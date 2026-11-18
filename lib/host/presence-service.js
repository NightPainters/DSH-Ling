// dsh-ling host — 对外变更通知服务 `dsh-ling/presence`(P4,2026-11-11)。
//
// 一句话(HANDOFF §0):器灵把所有「自己身上发生的变更」用一个**极窄的只读接口**说出来;
// 要不要因此打断主人,由别人去判断 —— 本服务**不给拦截权**、**不暴露内容**、**不暴露内部对象**、
// v1 **不做 ack**。
//
// 取用是软依赖(MF6;版本主张已在 P4C 2026-11-11 改成**可复核的当前宿主事实**,不再拿旧版本号背书):
//   本机当前宿主 `<DSH_PORTABLE>/portable/app/node_modules/@deepseek-ai/cordis/lib/index.js:763`
//   (该包 version = 4.0.5,落在本仓 peer `>=4.0.4` 范围内):
//     get(name, strict = true) { return getTraceable(this.ctx, this._getImpl(name, strict)?.value); }
//   `_getImpl` 对未 provide 的服务 `if (!impl) return;` ⇒ 缺失时 `?.value` 得 `undefined`,
//   `getTraceable` 对非对象原样返回 ⇒ 该宿主**返回 undefined,不抛**。
// ⚠️ 但这不是"所有宿主都如此"的保证:ctx.get 的行为由宿主实现决定,**别的宿主 / 别的版本可能抛**
//    (例如"服务缺失即报错"的实现)。所以消费方义务不变 —— **必须 try/catch**,把"拿不到"与
//    "拿的时候炸了"都归一成 undefined(本仓 `util.js` 的 `svc()` 就是这一层):
//   let presence; try { presence = ctx.get('dsh-ling/presence'); } catch { presence = undefined; }
//   if (presence) { presence.watch((c) => { /* 同步,别做长活 */ }); }
//   提供方这边 `ctx.provide` 的失败路径同理不冒泡(见本文件末尾的 catch)。
//
// 三个方法(公开面就这三个,一个都不多 —— 最窄接口是 HANDOFF §1 的结论):
//   state()              -> { ok, at, bootAt, enabled, pending: { sessions, global }, lastChange }
//                            · bootAt = 器灵**本次加载**时刻(每次 registerPresenceService 刷新,N1)
//                            · pending.sessions = 挂着的**会话数**(只数 `s:` 槽)
//                            · pending.global   = 有没有"影响所有会话"的变更还没投递(0/1)
//                            口径见 `docs/PRESENCE-CONTRACT-ADDENDUM.md`(只增键,不改旧字段语义)
//   watch(fn)            -> 退订函数(幂等);回调同步;坏监听不拖累;未启用仍可调用、只是不触发
//   recent({since,limit})-> Change[],时间正序,环形缓冲 bufferSize 条(默认 200),不分页
//
// 形态照抄 `mode-service.js`(HANDOFF §2 明确"不要重新论证"):
//   · 用 `ctx.provide()` 而不是 `class extends Service` —— 本插件 apply 是函数形态,且以
//     `file:` + Junction 加载、包内无 node_modules,`import '@deepseek-ai/cordis'` 会走 realpath
//     回到本包根目录再向上找 ⇒ 找不到。`ctx.provide` 零 import、由 fiber 生命周期托管;
//   · 服务名已被占用时**只记日志、不抛**(mode-service.js:79-84)—— 器灵被加载两遍不该导致
//     整个插件起不来。第二份实例照样能用(总线是模块级单实例,见 presence-bus.js),只是消费方
//     看不到它。
import {
  configurePresence,
  presenceSnapshot,
  recentChanges,
  refreshPresenceBootAt,
  watchPresence,
} from './presence-bus.js';

export const PRESENCE_SERVICE_NAME = 'dsh-ling/presence';

/**
 * 注册 presence 服务。
 *
 * @param {object} ctx    cordis 上下文(插件自己的)。
 * @param {object} deps
 *   · `config`:插件配置 `cfg.presence`(cordis.yml 可改:`enabled` / `bufferSize`)。
 *     默认值写在 `lib/host/config.js` 的 schema 里,**本文件不写 200 字面量**(红线)。
 *   · `memory` / `settings`:保留位(与 HANDOFF §6-2 的签名同形)。v1 的三个方法都不需要直接读
 *     它们 —— 变更由写点经总线推送;给出去等于把 db 表结构变成公开契约(HANDOFF §5-3)。
 * @returns {() => void} disposer(拆服务 + 卸掉本实例的订阅)
 */
export function registerPresenceService(ctx, { memory, settings, config } = {}) {
  // 配置先落地(失败也只当默认值,不抛)
  configurePresence(config || {});
  // N1:`bootAt` = **器灵本次加载时刻**。模块首 import 时算的那一次不算数 —— 热重载 / 同进程
  // 二次注册 / 测试复位后重建,都必须刷成本次注册的时刻(契约 §3.2 的字面语义)。永不抛。
  refreshPresenceBootAt();

  let disposed = false;
  const offs = new Set();

  const api = {
    /** 只读状态快照。失败也返回对象,不抛。 */
    state() {
      if (disposed) return { ok: false, reason: 'closed' };
      return presenceSnapshot();
    },

    /**
     * 订阅变更。返回退订函数(幂等)。
     * @param {(change: object) => void} fn
     */
    watch(fn) {
      if (disposed || typeof fn !== 'function') return () => {};
      const off = watchPresence((change) => {
        if (disposed) return; // 拆卸后不再回调(总线里可能还有别的实例的监听,不能靠它兜)
        fn(change);
      });
      let offed = false;
      const wrapped = () => {
        if (offed) return;
        offed = true;
        try { off(); } catch { /* 退订失败不影响其余监听 */ }
        offs.delete(wrapped);
      };
      offs.add(wrapped);
      return wrapped;
    },

    /**
     * 补看漏掉的变更(时间正序、有界)。
     * @param {{since?: string, limit?: number}} [opts]
     */
    recent(opts) {
      if (disposed) return [];
      return recentChanges(opts || {});
    },
  };

  const shutdown = () => {
    disposed = true;
    for (const off of [...offs]) {
      try { off(); } catch { /* 尽量都卸掉 */ }
    }
    offs.clear();
  };

  try {
    const dispose = ctx.provide(PRESENCE_SERVICE_NAME, api);
    console.info('[dsh-ling] presence service provided: %s', PRESENCE_SERVICE_NAME);
    return () => {
      shutdown();
      try { if (typeof dispose === 'function') dispose(); } catch { /* 已拆过 */ }
    };
  } catch (e) {
    // 同名服务已被别的 fiber 占用(器灵被加载了两遍):只记日志,不抛。
    console.debug('[dsh-ling] presence service provide failed', e);
    return () => { shutdown(); };
  }
}
