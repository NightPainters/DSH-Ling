// dsh-ling host — 语料人格建议识别器 v2(零模型,证据驱动)。
// 称呼类建议采用**白名单人称词库 + 句首/句尾双端匹配**(避免把"不错/当然可以/服务器繁忙"
// 之类功能性开头当称呼);纠正类仍用模式桶。全部阈值保守,证据附带原文摘录。

// 示例词库(启发式):可按你自己的历史语料增删。
// AI 自称词库:识别"助手在句中如何自称"的候选;
// 用户称呼词库:识别"助手如何称呼用户"的候选(其中也含 AI 自身名字,以免把自称误判成对用户的称呼)。
const AI_NAME_LEX = ['小灵', '灵灵', '小灵儿', '阿灵', '小语', '语语'];
const USER_TITLE_LEX = ['主人', '朋友', '兄弟', '老哥', '老师', '同学', '伙伴', '老板', '师傅', '亲', '阁下', '君', '先生', '女士', '道友', '掌柜', '大王', '小灵', '灵灵', '小语', '你老'];

export const CORRECTION_BUCKETS = [
  {
    key: 'classical',
    rule: '不要为文言而文言;用户要求直白清楚时用现代口语。',
    re: /太文言|文言文|文言了|晦涩|诘屈|为文言|咬文嚼字|拽文|之乎者也/,
  },
  {
    key: 'verbose',
    rule: '回答先给结论,控制篇幅,别绕。',
    re: /太啰嗦|太冗长|废话|太长不看|精简|精炼|说重点|直接给结论|别绕|说人话|简洁一点|能不能短点|缩短|废话太多|回复太长|回答太长|写太长|车轱辘|重复啰嗦/,
  },
  {
    key: 'vague',
    rule: '不要空话套话;给可执行的具体内容。',
    re: /太虚|假大空|空话|套话|不接地气|太抽象|太空洞|虚的|来点实际的|干货|务实点|别整虚的/,
  },
  {
    key: 'emotion',
    rule: '语气有温度一点,别太冷/太官方。',
    re: /太冷|冷漠|冷冰冰|温柔一点|温暖一点|太官方|太正式|轻松点|活泼点|俏皮|幽默点|有人情味|太机械|太客套/,
  },
  {
    key: 'format',
    rule: '多用结构化呈现(分点/表格/列表),便于阅读。',
    re: /用表格|分点|分条|列个表|做成表格|排版|结构化|条理|编号列出|要点列出来|表格形式|按点回答/,
  },
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function excerptAround(text, idx, span = 44) {
  const start = Math.max(0, idx - span);
  const seg = text.slice(start, idx + span).replace(/\s+/g, ' ');
  return (start > 0 ? '…' : '') + seg + (start + seg.length < text.length ? '…' : '');
}

/**
 * 白名单人称匹配:词出现在句首(词+标点)或句尾(标点+词)才计为"称呼"。
 * 附带 anyTotal(全文提及次数,作旁证展示)。
 */
function analyzeLexMatches(docs, lexicon, { minCount = 3 }) {
  const out = [];
  for (const w of lexicon) {
    const startRe = new RegExp('^' + escRe(w) + '[，,。！!？?:：]');
    const tailRe = new RegExp('[，,。！!？?:：]' + escRe(w) + '[。!！？?]?$');
    let n = 0;
    let anyTotal = 0;
    let last = '';
    const samples = [];
    for (const doc of docs) {
      const text = doc.text || '';
      if (text.length > 20000) continue;
      if (text.includes(w)) anyTotal += 1;
      let idx = -1;
      let m = text.match(startRe);
      if (m) {
        idx = 0;
      } else {
        m = text.match(tailRe);
        if (m) idx = text.lastIndexOf(w);
      }
      if (idx < 0) continue;
      n += 1;
      if (!last || (doc.date || '') > last) last = doc.date || '';
      if (samples.length < 3) {
        samples.push({ date: doc.date || '', ref: doc.ref || '', excerpt: excerptAround(text, Math.max(0, idx)) });
      }
    }
    if (n >= minCount) {
      out.push({ chunk: w, n, last, samples, anyTotal });
    }
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 3);
}

function analyzeCorrections(docs, { minCount = 3 }) {
  const buckets = CORRECTION_BUCKETS.map((b) => ({ ...b, n: 0, last: '', samples: [] }));
  for (const doc of docs) {
    const text = doc.text || '';
    if (text.length > 20000) continue;
    for (const b of buckets) {
      const m = text.match(b.re);
      if (m) {
        b.n += 1;
        if (!b.last || (doc.date || '') > b.last) b.last = doc.date || '';
        if (b.samples.length < 3) {
          b.samples.push({ date: doc.date || '', ref: doc.ref || '', excerpt: excerptAround(text, m.index) });
        }
      }
    }
  }
  return buckets.filter((b) => b.n >= minCount);
}

/**
 * @param {object} opts { userDocs, assistantDocs }
 */
export function analyzeCorpus({ userDocs = [], assistantDocs = [] } = {}) {
  const items = [];
  const aiNames = analyzeLexMatches(userDocs, AI_NAME_LEX, { minCount: 3 });
  if (aiNames.length) {
    const top = aiNames[0];
    items.push({
      kind: 'aiName',
      value: top.chunk,
      note: `历史语料里你有 ${top.n} 次在句首/句尾以「${top.chunk}」唤我(全文提及 ${top.anyTotal} 次,最近 ${top.last || '?'})。建议 AI 自称设为「${top.chunk}」。`,
      evidence: { count: top.n, recent: top.last, samples: top.samples.slice(0, 3), anyTotal: top.anyTotal },
    });
  }
  const userTitles = analyzeLexMatches(assistantDocs, USER_TITLE_LEX, { minCount: 3 });
  if (userTitles.length) {
    const top = userTitles[0];
    items.push({
      kind: 'userTitle',
      value: top.chunk,
      note: `过去我的回复里有 ${top.n} 次以「${top.chunk}」称呼你(全文 ${top.anyTotal} 次,最近 ${top.last || '?'})。建议沿用为对你的称呼。`,
      evidence: { count: top.n, recent: top.last, samples: top.samples.slice(0, 3), anyTotal: top.anyTotal },
    });
  }
  for (const b of analyzeCorrections(userDocs, { minCount: 3 })) {
    items.push({
      kind: 'hardrule',
      value: b.rule,
      note: `你在 ${b.n} 条消息里表达过这类诉求(最近 ${b.last || '?'}),建议采纳为习惯:「${b.rule}」`,
      evidence: { count: b.n, recent: b.last, samples: b.samples.slice(0, 3), bucket: b.key },
    });
  }
  return { items, stats: { userDocs: userDocs.length, assistantDocs: assistantDocs.length } };
}
