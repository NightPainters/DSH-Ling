// F4(2026-10-17) 孤立代理防线 —— 回归测试。
//
// 病灶:JavaScript 字符串允许**半个代理对**落单,那是非法 UTF-16;它一旦进请求体,
//   上游 JSON 解析器直接崩(实测两起 400 事故:`session-bc00b39b` #6331 低代理 `0xdd12`、
//   `session-7ff65dd7` seq=58 高代理 `U+D83C`,都源自 recall snippet 被 `slice()` 从 emoji 中间切断)。
//
// 本测试同时钉三件事:
//   ① "旧写法确实会切坏"——把病灶本身写成断言,将来谁改回 `slice` 会立刻红;
//   ② 三个新工具(wellFormed / clipChars / safeSlice)在任何切点上都不产生落单代理;
//   ③ `oneLine` 出口已接上安全截断。
import assert from 'node:assert/strict';
import { wellFormed, clipChars, safeSlice, oneLine } from '../lib/host/rawlog.js';

const EMOJI = '\u{1F3C6}'; // 🏆 —— UTF-16 = D83C DFC6(两个单元)
assert.equal(EMOJI.length, 2, 'emoji 必须是两个 UTF-16 单元,否则本测试没有意义');

/** 数出字符串里落单的高/低代理(与生产代码同一判据,但独立实现,避免"用被测代码测自己")。 */
function loneCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const x = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(x >= 0xdc00 && x <= 0xdfff)) n++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (!(p >= 0xd800 && p <= 0xdbff)) n++;
    }
  }
  return n;
}

// ── ① 病灶复现:旧写法确实会切出落单代理(这条红了 = 测试环境或前提变了,不是修坏了)
assert.equal(loneCount(('abc' + EMOJI + 'def').slice(0, 4)), 1, '旧写法应切出 1 个落单高代理');
assert.equal(loneCount(('xx' + EMOJI + 'yy').slice(3, 5)), 1, '旧写法应切出 1 个落单低代理');

// ── ② wellFormed:落单代理 → U+FFFD;完好的字符串原样不动
assert.equal(wellFormed('\uD83C'), '\uFFFD', '孤立高代理应被替换');
assert.equal(wellFormed('\uDFC6'), '\uFFFD', '孤立低代理应被替换');
assert.equal(wellFormed('x\uD83Cy\uDFC6z'), 'x\uFFFD y\uFFFD z'.replace(/ /g, ''), '两个孤立代理都应被替换');
assert.equal(wellFormed('a' + EMOJI + 'b'), 'a' + EMOJI + 'b', '完好的 emoji 不该被动');
assert.equal(wellFormed(''), '');
assert.equal(wellFormed(null), '', 'null 不该抛');
assert.equal(wellFormed(undefined), '');
assert.equal(loneCount(wellFormed('x\uD83Cy')), 0);
assert.equal(wellFormed(wellFormed('\uD83C')), '\uFFFD', '幂等');

// ── ③ clipChars:绝不切断代理对
assert.equal(loneCount(clipChars('abc' + EMOJI + 'def', 4)), 0);
assert.equal(clipChars('abc' + EMOJI + 'def', 4), 'abc…', '切点落在高代理前一格 ⇒ 回退,不吐出半个字符');
assert.equal(loneCount(clipChars('abc' + EMOJI + 'def', 5)), 0, '切点落在 emoji 中间也不许切坏');
assert.equal(clipChars('abc' + EMOJI + 'def', 5), 'abc' + EMOJI + '…');
assert.equal(clipChars('short', 99), 'short', '不超长时原样返回(不加省略号)');
assert.equal(clipChars('', 5), '');
assert.equal(loneCount(clipChars('x'.repeat(10) + '\uD83C', 11)), 0, '截断把孤立代理留在尾部也要净化');
assert.equal(clipChars(EMOJI, 1), '…', 'cap=1 容不下一个 emoji(2 单元)⇒ 退成省略号,但不留半个代理');
assert.equal(loneCount(clipChars(EMOJI, 1)), 0);

// ── ④ safeSlice:起点与终点都不切断
const s = 'xx' + EMOJI + 'yy'; // 码点: x x 🏆 y y ;单元: 6
assert.equal(loneCount(safeSlice(s, 0, 3)), 0);
assert.equal(safeSlice(s, 0, 3), 'xx' + EMOJI, '终点切在代理对中间 ⇒ 前进一格,把整个 emoji 留下');
assert.equal(loneCount(safeSlice(s, 3, 5)), 0);
assert.equal(safeSlice(s, 3, 5), EMOJI + 'y', '起点切在代理对中间 ⇒ 回退一格把整个 emoji 带上;终点不动(索引 5 本就在串外)');
assert.equal(safeSlice(s, 0, 99), s, '越界自动夹到串长');
assert.equal(safeSlice(s, -5, 2), 'xx', '负数起点夹到 0');
assert.equal(safeSlice(s, 4, 2), '', 'to < from ⇒ 空串,不抛');
assert.equal(loneCount(safeSlice('a\uD83Cb', 1, 3)), 0, '本身就带毒时也要净化');

// ── ⑤ oneLine 出口已接安全截断(它被 recall / memory / tools 共 16 处调用)
assert.equal(loneCount(oneLine('abc' + EMOJI + 'def', 4)), 0);
assert.equal(oneLine('abc' + EMOJI + 'def', 4), 'abc…');
assert.equal(oneLine('  a\n\n b  ', 40), 'a b', '单行化不变');
assert.equal(loneCount(oneLine('x'.repeat(30) + '\uD83C', 31)), 0);

// ── ⑥ recall **取原文**档的出口净化(F4-b,2026-10-17)
//   病灶形态与 snippet 不同:`action:'read'` 直出原文全文、不经 `oneLine`,
//   所以只测纯函数不够 —— 必须走**真正的渲染器**(RECALL_SPEC.render)。
{
  const { RECALL_SPEC } = await import('../lib/host/tools.js');
  const poisonText = '前文' + '\uD83C' + '后文'; // 落单高代理(与 seq=58 同一形态)
  const rendered = RECALL_SPEC.output.render({}, {
    ok: true, action: 'read', conv: 'conv-x', project: 'p', frames: 0, bytes: 100,
    totalTurns: 1, injected: 0, assistantEmpty: 0, callName: '主人',
    from: 1, to: 1, given: 1, chars: 20, adopted: 0, remaining: 0, nextFrom: null,
    turns: [{ n: 1, seq: 1, time: 1791952091169, role: 'assistant', human: false, text: poisonText, tools: [] }],
  });
  const shown = rendered[0].text;
  assert.equal(loneCount(shown), 0, '取原文回执里不许出现落单代理');
  assert.ok(shown.includes('前文') && shown.includes('后文'), '净化不能把正文吃掉');
}

console.log('f4-surrogate.test: ok');
