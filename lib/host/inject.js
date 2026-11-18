// dsh-ling host — system-prompt injection (DESIGN §4.2/4.3, REPORT-02).
// One global section; text() is evaluated at every model-step assembly and is
// a PURE READ of the session's frozen snapshot:
//   - running sessions: always return the frozen snapshot (D4 — never mutate,
//     never rebuild mid-run);
//   - idle sessions with a stale snapshot: rebuild lazily (one-time invalidation);
//   - subagent/child/unknown sessions: return '' (R5).
import { svc, pick, neutralizeMustache, sessionKind } from './util.js';
import { wellFormed } from './rawlog.js'; // 1.7.1 F4 闭环:注入面最终出口
import { buildSnapshotText, firstUserText } from './snapshot.js';
import { currentMode } from './mode.js';
import { keywordsFrom } from './inject-common.js';
import { timeAnchorDate, timeAnchorLive } from './clock.js';
import { awayFromSettings } from './away.js'; // 1.7.3 夜 F 类:水位与渲染必须同源判据
import { markDelivered } from './presence-bus.js'; // P4B MF1:投递即消费(见 advanceLogWatermark)

export const SECTION_NAME = 'dsh-ling.memory';
export const SECTION_ORDER = 1500; // persona(order 0)之后、指令之前
/** 时间锚 · context 侧(2026-09-23 搬迁):时段 + 间隔挂在**末条消息**上。
 *  平台(context)只在本轮文本真的不同时才产出新快照,而 section 改一个字就作废整个前缀。
 *  order 取 300:平台保留位只占 110/115/120,留出可读间隔。 */
export const CLOCK_CONTEXT_NAME = 'dsh-ling.clock';
export const CLOCK_CONTEXT_ORDER = 300;

// ── 1.8.0 N(自知通知)· presence 的第一个内部消费者 ─────────────────────────────
// 形态(DESIGN §3.1/§3.2):只在「上次开口之后真有变更」时,在时间锚**之后**追加**最多一行**;
//   无变更 ⇒ 一个字符都不多 —— 与改前的 context 文本**逐字节相同**(不 extra 换行、不 extra 段)。
// 计数口径:按 `kind` 聚合**条数**(一条 Change = 1 次);条数为 0 的 kind 不出现;
//   数字全部来自 presence 侧的变更流,本文件**不写死**任何计数。
// 消费语义(DESIGN §3.4-3 · 复审 G1 已改):清零点 = **这行文本的产出点** —— context 回调把
//   文本交给宿主的那一刻(`clearNotice`)。**不再**挂在 section 的 `advanceLogWatermark` 上:
//   那是"清在 section 路径、产在 context 路径",宿主若先渲染 section,整行**永不出现**(见下方注释)。
//   **不新增**任何"只读不推进"的游标;同一轮 context 多次渲染 ⇒ 只有第一次带这行(投递即消费)。
// 出口纪律(DESIGN §3.4-4):presence 侧任何异常(取服务 / watch / recent / 计数)**只能让这一行消失**,
//   不许让 context 文本或整段注入失败 —— `text` 回调在宿主侧没有 try/catch(见上方 C-03 注释)。
const NOTICE_GLOBAL_KEY = '*';   // 与 presence-bus 的全局槽同义:无 scope = 影响所有会话
const NOTICE_MAX_SESSIONS = 512; // 账本上限:长期进程里会话再多也不无限长
/** 聚合维度固定这 4 个(presence `PRESENCE_KINDS`),顺序即行内顺序 —— 不逐条展开、不随机序。 */
const NOTICE_KIND_ORDER = Object.freeze(['persona', 'memory', 'tree', 'settings']);
const NOTICE_KIND_LABELS = Object.freeze({
  persona: '人格', memory: '记忆', tree: '记忆树', settings: '设置',
});

/** 待通知计数:`key -> Map<kind, 条数>`;key = `s:<sessionId>`(该会话)或 `*`(全局)。 */
let noticeTally = new Map();
/** 当前绑定的 presence 服务对象 + 退订函数(换绑 ⇒ 换账本,旧服务的未消费计数不串到新服务)。 */
let noticeBound = null;
let noticeOff = null;

