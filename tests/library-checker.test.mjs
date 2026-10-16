// 1.7 图书馆 · **裁判员(library-checker)独立针对性测试**。
//
// 口径(派单要求):
//   · 全部走 node: 内置模块;**零真实网络** —— 官方文档面的 resolver/requester 一律用注入的受信钩子
//     (契约 §Checker Surface:这两个钩子是管理员代码,永不是条目载荷)。§10.5 用模块替身覆盖
//     `defaultRequester`/`defaultResolver` 的**默认路径调用形状与钉住语义**;网络本身无实测;
//     `checkerFor()` 自带自锁:带 officialUrls 的 checker 必须同时注入 resolver 与 requester,
//     否则测试自己抛错 —— 免得哪天"顺手"连上真网。
//   · 自有**临时 SQLite 库**(LibraryStore,真库真表)+ 自有**临时源根**(mkdtempSync)。
//   · 断言用 node:assert/strict,每条都有可度量的计数;失败即计数减少 —— 红/绿都能当证据用。
//   · 每一次 check 都套 4 s 看门狗(`settled`):挂住 = 一条失败,而不是把整个套件吊死。
//   · 时间相关的三处(异步超时 / 阻塞式同步 requester 超时 / 挂死 body 超时)是**故意**的等待,
//     不是"忙着轮询"。
//
// 覆盖清单(与派单一一对应):
//   §1 构造与配置校验(未知键/重复限额/非法根/非法 URL 清单;status())
//   §2 本地源:根允许、遍历、非文件、realpath/junction 逃逸、坏 UTF-8、watchdog
//   §3 official-doc:精确 URL 允许清单(查询串/片段/大小写/端口/凭据/私网 DNS/IP 形态)
//   §4 HTTP 面:状态码/重定向/MIME/charset/content-encoding/content-length/流式字节上限/chunk
//   §5 限额:取源字节、选中字节/行数(checker 限额独立于 store 限额)
//   §6 三态:ok / wrong / unknown 的确定性,类型严格结构比较,成员顺序无关,LF-only 比较
//   §7 RFC 6901 与 missing 位置 = unknown(不是 wrong);非有限值 / -0 一律拒绝(BOM 口径见同段)
//   §8 并发:per-item in-flight、concurrency_limit、close 幂等、取消(preflight/请求中/挂死 body)
//   §9 陈旧修订:留痕 + 不采纳 + 不污染新版本(含**在飞时**经真实 deferred 请求修订)
//  §10 证据结构(键集固定、可序列化、哈希独立复算)与 store 异常不吞
//  §10.5 公开默认传输(defaultRequester/defaultResolver)以模块替身验证调用形状与钉住语义(网络本身无实测)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import * as dnsNamespace from 'node:dns/promises';
import * as httpsNamespace from 'node:https';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LibraryStore } = await import(pathToFileURL(join(root, 'lib/host/library-store.js')).href);
const { LibraryChecker } = await import(pathToFileURL(join(root, 'lib/host/library-checker.js')).href);

// ── 断言骨架(与 library-store.test.mjs 同款计数法)────────────────────────────
let assertions = 0;
let failed = 0;
let sectionName = '(none)';
async function count(target, message) {
  assertions += 1;
  try {
    await target();
  } catch (e) {
    failed += 1;
    const text = String(e?.message ?? e).split('\n').slice(0, 5).join('\n     ');
    console.log(`  ✗ [${sectionName}] ${message}\n     ${text}`);
  }
}
const section = (name) => { sectionName = name; console.log(`── ${name}`); };
const note = (label, value) => { console.log(`  · ${label}: ${JSON.stringify(value)}`); };

/** 看门狗:promise 必须在 ms 内结算,否则算一条失败(而不是吊死套件)。 */
async function settled(promise, ms, label) {
  let timer;
  const outcome = await Promise.race([
    Promise.resolve(promise).then((value) => ({ done: true, value }), (error) => ({ done: true, error })),
    new Promise((resolveRace) => { timer = setTimeout(() => resolveRace({ timeout: true }), ms); }),
  ]);
  clearTimeout(timer);
  if (outcome.timeout) throw new Error(`${label}:${ms} ms 内没有结算(疑似挂住)`);
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

/** Node 的 events.getEventListeners 支持 EventTarget;取不到就返回 -1(=未测,不冒充 0)。 */
function listenerCount(target) {
  try { return getEventListeners(target, 'abort').length; } catch { return -1; }
}

// ── 临时库与临时源根 ──────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'ling-libcheck-'));
const dbFile = join(dir, 'library.db');
const store = new LibraryStore(dbFile);

const rootA = join(dir, 'rootA');       // 已登记根(允许读)
const rootB = join(dir, 'rootB');       // 未登记根(不允许读)
const outside = join(dir, 'outside');   // 逃逸靶子(junction 指向它)
for (const d of [rootA, rootB, outside]) mkdirSync(d);

const ALPHA = 'alpha\nbeta\ngamma\n';
const ALPHA_PATH = join(rootA, 'alpha.txt');
const CRLF_PATH = join(rootA, 'crlf.txt');
const LONELY_PATH = join(rootA, 'lonely.txt');
const LONG_PATH = join(rootA, 'long.txt');
const BIG_PATH = join(rootA, 'big.txt');
const BAD_PATH = join(rootA, 'bad-utf8.txt');
const DOC_PATH = join(rootA, 'doc.json');
const CRLF_JSON_PATH = join(rootA, 'crlf.json');
const NONFINITE_PATH = join(rootA, 'nonfinite.json');
const NEGZERO_TOP_PATH = join(rootA, 'negzero-top.json');
const NEGZERO_NEST_PATH = join(rootA, 'negzero-nest.json');
const STALE_PATH = join(rootA, 'stale.txt');
const OUTSIDE_PATH = join(outside, 'outside.txt');
const OTHER_ROOT_PATH = join(rootB, 'b.txt');

writeFileSync(ALPHA_PATH, ALPHA, 'utf8');
writeFileSync(CRLF_PATH, 'l1\r\nl2\r\n', 'utf8');
writeFileSync(LONELY_PATH, 'lonely', 'utf8');
writeFileSync(LONG_PATH, 'L'.repeat(200) + '\n', 'utf8');
writeFileSync(BIG_PATH, 'x'.repeat(4096), 'utf8');
writeFileSync(BAD_PATH, Buffer.from([0xff, 0xfe, 0x41]));
writeFileSync(CRLF_JSON_PATH, '{"crlf":"x\\r\\ny\\r\\n"}', 'utf8');
writeFileSync(NONFINITE_PATH, '{"nest":{"deep":-1e999},"top":1e999}', 'utf8');
writeFileSync(NEGZERO_TOP_PATH, '-0', 'utf8');                      // 源文件整体就是 -0
writeFileSync(NEGZERO_NEST_PATH, '{"nest":{"deep":-0},"sib":1}', 'utf8'); // 嵌套成员是 -0
writeFileSync(STALE_PATH, 'stale v1\n', 'utf8');
writeFileSync(OUTSIDE_PATH, 'outside\n', 'utf8');
writeFileSync(OTHER_ROOT_PATH, 'beta file\n', 'utf8');

const DOC = {
  obj: { a: 1, b: [1, 2] }, num: 1, str: '1', bool: true, nil: null,
  esc: { 'a/b': 7, 'c~d': 8 }, arr: ['x', 'y'], ver: '1.7.0', case: 'AbC', ws: '  pad  ',
};
writeFileSync(DOC_PATH, JSON.stringify(DOC), 'utf8');

const sha256Of = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// ── 受信钩子与假响应 ──────────────────────────────────────────────────────────
const httpCalls = [];
function recordingRequester(make) {
  return async (url, info) => {
    httpCalls.push({
      href: url.href, isURL: url instanceof URL, address: info.address, family: info.family,
      maxBytes: info.maxBytes, timeoutMs: info.timeoutMs, hasSignal: info.signal instanceof AbortSignal,
    });
    return make(url, info);
  };
}
function makeBody(chunks, hang) {
  const state = { destroyed: false };
  const body = {
    destroy() { state.destroyed = true; },
    [Symbol.asyncIterator]() {
      if (hang) return { next: () => new Promise(() => {}) };
      let i = 0;
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      };
    },
  };
  return { body, state };
}
function response({ statusCode = 200, headers = { 'content-type': 'application/json' }, chunks = [Buffer.from('{"a":1}')], url, hang = false, body } = {}) {
  const made = body === undefined ? makeBody(chunks, hang) : { body, state: { destroyed: false } };
  const out = { statusCode, headers, body: made.body };
  if (url !== undefined) out.url = url;
  return { response: out, state: made.state };
}
function responderFor(spec) {
  const holder = { calls: [], body: null };
  const requester = recordingRequester(async (url, info) => {
    holder.calls.push({ href: url.href, address: info.address, family: info.family, maxBytes: info.maxBytes, timeoutMs: info.timeoutMs, hasSignal: info.signal instanceof AbortSignal });
    if (typeof spec === 'function') return spec(url, info);
    const made = response(spec);
    holder.body = made.state;
    return made.response;
  });
  return { requester, holder };
}
const PUBLIC4 = [{ address: '93.184.216.34', family: 4 }];
const PUBLIC6 = [{ address: '2606:4700:4700::1111', family: 6 }];
const resolverBox = (records) => {
  const box = { calls: 0 };
  const resolver = async () => { box.calls += 1; return typeof records === 'function' ? records() : records; };
  return { resolver, box };
};
function deferred() {
  let resolvePromise; let rejectPromise;
  const promise = new Promise((resolveP, rejectP) => { resolvePromise = resolveP; rejectPromise = rejectP; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

// ── 条目 / checker 工厂 ───────────────────────────────────────────────────────
const checkers = [];
const track = (c) => { checkers.push(c); return c; };
const URL_DOC = 'https://example.com/doc.json';

function checkerFor(config = {}) {
  const urls = config.officialUrls ?? [];
  if (urls.length > 0 && (config.requester === undefined || config.resolver === undefined)) {
    throw new Error('测试自锁:带 officialUrls 的 checker 必须注入 resolver 与 requester(禁止真网络)');
  }
  return track(new LibraryChecker(store, { codeRoots: [rootA], ...config }));
}
function officialChecker({ urls = [URL_DOC], records = PUBLIC4, spec = { chunks: [Buffer.from('{"a":1}')] }, ...rest } = {}) {
  const { requester, holder } = responderFor(spec);
  const { resolver, box } = resolverBox(records);
  return { checker: checkerFor({ officialUrls: urls, resolver, requester, ...rest }), holder, box };
}

let itemSeq = 0;
function mkItem(over = {}) {
  const payload = {
    title: `靶子 ${++itemSeq}`, body: 'checker 测试正文', category: 'boundary',
    source_kind: 'our-code', source_ref: ALPHA_PATH, as_of: '2026-10-06', ...over,
  };
  const res = store.create(payload);
  if (!res.ok) throw new Error(`建条目失败(${res.reason}):${res.message ?? ''}`);
  return res.item;
}
const mkOfficial = (ref, spec) => mkItem({
  source_kind: 'official-doc', source_ref: ref, check_spec: spec ?? linesSpec('placeholder'),
});
const linesSpec = (expected, start = 1, end = 1, comparison = 'exact') => ({
  locator: { kind: 'lines', start, end }, expected, comparison,
});
const ptrSpec = (pointer, expected, comparison = 'exact') => ({
  locator: { kind: 'json-pointer', pointer }, expected, comparison,
});
const st = (id) => store.get(id).item;

// ─────────────────────────────────────────────────────────────────────────────
section('1) 构造与配置校验(配置错误要响亮,别名不越界)');
await count(() => assert.equal(typeof LibraryChecker, 'function'), 'LibraryChecker 是构造函数');
for (const m of ['check', 'close', 'status']) {
  await count(() => assert.equal(typeof LibraryChecker.prototype[m], 'function'), `checker.${m}() 存在(契约签名三方法)`);
}
await count(() => assert.throws(() => new LibraryChecker(null, {}), TypeError), 'store=null 抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker({}, {}), TypeError), 'store 缺 get/recordCheck 抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker(store, 5), TypeError), 'config 非普通对象抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker(store, { nope: 1 }), /unknown checker config key/), '未知 config 键抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { limits: { nope: 1 } }), /unknown checker limit/), '未知限额键抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { limits: { selectionMaxBytes: 4096 } }), /unknown checker limit/),
  'store 短名别名不在 checker 面(别名只是存储构造兼容)');
