// 请求体上限(4 MiB)行为契约测试 —— 针对 1.5.3(2026-09-29 夜修)那份缺陷:导入批撞 4 MiB 上限时连接被砍、前端只见「批失败(网关)」;原始缺陷报告未随本包公开,故本节自足 —— 判据与期望值全部写在下面。
// ---------------------------------------------------------------------------
// 这一节驱动的是**真实的 `readBody` 和真实的 HTTP 处理器**(`registerApi` + 假 webServer),
// 不是"只调一个工具函数":整条修复的落点有两处 —— `readBody` 的排空态、`guard` 的 413 出口;
// 只证明其中一处等于没证明(错误对象产出来了但送不出去,就是修前的原状)。
//
// 判据(修前 → 修后),实测值一律打印出来(报告要求:不接受"没报错"):
//   · T1 正常路径必须与**旧实现逐字一致**(旧实现从备份里逐字抄进来当标尺,不是凭记忆重写)。
//   · T2 超限后**不砍连接**:继续消费 data,直到 'end' 才 reject;排空期 destroy() 零调用。
//   · T3 超限后**不缓存**:已缓存的那几个 chunk 也必须被丢掉 —— 用 `Array.prototype.push` 记录器
//        直接看内部数组的**实际留存**,并拿旧实现做仪器的正对照(旧实现能看见留存 ⇒ 记录器有效)。
//   · T4/T5 排空不是免费的:硬熔断(drainMax)+ 静默超时(drainIdleMs)两道闸各有一条测试。
//   · T6 端点级端到端:5 MiB 打到真路由上,必须读到 **413 JSON**(修前只有 ECONNRESET)。
//   · T7 socket 已死时不许抛(guard 的 `res.destroyed` 守卫是硬要求)。
//   · V4 源码护栏:把上面几条钉住,防止将来被顺手删掉。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { readBody, registerApi } = await imp('lib/host/api.js');

let ok = true;
/** 每条断言**都把实测值印出来** —— 判绿不能靠"没报错",要靠看得见的数。 */
const check = (c, m) => { if (!c) ok = false; console.log((c ? '  ✓ ' : '  ✗ ') + m); };
const head = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length)));
const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

/** 旧实现**逐字拷贝**(包外备份 `api.js.20260929-221726.bak` 的 :139-155)。
 *  只作为 T1 的比对标尺;它那句 "reject + 同一拍 destroy" 是**修前的原状**,不参与别的断言。 */
function legacyReadBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('单次请求体过大(超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限),请拆分后重试'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 假请求:readBody 只监听 data/end/error;`destroy()` 可记录(排空态**不该**碰它)。 */
const mkReq = ({ onDestroy } = {}) => {
  const req = new EventEmitter();
  req.url = '/import/file/batch'; req.method = 'POST';
  req.headers = { host: '127.0.0.1:3080' };
  req.destroyed = false;
  req.destroyCount = 0;
  req.destroy = () => { req.destroyCount++; req.destroyed = true; if (onDestroy) onDestroy(); };
  return req;
};
/** 同时驱动新旧两个实现,喂同一串 chunk,返回两条结局(用于逐字比对)。 */
const runBoth = async (chunks, maxBytes) => {
  const rn = mkReq(); const ro = mkReq();
  const pn = readBody(rn, maxBytes, { drainIdleMs: 1000 });
  const po = legacyReadBody(ro, maxBytes);
  for (const c of chunks) { rn.emit('data', c); ro.emit('data', c); }
  rn.emit('end'); ro.emit('end');
  const pack = (p) => p.then((v) => ({ v }), (e) => ({ e }));
  const [a, b] = await Promise.all([pack(pn), pack(po)]);
  return { a, b };
};

// ===========================================================================
// T1 正常路径回归:小 body 单 chunk / 多 chunk 拼装,结果与旧实现**逐字一致**
// ===========================================================================
head('T1 正常路径回归(与旧实现逐字比对)');
{
  // ① 单 chunk
  const one = await runBoth([Buffer.from('{"items":[{"a":1}]}', 'utf8')], 8192);
  check(one.a.v === '{"items":[{"a":1}]}', '1) 单 chunk 解析出原文,实测 ' + JSON.stringify(one.a.v));
  check(one.a.v === one.b.v, '1) 与旧实现逐字一致(旧 ' + JSON.stringify(one.b.v) + ')');

  // ② 多 chunk 拼装,且**故意把中文按字节切断**(跨 chunk 的多字节字符):
  //    这条是 Buffer.concat 语义的命门 —— 若有人改成"每 chunk 各自 toString 再拼",这里立刻红。
  const s = '单次请求体过大(超过 4MB 上限),请拆分后重试';
  const buf = Buffer.from(s, 'utf8');
  const cut = 5;
  const mid = await runBoth([buf.subarray(0, cut), buf.subarray(cut, cut + 7), buf.subarray(cut + 7)], 8192);
  check(mid.a.v === s, '2) 3 段 chunk(含被切断的多字节汉字)拼回原文,实测 ' + JSON.stringify(mid.a.v));
  check(mid.a.v === mid.b.v, '2) 与旧实现逐字一致(字节切点 ' + cut + '/' + (cut + 7) + ')');

  // ③ 空 body(只有 end)
  const empty = await runBoth([], 8192);
  check(empty.a.v === '' && empty.a.v === empty.b.v, '3) 空 body → 空串(旧 ' + JSON.stringify(empty.b.v) + ')');

  // ④ 边界:**正好等于** maxBytes 必须成功(旧实现的判据是 `size > maxBytes`,不是 `>=`)
  const exact = await runBoth([Buffer.alloc(8192, 0x61)], 8192);
  check(typeof exact.a.v === 'string' && exact.a.v.length === 8192, '4) size === maxBytes 仍成功,实测长度 ' + exact.a.v.length);
  check(exact.a.v === exact.b.v, '4) 与旧实现逐字一致(边界不多不少)');

  // ⑤ 边界:maxBytes + 1 必须走超限路,且**旧实现会 destroy、新实现不会**
  const over = await runBoth([Buffer.alloc(8193, 0x61)], 8192);
  check(!!over.a.e && over.a.e.code === 'BODY_TOO_LARGE', '5) size === maxBytes+1 → 新实现 reject BODY_TOO_LARGE');
  check(over.a.e.message === over.b.e.message, '5) message 与旧文案**逐字相同**,实测 ' + JSON.stringify(over.a.e.message));
  check(over.b.e && over.b.e.code === undefined, '5) ★负对照:旧实现的错误对象**没有** code(所以 413 出口以前无从判断)');
}

// ===========================================================================
// T2 超限排空:到 'end' 才 reject;排空期 destroy() 零调用
// ===========================================================================
head('T2 超限排空(不砍连接,等到 end)');
{
  const req = mkReq();
  const ev = [];
  let err = null;
  const p = readBody(req, 64, { drainIdleMs: 5000 });
  p.then(() => ev.push('resolve'), (e) => { err = e; ev.push('reject'); });

  for (const n of [65, 100, 35]) { ev.push('data' + n); req.emit('data', Buffer.alloc(n, 0x62)); }
  await flush();
  const beforeEnd = ev.join('>');
  check(!ev.includes('reject'), '1) 超限后到 end 之前**没有** reject(实测事件序 ' + beforeEnd + ')');
  check(req.destroyCount === 0, '2) 排空期间 destroy() 零调用(实测 ' + req.destroyCount + ')');

  ev.push('end'); req.emit('end');
  await flush();
  check(ev.join('>') === 'data65>data100>data35>end>reject',
    '3) reject 发生在 **end 之后**(实测事件序 ' + ev.join('>') + ')');
  check(!!err && err.code === 'BODY_TOO_LARGE' && err.status === 413, '4) code/status 实测 ' + (err && err.code) + '/' + (err && err.status));
  check(!!err && err.limit === 64, '5) limit === maxBytes,实测 ' + (err && err.limit));
  check(!!err && err.got === 200, '6) got === 排空结束时的**真实字节数** 200(实测 ' + (err && err.got) + ')');
  check(!!err && err.message === '单次请求体过大(超过 ' + Math.round(64 / 1024 / 1024) + 'MB 上限),请拆分后重试',
    '7) message 逐字沿用旧文案,实测 ' + JSON.stringify(err && err.message));
  check(req.destroyCount === 0, '8) 整条排空路径 destroy() 依然零调用(实测 ' + req.destroyCount + ')');
}

// ===========================================================================
// T3 不缓存:超限第一拍就把已缓存的 chunk 丢掉(**行为断言**,不是数源码)
// ---------------------------------------------------------------------------
// 为什么走"记录内部数组"这条路,而不是数源码里 `chunks.push(` 的位置:
//   排空路径**从不拼装**那个数组(拼装只发生在正常路径的 'end'),所以"缓存有没有被丢"从返回值、
//   从错误对象上**完全看不见**,唯一可断言的证据就是那个数组本身。这里临时换掉
//   `Array.prototype.push`,记录每个数组收到过多少 Buffer 字节、以及它**当时的 length** ——
//   两个实现跑同一串 chunk:旧实现留下 8192 B,新实现在超限那一拍清零 ⇒ 记录器有效、丢弃是真的。
//   (V4 另有源码护栏兜底,两条一起钉。)
// ===========================================================================
head('T3 超限后不缓存(push 记录器:直接看内部数组的留存)');
let pushSeen = new Map();
let concatCalls = [];
{
  const origPush = Array.prototype.push;
  const origConcat = Buffer.concat;
  // 记录器里**不碰** Array.prototype.push 自己(只用 Map / 下标),否则递归。
  Array.prototype.push = function spyPush(...args) {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (Buffer.isBuffer(a)) pushSeen.set(this, (pushSeen.get(this) || 0) + a.length);
    }
    return origPush.apply(this, args);
  };
  Buffer.concat = function spyConcat(...args) {
    concatCalls.push(args[0] instanceof Array ? args[0].reduce((n, b) => n + (b && b.length || 0), 0) : -1);
    return origConcat.apply(Buffer, args);
  };

  const instrumented = async (impl, chunks, maxBytes, opts) => {
    const before = new Set(pushSeen.keys());
    const req = mkReq();
    const p = impl(req, maxBytes, opts);
    for (const c of chunks) req.emit('data', c);
    req.emit('end');
    await p.then(() => {}, () => {});
    return {
      req,
      arrays: [...pushSeen.entries()].filter(([arr]) => !before.has(arr))
        .map(([arr, bytes]) => ({ pushedBytes: bytes, retained: arr.length, retainedBytes: arr.reduce((n, b) => n + (b && b.length || 0), 0) })),
    };
  };

  const chunk = Buffer.alloc(4096, 0x63);
  const feed = [chunk, chunk, chunk, chunk];   // 4×4096;上限 8192 ⇒ 第 3 拍越界

  let now = null; let old = null; let concatOnDrain = null;
  try {
    concatCalls = [];
    now = await instrumented(readBody, feed, 8192, { drainIdleMs: 5000 });
    concatOnDrain = concatCalls.slice();   // 新实现的排空路径到底调没调 Buffer.concat(须在跑旧实现前取)
    // ★仪器的正对照:同一套记录器跑旧实现 —— 它必须**看得见留存**(8192 B),否则第 1 条等于没测
    old = await instrumented(legacyReadBody, feed, 8192);
  } finally {
    // 先卸载仪器、再做断言:免得 check() 自己的 console.log 撞进记录器
    Array.prototype.push = origPush;
    Buffer.concat = origConcat;
  }

  const nArr = now.arrays.filter((a) => a.pushedBytes >= 8192);
  check(nArr.length >= 1 && nArr.every((a) => a.retained === 0),
    '1) 新实现:超限第一拍后内部缓存数组 length === 0,实测 ' + JSON.stringify(nArr));
  // 4×4096、上限 8192:前两拍(8192 B)进缓存,第 3 拍越界 ⇒ 旧实现留下的正是这 8192 B。
  // 新实现"收过同样的 8192 B"却"留存 0" ⇒ 丢弃发生在超限那一拍,不是"压根没缓存"。
  check(nArr.length >= 1 && nArr[0].pushedBytes === 8192,
    '2) 而它**确实缓存过** 8192 B(2 个 4096 的 chunk ⇒ 丢弃不是"压根没缓存"),实测 ' + JSON.stringify(nArr[0]));
  check(concatOnDrain.length === 0, '3) 排空路径从不拼装超限缓冲:Buffer.concat 调用 0 次,实测 ' + JSON.stringify(concatOnDrain));

  // ★仪器的正对照:同一套记录器跑旧实现 —— 它必须**看得见留存**(8192 B),否则第 1 条等于没测
  const oArr = old.arrays.filter((a) => a.pushedBytes >= 8192);
  check(oArr.length >= 1 && oArr[0].retainedBytes === 8192 && oArr[0].retained === 2,
    '4) ★正对照:旧实现在同一位置留下 8192 B / 2 个 chunk(记录器有效,第 1 条不是假绿),实测 ' + JSON.stringify(oArr[0]));
  check(old.req.destroyCount >= 1, '5) ★负对照:旧实现超限即 destroy()(实测 ' + old.req.destroyCount + ' 次),这正是 reset 的来源');
}

