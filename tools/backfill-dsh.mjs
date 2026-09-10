// dsh-ling CLI — DSH 存量会话回溯导入(读侧/写侧复用 lib/host/backfill.js)。
// 用法: node tools/backfill-dsh.mjs [--db <memory.db>] [--root <sessions根>] [--dry-run] [--limit N]
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// dsh-ling 数据目录(可用 DSH_HOME 覆盖;老版本写死家目录)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';
const imp = (p) => import(pathToFileURL(join(rootDir, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { scanDshHistory } = await imp('lib/host/backfill.js');

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = g('db', join(LING_DIR, 'memory.db'));
const sessionsRoot = g('root', join(homedir(), '.dsh', 'sessions'));
const dry = args.includes('--dry-run');
const limit = Number(g('limit', '0')) || 0;

const memory = dry ? null : (existsSync(target) ? new MemoryStore(target) : null);
const { report, rows } = await scanDshHistory({ memory, root: sessionsRoot, limit });
console.log('扫描报告:', JSON.stringify(report));
console.log('本次新增行:', rows.length);
for (const r of rows.slice(0, 12)) {
  console.log(`  [${r.category}] ${(r.started_at || '').slice(0, 10)} ${r.title.slice(0, 40)} | ${(r.summary || '').slice(0, 50)}`);
}
if (dry) process.exit(0);
if (!memory) { console.error('目标库不存在(先启动过插件?):', target); process.exit(1); }
const n = memory.db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source='dsh'").get().n;
console.log('库内 dsh 概述总数:', n.n);
memory.close();
