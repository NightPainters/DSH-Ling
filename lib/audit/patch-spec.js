// E4 访问日志 · 核心补丁规格（唯一真源）
//
// 为什么要有这个文件：补丁是一条**插进 node_modules 的 core 代码**里的行，
// 而"该插什么、插在哪、怎么认出来"必须只有一处定义 —— 否则
// 补丁脚本与插件侧的"补丁在不在"检查会各自漂移。
//
// 补丁形态的原则（E4 任务书 §3.5 的延伸）：
//   · **一行 hooks**：core 只多一行 `globalThis.__dshAccessLogXxx?.(…)`，
//     实现全在本插件里 ⇒ DSH 升级后重打一次，逻辑零改动。
//   · **可选链兜底**：插件没装 / 被卸载时，这一行是 no-op，DSH 照常启动。
//   · **只观察不判定**：补丁不做任何判断、不改任何返回值。
//   · **锚点随 cohort 带**：同一处 core 代码在不同 DSH 版本里写法会变（见第二个目标），
//     所以目标可以给**候选锚点列表**：逐个试，恰好唯一命中的那个才可用 —— 单锚点必然顾此失彼。

/** 补丁标记：用于识别"这一行是我们插的"（幂等 + 可回滚的依据）。 */
export const PATCH_MARKER = 'E4 access log (dsh-ling patch)';

export const OBSERVE_GLOBAL = '__dshAccessLogObserve';
export const UPGRADE_GLOBAL = '__dshAccessLogUpgrade';

/** 补丁状态文件（相对 $DSH_HOME）：插件启动时据此报告"补丁在不在"。 */
export const PATCH_STATE_FILE = 'access-log.patch.json';

