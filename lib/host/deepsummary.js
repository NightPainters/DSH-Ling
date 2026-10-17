// dsh-ling host — LLM 深摘要(循环外一次性调用 ctx.llm.stream;通道经 2026-09-07 真机验证)。
// 原文双源:DB(dsh_turns_raw)+ 磁盘(~/.dsh/sessions,存量会话)。探针严格:空回复判失败。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { svc, utcIso, dshHome } from './util.js';
import { wellFormed } from './rawlog.js'; // 1.7.1 F4 闭环:深摘转写直接进请求体
import { RAW_IMPORT_PREFIX, rawSessionCandidates } from './memory.js';
import { pickSessionFile } from './backfill.js';
import { currentModelSelection } from './mode.js';
import { decodeAll } from './zstd.js';
// 「后台自动行为」的默认值真源(persona.DEFAULT_SETTINGS.auto)与区间真源(guard.AUTO_NUMBER_RANGES)
// 都各有唯一一处 —— 本模块只**取来用**,不另抄一份数字(抄一份 = 下次改默认必然漏改一处)。
import { DEFAULT_SETTINGS } from './persona.js';
import { AUTO_NUMBER_RANGES } from './guard.js';

// 循环外调用(深摘要 / 诞生仪式 / 语气归纳 / 自述起草)一律**跟随用户当前的模型选择**:
// 平台 API 要求显式给出 {provider, model},故读 agentDefaultModel.currentSelection();
// 只有读不到时才退回下面的兜底值(是兜底,不是"替用户指定模型")。
const FALLBACK_PROVIDER = 'deepseek-official';
const FALLBACK_MODEL = 'deepseek-v4-flash';

export const DEEP_CFG = {
  fallbackProvider: FALLBACK_PROVIDER,
  fallbackModel: FALLBACK_MODEL,
  effort: 'low',              // 循环外只做摘要/归纳,不需要高推理等级(与模式档位无关)
  maxTokens: 900,
  temperature: 0.2,
  inputCap: 26000,
  diskMinBytes: 64 * 1024,
  autoIntervalMin: 30,   // 旧默认值;1.7 起"自动间隔"的真源是 DEFAULT_SETTINGS.auto.deepIntervalMin(同值,见 resolveAuto)
  perRunLimit: 2,        // 仍是 deepCandidates 自己的默认每轮上限;启动块已改走 resolveAuto
};

/**
 * 读出**用户真的写过**的 auto 子树(settings.json 只持久化用户补丁,见 settings-file.js 文件头)。
 *
 * 为什么不能用 `settings.get().auto` 判优先级:`get()` 把 DEFAULT_SETTINGS 深合并了进来
 * ⇒ 那五个键**永远存在**,于是"代码默认值"会冒充"用户设定":插件配置里的旧键
 * (`feedbackAuto` / `deepSummaryAuto` / `deepIntervalMin` / `deepMaxPerRun`)被永久压掉
 * (老用户升级上来行为就变了),面板的 `source` 也会永远显示 settings。
 * 入参两种都收:SettingsFile 实例(读 `.user.auto` —— 真实运行时)或普通设置对象(退回 `.auto`,测试桩用);
 * **「有 .user 但没写 auto」与「没有 .user」必须分开**:前者 = 用户什么都没写 ⇒ `{}`,后者才回退到 `.auto`。
 */
export function storedAuto(settingsLike) {
  const s = (settingsLike && typeof settingsLike === 'object') ? settingsLike : {};
  const hasUser = (s.user && typeof s.user === 'object' && !Array.isArray(s.user)) ? s.user : null;
  const cand = hasUser ? hasUser.auto : s.auto;
  return (cand && typeof cand === 'object' && !Array.isArray(cand)) ? cand : {};
}

