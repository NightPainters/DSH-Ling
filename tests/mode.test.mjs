// mode 层单元测试(2026-09-13 补):**模式只应改变推理等级,绝不改变模型**。
// 三条硬断言:
//   1) 解析结果不含 provider/model(模式不再是"改模型"的来源);
//   2) selectModel 收到的是「当前模型原样带回 + 模式的推理档位」;
//   3) 读不到当前模型时**压根不调用** selectModel(宁可档位不同步,也不替用户选模型)。
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SETTINGS } from '../lib/host/persona.js';   // M7:真机默认值的唯一来源

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

const CUR = { provider: 'synth-provider', model: 'synth-v4-pro' };

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
eq(resolveModeConfig({ mode: { mapping: {} } }, 'life').reasoningEffort, 'high', 'life 默认档位=high(M7)');
eq(resolveModeEffort({ mode: { mapping: { work: { effort: 'high' } } } }, 'work'), 'high', 'settings 覆盖档位');
eq(resolveModeEffort({ mode: { mapping: { work: { effort: 'banana' } } } }, 'work'), 'max', '非法档位回退默认');
eq(resolveModeEffort(undefined, 'life'), 'high', 'settings 缺失也能解析');
eq(resolveModeEffort({ mode: { mapping: { life: { effort: 'off' } } } }, 'life'), 'off', 'off 是合法档位');
// 旧配置里残留的 provider/model 必须被忽略(向后兼容:旧 mapping 不得再影响模型)
const legacy = resolveModeConfig({ mode: { mapping: { work: { provider: 'old-p', model: 'old-m', effort: 'max' } } } }, 'work');
check(Object.keys(legacy).length === 1 && legacy.reasoningEffort === 'max', '旧 mapping 的 provider/model 被忽略:' + JSON.stringify(legacy));
eq(MODE_EFFORT.work, 'max', 'MODE_EFFORT.work = max');
eq(MODE_EFFORT.life, 'high', 'MODE_EFFORT.life = high');
eq(isEffort('max'), true, 'isEffort(max)');
eq(isEffort('banana'), false, 'isEffort(banana)');
check(KNOWN_MODES.join(',') === 'work,life', 'KNOWN_MODES 只有工作/生活');

// ---------- 1b) M7(E2 · 档位可配):生活默认 high,映射覆盖仍优先,工作仍 max ----------
// 语义:只有「没有合法 mapping」时才读 MODE_EFFORT —— 映射是用户的显式选择,永远压过默认。
eq(resolveModeEffort({}, 'life'), 'high', 'M7 ★ resolveModeEffort({}, life) = high(默认档位)');
eq(resolveModeEffort({ mode: { mapping: { life: { effort: 'low' } } } }, 'life'), 'low',
  'M7 ★ settings.mode.mapping.life.effort 覆盖优先(显式 low 压过默认 high)');
