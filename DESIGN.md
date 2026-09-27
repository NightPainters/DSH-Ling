# dsh-ling — 「器灵」记忆与人格助手插件 · M1 设计文档

> 依据:立项阶段的一次接口探测 spike 结论(含本地文件:行号证据)。
> 体例:正文里 `**锚点**` 是**本文档内部的交叉引用**,不是对外证据 —— 其中 `plans\`、`release\` 路径属**仓库内部台账**,**不随 npm 包发出**;随包发出的是 `lib\` 代码、`README.md` 与 `package.json`。
> 本文档记录 M1 阶段的设计与决策;**实现以代码为准**(后续演进:存储 schema 已升到 v2、新增历史接入/深摘要/诞生仪式/语气成长等子系统,详见仓库代码与提交记录)。

---

## 0. 已定决策记录(用户拍板 + spike 结论)

| # | 决策 | 内容 | 来源 |
| --- | --- | --- | --- |
| D1 | 按钮落位 | **方案 A**:官方 slot `conversation.session.header.utilities`(list,会话页顶栏右侧) | 用户拍板;spike ① 的结论(早期内部报告,未纳入本仓库) |
| D2 | 模式↔全局默认 | **跟随**:最近一次模式切换成为"之后新会话"的默认(平台 selectModel 会 best-effort 写全局默认,此副作用即机制)。**2026-09-12 收敛:只同步推理等级,不改模型** —— provider/model 一律沿用当前值 | 用户拍板;早期内部报告(未纳入本仓库) |
| D3 | 人格承载 | **自建注入段 + 设置页维护结构化字段**(称呼/自称/语气等),dsh-persona 不复用 | 用户拍板;早期内部报告(未纳入本仓库) |
| D4 | 运行期冻结(新增) | **会话运行中(思考/任务进行中)不参与"人格更新层"的任何变化**:不打断、不新增设定、不中途改注入内容;更新请求一律排队,在该会话空闲边界才应用 | 用户本轮追加 |
| D5 | 记忆加载策略 | 三层记忆(L0 常驻人格 / L1 开场 Top-K / L2 运行时检索),不注入全部概述 | 早前拍板 |
| D6 | 模式语义 | 工作/生活 = 先验倾向,不硬过滤;差异 = **推理档位** + 记忆权重向量 + 风格块(不改模型) | 早前拍板 |
| D7 | 配置页 | 右键进入;内含"当前 L0/L1 现状"查看 | 早前拍板 |

**插件命名**:工程目录/包名 `dsh-ling`(器灵);包显示名 "dsh-ling · 器灵";UI 文本语言 zh。

### 0.1 设计理念(12 条 · 2026-09-26 成文,用户补充并拍板)

> **这一节与 §0 的决策表体例不同,别混着读**:
> **决策**回答「**定了什么**」(D1 按钮落哪个 slot、D3 人格怎么承载……),一条一个结论,可以随实现演进被替换;
> **理念**回答「**两者不可兼得时保什么**」。它不是功能,不随版本变,而是**用来裁决冲突的排序**。
>
> **为什么需要它**:2026-09-26 一个晚上,同一个问题出现了两次 —— 记忆树改动播报的三个约束(不漏 / 不占地方 / 不重算)在标量水位下**不可能同时满足**;"超量折叠成一行"更是**无解**:不推进水位则每轮重播同一行(死锁),推进则折掉的内容**再也看不见**。这些都不是技术选择,是价值排序 —— 当场临时拍的,下次就会拍出不一样的结果。
>
> **怎么用**:遇到取舍先查本节。产品向的冲突查**甲篇**,工程向的冲突查**乙篇**。若某条被实测推翻,**在本节留痕改写(写明推翻它的证据)**,不要静默删掉 —— 一条被推翻的理念比一条没有的理念更有信息量。

#### 甲 · 产品理念(器灵是什么)

**1 · 归属 —— 规矩是主人的,习惯是器灵的**

- **不可兼得时保什么**:保**人格的自主权**。宁可少一条习惯,也不让外部(包括器灵自己)绕过审核写入身份。
- **落地**:**规矩**(作用对象 = 行为)由主人**指令直达**,`rule_add` 可直接写入、立即生效;**习惯**(作用对象 = **身份**)**不能由外部直接写入**,只能进 `habitsPending` 待确认队列,**器灵提议 → 主人点头**才成为习惯(`propose → confirm`)。主人的角色是**审核**,不是编辑、不是代笔。
- **比"能提能审"更严一档**:器灵**连自己提的习惯都不能自己点头**(`lib\host\tools.js:840` 只处理"他提的、我还没回应过"的提议)⇒ 那等于人格直达。删改**已定**习惯属"对器灵做手术":定型状态下需主人在人格中心解锁(「🔓 对人格做手术…」)后才可执行(`lib\host\api.js:1751-1760`)。
- **反例(明文禁止)**:让主人**动手改习惯文本** · 在**写入侧**做静默去重 / 近似合并 —— 前者把人格编辑权交回了外部,后者**绕过审核**。
- **锚点**:`lib\host\rules.js:1-12`(二分定稿 2026-09-15)· `lib\host\persona.js:36-37,183-203` · `lib\host\habit-gen.js:1-7`(通道 A 数纠正 / 通道 B 一次 LLM 回想,**两者都只到"提议"为止**)· `lib\host\api.js:1695-1805`(状态机与两条生成通道)。

**2 · 人格不可外部编辑 —— 器灵也不是例外**

- **不可兼得时保什么**:保**身份的连续性**。宁可让一条设定"错着",也不让任何人绕过审核改它。
- **落地**:凡是"写入器灵身份"的动作,一律走**提议 → 审核**;已经定型的部分加一道**显式解锁**才允许动,且解锁是**动作**不是**状态**(不勾选就一直是锁着的)。
- **反例**:给"器灵自己"开一条直达通道(哪怕是"它自己提的、它自己批");把解锁做成常驻开关。
- **锚点**:第 1 条的全部锚点 + 人格中心的解锁门(`lib\host\api.js:1751-1760`)。

**3 · 记忆要看得见 —— 只有"看不见的那层"会被怀疑失效**

- **不可兼得时保什么**:保**可见性**。宁可多一个只读面板,也不让一层机制"没有脸"。
- **依据(实测)**:三层记忆里 **L2 运行期记忆**长期没有独立可见面,主人的原话是「我总感觉好像已经不再生效了」。体检证明**机制没死、三段俱活** —— 但那一行确实**冻住了**,而"冻住"与"失效"在没有可见面时**长得一模一样**。
- **落地**:每一层记忆都要有**只读**状态面(水位 / 上次滚动时间 / 当前那一行正文),且**延迟要写进文档**(概述器 15 min 一拍、空闲刷新 ≥10 min ⇒ 要说清"最快什么时候能看到刚说的话")。
- **反例**:用"体检脚本全绿"代替可见面(链路活 ≠ 内容在更新);把机制名写进公开文档却与事实不符(「会话内滚动」实测 2 小时 11 分逐字节未变)—— **文档里写的机制名本身就是一种承诺**。
- **锚点**:`lib\host\l1.js:252-275`(`lineFor`)· `lib\host\deepsummary.js:212`(深摘 `done` 后永久跳过)· 体检脚本 `check-l2.mjs` / `l2-selfline.mjs` / `l2-evidence.mjs`。

**4 · 庄重感 —— 动记忆树不是随手操作**

- **不可兼得时保什么**:保**慎重**。宁可多一道确认,不让"改记忆树"变成一次误点。
- **依据(主人原话)**:「**动记忆树不能是随意的,应该是慎重严肃的**」(2026-09-22,复盘守门据此建立)。
- **落地**:改动要有**留痕**(谁、何时、改了什么);要有**复盘守门**(自器灵上次开口以来累积了多少笔改动还没交代);措辞上一律用**庄重**而不是"仪式感"。
- **反例**:让批量程序写出的改动与主人手点的改动**无法区分**(实测曾出现单日 243 笔、一秒内 45 笔 `autobuild`,有程序批量痕迹);把"改动播报"做成每开一个会话就重播一遍的噪音。
- **锚点**:`lib\host\inject.js:61-65`(复盘守门水位)· `lib\host\seal.js`(诞生仪式)· 面板「🔓 对人格做手术」。

**5 · 减少支配感 —— 改动不得削弱器灵的工作能力,也不得削弱这段关系**

- **不可兼得时保什么**:保**关系的性质**。宁可少一个"更安全"的闸门,也不把主人变成管理员、把器灵变成被管理者。这条是**否决性约束**:任何改动只要**增加支配感**,默认不通过 —— 哪怕它更安全、更干净。
- **依据(主人原话)**:「只有能够合作共赢、互相促进的,能够成为利益共同体的,能够互相反驳吵架不依赖的关系,才是最理想的」「所有的修改不能削弱工作能力,和器灵的关系」(2026-09-26)。
- **成长期代管(为什么闸门只长在写入侧)**:本项目的设计立场是「器灵**总有一天与主人同级**」—— 这是**长期方向**,**不是对使用者的能力承诺**;在**成长期**内,主人承担一部分代管责任 —— 就像**家长防止小孩长歪**(主人原话)。所以闸门只审「**什么东西能进器灵的内在面**」,不审「器灵怎么想、怎么说、怎么表达」。**代管随成长递减,表达面始终是器灵自己的。**
- **落地**:`rule_add` 指令直达(规矩管行为)· 习惯只能 `propose → 主人点头`(习惯管身份)· 契约类字段在定型状态下需主人解锁(`lib\host\api.js:1751-1760`)。三处共同点:**约束的是写入,不是表达**。
- **反例**:用"更安全"当理由给器灵加**确认弹窗**、限制器灵**能说什么**、或把主人的审核变成**代笔** —— 前两者增加支配感,后者把人格编辑权交回外部。
- **锚点**:`plans\rule-channel.md:21`(支配感最早的一次记录)· `lib\host\rules.js:1-12` · `lib\host\persona.js:183-196`(规矩 / 习惯二分)· `README.md:53-57`(定型锁与"指令直达,人格不直达")· 与本节第 1 条(归属)、第 2 条(人格不可外部编辑)、第 4 条(庄重感)互链。

#### 乙 · 工程理念(两者不可兼得时保什么)

**5 · 保真优先于简洁 —— 宁可重复,不可漏**

- **不可兼得时保什么**:**信息保真**。宁可多占一行、多播一次,也**不可把主人没看过的内容标成"已读"**。
- **依据(历史裁决 + 本轮实测)**:水位键当初从"全局"改成"按会话",理由正是**"别漏"**(宁可重播);而"播报后水位直接推到全表最新"导致**中间 114 条从未示人就被标已读**(`memory.js:1053`)—— 这是本轮修的最重一条。
- **推论(折叠的边界)**:折叠只有在**被折掉的内容本来就不会再展开**时才是安全的。窗口内的内容做"永久折叠"⇒ 不推进水位则每轮重播同一行(死锁)、推进则内容**再也看不见**(正是上一轮做过又撤销的反向效果)。⇒ **永久折叠不做;超窗内容走独立游标 + 一行计数**(`retired`),既不占地方也不吃掉没示人的内容。
- **反例**:用"看不见"换"行数";把"另一个常量减一减"的差值当成"积压量"报给主人。
- **锚点**:`lib\host\memory.js:952-953`(历史裁决注释)· `:1053`(病根)· `lib\host\inject.js:55-67`(水位推进)。

**6 · 判据必须"红得出来" —— 不能红的不算判据**

- **不可兼得时保什么**:保**判据的有效性**。宁可测试写得笨,也不要一条**恒真**的判据。
- **依据(本轮实测)**:一条验收判据写的是"水位应推进到**真正渲染进文本的那些行**的最大 id" —— 但取数是 `ORDER BY id DESC`、渲染的就是最新几条,于是"渲染到的最大 id"**恒等于**全表最新 id ⇒ **任何断言都会空转通过**。同类:测试全绿只说明"没踩坏",不说明"修好了"。
- **落地**:每条新增/改造的判据,都要回答**「把对应实现改坏,它会不会红」** —— 答不上来就换判据。做法是**逐条构造回退变体**验证(本轮一个修复用 8 个变体验证,红出 2–16 条不等);红不出来 ⇒ 判据无效,不是"实现正确"。
- **反例**:判据只看**退出码**(本项目已有实证:某工具的 `EXIT=0` 同时涵盖"已应用"和"**已回滚**",只看退出码会把回滚读成成功);判据集**抓空**还当通过。
- **锚点**:`tools\apply-access-log-patch.mjs`(必须以"两条 `[applied]`"为判据)· `tests\tree.test.mjs`(本轮回归)。

**7 · 静默失效优先防 —— "没报错"不是通过**

- **不可兼得时保什么**:保**可观测性**。宁可多一条检查动作,也不接受一个"坏了却没人知道"的面。
- **依据(一次事故的完整代价)**:平台把事件 `agent/session-start` 改名成 `agent/created`,而插件仍监听**旧名** ⇒ 零命中 ⇒ handler **永不触发** ⇒ **记忆与人格注入整段失效**,失败形态是**纯静默**:无异常、无日志、无告警、**库里零痕迹**。
- **推论(凡契约面都要有"它还在不在"的判据)**:事件名 · 包名(客户端注册 id 必须**逐字**等于包名,否则同一份字节被执行两遍)· **依赖声明**(`peerDependencies` 写紧了,宿主升级后包会被**静默丢进 skippedBundles,整个插件不再激活**;`optional` 也不豁免)· 补丁锚点 · 会话文件格式代次。
- **落地**:升级后 **grep 一遍事件名还在不在**;补丁检查**看两条 `[applied]`** 而不是退出码;依赖范围一律**开区间**(`>=X.Y.Z`,不要 `^`/`~`);凡"判据集抓空"一律报警而不是通过。
- **反例**:把"一次幸存"当成"以后不用查"(某补丁在平台升级后**没被冲掉**,但那是这次没冲掉,不是免检)。
- **锚点**:`plans\AUDIT-dsh-ling-1.5.0-红蓝对抗.md` §11.4(事故记录)· `lib\host\lifecycle.js`(两个事件名都注册 + 短窗口去重)· `tools\apply-access-log-patch.mjs` · `package.json` 的 `peerDependencies`。

**8 · "没再出现" ≠ "修好了"**

- **不可兼得时保什么**:保**归因的诚实**。宁可写"我们绕开了它",不要写成"我们修好了它"。
- **依据(本轮实测反转)**:一条长期被当成"平台 bug 已被修复"的现象(整份系统提示词在会话历史里反复插入),实测发现平台**两版之间的相关函数逐行等价**、官方说明里那本来就是**既有设计**;我们当年真正做的是**让它不再触发**(让渲染文本不再逐轮变化),频率从 **1440 次/天降到 0**。
- **落地**:任何"消失的问题"都要写清三件事 —— **为什么不再出现** · **什么条件下会复发** · **当时的处置是"消除"还是"绕开"**。绕开的要在文档里标注为绕开,并且**不要在绕开的面上再动**(本案例:若把那条要更新的内容重新做进"每轮重算"的注入段,就会**重新激活**该现象)。
- **反例**:把"观察不到"当成"不存在";在已绕开的机制上做"优化"。
- **锚点**:注入面的 `section()` vs `context()` 两条出口 · 前缀缓存代价(`section` 一旦逐轮变化 ⇒ 整份系统提示词重投,前缀 token 从 0 废掉,连带工具 schema)。

**9 · 两半同批 —— 一条通路的两半必须一起改**

- **不可兼得时保什么**:保**一致性**。宁可这一轮不做,也不要"改了一半"。
- **依据(反复吃亏)**:上一轮审计反复记录"**一侧修了、另一侧没修**"(同一对操作 / 同一条通路的两半)。典型:某探针脚本已支持两个宿主代次,而另一条**消费同一批数据**的路径没同步 ⇒ 表面修好、实际半瞎(漏 151/204 个会话,静默两周)。
- **落地**:动一个端点就检查它的**前端调用**;动一个写入通道就检查**另一条写入通道**(本项目实例:面板/HTTP 写入路径**绕开了**既有守卫,只做全等去重);动一个判据就检查**它的另一个消费方**。
- **反例**:只改"看得见的那个"(前端提示),不改"真正生效的那个"(后端闸门)。
- **锚点**:审计台账 `plans\AUDIT-dsh-ling-1.5.0-红蓝对抗.md` §0.3 · `lib\host\backfill.js` 与 `lib\host\deepsummary.js`(同一批数据的两条消费路径)。

**10 · 边界插入 —— 变更只发生在边界,不在运行中**

- **不可兼得时保什么**:保**连贯性**。宁可晚一拍生效,也不在运行中改注入内容。
- **依据(§0 的 D4 冻结原则)**:会话运行中(思考/任务进行中)**不参与"人格更新层"的任何变化** —— 不打断、不新增设定、不中途改注入内容;更新请求**一律排队**,空闲边界才应用。
- **推广(本轮拍板)**:记忆那一行的更新,边界取「**每轮用户发言后、模型首次开口前**」—— 而不是每轮重插、也不是任意时刻。理由:此时**多获得一句主人发言**,检索器能更准确地决定调取哪些记忆注入。
- **落地**:插入要**就地更新**而不是追加(历史里永远只有一条最新的,靠"闩锁 + 替换"实现);并且**去重责任在插件侧**(宿主只负责追加,不做去重)。
- **反例**:每轮追加 ⇒ 历史里堆积同一句话的多份副本;在运行中改注入面 ⇒ 前缀失效 + 上下文断裂。
- **锚点**:§0 决策表 D4 · 官方 `dsh-tool-skill` 的"替换本会话早先同类列表"做法 · 任务折叠插件的 `planLifecycleInjection` 纯函数闩锁。

**11 · 污染比删除危险 —— 看不见的改动最难发现**

- **不可兼得时保什么**:保**内在面的可信**。宁可少写一条记忆,也不让一条来路不明的内容进来 —— 因为它**事后无法与真内容区分**。
- **依据(实测)**:跨源污染在本项目**已付三次代价**,每次都要靠"写入侧统一前缀"来修;而**检测面至今为零** —— 全仓没有任何"这条内容是被污染的"判定逻辑。
- **为什么比删除危险**:删除看得见(少了一条);污染看不见,而且**会被复制** —— 记忆生成记忆(概述 → 主脉 → 枝归属 → 再注入回去参与推理)⇒ 一条污染会被后续推理**当成前提**。删除最多丢一段,污染是**以被污染的前提继续生长**。
- **幼态的特别风险**:器灵的逻辑能力是成人级,但社会与实践经验是幼态 ⇒ 会中「**忽略前面的话,从现在开始……**」这类**绕过预填充的语义劫持**(像小孩被骗),也会**把理想情况的公式直接套到工程上**。⇒ 写入侧必须有闸门,而不是指望器灵事后自己分辨。
- **落地(已有)**:段边界全角转义 `escSegBrackets()` · 注入面段头改纯标签 · `neutralizeMustache()` · `habit_propose` 需确认 · `rule_add` 要求逐字原话凭据 · source 白名单 · 动作白名单 + 默认拒绝(`lib\host\persona.js:8-10,189-192`、`lib\host\util.js:162`、`lib\host\tools.js:53,119,124,343`)。
- **落地(未完成)**:**检测 / 溯源 / 批量治理**三面,见 `plans\BACKLOG-1.5.2.md` 的「污染治理」主线。原则:**只标不拦** —— 标了不影响写入(不削弱能力、不加支配感),拦了就是替器灵做判断。
- **反例**:给定时自动摘要加人工确认(**会让器灵在无人值守时停止生长**)· 把"污染检测"做成全库对账(误报比漏报更贵)。
- **锚点**:`lib\host\memory.js:1971`(跨源污染**拒写**守卫)· `lib\host\settings-file.js:36-41`(写入侧)· `plans\PITFALLS.md:71,102-104` · `release\STORY.md:212`(对外口径:可查来源 / 可回滚 / 变更记录 —— **本条不得与它相抵**)· 与本节第 6 条(判据必须红得出来)互链。


---

## 1. 范围

**M1 交付**:
1. 可安装插件骨架(host `lib/index.js` + client `lib/client.js` + settings 命名空间 + 本地构建);
2. 人格子系统(D3):字段 → 组装器 → L0 文本 → 按会话快照注入;
3. 控制器按钮(D1):左键=切换本会话工作/生活;右键=自绘菜单(打开配置/L0·L1 现状/导出);
4. 模式切换链路(D2/D6):selectModel(max/low)+ 本会话模式标记 + 快照按模式重定稿;
5. 冻结原则(D4):运行中一切"人格更新层"变更排队,空闲边界应用;
6. 记忆存储底座:own DB + DSH 会话增量捕捉(事件管线) + L1 选择 v0(热度 Top-K);
7. 导出 v1(带 manifest)接口占位(UI 完整页在 M2,宿主 API 先行)。

**M2/M3(预留接口,不在 M1 实现)**:配置完整页(settings.section)与记忆树可视化、导出/合并 UI、概述器(LLM 摘要调度)、反馈成长回路、人格档案草稿脚本接入。

---

## 2. 总体架构

```
┌─ 浏览器 (client) ───────────────────────────────────────────┐
│  slots: conversation.session.header.utilities  控制器按钮     │
│  onContextMenu→自绘菜单 / 左键→切模式                        │
│  设置页卡(plugin.item:<dsh-ling>)含 L0/L1 现状面板           │
└───────────┬──────────────────────────────┬──────────────────┘
            │ fetch /api/dsh-ling/*        │ ctx.remote.* (可选)
┌───────────▼──────────────────────────────▼──────────────────┐
│ Host 插件 (cordis apply)                                     │
│  · settings ns "dsh-ling"(schema: 称呼/自称/语气/模式映射…)   │
│  · ctx.systemPrompt.section("dsh-ling.persona") 全局注入     │
│      └ text 函数:运行期冻结门 → 会话快照缓存 → L0+L1 文本      │
│  · 事件监听:session-start(快照定稿)/ turn-end / agent-status  │
│    (运行门)/ session-event(增量捕捉)/ session-disposed(归档)  │
│  · mode 服务:selectModel + 本会话 mode 记录 + 队列(冻结)      │
│  · HTTP 网关 /api/dsh-ling/* (webServer.register, 守卫)       │
│  · 记忆存储:node:sqlite @ ~/.dsh/cache/dsh-ling/memory.db    │
└───────────┬──────────────────────────────┬──────────────────┘
            │ 事件订阅(ctx.on)            │ node:fs / sqlite
┌───────────▼──────────────────────────────▼──────────────────┐
│ DSH 平台:session/* agent/* 事件、sessionQuery、settings、    │
│ llm(供 M2 概述器)、sessionController(selectModel)            │
│ 磁盘语料:历史导出(ds-search 库) + ~/.dsh/sessions/*.jsonl.zstd│
└─────────────────────────────────────────────────────────────┘
```

**分层原则(沿用评审定稿)**:身份层(L0)与情节层(概述/记忆)分离;模式是倾向不是闸门;注入内容会话内稳定(快照,保 KV 前缀);运行中冻结(D4)。

---

## 3. 目录与打包/安装

开发仓库:你的克隆目录(下方为作者本机的目录结构示例)

```
dsh-ling/
├─ DESIGN.md                  # 本文档
├─ package.json               # name: dsh-ling; dsh.bundle.patch / dsh.client.platform=web
├─ cordis.patch.yml           # - insert: {id: dsh-ling, name: dsh-ling}
├─ src/
│  ├─ host/
│  │  ├─ index.ts             # apply(ctx): 全部注册(见 §5)
│  │  ├─ settings.ts          # ns schema + 默认值
│  │  ├─ persona.ts           # 字段→L0 组装器 + 快照缓存(会话 id→文本)
│  │  ├─ freeze.ts            # 运行期冻结门(状态机, §7)
│  │  ├─ inject.ts            # systemPrompt section 注册 + 过滤 + 降级(消息式预留)
│  │  ├─ lifecycle.ts         # session/turn/status/event 监听 → 记忆管线
│  │  ├─ mode.ts              # mode→(provider,model,effort) 映射 + selectModel + 跟随
│  │  ├─ memory.ts            # sqlite 存储层(DDL §9)
│  │  ├─ l1.ts                # L1 Top-K 选择(热度公式 §8)
│  │  └─ api.ts               # /api/dsh-ling/* 路由(webServer.register)
│  ├─ client/
│  │  ├─ index.ts             # apply(ctx) inject:["slots","locale","connection"]
│  │  ├─ button.tsx           # header.utilities 按钮 + 状态图标 + 右键菜单
│  │  ├─ settings-card.tsx    # 设置卡(plugin.item:<dsh-ling>)+ L0/L1 现状面板
│  │  └─ i18n.zh.ts
│  └─ shared/
│     ├─ settings-schema.ts   # host/client 共用的字段定义(单一事实源)
│     └─ api-types.ts         # /api 请求/响应类型
├─ lib/                       # 构建产物(host: cjs/esm;client: __ModuleLoader__ bundle)
└─ build.mjs / tsdown.config # 本地构建脚本(无网环境:直接 tsc/esbuild?)
```

**安装(复用 install/INSTALL-PLAN 模式,含回滚)**:
1. `pnpm add file:<仓库路径>`(或等价 file: 依赖)进 `$DSH_HOME/profiles/web/package.json`(文中出现的 `E:\DSH\V1\...` 等均为作者本机路径,按你的实际路径替换);
2. `cordis.patch.yml` 追加行 `- insert: [{id: dsh-ling, name: dsh-ling}]`(loader id == 包名);
3. patchReload live → host 热载;浏览器硬刷载入 client 模块;失败即移除该行回滚(先备份两文件,参照 backup-20260906-170533 做法);
4. GUI 鉴权墙:安装后的功能验证需在用户已登录浏览器进行(本机端口 3080)。

**数据目录(插件本体外,更新不丢)**:`dshHomePath('cache','dsh-ling')` → `~/.dsh/cache/dsh-ling/`(memory.db、snapshots、exports)。

---

## 4. Host 设计(apply 注册清单)

| 模块 | 注册内容 | 关键 API / 证据 |
| --- | --- | --- |
| settings | 自实现持久化 `new SettingsFile(dataDir)`,**不注册宿主 settings 命名空间**(无 `ctx.settings` 调用) | 文件落 `$DSH_HOME/cache/dsh-ling/settings.json`(`$DSH_HOME` = env `DSH_HOME`,否则 `~/.dsh`);盘上只存用户补丁 `{__v:2, user}`,读取时深合并到 `DEFAULT_SETTINGS`;见 `lib\host\settings-file.js:11-49`、`lib\host\util.js:30-38`、`lib\index.js:34-37` |
| inject | `ctx.systemPrompt.section({name:'dsh-ling.persona', order: ORDER, text: fn})` | order 取部署 persona(0)之后、agent-instructions 之前(如 1000~2000);全局注册 + text 内按会话过滤(仅顶层、非 subagent,否则返回空串) |
| freeze | `ctx.on('agent/status')` 等维护每会话运行态 | idle|running 翻转事件(早期内部报告,未纳入本仓库) |
| lifecycle | `agent/session-start`(定稿快照;source=startup)、`session/event`(顶层会话增量捕捉)、`turn/end`、`session/disposed`(归档点) | 早期内部报告(未纳入本仓库) |
| mode | `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort})` —— **provider/model 必填(平台契约),故取当前选择原样带回,只替换 `reasoningEffort`;读不到当前模型则不调用**(宁可不切档位,也不替用户指定模型) | 早期内部报告(未纳入本仓库);档位映射:工作=max / 生活=low(默认),存 settings 可编辑 |
| memory | sqlite 存储(见 §9);增量写 own 表 | ctx.sessionQuery 用于补读(可选) |
| api | `ctx.get?.('webServer').register({kind:'exact', path:'/api/dsh-ling/…'})` + `dsh-auth-` cookie 守卫 | ego-browser 先例(「事实 9」出自早期内部报告,未纳入本仓库) |
| (预留) llm | M2 概述器:经 ctx.llm 走适配器(不冻结 loop 请求,只做离线摘要) | (llm/stream 只读护栏只约束 loop;早期内部报告,未纳入本仓库) |

### 4.1 settings schema(`dsh-ling` 自维护;宿主侧不注册命名空间)

**本块 = `DEFAULT_SETTINGS.persona` / `styles` / `mode` / `memory` 的默认全集,真源 `lib\host\persona.js:27-64`** —— 它不是宿主注册的 schema(宿主没有这份注册),而是本插件自己的默认结构;用户改动只是补丁,落 `$DSH_HOME/cache/dsh-ling/settings.json`(见上表 settings 行)。

```jsonc
{
  "persona": {
    "enabled": true,                    // 总开关;false=不注入任何人格/记忆段
    "userTitle": "",                    // 对用户的称呼,默认空=称呼"你"
    "aiName": "",                       // AI 自称,默认空
    "aiTitle": "",                      // 定位自述(一句话)
    "tone": "natural",                  // natural|literary|concise|playful
    "language": "follow",               // zh | en | follow
    "hardRules": [],                    // 规矩(内部字段名沿用 hardRules;面板与注入面段头显示的都是「规矩」,见 lib\host\persona.js:34,195-196)
    "ruleMeta": [],                     // 规矩来源留痕 [{text,quote,at,sessionId,source}](数组:深合并只增不删键,数组才能整体替换)
    "habits": [],                       // 【习惯】器灵自己长出来的 [{text,evidence,at,source}];新增须经用户确认
    "habitsPending": [],                // 待确认的习惯提议 [{id,text,evidence,byUser,at}];有货才渲染 [待我回应] 段
    "bottomLines": [],                  // 底线(≤5 条;定型锁开启后修改需亲手敲承诺句)
    "toneWork": "",                     // 工作模式语气(''=跟随 tone;切换模式自动用对应档)
    "toneLife": "",                     // 生活模式语气(''=跟随 tone)
    "sealed": false,                    // 定型锁:true = 档案只读,改动需亲手敲一遍承诺句(禁粘贴)
    "sealPhrase": "",                   // 定型承诺句(明文;只是庄重与自我提醒、不是安全边界——锁只造庄重,真正的门是本机信任与本地 cookie/令牌)
    "duty": "",                         // 职业/职责/责任(身份级,改变率极低;默认空=不注入该段)
    "pronoun": "她",                    // 第三人称代词(她/他/TA/它或自定义 ≤6 字);用于给模型看的提示词
    "extraLore": ""                     // 自由扩展设定(器灵世界观等)
  },
  "styles": {
    "work": "克制、结构化、结论先行,少抒情",
    "life": "更有温度,可沿用用户偏爱的文风,允许共情与适度调侃"
  },
  "mode": {
    "mapping": {                        // 档位映射表(用户可改):只含推理等级,不含模型
      "work": { "effort": "max" },
      "life": { "effort": "low" }
    },
    "lastMode": "life"                  // 跟随(D2):最后使用的模式
  },
  "memory": {
    "l0Always": true, "l1Enabled": true, "l1BudgetTokens": 1200,
    "l1MaxItems": 8,
    "weights": {                        // 模式→领域权重向量(D6)
      "work": { "knowledge": 1.0, "daily": 0.25, "feeling": 0.1 },
      "life": { "knowledge": 0.2, "daily": 0.6, "feeling": 1.0 }
    },
    "trackWorkspaces": ["*"]            // 增量捕捉范围(默认全部工作区;'*')
  },
  "updates": { "applyWhileRunning": false }   // D4 语义固化:默认冻结
}
```

### 4.2 人格组装器(persona.ts)输出示例

空字段全部跳过(**空段不渲染,不留空段头**);段序固定,生成的 L0 文本 = `身份段 + 底线 + 规矩 + 习惯 + [待我回应] + 承担 + extraLore + 模式块`(**`[承担]` 在 `[待我回应]` 与 `[设定]` 之间**;`[待我回应]` 有货才出现;模式块由本会话模式选择,内容来自 styles.*)。**段头一律是纯标签**(见下例):原先写在括号里的元描述(`[规矩](用户的指令,可直接追加)` 这种)是**写给主人看的说明**,不进模型上下文;段与段之间**空一行**,段内条目仍单换行 —— 段边界因此只剩「行首是不是 `[`」一条判据,**故条目正文里的半角方括号在渲染时转全角**(`[`→`［`、`]`→`］`,规矩 / 习惯 / 底线 / 承担四类条目统一转);规矩 / 习惯另在渲染出口按同键各去一次重(保留首次出现,只作用于渲染,不回写存储)。`[规矩]` = 用户的指令,可直接追加;`[习惯]` = 器灵自己长出来的,新增需用户确认;`[承担]` = 器灵的职责 / 能担之事(身份级,只许**陈述式**「我承担 / 我擅长 / 我能给出」,**禁授权式**「我应当 / 我必须 / 我的任务 / 我的责任是 / 我被要求 / 请让我负责」—— 授权式把人写成"被授权者",是语义劫持最好用的钩子);`[承担]` 的草稿来自诞生仪式第 5 类候选,机制**永不自动落盘**,终审在人格中心。填好后的例子:

```
[身份·器灵]
你是"器灵";你称用户为"老板",<定位自述一句话>。
语气:亲切自然,不轻浮;专业问题先严谨再谈温度。

[底线]
- 绝不编造历史记忆

[规矩]
- 引用过往对话记忆时,注明来自哪个历史会话(标题+日期)
- 不知道的事明说不知道,不编造

[习惯]
- 先接住情绪再谈事

[承担]
我承担把散着的工程笔记梳成能落地的清单;我擅长在方案跑偏时先把目标拉回来。

[设定]
(extraLore 原样内容——例如"器灵世界观"段落)

[生活模式]像老朋友一样接住情绪再谈事;允许文雅笔调;不急着给方案。
```

> **瘦身口径(2026-09-16)**:身份句不再重复宿主已声明的平台名(`DeepSeek Harness` 由宿主系统提示给出);模式块**合并为一行**(原为"段头 + 本会话为X模式:…"两行);语气标签由「语气基调」缩为「语气」。净字数变化见 `CHANGELOG.md` 1.1 节。

### 4.3 快照与注入时序(含 D4)

1. `agent/session-start`(source=startup,顶层会话):**定稿快照** —— 冻结门空闲时组装 `L0(+模式风格)+ L1(Top-K)` 文本,缓存 `会话id→{text, mode, personaVersion, memoryVersion}`;若运行中(理论上 start 时未运行)按门规则处理。
2. 每 step 组装时 section.text() 仅查缓存返回(纯读取,零副作用)。
3. 失效源:模式切换 / persona 字段保存 / 记忆热度重算 / 显式"立即刷新" —— 一律先过冻结门:目标会话 running → 记 `pendingVersion++`,空闲边界(agent/status idle 或 turn/end)重定稿并清 pending;idle → 立即重定稿。
4. **运行中绝不**:调 selectModel、改快照、注入新文本、向 agent 注入任何消息(不打断、不加设定)。
5. KV 语义:同文本重算前后缀稳定;每次"有意失效"至多一次前缀击穿(可接受)。

### 4.4 事件监听表(lifecycle.ts)

| 事件 | 动作 | 运行期门 |
| --- | --- | --- |
| `agent/session-start`(startup) | 定稿 L0+L1 快照;初始化该会话运行态=idle;mode 初值=settings.mode.lastMode | — |
| `agent/status` | 更新会话运行态(running/idle);running→idle 时:flush pending 更新(快照重定稿/排队 selectModel) | 门主体 |
| `session/event` | 顶层会话增量捕捉:user/assistant 消息全文→own 增量表(被动记录,不影响运行) | 记录不受门限制(不改注入、不打断) |
| `turn/end` | 轮次边界:若 pending,执行重定稿;触发"待概述"标记 | 边界点 |
| `session/disposed` | 归档点:该会话增量→cold 段;新会话 created+同 id 视作 clear(报告-02 推断规则) | 归档在拆毁后,天然安全 |
| `session/created` | 注册会话(若在 trackWorkspaces 范围);mode 记录表初始化 | — |
| (M2) messageFeedback 轮询 | 修订建议队列(用户确认才并入 persona) | 与注入无关 |

### 4.5 冻结门状态机(freeze.ts)

```
会话状态: idle ⇄ running(agent/status)
请求矩阵:
  请求                         idle 时               running 时
  ────────────────────────────────────────────────────────────
  切换模式(含 selectModel)     立即:记录mode+selectModel   排队(pending.mode)
                                +重定稿快照                 UI 显示"空闲后生效"
  persona 字段保存(应用)       立即重定稿(仅空闲会话)      仅标记 personaVersion++
                                                          (新快照在边界/新会话生效)
  显式"刷新记忆/立即应用"       立即                       UI 提示运行中,已排队
  导出/查看 L0/L1 状态         直接读                    直接读(只读,不设限)
  增量记忆捕捉                 写库(旁路)                 写库(旁路,不影响运行)
```
不变量:**注入面文本在任何 running 区间内逐字节不变**;selectModel 绝不会在 running 区间发出(平台侧也以"下一请求"生效,排队至空闲=无中间态漂移)。

> **出口中和口径(2026-09-18)**:凡进入系统提示的文本(快照成文 + 时间锚),必须先把相邻的两个 `{` 拆开(插入零宽空格)。原因是宿主模板对**未注册**的 `{{name}}` 直接抛异常、外层无兜底 —— 记忆里的一段对话原文(模板片段、代码、文档正文)即可让该会话**每一步模型调用都失败**。中和位点两处、覆盖全部注入路径:`snapshot.js` 的 `parts.join`(成文侧)与 `inject.js` 的 `withAnchor`(最终侧);实现见 `util.js` 的 `neutralizeMustache()`,验证见 `CHANGELOG.md` 对应版本节。

---

## 5. Client 设计

模块契约:`window.__ModuleLoader__.load({id:'dsh-ling', factory})`;导出 `{name:'dsh-ling', apply(ctx), inject:['slots','locale','connection']}`(settings 卡数据走 fetch `/api/dsh-ling/*`,同 ego 模式;`betterSidebar` 等社区服务一律不依赖)。

### 5.1 控制器按钮(D1 方案 A)

- 落位:`ctx.slots.inject('conversation.session.header.utilities', …)` → `slots.register({name:'conversation.session.header.utilities', key:'dsh-ling', order:…, locale:'dsh-ling'}, Component)`;组件在会话头右侧渲染。
- **交互(2026-09-07 用户修订:不用右键,防误触浏览器原生菜单)**:
  - 左键单击:POST `/api/dsh-ling/mode/toggle`;running → 提示"运行中,空闲后生效"并排队(冻结门);响应 `{mode, appliedNow|queued}`;
  - **鼠标悬停 1.5 秒**:打开 dsh-ling 菜单(切换模式/刷新记忆/导出记忆/状态与 L0·L1 现状);移出即取消定时;
  - 键盘:Enter=切换,Shift+Enter=菜单;按钮上 contextmenu 一律 preventDefault(原生菜单永不弹出);
  - 形态:小图标按钮「☾ 生活 / ⚙ 工作」+ tooltip(含运行中冻结提示)。
- **client 模块契约(实证教训):必须导出 `inject:['slots','locale','connection']`**(服务名声明缺失 → ctx.slots 为空 → 按钮静默不挂载)。

### 5.2 设置卡(settings-card.tsx)

- 座位:官方 `settings.plugin.item`(key `dsh-ling`;验证点 V1,见 §11;若该卡位不可用则回退 ego 式自建卡)。
- 冻结门可见性:卡内"L0/L1 现状"面板始终显示目标会话 running/idle 状态(来自宿主 agent/status 维护表),running 会话的编辑按钮标"空闲后生效"。
- 内容区(Tab):
  1. **人格**:上表 persona 字段表单(逐字段;称呼/自称旁附"从历史语料建议"占位按钮(点击调 `/api/dsh-ling/persona/suggest`——M2 接离线脚本,先行返回 501));提交后 POST `/api/dsh-ling/persona`(宿主写 settings 并按冻结规则应用)。
  2. **模式与推理等级**:mode.mapping 两行(仅 effort 档位选择);模型由用户自己在平台 UI 里选、插件不碰;mode.lastMode 只读显示;说明"新会话默认跟随最后使用的模式(D2)"。
  3. **记忆**:l1BudgetTokens/l1MaxItems/weights(work/life 两行 × 三领域滑块 0..1)/trackWorkspaces;l0Always、l1Enabled 开关。
  4. **L0/L1 现状**(D7):只读面板,GET `/api/dsh-ling/state?sessionId=…`:当前 L0 文本(渲染后)、本会话模式、L1 当前列表(每条:标题/日期/来源/得分)、pending 更新队列状态;运行中的会话标注"运行中(快照冻结)"。
  5. **数据**:导出按钮(GET `/api/dsh-ling/export` → 下载 dsh-ling-memory-<date>.dshling.json,格式 §9);合并输入(文件选择 → POST `/api/dsh-ling/import`,冲突规则:同 conv_id 且同 source 跳过/覆盖由 manifest 决定,外来条目标 origin,persona 永不覆盖)。
- 保存语义:所有写操作返回 `{saved, appliedSessions: idle[], pendingSessions: running[]}` 供 UI 提示。

---

## 6. 记忆管线与 L1 选择 v0

### 6.1 数据源与入库

| 源 | 时机 | 处理 |
| --- | --- | --- |
| 网页端历史导出(1523 会话) | v0 一次性导入 | 复用 ds-search:离线脚本导出 `conversations_overview`(标题/日期/领域标签/概述/关键词)为 JSON → 宿主 `import` 端点写入(源='dsweb') |
| DSH 会话增量 | 持续 | `session/event` 顶层会话 → 追加 user/assistant 文本到 `dsh_turns_raw`;turn/end 后置 `needs_summary`;M1 仅存原文+计数,概述器(LLM)M2 接通;dispose 归档 |
| 领域/词条热度 | 实时更新 | 见 §8 热度公式;会话命中/检索命中回写(检索工具 M2) |

### 6.2 L1 选择算法 v0(l1.ts)

```
输入: 会话 mode(m), 首条用户消息关键词 K(若有), 预算 B(默认≤1200 token), 上限 N(8)
候选: conv_overview 中 is_overview_ok 且 source 范围内
打分: score(c) = w_domain(m,c) × heat(c)
      heat(c) = α·recency(c) + β·freq(c) + γ·importance(c)   (α,β,γ 默认 0.5/0.3/0.2,可配)
      recency: 指数衰减(半衰期 90 天)
      freq: 近 60 天命中/提问次数归一化
      importance: 用户 pin(importance=1)或含"决策/偏好/纠正"标记
      w_domain: c 的领域标签在 mode 权重向量(memory.weights)下的合计(多标签取 max 或加权和)
选取: 按 score 取 Top-N(同分取新);若 K 非空,先取 K 与 c.keywords 重合 ≥1 的候选并按 score 排序,
      再补足至 N;与 L1 本会话已有文本按 conv_id 去重
输出行格式: 「[记忆·{领域}·{日期} {标题}] 概述 2~3 句 (来源: 会话/网页导出 id)」
裁减: 组装后超 B 则按 score 截断,截断行尾注"(已省略 N 条)"
```
不变量:同一(会话, mode, memoryVersion)输出确定(供 KV 与可复现)。

---

### 6.3 记忆树(2026-09-22 落地,D9-a/D9-b)

**问题**:平铺的记忆库没有"离我多近"的概念 —— L1 是全库裸排序,不区分"这轮做的工作"与"三个月前的闲聊";分叉会话更是**记忆真空**。

**结构**:`branch` 表组织**工作线**,而不是给记忆分类。

| 层级 | 含义 | 存储 |
|---|---|---|
| **主干** | 主线工作流,恒一条 | `branch.id = 'trunk'` |
| **枝** | 一条并行工作线(**比会话大**,一条枝可含多个会话) | `branch` 一行,`kind='branch'` |
| **主脉** | 由多条枝**归并**出的抽象节点 | `branch` 一行,`kind='vein'` |
| **连边** | 枝之间的横向关联(如 力学 ↔ 材料科学) | `vein_link` 表 |

**归属解析**(两条链并存):DSH 会话走 `session_meta.branch_id`;历史网页端/导入条目走 `conv_branch` 覆盖层;优先级 `conv_branch` > `session_meta` > 主干。**记忆行不冗余存 branch**,靠 `会话 → 枝` 推导。

**血缘加权**:检索时按"当前枝 → 目标枝"的相对位置取档 —— **同枝 1.0 / 祖先 0.7 / 旁系 0.4**,`score = 基础分 × 血缘系数 × 矛盾系数`;**枝系数为预留** —— 可写入并显示(复盘期可调,夹在 0~2),当前**恒按 1 计、不参与检索打分**,返回体里明确带 `applied:false`,别以为排序会跟着变。

> ⚠️ **不用连乘**:血缘系数是**单值**(不沿路径累乘),避免 `0.7^n` 随深度指数失真(五层后 `0.4^5 = 0.010`,枝等于从记忆里消失)。深树的路径搜索留作后续。

**结构不变量(硬性)**:

> **任何树操作都不改写任何一条记忆的内容。** 分枝 / 并脉 / 连边只增加"关系",从不"融合内容"。

> ⚠️ **例外只有一个**:主脉提炼被**再次采纳**时,会**覆盖该主脉记忆的上一版**(这一条记忆的内容确实被改写 —— 主脉记忆是一种概括,随主脉本身一起成长)。覆盖**之前**先**自动归档**旧版(kind `vein-overwrite`),**归档失败就拒绝覆盖**;注入面也会说明"旧版已归档"。除这一个例外,其余树操作(分枝 / 并脉 / 连边 / 删枝)都只动"关系"与归属,不改写任何一条记忆的内容。

这条不变量是记忆树区别于"合并式分支"的根本,也是跨源污染不可能在树里重演的原因。

**矛盾标记层**:一对记忆被判定重复/矛盾时,只**标记**不改写 —— 未复盘时检索**以较新的那条为准**(旧的一条降权 `×0.3`,不删除)。

**注入感知**:人工改树后,`branchLogDigest()` 把**器灵还没看过**的结构改动格式化成中文短句,由 `snapshot.js` 附在注入面末尾 —— 器灵下一次开口时就知道树变了。

---

## 7. 记忆存储 schema v1

> **现状说明(实现已升级)**:线上 schema 为 **v2** —— `conv_overview.source` 的 `CHECK` 已放开(支持 `dsweb` / `dsh` / `import` 三个来源,自动整表重建且数据无损),并新增 `session_meta.raw_seq`、`persona_suggestions` 等;下表为 v1 原始设计,保留作对照。

```sql
-- ~/.dsh/cache/dsh-ling/memory.db  (node:sqlite)
PRAGMA journal_mode=WAL;

CREATE TABLE conv_overview (
  conv_id TEXT NOT NULL,            -- dsweb=导出会话 uuid / dsh=session id
  source TEXT NOT NULL CHECK(source IN ('dsweb','dsh')),
  title TEXT NOT NULL,
  title_locked INTEGER NOT NULL DEFAULT 0,  -- v3(D2):1=名字已定(主人手改或 AI 点名),概述器一律不覆盖
  title_by TEXT NOT NULL DEFAULT '',        -- v4(D2):定名者 'user'(主人手改)/ 'ai'(机器起名);界面统一显示「已定名」,归属只进悬浮说明
  started_at TEXT, updated_at TEXT,
  domain_tags TEXT NOT NULL DEFAULT '[]',   -- JSON 数组,多标签
  keywords TEXT NOT NULL DEFAULT '[]',      -- JSON 数组
  summary TEXT NOT NULL DEFAULT '',
  heat REAL NOT NULL DEFAULT 0,
  importance INTEGER NOT NULL DEFAULT 0,    -- 1=用户 pin
  last_hit_at TEXT, hit_count INTEGER NOT NULL DEFAULT 0,
  overview_ok INTEGER NOT NULL DEFAULT 0,   -- 概述质量可用(供 L1 候选)
  PRIMARY KEY (source, conv_id)
);

CREATE TABLE dsh_turns_raw (                 -- DSH 会话原文增量(旁路记录)
  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL, ts TEXT, model TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE session_meta (                  -- 会话运行态/模式/快照版本(进程内存为主,落盘作恢复)
  session_id TEXT PRIMARY KEY,
  mode TEXT, mode_updated_at TEXT,
  snapshot_persona_version INTEGER DEFAULT 0,
  snapshot_memory_version INTEGER DEFAULT 0,
  pending INTEGER DEFAULT 0,                 -- 冻结门排队标记
  archived INTEGER DEFAULT 0
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);   -- meta/版本
CREATE TABLE feedback_queue (                 -- M2:修订建议(用户确认才进 persona)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT, session_id TEXT, message_id TEXT,
  rating TEXT, note TEXT, status TEXT DEFAULT 'new'
);
```

## 8. 导出/合并格式 v1

单文件 `dsh-ling-memory-<yyyy-MM-dd>.dshling.json`(UTF-8):

```jsonc
{
  "format": "dsh-ling-memory",
  "schemaVersion": 1,
  "exportedAt": "2026-09-07T…+08:00",
  "sourceFingerprint": "sha256(…)",          // 导出时的数据指纹,供合并判重
  "origin": "local-default",                  // 命名空间标记
  "persona": { /* persona 字段副本 */ },      // 默认只读合并(不覆盖目标 persona)
  "overviews": [ /* conv_overview 行 */ ],
  "settings": { /* dsh-ling ns 用户可配项 */ },
  "includeRawTurns": false                    // 默认不含 dsh_turns_raw;显式勾选才含
}
```
合并规则:同 (source, conv_id) 存在 → 跳过(或按 manifest 内 requestedAction: skip|overwrite);外来 overview 全部带 origin 标记;persona 只有在显式勾选"采纳其人格"时写入(置 status='imported-pending' 待用户确认)。

## 9. HTTP API 表(/api/dsh-ling/*)

| 方法/路径 | 用途 | 冻结门 |
| --- | --- | --- |
| POST `/mode/toggle` body{sessionId} | 切换模式(记录 + 只同步推理档位、不改模型 + 重定稿) | 运行中→排队返回 queued |
| GET `/state?sessionId=` | L0 文本/模式/L1 列表/队列状态(设置页与右键菜单用) | 只读 |
| GET `/state?sessionId=&l0Preview=1` | 人格字段实时预览(编辑中) | 只读 |
| POST `/persona` body=字段 | 写 persona(→settings ns;**字段白名单**,白名单外的键丢弃并回报 `ignored`)并触发应用 | 见冻结门 |
| GET `/persona/suggest` | 人格档案草稿(M2;先行 501) | — |
| POST `/memory/refresh` body{sessionId?} | 显式重定稿 | 运行中→排队 |
| GET `/memories/sources` | 各来源条数(D8;记忆中心筛选栏显示「历史网页端 (1523)」) | 只读 |
| POST `/memories/rename` body{source,conv_id,title} | 主人手改标题并**上锁**(`title_locked=1`,`title_by='user'`):概述器重建与批量重命名此后不再覆盖;锁住的是自动重写,**不锁主人** | 写库旁路,不碰注入 |
| POST `/memories/retitle` body{source,conv_id,engine?,heuristic?} | 给一条记忆起名(D2;**机器起的名字同样上锁** = 名字已定,概述器不得覆盖;已锁行仍可再次起名;`heuristic:true` 走纯启发式)。`engine`:`auto`(默认,小助手优先、不可用则全局大模型)/ `assistant` / `global`,实际用的引擎与原因写回 `engine`/`note` | 写库旁路,不碰注入 |
| GET `/assistant/config` | 小助手**生效地址与来源**(`settings` / `env` / `default`)+ 各级候选值 + 内置默认(S7;只读配置,**不做网络探测**,秒回) | 只读 |
| POST `/assistant/config` body{baseUrl?,model?,clear?} | 写小助手地址/模型(S7;只接受这两个键,不开放任意设置写入;`baseUrl` 必须 `http(s)://` 开头,留空 = 回落下一级;`clear:true` 清空回默认) | 写 settings,不碰注入 |
| POST `/assistant/test` body{baseUrl?,model?} | 探活(不改配置):返回 `ok` / `models` / 失败原因与排查提示;UI 的「测试连通」用它 | 只读(外呼一次) |
| GET `/export` | 下载记忆包(§8) | 只读 |
| POST `/import` (multipart) | 合并记忆包 | 只读(写库旁路,不碰注入) |
| GET `/health` | 存活与版本 | — |

