// dsh-ling host — L1 opener selection v0 (DESIGN §6.2).
// heat = α·recency + β·freq + γ·importance (exponential decay, half-life configurable);
// mode weights by category (knowledge/daily/feeling); optional keyword pre-match.
import { toEpochMs, isoDate } from './util.js';

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

const KW_BONUS_PER_HIT = 0.6;
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
  const all = store.listOverviews({ onlyOk: true });
  // D9-a 血缘加权(2026-09-18):当前会话所属枝 → 每条记忆所属枝的档位
  //   (同枝 1.0 / 祖先 0.7 / 旁系或后代 0.4)。取"最弱环"单值,**不做连乘** ——
  //   `0.7^5=0.168`、`0.4^5=0.010`,连乘会让深枝等于从记忆里消失(见 `memory.js` 的 `LINEAGE_*`)。
  //   记忆行不冗余存 branch,靠 `session_meta.branch_id` 推导(见 `plans/MEMORY-TREE.md` §2.2)。
  const ctx = lineageContext(store, o.sessionId);
  const scored = all
    .map((row) => {
      const heat = computeHeat(row, now, {});
      const catW = weights[row.category] ?? weights.daily ?? 0.5;
      const kw = kwOverlap(o.keywords || [], row.keywords);
      const rich = summaryWeight(row) * summaryBonus;
      const raw = catW * heat + Math.min(KW_BONUS_CAP, kw * KW_BONUS_PER_HIT) + (row.importance >= 1 ? 0.8 : 0) + rich;
      const lineage = lineageOf(ctx, row);
      // D9-b:矛盾降权 —— 检出矛盾但未复盘时"以最新为准",旧的一方乘 CONFLICT_DOWNWEIGHT(0.3)。
      //   只降权、不删除、不改内容(设计稿 §4 的核心不变量)。
      const conf = conflictOf(ctx, row);
      return { row, score: raw * lineage * conf, lineage, raw, heat, kw, rich, conf };
    })
    .filter((x) => x.score > 0 && !(x.row.source === 'dsh' && archived.has(String(x.row.conv_id))))
    .sort((a, b) => b.score - a.score || String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || '')));
  const chosen = scored.slice(0, max);
  // budget-aware trim
  const items = [];
  let totalChars = 0;
  for (const c of chosen) {
    const line = lineFor(c.row, { maxChars: o.maxLineChars, summaryChars: o.summaryChars });
    if (items.length >= max || totalChars + line.length > budget) break;
    items.push({ ...c.row, score: +c.score.toFixed(3), lineage: +Number(c.lineage).toFixed(2), conf: +Number(c.conf ?? 1).toFixed(2), raw: +Number(c.raw).toFixed(3), kw: c.kw, rich: c.rich, line });
    totalChars += line.length;
  }
  return {
    items,
    dropped: scored.length - items.length,
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
 * @param {{maxChars?:number, summaryChars?:number}} opts
 */
function lineFor(row, { maxChars = 0, summaryChars = SUMMARY_CHARS_DEFAULT } = {}) {
  const date = isoDate(row.updated_at || row.started_at);
  const tags = Array.isArray(row.domain_tags) && row.domain_tags.length ? `[${row.domain_tags.slice(0, 2).join('/')}]` : `[${row.category}]`;
  const title = String(row.title || '').trim();
  const summary = String(row.summary || '').trim();
  // 摘要去掉标题前缀,只留正文(摘要自带标题时不重复)
  let body = summary;
  if (title && body.startsWith(title)) body = body.slice(title.length).replace(/^[\s:：—-]+/, '');
  if (body === title) body = '';
  const text = (title && body) ? `${title} —— ${firstSentence(body, summaryChars)}` : (title || firstSentence(body, summaryChars));
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

export function formatL1Section(result) {
  if (!result || !result.items.length) return '';
  const lines = result.items.map((i) => i.line);
  if (result.dropped > 0) lines.push(`(已省略 ${result.dropped} 条较低相关记忆)`);
  return '[记忆·开场]\n' + lines.join('\n');
}
