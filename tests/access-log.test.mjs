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
const { createAccessLog, localIso, localDay, rejectionReason, deviceIdFromCookieValue, POSTURE_PROBE_PATH } = await imp('lib/audit/access-log.js');
const { PATCH_TARGETS, PATCH_MARKER, OBSERVE_GLOBAL, UPGRADE_GLOBAL } = await imp('lib/audit/patch-spec.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

const HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function mockReq({ method = 'POST', url = '/api/x', headers = {}, ip = '127.0.0.1' } = {}) {
  return { method, url, headers, socket: { remoteAddress: ip } };
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
const e403 = run(log, mockReq({ headers: { host: '192.0.2.66:3080' } }), 403);
check(e403.status === 403 && e403.rejection === 'untrusted-host', '403 → untrusted-host:' + JSON.stringify(e403.rejection));
const e401a = run(log, mockReq({ headers: { host: '127.0.0.1:3080' } }), 401);
check(e401a.rejection === 'no-cookie', '401 无 cookie → no-cookie:' + e401a.rejection);
const e401b = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: 'dsh-auth-xyz=deadbeef' } }), 401);
check(e401b.rejection === 'bad-cookie', '401 带伪 cookie → bad-cookie:' + e401b.rejection);
const e200 = run(log, mockReq({ headers: { host: '127.0.0.1:3080', cookie: `dsh_pair-W=${HEX}` } }), 200);
check(e200.status === 200 && e200.rejection === null, '200 → rejection 为 null');
check(e200.deviceId === HEX && e200.deviceCookie === true, '设备 hash 落地:' + e200.deviceId);
check(e200.channel === 'no-ua', '无 UA 的放行行标 channel:"no-ua":' + JSON.stringify(e200.channel));

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
const posture = run(log, mockReq({ url: '/api/session.list', headers: { host: 'main.dsh-ling.com' } }), 403);
check(posture.probe === 'posture', '五要素齐全 → 标 probe:"posture":' + JSON.stringify(posture.probe));
check(posture.status === 403 && posture.rejection === 'untrusted-host', '标注不代表放行(仍是 403 被拦下)');
check(posture.channel === 'no-ua', '探针行同时标 channel(它确实没有 UA):' + JSON.stringify(posture.channel));
const notProbe = [
  ['带 UA', { url: '/api/session.list', headers: { host: 'main.dsh-ling.com', 'user-agent': 'Mozilla/5.0' } }, 403],
  ['路径不同', { url: '/api/session/prompt', headers: { host: 'main.dsh-ling.com' } }, 403],
  ['已放行', { url: '/api/session.list', headers: { host: 'main.dsh-ling.com' } }, 200],
  ['非 loopback', { url: '/api/session.list', headers: { host: 'main.dsh-ling.com' }, ip: '192.0.2.50' }, 403],
];
for (const [why, req, code] of notProbe) {
  const e = run(log, mockReq(req), code);
  check(e.probe === undefined, `反例(${why})不得标注,实际 ` + JSON.stringify(e.probe));
}

// 4) WebSocket upgrade(/api/remote.mux):没有 statusCode,结局由栅栏码决定
const up1 = run(log, mockReq({ method: 'GET', url: '/api/remote.mux', headers: { host: '192.0.2.66:3080' } }), 0, { upgrade: true, rejection: 403 });
check(up1.phase === 'upgrade' && up1.status === 403 && up1.rejection === 'untrusted-host', 'upgrade 被拒:' + JSON.stringify(up1.status));
const up2 = run(log, mockReq({ method: 'GET', url: '/api/remote.mux', headers: { host: '127.0.0.1:3080' } }), 0, { upgrade: true, rejection: undefined });
check(up2.status === 101, 'upgrade 放行记 101:' + up2.status);

// 5) 绝不抛进请求路径:目录不可用时静默降级
const bogusDir = join(dir, 'not-a-dir');
writeFileSync(bogusDir, 'x');           // 同名的文件占位 → mkdirSync 必失败
const broken = createAccessLog({ dir: bogusDir });
const bres = mockRes();
let threw = false;
try {
  broken.observe(mockReq(), bres);
  bres.writeHead(200);
  bres.end();
} catch (e) { threw = true; }
check(!threw, '日志坏掉也不抛进请求路径');
check(broken.info().disabled === true, '坏掉后自我禁用(不再反复试)');
broken.close();

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
check(deviceIdFromCookieValue(`v1.${HEX}.signature`) === HEX, '签名形态里也能取到设备 hash');
// 真实形态(2026-09-25 核实):@linxin666/dsh-remote-web-ui 的 pairing.ts 用 clock.randomToken()
// 生成 32 位十六进制**明文**原样写进配对 cookie。用合成值钉住它 —— 绝不用真机 deviceId(那是凭据)。
const REAL_SHAPE = '0123456789abcdef0123456789abcdef';
check(deviceIdFromCookieValue(REAL_SHAPE) === REAL_SHAPE, '真实形态(32-hex 明文)原样取到');
check(deviceIdFromCookieValue(REAL_SHAPE.toUpperCase()) === REAL_SHAPE, '大写归一成小写');
check(deviceIdFromCookieValue('opaque-not-hex') === null, '取不到就返回 null(不编造)');
check(localIso(new Date(2026, 8, 24, 19, 49, 51, 123)).startsWith('2026-09-24T19:49:51.123'), 'localIso 对齐现场时刻');

log.close();
console.log(ok ? 'E4 访问日志全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
