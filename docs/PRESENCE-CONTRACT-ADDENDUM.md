# `dsh-ling/presence` 契约补充说明（addendum · 只增键，不改旧字段语义）

- 日期：2026-11-11（P4C-FIX 修订：§3 `settings.changed` 口径、§5 `ctx.get` 宿主事实、§7 树写点两处补齐）
- 适用契约：`HANDOFF-器灵-presence接口-20261022.md`（下称 HANDOFF，**不修改**，本文件只补）
- 适用代码：`lib/host/presence-bus.js`、`lib/host/presence-service.js`、`lib/host/inject.js`、`lib/host/memory.js`
- 铁律 3 的落地方式：**已有字段的语义一个都不改**，新事实一律用**新键**说。本文件里所有"新增"都是只增键。

---

## 1. `state()` 字段（本次只增一个键）

```js
state() -> {
  ok: true,
  at: '…Z',            // 取这次读数的时刻（UTC ISO）
  bootAt: '…Z',        // **器灵本次加载时刻**（见 §2）
  enabled: boolean,    // cordis.yml 的 presence.enabled
  pending: {
    sessions: number,  // 挂着未投递变更的**会话数**
    global: 0 | 1,     // ⬅ 新增（MF5）
  },
  lastChange: Change | null,
}
```

### 1.1 `pending.global`（新增键，MF5）

- 语义：**有没有**"没有 `scope.sessionId`（即影响所有会话）的变更还没被投递"。有 → `1`，没有 → `0`。
- 为什么加：`pending.sessions` 的字段名与 HANDOFF §3.2 的解释都是"多少**会话**"。旧实现把全局变更
  塞进一个 `*` 槽并计入 `sessions` ⇒ **零会话时报 1、十个会话时也只报 1**（名字与读数不符）。
  发布前必须定一次口径，本版选**方案②**：`sessions` 只数 `s:` 前缀（真实会话），全局槽单独报。
- **`pending.sessions` 的语义没有变**：仍然是"会话数"，只是不再把全局槽混进来。
- 投递口径不变：`recent()` / `state()` / `watch` 回调**都不消费** `pending`（口径 A，HANDOFF §5-1 同向）。
  只有「投递」推进：会话投递清该会话的 `s:` 槽，同时清全局槽（那次投递的文本里也含全局变更）。

---

## 2. `bootAt` = 本次加载时刻（N1）

`registerPresenceService()` 每次执行都把 `bootAt` 刷成**当次注册的时刻**（`refreshPresenceBootAt()`）。
热重载、同进程内二次注册、测试复位后重建，都算"一次新的加载"。
（旧实现只在模块**首次 import** 时取一次时，重载后 `bootAt` 仍是第一次的时刻，与 §3.2 字面不符。）

---

## 3. `count` 口径（逐 code 写清，N7）

`count` 是**可选**键，只在提供方**知道**条数时出现。消费者必须把它当成"该 code 下这个数代表什么"，
**不能跨 code 统一解释**。逐 code：

| `code` | `count` 含义 | 单位 | 出现条件 |
|---|---|---|---|
| `tree.changed` | **不带** | — | 恒无（树变更只说"结构变了"） |
| `memory.forgotten`（`forgetEntry`） | **不带** | — | 恒无（"忘掉一条"，条数由 `scope.sessionId` 那一侧自己知道） |
| `memory.forgotten`（`unforgetEntry`） | **不带** | — | 恒无 |
| `memory.forgotten`（`restoreEntry` 回灌） | **回灌的轮数**（`wroteTurns`） | 消息条（turn） | 回灌执行后 |
| `persona.changed` | **不带** | — | 恒无 |
| `settings.changed` | **本次 patch 的顶层键数**（`SettingsFile.update(patch)`：`Object.keys(patch).length`，如 `{inject, mode}` → `2`）<br>**`reset()` 也带**：写入默认值的顶层键数（`Object.keys(DEFAULT_SETTINGS).length`，当前 10：`persona/styles/mode/memory/inject/guard/habits/assistant/auto/dates`） | 顶层键 | `SettingsFile.update()`；`SettingsFile.reset()` |
| `mode.changed` | **不带** | — | 恒无（一条 = 某会话挡位变了一次） |

> **R2（P4C 修订）：`reset()` 那条到底带不带 `count`？——带，而且这是有意的。**
> 本文件 §3 早先写的是“`reset()` 那条不带”，与代码相反（`lib/host/settings-file.js:202-213`）。
> 以**当前代码行为**为准把口径写清，不让代码迁就文档：
>
> - `update(patch)`：`count` = 本次 patch 的**顶层键数**（`lib/host/presence-bus.js:213-226` 的
>   `emitSettingsChanged` 用 `Object.keys(patch).length`；`persona` / `styles` 子树另发 `persona.changed`）。
> - `reset()`：**同时**发 `persona.changed`（人格子树被重置）与 `settings.changed`，
>   后者的 `count` = `Object.keys(DEFAULT_SETTINGS).length`（**写入默认值的顶层键数**）。
>   两条都是真的变了，故都发；`reset()` **不**经过 `update()`，它的 `count` 不是"patch 键数"，
>   消费方按 `(code, 触发点)` 分支解释（见下）。
>
> 为什么不做成统一口径：三处自然单位不同（轮数 / 顶层键数 / 没有），强行统一要么造出"1"这种
> 无信息值，要么改变已经发布的读数。**统一解释的责任放在消费方**：按 `(code, 触发点)` 分支。

