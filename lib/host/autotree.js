// dsh-ling host — 一键生成记忆树(D9-b,2026-09-20 与用户定案)。
//
// 主干 1593 条太粗,需要先把树"初步划一遍"。分两阶段:
//   ① 机械分段  —— 按时序相邻性把全库概述切成若干簇(零成本、确定、可复现);
//   ② 小助手命名 —— 每簇一次调用,起一个主题名(模型只做"命名"这一件语义活)。
//   ③ 主人审核后落库(apply 在 api.js 侧) —— 建枝/主脉 + 挂会话。
//
// 为什么不把 1593 条直接丢给模型:装不进上下文,而且"按时序切段"本就是机械活。
// 模型擅长的是"给一段对话起主题名",不是"在 1593 条里做聚类"(设计稿 §8 / 用户 2026-09-20)。
//
// 不变量:本模块**只读概述索引**、只产出候选,**从不改写任何记忆内容**。

export const AUTOTREE_SYS = [
  '你是记忆整理助手。用户会给你一组同期的对话标题(按时间先后排列)。',
  '请判断这组对话共同围绕的主题,并起一个简短的中文名字。',
  '要求:',
  '1) 名字 2~10 个字,是主题(如「工程力学」「记忆系统设计」「装修与工具」),不要用时间或"对话记录"这类空话;',
  '2) 若这组对话主题分散、看不出共同主题,名字就写「零散记录」;',
  '3) 只输出一行,格式:名字|一句话说明',
  '不要输出任何其他内容。',
].join('\n');

const DAY = 86400000;

/** 宽松时间解析(取不到记 0 —— 0 视为"无时间",不参与间隔切分)。 */
export function tsOf(s) {
  const t = Date.parse(String(s || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 机械分段:先按源分组,组内按时序排序,相邻间隔 > gapDays(或单簇超过 maxSize)即切一刀。
 * 返回 [{ id, source, count, from, to, items:[{source,convId,title,at,ts,hasSummary}] }]。
 * ⚠️ 时间缺失(ts=0)的条目不会触发切分,只受 maxSize 约束 —— 避免"无时间"被误当成"间隔巨大"。
 */
export function bucketize(rows, { gapDays = 14, maxSize = 40 } = {}) {
  const bySource = new Map();
  for (const r of rows || []) {
    const src = String((r && r.source) || '');
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push({
      source: src,
      convId: String((r && r.convId) || ''),
      title: String((r && r.title) || ''),
      at: String((r && r.at) || ''),
      ts: tsOf(r && r.at),
      hasSummary: !!(r && r.hasSummary),
    });
  }
  const gap = Math.max(1, Number(gapDays) || 14) * DAY;
  const cap = Math.max(5, Math.min(200, Number(maxSize) || 40));
  const out = [];
  for (const [src, list] of bySource) {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.convId.localeCompare(b.convId));
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({
        id: 'bk:' + src + ':' + out.length,
        source: src,
        count: cur.length,
        from: cur[0].at,
        to: cur[cur.length - 1].at,
        items: cur,
      });
      cur = [];
    };
    for (const it of list) {
      const prev = cur[cur.length - 1];
      if (prev && it.ts && prev.ts && it.ts - prev.ts > gap) flush();
      else if (cur.length >= cap) flush();
      cur.push(it);
    }
    flush();
  }
  return out;
}

/** 把一簇压成给模型看的标题清单(只给标题,不给摘要 —— 省 token 且够用)。 */
export function bucketDigest(bucket, { maxTitles = 40 } = {}) {
  const items = (bucket && bucket.items) || [];
  return items
    .slice(0, Math.max(1, Number(maxTitles) || 40))
    .map((it) => '- ' + (it.title || it.convId))
    .join('\n');
}

/** 解析模型输出的一行「名字|说明」。宽容:去掉前缀符号/引号/编号。 */
export function parseName(text) {
  const first = String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';
  const clean = first.replace(/^[#*\-•\d.、\s]+/, '').trim();
  if (!clean) return { name: '', note: '' };
  const parts = clean.split(/[|｜]/);
  const name = String(parts[0] || '').replace(/[「」"']/g, '').trim().slice(0, 30);
  const note = String(parts.slice(1).join(' ') || '').trim().slice(0, 120);
  return { name, note };
}

/**
 * 给一簇起名。call 注入 summarizeWithRetry(便于测试与替换)。
 * 返回 { ok, name, note, ms } 或 { ok:false, error }。
 */
export async function nameBucket(baseUrl, model, bucket, { maxTokens = 512, timeoutMs = 90000, call = null } = {}) {
  if (typeof call !== 'function') return { ok: false, error: 'no-call' };
  const digest = bucketDigest(bucket);
  if (!digest) return { ok: false, error: 'empty-bucket' };
  const text = '来源:' + String((bucket && bucket.source) || '') + '\n'
    + '时间:' + String((bucket && bucket.from) || '?') + ' ~ ' + String((bucket && bucket.to) || '?') + '\n'
    + '共 ' + Number((bucket && bucket.count) || 0) + ' 条,标题如下:\n' + digest;
  const r = await call(baseUrl, model, { text, system: AUTOTREE_SYS, maxTokens, timeoutMs });
  if (!r || !r.ok) return { ok: false, error: String((r && r.error) || 'failed') };
  const { name, note } = parseName(r.summary);
  if (!name) return { ok: false, error: 'empty-name' };
  return { ok: true, name, note, ms: Number(r.ms || 0) };
}

/** 把若干命名结果合并成"应用计划"的默认形态(每簇一枝,挂在指定父下)。 */
export function planFromNamed(named, { parentId = 'trunk' } = {}) {
  return (named || [])
    .filter((n) => n && n.ok && n.bucketId)
    .map((n) => ({
      bucketId: String(n.bucketId),
      mode: 'branch',
      name: String(n.name || ''),
      parentId: String(parentId || 'trunk'),
      note: String(n.note || ''),
    }));
}
