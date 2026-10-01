// E4 访问日志 · 插件侧安装器
//
// 职责：把日志器挂到 core 补丁预留的两个全局钩子上，并在卸载时干净摘除。
// 不做的事：不碰鉴权判定、不碰记忆与人格数据。
//
// 一个重要性质：**没有补丁也安全**。钩子只是挂在 globalThis 上的可选调用，
// 补丁那一行写的是 `globalThis.__dshAccessLogObserve?.(…)` —— 插件在不在、
// 补丁打没打，DSH 都能照常启动与响应。

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { dshHome } from '../host/util.js';
import { createAccessLog } from './access-log.js';
import { OBSERVE_GLOBAL, UPGRADE_GLOBAL, PATCH_STATE_FILE, PATCH_MARKER } from './patch-spec.js';

export { OBSERVE_GLOBAL, UPGRADE_GLOBAL, PATCH_MARKER };

/** 当前活着的访问日志器（同一进程重复安装时取最后一份）。 */
let active = null;

/**
 * C-07：访问日志的**健康面**出口 —— `disabled` / `degraded` / 丢了多少行 / 最后一条 errno。
 * `/health`（`lib/host/api.js`）或界面读这一个函数即可；日志器没装时返回 `null`。
 * 为什么要有这个出口：写失败后旧实现只往 stderr 喊一行就永久静默，
 * 而"日志悄悄不记了"是这套取证能力最该被发现的故障 —— 必须有个**常驻可查**的地方。
 */
export function accessLogHealth() {
  return active ? active.info() : null;
}

/** 有意关闭(config.accessLog.enabled=false)时由安装器留痕 —— 见 accessLogStatus() 的原因 ①。 */
let offByConfig = false;

/** 补丁状态文件说"两条都 applied 了" ⇒ 补丁在位(缺文件 / 认不出标记都算没在)。 */
function patchApplied(home) {
  const st = readPatchState(home);
  if (!st || st.marker !== PATCH_MARKER) return false;
  if (!Array.isArray(st.targets) || st.targets.length === 0) return false;
  return st.targets.every((t) => t && t.state === 'applied');
}

/**
 * C-07c(2026-09-27):访问日志的**三态出口** —— 未装时也要说清"为什么没装"。
 *
 * 背景:`audit === null` 曾经同时代表四种情况(老后端 / 有意关闭 / 补丁没打 / 没挂载),
 * 界面上全是空白,分不出"应为但未装"(真·静默失败)与"有意关闭"。本函数把它们分开。
 *
 * @param {{enabled?: boolean, home?: string}} [opts]
 *   `enabled`:宿主侧真实配置 `config.accessLog.enabled`(读不到就别传 —— 安装器在**同一进程**里
 *   已经记过 `offByConfig`,跨进程/重启后仍建议由调用方把配置传进来,那才是不靠猜的判据)。
 *   `home`:补丁状态文件所在的 $DSH_HOME,测试用;默认 dshHome()。
 * @returns {object} 装上了 ⇒ `{installed:true, ...health 的 11 个字段}`;
 *                   没装上 ⇒ `{installed:false, reason}`。
 *
 * 能拿到的三种 reason(按判据强弱排序):
 *   ① 'disabled-by-config' —— 安装器记过 offByConfig,或调用方传入 enabled===false。**确定性判据**。
 *   ② 'patch-missing'      —— 补丁状态文件缺失 / 标记对不上 / 有目标不是 applied。**确定性判据**
 *                             (补丁真的没打 —— 此时无论插件在不在,请求都不会落盘)。
 *   ③ 'not-mounted'        —— 补丁在位但日志器不在(没装 / 已卸载 / apply 早退 / 同进程别处覆盖)。
 *                            这是**兜底分类**,不是精确诊断:模块内无法把"apply 没跑到"与
 *                            "apply 跑了但安装器抛了"分开(两者都不留痕)。
 */
export function accessLogStatus(opts = {}) {
  if (active) return { installed: true, ...active.info().health };
  if (offByConfig || opts.enabled === false) return { installed: false, reason: 'disabled-by-config' };
  if (!patchApplied(opts.home)) return { installed: false, reason: 'patch-missing' };
  return { installed: false, reason: 'not-mounted' };
}

/** 读补丁状态文件（补丁脚本写的），拿不到就返回 undefined —— 只用于提示，不影响功能。 */
export function readPatchState(home = dshHome()) {
  const file = join(home, 'logs', PATCH_STATE_FILE);
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 安装访问日志。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文（本实现不用它，保留签名一致）
 * @param {object} cfg dsh-ling config 里的 `accessLog` 段
 * @returns {() => void} disposer
 */
export function installAccessLog(ctx, cfg = {}) {
  const options = { ...(cfg || {}) };
  if (!options.dir) options.dir = join(dshHome(), 'logs');
  if (options.enabled === false) {
    offByConfig = true; // C-07c:留痕,好让 accessLogStatus() 说出"有意关闭"而不是"没装上"
    console.info('[dsh-ling] access log off (config.accessLog.enabled=false)');
    // 摘除后不再声称"按配置关闭" —— 否则同一进程里卸载完仍会报 disabled-by-config(会骗人)。
    return () => { offByConfig = false; };
  }
  offByConfig = false;

  const log = createAccessLog(options);
  active = log;
  const previous = { observe: globalThis[OBSERVE_GLOBAL], upgrade: globalThis[UPGRADE_GLOBAL] };
  globalThis[OBSERVE_GLOBAL] = (req, res) => {
    try {
      log.observe(req, res);
    } catch {}
  };
  globalThis[UPGRADE_GLOBAL] = (req, rejection) => {
    try {
      log.observeUpgrade(req, rejection);
    } catch {}
  };

  const info = log.info();
  console.info('[dsh-ling] access log on; dir=%s deviceCookie=%s', info.dir, info.deviceCookie);
  // 补丁没打时钩子永远收不到调用 —— 这是"静默不记"的唯一形态，必须主动喊出来（就下面这一句 warn）。
  const state = readPatchState();
  if (!state || state.marker !== PATCH_MARKER) {
    console.warn('[dsh-ling] core patch missing → run: node tools/apply-access-log-patch.mjs');
  } else if (Array.isArray(state.targets) && state.targets.some((t) => t.state !== 'applied')) {
    const bad = state.targets.filter((t) => t.state !== 'applied').map((t) => t.id).join(', ');
    console.warn('[dsh-ling] core patch incomplete (%s) → re-run tools/apply-access-log-patch.mjs', bad);
  }

  return () => {
    if (active === log) active = null; // 卸载后不留悬空引用（accessLogHealth() 随之回 null）
    // 必须先摘钩子再关 fd：core 的那一行随时可能还在调用它们。
    if (previous.observe === undefined) delete globalThis[OBSERVE_GLOBAL];
    else globalThis[OBSERVE_GLOBAL] = previous.observe;
    if (previous.upgrade === undefined) delete globalThis[UPGRADE_GLOBAL];
    else globalThis[UPGRADE_GLOBAL] = previous.upgrade;
    try {
      log.close();
    } catch {}
  };
}
