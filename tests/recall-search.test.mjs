// recall 检索档(1.6 §7 步 1):范围限制(D6)+ 命中折行 + 渲染
//
// 为什么单独立一套:这条路的三个判据**出错了也不会有人喊** ——
//   ① 范围(D6 已拍:默认只搜"主人自己的会话")错了,会静默把子代理会话读进来;
//   ② 可见性过滤错了会**静默少给** ⇒ skipped 必须报出来,不许静默丢;
//   ③ 渲染错了模型只会看到 `${v.message}` 这种原样字符串 —— 本文件第一次跑就抓到过一处。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  clampSearchLimit, visibleIdSet, toSearchRows, renderSearch, searchDeepItems, adoptDeepItems,
  searchLocalTurns, SEARCH_LOCAL_TURNS_MAX,
  SEARCH_HITS_DEFAULT, SEARCH_HITS_MAX, SEARCH_DEEP_MAX, withTimeout, SEARCH_TIMEOUT_MS,
} = await imp('lib/host/recall-search.js');
const { checkRecall } = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 条数夹取
{
  check(clampSearchLimit(undefined) === SEARCH_HITS_DEFAULT, '缺省应给默认值');
  check(clampSearchLimit(3) === 3, '正常值原样通过');
  check(clampSearchLimit(0) === 1, '下限夹到 1');
  check(clampSearchLimit(9999) === SEARCH_HITS_MAX, '上限夹到 ' + SEARCH_HITS_MAX);
  check(clampSearchLimit('abc') === SEARCH_HITS_DEFAULT, '非数退回默认');
}

// 2) 可见集(D6 判据 = isMemoryEligibleHeader:顶层 + 分叉入,子代理不入)
{
  const recs = [
    { header: { id: 'top-1' } },
    { header: { id: 'fork-1', parentSession: 'top-1' } },
    { header: { id: 'sub-1', origin: 'subagent' } },
    { header: { id: 'sub-2', delegationDepth: 1 } },
    { header: { id: 'sub-3', parentSession: 'top-1', delegationDepth: 2 } },
    { header: null },
    {},
  ];
  const s = visibleIdSet(recs);
  check(s.has('top-1'), '顶层会话应可见');
  check(s.has('fork-1'), '分叉会话应可见(D9-a:分叉入枝)');
  check(!s.has('sub-1'), 'origin=subagent 不可见');
  check(!s.has('sub-2'), 'delegationDepth>0 不可见');
  check(!s.has('sub-3'), '带深度的分叉不可见(子代理判据优先)');
  check(s.size === 2, '可见集应恰好 2 条,实得 ' + s.size);
  check(visibleIdSet(null).size === 0, 'null 入参应得空集,不抛');
  check(visibleIdSet([{ id: 'x' }]).size === 0, '没有 header 的记录不放入(宁少不滥)');
}

// 3) 折行:范围过滤 + skipped 必须报出 + 摘要单行化
{
  const hits = [
    { header: { id: 'top-1' }, bestMatch: { type: 'user/message', seq: 113, time: 1759000000000, snippet: '第一行\n第二行' } },
    { header: { id: 'sub-1', origin: 'subagent' }, bestMatch: { type: 'assistant/message', seq: 7, time: 1759000000000, snippet: '子代理的话' } },
  ];
  const visible = visibleIdSet(hits);
  const r = toSearchRows(hits, { visible, callName: '尝生' });
  check(r.rows.length === 1, '默认范围应只剩 1 条,实得 ' + r.rows.length);
  check(r.skipped === 1, '被挡掉的必须计数(skipped=1),实得 ' + r.skipped);
  check(r.rows[0].who === '尝生', 'user/message 应显示称呼');
  check(!/\n/.test(r.rows[0].snippet), '摘要必须单行化');
  check(r.rows[0].seq === 113 && r.rows[0].time.length > 0, '序与时间应带出');
  const all = toSearchRows(hits, { all: true });
  check(all.rows.length === 2 && all.skipped === 0, 'all=true 应全放行');
  check(all.rows[1].who === '鱼姬', 'assistant/message 显示鱼姬');
  check(toSearchRows(null, {}).rows.length === 0, 'null hits 不抛');
}

