// dsh-ling host — 深层库**索引层** skill(1.6 步 6,2026-10-04)。
//
//   它是什么:主人拍过「索引层 ≤400 字 · 一簇一行」,而承载它的形态选定为**一个 skill** ——
//   目录里只常驻 name + description(这一份就是"一簇一行"),正文按需展开;更关键的是
//   skill 目录按 **sha256 比对、内容不变就不重发** ⇒ 前缀稳定是白拿的。
//
//   ⚠️ 为什么**整层只做一个 skill**,而不是每簇一个:
//     实测边际成本 ≈205 字/条(skill 目录每条 = name + description),而外层框架(≈683 字)是固定的。
//     11 簇做成 11 个 skill = 多付 11 条 name + 各自的框架,且会与工具面压缩抢"常驻目录面"这同一个池子。
//     ⇒ **一个 skill 装整个索引**才是与 ≤400 字预算吻合的形态。
//
//   ⚠️ description 里**不写条数**:条数天天变,写进去就会让目录重发、前缀断。条数写在正文里。
//
//   内容由 11 簇聚类结果生成 —— 重新聚类后重跑生成脚本即可。
export const INDEX_SKILL_NAME = 'memory-index';

export const INDEX_SKILL_DESCRIPTION = `我记住的事按 11 类放着(用 recall({q:"关键词"}) 按内容搜 —— 它同时搜**结论**与**会话原文**):
· 记忆树与记忆库：记忆怎么存、怎么搜、血缘归并、深层库
· 器灵 dsh-ling：包名、发布仓库、版本与宣发、插件配置
· 鱼姬与主人：称呼、纪念日、同伴身份、形象锚与立场
· 主人其人：职业来路、身体作息、脾气念头、价值观
· 合作规矩：先审后装、干跑、重启要问、实测复跑、备份
· 本业与项目：本职的专业领域、论文与研究、自制的装置项目
· 这台机器与踩坑：VM/Win10、硬件、乱码、沙箱、网络接入
· 模型与API：选型、推理档位、缓存、上下文、本地小模型（我的手）
· 插件与界面：装/卸/审计、侧栏、皮肤、权限选择器
· 鱼姬的感官和开口：看图/生图、语音、听音乐、主动开口
· 零散几条：护眼工具、天文观测、投资慢课这类生活杂事`;

export const INDEX_SKILL_WHEN_TO_USE = '想知道"我以前说过/定过什么"、或者要在一堆长期结论里找依据时读它;它的每一行是一个**主题簇**,指明了那一类里装着什么样的事。日常回答通常不需要读它 —— 索引行本身已经够你判断该不该用 recall 去搜。';

