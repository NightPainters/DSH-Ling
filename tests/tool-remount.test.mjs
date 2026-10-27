// 器灵 · 1.7 热重载后「存量 agent 工具不补绑」的隔离回归(桩层红/绿)
//
// 复现的缺口(真机 + 探针):插件热重载时,**仍然活着**的 agent 不会再收到 `agent/created`,
// 于是它 scope 里的器灵工具一件都不在(全局那份又被 preset 的 restrict 掩码过滤掉)。
// 修复后:装载时「先挂监听 → 再枚举 `ctx.agents.list()` 补绑」,身份按 agent ctx 对象去重,
// 卸载即清自己,`agents` 服务迟到走 `ctx.inject(['agents'])`。
//
// 边界:本文件是**桩层**回归(自建 tools/agents/events/effect 服务),不实例化真实宿主 Tools;
// 真实 Cordis + 真实 Tools 过滤由主线另做复验。用完自建临时目录,import 前隔离 home,不用 exit(0)。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── 0) 任何插件模块 import 之前,先隔离三个 home 变量 ────────────────────────────────
const workdir = mkdtempSync(join(tmpdir(), 'ling-remount-'));
const savedEnv = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
for (const key of ['DSH_HOME', 'HOME', 'USERPROFILE']) process.env[key] = workdir;

let assertions = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions += 1; };
const yes = (value, label) => { assert.ok(value, label); assertions += 1; };

const { apply } = await import('../lib/index.js');
const { createAgentToolBinder, agentIdentity, AGENT_TOOL_EVENTS } = await import('../lib/host/agent-tools.js');
const { LibraryRuntime } = await import('../lib/host/library-runtime.js');

// 句柄泄漏/关闭与否用"旧闭包还能不能干活"和 close 计数两条独立证据,不靠退出时间。
let libraryCloses = 0;
const realClose = LibraryRuntime.prototype.close;
LibraryRuntime.prototype.close = function patchedClose(...a) { libraryCloses += 1; return realClose.apply(this, a); };

const hosts = [];
const dirs = [];
const makeDataDir = (tag) => { const dir = mkdtempSync(join(workdir, `${tag}-`)); dirs.push(dir); const data = join(dir, 'data'); mkdirSync(data); return data; };

/** 一个 agent:注册发生在它**自己的** ctx 上;这个 ctx 跨插件重载存活(真机就是这样)。 */
function makeAgent(sid) {
  const scoped = new Map();
  let calls = 0;
  const ctx = {
    tools: {
      register(spec) {
        calls += 1;
        scoped.set(spec.name, spec);
        return () => { if (scoped.get(spec.name) === spec) scoped.delete(spec.name); };
      },
    },
    get(name) { return name === 'tools' ? this.tools : undefined; },
    on() { return () => {}; },
  };
  return { agent: { session: { id: sid }, ctx }, ctx, scoped, calls: () => calls };
}

/** 桩宿主:一次插件装载一个 ctx;tools/webServer/skills/systemPrompt 是桩,agents 可选。 */
function makeHost({ agents = null } = {}) {
  const globalTools = new Map();
  const routes = new Map();
  const listeners = new Map();
  const effects = [];
  const injects = [];
  const services = {
    tools: { register(spec) { globalTools.set(spec.name, spec); return () => { if (globalTools.get(spec.name) === spec) globalTools.delete(spec.name); }; } },
    webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path); }; } },
    skills: { register() { return () => {}; } },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
  };
  if (agents) services.agents = agents;
  const provided = new Map();
  const ctx = {
    get: (name) => services[name] ?? provided.get(name),
    provide(name, value) { provided.set(name, value); return () => { provided.delete(name); }; },
    on(name, cb) {
      const set = listeners.get(name) ?? new Set();
      set.add(cb); listeners.set(name, set);
      return () => { set.delete(cb); };
    },
    effect(factory) { const d = factory(); effects.push(d); return d; },
    inject(deps, cb) { injects.push({ deps, cb }); return () => { const i = injects.findIndex((e) => e.cb === cb); if (i >= 0) injects.splice(i, 1); }; },
  };
  const host = {
    ctx, globalTools, routes, listeners, injects,
    fire: (name, payload) => { for (const cb of [...(listeners.get(name) ?? [])]) cb(payload); },
    fireInject: (index, child) => { injects[index].cb(child); },
    listenerCount: (name) => (listeners.get(name) ?? new Set()).size,
    async dispose() { await Promise.all(effects.map((fn) => (typeof fn === 'function' ? fn() : undefined))); },
  };
  hosts.push(host);
  return host;
}

