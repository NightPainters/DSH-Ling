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
