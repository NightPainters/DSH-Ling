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

/** 补丁标记：用于识别"这一行是我们插的"（幂等 + 可回滚的依据）。 */
export const PATCH_MARKER = 'E4 access log (dsh-ling patch)';

export const OBSERVE_GLOBAL = '__dshAccessLogObserve';
export const UPGRADE_GLOBAL = '__dshAccessLogUpgrade';

/** 补丁状态文件（相对 $DSH_HOME）：插件启动时据此报告"补丁在不在"。 */
export const PATCH_STATE_FILE = 'access-log.patch.json';

/**
 * 两条补丁的目标。`anchor` 必须**在目标文件里唯一命中**（脚本会断言），
 * 命中后把 `line(indent)` 插到锚点的**最后一行之后**。
 * `indentDelta`：插入行相对锚点最后一行的缩进偏移（进块内 +1，同级 0）。
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
    label: 'dsh-api-gateway · /api/remote.mux upgrade（同一条栅栏的第二个入口）',
    packageDir: ['node_modules', '@deepseek-ai', 'dsh-api-gateway'],
    file: 'lib/index.js',
    anchor: /^([ \t]*)const rejection = webCtx\.connection\.requestRejection\(req\);\r?\n/m,
    indentDelta: 0,
    line: (indent) => `${indent}globalThis.${UPGRADE_GLOBAL}?.(req, rejection); // ${PATCH_MARKER}\n`,
  },
];

/** 目标文件相对 DSH 包根的路径。 */
export function targetPath(dshRoot, target) {
  return [dshRoot, ...target.packageDir, target.file].join(process.platform === 'win32' ? '\\' : '/');
}
