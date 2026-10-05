// L1 换料(1.6 步 5):**深层库条目**的选择与渲染
//   旧版这个文件测的是概述行的两段式(`标题 —— 摘要首句`)与摘要加权;换料后 L1 读的是
//   `store.listDeepItems()`,行由 `deepLine()` 渲染(极简一行),判据换成**置顶 + 被采用 + 关键词 + 新近**。
//   `lineFor` / `computeHeat` / `summaryWeight` 都保留在 `l1.js`(别的读面仍在用),但**不再进 L1**,
//   所以本文件不再覆盖它们 —— 覆盖"已经不在这条路上"的渲染只会让红绿失去意义。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { selectL1, formatL1Section, perspectiveFrame, firstSentence } = await imp('lib/host/l1.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

/** 一条深层库条目(字段名与 `deep_item` 表一致 —— 注意来源列叫 **src**,不是 source)。 */
const item = (o = {}) => ({
  id: o.id || 'di:1',
  kind: o.kind ?? '决定',
  durability: o.durability ?? 'long',
  text: o.text ?? '一条结论',
  at: o.at ?? iso(1),
  created_at: o.created_at ?? iso(1),
  conv_id: o.conv_id || ('c-' + (o.id || '1')),   // 默认**按 id 派生** ⇒ 各条不同源(同源限额见第 11 组)
  src: o.src ?? 'dsh',
  hit_count: o.hit_count ?? 0,
  pinned: o.pinned ?? 0,
  superseded_by: '',
});
const pick = (rows, opts = {}) => selectL1(
  { listDeepItems: () => rows },
  { mode: 'work', maxItems: 8, budgetChars: 4000, ...opts },
);
const ids = (r) => r.items.map((i) => i.id);

// 1) 渲染形态:`- [kind] text` —— 不带日期/标签/来源三段前缀(那是概述行的形状)
{
  const r = pick([item({ kind: '承诺', text: '答应过要尽快做完记忆库' })]);
  check(r.items.length === 1, '一条条目应入选');
  check(r.items[0].line === '- [承诺] 答应过要尽快做完记忆库', '条目行形态: ' + r.items[0].line);
  check(!/\(\d{4}-\d{2}-\d{2}\)/.test(r.items[0].line), '条目行不带日期前缀');
  check(!r.items[0].line.includes('来源:'), '条目行不带来源后缀');
}
// 1b) 没有 kind 时退化成纯文本行,不渲染成 "[undefined]"
{
  const r = pick([item({ kind: '', text: '没有分类的结论' })]);
  check(r.items[0].line === '- 没有分类的结论', '无 kind 时不出现空标签: ' + r.items[0].line);
}

// 2) 置顶**必进** —— 不参与分数竞争,且预算再紧也先保它
{
  const rows = [
    // 置顶那条**故意**给最低的长期分(事实 0 + 不衰减的新近也救不了),其余给最高的(承诺 + 长期)。
    //   加入"硬度分/类别分"之后这条前提不再自明 ⇒ 必须显式构造,否则断言会随打分公式漂移。
    item({ id: 'p', kind: '事实', durability: 'long', text: '置顶的那条', pinned: 1, at: iso(3000) }),
    ...Array.from({ length: 9 }, (_, i) => item({ id: 'n' + i, kind: '承诺', durability: 'durable', text: '普通条目' + i })),
  ];
  const r = pick(rows, { maxItems: 3 });
  check(ids(r)[0] === 'p', '置顶排第一: ' + ids(r).join(','));
  check(r.items[0].pinned === true, '置顶标记带进 items');
  // 置顶的 at 已经很老(3000 天)且类别最低 —— 分数远低于新条目,它仍然进,证明是"必进"而不是"分高"
  check(r.items[0].score < r.items[1].score, '置顶的分数确实低于后来者(靠必进规则入选): ' + r.items[0].score + ' vs ' + r.items[1].score);
}
// 2b) 全置顶时也不炸,且不重复
{
  const rows = [item({ id: 'p1', pinned: 1 }), item({ id: 'p2', pinned: 1 })];
  const r = pick(rows, { maxItems: 5 });
  check(r.items.length === 2 && new Set(ids(r)).size === 2, '多条置顶各出现一次: ' + ids(r).join(','));
}

