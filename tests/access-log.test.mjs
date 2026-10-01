// E4 访问日志单测:四种请求形态可辨 + 落盘形状 + 切天/上限 + 绝不抛进请求路径。
// 对应任务书 §4「验收动作」的四态:①本机伪 cookie(应拒) ②本机真 cookie(应过)
// ③局域网 Host(应拒) ④隧道形态(Host=127.0.0.1)。单测只断言**日志可辨**这一半,
// 真实四态请求由实测脚本(带真实服务器)覆盖 —— 单测替代不了实测,这是 E4 的教训本身。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  createAccessLog, localIso, localDay, rejectionReason, deviceIdFromCookieValue,
  deviceIdDigest, DEVICE_ID_HASH, POSTURE_PROBE_PATH, resolveDeviceCookie, ACCESS_LOG_DEFAULTS,
} = await imp('lib/audit/access-log.js');
const { PATCH_TARGETS, PATCH_MARKER, PATCH_STATE_FILE, OBSERVE_GLOBAL, UPGRADE_GLOBAL } = await imp('lib/audit/patch-spec.js');

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
const log = createAccessLog({ dir, deviceCookie: 'dsh_pair-x', uaMax: 20, maxTotalBytes: 64 * 1024 });

// 1) 三种被拦形态 + 一种放行形态(任务书 §3.2 的 rejection 字段)
// 1a) **契约变更(C-14,2026-09-25)**：`rejection` 现在**优先取 `req.__dshLingRejection`**
//     （器灵 guard 判定后挂上的真因），读不到才退回按状态码反推。旧契约「403 ⇒ untrusted-host」
//     的前提是"全系统只有 core 栅栏会返回 403" —— C-02 让器灵 guard 拒的请求也进了这份日志，
//     该前提失效（cross-site / origin-mismatch / no-cookie / empty-cookie 四种全被误标）。
//     下面这条**不带**标记的 403 = core 栅栏的流量 ⇒ fallback 必须原样保留。
//     ⚠ 夹具里的 Host/IP 一律用**文档用网段**（RFC 5737 的 192.0.2.0/24）:这里要的只是
//     "一个非 loopback 的局域网 Host",没有理由把作者本机的真实网段写进公开文件。
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
const e200 = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-x=${HEX}` } }), 200);
check(e200.status === 200 && e200.rejection === null, '200 → rejection 为 null');
// **C-01 端到端**：cookie 里的凭据是 HEX，落盘的必须只有摘要（旧实现落的是原文）。
check(e200.deviceId === HEX_DIGEST && e200.deviceCookie === true, '设备字段落地为摘要:' + e200.deviceId);
check(e200.deviceIdHash === DEVICE_ID_HASH, '摘要带形态标记 deviceIdHash:' + e200.deviceIdHash);
check(e200.deviceId !== HEX && !JSON.stringify(e200).includes(HEX), '日志行里不得出现凭据原文');
check(e200.channel === 'no-ua', '无 UA 的放行行标 channel:"no-ua":' + JSON.stringify(e200.channel));
// C-01 端到端②：同一个键以**大写**形态出现在 cookie 里 ⇒ 落盘摘要必须与上一条相同（抽取器归一）
const e200u = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-x=${HEX.toUpperCase()}` } }), 200);
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

// ---- 9b) **契约字段名绊线**(2026-09-27,主会话追加)—— 这 11 个名字是跨文件契约,不是内部细节 ----
// 消费端(读的键就这几个,少一个不会报错、只会显示错):
//   · lib/client.js:953-962 渲染审计面板那一行:state 三分支 + lastError.code / message / at + lost / writes
//   · lib/client.js:3907    侧栏常驻警示:`st.audit.state === 'degraded'`
//   · lib/host/api.js:482   把 `accessLogHealth().health` **原样** sendJson(/health 与两个视图的 audit 字段)
// 为什么必须逐名钉死:前端对**未知 / 缺失**字段**不抛错** —— 改个名不会红,只会让面板静悄悄显示
// 「访问日志: ✔ 正常 · 写入 undefined」,那等于把"坏了"伪装成"正常",比不显示更坏。
// 所以:名字缺一个,这里就红(而不是等到有人在界面上肉眼发现)。
const HEALTH_KEYS = [
  'state', 'writes', 'failures', 'lost', 'lostSince', 'lastError', 'warnedAt',
  'recoveredAt', 'retryAttempts', 'nextRetryAt', 'retrySucceeded',
];
const hasKey = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const hOk = log.info().health;      // 正常姿态
const hDeg = broken.info().health;  // 降级姿态(唯一会带 lastError 的形态)
const hOff = off.info().health;     // 配置关闭姿态
for (const k of HEALTH_KEYS) {
  const missing = [['ok', hOk], ['degraded', hDeg], ['off', hOff]]
    .filter(([, h]) => !hasKey(h, k))
    .map(([n]) => n);
  check(missing.length === 0, 'C-07b 契约:health 必须含 "' + k + '"(三种姿态都查);缺失姿态:' + (missing.join(',') || '无'));
}
// lastError **存在时必须带全** code / message / at(消费端读 code 与 at 做展示)
check(
  !!hDeg.lastError && hasKey(hDeg.lastError, 'code') && hasKey(hDeg.lastError, 'message') && hasKey(hDeg.lastError, 'at'),
  'C-07b 契约:lastError 存在时必带 code/message/at:' + JSON.stringify(hDeg.lastError),
);
// 没坏过时必须是 **null**(不是 undefined) —— 消费端拿 `ah.lastError || {}` 与判空都要稳
check(
  hOk.lastError === null && hOff.lastError === null,
  'C-07b 契约:未失败时 lastError 为 null(不是 undefined):' + JSON.stringify([hOk.lastError, hOff.lastError]),
);
// `state` 的**派生顺序**也是契约:先判 degraded、再判 configOff —— 反了会把"写入失败"显示成
// "已按配置关闭"(语义正好相反,且是**安静的**错)。这两种状态在公开 API 上无法同时为真
// (configOff 的闸门在最前面,永远走不到写盘 ⇒ 永远降不了级),运行时区分不出来 ⇒ 只能在源码文本上钉。
const aSrc = readFileSync(join(root, 'lib/audit/access-log.js'), 'utf8');
check(
  /state:\s*degraded\s*\?\s*'degraded'\s*:\s*configOff\s*\?\s*'off'\s*:\s*'ok'/.test(aSrc),
  "C-07b 契约:state 必须先判 degraded 再判 configOff(反了会把故障显示成'已关闭')",
);
check(
  /if \(!degraded\) return;/.test(aSrc),
  'C-07b 契约:noteLost 的守卫挂在 degraded 上(不是 lastError)—— 否则"配置关闭"场景会误计数',
);

