// dsh-ling host — memory store (node:sqlite, zero deps).
// Schema per DESIGN §7. All access single-process (host).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ensureDir, sha256Text, utcIso, mergeDeep, toIso, toEpochMs } from './util.js';

const SCHEMA_VERSION = 4; // v4:title_by(定名者:user/ai);v3:title_locked;v2:conv_overview.source 放开 CHECK

/** 原文命名空间(G4/2026-09-17):dsh_turns_raw 无 source 维,DSH 会话与导入原文共表。
 *  若不隔离,概述器会把导入内容当成 DSH 会话重建(GROUP BY session_id 认领)→ 跨源双份;
 *  同 id 时更会互相覆盖原文(不可恢复)。故导入原文一律落 'import:<conv_id>'。
 *  历史数据(1.2.2 之前)的导入原文仍是裸 id —— 读取侧保留回退,写入侧一律带前缀。 */
export const RAW_IMPORT_PREFIX = 'import:';

/** 写入侧:按来源得出该会话原文应落的 session_id。 */
export function rawSessionId(source, convId) {
  const id = String(convId ?? '');
  if (String(source) === 'import' && id && !id.startsWith(RAW_IMPORT_PREFIX)) return RAW_IMPORT_PREFIX + id;
  return id;
}

/** 读取侧:候选 id 链(新前缀优先,旧裸 id 回退)。 */
export function rawSessionCandidates(source, convId) {
  const id = String(convId ?? '');
  if (id.startsWith(RAW_IMPORT_PREFIX)) return [id, id.slice(RAW_IMPORT_PREFIX.length)];
  return String(source) === 'import' ? [RAW_IMPORT_PREFIX + id, id] : [id];
}