// 4) 渲染:不许出现未插值的模板残句,任何形状都不许抛
{
  const good = renderSearch({
    ok: true, q: '记忆树 血缘', all: false, skipped: 2, hasMore: true,
    rows: [{ conv: 'session-x', seq: 113, time: '10-04 19:33', who: '尝生', snippet: '先等等' }],
  });
  check(typeof good === 'string' && good.includes('记忆树 血缘'), '正常回执应含查询词');
  check(good.includes('主人自己的会话'), '默认范围要在回执里说明');
  check(good.includes('2 条被范围挡掉'), 'skipped 必须在回执里出现');
  check(!good.includes('${'), '回执里不许出现未插值的 ${');
  const empty = renderSearch({ ok: true, q: 'zzz', all: true, rows: [], skipped: 0 });
  check(empty.includes('没找到'), '空结果要有明确说法');
  check(empty.includes('未限定范围'), 'all=true 要说明范围');
  const bad = renderSearch({ ok: false, reason: 'search-unavailable', message: '没拿到服务' });
  check(bad.includes('没拿到服务'), '不可用回执要带上原因');
  check(!bad.includes('${'), '错误回执同样不许有未插值');
  for (const v of [null, undefined, {}, { ok: false, reason: 'search-failed' }, { ok: true, rows: [], q: '' }, { ok: true, q: 'x' }, { ok: true, q: 'x', rows: null }]) {
    let t = null;
    try { t = renderSearch(v); } catch (e) { t = 'THREW:' + e.message; }
    check(typeof t === 'string' && !t.startsWith('THREW:'), '渲染任何形状都不许抛:' + JSON.stringify(v));
  }
}

// 5) checkRecall 的检索档(且不破坏原有三档)
{
  const s = checkRecall({ q: '记忆树 血缘' });
  check(s.ok && s.action === 'search', 'q ⇒ 检索档');
  check(s.all === false, 'all 缺省 = false(默认只搜主人自己的会话)');
  check(s.limit === SEARCH_HITS_DEFAULT, 'limit 缺省走检索档默认');
  check(checkRecall({ q: 'x', all: true }).all === true, 'all=true 透传');
  const both = checkRecall({ q: 'x', conv: 'session-y' });
  check(both.ok === false && both.reason === 'q-xor-conv', 'q 与 conv 同给应被拒');
  check(checkRecall({ from: 1 }).reason === 'conv-required', '只给 from 仍要求 conv');
  check(checkRecall({}).action === 'map', '空参仍走地图档(没破坏旧行为)');
  check(checkRecall({ conv: 'x' }).action === 'outline', '给 conv 仍走目录档');
  check(checkRecall({ conv: 'x', from: 1, to: 3 }).action === 'read', '给范围仍走原文档');
  check(checkRecall({ q: '  ' }).action === 'map', '空白 q 不算检索(退地图档)');
}

