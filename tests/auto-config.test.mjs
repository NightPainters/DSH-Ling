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

await api1.close();
await api2.close();
process.env.DSH_HOME = realDshHome;
if (realDshHome === undefined) delete process.env.DSH_HOME;
rmSync(httpTmp, { recursive: true, force: true });

summary();
