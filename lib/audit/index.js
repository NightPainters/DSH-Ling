// E4 访问日志 · 插件侧安装器
//
// 职责：把日志器挂到 core 补丁预留的两个全局钩子上，并在卸载时干净摘除。
// 不做的事：不碰鉴权判定、不碰记忆与人格数据（任务书 §3.5）。
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
    console.info('[dsh-ling] access log off (config.accessLog.enabled=false)');
    return () => {};
  }

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
  // 补丁没打时钩子永远收不到调用 —— 这是"静默不记"的唯一形态，必须主动喊出来（任务书 §5.3）。
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