// ---- 10) C-07b(2026-09-27):降级必须能**自己好起来**(旧实现一次失败 = 永久死) ----
// 现场:2026-09-27 实测 10:26:49 之后再 41.6 分钟文件零增长 —— 进程健在、补丁在位、请求照发,
// 增长 **0 字节**,只有重启才恢复。根因:旧实现全文件只有"初始化"与"失败"两处给状态赋值,
// 没有任何清除点 ⇒ 一次失败之后请求只计数不写盘。
// 手法沿用 §5:拿**同名文件**占住目录名 ⇒ mkdirSync 抛 EEXIST。注意这个 errno 长着"永久码"的脸,
// 但它的条件是**瞬时**的(占位文件删掉就好)—— 所以按 errno 分类会刚好把它判死,本设计一律重试。
const healRoot = mkdtempSync(join(tmpdir(), 'e4-access-heal-'));
const healDir = join(healRoot, 'logs');
writeFileSync(healDir, 'x');                     // 占位文件:目录建不起来
const heal = createAccessLog({ dir: healDir, retryBaseMs: 0, degradeWarnMs: 0 });
const realError = console.error;
const healSeen = [];
console.error = (...a) => { healSeen.push(a.map(String).join(' ')); };
const beat = (logger) => { const r = mockRes(); logger.observe(mockReq(), r); r.writeHead(200); r.end(); };

// 10a) 首次失败即降级(与 §5 同形,但这里多了"下次探针时刻")
beat(heal);
console.error = realError;
const g1 = heal.info().health;
check(g1.state === 'degraded', 'C-07b:首次写失败即降级:' + g1.state);
check(g1.lost === 1, 'C-07b:触发失败的那一行计入丢失:' + g1.lost);
check(g1.nextRetryAt > 0, 'C-07b:失败后**排定了下次探针时刻**(不再是无限期禁用):' + g1.nextRetryAt);
check(g1.retryAttempts === 1 && g1.lostSince !== null, 'C-07b:连续失败次数/故障起点可见:' + JSON.stringify([g1.retryAttempts, g1.lostSince]));

// 10b) **自行恢复(本组的关键一条)**:瞬时条件消失 ⇒ 下一次请求的写盘就是探针,写成功即自愈
unlinkSync(healDir);
console.error = (...a) => { healSeen.push(a.map(String).join(' ')); };
beat(heal);
console.error = realError;
const g2 = heal.info().health;
check(g2.state === 'ok', 'C-07b:条件恢复后下一次请求就自愈(state 回到 ok):' + g2.state);
check(heal.info().disabled === false, 'C-07b:自愈后 info().disabled 回到 false(向后兼容字段同源)');
check(g2.writes >= 1, 'C-07b:自愈这一次是**真写进去了**(writes 增长):' + g2.writes);
check(!!g2.recoveredAt, 'C-07b:留下恢复时刻(否则"它什么时候好的"没有痕迹):' + g2.recoveredAt);
check(g2.retryAttempts === 0 && g2.nextRetryAt === 0, 'C-07b:自愈后退避归零:' + JSON.stringify([g2.retryAttempts, g2.nextRetryAt]));
check(g2.retrySucceeded === 1, 'C-07b:自愈成功次数累计:' + g2.retrySucceeded);
const healFile = join(healDir, `access-${localDay()}.jsonl`);
check(existsSync(healFile), 'C-07b:恢复后**日志文件真的出现了**(不是只改了状态位)');
check(g2.lastError !== null, 'C-07b:lastError 作为历史证据保留(恢复不抹掉"坏过"这一事实)');
check(healSeen.some((l) => l.includes('access log recovered')), 'C-07b:恢复喊一次告警(含丢失总量):' + (healSeen.find((l) => l.includes('recovered')) || healSeen[healSeen.length - 1]));
heal.close();

