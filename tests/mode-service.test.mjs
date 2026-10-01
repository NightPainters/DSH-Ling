// mode-service 单元测试(2026-09-29 补,P3-A):把「给某个会话设模式」暴露成跨插件服务。
//
// 背景:器灵的模式记录是私有的(memory.db 的 session_meta.mode),memory/gate/settings
// 只活在器灵自己的 apply 闭包里。为让飞书桥能在建线时把新会话钉到生活挡位,器灵把
// 这个动作注册成 cordis 服务 `dsh-ling/mode`。本文件钉住五条硬断言:
//   1) 注册走 ctx.provide,名字 = 'dsh-ling/mode',provide 的 disposer 原样返回;
//   2) applyMode **不改全局** settings.mode.lastMode(否则飞书挡位会泄漏成桌面默认值);
//   3) applyMode 优先用调用方带来的 keepModel,不读全局当前选择(否则会覆盖对方会话的模型);
//   4) 非法入参 / 依赖抛错 一律**不抛**,以 {ok:false,reason} 返回 —— 对方缺席不该断流程;
//   5) 对照:applyModeToSession 不带 opts 时**仍改** lastMode(GUI 语义未被改坏)。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { registerModeService, MODE_SERVICE_NAME } = await imp('lib/host/mode-service.js');
const { applyModeToSession } = await imp('lib/host/mode.js');
const { mergeDeep } = await imp('lib/host/util.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
/** 被测代码会 console.debug / console.info 记录 warning,这里静音,保持测试输出干净。 */
async function silent(fn) {
  const d = console.debug, i = console.info;
  console.debug = () => {}; console.info = () => {};
  try { return await fn(); } finally { console.debug = d; console.info = i; }
}

const GLOBAL = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
const KEEP = { provider: 'deepseek-official', model: 'deepseek-flash' };

// ---------- 假件 ----------
function fakeCtx({ services = {}, throwOnProvide = false } = {}) {
  const provided = [];
  return {
    get: (n) => services[n],
    provide: (name, value) => {
      if (throwOnProvide) throw new Error('service "x" has been registered at <y>');
      provided.push({ name, value });
      return () => { const i = provided.indexOf(provided.find((p) => p.value === value)); if (i >= 0) provided.splice(i, 1); };
    },
    _provided: provided,
  };
}
function fakeMemory() {
  const modes = new Map();
  return {
    setSessionMode: (sid, m) => modes.set(sid, m),
    sessionMeta: (sid) => (modes.has(sid) ? { session_id: sid, mode: modes.get(sid) } : null),
    _modes: modes,
  };
}
function fakeSettings(init = {}) {
  let s = JSON.parse(JSON.stringify(init));
  return { get: () => s, update: async (p) => { s = mergeDeep(s, p); return s; }, _raw: () => s };
}
/** running 集合里的会话 → 排队(与真实 FreezeGate 的语义一致) */
function fakeGate(running = []) {
  const q = [];
  return {
    enqueueIfRunning: (sid, fn) => { if (!running.includes(sid)) return false; q.push({ sid, fn }); return true; },
    _q: q,
  };
}
function fakeController() {
  const calls = [];
  return { selectModel: async (r) => { calls.push(r); }, _calls: calls };
}
const svcBundle = (ctrl) => ({ sessionController: ctrl, agentDefaultModel: { currentSelection: () => GLOBAL } });

/** 同步版静音(注册时会 console.info 一行)。 */
function quiet(fn) {
  const i = console.info;
  console.info = () => {};
  try { return fn(); } finally { console.info = i; }
}

/** 起一个装好的服务,返回 { api, ctx, memory, settings, gate, ctrl }。 */
function boot({ running = [], services = null, throwOnProvide = false } = {}) {
  const ctrl = fakeController();
  const ctx = fakeCtx({ services: services ?? svcBundle(ctrl), throwOnProvide });
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'work' } });
  const gate = fakeGate(running);
  const dispose = quiet(() => registerModeService(ctx, { gate, memory, settings }));
  return { api: ctx._provided[0]?.value, ctx, memory, settings, gate, ctrl, dispose };
}

// ---------- 1) 注册:走 ctx.provide,名字与 dispose ----------
{
  eq(MODE_SERVICE_NAME, 'dsh-ling/mode', '服务名常量');
  const b = boot();
  eq(b.ctx._provided.length, 1, 'provide 被调用一次');
  eq(b.ctx._provided[0].name, MODE_SERVICE_NAME, '注册用的服务名');
  check(typeof b.api.applyMode === 'function', 'api.applyMode 是函数');
  check(typeof b.api.currentMode === 'function', 'api.currentMode 是函数');
  check(typeof b.dispose === 'function', '返回 disposer');
  b.dispose();
  eq(b.ctx._provided.length, 0, 'disposer 撤销服务');
}

// ---------- 2+3) applyMode:改本会话、用 keepModel、**不动全局** ----------
{
  const b = boot();
  const r = await silent(() => b.api.applyMode('feishu-1', 'life', { keepModel: KEEP }));
  eq(r.ok, true, 'applyMode ok');
  eq(r.mode, 'life', '结果带 mode');
  eq(r.reasoningEffort, 'low', 'life → 推理等级 low');
  eq(b.memory._modes.get('feishu-1'), 'life', '会话模式已写 life');
  eq(b.settings._raw().mode.lastMode, 'work', '★ 全局 lastMode 未被改动');
  eq(b.ctrl._calls.length, 1, 'selectModel 调了一次');
  eq(b.ctrl._calls[0].sessionId, 'feishu-1', 'sessionId 透传');
  eq(b.ctrl._calls[0].model, KEEP.model, '★ 用 keepModel 的模型,不用全局模型');
  eq(b.ctrl._calls[0].provider, KEEP.provider, 'provider 用 keepModel');
  eq(b.ctrl._calls[0].reasoningEffort, 'low', 'selectModel 收到 life 的档位');
}

