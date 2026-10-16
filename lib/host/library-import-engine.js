// dsh-ling host — 1.7 图书馆 · 导入通道的**模型段接线**(契约 §11.1「模型段怎么接 = 已定」)。
//
// 契约原文(逐字):「**直接用「导入栏」的模型选择器同款** —— 不另配一套模型来源。」
// 所以这里**只做两件事**:把两档引擎(既有 UI 里那个 `makeSel` 的两项)接到两个**已经存在**的调用路径上,
// 再把模型回复解析成候选数组。**不新建模型来源、不新建档位体系、不碰 prompt 之外的设置**。
//
//   引擎 `assistant` = 本机小助手(零成本)—— 走 `settings.assistant` 的 Ollama 端点(`summarizeLocal`);
//   引擎 `global`    = 当前全局大模型(会花额度)—— 走 `ctx.llm.stream`,**跟随用户当前选择**(`llmOnce`)。
//
// 三条硬口径(与契约 §3/§8 对齐):
//   ① 送模型的条数上限 = `importModelMaxItems`(默认 60);超出的行**只走规则段**,并在回执里说明
//      (**由 `analyzeImport` 记账**,这里不许自己截断——那样回执就说不出"被截了");
//   ② 回执必须带**如实的引擎/模型名**(`label`):契约 §3 明写"不许把两次结果不一样藏起来";
//   ③ 模型跑不成(端点不可达 / 回的不是 JSON / 空回复)⇒ **抛** —— 由 `analyzeImport` 归成
//      `model_failed` 并如实回 `ok:false`。**绝不退回"只用规则段 + ok:true"**:那等于把"模型没跑成"
//      藏进一个成功的回执里(那正是 §9.1 要拦的)。
//   ③【2026-10-14 更正 —— D11 已放行,下面 14-16 行那句原口径已变,留痕不删】
//      模型跑不成(端点不可达 / 回的不是 JSON / 空回复 / 某批被截断)⇒ **本层不再抛**:
//      记下失败与批号,由 `analyzeImport` 回成**显式标注的降级回执**
//      (`ok:true` + `stats.model_used:false` + `stats.model_error`,规则段候选照常给)。
//      为什么要改:原口径"抛 ⇒ 整发 ok:false"的代价是**一颗螺丝松了整台机器不转** ——
//      模型段一炸,连规则段本来已经读好的候选都一起丢(真机 20/40/60 行必炸时就是这个体验)。
//      **放行不等于可以藏**:降级必须显式标注,且回执里不许出现任何声称模型成功的字段
//      (`model_used:false`、`model:null`)——这条由 §9.1 的测试钉死。
import { resolveAssistant, summarizeLocal } from './dsweb-summary.js';
import { llmOnce, resolveLlmTarget } from './deepsummary.js';

/** 两档引擎名(与 UI 的 `makeSel([{v:'assistant'},{v:'global'}])` 逐字一致)。 */
export const IMPORT_ENGINES = ['assistant', 'global'];
/** 模型段回复是**结构化 JSON**(不是一句摘要)⇒ 预算给足;512 那档留给摘要。 */
export const IMPORT_MODEL_MAX_TOKENS = 2048;
/** 60 行 × 解析 + JSON 输出,本机小助手实测量级是十几秒;给到 2 分钟,超时如实报错。 */
export const IMPORT_MODEL_TIMEOUT_MS = 120000;
/** 单行原文送模型的截断(源文本另有限额:`importTextMaxBytes` 管的是整份)。 */
export const IMPORT_MODEL_ROW_CHARS = 600;
/**
 * 一批送几行(**2026-10-13 定,原因是真机实测**)。这个数不是随手取的:
 * 回复预算 `IMPORT_MODEL_MAX_TOKENS` = 2048,而提示词要求**每条候选逐字附 `evidence`**
 * (实测一条约 140 token)⇒ 十几条就把预算吃满、JSON 被截断 ⇒ `parseImportCandidates` 报
 * "没回 JSON 数组" ⇒ **整发 analyze 503**(连规则段候选一起丢)。
 * 真机读数:2 / 5 / 10 行过(5 行 3.2 s、10 行 5.1 s),**20 / 40 / 60 行必炸**。
 * 分批之后,2048 的预算按**批**给;总行数上限仍归 `importModelMaxItems`(默认 60)管。
 */
export const IMPORT_MODEL_BATCH_ROWS = 10;

