// dsh-ling host — freeze gate (D4): while a session is running
// (thinking/tasking) NO persona/memory-update-layer change applies.
// Updates queue and flush at the idle boundary (agent/status → idle,
// or explicit flush). Reads are always allowed.
import { pick } from './util.js';

const MODES = new Set(['work', 'life']);

/**
 * A(审计 §四.4,2026-10-01 修):`_byId` 的**基数上限** —— 只对"全缺省空壳"条目生效。
 *
 * 为什么会有无界增长:`GET /state?sessionId=<任意字符串>` 经 stateFor → `gate.isRunning` /
 * `pendingCount` / `snapshotOf`,而这三个方法都走 `_state()`,**先建条目再读** ⇒ 任意 id 都会
 * 在内存里留下一条。条目不存在与条目为全缺省,对读者**不可区分**(实测:`/state` 这条路上
 * 除 `_state()` 外没有任何写入点 —— mode 由 mode.js 从 memory/settings 读,不写 gate),
 * 所以上限可以只清理空壳。
 *
 * 为什么不会动到真读数:带读数的条目**一律不淘汰** —— `running`(agent/status 写)、
 * `pending`(act 写)、`snap`/`snapStale`(markSnap / 失效路径写)、`mode`(ensure 写)。
 * 于是"已存在会话的读数不受影响"是**结构上**成立的(不是靠概率),
 * `snapshotIds()` 枚举的定稿会话也不会因淘汰而消失。
 *
 * N=128 的依据:一台机器上真实并发的会话是个位数;带 snap 的定稿会话属于"非空壳",
 * 根本不在这条上限的管辖内(故不会误伤历史)。128 比真实需要高约两个数量级,
 * 同时把"任意 id ⇒ 无限增长"封成一个常数。要更紧/更松可经构造函数传 `maxIdleSessions`。
 */
const MAX_IDLE_SESSIONS_DEFAULT = 128;

export class FreezeGate {
  constructor({ onFlush, maxIdleSessions = MAX_IDLE_SESSIONS_DEFAULT } = {}) {
    this._byId = new Map();
    this._onFlush = onFlush || (() => {});
    this._recent = null; // 最近定稿快照的会话(API "当前会话"启发式)
    const n = Number(maxIdleSessions);
    this._maxIdle = Number.isFinite(n) && n >= 0 ? Math.floor(n) : MAX_IDLE_SESSIONS_DEFAULT;
  }

  /** 全缺省空壳?(新建时就是这个形状;任何真读数都会让它不再是空壳) */
  _isIdleShell(s) {
    return !s.running && !s.snap && !s.snapStale && !s.mode && s.pending.length === 0;
  }

  /**
   * A:超过上限时,按**插入顺序**(Map 的迭代顺序)淘汰最老的**空壳**;带读数的一律留下。
   * `keepId` = 刚建的那一条(它也是空壳,但必须留给本次调用方)。
   * @returns {number} 本次淘汰条数(自检/测试可读)
   */
  _trimIdleShells(keepId) {
    if (this._byId.size <= this._maxIdle) return 0;
    let dropped = 0;
    for (const [id, s] of this._byId) {
      if (this._byId.size <= this._maxIdle) break;
      if (id === keepId) continue;          // 本次要用的那一条不许被自己挤掉
      if (!this._isIdleShell(s)) continue;  // 带读数:永不淘汰(这就是"读数不受影响"的保证)
      this._byId.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  /** 门内会话条目数(自检/测试用;正常读者不需要它 —— 读数是 per-session 的)。 */
  size() {
    return this._byId.size;
  }

  /** @returns {{mode:string, running:boolean, pending:string[], snap:object|null}} */
  _state(sessionId) {
    let s = this._byId.get(sessionId);
    if (!s) {
      s = { mode: null, running: false, pending: [], snap: null, snapStale: false };
      this._byId.set(sessionId, s);
      this._trimIdleShells(sessionId);
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
