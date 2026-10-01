// dsh-ling host — loopback HTTP gateway /api/dsh-ling/*
// webServer acquisition is robust to boot order: direct svc → ctx.inject
// scope → periodic retry until mounted (routes disappear if unavailable).
import { svc, pick, isoDate } from './util.js';
import { assemblePersona, pronounOf, pronounize } from './persona.js';
import { applyModeToSession, currentMode, currentModelSelection, MODE_LABEL, resolveModeConfig } from './mode.js';
import { invalidateSession, refreshStats } from './inject.js';
import { sessionLineProbe, sessionLineState } from './session-line.js'; // E3(2026-09-27):sessionLineState 回到面板档的 `sessionLine` 字段;轮询档仍一个字节都不带
import { selectL1 } from './l1.js';
import { applySuggestionAsRule, dismissSuggestion } from './feedback.js';
import { applyCorpusSuggestion, dismissCorpusSuggestion } from './suggestions.js';
import { runDeepPass, rerunOne, candidateFor, deepSummarizeOne, llmOnce, importRawTargets } from './deepsummary.js';
import { GENESIS_SYS, parseGenesisResult, buildGenesisSource, composeGenesisRows, filterNamePairs } from './genesis.js';
import { scanIntoMemory } from './scan-dsweb.js';
import { scanDshHistory } from './backfill.js';
import { applyImportItems } from './import-file.js';
import { sealOk, KEY_MIN } from './seal.js';
import { timeAnchorDate, timeAnchorLive } from './clock.js';
import { TONE_ADVICE_SYS, TONE_SET, sampleToneRows, parseToneAdvice, appendStyleNote } from './tone-advice.js';
import { logImport, listImportLog, formatLogLine, cleanTooBig, cleanTooBigNames, cleanFoldSkipped } from './import-log.js';
import { checkRequest, lanAddresses, sanitizePersonaPatch } from './guard.js';
// 手术门(2026-09-30 深夜):本机判据 / 每启动票据 / 承诺句 / 哈希链留痕 —— 判据本体只在 surgery.js 一处。
// ⚠️ 上面那行 guard.js 的 import **不许动形态**:tests/guard.test.mjs:139 逐字匹配它。
import {
  gateSurgery, isLocalSurgeryRequest, readSurgeryTicket, rotateSurgeryTicket,
  listSurgeryEvents,
} from './surgery.js';
import {
  mapBranchList, convExistsIn,
  opBranchCreate, opBranchDelete, opBranchReparent, opBranchRename, opBranchWeight,
  opVeinLink, opVeinUnlink, opAssignConv, opConflictResolve,
  opBranchMembers, opSnapshotTree, opRestoreTree, opDeleteSnapshot,
} from './tree-ops.js';
import { retitleOne, retitleOneGlobal, heuristicRetitle } from './retitle.js';
import {
  addRule, removeRule, proposeHabit, resolveHabit, removeHabit, amendHabit, habitsOf, rulesView, RULE_MAX_CHARS,
  habitsPendingOf, pendingMaxOf,
} from './rules.js';
import {
  scanCorrections, evidenceOf, SCAN_DEFAULTS, summarizeScan,
  HABIT_REFLECT_SYS, buildReflectMaterial, parseReflect, REFLECT_DEFAULTS, reflectWithRetry,
} from './habit-gen.js';
import {
  openSource, buildCandidates, conversationText, probeAssistant, summarizeWithRetry, cleanSummary,
  touchMemoryVersion, resolveAssistant, MIN_TURNS_DEFAULT, SUMMARY_SYS,
} from './dsweb-summary.js';
import { TRUNK_ID } from './memory.js';
import { bucketize, nameBucket } from './autotree.js';
import { accessLogStatus } from '../audit/index.js';
// E2 可见化(2026-10-01):只取**键名常量** —— 那条留痕的键名与写法归 summarizer.js 一处所有,
// 本文件不另拼一份字符串(两处各写一份键名,将来必然漂成两个键)。
import { RAW_UNKNOWN_NS_KEY } from './summarizer.js';

// (旧)只校验 cookie 名形状的守卫已废弃 —— 见 guard.js:来源栅栏 + 名字对撞(2026-09-16 加固 ①+②)
// 网页端聊天记录库的默认路径:私有路径不写死在代码里 —— 由 UI 传入,或用 DSH_LING_DSWEB_DB 环境变量覆盖。
const DSWEB_DB_DEFAULT = process.env.DSH_LING_DSWEB_DB || '';
const MSG_KEY = '定型门:档案已定型 — 请在「解锁修改」弹窗里亲手敲一遍你的承诺句(输入框禁粘贴;若旧档案无明文记录,输入一句新的 ≥' + KEY_MIN + ' 字承诺即被采纳)。';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/** 记忆来源白名单(D2/D8,2026-09-17):旧代码写死 `body.source === 'dsh' ? 'dsh' : 'dsweb'`,
 *  会把 source='import' 的置顶/删除误打到 dsweb 源上。
 *  'vein' = 主脉提炼产物(2026-09-25 补)。它是库内第 5 个来源,漏掉它的后果:
 *    ① 记忆中心的来源筛选栏没有它的计数入口,主人看不到"主脉提炼"这一类;
 *    ② /memories/pin|delete 会拒收它 ⇒ 主人无法置顶或删除这类记忆。 */
const MEM_SOURCES = ['dsh', 'dsweb', 'import', 'vein'];

/** E3(审计 H-4):会话内调用**没有原话**时,规矩的原话位写的如实标注。
 *  它**不是原话**,是"没有原话"这件事本身 —— 仿 `rules.js` 自己的「(面板直接写入)」惯例。 */
export const SESSION_NO_QUOTE_NOTE = '(会话内调用,未附原话)';

/**
 * E3(审计 H-4,2026-10-01 修):规矩落库的**归因判据** —— 全仓唯一一处。
 *
 * 旧写法是 `source: body.quote ? 'session' : 'panel'` —— 拿**客户端可控字段** `body.quote`
 * 反推"这条规矩是谁提的"。而**真实面板本来就不发 quote**(`lib/client.js` 的表单发的正是
 * `{ action:'add', rule }`)⇒ 面板确实靠"没有 quote"被认出来,但**同一个形状也把
 * 「会话内、不带 quote 的 HTTP 调用」一起吞成了 `'panel'`**。后果不是文案问题:
 * `rules.js` 对 `'panel'` 免掉原话要求,并把原话位填成「(面板直接写入)」——
 * 于是一次**没有原话、也没有主人在场**的会话内调用,被记成"主人亲手写的那一条",
 * 留痕从此不能用来回答"这条规矩是谁提的"(审计 §H.1 溯源格 🟡 的实锤之一)。
 *
 * 两种归因是两回事,这里分开判 —— 判据只看**请求形状**,不再拿 quote 有无去反推身份:
 *   · `'panel'`            = 主人在**面板**里亲手敲的。面板的形状 = 既没有会话身份、也没有原话;
 *                            他自己敲的就是同意,故**不要求**另附原话(`rules.js` 既有语义,本轮未动);
 *   · `'session'`          = **会话内**代写,且带了原话 ⇒ 「经同意」可核查;
 *   · `'session-no-quote'` = **会话内**调用但**没带原话** ⇒ 手里没有「经同意」的任何凭据。
 *                            如实记这个标记,原话位写 `SESSION_NO_QUOTE_NOTE` ⇒ 不冒充面板、也不冒充同意。
 *
 * ⚠️ 面板身份是**形状识别,不是签名**:本机调用方仍可照抄这个形状(面板那一侧今天没有签名可用)。
 *    要变成不可冒充,得让面板带上只有它才有的凭据 —— 那要改 `lib/client.js`,不在本轮可写清单内,
 *    已列入 1.6 的残余风险。
 * @param {{sessionId?:unknown, quote?:unknown}} [body] 端点收到的 JSON body
 * @returns {{source:'panel'|'session'|'session-no-quote', sessionId:string, quote:string, fromPanel:boolean}}
 */
export function ruleWriteAttribution(body = {}) {
  const sid = String(body?.sessionId ?? '').trim();
  const quote = String(body?.quote ?? '').trim();
  const fromPanel = !sid && !quote;   // = client.js 面板表单的形状(它既不发 sessionId,也不发 quote)
  const source = fromPanel ? 'panel' : (quote ? 'session' : 'session-no-quote');
  return {
    fromPanel,
    source,
    // 面板写入没有会话身份 ⇒ 留痕仍写 'panel'(可读的"这不是某个会话");会话内调用写真实 id。
    sessionId: fromPanel ? 'panel' : sid,
    // 原话位**只说真话**:面板传空串,由 rules.js 填它自己的「(面板直接写入)」(那一步未改);
    // 会话内无原话时填如实标注 ⇒ 这次写入**照旧落库**(与改前一致:改前它也落库,只是被贴成
    // 'panel'),但记录里写清了"没有原话"。若将来要**直接拒收**这一支,判据在 rules.js 的
    // no-quote(它只认 src 是否为空)—— 那要动 rules.js,不在本轮可写清单内。
    //
    // ⚠️ **实测过的边界(别把它读成"没做")**:`ruleMeta.source` 落库时只有 `'panel'` / `'session'`
    //    两个值 —— rules.js 组装 meta 的那一行是 `source: fromPanel ? 'panel' : 'session'`,
    //    **非 panel 一律折成 'session'** ⇒ 上面第三个值 `'session-no-quote'` 到不了库里的
    //    `source` 字段(它活在**判据与回执**里:/persona/rule 的响应 `source` / `unquoted`)。
    //    库里"这次没有原话"由**原话位**承载(`SESSION_NO_QUOTE_NOTE`),面板看得见。
    //    要把三态带进 `ruleMeta`,得改 rules.js 那一行 —— 不在本轮可写清单,已列入残余风险。
    quote: fromPanel ? '' : (quote || SESSION_NO_QUOTE_NOTE),
  };
}

/** 路径归一(只用于**白名单比对**,不碰文件系统):分隔符统一 / 尾斜杠去掉;
 *  Windows 再折大小写(盘符与文件名都不区分大小写)。== 只归一化,不解析 `.`/`..` ==:
 *  归一化只会让"管理员写的路径"与"请求里的同一路径"对上,不会让白名单外的路径对上。 */
const normDbPath = (p) => {
  const s = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** B(审计 §四.4,2026-10-01 修):`/dsweb/summary/preview?db=` 的**准入白名单** —— 全仓唯一一处。
 *
 * 旧写法是 `dswebDbOf(q.get('db'))`(收任意路径)→ `openSource(db)` 只读打开 ⇒ 这是一个
 * **任意本机路径的存在性预言机**:问一句就知道某个 `.db` 在不在、里面有多少条与记忆库对得上的会话。
 * 审计把它列进"资源型"面时特别注明:它**今天靠 `readOnly:true` 才不是写原语** ——
 * 也就是整个安全性挂在一个 flag 上(把这个 flag 去掉就是一条任意文件的写原语)。
 *
 * 判据:只接受**默认库**(环境变量 `DSH_LING_DSWEB_DB`)**或 settings 白名单**里的路径;
 * 其余一律拒并给出 `reason`(**不静默**),让调用方能区分:
 *   · `no-db`         = 你没给路径(且没有默认库)—— 文案与改前逐字一致;
 *   · `db-not-allowed` = 你给的路径不许(白名单外)。
 *
 * 白名单键(`settings.dsweb`):`dbPath` / `db`(单值)、`dbs[]` / `dbPaths[]`(数组)。
 * 认这几个拼法是因为这套键**到今天还没有默认值**(`persona.js` 的 DEFAULT_SETTINGS 里没有
 * `dsweb` 子树 ⇒ 不存在"既有约定"可循),所以这里不发明新配置面,只采最直白的写法。
 * ⚠️ 面板(`client.js`)的 db 是**输入框手填**的 ⇒ 收紧后手填的路径会被拒 ——
 * 故端点里的拒绝文案必须给出两条出路(env / settings),否则就是"静默关功能",
 * 与审计"别静默"的要求正好相反。
 *
 * @param {unknown} value 请求里的 `?db=`
 * @param {{get?:Function}|object} settings settings 服务或裸配置对象
 * @param {Record<string,string|undefined>} [env] 环境变量来源(测试注入,不碰真机 env)
 * @returns {{ok:boolean, db:string, allowed:string[], asked?:string, reason?:string}}
 */
export function previewDbPolicy(value, settings, env = process.env) {
  const asked = String(value ?? '').trim();
  const cfg = (settings && typeof settings.get === 'function' ? settings.get() : settings) || {};
  const d = cfg.dsweb || {};
  const asList = (x) => (Array.isArray(x) ? x : []).map((s) => String(s || '').trim());
  const envDb = String(env?.DSH_LING_DSWEB_DB || '').trim();
  const allowed = [...new Set([
    envDb,
    String(d.dbPath || '').trim(),
    String(d.db || '').trim(),
    ...asList(d.dbs),
    ...asList(d.dbPaths),
  ].filter(Boolean))];
  const hit = (p) => allowed.some((a) => normDbPath(a) === normDbPath(p));
  // 没给 db:照旧用默认库(默认库为空时由调用方回既有的 no-db 文案,与改前逐字一致)
  if (!asked) return { ok: true, db: envDb, allowed };
  if (hit(asked)) return { ok: true, db: asked, allowed };
  return { ok: false, db: '', allowed, asked, reason: 'db-not-allowed' };
}

/** ⚠️ **写操作命中 0 行的"静默失败"**(审计 B#3,2026-09-22 修):
 *  底层 `renameBranch` / `setBranchWeight` / `reparentBranch` 用的都是 `UPDATE ... WHERE id=?`
 *  —— id 不存在时 SQLite 命中 0 行、`changes=0`,可方法仍回 `{ok:true}`。端点据此写了
 *  「已改名」的 `branch_log` 留痕:用户看到"成功",库里的行却纹丝未动(留痕本身还是假的)。
 *  `memory.js` 的这几个 UPDATE 目前**不回传 `changes`**,故在端点层做**前置存在性检查**
 *  (与 POST_ONLY 白名单同为"值不值得改 memory.js"的取舍:这边零回归面)。
 *  断边可直接用底层返回的 `removed` 计数(`unlinkVein` 已回传)。
 */
/** 树操作的收发助手(Part G G1):`tree-ops` 的 result 里 `status` 是**权威状态码**,
 *  这里只负责"照发",并把 `status` 从响应体里剥掉 —— 保证搬到 tree-ops 前后**响应体逐字不变**。 */
function sendOp(res, r) {
  const { status, ...payload } = r || {};
  sendJson(res, Number.isFinite(status) ? status : (r && r.ok ? 200 : 400), payload);
}

/** ⚠️ **批处理端点的单实例锁 + 总时长上限**(审计 B#6,2026-09-22 修):
 *  `/conflicts/judge` 与 `/tree/autobuild/name` 都要逐条调模型(单条 10~90 秒),旧实现
 *  ① **没有单实例锁** —— 前端循环调用时两批并发,同一批矛盾被判两次、同一簇被命名两次;
 *  ② **没有整体超时** —— 小助手卡住时一个请求能把连接和批处理永久挂住,且无从取消。
 *  修法:模块级"正在运行"标志(同类请求再来直接回 `{ok:false, reason:'busy'}`)+
 *  整批 deadline(到点**停止再发新的一条**并回报已完成数 —— 在飞的那一条仍会收尾,
 *  所以超时后的整体耗时上限是"总上限 + 单条最坏耗时",不会无限拖)。
 *  状态放**模块级**而非 `mountRoutes` 内:路由重挂(webServer 晚到/重试)不该把锁清掉。
 *
 *  ⚠️ 第三个消费者 `/vein/distill`(E2 / C-06,1.5.1 红蓝对抗 —— **同一条缺陷的两端**;
 *  收口方式:**只修服务端这一端**,客户端那半是"决定不做",理由见下):
 *  红队 E 从界面看:「✦ 提炼主脉」可重入(`doDistill` 读了忙标志 `lingBusyNow()` 却
 *    **从不置位** ⇒ 连点两次发两次请求);红队 C 从服务端看:这个端点**没有单实例锁**
 *    ⇒ 同一主脉并发提炼 = 模型调两次 + 候选表落两条几乎一样的行。
 *  **只从服务端这一端修**(1.5.2 定案):本处**复用下面这套锁**(不另发明)—— 锁在任何 await
 *  之前抢占、finally 释放;重复请求直接回 `{ok:false, reason:'busy'}`(前端已有对应中文提示)。
 *  客户端那半**决定不做**(前序曾把它记成"另一端、另一批改动"):`lingBusySet` 是
 *  scan / judge / gather **共用**的一把锁,而这里的 BATCH_RUN 是**按 kind 分锁** ⇒ 前端单方面
 *  置位会把三个操作互相挡死(提炼最坏 180s + 在飞单条 ~90s ≈ 270s > `LING_BUSY_JUDGE_MS`
 *  240s 的窗口),而且它**没有任何可见状态**(无渲染分支)⇒ 只会多出一把"看不见却挡人
 *  5 分钟"的锁。正确性由**本锁**闭合:前端 `doDistill` 对 `lingBusyNow()` **只读不写**
 *  (同处注释见 lib/client.js)。真要视觉状态,应另做 per-op 忙标志,不要复用这把共用锁。
 */
const BATCH_RUN = {
  judge: { running: false, startedAt: 0, finishedAt: 0, done: 0, total: 0, timedOut: false },
  name: { running: false, startedAt: 0, finishedAt: 0, done: 0, total: 0, timedOut: false },
  distill: { running: false, startedAt: 0, finishedAt: 0, done: 0, total: 0, timedOut: false },
};
/** 整批总时长上限(命名长、判定短;仍远小于浏览器/网关的挂死容忍时间)。
 *  `distill` 的语义与另两个略有不同:它不是"一批 N 条",而是"一次提炼里最多 3 次尝试"
 *  (DISTILL_TRIES)—— 到点即**不再开始下一次尝试**,在飞的那一次仍会收尾。
 *  180s 的取法:与客户端忙锁的"无进展容忍上限"同量级(client.js 的 `LING_BUSY_MS`),
 *  且远小于网关挂死容忍时间;单次尝试最坏 ~60s ⇒ 总耗时上界 ≈ 240s。 */
const BATCH_MS = { judge: 120000, name: 300000, distill: 180000 };

/** 抢占一次单实例运行权:已在跑则回 null,调用方据此回 busy。 */
function batchEnter(kind) {
  const st = BATCH_RUN[kind];
  if (!st || st.running) return null;
  st.running = true;
  st.startedAt = Date.now();
  st.finishedAt = 0;
  st.done = 0;
  st.total = 0;
  st.timedOut = false;
  return st;
}

/** 释放运行权(必须走 finally —— 抛异常时更不能把锁永久留下)。 */
function batchLeave(kind) {
  const st = BATCH_RUN[kind];
  if (!st) return;
  st.running = false;
  st.finishedAt = Date.now();
}

/** 整批 deadline 判据:到点即**不再开始新的一条**。 */
const batchTimeout = (kind, t0) => (Date.now() - t0) >= (BATCH_MS[kind] || 120000);

/** ⚠️ **请求体上限的入口**(2026-09-29 修:一次「批失败(网关)」误报的根治点)。
 *  旧实现把"超限"处理成一句话:`size > maxBytes` ⇒ `reject(...)` **同一拍** `req.destroy()`。
 *  代价(同批实测里最主要的放大器):**那句现成的错误文案永远送不出去** —— 响应还没写连接就没了,
 *  浏览器只看到 `ECONNRESET`,前端 `.catch` 把它显示成「批失败(网关)」(`client.js:3850-3854`),
 *  把排查方向引向网络/网关/模型;而真因只是本机同一进程内的一道体量闸门。
 *
 *  改判版修法:超限后**不砍连接、不立刻 reject**,改为
 *  ① 立刻停止缓存(已缓存的那几 MiB 也丢掉,不抱着它等到 end);
 *  ② 继续消费 `data`、只累加计数(排空);
 *  ③ 等 `'end'` 到达、连接健康时再 reject 一个 `code='BODY_TOO_LARGE'` / `status=413` 的错误,
 *     由下面的 `guard` 统一翻成 `sendJson(res, 413, { reason:'too-large' })` —— 文案因此真的有通路。
 *  排空换来的两个新代价必须各有一道闸,就是下面这两个常量。 */
const BODY_MAX_BYTES = 4 * 1024 * 1024;
/** 排空态的**硬熔断**:真实字节数超过它 ⇒ 立刻 `destroy()` + reject。
 *  取 64 MiB = 上限的 16 倍。理由:`drainMax` 不是"允许多大",而是**给一次真实超限请求留够
 *  把 body 发完的余量** —— 现实里最大的一份导出 ≈4.9 MB(带原文的包实测 4.66 MB),
 *  余量不够就会把"排空"本身变成新的失败:客户端拿到的仍是 reset 而不是 413,白改一场。
 *  同时它把最坏代价钉死:单个请求最多让我们多读 64 MiB(**纯丢弃、不缓存**)、多占一个计数变量。
 *  取更小会误伤大文件,取更大等于把"拒绝之后还能无限灌数据"当免费午餐。 */
const BODY_DRAIN_MAX_BYTES = 64 * 1024 * 1024;
/** 排空态的**静默超时**:连续这么久收不到任何 chunk ⇒ `destroy()` + reject。
 *  这是**替代原 `req.destroy()` 的那条防 DoS 动机**(修法原先只说"先响应再断开",
 *  没说清"对端发到一半就不发了怎么办"):只要还有数据在流,就说明对端在正常发,不算攻击;
 *  一旦静默,就是僵尸/半开连接,必须收掉 —— 否则"发 4 MiB 然后挂着不动"的连接能把
 *  请求、socket 和那段已丢缓存一起永久占住。
 *  取 30 s:与浏览器/网关的"无进展容忍时间"同量级,且远大于一次 64 MiB 的正常传输耗时。
 *  计时器**每收到一个 chunk 就重置**(滑动窗口,**不是**总时长上限)——
 *  慢但持续的发送不会被误杀,只有真静默才会。 */
const BODY_DRAIN_IDLE_MS = 30000;

/** 读满一个请求体。**导出只为可测**(`tests/bodylimit.test.mjs` 直接驱动它);
 *  49 处调用点一律只传 `req`,签名向后兼容:第二参默认值 = 上限常量,第三参是新增可选项。
 *
 *  ⚠️ 不许省的三条纪律:
 *  · 计时器在**三条出口**都要 `clearTimeout`(`'end'` / `'error'` / 熔断),不留悬挂 timer;
 *  · reject **只能发生一次**(`settled` 标志)—— 熔断之后 socket 上的 `'error'`/`'end'` 还会陆续
 *    到达,重复 reject 对 Promise 虽无害,但会让"谁才是真因"变得不可判;
 *  · **首字节之前也要有计时器**(2026-09-29 红队 E5):计时器原先只在 `data` 里武装
 *    ⇒「正确 cookie + `Content-Length: 4 MiB` + **实发 0 字节**」这条形状在应用层**没有任何计时器**
 *    (红队实测 20000 ms 零响应),兜底只剩 Node 自己的 `requestTimeout`(默认 300 s)。见下面的首字节闸。
 */
export function readBody(req, maxBytes = BODY_MAX_BYTES, opts = {}) {
  // 只认"正数"覆盖:0 / NaN / 负数一律回落默认值 —— 不发明"传 0 = 关掉闸门"这类隐藏开关,
  // 免得将来有人以为能靠一个 0 把 DoS 口子拆掉。
  const drainMax = (Number.isFinite(opts.drainMax) && opts.drainMax > 0) ? opts.drainMax : BODY_DRAIN_MAX_BYTES;
  const drainIdleMs = (Number.isFinite(opts.drainIdleMs) && opts.drainIdleMs > 0) ? opts.drainIdleMs : BODY_DRAIN_IDLE_MS;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;           // 真实字节数:排空态里**继续增长**,`got` 报的就是它
    let settled = false;
    let draining = false;   // 是否已进入排空态(超限第一拍置位,只置一次)
    let firstByteSeen = false; // 首字节到没到 —— 首字节闸的解除条件(见下面 data 分支的第一行)
    let timer = null;

    const disarm = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    /** 唯一的 reject 出口:settled 一旦为真,后面所有 reject 都是 no-op。 */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      disarm();
      reject(err);
    };
    /** 413 错误对象:`message` **逐字沿用旧文案**(不换措辞),其余字段给 guard 用。 */
    const tooLarge = () => {
      const e = new Error('单次请求体过大(超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限),请拆分后重试');
      e.code = 'BODY_TOO_LARGE';
      e.status = 413;
      e.limit = maxBytes;
      e.got = size;
      return e;
    };
    /** **首字节闸**的错误对象(红队 E5,2026-09-29)。**故意不复用 `BODY_TOO_LARGE`**:
     *  这一条不是"体量"问题 —— 一个字节都没发,连"多大"都无从谈起(`got` 恒为 0、**没有 `limit`**);
     *  拿 413 去说它,等于对着一个空连接喊"超过 4MB 上限"。它说的是"对端发完请求头就停住了"
     *  (半开/僵尸连接),故另起一个 code、配 408 语义。
     *  两种静默必须分得开,否则"到底谁没发数据"不可判:
     *   · 本函数 = **首字节之前**就静默(从没开始);
     *   · `tooLarge()` 那次(排空态) = **发到一半**停了(`size` 已 > `maxBytes`)。
     *  文案里的毫秒数取自**同一个可注入参数**:真机 30 s,测试注入 20 ms 时也就不撒谎。 */
    const noFirstByte = () => {
      const e = new Error('已收到请求头,但 ' + drainIdleMs + ' ms 内没有收到任何请求体数据(对端只发了请求头、不发体),已断开连接');
      e.code = 'BODY_IDLE_NO_FIRST_BYTE';
      e.status = 408;
      e.idleMs = drainIdleMs;
      e.got = size;   // 恒为 0:正因为它不是体量问题
      return e;
    };
    /** **唯一**的计时器工厂:同一时刻只有一个计时器在跑 —— 首字节闸(只活在首字节之前)与
     *  排空闸(只在超限之后)在时间上互斥,所以共用一个槽位、共用一个 `disarm()`。
     *  `onIdle` 决定"这次静默意味着什么"(见上面两个错误对象的区别),`req.destroy()` 是两条
     *  静默路的共同动作(静默 = 僵尸/半开连接,必须收掉)。计时器**每收一个 chunk 就重置**
     *  (滑动窗口,**不是**总时长上限)⇒ 慢但持续的合法上传不会被误杀。 */
    const arm = (onIdle) => {
      disarm();
      timer = setTimeout(() => { onIdle(); req.destroy(); }, drainIdleMs);
    };

    // ── 首字节闸:进函数就武装,且必须在任何 `req.on(` 注册**之前**(那时才有"还没开始"可言)──
    // 旧形状的代价:`arm()` 只在 `data` 里武装 ⇒ "只发头、不发体"的请求让这个 Promise **永远挂着**,
    // 连带请求与 socket 一起占住(请求体读取既没有超时,连接也没有)。修法就是这一句。
    arm(() => fail(noFirstByte()));

    req.on('data', (c) => {
      // 首字节到了 ⇒ 首字节闸的使命结束,**必须**在这里解除:留下来它会在**正常传输**里继续计时,
      // 把"慢但持续的合法上传"误杀成超时(正常路径此后**不**武装任何计时器)。
      if (!firstByteSeen) { firstByteSeen = true; disarm(); }
      size += c.length;
      // ── 正常路径(与旧实现行为逐字一致):只缓存没超限的 chunk ──────────────
      if (size <= maxBytes) { chunks.push(c); return; }
      // ── 超限第一拍:停缓存 **并丢弃已缓存的**(不抱着那几 MiB 等到 end)──────
      if (!draining) { draining = true; chunks.length = 0; }
      // ── 硬熔断:再灌下去就是真的流量攻击了 ─────────────────────────────────
      // 先 fail 再 destroy:destroy() 若同步抛出 `'error'`(假 req、或将来 Node 改行为),
      // 那个 error 也抢不走真因(`fail` 已被 settled 挡掉);旧代码同样是"先 reject 再 destroy"。
      if (size > drainMax) { fail(tooLarge()); req.destroy(); return; }
      arm(() => fail(tooLarge()));   // 排空态的静默计时器(首字节闸已在上面的 data 分支解除)
    });
    req.on('end', () => {
      disarm();
      if (draining) { fail(tooLarge()); return; }   // ← 连接健康:文案这次送得出去
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => { disarm(); fail(e); });
  });
}

