// dsh-ling host — 会话契约文件导入(ACCESS-DESIGN §1/§3)。
// 统一搬运格式:JSON {sessions:[…]}/数组 或 JSONL 逐行一会话;两档深度:
//   完整档 messages[{role,text,at}] / 轻量档 summary+keywords(仅标题+时间也可)。
// source 恒为 'import'(与 dsweb/dsh 区分),conv_id 建议含平台命名空间(如 "webchat:123")。
// 2026-09-08:适配 DeepSeek 官方「导出所有历史会话」conversations.json(ChatGPT 风格 mapping 树:
//   会话 {id,title,inserted_at,updated_at,mapping},消息在 mapping 节点的 message.fragments,
//   REQUEST=用户 / RESPONSE=助手 / THINK/工具/FILE 忽略);同 uuid 命中 dsweb 旧域时自动折叠归并。
import { sha256Text } from './util.js';
import { categorizeTitle } from './classify.js';
import { keywordsFrom } from './inject-common.js';

export const IMPORT_SOURCE = 'import';
export const CAT_NAME = { knowledge: '知识', daily: '日常', feeling: '生活' };

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

/** 时间值清洗:ISO 字符串可能带 6 位微秒与偏移(如 .412000+08:00),截为 3 位毫秒再解析 */
function cleanTimeStr(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, '$1');
}
function isoTime(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? new Date(v) : new Date(cleanTimeStr(String(v)));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
function toMs(v) {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(cleanTimeStr(String(v)));
  return Number.isFinite(t) ? t : null;
}

/**
 * DeepSeek 官方导出:mapping 树 → 有序轮次(REQUEST→user / RESPONSE→assistant;
 * THINK/FILE/SEARCH/TOOL_* 跳过;节点可混合多个 fragment)。
 * @returns [{seq,role,ts,text}]
 */
export function turnsFromOfficialMapping(mapping) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const turns = [];
  let seq = 0;
  function walk(id) {
    const node = map[id];
    if (!node || typeof node !== 'object') return;
    if (node.message && typeof node.message === 'object') {
      const frags = Array.isArray(node.message.fragments) ? node.message.fragments : [];
      let role = '';
      const texts = [];
      for (const fr of frags) {
        if (!fr || typeof fr !== 'object') continue;
        if (fr.type === 'REQUEST') role = 'user';
        else if (fr.type === 'RESPONSE') role = 'assistant';
        if (typeof fr.content === 'string' && fr.content.trim() && (fr.type === 'REQUEST' || fr.type === 'RESPONSE')) {
          texts.push(fr.content.trim());
        }
      }
      if (role && texts.length) {
        seq += 1;
        turns.push({ seq, role, ts: toMs(node.message.inserted_at ?? node.message.insertedAt ?? node.message.time), text: texts.join('\n') });
      }
    }
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  walk('root');
  return turns;
}

/** 规范化一个契约对象 → {ok, row, rawTurns?, degraded?, reason?} */
export function normalizeImportItem(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '非对象条目' };
  const s = raw;
  const title = str(s.title) || str(s.name);
  const started = isoTime(s.inserted_at ?? s.startedAt ?? s.started_at ?? s.insertedAt ?? s.startTime ?? s.time);
  const updated = isoTime(s.updated_at ?? s.updatedAt) || started;
  if (!title && !started && !s.mapping) return { ok: false, reason: '缺标题与时间(至少要有一项)' };

  // messages(完整档);官方导出走 mapping 树
  const rawTurns = [];
  const hasMapping = s.mapping && typeof s.mapping === 'object';
  if (hasMapping) {
    rawTurns.push(...turnsFromOfficialMapping(s.mapping));
  } else if (Array.isArray(s.messages) && s.messages.length) {
    let seq = 0;
    for (const m of s.messages) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'assistant' || m.role === 'bot' || m.role === 'ai' ? 'assistant'
        : m.role === 'user' || m.role === 'human' ? 'user' : '';
      const text = str(m.text ?? m.content);
      if (!role || !text) continue;
      seq += 1;
      rawTurns.push({ seq, role, ts: toMs(m.at ?? m.ts ?? m.time), text });
    }
  }

  const category = s.category === 'knowledge' || s.category === 'daily' || s.category === 'feeling'
    ? s.category : categorizeTitle(title || (rawTurns.length ? rawTurns[0].text.slice(0, 80) : ''));
  const firstUserText = rawTurns.length ? (rawTurns.find((t) => t.role === 'user')?.text || '') : '';
  const oneLine = (title || firstUserText).replace(/\s+/g, ' ').trim().slice(0, 46);
  const finalTitle = oneLine || '(未命名会话)';
  const summary0 = rawTurns.length
    ? (str(s.summary) || `${oneLine.slice(0, 140)} — ${rawTurns.length} 条消息`)
    : str(s.summary);
  const summary = summary0 || `${oneLine.slice(0, 140)}(轻量条目,摘要待深摘补充)`;
  if (!rawTurns.length && !summary && !title) return { ok: false, reason: '既无消息也无摘要,无法成档' };
  const givenKw = Array.isArray(s.keywords) ? s.keywords.map((k) => str(k)).filter(Boolean).slice(0, 20) : [];
  const keywords = givenKw.length
    ? givenKw
    : keywordsFrom((finalTitle + ' ' + (str(s.summary) || firstUserText)).slice(0, 400));

  let id = str(s.id ?? s.convId ?? s.sessionId);
  if (!id) {
    id = 'auto:' + sha256Text(String(finalTitle) + '|' + String(started || '')).slice(0, 16);
  }
  const row = {
    conv_id: id,
    source: IMPORT_SOURCE,
    title: finalTitle,
    started_at: started,
    updated_at: updated,
    domain_tags: [CAT_NAME[category] || '日常'],
    category,
    keywords,
    summary,
    heat: 0,
    importance: 0,
    last_hit_at: null,
    hit_count: 0,
    overview_ok: 1,
    origin: 'import-file-v1',
  };
  return { ok: true, row, rawTurns, degraded: Array.isArray(s.messages) && s.messages.length > 0 && !rawTurns.length };
}

