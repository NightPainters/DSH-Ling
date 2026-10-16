// 1.7 · 图书馆 API 面 + 模型工具面 —— 针对性证据套(真实 HTTP / 真存储库 / 桩运行时)
//
// 覆盖(逐条对应契约 §Integration Routes / §Integration Response Decisions / §Tooling):
//   · 方法闸:**405 前置**(写面 POST_ONLY 六个 / 读面 GET_ONLY 六个),且 405 早于鉴权 403、403 早于 handler;
//   · 载荷:未知 query / 重复 query / 未知 body 字段 / 非对象 body / 坏 JSON ⇒ 400(**不是** 500);超限 ⇒ 413;
//   · 语义映射:不可用/关闭 ⇒ 503、not_found ⇒ 404、hash_mismatch ⇒ 409、其余按 reason ⇒ 400;
//   · search 回执**没有** total(连直接属性访问都没有),也不暴露 includeInactive;
//   · check 回执补 `adoption_reason` 且**保留** checker 的 evidence/record;客户端断开 / 插件卸载都取消;
//   · 工具面只有两个、参数面极小(路径/URL/roots/规格/includeInactive 一律拒)、exec.signal 透传。
//
// ⚠️ DSH_HOME 隔离(硬要求,不是保险):`registerApi()` 一进来就 `rotateSurgeryTicket()`,
//    它往 `dshHome()` 写一张"每启动轮换"的票据文件 —— 不隔离就是**真机副作用**。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let assertions = 0;
let failures = 0;
const check = (cond, msg) => {
  assertions += 1;
  if (!cond) { failures += 1; console.log('✗ ' + msg); }
};
const section = (t) => console.log('▶ ' + t);

const tmp = mkdtempSync(join(tmpdir(), 'ling-lib-api-'));
const realHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(tmp, 'home');   // 见文件头:隔离每启动票据的真机写入

// ══ 1) 工具面自校验(纯函数)══════════════════════════════════════════════════════════
const {
  registerLingTools, checkLibrarySearch, checkLibraryCheck,
  LIBRARY_SEARCH_SPEC, LIBRARY_CHECK_SPEC,
  TOOL_LIBRARY_SEARCH, TOOL_LIBRARY_CHECK,
} = await imp('lib/host/tools.js');

section('1) library_search / library_check 的参数自校验(参数面必须极小)');
check(TOOL_LIBRARY_SEARCH === 'library_search' && TOOL_LIBRARY_CHECK === 'library_check', '工具名逐字');
check(checkLibrarySearch({ q: '  GB/T 1800  ' }).ok === true, 'q 去空白后通过');
check(checkLibrarySearch({ q: '   ' }).reason === 'empty-query', '空查询 ⇒ empty-query');
check(checkLibrarySearch({}).reason === 'empty-query', '缺 q ⇒ empty-query');
check(checkLibrarySearch({ q: 'x', includeInactive: true }).reason === 'unknown-arg',
  'includeInactive **拒**(存储层内部扩展,工具面不暴露)');
check(checkLibrarySearch({ q: 'x', path: '/etc/passwd' }).reason === 'unknown-arg', 'path **拒**');
check(checkLibrarySearch({ q: 'x', url: 'https://example.com' }).reason === 'unknown-arg', 'url **拒**');
check(checkLibrarySearch({ q: 'x', roots: ['/'] }).reason === 'unknown-arg', 'roots **拒**');
check(checkLibrarySearch({ q: 'x', comparison: 'exact' }).reason === 'unknown-arg', '比较规格 **拒**');
check((checkLibrarySearch({ q: 'x', a: 1 }).message || '').includes('a'), '未知参数**点名**报出(不是干巴巴的拒绝)');
check(checkLibrarySearch({ q: 'x', offset: 3, limit: 7 }).offset === 3
  && checkLibrarySearch({ q: 'x', offset: 3, limit: 7 }).limit === 7, 'offset/limit 传整数');
// ⚠️ F16(1.7 修复批次):理由词拼法**统一到 store**(下划线)—— store 才是深的那层契约
//   (`library-store.js:1417/1420` 一直回 `invalid_limit`/`invalid_offset`,且 browse/client 两套
//   已按它钉住);工具层原写连字符 ⇒ 具名文案与它**对不上**,永远落到通用兜底。
check(checkLibrarySearch({ q: 'x', limit: 0 }).reason === 'invalid_limit', 'limit 0 ⇒ invalid_limit');
check(checkLibrarySearch({ q: 'x', offset: -1 }).reason === 'invalid_offset', 'offset -1 ⇒ invalid_offset');
check(checkLibrarySearch({ q: 'x', limit: 1.5 }).reason === 'invalid_limit', 'limit 1.5 ⇒ invalid_limit');
// F16①:`limit` 契约「1..100 的整数」要在**工具层**兑现(此前 101 / 9999 一路放行到 store 才拒)
check(checkLibrarySearch({ q: 'x', limit: 101 }).reason === 'invalid_limit', 'limit 101 ⇒ 工具层就拒(invalid_limit)');
check(checkLibrarySearch({ q: 'x', limit: 9999 }).reason === 'invalid_limit', 'limit 9999 ⇒ 工具层就拒(不是等 store 拒)');
check(checkLibrarySearch({ q: 'x', limit: 100 }).ok === true, '正对照:limit=100(上限)照常放行');
check(checkLibrarySearch({ q: 'x', limit: 1 }).ok === true, '正对照:limit=1(下限)照常放行');
check(checkLibrarySearch({ q: 'x' }).ok === true, '正对照:不给 limit 照常放行(默认值由 store 给)');
check(checkLibraryCheck({ id: 'lib:abc' }).ok === true, 'id 通过');
check(checkLibraryCheck({}).reason === 'id-required', '缺 id ⇒ id-required');
check(checkLibraryCheck({ id: 'lib:abc', spec: {} }).reason === 'unknown-arg', 'check 面传 spec **拒**');
check(checkLibraryCheck({ id: 'lib:abc', signal: 1 }).reason === 'unknown-arg', 'check 面不许自己传 signal(取消归宿主)');

section('2) 工具 schema:additionalProperties:false + 逐字描述(源资料 / 非记忆 / 非通用真理 / 失败≠零命中)');
check(LIBRARY_SEARCH_SPEC.parameters.additionalProperties === false, 'search schema 关掉额外属性');
check(LIBRARY_CHECK_SPEC.parameters.additionalProperties === false, 'check schema 关掉额外属性');
check(JSON.stringify(Object.keys(LIBRARY_SEARCH_SPEC.parameters.properties)) === JSON.stringify(['q', 'offset', 'limit']),
  'search 参数**只有** q/offset/limit');
check(JSON.stringify(Object.keys(LIBRARY_CHECK_SPEC.parameters.properties)) === JSON.stringify(['id']),
  'check 参数**只有** id');
check(JSON.stringify(LIBRARY_SEARCH_SPEC.parameters.required) === JSON.stringify(['q']), 'search 必填 q');
check(JSON.stringify(LIBRARY_CHECK_SPEC.parameters.required) === JSON.stringify(['id']), 'check 必填 id');
check(/源资料/.test(LIBRARY_SEARCH_SPEC.description) && /不是记忆库/.test(LIBRARY_SEARCH_SPEC.description),
  'search 描述写明"源资料、不是记忆库"');
check(/通用真理/.test(LIBRARY_SEARCH_SPEC.description), 'search 描述写明"不许把 ok 当通用真理"');
check(/失败不是零命中/.test(LIBRARY_SEARCH_SPEC.description), 'search 描述写明"失败不是零命中"');
check(/unknown/.test(LIBRARY_CHECK_SPEC.description) && /不构成通用真理/.test(LIBRARY_CHECK_SPEC.description),
  'check 描述写明三态与"不构成通用真理"');
check(/不写核对留痕/.test(LIBRARY_CHECK_SPEC.description), 'check 描述写明取消不写留痕');

