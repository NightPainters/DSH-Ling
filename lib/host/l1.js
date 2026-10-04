// dsh-ling host — L1 opener selection v0 (DESIGN §6.2).
// heat = α·recency + β·freq + γ·importance (exponential decay, half-life configurable);
// mode weights by category (knowledge/daily/feeling); optional keyword pre-match.
import { toEpochMs, isoDate } from './util.js';
import { userTitleForMode } from './persona.js'; // 1.6-B2:视角框的称呼跟随 userTitle(不硬编码)

const DAY_MS = 86_400_000;

export function decayWeight(daysSince, halfLifeDays) {
  if (halfLifeDays <= 0) return 0;
  return Math.pow(0.5, daysSince / halfLifeDays);
}

export function computeHeat(row, nowMs, cfg) {
  const c = cfg || {};
  const half = Number(c.halfLifeDays ?? 90);
  const t = toEpochMs(row.updated_at || row.started_at);
  // 解析不出来时按"刚更新"处理(不惩罚未知),但绝不再让坏串长期拿满分:
  // 只要能被 toEpochMs 认出(含 "1789006881011.0"),就照真实时间衰减。
  const days = t === null ? 0 : Math.max(0, (nowMs - t) / DAY_MS);
  const recency = decayWeight(days, half);
  const freq = Math.min(1, (Number(row.hit_count ?? 0) + Number(row.importance ?? 0)) / 20);
  const alpha = Number(c.heatAlpha ?? 0.5);
  const beta = Number(c.heatBeta ?? 0.3);
  const gamma = Number(c.heatGamma ?? 0.2);
  return alpha * recency + beta * freq + gamma * Math.min(1, Number(row.importance ?? 0));
}

const CATEGORY_DEFAULTS = { knowledge: 1, daily: 0.5, feeling: 0.3 };

