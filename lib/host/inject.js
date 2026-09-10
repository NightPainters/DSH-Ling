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
      const built = buildSnapshotText(null, memory, settings, sessionId, {
        keywords: keywordsFrom(firstUserText(agent)),
      });
      gate.markSnap(sessionId, { ...built, sessionId, mode });
      return withAnchor(built.text);
    }
    // 冻结:running 一律返回既有快照(即使 stale);时间锚仍实时
    if (gate.isRunning(sessionId)) return withAnchor(snap.text || '');
    // idle + stale → 懒重建(一次性失效)
    if (snap.stale) {
      const mode = currentMode(memory, settings, sessionId);
      const built = buildSnapshotText(null, memory, settings, sessionId, {});
      gate.markSnap(sessionId, { ...built, sessionId, mode });
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
  const built = buildSnapshotText(null, memory, settings, sessionId, {
    keywords: keywordsFrom(firstUserText(agent)),
  });
  gate.markSnap(sessionId, { ...built, sessionId, mode });
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
  const built = buildSnapshotText(null, memory, settings, sessionId, {});
  gate.markSnap(sessionId, { ...built, sessionId, mode });
  return { invalidated: true, mode };
}
