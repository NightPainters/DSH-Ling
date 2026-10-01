// dsh-ling host — 导入记录(每次把历史请进门,都留一笔可查的账)。
// 设计(2026-09-11,作者拍板「甲」):
//   - **一次导入 = 一条账**:传输层仍按批(200/批)发送,但每批带同一个 runId,
//     host 端按 runId 累加进同一条账(批数/计数相加),日志不暴露 HTTP 细节;
//   - `at` = **导入开始时刻并固定**(首批写入后不再变动,账不会在列表里跳位置);`updatedAt` 记最后一批;
//   - 成功批由 /import/file/batch 自己记账;失败批由客户端经 /import/log 上报(只加 `errors` 批数);
//   - #10(2026-09-29):被**跳过**的"单条过大"也进账(客户端在导入收尾时上报一次),但它记的是
//     **跳过**、不是失败 ⇒ 走的是**不带 `errors`** 的那条路(`tooBig` / `tooBigNames`)。
//     以前 `/import/log` 只认 `errors`(且强制 ≥1),客户端只能**故意不报** ⇒ 账本上
//     完全看不出"有东西被跳过";现在这一笔补上了,且绝不混进"失败批"计数。
//   - 三条入口共用:文件导入 / 本机 DSH 扫描 / 网页端库扫描;
//   - kv `import.log.<at>` 存 JSON;保留最近 50 条,满了作废最老的。

export const IMPORT_LOG_PREFIX = 'import.log.';
export const IMPORT_LOG_KEEP = 50;
const AT_PAST_MS = 30 * 24 * 3600 * 1000; // 开始时刻最多回溯 30 天
const AT_FUTURE_MS = 60 * 1000;           // 允许 1 分钟时钟偏差
const NUM_KEYS = ['accepted', 'newRows', 'refreshed', 'upgraded', 'folded', 'removedImport', 'degraded', 'rejected', 'seen', 'errors'];

function pad(n) { return n < 10 ? '0' + n : String(n); }

/** 开始时刻归一:非法/越界一律退回 now —— 账的时间必须可信。 */
export function cleanAt(value, now = Date.now()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return now;
  if (n > now + AT_FUTURE_MS) return now;
  if (n < now - AT_PAST_MS) return now;
  return Math.floor(n);
}

/** ── #10:被跳过的"单条过大"(跳过 ≠ 失败)──────────────────────────────────
 *  三个上限是**输入护栏**,不是显示偏好:账本要长期留着,不许任意长度的用户输入原样进来
 *  (`/import/log` 是 HTTP 端点)。`tooBig` 是"整次导入里被跳过的条数",10000 远超现实。
 *  ⚠️ `cleanTooBig` / `cleanTooBigNames` 是**唯一一份**实现:端点(`api.js`)也调它们,
 *  不许在端点里另抄一份口径(否则两处必漂移)。 */
export const TOO_BIG_MAX = 10000;
/** 账本里最多留几个被跳过的条目名:与界面点名(前 5 条)同口径 —— 账本是摘要,不是清单。 */
export const TOO_BIG_NAMES_MAX = 5;
/** 单个名字的字符数上限:名字只用来"让人认出是哪一条",40 字够;超了就截,不丢整条。 */
export const TOO_BIG_NAME_CHARS = 40;

/** `tooBig` 归一:非负整数,夹在 [0, TOO_BIG_MAX];非数字/负数 → 0(不是 NaN、不是 undefined)。 */
export function cleanTooBig(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, TOO_BIG_MAX);
}

/** `tooBigNames` 归一:**只留非空字符串**、每条截到 40 字、最多 5 条(先来先留)。
 *  非数组 → 空数组;坏输入只许"少记",绝不许抛(账本通路是尽力而为,不能因为一个字段 500)。 */
export function cleanTooBigNames(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;                       // 非字符串项丢弃
    const s = x.trim();
    if (!s) continue;                                          // 空/纯空白丢弃
    out.push(s.length > TOO_BIG_NAME_CHARS ? s.slice(0, TOO_BIG_NAME_CHARS) : s);
    if (out.length >= TOO_BIG_NAMES_MAX) break;                 // 只取前 5 条
  }
  return out;
}

