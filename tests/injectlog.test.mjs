// 投递留痕(1.6-A,2026-10-03):**每一次首次定稿的注入**落一条 —— 回答「注入了谁 / 为什么是它 / 多少字」。
//   动机(主人当天定的调子「目的不是省钱,是防止注意力稀释」):判据是**行为** ⇒ 行为必须先有仪表。
//   此前"选得准不准 / 有没有漏用 / 面板读数是否等于实际注入"三问全无底账(plans/RECON-1.6-库现状-20261003)。
//   本套钉四件事:① 表与读写往返 ② **只有首次定稿**落痕(重建/刷新不落) ③ 落选者名单与理由可读 ④ 打桩不炸。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { selectL1, explainScore } = await imp('lib/host/l1.js');
const { buildSnapshotText } = await imp('lib/host/snapshot.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
const section = (t) => console.log('── ' + t);

const dir = mkdtempSync(join(tmpdir(), 'ling-inject-'));
const iso = (d) => new Date(Date.now() - d * 864e5).toISOString();
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

// ---------------- 1) 表就位 + 读写往返 ----------------
section('1) inject_log 表就位 + 读写往返');
const m1 = new MemoryStore(join(dir, 'a.db'));
eq(String(m1.kvGet('schema_version')), '17', 'E1:schema_version 前进到 17');
{
  const cols = m1.db.prepare('PRAGMA table_info(inject_log)').all().map((c) => c.name);
  const want = ['id', 'at', 'session_id', 'reason', 'mode', 'text_hash', 'text_chars', 'l0_chars',
    'l1_chars', 'budget_chars', 'keywords', 'items', 'runner_ups', 'excluded', 'dropped', 'note'];
  for (const c of want) check(cols.includes(c), `E1:inject_log 缺列 ${c}(实际 ${cols.join(',')})`);
  const idx = m1.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inject_log'").all().map((r) => r.name);
  check(idx.length >= 2, 'E1:建了索引(实际 ' + idx.join(',') + ')');
}
m1.logInjection({
  sessionId: 's-1', reason: 'first', mode: 'work', textHash: 'deadbeefdeadbeef',
  textChars: 2267, l0Chars: 1085, l1Chars: 1144, budgetChars: 1680,
  keywords: ['记忆树', '深层库'],
  items: [{ source: 'dsh', conv_id: 'c1', score: 1.2, why: '血缘1.00 ⇒ 1.200' }],
  runnerUps: [{ source: 'dsh', conv_id: 'c2', score: 0.9, reason: 'budget', why: '血缘0.40 ⇒ 0.900' }],
  excluded: { archived: 3, forgotten: 1, zero: 2 }, dropped: 1619,
});
{
  const got = m1.listInjections({ limit: 5 });
  eq(got.length, 1, 'E1:落一条');
  eq(got[0].items[0].conv_id, 'c1', 'E1:items JSON 解回对象');
  eq(got[0].runner_ups[0].reason, 'budget', 'E1:runner_ups JSON 解回对象');
  eq(got[0].excluded.archived, 3, 'E1:excluded JSON 解回对象');
  eq(got[0].dropped, 1619, 'E1:dropped 落库');
  eq(JSON.stringify(got[0].keywords), '["记忆树","深层库"]', 'E1:keywords 落库(为什么是它的一半答案在问句里)');
  eq(typeof m1.listInjections({ limit: 1, parse: false })[0].items, 'string', 'E1:parse=false 时 items 是 JSON 原文');
  // 缺省入参一律宽容 —— 留痕少一个字段是可惜,因为留痕而抛异常是事故
  m1.logInjection({ sessionId: 's-2' });
  eq(m1.listInjections({ limit: 5 })[0].session_id, 's-2', 'E1:新→旧(倒序)');
  eq(m1.listInjections({ sessionId: 's-1' }).length, 1, 'E1:按 sessionId 过滤');
  eq(m1.listInjections({ limit: 9999 }).length, 2, 'E1:limit 越界夹取而不抛');
  eq(m1.listInjections({ limit: 5 })[0].items.length, 0, 'E1:缺省字段写默认值(空数组)');
}
m1.close();

// ---------------- 2) 落选者名单与理由(纯桩,算法层) ----------------
section('2) 落选者名单与理由');
{
  const many = Array.from({ length: 12 }, (_, i) => row({ conv_id: 'c' + i, title: '标题' + i, hit_count: 12 - i }));
  const r = pick(many, { maxItems: 3, runnerUps: 5 });
  eq(r.items.length, 3, 'E2:maxItems=3 入选 3 条');
  eq(r.runnerUps.length, 5, 'E2:落选者留 5 条');
  check(r.runnerUps.every((x) => x.reason === 'max'),
    'E2:分数不够的记 reason=max(实际 ' + JSON.stringify(r.runnerUps.map((x) => x.reason)) + ')');
  check(r.runnerUps[0].score >= r.runnerUps[4].score, 'E2:落选者按分降序');
  check(r.runnerUps.every((x) => typeof x.why === 'string' && x.why.includes('⇒')), 'E2:落选者也带可读理由');
  eq(r.dropped, 9, 'E2:dropped = scored - items');
  eq(pick(many, { maxItems: 3, runnerUps: 0 }).runnerUps.length, 0, 'E2:runnerUps=0 时不记(留痕可关)');
}
{
  // 预算截断:同一个 150 字摘要铺 8 行 ⇒ 预算只放得下前几条
  const many = Array.from({ length: 8 }, (_, i) =>
    row({ conv_id: 'b' + i, title: '标题' + i, summary: '标题' + i + ' —— ' + '甲'.repeat(150), hit_count: 8 - i }));
  eq(pick(many, { maxItems: 8, budgetChars: 4000 }).items.length, 8, 'E2:前置 —— 宽预算下 8 条全进(否则下一条是空的)');
  const tight = pick(many, { maxItems: 8, budgetChars: 400 });
  check(tight.items.length < 8 && tight.items.length >= 1, 'E2:窄预算下入选被截(实际 ' + tight.items.length + ')');
  const bud = tight.runnerUps.filter((x) => x.reason === 'budget');
  check(bud.length >= 1, 'E2:被字节预算挤掉的记 reason=budget(实际 '
    + JSON.stringify(tight.runnerUps.map((x) => [x.conv_id, x.reason])) + ')');
  check(bud[0].score >= tight.runnerUps[tight.runnerUps.length - 1].score,
    'E2:budget 组分数不低于 max 组 —— 否则名单顺序会误导复盘');
}
{
  // excluded 三类计数:**主动排除**(主人的动作)必须能和"分数不够"分开算
  const rows = [row({ conv_id: 'keep' }), row({ conv_id: 'arc' }), row({ conv_id: 'forg', source: 'dsweb' })];
  const store = {
    listOverviews: () => rows,
    archivedConvIdSet: () => new Set(['arc']),
    forgottenConvIdSet: () => new Set(['dsweb|forg']),
  };
  const r = selectL1(store, { mode: 'work', maxItems: 8, budgetChars: 4000 });
  eq(r.excluded.archived, 1, 'E2:归档计数');
  eq(r.excluded.forgotten, 1, 'E2:遗忘计数');
  eq(r.excluded.zero, 0, 'E2:zero 计数(本组全为正分)');
  eq(r.items.length, 1, 'E2:主动排除的不进 items');
  eq(r.keywords.length, 0, 'E2:keywords 缺省空数组(可直接落库)');
}

// ---------------- 3) 接线:只有首次定稿落痕 ----------------
section('3) 接线:只有首次定稿落痕');
const S = {
  persona: {
    enabled: true, aiName: '小灵', userTitle: '', aiTitle: '', language: 'follow',
    tone: 'natural', toneWork: '', toneLife: '', extraLore: '',
    hardRules: [], habits: [], habitsPending: [], bottomLines: [], ruleMeta: [],
    sealed: false, sealPhrase: '', pronoun: '她',
  },
  styles: { work: '', life: '' },
  mode: { lastMode: 'life' },
  memory: { l1Enabled: true, l1BudgetTokens: 1200, l1MaxItems: 8 },
};
{
  const mem = new MemoryStore(join(dir, 'b.db'));
  mem.upsertOverview({
    source: 'dsh', conv_id: 'sess-a', title: '记忆树与深层库', summary: '记忆树与深层库 — 讨论索引层与深层库的实现',
    category: 'knowledge', keywords: ['记忆树'], overview_ok: 1, updated_at: iso(1), started_at: iso(1),
  });
  const settings = { get: () => S };
  const b1 = buildSnapshotText(null, mem, settings, 'sess-a', { keywords: ['记忆树'], bumpHits: true });
  eq(mem.listInjections({ limit: 10 }).length, 1, 'E3:首次定稿落一条痕');
  const rec = mem.listInjections({ limit: 1 })[0];
  eq(rec.reason, 'first', 'E3:reason=first');
  eq(rec.session_id, 'sess-a', 'E3:session_id 透传');
  eq(rec.text_hash.length, 16, 'E3:全文 sha256 前 16 位(实际 ' + rec.text_hash + ')');
  eq(rec.text_chars, b1.text.length,
    'E3:text_chars 与返回的注入面逐字对齐 —— 这是「面板读数 ≠ 实际注入」那条的对照基准');
  check(rec.l1_chars > 0 && rec.l1_chars < rec.text_chars,
    'E3:L1 段字数落在 (0, 全文) 之内(实际 ' + rec.l1_chars + '/' + rec.text_chars + ')');
  eq(rec.budget_chars, 1680, 'E3:预算口径 = l1BudgetTokens(1200) × 1.4');
  check(rec.items.length >= 1, 'E3:入选明细落库');
  check(String(rec.items[0].why || '').includes('⇒'), 'E3:明细带可读理由(why=' + JSON.stringify(rec.items[0].why) + ')');
  check(rec.items[0].chars > 0 && rec.items[0].chars < 400, 'E3:明细记的是**行字数**(chars=' + rec.items[0].chars + ')');
  check(!('summary' in rec.items[0]) && !('line' in rec.items[0]),
    'E3:明细已瘦身 —— 不带 summary/line 原文(原文在 conv_overview 里按 (source,conv_id) 取)');
  eq(JSON.stringify(rec.keywords), '["记忆树"]', 'E3:触发词落库');

  // bumpHits 缺省 false = 重建 / 空闲刷新 —— 绝不落痕,否则同一批记忆被反复记(与 hit_count 被刷高同一个错)
  buildSnapshotText(null, mem, settings, 'sess-a', { keywords: ['记忆树'] });
  eq(mem.listInjections({ limit: 10 }).length, 1, 'E3:重建/空闲刷新不落痕');
  mem.close();
}
{
  // 打桩 memory(没有 logInjection)⇒ 显式守卫挡住,注入面照旧成文
  // ⚠️ 桩配置必须沿用 S(`persona.enabled=true`)—— `snapshot.js` 里 L1 段的前置条件就是它,
  //   关掉 persona 时 L1 本来就不注入,那样这条断言会因为"没有 L1 段"而假失败。
  const stub = {
    kvGet: () => '', kvSet: () => {}, bumpHit: () => {},
    listOverviews: () => [row({ conv_id: 'c9', title: '打桩行' })], sessionMeta: () => null,
  };
  let threw = null;
  let txt = '';
  try { txt = buildSnapshotText(null, stub, { get: () => S }, 'sid-x', { keywords: [], bumpHits: true }).text; }
  catch (e) { threw = e; }
  check(threw === null, 'E4:桩 memory 无 logInjection 时不抛(实际 ' + threw + ')');
  check(txt.includes('打桩行'), 'E4:注入面照旧成文 —— 留痕失败不该影响注入');
}

// ---------------- 4) 理由词表跟着打分项走 ----------------
section('4) 理由词表');
{
  const s = explainScore({ row: { importance: 1 }, lineage: 0.7, heat: 0.42, kw: 2, rich: 0.25, conf: 0.3, score: 2.67 });
  // ⚠️ 2026-10-04 夜:措辞随 `explainScore` 的口径修正而变 —— 分项之间是**加法**、两个乘数
  //   (血缘/矛盾)是**乘法**,旧写法把 `矛盾降权×0.30` 混进加法列表,会报出与实际总分差 2.5 倍的分项和。
  for (const frag of ['血缘0.70', '热度0.42', '关键词命中2条', '摘要加成+0.25', '重要性+0.8', '× 矛盾0.30', '⇒ 2.670']) {
    check(s.includes(frag), `E5:理由缺片段 ${frag}(实际 ${s})`);
  }
  const flat = explainScore({ lineage: 1, kw: 0, rich: 0, conf: 1, score: 0.5 });
  check(!flat.includes('关键词') && !flat.includes('矛盾') && !flat.includes('摘要'),
    'E5:没生效的项不写进理由(否则留痕会说谎),实际 ' + flat);
}

rmSync(dir, { recursive: true, force: true });
console.log(ok ? '投递留痕 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