// 3) 被反复采用 ⇒ 排面靠前(hit_count 是"加固"这一维)
{
  const rows = [
    item({ id: 'cold', text: '从没被采用过' }),
    item({ id: 'hot', text: '被反复采用过', hit_count: 5 }),
  ];
  const r = pick(rows);
  check(ids(r)[0] === 'hot', '被采用的排前面: ' + ids(r).join(','));
  check(r.items[0].hit === 5, 'hit 带进 items');
  check(r.items[1].hit === 0, '未采用的 hit=0');
}
// 3b) 采用次数**饱和**:5 次与 500 次同分(满分 1.0),不出现"刷分碾压一切"
{
  const a = pick([item({ id: 'a', hit_count: 5 })]).items[0].raw;
  const b = pick([item({ id: 'b', hit_count: 500 })]).items[0].raw;
  check(Math.abs(a - b) < 1e-9, '采用数在 5 次处饱和: ' + a + ' vs ' + b);
}

// 4) 关键词命中 ⇒ 当轮相关加成(与宿主检索面同源的多词语义:每词都要命中)
{
  const rows = [
    item({ id: 'rel', text: '关于记忆树与血缘的设计', hit_count: 0 }),
    item({ id: 'irr', text: '关于别的东西的描述', hit_count: 0 }),
  ];
  const r = pick(rows, { keywords: ['记忆树'] });
  check(ids(r)[0] === 'rel', '关键词命中的排前面: ' + ids(r).join(','));
  check(r.items[0].kw === 1, 'kw 计数带进 items');
}

// 5) 预算是**护栏**:装不下的被留下并进 runnerUps(落选者留痕,1.6-A)
{
  // 用**真实长度**的数据(条目 ≤80 字):30 条 × 20 字,预算 100 字 ⇒ 只装得下几条
  const rows = Array.from({ length: 30 }, (_, i) => item({ id: 's' + i, text: '甲'.repeat(20), hit_count: 5 - (i % 5) }));
  const r = pick(rows, { budgetChars: 100 }); // ⚠️ selectL1 内部有 Math.max(200, budgetChars) 的下限 ⇒ 实际预算 200
  check(r.items.length >= 1, '预算紧时至少装下一条');
  check(r.totalChars <= 200, '总字数不超实际预算(下限 200): ' + r.totalChars);
  check(r.dropped === 30 - r.items.length, 'dropped 对得上: ' + r.dropped);
  check(r.runnerUps.length >= 1, '被挤掉的进 runnerUps');
  check(r.runnerUps.every((x) => ['budget', 'max', 'conv', 'dup'].includes(x.reason)), '落选原因合法: ' + r.runnerUps.map((x) => x.reason).join(','));
  check(typeof r.runnerUps[0].why === 'string' && r.runnerUps[0].why.length > 0, '落选者带可读理由');
}
// 5c) 病态超长条目被 `maxLineChars` 硬顶,不会把整段卡死
{
  const rows = [item({ id: 'huge', text: '乙'.repeat(900), hit_count: 5 }), item({ id: 'ok', text: '短条目' })];
  const r = pick(rows, { maxLineChars: 120, budgetChars: 400 });
  check(r.items.length === 2, '硬顶后两条都能进: ' + ids(r).join(','));
  check(r.items[0].line.length <= 140, '病态行受控: ' + r.items[0].line.length);
  check(r.items[0].line.includes('…'), '硬顶时标 …');
}
// 5b) maxItems 上限:超出的进 runnerUps 且 reason='max'
{
  const rows = Array.from({ length: 6 }, (_, i) => item({ id: 'i' + i, text: '条目' + i }));
  const r = pick(rows, { maxItems: 2 });
  check(r.items.length === 2, 'maxItems 生效');
  check(r.dropped === 4, 'dropped = 未入选数: ' + r.dropped);
  check(r.runnerUps.length > 0 && r.runnerUps.every((x) => x.reason === 'max'), '全是 max 落选');
}

