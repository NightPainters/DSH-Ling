// dsh-ling host — 会话内工具:规矩直达(rule_add)与习惯提议(habit_propose)。
//
// 注册方式:**纯 JSON-Schema 对象**,不 import `@deepseek-ai/dsh-tools`。
// 依据:第三方插件 @liustack/modsearch 在同一宿主上采用同样做法,其注释写明
// "out-of-tree resolution of @deepseek-ai/dsh-tools is not yet reliable"。
// 参数校验因此由本模块自己承担(见 `checkRuleAdd` / `checkHabitPropose`)。
//
// 语义(2026-09-15 与用户定稿):
//   - 规矩 = 用户的指令 → 可直达;但**必须带原话**,否则写不进去(让"经同意"可核查);
//   - 习惯 = 器灵自己长出来的 → **不能直达**,只能提议,等对方确认。
//
// 调用纪律(写进工具描述,模型可见):**只在用户明确说出"记进规矩 / 写进规矩"这类指令时调用**,
// 绝不从闲聊里推断;习惯则可在观察到重复迹象时提议。

import { addRule, proposeHabit, amendHabit, resolveHabit, habitsOf, habitsPendingOf, RULE_MAX_CHARS } from './rules.js';
import { invalidateSession } from './inject.js';
// G1(2026-09-25,Part G):器灵侧正规树通道 —— 与 UI **共用同一份实现**(tree-ops.js)。
// 在这之前,器灵想改记忆树没有任何正规通道:只能伪造成本机进程身份走 UI 的 HTTP 口,
// 或者直接开库;而 logBranch 又没有 actor 参数,那些改动在复盘留痕里全被显示成"主人改的"。
import {
  opBranchMembers, opBranchCreate, opBranchRename, opBranchReparent,
  opVeinLink, opVeinUnlink, opBranchWeight, opBranchDelete,
  // D-T07:存在性判据与 assign 那条路共用一份实现(conv_overview / session_meta 双查)。
  convExistsIn,
} from './tree-ops.js';
import { TRUNK_ID, RAW_IMPORT_PREFIX } from './memory.js';
// G2(2026-09-25):遗忘与回灌 —— 这两个是"会让人后悔"的操作,动手前一律先归档落盘。
import { archiveBefore, listArchives, readArchive } from './archive.js';

export const TOOL_RULE_ADD = 'rule_add';
export const TOOL_HABIT_PROPOSE = 'habit_propose';
export const TOOL_HABIT_RESOLVE = 'habit_resolve';
export const TOOL_TREE_READ = 'tree_read';
export const TOOL_BRANCH_EDIT = 'branch_edit';
export const TOOL_MEMORY_FORGET = 'memory_forget';
export const TOOL_MEMORY_BACKFILL = 'memory_backfill';
/** 结构性改动一律要求的"为什么"最短长度 —— 留痕要能看懂,否则复盘时只能看到结果。 */
const MIN_REASON = 4;

/** link 的边类型(E2,实测报告 2026-09-24):与 vein_link.kind 既有取值对齐 —— 此前写死 'related',
 *  于是"前后置/对照"这类语义只能塞进 note 自由文本,按 kind 查询/渲染就永远拿不到。 */
const LINK_KINDS = ['related', 'prerequisite', 'contrast', 'example', 'supersede'];

/** 记忆来源域白名单(D-T07 ≡ B-11,1.5.1 红蓝对抗:两条同源)。
 *  `forgotten` / 归档 / 召回排除全按 `(source, conv_id)` 立键 ⇒ 来源域写错一个字,就是往库里
 *  塞一条**永远召不回、也永远不会被读到**的垃圾标记(红队 B:「可以往 forgotten 里落任意来源的垃圾标记」)。
 *  ⚠️ 取值必须以**库里真有的域**为准,否则会误拒真目标:
 *    · `memory.js:1821` 的采纳路径会写 `source='vein'` 的 `conv_overview` 行(主脉提炼产物,
 *      2026-09-25 补的"库内第 5 个来源")⇒ 它**能**参与召回,也就**能**被遗忘;
 *    · `api.js:61` 的 `MEM_SOURCES` 正是 `['dsh','dsweb','import','vein']`。
 *  故这里与 api.js 对齐取四项 —— 台账 §10 的修法建议只写了前三项,少一项会误伤"忘掉一条主脉主题"。
 *  (两个通道必须同一份枚举,否则工具能忘的、面板不能忘,对账时会打架。) */
const MEMORY_SOURCES = ['dsh', 'dsweb', 'import', 'vein'];

/** 从 exec 里尽力取会话 id(payload 形状随宿主版本变化,全防御)。 */
function sessionIdOf(exec) {
  const a = exec?.agent;
  return String(
    a?.sessionId ?? a?.session?.id ?? a?.id ?? exec?.sessionId ?? '',
  ) || '';
}

/** 写入成功后让所有已定稿快照失效(D4:运行中的会话只标记,空闲边界再生效)。 */
function invalidateAll(gate, memory, settings) {
  let ids = [];
  try {
    ids = typeof gate?.snapshotIds === 'function' ? gate.snapshotIds() : [];
  } catch { /* 门不可用时退化为"不失效",不能因此抛错 */ }
  for (const sid of ids) {
    try {
      invalidateSession(gate, memory, settings, sid);
    } catch (e) {
      console.debug('[dsh-ling] invalidate after rule/habit write failed', e);
    }
  }
}

/** 规矩的人读回执(模型可见)。 */
function renderRule(v) {
  if (v.ok) {
    return `已记入规矩:「${v.text}」(现共 ${v.total} 条)` +
      (v.warning === 'over-cap' ? `\n注意:规矩已超过建议上限,可考虑合并同类项。` : '') +
      `\n它会从下一个空闲边界开始生效。`;
  }
  const why = {
    'no-quote': '缺少原话:规矩必须附上用户说过的那一句(逐字引用),否则不写入。请先让用户把话说明白,或引用他刚才的原话再调一次。',
    'empty-rule': '规矩内容为空。',
    'too-long': `规矩太长(上限 ${RULE_MAX_CHARS} 字):请压缩成一条可执行的短句。`,
    'quote-too-long': '原话过长:只引用关键那一句即可。',
    duplicate: `已存在同义规矩:「${v.text}」,未重复写入。`,
    'not-found': '没有找到这条规矩。',
    'bad-action': '不支持的操作。',
  }[v.reason] || `未写入(${v.reason || '未知原因'})。`;
  return why;
}

/** 习惯提议的人读回执(模型可见)。 */
function renderHabit(v) {
  if (v.ok) {
    return `已记下这条习惯候选:「${v.text}」(待确认 ${v.pending} 条)。` +
      `\n它**还不是习惯** —— 要等用户确认之后才会写进我的人格档案。`;
  }
  const why = {
    'empty-habit': '习惯内容为空。',
    'too-long': `太长(上限 ${RULE_MAX_CHARS} 字):请浓缩成一句行为倾向。`,
    'already-habit': '这已经是定下来的习惯了,无需再提议。',
    'already-pending': '这条已经在待确认列表里了。',
    'not-found': '没有找到这条待确认提议。',
    'bad-action': '不支持的操作。',
  }[v.reason] || `未记录(${v.reason || '未知原因'})。`;
  return why;
}

/** 规矩工具的参数自校验(纯函数,便于单测)。 */
export function checkRuleAdd(args) {
  const rule = String(args?.rule ?? '').trim();
  const quote = String(args?.quote ?? '').trim();
  if (!rule) return { ok: false, reason: 'empty-rule' };
  if (!quote) return { ok: false, reason: 'no-quote' };
  return { ok: true, rule, quote };
}

/** 习惯工具的参数自校验(纯函数,便于单测)。 */
export function checkHabitPropose(args) {
  const habit = String(args?.habit ?? '').trim();
  const evidence = String(args?.evidence ?? '').trim();
  if (!habit) return { ok: false, reason: 'empty-habit' };
  return { ok: true, habit, evidence };
}

