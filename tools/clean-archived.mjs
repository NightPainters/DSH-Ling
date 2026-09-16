// dsh-ling — 存量归档清理(一次性维护工具,2026-09-16 与用户定:清掉归档会话;未归档的测试会话不动)。
//
// 清的是什么:归档会话的**概述**(即 L1 会看见的那一层);**原文一律保留** —— 那是走过的路。
// 保护两类:①置顶(importance≥1,用户显式要留)②已深摘(kv `deep:<sid>`,花过 LLM、摘要更厚)。
// 防复活:同时把该会话概述水位 `sumdsh:<sid>` 推到最大 seq —— 即使宿主还在跑旧代码(不认识"跳过归档"),
//         概述器也会因为水位已满而跳过,清洁效果立刻就稳。
//
// 用法:
//   node tools/clean-archived.mjs                 # 干跑(只读,打印清单)
//   node tools/clean-archived.mjs --write         # 执行(先 VACUUM INTO 备份,再删除)
//   node tools/clean-archived.mjs --db <memory.db> [--all]   # 指定库;--all 连置顶/深摘一起清
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WRITE = args.includes('--write');
const ALL = args.includes('--all'); // --all:连置顶与已深摘也清(默认保护)
const SHOW = args.includes('--show'); // --show:把可清条目的原文轮次打印出来(便于人工判断)
const UNARCHIVE = args.includes('--unarchive'); // --unarchive:把"可清清单"里的会话从归档里捞出来(archived=0),不删任何东西

const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';
const DB = g('db', join(LING_DIR, 'memory.db'));
if (!existsSync(DB)) { console.error('找不到记忆库:', DB); process.exit(1); }

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=8000');

// 1) 挑出归档会话的概述(JOIN session_meta.archived=1)
const rows = db.prepare(
  `SELECT o.conv_id, o.title, o.hit_count, o.importance, o.updated_at,
          (SELECT COUNT(*) FROM dsh_turns_raw t WHERE t.session_id = o.conv_id) AS turns,
          (SELECT MAX(seq) FROM dsh_turns_raw t WHERE t.session_id = o.conv_id) AS max_seq,
          (SELECT value FROM kv WHERE key = 'deep:' || o.conv_id) AS deep
     FROM conv_overview o JOIN session_meta m ON m.session_id = o.conv_id
    WHERE o.source='dsh' AND m.archived=1
    ORDER BY o.updated_at DESC`,
).all();

const keepPinned = !ALL, keepDeep = !ALL;
const removable = [];
const kept = [];
for (const r of rows) {
  if (keepPinned && Number(r.importance) >= 1) { kept.push({ ...r, reason: '置顶' }); continue; }
  if (keepDeep && r.deep) { kept.push({ ...r, reason: '已深摘' }); continue; }
  removable.push(r);
}

console.log('== 存量归档清理 ==');
console.log('库:', DB);
console.log(`归档会话的概述 ${rows.length} 条 → 可清 ${removable.length} · 受保护 ${kept.length}${ALL ? '(已指定 --all,忽略保护)' : ''}\n`);

if (removable.length) {
  console.log('将清理:');
  for (const r of removable) {
    console.log(`  · [${(r.updated_at || '').slice(0, 10)}] ${String(r.title || '').slice(0, 40)}  命中 ${r.hit_count} · 原文 ${r.turns} 轮`);
  }
  console.log('');
}
if (kept.length) {
  console.log('受保护(保留):');
  for (const k of kept) console.log(`  · [${(k.updated_at || '').slice(0, 10)}] ${String(k.title || '').slice(0, 40)}  (${k.reason})`);
  console.log('');
}

if (SHOW && removable.length) {
  const turnsStmt = db.prepare('SELECT seq, role, ts, text FROM dsh_turns_raw WHERE session_id=? ORDER BY seq');
  console.log('== 原文(供人工判断)==');
  for (const r of removable) {
    console.log(`\n—— ${String(r.title || '')}  [${r.conv_id}]`);
    for (const t of turnsStmt.all(String(r.conv_id))) {
      const full = String(t.text || '').replace(/\s+/g, ' ');
      const txt = full.slice(0, 300);
      console.log(`   ${String(t.role || '?').padEnd(9)} ${String(t.ts || '').slice(0, 16)}  ${txt}${full.length > 300 ? ' …(' + full.length + ' 字)' : ''}`);
    }
  }
  console.log('');
}

if (!removable.length) { console.log('没有可清理的条目 —— 无需动作。'); db.close(); process.exit(0); }

// --unarchive:把它们从归档里捞出来(只改 archived 标记,不删任何东西)
if (UNARCHIVE) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bdir = join(dirname(DB), 'backups');
  if (!existsSync(bdir)) mkdirSync(bdir, { recursive: true });
  const bpath = join(bdir, `memory-before-unarchive-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(bpath.replace(/\\/g, '/'));
  const upd = db.prepare('UPDATE session_meta SET archived=0 WHERE session_id=?');
  db.exec('BEGIN');
  try {
    for (const r of removable) upd.run(String(r.conv_id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('捞回失败,已回滚:', String(e?.message ?? e));
    db.close();
    process.exit(1);
  }
  console.log('已备份:', bpath);
  console.log(`✓ 已从归档捞出 ${removable.length} 个会话(archived=0)—— 概述与原文都没动。`);
  for (const r of removable) console.log(`  · [${(r.updated_at || '').slice(0, 10)}] ${String(r.title || '').slice(0, 44)}`);
  console.log('\n提示:捞出来之后,这些会话与未归档会话同等待遇 —— 不会再被"归档即清"碰到。');
  db.close();
  process.exit(0);
}
if (!WRITE) { console.log('干跑结束(未改动任何数据)。加 --write 执行。'); db.close(); process.exit(0); }

// 2) 备份(热备份必须用 VACUUM INTO;插件可能正在写 WAL)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupDir = join(dirname(DB), 'backups');
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
const backup = join(backupDir, `memory-before-archive-cleanup-${stamp}.db`);
db.prepare('VACUUM INTO ?').run(backup.replace(/\\/g, '/'));
console.log('已备份:', backup);

// 3) 事务内删除概述 + 推水位防复活
const del = db.prepare("DELETE FROM conv_overview WHERE source='dsh' AND conv_id=?");
const bump = db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
db.exec('BEGIN');
try {
  for (const r of removable) {
    del.run(String(r.conv_id));
    if (r.max_seq !== null && r.max_seq !== undefined) bump.run('sumdsh:' + r.conv_id, String(r.max_seq));
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败,已回滚:', String(e?.message ?? e));
  db.close();
  process.exit(1);
}

const left = db.prepare(
  `SELECT COUNT(*) n FROM conv_overview o JOIN session_meta m ON m.session_id=o.conv_id
    WHERE o.source='dsh' AND m.archived=1`,
).get();
const total = db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source='dsh'").get();
console.log(`\n✓ 已清 ${removable.length} 条;归档会话剩余概述 ${Number(left.n)} 条;dsh 概述总数 ${Number(total.n)} 条。`);
console.log('提示:重启宿主后,新代码会阻止归档会话的概述被再次生成(本工具已用"推水位"兼容旧代码)。');
db.close();
