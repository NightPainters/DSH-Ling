// dsh-ling host — 习惯候选生成器(通道 A:零模型数纠正;通道 B:一次 LLM 读记忆回想)
//
// 为什么需要它(2026-09-16 与用户定稿):规矩/习惯拆开之后,"习惯"必须由器灵长出来,
// 但当时只有"会话内即时提议"这一条路 —— 没有任何东西会回头读我们一年多的相处。
//   - **通道 A(数出来的)**:纯本地规则扫描,零模型、确定性、可单测;
//   - **通道 B(想出来的)**:一次 LLM 调用,读最近的记忆概述 + A 的统计,归纳 1~3 条候选。
// 两者都只到"提议"为止 —— 落成习惯必须经用户确认(见 rules.proposeHabit / resolveHabit)。
//
// 判定口径(通道 A,**跨会话才叫模式**):
//   - 同一类纠正(太啰嗦/太文言/太虚/太冷/格式…)累计 ≥3 次,且**分布在 ≥2 个不同会话**;
//   - 候选文本直接取自 corpus-suggest 里那套纠正桶的规则文案(与语料提炼共用一份口径,避免两套标准)。
//
// 本模块只读库、零副作用(不写库、不发消息),便于在接口层决定要不要落成提议。

import { CORRECTION_BUCKETS } from './corpus-suggest.js';
import { extractJson } from './genesis.js';
import { isoDate } from './util.js';

export const SCAN_DEFAULTS = Object.freeze({
  minHits: 4,        // 同类纠正至少出现几次(2026-09-16 用户定案:3 → 4)
  minSessions: 3,    // 至少跨几个会话(单次会话里被说三遍不算"模式";2 → 3)
  maxTurns: 20000,   // 最多回看多少条真人轮次(防大库拖慢空闲边界)
  sampleLimit: 3,    // 每条候选带几段原话摘录
});

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * 扫描纠正信号(纯读)。
 * @param {{db:{prepare:Function}}} memory MemoryStore 实例
 * @returns {Array<{key:string, rule:string, hits:number, sessions:number, samples:string[]}>}
 */
export function scanCorrections(memory, opts = {}) {
  const { minHits, minSessions, maxTurns, sampleLimit } = { ...SCAN_DEFAULTS, ...opts };
  let rows = [];
  try {
    rows = memory.db.prepare(
      // G4:习惯只能从「主人自己的会话」长出来 —— 排除导入命名空间(别人的对话)
      "SELECT session_id, text FROM dsh_turns_raw WHERE role='user' AND session_id NOT LIKE 'import:%' ORDER BY seq DESC LIMIT ?",
    ).all(maxTurns);
  } catch {
    return [];   // 库结构异常时静默退化(生成器不能拖累别处)
  }

  const buckets = new Map(CORRECTION_BUCKETS.map((b) => [b.key, {
    key: b.key, rule: b.rule, hits: 0, sessions: new Set(), samples: [],
  }]));

  for (const r of rows) {
    const text = clean(r.text);
    if (!text) continue;
    for (const b of CORRECTION_BUCKETS) {
      if (!b.re.test(text)) continue;
      const item = buckets.get(b.key);
      item.hits += 1;
      item.sessions.add(String(r.session_id ?? ''));
      if (item.samples.length < sampleLimit) item.samples.push(text.slice(0, 80));
    }
  }

  return [...buckets.values()]
    .filter((b) => b.hits >= minHits && b.sessions.size >= minSessions)
    .map((b) => ({ key: b.key, rule: b.rule, hits: b.hits, sessions: b.sessions.size, samples: b.samples }))
    .sort((a, b) => (b.hits - a.hits) || (b.sessions - a.sessions));
}

/** 人读证据串(≤300 字,写进习惯提议的 evidence 字段)。 */
export function evidenceOf(cand) {
  const samples = (cand.samples || []).map((s) => `「${s}」`).join(' / ');
  return clean(`跨 ${cand.sessions} 个会话、共 ${cand.hits} 次纠正:${samples}`).slice(0, 300);
}

