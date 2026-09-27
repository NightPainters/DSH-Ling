// dsh-ling host — per-session memory snapshot builder (DESIGN §4.3).
// A snapshot = stable text frozen per session for KV-cache stability:
//   L0 persona (identity + mode style) + L1 opener selection (mode weighted).
// Also hosts message-text helpers for the durable event record shape:
//   { type, seq, time(ms), data: { content?|message:{content}, source? } }
import { assemblePersona } from './persona.js';
import { selectL1, formatL1Section } from './l1.js';
import { currentMode } from './mode.js';
import { neutralizeMustache } from './util.js';

// §4「超量折叠成一行」的那行计数(由 `memory.js` 的 branchLogDigest 在明细之后 push 进 `lines`)
// —— 它是**汇总**,不是明细。零明细时它撑不起整段(见下方渲染判据);有明细时照旧显示。
// 判据只用开头:明细行一律以主语(主人/器灵)或动作词开头,不会长成 `…另有 N 笔改动`。
// 若哪天 memory.js 改了措辞,这里退化成"照旧渲染"(fail-open)—— 只影响占不占地方,不吞明细。
const BRANCH_LOG_FOLD_LINE = /^…另有 \d+ 笔改动/;

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
      sessionId, // D9-a 血缘加权:当前会话所属枝决定各枝记忆的档位(同枝 1.0/祖先 0.7/旁系 0.4)
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
  // 注入感知(D9-b,2026-09-22):主人对记忆树做的**结构改动**,让器灵在下一次开口前就看到
  // "树变了" —— 这是复盘时"互相纠正"能成立的前提(不需要推送:复盘对话密集,
  // 每说一句就注入一次 ⇒ 感知延迟只有一轮,体感即实时)。
  // 只报**没见过的**改动(水位 = branch_log 自增 id),否则每轮重复注入同一批。
  // ── B3(1.5.2):水位从"一条按会话"变成**三条并存**,判定都在 `branchLogDigest` 里 ──
  //   · `branch_log_wm.<sessionId>` 本会话已看到哪(照旧,B#9);
  //   · `branch_log_wm.announced`   **全局**"已示人"边界 ⇒ 新会话不再重播已播过的(B3-1);
  //   · `branch_log_wm.retired`     **全局**超窗"计数式处置"边界(§2 老改动只计数不展开)。
  // 取数改成 FIFO(水位之上最早的一批),水位才可能停在未示人的内容之前(B3-2)。
  // B#9(2026-09-22 审计):**渲染不消费水位** —— 这里只读、不写。
  // buildSnapshotText 也会被"只重建、未开口"的路径调用(invalidateSession / refreshIdleSnapshot),
  // 在那里推进水位会把主人刚改的东西标记成已读,等到真正注入时反而看不到。
  // 推进由 inject.js 在真正要开口时做(它同时管 `.last` 与 §3 的开关)。
  let logMaxId = 0;
  let logShownMaxId = 0;
  let logRetiredMaxId = 0;
  try {
    if (typeof memory.branchLogDigest === 'function') {
      const wmk = 'branch_log_wm.' + String(sessionId || '');
      const prev = Number(memory.kvGet(wmk) || 0);
      // `now` 必须透传(B3):时间窗(§2)与水位推进要用**同一个时钟**,否则测试不可复现,
      // 生产上也会出现"按渲染时刻算过期、按投递时刻推进"的错位。
      const d = memory.branchLogDigest({ limit: 5, afterId: prev, now });
      // 全表最大 id:与开关、与是否成文**都无关**。它是 `branch_log_wm.last`(复盘退出判据)
      // 的输入 —— 关掉播报也不能让"欠交代"这笔账停摆(见 inject.advanceLogWatermark 注解)。
      logMaxId = Number(d?.maxId) || 0;
      // 真正示人的边界:只有真渲染了明细行时才非零。旧实现/打桩没有该字段 ⇒ 退回 maxId
      // (兼容 mustache 套里 `{lines, maxId:9}` 那种形状)。
      const shown = Number(d?.shownMaxId);
      logShownMaxId = Number.isFinite(shown) ? Math.max(0, shown) : logMaxId;
      logRetiredMaxId = Number(d?.retiredMaxId) || 0;
      // ── 明细 0 条 ⇒ **整段不渲染**(主人拍板,2026-09-27)──────────────────────────
      // 判据是"有没有**明细**行",不是"`lines` 非空":那行「…另有 N 笔改动」**也装在 `lines` 里**
      // (memory.js:1190 附近在明细之后 push),所以只判 `lines.length` 时"零明细"照样成文 ——
      // 注入面就只剩一行不放内容的计数(主人截图:395 笔改动、一条明细也没有)。
      // 只改**渲染**:三个水位字段照旧原样返回(下方 return),`.last` / `announced` / `retired`
      // 的推进与改前逐值相同 —— 不渲染 ≠ 把那批改动标成已读(它们仍在有效下界 `wm` 之上,
      // 下一轮照样进候选;与 §3 开关"只管渲染、不管交代记账"同一取向)。
      const logLines = Array.isArray(d?.lines) ? d.lines : [];
      const logDetailLines = logLines.filter((x) => !BRANCH_LOG_FOLD_LINE.test(String(x)));
      // §3 独立开关:只管**树改动播报**(总闸仍是 cordis 层的 cfg.injectEnabled)。
      // 关掉时:不成文、也不推进"已示人/已处置"水位(否则关着关着就把一段内容标成已读 ⇒
      // 再打开时那段内容永远看不到)。`.last` 照走 —— 它是复盘退出判据,不是"已示人"判据:
      // **开关只管"渲染",不管"交代记账"**(停推进会卡死复盘模式的退出,回归见 tree 套 9-5)。
      if (s.memory?.branchLogEnabled !== false && logDetailLines.length) {
        // A-03 / D-S03(1.5.1 红蓝对抗):段首此前**写死**「主人刚改动了记忆树」,而 schema v12 起
        // 每一行都已带主语(`branchLogDigest` 按 actor 分流成「主人」/「器灵」)⇒ 器灵经工具
        // 改的树,在它**下一轮的系统提示**里被读成"主人刚改动",与 tools.js 的设计意图正相反。
        // 段首改中性措辞,**主语交给每一行** —— 谁改的由行内说,不由段头替它说。
        parts.push(['【记忆树有改动】', ...logLines.map((x) => '- ' + x)].join('\n'));
      }
    }
  } catch { /* 感知失败不影响注入 */ }
  // 注入面出口 ①(快照侧,2026-09-18):L0 人格 + L1 记忆在这里成文。宿主 renderPrompt
  // 无 try/catch,未注册的 `{{名字}}` 会让该会话每一步都失败 ⇒ 成文即中和(幂等)。
  // 时间锚不经此处,由 inject.js 的最终出口兜底。
  const text = neutralizeMustache(parts.join('\n\n'));
  return {
    text,
    mode,
    // B#9:本段文本渲染到了哪条 branch_log(inject.js 在真正注入时据此推进水位)。
    // B3(1.5.2)拆成三个,别混用:
    //   logMaxId       全表最大 id   ⇒ `.last`(复盘退出判据)
    //   logShownMaxId  真正示人的边界 ⇒ 会话水位 + `announced`
    //   logRetiredMaxId 超窗只计数的边界 ⇒ `retired`
    logMaxId,
    logShownMaxId,
    logRetiredMaxId,
    builtAt: new Date(now).toISOString(),
    personaVersion: snapshotVersion(s),
    memoryVersion: memory.kvGet('memory_version') || '0',
  };
}

export function snapshotVersion(s) {
  const p = s?.persona || {};
  return [p.userTitle, p.aiName, p.aiTitle, p.tone, p.toneWork, p.toneLife, p.language, p.extraLore, p.duty, p.enabled, JSON.stringify(p.hardRules), JSON.stringify(p.bottomLines), p.sealed, s?.mode?.lastMode]
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
