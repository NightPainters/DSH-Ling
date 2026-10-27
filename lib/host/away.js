// lib/host/away.js — 「在场 / 暂离」的时间窗（1.7.3 夜 · 2026-10-27 主人定）
//
// 为什么需要一个**时间窗**，而不是每次都看"当前开关值":
//   入库是**异步的**——会话结束、空闲边界、下次启动都会回头扫会话日志补写。如果只判"此刻在不在场",
//   那么"离场期间说的话"会在她回来后（下一次差分捕捉/深摘时）被**补记**进记忆库，
//   于是她"记得"一段自己不在场的经历 —— 那是伪造记忆，比失忆更糟。
//
// 所以：离场这件事要落成**区间**，入库判的是"这条消息的时间落没落在离场区间里"。
//   入区间 → 丢弃（不入库）；出区间 → 照常。
// 将来 1.8 的「补课」正好消费同一份区间：列出"她不在的那几段"，由主人勾选要不要喂给她。
//
// 存储：`kv['away.windows']` = JSON 数组，每项 { from: ISO, to: ISO|null }；to=null 表示"仍未回来"。
//   · 只保留最近 MAX_WINDOWS 段（防止无限增长；超过就是"很久没看"，也够用了）。
//   · 任何一步读/写失败都**不抛**：离场判定坏了不该把入库或面板搞崩。

const KV_WINDOWS = 'away.windows';
const MAX_WINDOWS = 200;

/**
 * **唯一判据**：这份设置快照是不是"她暂离"。
 *
 * 为什么要把旧的两个细档键也算进来（2026-10-27 夜 · F 类盲审抓到的洞）：
 *   1.7.3 白天版把 `persona.enabled` 与 `inject.memoryEnabled` 留作"底层细档"，只让 `away` 压它们。
 *   于是下面两种盘上状态仍然可达（直连 API、或迁移漏网的老 settings.json）：
 *     · `enabled=false` + `memoryEnabled=true` ⇒ 人格不出、记忆照出（别人在读她的档案）
 *     · `enabled=true`  + `memoryEnabled=false` ⇒ 人格出、记忆不出（失忆的她）
 *   而这两种正是主人当晚明令要消灭的"不是人"的状态。
 *   ⇒ 判据收成一条：**任何一个"少给她一点"的旧配置，一律归为暂离**（不存在半开）。
 *   旧键因此不再是"细档"，而是 `away` 的**同义别名** —— 语义仍向后兼容，组合却不可达。
 *
 * @param {object|null|undefined} s 已取出的设置对象（不是 settings 门面）
 * @returns {boolean}
 */
export function awayFromSettings(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.inject?.away === true) return true;
  if (s.persona?.enabled === false) return true;
  if (s.inject?.memoryEnabled === false) return true;
  return false;
}

/** 当前是否离场。设置读不出来 ⇒ 视为**在场**（fail-open：一次读失败不该让她突然失能）。 */
export function isAwayNow(settings) {
  try {
    return awayFromSettings(settings?.get?.());
  } catch {
    return false;
  }
}

/** 读出全部离场区间（坏数据 ⇒ 空数组，不抛）。 */
export function readAwayWindows(memory) {
  try {
    const raw = memory?.kvGet?.(KV_WINDOWS);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((w) => w && typeof w.from === 'string' && (w.to === null || typeof w.to === 'string'));
  } catch {
    return [];
  }
}

function saveAwayWindows(memory, windows) {
  // 1.7.3 夜 F 类第三轮(盲审 B2):**写完要回读验证**。
  // 原因:台账是隐私边界,`kvSet` 失败/被截断时如果静默成功,后面所有入库判定都会放行 ——
  //   面板说"她暂离了",实际离场期间的话照样入库,又是一次"说了不做"。
  // 这里不抛(抛了会把入库或面板搞崩),而是把结果记进 kv,由面板与回执如实说破。
  try {
    const cut = windows.slice(-MAX_WINDOWS);
    memory?.kvSet?.(KV_WINDOWS, JSON.stringify(cut));
    const back = memory?.kvGet?.(KV_WINDOWS);
    if (!back) return markLedger(memory, 'unverified', '写后回读为空');
    const arr = JSON.parse(back);
    if (!Array.isArray(arr) || arr.length !== cut.length) {
      return markLedger(memory, 'mismatch', '写后回读条数不符(' + (Array.isArray(arr) ? arr.length : 'not-array') + '/' + cut.length + ')');
    }
    return markLedger(memory, 'ok', '');
  } catch (e) {
    return markLedger(memory, 'failed', String(e?.message ?? e).slice(0, 200));
  }
}

