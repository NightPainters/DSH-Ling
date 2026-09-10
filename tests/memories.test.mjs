// 记忆中心存储层单元测试(queryOverviews/置顶/删除)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-mc-'));
const db = new MemoryStore(join(dir, 'm.db'));
db.upsertOverview({ source: 'dsweb', conv_id: 'a1', title: '镍钴基高熵合金固溶时间', category: 'knowledge', keywords: ['镍钴', '固溶'], summary: '热处理工艺研究', overview_ok: true });
db.upsertOverview({ source: 'dsweb', conv_id: 'a2', title: '材料串联物理模拟', category: 'knowledge', overview_ok: true });
db.upsertOverview({ source: 'dsweb', conv_id: 'a3', title: '深夜情绪随笔', category: 'feeling', overview_ok: true });
db.upsertOverview({ source: 'dsh', conv_id: 'b1', title: '小灵今天聊了啥', category: 'daily', overview_ok: true });

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 查询:过滤 + 搜索 + 分页
let r = db.queryOverviews({ category: 'knowledge', sort: 'updated' });
check(r.total === 2 && r.items.length === 2, 'category 过滤 total=2');
r = db.queryOverviews({ source: 'dsh' });
check(r.total === 1 && r.items[0].conv_id === 'b1', 'source=dsh');
r = db.queryOverviews({ q: '镍钴' });
check(r.total === 1 && r.items[0].conv_id === 'a1', '搜索命中 镍钴');
r = db.queryOverviews({ q: '材料' });
check(r.total === 1, '搜索命中 材料');
r = db.queryOverviews({ limit: 2, offset: 0 });
check(r.items.length === 2 && r.total === 4, '分页 limit2/共4');

// 置顶
db.setImportance('dsweb', 'a1', 1);
check(db.overviewById('dsweb', 'a1').importance === 1, '置顶写入');
db.setImportance('dsweb', 'a1', 0);
check(db.overviewById('dsweb', 'a1').importance === 0, '取消置顶');

// 删除
db.deleteOverview('dsh', 'b1');
check(!db.overviewById('dsh', 'b1') && db.queryOverviews({ source: 'dsh' }).total === 0, '删除生效');

// L1 置顶加分(importance 行应显著提升排序)
db.upsertOverview({ source: 'dsweb', conv_id: 'old-pin', title: '老旧但重要的论文笔记', category: 'knowledge', started_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', overview_ok: true });
db.setImportance('dsweb', 'old-pin', 1);
const { selectL1 } = await imp('lib/host/l1.js');
const l1 = selectL1(db, { mode: 'work', categoryWeights: { work: { knowledge: 1.0, daily: 0.3, feeling: 0.1 } }, maxItems: 8, budgetChars: 4000 });
check(l1.items[0].conv_id === 'old-pin' || l1.items.some(i => i.conv_id === 'old-pin' && i.score > 0.9), '置顶条目进入 L1 前排');

console.log(ok ? '记忆中心存储层全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