// ===========================================================================
// T4 真熔断:超过 drainMax ⇒ 立刻 destroy() + reject(且只 reject 一次)
// ===========================================================================
head('T4 硬熔断(drainMax)');
{
  const req = mkReq();
  let err = null; let rejectCount = 0;
  const p = readBody(req, 64, { drainMax: 200, drainIdleMs: 5000 });
  p.then(() => {}, (e) => { err = e; rejectCount++; });
  req.emit('data', Buffer.alloc(65));    // 越界 → 排空(65 ≤ 200,不熔断)
  req.emit('data', Buffer.alloc(100));   // 165 ≤ 200
  check(req.destroyCount === 0, '1) 165 B 仍在 drainMax 内:destroy() 0 次(实测 ' + req.destroyCount + ')');
  req.emit('data', Buffer.alloc(100));   // 265 > 200 ⇒ 熔断
  await flush();
  check(req.destroyCount === 1, '2) 越过 drainMax 立即 destroy(),实测调用 ' + req.destroyCount + ' 次');
  check(!!err && err.code === 'BODY_TOO_LARGE' && err.got === 265 && err.limit === 64,
    '3) 熔断仍报 413 语义:code=' + (err && err.code) + ' got=' + (err && err.got) + ' limit=' + (err && err.limit));

  // 熔断之后 socket 上还会有 'end'/'error' 陆续到达 —— reject 只许发生一次
  req.emit('end'); req.emit('error', new Error('ECONNRESET(模拟)'));
  await flush();
  check(rejectCount === 1, '4) 熔断后补发 end + error:reject 仍只发生一次(实测 ' + rejectCount + ')');
  check(req.destroyCount === 1, '5) 补发的事件没有再次 destroy()(实测 ' + req.destroyCount + ')');
}

