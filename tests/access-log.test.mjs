// E4 访问日志单测:四种请求形态可辨 + 落盘形状 + 切天/上限 + 绝不抛进请求路径。
// 对应任务书 §4「验收动作」的四态:①本机伪 cookie(应拒) ②本机真 cookie(应过)
// ③局域网 Host(应拒) ④隧道形态(Host=127.0.0.1)。单测只断言**日志可辨**这一半,
// 真实四态请求由实测脚本(带真实服务器)覆盖 —— 单测替代不了实测,这是 E4 的教训本身。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  createAccessLog, localIso, localDay, rejectionReason, deviceIdFromCookieValue,
  deviceIdDigest, DEVICE_ID_HASH, POSTURE_PROBE_PATH,
} = await imp('lib/audit/access-log.js');
const { PATCH_TARGETS, PATCH_MARKER, OBSERVE_GLOBAL, UPGRADE_GLOBAL } = await imp('lib/audit/patch-spec.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 一律用**合成值**：真机 deviceId 是配对凭据，绝不写进测试/文档（项目红线）。
const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HEX_DIGEST = 'ff25d2389ab7917a';   // = sha256(HEX)[:16]，金值：钉住口径，防口径被悄悄改掉

function mockReq({ method = 'POST', url = '/api/x', headers = {}, ip = '127.0.0.1', lingRejection } = {}) {
  const req = { method, url, headers, socket: { remoteAddress: ip } };
  // C-14：器灵 guard 判定后挂在请求对象上的**真拒因**（lib/host/api.js 的守卫）。
  if (lingRejection !== undefined) req.__dshLingRejection = lingRejection;
  return req;
}
function mockRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writeHead = function writeHead(code) { this.statusCode = code; return this; };
  res.end = function end() { return this; };
  return res;
}
/** 跑一次"请求",返回日志最后一行。 */
function run(log, req, status, { upgrade = false, rejection } = {}) {
  const res = mockRes();
  if (upgrade) log.observeUpgrade(req, rejection);
  else { log.observe(req, res); res.writeHead(status); res.end(); }
  return lastLine(log.info().dir);
}
function lastLine(dir) {
  const day = localDay();
  const file = join(dir, `access-${day}.jsonl`);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const dir = mkdtempSync(join(tmpdir(), 'e4-access-log-'));
const log = createAccessLog({ dir, deviceCookie: 'dsh_pair-W', uaMax: 20, maxTotalBytes: 64 * 1024 });

// 1) 三种被拦形态 + 一种放行形态(任务书 §3.2 的 rejection 字段)
// 1a) **契约变更(C-14,2026-09-25)**：`rejection` 现在**优先取 `req.__dshLingRejection`**
//     （器灵 guard 判定后挂上的真因），读不到才退回按状态码反推。旧契约「403 ⇒ untrusted-host」
//     的前提是"全系统只有 core 栅栏会返回 403" —— C-02 让器灵 guard 拒的请求也进了这份日志，
//     该前提失效（cross-site / origin-mismatch / no-cookie / empty-cookie 四种全被误标）。
//     下面这条**不带**标记的 403 = core 栅栏的流量 ⇒ fallback 必须原样保留。
const e403 = run(log, mockReq({ headers: { host: '192.0.2.66:3080' } }), 403);
check(e403.status === 403 && e403.rejection === 'untrusted-host', '403 无真因标记 → fallback untrusted-host(未被破坏):' + JSON.stringify(e403.rejection));
// 1b) C-14 验收①：同样的 403，带器灵 guard 的真因 ⇒ 必须记真因，不许再误标 untrusted-host
const e403x = run(log, mockReq({ headers: { host: '127.0.0.1:3080' }, lingRejection: 'cross-site' }), 403);
check(e403x.status === 403 && e403x.rejection === 'cross-site', '403 带真因 → 记 cross-site(不再误标):' + e403x.rejection);
// 1c) **时序复刻**：真因在 observe() **之后**才挂上 —— 这正是 api.js 的真实时序（guard 顶部
//     observe，拒绝分支才挂 reason）。日志行必须仍读到它 ⇒ 证明拒因是在**写出那一刻**读的。
const lateReq = mockReq({ headers: { host: '127.0.0.1:3080' } });
const lateRes = mockRes();
log.observe(lateReq, lateRes);
lateReq.__dshLingRejection = 'origin-mismatch';
lateRes.writeHead(403);
lateRes.end();
const late = lastLine(dir);
check(late.status === 403 && late.rejection === 'origin-mismatch', 'observe 之后才挂的真因也要被记到:' + late.rejection);
// 1d) 405（方法校验，先于鉴权）挂 'method-not-allowed'，不再是「非栅栏状态码 ⇒ null」
const e405 = run(log, mockReq({ method: 'GET', url: '/api/dsh-ling/branches/gather', headers: { host: '127.0.0.1:3080' }, lingRejection: 'method-not-allowed' }), 405);
check(e405.status === 405 && e405.rejection === 'method-not-allowed', '405 → method-not-allowed:' + e405.rejection);
const e401a = run(log, mockReq({ headers: { host: '127.0.0.1:3080' } }), 401);
check(e401a.rejection === 'no-cookie', '401 无 cookie → no-cookie:' + e401a.rejection);
const e401b = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: 'dsh-auth-xyz=deadbeef' } }), 401);
check(e401b.rejection === 'bad-cookie', '401 带伪 cookie → bad-cookie:' + e401b.rejection);
const e200 = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-W=${HEX}` } }), 200);
check(e200.status === 200 && e200.rejection === null, '200 → rejection 为 null');
// **C-01 端到端**：cookie 里的凭据是 HEX，落盘的必须只有摘要（旧实现落的是原文）。
check(e200.deviceId === HEX_DIGEST && e200.deviceCookie === true, '设备字段落地为摘要:' + e200.deviceId);
check(e200.deviceIdHash === DEVICE_ID_HASH, '摘要带形态标记 deviceIdHash:' + e200.deviceIdHash);
check(e200.deviceId !== HEX && !JSON.stringify(e200).includes(HEX), '日志行里不得出现凭据原文');
check(e200.channel === 'no-ua', '无 UA 的放行行标 channel:"no-ua":' + JSON.stringify(e200.channel));
// C-01 端到端②：同一个键以**大写**形态出现在 cookie 里 ⇒ 落盘摘要必须与上一条相同（抽取器归一）
const e200u = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-W=${HEX.toUpperCase()}` } }), 200);
check(e200u.deviceId === HEX_DIGEST && e200u.deviceId !== HEX.toUpperCase(), '同一设备的大写形态 → 同一摘要:' + e200u.deviceId);