/** 把一条 Change 记进账本。永不抛(记不进去 = 少报一条,绝不影响注入)。 */
function tallyNotice(into, change) {
  try {
    if (!into) return;
    const kind = change && typeof change.kind === 'string' ? change.kind : '';
    // 词表外的 kind 不数:Change 的内容红线是"只含结构化事实",行里也只出现我们自己写的词
    if (!Object.prototype.hasOwnProperty.call(NOTICE_KIND_LABELS, kind)) return;
    const rawSid = change?.scope?.sessionId;
    // key 的口径与 presence-bus 的 normalizeChange/markDelivered 对齐(trim + 截断 128)
    const key = typeof rawSid === 'string' && rawSid.trim()
      ? 's:' + rawSid.trim().slice(0, 128)
      : NOTICE_GLOBAL_KEY;
    let bucket = into.get(key);
    if (!bucket) {
      if (into.size >= NOTICE_MAX_SESSIONS) {
        const oldest = into.keys().next();
        if (!oldest.done) into.delete(oldest.value);
      }
      bucket = new Map();
      into.set(key, bucket);
    }
    bucket.set(kind, (bucket.get(kind) || 0) + 1);
  } catch { /* 少报一条,不影响注入 */ }
}

/** 惰性绑定 `presence.watch`。**不能在注册时绑定**:`index.js` 先注册注入面(:143)、
 *  后 provide presence(:161)⇒ 注册那一刻 `ctx.get` 必然拿不到。
 *  订阅成功才把新账本挂上去;任何异常 ⇒ 返回 null(= 这一行不出现,注入照旧)。 */
function bindNoticeWatch(ctx) {
  try {
    const presence = svc(ctx, 'dsh-ling/presence');
    if (!presence || typeof presence.watch !== 'function') return null;
    if (noticeBound === presence) return presence;
    // 换绑:先退订旧服务,再建**新账本**(失败不留半截账)
    const prevOff = noticeOff;
    noticeOff = null;
    noticeBound = null;
    if (typeof prevOff === 'function') { try { prevOff(); } catch { /* 退订失败不影响其余 */ } }
    const next = new Map();
    let off = null;
    try {
      // 补看订阅前的窗口:首次求值之前发生的变更只在 `recent()` 缓冲里(它**不消费** pending)
      const rows = typeof presence.recent === 'function' ? presence.recent() : [];
      if (Array.isArray(rows)) for (const c of rows) tallyNotice(next, c);
      off = presence.watch((change) => tallyNotice(noticeTally, change));
    } catch {
      if (typeof off === 'function') { try { off(); } catch { /* ignore */ } }
      return null; // presence 抛错 ⇒ [自知] 不出现,clock 文本与注入不受影响
    }
    noticeTally = next;
    noticeOff = typeof off === 'function' ? off : null;
    noticeBound = presence;
    return presence;
  } catch {
    return null;
  }
}

/** 投递即消费:与 `markDelivered(sessionId)` / `markDelivered()` **同一组 key** 清零
 *  (该会话那一格 + 全局槽)。**调用点只有一个**:context 回调把 `[自知]` 那行交给宿主之后
 *  —— 这行文本真的随本次组装进入模型,才叫"投递"(section 路径上的 `advanceLogWatermark`
 *  与这行文本无关,复审 G1)。不抛;失败只导致下次多报一遍。 */
function clearNotice(sessionId) {
  try {
    if (!sessionId) return;
    noticeTally.delete('s:' + String(sessionId).trim().slice(0, 128));
    noticeTally.delete(NOTICE_GLOBAL_KEY);
  } catch { /* 记账失败不影响注入 */ }
}

/** 本会话 + 全局的待通知计数 ⇒ **一行**文本;无变更 / 取不到 presence / 任何异常 ⇒ `''`。 */
function noticeLineFor(ctx, sessionId) {
  try {
    if (!bindNoticeWatch(ctx)) return '';
    const sid = String(sessionId).trim().slice(0, 128);
    const bucket = new Map();
    for (const key of [NOTICE_GLOBAL_KEY, 's:' + sid]) { // 全局变更(影响所有会话)+ 本会话那一格
      const src = noticeTally.get(key);
      if (!src) continue;
      for (const [kind, n] of src) bucket.set(kind, (bucket.get(kind) || 0) + (Number(n) || 0));
    }
    const parts = [];
    let total = 0;
    for (const kind of NOTICE_KIND_ORDER) {
      const n = bucket.get(kind) || 0;
      if (n <= 0) continue; // 条数为 0 的 kind 不出现
      parts.push(`${NOTICE_KIND_LABELS[kind]}改了 ${n} 次`);
      total += n;
    }
    if (!parts.length) return '';
    // 措辞照 DESIGN §3.1 逐字;末尾「要细看用 state()/recent()」半句删掉 —— 模型在对话里没有
    // 这两个工具(它们只活在宿主 ctx 上),留着等于教它调用不存在的东西(见交付单偏差一节)。
    return `[自知] 上次开口之后：${parts.join('、')}（共 ${total} 条）。`;
  } catch {
    return ''; // presence 侧任何异常只让这一行消失
  }
}

