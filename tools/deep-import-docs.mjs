#!/usr/bin/env node
// 深层库(结论层)· **C 档:文档灌入**(2026-10-15,用户批准;规格逐字见 `plans/1.7-library-import-design-options.md`
// 同批的方案表,以及本文件头部的"批准原文"摘录)。
//
// 批准原文(主人 2026-10-15 夜,回话逐字)：「那四件事都按照你说的来。允许"作废一条结论",C 的料源与限量照上表走」
//   ⇒ 上表 = 我那条方案里的 C 行,逐条落地在下面每一处 ★ 注释旁。
//
// ★ 位置:进包、随 1.7 发布、可复跑(就是本文件)。
// ★ 料源(第一趟):`plans/spec-extract/*.md` 的**规格抽取表** + `dsh-ling/DESIGN.md` §0 已定决策记录 / §0.1 设计理念。
//   ⚠️ 与批准表的一处**订正**(2026-10-15 深夜实测):批准表里写的是"`DESIGN.md` 的 `G-*`" ——
//   **`G-*` 在 DESIGN.md 里不存在**(实测:`^#{2,4} G-` 命中 0)。该文件的"已定"是 §0 决策表(D1..D7)
//     与 §0.1 设计理念 12 条。⇒ 按**实质**取这两节,口径不变(都是"已拍板的一句话结论")。
//   `plans/` 其余文档(PITFALLS / 交接 / 复盘)与 `deep.sum:*` 摘要一律留**第二趟**。
// ★ 切条:一条 = 一句能独立读懂的结论;**超 80 字一律拒收并报数,不许自动改写**(本文件只去 markdown 标记,
//   不改词句 —— 去标记后的最终文本会逐条印在清单里给主人过目)。
// ★ kind:规则优先(按来源与状态列)→ 不确定就不落(进"待判清单")。**第一趟不调模型**(小助手今晚不一定在)。
// ★ 幂等:`conv_id = 'doc:<相对仓库根的路径>'` + `seq_from = seq_to = 0` + text
//   ⇒ 键 =(文档, 0, 0, 文本) ⇒ 重跑不重复,**且不受行号漂移影响**(行号会随文档编辑变,键里不带行号)。
// ★ origin:`doc-import-v1`(与既成的 `discipline-doc-v1` 同族,一眼认得出是灌进来的)。
// ★ 污染闸①:带 `~~删除线~~` 的、或落在"已过时/已废弃/作废"小节里的、或状态列属于**否决集**的,
//   一律不灌 —— 把作废结论灌进开场注入面是最坏的一种污染。
// ★ 污染闸②:「纪律」类**缺一条不落** —— DDL(memory.js:314-317)逐字:① 来源是**主人授权的一句指令**;
//   ② 作用对象是**行为**;③ **违反时能被判据红出来**。本脚本只能判②的形态,**判不了①与③**
//   ⇒ 纪律候选一律进 `pendingDiscipline` 等人补①③,**永不自动落库**。
// ★ 节奏:**先 dry 后 commit**。默认 dry(只出清单,一个字节都不写库);`--commit` 才写。
// ★ 限量(第一趟):**≤40 条**,硬度一律 `long`(不标 durable),观察一周。
//
// 用法:
//   node dsh-ling/tools/deep-import-docs.mjs                 # dry(默认):出清单 + 统计,不写库
//   node dsh-ling/tools/deep-import-docs.mjs --json          # 同上,额外把机器可读清单打到 stdout
//   node dsh-ling/tools/deep-import-docs.mjs --commit        # 落库(需主人过目清单后显式指定)
//   node dsh-ling/tools/deep-import-docs.mjs --review        # 另出「复查清单」(只列信号,不作废)
//   node dsh-ling/tools/deep-import-docs.mjs --db <path>     # 换库(默认按 DSH_HOME 推导,见下)
//   node dsh-ling/tools/deep-import-docs.mjs --root <dir>    # 换文档根(默认 = 当前工作目录)
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

// 默认库路径**按环境推导,不写死作者机器**(2026-10-15 发布检查抓到:原先把作者本机路径写成了默认值)。
// 口径与宿主一致:`DSH_HOME` 优先,没有就用 `~/.dsh`。
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
export const DEFAULT_DB = join(DSH_HOME, 'cache', 'dsh-ling', 'memory.db');

// ───────────────────────────── 常量与判据(纯,可单测) ─────────────────────────────
export const ORIGIN = 'doc-import-v1';
export const TEXT_MAX = 80;          // 与 DDL 一致(memory.js:319)
export const FIRST_PASS_LIMIT = 40;  // ★ 限量:第一趟 ≤40 条
export const DEFAULT_DURABILITY = 'long';
/** 硬度三档(与 `lib/host/tools.js` 的 `DEEP_DURABILITIES` 同集;这里不 import,免得工具脚本拖进宿主依赖)。 */
export const DEEP_DURABILITIES = Object.freeze(['durable', 'long', 'ephemeral']);

// ── 过时风险 → durability 分档(2026-10-15,用户问「过时条目怎么弄?统一堆到复盘吗」之后加) ──
//  源码口径(**已复核,不是照文档抄**):
//    · `lib/host/l1.js:400-403` —— `ephemeral` 在开场选择侧被 `continue` 掉 ⇒ **不进开场**;
//    · `lib/host/l1.js:162`   —— `DURABILITY_BONUS = { durable: 0.6, long: 0, ephemeral: 0 }` ⇒ `durable` 更常被选;
//    · `lib/host/memory.js:332` —— `ephemeral` **照旧留在库里、recall 搜得到**。
//  ⇒ 结论:「将来必定会过时」的条**不该**落成 `long`/`durable` —— 它会在开场反复露面,过时之后误导我开口;
//    落成 `ephemeral` 则"存着、要时搜得到、但不占开场",正是这类条该待的地方。
//  判据只认**文本里看得见的时间锚**,不猜语义(猜"这句话会不会过时"要人,机器只报看得见的)。
export const STALE_READING = /\d+\s*(ms|毫秒|秒|分钟|小时|天|周|个月|年|个会话|条|行|字节|KB|MB|GB|%|倍|次)/;
//  实测负例(2026-10-15):最初写成"任意 `\d+\.\d+`" ⇒ **「Apache-2.0」被当成版本号**,一句讲合规措辞的
//  结论被误判进 `ephemeral`(不进开场)✗。许可名/小数都不是"会过期的版本号" ⇒ 只认两种**明确形态**:
//  ① 带 `v` 前缀(`v1.7`);② 紧邻"版本/版本号/release"字样。其余裸小数一律不当版本。
export const STALE_VERSION = /(^|[^\d.\w-])v\d+\.\d+(\.\d+)?|(版本|版本号|release)\s*[:：]?\s*v?\d+\.\d+/;
export const STALE_MOMENT = /(当前|目前|现在|暂时|计划中|待做|待办|尚未|还没|即将|正在|下一步|先按|暂定)/;
export const STALE_WHEN = /(本次|这次|本轮|今天|昨天|今晚|刚才|明天|本周|这几天)/;
/** 原则性表述(只用于把**价值类**条标成 durable;`durable` 有排序加权,滥标会把开场挤成那几条)。
 *  词表依据:`memory.js:331` 的 DDL 注释自己举的例子就是「拍板『效果优先于成本』是 durable」——
 *  那句里没有"永远/一律",只有**价值排序形**(A 优先于 B)⇒ 词表必须收这一类,否则规则比设计意图还严。 */
export const PRINCIPLE = /(永远|一律|不许|禁止|绝不|无论|任何情况|原则|始终|横贯|底线|宁可|宁愿|优先于)/;
/** 只有这些类别才可能 durable:原则/价值/约定类。`决定`/`事实` 天生是"某个时点的判断",不标永久。 */
export const DURABLE_KINDS = Object.freeze(['承诺', '关系', '纪律', '偏好']);

/** 这条能活多久? → { durability, why }。判的是"它多久会变成假话",**不是它多重要**。 */
export function classifyDurability(text, kind = '') {
  const t = String(text ?? '');
  const hit = [];
  if (STALE_READING.test(t)) hit.push('含读数');
  if (STALE_VERSION.test(t)) hit.push('含版本/编号');
  if (STALE_MOMENT.test(t)) hit.push('含时点状态');
  if (STALE_WHEN.test(t)) hit.push('含时间副词');
  if (hit.length) return { durability: 'ephemeral', why: hit.join('+') + ' ⇒ 不进开场,过时也不污染开口(recall 仍搜得到)' };
  if (PRINCIPLE.test(t) && DURABLE_KINDS.includes(kind)) {
    return { durability: 'durable', why: '原则性表述 + 价值类 ⇒ 永久(会吃排序加权,故只认文本自带的原则词)' };
  }
  return { durability: 'long', why: '默认:稳定结论' };
}

/** 条龄(天)。`at` 解析不出就返回 null —— 不猜、不当 0 处理(当 0 会让它永远不入选复查)。 */
export function ageDays(at, now = new Date()) {
  const t = Date.parse(String(at ?? ''));
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86400000) : null;
}

export const EPHEMERAL_TTL_DAYS = 90;  // 「当次」档过了这么久还留着 ⇒ 该复查(不是自动作废)
export const NEVER_USED_DAYS = 180;    // 从没被加固过 + 这么老 + 没置顶 ⇒ 怀疑它其实用不上

/** 复查清单(③):机器能把"可能已经没用了"的挑出来,剩下的**人裁**。
 *  WHY 不让它自动作废:作废是不可逆动作里最轻的一个,但"这条还有没有用"是语义判断 —— 机器只能报信号。 */
export function reviewPlan(db, { now = new Date(), ttlDays = EPHEMERAL_TTL_DAYS, idleDays = NEVER_USED_DAYS } = {}) {
  const rows = db.prepare("SELECT id,kind,text,durability,hit_count,pinned,at,src FROM deep_item WHERE superseded_by=''").all();
  const out = { total: rows.length, byDurability: {}, staleRisk: [], expired: [], neverUsed: [] };
  for (const r of rows) {
    const d = DEEP_DURABILITIES.includes(String(r.durability)) ? String(r.durability) : 'long';
    out.byDurability[d] = (out.byDurability[d] || 0) + 1;
    const age = ageDays(r.at, now);
    const item = { id: r.id, kind: r.kind, text: r.text, durability: d, hit: Number(r.hit_count || 0), age, at: r.at, src: r.src };
    // ① 含时间锚却当着长期条 ⇒ 落库时分档漏网(或历史条目)。这不是错,是"过时了没人提醒"的根源。
    if (d !== 'ephemeral' && (STALE_READING.test(r.text) || STALE_MOMENT.test(r.text))) out.staleRisk.push(item);
    // ② 「当次」档 + 够老 ⇒ 候选作废。
    if (d === 'ephemeral' && age !== null && age >= ttlDays) out.expired.push(item);
    // ③ 从没被加固过 + 够老 + 没置顶 ⇒ 它可能一直没被开场选中过,白占位置。
    if (!Number(r.pinned) && Number(r.hit_count || 0) === 0 && age !== null && age >= idleDays) out.neverUsed.push(item);
  }
  const byAge = (a, b) => (b.age ?? -1) - (a.age ?? -1);
  out.staleRisk.sort(byAge); out.expired.sort(byAge); out.neverUsed.sort(byAge);
  out.counts = { staleRisk: out.staleRisk.length, expired: out.expired.length, neverUsed: out.neverUsed.length };
  return out;
}

