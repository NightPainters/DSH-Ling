// 器灵 · agent 作用域工具的**存量补绑**(1.7 热重载缺口修复 · 隔离副本)
//
// ── 症状(真机 + 隔离探针都复现过)────────────────────────────────────────────────
// agent 作用域的那一份工具只在 `agent/created` / `agent/session-start` 事件里注册。
// 插件热重载时,已经活着的 agent **不会再收到 created 事件** ⇒ 新插件的 scope 里一件工具都没有;
// 而全局那份又被 agent preset 的 `restrict({allow:[…]})` 掩码挡在可见面之外
// (规则实读:`dsh-tools/lib/index.js:2959-2977`,`layers.every(layer => layer.admits(name))`
//  过滤继承层,`own` 那一份再 append)⇒ 表现就是"器灵的工具从清单里消失"。
//
// ⚠️ 不能靠"卸载时别撤销旧注册"来绕过:旧注册的闭包持有**已关闭**的 LibraryRuntime,
//    留着它等于把工具接到一具尸体上(搜索会回 `reason:'closed'`)。正确做法是**重绑新的**。
//
// ── 本模块的做法(用已核的真实宿主接口)──────────────────────────────────────────
// 1. **先挂监听,再枚举存量**:`install()` 挂事件 → `bindExisting()` 走
//    `ctx.agents.list()`(实读 `dsh-agent/lib/index.js:612-614`:`return [...this.store.values()]
//    .map((entry) => entry.agent);`,每次都回**新数组**)补绑。中间新创建的 agent 不会漏。
// 2. **身份 = agent/context 对象**(`agent.ctx`,见 `dsh-agent` 类型声明 L148-149:
//    "Agent-scoped context; its contributions are agent-local, unwind on disposal, and reject
//    registration afterward."),**不是**会话 id + 3 秒时间窗 —— 同一个 sid 的两个不同 agent
//    必须各绑各的;同一次创建的两个事件名必须只绑一次。
// 3. **注册只走 registerLingTools**(注入进来的 `register`):内部的 `guard()`(含
//    lossless、参数校验)**不许绕过**;本模块不直接碰 `ctx.tools.register`。
// 4. **部分失败不静默**:`registerLingTools` 对单个 spec 的注册失败只 `console.debug` 并少一个
//    disposer(实读 `tools.js:1628-1639`:`return { ok: disposers.length > 0, disposers }`),
//    所以这里额外拿**全局注册的工具数**当基准,数量不足 ⇒ 明确记 `partial`,不算全成功。
// 5. **延迟/缺席的服务**:`agents` 服务尚未挂载时走既有 `ctx.inject(['agents'], cb)`
//    (与 entry 里 tools 的接续方式同一套路),不造枚举 API、不起"全库轮询"定时器。
// 6. **卸载即清自己**:`dispose()` 撤销本实例注册的全部工具并清空绑定表;
//    之后 `stopping` 锁死,任何事件/inject 回调都不再回绑。

import { pick, sessionKind } from './util.js';

/** 两个跨 cohort 的事件名(与 lifecycle.js 同一套口径,不另发明)。 */
export const AGENT_TOOL_EVENTS = ['agent/created', 'agent/session-start'];

/**
 * 一个值"能不能在上面注册工具"= 它是不是一个可用的 ctx。
 * ⚠️ 判据必须比"有 on + 有 get"宽:宿主/测试里的 agent ctx 最小形态可能**只有** `tools.register`
 *    (实读主线 `tests/library-runtime.test.mjs:151` 的桩就是 `{ tools: { register } }`)——
 *    拿 on/get 当门槛会把这种合法 ctx 判成"没有 ctx",于是工具不绑、断言当场红。
 */
const canRegister = (v) => !!v && typeof v === 'object'
  && ((!!v.tools && typeof v.tools.register === 'function') || typeof v.get === 'function');

/**
 * 取"该绑在谁身上"的身份对象。
 *
 * 顺序(有讲究):
 *   ① 形状像 Agent(`{ session, ctx }`,Agent 自己**不可注册**)⇒ 用它的 `ctx`
 *      (实读 `dsh-agent` 类型声明 L148-149:agent-scoped context)。
 *   ② 它自己就可注册 ⇒ 用它自己(裸 `payload.agentCtx`,以及原生 Context:
 *      **不要**先去读 `.ctx`,原生 Context 上的 `.ctx` 可能指回别处,会把不同 agent 判成同一个身份)。
 *   ③ 兜底再用 `.ctx`。
 */
export function agentIdentity(target) {
  if (!target || typeof target !== 'object') return null;
  const nested = target.ctx;
  if (nested && typeof nested === 'object' && nested !== target && canRegister(nested) && !canRegister(target)) return nested;
  if (canRegister(target)) return target;
  if (nested && typeof nested === 'object' && canRegister(nested)) return nested;
  return null;
}

