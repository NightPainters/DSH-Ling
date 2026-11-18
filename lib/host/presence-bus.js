// dsh-ling host — presence 变更总线(P4,2026-11-11)。
//
// 为什么会有这个文件:契约 `dsh-ling/presence`(HANDOFF-器灵-presence接口-20261022.md)
// 要求"五类写点各发一条 Change",而写点分散在 `memory.js`(树/遗忘/挡位)与
// `settings-file.js`(人格/设置)。两条路可走:
//   a) 把 bus 挂到 apply 闭包里、由 service 单例持有 —— 写点在 MemoryStore / SettingsFile 里,
//      拿不到闭包,只能层层传参(改 20 处签名);
//   b) **模块级单实例总线** —— 写点 `import` 即可发事件,零传参。
// 这里走 b。代价与对策:
//   · 多实例(器灵被加载两遍)会共享同一条总线 ⇒ 不会出现"两份缓冲、只有一份可见"的分叉,
//     反而更安全(注册失败的那份也照样往同一处记);
//   · 测试需要隔离 ⇒ `resetPresenceBus()` 显式复位(唯一入口,不允许直接改内部)。
//
// 红线(HANDOFF §3.5 / §5):
//   · Change **只含五个键** `kind/at/code/scope/count`,**绝不出现内容文本**;
//   · 未知 kind / code **一律忽略**(不发、不记、不抛);
//   · 任何失败都不得冒泡到写路径 —— 本文件所有导出函数**永不抛**。
//
// `recent()` **不消费**(口径见 `_crew/reports/p4-impl/impl.md`):`pending` 只由
// 「投递」(markDelivered)推进,不由读行为推进 —— 与 HANDOFF §5-1「不给拦截权」同向:
// 消费方的读取行为不该改变器灵自己的状态读数。
//
// ⚠️ **非契约导出(N5,2026-11-11 P4B)**:本文件 export 的 `emitChange` / `emitSettingsChanged` /
//   `markDelivered` / `resetPresenceBus` / `setPresenceClock` / `refreshPresenceBootAt` /
//   `normalizeChange` / `configurePresence` 全部是**提供方内部接缝**与测试缝,**不在**
//   `dsh-ling/presence` 的公开契约里。消费方**只许**经 `ctx.get('dsh-ling/presence')` 取
//   `state / watch / recent` 三个方法(HANDOFF §3.1 的最窄接口)。直接 import 本文件去伪造变更、
//   复位缓冲或替换时钟 = 越界;这些名字与形态**随时可变**,不受「只增键」承诺保护(铁律 3 只覆盖
//   `state()` 返回的字段与 Change 的键)。
import { utcIso } from './util.js';

/** v1 受控词表(HANDOFF §3.5,只增不改)。 */
export const PRESENCE_CODES = Object.freeze([
  'tree.changed',
  'memory.forgotten',
  'persona.changed',
  'settings.changed',
  'mode.changed',
]);

/** 词表里每条 code 固定挂在哪个 kind 上(HANDOFF §3.5 表的第三列)。 */
export const PRESENCE_KINDS = Object.freeze(['memory', 'persona', 'settings', 'tree']);

const CODE_KIND = Object.freeze({
  'tree.changed': 'tree',
  'memory.forgotten': 'memory',
  'persona.changed': 'persona',
  'settings.changed': 'settings',
  'mode.changed': 'settings',
});

/** Change 只允许这五个键(顺序即构造顺序;测试 #8 按它断言)。 */
export const CHANGE_KEYS = Object.freeze(['kind', 'at', 'code', 'scope', 'count']);

const DEFAULT_BUFFER_SIZE = 200; // 与 config.js 的 presence.bufferSize 默认一致
const MAX_BUFFER_SIZE = 10000;   // 夹取上界(配置写大了也不许吃满内存)
/** `scope.sessionId` 长度上限(N4)。本仓自己吃过"200KB id"的亏(memory.js:1263 的注释);
 *  超长一律**截断**而不是拒绝 —— 丢事件比截断一个 id 更糟。 */
