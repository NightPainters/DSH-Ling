// dsh-ling host — dsweb(网页端历史)概述补摘要(2026-09-16 与用户定案)。
//
// 背景:dsweb 的 1500+ 条概述**只有标题、没有摘要**(扫描时只取首条用户消息抽关键词/分类),
// 而正文在**源库**里(deepseek_library.db 的 conversations / messages),不在我们的库。
// 补摘要因此必须回源库取内容 → 调模型 → 只更新 conv_overview.summary(其余字段原样保留)。
//
// 候选口径(用户 2026-09-16 拍板):
//   1) 排序:**命中优先**(hit_count>0,即真的进过 L1 开场记忆)→ 其余按**轮次数降序**;
//   2) 阈值:轮次数 < minTurns(默认 2)默认不补(纯闲聊),显式 --all 才含;
//   3) 引擎:默认**本机小助手**(零成本);**绝不静默切换到大模型**(那等于替用户花钱)。
import { DatabaseSync } from 'node:sqlite';

// S7(2026-09-18 与用户定):默认地址**中性化**为 loopback —— 发布版绝不携带私有内网地址,
// 主人的真实小助手地址改由 settings.assistant(UI 可配)或环境变量指定,三级覆盖见 resolveAssistant()。
export const ASSISTANT_DEFAULT = 'http://127.0.0.1:11434/v1';
export const ASSISTANT_MODEL_DEFAULT = 'qwen3.5:9b';
export const MIN_TURNS_DEFAULT = 2;
export const MSG_BUDGET_DEFAULT = 2400;   // 小助手上下文仅 4096 token,材料必须克制
export const PER_MSG_DEFAULT = 600;
export const MAX_TOKENS_DEFAULT = 512;    // 小助手的下限,不得再低
export const SUMMARY_SYS = '你在为"历史会话"写一句摘要。只输出摘要本身:不超过 120 字,写清这次对话在做什么、结论是什么,不要客套、不要分点、不要引号、不要解释。';
/** Qwen3 的关思考软开关(2026-09-16 实测:该端点忽略 OpenAI 的 think 字段,但认这个)。 */
export const NO_THINK = '/no_think';

/**
 * S7:小助手目标的三级覆盖(2026-09-18 与用户定)。
 *   ① settings.assistant —— 界面可配,最高优先(主人的机器怎么连,主人说了算)
 *   ② 环境变量 DSH_LING_ASSISTANT / DSH_LING_ASSISTANT_MODEL —— 部署级
 *   ③ 内置默认 —— loopback,发布安全(绝不携带任何私有内网地址)
 * 返回生效值 + **来源**,便于界面如实显示"这个地址是哪来的"。
 */
export function resolveAssistant(settings) {
  const cfg = (settings && typeof settings.get === 'function' ? settings.get() : settings) || {};
  const a = cfg.assistant || {};
  const envBase = String(process.env.DSH_LING_ASSISTANT || '').trim();
  const envModel = String(process.env.DSH_LING_ASSISTANT_MODEL || '').trim();
  const setBase = String(a.baseUrl || '').trim();
  const setModel = String(a.model || '').trim();
  const baseUrl = setBase || envBase || ASSISTANT_DEFAULT;
  const model = setModel || envModel || ASSISTANT_MODEL_DEFAULT;
  const source = (setBase || setModel) ? 'settings' : ((envBase || envModel) ? 'env' : 'default');
  return {
    baseUrl, model, source,
    defaults: { baseUrl: ASSISTANT_DEFAULT, model: ASSISTANT_MODEL_DEFAULT },
    env: { baseUrl: envBase, model: envModel },
    configured: { baseUrl: setBase, model: setModel },
  };
}