// 10c) 退避闸门不变量(证明"不是每请求重试"):60s 基线 ⇒ 窗口内那 3 次请求**一次盘都不碰**
const stayDir = join(mkdtempSync(join(tmpdir(), 'e4-access-stay-')), 'logs');
writeFileSync(stayDir, 'x');
const stay = createAccessLog({ dir: stayDir, retryBaseMs: 60000, degradeWarnMs: 0 });
console.error = () => {};
beat(stay);                                       // 第 1 次:失败降级
const s1 = stay.info().health;
console.error = realError;
check(s1.failures === 1 && s1.lost === 1, 'C-07b:第 1 次请求:真失败 1 次(丢失 1 行):' + JSON.stringify([s1.failures, s1.lost]));
const sNext = s1.nextRetryAt;
console.error = () => {};
beat(stay); beat(stay); beat(stay);               // 再连发 3 次:全在退避窗口内
console.error = realError;
const s2 = stay.info().health;
check(s2.failures === 1, 'C-07b:退避窗口内**不重试**(4 次请求只碰了 1 次磁盘):' + s2.failures);
check(s2.lost === 4, 'C-07b:窗口内只计数(丢失 1 → 4):' + s2.lost);
check(s2.nextRetryAt === sNext, 'C-07b:窗口内 nextRetryAt **不变**(闸门是时间,不是调用次数):' + s2.nextRetryAt);
stay.close();

// 10d) 第三个闸门(upgrade 通道)也必须能自愈 —— 三个闸门漏改任何一个,那条通道就还是"永久死"
const upHealDir = join(mkdtempSync(join(tmpdir(), 'e4-access-upheal-')), 'logs');
writeFileSync(upHealDir, 'x');
const upHeal = createAccessLog({ dir: upHealDir, retryBaseMs: 0, degradeWarnMs: 0 });
console.error = () => {};
upHeal.observeUpgrade(mockReq({ method: 'GET', url: '/api/remote.mux' }), 101);
const u1 = upHeal.info().health;
check(u1.state === 'degraded' && u1.lost === 1, 'C-07b:upgrade 通道写失败同样降级:' + JSON.stringify([u1.state, u1.lost]));
unlinkSync(upHealDir);
upHeal.observeUpgrade(mockReq({ method: 'GET', url: '/api/remote.mux' }), 101);
console.error = realError;
const u2 = upHeal.info().health;
check(u2.state === 'ok' && upHeal.info().disabled === false && u2.retrySucceeded === 1,
  'C-07b:upgrade 通道(第三个闸门)也能自愈:' + JSON.stringify([u2.state, u2.retrySucceeded]));
check(existsSync(join(upHealDir, `access-${localDay()}.jsonl`)), 'C-07b:upgrade 通道自愈后文件也真的出现');
upHeal.close();

// 10e) 恢复必须**重置告警节流**:否则恢复后紧接着再坏一轮,那一次的首次告警会被上一轮的 warnAt 吃掉
const thDir = join(mkdtempSync(join(tmpdir(), 'e4-access-throttle-')), 'logs');
writeFileSync(thDir, 'x');
const th = createAccessLog({ dir: thDir, retryBaseMs: 0 });   // degradeWarnMs 走默认 60s
const thSeen = [];
const thMark = [];                               // 每次告警后的条数快照:用来钉住"哪一次喊了、哪一次没喊"
console.error = (...a) => { thSeen.push(a.map(String).join(' ')); thMark.push(thSeen.length); };
beat(th);                                        // ① 坏:首次立刻告警
const markAfterFirst = thSeen.length;
beat(th);                                        // ② 仍坏:60s 节流内不重复喊
const markAfterSecond = thSeen.length;
unlinkSync(thDir);
beat(th);                                        // ③ 条件消失 ⇒ 自愈 + 恢复告警
const markAfterHeal = thSeen.length;
// ④ 再坏一轮:目录已经建起来了,所以改拿**当天日志的文件名**去占位(文件换成目录 ⇒ 写必抛 EISDIR)
const thFile = join(thDir, `access-${localDay()}.jsonl`);
unlinkSync(thFile);
mkdirSync(thFile);
beat(th);                                        // 若节流没被重置,这一声会被上一轮的 warnAt 吃掉
console.error = realError;
check(markAfterFirst === 1 && thSeen[0].includes('access log disabled'),
  'C-07b:首次失败立刻告警:' + markAfterFirst);
