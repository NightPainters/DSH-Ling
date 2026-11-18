// 1.8.0 · N(自知通知)验收 —— DESIGN §3.4 的五条判据,全部落在**真实注入出口**上。
//
// 判据(与 DESIGN §3.4 一一对应):
//   A  无变更 ⇒ context 文本与**冻结基线**逐字节相同(时刻槽归一后)+ `[跨天]` 行原文 & sha256  (§3.4-1)
//   B  两种 kind 各 2 条 ⇒ 一行、按 kind 聚合、总数正确、C8 第 4 段                            (§3.4-2)
//   C  消费语义:context 投递即消费(再组装归零、不累加、新一轮从 1 起);section 渲染不消费      (§3.4-3)
//   C2 次序:section 先渲染、context 后组装 ⇒ `[自知]` 仍含(复审 G1 的正面用例)                  (§3.4-3)
//   D  `[自知]` 只走 context:断言打在**注册回调**上;section 先渲染也不吃账本                   (§3.4-5)
//   E  presence 抛错(取服务 / watch / recent / **监听器被派发时抛**)⇒ 只剩时钟文本,不抛        (§3.4-4)
//   F  全局槽 `*` 与两会话隔离:无 scope 的变更进本会话那一行;A 的行不含 B 的 kind               (§3.5/G3)
//   G  节间复位(G2):每节末尾 dispose(退订 + 清账本),下一节起手账本是空的
//
// ⚠️ 已知脆弱点(与 time-t2.0.test.mjs 同源,不是本文件引入):
//   1) `[现在]` 带时段词 + `HH:MM`、`[本场]` 带起算日:这些是**运行时刻**。A 节比较前用
//      `maskClock()` 只把**时刻槽**(时段词 / HH:MM / 月-日)归一成占位符,再与冻结表**按字节**比
//      —— 不做 trim、不做别的归一;`[跨天]` 整行完全确定,另有原文 + sha256 双钉。
//   2) 本套件**不碰**生产 `home\cache\dsh-ling\memory.db`:临时库走 mkdtempSync(同 presence.test.mjs:51)。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const { MemoryStore } = await imp('lib/host/memory.js');
const { timeAnchorLive, timeAnchorDate } = await imp('lib/host/clock.js');
const { neutralizeMustache } = await imp('lib/host/util.js');
const { wellFormed } = await imp('lib/host/rawlog.js');
const { registerMemorySection, renderMemorySection } = await imp('lib/host/inject.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(Object.is(a, b), `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
const section = (t) => console.log('── ' + t);

const dir = mkdtempSync(join(tmpdir(), 'ling-selfaware-'));
const mem = new MemoryStore(join(dir, 'm.db'));
// `timeAnchorLive` 直接读 settings.get();`renderMemorySection` 也读 settings.get()。
// 给空设置 ⇒ 称呼走中性措辞,期望文本完全确定(只考时间与 [自知],不考人格)。
const SETTINGS = { get: () => ({}) };

const asmTop = (sid) => ({ agent: { session: { id: sid, header: {} } } });
const asmSub = (sid) => ({ agent: { session: { id: sid, header: { origin: 'subagent' } } } });
const noticeLineOf = (t) => String(t).split('\n').find((l) => l.startsWith('[自知]')) || '';
const chunk = (t) => t.split('\n').filter((l) => l.startsWith('[自知]'));
const lastLineOf = (t) => String(t).split('\n').slice(-1)[0];
const sha256hex = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex').toUpperCase();
const byteCompare = (a, b) => Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
const SECTION_FOR_TLIVE = {
  text: 'L1 段', sessionId: 't-live', logMaxId: 7, logShownMaxId: 7, logRetiredMaxId: 0,
};
// 直调 section 用的 gate(与 mkHarness 里那份同形):`renderMemorySection` 会读 snapshotOf/isRunning。
const mkGate = (snap) => ({ snapshotOf: () => snap, isRunning: () => false, markSnap: () => {}, markSnapStale: () => {} });

// ── A 节冻结夹具(G5):改前实现(`timeAnchorLive` 一条表达式)产出的 context 文本 ────────────
// 取样原文(2026-11-12,20 天前起的会话):
//   [现在] 傍晚(17:31)
//   [本场] 已持续 20 天(自 10-23 17:31 起)
//   [跨天] 本场对话已跨 20 个日历天。…
// 其中「时段词 / HH:MM / 起算月-日」是**运行时刻**(不可冻结),故:
//   · FROZEN_CONTEXT_MASKED = 整串,时刻槽归一成占位符 ⇒ A 节**按字节**比(Buffer.compare = 0);
//   · FROZEN_TAIL + FROZEN_TAIL_SHA256 = `[跨天]` 整行(纯确定文本)⇒ 原文与 sha256 双钉。
// 两者都**随包**(在本文件里),不再靠"运行时用同一套生产函数重算"当基线。
const FROZEN_CONTEXT_MASKED = '[现在] <period>(<hh:mm>)\n'
  + '[本场] 已持续 20 天(自 <mm-dd> <hh:mm> 起)\n'
  + '[跨天] 本场对话已跨 20 个日历天。涉及"今天/昨天/刚才"时以 [今天] 为准,不要用"今天"指代整场。';
const FROZEN_TAIL = '\n[跨天] 本场对话已跨 20 个日历天。涉及"今天/昨天/刚才"时以 [今天] 为准,不要用"今天"指代整场。';
const FROZEN_TAIL_SHA256 = '210C1AF9711376EEF0487001BD56BEC272A1A045124A62CB0728EFAD864B3B40';
// 只归一**时刻槽**;不做 trim、不折叠空白、不归一标点。
const maskClock = (s) => String(s)
  .replace(/\d{1,2}:\d{2}/g, '<hh:mm>')      // [现在] 的 HH:MM + [本场] 的起算 HH:MM
  .replace(/(自 )\d{2}-\d{2}/, '$1<mm-dd>')  // [本场] 的起算月-日
  .replace(/^\[现在\] [^(\n]+/, '[现在] <period>'); // 时段词(时段档位随运行小时变)

// ── 夹具:假 presence 服务(只暴露公开面的 state/watch/recent 三个方法) ──────────────
// 形态照 presence.test.mjs 的 fakeCtx 思路,但**只模仿契约面**:不 import presence-bus,
// 不伪造内部对象 —— 本 set 要证明的是"消费方只靠公开面就能工作"。
const mkPresence = ({ watchThrows = false, throwInListener = false } = {}) => {
  const rows = [];
  const listeners = new Set();
  const api = {
    state: () => ({
      ok: true, at: new Date().toISOString(), bootAt: new Date().toISOString(),
      enabled: true, pending: { sessions: 0, global: 0 }, lastChange: rows.length ? rows[rows.length - 1] : null,
    }),
    watch: (fn) => {
      if (watchThrows) throw new Error('boom-watch');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    recent: () => {
      if (watchThrows) throw new Error('boom-recent'); // 与 watch 同炸:覆盖"取不到 + 炸了"两种形态
      return rows.map((c) => ({ ...c, scope: { ...c.scope } }));
    },
  };
  return {
    api,
    rows,
    listenerCount: () => listeners.size,
    emit(change) {
      const c = {
        kind: change.kind, code: change.code,
        at: change.at || new Date().toISOString(),
        scope: { ...(change.scope || {}) },
      };
      if (change.count !== undefined) c.count = change.count;
      rows.push(c);
      if (throwInListener) {
        // §3.4-4 的正面形态:**监听器被派发时抛**。给回调一个"一读属性就抛"的变更,且本 fake
        //   **不**像真总线那样逐监听 try(presence-bus.js:194-200)—— 这一节要证明的是消费方
        //   自己的防御(回调自带 try),不是总线的兜底。
        const poisoned = {};
        for (const k of ['kind', 'code', 'at', 'scope']) {
          Object.defineProperty(poisoned, k, { enumerable: true, get() { throw new Error('boom-listener'); } });
        }
        for (const fn of [...listeners]) fn(poisoned);
        return c;
      }
      // 真总线在监听器之前就记 pending(:191-192),这里同样"先入缓冲/再回调"
      for (const fn of [...listeners]) fn({ ...c, scope: { ...c.scope } });
      return c;
    },
  };
};

// ── 夹具:真实注册(拿到 clockSpec.text —— 与 time-t2.0.test.mjs:123-135 同法) ──────
// `specs` 逐个存下注册对象本身(G4):D 节要调**宿主真会调的那个回调**,而不是直调生产函数。
const mkHarness = ({ presence = null, presenceGetThrows = false, snapshot = null } = {}) => {
  const calls = { section: [], context: [] };
  const specs = [];
  let clockSpec = null;
  const sp = {
    section: (o) => { calls.section.push(o.name); specs.push(o); return () => {}; },
    context: (o) => { calls.context.push(o.name); clockSpec = o; return () => {}; },
  };
  const ctx = {
    get(n) {
      if (n === 'systemPrompt') return sp;
      if (n === 'dsh-ling/presence') {
        if (presenceGetThrows) throw new Error('boom-get'); // 别的宿主可能抛(util.js:11-20)
        return presence === null ? undefined : presence;
      }
      return undefined;
    },
  };
  const gate = { snapshotOf: () => snapshot, isRunning: () => false, markSnap: () => {}, markSnapStale: () => {} };
  const dispose = registerMemorySection(ctx, gate, mem, SETTINGS);
  return { calls, specs, clockSpec, ctx, gate, dispose, text: (asm) => clockSpec.text(asm) };
};

// 同一分钟重试:两次取样跨分钟会假红(`[现在]` 带 HH:MM),重试到同分钟为止。
const stablePair = (get, getBase, attempts = 8) => {
  let t = '';
  let base = '';
  for (let i = 0; i < attempts; i += 1) {
    t = get();
    base = getBase();
    if (t === base) return { same: true, t, base };
  }
  return { same: false, t, base };
};

// 会话身份:20 天前起 ⇒ 顶层恒 3 行(`[现在]`/`[本场]`/`[跨天]`),即 C8 的前三段都在。
mem.markSessionStarted('t-live', new Date(Date.now() - 20 * 864e5));
const baselineText = () => wellFormed(neutralizeMustache(timeAnchorLive(mem, SETTINGS, { sessionId: 't-live' })));

// ---------------- A) 无变更 ⇒ 与冻结基线逐字节相同 ----------------
section('A) 无变更 ⇒ context 文本与冻结基线逐字节相同(时刻槽归一后)');
{
  const presence = mkPresence();          // 服务在,但一条变更都没有
  const h = mkHarness({ presence: presence.api });
  eq(h.calls.context.length, 1, 'A:仍然只注册 1 个 context(不自开第二个注册点)');
  const r = stablePair(() => h.text(asmTop('t-live')), baselineText);
  const t = r.t;
  console.log('   实测 context 文本 = ' + JSON.stringify(t));
  console.log('   归一后 = ' + JSON.stringify(maskClock(t)));
  console.log('   [跨天] 行 sha256 = ' + sha256hex('\n' + lastLineOf(t)));
  // ① 冻结表(**文本随包**)按**字节**比:时刻槽之外一字不差 ⇒ 零字符差的"零"有实体基线
  eq(byteCompare(maskClock(t), FROZEN_CONTEXT_MASKED), 0,
    'A:与冻结基线逐字节相同(仅时刻槽归一;不做 trim / 不折叠空白)');
  // ② `[跨天]` 整行是纯确定文本 ⇒ 原文 + sha256 双钉(改一个字就红)
  const tail = '\n' + lastLineOf(t);
  eq(tail, FROZEN_TAIL, 'A:[跨天] 整行与冻结原文逐字相同');
  eq(sha256hex(tail), FROZEN_TAIL_SHA256, 'A:[跨天] 整行 sha256 与冻结值相同');
  // ③ 与"改前表达式"(运行时重算)**交叉**对照 —— 这一条**不是**冻结基线,只作第二只眼
  check(r.same, 'A:与改前表达式(运行时重算)对照通过 —— 交叉锚,不是基线本身');
  check(!t.includes('[自知]'), 'A:无变更 ⇒ [自知] 不出现(实测 ' + JSON.stringify(t) + ')');
  eq(t.split('\n').length, 3, 'A:仍是 [现在]/[本场]/[跨天] 三段');
  check(!t.includes('\n\n'), 'A:不夹带空行');
  h.dispose();
  eq(presence.listenerCount(), 0, 'A:dispose 后订阅已退订(下一节不串账)');
}

// ---------------- B) 两种 kind 各 2 条 ⇒ 一行、按 kind 聚合 ----------------
section('B) 两种 kind 各 2 条 ⇒ 一行、按 kind 聚合、总数正确');
{
  const presence = mkPresence();
  const h = mkHarness({ presence: presence.api });
  // 复位检查(G2):本节第一次组装必须看不见任何"上一节的账"
  const t0 = h.text(asmTop('t-live'));
  check(!t0.includes('[自知]'), 'B 前置(G2 复位):本节起手账本是空的(实际 ' + JSON.stringify(t0) + ')');
  // 变更发生在"上次开口之后"(先落进缓冲,再经订阅回调进账本)
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });
  presence.emit({ code: 'tree.changed', kind: 'tree', scope: { sessionId: 't-live' } });
  presence.emit({ code: 'tree.changed', kind: 'tree', scope: { sessionId: 't-live' } });
  const t = h.text(asmTop('t-live'));
  console.log('   context 文本 = ' + JSON.stringify(t));
  check(t.includes('[自知]'), 'B:有变更必有 [自知]');
  eq(chunk(t).length, 1, 'B:[自知] 只有**一行**(不逐条展开)');
  eq(t.split('[自知]').length, 2, 'B:[自知] 在整串里只出现一次');
  eq(t.split('\n').length, 4, 'B:[自知] 是第 4 段(C8:[现在]→[本场]→[跨天]→[自知])');
  check(t.indexOf('[自知]') > t.indexOf('[跨天]'), 'B:C8 顺序 —— [自知] 在 [跨天] 之后');
  check(!t.includes('\n\n'), 'B:段间仍是单个 \\n,不插空行');
  eq(noticeLineOf(t), '[自知] 上次开口之后：人格改了 2 次、记忆树改了 2 次（共 4 条）。',
    'B:整行逐字 = 按 kind 聚合 + 总数 4 条(4 条事件 ⇒ 2 个 kind 片段)');
  eq((t.match(/改了/g) || []).length, 2, 'B:按 kind 聚合(4 条事件只出 2 个「改了」,不逐条展开)');
  check(!t.includes('设置改了') && !t.includes('记忆改了'),
    'B:条数为 0 的 kind 不出现(既无「设置」也无「记忆」)');
  // 子代理:与 [本场]/[跨天] 同一道闸 ⇒ 不自知(见交付单 C6-(a) 的表态)
  const sub = h.text(asmSub('t-live'));
  check(!sub.includes('[自知]'), 'B:子代理没有 [自知](与 T⑤ 的 canInject 闸同源)');
  eq(sub.split('\n').length, 1, 'B:子代理仍只有 1 行(不夹带空行)');
  h.dispose();
  eq(presence.listenerCount(), 0, 'B:dispose 后订阅已退订');
}

// ---------------- C) 消费语义:context 投递即消费;section 渲染不消费 ----------------
section('C) 消费语义:context 投递即消费;section 渲染不消费');
{
  const presence = mkPresence();
  const h = mkHarness({ presence: presence.api });
  const t0 = h.text(asmTop('t-live'));
  check(!t0.includes('[自知]'), 'C 前置(G2 复位):本节起手账本是空的');
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });

  const t1 = h.text(asmTop('t-live'));
  eq(noticeLineOf(t1), '[自知] 上次开口之后：人格改了 1 次（共 1 条）。', 'C:首次组装看到 1 条');

  // 投递即消费:这一行已经随上一次组装交出去了 ⇒ 再组装必须归零(不重复报、不翻倍)
  const t1b = h.text(asmTop('t-live'));
  const t1c = h.text(asmTop('t-live'));
  check(!t1b.includes('[自知]'), 'C:投递即消费 ⇒ 再组装归零(实际 ' + JSON.stringify(t1b) + ')');
  check(!t1c.includes('[自知]'), 'C:归零后保持归零(不是只消失一次)');
  check(!t1b.includes('2 次'), 'C:渲染从不累加(绝不会出现 2 次)');

  // 新一轮从 1 起(不是 2、3):数字来自 presence 变更流,不是写死的
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });
  const t2 = h.text(asmTop('t-live'));
  eq(noticeLineOf(t2), '[自知] 上次开口之后：人格改了 1 次（共 1 条）。',
    'C:新一轮从 1 起(若从不推进/累加,这里会是 2 次)');

  // section 渲染**不**消费(它跟这行文本没有关系)
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });
  const sec = renderMemorySection(asmTop('t-live'), mkGate(SECTION_FOR_TLIVE), mem, SETTINGS);
  check(!sec.includes('[自知]'), 'C 前置:section 侧本来就不该有 [自知]');
  const t3 = h.text(asmTop('t-live'));
  eq(noticeLineOf(t3), '[自知] 上次开口之后：人格改了 1 次（共 1 条）。',
    'C:section 渲染**不**消费 ⇒ context 仍看见这一条');
  h.dispose();
}