function agentOf(assembly) {
  return pick(() => assembly?.agent, () => assembly?.scope?.agent, () => assembly?.ctx?.agent);
}

/** 导出给 `session-line.js`(E0)复用同一套取值口径 —— 只加 `export`,逻辑逐字未动。 */
export function sessionIdOfAgent(agent) {
  return pick(
    () => agent?.session?.id,
    () => agent?.session?.header?.id,
    () => agent?.sessionId,
    () => agent?.id,
  );
}

/** 会话种类(D9-a):'top' | 'fork' | 'subagent' | 'unknown'。
 *  旧版把 fork 与 subagent 一并当 child 丢弃 ⇒ 分叉会话记忆真空;
 *  现在**分叉会话照常注入**(读血缘链),只有子代理与"取不到 header"仍保守拒绝。 */
export function kindOfAgent(agent) {
  const header = pick(
    () => agent?.session?.header,
    () => agent?.header,
  );
  return sessionKind(header);
}

/** 能否注入(D9-a):顶层与分叉会话可以,子代理/未知不可以。
 *  ⚠️ 入参是**种类字符串**(不是 agent):E0 的 `agent/pre-step` 是全局注册,
 *  按 `dsh-scope/lib/invariant.js:17` 会收到**所有 agent(含子代理)**,故必须自己过这道闸。 */
export function canInject(kind) {
  return kind === 'top' || kind === 'fork';
}

/** B#9(2026-09-22 审计):消费注入感知水位 —— **只在真正要把文本送进模型时调用**。
 *  渲染(buildSnapshotText)本身不推进:它也会被"只重建、未开口"的路径调用
 *  (invalidateSession / refreshIdleSnapshot),在那里推进会把主人刚改的东西
 *  标记成已读,等真正开口时反而看不到。水位按会话、单调不回退。
 *
 *  ── B3(1.5.2):入参从一个 maxId 拆成三个,各管一件事 ────────────────────────
 *   · `maxId`         branch_log **全表最大 id** ⇒ 只喂 `branch_log_wm.last`。
 *                     它跟"示人没示人"无关:一次只渲染 5 行也照旧推到全表最新,这是**有意的**
 *                     (复盘模式的退出判据,消费点 memory.branchLogPending,本版逐行未动)。
 *   · `shownMaxId`    本轮**真正渲染过**的最大 id ⇒ 推按会话水位 + 全局 announced。
 *                     B3-2 的病根就是这里以前喂的是 maxId:一次播报把中间 114 条标成已读。
 *   · `retiredMaxId`  本轮按时间窗"计数式处置"的最大 id(§2 老改动只计数不展开)⇒ 推 retired。
 *                     它**不算已示人**,只让同一批老账不被每轮重算(否则水位永不前进)。
 *  `announceOn=false`(§3 开关关闭)⇒ 只推 `.last`,两个"已示人/已处置"水位一律不动。
 *  **开关只管"渲染",不管"交代记账"**:`.last` 是**复盘模式的退出判据**,不是"已示人"判据 ——
 *  关了它,侧栏会永远显示"还有 N 笔没说给器灵"、复盘模式退不出去;而 `.last` **不参与播报下界**
 *  (下界只取 会话/announced/retired 三者更大者)⇒ 它照走**不会**造成"关着开着丢一段内容":
 *  那条改动仍在候选里,开关一开照样播。
 *  回归:tests/tree.test.mjs 第 9-5 条(关闭 ⇒ 不播报、两个新水位不动、`.last` 照走、重开仍看得见)。
 *  字面量与 memory.js 的 BRANCH_LOG_WM_ANNOUNCED / BRANCH_LOG_WM_RETIRED 一致。 */
