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

/**
 * Pick Top-N overviews for the L1 opener.
 * @param {MemoryStore} store
 * @param {object} opts { mode, keywords[], categoryWeights, maxItems, budgetChars }
 * @returns {{items: Array, dropped: number, totalChars: number}}
 */
export function selectL1(store, opts) {
  const o = opts || {};
  const mode = o.mode === 'work' ? 'work' : 'life';
  const weights = Object.assign({}, CATEGORY_DEFAULTS, (o.categoryWeights || {})[mode] || {});
  const max = Math.max(1, Math.min(50, Number(o.maxItems ?? 8)));
  const budget = Math.max(200, Number(o.budgetChars ?? 6000)); // ~1.5 chars/token 中文估
  const now = Date.now();
  const all = store.listOverviews({ onlyOk: true });
  const scored = all
    .map((row) => {
      const heat = computeHeat(row, now, {});
      const catW = weights[row.category] ?? weights.daily ?? 0.5;
      const kw = kwOverlap(o.keywords || [], row.keywords);
      return { row, score: catW * heat + Math.min(KW_BONUS_CAP, kw * KW_BONUS_PER_HIT) + (row.importance >= 1 ? 0.8 : 0), heat, kw };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || '')));
  const chosen = scored.slice(0, max);
  // budget-aware trim
  const items = [];
  let totalChars = 0;
  for (const c of chosen) {
    const line = lineFor(c.row, { maxChars: o.maxLineChars });
    if (items.length >= max || totalChars + line.length > budget) break;
    items.push({ ...c.row, score: +c.score.toFixed(3), kw: c.kw, line });
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

function lineFor(row, { maxChars = 0 } = {}) {
  const date = isoDate(row.updated_at || row.started_at);
  const tags = Array.isArray(row.domain_tags) && row.domain_tags.length ? `[${row.domain_tags.slice(0, 2).join('/')}]` : `[${row.category}]`;
  const title = String(row.title || '').trim();
  const summary = String(row.summary || '').trim();
  // 标题/摘要去重:摘要自带标题(概述器与深摘都是"首问开头")时只留一份,不再重复前缀
  let body;
  if (title && summary) {
    body = summary === title ? title
      : summary.startsWith(title) ? summary
        : `${title}: ${summary}`;
  } else {
    body = title || summary;
  }
  // 单行上限:防止一条超长摘要吃满整个预算(截断优先落在句末,并标 …)
  const cap = Number(maxChars) > 0 ? Math.max(60, Number(maxChars)) : 0;
  if (cap && body.length > cap) {
    const slice = body.slice(0, cap);
    const cut = Math.max(slice.lastIndexOf('。'), slice.lastIndexOf('；'), slice.lastIndexOf('！'), slice.lastIndexOf('？'), slice.lastIndexOf('\n'));
    body = (cut >= Math.floor(cap * 0.5) ? slice.slice(0, cut + 1) : slice) + '…';
  }
  const srcName = row.source === 'dsh' ? 'DSH 会话' : row.source === 'import' ? '文件导入' : '历史会话';
  // DSH 会话 id 一律以 "session-" 开头,取前 8 位会全都一样 —— 这时取前缀之后的那一段才可区分
  const cid = String(row.conv_id || '');
  const short = cid.startsWith('session-') ? cid.slice(8, 16) : cid.slice(0, 8);
  return `- ${tags} ${date ? `(${date})` : ''}${body ? ' ' + body : ''} (来源: ${srcName}/${short})`;
}

export function formatL1Section(result) {
  if (!result || !result.items.length) return '';
  const lines = result.items.map((i) => i.line);
  if (result.dropped > 0) lines.push(`(已省略 ${result.dropped} 条较低相关记忆)`);
  return '[记忆·开场]\n' + lines.join('\n');
}
