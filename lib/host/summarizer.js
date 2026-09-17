// dsh-ling host — DSH 会话概述器 v1(轻量)。
// 把 dsh_turns_raw 中每个顶层会话聚合成 source='dsh' 的 conv_overview:
//   title = 首条真人消息单行截断;summary = 首问摘要 + 轮次;类别/关键词启发式。
// 增量:每会话水位 kv('sumdsh:<sid>') = 已概述的最大 seq;有新增才重建。
// 无 LLM 深摘要(v1);原文保留在 dsh_turns_raw,供 M2 概述升级。
import { categorizeTitle } from './classify.js';
import { heuristicTitle, TITLE_MAX_CHARS } from './retitle.js';
import { keywordsFrom } from './inject-common.js';
import { toIso } from './util.js';

const MIN_MESSAGES = 2;
const MIN_CHARS = 40;
const TITLE_MAX = TITLE_MAX_CHARS; // D2(2026-09-17):46 → 58。旧值把一句话切成半句;此值仅作启发式失败时的兜底
const SUMMARY_FIRST_MAX = 140;

export function summarizeDsh(memory, { force = false } = {}) {
  const groups = memory.db.prepare(
    `SELECT session_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars,
            MIN(ts) AS t0, MAX(ts) AS t1, MAX(seq) AS maxSeq
     FROM dsh_turns_raw WHERE session_id NOT LIKE 'import:%' GROUP BY session_id`,
  ).all();
  const stats = { sessions: groups.length, created: 0, updated: 0, skipped: 0, watermarkSet: 0, archivedSkipped: 0 };
  // 归档即清理(2026-09-16 用户定:清掉归档会话,未归档的测试会话不动):
  // 已归档会话不再生成/重建概述 —— 否则清掉的会被下一轮概述器复活。force 仍可强制重建(CLI 显式动作)。
  const archived = new Set(
    memory.db.prepare('SELECT session_id FROM session_meta WHERE archived=1').all().map((r) => String(r.session_id)),
  );

  const firstUserStmt = memory.db.prepare(
    `SELECT text FROM dsh_turns_raw WHERE session_id=? AND role='user' ORDER BY seq ASC LIMIT 1`,
  );
  const laterUserStmt = memory.db.prepare( // D2:首句是「你好」「下午好」这类时,往后取有实义的首句
    `SELECT text FROM dsh_turns_raw WHERE session_id=? AND role='user' ORDER BY seq ASC LIMIT 6`,
  );
  const roleCountStmt = memory.db.prepare(
    `SELECT role, COUNT(*) AS n FROM dsh_turns_raw WHERE session_id=? GROUP BY role`,
  );

  for (const g of groups) {
    const sid = String(g.session_id);
    if (!force && archived.has(sid)) {
      stats.skipped += 1;
      stats.archivedSkipped += 1;
      continue;
    }
    const wmKey = 'sumdsh:' + sid;
    const wm = Number(memory.kvGet(wmKey) || 0);
    if (!force && wm >= Number(g.maxSeq)) {
      stats.skipped += 1;
      continue;
    }
    const roles = roleCountStmt.all(sid);
    const users = Number((roles.find((r) => r.role === 'user') || {}).n || 0);
    const asst = Number((roles.find((r) => r.role === 'assistant') || {}).n || 0);
    const eligible = users >= 1 && users + asst >= MIN_MESSAGES && Number(g.chars) >= MIN_CHARS;
    if (eligible) {
      const first = String(firstUserStmt.get(sid)?.text || '').trim();
      const oneLine = first.replace(/\s+/g, ' ');
      // D2(2026-09-17):标题不再硬截首句。旧行为 60 条 dsh 里 26 条被切成半句话
      // (「…继续走你的新生之路。 我刚刚对1.2.1的」),且「你好」「下午好」直接当标题。
      // 三层:剥称呼/问候前缀 → 不好则往后取有实义的首句 → 在句读处收尾。
      let title = heuristicTitle(oneLine);
      if (!title) {
        for (const t of laterUserStmt.all(sid).slice(1)) {
          title = heuristicTitle(String(t.text || ''));
          if (title) break;
        }
      }
      if (!title) title = oneLine.slice(0, TITLE_MAX);
      const summary = first.length > SUMMARY_FIRST_MAX ? oneLine.slice(0, SUMMARY_FIRST_MAX) + '…' : oneLine;
      const category = categorizeTitle(title);
      const keywords = keywordsFrom((title + ' ' + oneLine).slice(0, 400));
      const existing = memory.overviewById('dsh', sid);
      const deepDone = !!memory.kvGet('deep:' + sid);
      memory.upsertOverview({
        conv_id: sid,
        source: 'dsh',
        title: title || '(未命名会话)',
        // 修 A:MIN/MAX(ts) 在混合形态下会被遗留数字串带偏 —— 落库前一并归一为 ISO
        started_at: toIso(g.t0),
        updated_at: toIso(g.t1),
        domain_tags: [category === 'knowledge' ? '知识' : category === 'feeling' ? '生活' : '日常'],
        category,
        keywords,
        // 已深摘的会话保留深摘要,不因增量刷新被浅版覆盖
        summary: deepDone && existing ? existing.summary : `${summary} — ${users + asst} 条消息`,
        // G2(2026-09-17):概述器**不再往库里写** heat/importance/last_hit_at/hit_count ——
        // 这四个是本机用户态(置顶、命中、热度):旧行为每轮重建都写 0 且被 UPSERT 无条件覆盖,
        // 使置顶的删除保护(importance>=1)与热度排序同时失效。新建行由 upsertOverview 填默认 0。
        overview_ok: 1,
        origin: 'dsh-summarizer-v1',
      });
      if (existing) stats.updated += 1;
      else stats.created += 1;
    } else {
      stats.skipped += 1;
    }
    memory.kvSet(wmKey, String(g.maxSeq));
    stats.watermarkSet += 1;
  }
  if (groups.length) memory.kvSet('memory_version', String(Date.now()));
  return stats;
}