---

## 4. 投递点（MF1）与"什么时候 `pending` 会回落"

- 生产投递点：`inject.js` 的 `advanceLogWatermark()` —— 它**只在文本真的要被送进模型时**被调用
  （`renderMemorySection()` 的 4 个投递分支）；`invalidateSession()` / `refreshIdleSnapshot()` 这类
  "只重建、没开口"的路径**不**调它。
- 该函数被调用时：`markDelivered(sessionId)`（清该会话槽）+ `markDelivered()`（清全局槽）。
  即使这一轮 `branch_log` 没有新内容（`maxId=0`），也照样清账 —— 投递就是投递。
- 因此 `pending` 的正确读法是"**到现在为止还没被投递的**"，不是"历史上出现过多少会话"。

---

## 5. `ctx.get()` 的语义（MF6：一个**可复核的当前宿主事实** + 消费方义务）

- **可复核事实（本机当前宿主）**：`<DSH_PORTABLE>/portable/app/node_modules/@deepseek-ai/cordis/lib/index.js:763`
  （该包 `package.json` 的 `version` = `4.0.5`，落在本仓 peer `>=4.0.4` 范围内）——
  `get(name, strict = true)` 对**未被 provide** 的服务返回 `undefined`，**不抛**：
  `get()` 体是 `return getTraceable(this.ctx, this._getImpl(name, strict)?.value)`，`_getImpl` 里
  `const impl = key && this.store[key]; if (!impl) return;` ⇒ 缺失走 `?.` 得 `undefined`，
  `getTraceable` 对非对象原样返回。复核命令（只读源码，不联网）：
  `node -e "const p='<DSH_PORTABLE>/portable/app/node_modules/@deepseek-ai/cordis/package.json';console.log(require(p).version)"`
  与直接读该文件 `:763-772`。
- ⚠️ **这不是"所有宿主都如此"的保证**：`ctx.get` 的行为由**宿主实现**决定，**别的宿主 / 别的版本
  可能抛**（例如"服务缺失即报错"的实现、或 strict 语义不同的实现）。契约维度上只承诺一件事：
  **消费方必须 try/catch**，把"拿不到"和"拿的时候炸了"都归一成 `undefined`。

```js
let presence;
try { presence = ctx.get('dsh-ling/presence'); } catch { presence = undefined; }
if (!presence) { /* 软依赖:跳过,不是错误 */ }
```

- 本仓的 `lib/host/util.js` 的 `svc()` 就是这一层的封装（两种宿主形态都回 `undefined`），
  与 `lib/host/presence-service.js` 头部注释同一口径。
- 提供方这边同理：`ctx.provide()` 失败只 `console.debug` + 返回 disposer（HANDOFF §3.1 的"不是错误"）。

---

## 6. 非契约导出（N5）

`lib/host/presence-bus.js` 里 `emitChange` / `emitSettingsChanged` / `markDelivered` /
`resetPresenceBus` / `setPresenceClock` / `refreshPresenceBootAt` / `normalizeChange` /
`configurePresence` 都是**提供方内部接缝**与测试缝，**不属于** `dsh-ling/presence` 的公开契约。
消费方只许经 `ctx.get('dsh-ling/presence')` 取 `state / watch / recent` 三个方法。
直接 `import '…/lib/host/presence-bus.js'` 去伪造变更、复位缓冲、替换时钟 = 越界；
这些名字与形态**随时可变**，不受「只增键」承诺保护。

---

## 7. 事件语义的收紧（MF2 / MF3，不改键、只改"发不发"）

- `mode.changed`：只在**挡位真的变了**时发（前后值比较）。同一挡位连续 set 两次 → 只 1 条；
  `clearSessionMode` 对一个本来就是 NULL / 不存在的会话 → 不发。
- `tree.changed`：只在**树结构真的变了**时发。
  `renameBranch` 同名、`setBranchWeight` 同值、`setSessionBranch` 同枝、`reparentBranch` 同父、
  `setConvBranch` 同值（覆盖层重放）→ 不发；
  对**不存在**的枝改名 / 调权重 → `ok:false` 且不发。
  `linkVeins`：同 `(from, to, kind, note)` 重放 → 不发；**反向写入**（无向关系 `A→B` 与 `B→A` 是同一个事实）
  只在旧行的 `kind/note` 真的变了时发；**有向边**（`prerequisite` / `supersede`）按有序对各自判断，
  反向不同值 = 新建另一条边 → 发。
  （与同文件既有的 `createBranch` / `clearConvBranch` / `unlinkVein` 的 `changes>0` 口径对齐。）
  ⚠️ 判据是**写前读旧值比较**：`ON CONFLICT DO UPDATE` 的同值更新在 SQLite 里 `changes` 仍为 1，
  **不能只看 `changes`**。

---

## 8. `recent({ since, limit })` 的边界（N3）

- `since`：闭区间（`>=`），非法值忽略（不抛、不过滤）。
- `limit`：一律按**条数**解释。`limit: 0` / 负数 ⇒ **空表**（旧实现回全量，与直读语义相反）。
- 不分页：`recent()` 的上限就是 `presence.bufferSize`（默认 200，可经 `cordis.yml` 调）。