/**
 * 落库一批(≤500/批,幂等):
 *  - 折叠:同 conv_id 命中 dsweb 旧域(官方导出与历史抓取同源)→ 元数据与原文并入 dsweb,
 *    并移除本域残留副本(避免 L1 双份召回);
 *  - 否则:新行全量 upsert;已存在只刷新 标题/时间/类别/关键词(不动 summary/importance/置顶/热度);
 *  - 完整档 raw 轮次按 (session_id,seq) 覆盖写,重复导入天然幂等。
 * @returns {{ok, newRows, refreshed, folded, removedImport, accepted, degraded, rejected}}
 */
export async function applyImportItems(memory, items) {
  const rejected = [];
  const stat = { ok: true, accepted: 0, newRows: 0, refreshed: 0, upgraded: 0, folded: 0, removedImport: 0, degraded: 0 };
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const n = normalizeImportItem(list[i]);
    if (!n.ok) { rejected.push({ i, reason: n.reason }); continue; }
    stat.accepted += 1;
    if (n.degraded) stat.degraded += 1;
    const id = n.row.conv_id;
    const dswebRow = memory.overviewById('dsweb', id);
    if (dswebRow) {
      // 官方导出/历史抓取同源:并入 dsweb 域(不动其 summary/importance;raw 落到 dsweb conv)
      memory.db.prepare(
        `UPDATE conv_overview SET title=?, started_at=?, updated_at=?, domain_tags=?, category=?, keywords=?, origin=?
         WHERE source='dsweb' AND conv_id=?`,
      ).run(
        n.row.title,
        n.row.started_at ?? dswebRow.started_at,
        n.row.updated_at ?? dswebRow.updated_at,
        JSON.stringify(n.row.domain_tags), n.row.category, JSON.stringify(n.row.keywords),
        n.row.origin, id,
      );
      const impDup = memory.overviewById(IMPORT_SOURCE, id);
      if (impDup) {
        memory.db.prepare("DELETE FROM conv_overview WHERE source=? AND conv_id=?").run(IMPORT_SOURCE, id);
        stat.removedImport += 1;
      }
      stat.folded += 1;
      for (const t of n.rawTurns) {
        memory.appendRawTurn(id, { seq: t.seq, role: t.role, ts: t.ts, model: null, text: t.text });
      }
      continue;
    }
    const existed = memory.overviewById(IMPORT_SOURCE, id);
    if (existed) {
      memory.db.prepare(
        `UPDATE conv_overview SET title=?, started_at=?, updated_at=?, domain_tags=?, category=?, keywords=?,
           overview_ok=1, origin=? WHERE source=? AND conv_id=?`,
      ).run(
        n.row.title,
        n.row.started_at ?? existed.started_at,
        n.row.updated_at ?? existed.updated_at,
        JSON.stringify(n.row.domain_tags), n.row.category, JSON.stringify(n.row.keywords),
        n.row.origin, IMPORT_SOURCE, id,
      );
      stat.refreshed += 1;
      // 轻量行升级为完整档:本次带来原文而原行没有 raw → 记为「补全原文」
      if (n.rawTurns.length && memory.rawTurnCount(id) === 0) stat.upgraded += 1;
    } else {
      memory.upsertOverview(n.row);
      stat.newRows += 1;
    }
    for (const t of n.rawTurns) {
      memory.appendRawTurn(id, { seq: t.seq, role: t.role, ts: t.ts, model: null, text: t.text });
    }
  }
  return { ok: true, ...stat, rejected };
}
