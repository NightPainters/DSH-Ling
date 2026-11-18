// 第 4 层(会话作为节点)单元测试 —— M1,2026-11-04
//
// 口径(主人 2026-11-04 裁定 = 侦察报告 §3.4 选项 A):
//   · 会话行 = 纯 live 会话(branchSessions(),复用 MEMBER_LIVE_SESSION),行数上界 = branchMemberCounts().sessions[b];
//   · sessions:true 时枝行尾印「会话 X · 条目 M」(M = members - sessions),条目只计数、不进第 4 层;
//   · 默认 maxSessions=0 的输出**逐字不变**(旧「会话 N」仍取 members)。
//   · DESIGN §5.3 的「会话数 == members」作废:反例 br:alpha members=4 / sessions=3(差 1 条 dsweb 条目)。
//
// 关键反证(回退必红):
//   ① 截断段:把 truncated 改回旧公式(或删掉 `|| sessionLinesCut`)→ 30 枝×5 会话(枝被截)与
//      23 枝×6 会话(枝全印完、只截会话行/「另有」行)两个用例都会变红;
//   ② 本段②:枝行若改回用 members 当「会话」数(或把条目冒充会话),`会话 3 · 条目 1` 的断言变红。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore, TRUNK_ID } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const {
  registerLingTools, checkTreeRead, TREE_READ_SPEC, TOOL_TREE_READ,
} = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
// 修复轮:与 tools.test.mjs:239-243 同形的递归检查。不能再用 `JSON.stringify(...).indexOf('undefined')`
// —— stringify 会**直接丢弃**值为 undefined 的属性,那条断言逻辑上永远不可能失败(空转)。
const hasUndef = (v, seen = new Set()) => {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => x === undefined || hasUndef(x, seen));
  return Object.entries(v).some(([, x]) => x === undefined || hasUndef(x, seen));
};
const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-'));
const settings = new SettingsFile(join(dir, 'set'));
const toolOf = (db) => {
  const reg = [];
  const ctx = { tools: { register: (spec) => { reg.push(spec); return () => {}; } } };
  const r = registerLingTools(ctx, { gate: { snapshotIds: () => [] }, memory: db, settings });
  check(r.ok === true, '注册工具成功');
  return reg.find((s) => s.name === TOOL_TREE_READ);
};
const renderOf = (tool, v) => tool.output.render({}, v)[0].text;

// ── fixture:一棵固定形状的树 ───────────────────────────────────────────────
// 主干 ─┬─ 主脉V ─┬─ 甲枝(3 个 live 会话 + 1 条 dsweb 条目 + 1 个空壳)
//       │         └─ 乙枝(1 个 live 会话)
//       └─ 空枝(0 会话)
const db = new MemoryStore(join(dir, 'm.db'));
const addOv = (source, cid, title, when) => db.upsertOverview({
  source, conv_id: cid, title, category: 'knowledge', summary: title, overview_ok: true, updated_at: when || null,
});
db.createVein({ id: 'vein:v1', name: '主脉V' });
db.createBranch({ id: 'br:alpha', name: '甲枝', parentId: 'vein:v1' });
db.createBranch({ id: 'br:beta', name: '乙枝', parentId: 'vein:v1' });
db.createBranch({ id: 'br:empty', name: '空枝' });
// 固定排序键(否则同一毫秒建的枝顺序依赖 id 字典序,对拍不稳)
const fixCreated = (id, at) => db.db.prepare('UPDATE branch SET created_at=? WHERE id=?').run(at, id);
fixCreated(TRUNK_ID, '2026-01-01T00:00:00.000Z');
fixCreated('vein:v1', '2026-01-02T00:00:00.000Z');
fixCreated('br:alpha', '2026-01-03T00:00:00.000Z');
fixCreated('br:beta', '2026-01-04T00:00:00.000Z');
fixCreated('br:empty', '2026-01-05T00:00:00.000Z');
// 甲枝:2 条"有概述"的会话 + 1 条"只有原文"的会话 + 1 个空壳 + 1 条非会话条目
db.setSessionBranch('s-a1', 'br:alpha');
addOv('dsh', 's-a1', '甲会话一', '2026-10-01T00:00:00.000Z');
db.setSessionBranch('s-a2', 'br:alpha');
addOv('dsh', 's-a2', '甲会话二', '2026-10-03T00:00:00.000Z');
db.appendRawTurn('s-raw', { seq: 1, role: 'user', text: '只有原文的会话(第一条用户消息)', ts: '2026-09-01T00:00:00.000Z' });
db.setSessionBranch('s-raw', 'br:alpha');
db.setSessionBranch('s-empty', 'br:alpha'); // 空壳:既无概述、又无原文 ⇒ live 谓词不认
addOv('dsweb', 'w2', '网页条目', null);
check(db.setConvBranch('dsweb', 'w2', 'br:alpha').ok === true, '覆盖层条目挂到甲枝');
// 乙枝 / 主干:各 1 条 live 会话(主干用来验"kind!=='branch' 不展开")
db.setSessionBranch('s-b1', 'br:beta');
addOv('dsh', 's-b1', '乙会话', '2026-10-05T00:00:00.000Z');
db.setSessionBranch('s-t1', TRUNK_ID);
addOv('dsh', 's-t1', '主干会话', '2026-10-06T00:00:00.000Z');

