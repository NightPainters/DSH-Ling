// 1.7 图书馆 · **存储层**(L1:自建 SQLite,与 memory.db 同款 DatabaseSync)。
//
// 为什么是**独立一套**而不是 MemoryStore 的新职责:
//   ① 图书馆的判据是"有源可对账"(交接 §1),条目形态 = 值 + 出处 + 取数时间 + 核对规格,
//      与记忆条目(会话/结论/血缘)没有公共列;
//   ② 零注入(交接 P3)⇒ 它不参与开场装配,不该让记忆库的构造路径依赖它;
//   ③ 契约 §Permanent Boundary:存进记忆库的数据**永不**迁进图书馆,库之间也不该有隐式通道。
//   所以本文件**只**依赖 node: 内置模块,不 import 本插件任何其他文件(留旧形状参考 memory.js
//   的 deep_item,LIKE 口径参考 recall-search.js,但那些是形状参考,不是依赖)。
//
// 本层负责:表结构 / 条目校验 / 新建-修订-撤下生命周期 / 检索 / 核对历史。**不负责**:
//   HTTP 端点、工具注册、界面、裁判员取源(那些归主线)。store 的公开操作**不对模型开放**。
//
// 四条"谁改都不许违反"的语义位(契约 §Item Contract,交接 §6):
//   ① superseded_by **只追不替**,且只指向"同事务里新建的下一版" ⇒ 结构上形不成环;
//   ② source_ref 与 as_of **必填非空**,as_of 不许用 created_at 偷代;
//   ③ checked_state/checked_at **只由 recordCheck 写** —— create/revise 显式拒绝这两个字段,
//      即使调用方把自己的核对结果塞进 item 也进不去;
//   ④ 撤下/取代都**留痕不物理删**,默认检索只看 active 最新版。
import { mkdirSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** 可复核的源类型(契约 §Item Contract,受控枚举)。 */
export const LIBRARY_SOURCE_KINDS = Object.freeze(['standard', 'official-doc', 'manual', 'our-code', 'web']);
/** 条目类目(受控枚举)。 */
export const LIBRARY_CATEGORIES = Object.freeze(['standard-value', 'boundary', 'project-spec', 'external-api']);
/** 核对三态 —— **只有**这三个值 + 未核空串,别的值(如 verified)一律拒绝。 */
export const LIBRARY_CHECK_STATES = Object.freeze(['ok', 'wrong', 'unknown']);
/**
 * 比较器语义(实现归裁判员 library-checker.js,这里只是**受控枚举**与口径说明):
 * - `exact`:**类型严格的 JSON 结构化深比**(数字/字符串/布尔/null/数组/对象逐位同形,
 *   等价于 `isDeepStrictEqual`;`1` 与 `'1'`、`0` 与 `false` 都**不**相等)——
 *   **不是**"`JSON.stringify` 后逐字节比",那会把键序差异也算成不等。
 * - `text-lf`:只把 CRLF/CR 归一成 LF(不 trim、不折叠大小写、不模糊),两端都必须是文本。
 */
export const LIBRARY_COMPARISONS = Object.freeze(['exact', 'text-lf']);

/** `id` 前缀;条目 id 形如 `lib:<uuid>`,lineage_id 取初版 id(同一谱系恒等)。 */
export const LIBRARY_ID_PREFIX = 'lib:';
/** 库文件 schema 版本,存在 library_meta 里(不是 PRAGMA user_version,便于同时读多行元数据)。 */
/**
 * 图书馆库的结构版本。**v2:library_item.import_key**(1.7 导入通道的幂等键,2026-10-12)。
 * 契约 §6:`import_key = sha256(sourceBytes).hex.slice(0,16) + ':' + locator`,空串 = "无键"。
 * 三条口径(测试 §5/§8 逐条钉住):
 * - 它是**身份**,不是内容 ⇒ 既不进 `libraryContentHash`,也不进 `byte_size`
 *   ("同内容换 import_key 照常入库"就是这条:去重认的是键,不是"内容一样就拒");
 * - **只在 create 时给出**(revise 出现即拒):修订不继承导入键,否则新版本会被自己旧版占着的键挡住;
 * - 唯一性**含撤回/被取代的行** ⇒ 重复导入的代价是永久的(撤下是留痕不删,同源同定位再导入仍 skipped)。
 */
export const LIBRARY_STORE_SCHEMA_VERSION = 2;

/**
 * 限额默认值(契约 §Limits)。字段名就是**可配置的名字** —— 主线按配置覆盖时用同一组键,
 * 单位在键名里写明,免得"64"到底是 KiB 还是字节要回头猜。
 */
export const DEFAULT_LIBRARY_LIMITS = Object.freeze({
  itemMaxBytes: 65536,        // 条目(正文 + JSON 元数据)UTF-8 字节上限 = 64 KiB
  resultMaxBytes: 262144,     // 一次响应序列化后的字节上限 = 256 KiB
  queryMaxChars: 512,         // 检索词字符上限
  searchDefaultLimit: 20,     // 检索默认条数
  searchMaxLimit: 100,        // 检索条数上限(契约 §Limits)
  // 浏览面(2026-10-13 主人定):人往下翻就续页;但某组总量到这个数(1000)就切**分页**,
  // 免得渐进累积把会话缓存撑爆 —— 两把尺是同一件事的两半,故放在一起。
  browseDefaultLimit: 200,    // 浏览面一页默认 200 条
  browseMaxLimit: 1000,       // 浏览面单页上限 = 切分页的阈值
  sourceMaxBytes: 2097152,    // 单次取源字节上限 = 2 MiB(裁判员用,本层只回执)
  selectedTextMaxBytes: 16384, // 定位选中的文本上限 = 16 KiB
  selectedTextMaxLines: 200,  // 定位选中的行数上限 = 200
  checkTimeoutMs: 10000,      // 单次核对超时 = 10 s
  checkConcurrency: 2,        // 并发核对 = 2
  sqliteBusyTimeoutMs: 2000,  // SQLite busy timeout = 2 s
  // ── 1.7 导入通道(契约 §7:全部可配、**规范键名**,双限是"条数 × 字节"两把尺)────────────
  // 这五个键同时是**配置面**的键名(config.js 从本表自动派生 library.limits 的 schema),
  // 所以改名等于改配置接口 —— 改这里要同批改契约 §7。
  importBatchMaxItems: 200,       // 单批条数上限
  importBatchMaxBytes: 3145728,   // 单批总字节上限 = 3 MiB
  importTextMaxBytes: 1048576,    // 单次粘贴/上传文本上限 = 1 MiB
  importCandidateMaxBytes: 65536, // 单条正文上限(= itemMaxBytes 同值)
  importModelMaxItems: 60,        // 单批**送模型**提候选的条数上限(成本闸)
});

/** 各限额的**有效区间**(整数闭区间)。越界 ⇒ 构造时抛错(配置错误要响亮,不静默夹取)。 */
const LIMIT_BOUNDS = Object.freeze({
  itemMaxBytes: [1024, 64 * 1024 * 1024],
  resultMaxBytes: [1024, 256 * 1024 * 1024],
  queryMaxChars: [1, 65536],
  searchDefaultLimit: [1, 1000],
  searchMaxLimit: [1, 1000],
  browseDefaultLimit: [1, 5000],
  browseMaxLimit: [1, 5000],
  sourceMaxBytes: [1024, 1024 * 1024 * 1024],
  selectedTextMaxBytes: [64, 16 * 1024 * 1024],
  selectedTextMaxLines: [1, 100000],
  checkTimeoutMs: [1, 600000],
  checkConcurrency: [1, 64],
  sqliteBusyTimeoutMs: [0, 600000],
  // 导入通道(契约 §7):上限留宽、下限守住"至少能放进一条";0 是 importModelMaxItems 的合法值
  // ——"一个都不送模型"是**正当逃生开关**(规则段仍照跑),不是配置错误。
  importBatchMaxItems: [1, 5000],
  importBatchMaxBytes: [1024, 256 * 1024 * 1024],
  importTextMaxBytes: [256, 64 * 1024 * 1024],
  importCandidateMaxBytes: [1, 64 * 1024 * 1024],
  importModelMaxItems: [0, 1000],
});

/** 读接口的分页上限(与检索同一个 100 的口径)。 */
const PAGE_MAX_LIMIT = 100;
const PAGE_DEFAULT_LIMIT = 20;

/**
 * 限额键的**兼容别名**(主线集成时用短名):别名与正名指向同一个内部字段。
 * ⚠️ 同一个字段**只要正名与别名同时出现就抛错** —— 不比较取值:两个名字都给本身就是
 * 语义重复,而"取值相同就放行"会让配置读起来有两个来源(下次只改一处就静默失效)。
 */
const LIMIT_ALIASES = Object.freeze({
  selectionMaxBytes: 'selectedTextMaxBytes',
  selectionMaxLines: 'selectedTextMaxLines',
  concurrency: 'checkConcurrency',
  busyTimeoutMs: 'sqliteBusyTimeoutMs',
});

/** 文本字段的字节上限(元数据自身的护栏;条目总量另受 itemMaxBytes 约束)。 */
const TITLE_MAX_BYTES = 2048;
const SOURCE_REF_MAX_BYTES = 4096;
const VERSION_MAX_BYTES = 512;
const AS_OF_MAX_BYTES = 64;
const WITHDRAW_REASON_MAX_BYTES = 4096;
const EVIDENCE_STRING_MAX_BYTES = 4096;

/** item 载荷里允许出现的字段(可编辑);此外一律拒绝 —— 不做静默剥离(契约 §Item Contract)。 */
const ITEM_INPUT_KEYS = Object.freeze([
  'title', 'body', 'category', 'source_kind', 'source_ref', 'as_of',
  'version', 'conditions', 'check_spec',
]);
/**
 * 导入身份键:只允许在 **create** 时出现(revise 出现即拒 —— 见 `normalizeItemInput` 的注释)。
 * 单独一栏而不并进 `ITEM_INPUT_KEYS`:并进去就等于 revise 也收,而 revise 的 `partial` 回落
 * 会把旧版的键**继承到新版本**,新版本当场被旧版占着的键挡住 ⇒ 导入过的条目将永远无法修订。
 */
const IMPORT_INPUT_KEYS = Object.freeze(['import_key']);
/** 导入键的字节上限(形状另判;它不进条目字节预算,但也不许无限长)。 */
const IMPORT_KEY_MAX_BYTES = 512;
/** 契约 §6 的键形:`<源摘要前 16 hex>:<定位>`。 */
const IMPORT_KEY_RE = /^[0-9a-f]{16}:.+$/;

/** 只读字段:出现即拒绝。`checked_state/checked_at` 在这里被**点名**(防外部伪造认证)。 */
const READONLY_ITEM_KEYS = Object.freeze([
  'id', 'lineage_id', 'revision', 'previous_id', 'content_hash', 'state', 'superseded_by',
  'created_at', 'updated_at', 'checked_state', 'checked_at', 'withdrawn_at', 'withdrawn_reason',
]);
const LOCATOR_KEYS = Object.freeze(['kind', 'start', 'end', 'pointer']);
const CHECK_SPEC_KEYS = Object.freeze(['locator', 'expected', 'comparison']);
/**
 * evidence 允许出现的键。**没有 `hash`**:核对对象的摘要已经有两个正门 ——
 * `recordCheck(itemId, hash, evidence)` 的**第二个参数**(写库时落 `library_check.item_hash`),
 * 以及回执/历史里的 `check.item_hash`。再收一个 `evidence.hash` 只会多出一份**不校验、不落库**
 * 的影子字段(加固前它就在这张表里,却从没人读),所以整条删掉:显式传 `hash` ⇒ `unknown_field`。
 */
const EVIDENCE_KEYS = Object.freeze([
  'state', 'requested_source', 'actual_source', 'source_hash', 'locator',
  'expected', 'observed', 'comparison', 'checked_at', 'reason',
]);

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AS_OF_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const AS_OF_TS_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

const SCHEMA_DDL = `CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS library_item (
  id               TEXT PRIMARY KEY,
  lineage_id       TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  previous_id      TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  category         TEXT NOT NULL,
  source_kind      TEXT NOT NULL,
  source_ref       TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  version          TEXT,
  conditions       TEXT,
  check_spec       TEXT,
  content_hash     TEXT NOT NULL,
  checked_state    TEXT NOT NULL DEFAULT '',
  checked_at       TEXT,
  superseded_by    TEXT NOT NULL DEFAULT '',
  withdrawn_at     TEXT,
  withdrawn_reason TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  import_key       TEXT NOT NULL DEFAULT ''
);
-- ⚠️ import_key 的索引**故意不写在这段 DDL 里**:SCHEMA_DDL 在迁移之前执行,而 v1 老表上
--   还没有这一列 ⇒ CREATE INDEX ... ON library_item(import_key) 会在迁移有机会跑之前就抛
--   "no such column"。索引由 _initializeSchema() 在**确认列存在之后**建(见那里的注释)。
CREATE TABLE IF NOT EXISTS library_check (
  check_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id          TEXT NOT NULL,
  check_sequence   INTEGER NOT NULL,
  item_hash        TEXT NOT NULL,
  state            TEXT NOT NULL,
  requested_source TEXT,
  actual_source    TEXT,
  source_hash      TEXT,
  locator          TEXT,
  expected         TEXT,
  observed         TEXT,
  comparison       TEXT,
  reason           TEXT,
  checked_at       TEXT NOT NULL,
  adopted          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(item_id, check_sequence)
);
CREATE INDEX IF NOT EXISTS library_item_lineage ON library_item(lineage_id, revision);
CREATE INDEX IF NOT EXISTS library_item_state ON library_item(superseded_by, withdrawn_at);
CREATE INDEX IF NOT EXISTS library_check_item ON library_check(item_id, check_sequence);
CREATE INDEX IF NOT EXISTS library_check_hash ON library_check(item_id, item_hash);`;

/** 库不可用(打不开 / 文件不是 SQLite 库 / 目录建不出来)—— 区别于"零命中"。 */
export class LibraryUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LibraryUnavailableError';
    this.code = 'library-unavailable';
    if (cause !== undefined) this.cause = cause;
  }
}

