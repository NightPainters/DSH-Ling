// docs-contract 文档契约测试(M2,2026-11-12)。`node tests/docs-contract.test.mjs`
//
// 钉住发布面(HANDOFF-器灵-presence接口-20261022.md §6-5「把 §3 契约 + §4 三条铁律 + §5 四条不做原样写进发布面」;
// ALIGN-2.0 §3 M2「逐条在发布面找到原文,缺一条即 FAIL」):
//   PHILOSOPHY.md 里 —— 三铁律 3/3、四不做 4/4、五码 5/5,**逐个**出现;缺一条就报出**缺哪一条**。
// 本文件是「变异 ⑥」的执行者:从 PHILOSOPHY.md 删掉任意一条铁律 ⇒ 本文件必须变红
// (ALIGN-2.0 §3 M2 变异点 ⑥);这条钉子之所以钉得住,是因为每条判据都钉**条款原文里的决定性片段**。
//
// 只读 markdown:不联网、不写文件、不建临时目录、不依赖宿主(不需要 ctx / cordis / DB / cordis.yml)。
//
// 为什么不用 `includes('不做')` / `includes('消费者')` 这类松词(见 m2-survey R2):
// PHILOSOPHY.md 里本来就有「不做任何削弱工作能力的事」「我们不做的事」等同形词,
// 也本来就有「消费者」相关叙述 —— 松词断言在条款被删掉之后照样全绿,等于没钉。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(root, 'PHILOSOPHY.md');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

let doc = '';
try {
  doc = readFileSync(DOC, 'utf8');
} catch (e) {
  ok = false;
  console.log('✗ 读不到 PHILOSOPHY.md:', DOC, '—', e.message);
}

/**
 * 一条判据 = { id, name, must }。
 * `must` 是**全部**必须出现的原文片段(逐字);少一个片段就报这一条缺什么。
 */
const THREE_LAWS = [
  { id: '铁律 1', name: '消费者必须忽略未知的 kind 与 code', must: ['消费者必须忽略未知的 `kind` 与 `code`'] },
  { id: '铁律 2', name: '服务是软依赖:拿不到就跳过,不许抛、不许报错', must: ['服务是软依赖', '拿不到就跳过', '不许抛、不许报错'] },
  { id: '铁律 3', name: '只增不改:已有字段的语义永不改,要改语义就加新字段', must: ['只增不改', '已有字段的', '要改语义就', '加新字段'] },
];

const FOUR_NO = [
  { id: '不做 1', name: '不给"拦截权"(默认行为永远执行)', must: ['拦截权', '默认行为'] },
  { id: '不做 2', name: '不暴露内容', must: ['不暴露内容'] },
  { id: '不做 3', name: '不暴露内部对象(不给 memory / gate / settings 句柄)', must: ['不暴露内部对象', '句柄'] },
  { id: '不做 4', name: 'v1 不做 ack(回执协调)', must: ['v1 不做 ack', '回执协调'] },
];

/**
 * `code` 受控词表(HANDOFF §3.5),五个逐个 —— 钉的是**整行**(code + 何时发 + kind)。
 * 为什么不用 `includes('tree.changed')` 这种单词断言(实测踩到):词表之外还有第二张表
 * (逐 `code` 的 `count` 口径)也列出这五个码 ⇒ 删掉词表里的一整行,单词断言**照样全绿**(空转)。
 * 钉整行才让"缺一行"真的变红。
 */
const FIVE_CODES = [
  { id: '码 1', name: 'tree.changed → tree', must: ['| `tree.changed` | 记忆树结构被改（增枝 / 改归属 / 调权重） | `tree` |'] },
  { id: '码 2', name: 'memory.forgotten → memory', must: ['| `memory.forgotten` | 有记忆被遗忘 / 回灌 | `memory` |'] },
  { id: '码 3', name: 'persona.changed → persona', must: ['| `persona.changed` | 人格层文本变了 | `persona` |'] },
  { id: '码 4', name: 'settings.changed → settings', must: ['| `settings.changed` | 器灵设置变了（含总开关） | `settings` |'] },
  { id: '码 5', name: 'mode.changed → settings', must: ['| `mode.changed` | 某会话挡位变了 | `settings` |'] },
];

/** 三节落点:标题 + §3/§4/§5 指针 + "本包内无消费者"。 */
const SECTIONS = [
  { id: '落点 1', name: '第七章「对外接口」标题', must: ['## 七、对外接口 `dsh-ling/presence`'] },
  { id: '落点 2', name: '契约一节(§3)', must: ['### 契约(v1,冻结) · HANDOFF §3'] },
  { id: '落点 3', name: '三铁律一节(§4)', must: ['### 三条兼容铁律 · HANDOFF §4'] },
  { id: '落点 4', name: '四不做一节(§5)', must: ['### 四条明确不做 · HANDOFF §5'] },
  { id: '落点 5', name: '本包内无消费者', must: ['本包内无消费者'] },
];

/** 逐条断言;缺哪条就把 id + 名字 + 缺的片段一次性说清(变异 ⑥ 靠它定位)。 */
function assertItems(label, items) {
  for (const it of items) {
    const missing = it.must.filter((s) => !doc.includes(s));
    check(missing.length === 0,
      `${label} ${it.id}「${it.name}」缺少原文片段:${missing.map((s) => JSON.stringify(s)).join(' / ')}`);
  }
}

// ── 1 文档可读且不是空壳 ─────────────────────────────────────────────────────
{
  check(doc.length > 0, 'PHILOSOPHY.md 读出来是空的(文件缺失或读失败)');
}

// ── 2 三铁律逐条(3/3;删掉任意一条 ⇒ 本节红并点名) ───────────────────────────
{
  assertItems('三铁律', THREE_LAWS);
}

// ── 3 四不做逐条(4/4) ───────────────────────────────────────────────────────
{
  assertItems('四不做', FOUR_NO);
}

// ── 4 五码逐个(5/5) ─────────────────────────────────────────────────────────
{
  assertItems('五码', FIVE_CODES);
}

// ── 5 三节的落点与"本包内无消费者" ───────────────────────────────────────────
{
  assertItems('章节', SECTIONS);
}

// ── 总 ──────────────────────────────────────────────────────────────────────
if (!ok) {
  console.error('\n有一项或多项失败(缺哪条见上面的 ✗ 行)');
  process.exitCode = 1;
} else {
  console.log('docs-contract:全部通过 ✓');
}
