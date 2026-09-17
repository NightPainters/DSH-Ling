// dsh-ling host — 记忆标题(D2,2026-09-17 与用户定)。
//
// 标题是记忆的"名字"。旧行为把首条用户消息硬截 46 字(见 summarizer.js TITLE_MAX),
// 于是 60 条 dsh 概述里 26 条是半句话:
//   「器灵，接下来在这里继续开发生长型人格与记忆树模块，继续走你的新生之路。 我刚刚对1.2.1的」
//   「刚才我为本虚拟机安装解压压缩软件<360压缩>，由于操作过快，被捆绑了360本体，随后我在物」
// 而 dsweb 侧标题干净(「CPU单核性能排行榜」),因为它用的是源库自带标题、不做首句截断。
//
// 三层:
//   ① heuristicTitle()  —— 剥称呼/问候前缀 + 在句读处截断(而不是硬切) + 无信息量首句时改取后续
//   ② retitleOne()      —— 小助手生成一句真标题(本机、零成本;1523 条 dsweb 摘要已证明可行)
//   ③ title_locked      —— 主人手改过的标题上锁,概述器重建与批量重命名都不再覆盖(在 memory.js 生效)
import { summarizeWithRetry } from './dsweb-summary.js';
import { llmOnce } from './deepsummary.js';
import { rawSessionCandidates } from './memory.js';

export const TITLE_MAX_CHARS = 58;   // 46 → 58:46 会把一句完整的话切成半句
export const LEGACY_TITLE_MAX = 46;  // 1.2.2 之前的硬截上限 —— 长度"达到"它就说明这条标题曾被切过
export const MACHINE_TITLE_MAX = 40; // 机器生成标题的上限(手改上限在 memory.renameTitle:120)
export const TITLE_MAX_TOKENS = 512; // 小助手下限,不得再低
export const TITLE_MATERIAL_CHARS = 1400;

export const TITLE_SYS = '你在给一段对话起名字。只输出标题本身:不超过 20 个字,写清这段对话在做什么或结论是什么;'
  + '不要引号、不要书名号、不要结尾标点、不要解释、不要分点、不要写"对话"二字。';

// 称呼与问候:中文主人对器灵的日常开场(「晚上好器灵，我小加班了一会，回来了」)
const ADDRESS_RE = /^(器灵|助手|宝贝|亲爱的)[，,、:：~～!！。\s]*/;
const GREETING_RE = /^(早上好|中午好|下午好|晚上好|晚安|你好呀|你好|您好|哈喽|嗨|早|hello|hi|yo)[啊呀呢，,、!！。.~\s]*/i;
// 无信息量首句(问候、寒暄、测试口令)
const VAGUE_RE = /^(嗯+|哦+|好+|在吗|在不在|\S{0,4}测试\S*|回复数字\s*\d+|\d+|ok|test)$/i;

/** 反复剥离"问候 + 称呼"前缀:「晚上好器灵，我小加班了一会，回来了」→「我小加班了一会，回来了」。 */
export function stripPreamble(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(GREETING_RE, '').replace(ADDRESS_RE, '').trim();
    if (s === before) break;
  }
  return s;
}

/** 该首句是否"不值得当标题"(剥完前缀后过短/纯寒暄/测试口令)。 */
export function isVagueTitle(text) {
  const s = stripPreamble(text);
  if (s.length < 4) return true;
  return VAGUE_RE.test(s);
}

/** 结果像不像一个"名字":拒路径 / URL / 系统文本 / 不含中文的串。
 *  实测教训(2026-09-17 dry-run):不加这道闸,启发式会把
 *  「已测试聊天」换成「E:\DSH\dsh-ling-upload里的license写入声明<Copyright [年份]」,
 *  「看一下这个文件夹的E:\DSH\from WEB\deepseek_」换成更短的路径 —— 比原标题更糟。 */
export function looksLikeTitle(s) {
  const t = String(s || '').trim();
  if (t.length < 4) return false;
  if (/^(file:|https?:|[A-Za-z]:[\\/]|\\|\/)/i.test(t)) return false;
  if (t.includes('\\') || t.includes('://')) return false;
  if (/[<>]/.test(t)) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  return true;
}

/**
 * 启发式标题:剥前缀 → 优先在句读处收尾(不切半句) → 兜底硬截。
 * 返回 '' 表示这段文本不适合当标题(调用方应改取后续消息)。
 */
