// E4 · 可取证访问日志（任务书：E:\DSH\daily\E4 - 可取证日志（任务书）.md）
//
// 目标：让「谁 · 何时 · 从哪台设备 · 调用了哪个端点 · 结果如何」事后可回答。
// 起因：2026-09-24 19:49:51 的那次调度重启，四条排查路全走死，最后只剩
//       「一次真实点击或一次合成点击」——**因为整个系统没有一行访问日志**。
//
// 边界（任务书 §3.3）：只记「发生了什么事」，不记「内容是什么」
//   · 不落请求体 / 响应体 · 不落 cookie 值（只落验签结果与设备 hash）
//   · 查询串一律丢弃（/?token=… 这类凭据不得进日志）
//
// 三条工程约束（都来自现场教训，不是风格偏好）：
//   1) **同步落盘**：悬案现场是「调度重启后 1200ms 进程退出」——异步写缓冲会把最后
//      一行丢掉，而最后一行恰恰是最重要的那行。用 appendFileSync（开→写→关）。
//      为什么不是「常开 fd + writeSync」：句柄一直握着时目录项会停在旧值 —— 实测
//      文件里已有 77 行，`Get-Item` 仍报 0 字节、mtime 停在创建那一刻；这正好是未来
//      取证时最容易误判成「什么都没记」的假象。且 Windows 上被别的句柄占用的文件
//      删不掉，会挡住按天轮转。
//   2) **绝不抛进请求路径**：任何异常都被吞掉（最多向 stderr 告警一次）。日志系统
//      坏掉也不能让请求变慢、变错、500。
//   3) **只观察、不判定**：本模块不调用鉴权、不改响应。状态码与拒绝原因全部来自
//      「已经发生的响应」，判据与 guard 保持单一来源（任务书 §3.5）。

import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PREFIX = 'access-';
const FILE_SUFFIX = '.jsonl';
/** 配对设备 id 是 32 位 hex（devices.json 的键就是它）；放宽到 16~64 位以兼容形态变化。 */
const HEX_RUN = /[0-9a-f]{16,64}/i;
/** core 的鉴权 cookie 前缀（dsh-client-connection：`dsh-auth-<base64url(sha256(authority))>`）。 */
const AUTH_COOKIE_PREFIX = 'dsh-auth-';
/**
 * 部署姿态自检探针的路径（`@linxin666/dsh-remote-web-ui` · `src/posture.ts`）：
 * 它伪造 Host 打本机 loopback，专门验证 `/api` 栅栏 —— **403 才是它期望的健康结果**。
 * 命中签名时多打 `probe:"posture"`，免得把自家自检误判成入侵（任务书 §7.5）。
 */
export const POSTURE_PROBE_PATH = '/api/session.list';
/**
 * 「无 UA 行」的通道标记（任务书 §7.5）:请求连 `user-agent` 头都没有 ⇒ **不是浏览器直连**。
 * 但这一类**混装两种调用者** —— 进程内客户端(boot 批量的内部 RPC)与经远端通道代理进来的
 * 设备(手机/平板/物理机,代理按设计不转发 UA)。故本字段只陈述"非浏览器通道"这一**事实**,
 * **不指认是哪一台设备**;要分辨两者得看端点语义(判读口径见任务书 §7.5)。
 */
export const CHANNEL_NO_UA = 'no-ua';

export const ACCESS_LOG_DEFAULTS = {
  enabled: true,
  /** 目录：默认 $DSH_HOME/logs（调用方补）。 */
  dir: '',
  /** 总大小上限（字节）：超限删最旧，当天文件永不删。0 = 不限制。 */
  maxTotalBytes: 32 * 1024 * 1024,
  /** UA 截断长度：UA 能区分浏览器/脚本/哪台设备，但整条太长。 */
  uaMax: 200,
  /** 携带已配对设备标识的 cookie 名（= settings.yaml 的 remote-web-ui.cookieName）。 */
  deviceCookie: 'dsh_pair-W',
  /** 高危端点：命中则多打一个 risk 字段，便于 grep。 */
  riskPatterns: ['settingRestart/restart', '/dsh-ling/'],
};

/** 本地时间 ISO（带毫秒与偏移）：既能排序、又能直接肉眼对齐现场时刻。 */
export function localIso(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}.${p(date.getMilliseconds(), 3)}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  );
}

/** 本地日期 `YYYY-MM-DD`：日志按天切的文件名口径。 */
export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const v = headers[name];
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}

