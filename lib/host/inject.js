// dsh-ling host — system-prompt injection (DESIGN §4.2/4.3, REPORT-02).
// One global section; text() is evaluated at every model-step assembly and is
// a PURE READ of the session's frozen snapshot:
//   - running sessions: always return the frozen snapshot (D4 — never mutate,
//     never rebuild mid-run);
//   - idle sessions with a stale snapshot: rebuild lazily (one-time invalidation);
//   - subagent/child/unknown sessions: return '' (R5).
import { svc, pick, neutralizeMustache, sessionKind } from './util.js';
import { buildSnapshotText, firstUserText } from './snapshot.js';
import { currentMode } from './mode.js';
import { keywordsFrom } from './inject-common.js';
import { timeAnchor } from './clock.js';

export const SECTION_NAME = 'dsh-ling.memory';
export const SECTION_ORDER = 1500; // persona(order 0)之后、指令之前

function agentOf(assembly) {
  return pick(() => assembly?.agent, () => assembly?.scope?.agent, () => assembly?.ctx?.agent);
}

function sessionIdOfAgent(agent) {
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
function kindOfAgent(agent) {
  const header = pick(
    () => agent?.session?.header,
    () => agent?.header,
  );
  return sessionKind(header);
}

/** 能否注入(D9-a):顶层与分叉会话可以,子代理/未知不可以。 */
function canInject(kind) {
  return kind === 'top' || kind === 'fork';
}

/** B#9(2026-09-22 审计):消费注入感知水位 —— **只在真正要把文本送进模型时调用**。
 *  渲染(buildSnapshotText)本身不推进:它也会被"只重建、未开口"的路径调用
 *  (invalidateSession / refreshIdleSnapshot),在那里推进会把主人刚改的东西
 *  标记成已读,等真正开口时反而看不到。水位按会话、单调不回退。 */
function advanceLogWatermark(memory, sessionId, maxId) {
  const v = Number(maxId);
  if (!sessionId || !Number.isFinite(v) || v <= 0) return;
  try {
    const k = 'branch_log_wm.' + String(sessionId);
    if (v > Number(memory.kvGet(k) || 0)) memory.kvSet(k, String(v));
    // 复盘守门(2026-09-22 用户:「动记忆树不能是随意的,应该是慎重严肃的」):
    // 另记一个**全局最后同步**水位,回答"自器灵上次开口以来累积了多少笔改动还没交代"
    // (memory.branchLogPending 读它)。与会话水位互补 —— 会话水位管"这个会话看到什么",
    // 本键管"是否还没跟器灵交代过"。
    if (v > Number(memory.kvGet('branch_log_wm.last') || 0)) memory.kvSet('branch_log_wm.last', String(v));
  } catch { /* 推进失败仅导致下次重复提示,不影响注入 */ }
}

export function registerMemorySection(ctx, gate, memory, settings) {
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
      text: (assembly) => textForAssembly(assembly, gate, memory, settings),
    });
    registered = true;
    memory.kvSet('inject.section_registered', '1');
    void ret;
  } catch (e) {
    console.debug('[dsh-ling] systemPrompt.section failed', e);
    memory.kvSet('inject.section_registered', '0:' + String(e?.message ?? e).slice(0, 120));
  }
  return () => {
    if (!registered) return;
    try {
      sp.section?.({ name: SECTION_NAME, order: SECTION_ORDER, complete: false, text: '' });
    } catch {}
    registered = false;
  };
}

function textForAssembly(assembly, gate, memory, settings) {
  try {
    if (!assembly) return '';
    const agent = agentOf(assembly);
    const sessionId = agent ? sessionIdOfAgent(agent) : undefined;
    if (!sessionId) return '';
    if (!canInject(kindOfAgent(agent))) return ''; // 子代理/未知不注入(R5);D9-a:分叉会话注入血缘链
    // 被动时间锚:每次组装实时生成,不进快照(跨天不过期)
    const anchor = timeAnchor(memory, settings);
    // 注入面出口 ②(最终侧,2026-09-18):时间锚不经快照,未来新增的 part 也只走这里,
    // 故在最外层再中和一次(幂等)。①+② 合计覆盖全部注入文本。
    const withAnchor = (text) => {
      const body = neutralizeMustache(text || '');
      if (!anchor) return body;
      return (body ? body + '\n\n' : '') + neutralizeMustache(anchor);
    };
    const snap = gate.snapshotOf(sessionId);
    if (!snap) {
      // 首轮组装可能先于/晚于 session-start 事件:空闲时补建,运行时不建(D4)
      if (gate.isRunning(sessionId)) return withAnchor('');
      const mode = currentMode(memory, settings, sessionId);
      const kw = keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw, bumpHits: true });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      advanceLogWatermark(memory, sessionId, built.logMaxId); // B#9:定稿即消费
      return withAnchor(built.text);
    }
    // 冻结:running 一律返回既有快照(即使 stale);时间锚仍实时
    if (gate.isRunning(sessionId)) {
      advanceLogWatermark(memory, sessionId, snap.logMaxId); // B#9:冻结快照投递即消费
      return withAnchor(snap.text || '');
    }
    // idle + stale → 懒重建(一次性失效);重建必须带上首次定稿时的关键词,否则排序口径会变
    if (snap.stale) {
      const mode = currentMode(memory, settings, sessionId);
      const kw = Array.isArray(snap.keywords) ? snap.keywords : keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      advanceLogWatermark(memory, sessionId, built.logMaxId); // B#9:重建后投递即消费
      return withAnchor(built.text);
    }
    advanceLogWatermark(memory, sessionId, snap.logMaxId); // B#9:命中缓存快照投递即消费
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
  if (!canInject(kindOfAgent(agent))) return null;
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
