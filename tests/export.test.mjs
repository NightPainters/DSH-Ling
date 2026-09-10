// 导出/合并 v2 单元测试(概述/队列/建议/深快照/人格默认不覆盖)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');

const dirA = mkdtempSync(join(tmpdir(), 'ling-xa-'));
const dirB = mkdtempSync(join(tmpdir(), 'ling-xb-'));
const a = new MemoryStore(join(dirA, 'm.db'));
const b = new MemoryStore(join(dirB, 'm.db'));
const settingsB = new SettingsFile(join(dirB, 'set'));

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// A 库内容
a.upsertOverview({ conv_id: 'a1', source: 'dsweb', title: '材料模拟', category: 'knowledge', overview_ok: true, summary: '浅' });
a.upsertOverview({ conv_id: 's1', source: 'dsh', title: '深摘会话', category: 'daily', overview_ok: true, summary: '深摘要文本' });
a.upsertOverview({ conv_id: 'imp-1', source: 'import', title: '文件导入的会话', category: 'daily', overview_ok: true, summary: '导入摘要' });
a.addFeedback({ session_id: 's1', message_id: 'm1', rating: 'negative', note: '别文言', created_at: '2026-09-07T00:00:00Z' });
a.addFeedback({ session_id: 's1', message_id: 'm2', rating: 'negative', note: '别啰嗦', created_at: '2026-09-07T00:01:00Z' });
a.addPersonaSuggestion({ kind: 'aiName', value: '灵灵', note: '自称建议', evidence: { count: 4 } });
a.addPersonaSuggestion({ kind: 'hardrule', value: '结构化呈现', note: '规则', evidence: { count: 3 } });
a.kvSet('deep:s1', 'done:2026-09-07T01:00:00Z');
a.kvSet('deep.sum:s1', '深摘要文本');
a.kvSet('deep.orig:s1', '浅');
a.kvSet('deep.skip:zzz', 'below-min:0:0');
a.addFeedback({ session_id: 'orphan', message_id: 'm9', rating: 'negative', note: '孤立', created_at: 'x' }); // 无 overview
const persona = { persona: { aiName: '灵灵', userTitle: '老板', hardRules: ['A'] }, styles: { work: 'W', life: 'L' }, lastMode: 'life' };

// 1) 导出 v2 含全部段
const bundle = a.exportBundle({ includeRaw: false });
check(bundle.exportScope === 2 && bundle.overviews.length === 3, '导出 overviews=3');
check(bundle.feedbackQueue.length === 3 && bundle.suggestions.length === 2, '导出队列/建议');
check(bundle.deep.some((d) => d.key === 'deep.sum:s1'), '导出深快照');
bundle.persona = persona; // API 层附载

// 2) 导入 B(默认不覆盖人格)
const r1 = b.importBundle(bundle);
check(r1.added === 3 && r1.queueAdded === 3 && r1.suggAdded === 2, '导入全段,报告=' + JSON.stringify(r1));
check(r1.deepRestored === 3, '深快照恢复3(deep:/sum/orig),实际 ' + r1.deepRestored);
check(b.overviewById('dsh', 's1').summary === '深摘要文本', '概述摘要即深文本');
// 来源保真:文件导入(import)的会话不得被错标成网页端(dsweb)
check(b.overviewById('import', 'imp-1')?.title === '文件导入的会话', 'import 来源保真');
check(!b.overviewById('dsweb', 'imp-1'), 'import 条目没有落进 dsweb 命名空间');
check(b.listFeedback({}).length === 3, 'B 队列=3');
check(b.listPersonaSuggestions().length === 2, 'B 建议=2');

// 3) 幂等重复导入:全跳过
const r2 = b.importBundle(bundle);
check(r2.skipped === 3 && r2.queueAdded === 0 && r2.suggAdded === 0 && r2.deepRestored === 0, '重复导入全跳过 ' + JSON.stringify(r2));

// 4) 孤儿 deep(skip 无 overview)不恢复;孤立 feedback 也会带过去但无害(仅测试导出含孤儿)
check(!b.kvGet('deep.skip:zzz'), '无概述的 deep.skip 不恢复');

// 5) 人格:默认 settingsB 不变
check(settingsB.get().persona.aiName === '', '人格默认未被覆盖');

// 6) 显式 persona=true(API 层语义)
await settingsB.update({ persona: bundle.persona.persona, styles: bundle.persona.styles });
check(settingsB.get().persona.aiName === '灵灵' && settingsB.get().styles.work === 'W', '显式导入后人格覆盖生效');

// 7) overwrite=true 更新概述
a.upsertOverview({ conv_id: 'a1', source: 'dsweb', title: '材料模拟v2', category: 'knowledge', overview_ok: true, summary: '浅2' });
const r3 = b.importBundle(a.exportBundle(), { overwrite: true });
check(r3.overwritten >= 1 && b.overviewById('dsweb', 'a1').title === '材料模拟v2', 'overwrite 生效');

// 8) 不覆盖的保护必须覆盖**全部来源**(曾经:import/dsh 行的查重按错来源查 → 被静默覆盖、计数还记成 added)
const bundle2 = a.exportBundle();
bundle2.overviews = bundle2.overviews.map((o) => (o.conv_id === 'imp-1' ? { ...o, title: '被改过的标题' } : o));
const r4 = b.importBundle(bundle2); // overwrite 默认 false
check(r4.skipped === 3 && r4.added === 0, 'overwrite=false 时全部跳过,实际 ' + JSON.stringify(r4));
check(b.overviewById('import', 'imp-1').title === '文件导入的会话', 'import 行同样受"不覆盖"保护');
check(b.overviewById('dsh', 's1').title === '深摘会话', 'dsh 行同样受"不覆盖"保护');

console.log(ok ? '导出/合并 v2 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