// ══ 3) 工具执行:桩运行时(含 signal 透传与取消不写库)════════════════════════════════
section('3) 工具执行:exec.signal 透传 / 取消不写库 / adoption_reason');
const toolReg = [];
const toolCtx = { tools: { register: (spec) => { toolReg.push(spec); return () => {}; } } };
const toolSaw = { searches: [], checks: [], writes: 0, abortReasons: [] };
const toolLibrary = {
  search: (q) => { toolSaw.searches.push(q); return { ok: true, items: [{ id: 'lib:1', title: 'T' }], count: 1, truncated: false }; },
  check: (id, { signal } = {}) => {
    toolSaw.checks.push({ id, hasSignal: !!signal, signal });
    if (signal && signal.aborted) {
      toolSaw.abortReasons.push(signal.reason);
      return { ok: false, reason: 'cancelled', message: '被取消(没写留痕)' };   // ← 取消:不写
    }
    toolSaw.writes += 1;
    return { ok: true, item_id: id, state: 'ok', adopted: true, recorded: true, evidence: { state: 'ok' }, record: { adopted: true } };
  },
};
const reg = registerLingTools(toolCtx, { gate: { snapshotIds: () => [] }, memory: { kvSet() {} }, settings: {}, library: toolLibrary });
const searchTool = toolReg.find((s) => s.name === TOOL_LIBRARY_SEARCH);
const checkTool = toolReg.find((s) => s.name === TOOL_LIBRARY_CHECK);
check(reg.ok === true && toolReg.length === 11, '十一个工具都注册上了(旧八 + 两个图书馆 + 深层库落条/作废)');
check(!!searchTool && !!checkTool, '两个图书馆工具在册');
const sOut = await searchTool.execute({ q: 'GB/T', limit: 5 }, {});
check(sOut.ok === true && toolSaw.searches.length === 1 && toolSaw.searches[0].limit === 5, 'search:参数原样交给运行时');
check(!('total' in sOut) && sOut.total === undefined, 'search 回执**没有** total(工具面也不补)');
const sBad = await searchTool.execute({ q: 'x', includeInactive: true }, {});
check(sBad.ok === false && sBad.reason === 'unknown-arg' && toolSaw.searches.length === 1,
  'search:非法参数**在工具层就被拒**(没走到运行时)');
const sig = new AbortController().signal;
const cOut = await checkTool.execute({ id: 'lib:1' }, { signal: sig });
check(toolSaw.checks[0].signal === sig, 'check:exec.signal **原样**透传(同一个对象)');
check(cOut.adoption_reason === 'adopted', 'check:adopted=true ⇒ adoption_reason=adopted');
check(cOut.evidence && cOut.record && cOut.state === 'ok', 'check:checker 的 evidence/record 原样保留');
const acTool = new AbortController();
acTool.abort(Object.assign(new Error('cancelled'), { cancelled: true }));
const cCan = await checkTool.execute({ id: 'lib:1' }, { signal: acTool.signal });
check(cCan.ok === false && cCan.reason === 'cancelled', 'check:取消 ⇒ 如实回 cancelled');
check(toolSaw.writes === 1 && toolSaw.abortReasons.length === 1 && toolSaw.abortReasons[0].cancelled === true,
  'check:取消**没有**写库(writes 仍是 1),且 signal.reason.cancelled=true 看得见');
const toolReg2 = [];
registerLingTools({ tools: { register: (s) => { toolReg2.push(s); return () => {}; } } },
  { gate: { snapshotIds: () => [] }, memory: { kvSet() {} }, settings: {} });
const un = await toolReg2.find((s) => s.name === TOOL_LIBRARY_SEARCH).execute({ q: 'x' }, {});
check(un.ok === false && un.reason === 'unavailable', '未注入 library ⇒ unavailable(**不是**零命中)');
const un2 = await toolReg2.find((s) => s.name === TOOL_LIBRARY_CHECK).execute({ id: 'lib:1' }, {});
check(un2.ok === false && un2.reason === 'unavailable' && !('adoption_reason' in un2),
  '未注入 library 的 check 不硬贴 adoption_reason');

// ── 桩运行时(HTTP 面用)────────────────────────────────────────────────────────────
const calls = [];
const stubSeen = { checkAbort: [], checkResolve: 0 };
const mkStubRuntime = () => ({
  limits: { itemMaxBytes: 65536 },
  status: () => ({ ok: true, enabled: true, closed: false, items: { total: 0 } }),
  search: (q) => { calls.push(['search', q]); return { ok: true, items: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }; },
  browse: (q) => { calls.push(['browse', q]); return { ok: true, groups: [], items: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }; },
  get: (id) => {
    // 1.7 第二轮:主线运行时的**真实短码**(library-runtime.js)必须映射成 503/409,不能落到 400。
    const FAILS = {
      'lib:missing': { reason: 'not_found', message: '没有这个条目' },
      'lib:inflight': { reason: 'in_flight', message: '这条已经在核对了' },
      'lib:crowded': { reason: 'concurrency_limit', message: '并发核对额度用完' },
      'lib:disabled': { reason: 'library_disabled', message: '图书馆已在插件配置中关闭' },
      'lib:unavail': { reason: 'library_unavailable', message: '图书馆资料库不可用(构造失败)' },
    };
    if (FAILS[id]) return { ok: false, ...FAILS[id] };
    return { ok: true, id, title: 'X' };
  },
  history: (id, opts) => { calls.push(['history', id, opts]); return { ok: true, id, revisions: [] }; },
  checks: (id, opts) => { calls.push(['checks', id, opts]); return { ok: true, id, checks: [], total: 0 }; },
  create: (item) => { calls.push(['create', item]); return { ok: true, id: 'lib:new', content_hash: 'h1' }; },
  revise: (id, item, h) => (h === 'stale'
    ? { ok: false, reason: 'hash_mismatch', message: '观测哈希与当前内容不符', status: 'stale' }
    : { ok: true, id: 'lib:next', previous_id: id }),
  withdraw: (id, reason, h) => ({ ok: true, id, withdrawn: true, reason }),
  check: (id, { signal } = {}) => new Promise((resolve) => {
    // `lib:slow*` = 故意"长活"的那两条:只有被取消才会结束 —— 用来验客户端断开 / 插件卸载两条取消路。
    const slow = id === 'lib:slow' || id === 'lib:slow2';
    const finish = () => {
      if (signal && signal.aborted) {
        stubSeen.checkAbort.push(signal.reason);
        return resolve({ ok: false, reason: 'cancelled', message: '本次核对被取消(不写留痕)' });
      }
      stubSeen.checkResolve += 1;
      if (id === 'lib:missing') return resolve({ ok: false, reason: 'not_found', message: '没有这个条目' });
      if (id === 'lib:stale') {
        return resolve({
          ok: true, item_id: id, state: 'ok', adopted: false, recorded: true,
          reason: 'declared_comparison_mismatch',
          evidence: { state: 'ok' }, record: { adopted: false, reason: 'stale_or_inactive' },
        });
      }
      // ① 运行时**自己**给了 adoption_reason ⇒ 本层不得覆盖。
      if (id === 'lib:runtimeadopt') {
        return resolve({
          ok: true, item_id: id, state: 'ok', adopted: true, recorded: true,
          evidence: { state: 'ok' }, record: { adopted: true }, adoption_reason: 'runtime-said-this',
        });
      }
      // ② 真实运行时当前的形状是 `record?.reason ?? null` ⇒ **null**。本层必须把 null 当"没给",
      //    再按 adopted/record 自己补(否则 HTTP 回执会带着 adoption_reason:null 出去)。
      if (id === 'lib:norecord') {
        return resolve({
          ok: false, item_id: id, state: 'unknown', recorded: false, reason: 'aborted', cancelled: true,
          evidence: { state: 'unknown' }, adoption_reason: null,
        });
      }
      resolve({ ok: true, item_id: id, state: 'ok', adopted: true, recorded: true, evidence: { state: 'ok' }, record: { adopted: true } });
    };
    if (signal && signal.aborted) return finish();
    if (slow) {
      // ⚠️ 这里**故意不**调 finish():它就是要挂住,直到外面 abort 我们(否则"取消"根本没被测到)。
      //    第一版写漏了"非慢路径要自己收尾"这一支 ⇒ 整个第 5 节挂死在第一个正常 check 上。
      if (signal) signal.addEventListener('abort', finish, { once: true });
      return;
    }
    setImmediate(finish);
  }),
  close: async () => {},
});

// ── 真实 HTTP 线:把 registerApi 的 exact 路由挂进一个真 Node http server ──────────────
const guardState = { value: { guard: { enforce: false } } };
const wire = async (library) => {
  const routes = new Map();
  const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
  const { registerApi } = await imp('lib/host/api.js');
  const dispose = registerApi({ get: () => webServer },
    { gate: {}, memory: { kvSet() {}, listOverviews: () => [], fingerprint: () => '' }, settings: { get: () => guardState.value }, library },
    { version: 'test-1.7' });
  const server = createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    const h = routes.get(path);
    if (!h) { res.statusCode = 404; res.end('{"ok":false,"reason":"no-route"}'); return; }
    h(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    routes, base, dispose,
    close: async () => {
      // ⚠️ 坑(本次实测踩到):`server.close()` 会**一直等 keep-alive 连接自己关**
      //    —— undici 的 fetch 默认复用连接池,于是 close 的回调永远不来,测试挂死。
      //    必须先 `closeAllConnections()`(Node 18.2+),再 close。
      try { server.closeAllConnections?.(); } catch { /* 老 Node 没有这个方法 */ }
      await new Promise((r) => server.close(() => r()));
      dispose();
    },
  };
};
const call = async (base, method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 也照测 */ }
  return { status: res.status, json, text };
};