function truncate(text, max) {
  if (text === undefined) return null;
  const s = String(text);
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** 只留路径：查询串与 hash 一律丢弃（可能含凭据）。 */
function pathOf(req) {
  let raw = '';
  try {
    raw = String(req?.url ?? '');
  } catch {
    raw = '';
  }
  const cut = Math.min(
    ...['?', '#'].map((c) => {
      const i = raw.indexOf(c);
      return i < 0 ? raw.length : i;
    }),
  );
  return truncate(raw.slice(0, cut), 300) || null;
}

/** 不做通用 Cookie 解码：只按名字找那一个（与 core 的做法一致）。 */
export function cookieValueOf(headerValue, name) {
  if (typeof headerValue !== 'string' || !headerValue || !name) return undefined;
  for (const part of headerValue.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * 从配对 cookie 值里取设备 hash（多策略，取不到就返回 null 并如实记 present）。
 * **权威形态（2026-09-25 定点核实）**：`@linxin666/dsh-remote-web-ui` 的 `src/pairing.ts`
 * 用 `clock.randomToken()` 生成 **32 位十六进制明文**，经 `src/routes.ts` 原样写进 cookie
 * （`$DSH_HOME/remote-web-ui-devices.json` 的键实测同为 32-hex）；cookie 名默认 `dsh_pair`，
 * 本机配置为 `dsh_pair-W`。多策略保留只为「不赌它改版」：先找 hex run，再试点分段。
 */
export function deviceIdFromCookieValue(value) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (!s) return null;
  const direct = s.match(HEX_RUN);
  if (direct) return direct[0].toLowerCase();
  const first = s.split(/[.~|:,]/)[0];
  const seg = first && first.match(HEX_RUN);
  return seg ? seg[0].toLowerCase() : null;
}

function firstForwarded(headers) {
  return (
    header(headers, 'cf-connecting-ip') ||
    (header(headers, 'x-forwarded-for') || '').split(',')[0].trim() ||
    header(headers, 'x-real-ip') ||
    undefined
  );
}

/**
 * 拒绝原因：**只从已经发生的响应反推**，不重跑鉴权。
 *  403 = Host/Origin 栅栏拦下（core 里 403 的唯一来源）→ untrusted-host
 *  401 = 栅栏过了但 cookie 没验过：带没带 cookie 区分 no-cookie / bad-cookie
 */
export function rejectionReason(status, headers) {
  if (status === 403) return 'untrusted-host';
  if (status === 401) {
    const raw = header(headers, 'cookie') || '';
    return raw.includes(AUTH_COOKIE_PREFIX) ? 'bad-cookie' : 'no-cookie';
  }
  return null;
}

/**
 * 建一个访问日志器。所有方法都不抛（内部全兜）。
 * @param {object} options 见 {@link ACCESS_LOG_DEFAULTS}（dir 必填）
 */
export function createAccessLog(options = {}) {
  const dir = String(options.dir || ACCESS_LOG_DEFAULTS.dir || '');
  const maxTotalBytes = Number.isFinite(Number(options.maxTotalBytes))
    ? Number(options.maxTotalBytes)
    : ACCESS_LOG_DEFAULTS.maxTotalBytes;
  const uaMax = Number.isFinite(Number(options.uaMax)) ? Number(options.uaMax) : ACCESS_LOG_DEFAULTS.uaMax;
  const deviceCookie = String(options.deviceCookie || ACCESS_LOG_DEFAULTS.deviceCookie);
  const riskPatterns = (Array.isArray(options.riskPatterns) ? options.riskPatterns : ACCESS_LOG_DEFAULTS.riskPatterns)
    .filter((p) => typeof p === 'string' && p);

  let day = null;
  let writes = 0;
  let disabled = options.enabled === false || !dir;
  let warned = false;

  const warn = (err) => {
    if (warned) return;
    warned = true;
    try {
      console.error('[dsh-ling] access log disabled:', (err && err.message) || err);
    } catch {}
  };

  const fileNameOf = (d) => `${FILE_PREFIX}${d}${FILE_SUFFIX}`;

  /** 超限删最旧（按文件名=时间序），当天文件永不删。 */
  function enforceCap() {
    if (!(maxTotalBytes > 0) || !dir) return;
    let names;
    try {
      names = readdirSync(dir)
        .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))
        .sort();
    } catch {
      return;
    }
    const current = day ? fileNameOf(day) : '';
    const sized = names.map((n) => {
      try {
        return { n, size: statSync(join(dir, n)).size };
      } catch {
        return { n, size: 0 };
      }
    });
    let total = sized.reduce((a, b) => a + b.size, 0);
    for (const f of sized) {
      if (total <= maxTotalBytes) break;
      if (f.n === current) continue;
      try {
        unlinkSync(join(dir, f.n));
        total -= f.size;
      } catch {}
    }
  }

  /** 确认当天文件所在目录存在；跨天时顺手做一次超限裁剪。返回当天文件名。 */
  function ensureDay() {
    const today = localDay();
    if (day !== today) {
      mkdirSync(dir, { recursive: true });
      day = today;
      enforceCap();
    }
    return fileNameOf(day);
  }

  function append(entry) {
    if (disabled) return;
    let line;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch {
      return;
    }
    try {
      appendFileSync(join(dir, ensureDay()), line);
      if (++writes % 256 === 0) enforceCap();
    } catch (err) {
      disabled = true;
      warn(err);
    }
  }

  function deviceFields(headers) {
    const value = cookieValueOf(header(headers, 'cookie'), deviceCookie);
    if (value === undefined) return { deviceCookie: false, deviceId: null };
    return { deviceCookie: true, deviceId: deviceIdFromCookieValue(value) };
  }

  function baseFields(req) {
    const headers = (req && req.headers) || {};
    const sock = (req && (req.socket || req.connection)) || {};
    return {
      ip: sock.remoteAddress ? String(sock.remoteAddress) : null,
      fwd: truncate(firstForwarded(headers), 60) || null,
      host: truncate(header(headers, 'host'), 120) || null,
      ua: truncate(header(headers, 'user-agent'), uaMax),
      bytes: Number.isFinite(Number(header(headers, 'content-length')))
        ? Number(header(headers, 'content-length'))
        : null,
      ...deviceFields(headers),
    };
  }

  /** loopback 的三种写法（v4 / v6 / v4-mapped）：姿态探针只打本机，来源必是其中之一。 */
  function isLoopback(ip) {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  /**
   * 姿态自检探针的**五要素签名**（任务书 §7.5）：POST + 路径 + loopback + 无 UA + 被 403 拦下。
   * 五条同时命中才标注 —— 放宽任何一条都会把真攻击错标成"自检"（PITFALLS B3：判据过宽）。
   * 标注**不代表放行**：被标注的行仍然是"被栅栏拦下"的记录，status 依旧是 403。
   */
  function isPostureProbe(entry) {
    return (
      entry.method === 'POST' &&
      entry.path === POSTURE_PROBE_PATH &&
      entry.status === 403 &&
      entry.rejection === 'untrusted-host' &&
      entry.ua === null &&
      isLoopback(entry.ip)
    );
  }

  function entryOf(req, base, status, extra) {
    const path = pathOf(req);
    const entry = {
      at: localIso(),
      method: (req && req.method) || null,
      path,
      status: Number.isFinite(status) && status > 0 ? status : null,
      rejection: rejectionReason(status, (req && req.headers) || {}),
      ip: base.ip,
      fwd: base.fwd,
      host: base.host,
      ua: base.ua,
      // 无 UA ⇒ 非浏览器通道(进程内客户端 / 经远端代理进来的设备);不指认是哪一台。
      channel: base.ua === null ? CHANNEL_NO_UA : undefined,
      deviceCookie: base.deviceCookie,
      deviceId: base.deviceId,
      bytes: base.bytes,
      ...extra,
    };
    if (path) {
      const hit = riskPatterns.find((p) => path.includes(p));
      if (hit) entry.risk = hit;
    }
    if (isPostureProbe(entry)) entry.probe = 'posture';
    return entry;
  }

  /**
   * 观察一个 HTTP 请求：挂最小响应钩子，拿到真实状态码后同步落一行。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function observe(req, res) {
    if (disabled || !req || !res) return;
    let base;
    try {
      base = baseFields(req);
    } catch {
      return;
    }
    const started = Date.now();
    let finished = false;
    let status = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      try {
        if (status > 0 || Number.isFinite(res.statusCode)) {
          status = status || res.statusCode;
        }
        append(entryOf(req, base, status, { ms: Date.now() - started }));
      } catch {}
    };
    try {
      const origWriteHead = res.writeHead;
      if (typeof origWriteHead === 'function') {
        res.writeHead = function patchedWriteHead(code, ...rest) {
          if (typeof code === 'number' && code > 0) status = code;
          return origWriteHead.call(this, code, ...rest);
        };
      }
      const origEnd = res.end;
      if (typeof origEnd === 'function') {
        res.end = function patchedEnd(...args) {
          try {
            finish();
          } catch {}
          return origEnd.apply(this, args);
        };
      }
      if (typeof res.once === 'function') res.once('close', finish);
    } catch {}
  }

  /**
   * 观察一次 WebSocket upgrade（/api/remote.mux）：这里没有 statusCode 可读，
   * 结局在调用点就已经确定 —— rejection 为空即放行（101），否则就是栅栏码。
   */
  function observeUpgrade(req, rejection) {
    if (disabled || !req) return;
    try {
      const status = Number.isFinite(rejection) && rejection > 0 ? rejection : 101;
      append(entryOf(req, baseFields(req), status, { phase: 'upgrade' }));
    } catch {}
  }

  /** 无句柄可关（每次写都开→写→关），保留此方法只为卸载链路的 API 稳定。 */
  function close() {}

  return {
    observe,
    observeUpgrade,
    append,
    close,
    info: () => ({
      dir,
      file: day ? join(dir, fileNameOf(day)) : join(dir, fileNameOf(localDay())),
      maxTotalBytes,
      deviceCookie,
      riskPatterns,
      disabled,
    }),
  };
}
