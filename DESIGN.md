# dsh-ling — 「器灵」记忆与人格助手插件 · M1 设计文档

> 依据:M0 spike 报告(`E:\DSH\V1\spike\REPORT.md` 及四份子报告,均含本地文件:行号证据)。
> 本文档为 M1(骨架 + 人格子系统 + L0 注入 + 按钮/模式切换 + 冻结原则)的实现设计;M2/M3 能力列为后续阶段,仅作接口预留。

---

## 0. 已定决策记录(用户拍板 + spike 结论)

| # | 决策 | 内容 | 来源 |
| --- | --- | --- | --- |
| D1 | 按钮落位 | **方案 A**:官方 slot `conversation.session.header.utilities`(list,会话页顶栏右侧) | 用户拍板;spike ① |
| D2 | 模式↔全局默认 | **跟随**:最近一次模式切换成为"之后新会话"的默认(平台 selectModel 会 best-effort 写全局默认,此副作用即机制) | 用户拍板;report-03 |
| D3 | 人格承载 | **自建注入段 + 设置页维护结构化字段**(称呼/自称/语气等),dsh-persona 不复用 | 用户拍板;report-04 |
| D4 | 运行期冻结(新增) | **会话运行中(思考/任务进行中)不参与"人格更新层"的任何变化**:不打断、不新增设定、不中途改注入内容;更新请求一律排队,在该会话空闲边界才应用 | 用户本轮追加 |
| D5 | 记忆加载策略 | 三层记忆(L0 常驻人格 / L1 开场 Top-K / L2 运行时检索),不注入全部概述 | 早前拍板 |
| D6 | 模式语义 | 工作/生活 = 先验倾向,不硬过滤;差异 = 模型档位 + 记忆权重向量 + 风格块 | 早前拍板 |
| D7 | 配置页 | 右键进入;内含"当前 L0/L1 现状"查看 | 早前拍板 |

**插件命名**:工程目录/包名 `dsh-ling`(器灵);包显示名 "dsh-ling · 器灵";UI 文本语言 zh。

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

