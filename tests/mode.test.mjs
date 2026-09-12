// mode 层单元测试(2026-09-13 补):**模式只应改变推理等级,绝不改变模型**。
// 三条硬断言:
//   1) 解析结果不含 provider/model(模式不再是"改模型"的来源);
//   2) selectModel 收到的是「当前模型原样带回 + 模式的推理档位」;
//   3) 读不到当前模型时**压根不调用** selectModel(宁可档位不同步,也不替用户选模型)。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  applyModeToSession, currentMode, resolveModeConfig, resolveModeEffort, currentModelSelection,
  isEffort, MODE_EFFORT, KNOWN_MODES,
} = await imp('lib/host/mode.js');
const { mergeDeep } = await imp('lib/host/util.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
/** 被测代码会用 console.debug 记录 warning,这里静音,保持测试输出干净。 */
async function silent(fn) {
  const orig = console.debug;
  console.debug = () => {};
  try { return await fn(); } finally { console.debug = orig; }
}

const CUR = { provider: 'deepseek-official', model: 'deepseek-v4-pro' };

// ---------- 假件 ----------
const fakeCtx = (services) => ({ get: (n) => services[n] });
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
  return { get: () => s, update: async (patch) => { s = mergeDeep(s, patch); return s; } };
}
/** running 集合里的会话 → 排队(与真实 FreezeGate 的语义一致) */
function fakeGate(running = []) {
  const queued = [];
  return {
    enqueueIfRunning: (sid, fn) => {
      if (!running.includes(sid)) return false;
      queued.push({ sid, fn });
      return true;
    },
    _queued: queued,
  };
}
function fakeController() {
  const calls = [];
  return {
    selectModel: async (req) => { calls.push(req); },
    _calls: calls,
  };
}

// ---------- 1) 解析结果只含推理等级,不含 provider/model ----------
const cfgWork = resolveModeConfig({ mode: { mapping: {} } }, 'work');
check(Object.keys(cfgWork).length === 1 && cfgWork.reasoningEffort === 'max', 'work 解析只含 reasoningEffort:' + JSON.stringify(cfgWork));
check(!('provider' in cfgWork) && !('model' in cfgWork), '解析结果不含 provider/model');
eq(resolveModeConfig({ mode: { mapping: {} } }, 'life').reasoningEffort, 'low', 'life 默认档位=low');
eq(resolveModeEffort({ mode: { mapping: { work: { effort: 'high' } } } }, 'work'), 'high', 'settings 覆盖档位');
eq(resolveModeEffort({ mode: { mapping: { work: { effort: 'banana' } } } }, 'work'), 'max', '非法档位回退默认');
eq(resolveModeEffort(undefined, 'life'), 'low', 'settings 缺失也能解析');
eq(resolveModeEffort({ mode: { mapping: { life: { effort: 'off' } } } }, 'life'), 'off', 'off 是合法档位');
// 旧配置里残留的 provider/model 必须被忽略(向后兼容:旧 mapping 不得再影响模型)
const legacy = resolveModeConfig({ mode: { mapping: { work: { provider: 'old-p', model: 'old-m', effort: 'max' } } } }, 'work');
check(Object.keys(legacy).length === 1 && legacy.reasoningEffort === 'max', '旧 mapping 的 provider/model 被忽略:' + JSON.stringify(legacy));
eq(MODE_EFFORT.work, 'max', 'MODE_EFFORT.work = max');
eq(MODE_EFFORT.life, 'low', 'MODE_EFFORT.life = low');
eq(isEffort('max'), true, 'isEffort(max)');
eq(isEffort('banana'), false, 'isEffort(banana)');
check(KNOWN_MODES.join(',') === 'work,life', 'KNOWN_MODES 只有工作/生活');

// ---------- 2) selectModel 收到「当前模型 + 模式档位」----------
{
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const controller = fakeController();
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ ...CUR }) },
    sessionController: controller,
  });
  const r = await applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-1', 'work');
  check(r.ok === true && !r.queued, 'work 立即生效:' + JSON.stringify(r));
  eq(r.reasoningEffort, 'max', '响应带 reasoningEffort');
  eq(controller._calls.length, 1, 'selectModel 被调用一次');
  const req = controller._calls[0] || {};
  eq(req.sessionId, 'sess-1', '带上 sessionId');
  eq(req.provider, CUR.provider, 'provider = 当前值(原样带回)');
  eq(req.model, CUR.model, 'model = 当前值(原样带回,不被改写)');
  eq(req.reasoningEffort, 'max', 'reasoningEffort = 工作档位');
  check(Object.keys(req).sort().join(',') === 'model,provider,reasoningEffort,sessionId', '请求字段恰好四个:' + Object.keys(req).join(','));
  eq(memory._modes.get('sess-1'), 'work', '模式已记录到会话');
  eq(settings.get().mode.lastMode, 'work', 'D2 跟随:lastMode 更新为 work');
}
{
  // 生活模式:同一个当前模型,档位换成 low
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'work', mapping: {} } });
  const controller = fakeController();
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ ...CUR }) },
    sessionController: controller,
  });
  await applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-2', 'life');
  const req = controller._calls[0] || {};
  eq(req.reasoningEffort, 'low', '生活档位=low');
  eq(req.model, CUR.model, '生活模式同样不改模型');
  eq(settings.get().mode.lastMode, 'life', 'D2 跟随:lastMode 更新为 life');
}