function advanceLogWatermark(memory, sessionId, maxId, shownMaxId, retiredMaxId, announceOn = true) {
  // ── P4B MF1(2026-11-11):**投递即消费** `dsh-ling/presence` 的 pending ────────────
  // 这个函数是"文本真的要被送进模型"的唯一入口(4 个调用点都在 renderMemorySection 的投递分支上,
  // 且 `invalidateSession` / `refreshIdleSnapshot` 那些"只重建、未开口"的路径**不**调它)⇒
  // 契约 §3.2「pending = 下次开口就会被注入的那些」在这里才真正成立。
  // 放在 `maxId` 早退**之前**:没有新的 branch_log 也照样是一次投递(那条早期写法会让
  // "只有挡位/人格变更、树没动"的会话永远清不掉 —— 正是 MF1 报的那个只增不减)。
  // `markDelivered` 永不抛,外面仍包一层 try:注入路径不许因为记账失败而少一段文本。
  try {
    if (sessionId) {
      markDelivered(String(sessionId)); // 该会话那一格
      markDelivered();                  // 全局槽:这次投递的文本里也含"影响所有会话"的变更
      // ── 1.8.0 N 复审 G1(fix,m3-fix):**自知账本不在这里清** ──────────────────────────
      // 这里曾经清过一次(`clearNotice`),那正是 G1:本函数挂在 section(system 前缀)的 4 个
      //   投递分支上,而 `[自知]` 那行文本只在 context 回调里产出 ⇒ 宿主若「先 section、后
      //   context」(前缀先于末条消息,是常见形态),本轮 section 一渲染就把账本清空,context
      //   随后读到空账本 ⇒ 整行**永不出现**,而当时 62 条测试全绿(套件自选了次序)。
      // 清零点必须与那行文本的产出点同源 ⇒ context 回调里的 `clearNotice(sidText)`。
    }
  } catch { /* 记账失败不影响注入 */ }
  const v = Number(maxId);
  if (!sessionId || !Number.isFinite(v) || v <= 0) return;
  // 旧快照(1.5.1 冻结在内存里的)没有 shownMaxId ⇒ 按 0 处理:**宁可下一轮重播一遍,
  // 也不把没示人的内容标成已读**(与 B3 的取向一致)。`.last` 不受影响。
  const seen = announceOn ? Number(shownMaxId) || 0 : 0;
  const retired = announceOn ? Number(retiredMaxId) || 0 : 0;
  try {
    if (seen > 0) {
      const k = 'branch_log_wm.' + String(sessionId);
      if (seen > Number(memory.kvGet(k) || 0)) memory.kvSet(k, String(seen));
      // 全局"已示人"边界(B3-1):别的会话已经看过的,新会话不再重播。
      if (seen > Number(memory.kvGet('branch_log_wm.announced') || 0)) memory.kvSet('branch_log_wm.announced', String(seen));
    }
    if (retired > 0 && retired > Number(memory.kvGet('branch_log_wm.retired') || 0)) {
      memory.kvSet('branch_log_wm.retired', String(retired));
    }
    // 复盘守门(2026-09-22 用户:「动记忆树不能是随意的,应该是慎重严肃的」):
    // 另记一个**全局最后同步**水位,回答"自器灵上次开口以来累积了多少笔改动还没交代"
    // (memory.branchLogPending 读它)。与会话水位互补 —— 会话水位管"这个会话看到什么",
    // 本键管"是否还没跟器灵交代过"。
    if (v > Number(memory.kvGet('branch_log_wm.last') || 0)) memory.kvSet('branch_log_wm.last', String(v));
  } catch { /* 推进失败仅导致下次重复提示,不影响注入 */ }
}

/** 注册记忆注入段(order 1500)+ 时间锚 context。
 *
 *  ── F5(1.7 修复批次,2026-10-15)────────────────────────────────────────────
 *  第 5 参是**逃生开关**:`cordis.patch.yml:16` 早就承诺 `injectEnabled: false` 能关掉注入,
 *  但在这次修之前全仓 `cfg.injectEnabled` **零处读** ⇒ 用户以为关掉了、实际照注(静默失效)。
 *  现在关到底 ⇒ **一段都不注册**(section 与 clock context 都不挂),留痕仍由
 *  index.js 的 `inject_enabled_config` 负责。默认(true / 不传)行为**逐字不变**。
 *  ⚠️ 这一道只管**记忆段**;人格段走 `settings.persona.enabled`(persona.js:166),两者并列。
 *  回归:tests/injectlog.test.mjs 第 5 节(关到底零注册 + 默认行为正对照 + 接线判据)。 */