// 6) 过滤沿用既有两把锁:归档会话、被遗忘的条目
{
  const rows = [
    item({ id: 'arch', conv_id: 'c-arch', src: 'dsh', hit_count: 5 }),
    item({ id: 'forg', conv_id: 'c-forg', src: 'dsh', hit_count: 4 }),
    item({ id: 'keep', conv_id: 'c-keep', src: 'dsh' }),
  ];
  const r = selectL1({
    listDeepItems: () => rows,
    archivedConvIdSet: () => new Set(['c-arch']),
    forgottenConvIdSet: () => new Set(['dsh|c-forg']),
  }, { mode: 'work', maxItems: 8, budgetChars: 4000 });
  check(ids(r).join(',') === 'keep', '归档与遗忘的条目都不入选: ' + ids(r).join(','));
  check(r.excluded.archived === 1, '归档计数: ' + r.excluded.archived);
  check(r.excluded.forgotten === 1, '遗忘计数: ' + r.excluded.forgotten);
}
// 6b) 归档只对 `src='dsh'` 生效(dsweb/import 没有会话行可归档)
{
  const rows = [item({ id: 'hist', conv_id: 'c-arch', src: 'dsweb' })];
  const r = selectL1({ listDeepItems: () => rows, archivedConvIdSet: () => new Set(['c-arch']) },
    { mode: 'work', maxItems: 8, budgetChars: 4000 });
  check(r.items.length === 1, 'dsweb 条目不受归档表影响');
}

// 7) 血缘与矛盾降权**按 `src` 对齐字段名**(条目的来源列叫 src,概述行叫 source)
{
  const rows = [item({ id: 'x', conv_id: 'c-x', src: 'dsh', hit_count: 5 })];
  const r = selectL1({
    listDeepItems: () => rows,
    conflictDowngradeMap: () => new Map([['dsh\u0000c-x', 0.3]]),
  }, { mode: 'work', maxItems: 8, budgetChars: 4000 });
  check(r.items[0].conf === 0.3, '矛盾降权按 src|conv_id 命中: ' + r.items[0].conf);
  // 措辞随 `explainScore` 口径修正而变:矛盾现在是**乘数**(`× 矛盾0.30`),不再混在加法分项里
  check(r.items[0].why.includes('矛盾'), '理由里报出降权: ' + r.items[0].why);
  // ⚠️ N4(蓝队 2026-10-04):深条目路的 `why` **原先没有护栏** —— 唯一断言只查 `includes('矛盾')`,
  //   把格式改回旧的加法写法**仍然绿**(F3 那个"留痕说谎"就是这么漏过去的)。这里把**形态**钉死:
  //   条目路必须是 `(分项和) × 血缘 [× 矛盾] ⇒ 总分`。
  check(/^\(.+\) × 血缘[\d.]+/.test(r.items[0].why) && /⇒ [\d.]+$/.test(r.items[0].why),
    '★ 条目路 why 必须是 `(分项和) × 血缘 [× 矛盾] ⇒ 总分` 形态: ' + r.items[0].why);
}
// 2c) ★ 置顶数**超过 maxItems** 时不许被裁 —— 蓝队 2026-10-04:F2("必进"在闸门处失效)能漏过去,
//   根因就是"置顶用例里置顶数从未超过 maxItems"。这条用例专门补上那个缺口。
{
  const rows = Array.from({ length: 5 }, (_, i) => item({ id: 'p' + i, pinned: 1, text: '置顶' + i }));
  const r = pick(rows, { maxItems: 2 });
  check(r.items.length === 5 && r.items.every((i) => i.pinned),
    '★ 置顶 5 条 + maxItems=2 ⇒ 5 条**全进**(必进允许越界),实际 ' + r.items.length);
  check(!r.runnerUps.some((x) => x.pinned), '★ 落选者名单里不许出现置顶(它们根本没被裁)');
  check(!r.items.some((i) => i.score === undefined), '越界置顶仍要带分数(留痕可复盘)');
}
// 7b) store 没有 listDeepItems(老桩)⇒ 不抛,返回空
{
  const r = selectL1({}, { mode: 'work', maxItems: 8, budgetChars: 4000 });
  check(r.items.length === 0 && r.dropped === 0, 'store 无 listDeepItems 时安全返回空');
}

