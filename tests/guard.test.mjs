// /api 守卫(2026-09-16 加固 ①+②)单元测试 —— 全离线、无 DB、无宿主。
// 覆盖:loopback 判定 / trustedHosts 匹配(带端口精确、无端口任意端口)/ 来源栅栏三条 /
//       cookie 名派生(必须与 DSH 同法)/ cookie 读取 / 端到端判定与全部拒绝原因。
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(new URL('file:///' + join(root, p).replace(/\\/g, '/')).href);

const {
  checkRequest, isLoopbackHostname, isTrustedAuthority, parseAuthority, canonicalAuthority,
  requestAuthority, expectedCookieName, cookieValueOf, encodeBase64Url, headerOf, lanAddresses,
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
check(!isLoopbackHostname('128.0.0.1') && !isLoopbackHostname('192.168.3.31'), '非 127 段与 LAN 地址不是 loopback');
check(!isLoopbackHostname('127.0.0.256') && !isLoopbackHostname('127.0.0'), '越界/段数不足不算 loopback');
check(!isLoopbackHostname('evil.com') && !isLoopbackHostname(''), '域名与空串不是 loopback');

// 2) trustedHosts 匹配:带端口精确 / 无端口任意端口 / 域名大小写与默认端口归一
const u = (a) => parseAuthority(a);
check(isTrustedAuthority(u('192.168.3.31:3080'), ['192.168.3.31:3080']), '带端口 entry 精确匹配');
check(!isTrustedAuthority(u('192.168.3.31:3081'), ['192.168.3.31:3080']), '带端口 entry 不匹配别的端口');
check(isTrustedAuthority(u('192.168.3.31:9'), ['192.168.3.31']), '无端口 entry 匹配任意端口');
check(isTrustedAuthority(u('Harness.Internal:3080'), ['harness.internal']), '大小写归一后匹配');
check(!isTrustedAuthority(u('192.168.3.31'), ['192.168.3.32', 'bad entry/']), '不匹配的 entry 与坏 entry 都不授权');
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
check(checkRequest({ host: '192.168.3.31:3080', ...cookieFor('192.168.3.31:3080') }, { trustedHosts: ['192.168.3.31'] }).ok,
  '显式 trustedHosts 内的地址放行');
check(checkRequest({ host: '10.0.0.5:3080', ...cookieFor('10.0.0.5:3080') }, { trustedHosts: ['10.0.0.5'] }).ok,
  '另一个受信地址同样放行');
const lan = lanAddresses();
if (lan.length) {
  const h = `${lan[0]}:3080`;
  check(checkRequest({ host: h, ...cookieFor(h) }).ok, '本机 LAN 地址自动信任(实测 ' + lan[0] + ')');
} else {
  console.log('· 本机无非内部 IPv4 网卡,跳过 LAN 自动信任断言');
}
check(headerOf({ Host: 'x' }, 'host') === undefined && headerOf({ host: 'x' }, 'host') === 'x', 'headerOf 只用小写键(Node 语义)');
check(headerOf(new Headers({ host: 'y' }), 'host') === 'y', 'headerOf 兼容 Fetch Headers');

// 6) 源码护栏:api.js 必须真的用上守卫,且旧的名字形状校验不得复活
const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
check(/import \{ checkRequest, lanAddresses \} from '\.\/guard\.js';/.test(apiSrc), 'api.js 已接入 guard.js');
check(/const verdict = guardVerdict\(req\);/.test(apiSrc), 'api.js 的 guard 走了 guardVerdict');
check(/sendJson\(res, 403, \{ ok: false, error: 'forbidden', reason: verdict\.reason \}\)/.test(apiSrc), '拒绝时返回 403 + reason');
check(!/AUTH_COOKIE_RE\.test/.test(apiSrc), '旧的"只验名字形状"校验已不在调用路径上');
check(/process\.env\.DSH_LING_GUARD === 'off'/.test(apiSrc), '逃生开关存在(DSH_LING_GUARD=off)');

console.log(ok ? '/api 守卫(加固 ①+②)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