export function registerMemorySection(ctx, gate, memory, settings, { enabled = true } = {}) {
  if (enabled === false) {
    // ── 1.7.3 E 类审计(2026-10-27):关着的时候也必须**留下可信读数** ────────────────
    // 此前这里裸 `return`,不写 `inject.section_registered` ⇒ 上一轮启动留下的 '1' 会一直被
    //   `GET /inject` 当"段注册实况"回出去(关了却报"已注册")。关到底是**事实**,要能读出来。
    memory.kvSet('inject.section_registered', '0:inject-disabled');
    return () => {};
  }
  const sp = svc(ctx, 'systemPrompt');
  if (!sp || typeof sp.section !== 'function') {
    console.debug('[dsh-ling] systemPrompt service unavailable; injection disabled');
    memory.kvSet('inject.section_registered', '0:no-service');
    return () => {};
  }
  let registered = false;
  try {
    const ret = sp.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      complete: false,
      text: (assembly) => renderMemorySection(assembly, gate, memory, settings),
    });
    registered = true;
    memory.kvSet('inject.section_registered', '1');
    void ret;
  } catch (e) {
    console.debug('[dsh-ling] systemPrompt.section failed', e);
    memory.kvSet('inject.section_registered', '0:' + String(e?.message ?? e).slice(0, 120));
  }
  // ── 时间锚 · context 侧(2026-09-23) ────────────────────────────────
  // 时段与间隔挂末条消息,不再进 system 前缀。旧写法每请求一次前缀全废
  // (实测回合内断裂 174 次 = 未缓存 token 43.96%);档位化后一天最多变几次。
  let clockRegistered = false;
  try {
    const ret2 = sp.context({
      name: CLOCK_CONTEXT_NAME,
      order: CLOCK_CONTEXT_ORDER,
      // ⚠️ C-03(1.5.1 红蓝对抗,2026-09-25):时间锚搬到 context 侧时**必须同样中和**。
      //   锚里的称呼来自 `persona.userTitle` —— 那是**用户可编辑的自由文本**,而且
      //   `corpus-suggest.js` 会从真实对话里挖出候选、经建议通道采纳写进 persona。
      //   一旦它含 `{{x}}`,宿主 renderPrompt 的 interpolate 会**直接抛异常**,
      //   而 agent-loop 调用处无 try/catch ⇒ **该会话每一步模型调用都失败**。
      //   这正是 1.3.1 拆掉的那颗雷(S12)的同类面:section 侧一直有中和
      //   (见 renderMemorySection 的 `neutralizeMustache(anchor)`),搬迁时漏了这一处。
      // 1.7.1(delta 复审):这是**独立于 snapshot 的第二条出口** —— context 文本也会进模型上下文,
      //   只中和 mustache 不够;时间锚里的称呼/日期同样是往外送的文本,照样过 wellFormed。
      // ── T⑤(1.8.0 时间感知):**子代理闸**落在这里,不在 clock.js ─────────────────────
      // 背景(PLAN §3):clock 是**另一条出口**,此前没有任何 `canInject` 判断 ⇒ 只活几十秒的
      //   子代理会话也会拿到「[本场] 已持续 20 天」,那是一句纯粹的假话。
      // 判据(C8 顺序 `[现在] → [本场] → [跨天]`,段间 `\n`,由 clock.js 统一拼):
      //   · 顶层 / 分叉(canInject)⇒ 传 sessionId ⇒ 三段都有;
      //   · 子代理 / 未知种类 ⇒ 传空 sessionId ⇒ **只出 `[现在]`**;
      //   · 取不到 sessionId ⇒ 同样只出 `[现在]`,**不抛**(验收 11)。
      // 闸只能在 inject.js:clock.js 若 import 本文件的 `canInject` 会成
      //   `inject→clock→inject` 环(clock.js 只 import persona.js)。
      // 顺序与空行不在这里重排:段落数组 + join('\n') 由 `timeAnchorLive` 按契约产出,
      //   出口仍**整体**过一次 `neutralizeMustache` + `wellFormed`(与改前同一处、同一次)。
      text: (assembly) => {
        const agent = agentOf(assembly);
        const sid = canInject(kindOfAgent(agent)) ? sessionIdOfAgent(agent) : undefined;
        const sidText = sid ? String(sid) : '';
        // ── 1.8.0 N(自知通知):C8 第 4 段,接在**时间锚之后**,段间仍是**单个** `\n` ──────
        // 子代理/未知种类/取不到 sessionId ⇒ sidText 为空 ⇒ 既没有 [本场]/[跨天],也没有 [自知]
        //   (与 T⑤ 的闸同源:自知同样是"这一场"的事实,子代理没有"上次开口")。
        // notice 为空(无变更 / presence 不可用 / presence 侧任何异常)⇒ 下面的表达式与改前
        //   **逐字相同**:`wellFormed(neutralizeMustache(timeAnchorLive(...)))`,不多一个字符。
        const notice = sidText ? noticeLineFor(ctx, sidText) : '';
        const base = timeAnchorLive(memory, settings, { sessionId: sidText });
        // ── 消费语义(DESIGN §3.4-3 · 复审 G1 改):清零点 = **这行文本的产出点** ────────────
        // 就绪的文本马上随本次 context 组装进入模型 ⇒ 此刻清零,与宿主调用 section/context 的
        //   **次序无关**(section 先渲染也好、根本不渲染也好,都不会提前吃掉这一行)。
        // 只在真有这行时清(notice 为空 ⇒ 没有可消费的东西,不碰账本)。
        // 显式代价:同一轮若宿主多次调用 context.text(),只有第一次带这行 —— 这是"投递即消费"
        //   在 context 侧的定义;换次序的收益(整行不再可能永不出现)远大于此。
        if (notice) clearNotice(sidText);
        return wellFormed(neutralizeMustache(notice ? base + '\n' + notice : base));
      },
    });
    clockRegistered = true;
    memory.kvSet('inject.clock_ctx_registered', '1');
    void ret2;
  } catch (e) {
    console.debug('[dsh-ling] systemPrompt.context failed', e);
    memory.kvSet('inject.clock_ctx_registered', '0:' + String(e?.message ?? e).slice(0, 120));
  }
  return () => {
    if (registered) {
      try {
        sp.section?.({ name: SECTION_NAME, order: SECTION_ORDER, complete: false, text: '' });
      } catch {}
      registered = false;
    }
    if (clockRegistered) {
      try {
        // 同名重注册即覆盖:与 section 的注销形态一致
        sp.context?.({ name: CLOCK_CONTEXT_NAME, order: CLOCK_CONTEXT_ORDER, text: '' });
      } catch {}
      clockRegistered = false;
    }
    // 1.8.0 N:拆注入面时卸掉自知订阅。只卸"本 ctx 现在取到的"那一份 —— 多实例/热重载下
    // 不误退别人的订阅。失败不影响其余拆卸。
    try {
      if (noticeBound && noticeBound === svc(ctx, 'dsh-ling/presence')) {
        if (typeof noticeOff === 'function') noticeOff();
        noticeOff = null;
        noticeBound = null;
        noticeTally = new Map();
      }
    } catch { /* 卸载失败不影响注入 */ }
  };
}

