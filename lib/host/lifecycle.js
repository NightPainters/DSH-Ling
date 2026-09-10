// dsh-ling host — lifecycle wiring (REPORT-02 / DESIGN §4.4):
//   session events → freeze gate state, snapshot freeze, incremental capture.
// Every handler is defensive (payload shapes verified at M1b live probe).
import { svc, pick, isTopLevelSessionHeader } from './util.js';
import { freezeSnapshotForSession, invalidateSession } from './inject.js';
import { extractMessageText, messageSourceKind } from './snapshot.js';
import { currentMode } from './mode.js';

export function wireLifecycle(ctx, gate, memory, settings, config) {
  const disposers = [];
  const wrap = (label, fn) => {
    const handler = (...args) => {
      try {
        fn(...args);
      } catch (e) {
        console.debug(`[dsh-ling] ${label} handler error`, e);
      }
    };
    return handler;
  };
  // 清掉上次的诊断残留,保证每次重启后诊断只反映本轮真实情况
  memory.kvSet('dbg.first_event_sample', '');
  memory.kvSet('dbg.event_no_session', '');
  memory.kvSet('lifecycle.wired', '1');

  const inTrackedWorkspace = () => {
    const t = config?.trackWorkspaces || settings.get().memory?.trackWorkspaces;
    return !Array.isArray(t) || t.includes('*');
  };

  // ---- agent/session-start: 新会话(或 resume/clear)启动,顶层会话定稿快照 ----
  disposers.push(
    ctx.on('agent/session-start', wrap('session-start', (payload) => {
      if (!inTrackedWorkspace()) return;
      const agent = pick(() => payload?.agent, () => payload?.session?.agent, () => payload?.agentCtx);
      const sessionId = pick(
        () => agent?.session?.id,
        () => payload?.session?.id,
        () => payload?.sessionId,
        () => payload?.agent?.sessionId,
      );
      if (!sessionId) return;
      const header = pick(() => agent?.session?.header, () => payload?.session?.header, () => payload?.header);
      if (header && !isTopLevelSessionHeader(header)) return; // 子代理不建快照(R5)
      const source = pick(() => payload?.source, () => agent?.sessionStartSource);
      const meta = memory.sessionMeta(String(sessionId));
      // 模式初始化(修法 A,2026-09-11):
      //   空会话(含 DSH 复用的空壳/临时文件)不固化模式 —— 清掉旧值,跟随"当前默认";
      //   只有真正说过话的会话才保留自己的模式;"首次真人输入"时才写下那一刻的默认。
      const hasContent = memory.hasUserTurns(String(sessionId));
      let mode = null;
      if (!hasContent) {
        memory.clearSessionMode(String(sessionId));
        const last = settings.get().mode?.lastMode;
        mode = (last === 'work' || last === 'life') ? last : platformDefaultMode(ctx, settings);
      } else {
        // resume/clear/compact = 保留既有 meta(该会话自己选过的模式优先)
        if (source !== 'startup' && source !== undefined && meta?.mode && (meta.mode === 'work' || meta.mode === 'life')) {
          mode = meta.mode;
        }
        if (!mode) mode = platformDefaultMode(ctx, settings);
        memory.setSessionMode(String(sessionId), mode);
      }
      gate.ensure(String(sessionId), { mode });
      freezeSnapshotForSession(gate, memory, settings, agent);
    })),
  );

  // ---- agent/status: idle⇄running → 冻结门;running→idle flush pending ----
  disposers.push(
    ctx.on('agent/status', wrap('status', (payload) => {
      const obs = gate.observeStatusEvent(payload);
      let sid = null;
      let running = null;
      if (obs) {
        sid = obs.sessionId;
        running = obs.running === true;
      } else {
        sid = pick(() => payload?.agent?.session?.id, () => payload?.agent?.id, () => payload?.id);
        const raw = pick(() => payload?.status, () => payload?.state);
        if (sid && typeof raw === 'string') running = raw === 'running';
      }
      if (!sid || running === null) return;
      const flippedIdle = gate.setRunning(String(sid), running);
      if (flippedIdle) {
        // 空闲边界:对会话日志做水位差分捕捉(与 session/event 双保险,幂等)
        const sess = pick(() => payload?.agent?.session, () => payload?.session, () => payload?.agentSession);
        try {
          captureSessionDiff(memory, sess, settings);
        } catch (e) {
          console.debug('[dsh-ling] idle-diff capture failed', e);
        }
      }
    })),
  );

  // ---- session/event: 逐条增量捕捉(顶层会话;被动记录,不受冻结门限制) ----
  // 契约:('session/event', (session, event) => void)
  // 真实事件形状(磁盘取证):{ type, seq, time(ms), data:{ content|message.content, source } }
  disposers.push(
    ctx.on('session/event', wrap('event-capture', (session, event) => {
      const type = event?.type;
      if (!event) {
        if (!memory.kvGet('dbg.first_event_sample')) {
          try {
            memory.kvSet('dbg.first_event_sample', JSON.stringify({
              note: 'event 参数缺失', sessionKeys: session ? Object.keys(session).slice(0, 10) : null,
            }).slice(0, 300));
          } catch {}
        }
        return;
      }
      if (type !== 'user/message' && type !== 'assistant/message') return;
      // 只留真人消息(排除 plugin/skill-catalog/goal 注入)
      if (type === 'user/message' && messageSourceKind(event) !== 'user') return;
      const sessionId = pick(
        () => session?.id,
        () => session?.header?.id,
        () => session?.sessionId,
      );
      if (!sessionId) {
        if (!memory.kvGet('dbg.event_no_session')) {
          memory.kvSet('dbg.event_no_session', JSON.stringify({ type, eventKeys: Object.keys(event).slice(0, 10) }).slice(0, 300));
        }
        return;
      }
      const header = pick(() => session?.header, () => session?.headerMeta);
      if (header && !isTopLevelSessionHeader(header)) return; // 子代理/嵌套不入库
      const text = extractMessageText(event);
      if (!text) return;
      const seq = Number(event?.seq ?? (memory.rawTurnCount(sessionId) + 1));
      const time = Number(event?.time);
      const isUser = type.startsWith('user');
      memory.appendRawTurn(String(sessionId), {
        seq,
        role: isUser ? 'user' : 'assistant',
        ts: time && !Number.isNaN(time) ? new Date(time).toISOString() : null,
        model: null,
        text,
      });
      if (isUser) stampModeIfFirstInput(memory, settings, String(sessionId));
    })),
  );

  // ---- session/disposed: 归档点(会话拆除后,天然安全) ----
  disposers.push(
    ctx.on('session/disposed', wrap('disposed', (payload) => {
      const sessionId = pick(() => payload?.session?.id, () => payload?.sessionId, () => payload?.id);
      if (!sessionId) return;
      memory.markArchived(String(sessionId));
    })),
  );

  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
  };
}

