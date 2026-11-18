// 后台自动行为的**设置面**测试(2026-10-16):默认值 / 三级优先级 / 写面白名单 / 真实 HTTP 面。
//
// 第 6-9 段是 `/auto` 的**真实 HTTP** 回归(方法闸、夹取与落盘回读、拒绝不写盘、配置旧键线路)——
// 这条线最初的验证是临时起服务手打的,不可重复 ⇒ 下一个人改坏它没有任何东西会红,故固化成常驻证据。
//
// 为什么这套测试存在的第一理由不是"新功能对不对",而是**默认行为一个字节都不许变**:
// 自动深摘、自动探活、反馈回路此前是硬编码/旧配置键驱动的,现在多了一层 settings.auto ——
// 只要默认值抄错一位,或"没设过"被误判成"用户设过",升级当天所有人的后台行为就静默改了。
// 故本套的行为面断言(第 1、2、5 段)比功能面断言(第 3、4 段)更硬:它们钉的是"没动过 = 原样"。
import { ok, eq, section, summary } from './harness.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 第 6 段起是**真实 HTTP** 面(常驻回归):真 Node server + registerApi 的 exact 路由。
// 脚手架(隔离 DSH_HOME / keep-alive 收尾坑)照抄 tests/library-api-tools.test.mjs,不另造一套。
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { DEFAULT_SETTINGS } = await imp('lib/host/persona.js');
const { AUTO_PATCH_KEYS, sanitizeAutoPatch } = await imp('lib/host/guard.js');
const { resolveAuto } = await imp('lib/host/deepsummary.js');

/** 规格表(逐字抄自任务书,不引用代码里的常量 —— 引用被测对象本身就把断言变成了同义反复)。 */
const SPEC = { deepSummary: true, deepIntervalMin: 30, deepMaxPerRun: 2, bootProbeDelayMs: 12000, feedbackAuto: true };
const SPEC_SOURCES = ['deepSummary', 'deepIntervalMin', 'deepMaxPerRun', 'bootProbeDelayMs', 'feedbackAuto'];

/** 仿 SettingsFile 的桩:`get()` 返回的是**默认值 + 用户补丁**的合并结果(真实现见 settings-file.js),
 *  而 `user` 才是磁盘上真正写了什么。二者的区别正是本套要防的那个坑,故桩必须把两者分开。 */
const mkSettings = (userAuto) => ({
  user: userAuto === undefined ? {} : { auto: userAuto },
  get() {
    const merged = structuredClone(DEFAULT_SETTINGS);
    if (this.user.auto) merged.auto = { ...merged.auto, ...this.user.auto };
    return merged;
  },
});

// ---------------- 1) 默认值:默认行为不变的第一道守卫 ----------------
await section('DEFAULT_SETTINGS.auto 五个默认值 = 规格表');
eq(DEFAULT_SETTINGS.auto, SPEC, 'DEFAULT_SETTINGS.auto 与规格表逐键相等');
for (const k of SPEC_SOURCES) {
  eq(typeof DEFAULT_SETTINGS.auto[k], typeof SPEC[k], `${k} 的类型与规格一致(${typeof SPEC[k]})`);
}

// ---------------- 2) 三级优先级:settings > cfg > 默认 ----------------
await section('resolveAuto 三级优先级(settings > cfg > 默认)');
const CFG_ALL = {
  deepSummaryAuto: false, deepIntervalMin: 120, deepMaxPerRun: 9, feedbackAuto: false,
};
const USER_ALL = {
  deepSummary: false, deepIntervalMin: 45, deepMaxPerRun: 5, bootProbeDelayMs: 3000, feedbackAuto: false,
};
// ① 两级都设了 ⇒ settings 全胜(cfg 一个都不许漏出来)
const r1 = resolveAuto(mkSettings(USER_ALL), CFG_ALL);
eq({ ...r1, source: undefined }, { ...USER_ALL, source: undefined }, '① 两级都设:五键全取 settings');
eq(r1.source, {
  deepSummary: 'settings', deepIntervalMin: 'settings', deepMaxPerRun: 'settings',
  bootProbeDelayMs: 'settings', feedbackAuto: 'settings',
}, '① source 五项全为 settings');

// ② settings 没设(auto 子树缺省)⇒ cfg 旧键接管(四个有旧键的键),没有旧键的探活延时落默认
const r2 = resolveAuto(mkSettings(), CFG_ALL);
eq({ deepSummary: r2.deepSummary, deepIntervalMin: r2.deepIntervalMin, deepMaxPerRun: r2.deepMaxPerRun, feedbackAuto: r2.feedbackAuto },
  { deepSummary: false, deepIntervalMin: 120, deepMaxPerRun: 9, feedbackAuto: false }, '② settings 缺省:四键取 cfg 旧键');
eq(r2.bootProbeDelayMs, 12000, '② 探活延时无旧配置键 ⇒ 落默认 12000');
eq(r2.source, {
  deepSummary: 'config', deepIntervalMin: 'config', deepMaxPerRun: 'config',
  bootProbeDelayMs: 'default', feedbackAuto: 'config',
}, '② source:四键 config + 探活 default');

// ③ 两边都没设 ⇒ 全默认(见第 5 段再钉一次)
const r3 = resolveAuto(mkSettings(), {});
for (const k of SPEC_SOURCES) eq(r3.source[k], 'default', `③ 未配置时 ${k} 的 source = default`);

// ④ 坑位回归:`settings.get()` 拿到的对象**永远含默认值**,把它当"用户设过"就会压掉 cfg 旧键。
//    桩的 get() 与真实现同形(合并默认值),故这一条钉的正是"resolveAuto 只认 user 补丁"。
const r4 = resolveAuto(mkSettings(), { deepIntervalMin: 60 });
eq(r4.deepIntervalMin, 60, '④ 只传 get() 合并结果时 cfg 旧键仍生效(不把默认值当用户设定)');
eq(r4.source.deepIntervalMin, 'config', '④ 该键 source = config(不是 settings)');