/** 锚点在一份源码里命中几次（把正则 g 化后统计；不改调用方传进来的正则对象，免留 lastIndex）。 */
export function countAnchorHits(source, anchor) {
  const re = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`);
  return (source.match(re) || []).length;
}

/**
 * 把一条目标规格归一成**候选锚点数组** —— 新形态 `anchors: [{ cohort, anchor, line, indentDelta }]`
 * 与旧形态（顶层 `anchor` / `line` / `indentDelta`）之间的兼容层。旧形态视作"只有一个候选"，
 * 于是不需要 cohort 概念的目标照旧写法即可（两个消费方共用这一个归一函数，判据不会分叉）。
 * `indentDelta` 的兜底沿用旧行为（1 = 进块内一级；同级插入要显式写 0）。
 */
export function anchorCandidates(target) {
  const raw = Array.isArray(target.anchors) && target.anchors.length
    ? target.anchors
    : [{ cohort: 'legacy', anchor: target.anchor, line: target.line, indentDelta: target.indentDelta }];
  return raw.map((c) => ({
    ...c,
    cohort: c.cohort || 'unknown',
    indentDelta: Number.isInteger(c.indentDelta)
      ? c.indentDelta
      : (Number.isInteger(target.indentDelta) ? target.indentDelta : 1),
  }));
}

/**
 * 在一份文件内容上解析"该用哪个候选锚点"（**纯函数**，不碰文件系统；补丁脚本与单测共用同一判据）。
 *
 * 语义（纪律：宁可不动，也不能在 core 里插错地方）：
 *   · `hit`       —— 恰好一个候选唯一命中 ⇒ 可用（`candidate` 带着该 cohort 自己的 `line`）；
 *   · `ambiguous` —— 两个及以上候选各自唯一命中（两种 cohort 的写法同时在场）⇒ **拒绝改动，不许猜**；
 *   · `drifted`   —— 没有任何候选唯一命中（全漂，或某个候选命中 2 次以上）⇒ 需要人工更新锚点。
 * `counts` 逐候选报命中数，供脚本打印与人工核对。
 */
export function resolveAnchor(target, source) {
  const counts = anchorCandidates(target)
    .map((c) => ({ cohort: c.cohort, candidate: c, hits: countAnchorHits(source, c.anchor) }));
  const usable = counts.filter((x) => x.hits === 1);
  if (usable.length === 1) return { state: 'hit', cohort: usable[0].cohort, candidate: usable[0].candidate, counts };
  if (usable.length > 1) return { state: 'ambiguous', cohort: null, candidate: null, counts };
  return { state: 'drifted', cohort: null, candidate: null, counts };
}

/**
 * 一行是不是**我们插进去的钩子行**（带标记 + `globalThis.__dshAccessLog…?.(` 可选调用）。
 * 回滚（删行）与 `--check` 复核都用它 —— 判据只此一处，免得两处各自漂移。
 */
export function isHookLine(line) {
  return (
    typeof line === 'string' &&
    line.includes(PATCH_MARKER) &&
    line.includes('globalThis.__dshAccessLog')
  );
}

/** 删掉所有钩子行（回滚）。只删"带标记且形如钩子调用"的行，绝不误伤别的代码。 */
export function stripHookLines(source) {
  return String(source).split(/\r?\n/).filter((line) => !isHookLine(line)).join('\n');
}

/**
 * **已打补丁的文件是否仍然有效**（C-09，2026-09-26）—— `--check` 的判据，纯函数，不碰文件系统。
 *
 * 为什么必须复核：旧判据是 `source.includes(PATCH_MARKER)`（"文件里出现过标记就算 applied"）。
 * 那是个**绿色短路**：标记行还在、但锚点那几行已经被改掉的文件（DSH 升级改写了这段代码、
 * 或有人手工动过）照样报 `applied` 并退出 0 ⇒ 用户以为 E4 在记，实际一行都不会记。
 * 判据必须落在**实体**上：插入点那几行还在不在原处、插进去的那行是不是**本站 cohort 的**文本。
 *
 * 三合一（缺一即不算 applied）：
 *   ① 有钩子行；② 锚点仍**恰好唯一**命中（`resolveAnchor` 同判据）；③ 钩子行正文 = 该 cohort 期望的插入行正文
 *   （缩进不参与比较：缩进错了 JS 照样跑，cohort 错了就是 ReferenceError —— 后者才是要抓的）。
 *
 * 返回 `{ state, cohort, candidate, counts, expected, actual, hooks }`：
 *   · `applied`         —— 三条全过；
 *   · `cohort-mismatch` —— 锚点在、钩子行却是另一个 cohort 的文本（0.1.5 的 `rejection` 行插进 0.1.7 的文件 ⇒ 每个请求都炸）；
 *   · `stale`           —— 钩子行在，但锚点已不在原处（`drifted` / `ambiguous`）；
 *   · `duplicated`      —— 钩子行不止一条（重复打过补丁 ⇒ 每行日志记两遍）；
 *   · `not-applied`     —— 一条钩子行都没有（此时 `cohort`/`counts` 来自 `resolveAnchor`，供"能不能打"参考）。
 */
export function verifyPatched(target, source) {
  const text = String(source);
  const hooks = text.split(/\r?\n/).filter(isHookLine);
  const res = resolveAnchor(target, text);
  const counts = res.counts;
  if (!hooks.length) {
    return { state: 'not-applied', cohort: res.cohort, candidate: null, counts, expected: null, actual: null, hooks: 0 };
  }
  if (hooks.length > 1) {
    return { state: 'duplicated', cohort: res.cohort, candidate: null, counts, expected: null, actual: hooks[0].trim(), hooks: hooks.length };
  }
  if (res.state !== 'hit') {
    return { state: 'stale', cohort: null, candidate: null, counts, expected: null, actual: hooks[0].trim(), hooks: 1 };
  }
  const expected = res.candidate.line('').trim();
  const actual = hooks[0].trim();
  return {
    state: actual === expected ? 'applied' : 'cohort-mismatch',
    cohort: res.cohort,
    candidate: res.candidate,
    counts,
    expected,
    actual,
    hooks: 1,
  };
}

/**
 * dsh-api-gateway 的 `/api/remote.mux` upgrade：**同一处代码在不同 DSH cohort 里写法不同**，
 * 所以这里是**候选锚点列表**（逐个试、恰好唯一命中的那个才可用），而不是单一正则。
 *
 * 为什么必须多候选：DSH 0.1.7 起 `requestRejection()` 不再公开，改成 `admit(req)` 返回
 * `{ peer }` 或 `{ rejection: <status> }`；两个 cohort 的**钩子行文本也不同**（旧的要直接交
 * `rejection` 变量，新的得从 `admission` 里取）。只留新锚点 ⇒ 还在 0.1.5 的用户锚点失配 ⇒
 * 补丁打不上 ⇒ **日志静默不记**（这正是"锚点必须随 cohort 带着走"的原因）。
 */
const MUX_ANCHORS = [
  {
    cohort: '0.1.7+',
    // dsh-client-connection/lib/index.js：admit() 返回 { peer: operator } 或 { rejection: <status> }。
    // 语义等价：允许通过时把 undefined 交给钩子、被拦下时交给它 status —— 与 0.1.5 的写法一致。
    anchor: /^([ \t]*)const admission = webCtx\.connection\.admit\(req\);\r?\n/m,
    indentDelta: 0,
    line: (indent) =>
      `${indent}globalThis.${UPGRADE_GLOBAL}?.(req, "rejection" in admission ? admission.rejection : void 0); // ${PATCH_MARKER}\n`,
  },
  {
    cohort: '0.1.5',
    anchor: /^([ \t]*)const rejection = webCtx\.connection\.requestRejection\(req\);\r?\n/m,
    indentDelta: 0,
    // 这里**只能**交 `rejection`：0.1.5 的文件里没有 `admission` 这个名字，
    // 写成 admission 的话每个 upgrade 请求都会 ReferenceError（`?.` 保不住未声明的标识符）。
    line: (indent) => `${indent}globalThis.${UPGRADE_GLOBAL}?.(req, rejection); // ${PATCH_MARKER}\n`,
  },
];

