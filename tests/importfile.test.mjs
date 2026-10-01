// 会话契约文件导入(ACCESS-DESIGN §1/§3)单元测试:两档深度/幂等/降级/坏行/auto-id
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore, rawSessionId } = await imp('lib/host/memory.js');
const { normalizeImportItem, applyImportItems, IMPORT_SOURCE } = await imp('lib/host/import-file.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-imp-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 完整档
const full = normalizeImportItem({
  id: 'webchat:100', title: '数据模拟', startedAt: '2026-01-01T10:00:00Z',
  messages: [
    { role: 'user', text: '数据模拟怎么做', at: '2026-01-01T10:00:00Z' },
    { role: 'assistant', text: '先建物理模型…', at: '2026-01-01T10:00:10Z' },
    { role: 'user', text: '继续', at: '2026-01-01T10:01:00Z' },
  ],
});
check(full.ok && full.row.conv_id === 'webchat:100', '完整档规范化');
check(full.rawTurns.length === 3 && full.rawTurns[0].role === 'user' && full.rawTurns[2].seq === 3, 'raw 轮次与序号');
check(!full.degraded, '完整档非降级');
check(full.row.category === 'knowledge' && full.row.source === IMPORT_SOURCE, '类别+来源');

// 2) 轻量档
const lite = normalizeImportItem({ id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', summary: '深夜闲聊', keywords: ['失眠'] });
check(lite.ok && !lite.rawTurns.length && lite.row.summary === '深夜闲聊', '轻量档(仅摘要)');
const lite2 = normalizeImportItem({ title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' });
check(lite2.ok && /^auto:/.test(lite2.row.conv_id), '无 id 自动生成(auto:)');
const lite2b = normalizeImportItem({ title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' });
check(lite2b.row.conv_id === lite2.row.conv_id, 'auto-id 稳定(同标题同时间幂等)');

// 3) 坏行 / 降级
const bad = normalizeImportItem(null);
check(!bad.ok, 'null 条目拒绝');
const bad2 = normalizeImportItem({ title: '' });
check(!bad2.ok, '空对象拒绝');
const liteTitleOnly = { title: '只有标题的会话', startedAt: '2026-04-01T00:00:00Z', messages: [{ role: 'user', text: '' }] };
const degraded = normalizeImportItem(liteTitleOnly);
check(degraded.ok && degraded.degraded && degraded.row.summary.length > 0, '空消息降级为轻量并给默认摘要');

// 4) 落库:首次新增(输入须为原始契约对象)
const fullItem = { id: 'webchat:100', title: '数据模拟', startedAt: '2026-01-01T10:00:00Z', messages: [{ role: 'user', text: '数据模拟怎么做', at: '2026-01-01T10:00:00Z' }, { role: 'assistant', text: '先建物理模型…', at: '2026-01-01T10:00:10Z' }, { role: 'user', text: '继续', at: '2026-01-01T10:01:00Z' }] };
const liteItem = { id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', summary: '深夜闲聊', keywords: ['失眠'] };
const lite2Item = { title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' };
const r1b = await applyImportItems(mem, [fullItem, liteItem, lite2Item, liteTitleOnly]);
check(r1b.newRows === 4, '首次导入新增 4: ' + r1b.newRows);
// G4(2026-09-17):导入原文落 'import:<id>' 命名空间,与 DSH 会话原文物理隔离
const RAW100 = rawSessionId(IMPORT_SOURCE, 'webchat:100');
check(mem.rawTurnCount(RAW100) === 3, '完整档 raw 写入 3 条(import 命名空间)');
check(mem.rawTurnCount('webchat:100') === 0, '同名裸 id 下不留原文(不再被 DSH 概述器认领)');
// 5) 重导:全刷新、raw 幂等、用户态 summary 不被覆盖
// (G2,2026-09-17:置顶经 setImportance 设置 —— upsertOverview 自 1.2.2 起不再覆盖本机用户态字段)
mem.upsertOverview({ source: IMPORT_SOURCE, conv_id: 'webchat:100', title: '数据模拟', category: 'knowledge', overview_ok: true, summary: '用户深摘内容' });
mem.setImportance(IMPORT_SOURCE, 'webchat:100', 1);
const r2 = await applyImportItems(mem, [fullItem]);
check(r2.newRows === 0 && r2.refreshed === 1, '重导刷新 1');
check(mem.rawTurnCount(RAW100) === 3, 'raw 覆盖写不翻倍');
const row100 = mem.overviewById(IMPORT_SOURCE, 'webchat:100');
check(row100.summary === '用户深摘内容', '已存在会话摘要不被覆盖');
check(Number(row100.importance) === 1, '置顶不被覆盖');
// 5b) 轻量行升级完整档 → upgraded(原无 raw,本次带原文)
const upR = await applyImportItems(mem, [{ id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', messages: [{ role: 'user', text: '最近睡得好吗' }, { role: 'assistant', text: '梦多但还好' }] }]);
check(upR.refreshed === 1 && upR.upgraded === 1 && mem.rawTurnCount(rawSessionId(IMPORT_SOURCE, 'other:9')) === 2, '轻量→完整 补全原文计 upgraded(2 轮)');
// 6) 混合批:好行入、坏行列入 rejected
const r3 = await applyImportItems(mem, [{ id: 'x1', title: '新会话', startedAt: '2026-05-01T00:00:00Z' }, { bad: true }, 'nope']);
check(r3.newRows === 1 && r3.rejected.length === 2, '混合批:1 新入 + 2 拒绝');
// 7) 类别别名与字段别名
const alias = normalizeImportItem({ id: 'a:1', name: '别名标题', startTime: '2026-06-01T00:00:00Z', messages: [{ role: 'human', content: '嗨' }, { role: 'ai', content: '你好' }] });
check(alias.ok && alias.row.title === '别名标题' && alias.row.started_at === '2026-06-01T00:00:00.000Z', '字段别名(name/startTime/human/ai/content)');
// 8) queryOverviews 泛化(import 源可过滤)
const q = mem.queryOverviews({ source: IMPORT_SOURCE, limit: 10 });
check(q.total === 5, 'queryOverviews 可按 import 源过滤: ' + q.total);

// 9) DeepSeek 官方导出结构(mapping 树:REQUEST/RESPONSE 轮,THINK/FILE 跳过;inserted_at 带微秒+时区)
const officialItem = {
  id: 'uuid-aaaa', title: '交流继电器关断慢原因',
  inserted_at: '2026-09-07T11:50:07.412000+08:00',
  updated_at: '2026-09-07T11:53:14.966000+08:00',
  mapping: {
    root: { id: 'root', children: ['1'] },
    '1': { id: '1', children: ['2'], message: { inserted_at: '2026-09-07T11:50:07.412000+08:00', fragments: [{ type: 'FILE', files: [] }, { type: 'REQUEST', content: '交流继电器关断为什么慢' }] } },
    '2': { id: '2', children: ['3'], message: { inserted_at: '2026-09-07T11:51:50.641000+08:00', fragments: [{ type: 'THINK', content: '推理(应跳过)' }, { type: 'RESPONSE', content: '因为固态继电器…' }] } },
    '3': { id: '3', children: [], message: { inserted_at: '2026-09-07T11:52:30.100000+08:00', fragments: [{ type: 'REQUEST', content: '那直控直呢' }] } },
  },
};
const off = normalizeImportItem(officialItem);
check(off.ok && off.rawTurns.length === 3, '官方 mapping 解析 3 轮: ' + (off.rawTurns || []).length);
check(off.rawTurns[0].role === 'user' && off.rawTurns[1].role === 'assistant' && off.rawTurns[2].role === 'user', '轮次角色正确');
check(!off.rawTurns.some((t) => t.text.includes('推理(应跳过)')), 'THINK 内容被跳过');
check(off.row.started_at === '2026-09-07T03:50:07.412Z', 'inserted_at 微秒+时区清洗:' + off.row.started_at);
check(off.rawTurns[0].ts === Date.parse('2026-09-07T03:50:07.412Z'), '消息时间戳清洗');

// 10) 同 uuid 折叠:官方导出命中 dsweb 旧域 → 并入 dsweb(含原文),import 副本移除
mem.upsertOverview({ conv_id: 'uuid-aaaa', source: 'dsweb', title: '交流继电器关断慢原因', category: 'knowledge', overview_ok: true, summary: '旧抓取摘要', importance: 0 });
mem.upsertOverview({ conv_id: 'uuid-aaaa', source: IMPORT_SOURCE, title: '交流继电器关断慢原因', category: 'knowledge', overview_ok: true, summary: '上次导入的轻量副本' });
const foldR = await applyImportItems(mem, [officialItem]);
check(foldR.folded === 1, '折叠 1(并入 dsweb)');
check(foldR.removedImport === 1, '移除 import 副本 1');
check(!mem.overviewById(IMPORT_SOURCE, 'uuid-aaaa'), 'import 域副本已删除');
const dsRow = mem.overviewById('dsweb', 'uuid-aaaa');
check(!!dsRow && dsRow.summary === '旧抓取摘要', 'dsweb 行摘要不被折叠覆盖');
check(mem.rawTurnCount('uuid-aaaa') === 3, '原文 raw 写入 dsweb 会话');

// 11) G4 读取侧:新数据走命名空间,旧数据(裸 id)保留回退 —— 老库不会因这次改动读不到原文
const { buildTranscript, candidateFor, importRawTargets } = await imp('lib/host/deepsummary.js');
mem.appendRawTurn('legacy:1', { seq: 1, role: 'user', ts: null, model: null, text: '旧版导入留下的裸 id 原文' });
mem.appendRawTurn('legacy:1', { seq: 2, role: 'assistant', ts: null, model: null, text: '旧回复' });
mem.upsertOverview({ conv_id: 'legacy:1', source: IMPORT_SOURCE, title: '旧数据', overview_ok: true });
check(buildTranscript(mem, 'legacy:1', { source: IMPORT_SOURCE }).text.includes('裸 id 原文'), 'G4 回退:旧数据(裸 id)仍可转录');
check(buildTranscript(mem, 'webchat:100', { source: IMPORT_SOURCE }).text.includes('数据模拟怎么做'), 'G4 主路径:新数据从 import 命名空间转录');
check(candidateFor(mem, 'webchat:100').file === null, 'candidateFor 命中命名空间原文(不误判为"无原文")');
const targets = importRawTargets(mem, { limit: 10 });
check(targets.some((t) => t.session_id === 'webchat:100'), 'importRawTargets 返回 conv_id 而非行 id: ' + JSON.stringify(targets.map((t) => t.session_id)));
check(targets.some((t) => t.session_id === 'legacy:1'), 'importRawTargets 兼容旧裸 id 行');

// 12) S5 导入诚实化:ChatGPT 原生导出形态(author.role + content.parts + current_node 主链,无 root 键)
const gptItem = {
  id: 'gpt-1', title: '汽车冬季性能',
  create_time: 1712345678.123,   // 秒级 epoch(旧实现当毫秒 → 1970)
  update_time: 1712345800.5,
  current_node: 'm3',
  mapping: {
    r: { id: 'r', message: null, parent: null, children: ['m1'] },
    m1: { id: 'm1', parent: 'r', children: ['m2', 'm2b'], message: { author: { role: 'user' }, create_time: 1712345678.123, content: { content_type: 'text', parts: ['冬天电动车续航掉得厉害'] } } },
    m2: { id: 'm2', parent: 'm1', children: ['m3'], message: { author: { role: 'assistant' }, create_time: 1712345700, content: { content_type: 'text', parts: ['主要看电池低温性能…'] } } },
    m2b: { id: 'm2b', parent: 'm1', children: [], message: { author: { role: 'assistant' }, create_time: 1712345710, content: { content_type: 'text', parts: ['重生成的分支(不该入档)'] } } },
    m3: { id: 'm3', parent: 'm2', children: [], message: { author: { role: 'user' }, create_time: 1712345800.5, content: { content_type: 'text', parts: ['那怎么保养'] } } },
  },
};
const gpt = normalizeImportItem(gptItem);
check(gpt.ok && gpt.rawTurns.length === 3, 'S5:ChatGPT mapping(无 root + parts)解析 3 轮: ' + (gpt.rawTurns || []).length);
check(gpt.rawTurns[0].role === 'user' && gpt.rawTurns[1].role === 'assistant', 'S5:ChatGPT author.role 映射正确');
check(!gpt.rawTurns.some((t) => t.text.includes('重生成的分支')), 'S5:current_node 主链回溯,重生成分支不入档');
check(gpt.row.started_at === new Date(1712345678.123 * 1000).toISOString(), 'S5:秒级 create_time 归一到毫秒: ' + gpt.row.started_at);
check(!gpt.degraded, 'S5:ChatGPT 导出非降级');
check(gpt.row.conv_id === 'gpt-1', 'S5:顶层 id 正确');

// 13) S5:认不出的 mapping 必须 degraded(旧实现静默报"导入完成"而正文零进)
const alienItem = { id: 'alien:1', title: '异形导出', mapping: { n1: { id: 'n1', message: { payload: { text: '结构不认识' } } } } };
const alien = normalizeImportItem(alienItem);
check(alien.ok && alien.degraded === true, 'S5:mapping 解析 0 轮 → degraded(不再当成功)');
check(/mapping/.test(alien.degradedReason || ''), 'S5:degraded 带原因: ' + alien.degradedReason);
const alienR = await applyImportItems(mem, [alienItem]);
check(alienR.degraded === 1 && alienR.degradedReasons && Object.keys(alienR.degradedReasons).length === 1,
  'S5:applyImportItems 汇总 degradedReasons: ' + JSON.stringify(alienR.degradedReasons));

// 14) S5:秒级时间双形态(顶层 create_time)
const secOnly = normalizeImportItem({ id: 'epoch:1', title: '秒级时间', create_time: 1712345678 });
check(!!secOnly.row.started_at && secOnly.row.started_at.startsWith('2024-'), 'S5:顶层秒级 create_time 归一: ' + secOnly.row.started_at);

// ═══════════════════════════════════════════════════════════════════════════
// 15) A(2026-09-30)折叠**绝不覆盖**目标会话已有的真原文(缺陷:折叠覆盖真原文)
//   修前:`import-file.js` 折叠分支无条件 `appendRawTurn(id,{seq:t.seq,…})`,而 `dsh_turns_raw`
//     主键是 (session_id,seq)、`appendRawTurn` 是 `ON CONFLICT(session_id,seq) DO UPDATE SET
//     text=excluded.text` ⇒ 导入侧 seq 从 1 重数、与目标既有轮次**必然同号** ⇒ 目标里的真原文
//     被逐条静默换掉(行数不增、内容被换、一个字都不报;离线测试台 S6d 实测 clobbered=3)。
//   判据:① 目标一个字原文都没有 ⇒ 照旧写入(升级路径,不许堵死);② 已有原文且逐条完全相同
//     ⇒ 幂等跳过、不计;③ 已有原文但不同 ⇒ **保留现有的** + 计入 foldSkippedRaw。
//   ⚠️ 不许"按 max(seq) 往后追加"(同段对话在库里变两份 ⇒ 污染 L1),也不许整段替换(丢真的方向)。
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { logImport: logImp2, formatLogLine } = await imp('lib/host/import-log.js');
const sha16 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const rawRows = (sid) => mem.db.prepare('SELECT seq, role, text FROM dsh_turns_raw WHERE session_id=? ORDER BY seq').all(sid);
/** 原文指纹:含 seq/role/text 且按 seq 排序 ⇒ "换内容/改号/丢行"三种变化都会改指纹。 */
const rawDigest = (sid) => sha16(rawRows(sid).map((r) => [r.seq, r.role, r.text].join('\u0001')).join('\u0002'));
/** 被顶掉的轮数:同 seq 上 text 变了(修前的表现是 =3,修后必须是 0)。 */
const clobberedOf = (sid, before) => {
  const after = new Map(rawRows(sid).map((r) => [Number(r.seq), String(r.text)]));
  let n = 0;
  for (const [seq, text] of before) if (after.has(seq) && after.get(seq) !== text) n += 1;
  return n;
};
const snapOf = (sid) => new Map(rawRows(sid).map((r) => [Number(r.seq), String(r.text)]));

// 15-① 目标已有原文、内容**完全相同** ⇒ 幂等跳过、不计丢失、原文逐字不变
const SAME = 'fold-case:same';
mem.upsertOverview({ conv_id: SAME, source: 'dsweb', title: '折叠-同一份', category: 'daily', overview_ok: true, summary: '网页端旧行' });
mem.appendRawTurn(SAME, { seq: 1, role: 'user', ts: null, model: null, text: '同一句问' });
mem.appendRawTurn(SAME, { seq: 2, role: 'assistant', ts: null, model: null, text: '同一句答' });
const sameSnap = snapOf(SAME);
const sameDigest = rawDigest(SAME);
const rSame = await applyImportItems(mem, [{ id: SAME, title: '折叠-同一份(导入侧同文)', startedAt: '2026-07-01T00:00:00Z', messages: [{ role: 'user', text: '同一句问' }, { role: 'assistant', text: '同一句答' }] }]);
check(rSame.folded === 1, '① 折叠命中 dsweb 域(走进折叠分支)');
check(rSame.foldSkippedRaw === 0, '① 逐条完全相同 ⇒ 幂等跳过、foldSkippedRaw=0(实测 ' + rSame.foldSkippedRaw + ')');
check(rawDigest(SAME) === sameDigest, '★① 原文指纹逐字不变(sha ' + sameDigest + ' → ' + rawDigest(SAME) + ')');
check(mem.rawTurnCount(SAME) === 2 && clobberedOf(SAME, sameSnap) === 0, '① 不新增不覆盖(仍 2 轮 / clobbered=0)');

// 15-② 目标已有原文、内容**不同** ⇒ 保留现有的、foldSkippedRaw>0、clobbered=0
const DIFF = 'fold-case:diff';
mem.upsertOverview({ conv_id: DIFF, source: 'dsweb', title: '折叠-不同内容', category: 'knowledge', overview_ok: true, summary: '网页端旧行 2' });
for (let k = 1; k <= 3; k++) mem.appendRawTurn(DIFF, { seq: k, role: k % 2 ? 'user' : 'assistant', ts: null, model: null, text: '目标原有的真原文-第 ' + k + ' 轮' });
const diffSnap = snapOf(DIFF);
const diffDigest = rawDigest(DIFF);
const rDiff = await applyImportItems(mem, [{ id: DIFF, title: '折叠-不同内容(导入侧)', startedAt: '2026-07-02T00:00:00Z', messages: [
  { role: 'user', text: '导入侧的正文 A' }, { role: 'assistant', text: '导入侧的正文 B' },
  { role: 'user', text: '导入侧的正文 C' }, { role: 'assistant', text: '导入侧的正文 D' },
] }]);
check(rDiff.folded === 1, '② 折叠命中 dsweb 域');
check(rDiff.foldSkippedRaw === 4, '② 4 轮内容不同 ⇒ 全部计入 foldSkippedRaw(实测 ' + rDiff.foldSkippedRaw + ')');
check(rawDigest(DIFF) === diffDigest, '★② 目标原文字节逐字不变(sha ' + diffDigest + ' → ' + rawDigest(DIFF) + ')');
check(clobberedOf(DIFF, diffSnap) === 0, '★② clobbered=0(修前此处 = 3)');
check(mem.rawTurnCount(DIFF) === 3, '② 不"按 max(seq) 往后追加"(行数仍 3,不把同段对话变成两份)');
check(rawRows(DIFF).every((r) => String(r.text).startsWith('目标原有的真原文')), '② 库里留下的全是目标原有原文(导入侧一个字没进)');

// 15-③ 负对照:目标**一个字原文都没有** ⇒ 照旧写入(升级路径不许被堵死)
const NONE = 'fold-case:none';
mem.upsertOverview({ conv_id: NONE, source: 'dsweb', title: '折叠-目标无原文', category: 'daily', overview_ok: true, summary: '只有壳的 dsweb 行' });
const rNone = await applyImportItems(mem, [{ id: NONE, title: '折叠-目标无原文(导入侧补原文)', startedAt: '2026-07-03T00:00:00Z', messages: [
  { role: 'user', text: '补进来的第 1 轮' }, { role: 'assistant', text: '补进来的第 2 轮' },
] }]);
check(rNone.folded === 1 && rNone.foldSkippedRaw === 0, '★③ 对照:目标无原文 ⇒ foldSkippedRaw=0(没被误判成"跳过")');
check(mem.rawTurnCount(NONE) === 2, '★③ 照旧写入 2 轮(升级路径没被堵死,实测 ' + mem.rawTurnCount(NONE) + ')');
check(rawRows(NONE).map((r) => r.text).join('|') === '补进来的第 1 轮|补进来的第 2 轮', '★③ 写进去的正是导入侧正文(seq 从 1 起)');

// 15-④ 部分重叠:相同的跳过不计,只有内容不同的才计数 —— 证明计数不是"有原文就整条 +N"
const MIX = 'fold-case:mix';
mem.upsertOverview({ conv_id: MIX, source: 'dsweb', title: '折叠-部分重叠', category: 'daily', overview_ok: true });
mem.appendRawTurn(MIX, { seq: 1, role: 'user', ts: null, model: null, text: '重叠的同一句' });
mem.appendRawTurn(MIX, { seq: 2, role: 'assistant', ts: null, model: null, text: '目标独有的一句' });
const mixSnap = snapOf(MIX);
const mixDigest = rawDigest(MIX);
const rMix = await applyImportItems(mem, [{ id: MIX, title: '折叠-部分重叠(导入侧)', startedAt: '2026-07-04T00:00:00Z', messages: [
  { role: 'user', text: '重叠的同一句' }, { role: 'assistant', text: '导入侧新的一句' }, { role: 'user', text: '导入侧另一句' },
] }]);
check(rMix.foldSkippedRaw === 2, '④ 部分重叠:只有内容不同的 2 轮计数(实测 ' + rMix.foldSkippedRaw + ')');
check(rawDigest(MIX) === mixDigest && clobberedOf(MIX, mixSnap) === 0, '④ 部分重叠时原文仍逐字不变(clobbered=0)');

// 16) B4:foldSkippedRaw 进持久账本 —— 只在 >0 时入账,=0 时落账逐字不变
const lat = Date.now() - 3600e3;
const kSkip = logImp2(mem, { at: lat, kind: 'file', name: 'fold.json', newRows: 2, refreshed: 1, folded: 1, foldSkippedRaw: 6 });
const recSkip = JSON.parse(mem.kvGet(kSkip));
check(recSkip.foldSkippedRaw === 6, '账本记下"原文未替换 6 轮"(实测 ' + recSkip.foldSkippedRaw + ')');
check(formatLogLine(recSkip).includes('原文未替换 6'), '账本那一行看得见「原文未替换 6」:…' + formatLogLine(recSkip).slice(-30));
const kZero = logImp2(mem, { at: lat + 1000, kind: 'file', name: 'fold.json', newRows: 2, refreshed: 1, folded: 1, foldSkippedRaw: 0 });
const recZero = JSON.parse(mem.kvGet(kZero));
check(!('foldSkippedRaw' in recZero), 'foldSkippedRaw=0 ⇒ 不新增字段(账本逐字不变;实测键=' + Object.keys(recZero).join(',') + ')');
const lineBase = formatLogLine({ at: lat, kind: 'file', name: 'big.json', newRows: 1379, refreshed: 42, errors: 1, batches: 7 });
const lineSkip = formatLogLine({ at: lat, kind: 'file', name: 'big.json', newRows: 1379, refreshed: 42, errors: 1, batches: 7, foldSkippedRaw: 3 });
check(lineSkip === lineBase + ' · 原文未替换 3', '行文案只在**末尾**追加一段(既有部分逐字不变):…' + lineSkip.slice(-16));
check(!formatLogLine({ at: lat, kind: 'file', newRows: 1, refreshed: 0, foldSkippedRaw: 0 }).includes('原文未替换'), 'foldSkippedRaw=0 ⇒ 行里不出现「原文未替换」');

// 17) B3 面板贯通:client.js 的 finish() 离线**跑不到**(vm-light 只暴露 exports.__test__ 的纯函数),
//     故这里查**源码形态** —— 它只证明"这句话还在",不证明渲染效果(证据边界:面板渲染效果本包内无用例覆盖、只能真机实看 —— 那正是 1.5.3(2026-09-29 修)那批"折叠计数不显示"缺陷的最后一环)。
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(/foldSkippedRaw:\s*0/.test(clientSrc), '面板 totals 初值带 foldSkippedRaw:0(不是 undefined ⇒ 不会变成 NaN)');
check(/totals\.foldSkippedRaw\s*\+=\s*r\.foldSkippedRaw/.test(clientSrc), '面板逐批累加 r.foldSkippedRaw');
check(clientSrc.includes('原文没有替换') && clientSrc.includes('不是失败'), '面板有那行人话(说清"没有替换"且"不是失败")');

// ═══════════════════════════════════════════════════════════════════════════
// 18) A'(2026-09-30)「已有原文」判据必须**连 `import:<id>` 一起看**(G4 裂缝:上一轮修复带出)
//   缺陷(修前):判据只看**写入目标**(dsweb 裸 id),没把 `import:<id>` 命名空间算进来 ⇒ 若该会话
//     在 `import:<id>` 下已有原文(例如先前做过一次普通文件导入)、而裸 id 这侧 0 轮,折叠会把
//     同一段对话**再写一份**进裸 id ⇒ 库里同一段对话两个 session_id、两份原文
//     —— 正是折叠机制本来要消灭的「L1 双份召回」。
//   判据:① 任一侧有原文 ⇒ **不写裸 id**、**不动 `import:` 侧的行**,被挡下的轮数进 foldSkippedRaw;
//         ② 两侧都没有  ⇒ 照旧写入裸 id(升级路径不许堵死);③ 两侧都有 ⇒ 仍不覆盖(上一轮行为,不回归)。
//   ── C′(2026-10-01):③ 的**逐条指纹**也扩到候选链两侧 —— 旧写法指纹只取写入目标(裸 id),
//      于是 `import:` 侧**已有的同一轮**会被算成"未替换"(计数偏大、方向保守)。详见本文件 §19。
//      ⚠️ 只让计数更准:**不动任何数据、不做迁移**。
//   (本段全部用 mem 的临时库;真机库/真机 .dsh 一概不碰。)
const { rawSessionCandidates } = await imp('lib/host/memory.js');
/** 该会话(conv id)在原文表里**有几个 session_id 存着原文** —— 折叠要消灭的正是这个数 > 1。 */
const rawHoldersSql = (convId) => {
  const ks = rawSessionCandidates(IMPORT_SOURCE, convId);
  const rows = mem.db.prepare('SELECT DISTINCT session_id FROM dsh_turns_raw WHERE session_id IN (' + ks.map(() => '?').join(',') + ')').all(...ks);
  return rows.map((r) => String(r.session_id)).sort();
};
const rawTextsLike = (pattern) => Number(mem.db.prepare('SELECT COUNT(*) n FROM dsh_turns_raw WHERE text LIKE ?').get(pattern).n);

// 18-① `import:` 侧有原文、dsweb 裸 id 无原文 ⇒ 裸 id 仍是 0 轮(没有第二份)+ 计数 + import 侧逐字不变
const NS = 'fold-case:importside';
const NS_RAW = rawSessionId(IMPORT_SOURCE, NS);
const nsFirst = await applyImportItems(mem, [{ id: NS, title: 'NSIDE 先普通导入', startedAt: '2026-08-01T00:00:00Z', messages: [
  { role: 'user', text: 'NSIDE-导入侧原文-第 1 轮' }, { role: 'assistant', text: 'NSIDE-导入侧原文-第 2 轮' },
] }]);
// 网页端壳行(同 id、有概述、**一个字原文都没有**)后来才出现 —— 这正是缺陷生效的那个顺序
mem.upsertOverview({ conv_id: NS, source: 'dsweb', title: 'NSIDE 网页端壳行', category: 'daily', overview_ok: true, summary: '只有壳、无原文' });
const nsBefore = rawRows(NS_RAW);
const nsDigest = rawDigest(NS_RAW);
check(nsFirst.newRows === 1 && mem.rawTurnCount(NS_RAW) === 2 && mem.rawTurnCount(NS) === 0, '★A\'① 前置:原文只落在 import: 命名空间(裸 id 0 轮)');
check(rawSessionCandidates(IMPORT_SOURCE, NS).some((k) => mem.rawTurnCount(k) > 0), '★A\'① 前置:候选链任一侧已有原文');
check(rawHoldersSql(NS).join(',') === NS_RAW, '★A\'① 前置:该会话只有 1 个 session_id 有原文(' + rawHoldersSql(NS).join(',') + ')');
const rNs = await applyImportItems(mem, [{ id: NS, title: 'NSIDE 二次导入(该折叠)', startedAt: '2026-08-02T00:00:00Z', messages: [
  { role: 'user', text: 'NSIDE-第二次导入-第 1 轮' }, { role: 'assistant', text: 'NSIDE-第二次导入-第 2 轮' }, { role: 'user', text: 'NSIDE-第二次导入-第 3 轮' },
] }]);
check(rNs.folded === 1, '★A\'① 命中 dsweb 域 ⇒ 走折叠分支');
check(mem.rawTurnCount(NS) === 0, '★★A\'① 裸 id 侧**仍是 0 轮**(没有第二份;修前此处 = 3):实测 ' + mem.rawTurnCount(NS));
check(rNs.foldSkippedRaw === 3, '★★A\'① 被挡下的 3 轮计入 foldSkippedRaw(实测 ' + rNs.foldSkippedRaw + ')');
check(rNs.foldSkippedRaw > 0, '★A\'① 该计数必须 > 0(有内容没进去就得说出来)');
check(rawDigest(NS_RAW) === nsDigest && JSON.stringify(rawRows(NS_RAW)) === JSON.stringify(nsBefore),
  '★★A\'① import: 侧原文**逐字未变**(sha ' + nsDigest + ' → ' + rawDigest(NS_RAW) + ')');
check(rNs.removedImport === 1 && !mem.overviewById(IMPORT_SOURCE, NS), '★A\'① import 域**概述**副本仍被清掉(折叠语义未变)');
check(rawHoldersSql(NS).join(',') === NS_RAW && rawHoldersSql(NS).length === 1,
  '★★A\'① 同一段对话在库里仍只有 1 个 session_id 有原文(SELECT DISTINCT session_id):修前 = 2 ' + NS_RAW + ' + ' + NS);
check(rawTextsLike('NSIDE-第二次导入-%') === 0, '★A\'① 本次导入的正文**一个字都没进库**(不是"换个 id 存")');

// 18-② 负对照:两侧都没有原文 ⇒ 照旧写入裸 id(升级路径不许堵死)
const NSN = 'fold-case:noside';
mem.upsertOverview({ conv_id: NSN, source: 'dsweb', title: 'NSIDE 两侧都空', category: 'daily', overview_ok: true, summary: '壳行' });
check(rawSessionCandidates(IMPORT_SOURCE, NSN).every((k) => mem.rawTurnCount(k) === 0), '★A\'② 前置:两侧都无原文');
const rNsNone = await applyImportItems(mem, [{ id: NSN, title: 'NSIDE 两侧都空(补原文)', startedAt: '2026-08-03T00:00:00Z', messages: [
  { role: 'user', text: 'NSIDE-补进来的 1' }, { role: 'assistant', text: 'NSIDE-补进来的 2' },
] }]);
check(rNsNone.folded === 1 && rNsNone.foldSkippedRaw === 0, '★A\'② 对照:两侧都空 ⇒ foldSkippedRaw=0(没被误判成"跳过")');
check(mem.rawTurnCount(NSN) === 2 && rawHoldersSql(NSN).join(',') === NSN, '★★A\'② 照旧写入裸 id 2 轮(升级路径没被堵死)' + ' · 持有人=' + rawHoldersSql(NSN).join(','));
check(rawRows(NSN).map((r) => r.text).join('|') === 'NSIDE-补进来的 1|NSIDE-补进来的 2', '★A\'② 写进去的正是导入侧正文(seq 从 1 起)');

// 18-③ 两侧都有原文 ⇒ 仍是不覆盖(与上一轮一致,不回归)
//   ⚠️ 期望值已按 C′(2026-10-01)更新:旧写法"指纹只取写入目标"的那 1 轮不再计入(见 §19)。
const NSB = 'fold-case:bothside';
const NSB_RAW = rawSessionId(IMPORT_SOURCE, NSB);
mem.upsertOverview({ conv_id: NSB, source: 'dsweb', title: 'NSIDE 两侧都有', category: 'daily', overview_ok: true, summary: '壳行' });
mem.appendRawTurn(NSB, { seq: 1, role: 'user', ts: null, model: null, text: 'NSIDE-网页端真原文 A' });
mem.appendRawTurn(NSB, { seq: 2, role: 'assistant', ts: null, model: null, text: 'NSIDE-网页端真原文 B' });
mem.appendRawTurn(NSB_RAW, { seq: 1, role: 'user', ts: null, model: null, text: 'NSIDE-导入侧旧副本 X' });
mem.appendRawTurn(NSB_RAW, { seq: 2, role: 'assistant', ts: null, model: null, text: 'NSIDE-导入侧旧副本 Y' });
const bSnap = snapOf(NSB); const bDigest = rawDigest(NSB);
const bImpRows = rawRows(NSB_RAW); const bImpDigest = rawDigest(NSB_RAW);
const rBoth = await applyImportItems(mem, [{ id: NSB, title: 'NSIDE 两侧都有(折叠)', startedAt: '2026-08-04T00:00:00Z', messages: [
  { role: 'user', text: 'NSIDE-网页端真原文 A' },        // 与裸 id 逐字相同 ⇒ 幂等跳过、不计
  { role: 'assistant', text: 'NSIDE-导入侧旧副本 Y' },   // 只在 import: 侧有 ⇒ C′ 前指纹只取裸 id ⇒ 计入;C′ 后**不计**(§19)
  { role: 'user', text: 'NSIDE-全新的一句' },            // 两侧都没有 ⇒ 计入
] }]);
check(rBoth.folded === 1 && rBoth.foldSkippedRaw === 1, '★★A\'③ 两侧都有 ⇒ 相同不计/不同计;**C′ 后**只在 import: 侧有的那轮也不计 ⇒ 期望 1(实测 ' + rBoth.foldSkippedRaw + ';C′ 前此处 = 2,见 §19)');
check(rawDigest(NSB) === bDigest && clobberedOf(NSB, bSnap) === 0, '★★A\'③ 裸 id 侧原文**逐字不变**(clobbered=0,不回归;修前此处 = 2)');
check(rawDigest(NSB_RAW) === bImpDigest && JSON.stringify(rawRows(NSB_RAW)) === JSON.stringify(bImpRows),
  '★A\'③ import: 侧原文也**一个字没动**(本批不做数据迁移;sha ' + bImpDigest + ' → ' + rawDigest(NSB_RAW) + ')');
check(rawRows(NSB).length === 2 && rawRows(NSB_RAW).length === 2, '★A\'③ 没有多出任何副本(两侧各自 2 轮,raw 行数不增)');
check(rawHoldersSql(NSB).length === 2, '★A\'③ 两侧各自持有(各自原有,不是这次新写的;本批不做"迁移合并")');

// ═══════════════════════════════════════════════════════════════════════════
// 19) C′(2026-10-01)折叠的**逐条指纹**也扩到候选链:两侧都有原文时,
//     `import:` 侧**已有的同一轮**不再被算成"未替换"。
//   旧写法(修前):存在判据已按候选链任一侧判(A'),但逐条比对的 `have` 集**只查写入目标(裸 id)**
//     ⇒ 只在 `import:<id>` 侧存在的同一轮在 `have` 里找不到 ⇒ 计入 foldSkippedRaw
//     (把幂等重复说成"原文未替换":计数偏大、方向保守)。
//   本段钉:① 那一轮**不计入**;② 两侧原文**一个字没动**(本批不做迁移);③ 负对照:两侧都没有的轮次**仍计入**
//     (证明扩指纹没有把计数整体调松)。
const CPS = 'fold-case:fingerprint';
const CPS_RAW = rawSessionId(IMPORT_SOURCE, CPS);
mem.upsertOverview({ conv_id: CPS, source: 'dsweb', title: 'C′ 指纹-两侧都有', category: 'daily', overview_ok: true, summary: '壳行' });
mem.appendRawTurn(CPS, { seq: 1, role: 'user', ts: null, model: null, text: 'C′-目标侧第 1 轮' });
mem.appendRawTurn(CPS, { seq: 2, role: 'assistant', ts: null, model: null, text: 'C′-目标侧第 2 轮' });
mem.appendRawTurn(CPS_RAW, { seq: 1, role: 'user', ts: null, model: null, text: 'C′-导入侧旧第 1 轮' });
mem.appendRawTurn(CPS_RAW, { seq: 2, role: 'assistant', ts: null, model: null, text: 'C′-两侧都有的那一轮' });
const cpsSnap = snapOf(CPS); const cpsDigest = rawDigest(CPS);
const cpsImpRows = rawRows(CPS_RAW); const cpsImpDigest = rawDigest(CPS_RAW);
check(rawSessionCandidates(IMPORT_SOURCE, CPS).every((k) => mem.rawTurnCount(k) > 0), '★C′ 前置:候选链**两侧都有**原文(' + JSON.stringify(rawHoldersSql(CPS)) + ')');
const rCps = await applyImportItems(mem, [{ id: CPS, title: 'C′ 指纹-两侧都有(折叠)', startedAt: '2026-08-05T00:00:00Z', messages: [
  { role: 'user', text: 'C′-目标侧第 1 轮' },          // 裸 id 侧已有 ⇒ 幂等跳过(旧/新口径都不计)
  { role: 'assistant', text: 'C′-两侧都有的那一轮' },  // **只在 import: 侧有** ⇒ C′ 后不计(旧写法计 1)
  { role: 'user', text: 'C′-两侧都没有的新轮' },       // 两侧都没有 ⇒ 计入
] }]);
check(rCps.folded === 1, '★C′ 命中 dsweb 域 ⇒ 走折叠分支');
check(rCps.foldSkippedRaw === 1, '★★C′ 两侧都有原文:`import:` 侧**已有的那一轮不计入**未替换数(实测 ' + rCps.foldSkippedRaw + ',期望 1;旧写法 = 2)');
check(rCps.foldSkippedRaw < 2, '★C′ 计数方向:不再把"import: 侧已有的同一轮"算成未替换(不再偏大)');
check(rawDigest(CPS) === cpsDigest && clobberedOf(CPS, cpsSnap) === 0, '★C′ 写入目标侧原文逐字不变(clobbered=0)');
check(rawDigest(CPS_RAW) === cpsImpDigest && JSON.stringify(rawRows(CPS_RAW)) === JSON.stringify(cpsImpRows),
  '★★C′ `import:` 侧原文**一个字没动**(只让计数更准,不做迁移;sha ' + cpsImpDigest + ' → ' + rawDigest(CPS_RAW) + ')');
check(mem.rawTurnCount(CPS) === 2 && mem.rawTurnCount(CPS_RAW) === 2 && rawHoldersSql(CPS).length === 2,
  '★C′ 没有多出任何副本(两侧各自仍 2 轮:' + mem.rawTurnCount(CPS) + '/' + mem.rawTurnCount(CPS_RAW) + ')');
check(rawTextsLike('C′-两侧都没有的新轮') === 0, '★C′ 本次导入的正文一个字都没进库(不是"换个 id 存")');
// 负对照:候选链两侧都没有的轮次 ⇒ 仍必须计入
const CPSN = 'fold-case:fingerprint-none';
mem.upsertOverview({ conv_id: CPSN, source: 'dsweb', title: 'C′ 指纹-负对照', category: 'daily', overview_ok: true, summary: '壳行' });
mem.appendRawTurn(CPSN, { seq: 1, role: 'user', ts: null, model: null, text: 'C′-负对照目标侧' });
const rCpsn = await applyImportItems(mem, [{ id: CPSN, title: 'C′ 指纹-负对照(折叠)', startedAt: '2026-08-06T00:00:00Z', messages: [
  { role: 'assistant', text: 'C′-负对照全新 A' }, { role: 'user', text: 'C′-负对照全新 B' },
] }]);
check(rCpsn.folded === 1 && rCpsn.foldSkippedRaw === 2, '★C′ 负对照:两侧都没有的 2 轮仍**全部计入**(实测 ' + rCpsn.foldSkippedRaw + ',期望 2 —— 扩指纹没把计数调松)');
console.log("C′ 折叠指纹扩到候选链 · 实测读数");
console.log('  两侧都有 ' + CPS + ' · foldSkippedRaw=' + rCps.foldSkippedRaw + '(旧写法=2) · 裸 id sha ' + cpsDigest + ' → ' + rawDigest(CPS)
  + ' · import: sha ' + cpsImpDigest + ' → ' + rawDigest(CPS_RAW) + ' · 持有人=' + JSON.stringify(rawHoldersSql(CPS)));
console.log('  负对照 ' + CPSN + ' · foldSkippedRaw=' + rCpsn.foldSkippedRaw + ' · 裸 id 轮数=' + mem.rawTurnCount(CPSN));

// ── A 的实测读数(判据要求"给实测值,不接受没报错";下面是本次新增用例的原始读数)──────
console.log('A 折叠不覆盖已有原文 · 实测读数');
console.log('  ① 完全相同 ' + SAME + ' · foldSkippedRaw=' + rSame.foldSkippedRaw + ' · 轮数=' + mem.rawTurnCount(SAME)
  + ' · clobbered=' + clobberedOf(SAME, sameSnap) + ' · sha ' + sameDigest + ' → ' + rawDigest(SAME)
  + ' · 原文=' + JSON.stringify(rawRows(SAME).map((r) => r.text)));
console.log('  ② 内容不同 ' + DIFF + ' · foldSkippedRaw=' + rDiff.foldSkippedRaw + ' · 轮数=' + mem.rawTurnCount(DIFF)
  + ' · clobbered=' + clobberedOf(DIFF, diffSnap) + '(修前=3) · sha ' + diffDigest + ' → ' + rawDigest(DIFF)
  + ' · 原文=' + JSON.stringify(rawRows(DIFF).map((r) => r.text)));
console.log('  ③ 负对照(目标无原文)' + NONE + ' · foldSkippedRaw=' + rNone.foldSkippedRaw + ' · 轮数=' + mem.rawTurnCount(NONE)
  + ' · 原文=' + JSON.stringify(rawRows(NONE).map((r) => r.text)));
console.log('  ④ 部分重叠 ' + MIX + ' · foldSkippedRaw=' + rMix.foldSkippedRaw + ' · clobbered=' + clobberedOf(MIX, mixSnap)
  + ' · sha ' + mixDigest + ' → ' + rawDigest(MIX));
console.log('  账本 line(>0)=' + formatLogLine(recSkip));
console.log('  账本 键(>0)=' + Object.keys(recSkip).join(',') + ' · 键(=0)=' + Object.keys(recZero).join(','));
console.log('  行文案(=0 基线)=' + lineBase);
console.log('  行文案(>0 追加)=' + lineSkip);
console.log("A' 折叠判据扩到 import: 命名空间 · 实测读数");
console.log('  ① 只 import: 侧有原文 ' + NS + ' · 裸 id 轮数=' + mem.rawTurnCount(NS) + '(修前=3) · foldSkippedRaw=' + rNs.foldSkippedRaw
  + ' · 该会话有原文的 session_id=' + JSON.stringify(rawHoldersSql(NS)) + '(修前=2 个) · import: 原文 sha ' + nsDigest + ' → ' + rawDigest(NS_RAW));
console.log('  ② 负对照(两侧都空)' + NSN + ' · 裸 id 轮数=' + mem.rawTurnCount(NSN) + ' · foldSkippedRaw=' + rNsNone.foldSkippedRaw
  + ' · 原文=' + JSON.stringify(rawRows(NSN).map((r) => r.text)));
console.log('  ③ 两侧都有 ' + NSB + ' · foldSkippedRaw=' + rBoth.foldSkippedRaw
  + ' · 裸 id sha ' + bDigest + ' → ' + rawDigest(NSB) + ' · import: sha ' + bImpDigest + ' → ' + rawDigest(NSB_RAW));

// ── E3(2026-10-01):来源列落地 —— 导入侧原文留下的"来源"必须是**记下来的**,不是后来猜的 ──────
// 两条路径的来源名不同,都必须如实:
//   · 常规导入 ⇒ `import:<id>`(G4 命名空间)⇒ source='import'(显式给,不靠 id 形状);
//   · dsweb 折叠分支 ⇒ 写进**裸 id**(该分支本就把导入内容并入 dsweb 域)⇒ source 缺省推导 = 'dsh',
//     与旧"裸 id = DSH 会话"判据**同解** ⇒ 裁决不变(若硬记 'dsweb',这些轮次会从概述器眼里消失)。
const { rawSourceOf, RAW_SOURCE_DSH, RAW_IMPORT_PREFIX } = await imp('lib/host/memory.js');
const rawSrcOf = (sid) => mem.db.prepare('SELECT DISTINCT source FROM dsh_turns_raw WHERE session_id=? ORDER BY source').all(sid).map((r) => r.source);
const FRESH_SRC = 'src-case:raw-source';
const rFreshSrc = await applyImportItems(mem, [{ id: FRESH_SRC, title: '来源列落地-常规导入', startedAt: '2026-08-07T00:00:00Z', messages: [
  { role: 'user', text: '来源列:常规导入第 1 轮' }, { role: 'assistant', text: '来源列:常规导入第 2 轮' },
] }]);
check(rFreshSrc.newRows === 1, 'E3 前置:常规导入落一条概述(newRows=' + rFreshSrc.newRows + ')');
const freshRawId = rawSessionId(IMPORT_SOURCE, FRESH_SRC);
check(freshRawId === RAW_IMPORT_PREFIX + FRESH_SRC, 'E3 前置:常规导入原文落 import: 命名空间(' + freshRawId + ')');
check(JSON.stringify(rawSrcOf(freshRawId)) === '["import"]', 'E3:常规导入原文记 source=import(实得 ' + JSON.stringify(rawSrcOf(freshRawId)) + ')');
check(JSON.stringify(rawSrcOf(FRESH_SRC)) === '[]', 'E3:常规导入不往裸 id 写原文(跨源隔离仍成立)');
check(mem.rawTurnCount(NONE) > 0 && JSON.stringify(rawSrcOf(NONE)) === JSON.stringify([rawSourceOf(NONE)]),
  'E3:折叠分支的来源 = 按 id 推导(rawSourceOf),不是凭空写的,实得 ' + JSON.stringify(rawSrcOf(NONE)));
check(rawSrcOf(NONE)[0] === 'fold-case', 'E3:该 fixture 的 id 自带冒号(' + NONE + ')⇒ 记 source=fold-case;'
  + '与旧判据(instr(id,":")=0 为假 ⇒ 排除)**同解**,裁决不变(记录值跟着 id 形状走,不是新发明的来源名)');
// 无冒号 id 的折叠:推导 ⇒ source='dsh' ⇒ 照旧入概述集(与旧"裸 id"判据同解)
const FOLD_PLAIN = 'foldcasesrcplain';
mem.upsertOverview({ conv_id: FOLD_PLAIN, source: 'dsweb', title: 'E3 折叠-无冒号 id', category: 'daily', overview_ok: true, summary: '壳行' });
const rFoldPlain = await applyImportItems(mem, [{ id: FOLD_PLAIN, title: 'E3 折叠-无冒号 id', startedAt: '2026-08-08T00:00:00Z', messages: [{ role: 'user', text: 'E3 折叠补进来的原文' }] }]);
check(rFoldPlain.folded === 1 && JSON.stringify(rawSrcOf(FOLD_PLAIN)) === '["dsh"]',
  'E3:无冒号 id 的 dsweb 折叠 ⇒ source=dsh(与旧"裸 id = DSH 会话"判据同解),实得 folded=' + rFoldPlain.folded + ' src=' + JSON.stringify(rawSrcOf(FOLD_PLAIN)));
check(JSON.stringify(rawSrcOf(NS_RAW)) === '["import"]', 'E3:A′ 用例的 import: 侧原文同样记 source=import(实得 ' + JSON.stringify(rawSrcOf(NS_RAW)) + ')');

console.log(ok ? '契约文件导入 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
