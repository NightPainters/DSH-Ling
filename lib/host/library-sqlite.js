/**
 * 1.7 图书馆 · **SQLite 类接入通道**(选项文档 §11.3;2026-10-15 开工)
 *
 * 这一层只做一件事:**把一张表读成"内容单元"**,交给纯函数的 `analyzeImport`
 * (`lib/host/library-import.js`)去走两段式。它**不写库、不改源库结构、不联网**。
 *
 * ## 为什么单独一层(不塞进 library-import.js)
 * `analyzeImport` 的契约是"纯函数式:不碰库、不碰文件、不碰 network"(契约 §2.1)。
 * 打开源库是**文件 I/O** ⇒ 必须留在外面,由运行时注入(`opts.readSqlite`),与模型段同款:
 * 测试可以换桩,纯函数那一层不被污染。
 *
 * ## 动工前实测的六条事实(探针 `_probe/sqlite-probe*.mjs`,2026-10-15)
 * 1. **打开是懒的**:`new DatabaseSync(垃圾文件,{readOnly:true})` **不抛**,第一条查询才抛
 *    `file is not a database` ⇒ 判"是不是库"**必须自己读魔数**,不能靠 open。
 * 2. **大整数默认就抛**:不传 `readBigInts` 时,任何超过 2^53 的 INTEGER 会让**整条查询**抛
 *    `ERR_OUT_OF_RANGE` ⇒ **一行坏数据能毙掉整张表** ⇒ 一律 `readBigInts: true`,自己转字符串。
 * 3. **`rowid` 会被同名列遮蔽**:表里真有一个叫 `rowid` 的列时,`SELECT rowid` 拿到的是**那一列**
 *    (实测 `__rid: "r1"` 而非 1/2)⇒ 无主键表必须在 `rowid`/`_rowid_`/`oid` 里挑一个**没被列名占用**的。
 * 4. **`PRAGMA busy_timeout` 在只读连接上也能设、且可回读**(实测 `{timeout:0}` → `{timeout:2000}`);
 *    而构造函数里那个 `{ timeout: 2000 }` 选项"没抛"**不等于生效** ⇒ 用 PRAGMA 设,并**回读当证据**。
 * 5. **`WITHOUT ROWID` 的表查 `rowid` 直接报 `no such column: rowid`** ⇒ rowid 回退只在**无主键**时用
 *    (而 WITHOUT ROWID 必有主键,两条口径正好不打架)。
 * 6. **标识符转义** = `"` 包 + 内部 `""`:`PRAGMA table_info("怪 名")` 与 `SELECT "列""引"` 都实测可用。
 *
 * ## 五条安全硬约束(§11.3:缺一条都不许上)
 * ① 只读打开(实测只读连接上写会抛 `attempt to write a readonly database`);
 * ② **拒绝打开本插件自己的库**(`library.db` / `memory.db`)⇒ `source_locked` —— 自噬 + 锁风险;
 * ③ 表**必须显式选**,**不猜"最大的表"**(猜错 = 把不相干的数据当条目灌进馆);
 * ④ 大表**不数总数**:不跑 `COUNT(*)`,分页靠 `LIMIT ?+1 OFFSET ?` **只探一格**;
 * ⑤ 打不开的东西**如实说**(`not_sqlite` / `source_unreadable` / …),**绝不静默产出 0 条**。
 *
 * ## 定位与保真(与 §11.6 B.1 同口径)
 * locator = `表名#主键值`(复合主键按 `pk` 次序用 `|` 连;无主键 ⇒ 用没被占用的 rowid 别名):
 * 它是**地址**,不是内容 —— 幂等键 = `sha256(源身份)[0:16] + ':' + locator`。
 * `m`(单元文本)= 该行 `列=值` 逐行拼成的文本,它**同时**是默认正文与 evidence 的回查区间
 * (`verifyWithIndex` 的 `span.includes(ev)`)—— 两边**只能由这一个函数产出**,另拼一遍就会假红。
 */