/** 打开源库(只读)。表结构按扫描器已验证的形态:conversations / messages。 */
export function openSource(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 源库里的会话(含轮次数 n_user;缺列时回退 0)。 */
export function listConversations(src, { minTurns = MIN_TURNS_DEFAULT, includeShort = false } = {}) {
  let rows = [];
  try {
    rows = src.prepare('SELECT conv_id, title, n_user, updated_at, inserted_at FROM conversations').all();
  } catch {
    rows = src.prepare('SELECT conv_id, title FROM conversations').all();
  }
  const out = [];
  for (const r of rows) {
    const n = Number(r.n_user ?? 0) || 0;
    if (!includeShort && n < minTurns) continue;
    out.push({ conv_id: String(r.conv_id), title: String(r.title || ''), n_user: n, updated_at: r.updated_at || r.inserted_at || '' });
  }
  return out;
}

/** 取某会话的正文(user/assistant),按预算截断。 */
export function conversationText(src, convId, { budgetChars = MSG_BUDGET_DEFAULT, perMsg = PER_MSG_DEFAULT } = {}) {
  let rows = [];
  try {
    rows = src.prepare(
      "SELECT role, text FROM messages WHERE conv_id=? AND length(text)>0 ORDER BY seq LIMIT 60",
    ).all(String(convId));
  } catch {
    return '';
  }
  const parts = [];
  let used = 0;
  for (const r of rows) {
    const role = String(r.role || '').toUpperCase() === 'USER' ? '用户' : 'AI';
    const t = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, perMsg);
    if (!t) continue;
    const line = `${role}: ${t}`;
    if (used + line.length > budgetChars) break;
    parts.push(line);
    used += line.length;
  }
  return parts.join('\n');
}

/** 候选 = 源库会话 ∩ 记忆库待补的行(hit_count 优先,再按轮次降序)。 */
export function buildCandidates(memory, src, { minTurns = MIN_TURNS_DEFAULT, includeShort = false, onlyHit = false } = {}) {
  const overviews = memory.listOverviews({ onlyOk: true }).filter((r) => r.source === 'dsweb');
  const byId = new Map(overviews.map((r) => [String(r.conv_id), r]));
  const convs = listConversations(src, { minTurns, includeShort });
  const list = [];
  for (const c of convs) {
    const ov = byId.get(c.conv_id);
    if (!ov) continue;
    const hit = Number(ov.hit_count ?? 0) || 0;
    if (onlyHit && hit <= 0) continue;
    if (String(ov.summary || '').trim()) continue; // 已有摘要的不重复补
    list.push({ conv_id: c.conv_id, title: c.title || ov.title || '', n_user: c.n_user, hit_count: hit, category: ov.category || 'daily' });
  }
  list.sort((a, b) => (b.hit_count - a.hit_count) || (b.n_user - a.n_user) || String(a.conv_id).localeCompare(String(b.conv_id)));
  return list;
}

