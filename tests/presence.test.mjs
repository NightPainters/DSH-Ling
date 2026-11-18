// presence 单元/接线测试(P4,2026-11-11)。`node tests/presence.test.mjs`
//
// 钉住 HANDOFF-器灵-presence接口-20261022.md §7 的九条验收 + 五类写点各至少一条:
//   1 服务可被 ctx.get('dsh-ling/presence') 取到,三个方法都在(公开面一个键都不多)
//   2 拿不到服务不抛(消费方流程继续)
//   3 watch(fn) 返回**函数**;off 后不再收到;重复 off 幂等;回调同步
//   4 坏监听不拖累(throw 的监听 + 好监听)
//   5 recent() 有界(bufferSize)且时间正序
//   6 未知 kind / code 被忽略,器灵不抛
//   7 state().pending 有未消费变更时 > 0,消费(**真实注入投递**)后回落;
//     MF5 口径:`pending.sessions` 只数会话槽,全局变更报在 `pending.global`(0/1)
//   8 Change 只含 kind/at/code/scope/count 五键,**绝无内容文本**,at 是 UTC ISO
//   9 既有套件全绿 —— 不在本文件里跑(见 _crew/reports/p4-impl/impl.md 的命令记录)
// 另:未启用 / 服务名被占 / disposer / 配置默认值 / 五类写点(树·遗忘·挡位·人格·设置)。
// P4B-FIX(2026-11-11)补:MF1 真实投递点、MF2 挡位幂等、MF3 树幂等重放、MF5 pending.global、
// MF6 两种 ctx.get 形态、N1 bootAt 刷新、N3 limit:0、N4 sessionId 截断、code→kind 全表断言。
// P4C-FIX(2026-11-11)补:MF3 残留两处(setConvBranch / linkVeins 的**同值重放**与反向/有向语义)、
// 恒真断言 `ctx.get()===api` 改成独立再取、时间正序改成**乱序输入**才有区分力、
// recent({since}) 闭区间/非法值、R2 的 settings.changed count 口径、state()/pending 改成
// "包含必需键 + 值形状"(只增键承诺)。
//
// 测试缝:契约 v1 无公开消费者,公开面只有 state/watch/recent ⇒ "手工塞一条 Change"
// 从公开面做不到。按 survey §4.4 选项 a,用**模块级**导出直接驱动(公开面零污染)。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const bus = await imp('lib/host/presence-bus.js');
const { registerPresenceService, PRESENCE_SERVICE_NAME } = await imp('lib/host/presence-service.js');
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { DEFAULT_SETTINGS } = await imp('lib/host/persona.js');
const { Config } = await imp('lib/host/config.js');
const { renderMemorySection } = await imp('lib/host/inject.js'); // MF1:真实注入投递入口

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(Object.is(a, b), `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);

/** 注册会 console.info 一行、失败路径 console.debug;静音保持输出干净。 */
function quiet(fn) {
  const i = console.info, d = console.debug;
  console.info = () => {}; console.debug = () => {};
  try { return fn(); } finally { console.info = i; console.debug = d; }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-presence-'));
const FIVE = ['kind', 'at', 'code', 'scope', 'count'];

/** fakeCtx:get() 必须能看见刚 provide 的服务(survey §4.2 指出的原 fake 缺口)。 */
function fakeCtx({ throwOnProvide = false } = {}) {
  const provided = [];
  return {
    get: (n) => provided.find((p) => p.name === n)?.value,
    provide: (name, value) => {
      if (throwOnProvide) throw new Error('service "' + name + '" has been registered at <fake>');
      provided.push({ name, value });
      return () => {
        const i = provided.findIndex((p) => p.name === name && p.value === value);
        if (i >= 0) provided.splice(i, 1);
      };
    },
    _provided: provided,
  };
}

/** 起一个注册好的服务(每个小节能独立 boot;总线先 reset)。 */
function boot({ config, throwOnProvide = false } = {}) {
  bus.resetPresenceBus();
  const ctx = fakeCtx({ throwOnProvide });
  const dispose = quiet(() => registerPresenceService(ctx, { memory: null, settings: null, config }));
  return { ctx, api: ctx.get(PRESENCE_SERVICE_NAME), dispose };
}

/** 五键不变量:任何一条 Change 都只许这五个键,且 at 是 UTC ISO。 */
function assertFiveKeys(rows, label) {
  for (const c of rows) {
    const keys = Object.keys(c);
    check(keys.every((k) => FIVE.includes(k)), `${label}:Change 出现五键之外的键 ${keys.join(',')}`);
    check(!keys.includes('text') && !keys.includes('value') && !keys.includes('name') && !keys.includes('reason'),
      `${label}:Change 里出现了内容字段`);
    check(typeof c.at === 'string' && new Date(Date.parse(c.at)).toISOString() === c.at, `${label}:at 不是 UTC ISO(${c.at})`);
    check(typeof c.kind === 'string' && typeof c.code === 'string', `${label}:kind/code 缺失`);
    check(c.scope && typeof c.scope === 'object' && !Array.isArray(c.scope), `${label}:scope 不是对象`);
  }
}

// ── 1 服务可被 ctx.get 取到,三个方法都在,公开面不多一个键 ───────────────────────
{
  const { ctx, api, dispose } = boot();
  check(!!api, '#1 ctx.get 取不到服务');
  // P4C(2026-11-11):旧断言 `ctx.get(...) === api` 是**恒真**的(api 就是同一个 ctx.get 取出来的)。
  // 要测"同一对象"必须**独立再取一次**再比;上面 `!!api` 已经证明能取到。
  const again = ctx.get(PRESENCE_SERVICE_NAME);
  check(!!again, '#1 第二次独立 ctx.get 取不到服务');
  eq(again === api, true, '#1 两次独立 ctx.get 必须返回同一对象');
  eq(PRESENCE_SERVICE_NAME, 'dsh-ling/presence', '#1 服务名');
  for (const m of ['state', 'watch', 'recent']) check(typeof api[m] === 'function', `#1 ${m} 不是函数`);
  eq(Object.keys(api).sort().join(','), 'recent,state,watch', '#1 公开面只许 state/watch/recent 三个键');
  // 六字段形状(契约 §3.2):at / bootAt 必须是 UTC ISO —— 删掉它们这里就红。
  // P4C:改用"**包含必需键 + 值形状**"而不是精确键集 —— 契约 §4 铁律 3 允许**只增键**,
  // 精确键集会让将来加字段先被测试打红(方向与承诺相反)。当前行为仍被钉住:必需键一个不能少,
  // 值形状 / pending 两格的语义都有断言。
  const st = api.state();
  for (const k of ['ok', 'at', 'bootAt', 'enabled', 'pending', 'lastChange']) {
    check(Object.hasOwn(st, k), `#1 state() 缺必需键 ${k}`);
  }
  eq(st.ok, true, '#1 state().ok 应为 true');
  eq(typeof st.enabled, 'boolean', '#1 state().enabled 应是布尔');
  check(st.pending !== null && typeof st.pending === 'object' && !Array.isArray(st.pending), '#1 state().pending 应是对象');
  check(Number.isInteger(st.pending.sessions) && st.pending.sessions >= 0, '#1 pending.sessions 应是非负整数(会话数)');
  check(st.pending.global === 0 || st.pending.global === 1, '#1 pending.global 应是 0|1(MF5)');
  check(st.lastChange === null || (typeof st.lastChange === 'object' && typeof st.lastChange.code === 'string'),
    '#1 state().lastChange 应是 null 或一条 Change');
  check(typeof st.at === 'string' && new Date(Date.parse(st.at)).toISOString() === st.at, '#1 state().at 不是 UTC ISO');
  check(typeof st.bootAt === 'string' && new Date(Date.parse(st.bootAt)).toISOString() === st.bootAt, '#1 state().bootAt 不是 UTC ISO');
  dispose();
}

