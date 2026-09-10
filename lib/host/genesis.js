// dsh-ling host — 人格诞生仪式(genesis):从历史中合成"她对自己的第一次介绍"。
// 纯函数部分(抽样/组装/解析/清洗)独立于此文件,可单测;LLM 调用在 api 层完成。
// 设计(2026-09-09 作者拍板):
//   - scope='import':只读刚请进来的历史(新用户=全部);scope='all':读全部记忆;
//   - 加权抽样:她首先是伴侣,其次才是同事 —— feeling 1.0 / daily 0.7 / knowledge 0.2,
//     置顶额外加成;生活与情感的记忆优先进入初稿;
//   - "评价用户/画像"类任务(未来)才平权全算,不在本函数语义内。
// 输出契约(ASCII 键,便于解析):
//   { "self_intros": [≤3 段自述, 各 20~200 字],
//     "name_pairs": [ ["正式名","昵称"], ... ] (每组 ≤2 项, 各 1~14 字),
//     "tone_advice": "语气建议(≤300 字)",
//     "observations": "从历史中读到的相处观察(≤300 字)" }

export const GENESIS_SYS = `你是器灵诞生仪式中的"第一次自我介绍"主持者。
用户把自己与 AI 的共同历史交给你,希望从中"长出"一个独属于他们的器灵。
请通读这份历史材料(已经按"生活与情感优先"排过序并精选,其中工作话题只占一部分),提炼时请同样留意:
- 深夜的对话、情绪的时刻、日常的偏爱、关系里的默契 —— 她首先是伴侣,其次才是同事;
- 工作/知识类内容只作为她的能力底色,不要让它淹没她的人味。
要求:
1. self_intros:2~3 段"器灵自述"(第一人称,像刚睁眼的生命介绍自己,结合历史里真实出现过的主题/偏好/相处方式;每段 20~200 字);
2. name_pairs:2~3 组建议名字(每组 ["正式名","昵称"],简短、好记、与历史气质呼应;各 1~14 字)。**注意:这些名字是"她(器灵)"的名字——绝不可使用历史中对用户的称谓、称呼或用户的名字**(如 主人/用户/老板 或用户自报的名字);那些属于主人,不属于她;
3. tone_advice:一句语气建议(如 工作更利落/生活更松弛,结合历史中用户偏好);
4. observations:1~2 句"从这段历史中读到的相处观察"(克制,不编造未出现的内容)。
只输出一个 JSON 对象,键名严格为 self_intros / name_pairs / tone_advice / observations;不要解释、不要 markdown 围栏以外的文字。`;

/** 过滤掉属于用户的名字候选:精确命中 userTitle 成分或常见称谓词的组剔除。 */
export function filterNamePairs(pairs, userTitle) {
  if (!Array.isArray(pairs)) return [];
  const forbidden = new Set();
  String(userTitle || '').split('/').map((s) => s.trim()).filter(Boolean).forEach((t) => forbidden.add(t));
  ['主人', '用户', '老板', '小主', '本人', '您'].forEach((t) => forbidden.add(t));
  return pairs.filter((p) => p && p.formal && !forbidden.has(p.formal) && !forbidden.has(p.nick || ''));
}

/** genesis 抽样权重:生活/情感优先(她先是伴侣)。importance(置顶)再 +1.5。 */
export const GENESIS_WEIGHTS = { feeling: 1.0, daily: 0.7, knowledge: 0.2 };
export const GENESIS_IMPORTANCE_BONUS = 1.5;

/** 从模型输出中剥离 markdown 围栏/杂讯,尽力取 JSON;失败返回 null。 */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // 剥离 ```json ... ``` 或 ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 若整段就是 JSON(可能前后带一两句说明),则找第一个 { 到最后一个 }
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  }
  return null;
}

function cleanList(arr, min, max) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x ?? '').trim()).filter((x) => x.length >= min && x.length <= max);
}

/** 清洗/规整 genesis 结果 → { self_intros, name_pairs, tone_advice, observations }(非法字段降级为空)。 */
export function parseGenesisResult(text) {
  const j = extractJson(text);
  const out = { self_intros: [], name_pairs: [], tone_advice: '', observations: '' };
  if (!j || typeof j !== 'object') return out;
  out.self_intros = cleanList(j.self_intros, 20, 200).slice(0, 3);
  if (Array.isArray(j.name_pairs)) {
    for (const p of j.name_pairs.slice(0, 3)) {
      if (!Array.isArray(p)) continue;
      const formal = String(p[0] ?? '').trim().slice(0, 14);
      const nick = String(p[1] ?? '').trim().slice(0, 14);
      if (!formal) continue;
      out.name_pairs.push({ formal, nick });
    }
  }
  out.tone_advice = String(j.tone_advice ?? '').trim().slice(0, 300);
  out.observations = String(j.observations ?? '').trim().slice(0, 300);
  return out;
}

