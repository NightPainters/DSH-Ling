// dsh-ling host — 反馈成长回路(message-feedback 消费方,REPORT-04)。
// ⚠️ 2026-10-01 订正(旧注释"平台 messageFeedback 无推送 → 低频轮询 list()"**已被证伪**):
//   宿主 `@deepseek-ai/dsh-message-feedback` 有推送 —— 冷会话写入 flush 后
//   `lib/index.js:288` 发 **`feedback/committed`**(载荷 = SessionInspection:
//   `{ meta, inheritedEventCount, events }`,末条即本次提交的事件);
//   活会话消费方按它 README.zh.md:58 的口径看 `session/event` 里的
//   `feedback/message-put` / `feedback/message-delete`。
//   ⇒ 现走**事件驱动**(registerFeedbackListener),不再 60 秒轮询 sidecar。
// 语义(人审闭环):
//   negative + note → 修订建议队列(绝不自动改人格;用户在 UI 逐条 采纳/忽略)
//   positive         → 该 DSH 会话概述热度加权(bumpHit)
// 去重:kv('fb.seen') 存已处理 key 集合(JSON,上限 FB_SEEN_CAP,先进先出)。
import { utcIso } from './util.js';
import { proposeHabit, resolveHabit, habitsOf } from './rules.js';

const FB_SEEN_CAP = 4000;