/** 注入面文本渲染(导出供回归断言直接调用,2026-09-23)。
 *  导出是刻意的:`{{…}}` 与时间锚两处病灶都靠"跨分钟取样"的断言钉住,
 *  没有导出就只能靠端到端间接验证。 */
export function renderMemorySection(assembly, gate, memory, settings) {
  try {
    if (!assembly) return '';
    const agent = agentOf(assembly);
    const sessionId = agent ? sessionIdOfAgent(agent) : undefined;
    if (!sessionId) return '';
    if (!canInject(kindOfAgent(agent))) return ''; // 子代理/未知不注入(R5);D9-a:分叉会话注入血缘链
    // 时间锚 · system 侧(2026-09-23 搬迁):**只有日期 + 星期**(-+纪念日)。
    // 时分/时段/间隔已移出 —— 它们分钟级抖动,会让整段会话前缀每请求作废一次。
    // 时段与间隔现在走 systemPrompt.context()(见 registerMemorySection 的 clock 段)。
    const anchor = timeAnchorDate(memory, settings);
    // 注入面出口 ②(最终侧,2026-09-18):时间锚不经快照,未来新增的 part 也只走这里,
    // 故在最外层再中和一次(幂等)。①+② 合计覆盖全部注入文本。
    const withAnchor = (text) => {
      const body = wellFormed(neutralizeMustache(text || ''));
      if (!anchor) return body;
      return wellFormed((body ? body + '\n\n' : '') + neutralizeMustache(anchor));
    };
    const snap = gate.snapshotOf(sessionId);
    // §3 独立开关(1.5.2):只管"树改动播报"。关闭时**不推进任何"已示人"水位** ——
    // 否则关着的那段时间里,这段内容会被标成已读,再打开就永远看不到它了。
    // ⚠️ 例外且**有意**:`branch_log_wm.last`(复盘退出判据,侧栏 GET /branch-log/pending 拦门)
    //    照旧推进 —— 它记的是"还没跟器灵交代过多少笔",不是"示人没示人",停推进会卡死复盘退出。
    const announceOn = (() => {
      try {
        const s2 = settings.get();
        // ── 1.7.3(2026-10-27,红队 B 路抓到)────────────────────────────────────
        // 原来只判 `branchLogEnabled`。但快照侧的渲染早已被 `inject.memoryEnabled` 一起闸住
        // (snapshot.js 里那段 push 现在要求 memoryEnabled)—— 而水位推进只认这里的 announceOn
        // ⇒ 面板关掉「记忆与图书馆」期间,树改动**一个字都没示人**、shown/retired 却被照旧消费;
        // 等他把开关打回来,那批改动已经"看过"了,**永远看不到** —— 静默吞内容,正是本版要治的病。
        // 判据:两道闸任何一道关着 ⇒ 都不推进"已示人/已处置";`.last` 仍照走(它是复盘退出判据,
        // 停推进会卡死复盘模式的退出 —— 与 §3 开关同一取向:只管渲染,不管交代记账)。
        // 1.7.3 夜 F 类第三轮(盲审 F6):**暂离也是"没示人"** —— 快照侧此时不渲染播报,
        //   若水位照推,那批改动就永远看不到。判据与渲染侧同源(awayFromSettings)。
        if (awayFromSettings(s2)) return false;
        return s2?.memory?.branchLogEnabled !== false && s2?.inject?.memoryEnabled !== false;
      } catch { return true; }
    })();
    if (!snap) {
      // 首轮组装可能先于/晚于 session-start 事件:空闲时补建,运行时不建(D4)
      if (gate.isRunning(sessionId)) return withAnchor('');
      const mode = currentMode(memory, settings, sessionId);
      const kw = keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw, bumpHits: true });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      advanceLogWatermark(memory, sessionId, built.logMaxId, built.logShownMaxId, built.logRetiredMaxId, announceOn); // B#9:定稿即消费
      return withAnchor(built.text);
    }
    // 冻结:running 一律返回既有快照(即使 stale);时间锚仍实时
    if (gate.isRunning(sessionId)) {
      advanceLogWatermark(memory, sessionId, snap.logMaxId, snap.logShownMaxId, snap.logRetiredMaxId, announceOn); // B#9:冻结快照投递即消费
      return withAnchor(snap.text || '');
    }
    // idle + stale → 懒重建(一次性失效);重建必须带上首次定稿时的关键词,否则排序口径会变
    if (snap.stale) {
      const mode = currentMode(memory, settings, sessionId);
      const kw = Array.isArray(snap.keywords) ? snap.keywords : keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      advanceLogWatermark(memory, sessionId, built.logMaxId, built.logShownMaxId, built.logRetiredMaxId, announceOn); // B#9:重建后投递即消费
      return withAnchor(built.text);
    }
    advanceLogWatermark(memory, sessionId, snap.logMaxId, snap.logShownMaxId, snap.logRetiredMaxId, announceOn); // B#9:命中缓存快照投递即消费
    return withAnchor(snap.text || '');
  } catch (e) {
    console.debug('[dsh-ling] textForAssembly failed', e);
    return '';
  }
}