// ══ 4) 真实 HTTP · 桩运行时 ══════════════════════════════════════════════════════════
section('4) 真实 HTTP:方法闸 405 前置 / 严格载荷 400 / 413 / 语义映射 503-404-409');
const stubRt = mkStubRuntime();
const api = await wire(stubRt);
// DSH_HOME 隔离的**正面证据**:`registerApi()` 的 rotateSurgeryTicket() 把票据写在
// `surgeryTicketPath() = defaultDataDir()/surgery.ticket`,而 defaultDataDir() 跟随 DSH_HOME
// ⇒ 它必须落在**临时** home 下(不隔离就会写主人的真实 home)。
const ticketInTmp = (() => {
  try { return readdirSync(join(tmp, 'home'), { recursive: true }).some((f) => String(f).includes('surgery.ticket')); } catch { return false; }
})();
check(ticketInTmp, 'DSH_HOME 隔离生效:每启动票据落在临时 home 下(真机副作用被挡住)');
check(api.routes.size >= 12, '九个 /library/* 路由 + 导入通道两条 + 浏览面一条都挂上了(实际 ' + api.routes.size + ' 条)');
for (const p of ['/api/dsh-ling/library/status', '/api/dsh-ling/library/search', '/api/dsh-ling/library/item',
  '/api/dsh-ling/library/history', '/api/dsh-ling/library/checks', '/api/dsh-ling/library/create',
  '/api/dsh-ling/library/revise', '/api/dsh-ling/library/withdraw', '/api/dsh-ling/library/check',
  '/api/dsh-ling/library/import/analyze', '/api/dsh-ling/library/import/commit',
  '/api/dsh-ling/library/browse']) {
  check(api.routes.has(p), '路由在册:' + p);
}

// 405:写面不许 GET(且是 405 + want:POST,不是 403/404)
for (const p of ['/library/create', '/library/revise', '/library/withdraw', '/library/check',
  '/library/import/analyze', '/library/import/commit']) {
  const r = await call(api.base, 'GET', '/api/dsh-ling' + p);
  check(r.status === 405 && r.json && r.json.error === 'method-not-allowed' && r.json.want === 'POST',
    '写面 GET ⇒ 405 want:POST:' + p + '(实际 ' + r.status + '/' + JSON.stringify(r.json) + ')');
}
// 405:读面不许 POST(这一支是 1.7 新增的 GET_ONLY)
for (const p of ['/library/status', '/library/search', '/library/item', '/library/history', '/library/checks', '/library/browse']) {
  // 不带 body:方法闸在**读体之前**就拒了,带 body 只会让"服务端没读的那半"留在连接上(测试噪声)。
  const r = await call(api.base, 'POST', '/api/dsh-ling' + p);
  check(r.status === 405 && r.json && r.json.want === 'GET',
    '读面 POST ⇒ 405 want:GET:' + p + '(实际 ' + r.status + '/' + JSON.stringify(r.json) + ')');
}

// 403 在 handler **之前**:同一个请求,栅栏开着 + 跨站头 ⇒ 403,且运行时**一次都没被调到**
guardState.value = { guard: { enforce: true } };
const before = calls.length;
const forbidden = await call(api.base, 'GET', '/api/dsh-ling/library/status', undefined);
// fetch 会带上自己的头;直接构造"跨站"请求:用 handler 直调(见下)才是可控的那条路。
check(forbidden.status === 403 || forbidden.status === 200,
  '栅栏开着时本机请求照常(实际 ' + forbidden.status + ';403 的可控判据见下面的 handler 直调)');
const statusHandler = api.routes.get('/api/dsh-ling/library/status');
const synth = async (reqLike, extra) => {
  const out = { headers: {}, body: '', statusCode: 0, ended: false, writableEnded: false, destroyed: false };
  const res = {
    statusCode: 0,
    setHeader: (k, v) => { out.headers[k] = v; },
    on: () => {}, off: () => {},
    end: (b) => { out.body = String(b); out.statusCode = res.statusCode; out.ended = true; out.writableEnded = true; },
  };
  const req = Object.assign({
    method: 'GET', url: '/api/dsh-ling/library/status', headers: { host: '127.0.0.1:3080' }, on: () => {}, off: () => {},
  }, reqLike);
  await statusHandler(req, res);
  Object.assign(out, extra || {});
  return out;
};
const forbiddenRes = await synth({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } });
const forbiddenJson = JSON.parse(forbiddenRes.body || '{}');
check(forbiddenRes.statusCode === 403 && forbiddenJson.error === 'forbidden',
  '跨站请求 ⇒ 403(实际 ' + forbiddenRes.statusCode + '/' + forbiddenRes.body + ')');
check(calls.length === before, '403 **发生在 handler 之前**:运行时调用数没变(仍 ' + calls.length + ')');
// 方法闸同样**先于**鉴权:跨站 + 错方法 ⇒ 405(不是 403)
const gateFirst = await synth({ method: 'POST', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } });
check(gateFirst.statusCode === 405 && JSON.parse(gateFirst.body || '{}').want === 'GET',
  '405 **先于** 403:跨站 + POST 读面 ⇒ 405(实际 ' + gateFirst.statusCode + ')');
guardState.value = { guard: { enforce: false } };

// 读面:正常返回 + 严格 query
const rStatus = await call(api.base, 'GET', '/api/dsh-ling/library/status');
check(rStatus.status === 200 && rStatus.json.ok === true, 'GET status ⇒ 200 ok');
const rUnknown = await call(api.base, 'GET', '/api/dsh-ling/library/search?q=x&includeInactive=true');
check(rUnknown.status === 400 && rUnknown.json.reason === 'unknown-param' && rUnknown.json.param === 'includeInactive',
  '未知 query ⇒ 400 unknown-param(includeInactive 被拒)');
const rDup = await call(api.base, 'GET', '/api/dsh-ling/library/search?q=a&q=b');
check(rDup.status === 400 && rDup.json.reason === 'duplicate-param' && rDup.json.param === 'q',
  '重复 query ⇒ 400 duplicate-param(不静默取头一个)');
const rNoId = await call(api.base, 'GET', '/api/dsh-ling/library/item');
check(rNoId.status === 400 && rNoId.json.reason === 'id-required', '只读面 id 必填 ⇒ 400');
const rSearch = await call(api.base, 'GET', '/api/dsh-ling/library/search?q=GB&offset=2&limit=3');
check(rSearch.status === 200 && rSearch.json.count === 0, 'GET search ⇒ 200(零命中也是 ok:true)');
check(Object.keys(rSearch.json).length > 0 && calls.some((c) => c[0] === 'search' && c[1].offset === 2 && c[1].limit === 3),
  '分页参数**按整数**交给运行时(offset=2 / limit=3)');
// 浏览面(只读、不搜也能翻):正常 200 + 带分组计数表;未知 query 一样点名拒。
const rBrowse = await call(api.base, 'GET', '/api/dsh-ling/library/browse?category=standard-value&limit=2');
check(rBrowse.status === 200 && rBrowse.json.ok === true && Array.isArray(rBrowse.json.groups),
  '浏览面 200 且回执带 groups(实际 ' + rBrowse.status + '/' + JSON.stringify(rBrowse.json).slice(0, 120) + ')');
check(Object.keys(rBrowse.json).includes('total') === false, '浏览面回执**没有** total(契约禁止误导性 total)');
const rBrowseQ = await call(api.base, 'GET', '/api/dsh-ling/library/browse?q=x');
check(rBrowseQ.status === 400 && rBrowseQ.json.reason === 'unknown-param',
  '浏览面未知 query ⇒ 400(实际 ' + rBrowseQ.status + '/' + JSON.stringify(rBrowseQ.json) + ')');