/**
 * 两条补丁的目标。插入位置由锚点决定：命中后把 `line(indent)` 插到锚点的**最后一行之后**。
 * `indentDelta`：插入行相对锚点最后一行的缩进偏移（进块内 +1，同级 0）。
 *
 * 锚点形态两种（`anchorCandidates()` 归一，判据见 `resolveAnchor()`）：
 *   · 单一锚点 —— 顶层 `anchor` / `line`：该正则必须**在目标文件里唯一命中**；
 *   · 候选锚点 —— `anchors: [{ cohort, anchor, line, indentDelta }]`：逐 cohort 试，恰好一个唯一命中才动手；
 *     多个同时命中 ⇒ 歧义（拒绝改动）；全不命中 ⇒ 漂移（退出码 2，等人工更新锚点）。
 */
export const PATCH_TARGETS = [
  {
    id: 'client-connection-api',
    label: 'dsh-client-connection · /api 唯一入口（403/401 栅栏就在里面）',
    packageDir: ['node_modules', '@deepseek-ai', 'dsh-client-connection'],
    file: 'lib/index.js',
    anchor: /^([ \t]*)path: API_PATH,\r?\n([ \t]*)handler: async \(req, res\) => \{\r?\n/m,
    indentDelta: 1,
    line: (indent) => `${indent}globalThis.${OBSERVE_GLOBAL}?.(req, res); // ${PATCH_MARKER}\n`,
  },
  {
    id: 'api-gateway-mux',
    label: 'dsh-api-gateway · /api/remote.mux upgrade（同一条栅栏的第二个入口，锚点随 cohort 漂移）',
    packageDir: ['node_modules', '@deepseek-ai', 'dsh-api-gateway'],
    file: 'lib/index.js',
    anchors: MUX_ANCHORS,
    // 顶层 `anchor` / `line` 是**派生**的（= 第一个候选），只为老读法兜底（插件侧状态检查、
    // tests/access-log.test.mjs 读的都是顶层字段）—— 绝不在这里手写第二份，免得跟 `anchors` 漂移。
    anchor: MUX_ANCHORS[0].anchor,
    line: MUX_ANCHORS[0].line,
    indentDelta: MUX_ANCHORS[0].indentDelta,
  },
];

/** 目标文件相对 DSH 包根的路径。 */
export function targetPath(dshRoot, target) {
  return [dshRoot, ...target.packageDir, target.file].join(process.platform === 'win32' ? '\\' : '/');
}