/** 首次真人输入时才固化会话模式(修法 A:空会话永远跟随当前默认)。 */
function stampModeIfFirstInput(memory, settings, sessionId) {
  const sid = String(sessionId);
  const meta = memory.sessionMeta(sid);
  if (meta && (meta.mode === 'work' || meta.mode === 'life')) return false;
  memory.setSessionMode(sid, currentMode(memory, settings, sid));
  return true;
}

/** 平台默认模型 → 模式:effort low/off=生活;max=工作;high/未知=回退 lastMode。 */
function platformDefaultMode(ctx, settings) {
  try {
    const adm = svc(ctx, 'agentDefaultModel');
    const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
    const eff = sel && sel.reasoningEffort;
    if (eff === 'low' || eff === 'off') return 'life';
    if (eff === 'max') return 'work';
  } catch (e) {
    console.debug('[dsh-ling] platformDefaultMode failed', e);
  }
  const last = settings.get().mode?.lastMode;
  return last === 'work' ? 'work' : 'life';
}

/**
 * 空闲边界差分捕捉:直接对会话快照事件日志按水位线(wm:<sid>)追加新增的
 * user/assistant 消息;以 (session_id, seq) 为主键幂等,与 session/event 订阅双保险。
 * @returns 新增入库条数
 */
export function captureSessionDiff(memory, session, settings = null) {
  if (!session) return 0;
  const sid = pick(() => session?.id, () => session?.header?.id);
  if (!sid) return 0;
  const header = pick(() => session?.header, () => session?.headerMeta);
  if (header && !isTopLevelSessionHeader(header)) return 0; // 子代理不入库(R5)
  if (typeof session.snapshotEvents !== 'function') return 0;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return 0;
  }
  if (!Array.isArray(events)) return 0;
  const key = 'wm:' + sid;
  let wm = Number(memory.kvGet(key) || 0);
  let lastSeq = wm;
  let added = 0;
  let userAdded = 0;
  const typeCount = {};
  const msgLike = [];
  for (const ev of events) {
    const s = Number(ev?.seq ?? 0);
    if (s > lastSeq) lastSeq = s;
    if (!s || s <= wm) continue;
    const type = ev?.type;
    if (!type) continue;
    typeCount[type] = (typeCount[type] || 0) + 1;
    if (String(type).includes('message') && msgLike.length < 3) {
      const data = ev?.data ?? {};
      msgLike.push({
        type,
        dataKeys: Object.keys(data).slice(0, 8),
        msgKeys: data?.message && typeof data.message === 'object' ? Object.keys(data.message).slice(0, 8) : null,
      });
    }
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    // 只留真人消息
    if (type === 'user/message' && messageSourceKind(ev) !== 'user') continue;
    const text = extractMessageText(ev);
    if (!text) continue;
    const time = Number(ev?.time);
    memory.appendRawTurn(String(sid), {
      seq: s,
      role: type.startsWith('user') ? 'user' : 'assistant',
      ts: time && !Number.isNaN(time) ? new Date(time).toISOString() : null,
      model: null,
      text,
    });
    added += 1;
    if (type.startsWith('user')) userAdded += 1;
  }
  if (lastSeq > wm) memory.kvSet(key, String(lastSeq));
  if (userAdded > 0 && settings) stampModeIfFirstInput(memory, settings, sid);
  if (added === 0 && !memory.kvGet('dbg.diff_types') && Object.keys(typeCount).length) {
    try {
      memory.kvSet('dbg.diff_types', JSON.stringify({ types: typeCount, msgLike }).slice(0, 900));
    } catch {}
  }
  return added;
}