/** 把待送行按批切开(空数组 ⇒ 空批表:一次都不调模型)。 */
export function chunkRows(rows, size = IMPORT_MODEL_BATCH_ROWS) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, Number(size) || IMPORT_MODEL_BATCH_ROWS);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 分批跑同一档引擎,各批候选**按批序拼起来**。
 *
 * 任一批抛错 ⇒ **整段抛**(由 `analyzeImport` 归成 `model_failed`):半份候选冒充"模型跑完了"
 * 比整段失败更坏 —— 用户会以为剩下的行"模型看过了、没东西可提"。(要不要改成"降级但仍然交规则段候选"
 * 是另一个决定,见交接单 D11,未决前不动。)
 * 批数写回 `mc.model_stats`,由 `analyzeImport` 照实报进回执 —— 否则"20 行是分两批跑的"这件事
 * 在回执里看不见,下一次再出这种配平问题还是查不出。
 */
// 【2026-10-14 更正,D11 已决】上面那段 doc 里"任一批抛错 ⇒ 整段抛"**已作废**(留痕不删):
// 任一批炸了**不抛** —— 成功的批保留、失败写回 `mc.model_stats`,由 `analyzeImport` 据此回
// **显式标注的降级回执**。原口径把"半份候选"看得比"整段失败"更坏;放行后的判据是
// "**只要标注得出来就不算藏**"。
async function runImportBatches(mc, call) {
  const chunks = chunkRows(mc && mc.rows);
  if (!chunks.length) return [];
  const out = [];
  let ok = 0;
  let failed = null;
  for (let i = 0; i < chunks.length; i++) {
    const ctx = { ...mc, rows: chunks[i], batch: { index: i + 1, total: chunks.length } };
    try {
      out.push(...(await call(ctx)));
      ok += 1;
    } catch (e) {
      // 任一批炸了:不抛、也不再往后跑(端点死了还硬跑剩下的批,是拿几倍超时换一份一样失败的账)。
      // 已经跑成功的批**保留** —— 丢掉等于白烧额度,而"模型对那几行白看了"与"没看"是两件事。
      failed = { index: i + 1, message: String((e && e.message) || e) };
      break;
    }
  }
  if (mc && typeof mc === 'object') {
    mc.model_stats = {
      batches: chunks.length,
      batch_rows: IMPORT_MODEL_BATCH_ROWS,
      ok,
      ...(failed ? { failed: [failed], error: `第 ${failed.index} / ${chunks.length} 批没跑成:${failed.message}` } : {}),
    };
  }
  return out;
}

/**
 * 模型段的系统提示词。**四件事必须写死在提示里**,因为它们对应四道会机械回查的闸:
 *   · `locator` 照抄 ⇒ 第 1 道闸(定位回查)比对得起来;
 *   · `evidence` 是原文逐字片段 ⇒ 第 1 道闸机械回查(`locator_verified`);
 *   · 枚举字段只能是既有取值 ⇒ 第 2 道闸(字段/枚举);
 *   · "拿不准留空、不许编" ⇒ §9.6 那条"模型幻觉被拦"的**正面要求**(拦得住 ≠ 可以不要求)。
 */
export const IMPORT_MODEL_SYS = [
  '你在把一份资料整理成"图书馆条目"。只输出**一个 JSON 数组**:不要解释、不要 Markdown 围栏、不要注释。',
  '',
  '数组里每个元素是一条条目,字段如下:',
  '- locator:字符串。**逐字照抄**我给你的定位;不许自己编,也不许改格式。',
  '- title:短标题(不超过 40 字)。',
  '- body:这条的正文。可以整理措辞,但**不许增加原文里没有的信息**。',
  '- category:"standard-value" | "boundary" | "project-spec" | "external-api" 之一。',
  '- source_kind:"standard" | "official-doc" | "manual" | "our-code" | "web" 之一。',
  '- as_of:日期 YYYY-MM-DD(我给了就用我给的)。',
  '- evidence:**必须是该 locator 原文里逐字出现的一段**。这一条会被机械回查 —— 对不上,整条会被拦下。',
  '',
  '硬规矩:',
  '- 只处理我列出的内容行:不许新增、不许漏、不许把两行并成一条;',
  '- 我列出的行**不是资料正文**时(表头、空行、页眉页脚、分隔线),**不要**为它产生元素;',
  '- 拿不准的字段留空字符串,不要猜;',
  '- 不许编造标准号、条款号、数值、日期。',
].join('\n');