// ===========================================================================
// T5 静默超时:drainIdleMs 到点 ⇒ destroy() + reject;计时器必须被清
// ===========================================================================
head('T5 静默超时(drainIdleMs)+ 计时器清理');
{
  const timeouts = () => (typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length : -1);
  const tBase = timeouts();
  const req = mkReq();
  let err = null;
  const t0 = Date.now();
  const p = readBody(req, 64, { drainIdleMs: 20 });
  req.emit('data', Buffer.alloc(65));    // 进入排空态,开静默计时器,此后**不再灌数据**
  const armed = timeouts();
  err = await p.then(() => null, (e) => e);
  const dt = Date.now() - t0;
  check(dt >= 20, '1) 到点才 reject(实测 ' + dt + ' ms ≥ 20 ms)');
  check(req.destroyCount === 1, '2) 静默到点 destroy() 一次,实测 ' + req.destroyCount + ' 次');
  check(!!err && err.code === 'BODY_TOO_LARGE' && err.got === 65, '3) 仍报 413 语义:code=' + (err && err.code) + ' got=' + (err && err.got));
  check(armed === tBase + 1, '4) 排空态里确实**开着**一个计时器(活跃 Timeout 数 ' + tBase + ' → ' + armed + ')');
  const tAfter = timeouts();
  check(tAfter === tBase, '5) settle 后计时器已被 clearTimeout(活跃 Timeout 数回到 ' + tAfter + ',基线 ' + tBase + ')');
  await flush(60);
  check(req.destroyCount === 1 && timeouts() === tBase,
    '6) 再等 60 ms(3×idle):无第二次开火、无悬挂计时器(实测 destroy=' + req.destroyCount + ' Timeout=' + timeouts() + ')');
}

// ===========================================================================
// T6 端点级端到端:5 MiB 打到**真路由**上 ⇒ HTTP 413 + 那句中文文案真的送得出去
//    (假 server + 假 req/res + registerApi,与 tests/branch.test.mjs:83-119 同法;
//     本节的假 res 额外带 `writableEnded`/`destroyed` —— 那是 guard 里 413 出口的判据)
// ===========================================================================
head('T6 端点级端到端(/import/file/batch,5 MiB)');
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
process.env.DSH_LING_GUARD = 'off';
const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-bodylimit-'));
const db = new MemoryStore(join(dir, 'm.db'));
const settings = new SettingsFile(join(dir, 'set'));
const routes = new Map();
const fakeServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
const gateStub = {
  snapshotIds: () => [], snapshotOf: () => null, isRunning: () => false,
  pendingCount: () => 0, recentSessionId: () => null, markSnapStale: () => {},
};
registerApi({ get: (n) => (n === 'webServer' ? fakeServer : undefined) }, { gate: gateStub, memory: db, settings }, {});

/** 假请求/假响应:req 记录 `destroy()`;res 带 `writableEnded`/`destroyed`(真 res 有,判据靠它)。 */
const fire = (path, chunks, { preDestroyed = false } = {}) => {
  const handler = routes.get('/api/dsh-ling' + path);
  if (typeof handler !== 'function') throw new Error('路由没挂上:' + path);
  const out = { status: 0, raw: '', body: null, ends: 0, headers: {} };
  const req = new EventEmitter();
  req.url = path; req.method = 'POST'; req.headers = { host: '127.0.0.1:3080' };
  req.destroyCount = 0;
  req.destroy = () => { req.destroyCount++; res.destroyed = true; };
  const res = {
    statusCode: 0, writableEnded: false, destroyed: preDestroyed,
    setHeader: (k, v) => { out.headers[k] = v; },
    end(payload) {
      out.ends++; this.writableEnded = true;
      out.status = this.statusCode; out.raw = String(payload ?? '');
      try { out.body = JSON.parse(out.raw); } catch { out.body = null; }
    },
  };
  const done = handler(req, res);
  for (const c of chunks) req.emit('data', c);
  req.emit('end');
  return { out, done, req };
};