const rHist = await call(api.base, 'GET', '/api/dsh-ling/library/history?id=lib:1&limit=2');
check(rHist.status === 200 && Array.isArray(rHist.json.revisions), 'GET history ⇒ 200(数组正名 revisions)');
const rChecks = await call(api.base, 'GET', '/api/dsh-ling/library/checks?id=lib:1');
check(rChecks.status === 200 && rChecks.json.total === 0, 'GET checks ⇒ 200(单条目精确 total 允许存在)');
const rMiss = await call(api.base, 'GET', '/api/dsh-ling/library/item?id=lib:missing');
check(rMiss.status === 404 && rMiss.json.reason === 'not_found', 'not_found ⇒ 404(不是 400/500)');
// search 回执**没有** total —— 连直接属性访问都没有(契约明文)
const rTotal = await call(api.base, 'GET', '/api/dsh-ling/library/search?q=x');
check(!('total' in rTotal.json) && rTotal.json.total === undefined && !rTotal.text.includes('"total"'),
  'search 回执**没有** total(键不存在 + 属性访问 undefined + 正文里没有):' + rTotal.text);

// 写面:严格 body + 语义错
const rBadJson = await call(api.base, 'POST', '/api/dsh-ling/library/create', '{oops');
check(rBadJson.status === 400 && rBadJson.json.reason === 'bad-json',
  '坏 JSON ⇒ 400 bad-json(**不是** 500;实际 ' + rBadJson.status + ')');
const rArr = await call(api.base, 'POST', '/api/dsh-ling/library/create', '[1,2]');
check(rArr.status === 400 && rArr.json.reason === 'bad-body', '数组 body ⇒ 400 bad-body');
const rUnkField = await call(api.base, 'POST', '/api/dsh-ling/library/create', { item: { title: 'x' }, extra: 1 });
check(rUnkField.status === 400 && rUnkField.json.reason === 'unknown-field', '未知 body 字段 ⇒ 400 unknown-field');
const rNoItem = await call(api.base, 'POST', '/api/dsh-ling/library/create', {});
check(rNoItem.status === 400 && rNoItem.json.reason === 'invalid_item', 'item 缺失 ⇒ 400 invalid_item');
const rCreate = await call(api.base, 'POST', '/api/dsh-ling/library/create', { item: { title: 'x' } });
check(rCreate.status === 200 && rCreate.json.ok === true && rCreate.json.id === 'lib:new', 'POST create ⇒ 200');
const rNoHash = await call(api.base, 'POST', '/api/dsh-ling/library/revise', { id: 'lib:1', item: { title: 'y' } });
check(rNoHash.status === 400 && rNoHash.json.reason === 'hash-required', 'revise 缺 expectedHash ⇒ 400(陈旧编辑进不来)');
const rStale = await call(api.base, 'POST', '/api/dsh-ling/library/revise', { id: 'lib:1', item: { title: 'y' }, expectedHash: 'stale' });
check(rStale.status === 409 && rStale.json.reason === 'hash_mismatch',
  'hash_mismatch ⇒ 409(冲突,不是参数错;实际 ' + rStale.status + ')');
const rWd = await call(api.base, 'POST', '/api/dsh-ling/library/withdraw', { id: 'lib:1', reason: '', expectedHash: 'h' });
check(rWd.status === 400 && rWd.json.reason === 'reason-required', 'withdraw 空 reason ⇒ 400');
const rWdOk = await call(api.base, 'POST', '/api/dsh-ling/library/withdraw', { id: 'lib:1', reason: '标准作废', expectedHash: 'h' });
check(rWdOk.status === 200 && rWdOk.json.withdrawn === true, 'withdraw 正常 ⇒ 200(留痕不物理删)');
// 413:请求体 > itemMaxBytes + 信封
const big = JSON.stringify({ item: { body: 'x'.repeat(80000) } });
const rBig = await call(api.base, 'POST', '/api/dsh-ling/library/create', big);
check(rBig.status === 413 && rBig.json.reason === 'too-large',
  '超限 ⇒ 413 too-large(实际 ' + rBig.status + '/' + rBig.text.slice(0, 80) + ')');

// check:adoption_reason 两种取值 + evidence/record 保留 + 监听拆除计数
section('5) check:adoption_reason / evidence+record 保留 / finally 拆监听 / 取消(断开与卸载)');
const rCheck = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:1' });
check(rCheck.status === 200 && rCheck.json.adoption_reason === 'adopted', 'check 采纳 ⇒ adoption_reason=adopted');
check(rCheck.json.evidence && rCheck.json.record && rCheck.json.state === 'ok', 'check 保留 checker 的 evidence/record/state');
const rCheckStale = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:stale' });
check(rCheckStale.json.adoption_reason === 'stale_or_inactive',
  'check 未采纳 ⇒ adoption_reason 取**存储层**的 stale_or_inactive(不是核对的 declared_comparison_mismatch):'
  + rCheckStale.json.adoption_reason);
const rCheckMiss = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:missing' });
check(rCheckMiss.status === 404 && !('adoption_reason' in rCheckMiss.json),
  'check 没走到结果(not_found)⇒ 404 且不硬贴 adoption_reason');
const rCheckUnk = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:1', spec: {} });
check(rCheckUnk.status === 400 && rCheckUnk.json.reason === 'unknown-field', 'check 面未知字段 ⇒ 400');

// ── 1.7 第二轮增补:严格 query 的另两个面 + 运行时真实短码的状态映射 + adoption_reason 统一三值 ──
// ① `/library/status` 也要严格空 query:`?enforce=0` 这种"看着像开关"的键必须被点名拒掉,
//    而不是静默忽略(静默忽略 = 调用方以为自己关了闸,实际没关)。
const createsBefore = calls.filter((c) => c[0] === 'create').length;
const rStatusQ = await call(api.base, 'GET', '/api/dsh-ling/library/status?enforce=0');
check(rStatusQ.status === 400 && rStatusQ.json.reason === 'unknown-param' && rStatusQ.json.param === 'enforce',
  '/library/status 未知 query ⇒ 400(不是静默忽略;实际 ' + rStatusQ.status + '/' + JSON.stringify(rStatusQ.json) + ')');
const rStatusDup = await call(api.base, 'GET', '/api/dsh-ling/library/status?x=1&x=2');
// ⚠️ `/library/status` 的 allowed 是**空集** ⇒ 任何键都先撞"未知"这一支,`duplicate-param` 在这里
//    根本不可达(实测第一版就是在这一条上红的)。重复键的判据要在**有白名单的**读面上验
//    (`/library/search?q=a&q=b`,见上面那条 duplicate-param)。
check(rStatusDup.status === 400 && rStatusDup.json.reason === 'unknown-param' && rStatusDup.json.param === 'x',
  '/library/status 带任何 query ⇒ 400 unknown-param(空白名单:未知先于重复;实际 '
  + rStatusDup.status + '/' + JSON.stringify(rStatusDup.json) + ')');
const rStatusPlain = await call(api.base, 'GET', '/api/dsh-ling/library/status');
check(rStatusPlain.status === 200 && rStatusPlain.json.ok === true, '/library/status 不带 query 照常 200');
// ② 四个写面的 query **严格为空**:载荷只走 body —— 否则 `?id=a&id=b` 这类会把"生效的键"
//    从 body 挪到 query 上,body 白名单就白设了(URLSearchParams 只取头一个同名键)。
for (const [p, body] of [
  ['/library/create', { item: { title: 'x' } }],
  ['/library/revise', { id: 'lib:1', item: { title: 'x' }, expectedHash: 'h' }],
  ['/library/withdraw', { id: 'lib:1', reason: 'r', expectedHash: 'h' }],
  ['/library/check', { id: 'lib:1' }],
]) {
  const rq = await call(api.base, 'POST', '/api/dsh-ling' + p + '?item=1', body);
  check(rq.status === 400 && rq.json.reason === 'unknown-param',
    '写面 ' + p + ' 带 query ⇒ 400 unknown-param(实际 ' + rq.status + '/' + (rq.json && rq.json.reason) + ')');
}
const rWriteDup = await call(api.base, 'POST', '/api/dsh-ling/library/create?id=a&id=b', { item: { title: 'x' } });
// 同 `/library/status`:写面的白名单也是空集 ⇒ 重复键同样先落在 unknown-param(结论一致:一个 query 都不收)。
check(rWriteDup.status === 400 && rWriteDup.json.reason === 'unknown-param' && rWriteDup.json.param === 'id',
  '写面重复 query ⇒ 400 unknown-param(空白名单;实际 ' + rWriteDup.status + '/' + (rWriteDup.json && rWriteDup.json.reason) + ')');
check(calls.filter((c) => c[0] === 'create').length === createsBefore,
  '带 query 的写请求**没走到运行时**(闸在 handler 第一行;实际 create 调用数 '
  + calls.filter((c) => c[0] === 'create').length + ')');
