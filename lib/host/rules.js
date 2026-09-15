// dsh-ling host — 规矩 / 习惯 域逻辑(2026-09-15 与尝生定稿的二分)
//
// 原则:**指令直达,人格不直达。**
//   - 规矩(rules)= 用户的指令,作用对象是「行为」→ 可直接写入;但**必须带原话**为凭据。
//   - 习惯(habits)= 器灵自己长出来的一部分,作用对象是「我是谁」→ **不能由外部直接写入**,
//     只能经「提议 → 对方确认」落地。任一方都可提议,由另一方确认。
//
// 存储(settings.persona 内):
//   hardRules: string[]                     规矩正文(沿用旧字段名以兼容人格编辑器)
//   ruleMeta:  { [text]: {quote, at, sessionId, source} }   规矩的来源留痕(原话/时间/会话)
//   habits:    [{text, evidence, at, source}]               已定习惯
//   habitsPending: [{id, text, evidence, byUser, at}]       待确认的习惯提议
//
// 本模块为纯域逻辑:只依赖传入的 settings(get/update),不做 IO、不碰 ctx,便于单测。

export const RULES_MAX = 12;      // 超过则提示合并(注入面瘦身的硬约束)
export const HABITS_MAX = 8;
export const RULE_MAX_CHARS = 40;
export const QUOTE_MAX_CHARS = 200;
export const EVIDENCE_MAX_CHARS = 300;