/**
 * 「后台自动行为」的**唯一解析处**(2026-10-16 与用户定):settings.auto > 插件配置旧键 > 代码默认。
 *
 * 为什么要收成一支:三级优先级原先散在 `index.js` 的启动块里(且探活延时是裸的 12000、根本没有配置键),
 * 而设置面板必须能如实显示"这个值是谁定的" —— 两处各判一次,迟早会漂成两个答案。
 *
 * 默认值**只从 `DEFAULT_SETTINGS.auto` 取**(不在这里另抄一份数字);区间只从 `AUTO_NUMBER_RANGES` 取。
 * cfg 一侧刻意保留旧代码的 `Number(...)` 口径:插件配置里写 `'60'` 这种字符串,旧实现是生效的,
 * 这里不能因为"更严格"就把它变成没设过(那才是行为变了)。
 *
 * @param {object} settings SettingsFile 实例(读用户补丁)或普通设置对象;见 storedAuto
 * @param {object} [cfg] 插件配置(旧键名:`deepSummaryAuto` / `deepIntervalMin` / `deepMaxPerRun` / `feedbackAuto`)
 * @returns {{deepSummary: boolean, deepIntervalMin: number, deepMaxPerRun: number,
 *   bootProbeDelayMs: number, feedbackAuto: boolean,
 *   source: Record<string, 'settings'|'config'|'default'>}}
 */
export function resolveAuto(settings, cfg = {}) {
  const sAuto = storedAuto(settings);
  const c = (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) ? cfg : {};
  const D = DEFAULT_SETTINGS.auto;
  const source = {};
  /** 布尔:settings 里必须是**真布尔**才算命中(字符串 "false" 不算设过 —— 与写面同一把尺)。 */
  const boolOf = (key, cfgKey, def) => {
    if (typeof sAuto[key] === 'boolean') { source[key] = 'settings'; return sAuto[key]; }
    if (cfgKey && typeof c[cfgKey] === 'boolean') { source[key] = 'config'; return c[cfgKey]; }
    source[key] = 'default'; return def;
  };
  /** 数字:settings 收有限数;cfg 沿用 `?? + Number()` 的旧口径(只有 undefined/null 算"没写");
   *  非有限数(如 'abc')落到默认 —— 旧实现会把它变成 NaN(interval 变 0 = 空转),那不是要保留的行为。 */
  const numOf = (key, cfgKey, def) => {
    const [lo, hi] = AUTO_NUMBER_RANGES[key];
    let raw;
    if (typeof sAuto[key] === 'number' && Number.isFinite(sAuto[key])) { raw = sAuto[key]; source[key] = 'settings'; }
    else {
      const has = cfgKey !== undefined && cfgKey !== null && c[cfgKey] !== undefined && c[cfgKey] !== null;
      const cv = has ? Number(c[cfgKey]) : NaN;
      if (has && Number.isFinite(cv)) { raw = cv; source[key] = 'config'; }
      else { raw = def; source[key] = 'default'; }
    }
    return Math.min(hi, Math.max(lo, raw));
  };
  return {
    // 探活延时**没有**旧配置键(此前硬编码 12000)⇒ 它只可能来自 settings 或默认。
    deepSummary: boolOf('deepSummary', 'deepSummaryAuto', D.deepSummary),
    deepIntervalMin: numOf('deepIntervalMin', 'deepIntervalMin', D.deepIntervalMin),
    deepMaxPerRun: numOf('deepMaxPerRun', 'deepMaxPerRun', D.deepMaxPerRun),
    bootProbeDelayMs: numOf('bootProbeDelayMs', null, D.bootProbeDelayMs),
    feedbackAuto: boolOf('feedbackAuto', 'feedbackAuto', D.feedbackAuto),
    source,
  };
}

/** 解析循环外调用使用的模型:跟随当前选择;不可读则用兜底值并留一行 debug。 */
export function resolveLlmTarget(ctx) {
  const cur = typeof currentModelSelection === 'function' ? currentModelSelection(ctx) : null;
  if (cur) return { provider: cur.provider, model: cur.model, followed: true };
  console.debug('[dsh-ling] llm target fallback →', FALLBACK_PROVIDER + '/' + FALLBACK_MODEL,
    '(agentDefaultModel.currentSelection 不可读;这不是用户的当前选择)');
  return { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL, followed: false };
}

/** 达标判定:(较多真人轮次但文本少)或(轮次尚可且文本充足)。 */
export function passThreshold(users, chars) {
  return (users >= 6 && chars >= 1500) || (users >= 2 && chars >= 6000);
}

/** 一次性模型调用(手建请求);收集 text-delta 与 chunk 类型日志。
 *  模型:**跟随当前选择**(显式传入 provider/model 时以入参为准,供测试/覆盖)。 */
