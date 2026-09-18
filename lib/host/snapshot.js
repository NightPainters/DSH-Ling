// dsh-ling host — per-session memory snapshot builder (DESIGN §4.3).
// A snapshot = stable text frozen per session for KV-cache stability:
//   L0 persona (identity + mode style) + L1 opener selection (mode weighted).
// Also hosts message-text helpers for the durable event record shape:
//   { type, seq, time(ms), data: { content?|message:{content}, source? } }
import { assemblePersona } from './persona.js';
import { selectL1, formatL1Section } from './l1.js';
import { currentMode } from './mode.js';
import { neutralizeMustache } from './util.js';

export function buildSnapshotText(ctx, memory, settings, sessionId, { keywords = [], now = Date.now(), bumpHits = false } = {}) {
  const s = settings.get();
  const personaEnabled = s.persona?.enabled !== false;
  const mode = currentMode(memory, settings, sessionId);
  const parts = [];
  if (personaEnabled) {
    const l0 = assemblePersona(s, mode);
    if (l0) parts.push(l0);
  }
  if (personaEnabled && s.memory?.l1Enabled !== false && memory.listOverviews({ onlyOk: true }).length > 0) {
    const cfg = s.memory || {};
    const result = selectL1(memory, {
      mode,
      keywords: keywords || [],
      categoryWeights: cfg.categoryWeights,
      maxItems: cfg.l1MaxItems,
      maxLineChars: cfg.l1MaxLineChars,
      summaryChars: cfg.l1SummaryChars,
      summaryBonus: cfg.summaryBonus,
      budgetChars: Math.max(200, Math.round((cfg.l1BudgetTokens ?? 1200) * 1.4)), // 中文≈1.4字/token 保守
    });
    // 命中记录(2026-09-16):只有**首次定稿**传 bumpHits,重建/空闲刷新不重复计 ——
    // 否则《会话变长 → 反复刷新》会把同一批记忆的 hit_count 刷高,把热度算歪。
    if (bumpHits && Array.isArray(result.items) && result.items.length) {
      try {
        for (const it of result.items) memory.bumpHit(it.source, it.conv_id);
      } catch { /* 记不上不影响注入 */ }
    }
    const l1 = formatL1Section(result);
    if (l1) parts.push(l1);
  }
  // 注入面出口 ①(快照侧,2026-09-18):L0 人格 + L1 记忆在这里成文。宿主 renderPrompt
  // 无 try/catch,未注册的 `{{名字}}` 会让该会话每一步都失败 ⇒ 成文即中和(幂等)。
  // 时间锚不经此处,由 inject.js 的最终出口兜底。
  const text = neutralizeMustache(parts.join('\n\n'));
  return {
    text,
    mode,
    builtAt: new Date(now).toISOString(),
    personaVersion: snapshotVersion(s),
    memoryVersion: memory.kvGet('memory_version') || '0',
  };
}

export function snapshotVersion(s) {
  const p = s?.persona || {};
  return [p.userTitle, p.aiName, p.aiTitle, p.tone, p.toneWork, p.toneLife, p.language, p.extraLore, p.enabled, JSON.stringify(p.hardRules), JSON.stringify(p.bottomLines), p.sealed, s?.mode?.lastMode]
    .join('|');
}

/** source.kind of a durable message event (user/plugin/skill-catalog/goal/…) */
export function messageSourceKind(event) {
  const d = event?.data ?? event?.payload ?? event;
  if (d?.source && typeof d.source === 'object') return d.source.kind ?? null;
  if (d?.sourceKind) return d.sourceKind;
  return null;
}

const SKIP_BLOCK_TYPES = new Set(['reasoning', 'tool-call', 'tool-result', 'refusal', 'image', 'file']);

function blockText(b) {
  if (typeof b === 'string') return b;
  if (!b || typeof b !== 'object') return '';
  const t = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : '';
  return t || '';
}

function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const out = [];
  for (const b of blocks) {
    if (b && typeof b === 'object' && SKIP_BLOCK_TYPES.has(b.type)) continue;
    const t = blockText(b);
    if (t) out.push(t);
  }
  return out.join('\n');
}

/** Visible text of a durable user/assistant message event (real record shape). */
export function extractMessageText(event) {
  const d = event?.data ?? event?.payload ?? event;
  if (!d || typeof d !== 'object') return '';
  if (typeof d.content === 'string') return d.content;
  if (Array.isArray(d.content)) return blocksToText(d.content);
  const m = d?.message;
  if (m && typeof m === 'object') {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return blocksToText(m.content);
  }
  return extractText(event);
}

/** 真人首条消息(排除 plugin/skill-catalog 注入),供 L1 关键词。 */
export function firstUserText(agent) {
  try {
    const session = agent?.session;
    if (!session || typeof session.snapshotEvents !== 'function') return '';
    const events = session.snapshotEvents();
    for (const ev of events || []) {
      if (ev?.type === 'user/message' && messageSourceKind(ev) === 'user') {
        return extractMessageText(ev);
      }
    }
  } catch {
    return '';
  }
  return '';
}

/** Legacy generic extractor (first text/content found anywhere). */
export function extractText(event) {
  const p = event?.payload || event;
  const msg = p?.message && typeof p.message === 'object' ? p.message : null;
  const content = p?.content ?? p?.text ?? (msg ? (msg.content ?? msg.text) : undefined);
  return contentOf(content);
}

function contentOf(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v.map((b) => contentOf(b)).filter(Boolean).join('\n');
  }
  if (v && typeof v === 'object') {
    for (const k of ['text', 'content']) {
      const c = contentOf(v[k]);
      if (c) return c;
    }
  }
  return '';
}
