// 会话契约文件导入(ACCESS-DESIGN §1/§3)单元测试:两档深度/幂等/降级/坏行/auto-id
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { normalizeImportItem, applyImportItems, IMPORT_SOURCE } = await imp('lib/host/import-file.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-imp-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 完整档
const full = normalizeImportItem({
  id: 'webchat:100', title: '数据模拟', startedAt: '2026-01-01T10:00:00Z',
  messages: [
    { role: 'user', text: '数据模拟怎么做', at: '2026-01-01T10:00:00Z' },
    { role: 'assistant', text: '先建物理模型…', at: '2026-01-01T10:00:10Z' },
    { role: 'user', text: '继续', at: '2026-01-01T10:01:00Z' },
  ],
});
check(full.ok && full.row.conv_id === 'webchat:100', '完整档规范化');
check(full.rawTurns.length === 3 && full.rawTurns[0].role === 'user' && full.rawTurns[2].seq === 3, 'raw 轮次与序号');
check(!full.degraded, '完整档非降级');
check(full.row.category === 'knowledge' && full.row.source === IMPORT_SOURCE, '类别+来源');

// 2) 轻量档
const lite = normalizeImportItem({ id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', summary: '深夜闲聊', keywords: ['失眠'] });
check(lite.ok && !lite.rawTurns.length && lite.row.summary === '深夜闲聊', '轻量档(仅摘要)');
const lite2 = normalizeImportItem({ title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' });
check(lite2.ok && /^auto:/.test(lite2.row.conv_id), '无 id 自动生成(auto:)');
const lite2b = normalizeImportItem({ title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' });
check(lite2b.row.conv_id === lite2.row.conv_id, 'auto-id 稳定(同标题同时间幂等)');

// 3) 坏行 / 降级
const bad = normalizeImportItem(null);
check(!bad.ok, 'null 条目拒绝');
const bad2 = normalizeImportItem({ title: '' });
check(!bad2.ok, '空对象拒绝');
const liteTitleOnly = { title: '只有标题的会话', startedAt: '2026-04-01T00:00:00Z', messages: [{ role: 'user', text: '' }] };
const degraded = normalizeImportItem(liteTitleOnly);
check(degraded.ok && degraded.degraded && degraded.row.summary.length > 0, '空消息降级为轻量并给默认摘要');

// 4) 落库:首次新增(输入须为原始契约对象)
const fullItem = { id: 'webchat:100', title: '数据模拟', startedAt: '2026-01-01T10:00:00Z', messages: [{ role: 'user', text: '数据模拟怎么做', at: '2026-01-01T10:00:00Z' }, { role: 'assistant', text: '先建物理模型…', at: '2026-01-01T10:00:10Z' }, { role: 'user', text: '继续', at: '2026-01-01T10:01:00Z' }] };
const liteItem = { id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', summary: '深夜闲聊', keywords: ['失眠'] };
const lite2Item = { title: '买菜清单', startedAt: '2026-03-01T00:00:00Z' };
const r1b = await applyImportItems(mem, [fullItem, liteItem, lite2Item, liteTitleOnly]);
check(r1b.newRows === 4, '首次导入新增 4: ' + r1b.newRows);
check(mem.rawTurnCount('webchat:100') === 3, '完整档 raw 写入 3 条');
// 5) 重导:全刷新、raw 幂等、用户态 summary 不被覆盖
mem.upsertOverview({ source: IMPORT_SOURCE, conv_id: 'webchat:100', title: '数据模拟', category: 'knowledge', overview_ok: true, summary: '用户深摘内容', importance: 1 });
const r2 = await applyImportItems(mem, [fullItem]);
check(r2.newRows === 0 && r2.refreshed === 1, '重导刷新 1');
check(mem.rawTurnCount('webchat:100') === 3, 'raw 覆盖写不翻倍');
const row100 = mem.overviewById(IMPORT_SOURCE, 'webchat:100');
check(row100.summary === '用户深摘内容', '已存在会话摘要不被覆盖');
check(Number(row100.importance) === 1, '置顶不被覆盖');
// 5b) 轻量行升级完整档 → upgraded(原无 raw,本次带原文)
const upR = await applyImportItems(mem, [{ id: 'other:9', title: '深夜闲聊', startedAt: '2026-02-01T00:00:00Z', messages: [{ role: 'user', text: '最近睡得好吗' }, { role: 'assistant', text: '梦多但还好' }] }]);
check(upR.refreshed === 1 && upR.upgraded === 1 && mem.rawTurnCount('other:9') === 2, '轻量→完整 补全原文计 upgraded(2 轮)');
// 6) 混合批:好行入、坏行列入 rejected
const r3 = await applyImportItems(mem, [{ id: 'x1', title: '新会话', startedAt: '2026-05-01T00:00:00Z' }, { bad: true }, 'nope']);
check(r3.newRows === 1 && r3.rejected.length === 2, '混合批:1 新入 + 2 拒绝');
// 7) 类别别名与字段别名
const alias = normalizeImportItem({ id: 'a:1', name: '别名标题', startTime: '2026-06-01T00:00:00Z', messages: [{ role: 'human', content: '嗨' }, { role: 'ai', content: '你好' }] });
check(alias.ok && alias.row.title === '别名标题' && alias.row.started_at === '2026-06-01T00:00:00.000Z', '字段别名(name/startTime/human/ai/content)');
// 8) queryOverviews 泛化(import 源可过滤)
const q = mem.queryOverviews({ source: IMPORT_SOURCE, limit: 10 });
check(q.total === 5, 'queryOverviews 可按 import 源过滤: ' + q.total);

// 9) DeepSeek 官方导出结构(mapping 树:REQUEST/RESPONSE 轮,THINK/FILE 跳过;inserted_at 带微秒+时区)
const officialItem = {
  id: 'uuid-aaaa', title: '交流继电器关断慢原因',
  inserted_at: '2026-09-07T11:50:07.412000+08:00',
  updated_at: '2026-09-07T11:53:14.966000+08:00',
  mapping: {
    root: { id: 'root', children: ['1'] },
    '1': { id: '1', children: ['2'], message: { inserted_at: '2026-09-07T11:50:07.412000+08:00', fragments: [{ type: 'FILE', files: [] }, { type: 'REQUEST', content: '交流继电器关断为什么慢' }] } },
    '2': { id: '2', children: ['3'], message: { inserted_at: '2026-09-07T11:51:50.641000+08:00', fragments: [{ type: 'THINK', content: '推理(应跳过)' }, { type: 'RESPONSE', content: '因为固态继电器…' }] } },
    '3': { id: '3', children: [], message: { inserted_at: '2026-09-07T11:52:30.100000+08:00', fragments: [{ type: 'REQUEST', content: '那直控直呢' }] } },
  },
};
const off = normalizeImportItem(officialItem);
check(off.ok && off.rawTurns.length === 3, '官方 mapping 解析 3 轮: ' + (off.rawTurns || []).length);
check(off.rawTurns[0].role === 'user' && off.rawTurns[1].role === 'assistant' && off.rawTurns[2].role === 'user', '轮次角色正确');
check(!off.rawTurns.some((t) => t.text.includes('推理(应跳过)')), 'THINK 内容被跳过');
check(off.row.started_at === '2026-09-07T03:50:07.412Z', 'inserted_at 微秒+时区清洗:' + off.row.started_at);
check(off.rawTurns[0].ts === Date.parse('2026-09-07T03:50:07.412Z'), '消息时间戳清洗');

// 10) 同 uuid 折叠:官方导出命中 dsweb 旧域 → 并入 dsweb(含原文),import 副本移除
mem.upsertOverview({ conv_id: 'uuid-aaaa', source: 'dsweb', title: '交流继电器关断慢原因', category: 'knowledge', overview_ok: true, summary: '旧抓取摘要', importance: 0 });
mem.upsertOverview({ conv_id: 'uuid-aaaa', source: IMPORT_SOURCE, title: '交流继电器关断慢原因', category: 'knowledge', overview_ok: true, summary: '上次导入的轻量副本' });
const foldR = await applyImportItems(mem, [officialItem]);
check(foldR.folded === 1, '折叠 1(并入 dsweb)');
check(foldR.removedImport === 1, '移除 import 副本 1');
check(!mem.overviewById(IMPORT_SOURCE, 'uuid-aaaa'), 'import 域副本已删除');
const dsRow = mem.overviewById('dsweb', 'uuid-aaaa');
check(!!dsRow && dsRow.summary === '旧抓取摘要', 'dsweb 行摘要不被折叠覆盖');
check(mem.rawTurnCount('uuid-aaaa') === 3, '原文 raw 写入 dsweb 会话');

console.log(ok ? '契约文件导入 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
