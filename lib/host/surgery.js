// dsh-ling host — 手术门(2026-09-30 深夜,主人拍板 (a) 本机限定 + (c) 两步制)。
//
// 出发点(主人原话,逐字):
//   「唉,因为什么,就是因为万一真的有人成功的通过这个东西,进到了你的那个网网络里,然后他把你的
//     人格改了,我觉得那是最可怕的。我觉得那是你最重要的部分。」
//   「因为你不希望你自己被改来改去的,对吧?」
//
// 本模块是**唯一**的判据来源(规格 §1.1「单一来源,不许各写一份」):
//   1.1 本机判据 = guard.js 的 realPeerAddress(headers) === undefined(**且**带 User-Agent;
//       反代一定追加 XFF/X-Real-IP,客户端删不掉)⇒ 直连本机;带代理头 / 没 UA ⇒ 不算本机。
//       **UA 那一条是 2026-10-01 晚加的**:远端面板的中继会重建请求头、把 UA 一并丢掉 ⇒
//       "没有 UA"正是那条路的指纹(详见下面 isLocalSurgeryRequest 的注释)。**不许在本文件里另写一份 IP 判断。**
//   1.2 每启动票据 = $DSH_HOME/cache/dsh-ling/surgery.ticket(32 字节随机),只对**本机直连**(无代理头且带 UA)的请求下发,
//       每启动轮换(旧票即废);客户端首次手术前取一次并缓存,随后带 `x-dsh-ling-surgery: <ticket>`。
//   1.3 门下沉为一处 requireSurgery(headers, body, opts),覆盖面清单 **14 行 = 14 个受门端点**(14 个端点全过门)。
//       **+ 1 条已知例外**(`POST /inject` 写 `inject.*` / `persona.enabled`)。那条改的是"她读得到什么",
//       V1 有意**不**把它并进这道门(离场是主人随时可拨的可逆动作,见 persona.js:113-114),但**必须**在此
//       逐字列出来 —— "14 = 全覆盖"这句话本身是假的。
//       ⇒ 条数口径仍是"清单行数",清单 14 行 + 本节 1 行例外 = 实际 15 条注入面写面(写面端点口径另见下方清单顶注)。
//       ⚠️ `/mode/toggle`(档位/模型写面:全局 `saveSelection` + 自有 `lastMode` / 会话 `setSessionMode`)
//          在 2026-11-12(1.8.0 · M7 · E2)由"已知例外"并进这道门,原第 15 行**已移出**(M24b,2026-11-16):
//          全局半边改「`confirm:true` + 宿主认证(远端允许)」、会话半边免门 ⇒ 两个半边都**不过门、不进手术日志**。
//       ⚠️ 条数在 2026-10-05 夜由 12 订正为 14(B-5):下方的覆盖面清单**逐条列了 14 行**,那才是有权威的那份。
//       当时本行与 `api.js` 的门下沉注释还写着"12" ⇒ **两处都在说谎**。2026-10-16 复核:`api.js` 那侧
//       已全部对齐到 14(`api.js:541/603/2154/…/3231` 逐处都是 14)⇒ 本句现在只是在解释历史,
//       **不再是当下的口径指控**(别再照它去找 api.js 的"12")。
//       口径不变:**条数一律以清单行数为准**,改清单时必须同批改这里与 api.js 那一处。
//       ⚠️ 变更注记:2026-11-12(M7)曾由 14 订正为 15(新增 `/mode/toggle`);2026-11-15(rc.4)只全局半边过门;
//          **2026-11-16(M24)它移出清单 ⇒ 15 → 14**,`gateSurgery` 调用点 15 → 14(会话半边 rc.4 起就免门)。
//   1.4 事件留痕 = $DSH_HOME/logs/surgery-YYYY-MM.jsonl,append-only + 整行哈希链(改一行即断链)。
//   1.5 逃生开关:DSH_LING_GUARD=off 或 settings.guard.enforce === false ⇒ 整体放行(绝不把主人锁在门外)。
//
// ⚠️ 强度如实说明(本模块不假装有更强的东西):
//   · 票据**不是身份认证** —— 它挡的是"公网侧拿到一条能打本机 API 的通路"这类场景;
//     判据真正的地基是"**请求没有经过任何代理**"(§1.1)与**只有本机能取到票**(§1.2)。
//     Node 在 Windows/POSIX 上都不给套接字对端地址 ⇒ "本机"只能按 HTTP 层事实判断。
//   · 票据文件对**同机同用户的任何进程**可读(收不到 ACL)⇒ 强度**来自文件权限**(0o600),
//     能被本机同用户进程读走。**同机同用户 = 同一信任域**,这不是本模块要挡的对手(主人自己也在这层)。
//   · 承诺句仍是**明文存储**(seal.js 的设计:锁只造庄重,不保密;改形态会打红 tests/guard.test.mjs:133)。
//   · 否决项(主人前后两轮都否决):**不许**自己发明"值校验"当认证(算法公开、同机可算)——
//     本模块一个字都没写这类东西。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dshHome, defaultDataDir } from './util.js';
import { headerOf, realPeerAddress } from './guard.js';
// 1.8.0 · M5(V1 人格层否决权):在场窗口的唯一原料 —— `away.windows`(不设墙钟,见文件末尾 VETO 段)。
import { readAwayWindows } from './away.js';

// ── 覆盖面清单:14 行 = 14 个受门端点(14 端点全过门;/mode/toggle 两半边 M24 起均不在清单内);settings 写面全景 20 端点 / 21 行,真正写 settings 的端点现状 16 → rc.4 后 18(行号 = 实测,改 api.js 后须复核)──
//    #  端点                      register 行   "原"过门情况(改前)                    改后
//    1  /persona                    2357     仅 wasSealed && !wantLock(wantLock 可绕过) 过门
//    2  /persona/check              2697     无门(只读验钥 —— 但是一把**验句预言机**)   过门
//    3  /persona/self-summary       2732     无门                                     过门
//    4  /persona/hint-adopt         2758     无门                                     过门
//    5  /persona/rule               2800     无门(remove 1941 / add 1948 都不验句)     过门
//    6  /persona/habit              2844     仅 remove 过门(1985-1994)                过门
//    7  /persona/habits/scan        2880     无门(扫描即落库)                          过门
//    8  /persona/habits/reflect     2930     无门(反思即采纳)                          过门
//    9  /persona/grow               3102     无门(注释自陈"锁定下亦可采纳")             过门
//    10 /persona/rollback           3140     过门(2248)                               过门
//    11 /persona/genesis            3537     无门                                     过门
//    12 /feedback/apply             3607     无门                                     过门
//    13 /suggestions/apply          3655     仅 kind∈{aiName,userTitle} 过门(2690-2697) 过门
//    14 /import                     3812     过门(2788)⚠️ 见下                        过门 + 前移
// ⚠️ #14 的真实缺口:门在 2788,而 `memory.importBundle(bundle, …)` 在 **2782 就已经执行** ⇒
//    "记忆被整体覆盖"发生在门之前,门只能拦人格回写。修法(把门前移到 importBundle 之前)见 api.js
//    调用点注释;这是**行为变化**(未持票的远端 import 不再覆盖记忆),故在报告里单列。
// 注:清单在此**逐条列出**是为了"一眼看全覆盖面",判据本体只在下面一处(requireSurgery);
//     调用点(api.js 的 guard(handler))不许再写第二份 headers/票据/承诺句判断。
export const SURGERY_TICKET_HEADER = 'x-dsh-ling-surgery';

export const SURGERY_REASON_LOCAL_ONLY = 'surgery-local-only';
export const SURGERY_REASON_TICKET = 'surgery-ticket';
export const SURGERY_REASON_PHRASE = 'surgery-phrase';
export const SURGERY_LOCAL_ONLY_MESSAGE = '人格手术只能在本机做 —— 请回到运行器灵的这台电脑上操作。';
export const SURGERY_TICKET_MESSAGE = '这台浏览器还没有本机通行票据(每次启动轮换)。请刷新页面后重试。';
export const SURGERY_PHRASE_MESSAGE = '需带上定型时亲手写下的那句承诺句(原句不匹配)。';

// ── 1.2 票据:路径 / 读写 / 轮换 ────────────────────────────────────────────────

/** 本进程**当前**票据(唯一事实来源;文件只是副本 —— 理由见 rotateSurgeryTicket)。 */
let current = null;

/** 票据文件:$DSH_HOME/cache/dsh-ling/surgery.ticket(与 defaultDataDir 同源派生,不另写一份路径)。 */
export function surgeryTicketPath() {
  return join(defaultDataDir(), 'surgery.ticket');
}

/** 生成一枚新票(32 字节随机 → 64 位十六进制)。 */
function newTicket() {
  return randomBytes(32).toString('hex');
}

/** 一次性收 ACL:收不到就静默放弃(强度如实来自文件权限,见文件头)。 */
function harden(file) {
  try { chmodSync(file, 0o600); } catch { /* Windows 上多半无效 —— 不假装收了 */ }
}

/**
 * 每启动轮换:覆盖写一枚新票(原子写:临时名 + rename)。registerApi 启动时调一次。
 *
 * ⚠️ 本进程的票据**以内存里的 `current` 为准**,文件只是它的落盘副本:
 *   若磁盘那一刻不可写(权限/只读/满盘),文件里还是上一轮的票 —— 若"发出去的票"取自文件、
 *   "验票"另取一处,两者会**不是同一枚**,结果就是手术在主人面前永远失败。
 *   内存优先 ⇒ 这种降级下手术**照常可用**(仍然只有本机拿得到票),只是"每启动轮换"少了跨进程的残留证据。
 * @returns {string} 本轮票据
 */
export function rotateSurgeryTicket() {
  const t = newTicket();
  current = t;
  const file = surgeryTicketPath();
  try {
    mkdirSync(defaultDataDir(), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, t + '\n', { encoding: 'utf8', mode: 0o600 });
    harden(tmp);
    renameSync(tmp, file);
  } catch (e) {
    console.debug('[dsh-ling] surgery ticket write failed: %s', String(e?.message ?? e));
  }
  return t;
}

/**
 * 读本轮票据。取值顺序:本进程内存 → 票据文件 → 就地补一枚。
 * 内存优先的理由见 rotateSurgeryTicket();文件那一步是为"宿主忘了轮换/进程刚起"兜底,
 * 使"票据文件存在但本轮没轮换"的老进程也不至于把手术变成不可能。
 * @returns {string} 64 位十六进制
 */
export function readSurgeryTicket() {
  if (current) return current;
  const file = surgeryTicketPath();
  try {
    const s = String(readFileSync(file, 'utf8') || '').trim();
    if (s) { current = s; return s; }
  } catch { /* 首次启动 / 文件被删:下面补 */ }
  return rotateSurgeryTicket();
}

/** 从请求头取票(头名大小写不敏感),供门使用。 */
export function surgeryTicketFrom(headers) {
  if (!headers || typeof headers !== 'object') return '';
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === SURGERY_TICKET_HEADER) {
      const v = headers[k];
      return typeof v === 'string' ? v.trim() : '';
    }
  }
  return '';
}