/** 把 `analyzeImport` 交来的行拼成用户消息。行格式固定为 `locator=<定位> | <原文>`。 */
export function buildImportPrompt(ctx = {}) {
  const rows = Array.isArray(ctx.rows) ? ctx.rows : [];
  const out = [];
  out.push(`源名:${String(ctx.name ?? '')}(类型 ${String(ctx.kind ?? '')})`);
  out.push(`今天:${String(ctx.today ?? '')}`);
  out.push('');
  out.push(`以下是待整理的内容行(共 ${rows.length} 行;每行格式 \`locator=<定位> | <原文>\`):`);
  // 分批时必须说清"这只是其中一批",否则模型会把"行不全"理解成"该补全"——
  // 而系统提示里那条"不许漏"是给**单批内**的行的(两句话必须同时成立才不打架)。
  if (ctx.batch && Number(ctx.batch.total) > 1) {
    out.push(`注意:这一份是第 ${ctx.batch.index} / ${ctx.batch.total} 批,只列出这一批的行。`);
    out.push('不在本批里的行由别处处理:你不用补、也不要提。');
  }
  for (const r of rows) {
    const text = String(r && r.text !== undefined && r.text !== null ? r.text : '').replace(/\s+/g, ' ').trim();
    out.push(`locator=${String(r && r.locator !== undefined && r.locator !== null ? r.locator : '')} | ${text.slice(0, IMPORT_MODEL_ROW_CHARS)}`);
  }
  return out.join('\n');
}

/**
 * 模型回复 → 候选数组。**解析不了就抛**(不返回空数组)。
 *
 * 为什么空数组是错的:回 `[]` 会让回执写成"模型跑了、没产出任何条目",而真相是"模型回了一坨没法用的东西"——
 * 两者对用户是**完全不同**的两件事(前者可以说"这段文本本来就没有条目",后者要人去看模型怎么了)。
 */
export function parseImportCandidates(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') throw new Error('模型回了空文本');
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim(); // 兜底:思考块(两条引擎都不该有)
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();   // 兜底:Markdown 围栏
  const i = s.indexOf('[');
  const j = s.lastIndexOf(']');
  if (i < 0 || j <= i) throw new Error(`模型没回 JSON 数组(片段:${s.slice(0, 120)})`);
  let arr = null;
  try {
    arr = JSON.parse(s.slice(i, j + 1));
  } catch (e) {
    throw new Error(`模型回的 JSON 解析不了(${e?.message ?? e};片段:${s.slice(i, i + 120)})`);
  }
  if (!Array.isArray(arr)) throw new Error('模型回的不是数组');
  // 非对象元素(字符串/数字/嵌套数组)skip 掉而不是让它变成一条"空条目"——analyzeImport 那边也 skip,
  // 这里先滤掉能少走一趟校验(两边都做不是冗余:这里是"形状",那边是"语义")。
  return arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
}

/**
 * 造模型段的 hook(交 `analyzeImport` 的 `opts.model`)。
 *
 * @param {{engine:string, ctx:object, settings:object}} args
 * @returns {{label:string, hook:Function}} `label` 进回执(如实写明是哪个模型跑的这一趟)
 */
export function makeImportModelHook({ engine, ctx, settings } = {}) {
  const eng = String(engine ?? '').trim();
  if (!IMPORT_ENGINES.includes(eng)) throw new Error(`未知引擎:${eng}`);

  if (eng === 'assistant') {
    const asst = resolveAssistant(settings);
    return {
      label: `assistant:${asst.model}`,
      hook: async (mc) => runImportBatches(mc, async (c) => {
        const r = await summarizeLocal(asst.baseUrl, asst.model, {
          system: IMPORT_MODEL_SYS,
          text: buildImportPrompt(c),
          maxTokens: IMPORT_MODEL_MAX_TOKENS,
          timeoutMs: IMPORT_MODEL_TIMEOUT_MS,
          clean: false, // 要结构化 JSON,不许被 cleanSummary 压成一行
        });
        if (!r.ok) throw new Error(`本机小助手没给出可用回复(${r.error ?? 'unknown'})`);
        return parseImportCandidates(r.summary);
      }),
    };
  }

  // global:跟随用户当前模型选择(读不到时 `resolveLlmTarget` 会用兜底值并标注 —— 如实写进 label)
  const target = resolveLlmTarget(ctx);
  return {
    label: `global:${target.provider}/${target.model}${target.followed ? '' : '(fallback:读不到当前选择)'}`,
    hook: async (mc) => runImportBatches(mc, async (c) => {
      const out = await llmOnce(ctx, {
        system: IMPORT_MODEL_SYS,
        text: buildImportPrompt(c),
        maxTokens: IMPORT_MODEL_MAX_TOKENS,
      });
      return parseImportCandidates(out?.text ?? '');
    }),
  };
}