// 1b) 元数据当场可见:写入后文件大小/mtime 必须立刻更新。
//     回归点:用「常开 fd + writeSync」时目录项会停在旧值 —— 实测文件已有 77 行,
//     Get-Item 仍报 0 字节,而那正是取证时最容易误判成「什么都没记」的假象。
const todayFile = join(dir, `access-${localDay()}.jsonl`);
const st = statSync(todayFile);
check(st.size > 0, '写入后文件大小立即可见:' + st.size);
check(Date.now() - st.mtimeMs < 60_000, '写入后 mtime 立刻更新:' + new Date(st.mtimeMs).toISOString());

// 2) 字段:method/path/ip/fwd/host/ua/bytes + 本地毫秒时间戳
const rich = run(log, mockReq({
  method: 'GET',
  url: '/api/dsh-ling/veins?branch=秘密令牌#frag',
  headers: {
    host: '127.0.0.1:3080',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/156.0 后面还有很长的尾巴',
    'content-length': '42',
    'cf-connecting-ip': '203.0.113.9',
  },
}), 200);
check(rich.method === 'GET' && rich.path === '/api/dsh-ling/veins', '查询串被丢弃:' + rich.path);
check(!JSON.stringify(rich).includes('秘密令牌'), '查询串内容不入库');
check(rich.ip === '127.0.0.1' && rich.fwd === '203.0.113.9', 'ip 与 fwd(隧道真实来源)分开记');
check(rich.host === '127.0.0.1:3080', 'host 头原样记');
check(rich.ua.length <= 21 && rich.ua.endsWith('…'), 'UA 截断:' + rich.ua);
check(rich.bytes === 42, 'bytes 取 content-length');
check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(rich.at), 'at 是本地时间(含毫秒与偏移):' + rich.at);
check(rich.risk === '/dsh-ling/', '高危端点打 risk 标记:' + rich.risk);
check(rich.channel === undefined, '带 UA 的浏览器行不得标 channel:' + JSON.stringify(rich.channel));

// 3) 悬案端点必须能被一眼 grep 出来
const restart = run(log, mockReq({ url: '/api/settingRestart/restart', headers: { host: '127.0.0.1:3080' } }), 401);
check(restart.risk === 'settingRestart/restart', 'settingRestart/restart 命中 risk');