/** 仅用于日志/留痕的会话 id(失败信息要能指认是谁);不参与去重。 */
function sessionIdOf(target) {
  try {
    const sid = pick(
      () => target?.session?.id,
      () => target?.agent?.session?.id,
      () => target?.id,
    );
    return sid === undefined ? '' : String(sid);
  } catch { return ''; }
}

/**
 * 建一个补绑器。
 * @param {object} options
 * @param {object} options.ctx        插件 ctx(挂在它上面的 `agents` 服务/事件/inject)
 * @param {Function} options.register registerLingTools(注入,便于测试;不许换成裸注册)
 * @param {object} [options.deps]     传给 register 的依赖(含**本次装载**的 library 实例)
 * @param {Function} [options.isDisposed] 入口是否已进入卸载
 * @param {number|Function} [options.expectedToolCount] 全局注册到的工具数(0 = 不校验数量)
 * @param {Function} [options.onNote] (level, message, data) => void,留痕用(写入入口的 kv)
 */
export function createAgentToolBinder({
  ctx,
  register,
  deps = {},
  isDisposed = () => false,
  expectedToolCount = 0,
  onNote = () => {},
} = {}) {
  /** 身份对象 → 绑定记录。用 Map(不是 WeakMap):卸载时要能逐一撤销并清空。 */
  const bound = new Map();
  const failures = [];
  const ownDisposers = [];
  let installed = false;
  let stopping = false;
  let listed = 0;
  let already = 0;
  let subagentSkipped = 0;
  let refusedAfterDispose = 0;
  let serviceAvailable = false;
  let injectHooked = false;

  const expected = () => {
    const n = typeof expectedToolCount === 'function' ? expectedToolCount() : expectedToolCount;
    const value = Number(n);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const note = (level, message, data) => {
    try { onNote(level, message, data); } catch { /* 留痕失败不许影响主流程 */ }
    if (level === 'warn' || level === 'error') console.warn('[dsh-ling] %s', message);
  };
  const fail = (reason, target, extra) => {
    const entry = { reason, sid: sessionIdOf(target), ...(extra || {}) };
    failures.push(entry);
    if (failures.length > 50) failures.shift();
    return entry;
  };

  /** 绑一个 agent(或一个裸 agent-ctx)。已绑过的身份直接跳过 —— 这就是去重。 */
  function bindOne(target, source) {
    if (stopping || isDisposed()) {
      refusedAfterDispose += 1;
      return { ok: false, reason: 'disposed' };
    }
    const identity = agentIdentity(target);
    if (!identity) {
      const entry = fail('no-agent-context', target, { source });
      note('warn', `agent 作用域工具补绑失败(${source}):payload 里没有可用的 agent ctx`, entry);
      return { ok: false, reason: entry.reason };
    }
    // **子代理不绑器灵工具**(1.7.3 U1)。
    //   为什么要这一步:`dsh-tools` 的规则是 "Restrictions intersect; scoped registrations remain
    //   visible"(`dsh-tools/lib/index.js:2987`)—— `tools.restrict()` 只逐层过滤**继承层**
    //   (`:3069` `layers.every(layer => layer.admits(name))`),`own` 那一份随后 append、永远可见;
    //   对 scope-local 名下 `deny` 甚至直接抛错(`:2986-3003`)。所以宿主侧**没有任何掩码能删掉**
    //   这里注册的工具 —— 只能在注册期判掉。ling 本来就不给子代理注入记忆、不入库
    //   (`sessionKind === 'subagent'`),工具是同一道界线的另一半。
    //   ⚠️ 只对 `'subagent'` 做 denylist,不做 allowlist:`fork`(主人的并行工作线)与
    //   `'unknown'`(取不到 header 的裸 agent-ctx,如宿主测试桩)必须照常绑 —— fail-open。
    const header = pick(
      () => target?.session?.header,
      () => target?.agent?.session?.header,
      () => target?.header,
    );
    if (sessionKind(header) === 'subagent') {
      subagentSkipped += 1;
      return { ok: true, reason: 'subagent-skip' };
    }
    if (bound.has(identity)) {
      already += 1;
      return { ok: true, reason: 'already' };
    }
    let result = null;
    try {
      result = register(identity, deps);          // ← 唯一注册入口(内部的 guard 不许绕过)
    } catch (error) {
      const entry = fail('register-threw', target, { source, detail: String(error?.message ?? error).slice(0, 200) });
      note('warn', `agent 作用域工具注册抛错(${source}): ${String(error?.message ?? error).slice(0, 200)}`, entry);
      return { ok: false, reason: entry.reason };
    }
    const disposers = Array.isArray(result?.disposers) ? result.disposers.filter((d) => typeof d === 'function') : [];
    if (!result || result.ok !== true) {
      const entry = fail(String(result?.reason || 'not-ok'), target, { source, disposers: disposers.length });
      note('warn', `agent 作用域工具未注册(${source} / ${entry.reason})`, entry);
      return { ok: false, reason: entry.reason };
    }
    const want = expected();
    const partial = want > 0 && disposers.length < want;
    bound.set(identity, { disposers, sid: sessionIdOf(target), source, partial, got: disposers.length, want });
    if (partial) {
      // 「部分失败不静默」:少了几件工具就必须说清,不能当全成功(否则又是"工具悄悄没了")。
      const entry = fail('partial', target, { source, got: disposers.length, want });
      note('warn', `agent 作用域工具只注册到 ${disposers.length}/${want} 件(${source})`, entry);
    }
    return { ok: true, reason: partial ? 'partial' : 'bound', partial, got: disposers.length };
  }

  function resolveRegistry(c = ctx) {
    try {
      const registry = pick(() => c?.agents, () => (typeof c?.get === 'function' ? c.get('agents') : undefined));
      return registry && typeof registry.list === 'function' ? registry : null;
    } catch { return null; }
  }

  /** 第 2 步:枚举存量 agent 补绑(`list()` 每次都回新数组,不受调用方改动影响)。 */
  function bindExisting(c = ctx) {
    if (stopping || isDisposed()) {
      refusedAfterDispose += 1;
      return { ok: false, reason: 'disposed' };
    }
    const registry = resolveRegistry(c);
    if (!registry) {
      serviceAvailable = false;
      return { ok: false, reason: 'no-agents-service' };
    }
    serviceAvailable = true;
    let raw = null;
    try { raw = registry.list(); }
    catch (error) {
      const entry = fail('list-failed', null, { detail: String(error?.message ?? error).slice(0, 200) });
      note('warn', `agents.list() 抛错: ${entry.detail}`, entry);
      return { ok: false, reason: entry.reason };
    }
    const agents = Array.isArray(raw) ? raw : [];
    listed = agents.length;
    let boundNow = 0;
    for (const agent of agents) {
      const r = bindOne(agent, 'enumerate');
      if (r.reason === 'bound' || r.reason === 'partial') boundNow += 1;
    }
    return { ok: true, listed: agents.length, boundNow, status: status() };
  }

  /** `agents` 服务迟到(或 provider 重载):走既有 ctx.inject 接续;不造枚举 API、不起轮询。 */
  function hookLateService() {
    if (injectHooked || stopping || isDisposed()) return false;
    injectHooked = true;
    try {
      const disposer = ctx?.inject?.(['agents'], (child) => {
        if (stopping || isDisposed()) { refusedAfterDispose += 1; return; }
        bindExisting(child || ctx);
      });
      if (typeof disposer === 'function') ownDisposers.push(disposer);
      return true;
    } catch (error) {
      const entry = fail('inject-failed', null, { detail: String(error?.message ?? error).slice(0, 200) });
      note('warn', `ctx.inject(['agents']) 失败: ${entry.detail}`, entry);
      return false;
    }
  }

  /** 第 1 步:挂事件监听(**必须在枚举之前**)。 */
  function install() {
    if (installed || stopping) return status();
    installed = true;
    for (const name of AGENT_TOOL_EVENTS) {
      try {
        const disposer = ctx?.on?.(name, (payload) => {
          const target = pick(
            () => payload?.agent,
            () => payload?.session?.agent,
            () => payload?.agentCtx,
          );
          if (!target) {
            const entry = fail('no-agent-in-payload', payload, { source: name });
            note('warn', `事件 ${name} 的载荷里没有 agent,补绑跳过(不静默)`, entry);
            return;
          }
          bindOne(target, name);
        });
        if (typeof disposer === 'function') ownDisposers.push(disposer);
      } catch (error) {
        const entry = fail('listener-failed', null, { source: name, detail: String(error?.message ?? error).slice(0, 200) });
        note('warn', `挂 ${name} 监听失败: ${entry.detail}`, entry);
      }
    }
    return status();
  }

  function status() {
    return {
      installed,
      stopping,
      serviceAvailable,
      injectHooked,
      listed,
      bound: bound.size,
      already,
      subagentSkipped,
      refusedAfterDispose,
      partial: [...bound.values()].filter((b) => b.partial).length,
      failures: failures.map((f) => ({ ...f })),
      expectedTools: expected(),
      events: [...AGENT_TOOL_EVENTS],
    };
  }

  /** 卸载:撤销本实例的全部注册、清空绑定表,并锁死后续回绑。 */
  function dispose() {
    stopping = true;
    const pending = [];
    for (const [identity, record] of bound) {
      for (const d of record.disposers) {
        try { pending.push(d()); } catch (error) { pending.push(Promise.reject(error)); }
      }
      bound.delete(identity);
    }
    for (const d of ownDisposers.splice(0).reverse()) {
      try { pending.push(d()); } catch (error) { pending.push(Promise.reject(error)); }
    }
    if (!pending.length) return { ok: true, released: 0 };
    return Promise.allSettled(pending).then((results) => {
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        note('warn', `agent 作用域工具卸载时 ${failed.length} 个 disposer 失败`, { failed: failed.length });
      }
      return { ok: failed.length === 0, released: results.length, failed: failed.length };
    });
  }

  return { install, bindExisting, hookLateService, status, dispose, bindOne };
}
