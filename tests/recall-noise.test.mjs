// 1.7.2 · recall 回执降噪(M1~M6,据 `daily\recall输出过滤-修改清单.md` §3)
//
// 为什么单独立一套:六项里四项是**纯函数**(M1/M3/M6 与 M5 的分组),而它们的错误形态
// 都是"看起来正常" —— 少剥一个星号、多截一段、折叠了却不报数,人眼扫过去全像对的。
// 混进 `recall-search.test`(已 421 行)会让那套越来越长,单开一套能一眼看出是哪一项破的。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  stripDanglingMarkers, stripPairedMarkdown, capReceiptText, RECEIPT_CHARS_MAX, wellFormed,
} = await imp('lib/host/rawlog.js');
const { groupDeepRows, renderSearch, DEEP_ROWS_PER_KIND } = await imp('lib/host/recall-search.js');
const { RECALL_SPEC } = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const renderRecall = (v) => RECALL_SPEC.output.render({}, v)[0].text;

// ── M1 · 截断后清理未闭合标记(剥掉、不补)──────────────────────────
check(stripDanglingMarkers('原文**一半') === '原文一半', 'M1:剥掉末尾未闭合的 **');
check(stripDanglingMarkers('原文 `代码') === '原文 代码', 'M1:剥掉末尾未闭合的 `');
check(stripDanglingMarkers('见 [链接') === '见 链接', 'M1:剥掉末尾未闭合的 [');
check(stripDanglingMarkers('大纲【未闭合') === '大纲未闭合', 'M1:剥掉末尾未闭合的 【');
check(stripDanglingMarkers('**完整** 与 `代码` 与 [文字]') === '**完整** 与 `代码` 与 [文字]',
  'M1:成对标记一个字不动(不是无差别剥 Markdown)');
check(stripDanglingMarkers(stripDanglingMarkers('a**b')) === stripDanglingMarkers('a**b'), 'M1:幂等(跑两遍结果一样)');
check(stripDanglingMarkers('没有标记') === '没有标记', 'M1:无标记的文本原样返回');
check(stripDanglingMarkers('两个末标记**然后[') === '两个末标记然后', 'M1:一轮剥不完时继续剥(多个未闭合)');
// 围栏:整体剥,不拆成 2+1(2026-10-23 对抗审计 A 抓到)
const fenced = '调用 `recall()` 后截断在 ```js\n未闭合';
const fencedOut = stripDanglingMarkers(fenced);
check(fencedOut.includes('`recall()`'), 'M1:未闭合围栏不得破坏前文成对的行内代码');
check(!fencedOut.includes('``'), 'M1:未闭合围栏整体剥掉(不许留 `` 残片)');

// ── M3 · 只剥 snippet 里的**成对**标记(选项 C)────────────────────
check(stripPairedMarkdown('**粗**体') === '粗体', 'M3:剥成对粗体');
check(stripPairedMarkdown('用 `code` 表示') === '用 code 表示', 'M3:剥成对行内代码');
check(stripPairedMarkdown('见 [文档](https://x.y/z)') === '见 文档', 'M3:链接留文字、丢掉地址');
check(stripPairedMarkdown('未配对的 ** 留着') === '未配对的 ** 留着', 'M3:未配对的归 M1 管,这里不动');
check(stripPairedMarkdown('**多\n行**不剥') === '**多\n行**不剥', 'M3:跨行的成对标记不剥(避免吃掉整段结构)');

// ── M5 · 条目去重 + 同类折叠 ──────────────────────────────────
const mk = (kind, text, conv = 'c1') => ({ kind, text, conv_id: conv });
const many = [mk('事实', 'a'), mk('事实', 'b'), mk('事实', 'c'), mk('事实', 'd'), mk('决定', 'e')];
const g = groupDeepRows(many);
check(g.rows.length === DEEP_ROWS_PER_KIND + 1, 'M5:同类超 3 条只留 3 条,其它类目不受影响');
check(g.folded.length === 1 && g.folded[0].includes('另有 1 条'), 'M5:折叠行必须报出条数(不静默丢)');
const dup = [mk('事实', '同一句', 'c1'), mk('事实', '同一句', 'c1')];
check(groupDeepRows(dup).rows.length === 1, 'M5:完全重复(同 conv + 同 text)只留一条');
check(groupDeepRows([]).rows.length === 0 && groupDeepRows([]).folded.length === 0, 'M5:空输入不炸');