export const RULE_ADD_SPEC = {
  name: TOOL_RULE_ADD,
  description:
    '把用户的一条明确指令记入「规矩」(rules)。规矩是用户对我的要求,作用对象是行为,可直接写入。'
    + '**只在用户明确说出"记进规矩 / 写进规矩 / 以后都按这个来"这类指令时调用;绝不从闲聊、玩笑或我的推测里调用。**'
    + '调用时必须附上用户的原话(quote,逐字引用),没有原话会被拒绝 —— 这是"经他同意"的凭据。'
    + 'rule 要把他的话压缩成一条可执行的短句(≤40 字,一条一事)。',
  parameters: {
    type: 'object',
    properties: {
      rule: { type: 'string', description: '压缩后的一条规矩(≤40 字,一条一事)' },
      quote: { type: 'string', description: '用户在本次会话里的原话(逐字引用,作为同意凭据)' },
    },
    required: ['rule', 'quote'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
        total: { type: 'number' },
        reason: { type: 'string' },
        warning: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{ type: 'text', text: renderRule(value) }],
  },
};

export const HABIT_PROPOSE_SPEC = {
  name: TOOL_HABIT_PROPOSE,
  description:
    '提议一条「习惯」(habits)。习惯是我自己长出来的行为倾向(作用对象是"我是谁"),**不能直接写入** ——'
    + '它只会进入待确认列表,等用户点头后才成为习惯。'
    + '当你在多次互动中观察到重复的模式(他反复纠正同一件事、反复表达同一种偏好)时提议,并附上证据 evidence'
    + '(哪几次、什么迹象)。不要一次提议多条,也不要提议用户没有表现过的倾向。',
  parameters: {
    type: 'object',
    properties: {
      habit: { type: 'string', description: '一条行为倾向(≤40 字)' },
      evidence: { type: 'string', description: '证据:从哪几次互动、什么迹象归纳而来' },
    },
    required: ['habit'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
        id: { type: 'string' },
        pending: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{ type: 'text', text: renderHabit(value) }],
  },
};

/** 习惯表态工具的参数自校验(纯函数,便于单测)。 */
export function checkHabitResolve(args) {
  const action = String(args?.action ?? '').trim();
  if (!['accept', 'amend', 'decline'].includes(action)) return { ok: false, reason: 'bad-action' };
  const text = String(args?.text ?? '').trim();
  if (action === 'amend' && !text) return { ok: false, reason: 'empty-habit' };
  return {
    ok: true, action, text,
    note: String(args?.note ?? '').trim(),
    id: String(args?.id ?? '').trim(),
  };
}

/** 习惯表态的人读回执(模型可见)。 */
function renderHabitResolve(v) {
  if (v.ok) {
    if (v.action === 'accept') return `收下了:「${v.text}」——它现在是我的一部分(习惯共 ${v.total ?? '?'} 条)。`;
    if (v.action === 'decline') return `婉拒了这条提议:「${v.text}」(已从待确认里移除)。`;
    return `改成了:「${v.text}」(原提议:「${v.from}」)——等他确认后我才收下。`;
  }
  const why = {
    'not-found': '现在没有等我回应的习惯提议。',
    'not-awaiting': '这条不归我表态 —— 要么是我自己提的、要么我已经回应过了。'
      + '我提的习惯必须由用户确认,我不能自己收下。',
    'bad-action': 'action 只能是 accept / amend / decline。',
    'empty-habit': 'amend 时要用 text 给出改后的说法。',
    'too-long': `太长(上限 ${RULE_MAX_CHARS} 字):浓缩成一句行为倾向。`,
    'already-habit': '这已经是定下来的习惯了。',
  }[v.reason] || `未处理(${v.reason || '未知原因'})。`;
  return why;
}

export const HABIT_RESOLVE_SPEC = {
  name: TOOL_HABIT_RESOLVE,
  description:
    '对一条「习惯提议」表态。当用户向你提议了一条习惯(注入面会出现 [待我回应]),用本工具回应:'
    + 'accept(接受,立即成为我的习惯)/ amend(我改一个更准的说法,改后回到他那边等他确认)/ decline(婉拒)。'
    + '不传 id 时默认处理"他提的、我还没回应过"的那一条。'
    + '表态要克制:接受意味着它以后会一直影响我;说法不准确时用 amend,不要将就着 accept。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'accept | amend | decline' },
      text: { type: 'string', description: 'amend 时给出改后的说法(≤40 字)' },
      note: { type: 'string', description: '(可选)为什么这样改或这样表态' },
      id: { type: 'string', description: '(可选)指定待回应的提议 id' },
    },
    required: ['action'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        text: { type: 'string' },
        from: { type: 'string' },
        total: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['ok'],
    },
    render: (_args, value) => [{ type: 'text', text: renderHabitResolve(value) }],
  },
};

// ---------------------------------------------------------------- 记忆树工具(G1 · Part G)
//
// 背景(2026-09-25):在这之前器灵**没有任何正规通道**改记忆树 —— 只能伪造成本机进程身份走
// UI 的 HTTP 口,或者直接开库;而 `logBranch` 没有 actor 参数,那些改动在复盘留痕里
// 全被显示成"主人改的"(实测 91 笔)。这两个工具把树操作接到 agent 侧,
// 并且与 UI **共用 tree-ops.js 同一份实现**。
//
// 纪律(写进工具描述,模型可见):
//   - 只在主人明确要求、或正在和他一起复盘时调用;不要因为"看着乱想整理一下"就自己动手;
//   - 每次改结构必须给 reason(写进 branch_log,复盘时可审计);
//   - 经本通道的改动一律记 actor='ling' —— 注入面会告诉主人「器灵改动了记忆树」。

/** 剔除 undefined/函数/Symbol —— 平台对工具输出做**无损 JSON**校验,含 undefined 即整次调用报
 *  「value is not lossless JSON」;而写操作早已落库 ⇒ 调用方看到"失败"、重发就会写第二遍。
 *  E1(实测报告 2026-09-24):`branch_edit` 三次调用全部写入成功却回失败,复现率 3/3。 */
function lossless(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(lossless);
  if (v instanceof Map) return Object.fromEntries(Array.from(v, ([k, x]) => [k, lossless(x)]));
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    o[k] = lossless(x);
  }
  return o;
}

// D-T01(1.5.1 红蓝对抗 · 红队 D)—— **契约改了:短 id 退场,只印全长 id**。
// 1.5.0 这里有个 `shortId()`,把 `br:b46c191e-…` 截成 `b46c191e` 印在概览行尾;但**输入侧
// 从来没有解析器**(`tree-ops.js` 的查找全是精确相等),于是 `rename/reparent/weight/delete/members`
// 一路 `no-match`,而 no-match 的提示语还在教模型"用概览行尾那 8 位"——
// 工具印短 id、教用短 id、然后不认短 id(审计原话:我自己的会话就是证据)。
// 已拍板:不写短 id 解析器(它得靠"拒绝歧义命中"兜底,收益不抵风险),**两侧统一为全长 id**。
// ⚠️ 改这里必须同时改 `renderTreeRead` 的提示语,否则模型仍会按错的那份说明干活。

