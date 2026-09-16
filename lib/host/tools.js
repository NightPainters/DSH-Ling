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

export const TOOL_RULE_ADD = 'rule_add';
export const TOOL_HABIT_PROPOSE = 'habit_propose';
export const TOOL_HABIT_RESOLVE = 'habit_resolve';

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

/**
 * 注册三个工具。**永不抛错**:拿不到 tools 服务时返回 `{ok:false, reason}`,
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
      return await fn(args, exec);
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
      return proposeHabit({ settings, habit: c.habit, evidence: c.evidence, byUser: false });
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

  for (const spec of [ruleSpec, habitSpec, resolveSpec]) {
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
