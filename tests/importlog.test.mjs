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

console.log(ok ? '导入记录 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