/** 给面板/接口的人读摘要(不落库)。 */
export function summarizeScan(candidates) {
  return candidates.map((c) => ({
    key: c.key, text: c.rule, hits: c.hits, sessions: c.sessions, evidence: evidenceOf(c),
  }));
}

// ── 通道 B:「让她回想最近的相处」 ───────────────────────────────────────────
// 与通道 A 的分工:A 是"数出来的"(零模型、确定性),B 是"想出来的"(一次 LLM,读记忆概述)。
// B 同样只产出**提议**,落地仍须用户确认。

export const REFLECT_DEFAULTS = Object.freeze({
  overviewLimit: 200,    // 回看多少条记忆概述(手动触发,不必省)
  turnLimit: 800,        // 回看多少条主人的真人原话
  budgetChars: 200000,   // 材料字符预算(远小于 1M 上下文,留足模型思考空间)
  maxTokens: 4000,       // 输出预算:够写 1~5 条候选 + 各自的证据
  maxHabits: 5,          // 一次最多提几条
  effort: 'off',         // 归纳任务:实测 'low' 只出思考、正文为空且慢十倍(2026-09-16);要更深可在设置里提高
});

export const HABIT_REFLECT_SYS = `你是器灵的"习惯观察员"。材料是她与主人最近的相处:主人的真人原话、她读过的会话概述、主人反复纠正过的地方,以及她现在的规矩与习惯。
任务:判断她是否值得新增 1~5 条「习惯」—— 即她**自己长出来的行为倾向**(语气、表达方式、做事节奏、提及记忆的方式),
而不是主人给她的指令(指令属于「规矩」,不由你提议)。

规则:
1. 只在材料里确有迹象时才提;迹象不足就返回空数组 —— **宁缺勿滥**;证据越具体,越要提;
2. 每条 ≤40 字,写成"她自己的倾向"(例:先给结论再展开;夜里说话更轻;不确定就直说不确定);
3. 每条必须给出证据:依据材料里的哪些原话/哪些重复出现的迹象;
4. 不要提"称呼、名字、底线、安全"相关内容 —— 那些属于契约,需要主人亲自解锁,不属于习惯;
5. 不要提泛泛的美德(如"要更努力"),要具体到行为;
6. 不要重复她已有的规矩或习惯。

只输出 JSON,不要解释:{"habits":[{"text":"…","evidence":"…"}]}`;

/**
 * 组装"回想"材料(纯读,不落库)。手动触发的调用,材料要给足 —— 预算默认 20 万字符(远小于 1M 上下文)。
 * 优先级:她现在的规矩/习惯 → 主人反复纠正处 → 主人的真人原话 → 她读过的概述;超预算时从尾部截断。
 * @returns {{ text: string, stats: {turns:number, overviews:number, corrections:number, chars:number} }}
 */
