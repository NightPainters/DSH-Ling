// dsh-ling host — LLM 深摘要(循环外一次性调用 ctx.llm.stream;通道经 2026-09-07 真机验证)。
// 原文双源:DB(dsh_turns_raw)+ 磁盘(~/.dsh/sessions,存量会话)。探针严格:空回复判失败。
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { svc, utcIso, dshHome } from './util.js';
import { RAW_IMPORT_PREFIX, rawSessionCandidates } from './memory.js';
import { currentModelSelection } from './mode.js';
import { decodeAll } from './zstd.js';

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
  autoIntervalMin: 30,
  perRunLimit: 2,
};

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

/** 在 ~/.dsh/sessions 下定位某会话的 jsonl.zstd。 */
export function findSessionFile(sessionId) {
  const root = join(dshHome(), 'sessions');
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const f = join(root, ws.name, String(sessionId), 'session.jsonl.zstd');
    try {
      const st = statSync(f);
      if (st.size > 0) return f;
    } catch {}
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
  return { text: joined, users, asst, chars: joined.length, file };
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
  return { text, users, parts: parts.length, chars: text.length };
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