// ---------------- 3) 写面白名单:放行 / 丢弃 / 夹取 ----------------
await section('sanitizeAutoPatch:白名单放行、白名单外丢弃并回报、数字夹取');
eq(AUTO_PATCH_KEYS, SPEC_SOURCES, '白名单 = 规格表五键');
const s1 = sanitizeAutoPatch({ deepIntervalMin: 1, deepMaxPerRun: 999, bogus: 1, guard: { enforce: false } });
eq(s1.clean, { deepIntervalMin: 10, deepMaxPerRun: 20 }, '越界数字被夹取到下/上界(1→10,999→20)');
eq(s1.dropped, ['bogus', 'guard'], '白名单外的键被丢弃并逐个回报');
eq(s1.clamped, ['deepIntervalMin', 'deepMaxPerRun'], 'clamped 只列真正被夹取的键');
const s2 = sanitizeAutoPatch(USER_ALL);
eq(s2.clean, USER_ALL, '界内数字与布尔原样放行');
eq(s2.clamped, [], '没有夹取时不虚报 clamped');
eq(s2.dropped, [], '没有丢弃时不虚报 dropped');
const s3 = sanitizeAutoPatch({ bootProbeDelayMs: 0 });
eq(s3.clean, { bootProbeDelayMs: 0 }, '下界 0 是合法值(0 = 立即),不被当成"没填"');
eq(sanitizeAutoPatch({ deepIntervalMin: 1440, deepMaxPerRun: 1, bootProbeDelayMs: 600000 }).clamped, [],
  '上界本身不算夹取');

// ---------------- 4) 写面:类型不符丢弃 + 原型污染 ----------------
await section('sanitizeAutoPatch:类型不符丢弃、只收扁平对象、无原型污染');
// 类型不符一律丢弃(不猜):字符串 "false" 猜错方向 = 悄悄关掉一个后台行为
eq(sanitizeAutoPatch({ deepSummary: 'yes' }).dropped, ['deepSummary'], '布尔键收到字符串 ⇒ 丢弃');
eq(sanitizeAutoPatch({ deepSummary: 0 }).dropped, ['deepSummary'], '布尔键收到数字 ⇒ 丢弃(0 不等于 false)');
eq(sanitizeAutoPatch({ deepIntervalMin: true }).dropped, ['deepIntervalMin'], '数字键收到布尔 ⇒ 丢弃');
eq(sanitizeAutoPatch({ deepIntervalMin: '45' }).dropped, ['deepIntervalMin'], '数字键收到数字字符串 ⇒ 丢弃(不做隐式转换)');
eq(sanitizeAutoPatch({ deepIntervalMin: NaN }).dropped, ['deepIntervalMin'], 'NaN/Infinity 不是可采纳的数字');
eq(sanitizeAutoPatch({ deepIntervalMin: Infinity }).dropped, ['deepIntervalMin'], 'Infinity 同样丢弃');
// 只收扁平对象:数组、null、标量整体丢弃(数组的 Object.entries 会给出 "0"/"1" 这类无意义下标键)
eq(sanitizeAutoPatch([{ deepSummary: false }]).clean, {}, '数组补丁整体丢弃');
eq(sanitizeAutoPatch(null).clean, {}, 'null 补丁整体丢弃');
eq(sanitizeAutoPatch('deepSummary=false').clean, {}, '标量补丁整体丢弃');
eq(sanitizeAutoPatch({ auto: { deepSummary: false } }).dropped, ['auto'], '嵌套写法整键丢弃(不与扁平键混用)');
// 原型污染:必须用 JSON.parse 造 own 键 —— 对象字面量里的 __proto__ 会去改原型、根本进不了 Object.entries
const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"deepSummary":false}');
const s4 = sanitizeAutoPatch(evil);
eq(s4.clean, { deepSummary: false }, '带 __proto__ / constructor 的补丁只留下白名单键');
eq(s4.dropped, ['__proto__', 'constructor'], '__proto__ 与 constructor 都被当普通陌生键丢弃');
eq(Object.prototype.hasOwnProperty.call(s4.clean, '__proto__'), false, 'clean 里没有 own 的 __proto__ 键');
eq(Object.getPrototypeOf(s4.clean), Object.prototype, 'clean 的原型未被改写');
eq({}.polluted, undefined, 'Object.prototype 未被污染');
eq(Object.getPrototypeOf({}), Object.prototype, '全局原型链完好');

// ---------------- 5) 默认不变:未配置任何东西 ----------------
await section('未配置任何东西时 resolveAuto({}, {}) 就是规格默认值');
const r0 = resolveAuto({}, {});
eq({ ...r0, source: undefined }, { ...SPEC, source: undefined }, 'resolveAuto({}, {}) = 规格表五键');
eq(r0.source, {
  deepSummary: 'default', deepIntervalMin: 'default', deepMaxPerRun: 'default',
  bootProbeDelayMs: 'default', feedbackAuto: 'default',
}, '五项 source 全为 default(没有任何一级声称设过)');
// 间隔与每轮上限的默认值必须与"旧硬编码"一致 —— 这两条是升级当天最容易悄悄变的东西
eq(r0.deepIntervalMin, 30, '自动深摘间隔默认 30 分钟(与旧 DEEP_CFG.autoIntervalMin 一致)');
eq(r0.deepMaxPerRun, 2, '每轮上限默认 2(与旧 DEEP_CFG.perRunLimit 一致)');
eq(r0.bootProbeDelayMs, 12000, '探活延时默认 12000ms(与旧硬编码一致)');

// ---------------- 6)-9) 真实 HTTP:把 /auto 挂进真 Node http server ----------------
// ⚠️ DSH_HOME 隔离(硬要求,不是保险):`registerApi()` 一进来就 `rotateSurgeryTicket()`,
//    它往 `dshHome()` 写一枚"每启动轮换"的票据 —— 不隔离就是**真机副作用**。
//    注意它与本段要查的 settings.json 是**两个**目录:settings 由显式临时目录构造(见下),
//    票据跟随 DSH_HOME —— 故两者都得隔离,不能只隔离一个。
const httpTmp = mkdtempSync(join(tmpdir(), 'ling-auto-http-'));
const realDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(httpTmp, 'home');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { registerApi } = await imp('lib/host/api.js');

/** 真 server + registerApi 的 exact 路由(接线照抄 tests/library-api-tools.test.mjs:212-241)。
 *  ⚠️ 写成 `function` **声明**而不是箭头常量:关①.6 的出站白名单按「文件 + 归属函数」判定,而它的
 *     `enclosingFn()` 只认 `function NAME` 声明 —— 箭头函数体里的命中会一律归到 `(顶层)`,
 *     白名单就只能粗放成"整个文件放行"。这里两处命中各自有主,白名单才写得起名字。 */
