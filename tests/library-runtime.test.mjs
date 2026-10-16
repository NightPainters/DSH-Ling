// Independent config/runtime/entry acceptance. Only self-owned temporary data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { LibraryRuntime, normalizeLibraryConfig } from '../lib/host/library-runtime.js';
import { LibraryStore } from '../lib/host/library-store.js';
import { MemoryStore } from '../lib/host/memory.js';
import { Config } from '../lib/host/config.js';

const dir = mkdtempSync(join(tmpdir(), 'ling-runtime-'));
const originalHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(dir, 'home');
const roots = join(dir, 'sources');
mkdirSync(roots);
const source = join(roots, 'value.txt');
writeFileSync(source, 'declared\n');
const itemInput = (title = 'isolated-reference') => ({
  title, body: 'Explanatory body is not certified.', category: 'project-spec',
  source_kind: 'our-code', source_ref: source, as_of: '2026-10-07',
  check_spec: { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'declared', comparison: 'exact' },
});
let assertions = 0;
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assertions++; };
const yes = (value, label) => { assert.ok(value, label); assertions++; };
const throws = (fn, label) => { assert.throws(fn, undefined, label); assertions++; };
const runtimes = [];
const live = (path, cfg) => { const runtime = new LibraryRuntime(path, cfg); runtimes.push(runtime); return runtime; };
const teardown = [];
try {
  console.log('1) Schemastery Config + canonical public configuration');
  yes(Config['~standard'], 'real Standard Schema, not plain object');
  eq(typeof Config, 'function');
  eq(Config(undefined).library.enabled, true, 'outer schema default applies before transform');
  eq(Config(null).library.codeRoots, [], 'nullish config uses the same default');
  eq((await Config['~standard'].validate(undefined)).value.library.enabled, true, 'Cordis Standard Schema path receives defaults');
  const configured = Config({ summarizeAuto: false, trackWorkspaces: ['*'], library: { codeRoots: [roots], limits: { checkConcurrency: 1 } } });
  eq(configured.summarizeAuto, false, 'legacy settings survive');
  eq(configured.trackWorkspaces, ['*']);
  eq(configured.library.enabled, true);
  eq(configured.library.limits.itemMaxBytes, 65536);
  eq(configured.library.limits.checkConcurrency, 1);
  eq(normalizeLibraryConfig().officialUrls, []);
  for (const bad of [null, [], 5, { nope: true }, { enabled: 'yes' }, { limits: null },
    { resolver: () => [] }, { requester: () => {} }, { limits: { concurrency: 1 } },
    { limits: { checkTimeoutMs: 0 } }, { limits: { checkConcurrency: 1.5 } },
    { limits: { searchDefaultLimit: 50, searchMaxLimit: 10 } }, { codeRoots: ['relative'] },
    { codeRoots: [source] }, { officialUrls: ['http://example.com/'] },
    { officialUrls: ['https://127.0.0.1/'] }, { officialUrls: ['https://u:p@example.com/'] }]) {
    throws(() => normalizeLibraryConfig(bad), 'invalid runtime config rejected');
    // F10:插件配置这条路**不再抛**(抛 = 记忆 / 人格 / 11 件工具一起不加载),改为把原因带进 config。
    //   界线:严格在里(normalizeLibraryConfig 照旧抛)、降级在外(Config 收住并记录)。
    const degradedCfg = Config({ library: bad });
    yes(String(degradedCfg.library.configError ?? '').length > 0,
      `invalid public config is recorded, not thrown: ${JSON.stringify(bad)}`);
  }
  const neverCreated = join(dir, 'invalid-before-io');
  throws(() => new LibraryRuntime(neverCreated, { requester: () => {} }));
  eq(existsSync(neverCreated), false, 'bad config does not create database directory');

  console.log('2) disabled/unavailable are not zero matches');
  const disabledPath = join(dir, 'disabled');
  const disabled = live(disabledPath, { enabled: false });
  eq(disabled.status().reason, 'library_disabled');
  eq(disabled.status().enabled, false);
  eq(disabled.search({ q: 'reference' }).reason, 'library_disabled');
  eq((await disabled.check('id')).recorded, false);
  eq(existsSync(disabledPath), false, 'disabled runtime creates no library DB');
  const corruptPath = join(dir, 'corrupt'); mkdirSync(corruptPath);
  writeFileSync(join(corruptPath, 'library.db'), 'this is not SQLite');
  const corrupt = live(corruptPath);
  eq(corrupt.status().available, false);
  eq(corrupt.status().reason, 'library_unavailable');
  eq(corrupt.create(itemInput()).reason, 'library_unavailable');

  console.log('3) real store/checker/runtime chain and adoption reasons');
  const runtimePath = join(dir, 'normal');
  const runtime = live(runtimePath, { codeRoots: [roots], limits: { checkConcurrency: 1 } });
  eq(runtime.status().available, true);
  eq(runtime.status().store.items.total, 0);
  eq(runtime.status().checker.limits.checkConcurrency, 1);
  const created = runtime.create(itemInput());
  eq(created.ok, true);
  const item = created.item;
  eq(runtime.get(item.id).item.content_hash, item.content_hash);
  eq(runtime.search({ q: 'reference' }).items.length, 1);
  eq('total' in runtime.search({ q: 'reference' }), false);
  eq(runtime.search({ q: 'reference', includeInactive: true }).ok, false);
  const checked = await runtime.check(item.id);
  eq(checked.ok, true); eq(checked.state, 'ok'); eq(checked.recorded, true); eq(checked.adopted, true);
  eq(checked.adoption_reason, 'adopted'); eq(checked.reason, null);
  eq(runtime.checks(item.id).total, 1);
  const revised = runtime.revise(item.id, { title: 'new-reference' }, item.content_hash);
  eq(revised.ok, true); eq(revised.item.checked_state, '');
  const stale = await runtime.check(item.id);
  eq(stale.state, 'ok'); eq(stale.adopted, false);
  eq(stale.adoption_reason, 'stale_or_inactive');
  eq(runtime.get(revised.item.id).item.checked_state, '');
  eq(runtime.history(item.id).revisions.length, 2);
  eq(runtime.withdraw(revised.item.id, 'retired', revised.item.content_hash).ok, true);
  eq(runtime.search({ q: 'reference' }).count, 0);

  console.log('4) cancellation, unload order, idempotent close, durable history');
  const cancelItem = runtime.create(itemInput('cancel-reference')).item;
  const controller = new AbortController(); controller.abort();
  const cancelled = await runtime.check(cancelItem.id, { signal: controller.signal });
  eq(cancelled.cancelled, true); eq(cancelled.adoption_reason, 'not_recorded');
  eq(runtime.checks(cancelItem.id).total, 0);
  const inFlight = runtime.check(cancelItem.id);
  const closeA = runtime.close(); const closeB = runtime.close();
  eq(closeA, closeB, 'same close promise');
  eq(runtime.search({ q: 'reference' }).reason, 'closed', 'reject new work before close awaits');
  eq((await inFlight).cancelled, true);
  await closeA;
  const reopened = new LibraryStore(join(runtimePath, 'library.db'));
  try { eq(reopened.checks(cancelItem.id).total, 0, 'no cancelled certification reached disk'); }
  finally { reopened.close(); }

  console.log('5) plugin entry exports, shared dependency wiring, memory degradation');
  const entry = await import('../lib/index.js');
  eq(entry.Config, Config); eq(typeof entry.apply, 'function');
  function fixture(path, extra = {}) {
    const listeners = new Map(); const effects = []; const specs = new Map(); const routes = new Map(); const sections = [];
    const provided = new Map();
    const services = {
      tools: { register(spec) { specs.set(spec.name, spec); return () => specs.delete(spec.name); } },
      skills: { register() { return () => {}; } },
      webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
      systemPrompt: { section(spec) { sections.push(spec); return () => {}; }, context() { return () => {}; } },
    };
    const ctx = {
      ...services, get(name) { return services[name] ?? provided.get(name); },
      provide(name, value) { provided.set(name, value); return () => provided.delete(name); },
      on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
      effect(factory) { const dispose = factory(); effects.push(dispose); return dispose; },
    };
    entry.apply(ctx, { dataDir: path, library: { codeRoots: [roots] }, accessLog: { enabled: false },
      summarizeAuto: false, deepSummaryAuto: false, feedbackAuto: false, ...extra });
    const close = async () => { await Promise.all(effects.map(fn => fn())); };
    teardown.push(close);
    return { ctx, listeners, specs, routes, sections, close };
  }
  const f = fixture(join(dir, 'entry-normal'));
  eq(f.specs.size, 11, '8 existing + 2 library tools + deep_item(B 档)');
  yes(f.routes.has('/api/dsh-ling/library/status'));
  yes(f.routes.has('/api/dsh-ling/health'), 'memory gateway retained');
  yes(f.sections.length > 0, 'memory injection retained');
  const independentStore = new LibraryStore(join(dir, 'entry-normal', 'library.db'));
  const wiredItem = independentStore.create(itemInput('entry-only-token')).item;
  independentStore.close();
  const searchTool = f.specs.get('library_search');
  eq((await searchTool.execute({ q: 'entry-only-token' }, {})).items[0].id, wiredItem.id);
  const scoped = new Map();
  const agentCtx = { tools: { register(spec) { scoped.set(spec.name, spec); return () => scoped.delete(spec.name); } } };
  for (const listener of f.listeners.get('agent/created') ?? []) {
    listener({ agent: { ctx: agentCtx, session: { id: 'test-subagent', header: { origin: 'subagent' } } } });
  }
  eq(scoped.size, 11, 'agent-scoped registration includes both library tools + deep_item(B 档)');
  eq((await scoped.get('library_search').execute({ q: 'entry-only-token' }, {})).items[0].id, wiredItem.id);
  eq((await scoped.get('library_check').execute({ id: wiredItem.id }, {})).state, 'ok');
  await f.close();
  eq(f.specs.size, 0); eq(scoped.size, 0, 'agent tool disposers collected');
  eq(f.routes.size, 0);
  eq((await searchTool.execute({ q: 'entry-only-token' }, {})).reason, 'closed');

  // F10(修前这里是:`throws(() => entry.apply({}, {…, library: { codeRoots: ['relative'] } }))` ——
  //   一个写错的 library 键把**整插件**打掉:记忆 / 人格 / 11 件工具一起不加载,连排查面都没有)。
  //   修后:响亮降级 —— **只废掉图书馆这一块**,其余照常。
  const badEntryPath = join(dir, 'entry-bad-config');
  const badEntry = fixture(badEntryPath, { library: { codeRoots: ['relative'] } });
  eq(badEntry.specs.size, 11, 'F10:library 配置写错时 11 件工具照常注册(没被连坐)');
  yes(badEntry.routes.has('/api/dsh-ling/health'), 'F10:记忆网关路由照常');
  yes(badEntry.sections.length > 0, 'F10:人格/记忆注入段照常');
  eq((await badEntry.specs.get('library_search').execute({ q: 'x' }, {})).reason, 'library_config_invalid');
  yes(existsSync(join(badEntryPath, 'memory.db')), 'F10:记忆库照常打开');
  await badEntry.close();
  const degradedPath = join(dir, 'entry-degraded'); mkdirSync(degradedPath);
  writeFileSync(join(degradedPath, 'library.db'), 'invalid SQLite');
  const degraded = fixture(degradedPath);
  eq(degraded.specs.size, 11, 'library failure does not remove memory tools(+ deep_item)');
  yes(degraded.sections.length > 0, 'library failure does not remove memory injection');
  eq((await degraded.specs.get('library_search').execute({ q: 'x' }, {})).reason, 'library_unavailable');
  yes(existsSync(join(degradedPath, 'memory.db')));
  const req = new EventEmitter();
  req.url = '/api/dsh-ling/health'; req.method = 'GET';
  // Use real same-origin cookie naming; do not disable the gateway guard.
  const { expectedCookieName } = await import('../lib/host/guard.js');
  req.headers = { host: '127.0.0.1:3080', cookie: `${expectedCookieName('127.0.0.1:3080')}=1` };
  const res = new EventEmitter(); res.setHeader = () => {};
  res.end = (data) => { res.body = JSON.parse(data); res.writableEnded = true; };
  await degraded.routes.get('/api/dsh-ling/health')(req, res);
  eq(res.statusCode, 200); eq(res.body.ok, true, 'memory health remains operational');
  await degraded.close();
  console.log('6) partial activation rollback: no leaked DB, routes, tools or late remount');
  for (const failure of ['boot_at', 'route_partial', 'api.registered', 'root_disappeared', 'effect', 'late_remount']) {
    const failedPath = join(dir, `failed-${failure}`);
    const root = join(dir, `root-${failure}`); mkdirSync(root);
    const effects = []; const routes = new Map(); const specs = new Map(); const late = [];
    const memories = new Set(); const closed = new Set(); const libraries = new Set();
    const originalSet = MemoryStore.prototype.kvSet;
    const originalClose = MemoryStore.prototype.close;
    const originalStatus = LibraryRuntime.prototype.status;
    const services = {
      webServer: { register(route) {
        if (failure === 'route_partial' && routes.size === 3) throw new Error('fault:route_partial');
        routes.set(route.path, route); return () => routes.delete(route.path);
      } },
      tools: { register(spec) { specs.set(spec.name, spec); return () => specs.delete(spec.name); } },
      skills: { register() { return () => {}; } },
    };
    const ctx = {
      ...services, get(name) { return failure === 'late_remount' && name === 'webServer' ? undefined : services[name]; }, provide() { return () => {}; },
      on() { return () => {}; }, inject(names, callback) { late.push(() => callback(services)); },
      effect(factory) {
        if (failure === 'effect') throw new Error('fault:effect');
        const dispose = factory(); effects.push(dispose); return dispose;
      },
    };
    if (failure === 'late_remount') delete ctx.webServer;
    let caught;
    try {
      MemoryStore.prototype.kvSet = function(key, value) {
        memories.add(this);
        if (failure === key || (failure === 'late_remount' && key === 'boot_at')) throw new Error(`fault:${failure}`);
        const result = originalSet.call(this, key, value);
        // Config accepted this existing root, but it vanished before runtime
        // construction revalidates it. This is filesystem TOCTOU, not bad input.
        if (failure === 'root_disappeared' && key === 'schema_version') rmSync(root, { recursive: true });
        return result;
      };
      MemoryStore.prototype.close = function() { closed.add(this); return originalClose.call(this); };
      LibraryRuntime.prototype.status = function() { libraries.add(this); return originalStatus.call(this); };
      try {
        entry.apply(ctx, { dataDir: failedPath, library: { codeRoots: [root] }, accessLog: { enabled: false },
          summarizeAuto: false, deepSummaryAuto: false, feedbackAuto: false });
      } catch (error) { caught = error; }
      await Promise.all(effects.map(fn => fn()));
      yes(caught, `${failure}: activation failure stays visible`);
      eq(closed.size, memories.size, `${failure}: every opened memory is closed`);
      eq(routes.size, 0, `${failure}: no ghost routes`);
      eq(specs.size, 0, `${failure}: no ghost tools`);
      for (const runtime of libraries) eq(runtime.status().reason, 'closed', `${failure}: library closed`);
      for (const callback of late) callback();
      eq(routes.size, 0, `${failure}: deferred injection cannot remount`);
      rmSync(failedPath, { recursive: true, force: true });
      eq(existsSync(failedPath), false, `${failure}: database handles released on disk`);
    } finally {
      MemoryStore.prototype.kvSet = originalSet;
      MemoryStore.prototype.close = originalClose;
      LibraryRuntime.prototype.status = originalStatus;
      await Promise.all(effects.map(fn => fn()));
      await Promise.all([...libraries].map(runtime => runtime.close()));
      for (const memory of memories) originalClose.call(memory);
    }
  }
  console.log('7) F10: bad library config is loud, bounded, and only kills the library');
  {
    // ① 配置层:不抛、结构仍是合法形状、原因带进 config(含**出错的键名** —— 可执行)
    const cfgBad = Config({ library: { codeRoots: ['relative/path'] } });
    yes(cfgBad.library.configError.length > 0, 'F10:配置校验失败的原因进了 config');
    yes(cfgBad.library.configError.includes('codeRoots'), 'F10:原因里含出错的键名(实际:' + cfgBad.library.configError + ')');
    eq(cfgBad.library.enabled, true, 'F10:结构仍是合法形状(默认:enabled=true)');
    eq(cfgBad.library.codeRoots, [], 'F10:结构仍是合法形状(默认:空白名单 —— 不放行任何源)');
    eq(typeof cfgBad.library.limits.searchMaxLimit, 'number', 'F10:限额仍取默认值,不是半套配置');
    eq(Config({ library: { codeRoots: [roots] } }).library.configError, '', 'F10:正对照 —— 合法配置的 configError 是空串');
    eq(Config(undefined).library.configError, '', 'F10:正对照 —— 没配 library 时也是空串');

    // ② 运行时层:直接进入不可用态,**不试图用半套配置开库**
    const badRuntimePath = join(dir, 'f10-bad-runtime');
    const badRuntime = live(badRuntimePath, { ...cfgBad.library });
    eq(badRuntime.status().ok, false, 'F10:配置有误 ⇒ status 不 ok');
    eq(badRuntime.status().reason, 'library_config_invalid', 'F10:理由词是 library_config_invalid(不用 library_unavailable 那种笼统话)');
    yes(String(badRuntime.status().message).includes('codeRoots'), 'F10:回执文案含出错的键名');
    eq(badRuntime.search({ q: 'x' }).reason, 'library_config_invalid', 'F10:检索回同一理由(不是零命中)');
    eq((await badRuntime.check('whatever')).recorded, false, 'F10:核对也拒,且 recorded=false');
    eq(existsSync(badRuntimePath), false, 'F10:配置有误时不建图书馆库(没用半套配置开库)');

    // ③ 界线:运行时层的严格性**没被这次修复放松**(严格在里、降级在外)
    throws(() => normalizeLibraryConfig({ codeRoots: ['relative'] }), 'F10:normalizeLibraryConfig 照旧严格');
  }

  console.log('8) F17:index.js 失败注释里的工具数 = 实测注册数(防陈旧数字)');
  {
    const f17 = fixture(join(dir, 'f17-entry'));
    const measured = f17.specs.size;
    eq(measured, 11, 'F17:实测注册工具数(不采信注释自报)');
    const idxSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
    // 逐字锚:apply() 的失败注释要写清"一起没了"的有多少件工具。
    // 这条判据的意义不在"11"这个字面 —— 而在**下次加工具时不会漏改**(与 F1 同类:
    // 注释说"十个"、实际十一个,是"记账说谎"里最难自查的一种)。
    const m = /异常就一路冒到 `apply\(\)` ⇒ \*\*(\d+) 个工具全不在/.exec(idxSrc);
    yes(m, 'F17:失败注释的锚点还在(找不到说明已被改写 ⇒ 需人工核)');
    eq(Number(m[1]), measured, `F17:注释里的工具数(${m?.[1]})必须等于实测注册数(${measured})`);
    await f17.close();
  }

  console.log(`PASS library runtime/config/entry: ${assertions} assertions`);
} finally {
  await Promise.all(teardown.map(fn => fn()));
  await Promise.all(runtimes.map(runtime => runtime.close()));
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
}