/** UTF-8 字节数(`Buffer.byteLength` 对非字符串会抛,故先要求 string)。 */
export function utf8Bytes(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

/** 规范化摘要:对**规范字段集**做确定性 JSON(键序固定)后 sha256 ⇒ `sha256:<hex>`。 */
export function libraryContentHash(item) {
  const canonical = {
    title: item.title,
    body: item.body,
    category: item.category,
    source_kind: item.source_kind,
    source_ref: item.source_ref,
    as_of: item.as_of,
    version: item.version ?? null,
    conditions: item.conditions ?? null,
    check_spec: item.check_spec ?? null,
  };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

/** 两枚摘要是否指同一内容(与陈旧判据同一处实现,免得两处判据漂移)。 */
export function hashEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = a.trim();
  const y = b.trim();
  return x.length > 0 && x === y;
}

/** text-lf:只把 CRLF/CR 归一成 LF —— 不 trim、不折叠大小写、不模糊匹配(契约 §Item Contract)。 */
export function normalizeTextLf(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * RFC 6901 JSON pointer 求值。返回 `{found, value}`:`found:false` 表示**位置不存在**
 * (契约:missing positions are unknown, not wrong),`value:undefined` 才是"存在且就是 undefined"。
 * 非法指针(不以 `/` 开头且非空串、`~` 后不是 0/1)返回 `{found:false, value:undefined, invalid:true}`。
 */
export function resolveJsonPointer(doc, pointer) {
  if (typeof pointer !== 'string') return { found: false, value: undefined, invalid: true };
  if (pointer === '') return { found: true, value: doc };
  if (!pointer.startsWith('/')) return { found: false, value: undefined, invalid: true };
  const tokens = pointer.slice(1).split('/').map((t) => {
    if (/~(?![01])/.test(t)) return null;
    return t.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  if (tokens.some((t) => t === null)) return { found: false, value: undefined, invalid: true };
  let cur = doc;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return { found: false, value: undefined };
      const idx = Number(token);
      if (idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (cur !== null && typeof cur === 'object') {
      if (!Object.prototype.hasOwnProperty.call(cur, token)) return { found: false, value: undefined };
      cur = cur[token];
      continue;
    }
    return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

/** LIKE 用:`%` `_` `\` 一律转义成字面量(转义符固定 `\`)。 */
function escapeLike(s) {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nowIso() {
  return new Date().toISOString();
}

function fail(reason, status, extra) {
  return Object.assign({ ok: false, reason, ...(status ? { status } : {}) }, extra || {});
}

/**
 * 失败回执的**规范形状**:`reason` 永远是机器可判定的**短码**(调用方按它分流),
 * 人话进 `message`。两者混用一个字段的话回执就没法机械判定了 —— 而"红/绿可判定"
 * 正是这套回执存在的理由(验收要能点名 `invalid_check_state`,而不是去正则匹配一句中文)。
 * `refuse(code, message)` 是给"内部小函数要先返回、由调用方统一做成回执"的场合用的形状。
 */
function refuse(code, message) {
  return { refused: true, response: fail(code, null, { message }) };
}

function bytesOf(value) {
  try {
    return utf8Bytes(JSON.stringify(value));
  } catch {
    return Infinity;
  }
}

/**
 * **严格 JSON 值判定**:只接受能**无损**穿过 `JSON.stringify` 的数据 ——
 * null / 布尔 / 有限数字 / 字符串 / 纯数据对象(原型为 `Object.prototype` 或 `null`)/ 数组,
 * 且不含环。合法返回 `null`,否则返回一句带出错路径的人话。
 *
 * 为什么非严不可:这些值落库前都要过 `JSON.stringify`,而它**会悄悄改值** ——
 * `Infinity`/`NaN` ⇒ `null`、值为 `undefined`/函数/Symbol 的键 ⇒ **整个键被丢掉**、
 * 数组空位 ⇒ `null`、`-0` ⇒ `0`、`BigInt` ⇒ 直接抛。任何一处发生,写进库的就不再是调用方
 * 给的那份数据(内容摘要也跟着漂移),所以必须在**入库前**拒掉,而不是靠 `bytesOf` 的
 * try/catch 兜成一句"超出字节上限"的误导回执 —— 实测:自引用环加固前正是以那个理由被拒的,
 * 而 `Infinity` 这类"能序列化但会变值"的则**直接混进库**(见 §13 回归断言)。
 */
function jsonValueProblem(value, label) {
  return scanJsonValue(value, label, []);
}

function scanJsonValue(value, path, ancestors) {
  const at = path.length > 120 ? `${path.slice(0, 117)}…` : path;
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return null;
  if (kind === 'number') {
    if (!Number.isFinite(value)) return `${at} 不能是非有限数字(${String(value)}):JSON 会把它悄悄变成 null`;
    if (Object.is(value, -0)) return `${at} 不能是 -0:JSON 会把它悄悄变成 0`;
    return null;
  }
  if (kind === 'undefined') return `${at} 不能是 undefined:JSON 会把这个键整个丢掉`;
  if (kind === 'bigint') return `${at} 不能是 BigInt:JSON.stringify 会直接抛错`;
  if (kind === 'function') return `${at} 不能是函数:JSON 会把这个键整个丢掉`;
  if (kind === 'symbol') return `${at} 不能是 Symbol:JSON 会把这个键整个丢掉`;
  if (ancestors.includes(value)) return `${at} 出现环(对象/数组自引用):JSON.stringify 会直接抛错`;
  ancestors.push(value);
  let problem = null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        problem = `${at}[${i}] 是数组空位:JSON 会把它变成 null`;
        break;
      }
      problem = scanJsonValue(value[i], `${at}[${i}]`, ancestors);
      if (problem) break;
    }
  } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    for (const key of Object.keys(value)) {
      problem = scanJsonValue(value[key], `${at}.${key}`, ancestors);
      if (problem) break;
    }
  } else {
    problem = `${at} 不是纯数据对象(原型既不是 Object.prototype 也不是 null):JSON 序列化会改它的形状`;
  }
  ancestors.pop();
  return problem;
}

/**
 * 显式 `checked_at`:必须是**合法 UTC ISO 时刻**(带 `Z`,如 `2026-10-06T12:00:00.000Z`),
 * 且日历与时分秒字段都能回读 —— `2026-02-30T00:00:00Z` / `2026-10-06T25:00:00Z` / 月份 13 一律拒。
 * 形状复用 `AS_OF_TS_RE`(与 `as_of` 的 UTC 时刻**同一条正则** ⇒ 两处口径不会各自漂移)。
 *
 * **只有完全缺省(`undefined`)才允许取当前时刻** —— 内部调用可以不传该字段;
 * 一旦显式给了值,就绝不静默改写成 `now()`。加固前这里对任何非字符串(含 `null`、数字、数组)
 * 和空串都 `.trim()` 后回落 `now()`(见旧 `checkedAtOrNow`),于是"证据写着 12:00、落库却是此刻"
 * 这种**账实不符**不会被任何断言发现 —— 而 `checked_at` 恰恰是认证的观测时间。
 */
function checkCheckedAt(v) {
  if (v === undefined) return { ok: true, value: nowIso() };
  if (typeof v !== 'string') {
    return fail('invalid_evidence', null, {
      message: `evidence.checked_at 必须是 UTC ISO 时刻字符串(收到 ${v === null ? 'null' : typeof v});`
        + '要取当前时刻就整个字段不传,不许用别的类型顶替',
    });
  }
  const t = v.trim();
  if (t === '' || t !== v) {
    return fail('invalid_evidence', null, {
      message: 'evidence.checked_at 必须是显式的 UTC ISO 时刻(不许留空、不许带首尾空白);'
        + '要取当前时刻就整个字段不传',
    });
  }
  const m = AS_OF_TS_RE.exec(t);
  if (!m) {
    return fail('invalid_evidence', null, {
      message: 'evidence.checked_at 必须是带 Z 的 UTC ISO 时刻(如 2026-10-06T12:00:00.000Z);'
        + '无 Z 的本地时间、带 +08:00 偏移量、纯日期一律拒绝',
    });
  }
  const [y, mo, d, hh, mi, ss] = [Number(m[1]), Number(m[2]), Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  const realDay = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  if (!realDay || hh > 23 || mi > 59 || ss > 59) {
    return fail('invalid_evidence', null, {
      message: `evidence.checked_at 不是真实存在的 UTC 时刻:${t}(形状对但日历/时刻越界)`,
    });
  }
  return { ok: true, value: t };
}

/** 严格整数解析:数字必须是整数;"12"/"12 " 可接受(表单来的字符串),其余一律 undefined。 */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  return undefined;
}

/**
 * 限额规范化(契约 §Limits:Configuration validated at activation; invalid values fail loudly)。
 * 主线可复用本函数做激活期校验;`base` 允许传部分覆盖。
 */
export function normalizeLibraryLimits(base) {
  if (base === undefined || base === null) return Object.freeze({ ...DEFAULT_LIBRARY_LIMITS });
  if (!isPlainObject(base)) throw new TypeError('limits 必须是普通对象');
  const out = { ...DEFAULT_LIBRARY_LIMITS };
  const seen = new Map();
  for (const [rawKey, raw] of Object.entries(base)) {
    const key = LIMIT_ALIASES[rawKey] ?? rawKey;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIBRARY_LIMITS, key)) {
      throw new RangeError(`limits 未知字段 ${rawKey}(可用:${Object.keys(DEFAULT_LIBRARY_LIMITS).join(', ')}`
        + ` 或别名 ${Object.keys(LIMIT_ALIASES).join(', ')})`);
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw new TypeError(`limits.${rawKey} 必须是整数(收到 ${JSON.stringify(raw)})`);
    }
    if (seen.has(key)) {
      throw new RangeError(`limits 同一个字段给了两个名字(${seen.get(key)} 与 ${rawKey}),`
        + '给两个名字本身就是语义重复(不比较取值,取值相同也拒)');
    }
    seen.set(key, rawKey);
    const [lo, hi] = LIMIT_BOUNDS[key];
    if (raw < lo || raw > hi) {
      throw new RangeError(`limits.${rawKey} 越界:${raw} 不在 [${lo}, ${hi}]`);
    }
    out[key] = raw;
  }
  if (out.browseDefaultLimit > out.browseMaxLimit) {
    throw new RangeError(`limits.browseDefaultLimit(${out.browseDefaultLimit})`
      + ` 不能大于 limits.browseMaxLimit(${out.browseMaxLimit})`);
  }
  if (out.searchDefaultLimit > out.searchMaxLimit) {
    throw new RangeError(`limits.searchDefaultLimit(${out.searchDefaultLimit})`
      + ` 不能大于 limits.searchMaxLimit(${out.searchMaxLimit})`);
  }
  return Object.freeze(out);
}

function checkIsoAsOf(text) {
  const t = String(text).trim();
  if (t !== text || t === '') return fail('invalid_as_of', null, { message: 'as_of 必须是显式的 ISO 日期(YYYY-MM-DD)或 UTC 时刻(…Z),不许留空' });
  if (utf8Bytes(t) > AS_OF_MAX_BYTES) return fail('invalid_as_of', null, { message: `as_of 长度超过 ${AS_OF_MAX_BYTES} 字节` });
  const dateMatch = AS_OF_DATE_RE.exec(t);
  const tsMatch = dateMatch ? null : AS_OF_TS_RE.exec(t);
  if (!dateMatch && !tsMatch) {
    return fail('invalid_as_of', null, { message: 'as_of 必须是 YYYY-MM-DD 或带 Z 的 UTC ISO 时刻(如 2026-10-06T00:00:00Z)' });
  }
  const m = dateMatch || tsMatch;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return fail('invalid_as_of', null, { message: 'as_of 的日期部分不是真实日历日' });
  }
  if (tsMatch) {
    const [hh, mi, ss] = [Number(m[4]), Number(m[5]), Number(m[6])];
    if (hh > 23 || mi > 59 || ss > 59) return fail('invalid_as_of', null, { message: 'as_of 的时刻部分越界' });
  }
  return { ok: true, value: t };
}

