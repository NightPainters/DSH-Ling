/**
 * 1.7 图书馆 · **导入通道**(第一增量:CSV 表格 + 粘贴文本)
 *
 * 契约:[plans/1.7-library-import-contract.md]。本模块只做**两件事**:
 *   ① `analyzeImport` —— 源 → 候选(**纯函数式,绝不写库**;契约 §2.1)
 *   ② `commitImport`  —— 人审后的候选 → **既有 `store.create`**(不另开写入口;契约 §2.2)
 *
 * 为什么分析阶段必须纯:同一份表格会被反复重跑(改分类、改粒度、换模型),
 * 只要有一次"顺手写进去",人审就失去意义 —— 所以库里那一行的存在性**只能**由 commit 决定。
 *
 * ## 单位口径(别在别处再定一套)
 * - `locator`:CSV = **行号,1-based,表头算第 1 行**(契约 §4);text = 行段 `"起点-终点"`(含两端);
 *   JSON = 数组 `[i]`(**含方括号**,1-based)/ JSONL 裸行号 / 单对象 `$`(选项文档 §11.2 逐字钉死)。
 * - `evidence` 与 `body`:CSV = 该行的**原文行**(不是重新拼出来的 `cells.join(',')` ——
 *   带引号的行重新拼会变样,而 evidence 的唯一用途是"落回原文";契约 §5)。
 * - `import_key = sha256(sourceBytes).hex.slice(0,16) + ':' + locator`(契约 §6 逐字)。
 *
 * - `locator`:SQLite = `表名#键值`(主键值;无主键的表用 `rowid`;见选项文档 §11.3)。
 * - `import_key`:SQLite 的"源"是**文件身份**(`realpath|size|mtimeMs`,D15),不是内容文本。
 *
 * ## 三道闸的分工(不许合并)
 * - 第 1 道 **定位回查**(本模块 `verifyImportCandidate`):evidence 必须落回原文 locator 处,
 *   落不回 ⇒ `locator_verified:false` + `issues:['evidence_not_found']` + **默认不勾选**。
 *   这是拦"模型顺手编一个值"的**唯一机械手段**。
 * - 第 2 道 **字段闸**(本模块,产出 `issues`):只是**提前告知**(省得填完才被拒)。
 * - 第 3 道 **`create` 自己的校验**:最终判据。三条**不合并** —— create 那把尺不因为这里判过就松。
 *
 * ## 回执纪律(契约 §8)
 * 空输入/空表/只有表头 ⇒ 如实说"**没有候选**",**不是**"导入成功 0 条":
 * 所以分析回执里**没有** `committed` 这类入库词汇,只有 `candidates` / `stats`。
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_LIBRARY_LIMITS, LIBRARY_CATEGORIES, LIBRARY_SOURCE_KINDS,
  normalizeTextLf, utf8Bytes,
} from './library-store.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_HASH_HEX_RE = /^[0-9a-f]{16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCATOR_LINE_RE = /^[1-9]\d*$/;
const LOCATOR_RANGE_RE = /^([1-9]\d*)-([1-9]\d*)$/;
/** JSON 数组元素:`[i]`(**含方括号**,1-based)—— 选项文档 §11.2 钉死的**唯一**写法。 */
const LOCATOR_JSON_INDEX_RE = /^\[[1-9]\d*\]$/;
/** JSON 单对象:整份一条。 */
const LOCATOR_JSON_WHOLE = '$';
/** JSON 嵌套深度上限(防 JSON 炸弹;正常资料 / 规格的 JSON 远低于此)。 */
export const JSON_MAX_DEPTH = 32;
/**
 * **直通**的字段名:命中就直接当条目字段用。
 * ⚠️ 直通**不等于绕过校验** —— 值原样交给 `create` 去判(`checked_state` 照样 `readonly_field`)。
 */
const JSON_PASSTHROUGH_KEYS = Object.freeze([
  'title', 'body', 'category', 'source_kind', 'source_ref', 'as_of',
  // ⚠️ 这三键**必须在场**(2026-10-15 复核抓出来的漏):它们是 `create` 认可的条目字段
  // (`library-store.js` 的 `ITEM_INPUT_KEYS`),而且 `check_spec` 是**机器可核对**的那一处比较 ——
  // 漏掉的后果不是报错,而是把它**静默降级成正文里的 prose**(机器可核对 ⇒ 变成人肉可读),
  // 正好踩在本项目"核对只认证声明的那处比较"的要害上。
  'version', 'conditions', 'check_spec',
]);
/** 拼正文时的"其他字段"分隔行(让"正文里哪一段是原样、哪一段是拼的"一眼可辨)。 */
const JSON_EXTRA_HEADER = '— 其他字段 —';

export const IMPORT_KINDS = Object.freeze(['csv', 'text', 'json', 'sqlite']);
export const IMPORT_DEFAULT_CATEGORY = 'standard-value';
export const IMPORT_DEFAULT_SOURCE_KIND = 'manual';

/**
 * **导入层**字段:进 `create` 之前必须剥掉(它们不是条目字段)。
 * ⚠️ 只剥这一张表 —— 不许把"白名单拷贝"当净化:那样 `checked_state` 会被**静默剥掉**而条目照进,
 * 正好绕过 §2.3(防伪认证)。其余字段一律**原样**交给 create 去判,该报 unknown_field/readonly_field 就报。
 */
export const IMPORT_ONLY_KEYS = Object.freeze([
  'index', 'origin', 'issues', 'selected', 'locator_verified', 'locator', 'evidence',
]);

/** 会**阻止勾选**的 issues(全部都是阻断性的:一条不干净 ⇒ 默认不勾,要人工显式保留)。 */
const BLOCKING_ISSUES = Object.freeze([
  'locator_missing', 'locator_out_of_range', 'evidence_not_found',
  'empty_title', 'empty_body', 'too_large', 'bad_category', 'bad_source_kind',
  'missing_source', 'missing_as_of', 'bad_as_of',
]);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isoToday = () => new Date().toISOString().slice(0, 10);

