// dsh-ling host — /api 守卫(2026-09-16 加固 ①+②;此前只校验 cookie **名字的形状**,等于没锁)
//
// ① 来源栅栏(复刻 DSH 自己的 isTrustedApiRequest 三条判定):
//    - Host 必须是 loopback(127.0.0.0/8 / ::1 / localhost),或**用户显式声明**的 trustedHosts;
//      → 防 DNS rebinding:浏览器被恶意页诱导连到本机端口时,Host 是攻击者的域名,过不了这一关
//    - `sec-fetch-site: cross-site` 直接拒(恶意页面发起的跨站请求)
//    - 带 Origin 时,其 host 必须等于请求的 Host(同源)
// ② 名字对撞:期望 cookie 名 = 'dsh-auth-' + base64url(sha256(规范化 Host)) —— 与 DSH 同源同法;
//    浏览器为"你正在访问的这个 authority"发的正是这个名字,所以本地/远端登录都天然通过,而
//    "随手编一个 dsh-auth-x=1"的脚本过不了。
//
// 不校验 cookie 值的 HMAC 签名:那需要读 DSH 的凭据库,跨版本易碎;② 已挡住非浏览器伪造。
//
// ③ 加固(2026-09-17,G1):**本机 LAN 地址不再自动信任**。
//    旧实现在 ① 里把 lanAddresses() 无条件并入受信集,而 ② 只判 cookie 名字不判值 ⇒ 同网段任何设备
//    只要 Host 填本机 LAN IP、cookie 名按 Host 现算(算法是公开的)、值随便填,即可 200 拿到
//    /state(人格档案全文)与 /memories(真实会话标题摘要)。名字对撞挡的是"随手编一个",挡不住"照算法算一个"。
//    现在:默认只信 loopback;要开局域网访问,必须在 settings.guard 里**显式**写 trustedHosts(单个地址)
//    或 allowLan:true(整段 LAN)。本机进程仍可伪造(它本来就能直接读 settings.json 与记忆库,不构成提权);
//    这一步关掉的是"同网段设备 → 人格与记忆"这条不需要任何凭据的通道。
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
 * 反向代理追加的**真实对端地址**(2026-09-30 加固⑤;判据与对照实验见 `tests\guard.test.mjs` 第 8 段「反代场景加固⑤」)。
 *
 * nginx 的 `$proxy_add_x_forwarded_for` = `$http_x_forwarded_for`, `$remote_addr`
 * ⇒ **最后一段永远是 nginx 亲自追加、客户端无法影响的地址**(客户端伪造只能污染前面的段)。
 * 无 XFF 时回退 `X-Real-IP`(同样是 nginx 亲自设置)。
 *
 * ⚠️ **不许"优化"成取第一段** —— 取首段时,攻击者只要自己先塞一句
 * `X-Forwarded-For: 127.0.0.1`,整条判据立刻失效(同段「攻击②」有逐行对照)。
 */