// 3b) 自检探针签名标注(2026-09-25 实机归因:每次开机一条 403,来源是自家部署姿态自检)
//     五要素齐全才标注;放宽任何一条都会把真攻击错标成"自检" —— 所以四个反例都必须不标注。
check(POSTURE_PROBE_PATH === '/api/session.list', '探针路径常量稳定(与远端 UI 的 posture 探针绑定)');
const posture = run(log, mockReq({ url: '/api/session.list', headers: { host: 'main.example.com' } }), 403);
check(posture.probe === 'posture', '五要素齐全 → 标 probe:"posture":' + JSON.stringify(posture.probe));
// C-14 契约：这里的 403 来自 **core 栅栏**（/api/session.list 不是器灵端点，器灵 guard 看不到它），
// 所以走的是「按状态码反推」的 fallback —— 契约变更后这一条依然成立。
check(posture.status === 403 && posture.rejection === 'untrusted-host', '标注不代表放行(仍是 403 被拦下)');
check(posture.channel === 'no-ua', '探针行同时标 channel(它确实没有 UA):' + JSON.stringify(posture.channel));
const notProbe = [
  ['带 UA', { url: '/api/session.list', headers: { host: 'main.example.com', 'user-agent': 'Mozilla/5.0' } }, 403],
  ['路径不同', { url: '/api/session/prompt', headers: { host: 'main.example.com' } }, 403],
  ['已放行', { url: '/api/session.list', headers: { host: 'main.example.com' } }, 200],
  ['非 loopback', { url: '/api/session.list', headers: { host: 'main.example.com' }, ip: '192.0.2.50' }, 403],
];
for (const [why, req, code] of notProbe) {
  const e = run(log, mockReq(req), code);
  check(e.probe === undefined, `反例(${why})不得标注,实际 ` + JSON.stringify(e.probe));
}

// 4) WebSocket upgrade(/api/remote.mux):没有 statusCode,结局由栅栏码决定
// C-14 契约:upgrade 的 403 由 **core 的 mux 栅栏**给出(req 上没有器灵真因标记)⇒ fallback
// untrusted-host;若带了标记则标记优先 —— 两种形态都要成立(entryOf 是同一个消费点)。
const up1 = run(log, mockReq({ method: 'GET', url: '/api/remote.mux', headers: { host: '192.0.2.66:3080' } }), 0, { upgrade: true, rejection: 403 });
check(up1.phase === 'upgrade' && up1.status === 403 && up1.rejection === 'untrusted-host', 'upgrade 被拒:' + JSON.stringify(up1.status));
const up3 = run(log, mockReq({ method: 'GET', url: '/api/remote.mux', headers: { host: '127.0.0.1:3080' }, lingRejection: 'no-cookie' }), 0, { upgrade: true, rejection: 403 });
check(up3.rejection === 'no-cookie', 'upgrade 带真因标记时标记优先:' + up3.rejection);
const up2 = run(log, mockReq({ method: 'GET', url: '/api/remote.mux', headers: { host: '127.0.0.1:3080' } }), 0, { upgrade: true, rejection: undefined });
check(up2.status === 101, 'upgrade 放行记 101:' + up2.status);

// 5) 绝不抛进请求路径 + **C-07:写失败必须可观测**(旧实现只喊一行 stderr,之后永久静默)
const bogusDir = join(dir, 'not-a-dir');
writeFileSync(bogusDir, 'x');           // 同名的文件占位 → mkdirSync 必失败
const broken = createAccessLog({ dir: bogusDir, degradeWarnMs: 0 });
const seen = [];
const origConsoleError = console.error;
console.error = (...a) => { seen.push(a.map(String).join(' ')); };
let threw = false;
try {
  const bres = mockRes();
  broken.observe(mockReq(), bres);
  bres.writeHead(200);
  bres.end();
} catch (e) { threw = true; }
check(!threw, '日志坏掉也不抛进请求路径');
check(broken.info().disabled === true, '坏掉后自我禁用(不再反复试写)');
const h1 = broken.info().health;
check(h1.state === 'degraded', 'C-07:健康面报 degraded:' + h1.state);
check(h1.failures === 1 && h1.lost === 1, 'C-07:失败 1 次/丢 1 行:' + JSON.stringify([h1.failures, h1.lost]));
check(!!h1.lastError && !!h1.lastError.code && !!h1.lastError.message && !!h1.lastError.at,
  'C-07:lastError 带 errno/message/时刻:' + JSON.stringify(h1.lastError));
check(seen.length === 1 && seen[0].includes('access log disabled') && seen[0].includes(h1.lastError.code),
  'C-07:首次失败立刻告警(含 errno):' + seen[0]);