// 8) 段组装:视角框在段头、只出现一次、条数不变;超量折叠成一行
{
  const rows = [item({ id: 'a', kind: '关系', text: '两人约定先侦察再动手' }), item({ id: 'b', text: '第二条' })];
  const r = pick(rows);
  const sec = formatL1Section(r);
  check(sec.startsWith('[记忆·开场]'), '段落头不变');
  check(sec.includes('以下是我从与主人'), '视角框在段头(1.6-B,措辞随换料更新)');
  check(sec.indexOf('以下是我从与主人') < sec.indexOf('\n- '), '视角框排在第一条之前');
  check(sec.split('以下是我从与主人').length === 2, '视角框只出现一次');
  check(sec.includes('- [关系] 两人约定先侦察再动手'), '条目原样进段');
  // 称呼跟随 userTitle(与时钟锚同一把尺:work=正式名 / life=昵称)
  check(formatL1Section(r, { userTitle: '尝生/主人', mode: 'work' }).includes('以下是我从与尝生'), 'work 取正式名');
  check(formatL1Section(r, { userTitle: '尝生/主人', mode: 'life' }).includes('以下是我从与主人'), 'life 取昵称');
  check(perspectiveFrame('', 'work').includes('与主人'), '空 userTitle 退回中性措辞');
  // 超量折叠
  const big = pick(Array.from({ length: 20 }, (_, i) => item({ id: 'z' + i, text: '条目' + i })), { maxItems: 3 });
  check(formatL1Section(big).includes('已省略'), '超量时有省略行: ' + formatL1Section(big).split('\n').pop());
  check(!formatL1Section({ items: [], dropped: 0 }).length, '无条目时返回空串');
}

// 9) firstSentence 保留(它仍被别的读面用:标题兜底/深摘)
{
  const cases = [['第一句。第二句。', '第一句。'], ['甲；乙。', '甲；'], ['问？答。', '问？'], ['半;后。', '半;']];
  cases.forEach(([s, want]) => check(firstSentence(s) === want, `firstSentence(${s}) → ${want},实际 ${firstSentence(s)}`));
  check(firstSentence('') === '', '空串 → 空');
  check(firstSentence('甲'.repeat(300)).endsWith('…') && firstSentence('甲'.repeat(300)).length === 111, '单句超预算 → 110 字 + …');
  check(firstSentence('甲'.repeat(300), 0).length === 300, 'cap=0 → 不截');
}

// 10) 预算口径:persona 缺省 720 tokens ⇒ 1008 字(「瘦身到 60%」的落点)
{
  const budgetChars = Math.round(720 * 1.4);
  check(budgetChars === 1008, '720 tokens × 1.4 = 1008 字: ' + budgetChars);
  const rows = Array.from({ length: 40 }, (_, i) => item({ id: 'b' + i, text: '条目' + i, hit_count: 5 - (i % 5) }));
  const r = pick(rows, { budgetChars });
  check(r.totalChars <= budgetChars, '实占不超口径: ' + r.totalChars);
  check(r.items.length < 40, '确实被预算裁过: 入选 ' + r.items.length);
}

