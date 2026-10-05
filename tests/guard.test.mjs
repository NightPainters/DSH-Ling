// /api 守卫(2026-09-16 加固 ①+②;2026-09-17 加固 ③+④)单元测试 —— 全离线、无 DB、无宿主。
// 覆盖:loopback 判定 / trustedHosts 匹配(带端口精确、无端口任意端口)/ 来源栅栏三条 /
//       cookie 名派生(必须与 DSH 同法)/ cookie 读取 / 端到端判定与全部拒绝原因 /
//       LAN 默认不受信(③) / 人格补丁字段白名单(④,堵 {"guard":{"enforce":false}})。
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(new URL('file:///' + join(root, p).replace(/\\/g, '/')).href);

const {
  checkRequest, isLoopbackHostname, isTrustedAuthority, parseAuthority, canonicalAuthority,
  requestAuthority, expectedCookieName, cookieValueOf, encodeBase64Url, headerOf, lanAddresses,
  sanitizePersonaPatch, PERSONA_PATCH_KEYS, STYLE_PATCH_KEYS,
} = await imp('lib/host/guard.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 与 DSH 同法的独立实现(故意不调用被测函数):用作"名字派生是否正确"的交叉验证
const refName = (authority) =>
  'dsh-auth-' + createHash('sha256').update(authority).digest('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
const cookieFor = (authority, value = 'sig.payload') => ({ cookie: `${refName(authority)}=${value}` });

// 1) loopback 判定
check(isLoopbackHostname('localhost') && isLoopbackHostname('::1'), 'localhost 与 ::1 是 loopback');
check(isLoopbackHostname('127.0.0.1') && isLoopbackHostname('127.1.2.3'), '127.0.0.0/8 全部是 loopback');
check(!isLoopbackHostname('128.0.0.1') && !isLoopbackHostname('192.0.2.31'), '非 127 段与 LAN 地址不是 loopback');
check(!isLoopbackHostname('127.0.0.256') && !isLoopbackHostname('127.0.0'), '越界/段数不足不算 loopback');
check(!isLoopbackHostname('evil.com') && !isLoopbackHostname(''), '域名与空串不是 loopback');

// 2) trustedHosts 匹配:带端口精确 / 无端口任意端口 / 域名大小写与默认端口归一
const u = (a) => parseAuthority(a);
check(isTrustedAuthority(u('192.0.2.31:3080'), ['192.0.2.31:3080']), '带端口 entry 精确匹配');
check(!isTrustedAuthority(u('192.0.2.31:3081'), ['192.0.2.31:3080']), '带端口 entry 不匹配别的端口');
check(isTrustedAuthority(u('192.0.2.31:9'), ['192.0.2.31']), '无端口 entry 匹配任意端口');
check(isTrustedAuthority(u('Harness.Internal:3080'), ['harness.internal']), '大小写归一后匹配');
check(!isTrustedAuthority(u('192.0.2.31'), ['192.0.2.32', 'bad entry/']), '不匹配的 entry 与坏 entry 都不授权');
// 注意:DSH 的 canonicalAuthority 用 http/https **两种**解析判端口,所以 :80 / :443 仍算"显式端口"(这是它的原意)
check(canonicalAuthority('a:80', u('a:80')) === 'a:80', 'canonicalAuthority 把 :80 视为显式端口(与 DSH 同)');
check(canonicalAuthority('a', u('a')) === 'a', 'canonicalAuthority 无端口时返回裸 hostname');
check(canonicalAuthority('a:3080', u('a:3080')) === 'a:3080', 'canonicalAuthority 保留显式非默认端口');

// 3) 来源栅栏
check(checkRequest({ host: '127.0.0.1:3080', ...cookieFor('127.0.0.1:3080') }).ok, 'loopback + 正确 cookie = 放行');
check(checkRequest({ host: '127.0.0.1:3080' }).reason === 'no-cookie', 'loopback 但没 cookie = 拒(理由 no-cookie)');
check(checkRequest({ host: 'evil.com', ...cookieFor('evil.com') }).reason === 'untrusted-host', '域名 Host = 拒(untrusted-host)');
check(checkRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site', ...cookieFor('127.0.0.1:3080') }).reason === 'cross-site',
  'loopback 但 cross-site = 拒');
check(checkRequest({ host: '127.0.0.1:3080', origin: 'http://evil.com', ...cookieFor('127.0.0.1:3080') }).reason === 'origin-mismatch',
  'Origin 与 Host 不同源 = 拒');
check(checkRequest({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', ...cookieFor('127.0.0.1:3080') }).ok,
  'Origin 同源 = 放行');
check(checkRequest({ host: '127.0.0.1:3080', origin: 'not-a-url', ...cookieFor('127.0.0.1:3080') }).reason === 'origin-mismatch',
  'Origin 无法解析 = 拒');
check(checkRequest({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', ...cookieFor('127.0.0.1:3080') }).ok,
  'same-origin 的 Fetch-Metadata = 放行');
check(checkRequest({}).reason === 'no-host', '没有 Host = 拒');
check(checkRequest({ host: '::::' , ...cookieFor('x') }).reason === 'bad-host', 'Host 无法解析 = 拒');

// 4) cookie 名派生:必须与 DSH 同法(交叉验证 + 形状)
check(expectedCookieName('127.0.0.1:3080') === refName('127.0.0.1:3080'), 'cookie 名与 DSH 的算法逐字一致');
check(expectedCookieName('127.0.0.1:3080').startsWith('dsh-auth-'), 'cookie 名带 dsh-auth- 前缀');
check(!/[+/=]/.test(expectedCookieName('a:1')), 'cookie 名是 base64url(无 + / =)');
check(encodeBase64Url(Buffer.from('a+b/c=')) === Buffer.from('a+b/c=').toString('base64url'),
  'encodeBase64Url 与 Node 标准 base64url 一致(DSH 的手写版同形)');
check(requestAuthority({ host: '127.0.0.1:3080' }) === '127.0.0.1:3080', 'requestAuthority 保留显式端口');
check(requestAuthority({ host: 'localhost:80' }) === 'localhost', 'requestAuthority 剥默认端口');
check(requestAuthority({}) === undefined, '无 Host 时 requestAuthority 返回 undefined');

// 5) cookie 读取:确切名字才取,空值也要能区分出来
const nm = expectedCookieName('127.0.0.1:3080');
check(cookieValueOf(`other=1; ${nm}=abc; x=2`, nm) === 'abc', '从多个 cookie 中取到确切名字');
check(cookieValueOf(`other=1`, nm) === undefined, '没有该名字返回 undefined');
check(cookieValueOf(`${nm}`, nm) === undefined, '只有名字没有等号 = 不算存在');
check(checkRequest({ host: '127.0.0.1:3080', cookie: `${nm}=` }).reason === 'empty-cookie', '空值 cookie = 拒(理由 empty-cookie)');
check(checkRequest({ host: '127.0.0.1:3080', cookie: 'dsh-auth-anything=1' }).reason === 'no-cookie',
  '随手编一个 dsh-auth- 名字 = 拒(这正是加固② 要挡的)');
check(checkRequest({ host: '192.0.2.31:3080', ...cookieFor('192.0.2.31:3080') }, { trustedHosts: ['192.0.2.31'] }).ok,
  '显式 trustedHosts 内的地址放行');
check(checkRequest({ host: '10.0.0.5:3080', ...cookieFor('10.0.0.5:3080') }, { trustedHosts: ['10.0.0.5'] }).ok,
  '另一个受信地址同样放行');
// G1(2026-09-17):LAN 地址**不再**自动信任 —— 关掉"同网段设备照着算法编个 cookie 名就能拿到
// 人格档案与真实会话标题"那条不需要任何凭据的路。要开局域网访问必须显式声明。
const lan = lanAddresses();
if (lan.length) {
  const h = `${lan[0]}:3080`;
  check(checkRequest({ host: h, ...cookieFor(h) }).reason === 'untrusted-host',
    '本机 LAN 地址默认不受信(实测 ' + lan[0] + ')');
  check(checkRequest({ host: h, ...cookieFor(h) }, { allowLan: true }).ok,
    'allowLan:true 时才恢复 LAN 信任(显式逃生口)');
  check(checkRequest({ host: h, ...cookieFor(h) }, { trustedHosts: [lan[0]] }).ok,
    '显式写进 trustedHosts 的 LAN 地址仍放行(单地址粒度)');
  check(checkRequest({ host: h, ...cookieFor(h) }, { trustedHosts: ['10.9.9.9'], allowLan: false }).reason === 'untrusted-host',
    'trustedHosts 白名单外的 LAN 地址 = 拒');
} else {
  console.log('· 本机无非内部 IPv4 网卡,跳过 LAN 相关断言');
}
check(!/const trusted = \[\.\.\.lanAddresses\(\)/.test(
  readFileSync(join(root, 'lib/host/guard.js'), 'utf8')), 'guard.js 里"无条件并入 LAN"的旧写法已不存在(G1 回归护栏)');
check(headerOf({ Host: 'x' }, 'host') === undefined && headerOf({ host: 'x' }, 'host') === 'x', 'headerOf 只用小写键(Node 语义)');
check(headerOf(new Headers({ host: 'y' }), 'host') === 'y', 'headerOf 兼容 Fetch Headers');

// 6) 字段白名单(G10):人格补丁只能落在 persona / styles 两棵子树内
check(Object.keys(sanitizePersonaPatch({ guard: { enforce: false } }).clean).length === 0
  && sanitizePersonaPatch({ guard: { enforce: false } }).dropped.includes('guard'),
  '🔒 {"guard":{"enforce":false}} 被整条丢弃(这正是能持久化关停守卫的那条路)');
check(Object.keys(sanitizePersonaPatch({ mode: { lastMode: 'work' } }).clean).length === 0, 'mode 子树不可经 /persona 写入');
check(Object.keys(sanitizePersonaPatch({ updates: { applyWhileRunning: true } }).clean).length === 0, 'updates 子树不可经 /persona 写入');
check(Object.keys(sanitizePersonaPatch({ memory: { l1BudgetTokens: 999999 } }).clean).length === 0, 'memory 子树不可经 /persona 写入');
check(Object.keys(sanitizePersonaPatch({ habits: { pendingMax: 99 } }).clean).length === 0,
  '顶层 habits(生成器配置,与 persona.habits 同名不同物)不可经 /persona 写入');
{
  const r = sanitizePersonaPatch({ persona: { aiName: '小灵', sealed: true }, guard: { enforce: false }, mode: { lastMode: 'x' } });
  check(JSON.stringify(r.clean) === JSON.stringify({ persona: { aiName: '小灵', sealed: true } }),
    '混合补丁:persona 留下,guard / mode 全丢');
  check(r.dropped.includes('guard') && r.dropped.includes('mode'), 'dropped 如实回报被丢的键(便于察觉攻击尝试)');
}
check(sanitizePersonaPatch({ persona: { aiName: 'x', evil: 1 } }).dropped.includes('persona.evil'), 'persona 子键同样收窄');
check(sanitizePersonaPatch({ styles: { work: 'a', hack: 'b' } }).dropped.includes('styles.hack'), 'styles 子键同样收窄');
check(Object.keys(sanitizePersonaPatch({ persona: 'not-an-object' }).clean).length === 0, '非对象子树不写入');
check(Object.keys(sanitizePersonaPatch(null).clean).length === 0 && Object.keys(sanitizePersonaPatch([1, 2]).clean).length === 0,
  'null / 数组补丁不写入');
// 完整性:客户端 collect() 与实际服务端调用点用到的每个键都必须被保留(否则是功能回退,不是加固)
const clientKeys = ['enabled', 'userTitle', 'aiName', 'aiTitle', 'pronoun', 'tone', 'toneWork', 'toneLife', 'language', 'hardRules', 'bottomLines', 'extraLore', 'duty'];
const kept = sanitizePersonaPatch({ persona: Object.fromEntries(clientKeys.map((k) => [k, 'v'])) }).clean.persona;
check(clientKeys.every((k) => k in kept), '客户端 collect() 的全部 13 个字段都被白名单保留(不误杀功能)');
// ⚠️ 计数与数组必须同批改:上面那句 every() 只遍历数组,漏了键它照样绿 —— 只有这行会把数字钉住。
//    (2026-09-27 加 duty 时的真实教训:数组与文案不同批改 ⇒ 测试继续通过但文案开始说谎。)
check(PERSONA_PATCH_KEYS.filter((k) => clientKeys.includes(k)).length === clientKeys.length,
  '文案里的字段数与 clientKeys 实际长度一致(' + clientKeys.length + ' 个)');
const srvKeys = ['ruleMeta', 'habits', 'habitsPending', 'sealed', 'sealPhrase', 'aiTitle'];
check(srvKeys.every((k) => PERSONA_PATCH_KEYS.includes(k)), '服务端/工具会写的字段(规矩元数据、习惯、定型、自述)都在白名单内');
check(STYLE_PATCH_KEYS.length === 2 && STYLE_PATCH_KEYS.includes('work') && STYLE_PATCH_KEYS.includes('life'), 'styles 白名单 = work / life');

// 7) 源码护栏:api.js 必须真的用上守卫,且旧的名字形状校验不得复活
const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
check(/import \{ checkRequest, lanAddresses, sanitizePersonaPatch \} from '\.\/guard\.js';/.test(apiSrc), 'api.js 已接入 guard.js(含白名单)');
check(/const verdict = guardVerdict\(req\);/.test(apiSrc), 'api.js 的 guard 走了 guardVerdict');
check(/sendJson\(res, 403, \{ ok: false, error: 'forbidden', reason: verdict\.reason \}\)/.test(apiSrc), '拒绝时返回 403 + reason');
check(!/AUTH_COOKIE_RE\.test/.test(apiSrc), '旧的"只验名字形状"校验已不在调用路径上');
check(/process\.env\.DSH_LING_GUARD === 'off'/.test(apiSrc), '逃生开关存在(DSH_LING_GUARD=off)');
check(/const \{ clean: patch, dropped \} = sanitizePersonaPatch\(raw\);/.test(apiSrc), '/persona 真的过了白名单(G10 回归护栏)');
check(!/settings\.update\(\{ persona: p, styles: st \}\)/.test(apiSrc), '/import 不再把外来 bundle 原样交给 settings.update');

// 8) 反代场景加固⑤(2026-09-30):**伪造 loopback Host 必须被拒** —— 来源:交接文档 §5.1/§5.3
//    判据核心:**XFF 取最后一段**(nginx 追加的真实对端);取首段会被"预塞 XFF: 127.0.0.1"绕过。
//    背景:引入反向代理后 Host 从"环境事实"退化成"客户端自我声明",而 cookie 那边只校验公开可算的名字 ⇒
//    「伪造 Host: 127.0.0.1:3080 + 自算 cookie 名」曾是一条**不需要任何凭据**的通路(2026-09-30 实测)。
{
  const LOOP = '127.0.0.1:3080';
  const PUB = '192.0.2.31';
  // ⚠️ 受信域名**故意用保留域**(example.com 属 RFC 2606)⇒ 公开仓库里不出现作者的真实域名/入口。
  const T = [PUB, 'main.example.com'];
  const req = (h) => checkRequest(h, { trustedHosts: T });
  // 合法:本机直连(无任何代理头)照旧免检
  check(req({ host: LOOP, ...cookieFor(LOOP) }).ok, '⑤合法:本机直连(无代理头)= 放行');
  check(req({ host: LOOP, origin: `http://${LOOP}`, ...cookieFor(LOOP) }).ok, '⑤合法:本机直连 + 同源 Origin = 放行');
  // 合法:远程正常访问(走 nginx,Host 是真实地址 ⇒ 根本走不到 loopback 分支)
  check(req({ host: PUB, 'x-forwarded-for': '203.0.113.9', cookie: `${refName(PUB)}=v` }).ok,
    '⑤合法:远程访问(Host=受信 IP,XFF=真实对端)= 放行');
  check(req({ host: 'main.example.com', 'x-forwarded-for': '203.0.113.9', cookie: `${refName('main.example.com')}=v` }).ok,
    '⑤合法:远程访问(Host=域名)= 放行');
  // ★攻击:伪造 loopback Host 且带着代理追加的头
  check(req({ host: LOOP, 'x-forwarded-for': '203.0.113.9', cookie: `${refName(LOOP)}=1` }).reason === 'spoofed-loopback-host',
    '⑤攻击①:伪造 Host=loopback + XFF(经反代)= 拒(spoofed-loopback-host)');
  check(req({ host: LOOP, 'x-forwarded-for': '127.0.0.1, 203.0.113.9', cookie: `${refName(LOOP)}=1` }).reason === 'spoofed-loopback-host',
    '⑤攻击②:攻击者预塞 XFF=127.0.0.1(**取最后一段才挡得住**)= 拒');
  check(req({ host: 'localhost', 'x-forwarded-for': '203.0.113.9', cookie: `${refName('localhost')}=1` }).reason === 'spoofed-loopback-host',
    '⑤攻击③:伪造 Host=localhost = 拒');
  check(req({ host: LOOP, 'x-real-ip': '203.0.113.9', cookie: `${refName(LOOP)}=1` }).reason === 'spoofed-loopback-host',
    '⑤攻击④:只给 X-Real-IP 不给 XFF = 拒');
  check(req({ host: LOOP, 'x-forwarded-for': '203.0.113.9' }).reason === 'spoofed-loopback-host',
    '⑤攻击⑤:伪造 loopback 且不带 cookie = 拒(先判伪造,不落 no-cookie)');
  check(req({ host: LOOP, 'x-forwarded-for': '203.0.113.9', cookie: `${refName(LOOP)}=1`, 'sec-fetch-site': 'cross-site' }).reason === 'spoofed-loopback-host',
    '⑤攻击⑥:伪造 loopback + 跨站 = 拒(先判伪造)');
  // 边界:反代头里**最后一段是 loopback**(本机自建的本地代理)—— 不该误伤
  check(req({ host: LOOP, 'x-forwarded-for': '127.0.0.1', cookie: `${refName(LOOP)}=1` }).ok,
    '⑤边界:代理头最后一段是 loopback(本机自建代理)= 不误伤');
}
// 源码护栏:判据的命门是"取最后一段",别被"优化"成首段
{
  const gsrc = readFileSync(join(root, 'lib/host/guard.js'), 'utf8');
  check(/export function realPeerAddress/.test(gsrc), '⑤护栏:realPeerAddress 已导出');
  check(/parts\[parts\.length - 1\]/.test(gsrc), '⑤护栏:XFF 取**最后一段**(不是首段 —— 取首段可被预塞绕过)');
  check(/reason: 'spoofed-loopback-host'/.test(gsrc), '⑤护栏:伪造 loopback 的拒绝理由在位');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 8) 手术门(2026-09-30 深夜;PLAN-手术门-实施 §1.1/§1.4/§1.5)——
//    · 本机判据是**单一来源**(realPeerAddress),这里验它与守卫⑤同一条命门;
//    · 留痕的**哈希链**:两次事件串得上 / 手工改一行 ⇒ 校验函数报断链(位置 + 原因);
//    · **负对照**:未 sealed ⇒ 行为与现状逐字一致(连"进过手术流程"都不该为真);
//    · 逃生开关:DSH_LING_GUARD=off 与 settings.guard.enforce=false 都必须整体放行。
//    ⚠️ 全部落 mkdtempSync 临时目录(DSH_HOME 在 import 之前设置)⇒ 绝不读写真机 ~/.dsh。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const holder = mkdtempSync(join(tmpdir(), 'dsh-ling-surgery-guard-'));
  process.env.DSH_HOME = holder;   // dshHome() 惰性读取 ⇒ 票据/留痕都落在临时目录
  const {
    isLocalSurgeryRequest, requireSurgery, createSurgeryEvent, verifySurgeryChain,
    readSurgeryTicket, rotateSurgeryTicket, surgeryTicketPath, rawUnlock, surgeryLogPath,
  } = await imp('lib/host/surgery.js');

  // ── 8.1 §1.1 本机判据:与守卫⑤共用同一条命门(不另写一份 IP 判断)─────────────────────
  //  ⚠️ 2026-10-01 晚**判据加强**:「无代理头」⇒「**无代理头 且 带 UA**」。
  //     起因是真机发现远端面板那条路(远端浏览器 → nginx → frpc → 宿主内 remote-web-ui 中继 →
  //     127.0.0.1:3080)在中继里被**重建**了请求头:Origin / UA / XFF 全丢,只补一句合成的
  //     `sec-fetch-site: same-origin` ⇒ 在器灵看来它"既没有代理头、也没有 Origin",与真本机同形。
  //     故这里第 1 条（旧断言「一个空头对象就算本机」）**按新判据改写**并保留原文案括号说明:
  //     空头对象没有 UA ⇒ 现在**不算**本机;紧随其后补上"带 UA 的本机浏览器"为正对照。
  //     这不是"放水",是判据本身变了 —— 旧的"没有 UA 也算本机"正是被修掉的那条路。
  const UA_LOCAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/156.0';
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080', 'user-agent': UA_LOCAL }) === true,
    '手术门:无代理头 + 带 UA ⇒ 直连本机(本机浏览器,负对照:别误伤)');
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080' }) === false,
    '手术门:无代理头但**没有 UA** ⇒ **不算本机**(远端中继重建请求头会丢 UA —— 这就是被修的那条路)');
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080', 'user-agent': '   ' }) === false,
    '手术门:UA 是空白串 ⇒ 仍不算本机(不拿"头存在但没值"当浏览器指纹)');
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080', 'x-forwarded-for': '203.0.113.9', 'user-agent': UA_LOCAL }) === false,
    '手术门:带 XFF ⇒ 经代理(**哪怕对端写的是公网地址**;**哪怕带着 UA 也不算本机** —— 代理头那一条不许删)');
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080', 'x-real-ip': '203.0.113.9', 'user-agent': UA_LOCAL }) === false,
    '手术门:只带 X-Real-IP 也算经代理');
  check(isLocalSurgeryRequest({ host: '127.0.0.1:3080', 'x-forwarded-for': '127.0.0.1', 'user-agent': UA_LOCAL }) === false,
    '手术门:代理头最后一段写 loopback ⇒ **仍算经代理**(比守卫⑤更严:§1.1 的判据就是"一个代理头都没有" ——'
    + '攻击者预塞 `XFF: 127.0.0.1` 的成本是零,手术是最后一道防线,不放这个口子)');

  // ── 8.1b 判据的**源码护栏**(防"将来被优化掉"):两条命门都必须逐字在位 ────────────────
  {
    const ssrc = readFileSync(join(root, 'lib/host/surgery.js'), 'utf8');
    check(/realPeerAddress\(headers\) !== undefined\) return false/.test(ssrc),
      '⑧护栏:判据第①条(代理头)在位 —— 公网直连时 nginx 追加的 XFF 是全链最可靠的一道,不许删');
    check(/headerOf\(headers, 'user-agent'\)/.test(ssrc) && /ua\.trim\(\) !== ''/.test(ssrc),
      '⑧护栏:判据第②条(**UA 必须存在且非空**)在位 —— 远端中继丢 UA 就是那条路的指纹,不许被"优化"掉');
    check((ssrc.match(/export function isLocalSurgeryRequest/g) || []).length === 1,
      '⑧护栏:isLocalSurgeryRequest **只有 1 处定义**(单一来源)');
  }

  // ── 8.2 §1.2 票据:本机拿得到 / 每次轮换不同 ──────────────────────────────────────
  const t1 = readSurgeryTicket();
  check(/^[0-9a-f]{64}$/.test(t1), '票据:32 字节随机 ⇒ 64 位十六进制(实测长度 ' + t1.length + ')');
  check(readSurgeryTicket() === t1, '票据:同一启动内保持不变(客户端缓存才有意义)');
  const t2 = rotateSurgeryTicket();
  const t3 = rotateSurgeryTicket();
  check(t2 !== t1 && t3 !== t2 && /^[0-9a-f]{64}$/.test(t3),
    '票据:每次轮换都是**新的一枚**(两次生成不同 ⇒ 表达"每启动轮换"、不真重启)');
  check(surgeryTicketPath().startsWith(holder), '票据路径在 $DSH_HOME 之下(临时目录,实为 ' + surgeryTicketPath() + ')');

  // ── 8.3 §1.3 负对照:未 sealed ⇒ 行为与现状**逐字一致** ──────────────────────────
  const unsealed = { get: () => ({ persona: {} }) };
  const v0 = requireSurgery({ host: '127.0.0.1:3080', 'x-forwarded-for': '203.0.113.9' }, { unlock: 'x' }, { settings: unsealed });
  check(JSON.stringify(v0) === JSON.stringify({ ok: true, gated: false, reason: null, phraseOk: true, channel: 'proxy', ticketOk: false }),
    '★负对照:未 sealed ⇒ 放行且 **gated:false**(连"经代理也不拦"—— 不打扰日常;实测 ' + JSON.stringify(v0) + ')');

  // ── 8.4 §1.5 逃生开关:两条都必须整体放行(误判时不把主人锁在门外)────────────────
  const sealedOn = { get: () => ({ persona: { sealed: true, sealPhrase: '这是我在定型时亲手写下的承诺句。' }, guard: { enforce: false } }) };
  const offBySettings = requireSurgery({ host: '127.0.0.1:3080' }, {}, { settings: sealedOn });
  check(offBySettings.ok === true && offBySettings.gated === false,
    '逃生开关:settings.guard.enforce === false ⇒ 整体放行(实测 gated=' + offBySettings.gated + ')');
  process.env.DSH_LING_GUARD = 'off';
  const offByEnv = requireSurgery({ host: '127.0.0.1:3080', 'x-forwarded-for': '203.0.113.9' }, {}, { settings: sealedOn });
  check(offByEnv.ok === true && offByEnv.gated === false, '逃生开关:DSH_LING_GUARD=off ⇒ 整体放行(带代理头也放行)');
  delete process.env.DSH_LING_GUARD;

  // ── 8.5 §1.4 留痕:哈希链串得上 + 改一行即断链(写成断言)─────────────────────────
  const iso = join(holder, 'chain.jsonl');
  const e1 = createSurgeryEvent({ endpoint: '/persona', fields: { unlock: 's:abc' }, reason: 'ok', channel: 'proxy', phraseOk: true }, { file: iso });
  const e2 = createSurgeryEvent({ endpoint: '/persona', fields: {}, reason: 'surgery-ticket', channel: 'local', phraseOk: false }, { file: iso });
  check(e1.prevLineHash === null, '链首:第一条的 prevLineHash 为 null(没有"上一条")');
  check(e2.prevLineHash === e1.hash, '★链:第二条的 prevLineHash === 第一条整行的哈希(串得上)');
  const intact = verifySurgeryChain(iso);
  check(intact.ok === true && intact.count === 2 && intact.brokenAt === null,
    '链校验:完好文件 ⇒ ok + count=2 + brokenAt=null(实测 ' + JSON.stringify(intact) + ')');

  const lines = readFileSync(iso, 'utf8').split('\n').filter((l) => l.trim() !== '');
  const tampered = join(holder, 'chain-tampered.jsonl');
  const t = lines.slice();
  t[0] = t[0].replace('"reason":"ok"', '"reason":"ok!改过了"');   // 手工改**内容**(hash 字段没跟着改)
  writeFileSync(tampered, t.join('\n') + '\n');
  const broken = verifySurgeryChain(tampered);
  check(broken.ok === false && broken.brokenAt === 1 && broken.reason === 'hash',
    '★改一行 ⇒ 校验函数报断链:brokenAt=' + broken.brokenAt + ' reason=' + broken.reason + '(整链完好时为 null)');
  check(readFileSync(tampered, 'utf8') !== readFileSync(iso, 'utf8'), '改过的文件确实与原文件不同(不是"改了但没生效")');

  // 链的另一半:只改 `hash` 字段本身(内容没动)也必须被抓
  const tampered2 = join(holder, 'chain-tampered2.jsonl');
  const t2lines = lines.slice();
  t2lines[0] = t2lines[0].replace(/"hash":"[0-9a-f]{8}/, '"hash":"deadbeef');
  writeFileSync(tampered2, t2lines.join('\n') + '\n');
  const broken2 = verifySurgeryChain(tampered2);
  check(broken2.ok === false && broken2.brokenAt === 1, '只改 hash 字段本身(伪装成"合法")⇒ 同样报断链 at ' + broken2.brokenAt);

  const emptyFile = join(holder, 'chain-empty.jsonl');
  writeFileSync(emptyFile, '');
  check(JSON.stringify(verifySurgeryChain(emptyFile)) === JSON.stringify({ ok: true, count: 0, brokenAt: null, reason: null }),
    '空文件 = 空链(还没发生过手术)⇒ ok,不误报');

  // ── 8.6 rawUnlock:只从原文里抽承诺句(不整包 parse 4 MiB bundle)────────────────
  check(rawUnlock('{"bundle":{"a":1},"unlock":"这是原句"}') === '这是原句', 'rawUnlock:顶层 unlock 抽得出');
  check(rawUnlock('{"bundle":{"unlock":"嵌入的假句"},"unlock":"真的"}') === '嵌入的假句',
    'rawUnlock:抽的是**第一个** "unlock"(bundle 在 unlock 之前 ⇒ 命中嵌入键,故调用点须保证 unlock 在前/唯一的形状)');
  check(rawUnlock('{"bundle":{}}') === '' && rawUnlock('') === '' && rawUnlock('not json') === '',
    'rawUnlock:取不到 ⇒ 空串(空串永远不等于任何已存的承诺句 ⇒ 只会更严,不会误放行)');
  check(rawUnlock('{"unlock":"a\\"b"}') === 'a"b', 'rawUnlock:按 JSON 规则反转义');
  check(surgeryLogPath().startsWith(holder), '留痕路径在 $DSH_HOME/logs 之下(实为 ' + surgeryLogPath() + ')');

  // ── 8.7 §6.2 链基线标记(2026-10-01 下午)─────────────────────────────────────────
  //  规格三条:① 断链落在**基线区间内** ⇒ ok:true + knownGaps(历史缺口,不再"永远喊狼来了");
  //            ② 落在区间**外** ⇒ 仍 ok:false(**新的篡改照样红**);
  //            ③ **区间内的自哈希照样核** —— 被改过的历史行不许因为"在区间里"就被放过。
  //  ⚠️ 构造手法:**不自己复算哈希公式**。用生产代码 createSurgeryEvent 往**空文件**里写一条
  //     (它的 prevLineHash 天然是 null、自哈希由生产代码算) ⇒ 得到"自哈希正确、链是断的"的**孤儿行**,
  //     再把它原样拼进目标链。自己拼 JSON = 在测试里再写一份规范化,一旦与 lineOfHash 差一个键,
  //     下面的断言就全是假的(本项目吃过"两条序列化路径拼形状"的亏)。
  {
    const S = await imp('lib/host/surgery.js');
    const chainFile = (name) => join(holder, name);
    const evOf = (at) => ({ endpoint: '/persona', reason: 'ok', channel: 'local', phraseOk: true });
    const append = (file, text) => writeFileSync(file, readFileSync(file, 'utf8') + text);
    /** 自哈希正确、prevLineHash=null 的孤儿行(在**空文件**里用生产代码写出来)。 */
    const mkOrphan = () => {
      const f = chainFile('seg-orphan.jsonl');
      writeFileSync(f, '');
      return JSON.stringify(S.createSurgeryEvent(evOf(), { file: f, at: '2026-01-01T00:00:00.000Z' }));
    };
    const orphan = mkOrphan();

    // ① 区间内断链:第 1 条正常;2–5 条是孤儿行(prevLineHash=null ⇒ 断链,但自哈希正确);第 6 条重新接上
    const inFile = chainFile('base-in.jsonl');
    writeFileSync(inFile, '');
    const l1 = S.createSurgeryEvent(evOf(), { file: inFile, at: '2026-01-01T00:00:01.000Z' });
    writeFileSync(inFile, JSON.stringify(l1) + '\n' + [orphan, orphan, orphan, orphan].join('\n') + '\n');
    const l6 = S.createSurgeryEvent(evOf(), { file: inFile, at: '2026-01-01T00:00:06.000Z' });
    check(l6.prevLineHash === JSON.parse(orphan).hash, '8.7① 前置:第 6 条真的接在第 5 条之后(链在区间结束后重新接上)');
    const vIn = S.verifySurgeryChain(inFile);
    check(vIn.ok === true && vIn.count === 6 && vIn.brokenAt === null,
      '★8.7① 已知区间内的断链(2–5 条 prevLineHash=null)⇒ ok:true(实测 ' + JSON.stringify(vIn) + ')');
    // 2026-10-01 晚(**语义更新,不是放宽**):`surgery.js:361/:395-396` 去重后
    //   `knownGaps` **每个基线区间只报一条**,`at` 记该区间**首个**受影响的行号
    //   (这里 2–5 条孤儿行同属区间 1–5 ⇒ 只出一条,at = 2)。
    //   四条不变量 —— ① 区间内断链仍被豁免 ② `at` 记首行 ③ 区间**内**自哈希照样核
    //   ④ 区间**外**仍 ok:false —— 由 `tests/branch.test.mjs` **§7.9c 的 ①②③④** 完整覆盖
    //   (含 ③④ 两条负对照)。本文件这 3 条(此处 + 下方 `/surgery/events` 读面 + 8.7④ 文件基线)
    //   只跟着"每区间一条"改**期望条数**,判据本身一个字没松。
    check(Array.isArray(vIn.knownGaps) && vIn.knownGaps.length === 1 && vIn.knownGaps[0].at === 2
      && vIn.knownGaps.every((g) => g.from === 1 && g.to === 5),
      '★8.7① knownGaps 每区间一条 + 记下**首行**行号与出处(人一眼看出"这是历史缺口,不是新的篡改";实测 ' + JSON.stringify(vIn.knownGaps) + ')');
    const ls = S.listSurgeryEvents(10, { file: inFile });
    check(Array.isArray(ls.chain.knownGaps) && ls.chain.knownGaps.length === 1 && typeof ls.chain.baseline === 'string',
      '★8.7① 读取面 /surgery/events 的 chain 字段带上 knownGaps(每区间一条)与基线出处(实测 ' + JSON.stringify(ls.chain) + ')');

    // ② 区间外断链:前 5 条**正确串上**,第 6 条放孤儿行 ⇒ 必须仍红(且 6 > 5 落在区间外)
    const outFile = chainFile('base-out.jsonl');
    writeFileSync(outFile, '');
    for (let i = 1; i <= 5; i++) S.createSurgeryEvent(evOf(), { file: outFile, at: '2026-01-01T00:00:0' + i + '.000Z' });
    append(outFile, orphan + '\n');
    const vOut = S.verifySurgeryChain(outFile);
    check(vOut.ok === false && vOut.brokenAt === 6 && vOut.reason === 'chain',
      '★8.7② 区间**外**的断链仍 ok:false(第 6 条;实测 ' + JSON.stringify(vOut) + ')');

    // ③ 区间内的**自哈希**照样核:把第 3 条(落在 1–5 内)的内容改一个字,hash 没跟着改
    const tamperFile = chainFile('base-in-tampered.jsonl');
    const linesIn = readFileSync(inFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    linesIn[2] = linesIn[2].replace('"reason":"ok"', '"reason":"ok!改过了"');
    writeFileSync(tamperFile, linesIn.join('\n') + '\n');
    const vT = S.verifySurgeryChain(tamperFile);
    check(vT.ok === false && vT.brokenAt === 3 && vT.reason === 'hash',
      '★8.7③ 区间内被改一行的**自哈希照样被抓**(不许因为"在区间里"就放过;实测 ' + JSON.stringify(vT) + ')');

    // ④ 基线**文件优先**:文件存在就以文件为准(不叠加内置),因此 `{brokenRanges:[]}` 能把豁免整体关掉
    const noneFile = chainFile('baseline-none.json');
    writeFileSync(noneFile, JSON.stringify({ brokenRanges: [] }));
    const vOff = S.verifySurgeryChain(inFile, { baselineFile: noneFile });
    check(vOff.ok === false && vOff.brokenAt === 2 && vOff.reason === 'chain',
      '★8.7④ 基线写 `{brokenRanges:[]}` ⇒ 豁免整体关闭(文件优先于内置;实测 ' + JSON.stringify(vOff) + ')');
    const mineFile = chainFile('baseline-mine.json');
    writeFileSync(mineFile, JSON.stringify({ brokenRanges: [{ from: 2, to: 5, reason: '测试用区间', at: '2026-02-02' }] }));
    const vMine = S.verifySurgeryChain(inFile, { baselineFile: mineFile });
    // ⚠️ 取值**必须防崩**:双向验证时(vMine 来自旧实现)knownGaps 是 undefined —— 而 check() 的
    //    message 参数是**先求值再传参**的,写 `vMine.knownGaps[0]` 会让整个文件停在这一行,
    //    那就看不到"红在哪几条"了(与 branch.test.mjs 对缺失路由的处理同一条纪律)。
    const gap0 = (v) => (Array.isArray(v?.knownGaps) && v.knownGaps.length ? v.knownGaps[0] : null);
    check(Array.isArray(vMine.knownGaps) && vMine.knownGaps.length === 1 && vMine.knownGaps[0].reason === '测试用区间',
      '★8.7④ 文件里的区间被采纳(每区间一条;reason/出处一并带出;实测 ' + JSON.stringify(gap0(vMine)) + ')');
    check(S.verifySurgeryChain(inFile, { baseline: false }).ok === false,
      '8.7④ `baseline:false` ⇒ 明确关闭豁免(核验基线自身时用)');

    // ⑤ 真机实况的首个区间:**from 1, to 5**(临时 $DSH_HOME 下没有基线文件 ⇒ 走内置默认)
    //   ⚠️ 双向验证的纪律(与 branch.test.mjs 对"路由没挂上"的处理同一条):换回旧实现时应当
    //     **逐条断言打红、看得到红在哪几条**,而不是整个文件停在"读一个不存在的导出"上。
    //     故旧实现缺这两个导出时,这里合成一个"缺失"回执让断言自己红。
    const hasBaselineApi = typeof S.readSurgeryBaseline === 'function' && typeof S.surgeryBaselinePath === 'function';
    const def = hasBaselineApi ? S.readSurgeryBaseline() : { source: '(旧实现无此导出)', ranges: [] };
    check(hasBaselineApi && def.source === 'builtin-default' && def.ranges.length === 1 && def.ranges[0].from === 1 && def.ranges[0].to === 5,
      '★8.7⑤ 内置默认区间 = 真机实况 from 1, to 5(实测 ' + JSON.stringify(def.ranges) + ')');
    check(hasBaselineApi && S.surgeryBaselinePath().startsWith(holder),
      '8.7⑤ 基线路径跟随 $DSH_HOME(实为 ' + (hasBaselineApi ? S.surgeryBaselinePath() : '(旧实现无此导出)') + ')');

    // ⑥ 基线文件**坏了** ⇒ 空区间(保守:宁可报断链,也不假装有豁免)
    const badFile = chainFile('baseline-broken.json');
    writeFileSync(badFile, '{ 这不是 JSON');
    const bad = hasBaselineApi ? S.readSurgeryBaseline(badFile) : { error: '(旧实现无此导出)', ranges: [] };
    check(hasBaselineApi && bad.error === 'baseline-unparsable' && bad.ranges.length === 0,
      '8.7⑥ 坏基线 ⇒ 空区间 + error 标记(实测 ' + JSON.stringify(bad) + ')');
    check(S.verifySurgeryChain(inFile, { baselineFile: badFile }).ok === false,
      '8.7⑥ 坏基线 ⇒ 区间内的断链也照样红(不假装有豁免)');

    // ⑦ 形状纪律:完好链的回执**不带** knownGaps 键(§8.5 那条"空文件回执逐字相等"的断言因此不被打破)
    const cleanFile = chainFile('base-clean.jsonl');
    writeFileSync(cleanFile, '');
    for (let i = 1; i <= 3; i++) S.createSurgeryEvent(evOf(), { file: cleanFile, at: '2026-01-01T00:00:0' + i + '.000Z' });
    const vClean = S.verifySurgeryChain(cleanFile);
    check(vClean.ok === true && !('knownGaps' in vClean),
      '8.7⑦ 完好链不带 knownGaps 键(实测 ' + JSON.stringify(vClean) + ')');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 9) 1.5.3 四件小活的护栏(E3 归因 / `/state` 基数上限 / `?db=` 白名单 / POST_ONLY 差集快照)
//    ⚠️ 本段**只追加**:上面任何既有断言一个字都没动(并发纪律:同一文件多路在改,只准追加)。
//    ⚠️ 全部落 mkdtempSync 临时目录,不读写真机 ~/.dsh;不启服务器、不占端口。
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ── 9.1 E3(审计 H-4):会话内调用 vs 面板调用,归因不许再混成一种 ────────────────────────────
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { SettingsFile } = await imp('lib/host/settings-file.js');
  const { addRule, rulesView } = await imp('lib/host/rules.js');
  const { ruleWriteAttribution, SESSION_NO_QUOTE_NOTE } = await imp('lib/host/api.js');

  // 三种请求形状:面板表单(client.js 发的就是第一种)/ 会话内无原话 / 会话内有原话
  const panel = ruleWriteAttribution({ action: 'add', rule: 'x' });
  const noQuote = ruleWriteAttribution({ action: 'add', rule: 'x', sessionId: 'sess-1' });
  const quoted = ruleWriteAttribution({ action: 'add', rule: 'x', sessionId: 'sess-1', quote: ' 你以后先说结论 ' });
  check(panel.source === 'panel' && panel.fromPanel === true && panel.sessionId === 'panel' && panel.quote === '',
    '★E3 负对照:面板形状(无会话身份、无原话)仍判 panel(实测 ' + JSON.stringify(panel) + ')');
  check(noQuote.source === 'session-no-quote' && noQuote.sessionId === 'sess-1' && noQuote.quote === SESSION_NO_QUOTE_NOTE,
    '★E3 会话内 + 不带 quote ⇒ 新标记 session-no-quote(不许再落成 panel;实测 ' + JSON.stringify(noQuote) + ')');
  check(quoted.source === 'session' && quoted.quote === '你以后先说结论',
    'E3 会话内 + 带原话 ⇒ session(原话逐字留下,只去两侧空白;实测 ' + JSON.stringify(quoted) + ')');

  // 落库判据(真 addRule + 真 SettingsFile ⇒ 读回 ruleMeta;这才是"留痕里到底写了什么")
  const sdir = mkdtempSync(join(tmpdir(), 'dsh-ling-e3-'));
  const st = new SettingsFile(join(sdir, 'set'));
  const w1 = await addRule({ settings: st, rule: '会话内无原话的那条', quote: noQuote.quote, sessionId: noQuote.sessionId, source: noQuote.source });
  const m1 = rulesView(st).rules.find((r) => r.text === '会话内无原话的那条');
  check(w1.ok === true, 'E3 会话内无原话**照旧落库**(与改前一致:改前也落库,只是被贴成 panel;实测 ' + JSON.stringify(w1) + ')');
  // ⚠️ 这一条是 E3 的**核心断言**:落库后的来源**不许**是 'panel' —— 改前它正是 'panel',
  //    也就是"主人亲手写的那一条"。改后它如实落成会话类归因,且原话位写明"没有原话"。
  //    ⚠️ 落库口径是 rules.js 定的:`source: fromPanel ? 'panel' : 'session'` —— **非 panel 一律折成
  //    'session'**,所以判据里的第三个值 'session-no-quote' 到不了库里的 `source` 字段
  //    (它在判据与回执里;库里"没有原话"由**原话位**承载)。要带进库得改 rules.js —— 不在本轮可写清单。
  check(m1 && m1.source === 'session' && m1.source !== 'panel' && m1.quote === SESSION_NO_QUOTE_NOTE && m1.sessionId === 'sess-1',
    '★E3 落库后来源**不再冒充 panel**(会话类归因),原话位如实写「未附原话」(实测 ' + JSON.stringify(m1) + ')');
  const w2 = await addRule({ settings: st, rule: '面板写的那条', quote: panel.quote, sessionId: panel.sessionId, source: panel.source });
  const m2 = rulesView(st).rules.find((r) => r.text === '面板写的那条');
  check(w2.ok === true && m2 && m2.source === 'panel' && m2.quote === '(面板直接写入)',
    '★E3 负对照:面板写入落库仍是 panel + rules.js 的「(面板直接写入)」(语义一个字没动;实测 ' + JSON.stringify(m2) + ')');
  check(/source: fromPanel \? 'panel' : 'session'/.test(readFileSync(join(root, 'lib/host/rules.js'), 'utf8')),
    'E3 护栏:rules.js 的落库口径仍是"两值契约"(panel / 非 panel) —— 若有人把它改成透传,'
    + '上面那条断言的语义就要**有意识地**重定(库里的 source 那时才会出现第三个值)');

  // 源码护栏:旧的反推口径不许复活;两个调用点都必须显式交代 source
  // ⚠️ 先剥注释再断言:本段上方的说明里**逐字引用**了旧写法(历史证据要留),不能把注释当代码判。
  const apiCode = apiSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check(!/body\.quote \? 'session' : 'panel'/.test(apiCode),
    'E3 护栏:api.js 的**代码**里"拿 body.quote 反推身份"的旧写法已不存在(注释里的引用不算)');
  check(/const attr = ruleWriteAttribution\(body\);/.test(apiSrc) && /source: attr\.source/.test(apiSrc),
    'E3 护栏:/persona/rule 用的就是那唯一一处归因判据(attr)');
  const tsrc = readFileSync(join(root, 'lib/host/tools.js'), 'utf8');
  check(/source: String\(c\.quote \|\| ''\)\.trim\(\) \? 'session' : 'session-no-quote'/.test(tsrc),
    'E3 护栏:tools.js 的 rule_add 调用点**显式**交代 source(不再靠 rules.js 的缺省值兜)');
  check(!/addRule\(\{ settings, rule: c\.rule, quote: c\.quote, sessionId: sessionIdOf\(exec\) \}\)/.test(tsrc),
    'E3 护栏:旧的"不传 source"那一行已不存在');
}

// ── 9.2 A(审计 §四.4):`/state?sessionId=<任意>` 的基数上限 —— 只淘汰空壳 ────────────────────
{
  const { FreezeGate } = await imp('lib/host/freeze.js');
  const readAll = (g) => JSON.stringify({
    run: g.isRunning('real-running'),
    snap: g.snapshotOf('real-snap'),
    mode: g.snapshotOf('real-mode'),
    pend: [g.pendingCount('real-running'), g.pendingCount('real-snap')],
    ids: g.snapshotIds().sort(),
  });
  const g = new FreezeGate({ maxIdleSessions: 16 });
  g.setRunning('real-running', true);            // 带 running
  g.markSnap('real-snap', { mode: 'life', at: 1 }); // 带 snap
  g.ensure('real-mode', { mode: 'work' });       // 带 mode
  const before = readAll(g);
  for (let i = 0; i < 200; i += 1) g.isRunning('fake-' + i);   // = /state?sessionId=<自造 id> 那条路
  check(g.size() <= 16, '★A 灌 200 个自造 sessionId ⇒ 条目数不超上限(实测 size=' + g.size() + ',上限 16)');
  check(readAll(g) === before, '★A 已存在会话的读数逐字不变(实测 ' + readAll(g) + ')');
  const g2 = new FreezeGate();
  for (let i = 0; i < 200; i += 1) g2.isRunning('x-' + i);
  check(g2.size() <= 128, 'A 默认上限 128 同样成立(实测 size=' + g2.size() + ')');
  const g3 = new FreezeGate({ maxIdleSessions: 2 });
  g3.setRunning('r1', true); g3.markSnap('r2', { at: 1 }); g3.ensure('r3', { mode: 'life' });
  check(g3.size() === 3 && g3.isRunning('r1') === true,
    '★A 上限 2 但三条都是真读数 ⇒ 一条都不淘汰(size 3 > 2 是**有意**的:宁可超上限也不动读数;实测 ' + g3.size() + ')');
  check(/const MAX_IDLE_SESSIONS_DEFAULT = 128;/.test(readFileSync(join(root, 'lib/host/freeze.js'), 'utf8')),
    'A 护栏:上限是声明出来的常量(附依据注释),不是散落的魔数');
}

// ── 9.3 B(审计 §四.4):`/dsweb/summary/preview?db=` 只认默认库 / settings 白名单 ─────────────
{
  const { previewDbPolicy } = await imp('lib/host/api.js');
  const env = { DSH_LING_DSWEB_DB: 'C:/db/lib.db' };
  const def = previewDbPolicy(undefined, {}, env);
  check(def.ok === true && def.db === 'C:/db/lib.db',
    '★B 负对照:不给 ?db= ⇒ 照旧用默认库(实测 ' + JSON.stringify(def) + ')');
  // ⚠️ "同一路径的不同写法"是**平台语义**,不是普遍真理。判据在 normDbPath()
  //    (`lib/host/api.js:130-133`):① `\`→`/` + 去尾斜杠(**两平台都做**);② 折大小写**只在 win32**。
  //    · Windows:盘符与路径都不区分大小写、`\` 与 `/` 等价 ⇒ `c:\DB\lib.db` 与白名单里的
  //      `C:/db/lib.db` 指的是**同一个文件** ⇒ 必须放行(否则主人换个写法填就被自家白名单拒了)。
  //    · POSIX:大小写**敏感**(`c:` ≠ `C:`、`DB` ≠ `db`),`\` 还只是普通文件名字符 ⇒ 归一后
  //      `c:/DB/lib.db` 与 `C:/db/lib.db` **仍是两个不同路径** ⇒ 必须拒。这里放行才是错的:
  //      端点拿到 pol.db 后走的是 `openSource(pol.db)`(api.js:2795/2807)—— 打开的是**原样字符串**,
  //      归一化只是比对用的键;放行一个白名单没写过的路径,等于白名单被绕过。
  //    两支都断言实值:win32 支钉"等价写法放行 + db 原样回给调用方";POSIX 支钉"不等价 ⇒ 拒且不静默"
  //    (reason/asked/allowed 都在 ⇒ 证明确实是"写法不同"被拒,不是白名单为空)。
  if (process.platform === 'win32') {
    const same = previewDbPolicy('c:\\DB\\lib.db', {}, env);
    check(same.ok === true && same.db === 'c:\\DB\\lib.db',
      '★B 负对照:默认库的同一路径(反斜杠/盘符大小写不同)照旧放行(实测 ' + JSON.stringify(same) + ')');
  } else {
    const diff = previewDbPolicy('c:\\DB\\lib.db', {}, env);
    check(diff.ok === false && diff.reason === 'db-not-allowed' && diff.db === ''
      && diff.asked === 'c:\\DB\\lib.db' && diff.allowed.join() === 'C:/db/lib.db',
      '★B 负对照(POSIX):`c:\\DB\\lib.db` 与默认库 `C:/db/lib.db` 是两个不同路径(大小写敏感)'
      + '⇒ 拒且不静默:reason/asked/allowed 都在、db 为空(实测 ' + JSON.stringify(diff) + ')');
  }
  const cfg = { get: () => ({ dsweb: { dbPath: 'D:/mine/a.db' } }) };
  check(previewDbPolicy('D:/mine/a.db', cfg, {}).ok === true, '★B 负对照:settings 白名单内的路径放行');
  check(previewDbPolicy('D:/mine/b.db', { get: () => ({ dsweb: { dbs: ['D:/mine/b.db'] } }) }, {}).ok === true,
    '★B 负对照:settings 的 dbs[] 数组写法同样放行');
  const bad = previewDbPolicy('C:/Windows/SAM', cfg, {});
  check(bad.ok === false && bad.reason === 'db-not-allowed' && bad.asked === 'C:/Windows/SAM' && bad.db === '',
    '★B 白名单外的路径 ⇒ 拒 + reason:db-not-allowed(**不静默、不打开**;实测 ' + JSON.stringify(bad) + ')');
  check(previewDbPolicy('E:/secret.db', {}, {}).ok === false,
    '★B 一条白名单都没有时,任何显式 ?db= 一律拒(默认库才是唯一的"零配置"通路)');
  check(/const pol = previewDbPolicy\(q\.get\('db'\), settings\);/.test(apiSrc),
    'B 护栏:preview 端点接的是白名单判据');
  check(!/const db = dswebDbOf\(q\.get\('db'\)\);/.test(apiSrc),
    'B 护栏:preview 端点不再直接吃任意路径');
}

// ── 9.3b A-1(2026-10-05 夜):两条"习惯候选"写面必须过手术门 ─────────────────────────────
// 来源:`plans\HANDOFF-机制面复核交办单-20261005.md` §A-1(机制面逐条复核 A 栏第一项,安全面)。
// 事实:`/persona/habits/scan` 与 `/persona/habits/reflect` 都会经 `proposeHabit` 把候选写进
//   `habitsPending`(进人格面),而确认侧 `/persona/habit` **是过门的** ⇒ 一条通路的两半只改了一半,
//   正是 DESIGN §0.1 理念 9「两半同批」的反例。
// 这里用**源码级**护栏(与 `:140` 那条 `api.js 的 guard 走了 guardVerdict` 同一形态):
//   行为级(真起服务、带代理头调这两条)由真机复跑覆盖 —— 本测试不启 HTTP 服务。
// ⚠️ 判据必须落在**该端点的 handler 块内**:`gateSurgery` 在 api.js 里有多处调用,
//   全文级 `includes` 会被别处的接线喂饱 ⇒ 先按 `register('<路由>'` 切块再判。
{
  const src = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const blockOf = (route) => {
    const i = src.indexOf(`register('${route}'`);
    if (i < 0) return '';
    const j = src.indexOf('disposers.push(register(', i + 10);
    return src.slice(i, j < 0 ? src.length : j);
  };
  for (const ep of ['/persona/habits/scan', '/persona/habits/reflect']) {
    const b = blockOf(ep);
    check(b.length > 0, `A-1 前置:找得到 ${ep} 的 handler 块`);
    check(/if \(!gateSurgery\(req, res, sendJson, \{ unlock: body\.unlock \}/.test(b),
      `★A-1 手术门:${ep} 的 handler 里接了 gateSurgery(交办单判据①)`);
    check(/const body = JSON\.parse\(\(await readBody\(req\)\) \|\| '\{\}'\)/.test(b),
      `★A-1 手术门:${ep} **先解析 body、再判门**(请求流只能读一次 ⇒ 顺序反了门就拿不到 unlock)`);
    check(!/async \(_req, res\)/.test(b),
      `★A-1 手术门:${ep} 的 handler 必须收 req(改前是 _req ⇒ 根本读不到原句)`);
    check(b.includes(`endpoint: '${ep}'`), `★A-1 手术门:${ep} 把端点名传给留痕`);
  }
  // ⚠️ `surgery.js:34-49` 的**覆盖面清单**把 `/persona/genesis` 列为**第 11 条写面**(改后 = 过门),
  //   而 `api.js:2943` 也确实接了门 ⇒ 它**应该**过门。
  //   ⇒ 本断言原写成"它有意不过门"(照抄交办单 A-1 的建议),**现场重读推翻了那句话**:
  //     交办单说"genesis 不写人格 ⇒ 不计入写面,别顺手接上",但清单明确列它为第 11 条。
  //     以清单为准(它是唯一逐条列出的权威),已回告交办单作者。
  const g = blockOf('/persona/genesis');
  check(g.length > 0 && /gateSurgery/.test(g),
    '★A-1 清单对齐:/persona/genesis 是清单第 11 条写面 ⇒ 必须过门(交办单 A-1 那句"别顺手接上"与清单冲突,以清单为准)');
}

// ── 9.3c A-2(2026-10-05 夜):面板档必须带 sessionLine / deepDone ──────────────────────────
// 来源:`plans\HANDOFF-机制面复核交办单-20261005.md` §A-2 —— 交办单说「面板档**漏列** sessionLine,
//   而前端 client.js 有读」。**现场重读判定为误报**,但顺手把事实链钉成断言(将来真被挪走会红):
//   · 前端**发**:client.js 面板打开时发 `/state?…&l0Preview=1`;
//   · 后端**收**:api.js 的 `/state` handler 把 `q.get('l0Preview') === '1'` 传成 `l0Preview`;
//   · 面板档**给**:`stateFor` 的 l0Preview 分支里两个字段都在,且取值仍挂在 `l0Preview` 上;
//   · 前端**读**:client.js 读 `r.sessionLine`,而那个 `r` 就是面板档应答(`paintE3` 的注释逐字写着
//     "同一份面板档应答")。
//   ⇒ 误报来源是 client.js 那句**容错注释**("老后端 / 轮询档没有这一项 ⇒ null"):它在讲"万一拿到
//     不带它的应答也别崩",被读成了"前端在读轮询档"。断言只钉**事实链**,不钉注释措辞。
{
  const api = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const cli = readFileSync(join(root, 'lib/client.js'), 'utf8');
  const iLight = api.indexOf('if (!l0Preview) return light;');
  check(iLight > 0, 'A-2 前置:找得到「轮询档早退」那一句(分档的判据本体)');
  const panel = api.slice(iLight, iLight + 3000);   // 早退之后就是面板档那半
  check(/sessionLine:\s*l0Preview\s*\?/.test(panel),
    '★A-2 面板档带 sessionLine,且取值挂在 l0Preview 上(轮询档一个字节都不带)');
  check(/deepDone:\s*l0Preview\s*\?/.test(panel), '★A-2 面板档带 deepDone(同上)');
  check(/l0Preview:\s*q\.get\('l0Preview'\)\s*===\s*'1'/.test(api),
    '★A-2 /state 把 `l0Preview=1` 传成面板档标记(前端发的就是它)');
  check((cli.match(/r\.sessionLine/g) || []).length === 1,
    '★A-2 前端只有一处读 r.sessionLine(多处 = 有人把同一个字段接到了轮询档)');
  check(/function paintE3\(r, cur, fmtClock\)/.test(cli) && cli.includes('l0Preview: \'1\''),
    '★A-2 读它的 r 来自 paintE3,而面板那条请求带 l0Preview=1');
}

// ── 9.4 C(审计建议):POST_ONLY 差集**快照护栏** ─────────────────────────────────────────────
// 这是**快照,不是白名单**:它把"截至本次改动,哪些已注册端点不在 POST_ONLY 里"逐条钉住,
// 好让**将来新增/删除端点时断言变红**,逼后来者**有意识地**回答一句:"这条是写面吗?"
// ⚠️ 变红时**该做的是判断**,不是无脑把路径抄进下面的数组:
//    · 新端点确实是写面 / GET 就能改状态 / GET 就能花钱 ⇒ 把它加进 **api.js 的 POST_ONLY 声明**,
//      差集**不会**因此变红(它本来就该从差集里消失);
//    · 新端点确实是纯读 ⇒ 把它加进下面的数组,并在同一行写一句"为什么它可以在 POST_ONLY 之外";
//    · 删掉了端点 ⇒ 从数组里删掉;**数与列表必须同批改**(否则数字与列表会互相说谎)。
// 判据来源:`plans\AUDIT-dsh-ling-1.5.3-端点写面-未进POST_ONLY.md`(逐条读过 handler 的那份审计)。
{
  const POST_ONLY_ROUTES_TOTAL = 79;   // 已注册端点数(disposers.push(register('…')))
  const POST_ONLY_SET_SIZE = 55;       // POST_ONLY 集合条数
  const POST_ONLY_DIFF_SNAPSHOT = [
    '/surgery/events',            // 事后日志(读手术门留痕),GET 不写
    '/health',
    '/memories/sources',
    '/branches',
    '/tree',
    '/branch-log',
    '/conflicts',
    '/tree/autobuild/preview',
    '/tree/snapshots',
    '/vein/suggestions',
    '/branch/members',
    '/memories',
    '/assistant/config',          // 同路径 GET/POST:写只在 POST 分支内(自带方法校验,差集里唯一的正面样本)
    '/state',                     // 内存型:?sessionId= 会建 gate 空壳(基数上限见 9.2)
    '/persona/history',
    '/persona/rules',
    '/import/history',
    '/deep/run-status',
    '/dsweb/summary/preview',     // 资源型:只读打开源库 + 出网探活(路径白名单见 9.3)
    '/dsweb/summary/status',
    '/feedback',
    '/suggestions',
    '/deep/status',
    '/export',                    // 资源型:序列化 bundle(?includeRaw=1 含原文,响应体很大)
  ];
  const setBlock = apiSrc.match(/const POST_ONLY = new Set\(\[([\s\S]*?)\]\);/);
  const postOnly = [...String(setBlock && setBlock[1] || '').replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const routes = [...apiSrc.matchAll(/disposers\.push\(register\('([^']+)'/g)].map((m) => m[1]);
  const diff = routes.filter((p) => !postOnly.includes(p));
  check(!!setBlock, 'C 护栏:POST_ONLY 声明块能被解析(源码形状没被改写)');
  check(routes.length === POST_ONLY_ROUTES_TOTAL,
    '★C 已注册端点数 = ' + POST_ONLY_ROUTES_TOTAL + '(实测 ' + routes.length + ';数变了 ⇒ 有人加/删了端点,请看本段注释"变红时该做什么")');
  check(postOnly.length === POST_ONLY_SET_SIZE,
    '★C POST_ONLY 条数 = ' + POST_ONLY_SET_SIZE + '(实测 ' + postOnly.length + ')');
  check(JSON.stringify(diff) === JSON.stringify(POST_ONLY_DIFF_SNAPSHOT),
    '★C 差集快照逐条相等(实测 ' + diff.length + ' 条:' + diff.join(' ') + ')');
  check(postOnly.every((p) => routes.includes(p)),
    'C 护栏:POST_ONLY 里没有"注册表里不存在"的路径(把路径名打错会在这里红)');
}

// ── 9.5 E2 可见化(2026-10-01):未知原文来源的**读面**与**前台那一句** ─────────────────────────
// 上一版(E2)把「未知来源的原文」从**被误信**改成**被排除**,但留痕只落在 kv 键里 —— 可查,主人看不见。
// 主人拍板:「E2 告诉前台到底发生啥了就行,加吧」。这一段钉的是那句话**走到前台**这条链的形状:
//   · 取数**唯一一处**(将来再加读面必须复用 helper —— 两份取数必然漂,漂了就有一份在说谎);
//   · 新字段**另起**(顶层,与 audit 平级;audit 是访问日志的固定形状契约,不许寄生);
//   · **干净时整个字段不出现**(零空壳)⇒ 既有应答体逐字不变(端点级负对照在 branch.test.mjs §7.10);
//   · 前台**不拆字段自己拼**(人话只有后端一处拼法),且字段缺失 ⇒ 一个字符都不渲染。
// ⚠️ 这里全是**源码级**形状护栏(不跑服务);"响应体逐字不变"由 §7.10 的真调端点证明,两者互补。
{
  const csrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
  const n = (re, s) => [...s.matchAll(re)].length;
  const KV_READ = /memory\?\.kvGet\?\.\(RAW_UNKNOWN_NS_KEY\)/g;

  // ① 读出 = **唯一一个 helper**(冒出第二个取数点 ⇒ 这里红)
  check(n(KV_READ, apiSrc) === 1, 'E2 护栏:kv 告警键只在 helper 里读**一次**(实测 ' + n(KV_READ, apiSrc) + ' 处)');
  check(n(/const rawUnknownSourcesOf = \(\) => \{/g, apiSrc) === 1, 'E2 护栏:取数 helper 只定义一次');
  // 名字共两处:定义一次 + helper 里调一次(**没有第二处调用** ⇒ 没有第二个拼法)
  check(n(/rawUnknownSourcesText\(/g, apiSrc) === 2 && n(/function rawUnknownSourcesText\(/g, apiSrc) === 1,
    'E2 护栏:人话结论只在一处拼(定义 1 处 + 调用 1 处;实测 名字共 '
    + n(/rawUnknownSourcesText\(/g, apiSrc) + ' 处、定义 ' + n(/function rawUnknownSourcesText\(/g, apiSrc) + ' 处)');
  {
    const { readdirSync } = await import('node:fs');
    const libFiles = [join(root, 'lib/client.js'), join(root, 'lib/index.js')]
      .concat(readdirSync(join(root, 'lib/host')).map((f) => join(root, 'lib/host', f)));
    const dup = libFiles.filter((f) => /const rawUnknownSourcesOf = \(\) => \{|function rawUnknownSourcesText\(/.test(readFileSync(f, 'utf8')));
    check(dup.length === 1 && dup[0].endsWith('api.js'),
      'E2 护栏:整包 lib 里只有 api.js 定义这两个名字(将来"顺手复制一份取数"要在这里红;实测 '
      + (dup.map((f) => f.replace(root, '')).join(' ') || '(零处!)') + ')');
  }

  // ② 新字段**另起**、老字段**逐字未动**、干净时**没有空壳**
  check(n(/\.\.\.\(rawUnknown \? \{ rawUnknownSources: rawUnknown \} : \{\}\)/g, apiSrc) === 3,
    'E2 护栏:三个挂点(/health + /state 两档)**全是条件展开**(干净 ⇒ 字段整个不出现,不是 null / {})');
  check(n(/audit: auditHealth\(\)/g, apiSrc) === 3, 'E2 护栏:老字段 audit 的三处取值表达式逐字未动');
  check(n(/return accessLogStatus\(\{ enabled: al\?\.enabled \}\);/g, apiSrc) === 1 && !/accessLogStatus\([^)]*rawUnknown/i.test(apiSrc),
    'E2 护栏:audit 的形状仍只有一个来源(accessLogStatus),新字段没有寄生进 audit 块');
  check(/ok: true, plugin: 'dsh-ling', version: config\.version, audit: auditHealth\(\),\n\s*sessionLine: sessionLineProbe\(memory, \{ limit: 8 \}\),\n\s*\.\.\.\(rawUnknown/.test(apiSrc),
    'E2 护栏:/health 老键的顺序与取值逐字未动,新键只追加在**最后**');

  // ③ 前台:字段缺失 ⇒ 静默;人话原样印,不拆字段
  check(/patch\.rawUnknownSources = r\.rawUnknownSources \|\| null;/.test(csrc),
    'E2 前台护栏:字段搬进 store(显式归零 ⇒ 告警消失后不会留一句过期的话)');
  check(/if \(ru && ru\.text\) lines\.push\('⚠ ' \+ ru\.text/.test(csrc),
    'E2 前台护栏:没有告警(字段缺失 / 老后端)⇒ 一个字符都不渲染');
  check(n(/ru\.ns|namespaces\[|rawUnknownSources\.namespaces/g, csrc) === 0,
    'E2 前台护栏:前台不拆字段自己拼(人话只有后端一处拼法;实测 '
    + n(/ru\.ns|namespaces\[|rawUnknownSources\.namespaces/g, csrc) + ' 处)');
}

console.log(ok ? '/api 守卫(加固 ①+②+③+④+⑤)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