await count(() => assert.throws(() => new LibraryChecker(store, { limits: { checkTimeoutMs: 5000 }, checkTimeoutMs: 1000 }), /duplicate checker limit/),
  '同名限额给两处抛错(不猜)');
await count(() => assert.throws(() => new LibraryChecker(store, { limits: 5 }), TypeError), 'limits 非普通对象抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker(store, { resolver: 5 }), TypeError), 'resolver 非函数抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker(store, { requester: 'x' }), TypeError), 'requester 非函数抛 TypeError');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: 'x' }), /codeRoots must be an array/), 'codeRoots 非数组抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: ['relative/dir'] }), /absolute local paths/), '相对根路径抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: [rootA + '\\..\\outside'] }), /without traversal/), '含 .. 的根抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: [ALPHA_PATH] }), /existing directories/), '根指向普通文件抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: [join(rootA, 'nope-dir')] }), /ENOENT/), '不存在的根抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { codeRoots: new Array(257).fill(rootA) }), /at most 256/), '根数量上限 256');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: 'x' }), /must be an array/), 'officialUrls 非数组抛错');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['http://example.com/x'] }), /https_required/), 'http URL 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['https://u:p@example.com/x'] }), /url_credentials_forbidden/), '带凭据 URL 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['https://127.0.0.1/x'] }), /private_target/), '回环 IP 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['https://[::ffff:93.184.216.34]/x'] }), /private_target/), 'IPv4 映射 IPv6 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['https://localhost/x'] }), /private_target/), 'localhost 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: ['not a url'] }), /invalid_url/), '非 URL 不许登记');
await count(() => assert.throws(() => new LibraryChecker(store, { officialUrls: new Array(1001).fill('https://example.com/x') }), /at most 1000/), 'URL 数量上限 1000');
await count(() => assert.throws(() => checkerFor({ officialUrls: [URL_DOC] }), /测试自锁/), '自锁:带官方 URL 必须注入传输钩子(防真网络)');
{
  const plain = checkerFor();
  const s = plain.status();
  await count(() => assert.equal(s.closed, false), 'status().closed=false');
  await count(() => assert.equal(s.activeCount, 0), 'status().activeCount=0');
  await count(() => assert.equal(s.codeRootCount, 1), 'status().codeRootCount=1');
  await count(() => assert.equal(s.officialUrlCount, 0), 'status().officialUrlCount=0');
  await count(() => assert.equal(s.transport, 'native-https'), '未注入钩子 => transport=native-https(本文件不对它发起任何取源)');
  await count(() => assert.deepEqual(Object.keys(s.limits).sort(),
    ['checkConcurrency', 'checkTimeoutMs', 'selectedTextMaxBytes', 'selectedTextMaxLines', 'sourceMaxBytes']),
  'status().limits 只含五个裁判员限额键');
  await count(() => assert.equal(s.limits.checkTimeoutMs, 10000), '默认超时 10 s 透传');
  await count(() => assert.equal(s.limits.checkConcurrency, 2), '默认并发 2 透传');
  const tuned = checkerFor({ limits: { checkTimeoutMs: 1234, selectedTextMaxLines: 7 } });
  await count(() => assert.equal(tuned.status().limits.checkTimeoutMs, 1234), 'checker 限额可覆盖');
  await count(() => assert.equal(tuned.status().limits.selectedTextMaxLines, 7), 'checker 限额按 store 同一套区间校验');
  await count(() => assert.throws(() => checkerFor({ limits: { sourceMaxBytes: 10 } }), /越界/), '越界限额在构造期响亮抛错');
  const injected = checkerFor({ codeRoots: [rootA], requester: recordingRequester(async () => response().response), resolver: resolverBox(PUBLIC4).resolver });
  await count(() => assert.equal(injected.status().transport, 'trusted-injected'), '注入钩子 => transport=trusted-injected');
}