// ── 1b N1:bootAt = **本次加载**时刻(不是模块首 import 的时刻) ─────────────────
{
  bus.resetPresenceBus();
  const before = bus.presenceSnapshot().bootAt;
  await new Promise((r) => { setTimeout(r, 5); });
  const t0 = Date.now();
  const ctx = fakeCtx();
  const dispose = quiet(() => registerPresenceService(ctx, { config: {} }));
  const bootAt = ctx.get(PRESENCE_SERVICE_NAME).state().bootAt;
  check(Date.parse(bootAt) >= t0 - 1, `N1 bootAt 应是本次注册时刻(实际 ${bootAt} < 注册前 ${new Date(t0).toISOString()})`);
  check(Date.parse(bootAt) > Date.parse(before), 'N1 bootAt 没随本次注册刷新(仍是模块首 import / reset 时刻)');
  dispose();
  bus.resetPresenceBus();
}

// ── 2 拿不到服务不抛(软依赖),消费方流程继续 ──────────────────────────────────
// MF6(2026-11-11 P4B;P4C 改用可复核宿主事实):本机当前宿主 cordis 4.0.5
// (`<DSH_PORTABLE>/portable/app/node_modules/@deepseek-ai/cordis/lib/index.js:763`)的
// `get(name, strict=true)` 对未 provide 的服务返回 undefined;但**别的宿主可能抛**。
// ⇒ 这里的消费者按本仓 `util.js:svc()` 的安全形态写,
// **两种形态都必须过**:get 返回 undefined(契约字面)与 get 抛错(宿主差异)。
{
  const consumer = (ctx) => {
    let presence;
    try { presence = ctx.get(PRESENCE_SERVICE_NAME); } catch { presence = undefined; }
    if (!presence) return 'skipped'; // 拿不到 = 跳过,不是错误
    presence.watch(() => {});
    return 'used';
  };
  let threw = false;
  let result = null;
  try { result = consumer({ get: () => undefined }); } catch { threw = true; }
  eq(threw, false, '#2 拿不到服务(undefined)时消费方抛了');
  eq(result, 'skipped', '#2 拿不到服务时应跳过而不是中断');
  // 形态 B:get 抛错(其它宿主 / fake 的实现差异)—— 同一个消费者也必须跳过而不是炸
  let threw2 = false;
  let result2 = null;
  try { result2 = consumer({ get: () => { throw new Error('service "dsh-ling/presence" not found'); } }); } catch { threw2 = true; }
  eq(threw2, false, '#2 ctx.get 抛错时消费方抛了(软依赖不成立)');
  eq(result2, 'skipped', '#2 ctx.get 抛错时消费方也应跳过');
  // 形态 C:本仓 `svc()` 就是为"宿主会抛"准备的那一层 —— 两种形态都必须回 undefined
  const util = await imp('lib/host/util.js');
  eq(util.svc({ get: () => undefined }, PRESENCE_SERVICE_NAME), undefined, '#2 svc():拿不到应为 undefined');
  let threw3 = false;
  let v3;
  try { v3 = util.svc({ get: () => { throw new Error('boom'); } }, PRESENCE_SERVICE_NAME); } catch { threw3 = true; }
  eq(threw3, false, '#2 svc():宿主抛错时不该把异常带出来');
  eq(v3, undefined, '#2 svc():宿主抛错时应回 undefined');
}