const MAX_SESSION_ID_LEN = 128;
/** 全局变更槽的 key(无 sessionId 的变更 = 影响所有会话)。 */
const GLOBAL_PENDING_KEY = '*';

/**
 * 单实例状态。`buffer` 是环形缓冲(超出 bufferSize 就从头部丢);
 * `pending` 记"哪些会话还有未投递的变更":key = `s:<sessionId>`,全局变更 = `*`。
 * ⚠️ MF5 口径(2026-11-11 P4B,方案②):`state().pending.sessions` **只数 `s:` 前缀**
 * (= 真实会话数);全局槽单独报成 `state().pending.global`(0/1)。
 * 旧实现把 `*` 也算进 `sessions`,于是"零会话时报 1、十个会话时报 1" —— 字段名与读数不符。
 */
function freshState() {
  return {
    enabled: true,
    bufferSize: DEFAULT_BUFFER_SIZE,
    bootAt: utcIso(),
    clock: () => utcIso(), // 可被测试替换(见 setPresenceClock),生产不替换
    seq: 0,
    buffer: [],           // [{ seq, change }]
    listeners: new Set(),
    pending: new Map(),   // key -> 未投递条数
    lastChange: null,
  };
}

let state = freshState();

/** 测试隔离入口:复位成刚加载时的形状(含 bootAt / 时钟 / 监听器 / 缓冲)。 */
export function resetPresenceBus() {
  state = freshState();
  return { ok: true };
}

/** N1:把 `bootAt` 刷成本次加载时刻。`registerPresenceService` 每次注册都调它 ——
 *  热重载 / 同进程二次注册 / 测试复位后重建,契约 §3.2 的"器灵本次加载时刻"才成立。
 *  永不抛。 */
export function refreshPresenceBootAt() {
  try {
    state.bootAt = utcIso();
    return { ok: true, bootAt: state.bootAt };
  } catch {
    return { ok: false };
  }
}


/** 只给测试用:替换 `at` 的生成器(生产一律 `utcIso()`)。失败不抛。 */
export function setPresenceClock(fn) {
  try {
    if (typeof fn === 'function') state.clock = fn;
    else state.clock = () => utcIso();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'bad-clock' };
  }
}

/**
 * 应用插件配置 `cfg.presence`(cordis.yml 可改,不许硬编码)。
 * 非法值一律忽略并保留旧值;`bufferSize` 先判数值再夹到 [1, 10000]。
 */
export function configurePresence(config = {}) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: true, enabled: state.enabled, bufferSize: state.bufferSize };
    if (typeof config.enabled === 'boolean') state.enabled = config.enabled;
    // 先判类型(与 memory.js:965 的 weight_scale 同一教训:`Number(null) === 0` 会静默变 0)
    if (typeof config.bufferSize === 'number' && Number.isFinite(config.bufferSize)) {
      state.bufferSize = Math.max(1, Math.min(MAX_BUFFER_SIZE, Math.floor(config.bufferSize)));
      if (state.buffer.length > state.bufferSize) state.buffer.splice(0, state.buffer.length - state.bufferSize);
    }
    return { ok: true, enabled: state.enabled, bufferSize: state.bufferSize };
  } catch {
    return { ok: false, reason: 'bad-config' };
  }
}

/** 拷贝一份 Change(五键;只读面绝不把内部对象交出去)。 */
function cloneChange(change) {
  const out = { kind: change.kind, at: change.at, code: change.code, scope: { ...change.scope } };
  if (change.count !== undefined) out.count = change.count;
  return out;
}

/**
 * 校验 + 归一化一条变更。只认五个键:多余键一律丢弃(内容文本没有任何入口)。
 * @returns {{ok:true, change:object}|{ok:false, reason:string}}
 */