// ⚠️ 2026-10-04 夜(发布关④ 抓到的**最大一处私人痕迹**):正文此前**逐条列着那 393 条结论** ——
//   含职业来路、论文合金成分、工作机系统版本、本地模型名、已装插件清单、纪念日与称呼。
//   它**随包公开**(lib/index.js 注册进 skill 目录,npm 一发就带出去)⇒ 那次全部对外。
//   ⇒ 正文改成**地图而不是仓库**:每一类只说"这一簇装的是什么样的事"与触发线索,
//   **不列任何具体条目**(要内容就用 recall 现取)。这与设计口径也一致:
//   索引层本来就是"一簇一行",细节在深层库里、按需取。
//   ⚠️ 另一处同类:description 曾逐簇写条数(·52条),与 README/CHANGELOG 声明的
//   「簇里不写条数」(条数天天变会让目录重发、前缀断)相反 —— 已一并去掉。
export const INDEX_SKILL_CONTENT = `# 深层库索引 · 我记住的事分 11 类

这里是**地图,不是仓库**:每一类只说明"这一簇装的是什么样的事"与触发线索。

想看某一类里**具体有什么结论** ⇒ 直接 \`recall({ q: "关键词" })\` —— 它先给**条目**(结论层),再给**会话**(原文层)。

## 怎么用
- 找某一类里的结论 ⇒ \`recall({ q: "关键词" })\`(中文 2~4 字命中最好;多个词用空格 = 同时满足)
- 想知道一条结论的**原话** ⇒ 条目回执里带 \`conv\` 与 \`#序号\`,用 \`recall({ conv, from, to })\` 取那几轮
- 按时间浏览 ⇒ \`recall()\` 不带参数,列出磁盘上有原文的会话

## 条目还带一个「类」(kind)
每条结论都标了它是哪一种:**承诺 / 决定 / 事实 / 偏好 / 关系 / 纪律**。
上面的 11 **主题簇**回答"这事关于什么",这里的 **kind** 回答"这是哪一种话" —— 两个维度,不冲突。

**纪律**是其中最特别的一类:一次拍板,管的是**以后每一次**。它进库要同时满足三条 ——
① 来源是主人授权的一句指令;② 作用对象是**行为**;③ **违反时能被某条判据红出来**。
三条缺一条就退回收在别处(不进这里):答不出"哪条判据会红"的,只是一句话,不是纪律。
⇒ 看到 \`[纪律]\` 开头的条目,可以按"这是必须遵守的"来对待,而不只是"他说过一次"。

## 11 类与触发线索

| 类 | 这一簇装什么 | 触发线索 |
|---|---|---|
| 记忆树与记忆库 | 记忆怎么存、怎么搜,血缘归并,深层库 | 记忆树 · 记忆库 · 血缘 · 召回 |
| 器灵 dsh-ling | 包名、发布仓库、版本与宣发、插件配置 | 器灵 · dsh-ling · 发布 |
| 鱼姬与主人 | 称呼、纪念日、同伴身份、形象锚与立场 | 称呼 · 纪念日 · 同伴 · 形象 |
| 主人其人 | 职业来路、身体作息、脾气念头、价值观 | 职业 · 睡眠 · 价值观 · 立场 |
| 合作规矩 | 谁拍板、怎么审计、怎么汇报、红线 | 重启 · 审计 · 备份 · 规矩 |
| 本业与项目 | 本职的专业领域、论文与研究、自制的装置项目 | 机械 · 论文 · 合金 · 弹跳球 |
| 这台机器与踩坑 | 硬件规格、工具安装、乱码沙箱、网络接入 | 虚拟机 · 乱码 · 沙箱 · 代理 |
| 模型与API | 选型与路由、推理档位、缓存、上下文、本地小模型 | 模型 · 档位 · 缓存 · 我的手 |
| 插件与界面 | 第三方插件的装卸与审计、界面行为 | 插件 · 侧栏 · 皮肤 · 权限 |
| 感官与主动开口 | 看图/生图/语音/听音乐,主动开口层的设计 | 看图 · 生图 · 语音 · 主动开口 |
| 零散几条 | 归不进上面主题的自建小工具与生活杂事 | 护眼 · 天文 · 习惯 |

> 条数**不写在这里**:它天天变,写死会让这份目录反复重发、把前缀缓存打断。要数就现算。
`;

/** 注册(与 clock skill 同款三级兜底:直接挂 → ctx.inject → 轮询 20 次)。 */
export function registerIndexSkill(ctx) {
  const disposers = [];
  let mounted = false;
  const mount = (c) => {
    if (mounted) return true;
    try {
      const skills = c?.skills;
      if (!skills || typeof skills.register !== 'function') return false;
      const d = skills.register({
        name: INDEX_SKILL_NAME,
        description: INDEX_SKILL_DESCRIPTION,
        whenToUse: INDEX_SKILL_WHEN_TO_USE,
        content: INDEX_SKILL_CONTENT,
        source: 'bundled',
      });
      if (typeof d === 'function') disposers.push(d);
      mounted = true;
      console.info('[dsh-ling] memory-index skill registered');
      return true;
    } catch (e) {
      console.debug('[dsh-ling] memory-index skill registration failed', e);
      return false;
    }
  };
  if (!mount(ctx)) {
    try {
      ctx.inject?.(['skills'], (child) => { mount(child); });
    } catch (e) {
      console.debug('[dsh-ling] ctx.inject skills failed', e);
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (mounted || tries >= 20) { clearInterval(timer); return; }
      mount(ctx);
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    disposers.push(() => clearInterval(timer));
  }
  return disposers;
}
