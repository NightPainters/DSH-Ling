// dsh-ling CLI — 语料人格档案建议:扫 ds-search 库 → 分析 → 写入记忆库建议表。
// 用法: node tools/suggest-persona.mjs [--ds <ds-search.db>] [--db <memory.db>] [--dry-run]
// 幂等:同 (kind,value) 已存在(任何状态)则跳过。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// dsh-ling 数据目录(可用 DSH_HOME 覆盖;老版本写死家目录)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { analyzeCorpus } = await imp('lib/host/corpus-suggest.js');

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const dsPath = g('ds', process.env.DSH_LING_DSWEB_DB || '');
const target = g('db', join(LING_DIR, 'memory.db'));
const dry = args.includes('--dry-run');

if (!existsSync(dsPath)) { console.error('语料库不存在:', dsPath); process.exit(1); }
const src = await import('node:sqlite').then((m) => new m.DatabaseSync(dsPath, { readOnly: true }));
const userRows = src.prepare("SELECT conv_id, ts, text FROM messages WHERE role='USER' AND text IS NOT NULL AND length(text) > 0 ORDER BY ts").all();
const asstRows = src.prepare("SELECT conv_id, ts, text FROM messages WHERE role='ASSISTANT' AND text IS NOT NULL AND length(text) > 0 ORDER BY ts").all();
src.close();
const toDoc = (r) => ({ text: r.text, date: r.ts ? String(r.ts).slice(0, 10) : '', ref: String(r.conv_id).slice(0, 8) });
console.log(`语料:用户 ${userRows.length} 条 / 助手 ${asstRows.length} 条`);
const { items, stats } = analyzeCorpus({
  userDocs: userRows.map(toDoc),
  assistantDocs: asstRows.map(toDoc),
});
console.log('识别建议:', items.length, '条', JSON.stringify(stats));
for (const it of items) console.log(`  [${it.kind}] ${it.value.slice(0, 40)} (证据 ${it.evidence.count})`);

if (dry) {
  for (const it of items) console.log('\n-- ' + it.kind + ' --\n' + it.note + '\n' + JSON.stringify(it.evidence.samples[0] || {}));
  process.exit(0);
}
const db = new MemoryStore(target);
let added = 0, skipped = 0;
for (const it of items) {
  if (db.hasPersonaSuggestion(it.kind, it.value)) { skipped += 1; continue; }
  db.addPersonaSuggestion(it);
  added += 1;
}
console.log(`写入:新增 ${added} · 跳过(已存在) ${skipped}`);
db.close();