/** 3-gram set of a token (CJK-agnostic). */
function grams3(s) {
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** 近似重复的判据(1.6,2026-10-04):3-gram **Jaccard** ≥ `DUP_JACCARD`。
 *
 *  为什么需要(真机实测):两条几乎同字的「器灵的记忆树工具(tree_read/branch_edit…)」——
 *  它们来自**不同会话**(幂等判据 `(conv_id,seq_from,seq_to,text)` 因此挡不住,同源限额也挡不住),
 *  却**同时占掉开场 8 个位置里的 2 个**。开场是全局最贵的面,一条重复就是实打实的一格浪费。
 *  与 `kwOverlap` 的 3-gram 思路同源(中文友好),但这里是**对称相似度**,不是"命中与否"。
 *  ⚠️ 这只是**选择侧**的守门;根源治理在提炼侧(跨会话归纳 / 同义合并),那一步还没做。 */
const DUP_JACCARD = 0.7;

function similarText(a, b) {
  const A = grams3(String(a || '').trim());
  const B = grams3(String(b || '').trim());
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= DUP_JACCARD;
}

/**
 * keyword overlap between query tokens and row keywords:
 * hit when a pair (1) contains the other (len>=2), or (2) shares a 3-gram —
 * robust to token-window offsets (query 4-grams vs stored 6-grams).
 */
function kwOverlap(queryKeywords, rowKeywords) {
  if (!queryKeywords || !queryKeywords.length || !rowKeywords || !rowKeywords.length) return 0;
  let hit = 0;
  for (const q of queryKeywords) {
    const qs = String(q).toLowerCase();
    if (qs.length < 2) continue;
    const qg = grams3(qs);
    for (const k of rowKeywords) {
      const ks = String(k).toLowerCase();
      if (ks.length < 2) continue;
      if (ks.includes(qs) || qs.includes(ks)) {
        hit += 1;
        break;
      }
      if (qg.size) {
        let shared = false;
        for (let i = 0; i + 3 <= ks.length; i++) {
          if (qg.has(ks.slice(i, i + 3))) {
            shared = true;
            break;
          }
        }
        if (shared) {
          hit += 1;
          break;
        }
      }
    }
  }
  return hit;
}

/** 1.6(2026-10-04)修:`kwOverlap` **不能**用在条目路上 —— 它有一条"共享 3-gram 也算命中"的回退
 *  (为"查询 4-gram vs 存储 6-gram 的**关键词表**"设计的),而条目路的右操作数是**条目正文**
 *  (全库均 52 字)。中文常用 3-gram 遍地都是 ⇒ 几乎任何查询都会命中 3 条以上 ⇒ 打满
 *  `KW_BONUS_CAP`(+1.8),把新近(最多 0.3)和 hit(尚为 0)全压死。
 *  实测病灶(用户 2026-10-04 开新会话看到):开场 8 条**全是同一次生图会话的条目** ——
 *  排序实际上等于"谁的字面碰巧撞上查询词"。
 *  长句只做**连续子串**匹配:那个词真出现在那句话里才算命中。 */
function kwHitInText(queryKeywords, text) {
  const t = String(text || '').toLowerCase();
  if (!t || !queryKeywords || !queryKeywords.length) return 0;
  let hit = 0;
  for (const q of queryKeywords) {
    const qs = String(q).toLowerCase();
    if (qs.length < 2) continue;
    if (t.includes(qs)) hit += 1;
  }
  return hit;
}

// ⚠️ 2026-10-04 夜改:`0.6 → 1.2`。实测发现**当轮相关打不过长期价值**:主人问「生图」时,
//   那条真正讲生图的条目只有 `决定/long`(长期分 ≈0.2),加上一次命中(0.6)仍只有 0.8,
//   而 `承诺/durable` 的条目躺着就是 1.0 ⇒ **开场里根本没有他在问的那件事**。
//   提到 1.2 后:命中一次 ≈1.4 ⇒ 能翻盘进前 8,但压不过"承诺+命中"的 2.2 ⇒ 不至于只剩撞词的。
const KW_BONUS_PER_HIT = 1.2;
const KW_BONUS_CAP = 1.8;
/** 「有信息量的摘要」加权(2026-09-16):只有标题的行(如全部 dsweb 行)不加分,
 *  真正带摘要的行加分 —— 用相对分差把"信息密度低"的行往后压,而不是硬过滤。
 *  判定:摘要去掉"标题前缀"与"— N 条消息"尾巴后仍 ≥ 20 字才算有信息量。 */
const SUMMARY_BONUS_DEFAULT = 0.25;

export function summaryWeight(row) {
  const s = String(row?.summary || '').trim();
  if (!s) return 0;
  const t = String(row?.title || '').trim();
  let body = s;
  if (t && body.startsWith(t)) body = body.slice(t.length).replace(/^[\s:：—\-]+/, '');
  body = body.replace(/\s*[—\-]\s*\d+\s*条消息\s*$/, '').trim();
  return body.length >= 20 ? 1 : 0;
}

/** 落选者留痕条数(1.6-A)。0 = 不留;上限 20 只是防呆 —— 它落在磁盘上,不进上下文。 */
const RUNNER_UPS_DEFAULT = 5;

// ── 1.6 步 5:L1 换料 —— 数据源从「会话概述」换成「深层库条目」(结论层) ──────────────
//   主人 2026-10-04 拍板:「反复加固 + 置顶」,**面向的对象不是浅层库原文,而是深层库条目**;
//   幅度「瘦身到现在的 60%」(经 l1BudgetTokens 1200 → 720 落地)。
//
//   为什么整条判据都要换掉:旧公式(`α·新近 + β·热度 + γ·重要性 + 关键词 + 摘要加成`)是为
//   **概述行**设计的 —— 概述是"一段话",要靠热度/摘要长度去猜哪段有价值;条目本身就是
//   **一句话结论**,它自带两个更强的信号:**被主人置顶**(主观)、**被反复采用**(客观)。
//
//   ⚠️ 一个尚未闭环的事实(2026-10-04):`hit_count` 目前**全库为 0** —— 因为它只该由
//   "真被采用"推进(列注释的语义位),而采用信号(recall 取过它指向的原文)还没接线。
//   在那之前,排序实际由 **置顶 + 关键词 + 新近** 三者承担,`hit` 项恒为 0(不是坏了)。
const DEEP_SCAN_MAX = 1000;   // 一次扫描的条目上限(条目继续增长后要换成真分页)
const HIT_BONUS = 1.0;        // 「被反复采用」的满分权重
const HIT_SATURATION = 5;     // 采用满 5 次即拿满分(与记忆行 freq 的 /20 不同:条目稀少,5 次已很硬)
// ⚠️ 2026-10-04 夜改:`0.3 → 0.1`。原因是主人实测抓到的真缺陷 —— **无关键词时分数几乎全平**:
//   条目多来自近日会话(衰减≈1)⇒ 每条都是 `0.3 × 1 ≈ 0.300`,前 10 名里 9 条同分 ⇒ 排序
//   **实际退化成"按会话时间"**,开场成了"最近几次会话的结论"而不是"最要紧的事"。
//   新近对**结论层**本就该是弱信号(结论的价值在长期),压到 0.1 后不再主导。
const RECENCY_W = 0.1;
const DEEP_HALF_LIFE = 365;   // 半衰期一年(旧的概述行是 90 天)
/** **硬度分**(1.6,2026-10-04 用户的判断:「能不能做成从根源上判断这些条目到底是临时的还是永久的,
 *  或者加"硬度"评分来衡量临时程度/永久程度」)。
 *  它**同时**用于两处:出局(见 `selectL1` 里 `ephemeral` 的 continue)与**排序**。
 *  只做前者是不够的 —— 上一版就只做了前者,于是"长期原则"和"阶段性结论"在排序里**同权**,
 *  区分度全靠新近(而那正是全平的来源)。`durable` 抬 0.6 之后,与 `long` 拉开约 7 倍。 */
const DURABILITY_BONUS = { durable: 0.6, long: 0, ephemeral: 0 };
/** **类别分**(1.6,2026-10-04 夜)。它解决的是"硬度分之后仍然全平"这一层 ——
 *  实测:`durable` 有 107 条而开场只有 8 个位置,同档内分数全同(极差 0.001)⇒ 排序仍旧退回
 *  按会话时间,于是"开发过程的决定/环境事实"照样能挤掉"关于人的承诺与关系"。
 *
 *  权重的依据是**主人 2026-10-04 夜的两条实测标注**:他标出「测评口径」(决定)与
 *  「某插件的档位细节」(偏好)两条"不该在这里" —— 它们都是**关于事**的;而器灵最该先看见的
 *  是**关于人**的(承诺/关系/偏好)。⇒ 用 `kind` 把这两类分开,不必新增字段。
 *  ⚠️ 这是本夜新加的判据(主人未逐字拍过)⇒ 值可调、可整体否掉;`hit`(+1.0)仍是最强信号。 */
const KIND_WEIGHT = { 承诺: 0.4, 关系: 0.3, 偏好: 0.2, 决定: 0.1, 事实: 0 };
/** **同源限额**:同一次会话最多进 N 条(置顶不受此限)。见 `selectL1` 里的同源循环。 */
const MAX_PER_CONV = 2;

/**
 * 一条条目的**可读理由**(1.6-A 硬约束③:每条进上下文的都要能报出理由)。
 * 词表跟着打分项走 —— 这里改了公式、那里必须同改,否则留痕会说谎(比不记更坏)。
 * @param {{row?:object, pinned?:boolean, hit?:number, kw?:number, recency?:number, lineage:number, conf?:number, score:number}} x
 */
export function explainScore(x) {
  const f = (n, d = 2) => Number(n).toFixed(d);
  // ⚠️ 词表**跟着数据源分路**,不能一套吃到底(1.6 步 5):
  //   双路并存期间,回落路径(概述)的打分项是「热度/摘要加成/重要性」,条目路径是「置顶/被采用/新近」——
  //   用一套词去描述另一条路的分数 = **留痕说谎**,而留痕是"每条进上下文的都要能报出理由"这条硬约束的落点。
  // 判路用**字段存在性**,不用 `useDeep` 标记:调用方可能是直接构造 `x` 的测试/诊断
  //   (它不会带 `useDeep`)—— 概述路的 `x` 必有 `heat`/`rich`,条目路的必有 `hit`。
  const legacy = x.useDeep === false || x.heat !== undefined || x.rich !== undefined;
  if (legacy) {
    const bits = [];
    if (x.heat !== undefined && x.heat !== null) {
      // ⚠️ 热度必须乘**类别权重**再报(蓝队 2026-10-04):真实分项是 `catW * heat`(见下面的打分),
      //   只报 `heat` 会让 daily 档虚高 0.252、feeling 档虚高 88%(0.750 vs 真实 0.399)——
      //   又一次"留痕与公式不符"。`catW` 由打分侧塞进 `x`;老调用方没塞时退回报纯 heat。
      const catW = x.catW === undefined || x.catW === null ? 1 : Number(x.catW);
      bits.push(`类别加权热度${f(Number(x.heat) * catW)}`);
    }
    if (Number(x.kw) > 0) {
      bits.push(`关键词命中${x.kw}条(+${f(Math.min(KW_BONUS_CAP, Number(x.kw) * KW_BONUS_PER_HIT))})`);
    }
    if (Number(x.rich) > 0) bits.push(`摘要加成+${f(x.rich)}`);
    if (Number(x.row?.importance ?? 0) >= 1) bits.push('重要性+0.8');
    // ⚠️ 同一口径修正(红队 2026-10-04,与条目路**必须同时改** —— 只改一边会让另一条路继续说谎):
    //   分项之间是加法,`血缘`/`矛盾` 是**乘数**,不能混进加法列表。
    const mult = [`× 血缘${f(x.lineage)}`];
    if (Number(x.conf ?? 1) < 1) mult.push(`× 矛盾${f(x.conf)}`);
    return `(${bits.join(' + ')}) ${mult.join(' ')} ⇒ ${f(x.score, 3)}`;
  }
  const bits = [];
  if (x.pinned) bits.push('置顶(必进)');
  if (Number(x.durBonus) > 0) bits.push(`硬度${x.dur}(+${f(x.durBonus)})`);
  if (Number(x.kindW) > 0) bits.push(`类别${x.row?.kind || ''}(+${f(x.kindW)})`);
  if (Number(x.hit) > 0) bits.push(`被采用${x.hit}次(+${f(Math.min(1, Number(x.hit) / HIT_SATURATION))})`);
  if (Number(x.kw) > 0) {
    bits.push(`关键词命中${x.kw}条(+${f(Math.min(KW_BONUS_CAP, Number(x.kw) * KW_BONUS_PER_HIT))})`);
  }
  if (x.recency !== undefined && x.recency !== null) bits.push(`新近${f(x.recency)}(${f(RECENCY_W)}×)`);
  // ⚠️ 口径(红队 2026-10-04 抓到"留痕说谎"):分项之间是**加法**,而总分是 `分项和 × 血缘 × 矛盾`。
  //   把两个乘数混进加法列表里报,`lineage=0.4` 时会报出分项和 1.10 而实际分 0.440(差 2.5 倍)⇒
  //   现在显式写成 `(分项和) × 血缘 × 矛盾 ⇒ 总分`,让留痕与公式一一对得上。
  const mult = [`× 血缘${f(x.lineage)}`];
  if (Number(x.conf ?? 1) < 1) mult.push(`× 矛盾${f(x.conf)}`);
  return `(${bits.join(' + ')}) ${mult.join(' ')} ⇒ ${f(x.score, 3)}`;
}

/** 主干枝 id(与 `memory.js` 的 `TRUNK_ID` 一致;算法模块不耦合存储层,故此处独立定义)。 */
const TRUNK_BRANCH = 'trunk';
/** 血缘档位兜底:未知枝按"旁系"算(与 memory.js 的 `LINEAGE_SIDE` 一致)。 */
const LINEAGE_SIDE_FALLBACK = 0.4;

/** D9-a:取当前会话的血缘上下文(所属枝 + 枝权重表 + 会话→枝 表)。
 *  任一步不可用则返回 null —— 此时不加权(等价于旧行为),保证向后兼容。 */
/** D9-a/D9-b:取当前会话的血缘上下文(所属枝 + 枝权重表 + 会话→枝 表 + 矛盾降权表)。
 *  **矛盾降权与血缘正交** —— 即使不传 sessionId(不加血缘权重),矛盾降权也必须生效;
 *  两者都拿不到时才返回 null(等价于旧行为),保证向后兼容。 */
function lineageContext(store, sessionId) {
  try {
    if (!store) return null;
    const sid = String(sessionId || '');
    const conflicts = typeof store.conflictDowngradeMap === 'function' ? store.conflictDowngradeMap() : null;
    const noLineage = !sid || typeof store.branchOfSession !== 'function';
    const branch = noLineage ? TRUNK_BRANCH : store.branchOfSession(sid);
    const weights = noLineage
      ? null
      : (typeof store.lineageWeightMap === 'function' ? store.lineageWeightMap(branch) : null);
    const sessionBranch = noLineage
      ? null
      : (typeof store.sessionBranchMap === 'function' ? store.sessionBranchMap() : null);
    // 方案 A(2026-09-21):非会话源的**显式**归属覆盖层 —— dsweb/import 的历史条目没有会话身份,
    //   靠 session_meta 推不出枝。与血缘正交(枝归属不依赖"当前会话"),故独立于 noLineage 取值。
    const convBranch = typeof store.convBranchMap === 'function' ? store.convBranchMap() : null;
    if (!weights && !conflicts) return null;
    return { branch, weights, sessionBranch, convBranch, conflicts };
  } catch {
    return null;
  }
}

/** D9-a:一条记忆行所属枝的血缘档位。
 *  方案 A(2026-09-21):`conv_branch` 显式覆盖**优先** —— dsweb/import 的历史条目靠它挂枝;
 *  未覆盖时,dsh 源走会话推导,其余归主干。 */
function lineageOf(ctx, row) {
  if (!ctx || !ctx.weights) return 1;
  const src = String(row?.source || '');
  const cid = String(row?.conv_id || '');
  const ov = ctx.convBranch && ctx.convBranch.size ? ctx.convBranch.get(src + '\u0000' + cid) : undefined;
  if (ov) return ctx.weights.get(ov) ?? LINEAGE_SIDE_FALLBACK;
  let bid = TRUNK_BRANCH;
  if (src === 'dsh' && ctx.sessionBranch) {
    bid = ctx.sessionBranch.get(cid) || TRUNK_BRANCH;
  }
  return ctx.weights.get(bid) ?? LINEAGE_SIDE_FALLBACK;
}

/** D9-b:矛盾降权因子。命中 `"source\u0000convId"` 即乘系数(默认 0.3)。
 *  规则见 `memory.js` 的 `conflictDowngradeMap()`:复盘裁定的按裁定,**未复盘的以最新为准**;
 *  只降权,不删除、不改写内容 —— 这是记忆树的核心不变量。 */
function conflictOf(ctx, row) {
  if (!ctx || !ctx.conflicts || !ctx.conflicts.size) return 1;
  const key = String(row?.source || '') + '\u0000' + String(row?.conv_id || '');
  return ctx.conflicts.get(key) ?? 1;
}

/**
 * Pick Top-N overviews for the L1 opener.
 * @param {MemoryStore} store
 * @param {object} opts { mode, keywords[], categoryWeights, maxItems, budgetChars, sessionId }
 *   `sessionId`(D9-a 起):用于血缘加权 —— 不传则不加权(旧行为)。
 * @returns {{items: Array, dropped: number, totalChars: number}}
 */
export function selectL1(store, opts) {
  const o = opts || {};
  const mode = o.mode === 'work' ? 'work' : 'life';
  const weights = Object.assign({}, CATEGORY_DEFAULTS, (o.categoryWeights || {})[mode] || {});
  const max = Math.max(1, Math.min(50, Number(o.maxItems ?? 8)));
  const budget = Math.max(200, Number(o.budgetChars ?? 6000)); // ~1.5 chars/token 中文估
  const now = Date.now();
  const summaryBonus = Number.isFinite(Number(o.summaryBonus)) ? Number(o.summaryBonus) : SUMMARY_BONUS_DEFAULT;
  // 2026-09-21:归档会话不参与召回 —— 归档是主人的明确动作("这条别再提了"),
  //   而此前 selectL1 直接吃 listOverviews 全量:归档只影响界面,召回照旧(用户实测反馈)。
  //   只对 source='dsh' 生效:archived 是会话级标记,历史网页端/导入条目没有会话行。
  const archived = (() => {
    try {
      return typeof store.archivedConvIdSet === 'function' ? store.archivedConvIdSet() : new Set();
    } catch {
      return new Set();
    }
  })();
  // Part G G2(2026-09-25):被"遗忘"的条目不再参与召回。
  //   遗忘是**软标记**(库里行还在,归档文件也在),所以撤销标记就恢复 —— 但召回必须真的不再选它,
  //   否则"忘了"只是界面上的幻觉:主人说要忘,我却还在每一次开口时想起来。
  //   键是 `source|conv_id`:历史网页端与导入条目没有会话行,不能只按会话判。
  const forgotten = (() => {
    try {
      return typeof store.forgottenConvIdSet === 'function' ? store.forgottenConvIdSet() : new Set();
    } catch {
      return new Set();
    }
  })();
  // ── 1.6 步 5:换料(双路并存,过渡期) ───────────────────────────────────────────────
  //   新:`store.listDeepItems()` —— 深层库条目(一句话结论/可从任何会话提炼)。
  //   旧:`store.listOverviews({ onlyOk: true })` —— 会话概述(一段话/会话一条)。
  //
  //   **为什么要并存而不是一刀切换掉**(2026-10-04):
  //   ① 条目还没提炼完(全量提炼在跑)⇒ 一刀切会让尚未提炼的会话在开场里**整个消失**;
  //   ② 换料是"数据源 + 打分公式 + 行渲染"三件一起动,旧路径保留 = 既有 8 个测试套件
  //      (branch/forget-backfill/injectlog/memories/sessionline/tree/times/unit)继续覆盖旧口径,
  //      不至于把"换料对不对"和"我有没有改坏别的"搅在一起。
  //   ⇒ 判据:**有条目就走新路**(本机现状),条目为空才回落概述。
  //   ⚠️ 条目铺满全库后,下面 `useDeep === false` 的整条分支可以删掉 —— 那才是这次换料的终点。
  const deepAll = (typeof store.listDeepItems === 'function')
    ? store.listDeepItems({ limit: DEEP_SCAN_MAX })
    : [];
  const useDeep = deepAll.length > 0;
  const all = useDeep
    ? deepAll
    : (typeof store.listOverviews === 'function' ? store.listOverviews({ onlyOk: true }) : []);
  // D9-a 血缘加权(2026-09-18):当前会话所属枝 → 每条记忆所属枝的档位
  //   (同枝 1.0 / 祖先 0.7 / 旁系或后代 0.4)。取"最弱环"单值,**不做连乘** ——
  //   `0.7^5=0.168`、`0.4^5=0.010`,连乘会让深枝等于从记忆里消失(见 `memory.js` 的 `LINEAGE_*`)。
  //   条目沿用同一把尺:血缘与矛盾降权都按 `source|conv_id` 索引,与"选的是概述还是条目"无关。
  const ctx = lineageContext(store, o.sessionId);
  // 1.6-A 投递留痕:过滤口径必须**可报告**。原来是一条 `.filter()` 链 —— 丢了多少、为什么丢,
  //   出了函数就查不到(只剩 `dropped` 一个净差)。改成显式循环,顺手留下三类计数:
  //   archived / forgotten 是**主动排除**(主人的明确动作),zero 是"算不出正分"(无信息量)。
  const excluded = { zero: 0, archived: 0, forgotten: 0, ephemeral: 0 };
  const scored = [];
  for (const row of all) {
    // 来源列名两路不同:条目叫 `src`、概述叫 `source`。血缘/矛盾/归档/遗忘四张表都按
    //   `source|conv_id` 索引 ⇒ 在这里对齐一次,而不是去改那四处读法。
    const srcOf = String(useDeep ? (row.src ?? '') : (row.source ?? ''));
    const asOverview = { source: srcOf, conv_id: row.conv_id };
    const lineage = lineageOf(ctx, asOverview);
    // D9-b:矛盾降权 —— 检出矛盾但未复盘时"以最新为准",旧的一方乘 CONFLICT_DOWNWEIGHT(0.3)。
    //   只降权、不删除、不改内容(设计稿 §4 的核心不变量)。
    const conf = conflictOf(ctx, asOverview);
    let x;
    if (useDeep) {
      // 硬度(1.6 v17):`ephemeral`(当次决定 / 一次性的绕法)**不进开场** —— 它照旧躺在库里、
      //   `recall` 搜得到,只是不该占开场那几个位置。这一条压的是**病根**(这条结论本身能活多久);
      //   而 `MAX_PER_CONV` 压的是症状(临时结论往往扎堆在一次会话里)⇒ 两者并存、分工不同。
      if (String(row.durability || 'long') === 'ephemeral') { excluded.ephemeral += 1; continue; }
      const hit = Number(row.hit_count ?? 0);
      const kw = kwHitInText(o.keywords || [], row.text);
      const t = toEpochMs(row.at || row.created_at);
      const recency = decayWeight(t === null ? 0 : Math.max(0, (now - t) / DAY_MS), DEEP_HALF_LIFE);
      // 硬度参与排序(不只是出局):`durable` 抬 0.6,与 `long` 拉开约 7 倍 ⇒ 长期原则/承诺/关系
      //   天然排在"阶段性结论"之前,不再靠新近来区分(新近已在 0.1 且常常全平)。
      const dur = String(row.durability || 'long').trim();
      const durBonus = DURABILITY_BONUS[dur] ?? 0;
      const kindW = KIND_WEIGHT[String(row.kind || '').trim()] ?? 0;
      const raw = durBonus + kindW
        + HIT_BONUS * Math.min(1, hit / HIT_SATURATION)
        + Math.min(KW_BONUS_CAP, kw * KW_BONUS_PER_HIT)
        + RECENCY_W * recency;
      const pinned = Number(row.pinned ?? 0) === 1;
      x = { row, score: raw * lineage * conf, lineage, raw, hit, kw, recency, conf, pinned, dur, durBonus, kindW, useDeep };
    } else {
      const heat = computeHeat(row, now, {});
      const catW = weights[row.category] ?? weights.daily ?? 0.5;
      const kw = kwOverlap(o.keywords || [], row.keywords);
      const rich = summaryWeight(row) * summaryBonus;
      const raw = catW * heat + Math.min(KW_BONUS_CAP, kw * KW_BONUS_PER_HIT) + (row.importance >= 1 ? 0.8 : 0) + rich;
      x = { row, score: raw * lineage * conf, lineage, raw, heat, catW, kw, rich, conf, pinned: false, useDeep };
    }
    // 置顶是**必进**的(主人的明确动作)⇒ 即使分数算不出正分也不丢;其余零分者视为无信息量。
    if (!(x.score > 0) && !x.pinned) { excluded.zero += 1; continue; }
    if (srcOf === 'dsh' && archived.has(String(row.conv_id))) { excluded.archived += 1; continue; }
    if (forgotten.has(srcOf + '|' + String(row.conv_id))) { excluded.forgotten += 1; continue; }
    scored.push(x);
  }
  // 排面:**置顶必进**(不参与竞争),其余按分排;同分时按**会话时间**新的在前 ——
  //   `created_at` 是入库时间,同一轮收进去的条目全落在同一秒 ⇒ 拿它当 tiebreaker 等于随机。
  const pinnedX = scored.filter((x) => x.pinned);
  const restX = scored
    .filter((x) => !x.pinned)
    .sort((a, b) => b.score - a.score
      || String(b.row.at || b.row.created_at || '').localeCompare(String(a.row.at || a.row.created_at || '')));
  // **同源限额**(2026-10-04 用户实测:「会话内的、临时的结论会被灌入」):
  //   同一次会话最多进 `MAX_PER_CONV` 条 —— 否则一次"高产出"的会话能把整个开场占满
  //   (实测某次生图会话有 13 条,开场 8 条里它一家全占)。同源被挡下的**进落选者名单**
  //   (`reason='conv'`),这样"它为什么没进"仍可查,而不是凭空消失。
  const perConv = new Map();
  const ranked = [];      // 过了同源限额与近似重复两道门、且已按分排好的全量
  const convCapped = [];  // 被同源限额挡下的
  const dupCapped = [];   // 与已入选条目**近似重复**的(2026-10-04:同一次真实注入里出现过两条同义结论)
  const pickedTexts = [];
  for (const x of [...pinnedX, ...restX]) {
    const k = String(x.row.conv_id || '');
    const seen = perConv.get(k) || 0;
    // 置顶不受限额约束 —— 那是主人的明确动作;限额只用来挡"自动提炼的扎堆"。
    if (seen >= MAX_PER_CONV && !x.pinned) { convCapped.push(x); continue; }
    // 近似重复:与**已入选**的任一条件文本高度相似 ⇒ 让位。
    //   ⚠️ **置顶豁免** —— 与同源限额同一待遇:置顶是主人的明确动作,他要让两条同义的都进,那是他的权利;
    //   去重只该挡"自动提炼出来的重复"(2026-10-04:测试夹具三条同文本置顶当场打红了三条断言)。
    const body = useDeep ? x.row.text : (x.row.title || x.row.summary);
    if (!x.pinned && pickedTexts.some((t) => similarText(t, body))) { dupCapped.push(x); continue; }
    perConv.set(k, seen + 1);
    pickedTexts.push(body);
    ranked.push(x);
  }
  // ⚠️ `chosen` 必须是 **Top-max**(后面那道预算循环只负责按字数裁):
  //   若把 `ranked` 直接当 `chosen`,`cutAt` 之后的全会被归成 `budget` 落选 —— 而它们其实是
  //   "排在第 max 名之后",两类原因混起来,落选者留痕就说谎了(2026-10-04 踩过,两个套件同时红)。
  // ⚠️ **置顶必进**在 `maxItems` 这一道也必须成立(红队 2026-10-04 实测:9 条置顶 + maxItems=3 ⇒
  //   只进 3 条,越界那 6 条 `pinned=true` 却被记成 `reason='max'`)—— 同源限额与去重两道门都给了
  //   置顶豁免,这一道漏了,等于"必进"只是句空话。置顶超过 max 时**允许越界**(它是主人的明确动作)。
  const keepPinned = ranked.filter((x) => x.pinned);
  const restRanked = ranked.filter((x) => !x.pinned);
  const restQuota = Math.max(0, max - keepPinned.length);
  // **事实席位**(用户 2026-10-04:「8 条也可以考虑改 10 条,其中 2 条作为最硬的事实的席位」)——
  //   动机是他看到的偏斜:承诺/关系优先之后,「我在什么环境里干活」这类**稳定事实**因为类别分为 0
  //   而永远进不来;但它们确实是"接下来要干什么"的前提。⇒ 10 个位置里留 2 个给**最硬的事实**
  //   (`durable` 的「事实」类),既不挤占"关于人"的主体(那 8 个),也不让环境事实缺席。
  //   没有合格事实时席位**归还通用池** —— 宁可让位也不空着。
  const FACT_SEATS = 2;
  const isHardFact = (x) => String(x.row?.kind || '') === '事实' && String(x.row?.durability || '') === 'durable';
  const factPool = restRanked.filter(isHardFact);
  const genPool = restRanked.filter((x) => !isHardFact(x));
  const factTake = factPool.slice(0, Math.min(FACT_SEATS, restQuota));
  const genTake = genPool.slice(0, Math.max(0, restQuota - factTake.length));
  // 混排回分数序(席位只决定"谁能进",不改变"进了之后排第几")
  const chosen = [...keepPinned, ...[...factTake, ...genTake].sort((a, b) => b.score - a.score)];
  const chosenSet = new Set(chosen);
  const beyondMax = restRanked.filter((x) => !chosenSet.has(x));
  // ⚠️ `weights`(categoryWeights)与 `summaryBonus` 只在 `useDeep === false` 的回落路径里参与打分。
  void weights; void summaryBonus;
  // budget-aware trim
  // 行渲染**必须跟着数据源分路**(2026-10-04 踩过):条目走 `deepLine`(极简一行),
  //   概述走 `lineFor`(标题 —— 摘要 + 来源后缀)。写成无条件 `deepLine` 的后果是:
  //   回落路径下 `row.text` 是 undefined ⇒ 每一行渲染成 `- ` ⇒ 整个注入面变成一串空行,
  //   **而且不报错**(不是异常,是静默错),只有断言"格式化含来源"能抓到它。
  const lineOf = (row) => (useDeep
    ? deepLine(row, o.maxLineChars)
    : lineFor(row, { maxChars: o.maxLineChars, summaryChars: o.summaryChars, selfConvId: o.sessionId }));
  const items = [];
  let totalChars = 0;
  let cutAt = chosen.length; // 第一个被字节预算挡下的位置(它及之后 = 预算落选)
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const line = lineOf(c.row);
    // ⚠️ **置顶必进在这里也必须成立**(蓝队 2026-10-04 抓到:上一版只改了 `chosen` 的造法,
    //   没改这道闸门 ⇒ 真机 9 条置顶 + maxItems=3 仍只进 3 条,穷举 90 组**累计丢掉 117 条置顶**)。
    //   置顶越界时**允许超出 max**,字数预算对它也不设限 —— 否则"必进"只是句空话。
    //   `chosen` 已把置顶排在前面,所以非置顶越界时 `break` 仍然正确(后面全是非置顶)。
    if (!c.pinned && (items.length >= max || totalChars + line.length > budget)) { cutAt = i; break; }
    items.push({ ...c.row, score: +c.score.toFixed(3), lineage: +Number(c.lineage).toFixed(2), conf: +Number(c.conf ?? 1).toFixed(2), raw: +Number(c.raw).toFixed(3), kw: c.kw, hit: c.hit, pinned: c.pinned, line, why: explainScore(c) });
    totalChars += line.length;
  }
  // 落选者名单(1.6-A):**差一步就进**的那几条 + 为什么没进。这是"不漏用"这一维唯一的仪表 ——
  //   只看 `dropped` 一个净差,回答不了「是分数本来就不够,还是被字节预算挤掉的」。
  //   两类原因互斥:`budget` = 已在 Top-max 之内、字数放不下(必排在 `max` 组之前);`max` = 排在第 max 名之后。
  const runnerUpLimit = Math.max(0, Math.min(20, Number(o.runnerUps ?? RUNNER_UPS_DEFAULT)));
  const runners = [];
  for (let i = cutAt; i < chosen.length; i++) runners.push({ x: chosen[i], reason: 'budget' });
  for (const x of convCapped) runners.push({ x, reason: 'conv' });   // 被同源限额挡下(2026-10-04)
  for (const x of dupCapped) runners.push({ x, reason: 'dup' });     // 与已入选条目近似重复(2026-10-04)
  for (const x of beyondMax) runners.push({ x, reason: 'max' });     // 排在第 max 名之后(已排序,故比旧的 scored[i] 更准)
  runners.sort((a, b) => b.x.score - a.x.score);
  const runnerUps = runners.slice(0, runnerUpLimit).map(({ x, reason }) => ({
    // ⚠️ 来源列名两路不同:条目叫 `src`、概述叫 `source`(红队 2026-10-04 抓到:这里写死
    //   `x.row.source` ⇒ 换料后落选者留痕的 source **恒为 undefined**,实测 id 42–46 段 0/5)——
    //   而 `archived`/`forgotten`/`conflict` 三张表全按 `source|conv_id` 索引,丢了 source 就回查不上。
    source: String(x.useDeep ? (x.row.src ?? '') : (x.row.source ?? '')),
    conv_id: x.row.conv_id,
    score: +x.score.toFixed(3),
    raw: +Number(x.raw).toFixed(3),
    lineage: +Number(x.lineage).toFixed(2),
    conf: +Number(x.conf ?? 1).toFixed(2),
    kw: x.kw,
    hit: x.hit,
    pinned: x.pinned,
    reason,
    chars: lineOf(x.row).length,
    why: explainScore(x),
  }));
  return {
    items,
    dropped: scored.length - items.length,
    runnerUps,
    excluded,
    // 本轮选取的触发词(1.6-A 留痕):「为什么是它」的一半答案在**问句**里,不留就无从复盘。
    keywords: Array.isArray(o.keywords) ? o.keywords.slice() : [],
    totalChars,
    mode,
    budget,
  };
}