// 11) **同源限额**(2026-10-04 尝生开新会话实测:「会话内的、临时的结论会被灌入」)
//   病灶:一次高产出会话(实测某次生图会话 13 条)能把 8 条开场整个占满,而那 8 条讲的是同一件事。
//   规则:同一次会话最多进 2 条（`MAX_PER_CONV`）;**置顶不受此限**(那是主人的明确动作)。
{
  const rows = Array.from({ length: 8 }, (_, i) => item({ id: 'k' + i, conv_id: 'same', text: '同源条目' + i, hit_count: 5 }));
  const r = pick(rows, { runnerUps: 20 });
  check(r.items.length === 2, '同源最多进 2 条,实际 ' + r.items.length);
  check(new Set(r.items.map((x) => x.conv_id)).size === 1, '进的都是同一个会话的条目');
  const capped = r.runnerUps.filter((x) => x.reason === 'conv');
  check(capped.length === 6, '被限额挡下的 6 条进了 runnerUps(conv): ' + capped.length);
  check(capped.every((x) => x.conv_id === 'same'), '挡下的确实都是同源条目');
  const rows2 = [
    item({ id: 'p1', conv_id: 's2', pinned: 1 }),
    item({ id: 'p2', conv_id: 's2', pinned: 1 }),
    item({ id: 'p3', conv_id: 's2', pinned: 1 }),
  ];
  const r2 = pick(rows2);
  check(r2.items.length === 3, '置顶不受同源限额约束,实际 ' + r2.items.length);
  // 不同源的条目互不影响(⚠️ 给不同 text:夹具的默认 text 相同会撞上"近似重复去重",
  //   而这一组要测的是**同源限额**,两件事不能混在一起)
  const rows3 = [
    item({ id: 'a', conv_id: 'x1', text: '不同源条目 A' }),
    item({ id: 'b', conv_id: 'x2', text: '不同源条目 B' }),
    item({ id: 'c', conv_id: 'x1', text: '不同源条目 C' }),
  ];
  check(pick(rows3).items.length === 3, '非同源不互相挤占,实际 ' + pick(rows3).items.length);
}

// 12) **近似重复去重**(2026-10-04 真机抓到的第二条:开场里同时出现两条同义结论)
//   病灶:两条几乎同字的「器灵的记忆树工具(tree_read/branch_edit…)」来自**不同会话** ⇒
//   幂等判据 `(conv_id,seq_from,seq_to,text)` 与同源限额**都挡不住**,却同时占了 8 个位置里的 2 个。
//   规则:与**已入选**条目 3-gram Jaccard ≥ 0.7 ⇒ 让位,落选原因记 `dup`(可查)。
{
  const t = '器灵的记忆树工具（tree_read/branch_edit/memory_forget）写在 lib/host/tools.js';
  const rows = [
    item({ id: 'd1', conv_id: 'cc1', text: t }),
    item({ id: 'd2', conv_id: 'cc2', text: t.replace('写在', '放在') }), // 同义改写 ⇒ 跨会话
    item({ id: 'd3', conv_id: 'cc3', text: '完全不相干的另一条结论' }),
  ];
  const r = pick(rows, { runnerUps: 20 });
  check(r.items.length === 2, '近似重复只进一条,实际 ' + r.items.length);
  check(r.items.some((x) => String(x.text).startsWith('完全不相干')), '不相干的那条正常进');
  check(r.runnerUps.filter((x) => x.reason === 'dup').length === 1, '被去重挡下的进了 runnerUps(dup)');
}

// 13) **事实席位**(1.6,2026-10-04 尝生:「8 条也可以考虑改 10 条,其中 2 条作为**最硬的事实**的席位」)
//   动机是实测偏斜:承诺/关系优先后,`事实` 的类别分为 0 ⇒ 稳定的环境类事实永远进不来,
//   而它们恰恰是"接下来要干什么"的前提。留 2 席给 `durable` 的事实,不挤占"关于人"的那 8 席。
{
  // 12 条 durable 事实 + 8 条承诺 ⇒ 事实必须占到至少 2 席(否则永远被类别分压在门外)
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => item({ id: 'p' + i, kind: '承诺', durability: 'durable', text: '承诺' + i })),
    ...Array.from({ length: 12 }, (_, i) => item({ id: 'f' + i, kind: '事实', durability: 'durable', text: '事实' + i })),
  ];
  const r = pick(rows, { maxItems: 10 });
  const facts = r.items.filter((x) => String(x.kind) === '事实').length;
  check(facts >= 2, '事实至少占 2 席(实际 ' + facts + ')');
  check(r.items.length === 10, '总数仍是 maxItems(实际 ' + r.items.length + ')');

  // 没有合格事实 ⇒ 席位**归还通用池**,不许空着
  const rows2 = Array.from({ length: 12 }, (_, i) => item({ id: 'q' + i, kind: '承诺', durability: 'durable', text: '承诺' + i }));
  const r2 = pick(rows2, { maxItems: 10 });
  check(r2.items.length === 10, '无合格事实时席位归还 ⇒ 仍满 10 条(实际 ' + r2.items.length + ')');

  // `long` 的事实**不算**"最硬" ⇒ 不占席位(否则等于给一切事实开后门)
  const rows3 = [
    ...Array.from({ length: 12 }, (_, i) => item({ id: 's' + i, kind: '承诺', durability: 'durable', text: '承诺' + i })),
    ...Array.from({ length: 4 }, (_, i) => item({ id: 'g' + i, kind: '事实', durability: 'long', text: '软事实' + i })),
  ];
  const r3 = pick(rows3, { maxItems: 10 });
  check(r3.items.filter((x) => String(x.text).startsWith('软事实')).length === 0, 'long 的事实不占席位');
}