// 6) 深层库条目检索(1.6 §7 步 4)
//    为什么必须有这一组:条目检索是**结论层**唯一的入口,而它的两个判据出错了都不会有人喊 ——
//    ① 多词语义若与宿主检索面不同解(那边是 AND),同一个问句会给出互相矛盾的结果;
//    ② `superseded_by` 若忘了过滤,会把"曾经成立、现已作废"的结论当成现行结论召回来。
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE deep_item (id TEXT PRIMARY KEY, kind TEXT, text TEXT, at TEXT, conv_id TEXT,
    seq_from INTEGER, seq_to INTEGER, src TEXT, hit_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
    superseded_by TEXT DEFAULT '', origin TEXT DEFAULT 'auto', branch_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT '')`);
  const ins = db.prepare('INSERT INTO deep_item (id,kind,text,conv_id,seq_from,seq_to,src,superseded_by,hit_count,pinned,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('di:1', '承诺', '鱼姬汇报必须基于自己实测的凭据', 'conv-a', 10, 12, 'dsh', '', 0, 0, '2026-10-04 01:00:00');
  ins.run('di:2', '偏好', '尝生的原则：不投资股市、不盯盘', 'conv-b', 3, 3, 'dsh', '', 0, 0, '2026-10-04 02:00:00');
  ins.run('di:3', '决定', '记忆树血缘可溯', 'conv-a', 20, 20, 'dsweb', '', 0, 0, '2026-10-04 03:00:00');
  ins.run('di:4', '事实', '这条已被取代', 'conv-c', 1, 1, 'dsh', 'di:9', 0, 0, '2026-10-04 04:00:00');
  const mem = { db };
  check(searchDeepItems(mem, '凭据').length === 1, '单词命中 1 条');
  check(searchDeepItems(mem, '投资 股市').length === 1, '多词 AND 命中(两词在同一句里)');
  check(searchDeepItems(mem, '投资 记忆树').length === 0, 'AND 语义:两词不在同一条则 0(不是 OR)');
  check(searchDeepItems(mem, 'zzz不存在').length === 0, '无匹配=空');
  check(searchDeepItems(mem, '   ').length === 0, '空白查询=空');
  check(searchDeepItems(mem, '取代').length === 0, '已取代的条目不参与召回(只追不替)');
  check(searchDeepItems({}, '凭据').length === 0, 'memory 没有 db 时静默空,不抛');
  check(searchDeepItems(mem, '凭据', 0).length === 1, 'limit=0 退回默认而不是 0 条');
  check(searchDeepItems(mem, '%').length === 0, 'LIKE 通配符被剥掉(不误命中全部)');
  check(searchDeepItems(mem, '凭据', 99999).length === 1, '超大 limit 被夹取后仍正确');
  db.close();
  // 渲染:条目段必须出现、且两种命中能同屏
  const onlyDeep = renderSearch({
    ok: true, q: '凭据', all: false, skipped: 0, rows: [],
    deep: [{ kind: '承诺', text: '鱼姬汇报必须基于实测凭据', conv_id: 'conv-a', seq_from: 10, seq_to: 12, pinned: 0 }],
  });
  check(onlyDeep.includes('深层库条目'), '有条目时要出现条目段');
  check(onlyDeep.includes('[承诺]'), '条目要带 kind');
  check(onlyDeep.includes('conv-a'), '条目要带出处 conv');
  // ⚠️ 2026-10-04 改(红队 2 的 F1):这里原本断言 `from=10` —— 而**印 `from` 本身是错的**:
  //   条目的 `seq_from` 是**事件流 seq**,而 `recall(conv, from, to)` 收的是**对话轮序号 n**,
  //   实测 274 条可比条目里 **207 条(75.5%)**照这条指引会 `out-of-range`;偶有落在范围内的,
  //   读到的也是不相干的轮次,还会顺手给不相干条目计一次"采用"。
  //   ⇒ 回执改为"先 `recall(conv=…)` 拿轮次,再按目录里的 `#N` 取",并且**不许再印 `from=`**。
  check(onlyDeep.includes('recall(conv=') && onlyDeep.includes('拿轮次'),
    '条目要给出"取原话"的下一步(先看目录再取,不直接印 from)');
  check(!onlyDeep.includes('from='), '★ 不许再印 from=<seq>(坐标系错位:事件流 seq ≠ 对话轮序号 n)');
  check(onlyDeep.includes('下一步'), '有条目时也要给下一步');
  check(!onlyDeep.includes('${'), '条目回执不许有未插值');
  check(renderSearch({
    ok: true, q: 'x', all: false, deep: [{ kind: '偏好', text: '一句话', conv_id: 'c' }],
    rows: [{ conv: 'c2', seq: 1, time: '10-04 20:08', who: '尝生', snippet: 's' }],
  }).includes('会话原文层'), '条目会话双命中时两段都在');
  check(renderSearch({
    ok: true, q: 'x', all: false, deep: [], rows: [{ conv: 'c2', seq: 1, time: 't', who: '尝生', snippet: 's' }],
  }).includes('找到 1 轮原文'), '无条目时也要有明确说法(口径:现在是"轮原文"而不是"个会话" —— 本地层按轮给)');
  check(renderSearch({
    ok: true, q: 'x', all: false, local: true, deep: [],
    rows: [{ conv: 'c2', seq: 1, time: 't', who: '尝生', snippet: 's' }],
  }).includes('本机库内原文层'), '★ A方案:本地路回执必须标注来源(残的那份要说清,否则会被读成"库里只有这些")');
  check(renderSearch({ ok: true, q: 'x', all: false, deep: [], rows: [], skipped: 0 }).includes('没找到'), '都没命中时仍要明确说法');
  check(SEARCH_DEEP_MAX > 0 && SEARCH_DEEP_MAX <= 50, 'SEARCH_DEEP_MAX 在合理区间');
}

