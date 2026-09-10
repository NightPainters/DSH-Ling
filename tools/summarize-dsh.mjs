// dsh-ling CLI — 手动跑 DSH 会话概述器(与宿主自动调度同一实现)。
// 用法: node tools/summarize-dsh.mjs [--db <memory.db>] [--force]
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// dsh-ling 数据目录(可用 DSH_HOME 覆盖;老版本写死家目录)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = g('db', join(LING_DIR, 'memory.db'));
const force = args.includes('--force');

if (!existsSync(target)) { console.error('找不到记忆库:', target); process.exit(1); }
const db = new MemoryStore(target);
const st = summarizeDsh(db, { force });
console.log('概述结果:', JSON.stringify(st));
const dsh = db.db.prepare("SELECT conv_id, title, category, updated_at, summary FROM conv_overview WHERE source='dsh' ORDER BY updated_at DESC LIMIT 6").all();
for (const r of dsh) console.log(`  [${r.category}] ${(r.updated_at || '').slice(0, 10)} ${String(r.title).slice(0, 34)} | ${String(r.summary).slice(0, 60)}`);
db.close();