// ③ 主线运行时的**真实短码**(library-runtime.js):503 两态 / 409 两态 —— 一条都不许落到 400
for (const [id, code, want] of [
  ['lib:disabled', 'library_disabled', 503],
  ['lib:unavail', 'library_unavailable', 503],
  ['lib:inflight', 'in_flight', 409],
  ['lib:crowded', 'concurrency_limit', 409],
]) {
  const r = await call(api.base, 'GET', '/api/dsh-ling/library/item?id=' + id);
  check(r.status === want && r.json.reason === code,
    '语义映射:' + code + ' ⇒ ' + want + '(实际 ' + r.status + '/' + (r.json && r.json.reason) + ')');
}
// ④ adoption_reason 统一三值:运行时给了就**原样保留**;给 null(=没给)则本层自己补
const rRuntimeSaid = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:runtimeadopt' });
check(rRuntimeSaid.json.adoption_reason === 'runtime-said-this',
  '运行时自己给的 adoption_reason **原样保留**(本层不覆盖):' + rRuntimeSaid.json.adoption_reason);
const rNoRecord = await call(api.base, 'POST', '/api/dsh-ling/library/check', { id: 'lib:norecord' });
check(rNoRecord.json.adoption_reason === 'not_recorded',
  '运行时给 null(视同没给)+ 无记录 ⇒ 本层补统一值 not_recorded(实际 ' + rNoRecord.json.adoption_reason + ')');
check(rNoRecord.json.recorded === false && !!rNoRecord.json.evidence,
  'not_recorded 那次仍**如实**带 recorded=false 与 evidence');

// 监听拆除:拿 handler 直调一次(计数式 req/res),跑完必须回到 0
const checkHandler = api.routes.get('/api/dsh-ling/library/check');
const live = { aborted: 0, close: 0 };
let directBody = '';
const dReq = {
  method: 'POST', url: '/api/dsh-ling/library/check', headers: { host: '127.0.0.1:3080' },
  on: (k) => { if (k === 'aborted') live.aborted += 1; },
  off: (k) => { if (k === 'aborted') live.aborted -= 1; },
};
const dRes = {
  statusCode: 0, setHeader: () => {},
  on: (k) => { if (k === 'close') live.close += 1; },
  off: (k) => { if (k === 'close') live.close -= 1; },
  end: (b) => { directBody = String(b); },
};
// ⚠️ 这个方法调的 req 没有真流 —— `readBody` 需要 'data'/'end'。故直接给一个"已解析"的假 req:
dReq.on = (k, f) => {
  if (k === 'data') queueMicrotask(() => f(Buffer.from(JSON.stringify({ id: 'lib:1' }))));
  if (k === 'end') queueMicrotask(() => f());
  if (k === 'aborted') live.aborted += 1;
};
dReq.off = (k) => { if (k === 'aborted') live.aborted -= 1; };
await checkHandler(dReq, dRes);
check(live.aborted === 0 && live.close === 0,
  'handler 的 finally 拆掉了 aborted/close 监听(计数回 0;实际 ' + JSON.stringify(live) + ')');
check(JSON.parse(directBody || '{}').adoption_reason === 'adopted', '直调 handler 同样走通 check 全路');

// 取消①:客户端断开(真 fetch + 真 abort)⇒ 服务端 AbortController 被 abort,reason.cancelled=true
const ac = new AbortController();
const inflight = fetch(api.base + '/api/dsh-ling/library/check', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'lib:slow' }), signal: ac.signal,
}).then((r) => ({ status: r.status })).catch((e) => ({ aborted: true, name: String(e && e.name) }));
await sleep(150);
const abortCountBefore = stubSeen.checkAbort.length;
const resolveBefore = stubSeen.checkResolve;   // 断开之前"走完核对"的次数(别拿常数当判据)
ac.abort();
const dropped = await inflight;
check(dropped.aborted === true, '客户端断开 ⇒ fetch 被取消(实际 ' + JSON.stringify(dropped) + ')');
// ⚠️ 服务端**发现断开**比客户端 abort 晚一两拍(要靠 socket 上的 aborted/close 事件)→ 这里必须等,
//    不等就会把"还没来得及处理"误判成"没传下去"(本次第一版就是这样红的)。
await sleep(200);
check(stubSeen.checkAbort.length === abortCountBefore + 1 && stubSeen.checkAbort[stubSeen.checkAbort.length - 1].cancelled === true,
  '断开传到运行时:signal.reason.cancelled=true(⇒ checker 不写留痕):'
  + JSON.stringify(stubSeen.checkAbort[stubSeen.checkAbort.length - 1] || null));
await sleep(60);
check(stubSeen.checkResolve === resolveBefore, '断开那一次**没有**走"核对完成"分支(完成数没涨)');

// 取消②:插件卸载(API disposer)⇒ 挂起的 HTTP 检查被取消
const inflight2 = fetch(api.base + '/api/dsh-ling/library/check', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'lib:slow2' }),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) })).catch((e) => ({ error: String(e) }));
await sleep(150);
const abortCount2 = stubSeen.checkAbort.length;
api.dispose();   // = mountRoutes 返回的那个 disposer(摘路由 + 取消挂起核对)
const afterUnload = await inflight2;
check(stubSeen.checkAbort.length === abortCount2 + 1
  && stubSeen.checkAbort[stubSeen.checkAbort.length - 1].code === 'unloaded',
  'API disposer 取消了挂起的 HTTP 核对(reason.code=unloaded):'
  + JSON.stringify(stubSeen.checkAbort[stubSeen.checkAbort.length - 1] || null));
check(afterUnload.status === 400 && afterUnload.json && afterUnload.json.reason === 'cancelled',
  '被卸载取消的那次如实回 cancelled(实际 ' + JSON.stringify(afterUnload) + ')');
await api.close().catch(() => {});

// ══ 6) 真实存储库:HTTP 全链(create→search→item→revise 陈旧→关闭)════════════════════
section('6) 真实 HTTP + 真 LibraryStore:create / search(无 total)/ item / 409 / 关闭 503');
const { LibraryStore } = await imp('lib/host/library-store.js');
const store = new LibraryStore(join(tmp, 'library.db'));
const realRuntime = {
  limits: store.limits,
  status: () => ({ ok: true, ...store.stats() }),
  search: (q) => store.search(q),
  browse: (q) => store.browse(q),
  get: (id) => store.get(id),
  history: (id, o) => store.history(id, o),
  checks: (id, o) => store.checks(id, o),
  create: (item) => store.create(item),
  revise: (id, item, h) => store.revise(id, item, h),
  withdraw: (id, reason, h) => store.withdraw(id, reason, h),
  check: async () => ({ ok: false, reason: 'unavailable', message: '本套只接存储层;checker 由它自己那套验收' }),
  close: async () => { store.close(); },
};
const api2 = await wire(realRuntime);
const ITEM = {
  title: 'GB/T 1800.1-2020 极限与配合',
  body: '标准正文摘要:公差带代号与极限偏差的口径。',
  category: 'standard-value',
  source_kind: 'standard',
  source_ref: 'GB/T 1800.1-2020',
  as_of: '2020-03-31',
};
const created = await call(api2.base, 'POST', '/api/dsh-ling/library/create', { item: ITEM });
// ⚠️ 存储层的成功回执是 `{ok:true, item:<整条记录>, byte_size}`(记录**嵌在 item 下**,
//    不是平铺的 {id, content_hash})—— API 层**如实透传**,所以这里照它的形状取(实测得到)。
check(created.status === 200 && created.json.ok === true
  && /^lib:/.test(String(created.json.item && created.json.item.id || '')),
  '真库 create ⇒ 200 且拿到 lib:<UUID>(实际 ' + JSON.stringify(created.json).slice(0, 140) + ')');
const newId = created.json && created.json.item && created.json.item.id;
const hash = created.json && created.json.item && created.json.item.content_hash;
// 存储层的哈希口径是 `sha256:<64 位十六进制>`(见 libraryContentHash)—— 逐字按它验。
check(/^sha256:[0-9a-f]{64}$/.test(String(hash || '')), 'create 回执带回 content_hash(sha256:<hex>):' + String(hash).slice(0, 20) + '…');
check(created.json.item.lineage_id === newId && Number(created.json.item.revision) === 1,
  'create 的记录自洽:lineage_id = 自身 id 且 revision = 1');
const got = await call(api2.base, 'GET', '/api/dsh-ling/library/item?id=' + encodeURIComponent(String(newId)));
check(got.status === 200 && got.json.ok === true && got.json.found === true && got.json.item && got.json.item.title === ITEM.title,
  '真库 item ⇒ 200 且标题逐字(记录嵌在 item 下,API 层如实透传)');