export async function llmOnce(ctx, { system, text, maxTokens = DEEP_CFG.maxTokens, signal, effort = DEEP_CFG.effort, provider, model } = {}) {
  const llm = svc(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable');
  const target = resolveLlmTarget(ctx);
  const chunks = llm.stream({
    provider: provider || target.provider,
    model: model || target.model,
    reasoningEffort: effort,
    temperature: DEEP_CFG.temperature,
    maxTokens,
    signal,
    system,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text) }],
      source: { kind: 'user' },
    }],
  });
  let out = '';
  const chunkLog = [];
  for await (const c of chunks) {
    if (!c || typeof c.type !== 'string') continue;
    if (chunkLog.length < 10) chunkLog.push(c.type);
    if (c.type === 'text-delta' && typeof c.text === 'string') out += c.text;
    if (c.type === 'error') throw new Error('llm stream error');
  }
  return { text: out, chunkLog, target };
}

/** 启动自检:先试 off(不思考)+足额预算;失败或空回复再试 low+大预算;仍空才判失败。 */
export async function probeLLM(ctx, memory) {
  const attempts = [];
  const run = async (effort, maxTokens) => {
    const t0 = Date.now();
    try {
      const { text, chunkLog } = await llmOnce(ctx, {
        system: 'Reply with exactly: pong',
        text: 'ping',
        maxTokens,
        effort,
      });
      const reply = text.trim();
      attempts.push({ effort, maxTokens, ok: reply.length > 0, reply: reply.slice(0, 40), chunkTypes: chunkLog, ms: Date.now() - t0 });
      return reply.length > 0;
    } catch (e) {
      attempts.push({ effort, maxTokens, ok: false, error: String(e?.message ?? e).slice(0, 200) });
      return false;
    }
  };
  const ok = (await run('off', 300)) || (await run('low', 600));
  const last = attempts[attempts.length - 1];
  memory.kvSet('llm.probe', JSON.stringify({
    ok,
    attempts,
    reply: ok ? last.reply : '(空回复)',
    chunkTypes: last ? last.chunkTypes || null : null,
    error: last && !ok ? last.error || null : null,
    at: utcIso(),
  }));
  return { ok, attempts };
}

/** 在 ~/.dsh/sessions 下定位某会话的转储文件(代次无关:session[.vN].jsonl.zstd)。 */
export function findSessionFile(sessionId) {
  const root = join(dshHome(), 'sessions');
  let ws;
  try { ws = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const w of ws) {
    if (!w.isDirectory()) continue;
    const hit = pickSessionFile(join(root, w.name, String(sessionId)));
    if (hit) return hit.f;
  }
  return null;
}

/** 从磁盘解码文件并统计/拼接 user/assistant 真实消息。 */
export function transcriptFromFile(file, { cap = DEEP_CFG.inputCap } = {}) {
  const text = decodeAll(readFileSync(file));
  const parts = [];
  let users = 0;
  let asst = 0;
  for (const line of text.split('\n')) {
    if (line.includes('"type":"user/message"')) {
      if (!line.includes('"kind":"user"')) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const body = ev?.data?.content;
      const u = Array.isArray(body)
        ? body.filter((b) => b?.type !== 'reasoning' && b?.type !== 'tool-call').map((b) => (typeof b === 'string' ? b : b?.text || b?.content || '')).join('\n')
        : '';
      if (!u) continue;
      users += 1;
      parts.push('[用户] ' + u.trim());
    } else if (line.includes('"type":"assistant/message"')) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const msg = ev?.data?.message;
      const body = msg?.content;
      const a = Array.isArray(body)
        ? body.filter((b) => b?.type === 'text' || !b?.type).map((b) => (typeof b === 'string' ? b : b?.text || b?.content || '')).join('\n')
        : '';
      if (!a) continue;
      asst += 1;
      parts.push('[AI] ' + a.trim());
    }
  }
  let joined = parts.join('\n');
  if (joined.length > cap) {
    const mark = '\n…[中段省略]…\n';
    const budget = Math.max(100, cap - mark.length);
    joined = joined.slice(0, Math.floor(budget * 0.6)) + mark + joined.slice(-Math.floor(budget * 0.4));
  }
  const safe = wellFormed(joined);
  return { text: safe, users, asst, chars: safe.length, file };
}

/** DB 原文转录(role user/assistant,按 seq)。source 给定时按 G4 命名空间取原文
 *  (import 源先试 'import:<id>' 再回退裸 id;dsh/dsweb 用裸 id)。 */