export function realPeerAddress(headers) {
  const xff = headerOf(headers, 'x-forwarded-for');
  if (typeof xff === 'string' && xff.trim() !== '') {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const real = headerOf(headers, 'x-real-ip');
  return typeof real === 'string' && real.trim() !== '' ? real.trim() : undefined;
}

/**
 * 判定一次 /api 请求是否放行。
 * @param {object} headers 请求头
 * @param {{trustedHosts?: string[], allowLan?: boolean}} [opts] 额外受信 authority(loopback 之外)
 *   trustedHosts: 用户显式声明的 authority 列表;allowLan: 显式信任本机全部 LAN 地址(默认 false)
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkRequest(headers, { trustedHosts = [], allowLan = false } = {}) {
  const host = headerOf(headers, 'host');
  if (!host) return { ok: false, reason: 'no-host' };
  const hostUrl = parseAuthority(host);
  if (!hostUrl) return { ok: false, reason: 'bad-host' };

  const loopbackHost = isLoopbackHostname(hostUrl.hostname);

  // ── 2026-09-30 加固⑤(反代场景):**loopback 免检只对"真的来自本机"的请求成立** ──────────
  // 沿革:旧代码"Host 长得像 loopback 就直接短路跳过受信名单",这条假设在**引入反向代理之后失效** ——
  // nginx 的 `proxy_set_header Host $http_host` 把 Host 变成**客户端的自我声明**,
  // 而 cookie 那边只校验**名字**(名字是 `sha256(authority)` 的公开派生,客户端自算即可)⇒
  // 「伪造 Host: 127.0.0.1:3080 + 自算 cookie 名」曾构成一条**不需要任何凭据**的公网通路。
  // 判据:反向代理**一定会追加** XFF/X-Real-IP(`$proxy_add_x_forwarded_for` 把真实对端**追加在最后一段**),
  //   所以"带着代理头、却声称自己是 loopback"= 伪造 ⇒ 拒。**无代理头的本机直连照旧免检**(见 §六 回归表)。
  if (loopbackHost) {
    const peer = realPeerAddress(headers);
    if (peer !== undefined && !isLoopbackHostname(peer)) {
      return { ok: false, reason: 'spoofed-loopback-host' };
    }
  }

  // 2026-09-17 加固③(G1):LAN 地址只在显式 allowLan 时才进受信集(旧版无条件并入,是整个 P0 的根)
  const trusted = allowLan ? [...lanAddresses(), ...trustedHosts] : trustedHosts;
  if (!loopbackHost && !isTrustedAuthority(hostUrl, trusted)) {
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

// ── ④ 字段白名单(2026-09-17,G10)────────────────────────────────────────────────
// POST /persona 把 body 深合并进 settings.json,而 mergeDeep 不做键过滤 —— 于是
// `{"guard":{"enforce":false}}` 能**持久化关停上面这套守卫**(且不触发定型门),
// 与"只判 cookie 名"串成一条自我关停的提权链。这里把补丁收窄到 persona / styles
// 两棵子树及其已知子键;其余一律丢弃并回报(不静默)。
/** persona 子树里允许经 /persona 写入的键(= DEFAULT_SETTINGS.persona 的全部字段)。 */
export const PERSONA_PATCH_KEYS = Object.freeze([
  'enabled', 'userTitle', 'aiName', 'aiTitle', 'language', 'pronoun',
  'tone', 'toneWork', 'toneLife',
  'hardRules', 'ruleMeta', 'habits', 'habitsPending', 'bottomLines',
  'sealed', 'sealPhrase', 'extraLore', 'duty',
]);
/** styles 子树里允许写入的键(两模式各一条风格)。 */
export const STYLE_PATCH_KEYS = Object.freeze(['work', 'life']);

/**
 * 把一份人格补丁收窄成"只能落在 persona / styles 子树里"的安全补丁。
 * @param {unknown} patch 待写入的补丁(通常是 body.patch)
 * @returns {{ clean: object, dropped: string[] }} clean = 可安全交给 settings.update 的补丁;
 *   dropped = 被丢弃的键路径(用于日志与响应,便于察觉误用或攻击尝试)
 */
export function sanitizePersonaPatch(patch) {
  const clean = {};
  const dropped = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { clean, dropped };
  const pick = (obj, allowed, prefix) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (allowed.includes(k)) out[k] = v;
      else dropped.push(prefix + k);
    }
    return out;
  };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'persona' && v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = pick(v, PERSONA_PATCH_KEYS, 'persona.');
      if (Object.keys(sub).length) clean.persona = sub;
    } else if (k === 'styles' && v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = pick(v, STYLE_PATCH_KEYS, 'styles.');
      if (Object.keys(sub).length) clean.styles = sub;
    } else {
      dropped.push(k);
    }
  }
  return { clean, dropped };
}

// ── ⑤ 后台行为补丁白名单(2026-10-16)──────────────────────────────────────────────
// 与 ④ 同一纪律、同一原因:`POST /auto` 也把 body 交给 `settings.update`(深合并,**不做键过滤**)
// ⇒ 不设白名单就等于给了一条新旁路 —— 拿 `/auto` 往 settings.json 里写 `guard.enforce:false` 或
// 整棵 persona(④ 那次堵的正是这条链)。故:只有下面 5 个键能出这个函数。
// 额外收窄(比 ④ 更严):**只收扁平对象**。auto 子树没有嵌套语义,接受嵌套/数组纯粹是给原型污染留门
// (`{"__proto__":{…}}` 经深合并会落到 Object.prototype 上,那是全进程级污染,不是一个设置项)。
/** auto 子树里允许经 /auto 写入的键(= DEFAULT_SETTINGS.auto 的全部字段)。 */
export const AUTO_PATCH_KEYS = Object.freeze([
  'deepSummary', 'deepIntervalMin', 'deepMaxPerRun', 'bootProbeDelayMs', 'feedbackAuto',
]);
/** 布尔键(其余三个是数字键:类型不符一律丢弃,不猜用户想说什么)。 */
export const AUTO_BOOL_KEYS = Object.freeze(['deepSummary', 'feedbackAuto']);
/** 数字键的合法区间 [lo, hi]:**唯一定义处** —— sanitizeAutoPatch(写面)与 resolveAuto(读面)同取这一份,
 *  两处各写一遍迟早会漂成"写得进 5、读出来 10"这种自相矛盾的设置。 */