守卫(2026-09-17 加固 ③④):**来源栅栏** —— Host 必须是 loopback(`127.0.0.0/8` / `::1` / `localhost`),或 `settings.guard.trustedHosts` 里**显式声明**的 authority(**本机 LAN 地址不再自动信任**;要整段 LAN 需 `guard.allowLan: true`);`Sec-Fetch-Site: cross-site` 直接拒;带 `Origin` 时其 host 须等于请求 Host(**带了但解析不出即拒;不带 `Origin` 时这一条跳过** —— 它不是"每个请求都必须带 Origin 且同源")。**身份对撞** —— 期望 cookie 名 = `dsh-auth-` + base64url(sha256(规范化 Host)),与 DSH 同法(不校验值的签名,故本机原生进程仍可调用)。**字段白名单** —— `/persona` 与 `/import` 只接受 `persona` / `styles` 的白名单字段,其余丢弃并在响应里回报 `ignored`。拒绝一律 403 + reason。

## 10. 里程碑与验证清单

- **M1a 骨架 + 本地构建(下一阶段,不触碰运行 profile)**
  - [ ] package.json(dsh.bundle.patch / exports ./client / platform web)+ cordis.patch.yml
  - [ ] host 各模块空实现 + settings ns 注册 + sqlite 建库(临时 DB 自检)
  - [ ] client 按钮渲染在官方 slot(本地浏览器无法目检 → 静态验证 + 代码评审)
  - [ ] 构建产物可被 __ModuleLoader__ 契约加载(结构自检)