{
  // ① 正对照:小 body 照常走完端点(证明这条修复没改掉既有语义)
  const small = fire('/import/file/batch', [Buffer.from(JSON.stringify({ items: [] }), 'utf8')]);
  await small.done;
  check(small.out.status === 200 && small.out.body && small.out.body.reason === 'empty',
    '1) 正对照:小 body 仍是 200 + reason=empty,实测 ' + small.out.status + ' ' + small.out.raw.slice(0, 60));

  // ② 5 MiB:整条修复的**唯一硬证据** —— 错误文案真的送得出去
  const chunks = []; for (let i = 0; i < 5; i++) chunks.push(Buffer.alloc(MB, 0x7b));
  const big = fire('/import/file/batch', chunks);
  await big.done;
  check(big.out.status === 413, '2) 5 MiB body → HTTP **413**(修前是 ECONNRESET,浏览器只看到 fetch reject),实测 ' + big.out.status);
  check(!!big.out.body && big.out.body.ok === false && big.out.body.reason === 'too-large',
    '3) reason === "too-large",实测 ' + JSON.stringify(big.out.body && big.out.body.reason));
  check(!!big.out.body && big.out.body.limit === 4194304, '4) limit === 4194304(4 MiB),实测 ' + (big.out.body && big.out.body.limit));
  check(!!big.out.body && big.out.body.got === 5 * MB, '5) got === 真实长度 ' + (5 * MB) + ',实测 ' + (big.out.body && big.out.body.got));
  check(!!big.out.body && big.out.body.message === '单次请求体过大(超过 4MB 上限),请拆分后重试',
    '6) 那句现成的中文文案真的到了响应体里,实测 ' + JSON.stringify(big.out.body && big.out.body.message));
  check(big.req.destroyCount === 0, '7) 413 这条路上没有 destroy()(连接健康,不是砍完再补一句),实测 ' + big.req.destroyCount);
  check(big.out.ends === 1, '8) 只写了一次响应(实测 res.end 调用 ' + big.out.ends + ' 次)');
  check(big.out.raw === JSON.stringify({ ok: false, reason: 'too-large', message: '单次请求体过大(超过 4MB 上限),请拆分后重试', limit: 4194304, got: 5 * MB }),
    '9) 响应体逐字等于约定形态,实测 ' + big.out.raw);
}

// ===========================================================================
// T7 socket 已死时不许抛(两条路都要:413 路 + 熔断路)
// ===========================================================================
head('T7 socket 已死时不抛(res.destroyed 守卫)');
{
  // ① 413 路:res 一开始就 destroyed ⇒ 不许再往死 socket 写
  const dead = fire('/import/file/batch', [Buffer.alloc(5 * MB, 0x7b)], { preDestroyed: true });
  let threw = null;
  await dead.done.catch((e) => { threw = e; });
  check(threw === null, '1) socket 已死 + 超限:处理器没有抛(实测 ' + (threw ? String(threw.message) : 'null') + ')');
  check(dead.out.ends === 0 && dead.out.status === 0, '2) 一个字节都没写(实测 res.end ' + dead.out.ends + ' 次,status ' + dead.out.status + ')');

  // ② 熔断路:真过 drainMax(64 MiB)⇒ readBody 自己 destroy() ⇒ res.destroyed 变真。
  //    复用**同一个** 8 MiB buffer 只为了让测试不必真分配 72 MiB:排空态只读 `c.length`、
  //    不持有 chunk(见 T3),复用不改变被测路径。
  const dbg = [];
  const origDebug = console.debug;
  console.debug = (...a) => { dbg.push(a.map((x) => String(x)).join(' ')); };
  let fuseThrew = null;
  let fuseRes = null;
  try {
    const eightMB = Buffer.alloc(8 * MB, 0x64);
    const fuse = fire('/import/file/batch', new Array(9).fill(eightMB));
    fuseRes = fuse;
    await fuse.done.catch((e) => { fuseThrew = e; });
  } finally { console.debug = origDebug; }
  check(fuseThrew === null, '3) 熔断(9×8 MiB > drainMax 64 MiB)+ socket 死:不抛(实测 ' + (fuseThrew ? String(fuseThrew.message) : 'null') + ')');
  check(fuseRes.req.destroyCount === 1, '4) 熔断确实 destroy() 了一次(实测 ' + fuseRes.req.destroyCount + ')');
  check(fuseRes.out.ends === 0, '5) 死 socket 上 res.end() 零调用(实测 ' + fuseRes.out.ends + ' 次)');
  check(dbg.some((l) => l.includes('response dropped (socket gone)')),
    '6) 走的是"响应丢弃"分支而不是 500,实测日志 ' + JSON.stringify(dbg));
}

