// dsh-ling host — mode service (D1/D2/D6): map mode → model config and apply
// via ctx.sessionController.selectModel (platform-native, REPORT-03).
import { svc } from './util.js';

export const KNOWN_MODES = ['work', 'life'];
export const MODE_LABEL = { work: '工作', life: '生活' };

export function resolveModeConfig(settings, modeKey) {
  const m = settings?.mode?.mapping?.[modeKey] || {};
  const provider = m.provider || 'deepseek-official';
  const model = m.model || 'deepseek-v4-flash';
  const effort = ['max', 'high', 'low', 'off'].includes(m.effort) ? m.effort : 'low';
  return { provider, model, reasoningEffort: effort };
}

async function doApply(ctx, memory, settings, sessionId, modeKey) {
  const cfg = resolveModeConfig(settings.get(), modeKey);
  const controller = svc(ctx, 'sessionController');
  let warning;
  if (controller && typeof controller.selectModel === 'function') {
    try {
      await controller.selectModel({
        sessionId,
        provider: cfg.provider,
        model: cfg.model,
        reasoningEffort: cfg.reasoningEffort,
      });
    } catch (e) {
      // 平台拒绝(provider/模型不可用、busy 等):模式仍照常记录生效(UI/记忆语义先走),
      // 以 warning 返回,不把整个操作判失败。
      warning = 'selectModel failed: ' + String(e?.message ?? e);
      console.debug('[dsh-ling] selectModel warning', warning);
    }
  } else {
    warning = 'no-sessionController; mode recorded only';
  }
  memory.setSessionMode(sessionId, modeKey);
  const s = await settings.update({ mode: { lastMode: modeKey } }); // D2 跟随
  return { ok: true, warning, sessionId, mode: modeKey, lastMode: s.mode.lastMode };
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
