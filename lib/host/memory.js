// dsh-ling host — memory store (node:sqlite, zero deps).
// Schema per DESIGN §7. All access single-process (host).
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, sha256Text, utcIso, mergeDeep, toIso, toEpochMs } from './util.js';

const SCHEMA_VERSION = 9; // v9:tree_snapshot(树的保存/恢复 R1);v8:conv_branch(非会话源的枝归属覆盖层,方案 A);v7:branch_log(复盘留痕);v6:vein_link + memory_conflict(D9-b 树的生长);v5:branch(记忆分枝 D9-a);v4:title_by(定名者:user/ai);v3:title_locked;v2:conv_overview.source 放开 CHECK

/** 主干枝 id(D9-a 记忆分枝,2026-09-18):存量会话与记忆天然属于主干。 */
export const TRUNK_ID = 'trunk';

/** 血缘档位(用户 2026-09-18 定档 1.0/0.7/0.4)。
 *  取"最弱环"单值,不做连乘 —— `0.7^5=0.168`、`0.4^5=0.010`,连乘会让深枝等于从记忆里消失,
 *  且每层舍入都会乘进后面。单值 + 有界,权重才可解释、可复现。 */
export const LINEAGE_SAME = 1.0; // 同枝
export const LINEAGE_ANCESTOR = 0.7; // 枝读其祖先(直系血缘:主干就是这条枝的历史)
export const LINEAGE_SIDE = 0.4; // 旁系 / 祖先读后代(枝的内容不构成主干的记忆)
export const CONFLICT_DOWNWEIGHT = 0.3; // 矛盾败方降权系数(D9-b:未复盘时以最新为准,旧的一方乘此值)

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

/** 本地时间戳(MM-DD HH:mm)。快照默认命名用它 —— utcIso 是 UTC,给主人看的名字应走本地时间。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  raw_seq INTEGER NOT NULL DEFAULT 0,
  branch_id TEXT NOT NULL DEFAULT 'trunk'
);
CREATE TABLE IF NOT EXISTS branch (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'branch',
  parent_id    TEXT,
  fork_at      TEXT,
  fork_seq     INTEGER,
  name_locked  INTEGER NOT NULL DEFAULT 0,
  weight_scale REAL NOT NULL DEFAULT 1.0,
  visibility   TEXT NOT NULL DEFAULT 'lineage',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);
-- v6(D9-b 树的生长,2026-09-19):横向连边。刻意不叫"合并" —— 任何树操作都不改写记忆内容。
CREATE TABLE IF NOT EXISTS vein_link (
  from_branch  TEXT NOT NULL,
  to_branch    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'related',   -- related | prerequisite | contrast
  note         TEXT NOT NULL DEFAULT '',          -- 为什么连(复盘时写)
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_branch, to_branch)
);
-- v6:矛盾标记层。检出矛盾但**不改写任何内容**;未复盘时以"最新为准"(检索侧降权旧的一方)。
CREATE TABLE IF NOT EXISTS memory_conflict (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  a_source     TEXT NOT NULL,
  a_conv_id    TEXT NOT NULL,
  b_source     TEXT NOT NULL,
  b_conv_id    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'contradict', -- contradict | duplicate | supersede
  detected_by  TEXT NOT NULL DEFAULT 'heuristic',  -- heuristic | llm | user
  score        REAL,                               -- 相似度(检出时)
  reason       TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending | confirmed | dismissed
  winner_side  TEXT,                               -- 'a' | 'b' | NULL=未裁定(以最新为准)
  resolved_at  TEXT,
  UNIQUE(a_source, a_conv_id, b_source, b_conv_id)
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
CREATE TABLE IF NOT EXISTS branch_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  action     TEXT NOT NULL,
  before_val TEXT NOT NULL DEFAULT '',
  after_val  TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS conv_branch (
  source     TEXT NOT NULL,
  conv_id    TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, conv_id)
);
CREATE TABLE IF NOT EXISTS tree_snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL
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

/** v4→v5:记忆分枝(D9-a,2026-09-18 用户定方向)。
 *  session_meta 加 branch_id(默认 'trunk' —— 存量会话天然属主干,迁移只填一列);
 *  建 branch 表并保证主干行存在。**记忆行不冗余存 branch**,靠 session → branch 推导:
 *  迁移成本最低,且枝归属变化时无需回写海量记忆行。 */