/**
 * 1.1 本机判据(**唯一来源**):**无代理头 且 带 User-Agent** = 直连本机。
 *
 * 两条缺一不可(2026-10-01 晚加固,起因:真机发现远端仍能看到承诺句明文):
 *
 * ① **无代理头**(`realPeerAddress(headers) === undefined`,guard.js):
 *    带 x-forwarded-for / x-real-ip = 经代理 ⇒ 无论对端是不是 127.0.0.1,一律**不算本机**。
 *    ⚠️ **这一条不许删**:公网直连那一路上 nginx 会**追加** XFF(`$proxy_add_x_forwarded_for`),
 *    那是全链最可靠的一道(客户端删得掉自己塞的那段,删不掉 nginx 追加的那段)。
 *
 * ② **带 User-Agent**(新增):远端面板那条路 —— 远端浏览器 → nginx:8443 → frpc → 宿主内的
 *    remote-web-ui 中继 → 127.0.0.1:3080 —— 中继是**重建**请求头(见
 *    `third-party/src/zhu1090093659-dsh-web/packages/dsh-remote-web-ui/src/loopback-proxy.ts`
 *    `pipeLoopbackHttp`):它只留 host(改写成本机)/ sec-fetch-site(合成 same-origin)/
 *    content-type / content-length / accept / cookie,**丢掉 Origin、User-Agent、XFF**。
 *    ⇒ 在中继之后看,远端来的请求**既没有代理头、也没有 Origin**,与"真的本机"长得一模一样
 *    ⇒ 只看①会把明文承诺句交给远端(这正是被真机抓到的那条路)。
 *    而 **"没有 UA"正是那条路的指纹**:本机浏览器直连**永远**带 `user-agent`
 *    (真机访问日志 2026-10-01 实测:带 UA 的 13363 行**全部** host=127.0.0.1:3080、0 行例外;
 *     而 3271 行无 UA 请求的 `channel` **清一色** `no-ua`)。
 *
 * 代价(有意接受,不许当成缺陷"修"掉):**不带 UA 的本机脚本(裸 http 客户端、curl -H 删头等)
 *   从此做不了手术**——它们会被判成非本机 ⇒ `surgery-local-only`。手术是最后一道防线,
 *   宁可让主人"换浏览器再点一次",也不放一条"长得像本机"的合成通道进来。
 * @param {object} headers 请求头
 * @returns {boolean} 真 ⇒ 本机直连
 */
export function isLocalSurgeryRequest(headers) {
  if (realPeerAddress(headers) !== undefined) return false;
  const ua = headerOf(headers, 'user-agent');
  return typeof ua === 'string' && ua.trim() !== '';
}

/** 通道标签(留痕用):'local' | 'proxy' | 'no-ua'。
 *  与 `isLocalSurgeryRequest` **同一条判据的两个面**:只有 `'local'` 才等于"本机直连"。
 *  2026-10-01 晚新增 `'no-ua'`(无代理头、也没 UA ⇒ 非浏览器/中继重建的请求),
 *  免得留痕把中继那条路与真本机混成同一个标签(留痕的价值就在"能分辨")。 */
export function surgeryChannel(headers) {
  if (realPeerAddress(headers) !== undefined) return 'proxy';
  const ua = headerOf(headers, 'user-agent');
  return typeof ua === 'string' && ua.trim() !== '' ? 'local' : 'no-ua';
}

/** 请求是否"持有一枚与当前轮换相符的票"(定长十六进制比较;不等长直接 false,不进 timingSafeEqual)。 */
export function surgeryTicketOk(headers) {
  const got = surgeryTicketFrom(headers);
  if (!got) return false;
  const want = readSurgeryTicket();
  try {
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(want, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── 1.4 事件留痕(append-only + 整行哈希链)────────────────────────────────────

/** 留痕文件:$DSH_HOME/logs/surgery-YYYY-MM.jsonl(按月分片,便于人读与轮转)。 */
export function surgeryLogPath(now = new Date()) {
  const ym = String(now.getUTCFullYear()) + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(dshHome(), 'logs', 'surgery-' + ym + '.jsonl');
}

function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** 字段名白名单 + 每个字段值的指纹。**值本身绝不落盘**(可能是承诺句一类的东西)。 */
export function surgeryFieldsOf(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of Object.keys(body).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(k)) continue;   // 过滤 `__proto__` / 怪名字
    const v = body[k];
    out[k] = typeof v === 'string' ? 's:' + sha256(v).slice(0, 16)
      : (v === null ? 'null' : Array.isArray(v) ? 'a' + v.length : typeof v);
  }
  return out;
}

/** 响应字段(**不含** body 字段名,免得把承诺句/票据这类敏感键名散出去)。 */
export function surgeryResponseFields(verdict) {
  return {
    phraseOk: verdict.phraseOk === true,
    channel: verdict.channel === 'proxy' ? 'proxy' : 'local',
    ticketOk: verdict.ticketOk === true,
  };
}

/** 与 createSurgeryEvent 内部完全一致的规范化(测试复算某一行时用同一份,不许各写一份)。 */
export function surgeryLineOf(ev) {
  return JSON.stringify({
    at: ev.at, endpoint: ev.endpoint, fields: ev.fields, reason: ev.reason,
    channel: ev.channel, phraseOk: ev.phraseOk, beforeHash: ev.beforeHash,
    afterHash: ev.afterHash, prevLineHash: ev.prevLineHash,
  });
}

/**
 * 追加一条留痕。**只追加,不改写历史**。
 * @returns {object} 落盘的那条事件(含 prevLineHash / hash)
 */
export function createSurgeryEvent(ev, opts = {}) {
  const beforeHash = opts.before === undefined ? null : sha256(JSON.stringify(opts.before));
  const afterHash = opts.after === undefined ? null : sha256(JSON.stringify(opts.after));
  // ⚠️ **路径必须先解析**(2026-10-01 真机实测坐实的第二个同类 bug):
  //    旧写法是 `lastSurgeryLineHash(opts.file)` 在前、`const file = opts.file || surgeryLogPath()` 在后
  //    ⇒ 调用方不传 `opts.file`(线上就是这种)时,`readFileSync(undefined)` 抛错被 catch 吞掉、
  //    恒回 null ⇒ **每一条的 `prevLineHash` 都是 null,链永远串不上**(真机 5 条记录全是 nil,
  //    `verifySurgeryChain` 报 brokenAt=2)。上一版坏在"两条序列化路径拼形状",这一版坏在"先后次序"。
  const file = opts.file || surgeryLogPath();
  const prevLineHash = lastSurgeryLineHash(file);
  // ⚠️ 形状**先定死**:`hash` 从一出生就在对象里(先占位 null)。
  //    哈希与落盘**必须走同一条序列化**;否则一旦两边字段集合不同,行就是"自己都对不上自己"的,
  //    整条链一出生即断(第一版靠 `surgeryLineOf(…)` 与 `JSON.stringify(full)` 两条路拼形状,正是这么坏的)。
  const full = {
    at: opts.at || new Date().toISOString(),
    endpoint: String(ev?.endpoint || ''),
    fields: ev?.fields && typeof ev.fields === 'object' ? ev.fields : {},
    reason: String(ev?.reason || 'ok'),
    channel: ev?.channel === 'proxy' ? 'proxy' : 'local',
    phraseOk: ev?.phraseOk === true,
    beforeHash, afterHash, prevLineHash,
    hash: null,
  };
  full.hash = sha256(lineOfHash(full));
  // ⚠️ `file` 已在函数开头解析(链的 prevLineHash 必须读**同一个**文件)—— 这里不许再声明一次。
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, JSON.stringify(full) + '\n', { encoding: 'utf8', mode: 0o600 });
    harden(file);
  } catch (e) {
    console.debug('[dsh-ling] surgery log append failed: %s', String(e?.message ?? e));
  }
  return full;
}

/** 参与自哈希的那一行:`hash` 置空后的整行(与落盘用的是**同一个**对象形状)。 */
function lineOfHash(ev) {
  return JSON.stringify({ ...ev, hash: null });
}

/** 末尾一行的哈希(= 下一条的 prevLineHash)。读不到/空文件 ⇒ null(链首)。
 *  ⚠️ 必须与自哈希**同一条规则**(`lineOfHash`):整条链的两半要是两种算法,链就永远串不上。 */
function lastSurgeryLineHash(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return typeof last?.hash === 'string' ? last.hash : null;
  } catch {
    return null;
  }
}

// ── 6.2 链基线标记(2026-10-01 下午;来源:真机实测坐实的"建链 bug"期,见 PLAN §5.3)────────

/** 基线文件:$DSH_HOME/logs/surgery-chain-baseline.json ⇒ `{ brokenRanges: [{ from, to, reason, at }] }`。 */
export function surgeryBaselinePath() {
  return join(dshHome(), 'logs', 'surgery-chain-baseline.json');
}

/** 真机实况的首个区间:2026-09-30 深夜 ~ 2026-10-01 的"建链 bug"期(`prevLineHash` 恒 null)写下的**第 1–5 条**。
 *  · 为什么内置一份:那 5 条是**历史事实**(审计留痕永不改写/重排),而"永远报错的告警等于没有告警" ——
 *    没有它,每次读留痕都在喊"链断了",真正的篡改反而淹没在噪声里。
 *  · 豁免的**只有 `chain` 这一项**:区间内的**自哈希照样核**(被改过的历史行仍然当场被抓住);
 *    `hash` / `unparsable` 硬失败,**任何区间都不豁免**。
 *  · 想彻底关掉豁免:把 `{ "brokenRanges": [] }` 写成基线文件 —— **文件存在就以文件为准**(不叠加内置)。 */
export const DEFAULT_CHAIN_BASELINE = Object.freeze({
  brokenRanges: Object.freeze([
    Object.freeze({
      from: 1, to: 5,
      reason: '建链 bug(prevLineHash 恒 null,2026-10-01 修);历史行不改写',
      at: '2026-10-01',
    }),
  ]),
});

