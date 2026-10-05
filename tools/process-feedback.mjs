// dsh-ling CLI — 从平台 message_feedback sidecar 文件把反馈灌入修订建议队列。
// 用法: node tools/process-feedback.mjs [--db <memory.db>] [--file <message_feedback.json>]
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// dsh-ling 数据目录(可用 DSH_HOME 覆盖;老版本写死家目录)
// ⚠️ A-4 同族(2026-10-05 夜 · 现场复核):下面那个平台反馈文件原先**硬写** `homedir()/.dsh`,
//   与这里的 DSH_HOME 判据**不同源** ⇒ 同一份脚本里两个目录来源,测试台做隔离(靠 DSH_HOME)
//   时会去读**真机**的 `storages/message_feedback.json`。改用同一个 DSH_DIR。
const DSH_DIR = process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh');
const LING_DIR = DSH_DIR + '/cache/dsh-ling';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { ingestFeedbackEntries, entriesFromFeedbackFile, loadSeen } = await imp('lib/host/feedback.js');

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = g('db', join(LING_DIR, 'memory.db'));
const fbFile = g('file', join(DSH_DIR, 'storages', 'message_feedback.json'));

if (!existsSync(target)) { console.error('找不到记忆库:', target); process.exit(1); }
const db = new MemoryStore(target);
if (!existsSync(fbFile)) {
  console.log('反馈文件不存在(尚未产生任何点踩/点赞):', fbFile);
} else {
  const fileObj = JSON.parse(readFileSync(fbFile, 'utf8'));
  const entries = entriesFromFeedbackFile(fileObj);
  console.log('文件条目:', entries.length, '条');
  const seen = loadSeen(db);
  const res = ingestFeedbackEntries(db, entries, { seen });
  console.log('处理结果:', JSON.stringify(res));
  const q = db.listFeedback({ status: 'new' });
  console.log('队列:', q.length, '条待确认');
  for (const it of q) console.log('  #' + it.id, it.rating, JSON.stringify(it.note.slice(0, 60)), it.session_id.slice(0, 8));
}
db.close();