export function normalizeChange(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'bad-change' };
    const code = typeof raw.code === 'string' ? raw.code : '';
    if (!PRESENCE_CODES.includes(code)) return { ok: false, reason: 'unknown-code' };
    const kind = CODE_KIND[code];
    // 调用方显式给 kind 时必须与词表一致;不一致 = 未知 kind ⇒ 忽略(铁律 1 的反面由提供方先挡)
    if (raw.kind !== undefined && raw.kind !== kind) return { ok: false, reason: 'unknown-kind' };
    // at 一定是 UTC ISO:没给 ⇒ 时钟;给了 ⇒ 归一化(防 `Date.now()` 数字 / 本地时间串混进来)
    let at = raw.at;
    if (at === undefined || at === null) at = state.clock();
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return { ok: false, reason: 'bad-at' };
    at = new Date(Date.parse(at)).toISOString();
    // scope 只允许 { sessionId };缺省 = 影响所有会话
    const scope = {};
    const sid = raw.scope && typeof raw.scope === 'object' ? raw.scope.sessionId : undefined;
    // N4:超长 sessionId 截断(不拒绝),避免把 200KB 的 id 塞进缓冲与 pending 键
    if (typeof sid === 'string' && sid.trim()) scope.sessionId = sid.trim().slice(0, MAX_SESSION_ID_LEN);
    const change = { kind, at, code, scope };
    // count 可选:必须是有限的非负数;非法就**不带**这个键(不抛)
    if (raw.count !== undefined) {
      const n = Number(raw.count);
      if (Number.isFinite(n) && n >= 0) change.count = Math.floor(n);
    }
    return { ok: true, change };
  } catch {
    return { ok: false, reason: 'bad-change' };
  }
}

/**
 * 发一条变更(写点唯一入口)。**永不抛**。
 * 未启用 / 未知 code / 未知 kind ⇒ 不记、不通知。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function emitChange(raw) {
  try {
    if (!state.enabled) return { ok: false, reason: 'disabled' };
    const normalized = normalizeChange(raw);
    if (!normalized.ok) return normalized;
    const change = normalized.change;
    state.seq += 1;
    state.buffer.push({ seq: state.seq, change });
    if (state.buffer.length > state.bufferSize) state.buffer.splice(0, state.buffer.length - state.bufferSize);
    state.lastChange = change;
    const key = change.scope.sessionId ? ('s:' + change.scope.sessionId) : GLOBAL_PENDING_KEY;
    state.pending.set(key, (state.pending.get(key) || 0) + 1);
    // 逐个 try/catch:一个坏监听不拖累其余,也绝不把异常带回写路径
    for (const fn of [...state.listeners]) {
      try {
        fn(cloneChange(change));
      } catch (e) {
        console.debug('[dsh-ling] presence listener failed', e);
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'throw:' + String(e?.message ?? e) };
  }
}

/**
 * 设置写的分类发事件(settings-file.js 唯一写盘点的接头):
 *  · patch 命中 `persona` / `styles` 子树 ⇒ `persona.changed`(人格层文本变了);
 *  · 其余(或混合)⇒ `settings.changed`(器灵设置变了,含总开关)。
 * 只报"哪个子树档次"这一层事实,**不带键值、不带正文**(HANDOFF §3.5 红线)。
 */
export function emitSettingsChanged(patch) {
  try {
    const keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
    if (!keys.length) return { ok: false, reason: 'no-patch' };
    const personaKeys = keys.filter((k) => k === 'persona' || k === 'styles');
    const rest = keys.filter((k) => k !== 'persona' && k !== 'styles');
    let last = { ok: false, reason: 'no-patch' };
    if (personaKeys.length) last = emitChange({ code: 'persona.changed' });
    if (rest.length || !personaKeys.length) last = emitChange({ code: 'settings.changed', count: keys.length });
    return last;
  } catch {
    return { ok: false, reason: 'bad-patch' };
  }
}

