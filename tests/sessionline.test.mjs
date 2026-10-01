// E0「那一行跟着会话走」(session-line):纯函数决策表 + IO 半 + handler 顺序纪律。
// 钉住的裁定:形态 A 只追不替 / 内容 = 标题 + 最新进展 + 自标识序号 /
//             档位 = **D+C**(只在 step===1 的轮次边界考虑 + 内容真变了才追加;旧 T/K 双门已废)/
//             内容闸三判据(逐字节原文 / lastMd5 / 实质键) / 面上没有我们的行时必须补一条 /
//             dupes 只留痕不写历史 / `sessionLinePreview` 纯只读且判定不依赖 turn。
//   + 2026-10-01:内容闸那三条**只有一处实现**(`contentChanged`),写路径与预览**共用** ——
//     预览曾少一条(md5)⇒ 同一份状态两种读数(见 §19);E1 的两处 `TITLE_MAX_CHARS` 是**不同语义**
//     (生成上限 vs 显示兜底),不统一,但有"显示兜底 ≥ 生成上限"的不变式(见 §18)。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  SESSION_LINE_SOURCE, TIER_MS_DEFAULT, TIER_TURNS_DEFAULT, LINE_MAX_CHARS, PROGRESS_MAX_CHARS, TITLE_MAX_CHARS,
  KV_LAST, KV_COUNTS, KV_DUPES, KV_ERR,
  progressLine, buildSessionLineText, scanSessionLineSurface, tierPass, decideSessionLine, md5,
  progressKey, contentChanged, maybeSessionLine, createSessionLineHandler, sessionLineProbe, sessionLineState,
  sessionLinePreview,
} = await imp('lib/host/session-line.js');
const { selectL1 } = await imp('lib/host/l1.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const SID = 'session-1234abcd-0000-0000-0000-000000000000';
const TITLE = '弹簧落地模拟';
const USER_TEXT = '把弹簧的阻尼再调大一档试试。';
const NOW = 1800000000000;
const sec = (n) => NOW + n;

const fakeMemory = ({ title = TITLE } = {}) => {
  const kv = new Map();
  return {
    kv,
    kvGet: (k) => (kv.has(k) ? kv.get(k) : undefined),
    kvSet: (k, v) => kv.set(String(k), String(v)),
    kvList: (prefix = '') => [...kv.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, value]) => ({ key, value })),
    overviewById: (src, cid) => (src === 'dsh' && cid === SID && title ? { title } : null),
  };
};
const userMsg = (text = USER_TEXT) => ({ id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
const payloadOf = ({ agent, turn = 15, step = 1, messages = [userMsg()], aborted = false } = {}) =>
  ({ agent, messages, turn, step, signal: { aborted } });
const fakeAgent = ({ nodes = [], events = {}, header = {} } = {}) => ({
  session: { id: SID, header, surface: { nodes }, eventAt: (seq) => events[seq] },
});
const ourEvent = (text) => ({ type: 'user/message', data: { id: 'l1', role: 'user', source: { kind: SESSION_LINE_SOURCE }, content: [{ type: 'text', text }] } });
// 可变的活面(模拟宿主把我们的消息真追加进日志后,那一行出现在面上)
const liveAgent = () => {
  const surf = { nodes: [], events: {} };
  return {
    surf,
    agent: { session: { id: SID, header: {}, surface: surf, eventAt: (s) => surf.events[s] } },
    put(seq, text) { surf.events[seq] = ourEvent(text); surf.nodes = [seq]; },
    /** 往面上追加一条**真人**发言(解析预览场景要"面末条真人发言"当进展)。 */
    putUser(seq, text = USER_TEXT) {
      surf.events[seq] = { type: 'user/message', data: { id: 'u' + seq, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } };
      surf.nodes = seq > 0 && surf.nodes.includes(seq) ? surf.nodes : [...surf.nodes, seq];
    },
  };
};
const handler = (memory, settings = { get: () => ({ memory: { sessionProgressLine: true } }) }) =>
  createSessionLineHandler(memory, settings, {});
const enterNext = (messages = [userMsg()]) => async () => ({ kind: 'enter', messages });
/** kv 全量快照(键序 + 值逐字)—— 用来钉"只读预览确实一个字节都没写"。 */
const snapOf = (m) => JSON.stringify([...m.kv.entries()]);
/** 走一个真实轮次:调 handler 之后把**真的追加进日志的那一行放回面上**(宿主行为:下一轮就能扫到它)。
 *  返回 { appended(本次追加的正文|null), res, seq }。 */
const runTurn = async ({ h, live, memory, turn, messages = [userMsg()], base = 100 }) => {
  const res = await h(payloadOf({ agent: live.agent, turn, messages }), enterNext(messages));
  const msg = res.messages.find((m) => m?.source?.kind === SESSION_LINE_SOURCE);
  if (msg) {
    const seq = live.surf.nextSeq || base;
    live.surf.nextSeq = seq + 1;
    live.put(seq, msg.content[0].text);
    return { appended: msg.content[0].text, res, seq };
  }
  return { appended: null, res, seq: null };
};

// ---------------- 1. 纯函数:旧档位双门(**已废但仍保留算式**,不在决策路径上) ----------------
{
  const st = { at: NOW, turn: 5 };
  check(tierPass({ state: st, turn: 15, now: NOW + TIER_MS_DEFAULT }) === true, 'T 与 K 都过 ⇒ 过(算式未变,但没人再调它)');
  check(tierPass({ state: st, turn: 14, now: NOW + TIER_MS_DEFAULT }) === false, 'K 差一轮 ⇒ 不过');
  check(tierPass({ state: st, turn: 15, now: NOW + TIER_MS_DEFAULT - 1 }) === false, 'T 差 1ms ⇒ 不过');
  check(tierPass({ state: { at: NOW, turn: 40 }, turn: 15, now: NOW + TIER_MS_DEFAULT }) === false, '轮数回退(异常)⇒ 不过');
  check(tierPass({ turn: 15, now: NOW + TIER_MS_DEFAULT }) === true, '首轮无状态 ⇒ 按 0 起算,过');
  check(typeof TIER_MS_DEFAULT === 'number' && typeof TIER_TURNS_DEFAULT === 'number', '常量仍导出(有测试/文档引用)');
}

// ---------------- 2. 纯函数:「最新进展」首句 ≤40 字 ----------------
{
  const p = progressLine('第一句。第二句不该出现');
  check(p === '第一句。', '按句读截断: ' + p);
  const long = progressLine('把弹簧的阻尼再调大一档试试然后看看落点偏移量是不是收敛到两厘米以内并且记录每一次的峰值位置');
  check(long.length <= PROGRESS_MAX_CHARS, '首句 ≤40 字(实长 ' + long.length + ')');
  check(long.endsWith('…'), '超长时标省略号: ' + long);
  check(progressLine('  多个   空白\n换行 ') === '多个 空白 换行', '折空白');
  check(progressLine('') === '', '空文本 ⇒ 空');
}

// ---------------- 3. 纯函数:整行公式 / 110 字上限 / turn 缺失时省略轮次段 ----------------
{
  const t = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), turn: 12, ordinal: 3, at: new Date(2026, 0, 2, 9, 30).getTime() });
  check(t.startsWith('[本次会话·进展 #3] '), '#N 自标识序号: ' + t);
  check(t.includes(' —— 最近:把弹簧的阻尼再调大一档试试。'), '标题 —— 最近:首句');
  check(t.includes(' · 第 12 轮 · 09:30'), '轮次 + HH:MM');
  const fat = buildSessionLineText({ title: '标'.repeat(200), progress: '进'.repeat(200), turn: 123, ordinal: 9, at: NOW });
  check(fat.length <= LINE_MAX_CHARS, '整行 ≤110 字(实长 ' + fat.length + ')');
  check(buildSessionLineText({ title: '', progress: '', turn: 1, ordinal: 1 }) === '', '标题与进展皆空 ⇒ 空(绝不写空文本)');
  // turn 缺失 ⇒ 省略轮次段(绝不写"第 0 轮"这种假读数)
  // ⚠️ 末段的 HH:MM 是 `at` 的**本机时区**渲染(`lib/host/session-line.js:87` 用的是
  //    getHours/getMinutes,即本机时区,不是 UTC),所以这里不能拿"固定的 UTC 毫秒"当 `at`:
  //    NOW = 1800000000000 = 2027-01-15T08:00:00Z,在开发机(Asia/Shanghai)渲染成 16:00、
  //    在 CI 的 ubuntu 跑器(UTC)渲染成 08:00 ⇒ 写死 ` · 16:00` 等于把开发机时区当成常量
  //    (2026-10-01 SEG 30 红的就是这一条)。改用与本节第一行 `new Date(2026, 0, 2, 9, 30)`
  //    同一手法:由**本机本地时间分量**构造 `at`,于是 ` · 16:00` 在任何时区都成立,
  //    且仍是逐字比对(不放宽成"含某个 HH:MM"就算过)。
  const AT_LOCAL_1600 = new Date(2026, 0, 2, 16, 0).getTime();
  const noTurn = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), ordinal: 2, at: AT_LOCAL_1600 });
  check(!noTurn.includes('轮'), 'turn 缺失 ⇒ 不含轮次段: ' + noTurn);
  check(!noTurn.includes('第 0 轮'), 'turn 缺失 ⇒ 绝不出现「第 0 轮」');
  check(noTurn.includes(TITLE) && noTurn.includes(' · 16:00'), 'turn 缺失 ⇒ 仍有标题 + HH:MM');
  const zero = buildSessionLineText({ title: TITLE, progress: '', turn: 0, ordinal: 1, at: NOW });
  check(!zero.includes('第 0 轮'), 'turn=0 同样按缺失处理(不写「第 0 轮」)');
  const neg = buildSessionLineText({ title: TITLE, progress: '', turn: -3, ordinal: 1, at: NOW });
  check(!neg.includes('第 -3 轮') && !neg.includes('第 0 轮'), '非法 turn ⇒ 同样省略');
}

