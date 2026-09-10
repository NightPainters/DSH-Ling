// dsh-ling host — 反馈成长回路(message-feedback 消费方,REPORT-04)。
// 平台 messageFeedback 无推送 → 低频轮询 list()。
// 语义(人审闭环):
//   negative + note → 修订建议队列(绝不自动改人格;用户在 UI 逐条 采纳/忽略)
//   positive         → 该 DSH 会话概述热度加权(bumpHit)
// 去重:kv('fb.seen') 存已处理 key 集合(JSON,上限 FB_SEEN_CAP,先进先出)。
import { utcIso } from './util.js';

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

/**
 * 从平台 message_feedback sidecar 文件结构映射条目(tables.sessions 形态)。
 * 服务 list() 需会话身份参数,不便轮询 → 直接读单文件 JSON。
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

/** 采纳一条建议为惯例(人审):note 追加进 persona.hardRules(去重)。 */
export async function applySuggestionAsRule(memory, settings, id) {  const row = memory.getFeedback(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'new') return { ok: false, reason: 'status:' + row.status };
  const note = String(row.note ?? '').trim();
  if (!note) return { ok: false, reason: 'empty-note' };
  const cur = settings.get().persona?.hardRules || [];
  const next = cur.includes(note) ? cur : [...cur, note];
  await settings.update({ persona: { hardRules: next } });
  memory.setFeedbackStatus(Number(id), 'applied');
  return { ok: true, id: Number(id), hardRules: next };
}

/** 忽略一条建议。 */
export function dismissSuggestion(memory, id) {
  const row = memory.getFeedback(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  memory.setFeedbackStatus(Number(id), 'dismissed');
  return { ok: true, id: Number(id) };
}