export function buildReflectMaterial(memory, opts = {}) {
  const {
    overviewLimit = REFLECT_DEFAULTS.overviewLimit,
    turnLimit = REFLECT_DEFAULTS.turnLimit,
    budgetChars = REFLECT_DEFAULTS.budgetChars,
    scan = [], rules = [], habits = [],
    cursor = null,
  } = opts;
  const textOf = (x) => clean(typeof x === 'string' ? x : x?.text);
  const blocks = [];
  const stats = {
    turns: 0, overviews: 0, corrections: 0, chars: 0,
    round: Math.max(1, Number(cursor?.round) || 1),
    turnOffset: 0, turnTotal: 0, ovOffset: 0, ovTotal: 0, wrapped: false,
  };
  let nextTurnOffset = 0;
  let nextOvOffset = 0;

  // ① 她现在的规矩与习惯 —— 让模型知道"已经有了什么",避免重复提议
  const curRules = (rules || []).map(textOf).filter(Boolean);
  const curHabits = (habits || []).map(textOf).filter(Boolean);
  if (curRules.length || curHabits.length) {
    const lines = [];
    if (curRules.length) lines.push('规矩(主人的指令):' + curRules.join(' / '));
    if (curHabits.length) lines.push('已有习惯:' + curHabits.join(' / '));
    blocks.push({ title: '【她现在的规矩与习惯(不要重复提议)】', lines });
  }

  // ② 主人反复纠正过的地方
  const cands = Array.isArray(scan) ? scan : [];
  if (cands.length) {
    stats.corrections = cands.length;
    blocks.push({
      title: '【主人反复纠正过的地方(本地统计:跨会话计数)】',
      lines: cands.map((c) => `- ${c.rule || c.text || c.key}(出现在 ${c.sessions} 个会话 / 共 ${c.hits} 次)`),
    });
  }

  // ③ 主人说过的话(真人原话;分轮读取 —— 每轮读上一轮没读过的那一段)
  try {
    const total = Number(memory?.db?.prepare?.("SELECT COUNT(*) n FROM dsh_turns_raw WHERE role='user' AND session_id NOT LIKE 'import:%'").get()?.n) || 0;
    stats.turnTotal = total;
    let off = Math.max(0, Number(cursor?.turnOffset) || 0);
    if (total > 0 && off >= total) { off = 0; stats.wrapped = true; }
    const rows = total > 0
      ? (memory.db.prepare("SELECT ts, text FROM dsh_turns_raw WHERE role='user' AND session_id NOT LIKE 'import:%' ORDER BY rowid DESC LIMIT ? OFFSET ?").all(turnLimit, off) || [])
      : [];
    const lines = rows
      .map((r) => { const t = clean(r?.text); return t ? `- (${isoDate(r?.ts) || '?'}) ${t.slice(0, 140)}` : ''; })
      .filter(Boolean)
      .reverse();
    stats.turns = lines.length;
    stats.turnOffset = off;
    nextTurnOffset = (total > 0 && off + turnLimit >= total) ? 0 : off + turnLimit;
    if (lines.length) blocks.push({ title: '【主人最近说过的话(真人原话,旧→新)】', lines });
  } catch { /* 库不可读时跳过该块 */ }

  // ④ 她读过的会话概述(同样分轮读取)
  try {
    const all = typeof memory?.listOverviews === 'function' ? memory.listOverviews({ onlyOk: true }) : [];
    const sorted = [...all].sort((a, b) => String(b?.updated_at || b?.started_at || '').localeCompare(String(a?.updated_at || a?.started_at || '')));
    stats.ovTotal = sorted.length;
    let off = Math.max(0, Number(cursor?.ovOffset) || 0);
    if (sorted.length > 0 && off >= sorted.length) { off = 0; stats.wrapped = true; }
    stats.ovOffset = off;
    nextOvOffset = (sorted.length > 0 && off + overviewLimit >= sorted.length) ? 0 : off + overviewLimit;
    const lines = sorted
      .slice(off, off + overviewLimit)
      .map((r) => {
        const date = String(r?.updated_at || r?.started_at || '').slice(0, 10);
        const sum = clean(r?.summary).slice(0, 120);
        const title = clean(r?.title).slice(0, 50);
        return `- [${r?.category || '?'}] (${date}) ${title}${sum && sum !== title ? '：' + sum : ''}`;
      })
      .filter((l) => l.length > 12);
    stats.overviews = lines.length;
    if (lines.length) blocks.push({ title: '【她读过的会话概述(新→旧)】', lines });
  } catch { /* 同上 */ }

  // 按预算拼装(超预算从块尾截断)
  const out = [];
  let used = 0;
  for (const b of blocks) {
    const head = b.title + '\n';
    if (used + head.length >= budgetChars) break;
    const kept = [];
    let size = 0;
    for (const line of b.lines) {
      if (used + head.length + size + line.length + 1 > budgetChars) break;
      kept.push(line);
      size += line.length + 1;
    }
    if (!kept.length) continue;
    const text = head + kept.join('\n');
    out.push(text);
    used += text.length + 2;
  }
  stats.chars = used;
  // 本轮覆盖情况(人读;接口与面板共用同一份措辞)
  const rng = (start, count, total) => (total ? `第 ${start + 1}–${start + count} 条 / 共 ${total} 条` : '无');
  stats.coverage = `第 ${stats.round} 轮 · 你的原话 ${rng(stats.turnOffset, stats.turns, stats.turnTotal)} · 会话概述 ${rng(stats.ovOffset, stats.overviews, stats.ovTotal)}` +
    (stats.wrapped ? ' · 已读完一圈,回到最新' : '');
  const nextCursor = { round: stats.round + 1, turnOffset: nextTurnOffset, ovOffset: nextOvOffset };
  if (!out.length) return { text: '', stats, nextCursor };   // 无任何材料 → 空串(接口据此提示,不要只给一行统计)
  const header = `（回想材料 · ${stats.coverage}）`;
  const text = (header + '\n\n' + out.join('\n\n') +
    `\n\n（材料统计:真人原话 ${stats.turns} 条 · 概述 ${stats.overviews} 条 · 纠正类型 ${stats.corrections} 类 · 共约 ${stats.chars} 字）`).trim();
  return { text, stats, nextCursor };
}