/** 供 lifecycle:agent/session-start 时为新顶层会话定稿快照。 */
export function freezeSnapshotForSession(gate, memory, settings, agent) {
  const sessionId = agent ? sessionIdOfAgent(agent) : undefined;
  if (!sessionId) return null;
  const kind = kindOfAgent(agent);
  if (!canInject(kind)) return null;
  const mode = currentMode(memory, settings, sessionId);
  // 关键词上下文必须随快照存下来:重建时若丢失,L1 的排序口径会悄悄换一套
  // (关键词加成最高 +1.8,远大于热度项 0.3~0.5)
  const kw = keywordsFrom(firstUserText(agent));
  const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw, bumpHits: true });
  gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
  return { sessionId, mode, chars: built.text.length };
}

/** 人格/模式变更后的失效入口:运行中仅标记 stale(注入面不变),空闲立即重建。 */
export function invalidateSession(gate, memory, settings, sessionId) {
  if (!sessionId) return { invalidated: false };
  const snap = gate.snapshotOf(sessionId);
  if (gate.isRunning(sessionId)) {
    gate.markSnapStale(sessionId);
    return { invalidated: false, queued: true, running: true };
  }
  const mode = currentMode(memory, settings, sessionId);
  const kw = Array.isArray(snap?.keywords) ? snap.keywords : [];
  const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw });
  gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
  return { invalidated: true, mode };
}