// ── 3 watch 返回函数;退订后不再收到;重复 off 幂等;回调同步 ────────────────────
{
  const { api, dispose } = boot();
  let hits = 0;
  let sync = false;
  const off = api.watch(() => { hits += 1; sync = true; });
  eq(typeof off, 'function', '#3 watch 必须返回退订函数');
  bus.emitChange({ code: 'tree.changed' });
  eq(hits, 1, '#3 订阅者没收到第一条');
  eq(sync, true, '#3 回调必须是同步的');
  off();
  off(); // 幂等:第二次不许报错、不许误删别人的监听
  bus.emitChange({ code: 'tree.changed' });
  eq(hits, 1, '#3 退订后仍收到事件');
  dispose();
}

// ── 4 坏监听不拖累 ───────────────────────────────────────────────────────────
{
  const { api, dispose } = boot();
  let good = 0;
  api.watch(() => { throw new Error('boom'); });
  api.watch(() => { good += 1; });
  let threw = false;
  const dbg = console.debug;
  console.debug = () => {}; // 坏监听被逐条 try/catch ⇒ 器灵只记一条 debug,测试里静音
  try { bus.emitChange({ code: 'settings.changed' }); } catch { threw = true; } finally { console.debug = dbg; }
  eq(threw, false, '#4 坏监听把异常带回了发送方');
  eq(good, 1, '#4 好监听没收到');
  eq(api.state().ok, true, '#4 坏监听影响到了 state()');
  dispose();
}

// ── 5 recent() 有界 + 时间正序 ────────────────────────────────────────────────
{
  const { api, dispose } = boot({ config: { bufferSize: 10 } });
  const at = (s) => new Date(Date.UTC(2026, 10, 11, 0, 0, s)).toISOString();
  // P4C:旧写法喂的是**本来就递增**的 at(0,1,2…59),环形缓冲又是追加序 ⇒
  // 把 `recentChanges` 里的 sort 整行删掉,旧断言仍为绿(空转)。现在先塞**逆序** at
  // (59 / 0 / 30),不排序就一定红。
  for (const s of [59, 0, 30]) bus.emitChange({ code: 'tree.changed', at: at(s) });
  const ooo = api.recent();
  eq(ooo.length, 3, '#5 乱序三条应全在缓冲里');
  eq(ooo.map((c) => c.at).join(','), [0, 30, 59].map(at).join(','), '#5 recent() 必须是时间正序(乱序输入 ⇒ 排序生效)');
  // 有界:再塞 60 条递增(bufferSize=10 ⇒ 只剩最后 10 条)
  for (let i = 0; i < 60; i += 1) bus.emitChange({ code: 'tree.changed', at: at(i) });
  const rows = api.recent({ limit: 50 }); // 不分页 ⇒ 上限就是 bufferSize
  eq(rows.length, 10, '#5 recent() 没被 bufferSize 夹住');
  let sorted = true;
  for (let i = 1; i < rows.length; i += 1) if (rows[i - 1].at > rows[i].at) sorted = false;
  eq(sorted, true, '#5 recent() 不是时间正序');
  eq(rows[rows.length - 1].at, at(59), '#5 环形缓冲保留了最新一条');
  // N3(2026-11-11 P4B):limit 一律按"条数"解释 —— 0 / 负数 ⇒ 空表(旧实现回全量)
  eq(api.recent({ limit: 0 }).length, 0, '#5 limit:0 应回空表(N3)');
  eq(api.recent({ limit: -3 }).length, 0, '#5 limit:-3 应回空表(N3)');
  eq(api.recent({ limit: 3 }).length, 3, '#5 limit:3 应回 3 条');
  // since 闭区间:只要 00:00:57 / 58 / 59 这三条(下界那条**不排除**)
  const sinceRows = api.recent({ since: at(57) });
  eq(sinceRows.length, 3, '#5 since 应是 >= 闭区间');
  eq(sinceRows[0].at, at(57), '#5 since 下界被排除了一条');
  eq(api.recent({ since: at(58) }).length, 2, '#5 since 再抬一格应剩 2 条');
  // 非法 since:不抛、不过滤(== 没给)
  let sinceThrew = false;
  let badRows = null;
  try { badRows = api.recent({ since: 'not-a-date' }); } catch { sinceThrew = true; }
  eq(sinceThrew, false, '#5 非法 since 不该抛');
  eq(badRows?.length, 10, '#5 非法 since 应被忽略(不抛、不过滤)');
  assertFiveKeys(rows, '#5');
  dispose();
}