// 13) A-5(2026-10-05):枝系数**真的改排序** —— 判据是"调低某条枝 ⇒ 从这条枝的会话里提炼出的
//     结论往后排",不是"回执说它生效了"。接线口径:一条记忆的枝 = **它来源会话所在的枝**
//     (条目自身不挂枝:实测 393/393 条 `deep_item.branch_id` 为空)。
{
  const mkStore = (rows, { scales = {}, convBranch = {} } = {}) => ({
    listDeepItems: () => rows,
    listBranches: () => Object.entries(scales).map(([id, w]) => ({ id, weightScale: w })),
    convBranchMap: () => new Map(Object.entries(convBranch).map(([k, v]) => [k.replace('|', '\u0000'), v])),
    sessionBranchMap: () => new Map(),
  });
  const mk = (id, conv, text) => item({ id, conv_id: conv, src: 'dsweb', text, kind: '事实', durability: 'long' });
  const rows = [mk('di:a', 'cA', '甲枝的结论'), mk('di:b', 'cB', '乙枝的结论')];
  const opt = { mode: 'work', maxItems: 8, budgetChars: 4000 };

  const flat = selectL1(mkStore(rows), opt);
  check(flat.items.length === 2, 'A-5 前置:两条同形条目都入选(实际 ' + flat.items.length + ')');
  check(Math.abs(flat.items[0].score - flat.items[1].score) < 1e-9, 'A-5 前置:默认(枝系数全为 1)两者同分');

  // 把甲枝压到 0.5 ⇒ 甲必须掉到乙后面,且分数正好减半
  const r2 = selectL1(mkStore(rows, {
    scales: { 'br:jia': 0.5 },
    convBranch: { 'dsweb|cA': 'br:jia', 'dsweb|cB': 'br:yi' },
  }), opt);
  check(ids(r2).join(',') === 'di:b,di:a',
    '★A-5 压枝系数 ⇒ 该枝的结论掉到后面(实际 ' + ids(r2).join(',') + ')');
  const half = flat.items.find((x) => x.id === 'di:a').score / 2;
  const now = r2.items.find((x) => x.id === 'di:a').score;
  check(Math.abs(now - half) < 1e-9, '★A-5 分数正好是原来的 1/2(实际 ' + now.toFixed(4) + ' vs ' + half.toFixed(4) + ')');

  // 留痕必须写出第三个乘数 —— 否则又是"留痕与公式不符"
  const why = String(r2.items.find((x) => x.id === 'di:a').why || '');
  check(/× 枝系数0\.50/.test(why), '★A-5 留痕印出枝系数(实际:' + JSON.stringify(why.slice(0, 90)) + ')');
  const whyFlat = String(flat.items[0].why || '');
  check(!/枝系数/.test(whyFlat), 'A-5 系数为 1 时留痕**不印**枝系数(与接线前逐字相同)');

  // 零开销路径:枝系数全 1 ⇒ 连映射都不建(桩里没有那两个方法也不该抛)
  const r3 = selectL1({ listDeepItems: () => rows }, opt);
  check(r3.items.length === 2, 'A-5 零开销路径:没有枝映射方法也不抛、照常选(实际 ' + r3.items.length + ')');
}

console.log(ok ? 'L1 换料(深层库条目) 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