const SUMMARY_CHARS_DEFAULT = 110;
/** 取"第一句":按中文句末标点(。；！？及英文 !?;)切;切完仍超 cap 则硬截并标 …。
 *  cap ≤ 0 = 不截(供测试与向后兼容)。 */
export function firstSentence(text, cap = SUMMARY_CHARS_DEFAULT) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^[\s\S]*?[。；！？!?;]/);
  let head = (m ? m[0] : t).trim();
  const limit = Number(cap) > 0 ? Math.max(40, Number(cap)) : 0;
  if (limit && head.length > limit) {
    const slice = head.slice(0, limit);
    const cut = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf(','), slice.lastIndexOf('、'));
    head = (cut >= Math.floor(limit * 0.6) ? slice.slice(0, cut) : slice) + '…';
  }
  return head;
}

/**
 * 一行 L1 记忆(两段结构 + 允许缺省,2026-09-16 与用户定案):
 *   有摘要 → `标题 —— 摘要第一句`(第一句超 summaryChars 再硬截)
 *   无摘要 → 只用标题(信息量优先,不截;仍受 maxChars 兜底)
 *   摘要自带标题(概述器/深摘的常态)→ 不重复前缀,只留正文
 * @param {object} row
 * @param {{maxChars?:number, summaryChars?:number, selfConvId?:string}} opts
 *   `selfConvId`(E0,1.5.2):**本会话自己那一行**只留标题、不带摘要 ——
 *   它的"进展"由活行(lib/host/session-line.js)承担;两边都印摘要 = 同一句话出现两遍。
 */