function norm(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 去重键:忽略**空格与中英标点差异**(中文输入法下 ,/，、./。 常混用)。 */
function key(text) {
  return norm(text)
    .replace(/[，。；：！？、（）【】“”‘’《》]/g, '')   // 全角标点整体去掉
    .replace(/[\s,.!?;:()[\]{}"'`~\-—…·]/g, '');        // 半角标点与空白
}

/** 规矩正文列表(过滤空值)。 */
export function rulesOf(settings) {
  const p = settings?.get ? settings.get().persona || {} : settings?.persona || {};
  return (Array.isArray(p.hardRules) ? p.hardRules : []).map(norm).filter(Boolean);
}

/** 规矩来源留痕(数组:对象存储会被 settings 的深合并"只增不删",删除时清不掉)。 */
export function ruleMetaOf(settings) {
  const p = settings?.get ? settings.get().persona || {} : settings?.persona || {};
  return (Array.isArray(p.ruleMeta) ? p.ruleMeta : []).filter((m) => m && typeof m.text === 'string');
}

/** 已定习惯。 */
export function habitsOf(settings) {
  const p = settings?.get ? settings.get().persona || {} : settings?.persona || {};
  return (Array.isArray(p.habits) ? p.habits : []).filter((h) => h && norm(h.text));
}

/** 待确认的习惯提议。 */
export function habitsPendingOf(settings) {
  const p = settings?.get ? settings.get().persona || {} : settings?.persona || {};
  return (Array.isArray(p.habitsPending) ? p.habitsPending : []).filter((h) => h && norm(h.text));
}

/** 汇总视图(面板/接口用)。 */
export function rulesView(settings) {
  const meta = ruleMetaOf(settings);
  return {
    rules: rulesOf(settings).map((text) => ({ text, ...(ruleMetaOf(settings).find((m) => m.text === text) || {}) })),
    habits: habitsOf(settings),
    pending: habitsPendingOf(settings),
    caps: { rules: RULES_MAX, habits: HABITS_MAX },
  };
}

/** 写入后统一收尾:落库 + 交给调用方做快照失效。返回最新 settings 快照。 */
async function persist(settings, personaPatch) {
  return settings.update({ persona: personaPatch });
}

/**
 * 追加一条规矩。
 * - `source:'session'`(默认,器灵在会话里代写):**必须带原话** —— 没有原话写不进去,「经用户同意」可核查;
 * - `source:'panel'`(用户本人在面板里写):他自己敲的就是同意,不再要求另附原话,留痕记「面板直接写入」。
 * @returns {{ok:boolean, reason?:string, text?:string, warning?:string, rules?:string[]}}
 */
export async function addRule({ settings, rule, quote, sessionId = '', now = Date.now(), source = 'session' }) {
  const text = norm(rule);
  const fromPanel = source === 'panel';
  const src = fromPanel ? '(面板直接写入)' : norm(quote);
  if (!text) return { ok: false, reason: 'empty-rule' };
  if (!src) return { ok: false, reason: 'no-quote' };
  if (text.length > RULE_MAX_CHARS) return { ok: false, reason: 'too-long', limit: RULE_MAX_CHARS };
  if (src.length > QUOTE_MAX_CHARS) return { ok: false, reason: 'quote-too-long', limit: QUOTE_MAX_CHARS };

  const current = rulesOf(settings);
  const exists = current.find((r) => key(r) === key(text));
  if (exists) {
    const hit = ruleMetaOf(settings).find((m) => m.text === exists) || null;
    return { ok: false, reason: 'duplicate', text: exists, meta: hit };
  }
  const next = [...current, text];
  const meta = [...ruleMetaOf(settings), { text, quote: src, at: now, sessionId: String(sessionId || ''), source: fromPanel ? 'panel' : 'session' }];
  const warning = next.length > RULES_MAX ? 'over-cap' : undefined;
  const s2 = await persist(settings, { hardRules: next, ruleMeta: meta });
  return { ok: true, text, warning, rules: rulesOf({ persona: s2.persona }) };
}

/** 删除一条规矩(只按正文匹配;调用方负责留痕)。 */
export async function removeRule({ settings, rule }) {
  const text = norm(rule);
  const current = rulesOf(settings);
  const hit = current.find((r) => key(r) === key(text));
  if (!hit) return { ok: false, reason: 'not-found' };
  const next = current.filter((r) => r !== hit);
  const meta = ruleMetaOf(settings).filter((m) => m.text !== hit);
  await persist(settings, { hardRules: next, ruleMeta: meta });
  return { ok: true, text: hit, rules: next };
}

/** 提议一条习惯(任一方都可提议;落地必须经对方确认)。 */
export async function proposeHabit({ settings, habit, evidence = '', byUser = false, now = Date.now() }) {
  const text = norm(habit);
  const ev = norm(evidence).slice(0, EVIDENCE_MAX_CHARS);
  if (!text) return { ok: false, reason: 'empty-habit' };
  if (text.length > RULE_MAX_CHARS) return { ok: false, reason: 'too-long', limit: RULE_MAX_CHARS };
  if (habitsOf(settings).some((h) => key(h.text) === key(text))) return { ok: false, reason: 'already-habit' };
  const pending = habitsPendingOf(settings);
  const dup = pending.find((h) => key(h.text) === key(text));
  if (dup) return { ok: false, reason: 'already-pending', id: dup.id };

  const id = `h${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const next = [...pending, { id, text, evidence: ev, byUser: !!byUser, at: now }];
  await persist(settings, { habitsPending: next });
  return { ok: true, id, pending: next.length, text };
}

/** 处理一条习惯提议:确认则落地为习惯,驳回则丢弃。 */
export async function resolveHabit({ settings, id, action, now = Date.now() }) {
  const pending = habitsPendingOf(settings);
  const item = pending.find((h) => h.id === String(id));
  if (!item) return { ok: false, reason: 'not-found' };
  const rest = pending.filter((h) => h.id !== item.id);
  if (action === 'reject') {
    await persist(settings, { habitsPending: rest });
    return { ok: true, rejected: item.text, pending: rest.length };
  }
  if (action !== 'confirm') return { ok: false, reason: 'bad-action' };

  // 禁止重复落地:确认时若已存在同名习惯,只清 pending。
  const existing = habitsOf(settings);
  if (existing.some((h) => key(h.text) === key(item.text))) {
    await persist(settings, { habitsPending: rest });
    return { ok: false, reason: 'already-habit', text: item.text };
  }
  const next = [...existing, { text: item.text, evidence: item.evidence || '', at: now, source: item.byUser ? 'user-proposed' : 'grown' }];
  const warning = next.length > HABITS_MAX ? 'over-cap' : undefined;
  await persist(settings, { habitsPending: rest, habits: next });
  return { ok: true, text: item.text, warning, habits: next.map((h) => h.text) };
}

/**
 * 器灵对「用户提议的习惯」表态:改一个说法(amend)—— 改完仍留在待确认里,等他点头。
 * 语义(2026-09-16 定稿):他提议 → 我回应;我若改法,改后的文本回到他那边确认。
 */
export async function amendHabit({ settings, id, text, note = '', now = Date.now() }) {
  const pending = habitsPendingOf(settings);
  const item = pending.find((h) => h.id === String(id));
  if (!item) return { ok: false, reason: 'not-found' };
  const next = norm(text);
  if (!next) return { ok: false, reason: 'empty-habit' };
  if (next.length > RULE_MAX_CHARS) return { ok: false, reason: 'too-long', limit: RULE_MAX_CHARS };
  const list = pending.map((h) => (h.id === item.id
    ? { ...h, text: next, amendedBy: 'ling', amendNote: norm(note).slice(0, 200), amendedAt: now }
    : h));
  await persist(settings, { habitsPending: list });
  return { ok: true, id: item.id, from: item.text, text: next };
}

/** 删除一条已定习惯(同样留痕由调用方负责)。 */
export async function removeHabit({ settings, habit }) {
  const text = norm(habit);
  const current = habitsOf(settings);
  const hit = current.find((h) => key(h.text) === key(text));
  if (!hit) return { ok: false, reason: 'not-found' };
  const next = current.filter((h) => h !== hit);
  await persist(settings, { habits: next });
  return { ok: true, text, habits: next.map((h) => h.text) };
}
