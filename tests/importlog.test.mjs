// 导入记录(留账)单元测试:字段归一 / 一次导入一条账(runId 累加) / 开始时刻固定 /
// 时间归一 / 修剪到 50 / 倒序 / 坏值容错 / 展示行
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const {
  logImport, listImportLog, formatLogLine, cleanAt, IMPORT_LOG_PREFIX, IMPORT_LOG_KEEP,
} = await imp('lib/host/import-log.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-imp-log-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

const NOW = Date.now();
const HOUR = 3600e3;

// 1) 写入一条:字段归一(kind 默认 file,数值默认 0,名字截断);at 保留调用方给的开始时刻
const at1 = NOW - 5000;
const key = logImport(mem, {
  at: at1, kind: 'file', name: 'chatgpt-export.json', accepted: 12, newRows: 9, refreshed: 2,
  upgraded: 1, folded: 0, removedImport: 0, degraded: 3, rejected: 1,
});
check(key.startsWith(IMPORT_LOG_PREFIX), '返回的 key 带前缀:' + key);
check(key === IMPORT_LOG_PREFIX + at1, 'key 就是开始时刻');
check(mem.kvGet(key) !== undefined, 'kv 中真的落了账');
const one = listImportLog(mem);
check(one.length === 1, '读回 1 条');
check(one[0].kind === 'file' && one[0].name === 'chatgpt-export.json', 'kind/name 保留');
check(one[0].newRows === 9 && one[0].upgraded === 1 && one[0].degraded === 3 && one[0].rejected === 1, '各计数保留');
check(one[0].at === at1 && one[0].startedAt === at1, 'at/startedAt = 传入的开始时刻');
check(one[0].batches === 1 && one[0].errors === 0, '单笔默认 1 批、0 失败');
const bareKey = logImport(mem, { at: NOW - 4000 });
check(bareKey && listImportLog(mem)[0].kind === 'file', 'kind 缺省为 file');
check(listImportLog(mem)[0].name === '' && listImportLog(mem)[0].newRows === 0, '缺省字段归一');
logImport(mem, { at: NOW - 3000, name: 'x'.repeat(400) });
const longItem = listImportLog(mem).find((it) => it.name.length > 0);
check(longItem.name.length === 120, '名字截断到 120:' + longItem.name.length);
check(listImportLog(mem).every((it) => it.accepted === 0 || it.accepted === 12), 'NaN 计数归一为 0');
// 一次导入 = 一条账时,失败批上报可能不带名字/只加 errors

// 2) 倒序:读出按新→旧
const mem2 = new MemoryStore(join(dir, 'm2.db'));
[[5000, 'oldest'], [3000, 'newest'], [4000, 'middle']].forEach(([off, name]) =>
  logImport(mem2, { at: NOW - off, kind: 'dsh', name, newRows: 1 }));
const desc = listImportLog(mem2);
check(desc.length === 3 && desc[0].name === 'newest' && desc[1].name === 'middle' && desc[2].name === 'oldest', '倒序(新→旧)');
check(listImportLog(mem2, { limit: 2 }).length === 2, 'limit 生效');
check(listImportLog(mem2, { limit: 999 })[0].name === 'newest', 'limit 超上限不报错');

// 3) 自动修剪:保留最近 50 条,最老的被作废
const mem3 = new MemoryStore(join(dir, 'm3.db'));
const base3 = NOW - 20 * HOUR;
for (let i = 1; i <= 55; i += 1) logImport(mem3, { at: base3 + i * 1000, kind: 'dsweb', name: 'db' + i, newRows: i });
const kept = listImportLog(mem3, { limit: IMPORT_LOG_KEEP });
check(kept.length === IMPORT_LOG_KEEP, '保留恰好 50 条,实际 ' + kept.length);
check(mem3.kvList(IMPORT_LOG_PREFIX).length === IMPORT_LOG_KEEP, 'kv 中也没有多于 50 条');
check(kept[0].name === 'db55', '最新一条在最前');
check(kept[kept.length - 1].name === 'db6', '最老的 5 条已作废(最后一条是 db6)');
check(!kept.some((it) => it.name === 'db1' || it.name === 'db5'), 'db1/db5 确已作废');

// 4) 坏值容错:脏 kv 不影响读取,也不影响后续写入
mem3.kvSet(IMPORT_LOG_PREFIX + 'broken', '{不是 JSON');
mem3.kvSet(IMPORT_LOG_PREFIX + 'emptyish', 'null');
mem3.kvSet(IMPORT_LOG_PREFIX + 'noAt', JSON.stringify({ kind: 'file', name: '没有 at' }));
const afterBad = listImportLog(mem3, { limit: 50 });
check(afterBad.length === IMPORT_LOG_KEEP, '坏值被跳过,好条目不受影响:' + afterBad.length);
check(afterBad.every((it) => it && it.at), '列表里每条都有 at');
logImport(mem3, { at: NOW - 1000, kind: 'dsh', name: 'after' });
check(listImportLog(mem3)[0].name === 'after', '坏值之后仍能正常写入');

// 5) 甲:一次导入 = 一条账(runId 累加;at 固定为首批开始时刻)
const mem4 = new MemoryStore(join(dir, 'm4.db'));
const t0 = NOW - 60 * 1000;
logImport(mem4, { runId: 'run-a', at: t0, kind: 'file', name: 'export.json', newRows: 5, refreshed: 1, rejected: 1 });
logImport(mem4, { runId: 'run-a', at: t0 + 1000, kind: 'file', name: 'export.json', newRows: 7, refreshed: 2, upgraded: 3, degraded: 1 });
logImport(mem4, { runId: 'run-a', at: t0 + 2000, kind: 'file', name: '', errors: 1 }); // 失败批上报
const runA = listImportLog(mem4);
check(runA.length === 1, '同一 runId 的多批只留一条账,实际 ' + runA.length);
check(runA[0].at === t0 && runA[0].startedAt === t0, 'at 固定为首批开始时刻');
check(runA[0].batches === 3, '批数累加为 3,实际 ' + runA[0].batches);
check(runA[0].newRows === 12 && runA[0].refreshed === 3, '核心计数累加');
check(runA[0].upgraded === 3 && runA[0].degraded === 1 && runA[0].rejected === 1 && runA[0].errors === 1, '附加计数与失败批累加');
check(runA[0].name === 'export.json', '失败批不带名字不会覆盖已有名字');
check(runA[0].kind === 'file' && runA[0].runId === 'run-a', 'kind/runId 保留');
check(Number(runA[0].updatedAt) > 0, 'updatedAt 记录最后一批时刻');
logImport(mem4, { runId: 'run-a', at: t0 + 30 * 60 * 1000, newRows: 1 });
check(listImportLog(mem4)[0].at === t0, '后续批的 at 不会改动账上时间');
check(listImportLog(mem4)[0].newRows === 13, '最后一批仍累加计数');
logImport(mem4, { runId: 'run-b', at: t0 - 5000, kind: 'file', name: 'other.json', newRows: 2 });
check(listImportLog(mem4).length === 2, '不同 runId 各留一条账');
check(listImportLog(mem4)[1].name === 'other.json', '两条账按开始时刻倒序');
// 不带 runId = 独立一笔(扫描类入口)
logImport(mem4, { at: t0 + 10 * 60 * 1000, kind: 'dsh', name: 'scan1' });
logImport(mem4, { at: t0 + 10 * 60 * 1000, kind: 'dsh', name: 'scan2' });
check(listImportLog(mem4).length === 4, '不带 runId 的两次扫描各留一条账');
check(mem4.kvList(IMPORT_LOG_PREFIX).length === 4, '同毫秒两笔不互相覆盖(kv 4 条)');

// 6) 开始时刻归一:非法/越界一律退回 now
const T = new Date(2026, 8, 11, 12, 0, 0).getTime();
check(cleanAt(NaN, T) === T && cleanAt(0, T) === T && cleanAt(-5, T) === T, '非法数值 → now');
check(cleanAt(undefined, T) === T && cleanAt('abc', T) === T && cleanAt(null, T) === T, '缺省/非数字 → now');
check(cleanAt(T - HOUR, T) === T - HOUR, '过去 1 小时保留');
check(cleanAt(T + 30 * 1000, T) === T + 30 * 1000, '1 分钟内时钟偏差容忍');
check(cleanAt(T + 10 * 60 * 1000, T) === T, '未来 10 分钟 → now');
check(cleanAt(T - 40 * 864e5, T) === T, '40 天前 → now');
check(cleanAt(1_700_000_000_000, T) === T, '2023 年的戳 → now(开始时刻必须是本次导入)');
check(cleanAt(T - 1000.7, T) === T - 1001, '向下取整到毫秒');
const mem6 = new MemoryStore(join(dir, 'm6.db'));
logImport(mem6, { at: 1_700_000_000_000 });
check(listImportLog(mem6)[0].at > 1_700_000_000_000, '写入时同样被归一');

// 7) 展示行:三条入口各自成形,含日期时间 / 批数 / 失败批
const at = new Date(2026, 8, 11, 9, 5, 0).getTime();
const lineFile = formatLogLine({
  at, kind: 'file', name: 'export.json', newRows: 9, refreshed: 2, upgraded: 1,
  folded: 3, removedImport: 1, degraded: 4, rejected: 2,
});
check(lineFile.startsWith('2026-09-11 09:05'), '文件导入行含时间:' + lineFile);
check(lineFile.includes('文件导入(export.json)'), '文件导入行含文件名');
check(lineFile.includes('新增 9') && lineFile.includes('刷新 2'), '文件导入行含核心计数');
check(lineFile.includes('补全原文 1') && lineFile.includes('并入网页端 3') && lineFile.includes('清理副本 1') && lineFile.includes('降级轻量 4') && lineFile.includes('拒绝 2'), '文件导入行含附加计数:' + lineFile);
const lineRun = formatLogLine({ at, kind: 'file', name: 'big.json', newRows: 1379, refreshed: 42, errors: 1, batches: 7 });
check(lineRun.includes('7 批') && lineRun.includes('失败 1 批'), '多批与失败批入行:' + lineRun);
check(!formatLogLine({ at, kind: 'file', newRows: 1, batches: 1 }).includes('1 批'), '单批不写"1 批"');
const lineFileBare = formatLogLine({ at, kind: 'file', newRows: 1, refreshed: 0 });
check(!lineFileBare.includes('(') && lineFileBare.includes('新增 1'), '无文件名时不出现空括号:' + lineFileBare);
const lineDsh = formatLogLine({ at, kind: 'dsh', seen: 41, newRows: 7 });
check(lineDsh.includes('本机 DSH 扫描') && lineDsh.includes('候选 41') && lineDsh.includes('新增 7'), 'DSH 扫描行:' + lineDsh);
const lineDsweb = formatLogLine({ at, kind: 'dsweb', name: 'deepseek_library.db', seen: 1523, newRows: 15, refreshed: 3 });
check(lineDsweb.includes('网页端库扫描') && lineDsweb.includes('源库 1523 条') && lineDsweb.includes('刷新 3'), '网页端扫描行:' + lineDsweb);
const lineUnknown = formatLogLine({ at, kind: 'weird', newRows: 1, refreshed: 0 });
check(lineUnknown.includes('文件导入'), '未知 kind 退回文件导入样式');

// ═══════════════════════════════════════════════════════════════════════════
// 8) #10(2026-09-29):被跳过的"单条过大"进账 —— **跳过 ≠ 失败**
// ---------------------------------------------------------------------------
// 判据:① `tooBig: 0` ⇒ 落的账**逐字不变**(值 + 键序 + 不新增字段 —— 负对照);
//       ② `tooBig > 0` ⇒ 入账,展示行末尾多出「· 单条过大 N」,位置在"失败 X 批"之后;
//       ③ 同一 runId 多次上报**累加**,且累加后仍夹在护栏内(名字最多 5 条);
//       ④ 护栏生效:`tooBig` 夹 0..10000;`tooBigNames` 前 5 条 / 每条 ≤40 字 / 非字符串丢弃;
//       ⑤ **命门**(必须在**端点**上验):只报 `tooBig` ⇒ 账本里 `errors` **不增长**。
//    ⚠️ ⑤ 为什么非走端点:强制 ≥1 的那句 `Math.max(1, ...)` 住在 `api.js` 的 `/import/log` 里,
//       账本层从不自己发明 `errors` —— 只测 `logImport()` 等于没测到那条命门(这正是修前的样子)。
import { EventEmitter } from 'node:events';
const { cleanTooBig, cleanTooBigNames, TOO_BIG_MAX, TOO_BIG_NAMES_MAX, TOO_BIG_NAME_CHARS } =
  await imp('lib/host/import-log.js'); // 同一模块(ESM 缓存),只是把新导出取过来

// ── ① 负对照:带 `tooBig: 0` 落账 ⇒ 与"压根不提这俩字段"逐字相同 ─────────────
const mem10 = new MemoryStore(join(dir, 'm10.db'));
const B10 = NOW - 10 * 60 * 1000;
const k10a = logImport(mem10, { at: B10, kind: 'file', name: 'a.json', newRows: 3, refreshed: 1, errors: 1 });
const k10b = logImport(mem10, { at: B10 + 1000, kind: 'file', name: 'a.json', newRows: 3, refreshed: 1, errors: 1, tooBig: 0, tooBigNames: [] });
const rec10a = JSON.parse(mem10.kvGet(k10a));
const rec10b = JSON.parse(mem10.kvGet(k10b));
for (const r of [rec10a, rec10b]) { r.at = 0; r.startedAt = 0; r.updatedAt = 0; } // 时间戳天然不同,归一后比其余部分
const same10 = JSON.stringify(rec10a) === JSON.stringify(rec10b);
console.log('    ① tooBig:0 与"不提这俩字段"逐字相同 = ' + same10 + ' · 键序=' + Object.keys(rec10b).join(','));
check(same10, 'tooBig:0 ⇒ 账本逐字不变(值与键序都不变)');
check(!('tooBig' in rec10b) && !('tooBigNames' in rec10b), 'tooBig:0 ⇒ 不新增字段(没跳过就不留痕)');

// ── ② 展示行:末尾追加「· 单条过大 N」,在"失败 X 批"之后 ────────────────────
const line10 = formatLogLine({ at, kind: 'file', name: 'big.json', newRows: 1379, refreshed: 42, errors: 1, batches: 7, tooBig: 3 });
const line10no = formatLogLine({ at, kind: 'file', name: 'big.json', newRows: 1379, refreshed: 42, errors: 1, batches: 7 });
console.log('    ② 含跳过:' + line10);
console.log('       无跳过:' + line10no);
check(line10.includes('· 单条过大 3'), '行含「· 单条过大 3」');
check(line10.indexOf('单条过大') > line10.indexOf('失败 1 批'), '它在"失败 X 批"**之后**(跳过不是失败,排在失败之后)');
check(line10 === line10no + ' · 单条过大 3', '只在末尾追加这一段,既有部分逐字不变');
check(!formatLogLine({ at, kind: 'file', newRows: 1, refreshed: 0, tooBig: 0 }).includes('单条过大'), 'tooBig:0 ⇒ 行里不出现「单条过大」');

// ── ③ 同一 runId 累加(与 errors 同语义),累加后仍夹在护栏内 ────────────────
const mem10r = new MemoryStore(join(dir, 'm10r.db'));
logImport(mem10r, { runId: 'run-10', at: B10, kind: 'file', name: 'big.json', tooBig: 2, tooBigNames: ['会话甲'] });
logImport(mem10r, { runId: 'run-10', at: B10 + 500, kind: 'file', tooBig: 1, tooBigNames: ['会话乙'] });
const rec10r = listImportLog(mem10r)[0];
check(rec10r.tooBig === 3, '两次上报累加为 3,实测 ' + rec10r.tooBig);
check((rec10r.tooBigNames || []).join(',') === '会话甲,会话乙', '名字累加(先来先留),实测 ' + JSON.stringify(rec10r.tooBigNames));
check(!rec10r.errors, '账本层不发明 errors:只报跳过 ⇒ errors 仍是 0,实测 ' + rec10r.errors);
logImport(mem10r, { runId: 'run-10', at: B10 + 900, kind: 'file', tooBig: 1, tooBigNames: ['丙', '丁', '戊', '己'] });
const rec10r2 = listImportLog(mem10r)[0];
console.log('    ③ 累加后:tooBig=' + rec10r2.tooBig + ' · names=' + JSON.stringify(rec10r2.tooBigNames));
check(rec10r2.tooBigNames.length === TOO_BIG_NAMES_MAX,
  '多批累加后名字仍只留 ' + TOO_BIG_NAMES_MAX + ' 条(账本是摘要,不许被多批撑大)');

// ── ④ 护栏:tooBig 0..10000;names 前 5 / ≤40 字 / 非字符串丢弃 ──────────────
const g6 = cleanTooBigNames(['a', 'b', 'c', 'd', 'e', 'f']);
const gLong = cleanTooBigNames(['x'.repeat(50)]);
const gMix = cleanTooBigNames([1, {}, null, '', 'ok', ['arr']]);
console.log('    ④ 6 条→' + JSON.stringify(g6) + ' · 50 字→' + gLong[0].length + ' 字 · 混类型→' + JSON.stringify(gMix)
  + ' · tooBig(1e9)=' + cleanTooBig(1e9));
check(g6.length === TOO_BIG_NAMES_MAX && TOO_BIG_NAMES_MAX === 5, '只取前 5 条');
check(gLong[0].length === TOO_BIG_NAME_CHARS && TOO_BIG_NAME_CHARS === 40, '每条截到 40 字');
check(gMix.join(',') === 'ok', '非字符串项丢弃');
check(cleanTooBigNames('不是数组').length === 0, '非数组 → 空数组(不抛:账本通路只许少记)');
check(cleanTooBig(1e9) === TOO_BIG_MAX && TOO_BIG_MAX === 10000, 'tooBig 夹到 10000');
check(cleanTooBig(-3) === 0 && cleanTooBig('abc') === 0 && cleanTooBig(undefined) === 0, '负数/非数字/缺省 → 0');
const mem10g = new MemoryStore(join(dir, 'm10g.db'));
logImport(mem10g, { at: B10, tooBig: 1e9, tooBigNames: ['x'.repeat(99), 1, 'y'] });
const rec10g = listImportLog(mem10g)[0];
console.log('    ④ 直接调 logImport 也过护栏:tooBig=' + rec10g.tooBig + ' names=' + JSON.stringify(rec10g.tooBigNames));
check(rec10g.tooBig === TOO_BIG_MAX && rec10g.tooBigNames.length === 2 && rec10g.tooBigNames[0].length === 40,
  'logImport 自己也过护栏(端点不是唯一入口 —— 「三条入口共用」这份才是底线)');
check(!rec10g.tooBigNames.some((x) => typeof x !== 'string'), '落账的每一项名字都是字符串');

// ── ⑤ 命门(端点级):只报 tooBig ⇒ errors 不增长;只报 errors ⇒ 逐字照旧 ────
process.env.DSH_LING_GUARD = 'off';
const { registerApi } = await imp('lib/host/api.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const routes10 = new Map();
const server10 = { register: (r) => { routes10.set(r.path, r.handler); return () => routes10.delete(r.path); } };
const gate10 = {
  snapshotIds: () => [], snapshotOf: () => null, isRunning: () => false,
  pendingCount: () => 0, recentSessionId: () => null, markSnapStale: () => {},
};
const memEp = new MemoryStore(join(dir, 'm10ep.db'));
registerApi({ get: (n) => (n === 'webServer' ? server10 : undefined) },
  { gate: gate10, memory: memEp, settings: new SettingsFile(join(dir, 'set10')) }, {});
/** 打真路由 `/import/log`(与 bodylimit.test.mjs T6 同法:假 req/res + 真 handler)。 */
const post10 = async (bodyObj) => {
  const handler = routes10.get('/api/dsh-ling/import/log');
  if (typeof handler !== 'function') throw new Error('路由没挂上:/import/log');
  const out = { status: 0, body: null };
  const req = new EventEmitter();
  req.url = '/import/log'; req.method = 'POST'; req.headers = { host: '127.0.0.1:3080' };
  req.destroy = () => {};
  const res = {
    statusCode: 0, writableEnded: false, destroyed: false,
    setHeader() {},
    end(p) { this.writableEnded = true; out.status = this.statusCode; try { out.body = JSON.parse(String(p ?? '')); } catch { out.body = null; } },
  };
  const done = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'));
  req.emit('end');
  await done;
  return out;
};
const epAt = NOW - 5 * 60 * 1000;
const rEp1 = await post10({ runId: 'ep-skip', at: epAt, file: 'big.json', tooBig: 2, tooBigNames: ['超大会话'] });
const eEp1 = listImportLog(memEp).find((x) => x.runId === 'ep-skip');
console.log('    ⑤ 只报 tooBig ⇒ 回执 ' + JSON.stringify(rEp1.body) + ' · 账本 errors=' + eEp1.errors
  + ' tooBig=' + eEp1.tooBig + ' names=' + JSON.stringify(eEp1.tooBigNames));
check(eEp1.tooBig === 2 && eEp1.errors === 0, '★命门:只报跳过 ⇒ tooBig=2,errors **不增长**(仍是 0)');
await post10({ runId: 'ep-skip', at: epAt + 100, file: 'big.json', tooBig: 1, tooBigNames: ['第二条'] });
const eEp2 = listImportLog(memEp).find((x) => x.runId === 'ep-skip');
check(eEp2.tooBig === 3 && eEp2.errors === 0, '再报一次仍累加、errors 仍 0(实测 tooBig=' + eEp2.tooBig + ' errors=' + eEp2.errors + ')');
await post10({ runId: 'ep-err', at: epAt + 200, file: 'big.json', errors: 1 });
const eEp3 = listImportLog(memEp).find((x) => x.runId === 'ep-err');
check(eEp3.errors === 1 && !eEp3.tooBig, '既有"只报 errors"通路逐字不变(errors=1 · 无 tooBig)');
await post10({ runId: 'ep-none', at: epAt + 300, file: 'big.json' });
const eEp4 = listImportLog(memEp).find((x) => x.runId === 'ep-none');
check(eEp4.errors === 1, '旧默认:既不报 errors 也不报 tooBig ⇒ 仍记 1 批失败(与修前逐字一致)');
await post10({ runId: 'ep-guard', at: epAt + 400, tooBig: 1e9, tooBigNames: ['z'.repeat(80), 7, 'w'] });
const eEp5 = listImportLog(memEp).find((x) => x.runId === 'ep-guard');
console.log('    ⑤ 端点护栏:tooBig=' + eEp5.tooBig + ' · names=' + JSON.stringify(eEp5.tooBigNames));
check(eEp5.tooBig === TOO_BIG_MAX && eEp5.tooBigNames.length === 2 && eEp5.tooBigNames[0].length === 40,
  '端点上也过护栏(10000 / 40 字 / 丢非字符串 —— 原始 HTTP 输入绕不过去)');
delete process.env.DSH_LING_GUARD;

console.log(ok ? '导入记录 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