check(markAfterSecond === 1, 'C-07b:60s 节流内不刷屏(第 2 次失败没喊):' + markAfterSecond);
check(markAfterHeal === 2 && thSeen[1].includes('access log recovered'), 'C-07b:恢复喊一次:' + thSeen[1]);
check(thSeen.length === 3 && thSeen[2].includes('access log disabled'),
  'C-07b:恢复后重置节流 ⇒ 下一轮故障立刻告警(没被上一轮吃掉):' + JSON.stringify(thMark));
check(th.info().health.state === 'degraded' && th.info().health.retryAttempts === 1,
  'C-07b:第二轮是**新的一次故障**(retryAttempts 从 0 重新数):' + JSON.stringify([th.info().health.state, th.info().health.retryAttempts]));
th.close();

// 10f) 时间闸门**会自己打开** —— 没有定时器、没有重启、也不需要有人来"踢一脚":
//      这正是现场那次停摆的反面(41.6 分钟零增长)。整条链上唯一的推动力是"还有请求在来"。
const gateDir = join(mkdtempSync(join(tmpdir(), 'e4-access-gate-')), 'logs');
writeFileSync(gateDir, 'x');
const gate = createAccessLog({ dir: gateDir, retryBaseMs: 400, degradeWarnMs: 0 });
console.error = () => {};
beat(gate);                                      // 失败 ⇒ 排定 ~400ms 后的探针
beat(gate);                                      // 立刻再发:窗口内 ⇒ 不碰盘
const w1 = gate.info().health;
await new Promise((r) => setTimeout(r, 700));    // 窗口自然过期(模块里**没有任何定时器**在推进它)
beat(gate);                                      // 窗口已过 ⇒ 自己再试一次(条件仍坏 ⇒ 再失败一次)
const w2 = gate.info().health;
console.error = realError;
check(w1.failures === 1 && w1.lost === 2, 'C-07b:窗口内的请求只计数不碰盘:' + JSON.stringify([w1.failures, w1.lost]));
check(w2.failures === 2 && w2.retryAttempts === 2 && w2.lost === 3,
  'C-07b:窗口一过就**自己**再试(无人推进/无定时器):' + JSON.stringify([w2.failures, w2.retryAttempts, w2.lost]));
check(w2.nextRetryAt > w1.nextRetryAt, 'C-07b:连败则退避加倍(400ms ⇒ 800ms):' + JSON.stringify([w1.nextRetryAt, w2.nextRetryAt]));
// 与另一路(lib/host/api.js 的 /health)的**接口契约**:字段名与顺序照抄,多一个少一个都算改契约
check(JSON.stringify(Object.keys(w2)) === JSON.stringify([
  'state', 'writes', 'failures', 'lost', 'lostSince', 'lastError', 'warnedAt',
  'recoveredAt', 'retryAttempts', 'nextRetryAt', 'retrySucceeded',
]), 'C-07b:health 字段名/顺序照抄契约:' + JSON.stringify(Object.keys(w2)));
gate.close();

// ---- 11) C-07c(2026-09-27):`audit` 从「health 或 null」改成**两层** —— "没装上"必须能说出为什么 ----
// 缺口:`audit: null` 此前同时代表四种情况(后端没重启 / 有意关闭 / **补丁没打** / 未挂载),
// 界面上**长得一模一样**。第 3 种是真·静默失败(取证能力没上线而没人知道)。
// 契约(与前端/测试的接口,字段名照抄):
//   装上   ⇒ { installed:true, ...11 个 health 字段 }   —— 一个字段都不能少、不能改名
//   没装上 ⇒ { installed:false, reason:'disabled-by-config'|'patch-missing'|'not-mounted' }
//   老后端 ⇒ 压根没有 audit 字段(前端一个字符都不渲染;这一半由 §11c 的源码绊线看住)
// 旧出口 `accessLogHealth()`(**原样返回 info,健康块在 .health 上)**:§9 已钉死"未装/卸载后 = null",
// 保持不动 —— 新契约走**新导出**,不改旧函数(改它会当场让 §9:283/288 变红)。
const { accessLogStatus } = await imp('lib/audit/index.js');
const REASONS = ['disabled-by-config', 'patch-missing', 'not-mounted'];
const realInfo = console.info;   // 安装器会往 stdout 喊一行,自证时要静音(用完必还原)
// 11a) **两种形状互斥**:installed=true 不许带 reason;installed=false 必须带且取值在枚举内。
//      这一条就是"绊线不许恒真"的锚:它同时约束两个分支,任一边漂了就红。
const shapeOf = (s) => {
  if (!s || typeof s !== 'object') return '非法形状(必须两层对象):' + JSON.stringify(s);
  if (s.installed === true) return hasKey(s, 'reason') ? 'installed=true 却带了 reason' : null;
  if (s.installed === false) return REASONS.includes(s.reason) ? null : 'installed=false 的 reason 不在枚举内:' + String(s.reason);
  return 'installed 必须是布尔:' + JSON.stringify(s.installed);
};
// 11b) 三个 reason 各自的**可复现构造**(都靠 opts.home 指向合成 home,不碰真机 ~/.dsh)
const altHome = mkdtempSync(join(tmpdir(), 'e4-status-home-'));
const patchFile = join(altHome, 'logs', PATCH_STATE_FILE);
mkdirSync(join(altHome, 'logs'), { recursive: true });
// "补丁已 applied"的**合成**状态(照抄补丁脚本写的形状;不读真机那份,免得被现场状态绑住)
const appliedState = JSON.stringify({
  marker: PATCH_MARKER, mode: 'check',
  targets: PATCH_TARGETS.map((t) => ({ id: t.id, state: 'applied' })),
});
// ① 补丁状态文件不在 ⇒ 'patch-missing'(真·静默失败:钩子永远收不到调用)
const stMissing = accessLogStatus({ home: altHome });
check(stMissing.installed === false && stMissing.reason === 'patch-missing',
  'C-07c:补丁状态文件不在 ⇒ patch-missing:' + JSON.stringify(stMissing));
