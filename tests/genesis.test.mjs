// 诞生仪式(genesis)单元测试:JSON 解析/清洗/原料截断/import 深摘目标选择
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { extractJson, parseGenesisResult, buildGenesisSource, isPlaceholderSummary, snippetFromRaw, composeGenesisRows, filterNamePairs } = await imp('lib/host/genesis.js');
const { importRawTargets } = await imp('lib/host/deepsummary.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-gen-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) JSON 抽取:纯 JSON / markdown 围栏 / 前后杂话
check(extractJson('{"a":1}').a === 1, '裸 JSON');
check(extractJson('```json\n{"a":2}\n```').a === 2, 'json 围栏');
check(extractJson('好的,这是结果:\n{"a":3}\n完毕').a === 3, '夹带说明');
check(extractJson('不是 JSON') === null, '非 JSON 返回 null');

// 2) 解析与清洗
const raw = {
  self_intros: ['第一段:这是一段足够长且有意义能够通过下限的完整自述文本', '第二段:这是第二段符合长度要求的自述候选文本', '第三段:这是第三段符合长度要求的自述候选文本内容', '第四段:这一段因为数量超限应当被裁掉不进入结果列表'],
  name_pairs: [['正式名一号', '昵称一号'], ['只有一个'], ['a', 'b', '多余'], '坏行', ['超长名字超长名字超长名字超长名字', '短']],
  tone_advice: '工作利落、生活松弛。'.repeat(60),
  observations: '观察一。观察二。',
};
const p = parseGenesisResult(JSON.stringify(raw));
check(p.self_intros.length === 3, '自述候选最多 3: ' + p.self_intros.length);
check(p.self_intros[1].indexOf('第二段') === 0, '自述保序');
check(p.name_pairs.length === 3, '名字组 ≤3(丢弃坏行与缺正式名): ' + p.name_pairs.length);
check(p.name_pairs[0].formal === '正式名一号' && p.name_pairs[0].nick === '昵称一号', '名字组结构');
check(p.name_pairs[1].formal === '只有一个' && p.name_pairs[1].nick === '', '昵称可缺省');
check(p.name_pairs[2].formal === 'a', '只取前两项的组');
check(p.tone_advice.length <= 300, 'tone_advice 截断 ≤300: ' + p.tone_advice.length);
check(p.observations === '观察一。观察二。', 'observations 原样');
const empty = parseGenesisResult('乱七八糟');
check(!empty.self_intros.length && !empty.name_pairs.length, '不可解析 → 空结果');

// 3) 原料组装与截断(保头)
const src = buildGenesisSource([
  { title: '会话甲', summary: '甲摘要内容' },
  { title: '会话乙', summary: '' },
  { title: '', summary: '' },
], { cap: 50 });
check(src.includes('会话甲') && src.includes('会话乙'), '原料含有效会话');
check(src.length <= 80, 'cap 生效(带省略注)');
const srcNo = buildGenesisSource([]);
check(srcNo === '', '无行 → 空');

// 4) import 深摘目标:按原文体量降序、只取 import 域
mem.upsertOverview({ conv_id: 'imp-a', source: 'import', title: '甲', category: 'daily', overview_ok: true });
mem.upsertOverview({ conv_id: 'imp-b', source: 'import', title: '乙', category: 'daily', overview_ok: true });
mem.upsertOverview({ conv_id: 'dsh-x', source: 'dsh', title: '丙', category: 'daily', overview_ok: true });
mem.appendRawTurn('imp-a', { seq: 1, role: 'user', ts: null, model: null, text: '短句' });
mem.appendRawTurn('imp-b', { seq: 1, role: 'user', ts: null, model: null, text: '很长很长很长很长很长很长很长很长很长的正文内容用于占位测试体量排序' });
mem.appendRawTurn('dsh-x', { seq: 1, role: 'user', ts: null, model: null, text: '非 import 不入' });
const t1 = importRawTargets(mem, { limit: 1 });
check(t1.length === 1 && t1[0].session_id === 'imp-b', '按体量取最大且仅 import: ' + JSON.stringify(t1));
const tAll = importRawTargets(mem, { limit: 10 });
check(tAll.length === 2 && !tAll.some((x) => x.session_id === 'dsh-x'), 'dsh 域不入列');

// 5) 短会话也要有声音:占位判定 + 原文片段 + 三级原料渲染
check(isPlaceholderSummary(''), '空概述=占位');
check(isPlaceholderSummary('标题(轻量条目,摘要待深摘补充)'), '轻量占位=占位');
check(isPlaceholderSummary('项目讨论 — 4 条消息'), '自动计数摘要=占位');
check(!isPlaceholderSummary('真实的可读摘要内容。'), '可读摘要非占位');
mem.appendRawTurn('imp-a', { seq: 2, role: 'assistant', ts: null, model: null, text: '回答内容第二句' });
mem.appendRawTurn('imp-a', { seq: 3, role: 'user', ts: null, model: null, text: '追问内容第三句很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长' });
const snip = snippetFromRaw(mem, 'imp-a', { perMsg: 12 });
check(snip.indexOf('主: 短句') === 0 && snip.indexOf('她:') > 0 && snip.indexOf('…') > 0, '片段按序含角色前缀与截断: ' + snip);
const three = buildGenesisSource([
  { title: '短会话甲', summary: '', snippet: '主: 你好 | 她: 我在' },
  { title: '长会话乙', summary: '深摘过的浓缩理解' },
  { title: '只有标题丙' },
]);
check(three.includes('[对话节选] 主: 你好') && three.includes('深摘过的浓缩理解') && three.includes('只有标题丙'), '三级取用渲染(片段/深摘/仅标题)');

// 6) genesis 原料抽样:scope=import 仅本段;scope=all 加权(生活/情感优先、置顶加成)
mem.upsertOverview({ conv_id: 'feel-1', source: 'dsweb', title: '深夜闲聊', category: 'feeling', updated_at: '2026-09-01T00:00:00Z', overview_ok: true, summary: '感性长概述内容内容内容' });
mem.upsertOverview({ conv_id: 'know-1', source: 'dsweb', title: '合金固溶计算', category: 'knowledge', updated_at: '2026-09-02T00:00:00Z', overview_ok: true, summary: '知识概述' });
mem.upsertOverview({ conv_id: 'daily-pin', source: 'dsweb', title: '置顶的日常纪念', category: 'daily', importance: 1, updated_at: '2026-08-01T00:00:00Z', overview_ok: true, summary: '日常概述' });
const onlyImport = composeGenesisRows(mem, { scope: 'import' });
check(onlyImport.rows.every((x) => !x.title.includes('深夜') && !x.title.includes('合金')), 'scope=import 不含其它域');
const allC = composeGenesisRows(mem, { scope: 'all', limit: 10 });
check(allC.pool >= 6 && allC.sampled <= 10, 'scope=all 覆盖全池并抽样: pool=' + allC.pool + ' sampled=' + allC.sampled);
check(allC.rows.length > 0 && allC.rows[0].title === '置顶的日常纪念', '置顶加成 > 普通生活类(排序首位): ' + allC.rows[0].title);
const feelIdx = allC.rows.findIndex((r) => r.title === '深夜闲聊');
const knowIdx = allC.rows.findIndex((r) => r.title === '合金固溶计算');
check(feelIdx >= 0 && knowIdx >= 0 && feelIdx < knowIdx, '生活/情感排在知识之前(加权)');
const small = composeGenesisRows(mem, { scope: 'all', limit: 2 });
check(small.sampled === 2, 'limit 生效: ' + small.sampled);
// 7) 深摘"继续"语义:excludeProcessed 跳过已 done(推进未读部分,不重复重跑)
mem.kvSet('deep:imp-b', 'done:2026-09-09T00:00:00Z');
const tEx = importRawTargets(mem, { limit: 10, excludeProcessed: true });
check(!tEx.some((x) => x.session_id === 'imp-b') && tEx.some((x) => x.session_id === 'imp-a'), 'excludeProcessed 跳过已 done: ' + JSON.stringify(tEx));
const tAll2 = importRawTargets(mem, { limit: 10 });
check(tAll2.some((x) => x.session_id === 'imp-b'), '不带排除时仍列出全部(兼容旧调用)');
mem.kvSet('deep:imp-b', '');

// 8) 名字属于"她":剔除用户称谓(userTitle 成分 + 常见称谓词)
const pairs8 = [
  { formal: '风语', nick: '小风' },
  { formal: '张明', nick: '小灵' },   // 正式名=用户的名字 → 剔除
  { formal: '阿芯', nick: '老板' },   // 昵称=称谓 → 剔除
  { formal: '蓝鲸', nick: '' },
  { formal: '小灵', nick: '肥鱼' },   // userTitle 之外,保留(历史中用户对器灵的称呼,可作器灵名)
];
const filtered = filterNamePairs(pairs8, '张明/老板');
check(filtered.length === 3, '剔除用户称谓组: ' + JSON.stringify(filtered.map((p) => p.formal)));
check(!filtered.some((p) => p.formal === '张明' || p.nick === '老板'), '无主客混淆残留');
check(filtered[0].formal === '风语' && filtered[2].formal === '小灵', '保序且保留合法组');
check(filterNamePairs(null, 'x').length === 0, '非数组容错');

console.log(ok ? '诞生仪式 genesis 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