const mount = (host, dataDir) => apply(host.ctx, {
  dataDir, library: { enabled: true }, accessLog: { enabled: false },
  summarizeAuto: false, feedbackAuto: false, deepSummaryAuto: false,
});
const searchOf = async (scoped, q = 'probe-only') => scoped.get('library_search').execute({ q }, {});

try {
  // ── 1) 存量 agent 跨卸载/重装:没有 created 事件也要补绑;旧闭包必须已关、新搜索必须可用 ──
  console.log('1) 存量 agent 跨卸载重装(全程不发 created 事件)');
  {
    const dataDir = makeDataDir('s1');
    const survivor = makeAgent('surviving-agent');
    const registry = { list: () => [survivor.agent] };
    const first = makeHost({ agents: registry });
    mount(first, dataDir);
    eq(first.globalTools.size, 11, '首次装载:全局注册 11 件工具');
    eq(survivor.scoped.size, 11, '存量 agent 在**没有 created 事件**时被枚举补绑(修复点)');
    eq(survivor.calls(), 11, '恰好注册 11 件,没有重复注册');
    // 监听数按"装载后有"判(别的模块也用 agent/* 事件,不能钉死绝对值);
    // "binder 自己每个事件名恰好挂一个"在 §5 用纯 binder 直测。
    yes(first.listenerCount(AGENT_TOOL_EVENTS[0]) >= 1, 'agent/created 监听已挂');
    yes(first.listenerCount(AGENT_TOOL_EVENTS[1]) >= 1, 'agent/session-start 监听已挂(旧 cohort 兼容)');
    const oldSearch = survivor.scoped.get('library_search');
    eq((await oldSearch.execute({ q: 'probe-only' }, {})).ok, true, '首次补绑的工具可用');

    await first.dispose();
    eq(survivor.scoped.size, 0, '卸载撤销 agent 作用域注册(不留持有旧 runtime 的闭包)');
    eq(first.globalTools.size, 0, '卸载撤销全局注册');
    eq(first.routes.size, 0, '卸载释放路由');
    const dead = await oldSearch.execute({ q: 'probe-only' }, {});
    eq(dead.ok, false, '旧闭包指向已关闭的 runtime(所以"留着旧注册"不是选项)');
    eq(dead.reason, 'closed', '旧闭包 reason=closed');

    const second = makeHost({ agents: registry });
    mount(second, dataDir);                       // 同一个 agent 对象、同一个 ctx,依然没有 created
    eq(second.globalTools.size, 11, '重装:全局 11 件');
    eq(survivor.scoped.size, 11, '重装后存量 agent 被重新补绑');
    eq((await searchOf(survivor.scoped)).ok, true, '重绑后的搜索走**新** runtime');
    await second.dispose();
    eq(survivor.scoped.size, 0, '第二次卸载同样清干净');
  }

  // ── 2) 重复枚举 / 双事件名同发:都不许重复注册;新 agent 照常绑 ──
  console.log('2) 重复枚举与双事件去重(身份 = agent ctx 对象)');
  {
    const dataDir = makeDataDir('s2');
    const one = makeAgent('dedup-1');
    const registry = { list: () => [one.agent] };
    const host = makeHost({ agents: registry });
    mount(host, dataDir);
    eq(one.calls(), 11, '枚举一次 = 11 件');
    host.fire('agent/created', { agent: one.agent });
    eq(one.calls(), 11, '同一 agent 再收 created:不重复注册');
    host.fire('agent/session-start', { agent: one.agent });
    eq(one.calls(), 11, '两个事件名同发:仍不重复注册');
    host.fire('agent/created', { agent: one.agent, source: 'tick' });
    eq(one.calls(), 11, '第三次事件也不重复');
    const later = makeAgent('dedup-later');
    registry.list = () => [one.agent, later.agent];
    host.fire('agent/created', { agent: later.agent });
    eq(later.calls(), 11, '之后新建的 agent 走事件照常绑上(去重不误伤新 agent)');
    await host.dispose();
    eq(one.scoped.size + later.scoped.size, 0, '卸载后两个 agent 的注册都撤销');
  }

  // ── 3) 同一个 sid 的两个 agent:必须各绑各的(旧的 3 秒 sid 窗口会把第二个吞掉) ──
  console.log('3) 同 sid 不同 agent 分别绑');
  {
    const dataDir = makeDataDir('s3');
    const a = makeAgent('same-sid');
    const b = makeAgent('same-sid');
    const host = makeHost({ agents: { list: () => [a.agent, b.agent] } });
    mount(host, dataDir);
    eq(a.scoped.size, 11, '第一个 agent 绑上 11 件');
    eq(b.scoped.size, 11, '同 sid 的第二个 agent 也绑上 11 件(各绑各的)');
    yes(a.ctx !== b.ctx, '前提:两个 agent 的 ctx 是不同对象');
    await host.dispose();
    eq(a.scoped.size + b.scoped.size, 0, '两个都撤销');
  }

  // ── 4) 缺 agents 服务 + 迟到:不抛错、不静默、走既有 inject;卸载后禁止回绑 ──
  console.log('4) agents 服务缺席/迟到;卸载后禁止回绑');
  {
    const dataDir = makeDataDir('s4');
    const late = makeAgent('late-agent');
    const host = makeHost({ agents: null });
    mount(host, dataDir);                       // 不许抛
    eq(late.scoped.size, 0, '服务缺席时没有乱绑');
    // 别的模块(skill 等)也用 ctx.inject,所以只挑 deps 恰为 ['agents'] 的那一次
    const agentInjects = host.injects.filter((i) => Array.isArray(i.deps) && i.deps.length === 1 && i.deps[0] === 'agents');
    eq(agentInjects.length, 1, '缺席时恰好挂了一次 ctx.inject([\'agents\']) 接续(不是全库轮询)');
    // 抓住回调本身而不是槽位号:卸载时 cordis 会把那次 inject 撤销(这里由 stub 的 disposer 模拟),
    // 槽位会移位 —— 而且"卸载后回调就算被调用也必须拒绝"本来就是要测的东西。
    const agentInjectCb = agentInjects[0].cb;
    yes(typeof agentInjectCb === 'function', '拿到 agents inject 回调');
    eq(host.globalTools.size, 11, '全局工具不受影响');
    agentInjectCb({ agents: { list: () => [late.agent] } });
    eq(late.scoped.size, 11, 'agents 迟到后补绑存量 agent');
    eq(late.calls(), 11, '迟到补绑也是 11 件');
    agentInjectCb({ agents: { list: () => [late.agent] } });
    eq(late.calls(), 11, 'inject 回调重复触发不重复注册');
    await host.dispose();
    eq(late.scoped.size, 0, '卸载撤销');
    host.fire('agent/created', { agent: late.agent });
    eq(late.calls(), 11, '卸载后事件不再回绑');
    agentInjectCb({ agents: { list: () => [late.agent] } });
    eq(late.calls(), 11, '卸载后 inject 回调也不再回绑');
  }

  // ── 5) binder 直测:部分失败/抛错/无 ctx/身份判定/不绕过 guard ──
  console.log('5) binder 直测:部分失败不静默 + 身份 + 不绕过 guard');
  {
    eq(AGENT_TOOL_EVENTS, ['agent/created', 'agent/session-start'], '两个事件名与 lifecycle 同套口径');

    // install():binder 自己每个事件名恰好挂 1 个监听,且幂等、卸载能摘掉
    const installed = new Map();
    const listenerHost = {
      on(name, cb) { const set = installed.get(name) ?? new Set(); set.add(cb); installed.set(name, set); return () => set.delete(cb); },
      get: () => undefined, inject: () => () => {},
    };
    const installBinder = createAgentToolBinder({ ctx: listenerHost, register: () => ({ ok: true, disposers: [] }), deps: {}, onNote: () => {} });
    installBinder.install();
    eq(installed.get('agent/created').size, 1, 'binder 给 agent/created 挂且只挂 1 个');
    eq(installed.get('agent/session-start').size, 1, 'binder 给 agent/session-start 挂且只挂 1 个');
    installBinder.install();
    eq(installed.get('agent/created').size, 1, 'install() 幂等,不重复挂');
    await installBinder.dispose();
    eq(installed.get('agent/created').size, 0, 'dispose 摘掉自己挂的监听');
    eq(installed.get('agent/session-start').size, 0, 'dispose 摘掉另一个事件名的监听');
    const agentCtx = { on() {}, get() {} };
    eq(agentIdentity({ session: { id: 'x' }, ctx: agentCtx }), agentCtx, 'Agent → 它的 ctx');
    eq(agentIdentity(agentCtx), agentCtx, '裸 ctx → 它自己');
    eq(agentIdentity({ session: { id: 'x' } }), null, '没有 ctx 的对象 → null');
    eq(agentIdentity(null), null, 'null → null');
    eq(agentIdentity({ ctx: { not: 'a ctx' } }), null, '`.ctx` 不是 Context → null(不许拿错对象当身份)');

    const notes = [];
    const shortCtx = { on() {}, get() {} };
    const rawCalls = [];
    const identityCtx = { on() {}, get() {}, tools: { register() { rawCalls.push(1); return () => {}; } } };
    const binder = createAgentToolBinder({
      ctx: { on: () => () => {}, get: () => undefined, inject: () => () => {} },
      register: () => ({ ok: true, disposers: [() => {}] }),   // 只回 1 件(模拟少注册)
      deps: {},
      expectedToolCount: 10,
      onNote: (level, message, data) => notes.push({ level, message, data }),
    });
    const partial = binder.bindOne({ session: { id: 'short' }, ctx: shortCtx });
    eq(partial.reason, 'partial', '只注册到 1/10 ⇒ 明确记 partial,不当全成功');
    eq(binder.status().partial, 1, 'status 里能看见 partial');
    yes(notes.some((n) => n.level === 'warn' && /只注册到 1\/10/.test(n.message)), 'partial 有明确告警留痕');

    // 没有可绑 ctx:点名失败,不静默
    const noCtx = binder.bindOne({ session: { id: 'no-ctx' } });
    eq(noCtx.reason, 'no-agent-context', '没有 agent ctx 的载荷点名失败');
    eq(binder.status().failures.some((f) => f.reason === 'no-agent-context'), true, '失败进 status.failures');

    // register 抛错 / 回 ok:false:都不许标记成已绑
    const throwing = createAgentToolBinder({
      ctx: {}, register: () => { throw new Error('boom'); }, deps: {}, onNote: () => {},
    });
    eq(throwing.bindOne({ session: { id: 't' }, ctx: { on() {}, get() {} } }).reason, 'register-threw', 'register 抛错被接住');
    eq(throwing.status().bound, 0, '抛错不算绑上');
    const refusing = createAgentToolBinder({
      ctx: {}, register: () => ({ ok: false, reason: 'no-tools' }), deps: {}, onNote: () => {},
    });
    eq(refusing.bindOne({ session: { id: 'r' }, ctx: { on() {}, get() {} } }).reason, 'no-tools', 'register 回 ok:false 时透出原因');
    eq(refusing.status().bound, 0, 'ok:false 不算绑上(不得把"缺工具"当全成功)');

    // 不绕过 guard:binder 只调注入的 register,绝不自己碰 ctx.tools.register
    const spy = createAgentToolBinder({ ctx: {}, register: () => ({ ok: true, disposers: [() => {}] }), deps: {}, onNote: () => {} });
    spy.bindOne({ session: { id: 'guard' }, ctx: identityCtx });
    eq(rawCalls.length, 0, 'binder 不直接调 ctx.tools.register(注册必须走 registerLingTools 的 guard)');
    eq(spy.status().bound, 1, '走过的这一件被记为已绑');

    // 已绑过的身份:already,不再注册
    const again = spy.bindOne({ session: { id: 'guard' }, ctx: identityCtx });
    eq(again.reason, 'already', '同身份再绑 = already(不重复注册)');
    eq(spy.status().already, 1, 'already 计数可见');

    // ── 1.7.3 U1:子代理在**注册期**就被挡掉(宿主掩码无解,只能在这里判) ──
    // 依据:`dsh-tools/lib/index.js:2987` "scoped registrations remain visible",
    // :3069 只过滤继承层;对 scope-local 名下 deny 直接抛错(:2986-3003)。
    const subCalls = [];
    const subBinder = createAgentToolBinder({
      ctx: {}, register: (id) => { subCalls.push(id); return { ok: true, disposers: [() => {}] }; }, deps: {}, onNote: () => {},
    });
    const skipped = subBinder.bindOne({ session: { id: 's1', header: { origin: 'subagent' } }, ctx: { on() {}, get() {} } });
    eq(skipped.reason, 'subagent-skip', '子代理被挡在注册之前');
    eq(skipped.ok, true, '跳过不算失败(与 already 同形,调用方无需改)');
    eq(subCalls.length, 0, '子代理真的没走 register(不是注册完再撤销)');
    eq(subBinder.status().subagentSkipped, 1, 'status 里看得见跳过计数');
    eq(subBinder.status().bound, 0, '跳过不计入已绑');
    eq(subBinder.bindOne({ session: { id: 's2', header: { delegationDepth: 1 } }, ctx: { on() {}, get() {} } }).reason, 'subagent-skip', 'delegationDepth 也算子代理');
    eq(subBinder.bindOne({ session: { id: 'f1', header: { parentSession: 'top' } }, ctx: { on() {}, get() {} } }).reason, 'bound', 'fork 照常绑(fail-open,不误伤主人的并行工作线)');
    eq(subBinder.bindOne({ session: { id: 'u1' }, ctx: { on() {}, get() {} } }).reason, 'bound', '取不到 header 的裸 ctx 照常绑(宿主测试桩不得被误伤)');

    // 卸载:清空绑定表 + 禁止回绑
    await spy.dispose();
    eq(spy.status().bound, 0, 'dispose 清空绑定表(零留)');
    eq(spy.bindOne({ session: { id: 'guard' }, ctx: identityCtx }).reason, 'disposed', '卸载后拒绝回绑');
    eq(spy.status().refusedAfterDispose, 1, '拒绝次数可见');
    eq(spy.status().stopping, true, 'stopping 锁死');
  }

  // ── 6) 归拢:所有宿主卸载后,资源面归零 ──
  console.log('6) 全场景卸载后资源归零');
  {
    for (const host of hosts) await host.dispose();          // 幂等:重复卸载不出错
    eq(hosts.every((h) => h.globalTools.size === 0), true, '所有宿主的全局工具表为空');
    eq(hosts.every((h) => h.routes.size === 0), true, '所有宿主的注册表为空');
    eq(libraryCloses >= 4, true, `每个装载的 LibraryRuntime 都被 close(实测 ${libraryCloses} 次)`);
  }

  console.log(`\nPASS tool-remount: ${assertions} assertions`);
} finally {
  for (const host of hosts) { try { await host.dispose(); } catch { /* 已记录 */ } }
  LibraryRuntime.prototype.close = realClose;
  for (const key of ['DSH_HOME', 'HOME', 'USERPROFILE']) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  rmSync(workdir, { recursive: true, force: true });   // 只删自建目录
}