// ── 6 未知 kind / code 被忽略,器灵不抛;消费方按铁律 1 自己跳过 ─────────────────
{
  const { api, dispose } = boot();
  const r1 = bus.emitChange({ kind: 'xyz', code: 'zzz' });
  eq(r1.ok, false, '#6 未知 code 不该被接受');
  const r2 = bus.emitChange({ kind: 'xyz', code: 'tree.changed' });
  eq(r2.ok, false, '#6 未知 kind 不该被接受');
  eq(api.recent().length, 0, '#6 未知 kind/code 不该进缓冲');
  eq(api.state().ok, true, '#6 未知输入弄崩了 state()');
  // 消费方示例:白名单 switch,未知 code 直接忽略(铁律 1 是消费方义务)
  const consume = (change) => {
    switch (change.code) {
      case 'tree.changed': return 'tree';
      case 'memory.forgotten': return 'memory';
      case 'persona.changed': return 'persona';
      case 'settings.changed': return 'settings';
      case 'mode.changed': return 'mode';
      default: return 'ignored';
    }
  };
  eq(consume({ kind: 'xyz', code: 'zzz' }), 'ignored', '#6 消费方没跳过未知 code');
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 's-1' } });
  eq(api.recent().length, 1, '#6 合法事件被连带拒了');
  eq(consume(api.recent()[0]), 'mode', '#6 合法 code 应被消费方识别');
  dispose();
}

// ── 7 pending:有未消费变更 > 0,消费(投递)后回落 ─────────────────────────────
// MF5 口径(方案②,只增键):`pending.sessions` 只数 `s:` 槽(= 真实会话数);
// 无 scope 的全局变更占 `pending.global`(0/1),**不再**混进 `sessions`。
{
  const { api, dispose } = boot();
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 's-a' } });
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 's-b' } });
  eq(api.state().pending.sessions, 2, '#7 两个会话挂着未消费变更,应是 2');
  eq(api.state().pending.global, 0, '#7 没有全局变更时 pending.global 应是 0');
  api.recent({ limit: 50 }); // 口径:recent() **不消费**
  eq(api.state().pending.sessions, 2, '#7 recent() 不许改变 pending(口径 A)');
  bus.markDelivered('s-a');
  eq(api.state().pending.sessions, 1, '#7 投递一个会话后应回落 1');
  bus.markDelivered('s-b');
  eq(api.state().pending.sessions, 0, '#7 全部投递后应回落到 0');
  bus.emitChange({ code: 'tree.changed' }); // 无 scope = 影响所有会话 ⇒ 全局槽
  eq(api.state().pending.sessions, 0, '#7 MF5:全局变更**不是**会话,不许把 sessions 顶成 1');
  eq(api.state().pending.global, 1, '#7 MF5:全局变更应报在 pending.global 上');
  bus.markDelivered();
  eq(api.state().pending.sessions, 0, '#7 全局槽投递后 sessions 仍应是 0');
  eq(api.state().pending.global, 0, '#7 全局槽被投递后应回落到 0');
  // N4:超长 sessionId 截断到 128(不拒绝、不丢事件)
  const longId = 'x'.repeat(300);
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: longId } });
  eq(api.state().pending.sessions, 1, '#7 N4:超长 sessionId 仍应记 1 个会话槽');
  const longRow = api.recent().at(-1);
  eq(longRow.scope.sessionId.length, 128, '#7 N4:scope.sessionId 应截断到 128');
  bus.markDelivered(longId); // 截断后仍是同一格 ⇒ 能清掉
  eq(api.state().pending.sessions, 0, '#7 N4:markDelivered 必须能命中被截断的那一格');
  dispose();
}

// ── 7b MF1:投递即消费 —— 必须经**真实注入入口**触发,不许只调 bus 内部函数 ──────
// `inject.js` 的 `advanceLogWatermark()` 只在 `renderMemorySection()` 的投递分支上被调用
// (它是 `section.text()` 的实现),所以这里走真入口:gate 给一份现成快照 ⇒ 走"冻结快照投递"那条路。
{
  const { api, dispose } = boot();
  const db = new MemoryStore(join(dir, 'm-inject.db'));
  const S = { mode: { lastMode: 'life' }, persona: {}, inject: {}, memory: {} };
  const settings = { get: () => S };
  // logMaxId=0:树没动过的"空投递"也一样要清账(MF1 的原症状:只有挡位/人格变更时永远清不掉)
  const snap = { text: '【记忆】P4-FIX 投递探针', logMaxId: 0, logShownMaxId: 0, logRetiredMaxId: 0 };
  const gate = {
    snapshotOf: () => snap,
    isRunning: () => false,
    markSnap: () => {},
    markSnapStale: () => {},
  };
  const asm = (sid) => ({ agent: { session: { id: sid, header: {} } } });
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 'sess-inj' } });
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 'sess-other' } });
  eq(api.state().pending.sessions, 2, 'MF1 前置:两个会话都压着未投递变更');
  const text = renderMemorySection(asm('sess-inj'), gate, db, settings);
  eq(text.includes('P4-FIX 投递探针'), true, 'MF1 前置:真实注入入口必须真的投递出文本');
  eq(api.state().pending.sessions, 1, 'MF1 投递后该会话 pending 必须回落(经真实注入入口,不是直接调 markDelivered)');
  // 别的会话没开口 ⇒ 它的账不能被这次投递清掉(区分力:不是"清空所有")
  eq(api.recent().length >= 2, true, 'MF1 前置:事件确实在缓冲里');
  renderMemorySection(asm('sess-other'), gate, db, settings);
  eq(api.state().pending.sessions, 0, 'MF1 第二个会话投递后应回落到 0');
  // 全局槽:无 scope 的变更也要在投递时消费掉,否则 pending.global 永远停在 1
  bus.emitChange({ code: 'tree.changed' });
  eq(api.state().pending.global, 1, 'MF1 前置:全局变更应占全局槽');
  renderMemorySection(asm('sess-inj'), gate, db, settings);
  eq(api.state().pending.global, 0, 'MF1 投递后全局槽也必须回落');
  db.close();
  dispose();
}

