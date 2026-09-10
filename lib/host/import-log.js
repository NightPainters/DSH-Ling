// dsh-ling host — 导入记录(每次把历史请进门,都留一笔可查的账)。
// 设计(2026-09-11,作者拍板「甲」):
//   - **一次导入 = 一条账**:传输层仍按批(200/批)发送,但每批带同一个 runId,
//     host 端按 runId 累加进同一条账(批数/计数相加),日志不暴露 HTTP 细节;
//   - `at` = **导入开始时刻并固定**(首批写入后不再变动,账不会在列表里跳位置);`updatedAt` 记最后一批;
//   - 成功批由 /import/file/batch 自己记账;失败批由客户端经 /import/log 上报(只加 `errors` 批数);
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

  if (runId) {
    const found = findByRun(memory, runId);
    if (found) {
      const merged = { ...found.value, updatedAt: now };
      merged.batches = (Number(found.value.batches) || 1) + batches;
      for (const k of NUM_KEYS) merged[k] = (Number(found.value[k]) || 0) + inc[k];
      if (!merged.name && name) merged.name = name; // 名字取首个非空
      if (note) merged.note = note;                 // 备注取最新
      // at / startedAt / runId / kind 保持首值
      memory.kvSet(found.key, JSON.stringify(merged));
      prune(memory);
      return found.key;
    }
  }

  const key = keyFor(memory, at);
  memory.kvSet(key, JSON.stringify({
    at, startedAt: at, updatedAt: now, runId: runId || null,
    kind, name, batches, ...inc, note,
  }));
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
  return `${when} · 文件导入${item.name ? '(' + item.name + ')' : ''} · ${parts.join(' · ')}`;
}