// ===========================================================================
// T8 首字节闸(红队 E5):只发头、不发体 —— 修前在应用层**没有任何计时器**
// ---------------------------------------------------------------------------
// 事实(红队实测):正确 cookie + `Content-Length: 4194304` + **实发 0 字节** ⇒ 20000 ms 零响应;
// 兜底只剩 Node 自己的 `requestTimeout`(默认 300 s)。根因:计时器原先只在 `req.on('data')` 里武装
// ⇒ 一个 chunk 都没来时那个 Promise **永远挂着**,连计时器都没有。
// 本节两条腿(**缺一条就等于没验**):
//   · 正:注入 drainIdleMs=20 ⇒ 到点就断,并断言**不是**在等 300 s;
//   · 负对照:同样注入 20 ms 闸门,但**正常把 body 发完** ⇒ 照常成功。若"首 data 解除闸门"这个动作
//     漏写,正例照样绿、而**合法的慢上传会被误杀** —— 那比原来的洞更糟,所以负对照是另一半判据。
//   · 正例带一条 1500 ms **死线**:坏实现下这个 Promise 永不 settle,不加死线整个文件会停在那一行
//     (exit 13),红得没有下文;有死线则断言照常打 ✗ 并继续跑完负对照与 V4 护栏。
// ===========================================================================
head('T8 首字节闸(E5:只发头不发体)+ 负对照(慢但持续的合法上传)');
{
  const timeouts = () => (typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length : -1);
  const tBase = timeouts();

  // ① 正:只发头、一个字节的体都不发(除 req 对象外什么都不发)
  //    ⚠️ 这个 Promise 在**坏实现**下永不 settle(修前正是如此:应用层一个计时器都没有)—— 直接 await
  //    会让整个文件停在这一行:Node 检测到"顶层 await 未决 + 无活动句柄"就直接 exit 13,后面的
  //    两条负对照与 V4 护栏**一条都不执行**(红是红了,却看不到到底红在哪几条)。故加一条**死线**:
  //    远大于闸门(20 ms)、又远小于 Node 自己的 300 s 兜底 ⇒ 到点只让断言打 ✗ 并继续往下跑。
  //    死线在结局到达时立刻清掉 —— 否则它会污染下面第 7/12 条的"活跃 Timeout 计数"。
  const DEADLINE = Symbol('T8 死线');
  const withDeadline = (p, ms) => {
    let t = null;
    const dl = new Promise((res) => { t = setTimeout(() => res(DEADLINE), ms); });
    const stop = () => { if (t) { clearTimeout(t); t = null; } };
    return Promise.race([p, dl]).then((v) => { stop(); return { value: v }; }, (e) => { stop(); return { error: e }; });
  };
  const t0 = Date.now();
  let destroyedAt = -1;
  const req = mkReq({ onDestroy: () => { if (destroyedAt < 0) destroyedAt = Date.now() - t0; } });
  const got1 = await withDeadline(readBody(req, 64, { drainIdleMs: 20 }).then(() => null, (e) => e), 1500);
  const timedOut = got1.value === DEADLINE;   // 死线到点 ⇒ 那一刻仍**没有任何结局**
  const err = timedOut ? null : got1.value;
  const dt = Date.now() - t0;
  check(!timedOut, '0) 只发头不发体 ⇒ 闸门到点在**死线内**有了结局(实测 ' + dt + ' ms'
    + (timedOut ? ' ⇒ 死线 1500 ms 到点仍无结局,正是修前那个形状' : '') + ')');
  check(!!err && err.code === 'BODY_IDLE_NO_FIRST_BYTE',
    '1) 只发头不发体 ⇒ reject,code 实测 ' + JSON.stringify(err && err.code) + '(不再是"永远挂着")');
  check(dt >= 20 && dt < 300,
    '2) 闸门 20 ms ⇒ 实测 ' + dt + ' ms 内 reject(断言 < 300 ms:证明**不是**在等 Node 的 300 s 兜底)');
  check(req.destroyCount === 1 && destroyedAt >= 0 && destroyedAt < 300,
    '3) destroy() 恰一次、发生在 ' + destroyedAt + ' ms(实测调用 ' + req.destroyCount + ' 次)');
  check(!!err && err.status === 408 && err.got === 0 && err.limit === undefined,
    '4) 老实报"对端一个字节都没发":status=' + (err && err.status) + ' got=' + (err && err.got)
    + ' limit=' + (err && err.limit) + '(**没有** limit —— 它不是体量问题)');
  check(!!err && err.code !== 'BODY_TOO_LARGE' && !/MB/.test(String(err && err.message)),
    '5) **不是** 413 那套:文案不提体量、不提 MB,实测 ' + JSON.stringify(err && err.message));
  check(!!err && err.idleMs === 20, '6) 回执里的闸门值 = 注入值,实测 ' + (err && err.idleMs) + ' ms');
  check(timeouts() === tBase, '7) settle 后无悬挂计时器(活跃 Timeout 回到基线 ' + tBase + ',实测 ' + timeouts() + ')');

  // ② 负对照一:同 20 ms 闸门、正常传输(每 chunk 间隔 5 ms)⇒ 照常成功
  {
    const r2 = mkReq();
    const p2 = readBody(r2, 8192, { drainIdleMs: 20 });
    const parts = ['正常', '上传', '的', 'body'];
    for (const s of parts) { r2.emit('data', Buffer.from(s, 'utf8')); await flush(5); }
    r2.emit('end');
    const got2 = await p2.then((v) => v, (e) => '✗' + e.message);
    check(got2 === parts.join(''), '8) 负对照一(20 ms 闸门 · chunk 间隔 5 ms)⇒ 照常成功,实测 ' + JSON.stringify(got2));
    check(r2.destroyCount === 0, '9) 负对照一里 destroy() 零调用,实测 ' + r2.destroyCount + ' 次');
  }

  // ③ 负对照二(**确定性**的那条):首字节之后故意静默 5× 闸门(100 ms)再发完 ⇒ 仍必须成功。
  //    专打"闸门忘了在首个 data 里解除"这个错法:那种写法下这 100 ms 静默早被打成超时。
  {
    const r3 = mkReq();
    const p3 = readBody(r3, 8192, { drainIdleMs: 20 });
    r3.emit('data', Buffer.from('慢但持续:', 'utf8'));
    await flush(100);   // = 5 × drainIdleMs
    r3.emit('data', Buffer.from('合法上传', 'utf8'));
    r3.emit('end');
    const got3 = await p3.then((v) => v, (e) => '✗' + e.message);
    check(got3 === '慢但持续:合法上传',
      '10) 负对照二(首字节后静默 100 ms = 5× 闸门)⇒ 仍成功,实测 ' + JSON.stringify(got3));
    check(r3.destroyCount === 0, '11) 负对照二里 destroy() 零调用,实测 ' + r3.destroyCount + ' 次');
    check(timeouts() === tBase, '12) 正常路径全程不留计时器(活跃 Timeout ' + timeouts() + ',基线 ' + tBase + ')');
  }

  // ④ 首字节迟到(闸门内到达):闸门**不该**把"慢一点的连接"误杀 —— 这是首字节闸与排空闸的衔接处。
  {
    const r5 = mkReq();
    const p5 = readBody(r5, 8192, { drainIdleMs: 40 });
    await flush(15);   // < 40:首字节在闸门内到达
    r5.emit('data', Buffer.from('{"ok":1}', 'utf8'));
    r5.emit('end');
    const got5 = await p5.then((v) => v, (e) => '✗' + e.message);
    check(got5 === '{"ok":1}', '13) 首字节在闸门内(15 ms < 40 ms)到达 ⇒ 照常读到,实测 ' + JSON.stringify(got5));
  }
}