// ── M6 · 回执总字数上限 ──────────────────────────────────────
const shortOne = capReceiptText('短');
check(shortOne.truncated === false && shortOne.remaining === 0 && shortOne.text === '短', 'M6:未超上限不截断');
const longOne = 'x'.repeat(RECEIPT_CHARS_MAX + 800);
const capped = capReceiptText(longOne);
check(capped.truncated === true, 'M6:超了必须标 truncated');
check(capped.remaining > 0 && capped.text.includes('还有'), 'M6:必须报出还剩多少(不许静默截断)');
check(capped.text.includes(String(RECEIPT_CHARS_MAX)), 'M6:报出上限数字');
// 切点不得留半个代理对 —— 与 F4 同一道防线
const emojiLong = 'a'.repeat(RECEIPT_CHARS_MAX - 1) + '🎉' + 'b'.repeat(500);
const ce = capReceiptText(emojiLong);
check(wellFormed(ce.text) === ce.text, 'M6:截断不得切出孤立代理(半个 emoji)');

// ── M2 · 固定文案收进 description,回执不再重复 ──────────────────
check(RECALL_SPEC.description.includes('拿到之后怎么走'), 'M2:下一步已收进 description');
check(RECALL_SPEC.description.includes('2~4 字'), 'M2:检索口径已在 description');
const searchReceipt = renderSearch({
  ok: true, q: 'x', all: false, skipped: 0, deep: [],
  rows: [{ conv: 'c', seq: 1, time: 't', who: '主人', snippet: 's' }],
});
check(!searchReceipt.includes('**下一步**'), 'M2:检索回执不再印固定「下一步」');
check(searchReceipt.includes('找到 1 轮原文'), 'M2:数据仍在(瘦身不是把内容删掉)');
const mapReceipt = renderRecall({
  ok: true, action: 'map', total: 1, projects: 1, noRawTotal: 0,
  sessions: [{ conv: 'c', mtime: Date.now(), bytes: 1024, project: 'p' }],
});
check(!mapReceipt.includes('**下一步**'), 'M2:清单回执不再印固定「下一步」');
check(mapReceipt.includes('磁盘上'), 'M2:清单数据仍在');

// ── M6 端到端:清单档超长必须被截断并报数 ────────────────────────
const big = renderRecall({
  ok: true, action: 'map', total: 2000, projects: 1, noRawTotal: 0,
  sessions: Array.from({ length: 200 }, (_, i) => ({ conv: `session-${i}`, mtime: Date.now(), bytes: 1024, project: 'p' })),
});
check(big.length <= RECEIPT_CHARS_MAX + 400, 'M6:清单档回执被压到上限附近');
check(big.includes('还有'), 'M6:清单档截断要报出还剩多少');
// ⚠️ 1.7.2 自查抓到的真缺陷:**search 档会被套两次上限**(renderSearch 一次 + renderRecall 一次)
//   ⇒ 二次截断并重复印一遍"还有多少没显示"。这里钉住"只报一次"。
const bigSearch = RECALL_SPEC.output.render({}, {
  ok: true, action: 'search', q: 'x', all: false, skipped: 0, deep: [],
  rows: Array.from({ length: 200 }, (_, i) => ({
    conv: `session-${i}`, seq: i, time: '10-23 20:00', who: '主人', snippet: '命中片段'.repeat(30),
  })),
})[0].text;
check((bigSearch.match(/字上限/g) || []).length === 1, 'M6:search 档只报一次上限(不许被套两次)');
check(bigSearch.length <= RECEIPT_CHARS_MAX + 400, 'M6:search 档也被压到上限附近');

// ── M6 · 末尾语义警告必须活下来(2026-10-23 对抗审计 B 抓到的真缺陷)──────────
const warnSearch = RECALL_SPEC.output.render({}, {
  ok: true, action: 'search', q: 'q', deep: [], all: false,
  selfExcluded: 7, skipped: 9, hasMore: true,
  rows: Array.from({ length: 40 }, (_, i) => ({ conv: `c${i}`, seq: i, time: '', who: 'x', snippet: 's'.repeat(160) })),
})[0].text;
check(warnSearch.includes('当前会话自己'), 'M6:截断后仍要保住「本会话已排除 N 轮」');
check(warnSearch.includes('被范围挡掉'), 'M6:截断后仍要保住「被范围挡掉 N 条」');
check(warnSearch.includes('还有更多'), 'M6:截断后仍要保住「这一页满了,还有更多」');
const warnMap = renderRecall({
  ok: true, action: 'map', total: 2000, projects: 1, noRawTotal: 12, noRawBySource: 'dsweb',
  sessions: Array.from({ length: 200 }, (_, i) => ({ conv: `s${i}`, mtime: Date.now(), bytes: 1024, project: 'p' })),
});
check(warnMap.includes('只有概述、没有原文'), 'M6:map 截断后仍要保住「库里另有 N 条只有概述」');

// ── M4 · emoji 策略(保留、不新增;用途写进说明)──────────────────
check(RECALL_SPEC.description.includes('状态符号'), 'M4:emoji 的角色已写进工具说明(状态符号·保留·不新增)');

console.log(ok ? '✓ recall-noise 全部通过' : '✗ recall-noise 有失败项');
process.exit(ok ? 0 : 1);