/** 回想调用的重试策略(复刻 probeLLM 的既有经验:思考档可能把预算吃光 → 空回复)。 */
export const REFLECT_RETRY = Object.freeze({
  retryEffort: 'off',          // 不思考,保证有可见输出
  retryMaterialChars: 80000,   // 重试时裁短材料,兼顾上下文较小的模型
});

/**
 * 发起"回想"调用;若空回复(或抛错),用 off 档 + 裁短材料再试一次。
 * 传入 llmOnce 而不是 ctx,便于单测注入假实现。
 * @returns {Promise<{text:string, attempts:Array, retried:boolean}>}
 */
export async function reflectWithRetry(llmOnceFn, { system, material, maxTokens, effort }) {
  const attempts = [];
  const run = async (eff, mat, tag) => {
    const t0 = Date.now();
    try {
      const r = await llmOnceFn({ system, text: mat, maxTokens, effort: eff });
      const text = String(r?.text ?? '');
      attempts.push({
        tag, effort: eff, maxTokens, chars: mat.length, ok: text.trim().length > 0,
        len: text.length, chunkTypes: r?.chunkLog || null, target: r?.target || null, ms: Date.now() - t0,
      });
      return text;
    } catch (e) {
      attempts.push({ tag, effort: eff, maxTokens, chars: mat.length, ok: false, error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 });
      return '';
    }
  };
  let text = await run(effort, material, 'first');
  if (!text.trim()) {
    const short = material.slice(0, REFLECT_RETRY.retryMaterialChars);
    text = await run(REFLECT_RETRY.retryEffort, short, 'retry-off');
  }
  return { text, attempts, retried: attempts.length > 1 };
}

/** 解析"回想"结果(容错:围栏剥离、中/英字段、超长丢弃、去重)。 */
export function parseReflect(text, { max = REFLECT_DEFAULTS.maxHabits, maxChars = 40 } = {}) {
  const obj = extractJson(String(text || ''));
  const arr = Array.isArray(obj?.habits) ? obj.habits : (Array.isArray(obj) ? obj : []);
  const out = [];
  for (const it of arr) {
    const t = clean(it?.text ?? it?.habit).slice(0, 200);
    if (!t || t.length > maxChars) continue;
    const ev = clean(it?.evidence ?? it?.why).slice(0, 300);
    if (out.some((x) => x.text === t)) continue;
    out.push({ text: t, evidence: ev });
    if (out.length >= max) break;
  }
  return out;
}