function checkTitle(text) {
  if (utf8Bytes(text) > TITLE_MAX_BYTES) return fail('invalid_item', null, { message: `title 超过 ${TITLE_MAX_BYTES} 字节` });
  return { ok: true };
}

function checkSourceRef(text) {
  if (utf8Bytes(text) > SOURCE_REF_MAX_BYTES) return fail('invalid_source_ref', null, { message: `source_ref 超过 ${SOURCE_REF_MAX_BYTES} 字节` });
  return { ok: true };
}

function checkVersion(v, limits) {
  if (v === undefined || v === null) return { ok: true, value: null };
  let text;
  if (typeof v === 'string') text = v.trim();
  else if (typeof v === 'number' && Number.isFinite(v)) text = String(v);
  // ⚠️ `Object.keys(v).length === v.length` 是**空位判据**:every()/map() 都会跳过数组空位,
  //   于是 `['1', , '2']` 能混过 every,再由 join('+') 悄悄变成 `'1+'`(键名被改)。空位一律拒。
  else if (Array.isArray(v) && v.length > 0 && Object.keys(v).length === v.length
    && v.every((x) => typeof x === 'string' && x.trim() !== '')) {
    text = v.map((x) => x.trim()).join('+');
  } else return fail('invalid_version', null, { message: 'version 必须是字符串、有限数字或非空字符串数组' });
  if (text === '') return fail('invalid_version', null, { message: 'version 给定了就不能是空串(要么省略)' });
  if (utf8Bytes(text) > Math.min(VERSION_MAX_BYTES, limits.itemMaxBytes)) {
    return fail('invalid_version', null, { message: `version 超过 ${VERSION_MAX_BYTES} 字节` });
  }
  return { ok: true, value: text };
}

function checkConditions(c, limits) {
  if (c === undefined || c === null) return { ok: true, value: null };
  if (typeof c === 'string') {
    const t = c.trim();
    if (t === '') return fail('invalid_conditions', null, { message: 'conditions 给定了就不能是空串(要么省略)' });
    if (utf8Bytes(t) > limits.itemMaxBytes) return fail('invalid_conditions', null, { message: 'conditions 超出条目字节上限' });
    return { ok: true, value: t };
  }
  if (Array.isArray(c)) {
    if (c.length === 0) return fail('invalid_conditions', null, { message: 'conditions 数组必须非空且每项是非空字符串' });
    // ⚠️ 逐项检查而不是 `c.every(...)`:every()/map() **会跳过数组空位**,`['a', , 'b']`
    //   因此能混过旧写法,再被 JSON 序列化成 null(数据被悄悄改)。
    for (let i = 0; i < c.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(c, i)) {
        return fail('invalid_conditions', null, { message: `conditions[${i}] 是数组空位:JSON 会把它变成 null` });
      }
      const x = c[i];
      if (typeof x !== 'string' || x.trim() === '') {
        return fail('invalid_conditions', null, { message: 'conditions 数组必须非空且每项是非空字符串' });
      }
    }
    const arr = c.map((x) => x.trim());
    if (bytesOf(arr) > limits.itemMaxBytes) return fail('invalid_conditions', null, { message: 'conditions 超出条目字节上限' });
    return { ok: true, value: arr };
  }
  if (isPlainObject(c)) {
    const keys = Object.keys(c);
    if (keys.length === 0) return fail('invalid_conditions', null, { message: 'conditions 对象必须非空' });
    // ⚠️ 拷贝**不能用** `o[k] = v`:键名 `__proto__` 会撞上 Object.prototype 上的访问器,
    //   赋值被静默忽略 —— 实测:自有键 `__proto__` 的 conditions 落库后变成 `{}`(键丢了)。
    //   Object.fromEntries 走 CreateDataProperty,键原样成为自有数据属性,不碰原型链。
    const entries = [];
    let total = 0;
    for (const k of keys) {
      const v = c[k];
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean' && v !== null) {
        return fail('invalid_conditions', null, { message: `conditions.${k} 只能是字符串/数字/布尔/null(显式适用条件不许塞嵌套结构)` });
      }
      // 数字这一档还要挡 NaN/Infinity/-0:它们"类型合法"却会被 JSON 悄悄改成 null/0。
      const scalarBad = jsonValueProblem(v, `conditions.${k}`);
      if (scalarBad) return fail('invalid_conditions', null, { message: scalarBad });
      entries.push([k, v]);
      total += utf8Bytes(k) + utf8Bytes(String(v));
      if (total > limits.itemMaxBytes) return fail('invalid_conditions', null, { message: 'conditions 超出条目字节上限' });
    }
    return { ok: true, value: Object.fromEntries(entries) };
  }
  return fail('invalid_conditions', null, { message: 'conditions 只能是字符串、非空字符串数组或扁平对象' });
}

// ⚠️ 行段/指针两个校验器**只看 locator 自己的键与值**(调用方传进来的就是 locator):
//   它们不该去审 `spec.expected` —— 早先版本在这里多写了一条"只允许 kind/start/end",
//   结果把 `spec.expected` 这个合法字段当成未知字段,连最普通的 lines 规格都建不进去
//   (测试第一次跑就抓到;这类"校验器越权审别人的字段"是自伤型缺陷)。
function checkLinesLocator(locator, expected, limits) {
  const keys = Object.keys(locator);
  if (keys.some((k) => k !== 'kind' && k !== 'start' && k !== 'end')) {
    return fail('invalid_check_spec', null, { message: 'lines 定位只允许 kind/start/end' });
  }
  const start = toInt(locator.start);
  const end = toInt(locator.end);
  if (start === undefined || end === undefined || start < 1 || end < start) {
    return fail('invalid_check_spec', null, { message: 'lines 定位要求 1 <= start <= end 的整数行号' });
  }
  if (end - start + 1 > limits.selectedTextMaxLines) {
    return fail('invalid_check_spec', null, { message: `lines 定位选中的行数(${end - start + 1})超过 ${limits.selectedTextMaxLines} 行上限` });
  }
  if (typeof expected !== 'string') {
    return fail('invalid_check_spec', null, { message: 'lines 定位的 expected 必须是文本' });
  }
  if (utf8Bytes(expected) > limits.selectedTextMaxBytes) {
    return fail('invalid_check_spec', null, { message: `lines 定位的 expected 超过 ${limits.selectedTextMaxBytes} 字节(选中文本上限)` });
  }
  return { ok: true, locator: { kind: 'lines', start, end } };
}

function checkJsonPointerLocator(locator, expected, limits) {
  const keys = Object.keys(locator);
  if (keys.some((k) => k !== 'kind' && k !== 'pointer')) {
    return fail('invalid_check_spec', null, { message: 'json-pointer 定位只允许 kind/pointer' });
  }
  const pointer = locator.pointer;
  if (typeof pointer !== 'string') return fail('invalid_check_spec', null, { message: 'json-pointer 定位的 pointer 必须是字符串' });
  if (pointer !== '') {
    if (pointer[0] !== '/') return fail('invalid_check_spec', null, { message: 'RFC 6901 指针必须以 / 开头(空串表示整篇)' });
    if (/~(?![01])/.test(pointer)) return fail('invalid_check_spec', null, { message: 'RFC 6901 指针里 ~ 只能出现在 ~0/~1 中' });
  }
  if (expected === undefined) return fail('invalid_check_spec', null, { message: 'json-pointer 定位必须显式给 expected(JSON 值;null 也算显式)' });
  // expected 是**任意 JSON 值**,但必须是能无损序列化的那种:加固前 `Infinity`/`NaN`/
  // 嵌套非有限数/undefined/函数/空位/环都能混进来,落库时被 JSON 悄悄改成 null 或丢键
  // (实测:`expected: Infinity` 建得进去,读回却是 `null`,规格与摘要一起被改写)。
  const expectedBad = jsonValueProblem(expected, 'check_spec.expected');
  if (expectedBad) return fail('invalid_check_spec', null, { message: expectedBad });
  if (bytesOf(expected) > limits.itemMaxBytes) return fail('invalid_check_spec', null, { message: 'expected 超出条目字节上限' });
  return { ok: true, locator: { kind: 'json-pointer', pointer } };
}