// ---------------- 4. 纯函数:决策表逐行(D+C 版) ----------------
{
  const on1 = { count: 1 };
  const mLast = md5('old');
  check(decideSessionLine({ onSurface: { count: 0 }, candidate: 'x' }).reason === 'absent', '面上没有我们的行 ⇒ 追加(absent)');
  check(decideSessionLine({ onSurface: { count: 0 }, candidate: 'same-as-last', changed: false }).action === 'append', '面上没有 + 内容与 lastMd5 相同 ⇒ 仍追加(折叠吞了要补)');
  check(decideSessionLine({ onSurface: on1, candidate: 'old', lastMd5: mLast, changed: false }).reason === 'same', '面上有 + 内容没变 ⇒ 不追加(same)');
  check(decideSessionLine({ onSurface: on1, candidate: 'new', lastMd5: mLast, changed: true }).reason === 'ok', '面上有 + 内容变了 ⇒ 追加(ok)');
  check(decideSessionLine({ onSurface: { count: 2 }, candidate: 'new', changed: true }).reason === 'dupes', '面上 >1 条 ⇒ dupes(不作废、不写)');
  check(decideSessionLine({ onSurface: { count: 0 }, candidate: '' }).reason === 'empty', '候选为空 ⇒ 绝不写空文本');
  check(decideSessionLine({ onSurface: { count: 1 }, candidate: '' }).reason === 'empty', '候选为空压过 same(顺序:dupes > empty > absent)');
  check(decideSessionLine({ onSurface: on1, candidate: 'new', tierOk: false }).reason === 'ok', '旧 tierOk 参数已无意义:不再产生 tier 分支');
  check(progressKey(TITLE, '甲') !== progressKey(TITLE, '乙'), '实质键随进展变');
  check(progressKey(TITLE, '甲') === progressKey(TITLE, '甲'), '同一份内容 ⇒ 同一个键');
}

// ---------------- 5. 纯函数:扫面(认出自己 / 真人) ----------------
{
  const events = {
    2: ourEvent('旧行'),
    3: { type: 'assistant/message', data: { content: [{ type: 'text', text: '模型的废话' }] } },
    4: { type: 'user/message', data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '真人甲' }] } },
    5: { type: 'user/message', data: { id: 'p', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '插件注入' }] } },
    9: ourEvent('新行'),
  };
  const s = scanSessionLineSurface([2, 3, 4, 5, 9], (seq) => events[seq]);
  check(s.count === 2 && s.lastSeq === 9 && s.lastText === '新行', '认出自己那几条 + 末条文本');
  check(s.firstUser === '真人甲' && s.latestUser === '真人甲', '只把 kind=user 当真人发言');
  check(s.count === 2 && !JSON.stringify(s).includes('插件注入'), '插件注入不参与扫描');
}

