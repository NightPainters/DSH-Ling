// dsh-ling host — DSH 会话概述器 v1(轻量)。
// 把 dsh_turns_raw 中**属于 DSH 命名空间**的每个顶层会话聚合成 source='dsh' 的 conv_overview
//   (范围判据是正向白名单,唯一一处定义见下方 E2 段;未知来源一律排除并留 kv 告警):
//   title = 首条真人消息经启发式清洗后的要点句(剥问候/称呼前缀 → 无实义则往后取前 6 条真人发言里第一条有实义的 → 句读处收尾、不切半句、上限 58 字;全失败才硬截首句);summary = 首问(≤140 字)+ 轮次;类别/关键词启发式。
// 增量:每会话水位 kv('sumdsh:<sid>') = 已概述的最大 seq;有新增才重建。
// 无 LLM 深摘要(v1);原文保留在 dsh_turns_raw,供 M2 概述升级。
import { categorizeTitle } from './classify.js';
import { heuristicTitle, TITLE_MAX_CHARS } from './retitle.js';
import { keywordsFrom } from './inject-common.js';
import { toIso } from './util.js';
import { RAW_IMPORT_PREFIX, RAW_NS_SEP, RAW_SOURCE_DSH, normalizeRawSource } from './memory.js';

const MIN_MESSAGES = 2;
const MIN_CHARS = 40;
const TITLE_MAX = TITLE_MAX_CHARS; // D2(2026-09-17):46 → 58。旧值把一句话切成半句;此值仅作启发式失败时的兜底
const SUMMARY_FIRST_MAX = 140;

// ── E2(2026-10-01)「静默失效」修复:原文范围判据 = 正向白名单(全包唯一一处定义)────────
// 旧判据是黑名单式:把「已知的那一个外来命名空间(`import:` 前缀)」排除掉,其余**全部**当真
// DSH 会话。它的致命处不在漏了谁,而在**默认信任**:任何没见过的来源(别的导入器、别的域的
// 同步、将来新增的命名空间)都会被概述器当成主人的会话重建、被习惯生成当成主人的纠正信号。
// 审计原话:「最该被质疑的内容带着最真诚的标记」。
// 这里反过来 —— 只有**明确落在 DSH 宿主命名空间**里的 id 才入选,其余一律排除;而且未知前缀
// 不是"悄悄丢掉",而是写一条 kv 告警(见 noteUnknownRawNamespaces),让人能发现
// "有东西进来了,而我不知道它是什么"。
//
// 事实依据(写入侧,2026-10-01 核对):写入者只有三处 ——
//   · 裸 id         :DSH 宿主会话轮次(lifecycle.js 的 appendRawTurn,source 显式记 'dsh')= 唯一的"自己人"命名空间;
//   · `import:<id>` :本机导入域原文(memory.js RAW_IMPORT_PREFIX,source 'import')= 别人的对话,不属于主人;
//   · import-file.js 的 dsweb 折叠分支(2026-09-30 修 A):原文写进**裸 id**(与 dsweb 抓取同源)。
// 故:DSH 自己的来源 = { RAW_SOURCE_DSH('dsh') };已知外来 = KNOWN_FOREIGN_RAW_NAMESPACES / …_SOURCES。
//
// ── v14(2026-10-01,主人拍板「来源也加个列吧」):判据从"只看 id 长相"升级为 source 优先 ─────
// 加列前:命名空间信息**只存在于 id 文本里**(表结构所限),判据只能写成"id 不带前缀",于是将来
//   出现一个**不带冒号**的新来源名时,物理上分不出来(会被当主人的会话认领)。
// 加列后:`dsh_turns_raw.source` 记下**真实来源**,判据改成 ——
//   · source 非空 ⇒ 只认 `source='dsh'`(记录优先;不带冒号的新来源名照样能被认出并排除 + 告警);
//   · source 为空 ⇒ **回落**到旧判据"裸 id = DSH 会话"(半迁移:老行还没回填,两种行为不许并存)。
// ⚠️ 口径不变的保证(负对照):真 DSH 会话(lifecycle 写的 'dsh' + 老行的裸 id 回落)在迁移前后
//    的处理结果**逐字一致** —— 回归见 tests/summarize.test.mjs 的 E2 golden 与 E3 段。
export const DSH_RAW_NAMESPACE = '';   // 空串 = 裸 id(DSH 宿主会话)
export { RAW_NS_SEP };                 // 分隔符的唯一定义处是 memory.js;这里再导出以保持既有导入面
/** 已知的**外来**(非 DSH)原文命名空间。只用于区分"已知外来"与"未知来源",不用于放行任何东西。 */
export const KNOWN_FOREIGN_RAW_NAMESPACES = Object.freeze([RAW_IMPORT_PREFIX]);
/** 同一批来源的**名字**(去尾冒号:`import:` ⇒ `import`)。v14 之后 source 列记的就是这个形态。 */
export const KNOWN_FOREIGN_RAW_SOURCES = Object.freeze(
  KNOWN_FOREIGN_RAW_NAMESPACES.map((ns) => String(ns).replace(/:+$/, '')),
);