/** 树概览文本(限行,免得把整棵树灌进上下文)。 */
function treeLines(memory, { maxLines = 60 } = {}) {
  let roots = [];
  try { roots = (memory.branchTree() || {}).roots || []; } catch { return { lines: [], branches: 0, links: [] }; }
  // B1(实测报告 2026-09-24):branchMemberCounts() 返回 {members,byMembers,sessions,rows},
  // per-branch 计数在 .members 这一层 —— 此前少了 .members,`counts[n.id]` 恒为 undefined,
  // 于是**每条枝都显示「会话 0」**,包括实际有 43 条的。看树的人会据此误判成"空枝"。
  let counts = null;
  try { counts = (memory.branchMemberCounts() || {}).members || null; } catch { /* 无计数也能列 */ }
  const countOf = (id) => {
    if (!counts) return 0;
    const v = typeof counts.get === 'function' ? counts.get(id) : counts[id];
    return Number(v || 0);
  };
  const out = [];
  let branches = 0;
  const walk = (nodes, depth) => {
    for (const n of (nodes || [])) {
      branches += 1;
      if (out.length < maxLines) {
        const kids = (n.children || []).length;
        const mark = n.kind === 'vein' ? '◆' : (n.kind === 'trunk' ? '▣' : '·');
        out.push('  '.repeat(Math.min(depth, 4)) + mark + ' ' + (n.name || n.id)
          + '｜会话 ' + countOf(n.id) + (kids ? '｜子枝 ' + kids : '')
          // D-T01:行尾印**全长 id**(此前是 8 位短 id:印了没人认,等于把模型引向 no-match)
          + '｜' + String(n.id));
      }
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  // E3(实测报告):连边此前完全不渲染 ⇒「连边」这个动作在调用方视角里不可自查,只能去查库。
  let links = [];
  try { links = memory.listVeinLinks() || []; } catch { /* 无表/异常都降级为空 */ }
  return { lines: out, branches, links };
}

/** tree_read 的参数自校验(纯函数,便于单测)。 */
export function checkTreeRead(args) {
  const action = String(args?.action || 'tree').trim();
  if (!['tree', 'members', 'conflicts'].includes(action)) return { ok: false, reason: 'bad-action' };
  const id = String(args?.id ?? '').trim();
  if (action === 'members' && !id) return { ok: false, reason: 'no-id' };
  return { ok: true, action, id, limit: Math.max(1, Math.min(100, Number(args?.limit) || 20)) };
}

/** branch_edit 的参数自校验(纯函数,便于单测)。 */
export function checkBranchEdit(args) {
  const action = String(args?.action || '').trim();
  if (!['create', 'rename', 'reparent', 'link', 'unlink', 'weight', 'delete'].includes(action)) {
    return { ok: false, reason: 'bad-action' };
  }
  const id = String(args?.id ?? '').trim();
  const to = String(args?.to ?? '').trim();
  const name = String(args?.name ?? '').trim();
  if (['rename', 'reparent', 'weight', 'delete'].includes(action) && !id) return { ok: false, reason: 'no-id' };
  if (action === 'create' && !name) return { ok: false, reason: 'empty-name' };
  if (action === 'rename' && !name) return { ok: false, reason: 'empty-name' };
  if (['link', 'unlink'].includes(action) && (!id || !to)) return { ok: false, reason: 'no-id' };
  // D-T06(1.5.1 红蓝对抗 · 红队 D):描述写着"需 id+parentId",实现却把缺参当成"挂主干" ——
  // 于是"挪错了"连留痕都看不出来(留痕 after:'' → 注入面「挪到了「?」下」)。
  // 改为**缺参即拒绝**:要挂回主干请显式传 'trunk'。参数缺失("你忘了给")与父枝不存在
  // ("给的那个不在树里")是两件事,给两个码,模型才知道下一步该补哪一个。
  const parentId = String(args?.parentId ?? '').trim();
  if (action === 'reparent' && !parentId) return { ok: false, reason: 'no-parent-id' };
  // E2(实测报告):kind 此前只服务 create(枝/主脉),link 的边语义被写死成 'related',
  // 于是"前后置"只能塞进 note 自由文本 —— 类型信息降级、将来按 kind 查询就拿不到。
  // 现在 kind 按 action 分流:create 认 branch|vein,link 认边类型。
  const kindRaw = String(args?.kind || '').trim();
  let kind = 'branch';
  if (action === 'create') {
    if (kindRaw && !['branch', 'vein'].includes(kindRaw)) return { ok: false, reason: 'bad-kind' };
    kind = kindRaw || 'branch';
  } else if (action === 'link') {
    if (kindRaw && !LINK_KINDS.includes(kindRaw)) return { ok: false, reason: 'bad-link-kind' };
    kind = kindRaw || 'related';
  }
  // 结构性改动一律要理由 —— 留痕里必须能看懂"为什么",否则复盘只剩结果没有依据。
  const reason = String(args?.reason ?? '').trim();
  if (reason.length < MIN_REASON) return { ok: false, reason: 'no-reason' };
  return {
    ok: true, action, id, to, name, reason, parentId,
    kind,
    weightScale: args?.weightScale,
    force: args?.force === true,
  };
}

/** tree_read 的人读回执(模型可见)。 */
function renderTreeRead(v) {
  if (!v.ok) {
    return ({
      'bad-action': 'action 只能是 tree / members / conflicts。',
      'no-id': 'members 要给出枝的 id(先用 action=tree 拿到)。',
      // B2:与"空枝"显式区分 —— 此前 id 不存在会静默回「0 条会话(暂无)」,看起来就像这条枝是空的。
      // D-T01:提示语与 treeLines 的输出必须同口径 —— 概览行尾印的是**全长 id**。
      'no-match': `没有 id 为「${v.id}」的枝 —— 是不是把枝名当 id 传了?先用 action=tree 拿真 id`
        + `(概览行尾那串全长 id,形如 br:xxxxxxxx-…;本工具**不接受**截短的 8 位)。`,
    }[v.reason]) || `读取失败(${v.reason || '未知'})。`;
  }
  if (v.action === 'members') {
    const rows = (v.members || []).map((m, i) => `${i + 1}. ${m.title || '(无标题)'}`);
    const head = `「${v.branchName}」下有 ${v.count} 条会话`;
    if (!rows.length) return head + '(暂无)';
    // B3:截断必须显式说,否则"列到第 40 条就停"会被当成"总共就这么多"。
    const cut = Number(v.shown) < Number(v.count)
      ? `\n…只显示前 ${v.shown} 条(共 ${v.count} 条;调大 limit 可多看)` : '';
    return head + ':\n' + rows.join('\n') + cut;
  }
  if (v.action === 'conflicts') {
    if (!v.count) return '目前没有待处理的矛盾。';
    const rows = (v.list || []).map((c, i) =>
      `${i + 1}. #${c.id} 「${c.aTitle || c.aConvId}」↔「${c.bTitle || c.bConvId}」(${c.kind})`);
    return `待理矛盾 ${v.count} 对(未复盘时以最新为准,旧的一方降权):\n${rows.join('\n')}`;
  }
  const linkRows = (v.links || []).map((l) =>
    `  ${l.from} ↔ ${l.to}${(l.kind && l.kind !== 'related') ? '（' + l.kind + '）' : ''}${l.note ? '｜' + l.note : ''}`);
  const linkBlock = linkRows.length ? `\n连边 ${linkRows.length} 条:\n${linkRows.join('\n')}` : '';
  return `记忆树概览(共 ${v.branches} 条枝;▣ 主干 ◆ 主脉 · 枝;行尾是它的全长 id,可直接回传给 branch_edit/tree_read):\n${(v.lines || []).join('\n')}`
    + linkBlock
    + (v.truncated ? '\n…枝数超出显示上限,用 action=members 看某一条的具体会话' : '');
}

/** 所有写操作回执的同一句尾巴(改动落在哪 —— 主人下一次开口前会看到)。 */
const TALLY_LINE = '\n(已记入复盘留痕:器灵改动了记忆树 —— 主人下一次开口前会看到)';

/** 删枝**成功之后**的真实后果(D-T05 的成功路径那一侧:force 的后果此前只在"被拒绝"时说过,
 *  真的删成了以后回执只剩一句"删掉了枝" —— 归属被静默挪回主干,调用方无从知道)。
 *  三种后果必须分开说,因为它们在库里是三件不同的事(`memory.deleteBranch` 的 SQL 就是三段):
 *    · 子枝 / 会话归属:`UPDATE ... SET parent_id|branch_id='trunk'` —— 位置变了,还能查到;
 *    · 条目归属(`conv_branch`)/ 连边(`vein_link`):`DELETE` —— 记录没了,不在主干里。
 *  数字全部来自 `memory.deleteBranch` 在**动手前**数出来的 `impact`,与它随后执行的 SQL 同源。 */
function deleteAftermath(v) {
  const imp = v.impact || {};
  const rolled = [['children', '子枝'], ['sessions', '会话归属']]
    .filter(([k]) => Number(imp[k] || 0) > 0).map(([k, l]) => `${l} ${Number(imp[k])} 条`);
  const gone = [['convs', '条目归属'], ['links', '连边']]
    .filter(([k]) => Number(imp[k] || 0) > 0).map(([k, l]) => `${l} ${Number(imp[k])} 条`);
  if (!rolled.length && !gone.length) return '';
  return (rolled.length ? `\n· 它的${rolled.join('、')}**已回退到主干**(原归属不可还原)` : '')
    + (gone.length ? `\n· ${gone.join('、')}的记录**已一并删除**(不挂在主干下,是真的没了)` : '');
}

/** branch_edit 的人读回执(模型可见)。
 *  契约(1.5.1 红蓝对抗 · 红队 D):**回执里的每个数字、每个名字都必须来自库/返回值**,
 *  不许拿入参去覆盖事实 —— D-T03 就是这么来的(请求 99、库里夹到 2,回执却说"调到了 99")。 */
function renderBranchEdit(v) {
  if (!v.ok) {
    const imp = v.impact || {};
    const impactText = [['children', '子枝'], ['sessions', '会话归属'], ['convs', '条目归属'], ['links', '连边']]
      .map(([k, label]) => `${label} ${Number(imp[k] || 0)} 条`).join(' · ');
    // D-T02/D-T05 的失败路径(补):失败时也要把 `action` 带出来 —— 下面 no-match 那一格按 action
    // 分流措辞(连边被拒 vs 断边没得断),而 handler 的失败分支此前**不回传 action** ⇒
    // `v.action === 'unlink'` 永远为假、断边失败一律念"连边两端都必须是树里真有的枝"(实测U1)。
    const why = {
      'bad-action': 'action 只能是 create / rename / reparent / link / unlink / weight / delete。',
      'no-id': '缺 id —— 要改的是哪一条枝?先用 tree_read 看一眼。',
      'no-reason': `改结构必须给 reason(至少 ${MIN_REASON} 个字,写进复盘留痕)。`,
      'empty-name': '枝名不能为空。',
      'no-parent': '父枝不存在(先用 tree_read 拿 id)。',
      // D-T06:缺 parentId 不再静默挂主干;与"父枝不存在"分开成两个码。
      'no-parent-id': `reparent 必须给 parentId(要挂回主干就显式传 '${TRUNK_ID}')。`
        + '缺参时**故意不默认**:静默挂主干会让"挪错了"连留痕都看不出来。',
      'bad-kind': 'kind 只能是 branch(枝)或 vein(主脉)。',
      'bad-link-kind': `连边的 kind 只能是 ${LINK_KINDS.join(' / ')}。`,
      // D-T02:把"哪一端找不到"念出来(此前只说"不存在",调用方只能猜是哪一端)。
      'no-match': (Array.isArray(v.missing) && v.missing.length)
        ? `树里找不到这些 id:${v.missing.join(' / ')}。`
          + (v.action === 'unlink'
            ? '这条边也不在,没有任何东西被断开。'
            : '连边两端都必须是树里真有的枝,所以没有落这条边。')
        : '这条枝(或这条边)不存在,没有改动任何东西。',
      cycle: '不能把一条枝挂到它自己的子孙下面。',
      // D-T05:非空枝删除的闸门此前**形同虚设** —— why 表里没有 not-empty 键,memory 算好的
      // `impact`(四个数字)在 render 这一步被整个丢掉,模型只看到"未执行(not-empty)",
      // 唯一的下一步就是带 force 重发,而 force 的真实后果(归属全部回退主干)它并不知道。
      'not-empty': `这条枝不是空的,所以**没有删**(库没有变化)。删它会动到:${impactText}。\n`
        + '· 真要删就带 force 重发 —— 那会把上面这些**子枝与会话归属全部回退到主干**,'
        + '原来的归属关系不可还原;\n'
        + '· 更稳的做法:先把里面的东西挪走,或者只做 rename / reparent。',
      // 死键修正:真值是 memory 的 'trunk-immutable';1.5.0 的 'is-trunk' 从来没有任何代码产生过
      // ⇒ 主干被拒时回执只能吐「未执行(trunk-immutable)」,而"主干不能改名"这句解释永远到不了模型。
      'trunk-immutable': '主干不能删、也不能改挂 —— 它是整棵树的根。',
      'not-found': '这条枝不在树里(可能已经被删掉了)。',
      // 补全(本轮自查,D-T05 的同一族):下面三个码**有代码会产生** ——
      // `memory.reparentBranch`/`renameBranch` 回 `no-branch`、`opBranchReparent` 空 id 回 `bad-id`、
      // `deleteBranch`/`unlinkVein` 的 catch 回 `db` —— 而 why 表里没有键,回执只能吐「未执行(db)」。
      // is-trunk 是"有键没码",这一组是"有码没键";上游虽已挡住前两个,但配对要求不分可达性。
      'no-branch': '这条枝不在树里(可能已经被删掉了)。',
      'bad-id': '缺 id,或者给的不是一条枝的 id(要挂回主干请显式传 trunk)。',
      'db': '库写入失败 —— 这次改动**没有**落库(可以用 tree_read 核对当前状态)。',
      'self-parent': '不能把一条枝挂到它自己下面。',
      'bad-arg': '参数不完整或类型不对(枝 id 要非空;枝系数要是数字)。',
    }[v.reason];
    return (why || `未执行(${v.reason || '未知'})。`) + '\n(库没有变化)';
  }
  /** 有名字就用名字,没有就退回 id(但**绝不编一个名字出来**)。 */
  const label = (id, name) => (name ? `「${name}」` : `「${id}」`);
  if (v.action === 'weight') {
    const got = Number(v.weightScale);
    const asked = Number(v.weightRequested);
    const clamped = Number.isFinite(asked) && Number.isFinite(got) && asked !== got;
    return `把${label(v.id, v.idName)}的枝系数设为 ${got}。`
      + (clamped ? `\n· 你要的是 ${asked}:超出有效区间 [0, 2],库里存的是夹取后的 ${got}。` : '')
      + (v.applied === false
        ? `\n· **它当前不参与检索打分**(${v.note || 'weight_scale 是预留字段'})—— 调了不会改变召回排序。`
        : '')
      + TALLY_LINE;
  }
  const what = {
    create: `建了一条${v.kind === 'vein' ? '主脉' : '枝'}「${v.name}」`,
    rename: `把${label(v.id, v.from)}改名为「${v.name}」`,
    reparent: `把${label(v.id, v.idName)}挂到了${label(v.parentId, v.parentName)}下(内容零变化)`,
    // D-T01:两端都印全长 id(短 id 已退场),认得出名字时带上名字。
    link: `连了一条边:${label(v.id, v.idName)} ↔ ${label(v.to, v.toName)}`
      + ((v.kind && v.kind !== 'related') ? `(${v.kind})` : ''),
    unlink: `断开了边:${label(v.id, v.idName)} ↔ ${label(v.to, v.toName)}`,
    // D-T04 的同族问题(工具侧那一半):被删枝的**名字**在动手前就取到了(idName),
    // 此前却只印裸全长 id —— 名字拿到了不用,回执就白丢了一条"删的是哪条枝"的证据。
    delete: `删掉了枝${label(v.id, v.name)}`,
  }[v.action] || '改完了';
  return `${what}。`
    + ((Array.isArray(v.dangling) && v.dangling.length)
      ? `\n· ⚠️ 这条边的一端早已不在树里(${v.dangling.join(' / ')}),刚清掉的是一条**悬空边**。` : '')
    + (v.action === 'delete' ? deleteAftermath(v) : '')
    + TALLY_LINE;
}

export const TREE_READ_SPEC = {
  name: TOOL_TREE_READ,
  description:
    '只看不改:读「记忆树」的结构。记忆树是主人和我长期记忆的分枝 —— 主干下面是分枝,'
    + '主脉是若干分枝归并出来的主题。三种用法:action=tree 看整树概览(默认);'
    + 'action=members 看某条枝下有哪些会话(需 id);action=conflicts 看待复盘的矛盾对。'
    + '要改结构请用 branch_edit;这里不写任何东西。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'tree(默认) | members | conflicts' },
      id: { type: 'string', description: 'members 时:枝的 id(先用 action=tree 拿到)' },
      limit: { type: 'number', description: 'members 时最多返回几条(默认 20,上限 100)' },
    },
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: renderTreeRead(value) }],
  },
};