// ---------------- 6. IO 半:面上没有我们的行 ⇒ 追加(即使内容与 kv 记的相同) ----------------
{
  const memory = fakeMemory();
  const agent = fakeAgent({ nodes: [], events: {} });
  const r = maybeSessionLine({ memory, agent, payload: payloadOf({ agent }), stateMap: new Map(), now: NOW });
  check(r.action === 'append' && r.reason === 'absent', '空面 ⇒ 追加(实为 ' + r.reason + ')');
  check(r.message?.source?.kind === SESSION_LINE_SOURCE && r.message?.role === 'user', '消息形状:role=user + 我们自己的 source.kind');
  check(Array.isArray(r.message?.content) && r.message.content[0].text === r.text, 'content 是块数组(平台强制)');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).chars === r.text.length, 'kv last 留痕 chars');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).append === 1, 'kv counts.append=1');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).md5 === md5(r.text), 'kv last.md5 = md5(正文)(内容闸基准)');
  check(!!JSON.parse(memory.kvGet(KV_LAST + SID)).key, 'kv last.key = 实质内容键(内容闸基准之二)');
  // 折叠把我们的行吞掉(面上 count=0),但 kv 记着的 md5/键都与本次候选相同 ⇒ 仍必须追加
  // (absent 分支**不经过**内容闸 —— 它被折叠吞了,补一条是对的)
  const expect = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), turn: 15, ordinal: 1, at: NOW });
  const lost = {
    at: NOW - TIER_MS_DEFAULT, turn: 5, appendCount: 0, text: expect, md5: md5(expect),
    key: progressKey(TITLE, progressLine(USER_TEXT)), seq: null,
  };
  memory.kvSet(KV_LAST + SID, JSON.stringify(lost));
  const r2 = maybeSessionLine({
    memory, agent, payload: payloadOf({ agent }), stateMap: new Map([[SID, lost]]), now: NOW,
  });
  check(r2.action === 'append' && r2.text === expect, '面上没有我们的行 + 内容与记录相同 ⇒ 照样追加');
}

// ---------------- 7. IO 半:D+C —— 内容变了立刻追加 / 内容没变不追加 / 时间不是判据 ----------------
{
  const { agent, put } = liveAgent();
  const memory = fakeMemory();
  const stateMap = new Map();
  // 首轮:面上还没有我们的行 ⇒ 追加,然后**模拟宿主把它追加进日志**(面上出现那一行)
  const first = maybeSessionLine({ memory, agent, payload: payloadOf({ agent, turn: 15 }), stateMap, now: NOW });
  check(first.action === 'append' && first.ordinal === 1, '首轮空面 ⇒ 追加 #1');
  put(7, first.text);
  // ① 面上有 + 内容真变了(最新进展换了)⇒ 立刻追加(**不再看 15 分钟 / 10 轮**)
  const t1 = maybeSessionLine({
    memory, agent, payload: payloadOf({ agent, turn: 16, messages: [userMsg('换了个话题:先看落点分布。')] }), stateMap, now: NOW + 1000,
  });
  check(t1.action === 'append' && t1.ordinal === 2, '① 内容变了 ⇒ 立刻追加(实为 ' + t1.reason + ')');
  check(t1.reason === 'ok', '① 走的是 ok 分支(不是旧 tier)');
  check(first.text.includes('#1] ') && t1.text.includes('#2] '), '① #N 序号递增');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).appendCount === 2, '① kv last.appendCount=2');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).replaceCount === 0, '① 形态 A:replaceCount 恒 0');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).seq === null, '① 新追加的 seq 未知 ⇒ 留 null,下一轮自愈');
  // ② 只有 1 秒过去、内容一字未变(同 turn、同 now)⇒ 不追加
  const at2 = NOW + 2000;
  const sameText = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), turn: 16, ordinal: 3, at: at2 });
  put(7, sameText);
  const sameSt = {
    at: at2, turn: 16, appendCount: 2, text: sameText, md5: md5(sameText),
    key: progressKey(TITLE, progressLine(USER_TEXT)), seq: 7,
  };
  memory.kvSet(KV_LAST + SID, JSON.stringify(sameSt));
  const same = maybeSessionLine({ memory, agent, payload: payloadOf({ agent, turn: 16 }), stateMap: new Map([[SID, sameSt]]), now: at2 });
  check(same.action === 'skip' && same.reason === 'same', '② 内容没变(原文/md5/实质键都相同)⇒ 不追加(实为 ' + same.reason + ')');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedSame === 1, '② skippedSame 计数 = 1(语义:内容闸挡下)');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedTier === 0, '② skippedTier 不再有写入点(档位已撤)');
  check(JSON.parse(memory.kvGet(KV_LAST + SID)).text === sameText, '② 内容闸不改 kv last');
  // ③ 时间门确已撤除:同一份状态、把 now 挪后 150 分钟(上次追加也在 150 分钟前)⇒ 判据仍只看内容
  const staleSt = { ...sameSt, at: NOW - 10 * TIER_MS_DEFAULT };
  const stale = maybeSessionLine({
    memory, agent, payload: payloadOf({ agent, turn: 16 }), stateMap: new Map([[SID, staleSt]]), now: NOW + 10 * TIER_MS_DEFAULT,
  });
  check(stale.action === 'skip' && stale.reason === 'same', '③ 挪后 150 分钟但内容没变 ⇒ 仍不追加(时间不是判据)');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedSame === 2, '③ 又记一次 skippedSame(=2)');
  // ④ 面上有 + 内容变了 ⇒ 追加 ok(注意:ordinal 沿用记录里的 appendCount+1;
  //    "内容变了"= 实质键变了或逐字节变了 —— 这里把进展换成另一句)
  put(7, '很久以前的那一行');
  const kvNow = JSON.parse(memory.kvGet(KV_LAST + SID));
  const diff = maybeSessionLine({
    memory,
    agent,
    payload: payloadOf({ agent, turn: 16, messages: [userMsg('第九次试验:记录峰值位置。')] }),
    stateMap: new Map([[SID, kvNow]]),
    now: sec(3),
  });
  check(diff.action === 'append' && diff.reason === 'ok', '④ 面上有 + 内容变了 ⇒ 追加(ok)(ordinal=' + diff.ordinal + ')');
}

