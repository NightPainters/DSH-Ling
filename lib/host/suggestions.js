// dsh-ling host — 语料建议的采纳/忽略(人审;kind 决定写入哪个 persona 字段)
const KIND_NAMES = { aiName: '自称', userTitle: '称呼', hardrule: '惯例' };

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
    const cur = settings.get().persona?.hardRules || [];
    const next = cur.includes(value) ? cur : [...cur, value];
    patch.persona = { hardRules: next };
  } else {
    return { ok: false, reason: 'unknown-kind:' + row.kind };
  }
  await settings.update(patch);
  memory.setPersonaSuggestionStatus(Number(id), 'adopted');
  return { ok: true, id: Number(id), kind: row.kind, kindName: KIND_NAMES[row.kind] || row.kind, value, patch };
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