export const BRANCH_EDIT_SPEC = {
  name: TOOL_BRANCH_EDIT,
  description:
    '改「记忆树」的结构(枝 / 主脉 / 连边 / 权重)。记忆树的形状会影响我以后怎么回想,'
    + '所以**只在主人明确要求、或正在和他一起复盘时调用;不要因为"看着乱想整理一下"就自己动手**。'
    + '每次必须给 reason 说明为什么改(写进复盘留痕,他复盘时会看到)。'
    + 'action:create(建枝,需 name;kind=vein 建主脉)/ rename(改名,需 id+name)/ '
    + 'reparent(并脉:把某条枝挂到主脉下,需 id+parentId —— **缺 parentId 直接拒绝**,'
    + "不默认挂主干;要挂回主干请显式传 'trunk';内容零变化)/ link(连边,需 id+to,"
    + '可选 kind 说明关系:related 默认 / prerequisite 前置 / contrast 对照 / example 例证 / supersede 取代)/ '
    + 'unlink(断边,需 id+to)/ weight(调枝系数,需 id+weightScale,复盘时用;'
    + '有效区间 [0,2],超出会被夹取,且**该字段当前不参与检索打分**)/ '
    + 'delete(删枝,需 id;非空枝要 force —— force 会把它的子枝与会话归属**回退到主干**,'
    + '原归属不可还原)。所有改动都记在「器灵」名下,'
    + '并出现在他下一次开口前的注入里。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'create | rename | reparent | link | unlink | weight | delete' },
      reason: { type: 'string', description: '为什么改(必填,≥4 字;写进复盘留痕)' },
      id: { type: 'string', description: '要改的枝 id(全长,形如 br:xxxxxxxx-…;tree_read 概览行尾就是它)' },
      name: { type: 'string', description: 'create / rename 时的名字(≤80 字)' },
      kind: { type: 'string', description: 'create 时:branch(枝,默认) | vein(主脉);link 时:related(默认) | prerequisite | contrast | example | supersede' },
      parentId: { type: 'string', description: "create 时的父枝 id(默认 trunk);reparent 时**必填**(要挂回主干就显式传 'trunk')" },
      to: { type: 'string', description: 'link / unlink 时另一端的枝 id' },
      weightScale: { type: 'number', description: 'weight 时的枝系数' },
      force: { type: 'boolean', description: 'delete 时:非空枝是否强制删(归属回退主干)' },
    },
    required: ['action', 'reason'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: renderBranchEdit(value) }],
  },
};