// ── 幂等键 ────────────────────────────────────────────────────────────────────────────
/** 全文摘要(`sha256:<64hex>`)—— 幂等键的一半,也是"同一份源"的身份。 */
export function importSourceHash(text) {
  return 'sha256:' + createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * 契约 §6 逐字:`sha256(sourceBytes).hex.slice(0,16) + ':' + locator`。
 * 摘要前 16 位十六进制 = 64 bit —— 同一批导入里够用,它只需在**同一份源**内区分定位。
 * 形状不对**抛**:静默拼出一个短键会让两个不同的源撞进同一格(那正是幂等要防的事)。
 */
export function importKey(sourceHash, locator) {
  const hex = String(sourceHash ?? '').replace(/^sha256:/i, '').toLowerCase();
  if (!SOURCE_HASH_HEX_RE.test(hex.slice(0, 16)) || hex.length < 16) {
    throw new RangeError(`import_key 需要 sha256:<64hex> 形状的源摘要(实际 ${JSON.stringify(String(sourceHash))})`);
  }
  const loc = String(locator ?? '').trim();
  if (loc === '') throw new RangeError('import_key 需要非空 locator(空定位无法区分同源的多个条目)');
  return hex.slice(0, 16) + ':' + loc;
}

// ── 源解析 ────────────────────────────────────────────────────────────────────────────
/**
 * RFC 4180 子集:引号包裹、`""` 转义、字段内换行。零依赖(契约 §1 拍板 ②)。
 * 每个 row 记下自己的**起始行号**与**原文片段**(`raw`)—— 后者是 evidence 的落点:
 * 行内带引号或换行时,`cells.join(',')` 跟原文不一致,拿它当 evidence 就会假红。
 */
function parseCsvRows(text) {
  const src = normalizeTextLf(text);
  const rows = [];
  let cells = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let rowStartAt = 0;
  const closeRow = (endAt) => {
    cells.push(cell);
    rows.push({ cells, raw: src.slice(rowStartAt, endAt), startLine: rowStartLine });
    cells = [];
    cell = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (ch === '\n') line += 1;
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell === '') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { cells.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\n') {
      closeRow(i);
      i += 1;
      line += 1;
      rowStartLine = line;
      rowStartAt = i;
      continue;
    }
    cell += ch; i += 1;
  }
  // 收尾:末行没有换行符时补上;已经用 '\n' 收过尾就不补(否则会多出一条空行)
  if (cell !== '' || cells.length > 0) closeRow(src.length);
  return rows;
}

// ── JSON 类(选项文档 §11.2)──────────────────────────────────────────────────────────
/**
 * `JSON.parse` 报错 → `行:列`;**拿不到就返回空串**(调用方据此**不写坐标**)。
 *
 * ⚠️ **绝不在这里造假位置**:新版 V8 对最常见的语法错只回一句贴片段
 * (`Unexpected token '}', "…" is not valid JSON`)—— **消息里根本没有 position**。
 * 老写法用 `at = 0` 回落 ⇒ 每条都印成 `(1:1)`,等于在回执里写一个自己不知道的坐标
 * (2026-10-15 异源复核抓出来的,探针里 `{"a":}` 与多行坏 JSON 双双印 `(1:1)`)。
 * 认得的两种措辞:① `at position N (line X column Y)`;② `(line X column Y)`。
 */
function jsonPos(text, err) {
  const msg = String((err && err.message) || err || '');
  const direct = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (direct) return `${Number(direct[1])}:${Number(direct[2])}`;
  const m = /position (\d+)/.exec(msg);
  if (!m) return '';
  const at = Number(m[1]);
  if (!Number.isFinite(at) || at < 0 || at > text.length) return '';
  const head = text.slice(0, at);
  return `${head.split('\n').length}:${at - (head.lastIndexOf('\n') + 1) + 1}`;
}

/**
 * **顶层元素边界扫描器**:按嵌套深度与字符串状态切出每个顶层元素的**原文区间**。
 *
 * 为什么不 `JSON.stringify(parsed)` 当原文:键序与空白会变样、数字样键还会被重排
 * ⇒ evidence 回查(`span.includes(ev)`,本文件 `verifyWithIndex`)会**必然假红**。
 * 这里只认字符、不做任何规范化;`raw` 是 `[start, end)` 的原样切片(两端的空白留给调用方 trim)。
 *
 * 迭代实现(不递归)—— 深度炸弹在这里也不会炸栈。
 */
function scanTopLevelElements(text) {
  const open = text.indexOf('[');
  if (open < 0) return { elements: [] };
  const s = text;
  const elements = [];
  let i = open + 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (start < 0) start = i; inStr = true; continue; }
    if (ch === '{' || ch === '[') { if (start < 0) start = i; depth += 1; continue; }
    if (ch === '}' || ch === ']') {
      if (ch === ']' && depth === 0) {          // 顶层数组收尾
        // `start` 只在非空白字符处被设置(下面三处分支),所以 `start >= 0` 就等于"有内容"
        // —— 原先那句 `s.slice(start, i).trim() !== ''` 是恒真的死代码(2026-10-15 复核指出)。
        if (start >= 0) elements.push({ index: elements.length + 1, raw: s.slice(start, i) });
        break;
      }
      depth -= 1;
      continue;
    }
    if (ch === ',') {
      if (depth === 0) {
        if (start >= 0) elements.push({ index: elements.length + 1, raw: s.slice(start, i) });
        start = -1;
      }
      continue;
    }
    if (depth === 0 && start < 0 && ch.trim() !== '') start = i;   // 标量元素(字符串/数字/布尔/null)
  }
  return { elements };
}

/** 嵌套深度是否**超过** `cap`(到顶就不再往下走 —— 防炸弹,不递归爆栈)。 */
function jsonTooDeep(value, cap) {
  let deep = false;
  const walk = (node, d) => {
    if (deep || !node || typeof node !== 'object') return;
    if (d > cap) { deep = true; return; }
    for (const k of Object.keys(node)) walk(node[k], d + 1);
  };
  walk(value, 0);
  return deep;
}

