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
import { awayFromSettings } from './host/away.js'; // 1.7.3 夜 F 类:在场/暂离唯一判据
import { registerModeService } from './host/mode-service.js';
import { registerApi } from './host/api.js';
import { summarizeDsh } from './host/summarizer.js';
import { registerFeedbackListener } from './host/feedback.js';
import { probeLLM, runDeepPass, resolveAuto } from './host/deepsummary.js';
import { registerLingTools } from './host/tools.js';
import { createAgentToolBinder } from './host/agent-tools.js';
import { registerClockSkill } from './host/clock-skill.js';
import { registerIndexSkill } from './host/deep-index-skill.js'; // 1.6 步 6:深层库索引层(一簇一行,走 skill)
import { installAccessLog } from './audit/index.js';
import { Config } from './host/config.js';
import { LibraryRuntime } from './host/library-runtime.js';
export { Config };

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
  // Direct callers receive the same fail-loud config validation as Cordis.
  // Validate registered roots/URLs before creating either database.
  // ⚠️ F10(2026-10-15)后这句话要分两半读:**library 配置**写错不再从 `Config()` 抛出去
  //   (改为把原因带进 `cfg.library.configError`,只废掉图书馆那一块,见 host/config.js);
  //   而 `normalizeLibraryConfig` 与 `new LibraryRuntime` 本身**照旧严格抛** ——
  //   注册根目录/URL 在"开库之前"仍会被拦下(严格在里、降级在外)。
  const cfg = { ...Config(config), version: readVersion() };
  const dataDir = cfg.dataDir || defaultDataDir();
  ensureDir(dataDir);

  const settings = new SettingsFile(dataDir);
  // ⚠️ F4(蓝队 2026-10-04 实测 + 主人 2026-10-04 拍板「按错误码分流」):这里此前**没有 try** ⇒
  //   只要构造抛(典型:另一个进程持写锁 —— 升级形态实测 16,445ms 后抛 `database is locked`),
  //   异常就一路冒到 `apply()` ⇒ **11 个工具全不在、人格注入也没了**,而且**没有任何可指认面**。
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
  let library = null;
  let disposed = false;
  const disposers = [];
  let sumTimer = null;
  let deepTimer = null;
  let deepBootTimer = null;
  let closing = null;
  // Own resources before any fallible wiring. A late effect misses failures in
  // runtime revalidation, route mounting or boot_at; Cordis can only roll back
  // effects already registered when apply throws.
  const dispose = () => {
    if (closing) return closing;
    disposed = true;
    let resolveClose, rejectClose;
    closing = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    const pending = [];
    try { pending.push(library?.close()); } catch (error) { pending.push(Promise.reject(error)); }
    if (sumTimer) { clearTimeout(sumTimer); clearInterval(sumTimer); sumTimer = null; }
    if (deepTimer) { clearInterval(deepTimer); deepTimer = null; }
    if (deepBootTimer) { clearTimeout(deepBootTimer); deepBootTimer = null; }
    for (const d of disposers.splice(0).reverse()) {
      try { if (typeof d === 'function') pending.push(d()); } catch (error) { pending.push(Promise.reject(error)); }
    }
    try { memory.close(); } catch (error) { pending.push(Promise.reject(error)); }
    Promise.allSettled(pending).then((results) => {
      const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) rejectClose(new AggregateError(failures, 'dsh-ling cleanup failed'));
      else resolveClose();
    });
    return closing;
  };
  try {
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-ling: lifecycle');
  library = new LibraryRuntime(dataDir, cfg.library);
  const libraryStatus = library.status();
  if (!libraryStatus.ok) console.warn('[dsh-ling] %s', libraryStatus.message);
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

  // F5(1.7 修复批次):`cfg.injectEnabled === false` 是**记忆段**的逃生开关 —— 关到底 ⇒
  // registerMemorySection 一段都不注册(此前这个键全仓零处读,承诺关得掉、实际关不掉)。
  // 它**不管**人格段:那道闸是 `settings.persona.enabled`(persona.js:166),两者并列。
  disposers.push(registerMemorySection(ctx, gate, memory, settings, { enabled: cfg.injectEnabled !== false }));
  // E0「那一行跟着会话走」:只加一个 agent/pre-step 监听(全库目前没有别处用它)。
  // 形态 A —— 只往 `decision.messages` 追加,**不碰** systemPrompt 的 section()/context(),
  // 也绝不调用带 surfaceOp 的 session.append。关掉开关:settings.memory.sessionProgressLine=false。
  // ── 1.7.3 E 类审计(2026-10-27):它也必须受**仓外总闸**管 ──────────────────────────
  // 这一行是把 `[本次会话·进展]` 当 user 消息塞进上下文,内容取自记忆库的会话概述 ⇒
  //   总闸 `cfg.injectEnabled:false` 关掉记忆段之后,记忆内容仍从这条路进模型,
  //   而面板写着"整段注入(含时间锚)已被总闸关掉" —— 就是又一次"说了没做"。
  // 副作用:总闸关时 `[本场]`/进展行一起消失(它们本就是记忆内容的投影),这是**有意**的。
  if (cfg.injectEnabled !== false) disposers.push(wireSessionLine(ctx, memory, settings, cfg.sessionLine || {}));
  else console.info('[dsh-ling] 总闸 injectEnabled=false:进展行(会话概述)一并不挂 —— 它也是记忆内容');
  disposers.push(wireLifecycle(ctx, gate, memory, settings, cfg));
  // P3-A(2026-09-29):把「给某个会话设模式」暴露成跨插件服务 `dsh-ling/mode` ——
  // 飞书桥建线时用它把新会话钉到生活挡位。软能力:注册失败只记日志,不影响其余功能。
  disposers.push(registerModeService(ctx, { gate, memory, settings }));
  disposers.push(registerApi(ctx, { gate, memory, settings, library }, cfg));
  // E4 可取证访问日志:只挂两个全局钩子,core 侧补丁留的调用点见 lib/audit/patch-spec.js。
  // 补丁未打时钩子收不到调用 —— 安装器会在启动日志里明确喊出来,不允许静默不记。
  disposers.push(installAccessLog(ctx, cfg.accessLog || {}));
  // clock skill(精确时间按需查询,2026-09-23 用户定):取服务走与 tools 同款的三级兜底。
  disposers.push(...registerClockSkill(ctx));
  // 深层库索引层 skill(1.6 步 6,2026-10-04):主人拍过「索引层 ≤400 字 · 一簇一行」,
  //   承载形态选定为**整个索引层一个 skill** —— 目录只常驻 name + description(11 行簇目录),
  //   正文按需展开;而 skill 目录按 sha256 比对、**内容不变就不重发** ⇒ 前缀稳定是白拿的。
  //   ⚠️ 不要拆成"每簇一个 skill":实测边际成本 ≈205 字/条,11 簇会把常驻目录面撑爆,
  //   而那个池子正是工具面压缩要抢的同一个。
  // 1.7.3:技能也随「记忆与图书馆」开关 ——— 它教模型"用 recall 搜记忆",工具关了它还在就成了指令错位。
  // 只读**启动那一刻**的设置(与全局工具层同一边界),运行中拨开关需重启宿主才彻底消失。
  // 1.7.3 E 类审计(2026-10-27):再叠一道**仓外总闸** —— 总闸关着却还挂索引 skill,等于面板说"已关"
  //   而模型仍被告知"用 recall 翻记忆"。
  disposers.push(...registerIndexSkill(ctx, {
    // 1.7.3 夜:离场也算"关" —— 她不在场时,别在技能目录里挂一份"用 recall 搜我的记忆"的说明书。
    // 判据走 awayFromSettings(三个键的别名收紧到一处),不在本文件另写一份布尔合取。
    enabled: cfg.injectEnabled !== false && !awayFromSettings(settings.get()),
  }));
  // 会话内工具(规矩直达 / 习惯提议):拿不到 tools 服务就退化为"只能用面板",绝不抛错。
  // 取服务用三级兜底(与 webServer 同一套路):直取 → ctx.inject 子 ctx → 定时重试。
  // 2026-09-16 教训:本插件 apply 可能早于 tools 服务挂载,一次性直取会静默失败 —— 工具从未注册。
  let toolsMounted = false;
  let globalToolCount = 0;             // 全局注册到的工具数:agent 侧判"部分失败"的基准
  const mountTools = (c) => {
    if (disposed) return { ok: false, reason: 'closed' };
    if (toolsMounted) return { ok: true };
    try {
      const tr = registerLingTools(c || ctx, { gate, memory, settings, library });
      if (tr && tr.ok) {
        toolsMounted = true;
        if (Array.isArray(tr.disposers)) disposers.push(...tr.disposers);
        globalToolCount = Array.isArray(tr.disposers) ? tr.disposers.length : 0;
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
  // 器灵侧工具 · agent 作用域补注册(2026-09-25 修;**2026-10-07 补上"存量 agent"这一半**)。
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
  //
  // ⚠️ 1.7 生命周期整改暴露的配套缺口(真机复现 + 隔离探针复现):
  //   1.7 起 agent 侧注册产生的 disposer 被收进入口 disposers,卸载时**连同旧闭包一起撤销**
  //   —— 这是**对的**(旧闭包持有已关闭的 LibraryRuntime,留着只会返回 `reason:'closed'`)。
  //   但补绑入口**只有 created 事件** ⇒ 热重载后**仍然活着的 agent 收不到事件**,
  //   工具从此缺席(全局那份又被 preset 掩码挡住)⇒ 表现就是"器灵工具从清单里消失"。
  //   修法(全在 `lib/host/agent-tools.js`,顶部注释给了实读锚点):
  //     ① **先挂监听** → ② 再 `ctx.agents.list()` 枚举存量补绑;
  //     ③ 身份按 **agent ctx 对象**(不是"sid + 3 秒窗口":同 sid 的两个 agent 必须各绑各的,
  //        两个事件名同发时必须只绑一次);
  //     ④ 注册只走 `registerLingTools`(内部 guard 不许绕过);
  //     ⑤ 少注册了工具 ⇒ 记 `partial`,**不当全成功**;
  //     ⑥ 卸载即撤销自己的全部注册并锁死回绑;`agents` 服务迟到走既有 `ctx.inject`。
  const agentTools = createAgentToolBinder({
    ctx,
    register: registerLingTools,
    deps: { gate, memory, settings, library },
    isDisposed: () => disposed,
    expectedToolCount: () => globalToolCount,
    // 留痕:除原有的 tools.agent_registered 之外,把"为什么没绑上/只绑了一部分"写进 kv,
    // 免得下一次又是"工具悄悄没了、库外无迹可查"。
    onNote: (level, message, data) => {
      try {
        memory.kvSet('tools.agent_registered', level === 'info' ? '1' : ('0:' + String((data && data.reason) || level)));
        if (level !== 'info') {
          memory.kvSet('tools.agent_rebind', JSON.stringify({ at: utcIso(), level, message: String(message).slice(0, 220), data: data || null }));
        }
      } catch { /* ignore */ }
    },
  });
  disposers.push(() => agentTools.dispose());   // 卸载即撤销 + 清空绑定表 + 禁止回绑
  agentTools.install();                         // ① 监听先挂(否则"枚举—事件"之间创建的 agent 会漏)
  {
    const firstBind = agentTools.bindExisting();       // ② 再枚举存量
    if (!firstBind.ok && firstBind.reason === 'no-agents-service') agentTools.hookLateService(); // ③ 服务迟到
    const st = agentTools.status();
    if (st.bound || st.failures.length || !st.serviceAvailable) {
      console.info('[dsh-ling] agent 作用域工具补绑: bound=%d listed=%d already=%d subagentSkip=%d partial=%d failures=%d agentsService=%s',
        st.bound, st.listed, st.already, st.subagentSkipped, st.partial, st.failures.length, st.serviceAvailable ? 'on' : 'off');
    }
  }

  memory.kvSet('boot_at', utcIso());
  memory.kvSet('inject_enabled_config', cfg.injectEnabled === false ? '0' : '1');

  // DSH 会话概述器:启动后 8s 跑一次,之后每 summarizeIntervalMin 分钟自动跑
  const runSummarizer = () => {
    // 1.7.3 夜 F 类第三轮(盲审 F1):浅概述也会写库(概述 + 水位),与深摘同属"后台写入",
    //   所以同一道闸 —— 否则面板说"后台停摆",概述器仍在长。
    if (!memoryFaceOn()) return;
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

  // 后台自动行为(自动深摘 / 探活延时 / 反馈回路)的三级优先级 —— settings.auto > 插件配置旧键 > 默认 ——
  // **只在本行判一次**(resolveAuto,见 host/deepsummary.js):面板要显示"这个值是谁定的",就不能有两处各判一次。
  // ⚠️ 这是**启动期**读取:面板改完要重启宿主才生效(定时器与探活延时都不回溯)。
  // ⚠️ 传 **settings 实例本身**(不是 `settings.get()`):后者把默认值也合并了进来 ⇒ 代码默认会冒充用户设定,
  //    插件配置里的旧键(feedbackAuto / deepSummaryAuto / deepIntervalMin / deepMaxPerRun)被整体压掉。
  const auto = resolveAuto(settings, cfg);

  // ── 1.7.3(2026-10-27 主人定):「关记忆」连**后台写入**一起停 ─────────────────────
  // 主人的口径:「关记忆一起停,但是要悬浮注解说出来」。
  // 关掉 `settings.inject.memoryEnabled` 之后,如果后台照旧自动深摘、照旧从点赞/点踩里长规矩与
  // 习惯提议,那面板上写着"已关闭"而记忆库仍在长大 —— 又是一次"说了不做"。
  // ⇒ 这里把两道后台入口(自动深摘调度、反馈成长回路)与注入面绑到**同一个判据**上。
  // ⚠️ 1.7.3 夜改:**不再是启动期常量**。`inject.away`(在场/暂离)是随时可拨的当场动作,
  //    如果只在启动时读一次,"她暂离了"要重启宿主才算数 —— 违反"暂离"的语义。
  //    所以这里是个**函数**,每次后台要干活前现问一遍(深摘的定时器每一轮都问)。
  // ⚠️ 读设置失败 ⇒ **照旧开**(fail-open):读不出来的设置不该变成"后台静默停摆"。
  // ⚠️ 手工入口(面板上的「深摘」「抓取反馈」按钮)不受影响:那是主人的显式动作,不是后台自走。
  const memoryFaceOn = () => {
    try {
      return !awayFromSettings(settings?.get?.());
    } catch { return true; }
  };
  if (!memoryFaceOn()) console.info('[dsh-ling] 记忆面已关闭(暂离 / inject.memoryEnabled=false):不注入记忆、后台自动深摘与反馈成长一并停摆');

  // 反馈成长回路:事件驱动(U7 正解,2026-10-01)。
  // ⚠️ 旧实现是"每 60 秒读一次 `~/.dsh/storages/message_feedback.json`",两处都错:
  //   ① 宿主**有推送** —— `dsh-message-feedback\lib\index.js:288` 在冷会话写入 flush 后
  //      发 `feedback/committed`(活会话走 `session/event` 的 feedback 事件);
  //   ② 那个 sidecar 在 Web 组合下自 2026/9/11 起**零写入**(该组合只挂 message-feedback,
  //      反馈已改写在会话日志里)⇒ 轮询每 60 秒读同一个死文件,纯空转。
  // 现在:事件到达即处理;`auto.feedbackAuto`(旧键 cfg.feedbackAuto)可整体关掉。
  if (auto.feedbackAuto) {
    try {
      // ⚠️ 1.7.3 夜:这里改成**常驻注册**(不再用启动时的 memoryFaceOn 包一层)。
      //   离场是运行时动作,若按启动快照决定"要不要挂监听",则"暂离"要重启才生效。
      //   现在把离场判据放到 feedback.js 的两个 handler 里(每次事件现问),见其 `awaySkip()`。
      disposers.push(registerFeedbackListener(ctx, memory, settings));
    } catch (e) {
      console.debug('[dsh-ling] feedback listener wiring failed', e);
    }
  }

  // LLM 深摘要:启动 auto.bootProbeDelayMs 后先自检探针;通过才挂自动调度(保守上限,可配)
  const bootDeep = async () => {
    if (disposed) return;
    try {
      const p = await probeLLM(ctx, memory);
      // ── 1.7.3 夜 F 类第三轮(盲审 F3):**定时器不再被"此刻在不在场"挡住注册** ──────────
      // 旧写法把 `memoryFaceOn()` 写进外层条件 ⇒ 启动时若她正暂离,timer 根本不会被创建;
      // 之后点「她回来」也没有补挂路径 ⇒ 自动深摘要等下次重启才恢复,与"不用重启"直接矛盾。
      // 现在只判"探针通过 + 配置允许",离场判定放在每一轮的 tick 里(下面那行)。
      if (!disposed && p.ok && auto.deepSummary) {
        if (memoryFaceOn()) runDeepPass(ctx, memory, { limit: auto.deepMaxPerRun, shouldStop: () => !memoryFaceOn() });
        const intervalMin = auto.deepIntervalMin; // clamp(10..1440)已在 resolveAuto 做过,这里不再设第二把尺
        deepTimer = setInterval(() => {
          // 每一轮**现问**一次 —— 她暂离了就跳过这次(不回头补,补也不补离场区间里的,
          // 那道闸在 lifecycle.js 的入库口径里)。这样离场/回来都不需要重启宿主。
          if (!memoryFaceOn()) return;
          runDeepPass(ctx, memory, { limit: auto.deepMaxPerRun, shouldStop: () => !memoryFaceOn() });
        }, intervalMin * 60 * 1000);
      }
    } catch (e) {
      console.debug('[dsh-ling] deep boot failed', e);
    }
  };
  deepBootTimer = setTimeout(bootDeep, auto.bootProbeDelayMs);
  console.info('[dsh-ling] booted; dataDir=%s injection=%s api=%s',
    dataDir,
    typeof svc(ctx, 'systemPrompt')?.section === 'function' ? 'on' : 'off(unavailable)',
    typeof svc(ctx, 'webServer')?.register === 'function' ? 'on' : 'off(unavailable)');
  } catch (error) {
    // Direct callers without Cordis also get rollback. Preserve the original
    // activation error; the registered effect can await this same close promise.
    void dispose().catch((cleanupError) => console.error('[dsh-ling] rollback failed', cleanupError));
    throw error;
  }
}