// ---------------- C2) 次序:section 先、context 后 ----------------
section('C2) 次序:section 先渲染、context 后组装 ⇒ [自知] 仍在(复审 G1 正面用例)');
{
  const presence = mkPresence();
  const h = mkHarness({ presence: presence.api });
  const t0 = h.text(asmTop('t-live'));
  check(!t0.includes('[自知]'), 'C2 前置(G2 复位):本节起手账本是空的');
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });

  // 宿主次序一:先 section(system 前缀)、后 context(末条消息)—— 常见形态
  const secFirst = renderMemorySection(asmTop('t-live'), mkGate(SECTION_FOR_TLIVE), mem, SETTINGS);
  check(!secFirst.includes('[自知]'), 'C2 前置:section 侧没有 [自知](它只走 context)');
  const t1 = h.text(asmTop('t-live'));
  eq(noticeLineOf(t1), '[自知] 上次开口之后：人格改了 1 次（共 1 条）。',
    'C2:**section 先渲染** ⇒ context 仍含 [自知](清零点不在 section 路径上)');

  // 宿主次序二:context 已投递 ⇒ 之后无论渲染几次 section 都不会把这行变出来;下一轮归零
  const secAfter = renderMemorySection(asmTop('t-live'), mkGate(SECTION_FOR_TLIVE), mem, SETTINGS);
  check(!secAfter.includes('[自知]'), 'C2:context 投递后 section 仍不含 [自知]');
  const t2 = h.text(asmTop('t-live'));
  check(!t2.includes('[自知]'), 'C2:这一轮已投递 ⇒ 下一轮归零(实际 ' + JSON.stringify(t2) + ')');
  h.dispose();
}

