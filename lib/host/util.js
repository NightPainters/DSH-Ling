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

export function isTopLevelSessionHeader(header) {
  if (!header || typeof header !== 'object') return false;
  if (header.parentSession) return false;
  if (header.origin === 'subagent') return false;
  if (header.delegationDepth) return false;
  return true;
}
