// dsh-ling host — lifecycle wiring (REPORT-02 / DESIGN §4.4):
//   session events → freeze gate state, snapshot freeze, incremental capture.
// Every handler is defensive (payload shapes verified at M1b live probe).
import { svc, pick, isMemoryEligibleHeader, sessionKind, utcIso } from './util.js';
import { TRUNK_ID } from './memory.js';
import { freezeSnapshotForSession, invalidateSession, refreshIdleSnapshot } from './inject.js';
import { summarizeDsh } from './summarizer.js';
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

  // ---- 会话启动(新会话 / resume / clear):顶层会话定稿快照 ----
  //      事件名跨 cohort:`agent/created`(DSH ≥0.1.7)/ `agent/session-start`(≤0.1.6)
  const startHandler = wrap('session-start', (payload) => {
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
      if (header && !isMemoryEligibleHeader(header)) return; // 子代理不建快照(R5);D9-a:分叉会话要建
      // D9-a:分叉会话归枝(建枝 + 挂会话 + 定水位),之后照常定稿快照 —— 它能读到血缘链记忆
      if (sessionKind(header) === 'fork') ensureForkBranch(memory, agent, header, String(sessionId));
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
    });
  // ⚠️ 事件改名(2026-09-25 夜**实测**):`agent/session-start` 在 DSH **0.1.7** 的
  //    `node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\**` 里**一个都不存在**;
  //    现在叫 **`agent/created`**,载荷是 `{ agent, source, signal }` —— 与本 handler 的
  //    取值路径(`payload.agent` / `payload.source`)**完全一致**,只有事件名对不上。
  //    后果极隐蔽:事件名不存在 ⇒ handler 永不触发 ⇒ **没有快照 ⇒ 记忆与人格注入整段
  //    静默空白**(只剩时间锚),没有报错、没有日志、库里也不留痕迹。现场取证:
  //    `last_hit_at` 与所有 `branch_log_wm.<会话>` 全部停在升级之前,`snap.refresh:*` 无新键。
  //    这正是内部踩坑记录 **B19** 说的那类:**跨进程契约(事件名/字段)驱动的判据,平台升级后
  //    必须复核一遍** —— 而且失败形态是静默的。
  //    修法:**两个名字都注册**(跨 cohort 兼容,不赌平台只留哪一个),加短窗口去重
  //    (将来两者同存时不会定稿两次 → 不会把 hit_count 刷两遍)。
  const freezeSeen = new Map();
  const dedupStart = (payload) => {
    try {
      const sid = pick(
        () => payload?.agent?.session?.id,
        () => payload?.session?.id,
        () => payload?.sessionId,
        () => payload?.agent?.sessionId,
      );
      const key = sid ? String(sid) : '';
      const now = Date.now();
      if (key && freezeSeen.get(key) && now - freezeSeen.get(key) < 3000) return; // 双事件同发时只定稿一次
      if (key) freezeSeen.set(key, now);
    } catch { /* 去重失败就照常执行,宁可多定稿一次也不漏 */ }
    return startHandler(payload);
  };
  disposers.push(ctx.on('agent/created', dedupStart));       // DSH ≥0.1.7
  disposers.push(ctx.on('agent/session-start', dedupStart)); // DSH ≤0.1.6(旧名,保留兼容)

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
        // B:空闲边界刷新 —— 记忆长进之后,把该会话的 L1 追平到最新。
        // 只可能在 running→idle 时发生,故 D4(运行中注入面逐字节不变)天然保持。
        try {
          refreshIdleSnapshot(gate, memory, settings, String(sid), {
            summarize: () => summarizeDsh(memory, { force: false }),
          });
        } catch (e) {
          console.debug('[dsh-ling] idle refresh failed', e);
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
      if (header && !isMemoryEligibleHeader(header)) return; // 子代理/嵌套不入库(D9-a:分叉会话入枝)
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
      const sid = String(sessionId);
      memory.markArchived(sid);
      // (2026-09-16 用户定案 A)归档**不做自动清理**:归档只是标记"该会话结束了",
      // 而 session/disposed 对每个关闭的会话都会触发 —— 自动删概述会长期把记忆库掏空。
      // 清理改为人工:①DSH 官方「设置 → 归档会话」里直接删;②tools/clean-archived.mjs --write(先看清单)。
      // 归档的语义保留为"停更":概述器跳过 archived=1 的会话(见 summarizer.js);该会话一旦有新轮次即复活。
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

/** D9-a(2026-09-18):分叉会话自动建枝。
 *  分叉 = 主人显式开的并行工作线,它**有自己的记忆**(写在所属枝里),同时**能读祖先链**。
 *  - 父枝:父会话所属枝(逐级上溯,天然支持"枝上再分枝");
 *  - 水位:分叉点之前属于父枝的历史,不重复计入本枝(见内部记忆树设计笔记 §6.1);
 *  - 枝名:先留空,命名沿用 D2 的 retitle 链路(retitleOne 会补)。
 *  幂等:重启/resume 时已挂枝则直接返回。 */
function ensureForkBranch(memory, session, header, sessionId) {
  try {
    const parentSid = String(pick(() => header?.parentSession) ?? '');
    if (!parentSid) return memory.branchOfSession(sessionId);
    const existing = memory.branchOfSession(sessionId);
    if (existing && existing !== TRUNK_ID) return existing; // 已建过
    const parentBranch = memory.branchOfSession(parentSid);
    let forkSeq =
      Number(pick(() => session?.inheritedEventCount, () => session?.header?.inheritedEventCount) ?? 0) || 0;
    // 兜底(2026-09-19 实机教训):平台没给出 inheritedEventCount 时水位会被写成 0,
    // 于是 idle 边界上 captureSessionDiff 会把 seed(父会话继承来的全部历史)当成新轮次灌进枝。
    // 取不到就退回"快照里已有的最大 seq"(≈ 分叉点),让水位落在正确位置。
    if (!forkSeq && typeof session?.snapshotEvents === 'function') {
      try {
        const evs = session.snapshotEvents();
        if (Array.isArray(evs) && evs.length) {
          forkSeq = evs.reduce((mx, e) => Math.max(mx, Number(e?.seq ?? 0)), 0);
        }
      } catch {
        /* 仍是 0:由 captureSessionDiff 的 isOwnSeq 过滤兜底 */
      }
    }
    const branchId = memory.createBranch({
      kind: 'branch',
      parentId: parentBranch,
      forkAt: parentSid,
      forkSeq,
      name: branchSeedName(memory, parentSid),
    });
    memory.setSessionBranch(sessionId, branchId);
    if (memory.kvGet('wm:' + sessionId) == null) memory.kvSet('wm:' + sessionId, String(forkSeq));
    memory.kvSet(
      'branch.last_created',
      JSON.stringify({ branchId, parentSid, parentBranch, forkSeq, at: utcIso() }).slice(0, 300),
    );
    return branchId;
  } catch (e) {
    console.debug('[dsh-ling] ensureForkBranch failed', e);
    return TRUNK_ID;
  }
}

/** D9-a 枝名种子:先借源会话的标题(器灵起名的第一层),复盘时可改、可上锁。
 *  枝刚建立时还没有自己的内容,故这里不调模型 —— 免得"每开一个分叉就打一次 LLM"。 */
function branchSeedName(memory, parentSid) {
  try {
    const t = memory.overviewTitleOf(parentSid);
    return t ? String(t).slice(0, 40) : '';
  } catch {
    return '';
  }
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
  if (header && !isMemoryEligibleHeader(header)) return 0; // 子代理不入库(R5);D9-a:分叉会话入枝
  const kind = sessionKind(header);
  if (typeof session.snapshotEvents !== 'function') return 0;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return 0;
  }
  if (!Array.isArray(events)) return 0;
  // D9-a:分叉会话的 seed 前缀是"父会话的历史",不是这条枝新产生的记忆 ——
  // 平台用 isOwnSeq(seq >= inheritedEventCount) 标记自有事件;顶层会话该值为 0,过滤对它们无影响。
  if (kind === 'fork' && typeof session.isOwnSeq === 'function') {
    try {
      events = events.filter((ev) => session.isOwnSeq(Number(ev?.seq ?? 0)));
    } catch {
      /* 过滤失败就按全量走,水位线仍是一道保险 */
    }
  }
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
