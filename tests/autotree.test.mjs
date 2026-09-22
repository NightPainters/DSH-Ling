// 一键生成记忆树(D9-b)单元测试:机械分段 / 命名解析 / 命名调用 / 计划生成。
// 不变量:本模块只读概述索引、只产候选,**从不改写任何记忆内容**。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { bucketize, bucketDigest, parseName, nameBucket, planFromNamed, tsOf } =
  await imp('lib/host/autotree.js');
const { MemoryStore } = await imp('lib/host/memory.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) tsOf:宽容解析
check(tsOf('2026-09-20T10:00:00.000Z') > 0, 'tsOf 解析 ISO');
check(tsOf('') === 0 && tsOf(null) === 0 && tsOf('乱七八糟') === 0, 'tsOf 取不到 → 0');

// 2) bucketize:按源分组,不混源
const rows = [
  { source: 'dsh', convId: 'a1', title: 'A1', at: '2026-09-01T00:00:00Z' },
  { source: 'dsh', convId: 'a2', title: 'A2', at: '2026-09-02T00:00:00Z' },
  { source: 'dsweb', convId: 'b1', title: 'B1', at: '2026-09-01T00:00:00Z' },
];
const b1 = bucketize(rows, { gapDays: 14 });
check(b1.length === 2, '两个源 → 两个簇,实际 ' + b1.length);
check(b1.every((b) => b.items.every((it) => it.source === b.source)), '簇内不混源');

// 3) 时间间隔切分:相差 20 天 > gapDays=14 → 切成两簇
const b2 = bucketize([
  { source: 'dsh', convId: 'x1', title: 'X1', at: '2026-09-01T00:00:00Z' },
  { source: 'dsh', convId: 'x2', title: 'X2', at: '2026-09-21T00:00:00Z' },
], { gapDays: 14 });
check(b2.length === 2, '间隔 20 天 → 切两簇,实际 ' + b2.length);
const b3 = bucketize([
  { source: 'dsh', convId: 'y1', title: 'Y1', at: '2026-09-01T00:00:00Z' },
  { source: 'dsh', convId: 'y2', title: 'Y2', at: '2026-09-10T00:00:00Z' },
], { gapDays: 14 });
check(b3.length === 1, '间隔 9 天 → 同一簇');

// 4) maxSize 上限:单簇不超过 maxSize
const many = [];
for (let i = 0; i < 25; i++) many.push({ source: 'dsh', convId: 'm' + i, title: 'M' + i, at: '2026-09-01T00:00:00Z' });
const b4 = bucketize(many, { maxSize: 10 });
check(b4.length === 3, '25 条 / 上限 10 → 3 簇,实际 ' + b4.length);
check(b4.every((b) => b.count <= 10), '每簇 ≤ maxSize');

// 5) 无时间条目不触发间隔切分(只受 maxSize 约束)
const b5 = bucketize([
  { source: 'import', convId: 'n1', title: 'N1', at: '' },
  { source: 'import', convId: 'n2', title: 'N2', at: '' },
], { gapDays: 1 });
check(b5.length === 1, '无时间的条目不会被间隔切开,实际 ' + b5.length);

// 6) bucketDigest:只给标题
const dig = bucketDigest(b2[0]);
check(dig.includes('X1') && !dig.includes('X2'), '摘要只含本簇标题');
check(bucketDigest({ items: [] }) === '', '空簇 → 空串');

// 7) parseName:宽容解析
check(parseName('工程力学|能量法在三门课里都成立').name === '工程力学', '标准格式');
check(parseName('工程力学|能量法').note === '能量法', '说明字段');
check(parseName('1. 「记忆系统设计」｜D9 系列').name === '记忆系统设计', '去编号与引号');
check(parseName('## 零散记录').name === '零散记录', '去 markdown 前缀');
check(parseName('').name === '' && parseName('\n\n').name === '', '空输出 → 空名');
check(parseName('名'.repeat(50)).name.length <= 30, '名字截断到 30 字');

// 8) nameBucket:调用契约(mock,不真的打模型)
const B = { id: 'bk:t:0', source: 'dsh', count: 1, from: 'a', to: 'b', items: [{ title: 'T1', convId: 'c1' }] };
const goodCall = async (baseUrl, model, { text, system }) => {
  check(baseUrl === 'http://x/v1' && model === 'm1', 'nameBucket 把 baseUrl/model 透传给 call');
  check(String(system).includes('记忆整理助手'), 'nameBucket 用 AUTOTREE_SYS');
  check(String(text).includes('T1'), 'nameBucket 把标题喂给模型');
  return { ok: true, summary: '工程力学|能量法', ms: 12 };
};
let r = await nameBucket('http://x/v1', 'm1', B, { call: goodCall });
check(r.ok && r.name === '工程力学' && r.note === '能量法', 'nameBucket 成功路径');
r = await nameBucket('http://x/v1', 'm1', B, { call: async () => ({ ok: false, error: 'timeout' }) });
check(!r.ok && r.error === 'timeout', 'nameBucket 失败透传 error');
r = await nameBucket('http://x/v1', 'm1', B, { call: async () => ({ ok: true, summary: '' }) });
check(!r.ok && r.error === 'empty-name', '模型空输出 → empty-name');
r = await nameBucket('http://x/v1', 'm1', { items: [] }, { call: goodCall });
check(!r.ok && r.error === 'empty-bucket', '空簇不调模型');
r = await nameBucket('http://x/v1', 'm1', B, {});
check(!r.ok && r.error === 'no-call', '未注入 call → no-call');

// 9) planFromNamed:只收成功项
const plan = planFromNamed([
  { bucketId: 'bk:a', ok: true, name: '甲', note: 'x' },
  { bucketId: 'bk:b', ok: false, name: '乙' },
], { parentId: 'vein:v1' });
check(plan.length === 1 && plan[0].bucketId === 'bk:a', '计划只含成功项');
check(plan[0].parentId === 'vein:v1' && plan[0].mode === 'branch', '计划带父与模式');

// 10) overviewIndex:只读索引,不取摘要正文
const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-autotree-'));
const db = new MemoryStore(join(dir, 'm.db'));
db.upsertOverview({ source: 'dsh', conv_id: 'i1', title: 'T1', category: 'knowledge', summary: '正文', overview_ok: true, updated_at: '2026-09-01T00:00:00Z' });
db.upsertOverview({ source: 'dsweb', conv_id: 'i2', title: 'T2', category: 'knowledge', summary: '', overview_ok: true, updated_at: '2026-09-02T00:00:00Z' });
const idx = db.overviewIndex();
check(idx.length === 2, 'overviewIndex 返回全部概述,实际 ' + idx.length);
check(idx.every((x) => !('summary' in x)), 'overviewIndex 不返回摘要正文');
check(idx.find((x) => x.convId === 'i1')?.hasSummary === true, 'hasSummary 为真');
check(idx.find((x) => x.convId === 'i2')?.hasSummary === false, '空摘要 hasSummary 为假');
check(idx.every((x) => x.at), 'overviewIndex 带时间(updated_at 回退 started_at)');

console.log(ok ? '一键生成记忆树(D9-b autotree)全部通过 ✓' : '一键生成记忆树(D9-b autotree)有失败项 ✗');
process.exit(ok ? 0 : 1);