// ── 1) branchSessions():口径、排序、降级 ──────────────────────────────────
const alphaS = db.branchSessions('br:alpha', 5);
check(Array.isArray(alphaS) && alphaS.length === 3,
  'branchSessions:只返回 live 会话(排除空壳与非会话条目),实际 ' + alphaS.length);
check(alphaS[0].sessionId === 's-a2' && alphaS[1].sessionId === 's-a1' && alphaS[2].sessionId === 's-raw',
  'branchSessions:updated_at 倒序,NULL 排最后,实际 ' + JSON.stringify(alphaS.map((s) => s.sessionId)));
check(alphaS[0].updatedAt === '2026-10-03T00:00:00.000Z' && alphaS[2].updatedAt === null,
  'branchSessions:updatedAt 取 conv_overview;只有原文的会话为 null');
check(alphaS[2].title === '只有原文的会话(第一条用户消息)',
  'branchSessions:标题回退到原文首条 user 消息,实际 ' + JSON.stringify(alphaS[2].title));
check(alphaS.every((s) => typeof s.sessionId === 'string' && typeof s.title === 'string' && 'updatedAt' in s),
  'branchSessions:返回体形状 {sessionId,title,updatedAt}');
check(db.branchSessions('br:alpha', 2).length === 2 && db.branchSessions('br:alpha', 2)[0].sessionId === 's-a2',
  'branchSessions:limit 生效(取最近的 N 条)');
check(db.branchSessions('br:alpha', 0).length === 0, 'branchSessions:limit=0 就是空(不回落默认值)');
check(db.branchSessions('br:no-such-branch', 5).length === 0, 'branchSessions:不存在的枝 → []');
check(db.branchSessions(TRUNK_ID, 5).length === 1 && db.branchSessions(TRUNK_ID, 5)[0].title === '主干会话',
  'branchSessions:主干也能取(树渲染只是不展开它)');
// 复用谓词的源码护栏:branchSessions 体内必须出现 MEMBER_LIVE_SESSION(不许另写一套谓词)
const memSrc = readFileSync(join(root, 'lib/host/memory.js'), 'utf8');
const at = memSrc.indexOf('branchSessions(branchId');
const end = at >= 0 ? memSrc.indexOf('\n  }\n', at) : -1;
check(at >= 0 && end > at && memSrc.slice(at, end).includes('MEMBER_LIVE_SESSION'),
  'branchSessions 复用 MEMBER_LIVE_SESSION(不另写谓词)');
// 缺表降级:新建库后拆掉 session_meta,读侧必须回 []
const dirBroken = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-broken-'));
const broken = new MemoryStore(join(dirBroken, 'b.db'));
broken.db.exec('DROP TABLE session_meta');
check(Array.isArray(broken.branchSessions('trunk', 5)) && broken.branchSessions('trunk', 5).length === 0,
  'branchSessions:缺表降级为 [](不抛)');