/** `foldSkippedRaw` 归一:与 `cleanTooBig` **同口径**(非负整数,夹在 [0, TOO_BIG_MAX]) —— 口径只留一份
 *  (两处各写一遍必漂移,这是本仓的老账)。
 *  语义:A(2026-09-30)折叠时"因为目标会话**已有原文**而**没有替换**的轮数"。它同样是「跳过 ≠ 失败」
 *  那一类(见 #10),所以:① **绝不**混进 `errors`;② `= 0`(含压根没这个字段)时落的账**逐字不变**。 */
export function cleanFoldSkipped(v) { return cleanTooBig(v); }

function numberFields(entry) {
  const out = {};
  for (const k of NUM_KEYS) out[k] = Number(entry?.[k]) || 0;
  return out;
}

/** 同一次导入(runId)找已有账:账 ≤50 条,扫一遍的代价可忽略;坏值跳过。 */
function findByRun(memory, runId) {
  for (const r of memory.kvList(IMPORT_LOG_PREFIX)) {
    try {
      const v = JSON.parse(String(r.value));
      if (v && typeof v === 'object' && v.runId === runId) return { key: String(r.key), value: v };
    } catch { /* 坏值跳过 */ }
  }
  return null;
}

function prune(memory) {
  const keys = memory.kvList(IMPORT_LOG_PREFIX).map((r) => String(r.key)).sort();
  while (keys.length > IMPORT_LOG_KEEP) memory.kvDel(keys.shift());
}

/** 键 = 开始时刻(同毫秒重复导入时加补零序号兜底),保证列表排序≈时间序。 */
function keyFor(memory, at) {
  let key = IMPORT_LOG_PREFIX + at;
  let n = 1;
  while (memory.kvGet(key) !== undefined) key = IMPORT_LOG_PREFIX + at + '.' + String(++n).padStart(3, '0');
  return key;
}

/**
 * 记账。带 runId 时**累加**进同一条账(一次导入一条);不带则为独立一笔(单次扫描)。
 * 返回落的 kv key。
 */
export function logImport(memory, entry) {
  const now = Date.now();
  const runId = String(entry?.runId || '').slice(0, 64);
  const at = cleanAt(entry?.at, now);
  const inc = numberFields(entry);
  const batches = Math.max(1, Math.min(Number(entry?.batches) || 1, 5000));
  const name = String(entry?.name || '').slice(0, 120);
  const note = String(entry?.note || '').slice(0, 200);
  const kind = String(entry?.kind || 'file');
  // #10:被跳过的"单条过大" —— 只有**上报了**它(>0)才入账。
  // ⚠️ `tooBig === 0`(含压根没这个字段)时,下面落的账**逐字不变**(不加键、不改值、不改键序):
  //    这是负对照,`tests/importlog.test.mjs` 有断言 —— 别为了"形状统一"给它俩补默认值。
  const tooBig = cleanTooBig(entry?.tooBig);
  const tooBigNames = cleanTooBigNames(entry?.tooBigNames);
  // A(2026-09-30):折叠时"因为目标已有原文而**没有替换**的轮数" —— 与 tooBig 同款:**只有 >0 才入账**。
  // ⚠️ 同一个负对照同样适用于它:`foldSkippedRaw === 0`(或没这个字段)时,落的账**逐字不变**
  //    (不进 NUM_KEYS:否则每一条文件导入的 JSON 都会凭空多一个 `foldSkippedRaw: 0` 键)。
  const foldSkipped = cleanFoldSkipped(entry?.foldSkippedRaw);

  if (runId) {
    const found = findByRun(memory, runId);
    if (found) {
      const merged = { ...found.value, updatedAt: now };
      merged.batches = (Number(found.value.batches) || 1) + batches;
      for (const k of NUM_KEYS) merged[k] = (Number(found.value[k]) || 0) + inc[k];
      if (!merged.name && name) merged.name = name; // 名字取首个非空
      if (note) merged.note = note;                 // 备注取最新
      if (foldSkipped) {
        // 同一 runId 的多批**累加**(与 tooBig/errors 同语义),合并后仍夹在上限内:
        merged.foldSkippedRaw = Math.min(TOO_BIG_MAX, (Number(found.value.foldSkippedRaw) || 0) + foldSkipped);
      }
      if (tooBig) {
        // 同一 runId 的多批**累加**(与 errors 同语义),但两项仍夹在上限内:
        // 多批各报 5 个名字、30 批就是 150 个 —— 合并后同样只留前 5 条(账本是摘要不是清单)。
        merged.tooBig = Math.min(TOO_BIG_MAX, (Number(found.value.tooBig) || 0) + tooBig);
        const namesMerged = cleanTooBigNames([].concat(merged.tooBigNames || [], tooBigNames));
        if (namesMerged.length) merged.tooBigNames = namesMerged;
      }
      // at / startedAt / runId / kind 保持首值
      memory.kvSet(found.key, JSON.stringify(merged));
      prune(memory);
      return found.key;
    }
  }

  const key = keyFor(memory, at);
  const rec = {
    at, startedAt: at, updatedAt: now, runId: runId || null,
    kind, name, batches, ...inc, note,
  };
  if (tooBig) {
    rec.tooBig = tooBig;
    if (tooBigNames.length) rec.tooBigNames = tooBigNames;
  }
  if (foldSkipped) rec.foldSkippedRaw = foldSkipped; // 同上:0 时不加键(键序与值逐字不变)
  memory.kvSet(key, JSON.stringify(rec));
  prune(memory);
  return key;
}