eq(resolveModeEffort({}, 'work'), 'max', 'M7 work 默认仍是 max');
// 反向也钉一条:默认改的只是「生活」,工作那侧的覆盖同样不受影响
eq(resolveModeEffort({ mode: { mapping: { work: { effort: 'high' } } } }, 'work'), 'high', 'M7 work 覆盖仍优先');

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
  eq(settings.get().mode.lastMode, 'life', 'D2 解耦:不传 opts 的会话切换不写 lastMode(仍 life)');
}
{
  // 生活模式:同一个当前模型,档位换成 high(M7 起默认 high,原为 low)
  const memory = fakeMemory();
  const settings = fakeSettings({ mode: { lastMode: 'work', mapping: {} } });
  const controller = fakeController();
  const ctx = fakeCtx({
    agentDefaultModel: { currentSelection: () => ({ ...CUR }) },
    sessionController: controller,
  });
  await applyModeToSession(ctx, fakeGate(), memory, settings, 'sess-2', 'life');
  const req = controller._calls[0] || {};
  eq(req.reasoningEffort, 'high', '生活档位=high');
  eq(req.model, CUR.model, '生活模式同样不改模型');
  eq(settings.get().mode.lastMode, 'work', 'D2 解耦:不传 opts 的会话切换不写 lastMode(仍 work)');
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
  eq(settings.get().mode.lastMode, 'life', 'D2 解耦:模型不可读时同样不写 lastMode(仍 life)');
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 8) M7(E2 · 档位可配)+ M24b · `/mode/toggle` 的门拆分:全局半边「confirm:true + 宿主认证(远端允许)」、会话半边免门
// -------------------------------------------------------------------------------------------
// 判据(M24 改后;ALIGN-v7 §6.3 的 A.3-1…9 + M24 的反转):
//   · A.3-3(**反转**)已定型(persona.sealed=true)+ **无票** + **无承诺句** + defaultOnly+confirm:true
//     ⇒ **ok:true**(全局半边 M24b 起 = confirm:true + 宿主认证,远端也允许),`saveSelection` 恰 1 次、`lastMode` 真的变、
//     `provider/model` 与当前选择逐字相同(`modelKept:true`),且 **surgery.jsonl 行数不变**(全局免门不留痕);
//   · 远端(headers 带 x-forwarded-for / 去掉 UA)+ confirm:true ⇒ **ok:true**(1.7.3 的远端能力不回退;不再有 local-only 闸);
//   · A.3-4 已定型 + **不带 confirm** ⇒ 走**预览**分支(reason=confirmation-required)、0 写 —— 预览分支
//     0 写,故它**先于** confirm 后的写点也不漏写(预览永远不落笔);
//   · A.3-1/2 会话半边**免门**:已定型 + 无票(或错票+错承诺句)+ sessionId ⇒ ok:true,
//     setSessionMode 恰 1 次、**不写全局 lastMode**(D-2 解耦;`mode.js:105` 默认 false + `api.js` 显式 false);
//   · A.3-5 会话档 /state:mode=会话值 而 lastMode=全局默认(两字段分叉);global 档两字段同值;
//   · A.3-6 sealed:false + 无票,两会话都成功;全局预览仍 confirmation-required;
//   · A.3-7 免门**不留痕**:会话切换前后 surgery.jsonl 行数不变;
//   · A.3-8 新会话跟**显式默认**(8a 之后 = life),不跟上次会话切换(work);
//   · A.3-9 会话半边**不走进**空会话刷新循环(桩计数器:增量 0);
//   · 正对照(本机 + confirm:true,全局半边,8d)⇒ 放行并真的写(lastMode 变 work、saveSelection 累计 2 次),
//     且**模型原样带回**(provider/model 与当前选择逐字相同 —— mode.js 顶部铁律);
//   · 会话半边正对照(票 + 原句 + sessionId)⇒ 仍放行,setSessionMode 恰 1 次(免门不是"谁都写不进去")。
// ⚠️ 段序:8a 先把全局 lastMode 顶成 life ⇒ 8b/8b1 的"不写 lastMode"以 life 为基线(8b 第二次会话切换写的
//    是 work:会话半边若偷偷写 lastMode,断言立刻红);8d 再顶回 work ⇒ 8a/8d 都测得出"真的变了"。
// 为什么**不新建测试文件**:package.json 的 test 链里已有本文件(64 段),把这段塞进来
//   ⇒ 段数不变、零 diff;代价是本文件从"纯单测"多一节"端点级"(需要 DSH_HOME 隔离)。
// ⚠️ DSH_HOME 隔离是硬要求:`registerApi()` 一进来就 `rotateSurgeryTicket()`(写一枚每启动票据),
//    不隔离就是真机副作用。隔离做法照抄 tests/branch.test.mjs:300-353。
// ⚠️ 两个不能抄近道的地方:
//   · 不能用 `DSH_LING_GUARD=off` / `settings.guard.enforce=false` 关守卫 —— 同一个开关也是**手术门的
//     逃生开关**(surgery.js surgeryDisabled)⇒ 一关就测不到门;故这里守卫**开着**并如实带齐
//     host/UA/cookie(guard.js 的 checkRequest 三条);
//   · 不能用"只改 lastMode 的假 settings" —— 门读 `settings.get().persona.sealed`,必须是真的
//     SettingsFile(顺带覆盖了"默认值 ⊕ 用户补丁"那条真路径)。
// ⚠️ 两段正对照的**次序**:会话半边正对照(8c)必须在全局半边正对照(8d)之前 —— 8d 会把全局
//     `lastMode` 写成 'work'(它自己的断言),而 8c 的判据是"会话切换后 lastMode **逐字未变**(= 8a 的 life)"。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  const homeTmp = mkdtempSync(join(tmpdir(), 'ling-m7-mode-'));
  const savedHome = process.env.DSH_HOME;
  const savedGuardEnv = process.env.DSH_LING_GUARD;
  process.env.DSH_HOME = join(homeTmp, 'home');
  delete process.env.DSH_LING_GUARD;
  const restoreEnv = () => {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    if (savedGuardEnv === undefined) delete process.env.DSH_LING_GUARD; else process.env.DSH_LING_GUARD = savedGuardEnv;
  };
  try {
    const { registerApi } = await imp('lib/host/api.js');
    const { SettingsFile } = await imp('lib/host/settings-file.js');
    const { expectedCookieName } = await imp('lib/host/guard.js');
    const { readSurgeryTicket } = await imp('lib/host/surgery.js');
    const PHRASE = '这是我在定型时亲手写下的承诺句。';
    const AUTH = '127.0.0.1:3080';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
    const LOCAL_HEADERS = { host: AUTH, 'user-agent': UA, cookie: expectedCookieName(AUTH) + '=1' };

    const settings = new SettingsFile(join(homeTmp, 'data'));
    // 定型 + 把 lastMode 顶到 'work'(不先顶的话真机默认就是 'life',断言"未变"会测不出东西)
    await settings.update({ persona: { sealed: true, sealPhrase: PHRASE }, mode: { lastMode: 'work' } });

    // 假 adm:★ 计数就是本段的命门 —— "拒了但已经写了"只能靠它抓到
    const saves = [];
    const adm = {
      currentSelection: () => ({ ...CUR, reasoningEffort: 'max' }),
      saveSelection: async (sel) => { saves.push(sel); },
    };
    const sessionWrites = [];
    const staleMarks = [];
    // A.3-9 桩计数器:`allSnapshotSessionIds(gate)` 的唯一实现就是 `gate.snapshotIds()`
    //   ⇒ "空会话刷新循环有没有被走进"只能在这里数。会话半边必须 0 次。
    let snapshotIdsCalls = 0;
    const gateStub = {
      recentSessionId: () => 'sess-gate',
      snapshotIds: () => { snapshotIdsCalls += 1; return []; },
      isRunning: () => false,
      pendingCount: () => 0,
      markSnapStale: (sid) => { staleMarks.push(sid); },
      enqueueIfRunning: () => false,
      snapshotOf: () => null,
      markSnap: () => {},
    };
    // session_meta 必须**真能读回**:A.3-5 的会话档 /state 靠 `currentMode` 读它。
    const modes = new Map();
    const memoryStub = {
      hasUserTurns: () => true,
      setSessionMode: (sid, m) => { modes.set(sid, m); sessionWrites.push({ sid, m }); },
      sessionMeta: (sid) => (modes.has(sid) ? { session_id: sid, mode: modes.get(sid) } : null),
      kvSet: () => {},
      kvGet: () => undefined,
    };
    const routes = new Map();
    const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
    const ctx = fakeCtx({ webServer, agentDefaultModel: adm });
    const dispose = registerApi(ctx, { gate: gateStub, memory: memoryStub, settings },
      { surgeryLog: join(homeTmp, 'surgery.jsonl') });
    const PATH = '/api/dsh-ling/mode/toggle';
    check(typeof routes.get(PATH) === 'function', 'M7 /mode/toggle 路由已挂上:' + PATH);

    /** 假 req(EventEmitter 当请求流,readBody 只认 url/method/headers + data/end)/ 假 res(4 个成员)。 */
    const call = async (body, headers) => {
      const req = new EventEmitter();
      req.url = PATH; req.method = 'POST';
      req.headers = { ...LOCAL_HEADERS, ...(headers || {}) };
      req.destroy = () => {};
      const out = {
        statusCode: 0, headers: {}, writableEnded: false, destroyed: false, body: '',
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        end(t) { this.body = String(t ?? ''); this.writableEnded = true; },
      };
      const done = routes.get(PATH)(req, out);
      req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
      req.emit('end');
      await done;
      let json = null;
      try { json = JSON.parse(out.body); } catch { /* 非 JSON 也照测 */ }
      return { out, json };
    };

    // ── 手术留痕读数(「拒绝也留一行」/「免门不留痕」的判据)────────────────────────────
    // `surgeryLog` 由 registerApi 的 deps 显式指到 homeTmp ⇒ 本段只读**这一个**文件。
    const surgeryLogFile = join(homeTmp, 'surgery.jsonl');
    const logLines = () => {
      try { return readFileSync(surgeryLogFile, 'utf8').split('\n').filter((l) => l.trim() !== '').length; }
      catch { return 0; } // 文件还没生成 = 0 行
    };
    const lastLogEvent = () => {
      try { return JSON.parse(readFileSync(surgeryLogFile, 'utf8').trim().split('\n').pop()); }
      catch { return null; }
    };

    /** GET 版假 req(只读 /state 用):无请求体,守卫用的 headers 与 POST 同一份。 */
    const get = async (query) => {
      const route = '/api/dsh-ling/state';
      const req = new EventEmitter();
      req.url = route + (query ? '?' + query : ''); req.method = 'GET';
      req.headers = { ...LOCAL_HEADERS };
      req.destroy = () => {};
      const out = {
        statusCode: 0, headers: {}, writableEnded: false, destroyed: false, body: '',
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        end(t) { this.body = String(t ?? ''); this.writableEnded = true; },
      };
      await routes.get(route)(req, out);
      let json = null;
      try { json = JSON.parse(out.body); } catch { /* 非 JSON 也照测 */ }
      return { out, json };
    };

    // ── 8a) A.3-3(**反转**)全局默认分支:已定型 + 无票 + 无承诺句 + confirm:true ⇒ 照常落笔 ──────
    // M24b 把全局半边从「手术门 + 承诺句」降为「**confirm:true + 宿主认证(远端允许)**」:档位/模型不是人格面,
    //   切换必须"无感" ⇒ 不再要票据、不再要原句,也**不进 surgery-*.jsonl**。
    const logBeforeGlobal = logLines();
    eq(settings.get().mode.lastMode, 'work', '8a 前置:全局默认基线 = work(让"变成 life"可分辨)');
    const globalSave = await call({ defaultOnly: true, mode: 'life', confirm: true });
    eq(globalSave.out.statusCode, 200, 'A.3-3 全局半边 ⇒ 200');
    eq(globalSave.json?.ok, true, 'A.3-3 ★★ 定型 + 无票 + 无承诺句 ⇒ ok:true(M24:全局半边不再过手术门)');
    check(globalSave.json?.surgery === undefined, 'A.3-3 ★★ 回执不带 surgery 拒因(压根没进手术门)');
    eq(globalSave.json?.reason, undefined, 'A.3-3 ★ 不出现 reason=sealed / surgery-*(免门)');
    eq(saves.length, 1, 'A.3-3 ★★ saveSelection 恰 1 次(档位真同步了,不是"拒了但写了")');
    eq(saves[0]?.reasoningEffort, 'high', 'A.3-3 ★ saveSelection 带 life 档位(high)');
    eq(globalSave.json?.modelKept, true, 'A.3-3 ★★ 回执 modelKept:true(模型原样)');
    eq(globalSave.json?.globalDefault, CUR.provider + '/' + CUR.model,
      'A.3-3 ★★ 回执 globalDefault 与当前模型逐字相同');
    eq(saves[0]?.provider, CUR.provider, 'A.3-3 ★★ provider 与当前选择逐字相同(模型原样)');
    eq(saves[0]?.model, CUR.model, 'A.3-3 ★★ model 与当前选择逐字相同(只换 reasoningEffort)');
    eq(settings.get().mode.lastMode, 'life', 'A.3-3 ★★ settings.mode.lastMode 真的变成 life');
    // 「全局免门不留痕」(M24 反转了旧的 MUT-A4「拒绝也留一行」):不过门 ⇒ surgery.jsonl 一行都不加。
    eq(logLines(), logBeforeGlobal, 'A.3-3 ★★ 全局免门不留痕:落笔后 surgery.jsonl 行数不变');

    // ── 8b) A.3-1/A.3-2 会话半边**免门**(rc.4 D-4):已定型 + 无票 ⇒ 照样成功 ────────────
    const logBeforeSess = logLines();
    const snapIdsBefore = snapshotIdsCalls;
    const sessNoTicket = await call({ sessionId: 'sess-probe', mode: 'life', confirm: true });
    eq(sessNoTicket.json?.ok, true, 'A.3-1 ★★ 会话分支无票 ⇒ 成功(会话半边免门)');
    eq(sessNoTicket.json?.reason, undefined, 'A.3-1 ★ 会话分支不出现 reason=sealed(不再被门拦)');
    eq(sessNoTicket.json?.sessionId, 'sess-probe', 'A.3-1 ★ 回执带请求指定的 sessionId');
    eq(sessionWrites.length, 1, 'A.3-1 ★★ memory.setSessionMode 恰 1 次');
    eq(sessionWrites[0]?.sid, 'sess-probe', 'A.3-1 ★ 写入的是请求指定的 sessionId');
    eq(sessionWrites[0]?.m, 'life', 'A.3-1 ★ 会话模式写成请求的 life');
    eq(settings.get().mode.lastMode, 'life', 'A.3-1 ★★ 会话切换**不写**全局 lastMode(D-2 解耦;8a 之后仍 life)');
    eq(logLines(), logBeforeSess, 'A.3-7 ★ 免门不留痕:会话切换后 surgery.jsonl 行数不变');
    eq(snapshotIdsCalls, snapIdsBefore, 'A.3-9 ★★ 会话半边不走进空会话刷新循环(gate.snapshotIds 调用 0 次)');
    // A.3-2:错票 + 错承诺句 ⇒ 仍然成功 —— "免门"是真的免,不是"票对了才免"。
    const sessBadTicket = await call(
      { sessionId: 'sess-probe2', mode: 'work', unlock: '错的承诺句', confirm: true },
      { 'x-dsh-ling-surgery': 'f'.repeat(64) },
    );
    eq(sessBadTicket.json?.ok, true, 'A.3-2 ★★ 错票 + 错承诺句仍成功(免门是真的免)');
    eq(sessionWrites.length, 2, 'A.3-2 ★ setSessionMode 再增 1 次(共 2)');
    eq(settings.get().mode.lastMode, 'life',
      'A.3-2 ★ 仍未写全局 lastMode(本次会话切的是 work:会话半边若偷写 lastMode ⇒ 这里必变 work)');
    eq(logLines(), logBeforeSess, 'A.3-7 ★ 免门不留痕:错票那次同样不留痕');
    eq(snapshotIdsCalls, snapIdsBefore, 'A.3-9 ★★ 会话半边共 2 次请求,空会话刷新循环增量 0 次');

    // ── 8b1a) A.3-5 会话档 /state:mode(会话值)/ lastMode(全局默认)在会话档**分叉** ──────
    // 读 sess-probe2(8b 第二次会话切换写的是 work,而全局 lastMode 是 8a 写的 life)⇒ 两字段必然不同值。
    const stSess = await get('sessionId=sess-probe2');
    eq(stSess.json?.mode, 'work', 'A.3-5 ★★ 会话档 mode=work(会话值)');
    eq(stSess.json?.lastMode, 'life', 'A.3-5 ★★ 会话档 lastMode=life(全局默认)⇒ 两字段分叉');
    eq(settings.get().mode.lastMode, 'life', 'A.3-5 ★ settings.mode.lastMode 逐字仍是 life');
    const stGlobal = await get('scope=global');
    eq(stGlobal.json?.mode, 'life', 'A.3-5 ★ global 档 mode=life');
    eq(stGlobal.json?.lastMode, 'life', 'A.3-5 ★ global 档 lastMode=life(两字段同值;global 档没有会话值)');

    // ── 8b1b) A.3-8 新会话跟**显式默认**,不跟上次会话切换 ─────────────────────────────
    const stNew = await get('sessionId=sess-new');
    eq(stNew.json?.mode, 'life', 'A.3-8 ★★ 新会话模式=life(跟显式默认 8a 写的 life,不跟上次会话切换的 work)');

    // ── 8b2) 预览边界:已定型 + **不带 confirm** ⇒ 预览分支(confirmation-required),0 写 ────────
    // M24 后全局半边**没有门**,但 `confirm !== true` 这一跳仍然 0 写:确认语不在就不动手(rc.4 同一条纪律)。
    // 若有人把 saveSelection / settings.update 挪到确认之前、或删掉预览分支 ⇒ saves/lastMode 立刻红。
    const preview = await call({ defaultOnly: true, mode: 'life' });
    eq(preview.out.statusCode, 200, 'M7 预览仍回 200');
    eq(preview.json?.reason, 'confirmation-required',
      'A.3-4 M7 ★★ sealed + 无 confirm ⇒ 预览(confirmation-required),确认分支仍 0 写');
    eq(preview.json?.applied, 'none', 'A.3-4 M7 ★ 预览 applied=none(不落笔,只念后果)');
    eq(preview.json?.mode, 'life', 'A.3-4 M7 预览回执说明"将要变成什么"(mode=life)');
    check(preview.json?.surgery === undefined, 'A.3-4 M7 ★★ 预览分支不带 surgery 拒因(没有门可拦)');
    eq(saves.length, 1, 'A.3-4 M7 ★★ 预览分支 adm.saveSelection 不增(仍 8a 那 1 次)');
    eq(settings.get().mode.lastMode, 'life', 'A.3-4 M7 ★★ 预览分支 settings.mode.lastMode 未变(仍 life)');

    // ── 8c) 会话半边正对照(票 + 原句 + sessionId ⇒ 仍放行;免门不是"谁都写不进去")─────────
    // ⚠️ 必须排在全局半边正对照(8d)**之前**:8d 会把全局 lastMode 写成 'work',
    //    而本组的判据是"会话切换后 lastMode **逐字未变**(= 8a 写的 life)"。
    const sessPass = await call({ sessionId: 'sess-probe', mode: 'life', confirm: true, unlock: PHRASE },
      { 'x-dsh-ling-surgery': readSurgeryTicket() });
    eq(sessPass.json?.ok, true, 'M7 ★★ 会话分支正对照:票 + 原句 ⇒ 放行(ok=true)');
    eq(sessPass.json?.sessionId, 'sess-probe', 'M7 ★ 回执带请求指定的 sessionId');
    eq(sessionWrites.length, 3, 'M7 ★★ 会话分支放行后 memory.setSessionMode 累计恰 3 次(2 次免门 + 本组)');
    eq(sessionWrites[2]?.sid, 'sess-probe', 'M7 ★ 写入的是请求指定的 sessionId');
    eq(sessionWrites[2]?.m, 'life', 'M7 ★ 会话模式写成请求的 life');
    eq(settings.get().mode.lastMode, 'life', 'M7 会话分支放行后 lastMode 逐字未变(仍 life)');

    // ── 8d) 全局半边正对照:本机 + confirm:true(**无票、无承诺句**)⇒ 放行,且模型原样带回 ─────
    // 8a 已把 lastMode 顶成 life ⇒ 本组把 work 写回去,"真的变了"才可分辨;模型仍然原样。
    const pass = await call({ defaultOnly: true, mode: 'work', confirm: true });
    eq(pass.out.statusCode, 200, 'M7 正对照(全局)⇒ 200');
    eq(pass.json?.ok, true, 'M7 正对照:本机 + confirm:true(无票 / 无原句)⇒ 放行(ok=true)');
    eq(pass.json?.modelKept, true, 'M7 ★★ 回执 modelKept:true');
    eq(saves.length, 2, 'M7 ★★ 正对照:saveSelection 累计 2 次(8a + 本组)');
    const sel = saves[1] || {};
    eq(sel.provider, CUR.provider, 'M7 ★ 模型原样带回:provider = 当前值');
    eq(sel.model, CUR.model, 'M7 ★ 模型原样带回:model = 当前值(模式只换 reasoningEffort)');
    eq(sel.reasoningEffort, 'max', 'M7 ★ work 档位 = max(只换档位,不换模型)');
    eq(settings.get().mode.lastMode, 'work', 'M7 正对照:放行后 lastMode 真的变成 work');

    // ── 8d2) M24b 远端:代理头 / 无 UA 也**不是**障碍;confirm:true 即可切全局默认 ──
    // 1.7.3 的远端能力保持:不再用 readIsLocal 一刀切;宿主认证仍由 guard 负责。
    const logBeforeRemote = logLines();
    const savesBeforeRemote = saves.length;
    const viaProxy = await call({ defaultOnly: true, mode: 'life', confirm: true },
      { 'x-forwarded-for': '127.0.0.1' });
    eq(viaProxy.out.statusCode, 200, 'A.3-3b ★ 带代理头 + confirm:true ⇒ 200(远端允许)');
    eq(viaProxy.json?.ok, true, 'A.3-3b ★★ 远端可切全局默认(不再 403 local-only)');
    eq(viaProxy.json?.reason, undefined, 'A.3-3b ★ 不出现 local-only');
    eq(saves.length, savesBeforeRemote + 1, 'A.3-3b ★ saveSelection +1');
    eq(settings.get().mode.lastMode, 'life', 'A.3-3b ★ lastMode → life');
    const noUa = await call({ defaultOnly: true, mode: 'work', confirm: true }, { 'user-agent': '' });
    eq(noUa.out.statusCode, 200, 'A.3-3b ★ 无 UA + confirm:true ⇒ 200(远端中继不再被拦)');
    eq(noUa.json?.ok, true, 'A.3-3b ★★ 无 UA 也可切');
    eq(saves.length, savesBeforeRemote + 2, 'A.3-3b ★ saveSelection +2');
    eq(settings.get().mode.lastMode, 'work', 'A.3-3b ★ lastMode → work');
    eq(logLines(), logBeforeRemote, 'A.3-3b ★ 免门不留痕:surgery.jsonl 不增');

    // ── 8e) A.3-6 对照组:sealed:false + 无票,两会话都成功(防"拆会话门把半边一起关了")──
    await settings.update({ persona: { sealed: false } });
    const openWrites = sessionWrites.length;
    const open1 = await call({ sessionId: 'sess-open-1', mode: 'life', confirm: true });
    const open2 = await call({ sessionId: 'sess-open-2', mode: 'work', confirm: true });
    eq(open1.json?.ok, true, 'A.3-6 ★ 未定型 + 无票:第一个会话切换成功');
    eq(open2.json?.ok, true, 'A.3-6 ★ 未定型 + 无票:第二个会话切换成功');
    eq(sessionWrites.length, openWrites + 2, 'A.3-6 ★ 两会话各写 1 次会话模式');
    // 全局半边在未定型时也不该被拆坏:同一端点、同一条判据,不带 confirm 仍只回预览、0 写。
    const openPreview = await call({ defaultOnly: true, mode: 'life' });
    eq(openPreview.json?.reason, 'confirmation-required',
      'A.3-6 ★ 未定型时全局半边仍需 confirm(预览分支没被拆坏)');
    eq(saves.length, 4, 'A.3-6 ★ 预览不落笔(saveSelection 仍 4 次 = 8a + 8d + 8d2×2;远端也计入)');
    dispose();
  } finally {
    restoreEnv();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 9) M7(E2 · 档位可配)· 真机默认值(lib/host/persona.js)+ client.js 解锁重试(源级护栏)