// ② 状态文件在位且两条目标都 applied,但日志器没装 ⇒ 'not-mounted'(兜底分类)
writeFileSync(patchFile, appliedState);
const stNotMounted = accessLogStatus({ home: altHome });
check(stNotMounted.installed === false && stNotMounted.reason === 'not-mounted',
  'C-07c:补丁在位但没装 ⇒ not-mounted:' + JSON.stringify(stNotMounted));
// ③ 补丁**半途**(一条 applied、一条 stale)⇒ 仍算 patch-missing —— 半打的补丁等于没打
writeFileSync(patchFile, JSON.stringify({
  marker: PATCH_MARKER, mode: 'check',
  targets: [{ id: PATCH_TARGETS[0].id, state: 'applied' }, { id: PATCH_TARGETS[1].id, state: 'stale' }],
}));
check(accessLogStatus({ home: altHome }).reason === 'patch-missing', 'C-07c:补丁不完整也算 patch-missing(半打=没打)');
// ④ 标记不是本插件的 ⇒ 同样是 patch-missing(别人的状态文件不算数)
writeFileSync(patchFile, JSON.stringify({ marker: 'someone-else', targets: [{ id: 'x', state: 'applied' }] }));
check(accessLogStatus({ home: altHome }).reason === 'patch-missing', 'C-07c:marker 不匹配 ⇒ patch-missing(不信别人的状态文件)');
// ⑤ 有意关闭:`enabled:false` 是**调用方带进来的**判据(重启后模块内拿不到,见实现注释)
check(accessLogStatus({ home: altHome, enabled: false }).reason === 'disabled-by-config',
  'C-07c:调用方传 enabled:false ⇒ disabled-by-config(与"没装上"分开)');
// ⑥ 安装器自己留的痕:同进程内装一次(带 enabled:false)后,不传 opts 也能说出来
const offDir = mkdtempSync(join(tmpdir(), 'e4-status-off-'));
console.info = () => {};                                  // 安装器那行 "access log off" 只是噪声
const disposeOff = installAccessLog({}, { dir: offDir, enabled: false });
console.info = realInfo;
check(accessLogStatus({ home: altHome }).reason === 'disabled-by-config',
  'C-07c:安装器留痕 ⇒ 不传 opts 也说 disabled-by-config(不再谎报 not-mounted)');
// ⑦ 卸载/复位后不留残影:关过一次**不能**让后面的判断永远说"有意关闭"
//    (判据链是 active → offByConfig/opts → patchApplied → not-mounted,所以这里先把
//     patch 状态摆成"已 applied" ⇒ 正确结果必然是 not-mounted;若留痕没复位就会谎报"有意关闭")
writeFileSync(patchFile, appliedState);
disposeOff();
const stReset = accessLogStatus({ home: altHome });
check(stReset.reason === 'not-mounted',
  'C-07c:关闭态 disposer 复位留痕 ⇒ 之后回到真实原因:' + JSON.stringify(stReset));
// ⑦b 判据**优先级**也是契约:有意关闭先于"补丁没打" —— 传了 enabled:false 就直说关闭
//     (补丁此刻仍缺 ⇒ 若优先级反了,这里会拿到 patch-missing)
writeFileSync(patchFile, JSON.stringify({ marker: 'someone-else', targets: [] }));
check(accessLogStatus({ home: altHome, enabled: false }).reason === 'disabled-by-config',
  'C-07c:opts.enabled===false 优先级高于 patch 判据(不会把"主人关的"说成"补丁没打")');
writeFileSync(patchFile, appliedState);   // 复位:后面几条都靠"补丁在位"这个前提
// ⑧ 装上那一半:`installed:true` + 11 个 health 字段齐、无 reason、无 key 漂移
console.info = () => {};
const disposeOn = installAccessLog({}, { dir: offDir, degradeWarnMs: 0 });
console.info = realInfo;
const stOn = accessLogStatus();
check(stOn.installed === true, 'C-07c:装上 ⇒ installed:true:' + JSON.stringify(stOn.installed));
check(shapeOf(stOn) === null, 'C-07c:装上这一支的形状合法:' + String(shapeOf(stOn)));
const missOn = HEALTH_KEYS.filter((k) => !hasKey(stOn, k));
check(missOn.length === 0, 'C-07c:installed=true 时 11 个 health 字段一个不少;缺:' + (missOn.join(',') || '无'));
check(!hasKey(stOn, 'reason'), 'C-07c:installed=true 时**不得**带 reason(两个分支互斥)');
// 键序照抄:installed 打头 + 11 个字段原序(消费端可能按位读,也让"顺序被重排"当场可见)
check(JSON.stringify(Object.keys(stOn)) === JSON.stringify(['installed', ...HEALTH_KEYS]),
  'C-07c:键序 = installed + 11 字段原序:' + JSON.stringify(Object.keys(stOn)));