/** 读取最近 limit 条(倒序,新→旧)。 */
export function listImportLog(memory, { limit = 50 } = {}) {
  const rows = memory.kvList(IMPORT_LOG_PREFIX);
  const items = [];
  for (const r of rows) {
    try {
      const v = JSON.parse(String(r.value));
      if (v && typeof v === 'object' && v.at) items.push(v);
    } catch { /* 坏值跳过 */ }
  }
  items.sort((a, b) => Number(b.at) - Number(a.at));
  return items.slice(0, Math.max(1, Math.min(limit, IMPORT_LOG_KEEP)));
}

/** 展示用的一行摘要(纯函数,便于单测)。 */
export function formatLogLine(item) {
  const d = new Date(Number(item.at));
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (item.kind === 'dsh') {
    return `${when} · 本机 DSH 扫描 · 候选 ${item.seen || 0} · 新增 ${item.newRows}`;
  }
  if (item.kind === 'dsweb') {
    return `${when} · 网页端库扫描 · 源库 ${item.seen || 0} 条 · 新增 ${item.newRows} · 刷新 ${item.refreshed}`;
  }
  const parts = [`新增 ${item.newRows}`, `刷新 ${item.refreshed}`];
  if (item.upgraded) parts.push(`补全原文 ${item.upgraded}`);
  if (item.folded) parts.push(`并入网页端 ${item.folded}`);
  if (item.removedImport) parts.push(`清理副本 ${item.removedImport}`);
  if (item.degraded) parts.push(`降级轻量 ${item.degraded}`);
  if (item.rejected) parts.push(`拒绝 ${item.rejected}`);
  const batches = Number(item.batches) || 0;
  if (batches > 1) parts.push(`${batches} 批`);
  if (item.errors) parts.push(`失败 ${item.errors} 批`);
  // #10:被跳过的"单条过大"必须在账本那一行上看得见(放在"失败 X 批"之后,只加不占位):
  // 它是**已知且可解释**的一件事,与"失败批"是两码事 —— 不许因为没地方写就不写(那正是修前的样子)。
  const tooBigN = Number(item.tooBig) || 0;
  if (tooBigN > 0) parts.push(`单条过大 ${tooBigN}`);
  // A(2026-09-30):折叠时"因为目标已有原文而**没有替换**的轮数"也要在账本这一行上看得见。
  // 与「单条过大」同款:**只在末尾追加**(既有部分逐字不变),且 `= 0` 时行里一个字都不多 ——
  // 它同样是**已知且可解释**的一件事(不是失败、不是丢失:目标是保住会话里原有的真原文)。
  const foldSkippedN = Number(item.foldSkippedRaw) || 0;
  if (foldSkippedN > 0) parts.push(`原文未替换 ${foldSkippedN}`);
  return `${when} · 文件导入${item.name ? '(' + item.name + ')' : ''} · ${parts.join(' · ')}`;
}