// 7) 采用信号(1.6 步 5):`recall` 取原文 ⇒ 与**所取区间相交**的条目 `hit_count` +1。
//    为什么这条必须有断言:`hit_count` 是"反复加固"判据唯一的信号来源,而它**出错了没人会喊** ——
//    加固多了会让条目自我强化(注入越多分越高),加固少了判据恒为空。两种都不会抛异常。
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE deep_item (id TEXT PRIMARY KEY, kind TEXT, text TEXT, at TEXT, conv_id TEXT,
    seq_from INTEGER, seq_to INTEGER, src TEXT, hit_count INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0,
    superseded_by TEXT DEFAULT '', origin TEXT DEFAULT 'auto', branch_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT '')`);
  const ins = db.prepare('INSERT INTO deep_item (id,kind,text,conv_id,seq_from,seq_to,src,superseded_by,hit_count) VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('di:1', '承诺', 'A', 'conv-a', 10, 12, 'dsh', '', 0);
  ins.run('di:2', '决定', 'B', 'conv-a', 30, 30, 'dsh', '', 0);
  ins.run('di:3', '事实', 'C', 'conv-b', 5, 5, 'dsweb', '', 0);
  ins.run('di:4', '事实', 'D', 'conv-a', 11, 11, 'dsh', 'di:9', 0); // 已取代 ⇒ 不该被加固
  const mem = {
    db,
    bumpDeepHit(id) {
      const r = db.prepare('UPDATE deep_item SET hit_count=hit_count+1 WHERE id=?').run(id);
      return { ok: r.changes > 0 };
    },
  };
  const hit = (id) => Number(db.prepare('SELECT hit_count n FROM deep_item WHERE id=?').get(id).n);
  check(adoptDeepItems(mem, 'conv-a', 11, 11) === 1, '区间相交的加固(已取代的那条不计)');
  check(hit('di:1') === 1, 'di:1 被加固一次');
  check(hit('di:4') === 0, '已取代的条目**不**被加固(它是"曾经成立"的留痕)');
  check(adoptDeepItems(mem, 'conv-a', 29, 31) === 1, '另一种相交(单点落在外层区间内)');
  check(hit('di:2') === 1, 'di:2 被加固一次');
  check(adoptDeepItems(mem, 'conv-a', 1, 2) === 0, '不相交 ⇒ 0,且不改任何行');
  check(hit('di:1') === 1 && hit('di:2') === 1, '不相交时两个计数都没动');
  check(adoptDeepItems(mem, 'conv-a', 12, 12) === 1, '边界:正好落在 seq_to 上算相交');
  check(adoptDeepItems(mem, 'conv-a', 13, 13) === 0, '边界:越过 seq_to 一格就不算');
  check(adoptDeepItems(mem, 'conv-b', 5, 5) === 1, '按 conv 隔离(dsweb 源同样可加固)');
  check(adoptDeepItems({}, 'conv-a', 10, 10) === 0, 'memory 没有 db ⇒ 0,不抛');
  check(adoptDeepItems({ db }, 'conv-a', 10, 10) === 0, 'memory 没有 bumpDeepHit ⇒ 0,不抛');
  check(adoptDeepItems(mem, 'conv-a', 0, 0) === 0, '区间非法(0)⇒ 0');
  check(adoptDeepItems(mem, '', 10, 10) === 0, 'conv 为空 ⇒ 0');
  check(adoptDeepItems(mem, 'conv-a', 'abc', 10) === 0, '非数区间 ⇒ 0');
  db.close();
}

// 8) 1.6.2:超时(把"不可中断"从根上消掉)+ 本会话排最后 + 超时回执
//
// 为什么这一节必须有断言:宿主的懒对账一旦卡住,`searchSessions` **不会返回**,而 GUI 没有中断入口
// (实测挂过约 30 分钟)。这里的判据**坏了不会有人喊** —— 工具只会静静地又挂一次,而那是
// "控制权被拿走"一级的问题。所以三条各自钉死:超时值、超时形态、超时时**条目照样交出去**。
{
  check(SEARCH_TIMEOUT_MS === 20000, '★ 超时上限是主人拍的 20 秒(改它要连注释与 README 一起改)');
  check(SEARCH_HITS_DEFAULT === 5, '★ 原文层默认 5 条(1.6.2 由 10 收窄:别让它淹掉条目层)');

  // 8a) 正常完成 ⇒ 原值透传
  const fast = await withTimeout(Promise.resolve('v'), 200, 'x');
  check(fast.ok === true && fast.value === 'v', 'withTimeout:正常完成 ⇒ 原值透传');

  // 8b) 超时 ⇒ 结构化结果,**不抛**
  const slow = await withTimeout(new Promise((r) => setTimeout(() => r('late'), 500)), 30, 'searchSessions');
  check(slow.ok === false && slow.reason === 'timeout' && slow.ms === 30,
    '★ withTimeout:超时 ⇒ {ok:false, reason:timeout}(同步 reject 或抛异常都会让模型那一步直接失败)');
  check(slow.label === 'searchSessions', '超时要带上是哪一路超的(排查时第一眼要看的就是这个)');

  // 8c) 底层后来完成了 ⇒ 结果被丢弃,但**不影响正确性**(检索是只读的)
  let landed = false;
  const got = await withTimeout(new Promise((r) => setTimeout(() => { landed = true; r('v'); }, 40)), 10, 'x');
  check(got.ok === false, 'withTimeout:到点就下结论(不等底层)');
  await new Promise((r) => setTimeout(r, 60));
  check(landed === true, '底层操作之后照旧跑完(只读 ⇒ 丢弃无害;别在这上面加"取消"的想象)');

  // 8d) 本会话排到最后 + 标 isSelf(不删)
  const hits = [
    { header: { id: 'me' }, bestMatch: { seq: 9, time: '2026-10-05 08:00:00', type: 'user/message', snippet: '刚说的话' } },
    { header: { id: 'old-1' }, bestMatch: { seq: 3, time: '2026-09-01 10:00:00', type: 'user/message', snippet: '当年的话' } },
  ];
  const r1 = toSearchRows(hits, { selfId: 'me' });
  check(r1.rows.length === 2, '两条都在(本会话**不删**,只挪位)');
  check(r1.rows[1].conv === 'me' && r1.rows[1].isSelf === true, '★ 本会话被排到最后并标 isSelf');
  check(r1.rows[0].conv === 'old-1' && r1.rows[0].isSelf === false, '历史命中保持在前(稳定排序,不打乱宿主原序)');
  const r2 = toSearchRows(hits, { selfId: '' });
  check(r2.rows[0].conv === 'me' && !r2.rows[0].isSelf, '不给 selfId ⇒ 顺序与标注都不动(旧调用点零影响)');

  // 8e) 回执:标注 + 超时文案(超时≠没找到,两者下一步动作不同)
  const withSelf = renderSearch({ ok: true, q: 'x', all: false, deep: [], skipped: 0, rows: r1.rows });
  check(withSelf.includes('← 本会话'), '★ 回执标出「← 本会话」(别把刚说的当成"当年说过的话"引用)');

  const timedOutDeep = renderSearch({
    ok: true, q: 'x', all: false, skipped: 0, rows: [], timedOut: true, timeoutMs: SEARCH_TIMEOUT_MS,
    deep: [{ kind: '承诺', text: '一条结论', conv_id: 'c1' }],
  });
  check(timedOutDeep.includes('原文层超时'), '★ 超时要明说(不许说成"没找到")');
  check(timedOutDeep.includes('条目层是本地库'), '★ 超时也要说清"条目层不受影响" —— 手上有东西可用');
  check(timedOutDeep.includes('一条结论'), '超时回执里条目照常给出来');

  const timedOutEmpty = renderSearch({ ok: true, q: 'x', all: false, skipped: 0, rows: [], deep: [], timedOut: true, timeoutMs: 20000 });
  check(timedOutEmpty.includes('没跑完'), '★ 两层都空 + 超时 ⇒ 说"没跑完",不许说成"没找到"');
  check(!timedOutEmpty.includes('按内容没找到'), '超时不许落进"没找到"的旧文案(那是另一种结论)');
}

// ── 9) 本地原文层 + **本会话默认排除**(2026-10-05 夜 · 主人拍板)──────────────────────
//   为什么值得单列一组:这是"①档默认走哪条路"与"谁的命中不算命中"两条**返回面语义**,
//   错了不会抛异常 —— 只会在主人眼前变成"前几条全是今天和昨天"(他截图报过的那个症状)。
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE dsh_turns_raw (session_id TEXT, seq INTEGER, role TEXT, ts TEXT, text TEXT)');
  const ins = db.prepare('INSERT INTO dsh_turns_raw VALUES (?,?,?,?,?)');
  ins.run('me', 1, 'user', '2026-10-05 20:00:00', '我在本会话说的检索');
  ins.run('me', 2, 'assistant', '2026-10-05 20:01:00', '本会话的另一句检索');
  ins.run('old', 5, 'user', '2026-09-01 10:00:00', '当年说过的检索');
  const mem = { db };

  const def = searchLocalTurns(mem, '检索', 10, { selfId: 'me' });
  check(def.rows.length === 1 && def.rows[0].conv === 'old',
    '★ 本会话**默认整条排除**(只剩历史那一条)—— 实际:' + JSON.stringify(def.rows.map((r) => r.conv)));
  check(def.selfExcluded === 2, '★ 被排除的条数如实报出(不然会被读成"库里只有这些")—— 实际:' + def.selfExcluded);

  const inc = searchLocalTurns(mem, '检索', 10, { selfId: 'me', includeSelf: true });
  check(inc.rows.length === 3 && inc.selfExcluded === 0, 'includeSelf=true ⇒ 全都在,且排除计数归零');
  check(inc.rows[2].conv === 'me' && inc.rows[2].isSelf === true, 'includeSelf 时本会话仍排在最后(顺序语义不变)');

  const noSelf = searchLocalTurns(mem, '检索', 10, {});
  check(noSelf.rows.length === 3 && noSelf.selfExcluded === 0, '不给 selfId ⇒ 谁都不排除(旧调用点零影响)');

  const txt = renderSearch({
    ok: true, q: '检索', all: false, local: true, deep: [], skipped: 0,
    rows: def.rows, selfExcluded: def.selfExcluded,
  });
  check(/另有 2 轮命中属于\*\*当前会话自己\*\*/.test(txt), '★ 回执说出"另有 N 轮是本会话、已排除"(不说就是假装搜过了)');
  const txt2 = renderSearch({
    ok: true, q: '检索', all: false, local: true, deep: [], skipped: 0, rows: def.rows, selfExcluded: 0,
  });
  check(!/另有/.test(txt2), '没有排除时不印那句(免得每次都多一段噪音)');

  check(SEARCH_LOCAL_TURNS_MAX >= SEARCH_HITS_MAX, '本地层上限不低于宿主层(否则同一个 limit 在两条路上含义不同)');

  // ⚠️ 2026-10-05 夜**真机抓到的疏漏**:**只有条目、原文 0 条**时 head 走另一支,那里漏了来源标注 ——
  //   而"原文被排除成 0 条"恰好是最容易落进这一支的情形(真机搜「检索」就是这样:7 条条目 + 0 轮原文)。
  const onlyDeep = renderSearch({
    ok: true, q: '检索', all: false, local: true, rows: [], skipped: 0, selfExcluded: 3,
    deep: [{ kind: '事实', text: 'x', conv_id: 'c' }],
  });
  check(/本机库内原文层/.test(onlyDeep), '★ 只有条目时也要标原文来源(否则默认路的覆盖范围无人知晓)');
  check(/另有 3 轮/.test(onlyDeep), '只有条目时"已排除 N 轮"照样要说');
  db.close();
}

console.log(ok ? '✓ recall-search 全部通过' : '✗ recall-search 有失败项');
process.exit(ok ? 0 : 1);