// ─────────────────────────────────────────────────────────────────────────────
section('2) 本地源:根允许 / 遍历 / 非文件 / realpath 逃逸');
const localChecker = checkerFor();
{
  const item = mkItem({ check_spec: linesSpec('alpha') });
  const res = await settled(localChecker.check(item.id), 4000, '本地 ok');
  await count(() => assert.equal(res.ok, true), 'ok 回执 ok=true');
  await count(() => assert.equal(res.state, 'ok'), '选中行与 expected 一致 => state=ok');
  await count(() => assert.equal(res.recorded, true), 'ok 已落库 recorded=true');
  await count(() => assert.equal(res.adopted, true), 'active 未变 => adopted=true');
  await count(() => assert.equal(res.reason, null), 'ok 的 reason=null');
  await count(() => assert.equal(res.item_id, item.id), '回执点名 item_id');
  await count(() => assert.equal(res.item_hash, item.content_hash), '回执带本次核对对象的 item_hash');
  await count(() => assert.equal(res.evidence.requested_source, item.source_ref), 'evidence.requested_source = 条目 source_ref');
  await count(() => assert.equal(res.evidence.actual_source, realpathSync(ALPHA_PATH)), 'evidence.actual_source = realpath(源)');
  await count(() => assert.equal(res.evidence.source_hash, sha256Of(readFileSync(ALPHA_PATH))), 'evidence.source_hash 与独立复算的 sha256 一致');
  await count(() => assert.equal(res.evidence.observed, 'alpha'), 'observed 就是选中的那一行');
  await count(() => assert.equal(st(item.id).checked_state, 'ok'), '条目 checked_state 被采纳为 ok');
  await count(() => assert.equal(store.checks(item.id).total, 1), '核对历史 1 条');
  await count(() => assert.equal(store.checks(item.id).checks[0].observed, 'alpha'), '历史里落的是 observed=alpha');

  const wrong = mkItem({ check_spec: linesSpec('zzz') });
  const wres = await settled(localChecker.check(wrong.id), 4000, '本地 wrong');
  await count(() => assert.equal(wres.state, 'wrong'), '不一致 => state=wrong');
  await count(() => assert.equal(wres.reason, 'declared_comparison_mismatch'), 'wrong 的 reason 点名"声明的比较不一致"');
  await count(() => assert.equal(wres.adopted, true), 'wrong 也是有效认证(内容没被取代)=> adopted=true');
  await count(() => assert.equal(st(wrong.id).checked_state, 'wrong'), '条目 checked_state=wrong');
}
{ // 未登记根 / 遍历 / 相对路径
  const c = checkerFor();
  const outsideRoot = mkItem({ source_ref: OTHER_ROOT_PATH, check_spec: linesSpec('beta file') });
  const r1 = await settled(c.check(outsideRoot.id), 4000, '未登记根');
  await count(() => assert.equal(r1.state, 'unknown'), '根没登记 => unknown(不是 wrong)');
  await count(() => assert.equal(r1.reason, 'code_root_not_allowed'), '未登记根 reason=code_root_not_allowed');

  // ⚠️ 这里必须用字符串拼接:path.join 会把 `..` 归一掉,那样测的就不是"遍历守卫"了(本测试初版踩过这个坑)。
  const traversal = mkItem({
    source_ref: rootA + sep + '..' + sep + 'outside' + sep + 'outside.txt',
    check_spec: linesSpec('outside'),
  });
  const r2 = await settled(c.check(traversal.id), 4000, '遍历路径');
  await count(() => assert.equal(r2.reason, 'absolute_local_path_required'), '路径含 .. => 直接拒绝(不做路径归一后放行)');

  const relative = mkItem({ source_ref: 'alpha.txt', check_spec: linesSpec('alpha') });
  const r3 = await settled(c.check(relative.id), 4000, '相对路径');
  await count(() => assert.equal(r3.reason, 'absolute_local_path_required'), '相对路径拒绝');

  const noRoots = track(new LibraryChecker(store, {}));
  const orphan = mkItem({ source_ref: ALPHA_PATH, check_spec: linesSpec('alpha') });
  const r4 = await settled(noRoots.check(orphan.id), 4000, '默认无根');
  await count(() => assert.equal(r4.reason, 'code_root_not_allowed'), 'codeRoots 默认空 => 合法绝对路径也不可读');
  await count(() => assert.equal(r4.state, 'unknown'), '无根拒绝是 unknown(不是 wrong)');
  const r5 = await settled(noRoots.check(traversal.id), 4000, '默认无根 + 遍历');
  await count(() => assert.equal(r5.reason, 'absolute_local_path_required'), '遍历守卫先于根守卫(两重拒绝,顺序稳定)');
}
{ // 非文件 / 不存在 / 坏 UTF-8
  const c = checkerFor();
  const dirItem = mkItem({ source_ref: rootA, check_spec: linesSpec('x') });
  const rDir = await settled(c.check(dirItem.id), 4000, '目录当源');
  note('目录当源的实测 reason', rDir.reason);
  await count(() => assert.equal(rDir.state, 'unknown'), '源是目录 => unknown');
  await count(() => assert.ok(['source_not_regular_file', 'source_io_failure'].includes(rDir.reason),
    `目录源的 reason 必须是"非普通文件"或 I/O 失败(实测 ${rDir.reason})`), '目录源的 reason 可判定');

  const ghost = mkItem({ source_ref: join(rootA, 'nope.txt'), check_spec: linesSpec('x') });
  const rGhost = await settled(c.check(ghost.id), 4000, '不存在的文件');
  await count(() => assert.equal(rGhost.state, 'unknown'), '不存在的本地源 => unknown');
  await count(() => assert.equal(rGhost.reason, 'source_io_failure'), 'realpath 失败归为 source_io_failure');

  const bad = mkItem({ source_ref: BAD_PATH, check_spec: linesSpec('alpha') });
  const rBad = await settled(c.check(bad.id), 4000, '坏 UTF-8');
  await count(() => assert.equal(rBad.state, 'unknown'), '非法 UTF-8 => unknown');
  await count(() => assert.equal(rBad.reason, 'invalid_utf8'), '非法 UTF-8 reason=invalid_utf8');
}
{ // realpath / junction 逃逸
  const c = checkerFor();
  let junctionMade = false;
  try {
    symlinkSync(outside, join(rootA, 'junc'), 'junction');
    junctionMade = true;
  } catch (e) { note('junction 创建失败(跳过该用例)', String(e?.code ?? e?.message ?? e)); }
  if (junctionMade) {
    const escaped = mkItem({ source_ref: join(rootA, 'junc', 'outside.txt'), check_spec: linesSpec('outside') });
    const r = await settled(c.check(escaped.id), 4000, 'junction 逃逸');
    await count(() => assert.equal(r.state, 'unknown'), 'junction 逃逸 => unknown');
    await count(() => assert.equal(r.reason, 'symlink_escape'), 'junction 指向根外 => symlink_escape(按 realpath 判,不按词法判)');
  }
  let fileLinkMade = false;
  try {
    symlinkSync(OTHER_ROOT_PATH, join(rootA, 'link.txt'), 'file');
    fileLinkMade = true;
  } catch (e) { note('文件符号链接创建失败(跳过该用例)', String(e?.code ?? e?.message ?? e)); }
  if (fileLinkMade) {
    const linkItem = mkItem({ source_ref: join(rootA, 'link.txt'), check_spec: linesSpec('beta file') });
    const r = await settled(c.check(linkItem.id), 4000, '符号链接逃逸');
    await count(() => assert.equal(r.reason, 'symlink_escape'), '文件符号链接指向根外 => symlink_escape');
  }
  const inside = mkItem({ source_ref: ALPHA_PATH, check_spec: linesSpec('alpha') });
  const rIn = await settled(c.check(inside.id), 4000, '正常文件仍可读');
  await count(() => assert.equal(rIn.state, 'ok'), '同一 checker 里正常文件仍 ok(逃逸拒绝没有误伤)');
}
{ // 回归守卫(曾经是红):把 **junction 路径本身登记为根** 时,根下的合法文件被误判成逃逸。
  // 根因:normalizeRoots 原先用 JS 版 realpathSync,readCode 用 async realpath;本环境实测前者
  // **不解析** Windows junction、后者解析 ⇒ root.real 仍是 junction 自己而 actual 已指向真实目录
  // ⇒ contained 为假 ⇒ symlink_escape。主线改为 realpathSync.native(与 promises.realpath 同口径)后转绿。
  // ⚠️ 这只是**本机同步 fallback 的行为差异**,不是"所有 Windows/OneDrive 都如此"的已证结论。
  const juncRoot = join(dir, 'junc-as-root');
  let made = false;
  try { symlinkSync(outside, juncRoot, 'junction'); made = true; } catch (e) { note('junction 根用例建立失败(跳过)', String(e?.code ?? e)); }
  if (made) {
    const c = track(new LibraryChecker(store, { codeRoots: [juncRoot] }));
    const item = mkItem({ source_ref: join(juncRoot, 'outside.txt'), check_spec: linesSpec('outside') });
    const r = await settled(c.check(item.id), 4000, 'junction 登记为根');
    let asyncReal = null;
    let jsSync = null;
    let nativeSync = null;
    try { asyncReal = await realpath(juncRoot); } catch { /* 下面 note 里如实标 null */ }
    try { jsSync = realpathSync(juncRoot); } catch { /* 同上 */ }
    try { nativeSync = realpathSync.native(juncRoot); } catch { /* 同上 */ }
    note('junction 登记为根(每次运行都记现场,绿也要有证据)', {
      source_ref: item.source_ref, state: r.state, reason: r.reason,
      realpathSync_JS: jsSync, realpathSync_native: nativeSync, asyncRealpath: asyncReal,
    });
    await count(() => assert.equal(r.state, 'ok',
      `登记过的根下合法文件应可读;实测 ${r.state}/${r.reason}(根是 junction 时 realpathSync 与 async realpath 不一致)`),
    '登记为根的 junction 目录下,合法文件仍应判 ok(不得误判 symlink_escape)');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('3) official-doc:精确 URL 允许清单与 SSRF 前置拒绝');
{
  const { checker, holder, box } = officialChecker({ spec: { chunks: [Buffer.from('{"a":1}')] } });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 4000, 'official ok');
  await count(() => assert.equal(res.state, 'ok'), '登记过的精确 URL => ok');
  await count(() => assert.equal(res.evidence.actual_source, URL_DOC), 'actual_source 就是登记的 URL');
  await count(() => assert.equal(res.evidence.observed, 1), 'JSON 数值 1 保类型(不是字符串)');
  await count(() => assert.equal(res.evidence.source_hash, sha256Of(Buffer.from('{"a":1}'))), 'source_hash 覆盖响应字节');
  await count(() => assert.equal(holder.calls.length, 1), 'requester 恰好调用一次');
  await count(() => assert.equal(holder.calls[0].address, '93.184.216.34'), '连接地址用的是解析结果(钉住 DNS)');
  await count(() => assert.equal(holder.calls[0].family, 4), 'family 一并交给传输');
  await count(() => assert.equal(holder.calls[0].maxBytes, 2097152), 'maxBytes = 生效的取源上限');
  await count(() => assert.equal(holder.calls[0].timeoutMs, 10000), 'timeoutMs = 生效的核对超时(超时预算也交给传输)');
  await count(() => assert.equal(holder.calls[0].hasSignal, true), '传输收到 AbortSignal(取消/超时可传导)');
  await count(() => assert.equal(box.calls, 1), '域名走注入 resolver');
  await count(() => assert.equal(holder.body.destroyed, true), '读完 body 后 destroy() 被调用(不悬着连接)');
}
const urlCases = [
  ['主机大小写归一后命中', 'https://EXAMPLE.com/doc.json', null],
  ['显式 443 端口归一后命中', 'https://example.com:443/doc.json', null],
  ['重复登记同一 URL 去重', URL_DOC, null],
  ['路径大小写不同', 'https://example.com/DOC.json', 'official_url_not_allowed'],
  ['查询串变化', `${URL_DOC}?x=1`, 'official_url_not_allowed'],
  ['片段变化', `${URL_DOC}#f`, 'official_url_not_allowed'],
  ['尾斜杠变化', `${URL_DOC}/`, 'official_url_not_allowed'],
  ['http 明文', 'http://example.com/doc.json', 'https_required'],
  ['明文凭据', 'https://u:p@example.com/doc.json', 'url_credentials_forbidden'],
  ['只有用户名', 'https://u@example.com/doc.json', 'url_credentials_forbidden'],
  ['localhost', 'https://localhost/doc.json', 'private_target'],
  ['.local 内网名', 'https://svc.local/doc.json', 'private_target'],
  ['尾点主机名', 'https://example.com./doc.json', 'private_target'],
  ['私网 IPv4', 'https://192.168.1.10/doc.json', 'private_target'],
  ['回环 IPv4', 'https://127.0.0.1/doc.json', 'private_target'],
  ['IPv6 回环', 'https://[::1]/doc.json', 'private_target'],
  ['IPv4 映射 IPv6', 'https://[::ffff:93.184.216.34]/doc.json', 'private_target'],
  ['链路本地 IPv6', 'https://[fe80::1]/doc.json', 'private_target'],
  ['文档用 IPv4 段', 'https://203.0.113.7/doc.json', 'private_target'],
  ['URL 内空白', 'https://example.com/do c.json', 'invalid_url'],
  ['URL 内控制字符', 'https://example.com/do\u0001c.json', 'invalid_url'],
];
for (const [label, ref, expectReason] of urlCases) {
  const { checker, holder } = officialChecker({ spec: { chunks: [Buffer.from('{"a":1}')] } });
  const item = mkOfficial(ref, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 4000, label);
  if (expectReason === null) {
    await count(() => assert.equal(res.state, 'ok', `${label}:期望 ok,实际 ${res.state}/${res.reason}`), `${label} => ok`);
  } else {
    await count(() => assert.equal(res.state, 'unknown', `${label}:期望 unknown,实际 ${res.state}`), `${label} => unknown`);
    await count(() => assert.equal(res.reason, expectReason, `${label}:期望 ${expectReason},实际 ${res.reason}`), `${label} reason=${expectReason}`);
    await count(() => assert.equal(res.recorded, true), `${label}:unknown 也要留档(历史有据)`);
    await count(() => assert.equal(holder.calls.length, 0), `${label}:拒绝发生在取源之前(requester 未被调用)`);
  }
}
{ // IP 字面量:跳过 DNS,直接钉住地址
  for (const [label, ref, address, family] of [
    ['公网 IPv4 字面量', 'https://93.184.216.34/x.json', '93.184.216.34', 4],
    ['公网 IPv6 字面量', 'https://[2606:4700:4700::1111]/x.json', '2606:4700:4700::1111', 6],
  ]) {
    const { checker, holder, box } = officialChecker({ urls: [ref], spec: { chunks: [Buffer.from('{"a":1}')] } });
    const item = mkOfficial(ref, ptrSpec('/a', 1));
    const res = await settled(checker.check(item.id), 4000, label);
    await count(() => assert.equal(res.state, 'ok', `${label}:实际 ${res.state}/${res.reason}`), `${label} 可核对`);
    await count(() => assert.equal(box.calls, 0), `${label}:IP 字面量不做 DNS 解析`);
    await count(() => assert.equal(holder.calls[0].address, address), `${label}:地址就是字面量`);
    await count(() => assert.equal(holder.calls[0].family, family), `${label}:family 与字面量一致`);
  }
}
{ // DNS 结果:私网/混合/畸形一律在连接前拒
  const dnsCases = [
    ['公网+私网混合记录', [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }], 'dns_private_or_invalid_address'],
    ['纯私网记录', [{ address: '10.0.0.1', family: 4 }], 'dns_private_or_invalid_address'],
    ['family 与地址不符', [{ address: '93.184.216.34', family: 6 }], 'dns_private_or_invalid_address'],
    ['记录不是普通对象', ['93.184.216.34'], 'dns_private_or_invalid_address'],
    ['空记录', [], 'dns_invalid_result'],
    ['非数组', { address: '93.184.216.34', family: 4 }, 'dns_invalid_result'],
    ['超过 64 条记录', Array.from({ length: 65 }, () => ({ address: '93.184.216.34', family: 4 })), 'dns_invalid_result'],
    ['IPv6 唯一本地地址', [{ address: 'fd00::1', family: 6 }], 'dns_private_or_invalid_address'],
  ];
  for (const [label, records, expectReason] of dnsCases) {
    const { checker, holder } = officialChecker({ records, spec: { chunks: [Buffer.from('{"a":1}')] } });
    const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
    const res = await settled(checker.check(item.id), 4000, label);
    await count(() => assert.equal(res.state, 'unknown', `${label}:实际 ${res.state}`), `${label} => unknown`);
    await count(() => assert.equal(res.reason, expectReason, `${label}:实际 ${res.reason}`), `${label} reason=${expectReason}`);
    await count(() => assert.equal(holder.calls.length, 0), `${label}:一条记录不合格就绝不发起连接`);
  }
  const failing = officialChecker({ records: async () => { throw new Error('dns down'); } });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(failing.checker.check(item.id), 4000, 'DNS 抛错');
  await count(() => assert.equal(res.state, 'unknown'), 'DNS 抛错 => unknown');
  await count(() => assert.equal(res.reason, 'dns_failure'), 'DNS 抛错 reason=dns_failure');
  await count(() => assert.equal(failing.holder.calls.length, 0), 'DNS 失败不发连接');
}
{ // 存储 srouce_ref 上限与 URL 上限同值:超长 URL 只能直接构造才可见
  const overlong = 'https://example.com/' + 'a'.repeat(4200);
  const item = {
    id: 'lib:00000000-0000-0000-0000-000000000001', content_hash: `sha256:${'a'.repeat(64)}`,
    source_kind: 'official-doc', source_ref: overlong, check_spec: ptrSpec('/a', 1),
  };
  const { requester, holder } = responderFor({ chunks: [Buffer.from('{"a":1}')] });
  const { resolver } = resolverBox(PUBLIC4);
  const stub = stubStore(item);
  const c = track(new LibraryChecker(stub, { officialUrls: [URL_DOC], resolver, requester }));
  const res = await settled(c.check(item.id), 4000, '超长 URL');
  await count(() => assert.equal(res.reason, 'invalid_url'), '超长 URL => invalid_url(仅直接构造可见:store 的 source_ref 上限同为 4096)');
  await count(() => assert.equal(holder.calls.length, 0), '超长 URL 不发连接');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4) HTTP 面:状态码 / MIME / 编码 / 长度 / 流式上限');