check(stOn.state === 'ok' && stOn.writes === 0, 'C-07c:带过来的 health 是真值(不是占位):' + JSON.stringify([stOn.state, stOn.writes]));
disposeOn();
check(accessLogStatus({ home: altHome }).reason === 'not-mounted', 'C-07c:卸载后回到"没装上"那一支');
// ⑨ 旧出口**没被动过**:§9 的 `accessLogHealth() === null` 继续成立(两条出口不是同一条)
check(accessLogHealth() === null, 'C-07c:旧出口 accessLogHealth() 语义不变(仍未装 ⇒ null)');
shapeOf(stMissing); shapeOf(stNotMounted); shapeOf(stOn);

// 11c) **消费端源码绊线**:形状改了但前端/路由没跟上 = 界面上静悄悄显示错(比不显示更坏)
const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
check(/return accessLogStatus\(\{ enabled: [^)]*\}\);/.test(apiSrc),
  'C-07c:/health 与两个视图的 audit 字段都走 accessLogStatus({ enabled })');
check(!/accessLogHealth\(\)\?\.health/.test(apiSrc),
  'C-07c:旧写法 `accessLogHealth()?.health ?? null` 已撤(否则"没装上"永远说不出口)');
check(/catch \{ return null; \}/.test(apiSrc), 'C-07c:健康面仍保 try/catch(不许把 sendJson 带崩)');
// 11c-2) **真发一发** `/health`(不碰真网络):拿假 webServer 收下路由表,再把 handler 当函数调一次。
//        这一步是"契约真到得了网线那头"的证据 —— 上面前两条只证明源码里有这行字。
const routes = new Map();
const fakeServer = { register: (r) => { routes.set(r.path, r.handler); return () => {}; } };
let wireErr = null;
try {
  const { registerApi } = await imp('lib/host/api.js');
  registerApi({ get: () => fakeServer },
    { gate: {}, memory: { kvSet() {}, listOverviews: () => [], fingerprint: () => '' }, settings: { get: () => ({ guard: { enforce: false } }) } },
    { version: 'test' });
} catch (e) { wireErr = e; }   // 宿主契约若变了,这里可能抛 —— 抛了就当"这一条测不了",不让它把整份测试带崩
const healthHandler = routes.get('/api/dsh-ling/health');
check(!!healthHandler, 'C-07c:/health 路由确实注册了(路径 = /api/dsh-ling/health);挂到:' + [...routes.keys()].length + ' 条;异常:' + String(wireErr && wireErr.message));
if (healthHandler) {
  const out = { headers: {}, body: '' };
  const res = { statusCode: 0, setHeader: (k, v) => { out.headers[k] = v; }, end: (b) => { out.body = String(b); } };
  await healthHandler({ method: 'GET', url: '/api/dsh-ling/health', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, res);
  const parsed = JSON.parse(out.body);
  check(/application\/json/.test(String(out.headers['Content-Type'])), 'C-07c:/health 回 JSON(Content-Type 就位)');
  check(parsed.ok === true && parsed.plugin === 'dsh-ling', 'C-07c:/health 仍是老形状(ok/plugin 没被新契约挤掉)');
  check(shapeOf(parsed.audit) === null, 'C-07c:/health 上的 audit 形状合法(两层契约真的走出去了):' + String(shapeOf(parsed.audit)));
  // 此刻进程里日志器是**没装**的(§9 已 dispose 且此后没再装),patch 状态又是合成 home ⇒ 必然是"没装上"那一支
  check(parsed.audit && parsed.audit.installed === false && REASONS.includes(parsed.audit.reason),
    'C-07c:/health 真的说出了"为什么没装":' + JSON.stringify(parsed.audit));
  check(parsed.audit && (!hasKey(parsed.audit, 'writes') || parsed.audit.installed === true),
    'C-07c:没装上时不带 health 字段(两种形状不许混在一起)');
}
const cliSrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(/installed === false/.test(cliSrc) && /已按配置关闭/.test(cliSrc) && /补丁未应用/.test(cliSrc) && /未挂载/.test(cliSrc),
  'C-07c:面板认得 installed:false 三种原因(关了 / 补丁没打 / 没挂载 必须能分辨)');
// 红点判据**行为绊线**(不是"源码里有这几个字"那种恒真断言):
// 把那段真判据原文抠出来,**逐字**跑一张真值表 —— 改判据(哪怕加个 `|| true`)当场就红。
const offSrcM = /var auditOffBad = ([\s\S]*?\));[\r\n]\s*var auditBad = ([^;]*);/.exec(cliSrc);
check(!!offSrcM, 'C-07c:能在 client.js 里抠到红点判据那两行(名字/形状没被重构掉)');
const badOf = (audit) => {
  const stub = (audit === undefined) ? 'var st = {};' : ('var st = { audit: ' + JSON.stringify(audit) + ' };');
  const src = stub + '\n'
    + 'var auditOffBad = ' + offSrcM[1].split('\n').map((s) => s.trim()).join('\n') + ';\n'
    + 'var auditBad = ' + offSrcM[2] + ';\nreturn { off: auditOffBad, bad: auditBad };';
  return new Function(src)();
};
const TRUTH = [
  [{ state: 'ok', writes: 3, lost: 0 }, false, false, '正常不红'],
  [{ state: 'degraded', lost: 2, lastError: { code: 'EACCES' } }, false, true, '停写必红'],
  [{ installed: false, reason: 'patch-missing' }, true, true, '补丁没打(真静默失败)必红'],
  [{ installed: false, reason: 'not-mounted' }, true, true, '未挂载(应为但没装)必红'],
  [{ installed: false, reason: 'disabled-by-config' }, false, false, '有意关闭**不染红**(否则红点没人看)'],
  [{ installed: true, state: 'off', writes: 0, lost: 0 }, false, false, '老姿势 state=off 也不红'],
  [undefined, false, false, '老后端(没有 audit 字段)不红'],
];
for (const [audit, wantOff, wantBad, why2] of TRUTH) {
  const got = badOf(audit);
  check(got.off === wantOff && got.bad === wantBad,
    'C-07c 红点真值表 · ' + why2 + ' ⇒ ' + JSON.stringify(got) + '(期望 off=' + wantOff + ' bad=' + wantBad + ')');
}
// 原因 → 中文:面板那个对象字面量里的键值必须**逐字**对上契约(键错 = 界面上显示"原因未知(…)"甚至空白)
const whyMapM = /\{\s*'disabled-by-config':\s*'([^']*)',\s*'patch-missing':\s*'([^']*)',\s*'not-mounted':\s*'([^']*)'\s*\}/.exec(cliSrc);
check(!!whyMapM && whyMapM[1] === '已按配置关闭' && whyMapM[2] === '补丁未应用' && whyMapM[3] === '未挂载',
  'C-07c:原因 → 中文的映射逐字照抄:' + JSON.stringify(whyMapM ? [whyMapM[1], whyMapM[2], whyMapM[3]] : null));