// ---------------- 8. IO 半:dupes(脏状态只留痕,不写历史) ----------------
{
  const memory = fakeMemory();
  const agent = fakeAgent({ nodes: [1, 2], events: { 1: ourEvent('甲'), 2: ourEvent('乙') } });
  const r = maybeSessionLine({ memory, agent, payload: payloadOf({ agent }), stateMap: new Map(), now: NOW });
  check(r.action === 'skip' && r.reason === 'dupes', '面上 >1 条 ⇒ 不写历史');
  check(!!memory.kvGet(KV_DUPES + SID), 'kv sessline.dupes.<sid> 留痕');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).dupes === 1, 'counts.dupes=1');
  check(memory.kvGet(KV_LAST + SID) === undefined, 'dupes 不动 kv last(零写历史)');
}

// ---------------- 9. IO 半:seq 自愈(不动 appendCount,实质键从面上反解) ----------------
// ⚠️ 面上那条的实质内容(标题+进展)与本次候选相同(只换了轮次号)⇒ 内容闸判"没变"。
{
  const { agent, put } = liveAgent();
  const memory = fakeMemory();
  const at = NOW + 2 * TIER_MS_DEFAULT;
  const oldText = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), turn: 20, ordinal: 1, at });
  put(4, oldText);
  const st = { at, turn: 20, appendCount: 1, seq: null, text: '', md5: '', key: '' };
  const r = maybeSessionLine({
    memory, agent, payload: payloadOf({ agent, turn: 21 }), stateMap: new Map([[SID, st]]), now: at,
  });
  const last = JSON.parse(memory.kvGet(KV_LAST + SID));
  check(last.seq === 4, 'seq 自愈补记为面上那条的 seq');
  check(last.text === oldText, 'kv last.text 对齐面上那条(留痕可读)');
  check(!!last.key, 'kv last.key 从面上正文反解出来(老记录也能补上实质键)');
  check(r.action === 'skip' && r.reason === 'same', '实质内容没变(只换轮次号)⇒ 不追加(实为 ' + r.reason + ')');
  check(st.appendCount === 1, '自愈**不动** appendCount(否则 #N 被顶一格 ⇒ 闸门失效)');
  check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedSame === 1, '记在 skippedSame');
}

// ---------------- 10. handler 顺序:① 委托 ② reject 零写 ③ 闸门 ----------------
{
  const memory = fakeMemory();
  const h = handler(memory);
  let calls = 0;
  const rej = await h(payloadOf({ agent: fakeAgent() }), async () => { calls += 1; return { kind: 'reject' }; });
  check(rej.kind === 'reject' && calls === 1, 'reject ⇒ 原样返回且 next 只调一次');
  check(memory.kv.size === 0, 'reject ⇒ 零写操作');
  const noState = fakeMemory();
  const h2 = handler(noState);
  await h2(payloadOf({ agent: fakeAgent(), step: 2 }), enterNext());
  await h2(payloadOf({ agent: fakeAgent(), messages: [] }), enterNext([]));
  check(noState.kv.size === 0, 'step!==1 与空批次(messages=[])⇒ 不追加(空批次首步会直接收轮)');
  const thrown = await handler(fakeMemory())(payloadOf({ agent: fakeAgent() }), async () => { throw new Error('downstream'); })
    .then(() => null, (e) => e);
  check(thrown instanceof Error && thrown.message === 'downstream', 'next 抛错 ⇒ 原样抛出(不吞、不兜底)');
}

// ---------------- 11. handler:范围过滤 / 开关 / aborted / startsRequestSeries ----------------
{
  const run = async ({ header, aborted = false, settings, next } = {}) => {
    const memory = fakeMemory();
    const agent = fakeAgent({ nodes: [], events: {}, header });
    const d = next ? await next() : { kind: 'enter', messages: [userMsg()] };
    const res = await handler(memory, settings)(payloadOf({ agent, aborted }), async () => d);
    return { memory, res, d };
  };
  const sub = await run({ header: { origin: 'subagent' } });
  check(sub.memory.kv.size === 0 && sub.res.messages.length === 1, '子代理 ⇒ 不注入');
  const unk = await run({ header: null });
  check(unk.memory.kv.size === 0, '取不到 header(unknown)⇒ 不注入');
  const fork = await run({ header: { parentSession: 'session-parent' } });
  check(fork.memory.kv.size > 0 && fork.res.messages.length === 2, '分叉会话 ⇒ 照常追加');
  check(fork.res.messages[1].source.kind === SESSION_LINE_SOURCE, '追加的就是我们那条');
  const off = await run({ settings: { get: () => ({ memory: { sessionProgressLine: false } }) } });
  check(off.memory.kv.size === 0 && off.res.messages.length === 1, '开关关闭 ⇒ 不追加(免重启回退)');
  const ab = await run({ aborted: true });
  check(ab.memory.kv.size === 0, 'signal.aborted ⇒ 不写');
  const sr = await run({ next: async () => ({ kind: 'enter', messages: [userMsg()], startsRequestSeries: true }) });
  check(sr.res.startsRequestSeries === true, '改写批次必须保留 startsRequestSeries');
  check(sr.res !== sr.d && sr.d.startsRequestSeries === true, '返回新对象(不就地改下游的 decision)');
}

// ---------------- 12. handler:业务异常 ⇒ 留证 + 退化成"不注入",绝不再调 next ----------------
{
  const memory = fakeMemory();
  const memoryBroken = { ...memory, kvGet: () => { throw new Error('boom'); } };
  let calls = 0;
  const res = await handler(memoryBroken)(payloadOf({ agent: fakeAgent({ nodes: [], events: {} }) }), async () => { calls += 1; return { kind: 'enter', messages: [userMsg()] }; });
  check(res.kind === 'enter' && res.messages.length === 1, '业务异常 ⇒ 退化成不注入(该轮照常走)');
  check(calls === 1, 'catch 里绝不再调 next()(waterfall 会重跑下游链)');
  check(String(memory.kvGet(KV_ERR) || '').includes('boom'), '异常留证 sessline.err');
}

