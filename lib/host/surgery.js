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
//   1.3 门下沉为一处 requireSurgery(headers, body, opts),覆盖全部 14 条人格/规矩/习惯写面。
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

// ── 覆盖面清单:14 条能改人格/规矩/习惯的写面(行号 = 2026-09-30 深夜实测,改 api.js 后须复核)──
//    #  端点                      register 行   "原"过门情况(改前)                    改后
//    1  /persona                    1809     仅 wasSealed && !wantLock(wantLock 可绕过) 过门
//    2  /persona/check              1855     无门(只读验钥 —— 但是一把**验句预言机**)   过门
//    3  /persona/self-summary       1881     无门                                     过门
//    4  /persona/hint-adopt         1903     无门                                     过门
//    5  /persona/rule               1938     无门(remove 1941 / add 1948 都不验句)     过门
//    6  /persona/habit              1965     仅 remove 过门(1985-1994)                过门
//    7  /persona/habits/scan        2003     无门(扫描即落库)                          过门
//    8  /persona/habits/reflect     2041     无门(反思即采纳)                          过门
//    9  /persona/grow               2205     无门(注释自陈"锁定下亦可采纳")             过门
//    10 /persona/rollback           2239     过门(2248)                               过门
//    11 /persona/genesis            2596     无门                                     过门
//    12 /feedback/apply             2645     无门                                     过门
//    13 /suggestions/apply          2685     仅 kind∈{aiName,userTitle} 过门(2690-2697) 过门
//    14 /import                     2777     过门(2788)⚠️ 见下                        过门 + 前移
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
 * 只抽紧跟在 `"unlock":` 之后的那个 JSON 字符串,再按 JSON 规则反转义 —— **不做全量 parse**。
 * 取不到/解析不了 ⇒ ''(空串永远不等于任何已存的承诺句 ⇒ 拒,不会误放行)。
 */
export function rawUnlock(text) {
  const m = /"(?:unlock|key)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(text ?? ''));
  if (!m) return '';
  try {
    const v = JSON.parse('"' + m[1] + '"');
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
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
 * 为什么集中在这里而不是每个端点自己写一遍:14 处各写一遍 = "各写一份",正是 §1.1 禁止的形状。
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
  req.__dshLingSurgery = sv;   // 端点可复核本次判据(不必自己重判一遍)
  return true;
}