const httpCases = [
  ['301 重定向', { statusCode: 301 }, 'redirect_forbidden'],
  ['302 + 同 URL', { statusCode: 302, url: URL_DOC }, 'redirect_forbidden'],
  ['response.url 已变(跟随后落点)', { statusCode: 200, url: 'https://example.com/other.json' }, 'unexpected_response_url'],
  ['404', { statusCode: 404 }, 'http_status_not_ok'],
  ['204 无正文', { statusCode: 204 }, 'http_status_not_ok'],
  ['text/html', { headers: { 'content-type': 'text/html' } }, 'unsupported_mime'],
  ['缺 content-type', { headers: {} }, 'unsupported_mime'],
  ['charset=latin-1', { headers: { 'content-type': 'text/plain; charset=latin-1' } }, 'unsupported_mime'],
  ['text/csv 无 charset', { headers: { 'content-type': 'text/csv' } }, 'unsupported_mime'],
  ['重复 charset', { headers: { 'content-type': 'application/json; charset=utf-8; charset=utf-8' } }, 'unsupported_mime'],
  ['content-type 非字符串', { headers: { 'content-type': ['application/json'] } }, 'invalid_response_headers'],
  ['headers 不是普通对象', { headers: new Map([['content-type', 'application/json']]) }, 'invalid_response_headers'],
  ['content-encoding: gzip', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 'unsupported_content_encoding'],
  ['content-length 非数字', { headers: { 'content-type': 'application/json', 'content-length': 'abc' } }, 'invalid_content_length'],
  ['content-length 超上限', { headers: { 'content-type': 'application/json', 'content-length': '99999999' } }, 'source_too_large'],
  ['content-length 与实际不符', { headers: { 'content-type': 'application/json', 'content-length': '5' } }, 'incomplete_source'],
  ['chunk 不是 Uint8Array', { chunks: ['{"a":1}'] }, 'invalid_response_chunk'],
  ['body 不可异步迭代', { body: {} }, 'invalid_response_body'],
  ['响应是 null', () => null, 'invalid_http_response'],
  ['响应是数字', () => 42, 'invalid_http_response'],
  ['正文非法 UTF-8', { chunks: [Buffer.from([0xff, 0xfe, 0x41])] }, 'invalid_utf8'],
  ['正文不是合法 JSON', { chunks: [Buffer.from('not json')] }, 'invalid_json'],
  ['指针位置不存在', { chunks: [Buffer.from('{"b":2}')] }, 'missing_json_pointer'],
];
for (const [label, spec, expectReason] of httpCases) {
  const { checker } = officialChecker({ spec });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 4000, label);
  await count(() => assert.equal(res.state, 'unknown', `${label}:期望 unknown,实际 ${res.state}/${res.reason}`), `${label} => unknown`);
  await count(() => assert.equal(res.reason, expectReason, `${label}:期望 ${expectReason},实际 ${res.reason}`), `${label} reason=${expectReason}`);
}
const httpOkCases = [
  ['application/json; charset=utf-8', { headers: { 'content-type': 'application/json; charset=utf-8' } }, ptrSpec('/a', 1), 1],
  ['text/plain 无 charset', { headers: { 'content-type': 'text/plain' }, chunks: [Buffer.from('hello\n')] }, linesSpec('hello'), 'hello'],
  ['text/plain; charset=UTF-8 带引号', { headers: { 'content-type': 'text/plain; charset="UTF-8"' }, chunks: [Buffer.from('hello\n')] }, linesSpec('hello'), 'hello'],
  ['text/markdown; charset=utf-8', { headers: { 'content-type': 'text/markdown; charset=utf-8' }, chunks: [Buffer.from('hello\n')] }, linesSpec('hello'), 'hello'],
  ['content-encoding: Identity(大小写)', { headers: { 'content-type': 'application/json', 'content-encoding': 'Identity' } }, ptrSpec('/a', 1), 1],
  ['content-length 正确', { headers: { 'content-type': 'application/json', 'content-length': '7' } }, ptrSpec('/a', 1), 1],
];
for (const [label, spec, useSpec, expectedObserved] of httpOkCases) {
  const { checker } = officialChecker({ spec });
  const item = mkOfficial(URL_DOC, useSpec);
  const res = await settled(checker.check(item.id), 4000, label);
  await count(() => assert.equal(res.state, 'ok', `${label}:实际 ${res.state}/${res.reason}`), `${label} => ok`);
  await count(() => assert.equal(res.evidence.observed, expectedObserved), `${label}:observed 正确`);
}
{ // 流式取源上限:无 content-length 时按累计字节兜住,并 destroy
  const chunks = Array.from({ length: 20 }, () => Buffer.alloc(100, 0x41));
  const { checker, holder } = officialChecker({ spec: { chunks }, limits: { sourceMaxBytes: 1024 } });
  const item = mkOfficial(URL_DOC, linesSpec('x'));
  const res = await settled(checker.check(item.id), 4000, '流式超限');
  await count(() => assert.equal(res.state, 'unknown'), '流式累计超上限 => unknown');
  await count(() => assert.equal(res.reason, 'source_too_large'), '流式累计超上限 reason=source_too_large');
  await count(() => assert.equal(holder.body.destroyed, true), '超限时已 destroy(有界流式读取)');
}

// ─────────────────────────────────────────────────────────────────────────────
section('5) 限额:取源字节 / 选中字节 / 选中行数(checker 限额独立生效)');
{
  const c = checkerFor({ limits: { sourceMaxBytes: 1024 } });
  const item = mkItem({ source_ref: BIG_PATH, check_spec: linesSpec('x') });
  const res = await settled(c.check(item.id), 4000, '本地源超大');
  await count(() => assert.equal(res.reason, 'source_too_large'), '本地源超过 sourceMaxBytes => source_too_large');
}
{
  const c = checkerFor({ limits: { selectedTextMaxBytes: 64 } });
  const item = mkItem({ source_ref: LONG_PATH, check_spec: linesSpec('short') });
  const res = await settled(c.check(item.id), 4000, '选中文本超大');
  await count(() => assert.equal(res.reason, 'selection_too_large'), '观测到的选中文本超 64 字节 => selection_too_large');
  const item2 = mkItem({ source_ref: ALPHA_PATH, check_spec: linesSpec('x'.repeat(80)) });
  const res2 = await settled(c.check(item2.id), 4000, 'expected 超大');
  await count(() => assert.equal(res2.reason, 'selection_too_large'), 'expected 本身超 64 字节 => selection_too_large');
}
{
  const c = checkerFor({ limits: { selectedTextMaxLines: 1 } });
  const item = mkItem({ source_ref: ALPHA_PATH, check_spec: linesSpec('alpha\nbeta', 1, 2) });
  const res = await settled(c.check(item.id), 4000, '选中行数超限');
  await count(() => assert.equal(res.reason, 'selection_too_many_lines'), 'checker 的 1 行上限拦住 store 允许的 2 行规格');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6) 三态:类型严格结构比较 / 成员顺序无关 / LF-only 比较');