// ── 2) 计数口径自检:members > sessions 是真实的(不是把条目冒充会话)────────
const bc = db.branchMemberCounts();
check(Number(bc.sessions['br:alpha']) === 3 && Number(bc.members['br:alpha']) === 4,
  '口径自检:甲枝 sessions=3 / members=4(差 1 条 dsweb 条目),实际 '
    + bc.sessions['br:alpha'] + '/' + bc.members['br:alpha']);
check(Number(bc.rows['br:alpha']) === 4, '口径自检:rows 含空壳(4),不代表 live 会话');
check(alphaS.length === Number(bc.sessions['br:alpha']), 'branchSessions 条数 == .sessions[b](选项 A 的验收)');

// ── 3) schema / 参数自校验 ─────────────────────────────────────────────────
check(TREE_READ_SPEC.parameters.properties.sessions?.type === 'boolean',
  'TREE_READ_SPEC.parameters 声明 sessions(boolean)');
check(/默认 false/.test(String(TREE_READ_SPEC.parameters.properties.sessions?.description || '')),
  'sessions 参数描述写明默认 false');
check(checkTreeRead({ action: 'tree', sessions: true }).sessions === true,
  'checkTreeRead 回传 sessions(改之前被丢弃 ⇒ execute 里 c.sessions 恒 undefined)');
check(checkTreeRead({ action: 'tree' }).sessions === false, 'checkTreeRead:缺省 sessions=false');
check(checkTreeRead({ action: 'tree' }).limit === 20 && checkTreeRead({ action: 'tree', limit: 5 }).limit === 5,
  'checkTreeRead:limit 行为不变(零回归)');
// verify §3.2(M2)的覆盖缺口:treeLines 未 export,默认 maxSessions=0 在现有调用图里不可达 ⇒
// 改默认值 0→5 原本没有任何测试变红。源码护栏按 verify 建议兜底(改默认值必红)。
const toolsSrc = readFileSync(join(root, 'lib/host/tools.js'), 'utf8');
check(/function treeLines\(memory, \{ maxLines = 60, maxSessions = 0 \} = \{\}\)/.test(toolsSrc),
  'treeLines 默认参数 maxSessions=0(源码护栏;verify M2 缺口:改成 5 必须变红)');

// ── 4) 默认输出:逐字旧行为(零回归的口径面)──────────────────────────────
const tool = toolOf(db);
const r0 = await tool.execute({ action: 'tree' }, {});
check(r0.ok === true && r0.sessions === undefined, '默认回执没有 sessions 字段(不新增可见字段)');
check(r0.sessionLinesCut === undefined, '默认回执没有 sessionLinesCut 字段(它只在 sessions 模式可能出现)');
check(r0.branches === 5 && r0.lines.length === 5, '默认:5 条枝 = 5 行(1 节点 1 行,旧行为)');
check(r0.truncated === false, '默认:未截断时 truncated=false');
check(r0.lines.some((l) => l === '▣ 主干｜会话 1｜子枝 2｜trunk'), '默认:主干行逐字旧文案,实际 ' + JSON.stringify(r0.lines[0]));
check(r0.lines.some((l) => /甲枝｜会话 4｜br:alpha$/.test(l)),
  '默认:枝行尾「会话 N」仍取 members(旧口径;零回归优先),实际 ' + JSON.stringify(r0.lines.find((l) => l.includes('甲枝'))));
check(r0.lines.every((l) => !/[├└]/.test(l)), '默认:没有任何会话行');
const t0 = renderOf(tool, r0);
check(t0.includes('记忆树概览(共 5 条枝') && t0.includes('▣ 主干｜会话 1｜子枝 2｜trunk'), '默认:渲染文本含旧概览头与主干行');
check(!t0.includes('…另有') && !t0.includes('显示已达上限'), '默认:没有第 4 层提示语');