// ===========================================================================
// V4 源码护栏(把上面几条钉住,防止将来被顺手删掉)
// ===========================================================================
head('V4 源码护栏(api.js)');
{
  const src = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  /** 切出函数体文本:**不能**直接找第一个 `{` —— 参数表里的默认值 `opts = {}` 就是一个大括号
   *  (第一版护栏就是这么被喂成假绿的:切出 66 字符,后面 10 条全部空判)。先按括号配平跨过参数表,
   *  再从函数体的第一个 `{` 起配平。 */
  const fnTextOf = (text, marker) => {
    const at = text.indexOf(marker);
    if (at < 0) return '';
    let pd = 0; let bodyAt = -1;
    for (let i = text.indexOf('(', at); i < text.length; i++) {
      if (text[i] === '(') pd++;
      else if (text[i] === ')') { pd--; if (pd === 0) { bodyAt = text.indexOf('{', i); break; } }
    }
    if (bodyAt < 0) return '';
    let depth = 0;
    for (let j = bodyAt; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(bodyAt, j + 1); }
    }
    return '';
  };
  const fn = fnTextOf(src, 'export function readBody(');
  check(fn.length > 1500 && /req\.on\('data'/.test(fn), '0) 护栏定位到了 readBody 本体(切出 ' + fn.length + ' 字符)');

  // ── 不缓存在超限后发生 ────────────────────────────────────────────────────
  const pushes = fn.match(/chunks\.push\(/g) || [];
  check(pushes.length === 1 && /if \(size <= maxBytes\) \{ chunks\.push\(c\); return; \}/.test(fn),
    '1) 全函数只有 1 处 chunks.push,且它在 `size <= maxBytes` 分支内(实测命中 ' + pushes.length + ' 处)');
  check(/if \(!draining\) \{ draining = true; chunks\.length = 0; \}/.test(fn),
    '2) 超限第一拍丢弃已缓存(chunks.length = 0 仍在)');
  const concat = fn.match(/Buffer\.concat\(/g) || [];
  check(concat.length === 1, '3) 拼接只发生在正常路径的 end(全函数 1 处,实测 ' + concat.length + ')');

  // ── 413 错误对象 ──────────────────────────────────────────────────────────
  check(/e\.code = 'BODY_TOO_LARGE'/.test(fn) && /e\.status = 413/.test(fn)
    && /e\.limit = maxBytes/.test(fn) && /e\.got = size/.test(fn),
    '4) 错误对象四件套 code=413/limit/got 都在');
  check(/Math\.round\(maxBytes \/ 1024 \/ 1024\) \+ 'MB 上限\),请拆分后重试'/.test(fn),
    '5) message 仍是那句现成文案(没有换措辞)');

  // ── 计时器三条出口都清 ────────────────────────────────────────────────────
  const arm = fn.match(/setTimeout\(/g) || [];
  check(arm.length === 1, '6) 排空只开**一个**计时器(setTimeout 1 处,实测 ' + arm.length + ')');
  check(/if \(settled\) return;\s*settled = true;\s*disarm\(\);\s*reject\(err\);/.test(fn),
    '7) 唯一 reject 出口 fail():settled 一次为真 + 必 disarm');
  check(/req\.on\('end', \(\) => \{\s*disarm\(\);/.test(fn), '8) 出口一 \'end\':先 disarm');
  check(/req\.on\('error', \(e\) => \{ disarm\(\); fail\(e\); \}\)/.test(fn), '9) 出口二 \'error\':disarm + fail');
  check(/if \(size > drainMax\) \{ fail\(tooLarge\(\)\); req\.destroy\(\); return; \}/.test(fn),
    '10) 出口三 熔断:先 fail(内含 disarm)再 destroy');

  // ── guard 里的 413 出口(一处覆盖全部端点)+ 硬守卫 ───────────────────────
  check(/e\.code === 'BODY_TOO_LARGE' && !res\.writableEnded && !res\.destroyed/.test(src),
    '11) 413 出口存在且带 writableEnded/destroyed 双守卫');
  check(/sendJson\(res, 413, \{ ok: false, reason: 'too-large', message: String\(e\.message \|\| ''\), limit: e\.limit, got: e\.got \}\)/.test(src),
    '12) 413 响应体形态与约定一致(ok:false + reason:"too-large" + message/limit/got 三项齐备)');
  check(/if \(!res\.writableEnded && !res\.destroyed\) \{\s*sendJson\(res, 500, \{ ok: false, error: String\(e\?\.message \?\? e\) \}\);/.test(src),
    '13) 500 分支语义未变(只加了守卫)');
  check(/console\.debug\('\[dsh-ling\] response dropped \(socket gone\): %s'/.test(src),
    '14) socket 已死时只记一句 debug,不写响应');

  // ── 没顺手改别的(C5)────────────────────────────────────────────────────
  check(src.includes('const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];'),
    '15) C5 端点体未动:items.slice(0, 500) 原样');
  check(!src.includes('会话契约文件导入(每批 ≤500;客户端分页)'),
    '16) 旧的「每批 ≤500」单一判据已拆(2026-09-29 收口 —— 它正是"客户端按条数写"的源头)');
  check(src.includes('上限口径(2026-09-29 修正') && src.includes('BODY_MAX_BYTES = 4 MiB') && src.includes('takeChunk'),
    '16b) 新契约注释在位:真闸门是字节 + 客户端按字节切批(≤200 条 且 ≤3 MiB/批)');
  check(src.includes('两半是耦合的'),
    '16c) 注释写明两半口径耦合:任何一方单独改上限都会让两端重新错位(本缺陷的成因)');
  check(src.includes("register('/import/file/batch', async (req, res) => {\n      const body = JSON.parse((await readBody(req)) || '{}');"),
    '17) 端点仍写 readBody(req)(不传第二参:全部端点口径不变)');

  // ── 首字节闸(E5)源码护栏 ──────────────────────────────────────────────────
  // 为什么不用 T8 的行为断言替代:行为断言能证明"现在有闸",但证明不了"闸开在**任何事件注册之前**"
  // (开在 data 里就是修前的原状);这里把位置本身钉住。
  const gateAt = fn.indexOf('arm(() => fail(noFirstByte()));');
  // ⚠️ 定位"第一个事件注册"只能用**带回调的真实注册串** `req.on('data', (c) =>` 这类:
  //    短串 `req.on('data'` / `req.on(` 会被**注释里的散文**骗到(本文件与 api.js 的注释里都写着这几个词,
  //    第一版护栏就是这样在 @597 处被喂成假红的 —— 那里的"命中"其实是一句注释)。
  const onSites = ["req.on('data', (c) =>", "req.on('end', () =>", "req.on('error', (e) =>"]
    .map((m) => fn.indexOf(m)).filter((i) => i >= 0);
  const firstOnAt = onSites.length ? Math.min(...onSites) : -1;
  check(gateAt > 0 && firstOnAt > 0 && gateAt < firstOnAt,
    '18) 首字节闸在 readBody 函数体内、**早于**任何 req.on 注册(武装点 @' + gateAt + ' < 首个真实注册 @' + firstOnAt + ',三处注册命中 ' + onSites.length + '/3)');
  check(/if \(!firstByteSeen\) \{ firstByteSeen = true; disarm\(\); \}/.test(fn),
    '19) 首个 data 路径里有对应的**解除**(漏了这里 = 把正常的慢上传误杀成超时)');
  check(/e\.code = 'BODY_IDLE_NO_FIRST_BYTE'/.test(fn) && /e\.status = 408/.test(fn),
    '20) 首字节闸的错误形状 = 408 语义(不拿 413/"体量"问题去说"对端一个字节都没发")');
  const nfb = fn.slice(fn.indexOf('const noFirstByte'), fn.indexOf('const arm = (onIdle)'));
  check(nfb.length > 100 && nfb.length < 900 && !/e\.limit/.test(nfb) && /e\.got = size/.test(nfb),
    '20b) 首字节闸**不带 limit**(切出 ' + nfb.length + ' 字符,含 got、不含 limit ⇒ 它不是体量问题)');
  const armSites = fn.match(/timer = setTimeout\(/g) || [];
  check(armSites.length === 1,
    '21) 仍是**唯一**一个计时器槽(首字节闸与排空闸共用:`timer = setTimeout(` 实测 ' + armSites.length + ' 处)');
  check(/const arm = \(onIdle\) => \{/.test(fn) && /arm\(\(\) => fail\(tooLarge\(\)\)\);/.test(fn),
    '22) 排空态仍武装同一个槽(工厂按 onIdle 分派:排空 = tooLarge,首字节 = noFirstByte)');
}

delete process.env.DSH_LING_GUARD;
console.log('\n请求体上限(4 MiB)行为契约:' + (ok ? '全部通过 ✓' : '存在失败'));
process.exitCode = ok ? 0 : 1;