check(/lines\.push\('访问日志: 未启用（' \+ why \+ '）'\)/.test(cliSrc),
  'C-07c:面板文案 = 访问日志: 未启用（<中文原因>）');
// 面板那支**必须**对三个 reason 都给出非空中文:映射表就是判据本身(上面已逐字对上),
// 这里再钉一条"表里只有这三个键、没有多余的" —— 多一个键意味着有人往契约里塞了第四种原因。
const whyKeys = whyMapM ? new Function('return Object.keys(' + whyMapM[0] + ');')() : [];
check(JSON.stringify(whyKeys) === JSON.stringify(REASONS),
  'C-07c:原因映射表的键恰为三个契约值:' + JSON.stringify(whyKeys));
// 老后端(没有 audit 字段)⇒ 一个字符都不渲染:分支必须整体挂在 `if (r.audit)` 之内
const panelAt = cliSrc.indexOf('installed === false');
check(panelAt > 0 && cliSrc.lastIndexOf('if (r.audit) {', panelAt) > 0,
  'C-07c:新分支在 `if (r.audit)` 之内(老后端仍是一个字符都不渲染)');

// ---- 12) CR-1(2026-10-01 红队,发布阻断项):设备 cookie 名**默认值必须中性** + 配置通路仍生效 ----
// 现场:那行默认值曾写成**某一台机器改过名的 cookie 名**(remote-web-ui 的 `cookieName`),被当成了
// 出厂默认 —— 具体值不在本文件复述(本文件同样是公开物)。后果双重:① 这行随包公开;
// ② 别人机器上 cookie 名对不上 ⇒ `deviceCookie` **恒 false**、设备维度**静默失效**
// (看起来像"这台设备没带 cookie",比漏记更坏)。
// 三条断言:① 不带任何配置 ⇒ 中性默认(且真的能认出标准 cookie);② 配了 ⇒ 取配置值
// (env 与宿主配置两条通路,后者 = 本机改名仍能生效的证明);③ 源码级护栏,拦"带后缀的改名"
// 这一整类回归。
// ⚠ 环境变量是**进程级**的:本段自己设置并恢复 `process.env`,既不依赖跑测机器的环境,
//   也不把值漏给后面可能新增的用例(段与段之间本来就是独立进程)。
check(resolveDeviceCookie({}, {}) === 'dsh_pair' && ACCESS_LOG_DEFAULTS.deviceCookie === 'dsh_pair',
  'CR-1①:出厂默认 = 上游 remote-web-ui 的默认名(中性,不带任何机器的私有改名):' + ACCESS_LOG_DEFAULTS.deviceCookie);
