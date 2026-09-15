// L1 行瘦身:标题/摘要去重 + 单行上限(防止一条超长摘要吃满整个预算)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { selectL1, formatL1Section } = await imp('lib/host/l1.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const row = (o = {}) => ({
  conv_id: o.conv_id || 'c1',
  source: o.source || 'dsh',
  title: o.title ?? '',
  summary: o.summary ?? '',
  category: o.category || 'knowledge',
  domain_tags: o.domain_tags || [],
  keywords: o.keywords || [],
  updated_at: o.updated_at || iso(1),
  started_at: o.started_at || iso(1),
  importance: o.importance ?? 0,
  hit_count: o.hit_count ?? 0,
  overview_ok: 1,
});
const pick = (rows, opts = {}) => selectL1({ listOverviews: () => rows }, { mode: 'work', maxItems: 8, budgetChars: 4000, ...opts });
const count = (s, sub) => s.split(sub).length - 1;

// 1) 标题 === 摘要 → 只出现一次
{
  const r = pick([row({ title: '弹簧落地模拟', summary: '弹簧落地模拟' })]);
  check(r.items.length === 1 && count(r.items[0].line, '弹簧落地模拟') === 1, '标题=摘要时只出现一次: ' + r.items[0].line);
}

// 2) 摘要以标题开头(概述器/深摘的常态)→ 用摘要,不重复前缀
{
  const r = pick([row({ title: '网络模块保存不了', summary: '网络模块保存不了 — 4 条消息' })]);
  const line = r.items[0].line;
  check(count(line, '网络模块保存不了') === 1, '摘要自带标题时不重复前缀: ' + line);
  check(line.includes('— 4 条消息'), '保留摘要正文');
}

// 3) 摘要不以标题开头 → 仍用「标题: 摘要」
{
  const r = pick([row({ title: '标题甲', summary: '正文乙' })]);
  check(r.items[0].line.includes('标题甲: 正文乙'), '两者不重叠时保留「标题: 摘要」: ' + r.items[0].line);
}

// 4) 无摘要(历史会话常态)→ 只输出标题
{
  const r = pick([row({ title: '只有标题的会话', summary: '' })]);
  const line = r.items[0].line;
  check(line.includes('只有标题的会话') && line.length < 80, '无摘要只输出标题: ' + line);
}

// 5) 超长正文被截断,标 … 且长度受控
{
  const long = row({ title: '长摘要', summary: '甲'.repeat(600) });
  const noCap = pick([long]);
  const capped = pick([long], { maxLineChars: 120 });
  check(capped.items[0].line.includes('…'), '超长标 …');
  check(capped.items[0].line.length < noCap.items[0].line.length, '上限生效后更短');
  check(capped.items[0].line.length < 200, '长度受控(前缀+正文+后缀 < 200): ' + capped.items[0].line.length);
}

// 6) 截断优先落在句末
{
  const s = '甲'.repeat(60) + '。' + '乙'.repeat(200);
  const r = pick([row({ title: 't', summary: s })], { maxLineChars: 80 });
  check(r.items[0].line.includes('。…'), '截断落在句末: …' + r.items[0].line.slice(-6));
}

// 7) 上限可配:小上限下,长条目不再吃满预算,短条目能进榜
{
  const rows = [
    row({ conv_id: 'long', title: '巨长', summary: '巨'.repeat(1200) }),
    row({ conv_id: 's1', title: '短一', summary: '短一' }),
    row({ conv_id: 's2', title: '短二', summary: '短二' }),
    row({ conv_id: 's3', title: '短三', summary: '短三' }),
  ];
  const small = pick(rows, { maxLineChars: 80, budgetChars: 600 });
  const ids = small.items.map((i) => i.conv_id);
  check(ids.includes('s1') && ids.includes('s2'), '长条目被限长后,短条目能进榜: ' + ids.join(','));
}

// 8) 行结构仍完整:分类标签 + 日期 + 来源后缀
{
  const r = pick([row({ title: '甲', summary: '甲', domain_tags: ['工作-物理'], updated_at: iso(3) })]);
  const line = r.items[0].line;
  check(/^- \[工作-物理\] \(\d{4}-\d{2}-\d{2}\) /.test(line), '行首结构不变: ' + line);
  check(line.includes('(来源: DSH 会话/'), '来源后缀保留');
  check(formatL1Section(r).startsWith('[记忆·开场]'), '段落头不变');
}

// 9) 上限关闭(0)= 不截断(向后兼容)
{
  const r = pick([row({ title: 't', summary: '丙'.repeat(500) })], { maxLineChars: 0 });
  check(!r.items[0].line.includes('…'), '上限为 0 时不截断');
}

console.log(ok ? 'L1 行瘦身 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