const DDL = `
CREATE TABLE IF NOT EXISTS conv_overview (
  conv_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  updated_at TEXT,
  domain_tags TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'daily',
  keywords TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  heat REAL NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  overview_ok INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'local',
  title_locked INTEGER NOT NULL DEFAULT 0,
  title_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source, conv_id)
);
CREATE TABLE IF NOT EXISTS dsh_turns_raw (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  ts TEXT,
  model TEXT,
  text TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  mode TEXT,
  mode_updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  raw_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS feedback_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  rating TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS persona_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** v1→v2 迁移:conv_overview.source 曾带 CHECK(source IN ('dsweb','dsh')),
 *  文件导入需第三来源 → 检测旧 SQL 后整表重建(保留全部行与主键)。 */
function migrateSourceCheck(db) {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conv_overview'").get();
    const sql = row && typeof row.sql === 'string' ? row.sql : '';
    if (!sql.includes('source IN') || !sql.includes('CHECK')) return; // 已是新表
    db.exec('BEGIN');
    db.exec(`CREATE TABLE conv_overview_v2 (
      conv_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      updated_at TEXT,
      domain_tags TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL DEFAULT 'daily',
      keywords TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      heat REAL NOT NULL DEFAULT 0,
      importance INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      overview_ok INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (source, conv_id)
    )`);
    db.exec(`INSERT INTO conv_overview_v2
      (conv_id, source, title, started_at, updated_at, domain_tags, category, keywords,
       summary, heat, importance, last_hit_at, hit_count, overview_ok, origin)
      SELECT conv_id, source, title, started_at, updated_at, domain_tags, category, keywords,
       summary, heat, importance, last_hit_at, hit_count, overview_ok, origin
      FROM conv_overview`);
    db.exec('DROP TABLE conv_overview');
    db.exec('ALTER TABLE conv_overview_v2 RENAME TO conv_overview');
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    console.warn('[dsh-ling] conv_overview 迁移失败(忽略,以 IF NOT EXISTS 语义为准):', String(e?.message ?? e).slice(0, 200));
  }
}

/** v2→v3/v4:conv_overview 增列 title_locked + title_by(D2 2026-09-17 与用户定)。
 *  记忆的"名字"是这个系统的核心资产之一:概述器每轮重建与批量重命名都会覆盖 title,
 *  主人手改过的标题必须不被机器覆盖 —— 故加锁列,由 renameTitle() 置 1。
 *  title_by 记录"这个名字是谁定的":'user'=主人手改、'ai'=机器起名。
 *  界面(2026-09-17 用户定稿):三条路径统一显示「🔒 已定名」,归属只藏在水下的悬浮说明里 ——
 *  标题层是器灵"修枝剪叶"式的自我复盘,器灵与主人同级,不该在标记上分等级。 */
function migrateTitleCols(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(conv_overview)').all().map((c) => String(c.name));
    if (!cols.includes('title_locked')) db.exec('ALTER TABLE conv_overview ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('title_by')) db.exec("ALTER TABLE conv_overview ADD COLUMN title_by TEXT NOT NULL DEFAULT ''");
  } catch (e) {
    console.warn('[dsh-ling] title 列迁移失败(忽略):', String(e?.message ?? e).slice(0, 200));
  }
}

export class MemoryStore {
  constructor(dbPath) {
    ensureDir(dbPath.slice(0, Math.max(0, dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'))) || '.');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA busy_timeout=15000;');
    this.db.exec(DDL);
    migrateSourceCheck(this.db); // v1→v2:去掉 conv_overview.source 的两源 CHECK
    migrateTitleCols(this.db); // v2→v4:title_locked + title_by(主人改过的标题不被机器覆盖)
    this._kvGet = this.db.prepare('SELECT value FROM kv WHERE key=?');
    this._kvSet = this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    if (!this.kvGet('schema_version')) this.kvSet('schema_version', String(SCHEMA_VERSION));
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  // ---- kv ----
  kvGet(key) {
    const r = this._kvGet.get(key);
    return r ? r.value : undefined;
  }

  kvSet(key, value) {
    this._kvSet.run(key, String(value));
  }

  // ---- overviews ----
  /** 写入/更新一条概述(幂等)。
   *
   *  G2(2026-09-17):默认**不覆盖本机用户态字段** —— heat / importance / last_hit_at / hit_count。
   *  这四个是本机行为的产物:importance 是用户显式置顶、hit_count/last_hit_at 是运行时命中、
   *  heat 由 L1 运行时计算。而概述器每轮增量重建都会 upsertOverview(旧行为无条件
   *  `SET ...=excluded.*`)⇒ 每 15 分钟把置顶与命中打回 0,导致:
   *    ① cleanOverviewOnArchive/archivedOverviewCandidates 的 `importance>=1` 删除保护失效
   *       (置顶的归档会话被当普通会话清掉);
   *    ② 命中次数永远长不起来,热度排序失真。
   *  故 UPDATE 分支不再触碰这四列(保留库中现值);新行 INSERT 时仍用调用方给的初值。
   *  需要整行覆盖的显式场景(如"按备份原样恢复")传 `keepUserState: false`。
   */
  upsertOverview(row) {
    const r = row || {};
    // 保留调用方声明的来源(dsweb/dsh/import/…);v0 时期曾强制"非 dsh 即 dsweb"
    const source = String(r.source ?? '').trim() || 'dsweb';
    // 不变量(G4 补强,2026-09-17):`import:` 是本机导入域的**内部命名空间**,只允许配 source='import'。
    // 实锤教训:把导入原文的 session_id 改成 `import:<uuid>` 之后,仍在跑旧代码的概述器
    // (缺 NOT LIKE 过滤)把它当 DSH 会话,产出了 15 条 `source='dsh'` + `conv_id='import:<uuid>'`
    // 的镜像行 —— 跨源污染的二代形态(一代是裸 uuid 双份)。这里直接拒写。
    const convId = String(r.conv_id ?? '');
    if (source !== 'import' && convId.startsWith(RAW_IMPORT_PREFIX)) {
      console.warn('[dsh-ling] 拒绝跨源镜像行:', JSON.stringify({ source, conv_id: convId.slice(0, 40) }));
      return;
    }
    const userStateSet = r.keepUserState === false
      ? ` heat=excluded.heat, importance=excluded.importance,
          last_hit_at=excluded.last_hit_at, hit_count=excluded.hit_count,`
      : '';
    this.db.prepare(
      `INSERT INTO conv_overview
        (conv_id, source, title, started_at, updated_at, domain_tags, category, keywords, summary,
         heat, importance, last_hit_at, hit_count, overview_ok, origin)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source, conv_id) DO UPDATE SET
         title=CASE WHEN conv_overview.title_locked=1 THEN conv_overview.title ELSE excluded.title END,
         updated_at=excluded.updated_at,
         domain_tags=excluded.domain_tags, category=excluded.category, keywords=excluded.keywords,
         summary=excluded.summary,${userStateSet}
         overview_ok=excluded.overview_ok, origin=excluded.origin`,
    ).run(
      String(r.conv_id ?? ''), source, String(r.title ?? ''), r.started_at || null, r.updated_at || null,
      JSON.stringify(r.domain_tags ?? []), String(r.category ?? 'daily'),
      JSON.stringify(r.keywords ?? []), String(r.summary ?? ''),
      Number(r.heat ?? 0), Number(r.importance ?? 0), r.last_hit_at || null,
      Number(r.hit_count ?? 0), r.overview_ok ? 1 : 0, String(r.origin ?? 'local'),
    );
  }

  listOverviews({ limit, onlyOk, source } = {}) {
    let sql = 'SELECT * FROM conv_overview';
    const where = [];
    if (onlyOk) where.push('overview_ok=1');
    if (source) where.push('source=?');
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY hit_count DESC, importance DESC, updated_at DESC'; // D8:heat 恒 0,改用 hit_count
    if (limit) sql += ' LIMIT ' + Math.max(1, Math.min(1000, limit));
    const stmt = source ? this.db.prepare(sql) : this.db.prepare(sql);
    const rows = source ? stmt.all(source) : stmt.all();
    return rows.map(mapRow);
  }

  /** 记忆中心查询:过滤(source/category/q)+ 排序 + 分页;返回 {items,total}。
   *  source 不限 dsweb/dsh——文件导入等第三方来源(source='import')同样可按源过滤。 */
  queryOverviews({ source, category, q, sort = 'updated', limit = 100, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (source) {
      where.push('source=?');
      args.push(source);
    }
    if (category === 'knowledge' || category === 'daily' || category === 'feeling') {
      where.push('category=?');
      args.push(category);
    }
    const qs = q ? String(q).trim() : '';
    if (qs) {
      where.push('(title LIKE ? OR summary LIKE ? OR keywords LIKE ?)');
      const like = '%' + qs + '%';
      args.push(like, like, like);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = Math.max(1, Math.min(500, Number(limit) || 100));
    const off = Math.max(0, Number(offset) || 0);
    // D8(2026-09-17):`heat` 列恒为 0(L1 的 computeHeat 在运行时算、从不落库),
    // 旧写法 `heat DESC` 等价于不排序 —— 记忆中心的"热度"档点了等于没排。
    // 改用真实落库的热度代理:hit_count 为主、importance 次之。
    const orderSql = sort === 'created' ? 'started_at DESC' : sort === 'heat' ? 'hit_count DESC, importance DESC, updated_at DESC' : 'updated_at DESC';
    const total = this.db.prepare(`SELECT COUNT(*) n FROM conv_overview ${whereSql}`).get(...args).n;
    const rows = this.db.prepare(
      `SELECT * FROM conv_overview ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`,
    ).all(...args, lim, off);
    return { items: rows.map(mapRow), total: Number(total), limit: lim, offset: off };
  }

  /** 显式改名(D2):写 title 并上锁 —— 概述器重建、批量重命名此后都不再覆盖。
   *  `by` 记录定名者:'user'=主人手改 / 'ai'=机器起名(界面三条路径统一显示「已定名」,
   *  归属只进悬浮说明)。默认"写过的就是最终版";要交还机器可用 unlockTitle。 */
  renameTitle(source, convId, title, { lock = true, by = 'user' } = {}) {
    const t = String(title ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!t) return { ok: false, reason: 'empty-title' };
    const who = by === 'ai' ? 'ai' : 'user';
    const r = this.db.prepare('UPDATE conv_overview SET title=?, title_locked=?, title_by=? WHERE source=? AND conv_id=?')
      .run(t, lock ? 1 : 0, who, String(source), String(convId));
    return { ok: Number(r.changes) > 0, title: t, locked: !!lock, by: who };
  }

  unlockTitle(source, convId) {
    this.db.prepare('UPDATE conv_overview SET title_locked=0 WHERE source=? AND conv_id=?')
      .run(String(source), String(convId));
  }

  /** 各来源条数(D8):记忆中心筛选栏用它显示"历史网页端 (1523)"这类计数。 */
  sourceCounts() {
    const rows = this.db.prepare('SELECT source, COUNT(*) AS n FROM conv_overview GROUP BY source ORDER BY n DESC').all();
    const bySource = {};
    let total = 0;
    for (const r of rows) {
      bySource[String(r.source)] = Number(r.n);
      total += Number(r.n);
    }
    return { total, bySource };
  }

  setImportance(source, convId, importance) {
    this.db.prepare('UPDATE conv_overview SET importance=? WHERE source=? AND conv_id=?')
      .run(Number(importance) ? 1 : 0, String(source), String(convId));
  }

  deleteOverview(source, convId) {
    this.db.prepare('DELETE FROM conv_overview WHERE source=? AND conv_id=?')
      .run(String(source), String(convId));
  }

  /** 归档会话里"该清掉"的概述候选(2026-09-16 与用户定:清掉归档会话,未归档的测试会话不动)。
   *  默认保护两类:①置顶(importance≥1,用户显式要留)②已深摘(花过 LLM 且摘要更厚)。
   *  返回 {scanned, removable, kept};纯读,不改库。 */
  archivedOverviewCandidates({ protectPinned = true, protectDeep = true } = {}) {
    const rows = this.db.prepare(
      `SELECT o.conv_id, o.title, o.hit_count, o.importance, o.category, o.updated_at,
              (SELECT COUNT(*) FROM dsh_turns_raw t WHERE t.session_id = o.conv_id) AS turns
         FROM conv_overview o JOIN session_meta m ON m.session_id = o.conv_id
        WHERE o.source='dsh' AND m.archived=1
        ORDER BY o.updated_at DESC`,
    ).all().map(mapRow);
    const removable = [];
    const kept = [];
    for (const r of rows) {
      if (protectPinned && Number(r.importance) >= 1) { kept.push({ ...r, reason: 'pinned' }); continue; }
      if (protectDeep && this.kvGet('deep:' + r.conv_id)) { kept.push({ ...r, reason: 'deep' }); continue; }
      removable.push(r);
    }
    return { scanned: rows.length, removable, kept };
  }

  /** 归档即清理:会话被归档时,若其概述未被保护则删掉(原文保留 —— 那是走过的路)。
   *  返回 {removed:boolean, reason}。 */
  cleanOverviewOnArchive(sessionId) {
    const sid = String(sessionId);
    const ov = this.overviewById('dsh', sid);
    if (!ov) return { removed: false, reason: 'no-overview' };
    if (Number(ov.importance) >= 1) return { removed: false, reason: 'pinned' };
    if (this.kvGet('deep:' + sid)) return { removed: false, reason: 'deep' };
    this.deleteOverview('dsh', sid);
    return { removed: true, reason: 'archived' };
  }

  overviewById(source, convId) {
    const r = this.db.prepare('SELECT * FROM conv_overview WHERE source=? AND conv_id=?').get(source, String(convId));
    return r ? mapRow(r) : undefined;
  }

  bumpHit(source, convId) {
    this.db.prepare(
      'UPDATE conv_overview SET hit_count=hit_count+1, last_hit_at=? WHERE source=? AND conv_id=?',
    ).run(utcIso(), source, String(convId));
  }

  // ---- raw turns (DSH incremental capture, passive) ----
  appendRawTurn(sessionId, { seq, role, ts, model, text }) {
    if (!sessionId || typeof text !== 'string' || !text) return;
    this.db.prepare(
      `INSERT INTO dsh_turns_raw (session_id, seq, role, ts, model, text)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id, seq) DO UPDATE SET text=excluded.text`,
      // 写侧归一(修 A):一律存 ISO;数字/浮点串(如 "1789006881011.0")也归一后再落库。
    ).run(String(sessionId), Number(seq), String(role ?? '?'), toIso(ts), model || null, text);
    this.db.prepare(
      'INSERT INTO session_meta(session_id, raw_seq) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET raw_seq=excluded.raw_seq',
    ).run(String(sessionId), Number(seq));
    // 会话复活(2026-09-16):归档过的会话一旦有新轮次 → 清归档标记,概述器会按水位重建它的概述。
    this.db.prepare('UPDATE session_meta SET archived=0 WHERE session_id=? AND archived=1').run(String(sessionId));
  }

  rawTurnCount(sessionId) {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM dsh_turns_raw WHERE session_id=?').get(String(sessionId));
    return r ? Number(r.n) : 0;
  }

  rawSessionCount() {
    const r = this.db.prepare('SELECT COUNT(DISTINCT session_id) AS n FROM dsh_turns_raw').get();
    return r ? Number(r.n) : 0;
  }

  // ---- session meta ----
  sessionMeta(sessionId) {
    const r = this.db.prepare('SELECT * FROM session_meta WHERE session_id=?').get(String(sessionId));
    return r || { session_id: String(sessionId), mode: null, archived: 0, raw_seq: 0 };
  }

  setSessionMode(sessionId, mode) {
    this.db.prepare(
      `INSERT INTO session_meta(session_id, mode, mode_updated_at) VALUES(?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode, mode_updated_at=excluded.mode_updated_at`,
    ).run(String(sessionId), mode, utcIso());
  }

  /** 清空会话模式(空会话回到"跟随当前默认"的语义;修法 A)。 */
  clearSessionMode(sessionId) {
    this.db.prepare('UPDATE session_meta SET mode=NULL, mode_updated_at=? WHERE session_id=?')
      .run(utcIso(), String(sessionId));
  }

  /** 该会话是否已有真人轮次(空壳/空会话判定)。 */
  hasUserTurns(sessionId) {
    const r = this.db.prepare("SELECT COUNT(*) n FROM dsh_turns_raw WHERE session_id=? AND role='user'").get(String(sessionId));
    return Number(r?.n || 0) > 0;
  }

  /** 最近一次"用户说话"的时间(ISO;供时间锚使用)。
   *  修 A:库里混着 ISO 与遗留数字串(`"1789006881011.0"`),文本排序不可靠 ——
   *  ISO 形态取 SQL 最大值,数字形态逐个归一后比大小,两边取较新者。 */
  lastUserTurnAt() {
    const isoRow = this.db.prepare(
      "SELECT ts FROM dsh_turns_raw WHERE role='user' AND ts LIKE '____-__-__%' ORDER BY ts DESC LIMIT 1",
    ).get();
    let bestMs = isoRow ? toEpochMs(isoRow.ts) : null;
    let bestIso = isoRow ? toIso(isoRow.ts) : null;
    const others = this.db.prepare(
      "SELECT ts FROM dsh_turns_raw WHERE role='user' AND ts IS NOT NULL AND ts<>'' AND ts NOT LIKE '____-__-__%'",
    ).all();
    for (const r of others) {
      const ms = toEpochMs(r.ts);
      if (ms === null) continue;
      if (bestMs === null || ms > bestMs) {
        bestMs = ms;
        bestIso = new Date(ms).toISOString();
      }
    }
    return bestIso;
  }

  markArchived(sessionId) {
    this.db.prepare(
      'INSERT INTO session_meta(session_id, archived) VALUES(?,1) ON CONFLICT(session_id) DO UPDATE SET archived=1',
    ).run(String(sessionId));
  }

  // ---- feedback queue(成长回路) ----
  addFeedback(row) {
    this.db.prepare(
      `INSERT INTO feedback_queue(created_at, session_id, message_id, rating, note, status)
       VALUES (?,?,?,?,?,'new')`,
    ).run(row.created_at || utcIso(), String(row.session_id ?? ''), String(row.message_id ?? ''), String(row.rating ?? 'negative'), String(row.note ?? ''));
  }

  listFeedback({ status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM feedback_queue WHERE status=? ORDER BY id DESC').all(status)
      : this.db.prepare('SELECT * FROM feedback_queue ORDER BY id DESC').all();
    return rows.map((r) => ({
      id: r.id, created_at: r.created_at, session_id: r.session_id, message_id: r.message_id,
      rating: r.rating, note: r.note, status: r.status,
    }));
  }

  getFeedback(id) {
    const r = this.db.prepare('SELECT * FROM feedback_queue WHERE id=?').get(Number(id));
    return r ? {
      id: r.id, created_at: r.created_at, session_id: r.session_id, message_id: r.message_id,
      rating: r.rating, note: r.note, status: r.status,
    } : null;
  }

  setFeedbackStatus(id, status) {
    this.db.prepare('UPDATE feedback_queue SET status=? WHERE id=?').run(String(status), Number(id));
  }

  countFeedback(status) {
    const r = this.db.prepare('SELECT COUNT(*) n FROM feedback_queue WHERE status=?').get(String(status));
    return r ? Number(r.n) : 0;
  }

  // ---- persona suggestions(语料提炼建议) ----
  addPersonaSuggestion({ kind, value, note, evidence }) {
    this.db.prepare(
      `INSERT INTO persona_suggestions(created_at, kind, value, note, evidence, status)
       VALUES (?,?,?,?,?,'new')`,
    ).run(utcIso(), String(kind), String(value ?? ''), String(note ?? ''), JSON.stringify(evidence ?? {}));
  }

  hasPersonaSuggestion(kind, value) {
    const r = this.db.prepare('SELECT id FROM persona_suggestions WHERE kind=? AND value=?').get(String(kind), String(value));
    return !!r;
  }

  listPersonaSuggestions({ status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM persona_suggestions WHERE status=? ORDER BY id DESC').all(String(status))
      : this.db.prepare('SELECT * FROM persona_suggestions ORDER BY id DESC').all();
    return rows.map(mapSuggestion);
  }

  getPersonaSuggestion(id) {
    const r = this.db.prepare('SELECT * FROM persona_suggestions WHERE id=?').get(Number(id));
    return r ? mapSuggestion(r) : null;
  }

  setPersonaSuggestionStatus(id, status) {
    this.db.prepare('UPDATE persona_suggestions SET status=? WHERE id=?').run(String(status), Number(id));
  }

  countPersonaSuggestion(status) {
    const r = this.db.prepare('SELECT COUNT(*) n FROM persona_suggestions WHERE status=?').get(String(status));
    return r ? Number(r.n) : 0;
  }

  // ---- export / import (DESIGN §8;v2 范围:概述/队列/建议/深快照;人格由 API 层附载) ----
  kvList(prefix) {
    return this.db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key").all(prefix + '%');
  }

  kvDel(key) {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(String(key));
  }

  exportBundle({ includeRaw = false } = {}) {
    const overviews = this.db.prepare('SELECT * FROM conv_overview ORDER BY source, conv_id').all().map(mapRow);
    const deep = this.kvList('deep').map((r) => ({ key: r.key, value: r.value }));
    const body = {
      format: 'dsh-ling-memory',
      schemaVersion: SCHEMA_VERSION,
      exportScope: 2,
      exportedAt: utcIso(),
      sourceFingerprint: sha256Text(JSON.stringify(overviews)),
      origin: 'local-default',
      overviews,
      feedbackQueue: this.listFeedback().map((it) => ({
        created_at: it.created_at, session_id: it.session_id, message_id: it.message_id,
        rating: it.rating, note: it.note, status: it.status,
      })),
      suggestions: this.listPersonaSuggestions().map((it) => ({
        kind: it.kind, value: it.value, note: it.note, evidence: it.evidence, status: it.status, created_at: it.created_at,
      })),
      deep,
    };
    if (includeRaw) {
      body.rawTurns = this.db.prepare('SELECT * FROM dsh_turns_raw ORDER BY session_id, seq').all();
    }
    return body;
  }

  /** 合并(DESIGN §8 v2):概述幂等;队列/建议按内容去重追加;deep 仅在目标存在对应概述时恢复。 */
  importBundle(bundle, { overwrite = false } = {}) {
    const report = { added: 0, skipped: 0, overwritten: 0, queueAdded: 0, queueSkipped: 0, suggAdded: 0, suggSkipped: 0, deepRestored: 0, deepSkipped: 0, errors: 0 };
    if (!bundle || bundle.format !== 'dsh-ling-memory') {
      report.errors = 1;
      return report;
    }
    for (const row of bundle.overviews || []) {
      try {
        // 来源保真:与 upsertOverview 同口径 —— 只有缺省才退回 dsweb。
        // (旧代码 `row.source === 'dsh' ? 'dsh' : 'dsweb'` 会把「文件导入(import)」错标成「网页端」)
        const src = String(row.source ?? '').trim() || 'dsweb';
        const existing = this.overviewById(src, row.conv_id);
        if (existing && !overwrite) {
          report.skipped += 1;
          continue;
        }
        this.upsertOverview({ ...row, origin: row.origin || bundle.origin || 'imported' });
        if (existing) report.overwritten += 1;
        else report.added += 1;
      } catch (e) {
        report.errors += 1;
      }
    }
    const hasFbStmt = this.db.prepare('SELECT COUNT(*) n FROM feedback_queue WHERE session_id=? AND message_id=?');
    for (const q of bundle.feedbackQueue || []) {
      const dup = hasFbStmt.get(String(q.session_id ?? ''), String(q.message_id ?? '')).n > 0;
      if (dup || !q.session_id || !q.message_id) {
        report.queueSkipped += 1;
        continue;
      }
      this.addFeedback({ session_id: q.session_id, message_id: q.message_id, rating: q.rating || 'negative', note: q.note || '', created_at: q.created_at });
      report.queueAdded += 1;
    }
    for (const s of bundle.suggestions || []) {
      if (!s.kind || !s.value || this.hasPersonaSuggestion(s.kind, s.value)) {
        report.suggSkipped += 1;
        continue;
      }
      this.addPersonaSuggestion({ kind: s.kind, value: s.value, note: s.note || '', evidence: s.evidence || {} });
      report.suggAdded += 1;
    }
    for (const d of bundle.deep || []) {
      const key = String(d.key || '');
      if (!key.startsWith('deep')) {
        report.deepSkipped += 1;
        continue;
      }
      const sid = key.slice(key.indexOf(':') + 1);
      const overview = this.overviewById('dsh', sid);
      if (key.startsWith('deep:') && (!overview || this.kvGet(key))) {
        report.deepSkipped += 1;
        continue;
      }
      if (overview && !this.kvGet(key)) {
        this.kvSet(key, String(d.value ?? ''));
        report.deepRestored += 1;
      } else {
        report.deepSkipped += 1;
      }
    }
    return report;
  }

  fingerprint() {
    const rows = this.db.prepare('SELECT * FROM conv_overview ORDER BY source, conv_id').all();
    return sha256Text(JSON.stringify(rows.map(mapRow)));
  }
}

function mapRow(r) {
  return {
    conv_id: r.conv_id,
    source: r.source,
    title: r.title,
    started_at: r.started_at,
    updated_at: r.updated_at,
    domain_tags: safeJson(r.domain_tags, []),
    category: r.category,
    keywords: safeJson(r.keywords, []),
    summary: r.summary,
    heat: r.heat,
    importance: r.importance,
    last_hit_at: r.last_hit_at,
    hit_count: r.hit_count,
    overview_ok: !!r.overview_ok,
    origin: r.origin,
    title_locked: !!r.title_locked,
    title_by: r.title_by || '',
  };
}

function safeJson(s, fb) {
  try {
    return JSON.parse(s);
  } catch {
    return fb;
  }
}

function mapSuggestion(r) {
  return {
    id: r.id,
    created_at: r.created_at,
    kind: r.kind,
    value: r.value,
    note: r.note,
    evidence: safeJson(r.evidence, {}),
    status: r.status,
  };
}
