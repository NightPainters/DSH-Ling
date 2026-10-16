import { join } from 'node:path';
import { LibraryStore, normalizeLibraryLimits, DEFAULT_LIBRARY_LIMITS } from './library-store.js';
import { LibraryChecker, validateLibraryCheckerConfig, normalizeRoots } from './library-checker.js';
import { analyzeImport, commitImport } from './library-import.js';
import { readSqliteSource } from './library-sqlite.js';

const plain = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
// F10(1.7):`configError` 是**公共配置形状**的第 5 个键(`config.js` 的 libraryFields 已声明它),
//   所以这里也必须收 —— 否则合法配置(空串)会在运行时被判成"未知配置"而把图书馆整块拒掉。
//   它只是"上一次校验失败的原因"的载体:非空时构造函数**先**进不可用态(见下),不会走到开库。
const CONFIG_KEYS = new Set(['enabled', 'codeRoots', 'officialUrls', 'limits', 'configError']);

/** Public config deliberately has no resolver, requester, or source override. */
export function normalizeLibraryConfig(raw = {}) {
  if (!plain(raw)) throw new TypeError('library 配置必须是对象');
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) throw new RangeError(`library 未知配置: ${key}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new TypeError('library.enabled 必须是布尔值');
  }
  const limits = raw.limits === undefined ? {} : raw.limits;
  if (!plain(limits)) throw new TypeError('library.limits 必须是对象');
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(DEFAULT_LIBRARY_LIMITS, key)) throw new RangeError(`library.limits 未知配置: ${key}`);
  }
  const normalized = normalizeLibraryLimits(limits);
  const codeRoots = raw.codeRoots === undefined ? [] : raw.codeRoots;
  const officialUrls = raw.officialUrls === undefined ? [] : raw.officialUrls;
  validateLibraryCheckerConfig({ codeRoots, officialUrls }, normalized);
  return Object.freeze({
    enabled: raw.enabled ?? true,
    codeRoots: Object.freeze([...codeRoots]), officialUrls: Object.freeze([...officialUrls]),
    limits: Object.freeze(normalized),
  });
}

function unavailable(reason, message) {
  return { ok: false, reason, message };
}

/** Independent library ownership: no memory import, migration, or injection. */
export class LibraryRuntime {
  #config;
  #store = null;
  #checker = null;
  #codeRoots = [];
  #lockedPaths = [];
  #failure = null;
  #closed = false;
  #closing = null;

  constructor(dataDir, config = {}) {
    // F10(1.7 修复批次):配置校验失败**不再把整插件带走**。`config.js` 已把原因带进来
    //   (`configError`),这里直接进不可用态 —— 响亮(理由词 + 出错的键名)、有界(只废图书馆)。
    //   **不试图用半套配置开库**:半套配置会把"配置写错"变成运行期看不懂的怪象。
    //   ⚠️ 直接构造(内部/测试)时的**严格性没变**:下面这行照旧对非法配置抛错 ——
    //   严格在里、降级在外,两层不许互相污染。
    const configError = plain(config) ? String(config.configError ?? '') : '';
    if (configError) {
      this.#config = normalizeLibraryConfig({});   // 合法形状,供 enabled / limits 读面
      this.#failure = unavailable('library_config_invalid', `图书馆配置有误: ${configError.slice(0, 300)}`);
      return;
    }
    // Configuration errors deliberately escape; DB availability errors do not.
    this.#config = normalizeLibraryConfig(config);
    if (!this.#config.enabled) return;
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('library dataDir 必须是非空路径');
    try {
      this.#store = new LibraryStore(join(dataDir, 'library.db'), this.#config.limits);
      this.#checker = new LibraryChecker(this.#store, {
        codeRoots: this.#config.codeRoots, officialUrls: this.#config.officialUrls,
      });
      // SQLite 通道(路 A,D14)要用的两件事,与 checker **同一套根校验**(导出复用,不复制第二份):
      //  - 白名单根:插件配置里的 `codeRoots`;
      //  - **不许自噬**:本插件自己的库 —— 源路径解析成真实路径后再比(大小写无关)。
      this.#codeRoots = normalizeRoots(this.#config.codeRoots);
      this.#lockedPaths = [join(dataDir, 'library.db'), join(dataDir, 'memory.db')];
    } catch (error) {
      try { this.#store?.close(); } catch { /* preserve the opening error */ }
      this.#store = null;
      this.#failure = unavailable('library_unavailable', `图书馆资料库不可用: ${String(error?.message ?? error).slice(0, 500)}`);
    }
  }

  get limits() { return this.#config.limits; }

  #unavailable() {
    if (this.#closed) return unavailable('closed', '图书馆已关闭');
    if (!this.#config.enabled) return unavailable('library_disabled', '图书馆已在插件配置中关闭');
    if (this.#failure) return { ...this.#failure };
    return null;
  }

  status() {
    const failure = this.#unavailable();
    if (failure) return { ...failure, enabled: this.#config.enabled, available: false, limits: { ...this.limits } };
    try {
      return {
        ok: true, enabled: true, available: true,
        store: this.#store.stats(), checker: this.#checker.status(), limits: { ...this.limits },
      };
    } catch (error) {
      return {
        ...unavailable('library_unavailable', `图书馆状态不可读: ${String(error?.message ?? error).slice(0, 500)}`),
        enabled: true, available: false, limits: { ...this.limits },
      };
    }
  }

  #call(method, ...args) {
    const failure = this.#unavailable();
    if (failure) return failure;
    try { return this.#store[method](...args); }
    catch (error) { return unavailable('library_unavailable', `图书馆操作失败: ${String(error?.message ?? error).slice(0, 500)}`); }
  }

  search(query) {
    if (!plain(query) || Object.keys(query).some((key) => !['q', 'offset', 'limit'].includes(key))) {
      return unavailable('invalid_argument', '检索只接受 q、offset、limit');
    }
    return this.#call('search', query);
  }
  /** 浏览面 · **只读**:不搜也能翻(按 类目/来源 分组列条目,含留痕行)+ 分组计数表。
   *  参数白名单在这里先收一道 —— 与 `search` 同款:未知键不落到 store 层才报。 */
  browse(query) {
    if (!plain(query) || Object.keys(query).some((key) => !['category', 'source_kind', 'offset', 'limit', 'fields'].includes(key))) {
      return unavailable('invalid_argument', '浏览只接受 category、source_kind、offset、limit、fields');
    }
    return this.#call('browse', query);
  }
  get(id) { return this.#call('get', id); }
  history(id, options) { return this.#call('history', id, options); }
  checks(id, options) { return this.#call('checks', id, options); }
  create(item) { return this.#call('create', item); }
  revise(id, item, expectedHash) { return this.#call('revise', id, item, expectedHash); }
  withdraw(id, reason, expectedHash) { return this.#call('withdraw', id, reason, expectedHash); }

  /** 导入通道 · **分析段**(契约 §3)——
   *  `analyzeImport` 是纯函数式的"源 → 候选",**不写库**(§9.1),故这里**不经** `#call`
   *  (:89 那个门面只转发 store 方法)。限额由运行时**自己**注入:插件配置里改过的尺必须生效,
   *  调用方不许自带一把(`opts.limits` 被本方法覆盖)。模型段由调用方注入 ⇒ 可换桩。
   *  ⚠️ 抛错也**不写库**:回 `library_unavailable`(503),不冒充"零候选"。 */
  async analyzeImport(input, opts = {}) {
    const failure = this.#unavailable();
    if (failure) return failure;
    try {
      return await analyzeImport(input, {
        ...(plain(opts) ? opts : {}),
        limits: this.limits,
        // 取源**由运行时注入**(`analyzeImport` 是纯函数,不碰文件):只读打开、白名单根、拒自噬、表必须显式选。
        readSqlite: (req) => readSqliteSource({
          ...req, roots: this.#codeRoots, lockedPaths: this.#lockedPaths,
        }),
      });
    } catch (error) {
      return unavailable('library_unavailable', `图书馆导入分析失败: ${String(error?.message ?? error).slice(0, 500)}`);
    }
  }

  /** 导入通道 · **落库段**(契约 §3):只走既有 `store.create` 逐条入库(§9.2),
   *  回执逐条 + 总数自洽(committed/skipped/rejected)。库不在场 ⇒ 503,不静默少给。 */
  async commitImport(payload) {
    const failure = this.#unavailable();
    if (failure) return failure;
    try {
      return await commitImport(this.#store, payload);
    } catch (error) {
      return unavailable('library_unavailable', `图书馆导入落库失败: ${String(error?.message ?? error).slice(0, 500)}`);
    }
  }

  async check(id, options = {}) {
    const failure = this.#unavailable();
    if (failure) return { ...failure, recorded: false };
    try {
      const result = await this.#checker.check(id, options);
      return {
        ...result,
        adoption_reason: result.adopted === true ? 'adopted'
          : result.record?.reason ?? (result.recorded ? 'not_adopted' : 'not_recorded'),
      };
    } catch (error) {
      return { ...unavailable('library_unavailable', `图书馆核对失败: ${String(error?.message ?? error).slice(0, 500)}`), recorded: false };
    }
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try { await this.#checker?.close(); }
      finally { this.#store?.close(); }
      return { ok: true, closed: true };
    })();
    return this.#closing;
  }
}
