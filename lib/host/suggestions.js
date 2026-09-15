// dsh-ling host — 语料建议的采纳/忽略(人审;kind 决定写入哪个 persona 字段)
// 2026-09-15 起:hardrule 类建议是**她长出来的**东西 → 走「提议 → 确认」落到**习惯**(不再是规矩)。
import { proposeHabit, resolveHabit, habitsOf } from './rules.js';

const KIND_NAMES = { aiName: '自称', userTitle: '称呼', hardrule: '习惯' };

export async function applyCorpusSuggestion(memory, settings, id) {
  const row = memory.getPersonaSuggestion(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.status !== 'new') return { ok: false, reason: 'status:' + row.status };
  const value = String(row.value ?? '').trim();
  const patch = {};
  if (row.kind === 'aiName') {
    if (!value) return { ok: false, reason: 'empty-value' };
    patch.persona = { aiName: value };
  } else if (row.kind === 'userTitle') {
    if (!value) return { ok: false, reason: 'empty-value' };
    patch.persona = { userTitle: value };
  } else if (row.kind === 'hardrule') {
    if (!value) return { ok: false, reason: 'empty-value' };
    // 面板上按下"采纳"= 确认动作 → 提议后立即确认(习惯不可直达,但仍只能走这条状态机)
    const prop = await proposeHabit({ settings, habit: value, evidence: '语料提炼(面板采纳即确认)', byUser: true });
    if (prop.ok) {
      await resolveHabit({ settings, id: prop.id, action: 'confirm' });
    } else if (prop.reason !== 'already-habit' && prop.reason !== 'already-pending') {
      return { ok: false, reason: prop.reason };
    }
    patch.persona = {};
  } else {
    return { ok: false, reason: 'unknown-kind:' + row.kind };
  }
  await settings.update(patch);
  memory.setPersonaSuggestionStatus(Number(id), 'adopted');
  return { ok: true, id: Number(id), kind: row.kind, kindName: KIND_NAMES[row.kind] || row.kind, value, patch, habits: habitsOf(settings).length };
}

export function dismissCorpusSuggestion(memory, id) {
  const row = memory.getPersonaSuggestion(Number(id));
  if (!row) return { ok: false, reason: 'not-found' };
  memory.setPersonaSuggestionStatus(Number(id), 'dismissed');
  return { ok: true, id: Number(id) };
}

export function suggestionDisplay(row) {
  const kindName = KIND_NAMES[row?.kind] || row?.kind || '?';
  return { ...row, kindName };
}