export function heuristicTitle(text) {
  const s = stripPreamble(text);
  if (!s || isVagueTitle(text)) return '';
  // ① 首个句末标点在限内 → 收在那里(本身就是一句完整的话)
  const end = s.search(/[。！？!?;；]/);
  if (end >= 1 && end <= TITLE_MAX_CHARS) return gate(s.slice(0, end).trim());
  if (s.length <= TITLE_MAX_CHARS) return gate(s.replace(/[。！？，,；;、\s]+$/, '').trim());
  // ② 超长 → 退到最近的句读处,避免"…我刚刚对1.2.1的"这种半句
  const head = s.slice(0, TITLE_MAX_CHARS);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'), head.lastIndexOf('；'), head.lastIndexOf(' '));
  if (cut >= 12) return gate(head.slice(0, cut).trim());
  return gate(head.trim());
}

/** 兜底闸:含路径/URL/系统文本的结果宁可不要(交还给调用方 → 由小助手或人工处理)。 */
function gate(t) {
  return looksLikeTitle(t) ? t : '';
}

/** 清洗模型输出:去引号/书名号/结尾标点,限长。 */
export function cleanTitle(raw) {
  let s = String(raw || '');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  s = s.replace(/^\s*(标题|题目|title)\s*[:：]\s*/i, '');
  s = s.replace(/^["'「『《]+|["'」』》]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[。！？，,；;、\s]+$/, '').trim();
  if (s.length > MACHINE_TITLE_MAX) s = s.slice(0, MACHINE_TITLE_MAX);
  return s;
}

/** 组装给标题生成器的材料:优先会话原文前几轮,退化到已有摘要。 */
export function materialFor(memory, { source, conv_id, cap = TITLE_MATERIAL_CHARS } = {}) {
  const parts = [];
  try {
    for (const sid of rawSessionCandidates(source, conv_id)) {
      const rows = memory.db.prepare(
        'SELECT role, text FROM dsh_turns_raw WHERE session_id=? ORDER BY seq ASC LIMIT 6',
      ).all(sid);
      if (!rows.length) continue;
      for (const r of rows) {
        const t = String(r.text || '').replace(/\s+/g, ' ').trim();
        if (t) parts.push((r.role === 'user' ? '主人: ' : '她: ') + t.slice(0, 500));
      }
      break;
    }
  } catch { /* 无原文表/无此行 → 走摘要 */ }
  if (!parts.length) {
    const ov = memory.overviewById ? memory.overviewById(source, conv_id) : null;
    if (ov && ov.summary) parts.push('摘要: ' + String(ov.summary));
    if (ov && ov.title) parts.push('旧标题(可能不准): ' + String(ov.title));
  }
  let s = parts.join('\n');
  if (s.length > cap) s = s.slice(0, cap);
  return s;
}

/** 取该会话"值得当标题"的首句:先首条用户消息,不好则往后找(修「你好」「下午好」当标题)。 */
export function firstGoodUserText(memory, { source, conv_id, scan = 6 } = {}) {
  for (const sid of rawSessionCandidates(source, conv_id)) {
    const rows = memory.db.prepare(
      "SELECT text FROM dsh_turns_raw WHERE session_id=? AND role='user' ORDER BY seq ASC LIMIT ?",
    ).all(sid, scan);
    if (!rows.length) continue;
    const texts = rows.map((r) => String(r.text || ''));
    const good = texts.find((t) => !isVagueTitle(t) && String(t).trim().length >= 8 && looksLikeTitle(stripPreamble(t))) || '';
    return { text: good, first: texts[0] || '', scanned: texts.length };
  }
  return { text: '', first: '', scanned: 0 };
}

/**
 * 会会话 id 形态判定。
 * 采用**排除法**而非 uuid 白名单:白名单一旦不匹配(测试 fixture 的短 id、未来新形态的会话语)
 * 就会静默跳过起名 —— 那是最难发现的一类 bug。这里只排除已知的**合成记忆行**。
 * 实锤教训(2026-09-17):批量起名把「主人原则：不投资股市、不盯盘(珍惜注意力)」(conv_id = `user:principle-…`)
 * 改成「主人原则：拒绝股市投资与盯盘,专注精力」,丢了括注里的理由 —— 合成行不是会话,不参与起名。
 */
export function looksLikeSessionId(id) {
  return !/^(user|kv|rule|habit|persona|fact|note):/i.test(String(id || '').trim());
}

/** 纯启发式改名(不调用模型):用于无小助手可用时的兜底。 */
export function heuristicRetitle(memory, { source, conv_id } = {}) {
  const { text, first, scanned } = firstGoodUserText(memory, { source, conv_id });
  const title = heuristicTitle(text || first);
  return { ok: !!title, title, source: text ? 'later-turn' : 'first-turn', scanned };
}

/**
 * 用小助手给一条记忆起名。**同样上锁**(lock:true)——
 * 2026-09-17 实测教训:不上锁时,跑在旧代码里的概述器一轮增量重建
 * 就把 AI 起的名字覆盖回"首句硬截 46 字"的半句(库里 title 长度上限实锤 = 46)。
 * 锁的语义是"这个名字已经定过,机器不得自动重写";主人手改与 AI 点名起名都是显式意图,不受锁阻拦。
 */
export async function retitleOne(baseUrl, model, { memory, source, conv_id, timeoutMs = 90000 } = {}) {
  if (!looksLikeSessionId(conv_id)) return { ok: false, error: 'not-a-session', title: '', ms: 0 };
  const material = materialFor(memory, { source, conv_id });
  if (!material || material.replace(/\s/g, '').length < 12) {
    return { ok: false, error: 'no-material', title: '', ms: 0 };
  }
  const r = await summarizeWithRetry(baseUrl, model, {
    text: material, system: TITLE_SYS, maxTokens: TITLE_MAX_TOKENS, timeoutMs,
  });
  if (!r.ok) return { ok: false, error: r.error || 'llm-failed', title: '', ms: r.ms || 0 };
  const title = cleanTitle(r.summary);
  if (!title) return { ok: false, error: 'empty-title', title: '', ms: r.ms || 0 };
  memory.renameTitle(source, conv_id, title, { lock: true, by: 'ai' });
  return { ok: true, title, ms: r.ms, attempts: r.attempts };
}

/**
 * 全局大模型路径(D2/S7):小助手不可用时的正解 —— 与 `/dsweb/summary/run` 的 `engine:'global'` 同源。
 *  **不是"静默换引擎"**:端点会把实际用到的引擎写回响应的 `engine` 字段,用户看得见用了哪个。
 *  §引擎选择:默认优先本机小助手(零成本);探测不到时才落到这里,并把原因写进 `note`。
 */
export async function retitleOneGlobal(ctx, { memory, source, conv_id, effort = 'off' } = {}) {
  if (!looksLikeSessionId(conv_id)) return { ok: false, error: 'not-a-session', title: '', ms: 0, engine: 'global' };
  const material = materialFor(memory, { source, conv_id });
  if (!material || material.replace(/\s/g, '').length < 12) {
    return { ok: false, error: 'no-material', title: '', ms: 0, engine: 'global' };
  }
  const t0 = Date.now();
  const r = await llmOnce(ctx, { system: TITLE_SYS, text: material, maxTokens: 600, effort });
  const title = cleanTitle(r?.text);
  if (!title) return { ok: false, error: 'empty-title', title: '', ms: Date.now() - t0, engine: 'global' };
  memory.renameTitle(source, conv_id, title, { lock: true, by: 'ai' });
  return { ok: true, title, ms: Date.now() - t0, engine: 'global' };
}

/** 挑"值得重命名"的候选:未上锁 且 (空标题 / 被截断的 / 无信息量的)。 */
export function retitleCandidates(memory, { source = '', limit = 200 } = {}) {
  const where = ['title_locked=0'];
  const args = [];
  if (source) { where.push('source=?'); args.push(source); }
  const rows = memory.db.prepare(
    `SELECT source, conv_id, title, summary FROM conv_overview WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`,
  ).all(...args, Math.max(1, Math.min(5000, Number(limit) || 200)));
  return rows.filter((r) => {
    const t = String(r.title || '').trim();
    if (!looksLikeSessionId(r.conv_id)) return false;            // 合成行(user:principle-…)不是会话
    if (!t) return true;
    if (t.length >= LEGACY_TITLE_MAX) return true;               // 被旧上限(TITLE_MAX=46)切过的
    if (ADDRESS_RE.test(t) || GREETING_RE.test(t)) return true;  // 还带着「器灵，」「晚上好器灵，」= 旧启发式产物
    return isVagueTitle(t);                                      // 「你好」「已测试聊天」
  }).map((r) => ({ source: String(r.source), conv_id: String(r.conv_id), title: String(r.title || ''), summary: String(r.summary || '') }));
}