// ---------------- B:空闲边界刷新(长会话在 idle 时把 L1 追平到最新) ----------------
const REFRESH_KEY = 'snap.refresh:';

function readRefreshRecord(memory, sessionId) {
  try {
    const raw = memory.kvGet(REFRESH_KEY + sessionId);
    if (!raw) return { count: 0, lastAt: 0 };
    const v = JSON.parse(String(raw));
    return { count: Number(v?.count) || 0, lastAt: Number(v?.lastAt) || 0 };
  } catch {
    return { count: 0, lastAt: 0 };
  }
}

/** 面板/状态接口用:该会话在空闲边界刷新过几次、最近一次何时。 */
export function refreshStats(memory, sessionId) {
  return sessionId ? readRefreshRecord(memory, sessionId) : { count: 0, lastAt: 0 };
}

/**
 * 空闲边界刷新:仅当「快照存在 + 会话空闲 + memory_version 变了 + 距上次刷新 ≥ 最小间隔」时重建。
 * 只会在 running→idle 时被调用,因此 D4 不变量(运行中注入面逐字节不变)天然保持。
 *
 * @param {object} opts
 *   - now:注入时间(测试用)
 *   - summarize:可选,刷新前先跑一次"本会话增量概述"(纯文本、零 LLM),否则追平的是上一轮概述
 *   - minIntervalMin:覆盖最小间隔(测试用)
 * @returns {{refreshed:boolean, reason:string, count?:number, chars?:number, lastAt?:number}}
 */
export function refreshIdleSnapshot(gate, memory, settings, sessionId, { now = Date.now(), summarize = null, minIntervalMin = null } = {}) {
  try {
    if (!sessionId) return { refreshed: false, reason: 'no-session' };
    const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
    const cfg = s.memory || {};
    if (cfg.idleRefresh === false) return { refreshed: false, reason: 'disabled' };
    if (gate.isRunning(sessionId)) return { refreshed: false, reason: 'running' };
    const snap = gate.snapshotOf(sessionId);
    if (!snap || !snap.text) return { refreshed: false, reason: 'no-snapshot' };
    // ① 先让概述器落库(它会 bump memory_version),否则下面比对的是上一轮版本
    if (typeof summarize === 'function') {
      try {
        summarize();
      } catch (e) {
        console.debug('[dsh-ling] idle summarize failed', e);
      }
    }
    const cur = String(memory.kvGet('memory_version') || '0');
    if (String(snap.memoryVersion || '0') === cur) return { refreshed: false, reason: 'unchanged' };
    const minMs = Math.max(0, Number(minIntervalMin ?? cfg.idleRefreshMinIntervalMin ?? 10)) * 60000;
    const rec = readRefreshRecord(memory, sessionId);
    if (minMs > 0 && rec.lastAt && now - rec.lastAt < minMs) {
      return { refreshed: false, reason: 'throttled', count: rec.count, lastAt: rec.lastAt };
    }
    const mode = currentMode(memory, settings, sessionId);
    const kw = Array.isArray(snap.keywords) ? snap.keywords : [];
    const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw, now });
    // ② 内容判等:文本没变 → 不计数(避免无谓的前缀失效),但仍刷新快照元信息
    if (built.text === snap.text) {
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      return { refreshed: false, reason: 'same-text', count: rec.count };
    }
    gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
    const next = { count: rec.count + 1, lastAt: now };
    memory.kvSet(REFRESH_KEY + sessionId, JSON.stringify(next));
    return { refreshed: true, reason: 'rebuilt', count: next.count, chars: built.text.length };
  } catch (e) {
    console.debug('[dsh-ling] refreshIdleSnapshot failed', e);
    return { refreshed: false, reason: 'error' };
  }
}
