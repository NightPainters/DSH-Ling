// M4 · M 记忆锚(1.8.0):`ling_anchor` + `origin='ling'` 的开场排除与额度。
//
// 这套只钉 M4 的五条验收(DESIGN §2.6 第 1-5 条 / ALIGN:151-152),每条都带**回退会怎样红**:
//   A1 只构造 `origin='ling'` 的库 ⇒ 开场选择为空;`origin='user'` / `auto` 的行为一个字不变。
//   A2 `list` 只看 `origin='ling'`,可按 `convId` 过滤(判据必须落在 SQL 里 —— 只改调用侧会"静默不过滤")。
//   A3 每会话 ≤3、全局 ≤200;被拒时库内行数不变,回执给出 `3/3` 与"腾位"出路。
//   A4 幂等 = 四元组 (convId, seqFrom, seqTo, text);**同前 40 字、不同全文不得误拒**。
//   A5 不覆盖 `origin='user'`;写入不 `bumpDeepHit`;`retract` 不物理删行;写入不发 presence 事件。
// 边界:自建临时目录 + 临时库,不碰真库、不写源码树;失败不用 exit(0) 掩盖。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore, DEEP_RETRACTED } = await imp('lib/host/memory.js');
const { selectL1 } = await imp('lib/host/l1.js');
const { searchDeepItems } = await imp('lib/host/recall-search.js');
const { resetPresenceBus, recentChanges, emitChange } = await imp('lib/host/presence-bus.js');
const {
  registerLingTools, checkLingAnchor, renderLingAnchor, LING_ANCHOR_SPEC,
  TOOL_LING_ANCHOR, TOOL_DEEP_ITEM,
  LING_ANCHOR_KINDS, LING_ANCHOR_TEXT_MAX, ANCHOR_PER_CONV_MAX, ANCHOR_GLOBAL_MAX, LING_ANCHOR_ORIGIN,
} = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
const section = (t) => console.log('── ' + t);

/** 读一列 —— 行不存在时返回 `null` 而**不抛**(M-6:物理删行应当报 `✗`,不该是 TypeError 崩溃;
 *  崩了只证明"哪里炸了",证明不了"哪条判据命中了")。 */
const col = (store, id, key) => {
  const row = store.deepItemById(id);
  return row ? String(row[key] ?? '') : null;
};
const hasRow = (store, id) => store.deepItemById(id) !== undefined && store.deepItemById(id) !== null;

const dir = mkdtempSync(join(tmpdir(), 'ling-anchor-'));
const m = new MemoryStore(join(dir, 'a.db'));
// 设置门面只需要能 `get()`:离场/定型两条门都是 fail-open,空对象 = 在场、未定型。
const settings = { get: () => ({}) };

/** 一次「纯对象注册」:拿真的 spec 列表(不实例化宿主 Tools)。 */
function mount(store) {
  const registered = [];
  const ctx = { tools: { register: (spec) => { registered.push(spec); return () => {}; } } };
  const r = registerLingTools(ctx, { gate: { snapshotIds: () => [] }, memory: store, settings });
  return { r, registered, tool: (name) => registered.find((s) => s.name === name) };
}

const reg = mount(m);
const anchor = reg.tool(TOOL_LING_ANCHOR);
const deepTool = reg.tool(TOOL_DEEP_ITEM);
const call = (args) => anchor.execute(args, {});

// ─────────────────────────────────────────────────────────────────────────────────────
section('0) 契约面:名字 / 常量 / 说明面与 deep_item 分工');
eq(LING_ANCHOR_SPEC.name, 'ling_anchor', 'M0:工具名 ling_anchor');
check(TOOL_LING_ANCHOR === 'ling_anchor', 'M0:TOOL_LING_ANCHOR 常量');
eq(reg.r.ok, true, 'M0:registerLingTools 成功(桩 ctx)');
check(!!anchor && typeof anchor.execute === 'function', 'M0:ling_anchor 在注册列表里(可执行)');
eq(ANCHOR_PER_CONV_MAX, 3, 'M0:每会话上限 3');
eq(ANCHOR_GLOBAL_MAX, 200, 'M0:全局上限 200');
eq(LING_ANCHOR_TEXT_MAX, 80, 'M0:正文上限 80 字');
check(LING_ANCHOR_KINDS.join(',') === '偏好,承诺,关系,决定', 'M0:四类 = 偏好/承诺/关系/决定(实际 ' + LING_ANCHOR_KINDS.join(',') + ')');
check(LING_ANCHOR_ORIGIN === 'ling', 'M0:origin 字面量 = ling');
// 与 deep_item 的说明必须是**两份**(deep_item 写的是"落条是经主人授权的动作",锚不能照抄那句)
check(!/落条是"经主人授权"的动作/.test(LING_ANCHOR_SPEC.description),
  'M0:锚的 description 不复用 deep_item 的"落条是经主人授权的动作"口径(自述锚是她本侧的动作)');