/** 正向判据的 **id 文本形态** —— 也是**半迁移的回落分支**:该 session_id 落在 DSH 命名空间吗?
 *  ⚠️ v14 起它**不再单独决定**某一行是否入选(整行判据是 isDshRawRow / dshSessionSql())。
 *  语义一个字未改(既有断言与本模块 4 条查询的回落口径都钉在它上面)。 */
export function isDshSessionId(sessionId) {
  const id = String(sessionId ?? '');
  return id !== '' && !id.includes(RAW_NS_SEP);
}

/** 整行判据(JS 形态,id + source):**source 优先,空 source 回落旧判据**。
 *  与 SQL 形态(dshSessionSql() 零参)必须同解 —— 两处任一改动都要在 tests/summarize.test.mjs
 *  的"两形态同解"断言上过一遍。 */
export function isDshRawRow(sessionId, source) {
  const src = normalizeRawSource(source);
  return src ? src === RAW_SOURCE_DSH : isDshSessionId(sessionId);
}

/** 同一判据的 SQL 形态(4 条原文查询共用这一份;列名可换,判据不许再分叉)。
 *  · **零参**(4 条查询用的形态)= 整行判据:`source` 优先,空 source 回落旧判据;
 *  · **带参**(既有调用点 `dshSessionSql('?')`)= id 纯函数形态 `instr(?, ':') = 0`,**逐字未变** ——
 *    那个调用点跑在不 FROM 任何表的 SELECT 里(tests/summarize.test.mjs 的两形态同解探针),
 *    那里**没有 source 列可读**,若把 source 判据也塞进去只会换来 "no such column: source"。
 *    故按**实参个数**分派:带参形态与整行判据的**回落分支**是同一个表达式,不是第二套口径。
 *  `instr(id, sep) = 0` 即"该 id 没有命名空间前缀 ⇒ 落在 DSH_RAW_NAMESPACE"。 */
export function dshSessionSql(col = null) {
  const idOnly = `instr(${col ?? 'session_id'}, '${RAW_NS_SEP}') = 0`;   // RAW_NS_SEP 是模块常量(非外部输入),无引号注入面
  if (col !== null) return idOnly;
  return `(CASE WHEN NULLIF(TRIM(source), '') IS NOT NULL THEN TRIM(source) = '${RAW_SOURCE_DSH}' ELSE ${idOnly} END)`;
}

/** 取 id 的命名空间前缀;裸 id 返回 DSH_RAW_NAMESPACE。 */
export function rawNamespaceOf(sessionId) {
  const id = String(sessionId ?? '');
  const i = id.indexOf(RAW_NS_SEP);
  return i < 0 ? DSH_RAW_NAMESPACE : id.slice(0, i + RAW_NS_SEP.length);
}

/** 未知来源告警的 kv 键(沿用 lifecycle.js 的 `dbg.*` 诊断约定,同一族键同一读法)。 */
export const RAW_UNKNOWN_NS_KEY = 'dbg.raw_unknown_namespace';

/**
 * 「有东西进来了,而我不知道它是什么」—— 扫一遍原文表里出现过的 (session_id, source),凡**不属于**
 * DSH 来源、又**不在**已知外来来源里的,写一条 kv 告警。
 *
 * 为什么必须有这一步:黑名单→白名单的真正代价是**未知来源从"被误信"变成"被静默丢弃"**。
 * 少了告警,新来源进来只会表现为"记忆莫名其妙变少",没人查得出来 —— 那只是把一种静默失效
 * 换成另一种。这条 kv 就是那个看得见的响动:面板/诊断里能读到"见过来源 X(样本 id、
 * 条数、首次/最近时间)"。同一来源**首次**出现时额外打一行 console.warn,便于当场发现。
 *
 * ── v14(2026-10-01)口径变化:告警报的是**来源名**,不再是"从前缀猜出来的字符串" ──────────
 *   · 带冒号的 id:键沿用**前缀串**(`weird:`),键形不因本次升级而变 ⇒ 老告警记录能直接续上;
 *   · 不带冒号的 id:旧判据**只能**把它当 DSH 会话(物理上分不出来);现在只要它带着别的来源名
 *     落库,键就是**那个来源名**(`weird-x`)—— 这类来源正是加这一列要照出来的东西;
 *   · 每条多记两个字段:`source`(该行记录的来源名;null = 这行还没回填)与
 *     `by`('source' = 靠记录认出来的 / 'id-prefix' = 靠 id 前缀认出来的),读的人能分清
 *     "这是它自己说的"还是"这是我猜的"。
 * 只在确有未知来源时才写(库干净时一个字节都不写 ⇒ 正常路径零副作用);读库失败一律静默
 * (告警不能拖累概述与习惯生成)。
 * @returns {string[]} 本次发现的未知来源(按条数降序)
 */