// ── 8 Change 只含五键、绝无内容文本、at 为 UTC ISO ────────────────────────────
{
  const { api, dispose } = boot();
  bus.emitChange({
    code: 'memory.forgotten',
    scope: { sessionId: 's-9' },
    count: 3,
    text: '绝密内容不许出现',
    name: 'branch-secret',
    reason: 'because',
    note: '明文备注',
  });
  const rows = api.recent();
  eq(rows.length, 1, '#8 合法事件没进缓冲');
  const c = rows[0];
  eq(Object.keys(c).sort().join(','), 'at,code,count,kind,scope', '#8 Change 键集不对(多键或少键)');
  eq(JSON.stringify(c).includes('绝密') || JSON.stringify(c).includes('branch-secret') || JSON.stringify(c).includes('明文'),
    false, '#8 Change 里出现了内容文本');
  eq(new Date(c.at).toISOString(), c.at, '#8 at 不是 UTC ISO 形状');
  eq(c.count, 3, '#8 count 丢了');
  eq(Object.keys(c.scope).join(','), 'sessionId', '#8 scope 只许 sessionId');
  eq(api.state().lastChange.code, 'memory.forgotten', '#8 state().lastChange 不对');
  assertFiveKeys(rows, '#8');
  dispose();
}

// ── 8b code → kind 映射(词表 HANDOFF §3.5 的第三列,逐格) ─────────────────────
// 覆盖缺口:此前只断言过 mode/settings 两格 —— 把 `tree.changed`/`memory.forgotten`/
// `persona.changed` 的映射改错,测试照样全绿。
{
  const { api, dispose } = boot();
  bus.emitChange({ code: 'tree.changed' });
  bus.emitChange({ code: 'memory.forgotten' });
  bus.emitChange({ code: 'persona.changed' });
  bus.emitChange({ code: 'settings.changed' });
  bus.emitChange({ code: 'mode.changed', scope: { sessionId: 'map-1' } });
  const map = Object.fromEntries(api.recent().map((c) => [c.code, c.kind]));
  eq(map['tree.changed'], 'tree', '写点:tree.changed 的 kind 应是 tree');
  eq(map['memory.forgotten'], 'memory', '写点:memory.forgotten 的 kind 应是 memory');
  eq(map['persona.changed'], 'persona', '写点:persona.changed 的 kind 应是 persona');
  eq(map['settings.changed'], 'settings', '写点:settings.changed 的 kind 应是 settings');
  eq(map['mode.changed'], 'settings', '写点:mode.changed 的 kind 应是 settings');
  eq(Object.keys(map).length, 5, '写点:五条 code 应各产出一条 Change');
  dispose();
}

// ── 未启用:服务仍在、watch 可调用但不触发、state().enabled=false ─────────────
{
  const { api, dispose } = boot({ config: { enabled: false } });
  check(!!api, '未启用时服务不该消失(否则消费方会误判"器灵没装")');
  let hits = 0;
  const off = api.watch(() => { hits += 1; });
  eq(typeof off, 'function', '未启用时 watch 也要返回退订函数');
  bus.emitChange({ code: 'tree.changed' });
  eq(hits, 0, '未启用时不该触发回调');
  eq(api.recent().length, 0, '未启用时不该记缓冲');
  eq(api.state().enabled, false, '未启用时 state().enabled 应为 false');
  eq(api.state().ok, true, '未启用时 state() 仍应 ok');
  dispose();
}

// ── 服务名被占用:只记日志、不抛;disposer 拆干净 ──────────────────────────────
{
  bus.resetPresenceBus();
  const ctx = fakeCtx({ throwOnProvide: true });
  let dispose = null;
  let threw = false;
  try { dispose = quiet(() => registerPresenceService(ctx, { config: {} })); } catch { threw = true; }
  eq(threw, false, '服务名被占用时 registerPresenceService 抛了');
  eq(typeof dispose, 'function', '注册失败也要返回 disposer');
  dispose();

  // provide 成功路径:dispose 后 state() = closed,watch 不再回调
  const two = boot();
  let hits = 0;
  const off = two.api.watch(() => { hits += 1; });
  bus.emitChange({ code: 'tree.changed' });
  eq(hits, 1, 'dispose 前应正常回调');
  two.dispose();
  eq(two.api.state().ok, false, 'dispose 后 state() 应返回 ok:false');
  eq(two.api.state().reason, 'closed', 'dispose 后 state() 的 reason 应是 closed');
  bus.emitChange({ code: 'tree.changed' });
  eq(hits, 1, 'dispose 后不该再回调');
  off(); // 幂等:dispose 已卸过,这里不许报错
}