// ---------------- D) 只在 context 侧:断言打在**注册回调**上 ----------------
section('D) [自知] 不进 system 前缀(前缀稳定性;断言打在注册回调上)');
{
  const presence = mkPresence();
  const h = mkHarness({ presence: presence.api, snapshot: SECTION_FOR_TLIVE });
  eq(h.calls.section.length, 1, 'D:仍然只注册 1 个 section');
  // ⚠️ G4:调**宿主真会调的那个注册回调**,不直调 renderMemorySection ——
  //   旧写法直调 + 测试自己拼变异串,把「塞进已注册 sp.section 外壳」这类变异放成了假阴。
  const sectionText = h.specs[0].text;
  eq(typeof sectionText, 'function', 'D:拿到注册回调本体(宿主视角)');
  const secZero = sectionText(asmTop('t-live')); // 零变更基线
  check(!secZero.includes('[自知]'), 'D 前置(G2 复位):零变更时 section 不含 [自知]');
  presence.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } });
  presence.emit({ code: 'tree.changed', kind: 'tree', scope: { sessionId: 't-live' } });
  const secChanged = sectionText(asmTop('t-live'));
  const sys = timeAnchorDate(mem, SETTINGS);
  const ctxTxt = h.text(asmTop('t-live'));

  // 判据本身(变异 M4a/M4b「把 [自知] 塞进 section」会踩红这条)
  const sectionIsNoticeFree = (s) => typeof s === 'string' && !s.includes('[自知]');
  eq(sectionIsNoticeFree(secChanged), true, 'D:section 不含 [自知]');
  eq(sectionIsNoticeFree(sys), true, 'D:system 锚不含 [自知]');
  check(!/\d{1,2}:\d{2}/.test(sys), 'D:system 锚仍不含 HH:MM(与 clock.test.mjs:86 同口径)');
  eq(secChanged, secZero, 'D:有变更时 section 与零变更时**逐字节相同**(前缀稳定性)');
  check(ctxTxt.includes('[自知]'), 'D 对照:同一场景 context 侧**确实**有 [自知](且 section 先渲染也不吃账本)');

  // 判据自检(**不是**产品断言):只证明 sectionIsNoticeFree 不是恒真谓词。
  // 「变异能不能被抓到」由变异跑证明(M4a/M4b 的红灯见 fix.md),**不**由这里自拼一串声称。
  eq(sectionIsNoticeFree('x\n[自知] y'), false, 'D:判据自检 —— sectionIsNoticeFree 对含 [自知] 的串为假');
  h.dispose();
  eq(presence.listenerCount(), 0, 'D:dispose 后订阅已退订');
}

