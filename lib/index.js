// dsh-ling host entry (cordis plugin): name/inject/apply named exports.
// Skeleton wiring: settings file, sqlite memory, freeze gate, system-prompt
// injection, lifecycle listeners, loopback HTTP gateway.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { svc, pick, ensureDir, defaultDataDir, utcIso } from './host/util.js';
import { SettingsFile } from './host/settings-file.js';
import { MemoryStore } from './host/memory.js';
import { FreezeGate } from './host/freeze.js';
import { registerMemorySection } from './host/inject.js';
import { wireSessionLine } from './host/session-line.js';
import { wireLifecycle } from './host/lifecycle.js';
import { registerModeService } from './host/mode-service.js';
import { registerApi } from './host/api.js';
import { summarizeDsh } from './host/summarizer.js';
import { registerFeedbackListener } from './host/feedback.js';
import { probeLLM, runDeepPass, DEEP_CFG } from './host/deepsummary.js';
import { registerLingTools } from './host/tools.js';
import { registerClockSkill } from './host/clock-skill.js';
import { registerIndexSkill } from './host/deep-index-skill.js'; // 1.6 步 6:深层库索引层(一簇一行,走 skill)
import { installAccessLog } from './audit/index.js';

export const name = 'dsh-ling';
export const inject = [];