export const AUTO_NUMBER_RANGES = Object.freeze({
  deepIntervalMin: Object.freeze([10, 1440]),
  deepMaxPerRun: Object.freeze([1, 20]),
  bootProbeDelayMs: Object.freeze([0, 600000]),
});

/**
 * 把一份「后台行为」补丁收窄成"只能落在这 5 个白名单键上"的安全扁平补丁。
 * @param {unknown} patch 待写入的补丁(通常是 body.patch,也接受 body 本身)
 * @returns {{ clean: object, dropped: string[], clamped: string[] }} clean = 可交给 settings.update 的补丁;
 *   dropped = 被丢弃的键(白名单外 / 类型不符 / 整个 body 不是普通对象);
 *   clamped = 被夹取到区间的键(用于如实回报"你填的值没被原样采纳")
 */
export function sanitizeAutoPatch(patch) {
  const clean = {};
  const dropped = [];
  const clamped = [];
  // 数组与 null 都不是补丁(数组的 Object.entries 会给出 "0"/"1" 这类下标键,没有语义)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { clean, dropped, clamped };
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(AUTO_NUMBER_RANGES, k)) {
      // 布尔键:只收真正的布尔;字符串 "false" 不猜(猜错方向 = 悄悄关掉一个后台行为)
      if (AUTO_BOOL_KEYS.includes(k)) {
        if (typeof v === 'boolean') clean[k] = v;
        else dropped.push(k);
        continue;
      }
      dropped.push(k);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) { dropped.push(k); continue; }
    const [lo, hi] = AUTO_NUMBER_RANGES[k];
    const c = Math.min(hi, Math.max(lo, v));
    clean[k] = c;
    if (c !== v) clamped.push(k);
  }
  return { clean, dropped, clamped };
}

// ── ⑥ 注入面开关补丁白名单(1.7.3)─────────────────────────────────────────────────
// 与 ④/⑤ 同一纪律、同一原因:`POST /inject` 也把 body 交给 `settings.update`(深合并,**不做键过滤**)
// ⇒ 不设白名单就等于又开一条旁路:拿 `/inject` 往 settings.json 里写 `guard.enforce:false` 或整棵 persona。
// 1.7.3 新增的唯一写面键:`inject.memoryEnabled`(记忆与图书馆的**注入面**:L1 记忆段 + 深层库 +
//   树改动播报 + 后台自动深摘/反馈成长)。
//   ⚠️ 它**不**管工具面:11 件记忆/图书馆工具照旧注册(2026-10-27 主人拍板「要剥离工具的只有子代理」)。
//      记错这一条会让人以为"关了就没工具",而实际关掉的是"注不注入、后台写不写"。工具面的闸在
//      `agent-tools.js` 的 `bindOne()`(只对子代理),与本键无关。
//   · 人格开关**不在这里** —— 它仍是既有的 `persona.enabled`,写面仍是 `/persona`
//     (手术门与定型判据都在那条路上);在这里再开一次 = 同一件事两条写入口,迟早漂成两个答案。
//   · 只收**真布尔**:字符串 "false" 不猜 —— 猜错方向 = 悄悄关掉主人的记忆注入。
// 1.7.3 夜(2026-10-27)追加第二个键:`away`(在场/暂离)。
//   它**不是**"第三个零件"——恰恰相反:它一开就压过 `persona.enabled` 与 `memoryEnabled`,
//   四处(人格段/记忆段/记忆工具/后台与入库)由同一条判据派生 ⇒ 两个旧键退成底层细档,
//   "人格开 + 记忆关"那种不是人的组合在状态机里不再可达。
//   ⚠️ 它**故意不走 `/persona`**:定型锁保护"她是谁不被改",离场是主人随时可拨的可逆动作。
/** inject 子树里允许经 /inject 写入的键。 */
export const INJECT_PATCH_KEYS = Object.freeze(['memoryEnabled', 'away']);

/**
 * 把一份「注入面」补丁收窄成"只能落在白名单布尔键上"的安全扁平补丁。
 * @param {unknown} patch 待写入的补丁(通常是 body.patch,也接受 body 本身)
 * @returns {{ clean: object, dropped: string[] }} clean = 可交给 settings.update 的补丁;
 *   dropped = 被丢弃的键(白名单外 / 类型不符 / 整个 body 不是普通对象)
 */
export function sanitizeInjectPatch(patch) {
  const clean = {};
  const dropped = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { clean, dropped };
  for (const [k, v] of Object.entries(patch)) {
    if (!INJECT_PATCH_KEYS.includes(k)) { dropped.push(k); continue; }
    if (typeof v !== 'boolean') { dropped.push(k); continue; }
    clean[k] = v;
  }
  return { clean, dropped };
}