/** check_spec:null(不可核)或 {locator, expected, comparison} —— 其余一律拒绝。 */
function checkCheckSpec(raw, limits) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) return fail('invalid_check_spec', null, { message: 'check_spec 只能是 null 或 {locator, expected, comparison}' });
  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => !CHECK_SPEC_KEYS.includes(k));
  if (unknown.length) return fail('invalid_check_spec', null, { message: `check_spec 未知字段:${unknown.join(', ')}` });
  const missing = CHECK_SPEC_KEYS.filter((k) => !keys.includes(k));
  if (missing.length) return fail('invalid_check_spec', null, { message: `check_spec 缺字段:${missing.join(', ')}` });
  if (!Object.prototype.hasOwnProperty.call(raw, 'expected')) {
    return fail('invalid_check_spec', null, { message: 'check_spec.expected 必须显式给出' });
  }
  if (typeof raw.comparison !== 'string' || !LIBRARY_COMPARISONS.includes(raw.comparison)) {
    return fail('invalid_check_spec', null, { message: `comparison 只能是 ${LIBRARY_COMPARISONS.join(' | ')}` });
  }
  // text-lf 的语义就是"把换行归一后比文本":expected 不是文本时这条比较器根本没法执行,
  // 加固前它会一路建进库,直到裁判员那边才变成必然的 mismatch —— 建不出来的规格要当场拒。
  if (raw.comparison === 'text-lf' && typeof raw.expected !== 'string') {
    return fail('invalid_check_spec', null, {
      message: 'comparison=text-lf 时 expected 必须是文本(换行归一只对文本有意义;要核 JSON 值请用 exact)',
    });
  }
  const loc = raw.locator;
  if (!isPlainObject(loc)) return fail('invalid_check_spec', null, { message: 'locator 必须是对象' });
  // ⚠️ locator 自己的**未知字段**必须在这里先判(lunknown),不能丢给下面的类型校验器 ——
  //   它们只认自己那一类的键,拿不到"这个键本来就不该存在"的语义(测试里 `kind:'lines'` 还多带
  //   一个 `lines:3` 就是靠这一条被拒的)。
  const lunknown = Object.keys(loc).filter((k) => !LOCATOR_KEYS.includes(k));
  if (lunknown.length) return fail('invalid_check_spec', null, { message: `locator 未知字段:${lunknown.join(', ')}` });
  if (loc.kind !== 'lines' && loc.kind !== 'json-pointer') {
    return fail('invalid_check_spec', null, { message: "locator.kind 只能是 'lines' 或 'json-pointer'" });
  }
  const res = loc.kind === 'lines'
    ? checkLinesLocator(loc, raw.expected, limits)
    : checkJsonPointerLocator(loc, raw.expected, limits);
  if (!res.ok) return res;
  const value = {
    locator: res.locator,
    expected: raw.expected,
    comparison: raw.comparison,
  };
  if (bytesOf(value) > limits.itemMaxBytes) return fail('invalid_check_spec', null, { message: 'check_spec 超出条目字节上限' });
  return { ok: true, value };
}

/**
 * 导入键校验:`空串即无`(与全库其余可选文本同一惯例;显式 null 也当"无")。
 * 形状不对**当场拒** —— 一条永远匹配不上的键躺在库里,唯一的下场就是让"重复导入"漏过去。
 */
function checkImportKey(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') return fail('invalid_import_key', null, { message: 'import_key 必须是字符串' });
  const s = raw.trim();
  if (s === '') return { ok: true, value: '' };
  if (utf8Bytes(s) > IMPORT_KEY_MAX_BYTES) {
    return fail('invalid_import_key', null, { message: `import_key 超过 ${IMPORT_KEY_MAX_BYTES} 字节上限` });
  }
  if (!IMPORT_KEY_RE.test(s)) {
    return fail('invalid_import_key', null, {
      message: "import_key 形状非法(期望 `<源摘要前 16 hex>:<定位>`,见契约 §6)",
    });
  }
  return { ok: true, value: s };
}

/**
 * 条目规范化。`partial:true`(revise)时缺省字段回落到 `fallback`(当前版),显式 null 表示
 * **清空该可选字段**;`partial:false`(create)时缺省即错误。任何模式下未知字段/只读字段都拒绝。
 */
function normalizeItemInput(raw, limits, opts) {
  const fallback = opts?.fallback ?? null;
  const partial = opts?.partial === true;
  if (!isPlainObject(raw)) return fail('invalid_type', null, { message: '条目必须是普通对象' });
  const unknown = Object.keys(raw).filter((k) => !ITEM_INPUT_KEYS.includes(k)
    && !READONLY_ITEM_KEYS.includes(k) && !IMPORT_INPUT_KEYS.includes(k));
  if (unknown.length) return fail('unknown_field', null, { message: `条目含未知字段:${unknown.join(', ')}` });
  const readonly = Object.keys(raw).filter((k) => READONLY_ITEM_KEYS.includes(k));
  if (readonly.length) {
    return fail('readonly_field', null, { message: `条目含只读字段:${readonly.join(', ')}` });
  }
  // 导入键只在 create(`partial:false`)时收。revise 的缺省回落是"继承当前版",若把旧版的
  // import_key 继承到新版本,新版本会被旧版占着的键挡住(导入过的条目就此无法修订)。
  if (partial && Object.keys(raw).some((k) => IMPORT_INPUT_KEYS.includes(k))) {
    return fail('readonly_field', null, {
      message: 'import_key 只在 create 时给出(修订不继承导入键:重复导入认的是键,不是修订)',
    });
  }
  const importKeyBad = partial ? { ok: true, value: '' } : checkImportKey(raw.import_key);
  if (!importKeyBad.ok) return importKeyBad;

  let title;
  if (Object.prototype.hasOwnProperty.call(raw, 'title')) title = raw.title;
  else if (partial && fallback) title = fallback.title;
  if (typeof title !== 'string' || title.trim() === '') return fail('invalid_title', null, { message: 'title 必填且非空' });
  title = title.trim();
  const titleBad = checkTitle(title);
  if (!titleBad.ok) return titleBad;

  let body;
  if (Object.prototype.hasOwnProperty.call(raw, 'body')) body = raw.body;
  else if (partial && fallback) body = fallback.body;
  if (typeof body !== 'string' || body === '') return fail('invalid_body', null, { message: 'body 必填且非空' });

  let category;
  if (Object.prototype.hasOwnProperty.call(raw, 'category')) category = raw.category;
  else if (partial && fallback) category = fallback.category;
  if (typeof category !== 'string' || !LIBRARY_CATEGORIES.includes(category.trim())) {
    return fail('invalid_category', null, { message: `category 只能是 ${LIBRARY_CATEGORIES.join(' | ')}` });
  }
  category = category.trim();

  let sourceKind;
  if (Object.prototype.hasOwnProperty.call(raw, 'source_kind')) sourceKind = raw.source_kind;
  else if (partial && fallback) sourceKind = fallback.source_kind;
  if (typeof sourceKind !== 'string' || !LIBRARY_SOURCE_KINDS.includes(sourceKind.trim())) {
    return fail('invalid_source_kind', null, { message: `source_kind 只能是 ${LIBRARY_SOURCE_KINDS.join(' | ')}` });
  }
  sourceKind = sourceKind.trim();

  let sourceRef;
  if (Object.prototype.hasOwnProperty.call(raw, 'source_ref')) sourceRef = raw.source_ref;
  else if (partial && fallback) sourceRef = fallback.source_ref;
  if (typeof sourceRef !== 'string' || sourceRef.trim() === '') {
    return fail('invalid_source_ref', null, { message: 'source_ref 必填非空(没有出处就不许进图书馆)' });
  }
  sourceRef = sourceRef.trim();
  const refBad = checkSourceRef(sourceRef);
  if (!refBad.ok) return refBad;

  let asOf;
  if (Object.prototype.hasOwnProperty.call(raw, 'as_of')) asOf = raw.as_of;
  else if (partial && fallback) asOf = fallback.as_of;
  if (typeof asOf !== 'string') return fail('invalid_as_of', null, { message: 'as_of 必填(显式 ISO 日期或 UTC 时刻,不由创建时间推断)' });
  const asOfBad = checkIsoAsOf(asOf);
  if (!asOfBad.ok) return asOfBad;
  asOf = asOfBad.value;

  let version;
  if (Object.prototype.hasOwnProperty.call(raw, 'version')) version = raw.version;
  else if (partial && fallback) version = fallback.version;
  const verBad = checkVersion(version, limits);
  if (!verBad.ok) return verBad;

  let conditions;
  if (Object.prototype.hasOwnProperty.call(raw, 'conditions')) conditions = raw.conditions;
  else if (partial && fallback) conditions = fallback.conditions;
  const condBad = checkConditions(conditions, limits);
  if (!condBad.ok) return condBad;

  let checkSpec;
  if (Object.prototype.hasOwnProperty.call(raw, 'check_spec')) checkSpec = raw.check_spec;
  else if (partial && fallback) checkSpec = fallback.check_spec;
  const specBad = checkCheckSpec(checkSpec, limits);
  if (!specBad.ok) return specBad;

  const value = {
    title,
    body,
    category,
    source_kind: sourceKind,
    source_ref: sourceRef,
    as_of: asOf,
    version: verBad.value,
    conditions: condBad.value,
    check_spec: specBad.value,
  };
  // 契约:条目 UTF-8 字节上限 **包含 JSON 元数据**(不是只看 body 长度)。
  const total = bytesOf(value);
  if (total > limits.itemMaxBytes) {
    return fail('item_too_large', null, { message: `条目总计 ${total} 字节,超过 ${limits.itemMaxBytes} 字节上限(含 JSON 元数据)` });
  }
  value.byte_size = total;
  // 导入键在**字节判定之后**才挂上去:它是身份不是内容 —— 既不该占条目字节预算,
  // 也不该进 libraryContentHash(那两个判据都只看"内容字段":换键不换内容)。
  if (!partial) value.import_key = importKeyBad.value;
  return { ok: true, value };
}

function parseJsonColumn(raw, field, id) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`library_item.check_spec/conditions 列解析失败(id=${id}, field=${field}):${e?.message ?? e}`);
  }
}

function rowToRecord(row) {
  return {
    id: row.id,
    lineage_id: row.lineage_id,
    revision: Number(row.revision),
    previous_id: row.previous_id || null,
    title: row.title,
    body: row.body,
    category: row.category,
    source_kind: row.source_kind,
    source_ref: row.source_ref,
    as_of: row.as_of,
    version: row.version === null || row.version === undefined ? null : row.version,
    conditions: row.conditions === null || row.conditions === undefined
      ? null
      : parseJsonColumn(row.conditions, 'conditions', row.id),
    check_spec: row.check_spec === null || row.check_spec === undefined
      ? null
      : parseJsonColumn(row.check_spec, 'check_spec', row.id),
    content_hash: row.content_hash,
    state: row.withdrawn_at ? 'withdrawn' : (row.superseded_by ? 'superseded' : 'active'),
    superseded_by: row.superseded_by || null,
    checked_state: row.checked_state || '',
    checked_at: row.checked_at ?? null,
    withdrawn_at: row.withdrawn_at ?? null,
    withdrawn_reason: row.withdrawn_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // 空串即无(与库里的存储形状同一口径):回执里 null = "这条不是从导入通道进来的"。
    import_key: row.import_key ? row.import_key : null,
  };
}

function checkRowToRecord(row) {
  return {
    check_sequence: Number(row.check_sequence),
    item_id: row.item_id,
    item_hash: row.item_hash,
    state: row.state,
    requested_source: row.requested_source ?? null,
    actual_source: row.actual_source ?? null,
    source_hash: row.source_hash ?? null,
    locator: row.locator === null || row.locator === undefined
      ? null
      : parseJsonColumn(row.locator, 'locator', row.item_id),
    expected: row.expected === null || row.expected === undefined
      ? null
      : parseJsonColumn(row.expected, 'expected', row.item_id),
    observed: row.observed === null || row.observed === undefined
      ? null
      : parseJsonColumn(row.observed, 'observed', row.item_id),
    comparison: row.comparison ?? null,
    reason: row.reason ?? null,
    checked_at: row.checked_at,
    adopted: Number(row.adopted) === 1,
  };
}

/**
 * 条目 id 只接受本库自产的形状 `lib:<uuid>` —— 拒绝乱七八糟的 id 是**减少攻击面**,
 * 不是洁癖:它同时挡住把外部字符串拼进 SQL 的冲动。
 */
