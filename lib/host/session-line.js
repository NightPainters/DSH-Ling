// dsh-ling host — E0「那一行跟着会话走」(session progress line)。
//
// 病灶:`[记忆·开场]` 里「本会话自己那一行」= 标题 + 摘要第一句,而两者同源
// (`summarizer.js` 都取自首条真人消息)→ 会话越长,那一行恒等,等于同一句话印两遍。
// 裁定的形态是 **A · 只追不替**:只用 `agent/pre-step` 的 `decision.messages` **追加**一条
// 带自标识序号的活行,**绝不**调用带 `surfaceOp` 的 `session.append`(不引入 replace 契约面)。
// 旧行留在历史里(平台无删除),序号让它们读起来是"历史"而不是"矛盾"。
//
// 档位(2026-09-23 主人拍板,替换旧的 15min + 10 轮双门):
//   D = 只在 `step === 1`(新轮次第一批)考虑追加 —— "在新轮次开始时插进来";
//   C = "内容真变了才追加" —— 三道**同源**判据,任一说"没变"就不追加:
//       ① 逐字节:候选与上次真追加的 `st.text` 相同;
//       ② `counts.lastMd5`:md5(候选) 与上次记录的 md5 相同(裁定点名的那道);
//       ③ 实质键 `st.key` = md5(标题 + 最新进展):剥掉 `#N`/`第 N 轮`/`HH:MM` 这些易变段。
//       为什么非要 ③:正文自带 `#N`,而"试一次"就会让它 +1 ⇒ 只有 ①② 时恒判"变了",闸等于没有(实测钉过)。
//   ⇒ 旧档位 T/K(`TIER_MS_DEFAULT / TIER_TURNS_DEFAULT`)已废但保留导出,探针里 `tier.active:false`。
//   ⇒ 净效果:同一个"最新进展"在整段会话里只追加一次;发言一变,下一轮立刻追加一条(无时间门)。
//
// 平台契约(宿主 0.1.7-rc.2,行号为 checkout):
//   · `agent/pre-step` 载荷 `{agent, messages, turn, step, signal}`(runtime-types.d.ts:304-310),
//     派发见 dsh-agent-loop/lib/index.js:911-918;`step === 1 && messages.length > 0`
//     = 每轮用户发言后、模型首次开口前(:953 `step = phase.step + 1`,:1023 每轮 `phase.step = 0`)。
//     ⚠️ :962-966 首步**空批次直接收轮** ⇒ 往 `decision.messages` 塞东西必须以
//     `messages.length > 0` 为门,否则把本该结束的轮次顶开一步。
//   · 我们返回的消息由**宿主自己**追加(:1046 `session.append("user/message", message, {surfaceOp:"append"})`),
//     我们只提供 `UserMessage` 形状:`{id, role:'user', source:{kind}, content:[]}`
//     (dsh-session/lib/index.js:1151-1163 强制)。
//   · `user/message` 永不被过滤(:214-227)⇒ 想"作废"一条**不要**给空文本,本模块无作废路径。
//   · 客户端只有 `source.kind === 'user'` 才当输入气泡,其余走 contextMessage ⇒ **不动 client.js**。
//
// 热路径三条锁:① 闸门最前置;② 通过后只做 O(surface 节点数) 纯内存扫描 + O(1) 单行读
// (禁 summarizeDsh 全表扫、禁 runDeepPass、禁文件 IO);③ 全 handler try/catch 退化成 `return d`。
import { createHash } from 'node:crypto';
import { pick } from './util.js';
import { firstSentence } from './l1.js';
import { extractMessageText } from './snapshot.js';
import { canInject, kindOfAgent, sessionIdOfAgent } from './inject.js';

/** 我们那条活行的 `source.kind` —— 也是"认出自己"的唯一判据(不用记下的 seq:折叠后可能已不在面上)。 */
export const SESSION_LINE_SOURCE = 'dsh-ling:session-line';
/** ⚠️ **已废档位,不再生效** —— 2026-09-23 主人拍板:那一行表达「最新进展」,档位改为 D+C
 *  (轮次边界刷新 + 内容真变了才追加)。这两个常量 + `tierPass` **只保留导出**(测试/探针引用),
 *  handler 侧再也不拿它们当闸门:探针里 `tierActive: false` 就是"它不在生效"的显式标记。
 *  保留而不删的理由:① 有测试与文档引用;② 留着"最小间隔"这条路将来若要重启,口径可查。 */
export const TIER_MS_DEFAULT = 15 * 60 * 1000;
/** ⚠️ **已废档位,不再生效**(见 `TIER_MS_DEFAULT` 注释:档位改 D+C,双门撤除)。 */
export const TIER_TURNS_DEFAULT = 10;
/** 整行上限(与 `l1.js` 的 SUMMARY_CHARS_DEFAULT 同量级)。 */
export const LINE_MAX_CHARS = 110;
/** 「最新进展」上限:真人发言首句。 */
export const PROGRESS_MAX_CHARS = 40;
/** 标题段上限(概述器侧的标题上限是 58,这里只做兜底)。 */
export const TITLE_MAX_CHARS = 60;
export const KV_LAST = 'sessline.last.';
export const KV_COUNTS = 'sessline.counts.';
export const KV_DUPES = 'sessline.dupes.';
export const KV_ERR = 'sessline.err';