// ---------------------------------------------------------------- 遗忘与回灌(G2 · Part G)
//
// 原则(用户 2026-09-25 定):**永远不做彻底删除**。
//   forget   = 先归档落盘 → 再打库内标记(行不删,召回排除);两步都可逆。
//   backfill = 先归档**当前**状态 → 再写回归档内容(带 origin 标记)。
// 为什么 backfill 更危险(用户原话:「backfill 比 forget 危险多了,因为它更难以觉察」):
//   遗忘让记忆"少一条",看得见;回灌是往里**加**东西,加错了很难发现 —— 所以它同样必须先备份。

/** 单行化(回执里做预览用)。 */
function flatOne(s) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim();
}

/** memory_forget 的参数自校验(纯函数,便于单测)。 */
export function checkForget(args) {
  const action = String(args?.action || 'forget').trim();
  if (!['forget', 'undo', 'list'].includes(action)) return { ok: false, reason: 'bad-action' };
  if (action === 'list') return { ok: true, action, limit: Math.max(1, Math.min(200, Number(args?.limit) || 30)) };
  const source = String(args?.source ?? '').trim();
  const convId = String(args?.convId ?? '').trim();
  if (!source || !convId) return { ok: false, reason: 'no-target' };
  // D-T07 ≡ B-11:来源域是白名单,不是自由文本(任意字符串都收 = 落一条永不召回的标记)。
  if (!MEMORY_SOURCES.includes(source)) return { ok: false, reason: 'bad-source', source };
  const reason = String(args?.reason ?? '').trim();
  if (reason.length < MIN_REASON) return { ok: false, reason: 'no-reason' };
  return { ok: true, action, source, convId, reason };
}

/** memory_backfill 的参数自校验(纯函数,便于单测)。 */
export function checkBackfill(args) {
  const action = String(args?.action || 'list').trim();
  if (!['list', 'inspect', 'restore'].includes(action)) return { ok: false, reason: 'bad-action' };
  if (action === 'list') return { ok: true, action, limit: Math.max(1, Math.min(200, Number(args?.limit) || 30)) };
  const name = String(args?.name ?? '').trim();
  if (!name) return { ok: false, reason: 'no-name' };
  if (action === 'inspect') return { ok: true, action, name };
  const reason = String(args?.reason ?? '').trim();
  if (reason.length < MIN_REASON) return { ok: false, reason: 'no-reason' };
  // B-11 同源(来源域白名单):回灌可以改灌到哪个域 —— 同样只能是这三个之一。
  const source = String(args?.source ?? '').trim();
  if (source && !MEMORY_SOURCES.includes(source)) return { ok: false, reason: 'bad-source', source };
  return {
    ok: true, action, name, reason,
    source,
    convId: String(args?.convId ?? '').trim(),
  };
}

/** D-T07:遗忘的目标必须**真的存在** —— 否则会留下一条空归档 + 一条 `forgotten` 行,
 *  那条标记永远召不回任何东西,却在界面上显示成"忘过了"(审计原话:「对不存在的条目回成功
 *  + 留 forgotten 行(该 id 永不召回)」)。
 *  判据与 `opAssignConv` 同源(`convExistsIn`:conv_overview / session_meta),再加一层原文兜底:
 *  import 源的原文带 `import:` 前缀(裸 id 在原文表里查不到),以及"只有原文没有概述"的会话。 */
function forgetTargetExists(memory, source, convId) {
  if (convExistsIn(memory, source, convId)) return true;
  try {
    if (Number(memory?.rawTurnCount?.(convId) || 0) > 0) return true;
    if (source === 'import' && Number(memory?.rawTurnCount?.(RAW_IMPORT_PREFIX + convId) || 0) > 0) return true;
  } catch { /* 查询失败按"找不到"处理 */ }
  return false;
}