// -------------------------------------------------------------------------------------------
// 为什么不能只靠 `resolveModeEffort({}, 'life')`:
//   真机 `settings.get()` = mergeDeep(DEFAULT_SETTINGS, user)(settings-file.js:146)⇒ mapping **恒命中**,
//   只改 mode.js 的 MODE_EFFORT 在真机上是 no-op。故这里钉两件:①DEFAULT_SETTINGS 本身;
//   ②一次**真的 SettingsFile**(零用户补丁)走完整条解析路径 —— 后者才是"真机默认值"的证据。
// client.js 的 UI 行为无法离线跑(要 window/fetch/React),按 CEO-AUTH-M7 §5 只做**源级护栏**:
//   钉住「解锁重试的形状」;有人删掉 unlock / window.prompt / sealed 判断、或把某处调用改回裸
//   postToggle,本段就红。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  eq(DEFAULT_SETTINGS.mode.mapping.life.effort, 'high',
    'M7 ★★ 真机默认 DEFAULT_SETTINGS.mode.mapping.life.effort = high');
  eq(DEFAULT_SETTINGS.mode.mapping.work.effort, 'max', 'M7 真机默认 work 仍是 max');

  // 真机路径:构造一个**没有任何用户补丁**的 SettingsFile ⇒ get() 就是默认值 ⊕ 空用户配置
  const homeTmp = mkdtempSync(join(tmpdir(), 'ling-m7-default-'));
  const { SettingsFile } = await imp('lib/host/settings-file.js');
  const real = new SettingsFile(join(homeTmp, 'data'));
  eq(real.get().mode.mapping.life.effort, 'high', 'M7 ★★ 真机 SettingsFile.get() 的 life 默认 = high');
  eq(resolveModeEffort(real.get(), 'life'), 'high',
    'M7 ★★ 真机 get() 路径:life 解析 = high(不只是 resolveModeEffort({}, life))');
  eq(resolveModeEffort(real.get(), 'work'), 'max', 'M7 真机 get() 路径:work 解析 = max');
  // 用户显式写 low 仍优先(默认值只兜底,绝不覆盖用户的显式选择)
  await real.update({ mode: { mapping: { life: { effort: 'low' } } } });
  eq(resolveModeEffort(real.get(), 'life'), 'low', 'M7 真机 get() 路径:mapping 覆盖优先(显式 low 压过默认 high)');
}