/**
 * 订阅变更。返回**退订函数**(幂等;调两次不报错)。
 * 未启用时仍可调用 —— 只是永远不触发(HANDOFF §3.3)。
 * @param {(change: object) => void} fn 同步回调,不要在里面做长活
 */
export function watchPresence(fn) {
  if (typeof fn !== 'function') return () => {};
  const entry = (change) => fn(change);
  state.listeners.add(entry);
  let offed = false;
  return () => {
    if (offed) return;
    offed = true;
    state.listeners.delete(entry);
  };
}

/**
 * 补看漏掉的变更:`Change[]`,时间正序,有界(不分页)。`recent()` **不消费** pending。
 * @param {{since?: string, limit?: number}} [opts]
 */
export function recentChanges(opts = {}) {
  try {
    const { since, limit } = opts && typeof opts === 'object' ? opts : {};
    let rows = state.buffer.map((e) => e.change);
    if (typeof since === 'string' && since) {
      const t = Date.parse(since);
      if (!Number.isNaN(t)) rows = rows.filter((c) => Date.parse(c.at) >= t);
    }
    // ISO UTC 字符串可直接字典序比较;相同时刻保持插入顺序(稳定排序)
    rows = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    // N3:limit 一律按"条数"解释 —— `limit:0` / 负数 ⇒ 空表(旧实现只在 `n > 0` 时切片,
    // 于是 `limit:0` 反而回**全量**,与"我要 0 条"的直读语义相反)。
    const n = Number(limit);
    if (Number.isFinite(n)) rows = rows.slice(0, Math.max(0, Math.floor(n)));
    return rows.map(cloneChange);
  } catch {
    return [];
  }
}

/** 只读状态快照:失败也返回对象(**不抛**)。
 *  MF5(方案②,只增键):`pending.sessions` = 只数 `s:` 前缀的**真实会话数**;
 *  新增 `pending.global`(0/1)= 有没有"无 scope(影响所有会话)"的变更还没投递。
 *  旧键的语义**保持不变**(铁律 3):`sessions` 仍是会话数,只是不再把全局槽混进去。 */
export function presenceSnapshot() {
  try {
    return {
      ok: true,
      at: state.clock(),
      bootAt: state.bootAt,
      enabled: state.enabled,
      pending: { sessions: pendingSessionCount(), global: state.pending.has(GLOBAL_PENDING_KEY) ? 1 : 0 },
      lastChange: state.lastChange ? cloneChange(state.lastChange) : null,
    };
  } catch (e) {
    return { ok: false, reason: 'throw:' + String(e?.message ?? e) };
  }
}

/** `pending` 里"真实会话"槽的个数(只数 `s:` 前缀;全局槽 `*` 不算会话)。 */
function pendingSessionCount() {
  let n = 0;
  for (const k of state.pending.keys()) if (k.startsWith('s:')) n += 1;
  return n;
}

/**
 * 投递即消费(HANDOFF §3.2 的 pending 语义):某会话把"压着的变更"投递出去之后调。
 * · `markDelivered(sessionId)` ⇒ 清该会话的未投递计数;
 * · `markDelivered()`(或 null/'*')⇒ 清**全局槽**(无 sessionId 的变更)。
 * ✅ MF1(2026-11-11 P4B):生产投递点已接 —— `inject.js` 的 `advanceLogWatermark()`
 *   (只在"文本真的要送进模型"时被调用)里先 `markDelivered(sessionId)`(该会话那一格)
 *   再 `markDelivered()`(全局槽:这次投递的文本里也含它)。
 */
export function markDelivered(sessionId) {
  try {
    const key = typeof sessionId === 'string' && sessionId.trim() && sessionId !== GLOBAL_PENDING_KEY
      ? ('s:' + sessionId.trim().slice(0, MAX_SESSION_ID_LEN))
      : GLOBAL_PENDING_KEY;
    return { ok: true, cleared: state.pending.delete(key) };
  } catch {
    return { ok: false, reason: 'throw' };
  }
}