// ---------------- 13. 同轮重入 / 换轮 / 跨重启:内容闸的真实边界 ----------------
{
  const live = liveAgent();
  const memory = fakeMemory();
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const h = handler(memory);
    const first = await runTurn({ h, live, memory, turn: 15 });
    check(!!first.appended && first.appended.includes('#1'), '① 首轮(空面)⇒ 追加 #1');
    const k = JSON.parse(memory.kvGet(KV_LAST + SID));
    check(typeof k.at === 'number' && k.at > 0 && k.turn === 15, '① kv last 记下 at/turn');
    check(k.md5 === md5(first.appended), '① kv last.md5 = md5(追加的正文)');
    const again = await runTurn({ h, live, memory, turn: 15 });
    check(again.appended === null, '② 同一轮内同参重进 ⇒ 不追加(内容闸,不是档位)');
    check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedSame === 1, '② 记在 skippedSame(=1)');
    check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedTier === 0, '② skippedTier 恒 0(档位已撤)');
    // ③ 换轮但真人发言没变 ⇒ 判"内容没变" ⇒ 不追加(轮次号只是格式位,不算内容)
    const b0 = await runTurn({ h, live, memory, turn: 16 });
    check(b0.appended === null, '③ 换轮但发言未变 ⇒ 不追加(实质内容没变)');
    // ④ 换轮 + 发言变了 ⇒ 追加 #2
    const b = await runTurn({ h, live, memory, turn: 17, messages: [userMsg('换个方向:先看阻尼比。')] });
    check(!!b.appended && b.appended.includes('#2'), '④ 换轮 + 发言变了 ⇒ 追加 #2');
    check(JSON.parse(memory.kvGet(KV_LAST + SID)).appendCount === 2, '④ 续号递增到 2,不重置');
    // ⑤ 重启(新 handler)+ 同轮同参 ⇒ 仍不追加(判据从 kv 读回后照旧生效)
    const h2 = handler(memory);
    const c = await runTurn({ h: h2, live, memory, turn: 17, messages: [userMsg('换个方向:先看阻尼比。')] });
    check(c.appended === null, '⑤ 重启后同轮同参 ⇒ 不追加(判据从 kv 读回)');
    check(JSON.parse(memory.kvGet(KV_LAST + SID)).appendCount === 2, '⑤ 序号没被顶动');
    const d = await runTurn({ h: h2, live, memory, turn: 18, messages: [userMsg('再看一次峰值位置。')] });
    check(!!d.appended, '⑥ 重启后发言又变了 ⇒ 照常追加');
  } finally { Date.now = realNow; }
}

// ---------------- 14. 探针(挂 /health 与 /state) ----------------
{
  const live = liveAgent();
  const memory = fakeMemory();
  const h = handler(memory);
  const realNow = Date.now;
  Date.now = () => NOW; // 冻住钟:两次调用的时间片一致 ⇒ 候选正文逐字节相同 ⇒ 稳定走内容闸
  try {
    const r = await runTurn({ h, live, memory, turn: 15 });
    check(!!r.appended, '首轮 ⇒ 追加');
    const again = await runTurn({ h, live, memory, turn: 15 });
    check(again.appended === null, '同轮同参再走一次 ⇒ 不追加(内容闸)');
  } finally { Date.now = realNow; }
  const probe = sessionLineProbe(memory, { limit: 8 });
  check(probe.totals.sessions === 1 && probe.totals.append === 1 && probe.totals.skippedSame === 1, '探针汇总:1 次追加 + 1 次内容闸跳过');
  check(probe.totals.skippedTier === 0, '探针 skippedTier 恒 0(档位已撤,不再有写入点)');
  check(probe.sessions[0].sessionId === SID && probe.sessions[0].last.text.includes(TITLE), '探针按会话列出最近一条活行文本');
  check(probe.sessions[0].last.key === JSON.parse(memory.kvGet(KV_LAST + SID)).key, '探针带出实质键 key');
  check(probe.tier.ms === TIER_MS_DEFAULT && probe.tier.turns === TIER_TURNS_DEFAULT, '探针仍带档位常量(引用未断)');
  check(probe.tier.active === false && probe.tier.gate === 'D+C', '探针明确标出:旧档位不在生效 + 现行档位是 D+C');
  const one = sessionLineState(memory, SID);
  check(one.counts.append === 1 && one.last.chars > 0, '/state 侧探针可读');
  check(one.tier.active === false, '/state 侧同样标出档位已废');
  check(one.tierActive === false, '/state 侧顶层也带 tierActive:false(一眼看出档位不在生效)');
  check(sessionLineState(memory, '') === null, '无会话 id ⇒ null(不抛)');
}

// ---------------- 15. 同批改动:`[记忆·开场]` 里本会话自己那一行只留标题 ----------------
{
  const iso = new Date(Date.now() - 864e5).toISOString();
  const rows = [{
    conv_id: SID, source: 'dsh', title: TITLE, summary: TITLE + ' — 4 条消息', category: 'knowledge',
    domain_tags: ['知识'], keywords: [], updated_at: iso, started_at: iso, importance: 0, hit_count: 0, overview_ok: 1,
  }];
  const store = { listOverviews: () => rows };
  const self = selectL1(store, { mode: 'work', maxItems: 8, budgetChars: 4000, sessionId: SID });
  check(self.items[0].line.includes(TITLE) && !self.items[0].line.includes('4 条消息'), '当前会话自己那一行:只留标题,去掉摘要');
  check(!self.items[0].line.includes('——'), '不再出现「标题 —— 摘要」的同源双印');
  const other = selectL1(store, { mode: 'work', maxItems: 8, budgetChars: 4000, sessionId: 'session-ffffffff-0000-0000-0000-000000000000' });
  check(other.items[0].line.includes('4 条消息'), '别的会话照旧带摘要(零回归)');
  const legacy = selectL1(store, { mode: 'work', maxItems: 8, budgetChars: 4000 });
  check(legacy.items[0].line.includes('4 条消息'), '不传 sessionId ⇒ 旧行为不变(向后兼容)');
}