check(/不会进开场|不进开场/.test(LING_ANCHOR_SPEC.description), 'M0:说明里写明默认不进开场');
check(/升格/.test(LING_ANCHOR_SPEC.description), 'M0:说明里写明要进开场得由主人升格');
// M-3:额度与 R3 归因都锚在调用方给的 `convId` 上 ⇒ 说明面必须把"这是自律闸"写死,不许假装是硬闸。
check(/自律闸/.test(LING_ANCHOR_SPEC.description), 'M-3:说明里写明额度是**自律闸**');
check(/由调用方|由你/.test(LING_ANCHOR_SPEC.description), 'M-3:说明里写明 convId 由调用方提供');
// M-4:DESIGN R2 的两条升格路(改 origin / 置顶)都要在说明面出现 —— 不许把两条悄悄收成一条。
check(/置顶/.test(LING_ANCHOR_SPEC.description), 'M-4:说明里写明"置顶"是第二条升格路');
check(/origin/.test(LING_ANCHOR_SPEC.description) && /user\/auto|origin=user|origin 改成/.test(LING_ANCHOR_SPEC.description),
  'M-4:说明里写明"改 origin"是第一条升格路');
// M-2:三种"库里已有一行同四元组"的分支必须出现在说明面(否则模型只知道 existed=true 一种)
check(/existed-other-origin/.test(LING_ANCHOR_SPEC.description), 'M-2:说明里点名 existed-other-origin(别人的行占着四元组)');
check(/已作废/.test(LING_ANCHOR_SPEC.description), 'M-2:说明里写明"已作废的同四元组不算重放"');
check(Array.isArray(LING_ANCHOR_SPEC.parameters?.required) && LING_ANCHOR_SPEC.parameters.required.includes('action'),
  'M0:参数 required 含 action');

// ─────────────────────────────────────────────────────────────────────────────────────
section('1) 参数自校验(纯函数)');
eq(checkLingAnchor({}).reason, 'empty-kind', 'P1:空参数 ⇒ 缺省 action=add,先撞 empty-kind');
eq(checkLingAnchor({ kind: '偏好', text: 'x', convId: 'c', seqFrom: 1 }).action, 'add', 'P1:缺省 action 就是 add');
eq(checkLingAnchor({ action: 'nope' }).reason, 'bad-action', 'P1:未知 action → bad-action');
eq(checkLingAnchor({ action: 'add', kind: '事实', text: 'x', convId: 'c', seqFrom: 1 }).reason, 'bad-kind',
  'P1:kind 不在四类(「事实」是 deep_item 的类别,不是锚)→ bad-kind');
eq(checkLingAnchor({ action: 'add', kind: '偏好', text: 'x'.repeat(LING_ANCHOR_TEXT_MAX + 1), convId: 'c', seqFrom: 1 }).reason,
  'too-long', 'P1:正文超 80 字 → too-long(不自动截断)');
eq(checkLingAnchor({ action: 'add', kind: '偏好', text: '   ', convId: 'c', seqFrom: 1 }).reason, 'empty-text', 'P1:空正文 → empty-text');
eq(checkLingAnchor({ action: 'add', kind: '偏好', text: 'x', seqFrom: 1 }).reason, 'no-conv',
  'P1:缺 convId → no-conv(额度按会话算,缺了就退化成"全局 ≤3")');
eq(checkLingAnchor({ action: 'add', kind: '偏好', text: 'x', convId: 'c' }).reason, 'no-seq',
  'P1:缺 seqFrom → no-seq(原文下钻不上)');
const p1 = checkLingAnchor({ action: 'add', kind: '偏好', text: '我习惯先给结论', convId: ' c1 ', seqFrom: 7 });
eq(p1.ok, true, 'P1:合法 add 通过');
eq(p1.seqTo, 7, 'P1:seqTo 缺省 = seqFrom');
eq(p1.convId, 'c1', 'P1:convId 去空格');
eq(p1.durability, 'long', 'P1:durability 默认 long');
eq(checkLingAnchor({ action: 'add', kind: '偏好', text: 'x', convId: 'c', seqFrom: 1, durability: 'forever' }).reason,
  'bad-durability', 'P1:非法 durability → bad-durability');
eq(checkLingAnchor({ action: 'retract' }).reason, 'no-id', 'P1:retract 缺 id → no-id');
eq(checkLingAnchor({ action: 'retract', id: 'di:x', reason: '三个字' }).reason, 'no-reason',
  'P1:作废理由 <4 字 → no-reason');
