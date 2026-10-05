// tests/client-batch.test.mjs — V1(2026-09-29 导入批失败 4MiB)
// 目的:直接验【真实源码】lib/client.js 里的 takeChunk / utf8Len 行为 —— 不在测试里照抄一份实现。
//
// 选路 (a):factory 内 exports.__test__ 钩子 + tests/vm-light.mjs 的 contextify() 加载 lib/client.js。
// 理由:
//   1) 与 tests/unit.mjs:341 走的是同一条加载路径(本仓既有先例),不引入第二种加载器;
//   2) 抠源码文本(方案 b)只能验"我抠出来的那段",改线时正则一漂就静默失配;__test__ 拿的是
//      真正被 bGo.onclick 调用的那一个函数对象,语义零漂移;
//   3) 方案 (a) 的代价是沙箱白名单缺全局 —— 本文件【在测试侧】补桩,不动生产代码,不改 vm-light
//      (它被另外 30+ 个用例共用)。utf8Len 手写 code-point 计数,故不需要补 TextEncoder。
import { readFileSync } from 'node:fs';
import { ok, eq, section, summary } from './harness.mjs';
import { contextify } from './vm-light.mjs';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 最小 DOM/fetch 桩(与 tests/unit.mjs:308-326 同形,只保留本文件需要的部分)----
const elStub = () => ({
  style: {}, dataset: {}, children: [], textContent: '', className: '', id: '',
  appendChild(c) { this.children.push(c); return c; }, remove() {},
  addEventListener() {}, removeEventListener() {}, click() {}, setAttribute() {},
});
const doc = {
  createElement: elStub,
  createStyleSheet: () => ({ cssRules: [] }),
  documentElement: { getAttribute: () => 'light' },
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
const win = { __ModuleLoader__: { load() {} }, addEventListener() {}, removeEventListener() {} };

const out = await contextify(src, {
  window: win,
  document: doc,
  fetch: async () => ({ ok: false, status: 413, json: async () => null }),
});
const T = out && out.__test__;

await section('V1 钩子可达(方案 a:真源码 + contextify)');
ok(!!T, 'exports.__test__ 存在于 client.js 导出面');
ok(T && typeof T.takeChunk === 'function', '取到真实 takeChunk');
ok(T && typeof T.utf8Len === 'function', '取到真实 utf8Len');
if (!T || typeof T.takeChunk !== 'function' || typeof T.utf8Len !== 'function') {
  console.error('  ✗ 测试钩子不可用,后续断言无意义');
  summary();
  process.exit(1);
}
const LIMIT = T.BATCH_MAX_BYTES;
const MAXI = T.BATCH_MAX_ITEMS;
console.log(`    实测常量:BATCH_MAX_BYTES=${LIMIT} · BATCH_MAX_ITEMS=${MAXI}`);

// 契约口径的独立复算(不是实现副本:只按"stringify UTF-8 字节 + 1/条 + 2 封套"重算一遍,用来对照 takeChunk 自报的 bytes)
const recount = (list) => 2 + list.reduce((a, it) => a + T.utf8Len(JSON.stringify(it)) + 1, 0);
// 走完整个数组:顺带断言"前进性"(空批 / next 不前进 ⇒ 立即红,而不是挂死)
function drain(items) {
  const batches = [];
  let from = 0, guard = 0;
  while (from < items.length) {
    const c = T.takeChunk(items, from);
    if (!c.list.length) throw new Error('切出空批(from=' + from + ') ⇒ 调用方死循环');
    if (c.next <= from) throw new Error('next 未前进(from=' + from + ' next=' + c.next + ')');
    batches.push(c);
    from = c.next;
    if (++guard > items.length + 5) throw new Error('批次数异常');
  }
  return batches;
}

// ---------------------------------------------------------------- T1
await section('T1 utf8Len 精确性(CJK / emoji / 引号反斜杠 / 空串 / 控制字符 / 混合)');
const control = String.fromCharCode(1) + String.fromCharCode(0x1f) + String.fromCharCode(0x7f);
const t1cases = [
  ['空串', ''],
  ['纯 ASCII', 'abc123'],
  ['CJK 5 字', '鱼姬记忆树'],
  ['emoji 代理对', '🐟🐠'],
  ['双引号+反斜杠', '"' + '\\'],
  ['控制字符 0x01/0x1f/0x7f', control],
  ['JSON 转义后的正文', JSON.stringify({ t: 'a"b\\c\nd\te' })],
  ['混合', 'a鱼🐟"\\' + String.fromCharCode(10) + String.fromCharCode(7)],
];
let t1bad = 0;
for (const [name, s] of t1cases) {
  const got = T.utf8Len(s);
  const want = Buffer.byteLength(s, 'utf8');
  const raw = s.length;
  if (got !== want) t1bad += 1;
  console.log(`    ${name}: utf8Len=${got} · Buffer.byteLength=${want} · s.length=${raw}${got === raw ? '' : ' ·(≠length ✓)'}`);
}
eq(t1bad, 0, 'T1 utf8Len 与 Buffer.byteLength 逐例一致');
ok(T.utf8Len('鱼姬记忆树') === 15 && T.utf8Len('鱼姬记忆树') !== '鱼姬记忆树'.length, 'T1 CJK 计 3 字节/字(未用 s.length 冒充)');
ok(T.utf8Len('🐟') === 4, 'T1 单个 emoji 计 4 字节(代理对合成)');
ok(T.utf8Len('') === 0, 'T1 空串 = 0');

// ---------------------------------------------------------------- T2
await section('T2 20 条 × ≈200 KB:每批 ≤ 3 MiB + 拼接后与原数组逐条相等(不丢不重)');
const bigItems = Array.from({ length: 20 }, (_, i) => ({
  i, role: i % 2 ? 'assistant' : 'user', at: 1700000000000 + i,
  text: '答'.repeat(60000) + 'x'.repeat(20000),   // 180000 + 20000 = 200000 B/条
}));
const t2batches = drain(bigItems);
let t2bad = 0;
t2batches.forEach((c, k) => {
  const real = Buffer.byteLength(JSON.stringify({ items: c.list, file: 'conversations.json', runId: 'imp-x', at: 1 }), 'utf8');
  const okBytes = c.bytes <= LIMIT;
  const okReal = real < 4 * 1024 * 1024;
  if (!okBytes || !okReal || c.list.length > MAXI) t2bad += 1;
  console.log(`    批${k + 1}: ${c.list.length} 条 · 自报 bytes=${c.bytes} · 复算=${recount(c.list)} · 真请求体=${(real / 1024 / 1024).toFixed(2)} MB · ≤3MiB:${okBytes} · <4MiB:${okReal}`);
});
eq(t2batches.length, 2, 'T2 20×200KB ⇒ 2 批(不是整批一发)');
eq(t2bad, 0, 'T2 每批均满足 ≤3MiB 且真实请求体 <4MiB');
const t2flat = [].concat(...t2batches.map((c) => c.list));
eq(t2flat.length, bigItems.length, 'T2 拼接后条数相等');
let t2sameRefs = 0;
for (let k = 0; k < bigItems.length; k++) if (t2flat[k] === bigItems[k]) t2sameRefs += 1;
eq(t2sameRefs, bigItems.length, 'T2 拼接后逐条【同引用】相等(不丢条、不重条)');
t2batches.forEach((c, k) => eq(c.bytes, recount(c.list), `T2 批${k + 1} 自报字节 = 契约口径复算`));

// ---------------------------------------------------------------- T3
await section('T3 2000 条小条目:条数上限 200/批仍生效');
const smallItems = Array.from({ length: 2000 }, (_, i) => ({ i, text: '短' + i }));
const t3batches = drain(smallItems);
const t3maxItems = Math.max(...t3batches.map((c) => c.list.length));
const t3maxBytes = Math.max(...t3batches.map((c) => c.bytes));
console.log(`    批数=${t3batches.length} · 单批最多条数=${t3maxItems} · 单批最大字节=${t3maxBytes}`);
eq(t3batches.length, 10, 'T3 2000 条小条目 ⇒ 10 批');
eq(t3maxItems, MAXI, 'T3 单批条数 = 200(旧条数行为保留)');
ok(t3maxBytes <= LIMIT, 'T3 小条目批次自然不会碰字节上限');
const t3flat = [].concat(...t3batches.map((c) => c.list));
eq(t3flat.length, 2000, 'T3 2000 条不丢不重');

// ---------------------------------------------------------------- T4
await section('T4 单条超大(单条 4 MB):单独成批,前进性成立,不死循环');
const huge = { i: 0, text: 'y'.repeat(4 * 1024 * 1024) };
const t4c = T.takeChunk([huge, { i: 1, text: '小' }], 0);
console.log(`    单条 4MB ⇒ 该批 ${t4c.list.length} 条 · next=${t4c.next} · bytes=${t4c.bytes}(> 上限 ${LIMIT}:${t4c.bytes > LIMIT})`);
eq(t4c.list.length, 1, 'T4 首条自超上限也单独成批(绝不返回空批)');
eq(t4c.next, 1, 'T4 next 前进到 1');
const t4rest = T.takeChunk([huge, { i: 1, text: '小' }], t4c.next);
eq(t4rest.list.length, 1, 'T4 后续条目照常成批');
let t4drain = null, t4err = null;
try { t4drain = drain([huge, { i: 1, text: '小' }]); } catch (e) { t4err = e; }
eq(t4err, null, 'T4 走完全程不抛(前进性硬保证)');
if (t4drain) console.log(`    走完 2 条 ⇒ ${t4drain.length} 批 · 条数合计=${t4drain.reduce((a, c) => a + c.list.length, 0)}`);
let t4only = null, t4onlyErr = null;
try { t4only = drain([huge]); } catch (e) { t4onlyErr = e; }
eq(t4onlyErr, null, 'T4 单条超限数组也能走完(不进入死循环)');
if (t4only) eq(t4only.length, 1, 'T4 单条超限数组 ⇒ 1 批 1 条');

// ---------------------------------------------------------------- T5
await section('T5 边界:累计恰好卡在上限(±1 字节)');
// JSON.stringify({t:'a'.repeat(k)}) 长度 = k + 8 ⇒ 契约口径 cost = k + 9
const k1 = 1000;
const cost1 = k1 + 9;
const k2exact = (LIMIT - 2 - cost1) - 9;           // 恰好把累计顶到 LIMIT
const exactItems = [{ t: 'a'.repeat(k1) }, { t: 'a'.repeat(k2exact) }];
const overItems = [{ t: 'a'.repeat(k1) }, { t: 'a'.repeat(k2exact + 1) }]; // 再多 1 字节
const e1 = T.takeChunk(exactItems, 0);
const e2 = T.takeChunk(overItems, 0);
console.log(`    恰好 ${LIMIT} B:条数=${e1.list.length} · bytes=${e1.bytes} · 复算=${recount(e1.list)}`);
console.log(`    超出 1 B:条数=${e2.list.length} · bytes=${e2.bytes} · 复算=${recount(e2.list)}(第二条被推到下一批)`);
eq(e1.list.length, 2, 'T5 恰好等于上限 ⇒ 两条同批(不提前切)');
eq(e1.bytes, LIMIT, 'T5 该批 bytes 恰为上界');
eq(e2.list.length, 1, 'T5 超上限 1 字节 ⇒ 第二条切到下一批');
eq(e2.bytes, 2 + cost1, 'T5 超限批只装第一条');
const e2b = T.takeChunk(overItems, e2.next);
eq(e2b.list.length, 1, 'T5 被推出的那一字节条目在下一批里,未丢');

// ---------------------------------------------------------------- T6(缺口:4 MiB 之上那一档)
await section('T6 单条 66 MiB(会在服务端直接熔断那一档):仍单独成批,前进性成立,不死循环');
// T4 已覆盖"单条 4 MB";这里只补**缺口** —— 4 MiB 回 413 之上还有一档:单条 > 64 MiB 时服务端
// 连 413 都来不及给(连接被 reset ⇒ 客户端只看到 .catch 的「批失败(网关)」)。
// 切批行为在这一档必须同样成立:该条单独成批、next 前进、走完全程不抛。
const huge66 = { i: 0, title: '超大会话', text: 'z'.repeat(66 * 1024 * 1024) };
const t6c = T.takeChunk([huge66, { i: 1, text: '小' }], 0);
console.log(`    单条 66MiB ⇒ 该批 ${t6c.list.length} 条 · next=${t6c.next} · 自报 bytes=${t6c.bytes}(${(t6c.bytes / 1024 / 1024).toFixed(1)} MB,远超上限 ${LIMIT})`);
eq(t6c.list.length, 1, 'T6 单条 66MiB 也单独成批(首条自超上限绝不返回空批)');
eq(t6c.next, 1, 'T6 next 前进到 1');
eq(t6c.bytes, recount([huge66]), 'T6 自报字节 = 契约口径复算');
let t6err = null, t6drain = null;
try { t6drain = drain([huge66, { i: 1, text: '小' }]); } catch (e) { t6err = e; }
eq(t6err, null, 'T6 走完全程不抛(前进性硬保证:不死循环)');
if (t6drain) {
  console.log(`    走完 2 条 ⇒ ${t6drain.length} 批 · 条数合计=${t6drain.reduce((a, c) => a + c.list.length, 0)} · 超大条所在批=${t6drain[0].list.length} 条`);
  eq(t6drain.length, 2, 'T6 66MiB 条 + 小条 ⇒ 2 批(超大条不与任何条目同批)');
  eq(t6drain[0].list[0], huge66, 'T6 超大条原样落在第一批(同引用,没被改写/截断)');
}

// ---------------------------------------------------------------- T7 C-1(2026-09-29 单条自身超限)
await section('T7 C-1 单条超限:独立计数 tooBig + 点名文案 + 不镜像服务端常量');
// ⚠️ **证据边界(如实说明)**:C-1 的判据都在 `bGo.onclick` 闭包里 —— 要执行到它需要真实的
// DOM 挂载 + store + FileReader,本文件的最小桩不具备(它只经 exports.__test__ 做行为断言)。
// ⇒ T7 是**源码护栏**,不是执行级覆盖;不许为了"让测试好看"去重构 UI 结构换可测性。
ok(src.includes('tooBig'), 'T7 存在独立计数 tooBig(不与 errors 混用一个数)');
ok(/totals\.tooBig \+= 1/.test(src), 'T7 单条超限路径给 totals.tooBig 计数');
ok(src.includes("r.reason === 'too-large' && chunk.list.length === 1"), 'T7 判据 = 服务端回执 reason + 本批条数(唯一能区分两种 413 的依据)');
ok(/one\.title \|\| one\.name/.test(src) && src.includes('未命名'), 'T7 点名:title → name → 「未命名」三级退路');
ok(/utf8Len\(JSON\.stringify\(one\)\)/.test(src), 'T7 报出该条**真实**字节数(客户端复算,不拿封套近似值冒充)');
ok(src.includes("'单条过大跳过:「' + oneTitle") && src.includes('fmtBytes(oneBytes)'), 'T7 文案里同时有它的名字与体量');
ok(src.includes('这条已跳过,其余会话照常导入'), 'T7 文案说清"这条跳过、其余照常导入"(可执行的话,不是"把文件拆小")');
ok(src.includes('拆小导出文件也拆不开单条'), 'T7 指出"拆文件"对单条超限物理上无效(旧文案正是在这里骗人)');
// 单条分支:只加 tooBig,不加 errors、不报"失败批"账(服务端账本里只有 errors 一个字段)、不 return
{
  const iC1 = src.indexOf("r.reason === 'too-large' && chunk.list.length === 1");
  const iErr = src.indexOf('totals.errors += 1', iC1);
  const c1 = src.slice(iC1, iErr > iC1 ? iErr : iC1 + 1200);
  console.log(`    单条分支源码长度=${c1.length} B · 含 tooBig:${c1.includes('totals.tooBig += 1')} · 含 errors:${c1.includes('totals.errors')} · 含 return:${/\breturn\b/.test(c1)}`);
  ok(c1.includes('totals.tooBig += 1'), 'T7 单条分支并入 tooBig');
  ok(!c1.includes('totals.errors'), 'T7 单条分支**不**计入 errors(它不是意外,是已知且可解释)');
  ok(!c1.includes('reportError()'), 'T7 单条分支不把它报进「失败批」账(账里只有 errors 字段,报了就等于混进错误)');
  ok(!/\breturn\b/.test(c1), 'T7 单条分支不 return ⇒ 后面的批照常导入(绝不因一条太大中止整次导入)');
}
// finish() 汇总:如实显示 + 有跳过时不说"✓ 导入完成"(S5 导入诚实化口径)
ok(/\(skipped \? ' · 单条过大跳过 ' \+ skipped : ''\)/.test(src), 'T7 汇总行如实显示「· 单条过大跳过 N」');
ok(src.includes('⚠ 导入不完全:写入新记忆 '), 'T7 有跳过时走 ⚠ 不完全文案(不是沉默,也不是"完成")');
ok(/if \(!totals\.errors && !skipped && totals\.accepted && !shell\)/.test(src), 'T7 有跳过时不打"她开始读这些日子了"收尾(它是"全都好"的口气)');
{
  const iShell = src.indexOf('if (shell) {');
  const iSkip = src.indexOf('} else if (skipped) {', iShell);
  const iElse = src.indexOf('} else {', iSkip);
  const iDone = src.indexOf('✓ 导入完成', iElse);
  console.log(`    结构位置 if(shell)=${iShell} < else-if(skipped)=${iSkip} < else=${iElse} < ✓导入完成=${iDone}`);
  ok(iShell > 0 && iSkip > iShell && iElse > iSkip && iDone > iElse,
    'T7 「✓ 导入完成」落在 else if(skipped) 之后的 else 里 ⇒ 有跳过时物理上说不到它');
}
// **命门**:客户端不许镜像服务端的字节上限(判据必须来自回执 r.limit)
ok(!/4\s*\*\s*1024\s*\*\s*1024/.test(src), 'T7 未写死 4 * 1024 * 1024');
ok(!/4194304/.test(src), 'T7 未写死 4194304');
ok(!/BODY_MAX/.test(src), 'T7 未引用服务端常量名 BODY_MAX');
ok(/r\.limit/.test(src) && /r && r\.limit/.test(src), 'T7 上限仍取自服务端回执 r.limit');
{
  const mm = src.match(/1024\s*\*\s*1024/g) || [];
  console.log(`    client.js 里 \`1024 * 1024\` 命中 ${mm.length} 处(应为 2:BATCH_MAX_BYTES 3 MiB 自身上限 + fmtBytes 的 1 MiB 显示阈值)`);
  eq(mm.length, 2, 'T7 `1024 * 1024` 仍只有已知 2 处 —— 新增第 3 处前先想清楚:它是不是在镜像服务端常量');
}

// ---------------------------------------------------------------- T0 源码护栏(V3,随测试常驻)
await section('T0 源码护栏(旧判据已拆 / 新判据在位)');
ok(!src.includes('var batch = 200'), 'T0 旧条数常量 `var batch = 200` 已不存在');
ok(!src.includes('idx - batch'), 'T0 旧的 `idx - batch` 拒绝序号算式已不存在');
ok(src.includes("chunkStart + rj.i + 1"), 'T0 拒绝序号改用本批起始下标');
ok(src.includes('r.reason === \'too-large\''), 'T0 too-large 映射在位');
// 上限数字必须取自服务端回执(413 体里的 limit),客户端不许再写死一个 —— 两处写死必漂移(主会话收口时改)
ok(/r\.limit/.test(src) && src.includes('服务端单次上限 '), 'T0 超限文案的上限取自回执 r.limit(不是写死的字面量)');
ok(src.includes('takeChunk(items, idx)'), 'T0 切批入口走 takeChunk(按字节)');
ok(src.includes('已送 '), 'T0 进度文案含字节口径"已送"');
ok(src.includes('按体量切批'), 'T0 预览文案已按体量口径');
ok(!/^\s*import\s/m.test(src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), 'T0 client.js 未引入 import(仍是单文件 bundle)');

// ---------------------------------------------------------------- T8 B(2026-09-29 记忆包 413 说人话)
await section('T8 B 记忆包 413 文案:三件事说清 + 上限只许来自回执 + sealed 原文逐字未变');
// ⚠️ **证据边界(如实说明)**:bImp 的 `.then/.catch` 长在 `renderOverview` 的闭包里 —— 要执行到它需要
// 真实 DOM 挂载 + FileReader + window.confirm + 真 fetch,本文件的最小桩不具备(`exports.__test__` 也不覆盖它,
// 它只导出 takeChunk / utf8Len 这类**纯函数**)。⇒ T8 是**源码护栏**,不是执行级覆盖;
// 不许为了"让测试好看"去重构 UI 结构换可测性(与 T7 / C-1 同一条口径)。
{
  // ⚠️ 所有**文案断言**都先剥掉 `//` 注释行再匹配:否则注释里出现同样的词就能让断言假绿
  //    (A 段源码护栏就吃过这个亏 —— 注释里的 `req.on(` 骗过了 indexOf)。
  const codeOf = (t) => t.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const iOn = src.indexOf('fileInput.onchange = function () {');
  const iImpEnd = src.indexOf('bImp.onclick', iOn);
  const imp = src.slice(iOn, iImpEnd);
  const iSealed = imp.indexOf("r.reason === 'sealed'");
  const iLarge = imp.indexOf("r.reason === 'too-large'");
  const iElse = imp.indexOf('} else {', iLarge);
  const iCatch = imp.indexOf('.catch(function () {');
  const iCatchEnd = imp.indexOf('} catch (e) {', iCatch);
  const sealedCode = codeOf(imp.slice(iSealed, iLarge));
  const largeCode = codeOf(imp.slice(iLarge, iElse));
  const elseCode = codeOf(imp.slice(iElse, iCatch));
  const catchCode = codeOf(imp.slice(iCatch, iCatchEnd));
  console.log(`    导入块 ${imp.length} B · 定位 sealed@${iSealed} < too-large@${iLarge} < else@${iElse} < catch@${iCatch} < }catch@${iCatchEnd}`);
  console.log(`    剥注释后的分支体:sealed=${sealedCode.length} B · too-large=${largeCode.length} B · else=${elseCode.length} B · catch=${catchCode.length} B`);
  ok(iOn > 0 && iImpEnd > iOn && iSealed > 0 && iLarge > iSealed && iElse > iLarge && iCatch > iElse && iCatchEnd > iCatch,
    'T8-0 四段分支都定位到了(定位失败 ⇒ 下面每条都会假绿,故这条是地基)');

  // ── ① 三件事:整包太大(不是包坏了)/ 上限是多少 / 怎么办 ──────────────────
  ok(/整包/.test(largeCode) && /不是包坏了/.test(largeCode),
    'T8-① 说清"整包太大、不是包坏了"(体量闸门,不是包结构坏)');
  ok(/单次上限/.test(largeCode), 'T8-② 说清服务端单次上限是多少');
  ok(/导出记忆包/.test(largeCode) && /不含原文/.test(largeCode) && /重新导出/.test(largeCode),
    'T8-③ 给出可执行的路:用「⬇ 导出记忆包」重新导出一份**不含原文**的包再导入');
  ok(/结构限制/.test(largeCode) && /一次/.test(largeCode),
    'T8-③b 如实说明"整包一次发不完"是**当前通道的结构限制**(不甩锅给文件、也不假装能拆)');

  // ── ② 上限数字**只许来自回执**(C-1 同一条命门:客户端不镜像服务端常量)──────────
  ok(/fmtLimitMB\(r\.limit\)/.test(largeCode), 'T8-② 上限经 fmtLimitMB(r.limit) 换算 —— 判据是回执,不是写死的字面量');
  ok(!/1024\s*\*\s*1024/.test(largeCode) && !/4194304/.test(largeCode),
    'T8-②b 413 分支里没有写死的字节上限(既无 1024 * 1024,也无 4194304)');
  ok(/function fmtLimitMB\(limit\)/.test(src) && /Math\.round\(n \/ 1024 \/ 1024 \* 10\)/.test(src),
    'T8-②c fmtLimitMB 只做"回执 limit → MB"换算(除法口径,不引入字节乘法常量)');
  ok(src.includes('上限未随回执返回'), 'T8-②d 回执没带 limit 时如实说"没给",不猜一个 4 MB 顶上');
  console.log(`    largeCode 含写死上限:${/1024\s*\*\s*1024|4194304/.test(largeCode)} · 含 fmtLimitMB(r.limit):${/fmtLimitMB\(r\.limit\)/.test(largeCode)}`);

  // ── ③ 不再把回执 JSON 糊到人脸上 ─────────────────────────────────────────
  ok(!/JSON\.stringify/.test(largeCode), 'T8-③c 413 分支不再 JSON.stringify 回执(旧形状:把 "too-large" 字段糊脸)');
  ok(/r\.message \|\| r\.error \|\| r\.reason/.test(elseCode) && elseCode.indexOf('message') < elseCode.indexOf('JSON.stringify'),
    'T8-③d 其余失败:先取服务端 message,JSON 摘要只作最后兜底(源码顺序 = 优先级)');

  // ── ④ sealed 分支原文**逐字未变**(与 1.5.3 备份的同一行相等)──────────────
  const SEALED_LINE = "toast('导入失败:人格已定型 — 请先到「人格中心」做手术(输入承诺句)后再覆盖导入;仅导入记忆不受影响');";
  ok(sealedCode.includes(SEALED_LINE), 'T8-④ sealed 分支文案逐字未变(与备份那一行相等)');
  console.log(`    sealed 段含原文逐字:${sealedCode.includes(SEALED_LINE)} · 段内 toast 调用=${(sealedCode.match(/toast\(/g) || []).length} 处`);

  // ── ⑤ .catch:保留原话 + 只给"可能",不下确定结论 ─────────────────────────
  ok(catchCode.includes('导入失败(网关不可达)'), 'T8-⑤ .catch 保留「导入失败(网关不可达)」原话');
  ok(/无从判断/.test(catchCode) && /可能/.test(catchCode), 'T8-⑤b 拿不到回执 ⇒ 只说"无从判断"+ 一种可能(不猜成确定结论)');
  ok(/不含原文/.test(catchCode), 'T8-⑤c .catch 也给一条可执行的路(换成不含原文的包再试)');

  // ── ⑥ 长文案的渲染通道(toast 第三参;不传 = 既有调用面零改动)──────────────
  ok(/function toast\(msg, ms, wrap\)/.test(src), 'T8-⑥ toast 第三参 wrap 在位(长文案换行渲染)');
  ok(/white-space:pre-line/.test(src), 'T8-⑥b wrap 走 pre-line ⇒ 文案里手写的换行真的落地(nowrap 下会溢出屏幕)');
  const wrapCalls = src.match(/12000, true\)/g) || [];
  eq(wrapCalls.length, 2, 'T8-⑥c 只有这两条长文案走 wrap=true(其余 toast 调用面一字未动)');
}