// ── 配置:默认值来自 config.js schema(可经 cordis.yml 调,不许硬编码) ──────────
{
  const cfg = Config({});
  eq(cfg.presence.enabled, true, 'config:presence.enabled 默认应为 true');
  eq(cfg.presence.bufferSize, 200, 'config:presence.bufferSize 默认应为 200');
  const cfg2 = Config({ presence: { enabled: false, bufferSize: 5 } });
  eq(cfg2.presence.enabled, false, 'config:presence.enabled 应可配');
  eq(cfg2.presence.bufferSize, 5, 'config:presence.bufferSize 应可配');
}

// ── 写点 1/5:树结构(memory.js) ──────────────────────────────────────────────
// MF3(2026-11-11 P4B):"什么都没变也发"是本类的主病。这里的每条幂等重放都必须**不发**:
//   createBranch 重放 / renameBranch 同名 / setBranchWeight 同值 /
//   setSessionBranch 同枝 / reparentBranch 同父;不存在的枝改名/调权重必须 ok:false 且不发。
// P4C(2026-11-11):补上复审点名的两处残留 —— `setConvBranch`(覆盖层)与 `linkVeins`(连边,
// 含**反向**写入与**有向**边两种语义)的同值重放,以及换值必须发(正对照,别把整类打哑)。
{
  const { api, dispose } = boot();
  const db = new MemoryStore(join(dir, 'm.db'));
  const treeN = () => api.recent().filter((c) => c.code === 'tree.changed').length;
  db.createBranch({ id: 'br:p4-1', name: 'P4 测试枝' });
  eq(treeN(), 1, '写点:createBranch 没发 tree.changed');
  db.createBranch({ id: 'br:p4-1', name: 'P4 测试枝' }); // 幂等重放:无实际插入 ⇒ 不发
  eq(treeN(), 1, '写点:createBranch 幂等重放不该发事件');
  db.renameBranch('br:p4-1', '改名枝');
  eq(treeN(), 2, '写点:renameBranch 没发 tree.changed');
  db.renameBranch('br:p4-1', '改名枝'); // MF3 幂等重放 ①:同名 ⇒ 不发
  eq(treeN(), 2, '写点:renameBranch 同名重放不该发事件(MF3)');
  db.setBranchWeight('br:p4-1', 1.2);
  eq(treeN(), 3, '写点:setBranchWeight 没发 tree.changed');
  db.setBranchWeight('br:p4-1', 1.2); // MF3 幂等重放 ②:同值 ⇒ 不发
  eq(treeN(), 3, '写点:setBranchWeight 同值重放不该发事件(MF3)');
  db.createBranch({ id: 'br:p4-2', name: '新父枝' });
  eq(treeN(), 4, '写点:createBranch(第二条)没发 tree.changed');

  // ── linkVeins:正向同值重放 / 反向同值重放 / 换 kind 必须发(P4C MF3 残留) ──
  db.linkVeins('br:p4-1', 'trunk', { kind: 'related' });
  eq(treeN(), 5, '写点:linkVeins 没发 tree.changed');
  db.linkVeins('br:p4-1', 'trunk', { kind: 'related' }); // 同 (from,to,kind,note) 重放 ⇒ 不发
  eq(treeN(), 5, '写点:linkVeins 同值重放不该发事件(P4C MF3)');
  db.linkVeins('trunk', 'br:p4-1', { kind: 'related' }); // 反向同值(无向关系是同一个事实)⇒ 不发
  eq(treeN(), 5, '写点:linkVeins 反向同值重放不该发事件(P4C MF3)');
  db.linkVeins('trunk', 'br:p4-1', { kind: 'related', note: '反向备注' }); // 反向路径真的改了 note ⇒ 发
  eq(treeN(), 6, '写点:linkVeins 反向改 note 应发 1 条(别把反向路径打哑)');
  db.linkVeins('trunk', 'br:p4-1', { kind: 'related', note: '反向备注' }); // 再重放 ⇒ 不发
  eq(treeN(), 6, '写点:linkVeins 反向改完再重放不该发事件(P4C MF3)');
  db.linkVeins('br:p4-1', 'trunk', { kind: 'prerequisite' }); // 有向边:同一有序对换 kind ⇒ 发
  eq(treeN(), 7, '写点:linkVeins 换 kind 应发 1 条(P4C MF3)');
  db.linkVeins('br:p4-1', 'trunk', { kind: 'prerequisite' }); // 有向边同值重放 ⇒ 不发
  eq(treeN(), 7, '写点:linkVeins 有向边同值重放不该发事件(P4C MF3)');
  eq(db.listVeinLinks().length, 1, '写点:linkVeins 不许因反向写入多落一行(无向关系只一条边)');
  db.unlinkVein('br:p4-1', 'trunk');
  eq(treeN(), 8, '写点:unlinkVein 没发 tree.changed');

  // ── setConvBranch:覆盖层同值重放 / 换枝必须发(P4C MF3 残留) ──
  db.setConvBranch('dsweb', 'w2', 'br:p4-1'); // 缺行 = 未指定 = 主干 ⇒ 主干→枝 是真变更
  eq(treeN(), 9, '写点:setConvBranch 没发 tree.changed');
  db.setConvBranch('dsweb', 'w2', 'br:p4-1'); // 同值重放(ON CONFLICT 同值 changes 仍=1)⇒ 不发
  eq(treeN(), 9, '写点:setConvBranch 同值重放不该发事件(P4C MF3)');
  db.setConvBranch('dsweb', 'w0', 'trunk'); // 缺行 + 归主干 = 树结构没变 ⇒ 不发
  eq(treeN(), 9, '写点:setConvBranch 把未指定的条目显式归主干不该发事件(P4C MF3)');
  db.setConvBranch('dsweb', 'w2', 'br:p4-2'); // 换枝 ⇒ 真的变了
  eq(treeN(), 10, '写点:setConvBranch 换枝应发 1 条(P4C MF3)');
  db.setConvBranch('dsweb', 'w2', 'br:p4-2'); // 再重放 ⇒ 不发
  eq(treeN(), 10, '写点:setConvBranch 换枝后再重放不该发事件(P4C MF3)');

  db.setSessionBranch('sess-p4', 'br:p4-1');
  eq(treeN(), 11, '写点:setSessionBranch 没发 tree.changed');
  db.setSessionBranch('sess-p4', 'br:p4-1'); // MF3 幂等重放 ③:同枝(ON CONFLICT 同值 changes 仍=1)⇒ 不发
  eq(treeN(), 11, '写点:setSessionBranch 同枝重放不该发事件(MF3)');
  eq(db.reparentBranch('br:p4-1', 'br:p4-2').ok, true, '写点:reparentBranch 应成功');
  eq(treeN(), 12, '写点:reparentBranch 没发 tree.changed');
  db.reparentBranch('br:p4-1', 'br:p4-2'); // MF3 幂等重放 ④:同父 ⇒ 不发
  eq(treeN(), 12, '写点:reparentBranch 同父重放不该发事件(MF3)');
  // MF3:改一个不存在的枝 —— 旧实现 ok:true + 一条假"树结构被改"
  const ghostRename = db.renameBranch('br:nope', '幽灵枝');
  eq(ghostRename.ok, false, '写点:renameBranch 不存在的枝应回 ok:false(MF3)');
  eq(treeN(), 12, '写点:renameBranch 不存在的枝不该发事件(MF3)');
  const ghostWeight = db.setBranchWeight('br:nope', 1.5);
  eq(ghostWeight.ok, false, '写点:setBranchWeight 不存在的枝应回 ok:false(MF3)');
  eq(treeN(), 12, '写点:setBranchWeight 不存在的枝不该发事件(MF3)');
  eq(db.deleteBranch('br:p4-1', { force: true }).ok, true, '写点:deleteBranch 应成功');
  eq(treeN(), 13, '写点:deleteBranch 没发 tree.changed');
  // create1 / rename / weight / create2 / link / link反改note / link换kind / unlink /
  // setConvBranch / setConvBranch换枝 / setSessionBranch / reparent / delete = 13
  eq(treeN(), 13, '写点:树结构总量应为 13 条(所有幂等重放 + 2 条不存在都不算)');
  const rows = api.recent();
  assertFiveKeys(rows, '写点·树');
  db.close();
  dispose();
}

