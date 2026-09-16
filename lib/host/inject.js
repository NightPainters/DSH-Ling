// dsh-ling host — system-prompt injection (DESIGN §4.2/4.3, REPORT-02).
// One global section; text() is evaluated at every model-step assembly and is
// a PURE READ of the session's frozen snapshot:
//   - running sessions: always return the frozen snapshot (D4 — never mutate,
//     never rebuild mid-run);
//   - idle sessions with a stale snapshot: rebuild lazily (one-time invalidation);
//   - subagent/child/unknown sessions: return '' (R5).
import { svc, pick } from './util.js';
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

function isChildSession(agent) {
  const header = pick(
    () => agent?.session?.header,
    () => agent?.header,
  );
  if (!header || typeof header !== 'object') return null; // 未知 → 保守不注入
  if (header.parentSession || header.origin === 'subagent' || header.delegationDepth) return true;
  return false;
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
    const child = isChildSession(agent);
    if (child !== false) return ''; // 子代理/未知会话不注入(R5 保守)
    // 被动时间锚:每次组装实时生成,不进快照(跨天不过期)
    const anchor = timeAnchor(memory, settings);
    const withAnchor = (text) => {
      if (!anchor) return text || '';
      return (text ? text + '\n\n' : '') + anchor;
    };
    const snap = gate.snapshotOf(sessionId);
    if (!snap) {
      // 首轮组装可能先于/晚于 session-start 事件:空闲时补建,运行时不建(D4)
      if (gate.isRunning(sessionId)) return withAnchor('');
      const mode = currentMode(memory, settings, sessionId);
      const kw = keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw, bumpHits: true });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      return withAnchor(built.text);
    }
    // 冻结:running 一律返回既有快照(即使 stale);时间锚仍实时
    if (gate.isRunning(sessionId)) return withAnchor(snap.text || '');
    // idle + stale → 懒重建(一次性失效);重建必须带上首次定稿时的关键词,否则排序口径会变
    if (snap.stale) {
      const mode = currentMode(memory, settings, sessionId);
      const kw = Array.isArray(snap.keywords) ? snap.keywords : keywordsFrom(firstUserText(agent));
      const built = buildSnapshotText(null, memory, settings, sessionId, { keywords: kw });
      gate.markSnap(sessionId, { ...built, sessionId, mode, keywords: kw });
      return withAnchor(built.text);
    }
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
  const child = isChildSession(agent);
  if (child !== false) return null;
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
