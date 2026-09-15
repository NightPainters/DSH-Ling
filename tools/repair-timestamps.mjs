// dsh-ling — 存量时间戳修复(一次性维护工具,可重复运行)。
//
// 背景(2026-09-15 修 A):早期写入路径把毫秒时间戳当浮点存成了 text,落库形态为
//   dsh_turns_raw.ts = "1789006881011.0"
// 这类值 `Date.parse` 解析为 NaN → L1 新近度恒为 1.0(永不衰减)、注入行里显示成 (1789006881)。
// 读侧已在 1.0.4 起容错(见 lib/host/util.js 的 toEpochMs/toIso),本工具把**磁盘上的存量值**也归一为 ISO,
// 让 `MIN/MAX(ts)`、导出、记忆中心展示都回到同一口径。
//
// 用法:
//   node tools/repair-timestamps.mjs              # 干跑:只统计与抽样,不写库
//   node tools/repair-timestamps.mjs --write      # 先备份(VACUUM INTO),再修复
//   node tools/repair-timestamps.mjs --db <path>  # 指定记忆库(默认 $DSH_HOME/cache/dsh-ling/memory.db)
// 退出码:0 = 无需修复或已修复;1 = 出错
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defaultDataDir, toIso } from '../lib/host/util.js';

const ISO_LIKE = "____-__-__%"; // SQLite LIKE:ISO 形态(2026-09-10T…)
const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DB = g('db', join(defaultDataDir(), 'memory.db'));
const WRITE = args.includes('--write');

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=8000');
console.log('== dsh-ling 存量时间戳修复 ==');
console.log('库:', DB);
console.log('模式:', WRITE ? '写入(先备份)' : '干跑(只读)');
console.log('');

// ── 1) 找出待修行 ──
const badTurns = db.prepare(
  `SELECT rowid, session_id, seq, ts FROM dsh_turns_raw
   WHERE ts IS NOT NULL AND ts <> '' AND ts NOT LIKE '${ISO_LIKE}'`,
).all();
const badOvs = db.prepare(
  `SELECT conv_id, source, started_at, updated_at FROM conv_overview
   WHERE (started_at IS NOT NULL AND started_at <> '' AND started_at NOT LIKE '${ISO_LIKE}')
      OR (updated_at IS NOT NULL AND updated_at <> '' AND updated_at NOT LIKE '${ISO_LIKE}')`,
).all();

console.log(`待修:dsh_turns_raw ${badTurns.length} 行 · conv_overview ${badOvs.length} 行`);
if (badTurns.length) {
  console.log('  抽样(turns):');
  for (const r of badTurns.slice(0, 4)) {
    console.log(`    ${r.session_id.slice(0, 8)} #${r.seq}  ${JSON.stringify(r.ts)} → ${JSON.stringify(toIso(r.ts))}`);
  }
}
if (badOvs.length) {
  console.log('  抽样(overview):');
  for (const r of badOvs.slice(0, 4)) {
    console.log(`    ${r.source}/${r.conv_id.slice(0, 8)}  ${JSON.stringify(r.started_at)} → ${JSON.stringify(toIso(r.started_at))}`
      + `  |  ${JSON.stringify(r.updated_at)} → ${JSON.stringify(toIso(r.updated_at))}`);
  }
}

const unparsable = [...badTurns.map((r) => r.ts), ...badOvs.flatMap((r) => [r.started_at, r.updated_at])]
  .filter((v) => v && v !== '' && toIso(v) === null);
if (unparsable.length) {
  console.log(`\n⚠️ 其中 ${unparsable.length} 个值无法解析(将原样保留,不写入):${JSON.stringify(unparsable.slice(0, 5))}`);
}

if (!badTurns.length && !badOvs.length) {
  console.log('\n✓ 无需修复:所有时间戳已是 ISO 形态。');
  db.close();
  process.exit(0);
}
if (!WRITE) {
  console.log('\n(干跑结束。确认无误后加 --write 执行;执行前会自动 VACUUM INTO 一份备份。)');
  db.close();
  process.exit(0);
}

// ── 2) 备份(VACUUM INTO 得到一致性快照,WAL 下安全) ──
const backupDir = join(defaultDataDir(), 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = join(backupDir, `memory-${stamp}.db`);
db.prepare('VACUUM INTO ?').run(backup);
console.log('\n备份:', backup);

// ── 3) 修复 ──
const updTurn = db.prepare('UPDATE dsh_turns_raw SET ts=? WHERE rowid=?');
const updOv = db.prepare('UPDATE conv_overview SET started_at=?, updated_at=? WHERE source=? AND conv_id=?');
let nTurn = 0;
let nOv = 0;
db.exec('BEGIN');
try {
  for (const r of badTurns) {
    const iso = toIso(r.ts);
    if (!iso) continue;
    updTurn.run(iso, r.rowid);
    nTurn += 1;
  }
  for (const r of badOvs) {
    updOv.run(toIso(r.started_at), toIso(r.updated_at), r.source, r.conv_id);
    nOv += 1;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\n✗ 写入失败,已回滚:', String(e?.message ?? e));
  db.close();
  process.exit(1);
}
console.log(`\n✓ 已修复:dsh_turns_raw ${nTurn} 行 · conv_overview ${nOv} 行`);
console.log('回滚方式:把备份文件复制回', DB);

// ── 4) 复验 ──
const left = db.prepare(
  `SELECT (SELECT COUNT(*) FROM dsh_turns_raw WHERE ts IS NOT NULL AND ts<>'' AND ts NOT LIKE '${ISO_LIKE}') AS a,
          (SELECT COUNT(*) FROM conv_overview WHERE (started_at IS NOT NULL AND started_at<>'' AND started_at NOT LIKE '${ISO_LIKE}')
             OR (updated_at IS NOT NULL AND updated_at<>'' AND updated_at NOT LIKE '${ISO_LIKE}')) AS b`,
).get();
console.log(`复验:剩余非 ISO —— turns ${left.a} · overview ${left.b}`);
db.close();
process.exit(0);