function lineFor(row, { maxChars = 0, summaryChars = SUMMARY_CHARS_DEFAULT, selfConvId = '' } = {}) {
  const date = isoDate(row.updated_at || row.started_at);
  const tags = Array.isArray(row.domain_tags) && row.domain_tags.length ? `[${row.domain_tags.slice(0, 2).join('/')}]` : `[${row.category}]`;
  const title = String(row.title || '').trim();
  const summary = String(row.summary || '').trim();
  // 摘要去掉标题前缀,只留正文(摘要自带标题时不重复)
  let body = summary;
  if (title && body.startsWith(title)) body = body.slice(title.length).replace(/^[\s:：—-]+/, '');
  if (body === title) body = '';
  // E0(1.5.2):本会话自己那一行 → 只要标题(摘要在活行里,不重复印)。
  // 兜底:万一这行没有标题,仍退回摘要首句 —— 绝不让它渲染成"只有标签和来源"的空行。
  const isSelf = !!selfConvId && String(row.conv_id || '') === String(selfConvId);
  const text = isSelf
    ? (title || firstSentence(body, summaryChars))
    : ((title && body) ? `${title} —— ${firstSentence(body, summaryChars)}` : (title || firstSentence(body, summaryChars)));
  // 兜底硬顶:只对病态长标题生效(摘要侧已由 summaryChars 控住)
  const cap = Number(maxChars) > 0 ? Math.max(60, Number(maxChars)) : 0;
  let out = text;
  if (cap && out.length > cap) {
    const slice = out.slice(0, cap);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
    out = (cut >= Math.floor(cap * 0.5) ? slice.slice(0, cut + 1) : slice) + '…';
  }
  const srcName = row.source === 'dsh' ? 'DSH 会话' : row.source === 'import' ? '文件导入' : '历史会话';
  // DSH 会话 id 一律以 "session-" 开头,取前 8 位会全都一样 —— 这时取前缀之后的那一段才可区分
  const cid = String(row.conv_id || '');
  const short = cid.startsWith('session-') ? cid.slice(8, 16) : cid.slice(0, 8);
  return `- ${tags} ${date ? `(${date})` : ''}${out ? ' ' + out : ''} (来源: ${srcName}/${short})`;
}