// ── 5) sessions:true:会话节点 + 同口径双计数 ─────────────────────────────
const r1 = await tool.execute({ action: 'tree', sessions: true }, {});
check(r1.ok === true && r1.sessions === true, 'sessions:true 回执带标记');
check(r1.truncated === false, 'sessions:true 未撞上限 ⇒ truncated=false');
check(r1.lines.length <= 160, 'sessions:true 总行数 ≤ maxLines(160),实际 ' + r1.lines.length);
const lineOf = (name) => r1.lines.find((l) => l.includes(name)) || '';
const alphaLine = lineOf('甲枝');
check(/甲枝｜会话 3 · 条目 1｜br:alpha$/.test(alphaLine),
  'sessions:true 枝行尾「会话 X · 条目 M」= .sessions/.members-.sessions(选项 A),实际 ' + JSON.stringify(alphaLine));
check(/乙枝｜会话 1｜br:beta$/.test(lineOf('乙枝')), 'sessions:true:无条目时只印「会话 X」(M=0 不显示)');
check(/空枝｜会话 0｜br:empty$/.test(lineOf('空枝')), 'sessions:true:空枝不出现会话行');
check(/▣ 主干｜会话 1｜子枝 2｜trunk$/.test(lineOf('主干')), 'sessions:true:主干行尾只印会话数(kind!==branch 不展开)');
const t1 = renderOf(tool, r1);
check(t1.includes('├ 甲会话二   2026-10-03') && t1.includes('├ 甲会话一   2026-10-01'),
  'sessions:true:甲枝会话行按时间倒序,且带日期(UTC 前 10 位)');
check(t1.includes('└ 只有原文的会话(第一条用户消息)'), 'sessions:true:只有原文的会话行(无日期,标题回退原文)');
check(t1.includes('└ 乙会话   2026-10-05'), 'sessions:true:乙枝会话行(前一条是 ├、最后一条是 └)');
check(!t1.includes('主干会话'), 'sessions:true:主干不展开(kind=trunk)');
check(!/s-a1|s-a2|s-raw|s-b1/.test(t1), 'sessions:true:不印会话 id');
const sessionRows = r1.lines.filter((l) => /^\s+[├└] /.test(l));
check(sessionRows.length === Number(bc.sessions['br:alpha']) + Number(bc.sessions['br:beta']),
  'sessions:true:会话行数 == Σ .sessions[b](3+1),实际 ' + sessionRows.length);
check(!t1.includes('…另有'), 'sessions:true:未超 maxSessions(5)时不出现「另有」');

// ── 6) 「…另有 N 个会话」:N 只按会话算,且 == .sessions[b] - 已列会话行 ────
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-many-'));
const db2 = new MemoryStore(join(dir2, 'm.db'));
const SET_TIMES = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
db2.createBranch({ id: 'br:many', name: '多会话枝' });
db2.setSessionBranch('s-m1', 'br:many');
for (let i = 0; i < 7; i += 1) {
  const sid = 's-m' + (i + 1);
  db2.setSessionBranch(sid, 'br:many');
  db2.upsertOverview({ source: 'dsh', conv_id: sid, title: '多会话' + (i + 1), category: 'knowledge', summary: 'x', overview_ok: true, updated_at: SET_TIMES[i] + 'T00:00:00.000Z' });
}
db2.upsertOverview({ source: 'dsweb', conv_id: 'w9', title: '一条非会话条目', category: 'knowledge', summary: 'x', overview_ok: true });
db2.setConvBranch('dsweb', 'w9', 'br:many'); // members(8) > sessions(7) —— 条目绝不能进会话行/「另有」
const tool2 = toolOf(db2);
const r2 = await tool2.execute({ action: 'tree', sessions: true }, {});
const manyLine = r2.lines.find((l) => l.includes('多会话枝')) || '';
check(/多会话枝｜会话 7 · 条目 1｜br:many$/.test(manyLine), '另有用例:枝行 = 会话 7 · 条目 1,实际 ' + JSON.stringify(manyLine));
const rows2 = r2.lines.filter((l) => /^\s+[├└] /.test(l));
const listed2 = rows2.filter((l) => !l.includes('…另有'));
const extra2 = rows2.find((l) => l.includes('…另有')) || '';
check(listed2.length === 5, '另有用例:最多列 maxSessions=5 条会话行,实际 ' + listed2.length);
check(/…另有 2 个会话/.test(extra2) && rows2.length === 6,
  '另有用例:N = .sessions - 已列会话行 = 7-5 = 2(条目不算),实际 ' + JSON.stringify(extra2));