// C-07 核心断言:**之后不得沉默** —— 降级状态下流量继续,丢行数与告警都必须继续长
for (let i = 0; i < 8; i += 1) {
  const bres = mockRes();
  broken.observe(mockReq(), bres);
  bres.writeHead(200);
  bres.end();
}
const h2 = broken.info().health;
check(h2.lost === 9, 'C-07:降级后每一行都计入丢失(1+8):' + h2.lost);
check(seen.length === 9, 'C-07:继续告警,不许"1 行 stderr 之后就永久静默"(节流=0 ⇒ 每丢一行喊一次):' + seen.length);
check(seen[seen.length - 1].includes('9 line(s) dropped'), 'C-07:告警带上**当前**累计损失量(不失真):' + seen[seen.length - 1]);
broken.observeUpgrade(mockReq({ method: 'GET', url: '/api/remote.mux' }), 101);
check(broken.info().health.lost === 10 && seen.length === 10, 'C-07:upgrade 通道同样计入丢失并告警:' + broken.info().health.lost);
check(broken.info().health.warnedAt !== null, 'C-07:health 带最近告警时刻(供 /health 常驻读取)');
// 默认节流(60s)下不许刷屏 —— 但**不喊不等于不记**:损失量照样长
const broken2 = createAccessLog({ dir: bogusDir });
const mark = seen.length;
for (let i = 0; i < 5; i += 1) {
  const r2 = mockRes();
  broken2.observe(mockReq(), r2);
  r2.writeHead(200);
  r2.end();
}
check(seen.length === mark + 1, 'C-07:默认节流下 60s 内只喊首次(不刷屏):新增告警 ' + (seen.length - mark) + ' 次');
check(broken2.info().health.lost === 5, 'C-07:不喊也照样计数(5 次请求 = 1 次失败 + 4 次降级丢行):' + broken2.info().health.lost);
broken2.close();
console.error = origConsoleError;
broken.close();
// 健康面在三种姿态下都要说人话:ok / degraded / off(配置关闭 ≠ 故障,不计丢失也不喊)
check(log.info().health.state === 'ok' && log.info().health.lost === 0, 'C-07:正常姿态 health.state=ok');
const off = createAccessLog({ dir, enabled: false });
const offRes = mockRes();
off.observe(mockReq(), offRes);
offRes.writeHead(200);
offRes.end();
check(off.info().health.state === 'off' && off.info().health.lost === 0, 'C-07:配置关闭 = off 且不计丢失:' + JSON.stringify(off.info().health));
off.close();

// 6) 滚动:超上限删最旧,当天文件永不删
const capDir = mkdtempSync(join(tmpdir(), 'e4-access-cap-'));
const old = join(capDir, 'access-2020-01-01.jsonl');
writeFileSync(old, 'x'.repeat(4096));
const capped = createAccessLog({ dir: capDir, maxTotalBytes: 1024 });
const cres = mockRes();
capped.observe(mockReq(), cres);
cres.writeHead(200);
cres.end();
check(!existsSync(old), '超上限删最旧');
const remain = readdirSync(capDir).filter((f) => f.endsWith('.jsonl'));
check(remain.length === 1 && remain[0] === `access-${localDay()}.jsonl`, '当天文件保留:' + remain.join(','));
capped.close();

// 7) 补丁规格自检:两条补丁的插入行必须都带标记(否则回滚会认不出来)
check(PATCH_TARGETS.length === 2, '补丁目标两条');
for (const t of PATCH_TARGETS) {
  const line = t.line('\t');
  check(line.includes(PATCH_MARKER), `${t.id} 插入行含标记`);
  check(line.includes('globalThis.__dshAccessLog') && line.includes('?.('), `${t.id} 是可选调用(插件缺失即 no-op)`);
  check(t.anchor instanceof RegExp, `${t.id} 锚点是正则`);
}
check(OBSERVE_GLOBAL === '__dshAccessLogObserve' && UPGRADE_GLOBAL === '__dshAccessLogUpgrade', '钩子全局名稳定');

