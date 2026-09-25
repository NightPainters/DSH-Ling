// dsh-ling host — clock skill:精确时间按需查询(2026-09-23 用户定)。
//
// 为什么做成 skill 而不常驻注入:
// 时间锚搬迁之后(见 plans/TIMEANCHOR-FIX.md),system 侧只留 [今天](日期+星期,一天变一次),
// context 侧给 [现在](时段档 + 间隔档)。**精确到分钟的时间刻意不常驻** —— 它每 60 秒变一次,
// 会把整段 system 前缀连同工具定义一起作废(实测 system 侧 1440 次/天 → 0)。
// 需要精确时间时主动查,像看手表,而不是让表一直对着人报时。
//
// 注册形态按平台契约:`ctx.skills.register({...})` 注册**内存中的 skill**(嵌入式),
// 注册表补入默认调用策略与 provider 标签,返回的 disposer 归入本插件 effect 链。
// 取服务沿用 tools 的三级兜底(直取 → ctx.inject 子 ctx → 定时重试):apply 可能早于 skills 挂载。

/** skill 名(kebab-case,平台按此寻址)。 */
export const CLOCK_SKILL_NAME = 'clock';

/** 面向发现层的路由描述。 */
export const CLOCK_SKILL_DESCRIPTION =
  '查询当前的精确时间(年月日 · 时分秒 · 星期)。需要报时间、算时长、判断"过了多久"、生成带时间戳的名字时使用。';

/** 补充路由指引 —— 顺带把"什么时候不该用它"写在这里,避免为了问时间而白调一次。 */
export const CLOCK_SKILL_WHEN_TO_USE =
  '用户问"现在几点""今天几号",或你需要精确到分钟/秒的时间做判断(倒计时、间隔计算、时间戳)时。' +
  '日常判断"是接着聊还是隔了很久"不需要它 —— 读上下文里的 [现在]。';

/**
 * 指令正文(frontmatter 由注册字段承载,不进正文)。
 * ⚠️ 正文会随 skill 加载进入模型请求 ⇒ **不得含相邻的 `{{`**(宿主 renderPrompt 对未注册变量直接抛异常,
 * 见 1.3.1 的注入面加固);`tests/clock-skill.test.mjs` 对此有断言。
 */
export const CLOCK_SKILL_CONTENT = `# clock — 精确时间按需查询

## 为什么需要它

上下文里的时间信息只有**两个档**,都不含精确分钟:

| 载体 | 内容 | 刷新频率 |
|---|---|---|
| system 侧 \`[今天]\` | 年月日 + 星期 | 一天一次 |
| context 侧 \`[现在]\` | 时段(清晨/上午/中午/下午/傍晚/夜里/深夜)+ 间隔档(刚刚/今天早些时候/昨天/N 天前) | 每条消息 |

精确到分钟的时间**刻意不常驻** —— 它每 60 秒变一次,会让整段 system 前缀连同工具定义一起失效。
所以:**需要精确时间时主动查。像看手表,而不是让表一直报时。**

## 怎么查

\`\`\`powershell
# 完整:日期 + 时间 + 星期
pwsh -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss dddd'"
# → 2026-09-23 22:14:37 星期三

# 只要日期
pwsh -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd dddd'"

# 只要时间
pwsh -NoProfile -Command "Get-Date -Format 'HH:mm'"

# 带时区偏移(跨时区判断时)
pwsh -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'"
# → 2026-09-23 22:14:37 +08:00
\`\`\`

本机时区:China Standard Time(**UTC+8**),无夏令时。

## 何时该用

| 场景 | 用不用 |
|---|---|
| 用户问"现在几点 / 今天几号" | ✅ 用 |
| 算时长、"过了多久"、倒计时 | ✅ 用(先查再算) |
| 生成带时间戳的文件名 / 日志行 | ✅ 用 |
| 判断"接着聊还是隔了很久" | ❌ 不用 —— 读 \`[现在]\` 的间隔档 |
| 判断语气(深夜该收尾 / 中午可以继续) | ❌ 不用 —— 时段档已在 \`[现在]\` 里 |
| 往文档里写日期 | ⚠️ 用 \`[今天]\` 即可,除非明确要精确到分钟 |

## 三条边界

1. **不要把精确时间写进长期内容**(persona / settings / 记忆)—— 那会让 system 前缀每次组装都变,
   把这次优化的收益原样还回去。
2. **\`[今天]\` 与 \`[现在]\` 优先** —— 它们覆盖绝大多数判断;本 skill 只用于真的需要分钟级时。
3. **跨零点注意**:\`[今天]\` 由 system 侧承载,跨天后的第一条消息**可能仍是昨天的日期** ——
   若结论依赖"绝对今天",先查本 skill。

## 来源

dsh-ling 内置(器灵包)。设计依据:\`plans/TIMEANCHOR-FIX.md\`。
`;

/**
 * 注册 clock skill,带与 tools 同款的三级兜底。
 * @param {object} ctx cordis 上下文。
 * @returns {Array<Function>} 需要随插件一起释放的 disposer 列表(含定时器与 skill 注销)。
 */
export function registerClockSkill(ctx) {
  const disposers = [];
  let mounted = false;

  const mount = (c) => {
    if (mounted) return true;
    try {
      const skills = c?.skills;
      if (!skills || typeof skills.register !== 'function') return false;
      const d = skills.register({
        name: CLOCK_SKILL_NAME,
        description: CLOCK_SKILL_DESCRIPTION,
        whenToUse: CLOCK_SKILL_WHEN_TO_USE,
        content: CLOCK_SKILL_CONTENT,
        source: 'bundled',
      });
      if (typeof d === 'function') disposers.push(d);
      mounted = true;
      console.info('[dsh-ling] clock skill registered');
      return true;
    } catch (e) {
      console.debug('[dsh-ling] clock skill registration failed', e);
      return false;
    }
  };

  if (!mount(ctx)) {
    // 服务从回调参数取,不能走闭包 ctx(否则报 without inject)
    try {
      ctx.inject?.(['skills'], (child) => {
        mount(child);
      });
    } catch (e) {
      console.debug('[dsh-ling] ctx.inject skills failed', e);
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mounted || tries >= 20) {
        clearInterval(timer);
        return;
      }
      mount(ctx);
    }, 1500);
    disposers.push(() => clearInterval(timer));
    console.info('[dsh-ling] skills service not ready at apply; retrying (clock)');
  }
  return disposers;
}