// ---------------- 16. D 闸(轮次边界)与业务异常:handler 侧两条硬纪律 ----------------
{
  // ① step===1 + 内容变了 ⇒ 追加;step===1 + 内容没变 ⇒ 不追加
  const live = liveAgent();
  const memory = fakeMemory();
  const h = handler(memory);
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const a = await runTurn({ h, live, memory, turn: 15 });
    check(!!a.appended && a.appended.includes('#1'), '① step===1 首轮空面 ⇒ 追加');
    const b = await runTurn({ h, live, memory, turn: 16, messages: [userMsg('换个方向:先看阻尼比。')] });
    check(!!b.appended && b.appended.includes('#2'), '① step===1 + 内容变了 ⇒ 追加');
    check(b.appended.includes('换个方向'), '① 追加的正文里带上了最新进展');
    check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).append === 2, '① counts.append=2');
    const c = await runTurn({ h, live, memory, turn: 16, messages: [userMsg('换个方向:先看阻尼比。')] });
    check(c.appended === null && c.res.messages.length === 1, '② step===1 + 内容没变 ⇒ 不追加');
    check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).skippedSame === 1, '② counts.skippedSame=1');
    check(JSON.parse(memory.kvGet(KV_COUNTS + SID)).append === 2, '② 追加次数没涨');
  } finally { Date.now = realNow; }
  // ③ step!==1(轮次中段)⇒ 不追加、零写操作(轮次边界 D)
  {
    const memory = fakeMemory();
    const h = handler(memory);
    const r = await h(payloadOf({ agent: fakeAgent(), step: 2 }), enterNext());
    check(r.messages.length === 1 && memory.kv.size === 0, '③ step!==1 ⇒ 不追加且零写(实为 kv.size=' + memory.kv.size + ')');
    const r9 = await h(payloadOf({ agent: fakeAgent(), step: 9 }), enterNext());
    check(r9.messages.length === 1 && memory.kv.size === 0, '③ step===9 ⇒ 同样零写');
  }
  // ④ 业务异常 ⇒ 退化成不注入且不再调 next
  {
    const errMem = fakeMemory();
    let calls = 0;
    const res = await handler({ ...errMem, kvGet: () => { throw new Error('boom'); } })(
      payloadOf({ agent: fakeAgent({ nodes: [], events: {} }) }), async () => { calls += 1; return { kind: 'enter', messages: [userMsg()] }; },
    );
    check(res.messages.length === 1 && calls === 1, '④ 业务异常 ⇒ 不注入且 next 只调一次');
  }
}

// ---------------- 17. sessionLinePreview / sessionLineState:只读 + 判定不依赖 turn ----------------
{
  const memory = fakeMemory();
  const SETTINGS = { get: () => ({ memory: { sessionProgressLine: true } }) };
  // 空库:没有 last/counts、也没有会话面
  const before = snapOf(memory);
  const p0 = sessionLinePreview(memory, SETTINGS, SID, { turn: 15 });
  check(snapOf(memory) === before, '④ 预览前后 kv 快照逐字相同(空库)');
  check(p0.blocked === 'absent' && p0.wouldAppend === true && p0.ordinal === 1, '空库 ⇒ absent / wouldAppend / #1');
  check(p0.last === null && p0.counts.append === 0, '空库 ⇒ last=null,counts 全 0');
  // ② turn 缺失:不判 turn(结论一致),正文给 null(绝不"第 0 轮")
  const p0n = sessionLinePreview(memory, SETTINGS, SID, {});
  check(p0n.blocked === 'absent' && p0n.wouldAppend === true, '② turn 缺失 ⇒ 判定与给定时一致(absent)');
  check(p0n.text === null, '② turn 缺失 ⇒ text=null');
  // 有 last + 会话面
  // ⚠️ 预览的判定基准是"**不含轮次号**的那一行"(面板路径上没有 turn 来源)⇒ 这里用 `maybeSessionLine`
  //    造真实记录(它落盘的 `key` = 标题+进展,才是判据);面上那条也摆成无轮次版,便于逐字节那侧对上。
  const live = liveAgent();
  live.putUser(50, USER_TEXT);   // 预览的"最新进展"只能从面上来(handler 侧才从 payload 来)
  live.putUser(51, USER_TEXT);
  memory.session = live.agent.session; // ⚠️ 必须在 `maybeSessionLine` **之前**挂上:它也读面(scan.latestUser)
  const ST1 = { at: NOW, turn: 15, appendCount: 0, seq: null, text: '', md5: '', key: '' };
  const r1 = maybeSessionLine({
    memory, agent: live.agent, payload: payloadOf({ agent: live.agent, turn: 15 }), stateMap: new Map([[SID, ST1]]), now: NOW,
  });
  check(r1.action === 'append' && r1.ordinal === 1, '预览场景:先真追加一条 #1');
  const noTurnText = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), ordinal: 1, at: NOW });
  live.put(100, noTurnText); // 面末条 = 无轮次版(与预览的判定基准同形)
  const prevKey = JSON.parse(memory.kvGet(KV_LAST + SID)).key;
  check(!!prevKey, 'kv last 落了实质键(key)');
  memory.kvSet(KV_LAST + SID, JSON.stringify({
    at: NOW, turn: 15, appendCount: 1, seq: 100, text: noTurnText, md5: md5(noTurnText), key: prevKey,
  }));
  const before2 = snapOf(memory);
  const p1 = sessionLinePreview(memory, SETTINGS, SID, { turn: 15 });
  check(snapOf(memory) === before2, '④ 预览前后 kv 快照逐字相同(有 last + 有面)');
  check(p1.last?.md5 === md5(noTurnText), '预览带出 last.md5(与上次真追加一致)');
  check(p1.ordinal === 2, '预览 #2 = 上次 appendCount+1');
  check(p1.blocked === 'same' && p1.wouldAppend === false, '预览:内容没变 ⇒ blocked=same / 不会追加');
  check(typeof p1.text === 'string' && p1.text.includes(TITLE) && p1.text.includes('第 15 轮'), '预览正文按当前上下文算出(带标题 + 轮次)');
  const p1n = sessionLinePreview(memory, SETTINGS, SID, {});
  check(p1n.text === null && !String(p1n.text).includes('第 0 轮'), '② turn 缺失 ⇒ text=null,不出现「第 0 轮」');
  check(p1n.blocked === p1.blocked && p1n.wouldAppend === p1.wouldAppend, '②判定不依赖 turn(缺失与给定结果一致)');
  // /state 侧:富字段(委托预览),E3 的调用点一个字都不用改
  const st1 = sessionLineState(memory, SID);
  check(st1.last?.md5 === md5(noTurnText) && st1.counts.append === 1, 'sessionLineState 老字段照旧(last/counts)');
  check(st1.blocked === 'same' && st1.wouldAppend === false && st1.ordinal === 2, 'sessionLineState 带上富字段(判定读数不哑)');
  check(st1.text === null && st1.preview?.text === null, 'sessionLineState 不传 turn ⇒ text=null(不造假读数)');
  const st2 = sessionLineState(memory, SID, { turn: 15 });
  check(st2.text === st2.preview?.text && typeof st2.text === 'string' && st2.text.includes('第 15 轮'), 'sessionLineState(opts.turn) ⇒ 透传出正文');
  check(st2.blocked === 'same', 'sessionLineState(opts.turn) ⇒ 判定与不传时一致');
  const beforeState = snapOf(memory);
  sessionLineState(memory, SID, { turn: 15 });
  check(snapOf(memory) === beforeState, '④ sessionLineState(含富字段)同样零写 kv');
  // 内容变了(面上换一条新的真人发言)⇒ 预览说会追加
  const memory2 = fakeMemory();
  memory2.kvSet(KV_LAST + SID, memory.kvGet(KV_LAST + SID));
  memory2.kvSet(KV_COUNTS + SID, memory.kvGet(KV_COUNTS + SID));
  const { agent: agent2, put: put2 } = liveAgent();
  put2(5, noTurnText);
  memory2.session = {
    ...agent2.session,
    surface: { nodes: [4, 5] },
    eventAt: (s) => (s === 4
      ? { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '全新的方向:改看速度曲线。' }] } }
      : agent2.session.eventAt(s)),
  };
  const before3 = snapOf(memory2);
  const p2 = sessionLinePreview(memory2, SETTINGS, SID, { turn: 16 });
  check(snapOf(memory2) === before3, '④ 预览(内容变了那条路径)同样不写 kv');
  check(p2.text.includes('全新的方向'), '预览取面上末条真人发言当最新进展');
  check(p2.blocked === 'ok' && p2.wouldAppend === true, '预览:内容变了 ⇒ blocked=ok / 会追加');
  const p2n = sessionLinePreview(memory2, SETTINGS, SID, {});
  check(p2n.blocked === 'ok' && p2n.wouldAppend === true && p2n.text === null, '② 内容变了这条路径同样不依赖 turn');
  // 开关 / 无 id / 脏状态 / 读口全炸
  const off = sessionLinePreview(memory, { get: () => ({ memory: { sessionProgressLine: false } }) }, SID, { turn: 15 });
  check(off.blocked === 'disabled' && off.wouldAppend === false && off.text === null, '开关关闭 ⇒ blocked=disabled');
  const noId = sessionLinePreview(memory, {}, '', {});
  check(noId.blocked === 'empty' && noId.wouldAppend === false, '无会话 id ⇒ blocked=empty(不抛)');
  const dirty = fakeMemory();
  dirty.kvSet(KV_LAST + SID, JSON.stringify({ appendCount: 1, md5: 'x' }));
  dirty.session = { surface: { nodes: [1, 2] }, eventAt: (s) => ourEvent('第' + s + '条') };
  const pd = sessionLinePreview(dirty, {}, SID, { turn: 5 });
  check(pd.blocked === 'dupes' && pd.wouldAppend === false, '面上 >1 条 ⇒ blocked=dupes');
  const broken = { kvGet: () => { throw new Error('boom'); }, overviewById: () => { throw new Error('boom'); } };
  const pe = sessionLinePreview(broken, {}, SID, { turn: 5 });
  check(pe.blocked === 'empty' && pe.wouldAppend === false, '全部读口抛错 ⇒ 退化成"算不出",绝不抛到 HTTP 层');
  const brokenState = sessionLineState({ kvGet: () => { throw new Error('boom'); } }, SID, { turn: 5 });
  check(brokenState !== null && typeof brokenState === 'object', 'sessionLineState 读口抛错也不崩(实为 ' + (brokenState === null ? 'null' : 'object') + ')');
  check(sessionLineState(memory, '', { turn: 1 }) === null, 'sessionLineState 空 id ⇒ null(带 opts 也不炸)');
}

