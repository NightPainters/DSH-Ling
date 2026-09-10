// dsh-ling host — settings persistence v2.
// Persists ONLY user patches (decoupled from code defaults so future default
// changes propagate); one-time migration from the v0 full-snapshot file keeps
// only the user-meaningful { mode.lastMode }.
import { join } from 'node:path';
import { ensureDir, mergeDeep, readJsonSafe, writeJsonAtomic } from './util.js';
import { DEFAULT_SETTINGS } from './persona.js';

const SETTINGS_VERSION = 2;

export class SettingsFile {
  constructor(dataDir) {
    this.dir = ensureDir(dataDir);
    this.file = join(dataDir, 'settings.json');
    const stored = readJsonSafe(this.file, {});
    let user;
    if (stored && stored.__v === SETTINGS_VERSION && stored.user) {
      user = mergeDeep({}, stored.user);
    } else if (stored && stored.__v === SETTINGS_VERSION) {
      user = mergeDeep({}, stored);
    } else {
      // v0/v1 迁移:旧文件是"默认值全量快照",只保留用户关心的 lastMode
      user = {};
      const lm = stored?.mode?.lastMode;
      if (lm === 'work' || lm === 'life') user = { mode: { lastMode: lm } };
    }
    this.user = user || {};
    this.current = mergeDeep(structuredClone(DEFAULT_SETTINGS), this.user);
  }

  get() {
    return this.current;
  }

  /** Apply a user patch (deep-merged onto current defaults); persist patch only. */
  async update(patch) {
    this.user = mergeDeep(this.user, patch || {});
    this.current = mergeDeep(structuredClone(DEFAULT_SETTINGS), this.user);
    await writeJsonAtomic(this.file, { __v: SETTINGS_VERSION, user: this.user });
    return this.current;
  }

  async reset() {
    this.user = {};
    this.current = structuredClone(DEFAULT_SETTINGS);
    await writeJsonAtomic(this.file, { __v: SETTINGS_VERSION, user: {} });
    return this.current;
  }
}