export function buildTranscript(memory, sessionId, { cap = DEEP_CFG.inputCap, source } = {}) {
  const stmt = memory.db.prepare(
    "SELECT seq, role, text FROM dsh_turns_raw WHERE session_id=? AND role IN ('user','assistant') ORDER BY seq",
  );
  let rows = [];
  for (const id of rawSessionCandidates(source, sessionId)) {
    rows = stmt.all(id);
    if (rows.length) break;
  }
  const parts = [];
  let users = 0;
  let total = 0;
  for (const r of rows) {
    const label = r.role === 'user' ? '[用户]' : '[AI]';
    const t = String(r.text || '').trim();
    if (!t) continue;
    if (r.role === 'user') users += 1;
    const line = `${label} ${t}`;
    total += line.length;
    parts.push(line);
  }
  let text = parts.join('\n');
  if (text.length > cap) {
    const mark = '\n…[中段省略]…\n';
    const budget = Math.max(100, cap - mark.length);
    text = text.slice(0, Math.floor(budget * 0.6)) + mark + text.slice(-Math.floor(budget * 0.4));
  }
  const safe = wellFormed(text);
  return { text: safe, users, parts: parts.length, chars: safe.length };
}

/**
 * 候选池:①DB 原文达标;②磁盘文件(≥diskMinBytes)有概述且未深摘。
 * 返回 [{session_id, users?, chars?, lastTs, file?}] 按最近活跃降序。
 */
export function deepCandidates(memory, { limit = DEEP_CFG.perRunLimit } = {}) {
  const rawRows = memory.db.prepare(
    `SELECT t.session_id,
            COUNT(*) FILTER (WHERE t.role='user') AS users,
            COUNT(*) FILTER (WHERE t.role='assistant') AS asst,
            COALESCE(SUM(LENGTH(t.text)),0) AS chars,
            MAX(t.ts) AS lastTs
     FROM dsh_turns_raw t
     JOIN conv_overview o ON o.source='dsh' AND o.conv_id=t.session_id
     GROUP BY t.session_id`,
  ).all();
  const rawPass = new Set();
  const rawOut = [];
  for (const r of rawRows) {
    if (memory.kvGet('deep:' + r.session_id)) continue; // 已深摘;skip 不约束 raw(会话长大后可重试)
    if (!passThreshold(Number(r.users), Number(r.chars))) continue;
    rawPass.add(r.session_id);
    rawOut.push({ session_id: r.session_id, users: r.users, chars: r.chars, lastTs: r.lastTs, file: null });
  }
  rawOut.sort((a, b) => String(b.lastTs || '').localeCompare(String(a.lastTs || '')));
  // 磁盘源:按文件大小降序(内容多者优先);跳过已摘/已判不合格
  const ovs = memory.db.prepare("SELECT conv_id, updated_at FROM conv_overview WHERE source='dsh'").all();
  const diskOut = [];
  for (const o of ovs) {
    if (rawPass.has(o.conv_id)) continue;
    if (memory.kvGet('deep:' + o.conv_id) || memory.kvGet('deep.skip:' + o.conv_id)) continue;
    const file = findSessionFile(o.conv_id);
    if (!file) continue;
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }
    if (size < DEEP_CFG.diskMinBytes) continue;
    diskOut.push({ session_id: o.conv_id, users: 0, chars: 0, lastTs: o.updated_at, file, size });
  }
  diskOut.sort((a, b) => b.size - a.size);
  return rawOut.concat(diskOut).slice(0, Math.max(1, Number(limit) || DEEP_CFG.perRunLimit));
}

const SYS = '你是用户的私人记忆摘要器。你会读到一段多轮对话记录(可能含代码/技术/生活内容)。请输出:第一行「主旨」,第二行「关键结论或产出」,第三行「用户的偏好/值得日后引用的点」。总输出不超过 500 字,不要客套,不要复述对话,不要用 markdown 标题。';