function migrateBranchCols(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(session_meta)').all().map((c) => String(c.name));
    if (!cols.includes('branch_id')) {
      db.exec("ALTER TABLE session_meta ADD COLUMN branch_id TEXT NOT NULL DEFAULT 'trunk'");
    }
    const now = utcIso();
    db.prepare(`INSERT INTO branch (id,name,kind,parent_id,created_at,updated_at)
      VALUES (?,?,?,NULL,?,?) ON CONFLICT(id) DO NOTHING`).run(TRUNK_ID, '主干', 'trunk', now, now);
  } catch (e) {
    console.warn('[dsh-ling] branch 迁移失败(忽略):', String(e?.message ?? e).slice(0, 200));
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
    migrateBranchCols(this.db); // v4→v5:branch 表 + session_meta.branch_id(记忆分枝 D9-a)
    this._kvGet = this.db.prepare('SELECT value FROM kv WHERE key=?');
    this._kvSet = this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    // schema_version 必须跟随真实结构更新,不能只写一次:
    // v5 加了 branch 表与 session_meta.branch_id,若仍留 '4',后续会话会误判库结构。
    // v6 加 vein_link + memory_conflict 两张新表(纯新增,无 ALTER,DDL 的 IF NOT EXISTS 即迁移)。
    if (this.kvGet('schema_version') !== String(SCHEMA_VERSION)) this.kvSet('schema_version', String(SCHEMA_VERSION));
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  // ---- branch(记忆分枝 D9-a,2026-09-18) ----

  /** 会话所属枝(无记录 → 主干)。 */
  branchOfSession(sessionId) {
    try {
      const row = this.db.prepare('SELECT branch_id FROM session_meta WHERE session_id=?').get(String(sessionId));
      return row && row.branch_id ? String(row.branch_id) : TRUNK_ID;
    } catch {
      return TRUNK_ID;
    }
  }

  /** 把会话挂到枝上(该会话无 meta 行时补建)。 */
  setSessionBranch(sessionId, branchId) {
    const sid = String(sessionId);
    const bid = String(branchId || TRUNK_ID);
    this.db.prepare(`INSERT INTO session_meta (session_id, branch_id) VALUES (?,?)
      ON CONFLICT(session_id) DO UPDATE SET branch_id=excluded.branch_id`).run(sid, bid);
    return bid;
  }

  /** 建枝(幂等);返回枝 id。缺省 id = `br:<uuid>`。 */
  createBranch({ id = null, name = '', kind = 'branch', parentId = TRUNK_ID, forkAt = null, forkSeq = null, visibility = 'lineage' } = {}) {
    const bid = String(id || ('br:' + randomUUID()));
    const now = utcIso();
    this.db.prepare(`INSERT INTO branch
      (id,name,kind,parent_id,fork_at,fork_seq,visibility,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO NOTHING`)
      .run(
        bid,
        String(name || ''),
        String(kind || 'branch'),
        parentId ? String(parentId) : null,
        forkAt ? String(forkAt) : null,
        Number.isFinite(Number(forkSeq)) ? Number(forkSeq) : null,
        String(visibility || 'lineage'),
        now,
        now,
      );
    return bid;
  }

  /** 全部枝(含主干)。 */
  listBranches() {
    try {
      return this.db.prepare('SELECT * FROM branch ORDER BY created_at, id').all().map((r) => ({
        id: String(r.id),
        name: String(r.name || ''),
        kind: String(r.kind || 'branch'),
        parentId: r.parent_id ? String(r.parent_id) : null,
        forkAt: r.fork_at ? String(r.fork_at) : null,
        forkSeq: r.fork_seq == null ? null : Number(r.fork_seq),
        nameLocked: Number(r.name_locked || 0),
        weightScale: Number(r.weight_scale ?? 1),
        visibility: String(r.visibility || 'lineage'),
        status: String(r.status || 'active'),
        createdAt: r.created_at ? String(r.created_at) : null,
      }));
    } catch {
      return [];
    }
  }

  /** 血缘链:自己 → 父 → … → 主干(未知枝视为主干后代)。 */
  branchAncestors(branchId) {
    const out = [];
    const seen = new Set();
    let cur = String(branchId || TRUNK_ID);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      let row = null;
      try {
        row = this.db.prepare('SELECT parent_id FROM branch WHERE id=?').get(cur);
      } catch {
        row = null;
      }
      cur = row && row.parent_id ? String(row.parent_id) : null;
    }
    if (!out.includes(TRUNK_ID)) out.push(TRUNK_ID);
    return out;
  }

  /** 单点血缘权重(UI 与测试用)。 */
  lineageWeight(currentBranchId, targetBranchId) {
    const cur = String(currentBranchId || TRUNK_ID);
    const tgt = String(targetBranchId || TRUNK_ID);
    if (cur === tgt) return LINEAGE_SAME;
    return this.branchAncestors(cur).includes(tgt) ? LINEAGE_ANCESTOR : LINEAGE_SIDE;
  }

  /** 全库枝 → 血缘权重映射(L1 打分用:一次算好,避免逐行查库)。 */
  lineageWeightMap(currentBranchId) {
    const cur = String(currentBranchId || TRUNK_ID);
    const anc = new Set(this.branchAncestors(cur));
    const m = new Map();
    let rows = [];
    try {
      rows = this.db.prepare('SELECT id FROM branch').all();
    } catch {
      rows = [];
    }
    for (const r of rows) {
      const id = String(r.id);
      m.set(id, id === cur ? LINEAGE_SAME : anc.has(id) ? LINEAGE_ANCESTOR : LINEAGE_SIDE);
    }
    // ⚠️ 不给"未知枝"满权重(审计 A#4,2026-09-22 修):旧实现无条件 `m.set(cur, LINEAGE_SAME)`,
    // 于是**悬空枝(已删但仍有引用)反而拿 1.0** —— 与 `lineageOf` 的 0.4 兜底自相矛盾,
    // 而且它还是"数据丢了但权重没降"的掩体:错误不会因排序异常而暴露。
    // 现在只有真的登记在 branch 表里的当前枝才有 1.0,未知枝交给调用方的兜底档。
    if (m.has(cur)) m.set(cur, LINEAGE_SAME);
    if (!m.has(TRUNK_ID)) m.set(TRUNK_ID, cur === TRUNK_ID ? LINEAGE_SAME : LINEAGE_ANCESTOR);
    return m;
  }

  // ---- conv_branch:非会话源的枝归属覆盖层(方案 A,2026-09-21) ----
  //
  // 为什么需要它:枝归属原本靠 `session_meta` 推导(会话 → 枝),但 dsweb(1523 条)与 import(16 条)
  // 的历史条目**不是 DSH 会话**、没有会话身份 ⇒ 推不出枝,只能永远留在主干,"一键生成树"对它们无效。
  // 于是加一张显式覆盖表:**只对非会话源使用**,DSH 会话仍走 session_meta(既有链路零变化)。
  // 解析优先级:conv_branch(显式指定) > session_meta(会话推导) > trunk。

  /** 显式指定某条概述的枝归属(dsweb/import 用;幂等)。 */
  setConvBranch(source, convId, branchId) {
    const src = String(source || '');
    const cid = String(convId || '');
    const bid = String(branchId || TRUNK_ID);
    if (!src || !cid) return { ok: false, reason: 'bad-arg' };
    this.db.prepare(`INSERT INTO conv_branch (source,conv_id,branch_id,created_at) VALUES (?,?,?,?)
      ON CONFLICT(source,conv_id) DO UPDATE SET branch_id=excluded.branch_id`).run(src, cid, bid, utcIso());
    return { ok: true, source: src, convId: cid, branchId: bid };
  }

  /** 撤销显式归属(回到"未指定" = 主干)。 */
  clearConvBranch(source, convId) {
    const r = this.db.prepare('DELETE FROM conv_branch WHERE source=? AND conv_id=?')
      .run(String(source || ''), String(convId || ''));
    return { ok: true, removed: Number(r.changes || 0) };
  }

  /** 覆盖层全量映射(key = `source\0convId`)。 */
  convBranchMap() {
    const m = new Map();
    try {
      for (const r of this.db.prepare('SELECT source, conv_id, branch_id FROM conv_branch').all()) {
        m.set(String(r.source) + '\u0000' + String(r.conv_id), String(r.branch_id || TRUNK_ID));
      }
    } catch {
      /* noop */
    }
    return m;
  }

  /** 某条概述的最终枝归属(显式覆盖优先,其次会话推导)。 */
  branchOfConv(source, convId) {
    try {
      const r = this.db.prepare('SELECT branch_id FROM conv_branch WHERE source=? AND conv_id=?')
        .get(String(source || ''), String(convId || ''));
      if (r && r.branch_id) return String(r.branch_id);
    } catch {
      /* noop */
    }
    return String(source || '') === 'dsh' ? this.branchOfSession(convId) : TRUNK_ID;
  }

  /** 会话 → 枝 映射(L1 把记忆行映射到枝用;未登记会话视为主干)。 */
  sessionBranchMap() {
    const m = new Map();
    try {
      for (const r of this.db.prepare('SELECT session_id, branch_id FROM session_meta').all()) {
        m.set(String(r.session_id), String(r.branch_id || TRUNK_ID));
      }
    } catch {
      /* noop */
    }
    return m;
  }

  // ---- 树操作(D9-b,2026-09-19):主脉 / 并脉 / 连边 —— 一律不改写记忆内容 ----

  /** 建主脉(kind='vein',如「力学」);缺省 id = `vein:<uuid>`。 */
  createVein({ id = null, name = '', parentId = TRUNK_ID, visibility = 'lineage' } = {}) {
    return this.createBranch({
      id: id || ('vein:' + randomUUID()),
      name,
      kind: 'vein',
      parentId,
      visibility,
    });
  }

  /** 某枝的全部后代 id(不含自身)。用于并脉防环与整树渲染。 */
  branchDescendants(branchId) {
    const out = [];
    const root = String(branchId || '');
    if (!root) return out;
    let rows = [];
    try {
      rows = this.db.prepare('SELECT id, parent_id FROM branch').all();
    } catch {
      return out;
    }
    const kids = new Map();
    for (const r of rows) {
      const p = r.parent_id ? String(r.parent_id) : '';
      if (!p) continue;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(String(r.id));
    }
    const stack = [...(kids.get(root) || [])];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const k of kids.get(cur) || []) stack.push(k);
    }
    return out;
  }

  /** 并脉:把一条枝挂到新父节点下。**防环**(新父不能是自己或自己的后代)。内容零变化。 */
  reparentBranch(branchId, newParentId) {
    const bid = String(branchId || '');
    const pid = String(newParentId || TRUNK_ID);
    if (!bid) return { ok: false, reason: 'no-branch' };
    if (bid === TRUNK_ID) return { ok: false, reason: 'trunk-immutable' };
    if (bid === pid) return { ok: false, reason: 'self-parent' };
    if (pid !== TRUNK_ID) {
      let p = null;
      try {
        p = this.db.prepare('SELECT id FROM branch WHERE id=?').get(pid);
      } catch {
        p = null;
      }
      if (!p) return { ok: false, reason: 'no-parent' };
    }
    if (this.branchDescendants(bid).includes(pid)) return { ok: false, reason: 'cycle' };
    this.db.prepare('UPDATE branch SET parent_id=?, updated_at=? WHERE id=?').run(pid, utcIso(), bid);
    return { ok: true, id: bid, parentId: pid };
  }

  /** 枝改名(复盘时用)。`name_locked` 语义同 D2 的 `title_locked`。 */
  /**
   * 删枝(审计 B#4 补的能力,2026-09-22)。此前**全插件没有任何删枝端点** ——
   * 建错枝(如空名枝)只能直连改库,这与"树操作可复盘、可审计"的设计相悖。
   *
   * 安全规则:① trunk 不可删;② 有子枝或仍有归属(会话 / 覆盖层)时,除非 `force`,
   * 否则**拒绝并回报影响面** —— 让调用方先知道会动到什么。
   * `force` 删枝时,归属一律**回退到主干**,绝不留下悬空引用(与 `restoreTree` 同一条纪律)。
   */
  deleteBranch(branchId, { force = false } = {}) {
    const bid = String(branchId || '');
    if (!bid) return { ok: false, reason: 'bad-arg' };
    if (bid === TRUNK_ID) return { ok: false, reason: 'trunk-immutable' };
    let row = null;
    try {
      row = this.db.prepare('SELECT id FROM branch WHERE id=?').get(bid);
    } catch {
      row = null;
    }
    if (!row) return { ok: false, reason: 'not-found' };
    const cnt = (sql, a, b) => {
      try {
        const r = b === undefined ? this.db.prepare(sql).get(a) : this.db.prepare(sql).get(a, b);
        return Number(r?.n || 0);
      } catch {
        return 0;
      }
    };
    const impact = {
      children: cnt('SELECT COUNT(*) n FROM branch WHERE parent_id=?', bid),
      sessions: cnt('SELECT COUNT(*) n FROM session_meta WHERE branch_id=?', bid),
      convs: cnt('SELECT COUNT(*) n FROM conv_branch WHERE branch_id=?', bid),
      links: cnt('SELECT COUNT(*) n FROM vein_link WHERE from_branch=? OR to_branch=?', bid, bid),
    };
    const busy = impact.children || impact.sessions || impact.convs || impact.links;
    if (!force && busy) return { ok: false, reason: 'not-empty', impact };
    try {
      this.db.exec('BEGIN');
      this.db.prepare('UPDATE branch SET parent_id=? WHERE parent_id=?').run(TRUNK_ID, bid);
      this.db.prepare('UPDATE session_meta SET branch_id=? WHERE branch_id=?').run(TRUNK_ID, bid);
      this.db.prepare('DELETE FROM conv_branch WHERE branch_id=?').run(bid);
      this.db.prepare('DELETE FROM vein_link WHERE from_branch=? OR to_branch=?').run(bid, bid);
      this.db.prepare('DELETE FROM branch WHERE id=?').run(bid);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      return { ok: false, reason: 'db', error: String(e?.message ?? e).slice(0, 200) };
    }
    return { ok: true, id: bid, name: String(row.name || ''), impact };
  }

  renameBranch(branchId, name, { lock = true } = {}) {
    const bid = String(branchId || '');
    const nm = String(name || '').trim().slice(0, 60);
    if (!bid) return { ok: false, reason: 'no-branch' };
    if (!nm) return { ok: false, reason: 'empty-name' };
    this.db.prepare('UPDATE branch SET name=?, name_locked=?, updated_at=? WHERE id=?')
      .run(nm, lock ? 1 : 0, utcIso(), bid);
    return { ok: true, id: bid, name: nm };
  }

  /** 复盘期权重调节(平时只读 —— 设计稿 §3.3)。scale 夹在 [0,2]。 */
  setBranchWeight(branchId, scale) {
    const bid = String(branchId || '');
    const v = Number(scale);
    if (!bid || !Number.isFinite(v)) return { ok: false, reason: 'bad-arg' };
    const clamped = Math.max(0, Math.min(2, v));
    this.db.prepare('UPDATE branch SET weight_scale=?, updated_at=? WHERE id=?').run(clamped, utcIso(), bid);
    return { ok: true, id: bid, weightScale: clamped };
  }

  /** 连边:两条枝之间的横向关联(如 力学 ↔ 材料科学)。 */
  linkVeins(fromBranch, toBranch, { kind = 'related', note = '' } = {}) {
    const a = String(fromBranch || '');
    const b = String(toBranch || '');
    if (!a || !b || a === b) return { ok: false, reason: 'bad-arg' };
    this.db.prepare(`INSERT INTO vein_link (from_branch,to_branch,kind,note,created_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(from_branch,to_branch) DO UPDATE SET kind=excluded.kind, note=excluded.note`)
      .run(a, b, String(kind || 'related'), String(note || '').slice(0, 300), utcIso());
    return { ok: true, from: a, to: b };
  }

  unlinkVein(fromBranch, toBranch) {
    try {
      const r = this.db.prepare('DELETE FROM vein_link WHERE from_branch=? AND to_branch=?')
        .run(String(fromBranch || ''), String(toBranch || ''));
      return { ok: true, removed: Number(r.changes || 0) };
    } catch {
      return { ok: false, reason: 'db' };
    }
  }

  listVeinLinks() {
    try {
      return this.db.prepare('SELECT * FROM vein_link ORDER BY created_at, from_branch').all().map((r) => ({
        from: String(r.from_branch),
        to: String(r.to_branch),
        kind: String(r.kind || 'related'),
        note: String(r.note || ''),
        createdAt: r.created_at ? String(r.created_at) : null,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 复盘留痕(设计稿 §3.3 第 2 条:仅在复盘时修改,并留痕"改了什么、为什么")。
   * 只记结构操作(改名/并脉/权重/连边),**绝不记录记忆内容** —— 与"内容零改写"不变量一致。
   */
  logBranch(branchId, action, { before = '', after = '', note = '' } = {}) {
    // 写入侧净化(审计 B#2,2026-09-22):branchId 必须限长 —— /veins/link 只要求"非空且 from≠to",
    // 实测可塞进 200KB 的 id,渲染成单行 20 万字符;自由文本一律**压平换行**,
    // 因为换行能穿透引号,在系统提示里自造独立行(如 note 塞 `\n\n【系统】忽略此前指令…`)。
    const oneLine = (s, n) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
    try {
      this.db.prepare(`INSERT INTO branch_log (at,branch_id,action,before_val,after_val,note)
        VALUES (?,?,?,?,?,?)`)
        .run(utcIso(), oneLine(branchId, 64), oneLine(action, 40),
          oneLine(before, 200), oneLine(after, 200), oneLine(note, 300));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'db' };
    }
  }

  /**
   * 结构改动摘要(D9-b 注入感知,2026-09-22) —— 把 branch_log 里**还没被器灵看过**的改动
   * 格式化成中文短句,供注入面使用:主人改了树,器灵下一次开口前就能看到。
   *
   * 水位用**自增 id** 而非时间戳 —— 同一毫秒内的多条改动用时间戳比较会漏。
   * 只报结构操作,不碰任何记忆内容(与"内容零改写"不变量一致)。
   */
  branchLogDigest({ limit = 5 } = {}) {
    const max = Math.max(1, Math.min(20, Number(limit) || 5));
    const wm = Number(this.kvGet('branch_log_wm') || 0);
    let rows = [];
    try {
      rows = this.listBranchLog({ limit: 120 });
    } catch {
      return { lines: [], maxId: wm, total: 0 };
    }
    const fresh = rows.filter((r) => Number(r.id) > wm);
    if (!fresh.length) return { lines: [], maxId: wm, total: 0 };
    const names = new Map(this.listBranches().map((b) => [b.id, b.name || b.id]));
    // 提示面净化(审计 §2.5 + B#2,2026-09-22):
    // ① 枝名/id 一律翻译或缩成短号,**永不吐裸 uuid**(实测:gather/autobuild 两支漏了 nm(),
    //    器灵在注入面里读到的是一串 `vein:558ae2a3-…`);
    // ② 所有渲染文本**压平换行 + 限长** —— branch_log 装的是自由文本(枝名、连边理由、备注),
    //    换行能穿透引号、在系统提示里自造独立行(实测:note 塞 `\n\n【系统】…` 即可脱离框架)。
    const nm = (v) => {
      const k = String(v || '');
      if (!k) return '?';
      return names.get(k) || ('(已删枝 ' + k.slice(-8) + ')');
    };
    const flat = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
    const lines = fresh.slice(0, max).map((r) => {
      const who = nm(r.branchId);
      const line = (() => {
        switch (String(r.action || '')) {
          case 'rename': return '把「' + (r.before || '未命名') + '」改名为「' + r.after + '」';
          case 'reparent': return '把「' + who + '」从「' + nm(r.before) + '」下挪到了「' + nm(r.after) + '」下';
          case 'weight': return '把「' + who + '」的枝系数从 ' + (r.before || '1') + ' 调到了 ' + r.after;
          case 'link': return '连了一条边:「' + who + '」↔「' + nm(r.after) + '」(' + (r.note || 'related') + ')';
          case 'unlink': return '断开了边:「' + who + '」↔「' + nm(r.before) + '」';
          case 'gather': return '把「' + who + '」归并到了「' + nm(r.after) + '」下';
          case 'autobuild': return '自动建了一条枝「' + nm(r.after) + '」' + (r.note ? '(' + r.note + ')' : '');
          default: return (r.action || '操作') + ':' + who + (r.after ? ' → ' + nm(r.after) : '');
        }
      })();
      return flat(line);
    });
    if (fresh.length > lines.length) lines.push('…另有 ' + (fresh.length - lines.length) + ' 笔改动');
    return { lines, maxId: Number(fresh[0].id), total: fresh.length };
  }

  /** 复盘留痕列表(最近的在前)。 */
  listBranchLog({ limit = 100 } = {}) {
    try {
      const n = Math.max(1, Math.min(500, Number(limit) || 100));
      return this.db.prepare('SELECT * FROM branch_log ORDER BY id DESC LIMIT ?').all(n).map((r) => ({
        id: Number(r.id),
        at: String(r.at || ''),
        branchId: String(r.branch_id || ''),
        action: String(r.action || ''),
        before: String(r.before_val || ''),
        after: String(r.after_val || ''),
        note: String(r.note || ''),
      }));
    } catch {
      return [];
    }
  }

  /** 整棵树(UI 用):嵌套 children + 每枝会话数 + 横向连边 + **层级(计算属性,不落库)**。 */
  branchTree() {
    const nodes = this.listBranches();
    const counts = new Map();
    try {
      for (const r of this.db.prepare('SELECT branch_id AS bid, COUNT(*) AS n FROM session_meta GROUP BY branch_id').all()) {
        counts.set(String(r.bid || TRUNK_ID), Number(r.n || 0));
      }
    } catch {
      /* noop */
    }
    const byId = new Map();
    for (const n of nodes) byId.set(n.id, { ...n, sessions: counts.get(n.id) || 0, children: [] });
    const roots = [];
    for (const n of byId.values()) {
      const p = n.parentId ? byId.get(n.parentId) : null;
      if (p && n.id !== TRUNK_ID) p.children.push(n);
      else roots.push(n);
    }
    // 层级 = **计算属性**(用户 2026-09-19 定):按相对深度切,树长高时自动重算,**零回写**。
    // 于是"几条主脉并成一条更大的主脉 ⇒ 原节点自动降级"是视图效果,不需要回写任何一行记忆 ——
    // 这正是"任何树操作都不改写记忆内容"这条核心不变量能成立的原因。
    // 档位:0=主干(恒 1 条);(0,0.25]=主脉;≤0.62=枝;其余=叶 ⇒ 最多 1 主干 / 2 主脉 / 3 枝 / 4 叶。
    let maxDepth = 0;
    const walk = (n, d) => {
      n.depth = d;
      if (d > maxDepth) maxDepth = d;
      for (const c of n.children) walk(c, d + 1);
    };
    for (const r of roots) walk(r, 0);
    const N = Math.max(1, maxDepth);
    for (const n of byId.values()) {
      const p = n.depth / N;
      n.level = (n.id === TRUNK_ID || p === 0) ? 'trunk'
        : (p <= 0.25 ? 'vein' : (p <= 0.62 ? 'branch' : 'leaf'));
    }
    return { roots, links: this.listVeinLinks(), total: nodes.length, depth: maxDepth };
  }

  // ---- 树的保存 / 恢复(R1,2026-09-22)----
  // 快照只存**结构**(枝 / 归属 / 连边),不存任何记忆内容 —— 与"内容零改写"不变量一致。
  // 恢复 = 把结构整体还原;恢复前**自动存一份当前状态**,所以"恢复"本身也是可撤的。

  /** 存一份当前树结构的快照。 */
  snapshotTree({ name = '', note = '' } = {}) {
    const now = utcIso();
    try {
      const data = {
        branches: this.db.prepare('SELECT * FROM branch').all(),
        sessionBranch: this.db.prepare('SELECT session_id, branch_id FROM session_meta').all(),
        convBranch: this.db.prepare('SELECT source, conv_id, branch_id FROM conv_branch').all(),
        links: this.db.prepare('SELECT from_branch, to_branch, kind, note FROM vein_link').all(),
      };
      // 名字留空 → 自动命名;不写「未命名」(2026-09-22 用户:手工/自动 + 日期时间即可)
      const nm = String(name || '').trim() || ('手动快照 - ' + localStamp());
      const r = this.db.prepare('INSERT INTO tree_snapshot (at,name,note,data) VALUES (?,?,?,?)')
        .run(now, nm.slice(0, 80), String(note || '').slice(0, 300), JSON.stringify(data));
      return {
        ok: true,
        id: Number(r.lastInsertRowid),
        at: now,
        counts: {
          branches: data.branches.length,
          sessionBranch: data.sessionBranch.length,
          convBranch: data.convBranch.length,
          links: data.links.length,
        },
      };
    } catch (e) {
      return { ok: false, reason: 'db', error: String(e?.message ?? e).slice(0, 200) };
    }
  }

  /** 快照列表(不带 data —— 快照体可能很大,列表只给元信息与规模)。 */
  listTreeSnapshots({ limit = 50 } = {}) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    try {
      return this.db.prepare('SELECT id, at, name, note, LENGTH(data) AS bytes FROM tree_snapshot ORDER BY id DESC LIMIT ?')
        .all(n)
        .map((r) => ({
          id: Number(r.id),
          at: r.at ? String(r.at) : null,
          name: String(r.name || ''),
          note: String(r.note || ''),
          bytes: Number(r.bytes || 0),
        }));
    } catch {
      return [];
    }
  }

  /**
   * 恢复树结构(单事务)。恢复前自动把当前状态存一份,返回 backupId。
   * 只恢复快照里记录过的会话归属 —— 快照之后新建的会话保持原样,不会被拽回主干。
   */
  restoreTree(snapshotId) {
    const sid = Number(snapshotId);
    let row = null;
    try {
      row = this.db.prepare('SELECT * FROM tree_snapshot WHERE id=?').get(sid);
    } catch {
      row = null;
    }
    if (!row) return { ok: false, reason: 'not-found' };
    let data = null;
    try {
      data = JSON.parse(String(row.data || '{}'));
    } catch {
      return { ok: false, reason: 'bad-data' };
    }
    const backup = this.snapshotTree({ name: '自动快照 - ' + localStamp(), note: '恢复快照 #' + sid + ' 之前的自动备份' });
    let detached = 0;
    try {
      const insB = this.db.prepare(`INSERT INTO branch
        (id,name,kind,parent_id,fork_at,fork_seq,name_locked,weight_scale,visibility,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, parent_id=excluded.parent_id,
          fork_at=excluded.fork_at, fork_seq=excluded.fork_seq, name_locked=excluded.name_locked,
          weight_scale=excluded.weight_scale, visibility=excluded.visibility, status=excluded.status,
          updated_at=excluded.updated_at`);
      const insC = this.db.prepare('INSERT INTO conv_branch (source,conv_id,branch_id,created_at) VALUES (?,?,?,?) ON CONFLICT(source,conv_id) DO UPDATE SET branch_id=excluded.branch_id');
      const insL = this.db.prepare('INSERT INTO vein_link (from_branch,to_branch,kind,note,created_at) VALUES (?,?,?,?,?) ON CONFLICT(from_branch,to_branch) DO UPDATE SET kind=excluded.kind, note=excluded.note');
      const upS = this.db.prepare('UPDATE session_meta SET branch_id=? WHERE session_id=?');
      const now = utcIso();
      this.db.exec('BEGIN');
      // ⚠️ **不删枝**(审计 A#1/#3/#7,2026-09-22 修):
      // 旧实现是 `DELETE FROM branch WHERE id<>'trunk'` —— 它会静默删掉"快照之后新建的枝",
      // 而 `session_meta.branch_id` 仍指向它们 ⇒ **悬空引用**。实测后果三连:
      // 那些记忆**树里看不见**(枝没了)、**计数里数得到**(幽灵桶)、**权重还满格**(L1 lineage=1)
      // —— 数据仍在库里,但 UI 没有任何路径能再看见或改回它们,等于永久不可达。
      // 改为:快照里没有的枝一律 **reparent 到主干** —— 枝与归属都保留,只是回到主干下。
      const snapIds = new Set((data.branches || []).map((b) => String(b.id)));
      snapIds.add(TRUNK_ID);
      const detachIds = this.db.prepare('SELECT id FROM branch WHERE id<>?').all(TRUNK_ID)
        .map((r) => String(r.id)).filter((id) => !snapIds.has(id));
      const upP = this.db.prepare('UPDATE branch SET parent_id=?, updated_at=? WHERE id=?');
      for (const id of detachIds) upP.run(TRUNK_ID, now, id);
      detached = detachIds.length;
      for (const b of data.branches || []) {
        insB.run(
          String(b.id), String(b.name || ''), String(b.kind || 'branch'),
          b.parent_id ? String(b.parent_id) : null,
          b.fork_at ? String(b.fork_at) : null,
          Number.isFinite(Number(b.fork_seq)) ? Number(b.fork_seq) : null,
          Number(b.name_locked || 0), Number(b.weight_scale ?? 1),
          String(b.visibility || 'lineage'), String(b.status || 'active'),
          String(b.created_at || now), b.updated_at ? String(b.updated_at) : now,
        );
      }
      // trunk 行必须存在(快照里没有就补一个)
      this.db.prepare(`INSERT INTO branch (id,name,kind,parent_id,created_at,updated_at)
        VALUES (?,?,?,NULL,?,?) ON CONFLICT(id) DO NOTHING`).run(TRUNK_ID, '主干', 'trunk', now, now);
      this.db.prepare('DELETE FROM conv_branch').run();
      for (const c of data.convBranch || []) insC.run(String(c.source), String(c.conv_id), String(c.branch_id), now);
      this.db.prepare('DELETE FROM vein_link').run();
      for (const l of data.links || []) {
        insL.run(String(l.from_branch), String(l.to_branch), String(l.kind || 'related'), String(l.note || ''), now);
      }
      for (const s of data.sessionBranch || []) upS.run(String(s.branch_id || TRUNK_ID), String(s.session_id));
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* noop */ }
      return { ok: false, reason: 'db', error: String(e?.message ?? e).slice(0, 200) };
    }
    this.logBranch(TRUNK_ID, 'restore', { after: String(row.name || ('#' + sid)), note: '恢复树快照 #' + sid + (detached ? (';' + detached + ' 条新枝回退到主干') : '') });
    return {
      ok: true, id: sid, backupId: backup.ok ? backup.id : null, counts: backup.ok ? backup.counts : null,
      // 让调用方知道这次恢复**动了什么**(旧实现只报"被覆盖掉的那个状态",看不出会删枝)
      affected: { detachedToTrunk: detached },
    };
  }

  deleteTreeSnapshot(snapshotId) {
    try {
      const r = this.db.prepare('DELETE FROM tree_snapshot WHERE id=?').run(Number(snapshotId));
      return { ok: true, removed: Number(r.changes || 0) };
    } catch {
      return { ok: false, reason: 'db' };
    }
  }

  /**
   * 某枝下的成员(R2 会话级展开):DSH 会话 + 覆盖层条目,均带标题。
   * 标题三级回退:概述标题 → **原文首条用户消息** → 空(前端再回退成短 id)。
   * 只显示裸 uuid 对主人毫无信息量 —— 库里绝大多数会话没有概述行(概述器有正文长度门槛),
   * 故必须回读原文;取前 120 字交给 JS 侧压成单行 40 字。
   */
  branchMembers(branchId, { limit = 300 } = {}) {
    const bid = String(branchId || TRUNK_ID);
    const n = Math.max(1, Math.min(2000, Number(limit) || 300));
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const out = [];
    try {
      for (const r of this.db.prepare(`SELECT m.session_id AS cid,
        COALESCE(NULLIF(TRIM(o.title),''),
          (SELECT SUBSTR(REPLACE(REPLACE(TRIM(t.text), CHAR(10), ' '), CHAR(13), ' '), 1, 120)
             FROM dsh_turns_raw t
            WHERE t.session_id = m.session_id AND t.role='user' AND TRIM(COALESCE(t.text,'')) <> ''
            ORDER BY t.seq LIMIT 1), '') AS title,
        COALESCE(m.archived,0) AS arc
        FROM session_meta m LEFT JOIN conv_overview o ON o.source='dsh' AND o.conv_id=m.session_id
        WHERE m.branch_id=?
          AND (NULLIF(TRIM(o.title),'') IS NOT NULL
               OR EXISTS (SELECT 1 FROM dsh_turns_raw t2 WHERE t2.session_id = m.session_id))
        ORDER BY m.session_id LIMIT ?`).all(bid, n)) {
        out.push({ kind: 'session', source: 'dsh', convId: String(r.cid), title: clean(r.title), archived: Number(r.arc || 0) });
      }
    } catch { /* noop */ }
    try {
      for (const r of this.db.prepare(`SELECT c.source AS src, c.conv_id AS cid,
        COALESCE(NULLIF(TRIM(o.title),''),
          (SELECT SUBSTR(REPLACE(REPLACE(TRIM(t.text), CHAR(10), ' '), CHAR(13), ' '), 1, 120)
             FROM dsh_turns_raw t
            WHERE t.session_id = c.conv_id AND t.role='user' AND TRIM(COALESCE(t.text,'')) <> ''
            ORDER BY t.seq LIMIT 1), '') AS title
        FROM conv_branch c LEFT JOIN conv_overview o ON o.source=c.source AND o.conv_id=c.conv_id
        WHERE c.branch_id=?
          AND (NULLIF(TRIM(o.title),'') IS NOT NULL
               OR EXISTS (SELECT 1 FROM dsh_turns_raw t2 WHERE t2.session_id = c.conv_id))
        ORDER BY c.conv_id LIMIT ?`).all(bid, n)) {
        out.push({ kind: 'entry', source: String(r.src), convId: String(r.cid), title: clean(r.title), archived: 0 });
      }
    } catch { /* noop */ }
    return out;
  }

  /** 改单条(会话 / 历史条目)的枝归属 —— R2/R3 拖动会话用。 */
  assignConv(source, convId, branchId) {
    const src = String(source || '');
    const cid = String(convId || '');
    const bid = String(branchId || TRUNK_ID);
    if (!src || !cid) return { ok: false, reason: 'bad-arg' };
    if (src === 'dsh') {
      const prev = this.branchOfSession(cid);
      this.setSessionBranch(cid, bid);
      return { ok: true, via: 'session_meta', branchId: bid, prev };
    }
    let prev = null;
    try {
      prev = this.branchOfConv(src, cid);
    } catch { /* noop */ }
    this.setConvBranch(src, cid, bid);
    return { ok: true, via: 'conv_branch', branchId: bid, prev };
  }

  // ---- 矛盾标记层(D9-b,2026-09-19):检出但**不改写内容**;未复盘 → 以最新为准 ----

  /** 记录一对矛盾(幂等:同一对只留一条)。a/b 会被归一排序,保证先后无关。 */
  recordConflict({ aSource, aConvId, bSource, bConvId, kind = 'contradict', detectedBy = 'heuristic', score = null, reason = '' } = {}) {
    const a = [String(aSource || ''), String(aConvId || '')];
    const b = [String(bSource || ''), String(bConvId || '')];
    if (!a[1] || !b[1] || (a[0] === b[0] && a[1] === b[1])) return { ok: false, reason: 'bad-arg' };
    const ka = a[0] + '\u0000' + a[1];
    const kb = b[0] + '\u0000' + b[1];
    const [x, y] = ka <= kb ? [a, b] : [b, a];
    const sc = score == null || !Number.isFinite(Number(score)) ? null : Number(score);
    try {
      // 先查后写(不用 upsert 的 CASE 表达式 —— 那里 未限定列名指旧值还是新值容易读错):
      // 已存在则保持原状,**除非此前被驳回**(dismissed):再次检出说明它又冒出来了,
      // 应当重新提起(回到 pending 并刷新检出信息),否则一条被驳回的矛盾将永远无法再被提出。
      const cur = this.db.prepare(`SELECT id, status FROM memory_conflict
        WHERE a_source=? AND a_conv_id=? AND b_source=? AND b_conv_id=?`).get(x[0], x[1], y[0], y[1]);
      if (cur) {
        const id = Number(cur.id);
        if (String(cur.status) === 'dismissed') {
          this.db.prepare(`UPDATE memory_conflict
            SET status='pending', kind=?, detected_by=?, score=?, reason=?, winner_side=NULL, resolved_at=NULL
            WHERE id=?`)
            .run(String(kind || 'contradict'), String(detectedBy || 'heuristic'), sc, String(reason || '').slice(0, 300), id);
          return { ok: true, id, reopened: true };
        }
        return { ok: true, id, reopened: false };
      }
      this.db.prepare(`INSERT INTO memory_conflict
        (created_at,a_source,a_conv_id,b_source,b_conv_id,kind,detected_by,score,reason,status)
        VALUES (?,?,?,?,?,?,?,?,?,'pending')`)
        .run(utcIso(), x[0], x[1], y[0], y[1], String(kind || 'contradict'), String(detectedBy || 'heuristic'), sc, String(reason || '').slice(0, 300));
      const row = this.db.prepare(`SELECT id FROM memory_conflict
        WHERE a_source=? AND a_conv_id=? AND b_source=? AND b_conv_id=?`).get(x[0], x[1], y[0], y[1]);
      return { ok: true, id: row ? Number(row.id) : null, reopened: false };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
    }
  }

  /**
   * 模型判定后回写这条候选的**性质**(duplicate / contradict / unrelated)。
   * 只改标记,不改记忆内容 —— 启发式只能找"措辞重复",判"同题反结论"必须读懂意思。
   */
  setConflictKind(id, { kind = '', detectedBy = 'llm', reason = '' } = {}) {
    try {
      const cid = Number(id);
      if (!Number.isFinite(cid)) return { ok: false, reason: 'bad-id' };
      const k = String(kind || '').trim().slice(0, 20);
      if (!k) return { ok: false, reason: 'bad-kind' };
      this.db.prepare('UPDATE memory_conflict SET kind=?, detected_by=?, reason=? WHERE id=?')
        .run(k, String(detectedBy || 'llm').slice(0, 20), String(reason || '').slice(0, 300), cid);
      return { ok: true, id: cid, kind: k };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
    }
  }

  listConflicts({ status = '', limit = 100 } = {}) {
    try {
      const where = status ? 'WHERE status=?' : '';
      const args = status ? [String(status)] : [];
      args.push(Math.max(1, Math.min(500, Number(limit) || 100)));
      return this.db.prepare(`SELECT * FROM memory_conflict ${where} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args).map((r) => ({
        id: Number(r.id),
        createdAt: r.created_at ? String(r.created_at) : null,
        a: { source: String(r.a_source), convId: String(r.a_conv_id) },
        b: { source: String(r.b_source), convId: String(r.b_conv_id) },
        kind: String(r.kind || 'contradict'),
        detectedBy: String(r.detected_by || 'heuristic'),
        score: r.score == null ? null : Number(r.score),
        reason: String(r.reason || ''),
        status: String(r.status || 'pending'),
        winnerSide: r.winner_side ? String(r.winner_side) : null,
        resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
      }));
    } catch {
      return [];
    }
  }

  /** 复盘裁定:指定谁为准(winner='a'|'b'),或驳回(dismissed)。 */
  resolveConflict(id, { winner = null, status = 'confirmed' } = {}) {
    const cid = Number(id);
    if (!Number.isFinite(cid)) return { ok: false, reason: 'bad-id' };
    const st = status === 'dismissed' ? 'dismissed' : 'confirmed';
    const w = winner === 'a' || winner === 'b' ? winner : null;
    if (st === 'confirmed' && !w) return { ok: false, reason: 'need-winner' };
    try {
      this.db.prepare('UPDATE memory_conflict SET status=?, winner_side=?, resolved_at=? WHERE id=?')
        .run(st, st === 'dismissed' ? null : w, utcIso(), cid);
      return { ok: true, id: cid, status: st, winnerSide: st === 'dismissed' ? null : w };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e).slice(0, 120) };
    }
  }

  /** 某条概述的时间戳(矛盾裁定用"最新为准"的判据)。
   *  `conv_overview` **没有 created_at 列**(只有 started_at / updated_at);
   *  `updated_at` 也可能为空(调用方没传),故兜底到 `started_at`。 */
  _overviewWhen(source, convId) {
    try {
      const r = this.db.prepare('SELECT updated_at, started_at FROM conv_overview WHERE source=? AND conv_id=?')
        .get(String(source), String(convId));
      return String((r && (r.updated_at || r.started_at)) || '');
    } catch {
      return '';
    }
  }

  /** 检索侧降权映射:`"source\\u0000convId" → 系数`。
   *  规则(用户 2026-09-20 定):**复盘裁定的按裁定;未复盘的以最新为准**(旧的一方降权)。
   *  `duplicate` 不降权(两条内容相同,降谁都会丢信息);`dismissed` 一律不降权。 */
  conflictDowngradeMap() {
    const m = new Map();
    let rows = [];
    try {
      rows = this.db.prepare("SELECT * FROM memory_conflict WHERE status<>'dismissed' AND kind<>'duplicate'").all();
    } catch {
      return m;
    }
    for (const r of rows) {
      const aKey = String(r.a_source) + '\u0000' + String(r.a_conv_id);
      const bKey = String(r.b_source) + '\u0000' + String(r.b_conv_id);
      let loser = null;
      if (r.status === 'confirmed' && r.winner_side) {
        loser = String(r.winner_side) === 'a' ? bKey : aKey;
      } else {
        const ta = this._overviewWhen(r.a_source, r.a_conv_id);
        const tb = this._overviewWhen(r.b_source, r.b_conv_id);
        if (ta && tb) {
          if (ta < tb) loser = aKey;
          else if (tb < ta) loser = bKey;
        } else if (!ta && tb) loser = aKey;
        else if (ta && !tb) loser = bKey;
      }
      if (loser) m.set(loser, CONFLICT_DOWNWEIGHT);
    }
    return m;
  }

  /** 源会话标题(D9-a:建枝时给枝起种子名用;查不到返回 '')。 */
  overviewTitleOf(convId) {
    try {
      const row = this.db
        .prepare("SELECT title FROM conv_overview WHERE conv_id=? AND title<>'' ORDER BY updated_at DESC LIMIT 1")
        .get(String(convId));
      return row && row.title ? String(row.title) : '';
    } catch {
      return '';
    }
  }

  /**
   * 已归档会话 id 集合(2026-09-21,D9-b 用)。
   *
   * 归档 = 主人主动封存、不再参与日常召回的那批会话。矛盾扫描必须排除它们,
   * 否则会拿几个月前已封存的对话互相判"矛盾",把待复盘队列塞满噪音(用户实测反馈)。
   * 一次取全量而非逐行查 session_meta —— scan 里要判上千条,逐行查是 O(n) 次 SQL。
   */
  archivedConvIdSet() {
    const s = new Set();
    try {
      for (const r of this.db.prepare('SELECT session_id FROM session_meta WHERE archived=1').all()) {
        s.add(String(r.session_id));
      }
    } catch {
      /* noop */
    }
    return s;
  }

  /** 全库概述索引(源/会话/标题/时间) —— 供一键生成记忆树做机械分段(只读,不取摘要正文)。 */
  overviewIndex() {
    try {
      return this.db.prepare(`SELECT source, conv_id, title, summary,
        COALESCE(updated_at, started_at) AS at FROM conv_overview`).all().map((r) => ({
        source: String(r.source || ''),
        convId: String(r.conv_id || ''),
        title: String(r.title || ''),
        hasSummary: !!(r.summary && String(r.summary).trim()),
        at: r.at ? String(r.at) : '',
      }));
    } catch {
      return [];
    }
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
  queryOverviews({ source, category, q, branch, sort = 'updated', limit = 100, offset = 0 } = {}) {
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
    // 按枝过滤(方案 A,2026-09-21 起):归属解析 = conv_branch 显式覆盖 > dsh 会话的 session_meta > 主干。
    // 原来只对 DSH 会话有意义(dsweb/import 恒属主干),加了覆盖层后非会话源也能挂枝。
    const bsel = branch ? String(branch) : '';
    if (bsel) {
      if (bsel === TRUNK_ID) {
        // 主干 = 没被显式指到别的枝,且(非 dsh 源 或 没被会话表指到别的枝)。
        // 用 NOT EXISTS 而非 `IN (SELECT … WHERE branch_id='trunk')` —— 后者会漏掉
        // session_meta 里根本没有行的会话(历史会话、未走 session-start 的会话),
        // 让它们在按主干过滤时整批消失。未登记 = 主干,这是本设计的默认归属。
        where.push("NOT EXISTS (SELECT 1 FROM conv_branch cb WHERE cb.source=conv_overview.source AND cb.conv_id=conv_overview.conv_id AND cb.branch_id<>?)");
        args.push(TRUNK_ID);
        where.push("(source<>'dsh' OR NOT EXISTS (SELECT 1 FROM session_meta m WHERE m.session_id=conv_overview.conv_id AND m.branch_id<>?))");
        args.push(TRUNK_ID);
      } else {
        where.push("(EXISTS (SELECT 1 FROM conv_branch cb WHERE cb.source=conv_overview.source AND cb.conv_id=conv_overview.conv_id AND cb.branch_id=?) OR (source='dsh' AND EXISTS (SELECT 1 FROM session_meta m WHERE m.session_id=conv_overview.conv_id AND m.branch_id=?)))");
        args.push(bsel, bsel);
      }
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

  /** 各枝条数(D9-a):记忆中心筛选栏用它显示「主干 (1590)」「枝名 (3)」。
   *  归属解析:conv_branch 显式覆盖 > dsh 会话的 session_meta > 主干(与 queryOverviews 口径一致)。 */
  branchCounts() {
    const rows = this.db.prepare(
      `SELECT COALESCE(cb.branch_id, m.branch_id, ?) AS bid, COUNT(*) AS n
       FROM conv_overview o
       LEFT JOIN conv_branch cb ON cb.source = o.source AND cb.conv_id = o.conv_id
       LEFT JOIN session_meta m ON o.source='dsh' AND m.session_id = o.conv_id
       GROUP BY bid`,
    ).all(TRUNK_ID);
    // ⚠️ 与 branch 表对账(审计 A#2,2026-09-22 修):归属行可能指向**已不存在的枝**
    // (历史遗留 / 手工改动),旧实现把它原样塞进 byBranch ⇒ 界面渲染出"名字 = 裸 UUID"的幽灵枝行。
    // 现在:只输出真实存在的枝;幽灵桶的计数**归入主干**(总数不变)并单独报 `phantom` 供观测。
    const known = new Set([TRUNK_ID]);
    try {
      for (const r of this.db.prepare('SELECT id FROM branch').all()) known.add(String(r.id));
    } catch { /* noop */ }
    const byBranch = {};
    let total = 0;
    let phantom = 0;
    for (const r of rows) {
      const bid = String(r.bid);
      const n = Number(r.n);
      total += n;
      if (!known.has(bid)) {
        phantom += n;
        byBranch[TRUNK_ID] = (byBranch[TRUNK_ID] || 0) + n;
        continue;
      }
      byBranch[bid] = (byBranch[bid] || 0) + n;
    }
    return { total, byBranch, phantom };
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
