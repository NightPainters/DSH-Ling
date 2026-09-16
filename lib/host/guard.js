// dsh-ling host — /api 守卫(2026-09-16 加固 ①+②;此前只校验 cookie **名字的形状**,等于没锁)
//
// ① 来源栅栏(复刻 DSH 自己的 isTrustedApiRequest 三条判定):
//    - Host 必须是 loopback(127.0.0.0/8 / ::1 / localhost),或本机 LAN 地址 / 用户声明的 trustedHosts;
//      → 防 DNS rebinding:浏览器被恶意页诱导连到本机端口时,Host 是攻击者的域名,过不了这一关
//    - `sec-fetch-site: cross-site` 直接拒(恶意页面发起的跨站请求)
//    - 带 Origin 时,其 host 必须等于请求的 Host(同源)
// ② 名字对撞:期望 cookie 名 = 'dsh-auth-' + base64url(sha256(规范化 Host)) —— 与 DSH 同源同法;
//    浏览器为"你正在访问的这个 authority"发的正是这个名字,所以本地/远端登录都天然通过,而
//    "随手编一个 dsh-auth-x=1"的脚本过不了。
//
// 不校验 cookie 值的 HMAC 签名:那需要读 DSH 的凭据库,跨版本易碎;② 已挡住非浏览器伪造。
// 逃生开关:环境变量 DSH_LING_GUARD=off,或 settings.guard.enforce = false(误判时不会把人锁在门外)。
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/** 取头部值(兼容 Node IncomingMessage.headers 与 Fetch Headers)。 */
export function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[String(name).toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/** 把 Host 头解析成规范化 URL(hostname 小写、默认端口剥离、IPv6 加括号);不可解析返回 undefined。 */
export function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
}

/** loopback 判定:localhost、::1、以及 127.0.0.0/8 全部(与 DSH 同口径)。 */
export function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const parts = h.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 规范化后的 authority:`hostname`(无端口)或 `hostname:port`。 */
export function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/** trustedHosts 条目匹配:带端口 → 精确匹配 authority;不带端口 → 匹配该主机名的任意端口。 */
export function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts || []).some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === undefined) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host;
  });
}

/** 本机各网卡的 IPv4 地址(与 DSH 的 lanAddresses 同思路:LAN 直连时 Host 是 IP 字面量,域名伪造不了它)。 */
export function lanAddresses() {
  const out = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni && ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch { /* 取不到就当没有 */ }
  return out;
}

/** 规范化后的请求 authority(cookie 名与同源判定都用它)。 */
export function requestAuthority(headers) {
  const host = headerOf(headers, 'host');
  if (!host) return undefined;
  const url = parseAuthority(host);
  return url ? url.host : undefined;
}

export function encodeBase64Url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** 期望的会话 cookie 名(与 DSH 的 cookieName() 逐字同法)。 */
export function expectedCookieName(authority) {
  return 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(String(authority)).digest());
}

/** 从 Cookie 头里读出**确切名字**的那条并去空格(与 DSH 的 cookieValue() 同法)。 */
export function cookieValueOf(cookieHeader, name) {
  for (const seg of String(cookieHeader || '').split(';')) {
    const at = seg.indexOf('=');
    if (at === -1 || seg.slice(0, at).trim() !== name) continue;
    return seg.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * 判定一次 /api 请求是否放行。
 * @param {object} headers 请求头
 * @param {{trustedHosts?: string[]}} [opts] 额外受信 authority(除 loopback 与 LAN 之外)
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkRequest(headers, { trustedHosts = [] } = {}) {
  const host = headerOf(headers, 'host');
  if (!host) return { ok: false, reason: 'no-host' };
  const hostUrl = parseAuthority(host);
  if (!hostUrl) return { ok: false, reason: 'bad-host' };
  const trusted = [...lanAddresses(), ...trustedHosts];
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trusted)) {
    return { ok: false, reason: 'untrusted-host' };
  }
  if (headerOf(headers, 'sec-fetch-site') === 'cross-site') return { ok: false, reason: 'cross-site' };
  const origin = headerOf(headers, 'origin');
  if (origin !== undefined) {
    let same = false;
    try { same = new URL(origin).host === hostUrl.host; } catch { same = false; }
    if (!same) return { ok: false, reason: 'origin-mismatch' };
  }
  const authority = hostUrl.host;
  const value = cookieValueOf(headerOf(headers, 'cookie'), expectedCookieName(authority));
  if (value === undefined) return { ok: false, reason: 'no-cookie' };
  if (!value) return { ok: false, reason: 'empty-cookie' };
  return { ok: true, reason: 'ok' };
}