/** 对一个会话做深摘要并回写 overview.summary(原值存 kv deep.orig.<sid>)。 */
export async function deepSummarizeOne(ctx, memory, candidate) {
  const sessionId = candidate.session_id;
  // 档案行可能落在任一来源域(dsh / dsweb / import):按序查找后原域回写
  const overview = memory.overviewById('dsh', String(sessionId))
    || memory.overviewById('dsweb', String(sessionId))
    || memory.overviewById('import', String(sessionId));
  if (!overview) return { ok: false, reason: 'no-overview' };
  let tr;
  if (candidate.file) {
    tr = transcriptFromFile(candidate.file);
  } else {
    tr = buildTranscript(memory, sessionId, { source: overview.source });
  }
  if (!tr.text || !passThreshold(tr.users, tr.chars)) {
    // 不合格会话打跳过标记(避免每轮占坑重试);DB 原文后续长大会走 raw 通道重新评估
    memory.kvSet('deep.skip:' + sessionId, 'below-min:' + tr.users + ':' + tr.chars + ':' + utcIso());
    return { ok: false, reason: 'below-min', users: tr.users, chars: tr.chars };
  }
  const { text } = await llmOnce(ctx, { system: SYS, text: tr.text });
  const summary = text.trim();
  if (!summary) return { ok: false, reason: 'empty-output' };
  if (!memory.kvGet('deep.orig:' + sessionId)) {
    memory.kvSet('deep.orig:' + sessionId, overview.summary || '');
  }
  memory.upsertOverview({ ...overview, summary });
  memory.kvSet('deep:' + sessionId, 'done:' + utcIso());
  memory.kvSet('deep.sum:' + sessionId, summary); // 永久快照,防被浅版覆盖后丢失
  return { ok: true, sessionId, chars: summary.length };
}

/** 清掉 done/skip 标记,允许(或强制)重新深摘。 */
export function rerunOne(memory, sessionId) {
  const sid = String(sessionId);
  memory.kvSet('deep:' + sid, '');
  memory.kvSet('deep.skip:' + sid, '');
  return { ok: true, sessionId: sid };
}

/** 候选来源:优先 DB 原文;否则磁盘文件。
 *  G4:同时兼容导入命名空间('import:<id>')与旧数据的裸 id。 */
export function candidateFor(memory, sessionId) {
  const sid = String(sessionId);
  const stmt = memory.db.prepare("SELECT COUNT(*) n FROM dsh_turns_raw WHERE session_id=? AND role='user'");
  for (const id of [sid, RAW_IMPORT_PREFIX + sid]) {
    const c = stmt.get(id);
    if (c && Number(c.n) > 0) return { session_id: sid, file: null };
  }
  const file = findSessionFile(sid);
  if (file) return { session_id: sid, file };
  return { session_id: sid, file: null };
}

/** import 源中带原文的会话,按体量降序(一键深摘/诞生仪式用)。
 *  excludeProcessed=true 时排除已 done 或已 skip 的会话——按钮"继续"推进的是未读部分,不重复重跑。 */
export function importRawTargets(memory, { limit = 50, excludeProcessed = false } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const all = memory.db.prepare(
    `SELECT o.conv_id AS conv_id, SUM(LENGTH(t.text)) chars
       FROM dsh_turns_raw t
       JOIN conv_overview o ON o.source='import'
        AND (o.conv_id = t.session_id OR (? || o.conv_id) = t.session_id)
      GROUP BY o.conv_id ORDER BY chars DESC`,
  ).all(RAW_IMPORT_PREFIX);
  const out = [];
  for (const r of all) {
    const sid = String(r.conv_id);
    if (excludeProcessed) {
      const done = String(memory.kvGet('deep:' + sid) || '');
      const skip = String(memory.kvGet('deep.skip:' + sid) || '');
      if (done.trim() || skip.trim()) continue;
    }
    out.push({ session_id: sid, chars: Number(r.chars) });
    if (out.length >= lim) break;
  }
  return out;
}

/** 跑一轮深摘要(自动与手动共用);探针未通过/空回复时拒绝并说明。 */
export async function runDeepPass(ctx, memory, { limit } = {}) {
  const probeRaw = memory.kvGet('llm.probe');
  const probe = probeRaw ? JSON.parse(probeRaw) : null;
  if (!probe || !probe.ok) {
    return { ok: false, reason: 'probe-not-ok:' + (probe ? probe.error || probe.reply || 'empty-reply' : 'no-probe') };
  }
  const cands = deepCandidates(memory, { limit });
  const report = { candidates: cands.length, done: [] };
  for (const c of cands) {
    try {
      const r = await deepSummarizeOne(ctx, memory, c);
      report.done.push({ session_id: c.session_id, ok: r.ok, chars: r.chars || null, reason: r.reason || null });
    } catch (e) {
      report.done.push({ session_id: c.session_id, ok: false, reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  memory.kvSet('deep.last', JSON.stringify({ at: utcIso(), ...report }));
  return { ok: true, ...report };
}