function parseLibraryId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text.startsWith(LIBRARY_ID_PREFIX)) return null;
  const uuid = text.slice(LIBRARY_ID_PREFIX.length).toLowerCase();
  if (!UUID_RE.test(uuid)) return null;
  return LIBRARY_ID_PREFIX + uuid;
}

/**
 * 证据里的 locator:允许"直接给定位对象"或"给一句源内定位描述(有界字符串)"。
 * 返回值**形状统一**为 `{locator}` —— 修前它在"没有定位"时返回裸 null,调用方却按
 * `locator.refused` 读 ⇒ 直接用 null 去取属性会抛 TypeError(测试当场抓到)。形状不统一
 * 就是这种"平时不报、边界就炸"的根源,故这里只回一种形状。
 */
function canonicalizeEvidenceLocator(raw, spec, limits) {
  if (raw === undefined || raw === null) return { locator: spec === null ? null : spec.locator };
  if (isPlainObject(raw)) {
    const loc = raw.kind === 'lines'
      ? checkLinesLocator(raw, '', limits)
      : (raw.kind === 'json-pointer' ? checkJsonPointerLocator(raw, null, limits) : null);
    if (!loc) return refuse('invalid_locator', "evidence.locator.kind 只能是 'lines' 或 'json-pointer'");
    if (loc.ok) return { locator: loc.locator };
    return refuse('invalid_locator', `evidence.locator 非法:${loc.message ?? loc.reason}`);
  }
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return { locator: spec === null ? null : spec.locator };
    if (utf8Bytes(t) > EVIDENCE_STRING_MAX_BYTES) {
      return refuse('invalid_locator', `evidence.locator 超过 ${EVIDENCE_STRING_MAX_BYTES} 字节`);
    }
    return { locator: t };
  }
  return refuse('invalid_locator', 'evidence.locator 只能是对象或字符串');
}

function checkEvidenceValue(value, label, limits) {
  if (value === undefined) return { ok: true, value: null };
  // ⚠️ 不能只靠 `bytesOf` 判大小:它的 try/catch 把"序列化不了"兜成 Infinity,而
  //   `Infinity`/`NaN`/`undefined` 这类**能序列化但会变值**的它根本发现不了
  //   (`JSON.stringify(Infinity) === 'null'`,于是按 4 字节通过、落库成了 null)。
  const problem = jsonValueProblem(value, `evidence.${label}`);
  if (problem) return fail('invalid_evidence', null, { message: problem });
  const size = bytesOf(value);
  if (!Number.isFinite(size)) return fail('invalid_evidence', null, { message: `evidence.${label} 无法序列化成 JSON` });
  if (size > limits.itemMaxBytes) {
    return fail('invalid_evidence', null, { message: `evidence.${label} 超过 ${limits.itemMaxBytes} 字节上限` });
  }
  return { ok: true, value };
}

function checkEvidenceText(value, label, required) {
  if (value === undefined || value === null) {
    if (required) return fail('invalid_evidence', null, { message: `evidence.${label} 必填(核对凭据必须写明它查的是哪个源)` });
    return { ok: true, value: null };
  }
  if (typeof value !== 'string') return fail('invalid_evidence', null, { message: `evidence.${label} 必须是字符串` });
  const t = value.trim();
  if (required && t === '') return fail('invalid_evidence', null, { message: `evidence.${label} 不能为空` });
  if (utf8Bytes(value) > EVIDENCE_STRING_MAX_BYTES) {
    return fail('invalid_evidence', null, { message: `evidence.${label} 超过 ${EVIDENCE_STRING_MAX_BYTES} 字节` });
  }
  return { ok: true, value: t === '' ? null : value };
}

/** 核对凭据校验 + 规范化(契约 §Checker Surface 的 evidence 字段清单)。 */
function normalizeEvidence(raw, limits, spec) {
  if (!isPlainObject(raw)) return fail('invalid_type', null, { message: 'evidence 必须是普通对象' });
  const unknown = Object.keys(raw).filter((k) => !EVIDENCE_KEYS.includes(k));
  if (unknown.length) return fail('unknown_field', null, { message: `evidence 未知字段:${unknown.join(', ')}` });

  if (typeof raw.state !== 'string' || !LIBRARY_CHECK_STATES.includes(raw.state.trim())) {
    return fail('invalid_check_state', null, {
      message: `evidence.state 只能是 ${LIBRARY_CHECK_STATES.join(' | ')}(伪造的 verified/ok-ish 状态一律拒绝)`,
    });
  }
  const state = raw.state.trim();
  if (state !== 'ok' && !(typeof raw.reason === 'string' && raw.reason.trim() !== '')) {
    return fail('invalid_evidence', null, { message: `evidence.state=${state} 必须给出具体 reason(查不到就不是对/错)` });
  }

  const requested = checkEvidenceText(raw.requested_source, 'requested_source', true);
  if (!requested.ok) return requested;
  const actual = checkEvidenceText(raw.actual_source, 'actual_source', false);
  if (!actual.ok) return actual;
  const sourceHash = checkEvidenceText(raw.source_hash, 'source_hash', false);
  if (!sourceHash.ok) return sourceHash;
  if (sourceHash.value !== null && !HASH_RE.test(sourceHash.value)) {
    return fail('invalid_evidence', null, { message: 'evidence.source_hash 必须是 sha256:<64 位小写十六进制>' });
  }
  const reason = checkEvidenceText(raw.reason, 'reason', false);
  if (!reason.ok) return reason;
  const comparison = checkEvidenceText(raw.comparison, 'comparison', false);
  if (!comparison.ok) return comparison;
  if (comparison.value !== null && !LIBRARY_COMPARISONS.includes(comparison.value)) {
    return fail('invalid_evidence', null, { message: `evidence.comparison 只能是 ${LIBRARY_COMPARISONS.join(' | ')}` });
  }
  const locator = canonicalizeEvidenceLocator(raw.locator, spec, limits);
  if (locator.refused) return locator.response;
  const expected = checkEvidenceValue(raw.expected, 'expected', limits);
  if (!expected.ok) return expected;
  const observed = checkEvidenceValue(raw.observed, 'observed', limits);
  if (!observed.ok) return observed;
  const checkedAt = checkCheckedAt(raw.checked_at);
  if (!checkedAt.ok) return checkedAt;

  // 字节数按**规范化后的证据**算,不按调用方给的原样对象:原样对象里可能夹着非 JSON 值,
  // `bytesOf` 会兜成 Infinity(加固前这里就是这么来的 —— 一个夹带 BigInt 的 checked_at
  // 会让回执自报 Infinity 字节)。现在每个字段都已单独验过,这一份一定可序列化;
  // 仍按规范化后的对象算,是为了让"落库的那份"和"计字节的那份"**始终是同一个对象**。
  const value = {
    state,
    requested_source: requested.value,
    actual_source: actual.value,
    source_hash: sourceHash.value,
    locator: locator.locator,
    expected: expected.value,
    observed: observed.value,
    comparison: comparison.value,
    reason: reason.value,
    checked_at: checkedAt.value,
  };
  value.byte_size = bytesOf(value);
  return { ok: true, value };
}

/**
 * 给回执加一个**不可枚举**的兼容别名。为什么不可枚举:它不出现在 `Object.keys`/`JSON.stringify`
 * 里 ⇒ 不占响应字节(256 KiB 上限是按序列化后算的)、也不会被当成两个字段各自渲染;
 * 但 `res.items` 这种点读法照旧可用(与 memory.js 的 countView 同一手法)。
 * ⚠️ `search()` **不再**挂任何不可枚举的 `total` 别名:主线已把那个伪总数彻底删掉,
 *   检索回执只有 `count`(本页)/`nextOffset`/`truncated`(回归断言见测试 §8)。
 */
function alias(target, name, value) {
  Object.defineProperty(target, name, { value, enumerable: false, configurable: true, writable: false });
  return target;
}

/** 条目载荷里出现的"绝不允许从外部写入"的认证字段 —— 报错文案单列,便于验收点名。 */
const FORGED_STATE_KEYS = Object.freeze(['checked_state', 'checked_at']);

/**
 * LibraryStore —— 图书馆存储层。所有公开操作**同步**返回规范 `{ok,...}` 记录。
 *
 * 构造失败(打不开 / 不是 SQLite 库 / 目录不可建)抛 `LibraryUnavailableError`:
 * "库不可用"与"零命中"必须是可区分的两件事(契约 §Store Surface: unavailable != zero results)。
 * 构造之后的**读写异常一律上抛**(不 catch-return-empty)—— 静默吞掉数据库错误会把故障
 * 伪装成"没有数据",那正是本次要避免的语义。
 */