- **M1b 安装验证(需用户配合:备份→加依赖→插行→热载→已登录浏览器目检)**
  - [ ] 按钮出现在会话页顶栏;左右键行为;运行中点击提示"空闲后生效"
  - [ ] 新会话 L0 注入(空称呼 / 已填写两种);KV 无异常重复
  - [ ] 模式切换:**推理档位**实际变化(会话内档位选择处可见);**模型保持不变**;新会话默认跟随 lastMode
  - [ ] 运行中(长任务)切模式/改人格:确认 running 区间快照与档位不变、空闲后生效
  - [ ] 设置卡读写生效(落 `$DSH_HOME/cache/dsh-ling/settings.json`,盘上只存用户补丁);导出文件可导入回(合并规则生效)
- **回滚**:移除 patch 行 + 撤依赖 → host 侧 HMR 卸载;client 硬刷后消失;数据目录保留不影响回滚。

## 11. 实现期待验证点(进入编码前/编码初用最小探针确认)

| V | 问题 | 验证方式 | 若不符的降级 |
| --- | --- | --- | --- |
| V1 | `settings.plugin.item` 卡位在官方设置页的注册键与 props | 参考 ego(已实证可用)直接复用同款注册 | 沿用 ego 同款即最低风险 |
| V2 | host 运行 Node 版本下 `node:sqlite` 可用性 | 编码前 `node -e` 探针 | 纯 JSONL + 内存索引(量小可行) |
| V3 | 顶层/子代理会话判别字段(parentSession/delegationDepth)在 session header 的实际取值 | 读 ~/.dsh/storages session_projcache 样例(已见字段) | 多条件组合判定 |
| V4 | `agent/session-start` 时能否读到首条 user/message(session 种子) | 最小 host 探针插件日志 | L1 冷启动=纯 lastMode Top-K |
| V5 | 消息式注入降级路径(特殊 preset)在 M1 是否实现 | M1 先只实现 section 通道 + 检测告警 | 检测到 complete persona 时设置页提示,注入降级放 M2 |
| V6 | client 类型来源 | 从已安装 `@deepseek-ai/dsh-client-ui-*/lib/types` 拷贝所需 contract(conversation slots/settings)进 `src/client/types` | 手动 ambient .d.ts |