/** md5(仅用于"这条是不是新文本"的去重与探针展示,不是安全边界)。 */
export function md5(text) {
  return createHash('md5').update(String(text), 'utf8').digest('hex');
}

function oneLine(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

/** 硬夹到 n 字(超出留 `…`)。 */
function clip(s, n) {
  const t = String(s ?? '');
  const k = Math.max(1, Number(n) || 0);
  return t.length <= k ? t : t.slice(0, k - 1) + '…';
}

/** 本地时刻 HH:MM(与主人看到的钟一致;探针里用它判断"文本是否随对话变")。 */
export function hhmm(at) {
  const d = new Date(Number(at) || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 「最新进展」:真人发言首句,≤40 字。
 *  复用 `l1.firstSentence` 的句读切法(它 cap ≤40 时按 40 处理),**再夹一次** ——
 *  它会为省略号多留一个字(`40 字 + …`),这里保证严格 ≤40。 */
export function progressLine(text, cap = PROGRESS_MAX_CHARS) {
  const t = oneLine(text);
  if (!t) return '';
  return clip(firstSentence(t, cap), cap);
}

/**
 * 内容公式(照裁定,不另设计):
 *   `[本次会话·进展 #N] {标题} —— 最近:{最新真人发言首句} · 第 {turn} 轮 · {HH:MM}`
 * 整行 ≤ maxChars:标题优先(它是锚),剩余空间给进展;进展只剩不到 8 字就整段不带
 * (宁可是一行干净的标题,也不要 3 个字的残句)。两者皆空 ⇒ 返回 ''(调用方据此不写)。
 */
export function buildSessionLineText({ title, progress, turn, ordinal, at = Date.now(), maxChars = LINE_MAX_CHARS } = {}) {
  const head = `[本次会话·进展 #${Number(ordinal) || 1}] `;
  // 轮次段:turn 缺失/非法时**整段省略**(省略 = 陈述"不知道",与台账 B66 一致);
  // 绝不写 `第 0 轮` —— 那是假读数(`/state` 面板路径上没有 turn 来源)。
  const turnNum = Number(turn);
  const hasTurn = Number.isFinite(turnNum) && turnNum > 0;
  const tail = (hasTurn ? ` · 第 ${turnNum} 轮` : '') + ` · ${hhmm(at)}`;
  const mid = ' —— 最近:';
  const t0 = oneLine(title);
  const p0 = oneLine(progress);
  if (!t0 && !p0) return '';
  const room = Math.max(8, Number(maxChars) - head.length - tail.length - mid.length);
  let tt = t0;
  let pp = p0;
  if (tt.length + pp.length > room) {
    tt = clip(tt, Math.min(tt.length || room, room));
    const rest = room - tt.length;
    pp = rest >= 8 ? clip(pp, rest) : '';
  }
  return head + tt + (pp ? mid + pp : '') + tail;
}

/**
 * 扫一遍会话面(纯内存):回答两件事 —— ① 我们那条**还在不在**;② 面上最后一条的**文本**
 * (供逐字节硬闸)。顺带记下首条/末条**真人**发言(标题缺失时的兜底与"最新进展"的兜底)。
 * `nodes` 是 seq 数组(公开访问:官方 pruner:139、compaction-basic:869 在用),
 * `eventAt(seq)` 取回事件。**不用**"上次记下的 seq"定位:折叠后它可能已不在面上。
 */
export function scanSessionLineSurface(nodes, eventAt) {
  const out = { count: 0, lastText: '', lastSeq: -1, seqs: [], firstUser: '', latestUser: '' };
  for (const seq of Array.isArray(nodes) ? nodes : []) {
    let ev;
    try {
      ev = eventAt(seq);
    } catch {
      continue; // 单点取回失败不该让整段扫描失败
    }
    if (!ev || ev.type !== 'user/message') continue;
    const kind = ev?.data?.source?.kind;
    if (kind === SESSION_LINE_SOURCE) {
      out.count += 1;
      out.lastSeq = Number(seq);
      out.seqs.push(Number(seq));
      out.lastText = String(extractMessageText(ev) ?? ''); // 不折空白:硬闸要逐字节比
      continue;
    }
    if (kind === 'user') {
      const t = oneLine(extractMessageText(ev));
      if (t) {
        if (!out.firstUser) out.firstUser = t;
        out.latestUser = t;
      }
    }
  }
  return out;
}

/** 实质内容键:**只含"标题 + 最新进展"**,剥掉易变段(`#N` 序号 / `第 N 轮` / `HH:MM`)。
 *  用途:内容闸(C)的实质判据 —— 那一行表达「最新进展」,标点式的序号与钟点不算"进展变了";
 *  若拿带序号的整行去比,`#N` 每次尝试都会 +1 ⇒ 闸门永远为"变了",等于没有闸(实测过)。
 *  剥离(而非删除)易变段 = 不动那一行的呈现形态,只动"什么算变"。 */
export function progressKey(title, progress) {
  return md5(oneLine(title) + '\u0000' + oneLine(progress));
}

/** 从我们那条活行的正文里把"标题 + 进展"两段拆出来(给预览/自愈当比较基准)。
 *  正文形如 `[本次会话·进展 #N] {标题} —— 最近:{进展} · 第 T 轮 · HH:MM`,尾部整段是格式位。
 *  解不出(老格式/被夹过)⇒ 两段都空。 */
function partsFromLineText(text) {
  const t = String(text ?? '');
  const m = /^\[本次会话·进展 #\d+\]\s*([\s\S]*)$/.exec(t);
  if (!m) return { title: '', progress: '' };
  // 只剥**行尾**的格式段;`第 N 轮` 那一段可能不存在(缺 turn 时省略)。⚠️ 别用贪婪/可选组混写:
  // `(.*?)\s*(?:· 第 N 轮 …)?\s*$` 会把"结尾恰好像 HH:MM 的进展"也吞掉(实测踩过)。
  let body = m[1].trim();
  body = body.replace(/\s*·\s*\d{2}:\d{2}\s*$/, '');
  body = body.replace(/\s*·\s*第\s*\d+\s*轮\s*$/, '');
  const i = body.indexOf(' —— 最近:');
  return i >= 0
    ? { title: body.slice(0, i).trim(), progress: body.slice(i + ' —— 最近:'.length).trim() }
    : { title: body.trim(), progress: '' };
}

/** 从我们那条活行的正文里把"实质键"反解出来(给老记录/自愈用)。解不出 ⇒ ''。 */
function keyFromLineText(text) {
  const { title, progress } = partsFromLineText(text);
  return title || progress ? progressKey(title, progress) : '';
}

/** ⚠️ **档位双门(纯函数)—— 已不在决策路径上**(D+C 之后没有任何调用方:`maybeSessionLine`
 *  不再调它)。保留导出只为:测试钉住它的算术 + 将来若要恢复"最小间隔"有现成口径。
 *  旧语义:**两道门都要过**才算过;`state` 是上次追加的记录(内存优先,kv 兜底)。 */
export function tierPass({ state, turn, now = Date.now(), tierMs = TIER_MS_DEFAULT, tierTurns = TIER_TURNS_DEFAULT } = {}) {
  const at = Number(state?.at) || 0;
  const lastTurn = Number(state?.turn) || 0;
  const cur = Number(turn) || 0;
  return (now - at) >= Number(tierMs) && (cur - lastTurn) >= Number(tierTurns);
}

/**
 * 决策表(纯函数,逐行对应裁定)。**D+C 版**(2026-09-23 主人拍板):
 *   D(`step === 1`)已由 handler 的轮次边界闸门保证 —— 本函数被调用时必是"新轮次第一批";
 *   C(`changed`)是这里唯一的追加闸:内容没真变就不追加(**永久留痕的平台,刷新 = 再插一条**)。
 *
 * 分支逐条(顺序即优先级,先命中先返回):
 *   面上 > 1 条                     → 'dupes':形态 A 不作废旧副本(没有删除操作,也不许 replace)
 *   候选为空                        → 'empty':绝不给空文本的 user/message
 *   面上没有我们的行                → 'absent':**追加**(与 `changed` 无关 —— 行被折叠吞了,补一条是对的;
 *                                      这也正是"面上若没有我们的行,**即便文本与 lastMd5 相同也照样追加**"那条旧测试钉的语义)
 *   面上有 + `changed === false`    → 'same':内容真没变,**不追加**
 *   其余(面上有 + 内容变了)        → 'ok':追加一条新的(旧的留在历史里,#N 递增)
 *  ⚠️ 没有 'tier' 分支了(双门撤除)。
 *
 *  @param {object} o
 *  @param {{count:number}} o.onSurface 扫面结果,只用 `count`
 *  @param {string} o.candidate 本次候选正文
 *  @param {string} o.lastMd5 KV_LAST 里记的上一次真追加的 `md5(text)`(无记录 ⇒ '')
 *  @param {boolean} o.changed 内容真变了(`maybeSessionLine` 按上面三道判据算出来)
 */
export function decideSessionLine({ onSurface, candidate = '', lastMd5 = '', changed = true } = {}) {
  const s = onSurface || { count: 0 };
  const count = Number(s.count) || 0;
  if (count > 1) return { action: 'skip', reason: 'dupes' };
  if (!candidate) return { action: 'skip', reason: 'empty' };
  if (count === 0) return { action: 'append', reason: 'absent' };
  if (!changed) return { action: 'skip', reason: 'same' };
  return { action: 'append', reason: 'ok' };
}

// ---------------------------------------------------------------- kv 侧(全部 O(1) 单行读写)

function safeParse(raw) {
  try {
    return raw ? JSON.parse(String(raw)) : null;
  } catch {
    return null;
  }
}

function blankCounts() {
  return { append: 0, skippedTier: 0, skippedSame: 0, dupes: 0 };
}

export function readCounts(memory, sid) {
  try {
    const v = safeParse(memory?.kvGet?.(KV_COUNTS + sid));
    if (!v) return blankCounts();
    return {
      append: Number(v.append) || 0,
      skippedTier: Number(v.skippedTier) || 0,
      skippedSame: Number(v.skippedSame) || 0,
      dupes: Number(v.dupes) || 0,
    };
  } catch {
    return blankCounts();
  }
}

function writeCounts(memory, sid, c) {
  try {
    memory?.kvSet?.(KV_COUNTS + sid, JSON.stringify(c));
  } catch { /* 计数写不上不影响注入 */ }
}

function bumpCounts(memory, sid, field) {
  const c = readCounts(memory, sid);
  c[field] = (Number(c[field]) || 0) + 1;
  writeCounts(memory, sid, c);
  return c;
}

/** 上次追加记录:`{at, turn, md5, key, chars, text, seq, appendCount, replaceCount, kind}`。
 *  `key` = 实质内容键(标题+最新进展,剥掉 `#N`/轮次/HH:MM),内容闸的实质判据(新增字段)。
 *  `replaceCount` 恒 0 —— 形态 A 没有替换路径,留着是为了探针里一眼看出"确实一次都没替"。 */
function blankState() {
  return { at: 0, turn: 0, md5: '', key: '', chars: 0, text: '', seq: null, appendCount: 0, replaceCount: 0, kind: '' };
}

/** seq 归一:**保留 null**(不能用 `Number.isFinite(Number(v))` —— `Number(null)===0` 会把
 *  "还不知道"(null)悄悄变成 0,于是自愈判据 `st.seq === null` 在落盘一轮之后永远为假)。 */
function seqOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function writeLast(memory, sid, st) {
  try {
    memory?.kvSet?.(KV_LAST + sid, JSON.stringify({
      at: Number(st.at) || 0,
      turn: Number(st.turn) || 0,
      md5: String(st.md5 || ''),
      key: String(st.key || ''),
      chars: Number(st.chars) || 0,
      text: String(st.text || ''),
      seq: seqOrNull(st.seq),
      appendCount: Number(st.appendCount) || 0,
      replaceCount: Number(st.replaceCount) || 0,
      kind: String(st.kind || ''),
    }));
  } catch { /* 留痕失败不影响注入 */ }
}

/** 进程内 Map 优先;没有(重启/首次)才付一次 O(1) kv 单行读 ——
 *  这样重启后档位判定照旧有效(否则"重启即多追加一条",与裁定里"不会多出一条"相悖)。 */
function readState(memory, sid, stateMap) {
  const mem = stateMap.get(sid);
  if (mem) return mem;
  const v = safeParse(memory?.kvGet?.(KV_LAST + sid));
  const rec = v
    ? {
      at: Number(v.at) || 0,
      turn: Number(v.turn) || 0,
      md5: String(v.md5 || ''),
      key: String(v.key || ''),
      chars: Number(v.chars) || 0,
      text: String(v.text || ''),
      seq: seqOrNull(v.seq),
      appendCount: Number(v.appendCount) || 0,
      replaceCount: Number(v.replaceCount) || 0,
      kind: String(v.kind || ''),
    }
    : blankState();
  stateMap.set(sid, rec);
  return rec;
}

/** 标题:仍是锚。优先用**已有的**概述标题(主键单行读,不是全表扫);
 *  概述还没生成时退回"首条真人发言的首句"(与概述器同源,只是不落库)。 */
function resolveTitle(memory, sid, fallbackText) {
  try {
    const ov = memory?.overviewById?.('dsh', sid);
    const t = oneLine(ov?.title);
    if (t) return clip(t, TITLE_MAX_CHARS);
  } catch { /* 读不到概述就用兜底 */ }
  return clip(oneLine(fallbackText), TITLE_MAX_CHARS);
}

/** 本轮用户批次里最后一条**真人**发言(pre-step 的 `messages` 尚未入面,故从载荷取)。 */
function latestUserTextFromMessages(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const m = arr[i];
    if (m?.source?.kind !== 'user') continue;
    const t = oneLine(extractMessageText({ data: m }));
    if (t) return t;
  }
  return '';
}

/**
 * IO 半(可单测):扫面 → 候选文本 → **内容真变了闸(C)** → 可能构造一条消息。
 * **档位双门(15min / 10 轮)已撤**:本函数只在 `step === 1`(轮次边界,D)被 handler 调到,
 * 追加与否只看 `counts.lastMd5` 与 `md5(candidate)` 是否不同。`tierMs/tierTurns` 形参保留但**不再参与判定**。
 * 不做任何 `session.append`(追加是宿主的活,见 :1046);不写文件;不跑概述器。
 * @returns {{action:'append'|'skip', reason:string, message?:object, text?:string, ordinal?:number}}
 */
export function maybeSessionLine({ memory, agent, payload, stateMap, now = Date.now(), tierMs = TIER_MS_DEFAULT, tierTurns = TIER_TURNS_DEFAULT } = {}) {
  const sid = String(sessionIdOfAgent(agent) || '');
  const session = pick(() => agent?.session);
  if (!sid || !session || typeof session.eventAt !== 'function') return { action: 'skip', reason: 'no-session' };
  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes)) return { action: 'skip', reason: 'no-surface' };
  const scan = scanSessionLineSurface(nodes, (seq) => session.eventAt(seq));
  const st = readState(memory, sid, stateMap);

  // ① 脏状态(面上 >1 条):形态 A 不作废旧副本 ⇒ 只留痕 + 探针可见,不写历史。
  if (scan.count > 1) {
    bumpCounts(memory, sid, 'dupes');
    try {
      memory?.kvSet?.(KV_DUPES + sid, JSON.stringify({ at: now, count: scan.count, seqs: scan.seqs.slice(-8) }));
    } catch { /* 留痕失败不影响判定 */ }
    return { action: 'skip', reason: 'dupes', count: scan.count };
  }

  // ② seq 自愈(每会话至多一次):本行入日志的 seq 在决策时还不知道(追加发生在我们返回之后),
  //    下一轮从面上就能读到真值 —— 届时补记,之后不再写(kv `last.seq` 不再为 null)。
  //    ⚠️ 只补 `seq`/`text`/`md5`(留痕对齐面),**绝不在这里改 `appendCount`**:
  //    序号是"面上那条的编号 +1",自愈改它会让下一次候选的 `#N` 凭空 +1 ⇒ 内容闸(C)对"内容没变"永远失效。
  if (scan.count === 1 && st.seq === null && Number(scan.lastSeq) >= 0) {
    st.seq = Number(scan.lastSeq);
    if (scan.lastText) {
      st.text = scan.lastText;
      st.md5 = md5(scan.lastText);
      if (!st.key) st.key = keyFromLineText(scan.lastText);
    }
    stateMap.set(sid, st); // 回写进程内 Map:否则同一个 handler 的下一次调用又读到旧记录
    writeLast(memory, sid, st);
  }

  // ③ 候选文本:到这里才付 O(1) 单行读(overviewById)与字符串拼接。
  const turn = Number(payload?.turn) || 0;
  const progress = progressLine(latestUserTextFromMessages(payload?.messages) || scan.latestUser);
  const title = resolveTitle(memory, sid, scan.firstUser);
  const ordinal = (Number(st.appendCount) || 0) + 1;
  const candidate = buildSessionLineText({ title, progress, turn, ordinal, at: now });

  // ④ C 闸:内容真变了?**三条判据,任一说"没变"就不追加** ——
  //    ① 字面原文:候选与上次真追加的 `st.text` 逐字节相同(裁定原话那一侧);
  //    ② `counts.lastMd5`:`md5(候选)` 与上次记录的 md5 相同(裁定点名要用的那道判据);
  //    ③ 实质键 `st.key`:`progressKey(标题, 最新进展)` 与上次追加时记的相同(剥掉 `#N`/轮次/HH:MM)。
  //    为什么要 ③:只留 ①② 时,`#N` 每尝试一次就 +1 ⇒ 恒判"变了",闸等于没有(实测钉过);
  //    为什么要 ①②:同一轮内同参重入时,只有逐字节那一侧才拦得住。`st.key` 是**新增字段**,
  //    不动任何已有 kv 的含义;老记录没有它 ⇒ 第一次一律追加一条,之后照常。
  const lastMd5 = String(st.md5 || '');
  const lastKey = String(st.key || '');
  const textUnchanged = !!st.text && candidate === String(st.text);
  const curKey = progressKey(title, progress);
  const changed = !(textUnchanged || (!!lastMd5 && md5(candidate) === lastMd5) || (!!lastKey && curKey === lastKey));
  const verdict = decideSessionLine({ onSurface: scan, candidate, lastMd5, changed });
  if (verdict.action !== 'append') {
    // kv 语义**不变**:`skippedSame` = "被内容闸挡下"(旧义是"面末条逐字节相同",新义是"与 lastMd5/面末条相同",
    // 都是"内容没变 ⇒ 不追加");`dupes` 仍只表示"面上 >1 条"这一种脏状态,绝不混用。
    // `skippedTier` 已无写入点(档位撤除),老库里那个计数是历史值 —— 别改它的含义,也别清。
    if (verdict.reason === 'same') bumpCounts(memory, sid, 'skippedSame');
    return { action: 'skip', reason: verdict.reason, text: candidate };
  }

  // ⑤ 真追加:`{...decision, messages:[...]}` 由 handler 负责(保留 startsRequestSeries)。
  const message = {
    id: `sessline-${sid}-${ordinal}-${Number(now).toString(36)}`,
    role: 'user',
    source: { kind: SESSION_LINE_SOURCE },
    content: [{ type: 'text', text: candidate }],
  };
  st.at = now;
  st.turn = turn;
  st.md5 = md5(candidate);
  st.key = curKey;
  st.chars = candidate.length;
  st.text = candidate;
  st.seq = null; // 宿主还没追加:下一轮自愈
  st.appendCount = ordinal;
  st.replaceCount = 0;
  st.kind = 'append';
  stateMap.set(sid, st);
  writeLast(memory, sid, st);
  bumpCounts(memory, sid, 'append');
  return { action: 'append', reason: verdict.reason, message, text: candidate, ordinal, chars: candidate.length };
}

// ---------------------------------------------------------------- handler(顺序即纪律)

/**
 * 造一个 `agent/pre-step` waterfall 监听器。顺序不可调换:
 *   ① 单独一个 try 只做委托(**必须** `return next()`;不返回会让 :920 读 `decision.kind` 抛 TypeError
 *      ⇒ :993 catch ⇒ `turnEnds={kind:'error'}` ⇒ **该轮直接作废报错**)。`next()` 只调一次。
 *   ② 非 enter(`reject`)⇒ 原样返回,**零写操作**。
 *   ③ 轮次边界闸门最前置:`step === 1 && messages.length > 0`(空批次首步直接收轮,:962-966)。
 *   ④ 按 agent 种类过滤(全局注册会收到所有 agent,含子代理)。
 *   ⑤ 业务段整段 try/catch:出错只留证(`sessline.err`)+ 退化成"不注入" ——
 *      **绝不在 catch 里再调 next()**(waterfall 再调会重跑下游链)。
 */
export function createSessionLineHandler(memory, settings, cfg = {}) {
  const stateMap = new Map();
  // ⚠️ `cfg.tierMs / cfg.tierTurns` 仍然读进来(兼容老配置,不报错),但 **D+C 之后不再参与任何判定** ——
  //    写进 `maybeSessionLine` 也只是形参。改这两个值不会改变行为;要改行为请改决策表(见 `decideSessionLine`)。
  const tierMs = Number(cfg.tierMs) > 0 ? Number(cfg.tierMs) : TIER_MS_DEFAULT;
  const tierTurns = Number(cfg.tierTurns) > 0 ? Number(cfg.tierTurns) : TIER_TURNS_DEFAULT;
  return async function sessionLinePreStep(payload, next) {
    let d;
    try {
      d = await next();
    } catch (e) {
      throw e; // 委托失败不属于我们兜底的范围(下游自己的错)
    }
    if (!d || d.kind !== 'enter') return d;
    if (payload?.step !== 1 || !payload?.messages?.length) return d;
    try {
      if (payload.signal?.aborted) return d;
      const agent = payload.agent;
      if (!agent || !canInject(kindOfAgent(agent))) return d;
      const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
      if (s?.memory?.sessionProgressLine === false) return d; // 免重启回退开关
      const r = maybeSessionLine({ memory, agent, payload, stateMap, tierMs, tierTurns });
      if (r.action !== 'append' || !r.message) return d;
      return { ...d, messages: [...d.messages, r.message] }; // 保留 startsRequestSeries
    } catch (e) {
      try {
        memory?.kvSet?.(KV_ERR, JSON.stringify({ at: Date.now(), msg: String(e?.message ?? e).slice(0, 200) }));
      } catch { /* 留证都失败就只能放弃留证 */ }
      return d; // 异常一律退化成"不注入"
    }
  };
}

/** 注册(与全库其它事件同款:`ctx.on` 返回 disposer)。拿不到 ctx.on 就退化为空操作。 */
export function wireSessionLine(ctx, memory, settings, cfg = {}) {
  if (!ctx || typeof ctx.on !== 'function') return () => {};
  try {
    const dispose = ctx.on('agent/pre-step', createSessionLineHandler(memory, settings, cfg));
    return typeof dispose === 'function' ? dispose : () => {};
  } catch (e) {
    console.debug('[dsh-ling] agent/pre-step registration failed', e);
    return () => {};
  }
}

// ---------------------------------------------------------------- 只读探针

/** 探针里的档位标记:`active:false` = **双门已废、不在生效**(主人要一眼看出它还在不在)。
 *  常量仍带出去(有读者按 `tier.ms/turns` 取值),`active` 是新增的判据。 */
function tierProbe() {
  return { ms: TIER_MS_DEFAULT, turns: TIER_TURNS_DEFAULT, active: false, gate: 'D+C' };
}

/** 只读预览:此刻"应该"追加的那一条活行 + 档位状态。**不写任何 kv、不改任何状态。**
 *  调用方(HTTP 面板)每打开一次就会调一次 ⇒ 这里**绝不允许** `kvSet`。
 *  判定口径与 `maybeSessionLine` 逐条对齐(同一张决策表、同一套内容判据),
 *  差别只有一处:预览拿不到 `payload.messages`,所以若 `memory` 上挂着该会话且面上有真人发言,
 *  就用面上末条真人发言当"最新进展";拿不到就只印标题。
 *
 *  ⚠️ turn 的语义(集成要求,别乱改):
 *    · **判定侧(`wouldAppend` / `blocked`)与 turn 完全无关** —— 内容比较用的是"标题 + 最新真人发言首句",
 *      不含轮次号(`progressKey` 只含这两样)⇒ 同一个面/库,传不传 turn 结论一致;
 *    · **正文侧 `text` 依赖 turn**:`turn` 缺失/非法时 `text` 返回 **null**(不是 ''、更不是"第 0 轮"),
 *      `blocked` 仍照常判定 —— 面板路径上没有 turn 来源时,宁可不给正文,也不给假读数(台账 B66)。
 *  @returns {{text:string|null, ordinal:number, wouldAppend:boolean, blocked:string, last:object|null, counts:object|null}}
 */
export function sessionLinePreview(memory, settings, sessionId, { turn } = {}) {
  const sid = String(sessionId || '');
  const out = { text: null, ordinal: 1, wouldAppend: false, blocked: 'absent', last: null, counts: null };
  const turnNum = Number(turn);
  const hasTurn = Number.isFinite(turnNum) && turnNum > 0;
  if (!sid) return { ...out, blocked: 'empty' };
  try {
    // ① 开关(免重启回退):与 handler 同一口径。
    const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
    if (s?.memory?.sessionProgressLine === false) return { ...out, blocked: 'disabled' };
    out.counts = readCounts(memory, sid);
    out.last = safeParse(memory?.kvGet?.(KV_LAST + sid));
    const appendCount = Number(out.last?.appendCount) || Number(out.counts?.append) || 0;
    const ordinal = appendCount + 1;
    out.ordinal = ordinal;
    // ② 扫面(有就扫,没有就按"扫不到"处理)—— 纯内存读,不写盘。
    let scan = { count: 0, latestUser: '', firstUser: '' };
    try {
      const sess = memory?.session || memory?.sessions?.get?.(sid) || null;
      const nodes = sess?.surface?.nodes;
      if (Array.isArray(nodes) && typeof sess.eventAt === 'function') {
        scan = scanSessionLineSurface(nodes, (seq) => sess.eventAt(seq));
      }
    } catch { /* 拿不到会话面不影响预览(只是少了个进展兜底) */ }
    // ③ 标题来自已有概述(缺失时退回面上首条真人发言);进展 = 面上末条真人发言。
    const title = resolveTitle(memory, sid, scan.firstUser);
    const progress = progressLine(scan.latestUser);
    // ④ 判定与 turn **无关**(集成要求)。**HTTP 路径上没有会话面**(实测:`memory.session` 不存在)⇒
    //    这时只能拿"标题"当比较基准(进展看不到就退回上次那条里记的进展)——否则 key 会随"看不见"
    //    而每次都变,面板永远读成"会追加"(哑读数)。
    const lastMd5 = String(out.last?.md5 || '');
    const lastKey = String(out.last?.key || '');
    const lastParts = partsFromLineText(out.last?.text);
    const effTitle = title || lastParts.title;
    const effProgress = progress || lastParts.progress;
    const basis = progress ? 'title+progress' : (scan.latestUser ? 'title+progress' : 'title-only');
    const curKey = effTitle || effProgress ? progressKey(effTitle, effProgress) : '';
    const judgeText = buildSessionLineText({ title: effTitle, progress: effProgress, ordinal, at: Date.now() }); // 无轮次版
    const textUnchanged = scan.count === 1 && !!judgeText && String(scan.lastText) === judgeText;
    const changed = !(textUnchanged || (!!lastKey && !!curKey && curKey === lastKey));
    if (process.env.DSH_LING_DBG) console.log('[pv]', JSON.stringify({ cnt: scan.count, ord: ordinal, basis, lastKey: lastKey.slice(0, 6), curKey: curKey.slice(0, 6), lastParts, effTitle, effProgress, textUnchanged, judge: judgeText }));
    const verdict = decideSessionLine({ onSurface: scan, candidate: judgeText, lastMd5, changed });
    out.blocked = verdict.reason;
    out.wouldAppend = verdict.action === 'append';
    out.basis = basis; // 'title+progress' | 'title-only' —— 面板可据此说明"进展没看到"
    // ⑤ 正文只在**知道轮次**时给:不知道就 null(绝不"第 0 轮"式假读数);判定不受影响。
    out.text = hasTurn ? buildSessionLineText({ title: effTitle, progress: effProgress, turn: turnNum, ordinal, at: Date.now() }) : null;
    return out;
    // ⑤ 正文只在**知道轮次**时给:不知道就 null(绝不"第 0 轮"式假读数);判定不受影响。
    out.text = hasTurn ? buildSessionLineText({ title, progress, turn: turnNum, ordinal, at: Date.now() }) : null;
    return out;
  } catch {
    return { ...out, blocked: 'empty' }; // 任何异常 ⇒ 报"算不出",绝不抛到 HTTP 层
  }
}

/** 某会话的探针视图(挂 `/state`):计数 + 最近一条活行 + 脏记录 + **富字段**(委托 `sessionLinePreview`)。
 *  签名向后兼容:`opts.turn` 可选,不传就只看"上次真追加"的真实读数(不带轮次,text=null)。 */
export function sessionLineState(memory, sessionId, opts = {}) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const read = (k) => { try { return safeParse(memory?.kvGet?.(k)); } catch { return null; }; };
  const base = {
    source: SESSION_LINE_SOURCE,
    tier: tierProbe(),
    counts: readCounts(memory, sid),
    last: read(KV_LAST + sid),
    dupes: read(KV_DUPES + sid),
  };
  let p = { text: null, ordinal: (Number(base.last?.appendCount) || Number(base.counts?.append) || 0) + 1, wouldAppend: false, blocked: 'empty', last: base.last, counts: base.counts };
  try {
    p = sessionLinePreview(safeMemoryOf(memory), opts.settings, sid, { turn: opts.turn });
  } catch { /* 预览任何异常都不该把 /state 打挂 */ }
  return { ...base, preview: p, text: p.text, ordinal: p.ordinal, wouldAppend: p.wouldAppend, blocked: p.blocked, tierActive: false };
}