// ---------------- 18. E1:`TITLE_MAX_CHARS` 同名不同值 = **不同语义**(判定 + 不变式) ----------------
//   判定(2026-10-01):`retitle.js` 的那个是**生成上限**(`heuristicTitle` 切句读/硬截的落点 ——
//   它决定"机器造出来的标题最长多少字"),本模块这个是**显示兜底**(`resolveTitle` 把**任何来源**的标题
//   夹进那一行:除本机生成外还有源库自带标题、主人手改 ≤120)。两处的读者与方向都不同
//   ⇒ **不硬统一**(只补注释,见两个文件里的常量注释);但有一条不许破的不变式:
//   **显示兜底 ≥ 生成上限** —— 否则机器刚造出来的标题会在那一行里被再切一刀。
{
  const { TITLE_MAX_CHARS: GEN_MAX, heuristicTitle } = await imp('lib/host/retitle.js');
  const SETTINGS_E1 = { get: () => ({ memory: { sessionProgressLine: true } }) };
  check(typeof TITLE_MAX_CHARS === 'number' && typeof GEN_MAX === 'number',
    'E1 两处同名常量都可读(本模块 ' + TITLE_MAX_CHARS + ' / retitle ' + GEN_MAX + ')');
  check(TITLE_MAX_CHARS !== GEN_MAX,
    'E1 实测:**同名不同值**(' + TITLE_MAX_CHARS + ' vs ' + GEN_MAX + ')—— 属不同语义,不统一');
  check(TITLE_MAX_CHARS >= GEN_MAX,
    '★E1 不变式:显示兜底(' + TITLE_MAX_CHARS + ')必须 ≥ 生成上限(' + GEN_MAX + '),否则机器造的标题会在那一行里被再切一刀');
  // 生成侧:启发式造出来的标题不超生成上限
  const gen = heuristicTitle('把弹簧的阻尼再调大一档试试，然后看落点偏移量是不是收敛，再记录每一次的峰值位置与收敛速度，最后整理成一份对照表并复核一遍');
  check(!!gen && gen.length <= GEN_MAX, '★E1 生成侧:启发式标题不超生成上限(实测 ' + (gen || '').length + ' ≤ ' + GEN_MAX + ')');
  // 显示侧:兜底确实把 70 字标题夹到 60 字(超出留 …)—— 钉住"显示兜底"这个语义本身
  const LONG70 = '标'.repeat(70);
  const pvLong = sessionLinePreview(fakeMemory({ title: LONG70 }), SETTINGS_E1, SID, { turn: 4 });
  check(typeof pvLong.text === 'string' && pvLong.text.includes('标'.repeat(TITLE_MAX_CHARS - 1) + '…'),
    '★E1 显示兜底 = ' + TITLE_MAX_CHARS + ' 字(超出留 …;实测 ' + JSON.stringify(String(pvLong.text).slice(0, 24)) + ')');
  check(!String(pvLong.text).includes('标'.repeat(TITLE_MAX_CHARS)),
    '★E1 确实切了(那一行里不出现 ' + TITLE_MAX_CHARS + ' 个连续「标」)');
  // 两条路的值虽不同,却不冲突:生成上限以内的标题**逐字穿过**那道显示兜底
  const genTitle = '生'.repeat(GEN_MAX);
  const pvGen = sessionLinePreview(fakeMemory({ title: genTitle }), SETTINGS_E1, SID, { turn: 4 });
  check(String(pvGen.text).includes(genTitle),
    '★E1 生成上限以内(' + GEN_MAX + ' 字)的标题逐字穿过显示兜底(两条路不冲突)');
}