// ---------------- E) presence 抛错 ⇒ 只剩时钟文本,不抛 ----------------
section('E) presence 抛错 ⇒ 只剩时钟文本,不抛、异常文本不进上下文');
{
  // E-1:服务在,但 watch/recent 都炸
  const h1 = mkHarness({ presence: mkPresence({ watchThrows: true }).api });
  let threw1 = null;
  let t1 = '';
  try { t1 = h1.text(asmTop('t-live')); } catch (e) { threw1 = e; }
  check(threw1 === null, 'E:presence 侧抛错时注入出口不抛(实际 ' + threw1 + ')');
  const r1 = stablePair(() => h1.text(asmTop('t-live')), baselineText);
  check(r1.same, 'E:坏 presence ⇒ context 文本与时钟基线逐字节相同(实际 ' + JSON.stringify(r1.t) + ')');
  check(t1.includes('[现在]'), 'E:注入没少段([现在] 仍在)');
  check(!t1.includes('[自知]'), 'E:坏 presence ⇒ [自知] 消失(而不是造一行假的)');
  check(!t1.includes('boom'), 'E:异常文本不得进上下文');
  h1.dispose();

  // E-2:宿主 ctx.get 自己抛(util.js:11-20 论证的真实形态)
  const h2 = mkHarness({ presenceGetThrows: true });
  let threw2 = null;
  let t2 = '';
  try { t2 = h2.text(asmTop('t-live')); } catch (e) { threw2 = e; }
  check(threw2 === null, 'E:ctx.get 抛错 ⇒ 注入出口不抛(实际 ' + threw2 + ')');
  check(t2.includes('[现在]') && !t2.includes('[自知]'), 'E:ctx.get 抛错 ⇒ 只剩时钟文本');
  h2.dispose();

  // E-3(§3.4-4 的**正面**形态):订阅回调被 presence 派发时抛 —— 派发方不许炸,这一行只是消失
  const p3 = mkPresence({ throwInListener: true });
  const h3 = mkHarness({ presence: p3.api });
  h3.text(asmTop('t-live')); // 先建账/绑订阅(此时无变更)
  eq(p3.listenerCount(), 1, 'E:订阅已建立(下面那一抛确实落在监听器上)');
  let threw3 = null;
  try { p3.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 't-live' } }); } catch (e) { threw3 = e; }
  check(threw3 === null, 'E:监听器被派发时抛 ⇒ 派发方不炸(回调自带 try)(实际 ' + threw3 + ')');
  let threw3b = null;
  let t3 = '';
  try { t3 = h3.text(asmTop('t-live')); } catch (e) { threw3b = e; }
  check(threw3b === null, 'E:监听器抛错后注入出口仍不抛(实际 ' + threw3b + ')');
  check(t3.includes('[现在]'), 'E:监听器抛错 ⇒ 时钟段仍在([现在])');
  check(!t3.includes('[自知]'), 'E:监听器抛错 ⇒ 这一行只是消失,不造假的');
  check(!t3.includes('boom'), 'E:监听器的异常文本不进上下文');
  h3.dispose();
}