const docChecker = checkerFor();
const ptrCheck = async (file, pointer, expected, comparison = 'exact') => {
  const item = mkItem({ source_ref: file, check_spec: ptrSpec(pointer, expected, comparison) });
  return settled(docChecker.check(item.id), 4000, `指针 ${pointer}`);
};
for (const [label, file, pointer, expected, comparison] of [
  ['对象成员顺序无关', DOC_PATH, '/obj', { b: [1, 2], a: 1 }, 'exact'],
  ['数值保持数值类型', DOC_PATH, '/num', 1, 'exact'],
  ['字符串保持字符串类型', DOC_PATH, '/str', '1', 'exact'],
  ['布尔', DOC_PATH, '/bool', true, 'exact'],
  ['null', DOC_PATH, '/nil', null, 'exact'],
  ['~1 转义(键里有 /)', DOC_PATH, '/esc/a~1b', 7, 'exact'],
  ['~0 转义(键里有 ~)', DOC_PATH, '/esc/c~0d', 8, 'exact'],
  ['数组下标', DOC_PATH, '/arr/1', 'y', 'exact'],
  ['空指针 = 整篇', DOC_PATH, '', DOC, 'exact'],
  ['text-lf 对 JSON 字符串', DOC_PATH, '/str', '1', 'text-lf'],
  ['exact 保留 CRLF', CRLF_JSON_PATH, '/crlf', 'x\r\ny\r\n', 'exact'],
  ['text-lf 归一 CRLF', CRLF_JSON_PATH, '/crlf', 'x\ny\n', 'text-lf'],
]) {
  const res = await ptrCheck(file, pointer, expected, comparison);
  await count(() => assert.equal(res.state, 'ok', `${label}:实际 ${res.state}/${res.reason} observed=${JSON.stringify(res.evidence.observed)}`), `${label} => ok`);
}
for (const [label, file, pointer, expected, comparison] of [
  ['数值 vs 字符串(类型严格)', DOC_PATH, '/num', '1', 'exact'],
  ['字符串 vs 数值(类型严格)', DOC_PATH, '/str', 1, 'exact'],
  ['布尔 vs 数值(类型严格)', DOC_PATH, '/bool', 1, 'exact'],
  ['null vs 0', DOC_PATH, '/nil', 0, 'exact'],
  ['null vs false', DOC_PATH, '/nil', false, 'exact'],
  ['数组长度不同', DOC_PATH, '/arr', ['x'], 'exact'],
  ['对象多一个成员', DOC_PATH, '/obj', { a: 1, b: [1, 2], c: 3 }, 'exact'],
  ['text-lf 不折叠大小写', DOC_PATH, '/case', 'abc', 'text-lf'],
  ['text-lf 不 trim', DOC_PATH, '/ws', 'pad', 'text-lf'],
  ['exact 见 CRLF 就不等于 LF', CRLF_JSON_PATH, '/crlf', 'x\ny\n', 'exact'],
]) {
  const res = await ptrCheck(file, pointer, expected, comparison);
  await count(() => assert.equal(res.state, 'wrong', `${label}:实际 ${res.state}/${res.reason}`), `${label} => wrong`);
  await count(() => assert.equal(res.reason, 'declared_comparison_mismatch'), `${label}:wrong 的 reason 可判定`);
}
{
  // text-lf 只在两端都是文本时才有意义。store 现已**不许建出**这种规格(library-store.js L552-556),
  // 所以 checker 侧那条守卫用 stub 直测;两条一起断言,才说得清"库面拒绝 + 裁判面兜底"的分工。
  const refused = store.create({
    title: 'text-lf 配非文本规格', body: 'x', category: 'boundary', source_kind: 'our-code',
    source_ref: DOC_PATH, as_of: '2026-10-06', check_spec: ptrSpec('/num', 1, 'text-lf'),
  });
  await count(() => assert.equal(refused.ok, false, `实际 ${JSON.stringify(refused).slice(0, 160)}`),
    'store 拒绝 text-lf + 非文本 expected 的规格(建不进库)');
  await count(() => assert.equal(refused.reason, 'invalid_check_spec'), 'store 拒绝 reason=invalid_check_spec');
  const base = mkItem({ source_ref: DOC_PATH, check_spec: null });
  const res = await settled(settleStub(base, ptrSpec('/num', 1, 'text-lf')), 4000, 'text-lf 非文本(stub)');
  await count(() => assert.equal(res.state, 'unknown'), 'checker 自身守卫:text-lf 遇到非文本 => unknown(不是 wrong)');
  await count(() => assert.equal(res.reason, 'comparison_requires_text'), 'checker 守卫 reason=comparison_requires_text');
}
{ // 行段:切片口径(行终止符不属于选中的内容)、尾换行后的空行、CRLF、真正的行数越界
  const lineCheck = async (file, expected, start, end, comparison = 'exact') => {
    const item = mkItem({ source_ref: file, check_spec: linesSpec(expected, start, end, comparison) });
    return settled(docChecker.check(item.id), 4000, `行 ${start}-${end}`);
  };
  const r1 = await lineCheck(ALPHA_PATH, 'beta\ngamma', 2, 3);
  await count(() => assert.equal(r1.state, 'ok', `实际 ${r1.state}`), '行 2-3 = beta\\ngamma(行终止符不属于选中内容)');
  const r2 = await lineCheck(ALPHA_PATH, 'alpha\nbeta\ngamma', 1, 3);
  await count(() => assert.equal(r2.state, 'ok'), '行 1-3 = 前三行(不含文件末尾那个换行)');
  const r4 = await lineCheck(ALPHA_PATH, 'alpha\nbeta\ngamma\n', 1, 4);
  await count(() => assert.equal(r4.state, 'ok'), '行 1-4 = 全文:末尾换行之后的空行是可寻址的第 4 行');
  const r4b = await lineCheck(ALPHA_PATH, 'x', 1, 5);
  await count(() => assert.equal(r4b.state, 'unknown'), '行号真的超出文件 => unknown');
  await count(() => assert.equal(r4b.reason, 'missing_lines'), '行号超出 reason=missing_lines');
  const r3 = await lineCheck(LONELY_PATH, 'lonely', 1, 1);
  await count(() => assert.equal(r3.state, 'ok'), '无尾换行的单行文件可选中');
  const c1 = await lineCheck(CRLF_PATH, 'l1\r\nl2', 1, 2, 'exact');
  await count(() => assert.equal(c1.state, 'ok'), 'exact 保留选中内容内部的 CRLF');
  const c2 = await lineCheck(CRLF_PATH, 'l1\nl2', 1, 2, 'exact');
  await count(() => assert.equal(c2.state, 'wrong'), 'exact 不归一 CRLF(与 LF 版不等)');
  const c3 = await lineCheck(CRLF_PATH, 'l1\nl2', 1, 2, 'text-lf');
  await count(() => assert.equal(c3.state, 'ok'), 'text-lf 归一 CRLF 后相等');
  const c4 = await lineCheck(CRLF_PATH, 'l1', 1, 1, 'exact');
  await count(() => assert.equal(c4.state, 'ok'), '行终止符不在选中内容里:行 1 就是 l1(不带 CR)');
  const r7 = await lineCheck(ALPHA_PATH, 'alpha ', 1, 1, 'text-lf');
  await count(() => assert.equal(r7.state, 'wrong'), 'text-lf 不 trim(尾空格算不同)');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7) RFC 6901 与 missing 位置 = unknown;非有限 JSON 必须拒绝');