// ---------- 3b) 不带 keepModel → 退回全局当前选择(仍是合法行为,只是不该被跨插件用到) ----------
{
  const b = boot();
  await silent(() => b.api.applyMode('feishu-2', 'work'));
  eq(b.ctrl._calls.length, 1, '不带 keepModel 时仍会同步档位');
  eq(b.ctrl._calls[0].model, GLOBAL.model, '退回全局当前模型');
  eq(b.settings._raw().mode.lastMode, 'work', '全局仍未被这次调用改动');
}

// ---------- 4) syncEffort:false → 只记模式,不碰模型 ----------
{
  const b = boot();
  const r = await silent(() => b.api.applyMode('feishu-3', 'life', { keepModel: KEEP, syncEffort: false }));
  eq(b.ctrl._calls.length, 0, 'syncEffort=false → 不调 selectModel');
  eq(r.warning, 'effort-sync-skipped', 'warning 说明为何没同步');
  eq(b.memory._modes.get('feishu-3'), 'life', '模式仍照常写入');
}

// ---------- 5) 非法入参:不抛,给 reason ----------
{
  const b = boot();
  eq((await b.api.applyMode('', 'life')).reason, 'no-session-id', '空 sessionId → no-session-id');
  eq((await b.api.applyMode(null, 'life')).reason, 'no-session-id', 'null sessionId → no-session-id');
  eq((await b.api.applyMode('s', 'nope')).reason, 'unknown-mode:nope', '未知模式 → unknown-mode');
  eq((await b.api.applyMode('s', 'work', { keepModel: KEEP })).ok, true, 'work 是合法模式');
  eq(b.ctrl._calls.length, 1, '只有合法那次走到了 selectModel');
}

// ---------- 6) 会话在跑 → 入队,不当场写 ----------
{
  const b = boot({ running: ['feishu-4'] });
  const r = await silent(() => b.api.applyMode('feishu-4', 'life', { keepModel: KEEP }));
  eq(r.queued, true, 'running 会话 → queued');
  eq(b.gate._q.length, 1, '队列里有一条');
  eq(b.memory._modes.has('feishu-4'), false, '入队时还没写模式(等空闲边界)');
}

// ---------- 7) 依赖抛错:不抛,以 ok:false / warning 收场 ----------
{
  const ctrl = { selectModel: async () => { throw new Error('busy'); } };
  const ctx = fakeCtx({ services: svcBundle(ctrl) });
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'work' } });
  const dispose = registerModeService(ctx, { gate: fakeGate(), memory, settings });
  const api = ctx._provided[0].value;
  const r = await silent(() => api.applyMode('feishu-5', 'life', { keepModel: KEEP }));
  eq(r.ok, true, '平台拒绝 selectModel 不判整体失败');
  check(String(r.warning).startsWith('selectModel failed'), 'warning 记录原因:' + r.warning);
  eq(memory._modes.get('feishu-5'), 'life', '模式仍写入(UI/记忆语义先走)');
  dispose();
}

// ---------- 8) 同名服务已被占用:注册不抛,返回 no-op ----------
{
  const ctx = fakeCtx({ throwOnProvide: true });
  let dispose;
  let threw = false;
  await silent(async () => {
    try { dispose = registerModeService(ctx, { gate: fakeGate(), memory: fakeMemory(), settings: fakeSettings() }); }
    catch { threw = true; }
  });
  check(!threw, 'provide 抛错时 registerModeService 不向上抛');
  check(typeof dispose === 'function', '仍返回一个 disposer');
  try { dispose(); } catch { check(false, 'no-op disposer 不该抛'); }
}

// ---------- 9) currentMode 读得到 ----------
{
  const b = boot();
  eq(b.api.currentMode('nobody'), 'work', '无会话记录 → 跟随 lastMode(=work)');
  eq(b.api.currentMode(''), 'work', '空 sessionId → 跟随 lastMode');
  await silent(() => b.api.applyMode('feishu-6', 'work', { keepModel: KEEP }));
  eq(b.api.currentMode('feishu-6'), 'work', '写入后读得到 work');
  await silent(() => b.api.applyMode('feishu-7', 'life', { keepModel: KEEP }));
  eq(b.api.currentMode('feishu-7'), 'life', '会话记录优先于 lastMode');
}

// ---------- 10) 对照:GUI 路径(applyModeToSession 不带 opts)行为未被改坏 ----------
{
  const ctrl = fakeController();
  const ctx = fakeCtx({ services: svcBundle(ctrl) });
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'work' } });
  const gate = fakeGate();
  const r = await silent(() => applyModeToSession(ctx, gate, memory, settings, 'gui-1', 'life'));
  eq(r.ok, true, 'GUI 路径 ok');
  eq(memory._modes.get('gui-1'), 'life', 'GUI 路径写会话模式');
  eq(settings._raw().mode.lastMode, 'life', '★ GUI 路径仍改 lastMode(D2 跟随未被改坏)');
  eq(ctrl._calls[0].model, GLOBAL.model, 'GUI 路径仍用全局当前模型原样带回');
}

// ---------- 11) 源码级护栏:服务层不得自己把全局设成默认 ----------
{
  const src = readFileSync(join(root, 'lib/host/mode-service.js'), 'utf8');
  check(!/setDefault\s*:\s*true/.test(src), 'mode-service 不得出现 setDefault:true(会把飞书挡位泄漏成全局默认)');
  check(/setDefault\s*:\s*false/.test(src), 'mode-service 必须显式写 setDefault:false');
}

console.log(ok ? 'mode 服务(跨插件设挡位,不动全局)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