/** 非标量 ⇒ 紧凑 JSON(用于正文);标量 ⇒ 原样。**不许**静默丢键。 */
function jsonLiteral(v) {
  if (v !== null && typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * JSON 源 → **形态 + 内容单元**(纯函数,不碰库/文件/网络)。
 *
 * 三种形态自动判(选项文档 §11.2):数组 ⇒ 一元素一条 · 单对象 ⇒ 整份一条 · JSONL ⇒ 一行一条。
 * 判不出来就**如实报**(带 `行:列`),绝不静默当成别的 `kind` 或"0 个候选"。
 */
function parseJsonSource(text) {
  const src = normalizeTextLf(String(text ?? ''));
  const trimmed = src.trim();
  if (trimmed === '') return { ok: false, reason: 'empty_source', message: '源是空的(没有任何字符)' };
  const first = trimmed[0];
  if (!/[{\["\-0-9tfn]/.test(first)) {
    return {
      ok: false, reason: 'kind_mismatch',
      message: `自称 json,但开头是 ${JSON.stringify(first)}`
        + (first === '<' ? ' —— 像是 HTML/XML,不是 JSON' : ' —— 认不出是 JSON 的开头'),
    };
  }
  // ① 整份解析得通 ⇒ 数组 / 单对象
  let whole = null;
  let wholeErr = null;
  try { whole = JSON.parse(trimmed); } catch (e) { wholeErr = e; }
  if (wholeErr === null) {
    if (jsonTooDeep(whole, JSON_MAX_DEPTH)) {
      return { ok: false, reason: 'json_too_deep', message: `JSON 嵌套超过 ${JSON_MAX_DEPTH} 层(拒绝解析,防 JSON 炸弹)` };
    }
    if (Array.isArray(whole)) {
      const { elements } = scanTopLevelElements(trimmed);
      if (elements.length !== whole.length) {
        return {
          ok: false, reason: 'json_scan_mismatch',
          message: `顶层元素边界扫描得 ${elements.length} 个,而解析结果有 ${whole.length} 个`
            + '(这是本机扫描器的自检 —— 请把这份源报给我,别照进)',
        };
      }
      return {
        ok: true, form: 'array',
        units: elements.map((el) => ({ locator: `[${el.index}]`, ordinal: el.index, raw: el.raw, value: whole[el.index - 1] })),
      };
    }
    if (isPlainObject(whole)) {
      return { ok: true, form: 'object', units: [{ locator: LOCATOR_JSON_WHOLE, ordinal: 0, raw: trimmed, value: whole }] };
    }
    return {
      ok: false, reason: 'json_not_object',
      message: `顶层是 ${whole === null ? 'null' : typeof whole} —— JSON 导入只认**对象**或**对象数组**(契约 §2.2:每条候选都得是一个条目)`,
    };
  }
  // ② JSONL:逐行一个**对象**(每行都合法才算)。
  //   ⚠️ 两处口径(2026-10-15 复核后定):
  //   ① 逐行 parse 前要 `trim()` —— 整份路径早在 `trimmed` 里剥掉了 BOM,逐行路径若不 trim,
  //      首行带 `\uFEFF` 的 JSONL 会被硬拒,而同样带 BOM 的数组/单对象却照过(**同一条通道两种行为**);
  //   ② **只收对象**:数组/标量行 ⇒ 当坏行。要导"一串标量"用数组形态(那里每个元素都能承载)。
  //      口径统一在"一行一个对象"这一句上,不做两种写法(spec §11.2 同话)。
  const rawLines = src.split('\n');
  const lines = [];
  let badLine = 0;
  let badErr = null;
  for (let i = 0; i < rawLines.length; i += 1) {
    if (rawLines[i].trim() === '') continue;
    let v = null;
    try { v = JSON.parse(rawLines[i].trim()); } catch (e) { badLine = i + 1; badErr = e; break; }
    if (!isPlainObject(v)) { badLine = i + 1; badErr = new SyntaxError(`这一行不是对象(是 ${Array.isArray(v) ? 'array' : typeof v})`); break; }
    if (jsonTooDeep(v, JSON_MAX_DEPTH)) {
      return { ok: false, reason: 'json_too_deep', message: `第 ${i + 1} 行的 JSON 嵌套超过 ${JSON_MAX_DEPTH} 层(拒绝解析)` };
    }
    lines.push({ line: i + 1, raw: rawLines[i], value: v });
  }
  if (badLine === 0 && lines.length > 0) {
    return {
      ok: true, form: 'jsonl',
      units: lines.map((l) => ({ locator: String(l.line), ordinal: l.line, raw: l.raw, value: l.value })),
    };
  }
  // ③ 都不是 ⇒ 报整份的错(拿得到坐标才写坐标,拿不到就不写),并把 JSONL 那一遍的错也如实带上
  const where = jsonPos(trimmed, wholeErr);
  const eof = /end of (JSON|input)|Unexpected end|Unterminated/i.test(String((wholeErr && wholeErr.message) || ''));
  return {
    ok: false, reason: 'invalid_json',
    message: `JSON 解析失败${where === '' ? '' : `(${where})`}:${String((wholeErr && wholeErr.message) || wholeErr)}`
      + (badLine > 0 ? `;按 JSONL 逐行看,第 ${badLine} 行也不合法(${String((badErr && badErr.message) || badErr)})` : '')
      + (eof ? '(像是没写完 —— 整份被截断了?)' : ''),
  };
}

/** 把源建成一次性的索引(行表 + 行号 → 原文)。CSV 的"行"以**起始行号**为准。 */
function buildSourceIndex(payload) {
  const text = normalizeTextLf(payload.text ?? '');
  const lines = text.split('\n');
  // 末尾换行会产生一个空尾元素 —— 它是"行的分隔符"而不是"第 N 行",不参与定位
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const index = { kind: payload.kind, name: payload.name, text, lines, csvRows: null, csvByLine: null, json: null, jsonByLocator: null };
  if (payload.kind === 'csv') {
    index.csvRows = parseCsvRows(text);
    index.csvByLine = new Map();
    for (const r of index.csvRows) if (!index.csvByLine.has(r.startLine)) index.csvByLine.set(r.startLine, r);
  }
  if (payload.kind === 'json') {
    index.json = parseJsonSource(text);
    if (index.json.ok === true) {
      index.jsonByLocator = new Map();
      for (const u of index.json.units) index.jsonByLocator.set(u.locator, u.raw);
    }
  }
  return index;
}

/** locator → 原文片段(找不到 ⇒ null)。CSV:该行(含跨行的引号字段);text:闭区间行段;JSON:见 §11.2。 */
function resolveLocator(index, locator) {
  const loc = String(locator ?? '').trim();
  if (index.kind === 'json') {
    if (!index.json || index.json.ok !== true || !index.jsonByLocator) return null;
    if (loc === LOCATOR_JSON_WHOLE) return index.json.form === 'object' ? index.json.units[0].raw : null;
    if (LOCATOR_JSON_INDEX_RE.test(loc)) return index.jsonByLocator.get(loc) ?? null;
    // JSONL 的裸行号(与文本段落同形,但只有 JSONL 这场才认它)
    if (LOCATOR_LINE_RE.test(loc) && index.json.form === 'jsonl') return index.jsonByLocator.get(loc) ?? null;
    return null;
  }
  if (index.kind === 'sqlite') {
    // SQLite 的 locator 形状是 `表名#键值`,**不是**行号 —— 只有这一条分支认它(选项文档 §11.3)。
    if (!index.sqliteByLocator) return null;
    return index.sqliteByLocator.get(loc) ?? null;
  }
  if (LOCATOR_LINE_RE.test(loc)) {
    const n = Number(loc);
    if (index.csvByLine && index.csvByLine.has(n)) return index.csvByLine.get(n).raw;
    return n >= 1 && n <= index.lines.length ? index.lines[n - 1] : null;
  }
  const m = LOCATOR_RANGE_RE.exec(loc);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > b || b > index.lines.length) return null;
    return index.lines.slice(a - 1, b).join('\n');
  }
  return null;
}

// ── 第 1 + 第 2 道闸 ──────────────────────────────────────────────────────────────────
/**
 * 定位回查 + 字段闸(**纯函数**)。回执 = 原候选 + `locator_verified` / `issues` / `selected`。
 * `selected` 的语义是"**默认**要不要勾":定位通过**且**没有阻断性 issues ⇒ 勾。
 * 它是一个可被人工覆盖的**默认值**,不是判据 —— 人工可以显式保留一条 `evidence_not_found` 的候选。
 */
export function verifyImportCandidate(candidate, source) {
  // 公开入口只有 payload(没有索引)⇒ 现建一个;`analyzeImport` 走 verifyWithIndex 复用同一个索引。
  const index = buildSourceIndex(isPlainObject(source) ? source : {});
  return verifyWithIndex(candidate, index, source);
}

function verifyWithIndex(candidate, index, source) {
  const limits = (isPlainObject(source) && source.limits) || DEFAULT_LIBRARY_LIMITS;
  const cand = isPlainObject(candidate) ? { ...candidate } : {};
  const issues = [];

  // 第 1 道闸:evidence 必须落回原文
  const locator = cand.locator === undefined || cand.locator === null ? '' : String(cand.locator).trim();
  let locatorOk = false;
  let evidenceOk = false;
  if (locator === '') {
    issues.push('locator_missing');
  } else {
    const span = resolveLocator(index, locator);
    if (span === null) {
      issues.push('locator_out_of_range');
    } else {
      locatorOk = true;
      const ev = typeof cand.evidence === 'string' ? normalizeTextLf(cand.evidence) : '';
      // ⚠️ **两侧都按 LF 归一**:`ev` 上面已归一,`span` 若不归一 ⇒ 源值里含 `\r\n` 时**必假红**
      //    (SQLite 的 TEXT 单元格里放 CRLF 文本太正常了 —— 那不是"证据找不到",是我们自己口径没对齐)。
      evidenceOk = ev.trim() !== '' && normalizeTextLf(String(span)).includes(ev);
      if (!evidenceOk) issues.push('evidence_not_found');
    }
  }

  // 第 2 道闸:字段面(提前告知)
  if (typeof cand.title !== 'string' || cand.title.trim() === '') issues.push('empty_title');
  if (typeof cand.body !== 'string' || cand.body === '') issues.push('empty_body');
  else if (utf8Bytes(cand.body) > Number(limits.importCandidateMaxBytes ?? limits.itemMaxBytes)) issues.push('too_large');
  if (typeof cand.category !== 'string' || !LIBRARY_CATEGORIES.includes(String(cand.category).trim())) issues.push('bad_category');
  if (typeof cand.source_kind !== 'string' || !LIBRARY_SOURCE_KINDS.includes(String(cand.source_kind).trim())) issues.push('bad_source_kind');
  if (typeof cand.source_ref !== 'string' || cand.source_ref.trim() === '') issues.push('missing_source');
  if (typeof cand.as_of !== 'string' || cand.as_of.trim() === '') issues.push('missing_as_of');
  else if (!DATE_RE.test(cand.as_of.trim()) && !/^\d{4}-\d{2}-\d{2}T/.test(cand.as_of.trim())) issues.push('bad_as_of');

  const locator_verified = locatorOk && evidenceOk;
  const selected = locator_verified && !issues.some((i) => BLOCKING_ISSUES.includes(i));
  return { ...cand, locator_verified, issues, selected };
}

// ── JSON 单元 → 候选(字段映射:选项文档 §11.2)──────────────────────────────────────────
/**
 * 一个 JSON 内容单元 → 一条候选。
 * - 键命中图书馆字段名 ⇒ **直通**(值原样用,校验仍归字段闸与 `create`,这里不放行);
 * - 其余键 ⇒ 拼进正文(每行 `键: 值`,非标量用紧凑 JSON)—— **一个键都不许静默丢**;
 * - 对象本来就有 `body` 时,其余键仍拼在正文后面(用分隔行切开),同样不丢。
 */
function jsonUnitCandidate(name, defaults, form, unit) {
  const span = String(unit.raw ?? '').trim();
  const base = {
    category: defaults.category,
    source_kind: defaults.source_kind,
    source_ref: `${name}#${unit.locator}`,
    as_of: defaults.as_of,
    locator: unit.locator,
    evidence: span,
    origin: 'rule',
  };
  const title = form === 'object' ? name
    : form === 'jsonl' ? `${name} 第 ${unit.ordinal} 行`
      : `${name} 第 ${unit.ordinal} 条`;
  const obj = isPlainObject(unit.value) ? unit.value : null;
  if (obj === null) {
    // 标量元素(字符串/数字/布尔):正文取紧凑字面量;`null` 是**没有内容** ⇒ 空正文(字段闸会打 empty_body)
    return { ...base, title, body: unit.value === null ? '' : jsonLiteral(unit.value) };
  }
  return objectCandidate(base, title, obj);
}

/**
 * 对象 → 候选的**字段映射(只有这一份实现;JSON 与 SQLite 共用)**:
 * - 键命中图书馆字段名 ⇒ **直通**(值原样用,校验仍归字段闸与 `create`,这里不放行);
 * - 其余键 ⇒ 拼进正文(每行 `键: 值`,非标量用紧凑 JSON)—— **一个键都不许静默丢**;
 * - 对象本来就有 `body` 时,其余键仍拼在正文后面(用分隔行切开),同样不丢。
 */
function objectCandidate(base, fallbackTitle, obj) {
  const out = { ...base };
  const extras = [];
  for (const [k, v] of Object.entries(obj)) {
    // `title` / `body` 单独处理:**键缺省才补默认,键在场就原样保留** ——
    // 把 `title: 123` 补齐成默认标题等于把源里的毛病藏起来,字段闸该报就让它报。
    if (k === 'title') { out.title = v; continue; }
    if (k === 'body') {
      // 字符串就直接当正文;形状不对(数字/对象)时保留成正文里的一行 —— 既不假装能拼,也不静默丢
      if (typeof v === 'string') out.body = v;
      else extras.push(`body: ${jsonLiteral(v)}`);
      continue;
    }
    if (JSON_PASSTHROUGH_KEYS.includes(k)) { out[k] = v; continue; }
    extras.push(`${k}: ${jsonLiteral(v)}`);
  }
  const extraText = extras.join('\n');
  if (typeof out.body === 'string') {
    if (extraText !== '') out.body = `${out.body}\n\n${JSON_EXTRA_HEADER}\n${extraText}`;
  } else {
    out.body = extraText;
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'title')) out.title = fallbackTitle;
  return out;
}

// ── 分析 ──────────────────────────────────────────────────────────────────────────────
/**
 * 一个 SQLite 行 → 一条候选(选项文档 §11.3)。
 * 列名命中图书馆字段名就直通 —— 映射**与 JSON 共用 `objectCandidate`**(只有一份实现)。
 * `evidence` 用取源层预存的整行文本(`列=值` 拼成),逐字回查照旧成立。
 */
function sqliteUnitCandidate(name, defaults, table, unit) {
  const span = String(unit.raw ?? '').trim();
  const title = `${name} · ${table} 第 ${unit.ordinal} 行`;
  const base = {
    body: span,
    category: defaults.category,
    source_kind: defaults.source_kind,
    source_ref: `${name}#${unit.locator}`,
    as_of: defaults.as_of,
    locator: unit.locator,
    evidence: span,
    origin: 'rule',
  };
  const obj0 = isPlainObject(unit.value) ? unit.value : null;
  // SQL 的 `NULL` = **没有值** —— 与 JSON 的 `title: 123`(值在那儿、形状不对)不是一回事:
  // 图书馆字段列为 NULL ⇒ 当**键缺省**,回退到通道默认(`title` 用可追溯的默认标题)。
  // 否则一条 `title=NULL` 会变成 `title:null` ⇒ 整条被字段闸拦下(empty_title),而源里根本没毛病。
  // 其余列的 NULL **如实写 NULL** 进正文 —— 一个都不许静默丢。
  const obj = obj0 === null ? null : Object.fromEntries(
    Object.entries(obj0).filter(([k, v]) => !(v === null && JSON_PASSTHROUGH_KEYS.includes(k))),
  );
  return obj === null ? { ...base, title } : objectCandidate(base, title, obj);
}

/**
 * 源 → 候选。**纯函数式**:不碰库、不碰文件、不碰 network。
 *
 * `opts`:
 * - `today`    —— `as_of` 的默认值(面板给"今天"但可改;**绝不由创建时间推断**,契约 §4)
 * - `category` / `source_kind` —— 规则段默认值
 * - `model`    —— **可选**的模型段:`async (ctx) => 原始候选[]`(只交 locator/evidence/title/body…;
 *                `index` 与 `origin` 由本函数补)。它是**候选来源之一**,不是判据。
 * - `limits`   —— 限额(默认 `DEFAULT_LIBRARY_LIMITS`)
 * - `modelLabel` —— 回执里如实写出的模型名(契约 §3:不许把"两次结果不一样"藏起来)
 *
 * ⚠️ 模型段抛错 ⇒ 回 `{ok:false, reason:'model_failed'}` —— **不冒充成功**。
 * 退回"只用规则段、ok:true"看着更友好,但那等于把"模型没跑成"藏进一个成功的回执里。
 */
export async function analyzeImport(input, opts = {}) {
  const limits = opts.limits || DEFAULT_LIBRARY_LIMITS;
  if (!isPlainObject(input)) return { ok: false, reason: 'invalid_input', message: 'analyze 入参必须是普通对象' };
  const kind = String(input.kind ?? '').trim();
  if (!IMPORT_KINDS.includes(kind)) {
    return { ok: false, reason: 'invalid_kind', message: `kind 只能是 ${IMPORT_KINDS.join(' | ')}` };
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') return { ok: false, reason: 'invalid_name', message: 'name 必填非空(它是 source_ref 的前半截)' };
  // SQLite 通道(选项文档 §11.3):源是**盘上的文件**,不是 text ⇒ 两条入口不许同时在场
  // (D15:`text` 与 `path` 同给时,"这份源的摘要按谁算"没有答案 —— 参数错就当场说,不猜)。
  const isSqlite = kind === 'sqlite';
  const text = typeof input.text === 'string' ? input.text : (input.text == null ? '' : String(input.text));
  if (isSqlite && text.trim() !== '') {
    return { ok: false, reason: 'invalid_argument', message: 'kind=sqlite 只走 path:text 与 path 不许同时给(源摘要按谁算没有答案)' };
  }
  const bytes = utf8Bytes(text);
  if (bytes > Number(limits.importTextMaxBytes)) {
    return {
      ok: false, reason: 'text_too_large',
      message: `文本 ${bytes} 字节,超过 importTextMaxBytes=${limits.importTextMaxBytes}(不做静默截断)`,
    };
  }

  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  // `payload` 还要给 `vopts`(字段闸/回查那道)用:SQLite 的 `text` 恒为空串,
  // 规则段与模型段吃的是**取源层给的单元**(`index.sqlite.units`)。
  const payload = { kind, name, text };
  let index;
  if (isSqlite) {
    // 取源**只能由运行时注入**(`analyzeImport` 是纯函数:不碰文件 —— 本文件头注与契约 §2.1)。
    const reader = typeof opts.readSqlite === 'function' ? opts.readSqlite : null;
    if (!reader) {
      return { ok: false, reason: 'sqlite_unavailable', message: 'SQLite 通道缺少取源实现(运行时没注入 readSqlite:接线问题,不是源的问题)' };
    }
    const read = await reader({
      path: input.path, table: input.table, offset, limit: limits.importBatchMaxItems, limits,
    });
    if (!isPlainObject(read) || read.ok !== true) {
      return {
        ok: false,
        reason: String((read && read.reason) || 'sqlite_read_failed'),
        message: String((read && read.message) || '读源库失败,而且没给出原因'),
      };
    }
    index = {
      kind: 'sqlite', name, text: '', lines: [], csvRows: null, csvByLine: null,
      json: null, jsonByLocator: null, sqlite: read, sqliteByLocator: new Map(),
    };
    for (const u of read.units) index.sqliteByLocator.set(u.locator, u.raw);
  } else {
    index = buildSourceIndex(payload);
    // JSON 这条通道的源**可能解析不了** —— 当场如实报(带 `行:列`),绝不静默当成"0 个候选"(契约 §8)。
    if (kind === 'json' && index.json && index.json.ok !== true) {
      return { ok: false, reason: index.json.reason, message: index.json.message };
    }
  }
  // 源摘要(**按 kind 分支**,D15):普通通道 = 内容文本;SQLite = **文件身份串**
  // (`realpath|size|mtimeMs`)—— 它不随"抽了哪一页"变,否则同一份源翻一页就换一个 import_key。
  const source_hash = isSqlite ? importSourceHash(index.sqlite.source_identity) : importSourceHash(text);
  const today = typeof opts.today === 'string' && opts.today.trim() !== '' ? opts.today.trim() : isoToday();
  const defaults = {
    category: typeof opts.category === 'string' && LIBRARY_CATEGORIES.includes(opts.category) ? opts.category : IMPORT_DEFAULT_CATEGORY,
    source_kind: typeof opts.source_kind === 'string' && LIBRARY_SOURCE_KINDS.includes(opts.source_kind) ? opts.source_kind : IMPORT_DEFAULT_SOURCE_KIND,
    as_of: today,
  };
  const vopts = { ...payload, limits };

  // ── 规则段(确定性;与 D1/schema 无关)────────────────────────────────────────────
  let dataRows = 0;
  const units = [];
  if (kind === 'csv') {
    const parsed = index.csvRows;
    const data = parsed.slice(1); // 表头 = 第 1 行(契约 §4)
    dataRows = data.length;
    for (const row of data) {
      const span = row.raw.trim();
      if (span === '' && row.cells.every((c) => c.trim() === '')) continue; // 纯空行不是条目
      units.push({ m: row.raw, c: {
        title: `${name} 第 ${row.startLine} 行`,
        body: span,
        category: defaults.category,
        source_kind: defaults.source_kind,
        source_ref: `${name}#${row.startLine}`,
        as_of: defaults.as_of,
        locator: String(row.startLine),
        evidence: span,
        origin: 'rule',
      } });
    }
  } else if (kind === 'json') {
    // JSON:内容单元 = 数组元素 / JSONL 一行 / 单对象(整份);locator 见 §11.2 的三种形态。
    const j = index.json;
    dataRows = j.units.length;
    for (const u of j.units) {
      units.push({ m: u.raw, c: jsonUnitCandidate(name, defaults, j.form, u) });
    }
  } else if (kind === 'sqlite') {
    // SQLite:内容单元 = 表里**一行一单元**;窗口已在取源那一层用 SQL 的 LIMIT/OFFSET 切好。
    const s = index.sqlite;
    dataRows = s.units.length;
    for (const u of s.units) units.push({ m: u.raw, c: sqliteUnitCandidate(name, defaults, s.table, u) });
  } else if (kind === 'text') {
    // 文本:空行分段;locator = 行段 `起点-终点`(含两端,1-based)
    const lines = index.lines;
    let start = null;
    let buf = [];
    const flush = (endLine) => {
      if (start === null) return;
      const body = buf.join('\n');
      units.push({ m: body, c: {
        title: `${name} 第 ${start}-${endLine} 行`,
        body,
        category: defaults.category,
        source_kind: defaults.source_kind,
        source_ref: `${name}#${start}-${endLine}`,
        as_of: defaults.as_of,
        locator: `${start}-${endLine}`,
        evidence: body,
        origin: 'rule',
      } });
      start = null;
      buf = [];
    };
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === '') { flush(i); continue; }
      if (start === null) start = i + 1;
      buf.push(lines[i]);
    }
    flush(lines.length);
    dataRows = units.length;
  } else {
    // 兜底 = **拒**,不是"落文本":将来给 `IMPORT_KINDS` 加了值却忘了加分支时,这里会**立刻炸出来**,
    // 而不是把新形态的源静默按空行切成 raw 文本(选项文档 §11.6 A.1 的必改项)。
    return {
      ok: false, reason: 'invalid_kind',
      message: `kind=${JSON.stringify(kind)} 还没有实现分支(别把它当文本处理)`,
    };
  }

  // ── 分页(2026-10-13,D12)───────────────────────────────────────────────────────────
  // `units` = 这份源的**内容单元**序列(CSV 一行 / 文本一段)。分页的尺**只有这一把**:
  // `offset` 切的就是这个序列,规则段与模型段吃**同一个窗口** —— 两段各切各的,会让"翻到第 2 页"
  // 变成"规则段给了第 2 页、模型段给了第 3 页"这种没人能对上的账。
  // 一页的单元数复用 `importBatchMaxItems`(默认 200)——**不是新开一把尺**:契约里"一批"与
  // "一页"本来就是同一个数(它管的是"一次交给人的量")。
  const pageMaxRaw = Number(limits.importBatchMaxItems ?? 0);
  const pageMax = Number.isFinite(pageMaxRaw) && pageMaxRaw > 0 ? pageMaxRaw : units.length;
  let unitsTotal;
  let win;
  let nextOffset;
  if (isSqlite) {
    // SQLite 的窗口**在取源那一层就切好了**(SQL 的 LIMIT/OFFSET)—— 这里再切一次等于切两刀。
    // `units_total` 如实给 **null**:大表**不跑 `COUNT(*)`**(安全硬约束④)⇒ 总数这件事我不知道,
    // 就不许编一个数出来(契约 §8)。客户端见 null 走"还有更多"而不是页码。
    win = units;
    unitsTotal = null;
    nextOffset = index.sqlite.has_more === true ? offset + win.length : null;
  } else {
    unitsTotal = units.length;
    win = units.slice(offset, offset + pageMax);
    nextOffset = offset + win.length < unitsTotal ? offset + win.length : null;
  }
  const raw = win.map((u) => u.c);

  const candidates = raw.map((c) => verifyWithIndex(c, index, vopts));

  // ── 模型段(可选)────────────────────────────────────────────────────────────────
  const model = typeof opts.model === 'function' ? opts.model : null;
  let model_used = false;
  let model_rows = 0;
  let model_rows_capped = false;
  // 降级回执(D11,2026-10-14 放行):模型段没跑成时的**显式标注**;全跑成时为 null。
  let model_error = null;
  // 分批数:由模型段自己记在 `ctx.model_stats` 上(引擎知道切了几批),这里只负责照实报。
  // **只在 >1 批时才出这个字段** —— 单批与分批前的老回执逐字一致。
  let model_batches = 0;
  if (model) {
    const cap = Number(limits.importModelMaxItems ?? 0);
    // 成本闸:只把**前 cap 条**交给模型;超出的部分仍走规则段,并在回执里说明(契约 §11.1)
    // 送模型的行**只取本页窗口**(与规则段同一个窗口);`m` 是单元里预存的原文,不再按 kind 重算。
    const textRows = win.map((u) => ({ locator: u.c.locator, text: u.m }));
    const offered = cap > 0 ? textRows.slice(0, cap) : [];
    model_rows = offered.length;
    model_rows_capped = offered.length < textRows.length;
    const ctx = {
      kind, name, source_hash, today,
      rows: offered, rules: raw, limits,
      max_items: cap, model: opts.modelLabel ?? null,
    };
    let produced = null;
    let thrown = '';
    try {
      produced = await model(ctx);
    } catch (e) {
      thrown = `模型段抛错:${e?.message ?? e}`;
    }
    if (thrown === '' && !Array.isArray(produced)) thrown = '模型段必须回候选数组';
    if (thrown !== '') produced = null;
    const ms = isPlainObject(ctx.model_stats) ? ctx.model_stats : null;
    if (ms && Number(ms.batches) > 0) model_batches = Number(ms.batches);
    const batchFail = ms && Array.isArray(ms.failed) && ms.failed.length ? ms.failed : null;
    // ── 降级回执(D11 放行,2026-10-14)──────────────────────────────────────────────
    // 模型段没跑成**不再让整发失败**:规则段候选照常给,但**必须显式标注**(`model_error`),
    // 且回执里不许出现任何声称模型成功的字段(`model_used:false`、`model:null`)。
    if (thrown !== '' || batchFail) {
      model_error = {
        engine: opts.modelLabel ?? null,
        message: thrown !== '' ? thrown : String(ms.error || '模型段有一批没跑成'),
        rows_offered: model_rows,
        ...(batchFail
          ? {
            batches_total: Number(ms.batches),
            batches_ok: Number(ms.ok) || 0,
            batches_failed: batchFail.map((x) => x.index),
          }
          : {}),
      };
    }
    // `model_used` 的语义 = **有模型产出进入这份回执**。全成功时即使是空产出也算跑过
    // (那是"模型看了、没东西可提",与"没跑成"是两件事);一旦降级,就只有**真拿到候选**才算 true。
    model_used = Array.isArray(produced) && (produced.length > 0 || model_error === null);
    for (const item of (Array.isArray(produced) ? produced : [])) {
      if (!isPlainObject(item)) continue;
      const loc = item.locator === undefined || item.locator === null ? '' : String(item.locator).trim();
      const filled = {
        title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : `${name}#${loc || '?'}`,
        body: typeof item.body === 'string' ? item.body : '',
        category: typeof item.category === 'string' && item.category.trim() !== '' ? item.category.trim() : defaults.category,
        source_kind: typeof item.source_kind === 'string' && item.source_kind.trim() !== '' ? item.source_kind.trim() : defaults.source_kind,
        source_ref: typeof item.source_ref === 'string' && item.source_ref.trim() !== '' ? item.source_ref.trim() : `${name}#${loc}`,
        as_of: typeof item.as_of === 'string' && item.as_of.trim() !== '' ? item.as_of.trim() : defaults.as_of,
        locator: loc,
        evidence: typeof item.evidence === 'string' ? item.evidence : '',
        origin: 'model',
        ...(item.version !== undefined ? { version: item.version } : {}),
        ...(item.conditions !== undefined ? { conditions: item.conditions } : {}),
        ...(item.check_spec !== undefined ? { check_spec: item.check_spec } : {}),
      };
      candidates.push(verifyWithIndex(filled, index, vopts));
    }
  }

  // ── 批次上限:超出部分**不静默丢**(回执里给出条数)────────────────────────────────
  const batchMax = Number(limits.importBatchMaxItems ?? candidates.length);
  const kept = candidates.slice(0, batchMax);
  const dropped = candidates.length - kept.length;
  kept.forEach((c, i) => { c.index = i + 1; });

  return {
    ok: true,
    source_hash,
    candidates: kept,
    stats: {
      rows: dataRows,
      candidates: kept.length,
      rejected: kept.filter((c) => c.selected !== true).length,
      model_used,
      model: model_used ? (opts.modelLabel ?? 'custom') : null,
      ...(model_used ? { model_rows, model_rows_capped } : {}),
      ...(model_used && model_batches > 1 ? { model_batches } : {}),
      ...(model_error ? { model_error } : {}),
      ...(dropped > 0 ? { dropped_by_batch_limit: dropped } : {}),
      // JSON 这条通道**把认出来的形态写进回执**(选项文档 §11.2:"判错不静默")—— 数组 / 单对象 / JSONL。
      ...(kind === 'json' && index.json && index.json.ok === true ? { json_form: index.json.form } : {}),
      // SQLite 把"源的身份 / 认的是哪张表 / 还有没有下一页"如实写进回执(§11.3;D15 的源摘要按文件身份算)。
      ...(isSqlite ? {
        sqlite_table: index.sqlite.table ?? null,
        sqlite_columns: index.sqlite.columns ?? [],
        sqlite_key: index.sqlite.unit_kind ?? null,
        sqlite_order_by: index.sqlite.order_by ?? null,
        sqlite_sidecars_created: Array.isArray(index.sqlite.sidecars_created) ? index.sqlite.sidecars_created : [],
        sqlite_identity_changed: index.sqlite.identity_changed === true,
        sqlite_source: index.sqlite.source_identity ?? null,
        sqlite_has_more: index.sqlite.has_more === true,
        ...(index.sqlite.views_total > 0 ? { sqlite_views: index.sqlite.views_total } : {}),
        ...(index.sqlite.locators_capped > 0 ? { sqlite_locators_capped: index.sqlite.locators_capped } : {}),
      } : {}),
      // 分页账(2026-10-13,D12):客户端据此判"还要不要继续加载",以及走渐进还是走页码
      // (`units_total` 与 1000 比 —— 阈值在客户端,服务端只如实报数)。
      offset,
      units_total: unitsTotal,
      next_offset: nextOffset,
    },
  };
}

// ── 入库 ──────────────────────────────────────────────────────────────────────────────
/**
 * 人审后的候选 → **既有 `store.create`**。逐条回执,总数自洽(契约 §8):
 * `committed + skipped + rejected.length === items.length`。
 *
 * `ok:true` 的语义是"**这批处理完了、回执是完整的**",不是"每条都进去了" ——
 * 被拒条目是**正常结果**,写在 `rejected` 里,不该把整批说成失败(那样前端只会看到一个红叉)。
 * 只有"连批次都没法处理"(形状不对/超批上限)才回 `ok:false`。
 */
export async function commitImport(target, payload) {
  if (!target || typeof target.create !== 'function') {
    return { ok: false, reason: 'invalid_target', message: 'commit 需要一个至少实现 create 的 store' };
  }
  if (!isPlainObject(payload)) return { ok: false, reason: 'invalid_payload', message: 'commit 入参必须是普通对象' };
  const sourceHash = typeof payload.source_hash === 'string' ? payload.source_hash.trim() : '';
  if (!HASH_RE.test(sourceHash)) {
    return { ok: false, reason: 'invalid_source_hash', message: 'source_hash 形状非法(期望 sha256:<64hex>)' };
  }
  const items = payload.items;
  if (!Array.isArray(items)) return { ok: false, reason: 'invalid_items', message: 'items 必须是数组' };
  const limits = payload.limits || target.limits || DEFAULT_LIBRARY_LIMITS;
  if (items.length > Number(limits.importBatchMaxItems)) {
    return {
      ok: false, reason: 'batch_too_large',
      message: `单批 ${items.length} 条,超过 importBatchMaxItems=${limits.importBatchMaxItems}`,
    };
  }
  const batchBytes = utf8Bytes(JSON.stringify(items));
  if (batchBytes > Number(limits.importBatchMaxBytes)) {
    return {
      ok: false, reason: 'batch_too_large',
      message: `单批 ${batchBytes} 字节,超过 importBatchMaxBytes=${limits.importBatchMaxBytes}`,
    };
  }

  const committed = [];
  const rejected = [];
  let skipped = 0;
  let no_key = 0;
  for (let i = 0; i < items.length; i += 1) {
    const idx = i + 1; // 契约 §4:index 是**本批序号**,1-based(与回执对得上)
    const raw = items[i];
    if (!isPlainObject(raw)) { rejected.push({ index: idx, reason: 'invalid_item' }); continue; }
    const locator = raw.locator === undefined || raw.locator === null ? '' : String(raw.locator).trim();
    const item = {};
    // ⚠️ 只剥**导入层**字段,其余原样交给 create —— 静默剥掉 checked_state 就等于放行伪造认证
    for (const [k, v] of Object.entries(raw)) if (!IMPORT_ONLY_KEYS.includes(k)) item[k] = v;
    if (locator === '') {
      no_key += 1; // 没有定位就没有幂等键 ⇒ 如实记账(重复导入它挡不住)
    } else {
      item.import_key = importKey(sourceHash, locator);
    }
    let res = null;
    try {
      res = await target.create(item);
    } catch (e) {
      rejected.push({ index: idx, reason: 'create_threw', message: String(e?.message ?? e) });
      continue;
    }
    if (res && res.ok === true) {
      committed.push(res.item?.id ?? null);
    } else if (res && res.reason === 'duplicate_import') {
      skipped += 1; // 幂等命中:同一份源、同一个定位 —— 这是**成功**,不是失败
    } else {
      rejected.push({
        index: idx,
        reason: (res && res.reason) || 'create_failed',
        ...(res && res.message ? { message: res.message } : {}),
      });
    }
  }
  return {
    ok: true,
    committed: committed.length,
    skipped,
    rejected,
    ids: committed,
    ...(no_key > 0 ? { no_key } : {}),
  };
}
