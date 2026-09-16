// L1 行瘦身:标题/摘要去重 + 单行上限(防止一条超长摘要吃满整个预算)
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { selectL1, formatL1Section, firstSentence } = await imp('lib/host/l1.js');

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

// 3) 摘要不以标题开头 → 两段结构「标题 —— 摘要第一句」
{
  const r = pick([row({ title: '标题甲', summary: '正文乙' })]);
  check(r.items[0].line.includes('标题甲 —— 正文乙'), '两段结构(标题 —— 摘要): ' + r.items[0].line);
}

// 4) 无摘要(历史会话常态)→ 只输出标题
{
  const r = pick([row({ title: '只有标题的会话', summary: '' })]);
  const line = r.items[0].line;
  check(line.includes('只有标题的会话') && line.length < 80, '无摘要只输出标题: ' + line);
}

// 5) 摘要段预算 110:第一句超预算 → 硬截 + …(maxLineChars 只是兜底硬顶)
{
  const long = row({ title: '长摘要', summary: '甲'.repeat(600) });
  const r = pick([long]);
  const line = r.items[0].line;
  check(line.includes('…'), '超预算标 …');
  check(line.length < 200, '长度受控(前缀+正文+后缀 < 200): ' + line.length);
  check(!line.includes('甲'.repeat(111)), '摘要段不超过 110 字');
}

// 6) 只取第一句:句末标点之后的内容不再进 L1
{
  const s = '甲'.repeat(60) + '。' + '乙'.repeat(200);
  const r = pick([row({ title: 't', summary: s })]);
  const line = r.items[0].line;
  check(line.includes('甲'.repeat(60) + '。'), '保留第一句');
  check(!line.includes('乙'), '第二句不进 L1: ' + line.slice(-20));
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

// 9) 两档可配:summaryChars=0 = 摘要段不截;maxLineChars 仍是兜底硬顶
{
  const r0 = pick([row({ title: 't', summary: '丙'.repeat(500) })], { summaryChars: 0, maxLineChars: 0 });
  check(!r0.items[0].line.includes('…'), 'summaryChars=0 且 maxLineChars=0 → 完全不截');
  const r1 = pick([row({ title: 't', summary: '丙'.repeat(500) })], { summaryChars: 0, maxLineChars: 80 });
  check(r1.items[0].line.includes('…'), 'maxLineChars 兜底硬顶仍生效');
}

// 11) firstSentence:按中文句末标点切
{
  const cases = [
    ['第一句。第二句。', '第一句。'],
    ['甲；乙。', '甲；'],
    ['问？答。', '问？'],
    ['叹！后。', '叹！'],
    ['半;后。', '半;'],
  ];
  cases.forEach(([s, want]) => {
    check(firstSentence(s) === want, `firstSentence(${s}) → ${want},实际 ${firstSentence(s)}`);
  });
  check(firstSentence('没有句末标点的一长句') === '没有句末标点的一长句', '无句末标点 → 原样');
  check(firstSentence('') === '', '空串 → 空');
  check(firstSentence('甲'.repeat(300)).endsWith('…') && firstSentence('甲'.repeat(300)).length === 111, '单句超预算 → 110 字 + …');
  check(firstSentence('甲'.repeat(300), 0).length === 300, 'cap=0 → 不截');
}

// 12) 无摘要行:信息量优先,不吃 110 预算(长标题原样保留)
{
  const longTitle = '长'.repeat(120);
  const r = pick([row({ title: longTitle, summary: '' })]);
  const line = r.items[0].line;
  check(line.includes(longTitle), '无摘要行标题不被 110 预算截断(行 ' + line.length + ' 字)');
  check(!line.includes('…'), '无摘要行不加省略号');
}

// 13) 有摘要行超预算:恰好截到 110 字 + …
{
  const r = pick([row({ title: 't', summary: '甲'.repeat(300) })]);
  const line = r.items[0].line;
  check(line.includes('甲'.repeat(110) + '…'), '截到 110 字 + …');
}

// 10) 「有信息量的摘要」加权(2026-09-16):同样新近度下,带真摘要的行排在只有标题的行前面
{
  const rows = [
    row({ conv_id: 'title-only', title: '只有标题的历史会话', summary: '' }),
    row({ conv_id: 'rich', title: '带摘要的会话', summary: '带摘要的会话 — ' + '正文'.repeat(20) }),
  ];
  const r = pick(rows);
  check(r.items[0].conv_id === 'rich', '带摘要的行排前面: ' + r.items.map((i) => i.conv_id).join(','));
  check(r.items[0].rich > 0 && r.items[1].rich === 0, 'rich 分只在有信息量时给: ' + r.items.map((i) => i.rich).join(','));
}
{
  // 「标题 — N 条消息」这种自动计数摘要不算有信息量
  const rows = [
    row({ conv_id: 'count-only', title: '浅摘会话', summary: '浅摘会话 — 4 条消息' }),
    row({ conv_id: 'plain', title: '无摘要会话', summary: '' }),
  ];
  const r = pick(rows);
  const byId = Object.fromEntries(r.items.map((i) => [i.conv_id, i]));
  check(byId['count-only'].rich === 0 && byId['plain'].rich === 0, '"标题 — N 条消息"不算有信息量');
}
{
  // 0 = 关闭加权:两行同分(顺序退回时间序)
  const rows = [
    row({ conv_id: 'a', title: '甲', summary: '' }),
    row({ conv_id: 'b', title: '乙', summary: '乙 — ' + '正文'.repeat(20) }),
  ];
  const r = pick(rows, { summaryBonus: 0 });
  check(r.items.every((i) => i.rich === 0), 'summaryBonus=0 时不加权');
}
{
  // 加权不得压过置顶(0.8)与关键词加成(≤1.8)
  const rows = [
    row({ conv_id: 'pinned', title: '置顶行', summary: '', importance: 1 }),
    row({ conv_id: 'rich', title: '带摘要行', summary: '带摘要行 — ' + '正文'.repeat(20) }),
  ];
  const r = pick(rows);
  check(r.items[0].conv_id === 'pinned', '置顶仍优先于摘要加权');
}

console.log(ok ? 'L1 行瘦身 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