// ── client.js 源级护栏(UI 无法离线跑 ⇒ 只钉形状,**且必须钉在 helper 函数体里**)──────────
// ⚠️ 为什么不再对整份 client.js 做正则(判据 5「护栏不得恒真」,m7-review §六.1):
//   `window.prompt(` 在 :3319(记忆改名)本来就有;`reason === 'sealed'`
//   在 :2100 / :2162 / :2714 / :7034 本来就有 ⇒ 那两条对整个文件的正则**恒真**,删掉整个 helper
//   也照绿(MUTATION-LOG.md:190-197 自证:删 helper 后 7 条红,**恰好不含**这两条)。
//   故:形状断言一律只认 `function postToggleWithUnlock(body)` 到下一个顶层 function 之间的文本;
//   另加一条全文反向护栏抓"极性写反"(m7-review §六.1 要求的 ⑦ 变异)。
{
  const csrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
  // helper 切片:起点找不到 ⇒ helperAt = -1 ⇒ 下面每一条都红(「删除 helper」变异走这条)
  const helperAt = csrc.indexOf('function postToggleWithUnlock(body)');
  const helperEnd = helperAt < 0 ? -1 : csrc.indexOf('\n      function ', helperAt + 1);
  const helperOk = helperAt >= 0 && helperEnd > helperAt;
  check(helperOk, 'M7 ★ client.js 有 postToggleWithUnlock(body) 且函数体边界可定位(删除变异必红)');
  const helper = helperOk ? csrc.slice(helperAt, helperEnd) : '';
  check(/postToggle\(body\)\.then\(/.test(helper),
    'M7 ★ helper 先发不带 unlock 的那一次(confirm:true 的既有流程逐字不动)');
  check(/window\.prompt\(/.test(helper),
    'M7 ★★ helper 内用 window.prompt 问承诺句(不新增 UI 组件;删掉 prompt 必红)');
  check(/r\.reason\s*!==\s*'sealed'/.test(helper),
    'M7 ★★ helper 内是精确否定 r.reason !== \'sealed\'(不接受 [!=]==)');
  check(!/r\.reason\s*===\s*'sealed'/.test(helper),
    'M7 ★★ helper 内无极性反转 reason === \'sealed\'(⑦ 变异必红)');
  check(/unlock:\s*String\(phrase\)\.trim\(\)/.test(helper),
    'M7 ★★ helper 重试时带上 unlock(缺了它 ⇒ 定型用户从面板切模式恒被拒)');
  check(/var b = Object\.assign\(\{\}, body, \{ unlock:/.test(helper),
    'M7 ★ helper 重试 body = 原 body ⊕ unlock(不丢 defaultOnly / confirm)');
  check(/if \(phrase == null\) return r;/.test(helper), 'M7 ★ helper 内取消(prompt=null)= 不重试');
  // 只重试一次 / 无循环:两条都只认 helper 体内 —— 断言名字不再大于能力
  eq((helper.match(/postToggle\(b\)/g) || []).length, 1, 'M7 ★★ helper 内重试调用 postToggle(b) 恰 1 处');
  check(!/\b(for|while|do)\s*\(/.test(helper), 'M7 ★★ helper 体内无 for/while/do 循环(不再靠人眼)');
  // 反向护栏(全文):`reason === 'sealed'` 之后紧跟 `return postToggle(` = 极性写反 ⇒ 红。
  //   260 字窗口按 helper 现形量出来(实测 230 字);`postToggle(` 全文只在 helper 三行里出现。
  check(!/reason\s*===\s*'sealed'[\s\S]{0,260}return postToggle\(/.test(csrc),
    'M7 ★★ 全文无「reason === \'sealed\' ⇒ 再 postToggle」的极性反转(⑦)');
  // toggleMode 里**两处**调用都必须换成 helper(裸 postToggle 只剩 helper 自己那一次)
  const tmStart = csrc.indexOf('function toggleMode(store)');
  const tmEnd = csrc.indexOf('function refreshMemory(store)');
  check(tmStart > 0 && tmEnd > tmStart, 'M7 找得到 toggleMode 函数体');
  const tmBody = csrc.slice(tmStart, tmEnd);
  const tmCalls = (tmBody.match(/postToggleWithUnlock\(/g) || []).length;
  check(tmCalls === 2, 'M7 ★★ toggleMode 的两处调用都走 postToggleWithUnlock(实测 ' + tmCalls + ')');
  check(!/\bpostToggle\(/.test(tmBody), 'M7 ★ toggleMode 内不再有裸 postToggle(');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 10) M21-7(rc.4 · D-1 轻确认)· `/mode/effort` 端点级验收(C.6-1…5,ALIGN-v2 §C.6 / ALIGN-v7 §6.1)
// -------------------------------------------------------------------------------------------
// 判据(RC4-RUNBOOK-v7:44 / RC4-ALIGN-v7:666-686 逐条):
//   · C.6-1 默认设置 GET ⇒ `mode:'life'`(lastMode 口径)、`effort:'high'`(**index 2**;
//     MUT-C6 = 拿 `EFFORTS` 顺序当滑块顺序 ⇒ 这里必红)、`mapping.work==='max'`、`source` 全 `'default'`;
//   · C.6-2 POST {mode:'life', effort:'low', confirmEffort:true} ⇒ 200、`mapping.life.effort==='low'`、
//     **`mapping.work` 逐字未变**(MUT-C1 = 整体替换 mapping ⇒ 必红);
//   · C.6-3 同一请求**不带** `confirmEffort` ⇒ `reason:'confirmation-required'`、`applied:'none'`、0 写
//     (MUT-D4-1 = 删 confirmEffort 分支 ⇒ `updateCalls` 变 1、reason 变别的 ⇒ 必红);
//   · C.6-4 非法值(`effort:'banana'` / `mode:'chaos'`)⇒ 400 + `dropped`;非本机 ⇒ 403 `local-only`;
//     两者都 **0 写**(MUT-D4-2 = 删本机判据 ⇒ 非本机用例实测 200 且写盘 ⇒ 必红);
//   · C.6-5 落笔后 `mode.lastMode` 逐字未变、`saveSelection` 0 次、`/mode/toggle` **调用 0 次**
//     —— 用**桩计数器**(不是源码字符串黑名单,评审 6.5)。
// 另外钉三件结构事实(D-1 / §5.4):**不进** `surgery-*.jsonl`(门不过、留痕 0 行)、
//   进 `POST_ONLY` + `DUAL_METHOD_READ_PATHS`、**不进** `GET_ONLY`;GET 200 / PUT 405(读者半边必须活着)。
// 为什么**不新建测试文件**:package.json 的 test 链里已有本文件;放这里 ⇒ 段数/文件名零 diff。
// ⚠️ DSH_HOME 隔离是硬要求(照抄上面第 8 段:`registerApi()` 会轮换每启动票据;非本机用例会碰手术门面)。
// ⚠️ `updateCalls` 就是"0 写"的唯一可断言形状(ALIGN §6.1 的"0 写的定义"):读 GET 也走它 ⇒ 顺带证明读面纯读。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  const homeTmp = mkdtempSync(join(tmpdir(), 'ling-m21-7-effort-'));
  const savedHome = process.env.DSH_HOME;
  const savedGuardEnv = process.env.DSH_LING_GUARD;
  process.env.DSH_HOME = join(homeTmp, 'home');
  delete process.env.DSH_LING_GUARD;
  const restoreEnv = () => {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
    if (savedGuardEnv === undefined) delete process.env.DSH_LING_GUARD; else process.env.DSH_LING_GUARD = savedGuardEnv;
  };
  try {
    const { registerApi } = await imp('lib/host/api.js');
    const { SettingsFile } = await imp('lib/host/settings-file.js');
    const { expectedCookieName } = await imp('lib/host/guard.js');
    const AUTH = '127.0.0.1:3080';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
    const LOCAL_HEADERS = { host: AUTH, 'user-agent': UA, cookie: expectedCookieName(AUTH) + '=1' };

    // **零用户补丁**的真 SettingsFile ⇒ `get()` = DEFAULT_SETTINGS ⊕ {}。C.6-1 的"默认设置"就是它。
    const settings = new SettingsFile(join(homeTmp, 'data'));
    // ── 0 写的探针:数 `settings.update`(唯一的盘写入口)─────────────────────────────
    let updateCalls = 0;
    const realUpdate = settings.update.bind(settings);
    settings.update = async (patch) => { updateCalls += 1; return realUpdate(patch); };

    // 桩计数器(C.6-5):`saveSelection` 一次都不许发生;`/mode/toggle` 一次都不许被调用。
    const saves = [];
    const adm = {
      currentSelection: () => ({ ...CUR, reasoningEffort: 'max' }),
      saveSelection: async (sel) => { saves.push(sel); },
    };
    const sessionWrites = [];
    const gateStub = {
      recentSessionId: () => 'sess-gate',
      snapshotIds: () => [],
      isRunning: () => false,
      pendingCount: () => 0,
      markSnapStale: () => {},
      enqueueIfRunning: () => false,
      snapshotOf: () => null,
      markSnap: () => {},
    };
    const memoryStub = {
      hasUserTurns: () => true,
      setSessionMode: (sid, m) => { sessionWrites.push({ sid, m }); },
      sessionMeta: () => null,
      kvSet: () => {},
      kvGet: () => undefined,
    };
    const routes = new Map();
    const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
    const ctx = fakeCtx({ webServer, agentDefaultModel: adm });
    const dispose = registerApi(ctx, { gate: gateStub, memory: memoryStub, settings },
      { surgeryLog: join(homeTmp, 'surgery.jsonl') });
    const PATH = '/api/dsh-ling/mode/effort';
    const TOGGLE = '/api/dsh-ling/mode/toggle';
    // /mode/toggle 的**桩计数器**:包在已注册的 guard handler 外面 ⇒ 只数"请求进来了几次",
    // 不复制它的行为(评审 6.5:MUT-C4 / C.6-5 要的是行为计数,不是源码字符串)。
    let toggleCalls = 0;
    const toggleHandler = routes.get(TOGGLE);
    check(typeof toggleHandler === 'function', 'M21-7 前置:/mode/toggle 已注册(桩计数器有着落)');
    routes.set(TOGGLE, (req, res) => { toggleCalls += 1; return toggleHandler(req, res); });
    check(typeof routes.get(PATH) === 'function', 'M21-7 ★ /mode/effort 路由已挂上:' + PATH);

    /** 发一次请求(假 req/res 与第 8 段同一形状;GET 不带体,POST 才 emit data/end)。 */
    const invoke = async (method, body, headers) => {
      const req = new EventEmitter();
      req.url = PATH; req.method = method;
      req.headers = { ...LOCAL_HEADERS, ...(headers || {}) };
      req.destroy = () => {};
      const out = {
        statusCode: 0, headers: {}, writableEnded: false, destroyed: false, body: '',
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        end(t) { this.body = String(t ?? ''); this.writableEnded = true; },
      };
      const done = routes.get(PATH)(req, out);
      if (method === 'POST') {
        req.emit('data', Buffer.from(JSON.stringify(body ?? {})));
        req.emit('end');
      }
      await done;
      let json = null;
      try { json = JSON.parse(out.body); } catch { /* 非 JSON 也照测 */ }
      return { out, json };
    };
    const getEffort = () => invoke('GET');
    const postEffort = (body, headers) => invoke('POST', body, headers);
    const mappingOf = () => JSON.stringify(settings.get().mode.mapping);
    const logLines = () => {
      try { return readFileSync(join(homeTmp, 'surgery.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').length; }
      catch { return 0; } // 文件不存在 = 0 行(本卡的正确形状:不进手术日志)
    };

    // ── 10a) C.6-1 默认设置 GET:mode='life' / effort='high'(index 2)/ work='max' / source 全 default ──
    const g0 = await getEffort();
    eq(g0.out.statusCode, 200, 'C.6-1 GET 默认设置 ⇒ 200');
    eq(g0.json?.ok, true, 'C.6-1 GET 回执 ok:true');
    eq(g0.json?.mode, 'life', 'C.6-1 ★★ 默认 lastMode 口径 = life(不是 currentMode 的会话值)');
    eq(g0.json?.effort, 'high', 'C.6-1 ★★ 默认档位 = high');
    eq((g0.json?.efforts || []).join(','), 'off,low,high,max',
      'C.6-1 ★★ 四档顺序 = off,low,high,max(展示序,不是 mode.js 的 EFFORTS 顺序)');
    eq((g0.json?.efforts || [])[2], 'high', 'C.6-1 ★★ index 2 = high(MUT-C6:拿 EFFORTS 顺序 ⇒ 这里是 low)');
    eq(g0.json?.labels?.high, '深入', 'C.6-1 标签 high=深入');
    eq(g0.json?.labels?.off, '省电', 'C.6-1 标签 off=省电');
    eq(g0.json?.labels?.low, '均衡', 'C.6-1 标签 low=均衡');
    eq(g0.json?.labels?.max, '极致', 'C.6-1 标签 max=极致');
    eq(g0.json?.mapping?.work, 'max', 'C.6-1 ★ mapping.work = max(默认)');
    eq(g0.json?.mapping?.life, 'high', 'C.6-1 ★ mapping.life = high(默认)');
    eq(JSON.stringify(g0.json?.source), JSON.stringify({ work: 'default', life: 'default' }),
      'C.6-1 ★★ source 全 default(未设置 ≠ 用户设过)');
    eq(updateCalls, 0, 'C.6-1 ★★ GET 一个字节都不写盘(updateCalls = 0)');

    // ── 10a2) `mode` 口径的证据:lastMode 顶成 work ⇒ GET 的 mode/effort 跟着变 ─────────────
    // 这一条把"mode 取 lastMode 口径"钉成动态证据(而不是只靠源码那句);同时给后面的
    // "lastMode 逐字未变" 造一个**可分辨的基线**(默认就是 life,'未变'测不出东西)。
    await settings.update({ mode: { lastMode: 'work' } });
    updateCalls = 0;
    const gWork = await getEffort();
    eq(gWork.json?.mode, 'work', 'C.6-1 ★ lastMode=work ⇒ GET 的 mode=work(口径 = settings.mode.lastMode)');
    eq(gWork.json?.effort, 'max', 'C.6-1 ★ lastMode=work ⇒ GET 的 effort=max(该模式的解析值)');
    eq(updateCalls, 0, 'C.6-1 ★ 读面再次 0 写');
    const BASE_MAPPING = mappingOf();
    const BASE_LAST = settings.get().mode.lastMode;
    const logBase = logLines();

    // ── 10b) C.6-3 不带 confirmEffort ⇒ confirmation-required + applied:'none' + 0 写 ────────
    const preview = await postEffort({ mode: 'life', effort: 'low' });
    eq(preview.out.statusCode, 200, 'C.6-3 预览仍是 200(与 /mode/toggle 全局半边同一条纪律)');
    eq(preview.json?.ok, false, 'C.6-3 预览 ok:false(没落笔)');
    eq(preview.json?.reason, 'confirmation-required', 'C.6-3 ★★ reason = confirmation-required');
    eq(preview.json?.applied, 'none', 'C.6-3 ★★ applied = none');
    eq(preview.json?.mode, 'life', 'C.6-3 预览说明"改哪个模式"');
    eq(preview.json?.effort?.from, 'high', 'C.6-3 预览带 from=high');
    eq(preview.json?.effort?.to, 'low', 'C.6-3 预览带 to=low');
    check(typeof preview.json?.message === 'string' && preview.json.message.length > 10,
      'C.6-3 预览带可念给主人听的 message(不是空壳)');
    eq(updateCalls, 0, 'C.6-3 ★★ 预览分支 settings.update 调用 0 次(MUT-D4-1 的证据点)');
    eq(mappingOf(), BASE_MAPPING, 'C.6-3 ★★ 盘上 mode.mapping 逐字未变');
    eq(settings.get().mode.lastMode, BASE_LAST, 'C.6-3 ★ lastMode 逐字未变');
    eq(logLines(), logBase, 'C.6-3 ★ 不进手术日志(预览后 surgery-*.jsonl 行数不变)');

    // ── 10c) C.6-2 confirmEffort:true ⇒ 只写 mode.mapping.<mode>.effort(work 逐字未变)────────
    const saved = await postEffort({ mode: 'life', effort: 'low', confirmEffort: true });
    eq(saved.out.statusCode, 200, 'C.6-2 确认后 200');
    eq(saved.json?.ok, true, 'C.6-2 ★★ 确认后 ok:true');
    eq(saved.json?.applied, 'saved', 'C.6-2 回执 applied=saved');
    eq(updateCalls, 1, 'C.6-2 ★★ 只发生 1 次 settings.update');
    eq(settings.get().mode.mapping.life.effort, 'low', 'C.6-2 ★★ 盘上 mapping.life.effort = low');
    eq(JSON.stringify(settings.get().mode.mapping.work), JSON.stringify({ effort: 'max' }),
      'C.6-2 ★★ mapping.work 逐字未变(MUT-C1:整体替换 mapping ⇒ 这里必红)');
    eq(saved.json?.effective, 'low', 'C.6-2 ★ 回执 effective=low(M22-4 用它回填)');
    eq(saved.json?.to, 'low', 'C.6-2 回执 to=low');
    eq(saved.json?.from, 'high', 'C.6-2 回执 from=high');
    eq(saved.json?.mode, 'life', 'C.6-2 回执 mode=请求的 life');
    eq(logLines(), logBase, 'C.6-2 ★★ 不进手术日志(成功落笔也没写 surgery-*.jsonl,D-1)');
    // 回读:GET 立刻反映新值(life=low),当前模式仍是 work(max),source 只在 life 那侧变 settings
    const gAfter = await getEffort();
    eq(gAfter.json?.mode, 'work', 'C.6-2 ★ 回读的 mode 仍取 lastMode=work(写 life 的档位不切模式)');
    eq(gAfter.json?.effort, 'max', 'C.6-2 ★ 回读 effort 仍是当前模式(work)的 max');
    eq(gAfter.json?.mapping?.life, 'low', 'C.6-2 ★ GET mapping.life = low(落笔真的可读)');
    eq(gAfter.json?.mapping?.work, 'max', 'C.6-2 ★ GET mapping.work 仍是 max');
    eq(gAfter.json?.source?.life, 'settings', 'C.6-2 ★ source.life 变 settings(用户设过)');
    eq(gAfter.json?.source?.work, 'default', 'C.6-2 ★ source.work 仍 default');
    eq(updateCalls, 1, 'C.6-2 ★ 回读 GET 不再写盘(仍 1 次)');

    // ── 10d) C.6-4 非法值 ⇒ 400 + dropped + 0 写(不猜、不降级成 200)─────────────────────
    const beforeBad = mappingOf();
    const badCases = [
      { body: { mode: 'life', effort: 'banana' }, dropped: 'effort', name: "effort:'banana'" },
      { body: { mode: 'chaos', effort: 'low' }, dropped: 'mode', name: "mode:'chaos'" },
      { body: {}, dropped: 'mode,effort', name: '空 body' },
      { body: { mode: 'life', effort: 'LOW' }, dropped: 'effort', name: "大小写不符 effort:'LOW'" },
      { body: { mode: 'life', effort: 2 }, dropped: 'effort', name: 'effort 是数字 2' },
      { body: { mode: 'life', effort: 'low', confirmEffort: 'true' }, dropped: null, name: "confirmEffort:'true'(字符串 ≠ true)" },
    ];
    for (const c of badCases) {
      const r = await postEffort(c.body);
      if (c.dropped === null) {
        // confirmEffort 只认**布尔 true**;字符串 'true' 不当确认 ⇒ 走预览分支、0 写
        eq(r.out.statusCode, 200, 'C.6-4 ' + c.name + ' ⇒ 200(非布尔确认不当确认)');
        eq(r.json?.reason, 'confirmation-required', 'C.6-4 ' + c.name + ' ⇒ reason=confirmation-required');
      } else {
        eq(r.out.statusCode, 400, 'C.6-4 ★ ' + c.name + ' ⇒ 400');
        eq(r.json?.ok, false, 'C.6-4 ' + c.name + ' ⇒ ok:false');
        eq((r.json?.dropped || []).join(','), c.dropped, 'C.6-4 ★ ' + c.name + ' ⇒ dropped 精确点名');
        eq(r.json?.error, 'bad-value', 'C.6-4 ' + c.name + ' ⇒ error=bad-value');
      }
    }
    eq(updateCalls, 1, 'C.6-4 ★★ 以上非法/半非法请求全部 0 写(updateCalls 仍 1)');
    eq(mappingOf(), beforeBad, 'C.6-4 ★★ 盘上 mapping 逐字未变');

    // ── 10e) C.6-4 非本机 ⇒ 403 local-only 且 0 写(MUT-D4-2 的证据点)──────────────────────
    // 两种"非本机"指纹(判据本体 surgery.js:182 `isLocalSurgeryRequest`):①带代理头 ②无 UA。
    // ⚠️ XFF 必须填**loopback**(127.0.0.1):填公网地址会被 guardVerdict 以 spoofed-loopback-host 先拒,
    //    那样测到的就不是本端点的闸了(反代在本机时的真形状就是 XFF=127.0.0.1)。
    const beforeNonLocal = mappingOf();
    const viaProxy = await postEffort({ mode: 'life', effort: 'off', confirmEffort: true },
      { 'x-forwarded-for': '127.0.0.1' });
    eq(viaProxy.out.statusCode, 403, 'C.6-4 ★★ 带代理头 + confirmEffort:true ⇒ 403');
    eq(viaProxy.json?.reason, 'local-only', 'C.6-4 ★★ 403 reason = local-only');
    eq(viaProxy.json?.ok, false, 'C.6-4 非本机回执 ok:false');
    const noUa = await postEffort({ mode: 'life', effort: 'off', confirmEffort: true }, { 'user-agent': '' });
    eq(noUa.out.statusCode, 403, 'C.6-4 ★★ 无 UA ⇒ 403(远端中继的指纹)');
    eq(noUa.json?.reason, 'local-only', 'C.6-4 ★★ 无 UA 的 403 reason = local-only');
    eq(updateCalls, 1, 'C.6-4 ★★ 非本机 0 写(MUT-D4-2:删本机判据 ⇒ 这里变 2 且 200)');
    eq(mappingOf(), beforeNonLocal, 'C.6-4 ★★ 非本机两次请求后 mapping 逐字未变');
    eq(settings.get().mode.mapping.life.effort, 'low', 'C.6-4 ★ life 仍是上一步写的 low(没被 off 顶掉)');

    // ── 10f) C.6-5 落笔的副作用面:lastMode / saveSelection / /mode/toggle 全 0 ─────────────
    eq(settings.get().mode.lastMode, BASE_LAST, 'C.6-5 ★★ mode.lastMode 逐字未变(仍 ' + BASE_LAST + ')');
    eq(saves.length, 0, 'C.6-5 ★★ adm.saveSelection 调用 0 次(不碰平台默认)');
    eq(sessionWrites.length, 0, 'C.6-5 ★★ memory.setSessionMode 调用 0 次(不切模式)');
    eq(toggleCalls, 0, 'C.6-5 ★★ /mode/toggle 调用 0 次(桩计数器;MUT-C4 必红)');
    eq(logLines(), logBase, 'C.6-5 ★★ 全程不进手术日志(0 行)');

    // ── 10g) 结构事实:POST_ONLY + DUAL_METHOD_READ_PATHS、不进 GET_ONLY、不过手术门、GET200/PUT405 ──
    const putRes = await invoke('PUT', undefined);
    eq(putRes.out.statusCode, 405, '§5.4-6 ★ PUT /mode/effort ⇒ 405(写面只许 POST)');
    eq(putRes.json?.want, 'POST', '§5.4-6 ★ 405 回执 want=POST');
    const delRes = await invoke('DELETE', undefined);
    eq(delRes.out.statusCode, 405, '§5.4-6 ★ DELETE /mode/effort ⇒ 405');
    const gAlive = await getEffort();
    eq(gAlive.out.statusCode, 200, '§5.4-6 ★★ GET 仍 200(MUT-D4-4:漏进 DUAL_METHOD_READ_PATHS ⇒ 这里变 405)');

    const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
    const postBlock = apiSrc.match(/const POST_ONLY = new Set\(\[([\s\S]*?)\]\);/);
    const dualBlock = apiSrc.match(/const DUAL_METHOD_READ_PATHS = new Set\(\[([^\]]*)\]\)/);
    const getBlock = apiSrc.match(/const GET_ONLY = new Set\(\[([\s\S]*?)\]\);/);
    check(!!postBlock && !!dualBlock && !!getBlock, 'M21-7 前置:三张表都能从 api.js 源码里定位');
    check(String(postBlock && postBlock[1] || '').includes("'/mode/effort'"),
      'M21-7 ★★ `/mode/effort` 在 api.js 的 POST_ONLY 里');
    check(String(dualBlock && dualBlock[1] || '').includes("'/mode/effort'"),
      'M21-7 ★★ `/mode/effort` 在 DUAL_METHOD_READ_PATHS 里(GET 半边靠它放行)');
    check(!String(getBlock && getBlock[1] || '').includes("'/mode/effort'"),
      'M21-7 ★★ `/mode/effort` **不在** GET_ONLY 里(否则 POST 被自己的读面闸 405)');
    const at = apiSrc.indexOf("disposers.push(register('/mode/effort'");
    const tail = at < 0 ? '' : apiSrc.slice(at);
    const endAt = tail.indexOf('\n    }));');
    const bodySrc = at < 0 ? '' : tail.slice(0, endAt);
    check(at > 0 && endAt > 0, 'M21-7 前置:端点源码块可切片');
    check(!/gateSurgery\(/.test(bodySrc), 'M21-7 ★★ 端点内不调 gateSurgery(门级别 = 轻确认 + 仅本机)');
    check(!/surgeryLog/.test(bodySrc), 'M21-7 ★★ 端点内不碰 surgeryLog(不进 surgery-*.jsonl,D-1)');
    eq((bodySrc.match(/settings\.update\(/g) || []).length, 1,
      'M21-7 ★★ 端点内 settings.update 恰 1 处(唯一写点)');
    check(/readIsLocal\(req\)/.test(bodySrc), 'M21-7 ★ 端点内用 readIsLocal 判本机(判据本体在 surgery.js)');
    dispose();
  } finally {
    restoreEnv();
  }
}

console.log(ok ? 'mode 层(只改档位不改模型)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