for (const [label, pointer] of [
  ['不存在的成员', '/missing'],
  ['数组下标前导零', '/arr/01'],
  ['数组下标越界', '/arr/2'],
  ['数组减号(追加位)', '/arr/-'],
  ['对象里不存在的键', '/obj/nope'],
  ['指针穿过标量', '/num/deep'],
]) {
  const res = await ptrCheck(DOC_PATH, pointer, 1);
  await count(() => assert.equal(res.state, 'unknown', `${label}:位置不存在必须是 unknown,实际 ${res.state}`), `${label} => unknown`);
  await count(() => assert.equal(res.reason, 'missing_json_pointer'), `${label} reason=missing_json_pointer`);
  await count(() => assert.equal(res.evidence.observed, null), `${label}:取不到值就不该有 observed`);
}
{
  const top = mkItem({ source_ref: NONFINITE_PATH, check_spec: ptrSpec('/top', 1) });
  const rTop = await settled(docChecker.check(top.id), 4000, '顶层非有限');
  await count(() => assert.equal(rTop.state, 'unknown', `顶层 1e999:实际 ${rTop.state}/${rTop.reason}`), '顶层 1e999 解析成 Infinity => unknown');
  await count(() => assert.equal(rTop.reason, 'nonfinite_json_value'), '顶层非有限 reason=nonfinite_json_value');

  const nested = mkItem({ source_ref: NONFINITE_PATH, check_spec: ptrSpec('/nest', { deep: null }) });
  const rNested = await settled(docChecker.check(nested.id), 4000, '嵌套非有限');
  await count(() => assert.equal(rNested.state, 'unknown',
    `嵌套非有限必须与顶层同判(实际 state=${rNested.state} reason=${rNested.reason} observed=${JSON.stringify(rNested.evidence.observed)})`),
  '嵌套非有限 JSON 不得判 ok/wrong');
  await count(() => assert.equal(rNested.reason, rTop.reason), '嵌套与顶层用同一个 reason 码');

  const whole = mkItem({ source_ref: NONFINITE_PATH, check_spec: ptrSpec('', { nest: { deep: null }, top: null }) });
  const rWhole = await settled(docChecker.check(whole.id), 4000, '整篇含非有限');
  await count(() => assert.equal(rWhole.state, 'unknown', `整篇含非有限:实际 ${rWhole.state}/${rWhole.reason}`), '整篇指针遇到非有限同样 unknown');
}
{ // -0:store 的 JSON 列**无法无损保留符号**(JSON.stringify(-0) === '0'),所以 -0 是"不该写进证据"的值。
  // store 侧在建条目时就拒绝 expected=-0;而**源里**出现的 -0 只能由裁判员在写认证之前拦下:
  // unknown / non_roundtrippable_json_value,**observed 保持 null**(不让签名已丢的值进证据),
  // 但这次尝试照常留档 recorded:true —— 它不是取消,也不是取源失败。
  const refusedZero = store.create({
    title: 'expected=-0 建不进库', body: 'x', category: 'boundary', source_kind: 'our-code',
    source_ref: NEGZERO_TOP_PATH, as_of: '2026-10-06', check_spec: ptrSpec('', -0),
  });
  await count(() => assert.equal(refusedZero.ok, false, `实际 ${JSON.stringify(refusedZero).slice(0, 200)}`),
    'store 建条目时就拒绝 check_spec.expected=-0(JSON 证据无法无损保留签名)');
  await count(() => assert.equal(refusedZero.reason, 'invalid_check_spec'), 'store 拒绝 -0 的 reason=invalid_check_spec');
  const zeroCases = [
    ['源顶层就是 -0(空指针选整篇)', NEGZERO_TOP_PATH, '', 0],
    ['嵌套成员是 -0', NEGZERO_NEST_PATH, '/nest/deep', 0],
    ['选中的对象里含 -0(整段)', NEGZERO_NEST_PATH, '/nest', { deep: 0 }],
  ];
  for (const [label, file, pointer, expected] of zeroCases) {
    const item = mkItem({ source_ref: file, check_spec: ptrSpec(pointer, expected) });
    const res = await settled(docChecker.check(item.id), 4000, label);
    await count(() => assert.equal(res.state, 'unknown', `${label}:实际 ${res.state}/${res.reason}`), `${label} => unknown`);
    await count(() => assert.equal(res.reason, 'non_roundtrippable_json_value', `${label}:实际 reason=${res.reason}`),
      `${label} reason=non_roundtrippable_json_value`);
    await count(() => assert.equal(res.recorded, true, `${label}:实际 recorded=${res.recorded}`),
      `${label} 照常留档 recorded=true(不是取消)`);
    await count(() => assert.equal(res.evidence.observed, null, `${label}:实际 observed=${JSON.stringify(res.evidence.observed)}`),
      `${label} observed 必须为 null(签名已丢的值不进证据)`);
    await count(() => assert.equal(res.evidence.state, 'unknown'), `${label} evidence.state=unknown`);
    await count(() => assert.equal(res.evidence.reason, 'non_roundtrippable_json_value'), `${label} evidence.reason 同码`);
    await count(() => assert.equal(store.checks(item.id).total, 1), `${label} 留档一条核对历史`);
    await count(() => assert.equal(store.checks(item.id).checks.at(-1).state, 'unknown'), `${label} 历史里那一条是 unknown`);
  }
}
{ // BOM:observe() 用 { ignoreBOM: true }(checker L401)⇒ **BOM 保留**,不隐式丢掉。
  // 口径由主线定(2026-10-06):BOM 属于源内容,悄悄剥掉就等于改动了比对基准,故这里把"保留"
  // 记成事实断言,而不是只留一句观察。
  const bomJson = join(rootA, 'bom.json');
  writeFileSync(bomJson, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));
  const bomItem = mkItem({ source_ref: bomJson, check_spec: ptrSpec('/a', 1) });
  const rBom = await settled(docChecker.check(bomItem.id), 4000, 'BOM JSON');
  note('BOM 开头的 JSON(口径:保留 BOM)', { state: rBom.state, reason: rBom.reason });
  await count(() => assert.equal(rBom.state, 'unknown'), '带 BOM 的 JSON => unknown(BOM 未被剥掉,解析失败)');
  await count(() => assert.equal(rBom.reason, 'invalid_json'), '带 BOM 的 JSON reason=invalid_json');
  const bomTxt = join(rootA, 'bom.txt');
  writeFileSync(bomTxt, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\n')]));
  const bomTxtItem = mkItem({ source_ref: bomTxt, check_spec: linesSpec('alpha') });
  const rBomTxt = await settled(docChecker.check(bomTxtItem.id), 4000, 'BOM 文本');
  note('BOM 开头的文本文件第 1 行 vs "alpha"(口径:保留 BOM)',
    { state: rBomTxt.state, reason: rBomTxt.reason, observed: rBomTxt.evidence.observed });
  await count(() => assert.equal(rBomTxt.state, 'wrong'), 'BOM 文本第 1 行含 U+FEFF => 与 "alpha" 不等(不隐式丢 BOM)');
  await count(() => assert.equal(rBomTxt.evidence.observed, '\uFEFFalpha'), 'observed 保留 U+FEFF 前缀');
}
{ // 只有直接构造才到得了的分支(store 会先在 create 拒绝)
  const c = checkerFor();
  for (const [label, spec, expectReason] of [
    ['check_spec=null', null, 'no_check_spec'],
    ['locator.kind 不支持', { locator: { kind: 'bytes', offset: 0 }, expected: 'x', comparison: 'exact' }, 'unsupported_locator'],
    ['check_spec 缺 comparison', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x' }, 'invalid_check_spec'],
    ['指针 ~ 转义非法', { locator: { kind: 'json-pointer', pointer: '/a~2b' }, expected: 1, comparison: 'exact' }, 'invalid_json_pointer'],
    ['行号顺序倒置', { locator: { kind: 'lines', start: 3, end: 1 }, expected: 'x', comparison: 'exact' }, 'invalid_lines_locator'],
  ]) {
    const plain = mkItem({ check_spec: null });
    if (spec !== null) {
      const res = await settled(settleStub(plain, spec, c), 4000, label);
      await count(() => assert.equal(res.state, 'unknown', `${label}:实际 ${res.state}`), `${label} => unknown`);
      await count(() => assert.equal(res.reason, expectReason, `${label}:期望 ${expectReason},实际 ${res.reason}`), `${label} reason=${expectReason}`);
    } else {
      const res = await settled(c.check(plain.id), 4000, label);
      await count(() => assert.equal(res.reason, 'no_check_spec'), 'check_spec=null => no_check_spec');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('8) 并发:in-flight / concurrency_limit / close 幂等 / 三种取消');
{
  const held = deferred();
  const { checker } = officialChecker({
    spec: async () => { await held.promise; return response({ chunks: [Buffer.from('{"a":1}')] }).response; },
    checkConcurrency: 1,
  });
  const A = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const B = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const p1 = checker.check(A.id);
  await count(() => assert.equal(checker.status().activeCount, 1), '请求挂起时 activeCount=1');
  const dup = await checker.check(A.id);
  await count(() => assert.equal(dup.reason, 'in_flight'), '同一条目并发 => refused in_flight');
  await count(() => assert.equal(dup.recorded, false), 'in_flight 不写认证');
  await count(() => assert.equal(dup.ok, false), 'in_flight ok=false');
  await count(() => assert.equal(dup.item_id, A.id), 'in_flight 回执点名条目');
  const other = await checker.check(B.id);
  await count(() => assert.equal(other.reason, 'concurrency_limit'), 'checkConcurrency=1 时另一条目 => concurrency_limit');
  await count(() => assert.equal(other.recorded, false), 'concurrency_limit 不写认证');
  await count(() => assert.equal(store.checks(B.id).total, 0), '被拒的两条都没落历史');
  held.resolve();
  const done = await settled(p1, 4000, '释放后的 in-flight check');
  await count(() => assert.equal(done.state, 'ok'), '释放后原请求正常完成');
  await count(() => assert.equal(done.adopted, true), '完成的那条被采纳');
  await count(() => assert.equal(checker.status().activeCount, 0), '完成后 activeCount 归零');
  await count(() => assert.equal(store.checks(A.id).total, 1), '只落了一条历史(被拒的没落)');
}
{
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const c = checkerFor();
  const ac = new AbortController();
  ac.abort();
  const res = await settled(c.check(item.id, { signal: ac.signal }), 4000, 'preflight 取消');
  await count(() => assert.equal(res.ok, false), 'preflight 取消 ok=false');
  await count(() => assert.equal(res.cancelled, true), 'preflight 取消标记 cancelled');
  await count(() => assert.equal(res.reason, 'aborted'), 'preflight 取消 reason=aborted');
  await count(() => assert.equal(res.recorded, false), 'preflight 取消不写认证');
  await count(() => assert.equal(store.checks(item.id).total, 0), 'preflight 取消没有留下核对历史');
  await count(() => assert.equal(c.status().activeCount, 0), 'preflight 取消不占并发名额');
  for (const [label, opts, expectReason] of [
    ['未知 option', { nope: 1 }, 'invalid_options'],
    ['options=null', null, 'invalid_options'],
    ['signal 不是 AbortSignal', { signal: 'x' }, 'invalid_signal'],
  ]) {
    const bad = await c.check(item.id, opts);
    await count(() => assert.equal(bad.reason, expectReason, `${label}:实际 ${bad.reason}`), `${label} => ${expectReason}`);
    await count(() => assert.equal(bad.recorded, false), `${label} 不写认证`);
  }
}
{
  // 先确认 requester 已被调用(由钩子自己通知),否则"取消"可能落在取源之前 —— 那就没测到本意。
  const held = deferred();
  const arrived = deferred();
  let seenSignal = null;
  const requester = recordingRequester(async (_url, info) => {
    seenSignal = info.signal;
    arrived.resolve();
    await held.promise;
    return response({ chunks: [Buffer.from('{"a":1}')] }).response;
  });
  const { resolver } = resolverBox(PUBLIC4);
  const checker = checkerFor({ officialUrls: [URL_DOC], resolver, requester, checkTimeoutMs: 8000 });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const ac = new AbortController();
  const p = checker.check(item.id, { signal: ac.signal });
  await arrived.promise;
  await count(() => assert.equal(seenSignal instanceof AbortSignal, true), 'requester 收到 AbortSignal(取消可传导到传输)');
  await count(() => assert.equal(seenSignal.aborted, false), '取消之前传输侧 signal 未中止');
  await count(() => assert.equal(checker.status().activeCount, 1), '请求在飞时 activeCount=1');
  ac.abort();
  const res = await settled(p, 4000, '请求中取消');
  await count(() => assert.equal(res.cancelled, true), '请求中取消 => cancelled');
  await count(() => assert.equal(res.recorded, false), '请求中取消不写认证');
  await count(() => assert.equal(res.reason, 'aborted'), '请求中取消 reason=aborted');
  await count(() => assert.equal(res.state, 'unknown'), '请求中取消 state=unknown');
  await count(() => assert.equal(seenSignal.aborted, true), '调用方取消后传输侧 signal 也被中止');
  await count(() => assert.equal(store.checks(item.id).total, 0), '请求中取消不落历史');
  await count(() => assert.equal(listenerCount(ac.signal) === 0 || listenerCount(ac.signal) === -1, true,
    `调用方 signal 上不应残留 abort 监听(实测 ${listenerCount(ac.signal)})`), '取消后清理了调用方监听');
  await count(() => assert.equal(checker.status().activeCount, 0), '取消后 activeCount=0');
}
{
  const arrived = deferred();
  const holder = { body: null };
  const requester = recordingRequester(async () => {
    const made = response({ hang: true });
    holder.body = made.state;
    arrived.resolve();
    return made.response;
  });
  const { resolver } = resolverBox(PUBLIC4);
  const checker = checkerFor({ officialUrls: [URL_DOC], resolver, requester, checkTimeoutMs: 8000 });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const ac = new AbortController();
  const p = checker.check(item.id, { signal: ac.signal });
  await arrived.promise; // body 已经开始挂死
  await count(() => assert.equal(checker.status().activeCount, 1), '挂死 body 时 activeCount=1');
  ac.abort();
  const res = await settled(p, 4000, '挂死 body 中取消');
  await count(() => assert.equal(res.cancelled, true), 'body 无视 signal 也能被取消(外层 abortable 兜住)');
  await count(() => assert.equal(res.recorded, false), '挂死 body 取消不写认证');
  await count(() => assert.equal(holder.body.destroyed, true), '挂死 body 取消后 destroy 被调用');
  await count(() => assert.equal(store.checks(item.id).total, 0), '挂死 body 取消不落历史');
  await count(() => assert.equal(checker.status().activeCount, 0), '挂死 body 取消后 activeCount=0');
}
{
  const held = deferred();
  const { checker } = officialChecker({
    spec: async () => { await held.promise; return response({ chunks: [Buffer.from('{"a":1}')] }).response; },
    checkTimeoutMs: 8000,
  });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const p = checker.check(item.id);
  const c1 = checker.close();
  const c2 = checker.close();
  await count(() => assert.strictEqual(c1, c2), 'close() 幂等:两次调用返回同一个 promise');
  const res = await settled(p, 4000, 'close 时在飞的核对');
  await count(() => assert.equal(res.cancelled, true), 'close 时在飞的核对 => cancelled');
  await count(() => assert.equal(res.recorded, false), 'close 取消不写认证');
  await count(() => assert.equal(res.reason, 'closed'), 'close 取消 reason=closed');
  await count(() => assert.equal(res.ok, false), 'close 取消 ok=false');
  const closed = await c1;
  const closed2 = await c2;
  await count(() => assert.deepEqual(closed, { ok: true, closed: true }), 'close() 回执 {ok:true,closed:true}');
  await count(() => assert.strictEqual(closed, closed2), '两次 close 拿到同一个回执对象');
  await count(() => assert.equal(checker.status().closed, true), 'close 后 status().closed=true');
  await count(() => assert.equal(checker.status().activeCount, 0), 'close 后 activeCount=0');
  await count(() => assert.equal(store.checks(item.id).total, 0), 'close 取消不落历史');
  const after = await checker.check(item.id);
  await count(() => assert.equal(after.reason, 'closed'), 'close 之后 check => refused closed');
  await count(() => assert.equal(after.recorded, false), 'close 之后的 check 不写');
}
{ // 正常成功路径也不能留下调用方监听
  const ac = new AbortController();
  const c = checkerFor();
  const item = mkItem({ check_spec: linesSpec('alpha') });
  const res = await settled(c.check(item.id, { signal: ac.signal }), 4000, '带 signal 的正常核对');
  await count(() => assert.equal(res.state, 'ok'), '带 signal 的正常核对仍然 ok');
  const lc = listenerCount(ac.signal);
  if (lc === -1) note('getEventListeners 对 AbortSignal 不可用,跳过监听残留断言', lc);
  else await count(() => assert.equal(lc, 0), `成功后调用方 signal 无残留监听(实测 ${lc})`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('9) 陈旧修订:留痕、不采纳、不污染新版本');
{
  const c = checkerFor();
  const item = mkItem({ source_ref: STALE_PATH, check_spec: linesSpec('stale v1') });
  const first = await settled(c.check(item.id), 4000, '陈旧谱系首核');
  await count(() => assert.equal(first.state, 'ok'), '首核 ok');
  await count(() => assert.equal(first.adopted, true), '首核被采纳');
  await count(() => assert.equal(st(item.id).checked_state, 'ok'), '旧版认证为 ok');
  const rev = store.revise(item.id, { body: 'checker 测试正文 v2' }, item.content_hash);
  await count(() => assert.equal(rev.ok, true), '修订出新版本');
  const v2 = rev.item;
  await count(() => assert.equal(v2.checked_state, ''), '新版本认证被重置');
  writeFileSync(STALE_PATH, 'stale v2 changed\n', 'utf8'); // 让"旧版复查"比出 wrong
  const staleRes = await settled(c.check(item.id), 4000, '旧版复查');
  await count(() => assert.equal(staleRes.state, 'wrong'), '源已变 => 旧版复查比出 wrong');
  await count(() => assert.equal(staleRes.recorded, true), '陈旧证据照样留档 recorded=true');
  await count(() => assert.equal(staleRes.adopted, false), '被取代的旧版 => adopted=false');
  // 顶层 reason 是**比对结果**那一档(wrong ⇒ declared_comparison_mismatch);"为什么不采纳"在 record.reason。
  await count(() => assert.equal(staleRes.reason, 'declared_comparison_mismatch'),
    '陈旧复核的顶层 reason 是比对结论(与 state=wrong 一致)');
  await count(() => assert.equal(staleRes.record.reason, 'stale_or_inactive'), '采纳判词在 record.reason=stale_or_inactive');
  await count(() => assert.equal(st(item.id).checked_state, 'ok'), '旧版自身认证保留(不被陈旧结果改写)');
  await count(() => assert.equal(st(item.id).state, 'superseded'), '旧版仍是 superseded(留痕,无物理删)');
  await count(() => assert.equal(st(v2.id).checked_state, ''), '新 active 版认证没有被陈旧证据污染');
  await count(() => assert.equal(store.checks(item.id).total, 2), '陈旧那次也进历史(2 条)');
  const last = store.checks(item.id).checks.at(-1);
  await count(() => assert.equal(last.state, 'wrong'), '历史里那一条确实是 wrong');
  await count(() => assert.equal(last.adopted, false), '历史里那一条标 adopted=false');
  await count(() => assert.equal(last.item_hash, item.content_hash), '历史里记的是"被核的那个旧版哈希"');
}
{ // **在飞时**修订(区别于"核对开始前就已修订"):核对由真实 deferred 钩子挂住,期间做完 revise 再放行。
  // 要验证的是:认证是针对**发起那一刻观测到的哈希**结算的 ⇒ 已被取代就不再采纳,新 active 版不被污染。
  const held = deferred();
  const arrived = deferred();
  const { checker } = officialChecker({
    spec: async () => { arrived.resolve(); await held.promise; return response({ chunks: [Buffer.from('{"a":1}')] }).response; },
  });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const inflight = checker.check(item.id);
  await arrived.promise; // 先确认 requester 真的到了,否则"在飞"就是空话
  await count(() => assert.equal(checker.status().activeCount, 1), '请求在飞时 activeCount=1(核对确实未结算)');
  const rev = store.revise(item.id, { body: 'checker 测试正文 v2' }, item.content_hash);
  await count(() => assert.equal(rev.ok, true), '在飞期间修订成功(旧版被取代)');
  await count(() => assert.equal(st(item.id).state, 'superseded'), '放行响应之前旧版已经是 superseded');
  held.resolve();
  const res = await settled(inflight, 4000, '在飞修订后的核对');
  await count(() => assert.equal(res.state, 'ok', `比对本身成功:实际 ${res.state}/${res.reason}`), '响应放行后比对成功 => ok');
  await count(() => assert.equal(res.recorded, true), '证据照常留档 recorded=true');
  await count(() => assert.equal(res.adopted, false), '在飞期间被取代 => 不采纳');
  await count(() => assert.equal(res.record.reason, 'stale_or_inactive'), '不采纳的判词在 record.reason');
  await count(() => assert.equal(res.item_hash, item.content_hash), '结算锁在发起时观测到的那个哈希上');
  await count(() => assert.equal(st(item.id).checked_state, ''), '旧版认证没有被这次结果写上');
  await count(() => assert.equal(st(rev.item.id).checked_state, ''), '新 active 版认证不被污染');
  const hist = store.checks(item.id);
  await count(() => assert.equal(hist.total, 1), '核对历史记在旧版 id 上,共 1 条');
  await count(() => assert.equal(hist.checks.at(-1).item_hash, item.content_hash), '历史记的是发起时那个哈希');
  await count(() => assert.equal(hist.checks.at(-1).adopted, false), '历史里那一条标 adopted=false');
}
{
  const c = checkerFor();
  const item = mkItem({ check_spec: linesSpec('alpha') });
  const before = await settled(c.check(item.id), 4000, '撤下前核对');
  await count(() => assert.equal(before.adopted, true), '撤下前被采纳');
  const w = store.withdraw(item.id, '测试撤下', item.content_hash);
  await count(() => assert.equal(w.ok, true), '撤下成功');
  const after = await settled(c.check(item.id), 4000, '撤下后核对');
  await count(() => assert.equal(after.state, 'ok'), '撤下后仍照常取源比对(读数不受状态影响)');
  await count(() => assert.equal(after.adopted, false), '撤下后不采纳');
  await count(() => assert.equal(after.reason, null), '撤下后比对成功 => 顶层 reason=null(与 state=ok 一致)');
  await count(() => assert.equal(after.record.reason, 'stale_or_inactive'), '撤下后"不采纳"的判词在 record.reason');
  await count(() => assert.equal(st(item.id).checked_state, 'ok'), '撤下条目保留原认证(不被新结果改写)');
  await count(() => assert.equal(st(item.id).state, 'withdrawn'), '状态仍是 withdrawn');
  await count(() => assert.equal(store.checks(item.id).total, 2), '撤下后核对历史 2 条(留痕)');
}
{ // 不存在的条目 / 非法 id:store 回执原样透传,不冒充 unknown-certified
  const c = checkerFor();
  const ghostId = `lib:${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`;
  const ghost = await c.check(ghostId);
  await count(() => assert.equal(ghost.ok, false), '不存在的条目 ok=false');
  await count(() => assert.equal(ghost.reason, 'not_found'), '不存在的条目 reason=not_found(store 口径原样)');
  await count(() => assert.equal(ghost.found, false), 'found=false 一并透传');
  await count(() => assert.equal(ghost.state, 'unknown'), '补上 state=unknown');
  await count(() => assert.equal(ghost.recorded, false), '没有落认证');
  const bad = await c.check('not-an-id');
  await count(() => assert.equal(bad.reason, 'invalid_argument'), '非法 id => store 的 invalid_argument 原样透传');
  await count(() => assert.equal(bad.recorded, false), '非法 id 不落认证');
}

// ─────────────────────────────────────────────────────────────────────────────
section('10) 证据结构 / store 异常不吞 / 无真实网络自证');
{
  const c = checkerFor();
  const item = mkItem({ check_spec: linesSpec('alpha') });
  const res = await settled(c.check(item.id), 4000, '证据结构');
  await count(() => assert.deepEqual(Object.keys(res.evidence).sort(),
    ['actual_source', 'checked_at', 'comparison', 'expected', 'locator', 'observed', 'reason', 'requested_source', 'source_hash', 'state']),
  'evidence 键集固定为契约那十个');
  await count(() => assert.deepEqual(res.evidence.locator, item.check_spec.locator), 'evidence.locator 复刻条目规格的定位');
  await count(() => assert.equal(res.evidence.comparison, 'exact'), 'evidence.comparison 复刻规格');
  await count(() => assert.equal(res.evidence.expected, 'alpha'), 'evidence.expected 复刻规格');
  await count(() => assert.equal(res.evidence.reason, null), 'ok 的 reason=null');
  await count(() => assert.equal(res.evidence.state, 'ok'), 'evidence.state=ok');
  await count(() => assert.equal(new Date(res.evidence.checked_at).toISOString(), res.evidence.checked_at), 'checked_at 是规范 ISO 时刻');
  await count(() => assert.deepEqual(JSON.parse(JSON.stringify(res.evidence)), res.evidence), 'evidence 可无损 JSON 往返(结构面)');
  await count(() => assert.equal(typeof res.record.check_sequence, 'number'), '回执带本次核对序号');
  await count(() => assert.equal(res.record.check.adopted, true), '回执里那一行标 adopted');
}
{
  const item = mkItem({ check_spec: linesSpec('alpha') });
  const boomGet = { limits: store.limits, get() { throw new Error('store boom'); }, recordCheck() {} };
  const c1 = track(new LibraryChecker(boomGet, { codeRoots: [rootA] }));
  await count(async () => { await assert.rejects(() => c1.check(item.id), /store boom/); }, 'store.get 抛错原样上抛(不吞成 unknown)');
  await count(() => assert.equal(c1.status().activeCount, 0), '取条目失败不占并发名额');
  const boomRecord = {
    limits: store.limits,
    get: () => ({ ok: true, found: true, item }),
    recordCheck() { throw new Error('record boom'); },
  };
  const c2 = track(new LibraryChecker(boomRecord, { codeRoots: [rootA] }));
  await count(async () => { await assert.rejects(() => c2.check(item.id), /record boom/); }, 'store.recordCheck 抛错原样上抛(不吞)');
  await count(() => assert.equal(c2.status().activeCount, 0), 'recordCheck 抛错后并发名额已释放');
}
{
  await count(() => assert.equal(httpCalls.length > 0, true), '本次确实走了注入传输(有调用记录)');
  await count(() => assert.equal(httpCalls.every((c) => c.isURL === true), true), '传输第一参数是 URL 实例');
  await count(() => assert.equal(httpCalls.every((c) => c.hasSignal === true), true), '每次传输都带 AbortSignal');
  const allowedHosts = new Set(['example.com', '93.184.216.34', '[2606:4700:4700::1111]']);
  const hosts = new Set(httpCalls.map((c) => new globalThis.URL(c.href).hostname));
  await count(() => assert.equal([...hosts].every((h) => allowedHosts.has(h)), true,
    `注入传输只碰到测试内登记的地址(实际 ${[...hosts].join(',')})`), '注入传输只碰到测试内登记的地址');
}

// ── stub store(只用于 store 会先在 create 拒绝的分支)──────────────────────────
function settleStub(baseItem, spec, checker) {
  const item = { ...baseItem, check_spec: spec };
  const stub = stubStore(item);
  const c = track(new LibraryChecker(stub, { codeRoots: [rootA] }));
  return c.check(item.id);
}
function stubStore(item) {
  const calls = { get: 0, record: [] };
  return {
    limits: store.limits,
    calls,
    get() { calls.get += 1; return { ok: true, found: true, item }; },
    recordCheck(id, hash, evidence) {
      calls.record.push({ id, hash, evidence });
      return {
        ok: true, adopted: false, reason: 'stale_or_inactive', item_id: id, check_sequence: 1,
        state: evidence.state, checked_at: evidence.checked_at, checked_state: '', check: null,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
section('10.5) 公开默认传输(defaultRequester/defaultResolver)以模块替身验证');
// 为什么必须有这一段:前面所有 official-doc 用例都走**注入的** requester —— 那是受信管理员路径,
// 用它自证"默认传输也对"是循环论证。这里把 node:https.request 与 node:dns/promises.lookup 换成替身
// (syncBuiltinESMExports 让裁判员模块里的**活绑定**一起换掉;finally 还原),于是**公开默认路径**
// 也能在零真实网络下被逐条检查:GET / agent:false / Accept-Encoding identity / 钉住的 lookup /
// secureConnect 地址不一致必须 destroy。
{
  const requireCjs = createRequire(import.meta.url);
  const httpsCjs = requireCjs('node:https');
  const dnsCjs = requireCjs('node:dns/promises');
  const realRequest = httpsCjs.request;
  const realLookup = dnsCjs.lookup;
  const bodyState = { destroyed: false };
  const fakeResponse = {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    destroy() { bodyState.destroyed = true; },
    [Symbol.asyncIterator]() {
      let i = 0;
      const chunks = [Buffer.from('{"a":1}')];
      return {
        next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
      };
    },
  };
  const record = { calls: [], endCalled: 0, destroyed: [], remoteAddress: '93.184.216.34' };
  const fakeRequest = (url, options, callback) => {
    const req = {
      errors: [], sockets: [], broken: false,
      once(event, fn) { if (event === 'error') this.errors.push(fn); return this; },
      on(event, fn) { if (event === 'socket') this.sockets.push(fn); return this; },
      destroy(error) {
        this.broken = true;
        record.destroyed.push(error?.code ?? error?.message ?? null);
        for (const fn of this.errors) fn(error);
      },
      end() {
        record.endCalled += 1;
        const socket = {
          remoteAddress: record.remoteAddress, secureHandler: null,
          once(event, fn) { if (event === 'secureConnect') this.secureHandler = fn; return this; },
        };
        for (const fn of this.sockets) fn(socket);
        if (socket.secureHandler) socket.secureHandler();
        if (!this.broken) callback(fakeResponse);
      },
    };
    record.calls.push({ href: url?.href ?? String(url), options });
    return req;
  };
  const dnsRecord = { calls: [] };
  const fakeLookup = async (hostname, options) => { dnsRecord.calls.push({ hostname, options }); return PUBLIC4; };
  httpsCjs.request = fakeRequest;
  dnsCjs.lookup = fakeLookup;
  syncBuiltinESMExports();
  const httpsStubActive = httpsNamespace.request === fakeRequest;
  const dnsStubActive = dnsNamespace.lookup === fakeLookup;
  note('模块替身是否已接管活绑定(否则整段跳过)', { 'node:https.request': httpsStubActive, 'node:dns/promises.lookup': dnsStubActive });
  try {
    if (!httpsStubActive) {
      note('跳过默认传输用例', 'syncBuiltinESMExports 没能替换 node:https 的命名导出绑定');
    } else {
      // 公网 IP 字面量:不解析域名 ⇒ 必然走 defaultRequester。替身已确认接管,绝无真实连接。
      const LITERAL = 'https://93.184.216.34/direct.json';
      const c = track(new LibraryChecker(store, { officialUrls: [LITERAL], checkTimeoutMs: 2000 }));
      await count(() => assert.equal(c.status().transport, 'native-https'), '不注入钩子 => transport=native-https');
      const item = mkOfficial(LITERAL, ptrSpec('/a', 1));
      const res = await settled(c.check(item.id), 5000, '默认传输成功路径');
      await count(() => assert.equal(res.state, 'ok', `实际 ${res.state}/${res.reason}`), '公开默认传输路径能取源并判 ok');
      const call = record.calls[0];
      await count(() => assert.equal(record.endCalled, 1), 'req.end() 调用一次');
      await count(() => assert.equal(call.href, LITERAL), 'https.request 收到目标 URL');
      await count(() => assert.equal(call.options.method, 'GET'), 'method=GET');
      await count(() => assert.equal(call.options.agent, false), 'agent=false(无连接池复用)');
      await count(() => assert.equal(call.options.headers['Accept-Encoding'], 'identity'), 'Accept-Encoding: identity(不请求压缩)');
      await count(() => assert.equal(call.options.signal instanceof AbortSignal, true), 'AbortSignal 交给 https.request');
      let allAddrs = null;
      let oneAddr = null;
      call.options.lookup('93.184.216.34', { all: true }, (_e, addrs) => { allAddrs = addrs; });
      call.options.lookup('93.184.216.34', {}, (_e, address, family) => { oneAddr = { address, family }; });
      await count(() => assert.deepEqual(allAddrs, [{ address: '93.184.216.34', family: 4 }]),
        'lookup(all) 返回已校验并钉住的地址(不做第二次解析)');
      await count(() => assert.deepEqual(oneAddr, { address: '93.184.216.34', family: 4 }),
        'lookup(非 all) 同样回钉住地址与 family');
      await count(() => assert.equal(record.destroyed.length, 0), 'remoteAddress 与钉住地址一致 => 不 destroy');
      await count(() => assert.equal(bodyState.destroyed, true), '默认传输读完 body 也 destroy');
      record.remoteAddress = '10.0.0.1';
      const item2 = mkOfficial(LITERAL, ptrSpec('/a', 1));
      const res2 = await settled(c.check(item2.id), 5000, '默认传输地址不一致');
      await count(() => assert.equal(res2.state, 'unknown'), 'secureConnect 地址与钉住地址不一致 => unknown');
      await count(() => assert.equal(res2.reason, 'connection_address_mismatch'), '地址不一致 reason=connection_address_mismatch');
      await count(() => assert.equal(record.destroyed.includes('connection_address_mismatch'), true), '不一致时确实调用了 req.destroy');
      await count(() => assert.equal(store.checks(item2.id).total, 1), '不一致也留档(unknown 有据)');
      if (dnsStubActive) {
        record.remoteAddress = '93.184.216.34'; // 复位:上一段故意换成了不一致的地址
        const c2 = track(new LibraryChecker(store, { officialUrls: [URL_DOC], checkTimeoutMs: 2000 }));
        const item3 = mkOfficial(URL_DOC, ptrSpec('/a', 1));
        const res3 = await settled(c2.check(item3.id), 5000, '默认 DNS 路径');
        await count(() => assert.equal(res3.state, 'ok', `实际 ${res3.state}/${res3.reason}`), '域名走公开默认 DNS 路径也能核对');
        await count(() => assert.deepEqual(dnsRecord.calls.at(-1), { hostname: 'example.com', options: { all: true, verbatim: true } }),
          'defaultResolver 调 lookup(host, {all:true, verbatim:true})');
      } else {
        note('跳过默认 DNS 用例', 'syncBuiltinESMExports 没能替换 node:dns/promises 的命名导出绑定');
      }
    }
  } finally {
    httpsCjs.request = realRequest;
    dnsCjs.lookup = realLookup;
    syncBuiltinESMExports();
  }
  await count(() => assert.equal(httpsNamespace.request, realRequest), 'finally 已还原 https.request(不污染后续用例)');
  await count(() => assert.equal(dnsNamespace.lookup, realLookup), 'finally 已还原 dns.lookup');
}

// ─────────────────────────────────────────────────────────────────────────────
section('11) 超时与 deadline:异步 / 阻塞式同步 / 挂死 body');
{
  const { checker } = officialChecker({ spec: () => new Promise(() => {}), checkTimeoutMs: 80 });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const t0 = performance.now();
  const res = await settled(checker.check(item.id), 4000, '异步永不结算的 requester');
  const elapsed = performance.now() - t0;
  note('异步超时耗时 ms', Math.round(elapsed));
  await count(() => assert.equal(res.state, 'unknown'), 'requester 永不结算 => unknown(不是挂住)');
  await count(() => assert.equal(res.reason, 'timeout'), 'requester 永不结算 reason=timeout');
  await count(() => assert.equal(elapsed < 2000, true, `实际 ${Math.round(elapsed)} ms`), '超时在有限时间内生效');
  await count(() => assert.equal(checker.status().activeCount, 0), '超时后 activeCount=0');
}
{
  const { checker, holder } = officialChecker({ spec: { hang: true }, checkTimeoutMs: 80 });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 4000, '挂死 body 超时');
  await count(() => assert.equal(res.state, 'unknown'), 'body 永不产出且无视 signal => unknown');
  await count(() => assert.equal(res.reason, 'timeout'), '挂死 body reason=timeout');
  await count(() => assert.equal(holder.body.destroyed, true), '挂死 body 超时后 destroy 被调用');
  await count(() => assert.equal(checker.status().activeCount, 0), '挂死 body 超时后 activeCount=0');
}
{
  const t0Block = () => { const s = performance.now(); while (performance.now() - s < 300) { /* 阻塞事件循环 */ } };
  const { checker } = officialChecker({
    spec: async () => { t0Block(); return response({ chunks: [Buffer.from('{"a":1}')] }).response; },
    checkTimeoutMs: 50,
  });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const t0 = performance.now();
  const res = await settled(checker.check(item.id), 5000, '阻塞式同步 requester');
  const elapsed = performance.now() - t0;
  note('阻塞式同步 requester 实测', { state: res.state, reason: res.reason, ms: Math.round(elapsed) });
  await count(() => assert.equal(elapsed >= 250, true, `实际 ${Math.round(elapsed)} ms(阻塞确实发生了)`), '阻塞式同步 requester 确实阻塞了事件循环');
  await count(() => assert.notEqual(res.state, 'ok', `阻塞 300 ms > 超时 50 ms,不得判 ok(实际 state=${res.state} reason=${res.reason})`),
    '事件循环被阻塞超过超时后,不得判 ok');
  await count(() => assert.equal(res.reason, 'timeout', `期望 timeout,实际 ${res.reason}(deadline 没传导到阻塞点)`),
    '阻塞式同步 requester 之后按 performance.now deadline 判 timeout');
}
{
  const t0Block = () => { const s = performance.now(); while (performance.now() - s < 300) { /* 阻塞事件循环 */ } };
  const { checker, holder } = officialChecker({
    records: () => { t0Block(); return PUBLIC4; },
    spec: { chunks: [Buffer.from('{"a":1}')] },
    checkTimeoutMs: 50,
  });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 5000, '阻塞式同步 resolver');
  note('阻塞式同步 resolver 实测', { state: res.state, reason: res.reason, httpCalls: holder.calls.length });
  await count(() => assert.notEqual(res.state, 'ok', `阻塞 300 ms > 超时 50 ms,不得判 ok(实际 state=${res.state} reason=${res.reason})`),
    '阻塞式同步 resolver 之后不得判 ok');
  await count(() => assert.equal(res.reason, 'timeout', `期望 timeout,实际 ${res.reason}(deadline 没传到 resolveAddress)`),
    '阻塞式同步 resolver 之后按 deadline 判 timeout');
}
{
  const { checker } = officialChecker({
    records: async () => { await new Promise((r) => setTimeout(r, 200)); return PUBLIC4; },
    spec: { chunks: [Buffer.from('{"a":1}')] },
    checkTimeoutMs: 50,
  });
  const item = mkOfficial(URL_DOC, ptrSpec('/a', 1));
  const res = await settled(checker.check(item.id), 4000, '异步慢 resolver');
  await count(() => assert.equal(res.reason, 'timeout'), '异步慢 resolver => timeout');
}

// ─────────────────────────────────────────────────────────────────────────────
section('12) 收尾:checker 全关 / store 全关 / 临时目录清理');
for (const c of checkers) { try { await settled(c.close(), 4000, 'close'); } catch (e) { note('close 失败', String(e?.message ?? e)); } }
await count(() => assert.equal(checkers.every((c) => c.status().closed === true), true), '所有 checker 已关闭');
const beforeClose = store.stats();
await count(() => assert.equal(beforeClose.ok, true), 'store 仍可用(本文件从未关过 store)');
store.close();
await count(() => assert.equal(store.close().already, true), 'store close 幂等');
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用,交给系统清 */ }

console.log(`\n断言 ${assertions} 条,失败 ${failed} 条`);
console.log(failed === 0 ? '✓ library-checker 全部通过' : `✗ library-checker 有 ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