/** 状态列的**接受集**(硬度分越高越硬)。判据来源:`spec-extract` 实测出现的状态值(2026-10-15 普查)。 */
export const STATUS_ACCEPT = Object.freeze({
  '已拍板': 3, '已拍': 3, '已决': 3, '已决（10-01）': 3, '主人拍板': 3, '用户拍板': 3,
  '已定': 2, '设计已定': 2, '纪律': 2,
  '已落地': 1, '✅ 已落地': 1, '实测': 1,
});
/** 状态列的**否决集**:出现即整条丢(污染闸①的一半)。 */
export const STATUS_REJECT = Object.freeze([
  '草案', '待拍板', '待建', '计划中', '已否掉', '反例（禁令）', '待确认', '🟡 待主人确认',
  '待定', '未定', '讨论中', '待落', '设想', '—', '',
]);
/** 小节标题里出现这些词 ⇒ 整节当作废料(污染闸①的另一半)。 */
export const SECTION_STALE = /已过时|已废弃|作废|已删|历史版本|旧口径|更正前|不再适用/;

/** 去 markdown 标记(**只去标记,不改词句**)。 */
export function stripMarkup(s) {
  return String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 规范化键(**去重第二级**):抹掉标点/全半角差异/【】前缀/空白,只留字。
 *  WHY 需要它:同一句结论在 `spec-extract/0-合并索引.md` 与 `2-DESIGN-星.md` 里各存一份、
 *  标点略有差异(`,／,`、`【归属】` 前缀)⇒ 逐字比不出重复,两份会各占一个席位,
 *  第一趟 40 条的预算被同一句话吃掉两条。 */
export function canonKey(s) {
  return String(s ?? '')
    .replace(/[（）()「」【】《》""''‘’“”\[\]]/g, '')
    .replace(/[，,。.：:；;、／/＋+＝=＊*－—\-·…！!？?\s`]/g, '')
    .toLowerCase();
}

/** 独立读得懂的粗筛:开头就是指代词的句子,离开上下文读不懂 ⇒ 不收。 */
export const LEADING_REF = /^(这|那|它|他|她|该|此|本|上述|前述|其中|因此|所以|从而|于是|另外|此外|并且|而且|同时|但是|但|然而|若|如果|当|①②③|注[:：])/;
/** 一眼就不是"结论"的行(操作步骤/命令/纯符号)。 */
export const NOT_A_CONCLUSION = /^(node |npm |git |cd |pwsh |powershell |Select-|Get-|Write-|import |export const|function |const |\|\s*---)/;

/** 这个状态值收不收? → {ok, score, reason} */
export function judgeStatus(raw) {
  const s = stripMarkup(raw);
  if (STATUS_REJECT.includes(s)) return { ok: false, score: 0, reason: '状态=否决集(' + s + ')' };
  for (const k of Object.keys(STATUS_ACCEPT)) if (s.startsWith(k)) return { ok: true, score: STATUS_ACCEPT[k], reason: '' };
  return { ok: false, score: 0, reason: '状态不在接受集(' + s + ')' };
}

/** kind 判定(**规则优先**)。返回 {kind, why} 或 {pending:true, why} —— 不确定就不落。 */
export function classifyKind(text, status) {
  const t = String(text ?? '');
  const st = stripMarkup(status);
  // 「纪律」:DDL 三判据里只有②靠形态能看 —— 但①③判不了 ⇒ 一律进待判清单,永不自动落库。
  if (st === '纪律') return { pending: true, why: '状态列自称纪律:须核三判据(①主人授权的一句指令 ②作用对象是行为 ③违反时能被判据红出来)' };
  if (/(不许|一律|禁止|严禁|永远不|绝不能)/.test(t)) return { pending: true, why: '含禁令词(可能是纪律):须核三判据' };
  // ⚠️ **判 kind 只看文本,不看状态列** —— 实测吃过亏:状态列里几乎每一行都写着「已定／已决／已拍板」,
  //   把状态拼进正则会让**整批候选清一色判成「决定」**(第一趟 dry 的 40 条就是这样,回头看才发现)。
  //   状态只当**兜底**:文本里看不出类别时,才由"带决策态"收口成「决定」。
  //   顺序也要紧:偏好/关系排在决定**前面** —— 「他讨厌文档滞后」哪怕状态写着"已定"也是偏好,不是决定。
  // ⚠️ 裸「承诺」不能当触发词:它是**领域名词**(实测样本「深层库要让『承诺类』的东西…」被误判成承诺,
  //   与此前「习惯」误伤设计理念第 1 条同一种错)⇒ 只认「有人在承诺」的形态。
  if (/(我承诺|承诺过|答应过|说好了|许下)/.test(t)) return { kind: '承诺', why: '含承诺词' };
  if (/(偏好|讨厌|不喜欢|喜欢|口味)/.test(t)) return { kind: '偏好', why: '含偏好词' };
  if (/(约定|纪念日|称呼|并肩|同伴|我们之间)/.test(t)) return { kind: '关系', why: '含关系词' };
  if (/(拍板|裁定|裁决|决定|选了|收敛为|定为)/.test(t)) return { kind: '决定', why: '含决定词' };
  // 兜底的形状要认全:实测状态列写过「已拍(10-04)」「用户拍板」「已确认」三种,漏一个整条就落到默认的「事实」
  //   (审计实测 #19/#21/#24 就是这样把**设计口径**标成了事实)。
  if (/(拍板|已决|已定|已拍|裁定|已确认)/.test(st)) return { kind: '决定', why: '文本里没有类别词,而状态列是决策态(兜底)' };
  return { kind: '事实', why: '默认(关于他的项目/环境的稳定事实,见 prompt.md 判据①的边界澄清)' };
}

/** 注入价值粗算(**排序用,不是判据** —— 判据只管"不许污染",这里管"先灌哪 40 条")。
 *  理由说透:这 411 条是开场注入的全部底料,而第一趟那 40 条会被开场**反复挑中**
 *  ⇒ 优先**行为类与价值排序类**(关系/偏好/承诺/决定/理念),而不是实现细节
 *  (按钮 / 字段 / fetch 那类半年后读也读得懂,但对"我该怎么开口"没帮助)。 */
export function valueScore(text, kind, why) {
  const t = String(text ?? '');
  let v = 0;
  if (kind === '关系' || kind === '偏好' || kind === '承诺') v += 6;
  if (kind === '决定') v += 3;
  if (/设计理念|不可兼得|排序|宁可不|宁可多/.test(String(why ?? '')) || /不可兼得|取舍|优先于/.test(t)) v += 5;
  if (/主人|我们|我答应|并肩/.test(t)) v += 3;
  if (/纪律|规矩|一律|不许|禁止|必须/.test(t)) v += 2;
  if (/contextmenu|preventDefault|tooltip|fetch|接口|字段|schema|端点|按钮|图标|CSS|HTML|SQL|索引/.test(t)) v -= 4;
  return v;
}

/** 闸一 · **过程与当场读数**吗?(prompt.md 判据③ 逐字:「工具输出、报错、进度播报、当时的时间/
 *  状态/数字,半年后取出来只会误导」。)
 *  ⚠️ 只收"本次/这次/本轮/今天/昨晚/刚才"这几个**强**词 —— 「昨天/现在/目前」太常见,
 *  禁掉会把稳定事实一起拦(实测:"昨天"常出现在真结论里,而"昨晚"几乎只出现在过程里)。
 *  ⚠️ 抽成导出函数是为了**能测**:内联在 push() 里的规则测不到,而规矩是"新规则必须配判据"。 */
export function isProcessReading(text) {
  return /(本次|这次|本轮|今天|昨晚|刚才)/.test(String(text ?? ''));
}

/** 闸二 · 分句数(prompt.md 逐字要求「不许把两件事塞进一条」)。
 *  口径:按中英分号切,只数**≥4 字**的分句 —— 太短的不算分句(「跑 1;2 次」不该被算成两件事)。
 *  collect 里「≥3 个分句 ⇒ 拒收」,退回让人拆:在灌库时替主人合并 = 替他写结论,越权。 */
export function clauseCount(text) {
  return String(text ?? '').split(/[;；]/).filter((s) => s.trim().length >= 4).length;
}

/** 近似重复的判据阈值(二元组 Dice)。0.85 刻意偏『宁可并』 —— 判据用的样本见 `near` 那段注释。 */
export const DUP_DICE = 0.85;

/** 二元组 Dice 相似度(0~1)。判"同一句结论在两份文档里各存一份"用。
 *  ⚠️ 为什么不用"包含关系":实测那对样本里,短句**不是**长句的连续子串
 *  (半句插在中间:「层名归一:叫『主动感知层』」 vs 「【归属】层名归一:叫『主动感知层』(旧名本能层)」),
 *  包含判据给 false,而 Dice 给 0.889。 */
export function dice2(a, b) {
  const grams = (s) => { const g = new Set(); for (let i = 0; i < String(s).length - 1; i++) g.add(String(s).slice(i, i + 2)); return g; };
  const ga = grams(a); const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** 重叠系数(|A∩B| / min(|A|,|B|),二元组)。抓"长度不对称"的那种同一句结论:
 *  实测样本「D1『气根』:条目不隶属于枝…」 vs 「D1『气根』的具体含义:条目不隶属于枝…(branch 侧要预留…)」
 *  —— Dice 只有 0.755(被长句的尾巴拉低),重叠系数是 1.0。 */
export function overlap2(a, b) {
  const grams = (s) => { const g = new Set(); for (let i = 0; i < String(s).length - 1; i++) g.add(String(s).slice(i, i + 2)); return g; };
  const ga = grams(a); const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const x of ga) if (gb.has(x)) inter++;
  return inter / Math.min(ga.size, gb.size);
}

// ─────────────────────────── C 档 · 出处核验闸(2026-10-15 · 对抗审计之后加) ───────────────────────────
// 为什么加:第一趟清单的「出处」栏写的是**二手抽取件**(`plans/spec-extract/*.md`)的行号,不是真源行号。
// 审计实测二手件的第 3/4 格 `源文件:N` 有**系统性偏移**:`DESIGN.md:14/15/16/17` 实为 `:19/20/21/22`(+5);
// `:16,146` 的 `:146` 实为 `:152`(+6);`cordis.patch.yml:12` 实为 `:2`(−10)。
// 而清单"抄得准"(二手件标哪行就是哪行)⇒ **逐字比对永远查不出这一类**。本闸把
// 「真源里到底有没有这句话」变成机器判据:
//   ① 出处列解析出真源指针 → 打开真源那一行(±PROV_WINDOW) → 逐字命中 / 只中片段 / 没有;
//   ② 指针解析不了或那一行没有 → 到**真源语料库**里全库搜(排除 spec-extract 这类二手件);
//   ③ 只在二手件里出现、真源全库都没有的句子 ⇒ 疑索引自撰/跨行拼接 ⇒ **退待判,不许落库**。
export const PROV_WINDOW = 10;

/** 比 canonKey 更狠一层:再抹掉表格竖线 —— 二手件常把 `|` 换成 `:`。
 *  实测样本:二手件写「记忆加载策略:三层记忆(L0 常驻人格…)」,真源是表格行
 *  `| D5 | 记忆加载策略 | 三层记忆(L0 常驻人格…) | 早前拍板 |`
 *  ⇒ 不去竖线就判不出"真源里其实有这句",会把一条好结论误退待判。 */
export function flatKey(s) {
  return canonKey(s).replace(/[|‖│]/g, '');
}

/** 结构行:表头分隔、`---`、代码围栏、纯标题 —— 被当"结论行"引用就是锚错位。 */
export function isStructuralLine(s) {
  const t = String(s ?? '').trim();
  if (!t) return true;
  if (/^-{3,}$/.test(t)) return true;
  if (/^\|[\s:|-]+\|?$/.test(t)) return true;
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^(```|~~~)/.test(t)) return true;
  return false;
}

/** 从「出处」格里解析真源指针:`文件.md:12` / `文件.md:12,146` / 缩写式 `主动层:395`。 */
export function parsePointers(cell) {
  const out = [];
  const s = String(cell ?? '');
  const seen = new Set();
  const add = (file, lines, raw, short) => {
    const nums = lines.filter((n) => Number.isFinite(n) && n > 0);
    if (!nums.length) return;
    const key = file + '|' + nums.join(',');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, lines: nums, raw, short: !!short });
  };
  const reFull = /([A-Za-z0-9_\u4e00-\u9fa5.-]+\.(?:md|yml|yaml|js|mjs|cjs|json|txt|ps1))[:：]\s*([\d,\s]+)/g;
  let m;
  while ((m = reFull.exec(s))) add(m[1].replace(/^.*[\\/]/, ''), m[2].split(/[,\s]+/).map((x) => parseInt(x, 10)), m[0], false);
  const reShort = /[`「]([\u4e00-\u9fa5A-Za-z][^\s:：`」]{0,20})[:：]\s*([\d,\s]+)/g;
  while ((m = reShort.exec(s))) {
    if (/\.(md|yml|yaml|js|mjs|cjs|json|txt|ps1)$/.test(m[1])) continue;
    add(m[1], m[2].split(/[,\s]+/).map((x) => parseInt(x, 10)), m[0], true);
  }
  return out;
}

/** 表头 → 列角色。**按表头名取,不按"最长格猜"**(猜过一次:把 44 字的「出处」格当成了结论)。
 *  ⚠️ 各料源的列序**并不相同**:`0-合并索引.md` 是「# | 设定条目 | 标签 | 出处 | 状态线索」,
 *  其余三份是「# | 设定条目 | 出处 | 类别 | 实现线索」⇒ 硬取 cells[4] 会张冠李戴。
 *  isConclusionTable:第一格是「设定条目/结论」**且**有「出处」列 —— 否则它只是某份文档的结构表
 *  (实测 `4-README与CHANGELOG基线.md` 表头是「# | 节名 | 行号范围 | 承担职责 | …」,
 *   那些行是"哪一节写了什么"的目录,不是可灌的结论 ⇒ 整表不入料)。 */
export function columnRoles(header) {
  const hs = (header || []).map((h) => stripMarkup(h));
  const find = (...names) => {
    for (const nm of names) { const i = hs.findIndex((h) => h.includes(nm)); if (i >= 0) return i; }
    return -1;
  };
  const conclusion = find('设定条目', '结论', '条目');
  const source = find('出处', '来源');
  return {
    conclusion, source,
    status: find('状态线索', '状态', '实现线索', '线索'),
    category: find('类别', '标签'),
    isConclusionTable: conclusion >= 0 && source >= 0,
  };
}

/** 真源语料库:(相对路径, 每行原文, 每行 flatKey)。
 *  **排除二手件与清单类产物** —— 否则清单里那 40 条会把"自己"当证据,核验变成自证(C 档的自我污染)。 */
export function buildCorpus(root) {
  const out = [];
  const skip = /(^|[\\/])spec-extract[\\/]|清单|明细|INDEX\.md$|(^|[\\/])_tools[\\/]|独立复跑|审计/;
  const add = (abs) => {
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (skip.test(rel) || !existsSync(abs)) return;
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { return; }
    if (text.length > 900000) return;
    const lines = text.split('\n');
    out.push({ rel, lines, flat: lines.map(flatKey) });
  };
  const plansDir = join(root, 'plans');
  if (existsSync(plansDir)) for (const f of readdirSync(plansDir)) if (f.endsWith('.md')) add(join(plansDir, f));
  for (const rel of ['dsh-ling/DESIGN.md', 'dsh-ling/README.md', 'README.md', 'dsh-ling/CHANGELOG.md']) add(join(root, rel));
  return out;
}

/** 在真源语料库里找这句话(前缀加速的逐行扫描)。返回 {rel,line,raw,coverage} 或 null。 */
export function findInCorpus(corpus, text) {
  const f = flatKey(text);
  if ([...f].length < 8) return null;
  const head = f.slice(0, 8);
  for (const doc of corpus) {
    for (let i = 0; i < doc.flat.length; i++) {
      const fl = doc.flat[i];
      if (fl.length < head.length || !fl.includes(head)) continue;
      if (fl.includes(f)) return { rel: doc.rel, line: i + 1, raw: doc.lines[i], exact: true, coverage: 1 };
    }
  }
  return null;
}

/** 片段覆盖率:把结论按标点切碎,看真源那一行里有几成片段。抓"二手件删节改写"那种。 */
export function fragmentCoverage(text, line) {
  const frags = String(text ?? '').split(/[,，。.、;；:：()（）「」【】/\s]+/).map(flatKey).filter((x) => [...x].length >= 3);
  if (!frags.length) return 0;
  const fl = flatKey(line);
  let hit = 0;
  for (const fr of frags) if (fl.includes(fr)) hit++;
  return hit / frags.length;
}

const TODO_CONTEXT = /交付|待办|TODO|下一步|计划|未做|路线图/;

/** 真源指针能不能解析成盘上的文件?缩写式(`主动层:395`)按"文件名唯一包含该词"兜底;歧义就如实认输。 */
export function resolveSourceFile(root, name) {
  const cands = [join(root, 'plans', name), join(root, 'dsh-ling', name), join(root, name)];
  for (const c of cands) if (existsSync(c)) return c;
  const base = String(name).replace(/\.[^.]+$/, '');
  if (!base) return '';
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (e.name.includes(base)) hits.push(p);
    }
  };
  walk(join(root, 'plans'), 0);
  if (hits.length === 1) return hits[0];
  const md = hits.filter((h) => h.endsWith('.md'));
  if (md.length === 1) return md[0];
  return '';
}

/** 主闸:这句话在真源里到底有没有?
 *  status = self(本文件就是真源) / verified(真源命中) / partial(真源只中片段)
 *         / corpus(真源别处命中) / corpus-todo(命中处在"交付/待办"区) / missing(真源全库都没有)。 */
/** 真源那一行**自己**的措辞是不是「还没定」?(实测 2026-10-15:一条被二手件标「已拍板(D3)」的结论,
 *  匹配到的真源行原文是「草案建议:A + C(自动跑,允许手补/重跑)。」—— 状态是二手件给的,
 *  真源那行自称草案。不丢(状态可能真来自别处),但必须**标出来**。) */
export const STANCE_WEAK = /草案|建议|待拍板|待定|设想|候选|待商/;

/** 真源那一行原文(给主人核对用,截断 90 字;表格竖线会被转义,不破坏清单表格)。 */
export function clipLine(s) {
  return stripMarkup(String(s ?? '')).slice(0, 90);
}

/** 主闸:这句话在真源里到底有没有?
 *  status = self(本文件就是真源) / verified(真源逐字命中) / partial(真源片段 ≥60%,留)
 *         / corpus(真源别处逐字命中,出处改指) / weak(真源只有"措辞不同的近邻",退待判)
 *         / corpus-todo(命中处在交付/待办区,退待判) / missing(真源全库无对应,退待判)。
 *  ⚠️ 为什么必须分 weak 与 missing(2026-10-15 实测吃的亏):二手件会把真源的**表格行改写成一句话**,
 *  实测样本:二手件写「记忆树变更感知(未读水位):主人的结构改动在她下一次开口前注入,只报没见过的」,
 *  真源 `DESIGN-主动层-讨论底稿.md:45` 是表格行「② | **变更感知(未读水位)** | 主人对记忆树的**结构改动**,
 *  在她下一次开口前注入;只报没见过的」 —— 同一件事、措辞不同,片段只有 50%。
 *  一律判成"真源没有这句话"就是**我自己在编** ⇒ 分档:≥60% 留、34%~60% 退待判并**带上最像的那一行原文**、
 *  34% 以下才说"无对应"。三档都印真源原文,人一眼能看出是改写还是自撰。 */
/** 主闸:这句话在真源里到底有没有?
 *  证据强弱(取**最有力**的一条,不是取第一条):
 *    verified(逐字命中) > partial(片段 ≥60%) > corpus(真源别处逐字命中) > weak(措辞不同的近邻) > missing。
 *  ⚠️ 为什么必须"取最有力"而不是"取第一条"(2026-10-15 实测):一条结论的出处格常带**多个指针**
 *  (实测 `#48` 写的是 `DESIGN.md:17,354,358` · `DESIGN-主动层-讨论底稿.md:52` · `PROACTIVE-LAYER.md:66`),
 *  第一条只中 40% 片段、第二条是**逐字命中** —— 见 weak 就 return 会把一条好结论错判成"出处核不过"。
 *  ⚠️ 为什么必须分 weak 与 missing:二手件会把真源的**表格行改写成一句话**(实测 `记忆树变更感知(未读水位)…`
 *  对真源 `DESIGN-主动层-讨论底稿.md:45` 的表格行,片段只 50%)。一律判"真源没有这句话"就是**我自己在编**;
 *  ⇒ 分档:≥60% 留、34%~60% 退待判并带最像的那一行原文、34% 以下才说"无对应"。三档都印真源原文。 */
export function verifyProvenance(text, pointers, corpus, opts = {}) {
  const win = opts.window ?? PROV_WINDOW;
  const partialMin = opts.partialMin ?? 0.6;
  const weakMin = opts.weakMin ?? 0.34;
  const f = flatKey(text);
  const cache = opts.cache || (opts.cache = new Map());
  const flatOf = (abs) => {
    if (!cache.has(abs)) {
      let ls = [];
      try { ls = readFileSync(abs, 'utf8').split('\n'); } catch { ls = []; }
      cache.set(abs, { lines: ls, flat: ls.map(flatKey) });
    }
    return cache.get(abs);
  };
  const RANK = { verified: 5, partial: 4, corpus: 3, 'corpus-todo': 3, weak: 2, missing: 1 };
  const better = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return (RANK[a.status] || 0) >= (RANK[b.status] || 0) ? a : b;
  };
  let best = null;
  let unresolved = 0;
  let firstFile = '';
  if (f.length >= 8) {
    for (const p of pointers || []) {
      const abs = resolveSourceFile(opts.root, p.file);
      if (!abs) { unresolved++; continue; }
      const rel = relative(opts.root, abs).replace(/\\/g, '/');
      if (!firstFile) firstFile = rel;
      const doc = flatOf(abs);
      if (!doc.lines.length) continue;
      // ① 指针行 ±win:逐字 / 片段
      let exact = null;
      let near = { cov: 0, line: 0, delta: 0 };
      for (const n of p.lines) {
        for (let d = -win; d <= win; d++) {
          const i = n + d - 1;
          if (i < 0 || i >= doc.lines.length) continue;
          if (!exact && doc.flat[i].includes(f)) {
            exact = { status: 'verified', file: rel, line: i + 1, delta: d, coverage: 1,
              flag: d === 0 ? '' : ('指针漂移 ' + (d > 0 ? '+' : '') + d), raw: clipLine(doc.lines[i]), note: '' };
          }
          const cov = fragmentCoverage(text, doc.lines[i]);
          if (cov > near.cov) near = { cov, line: i + 1, delta: d };
        }
      }
      if (exact) { best = better(best, exact); continue; }
      if (near.cov >= partialMin) {
        best = better(best, { status: 'partial', file: rel, line: near.line, delta: near.delta, coverage: near.cov,
          flag: '真源片段 ' + Math.round(near.cov * 100) + '%' + (near.delta ? ('(漂移 ' + (near.delta > 0 ? '+' : '') + near.delta + ')') : ''),
          raw: clipLine(doc.lines[near.line - 1]), note: '' });
        continue;
      }
      // ② 整个真源文件里找最像的一行(缓存过,不重复读盘)
      let wide = { cov: 0, line: 0 };
      for (let i = 0; i < doc.lines.length; i++) {
        if (doc.flat[i].includes(f)) { wide = { cov: 1, line: i + 1 }; break; }
        const cov = fragmentCoverage(text, doc.lines[i]);
        if (cov > wide.cov) wide = { cov, line: i + 1 };
      }
      if (wide.cov >= partialMin) {
        best = better(best, { status: 'partial', file: rel, line: wide.line, delta: null, coverage: wide.cov,
          flag: '真源别处 L' + wide.line + '(片段 ' + Math.round(wide.cov * 100) + '%)',
          raw: clipLine(doc.lines[wide.line - 1]), note: '' });
        continue;
      }
      const anchorLine = doc.lines[p.lines[0] - 1];
      if (isStructuralLine(anchorLine)) {
        best = better(best, { status: 'missing', file: rel, line: p.lines[0], delta: 0, coverage: wide.cov,
          flag: '锚到结构行', raw: clipLine(anchorLine), note: '指针那一行是表头/分隔符/围栏,不是结论行' });
        continue;
      }
      if (wide.cov >= weakMin) {
        best = better(best, { status: 'weak', file: rel, line: wide.line, delta: null, coverage: wide.cov,
          flag: '真源措辞不同(最像 L' + wide.line + ',片段 ' + Math.round(wide.cov * 100) + '%)',
          raw: clipLine(doc.lines[wide.line - 1]), note: '二手件改写过:须人核' });
        continue;
      }
      best = better(best, { status: 'missing', file: rel, line: wide.line || p.lines[0], delta: null, coverage: wide.cov,
        flag: '真源无对应句', raw: clipLine(doc.lines[(wide.line || p.lines[0]) - 1]), note: '' });
    }
  }
  // ③ 全库兜底:真源别处**逐字**有这句 ⇒ 出处改指真源(比"措辞不同的近邻"强)
  if (!best || (RANK[best.status] || 0) < 3) {
    const hit = findInCorpus(corpus, text);
    if (hit) {
      const doc2 = corpus.find((d) => d.rel === hit.rel);
      let todo = false;
      if (doc2) for (let i = Math.max(0, hit.line - 30); i < hit.line; i++) if (/^#{1,6}\s/.test(doc2.lines[i]) && TODO_CONTEXT.test(doc2.lines[i])) todo = true;
      best = better(best, { status: todo ? 'corpus-todo' : 'corpus', file: hit.rel, line: hit.line, delta: null, coverage: 1,
        flag: todo ? '真源处在"交付/待办"区' : '出处改指真源', raw: clipLine(hit.raw), note: '' });
    }
  }
  if (!best) {
    best = { status: 'missing', file: firstFile || ((pointers && pointers[0] && pointers[0].file) || ''), line: 0,
      delta: null, coverage: 0, raw: '',
      flag: (pointers && pointers.length) ? (unresolved === pointers.length ? '出处指针解析不出文件' : '真源全库无对应句') : '出处未标',
      note: '' };
  }
  // 最后一关:真源那一行**自己**的措辞是不是「还没定」(见 STANCE_WEAK 的注释)。
  //  不丢 —— 状态可能确实来自别处;但旗标要打出来,让人一眼看到「这句的靠山是个草案」。
  if (best && best.raw && STANCE_WEAK.test(best.raw)) {
    best = { ...best, flag: (best.flag ? best.flag + ' · ' : '') + '⚠️真源这行自称草案/建议' };
  }
  return best;
}
/** 闸的裁决:能不能落库。**宁可退待判** —— 半年前一条"看着像结论"的句子,比少一条更贵。 */
export function provenanceVerdict(prov) {
  const st = prov && prov.status;
  if (st === 'self' || st === 'verified' || st === 'partial' || st === 'corpus') return { ok: true, flag: (prov && prov.flag) || '' };
  if (st === 'weak') return { ok: false, reason: '真源只有措辞不同的近邻(' + ((prov && prov.flag) || '') + '):二手件改写过,须人核' };
  if (st === 'corpus-todo') return { ok: false, reason: '真源里这句话处在"交付/待办"区(疑把待办读成了事实)' };
  if (st === 'missing') return { ok: false, reason: '真源里找不到对应句(' + ((prov && prov.flag) || '') + ')' };
  return { ok: false, reason: '出处核不出来' };
}
/** 闸三 · **含当场读数**吗?(审计实测:#12 写着「历史 116 个会话」,而真源自己标注
 *  「⚠️ 范围待重拍 —— 补录后"有原文的会话"由 116 → 1,616」⇒ 半年后必误导;
 *  #37 写着「热路径从 ~24ms 降到 ~1ms 量级」,真源同句是**当时实测**。)
 *  ⚠️ 必须分**常量**与**读数**:「底线 bottomLines 上限 5 条」里的 5 是设计常量(不该拦),
 *  「116 个会话」「从 ~24ms 降到 ~1ms」是当时测出来的数(该拦)⇒ 先看常量词,再看读数码。 */
export const READING_CONSTRAINT = /(上限|最多|不超过|至少|限量|阈值|硬闸|下限|预算)[^。;；]{0,6}?\d/;
export const READING_SIGNAL = /(\d+\s*(ms|毫秒|秒|分钟|小时|个会话|次会话|行|字节|MB|KB|GB|%|倍))|(降[到至]\s*[~≈]?\d)|([~≈]\d+\s*(ms|毫秒|秒))|量级/;
export function isReadingBearing(text) {
  const t = String(text ?? '');
  if (READING_CONSTRAINT.test(t)) return false;
  return READING_SIGNAL.test(t);
}

/** 一行/一行的候选过闸。返回 {ok} 或 {ok:false, reason}。 */
export function gateCandidate({ text, status, line, sectionStale }) {
  if (sectionStale) return { ok: false, reason: '小节标题命中作废词(污染闸①)' };
  const raw = String(line ?? '');
  if (/~~/.test(raw) || /~~/.test(String(text ?? ''))) return { ok: false, reason: '含删除线(污染闸①)' };
  if (/➡️/.test(raw) && !/➡️/.test(String(text ?? ''))) return { ok: false, reason: '同一行带"➡️ 更正"(取更正那句,不取原句)' };
  const t = stripMarkup(text);
  if (!t) return { ok: false, reason: '空文本' };
  if (LEADING_REF.test(t)) return { ok: false, reason: '开头是指代词:离开上下文读不懂' };
  if (NOT_A_CONCLUSION.test(t)) return { ok: false, reason: '是命令/步骤而不是结论' };
  const n = [...t].length;
  if (n > TEXT_MAX) return { ok: false, reason: '超 ' + TEXT_MAX + ' 字(实际 ' + n + '):**不自动改写**' };
  if (n < 8) return { ok: false, reason: '太短(' + n + ' 字):不像一句能独立读懂的结论' };
  const st = judgeStatus(status);
  if (!st.ok) return { ok: false, reason: st.reason };
  return { ok: true, text: t, chars: n, hardness: st.score };
}

/** 把 markdown 表格解析成 {header, rows:[{cells, line}]}(表头缺失时 header 为空数组)。 */
export function parseTables(text) {
  const out = [];
  let header = null;
  let cur = null;
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(L);
    if (isRow) {
      const cells = L.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // 分隔行
      if (!header) { header = cells; cur = { header, rows: [] }; out.push(cur); continue; }
      cur.rows.push({ cells, line: i + 1, raw: L });
      continue;
    }
    if (!isRow) { header = null; cur = null; }   // 表格结束
  }
  return out;
}

/** 表格里按表头名找列;**找不到就按形状猜**(结论列 = 最长的一格)。 */
export function columnIndex(header, names, cells) {
  const hs = (header || []).map((h) => stripMarkup(h));
  for (const nm of names) {
    const i = hs.findIndex((h) => h.includes(nm));
    if (i >= 0) return i;
  }
  // 形状兜底:取最长的格子当结论(表头缺失或名字不认识时)
  let best = -1; let len = -1;
  cells.forEach((c, i) => { const n = stripMarkup(c).length; if (n > len) { len = n; best = i; } });
  return best;
}

// ───────────────────────────── 料源清单(第一趟) ─────────────────────────────
export function listSpecExtractDocs(root) {
  const dir = join(root, 'plans', 'spec-extract');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => join(dir, f));
}

/** DESIGN.md 的"已定"两节:§0 决策表(D1..D7)+ §0.1 设计理念(甲/乙篇的 **N · 标题** 行)。 */
export function extractDesignSections(text) {
  const lines = String(text ?? '').split('\n');
  const out = { decisions: [], principles: [] };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const m = /^\|\s*(D\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/.exec(L);
    if (m) { out.decisions.push({ id: m[1], title: m[2].trim(), text: m[3].trim(), line: i + 1, raw: L }); continue; }
    const p = /^\*\*(\d+)\s*·\s*([^*]+)\*\*\s*$/.exec(L.trim());
    if (p) { out.principles.push({ n: Number(p[1]), text: p[2].trim(), line: i + 1, raw: L }); continue; }
  }
  return out;
}

/** 既有条目的文本集合(去重与"已灌过"判定)。 */
export function existingTexts(db) {
  const set = new Set();
  for (const r of db.prepare('SELECT text FROM deep_item').all()) { set.add(stripMarkup(r.text)); set.add(canonKey(r.text)); }
  return set;
}

// ───────────────────────────── 主流程 ─────────────────────────────
function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/** 第一趟**总**预算还够几条(2026-10-15 事故后加)。
 *  WHY 必须有它:`commit` 的去重只保证"同一句话不落两次",而 `collect` 的选取取的是
 *  **库里还没有的候选** ⇒ 连跑两遍 `--commit` 会静默落成 80 条(我实测踩过:第二遍印的是
 *  `新写入 40 / 幂等命中 0`,因为那 40 条是第 41~80 名,不是重复)。
 *  ⇒ `≤40 条`是**全趟总预算**,不是"每次最多 40"。 */
export function remainingBudget(db, limit = FIRST_PASS_LIMIT) {
  const n = Number(db.prepare('SELECT COUNT(*) n FROM deep_item WHERE origin=?').get(ORIGIN)?.n) || 0;
  return { alreadyImported: n, budget: Math.max(0, limit - n) };
}

export function collect({ root, db, limit = FIRST_PASS_LIMIT }) {
  // 真源语料库:核验「这句话真源里有没有」用。**它排除 spec-extract 与清单类产物** ——
  // 否则清单里那 40 条会把自己当证据(自证),理由写在 buildCorpus 的注释里。
  const corpus = buildCorpus(root);
  const seen = db ? existingTexts(db) : new Set();
  const canon = [];   // 已收候选的规范化键 + 它的候选对象(供"近似重复"那一级判重,并在需要时换成更全的那条)
  const report = {
    scanned: [], candidates: [], rejected: [], pendingDiscipline: [], duplicates: [], overLimit: [],
    // 2026-10-15 自审新增两个桶:待判被并掉的出处 / 疑重复灰区(0.6~0.85)
    pendingMerged: [], suspicious: [],
    // 2026-10-15 审计回执之后新增:出处核不过的 / 含当场读数的 / 每张表的列角色(自查取列取对没有)
    pendingProv: [], readings: [], tables: [],
    stats: { rows: 0, kept: 0, rejected: 0, dup: 0, pending: 0, suspicious: 0, pendingProv: 0, readings: 0, suspiciousMerged: 0 },
  };
  const push = (text, kind, why, hardness, srcFile, lineNo, status, raw, prov) => {
    const rel = relative(root, srcFile).replace(/\\/g, '/');
    const key = stripMarkup(text);
    const ck = canonKey(key);
    // ── 形态闸(2026-10-15 自审加:清单出来之后、给主人看之前发现的)────────────────────
    //  闸一 · 过程与当场读数:prompt.md 判据③ 逐字「工具输出、报错、进度播报、当时的时间/状态/数字,
    //   半年后取出来只会误导」。原先只有『状态列 + 禁令词』两道闸,于是一条写着「本次不需要改」的
    //   过程读数以「纪律」形混进了待判清单(实测)⇒ 这里按**词形**再拦一道。
    if (isProcessReading(key)) {
      report.rejected.push({ src: rel + ':' + lineNo, why: '疑似过程读数(判据③:半年后取出来只会误导)', text: key.slice(0, 44) });
      report.stats.rejected++; return;
    }
    //  闸二 · 一条一事:prompt.md 逐字要求「不许把两件事塞进一条」。三个以上分句的条目**必然**是
    //   多件事(实测样本:「触发＝…;视野＝…;升格去向＝…;燃料＝惊讶」四条塞进一条)⇒ 退回去让人拆。
    //   为什么不在这里替主人合并:改词句 = 替他写结论,那是越权(与『D 档只读』同一条线)。
    const clauses = clauseCount(key);
    if (clauses >= 3) {
      report.rejected.push({ src: rel + ':' + lineNo, why: '多事合一(' + clauses + ' 个分句):prompt.md 逐字要求「不许把两件事塞进一条」', text: key.slice(0, 44) });
      report.stats.rejected++; return;
    }
    //  闸三 · 含当场读数(2026-10-15 · 审计回执之后加):见 isReadingBearing 的注释。
    if (isReadingBearing(key)) {
      report.readings.push({ src: rel + ':' + lineNo, text: key, why: '含当场读数:半年后可能误导,交主人裁' });
      report.stats.readings++; return;
    }
    //  闸四 · **出处核验**(2026-10-15 · 审计回执之后加):真源里到底有没有这句话。
    //   这是本工具最后加、也最要紧的一道 —— 判据不在「二手件抄得准不准」,而在「真源认不认」。
    {
      const v = provenanceVerdict(prov);
      if (!v.ok) {
        report.pendingProv.push({ text: key, why: v.reason, src: rel + ':' + lineNo,
          raw: (prov && prov.raw) || '',
          prov: prov ? (prov.status + (prov.file ? ' @ ' + prov.file + (prov.line ? ':' + prov.line : '') : '')) : '' });
        report.stats.pendingProv++; return;
      }
    }
    // 三级去重:①逐字 ②规范化 ③**包含关系**。
    //   为什么要有③:同一句结论在一份文档里多半个前缀或少一句尾注,规范化也抹不平 ——
    //   实测样本:「层名归一:叫『主动感知层』」 vs 「【归属】层名归一:叫『主动感知层』(旧名本能层)」;
    //   以及「提炼触发＝空闲边界 ＋ 手动」 vs 「提炼触发 = 空闲边界 + 手动」。
    //   包含判定只在**短的那条 ≥ 长的 55%** 时生效 —— 免得把"半句话"与"整句话"误并成一条。
    //   判据用**二元组 Dice**(≥ `DUP_DICE`),不用"包含关系" —— 理由见 dice2 的注释(实测两者结论相反)。
    //   阈值 0.85 偏"宁可并":并错一条的代价(清单里少一句、他过目时看得出来)远小于**同一句话占掉两个席位**。
    let near = false; let nearOverlap = 0; let nearIdx = -1;
    if (ck.length >= 12) {
      for (let i = 0; i < canon.length; i++) {
        const s = canon[i].ck;
        if (s.length < 12) continue;
        const ov = overlap2(ck, s);
        // ⚠️ 两条闸**同时**要过:重叠系数管"是不是同一句",长度比 0.5 管"别把半句话并进整句话"。
        const ratio = Math.min(ck.length, s.length) / Math.max(ck.length, s.length);
        if (ov >= DUP_DICE && ratio >= 0.5) { near = true; nearOverlap = ov; nearIdx = i; break; }
      }
    }
    if (seen.has(key) || (ck.length >= 12 && seen.has(ck))) {
      report.duplicates.push({ text: key.slice(0, 48), src: rel + ':' + lineNo, canonical: true, near: false, overlap: 0 });
      report.stats.dup++; return;
    }
    if (near) {
      // 近重复:**留更全的那条**(两条都在 80 字内 ⇒ 长者信息是短者的超集)。
      //   实测样本:短句「【开口层】面板卡『她的话』是开口层本体(留白式,不是推送式)」 vs
      //   长句「面板卡『她的话』是开口层本体…;通道优先级 = 面板卡 → 开场白 → 飞书出站」——
      //   只留先到的那条,会把"通道优先级"这半句信息丢掉。
      const prev = canon[nearIdx];
      report.stats.dupNear = (report.stats.dupNear || 0) + 1;
      if (ck.length > prev.ck.length && ck.length <= TEXT_MAX) {
        report.duplicates.push({ text: stripMarkup(prev.cand.text).slice(0, 48), src: rel + ':' + lineNo,
          canonical: false, near: true, overlap: nearOverlap, replacedBy: key.slice(0, 48) });
        seen.delete(prev.ck);
        canon.splice(nearIdx, 1);
        prev.cand.text = key;
        prev.cand.chars = [...key].length;
        prev.cand.src = rel;
        prev.cand.line = lineNo;
        prev.cand.status = stripMarkup(status);
        prev.cand.convId = 'doc:' + rel;
        prev.cand.why = why + ' ·(与另一处近似重复:重叠 ' + nearOverlap.toFixed(2) + ',留更全的一条)';
        prev.cand.provStatus = prov ? prov.status : ''; prev.cand.provFile = prov ? prov.file : '';
        prev.cand.provLine = prov ? prov.line : 0; prev.cand.provDelta = (prov && prov.delta) || 0;
        prev.cand.provFlag = prov ? (prov.flag || '') : '';
        seen.add(key);
        seen.add(ck);
        canon.push({ ck, cand: prev.cand });
      } else {
        report.duplicates.push({ text: key.slice(0, 48), src: rel + ':' + lineNo,
          canonical: false, near: true, overlap: nearOverlap });
        report.stats.dup++;
      }
      return;
    }
    const cand = {
      text: key, kind, why, hardness, src: rel, line: lineNo,
      status: stripMarkup(status), convId: 'doc:' + rel, raw: String(raw).slice(0, 160),
      // 出处核验的结果 —— 清单的「出处」栏印的是**真源**行号,不再印二手件的行号
      provStatus: prov ? prov.status : '', provFile: prov ? prov.file : '',
      provLine: prov ? prov.line : 0, provDelta: (prov && prov.delta) || 0,
      provFlag: prov ? (prov.flag || '') : '', provNote: prov ? (prov.note || '') : '',
      provRaw: prov ? (prov.raw || '') : '',
    };
    report.candidates.push(cand);
    seen.add(key);
    if (ck.length >= 12) { seen.add(ck); canon.push({ ck, cand }); }
  };

  // ① spec-extract 各文档的表格行(**二手件** —— 每行都带一个指向真源的「出处」指针)
  for (const file of listSpecExtractDocs(root)) {
    const text = readFileSync(file, 'utf8');
    report.scanned.push(relative(root, file).replace(/\\/g, '/'));
    let stale = false;
    let roles = null;      // 当前表的列角色(按**表头名**取)
    let tableOk = false;   // 这张表是不是"结论表"
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const h = /^#{1,6}\s+(.*)$/.exec(L);
      if (h) stale = SECTION_STALE.test(h[1]);
      if (!/^\s*\|.*\|\s*$/.test(L)) { roles = null; tableOk = false; continue; }
      if (/^\s*\|[\s:|-]+\|\s*$/.test(L)) continue;
      const cells = L.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const head = stripMarkup(cells[0]);
      if (/^(编号|#|id|序|no\.?)$/i.test(head)) {
        roles = columnRoles(cells);
        tableOk = roles.isConclusionTable;
        report.tables.push({ file: report.scanned.slice(-1)[0], line: i + 1, cols: roles, ok: tableOk });
        continue;
      }
      report.stats.rows++;
      if (!tableOk || !roles) {
        report.rejected.push({ src: report.scanned.slice(-1)[0] + ':' + (i + 1),
          why: '这张表不是结论表(既无「设定条目/结论」列,也无「出处」列)',
          text: stripMarkup(cells[1] || cells[0]).slice(0, 44) });
        report.stats.rejected++; continue;
      }
      // ⚠️ 列位**按表头名取**(2026-10-15 实测:**各料源列序并不相同** —— `0-合并索引.md` 是
      //   「# | 设定条目 | 标签 | 出处 | 状态线索」,其余三份是「# | 设定条目 | 出处 | 类别 | 实现线索」),
      //   **不按"最长格猜"** —— 猜会把「出处」那一格(`DESIGN-…md:274,161`,44 字)当成结论:
      //   第一趟 dry 的清单里真印出过这一条(`[决定] DESIGN-深层库与检索面-20261004.md:274,161`)。
      const textCell = cells[roles.conclusion];
      const srcCell = roles.source >= 0 ? cells[roles.source] : '';
      const statusCell = roles.status >= 0 ? cells[roles.status] : '';
      const g = gateCandidate({ text: textCell, status: statusCell, line: L, sectionStale: stale });
      if (!g.ok) { report.rejected.push({ src: report.scanned.slice(-1)[0] + ':' + (i + 1), why: g.reason, text: stripMarkup(textCell).slice(0, 44) }); report.stats.rejected++; continue; }
      const k = classifyKind(g.text, statusCell);
      if (k.pending) { report.pendingDiscipline.push({ text: g.text, why: k.why, src: report.scanned.slice(-1)[0] + ':' + (i + 1) }); report.stats.pending++; continue; }
      // ★ 出处核验:二手件的「出处」格 → 打开真源那一行,看真源里到底有没有这句话
      const prov = verifyProvenance(g.text, parsePointers(srcCell), corpus, { root });
      push(g.text, k.kind, k.why, g.hardness, file, i + 1, statusCell, L, prov);
    }
  }

  // ② DESIGN.md 的 §0 决策表 + §0.1 设计理念
  const design = join(root, 'dsh-ling', 'DESIGN.md');
  if (existsSync(design)) {
    report.scanned.push(relative(root, design).replace(/\\/g, '/'));
    const { decisions, principles } = extractDesignSections(readFileSync(design, 'utf8'));
    for (const d of decisions) report.stats.rows++;
    for (const d of decisions) {
      // 决策表是「# | 决策(标题) | 内容 | 来源」两格拼着的:只取内容格会失去主词
      // (实测:「方案 A:官方 slot …」单看读不懂"哪个方案 A")⇒ 标题当主词拼上(**不改词句**)。
      const dText = d.title && !stripMarkup(d.text).startsWith(d.title) ? (d.title + ':' + d.text) : d.text;
      const g = gateCandidate({ text: dText, status: '用户拍板', line: d.raw, sectionStale: false });
      if (!g.ok) { report.rejected.push({ src: 'dsh-ling/DESIGN.md:' + d.line, why: g.reason, text: g.text || stripMarkup(d.text).slice(0, 40) }); report.stats.rejected++; continue; }
      const k = classifyKind(g.text, '用户拍板');
      if (k.pending) { report.pendingDiscipline.push({ text: g.text, why: k.why, src: 'dsh-ling/DESIGN.md:' + d.line }); report.stats.pending++; continue; }
      // 这一节的出处就是本文件自身 ⇒ 无二手件、无需外核(status='self' 直接过闸)
      push(g.text, k.kind, k.why + '(决策表 ' + d.id + ')', g.hardness, design, d.line, '用户拍板', d.raw,
        { status: 'self', file: 'dsh-ling/DESIGN.md', line: d.line, delta: 0, coverage: 1, flag: '本源即真源', note: '' });
    }
    // 理念行是"**N · 标题**":标题短,常读不懂 ⇒ 把标题与紧随其后的第一句拼起来(不改词句,只拼接)
    for (const p of principles) {
      const lines2 = readFileSync(design, 'utf8').split('\n');
      let body = '';
      for (let j = p.line; j < Math.min(p.line + 6, lines2.length); j++) {
        const s = stripMarkup(lines2[j]).replace(/^[-*·]\s*/, '');   // 去列表标记:原文是 `- 不可兼得时保什么:…`
        if (s && !/^\*\*/.test(lines2[j].trim())) { body = s; break; }
      }
      // 正文形如「保什么:保人格的自主权。宁可少一条习惯…」⇒ 只留冒号之后那句(**不改词句**,只是选段)
      const mKeep = /保什么[:：]\s*(.+)$/.exec(body);
      const tail = mKeep ? mKeep[1].trim() : body;
      const joined = tail ? (p.text + ':' + tail) : p.text;
      const g = gateCandidate({ text: joined, status: '主人拍板', line: p.raw, sectionStale: false });
      if (!g.ok) { report.rejected.push({ src: 'dsh-ling/DESIGN.md:' + p.line, why: '理念条:' + g.reason, text: stripMarkup(joined).slice(0, 44) }); report.stats.rejected++; continue; }
      const k = classifyKind(g.text, '主人拍板');
      // ⚠️ 2026-10-15 自审订正(**清单出来之后、给主人看之前**):**理念一律进待判,不自动落库**。
      //   理由(DDL 逐字):「决定管一次、纪律管**以后每一次**」—— 理念回答「两者不可兼得时保什么」,
      //   管的是以后每一次 ⇒ 它天生是**纪律形**;而纪律要过三判据,③「违反时能被判据红出来」机器答不出
      //   (「保真优先于简洁」违反时哪条判据红?要人点名)。
      //   原先这条只对『含禁令词』的理念生效 ⇒ 「宁可…也不…」那 11 条排序原则全当 `决定` 进了第一趟
      //   清单 —— 那是**误判 kind**(决定管一次,不管以后每一次),不是风格问题 ⇒ 整批退回去等人补 ③。
      report.pendingDiscipline.push({ text: g.text,
        why: '设计理念第 ' + p.n + ' 条(排序原则 ⇒ 纪律形):须人补③「哪条判据会红」;' + k.why,
        src: 'dsh-ling/DESIGN.md:' + p.line });
      report.stats.pending++;
      continue;
    }
  }

  // ── 待判清单也要去重(2026-10-15 自审加)────────────────────────────────────────
  //  实测:待判那 34 条里「凡写入器灵身份的动作一律提议→审核」出现两次、「API 拒绝一律 403+reason」
  //  两次、「归属」三次、「sealHash」两次 —— 因为去重只跑在 candidates 上,**待判是绕过去重进的**。
  //  同一句话在待判清单里出现两遍,会让人以为是两条不同的纪律 ⇒ 这里用与 candidates 同一套判据
  //  (重叠系数 ≥0.85 且长度比 ≥0.5)去重,被并掉的出处照样留着(不静默)。
  {
    const kept = []; const merged = [];
    for (const p of report.pendingDiscipline) {
      const ck = canonKey(stripMarkup(p.text));
      let hit = -1;
      for (let i = 0; i < kept.length; i++) {
        const s = kept[i].ck;
        if (s === ck) { hit = i; break; }
        if (s.length < 12 || ck.length < 12) continue;
        const ov = overlap2(ck, s);
        const ratio = Math.min(ck.length, s.length) / Math.max(ck.length, s.length);
        if (ov >= DUP_DICE && ratio >= 0.5) { hit = i; break; }
      }
      if (hit < 0) { kept.push({ ck, p, alsoAt: [] }); continue; }
      const k0 = kept[hit];
      // 留**更全**的那条(与 candidates 同一口径):判定理由取长者那一条,两边出处都留着
      if ([...ck].length > [...k0.ck].length) { k0.alsoAt.push(k0.p.src); k0.p = p; k0.ck = ck; }
      else k0.alsoAt.push(p.src);
      merged.push({ text: stripMarkup(p.text).slice(0, 48), keptAt: kept[hit].p.src, alsoAt: p.src });
    }
    report.pendingDiscipline = kept.map((k) => { const p = k.p; if (k.alsoAt.length) p.alsoAt = k.alsoAt.slice(); return p; });
    report.pendingMerged = merged;
    report.stats.pending = report.pendingDiscipline.length;
  }
  // ── 疑重复灰区(重叠 0.6~0.85):**不自动丢**,列出来让人裁决(2026-10-15 自审加)──────
  //  实测漏网样本:同一条「人格承载」在三份文档里措辞不同(一份写『自建注入段+结构化字段』,
  //  另一份写『自注入段＋设置页结构化字段…链路=字段→组装器→L0 文本→按会话快照注入』)⇒ 0.85 判不出。
  //  与其把阈值下调到『宁可错并』(并错=少一条真结论,且他看不出来),不如把这段灰区**列出来**由人裁。
  {
    const sus = [];
    const dropIdx = new Set();   // 灰区里被判"留更全的一条"而掉的下标(2026-10-15 审计之后加)
    const cs = report.candidates;
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
      const a = canonKey(stripMarkup(cs[i].text)); const b = canonKey(stripMarkup(cs[j].text));
      if (a.length < 12 || b.length < 12) continue;
      const ov = overlap2(a, b);
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ov >= 0.6 && ov < DUP_DICE && ratio >= 0.5) {
        // 灰区**也要二选一**(2026-10-15 审计之后加):审计实测 #18/#22 与 #25/#30 两对都在灰区里列着、
        // 同一趟**又都落了** —— 「列出来由人裁」若没有回填机制,等于没拦。
        // 口径与 0.85 之上一致:**留更全的那条**;被并掉的那条照样打印(不静默)。
        const drop = b.length > a.length ? i : j;
        dropIdx.add(drop);
        sus.push({ a: cs[i].text.slice(0, 40), b: cs[j].text.slice(0, 40), overlap: Number(ov.toFixed(3)),
          aSrc: cs[i].src + ':' + cs[i].line, bSrc: cs[j].src + ':' + cs[j].line,
          kept: drop === i ? (cs[j].src + ':' + cs[j].line) : (cs[i].src + ':' + cs[i].line) });
      }
    }
    if (dropIdx.size) {
      report.candidates = cs.filter((_, i) => !dropIdx.has(i));
      report.stats.suspiciousMerged = dropIdx.size;
    }
    report.suspicious = sus.slice(0, 40);
    report.stats.suspicious = sus.length;
  }

  // 排序:硬度 ↓ → 注入价值 ↓ → 类别 ↓ → 短的先
  const KIND_RANK = { 承诺: 5, 纪律: 5, 关系: 4, 偏好: 4, 决定: 3, 事实: 1 };
  for (const c of report.candidates) c.value = valueScore(c.text, c.kind, c.why);
  // 过时风险分档(2026-10-15):每条候选**自己**带 durability,落库按它写(不再一律 long)。
  for (const c of report.candidates) {
    const d = classifyDurability(c.text, c.kind);
    c.durability = d.durability;
    c.durWhy = d.why;
  }
  report.candidates.sort((a, b) => (b.hardness - a.hardness)
    || (b.value - a.value)
    || (KIND_RANK[b.kind] - KIND_RANK[a.kind])
    || (a.chars ?? a.text.length) - (b.chars ?? b.text.length)
    || a.src.localeCompare(b.src));
  // 单文档席位上限:不让一份文档吃掉整趟(40 × 40% = 16),否则"第一趟"就变成某一份的专场
  const perDocCap = Math.max(8, Math.round(limit * 0.4));
  // 预算 = 总限量 − 本 origin 已落条数(2026-10-15 事故后加;见 remainingBudget 的注释)
  const { alreadyImported, budget } = remainingBudget(db, limit);
  report.stats.alreadyImported = alreadyImported;
  report.stats.budget = budget;
  const perDoc = new Map();
  const selected = [];
  const spilled = [];
  for (const c of report.candidates) {
    const n = perDoc.get(c.src) || 0;
    if (selected.length < budget && n < perDocCap) { selected.push(c); perDoc.set(c.src, n + 1); }
    else spilled.push(c);
  }
  report.selected = selected;
  report.overLimit = spilled;
  report.stats.kept = report.selected.length;
  return report;
}

export function commit({ db, items, now = new Date().toISOString() }) {
  const out = { inserted: 0, existed: 0, ids: [] };
  const sel = db.prepare('SELECT id FROM deep_item WHERE conv_id=? AND seq_from=0 AND seq_to=0 AND text=?');
  const ins = db.prepare(`INSERT INTO deep_item (id, kind, text, at, conv_id, seq_from, seq_to, src, origin, durability, branch_id, updated_at)
    VALUES (?,?,?,?,?,0,0,?,?,?,?,?)`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      if (sel.get(it.convId, it.text)) { out.existed++; continue; }
      const id = 'di:' + randomUUID();
      // 硬度按**每条自己**的过时风险落(2026-10-15 加):不再一律 long。
      const dur = DEEP_DURABILITIES.includes(String(it.durability || '')) ? String(it.durability) : DEFAULT_DURABILITY;
      ins.run(id, it.kind, it.text, now, it.convId, 'import', ORIGIN, dur, '', now);
      out.inserted++; out.ids.push(id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return out;
}

// ───────────────────────────── CLI ─────────────────────────────
const isMain = process.argv[1] && /deep-import-docs\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const root = argOf('--root', process.cwd());
  const dbPath = argOf('--db', DEFAULT_DB);
  const commitMode = process.argv.includes('--commit');
  const asJson = process.argv.includes('--json');
  const reviewMode = process.argv.includes('--review');
  const outPath = argOf('--out', '');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 30000');
  const rep = collect({ root, db });
  console.log('=== C 档文档灌入(第一趟)· ' + (commitMode ? '**COMMIT**' : 'dry-run(不写库)') + ' ===');
  console.log('库:', dbPath);
  console.log('扫过的文档(' + rep.scanned.length + '):');
  for (const s of rep.scanned) console.log('  ·', s);
  console.log('表行总数:', rep.stats.rows, '| 过闸候选:', rep.stats.kept + rep.overLimit.length, '| 拒:', rep.stats.rejected, '| 已存在(去重):', rep.stats.dup, '| 待判(纪律类):', rep.stats.pending);
  console.log('第一趟拟落 ' + rep.selected.length + ' 条(上限 ' + FIRST_PASS_LIMIT + '),其余 ' + rep.overLimit.length + ' 条留第二趟');
  console.log('本趟预算:上限 ' + FIRST_PASS_LIMIT + ' − 本 origin 已落 ' + rep.stats.alreadyImported + ' = ' + rep.stats.budget + ' 条');
  console.log('出处核不过:', (rep.pendingProv || []).length, '| 含当场读数:', (rep.readings || []).length,
    '| 灰区被并:', rep.stats.suspiciousMerged || 0, '| 非结论表被拒:', rep.rejected.filter((r) => /不是结论表/.test(r.why)).length);
  if (rep.pendingDiscipline.length) {
    console.log('--- 待判:纪律类(缺①③,永不自动落库) ---');
    for (const p of rep.pendingDiscipline.slice(0, 20)) console.log('  · [' + p.src + '] ' + p.text + '\n      为什么待判:' + p.why);
  }
  console.log('--- 清单(dry:以下就是要落的,逐条过目) ---');
  for (const c of rep.selected) console.log('  [' + c.kind + '·状态分' + c.hardness + '] ' + c.text + '\n      ' + c.src + ':' + c.line + ' · 状态=' + c.status + ' · ' + c.why);
  if (outPath) {
    const md = [];
    md.push('# 深层库 · 结论层 第一趟灌入清单(C 档 · ' + (commitMode ? '**已落库**' : 'dry-run 产物') + ')');
    md.push('');
    md.push('> 生成:' + new Date().toISOString() + ' · 工具 [`dsh-ling/tools/deep-import-docs.mjs`](<../dsh-ling/tools/deep-import-docs.mjs>)(进包、可复跑)');
    md.push('> 限量:' + FIRST_PASS_LIMIT + ' 条 · **硬度按每条自己的过时风险分档**(`ephemeral` 不进开场 / `long` / `durable`) · `origin=`' + '`' + ORIGIN + '` · 幂等键 =(文档, 0, 0, 文本)');
    md.push(commitMode
      ? ('> ✅ **这份清单已落库**(`--commit`,幂等键 =(文档, 0, 0, 文本) ⇒ 重复跑不会重复落)。')
      : '> ⚠️ **这是一份 dry-run 产物:一个字节都没写库。** 主人过目后我再跑 `--commit`。');
    md.push('');
    md.push('## 统计');
    md.push('');
    md.push('| 项 | 数 |');
    md.push('|---|---|');
    md.push('| 扫过的文档 | ' + rep.scanned.length + ' |');
    md.push('| 表行总数 | ' + rep.stats.rows + ' |');
    md.push('| 过闸候选 | ' + (rep.selected.length + rep.overLimit.length) + ' |');
    md.push('| 未过闸(状态否决/超长/指代/小节作废) | ' + rep.stats.rejected + ' |');
    md.push('| 与库内或彼此重复 | ' + rep.stats.dup + '(其中近似重复 ' + (rep.stats.dupNear || 0) + ') |');
    md.push('| 待判(纪律类/理念 ⇒ 缺①③,永不自动落库) | ' + rep.pendingDiscipline.length + ' |');
    if ((rep.pendingMerged || []).length) md.push('| 待判里被判为重复而并掉的 | ' + rep.pendingMerged.length + ' |');
    if (rep.stats.suspicious) md.push('| 疑重复灰区(重叠 0.6~0.85,**已按留更全的一条合并**) | ' + rep.stats.suspicious + ' |');
    if (rep.stats.suspiciousMerged) md.push('| ↳ 其中本趟真被并掉的 | ' + rep.stats.suspiciousMerged + ' |');
    md.push('| **出处核不过**(真源里没有这句/锚到结构行/只在待办区) | ' + (rep.pendingProv || []).length + ' |');
    md.push('| **含当场读数**(半年后可能误导,交主人裁) | ' + (rep.readings || []).length + ' |');
    md.push('| 本趟预算(总限量 − 本 origin 已落) | ' + FIRST_PASS_LIMIT + ' − ' + rep.stats.alreadyImported + ' = **' + rep.stats.budget + '** |');
    md.push('| **本趟拟落** | ' + rep.selected.length + ' |');
    md.push('| 余下(第二趟) | ' + rep.overLimit.length + ' |');
    md.push('');
    md.push('## 本趟拟落的 ' + rep.selected.length + ' 条');
    md.push('');
    md.push('> **「硬度」这一列才是 `durability`** —— 它判的是这条结论**能活多久**,不是它多重要:');
    md.push('> `ephemeral` = 文本里有读数/版本号/时点状态 ⇒ **不进开场**(照旧存在库里、`recall` 搜得到);');
    md.push('> `long` = 默认(稳定结论);`durable` = 原则性表述 + 价值类(会吃排序加权,故只认文本自带的原则词)。');
    md.push('> **「状态分」是另一回事** —— 它是来源状态列的可信度分(主人拍板 3 / 已决 2…),只用于排序,与寿命无关。');
    md.push('> **「出处」栏印的是真源行号**;二手件(spec-extract)的行号只在后面括注 —— 审计实测二手件的指针有系统性偏移(+5/+6)。');
    md.push('>');
    md.push('> ⚠️ 这一段注**必须写在表头之前**:写进表头与首行之间会把 Markdown 表格截断(第一趟清单真犯过)。');
    md.push('');
    md.push('| # | kind | 硬度 | 过时风险 | 状态分 | 文本 | 出处(真源) | 真源原文(逐字,截 90 字) |');
    md.push('|---|---|---|---|---|---|---|---|');
    // 出处栏印**真源**行号(2026-10-15 审计之后改):二手件的行号只括注在后面。
    const provCell = (c) => {
      const srcTag = c.provFile ? ('`' + c.provFile + (c.provLine ? ':' + c.provLine : '') + '`') : '(未核出)';
      const idxTag = c.provStatus === 'self' ? '本源' : ('二手件 `' + c.src + ':' + c.line + '`');
      const d = c.provDelta ? (' · 指针漂移 ' + (c.provDelta > 0 ? '+' : '') + c.provDelta) : '';
      const fl = c.provFlag ? (' · ' + c.provFlag) : '';
      return srcTag + ' · ' + idxTag + d + fl + ' · 状态=' + c.status;
    };
    rep.selected.forEach((c, i) => md.push('| ' + (i + 1) + ' | ' + c.kind + ' | `' + (c.durability || DEFAULT_DURABILITY) + '` | '
      + String(c.durWhy || '').replace(/\|/g, '\\|') + ' | ' + c.hardness + ' | '
      + String(c.text).replace(/\|/g, '\\|') + ' | ' + provCell(c) + ' | '
      + String(c.provRaw || '').replace(/\|/g, '\\|') + ' |'));
    md.push('');
    md.push('## 出处核不过的(真源里没有这句/锚到结构行/只在待办区)—— 一律不落库');
    md.push('');
    md.push('这一节是 2026-10-15 对抗审计之后新加的闸。判据不在「二手件抄得准不准」,而在「真源到底认不认」:');
    md.push('审计实测二手件的 `源文件:N` 有系统性偏移(`DESIGN.md:14/15/16/17` 实为 `:19/20/21/22`),');
    md.push('而清单「抄得准」(二手件标哪行就是哪行)⇒ **逐字比对永远查不出这一类**。');
    md.push('');
    (rep.pendingProv || []).forEach((p, i) => md.push((i + 1) + '. ' + p.text + '  \n   `' + p.src + '` · ' + p.why
      + (p.prov ? ('  \n   核验:' + p.prov) : '')
      + (p.raw ? ('  \n   真源最像的一行:' + p.raw) : '')));
    md.push('');
    md.push('## 含当场读数的(不硬丢:机器分不清「720 预算」与「116 个会话」,交人裁)');
    md.push('');
    (rep.readings || []).forEach((p, i) => md.push((i + 1) + '. ' + p.text + '  \n   `' + p.src + '`'));
    md.push('');
    md.push('## 待判:纪律类(缺 DDL 三判据的 ①③,永不自动落库)');
    md.push('');
    md.push('判据原文在 [`memory.js`](<../dsh-ling/lib/host/memory.js#L314-L317>) 的 DDL 注释里:');
    md.push('① 来源是**主人授权的一句指令**;② 作用对象是**行为**;③ **违反时能被判据红出来**。');
    md.push('本工具只能看②的形态 —— ①③要人补 ⇒ 这些一律留在这里,等主人逐条点头(或否掉)。');
    md.push('');
    rep.pendingDiscipline.forEach((p, i) => md.push((i + 1) + '. ' + p.text + '  \n   `' + p.src + '`'
      + ((p.alsoAt && p.alsoAt.length) ? (' · 同条还出现在:`' + p.alsoAt.join('` · `') + '`') : '') + ' · ' + p.why));
    md.push('');
    md.push('## 未过闸的理由分类(不逐条列,按理由归堆 —— 理由本身要能自查)');
    md.push('');
    {
      const byWhy = new Map();
      for (const r of rep.rejected) {
        const key = String(r.why).replace(/\(.*$/, '');
        byWhy.set(key, (byWhy.get(key) || 0) + 1);
      }
      md.push('| 理由 | 条数 |');
      md.push('|---|---|');
      for (const [k2, n2] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) md.push('| ' + k2 + ' | ' + n2 + ' |');
    }
    md.push('');
    if ((rep.suspicious || []).length) {
      md.push('## 疑重复(重叠 0.6~0.85):**没有自动丢**,列出来由人裁');
      md.push('');
      md.push('阈值之上的已按『留更全的一条』合并;这一段灰区不自动判 —— 并错=少一条真结论且看不出来,');
      md.push('漏两条的代价只是清单里多两行(扫一眼就看得出来)。');
      md.push('');
      for (const s2 of rep.suspicious) {
        md.push('- 重叠 ' + s2.overlap + ': **' + s2.a + '…**');
        md.push('  vs **' + s2.b + '…**');
        md.push('  `' + s2.aSrc + '` ↔ `' + s2.bSrc + '`');
      }
      md.push('');
    }
    if ((rep.pendingMerged || []).length) {
      md.push('## 待判清单里被判为重复而并掉的(不静默)');
      md.push('');
      for (const m2 of rep.pendingMerged) md.push('- ' + m2.text + '  \n  留:`' + m2.keptAt + '` · 并掉:`' + m2.alsoAt + '`');
      md.push('');
    }
    md.push('## 判为近似重复而合并掉的(不静默,逐条可查)');
    md.push('');
    rep.duplicates.filter((d) => d.near).forEach((d) => md.push('- 重叠 ' + Number(d.overlap).toFixed(3)
      + (d.replacedBy ? (' · **换成了更全的一条**:' + d.replacedBy) : '') + '  \n  ' + d.text + '  \n  `' + d.src + '`'));
    md.push('');
    md.push('## 扫过的文档');
    md.push('');
    for (const s of rep.scanned) md.push('- `' + s + '`');
    md.push('');
    writeFileSync(outPath, md.join('\n'), 'utf8');
    console.log('清单已写入:', outPath);
  }
  if (asJson) console.log(JSON.stringify(rep, null, 1));
  if (rep.duplicates.some((d) => d.near)) {
    console.log('--- 判为**近似重复**而合并掉的(' + rep.duplicates.filter((d) => d.near).length + ' 条,全部印出来,不静默) ---');
    for (const d of rep.duplicates.filter((x) => x.near).slice(0, 15)) {
      console.log('  · 重叠=' + Number(d.overlap).toFixed(3) + '  ' + d.text + '   [' + d.src + ']');
    }
  }
  if (commitMode && (rep.stats.budget ?? rep.selected.length) <= 0) {
    console.log('⛔ 本趟预算已用完(origin=' + ORIGIN + ' 已落 ' + rep.stats.alreadyImported + ' 条 ≥ 限量 ' + FIRST_PASS_LIMIT + ')⇒ **拒绝再落**。');
    console.log('   不许静默超限量 —— 2026-10-15 实测踩过:连跑两遍 --commit 落成 80 条,而清单上只写着 40。');
    console.log('   要落第二趟请显式换 origin 或抬限量(那是"第二趟"的决定,不是重跑的副作用)。');
  } else if (commitMode) {
    const r = commit({ db, items: rep.selected });
    console.log('=== 落库结果 ===');
    console.log('新写入:', r.inserted, '| 幂等命中:', r.existed);
  } else {
    console.log('=== 没有写库(先 dry 后 commit;过目后加 --commit) ===');
  }
  // ── 复查清单(③):机器挑信号,人裁 ────────────────────────────────────────────────
  //  WHY 不做成"自动作废":作废虽可撤,但"这条还有没有用"是语义判断 ⇒ 机器只报它**看得见**的信号。
  if (reviewMode) {
    const rv = reviewPlan(db);
    const d2 = rv.byDurability;
    console.log('=== 结论层复查清单(在役 ' + rv.total + ' 条 · ephemeral ' + (d2.ephemeral || 0)
      + ' / long ' + (d2.long || 0) + ' / durable ' + (d2.durable || 0) + ') ===');
    console.log('① 含时间锚却当着长期条(会进开场,过时了没人提醒):', rv.counts.staleRisk);
    console.log('② 「当次」档够老(≥' + EPHEMERAL_TTL_DAYS + ' 天,候选作废):', rv.counts.expired);
    console.log('③ 从没被加固过 + 够老(≥' + NEVER_USED_DAYS + ' 天,怀疑白占位置):', rv.counts.neverUsed);
    for (const it of rv.staleRisk.slice(0, 12)) {
      console.log('  · [' + it.kind + '·' + it.durability + '·' + (it.age === null ? '?' : it.age) + '天·加固' + it.hit + '] ' + it.text);
    }
    const rvPath = argOf('--out-review', '');
    if (rvPath) {
      const m2 = [];
      m2.push('# 结论层 · 复查清单(机器挑信号,人裁)');
      m2.push('');
      m2.push('> 生成:' + new Date().toISOString() + ' · 工具 `dsh-ling/tools/deep-import-docs.mjs --review`');
      m2.push('> **这一面只列信号,不作废任何东西** —— 作废要人点头(`deep_item --action retract`,只标记不删、写留痕、可撤)。');
      m2.push('> 为什么要它:结论层条目**直接影响开场**(`ephemeral` 除外),过时的条不当场清理,');
      m2.push('> 它会一直以"看起来相关"的方式混进开场白 —— 那比不注入更坏。');
      m2.push('');
      m2.push('## 总账');
      m2.push('');
      m2.push('| 项 | 数 |');
      m2.push('|---|---|');
      m2.push('| 在役 | ' + rv.total + ' |');
      m2.push('| 硬度 `ephemeral`(不进开场) | ' + (d2.ephemeral || 0) + ' |');
      m2.push('| 硬度 `long` | ' + (d2.long || 0) + ' |');
      m2.push('| 硬度 `durable`(吃排序加权) | ' + (d2.durable || 0) + ' |');
      m2.push('| ① 含时间锚却当着长期条 | ' + rv.counts.staleRisk + ' |');
      m2.push('| ② 当次档够老(≥' + EPHEMERAL_TTL_DAYS + ' 天) | ' + rv.counts.expired + ' |');
      m2.push('| ③ 从没被加固过 + 够老(≥' + NEVER_USED_DAYS + ' 天) | ' + rv.counts.neverUsed + ' |');
      m2.push('');
      const sec = (title, note, arr) => {
        m2.push('## ' + title);
        m2.push('');
        m2.push(note);
        m2.push('');
        if (!arr.length) { m2.push('(空)'); m2.push(''); return; }
        m2.push('| # | kind | 硬度 | 加固 | 条龄(天) | 文本 | 来源 |');
        m2.push('|---|---|---|---|---|---|---|');
        arr.slice(0, 60).forEach((it, i) => m2.push('| ' + (i + 1) + ' | ' + it.kind + ' | ' + it.durability + ' | '
          + it.hit + ' | ' + (it.age === null ? '?' : it.age) + ' | ' + String(it.text).replace(/\|/g, '\\|')
          + ' | `' + String(it.src || '') + '` |'));
        m2.push('');
      };
      sec('① 含时间锚却当着长期条', '这些条文本里写着读数/时点状态,却按 `long`/`durable` 存 ⇒ 它们**会进开场**。'
        + '处置:改成 `ephemeral`(写作 `deep_item add` 时给 `durability`),或过时那天 `retract`。', rv.staleRisk);
      sec('② 「当次」档够老(≥' + EPHEMERAL_TTL_DAYS + ' 天)', '这些条已是 `ephemeral`:**不进开场**,所以不急;'
        + '但它们可能早已无用,清理能让 `recall` 少些噪声。', rv.expired);
      sec('③ 从没被加固过 + 够老(≥' + NEVER_USED_DAYS + ' 天)', '`hit_count=0` 意味着**从没在真实使用里被采用过**'
        + '(加固只在真被采用时 +1,被注入不算)⇒ 它们要么一直没被选中,要么被选中了但没用上。'
        + '⚠️ **这是最弱的一个信号**(2026-10-15 实测):生平类事实(「主人做过高温高熵合金方向」)天然就是 0 加固,'
        + '所以这一节当"扫一遍"用,**不要当删除清单**。真正该动的依据是①和②。', rv.neverUsed);
      writeFileSync(rvPath, m2.join('\n'), 'utf8');
      console.log('复查清单已写入:', rvPath);
    }
  }
  db.close();
}