/** 1.6 步 5:一条**深层库条目**渲染成一行(取代 `lineFor` 的概述两段式 `标题 —— 摘要首句`)。
 *  为什么这么极简:条目本身就是**一句话结论**(全库均 48 字),再套"日期/标签/来源"三段前缀
 *  等于每行白付约 15 字的税,而注入面的字数是这份文件存在的理由本身。
 *  出处(conv/seq)不进这一行 —— 它落在**投递留痕**里(`inject_log.items`),模型要原话时
 *  用 `recall({q})` 找到条目再 `recall(conv, from, to)` 下钻。
 *  `lineFor` 保留未删:它仍是被测函数(`l1lines.test.mjs`),且概述行在别的读面还在用。 */
function deepLine(row, maxChars = 0) {
  const kind = String(row?.kind || '').trim();
  let text = String(row?.text || '').trim();
  // 兜底硬顶(默认 0 = 不截):提炼侧本来就限制 ≤80 字,这里只为**病态行**保命 ——
  //   预算裁剪是"装不下就停"(见下面的 for),一条超长条目会把排在它后面的全卡死。
  const cap = Number(maxChars) > 0 ? Math.max(60, Number(maxChars)) : 0;
  if (cap && text.length > cap) text = text.slice(0, cap - 1) + '…';
  return kind ? `- [${kind}] ${text}` : `- ${text}`;
}