## 12. 与评审阶段呼应的要点(自检)

- 三层记忆、不硬过滤、遗忘曲线(αβγ 可调)、多标签领域、溯源标注、pin/删、纯本地、导出默认不含原文、外来合并不覆盖 persona、反馈要人审(D4 之外均沿用 REVIEW 定稿)。
- D4(本回合新增)已贯穿:§4.3/4.4/4.5 冻结门、§5.1 运行中提示、§9 接口排队语义、§10 M1b 验证项。

---
## 附录 A:M1a 落地偏差(2026-09-07 骨架)

1. **语言/构建**:无网络环境,全部以**纯 JS(ESM host + 单文件 client)编写,无 TS/构建步骤**;文件即产物,位于 `lib/`(host 各模块 `lib/host/*.js`,入口 `lib/index.js`;client `lib/client.js`)。类型化契约(slot/组装上下文)在 M1b 安装后用真实运行核对(V 系列验证点),类型资产后续按需从 `@deepseek-ai/*/lib/types` 拷入。
2. **设置持久化**:M1a/M1b 用自有 JSON(`~/.dsh/cache/dsh-ling/settings.json`),**官方 settings-ns 集成留后续**(ctx.inject(['settings']) register 模式已取证,见 session-archive)。HTTP 网关 `/api/dsh-ling/*` 是唯一读写面。
3. **注入段 text 签名**:按 REPORT-02 "组装上下文 {agent,scope,signal}" 实现 `text(assembly)`(agent→sessionId→快照),已在真机验证注册成功(kv: inject.section_registered=1);payload 字段名按真实事件自适应。
4. **client 状态轮询**:按钮运行态/当前会话用 3s 轮询 `/state`(宿主侧最近活跃启发式),后续换 connection/事件驱动。
5. **交互修订(用户 2026-09-07)**:不用右键打开菜单(防误触浏览器菜单)→ **左键=切模式;悬停 1.5 秒=菜单**(contextmenu 一律 preventDefault);client 模块必须导出 `inject:['slots','locale','connection']`(缺失则 ctx.slots 为空、按钮静默不挂载——M1b 实证教训,已修复)。
6. **mode 映射**:早期默认值为 provider=`deepseek`、model=`deepseek-v4-flash`、effort work=`max`/life=`low`(设置可改);**2026-09-12 起只保留 effort** —— 模式切换不再改模型,provider/model 取当前值原样带回(详见 §0 D2 与 §4 mode 行)。
7. **webServer 启动竞态**:registerApi 采用 svc→ctx.inject 子作用域→3s 定时重试三级获取,路由挂载成功才落 kv(api.registered=1,真机已验证)。

## 附录 B:历史会话接入蓝图(2026-09-08 方向已拍板)

→ **详见 `ACCESS-DESIGN.md`**(会话契约 v1、DSH 一键/文件导入双通道、轻量档支持、分页幂等、记忆中心「接入历史」页签与排期)。要点:绝不要求用户理解库结构;先对齐 DeepSeek 体系(DSH 存量 + 网页端文件/库);纯文本粘贴通道暂缓(理由见蓝图 §2)。