// ---------------------------------------------------------------- T9 #10(2026-09-29 跳过进持久账本)
await section('T9 #10 被跳过的「单条过大」进持久账本:收尾上报一次 · 不带 errors · 名字 ≤5(源码护栏)');
// ⚠️ 证据边界同 T7/T8:这条通路长在 `bGo.onclick` 闭包里(要真 DOM + FileReader + 真 fetch 才跑得到),
// ⇒ 这里是**源码护栏**,不是执行级覆盖。行为级判据在 `tests/importlog.test.mjs`(账本累加 + 端点命门)。
{
  // 只断"代码",不断"注释":先剥掉整行注释(教训:注释里就写着 errors / 不含原文这些词,
  // 不剥的话断言可以被注释满足 —— 那就是假绿)。
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  /** 取函数体(从 marker 后第一个 `{` 起配平)—— finish()/reportTooBig() 都是无参函数,不必跨参数表。 */
  const blockOf = (text, marker) => {
    const at = text.indexOf(marker);
    if (at < 0) return '';
    const bodyAt = text.indexOf('{', at);
    if (bodyAt < 0) return '';
    let depth = 0;
    for (let j = bodyAt; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) return text.slice(bodyAt, j + 1); }
    }
    return '';
  };
  const rep = blockOf(code, 'function reportTooBig() {');
  const fin = blockOf(code, 'function finish() {');
  console.log(`    reportTooBig 体=${rep.length} B · finish 体=${fin.length} B · 上报函数 ${(code.match(/function reportTooBig\(\)/g) || []).length} 处 · /import/log 调用 ${(code.match(/api\('\/import\/log'/g) || []).length} 处`);
  ok(rep.length > 80, 'T9 定位到真实的 reportTooBig()(切出 ' + rep.length + ' B)');
  ok(/tooBig: totals\.tooBig/.test(rep), 'T9 上报体带上被跳过的条数(取自 totals.tooBig,不是另记一个数)');
  ok(/tooBigNames: skippedNames\.slice\(0, 5\)/.test(rep), 'T9 名字**上限 5 条**随上报一起发(slice(0, 5))');
  ok(!rep.includes('errors'), 'T9 ★命门:这一笔**不带 errors** —— 账本里它是「跳过」,不是「失败批」');
  ok((code.match(/api\('\/import\/log'/g) || []).length === 2,
    'T9 /import/log 恰好两处调用:reportError(失败批)+ reportTooBig(跳过)—— 不许多一路乱报');
  ok(fin.includes('reportTooBig();'), 'T9 上报点在 finish() 里(收尾一次,不是每条一发)');
  ok((fin.match(/reportTooBig\(\);/g) || []).length === 1, 'T9 finish() 里**只**调一次(实测 '
    + (fin.match(/reportTooBig\(\);/g) || []).length + ' 次)');
  ok(/if \(!totals\.tooBig\) return;/.test(rep), 'T9 没有跳过就不上报(零跳过时账本上一个字节都不多写)');
  ok(/if \(skippedNames\.length < 5\) skippedNames\.push\(oneTitle\)/.test(code),
    'T9 名字与界面点名**同源**(同一个 oneTitle:title → name →「未命名」三级退路),最多 5 条');
  {
    // 名字收集必须落在 C-1 分支里(即"单条自身超限"那一支),不能落进失败支
    const iC1 = code.indexOf("r.reason === 'too-large' && chunk.list.length === 1");
    const iErr = code.indexOf('totals.errors += 1', iC1);
    const c1 = code.slice(iC1, iErr > iC1 ? iErr : iC1 + 1400);
    console.log(`    C-1 分支体=${c1.length} B · 含 skippedNames.push:${c1.includes('skippedNames.push(oneTitle)')} · 含 errors:${c1.includes('totals.errors')}`);
    ok(c1.includes('skippedNames.push(oneTitle)'), 'T9 名字收集在 C-1(单条超限)分支内');
    ok(!c1.includes('totals.errors'), 'T9 名字收集不落进失败支(跳过 ≠ 失败)');
  }
}

summary();