/** 版本号单一来源 = package.json(读不到就退回未知,不影响运行)。 */
function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...config, version: readVersion() };
  const dataDir = cfg.dataDir || config.dataDir || defaultDataDir();
  ensureDir(dataDir);

  const settings = new SettingsFile(dataDir);
  // ⚠️ F4(蓝队 2026-10-04 实测 + 主人 2026-10-04 拍板「按错误码分流」):这里此前**没有 try** ⇒
  //   只要构造抛(典型:另一个进程持写锁 —— 升级形态实测 16,445ms 后抛 `database is locked`),
  //   异常就一路冒到 `apply()` ⇒ **8 个工具全不在、人格注入也没了**,而且**没有任何可指认面**。
  //   那是 **fail-dead** 不是 fail-closed(本项目对 fail-closed 的定义 = 拒绝 + 给判据,见 B-05)。
  //   分流规则:
  //     · errcode **5 / 6**(BUSY / LOCKED)= "等一会儿就能开" ⇒ 同步有界重试 3 次 × 2 秒;
  //     · **其余**(8 READONLY / 11 CORRUPT / 打不开文件…)= "真的打不开" ⇒ **不重试**,直接降级;
  //   仍失败 ⇒ **降级加载**:本插件不注册任何东西(别的插件不受影响),并留一条**可执行**的 error。
  const sleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 退化:不睡 */ }
  };
  const isLockErr = (e) => Number(e?.errcode ?? e?.code ?? -1) === 5 || Number(e?.errcode ?? -1) === 6
    || /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(e?.message ?? e));
  let memory = null;
  let memoryErr = null;
  for (let attempt = 0; attempt < 3 && !memory; attempt += 1) {
    try {
      memory = new MemoryStore(join(dataDir, 'memory.db'));
    } catch (e) {
      memoryErr = e;
      if (!isLockErr(e)) break;          // 非锁类:立即放弃重试(照旧"真的打不开")
      if (attempt < 2) sleepSync(2000);
    }
  }
  if (!memory) {
    const dbFile = join(dataDir, 'memory.db');
    console.error('[dsh-ling] 记忆库打不开,**本次以降级形态加载**(记忆 / 人格注入 / 器灵工具面全部不可用;'
      + '其余插件不受影响)。原因:' + String(memoryErr?.message ?? memoryErr).slice(0, 300)
      + '\n  怎么排查:① 多半是别的进程正持写锁 —— 等几秒后重载宿主;'
      + '② 确认 ' + dbFile + ' 没被只读挂载或被独占;'
      + '③ 若文件损坏,先从 ' + dataDir + ' 下的备份恢复。');
    return;
  }
  // invalidate 延迟绑定(避免环):onFlush 在事件时点才调用,彼时必已就绪
  let invalidateNow = (sid) => {};
  import('./host/inject.js').then((m) => {
    invalidateNow = (sid) => m.invalidateSession(gate, memory, settings, sid);
  }).catch((e) => console.debug('[dsh-ling] lazy inject import failed', e));
  const gate = new FreezeGate({
    onFlush: (sessionId, state) => {
      // running→idle 边界:先执行已入队 op,再清 stale 快照(若有人格/记忆变更待重建)
      if (state && state.snapStale && !state.running) {
        try {
          invalidateNow(sessionId);
        } catch (e) {
          console.debug('[dsh-ling] stale snapshot rebuild failed', e);
        }
      }
    },
  });

  const disposers = [];
  disposers.push(registerMemorySection(ctx, gate, memory, settings));
  // E0「那一行跟着会话走」:只加一个 agent/pre-step 监听(全库目前没有别处用它)。
  // 形态 A —— 只往 `decision.messages` 追加,**不碰** systemPrompt 的 section()/context(),
  // 也绝不调用带 surfaceOp 的 session.append。关掉开关:settings.memory.sessionProgressLine=false。
  disposers.push(wireSessionLine(ctx, memory, settings, cfg.sessionLine || {}));
  disposers.push(wireLifecycle(ctx, gate, memory, settings, cfg));
  // P3-A(2026-09-29):把「给某个会话设模式」暴露成跨插件服务 `dsh-ling/mode` ——
  // 飞书桥建线时用它把新会话钉到生活挡位。软能力:注册失败只记日志,不影响其余功能。
  disposers.push(registerModeService(ctx, { gate, memory, settings }));
  disposers.push(registerApi(ctx, { gate, memory, settings }, cfg));
  // E4 可取证访问日志:只挂两个全局钩子,core 侧补丁留的调用点见 lib/audit/patch-spec.js。
  // 补丁未打时钩子收不到调用 —— 安装器会在启动日志里明确喊出来,不允许静默不记。
  disposers.push(installAccessLog(ctx, cfg.accessLog || {}));
  // clock skill(精确时间按需查询,2026-09-23 尝生定):取服务走与 tools 同款的三级兜底。
  disposers.push(...registerClockSkill(ctx));
  // 深层库索引层 skill(1.6 步 6,2026-10-04):主人拍过「索引层 ≤400 字 · 一簇一行」,
  //   承载形态选定为**整个索引层一个 skill** —— 目录只常驻 name + description(11 行簇目录),
  //   正文按需展开;而 skill 目录按 sha256 比对、**内容不变就不重发** ⇒ 前缀稳定是白拿的。
  //   ⚠️ 不要拆成"每簇一个 skill":实测边际成本 ≈205 字/条,11 簇会把常驻目录面撑爆,
  //   而那个池子正是工具面压缩要抢的同一个。
  disposers.push(...registerIndexSkill(ctx));
  // 会话内工具(规矩直达 / 习惯提议):拿不到 tools 服务就退化为"只能用面板",绝不抛错。
  // 取服务用三级兜底(与 webServer 同一套路):直取 → ctx.inject 子 ctx → 定时重试。
  // 2026-09-16 教训:本插件 apply 可能早于 tools 服务挂载,一次性直取会静默失败 —— 工具从未注册。
  let toolsMounted = false;
  const mountTools = (c) => {
    if (toolsMounted) return { ok: true };
    try {
      const tr = registerLingTools(c || ctx, { gate, memory, settings });
      if (tr && tr.ok) {
        toolsMounted = true;
        if (Array.isArray(tr.disposers)) disposers.push(...tr.disposers);
        console.info('[dsh-ling] tools registered: %d', tr.disposers?.length ?? 0);
      }
      return tr || { ok: false, reason: 'unknown' };
    } catch (e) {
      console.debug('[dsh-ling] tools registration failed', e);
      return { ok: false, reason: 'throw' };
    }
  };
  const firstMount = mountTools(ctx);
  if (!firstMount.ok) {
    try {
      ctx.inject?.(['tools'], (child) => mountTools(child));
    } catch (e) {
      console.debug('[dsh-ling] ctx.inject tools failed', e);
    }
    let toolTries = 0;
    const toolTimer = setInterval(() => {
      toolTries += 1;
      if (toolsMounted || toolTries >= 20) { clearInterval(toolTimer); return; }
      mountTools(ctx);
    }, 1500);
    disposers.push(() => clearInterval(toolTimer));
    console.info('[dsh-ling] tools service not ready at apply (%s); retrying', firstMount.reason);
  }
  // 器灵侧工具 · agent 作用域补注册(2026-09-25 修)。
  //
  // 症状:工具"注册成功"(kv tools.registered=1、disposers 非空)但 agent 的
  // 工具清单里一个都没有 —— 连 09-16 就有的 rule_add 也不在。
  //
  // 根因(平台源码层):dsh-tools 的 `view(scope)` 对**全局层**工具逐个跑
  // `layers.every(layer => layer.admits(name))`;`admits` 判的是该 scope 的
  // `tools.restrict()` 掩码。Web 端按 agent preset 组工具(dsh-base
  // cordis.patch.yml 注释:"The Web app ... composes both tools per agent
  // preset"),preset 用 `restrict({ allow: [...] })` 白名单 ⇒ 我们注册在
  // 全局层的那份**不在白名单里,被过滤掉**。
  //
  // 平台文档给了出路:`register` —— "Register globally or **in the calling
  // agent scope**. Scoped tools shadow globals";`restrict` —— "Restrictions
  // intersect; **scoped registrations remain visible**"。即 scope 内注册
  // 不受 restrict 约束。参照实现:`@linxin666/dsh-tool-describe-image` 的
  // `agent.ctx.tools.restrict(...)`(同样用 agent.ctx)。
  //
  // 故:每个 agent 创建时,在**它自己的** ctx 上再注册一份。两处注册落在
  // 不同层(全局层 vs agent 层),平台允许多层共存、近者遮蔽,不冲突。
  // 全局那份**保留**:没有 restrict 的部署仍走它,且它是 apply 期的早绑。
  // ⚠️ 事件名跨 cohort(与 `lifecycle.js:82-99` **同一套口径**,不另发明):DSH **≥0.1.7**
  //    叫 `agent/created`,**≤0.1.6** 叫 `agent/session-start`,载荷形状不变。此前这里只挂了
  //    新名字 ⇒ 在 0.1.6 上本段永不触发 ⇒ **agent scope 的工具补注册根本不发生**(全局那份仍被
  //    preset 的 restrict 掩码挡掉,于是 agent 的工具清单里一个都没有)。两个名字都注册 +
  //    3 秒去重:将来两者同存时同一个 agent 不会被注册两遍。
  const agentToolSeen = new Map();
  const onAgentCreated = (payload) => {
    // 去重键取会话 id(取值路径与 lifecycle.js 的 dedupStart 逐字一致)
    try {
      const sid = pick(
        () => payload?.agent?.session?.id,
        () => payload?.session?.id,
        () => payload?.sessionId,
        () => payload?.agent?.sessionId,
      );
      const key = sid ? String(sid) : '';
      const now = Date.now();
      if (key && agentToolSeen.get(key) && now - agentToolSeen.get(key) < 3000) return; // 双事件同发时只注册一次
      if (key) agentToolSeen.set(key, now);
    } catch { /* 去重失败就照常执行,宁可多注册一次也不漏 */ }
    try {
      const agent = pick(() => payload?.agent, () => payload?.session?.agent, () => payload?.agentCtx);
      const r = registerLingTools(agent?.ctx, { gate, memory, settings });
      try {
        memory.kvSet('tools.agent_registered', r?.ok ? '1' : ('0:' + String(r?.reason || '')));
      } catch { /* ignore */ }
      if (r?.ok) {
        console.info('[dsh-ling] tools registered on agent scope: %d', r.disposers?.length ?? 0);
      }
    } catch (e) {
      console.debug('[dsh-ling] agent-scope tools registration failed', e);
    }
  };
  try {
    disposers.push(ctx.on?.('agent/created', onAgentCreated));       // DSH ≥0.1.7
    disposers.push(ctx.on?.('agent/session-start', onAgentCreated)); // DSH ≤0.1.6(旧名,保留兼容)
  } catch (e) {
    console.debug('[dsh-ling] agent scope tool hooks failed', e);
  }

  memory.kvSet('boot_at', utcIso());
  memory.kvSet('inject_enabled_config', cfg.injectEnabled === false ? '0' : '1');

  // DSH 会话概述器:启动后 8s 跑一次,之后每 summarizeIntervalMin 分钟自动跑
  let sumTimer = null;
  const runSummarizer = () => {
    try {
      const st = summarizeDsh(memory);
      if (st.sessions > 0 || st.created + st.updated > 0) {
        memory.kvSet('summarizer.last', JSON.stringify({ at: utcIso(), ...st }));
      }
    } catch (e) {
      console.debug('[dsh-ling] summarizeDsh failed', e);
    }
  };
  if (cfg.summarizeAuto !== false) {
    sumTimer = setTimeout(() => {
      runSummarizer();
      const intervalMin = Math.max(1, Number(cfg.summarizeIntervalMin ?? 15));
      sumTimer = setInterval(runSummarizer, intervalMin * 60 * 1000);
    }, 8000);
  }

  // 反馈成长回路:事件驱动(U7 正解,2026-10-01)。
  // ⚠️ 旧实现是"每 60 秒读一次 `~/.dsh/storages/message_feedback.json`",两处都错:
  //   ① 宿主**有推送** —— `dsh-message-feedback\lib\index.js:288` 在冷会话写入 flush 后
  //      发 `feedback/committed`(活会话走 `session/event` 的 feedback 事件);
  //   ② 那个 sidecar 在 Web 组合下自 2026/9/11 起**零写入**(该组合只挂 message-feedback,
  //      反馈已改写在会话日志里)⇒ 轮询每 60 秒读同一个死文件,纯空转。
  // 现在:事件到达即处理;`feedbackAuto:false` 可整体关掉。
  if (cfg.feedbackAuto !== false) {
    try {
      disposers.push(registerFeedbackListener(ctx, memory));
    } catch (e) {
      console.debug('[dsh-ling] feedback listener wiring failed', e);
    }
  }

  // LLM 深摘要:启动 12s 先自检探针;通过才挂自动调度(保守上限,可配)
  let deepTimer = null;
  const bootDeep = async () => {
    try {
      const p = await probeLLM(ctx, memory);
      if (p.ok && cfg.deepSummaryAuto !== false) {
        runDeepPass(ctx, memory, { limit: Number(cfg.deepMaxPerRun ?? DEEP_CFG.perRunLimit) });
        const intervalMin = Math.max(10, Number(cfg.deepIntervalMin ?? DEEP_CFG.autoIntervalMin));
        deepTimer = setInterval(() => {
          runDeepPass(ctx, memory, { limit: Number(cfg.deepMaxPerRun ?? DEEP_CFG.perRunLimit) });
        }, intervalMin * 60 * 1000);
      }
    } catch (e) {
      console.debug('[dsh-ling] deep boot failed', e);
    }
  };
  const deepBootTimer = setTimeout(bootDeep, 12000);

  const dispose = () => {
    if (sumTimer) {
      clearTimeout(sumTimer);
      clearInterval(sumTimer);
      sumTimer = null;
    }
    if (deepTimer) {
      clearInterval(deepTimer);
      deepTimer = null;
    }
    if (deepBootTimer) {
      clearTimeout(deepBootTimer);
    }
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
    try {
      memory.close();
    } catch {}
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose, 'dsh-ling: lifecycle');
  }
  console.info('[dsh-ling] booted; dataDir=%s injection=%s api=%s',
    dataDir,
    typeof svc(ctx, 'systemPrompt')?.section === 'function' ? 'on' : 'off(unavailable)',
    typeof svc(ctx, 'webServer')?.register === 'function' ? 'on' : 'off(unavailable)');
}
