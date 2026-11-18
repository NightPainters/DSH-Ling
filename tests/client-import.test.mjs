// tests/client-import.test.mjs — m12-fix ③(蓝队 R2-5 / C-D)
//
// 缺陷:客户端「导入记忆包」**从不带承诺句** —— 唯一调用点(lib/client.js 的 `/import`)固定发
//   `{bundle, persona:true}`,payload 里没有 `unlock`;`api()` 只补票据头。于是已定型用户在
//   `/import` 的门那一跳永远 `surgery-phrase`(未定型才不受影响),界面还把他指向「人格中心输入
//   承诺句」——那条路同样不带承诺句 ⇒ **已定型用户永远无法从包恢复人格**,且回执理由说谎。
//
// 本文件验两件事(都直接跑**真实源码**,不复制实现):
//   ① `importPayloadOf()` 的行为(经 exports.__test__ 取真函数,加载路径与 tests/client-batch.test.mjs 同一条);
//   ② 接线护栏:导入 handler 只许经它拼载荷,且必须现场问承诺句(禁粘贴)—— 防止将来又回到
//      "固定发一份不带 unlock 的载荷"。
import { readFileSync } from 'node:fs';
import { ok, eq, section, summary } from './harness.mjs';
import { contextify } from './vm-light.mjs';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ---- 最小 DOM/fetch 桩(与 tests/client-batch.test.mjs 同形;本文件只取 __test__,不发请求)----
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
  fetch: async () => ({ ok: false, status: 500, json: async () => null }),
});
const T = out && out.__test__;

await section('m12-③ 钩子可达(真源码 + contextify)');
ok(!!T, 'exports.__test__ 存在于 client.js 导出面');
ok(T && typeof T.importPayloadOf === 'function', '取到真实 importPayloadOf(不是测试里的副本)');
if (!T || typeof T.importPayloadOf !== 'function') {
  console.error('  ✗ 测试钩子不可用,后续断言无意义');
  summary();
  process.exit(1);
}
const payloadOf = T.importPayloadOf;
const BUNDLE = { schemaVersion: 17, overviews: [{ id: 1 }], persona: { persona: { aiName: '小灵' } } };

await section('m12-③ 只并入记忆:载荷不含 persona / unlock');
eq(payloadOf(BUNDLE, false), { bundle: BUNDLE },
  '★application=false ⇒ 只有 { bundle }(不碰人格,也不该带承诺句)');

await section('m12-③ 已定型 + 覆盖人格:承诺句必须透传到顶层 unlock');
{
  const p = payloadOf(BUNDLE, true, '  那句话  ', { sealed: true });
  ok(!!p && p.persona === true, '★persona:true 照旧(覆盖人格的意图不丢)');
  ok(!!p && p.unlock === '那句话', '★主人敲的承诺句被 trim 后放进**顶层** `unlock`(修前这里根本没有 unlock 键)');
  eq(!!p && Object.keys(p).sort(), ['bundle', 'persona', 'unlock'], '载荷键集恰好是 {bundle, persona, unlock}');
}

await section('m12-③ 已定型但没有承诺句(取消/空白):不发"注定 sealed"的请求');
{
  ok(payloadOf(BUNDLE, true, '', { sealed: true }) === null, '★空串 ⇒ null(调用方不发请求,而不是发一份必被门拒的包)');
  ok(payloadOf(BUNDLE, true, '   ', { sealed: true }) === null, '★全空白 ⇒ null(同上)');
  ok(payloadOf(BUNDLE, true, undefined, { sealed: true }) === null, '★根本没输入(undefined)⇒ null');
}

await section('m12-③ 未定型:不该被多问一句(不塞 unlock,照旧覆盖人格)');
{
  const p = payloadOf(BUNDLE, true, '', { sealed: false });
  ok(!!p && p.persona === true, '未定型 ⇒ 仍可覆盖人格');
  ok(!!p && !Object.prototype.hasOwnProperty.call(p, 'unlock'), '未定型 ⇒ 不带 unlock(定型门不会进,不必多要一句)');
}

await section('m12-③ 接线护栏:导入 handler 只经 importPayloadOf 拼载荷,且现场问承诺句');
{
  const from = src.indexOf("var bImp = el('button', null, '⬆ 导入记忆包…')");
  const to = src.indexOf('acts.appendChild(bExp)');
  const block = from >= 0 && to > from ? src.slice(from, to) : '';
  ok(block.length > 0, '抠到「导入记忆包」这一段 handler(实测长度 ' + block.length + ')');
  ok(/api\('\/import', \{ method: 'POST', body: payload \}\)/.test(block),
    '★/import 调用点仍在(护栏不是对着空气断言)');
  ok(/importPayloadOf\(bundle/.test(block),
    '★载荷经 importPayloadOf 拼(修前是内联的 `applyPersona ? {bundle, persona:true} : {bundle}`)');
  ok(!/\? \{ bundle: bundle, persona: true \} :/.test(block),
    '★修前那种"固定不带 unlock 的载荷"不许再出现(回退即红)');
  ok(/lingAsk\(\{/.test(block) && /noPaste: true/.test(block),
    '★要覆盖人格时现场问承诺句(禁粘贴 —— 与人格中心的手术同一套仪式)');
  ok(/sealed: true \}/.test(block), '★"已定型却没有承诺句"这一支明确走 null(不发请求)');
}

summary();
