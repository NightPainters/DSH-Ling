// dsh-ling host entry (cordis plugin): name/inject/apply named exports.
// Skeleton wiring: settings file, sqlite memory, freeze gate, system-prompt
// injection, lifecycle listeners, loopback HTTP gateway.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { svc, ensureDir, defaultDataDir, utcIso, dshHome } from './host/util.js';
import { SettingsFile } from './host/settings-file.js';
import { MemoryStore } from './host/memory.js';
import { FreezeGate } from './host/freeze.js';
import { registerMemorySection } from './host/inject.js';
import { wireLifecycle } from './host/lifecycle.js';
import { registerApi } from './host/api.js';
import { summarizeDsh } from './host/summarizer.js';
import { ingestFeedbackEntries, loadSeen, entriesFromFeedbackFile } from './host/feedback.js';
import { probeLLM, runDeepPass, DEEP_CFG } from './host/deepsummary.js';
import { registerLingTools } from './host/tools.js';
import { registerClockSkill } from './host/clock-skill.js';
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
  const memory = new MemoryStore(join(dataDir, 'memory.db'));
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
  disposers.push(wireLifecycle(ctx, gate, memory, settings, cfg));
  disposers.push(registerApi(ctx, { gate, memory, settings }, cfg));
  // E4 可取证访问日志:只挂两个全局钩子,core 侧补丁留的调用点见 lib/audit/patch-spec.js。
  // 补丁未打时钩子收不到调用 —— 安装器会在启动日志里明确喊出来,不允许静默不记。
  disposers.push(installAccessLog(ctx, cfg.accessLog || {}));
  // clock skill(精确时间按需查询,2026-09-23 用户定):取服务走与 tools 同款的三级兜底。
  disposers.push(...registerClockSkill(ctx));
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
  try {
    ctx.on?.('agent/created', ({ agent }) => {
      try {
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
    });
  } catch (e) {
    console.debug('[dsh-ling] agent/created hook failed', e);
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

  // 反馈成长回路轮询(平台 messageFeedback.list 需会话身份参数 → 直接读 sidecar 文件)
  let fbTimer = null;
  const fbFile = join(dshHome(), 'storages', 'message_feedback.json');
  const pollFeedback = async () => {
    try {
      if (!existsSync(fbFile)) return;
      const fileObj = JSON.parse(readFileSync(fbFile, 'utf8'));
      const entries = entriesFromFeedbackFile(fileObj);
      if (!entries.length) return;
      const seen = loadSeen(memory);
      const res = ingestFeedbackEntries(memory, entries, { seen });
      if (res.queued + res.boosted + res.seenAdded > 0) {
        memory.kvSet('feedback.last', JSON.stringify({ at: utcIso(), ...res }));
      }
    } catch (e) {
      console.debug('[dsh-ling] feedback poll failed', e);
    }
  };
  if (cfg.feedbackAuto !== false) {
    const pollSec = Math.max(20, Number(cfg.feedbackPollSec ?? 60));
    fbTimer = setTimeout(() => {
      pollFeedback();
      fbTimer = setInterval(pollFeedback, pollSec * 1000);
    }, 20000);
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
    if (fbTimer) {
      clearTimeout(fbTimer);
      clearInterval(fbTimer);
      fbTimer = null;
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
