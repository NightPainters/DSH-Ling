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

export const name = 'dsh-ling';
export const inject = [];

export function apply(ctx, config = {}) {
  const cfg = { ...config, version: '0.1.0' };
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