export function noteUnknownRawNamespaces(memory, where = '') {
  let rows = [];
  try {
    rows = memory?.db?.prepare?.(
      'SELECT session_id, source, COUNT(*) AS n FROM dsh_turns_raw GROUP BY session_id, source',
    )?.all?.() || [];
  } catch { return []; }
  const found = new Map();
  for (const r of rows) {
    const sid = String(r?.session_id ?? '');
    const src = normalizeRawSource(r?.source);   // '' = 该行还没回填(半迁移)
    if (isDshRawRow(sid, src)) continue;         // 整行判据,与 4 条查询同解
    const ns = rawNamespaceOf(sid);              // id 前缀('' = 裸 id)
    const key = ns || src;                       // 键:优先 id 前缀(键形稳定);裸 id 只能报记录下来的来源名
    if (KNOWN_FOREIGN_RAW_NAMESPACES.includes(key) || KNOWN_FOREIGN_RAW_SOURCES.includes(src)) continue;
    const cur = found.get(key) || { ns: key, source: src || null, by: src ? 'source' : 'id-prefix', turns: 0, samples: [] };
    cur.turns += Number(r?.n) || 0;
    if (cur.samples.length < 3) cur.samples.push(sid.slice(0, 64));
    found.set(key, cur);
  }
  const list = [...found.values()].sort((a, b) => (b.turns - a.turns) || a.ns.localeCompare(b.ns));
  if (!list.length) return [];
  try {
    let prev = null;
    try { const raw = memory?.kvGet?.(RAW_UNKNOWN_NS_KEY); prev = raw ? JSON.parse(String(raw)) : null; } catch { prev = null; }
    const prevNs = (prev && typeof prev === 'object' && prev.namespaces && typeof prev.namespaces === 'object') ? prev.namespaces : {};
    const namespaces = { ...prevNs };
    const now = new Date().toISOString();
    const fresh = [];
    for (const u of list) {
      const old = (namespaces[u.ns] && typeof namespaces[u.ns] === 'object') ? namespaces[u.ns] : null;
      if (!old) fresh.push(u.ns);
      namespaces[u.ns] = {
        turns: Number(old?.turns || 0) + u.turns,
        samples: [...new Set([...(Array.isArray(old?.samples) ? old.samples : []), ...u.samples])].slice(0, 3),
        // v14:来源名 + 认定方式(旧记录没有这两个字段 ⇒ 保留旧值 / 置 null,不伪造)
        source: u.source ?? (old && 'source' in old ? old.source : null),
        by: u.by || old?.by || null,
        firstSeenAt: old?.firstSeenAt || now,
        lastSeenAt: now,
      };
    }
    // 只保留最近 20 个命名空间(整段 JSON 不截断,否则读者解析不出来)
    const kept = Object.fromEntries(Object.entries(namespaces).slice(-20));
    memory?.kvSet?.(RAW_UNKNOWN_NS_KEY, JSON.stringify({
      at: now,
      where: String(where || '').slice(0, 60),
      note: 'dsh_turns_raw 里出现了既不属于 DSH 来源、也不在已知外来来源列表里的原文;'
        + '已一律排除(判据见 summarizer.js isDshRawRow/dshSessionSql:source 优先,空 source 回落"裸 id");'
        + '键 = id 的命名空间前缀,裸 id 时 = 该行记录下来的来源名(source 为空的行不会出现在这里)。留痕供人判断它是什么。',
      namespaces: kept,
    }));
    if (fresh.length) {
      console.warn('[dsh-ling] 原文表出现未知来源,已排除:', fresh.join(', '),
        JSON.stringify(list.filter((u) => fresh.includes(u.ns))
          .map((u) => ({ ns: u.ns, source: u.source, by: u.by, turns: u.turns, sample: u.samples[0] }))));
    }
  } catch { /* 告警写不进去不影响主流程 */ }
  return list.map((u) => u.ns);
}

export function summarizeDsh(memory, { force = false } = {}) {
  // E2:先看一眼有没有"不认识的东西"进来了(未知来源命名空间 → kv 告警)。库干净时零写入。
  noteUnknownRawNamespaces(memory, 'summarizer.summarizeDsh');
  const groups = memory.db.prepare(
    `SELECT session_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars,
            MIN(ts) AS t0, MAX(ts) AS t1, MAX(seq) AS maxSeq
     FROM dsh_turns_raw WHERE ${dshSessionSql()} GROUP BY session_id`,
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
