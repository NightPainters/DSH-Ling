// dsh-ling host — freeze gate (D4): while a session is running
// (thinking/tasking) NO persona/memory-update-layer change applies.
// Updates queue and flush at the idle boundary (agent/status → idle,
// or explicit flush). Reads are always allowed.
import { pick } from './util.js';

const MODES = new Set(['work', 'life']);

export class FreezeGate {
  constructor({ onFlush } = {}) {
    this._byId = new Map();
    this._onFlush = onFlush || (() => {});
    this._recent = null; // 最近定稿快照的会话(API "当前会话"启发式)
  }

  /** @returns {{mode:string, running:boolean, pending:string[], snap:object|null}} */
  _state(sessionId) {
    let s = this._byId.get(sessionId);
    if (!s) {
      s = { mode: null, running: false, pending: [], snap: null, snapStale: false };
      this._byId.set(sessionId, s);
    }
    return s;
  }

  ensure(sessionId, { mode } = {}) {
    const s = this._state(sessionId);
    if (mode && MODES.has(mode) && s.mode !== mode) s.mode = mode;
    return s;
  }

  /** Called from agent/status events. Returns true on a running→idle transition. */
  setRunning(sessionId, running) {
    if (!sessionId) return false;
    const s = this._state(sessionId);
    const was = s.running;
    s.running = !!running;
    if (was && !s.running) {
      const ops = s.pending.splice(0);
      for (const op of ops) {
        try {
          op();
        } catch (e) {
          console.debug('[dsh-ling] pending op failed', e);
        }
      }
      this._onFlush(sessionId, s);
      return true;
    }
    return false;
  }

  /**
   * D4 gate: run `op` now when idle; queue it when running.
   * @returns {{applied:boolean, queued:boolean, running:boolean}}
   */
  act(sessionId, op, label = 'update') {
    const s = this._state(sessionId);
    if (s.running) {
      s.pending.push(op);
      return { applied: false, queued: true, running: true, label };
    }
    op();
    return { applied: true, queued: false, running: false, label };
  }

  /** Async-friendly: enqueue only when running (caller awaits when idle). */
  enqueueIfRunning(sessionId, op) {
    const s = this._state(sessionId);
    if (s.running) {
      s.pending.push(op);
      return true;
    }
    return false;
  }

  isRunning(sessionId) {
    return sessionId ? !!this._state(sessionId).running : false;
  }

  pendingCount(sessionId) {
    return sessionId ? this._state(sessionId).pending.length : 0;
  }

  markSnap(sessionId, snap) {
    const s = this._state(sessionId);
    s.snap = snap;
    s.snapStale = false;
    this._recent = sessionId;
  }

  markSnapStale(sessionId) {
    if (sessionId) this._state(sessionId).snapStale = true;
  }

  snapshotOf(sessionId) {
    const s = sessionId ? this._state(sessionId) : null;
    return s ? { ...(s.snap || {}), running: s.running, stale: !!s.snapStale } : null;
  }

  /** 已定稿快照的会话 id(API 枚举用)。 */
  snapshotIds() {
    return [...this._byId.entries()].filter(([, s]) => !!s.snap).map(([id]) => id);
  }

  /** 最近定稿/活跃的会话 id(启发式,可为 null)。 */
  recentSessionId() {
    return this._recent;
  }

  /** Convenience: payload shapes differ across events — extract (sessionId, running). */
  observeStatusEvent(payload) {
    const sessionId = pick(
      () => payload?.session?.id,
      () => payload?.sessionId,
      () => payload?.agent?.session?.id,
      () => payload?.agent?.sessionId,
      () => payload?.id,
    );
    if (!sessionId) return null;
    const raw = pick(
      () => payload?.status,
      () => payload?.running,
      () => payload?.state,
    );
    let running;
    if (typeof raw === 'boolean') running = raw;
    else if (typeof raw === 'string') running = raw === 'running';
    else running = undefined;
    return { sessionId: String(sessionId), running };
  }

  /** Extract session id from an agent-scoped event payload (session-start & co). */
  sessionIdOf(payload) {
    return pick(
      () => payload?.session?.id,
      () => payload?.sessionId,
      () => payload?.agent?.session?.id,
      () => payload?.agent?.sessionId,
      () => payload?.header?.id,
      () => payload?.id,
    );
  }
}