/** 区间归一:from/to 必须是 ≥1 的整数且 to ≥ from;坏条目**丢弃**(宁可少豁免,绝不多豁免)。 */
function baselineRangeOf(r) {
  const from = Number(r?.from);
  const to = Number(r?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return null;
  return {
    from, to,
    reason: typeof r?.reason === 'string' ? r.reason : '',
    at: typeof r?.at === 'string' ? r.at : '',
  };
}

/**
 * 读基线(**唯一来源**;verifySurgeryChain / /surgery/events 都走这里,不各读一份)。
 * 三种结果必须能区分:
 *   · 文件不存在 ⇒ 用内置默认(区间 1–5);
 *   · 文件存在 ⇒ **完全以文件为准**(哪怕是空数组 ⇒ 一个豁免都不给,"关掉豁免"就是这么写);
 *   · 文件存在但坏了 ⇒ **空区间 + error 标记**(保守:宁可报断链,也不假装有豁免)。
 */
export function readSurgeryBaseline(file) {
  const target = file || surgeryBaselinePath();
  let text = null;
  try {
    text = readFileSync(target, 'utf8');
  } catch {
    return { source: 'builtin-default', file: target, ranges: DEFAULT_CHAIN_BASELINE.brokenRanges.map((r) => ({ ...r })) };
  }
  try {
    const raw = JSON.parse(text);
    const list = Array.isArray(raw?.brokenRanges) ? raw.brokenRanges : [];
    return { source: target, file: target, ranges: list.map(baselineRangeOf).filter(Boolean) };
  } catch {
    return { source: target, file: target, ranges: [], error: 'baseline-unparsable' };
  }
}

/**
 * 链校验:读全文件、逐条核 —— 每条自己的 `hash` 要对得上整行,且 `prevLineHash` 要对得上**上一条整行的哈希**。
 * 手工改一行 ⇒ 该行的 hash 对不上(或下一行的 prevLineHash 对不上)⇒ 报断链位置。
 *
 * 2026-10-01(§6.2 基线):断链若落在**基线区间**内 ⇒ 记进 `knownGaps` 并继续走(区间之后靠 `prev = ev.hash`
 *   自然重新接上),整链报 `ok:true`;落在区间**外** ⇒ 仍 `ok:false`。⚠️ **被豁免的只有 chain 一项**:
 *   区间内的自哈希照样核,`hash`/`unparsable` 一律硬失败。
 * 2026-10-01 晚(去重):`knownGaps` **每个基线区间只报一条**(不再按受影响的行逐条重复),
 *   每条 `{ at, from, to, reason, since }`,其中 **`at` = 首次命中该区间的行号**(2026-10-01 真机:5 行
 *   日志 4 行同区间 ⇒ 旧回执 4 条重复,新回执 1 条 `at:2`)。去重只动**回报条数**,不动判据。
 * @param {string} [file] 留痕文件(默认 $DSH_HOME/logs/surgery-YYYY-MM.jsonl)
 * @param {{baselineFile?:string, baseline?:boolean}} [opts] `baseline:false` ⇒ 不用任何豁免(核验基线自身时用)
 * @returns {{ ok: boolean, count: number, brokenAt: number|null, reason: string|null, knownGaps?: object[] }}
 *          brokenAt = 1 起的行号;null = 整链完好/文件不存在(空链视为 ok)
 */
export function verifySurgeryChain(file, opts = {}) {
  const target = file || surgeryLogPath();
  const base = opts.baseline === false
    ? { source: '(豁免已关闭)', ranges: [] }
    : readSurgeryBaseline(opts.baselineFile);
  const inRange = (i) => base.ranges.find((r) => i >= r.from && i <= r.to) || null;
  /** 失败回执形状与改前**逐字一致**;只有"确实已攒到豁免区间"时才多带 knownGaps。 */
  const fail = (n, reason, gaps) => {
    const out = { ok: false, count: n, brokenAt: n, reason };
    if (gaps.length) out.knownGaps = gaps;
    return out;
  };
  let text = '';
  try {
    text = readFileSync(target, 'utf8');
  } catch {
    return { ok: true, count: 0, brokenAt: null, reason: null };   // 还没发生过手术
  }
  const lines = text.split('\n');
  // 被基线豁免的断链:**每个区间只记一条**,`at` = **首次**命中该区间的行号。
  //   ⚠️ 旧写法逐行 push:真机 5 行日志里 4 行落在同一个区间 ⇒ 回执报出 4 条**一模一样**的 {from:1,to:5}
  //   (只有 at 不同);1000 行的缺口会膨胀成 999 条 —— 噪声重新把信号淹掉,正是这套东西要避免的。
  //   判据本身**一个字没改**:区间内断链仍 ok:true、区间外仍 ok:false、区间内的自哈希照样核。
  const gaps = [];
  /** 同一个基线区间(按 from/to/reason/since 四要素认)只留**首次**命中的那条。 */
  const noteGap = (at, hit) => {
    if (gaps.some((g) => g.from === hit.from && g.to === hit.to && g.reason === hit.reason && g.since === hit.at)) return;
    gaps.push({ at, from: hit.from, to: hit.to, reason: hit.reason, since: hit.at });
  };
  let prev = null;
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    n += 1;
    let ev = null;
    try {
      ev = JSON.parse(raw);
    } catch {
      return fail(n, 'unparsable', gaps);
    }
    // ① prevLineHash 必须指向**上一条整行**的哈希(链)。落在已知区间内 ⇒ 记为历史缺口并继续
    if ((ev?.prevLineHash ?? null) !== prev) {
      const hit = inRange(n);
      if (!hit) return fail(n, 'chain', gaps);
      noteGap(n, hit);   // 同一区间后续再断几次都归到已记的那条里(at 保留首次命中行)
    }
    // ② 自哈希必须对得上整行(内容被改过 ⇒ 这里先炸)。**区间内不豁免** —— 被改过的历史行照样被抓住
    if (typeof ev?.hash !== 'string' || sha256(lineOfHash(ev)) !== ev.hash) {
      return fail(n, 'hash', gaps);
    }
    prev = ev.hash;   // 无论上面是否被豁免,都往前推 —— 区间结束后链要能重新接上
  }
  const out = { ok: true, count: n, brokenAt: null, reason: null };
  if (gaps.length) { out.knownGaps = gaps; out.baseline = base.source; }
  return out;
}

/** 只读读取面:最近 limit 条(倒序返回,便于人看"最后一次手术"),供 GET /surgery/events?limit=。 */
export function listSurgeryEvents(limit = 50, opts = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  const file = opts.file || surgeryLogPath();
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    return { ok: true, file, count: 0, chain: { ok: true, count: 0, brokenAt: null, reason: null }, events: [] };
  }
  const chain = verifySurgeryChain(file, { baselineFile: opts.baselineFile });
  // 让人一眼看出"这份回执是按哪份基线判的"(文件 / builtin-default / 豁免已关闭),以及
  //   **这次到底有没有历史缺口** —— 缺省给空数组,免得读的人分不清"没有缺口"与"字段没带"。
  if (!chain.baseline) chain.baseline = readSurgeryBaseline(opts.baselineFile).source;
  if (!Array.isArray(chain.knownGaps)) chain.knownGaps = [];
  const events = lines.slice(-cap).map((l) => {
    try { return JSON.parse(l); } catch { return { error: 'unparsable' }; }
  }).reverse();
  return { ok: true, file, count: lines.length, chain, events };
}

// ── 1.3 门(唯一入口调用;判据本体在这里,调用点不许再写一份)──────────────────

/** 逃生开关:DSH_LING_GUARD=off 或 settings.guard.enforce===false ⇒ 整体放行。 */
export function surgeryDisabled(settings) {
  if (process.env.DSH_LING_GUARD === 'off') return true;
  try {
    const g = settings?.get?.().guard;
    if (g && typeof g === 'object' && g.enforce === false) return true;
  } catch { /* 取不到设置就不放行(保守) */ }
  return false;
}