开发仓库:`E:\DSH\V1\dsh-ling\`

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
| settings | `ctx.settings.register('dsh-ling', schema, {base})` | settings ns 落 `$DSH_HOME/settings.yaml`(report-04) |
| inject | `ctx.systemPrompt.section({name:'dsh-ling.persona', order: ORDER, text: fn})` | order 取部署 persona(0)之后、agent-instructions 之前(如 1000~2000);全局注册 + text 内按会话过滤(仅顶层、非 subagent,否则返回空串);report-02/R5 |
| freeze | `ctx.on('agent/status')` 等维护每会话运行态 | idle|running 翻转事件(report-02) |
| lifecycle | `agent/session-start`(定稿快照;source=startup)、`session/event`(顶层会话增量捕捉)、`turn/end`、`session/disposed`(归档点) | report-02 |
| mode | `ctx.sessionController.selectModel({sessionId, provider, model, reasoningEffort})`;`modelCatalog()`/`resolveCallConfig` 预检 | report-03;effort 映射:工作=max / 生活=low(默认),映射表存 settings 可编辑 |
| memory | sqlite 存储(见 §9);增量写 own 表 | ctx.sessionQuery 用于补读(可选) |
| api | `ctx.get?.('webServer').register({kind:'exact', path:'/api/dsh-ling/…'})` + `dsh-auth-` cookie 守卫 | ego-browser 先例(事实 9) |
| (预留) llm | M2 概述器:经 ctx.llm 走适配器(不冻结 loop 请求,只做离线摘要) | report-03(llm/stream 只读护栏只约束 loop) |

### 4.1 settings 命名空间 schema(`dsh-ling`)

```jsonc
{
  "persona": {
    "enabled": true,                    // 总开关;false=不注入任何人格/记忆段
    "userTitle": "",                    // 对用户的称呼,默认空=称呼"你"
    "aiName": "",                       // AI 自称,默认空
    "aiTitle": "",                      // 定位自述(一句话)
    "tone": "natural",                  // natural|literary|concise|playful
    "language": "follow",               // zh | en | follow
    "hardRules": [],                    // 惯例(内部字段名沿用 hardRules;UI/注入显示为「惯例」)
    "bottomLines": [],                  // 底线(≤5 条;定型锁开启后修改需亲手敲承诺句)
    "toneWork": "",                     // 工作模式语气(''=跟随 tone;切换模式自动用对应档)
    "toneLife": "",                     // 生活模式语气(''=跟随 tone)
    "sealed": false,                    // 定型锁:true = 档案只读,改动需亲手敲一遍承诺句(禁粘贴)
    "sealPhrase": "",                   // 定型承诺句(明文;锁只造庄重不保密——仅供解锁界面回显提醒)
    "extraLore": ""                     // 自由扩展设定(器灵世界观等)
  },
  "styles": {
    "work": "克制、结构化、结论先行,少抒情",
    "life": "更有温度,可沿用用户偏爱的文风,允许共情与适度调侃"
  },
  "mode": {
    "mapping": {                        // 档位映射表(用户可改)
      "work": { "provider": "deepseek", "model": "deepseek-v4-flash", "effort": "max" },
      "life": { "provider": "deepseek", "model": "deepseek-v4-flash", "effort": "low" }
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

空字段全部跳过;生成的 L0 文本 = `身份段 + 底线 + 惯例 + extraLore + 模式风格块`(风格块由本会话模式选择,内容来自 styles.*)。例(灵灵填法):

```
[身份·dsh-ling]
你是"器灵",存身于用户的 DeepSeek Harness 之中;你称用户为"老板"。
语气基调:亲切自然,可略带俏皮;专业问题先严谨再谈温度。
惯例:
- 引用你我过往对话记忆时,必须注明来自哪个历史会话(标题+日期);
- 不知道的事明说不知道,不编造;
- 除非用户要求,不要主动引用生活隐私细节来装饰回答。
[设定]
(extraLore 原样内容——例如"器灵世界观"段落)
[本会话模式:生活]
本会话为生活模式:像老朋友一样接住情绪再谈事;允许文雅笔调;不急着给方案。
```

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
  2. **模式与模型**:mode.mapping 两行(provider/model/effort 下拉/文本);mode.lastMode 只读显示;说明"新会话默认跟随最后使用的模式(D2)"。
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

## 7. 记忆存储 schema v1

```sql
-- ~/.dsh/cache/dsh-ling/memory.db  (node:sqlite)
PRAGMA journal_mode=WAL;

CREATE TABLE conv_overview (
  conv_id TEXT NOT NULL,            -- dsweb=导出会话 uuid / dsh=session id
  source TEXT NOT NULL CHECK(source IN ('dsweb','dsh')),
  title TEXT NOT NULL,
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
| POST `/mode/toggle` body{sessionId} | 切换模式(记录+selectModel+重定稿) | 运行中→排队返回 queued |
| GET `/state?sessionId=` | L0 文本/模式/L1 列表/队列状态(设置页与右键菜单用) | 只读 |
| GET `/state?sessionId=&l0Preview=1` | 人格字段实时预览(编辑中) | 只读 |
| POST `/persona` body=字段 | 写 persona(→settings ns)并触发应用 | 见冻结门 |
| GET `/persona/suggest` | 人格档案草稿(M2;先行 501) | — |
| POST `/memory/refresh` body{sessionId?} | 显式重定稿 | 运行中→排队 |
| GET `/export` | 下载记忆包(§8) | 只读 |
| POST `/import` (multipart) | 合并记忆包 | 只读(写库旁路,不碰注入) |
| GET `/health` | 存活与版本 | — |

守卫:全部经 `dsh-auth-` cookie 判定(ego-browser 模式);loopback 来源。

## 10. 里程碑与验证清单

- **M1a 骨架 + 本地构建(下一阶段,不触碰运行 profile)**
  - [ ] package.json(dsh.bundle.patch / exports ./client / platform web)+ cordis.patch.yml
  - [ ] host 各模块空实现 + settings ns 注册 + sqlite 建库(临时 DB 自检)
  - [ ] client 按钮渲染在官方 slot(本地浏览器无法目检 → 静态验证 + 代码评审)
  - [ ] 构建产物可被 __ModuleLoader__ 契约加载(结构自检)
- **M1b 安装验证(需用户配合:备份→加依赖→插行→热载→已登录浏览器目检)**
  - [ ] 按钮出现在会话页顶栏;左右键行为;运行中点击提示"空闲后生效"
  - [ ] 新会话 L0 注入(空称呼/灵灵填法两种);KV 无异常重复
  - [ ] 模式切换:模型档位实际变化(会话内下拉可见);新会话默认跟随 lastMode
  - [ ] 运行中(长任务)切模式/改人格:确认 running 区间快照与档位不变、空闲后生效
  - [ ] 设置卡读写 settings.yaml;导出文件可导入回(合并规则生效)
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

## 

---

## 附录 A:M1a 落地偏差(2026-09-07 骨架)

1. **语言/构建**:无网络环境,全部以**纯 JS(ESM host + 单文件 client)编写,无 TS/构建步骤**;文件即产物,位于 `lib/`(host 各模块 `lib/host/*.js`,入口 `lib/index.js`;client `lib/client.js`)。类型化契约(slot/组装上下文)在 M1b 安装后用真实运行核对(V 系列验证点),类型资产后续按需从 `@deepseek-ai/*/lib/types` 拷入。
2. **设置持久化**:M1a/M1b 用自有 JSON(`~/.dsh/cache/dsh-ling/settings.json`),**官方 settings-ns 集成留后续**(ctx.inject(['settings']) register 模式已取证,见 session-archive)。HTTP 网关 `/api/dsh-ling/*` 是唯一读写面。
3. **注入段 text 签名**:按 REPORT-02 "组装上下文 {agent,scope,signal}" 实现 `text(assembly)`(agent→sessionId→快照),已在真机验证注册成功(kv: inject.section_registered=1);payload 字段名按真实事件自适应。
4. **client 状态轮询**:按钮运行态/当前会话用 3s 轮询 `/state`(宿主侧最近活跃启发式),后续换 connection/事件驱动。
5. **交互修订(用户 2026-09-07)**:不用右键打开菜单(防误触浏览器菜单)→ **左键=切模式;悬停 1.5 秒=菜单**(contextmenu 一律 preventDefault);client 模块必须导出 `inject:['slots','locale','connection']`(缺失则 ctx.slots 为空、按钮静默不挂载——M1b 实证教训,已修复)。
6. **mode 映射默认值**:provider=`deepseek`、model=`deepseek-v4-flash`、effort work=`max`/life=`low`(设置可改;安装时按真实模型目录校准)。
7. **webServer 启动竞态**:registerApi 采用 svc→ctx.inject 子作用域→3s 定时重试三级获取,路由挂载成功才落 kv(api.registered=1,真机已验证)。

## 附录 B:历史会话接入蓝图(2026-09-08 方向已拍板)

→ **详见 `ACCESS-DESIGN.md`**(会话契约 v1、DSH 一键/文件导入双通道、轻量档支持、分页幂等、记忆中心「接入历史」页签与排期)。要点:绝不要求用户理解库结构;先对齐 DeepSeek 体系(DSH 存量 + 网页端文件/库);纯文本粘贴通道暂缓(理由见蓝图 §2)。