// 8) 纯函数:拒绝原因与设备 hash 解析
check(rejectionReason(200, {}) === null && rejectionReason(404) === null, '非栅栏状态码不算拒绝');
// C-14:第三个参数(请求对象)是新增的**优先判据**;不传/读不到一律退回旧判据(core 栅栏)。
check(rejectionReason(403, {}) === 'untrusted-host', 'core 栅栏 403 → untrusted-host(fallback 不变)');
check(rejectionReason(403, {}, { __dshLingRejection: 'no-cookie' }) === 'no-cookie', '带真因的 403 → 真因优先');
check(rejectionReason(403, {}, {}) === 'untrusted-host', '空请求对象 → 仍退回 fallback');
check(rejectionReason(401, {}, { __dshLingRejection: '' }) === 'no-cookie', '空真因视同没有(不吞掉 fallback)');
check(deviceIdFromCookieValue(`v1.${HEX}.signature`) === HEX, '抽取器能取出设备键(**返回的是凭据原文**,只能喂 deviceIdDigest)');
// 真实形态(2026-09-25 核实):远端 UI 的配对实现用它的随机令牌生成器
// 生成 32 位十六进制**明文**原样写进配对 cookie。用合成值钉住它 —— 绝不用真机 deviceId(那是凭据)。
const REAL_SHAPE = '0123456789abcdef0123456789abcdef';
check(deviceIdFromCookieValue(REAL_SHAPE) === REAL_SHAPE, '真实形态(32-hex 明文)原样取到');
check(deviceIdFromCookieValue(REAL_SHAPE.toUpperCase()) === REAL_SHAPE, '大写归一成小写');
check(deviceIdFromCookieValue('opaque-not-hex') === null, '取不到就返回 null(不编造)');

// ---- C-01(高):凭据原文落盘前必须摘要化 —— 逐条钉住"摘要"的六条性质 ----
const d = deviceIdDigest(REAL_SHAPE);
// ① 不可逆:摘要里不含原文,也不是原文的任何片段
check(d !== REAL_SHAPE && !d.includes(REAL_SHAPE.slice(0, 8)), '摘要不含凭据原文:' + d);
// ② 确定性:同一输入 → 同一摘要(跨进程/跨机器稳定,事后才能比对"是不是同一台设备")
check(deviceIdDigest(REAL_SHAPE) === deviceIdDigest(String(REAL_SHAPE)), '同一输入 → 同一摘要');
check(d === '3eb1bd439947eb76', '摘要口径锁定 = sha256(utf8) 前 16 位(金值,防口径被悄悄改掉)');
// ③ 区分度:换一台设备必须换摘要
check(d !== deviceIdDigest(HEX) && deviceIdDigest(HEX) === HEX_DIGEST, '不同设备 → 不同摘要');
// ④ 形态:16 位小写 hex + 与实现一致的算法标记(老日志没有该字段 ⇒ 消费者靠它分辨时代)
check(/^[0-9a-f]{16}$/.test(d) && DEVICE_ID_HASH === 'sha256-16', '摘要 = 16 位小写 hex,标记 sha256-16');
// ⑤ 日志口径稳定:同一个键的两种大小写形态(经抽取器归一)落成同一摘要
check(deviceIdDigest(deviceIdFromCookieValue(REAL_SHAPE.toUpperCase())) === d, '大小写形态经抽取器归一 → 同一摘要');
check(deviceIdDigest(`v1.${REAL_SHAPE}.signature`) !== d, '反证:摘要是对**抽出的设备键**做的,不是对整串 cookie');
// ⑥ 取不到就不编造
check(deviceIdDigest(null) === null && deviceIdDigest('') === null && deviceIdDigest(undefined) === null, '空值 → null(不编造摘要)');
check(localIso(new Date(2026, 8, 24, 19, 49, 51, 123)).startsWith('2026-09-24T19:49:51.123'), 'localIso 对齐现场时刻');

// ---- C-01 整文件扫描(最强的一条):今天这份日志里**一个凭据原文都没有**,只有摘要 ----
const allText = readFileSync(todayFile, 'utf8').toLowerCase();
check(!allText.includes(HEX) && !allText.includes(REAL_SHAPE), '整份日志不含任何凭据原文(大小写都不放过)');
check(allText.includes(HEX_DIGEST), '日志里落的是摘要(仍可 grep/按设备分组,取证能力不减)');

// ---- 9) C-07 的**插件级出口**:`/health`(或界面)只需读 accessLogHealth(),不必去猜 stderr 那一行 ----
const { installAccessLog, accessLogHealth } = await imp('lib/audit/index.js');
check(accessLogHealth() === null, 'C-07:未安装时 accessLogHealth() = null');
const healthDir = mkdtempSync(join(tmpdir(), 'e4-access-health-'));
const disposeLog = installAccessLog({}, { dir: healthDir, degradeWarnMs: 0 });
check(accessLogHealth()?.health?.state === 'ok', 'C-07:安装后健康面可读且为 ok:' + JSON.stringify(accessLogHealth()?.health));
disposeLog();
check(accessLogHealth() === null, 'C-07:卸载后健康面归 null(不留悬空引用)');

log.close();
console.log(ok ? 'E4 访问日志全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