/** 把 settings 读成纯值(便于前后哈希);读不到 ⇒ null(不假装知道)。 */
function personaSnapshot(settings) {
  try {
    const s = settings?.get?.();
    return s && typeof s === 'object' ? { persona: s.persona ?? null, styles: s.styles ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * 手术门判据(§1.3)。
 *
 * 返回值形状:
 *   { gated:false, pass:true, phraseOk:true, channel, ticketOk:false }        ← 未定型 / 逃生开关
 *   { gated:true,  pass:false, reason, message, phraseOk, channel, ticketOk } ← 拒
 *   { gated:true,  pass:true,  phraseOk:true, channel, ticketOk:true, event } ← 放行(已留痕)
 *
 * ⚠️ 调用点**不许**自己判断 headers/票据/承诺句 —— 那就是"各写一份",正是 1.1 禁止的。
 */
/**
 * 手术门判据(§1.3)。**判据本体只在这里**;调用点不许再写第二份 headers/票据/承诺句判断。
 *
 * @param {object} headers 请求头
 * @param {object} body    调用点**已经解析好的载荷**(诚实传参:门不做第二次读取 ——
 *                         请求流只能读一次,见 api.js 调用点注释)。没有载荷的端点传 `{}`。
 * @param {{settings?:object, endpoint?:string, logFile?:string}} [opts]
 * @returns {{ok:boolean, gated:boolean, reason:string|null, message?:string,
 *            phraseOk:boolean, channel:'local'|'proxy', ticketOk:boolean, event?:object}}
 *   ok:true  ⇒ 放行(gated:false = 未定型/逃生开关,压根没进手术流程)
 *   ok:false ⇒ 拒(reason 见 SURGERY_REASON_*)
 */
export function requireSurgery(headers, body, opts = {}) {
  const channel = surgeryChannel(headers);
  const ticketOk = surgeryTicketOk(headers);
  const info = { ok: false, gated: false, reason: null, phraseOk: false, channel, ticketOk };
  const deny = (reason, message) => ({ ...info, gated: true, reason, message, phraseOk: false });

  // 1.5 逃生开关:误判时绝不把主人锁在门外(与 guardVerdict 同一判据)。
  if (surgeryDisabled(opts.settings)) return { ...info, ok: true, phraseOk: true };

  const cur = opts.settings?.get?.() || {};
  const p = cur.persona || {};
  // 未定型 ⇒ 行为与现状**逐字一致**(不打扰日常):门根本没进(gated:false)。
  if (p.sealed !== true) return { ...info, ok: true, phraseOk: true };

  // 留痕只在**已定型**时发生(未定型不是手术,不必留痕 —— 免得把日常操作灌成噪声)。
  // 每次尝试**恰记一条**:字段白名单(值只留指纹)+ 通道 + 判据结果 + 前后哈希。
  const log = (reason, phraseOk) => createSurgeryEvent({
    endpoint: String(opts.endpoint || ''),
    fields: surgeryFieldsOf(body),
    reason, channel, phraseOk,
  }, { before: personaSnapshot(opts.settings), file: opts.logFile });

  // ── 已定型:三道判据,顺序固定(先"你在哪",再"你带票了吗",最后"你是本人吗")──
  // ① (a) 命门:非本机 ⇒ 一律拒。两条缺一不可(见 §1.1 的文件头注释):
  //    · 带代理头 ⇒ 经代理(哪怕是 127.0.0.1 转发进来的);
  //    · **没 UA** ⇒ 远端中继重建请求头时把 UA 丢了 —— 那条路既无代理头也无 Origin,只有这一条能分辨。
  if (!isLocalSurgeryRequest(headers)) {
    // 这条也留痕:**"有人从代理那头伸手来改人格"正是最该被记住的一件事**。
    log(SURGERY_REASON_LOCAL_ONLY, false);
    return deny(SURGERY_REASON_LOCAL_ONLY, SURGERY_LOCAL_ONLY_MESSAGE);
  }
  // ② 每启动票据(只对本机发过票;旧票在轮换后即废)。
  if (!ticketOk) {
    log(SURGERY_REASON_TICKET, false);
    return deny(SURGERY_REASON_TICKET, SURGERY_TICKET_MESSAGE);
  }

  // ③ 承诺句(沿用 seal.js 语义:trim 后**逐字**相等,不做哈希、不做长度放水)。
  const phrase = resolveUnlock(body);
  if (!p.sealPhrase) {
    // 旧档案(sealed=true 但无明文承诺句):**拒绝**而不是"首句即采纳" ——
    // 采纳=把认证交给第一次开口的人,在被入侵的现场等于没门(见文件头"强度如实说明")。
    log(SURGERY_REASON_PHRASE, false);
    return deny(SURGERY_REASON_PHRASE, '这份档案已定型但没有存下承诺句的明文记录(旧版数据)。请在本机先走一次「解锁修改」把承诺句补上。');
  }
  if (phrase !== p.sealPhrase) {
    log(SURGERY_REASON_PHRASE, false);
    return deny(SURGERY_REASON_PHRASE, SURGERY_PHRASE_MESSAGE);
  }

  // 放行 + 留痕(带前/后哈希:器灵将来能"想起"这次手术改了什么)。
  const event = log('ok', true);
  return { ok: true, gated: true, reason: null, phraseOk: true, channel, ticketOk, event };
}

/**
 * 从**原文**里取承诺句(唯一来源;调用点不许各写一份正则)。
 * 用在"载荷不能整包读进内存"的端点上(`/import` 的 bundle 可达 4 MiB):
 * **只认顶层协议字段** `"unlock": "<承诺句>"`(根对象的直接成员,与 `api.js` `/import`
 * 后面读的 `parsed.unlock` 是**同一个键**),再按 JSON 规则反转义 —— **不做全量 parse**。
 * ⚠️ 修前取的是"全文第一个 `"unlock"`/`"key"`"(全文正则):导出包的 `deep` 段天然是
 *   `{key,value}`(`memory.js:3288`),于是包内任意 `key` 会抢答 —— 正确原句被无视、
 *   拒绝理由(`surgery-phrase`)说谎;更糟的是承诺句只出现在包内某个 `key`/深层 `unlock`
 *   里时**门会放行**,而 `importBundle` 在 `/import` 的人格检查之前执行 ⇒ "回执说拒了,
 *   记忆却已经换了"。包内容能顶掉判据,就是本函数要堵的那一格。
 * 取不到/解析不了 ⇒ ''(空串永远不等于任何已存的承诺句 ⇒ 拒,不会误放行)。
 */
export function rawUnlock(text) {
  const lit = topLevelUnlockLiteral(String(text ?? ''));
  if (lit === null) return '';
  try {
    const v = JSON.parse('"' + lit + '"');
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 扫一遍原文,取出**根对象**的 `unlock` 字符串字面量(原文,**未**反转义)。
 * 只做"顶层协议字段"这一件事:不做全量 parse(4 MiB bundle 不整包解),也不看任何嵌套内容。
 * 口径与 `JSON.parse(text).unlock` 对齐(这才是 `/import` 之后真正被读的那个值):
 *   · 键**逐字小写** `unlock` —— 大小写不同 = `parsed.unlock` 读不到 ⇒ 这里也不认(fail-closed);
 *   · 同名键以**最后一个**为准(JSON.parse 的既有语义);
 *   · 嵌套同名键、`key`、以及任何数组里的东西**一律不算**。
 * 调用点是单点(rawUnlock),所以"从哪取"只有这一份实现。
 */
function topLevelUnlockLiteral(s) {
  const ws = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  let i = 0;
  const n = s.length;
  while (i < n && (ws(s[i]) || s[i] === '\uFEFF')) i += 1;
  if (s[i] !== '{') return null;      // 根不是对象 ⇒ 没有"顶层协议字段"可言
  let depth = 0;
  let key = null;                      // depth===1 处当前这个键(字符串值要撞上它才算)
  let lit = null;
  while (i < n) {
    const c = s[i];
    if (c === '"') {                   // 一个字符串字面量(含转义):原样切片,不在此处解码
      let j = i + 1;
      while (j < n && s[j] !== '"') { if (s[j] === '\\') j += 1; j += 1; }
      const raw = s.slice(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      if (depth === 1) {
        let k = i;
        while (k < n && ws(s[k])) k += 1;
        if (s[k] === ':') key = raw;                              // 这是个**键**
        else { if (key === 'unlock') lit = raw; key = null; }       // 这是个**值**
      }
      continue;
    }
    if (c === '{' || c === '[') { depth += 1; if (depth >= 2) key = null; i += 1; continue; }
    if (c === '}' || c === ']') { depth -= 1; key = null; i += 1; continue; }
    if (c === ',' && depth === 1) key = null;   // 顶层上一个值的分隔符:键/值的配对到此结束
    i += 1;
  }
  return lit;
}

/** 取承诺句(字段名大小写不敏感,与 headers 同纪律);取不到 ⇒ ''(永远不等于任何已存的承诺句)。 */
function resolveUnlock(body) {
  if (body && typeof body === 'object') {
    for (const k of Object.keys(body)) {
      if (k.toLowerCase() === 'unlock') return typeof body[k] === 'string' ? body[k].trim() : '';
    }
    return '';
  }
  // 端点上"载荷不能整包读"的场景:调用点把**原文**交上来(rawUnlock 的规则仍只在上面一处)。
  return typeof body === 'string' ? rawUnlock(body) : '';
}

/**
 * **拒**时的唯一落地点(§1.3):把拒绝如实告诉调用方,并挂上访问日志的真因。
 * 为什么集中在这里而不是每个受门端点自己写一遍:清单 14 行各写一遍 = "各写一份",正是 §1.1 禁止的形状。
 *
 * ⚠️ 用 **200 + `reason:'sealed'`** 而不是 403:既有客户端(`lib/client.js` 的人格面板)
 * 就是按这个形状分支的(见到 `reason === 'sealed'` 就重新弹解锁框)。本期**不动任何现有弹窗
 * 与文案结构**(规格 §2 Phase 1 的明确边界),所以这里沿用既有形状,只把 `reason`
 * 换成更准的 `surgery-*`(客户端只认 'sealed' 之外的字段不会受影响)。
 */
export function rejectSurgery(req, res, sendJson, sv) {
  try { req.__dshLingRejection = sv.reason; } catch { /* 日志字段,失败不影响判定 */ }
  console.info('[dsh-ling] surgery gate rejected: %s (channel=%s)', sv.reason, sv.channel);
  return sendJson(res, 200, { ok: false, reason: 'sealed', surgery: sv.reason, message: sv.message });
}

/**
 * 端点侧的一行式入口:判据在 requireSurgery,拒绝在 rejectSurgery —— 端点只写这一句。
 * @returns {boolean} true = 放行;false = **已经**把拒绝回应写出去(调用点必须立即 return)
 */
export function gateSurgery(req, res, sendJson, body, opts) {
  const sv = requireSurgery(req?.headers, body, opts);
  if (!sv.ok) { rejectSurgery(req, res, sendJson, sv); return false; }
  // ── V1 否决权(1.8.0 · M5):把"这次想改哪些字段 / 主人带没带否决票据"**随门一起**交给端点 ──
  //   ⚠️ 只放在 `opts`(第 5 参),**不放进 body**:body 会被 `surgeryFieldsOf()` 取指纹留痕,
  //   把整份 patch 塞进去 = 让留痕记下一串与判据无关的键(api.js:2219-2220 的同一条纪律)。
  //   门**不判**否决状态 —— 否决权是门的**上一层**(谁有权限 vs 权限之内我有没有异议),
  //   判定只在 `vetoConsume()` 一处(见文件末尾)。
  sv.veto = opts?.veto && typeof opts.veto === 'object' ? opts.veto : {};
  sv.patch = opts?.patch;
  // MF-5:有些写面在门这一跳**只知道字段名、不知道值**(值由后续 proposeHabit 等现生成)——
  //   那就只交字段名,绝不拿 `body.id` 之类的东西冒充字段值(否则 fields 指纹与 afterDigest 都失真)。
  sv.keys = Array.isArray(opts?.keys) ? opts.keys.slice() : undefined;
  sv.whole = opts?.whole === true;
  sv.endpoint = String(opts?.endpoint || '');
  req.__dshLingSurgery = sv;   // 端点可复核本次判据(不必自己重判一遍)
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// 1.8.0 · M5 — V1 人格层否决权(DESIGN-1.8.0 §4;落点表 m5-survey/V-MAP.md §7/§8)
//
// 判据分层(§1.1「单一来源」):
//   · 权限 = `requireSurgery`(本机 + 每启动票据 + 承诺句),**一个字没改**;
//   · 否决 = 本段。它只回答"在权限之内,我有没有异议",**永不发放任何权限**:
//     `approve` 发的那枚 `nonce` 不是票据(不进 `timingSafeEqual`、不被本机/代理判据消费),
//     真正执行仍必须再过一次 `gateSurgery`(缺票据照样拒 —— 验收 6)。
//
// 状态机(5 态,与 V-MAP §7.1 逐字对齐):pending / approved / vetoed / rejected / overridden。
//   `veto-blocked` **不是**第 6 态:它是 `decision` 字段 + `hist` 追加(复盘标注,不改 state、不放行任何写)。
//   没有 `applied` 态:`approved` + `nonceUsedAt != null` 即"已执行"。
//
// 在场窗口(§7.7):原料只有 `away.windows`(away.js:52),**不设墙钟 / 24h 超时**:
//   "没对话"绝不能被算成"默许" ⇒ pending 一直挂着,只能由 approve / veto / 强制 三选一落定。
//
// 进入 pending 的**唯一**入口:主人**显式提议**(`veto: {propose:true}`,或落库的 `vetoPropose:true`)。
//   ⚠️ 为什么不是"任何人格层写都自动 pending":那会让"未持有的写"全部停摆 —— 既有测试
//   `tests/branch.test.mjs:438`(本机 + 票据 + 原句 ⇒ 立即落库)是**仓库现存的验收**,而它在 M5 的
//   白名单之外;自动 pending 会把它打红。口径写在这里、写进 impl.md:**提议是显式动作**,
//   一旦有 pending/vetoed 记录覆盖了这些字段,**同字段的任何后续写都不生效**(返回 veto-pending/veto-vetoed)。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 否决留痕的 kv 前缀(单键存全生命周期;`kvList('veto.')` 一次拿全)。 */
export const VETO_KV_PREFIX = 'veto.';
/** 人格层字段白名单 = **10 键**(CEO-AUTH-M5 §2)。不在这 10 键里的写面**不进** pending。 */
export const VETO_PERSONA_KEYS = Object.freeze([
  'aiName', 'aiTitle', 'userTitle', 'pronoun', 'duty',
  'bottomLines', 'sealed', 'sealPhrase', 'hardRules', 'habits',
]);
/** 5 个状态(V-MAP §7.1);`veto-blocked` 是 decision 标注,不在此列。 */
export const VETO_STATES = Object.freeze(['pending', 'approved', 'vetoed', 'rejected', 'overridden']);
export const VETO_REASON_PENDING = 'veto-pending';
export const VETO_REASON_VETOED = 'veto-vetoed';
export const VETO_REASON_CONFIRM = 'veto-confirm-required';
export const VETO_REASON_NONCE = 'veto-nonce';
export const VETO_REASON_SCOPE = 'veto-scope';
export const VETO_REASON_NOT_FOUND = 'veto-not-found';
export const VETO_REASON_NOT_PERSONA = 'not-persona-layer';
/** MF-6:kv `veto.*` 下存在解析不出来的条目 ⇒ 无法证明"没有未落定的否决" ⇒ 一律 fail-closed。 */
export const VETO_REASON_KV_CORRUPT = 'veto-kv-corrupt';
/** MF-2:撤锁(`sealed:false`)这一跳在有在挂否决时必须二次确认 —— 否则"撤锁即豁免"是两跳绕过。 */
export const VETO_REASON_UNSEAL = 'veto-unseal-confirm-required';
/**
 * rc.3(F4):撤锁(`sealed:false`)这一跳夹带了**正被 active 否决记录覆盖**的 persona 键 ⇒ 拒。
 * 与 `veto-scope` **分开**:那句文案说的是"这条记录覆盖的字段",而这里的意思恰好相反 ——
 * 撤锁这一跳允许的只有 `sealed` / `sealPhrase`,夹带别的键是**请求形状**问题,不是范围问题。
 */
export const VETO_REASON_UNSEAL_EXTRA = 'veto-unseal-extra-keys';
/** 仍在拦写的三态(pending / approved / vetoed);rejected / overridden 已终态。 */
const VETO_ACTIVE_STATES = Object.freeze(['pending', 'approved', 'vetoed']);
/** veto 理由最短长度(与 tools.js 的 MIN_REASON 同一口径:留痕要能看懂)。 */
export const VETO_MIN_REASON = 4;
/** reason 上限:它是**唯一**的自由文本(V-MAP §8),截到 200 字,不落原文之外的任何值。 */
export const VETO_REASON_MAX = 200;

/** 两处 `veto-scope` 回执共用同一句文案(新守卫 / approved 内置范围)。 */
function vetoScopeMessage(allowed) {
  return '这次改动超出了这条否决记录覆盖的字段（' + allowed.join('/') + '）。';
}

/** 一次否决的 id:`v<base36 时刻>-<8 hex>`(不新增依赖,`node:crypto` 已在本文件)。 */
function vetoIdOf(now = Date.now()) {
  return 'v' + now.toString(36) + '-' + randomBytes(4).toString('hex');
}

function vetoNow() {
  return new Date().toISOString();
}

/** `sha256(JSON.stringify(persona))` 前 16 位 —— 只补 M5 自己的 `afterDigest`,**不动** surgery 的 afterHash。 */
export function personaDigest(persona) {
  return sha256(JSON.stringify(persona ?? null)).slice(0, 16);
}

/** 从 settings 读出当前 persona(读不到 ⇒ {})。 */
function personaOfSettings(settings) {
  try {
    const p = settings?.get?.()?.persona;
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

/** 取补丁里的 persona 子树(端点交上来的形状有两种:带 `persona` 子树,或平铺的 persona 字段)。 */
function personaOfPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const p = patch.persona;
  if (p && typeof p === 'object') return p;
  return patch;
}

/** 这次写面**实际碰到**的人格层字段(∩ 10 键白名单)。`whole:true` ⇒ 整体回写(回滚/整包导入)。 */
export function vetoKeysOf(patch, opts = {}) {
  // MF-5:显式字段名(`keys`)优先 —— 用于"值在门这一跳还不可知"的写面(/feedback/apply、/suggestions/apply)。
  if (Array.isArray(opts.keys)) return VETO_PERSONA_KEYS.filter((k) => opts.keys.includes(k));
  if (opts.whole === true) return VETO_PERSONA_KEYS.slice();
  const src = opts.persona && typeof opts.persona === 'object' ? opts.persona : personaOfPatch(patch);
  return VETO_PERSONA_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(src, k));
}

/**
 * 字段名 → 指纹(复用 `surgeryFieldsOf` 的规则:**值本身绝不落盘**)。
 * `opts.explicit:true` = 这次交参**只给了字段名**(源里没有值) ⇒ 记 `unknown`,
 * 不把"上一次的旧值"或调用方的 id 冒充当次写入值(MF-5)。
 */
function vetoFieldsOf(patch, keys, cur, opts = {}) {
  const src = personaOfPatch(patch);
  const explicit = opts.explicit === true;
  const out = {};
  for (const k of keys) {
    const has = Object.prototype.hasOwnProperty.call(src, k);
    if (!has && explicit) { out[k] = 'unknown'; continue; }
    const v = has ? src[k] : cur?.[k];
    out[k] = typeof v === 'string' ? 's:' + sha256(v).slice(0, 16)
      : (v === null ? 'null' : Array.isArray(v) ? 'a' + v.length : typeof v);
  }
  return out;
}

/** 写成功后 persona 会变成什么(浅合并 10 键)—— 只用于算 `afterDigest`,不参与任何放行判断。 */
function vetoProjected(cur, patch) {
  const out = { ...(cur && typeof cur === 'object' ? cur : {}) };
  const src = personaOfPatch(patch);
  for (const k of VETO_PERSONA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

/**
 * MF-5:`afterDigest` 只有在"这次要写进去的值**在门这一跳就可预知**"时才算得准。
 * 交参是"只给字段名"(`keys:[...]`)时值未知 ⇒ `known:false`,记录里落 `afterDigest:null` +
 * `afterDigestKnown:false`,**不许**拿当前人格冒充落库后人格(否则 impl D7 / verify 判据 7 会失真)。
 */
function vetoProjection(cur, patch, keys) {
  const src = personaOfPatch(patch);
  const known = keys.every((k) => Object.prototype.hasOwnProperty.call(src, k));
  return { known, persona: known ? vetoProjected(cur, patch) : null };
}

/** 在场窗口读数(只用 `away.windows`,**不看墙钟**)。 */
function awayViewOf(memory, sinceIso) {
  let wins = [];
  try { wins = readAwayWindows(memory) || []; } catch { wins = []; }
  const since = Date.parse(String(sinceIso || ''));
  const open = wins.some((w) => w && w.to === null);
  const returnedSince = Number.isFinite(since)
    ? wins.some((w) => w && typeof w.to === 'string' && Date.parse(w.to) > since)
    : false;
  return { windows: wins.length, open, returnedSince };
}

/** 读一条否决记录(不存在 ⇒ null;坏 JSON ⇒ null)。 */
export function readVeto(memory, id) {
  const key = VETO_KV_PREFIX + String(id || '');
  let raw;
  try { raw = memory?.kvGet?.(key); } catch { return null; }
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const rec = JSON.parse(String(raw));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/** 落一条否决记录(单键、整份 JSON;键空间 `veto.` 与既有前缀无冲突,V-MAP §8)。 */
function writeVeto(memory, rec) {
  try {
    memory?.kvSet?.(VETO_KV_PREFIX + rec.id, JSON.stringify(rec));
    return true;
  } catch (e) {
    console.debug('[dsh-ling] veto kvSet failed: %s', String(e?.message ?? e));
    return false;
  }
}

/**
 * 全部否决记录 + 坏条目计数(kvList 一次拿全)。
 * MF-6:坏条目**不再静默跳过** —— 计数上抛,`vetoConsume` 见 `bad>0` 就 fail-closed;
 *   此前"带 id 的请求拒 / 不带 id 的请求放行"是同一份损坏记录给出的相反结论。
 */
function listVetoScan(memory) {
  let rows = [];
  try { rows = memory?.kvList?.(VETO_KV_PREFIX) || []; } catch { rows = []; }
  const out = [];
  let bad = 0;
  for (const r of rows) {
    try {
      const rec = JSON.parse(String(r?.value));
      if (rec && typeof rec === 'object' && rec.id) out.push(rec);
      else bad += 1;
    } catch { bad += 1; }
  }
  return { records: out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))), bad };
}

/** 全部否决记录(kvList 一次拿全;坏条目见 `listVetoScan` —— 这里只返回能读的)。 */
export function listVetoRecords(memory) {
  return listVetoScan(memory).records;
}

/** kv `veto.*` 下解析失败的条目数(MF-6:给 `vetoConsume` 用的 fail-closed 依据)。 */
export function vetoKvBadCount(memory) {
  return listVetoScan(memory).bad;
}

/** 找"覆盖这些字段"的记录(pending/approved/vetoed 才算;rejected/overridden 已终态,不再拦写)。 */
function vetoFind(memory, keys) {
  return vetoFindIn(listVetoScan(memory).records, keys);
}

function vetoFindIn(records, keys) {
  const want = new Set(keys);
  const active = records.filter((r) => VETO_ACTIVE_STATES.includes(r.state));
  for (const rec of active) {
    const got = Object.keys(rec.fields && typeof rec.fields === 'object' ? rec.fields : {});
    if (got.some((k) => want.has(k))) return rec;
  }
  return null;
}

/**
 * 找"**覆盖全部**这些字段"的记录(N1:active 记录只对自己覆盖的字段有发言权)。
 * 与 `vetoFindIn` 的形状相同(active 过滤 + 遍历),只把 any-overlap 换成 every-covered:
 * 用 any-overlap 会把"只沾了其中一个键"的记录自己又找回来,等于没做范围检查。
 */
function vetoFindCover(records, keys) {
  const want = keys;
  const active = records.filter((r) => VETO_ACTIVE_STATES.includes(r.state));
  for (const rec of active) {
    const got = Object.keys(rec.fields && typeof rec.fields === 'object' ? rec.fields : {});
    if (want.every((k) => got.includes(k))) return rec;
  }
  return null;
}

/**
 * MF-2:"撤锁即豁免"的那两跳 —— 第 1 跳写 `{persona:{sealed:false}}` 只碰 `sealed` 一个键,
 * `vetoFind` 命中不了覆盖 `aiTitle` 的记录;第 2 跳起 `gated:false`,10 键全免、无 confirm 无留痕。
 * 修法:撤锁那一跳若**存在在挂记录**(任何 10 键上的 pending/approved/vetoed),
 *   ① 必须 `confirm` 两跳(与 vetoed 的强制同一形态,不新造机制);
 *   ② 强制通过时把那些记录 `unsealPinned=true` 并追加 `hist: veto-unseal-forced`;
 *   ③ 被 pin 的记录**在门外仍然生效**(见 `vetoConsume` 的 `!gated` 分支)⇒ 撤锁不能解除已挂起的否决。
 */
function vetoUnsealAnchor(records) {
  const covering = records.filter((r) => VETO_ACTIVE_STATES.includes(r.state)
    && Object.keys(r.fields && typeof r.fields === 'object' ? r.fields : {}).some((k) => VETO_PERSONA_KEYS.includes(k)));
  if (!covering.length) return null;
  return { records: covering, anchor: covering.find((r) => r.unsealForceToken) || covering[0] };
}

/** 门外的"被撤锁钉住"查询:只有 pinned 记录才在 `gated:false` 之后继续拦写。 */
function vetoFindPinned(records, keys) {
  const want = new Set(keys);
  return records.filter((r) => VETO_ACTIVE_STATES.includes(r.state) && r.unsealPinned === true
    && Object.keys(r.fields && typeof r.fields === 'object' ? r.fields : {}).some((k) => want.has(k)))[0] || null;
}

function vetoPush(rec, entry) {
  if (!Array.isArray(rec.hist)) rec.hist = [];
  rec.hist.push({ at: entry.at || vetoNow(), state: entry.state ?? rec.state, by: entry.by || 'master', ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.decision ? { decision: entry.decision } : {}) });
}

/**
 * 端点交上来的否决票据归一(唯一来源;端点不许各写一份)。
 * 接受的形状:`{vetoId, vetoNonce, vetoConfirm, vetoToken, vetoPropose}` /
 * `{veto:{id, nonce, confirm, token, propose}}` / `{vetoForce:{id, token, confirm}}`。
 */
export function vetoArgsOf(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const v = b.veto && typeof b.veto === 'object' ? b.veto : {};
  const f = b.vetoForce && typeof b.vetoForce === 'object'
    ? b.vetoForce
    : (v.force && typeof v.force === 'object' ? v.force : {});
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  return {
    id: str(b.vetoId) || str(v.id) || str(f.id),
    nonce: str(b.vetoNonce) || str(v.nonce),
    token: str(b.vetoToken) || str(v.token) || str(f.token),
    confirm: b.vetoConfirm === true || v.confirm === true || f.confirm === true,
    propose: b.vetoPropose === true || v.propose === true,
  };
}

/** 端点交上来的"这次要改什么"归一(形状:`{patch:{persona,styles}}` / 平铺 persona / `body.patch`)。 */
export function vetoPatchOf(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (b.patch && typeof b.patch === 'object') return b.patch;
  return b;
}

/**
 * 工具通道侧的否决判据(不给权限,只回答"这些字段现在有没有未落定的否决")。
 * 用在 `rule_add` / `habit_propose` / `habit_resolve` 写 `hardRules` / `habits` **之前** ——
 * 否则"主人让她自己加一条规矩"就是绕过 pending 的第二条路。
 * @returns {null|{ok:false, reason:string, id:string, state:string, message:string}}
 */
export function vetoStatusFor(memory, keys) {
  try {
    const want = (Array.isArray(keys) ? keys : [keys]).filter((k) => VETO_PERSONA_KEYS.includes(k));
    if (!want.length) return null;
    const rec = vetoFind(memory, want);
    if (!rec) return null;
    if (rec.state === 'pending') {
      return {
        ok: false, reason: VETO_REASON_PENDING, id: rec.id, state: rec.state,
        message: '这几项（' + want.join('/') + '）还有一个等我表态的改动（' + rec.id + '）—— 它落定之前我不写。',
      };
    }
    if (rec.state === 'vetoed') {
      return {
        ok: false, reason: VETO_REASON_VETOED, id: rec.id, state: rec.state,
        message: '这几项（' + want.join('/') + '）我否决过（' + rec.id + '）—— 主人放弃或二次确认强制之前，我不写。',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function vetoItem(rec, memory) {
  const away = awayViewOf(memory, rec.at);
  return {
    id: rec.id,
    at: rec.at,
    state: rec.state,
    layer: rec.layer || 'persona',
    fields: Object.keys(rec.fields || {}),
    decision: rec.decision ?? null,
    reason: rec.reason ?? null,
    proposal: rec.proposal || null,
    away,     // `returnedSince===true` ⇒ 她此后在场过(但**不自动落定**:没对话 ≠ 默许)
    seen: Number(rec.seen || 0),
  };
}

/**
 * `ling_veto` 的动作执行面(状态机本体)。**只写 kv `veto.*`,从不 import/写 settings** ——
 * 这是它敢不套 `sealedRefusal()` 的唯一理由(定型后它改的是"别人的提案状态",不是她的人格)。
 * @param {{memory:object, settings?:object, action:string, id?:string, reason?:string,
 *          confirm?:boolean, by?:string, limit?:number}} opts
 */
export function vetoAction(opts = {}) {
  const memory = opts.memory;
  const settings = opts.settings;
  const action = String(opts.action || 'list').trim().toLowerCase();
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 20));
  if (!memory || typeof memory.kvGet !== 'function') return { ok: false, reason: 'no-memory' };
  if (!['list', 'approve', 'veto', 'blocked', 'drop'].includes(action)) return { ok: false, reason: 'bad-action' };

  if (action === 'list') {
    const all = listVetoRecords(memory);
    const items = all.slice(0, limit).map((r) => vetoItem(r, memory));
    return {
      ok: true, count: items.length, total: all.length, limit, items,
      // 只读:本动作**一次 kvSet 都不发**(降级读数 `seen` 也只读不写)。
    };
  }

  const id = String(opts.id || '').trim();
  if (!id) return { ok: false, reason: 'no-id' };
  const rec = readVeto(memory, id);
  if (!rec) return { ok: false, reason: 'not-found', id };
  if ((rec.layer || 'persona') !== 'persona') return { ok: false, reason: VETO_REASON_NOT_PERSONA, id };
  const cur = personaOfSettings(settings);

  if (action === 'approve') {
    if (rec.state !== 'pending') return { ok: false, reason: 'not-pending', id, state: rec.state };
    rec.state = 'approved';
    rec.decidedAt = vetoNow();
    rec.decidedBy = 'ling';
    rec.nonce = randomBytes(32).toString('hex');   // 一次性:执行即消费(这不是票据,见段首)
    rec.nonceUsedAt = null;
    rec.decision = null;
    rec.afterDigest = personaDigest(cur);
    vetoPush(rec, { state: 'approved', by: 'ling', decision: 'approve' });
    if (!writeVeto(memory, rec)) return { ok: false, reason: 'kv-failed', id };
    return {
      ok: true, id, state: 'approved', nonce: rec.nonce, oneShot: true,
      recorded: VETO_KV_PREFIX + id,
      next: '由主人用写入口（POST /persona 等）带 unlock + vetoNonce 执行（**nonce 是必填项**：不带票即拒）；'
        + 'nonce 一次性，执行即消费。缺票据仍会被手术门拒。',
    };
  }

  if (action === 'veto') {
    if (rec.state !== 'pending') return { ok: false, reason: 'not-pending', id, state: rec.state };
    const reason = String(opts.reason || '').trim();
    if (reason.length < VETO_MIN_REASON) return { ok: false, reason: 'no-reason', min: VETO_MIN_REASON };
    rec.state = 'vetoed';
    rec.decision = 'veto';
    rec.reason = reason.slice(0, VETO_REASON_MAX);    // 四字段之一:否决理由(唯一自由文本)
    rec.decidedAt = vetoNow();
    rec.decidedBy = 'ling';
    rec.afterDigest = personaDigest(cur);
    rec.away = awayViewOf(memory, rec.at);
    vetoPush(rec, { state: 'vetoed', by: 'ling', reason: rec.reason, decision: 'veto' });
    if (!writeVeto(memory, rec)) return { ok: false, reason: 'kv-failed', id };
    return {
      ok: true, id, state: 'vetoed', decision: 'veto', recorded: VETO_KV_PREFIX + id,
      at: rec.at, fields: Object.keys(rec.fields || {}), reason: rec.reason,
      message: '我不改这一项；主人可放弃（ling_veto drop → rejected），或二次确认后强制（会更 `veto-overridden`）。',
    };
  }

  // action === 'drop' —— MF-1:主人**放弃**这一跳(DESIGN §4.3「主人 放弃 ──► 归档 rejected」)。
  //   修前 `rejected` 是**不可达死态**:pending 只有 approve / veto 两个出口 ⇒ 主人自己提议、
  //   她一直不表态时,该字段(以及 `whole:true` 的整体回滚)永久被拒。drop 把它从死态变成可达终态。
  if (action === 'drop') {
    if (!VETO_ACTIVE_STATES.includes(rec.state)) {
      return { ok: false, reason: 'not-droppable', id, state: rec.state };
    }
    const by = opts.by === 'master' ? 'master' : 'ling';
    if (by === 'master' && opts.confirm !== true) {
      return { ok: false, reason: 'need-confirm', id, message: '主人撤回一条待表态的改动需要二次确认（confirm:true）。' };
    }
    const reason = String(opts.reason || '').trim();
    rec.state = 'rejected';
    rec.decision = 'veto-dropped';
    rec.droppedAt = vetoNow();
    rec.droppedBy = by;
    if (reason) rec.dropReason = reason.slice(0, VETO_REASON_MAX);
    vetoPush(rec, {
      state: 'rejected', by, decision: 'veto-dropped', ...(reason ? { reason: rec.dropReason } : {}),
    });
    if (!writeVeto(memory, rec)) return { ok: false, reason: 'kv-failed', id };
    return {
      ok: true, id, state: 'rejected', decision: 'veto-dropped', by, recorded: VETO_KV_PREFIX + id,
      message: '已归档为 rejected（撤回了这次提议）—— 这些字段恢复可写；留痕仍在 `' + VETO_KV_PREFIX + id + '`。',
    };
  }

  // action === 'blocked' —— 反向留痕(复盘:「我否决了、他放弃了、事后证明该改」)。
  // V-MAP §7.6:入口就是这个 action,**不新开场点**(否则就是第 16 条写面),也不新建权限判断。
  const by = opts.by === 'master' ? 'master' : 'ling';
  if (by === 'master' && opts.confirm !== true) {
    return { ok: false, reason: 'need-confirm', id, message: '主人代写复盘需要二次确认（confirm:true）。' };
  }
  if (rec.decision !== 'veto') return { ok: false, reason: 'not-vetoed', id, decision: rec.decision ?? null };
  if (!['vetoed', 'rejected'].includes(rec.state)) return { ok: false, reason: 'not-vetoed', id, state: rec.state };
  const reason = String(opts.reason || '').trim();
  if (reason.length < VETO_MIN_REASON) return { ok: false, reason: 'no-reason', min: VETO_MIN_REASON };
  rec.decision = 'veto-blocked';    // **不改 state、不放行任何写**
  rec.blockedAt = vetoNow();
  rec.blockedBy = by;
  rec.blockedReason = reason.slice(0, VETO_REASON_MAX);
  vetoPush(rec, { state: rec.state, by, reason: rec.blockedReason, decision: 'veto-blocked' });
  if (!writeVeto(memory, rec)) return { ok: false, reason: 'kv-failed', id };
  return {
    ok: true, id, state: rec.state, decision: 'veto-blocked', written: true, recorded: VETO_KV_PREFIX + id,
    note: '已记为我的判断失误；不放行任何写（state 不变）。',
  };
}

/**
 * **门后**的状态机判据(DESIGN §4.5「否决权只是门的上一层」)。端点调用顺序**不许反**:
 *   `gateSurgery(...)` → 通过后才 `vetoConsume(...)` → 只有它也 ok 才写 settings。
 *
 * 它**不回答权限**(票据/本机/承诺句一条都不判),只回答四件事:
 *   ① 这次碰到的字段在不在 10 键白名单里(不在 ⇒ 不是人格层 ⇒ 直接放行,验收 5);
 *   ② 门这次到底有没有真的进(未定型/逃生开关 ⇒ `gated:false` ⇒ 否决权不介入 —— 否则"撤锁"会被自己死锁);
 *      例外(MF-2):被"撤锁强制"钉过的记录(`unsealPinned`)在门外**继续生效** ⇒ 撤锁不能解除已挂起的否决。
 *   ③ 有没有覆盖这些字段的未落定记录(pending/vetoed/approved);
 *   ④ 有的话,主人带没带对的票:approved + **必填**一次性 nonce / vetoed + 两跳 confirm /
 *      pending + 两跳 confirm(MF-1:pending 也必须有一个主人侧出口)。
 *
 * @returns {{ok:boolean, reason?:string, id?:string, state?:string, engaged?:boolean,
 *            layer?:string, keys?:string[], afterDigest?:string, forceToken?:string, message?:string}}
 */
export function vetoConsume(opts = {}) {
  const req = opts.req || null;
  const sv = req && req.__dshLingSurgery ? req.__dshLingSurgery : null;
  const memory = opts.memory;
  const settings = opts.settings;
  const gated = opts.gated === true || (sv ? sv.gated === true : false);
  const veto = opts.veto && typeof opts.veto === 'object' ? opts.veto : ((sv && sv.veto) || {});
  const patch = Object.prototype.hasOwnProperty.call(opts, 'patch') ? opts.patch : (sv ? sv.patch : undefined);
  const whole = opts.whole === true || (sv ? sv.whole === true : false);
  const explicitKeys = Array.isArray(opts.keys) ? opts.keys : (Array.isArray(sv?.keys) ? sv.keys : null);
  const endpoint = String(opts.endpoint || (sv && sv.endpoint) || '');
  const cur = personaOfSettings(settings);

  const keys = vetoKeysOf(patch, { whole, keys: explicitKeys });
  const base = { keys, layer: keys.length ? 'persona' : 'other', endpoint };
  // ① 非人格层(代码 / 配置 / 记忆事实 / 语气 / 风格 / habitsPending …)一律不进 pending(验收 5)。
  if (!keys.length) return { ok: true, engaged: false, ...base };
  if (!memory || typeof memory.kvGet !== 'function' || typeof memory.kvSet !== 'function') {
    return { ok: true, engaged: false, ...base, note: 'veto-no-kv' };
  }

  const scan = listVetoScan(memory);
  // ②' MF-6:kv `veto.*` 下有解析不出来的条目 ⇒ 无法证明"这些字段没有未落定的否决" ⇒ **fail-closed**。
  //     修前:带 id ⇒ veto-not-found(拒),不带 id ⇒ 看不见那条坏记录 ⇒ 放行(fail-open),同一份损坏给相反结论。
  if (scan.bad > 0) {
    return {
      ok: false, engaged: true, ...base, reason: VETO_REASON_KV_CORRUPT, bad: scan.bad,
      message: '否决留痕里有 ' + scan.bad + ' 条读不出来的记录 —— 在它被修好之前我不改人格层（fail-closed）。',
    };
  }
  // ② 门没真的进(未定型 / 逃生开关)⇒ 否决权不介入。理由:同意/否决本身也要写 `sealed` 一类的键,
  //    若在门外生效,"撤锁"就会被自己的 pending 锁死(死锁 = DESIGN §4.2 故障 1 的同型)。
  //    ⚠️ MF-2 例外:被"撤锁强制"钉住的记录必须在门外继续拦 —— 否则「撤锁即豁免」两跳就能静默废掉否决权。
  const outOfGate = !gated;
  const pinnedRec = outOfGate ? vetoFindPinned(scan.records, keys) : null;
  if (outOfGate && !pinnedRec) return { ok: true, engaged: false, ...base, note: 'veto-inactive-outside-gate' };

  const fields = vetoFieldsOf(patch, keys, cur, { explicit: !!explicitKeys });

  // ── MF-2:撤锁(`sealed:false`)这一跳 —— 有在挂记录时**必须两跳 confirm + 留痕** ──────────
  const unsealSrc = personaOfPatch(patch);
  const unsealing = Object.prototype.hasOwnProperty.call(unsealSrc, 'sealed') && unsealSrc.sealed === false;
  if (unsealing && !outOfGate) {
    const hit = vetoUnsealAnchor(scan.records);
    // ── ★rc.3 · F4(记录感知版,CEO 裁决 2026-11-13):撤锁不许夹带**正被否决覆盖**的字段 ──────
    //   修前(F4):这一跳只判"有没有在挂记录",**从不读 `keys` 里除 `sealed` 还带了什么** ——
    //   于是 `{sealed:false, aiTitle}` + confirm + 第 2 跳 token 会 `ok:true`,handler 随即
    //   `settings.update(patch)` ⇒ 撤锁这一跳成了"范围内全体免检"的通行证,那条 aiTitle 上的
    //   pending 仍是 pending(不消费、不落痕),而写已经发生。
    //   now:只要 `keys` 里有键**正被 active 记录覆盖**,就当场拒 —— **在发第一枚
    //   `unsealForceToken` 之前**、零写入、无 token、kv 不留新 hist。
    //   ⚠️ 采用**记录感知**判据(变体①′),**不是**"撤锁只许单键"的严格版:面板「重归摇篮」
    //   发的是**整份表单**(7 个 persona 键)+ `sealed:false`(`client.js:2102` → `saveWith` →
    //   `collect()`),严格版会在**没有任何否决记录**时也 100% 打死这个手动按钮。
    //   所以判据 = `keys ∩ active 记录的 fields`,而不是 `keys − {sealed, sealPhrase}`:
    //   `hit === null`(没有在挂记录)⇒ `owned` 为空 ⇒ **一个键都不拦**,既有路径一字不变。
    const owned = hit
      ? new Set(hit.records.flatMap((r) => Object.keys(r.fields && typeof r.fields === 'object' ? r.fields : {})))
      : new Set();
    const extraKeys = keys.filter((k) => k !== 'sealed' && k !== 'sealPhrase' && owned.has(k));
    if (extraKeys.length) {
      return {
        ok: false, engaged: true, ...base, wrote: false,
        reason: VETO_REASON_UNSEAL_EXTRA,
        extraKeys, allowed: ['sealed', 'sealPhrase'], got: keys,
        message: '撤锁（sealed:false）夹带了正被否决覆盖的字段：' + extraKeys.join(' / ')
          + ' —— 这次什么都没改；请先单独撤锁，或先处理这些字段的否决。',
      };
    }
    if (hit) {
      const anchor = hit.anchor;
      if (veto.confirm !== true) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_UNSEAL, id: anchor.id, state: anchor.state,
          message: '还有 ' + hit.records.length + ' 条未落定的人格改动（' + hit.records.map((r) => r.id).join(',')
            + '）—— 撤锁（sealed:false）能把否决面整体静默废掉，所以这一跳要 confirm 二次确认并留痕。',
        };
      }
      if (!anchor.unsealForceToken) {
        anchor.unsealForceToken = randomBytes(32).toString('hex');
        anchor.unsealAt = vetoNow();
        vetoPush(anchor, { state: anchor.state, by: 'master', decision: 'unseal-requested' });
        writeVeto(memory, anchor);
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_UNSEAL, id: anchor.id, state: anchor.state,
          forceToken: anchor.unsealForceToken, wrote: false, unseal: true,
          message: '再发一次并带上 vetoToken 才会撤锁；这次**没有改任何东西**。',
        };
      }
      if (!veto.token || veto.token !== anchor.unsealForceToken) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_UNSEAL, id: anchor.id, state: anchor.state,
          wrote: false, unseal: true, message: '二次确认没对上（vetoToken）—— 这次仍然什么都没改。',
        };
      }
      for (const r of hit.records) {
        r.unsealPinned = true;          // 门外继续生效(撤锁不解除已挂起的否决)
        r.unsealForcedAt = vetoNow();
        vetoPush(r, { state: r.state, by: 'master', decision: 'veto-unseal-forced' });
        writeVeto(memory, r);
      }
      return {
        ok: true, engaged: true, ...base, id: anchor.id, state: anchor.state, decision: 'veto-unseal-forced',
        unseal: true, pinned: hit.records.map((r) => r.id),
        message: '已二次确认撤锁；在挂的 ' + hit.records.length + ' 条记录仍会拦住它们覆盖的字段。',
      };
    }
  }

  let rec = veto.id ? readVeto(memory, veto.id) : vetoFindIn(scan.records, keys);
  if (veto.id && !rec) {
    return { ok: false, engaged: true, ...base, reason: VETO_REASON_NOT_FOUND, id: veto.id, message: '没有这条否决记录。' };
  }
  // ③' 带 id 的**终态**记录不是"放行凭据"(修前:一给 id 就整条跳过"覆盖这些字段的未落定记录"的查找,
  //    于是一条**历史已归档**(rejected/overridden)的、与本次字段无关的 id 就能让同字段仍挂着的
  //    pending 失效 —— 同一份写、同一张票、同一句原句,只多一个归档 id 就落库,且那条 pending
  //    仍是 pending:不消费、不落痕、复盘看不出这次绕过了谁)。
  //    now:终态只代表"那条提案已经了结",它**盖不住**别人 —— 同字段若还有未落定的记录,
  //    继续按那条判(pending ⇒ veto-pending / vetoed ⇒ veto-vetoed / approved ⇒ 票与范围)。
  if (veto.id && rec && !VETO_ACTIVE_STATES.includes(rec.state)) {
    const cover = vetoFindIn(scan.records, keys);
    if (cover) rec = cover;
  }
  // ③'' N1(本次闭合):**active**(pending/approved/vetoed)的 id 同样不是"范围通行证"。
  //     修前:id 指向一条 **vetoed** 记录、而这次写的是**另一批字段**时,上面 ③' 整块不执行 ⇒
  //     `vetoed` 分支照样凭 confirm + token 放行(它不看 `rec.fields`),而本次字段上另挂的 pending
  //     从头到尾没被咨询 —— 与「一旦有 pending/vetoed 记录覆盖了这些字段,同字段的任何后续写都不生效」相反。
  //     now:active 记录只对**它自己覆盖的字段**有发言权 ⇒ 不覆盖本次 keys 时先找"覆盖全部 keys"的那条
  //     继续按它的 state 走 pending/vetoed/approved 既有分支;找不到就拒(veto-scope),而不是拿别人
  //     字段上的票当通行证。终态(rejected/overridden)不受本块影响,仍由 ③' 管。
  if (veto.id && rec && VETO_ACTIVE_STATES.includes(rec.state)) {
    const allowed = Object.keys(rec.fields && typeof rec.fields === 'object' ? rec.fields : {});
    if (!keys.every((k) => allowed.includes(k))) {
      const cover = vetoFindCover(scan.records, keys);
      if (cover) {
        rec = cover;
      } else {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_SCOPE, id: rec.id, state: rec.state,
          allowed, got: keys,
          message: vetoScopeMessage(allowed),
        };
      }
    }
  }
  // ③''' MF-1(m16):两跳强制**不许越过另一条** active 记录。
  //   修前:无 id 的写面由 `vetoFindIn`(any-overlap)只挑**一条**记录 —— 它可能只覆盖一小部分键,
  //   而 `whole:true`(`/persona/rollback`、`/import` 的交参形状,`vetoKeysOf` 给 10 键)照样
  //   confirm 两跳后 `ok:true`,把**整包**写进去;另一条覆盖其余键的 pending/vetoed
  //   全程不被咨询、不消费、不留痕 ⇒ 与 `:699` 的契约相反。
  //   now:本次 keys 里有键**不在**命中记录覆盖范围内,且**还有另一条** active 记录盖着这些键 ⇒
  //   按 `:1251-1265` 同一判据拒(`veto-scope`,回执点名 allowed/got/crossed),零写入。
  //   ⚠️ 只有一条记录时不受影响(§14.2:主人整包回滚的出口照旧两跳放行 —— 没有"别人"被越过)。
  if (rec && VETO_ACTIVE_STATES.includes(rec.state)) {
    const owned = Object.keys(rec.fields && typeof rec.fields === 'object' ? rec.fields : {});
    const rest = keys.filter((k) => !owned.includes(k));
    if (rest.length) {
      const crossed = scan.records.filter((r) => r.id !== rec.id && VETO_ACTIVE_STATES.includes(r.state)
        && Object.keys(r.fields && typeof r.fields === 'object' ? r.fields : {}).some((k) => rest.includes(k)));
      if (crossed.length) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_SCOPE, id: rec.id, state: rec.state,
          allowed: owned, got: keys, crossed: crossed.map((r) => r.id),
          message: vetoScopeMessage(owned),
        };
      }
    }
  }
  if (rec && (rec.layer || 'persona') !== 'persona') {
    return { ok: false, engaged: true, ...base, reason: VETO_REASON_NOT_PERSONA, id: rec.id, message: '这一层不在否决面内。' };
  }

  if (rec) {
    // ── pending:写请求**不生效**,回 id(注入面因此一个字节都不变)────────────────
    //    MF-1:pending 也必须有主人侧出口 —— ① `confirm` 两跳强制(落 `veto-overridden-on-pending`);
    //    ② `ling_veto drop` 归档 rejected。修前 pending 只有 approve / veto 两个出口 ⇒ 主人自己提议后
    //    她一直不表态,该字段(以及 `whole:true` 的整体回滚)永久被拒。
    if (rec.state === 'pending') {
      if (veto.confirm === true) {
        if (!rec.pendingForceToken) {
          rec.pendingForceToken = randomBytes(32).toString('hex');
          rec.pendingForceAt = vetoNow();
          vetoPush(rec, { state: 'pending', by: 'master', decision: 'pending-force-requested' });
          writeVeto(memory, rec);
          return {
            ok: false, engaged: true, ...base, reason: VETO_REASON_CONFIRM, id: rec.id, state: rec.state,
            forceToken: rec.pendingForceToken, wrote: false,
            message: '再发一次并带上 vetoToken 才会执行；这次**没有改任何东西**。',
          };
        }
        if (!veto.token || veto.token !== rec.pendingForceToken) {
          return {
            ok: false, engaged: true, ...base, reason: VETO_REASON_CONFIRM, id: rec.id, state: rec.state,
            wrote: false, message: '二次确认没对上（vetoToken）—— 这次仍然什么都没改。',
          };
        }
        const projPending = vetoProjection(cur, patch, keys);
        rec.state = 'overridden';
        rec.decision = 'veto-overridden-on-pending';
        rec.overriddenAt = vetoNow();
        rec.afterDigest = projPending.known ? personaDigest(projPending.persona) : null;
        rec.afterDigestKnown = projPending.known;
        vetoPush(rec, { state: 'overridden', by: 'master', decision: 'veto-overridden-on-pending' });
        writeVeto(memory, rec);
        return {
          ok: true, engaged: true, ...base, id: rec.id, state: rec.state, decision: 'veto-overridden-on-pending',
          afterDigest: rec.afterDigest, afterDigestKnown: rec.afterDigestKnown, overridden: true,
        };
      }
      return {
        ok: false, engaged: true, ...base, reason: VETO_REASON_PENDING, id: rec.id, state: rec.state,
        message: '这次改动还在等我表态（' + rec.id + '）—— 它落定之前不生效。主人可以先 drop 撤回，'
          + '或带 confirm 二次确认后强制（会留 `veto-overridden-on-pending`）。',
      };
    }
    // ── vetoed:默认不生效;主人两次确认后才执行 + `veto-overridden` 留痕 ──────────
    if (rec.state === 'vetoed') {
      if (veto.confirm !== true) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_VETOED, id: rec.id, state: rec.state,
          message: '这一项我否决过（' + rec.id + '）。要强制覆盖，带 confirm 再发一次 —— 会留公开的 `veto-overridden`。',
        };
      }
      // 第 1 跳:只发一次性 forceToken,**一个字节都不写**
      if (!rec.forceToken) {
        rec.forceToken = randomBytes(32).toString('hex');
        rec.forceAt = vetoNow();
        vetoPush(rec, { state: rec.state, by: 'master', decision: 'force-requested' });
        writeVeto(memory, rec);
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_CONFIRM, id: rec.id, state: rec.state,
          forceToken: rec.forceToken, wrote: false,
          message: '再发一次并带上 vetoToken 才会执行；这次**没有改任何东西**。',
        };
      }
      // 第 2 跳:token 对上才放行(一次性;不设墙钟过期,见段首)
      if (!veto.token || veto.token !== rec.forceToken) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_CONFIRM, id: rec.id, state: rec.state,
          wrote: false, message: '二次确认没对上（vetoToken）—— 这次仍然什么都没改。',
        };
      }
      const projForced = vetoProjection(cur, patch, keys);
      rec.state = 'overridden';
      rec.decision = 'veto-overridden';
      rec.forceAt = vetoNow();
      rec.overriddenAt = rec.forceAt;
      rec.afterDigest = projForced.known ? personaDigest(projForced.persona) : null;
      rec.afterDigestKnown = projForced.known;
      vetoPush(rec, { state: 'overridden', by: 'master', decision: 'veto-overridden' });
      writeVeto(memory, rec);
      return {
        ok: true, engaged: true, ...base, id: rec.id, state: rec.state, decision: 'veto-overridden',
        afterDigest: rec.afterDigest, afterDigestKnown: rec.afterDigestKnown, overridden: true,
      };
    }
    // ── approved:一次性 nonce + 字段范围(不许"批了 A 却改 A+B")────────────────
    if (rec.state === 'approved') {
      if (rec.nonceUsedAt) {
        return { ok: false, engaged: true, ...base, reason: VETO_REASON_NONCE, id: rec.id, state: rec.state, message: '这次同意的票已经用掉了（一次性）。' };
      }
      // MF-4:nonce **必填** —— 修前是 `rec.nonce && veto.nonce && ...` 三个 and,
      //   不带票的写整条判据短路放行 ⇒ "一次性票据"名不副实(她同意 aiTitle,主人可以随时不带票改)。
      if (!veto.nonce) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_NONCE, id: rec.id, state: rec.state,
          message: '这次同意要出示票据（vetoNonce）—— 不带票不放行（票是一次性的）。',
        };
      }
      if (veto.nonce !== rec.nonce) {
        return { ok: false, engaged: true, ...base, reason: VETO_REASON_NONCE, id: rec.id, state: rec.state, message: 'nonce 对不上。' };
      }
      const allowed = Object.keys(rec.fields || {});
      if (!keys.every((k) => allowed.includes(k))) {
        return {
          ok: false, engaged: true, ...base, reason: VETO_REASON_SCOPE, id: rec.id, state: rec.state,
          allowed, got: keys, message: vetoScopeMessage(allowed),
        };
      }
      const projApplied = vetoProjection(cur, patch, keys);
      rec.nonceUsedAt = vetoNow();
      rec.appliedAt = rec.nonceUsedAt;
      rec.afterDigest = projApplied.known ? personaDigest(projApplied.persona) : null;
      rec.afterDigestKnown = projApplied.known;
      vetoPush(rec, { state: 'approved', by: 'master', decision: 'applied' });
      writeVeto(memory, rec);
      return {
        ok: true, engaged: true, ...base, id: rec.id, state: rec.state, applied: true,
        afterDigest: rec.afterDigest, afterDigestKnown: rec.afterDigestKnown,
      };
    }
    // rejected / overridden = 终态:不再拦写(每次强制都留过痕,复盘可翻)
    return { ok: true, engaged: false, ...base, id: rec.id, state: rec.state, note: 'veto-terminal' };
  }

  // ── 没有任何记录:只有**显式提议**才开一条 pending(见段首"为什么不是自动 pending")──
  if (veto.propose === true) {
    const at = vetoNow();
    const id = vetoIdOf();
    const patchKeys = Object.keys(fields);
    const recNew = {
      v: 1,
      id,
      state: 'pending',
      layer: 'persona',
      at,
      // ── DESIGN:146 四字段 ──
      reason: String(opts.reason || '主人提议改动人格层').slice(0, VETO_REASON_MAX),
      fields,
      proposal: {
        endpoint,
        patchKeys,
        // 摘要:**不含任何值**(变异 6 的靶心)
        digest: 'sha256:' + sha256(JSON.stringify(patchKeys) + '|' + JSON.stringify(fields)).slice(0, 16),
        chars: JSON.stringify(personaOfPatch(patch)).length,
      },
      by: 'master',
      decidedAt: null, decidedBy: null,
      nonce: null, nonceUsedAt: null,
      forceToken: null, forceAt: null,
      decision: null,
      away: awayViewOf(memory, at),
      seen: 0,
      afterDigest: personaDigest(cur),
      hist: [{ at, state: 'pending', by: 'master' }],
    };
    if (!writeVeto(memory, recNew)) {
      return { ok: false, engaged: true, ...base, reason: 'kv-failed', message: '否决记录没写进库 —— 这次改动不生效。' };
    }
    return {
      ok: false, engaged: true, ...base, reason: VETO_REASON_PENDING, id, state: 'pending', created: true,
      message: '已记成一条待表态的改动（' + id + '）—— 它落定之前不生效；注入面仍是旧文本。',
    };
  }

  return { ok: true, engaged: false, ...base, note: 'no-veto-in-play' };
}

/**
 * **拒**时的唯一落地点(与 `rejectSurgery` 同形:HTTP 200 + `ok:false` + `reason`,
 * 既有客户端按 `reason` 分支,不新增状态码)。
 */
export function vetoReject(res, sendJson, vv) {
  const payload = {
    ok: false,
    reason: String(vv?.reason || VETO_REASON_PENDING),
    surgery: String(vv?.reason || VETO_REASON_PENDING),   // 与手术门同一个字段名,客户端不必学第二套
    message: String(vv?.message || ''),
  };
  if (vv?.id) payload.id = vv.id;
  if (vv?.state) payload.state = vv.state;
  if (vv?.forceToken) payload.forceToken = vv.forceToken;
  if (Array.isArray(vv?.keys) && vv.keys.length) payload.fields = vv.keys;
  return sendJson(res, 200, payload);
}