// ---------------- F) 全局槽 `*` 与跨会话隔离(G3) ----------------
section('F) 全局槽 `*` 与两会话隔离');
{
  // F-1:无 `scope` 的 emit ⇒ 进全局槽 ⇒ 同一会话的 [自知] 里计数 +1
  const p1 = mkPresence();
  const h1 = mkHarness({ presence: p1.api });
  p1.emit({ code: 'settings.changed', kind: 'settings' }); // 无 scope = 影响所有会话
  const t1 = h1.text(asmTop('t-live'));
  eq(noticeLineOf(t1), '[自知] 上次开口之后：设置改了 1 次（共 1 条）。',
    'F:无 scope 的变更走全局槽,并进本会话那一行(全局 + 本会话的合并分支)');
  h1.dispose();

  // F-2:两会话各发一条 ⇒ A 的行不含 B 的 kind;A 投递后 B 仍在(互不吃)
  const p2 = mkPresence();
  const h2 = mkHarness({ presence: p2.api });
  p2.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 's-a' } });
  p2.emit({ code: 'tree.changed', kind: 'tree', scope: { sessionId: 's-b' } });
  const ta = h2.text(asmTop('s-a'));
  eq(noticeLineOf(ta), '[自知] 上次开口之后：人格改了 1 次（共 1 条）。',
    'F:A 会话的行只含自己的 kind(不含 B 的记忆树 —— 跨会话不串味)');
  const tb = h2.text(asmTop('s-b'));
  eq(noticeLineOf(tb), '[自知] 上次开口之后：记忆树改了 1 次（共 1 条）。',
    'F:A 已投递,B 的行仍在且只含自己的 kind');
  check(!h2.text(asmTop('s-a')).includes('[自知]'), 'F:A 已投递 ⇒ 再组装归零');
  check(!h2.text(asmTop('s-b')).includes('[自知]'), 'F:B 已投递 ⇒ 归零');
  h2.dispose();

  // F-3:全局槽 + 本会话同一条变更流里 ⇒ 计数相加(合并在同一行)
  const p3 = mkPresence();
  const h3 = mkHarness({ presence: p3.api });
  p3.emit({ code: 'persona.changed', kind: 'persona', scope: { sessionId: 's-c' } });
  p3.emit({ code: 'persona.changed', kind: 'persona' }); // 全局
  const tc = h3.text(asmTop('s-c'));
  eq(noticeLineOf(tc), '[自知] 上次开口之后：人格改了 2 次（共 2 条）。',
    'F:全局槽 + 本会话那一格按 kind 合并成一条计数');
  h3.dispose();
}

mem.close();
rmSync(dir, { recursive: true, force: true });
console.log(ok ? '自知通知 N 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