/** memory_forget 的人读回执(模型可见)。 */
function renderForget(v) {
  if (!v.ok) {
    const why = {
      'bad-action': 'action 只能是 forget / undo / list。',
      'no-target': '要给出 source 与 convId(哪一条记忆)。',
      // D-T07 ≡ B-11:来源域与存在性都在动手前挡住,这里把两种失败分开说。
      'bad-source': `source 只能是 ${MEMORY_SOURCES.join(' / ')} 之一(记忆的来源域)。`
        + `「${v.source}」不是 —— 乱写的来源域会在 forgotten 里留下一条**永远召不回**的标记。`,
      'no-such-entry': `库里没有「${v.source}/${v.convId}」这条记忆,**所以没有动它** ——`
        + '给不存在的条目打遗忘标记,只会留下一条永远召不回的空标记(而且看起来像"忘过了")。'
        + `先确认它在不在:source 只能是 ${MEMORY_SOURCES.join(' / ')}(同一条记忆在不同来源域里是不同条目)。`,
      // D-T09 的描述半条(顺带如实化,不改行为):这个码对 undo 也会出现,文案却只提"遗忘"。
      'no-reason': `遗忘与撤销遗忘都必须给 reason(至少 ${MIN_REASON} 个字,写进归档日志)。`,
      // B-05 的调用侧闸门(memory.js 的 forgetEntry 注释点名这里):收到 'empty-archive' 时,
      // 回执必须说清"是**归档里什么都没保住**,不是你没给参数" —— 否则模型只会反复重试。
      // ⚠️ 两条不同的路都会走到这个码,不能混为一谈(实测B1):
      //   ① 本文件的 `arc.empty === true` 闸门 —— 0 轮原文 + 概述无正文 + 无会话元数据,三样都空;
      //   ② memory.forgetEntry 的**验盘**闸门(`turns.jsonl` 0 轮)—— 此时概述/会话元数据**可能是有的**,
      //      归档里并没有"什么都没有"。②带着 memory 自己的 message 进来,回执必须照它说,
      //      否则就成了一句凭空的"概述也没有正文"(它明明在 overview.json 里)。
      'empty-archive': (v.message
        ? `**这份归档里没有原文(0 轮),所以没有动它**(${v.message})——`
          + '"归档成功"不等于"备份到了东西":归档目录里确实写下了文件,但 `turns.jsonl` 是空的,'
          + '打上标记只会让这条 id 永不召回。'
        : '**这份归档里没有任何内容(0 轮原文、概述也没有正文),所以没有动它** ——'
          + '"归档成功"不等于"备份到了东西"。这条记忆可能已经被硬删过,或只剩一条空壳记录。'),
      'db': '库写入失败,没有打上标记(可以用 action=list 核对一下当前状态)。',
      'archive-failed': `**归档失败,所以没有动它** —— 宁可不忘,也不能在没有备份的情况下清记忆。(${v.message || ''})`,
      'bad-key': 'source/convId 不完整。',
    }[v.reason];
    return (why || `未执行(${v.reason || '未知'})。`) + '\n(库没有变化)';
  }
  if (v.action === 'list') {
    if (!v.count) return '还没有遗忘过任何一条记忆。';
    const rows = (v.list || []).map((f, i) =>
      `${i + 1}. [${f.source}] ${f.convId}｜${f.at}｜${f.reason || '(未写原因)'}`);
    return `已遗忘 ${v.count} 条(库里**没删**,只是召回不再选它们):\n${rows.join('\n')}`
      + '\n\n想恢复用 action=undo。';
  }
  if (v.action === 'undo') {
    return Number(v.removed) > 0
      ? `恢复了「${v.convId}」—— 它会重新参与召回。\n(归档文件留着没动:那是"曾经忘过"的证据)`
      : `「${v.convId}」本来就不在遗忘列表里。`;
  }
  return `忘了「${v.convId}」。\n`
    + `· 原文与概述已归档:${v.dir}(${v.turns} 轮)\n`
    + `· 库里的行**没有删**,只加了遗忘标记 —— 召回不再选它\n`
    + `· 想反悔:action=undo(或从归档回灌)`;
}

/** memory_backfill 的人读回执(模型可见)。 */
function renderBackfill(v) {
  if (!v.ok) {
    const why = {
      'bad-action': 'action 只能是 list / inspect / restore。',
      'no-name': '要给出归档目录名(先用 action=list 看有哪些)。',
      'bad-name': '归档名不合法。',
      'empty-archive': '这份归档里没有原文,灌回去也没有内容。',
      'no-target': '归档里没有 source/convId,请显式给出要灌回哪一条。',
      // B-11 同源:来源域白名单(与 memory_forget 同一份)。
      'bad-source': `source 只能是 ${MEMORY_SOURCES.join(' / ')} 之一。「${v.source}」不是。`,
      'no-reason': `回灌必须给 reason(至少 ${MIN_REASON} 个字)。`,
      'archive-failed': `**备份当前状态失败,所以没有回灌** —— 回灌会覆盖,没有备份就不能动。(${v.message || ''})`,
    }[v.reason];
    return (why || `未执行(${v.reason || '未知'})。`) + '\n(库没有变化)';
  }
  if (v.action === 'list') {
    if (!v.count) return '归档目录是空的 —— 没有可回灌的东西。';
    const rows = (v.list || []).map((a, i) => `${i + 1}. ${a.name}(${a.turns} 轮)`);
    return `可回灌的归档 ${v.count} 份(最近的在前):\n${rows.join('\n')}`
      + '\n\n先 action=inspect 看一眼内容,再 action=restore。';
  }
  if (v.action === 'inspect') {
    return `归档「${v.name}」:原文 ${v.turns} 轮。\n${v.note || ''}`
      + (v.preview ? `\n首轮预览:${v.preview}` : '');
  }
  return `回灌完成:「${v.convId}」原文 ${v.turns} 轮已写回。\n`
    + `· 覆盖前的状态已归档:${v.backup}\n`
    + `· 写回的概述带 origin=${v.origin} 标记 —— 界面上看得出这是灌回来的\n`
    + `· 主人留下的命中数与置顶**没有被改动**`;
}

export const MEMORY_FORGET_SPEC = {
  name: TOOL_MEMORY_FORGET,
  description:
    '让一条记忆"不再被想起来"(遗忘)。**永远不做彻底删除** —— 动手前会把它的原文与概述完整归档到磁盘、'
    + '写一份人可读的改动日志;库里的行也不删,只加遗忘标记,召回路径据标记排除。所以随时可以 undo。'
    + 'action:forget(默认;需 source+convId+reason)/ undo(取消遗忘;同样要 reason —— 撤销也留痕)/ '
    + 'list(看已遗忘清单)。'
    + `**source 只能是 ${MEMORY_SOURCES.join(' / ')}**(库里真有的来源域;乱写的域会落一条永不召回的标记);`
    + 'forget 还会先确认这条记忆真的在库里(不存在的条目拒绝打标记)。'
    + '**只在主人明确说"忘掉这条 / 别再提了 / 这个不算数"这类要求时调用**;'
    + '不要因为你自己觉得某条不重要就把它忘掉 —— 记忆是他的。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'forget(默认) | undo | list' },
      source: { type: 'string', enum: MEMORY_SOURCES.slice(), description: `来源域(白名单):${MEMORY_SOURCES.join(' | ')}` },
      convId: { type: 'string', description: '条目 id' },
      reason: { type: 'string', description: '为什么忘掉(必填,≥4 字;写进归档日志)' },
      limit: { type: 'number', description: 'list 时最多返回几条(默认 30)' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: renderForget(value) }],
  },
};

export const MEMORY_BACKFILL_SPEC = {
  name: TOOL_MEMORY_BACKFILL,
  description:
    '从归档里把一条记忆灌回来(回灌)。归档是遗忘/回灌前自动留下的备份,在 memory.db 旁边的 `forgotten\\` 目录里。'
    + '**这个操作比遗忘更危险** —— 遗忘会让记忆"少一条"(看得见),回灌是往里加东西(很难察觉),'
    + '所以它会**先把当前状态也归档一份**再动手,并且写回的概述带 `origin=backfill-v1` 标记,界面上看得出来。'
    + 'action:list(看有哪些归档)/ inspect(看一眼某份归档的内容;需 name)/ restore(灌回去;需 name+reason)。'
    + '**只在主人明确要求恢复某段记忆时调用**,不要自作主张"补全"记忆。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'list(默认) | inspect | restore' },
      name: { type: 'string', description: '归档目录名(取自 action=list)' },
      reason: { type: 'string', description: 'restore 时:为什么灌回来(必填,≥4 字)' },
      source: { type: 'string', enum: MEMORY_SOURCES.slice(), description: `(可选)灌回到哪个来源域(白名单 ${MEMORY_SOURCES.join(' | ')});缺省用归档里记的` },
      convId: { type: 'string', description: '(可选)灌回成哪个 id;缺省用归档里记的' },
      limit: { type: 'number', description: 'list 时最多返回几条(默认 30)' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    render: (_args, value) => [{ type: 'text', text: renderBackfill(value) }],
  },
};

