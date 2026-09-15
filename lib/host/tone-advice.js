// dsh-ling host — 语气 P1:按记忆分类(知识↔生活)归纳语气候选(人审采纳,自由生长)。
// 语义(2026-09-11 作者拍板):
//   - 语气/风格属"自性类"→ 成长通道,锁定下免手术;契约类(名字/称呼/底线/世界观)仍属手术区;
//   - 只做可逆动作:语气仅在四档枚举间替换;风格文本只追加、不删除用户写过的字;
//   - 采纳=用户按下的那一下(候选不落盘)。
import { extractJson } from './genesis.js';
import { isPlaceholderSummary, snippetFromRaw } from './genesis.js';

export const TONE_SET = ['natural', 'literary', 'concise', 'playful'];
export const TONE_LABEL = { natural: '自然亲切', literary: '文雅', concise: '简洁直接', playful: '活泼俏皮' };

/** 模型可能回中文/大写/近义词:统一归一到四档枚举,失败返回 ''(不猜)。 */
export const TONE_ALIAS = {
  natural: 'natural', 自然: 'natural', 自然亲切: 'natural', 亲切: 'natural', 温和: 'natural',
  literary: 'literary', 文雅: 'literary', 文学: 'literary', 典雅: 'literary', 书面: 'literary',
  concise: 'concise', 简洁: 'concise', 简洁直接: 'concise', 直接: 'concise', 精炼: 'concise', 干练: 'concise',
  playful: 'playful', 活泼: 'playful', 俏皮: 'playful', 活泼俏皮: 'playful', 轻松: 'playful', 幽默: 'playful',
};
export function normalizeTone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (TONE_SET.includes(lower)) return lower;
  if (TONE_ALIAS[s]) return TONE_ALIAS[s];
  if (TONE_ALIAS[lower]) return TONE_ALIAS[lower];
  for (const k of TONE_SET) if (lower.includes(k)) return k; // 如 "concise(简洁直接)"
  for (const [k, v] of Object.entries(TONE_ALIAS)) if (s.includes(k)) return v;
  return '';
}

/** 两侧取样权重:工作侧看知识,生活侧看情感与日常 */
export const TONE_SIDE_WEIGHTS = {
  work: { knowledge: 1.0, daily: 0.3, feeling: 0.05 },
  life: { feeling: 1.0, daily: 0.6, knowledge: 0.05 },
};
/** 置顶加成刻意小于最小类别差:只在同类内优先,不反转"工作侧看知识 / 生活侧看情感"的类别序。 */
export const TONE_IMPORTANCE_BONUS = 0.35;

export const TONE_ADVICE_SYS = `你是器灵的"语气观察员"。请阅读两组历史材料(工作侧 / 生活侧),分别判断用户更适应哪一种语气,并给出依据。
四档语气(必须从中选择,不要创造新词):
- natural 自然亲切:口语化但不轻浮,专业问题先严谨再谈温度
- literary 文雅:文雅简洁,可适当用典,不堆砌辞藻
- concise 简洁直接:直接、精炼、少铺垫、结论先行
- playful 活泼俏皮:轻松活泼,适度俏皮,仍以有用为先
要求:
1. 依据必须来自材料里真实出现的痕迹(如反复要求结论先行、深夜更接受玩笑、讨厌冗长文言等),不要空话;
2. 只输出一个 JSON 对象,键名严格为 work / life;每个值为 {"tone":"四档之一","note":"≤80 字语气注(她会怎么写自己)","evidence":"≤120 字判断依据"};
3. 不要解释、不要 markdown 围栏以外的文字。`;

/** 按侧取样:类别权重 + 置顶加成,降序取前 limit;并做三级取用(深摘→概述→片段/线索)。 */
export function sampleToneRows(memory, { side = 'life', limit = 40, pronoun = '她' } = {}) {
  const weights = TONE_SIDE_WEIGHTS[side] || TONE_SIDE_WEIGHTS.life;
  const pool = memory.db.prepare(
    'SELECT conv_id, title, summary, keywords, category, importance, updated_at FROM conv_overview',
  ).all();
  const rows = pool.map((r) => ({
    conv_id: String(r.conv_id),
    title: r.title,
    summary: String(r.summary || ''),
    keywords: (() => { try { const v = JSON.parse(String(r.keywords || '[]')); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    category: String(r.category),
    importance: Number(r.importance) || 0,
    updated_at: String(r.updated_at || ''),
  }))
    .map((r) => ({ ...r, score: (weights[r.category] ?? 0.05) + (r.importance > 0 ? TONE_IMPORTANCE_BONUS : 0) }))
    .sort((a, b) => (b.score - a.score) || b.updated_at.localeCompare(a.updated_at))
    .slice(0, Math.max(1, Math.min(limit, 200)));
  const out = rows.map((r) => {
    const deep = memory.kvGet('deep.sum:' + r.conv_id);
    let summary = '';
    if (deep) summary = String(deep);
    else {
      const s = r.summary.trim();
      if (s && !isPlaceholderSummary(s)) summary = s;
    }
    return {
      title: r.title,
      summary,
      snippet: summary ? '' : snippetFromRaw(memory, r.conv_id, { pronoun }),
      keywords: summary ? [] : r.keywords,
      category: r.category,
    };
  });
  return { rows: out, sampled: out.length, pool: pool.length };
}

/** 清洗模型输出 → { work:{tone,note,evidence}, life:{...} }(tone 走别名归一,失败置空) */
export function parseToneAdvice(text) {
  const j = extractJson(text) || {};
  const side = (a, b, c) => a || b || c || {};
  const pick = (v) => {
    const o = v && typeof v === 'object' ? v : {};
    return {
      tone: normalizeTone(o.tone),
      note: String(o.note ?? '').trim().slice(0, 80),
      evidence: String(o.evidence ?? '').trim().slice(0, 120),
    };
  };
  return {
    work: pick(side(j.work, j['工作'], j['工作侧'])),
    life: pick(side(j.life, j['生活'], j['生活侧'])),
  };
}

/** 风格文本追加:只追加、不删除;已含则原样返回(去重)。 */
export function appendStyleNote(existing, note) {
  const cur = String(existing || '');
  const add = String(note || '').trim();
  if (!add) return cur;
  if (cur.includes(add)) return cur;
  return (cur.trimEnd() ? cur.trimEnd() + '\n' : '') + add;
}