// ── 写点 2/5:遗忘 / 回灌(memory.js) ─────────────────────────────────────────
{
  const { api, dispose } = boot();
  const db = new MemoryStore(join(dir, 'm-forget.db'));
  const arc = join(dir, 'arc');
  db.forgetEntry({ source: 'dsh', convId: 'sess-forget', archivePath: arc, archiveTurns: 1 });
  const rows1 = api.recent();
  eq(rows1.length, 1, '写点:forgetEntry 没发 memory.forgotten');
  eq(rows1[0].code, 'memory.forgotten', '写点:forgetEntry 的 code 不对');
  eq(rows1[0].scope.sessionId, 'sess-forget', '写点:forgetEntry 应带 scope.sessionId');
  db.unforgetEntry({ source: 'dsh', convId: 'sess-forget' });
  eq(api.recent().length, 2, '写点:unforgetEntry 没发 memory.forgotten');
  db.restoreEntry({ source: 'dsh', convId: 'sess-forget', turns: [{ seq: 1, role: 'user', ts: null, model: null, text: '原文' }] });
  const rows2 = api.recent();
  eq(rows2.length, 3, '写点:restoreEntry 没发 memory.forgotten');
  eq(rows2[2].count, 1, '写点:restoreEntry 的 count 应是回灌轮数');
  eq(JSON.stringify(rows2).includes('原文'), false, '写点:回灌正文漏进了 Change');
  assertFiveKeys(rows2, '写点·遗忘');
  db.close();
  dispose();
}

