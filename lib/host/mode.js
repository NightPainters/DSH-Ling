// dsh-ling host — mode service (D1/D2/D6): 模式只调「推理等级」。
//
// 语义(2026-09-12 变更):**模式切换不再修改模型选项**。
//   工作模式 = 推理等级 max;生活模式 = 推理等级 low;模型由用户自己在
//   DSH 左下角/右上角选择,插件原样保留、绝不改写。
//   平台 API 的硬约束:`sessionController.selectModel` 与
//   `agentDefaultModel.saveSelection` 都要求完整的 {provider, model}
//   (只有 reasoningEffort 是可选字段)→ 因此做法是「**先读当前选择,原样带回去,
//   只替换 reasoningEffort**」;读不到当前模型时**宁可不调用**,也不凭空指定模型。
import { svc } from './util.js';

export const KNOWN_MODES = ['work', 'life'];
export const MODE_LABEL = { work: '工作', life: '生活' };
/** 各模式的默认推理等级(可在 settings.mode.mapping.<mode>.effort 覆盖)。 */
export const MODE_EFFORT = { work: 'max', life: 'low' };
const EFFORTS = ['max', 'high', 'low', 'off'];

export function isEffort(v) {
  return EFFORTS.includes(v);
}

/** 解析模式的推理等级(唯一由模式决定的东西)。 */
export function resolveModeEffort(settings, modeKey) {
  const m = settings?.mode?.mapping?.[modeKey] || {};
  if (isEffort(m.effort)) return m.effort;
  return MODE_EFFORT[modeKey] || 'low';
}

/**
 * 兼容旧的调用形状:仍返回 `{ reasoningEffort }` ——
 * **不再返回 provider/model**(那是"改模型"的来源)。
 */
export function resolveModeConfig(settings, modeKey) {
  return { reasoningEffort: resolveModeEffort(settings, modeKey) };
}

/**
 * 读当前生效的模型选择,只取 provider/model 用于"原样带回"。
 * 读不到 → null(调用方据此放弃改档位,而不是替代用户选模型)。
 */
export function currentModelSelection(ctx) {
  const adm = svc(ctx, 'agentDefaultModel');
  const sel = adm && typeof adm.currentSelection === 'function' ? adm.currentSelection() : null;
  if (sel && sel.provider && sel.model) return { provider: String(sel.provider), model: String(sel.model) };
  return null;
}

async function doApply(ctx, memory, settings, sessionId, modeKey) {
  const reasoningEffort = resolveModeEffort(settings.get(), modeKey);
  const controller = svc(ctx, 'sessionController');
  let warning;
  if (controller && typeof controller.selectModel === 'function') {
    const keep = currentModelSelection(ctx); // 当前模型:原样带回,不改
    if (!keep) {
      warning = 'unknown-current-model; 推理等级未同步(拒绝替用户指定模型)';
      console.debug('[dsh-ling]', warning);
    } else {
      try {
        await controller.selectModel({
          sessionId,
          provider: keep.provider,
          model: keep.model,
          reasoningEffort,
        });
      } catch (e) {
        // 平台拒绝(模型不可用、busy 等):模式仍照常记录生效(UI/记忆语义先走),
        // 以 warning 返回,不把整个操作判失败。
        warning = 'selectModel failed: ' + String(e?.message ?? e);
        console.debug('[dsh-ling] selectModel warning', warning);
      }
    }
  } else {
    warning = 'no-sessionController; mode recorded only';
  }
  memory.setSessionMode(sessionId, modeKey);
  const s = await settings.update({ mode: { lastMode: modeKey } }); // D2 跟随
  return { ok: true, warning, sessionId, mode: modeKey, reasoningEffort, lastMode: s.mode.lastMode };
}

/**
 * Apply mode to a session (D4): running → queue (returns queued), idle → apply now.
 */
export async function applyModeToSession(ctx, gate, memory, settings, sessionId, modeKey) {
  if (!sessionId) return { ok: false, reason: 'no-session-id' };
  if (!KNOWN_MODES.includes(modeKey)) return { ok: false, reason: `unknown-mode:${modeKey}` };
  const queued = gate.enqueueIfRunning(sessionId, () => {
    doApply(ctx, memory, settings, sessionId, modeKey).catch((e) =>
      console.debug('[dsh-ling] queued mode apply failed', e),
    );
  });
  if (queued) return { ok: true, queued: true, running: true, sessionId, mode: modeKey };
  return await doApply(ctx, memory, settings, sessionId, modeKey);
}

/** Current mode for a session: session_meta → settings.lastMode. */
export function currentMode(memory, settings, sessionId) {
  const meta = sessionId ? memory.sessionMeta(sessionId) : null;
  if (meta && meta.mode && KNOWN_MODES.includes(meta.mode)) return meta.mode;
  const last = settings.get().mode?.lastMode;
  return KNOWN_MODES.includes(last) ? last : 'life';
}