export function registerApi(ctx, deps, config) {
  const { gate, memory, settings } = deps;

  // ── 手术门:票据**每启动轮换**(规格 §1.2)──────────────────────────────────────
  // 这一句就是"每启动"的落点:插件随宿主启动装配一次 ⇒ 覆盖写一枚新的 32 字节随机票,
  // 上一轮启动留下的票据**当场作废**(旧票仍留在文件里也没用:门比对的是本进程写下的那一枚)。
  // 卸载/重装插件同样会重跑这里 ⇒ "轮换"跟着"装配"走,不需要额外生命周期钩子。
  rotateSurgeryTicket();

  // ---- 获取 webServer:直取 → inject 子作用域 → 定时重试 ----
  let disposed = false;
  let disposeRoutes = null;
  let timer = null;

  const tryMount = () => {
    if (disposed || disposeRoutes) return;
    let server = svc(ctx, 'webServer');
    let scopeCtx = null;
    if (!server || typeof server.register !== 'function') {
      // ctx.inject(['webServer'], cb) 在服务可用时立刻回调子 ctx
      try {
        ctx.inject?.(['webServer'], (child) => {
          scopeCtx = child;
          const s2 = child?.webServer;
          if (s2 && typeof s2.register === 'function' && !disposeRoutes) {
            disposeRoutes = mountRoutes(s2);
            memory.kvSet('api.registered', '1');
          }
        });
      } catch (e) {
        console.debug('[dsh-ling] ctx.inject webServer failed', e);
      }
      server = scopeCtx?.webServer ?? null;
    }
    if (server && typeof server.register === 'function') {
      disposeRoutes = mountRoutes(server);
      memory.kvSet('api.registered', '1');
    }
  };

  const mountRoutes = (server) => {
    const disposers = [];
    // 一键深摘(import 源)的运行状态:单实例串行,防并发重入
    const impRun = { running: false, total: 0, done: [], startedAt: 0, finishedAt: 0 };
    // 网页端库"补摘要"运行状态(与深摘同纪律:单实例串行 + 轮询进度)
    const dswebRun = {
      running: false, total: 0, done: [], ok: 0, fail: 0, current: '', engine: '',
      startedAt: 0, finishedAt: 0, lastError: null, db: '',
    };
    // 守卫(2026-09-16 加固 ①+②,2026-09-17 加固 ③):来源栅栏(loopback / **显式** trustedHosts
    // + 非 cross-site + Origin 同源)+ 会话 cookie **名字对撞**(期望名由 Host 派生,与 DSH 同法)。
    // ③(G1)= 本机 LAN 地址不再自动信任:settings.guard.allowLan 默认 false,要开局域网访问须显式打开。
    // 逃生开关:DSH_LING_GUARD=off 或 settings.guard.enforce=false(误判时不会把人锁在门外)。
    const guardVerdict = (req) => {
      const g = (settings.get().guard && typeof settings.get().guard === 'object') ? settings.get().guard : {};
      if (process.env.DSH_LING_GUARD === 'off' || g.enforce === false) return { ok: true, reason: 'disabled' };
      const extra = Array.isArray(g.trustedHosts) ? g.trustedHosts : [];
      return checkRequest(req.headers, { trustedHosts: extra, allowLan: g.allowLan === true });
    };
    // ⚠️ **HTTP 方法校验**(审计 B#1/P0,2026-09-22 修):
    // 宿主契约 `dsh-host-webserver` 的 `WebRoute` **没有 method 字段**,`guard` 也从不读 `req.method`
    // ⇒ 旧实现下**任何 GET 都能执行写端点**。raw socket 实测:`GET /branches/gather` 返回 200
    // **且真的改了树**(审计期间已实际发生一次)。
    // 这让"本机任意网页里一个 `<img src="http://127.0.0.1:3080/api/dsh-ling/branches/gather">`"
    // 就能静默改数据 —— 守卫只拒 `sec-fetch-site: cross-site`,而 `<img>` 不带 Origin、
    // cookie 又是 host cookie,同站子资源会照常带上(同站 CSRF 面)。
    // 修法**集中在这里声明**,而不是改 72 处 `register` 调用:一处维护、一眼看全、零回归面。
    const POST_ONLY = new Set([
      '/branches/create', '/branches/reparent', '/branches/rename', '/branches/weight', '/branches/delete',
      '/veins/link', '/veins/unlink',
      '/conflicts/record', '/conflicts/resolve', '/conflicts/judge', '/conflicts/scan',
      '/tree/autobuild/name', '/tree/autobuild/apply',
      '/branches/gather', '/tree/snapshot', '/tree/restore', '/tree/snapshot/delete',
      '/branch/assign',
      '/vein/distill', '/vein/suggestion/resolve',
      '/memories/pin', '/memories/delete', '/memories/rename', '/memories/retitle',
      '/assistant/test', '/mode/toggle',
      '/persona', '/persona/self-summary', '/persona/hint-adopt', '/persona/rule', '/persona/habit',
      '/persona/habits/scan', '/persona/habits/reflect', '/persona/tone-advice', '/persona/grow',
      '/persona/rollback', '/persona/genesis',
      '/memory/refresh', '/dsweb/scan', '/dsh/backfill',
      '/import/file/batch', '/import/log', '/import',
      '/deep/run-import', '/deep/run', '/deep/one',
      '/dsweb/summary/run',
      '/feedback/apply', '/feedback/dismiss', '/suggestions/apply', '/suggestions/dismiss',
      // ── 1.5.3(2026-09-29 夜,用户批;依据作者的审计台账《1.5.3 端点写面 · 未进 POST_ONLY》,该台账不随包公开)──
      // ⚠️ 版本号由主会话校正:本批**尚未发布**(`package.json` 仍是 `1.5.3-dev`)⇒ 归 **1.5.3**;
      //    原先这里写的 `1.5.4` 是修复代理想当然的版本号,仓库里从无 1.5.4 的计划。
      // 三条都是**形态上就不该由 GET 执行**的端点,补进同一处声明(仍守"一处维护、一眼看全"):
      //   · `/branch-log/pending`:`memory.branchLogPending()` 在"水位键缺失 + branch_log 非空"时会
      //     **一次性补种水位**(memory.js:1272 `kvSet('branch_log_wm.last', …)`)⇒ GET 能静默把
      //     "复盘守门"的欠账计数顶成 0(审计差集里**唯一一条真写**);
      //   · `/persona/draft`:handler 里 `await llmOnce(...)` ⇒ **GET 就能花一次全局模型额度**(不落盘);
      //   · `/persona/check`:handler 读 body(注释自称 POST),形态已像 POST 端点,防御性收口。
      // 前端调用点**全部已核**(A:客户端本来就是 POST;C:本来就是 POST;B:三处已同步改 POST)。
      '/branch-log/pending', '/persona/draft', '/persona/check',
      // ── 1.5.3(2026-09-30 深夜,手术门)· 取票 = **发放凭据**的动作,形态上就不该由 GET 执行 ──
      // `/surgery/ticket` 只对**本机直连**(无代理头 **且** 带 UA)发一枚 32 字节票;**不缓存**(no-store)—— 票据是每启动轮换的。
      '/surgery/ticket',
    ]);
    // ── 手术门下沉(2026-09-30 深夜;规格 §1.3「门下沉为一处」)──────────────────────────
    // 判据本体**只在** lib/host/surgery.js 的 requireSurgery() 里;这里只是**唯一**的调用点。
    // 覆盖面 = 全部 14 条能改人格/规矩/习惯的写面(逐条清单见 surgery.js 头部注释):挂在 guard(handler)
    // 上就"一眼看全、零回归面",与 POST_ONLY / 413 出口同一个取舍 —— 而不是在 49 个 register 调用点各写一遍。
    // 安全的位置:本调用在 POST_ONLY(405)与 guardVerdict(403)**之后** ⇒ 被挡下的请求绝不会走到 handler。
    // ⚠️ 承诺句必须**惰性**取:多数写端点的载荷由 `await readBody(req)` 消费,而请求流**只能读一次** ——
    //   门若在这里再读一遍,请求流就空了(那些端点会静默变成空 body)。
    //   ⇒ 这里**只**回一个"原文在哪"的函数;真正"从原文里抽承诺句"的规则在 surgery.js 的 rawUnlock()
    //     一处(与判据同源,不在调用点各写一份正则)。
    // `config.surgeryLog` = 留痕文件的**注入口**(测试用):默认落 $DSH_HOME/logs/surgery-YYYY-MM.jsonl,
    //   测试可指向临时文件,免得"链是否完好"被上一段测试或真机留下的旧行干扰。
    const surgeryLog = config?.surgeryLog;
    const guard = (handler) => async (req, res) => {
      // ── E4 覆盖缺口(C-02,1.5.1 红蓝对抗)──────────────────────────────────
      // 器灵的端点在宿主路由表里注册为 **exact** 路由,先于 core 的 `/api` **前缀**路由命中
      // ⇒ core 里那两行钩子**永远看不到器灵自己的流量**(实测:受控发一条
      // `GET /api/dsh-ling/health` 拿到 403,而当天日志**新增 0 行**;两天日志里
      // `/api/dsh-ling` 命中总数也是 0)⇒ E4 对"谁调用了器灵"这个问题一直是空白。
      // 修法**不**再往 node_modules 塞第三条补丁(DSH 一升级就被吃掉,见内部踩坑记录 B25/B30),
      // 而是**让器灵自己记自己** —— 入口就在下面这一个 guard 上:零 core 依赖、升级不会漂,
      // 而且方法校验(405)与鉴权拒绝(403)都在它后面,所以**拒绝也会被记下来**。
      try {
        if (!req.__dshLingLogged && typeof globalThis.__dshAccessLogObserve === 'function') {
          req.__dshLingLogged = true;   // 万一将来 core 侧也覆盖到这里,不会记两遍
          globalThis.__dshAccessLogObserve(req, res);
        }
      } catch { /* 记日志失败绝不影响请求本身 */ }
      // 方法校验**先于鉴权** —— 它挡的是"浏览器被诱导发出的同站请求",与身份无关。
      // 两种 url 形态都能处理:带前缀(`/api/dsh-ling/x`)被 replace 剥掉,不带的原样保留。
      const sub = String(req.url || '').split('?')[0].replace(/^\/api\/dsh-ling/, '');
      if (POST_ONLY.has(sub) && String(req.method || 'GET').toUpperCase() !== 'POST') {
        // ── C-14（rejection 误标）──────────────────────────────────────────────
        // 上面第 225 行就把这次请求交给访问日志了，但**判定点在这里**：只按状态码反推的
        // rejectionReason() 分不清"哪个栅栏拒的"。故判定完成后把真因挂到请求对象上；
        // 时序是安全的：日志行由 observe() 补丁过的 res.end() **同步**写出（access-log.js 的
        // `patchedEnd`：先 `finish()` 写行、再 `origEnd.apply`），而 sendJson 里才调 res.end
        // ⇒ 本行必早于写出（不写行号，免得漂移；认这两个函数名）。
        req.__dshLingRejection = 'method-not-allowed';
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', want: 'POST' });
        return;
      }
      const verdict = guardVerdict(req);
      if (!verdict.ok) {
        req.__dshLingRejection = verdict.reason; // C-14：同上，写日志发生在下面的 sendJson→res.end 之内
        console.info('[dsh-ling] guard rejected: %s (host=%s site=%s origin=%s)',
          verdict.reason, req.headers.host, req.headers['sec-fetch-site'], req.headers.origin);
        sendJson(res, 403, { ok: false, error: 'forbidden', reason: verdict.reason });
        return;
      }
      // ── 手术门(2026-09-30 深夜)──────────────────────────────────────────────
      // 判据本体只在 lib/host/surgery.js 的 requireSurgery() 一处;**各写端点不重判** ——
      // 但调用点必须落在"载荷已经解析出来"的地方(见下),因为请求流只能读一次。
      // 每个写端点的形状固定为:`const body = JSON.parse(…); if (!gateSurgery(req, res, sendJson, body, { settings, logFile: surgeryLog, endpoint: sub })) return;`
      //   · 这一句就是全部接线:判据(本机 / 每启动票据 / 承诺句)与拒绝回应都在 surgery.js;
      //   · 覆盖面 = 14 条写面,逐条清单与"改前是否过门"见 surgery.js 头部注释。
      try {
        await handler(req, res);
      } catch (e) {
        // ── 413 出口:一处覆盖**全部**端点(2026-09-29)────────────────────────
        // `readBody` 超限时 reject 的 `BODY_TOO_LARGE` 到这里落地。写在这里而不是 49 个端点里:
        // 与 POST_ONLY 同一个取舍 —— 一处维护、一眼看全、零回归面。响应体形态
        // 沿用既定约定(`reason:'too-large'`),`limit`/`got` 让人能自己算差多少。
        if (e && e.code === 'BODY_TOO_LARGE' && !res.writableEnded && !res.destroyed) {
          return sendJson(res, 413, { ok: false, reason: 'too-large', message: String(e.message || ''), limit: e.limit, got: e.got });
        }
        // ⚠️ `res.destroyed` 是**硬要求**,不是保险:熔断 / 静默超时那两条路上 socket 已经没了
        // (`readBody` 里 `req.destroy()`),再 `res.end()` 就是往死 socket 写。这里放下这一句,
        // 那两条路的错误就只能"静默丢弃"——故与下面的 500 分支合流,只多一句带原因的 debug。
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
          return;
        }
        console.debug('[dsh-ling] response dropped (socket gone): %s', String(e?.message ?? e));
      }
    };
    // 供状态/自检使用:本机 LAN 地址(G1 之后**不再**自动受信,仅用于提示"要不要显式打开 allowLan")
    const guardInfo = () => ({
      lan: lanAddresses(),
      enabled: process.env.DSH_LING_GUARD !== 'off',
      allowLan: settings.get().guard?.allowLan === true,
    });
    const register = (path, handler) =>
      server.register({ kind: 'exact', path: '/api/dsh-ling' + path, handler: guard(handler) });

    // ── 手术门 · 每启动票据的**发放口**(规格 §1.2)────────────────────────────────────
    // 「只对**本机直连**的请求下发」(§1.1 已加强为「无代理头 **且** 带 UA」,见 surgery.js 文件头):
    //   带 x-forwarded-for / x-real-ip 的请求、以及**没有 UA**(远端中继重建请求头时会丢 UA)的请求
    //   连票都拿不到 —— 判据用 surgery.js 的 isLocalSurgeryRequest(与手术门 §1.1 **同一个来源**,不另写一份)。
    // 票据每启动轮换(见 registerApi 里的 rotateSurgeryTicket()),旧票即废;
    //   故响应带 `no-store`,免得中间层/浏览器把票缓存成"过期也能用"。
    // 这条路是**凭据发放**,所以进了 POST_ONLY(GET 不得执行)。
    disposers.push(register('/surgery/ticket', async (req, res) => {
      if (!isLocalSurgeryRequest(req.headers)) {
        return sendJson(res, 403, { ok: false, reason: 'surgery-local-only', message: '本机通行票据只发给本机直连的请求。' });
      }
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, { ok: true, ticket: readSurgeryTicket(), local: true });
    }));

    // ── 手术门 · 只读留痕面(规格 §1.4)─────────────────────────────────────────────
    // 供**主动感知层**将来消费(**本期只做读取,不做主动开口** —— 那是 Phase 2 的接口形状)。
    // 过 guard(只有本机/受信 authority 能读);`limit` 默认 50、上限 500;
    // 回执里带**链校验结果**(brokenAt:整链完好时为 null)⇒ 主人一眼能看出留痕有没有被动过。
    disposers.push(register('/surgery/events', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const out = listSurgeryEvents(q.get('limit'), { file: surgeryLog });
      sendJson(res, 200, { ok: true, ...out });
    }));

    /** 批量失效所有已定稿快照(规矩/习惯写入后调用;运行中的会话只标记 stale,空闲边界再生效)。 */
    const invalidateAllSummaries = () =>
      allSnapshotSessionIds(gate).map((sid) => ({ sessionId: sid, result: invalidateSession(gate, memory, settings, sid) }));

    /** L0 预览 = 人格段 + 时间锚(便于用户在状态页看到"现在")。
     *  2026-09-23 时间锚拆分:system 侧只留 [今天](日期,一天变一次),
     *  时段与间隔移到 context();状态页是给人看的,故两侧拼起来保持信息完整。 */
    const l0WithClock = (s, mode) => {
      const base = assemblePersona(s, mode);
      const anchor = [timeAnchorDate(memory, settings), timeAnchorLive(memory, settings)]
        .filter(Boolean).join('\n');
      return anchor ? (base ? base + '\n\n' + anchor : anchor) : base;
    };

    /** §6.1(a) 读面**渠道分流**:承诺句只对本机直连回发。
     *  判据 = `isLocalSurgeryRequest(headers)`(surgery.js)—— 它就是 §1.1 的**单一来源**,
     *  与守卫⑤「伪造 loopback 必须被拒」那条、与手术门的 `surgery-local-only` **同源**。
     *  本文件**不另写一份** IP / 代理头 / UA 判断(各写一份必然漂)。
     *  ⚠️ 2026-10-01 晚:判据已从「无代理头」加强为「**无代理头 且 带 UA**」——
     *     远端面板的中继(remote-web-ui loopback-proxy)会重建请求头、把 UA 一并丢掉,
     *     所以"没有 UA"正是那条路的指纹。本文件**一个字都不用改**:加强落在单一来源里,
     *     三个读面(自动)跟着变严 —— 这正是"单一来源"的意义。
     *  ⚠️ 过滤只发生在**出站这一层**:已存档的历史条目、settings.json、库里的行**一个字节都不动**。 */
    const readIsLocal = (req) => isLocalSurgeryRequest(req?.headers);
    /** 非本机 ⇒ 从人格对象里剥掉承诺句、补 `hasSeal` 与 `phraseHidden`(**只读过滤,不改数据**)。
     *  ⚠️ 标记字段特意**不叫** `sealPhraseHidden`:名字里带 `sealPhrase` 子串,会让
     *     "远端响应体不含 `sealPhrase`"这条**子串**断言假红 —— 验收判据是"不含这个词",那就一个都不含。 */
    const personaForRead = (p, local) => {
      if (!p || typeof p !== 'object') return p ?? null;
      if (local) return p;
      const out = { ...p };
      const had = !!out.sealPhrase;
      delete out.sealPhrase;
      out.hasSeal = had;             // 剥掉内容,但"到底有没有这句"照样如实告诉远端(界面要用)
      out.phraseHidden = had;        // 客户端据此走"优雅退化"文案,而不是把"没这句"误当成"旧档案"
      return out;
    };

    const personaInfo = (s, local = false) => ({
      enabled: s?.persona?.enabled !== false,
      userTitle: s?.persona?.userTitle ?? '',
      aiName: s?.persona?.aiName ?? '',
      aiTitle: s?.persona?.aiTitle ?? '',
      tone: s?.persona?.tone ?? 'natural',
      toneWork: s?.persona?.toneWork ?? '',
      toneLife: s?.persona?.toneLife ?? '',
      language: s?.persona?.language ?? 'follow',
      hardRules: Array.isArray(s?.persona?.hardRules) ? s.persona.hardRules : [],
      // 规矩/习惯(2026-09-15 二分):人格中心要看到它们,否则会显示"还没有习惯"(数据其实在,只是没被这个白名单带出来)
      habits: Array.isArray(s?.persona?.habits) ? s.persona.habits : [],
      habitsPending: Array.isArray(s?.persona?.habitsPending) ? s.persona.habitsPending : [],
      ruleMeta: Array.isArray(s?.persona?.ruleMeta) ? s.persona.ruleMeta : [],
      bottomLines: Array.isArray(s?.persona?.bottomLines) ? s.persona.bottomLines : [],
      sealed: s?.persona?.sealed === true,
      hasSeal: !!s?.persona?.sealPhrase,
      // §6.1(a):承诺句**只对本机直连**回发(经代理的读面一个字节都不给);远端另给
      //   `phraseHidden` 让界面能说清"这句只在本机显示"(而不是把"没这句"当成"旧档案没有明文")。
      ...(local
        ? { sealPhrase: s?.persona?.sealPhrase ?? '' }      // 明文回显用(锁只造庄重,不保密;本机①照旧)
        : { phraseHidden: !!s?.persona?.sealPhrase }),
      extraLore: s?.persona?.extraLore ?? '',
      // 职责(1.5.2 I-5):白名单投影必须带出,否则人格中心恒空(与 habits 那次同族的"漏字段=界面静默错")
      duty: s?.persona?.duty ?? '',
      pronoun: s?.persona?.pronoun || '她', // 第三人称代词(用户设定;预设 她/他/TA/它,可自定义)
      stylesWork: s?.styles?.work ?? '',
      stylesLife: s?.styles?.life ?? '',
    });

    const touchesPersona = (patch) =>
      (patch && typeof patch === 'object') &&
      ((patch.persona && typeof patch.persona === 'object' && Object.keys(patch.persona).length) ||
        (patch.styles && typeof patch.styles === 'object' && Object.keys(patch.styles).length));
    const clampBottomLines = (patch) => {
      const bl = patch?.persona?.bottomLines;
      if (Array.isArray(bl) && bl.length > 5) {
        patch.persona.bottomLines = bl.slice(0, 5); // 底线上限 5 条(host 侧硬保险)
        patch._bottomCapped = true;
      }
      return patch;
    };
    /**
     * 存档一份人格档案快照(语义 = 「那次操作之后的档案」,用户直觉即所见;回滚前
     * 额外用 kind='pre-rollback' 留一份当前档案便于反悔)。与最新一份完全相同则跳过。
     * 上限 30 份(hist/log 同步修剪)。
     */
    const archivePersona = async (s, kind = 'result') => {
      const at = Date.now();
      const p = s.persona || {};
      const rows = memory.kvList('persona.hist.');
      if (rows.length) {
        const latest = rows[rows.length - 1]; // kvList 升序,最后一行最新
        try {
          const lv = JSON.parse(String(latest.value));
          if (lv && JSON.stringify(lv.persona || null) === JSON.stringify(p) &&
              JSON.stringify(lv.styles || null) === JSON.stringify(s.styles || {})) {
            return null; // 内容无变化(连点保存等),不重复留档
          }
        } catch {}
      }
      const histKey = `persona.hist.${at}`;
      await memory.kvSet(histKey, JSON.stringify({ persona: p, styles: s.styles || {}, kind }));
      await memory.kvSet(`persona.log.${at}`, JSON.stringify({
        at, kind,
        keys: Object.keys(p),
        sample: JSON.stringify(p).slice(0, 60),
      }));
      const hists = memory.kvList('persona.hist.').map((r) => String(r.key)).sort();
      const logs = memory.kvList('persona.log.').map((r) => String(r.key)).sort();
      while (hists.length > 30) {
        const victim = hists.shift();
        await memory.kvDel(victim);
      }
      while (logs.length > 30) {
        const victim = logs.shift();
        await memory.kvDel(victim);
      }
      return histKey;
    };

    /** GET 参数预览覆写:合成一份临时 settings(不落盘)供 L0 实时预览。 */
    const previewOverrides = (q) => {
      if (!q) return null;
      const pp = q.get('previewPersona');
      const ps = q.get('previewStyles');
      if (!pp && !ps) return null;
      const tmp = structuredClone(settings.get());
      if (pp) {
        try {
          const patch = JSON.parse(pp);
          if (patch && typeof patch === 'object') tmp.persona = { ...(tmp.persona || {}), ...patch };
        } catch {}
      }
      if (ps) {
        try {
          const patch = JSON.parse(ps);
          if (patch && typeof patch === 'object') tmp.styles = { ...(tmp.styles || {}), ...patch };
        } catch {}
      }
      return tmp;
    };

    // ---- 原文来源告警的读面(E2 可见化,2026-10-01)------------------------------------------
    // 背景:E2 把「未知来源的原文」从**被误信**改成**被排除**,但那条留痕只落在 kv 键
    //   `dbg.raw_unknown_namespace` 里 —— **可查,但主人看不见**。本块把那句话搬到前台:
    //   面板要能如实说出"有东西进来了,而我不知道它是什么"。
    // ⚠️ 数据源**只有**那个 kv 键(键名 import 自 summarizer.js,见文件头;本文件不另拼一份)。
    //     `dsh_turns_raw` 将来会有 `source` 列 —— 本读面**不依赖它**,两条路并存也不冲突。
    // ⚠️ **读面契约(前台照这个读,别改形状)**:
    //   · 字段名 `rawUnknownSources`,挂在**顶层**(与 `audit` 平级)。**不塞进 `audit` 块** ——
    //     那块是访问日志的固定形状契约(tests/access-log.test.mjs:460「多一个少一个都算改契约」)。
    //   · **干净时该字段整个不出现**(调用点用条件展开)⇒ ①前台"没有告警就一个字符都不渲染",
    //     ②既有应答体逐字不变(负对照:V1)。绝不用 {} / null 之类空壳冒充"查过了,没事"。
    //   · 告警存在时形状(五个要素齐,顺序固定):
    //     { count, turns, names[], namespaces[{ns,turns,samples[],firstSeenAt,lastSeenAt}],
    //       firstSeenAt, lastSeenAt, at, text }
    //     ①count = 未知来源**个数**;②names/namespaces[].ns = 它们**叫什么**;
    //     ③namespaces[].turns = 各有多少轮原文;④firstSeenAt/lastSeenAt = 首次/最近见到;
    //     ⑤text = **唯一一处**拼出来的人话结论(前台原样显示,不再自己拼第二遍)。
    // ⚠️ 唯一一个 helper 就是下面这个:`/health` 与 `/state` 两个读面都只经它取数。
    //     将来要加第三个读面,也在这里加字段 —— **不许**在各处各写一份取数逻辑。
    // ⚠️ 时间语义:kv 里的计数是**累积**的(summarizer 只加不减)⇒ 这是"**见过**"的留痕,不是
    //     "此刻表里还有"。所以 text 里写的是"首次/最近**见到**",不含糊成"现在有"。
    const rawUnknownSourcesOf = () => {
      try {
        const raw = memory?.kvGet?.(RAW_UNKNOWN_NS_KEY);
        if (!raw) return null;                       // 没写过这个键 ⇒ 干净(一个字节都没写过)
        const parsed = JSON.parse(String(raw));
        const src = parsed?.namespaces;
        // 两种写法都吃:对象表(**当前** summarizer 的写法 —— 名字是**键**,值里没有 ns 字段;
        // 第一版探针就在这里读错了:只认 r.ns ⇒ 一个来源都认不出、静默返回 null)与数组(将来若改形状,读面不跟着瞎)。
        const rows = Array.isArray(src) ? src
          : (src && typeof src === 'object' ? Object.entries(src).map(([ns, r]) => ({ ...(r && typeof r === 'object' ? r : {}), ns })) : []);
        const byNs = new Map();
        for (const r of rows) {
          const ns = String((r && r.ns) || '').trim();
          if (!ns) continue;
          const cur = byNs.get(ns) || { ns, turns: 0, samples: [], firstSeenAt: null, lastSeenAt: null };
          cur.turns += Number(r?.turns) || 0;
          if (Array.isArray(r?.samples)) {
            cur.samples = [...new Set([...cur.samples, ...r.samples.map(String)])].slice(0, 3);
          }
          const f = r?.firstSeenAt ? String(r.firstSeenAt) : null;
          const l = r?.lastSeenAt ? String(r.lastSeenAt) : null;
          if (f && (!cur.firstSeenAt || f < cur.firstSeenAt)) cur.firstSeenAt = f;
          if (l && (!cur.lastSeenAt || l > cur.lastSeenAt)) cur.lastSeenAt = l;
          byNs.set(ns, cur);
        }
        // 去重按命名空间(summarizer 那边已按 ns 归并,这里再收一次 —— 读面不假定写入侧一定整洁)
        const namespaces = [...byNs.values()].sort((a, b) => (b.turns - a.turns) || a.ns.localeCompare(b.ns));
        if (!namespaces.length) return null;         // 有键没内容 = 空壳 ⇒ 按"没有告警"处理,不显示空行
        const turns = namespaces.reduce((s, u) => s + u.turns, 0);
        const stamps = (k) => namespaces.map((u) => u[k]).filter(Boolean).sort();
        const firstSeenAt = stamps('firstSeenAt')[0] || null;
        const lastSeenAt = stamps('lastSeenAt').slice(-1)[0] || null;
        return {
          count: namespaces.length,
          turns,
          names: namespaces.map((u) => u.ns),
          namespaces,
          firstSeenAt,
          lastSeenAt,
          at: parsed?.at ? String(parsed.at) : null,
          text: rawUnknownSourcesText({ namespaces, turns, firstSeenAt, lastSeenAt }),
        };
      } catch { return null; }   // 解析不出来 ⇒ 当"没有告警"(绝不拿半个读数冒充"一切正常")
    };

    // ---- /state 分档(1.5.2,设计 §3) ------------------------------------------------------
    // 面板路径(client.js:890)恒带 `l0Preview=1`,轮询路径(client.js:604-608)从不带
    // ⇒ 用**已有**的这个开关当"面板档"标记:**不新增查询参数、前端零改动**。
    // 轮询档只回 `applyStateToStore`(client.js:610-620)真会读到的字段 —— 重字段在轮询应答里今天就没被读过,
    // 省掉它们不改变任何前端行为(而"按需省字段"是危险的,见设计 §4:前端每拍**无条件**覆写 store)。
    // ⚠️ `persona` 必须留在轮询档:client.js:612 每拍 `setPronounFrom(r.persona)`,省掉第三人称代词会卡住。
    // ⚠️ `audit` 必须留在轮询档:client.js:618 的 `!== undefined` 守卫 + 侧栏红点,唯一"不主动查也看得见"的日志故障位。
    // ⚠️ `rawUnknownSources` 同样留在轮询档(2026-10-01):client.js 的 applyStateToStore 会读它
    //     ⇒ 面板不必重开就能看到"有未知来源进来了"。干净时**整个字段不出现** ⇒ 轮询应答逐字不变。
    const stateForGlobal = (q, local = false) => {
      const base = settings.get();
      const tmp = previewOverrides(q) || base;
      const mode = base.mode?.lastMode === 'work' ? 'work' : 'life';
      const wantPreview = q && q.get('l0Preview') === '1'; // 面板档标记
      const rawUnknown = rawUnknownSourcesOf();            // 干净 ⇒ null ⇒ 下面条件展开=字段不出现
      const light = {
        ok: true,
        plugin: 'dsh-ling',
        sessionId: null,
        scope: 'global',
        mode,
        modeLabel: MODE_LABEL[mode],
        running: false,
        pending: 0,
        persona: personaInfo(base, local),
        lastMode: mode,
        audit: auditHealth(), // C-07:全局(无活动会话)视图也要看得到日志健康面
        ...(rawUnknown ? { rawUnknownSources: rawUnknown } : {}), // E2 可见化:新字段另起,老字段逐字不动
      };
      if (!wantPreview) return light; // 轮询档:到此为止(下面这些只有面板路径才付)
      return {
        ...light,
        snapshot: null,
        l0PreviewText: l0WithClock(tmp, mode),
        memory: {
          overviews: memory.countOverviews({ onlyOk: true }),
          rawTurnSessions: rawTurnSessionCount(memory),
          fingerprint: memory.fingerprint(),
        },
      };
    };

    // ---- E3 面板档只读读数(2026-09-27)------------------------------------------------------
    // 背景:「那一行」在盘上有**两条**,长得像但不是一回事 —— ①L2 `[记忆·开场]` 里本会话那一条
    // (只有标题,概述器 15 分钟一拍)与 ②E0 `agent/pre-step` 追加的活行(`[本次会话·进展 #N] ...`)。
    // 面板要把两条**各自标注**地显示出来,并把"为什么没变"变成看得见的读数 ⇒ 需要下面几个只读字段。
    // 规矩(照 auditHealth):**每个新字段各自 try/catch** —— 任何一个读数出错都不许把 /state 带崩;
    // 且**只在 l0Preview=1 的面板档付这个钱**(轮询档今天 43× 提速的成果不能被这几个字段吃回去)。
    const SNAP_TEXT_CAP = 8000; // 冻结快照原文上限:面板是只读展示(看全文走面板档、纯读、不进 prompt),8k 字符够看清那一轮读到什么
    const e3Snapshot = (snap) => {
      try {
        const t = String((snap && snap.text) || '');
        return t.length > SNAP_TEXT_CAP ? { text: t.slice(0, SNAP_TEXT_CAP), truncated: true } : { text: t };
      } catch { return {}; } // 取不到就**不给**这个字段 ⇒ 前端按"缺字段"处理(绝不用空串冒充"快照是空的")
    };
    // E1 深摘冻结:该会话是否已被深摘(`deepsummary.js:267` 写的就是 `done:<iso>`)—— 冻结则那一行正文不再更新
    const e3DeepDone = (sid) => {
      try { return String(memory.kvGet('deep:' + sid) || '').startsWith('done:'); } catch { return null; }
    };
    // ②活行读数:handler 侧给 sessionLineState 添了字段(text/ordinal/wouldAppend/blocked/last/counts,
    //   富字段整体还挂在 `preview` 下、**含 `basis`**),这里只做**转发 + 容错**(少字段/抛异常都退化成 null)。
    // `opts.settings` 必须透传(settings 就在本作用域内):预览据此尊重那个**免重启回退开关**
    //   (`memory.sessionProgressLine === false` ⇒ 报 `blocked: 'disabled'`);不透传就会照样给"会追加"的预测。
    const e3SessionLine = (sid) => {
      try { return sessionLineState(memory, sid, { settings }) || null; } catch { return null; }
    };
    // ③本会话那一行的 `self` 标记:只**加**一个字段(既有 conv_id/title/date/category/score/line 逐字不动)
    const e3L1Items = (l1, sid) => {
      try {
        return l1.items.map((i) => {
          const row = {
            conv_id: i.conv_id, title: i.title, date: isoDate(i.updated_at || i.started_at),
            category: i.category, score: i.score, line: i.line,
          };
          if (String(i.conv_id) === String(sid)) row.self = true;
          return row;
        });
      } catch { return []; } // 映射本身出错也不许把 /state 带崩
    };

    const stateFor = (sessionId, { l0Preview = false, q, local = false } = {}) => {
      const base = settings.get();
      const tmp = q ? (previewOverrides(q) || base) : base;
      const mode = currentMode(memory, settings, sessionId);
      const rawUnknown = rawUnknownSourcesOf();            // 同上:干净 ⇒ 字段整个不出现
      const light = {
        ok: true,
        plugin: 'dsh-ling',
        sessionId,
        mode,
        modeLabel: MODE_LABEL[mode] ?? mode,
        running: gate.isRunning(sessionId),
        pending: gate.pendingCount(sessionId),
        persona: personaInfo(base, local),
        lastMode: base.mode?.lastMode ?? 'life',
        audit: auditHealth(), // C-07:会话视图同样带上(旧客户端忽略未知字段,向后兼容)
        ...(rawUnknown ? { rawUnknownSources: rawUnknown } : {}), // E2 可见化:新字段另起,老字段逐字不动
      };
      if (!l0Preview) return light; // 轮询档(见上:分档说明)
      const snap = gate.snapshotOf(sessionId);
      const l1 = base.memory?.l1Enabled === false ? null : selectL1(memory, {
        mode,
        sessionId, // D9-a 血缘加权:按该会话所属枝给记忆定档
        categoryWeights: base.memory?.categoryWeights,
        maxItems: base.memory?.l1MaxItems,
        budgetChars: Math.max(200, Math.round((base.memory?.l1BudgetTokens ?? 1200) * 1.4)),
      });
      return {
        ...light,
        // E3:`snapshot` 加**正文字段**(`text`,超 8000 字符时另给 `truncated: true`)—— 面板的「看全文」读它。
        //     既有 5 个字段(exists/builtAt/mode/stale/chars)逐字未动;只面板档带(上面的 `if (!l0Preview) return light;`)。
        snapshot: snap
          ? { exists: true, builtAt: snap.builtAt ?? null, mode: snap.mode ?? null, stale: !!snap.stale, chars: (snap.text || '').length, ...e3Snapshot(snap) }
          : { exists: false },
        idleRefresh: refreshStats(memory, sessionId), // B:空闲边界刷新留痕(次数 + 最近时间)
        // E3:②活行读数 + ①"为什么没变"的判据。`l0Preview` 在上面早已早退 ⇒ 这里恒为 true;
        //     仍写成三元组是**字面**钉住"轮询档一个都不带"(将来有人挪动那句早退也不会悄悄带上重字段)。
        sessionLine: l0Preview ? e3SessionLine(sessionId) : undefined,
        deepDone: l0Preview ? e3DeepDone(sessionId) : null,
        l0PreviewText: l0WithClock(tmp, mode),
        memory: {
          overviews: memory.countOverviews({ onlyOk: true }),
          rawTurnSessions: rawTurnSessionCount(memory),
          fingerprint: memory.fingerprint(),
          l1: l1 ? {
            items: e3L1Items(l1, sessionId), // E3:本会话那一条多一个 `self: true`
            totalChars: l1.totalChars,
            dropped: l1.dropped,
          } : null,
        },
      };
    };

    // C-07 访问日志健康面:写盘失败后日志器会**自我停写** —— 那个状态必须常驻可查。
    // 没有这个出口时,「日志悄悄不记了」只能事后发现(2026-09-27 静默 41.6 分钟那次)。
    // C-07c:形状由"health 或 null"改成**两层** —— 装上了 `{installed:true, ...11 个 health 字段}`,
    //        没装上 `{installed:false, reason}`(老后端仍是没有 audit 字段,前端一个字符都不渲染)。
    //        `enabled` 取宿主侧真实配置:有意关闭时才能说出"已按配置关闭",而不是含糊的"没装上"。
    // 双层兜底(accessLogStatus 抛 ⇒ null):健康面永远不许把 sendJson 带崩。
    // `enabled` 的三级取法(直取 → config 段 → plugin.config 段):DSH 各版本把插件配置放在哪一层
    // 不完全一致,取不到就是 undefined(accessLogStatus 便不会误报"有意关闭" —— 宁可说 not-mounted)。
    const auditHealth = () => {
      try {
        const al = config?.accessLog || config?.config?.accessLog || config?.plugin?.config?.accessLog;
        return accessLogStatus({ enabled: al?.enabled });
      } catch { return null; }
    };

    // GET /health
    disposers.push(register('/health', async (_req, res) => {
      // E0 只读探针:并进既有的 /health(**不开新路由**)—— 验收时不必离线解 zstd 会话日志,
      // 就能看到"追加了几次、跳过了几次、有没有重复"。`limit` 只留最近 8 个会话,免把健康面撑大。
      // E2 可见化(2026-10-01):未知原文来源的留痕也挂在这里(**只在确有告警时**)——
      // 既有 ok/plugin/version/audit/sessionLine 五个键的顺序与取值逐字未动,新键**排在最后**。
      const rawUnknown = rawUnknownSourcesOf();
      sendJson(res, 200, {
        ok: true, plugin: 'dsh-ling', version: config.version, audit: auditHealth(),
        sessionLine: sessionLineProbe(memory, { limit: 8 }),
        ...(rawUnknown ? { rawUnknownSources: rawUnknown } : {}),
      });
    }));

    // ---- 记忆中心 ----
    const memSourceOf = (v) => (MEM_SOURCES.includes(String(v)) ? String(v) : '');

    // GET /memories/sources —— 各来源条数(D8:筛选栏显示「历史网页端 (1523)」,一眼看到库里有什么)
    //                        + 各枝条数(D9-a 记忆分枝:枝名与计数一次带回,省一个往返)
    disposers.push(register('/memories/sources', async (req, res) => {
      const bc = memory.branchCounts();
      const byId = new Map(memory.listBranches().map((b) => [b.id, b]));
      const list = Object.keys(bc.byBranch || {}).map((id) => {
        const b = byId.get(id) || {};
        return {
          id,
          name: String(b.name || (id === TRUNK_ID ? '主干' : id)),
          kind: String(b.kind || (id === TRUNK_ID ? 'trunk' : 'branch')),
          memories: Number(bc.byBranch[id] || 0),
        };
      });
      list.sort((a, b) => (a.id === TRUNK_ID ? -1 : b.id === TRUNK_ID ? 1 : b.memories - a.memories));
      sendJson(res, 200, {
        ok: true,
        ...memory.sourceCounts(),
        trunk: TRUNK_ID,
        branch: { total: bc.total, byBranch: bc.byBranch, list },
      });
    }));

    /** 与 `branchMembers()` **同一谓词**的 per-枝计数(审计 A#6,2026-09-22):
     *  界面上的「N 个会话」此前用 `sessionBranchMap()` 全量聚合 —— 那算的是"**挂在**这条枝下的
     *  会话数",而展开列表(`branchMembers`)只列"**真的有内容**的"(有概述标题 OR 有原文轮次);
     *  于是主干显示 76、点开只有 15 条,数字与列表对不上。
     *  数据层的 `memory.branchMemberCounts()` 用同一谓词算计数,这里**优先采用**它。
     *  ⚠️ 该方法与 api.js 是**跨文件软链**:此刻可能尚未落地 ⇒ 必须 `typeof` 防御,
     *  取不到就退回旧的 `sessionBranchMap` 口径(**降级,不是报错**)。
     *  返回结构做了两种兼容(`mc[id]` 扁平 与 `mc.members[id]` 嵌套)—— 未知形状不该让端点崩。
     *  (定义在 `/branches`、`/tree` 两个用点之前:同文件内少一次"往上找定义"。) */
    const memberCountOf = () => {
      try {
        if (typeof memory.branchMemberCounts !== 'function') return null;
        const raw = memory.branchMemberCounts();
        // ⚠️ 数据层实测返回 { members: Map, sessions: Map, rows: Map, byMembers: 普通对象 }
        // (memory.js:1089)。**Map 用 Object.keys() 取不到任何键** —— 若直接读 raw.members,
        // 会解析出空表、于是所有枝的计数被"清零"(比退回旧口径更糟,A#6 等于反向修坏)。
        // 故:优先 byMembers(普通对象) → 退 raw.members(并在是 Map 时转一次) → 退 raw 本身;
        // 且**解析结果为空时按"取不到"处理**(return null),让调用方退回 session_meta 口径,
        // 而不是把界面上的会话数全显示成 0。
        let src = (raw && typeof raw === 'object') ? raw.byMembers : null;
        if (!src || typeof src !== 'object') {
          src = (raw && typeof raw === 'object') ? raw.members : null;
          if (src instanceof Map) src = Object.fromEntries(src);
        }
        if (!src || typeof src !== 'object') src = (raw && typeof raw === 'object') ? raw : null;
        if (!src || typeof src !== 'object') return null;
        if (src instanceof Map) src = Object.fromEntries(src);
        const out = {};
        for (const k of Object.keys(src)) {
          const n = Number(src[k]);
          if (Number.isFinite(n)) out[String(k)] = n;
        }
        return Object.keys(out).length ? out : null;
      } catch {
        return null; // 计数失败退回旧口径,不影响端点
      }
    };

    // GET /branches —— 枝列表(记忆分枝 D9-a,只读):每条枝带自己的会话数与记忆数。
    //   主干恒在列表首位;枝按建立时间排。界面用它渲染「枝」下拉与枝名标记。
    disposers.push(register('/branches', async (req, res) => {
      const counts = memory.branchCounts().byBranch || {};
      // A#6:与 /tree 同一口径 —— 优先用"同一谓词"的成员计数(取不到则退回 session_meta 计数)。
      const mc = memberCountOf();
      let sessCount = mc;
      if (!sessCount) {
        const sess = memory.sessionBranchMap();
        sessCount = {};
        for (const bid of sess.values()) sessCount[bid] = (sessCount[bid] || 0) + 1;
      }
      const list = memory.listBranches().map((b) => ({
        ...b,
        memories: Number(counts[b.id] || 0),
        sessions: Number(sessCount[b.id] || 0),
      }));
      list.sort((a, b) => (a.id === TRUNK_ID ? -1 : b.id === TRUNK_ID ? 1 : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))));
      sendJson(res, 200, { ok: true, trunk: TRUNK_ID, sessionsBasis: mc ? 'members' : 'session-meta', branches: list });
    }));

    // ---- 记忆树:复盘驱动的树操作(D9-b,2026-09-19) ----
    //
    // 全部操作**不改写任何记忆内容**(设计稿 §4 核心不变量):分枝/并脉/连边只增加"关系"。
    // 复盘界面用 /tree 一次拿全量结构,用下面几个 POST 落地主人与器灵的归类决定。

    const treeCounts = () => {
      const bc = memory.branchCounts();
      const byBranch = bc.byBranch || {};
      // A#6:优先用"同一谓词"的成员计数;该方法不存在/抛错 → 退回 session_meta 计数(软链降级)
      const mc = memberCountOf();
      if (mc) return { total: bc.total, byBranch, sessCount: mc, memberCounts: true };
      const sess = memory.sessionBranchMap();
      const sessCount = {};
      for (const bid of sess.values()) sessCount[bid] = (sessCount[bid] || 0) + 1;
      return { total: bc.total, byBranch, sessCount, memberCounts: false };
    };
    // sessions 用"同一谓词"的成员计数(A#6):数字与「展开」列表里的条数从此一致。
    const treeNode = (n, byBranch, sessCount) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      parentId: n.parentId,
      forkAt: n.forkAt,
      nameLocked: n.nameLocked,
      weightScale: n.weightScale,
      visibility: n.visibility,
      status: n.status,
      createdAt: n.createdAt,
      memories: Number(byBranch[n.id] || 0),
      sessions: Number(sessCount[n.id] || 0),
      children: (n.children || []).map((c) => treeNode(c, byBranch, sessCount)),
    });

    // GET /tree —— 整树(枝/主脉嵌套 + 横向连边 + 计数),复盘界面一次渲染
    disposers.push(register('/tree', async (_req, res) => {
      const t = memory.branchTree();
      const { byBranch, sessCount, total, memberCounts } = treeCounts();
      sendJson(res, 200, {
        ok: true,
        trunk: TRUNK_ID,
        total,
        memories: Number(total || 0),
        // A#6:告诉界面这次 sessions 用的是哪种口径(同一谓词 / 旧的 session_meta 计数降级)
        sessionsBasis: memberCounts ? 'members' : 'session-meta',
        roots: (t.roots || []).map((n) => treeNode(n, byBranch, sessCount)),
        links: t.links || [],
      });
    }));

    // POST /branches/create { name, kind, parentId } —— 手建枝或主脉(kind='vein')
    disposers.push(register('/branches/create', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opBranchCreate(memory, { ...body, actor: 'user' }));
    }));

    // POST /branches/delete { id, force } —— **删枝**(审计 B#4 补的能力)
    //   规则:trunk 不可删;非空枝(有子枝/归属/连边)默认拒绝并回报影响面,`force:true` 才动手
    //   —— force 时归属回退到主干,不留悬空引用。
    disposers.push(register('/branches/delete', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opBranchDelete(memory, { id: body.id, force: body.force, actor: 'user' }));
    }));

    // POST /branches/reparent { id, parentId, name } —— **并脉**:把枝/主干挂到主脉下(内容零变化)
    //   新主脉可当场建(name 非空且 parentId 尚不存在时先建 vein)。
    disposers.push(register('/branches/reparent', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opBranchReparent(memory, { ...body, actor: 'user' }));
    }));

    // POST /branches/rename { id, name, lock }
    disposers.push(register('/branches/rename', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opBranchRename(memory, { ...body, actor: 'user' }));
    }));

    // POST /branches/weight { id, weightScale } —— 复盘时调枝系数(平时只读,设计稿 §3.3)
    disposers.push(register('/branches/weight', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opBranchWeight(memory, { ...body, actor: 'user' }));
    }));

    // GET /branch-log?limit=N —— 复盘留痕(改了什么、为什么;只记结构操作,不记记忆内容)
    disposers.push(register('/branch-log', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const names = new Map(memory.listBranches().map((b) => [b.id, b.name || b.id]));
      const list = memory.listBranchLog({ limit: q.get('limit') || 100 })
        .map((e) => ({ ...e, branchName: names.get(e.branchId) || e.branchId }));
      sendJson(res, 200, { ok: true, total: list.length, log: list });
    }));

    // POST /branch-log/pending —— 复盘守门(2026-09-22 用户:「互相复盘不应该被我绕过」)。
    // 返回"自器灵上次开口以来累积了多少笔结构改动还没交代";侧栏据此提示,
    // 并在未同步时**拦住"退出复盘模式"** —— 改完树必须让器灵有机会看到。
    // ⚠️ 进 `POST_ONLY` 的原因:它不是纯读 —— `memory.branchLogPending()` 在"水位键缺失 +
    // branch_log 非空"时会**一次性把水位补种到当前最大 id**(memory.js:1272)⇒ 一个 GET
    // 就能静默把欠账计数顶成 0(审计差集 26 条里**唯一一条真写**)。前端三处调用点已同步改 POST。
    disposers.push(register('/branch-log/pending', async (req, res) => {
      let r = { watermark: 0, maxId: 0, pending: 0 };
      try {
        if (typeof memory.branchLogPending === 'function') r = memory.branchLogPending();
      } catch { /* 降级为 0,不阻断界面 */ }
      sendJson(res, 200, { ok: true, ...r });
    }));

    // POST /veins/link { from, to, kind, note } / POST /veins/unlink { from, to }
    disposers.push(register('/veins/link', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opVeinLink(memory, { ...body, actor: 'user' }));
    }));
    disposers.push(register('/veins/unlink', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opVeinUnlink(memory, { ...body, actor: 'user' }));
    }));

    // ---- 矛盾标记层(D9-b):检出但**不改写内容**;未复盘 → 以最新为准 ----

    // GET /conflicts?status=pending|confirmed|dismissed —— 待复盘矛盾(带两侧标题,复盘界面直接可读)
    disposers.push(register('/conflicts', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      // 2026-09-21:补两侧**摘要全文** —— 只给标题时人根本判不出"到底哪矛盾"(用户实测反馈)。
      const ovOf = (src, cid) => {
        try { return memory.overviewById(String(src), String(cid)) || null; } catch { return null; }
      };
      // 2026-09-21:涉及归档会话的矛盾不进列表 —— 归档意味着"这条别再提了",
      //   但已登记的旧记录不会自动消失,所以在这里按当前归档状态实时筛(用户实测反馈:
      //   扫描侧上一轮已排除归档,可已存在的记录仍会一直显示)。
      const archSet = memory.archivedConvIdSet();
      const isArch = (side) => side && side.source === 'dsh' && archSet.has(String(side.convId));
      const list = memory.listConflicts({ status: q.get('status') || '', limit: q.get('limit') || 100 })
        .filter((c) => !isArch(c.a) && !isArch(c.b))
        .map((c) => {
          const oa = ovOf(c.a.source, c.a.convId);
          const ob = ovOf(c.b.source, c.b.convId);
          return {
            ...c,
            aTitle: (oa && oa.title) || memory.overviewTitleOf(c.a.convId) || c.a.convId,
            bTitle: (ob && ob.title) || memory.overviewTitleOf(c.b.convId) || c.b.convId,
            aSummary: String((oa && oa.summary) || ''),
            bSummary: String((ob && ob.summary) || ''),
          };
        });
      sendJson(res, 200, { ok: true, total: list.length, conflicts: list });
    }));

    // POST /conflicts/record { a:{source,conv_id}, b:{...}, kind, reason } —— 手工/LLM 检出登记
    disposers.push(register('/conflicts/record', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const a = body.a || {};
      const b = body.b || {};
      const r = memory.recordConflict({
        aSource: a.source, aConvId: a.conv_id || a.convId,
        bSource: b.source, bConvId: b.conv_id || b.convId,
        kind: String(body.kind || 'contradict'),
        detectedBy: String(body.detectedBy || 'user'),
        reason: String(body.reason || ''),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // ---- 一键生成记忆树(D9-b,2026-09-21 与用户定案) ----
    //   两阶段:① 机械分段(零成本、只读) ② 小助手命名 ③ 主人审核后落库。
    //   不变量:不改写任何记忆内容 —— 只建枝/主脉 + 挂会话归属。
    const autoSeg = (gapDays, maxSize) => bucketize(memory.overviewIndex(), { gapDays, maxSize });

    // GET /tree/autobuild/preview?gapDays=14&maxSize=40 —— 机械分段(只读,不调模型)
    disposers.push(register('/tree/autobuild/preview', async (req, res) => {
      const u = new URL(String(req.url || '/'), 'http://x');
      const gapDays = Math.max(1, Math.min(365, Number(u.searchParams.get('gapDays')) || 14));
      const maxSize = Math.max(5, Math.min(200, Number(u.searchParams.get('maxSize')) || 40));
      const buckets = autoSeg(gapDays, maxSize);
      const bySource = {};
      for (const b of buckets) bySource[b.source] = (bySource[b.source] || 0) + 1;
      sendJson(res, 200, {
        ok: true,
        gapDays,
        maxSize,
        total: buckets.length,
        bySource,
        buckets: buckets.map((b) => ({
          id: b.id, source: b.source, count: b.count, from: b.from, to: b.to,
          sample: b.items.slice(0, 16).map((it) => it.title || it.convId),
        })),
      });
    }));

    // POST /tree/autobuild/name { bucketIds?, gapDays?, maxSize?, limit? } —— 给指定簇起名(批量,每次 limit 个)
    disposers.push(register('/tree/autobuild/name', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 审计 B#6:单实例锁 —— 命名批处理逐条调模型,重复入队既浪费引擎额度,
      // 也会让同一簇拿到两份互相覆盖的名字。锁在**任何 await 之前**抢占(同 tick 原子)。
      const run = batchEnter('name');
      if (!run) {
        return sendJson(res, 200, {
          ok: false, reason: 'busy',
          hint: '上一批命名还在跑;请等它结束再点(重复提交会让同一簇被命名两次)',
        });
      }
      try {
        const gapDays = Math.max(1, Math.min(365, Number(body.gapDays) || 14));
        const maxSize = Math.max(5, Math.min(200, Number(body.maxSize) || 40));
        const limit = Math.max(1, Math.min(20, Number(body.limit) || 5));
        const asst = resolveAssistant(settings);
        const probe = await probeAssistant(asst.baseUrl, { timeoutMs: 5000 });
        if (!probe.ok) {
          return sendJson(res, 200, { ok: false, reason: 'assistant-unavailable', hint: '命名需要模型;地址可在「接入历史」里配置' });
        }
        const all = autoSeg(gapDays, maxSize);
        const want = Array.isArray(body.bucketIds) && body.bucketIds.length
          ? new Set(body.bucketIds.map((x) => String(x))) : null;
        const candidates = (want ? all.filter((b) => want.has(b.id)) : all).slice(0, limit);
        // 并发命名:小助手单条命名可能要 10~20 秒,串行 5 条会超过浏览器/网关的容忍时间而被断开
        // (前端表现为 fetch reject → "命名失败(网关)")。并发把总耗时压到 ≈ 最慢的那一条。
        // 审计 B#6 补的总时长上限:整批起跑前先按 deadline 卡一道 —— 若**本身就在超时前**
        // 发起,fork 出来的这一批必然都在 deadline 内开工(不会出现"半批已发、半批被拦")。
        const t0 = Date.now();
        const targets = batchTimeout('name', t0) ? [] : candidates;
        run.total = candidates.length;
        run.done = 0;
        const out = (await Promise.allSettled(targets.map(async (b) => {
          const r = await nameBucket(asst.baseUrl, asst.model, b, { call: summarizeWithRetry });
          run.done += 1;
          return {
            bucketId: b.id, source: b.source, count: b.count, from: b.from, to: b.to,
            ok: !!r.ok, name: r.name || '', note: r.note || '', error: r.error || null,
          };
        }))).filter((x) => x.status === 'fulfilled').map((x) => x.value);
        const timedOut = candidates.length > targets.length;
        run.timedOut = timedOut;
        sendJson(res, 200, {
          ok: true,
          named: out.filter((x) => x.ok).length,
          failed: out.filter((x) => !x.ok).length,
          dropped: candidates.length - targets.length, // 因总时长上限**未开工**的簇数
          timedOut,
          engine: String((asst && asst.model) || ''),
          ms: Date.now() - t0,
          items: out,
        });
      } finally {
        batchLeave('name');
      }
    }));

    // POST /tree/autobuild/apply { plan:[{bucketId,mode:'branch'|'vein',name,parentId}] } —— 落库(只建结构)
    disposers.push(register('/tree/autobuild/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const gapDays = Math.max(1, Math.min(365, Number(body.gapDays) || 14));
      const maxSize = Math.max(5, Math.min(200, Number(body.maxSize) || 40));
      const plan = Array.isArray(body.plan) ? body.plan.slice(0, 200) : [];
      if (!plan.length) return sendJson(res, 200, { ok: false, reason: 'empty-plan' });
      // ⚠️ 审计 B#10:plan 里的 `parentId` / `mode` 此前**零校验** ——
      //   ① 未知 parentId(已删的枝、前端缓存的旧 id、伪造的裸 uuid)被 `createBranch` 原样塞进
      //      `parent_id`,`branchTree()` 里找不到父节点 ⇒ **被当成根节点**,凭空多出一棵"野树";
      //   ② 同一个 bucketId 在 plan 里出现两次会**重复建枝**(同一批会话被挂两遍,归属互相覆盖)。
      //   `mode` 无需白名单:非 'vein' 一律走 branch(旧行为已是这个语义,保持兼容)。
      const branchMap = mapBranchList(memory.listBranches());
      const byId = new Map(autoSeg(gapDays, maxSize).map((b) => [b.id, b]));
      const seenBucket = new Set();
      let badParent = 0;
      let duplicate = 0;
      const created = [];
      let assigned = 0;
      let skipped = 0;
      // 零散合簇(用户 2026-09-21 裁决):名字含「零散」的簇统一挂到同一个主脉「零散会话」下。
      //   理由:历史网页端的一次性问答主题天然分散、不属于任何工作线;合并成一簇后可在
      //   复盘时展开细化(设计稿 §10.3)。主脉按名复用,不重复建。
      const ZERO_NAME = '零散会话';
      let zeroVeinId = null;
      const zeroVeinOf = () => {
        if (zeroVeinId) return zeroVeinId;
        const exist = memory.listBranches().find((x) => x.kind === 'vein' && x.name === ZERO_NAME);
        zeroVeinId = exist ? exist.id : memory.createVein({ name: ZERO_NAME });
        if (!exist) memory.logBranch(zeroVeinId, 'autobuild', { after: ZERO_NAME, note: '零散会话合簇(自动创建)' });
        return zeroVeinId;
      };
      for (const p of plan) {
        const key = String(p.bucketId || '');
        const b = byId.get(key);
        const name = String(p.name || '').trim().slice(0, 60);
        if (!b || !name) { skipped += 1; continue; }
        // 去重(审计 B#10②):一个簇只落一条枝 —— 同批里第二次出现直接跳过,不重复建、不重复挂。
        if (seenBucket.has(key)) { duplicate += 1; skipped += 1; continue; }
        const wantParent = String(p.parentId || '');
        let parentId;
        if (/零散/.test(name) && !wantParent) {
          parentId = zeroVeinOf(); // 零散簇的既有裁决优先(见上)
        } else if (wantParent && wantParent !== TRUNK_ID && !branchMap.has(wantParent)) {
          // 未知父(审计 B#10①):不落"父不存在的枝" —— 那在 branchTree() 里会被当成根节点。
          // 与 memory.reparentBranch 的 `no-parent` 纪律一致:跳过并计数,由调用方决定是否用 trunk 重试。
          badParent += 1;
          skipped += 1;
          continue;
        } else {
          parentId = wantParent || TRUNK_ID;
        }
        const mode = String(p.mode || 'branch');
        const bid = mode === 'vein'
          ? memory.createVein({ name, parentId })
          : memory.createBranch({ name, parentId, kind: 'branch' });
        seenBucket.add(key);
        // 归属两条链(方案 A,2026-09-21):
        //   dsh 会话 → session_meta(D9-a 既有链路,零变化);
        //   其余源(dsweb/import)→ conv_branch 覆盖层 —— 它们不是 DSH 会话,推不出枝。
        let n = 0;
        for (const it of b.items) {
          if (it.source === 'dsh') memory.setSessionBranch(it.convId, bid);
          else memory.setConvBranch(it.source, it.convId, bid);
          n += 1;
          assigned += 1;
        }
        memory.logBranch(bid, 'autobuild', { after: name, note: '一键生成:' + b.source + ' ' + b.count + ' 条(挂上 ' + n + ')' });
        created.push({ id: bid, name, mode, parentId, source: b.source, count: b.count, assigned: n });
      }
      sendJson(res, 200, {
        ok: true,
        created,
        assigned,
        skipped,
        // 审计 B#10:把"为什么少建了"分类回报,否则调用方只看到 created 比 plan 短,无从判断
        // 是自己发了重复项、还是引用了已删的父枝。
        duplicate,
        badParent,
        zeroVein: zeroVeinId,
        note: '归属已写入 ' + assigned + ' 条(DSH 会话走 session_meta,历史网页端/导入条目走 conv_branch 覆盖层)'
          + (zeroVeinId ? ';零散簇已合并到主脉「' + ZERO_NAME + '」' : '')
          + (duplicate ? ';已忽略 ' + duplicate + ' 条重复 bucketId' : '')
          + (badParent ? ';已跳过 ' + badParent + ' 条父枝不存在的项(未知 parentId 不落枝)' : ''),
      });
    }));

    // POST /branches/gather { pattern='零散', veinName='零散会话' }
    //   —— 把**已存在**的枝按名字归并到同一个主脉下(幂等,可重复跑)。
    //   为什么需要它:一键生成树在旧逻辑下已经建出多个「零散记录」枝,`/tree/autobuild/apply`
    //   的合簇只对**新应用**生效,追不回存量;本端点负责把存量收进主脉。
    //   同时它也是复盘期的批量归类原语:把名字含某关键词的枝一次归到一个主脉。
    disposers.push(register('/branches/gather', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const pattern = String(body.pattern || '零散').trim().slice(0, 30);
      const veinName = String(body.veinName || '零散会话').trim().slice(0, 60);
      if (!pattern) return sendJson(res, 200, { ok: false, reason: 'empty-pattern' });
      const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc);
      let vein = memory.listBranches().find((x) => x.kind === 'vein' && x.name === veinName);
      let veinCreated = false;
      if (!vein) {
        const vid = memory.createVein({ name: veinName });
        memory.logBranch(vid, 'gather', { after: veinName, note: '归并目标主脉(自动创建)' });
        vein = { id: vid, name: veinName };
        veinCreated = true;
      }
      const moved = [];
      for (const b of memory.listBranches()) {
        if (b.id === vein.id || b.kind === 'vein') continue;
        if (!re.test(String(b.name || ''))) continue;
        if (String(b.parentId || '') === String(vein.id)) continue; // 已就位,幂等跳过
        const r = memory.reparentBranch(b.id, vein.id);
        if (r && r.ok) {
          memory.logBranch(b.id, 'gather', {
            before: String(b.parentId || 'trunk'),
            after: String(vein.id),
            note: '归并到主脉「' + veinName + '」(匹配 ' + pattern + ')',
          });
          moved.push({ id: b.id, name: String(b.name || '') });
        }
      }
      sendJson(res, 200, {
        ok: true, vein: vein.id, veinName, veinCreated,
        moved: moved.length, movedList: moved.slice(0, 60),
        note: moved.length ? ('已把 ' + moved.length + ' 条含「' + pattern + '」的枝归并到主脉「' + veinName + '」')
          : (veinCreated ? ('已建主脉「' + veinName + '」,但没有匹配的枝') : '没有需要归并的枝(已就位)'),
      });
    }));

    // ---- 树的保存 / 恢复(R1,2026-09-22)+ 会话级展开(R2) ----

    /** 从 req.url 取查询参数(不依赖 URL 类,与既有 GET 端点同风格)。 */
    const qArg = (url, key) => {
      const m = new RegExp('[?&]' + key + '=([^&]*)').exec(String(url || ''));
      if (!m) return '';
      // 审计 B#7:畸形百分号编码(如 `?limit=%E0%A4%A`)会让 decodeURIComponent 抛 URIError
      // —— 旧实现直接冒到 guard 的 catch,变成 500;这里退化为原样返回(端点自己会做数值校验)。
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return String(m[1] || '');
      }
    };

    // GET /tree/snapshots?limit=N —— 快照列表(不带快照体 —— 体可能很大)
    disposers.push(register('/tree/snapshots', async (req, res) => {
      const limit = Number(qArg(req.url, 'limit') || 50);
      sendJson(res, 200, { ok: true, snapshots: memory.listTreeSnapshots({ limit }) });
    }));

    // ---- 主脉提炼(R7,2026-09-23) ----
    // 设计稿 §5:主脉装的是"从多条枝里看出来的共性",不是任何子枝的内容。
    // 三条硬约束:① 走审核队列(不直接进记忆) ② 标注派生来源 ③ 与并脉解耦(并脉只建结构)。
    const DISTILL_SYS = '你在帮主人整理长期记忆树。下面给你一条「主脉」及其子枝上的若干条记忆摘要。'
      + '请只输出一段 60~160 字的中文结论,指出这些记忆里**共同的**规律、方法或结论 —— '
      + '不是逐条复述,也不要把标题罗列一遍。若它们之间确实没有明显共性,就直说「暂未看出共性」。'
      + '不要 markdown,不要编号,不要引号。';

    // GET /vein/suggestions?status=new&veinId=&limit=N —— 提炼候选(审核队列)
    disposers.push(register('/vein/suggestions', async (req, res) => {
      const status = String(qArg(req.url, 'status') || 'new');
      const veinId = String(qArg(req.url, 'veinId') || '');
      const limit = Number(qArg(req.url, 'limit') || 50);
      sendJson(res, 200, { ok: true, suggestions: memory.listVeinSuggestions({ status, veinId, limit }) });
    }));

    // POST /vein/distill { veinId, limit, chars } —— 取子枝概述 → 模型提炼 → 存候选队列
    disposers.push(register('/vein/distill', async (req, res) => {
      // ── C-06(1.5.1 红蓝对抗,E2 是它的界面那一端):**单实例锁** ────────────────
      // 锁必须在 `readBody` **之前**抢:`batchEnter` 是同步的(同 tick 原子),而 `await readBody`
      // 就是本处理器的第一个让出点 —— 放到它后面,两个并发请求都能先读完 body、
      // 再一起冲进模型调用,锁等于没上(与 `/tree/autobuild/name` 的同一条纪律)。
      // 复用的是本文件已有的那一套(BATCH_RUN / batchEnter / batchLeave / batchTimeout,
      // 见顶部注释与 `/conflicts/judge`、`/tree/autobuild/name` 两处用法),不另发明:
      // 这样 `busy` 的 reason 文案与响应形态与客户端既有处理完全一致。
      const run = batchEnter('distill');
      if (!run) {
        return sendJson(res, 200, {
          ok: false, reason: 'busy',
          hint: '上一条主脉的提炼还在跑(模型调用要几十秒);等它出结果再提炼 —— 重复提交会产出重复候选',
        });
      }
      let timedOut = false;
      // 下面这一整段的缩进**保持原样不重排**:本批只加"锁 + deadline"两件事,
      // 便于逐行对照原实现审查(锁定/释放的边界一眼可见)。
      try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const veinId = String(body.veinId || '').trim();
      if (!veinId) { sendJson(res, 400, { ok: false, reason: 'no-vein' }); return; }
      const v = memory.listBranches().find((b) => String(b.id) === veinId);
      if (!v) { sendJson(res, 404, { ok: false, reason: 'vein-not-found' }); return; }
      if (String(v.kind || '') !== 'vein') {
        sendJson(res, 400, { ok: false, reason: 'not-a-vein', hint: '只有主脉才能提炼;普通枝请先并到主脉下' });
        return;
      }
      const mat = memory.veinMaterial(veinId, { limit: body.limit, chars: body.chars });
      if (!mat.length) {
        sendJson(res, 200, {
          ok: false, reason: 'no-material',
          hint: '这条主脉下还没有带摘要的记忆 —— 先把枝并进来,或多聊几句让概述器生成摘要',
        });
        return;
      }
      const text = '主脉名称:' + String(v.name || veinId) + '\n\n素材(共 ' + mat.length + ' 条):\n'
        + mat.map((m, i) => (i + 1) + '. ' + (m.title || m.convId) + ' —— ' + m.summary).join('\n');
      const t0 = Date.now();
      // 全局大模型(2026-09-25 用户:「你在给自己做整理,别让小助手代劳」)。
      // 原先走本机小助手(summarizeWithRetry + /no_think),但"这几条枝讲的是不是一件事"
      // 是**判断**不是搬砖 —— 该用器灵自己的脑;小助手留给压缩/分类这类机械活。
      //
      // ⚠️ 换通路时漏改判据,盘上实际踩过(2026-09-25 深夜,现象是"模型调用失败"):
      //   `llmOnce` 返回 `{ text, chunkLog, target }` —— **既没有 `ok` 也没有 `summary`**。
      //   旧判据 `!r.ok` 因此恒为真 ⇒ 每次提炼都判失败(error 回退成 'empty'),而模型其实答了;
      //   末尾 `String(r.summary)` 还会把回执 text 写成字面量 "undefined"。
      //   教训:**换通路必须连返回形态与判据一起改**(与 A4 同一次改动的残留半截)。
      // 空回复是真实存在的(llmOnce 内部不重试)—— 照 habit-gen.reflectWithRetry 的成例分档重试。
      const DISTILL_TRIES = [
        { effort: 'off', maxTokens: 1200 },
        { effort: 'low', maxTokens: 2400 },
        { effort: 'off', maxTokens: 2400, cap: 12000 },
      ];
      const attempts = [];
      let distilled = '';
      let lastErr = '';
      run.total = DISTILL_TRIES.length;
      for (const att of DISTILL_TRIES) {
        // C-06 的后半句"无总超时":整批 deadline —— 到点**不再开始下一次尝试**
        // (在飞的那一次仍会收尾 ⇒ 总耗时上界 = 总上限 + 单次最坏耗时,与 judge/name 同口径)。
        if (batchTimeout('distill', t0)) { timedOut = true; break; }
        const material = att.cap ? text.slice(0, att.cap) : text;
        try {
          const rr = await llmOnce(ctx, { system: DISTILL_SYS, text: material, maxTokens: att.maxTokens, effort: att.effort });
          const got = String((rr && rr.text) || '').trim();
          attempts.push({ effort: att.effort, maxTokens: att.maxTokens, chars: material.length, ok: !!got, len: got.length });
          if (got) { distilled = got; break; }
        } catch (e) {
          lastErr = String(e?.message ?? e);
          attempts.push({ effort: att.effort, maxTokens: att.maxTokens, chars: material.length, ok: false, error: lastErr });
        }
      }
      run.done = attempts.length;
      run.timedOut = timedOut;
      if (!distilled) {
        // 超时截断与"模型答了空"要分开报:前者重试/稍后再试有用,后者重试无用。
        sendJson(res, 200, {
          ok: false, reason: timedOut ? 'timeout' : 'llm-failed',
          error: timedOut ? 'deadline' : (lastErr || 'empty'),
          timedOut, attempts, ms: Date.now() - t0,
        });
        return;
      }
      const saved = memory.addVeinSuggestion({
        veinId,
        text: distilled,
        sources: mat.map((m) => m.source + '/' + m.convId),
        model: 'global',
        note: '素材 ' + mat.length + ' 条',
      });
      if (saved.ok) {
        memory.logBranch(veinId, 'distill', { after: '候选 #' + saved.id, note: '提炼出候选(待审核),素材 ' + mat.length + ' 条' });
      }
      sendJson(res, 200, {
        ok: !!saved.ok, id: saved.id, text: distilled,
        materials: mat.length, ms: Date.now() - t0, reason: saved.reason, attempts, timedOut,
      });
      } finally {
        // 释放必须走 finally(审计 B#6 的纪律:抛异常时更不能把锁永久留下)。早退的每一条
        // (no-vein / vein-not-found / not-a-vein / no-material / 模型失败)都会经过这里。
        batchLeave('distill');
      }
    }));

    // POST /vein/suggestion/resolve { id, action, text, note } —— 采纳(写入主脉记忆)/驳回
    /** 候选行的 `vein_id`(只读;A-06 与 A-12 两个前置判据都要先知道"这条候选指向哪条主脉")。
     *  为什么不走 `listVeinSuggestions`:它只有 status/veinId/limit 三个筛、默认 50 条上限,
     *  按 id 精确定位要翻页,反而更脆。直读 `memory.db` 在本文件有先例(见 `/dsh/backfill`)。 */
    const sugVeinOf = (sid) => {
      try {
        const row = memory.db.prepare('SELECT vein_id FROM vein_suggestions WHERE id=?').get(sid);
        return row ? String(row.vein_id || '') : '';
      } catch { return ''; }
    };
    /** E9:失败原因 → 中文。与客户端 `delSnapshot` 的既有分工一致(见 client.js 的
     *  `SNAP_DEL_REASON` / `snapDelReason`:后端带 message 就用它,前端只在自己那张表里兜底)。 */
    const VEI_SUG_MSG = {
      'bad-id': '候选编号不对',
      'not-found': '这条候选不存在(可能已经处理过了)',
      'bad-action': '动作只认「采纳」或「驳回」',
      'empty-text': '候选正文是空的 —— 没有可写入的内容',
      'no-vein': '这条候选没记录所属主脉,结论无处安放',
      'vein-not-found': '这条候选所属的主脉已被删除 —— 结论无处安放(请驳回它,或对现存的主脉重新提炼)',
      'archive-failed': '旧版主脉记忆归档失败 —— 为免覆盖后回不去,本次采纳已中止',
      'db': '记忆库写入错误',
    };
    disposers.push(register('/vein/suggestion/resolve', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = Number(body.id);
      const act = String(body.action || '').trim().toLowerCase();
      // ── A-06(1.5.1 红蓝对抗):采纳的判据落在**真实存在性**上 ────────────────────
      // 候选指向的主脉被删之后,`resolveVeinSuggestion` 照旧会写 conv_overview,并回
      // `ok:true` + `branchId=<已删枝>` —— 因为底层 `assignConv`(memory.js 的 `assignConv`)
      // 把 `setConvBranch` 的 `{ok:false, reason:'no-branch'}` **吞掉了**(它只 try/catch 了读归属
      // 那半句,写入的返回值根本没看)⇒「归属已写」是句谎话,那条主脉记忆实际落回主干。
      // 判据放在端点层(与上面 B#3 那几处存在性检查同一取舍:零回归面、不动 memory.js):
      // 采纳前先确认候选所属的主脉**此刻还在 branch 表里**,不在就如实拒收、**一个字节都不写库**。
      const veinId = Number.isFinite(sid) ? sugVeinOf(sid) : '';
      let veinAlive = true;
      if (act === 'accept' && veinId) {
        veinAlive = memory.listBranches().some((b) => String(b.id) === veinId);
        if (!veinAlive) {
          return sendJson(res, 200, {
            ok: false, reason: 'vein-not-found', veinId,
            message: VEI_SUG_MSG['vein-not-found'],
            hint: '候选悬空(主脉已删)',
          });
        }
      }
      // ── A-12(1.5.1 红蓝对抗):先记下"这条主脉记忆的名字是否已经定过" ──────────────
      // 「锁」的确切语义(DESIGN.md:title_locked「锁住的是自动重写,**不锁主人**」):
      // `title_locked=1` 只让 `upsertOverview` 不动 title,summary 照样被覆盖 ⇒ 主人手改过名字的
      // 那条主脉记忆,下次采纳会把**正文**换掉、名字留着 —— 名字是对的,内容却换了人写,而回执里
      // 只有一个 `replaced`。这把锁**不该由端点扩权去挡主人**(采纳本就是主人的显式动作,
      // 前面还有解锁门),该做的是**把这件事说出来**:动手前读一次定名状态,动手后如实回报。
      let naming = null;
      if (act === 'accept' && veinId && veinAlive) {
        try {
          const prev = memory.overviewById('vein', veinId);
          if (prev && prev.title_locked) {
            naming = { title: String(prev.title || ''), titleBy: String(prev.title_by || ''), locked: true };
          }
        } catch { /* 读不到就当没定名:不因此拒绝采纳 */ }
      }
      const r = memory.resolveVeinSuggestion(sid, { action: body.action, text: body.text, note: body.note });
      if (!r.ok) {
        // E9:把英文内部码也译一份中文出去。`ok` / `reason` **逐字不动**(前端可能仍在读 reason,
        // 兼容优先),只**增**一个 message;底层已带 message 的(如 archive-failed)优先用它。
        sendJson(res, 200, { ...r, message: r.message || VEI_SUG_MSG[r.reason] || ('操作失败:' + String(r.reason || '未知')) });
        return;
      }
      // A-01(1.5.1):「覆盖旧版主脉记忆」必须在**总变动日志**里留痕 —— 否则主人只看得到
      // "采纳了一条",不知道旧的被换掉了、也不知道旧版去了哪个归档目录。
      const accepted = r.status === 'accepted';
      memory.logBranch(String(r.veinId || ''), 'vein-adopt', {
        after: accepted ? (r.replaced ? '已采纳(覆盖旧版)' : '已采纳') : '已驳回',
        note: accepted && r.replaced
          ? ('覆盖了上一版主脉记忆(' + r.replaced.prevChars + ' 字);旧版已归档 ' + r.replaced.dir)
          : '主脉提炼候选',
      });
      // ── A-06 的后半:归属**真的**落库了吗(不信任底层回执,自己看一遍) ────────────
      // 前置门之后仍复核一次:改动小、代价低,而它挡的正是"回执说写了、库里没有"这类谎话。
      if (accepted && String(memory.branchOfConv('vein', String(r.veinId || '')) || '') !== String(r.veinId || '')) {
        sendJson(res, 200, {
          ...r, branchId: '', assigned: false,
          message: '记忆已写入,但没能挂到主脉下(主脉可能刚被删除)—— 它现在按主干显示',
        });
        return;
      }
      // ── E10(1.5.1 红蓝对抗):「覆盖了上一版」与「名字已定过还被换正文」这两件事此前
      // **前端零提示**(A-01 已把 replaced 回传、也留了痕,但界面上看不出来)。
      // 后端把话说全,前端照 `message` 显示(前端那半见另一批改动)。
      const out = { ...r };
      if (accepted) {
        out.assigned = true;
        if (naming) {
          out.naming = naming;
          out.message = '已采纳 —— 主脉记忆的正文换成了新提炼的结论;名字「' + naming.title + '」'
            + (naming.titleBy === 'user' ? '是你手改过的' : '已由机器定过') + ',按约定保持不动'
            + (r.replaced ? ';旧版正文已归档:' + r.replaced.dir : '');
        } else if (r.replaced) {
          out.message = '已采纳 —— **覆盖了上一版主脉记忆**(旧版已归档:' + r.replaced.dir + '),不是新增一条';
        }
      }
      sendJson(res, 200, out);
    }));

    // POST /tree/snapshot { name, note } —— 存一份当前树结构(只存结构,不存记忆内容)
    // ⚠️ 审计 B#5:单份快照约 217KB 且**此前无任何条数上限** ⇒ 反复调用可让 DB 无限膨胀。
    // 加软上限:到顶时裁掉**最旧的一条**。
    // ⚠️ 审计 A#9 的交互(2026-09-22):`deleteTreeSnapshot` 现在**拒绝删掉最后一份
    //   `kind='auto'` 的快照**(那是撤回上次树恢复的唯一退路)。旧清理只盯"最旧一条",
    //   若它恰好是最后一份 auto,删除被拒 —— 而这里为了"清理失败不该挡住保存"包着 try/catch,
    //   于是**静默失效**、快照继续增长、软上限形同虚设。
    //   修法:清理时**优先裁非 auto 的最旧一条**;没有可裁的(全是 auto 备份)就
    //   **跳过本轮** —— 宁可暂时超上限,也不去动那条唯一的退路。
    const MAX_TREE_SNAPSHOTS = 60;
    disposers.push(register('/tree/snapshot', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opSnapshotTree(memory, { ...body, actor: 'user' }, { maxSnapshots: MAX_TREE_SNAPSHOTS }));
    }));

    // POST /tree/restore { id } —— 恢复树结构;恢复前**自动存一份当前状态**(返回 backupId)
    disposers.push(register('/tree/restore', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opRestoreTree(memory, { ...body, actor: 'user' }));
    }));

    // POST /tree/snapshot/delete { id }
    disposers.push(register('/tree/snapshot/delete', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opDeleteSnapshot(memory, { id: body.id, actor: 'user' }));
    }));

    // GET /branch/members?id=<branchId>&limit=N —— 会话级展开(R2):该枝下的会话/条目
    disposers.push(register('/branch/members', async (req, res) => {
      const id = String(qArg(req.url, 'id') || TRUNK_ID);
      const limit = Number(qArg(req.url, 'limit') || 300);
      sendOp(res, opBranchMembers(memory, { id, limit }));
    }));

    // POST /branch/assign { source, convId, branchId } —— 拖动会话/条目改归属(R2/R3)
    disposers.push(register('/branch/assign', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opAssignConv(memory, { ...body, actor: 'user' }));
    }));

    // POST /conflicts/resolve { id, winner:'a'|'b'|null, status:'confirmed'|'dismissed' }
    disposers.push(register('/conflicts/resolve', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendOp(res, opConflictResolve(memory, { ...body, actor: 'user' }));
    }));

    // POST /conflicts/judge { limit } —— **复盘环节**:让模型读两侧摘要全文,判定这条候选到底是什么。
    //   启发式(2-gram)只能找"措辞重复";判"同题反结论"必须读懂意思 ⇒ 这一步只能交给模型。
    //   分批(默认 5 条,上限 20),前端循环调用并显示进度 —— 避免一个长任务把 HTTP 连接拖死。
    //   unrelated → 直接驳回(清洗假阳性);duplicate / contradict → 回写性质,留给主人裁定。
    const JUDGE_SYS = '你在帮主人整理长期记忆。下面给你两条记忆的摘要(A 和 B)。'
      + '请判断它们的关系,只回一个词:\n'
      + '- unrelated:讲的是不同的事(哪怕用词相近)\n'
      + '- duplicate:讲的是同一件事\n'
      + '- contradict:讲的是同一件事但结论相反\n'
      + '只回那一个词,不要解释,不要标点。';
    const parseVerdict = (s) => {
      const t = String(s || '').toLowerCase();
      if (t.includes('contradict')) return 'contradict';
      if (t.includes('duplicate')) return 'duplicate';
      if (t.includes('unrelated')) return 'unrelated';
      return 'unknown';
    };
    disposers.push(register('/conflicts/judge', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const limit = Math.max(1, Math.min(20, Number(body.limit) || 5));
      // 审计 B#6:单实例锁(同 name 批处理)—— 前端"循环调用直到 left=0"时,
      // 上一批还在跑就再发一批,会让同一条矛盾被判定两次(`setConflictKind` 后写覆盖先写)。
      const run = batchEnter('judge');
      if (!run) {
        return sendJson(res, 200, {
          ok: false, reason: 'busy',
          hint: '上一批判定还在跑;请等它返回结果里的 left 变成 0 再收尾',
        });
      }
      try {
        const asst = resolveAssistant(settings);
        const probe = await probeAssistant(asst.baseUrl, { timeoutMs: 5000 });
        if (!probe.ok) return sendJson(res, 200, { ok: false, reason: 'assistant-unavailable', hint: '小助手不可用时可跳过模型判定,直接人工裁定' });
        const pend = memory.listConflicts({ status: 'pending', limit: 200 });
        const t0 = Date.now();
        const done = [];
        let left = 0;
        let timedOut = false;
        run.total = pend.length;
        run.done = 0;
        for (const c of pend) {
          if (done.filter((d) => !d.skip).length >= limit) { left += 1; continue; }
          // 审计 B#6:整批总时长上限 —— 到点**不再开始新的一条**,直接把剩余数回报出去
          // (在飞的那一条会收尾,所以总耗时上界 = 总上限 + 单条最坏耗时,不会无限挂)。
          if (batchTimeout('judge', t0)) { timedOut = true; left += 1; continue; }
          const pickOv = (src, cid) => { try { return memory.overviewById(String(src), String(cid)) || null; } catch { return null; } };
          const oa = pickOv(c.a.source, c.a.convId);
          const ob = pickOv(c.b.source, c.b.convId);
          const ta = String((oa && oa.summary) || '').trim().slice(0, 700);
          const tb = String((ob && ob.summary) || '').trim().slice(0, 700);
          if (!ta || !tb) { done.push({ id: c.id, skip: 'no-summary' }); continue; }
          let verdict = 'unknown';
          let why = '';
          try {
            const r = await summarizeWithRetry(asst.baseUrl, asst.model, {
              text: 'A:\n' + ta + '\n\nB:\n' + tb,
              system: JUDGE_SYS,
            });
            verdict = parseVerdict(r && r.summary);
            why = String((r && r.summary) || '').slice(0, 200);
          } catch (e) {
            verdict = 'unknown';
            why = String(e?.message ?? e).slice(0, 120);
          }
          // 保守:只对明确判定动作,unknown 一律不动(宁可留给人工,也不误驳回)。
          if (verdict === 'unrelated') memory.resolveConflict(c.id, { status: 'dismissed' });
          else if (verdict === 'duplicate' || verdict === 'contradict') {
            memory.setConflictKind(c.id, { kind: verdict, detectedBy: 'llm', reason: why });
          }
          done.push({ id: c.id, verdict });
          run.done += 1;
        }
        run.timedOut = timedOut;
        sendJson(res, 200, {
          ok: true,
          judged: done.filter((d) => !d.skip).length,
          skipped: done.filter((d) => d.skip).length,
          left,
          timedOut,
          engine: String((asst && asst.model) || ''),
          items: done,
        });
      } finally {
        batchLeave('judge');
      }
    }));

    // POST /conflicts/scan { limit, threshold } —— 启发式检出**重复**(duplicate)
    //   范围刻意收窄:只扫最近的 dsh/import 概述(不含 dsweb 海量短会话),两两比 2-gram Jaccard。
    //   语义矛盾(反结论)检出需要 LLM 判读,不在本端点假装能做 —— 它产出的是待复盘候选。
    disposers.push(register('/conflicts/scan', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const limit = Math.max(10, Math.min(200, Number(body.limit) || 60));
      const threshold = Math.max(0.3, Math.min(0.95, Number(body.threshold) || 0.55));
      // 2026-09-21:排除**已归档**会话 —— 封存的对话不该再被拉出来互相判矛盾(用户实测反馈)。
      const archived = memory.archivedConvIdSet();
      const rows = memory.queryOverviews({ limit }).items
        .filter((r) => r.source === 'dsh' || r.source === 'import')
        .filter((r) => !archived.has(String(r.conv_id)))
        .filter((r) => String(r.summary || '').trim().length >= 20);
      const grams = (s) => {
        const t = String(s).replace(/[\s\p{P}]+/gu, '');
        const g = new Set();
        for (let i = 0; i + 2 <= t.length; i++) g.add(t.slice(i, i + 2));
        return g;
      };
      const sets = rows.map((r) => grams(r.summary));
      const found = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const A = sets[i]; const B = sets[j];
          if (!A.size || !B.size) continue;
          let inter = 0;
          for (const g of A) if (B.has(g)) inter++;
          const jac = inter / (A.size + B.size - inter);
          if (jac >= threshold) {
            const rec = memory.recordConflict({
              aSource: rows[i].source, aConvId: rows[i].conv_id,
              bSource: rows[j].source, bConvId: rows[j].conv_id,
              kind: 'duplicate', detectedBy: 'heuristic',
              score: Number(jac.toFixed(3)),
              reason: `2-gram Jaccard ${jac.toFixed(3)} ≥ ${threshold}`,
            });
            found.push({ a: rows[i].conv_id, b: rows[j].conv_id, score: Number(jac.toFixed(3)), id: rec.id, reopened: !!rec.reopened });
          }
        }
      }
      sendJson(res, 200, { ok: true, scanned: rows.length, threshold, found: found.length, pairs: found.slice(0, 50) });
    }));

    // GET /memories?source=&category=&q=&sort=&limit=&offset=
    disposers.push(register('/memories', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const r = memory.queryOverviews({
        source: q.get('source') || undefined,
        category: q.get('category') || undefined,
        q: q.get('q') || undefined,
        sort: q.get('sort') || 'updated',
        branch: q.get('branch') || undefined,
        limit: q.get('limit') || undefined,
        offset: q.get('offset') || undefined,
      });
      sendJson(res, 200, { ok: true, ...r });
    }));

    // POST /memories/pin { source, conv_id, pin }
    disposers.push(register('/memories/pin', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      if (!memory.overviewById(src, body.conv_id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
      memory.setImportance(src, body.conv_id, body.pin === false ? 0 : 1);
      sendJson(res, 200, { ok: true, source: src, conv_id: body.conv_id, pinned: body.pin !== false });
    }));

    // POST /memories/delete { source, conv_id }
    disposers.push(register('/memories/delete', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      const existed = !!memory.overviewById(src, body.conv_id);
      if (existed) memory.deleteOverview(src, body.conv_id);
      sendJson(res, 200, { ok: true, existed });
    }));

    // POST /memories/rename { source, conv_id, title, lock? }
    // 主人手改标题(D2):默认上锁(title_locked=1) —— 概述器重建、批量重命名此后都不再覆盖。
    disposers.push(register('/memories/rename', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      if (!memory.overviewById(src, body.conv_id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
      const r = memory.renameTitle(src, body.conv_id, body.title, { lock: body.lock !== false });
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.reason || 'rename-failed' });
      touchMemoryVersion(memory);
      sendJson(res, 200, { ok: true, source: src, conv_id: body.conv_id, title: r.title, locked: r.locked });
    }));

    // POST /memories/retitle { source, conv_id, baseUrl?, model?, heuristic? }
    // 用小助手给一条记忆起名(D2)。**机器起的名字同样上锁** —— 2026-09-17 实测教训:
    // 不上锁时,跑在旧代码里的概述器一轮增量重建就把 AI 起的名字覆盖回"首句硬截 46 字"的半句。
    // 已上锁的行**允许**再次起名(用户点按钮=显式意图),结果仍是"定过的名字"。
    disposers.push(register('/memories/retitle', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      const ov = memory.overviewById(src, body.conv_id);
      if (!ov) return sendJson(res, 404, { ok: false, error: 'not-found' });
      const t0 = Date.now();
      // heuristic:true 走纯启发式(不调模型) —— 小助手不可用时的兜底,也是测试用的稳定路径
      if (body.heuristic === true) {
        const h = heuristicRetitle(memory, { source: src, conv_id: body.conv_id });
        if (h.ok) {
          memory.renameTitle(src, body.conv_id, h.title, { lock: true, by: 'ai' });
          touchMemoryVersion(memory);
        }
        return sendJson(res, h.ok ? 200 : 502, {
          ok: h.ok, source: src, conv_id: body.conv_id, title: h.title || '',
          engine: 'heuristic', error: h.error || null, ms: Date.now() - t0,
        });
      }
      // 引擎(D2/S7):默认 auto —— 优先本机小助手(零成本),探测不到才落全局大模型;
      // 实际用了哪个写回响应(engine/note),不做"静默换引擎"。
      const want = body.engine === 'global' ? 'global' : body.engine === 'assistant' ? 'assistant' : 'auto';
      const asst = resolveAssistant(settings);   // S7:settings → 环境变量 → 内置默认(loopback)
      let engine = want;
      let note = '';
      if (want === 'auto') {
        const probe = await probeAssistant(String(body.baseUrl || asst.baseUrl));
        engine = probe.ok ? 'assistant' : 'global';
        note = probe.ok ? '' : '本机小助手不可用(' + probe.reason + ' @ ' + asst.baseUrl + ') → 本次改用当前全局大模型';
      }
      const r = engine === 'global'
        ? await retitleOneGlobal(ctx, { memory, source: src, conv_id: body.conv_id })
        : await retitleOne(String(body.baseUrl || asst.baseUrl), String(body.model || asst.model), {
          memory, source: src, conv_id: body.conv_id,
        });
      if (r.ok) touchMemoryVersion(memory);
      sendJson(res, r.ok ? 200 : 502, {
        ok: r.ok, source: src, conv_id: body.conv_id, title: r.title || '',
        engine, from: r.source || engine, note: note || undefined,
        error: r.error || null, ms: r.ms || (Date.now() - t0),
      });
    }));

    // ---- S7(2026-09-18 与用户定):小助手(本机小模型)地址 —— 三级覆盖 ----
    // 一个路径按 method 分派(平台的 exact 路由表不允许同 path 注册两次):
    //   GET  /assistant/config → 生效值 + **来源**(settings/env/default) + 各级候选值(不做网络探测,秒回)
    //   POST /assistant/config { baseUrl?, model?, clear? } → 只写这两个键(不开放任意设置写入)
    // 真实探测在 /assistant/test。
    disposers.push(register('/assistant/config', async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.clear === true) {
          await settings.update({ assistant: { baseUrl: '', model: '' } });
        } else {
          const patch = {};
          if (body.baseUrl !== undefined) {
            const v = String(body.baseUrl || '').trim();
            if (v && !/^https?:\/\//i.test(v)) {
              return sendJson(res, 400, {
                ok: false, error: 'bad-url',
                message: '地址需以 http:// 或 https:// 开头(留空 = 回到环境变量 / 内置默认)',
              });
            }
            patch.baseUrl = v.slice(0, 300);
          }
          if (body.model !== undefined) patch.model = String(body.model || '').trim().slice(0, 120);
          if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'nothing-to-update' });
          await settings.update({ assistant: patch });
        }
        const after = resolveAssistant(settings);
        return sendJson(res, 200, { ok: true, baseUrl: after.baseUrl, model: after.model, source: after.source });
      }
      const asst = resolveAssistant(settings);
      return sendJson(res, 200, {
        ok: true,
        baseUrl: asst.baseUrl, model: asst.model, source: asst.source,
        configured: asst.configured, env: asst.env, defaults: asst.defaults,
      });
    }));

    // POST /assistant/test { baseUrl?, model? } —— 探活(不改配置);UI 的「测试连通」用
    disposers.push(register('/assistant/test', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const asst = resolveAssistant(settings);
      const baseUrl = String(body.baseUrl || asst.baseUrl).trim();
      const probe = await probeAssistant(baseUrl, { timeoutMs: 5000 });
      sendJson(res, 200, {
        ok: probe.ok, baseUrl, model: String(body.model || asst.model),
        reason: probe.reason || null, models: probe.models || [],
        // 填错地址最常见的两种:忘了 /v1、把它当成文件夹路径 —— 按形态给不同的提示
        hint: probe.ok ? null : (String(baseUrl).includes('/v1')
          ? '确认小助手(Ollama)已启动,且该地址从本机可达 —— 要带 http:// 前缀与端口(默认 11434)。'
          : '这个地址看起来少了 /v1 结尾(Ollama 的 OpenAI 兼容端点在 /v1/models,而 /models 不存在)。'
            + '单机自用填 http://127.0.0.1:11434/v1;小助手在别的机器上就把 127.0.0.1 换成那台的 IP。'),
      });
    }));

    // POST /mode/toggle { sessionId?, mode?, defaultOnly?, confirm? }
    //   全局默认那半(无 sessionId / defaultOnly):**必须带 confirm:true** 才落笔 —— 不带只回预览
    disposers.push(register('/mode/toggle', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const wantDefault = body.defaultOnly === true;
      const sessionId = wantDefault ? null : (body.sessionId || gate.recentSessionId());
      if (!sessionId) {
        // 全局默认路径(无会话或显式 defaultOnly):
        // ① 平台默认模型(agent-default-model)→ 只同步**推理等级**;模型原样保留
        // ② 自有 lastMode(D2 跟随源)
        // ⚠️ 走这条动的是**平台全局默认模型**(新会话都跟随),不是本会话 —— 故 1.5.2 起 fail-closed:
        //   没带 confirm:true 的请求**一个字节都不写**,只回一份"将要变什么"的预览(界面据此把后果
        //   念给主人听,再带着 confirm 发第二次)。凭据不在就不动手 —— 与定型门(seal.js)同一条纪律。
        const cur = settings.get().mode?.lastMode === 'work' ? 'work' : 'life';
        const next = body.mode && ['work', 'life'].includes(body.mode) ? body.mode : (cur === 'work' ? 'life' : 'work');
        const cfg = resolveModeConfig(settings.get(), next); // 只含 reasoningEffort
        const adm = svc(ctx, 'agentDefaultModel');
        const keep = currentModelSelection(ctx); // 当前模型:原样带回,不改
        const admSel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
        // 平台默认档位的"改前值":没设置过就是 null,不假装知道
        const prevEffort = admSel && admSel.reasoningEffort != null ? String(admSel.reasoningEffort) : null;
        if (body.confirm !== true) {
          return sendJson(res, 200, {
            ok: false, reason: 'confirmation-required', applied: 'none', defaultOnly: true,
            sessionId: null, from: cur, mode: next, lastMode: cur,
            globalDefault: keep ? keep.provider + '/' + keep.model : null,
            reasoningEffort: { from: prevEffort, to: cfg.reasoningEffort },
            message: '这会改**全局默认模型**(新会话都跟随),不是只改当前会话 —— 确认后再发一次(带 confirm:true)。',
          });
        }
        let warning;
        if (adm && typeof adm.saveSelection === 'function') {
          if (!keep) {
            warning = 'unknown-current-model; 默认推理等级未同步(拒绝替用户指定模型)';
            console.debug('[dsh-ling]', warning);
          } else {
            try {
              // saveSelection 需要完整选择(provider/model 必填)→ 只替换 reasoningEffort
              await adm.saveSelection({ provider: keep.provider, model: keep.model, reasoningEffort: cfg.reasoningEffort });
            } catch (e) {
              warning = 'default-model sync failed: ' + String(e?.message ?? e);
              console.debug('[dsh-ling] saveSelection warning', warning);
            }
          }
        } else {
          warning = 'agentDefaultModel unavailable; new-session effort not synced';
          console.debug('[dsh-ling]', warning);
        }
        const s2 = await settings.update({ mode: { lastMode: next } });
        // 修法 A 补完:空会话(无真人输入)语义上"跟随默认",默认变了 → 它们的快照必须失效;
        // 有内容的旧会话保持自己的模式(不动)。running 的走 stale,空闲则立即重建。
        const refreshed = [];
        for (const sid of allSnapshotSessionIds(gate)) {
          if (memory.hasUserTurns(sid)) continue;
          const r2 = invalidateSession(gate, memory, settings, sid);
          refreshed.push({ sessionId: sid, ...r2 });
        }
        return sendJson(res, 200, {
          ok: true, mode: next, applied: 'default-only', sessionId: null,
          lastMode: s2.mode.lastMode, platformDefaultSynced: !warning, warning,
          emptySessionsRefreshed: refreshed.length,
          // 回显(1.5.2 U8):把"改的是哪个全局默认、档位从什么变成什么、模型有没有被碰"原样交代,
          // 界面据此回执 —— 主人不必再去设置页核对到底动了什么。
          from: cur, globalDefault: keep ? keep.provider + '/' + keep.model : null,
          modelKept: !!keep,
          reasoningEffort: { from: prevEffort, to: cfg.reasoningEffort },
        });
      }
      const cur = currentMode(memory, settings, sessionId);
      const next = body.mode && ['work', 'life'].includes(body.mode) ? body.mode : (cur === 'work' ? 'life' : 'work');
      const r = await applyModeToSession(ctx, gate, memory, settings, sessionId, next);
      if (r.ok && !r.queued) invalidateSession(gate, memory, settings, sessionId);
      else if (r.ok && r.queued) gate.markSnapStale(sessionId); // 运行中:排队;空闲后重建会读新模式
      sendJson(res, 200, { ok: r.ok, ...r, running: gate.isRunning(sessionId) });
    }));

    // GET /state?sessionId=&scope=global&l0Preview=1&previewPersona=&previewStyles=
    // §6.1(a):`/state` 的 `personaInfo` **按渠道分流** —— 带代理头(经反代/远端)的请求不回承诺句,只回 hasSeal。
    //   判据在 `readIsLocal` 一处;两个调用点(stateForGlobal / stateFor)同一条路,不会有一条漏掉。
    disposers.push(register('/state', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const local = readIsLocal(req);
      if (q.get('scope') === 'global') return sendJson(res, 200, stateForGlobal(q, local));
      const sessionId = reqSessionId(req.url) || gate.recentSessionId();
      if (!sessionId) return sendJson(res, 200, stateForGlobal(q, local));
      sendJson(res, 200, stateFor(sessionId, { l0Preview: q.get('l0Preview') === '1', q, local }));
    }));

    // POST /persona  字段补丁 → settings + 全局失效(按冻结门)
    // 定型门(承诺句版):sealed 后动 persona/styles 需带 unlock=定型时亲手写下的句子(哈希比对);
    //   上锁(sealed:true)需带新承诺句 → 覆盖哈希;撤锁清哈希;每次成功变更后存「结果档案」。
    disposers.push(register('/persona', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // ── 手术门(第 1/14 条写面)────────────────────────────────────────────────
      // 载荷必须**在这里**交上去:请求流只能读一次(见 guard 里的接线说明)。
      // 只交 `unlock` 一项:门只读它(§1.3 判据 3)。把整份 patch 交上去 = 让留痕的"字段指纹"
      // 记下一串与判据无关的内容(越少记越好;要留痕的是"这次手术",不是"他改成了什么")。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona' })) return;
      const raw = clampBottomLines(body.patch && typeof body.patch === 'object' ? body.patch : body);
      // 2026-09-17 加固④(G10):白名单收窄 —— 补丁只能落在 persona / styles 两棵子树内。
      // 此前 body 被原样深合并进 settings.json,`{"guard":{"enforce":false}}` 可持久化关停本守卫。
      const { clean: patch, dropped } = sanitizePersonaPatch(raw);
      if (dropped.length) console.warn('[dsh-ling] /persona 丢弃白名单外的字段: %s', dropped.join(', '));
      const cur = settings.get();
      const wantLock = patch.persona?.sealed === true;
      const doUnseal = patch.persona?.sealed === false;
      if (touchesPersona(patch)) {
        // ── 2026-09-30 深夜(手术门):**删掉 `wasSealed` 绕过分支**(侦察 F9)──────────
        // 旧代码在这里是二选一:`wantLock` 直接采纳"新承诺句"、`wasSealed` 才验原句 ——
        // 而 `wantLock` 分支排在 `wasSealed` **之前**,于是"带着 sealed:true 的补丁"能跳过验句。
        // 现在:已定型时**所有**写入都由手术门(本机 + 每启动票据 + 原句)统一判过(见上面 gateSurgery),
        // 走到这一行只可能是"未定型"⇒ 这里只剩"首次上锁"这一种正当语义。
        if (wantLock) {
          const k = String(body.unlock || '').trim();
          if (k.length < KEY_MIN) return sendJson(res, 200, { ok: false, reason: 'sealed', message: '上锁需先亲手写下一句 ≥' + KEY_MIN + ' 字的承诺句(明文保存,仅供解锁界面回显提醒)。' });
          patch.persona.sealPhrase = k; // 首次上锁:记下这句承诺
        }
        if (doUnseal) patch.persona.sealPhrase = ''; // 永久撤锁 → 清句
      }
      const s2 = await settings.update(patch);
      const histKey = touchesPersona(patch) ? await archivePersona(s2, 'result') : null;
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true,
        affected,
        lastMode: s2.mode?.lastMode,
        sealed: s2.persona?.sealed === true,
        hasSeal: !!s2.persona?.sealPhrase,
        bottomCapped: raw._bottomCapped === true,
        ignored: dropped.length ? dropped : undefined,
        histKey,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /persona/check { unlock }  客户端「解锁修改」先验钥(只读,不落盘)
    // 进 `POST_ONLY` 是**防御性**:今天 GET 下 body 恒为 `{}` ⇒ 只回"承诺句不一致"(无写),
    // 但 handler 读 body、注释也自称 POST ⇒ 形态已经是 POST 端点,补进去零成本。
    disposers.push(register('/persona/check', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cur = settings.get();
      // 手术门(第 2/14 条写面):**这一条本身不写** —— 它是"验句预言机"(在线猜句的入口)。
      // 门口径与别处**完全一致**:已定型 ⇒ 必须本机 + 带票 + 原句,否则连"这句对不对"都不告诉它
      // (改前它对任意调用者有求必应 ⇒ 猜句成功率只受网络延迟限制)。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/check' })) return;
      if (cur.persona?.sealed !== true) {
        return sendJson(res, 200, { ok: true, valid: true, sealed: false, message: '档案未定型' });
      }
      const g = sealOk(cur.persona, body.unlock);
      sendJson(res, 200, {
        ok: true, valid: g.pass, sealed: true, adopt: !!g.adoptKey,
        message: g.pass ? (g.adoptKey ? '旧档案无明文:这句话将被采纳为定型承诺句' : '承诺句一致') : MSG_KEY,
      });
    }));

    // GET /persona/history  人格档案存档(每次保存后的结果;回滚前另有 pre-rollback 档)
    // §6.1(a):**读时过滤** —— 存档内容一个字都不改写(那是人读的档、也是回滚的档),
    //   只在**出站这一层**按渠道剔除承诺句(经代理 ⇒ 剥掉并补 hasSeal / sealPhraseHidden)。
    disposers.push(register('/persona/history', async (req, res) => {
      const local = readIsLocal(req);
      const items = memory.kvList('persona.hist.').map((r) => {
        const k = String(r.key);
        let v = null;
        try { v = JSON.parse(String(r.value)); } catch {}
        return { ts: Number(k.slice('persona.hist.'.length)) || null, persona: personaForRead(v?.persona ?? null, local), styles: v?.styles ?? null, kind: v?.kind || 'result' };
      }).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
      sendJson(res, 200, { ok: true, items });
    }));

    // POST /persona/self-summary { text }  自我总结成长通道(自由生长的一部分):
    //   无论是否定型,只允许更新 persona.aiTitle(定位自述)单字段;其余字段仍需手术/承诺句。
    disposers.push(register('/persona/self-summary', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 3/14 条写面):身份自述 aiTitle 属身份保护区。只交 unlock(见 /persona 处说明)。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/self-summary' })) return;
      const text = String(body.text ?? '').trim();
      if (!text) return sendJson(res, 200, { ok: false, reason: 'empty', message: '内容为空' });
      if (text.length > 500) return sendJson(res, 200, { ok: false, reason: 'long', message: '自述过长(≤500 字)' });
      const cur = settings.get();
      const histKey = await archivePersona(cur, 'result');
      const s2 = await settings.update({ persona: { aiTitle: text } });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true, affected, histKey, chars: text.length,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /persona/hint-adopt { text }  诞生建议(语气建议/相处观察)采纳:
    //   属"成长回路"—— 建议中心里按下那一下 = 确认,故走「提议 → 确认」状态机落到**习惯**
    //   (习惯不能直达;这里的用户点击就是确认动作),重量前先归档。
    disposers.push(register('/persona/hint-adopt', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 4/14 条写面):一次点击即 propose+confirm 落一条习惯。只交 unlock。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/hint-adopt' })) return;
      const text = String(body.text ?? '').trim();
      if (text.length < 4 || text.length > 400) {
        return sendJson(res, 200, { ok: false, reason: 'bad', message: '内容需在 4~400 字之间' });
      }
      const existing = habitsOf(settings).some((h) => String(h.text).replace(/\s+/g, '') === text.replace(/\s+/g, ''));
      if (existing) {
        return sendJson(res, 200, { ok: true, exists: true, habits: habitsOf(settings).length, message: '这条已经是习惯里的了' });
      }
      const histKey = await archivePersona(settings.get(), 'result');
      const prop = await proposeHabit({ settings, habit: text, evidence: '建议中心采纳', byUser: true });
      if (!prop.ok) return sendJson(res, 200, { ok: false, reason: prop.reason, message: '未记入:' + prop.reason });
      const done = await resolveHabit({ settings, id: prop.id, action: 'confirm' });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const s2 = settings.get();
      sendJson(res, 200, {
        ok: done.ok, affected, histKey,
        habits: habitsOf(settings).length,
        warning: done.warning,
        l0PreviewText: l0WithClock(s2, s2.mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // ---- 规矩 / 习惯(2026-09-15 定稿:指令直达,人格不直达)----
    // GET /persona/rules  规矩 + 习惯 + 待确认提议(面板用)
    disposers.push(register('/persona/rules', async (_req, res) => {
      sendJson(res, 200, { ok: true, ...rulesView(settings) });
    }));

    // POST /persona/rule { action:'add'|'remove', rule, quote? }
    //   规矩直达:add 必须带原话(quote);remove 只需正文。
    //   ⚠️ E3(审计 H-4):"add 必须带原话"**只对会话内调用成立** —— 主人在**面板**里亲手敲的
    //      (请求形状:无 sessionId、无 quote)本来就不需要另附原话(他自己敲的就是同意)。
    //      "去掉 quote"**不再等于**"来自面板":归因只由 ruleWriteAttribution() 一处判(见文件头)。
    disposers.push(register('/persona/rule', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 5+6/14 条写面:add 与 remove 同一端点,一次判过):
      //   规矩是他的指令(quote 是"经同意"的凭据),但**删规矩能整批删光** ⇒ 一律过门。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/rule' })) return;
      const action = String(body.action || 'add');
      if (action === 'remove') {
        const r = await removeRule({ settings, rule: body.rule });
        return sendJson(res, 200, r.ok
          ? { ok: true, ...r, affected: invalidateAllSummaries() }
          : { ok: false, reason: r.reason, message: '没有这条规矩' });
      }
      if (action !== 'add') return sendJson(res, 200, { ok: false, reason: 'bad-action' });
      // ── E3(审计 H-4):归因判据只在 ruleWriteAttribution() 一处 ──────────────────────
      //   被删掉的旧写法:`source: body.quote ? 'session' : 'panel'` —— 用"有没有 quote"
      //   反推"谁写的",于是**会话内、不带 quote 的 HTTP 调用**被贴成 'panel'
      //   (= 冒充主人亲手写的那一条:rules.js 据此免掉原话要求,原话位填成「(面板直接写入)」)。
      const attr = ruleWriteAttribution(body);
      const r = await addRule({
        settings, rule: body.rule, quote: attr.quote, sessionId: attr.sessionId, source: attr.source,
      });
      const message = !r.ok
        ? {
          'no-quote': '规矩必须附上原话(你说的那一句)才能写入 —— 这是"经同意"的凭据。',
          'empty-rule': '规矩内容为空。',
          'too-long': `规矩太长(上限 ${RULE_MAX_CHARS} 字),请压缩成一条短句。`,
          duplicate: '已有同义规矩,未重复写入。',
        }[r.reason] || ('未写入:' + r.reason)
        : undefined;
      sendJson(res, 200, {
        ok: r.ok, ...r, message, affected: r.ok ? invalidateAllSummaries() : [],
        // 归因如实回传:面板 = 主人亲手写 / 会话内带原话 / 会话内无原话 —— 调用方不必再猜
        // rules.js 的 'panel' 是什么意思。`unquoted` 只在"会话内且没有原话"时为真。
        source: attr.source,
        ...(attr.source === 'session-no-quote' && r.ok
          ? { unquoted: true, note: '这次写入来自会话内调用、且没有原话 —— 留痕按「会话内调用」记,不是面板写入,也不是"经同意"。' }
          : {}),
      });
    }));

    // POST /persona/habit { action:'propose'|'confirm'|'reject'|'remove', habit?, evidence?, id? }
    //   习惯不直达:propose(任一方可提)/ confirm(对方点头)/ reject / remove。
    disposers.push(register('/persona/habit', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 7+8/14 条写面:propose/confirm/reject 与 remove 同一端点,一次判过)。
      // 改前只有 remove 过门 —— "加比删容易"正是侦察里指出的不对称,现在两条都过门。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/habit' })) return;
      const action = String(body.action || 'propose');
      if (action === 'propose') {
        const r = await proposeHabit({
          settings, habit: body.habit, evidence: body.evidence, byUser: body.byUser !== false,
        });
        return sendJson(res, 200, {
          ok: r.ok, ...r,
          message: r.ok
            ? '已作为候选记下,确认后才成为习惯'
            : (r.reason === 'pending-full'
              ? `待确认的习惯已经有 ${r.pending} 条(上限 ${r.limit})—— 先处理完这些,再看新的。`
              : ('未记录:' + r.reason)),
        });
      }
      if (action === 'confirm' || action === 'reject') {
        const r = await resolveHabit({ settings, id: body.id, action });
        return sendJson(res, 200, { ok: r.ok, ...r, affected: r.ok ? invalidateAllSummaries() : [] });
      }
      if (action === 'remove') {
        // 习惯属于她:删改属"对她做手术" —— 已定型时由上面的手术门统一判过(本机 + 每启动票据 + 原句),
        // 这里不再自己重判一遍(旧代码在此处另有一份 sealOk 判据:同一判据两份实现 = 迟早漂移)。
        const r = await removeHabit({ settings, habit: body.habit });
        return sendJson(res, 200, { ok: r.ok, ...r, affected: r.ok ? invalidateAllSummaries() : [] });
      }
      sendJson(res, 200, { ok: false, reason: 'bad-action' });
    }));

    // POST /persona/habits/scan  通道 A:零模型,扫"跨会话重复出现的纠正"→ 落成习惯候选(待确认)
    //   阈值:同类纠正 ≥4 次 且 跨 ≥3 个会话(单次会话里被说三遍不算模式;口径与变更记录见 habit-gen.js 的 SCAN_DEFAULTS)
    disposers.push(register('/persona/habits/scan', async (_req, res) => {
      try {
        // 上限(2026-09-16 定案):待确认满了就**明确驳回**,并说明为什么 —— 不排队、不静默丢弃。
        const capS = pendingMaxOf(settings);
        const pendS = habitsPendingOf(settings).length;
        if (pendS >= capS) {
          return sendJson(res, 200, {
            ok: false, reason: 'pending-full', pending: pendS, limit: capS,
            message: `待确认的习惯已经有 ${pendS} 条(上限 ${capS})—— 先把手上的处理完(认可 / 先不要),再看新的。`,
          });
        }
        const cands = scanCorrections(memory);
        if (!cands.length) {
          return sendJson(res, 200, {
            ok: true, found: 0, proposed: 0, skipped: [],
            message: `没发现"跨会话重复"的纠正信号(阈值:同类 ≥${SCAN_DEFAULTS.minHits} 次且跨 ≥${SCAN_DEFAULTS.minSessions} 个会话)。`,
          });
        }
        const proposed = [];
        const skipped = [];
        for (const c of cands) {
          const r = await proposeHabit({ settings, habit: c.rule, evidence: evidenceOf(c), byUser: false });
          if (r.ok) proposed.push({ id: r.id, text: c.rule, hits: c.hits, sessions: c.sessions, evidence: evidenceOf(c) });
          else skipped.push({ text: c.rule, reason: r.reason, hits: c.hits });
        }
        sendJson(res, 200, {
          ok: true, found: cands.length, proposed: proposed.length, skipped, items: proposed,
          message: proposed.length
            ? `从纠正记录里长出 ${proposed.length} 条习惯候选(等你确认)`
            : '候选都已经在习惯里或待确认列表里了',
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'scan', message: '扫描失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /persona/habits/reflect  通道 B:让她"回想最近的相处" → 1~5 条习惯候选(一次 LLM,只提议不落盘)
    // 手动触发,材料给足:主人真人原话 + 记忆概述 + 纠正统计 + 她现状(默认预算 20 万字符,可用 settings.habits.reflect* 覆盖)
    disposers.push(register('/persona/habits/reflect', async (_req, res) => {
      try {
        // 上限(2026-09-16 定案):与 scan 同一条规则 —— 满了明确驳回,不排队、不静默丢弃。
        const capR = pendingMaxOf(settings);
        const pendR = habitsPendingOf(settings).length;
        if (pendR >= capR) {
          return sendJson(res, 200, {
            ok: false, reason: 'pending-full', pending: pendR, limit: capR,
            message: `待确认的习惯已经有 ${pendR} 条(上限 ${capR})—— 先把手上的处理完(认可 / 先不要),再让她看新的。`,
          });
        }
        const hs = settings.get()?.habits || {};
        // 注意:scanCorrections 用的是"展开覆盖"语义,传 undefined 会把默认值顶掉 —— 只在有值时传
        const scanOpts = {};
        if (hs.scanMinHits != null) scanOpts.minHits = Number(hs.scanMinHits) || SCAN_DEFAULTS.minHits;
        if (hs.scanMinSessions != null) scanOpts.minSessions = Number(hs.scanMinSessions) || SCAN_DEFAULTS.minSessions;
        const scan = summarizeScan(scanCorrections(memory, scanOpts));
        // 轮询游标:每次读上一轮没读过的那一段;读满一圈回到最新(kv 持久化,跨会话累计)
        let cursor = null;
        try { cursor = JSON.parse(memory.kvGet('habits.reflect.cursor') || 'null') || null; } catch { cursor = null; }
        const { text: material, stats, nextCursor } = buildReflectMaterial(memory, {
          scan,
          rules: settings.get()?.persona?.hardRules || [],
          habits: settings.get()?.persona?.habits || [],
          overviewLimit: hs.reflectOverviewLimit,
          turnLimit: hs.reflectTurnLimit,
          budgetChars: hs.reflectBudgetChars,
          cursor,
        });
        try { if (nextCursor) memory.kvSet('habits.reflect.cursor', JSON.stringify(nextCursor)); } catch { /* 游标没存上只影响下一轮,不影响本次 */ }
        const cov = stats?.coverage ? ` ${stats.coverage}` : '';
        if (!material) {
          return sendJson(res, 200, {
            ok: false, reason: 'empty',
            message: pronounize('没有可回想的材料 —— 先接入一些历史,她才有相处的痕迹可读。', pronounOf(settings.get())),
          });
        }
        const eff = hs.reflectEffort || REFLECT_DEFAULTS.effort;
        const maxTok = Number(hs.reflectMaxTokens) || REFLECT_DEFAULTS.maxTokens;
        const { text, attempts, retried } = await reflectWithRetry(
          (o) => llmOnce(ctx, o),
          { system: pronounize(HABIT_REFLECT_SYS, pronounOf(settings.get())), material, maxTokens: maxTok, effort: eff },
        );
        const cands = parseReflect(text, { max: Number(hs.reflectMaxHabits) || REFLECT_DEFAULTS.maxHabits });
        // 每次运行都留一条运行记录(不只是空回复时):否则"跑了但没结果"这类问题只能靠猜
        // —— 2026-09-16 实测:上一版只在空回复时写 kv,结果连"跑没跑、读到什么"都查不到。
        try {
          const first = attempts[0] || {};
          memory.kvSet('habits.reflect.last', JSON.stringify({
            at: new Date().toISOString(),
            round: cursor?.round ?? 1,
            materialChars: material.length,
            maxTokens: maxTok,
            effort: eff,
            retried: !!retried,
            textLen: String(text || '').length,
            empty: !String(text || '').trim(),
            candidates: cands.length,
            target: first.target ? `${first.target.provider}/${first.target.model}` : null,
            attempts: (attempts || []).map((a) => ({
              tag: a.tag, effort: a.effort, chars: a.chars, ms: a.ms, ok: a.ok, len: a.len,
              chunkTypes: a.chunkTypes, error: a.error ? String(a.error).slice(0, 200) : undefined,
            })),
            coverage: stats?.coverage || null,
          }));
        } catch { /* 运行记录没写上不影响主流程 */ }
        if (!cands.length) {
          const empty = !String(text || '').trim();
          const first = attempts[0] || {};
          if (empty) {
            // 空回复必须留下"为什么":否则只能靠猜(旧版就是这样瞒了一整天)
            try {
              memory.kvSet('habits.reflect.debug', JSON.stringify({
                at: new Date().toISOString(), materialChars: material.length, maxTokens: maxTok, effort: eff, attempts, stats,
              }));
            } catch { /* 诊断没写上不影响主流程 */ }
          }
          const tgt = first.target ? `${first.target.provider}/${first.target.model}` : '(未知目标模型)';
          const chunks = Array.isArray(first.chunkTypes) && first.chunkTypes.length ? first.chunkTypes.join(',') : '(无 chunk)';
          return sendJson(res, 200, {
            ok: true, found: 0, proposed: 0, skipped: [], items: [], material: stats, retried,
            message: pronounize(`她读完${cov},觉得还不足以长出一条习惯(宁缺勿滥)。`, pronounOf(settings.get())) +
              (empty
                ? `(模型没有返回内容:目标 ${tgt} · 材料 ${material.length} 字 · ${maxTok} token · chunk=[${chunks}]` +
                  `${retried ? ' · 已用 off 档 + 裁短材料重试一次仍空' : ''};诊断已存 kv habits.reflect.debug —— ` +
                  '多半是材料超出当前模型上下文,或思考档吃掉了预算:可调小 reflectBudgetChars 或提高 reflectMaxTokens)'
                : ''),
          });
        }
        const proposed = [];
        const skipped = [];
        for (const c of cands) {
          const r = await proposeHabit({ settings, habit: c.text, evidence: c.evidence || '她回想最近的相处时归纳', byUser: false });
          if (r.ok) proposed.push({ id: r.id, text: c.text, evidence: c.evidence });
          else skipped.push({ text: c.text, reason: r.reason });
        }
        sendJson(res, 200, {
          ok: true, found: cands.length, proposed: proposed.length, skipped, items: proposed, material: stats,
          message: proposed.length
            ? pronounize(`她回想${cov},提出 ${proposed.length} 条习惯候选(等你确认)`, pronounOf(settings.get()))
            : '候选都已经在习惯里或待确认列表里了',
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'reflect', message: '回想失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // ---- 语气 P1(自性类 = 自由生长,锁定下免手术)----
    // POST /persona/tone-advice  按记忆分类(工作侧知识 / 生活侧情感)归纳两档语气候选(只读,不落盘)
    disposers.push(register('/persona/tone-advice', async (_req, res) => {
      try {
        const pnTone = pronounOf(settings.get());
        const workSide = sampleToneRows(memory, { side: 'work', limit: 40, pronoun: pnTone });
        const lifeSide = sampleToneRows(memory, { side: 'life', limit: 40, pronoun: pnTone });
        const srcWork = buildGenesisSource(workSide.rows, { cap: 9000 });
        const srcLife = buildGenesisSource(lifeSide.rows, { cap: 9000 });
        if (!srcWork && !srcLife) {
          return sendJson(res, 200, { ok: false, reason: 'empty', message: pronounize('记忆库还是空的——先接入历史,她才有可观察的素材。', pronounOf(settings.get())) });
        }
        const material = '【工作侧材料(知识/技术为主)】\n' + (srcWork || '(无)') +
          '\n\n【生活侧材料(情感/日常为主)】\n' + (srcLife || '(无)');
        const { text } = await llmOnce(ctx, {
          system: pronounize(TONE_ADVICE_SYS, pronounOf(settings.get())),
          text: material,
          maxTokens: 1000,
          effort: 'low',
        });
        let result = parseToneAdvice(text);
        let raw = text;
        if (!result.work.tone && !result.life.tone) {
          // 一次强化重试:明确只输出 JSON、tone 用小写英文枚举
          const retry = await llmOnce(ctx, {
            system: '只输出一个 JSON 对象,不要 markdown 围栏、不要解释。格式:{"work":{"tone":"natural|literary|concise|playful","note":"…","evidence":"…"},"life":{…}}。tone 必须是小写英文枚举之一,禁止中文。',
            text: material,
            maxTokens: 1000,
            effort: 'off',
          });
          raw = retry.text;
          result = parseToneAdvice(retry.text);
        }
        if (!result.work.tone && !result.life.tone) {
          // 留下原始输出,便于定位(可在同一位置读 kv 查看)
          memory.kvSet('tone.advice.debug', JSON.stringify({
            at: new Date().toISOString(),
            raw: String(raw || '').slice(0, 1200),
            sampled: { work: workSide.sampled, life: lifeSide.sampled },
          }));
          return sendJson(res, 200, {
            ok: false, reason: 'parse',
            message: '模型没给出可用的语气建议(原始输出已留存)。再试一次,或看看这次它说了什么:' + String(raw || '').slice(0, 120),
          });
        }
        memory.kvSet('tone.advice.last', JSON.stringify({ at: new Date().toISOString(), result, sampled: { work: workSide.sampled, life: lifeSide.sampled } }));
        sendJson(res, 200, {
          ok: true, result,
          sampled: { work: workSide.sampled, life: lifeSide.sampled, workPool: workSide.pool, lifePool: lifeSide.pool },
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '归纳失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /persona/grow { tone?: {work?,life?,default?}, styleAppend?: {work?,life?} }
    //   自性类成长通道:白名单字段(语气枚举 + 风格追加),锁定下亦可采纳;不可逆操作一律不做。
    disposers.push(register('/persona/grow', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 9/14 条写面):改语气 / 追加风格注 —— 旧注释自陈"锁定下亦可采纳",那正是缺口。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/grow' })) return;
      const patch = {};
      const toneIn = body.tone && typeof body.tone === 'object' ? body.tone : {};
      if (toneIn.default && TONE_SET.includes(String(toneIn.default))) patch.tone = String(toneIn.default);
      if (toneIn.work && TONE_SET.includes(String(toneIn.work))) patch.toneWork = String(toneIn.work);
      if (toneIn.life && TONE_SET.includes(String(toneIn.life))) patch.toneLife = String(toneIn.life);
      const styleIn = body.styleAppend && typeof body.styleAppend === 'object' ? body.styleAppend : {};
      const cur = settings.get();
      const styles = { ...(cur.styles || {}) };
      let appended = false;
      for (const side of ['work', 'life']) {
        const note = String(styleIn[side] ?? '').trim();
        if (!note) continue;
        const next = appendStyleNote(styles[side], note);
        if (next !== styles[side]) { styles[side] = next; appended = true; }
      }
      if (!Object.keys(patch).length && !appended) {
        return sendJson(res, 200, { ok: false, reason: 'noop', message: '没有可应用的有效更改(语气需为四档之一,风格注只追加不覆盖)' });
      }
      const histKey = await archivePersona(cur, 'result');
      const s2 = await settings.update(appended ? { persona: patch, styles } : { persona: patch });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, affected, histKey, appended,
        tone: { tone: s2.persona?.tone, toneWork: s2.persona?.toneWork, toneLife: s2.persona?.toneLife },
        l0PreviewText: l0WithClock(s2, s2.mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /persona/rollback { ts, unlock? }  回滚到某历史存档(同样受定型门约束)
    disposers.push(register('/persona/rollback', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 10/14 条写面):整体回写 {persona,styles}(含 sealed/sealPhrase)——
      // 回滚到定型前快照 = **撤锁**,故判据必须在"看存档是否存在"之前:格式不对的请求也不该探到存档。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/persona/rollback' })) return;
      const ts = Number(body.ts);
      const raw = ts ? memory.kvGet('persona.hist.' + ts) : null;
      if (!raw) return sendJson(res, 200, { ok: false, reason: 'notfound', message: '存档不存在' });
      let snap = null;
      try { snap = JSON.parse(String(raw)); } catch {}
      if (!snap || !snap.persona) return sendJson(res, 200, { ok: false, reason: 'bad', message: '存档内容损坏' });
      const cur = settings.get();
      const g = cur.persona?.sealed === true ? sealOk(cur.persona, body.unlock) : { pass: true, adoptKey: null };
      if (!g.pass) return sendJson(res, 200, { ok: false, reason: 'sealed', message: MSG_KEY });
      await archivePersona(cur, 'pre-rollback'); // 回滚前再留一份当前档案,可再反悔
      const patch2 = { persona: { ...snap.persona }, styles: { ...(snap.styles || {}) } };
      if (g.adoptKey) patch2.persona.sealPhrase = g.adoptKey; // 旧档案无明文:采纳当前键入句子
      const s2 = await settings.update(patch2);
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true, affected, sealed: s2.persona?.sealed === true,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /memory/refresh { sessionId? }
    disposers.push(register('/memory/refresh', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sessionId = body.sessionId || null;
      if (sessionId) {
        return sendJson(res, 200, { ok: true, ...invalidateSession(gate, memory, settings, sessionId) });
      }
      const affected = allSnapshotSessionIds(gate).map((sid) => ({ sessionId: sid, result: invalidateSession(gate, memory, settings, sid) }));
      sendJson(res, 200, { ok: true, affected });
    }));

    // GET /import/history  导入记录(三条入口共用:文件导入 / 本机 DSH 扫描 / 网页端库扫描)
    disposers.push(register('/import/history', async (_req, res) => {
      const items = listImportLog(memory, { limit: 50 }).map((it) => ({ ...it, line: formatLogLine(it) }));
      sendJson(res, 200, { ok: true, items, keep: 50 });
    }));

    // POST /persona/draft  基于当前档案(惯例/底线/设定/风格)起草「定位自述」候选。
    // 对**库**而言是只读:不写任何键、不改 settings,不受定型门约束(采用仍需常规保存流程);
    // 但对**模型额度**不是 —— 下面 `await llmOnce(...)` 每次请求都真发一次全局模型调用。
    // ⇒ 因此它在 `POST_ONLY` 里:GET 就能被诱导触发付费调用,是"成本型"而非"写型"的攻击面
    //   (旧注释写"只读操作…不落盘",只说了库那一半,漏掉额度这一半;2026-09-29 夜改准)。
    disposers.push(register('/persona/draft', async (_req, res) => {
      const s = settings.get();
      const p = s.persona || {};
      const parts = [];
      const toneName = { natural: '自然亲切', literary: '文雅', concise: '简洁直接', playful: '活泼俏皮' }[p.tone] || p.tone || '自然';
      parts.push('自称:' + (p.aiName || '(未设置)') + ' | 对用户称呼:' + (p.userTitle || '(用你)'));
      parts.push('语气:' + toneName + ' | 语言:' + (p.language === 'zh' ? '中文' : p.language === 'en' ? 'English' : '跟随用户'));
      if (Array.isArray(p.bottomLines) && p.bottomLines.length) parts.push('底线:\n' + p.bottomLines.map((x) => '- ' + x).join('\n'));
      if (Array.isArray(p.hardRules) && p.hardRules.length) parts.push('规矩(用户的指令):\n' + p.hardRules.map((x) => '- ' + x).join('\n'));
      if (Array.isArray(p.habits) && p.habits.length) parts.push('习惯(她长出来的):\n' + p.habits.map((x) => '- ' + (x?.text || x)).join('\n'));
      if (typeof p.duty === 'string' && p.duty.trim()) parts.push('职责(身份级设定,她已承担的事):\n' + p.duty.trim().slice(0, 800));
      if (typeof p.extraLore === 'string' && p.extraLore.trim()) parts.push('扩展设定/身世:\n' + p.extraLore.trim().slice(0, 1200));
      parts.push('工作模式风格:' + (s.styles?.work || '(空)'));
      parts.push('生活模式风格:' + (s.styles?.life || '(空)'));
      if (!parts.length) return sendJson(res, 200, { ok: false, reason: 'empty', message: '档案为空,先填一些内容再起草' });
      try {
        const { text } = await llmOnce(ctx, {
          system: '你是人格档案文案起草助手。依据档案要素起草「定位自述」:说清 AI 是谁、什么气质、与用户是什么关系,自然、克制、不空泛、不堆砌辞藻,与档案语气一致,每段不超过 200 字。输出 1 到 3 个候选,每行一个:不带序号、不加引号、不写解释。',
          text: parts.join('\n'),
          maxTokens: 600,
          effort: 'low',
        });
        const candidates = String(text || '')
          .split('\n').map((l) => l.trim().replace(/^[\s\-•·*]*\d*[.、)）]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
          .filter((l) => l.length >= 4 && l.length <= 200)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 3);
        if (!candidates.length && String(text || '').trim().length <= 220) candidates.push(String(text).trim());
        if (!candidates.length) return sendJson(res, 200, { ok: false, reason: 'empty-reply', message: '模型没有给出可用候选,再试一次' });
        sendJson(res, 200, { ok: true, candidates });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '起草失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /dsweb/scan { db?, limit? }  网页端历史库(聊天记录 .db)增量扫描入库
    disposers.push(register('/dsweb/scan', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const dbPath = String(body.db || DSWEB_DB_DEFAULT || '').trim();
      if (!dbPath) {
        return sendJson(res, 200, {
          ok: false, reason: 'no-db',
          message: '请先填写网页端聊天记录库的完整路径(本插件不预设私有路径;也可用 DSH_LING_DSWEB_DB 环境变量指定)',
        });
      }
      try {
        const r = scanIntoMemory(memory, dbPath, { limit: body.limit ? Number(body.limit) : 0 });
        const affected = allSnapshotSessionIds(gate).map((sid) => ({
          sessionId: sid,
          result: invalidateSession(gate, memory, settings, sid),
        }));
        logImport(memory, {
          kind: 'dsweb', name: String(dbPath).split(/[\\/]/).pop(),
          seen: r.seen, newRows: r.added, refreshed: r.refreshed,
        });
        sendJson(res, 200, { ok: true, db: dbPath, ...r, affected: affected.length });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'scan', message: '扫描失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /dsh/backfill { limit? }  通道 A:DSH 存量会话一键扫描入库(幂等;已存在跳过)
    disposers.push(register('/dsh/backfill', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const { report } = await scanDshHistory({ memory, limit: body.limit ? Number(body.limit) : 0 });
        const total = memory.db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source='dsh'").get().n;
        logImport(memory, { kind: 'dsh', name: '本机会话', seen: report.scanned, newRows: report.created });
        sendJson(res, 200, { ok: true, ...report, totalDsh: Number(total) });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'backfill', message: '扫描失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /import/file/batch { items, file?, runId?, at? }  通道 B:会话契约文件导入(上限口径见下;客户端分页)
    //   ⚠️ **上限口径(2026-09-29 修正;原文写的「每批 ≤500」与实现自相矛盾,已作废)**:
    //   真正的闸门是**字节** —— 本文件 `readBody` 的 `BODY_MAX_BYTES = 4 MiB`(超限走下面的 413 出口);
    //   而 `items.slice(0, 500)` 只是**防呆的条数上限**(500 条要装进 4 MiB 需每条 ≤8 KB,而带正文的
    //   会话实测 ≈26 KB/条)。⇒ 客户端(`lib/client.js` 的 `takeChunk`)按**累计字节**切批:≤200 条 且 ≤3 MiB/批。
    //   ⚠️ **两半是耦合的**:3 MiB(加数组封套与转义)必须留在 4 MiB 之下 —— 任何一方单独改上限,都会让
    //   两端口径重新错位,而**这正是本缺陷的成因**(186 条 4.89 MB 被按条数打成整批发 ⇒ 超限 ⇒ 连接被 reset)。
    //   超限时 `readBody` 会**排空请求体后回 `413 {ok:false, reason:'too-large', limit, got}`**(不再砍连接),
    //   客户端据此给人话。
    //   file/runId/at 仅用于记账:同一次导入(同 runId)的多批累加进**一条**账,at = 导入开始时刻
    disposers.push(register('/import/file/batch', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      if (!items.length) return sendJson(res, 200, { ok: false, reason: 'empty', message: '本批没有条目' });
      try {
        const r = await applyImportItems(memory, items);
        logImport(memory, {
          kind: 'file', name: body.file, runId: body.runId, at: body.at,
          accepted: r.accepted, newRows: r.newRows, refreshed: r.refreshed,
          upgraded: r.upgraded, folded: r.folded, removedImport: r.removedImport,
          // A(2026-09-30):折叠时"因为目标已有原文而**没有替换**的轮数"也要进账(与 tooBig 同款,
          // 只有 >0 才真的落进账本;`= 0` 时账本逐字不变 —— `logImport` 里那道负对照管着)。
          foldSkippedRaw: cleanFoldSkipped(r.foldSkippedRaw),
          degraded: r.degraded, rejected: (r.rejected || []).length,
        });
        // 回执 = `{ ok, ...r }` **整份透传** ⇒ `foldSkippedRaw`(以及 folded/upgraded/…)天然在体里,
        // 不需要在这里另抄一行(抄了反而会与 applyImportItems 的返回漂移)。
        sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'import', message: '导入失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /import/log { runId, at?, file?, errors?, tooBig?, tooBigNames? }
    //   记账补充:客户端上报**失败批**(成功批由上面自己记账)。
    //   #10(2026-09-29)新增第二条路:上报**被跳过的"单条过大"**。它与失败批是两码事 ——
    //   跳过是**已知且可解释**的(那一条自己就超过了单次上限,拆文件也拆不开它)。
    //   ⚠️ **命门**:`errors` 的既有语义是 `Math.max(1, ...)`(**强制 ≥1**),所以"只报跳过"这条路
    //   **绝不能**顺手带上 `errors` —— 否则账本会把"跳过"记成"失败批",正是要避免的混账;
    //   也正因为这条通路以前不存在,客户端当时只能**故意不报**,账本上看不到任何东西被跳过。
    //   输入护栏(账本要长期留着,不许原样吞任意长度用户输入):`tooBig` 夹 0..10000;
    //   `tooBigNames` 只取前 5 条、每条截到 40 字、非字符串丢弃。两处口径的唯一实现在
    //   `import-log.js` 的 `cleanTooBig` / `cleanTooBigNames`(这里显式过一遍,再交给 logImport
    //   自己防一道 —— 端点不是唯一入口,「三条入口共用」的那一份才是底线)。
    disposers.push(register('/import/log', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String(body.runId || '').slice(0, 64);
      if (!runId) return sendJson(res, 200, { ok: false, reason: 'runId', message: '缺少 runId' });
      const tooBig = cleanTooBig(body.tooBig);
      const patch = { kind: 'file', name: body.file, runId, at: body.at };
      // 既有通路(**逐字不变**):`errors` 一律 `max(1, ...)` —— 没传也记 1 批失败(旧行为)。
      // 只有"报跳过"这一路(tooBig > 0)才允许不带 errors;要同时报失败批,显式传 errors 即可。
      if (body.errors !== undefined || tooBig === 0) {
        patch.errors = Math.max(1, Number(body.errors) || 1);
      }
      if (tooBig > 0) {
        patch.tooBig = tooBig;
        patch.tooBigNames = cleanTooBigNames(body.tooBigNames);
      }
      const key = logImport(memory, patch);
      sendJson(res, 200, { ok: true, key });
    }));

    // ---- 诞生仪式:一键深摘(import 源)+ 人格初稿 ----
    // POST /deep/run-import  对"文件导入"会话中**尚未读过**的批量深摘(后台串行;GET 轮询状态;
    //   已 done/skip 的跳过 —— 重复点击推进的是未读部分,不会重读)
    disposers.push(register('/deep/run-import', async (req, res) => {
      if (impRun.running) {
        return sendJson(res, 200, { ok: true, busy: true, total: impRun.total, finished: impRun.done.length });
      }
      const targets = importRawTargets(memory, { limit: 200, excludeProcessed: true }); // 一次跑完所有未读(含快速通过的短会话)
      if (!targets.length) {
        return sendJson(res, 200, { ok: false, reason: 'none', message: '已全部读过(可换新导入的历史再来)' });
      }
      impRun.running = true;
      impRun.total = targets.length;
      impRun.done = [];
      impRun.startedAt = Date.now();
      impRun.finishedAt = 0;
      (async () => {
        for (const t of targets) {
          let r;
          try {
            r = await deepSummarizeOne(ctx, memory, candidateFor(memory, t.session_id));
            impRun.done.push({ id: t.session_id.slice(0, 8), ok: !!r.ok, chars: r.chars || null, reason: r.reason || null });
          } catch (e) {
            impRun.done.push({ id: t.session_id.slice(0, 8), ok: false, reason: 'err:' + String(e?.message ?? e).slice(0, 120) });
          }
        }
        impRun.running = false;
        impRun.finishedAt = Date.now();
      })();
      sendJson(res, 200, { ok: true, started: true, total: targets.length });
    }));

    // GET /deep/run-status  一键深摘进度
    disposers.push(register('/deep/run-status', async (_req, res) => {
      sendJson(res, 200, {
        ok: true, running: impRun.running, total: impRun.total,
        done: impRun.done, startedAt: impRun.startedAt, finishedAt: impRun.finishedAt,
      });
    }));

    // ---- 网页端历史(dsweb)补摘要:候选预览 / 后台串行执行 / 进度 ----
    // 为什么要有 UI:CLI 只适合本机;给别人用时,引擎选择必须是**显式动作** —— 绝不静默花用户的钱。
    const dswebDbOf = (v) => String(v || DSWEB_DB_DEFAULT || '').trim();
    const dswebQuery = (req) => new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams;

    // GET /dsweb/summary/preview?db=&minTurns=&all=1&onlyHit=1&limit=
    disposers.push(register('/dsweb/summary/preview', async (req, res) => {
      const q = dswebQuery(req);
      // ── B(审计 §四.4,2026-10-01 修):`db` **只认**默认库 / settings 白名单 ──────────────
      //   改前这里是 `dswebDbOf(q.get('db'))` —— 收任意路径再 `openSource()` 只读打开,
      //   等于一个"任意本机路径存在吗"的预言机;审计注明它靠 `readOnly:true` 才不是写原语。
      //   判据(全仓唯一一处)在模块级的 previewDbPolicy();这里只接线 + 如实回 reason。
      //   ⚠️ **只收紧这一条**:同文件的 `/dsweb/scan` 与 `/dsweb/summary/run` 仍走 `dswebDbOf`
      //      (它们是 POST_ONLY 的显式动作,不在本条审计范围内 —— 顺手混改会改掉另两个端点的语义)。
      const pol = previewDbPolicy(q.get('db'), settings);
      if (!pol.ok) {
        return sendJson(res, 200, {
          ok: false, reason: pol.reason,
          message: '这个库路径不在白名单里,没有打开它:' + pol.asked
            + '。要用它,先把它设成默认库或写进白名单 —— 环境变量 DSH_LING_DSWEB_DB,'
            + '或 settings 的 dsweb.dbPath / dsweb.dbs[]。',
        });
      }
      const db = pol.db;
      if (!db) {
        return sendJson(res, 200, {
          ok: false, reason: 'no-db',
          message: '请先填写网页端聊天记录库(.db)的完整路径(也可用 DSH_LING_DSWEB_DB 环境变量指定)',
        });
      }
      const minTurns = Number(q.get('minTurns') || MIN_TURNS_DEFAULT) || MIN_TURNS_DEFAULT;
      const includeShort = q.get('all') === '1';
      const onlyHit = q.get('onlyHit') === '1';
      const limit = Math.max(1, Math.min(Number(q.get('limit') || 20) || 20, 200));
      let src;
      try { src = openSource(db); } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'db', message: '打不开源库:' + String(e?.message ?? e).slice(0, 160) });
      }
      try {
        const list = buildCandidates(memory, src, { minTurns, includeShort, onlyHit });
        const asst = resolveAssistant(settings);
        const assistant = await probeAssistant(asst.baseUrl);
        sendJson(res, 200, {
          ok: true, db, total: list.length, minTurns, includeShort, onlyHit,
          assistant: { ok: assistant.ok, reason: assistant.reason, models: assistant.models, base: asst.baseUrl, model: asst.model, source: asst.source },
          items: list.slice(0, limit),
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'preview', message: String(e?.message ?? e).slice(0, 200) });
      } finally { try { src.close(); } catch { /* ignore */ } }
    }));

    // POST /dsweb/summary/run { db, engine:'assistant'|'global', limit?, minTurns?, all?, onlyHit?, baseUrl?, model? }
    disposers.push(register('/dsweb/summary/run', async (req, res) => {
      if (dswebRun.running) {
        return sendJson(res, 200, { ok: true, busy: true, total: dswebRun.total, finished: dswebRun.done.length });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const db = dswebDbOf(body.db);
      if (!db) return sendJson(res, 200, { ok: false, reason: 'no-db', message: '请先填写网页端聊天记录库路径' });
      const engine = body.engine === 'global' ? 'global' : 'assistant';
      const asst = resolveAssistant(settings);
      const baseUrl = String(body.baseUrl || asst.baseUrl);
      const model = String(body.model || asst.model);
      if (engine === 'assistant') {
        const probe = await probeAssistant(baseUrl);
        if (!probe.ok) {
          return sendJson(res, 200, {
            ok: false, reason: 'no-assistant',
            message: '本机小助手探测失败(' + probe.reason + ' @ ' + baseUrl + ')—— 我们不会替你静默换引擎;请确认它在线,或**显式**改选「当前全局大模型」。',
          });
        }
      }
      let src;
      try { src = openSource(db); } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'db', message: '打不开源库:' + String(e?.message ?? e).slice(0, 160) });
      }
      const minTurns = Number(body.minTurns || MIN_TURNS_DEFAULT) || MIN_TURNS_DEFAULT;
      const includeShort = !!body.all;
      const onlyHit = !!body.onlyHit;
      const cap = Math.max(0, Math.min(Number(body.limit || 0) || 0, 2000));
      let list;
      try {
        list = buildCandidates(memory, src, { minTurns, includeShort, onlyHit });
      } catch (e) {
        try { src.close(); } catch { /* ignore */ }
        return sendJson(res, 200, { ok: false, reason: 'candidates', message: String(e?.message ?? e).slice(0, 200) });
      }
      if (cap) list = list.slice(0, cap);
      if (!list.length) {
        try { src.close(); } catch { /* ignore */ }
        return sendJson(res, 200, { ok: false, reason: 'none', message: '没有待补摘要的候选(可能都已补过,或轮次数不足)' });
      }
      dswebRun.running = true; dswebRun.total = list.length; dswebRun.done = [];
      dswebRun.ok = 0; dswebRun.fail = 0; dswebRun.current = ''; dswebRun.engine = engine;
      dswebRun.startedAt = Date.now(); dswebRun.finishedAt = 0; dswebRun.lastError = null; dswebRun.db = db;
      (async () => {
        try {
          for (const it of list) {
            dswebRun.current = String(it.title || it.conv_id).slice(0, 40);
            const short = String(it.conv_id).slice(0, 8);
            try {
              const text = conversationText(src, it.conv_id);
              if (!text) { dswebRun.fail += 1; dswebRun.done.push({ id: short, ok: false, reason: 'no-text' }); continue; }
              let summary = '';
              let reason = null;
              if (engine === 'assistant') {
                const r = await summarizeWithRetry(baseUrl, model, { text, system: SUMMARY_SYS });
                summary = r.ok ? String(r.summary || '') : '';
                reason = r.ok ? null : (r.error || 'failed');
              } else {
                const r = await llmOnce(ctx, { system: SUMMARY_SYS, text, maxTokens: 600, effort: 'off' });
                summary = cleanSummary(r?.text);
                reason = summary ? null : 'empty';
              }
              if (!summary) { dswebRun.fail += 1; dswebRun.lastError = reason; dswebRun.done.push({ id: short, ok: false, reason }); continue; }
              const ov = memory.overviewById('dsweb', it.conv_id);
              if (ov) memory.upsertOverview({ ...ov, summary });
              dswebRun.ok += 1; dswebRun.done.push({ id: short, ok: true, chars: summary.length });
            } catch (e) {
              dswebRun.fail += 1;
              dswebRun.lastError = String(e?.message ?? e).slice(0, 120);
              dswebRun.done.push({ id: short, ok: false, reason: 'err' });
            }
          }
        } finally {
          touchMemoryVersion(memory);          // 补摘要改了记忆内容 → 长会话空闲时才会追平
          try { src.close(); } catch { /* ignore */ }
          dswebRun.running = false; dswebRun.finishedAt = Date.now(); dswebRun.current = '';
        }
      })();
      sendJson(res, 200, { ok: true, started: true, total: list.length, engine });
    }));

    // GET /dsweb/summary/status  补摘要进度(前端 2 秒轮询)
    disposers.push(register('/dsweb/summary/status', async (_req, res) => {
      sendJson(res, 200, {
        ok: true, running: dswebRun.running, total: dswebRun.total, finished: dswebRun.done.length,
        okCount: dswebRun.ok, failCount: dswebRun.fail, current: dswebRun.current, engine: dswebRun.engine,
        startedAt: dswebRun.startedAt, finishedAt: dswebRun.finishedAt, lastError: dswebRun.lastError,
        tail: dswebRun.done.slice(-5),
      });
    }));

    // POST /persona/genesis { scope?: 'import'|'all' }
    //   合成"她对自己的第一次介绍"。原料:scope='import'=刚请进来的历史;'all'=全部记忆
    //   (生活/情感优先加权抽样)。每行三级取用:深摘 → 非占位概述 → 原文片段/线索。
    disposers.push(register('/persona/genesis', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const scope = body.scope === 'all' ? 'all' : 'import';
      const pn = pronounOf(settings.get());
      const comp = composeGenesisRows(memory, { scope, pronoun: pn });
      const sourceText = buildGenesisSource(comp.rows);
      if (!sourceText) {
        return sendJson(res, 200, { ok: false, reason: 'empty', message: pronounize('还没有可读的历史——先在「接入历史」把一段对话请进来,她才能开始认识自己。', pronounOf(settings.get())) });
      }
      try {
        const { text } = await llmOnce(ctx, {
          system: pronounize(GENESIS_SYS, pn),
          text: pronounize(`请阅读以下"她与用户的共同历史材料"(${scope === 'all' ? '来自全部记忆,已按生活/情感优先抽样 ' + comp.sampled + ' 条' : '来自刚导入的一段历史 ' + comp.sampled + ' 条'}),完成自我介绍:\n\n`, pn) + sourceText,
          maxTokens: 1600,
          effort: 'low',
        });
        const result = parseGenesisResult(text);
        if (!result.self_intros.length && !result.name_pairs.length) {
          return sendJson(res, 200, { ok: false, reason: 'parse', message: '模型输出无法解读,再试一次' });
        }
        // 名字必须属于"她":剔除用户称谓/称呼(userTitle 成分 + 常见称谓词)
        const userTitle = settings.get().persona?.userTitle || '';
        result.name_pairs = filterNamePairs(result.name_pairs, userTitle);
        memory.kvSet('genesis.last', JSON.stringify({ at: new Date().toISOString(), scope, result }));
        sendJson(res, 200, { ok: true, scope, sampled: comp.sampled, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '诞生仪式失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // ---- 成长回路(修订建议队列,人审闭环) ----
    // GET /feedback
    disposers.push(register('/feedback', async (_req, res) => {
      const items = memory.listFeedback({ status: 'new' }).map((it) => ({
        id: it.id, created_at: it.created_at, session_id: it.session_id,
        note: it.note, rating: it.rating,
      }));
      sendJson(res, 200, {
        ok: true,
        items,
        stats: {
          new: items.length,
          applied: memory.countFeedback('applied'),
          dismissed: memory.countFeedback('dismissed'),
        },
      });
    }));

    // POST /feedback/apply { id }
    disposers.push(register('/feedback/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 11/14 条写面):采纳建议 → 落习惯 / 改自称。改前只有身份两 kind 有门。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/feedback/apply' })) return;
      const r = await applySuggestionAsRule(memory, settings, body.id);
      if (!r.ok) return sendJson(res, 200, { ok: false, reason: r.reason });
      await archivePersona(settings.get(), 'result'); // 惯例成长也留档
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, id: r.id, hardRules: r.hardRules,
        affected: affected.length,
        l0PreviewText: l0WithClock(settings.get(), settings.get().mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /feedback/dismiss { id }
    disposers.push(register('/feedback/dismiss', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, dismissSuggestion(memory, body.id));
    }));

    // ---- 语料提炼建议(人格档案) ----
    // GET /suggestions
    disposers.push(register('/suggestions', async (_req, res) => {
      const items = memory.listPersonaSuggestions({ status: 'new' }).map((it) => ({
        id: it.id, kind: it.kind, value: it.value, note: it.note, evidence: it.evidence,
      }));
      sendJson(res, 200, {
        ok: true,
        items,
        stats: {
          new: items.length,
          adopted: memory.countPersonaSuggestion('adopted'),
          dismissed: memory.countPersonaSuggestion('dismissed'),
        },
      });
    }));

    // POST /suggestions/apply { id }
    disposers.push(register('/suggestions/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      // 手术门(第 13/14 条写面):采纳建议。改前**只有** kind∈{aiName,userTitle} 才验句,
      // 惯例类(hardrule 等)可自由追加 ⇒ 现在整条端点统一过门(下面那段身份分支因此成了一道冗余的深防线,
      // 保留不动:判据更严的一侧永远不会把请求放过去)。
      if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/suggestions/apply' })) return;
      const row = memory.getPersonaSuggestion(Number(body.id));
      const kind = row?.kind ?? '';
      // 定型门:自称/称呼属身份保护区,采纳需钥匙;惯例类建议(成长回路)可自由追加
      if (kind === 'aiName' || kind === 'userTitle') {
        const cur = settings.get();
        const g = cur.persona?.sealed === true ? sealOk(cur.persona, body.unlock) : { pass: true, adoptKey: null };
        if (!g.pass) {
          return sendJson(res, 200, { ok: false, reason: 'sealed', message: '人格已定型 — 采纳「' + (kind === 'aiName' ? '自称' : '称呼') + '」需先输入承诺句(' + MSG_KEY + ')。惯例类建议仍可直接采纳。' });
        }
        if (g.adoptKey) await settings.update({ persona: { sealPhrase: g.adoptKey } });
      }
      const r = await applyCorpusSuggestion(memory, settings, body.id);
      if (!r.ok) return sendJson(res, 200, { ok: false, reason: r.reason });
      await archivePersona(settings.get(), 'result'); // 建议采纳后的档案留档
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, id: r.id, kind: r.kind, kindName: r.kindName, value: r.value,
        affected: affected.length,
        l0PreviewText: l0WithClock(settings.get(), settings.get().mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /suggestions/dismiss { id }
    disposers.push(register('/suggestions/dismiss', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, dismissCorpusSuggestion(memory, body.id));
    }));

    // ---- LLM 深摘要 ----
    // GET /deep/status
    disposers.push(register('/deep/status', async (_req, res) => {
      const probeRaw = memory.kvGet('llm.probe');
      const lastRaw = memory.kvGet('deep.last');
      const doneRow = memory.db.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'deep:%' AND value LIKE 'done:%'").get();
      sendJson(res, 200, {
        ok: true,
        probe: probeRaw ? JSON.parse(probeRaw) : null,
        last: lastRaw ? JSON.parse(lastRaw) : null,
        done: doneRow ? Number(doneRow.n) : 0,
      });
    }));

    // POST /deep/run { limit? }
    disposers.push(register('/deep/run', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await runDeepPass(ctx, memory, { limit: body.limit ? Number(body.limit) : undefined });
      sendJson(res, 200, { ok: r.ok, reason: r.reason, candidates: r.candidates, done: r.done });
    }));

    // POST /deep/one { sessionId }  — 对单个会话强制重深摘(自动过 skip/done)
    disposers.push(register('/deep/one', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = body.sessionId;
      if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId required' });
      rerunOne(memory, sid);
      const cand = candidateFor(memory, sid);
      if (!cand) {
        return sendJson(res, 200, { ok: false, reason: 'no-candidate', message: '该会话没有可深摘的内容' });
      }
      const r = await deepSummarizeOne(ctx, memory, cand);
      let message;
      if (!r.ok) {
        if (r.reason === 'below-min') message = '会话较短,未达深摘门槛(短会话无需深摘;它的标题与片段已可检索),是正常现象';
        else if (r.reason === 'no-overview') message = '该会话没有可回写深摘的档案行';
      }
      sendJson(res, 200, { ok: r.ok, sessionId: sid, reason: r.reason || null, message, chars: r.chars || null });
    }));

    // GET /export
    // §6.1(a):导出包里的承诺句同样按渠道分流 —— **本机导出照旧带**(备份完整性:本机导出的包
    //   本来就是给本机恢复用的),经代理的导出剥掉(远端拿不到这句)。
    disposers.push(register('/export', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const local = readIsLocal(req);
      const bundle = memory.exportBundle({ includeRaw: q.get('includeRaw') === '1' });
      const s = settings.get();
      // 人格/风格/最后模式随包附载(默认不在合并时覆盖目标)
      bundle.persona = {
        persona: personaForRead(s.persona || {}, local),
        styles: s.styles || {},
        lastMode: s.mode?.lastMode || 'life',
      };
      const payload = JSON.stringify(bundle, null, 2);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dsh-ling-memory-${new Date().toISOString().slice(0, 10)}.dshling.json"`);
      res.end(payload);
    }));

    // POST /import   body = bundle(JSON) 或 { bundle, persona?: true };?overwrite=1
    disposers.push(register('/import', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const text = await readBody(req);
      const parsed = JSON.parse(text || '{}');
      // 手术门(第 14/14 条写面)⚠️ **前移到 importBundle 之前** —— 这是本批唯一一处"改前门在后面"的修正:
      //   改前:`memory.importBundle()`(下一行)先跑,门在它**之后** ⇒ 一个带着恶意 bundle 的请求
      //   即使人格回写被拒,**记忆也已经整体被换掉了**(DESIGN §3 该行备注"门拦不住记忆被换")。
      //   现在:已定型时,未过门(非本机 / 无票 / 原句不符)的请求**一个字节都不落库**。
      //   载荷交的是**原文**:bundle 可达 4 MiB,门用 rawUnlock() 只抽 `"unlock"` 那一段,
      //   不整包 parse、不进留痕字段(见 surgery.js)。未定型时 gated:false ⇒ 行为与现状逐字一致。
      if (!gateSurgery(req, res, sendJson, text, { settings, logFile: surgeryLog, endpoint: '/import' })) return;
      const bundle = parsed.bundle || parsed;
      const report = memory.importBundle(bundle, { overwrite: q.get('overwrite') === '1' });
      // 人格默认不覆盖;仅当显式 persona:true(如备份恢复)才合并(外来条目不污染本地人格)
      let personaApplied = false;
      if (parsed.persona === true && bundle.persona) {
        const cur = settings.get();
        // 定型门:已定型时整体覆盖人格需钥匙
        const g = cur.persona?.sealed === true ? sealOk(cur.persona, parsed.unlock) : { pass: true, adoptKey: null };
        if (!g.pass) {
          return sendJson(res, 200, { ok: false, reason: 'sealed', message: MSG_KEY + '只并入记忆/建议则不受影响。', report });
        }
        const p = bundle.persona.persona || {};
        const st = bundle.persona.styles || {};
        if (g.adoptKey) p.sealPhrase = g.adoptKey;
        const { clean } = sanitizePersonaPatch({ persona: p, styles: st }); // 加固④:外来 bundle 同样过白名单
        await settings.update(clean);
        await archivePersona(settings.get(), 'result'); // 备份覆盖后档案留档
        personaApplied = true;
        for (const sid of allSnapshotSessionIds(gate)) {
          invalidateSession(gate, memory, settings, sid);
        }
      }
      sendJson(res, 200, { ok: report.errors === 0, personaApplied, report });
    }));

    return () => {
      for (const d of disposers) {
        try {
          d();
        } catch {}
      }
    };
  };

  const reqSessionId = (url) => {
    const q = new URL(url || '/', 'http://dsh.internal').searchParams;
    return q.get('sessionId') || q.get('sid') || null;
  };

  tryMount();
  if (!disposeRoutes) {
    // 服务启动顺序兜底:每 3s 重试,成功或插件卸载即停
    timer = setInterval(() => {
      if (disposed || disposeRoutes) {
        clearInterval(timer);
        timer = null;
        return;
      }
      tryMount();
    }, 3000);
  }

  return () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (disposeRoutes) {
      try {
        disposeRoutes();
      } catch {}
      disposeRoutes = null;
    }
  };
}

function allSnapshotSessionIds(gate) {
  return gate.snapshotIds();
}

function rawTurnSessionCount(memory) {
  return memory.rawSessionCount();
}

/** 人话结论(唯一的拼法;前台**原样**显示它,不再自己拼第二遍)。
 *  要素:①几个未知来源 ②它们叫什么 + ③各多少轮 ④首次/最近见到 ⑤一句结论(已经怎么处理了)。
 *  ⚠️ 措辞纪律:只说**查得到的事**。
 *    · "已按外部内容处理"的依据 = summarizer.js 的 dshSessionSql() 把它们排除在概述之外、
 *      habit-gen.js 复用同一判据把它们排除在习惯扫描之外(2026-10-01 逐点核对过调用点);
 *    · **不说**"没混进你的会话统计" —— `memory.rawSessionCount()` 数的是全表 DISTINCT session_id,
 *      **含**外来命名空间 ⇒ 面板上那个"DSH 原始轮次会话 N 个"目前确实把它们算在内。
 *      那句话听着漂亮但是假的;这里如实说"原文表里的会话数仍含它们"(见报告「与描述不一致的事实」)。
 *    · kv 里的计数是累积的 ⇒ 用"见到"而不是"现在有"。 */
function rawUnknownSourcesText({ namespaces, turns, firstSeenAt, lastSeenAt }) {
  const list = namespaces.map((u) => u.ns + '(' + u.turns + ' 轮)').join(' · ');
  const when = (v) => {
    const d = new Date(String(v));
    if (isNaN(d.getTime())) return String(v);   // 脏值原样印出,不做自作聪明的截取
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const seen = (firstSeenAt && lastSeenAt)
    ? '首次见到 ' + when(firstSeenAt) + ',最近见到 ' + when(lastSeenAt) + '。'
    : (firstSeenAt ? '首次见到 ' + when(firstSeenAt) + '(未记最近时刻)。' : '时刻未记录。');
  return '有 ' + namespaces.length + ' 个我没见过的原文来源:' + list + ',共 ' + turns + ' 轮原文 —— '
    + '已按外部内容处理:没被概述、也没进你的习惯统计(原文表里那个"会话数"仍含它们)。' + seen;
}