// ── 写点 3/5:挡位(memory.js) ────────────────────────────────────────────────
// MF2(2026-11-11 P4B):词表说 `mode.changed` = 「挡位**变了**」。旧实现无条件发 ⇒
// `lifecycle.js:119` 每次 session-start(含 resume/clear/compact)都报一条假变更。
// 这里钉住三件事:变了才发 / 同挡位连设两次只 1 条 / clear 已是 NULL 不发 / changes===0 不发。
{
  const { api, dispose } = boot();
  const db = new MemoryStore(join(dir, 'm-mode.db'));
  db.setSessionMode('sess-mode', 'work');
  eq(api.recent().length, 1, '写点:setSessionMode 变了挡位应发 1 条');
  db.setSessionMode('sess-mode', 'work'); // MF2:同一挡位连设两次 ⇒ 仍只有 1 条
  eq(api.recent().length, 1, '写点:同一挡位连续 set 两次不该产生第二条(MF2)');
  db.setSessionMode('sess-mode', 'life'); // 真的变了 ⇒ 第 2 条
  eq(api.recent().length, 2, '写点:挡位真的变了应发第二条');
  db.clearSessionMode('sess-mode');
  eq(api.recent().length, 3, '写点:clearSessionMode 清掉真挡位应发 1 条');
  db.clearSessionMode('sess-mode'); // MF2:已经是 NULL ⇒ 不发
  eq(api.recent().length, 3, '写点:clear 一个已是 NULL 的会话不该发事件(MF2)');
  db.clearSessionMode('sess-never-seen'); // MF2:changes===0(没有这一行)⇒ 不发
  eq(api.recent().length, 3, '写点:clear 一个不存在的会话不该发事件(MF2:changes===0)');
  const rows = api.recent();
  eq(rows.length, 3, '写点:挡位总量应为 3 条(work / life / clear)');
  eq(rows[0].code, 'mode.changed', '写点:setSessionMode 的 code 不对');
  eq(rows[0].scope.sessionId, 'sess-mode', '写点:mode.changed 应带 scope.sessionId');
  eq(rows[0].kind, 'settings', '写点:mode.changed 的 kind 按词表应是 settings');
  assertFiveKeys(rows, '写点·挡位');
  db.close();
  dispose();
}

// ── 写点 4/5 + 5/5:人格 / 设置(settings-file.js) ───────────────────────────
// R2(P4C):`settings.changed` 的 `count` 口径以**当前代码行为**为准并在此钉住 ——
//   update(patch) ⇒ count = 本次 patch 的顶层键数;
//   reset()       ⇒ 同时发 persona.changed + settings.changed,
//                    后者的 count = Object.keys(DEFAULT_SETTINGS).length(写入默认值的顶层键数)。
{
  const { api, dispose } = boot();
  const sf = new SettingsFile(join(dir, 'set'));
  await sf.update({ persona: { enabled: true } });
  const rows1 = api.recent();
  eq(rows1.length, 1, '写点:settings.update(persona) 应发 1 条');
  eq(rows1[0].code, 'persona.changed', '写点:persona 子树应发 persona.changed');
  await sf.update({ styles: { tone: 'warm' } });
  eq(api.recent()[1]?.code, 'persona.changed', '写点:styles 子树也算人格层');
  await sf.update({ inject: { memoryEnabled: true } });
  eq(api.recent()[2]?.code, 'settings.changed', '写点:inject(总开关)应发 settings.changed');
  eq(api.recent()[2]?.kind, 'settings', '写点:settings.changed 的 kind 应是 settings');
  eq(api.recent()[2]?.count, 1, '写点:update(patch) 的 count 应是本次 patch 的顶层键数(R2)');
  // 两键 patch ⇒ count = 2(不是字节数、不是深合并后的键数)
  await sf.update({ inject: { away: false }, mode: { lastMode: 'work' } });
  const mixed = api.recent().at(-1);
  eq(mixed?.code, 'settings.changed', '写点:两键 patch 应发 settings.changed');
  eq(mixed?.count, 2, '写点:update 两键 patch 的 count 应是 2(R2)');
  const n = api.recent().length;
  await sf.reset();
  eq(api.recent().length, n + 2, '写点:reset 应发 persona.changed + settings.changed 两条');
  const tail = api.recent().slice(-2);
  eq(tail[0].code, 'persona.changed', '写点:reset 先发 persona.changed(R2:有意的)');
  eq(tail[1].code, 'settings.changed', '写点:reset 再发 settings.changed(R2:有意的)');
  eq(tail[1].count, Object.keys(DEFAULT_SETTINGS).length,
    '写点:reset 的 settings.changed.count 应是默认值顶层键数(R2)');
  const rows = api.recent();
  assertFiveKeys(rows, '写点·设置');
  dispose();
}

// ── 总:全部事件都不含内容文本(五键不变量扫一遍) ────────────────────────────
{
  const { api } = boot();
  bus.emitChange({ code: 'persona.changed', payload: { text: '人格正文' } });
  const rows = api.recent();
  assertFiveKeys(rows, '总');
  eq(JSON.stringify(rows).includes('人格正文'), false, '总:Change 里漏出了正文');
}

if (!ok) {
  console.error('\n有一项或多项失败');
  process.exitCode = 1;
} else {
  console.log('presence:全部通过 ✓');
}