async function wireAuto(settings, cfg) {
  const routes = new Map();
  const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
  const dispose = registerApi({ get: () => webServer },
    { gate: {}, memory: { kvSet() {}, listOverviews: () => [], fingerprint: () => '' }, settings },
    cfg);
  const server = createServer((req, res) => {
    // 与宿主**同一个路径语义**(dsh-host-webserver: `new URL(req.url, base).pathname`):
    // 它会把 `.`/`..` 段归一掉。替身若不归一,就测不出"方法闸与宿主用两套路径语义"这条缺陷
    // (1.7.3 E 类审计逮到的那条,见 api.js guard 里 sub 的注释)。
    const path = new URL(String(req.url || '/'), 'http://dsh.internal').pathname;
    const h = routes.get(path);
    if (!h) { res.statusCode = 404; res.end('{"ok":false,"reason":"no-route"}'); return; }
    h(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    routes, base,
    close: async () => {
      // 关①.6 出站命中点 1/2(定性):这句只是**注释里提到**那个连接池库的名字,本身没有出站调用。
      // 本文件两处命中都属"离线替身":服务起在本机 `listen(0, '127.0.0.1')` 的临时端口上,
      // 目标里没有任何上游/第三方固定域名;登记处 = tools/compliance-spec.mjs 的 OUTBOUND 白名单。
      // 坑(实测踩到):undici 的 fetch 复用 keep-alive 连接 ⇒ 不先 closeAllConnections(),
      // `server.close()` 的回调永远不来(整套挂死)。
      try { server.closeAllConnections?.(); } catch { /* 老 Node 没有这个方法 */ }
      await new Promise((r) => server.close(() => r()));
      dispose();
    },
  };
};
async function callAuto(base, method, path, body) {
  // 关①.6 出站命中点 2/2(定性):本机回环替身 —— `base` 由上面 `server.address().port` 现场拼出,
  // 只指向 `listen(0, '127.0.0.1')` 起的那个临时服务,不含任何上游/第三方固定域名(离线不出网)。
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
const AUTO_URL = '/api/dsh-ling/auto';
const snapshot = (file) => ({ text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs });

await section('真实 HTTP · 双方法闸(只放行 GET 读半边)与 GET /auto 的只读读数');
const data1 = join(httpTmp, 'data1');
const settingsFile1 = join(data1, 'settings.json');
const settings1 = new SettingsFile(data1);
const api1 = await wireAuto(settings1, { version: 'test-1.7' });
ok(api1.routes.has(AUTO_URL), '/auto 路由在册:' + AUTO_URL);
// 隔离的**正面证据**(照抄 library-api-tools.test.mjs:258-264):票据必须落在临时 home 下。
const ticketInTmp = (() => {
  try { return readdirSync(join(httpTmp, 'home'), { recursive: true }).some((f) => String(f).includes('surgery.ticket')); } catch { return false; }
})();
ok(ticketInTmp, 'DSH_HOME 隔离生效:每启动票据落在临时 home 下(真机副作用被挡住)');
// 方法闸**先于鉴权**:此刻守卫是默认开着的(真 SettingsFile 的 guard.enforce === true),
// 而 PUT/DELETE 仍必须回 405 —— 回 403 就说明这道闸被挪到鉴权后面去了(顺序反了)。
for (const m of ['PUT', 'DELETE']) {
  const r = await callAuto(api1.base, m, AUTO_URL);
  ok(r.status === 405 && r.json?.error === 'method-not-allowed' && r.json?.want === 'POST',
    `${m} /auto ⇒ 405 want:POST(实际 ${r.status}/${JSON.stringify(r.json)})`);
}
// ── 1.7.3 E 类审计(2026-10-27)· 点段不得绕过方法闸 ────────────────────────────────────
// 宿主按 `new URL(...).pathname` 匹配(吃掉 `.`/`..`),而 guard 原先拿**原始** `req.url` ⇒
// `GET /api/dsh-ling/x/../persona` 在宿主侧归一成 `/api/dsh-ling/persona`(正正命中路由)、
// 到 guard 里 `sub` 却是 `/x/../persona`(不在 POST_ONLY)⇒ 门放过,写面可被 GET 驱动。
// 判据是 **405 而不是 403**:回 403 说明它穿过了方法闸、落到鉴权去了(那就是本缺陷还活着)。
// ⚠️ 必须用 `node:http` 发**原始路径**:`fetch` 按 URL 规范会先把 `.`/`..` 归一掉再发,
//    用 fetch 测这条永远绿(实测踩过:反证脚本退回旧写法,用 fetch 的那版断言照样全绿)。
function rawCall(base, method, rawPath) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // 本机 127.0.0.1 的 listen(0) 临时替身(与上面 `callAuto` 同源,离线不出网)。
    const req = httpRequest({ host: u.hostname, port: u.port, method, path: rawPath }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 照测 */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
{
  const rDot = await rawCall(api1.base, 'GET', '/api/dsh-ling/x/../persona');
  ok(rDot.status === 405 && rDot.json?.error === 'method-not-allowed',
    `原始路径 GET /x/../persona ⇒ 405(点段不得穿过写面闸;实际 ${rDot.status}/${JSON.stringify(rDot.json)})`);
  const rDotDeep = await rawCall(api1.base, 'GET', '/api/dsh-ling/a/b/../../persona');
  ok(rDotDeep.status === 405, `原始路径 GET /a/b/../../persona ⇒ 405(多层点段同样;实际 ${rDotDeep.status})`);
  const rPlain = await rawCall(api1.base, 'GET', '/api/dsh-ling/persona');
  ok(rPlain.status === 405, `对照:规范路径 GET /persona ⇒ 405(基线没被改坏;实际 ${rPlain.status})`);
}
// 守卫默认开着 ⇒ 读面要能通,只能走它自己的逃生开关(`settings.guard.enforce = false`,
// 见 api.js 的 guardVerdict;另一条是 DSH_LING_GUARD=off)。这里用 settings 而不是环境变量,
// 顺带证明"写 guard 不碰 auto 子树"。
await settings1.update({ guard: { enforce: false } });
const beforeGet = snapshot(settingsFile1);
const rGet0 = await callAuto(api1.base, 'GET', AUTO_URL);
ok(rGet0.status === 200, `GET /auto ⇒ 200(实际 ${rGet0.status}/${rGet0.text.slice(0, 160)})`);
eq({ ...rGet0.json?.effective, source: undefined }, { ...SPEC, source: undefined },
  'GET /auto 的 effective 五键 = 规格默认值');
eq(rGet0.json?.effective?.source, {
  deepSummary: 'default', deepIntervalMin: 'default', deepMaxPerRun: 'default',
  bootProbeDelayMs: 'default', feedbackAuto: 'default',
}, 'GET /auto:五键 source 全 default(没有任何一级声称设过)');
// 「没写过」与「写的就是默认值」必须能分辨 —— 前者是空对象,不是 get() 的合并结果。
eq(rGet0.json?.stored, {}, 'stored = {}(没写过就是空对象,不是五个默认值)');
eq(rGet0.json?.pluginConfig, { feedbackAuto: null, deepSummaryAuto: null, deepIntervalMin: null, deepMaxPerRun: null },
  'pluginConfig = 四个旧键的只读快照(没写 = null,不是 false/0)');
eq(snapshot(settingsFile1), beforeGet, 'GET 只读:settings.json 内容与 mtime 都没动');

await section('真实 HTTP · POST /auto:夹取 + 丢弃 + 落盘能读回来');
const rPost = await callAuto(api1.base, 'POST', AUTO_URL, { patch: { deepIntervalMin: 1, deepMaxPerRun: 999, 想吃鱼: true } });
ok(rPost.status === 200, `POST /auto ⇒ 200(实际 ${rPost.status}/${rPost.text.slice(0, 160)})`);
eq(rPost.json?.clamped, ['deepIntervalMin', 'deepMaxPerRun'], 'clamped 点名两个越界键(1 与 999)');
eq(rPost.json?.dropped, ['想吃鱼'], 'dropped 点名白名单外的键');
eq(rPost.json?.effective?.deepIntervalMin, 10, 'effective.deepIntervalMin = 10(1 夹到下限)');
eq(rPost.json?.effective?.deepMaxPerRun, 20, 'effective.deepMaxPerRun = 20(999 夹到上限)');
eq(rPost.json?.effective?.source?.deepIntervalMin, 'settings', '写完这一拍 source 立刻变 settings');
// 落盘:回读**真文件**,不是回读内存里的 current(夹取必须发生在落盘之前)。
eq(JSON.parse(readFileSync(settingsFile1, 'utf8'))?.user?.auto, { deepIntervalMin: 10, deepMaxPerRun: 20 },
  'settings.json 的 user.auto = 夹取后的值(1/999 不许落盘)');
const rGet1 = await callAuto(api1.base, 'GET', AUTO_URL);
eq(rGet1.json?.stored, { deepIntervalMin: 10, deepMaxPerRun: 20 }, 'GET /auto 的 stored 读回来的就是写下去的那份');
eq(rGet1.json?.stored?.deepIntervalMin, 10, 'stored.deepIntervalMin === 10');
eq(rGet1.json?.effective?.source?.deepIntervalMin, 'settings', "source.deepIntervalMin === 'settings'(落盘读得回来)");
eq({ ...rGet1.json?.effective, source: undefined },
  { deepSummary: true, deepIntervalMin: 10, deepMaxPerRun: 20, bootProbeDelayMs: 12000, feedbackAuto: true },
  '只写了两个数字键 ⇒ 其余三键照旧(逐键独立,不是整块覆盖)');

await section('真实 HTTP · 拒绝就是真拒绝:400 且 settings.json 一个字节都没动');
const beforeReject = snapshot(settingsFile1);
const rNoBody = await callAuto(api1.base, 'POST', AUTO_URL);                  // 不带 body
const rEmptyObj = await callAuto(api1.base, 'POST', AUTO_URL, {});             // 空对象
const rAllDropped = await callAuto(api1.base, 'POST', AUTO_URL, { patch: { 想吃鱼: true, guard: { enforce: false } } });
for (const [name, r] of [['不带 body', rNoBody], ['{}', rEmptyObj], ['全白名单外', rAllDropped]]) {
  ok(r.status === 400 && r.json?.ok === false && r.json?.error === 'nothing-to-update',
    `${name} ⇒ 400 nothing-to-update(实际 ${r.status}/${JSON.stringify(r.json)})`);
}
eq(rAllDropped.json?.dropped, ['想吃鱼', 'guard'], '全白名单外时照实回报丢了哪两个(含想用来关守卫的 guard)');
eq(rAllDropped.json?.clamped, [], '没有夹取就不虚报 clamped');
eq(snapshot(settingsFile1), beforeReject, 'settings.json 内容与 mtime 逐字未变(拒绝没有顺手落盘)');
const rGet2 = await callAuto(api1.base, 'GET', AUTO_URL);
eq(rGet2.json?.stored, { deepIntervalMin: 10, deepMaxPerRun: 20 }, '被拒三次之后 stored 仍是上一次成功写入的那份');

await section('真实 HTTP · 插件配置旧键线路:字符串 60 照旧生效(source=config)');
const settings2 = new SettingsFile(join(httpTmp, 'data2'));
const api2 = await wireAuto(settings2, {
  version: 'test-1.7', deepIntervalMin: '60', deepMaxPerRun: 7, deepSummaryAuto: false,
});
await settings2.update({ guard: { enforce: false } });
const rCfg = await callAuto(api2.base, 'GET', AUTO_URL);
ok(rCfg.status === 200, `配置线路 GET /auto ⇒ 200(实际 ${rCfg.status}/${rCfg.text.slice(0, 160)})`);
// 字符串 '60' 必须生效:旧实现是 `Number(cfg.deepIntervalMin)`,这里不许"更严格"地丢掉它。
eq({ ...rCfg.json?.effective, source: undefined },
  { deepSummary: false, deepIntervalMin: 60, deepMaxPerRun: 7, bootProbeDelayMs: 12000, feedbackAuto: true },
  "旧配置键接管三键(字符串 '60' 按旧口径 Number() 生效),探活延时无旧键 ⇒ 落默认");
eq(rCfg.json?.effective?.source, {
  deepSummary: 'config', deepIntervalMin: 'config', deepMaxPerRun: 'config',
  bootProbeDelayMs: 'default', feedbackAuto: 'default',
}, "source:三个有旧键的键 = config,其余 default(探活延时没有旧配置键)");
eq(rCfg.json?.stored, {}, 'settings 依旧为空 ⇒ stored = {}(配置不是"用户写过")');
eq(rCfg.json?.pluginConfig, { feedbackAuto: null, deepSummaryAuto: false, deepIntervalMin: '60', deepMaxPerRun: 7 },
  'pluginConfig 如实回旧键原值(含字符串,不做归一)');
// 三级优先级的第三级对照:settings 一旦写下去,同一台机器上配置就得让位。
const rWin = await callAuto(api2.base, 'POST', AUTO_URL, { patch: { deepIntervalMin: 45 } });
eq(rWin.json?.effective?.deepIntervalMin, 45, 'settings 写 45 ⇒ 压过配置里的 60');
eq(rWin.json?.effective?.source?.deepIntervalMin, 'settings', '该键 source 变 settings(配置让位)');
eq(rWin.json?.effective?.deepSummary, false, '没写的键仍由配置接管(压过是逐键的,不是整块)');

// ---------------- 10) rc.4 · `/model/background`(M21-4)----------------
// 为什么写在这一套里:它与 /auto、/inject 是**同一类**端点(写 settings 的一个子树 + GET 读生效值),
// 而这套已经有"真 Node server + registerApi + DSH_HOME 隔离"的脚手架(见第 6-9 段)。
// ⚠️ 本段**不写死** guard.test.mjs 的 665/666 计数:那是 guard.test.mjs 的事;这里只钉"路径进表"
//    与端点行为 —— 否则 M21-7 加 /mode/effort 时这套会无故变红(两条新端点各 +1,不是同一条)。
await section('真实 HTTP · /model/background:方法闸 / 仅本机 / 白名单 / 原型键 / 清除语义 / 落盘');
const bgData = join(httpTmp, 'data-bg');
const bgFile = join(bgData, 'settings.json');
const bgSettings = new SettingsFile(bgData);
const PLAT = { provider: 'platform-p', model: 'platform-m' };
// 守卫的逃生开关(与第 6 段同一理由):读/写面要能通;"只许本机"另有端点内判据(readIsLocal)。
await bgSettings.update({ guard: { enforce: false } });

/** 真 server + registerApi 的 exact 路由(接线同本文件第 6 段的 wireAuto,只多一个"平台当前选择"桩)。
 *  第三参 `kv`(可选):`llm.background.lastError` 的回显测试(M21-6)需要一枚**能读回**的 kv ——
 *  传 Map 就是真读回,不传则是"永远读不到"(前 10 段的行为与改动前逐字一致)。
 *  第四参 `spy`(可选,B.7-7):给了就在 adm 桩上装一枚 `saveSelection` 计数器 ——
 *  不传时该键**缺席**(与改动前逐字同形),故不影响前 10 段。 */
async function wireBackground(settings, selection, kv, spy) {
  const routes = new Map();
  const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
  const adm = {
    currentSelection: () => selection,
    ...(spy ? { saveSelection: (sel) => { spy.saveSelectionCalls.push(sel); return Promise.resolve(); } } : {}),
  };
  const ctx = { get: (name) => (name === 'agentDefaultModel' ? adm : webServer) };
  const dispose = registerApi(ctx, {
    gate: {},
    memory: {
      kvSet(k, v) { if (kv) kv.set(String(k), String(v)); },
      kvGet(k) { return kv ? (kv.get(String(k)) ?? null) : null; },
      listOverviews: () => [], fingerprint: () => '',
    },
    settings,
  }, { version: 'test-1.7' });
  const server = createServer((req, res) => {
    const path = new URL(String(req.url || '/'), 'http://dsh.internal').pathname;
    const h = routes.get(path);
    if (!h) { res.statusCode = 404; res.end('{"ok":false,"reason":"no-route"}'); return; }
    h(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    routes,
    base: 'http://127.0.0.1:' + server.address().port,
    close: async () => {
      try { server.closeAllConnections?.(); } catch { /* 老 Node 没有这个方法 */ }
      await new Promise((r) => server.close(() => r()));
      dispose();
    },
  };
}
/** B.7-7 的计数外壳:包住真 SettingsFile,把**每次** `update` 的 patch 原文记进 `calls`。
 *  ⚠️ 只记不拦、不改写:读写仍走真实现(落盘行为与不带外壳时逐字一致)⇒ 断言的是"真发生了什么",
 *     不是"我们拦住之后剩什么"。`user` 走 getter 直通(api.js 的 effort/写面读它)。 */
function countingSettings(inner, calls) {
  return {
    get user() { return inner.user; },
    get: () => inner.get(),
    update: (patch) => { calls.push(patch); return inner.update(patch); },
  };
}

/** 本机回环替身(离线不出网):base 由 listen(0) 的临时端口现场拼出。 */
async function callBg(base, method, body, extraHeaders) {
  const res = await fetch(base + '/api/dsh-ling/model/background', {
    method,
    headers: body === undefined
      ? extraHeaders
      : { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 也照测 */ }
  return { status: res.status, json, text };
}

const apiBundle = await wireBackground(bgSettings, PLAT);
ok(apiBundle.routes.has('/api/dsh-ling/model/background'), '/model/background 路由在册');
// ① 方法闸:进 POST_ONLY 的写半边只许 POST ⇒ PUT/DELETE 405;读半边由 DUAL_METHOD_READ_PATHS 放行
//    ⇒ GET 必须 200(忘了那张表就是 405,ALIGN-v7 §5.4-4 / MUT-D4-4)。
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const r = await callBg(apiBundle.base, m);
  ok(r.status === 405 && r.json?.error === 'method-not-allowed' && r.json?.want === 'POST',
    `${m} /model/background ⇒ 405 want:POST(实际 ${r.status}/${JSON.stringify(r.json)})`);
}
// ② B.7-1:两键皆空 ⇒ GET source:'platform'(跟随平台当前选择),effective = 平台选择,0 写盘
const beforeBg = snapshot(bgFile);
const bgGet0 = await callBg(apiBundle.base, 'GET');
ok(bgGet0.status === 200, `GET /model/background ⇒ 200(实际 ${bgGet0.status}/${bgGet0.text.slice(0, 200)})`);
eq(bgGet0.json?.configured, { provider: '', model: '' }, 'B.7-1 未设置时 configured 两键为空');
eq(bgGet0.json?.effective, PLAT, 'B.7-1 未设置时 effective = 平台当前选择');
eq(bgGet0.json?.source, 'platform', "B.7-1 未设置时 source === 'platform'");
eq(bgGet0.json?.followed, true, 'B.7-1 未设置时 followed === true(跟随平台)');
eq(bgGet0.json?.lastError, null, 'D-3 的 lastError 面:kv 无记录且同进程无失败 ⇒ null(不是"一切正常"的断言)');
eq(snapshot(bgFile), beforeBg, 'GET 只读:settings.json 内容与 mtime 都没动');
// ③ 源码级:路径必须同时进 POST_ONLY 与 DUAL_METHOD_READ_PATHS,且**不许**进 GET_ONLY
{
  const apiText = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const postBlock = apiText.match(/const POST_ONLY = new Set\(\[([\s\S]*?)\]\);/);
  const dualLine = apiText.match(/const DUAL_METHOD_READ_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  const getBlock = apiText.match(/const GET_ONLY = new Set\(\[([\s\S]*?)\]\);/);
  const picked = (b) => [...String(b && b[1] || '').replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(picked(postBlock).includes('/model/background'), 'POST_ONLY 里有 /model/background(写半边只许 POST)');
  ok(picked(dualLine).includes('/model/background'), 'DUAL_METHOD_READ_PATHS 里有 /model/background(读半边放行)');
  ok(!picked(getBlock).includes('/model/background'), 'GET_ONLY 里没有 /model/background(否则 POST 被自己的读面闸 405)');
}
// ④ 写面:只收字符串 + trim 后写;落盘回读的是**真文件**
const bgSet = await callBg(apiBundle.base, 'POST', { provider: '  p  ', model: 'm' });
ok(bgSet.status === 200, `POST /model/background ⇒ 200(实际 ${bgSet.status}/${bgSet.text.slice(0, 200)})`);
eq(bgSet.json?.configured, { provider: 'p', model: 'm' }, 'POST 后 configured = trim 后的两键');
eq(bgSet.json?.source, 'settings', "两键齐全 ⇒ source === 'settings'");
eq(bgSet.json?.effective, { provider: 'p', model: 'm' }, '两键齐全 ⇒ effective = 设置值(不是平台选择)');
eq(bgSet.json?.dropped, [], '没有丢弃时不虚报 dropped');
eq(JSON.parse(readFileSync(bgFile, 'utf8'))?.user?.model?.background, { provider: 'p', model: 'm' },
  'settings.json 的 user.model.background = trim 后的两键(盘上是真值)');
const bgGet1 = await callBg(apiBundle.base, 'GET');
eq(bgGet1.json?.configured, { provider: 'p', model: 'm' }, 'GET 读回来的就是写下去的那份');
eq(bgGet1.json?.source, 'settings', "落盘读得回来 ⇒ source === 'settings'");
// ⑤ B.7-4:坏值 ⇒ 400 + dropped,0 写;GET 仍回落
const beforeBad = snapshot(bgFile);
for (const [name, body, dropKey] of [
  ["provider:123(数字)", { provider: 123 }, 'provider'],
  ["provider:null", { provider: null }, 'provider'],
  ["provider:{a:1}(对象)", { provider: { a: 1 } }, 'provider'],
  ["provider:['p'](数组)", { provider: ['p'] }, 'provider'],
  ["provider:'   '(全空白)", { provider: '   ' }, 'provider'],
  ['想吃鱼(白名单外)', { 想吃鱼: true }, '想吃鱼'],
]) {
  const r = await callBg(apiBundle.base, 'POST', body);
  ok(r.status === 400 && r.json?.ok === false && r.json?.error === 'nothing-to-update',
    `B.7-4 ${name} ⇒ 400 nothing-to-update(实际 ${r.status}/${JSON.stringify(r.json)})`);
  eq(r.json?.dropped, [dropKey], `B.7-4 ${name} ⇒ dropped 点名该键`);
}
eq(snapshot(bgFile), beforeBad, 'B.7-4 五次拒绝后 settings.json 内容与 mtime 逐字未变(0 写)');
const bgEmpty = await callBg(apiBundle.base, 'POST', {});
ok(bgEmpty.status === 400 && bgEmpty.json?.error === 'nothing-to-update', '无合法键(空 body)⇒ 400 nothing-to-update');
eq((await callBg(apiBundle.base, 'GET')).json?.configured, { provider: 'p', model: 'm' },
  'B.7-4 被拒之后 configured 仍是上一次成功写入的那份(拒绝没有顺手落盘)');
// ⑥ B.7-8:非本机(带代理头 / 无 UA)⇒ 403 local-only 且 0 写
const beforeRemote = snapshot(bgFile);
for (const [name, headers] of [
  ['带 x-forwarded-for', { 'x-forwarded-for': '203.0.113.9' }],
  ['带 x-real-ip', { 'x-real-ip': '203.0.113.9' }],
]) {
  const r = await callBg(apiBundle.base, 'POST', { provider: 'evil', model: 'evil' }, headers);
  ok(r.status === 403 && r.json?.reason === 'local-only',
    `B.7-8 ${name} 的 POST ⇒ 403 local-only(实际 ${r.status}/${JSON.stringify(r.json)})`);
}
eq(snapshot(bgFile), beforeRemote, 'B.7-8 非本机两次拒绝后 settings.json 逐字未变(0 写)');
// ⑦ B.7-9:原型键(任意层级)⇒ 400 forbidden-key、0 写、Object.prototype 未被污染
const beforeEvil = snapshot(bgFile);
for (const [name, rawBody] of [
  ['顶层 __proto__', '{"__proto__":{"polluted":1}}'],
  ['嵌套 __proto__', '{"provider":{"__proto__":{"x":1}}}'],
  ['constructor.prototype', '{"constructor":{"prototype":{"polluted":true}}}'],
  ['顶层 prototype', '{"model":"m","prototype":1}'],
  ['patch 里的 __proto__', '{"patch":{"__proto__":{"polluted":1}}}'],
]) {
  const r = await callBg(apiBundle.base, 'POST', rawBody);
  ok(r.status === 400 && r.json?.error === 'forbidden-key' && r.json?.reason === 'forbidden-key',
    `B.7-9 ${name} ⇒ 400 forbidden-key(实际 ${r.status}/${JSON.stringify(r.json)})`);
}
eq(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false, 'B.7-9 Object.prototype 没有被种上 polluted');
eq({}.polluted, undefined, 'B.7-9 全局原型链干净({}.polluted === undefined)');
eq(Object.getPrototypeOf({}), Object.prototype, 'B.7-9 普通对象原型未被改写');
eq(snapshot(bgFile), beforeEvil, 'B.7-9 五次拒绝后 settings.json 逐字未变(0 写)');
// ⑧ B.7-5:清除语义 —— 空串 = 清除(回到"未设置")
const bgClear = await callBg(apiBundle.base, 'POST', { provider: '', model: '' });
ok(bgClear.status === 200, `POST 两键空串 ⇒ 200(实际 ${bgClear.status}/${bgClear.text.slice(0, 200)})`);
eq(bgClear.json?.configured, { provider: '', model: '' }, 'B.7-5 清除后 configured 两键为空');
const cleared = JSON.parse(readFileSync(bgFile, 'utf8'))?.user?.model?.background;
ok(cleared === undefined || (cleared.provider === '' && cleared.model === ''),
  'B.7-5 settings.json 两键为空或子树被清(实际 ' + JSON.stringify(cleared) + ')');
const bgGet2 = await callBg(apiBundle.base, 'GET');
eq(bgGet2.json?.source, 'platform', "B.7-5 清除后 GET source === 'platform'(回到跟随平台)");
eq(bgGet2.json?.effective, PLAT, 'B.7-5 清除后 effective 回到平台当前选择');
// ⑧-bis B.7-3(M21-5):只填 model(provider 空)⇒ 写面照收,但解析级**整对忽略** ⇒ source:'platform'
//    (禁止 `provider 设置 × model 平台` 混搭:会拼出一个不存在的组合)
const bgHalf = await callBg(apiBundle.base, 'POST', { model: 'only-m' });
ok(bgHalf.status === 200, `B.7-3 只填 model ⇒ 200(实际 ${bgHalf.status}/${bgHalf.text.slice(0, 200)})`);
eq(bgHalf.json?.configured, { provider: '', model: 'only-m' }, 'B.7-3 写面如实回报单键 configured');
eq(bgHalf.json?.source, 'platform', "B.7-3 只填 model ⇒ source === 'platform'(整对忽略,不是混搭)");
eq(bgHalf.json?.effective, PLAT, 'B.7-3 effective = 平台当前选择(设置级单键不得拆开用)');
const bgHalfGet = await callBg(apiBundle.base, 'GET');
eq(bgHalfGet.json?.source, 'platform', "B.7-3 落盘后 GET 仍 source === 'platform'");
// ⑨ B.7-1 的反向对照:平台选择读不到 ⇒ source:'fallback'(兜底),而不是谎称 platform
{
  const byKey = join(httpTmp, 'data-bg-noselect');
  const byKeySettings = new SettingsFile(byKey);
  await byKeySettings.update({ guard: { enforce: false } });
  const apiNoSel = await wireBackground(byKeySettings, null);
  const r = await callBg(apiNoSel.base, 'GET');
  ok(r.status === 200, `读不到平台选择时 GET ⇒ 200(实际 ${r.status})`);
  eq(r.json?.source, 'fallback', "读不到平台选择 ⇒ source === 'fallback'(不谎称 platform)");
  eq(r.json?.followed, false, '读不到平台选择 ⇒ followed === false');
  await apiNoSel.close();
}
// ⑨-ter **B.7-7**(M21-8 §7-3 的缺口补齐):`/model/background` 与档位面**不相干** ——
//   成功路径与失败路径都**不许**调 `saveSelection`、都**不许**写 `mode.lastMode`
//   (lastMode 的唯一写面 = `settings.update({mode:{lastMode}})`),且 `settings.mode` **逐字未变**。
//   判法(不是"论证"、更不是 check(true)):
//     · `countingSettings` 外壳把**每一次**真实 `settings.update` 的 patch 原文记下来
//       ⇒ "写了几次、写的是什么"逐字对照(漏写/多写/夹带 mode 键立刻红);
//     · adm 桩上装 `saveSelection` 计数器 ⇒ 谁调谁留痕(0 次才是"没碰");
//     · 成功/失败各跑一条,失败侧三次拒绝(坏值 400 / 原型键 400 / 非本机 403)后
//       `settings.update` 次数**必须一毫米都不涨**;
//     · 改前/改后各拍一份 `settings.get().mode`(默认值 ⊕ 用户补丁)与盘上 `user.mode`
//       ⇒ 逐字 JSON 相等。
{
  const b77Data = join(httpTmp, 'data-bg-b77');
  const b77File = join(b77Data, 'settings.json');
  const b77Settings = new SettingsFile(b77Data);
  await b77Settings.update({ guard: { enforce: false } });
  const b77Calls = [];                       // 每次 settings.update 的 patch 原文
  const b77Spy = { saveSelectionCalls: [] };
  const apiB77 = await wireBackground(countingSettings(b77Settings, b77Calls), PLAT, null, b77Spy);
  const modeBefore = JSON.stringify(b77Settings.get().mode);
  const userModeBefore = JSON.stringify(b77Settings.user?.mode ?? null);
  // ① 成功路径:200,且**唯一**一次写就是 model.background(patch 逐字相等)
  const callBeforeOk = b77Calls.length;
  const r77Ok = await callBg(apiB77.base, 'POST', { provider: 'b77-p', model: 'b77-m' });
  ok(r77Ok.status === 200, `B.7-7 成功路径 POST ⇒ 200(实际 ${r77Ok.status}/${r77Ok.text.slice(0, 200)})`);
  eq(b77Calls.length - callBeforeOk, 1, 'B.7-7 成功路径 settings.update 恰 1 次');
  {
    const b77Patch = b77Calls[b77Calls.length - 1] || {};
    eq(Object.keys(b77Patch), ['model'], 'B.7-7 成功路径唯一一次写只碰顶层键 model(没有 mode / 别的混进来)');
    eq(Object.keys(b77Patch?.model || {}), ['background'], 'B.7-7 写的是 model.background 一个子树');
    eq(b77Patch?.model?.background, { provider: 'b77-p', model: 'b77-m' },
      'B.7-7 成功路径唯一一次写 = model.background(patch 逐字相等)');
  }
  // ② 失败路径:坏值 / 白名单外 ⇒ 400,原型键 ⇒ 400,非本机 ⇒ 403;三次之后 0 次 settings.update
  const callBeforeBad = b77Calls.length;
  for (const [name, body] of [
    ['坏值 provider:123', { provider: 123 }],
    ['白名单外 想吃鱼', { 想吃鱼: true }],
  ]) {
    const r = await callBg(apiB77.base, 'POST', body);
    ok(r.status === 400, `B.7-7 失败路径 ${name} ⇒ 400(实际 ${r.status}/${r.text.slice(0, 160)})`);
  }
  const r77Evil = await callBg(apiB77.base, 'POST', '{"__proto__":{"polluted":1}}');
  ok(r77Evil.status === 400 && r77Evil.json?.error === 'forbidden-key',
    `B.7-7 失败路径 原型键 ⇒ 400 forbidden-key(实际 ${r77Evil.status}/${JSON.stringify(r77Evil.json)})`);
  const r77Remote = await callBg(apiB77.base, 'POST', { provider: 'evil', model: 'evil' }, { 'x-forwarded-for': '203.0.113.9' });
  ok(r77Remote.status === 403 && r77Remote.json?.reason === 'local-only',
    `B.7-7 失败路径 非本机 ⇒ 403 local-only(实际 ${r77Remote.status}/${JSON.stringify(r77Remote.json)})`);
  eq(b77Calls.length, callBeforeBad, 'B.7-7 三次失败后 settings.update **一次都没发生**(0 写)');
  // ③ lastMode / saveSelection:整段 0 次;mode 子树逐字未变
  eq(b77Spy.saveSelectionCalls.length, 0, 'B.7-7 saveSelection 调用 0 次(成功与失败路径整段)');
  eq(b77Calls.filter((p) => p && typeof p === 'object' && Object.keys(p).includes('mode')).length, 0,
    'B.7-7 没有任何一次 settings.update 带 mode 键 ⇒ lastMode 写面 0 次');
  eq(JSON.stringify(b77Settings.get().mode), modeBefore, 'B.7-7 settings.mode(默认 ⊕ 补丁)逐字未变');
  eq(JSON.stringify(b77Settings.user?.mode ?? null), userModeBefore, 'B.7-7 盘上 user.mode 逐字未变');
  eq(JSON.parse(readFileSync(b77File, 'utf8'))?.user?.mode ?? null, null,
    'B.7-7 settings.json 里仍然一个 mode 键都没被写出来');
  await apiB77.close();
}
// ⑩ B.5-3 / B.5-4(M21-6 / D-3,ALIGN-v7 §4.4/§4.6):GET `/model/background` 的 `lastError` 回显
//    · kv 有值 ⇒ **四字段(provider/model/error/at)原样**回显,一个字段不解释、不分类;
//    · kv 里 JSON 被写坏 ⇒ 仍 200 且 `lastError:null`(**回显自身不许 500**);
//    · 响应正文里**不许**出现 `unreachable` / `model-rejected` / `empty` 这类分类学字样
//      (D-3 只说"最近一次失败是什么",不回答为什么;原因诊断属 `V1\PROBE` 立项)。
{
  const bgKv = new Map();
  const apiErr = await wireBackground(bgSettings, PLAT, bgKv);
  const ERR_REC = { provider: 'p', model: 'm', error: 'model x not found', at: '2026-11-15T17:00:00.000Z' };
  bgKv.set('llm.background.lastError', JSON.stringify(ERR_REC));
  const rErr = await callBg(apiErr.base, 'GET');
  ok(rErr.status === 200, `B.5-3 kv 有记录时 GET ⇒ 200(实际 ${rErr.status}/${rErr.text.slice(0, 200)})`);
  eq(rErr.json?.lastError, ERR_REC, 'B.5-3 lastError 四字段(provider/model/error/at)原样回显');
  for (const word of ['unreachable', 'model-rejected', 'empty']) {
    ok(!String(rErr.text).includes(word), `B.5-3 响应里没有分类学字样 ${word}`);
  }
  // 坏 JSON:GET 仍 200、lastError 回落 null —— 回显路径自己不许抛(否则面板拿到 500)
  bgKv.set('llm.background.lastError', '{"provider":"p",');
  const rBad = await callBg(apiErr.base, 'GET');
  ok(rBad.status === 200, `B.5-4 kv 里 JSON 被写坏 ⇒ GET 仍 200(实际 ${rBad.status}/${rBad.text.slice(0, 200)})`);
  eq(rBad.json?.lastError, null, 'B.5-4 坏 JSON ⇒ lastError:null(不许 500、不许把原始串抛给面板)');
  // 合法 JSON 但不是四字段形状:同样按"没有可回显的记录"处理(否则前端拿到字符串去读 .error)
  bgKv.set('llm.background.lastError', '"boom"');
  eq((await callBg(apiErr.base, 'GET')).json?.lastError, null, 'B.5-4 合法 JSON 但非对象 ⇒ lastError:null');
  // ⑪ B.5-5 的**HTTP 半边**:sink 未注入(测试环境)时,GET 走同进程回落 `llmLastError()`
  //     —— "有失败记录就能回显",不依赖落盘这一条路径。
  const { llmOnce, setLlmErrorSink, llmLastError } = await imp('lib/host/deepsummary.js');
  setLlmErrorSink(null);
  const failCtx = { get: (n) => (n === 'llm' ? { stream: () => { throw new Error('no such model'); } } : undefined) };
  let threw = null;
  try { await llmOnce(failCtx, { system: 's', text: 't', provider: 'fp', model: 'fm' }); } catch (e) { threw = e; }
  ok(threw && threw.message === 'no such model', 'B.5-5 未注入 sink 时 llmOnce 仍照原样抛错(不吞)');
  const fallback = llmLastError();
  ok(fallback && fallback.provider === 'fp' && fallback.model === 'fm' && fallback.error === 'no such model'
    && typeof fallback.at === 'string' && fallback.at !== '',
  'B.5-5 llmLastError() 有同进程记录: ' + JSON.stringify(fallback));
  bgKv.delete('llm.background.lastError');
  const rFb = await callBg(apiErr.base, 'GET');
  eq(rFb.json?.lastError, fallback, 'B.5-5 sink 未注入 ⇒ GET 走 llmLastError() 回落同样能回显');
  setLlmErrorSink(null);       // 收尾:模块级单例不许带着本段的桩离开
  await apiErr.close();
}
await apiBundle.close();

await api1.close();
await api2.close();
process.env.DSH_HOME = realDshHome;
if (realDshHome === undefined) delete process.env.DSH_HOME;
rmSync(httpTmp, { recursive: true, force: true });

summary();