import { openSync, closeSync, readSync, statSync, realpathSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { contained, localPath } from './library-checker.js';
import { utf8Bytes } from './library-store.js';

/** SQLite 文件头(16 字节,ASCII)。**唯一的**"这是不是 SQLite 库"判据 —— open 是懒的。 */
export const SQLITE_MAGIC = 'SQLite format 3\0';
/** 无主键表挑 rowid 别名的次序(白名单常量 ⇒ 拼进 SQL 时不加引号,见 `selectList`)。 */
export const SQLITE_ROWID_ALIASES = Object.freeze(['rowid', '_rowid_', 'oid']);
/** locator 的字节预算(幂等键里 locator 那半截;store 侧 `import_key` 上限 512 字节)。 */
export const SQLITE_LOCATOR_MAX_BYTES = 300;
/** 回执里最多列出几张表(超出只计数,不静默丢)。 */
export const SQLITE_TABLES_LISTED = 100;

const bad = (reason, message) => ({ ok: false, reason, message });
const msgOf = (e) => String((e && e.message) || e || '未知错误').slice(0, 300);

/** `"名""字"` —— SQLite 的标识符转义(实测可用于 SELECT 与 PRAGMA)。 */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * D15 的**源身份串**:`<真实路径>|<字节数>|`mtime。<br>
 * 为什么不拿内容哈希:① 读整库求哈希与"大表不数总数"同一类浪费;② path 接入时源文本为空,
 * 内容哈希会退化成常量、让**跨库同表同主键撞键**(这条是被异源复核证伪后改的口径,见 §11.6 C)。
 */
export function sqliteIdentityString(identity) {
  return `${identity.real}|${identity.size}|${identity.mtime_ms}`;
}

/** 单元格值 → 文本(保真优先:`NULL` / 大整数按原样 / 二进制写成 `x'..'`,不猜、不改)。 */
export function sqlValueText(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Uint8Array) {
    const hex = Buffer.from(v).toString('hex');
    return hex.length <= 64 ? `x'${hex}'` : `x'${hex.slice(0, 64)}…'(${v.length} 字节)`;
  }
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * 行 → 单元文本(每列一行 `列=值`)。
 * ⚠️ 这个函数的输出**就是** `m`,也是 evidence 的回查区间 —— **不许在别处再拼一遍**。
 */
export function sqlRowText(columns, row) {
  return columns.map((c) => `${c.name}=${sqlValueText(row[c.name])}`).join('\n');
}

/** 主键值超预算时的**确定性**收短:截到预算内(不劈开多字节字符)+ 挂原文摘要前 8 位。 */
export function sqliteLocatorOf(table, keyText) {
  const raw = `${table}#${keyText}`;
  if (utf8Bytes(raw) <= SQLITE_LOCATOR_MAX_BYTES) return { locator: raw, capped: false };
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  const room = SQLITE_LOCATOR_MAX_BYTES - digest.length - 2; // 1 个 `…` 与 1 个 `#` 的余量
  const head = Buffer.from(raw, 'utf8').subarray(0, room).toString('utf8').replace(/\uFFFD+$/u, '');
  return { locator: `${head}…#${digest}`, capped: true };
}

/** 读前 16 字节判魔数(open 靠不住:fopen 一个垃圾文件是成功的)。 */
function isSqliteFile(real) {
  let fd = null;
  try {
    fd = openSync(real, 'r');
    const buf = Buffer.alloc(16);
    const read = readSync(fd, buf, 0, 16, 0);
    return read === 16 && buf.toString('latin1') === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 只读句柄,关不上也不影响结论 */ } }
  }
}

const realOrResolved = (p) => { try { return realpathSync.native(p); } catch { return resolvePath(p); } };
/** 源库旁边那两个 SQLite 侧文件:`-wal` / `-shm`(存在与**新增**都要如实报出去)。 */
const sidecarState = (dbPath) => ['-wal', '-shm'].map((suf) => dbPath + suf).filter((p) => existsSync(p));