check(resolveDeviceCookie({}, { DSH_LING_DEVICE_COOKIE: 'dsh_pair-x' }) === 'dsh_pair-x',
  'CR-1②a:环境变量 DSH_LING_DEVICE_COOKIE 能改掉默认名(不改代码即恢复本机改名)');
check(resolveDeviceCookie({ deviceCookie: 'dsh_pair-y' }, { DSH_LING_DEVICE_COOKIE: 'dsh_pair-x' }) === 'dsh_pair-y',
  'CR-1②b:宿主配置(accessLog.deviceCookie)优先于环境变量');
check(resolveDeviceCookie({ deviceCookie: '   ' }, { DSH_LING_DEVICE_COOKIE: '  ' }) === 'dsh_pair',
  'CR-1:空串 / 纯空白按"没设"处理(回落中性默认,不产生空 cookie 名)');

const savedEnvCookie = process.env.DSH_LING_DEVICE_COOKIE;
const dirCookie = mkdtempSync(join(tmpdir(), 'e4-access-cookie-'));
try {
  // ① 默认情形:进程里没有任何配置 ⇒ 日志器必须按中性默认名找 cookie,且**找得到**
  delete process.env.DSH_LING_DEVICE_COOKIE;
  const neutral = createAccessLog({ dir: dirCookie });
  check(neutral.info().deviceCookie === 'dsh_pair',
    'CR-1①:不带配置建日志器 ⇒ info() 报中性默认名:' + neutral.info().deviceCookie);
  const eDef = run(neutral, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair=${HEX}` } }), 200);
  check(eDef.deviceCookie === true && eDef.deviceId === HEX_DIGEST,
    'CR-1①:中性默认名下,**标准 cookie** 认得出(设备维度真的活着):' + JSON.stringify([eDef.deviceCookie, eDef.deviceId]));
  neutral.close();

  // ② 配置优先:env 设成改名 ⇒ 日志器按它取;**改名生效后新名认得出、旧名不再误认**
  process.env.DSH_LING_DEVICE_COOKIE = 'dsh_pair-x';
  const renamed = createAccessLog({ dir: dirCookie });
  check(renamed.info().deviceCookie === 'dsh_pair-x',
    'CR-1②:环境变量生效,日志器取到配置值:' + renamed.info().deviceCookie);
  const eRen = run(renamed, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-x=${HEX}` } }), 200);
  const eOld = run(renamed, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair=${HEX}` } }), 200);
  check(eRen.deviceCookie === true && eRen.deviceId === HEX_DIGEST && eOld.deviceCookie === false,
    'CR-1②:改名生效 ⇒ 新名认得出 / 旧名不再误认:' + JSON.stringify([eRen.deviceCookie, eOld.deviceCookie]));
  renamed.close();

  // ② 宿主配置通路(**这条证明"本机改名仍能生效"**):与 lib/index.js:72 → lib/audit/index.js:98
  //    同一接线 —— installer 把 cfg.accessLog 原样透传给 createAccessLog。
  const disposeCfg = installAccessLog({}, { dir: dirCookie, deviceCookie: 'dsh_pair-y' });
  check(accessLogHealth()?.deviceCookie === 'dsh_pair-y',
    'CR-1②:宿主配置 accessLog.deviceCookie 生效且优先于环境变量(installer 透传):' + accessLogHealth()?.deviceCookie);
  disposeCfg();
} finally {
  if (savedEnvCookie === undefined) delete process.env.DSH_LING_DEVICE_COOKIE;
  else process.env.DSH_LING_DEVICE_COOKIE = savedEnvCookie;
}

// ③ 源码级护栏:默认值位**不许**再出现"带后缀的改名"这一整类值。
// 判据刻意**不写那个具体值**(本文件同样是公开物,不再抄一遍):`dsh_pair` 紧跟字母/数字 = 带后缀
// 的改名 —— 拦的是"某一台机器的值被粘进默认位"这个**类**,而不是某一个字符串。
const srcCookie = readFileSync(join(root, 'lib/audit/access-log.js'), 'utf8');
check(!/dsh_pair-[A-Za-z0-9]/.test(srcCookie),
  'CR-1③:源码里不得再出现"带后缀的改名"(这一类回归通杀,连注释一起查)');
check(/deviceCookie:\s*'dsh_pair'/.test(srcCookie),
  'CR-1③:默认值位置逐字是中性名 dsh_pair(不是引用别的常量、也不是改名)');
check(/export function resolveDeviceCookie\(/.test(srcCookie) && /const deviceCookie = resolveDeviceCookie\(options\)/.test(srcCookie),
  'CR-1③:cookie 名只有一条解析路径(option → env → 默认),不是第二处手写副本');
check(!/String\(options\.deviceCookie \|\| ACCESS_LOG_DEFAULTS\.deviceCookie\)/.test(srcCookie),
  'CR-1③:旧的"选项或默认"二值写法已撤(它读不到 env,中性化后会弄坏改过名的机器)');

log.close();
console.log(ok ? 'E4 访问日志全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