export class LibraryStore {
  constructor(dbPath, limits) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new TypeError('LibraryStore(dbPath, limits):dbPath 必须是非空字符串');
    }
    this.path = dbPath;
    // ⚠️ 顺序照 memory.js 的实测教训:busy_timeout 必须在任何可能撞锁的语句**之前**
    //   (DDL 之前、journal_mode 之前);否则非 WAL 库遇到写锁时会在毫秒级抛 database is locked。
    this.limits = normalizeLibraryLimits(limits);
    this.closed = false;
    try {
      if (dbPath !== ':memory:') mkdirFor(dbPath);
      this.db = new DatabaseSync(dbPath);
    } catch (e) {
      throw new LibraryUnavailableError(
        `图书馆库打不开(${dbPath}):${e?.message ?? e}`, e);
    }
    try {
      this.db.exec(`PRAGMA busy_timeout=${this.limits.sqliteBusyTimeoutMs};`);
      this.db.exec('PRAGMA foreign_keys=ON;');
      this.db.exec('PRAGMA journal_mode=WAL;');
      this.db.exec(SCHEMA_DDL);
      this._initializeSchema();
      this._prepare();
    } catch (e) {
      try { this.db.close(); } catch { /* 初始化没成功,关不关得掉都不改变结论 */ }
      this.closed = true;
      if (e instanceof LibraryUnavailableError) throw e;
      throw new LibraryUnavailableError(`图书馆库初始化失败(${dbPath}):${e?.message ?? e}`, e);
    }
  }

  /** 建表 + 元数据自证(迁移后回读一次,失败即抛,不留"静默列缺失"的路)。 */
  _initializeSchema() {
    const cur = this.db.prepare('SELECT value FROM library_meta WHERE key=?').get('schema_version');
    if (cur === undefined) {
      this.db.prepare('INSERT INTO library_meta(key,value) VALUES(?,?)')
        .run('schema_version', String(LIBRARY_STORE_SCHEMA_VERSION));
    } else if (Number(cur.value) === 1 && LIBRARY_STORE_SCHEMA_VERSION === 2) {
      // v1 → v2:唯一的迁移路。显式 ALTER + 回读自证 + 成功后才前进版本;
      // 任何一步不成 ⇒ 抛(绝不带着"旧结构 + 新版本号"跑起来)。
      this._migrateV1toV2();
    } else if (Number(cur.value) !== LIBRARY_STORE_SCHEMA_VERSION) {
      throw new Error(`library 库 schema_version=${cur.value},本版期望 ${LIBRARY_STORE_SCHEMA_VERSION}`
        + '(不认识的库不许就地改写,请另行处置)');
    }
    const cols = this.db.prepare('PRAGMA table_info(library_item)').all().map((c) => c.name);
    const want = ['id', 'lineage_id', 'revision', 'previous_id', 'title', 'body', 'category',
      'source_kind', 'source_ref', 'as_of', 'version', 'conditions', 'check_spec', 'content_hash',
      'checked_state', 'checked_at', 'superseded_by', 'withdrawn_at', 'withdrawn_reason',
      'created_at', 'updated_at', 'import_key'];
    const missing = want.filter((c) => !cols.includes(c));
    if (missing.length) throw new Error(`library_item 缺列:${missing.join(', ')}`);
    // 导入键的唯一性**由库自己保证**:部分唯一索引 —— `空串即无`,没有键的行不受约束。
    // 放在这里(而不是 SCHEMA_DDL)是因为 DDL 先于迁移执行,而 v1 老表上还没有这一列。
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS library_item_import_key
      ON library_item(import_key) WHERE import_key<>'';`);
    const ccols = this.db.prepare('PRAGMA table_info(library_check)').all().map((c) => c.name);
    const cwant = ['check_id', 'item_id', 'check_sequence', 'item_hash', 'state', 'requested_source',
      'actual_source', 'source_hash', 'locator', 'expected', 'observed', 'comparison', 'reason',
      'checked_at', 'adopted'];
    const cmissing = cwant.filter((c) => !ccols.includes(c));
    if (cmissing.length) throw new Error(`library_check 缺列:${cmissing.join(', ')}`);
  }

  /**
   * v1 → v2:`library_item` 加 `import_key`(纯增列)。
   * 幂等(先探列再 ALTER,重复跑不报错)+ 自证(回读不到该列 ⇒ 抛,版本不前进);
   * ALTER 与版本前进**同一个事务**,中途失败不留"半迁移却已前进"的组合。
   */
  _migrateV1toV2() {
    this._tx(() => {
      const cols = this.db.prepare('PRAGMA table_info(library_item)').all().map((c) => c.name);
      if (!cols.includes('import_key')) {
        this.db.exec("ALTER TABLE library_item ADD COLUMN import_key TEXT NOT NULL DEFAULT ''");
      }
      const back = this.db.prepare('PRAGMA table_info(library_item)').all().map((c) => c.name);
      if (!back.includes('import_key')) {
        throw new Error('library 库 v1→v2 迁移未生效:library_item.import_key 仍缺(schema_version 不前进)');
      }
      this.db.prepare('UPDATE library_meta SET value=? WHERE key=?')
        .run(String(LIBRARY_STORE_SCHEMA_VERSION), 'schema_version');
    });
  }

  _prepare() {
    this.st = {
      insertItem: this.db.prepare(`INSERT INTO library_item
        (id, lineage_id, revision, previous_id, title, body, category, source_kind, source_ref, as_of,
         version, conditions, check_spec, content_hash, checked_state, checked_at, superseded_by,
         withdrawn_at, withdrawn_reason, created_at, updated_at, import_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'',NULL,'',NULL,NULL,?,?,?)`),
      // 幂等查重:空串是"无键"(不受部分唯一索引约束),故显式排掉。
      byImportKey: this.db.prepare(
        "SELECT id FROM library_item WHERE import_key=? AND import_key<>'' LIMIT 1"),
      getItem: this.db.prepare('SELECT * FROM library_item WHERE id=?'),
      byLineage: this.db.prepare('SELECT * FROM library_item WHERE lineage_id=? ORDER BY revision ASC'),
      lineageHead: this.db.prepare(
        'SELECT * FROM library_item WHERE lineage_id=? ORDER BY revision DESC LIMIT 1'),
      sameContent: this.db.prepare(
        'SELECT id FROM library_item WHERE lineage_id=? AND content_hash=? AND revision<>? ORDER BY revision ASC LIMIT 1'),
      nextRevision: this.db.prepare(
        'SELECT COALESCE(MAX(revision),0)+1 AS rev FROM library_item WHERE lineage_id=?'),
      setSuperseded: this.db.prepare(
        "UPDATE library_item SET superseded_by=? WHERE id=? AND content_hash=? AND superseded_by='' AND withdrawn_at IS NULL"),
      withdraw: this.db.prepare(
        "UPDATE library_item SET withdrawn_at=?, withdrawn_reason=?, updated_at=? WHERE id=? AND content_hash=? AND superseded_by='' AND withdrawn_at IS NULL"),
      adoptCheck: this.db.prepare(
        "UPDATE library_item SET checked_state=?, checked_at=?, updated_at=? WHERE id=? AND content_hash=? AND superseded_by='' AND withdrawn_at IS NULL"),
      insertCheck: this.db.prepare(`INSERT INTO library_check
        (item_id, check_sequence, item_hash, state, requested_source, actual_source, source_hash,
         locator, expected, observed, comparison, reason, checked_at, adopted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
      nextSeq: this.db.prepare(
        'SELECT COALESCE(MAX(check_sequence),0)+1 AS seq FROM library_check WHERE item_id=?'),
      // ⚠️ 回读**必须按 (item_id, check_sequence) 两把钥匙**:check_sequence 是**每条目独立**的
      //   序号(契约:"Each attempt has an ordered sequence"),不是全局唯一 —— 只按它去 SELECT *
      //   会撞到**别的条目**的同号行(实测:第二个条目的"第 1 次核对"回读到第一个条目的行)。
      //   全局唯一那把钥匙是 check_id(AUTOINCREMENT),不对外暴露。
      seqRow: this.db.prepare('SELECT * FROM library_check WHERE item_id=? AND check_sequence=?'),
      listChecks: this.db.prepare(
        'SELECT * FROM library_check WHERE item_id=? ORDER BY check_sequence ASC LIMIT ? OFFSET ?'),
      countChecks: this.db.prepare('SELECT COUNT(*) AS n FROM library_check WHERE item_id=?'),
      allOfLineageForState: this.db.prepare(
        'SELECT id, superseded_by, withdrawn_at FROM library_item WHERE lineage_id=?'),
      stateCounts: this.db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN superseded_by='' AND withdrawn_at IS NULL THEN 1 ELSE 0 END),0) AS active,
          COALESCE(SUM(CASE WHEN superseded_by<>'' THEN 1 ELSE 0 END),0) AS superseded,
          COALESCE(SUM(CASE WHEN superseded_by='' AND withdrawn_at IS NOT NULL THEN 1 ELSE 0 END),0) AS withdrawn,
          COALESCE(MAX(revision),0) AS max_revision
        FROM library_item`),
      countsForLineage: this.db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN superseded_by='' AND withdrawn_at IS NULL THEN 1 ELSE 0 END),0) AS active,
          COALESCE(SUM(CASE WHEN superseded_by<>'' THEN 1 ELSE 0 END),0) AS superseded,
          COALESCE(SUM(CASE WHEN superseded_by='' AND withdrawn_at IS NOT NULL THEN 1 ELSE 0 END),0) AS withdrawn
        FROM library_item WHERE lineage_id=?`),
      countChecksForLineage: this.db.prepare(
        'SELECT COUNT(*) AS n FROM library_check WHERE item_id IN (SELECT id FROM library_item WHERE lineage_id=?)'),
      checkCountsByItem: this.db.prepare(
        'SELECT item_id, COUNT(*) AS n FROM library_check WHERE item_id IN'
        + ' (SELECT id FROM library_item WHERE lineage_id=?) GROUP BY item_id'),
    };
  }

  /** 事务:先获取跨连接写锁,再读状态/写入;异常回滚后上抛,不吞失败。 */
  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始异常 */ }
      throw e;
    }
  }

  /** 关闭后的统一回执:`reason` 是机器短码 `closed`,人话进 `message`,并保留 `code:'closed'`。 */
  _closedResponse() {
    return fail('closed', null, { message: '图书馆库已关闭', code: 'closed' });
  }

  _assertOpen() {
    if (this.closed) throw new LibraryUnavailableError('图书馆库已关闭');
  }

  /** 新建条目:新建版本号=1、lineage=自身 id,认证状态一律为空(只能由 recordCheck 写)。 */
  create(item) {
    if (this.closed) return this._closedResponse();
    const bad = forgeryGuard(item);
    if (bad) return bad;
    const norm = normalizeItemInput(item, this.limits, { partial: false });
    if (!norm.ok) return norm;
    const value = norm.value;
    const id = LIBRARY_ID_PREFIX + randomUUID();
    const at = nowIso();
    // 查重与写入**必须在同一个写事务里**(BEGIN IMMEDIATE):先查后写之间若有第二个连接提交,
    // 两笔都会过预检 —— 那样"幂等"就只是"大多数时候成立"。
    const out = this._tx(() => {
      if (value.import_key) {
        const dup = this.st.byImportKey.get(value.import_key);
        if (dup) return { dup: dup.id };
      }
      try {
        this.st.insertItem.run(
          id, id, 1, '', value.title, value.body, value.category, value.source_kind, value.source_ref,
          value.as_of, value.version, jsonOrNull(value.conditions), jsonOrNull(value.check_spec),
          libraryContentHash(value), at, at, value.import_key ?? '',
        );
      } catch (e) {
        // 库里的部分唯一索引是最后一道闸(并发下两笔同时过预检才撞到这里):
        // 归成同一个 reason,不外泄 SQLite 错误码 —— 调用方只需知道"这个键已经有了"。
        if (value.import_key && /UNIQUE|library_item_import_key/i.test(String(e?.message))) {
          return { dup: this.st.byImportKey.get(value.import_key)?.id ?? '' };
        }
        throw e;
      }
      return { record: rowToRecord(this.st.getItem.get(id)) };
    });
    if (out.dup !== undefined) {
      return fail('duplicate_import', null, {
        message: `这个导入键已经有条目了(幂等:同源同定位只进一次;撤下/被取代的行也算占用):${value.import_key}`,
        duplicate_of: out.dup || null,
      });
    }
    return { ok: true, item: out.record, byte_size: value.byte_size };
  }

  /**
   * 修订:必须拿"当前 active 最新版 + 它观测到的 content_hash"。新版本**换新 id**、
   * previous_id 指向被取代的旧版,旧版 superseded_by 只追不替 —— 两笔写在同一事务里,
   * 所以 superseded_by 结构上不可能指向"不是刚建出来的下一版",也就形不成环。
   * 认证状态**重置**(新内容不该继承旧认证)。
   */
  revise(id, item, expectedHash) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(id);
    if (!canonicalId) return fail('invalid_argument', null, { message: `id 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(id)}` });
    if (typeof expectedHash !== 'string' || expectedHash.trim() === '') {
      return fail('invalid_argument', null, { message: 'expectedHash 必填(修订必须带上观测到的 content_hash,防陈旧覆盖)' });
    }
    const bad = forgeryGuard(item);
    if (bad) return bad;
    // Read state/hash only after acquiring the writer lock. A second connection
    // may commit between a preflight read and BEGIN; synchronous JS is no lock.
    return this._tx(() => {
      const current = this.st.getItem.get(canonicalId);
      if (!current) return fail('not_found', null, { message: `条目不存在:${canonicalId}` });
      if (current.withdrawn_at) return fail('not_active', null, { message: '条目已撤下,不能修订(撤下是终态留痕)' });
      if (current.superseded_by) return fail('not_active', null, { message: '条目已被新版取代,只能修订当前最新版' });
      if (!hashEqual(expectedHash, current.content_hash)) {
        return fail('hash_mismatch', 'stale', {
          message: `expectedHash 与当前 content_hash 不一致(陈旧观测):期望 ${current.content_hash},`
            + `收到 ${String(expectedHash).trim()}`,
          current_hash: current.content_hash,
        });
      }
      const currentRecord = rowToRecord(current);
      const norm = normalizeItemInput(item, this.limits, { partial: true, fallback: currentRecord });
      if (!norm.ok) return norm;
      const value = norm.value;
      const newHash = libraryContentHash(value);
      if (newHash === current.content_hash) {
        return fail('no_change', null, {
          message: '内容与当前版完全一致,没有产生新修订(避免同一事务里造出重复版本)',
          content_hash: current.content_hash,
        });
      }
      const twin = this.st.sameContent.get(current.lineage_id, newHash, current.revision);
      if (twin) {
        return fail('duplicate_content', null, { message: `该内容已是本谱系的另一版(${twin.id}),不需要重复修订` });
      }
      const newId = LIBRARY_ID_PREFIX + randomUUID();
      const at = nowIso();
      const rev = Number(this.st.nextRevision.get(current.lineage_id).rev);
      this.st.insertItem.run(
        newId, current.lineage_id, rev, canonicalId, value.title, value.body, value.category,
        value.source_kind, value.source_ref, value.as_of, value.version, jsonOrNull(value.conditions),
        jsonOrNull(value.check_spec), newHash, at, at,
        // 修订**不继承**导入键(空串 = 无键):键标识的是"这一次导入",不是谱系;
        // 继承的话新版本会被旧版占着的同一个键挡住(而且那是唯一索引,库层面也过不去)。
        '',
      );
      const changed = this.st.setSuperseded.run(newId, canonicalId, current.content_hash);
      if (Number(changed.changes) !== 1) throw new Error('修订目标在事务内失去 active/hash 条件,已回滚');
      return {
        ok: true,
        item: rowToRecord(this.st.getItem.get(newId)),
        previous: rowToRecord(this.st.getItem.get(canonicalId)),
        byte_size: value.byte_size,
      };
    });
  }

  /** 撤下:reason 与 expectedHash **都必填**;只改状态留痕,不物理删除(历史与核对记录都留着)。 */
  withdraw(id, reason, expectedHash) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(id);
    if (!canonicalId) return fail('invalid_argument', null, { message: `id 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(id)}` });
    if (typeof reason !== 'string' || reason.trim() === '') {
      return fail('invalid_argument', null, { message: 'withdraw 必须给出非空 reason(撤下不是静默删除)' });
    }
    if (utf8Bytes(reason) > WITHDRAW_REASON_MAX_BYTES) {
      return fail('invalid_argument', null, { message: `reason 超过 ${WITHDRAW_REASON_MAX_BYTES} 字节` });
    }
    if (typeof expectedHash !== 'string' || expectedHash.trim() === '') {
      return fail('invalid_argument', null, { message: 'withdraw 必须带上观测到的 content_hash' });
    }
    return this._tx(() => {
      const current = this.st.getItem.get(canonicalId);
      if (!current) return fail('not_found', null, { message: `条目不存在:${canonicalId}` });
      if (current.withdrawn_at) return fail('not_active', null, { message: '条目已经撤下过了(撤下不重复执行)' });
      if (current.superseded_by) return fail('not_active', null, { message: '条目已被新版取代;要撤下请撤下当前最新版' });
      if (!hashEqual(expectedHash, current.content_hash)) {
        return fail('hash_mismatch', 'stale', {
          message: `expectedHash 与当前 content_hash 不一致(陈旧观测):期望 ${current.content_hash},`
            + `收到 ${String(expectedHash).trim()}`,
          current_hash: current.content_hash,
        });
      }
      const at = nowIso();
      const changed = this.st.withdraw.run(at, reason.trim(), at, canonicalId, current.content_hash);
      if (Number(changed.changes) !== 1) throw new Error('撤下目标在事务内失去 active/hash 条件,已回滚');
      return { ok: true, item: rowToRecord(this.st.getItem.get(canonicalId)) };
    });
  }

  /** 单条读:任何状态都读得到(撤下/被取代是留痕,不是消失);不存在 ⇒ not_found 且 found:false。 */
  get(id) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(id);
    if (!canonicalId) return fail('invalid_argument', null, { message: `id 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(id)}` });
    const row = this.st.getItem.get(canonicalId);
    if (!row) return fail('not_found', null, { message: `条目不存在:${canonicalId}`, found: false });
    return { ok: true, found: true, item: rowToRecord(row) };
  }

  /** 谱系历史:全部版本(含被取代/已撤下)+ 每条核对数 + 有界分页。 */
  history(id, opts) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(id);
    if (!canonicalId) return fail('invalid_argument', null, { message: `id 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(id)}` });
    const paging = resolvePaging(opts, this.limits);
    if (!paging.ok) return paging.response;
    const row = this.st.getItem.get(canonicalId);
    if (!row) return fail('not_found', null, { message: `条目不存在:${canonicalId}`, found: false });
    const all = this.st.byLineage.all(row.lineage_id).map(rowToRecord);
    const counts = this.st.countsForLineage.get(row.lineage_id);
    const checksTotal = Number(this.st.countChecksForLineage.get(row.lineage_id).n);
    const currentId = currentOf(all)?.id ?? null;
    const checkCount = new Map();
    for (const c of this.st.checkCountsByItem.all(row.lineage_id)) {
      checkCount.set(c.item_id, Number(c.n));
    }
    const revisions = all.map((it) => ({
      id: it.id,
      revision: it.revision,
      previous_id: it.previous_id,
      state: it.state,
      superseded_by: it.superseded_by,
      withdrawn_at: it.withdrawn_at,
      withdrawn_reason: it.withdrawn_reason,
      content_hash: it.content_hash,
      title: it.title,
      checked_state: it.checked_state,
      checked_at: it.checked_at,
      created_at: it.created_at,
      updated_at: it.updated_at,
      check_count: checkCount.get(it.id) ?? 0,
      is_current: it.id === currentId,
    }));
    const slice = revisions.slice(paging.offset, paging.offset + paging.limit);
    const hasMore = paging.offset + slice.length < revisions.length;
    const { kept, capped } = capByBytes(slice, this.limits.resultMaxBytes, (k, wasCapped) => ({
      ok: true,
      found: true,
      item_id: canonicalId,
      lineage_id: row.lineage_id,
      revision_count: revisions.length,
      check_total: checksTotal,
      counts: { active: Number(counts.active), superseded: Number(counts.superseded), withdrawn: Number(counts.withdrawn) },
      offset: paging.offset,
      limit: paging.limit,
      count: k.length,
      nextOffset: (wasCapped || hasMore) && k.length > 0 ? paging.offset + k.length : null,
      truncated: wasCapped || hasMore,
      revisions: k,
    }));
    // 兼容别名(不可枚举):主线读 `history().items` 可用,但序列化里只有 `revisions` 一份数据。
    const out = { ...kept, byte_size: bytesOf(kept) };
    return alias(out, 'items', out.revisions);
  }
  /**
   * 检索:默认**只看 active 最新版**;多词 = 空白切分后 AND(title/body/category 任一中出现即可);
   * `% _ \` 一律按字面量(`LIKE ? ESCAPE '\'`);分页有界,响应受 resultMaxBytes 约束。
   * 空查询是**参数错误**(不是"零命中")—— 把用错参数伪装成没数据是最误导的一类回执。
   */
  search(query) {
    if (this.closed) return this._closedResponse();
    const raw = query === undefined || query === null ? {} : query;
    if (!isPlainObject(raw)) return fail('invalid_type', null, { message: 'search 参数必须是对象:{q, limit?, offset?, includeInactive?}' });
    const unknown = Object.keys(raw).filter((k) => !['q', 'limit', 'offset', 'includeInactive'].includes(k));
    if (unknown.length) return fail('unknown_field', null, { message: `search 未知参数:${unknown.join(', ')}` });
    if (typeof raw.q !== 'string') return fail('invalid_query', null, { message: 'q 必填(字符串)' });
    const q = raw.q.trim();
    if (q === '') return fail('invalid_query', null, { message: 'q 不能为空(空查询会返回全部条目,这不是检索)' });
    if (q.length > this.limits.queryMaxChars) {
      return fail('query_too_long', null, { message: `q 长度 ${q.length} 字符,超过 ${this.limits.queryMaxChars} 字符上限` });
    }
    const limit = raw.limit === undefined ? this.limits.searchDefaultLimit : toInt(raw.limit);
    if (limit === undefined || limit < 1 || limit > this.limits.searchMaxLimit) {
      return fail('invalid_limit', null, { message: `limit 必须是 1..${this.limits.searchMaxLimit} 的整数(默认 ${this.limits.searchDefaultLimit})` });
    }
    const offset = raw.offset === undefined ? 0 : toInt(raw.offset);
    if (offset === undefined || offset < 0) return fail('invalid_offset', null, { message: 'offset 必须是 >= 0 的整数' });
    if (raw.includeInactive !== undefined && typeof raw.includeInactive !== 'boolean') {
      return fail('invalid_argument', null, { message: 'includeInactive 只能是布尔值' });
    }
    const includeInactive = raw.includeInactive === true;
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length === 0) return fail('invalid_query', null, { message: 'q 里没有可检索的词' });
    const clauses = words.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
    const where = [includeInactive ? '1=1' : "superseded_by='' AND withdrawn_at IS NULL", ...clauses].join(' AND ');
    const args = [];
    for (const w of words) {
      const pat = `%${escapeLike(w)}%`;
      args.push(pat, pat, pat);
    }
    // 多取 1 条只为判定"后面还有没有",不对外暴露 "总数" —— 契约禁止误导性 total。
    const rows = this.db.prepare(
      `SELECT * FROM library_item WHERE ${where} ORDER BY revision DESC, created_at DESC, id ASC LIMIT ? OFFSET ?`,
    ).all(...args, limit + 1, offset);
    const moreInDb = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToRecord);
    const hasMore = moreInDb;
    const { kept, capped } = capByBytes(items, this.limits.resultMaxBytes, (k, wasCapped) => ({
      ok: true,
      query: q,
      words,
      includeInactive,
      items: k,
      count: k.length,
      offset,
      limit,
      nextOffset: (wasCapped || hasMore) && k.length > 0 ? offset + k.length : null,
      truncated: wasCapped || hasMore,
    }));
    // 单条就超上限时 kept 为空:这时必须让 nextOffset 指回同一个 offset(而不是 null),
    // 否则"换个更小的 limit 重试"这条出路被回执自己堵死。
    if (kept.count === 0 && rows.length > 0) kept.nextOffset = offset;
    const out = { ...kept, byte_size: bytesOf(kept) };
    return out;
  }

  /**
   * 浏览:**不搜也能翻** —— 按 `category` / `source_kind` 两个分组维度列条目。
   * 与 `search` 的分工(这不是它的重复实现):
   *   · `search` 要关键词,且**默认只看 active 最新版**(`includeInactive` 是存储层内部扩展,面不外露);
   *   · `browse` 不要关键词,且**看全部** —— 撤下/被取代的行走的是留痕不是消失,它们也是馆藏
   *     (条目自带 `state`,要区分由调用方自己看)。
   * 回执**不给 total**(契约禁止误导性 total):只给本页 + `nextOffset` + `truncated`;
   * 另附一张 `groups` 分组计数表(**与筛选无关,恒定全量**)—— 浏览树的组节点靠它,
   * 否则每翻一页骨架都会跟着变。
   */
  browse(query) {
    if (this.closed) return this._closedResponse();
    const raw = query === undefined || query === null ? {} : query;
    if (!isPlainObject(raw)) return fail('invalid_type', null, { message: 'browse 参数必须是对象:{category?, source_kind?, offset?, limit?}' });
    const unknown = Object.keys(raw).filter((k) => !['category', 'source_kind', 'offset', 'limit', 'fields'].includes(k));
    if (unknown.length) return fail('unknown_field', null, { message: `browse 未知参数:${unknown.join(', ')}` });
    if (raw.category !== undefined && !LIBRARY_CATEGORIES.includes(raw.category)) {
      return fail('invalid_argument', null, { message: `category 只能是 ${LIBRARY_CATEGORIES.join(' / ')}(实际 ${JSON.stringify(raw.category)})` });
    }
    if (raw.source_kind !== undefined && !LIBRARY_SOURCE_KINDS.includes(raw.source_kind)) {
      return fail('invalid_argument', null, { message: `source_kind 只能是 ${LIBRARY_SOURCE_KINDS.join(' / ')}(实际 ${JSON.stringify(raw.source_kind)})` });
    }
    // `fields`:'full'(默认,整条含正文)/ 'row'(列表行,**不带正文**)。列表行存在的理由是字节预算:
    // 单条正文上限 64 KiB,而一次响应总共只有 resultMaxBytes(256 KiB) ⇒ 200 条带正文必然被截,
    // 于是"翻到底再加载"会变成"翻到底只拿到几条"。列表只要标题与标记,正文由详情面按 id 单取。
    const fields = raw.fields === undefined ? 'full' : raw.fields;
    if (fields !== 'full' && fields !== 'row') {
      return fail('invalid_argument', null, { message: `fields 只能是 full / row(实际 ${JSON.stringify(raw.fields)})` });
    }
    const limit = raw.limit === undefined ? this.limits.browseDefaultLimit : toInt(raw.limit);
    if (limit === undefined || limit < 1 || limit > this.limits.browseMaxLimit) {
      return fail('invalid_limit', null, { message: `limit 必须是 1..${this.limits.browseMaxLimit} 的整数(默认 ${this.limits.browseDefaultLimit})` });
    }
    const offset = raw.offset === undefined ? 0 : toInt(raw.offset);
    if (offset === undefined || offset < 0) return fail('invalid_offset', null, { message: 'offset 必须是 >= 0 的整数' });
    const where = [];
    const args = [];
    if (raw.category !== undefined) { where.push('category=?'); args.push(raw.category); }
    if (raw.source_kind !== undefined) { where.push('source_kind=?'); args.push(raw.source_kind); }
    // 多取 1 条只为判定"后面还有没有"(与 search 同一手法):total 从缺,分页靠 nextOffset。
    const rows = this.db.prepare(
      `SELECT * FROM library_item${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
      + ' ORDER BY category ASC, source_kind ASC, revision DESC, created_at DESC, id ASC LIMIT ? OFFSET ?',
    ).all(...args, limit + 1, offset);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => {
      const rec = rowToRecord(row);
      if (fields !== 'row') return rec;
      const body = rec.body;
      const out = { ...rec };
      delete out.body;
      out.body_chars = typeof body === 'string' ? body.length : 0;
      return out;
    });
    const groups = this.db.prepare(
      'SELECT category, source_kind, COUNT(*) AS n,'
      + " SUM(CASE WHEN superseded_by='' AND withdrawn_at IS NULL THEN 1 ELSE 0 END) AS active_n"
      + ' FROM library_item GROUP BY category, source_kind ORDER BY category ASC, source_kind ASC',
    ).all().map((g) => ({ category: g.category, source_kind: g.source_kind, count: Number(g.n), active: Number(g.active_n) }));
    const { kept, capped } = capByBytes(items, this.limits.resultMaxBytes, (k, wasCapped) => ({
      ok: true,
      category: raw.category === undefined ? null : raw.category,
      source_kind: raw.source_kind === undefined ? null : raw.source_kind,
      fields,
      groups,
      items: k,
      count: k.length,
      offset,
      limit,
      nextOffset: (wasCapped || hasMore) && k.length > 0 ? offset + k.length : null,
      truncated: wasCapped || hasMore,
    }));
    // 同 search:单条就超上限时"换个更小的 limit 重试"这条出路不许被回执自己堵死。
    if (kept.count === 0 && rows.length > 0) kept.nextOffset = offset;
    const out = { ...kept, byte_size: bytesOf(kept) };
    return out;
  }

  /** 库级画像:各状态条数 + 核对数 + 限额(供 /library/status 用)。**不报 total 用于检索分页**。 */
  stats() {
    if (this.closed) return this._closedResponse();
    const c = this.st.stateCounts.get();
    const checks = Number(this.db.prepare('SELECT COUNT(*) AS n FROM library_check').get().n);
    const lineages = Number(this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT lineage_id FROM library_item)').get().n);
    const adopted = Number(this.db.prepare('SELECT COUNT(*) AS n FROM library_check WHERE adopted=1').get().n);
    return {
      ok: true,
      items: {
        total: Number(c.active) + Number(c.superseded) + Number(c.withdrawn),
        active: Number(c.active),
        superseded: Number(c.superseded),
        withdrawn: Number(c.withdrawn),
        lineages,
        max_revision: Number(c.max_revision),
      },
      checks: { total: checks, adopted },
      limits: { ...this.limits },
      schema_version: LIBRARY_STORE_SCHEMA_VERSION,
    };
  }

  /**
   * 记录一次**已完成**的核对(裁判员调用;本方法不对模型开放)。
   * - 每一次完成都留档(check_sequence 单调递增,按条目独立编排);
   * - 只有"条目仍是 active 最新版"且"哈希与本次核对对象一致"才**采纳**为最新认证;
   * - 陈旧证据返回 adopted:false(不报错)—— 它仍然是历史证据,只是不再代表当前内容;
   * - 条目不存在:证据照留(审计用),adopted:false。绝不吞掉写库异常。
   */
  recordCheck(itemId, hash, evidence) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(itemId);
    if (!canonicalId) return fail('invalid_argument', null, { message: `itemId 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(itemId)}` });
    if (typeof hash !== 'string' || !HASH_RE.test(hash.trim())) {
      return fail('invalid_argument', null, { message: 'hash 必须是 sha256:<64 位小写十六进制>(核对对象的内容摘要)' });
    }
    const wantHash = hash.trim();
    return this._tx(() => {
      const row = this.st.getItem.get(canonicalId);
      const spec = row ? (row.check_spec === null || row.check_spec === undefined
        ? null : parseJsonColumn(row.check_spec, 'check_spec', canonicalId)) : null;
      const norm = normalizeEvidence(evidence, this.limits, spec);
      if (!norm.ok) return norm;
      const ev = norm.value;
      const eligible = Boolean(row) && !row.superseded_by && !row.withdrawn_at && hashEqual(wantHash, row.content_hash);
      const at = ev.checked_at;
      // Adoption and history share the same transaction. An inactive/stale row
      // still gets its completed evidence; a failed CAS never erases that record.
      const adopted = eligible && Number(this.st.adoptCheck.run(ev.state, at, at, canonicalId, wantHash).changes) === 1;
      const next = Number(this.st.nextSeq.get(canonicalId).seq);
      this.st.insertCheck.run(
        canonicalId, next, wantHash, ev.state, ev.requested_source, ev.actual_source, ev.source_hash,
        jsonOrNull(ev.locator), jsonOrNull(ev.expected), jsonOrNull(ev.observed), ev.comparison,
        ev.reason, at, adopted ? 1 : 0,
      );
      // Receipt is read under the same writer lock, never from a later state.
      const inserted = checkRowToRecord(this.st.seqRow.get(canonicalId, next));
      return {
        ok: true,
        adopted,
        reason: adopted ? null : (row ? 'stale_or_inactive' : 'item_missing'),
        item_id: canonicalId,
        check_sequence: next,
        state: ev.state,
        checked_at: at,
        checked_state: adopted ? ev.state : (row ? row.checked_state || '' : ''),
        check: inserted,
      };
    });
  }

  /** 核对历史(按 check_sequence 升序 = 时间单调),有界分页 + 字节上限。 */
  checks(id, opts) {
    if (this.closed) return this._closedResponse();
    const canonicalId = parseLibraryId(id);
    if (!canonicalId) return fail('invalid_argument', null, { message: `id 形状非法(期望 ${LIBRARY_ID_PREFIX}<uuid>):${JSON.stringify(id)}` });
    const paging = resolvePaging(opts, this.limits);
    if (!paging.ok) return paging.response;
    const total = Number(this.st.countChecks.get(canonicalId).n);
    const rows = this.st.listChecks.all(canonicalId, paging.limit, paging.offset).map(checkRowToRecord);
    const hasMore = paging.offset + rows.length < total;
    const { kept, capped } = capByBytes(rows, this.limits.resultMaxBytes, (k, wasCapped) => ({
      ok: true,
      item_id: canonicalId,
      checks: k,
      count: k.length,
      offset: paging.offset,
      limit: paging.limit,
      total,
      nextOffset: (wasCapped || hasMore) && k.length > 0 ? paging.offset + k.length : null,
      truncated: wasCapped || hasMore,
    }));
    const out = { ...kept, byte_size: bytesOf(kept) };
    return alias(out, 'items', out.checks);
  }

  /** 关闭:幂等;关掉后的操作返回 `{ok:false, reason:'closed', message:'图书馆库已关闭', code:'closed'}`(不是抛错)。 */
  close() {
    if (this.closed) return { ok: true, closed: true, already: true };
    this.closed = true;
    try {
      this.db.close();
    } catch (e) {
      throw new Error(`图书馆库关闭失败:${e?.message ?? e}`);
    }
    return { ok: true, closed: true, already: false };
  }
}

/** 载荷里出现伪造认证字段(checked_state/checked_at)时的**点名**回执。 */
function forgeryGuard(item) {
  if (!isPlainObject(item)) return null;
  const forged = FORGED_STATE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(item, k));
  if (!forged.length) return null;
  return fail('readonly_field', null, {
    message: `条目载荷含只读认证字段:${forged.join(', ')}(checked_state/checked_at 只能由 recordCheck 写)`,
    readonly: forged,
  });
}

function mkdirFor(filePath) {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = idx > 0 ? filePath.slice(0, idx) : '.';
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new LibraryUnavailableError(`图书馆库目录建不出来(${dir}):${e?.message ?? e}`, e);
  }
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new LibraryUnavailableError(`图书馆库路径的父级不是目录:${dir}`);
  } catch (e) {
    if (e instanceof LibraryUnavailableError) throw e;
    throw new LibraryUnavailableError(`图书馆库目录不可用(${dir}):${e?.message ?? e}`, e);
  }
}

function jsonOrNull(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function resolvePaging(opts, limits) {
  const raw = opts === undefined || opts === null ? {} : opts;
  if (!isPlainObject(raw)) return refuse('invalid_type', '分页参数必须是对象:{offset?, limit?}');
  const unknown = Object.keys(raw).filter((k) => k !== 'offset' && k !== 'limit');
  if (unknown.length) return refuse('unknown_field', `分页参数未知字段:${unknown.join(', ')}`);
  const offset = raw.offset === undefined ? 0 : toInt(raw.offset);
  if (offset === undefined || offset < 0) return refuse('invalid_offset', 'offset 必须是 >= 0 的整数');
  const defaultLimit = Math.min(PAGE_DEFAULT_LIMIT, limits.searchMaxLimit);
  const limit = raw.limit === undefined ? defaultLimit : toInt(raw.limit);
  if (limit === undefined || limit < 1 || limit > PAGE_MAX_LIMIT) {
    return refuse('invalid_limit', `limit 必须是 1..${PAGE_MAX_LIMIT} 的整数(默认 ${defaultLimit})`);
  }
  return { ok: true, offset, limit };
}

function currentOf(items) {
  return items.find((it) => it.superseded_by === '' && !it.withdrawn_at) ?? items[items.length - 1] ?? null;
}

/**
 * 序列化结果超上限时从**尾部**丢条目(不静默截断 JSON),并如实回 truncated。
 * ⚠️ 截断标志由这里**当参数传进去**给 build —— 修前 build 回调直接读外层的 `capped`,
 * 而那个 `capped` 是 `const {kept, capped} = capByBytes(...)` 的**同名绑定**,回调执行时
 * 它还在 TDZ 里 ⇒ `Cannot access 'capped' before initialization`(第一次跑 history 就炸)。
 * 闭包与环境同名是这类"平时不报、一进分支就炸"的经典来源,故这里不靠闭包。
 */
function capByBytes(items, maxBytes, build) {
  let kept = items.slice();
  let capped = false;
  while (kept.length > 0 && bytesOf(build(kept, capped)) > maxBytes) {
    kept = kept.slice(0, -1);
    capped = true;
  }
  return { kept: build(kept, capped), capped };
}