eq(checkLingAnchor({ action: 'retract', id: 'di:x', reason: '这条不成立了' }).ok, true, 'P1:作废理由 ≥4 字通过');
eq(checkLingAnchor({ action: 'list' }).includeSuperseded, false, 'P1:list 默认不显示已退役');
eq(checkLingAnchor({ action: 'list' }).limit, 50, 'P1:list 默认 50 条');

// ─────────────────────────────────────────────────────────────────────────────────────
section('2) add:落库 origin=ling / 回执三件事 / 不打 presence / 不加固');
resetPresenceBus();
eq(recentChanges().length, 0, 'A-presence:复位后总线是空的');
// ⚠️ M-5(正对照):先造一条**真**事件,证明"总线在记" —— 否则下面那句 `=== 0` 是恒真断言
//   (hook 没挂 / 模块形态变了,它照样绿;verify §7.2 实测过这个坑)。
eq(emitChange({ code: 'memory.forgotten', scope: { sessionId: 'sess-l' } }).ok, true,
  'A-presence:正对照 —— emitChange 成功(总线确实在记事件)');
const presenceBase = recentChanges().length;
eq(presenceBase, 1, 'A-presence:正对照 —— 基线 = 1(非恒真)');
const a1 = await call({ kind: '偏好', text: '我习惯先给结论,再给理由', convId: 'sess-l', seqFrom: 1 });
eq(a1.ok, true, 'A-add:第一条落库');
eq(a1.existed, false, 'A-add:首次写入 existed=false');
eq(col(m, a1.id, 'origin'), 'ling', 'A-add:库里 origin=ling');
eq(col(m, a1.id, 'durability'), 'long', 'A-add:durability 默认 long');
eq(col(m, a1.id, 'hit_count'), '0', 'A-add:写入不加固(hit_count=0)');
eq(col(m, a1.id, 'conv_id'), 'sess-l', 'A-add:conv_id 落对');
eq(col(m, a1.id, 'seq_from'), '1', 'A-add:seq_from 落对');
eq(col(m, a1.id, 'seq_to'), '1', 'A-add:seq_to 缺省 = seqFrom');
const txt1 = renderLingAnchor(a1);
check(/origin=ling/.test(txt1), 'A-add 回执:自报 origin=ling');
check(/不会进开场/.test(txt1), 'A-add 回执:自报"不会进开场"');
check(/本会话已用 1\/3/.test(txt1), 'A-add 回执:自报本会话已用 1/3(实际回执:' + txt1 + ')');
check(/升格/.test(txt1), 'A-add 回执:自报"若要进开场请主人升格"');
check(/置顶/.test(txt1), 'M-4:回执写明升格第二条路"置顶"');
check(/由调用方提供/.test(txt1) && /自律闸/.test(txt1),
  'M-3:回执自报 convId 由调用方提供、额度是自律闸(实际回执:' + txt1 + ')');
eq(recentChanges().length, presenceBase,
  'A-add:写入**不发** presence 事件(基线 1 条真事件,写入后仍是 1 —— 不是"总线空了"的恒真)');