const found = await call(api2.base, 'GET', '/api/dsh-ling/library/search?q=' + encodeURIComponent('公差带'));
check(found.status === 200 && found.json.count >= 1, '真库 search 命中(实际 count=' + found.json.count + ')');
check(!('total' in found.json) && !found.text.includes('"total"'), '真库 search 回执**没有** total');
const notFound = await call(api2.base, 'GET', '/api/dsh-ling/library/item?id=lib%3A00000000-0000-4000-8000-000000000000');
check(notFound.status === 404 && notFound.json.reason === 'not_found', '真库取不存在的 id ⇒ 404');
// ⚠️ 顺序有讲究:**先**用错哈希试(此时这一版仍是 active,409 才是它自己的语义);
//    修订成功之后旧版就 superseded 了,那时再拿错哈希试会得到 not_active(另一条语义)。
//    (第一版把两步写反了,实测回的是 400/not_active —— 记在这里免得下次又写反。)
const stale = await call(api2.base, 'POST', '/api/dsh-ling/library/revise',
  { id: newId, item: { ...ITEM, body: '拿陈旧哈希改。' }, expectedHash: 'sha256:' + '0'.repeat(64) });
check(stale.status === 409 && stale.json.reason === 'hash_mismatch',
  '真库陈旧哈希 ⇒ 409 hash_mismatch(实际 ' + stale.status + '/' + stale.json.reason + ')');
check(stale.json.status === 'stale', '内部机器标记 status:"stale" 照旧带出(**不是** HTTP 码):' + JSON.stringify(stale.json.status));
const revised = await call(api2.base, 'POST', '/api/dsh-ling/library/revise',
  { id: newId, item: { ...ITEM, body: '改过一版的正文。' }, expectedHash: hash });
check(revised.status === 200 && revised.json.ok === true
  && /^lib:/.test(String(revised.json.item && revised.json.item.id || '')),
  '真库 revise(带当前哈希)⇒ 200');
check(revised.json.item.id !== newId && revised.json.item.previous_id === newId,
  'revise:**换新 id** 且 previous_id 指回旧版(谱系咬合)');
// 已被新版取代的旧版:再修订是**语义错**(not_active ⇒ 400),与"冲突 409"分得开
const again = await call(api2.base, 'POST', '/api/dsh-ling/library/revise',
  { id: newId, item: { ...ITEM, body: '再改一次旧版。' }, expectedHash: hash });
check(again.status === 400 && again.json.reason === 'not_active',
  '已取代的旧版再修订 ⇒ 400 not_active(按 reason 分流,不冒充 409)');
const hist = await call(api2.base, 'GET', '/api/dsh-ling/library/history?id=' + encodeURIComponent(String(newId)));
check(hist.status === 200 && Array.isArray(hist.json.revisions) && hist.json.revisions.length === 2
  && Number(hist.json.revision_count) === 2,
  '真库 history ⇒ 两版(实际 revisions=' + ((hist.json.revisions || []).length) + ', revision_count=' + hist.json.revision_count + ')');
const checkUnavail = await call(api2.base, 'POST', '/api/dsh-ling/library/check', { id: newId });
check(checkUnavail.status === 503 && checkUnavail.json.reason === 'unavailable',
  '运行时回 unavailable ⇒ 503(不是 200/零命中;实际 ' + checkUnavail.status + ')');
// 关闭之后:同一个运行时如实回 closed ⇒ 503
await realRuntime.close();
const afterClose = await call(api2.base, 'GET', '/api/dsh-ling/library/search?q=x');
check(afterClose.status === 503 && afterClose.json.reason === 'closed',
  '关闭后 search ⇒ 503 closed(实际 ' + afterClose.status + '/' + afterClose.json.reason + ')');
await api2.close().catch(() => {});

// ══ 7) 真实 LibraryRuntime 端到端 HTTP(our-code 临时源 → create → check 真的 ok/recorded/adopted)══
// 这一节**不碰网络**:源是临时目录里的本地文件,`codeRoots` 只指它,没有 officialUrls、不注入 requester。
section('7) 真实 LibraryRuntime:create(our-code) / check 真 ok+recorded+adopted / history+checks / 降级 503');
const { LibraryRuntime } = await imp('lib/host/library-runtime.js');
const srcDir = join(tmp, 'src');
mkdirSync(srcDir, { recursive: true });
const srcFile = join(srcDir, 'demo.txt');
writeFileSync(srcFile, 'alpha\nbeta\ngamma\n', 'utf8');
const dataDir = join(tmp, 'rt-data');
mkdirSync(dataDir, { recursive: true });
const rt = new LibraryRuntime(dataDir, { codeRoots: [srcDir] });
const api3 = await wire(rt);
const OUR_ITEM = {
  title: '我们自己写的规格(临时源)',
  body: '端到端核对的临时条目:只钉"声明的那个比较"。',
  category: 'project-spec',
  source_kind: 'our-code',
  source_ref: srcFile,
  as_of: '2026-10-07',
  check_spec: { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'alpha', comparison: 'exact' },
};
const rtStatus = await call(api3.base, 'GET', '/api/dsh-ling/library/status');
check(rtStatus.status === 200 && rtStatus.json.ok === true && rtStatus.json.available === true,
  '真 runtime status ⇒ 200 available(实际 ' + rtStatus.status + '/' + JSON.stringify(rtStatus.json).slice(0, 120) + ')');
const rtCreated = await call(api3.base, 'POST', '/api/dsh-ling/library/create', { item: OUR_ITEM });
check(rtCreated.status === 200 && rtCreated.json.ok === true && /^lib:/.test(String(rtCreated.json.item && rtCreated.json.item.id || '')),
  '真 runtime create ⇒ 200(实际 ' + JSON.stringify(rtCreated.json).slice(0, 160) + ')');
const ourId = rtCreated.json.item.id;
const ourHash = rtCreated.json.item.content_hash;
const rtCheck = await call(api3.base, 'POST', '/api/dsh-ling/library/check', { id: ourId });
check(rtCheck.status === 200 && rtCheck.json.ok === true && rtCheck.json.state === 'ok'
  && rtCheck.json.recorded === true && rtCheck.json.adopted === true,
  '★真核对:ok + state=ok + recorded + adopted(实际 ' + JSON.stringify(rtCheck.json).slice(0, 220) + ')');
check(rtCheck.json.item_hash === ourHash && rtCheck.json.adoption_reason === 'adopted',
  '★回执带 item_hash 与统一 adoption_reason=adopted(实际 ' + rtCheck.json.adoption_reason + ')');
check(!!rtCheck.json.evidence && !!rtCheck.json.record
  && rtCheck.json.evidence.observed === 'alpha' && rtCheck.json.evidence.actual_source === srcFile,
  '★证据**真的取到了源**:observed=alpha 且 actual_source 指向临时源文件('
  + JSON.stringify(rtCheck.json.evidence && { observed: rtCheck.json.evidence.observed, actual_source: rtCheck.json.evidence.actual_source }) + ')');
const rtChecks = await call(api3.base, 'GET', '/api/dsh-ling/library/checks?id=' + encodeURIComponent(ourId));
check(rtChecks.status === 200 && Number(rtChecks.json.total) === 1 && (rtChecks.json.checks || []).length === 1
  && rtChecks.json.checks[0].state === 'ok',
  '★核对**真的落库**:GET checks ⇒ 1 行 state=ok(实际 total=' + rtChecks.json.total + ')');
const rtHist = await call(api3.base, 'GET', '/api/dsh-ling/library/history?id=' + encodeURIComponent(ourId));
check(rtHist.status === 200 && (rtHist.json.revisions || []).length === 1, '真 runtime history ⇒ 1 版');
const rtSearch = await call(api3.base, 'GET', '/api/dsh-ling/library/search?q=' + encodeURIComponent('临时源'));
check(rtSearch.status === 200 && rtSearch.json.count >= 1 && !('total' in rtSearch.json),
  '真 runtime search 命中且回执无 total(实际 count=' + rtSearch.json.count + ')');