export function loadSeen(memory) {
  try {
    const v = memory.kvGet('fb.seen');
    const arr = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSeen(memory, arr) {
  const trimmed = arr.slice(-FB_SEEN_CAP);
  memory.kvSet('fb.seen', JSON.stringify(trimmed));
}

/**
 * 处理一批平台反馈条目(纯逻辑,便于单测)。
 * @returns {{queued:number, boosted:number, seenAdded:number, skipped:number}}
 */
export function ingestFeedbackEntries(memory, entries, { seen } = {}) {
  const seenSet = new Set(seen || loadSeen(memory));
  const out = { queued: 0, boosted: 0, seenAdded: 0, skipped: 0 };
  for (const e of entries || []) {
    const sid = String(e?.sessionId ?? '');
    const mid = String(e?.messageId ?? '');
    const rating = String(e?.rating ?? '');
    if (!sid || !mid || (rating !== 'positive' && rating !== 'negative')) {
      out.skipped += 1;
      continue;
    }
    const key = sid + ':' + mid;
    if (seenSet.has(key)) {
      out.skipped += 1;
      continue;
    }
    seenSet.add(key);
    out.seenAdded += 1;
    if (rating === 'positive') {
      // 点赞 → 强化对应 DSH 会话(若存在概述)
      if (memory.overviewById('dsh', sid)) {
        memory.bumpHit('dsh', sid);
        out.boosted += 1;
      }
    } else {
      const note = String(e?.note ?? '').trim();
      if (note) {
        memory.addFeedback({
          session_id: sid, message_id: mid, rating, note,
          created_at: e?.createdAt ? new Date(e.createdAt).toISOString() : utcIso(),
        });
        out.queued += 1;
      } else {
        out.skipped += 1; // 无文案的差评不入队列(信息量不足)
      }
    }
  }
  if (out.seenAdded > 0) saveSeen(memory, [...seenSet]);
  return out;
}

/** 事件名单一来源(测试钉它;改名时两处一起红,不会静默漂移)。 */
export const FEEDBACK_COMMITTED_EVENT = 'feedback/committed';

/**
 * 提交事件列表 → 当前反馈条目(纯函数)。
 * 与宿主 message-feedback 同口径:put 覆盖同 messageId 的旧值,delete 抹掉它。
 * 末条是本次提交的事件 —— 无该项就返回空(不算错,也绝不抛)。
 * @param {string} sid 所属会话
 * @param {Array} events SessionInspection.events
 * @returns {Array<{sessionId:string,messageId:string,rating:string,note:string,createdAt:number}>}
 */
export function entriesFromSessionEvents(sid, events) {
  const list = Array.isArray(events) ? events : [];
  const last = list[list.length - 1];
  const t = last?.type;
  if (t !== 'feedback/message-put' && t !== 'feedback/message-delete') return [];
  const sessionId = String(sid ?? last?.data?.sessionId ?? '');
  if (!sessionId) return [];
  const map = new Map();
  for (const ev of list) {
    const d = ev?.data;
    if (!d) continue;
    if (ev.type === 'feedback/message-put' && d.item?.messageId && d.item?.rating) {
      map.set(String(d.item.messageId), {
        messageId: String(d.item.messageId),
        rating: String(d.item.rating),
        note: d.item.note ?? '',
        createdAt: d.item.createdAt ?? d.item.updatedAt ?? Date.now(),
      });
    } else if (ev.type === 'feedback/message-delete' && d.messageId) {
      map.delete(String(d.messageId));
    }
  }
  return [...map.values()].map((it) => ({ sessionId, ...it }));
}

/**
 * 挂推送监听(U7 正解)。
 * - 冷会话:`feedback/committed`,载荷是完整事件日志 ⇒ 重放出**当前**条目(update/delete 都算准);
 * - 活会话:`session/event` 的 `feedback/message-put|delete`,按事件本身取条目;
 * - delete 事件**不**反向撤单:已入队的修订建议保持原状(与旧轮询口径一致,登记在案)。
 * 绝不抛:宿主在 `feedback/committed` 上等观察方,抛错只会让它写日志。
 * @returns {() => void} 卸载函数(交给 ctx.effect / disposers)
 */
export function registerFeedbackListener(ctx, memory) {
  const offs = [];
  const handle = (label, fn) => async (...args) => {
    try {
      fn(...args);
    } catch (e) {
      console.debug(`[dsh-ling] feedback ${label} handler error`, e);
    }
  };
  try {
    offs.push(ctx.on(FEEDBACK_COMMITTED_EVENT, handle('committed', (inspection) => {
      // 只认驱动本回调的那条事件;其余类型视作"无提交"(宿主 no-op append 也会发这个通知)
      const last = inspection?.events?.[inspection.events.length - 1];
      if (last?.type !== 'feedback/message-put') return;
      const sid = String(inspection?.meta?.id ?? last?.data?.sessionId ?? '');
      const entries = entriesFromSessionEvents(sid, inspection?.events);
      if (entries.length) processFeedbackEntries(memory, entries, { seen: loadSeen(memory) });
    })));
  } catch (e) {
    console.debug('[dsh-ling] feedback committed subscribe failed', e);
  }
  try {
    offs.push(ctx.on('session/event', handle('live-event', (session, event) => {
      const t = event?.type;
      if (t !== 'feedback/message-put' && t !== 'feedback/message-delete') return;
      const sid = String(
        session?.id ?? event?.data?.sessionId ?? session?.header?.id ?? '',
      );
      const entries = t === 'feedback/message-put'
        ? entriesFromSessionEvents(sid, [event])
        : [];
      if (entries.length) processFeedbackEntries(memory, entries, { seen: loadSeen(memory) });
    })));
  } catch (e) {
    console.debug('[dsh-ling] feedback live subscribe failed', e);
  }
  memory.kvSet('feedback.wired', FEEDBACK_COMMITTED_EVENT + '+session/event');
  return () => {
    for (const d of offs) {
      try { d(); } catch { /* ignore */ }
    }
  };
}

/**
 * 从平台 message_feedback sidecar 文件结构映射条目(tables.sessions 形态)。
 * ⚠️ 2026-10-01 起**不再是活路径**:宿主推送已接管(见文件头);
 * 该 sidecar 在 Web 组合下自 2026/9/11 起零写入。此处只服务
 * `tools/process-feedback.mjs` 这个人工兜底 CLI 与既有回归测试。
 */
export function entriesFromFeedbackFile(fileObj) {
  const out = [];
  const tables = fileObj?.tables?.sessions;
  if (!tables || typeof tables !== 'object') return out;
  for (const sessionId of Object.keys(tables)) {
    const row = tables[sessionId];
    for (const item of row?.items || []) {
      if (!item?.messageId || !item?.rating) continue;
      out.push({
        sessionId,
        messageId: item.messageId,
        rating: item.rating,
        note: item.note ?? '',
        createdAt: item.createdAt ?? item.updatedAt ?? Date.now(),
      });
    }
  }
  return out;
}

/** 采纳一条点踩建议(人审):走「提议 → 确认」落到**习惯**(2026-09-15 二分定稿;不再是规矩)。 */
export async function applySuggestionAsRule(memory, settings, id) {
  const row = memory.getFeedback(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'new') return { ok: false, reason: 'status:' + row.status };
  const note = String(row.note ?? '').trim();
  if (!note) return { ok: false, reason: 'empty-note' };
  const prop = await proposeHabit({ settings, habit: note, evidence: '平台点踩理由(面板采纳即确认)', byUser: true });
  if (prop.ok) {
    await resolveHabit({ settings, id: prop.id, action: 'confirm' });
  } else if (prop.reason !== 'already-habit' && prop.reason !== 'already-pending') {
    return { ok: false, reason: prop.reason };
  }
  memory.setFeedbackStatus(Number(id), 'applied');
  return { ok: true, id: Number(id), habits: habitsOf(settings).length };
}

/** 忽略一条建议。 */
export function dismissSuggestion(memory, id) {
  const row = memory.getFeedback(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  memory.setFeedbackStatus(Number(id), 'dismissed');
  return { ok: true, id: Number(id) };
}

/**
 * U7 正解入口:吃一批平台反馈,交给 ingestFeedbackEntries。
 * 幂等:同一 (会话,消息) 只处理一次(kv `fb.seen`);返回 null = 这批没有可处理项。
 * 注意 `{seen}` 必须是**本次调用前**的快照(调用后 seenSet 已含新键)。
 */
export function processFeedbackEntries(memory, entries, { seen } = {}) {
  const res = ingestFeedbackEntries(memory, entries, { seen });
  if (res.queued + res.boosted + res.seenAdded > 0) {
    memory.kvSet('feedback.last', JSON.stringify({ at: utcIso(), ...res }));
    return res;
  }
  return null;
}