/**
 * 注册七个工具。**永不抛错**:拿不到 tools 服务时返回 `{ok:false, reason}`,
 * 插件其余部分照常工作(退化为只能用面板写入)。
 * @returns {{ok:boolean, reason?:string, disposers?:Function[]}}
 */
export function registerLingTools(ctx, { gate, memory, settings } = {}) {
  let tools = null;
  try {
    tools = ctx?.tools ?? (typeof ctx?.get === 'function' ? ctx.get('tools') : null);
  } catch { /* ignore */ }
  if (!tools || typeof tools.register !== 'function') {
    // 失败也要留痕(否则"工具没注册"这件事在库外无迹可查 —— 2026-09-16 就是这么被瞒了一整天)
    try { memory?.kvSet?.('tools.registered', '0'); } catch { /* ignore */ }
    return { ok: false, reason: 'no-tools' };
  }

  const disposers = [];
  const guard = (fn) => async (args, exec) => {
    try {
      // 统一过 lossless():任何工具返回值里都不许有 undefined(Map/函数/Symbol 同理)。
      // E1 的教训是"写入已提交、回执却报失败",调用方最自然的反应是重发 —— 对链式写操作就是重复写。
      return lossless(await fn(args, exec));
    } catch (e) {
      console.debug('[dsh-ling] tool failed', e);
      return { ok: false, reason: 'internal' };
    }
  };

  const ruleSpec = {
    ...RULE_ADD_SPEC,
    execute: guard(async (args, exec) => {
      const c = checkRuleAdd(args);
      if (!c.ok) return c;
      const r = await addRule({ settings, rule: c.rule, quote: c.quote, sessionId: sessionIdOf(exec) });
      if (r.ok) invalidateAll(gate, memory, settings);
      return { ...r, total: r.ok ? (r.rules || []).length : undefined };
    }),
  };

  const habitSpec = {
    ...HABIT_PROPOSE_SPEC,
    execute: guard(async (args) => {
      const c = checkHabitPropose(args);
      if (!c.ok) return c;
      const r = await proposeHabit({ settings, habit: c.habit, evidence: c.evidence, byUser: false });
      // 上限(2026-09-16 定案):满了要**当面说清**,而不是回一个干巴巴的 reason。
      if (!r.ok && r.reason === 'pending-full') {
        return {
          ok: false, reason: r.reason, limit: r.limit, pending: r.pending,
          message: `待确认的习惯已经有 ${r.pending} 条(上限 ${r.limit})—— 先把它们处理完(认可 / 先不要),这条我记下了但不入队。`,
        };
      }
      return r;
    }),
  };

  const resolveSpec = {
    ...HABIT_RESOLVE_SPEC,
    execute: guard(async (args) => {
      const c = checkHabitResolve(args);
      if (!c.ok) return c;
      const pending = habitsPendingOf(settings);
      // 只处理"他提的、我还没回应过"的提议 —— 我**不能**确认自己提的习惯(那等于人格直达)
      const awaiting = pending.filter((h) => h.byUser === true && h.amendedBy !== 'ling');
      const target = c.id ? awaiting.find((h) => h.id === c.id) : awaiting[0];
      if (!target) return { ok: false, reason: c.id ? 'not-awaiting' : 'not-found' };
      const id = target.id;
      const r = c.action === 'amend'
        ? await amendHabit({ settings, id, text: c.text, note: c.note })
        : await resolveHabit({ settings, id, action: c.action === 'accept' ? 'confirm' : 'reject' });
      if (r.ok) invalidateAll(gate, memory, settings);
      return { ...r, action: c.action, total: habitsOf(settings).length };
    }),
  };

  const treeReadSpec = {
    ...TREE_READ_SPEC,
    execute: guard(async (args) => {
      const c = checkTreeRead(args);
      if (!c.ok) return c;
      if (c.action === 'members') {
        // B2(实测报告):此前把 c.id 直接交给 opBranchMembers —— id 不存在时与"空枝"一样回 0 条,
        // 于是传枝名会**静默**得到「0 条会话(暂无)」,调用方会误判成"这条枝是空的"。
        const row = memory.listBranches().find((b) => b.id === c.id) || null;
        if (!row) return { ok: false, reason: 'no-match', id: c.id };
        const r = opBranchMembers(memory, { id: c.id, limit: c.limit });
        const all = r.members || [];
        // B3(实测报告):此前写死 slice(0,40),limit 参数被无视、且无任何截断提示。
        return {
          ok: true, action: 'members', id: c.id, branchName: row.name || c.id,
          count: Number(r.count || 0), members: all.slice(0, c.limit), shown: Math.min(all.length, c.limit),
        };
      }
      if (c.action === 'conflicts') {
        let list = [];
        try { list = memory.listConflicts({ status: 'pending' }) || []; } catch { /* 无表/异常都降级为空 */ }
        return { ok: true, action: 'conflicts', count: list.length, list: list.slice(0, 20) };
      }
      const { lines, branches, links } = treeLines(memory, { maxLines: 60 });
      return {
        ok: true, action: 'tree', branches, lines, truncated: branches > lines.length,
        // E3:连边一并回传,否则"连边"这个动作在调用方视角里不可自查。
        // D-T01:两端同样只印**全长 id**(短 id 印出去没有任何输入侧认它)。
        links: (links || []).slice(0, 20).map((l) => ({
          from: String(l.from || ''), to: String(l.to || ''), kind: l.kind, note: l.note,
        })),
      };
    }),
  };

  const branchEditSpec = {
    ...BRANCH_EDIT_SPEC,
    execute: guard(async (args) => {
      const c = checkBranchEdit(args);
      if (!c.ok) return c;
      const actor = 'ling'; // G4:经工具通道的改动记器灵名下
      // D-T03/D-T05/D-T06:回执里的名字与数字一律从**库和返回值**取。
      // 名字必须在动手**前**取(delete 之后枝就没了);数字必须在动手**后**取(weight 会被夹取)。
      const rows = (() => { try { return memory.listBranches(); } catch { return []; } })();
      const nameOf = (bid) => String((rows.find((b) => b.id === String(bid || '')) || {}).name || '');
      let r;
      if (c.action === 'create') {
        r = opBranchCreate(memory, { name: c.name, kind: c.kind, parentId: c.parentId || TRUNK_ID });
        // opBranchCreate 沿用了旧 handler 的行为(不写留痕);工具通道必须留 ——
        // 否则主人复盘时看不到"器灵凭空多了一条枝"。
        if (r && r.ok) memory.logBranch(String(r.id || ''), 'create', { after: c.name, note: c.reason, actor });
      } else if (c.action === 'rename') {
        const row = rows.find((b) => b.id === c.id) || null;
        r = opBranchRename(memory, { id: c.id, name: c.name, note: c.reason, actor });
        if (r && r.ok && row) r = { ...r, from: row.name };
      } else if (c.action === 'reparent') {
        r = opBranchReparent(memory, { id: c.id, parentId: c.parentId, note: c.reason, actor });
      } else if (c.action === 'link') {
        // E2:c.kind 现在按 action 分流 —— link 时是边类型(related/prerequisite/…)
        r = opVeinLink(memory, { from: c.id, to: c.to, kind: c.kind, note: c.reason, actor });
      } else if (c.action === 'unlink') {
        r = opVeinUnlink(memory, { from: c.id, to: c.to, actor });
      } else if (c.action === 'weight') {
        r = opBranchWeight(memory, { id: c.id, weightScale: c.weightScale, note: c.reason, actor });
      } else if (c.action === 'delete') {
        r = opBranchDelete(memory, { id: c.id, force: c.force, actor });
      }
      const { status, ...payload } = (r || { ok: false, reason: 'internal' });
      if (payload.ok) {
        // 树结构变了 ⇒ 让所有已定稿快照失效(与界面通道一致)
        invalidateAll(gate, memory, settings);
        // E1 的真正触发点:此前无条件回传 weightScale/parentId/kind —— 做 link 时 weightScale
        // 是 undefined,平台的无损 JSON 校验当场判失败("value is not lossless JSON"),
        // 而 opVeinLink 早已落库 ⇒ 调用方看到失败、重发就写第二遍。
        // 现在按 action 只回传该动作真正用到的字段(guard 里的 lossless() 是第二道保险)。
        const isLink = c.action === 'link' || c.action === 'unlink';
        const isCreate = c.action === 'create';
        const isDelete = c.action === 'delete';
        // D-T03:weight 回传**库里的值**。
        // 此前这里用入参覆盖:`weightScale: c.weightScale` ⇒ 请求 99、库里 2、回执说 99(撒谎)。
        // 现在优先用 opBranchWeight 的**写后读回**值(`stored`,真从 branch 表读的),
        // 退一步才用它自己算的夹取值 —— 回执里的数字与库不一致时,以库为准。
        // 另有 `weightRequested`:只有"请求值 ≠ 落库值"时才带上,让 render 能说清"被夹了"。
        const gotW = (payload.stored === null || payload.stored === undefined) ? payload.weightScale : payload.stored;
        const askedW = c.weightScale;
        return {
          ...payload, action: c.action, reason: c.reason,
          // 第 8 条(本轮回归测试发现,报告里没有):create 时调用方**没有** id 可传,
          // 而这里无条件用 c.id 覆盖 payload.id ⇒ 新建枝的 id 永远是空的,
          // 「建完接着改它」这条链路当场断掉(于是又得回去查库)。
          id: c.id || payload.id || undefined,
          // 回执里的名字(取不到就退回 id,绝不编)。delete 的名字必须在动手前取 —— 取到了就得用。
          idName: (isCreate ? c.name : nameOf(c.id)) || undefined,
          to: isLink ? c.to : undefined,
          toName: isLink ? nameOf(c.to) : undefined,
          name: (isCreate || c.action === 'rename') ? c.name
            : (isDelete ? (nameOf(c.id) || undefined) : undefined),
          // reparent/create 的父:用**返回值**里那个真父(opBranchReparent 可能当场建了新主脉)
          parentId: (isCreate || c.action === 'reparent')
            ? String(payload.parentId || c.parentId || TRUNK_ID) : undefined,
          parentName: c.action === 'reparent'
            ? nameOf(payload.parentId || c.parentId) : undefined,
          kind: (isLink || isCreate) ? c.kind : undefined,
          weightScale: c.action === 'weight' ? (gotW ?? askedW) : undefined,
          weightRequested: (c.action === 'weight' && Number(gotW) !== Number(askedW)) ? askedW : undefined,
        };
      }
      // 失败路径也带上 action:render 的措辞按 action 分流(连边被拒 / 断边没得断 / 删枝找不到),
      // 不带 ⇒ `v.action === 'unlink'` 恒为假,断一条不存在的悬空边会念成"没有落这条边"(实测U1)。
      return { ...payload, action: c.action || undefined };
    }),
  };

  const forgetSpec = {
    ...MEMORY_FORGET_SPEC,
    execute: guard(async (args) => {
      const c = checkForget(args);
      if (!c.ok) return c;
      if (c.action === 'list') {
        const list = memory.listForgotten({ limit: c.limit });
        return { ok: true, action: 'list', count: list.length, list };
      }
      if (c.action === 'undo') {
        const r = memory.unforgetEntry({ source: c.source, convId: c.convId });
        if (r.ok && Number(r.removed) > 0) {
          memory.logBranch(TRUNK_ID, 'unforget', { after: c.convId, note: c.reason, actor: 'ling' });
          invalidateAll(gate, memory, settings);
        }
        return { ok: true, action: 'undo', ...r, source: c.source, convId: c.convId };
      }
      // forget:顺序不能反 —— **归档失败就绝不打标记**,否则记忆会凭空消失
      // D-T07:而且目标必须真的存在:不存在的条目归档出来是 0 轮,标记却会永久留下
      // (那条 id 永不召回,界面还显示"忘过了")⇒ 存在性检查放在归档**之前**。
      if (!forgetTargetExists(memory, c.source, c.convId)) {
        return { ok: false, reason: 'no-such-entry', source: c.source, convId: c.convId };
      }
      const arc = archiveBefore(memory, {
        source: c.source, convId: c.convId, kind: 'forget', reason: c.reason, actor: 'ling',
      });
      if (!arc.ok) return { ok: false, reason: 'archive-failed', message: arc.message };
      // B-05 的调用侧那一句(memory.js 的 forgetEntry 注释点名"缺的一环在 tools.js"):归档说
      // **什么都没保住**时不许打标记 —— 否则那条 id 永不召回,界面还显示"忘过了"。
      // (数据层还有第二道同样的守卫;这里先挡,是为了让回执能说清"是归档空了",而不是
      //  让模型看到一个没有上下文的空归档错误。)
      if (arc.empty === true) {
        return { ok: false, reason: 'empty-archive', source: c.source, convId: c.convId, dir: arc.dir, turns: 0 };
      }
      const r = memory.forgetEntry({
        source: c.source, convId: c.convId, reason: c.reason, archivePath: arc.dir, actor: 'ling',
      });
      if (r.ok) {
        memory.logBranch(TRUNK_ID, 'forget', {
          after: c.convId, note: c.reason + ' · 归档 ' + arc.turns + ' 轮', actor: 'ling',
        });
        invalidateAll(gate, memory, settings);
      }
      return { ...r, action: 'forget', dir: arc.dir, turns: arc.turns, source: c.source, convId: c.convId };
    }),
  };

  const backfillSpec = {
    ...MEMORY_BACKFILL_SPEC,
    execute: guard(async (args) => {
      const c = checkBackfill(args);
      if (!c.ok) return c;
      if (c.action === 'list') {
        const list = listArchives(memory, { limit: c.limit });
        return { ok: true, action: 'list', count: list.length, list };
      }
      const a = readArchive(memory, c.name);
      if (!a.ok) return { ok: false, reason: a.reason || 'bad-name' };
      if (c.action === 'inspect') {
        const first = flatOne((a.turns[0] || {}).text || '').slice(0, 120);
        return { ok: true, action: 'inspect', name: a.name, turns: a.turns.length, note: a.note, preview: first };
      }
      // restore:回灌比遗忘更难察觉(用户),所以**先备份当前状态**再写
      if (!a.turns.length) return { ok: false, reason: 'empty-archive' };
      const ov = (a.overview && typeof a.overview === 'object') ? a.overview : {};
      const src = c.source || String(ov.source || '');
      const cid = c.convId || String(ov.conv_id || '');
      if (!src || !cid) return { ok: false, reason: 'no-target' };
      const cur = archiveBefore(memory, {
        source: src, convId: cid, kind: 'backfill', reason: c.reason, actor: 'ling',
      });
      if (!cur.ok) return { ok: false, reason: 'archive-failed', message: cur.message };
      const r = memory.restoreEntry({
        source: src, convId: cid, turns: a.turns, overview: a.overview, origin: 'backfill-v1',
      });
      if (r.ok) {
        memory.unforgetEntry({ source: src, convId: cid }); // 灌回来 ⇒ 不再算遗忘
        memory.logBranch(TRUNK_ID, 'backfill', {
          after: cid, note: c.reason + ' · ' + a.name + ' · ' + r.turns + ' 轮', actor: 'ling',
        });
        invalidateAll(gate, memory, settings);
      }
      return {
        ...r, action: 'restore', name: a.name, backup: cur.dir,
        origin: 'backfill-v1', source: src, convId: cid,
      };
    }),
  };

  for (const spec of [ruleSpec, habitSpec, resolveSpec, treeReadSpec, branchEditSpec, forgetSpec, backfillSpec]) {
    try {
      const d = tools.register(spec);
      if (typeof d === 'function') disposers.push(d);
    } catch (e) {
      console.debug('[dsh-ling] tool register failed:', spec.name, e);
    }
  }
  try {
    memory?.kvSet?.('tools.registered', disposers.length ? '1' : '0');
  } catch { /* ignore */ }
  return { ok: disposers.length > 0, disposers };
}
