// 语料建议:识别器 + 采纳映射 单元测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { analyzeCorpus } = await imp('lib/host/corpus-suggest.js');
const { applyCorpusSuggestion, dismissCorpusSuggestion } = await imp('lib/host/suggestions.js');
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// --- 识别器 ---
const userDocs = [];
for (let i = 0; i < 9; i++) userDocs.push({ text: `灵灵，${i}号问题怎么解`, date: '2026-08-0' + i, ref: 'u' + i });
for (let i = 0; i < 4; i++) userDocs.push({ text: `这个回答太啰嗦了，直接给结论`, date: '2026-08-1' + i, ref: 'c' + i });
userDocs.push({ text: '你写得太文言了,说人话', date: '2026-08-20', ref: 'c9' });
userDocs.push({ text: '这段咬文嚼字,好好说人话', date: '2026-08-20', ref: 'c11' });
userDocs.push({ text: '太文言了,直白一点', date: '2026-08-21', ref: 'c12' });
userDocs.push({ text: '请用表格列出', date: '2026-08-21', ref: 'c10' });
userDocs.push({ text: '请分点列出要点', date: '2026-08-21', ref: 'c13' });
userDocs.push({ text: '用列表呈现这几点', date: '2026-08-21', ref: 'c14' });
const asstDocs = [];
for (let i = 0; i < 4; i++) asstDocs.push({ text: `老板，关于${i}号,建议是…`, date: '2026-08-0' + i, ref: 'a' + i });
for (let i = 0; i < 15; i++) asstDocs.push({ text: '服务器繁忙，请稍后再试。', date: '2025-02-01', ref: 'err' + i });

const r = analyzeCorpus({ userDocs, assistantDocs: asstDocs });
const kinds = r.items.map((x) => x.kind);
check(kinds.includes('aiName'), '识别 aiName 候选: ' + JSON.stringify(kinds));
const ai = r.items.find((x) => x.kind === 'aiName');
check(ai && ai.value === '灵灵' && ai.evidence.count >= 9, 'aiName=灵灵 & 计数≥9: ' + JSON.stringify(ai && { v: ai.value, n: ai.evidence.count }));
const hr = r.items.filter((x) => x.kind === 'hardrule');
check(hr.length >= 2, '识别 ≥2 条惯例桶: ' + hr.length);
check(r.items.some((x) => x.kind === 'userTitle' && x.value === '老板'), 'userTitle=主人(助手称呼)');
check(!r.items.some((x) => x.kind === 'userTitle' && x.value === '服务器繁忙'), '系统模板开头被剔除');
// 证据样例带摘录
check(ai.evidence.samples.length > 0 && ai.evidence.samples[0].excerpt.includes('灵灵'), '证据样例含摘录');

// --- 采纳/忽略映射 ---
const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-sug-'));
const db = new MemoryStore(join(dir, 'm.db'));
const settings = new SettingsFile(join(dir, 'set'));
for (const it of r.items) db.addPersonaSuggestion(it);
const list = db.listPersonaSuggestions({ status: 'new' });
check(list.length === r.items.length, '建议入库 ' + r.items.length);
const aiRow = list.find((x) => x.kind === 'aiName');
const a1 = await applyCorpusSuggestion(db, settings, aiRow.id);
check(a1.ok && settings.get().persona.aiName === '灵灵', '采纳 aiName → persona.aiName');
check(db.getPersonaSuggestion(aiRow.id).status === 'adopted', '状态 adopted');
const a2 = await applyCorpusSuggestion(db, settings, aiRow.id);
check(!a2.ok && a2.reason === 'status:adopted', '重复采纳被拒');
const hrRow = list.find((x) => x.kind === 'hardrule');
const h1 = await applyCorpusSuggestion(db, settings, hrRow.id);
check(h1.ok && settings.get().persona.habits.some((h) => h.text === hrRow.value), '采纳 hardrule → 落到习惯(不再直达规矩)');
const utRow = list.find((x) => x.kind === 'userTitle');
if (utRow) {
  const u1 = await applyCorpusSuggestion(db, settings, utRow.id);
  check(u1.ok && settings.get().persona.userTitle === '老板', '采纳 userTitle → persona.userTitle');
}
const dr = dismissCorpusSuggestion(db, list.find((x) => x.status === 'new').id);
check(dr.ok, '忽略生效');

console.log(ok ? '语料建议 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