/** 探测本机小助手(3 秒)。返回 {ok, models[], reason}。 */
export async function probeAssistant(baseUrl = ASSISTANT_DEFAULT, { timeoutMs = 3000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/models', { signal: ctrl.signal });
    if (!res.ok) return { ok: false, models: [], reason: 'http-' + res.status };
    const j = await res.json();
    const models = (j?.data || []).map((m) => String(m.id || '')).filter(Boolean);
    return { ok: models.length > 0, models, reason: models.length ? 'ok' : 'no-models' };
  } catch (e) {
    return { ok: false, models: [], reason: String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)).slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调本机小助手写摘要。返回 {ok, summary, error, ms, diag}。
 *
 * 关键实测(2026-09-16):
 *   · `/v1/chat/completions`(OpenAI 兼容)**不认** think:false,也**不认** /no_think 软开关 →
 *     模型把 max_tokens 全用在 reasoning 上,`finish:'length'` 且正文为空(512→2133 字符思考;2048→4288 字符思考);
 *   · **Ollama 原生 `/api/chat` + `think:false` 有效**:实测 thinking 长度 0、正文正常。
 * 因此默认走原生端点(把 base 末尾的 `/v1` 去掉),`noThink:false` 时才用兼容端点。
 */
export async function summarizeLocal(baseUrl, model, { system = SUMMARY_SYS, text, maxTokens = MAX_TOKENS_DEFAULT, timeoutMs = 90000, noThink = true } = {}) {
  const t0 = Date.now();
  const base = String(baseUrl).replace(/\/+$/, '');
  const native = base.replace(/\/v1$/, '');
  const url = noThink ? native + '/api/chat' : base + '/chat/completions';
  const cap = Math.max(MAX_TOKENS_DEFAULT, Number(maxTokens) || MAX_TOKENS_DEFAULT);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const sys = noThink ? system + '\n' + NO_THINK : system;
    const usr = noThink ? text + '\n' + NO_THINK : text;
    const body = noThink
      ? {
        model, stream: false, think: false,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        options: { temperature: 0.2, num_predict: cap },
      }
      : {
        model, stream: false,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
        max_tokens: cap, temperature: 0.2,
      };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, error: 'http-' + res.status, ms: Date.now() - t0, diag: String(t).slice(0, 200), path: noThink ? 'native' : 'compat' };
    }
    const j = await res.json();
    const msg = noThink ? (j?.message ?? {}) : (j?.choices?.[0]?.message ?? {});
    const raw = String(msg.content ?? '');
    const reasoning = String(msg.thinking ?? msg.reasoning_content ?? msg.reasoning ?? '');
    const diag = {
      path: noThink ? 'native' : 'compat',
      finish: noThink ? (j?.done_reason ?? (j?.done ? 'stop' : null)) : (j?.choices?.[0]?.finish_reason ?? null),
      contentLen: raw.length,
      reasoningLen: reasoning.length,
      completionTokens: noThink ? (j?.eval_count ?? null) : (j?.usage?.completion_tokens ?? null),
      promptTokens: noThink ? (j?.prompt_eval_count ?? null) : (j?.usage?.prompt_tokens ?? null),
    };
    const summary = cleanSummary(raw);
    return { ok: !!summary, summary, error: summary ? null : (diag.reasoningLen > 0 ? 'reasoning-only' : 'empty'), ms: Date.now() - t0, diag };
  } catch (e) {
    return { ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message ?? e)).slice(0, 120), ms: Date.now() - t0, path: noThink ? 'native' : 'compat' };
  } finally {
    clearTimeout(timer);
  }
}

/** 清洗模型输出:去思考块/引号/换行,限长 300 字。 */
export function cleanSummary(raw) {
  let s = String(raw || '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/^\s*(摘要|总结|概述)\s*[:：]\s*/i, '');
  s = s.replace(/^["'「『]+|["'」』]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

/**
 * 带一次加预算重试的摘要调用(2026-09-16 实测教训):
 *   qwen3.x 默认思考,512 token 能被 reasoning 吃光 → `finish:'length'` 且正文为空。
 *   attempt 1:`/no_think` + 512;失败(reasoning-only/empty) → attempt 2:预算 ×4(给思考留够,正文才轮得上)。
 * 返回 { ok, summary, error, ms, attempts:[{tag,maxTokens,ok,error,ms,diag}] }
 */
export async function summarizeWithRetry(baseUrl, model, { text, system = SUMMARY_SYS, maxTokens = MAX_TOKENS_DEFAULT, timeoutMs = 90000 } = {}) {
  const attempts = [];
  const first = await summarizeLocal(baseUrl, model, { system, text, maxTokens, timeoutMs });
  attempts.push({ tag: 'no-think', maxTokens: Math.max(MAX_TOKENS_DEFAULT, maxTokens), ok: first.ok, error: first.error, ms: first.ms, diag: first.diag });
  if (first.ok) return { ok: true, summary: first.summary, error: null, ms: first.ms, attempts };
  const big = Math.max(2048, Math.max(MAX_TOKENS_DEFAULT, maxTokens) * 4);
  const second = await summarizeLocal(baseUrl, model, { system, text, maxTokens: big, timeoutMs });
  attempts.push({ tag: 'big-budget', maxTokens: big, ok: second.ok, error: second.error, ms: second.ms, diag: second.diag });
  if (second.ok) return { ok: true, summary: second.summary, error: null, ms: second.ms, attempts };
  return { ok: false, summary: '', error: second.error || first.error || 'failed', ms: second.ms, attempts };
}

/** 补摘要改的是记忆内容,必须 bump 版本 —— 否则长会话在空闲边界不会追平(只有概述器会 bump)。 */
export function touchMemoryVersion(memory, now = Date.now()) {
  try { memory?.kvSet?.('memory_version', String(now)); return true; } catch { return false; }
}