/** `sessionLinePreview` 的 memory 只读包装:探针路径绝不允许写(双保险,防止将来误用 kvSet)。
 *  ⚠️ `session` / `sessions` 必须用 **getter** 转发 —— 对象字面量里的 `session: memory.session` 是
 *  取值快照,而探针在会话面挂上之前就先构造过这个包装(实测踩过一次:面上有真人发言却读到空进展)。 */
function safeMemoryOf(memory) {
  if (!memory || typeof memory !== 'object') return memory;
  return {
    kvGet: (k) => memory.kvGet?.(k),
    kvList: (p) => memory.kvList?.(p),
    overviewById: (s, c) => memory.overviewById?.(s, c),
    get session() { return memory.session; },
    get sessions() { return memory.sessions; },
  };
}

/** 全局探针视图(挂 `/health`):按会话汇总"追加了几次 / 跳过几次 / 有没有重复"。
 *  目的:验收时**不必离线解 zstd 会话日志**就能回答这三个问题。 */
export function sessionLineProbe(memory, { limit = 8 } = {}) {
  const out = {
    source: SESSION_LINE_SOURCE,
    tier: tierProbe(),
    err: safeParse(memory?.kvGet?.(KV_ERR)),
    totals: { sessions: 0, append: 0, skippedTier: 0, skippedSame: 0, dupes: 0 },
    sessions: [],
  };
  try {
    const counts = new Map();
    const lasts = new Map();
    const dupes = new Map();
    for (const row of memory?.kvList?.(KV_COUNTS) || []) counts.set(String(row.key).slice(KV_COUNTS.length), safeParse(row.value));
    for (const row of memory?.kvList?.(KV_LAST) || []) lasts.set(String(row.key).slice(KV_LAST.length), safeParse(row.value));
    for (const row of memory?.kvList?.(KV_DUPES) || []) dupes.set(String(row.key).slice(KV_DUPES.length), safeParse(row.value));
    const ids = [...new Set([...counts.keys(), ...lasts.keys(), ...dupes.keys()])];
    const rows = ids.map((sid) => {
      const c = counts.get(sid) || blankCounts();
      const l = lasts.get(sid) || null;
      const d = dupes.get(sid) || null;
      out.totals.sessions += 1;
      out.totals.append += Number(c.append) || 0;
      out.totals.skippedTier += Number(c.skippedTier) || 0;
      out.totals.skippedSame += Number(c.skippedSame) || 0;
      out.totals.dupes += Number(c.dupes) || 0;
      return {
        sessionId: sid,
        append: Number(c.append) || 0,
        skippedTier: Number(c.skippedTier) || 0,
        skippedSame: Number(c.skippedSame) || 0,
        dupes: Number(c.dupes) || 0,
        last: l ? { at: l.at ?? null, turn: l.turn ?? null, seq: l.seq ?? null, md5: l.md5 ?? null, key: l.key ?? null, chars: l.chars ?? null, text: l.text ?? '' } : null,
        dupesInfo: d,
      };
    });
    rows.sort((a, b) => (Number(b.last?.at) || 0) - (Number(a.last?.at) || 0));
    out.sessions = rows.slice(0, Math.max(1, Number(limit) || 8));
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}
