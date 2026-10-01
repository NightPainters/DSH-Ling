// dsh-ling host — 模式服务（P3-A，2026-09-29）：把「给某个会话设模式」做成跨插件能力。
//
// 为什么需要它：器灵的模式记录是**私有**的（memory.db 的 `session_meta.mode`），
// 而 memory / gate / settings 三个依赖只活在器灵自己的 apply 闭包里 —— 别的插件
// （如飞书桥 dsh-feishu-host）拿不到，于是「来自飞书的会话默认走生活挡位」一直做不到。
// 本模块把这个动作注册成 cordis 服务 `dsh-ling/mode`，调用方按**软依赖**取用：
//
//   const ling = ctx.get('dsh-ling/mode');            // 拿不到就是 undefined，不是错误
//   await ling?.applyMode(sessionId, 'life', { keepModel: { provider, model } });
//
// 契约（语义与 mode.js 一致，差别只在默认值）：
//   applyMode(sessionId, modeKey, opts) -> Promise<Result>
//     · **不改全局** `settings.mode.lastMode`
//       —— GUI 的 `applyModeToSession` 才改，那是「同时设为新会话默认」的语义；
//          跨插件调用若照做，会把飞书的挡位泄漏成桌面端的默认值。
//     · opts.keepModel    调用方自带的模型。**跨插件调用必须传** —— 不传就退回
//                         「读全局当前选择」，会把 GUI 正选着的模型覆盖到对方会话上。
//     · opts.syncEffort   默认 true（模式的实质就是推理等级）；false = 只记模式。
//     · **失败不抛**：以 `{ok:false, reason}` 返回。调用方不该因为器灵缺席/出错
//       而中断自己的流程。
//
// Result = { ok, mode, reasoningEffort, warning?, queued?, lastMode?, reason? }
import { KNOWN_MODES, applyModeToSession, currentMode } from './mode.js';

export const MODE_SERVICE_NAME = 'dsh-ling/mode';

/**
 * 把模式能力注册成服务。
 *
 * 用 `ctx.provide()` 而不是 `class extends Service`：本插件的 apply 是函数形态，
 * 且 dsh-ling 以 `file:` + Junction 加载、包内无 node_modules，`import '@deepseek-ai/cordis'`
 * 会走 realpath 回到**本包根目录**再向上找 —— 找不到。`ctx.provide` 是同一套
 * reflect 机制的上层入口，零 import、同样由 fiber 生命周期托管（返回 disposer）。
 *
 * @param {object} ctx    cordis 上下文（插件自己的）。
 * @param {object} deps   `{ gate, memory, settings }`，与 mode.js 同源。
 * @returns {() => void}  disposer（拆服务）。
 */
export function registerModeService(ctx, { gate, memory, settings }) {
  const api = {
    name: MODE_SERVICE_NAME,
    knownModes: KNOWN_MODES,

    /**
     * 给某个会话设模式。
     *
     * @param {string} sessionId 目标会话（飞书侧形如 `feishu-<uuid>`）。
     * @param {'work'|'life'} modeKey
     * @param {{keepModel?: {provider: string, model: string}, syncEffort?: boolean}} [opts]
     */
    async applyMode(sessionId, modeKey, opts = {}) {
      if (!sessionId) return { ok: false, reason: 'no-session-id' };
      if (!KNOWN_MODES.includes(modeKey)) return { ok: false, reason: `unknown-mode:${modeKey}` };
      try {
        return await applyModeToSession(ctx, gate, memory, settings, sessionId, modeKey, {
          setDefault: false, // 跨插件：只改这条会话，不动全局默认
          keepModel: opts.keepModel ?? null,
          syncEffort: opts.syncEffort !== false,
        });
      } catch (e) {
        return { ok: false, reason: 'throw:' + String(e?.message ?? e) };
      }
    },

    /** 读某个会话当前生效的模式（session_meta → lastMode → 'life'）。 */
    currentMode(sessionId) {
      try {
        return currentMode(memory, settings, sessionId);
      } catch {
        return 'life';
      }
    },
  };

  try {
    const dispose = ctx.provide(MODE_SERVICE_NAME, api);
    console.info('[dsh-ling] mode service provided: %s', MODE_SERVICE_NAME);
    return typeof dispose === 'function' ? dispose : () => {};
  } catch (e) {
    // 同名服务已被别的 fiber 占用（例如器灵被加载了两遍）：只记日志，不抛 ——
    // 器灵其余功能照常，不能因为一个可选能力注册失败就整插件起不来。
    console.debug('[dsh-ling] mode service provide failed', e);
    return () => {};
  }
}