/** 台账状态落一条 kv(不抛)。`ok` 也记,这样面板能说"上次写入是好的/是坏的"。 */
function markLedger(memory, state, detail) {
  try {
    memory?.kvSet?.('away.ledger', JSON.stringify({ state, detail, at: new Date().toISOString() }));
  } catch { /* 连状态都写不进去:返回值仍然告诉调用方 */ }
  if (state !== 'ok') console.warn('[dsh-ling] 离场区间台账写入异常(%s %s) —— 离场期间的会话可能仍会入库', state, detail);
  return state;
}

/** 台账健康度(只读)。面板/回执用它说破"台账没写成,边界不可靠"。 */
export function awayLedger(memory) {
  try {
    const raw = memory?.kvGet?.(KV_WINDOWS);
    const st = memory?.kvGet?.('away.ledger');
    let state = 'ok';
    let detail = '';
    let at = null;
    if (st) {
      try {
        const o = JSON.parse(st);
        state = String(o?.state || 'ok');
        detail = String(o?.detail || '');
        at = o?.at || null;
      } catch { state = 'unreadable'; }
    }
    if (raw) {
      try { JSON.parse(raw); } catch { state = 'corrupt'; detail = '台账内容不是合法 JSON'; }
    }
    return { state, detail, at };
  } catch {
    return { state: 'unreadable', detail: '', at: null };
  }
}

/**
 * 把"当前开关值"同步成区间台账。幂等：开关没变就什么都不做。
 * 调用点：① 宿主启动时（补上"上次离场后没关掉"的那一段）② 面板拨开关时。
 * @returns {'opened'|'closed'|null} 本次实际做的动作
 */
export function syncAwayWindow(memory, settings, now = Date.now()) {
  const at = new Date(now).toISOString();
  const windows = readAwayWindows(memory);
  const open = windows.length ? windows[windows.length - 1].to === null : false;
  const away = isAwayNow(settings);
  if (away && !open) {
    windows.push({ from: at, to: null });
    saveAwayWindows(memory, windows);
    return 'opened';
  }
  if (!away && open) {
    windows[windows.length - 1].to = at;
    saveAwayWindows(memory, windows);
    return 'closed';
  }
  return null;
}

/**
 * 时间归一(1.7.3 夜 F 类第三轮 · 盲审 N1):入库与深摘都直接吃事件时间字段,
 * 而"时间"在真实日志里有三种形态 —— epoch 毫秒、epoch 秒、ISO 字符串。
 * 只按毫秒比较时,**秒**(会被当成 1970)与**ISO 字符串**(Number() 得 NaN)都会逃出区间过滤
 * ⇒ 离场内容照样入库。这里统一成毫秒;认不出来的返回 0(按"不知道"处理,见下面的策略)。
 */
export function toEpochMs(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) {
    // 1e11 ms = 1973-03;小于它的正数只可能是"秒"(1.7e9 ≈ 2023)⇒ 换乘 1000
    return n < 1e11 ? n * 1000 : n;
  }
  const p = Date.parse(String(v ?? ''));
  return Number.isNaN(p) ? 0 : p;
}

/**
 * 这条消息的时间是否落在某个离场区间里（= 她不在场时产生的，不该入库）。
 * @param {number|string} ts epoch ms / epoch 秒 / ISO 字符串；拿不到时间 ⇒ 按**不入区间**处理
 *        （宁可多记，不误丢 —— 保守方向在这里是"别把她正常说的话也吞了"）。
 */
export function withinAwayWindow(memory, ts) {
  const t = toEpochMs(ts);
  if (!t) return false;
  const windows = readAwayWindows(memory);
  if (!windows.length) return false;
  for (const w of windows) {
    const from = Date.parse(w.from);
    if (Number.isNaN(from) || t < from) continue;
    if (w.to === null) return true;                 // 至今未归
    const to = Date.parse(w.to);
    if (Number.isNaN(to)) return true;              // 结束时间坏了 ⇒ 保守地当作"仍在离场"（隐私方向）
    if (t <= to) return true;
  }
  return false;
}

/** 面板/回执用的一句话摘要（只读，不写）。 */
export function awaySummary(memory) {
  const windows = readAwayWindows(memory);
  const last = windows.length ? windows[windows.length - 1] : null;
  return {
    windows: windows.length,
    open: !!last && last.to === null,
    since: last ? last.from : null,
    lastTo: last ? last.to : null,
    // 台账健康度:面板要能说"边界不可靠"(盲审 B2)
    ledger: awayLedger(memory),
  };
}
