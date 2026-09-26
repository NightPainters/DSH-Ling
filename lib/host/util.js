// dsh-ling host utilities — platform-service access, paths, io helpers.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const PLUGIN_ID = 'dsh-ling';
export const DISPLAY_NAME = 'dsh-ling · 器灵';

/** Resolve a platform service by id without throwing (cordis ctx.get throws when absent). */
export function svc(ctx, name) {
  try {
    const v = ctx?.get?.(name);
    return v !== undefined ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Try a nested chain of property gets (defensive against unknown payload shapes). */
export function pick(...chain) {
  for (const c of chain) {
    const v = c();
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** $DSH_HOME → env DSH_HOME, else ~/.dsh (platform convention; not hardcoded elsewhere). */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Plugin-owned data dir: $DSH_HOME/cache/dsh-ling (outside the plugin package, survives updates). */
export function defaultDataDir() {
  return join(dshHome(), 'cache', PLUGIN_ID);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonSafe(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  const dir = idx > 0 ? file.slice(0, idx) : '.';
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await (await import('node:fs/promises')).rename(tmp, file).catch(async () => {
    // Windows rename-over-existing can fail; fall back to direct write.
    await writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  });
  return file;
}

export function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function utcIso() {
  return new Date().toISOString();
}

/**
 * 宽松时间归一(2026-09-15 修 A):把各种历史遗留形态统一成 epoch 毫秒。
 * 能吃:ISO 字符串 / 数字 / 数字字符串(含 `"1789006881011.0"` 这类浮点串)/ Date。
 * 十位数按「秒」、十三位按「毫秒」;不可解析一律返回 null(绝不返回 NaN)。
 * 背景:早期写入路径把毫秒时间戳当浮点存成了 text,导致 `Date.parse` 返回 NaN →
 * 新近度恒为 1.0(永不衰减)、注入文本里出现 `(1789006881)`。
 */
export function toEpochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return epochOf(value);
  const s = String(value).trim();
  if (!s) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return epochOf(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function epochOf(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n < 1e11 ? n * 1000 : n); // 10 位=秒,13 位=毫秒
}

/** 归一为 ISO 字符串(存库/展示统一用 ISO);不可解析返回 null。 */
export function toIso(value) {
  const ms = toEpochMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/** 归一为 `YYYY-MM-DD`(日期展示用,UTC 口径,与原 `.slice(0,10)` 行为一致);不可解析返回 ''。 */
export function isoDate(value) {
  const iso = toIso(value);
  return iso ? iso.slice(0, 10) : '';
}

/** Deep-merge plain objects (arrays replaced). */
export function mergeDeep(base, over) {
  if (over === undefined || over === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  if (typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = mergeDeep(base[k], over[k]);
  return out;
}

/** 会话种类(记忆分枝 D9-a,2026-09-18 用户定方向)。
 *  背景:原 `isTopLevelSessionHeader` 把三类混成一个 false —— 子代理、委托、分叉**都不入库、不注入**。
 *  但分叉会话是主人显式开的**并行工作线**(工程上"先放下别的模块,专注做完这一个再回来"),
 *  它应当**有自己的记忆**(写入所属枝)且**能读祖先链**,而不是记忆真空。
 *  区分:
 *    'subagent' —— 子代理/委托:仍不入库、不注入(它们是实现细节,不是主人的工作线);
 *    'fork'     —— 分叉会话:归枝,入库到枝、注入血缘链(D9-a);
 *    'top'      —— 顶层会话:主干;
 *    'unknown'  —— 取不到 header:保守按旧行为(不入库)。
 *  注意:`parentSession` 是平台的加速器,**不是判据** —— 即使 DSH 不再写这个字段,
 *  也能靠主人显式标记建枝(见内部记忆树设计笔记 §7 与内部踩坑记录 B19)。 */
export function sessionKind(header) {
  if (!header || typeof header !== 'object') return 'unknown';
  if (header.origin === 'subagent' || header.delegationDepth) return 'subagent';
  if (header.parentSession) return 'fork';
  return 'top';
}

export function isTopLevelSessionHeader(header) {
  return sessionKind(header) === 'top';
}

/** 是否应当入库 / 被注入(D9-a):顶层与分叉会话都算,子代理不算。 */
export function isMemoryEligibleHeader(header) {
  const k = sessionKind(header);
  return k === 'top' || k === 'fork';
}

/**
 * 中和文本里的 DSH 模板定界符(`{{…}}`),使注入提示面的任意文本都无法被当模板展开。
 *
 * 为什么必须做:宿主把 section 文本交给 `renderPrompt` 做变量插值,而调用点**没有 try/catch**
 * (每次模型步渲染一次)。未注册的名字(如 `{{time}}`)直接抛异常 ⇒ 一条含 `{{…}}` 的
 * 记忆就能让该会话**每一步**都失败,现象只是"器灵突然不说话了"。
 *
 * 为什么这样写:宿主模板只认**紧邻**的 `{{`,所以只需拆开相邻的两个 `{`(其后那个 `}` 无害)。
 * 用 lookahead 逐位判定,而不是 `.replace(/\{\{/g, …)`:后者在 `{{{` 上会漏 ——
 * 替换掉前两个 `{` 之后,残留字符又与原第三个 `{` 相邻。
 *   `{{time}}` → `{\u200b{time}}`    `{{{` → `{\u200b{\u200b{`    `{ {` → 原样
 *
 * 为什么用零宽空格:文本对模型与主人保持原样可读;且本函数**幂等**(中和过的文本再跑不变)。
 */
export function neutralizeMustache(text) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  return text.replace(/\{(?=\{)/g, '{\u200b');
}