check(Number(db2.branchMemberCounts().sessions['br:many']) - listed2.length === 2,
  '另有用例:N == .sessions[b] - shown(选项 A 的验收)');
check(listed2[0].includes('多会话7') && listed2[4].includes('多会话3'),
  '另有用例:列的是最近 5 条(倒序),实际 ' + JSON.stringify(listed2.map((l) => l.trim().slice(0, 12))));

// ── 7) 截断:会话行也吃 maxLines —— 旧公式会假阴性(★主反证)────────────────
// 30 枝 × (1 枝 + 5 会话) = 180 行 > 160:至少 1 条枝被截掉。
// 旧公式 branches(31) > lines.length(160) === false ⇒ truncated=false、不提示 ⇒ 本段必红。
const dir3 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-cut-'));
const db3 = new MemoryStore(join(dir3, 'm.db'));
for (let b = 0; b < 30; b += 1) {
  const bid = 'br:cut' + String(b).padStart(2, '0');
  db3.createBranch({ id: bid, name: '截断枝' + b });
  for (let s = 0; s < 5; s += 1) {
    const sid = `s-${b}-${s}`;
    db3.setSessionBranch(sid, bid);
    db3.upsertOverview({ source: 'dsh', conv_id: sid, title: `会话${b}-${s}`, category: 'knowledge', summary: 'x', overview_ok: true, updated_at: '2026-10-0' + ((s % 9) + 1) + 'T00:00:00.000Z' });
  }
}
const tool3 = toolOf(db3);
const r3 = await tool3.execute({ action: 'tree', sessions: true }, {});
check(r3.lines.length === 160, '截断:sessions 模式确实把预算吃满(is 160),实际 ' + r3.lines.length);
check(r3.lines.length <= 160, '截断:总行数 ≤ maxLines(硬上限)');
check(r3.branches === 31, '截断:branches 仍是全量枝数(31),实际 ' + r3.branches);
check(r3.truncated === true,
  '★截断:枝被截掉时 truncated 必须为 true(改回 branches > lines.length 必红:31>160 为 false)');
const t3 = renderOf(tool3, r3);
check(/…显示已达上限/.test(t3) && !/枝数超出显示上限/.test(t3),
  '截断:sessions 模式给同口径提示(不再说"枝数超出"),实际 ' + JSON.stringify(t3.slice(-80)));
check(!/memory|undefined/.test(t3), '截断:渲染不夹带内部字段');

// ── 7b) 修复轮:所有枝行印完、只有会话行/「另有」行被预算截掉(钉住 sessionLinesCut)──
// 形状:23 枝 × 6 会话 ⇒ 每枝 1 枝行 + 5 会话行 + 1 条「…另有 1 个会话」= 7 行;
// 总共 1(主干)+ 23×7 = 162 行 > 160。第 23 枝行落在第 156 行 ⇒ 24 条枝行全部印出
// (branches === branchesShown === 24),预算只切掉最后一条枝的第 5 条会话行与「…另有」行。
// 此时旧公式 `branches > branchesShown`(24 > 24)为 false ⇒ 删掉 `|| sessionLinesCut` 后
// 本段必红:truncated=false、无「会话行超出显示上限」提示。这也是 impl §6.7 声称覆盖、
// 旧用例实际没覆盖的路径(旧用例每枝恰好 5 条会话,extra=0,根本没有「另有」行)。
const dir5 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-scut-'));
const db5 = new MemoryStore(join(dir5, 'm.db'));
for (let b = 0; b < 23; b += 1) {
  const bid = 'br:sc' + String(b).padStart(2, '0');
  db5.createBranch({ id: bid, name: '会话截断枝' + String(b).padStart(2, '0') });
  for (let s = 0; s < 6; s += 1) {
    const sid = 's-sc' + b + '-' + s;
    db5.setSessionBranch(sid, bid);
    db5.upsertOverview({ source: 'dsh', conv_id: sid, title: '会话' + b + '-' + s, category: 'knowledge', summary: 'x', overview_ok: true, updated_at: '2026-10-0' + (s + 1) + 'T00:00:00.000Z' });
  }
}
const tool5 = toolOf(db5);
const r5 = await tool5.execute({ action: 'tree', sessions: true }, {});
check(r5.lines.length === 160 && r5.branches === 24,
  '会话行截断:160 行 / 24 枝,实际 ' + r5.lines.length + '/' + r5.branches);