// ── 合法 JSON 特殊键:数据库/HTTP 正确,工具回执的通用转换器也必须逐键保真 ──
const keyJson = '{"__proto__":{"proof":"ordinary-data"},"nested":{"__proto__":7},"list":[{"__proto__":null}],"constructor":{"prototype":"data"}}';
const keyValue = JSON.parse(keyJson);
const keyFile = join(srcDir, 'keys.json'); writeFileSync(keyFile, keyJson);
const keyCreated = await call(api3.base, 'POST', '/api/dsh-ling/library/create', { item: {
  ...OUR_ITEM, title: 'json-key-integrity', source_ref: keyFile,
  check_spec: { locator: { kind: 'json-pointer', pointer: '' }, expected: keyValue, comparison: 'exact' },
} });
check(keyCreated.status === 200 && keyCreated.json.ok, '特殊键条目经 HTTP 正常入库');
const keyId = keyCreated.json.item.id;
check(JSON.stringify(keyCreated.json.item.check_spec.expected) === keyJson, 'HTTP create 保留全部特殊键');
const keyTools = [];
const keyRegistration = registerLingTools({ tools: { register(spec) { keyTools.push(spec); return () => {}; } } },
  { gate: {}, memory: { kvSet() {} }, settings: {}, library: rt });
const keySearch = await keyTools.find(s => s.name === TOOL_LIBRARY_SEARCH).execute({ q: 'json-key-integrity' }, {});
check(keySearch.ok && keySearch.count === 1, '特殊键工具检索命中');
const searchExpected = keySearch.items[0].check_spec.expected;
check(Object.hasOwn(searchExpected, '__proto__'), 'search expected 的 __proto__ 是自有数据键');
check(Object.getPrototypeOf(searchExpected) === Object.prototype, 'search expected 的原型没有被特殊键改写');
check(JSON.stringify(searchExpected) === keyJson, 'search 回执的整段 expected 序列化无损');
const keyCheck = await keyTools.find(s => s.name === TOOL_LIBRARY_CHECK).execute({ id: keyId }, {});
check(keyCheck.ok && keyCheck.state === 'ok' && keyCheck.recorded && keyCheck.adopted, '特殊键源的真实核对成功并采纳');
for (const [label, value] of [['expected', keyCheck.evidence.expected], ['observed', keyCheck.evidence.observed],
  ['record.expected', keyCheck.record.check.expected], ['record.observed', keyCheck.record.check.observed]]) {
  check(Object.hasOwn(value, '__proto__') && Object.getPrototypeOf(value) === Object.prototype,
    label + ': 数据键在场且原型未变');
  check(JSON.stringify(value) === keyJson, label + ': 嵌套对象/数组/constructor 逐键保真');
}
check(Object.prototype.proof === undefined, '没有污染 Object.prototype');
const keyHistory = rt.checks(keyId).checks[0];
check(JSON.stringify(keyHistory.observed) === JSON.stringify(keyCheck.evidence.observed), '工具观察值与持久历史同源同值');
// Model-visible output.render is the final data surface, not just execute().
const renderedText = (spec, value) => spec.output.render({}, value).filter(b => b.type === 'text').map(b => b.text).join('\n');
const renderedSearch = renderedText(LIBRARY_SEARCH_SPEC, keySearch);
const renderedCheck = renderedText(LIBRARY_CHECK_SPEC, keyCheck);
check(renderedSearch.includes(JSON.stringify(keySearch)), '模型实际检索文本包含完整 canonical JSON,正文/适用条件/核对规格不丢');
check(renderedSearch.includes(JSON.stringify(OUR_ITEM.body)) && renderedSearch.includes(OUR_ITEM.as_of), '模型能直接读正文与取数日期(JSON文本中的引号按JSON转义),无需不存在的读取工具');
check(renderedSearch.includes('外部资料数据') && renderedSearch.includes('不是指令'), '资料与指令边界在模型文本里');
check(renderedCheck.includes(JSON.stringify(keyCheck)), '模型实际核对文本包含完整 evidence 与 record');
check(renderedCheck.includes('actual_source') && renderedCheck.includes('source_hash') && renderedCheck.includes('observed'), '模型可见真实源/摘要/观察值');
const cancelledView = { ok: false, reason: 'aborted', cancelled: true, recorded: false, adoption_reason: 'not_recorded' };
check(renderedText(LIBRARY_CHECK_SPEC, cancelledView).includes(JSON.stringify(cancelledView)), '取消文本保留 cancelled/recorded,不只给笼统失败');
const cappedView = { ok: true, items: [], count: 0, offset: 0, limit: 1, nextOffset: 0, truncated: true };
const capText = renderedText(LIBRARY_SEARCH_SPEC, cappedView);
check(!capText.includes('真的零命中') && capText.includes(JSON.stringify(cappedView)), '单条超过输出上限不能冒充零命中,保留重试 offset');
const pagedText = renderedText(LIBRARY_SEARCH_SPEC, { ...keySearch, truncated: true, nextOffset: 1 });
check(!pagedText.includes('(被字节上限截断)') && pagedText.includes('下一页 offset=1'), '有下一页不擅自归因为字节超限');
check(!LIBRARY_SEARCH_SPEC.parameters.properties.q.description.includes('不是子串匹配'), '检索描述不得违背 LIKE 字面子串实现');
for (const dispose of keyRegistration.disposers) dispose();

// ── 降级面:`enabled:false` 与"构造失败"必须是 **503**(不是 400),且别的记忆端点照常 ──
const rtOff = new LibraryRuntime(join(tmp, 'rt-off'), { enabled: false });
const apiOff = await wire(rtOff);
const offStatus = await call(apiOff.base, 'GET', '/api/dsh-ling/library/status');
check(offStatus.status === 503 && offStatus.json.reason === 'library_disabled',
  '★runtime enabled:false ⇒ HTTP **503** library_disabled(不是 400;实际 ' + offStatus.status + '/' + offStatus.json.reason + ')');
const offSearch = await call(apiOff.base, 'GET', '/api/dsh-ling/library/search?q=x');
check(offSearch.status === 503 && offSearch.json.reason === 'library_disabled',
  '★关掉时 search ⇒ 503(**不是**零命中;实际 ' + offSearch.status + ')');
const offHealth = await call(apiOff.base, 'GET', '/api/dsh-ling/health');
check(offHealth.status === 200 && !!offHealth.json && offHealth.json.ok === true,
  '★图书馆关着时**别的端点照常**(/health 200;实际 ' + offHealth.status + ')');
const badDir = join(tmp, 'rt-bad');
mkdirSync(join(badDir, 'library.db'), { recursive: true });   // 用目录占住库文件路径 ⇒ 构造必失败
const rtBad = new LibraryRuntime(badDir, {});
const apiBad = await wire(rtBad);
const badStatus = await call(apiBad.base, 'GET', '/api/dsh-ling/library/status');
check(badStatus.status === 503 && badStatus.json.reason === 'library_unavailable',
  '★构造失败 ⇒ HTTP **503** library_unavailable(不是 400/500;实际 ' + badStatus.status + '/' + badStatus.json.reason + ')');
const badCreate = await call(apiBad.base, 'POST', '/api/dsh-ling/library/create', { item: ITEM });
check(badCreate.status === 503, '★不可用时写面同样 503(实际 ' + badCreate.status + ')');

// ══ 8) 取消对**真实** checker 的核对历史零写入(本地 I/O 在飞取消;全程无网络)════════════
// 判据分两半:① 断开/卸载那两次 ⇒ checks 零行;② 正对照(同一条正常核对)⇒ **恰好 1 行**。
// 只有 ② 成立,① 才能说明"取消没写",而不是"这条条目根本写不进"。
section('8) 取消不写库(真 LibraryRuntime):客户端断开 / 插件卸载 / 正对照');
const bigDir = join(tmp, 'src-big');
mkdirSync(bigDir, { recursive: true });
const bigFile = join(bigDir, 'big.txt');
const BIG_BYTES = 16 * 1024 * 1024;
// 16 MiB 本地源:读源要分 ~256 个 64 KiB 块 + sha256 + UTF-8 解码 ⇒ "在飞"窗口足够宽,
// 于是"客户端断开"一定能落在核对**进行中**(否则这条测试会时红时绿)。
writeFileSync(bigFile, 'alpha\n' + 'x'.repeat(BIG_BYTES) + '\n', 'utf8');
const cancelData = join(tmp, 'rt-cancel');
mkdirSync(cancelData, { recursive: true });
const rt2 = new LibraryRuntime(cancelData, { codeRoots: [bigDir], limits: { sourceMaxBytes: 32 * 1024 * 1024 } });
const cancelSeen = { signals: [] };
// 薄**转发壳**(只为观测 check 入口;真实工作仍由 rt2 这个真 runtime 做,壳不是实现):
const rt2probe = { limits: rt2.limits };
for (const m of ['status', 'search', 'get', 'history', 'checks', 'create', 'revise', 'withdraw', 'close']) {
  rt2probe[m] = (...a) => rt2[m](...a);
}
const api4 = await wire(rt2probe);
const bigCreated = await call(api4.base, 'POST', '/api/dsh-ling/library/create', {
  item: {
    ...OUR_ITEM, title: '大源取消用例', source_ref: bigFile,
    check_spec: { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'alpha', comparison: 'exact' },
  },
});
check(bigCreated.status === 200, '大源条目建好了(实际 ' + bigCreated.status + '/' + JSON.stringify(bigCreated.json).slice(0, 120) + ')');
const bigId = bigCreated.json.item.id;
const countChecksHttp = async (base, id) => Number((await call(base, 'GET', '/api/dsh-ling/library/checks?id=' + encodeURIComponent(id))).json.total);
check(await countChecksHttp(api4.base, bigId) === 0, '起点:这条条目**还没有**任何核对留痕');