// ---------- 3) 读不到当前模型 → 不调用 selectModel ----------
{
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const controller = fakeController();
  const ctx = fakeCtx({ sessionController: controller, agentDefaultModel: {} }); // 无 currentSelection
  const r = await silent(() => applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-3', 'work'));
  eq(controller._calls.length, 0, '模型不可读时一次都不调用 selectModel');
  check(String(r.warning || '').includes('unknown-current-model'), 'warning 说明原因:' + r.warning);
  check(r.ok === true, '仍按成功返回(模式照常记录)');
  eq(memory._modes.get('sess-3'), 'work', '模式仍记录(UI/记忆语义不受影响)');
  eq(settings.get().mode.lastMode, 'work', 'lastMode 仍跟随');
  eq(currentModelSelection(ctx), null, 'currentModelSelection 返回 null');
}
{
  // currentSelection 存在但字段不全 → 同样视为不可读
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ provider: 'p' }) },
    sessionController: fakeController(),
  });
  eq(currentModelSelection(ctx), null, 'provider/model 不全 → null');
}
{
  // agentDefaultModel 服务缺失(平台差异)→ 不抛错
  const ctx = fakeCtx({ sessionController: fakeController() });
  eq(currentModelSelection(ctx), null, '服务缺失 → null 且不抛错');
}

// ---------- 4) D4:running 会话只排队,不立即改档位 ----------
{
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const controller = fakeController();
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ ...CUR }) },
    sessionController: controller,
  });
  const gate = fakeGate(['sess-run']);
  const r = await applyModeToSession(ctx, gate, memory, settings, 'sess-run', 'work');
  check(r.ok === true && r.queued === true && r.running === true, 'running → 排队:' + JSON.stringify(r));
  eq(controller._calls.length, 0, '排队时未调用 selectModel');
  eq(gate._queued.length, 1, '排队项已入队');
  eq(memory.sessionMeta('sess-run'), null, '排队时未写会话模式');
}

// ---------- 5) 平台拒绝(selectModel 抛错)不影响模式生效 ----------
{
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ ...CUR }) },
    sessionController: { selectModel: async () => { throw new Error('model busy'); } },
  });
  const r = await silent(() => applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-5', 'work'));
  check(r.ok === true, '平台拒绝仍返回 ok');
  check(String(r.warning || '').includes('selectModel failed'), 'warning 带平台原因:' + r.warning);
  eq(memory._modes.get('sess-5'), 'work', '模式已记录');
}
{
  // 没有 sessionController(其它宿主)→ 只记录模式
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const r = await applyModeToSession(fakeCtx({}), fakeGate(), memory, settings, 'sess-6', 'work');
  check(r.ok === true && String(r.warning || '').includes('no-sessionController'), '无控制器时仅记录:' + r.warning);
}

// ---------- 6) 入参防御 + currentMode 回退 ----------
{
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'life', mapping: {} } });
  const ctx = fakeCtx({});
  const r1 = await applyModeToSession(ctx, fakeGate(), memory, settings, '', 'work');
  check(r1.ok === false && r1.reason === 'no-session-id', '缺 sessionId 直接拒绝');
  const r2 = await applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-7', 'weekend');
  check(r2.ok === false && String(r2.reason).startsWith('unknown-mode:'), '未知模式直接拒绝:' + r2.reason);
}
{
  const memory = fakeMemory();
  memory.setSessionMode('sess-m', 'work');
  eq(currentMode(memory, fakeSettings({ mode: { lastMode: 'life' } }), 'sess-m'), 'work', '会话模式优先');
  eq(currentMode(memory, fakeSettings({ mode: { lastMode: 'work' } }), 'sess-none'), 'work', '无会话记录 → 跟随 lastMode');
  eq(currentMode(memory, fakeSettings({ mode: { lastMode: 'junk' } }), 'sess-none'), 'life', 'lastMode 非法 → 回退 life');
  eq(currentMode(memory, fakeSettings({}), ''), 'life', '空 sessionId → life');
}

// ---------- 7) 源码级护栏:mode 路径不得出现任何硬编码模型/provider ----------
{
  const src = readFileSync(join(root, 'lib/host/mode.js'), 'utf8');
  const ids = src.match(/deepseek-[a-z0-9.-]+/gi) || [];
  check(ids.length === 0, 'mode.js 不得出现硬编码模型名,实际:' + JSON.stringify(ids));
  // 允许 `keep.provider` / `String(sel.provider)` 这类"读来的值",但不得出现字符串字面量形式的 provider
  const lits = src.match(/['"](?:deepseek|openai|anthropic|google|azure|moonshot|qwen|siliconflow)[a-z0-9._-]*['"]/gi) || [];
  check(lits.length === 0, 'mode.js 不得出现硬编码 provider 字符串,实际:' + JSON.stringify(lits));
}

console.log(ok ? 'mode 层(只改档位不改模型)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