/** 路径比对的归一:Windows 大小写不敏感,两边都走真实路径。 */
const samePath = (a, b) => {
  const na = realOrResolved(a);
  const nb = realOrResolved(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
};

/**
 * 打开源库(只读)并读出一页内容单元。<br>
 * `options`:`path` · `table` · `offset` · `limit`(一页几张) · `limits` · `roots`(登记根,
 * `[{path, real}]`,由 `normalizeRoots` 产出) · `lockedPaths`(拒开的自有库绝对路径)。
 */
export async function readSqliteSource(options = {}) {
  const o = options && typeof options === 'object' ? options : {};
  const limits = o.limits && typeof o.limits === 'object' ? o.limits : {};

  // ── ① 路径闸(复用 library-checker 的同一套根校验,不自创)────────────────────────────
  const rawPath = typeof o.path === 'string' ? o.path.trim() : '';
  if (rawPath === '') {
    return bad('source_path_invalid', 'path 必填:SQLite 走"路径接入",要的是源库在本机上的**绝对**路径');
  }
  if (!localPath(rawPath)) {
    return bad('source_path_invalid', `path 必须是本机绝对路径且不含 .. 穿越(实际 ${JSON.stringify(rawPath)})`);
  }
  const roots = Array.isArray(o.roots) ? o.roots.filter((r) => r && typeof r.path === 'string' && typeof r.real === 'string') : [];
  const lexical = resolvePath(rawPath);
  if (roots.length === 0) {
    return bad('source_path_not_allowed', '还没有登记取源根(library.codeRoots 是空的)⇒ 路径接入读不了任何源库');
  }
  if (!roots.some((r) => contained(r.path, lexical) || contained(r.real, lexical))) {
    return bad('source_path_not_allowed', `这个路径不在登记的取源根里(library.codeRoots)。要读它,先把它的目录加进 codeRoots:${lexical}`);
  }
  let real = '';
  try { real = realpathSync.native(lexical); }
  catch (e) { return bad('source_unreadable', `打不开这个路径:${msgOf(e)}`); }
  if (!roots.some((r) => contained(r.real, real))) {
    return bad('source_symlink_escape', `真实路径 ${real} 跳出了登记根(符号链接?)—— 根白名单挡不住这层,所以这里再核一次`);
  }
  let st = null;
  try { st = statSync(real); }
  catch (e) { return bad('source_unreadable', `读不到文件信息:${msgOf(e)}`); }
  if (!st.isFile()) return bad('source_unreadable', '这不是普通文件(目录 / 设备 / 管道都不接)');

  // ── ② 自噬闸:根白名单**挡不住**它(数据目录完全可以被登记进 codeRoots)────────────────
  const locked = Array.isArray(o.lockedPaths) ? o.lockedPaths.filter((p) => typeof p === 'string' && p !== '') : [];
  for (const p of locked) {
    // ⚠️ **只比路径串不够**:`realpath` 不会把**硬链接**归一到同一个路径 ⇒ 在登记根里放一个指向
    //    `memory.db` 的硬链接,路径串不同、inode 相同,这道闸就被绕过去了(2026-10-15 实测复现:
    //    `ok:true` 且读出了 `memory-机密`)。所以除了路径串,还要比 **dev+ino**
    //    —— 与 library-checker 的 `sameFile` 同一口径,不另立第二套。
    let same = samePath(real, p);
    if (!same) {
      try {
        const other = statSync(p);
        same = other.dev === st.dev && other.ino === st.ino;
      } catch { /* 对方不在 / 读不到 ⇒ 这一路比不了,不算命中 */ }
    }
    if (same) {
      return bad('source_locked', `这个文件是本插件自己的库(${p})—— 拒绝打开:自噬 + 锁风险`);
    }
  }

  // ── ③ 魔数闸(open 是懒的:垃圾文件也能 open 成功,必须自己看头)──────────────────────
  if (!isSqliteFile(real)) {
    return bad('not_sqlite', `前 16 字节不是 SQLite 魔数(${JSON.stringify(SQLITE_MAGIC)})—— `
      + '它不是一个 SQLite 库。若这是 SQLCipher 之类的**加密库**,本通道不支持(请先解密或导出成普通库)。');
  }

  const identity = { real, size: st.size, mtime_ms: Math.floor(st.mtimeMs) };
  const sourceIdentity = sqliteIdentityString(identity);

  // ── ④ 只读打开 ────────────────────────────────────────────────────────────────────
  // 打开前先记下源库旁边的侧文件(WAL 库在 `-shm` 缺失、目录可写时,SQLite 自己会建一个 —— 那是源目录的一次写入)
  const sideBefore = sidecarState(real);
  let db = null;
  try { db = new DatabaseSync(real, { readOnly: true, readBigInts: true }); }
  catch (e) { return bad('source_unreadable', `只读打开失败:${msgOf(e)}`); }
  try {
    const timeout = Math.floor(Number(limits.sqliteBusyTimeoutMs ?? 0));
    let busy = null;
    if (Number.isFinite(timeout) && timeout > 0) {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
      const back = db.prepare('PRAGMA busy_timeout').get();
      busy = { want: timeout, got: Number(back?.timeout ?? 0) };
    }

    // ── ⑤ 表枚举(表必须显式选;不猜)──────────────────────────────────────────────────
    let all = [];
    try {
      all = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    } catch (e) {
      return bad('sqlite_read_failed', `读不了表清单(这不像是普通 SQLite 库):${msgOf(e)}`);
    }
    const allNames = all.map((r) => ({ type: String(r.type), name: String(r.name) }));
    const names = allNames.filter((x) => x.type === 'table').map((x) => x.name);
    const viewNames = allNames.filter((x) => x.type === 'view').map((x) => x.name);
    const tables = names.slice(0, SQLITE_TABLES_LISTED);
    const tablesCapped = names.length > tables.length;
    // 视图**不接**,而且要在这里**拦住**(不是放进去再撞错):`PRAGMA table_info` 对视图一律 pk=0(实测),
    // 视图又没有 rowid ⇒ 生成不出稳定定位 —— 拿"行号"当键的话,源一变就会悄悄指到别的行(那是假幂等)。
    const viewNote = viewNames.length === 0 ? '' : `(另有 ${viewNames.length} 个视图不接:${viewNames.slice(0, 6).join('、')}${viewNames.length > 6 ? ' 等' : ''})`;
    const hint = tables.length === 0
      ? `(这个库里**一张表都没有**)${viewNote}`
      : `库里的表:${tables.join('、')}${tablesCapped ? ` 等 ${names.length} 张` : ''}${viewNote}`;

    const table = typeof o.table === 'string' ? o.table.trim() : '';
    if (table === '') {
      return bad('table_required', `表必须**显式选**(不替你猜最大的表 —— 猜错就把不相干的数据灌进馆了)。${hint}`);
    }
    if (viewNames.includes(table)) {
      return bad('table_not_found', `${JSON.stringify(table)} 是个**视图**,本通道不接:视图没有稳定主键(拿行号当键 = 假幂等),请改用它底下的那张表。`);
    }
    if (!names.includes(table)) {
      return bad('table_not_found', `这张表不在库里:${JSON.stringify(table)}。${hint}`);
    }

    // ── ⑥ 列与定位键 ──────────────────────────────────────────────────────────────────
    let cols = [];
    try { cols = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all(); }
    catch (e) { return bad('sqlite_read_failed', `读不了表结构:${msgOf(e)}`); }
    if (!Array.isArray(cols) || cols.length === 0) {
      return bad('table_not_found', `读不到 ${JSON.stringify(table)} 的列(它是视图或空壳?)`);
    }
    const columns = cols.map((c) => ({ name: String(c.name), type: String(c.type ?? '') }));
    const colNames = columns.map((c) => c.name);
    const pk = cols.filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk)) // pk 是**主键里的位次**(复合主键按它排序)
      .map((c) => String(c.name));
    let ridAlias = '';
    if (pk.length === 0) {
      ridAlias = SQLITE_ROWID_ALIASES.find((a) => !colNames.includes(a)) || '';
      if (ridAlias === '') {
        return bad('no_stable_key', `${JSON.stringify(table)} 没有主键,而 rowid / _rowid_ / oid 三个名字都被列名占用了 ⇒ 拿不到稳定定位`);
      }
    }

    // ── ⑦ 取值(只 SELECT;分页在 SQL 层做,大表不整表读进内存)────────────────────────────
    const pageMaxRaw = Math.floor(Number(o.limit ?? 0));
    const pageMax = Number.isFinite(pageMaxRaw) && pageMaxRaw > 0 ? pageMaxRaw : Number(limits.importBatchMaxItems ?? 200);
    const offsetRaw = Math.floor(Number(o.offset ?? 0));
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
    // 别名一律来自白名单常量(不是用户输入)⇒ 不加引号:`SELECT "rowid"` 在某些上下文会回落成字符串字面量。
    const selectList = [...colNames.map(quoteIdent), ...(ridAlias ? [`${ridAlias} AS __rid`] : [])].join(', ');
    let rows = [];
    // ⚠️ **必须显式 ORDER BY**:`LIMIT ? OFFSET ?` 不排序时"第几页是哪些行"是**未定义**的 ——
    //    源库被别的进程写动(VACUUM / REINDEX / 新行)后两次扫描的窗口会漂 ⇒ 翻页**重条目或漏条目**;
    //    同一份源两次读也可能给出不同顺序。有主键 ⇒ 按主键(升序、唯一 ⇒ 页序稳定);
    //    无主键 ⇒ 按**没被列名占用的** rowid 别名(它天然唯一)。
    const orderBy = pk.length > 0 ? pk.map((c) => quoteIdent(c)).join(', ') : ridAlias;
    try {
      rows = db.prepare(`SELECT ${selectList} FROM ${quoteIdent(table)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(pageMax + 1, offset);
    } catch (e) {
      return bad('sqlite_read_failed', `读表失败:${msgOf(e)}`);
    }

    const batchMax = Number(limits.importBatchMaxBytes ?? 0);
    const byteBudget = Number.isFinite(batchMax) && batchMax > 0 ? batchMax : Infinity;
    const units = [];
    let bytes = 0;
    let capped = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (units.length >= pageMax) break; // 多取的那一格就是"还有更多"的证据
      const row = rows[i];
      const text = sqlRowText(columns, row);
      const size = utf8Bytes(text);
      // 字节闸:第一条永远收(否则 next_offset 会原地打转),之后超预算就留给下一页
      if (units.length > 0 && bytes + size > byteBudget) break;
      bytes += size;
      const keyText = pk.length > 0 ? pk.map((n) => sqlValueText(row[n])).join('|') : sqlValueText(row.__rid);
      const { locator, capped: wasCapped } = sqliteLocatorOf(table, keyText);
      if (wasCapped) capped += 1;
      const value = {};
      for (const n of colNames) value[n] = row[n]; // `__rid` 不进单元值:它不该出现在"其他字段"正文里
      units.push({ locator, ordinal: offset + i + 1, raw: text, value, key: keyText, pk });
    }
    const hasMore = rows.length > units.length;

    // ── ⑧ 读完之后两件如实上报的事 ────────────────────────────────────────────────────
    // ① 身份复验(**缩小** TOCTOU 窗口的办法):`node:sqlite` 只收路径、拿不到 fd,所以给不了
    //    `O_NOFOLLOW` 那层保证;这里至少能发现"读的过程中这个路径被换走/文件被改过"。
    //    发现 ≠ 硬拒(别人 checkpoint 一下也会改 mtime),但**绝不许装作没发生**:如实进回执。
    let identityChanged = false;
    try {
      const st2 = statSync(real);
      identityChanged = st2.size !== st.size
        || Math.floor(st2.mtimeMs) !== Math.floor(st.mtimeMs)
        || st2.dev !== st.dev || st2.ino !== st.ino
        || !samePath(real, realpathSync.native(lexical));
    } catch { identityChanged = true; }
    // ② 源目录侧写:实测复现 —— 有 `-wal`、没 `-shm` 时读一次,源目录就会多出 `<库名>-shm`。
    //    这不是"我们写源库"(主库一个字节没动),但确实是**源目录的一次写入** ⇒ 报出来。
    const sidecarCreated = sidecarState(real).filter((p) => sideBefore.indexOf(p) < 0);

    return {
      ok: true,
      source_identity: sourceIdentity,
      identity,
      table,
      columns: colNames,
      column_types: columns.map((c) => ({ name: c.name, type: c.type })),
      pk,
      rowid_alias: ridAlias,
      tables,
      tables_total: names.length,
      tables_capped: tablesCapped,
      views_total: viewNames.length,
      unit_kind: pk.length > 0 ? 'pk' : 'rowid',
      offset,
      page_max: pageMax,
      order_by: orderBy,
      rows_fetched: rows.length,
      units,
      has_more: hasMore,
      locators_capped: capped,
      busy_timeout: busy,
      sidecars_created: sidecarCreated,
      identity_changed: identityChanged,
    };
  } catch (e) {
    return bad('sqlite_read_failed', `读源库时出错:${msgOf(e)}`);
  } finally {
    try { db.close(); } catch { /* 只读句柄;关不掉也不该盖住真正的错 */ }
  }
}