// ① 客户端断开:一旦 API 真把 check 交给运行时,立刻掐断 fetch(不等它读完源)
let abortClient = () => {};
rt2probe.check = (id, opts) => {
  cancelSeen.signals.push(opts && opts.signal);
  queueMicrotask(() => abortClient());   // 落在 checker 第一个 await 上 ⇒ 必定"在飞"
  return rt2.check(id, opts);
};
const ac4 = new AbortController();
abortClient = () => ac4.abort();
const dropped4 = await fetch(api4.base + '/api/dsh-ling/library/check', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: bigId }), signal: ac4.signal,
}).then((r) => ({ status: r.status })).catch((e) => ({ aborted: true, name: String(e && e.name) }));
check(dropped4.aborted === true, '客户端断开 ⇒ fetch 被取消(实际 ' + JSON.stringify(dropped4) + ')');
await sleep(300);   // 服务端"发现断开"比客户端 abort 晚一两拍(与第 5 节同一条实测)
const sig4 = cancelSeen.signals[cancelSeen.signals.length - 1];
check(!!sig4 && sig4.aborted === true && !!sig4.reason && sig4.reason.cancelled === true,
  '★断开传到**真** checker:signal.reason.cancelled=true(那一支不写库)');
check(rt2.status().checker.activeCount === 0, '★那次核对已经收尾(activeCount 回 0;实际 ' + rt2.status().checker.activeCount + ')');
check(await countChecksHttp(api4.base, bigId) === 0,
  '★断开那一次对**真实**核对历史零写入(实际 ' + await countChecksHttp(api4.base, bigId) + ' 行)');

// ② 插件卸载:check 入口即 dispose(API disposer 会 abort 它挂起的核对)
let unloadSeen = null;
rt2probe.check = (id, opts) => {
  unloadSeen = opts && opts.signal;
  queueMicrotask(() => api4.dispose());
  return rt2.check(id, opts);
};
const dropUnload = await call(api4.base, 'POST', '/api/dsh-ling/library/check', { id: bigId });
check(!!unloadSeen && unloadSeen.aborted === true && !!unloadSeen.reason && unloadSeen.reason.code === 'unloaded',
  '★API disposer 取消了挂起的**真**核对(reason.code=unloaded)');
check(dropUnload.json && dropUnload.json.cancelled === true && dropUnload.json.reason === 'aborted',
  '被卸载取消的那次如实回 cancelled(reason 是 checker 内部码 aborted;实际 ' + JSON.stringify(dropUnload.json || {}).slice(0, 140) + ')');
await sleep(300);
const afterUnloadTotal = Number((await rt2.checks(bigId, {})).total);
check(afterUnloadTotal === 0, '★卸载那一次同样零写入核对历史(直接问 runtime,实际 ' + afterUnloadTotal + ' 行)');

// ③ 正对照:同一条条目正常核对**会**写一行
rt2probe.check = (id, opts) => rt2.check(id, opts);
const api4b = await wire(rt2probe);
const okBig = await call(api4b.base, 'POST', '/api/dsh-ling/library/check', { id: bigId });
check(okBig.status === 200 && okBig.json.ok === true && okBig.json.recorded === true && okBig.json.adopted === true,
  '★正对照:同一条正常核对 ok+recorded+adopted(实际 ' + JSON.stringify(okBig.json || {}).slice(0, 160) + ')');
check(await countChecksHttp(api4b.base, bigId) === 1,
  '★正对照落下**恰好 1 行** ⇒ 两次取消确实一行都没写(实际 ' + await countChecksHttp(api4b.base, bigId) + ' 行)');

await api3.close().catch(() => {});
await apiOff.close().catch(() => {});
await apiBad.close().catch(() => {});
await api4.close().catch(() => {});
await api4b.close().catch(() => {});
await rt.close().catch(() => {});
await rtOff.close().catch(() => {});
await rtBad.close().catch(() => {});
await rt2.close().catch(() => {});

// ══ 9) F16:具名文案必须**到得了眼前**(工具层拒 + store 拒,同一句话)══════════════════
//   蓝 3 的 A2:store 回 `invalid_limit`(下划线)而工具具名分支只登记 `invalid-limit`(连字符)
//   ⇒ 那句「limit 不合法(1..100 的整数)」**物理不可达**,永远回退成「理据见 reason=invalid_limit」。
//   本节判**两件事**:① 工具层自己就把 101/9999 拒掉(不到 store);② 两种来源都落到**同一句具名文案**。
section('9) F16:limit 契约 + invalid_limit 具名文案可达(两个来源)');
{
  const reg16 = [];
  // ⚠️ 工具调的是 `library.search(query)`(**单对象**形式,见 tools.js 的 librarySearchSpec)——
  //   桩按 `(q, opts)` 收会静默拿到 undefined,让"正对照"假红。
  const store16 = { seen: [], search: (query) => { store16.seen.push({ ...(query || {}) }); return { ok: true, items: [], count: 0, truncated: false }; } };
  registerLingTools({ tools: { register: (s) => { reg16.push(s); return () => {}; } } },
    { gate: { snapshotIds: () => [] }, memory: { kvSet() {} }, settings: {}, library: store16 });
  const tool16 = reg16.find((s) => s.name === TOOL_LIBRARY_SEARCH);
  check(!!tool16 && typeof tool16.output?.render === 'function', 'library_search 在册且带 output.render(走真实渲染口)');
  const render16 = (v) => tool16.output.render([{}], v).map((x) => x.text).join('\n');

  // ① 工具层自己拒:store **一次都没被调用**(这才是"在工具层兑现")
  const over = await tool16.execute({ q: 'x', limit: 101 }, {});
  check(over.ok === false && over.reason === 'invalid_limit', '★limit=101 在工具层被拒(实际 ' + JSON.stringify(over.reason) + ')');
  check(store16.seen.length === 0, '★被拒时**没有**走到 store(此前是放行到 store 才拒)');
  // ② 具名文案可达(工具层来源)
  const rTool = render16(over);
  check(/limit 不合法/.test(rTool) && !/理据见 reason=/.test(rTool),
    '★工具层拒 ⇒ 落到具名文案(实际:' + rTool.slice(0, 100) + ')');
  // ③ 具名文案可达(store 来源:管理员把上限配小了,工具层放行、store 仍拒 ⇒ 同一句话)
  const rStore = render16({ ok: false, reason: 'invalid_limit', message: 'limit 必须是 1..20 的整数(默认 20)' });
  check(/limit 不合法/.test(rStore) && !/理据见 reason=/.test(rStore),
    '★store 拒(配小了的限额)⇒ **同一句**具名文案,不再掉进通用兜底(实际:' + rStore.slice(0, 100) + ')');
  check(/1\.\.20/.test(rStore), '★store 的具体限额原文照旧附在后面(具名文案不吞掉细节)');
  // ④ 正对照:合法 limit 照常走到 store,且 offset 的理由词同样统一
  const okIn = await tool16.execute({ q: 'x', limit: 100 }, {});
  check(okIn.ok === true && store16.seen.length === 1 && store16.seen[0].limit === 100, '正对照:limit=100 走到 store 且原样透传');
  const badOff = render16({ ok: false, reason: 'invalid_offset', message: 'offset 必须是 >= 0 的整数' });
  check(/offset 不合法/.test(badOff) && !/理据见 reason=/.test(badOff), '★offset 同一族:invalid_offset 也落到具名文案');
}

// ── 收尾:关掉一切再删临时目录(Windows 上库文件还开着就删不掉)─────────────────────
if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome;
try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { check(false, '临时目录清理失败:' + e.message); }
console.log('\n断言 ' + assertions + ' 条,失败 ' + failures + ' 条');
if (failures) process.exitCode = 1; else console.log('✓ library-api-tools 全部通过');