const branchRows5 = r5.lines.filter((l) => !/^\s+[├└] /.test(l));
check(branchRows5.length === r5.branches,
  '会话行截断:所有枝行都印完(枝没有被截),实际 ' + branchRows5.length + '/' + r5.branches);
check(r5.truncated === true,
  '★只有会话行被截:truncated 必须为 true(删掉 || sessionLinesCut 必红:24>24=false)');
check(r5.sessionLinesCut === true,
  '★只有会话行被截:回执显式带 sessionLinesCut=true(CEO 2026-11-04 口径)');
const extraRows5 = r5.lines.filter((l) => l.includes('…另有'));
check(extraRows5.length === 22 && !r5.lines[r5.lines.length - 1].includes('…另有'),
  '会话行截断:最后一条枝的「…另有」行被预算截掉(其余 22 枝各 1 条已印),实际 ' + extraRows5.length);
// 修复轮(CEO 2026-11-04 追加):预算切在会话行中间时,最后一条**实际印出的**会话行必须用 └ 收尾;
// 旧写法只看 `i === lines.length - 1`,会留下"悬空 ├、没有 └"(最后一行是 ├,看起来后面还有下文)。
check(/^\s+└ /.test(r5.lines[r5.lines.length - 1]),
  '★会话行截断:最后一条实际印出的会话行用 └ 收尾(不留悬空 ├),实际 '
    + JSON.stringify(r5.lines[r5.lines.length - 1]));
const t5 = renderOf(tool5, r5);
check(/…显示已达上限/.test(t5) && /…会话行超出显示上限,用 action=members 看单枝/.test(t5),
  '会话行截断:提示语 = 总截断提示 + 会话行超限中性提示,实际 ' + JSON.stringify(t5.slice(-140)));

// ── 8) 默认模式截断:旧公式等价性(60 行 + 旧提示语)──────────────────────
const dir4 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree4-default-cut-'));
const db4 = new MemoryStore(join(dir4, 'm.db'));
for (let b = 0; b < 65; b += 1) db4.createBranch({ id: 'br:d' + String(b).padStart(2, '0'), name: '默认截断枝' + b });
const tool4 = toolOf(db4);
const r4 = await tool4.execute({ action: 'tree' }, {});
check(r4.lines.length === 60 && r4.branches === 66 && r4.truncated === true,
  '默认截断:60 行 / 66 枝 / truncated=true(与改动前公式逐字等价),实际 '
    + r4.lines.length + '/' + r4.branches + '/' + r4.truncated);
const t4 = renderOf(tool4, r4);
check(/…枝数超出显示上限,用 action=members 看某一条的具体会话/.test(t4),
  '默认截断:提示语逐字不变(零回归)');

// ── 9) sessions 模式 rows 形状 / lossless 兼容(日期是 ISO 字符串,不是 Date)──
check(r1.lines.every((l) => typeof l === 'string'), 'sessions:true:lines 全是字符串(可直接渲染)');
// 修复轮:原断言 `JSON.stringify(r1).indexOf('undefined')` 恒为 -1(空转),改用递归 hasUndef。
check(hasUndef({ x: undefined }) === true, 'hasUndef 自检:确实能抓到 undefined(防止再次空转)');
check(!hasUndef(r1), 'sessions:true:回执无 undefined(递归检查,覆盖 sessions 回执)');
check(!hasUndef(r0) && !hasUndef(r2) && !hasUndef(r3) && !hasUndef(r4) && !hasUndef(r5),
  '各 tree 回执(默认 / 另有 / 枝截断 / 默认截断 / 会话行截断)均无 undefined');

console.log(ok ? '树第 4 层(会话作为节点)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