// 开场选择跑过之后仍然 hit_count=0(注入不加分)
selectL1(m, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
eq(col(m, a1.id, 'hit_count'), '0', 'A-add:进过选择器后 hit_count 仍是 0(注入不算采用)');

// ─────────────────────────────────────────────────────────────────────────────────────
section('3) 幂等:四元组重复 ⇒ existed;同前 40 字不同全文 ⇒ **必须写进去**');
const before2 = m.deepItemCount();
const a2 = await call({ kind: '偏好', text: '我习惯先给结论,再给理由', convId: 'sess-l', seqFrom: 1 });
eq(a2.existed, true, 'A4:四元组完全重复 → existed=true');
eq(a2.id, a1.id, 'A4:重复返回同一个 id');
eq(m.deepItemCount(), before2, 'A4:重复**没有**多写一行');
check(/已经在库里/.test(renderLingAnchor(a2)), 'A4:回执说明"已经在库里,没有重复写"');
// ⚠️ 这条专打"前 40 字"被误用成硬闸:两句话前 40 字相同、结尾不同 ⇒ 两条都该在库里。
const head = '这是一句我自己立下的锚,前半句故意写得一模一样好用来试探幂等判据的边界在哪里,后半句才开始分岔';
check([...head].length >= 40, 'A4:前 40 字相同的前缀素材够长');
const t1 = head + '——结尾甲';
const t2 = head + '——结尾乙';
const a3 = await call({ kind: '关系', text: t1, convId: 'sess-r', seqFrom: 2 });
const a4 = await call({ kind: '关系', text: t2, convId: 'sess-r', seqFrom: 2 });
eq(a3.existed, false, 'A4:同 conv+seq、全文甲 → 写入');
eq(a4.existed, false, 'A4:同 conv+seq、前 40 字相同但全文乙 → **仍写入**(不得因前 40 字误拒)');
check(a3.id !== a4.id, 'A4:两条各有自己的 id');
eq(m.listDeepItems({ origin: 'ling', convId: 'sess-r', limit: 10 }).length, 2,
  'A4:同轮次的两条不同全文都在库里(2 条)');
// 同正文、不同 seq ⇒ 四元组不同 ⇒ 也是新行
const a5 = await call({ kind: '关系', text: t1, convId: 'sess-r', seqFrom: 3 });
eq(a5.existed, false, 'A4:同正文、不同 seqFrom → 四元组不同 → 写入');
// ⚠️ M-2(a):**作废后同四元组重放**。作废 = 腾位(回执原话"这一条不再占额度"),那么同文本
//   重放必须能真的再写一条;旧行留痕不删。修前这里会回 existed=true 指向**已作废**的行
//   —— 模型看到"已经在库里"+"本会话 2/3",两句话都真、合起来是假的。
{
  const rowsBeforeReplay = m.deepItemCount();
  const rp = await call({ action: 'retract', id: a3.id, reason: '这条关系判断不成立了' });
  eq(rp.ok, true, 'M-2:先作废 a3(腾出一个位)');
  eq(m.deepItemCountByOrigin('ling', { convId: 'sess-r' }), 2, 'M-2:作废后本会话在役 2 条');
  const replay = await call({ kind: '关系', text: t1, convId: 'sess-r', seqFrom: 2 });
  eq(replay.ok, true, 'M-2:作废后同四元组重放 → ok');
  eq(replay.existed, false, 'M-2:退役行**不算**"已存在"(否则腾位是句空话)');
  check(replay.id !== a3.id, 'M-2:新锚拿到**新的** id(不是那条退役行)');
  eq(replay.revivedRetired, true, 'M-2:回执自报"同文本的旧锚已作废,这一条是新写的"');
  eq(replay.retiredId, String(a3.id), 'M-2:回执点名旧锚的 id');
  eq(m.deepItemCount(), rowsBeforeReplay + 1, 'M-2:重放**真的**多了一行(旧行不删)');
  eq(col(m, a3.id, 'superseded_by'), DEEP_RETRACTED, 'M-2:旧锚仍是退役留痕');
  const liveSame = m.listDeepItems({ origin: 'ling', convId: 'sess-r', limit: 10 })
    .filter((r) => Number(r.seq_from) === 2 && Number(r.seq_to) === 2 && String(r.text) === t1);
  eq(liveSame.length, 1, 'M-2:同四元组**在役**只有 1 条(退役行不算:不出现两条都算数)');
  if (liveSame.length === 1) {
    eq(String(liveSame[0].id), String(replay.id), 'M-2:在役的是新写的那条');
  } else {
    check(false, 'M-2:在役条数不等于 1,无法比对 id(实际 ' + liveSame.length + ' 条)');
  }
  check(/新写的/.test(renderLingAnchor(replay)), 'M-2:回执说明"旧锚已作废、这条是新写的"');
  eq(m.deepItemCountByOrigin('ling', { convId: 'sess-r' }), 3, 'M-2:重放后本会话回到 3 条在役');
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('4) 每会话 ≤3:第 4 条拒写,回执给 3/3 与"腾位"出路');
const quota = await call({ kind: '决定', text: '这个会话里的第三条锚', convId: 'sess-q', seqFrom: 3 });
eq(quota.ok, true, 'A3:第 1 条成功');
await call({ kind: '承诺', text: '承诺一', convId: 'sess-q', seqFrom: 4 });
await call({ kind: '偏好', text: '偏好一', convId: 'sess-q', seqFrom: 5 });
eq(m.deepItemCountByOrigin('ling', { convId: 'sess-q' }), 3, 'A3:本会话已有 3 条在役锚');
const rowsBefore = m.deepItemCount();
const over = await call({ kind: '决定', text: '第四条应当被拒', convId: 'sess-q', seqFrom: 6 });
eq(over.ok, false, 'A3:第 4 条被拒');
eq(over.reason, 'quota-session', 'A3:拒因 = quota-session');
eq(over.used, 3, 'A3:回执自报 used=3');
eq(over.max, 3, 'A3:回执自报 max=3');
check(/3\/3/.test(String(over.message)), 'A3:拒写说明里有 3/3');
check(/retract/.test(String(over.message)) && /换会话/.test(String(over.message)),
  'A3:拒写说明给出"要腾位请 retract 或换会话"');
eq(m.deepItemCount(), rowsBefore, 'A3:被拒时库内行数不变(没写)');
// 另一个会话不受影响(额度是按会话算的,不是全局 3)
const other = await call({ kind: '决定', text: '换个会话就还能落', convId: 'sess-q2', seqFrom: 1 });
eq(other.ok, true, 'A3:另一个会话照常可写(额度按会话)');
// 作废一条 ⇒ 腾出一个位
const first = m.listDeepItems({ origin: 'ling', convId: 'sess-q', limit: 10 })[0];
const rq = await call({ action: 'retract', id: first.id, reason: '这条不再成立' });
eq(rq.ok, true, 'A3:先作废一条');
eq(m.deepItemCountByOrigin('ling', { convId: 'sess-q' }), 2, 'A3:作废后本会话在役 2 条(额度只数在役的)');
const after = await call({ kind: '决定', text: '腾出位之后就能落', convId: 'sess-q', seqFrom: 7 });
eq(after.ok, true, 'A3:腾位后第 4 条能写');

// ─────────────────────────────────────────────────────────────────────────────────────
section('5) 全局 ≤200:第 201 条拒写(另起一个库,不污染上文的用例)');
{
  const m2 = new MemoryStore(join(dir, 'quota.db'));
  const g = mount(m2);
  const call2 = (args) => g.tool(TOOL_LING_ANCHOR).execute(args, {});
  let wrote = 0;
  for (let i = 0; i < ANCHOR_GLOBAL_MAX; i += 1) {
    const r = await call2({ kind: '偏好', text: '全局额度第 ' + (i + 1) + ' 条', convId: 'conv-' + i, seqFrom: 1 });
    if (r.ok) wrote += 1;
  }
  eq(wrote, ANCHOR_GLOBAL_MAX, 'A3:全局正好写入 200 条');
  eq(m2.deepItemCountByOrigin('ling'), ANCHOR_GLOBAL_MAX, 'A3:全局在役计数 = 200');
  const beforeG = m2.deepItemCount();
  const overG = await call2({ kind: '偏好', text: '第 201 条应当被拒', convId: 'conv-fresh', seqFrom: 1 });
  eq(overG.ok, false, 'A3:第 201 条被拒');
  eq(overG.reason, 'quota-global', 'A3:拒因 = quota-global(不是 quota-session)');
  eq(overG.used, ANCHOR_GLOBAL_MAX, 'A3:回执自报 used=200');
  eq(overG.max, ANCHOR_GLOBAL_MAX, 'A3:回执自报 max=200');
  eq(m2.deepItemCount(), beforeG, 'A3:被拒时库内行数不变');
  try { m2.db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('6) list:只看 origin=ling + 按 convId 过滤 + includeSuperseded');
{
  const m3 = new MemoryStore(join(dir, 'list.db'));
  const g = mount(m3);
  const call3 = (args) => g.tool(TOOL_LING_ANCHOR).execute(args, {});
  const deep3 = (args) => g.tool(TOOL_DEEP_ITEM).execute(args, {});
  const l1 = await call3({ kind: '偏好', text: '会话 l 的锚', convId: 'sess-l', seqFrom: 1 });
  await call3({ kind: '偏好', text: '会话 m 的锚', convId: 'sess-m', seqFrom: 1 });
  // ⚠️ 这里必须显式给 `seqTo: 9`:deep_item 的 `seqTo` 缺省是 0,而锚缺省 = seqFrom ⇒ 不给就
  //   天然不撞四元组(review M-1 记的"口径不对称";本轮只把它当既有事实,不在这里改口径)。
  const u1 = await deep3({ kind: '偏好', text: '主人手写的一条(origin=user)', convId: 'sess-l', seqFrom: 9, seqTo: 9 });
  eq(u1.ok, true, 'A2:先由 deep_item 落一条 origin=user(对照)');
  // ⚠️ 最危险的假绿:只改调用侧、SQL 不认参数 ⇒ 不报错但不过滤。故断言是**精确条数**。
  eq(m3.listDeepItems({ origin: 'ling', limit: 100 }).length, 2,
    'A2:listDeepItems 的 origin 判据**真落在 SQL 里**(传 {origin:ling} 只回 2 条,不回 3 条)');
  const allL = await call3({ action: 'list' });
  eq(allL.ok, true, 'A2:list 成功');
  eq(allL.shown, 2, 'A2:list 不含 origin=user');
  eq(allL.all, 2, 'A2:在役数 = 2');
  eq(allL.items.every((r) => r.kind && r.id), true, 'A2:list 行带 id/kind(deepItemView 单一来源)');
  const byConv = await call3({ action: 'list', convId: 'sess-l' });
  eq(byConv.shown, 1, 'A2:按 convId 过滤后只剩 1 条');
  eq(String(byConv.items[0].conv_id), 'sess-l', 'A2:过滤出来的果然是 sess-l 那条');
  // ⚠️ M-2(b):同四元组撞上 **origin=user** 的行。工具侧只探 origin=ling(探不到),存储层的判据
  //   却是 origin 无关 ⇒ 会回 existed=true。回执**必须**与"在役锚已存在"区分开:否则模型看到
  //   "已经在库里"+ id 指向一条 list 里永远看不见的 user 行,就会进"说存在但列不出"的循环。
  {
    const userText = '主人手写的一条(origin=user)';
    const q = await call3({ kind: '偏好', text: userText, convId: 'sess-l', seqFrom: 9 });
    eq(q.ok, true, 'M-2:撞上 user 行的调用本身不报错');
    eq(q.existed, true, 'M-2:存储层判据 origin 无关 ⇒ existed=true(这是**既有**口径,没改)');
    eq(q.reason, 'existed-other-origin', 'M-2:回执带 reason=existed-other-origin(与"在役锚已存在"可区分)');
    eq(q.existingOrigin, 'user', 'M-2:回执点名占位者的 origin=user');
    eq(q.id, u1.id, 'M-2:回执里的 id 指向那条 user 行(不是锚)');
    check(/没有落库/.test(renderLingAnchor(q)), 'M-2:回执明说"这条锚没有落库"');
    check(/看不到/.test(renderLingAnchor(q)), 'M-2:回执提醒"list 里看不到它"');
    eq(m3.deepItemCountByOrigin('ling', { convId: 'sess-l' }), 1, 'M-2:本会话在役锚仍是 1(位子没被占)');
    eq(m3.deepItemCount(), 3, 'M-2:总行数不增(锚没写进去,user 行也没多)');
    eq(col(m3, u1.id, 'text'), userText, 'M-2:user 行正文一字未动');
    eq(col(m3, u1.id, 'origin'), 'user', 'M-2:user 行 origin 仍是 user');
  }
  // 作废后:默认看不见、includeSuperseded 看得见且仍标 retracted
  const rr = await call3({ action: 'retract', id: l1.id, reason: '这条不成立了' });
  eq(rr.ok, true, 'A2:作废一条锚');
  const afterDef = await call3({ action: 'list' });
  eq(afterDef.shown, 1, 'A2:作废后默认列表少一条');
  eq(afterDef.retired, 1, 'A2:回执单独报 retired=1');
  const afterInc = await call3({ action: 'list', includeSuperseded: true });
  eq(afterInc.shown, 2, 'A2:includeSuperseded:true 仍看得见(复盘视图)');
  const retRow = afterInc.items.find((r) => r.id === l1.id);
  check(!!retRow, 'A2:退役行仍在列表里(不物理删)');
  eq(retRow ? String(retRow.superseded_by) : null, 'retracted', 'A2:退役行标 superseded_by=retracted');
  check(/已作废/.test(renderLingAnchor(afterInc)), 'A2:list 回执标出"[已作废]"');
  try { m3.db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('7) retract:不删行 / 留痕 / already-retired / 只作废自己的锚');
{
  const victim = await call({ kind: '承诺', text: '这条待会儿会被作废', convId: 'sess-v', seqFrom: 1 });
  const totalBefore = m.deepItemCount();
  const retiredBefore = m.deepRetiredCount();
  // 不是锚的行不许被 ling_anchor 作废(origin='user' 的主人手写位)
  const uu = await deepTool.execute({ kind: '偏好', text: '主人手写,别动它', convId: 'sess-v', seqFrom: 2 }, {});
  eq(uu.ok, true, 'A5:deep_item 落一条 origin=user');
  const wrong = await call({ action: 'retract', id: uu.id, reason: '想把主人手写的也作废' });
  eq(wrong.ok, false, 'A5:ling_anchor 拒绝对非 ling 条目动手');
  eq(wrong.reason, 'not-anchor', 'A5:拒因 = not-anchor');
  eq(col(m, uu.id, 'origin'), 'user', 'A5:主人手写的 origin 仍是 user(一个字没动)');
  // 正常作废
  const ret = await call({ action: 'retract', id: victim.id, reason: '这条承诺已经兑现完了' });
  eq(ret.ok, true, 'A5:作废成功');
  // ⚠️ M-6:先做空保护再断言 —— 物理删行那条变异下,这里必须报 `✗`(判据命中),
  //   不能因为属性读到 undefined 抛 TypeError 崩掉(崩了证明不了判据在哪)。
  eq(col(m, victim.id, 'superseded_by'), DEEP_RETRACTED, 'A5:标的是哨兵 retracted(行必须还在)');
  check(hasRow(m, victim.id), 'A5:**行仍在库里**(不物理删)');
  eq(m.deepItemCount(), totalBefore + 1, 'A5:总行数只因为多了一条 user 行而 +1(作废不删行)');
  eq(m.deepRetiredCount(), retiredBefore + 1, 'A5:退役计数 +1');
  const rlog = (() => { try { return JSON.parse(String(m.kvGet('deep.retract:' + victim.id))); } catch { return {}; } })();
  eq(rlog.reason, '这条承诺已经兑现完了', 'A5:理由落到 kv deep.retract:<id>');
  eq(String(rlog.by), 'ling', 'A5:留痕记 by=ling(谁作废的)');
  check(!m.listDeepItems({ origin: 'ling' }).some((r) => r.id === victim.id), 'A5:默认读路径不再挑它');
  check(m.listDeepItems({ origin: 'ling', includeSuperseded: true }).some((r) => r.id === victim.id),
    'A5:includeSuperseded:true 仍看得见(复盘视图)');
  const inRecall = searchDeepItems(m, '这条待会儿会被作废', 12);
  check(!(inRecall || []).some((r) => String(r.id) === String(victim.id)), 'A5:recall 不再返回它');
  const again = await call({ action: 'retract', id: victim.id, reason: '再作废一次试试' });
  eq(again.ok, false, 'A5:重复作废被拒');
  eq(again.reason, 'already-retired', 'A5:拒因 = already-retired');
  eq((() => { try { return JSON.parse(String(m.kvGet('deep.retract:' + victim.id))).reason; } catch { return null; } })(),
    '这条承诺已经兑现完了', 'A5:先前理由**没被盖掉**');
  const nf = await call({ action: 'retract', id: 'di:nope', reason: '这条不存在' });
  eq(nf.reason, 'not-found', 'A5:作废不存在的 id → not-found');
  // 主人手写那条一笔没变
  eq(col(m, uu.id, 'text'), '主人手写,别动它', 'A5:user 行正文没被覆盖');
  check(hasRow(m, uu.id), 'A5:user 行仍在(没被删)');
  eq(m.listDeepItems({ origin: 'user', limit: 10 }).some((r) => String(r.id) === String(uu.id)), true,
    'A5:user 行原样可读');
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('8) 开场排除:只有 origin=ling 的库 ⇒ 开场为空;user/auto 行为不变');
{
  const m4 = new MemoryStore(join(dir, 'open.db'));
  m4.addDeepItem({ kind: '偏好', text: '只有锚的库里这一条不该进开场', convId: 'sess-ling', seqFrom: 1, seqTo: 1, origin: 'ling' });
  m4.addDeepItem({ kind: '承诺', text: '这一条也是锚', convId: 'sess-ling', seqFrom: 2, seqTo: 2, origin: 'ling' });
  const r1 = selectL1(m4, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
  eq(r1.items.length, 0, 'A1:只构造 origin=ling ⇒ 开场选择为空');
  eq(r1.excluded.origin, 2, 'A1:两条都被记进 excluded.origin(主动排除,不是静默消失)');
  eq(m4.deepItemCount(), 2, 'A1:库里行仍在(**排除不是删除**)');
  check(m4.listDeepItems({ origin: 'ling', limit: 10 }).length === 2, 'A1:list/recall 那一侧照旧看得见');
  // 对照:user / auto 照旧进开场
  const uu = m4.addDeepItem({ kind: '偏好', text: '主人手写的一条偏好', convId: 'sess-u', seqFrom: 1, seqTo: 1, origin: 'user' });
  const av = m4.addDeepItem({ kind: '偏好', text: '自动提炼的一条偏好', convId: 'sess-a', seqFrom: 1, seqTo: 1, origin: 'auto' });
  const r2 = selectL1(m4, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
  const ids = r2.items.map((i) => String(i.id));
  eq(r2.excluded.origin, 2, 'A1:user/auto 的条目没有被 origin 判据吃掉(仍是 2)');
  check(ids.includes(uu.id) && ids.includes(av.id), 'A1:origin=user / auto 照旧进开场(items=' + ids.join(',') + ')');
  // 升格(改 origin)之后就能进开场 —— 这是"要进开场请主人升格"的可执行含义
  m4.db.prepare("UPDATE deep_item SET origin='user' WHERE conv_id='sess-ling'").run();
  const r3 = selectL1(m4, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
  eq(r3.items.length, 4, 'A1:升格后 4 条都参与开场选择');
  eq(r3.excluded.origin, 0, 'A1:升格后不再有 origin 排除');
  try { m4.db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('9) 不覆盖 user(M-1):同四元组的 ling 写入不碰 user 行');
// DESIGN §2.5 的禁令:自述锚不许覆盖/删除主人的条目。修前这条性质**零覆盖**
// (M5 变异下 D1 红在同轮次两条不同全文那一格,是误中)。这里逐列钉:
//   user 行 `(sess-x, 1, 1, T)` 先落 → ling_anchor 用**逐位相同**的四元组再写一次。
{
  const m5 = new MemoryStore(join(dir, 'user-guard.db'));
  const g = mount(m5);
  const call5 = (args) => g.tool(TOOL_LING_ANCHOR).execute(args, {});
  const deep5 = (args) => g.tool(TOOL_DEEP_ITEM).execute(args, {});
  const T = '主人手写的这条偏好不能被自述锚顶掉';
  const u = await deep5({ kind: '偏好', text: T, convId: 'sess-x', seqFrom: 1, seqTo: 1 });
  eq(u.ok, true, 'M-1:deep_item 先落一条 origin=user(四元组 sess-x/1/1)');
  eq(col(m5, u.id, 'origin'), 'user', 'M-1:对照行确实是 origin=user');
  const snap = {};
  for (const k of ['text', 'origin', 'updated_at', 'superseded_by', 'hit_count', 'kind', 'durability']) {
    snap[k] = col(m5, u.id, k);
  }
  const rowsBefore = m5.deepItemCount();
  const l = await call5({ kind: '承诺', text: T, convId: 'sess-x', seqFrom: 1, seqTo: 1 });
  eq(l.ok, true, 'M-1:同四元组的 ling 写入调用成功返回(不是异常)');
  eq(l.existed, true, 'M-1:存储层判据 origin 无关 ⇒ existed=true');
  eq(l.reason, 'existed-other-origin', 'M-1:回执点名"占位的是别人的行"(M-2 的另一半)');
  eq(l.existingOrigin, 'user', 'M-1:回执报的占位者 origin=user');
  eq(l.id, u.id, 'M-1:回执里的 id 指向那条 user 行');
  // 逐列:一个字都不许动
  for (const k of ['text', 'origin', 'updated_at', 'superseded_by', 'hit_count', 'kind', 'durability']) {
    eq(col(m5, u.id, k), snap[k], 'M-1:user 行 ' + k + ' 逐列未变(没有任何 UPDATE)');
  }
  eq(m5.deepItemCountByOrigin('ling', { convId: 'sess-x' }), 0, 'M-1:ling 在役计数仍是 0(一条也没落进去)');
  eq(m5.deepItemCount(), rowsBefore, 'M-1:总行数不增(没有多写一行)');
  eq(m5.listDeepItems({ origin: 'user', limit: 10 }).length, 1, 'M-1:user 行原样可读');
  check(/没有落库/.test(renderLingAnchor(l)), 'M-1:回执明说"这条锚没有落库"(不许说"已经在库里")');
  try { m5.db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────
section('10) 置顶升格(M-4):pinned 的 ling 锚进开场,未置顶的仍被排除');
// DESIGN R2 给了**两条**升格路:改 origin **或置顶**。修前 `origin==='ling'` 的 `continue`
// 在 pinned 之前且无条件 ⇒ 置顶的锚照样进不了开场,第二条路是句空话。
{
  const m6 = new MemoryStore(join(dir, 'pinned.db'));
  const plain = m6.addDeepItem({ kind: '偏好', text: '未置顶的锚不该进开场', convId: 's-pin', seqFrom: 1, seqTo: 1, origin: 'ling' });
  const pin = m6.addDeepItem({ kind: '承诺', text: '置顶的锚应当进开场', convId: 's-pin', seqFrom: 2, seqTo: 2, origin: 'ling' });
  eq(m6.setDeepPinned(pin.id, true).ok, true, 'M-4:把其中一条锚置顶(pinned=1)');
  const out = selectL1(m6, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
  const ids = out.items.map((i) => String(i.id));
  check(ids.includes(String(pin.id)), 'M-4:置顶的 ling 锚**进开场**(DESIGN R2 的第二条升格路,items=' + ids.join(',') + ')');
  check(!ids.includes(String(plain.id)), 'M-4:未置顶的 ling 锚仍不进开场');
  eq(out.excluded.origin, 1, 'M-4:excluded.origin 只数未置顶的那 1 条(置顶不算"被排除")');
  const chosen = out.items.find((i) => String(i.id) === String(pin.id));
  eq(chosen ? chosen.pinned : null, true, 'M-4:它在开场里仍带 pinned=true(置顶语义没丢)');
  eq(m6.deepItemCount(), 2, 'M-4:两行都还在库里(排除不是删除)');
  // 取消置顶 ⇒ 回到"不进开场"(证明上面那条进开场确实是**置顶**带来的,不是别的原因)
  m6.setDeepPinned(pin.id, false);
  const back = selectL1(m6, { mode: 'life', keywords: [], maxItems: 8, budgetChars: 6000 });
  eq(back.items.length, 0, 'M-4:取消置顶后两条都不进开场');
  eq(back.excluded.origin, 2, 'M-4:取消置顶后两条都记进 excluded.origin');
  try { m6.db.close(); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────
try { m.db.close(); } catch { /* 关不掉不影响结论 */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶发占用,留给系统清 */ }
console.log(ok ? '✓ ling-anchor 全部通过' : '✗ ling-anchor 有失败');
process.exit(ok ? 0 : 1);