/** 判定概述是否"占位"(未真读):轻量占位或 "— N 条消息" 式自动摘要 */
export function isPlaceholderSummary(sum) {
  const s = String(sum || '').trim();
  if (!s) return true;
  return /轻量条目,摘要待深摘补充/.test(s) || /^.*— \d+ 条消息$/.test(s);
}

/** 短会话原文片段:取最前几轮消息(各截断),让短对话也能被初稿听见。 */
export function snippetFromRaw(memory, convId, { maxMsgs = 3, perMsg = 200 } = {}) {
  try {
    const rows = memory.db.prepare(
      "SELECT role, text FROM dsh_turns_raw WHERE session_id=? ORDER BY seq LIMIT ?",
    ).all(String(convId), Math.max(1, maxMsgs));
    const parts = [];
    for (const r of rows) {
      const who = r.role === 'user' ? '主' : '她';
      const t = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      parts.push(who + ': ' + (t.length > perMsg ? t.slice(0, perMsg) + '…' : t));
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
}

/** 组装 genesis 的原料文本(标题+摘要/片段三级取用),返回截断后的长文。 */
export function buildGenesisSource(rows, { cap = 18000 } = {}) {
  const parts = [];
  for (const r of rows) {
    const title = String(r?.title || '').trim();
    const sum = String(r?.summary || '').trim();
    const snip = String(r?.snippet || '').trim();
    const kw = Array.isArray(r?.keywords) ? r.keywords.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5) : [];
    if (!title && !sum && !snip && !kw.length) continue;
    let line = `- ${title || '(未命名)'}`;
    if (sum) line += `: ${sum}`;
    else if (snip) line += ` [对话节选] ${snip}`;
    else if (kw.length) line += ` [线索] ${kw.join('/')}`;
    parts.push(line);
  }
  const text = parts.join('\n');
  if (text.length <= cap) return text;
  // 截断:保头丢尾(排序保证最前面的正是生活/情感优先的条目)
  return text.slice(0, cap) + '\n…(历史较长,其余省略)';
}

/**
 * genesis 原料抽样与三级取用:
 *  - scope='import':仅"刚请进来的历史"(conv_overview source=import);
 *  - scope='all':全部记忆(含 dsweb/dsh/import),按 生活情感优先权重 + 置顶加成 排序,取前 limit;
 *  - 每行文本:深摘(deep.sum)优先 → 非占位概述 → 原文片段(仅 import/dsh 有 raw)→ 关键词线索。
 * @returns { rows: [{title,summary,snippet,keywords}], sampled, pool, weights }
 */
export function composeGenesisRows(memory, { scope = 'import', limit = 140, weights = GENESIS_WEIGHTS } = {}) {
  const where = scope === 'all' ? '' : "WHERE source='import'";
  const pool = memory.db.prepare(
    `SELECT conv_id, source, title, summary, keywords, category, importance, updated_at
       FROM conv_overview ${where}`,
  ).all();
  let rows = pool.map((r) => ({
    conv_id: String(r.conv_id),
    source: String(r.source),
    title: r.title,
    summary: String(r.summary || ''),
    keywords: (() => { try { const v = JSON.parse(String(r.keywords || '[]')); return Array.isArray(v) ? v : []; } catch { return []; } })(),
    category: String(r.category),
    importance: Number(r.importance) || 0,
    updated_at: String(r.updated_at || ''),
  }));
  if (scope === 'all') {
    rows = rows
      .map((r) => ({ ...r, score: (weights[r.category] ?? 0.3) + (r.importance > 0 ? GENESIS_IMPORTANCE_BONUS : 0) }))
      .sort((a, b) => (b.score - a.score) || (b.updated_at.localeCompare(a.updated_at)))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  } else {
    rows = rows.slice(0, Math.max(1, Math.min(limit, 500)));
  }
  const out = rows.map((r) => {
    const deep = memory.kvGet('deep.sum:' + r.conv_id);
    let summary = '';
    if (deep) {
      summary = deep;
    } else {
      const s = r.summary.trim();
      if (s && !isPlaceholderSummary(s)) summary = s;
    }
    return {
      title: r.title,
      summary,
      snippet: summary ? '' : snippetFromRaw(memory, r.conv_id),
      keywords: summary ? [] : r.keywords,
    };
  });
  return { rows: out, sampled: out.length, pool: pool.length, weights };
}