// ---------------- 19. C 组:预览与写路径的「内容真变了」判据**同一处**(不再各写一份) ----------------
//   旧状:`maybeSessionLine` 内联 3 条(逐字节 / md5 / 实质键),`sessionLinePreview` 只内联 2 条(缺 md5)
//   ⇒ 同一份状态能出现两种读数:kv 记着 md5 而 `last.text` **缺失**(或与 kv 那条不同源 —— 预览的
//     逐字节基准是"面上那条")时,预览说"会追加"、写路径判 same ⇒ **读数与行为不一致**。
//   修法:两条路都调 `contentChanged()`。下面既钉**调用点同源**(源码形态),也钉**行为一致**(含那个角落)。
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'lib/host/session-line.js'), 'utf8');
  check(/export function contentChanged\(/.test(src), '★C 判据只有一处实现(导出 contentChanged)');
  check(/const changed = contentChanged\(\{ candidate, lastText: st\.text/.test(src),
    '★C 源码形态:**写路径**走 contentChanged(不再内联三条)');
  check(/const judge = contentChanged\(\{/.test(src), '★C 源码形态:**预览**走同一个 contentChanged(不再内联两条)');
  check(!/const changed = !\(textUnchanged \|\|/.test(src), '★C 源码形态:写路径的旧内联判据已不存在');
  check(!/const textUnchanged = scan\.count === 1/.test(src), '★C 源码形态:预览的旧内联判据已不存在');
  // 单元:三条判据各自都能单独说"没变"(**缺任何一条**都会让两条路分叉)
  const cand = '候选正文';
  check(contentChanged({ candidate: cand }).changed === true, 'C 空记录 ⇒ 判"变了"');
  check(contentChanged({ candidate: cand, lastText: cand }).changed === false, 'C 判据①逐字节能挡');
  check(contentChanged({ candidate: cand, lastMd5: md5(cand) }).changed === false, 'C 判据②md5 能挡(**预览旧写法缺的就是这条**)');
  check(contentChanged({ candidate: cand, curKey: 'k', lastKey: 'k' }).changed === false, 'C 判据③实质键能挡');
  check(contentChanged({ candidate: cand, lastMd5: md5('别的') }).changed === true, 'C 负对照:md5 不同 ⇒ 仍判"变了"');

  // ── 角落:kv 有 md5、`text` 缺失(逐字节那条不参与)⇒ 两条路必须**同判 same** ──
  const SETTINGS_C = { get: () => ({ memory: { sessionProgressLine: true } }) };
  const realNow = Date.now;
  Date.now = () => NOW; // 冻住钟:预览与写路径的候选正文才逐字节可比
  try {
    const live = liveAgent();
    live.put(61, '上一次那条的正文(与本次候选不同 ⇒ 逐字节那条不参与)'); // ⚠️ 先摆我们的行(`put` 会把面重置成 [seq])
    live.putUser(60, USER_TEXT);                                        // 再追加真人发言 ⇒ nodes = [61, 60]
    // 预览的判定基准 = **无轮次版**正文(面板路径没有 turn)⇒ 两条路共用同一个串,才叫"同一输入"
    const judge = buildSessionLineText({ title: TITLE, progress: progressLine(USER_TEXT), ordinal: 2, at: NOW });
    // kv 记录:`text` 缺失、`md5` 尚存;`seq` 非 null ⇒ 不走 seq 自愈(自愈会用面上那条覆盖 md5)
    const st = { at: NOW, turn: 0, appendCount: 1, seq: 61, text: '', md5: md5(judge), key: '' };
    const memory = fakeMemory();
    memory.kvSet(KV_LAST + SID, JSON.stringify(st));
    memory.session = live.agent.session; // 预览只能从 `memory.session` 拿面
    const before = snapOf(memory);
    const pv = sessionLinePreview(memory, SETTINGS_C, SID, { turn: 0 });
    check(snapOf(memory) === before, 'C 预览仍零写 kv');
    const wr = maybeSessionLine({
      memory,
      agent: live.agent,
      payload: payloadOf({ agent: live.agent, turn: 0, messages: [userMsg(USER_TEXT)] }),
      stateMap: new Map([[SID, { ...st }]]),
      now: NOW,
    });
    check(pv.blocked === 'same' && pv.wouldAppend === false,
      '★★C 角落(text 缺失 + md5 尚存):**预览**判 same / 不追加(实测 blocked=' + pv.blocked + ';修前 = ok)');
    check(wr.action === 'skip' && wr.reason === 'same', '★★C 角落:**写路径**同样判 same(实测 ' + wr.action + '/' + wr.reason + ')');
    check(pv.blocked === wr.reason && pv.wouldAppend === (wr.action === 'append'),
      '★★C 两条路对**同一输入**给同一结论(' + pv.blocked + ' vs ' + wr.reason + ' / wouldAppend=' + pv.wouldAppend + ')');
    // 负对照:进展变了 ⇒ 两条路都必须说"追加"(证明上面不是"两边都恒判 same")
    const live2 = liveAgent();
    live2.put(61, '上一次那条的正文');
    live2.putUser(60, '全新的方向:改看速度曲线。');
    const memory2 = fakeMemory();
    memory2.kvSet(KV_LAST + SID, JSON.stringify(st));
    memory2.session = live2.agent.session;
    const pv2 = sessionLinePreview(memory2, SETTINGS_C, SID, { turn: 0 });
    const wr2 = maybeSessionLine({
      memory: memory2,
      agent: live2.agent,
      payload: payloadOf({ agent: live2.agent, turn: 0, messages: [userMsg('全新的方向:改看速度曲线。')] }),
      stateMap: new Map([[SID, { ...st }]]),
      now: NOW,
    });
    check(pv2.blocked === 'ok' && pv2.wouldAppend === true, 'C 负对照:进展变了 ⇒ 预览判 ok(实测 ' + pv2.blocked + ')');
    check(wr2.action === 'append' && wr2.reason === 'ok', 'C 负对照:进展变了 ⇒ 写路径判 ok(实测 ' + wr2.reason + ')');
    check(pv2.blocked === wr2.reason, 'C 负对照:两条路结论仍一致(' + pv2.blocked + ' vs ' + wr2.reason + ')');
  } finally { Date.now = realNow; }
}

console.log(ok ? '活行(session-line)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