// L1 视角框(1.6 · 第一批 B)—— 修「代词混乱」BUG:落点一处、覆盖全部历史条目、零动库。
// 病灶(实测):`conv_overview` 的
// **标题位多半是主人当年的原话**(8 行里 7 行),其中还夹着指令与限制 ——
// 如「本会话暂时不用执行任何写操作」,读到会误判**当前**会话只读,是可指认的行为危害。
// 组装侧 `lineFor()` 不做人称改写是对的(原文照录才有信息量),缺的是**声明视角**。
// 代价:每次注入 +≈59 字(约本段 5%);改段头 ⇒ 前缀缓存断一次,此后稳定。
const L1_FRAME_CALLNAME_FALLBACK = '主人';

/**
 * 视角框的称呼 —— **跟随 `persona.userTitle`**,不硬编码。
 *
 * 为什么走配置而不是写死(2026-10-04 用户的判断:「提早换更合适」):
 *  - `dsh-ling` 是要发 npm 的通用包,**把某个用户的名字写死会污染公开件**;
 *  - `userTitle` 本来就是**主人自己可编辑**的字段(`persona.js`:「空 = 用"你"」),
 *    走它 = 本机显示他设的称呼、别人的实例显示他们自己的,**本机效果不打折**;
 *  - 与 `[现在] 距上次与X对话`(`clock.js` 的 `userTitleForMode`)共用同一把尺 ⇒ 两处口径不会打架;
 *  - 换名字只改一处配置,不必重新发版。
 *
 * 空值退回中性措辞「主人」(`L1_FRAME_CALLNAME_FALLBACK`)—— 与包内既有文案口径一致。
 * ⚠️ 不可退回「你」:框里「你」已经**被定义为我(器灵)**,称呼主人用「你」会自相矛盾。
 */
export function perspectiveFrame(userTitle = '', mode = 'life') {
  const callName = userTitleForMode(userTitle, mode) || L1_FRAME_CALLNAME_FALLBACK;
  // ⚠️ 1.6 步 5 换料后措辞必须跟着改:框里原来的说法是「${callName}过去对我说过的话」,
  //   那是**概述时代**的事实(标题位多半是他的原话);现在注入的是**提炼出的结论**
  //   (承诺/决定/事实/偏好/关系),主体既可能是他也可能是我 ⇒ 说成"他说过的话"会失真。
  return `（以下是我从与${callName}的过去里记住的结论：「你」指我，「我/我们」指他，「本会话/接下来/现在」指当时那个会话，不是此刻的指令。）`;
}

export function formatL1Section(result, opts = {}) {
  if (!result || !result.items.length) return '';
  const lines = result.items.map((i) => i.line);
  if (result.dropped > 0) lines.push(`(已省略 ${result.dropped} 条较低相关记忆)`);
  return `[记忆·开场]${perspectiveFrame(opts.userTitle, opts.mode)}\n` + lines.join('\n');
}
