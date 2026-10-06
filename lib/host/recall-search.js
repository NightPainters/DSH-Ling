// dsh-ling host — recall 的**检索档**(1.6 §7 步 1,2026-10-04)。
//
// 它是什么:给模型一个「**按内容找会话**」的入口。此前只有 `recall()` 的磁盘清单(按时间列文件)
//   与 `recall(conv)` 的目录 —— 要"找"只能靠翻,翻不动就靠猜。
//
// 为什么接宿主检索面而不是自建(2026-10-04 全实测):
//   · 宿主 `@deepseek-ai/dsh-session-query` 的 SQLite 后端已由主人在 2026-09-20 启用
//     (`profiles\web\cordis.patch.yml:59-62` → `session-search.db`);
//   · 索引**懒对账**:每次 `searchSessions` 先跑 `_reconcile` → `_observeStable`,把磁盘上新增的
//     会话补进索引(代码 :537/:543/:707/:724 + 数据 `global_generation=2` 两侧证实)
//     ⇒ 停更是"没人搜过",不是坏了;
//   · 中文实测:2~4 字短词命中良好(`记忆树` 1024 / `血缘` 288 / `注入面` 453),
//     **多词 = AND**(`记忆树 血缘` ≡ `"记忆树" "血缘"` ≡ 159),**无子串召回**(`call` 命中 0);
//   · 官方为 tokenizer 取舍(`unicode61`,否决 trigram)做过实测 ⇒ 重开选型是重复踩坑。
//   ⇒ 结论:**分两层用** —— 找会话走宿主,找原文走 `rawlog`(磁盘直读)。
//
// 范围限制(D6 已拍 2026-10-04):默认**只搜「主人自己的会话」**;越界要显式 `all:true`。
//   判据**复用** `isMemoryEligibleHeader`(顶层 + 分叉入、子代理不入)—— 与入库/注入同一把尺,
//   不另立一份,否则会出现"能读到的"与"能记住的"两套边界。
//   官方 README 的硬约束原文:「**无调用方授权** …… 模型工具或 UI **必须限制调用方可检查的会话**」
//   ⇒ 照抄它的形状:`listSessions()` 造可见集 → 结果逐条 `visibleIds.has(...)`
//   (官方同款实现在 `dsh-api-session-controller\lib\index.js:1934` / `:1984`)。

import { isMemoryEligibleHeader, sessionKind } from './util.js';
import { localStamp, oneLine } from './rawlog.js';

/** 一页几个会话(默认):**5 条**(2026-10-05 主人拍板 B2,原为 10)。
 *  起因:实测"搜什么都中今天" —— 全文索引里**当前会话自己**也在,任何词都能命中几十秒前刚打的那句话,
 *  而原文层默认 10 行会把上面的**条目层**(结论,一句话说完)挤到看不见。砍到 5 条让条目重新占视觉重心;
 *  要更多**显式传 `limit`**(上限 50 不变,想翻就翻)。 */
export const SEARCH_HITS_DEFAULT = 5;
/** 一页几个会话(上限):给模型的是"下一步去哪",不是把库倒出来。 */
export const SEARCH_HITS_MAX = 50;
/** 单条摘要的显示字数 —— **报短摘要而不是 id**(2026-10-04 生态复核:同生态对手的 README 逐字
 *  「查 id 是什么的那一步最容易省略,省略了就等于没报」)。这一条是本次复核直接抄来的。 */
export const SEARCH_SNIPPET_CHARS = 160;

/** 宿主检索的**超时上限**(2026-10-05,主人定 20 秒)。
 *
 *  为什么必须有它:宿主的懒对账(`_reconcile` → `_observeStable`)是**串行化**的。一旦撞上卡住的对账,
 *  `searchSessions` 就**一直不返回** —— 实测有一次挂了 **约 30 分钟**,而当时**没有任何中断入口**:
 *  GUI 没有,工具层也没有。按本项目理念(「逃生开关永远可用」),**"不可中断"本身就该按最严重一级对待**,
 *  与它挂了多久无关。
 *  ⇒ 我们改不了宿主(拿不到取消口),但可以**不给它无限期**:超时后放弃原文层,并**照样把条目层交出去**
 *  (条目是本地 SQLite,毫秒级,完全不受宿主影响)。
 *  ⚠️ 别调小到 5 秒以下:一次"慢但对"的检索比"快速失败"有用得多;
 *  也别指望它治并发 —— 并发撞对账是宿主侧的事,这里只保证**任何一次都不会挂死**。 */
export const SEARCH_TIMEOUT_MS = 20000;

/**
 * 给 Promise 套超时(纯函数,可单测)。
 * ⚠️ 超时**不取消**底层操作(宿主没给取消口),只是我们不再等它;它之后若返回,结果被丢弃 ——
 *   检索是只读的,丢弃不影响任何状态。
 * @returns `{ok:true, value}` | `{ok:false, reason:'timeout', ms, label}`
 */
export function withTimeout(promise, ms, label = '检索') {
  const limit = Math.max(1, Number(ms) || SEARCH_TIMEOUT_MS);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', ms: limit, label }), limit);
    // 别让这个定时器拖住进程退出(工具层常在短命进程里被调用)
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([
    Promise.resolve(promise).then((value) => ({ ok: true, value })),
    timeout,
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 条数夹取(纯函数,便于单测)。 */
export function clampSearchLimit(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(SEARCH_HITS_MAX, Math.max(1, v)) : SEARCH_HITS_DEFAULT;
}

/** 一次检索最多带出几条**深层库条目**(1.6 §7 步 4,2026-10-04)。 */
export const SEARCH_DEEP_MAX = 12;

/**
 * 在**深层库条目**里按内容找(1.6 §7 步 4)。
 *
 * 为什么要和"找会话"并在一起:主人的问句多半是「我说过什么关于 X 的」——
 * 而答案更可能在**结论层**(`deep_item`)而不是某一段原始对话里。两者一起给,
 * 「找条目」与「找会话」一次到位,少一轮往返。
 *
 * 多词语义**必须与宿主检索面同解(AND)**:那边实测 `记忆树 血缘` ≡ `"记忆树" "血缘"`,
 * 这里就也是"每词都要出现"。两处"多词"含义打架的话,同一个问句会给出互相矛盾的结果。
 *
 * 排面用表自己的口径(置顶 → 加固 → 新);**已取代的条目不参与** —— 它们是
 * "曾经成立、现已作废"的留痕(见 `supersedeDeepItem`),主动召回不该再挑它。
 *
 * 表还没建时(宿主未重启)**静默返回空**:检索面不该因为深层库缺席而整体失败。
 */
export function searchDeepItems(memory, q, limit = SEARCH_DEEP_MAX) {
  const db = memory?.db;
  if (!db?.prepare) return [];
  const words = String(q || '').trim().split(/\s+/).map((w) => w.replace(/[%_\\]/g, '')).filter(Boolean);
  if (!words.length) return [];
  try {
    // ⚠️ 2026-10-06:**类目名(kind)也在检索面里** —— 修前只扫 `text`,于是查询里的类目词打不中
    //   它们自己的条目:实测搜「纪律」时那 18 条只回来 2 条(恰好正文含"纪律"二字的那些),
    //   而**同族缺陷对"承诺 / 决定 / 关系 / 事实 / 偏好"一样成立**。
    //   多词仍是 **AND**(每词都得在 text 或 kind 里出现其一),与宿主检索面同解,不另立口径。
    const where = words.map(() => "(text LIKE ? ESCAPE '\\' OR kind LIKE ? ESCAPE '\\')").join(' AND ');
    const args = [];
    for (const w of words) { args.push(`%${w}%`, `%${w}%`); }
    args.push(Math.max(1, Math.min(50, Number(limit) || SEARCH_DEEP_MAX)));
    return db.prepare(
      `SELECT id, kind, text, conv_id, src, seq_from, seq_to, pinned, hit_count FROM deep_item
       WHERE superseded_by='' AND ${where}
       ORDER BY pinned DESC, hit_count DESC, created_at DESC LIMIT ?`,
    ).all(...args);
  } catch { return []; }
}

/** 检索档本地原文层一次最多带出几轮(默认同 `SEARCH_HITS_DEFAULT`)。 */
export const SEARCH_LOCAL_TURNS_MAX = 50;

/**
 * 在**我们自己的库**里按内容搜原文轮(`dsh_turns_raw`)—— 检索档的**默认**原文来源。
 *
 * 为什么默认走这里(2026-10-05 夜 · 主人拍板方案 A):
 *   宿主 `sessionQuery` 的每次搜索都会做一遍**全量对账**(`_observeStable` 里 list 两遍、
 *   最多重试 2 轮),实测**每次都超过 20 秒**(重启后第一次也一样),而这边的
 *   同一个查询只要 **2~45 毫秒**。快的设成默认、慢的降级成显式选项,是这一档的取舍。
 *   ⚠️ 代价**必须如实报出去**:库里这份原文是**残的** —— capture 侧只收"真人消息 +
 *   有正文的回复",所以我自己的长回复**中段**搜不到。回执里要写明这一层是"库内原文层"。
 *
 * 与 `searchDeepItems` 同解的三条(不另立口径):多词 = **AND**;词里的 `% _ \` 先剥掉;
 * 表不存在时**静默返回空**(检索面不该因为某张表缺席而整体失败)。
 *
 * @param {object} memory  MemoryStore
 * @param {string} q       查询词(空格分隔 = 同时满足)
 * @param {number} limit   最多几轮
 * @param {object} [opts]  `{ selfId, callName, includeSelf }` —— `selfId` 是当前会话 id;
 *   **默认把它整条排除**(见下方注释),要看自己刚说的传 `includeSelf:true`(那时它排到最后并标 `isSelf`)
 * @returns `{{rows:object[], selfExcluded:number}}` —— `selfExcluded` 是**因为"是本会话"而被排除的条数**,
 *   调用方**必须把它报出去**:不说就会被读成"库里只有这些"(那是说假话)
 */
export function searchLocalTurns(memory, q, limit = SEARCH_HITS_DEFAULT, { selfId = '', callName = '主人', includeSelf = false } = {}) {
  const db = memory?.db;
  if (!db?.prepare) return { rows: [], selfExcluded: 0 };
  const words = String(q || '').trim().split(/\s+/).map((w) => w.replace(/[%_\\]/g, '')).filter(Boolean);
  if (!words.length) return { rows: [], selfExcluded: 0 };
  const cap = Math.max(1, Math.min(SEARCH_LOCAL_TURNS_MAX, Number(limit) || SEARCH_HITS_DEFAULT));
  let rows;
  try {
    const where = words.map(() => "text LIKE ? ESCAPE '\\'").join(' AND ');
    rows = db.prepare(
      `SELECT session_id, seq, role, ts, text FROM dsh_turns_raw
       WHERE ${where} ORDER BY ts DESC LIMIT ?`,
    ).all(...words.map((w) => `%${w}%`), cap);
  } catch { return { rows: [], selfExcluded: 0 }; }
  const self = String(selfId || '');
  const mapped = rows.map((r) => {
    const id = String(r.session_id ?? '');
    const role = String(r.role ?? '');
    const isUser = role.startsWith('user');
    // 命中位置附近截一段(而不是从头截):词可能出现在长回复的中间
    const text = String(r.text ?? '');
    const at = words.map((w) => text.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const from = Math.max(0, at - 40);
    return {
      conv: id, seq: Number(r.seq) || 0, role,
      time: r.ts ? localStamp(r.ts) : '',
      who: isUser ? callName : '鱼姬',
      snippet: oneLine(text.slice(from, from + SEARCH_SNIPPET_CHARS), SEARCH_SNIPPET_CHARS),
      isSelf: Boolean(self) && id === self,
    };
  });
  // ⚠️ **本会话默认排除**(2026-10-05 夜 · 主人拍板):它就在库里、而它的话又最新 ⇒ 任何词都能命中它,
  //   把要回溯的历史**整页挤掉** —— 真机实测「检索」10 条里 9 条是本会话;光把它排到末尾只治了"占头部",
  //   没治"占位"。而"我刚说过什么"**根本不需要搜**:它就在我的上下文里;
  //   搜索这个动作的全部意义是回溯**我这里没有的**东西。要看自己刚说的传 `includeSelf:true`。
  //   ⇒ 排除的条数**如实报出去**(`selfExcluded`),不说就会被读成"库里只有这些"。
  const kept = includeSelf ? mapped : mapped.filter((r) => !r.isSelf);
  const selfExcluded = includeSelf ? 0 : mapped.length - kept.length;
  return { rows: kept.sort((a, b) => Number(a.isSelf) - Number(b.isSelf)), selfExcluded };
}

/**
 * 从 `listSessions()` 的记录里造「主人自己的会话」id 集(纯函数)。
 * 拿不到 header 的**不放入** —— 宁少不滥,这是可见性过滤,不是统计。
 */
/** 1.6 步 5:**采用信号** —— `recall` 去取某段原文时,把**与所取区间相交**的深层库条目加固 +1。
 *
 *  为什么这是"采用"而不是"注入":注入是系统单方面推给模型的,模型完全可以不理;
 *  而**肯为一条结论下钻去读它指向的原话**,是它真在用这条结论的证据。
 *  `deep_item` 列注释里那条语义位(「`hit_count` 只由真被采用推进,不由被注入推进」)就落在这里 ——
 *  否则注入越多分越高、分越高越容易被注入,是个自我强化回路(抄自 stratagate 的做法)。
 *
 *  ⚠️ **seq 坐标系**:必须用 `dsh_turns_raw.seq`(即提炼料文件里的 `**#N role**`),
 *  **不是**目录里的对话轮序号 `n` —— 两者在"注入消息被折叠"的会话里会叉开。
 *  相交判据 `seq_from <= hi && seq_to >= lo`;已取代的条目不加固(它是"曾经成立"的留痕)。
 *  返回被加固的条数(0 = 没有相交条目,正常)。任何异常都吞成 0 —— 加固失败不该让读原文失败。 */
export function adoptDeepItems(memory, conv, seqLo, seqHi) {
  try {
    if (!memory?.db || typeof memory.bumpDeepHit !== 'function') return 0;
    const c = String(conv || '');
    const lo = Number(seqLo) || 0;
    const hi = Number(seqHi) || 0;
    if (!c || !lo || !hi) return 0;
    const rows = memory.db.prepare(
      "SELECT id FROM deep_item WHERE conv_id=? AND superseded_by='' AND seq_from<=? AND seq_to>=? LIMIT 50",
    ).all(c, hi, lo);
    let n = 0;
    for (const r of rows) if (memory.bumpDeepHit(r.id)?.ok) n += 1;
    return n;
  } catch {
    return 0;
  }
}

export function visibleIdSet(records) {
  const out = new Set();
  for (const r of records || []) {
    const h = r?.header;
    if (!h || typeof h !== 'object') continue;
    const id = h.id ?? r?.id;
    if (!id) continue;
    if (isMemoryEligibleHeader(h)) out.add(String(id));
  }
  return out;
}

/**
 * 把宿主的 `SessionSearchHit[]` 折成回执行(纯函数)。
 * @param hits  `{ header, bestMatch: { seq, time, type, snippet } }[]`
 * @param visible 可见集(来自 `visibleIdSet`);`all === true` 时忽略
 * @param all 越界开关(D6:显式才生效)
 * @returns `{ rows, skipped }` —— `skipped` 是**被范围挡掉**的条数,必须报出来(不静默丢)
 */
export function toSearchRows(hits, { visible = null, all = false, callName = '主人', selfId = '' } = {}) {
  const rows = [];
  const self = String(selfId || '');
  let skipped = 0;
  for (const h of hits || []) {
    const header = h?.header ?? {};
    const id = header.id ?? h?.sessionId;
    if (!all && visible && (!id || !visible.has(String(id)))) { skipped += 1; continue; }
    const m = h?.bestMatch ?? {};
    const isUser = String(m.type || '').startsWith('user');
    rows.push({
      conv: String(id || '(无 id)'),
      kind: sessionKind(header),
      cwd: header.cwd ? String(header.cwd) : '',
      seq: m.seq ?? null,
      time: m.time ? localStamp(m.time) : '',
      who: isUser ? callName : '鱼姬',
      snippet: oneLine(m.snippet || '', SEARCH_SNIPPET_CHARS),
      isSelf: Boolean(self) && String(id) === self,
    });
  }
  // ⚠️ 本会话排到最后(2026-10-05 主人拍板 C):**当前会话自己也在索引里**,于是"搜什么都中今天" ——
  //   任何词都能命中几十秒前刚打的那句话,而它排在头一条,把要回溯的历史全挤下去。
  //   **不删**它(有时确实要找自己刚才那句),只挪到末尾并标注「← 本会话」。
  //   `sort` 在 V8 上是**稳定**的 ⇒ 其余命中保持宿主的原序(相关性+新近),不打乱。
  if (self) rows.sort((a, b) => Number(a.isSelf) - Number(b.isSelf));
  // ⚠️ `degraded`(蓝队 2026-10-04 抓到 P3):宿主**没有** `listSessions` 时,`visible` 恒为 null
  //   ⇒ 范围限制**整条失效**(一条不挡),而回执却仍写着"已在主人自己的会话内" —— 那是**说假话**。
  //   取舍(主代理 2026-10-04 定):**保持 fail-open 但如实标注** —— 完全禁用会让"按内容找会话"
  //   在宿主版本变动时突然死掉,而这里泄漏面只是子代理会话(不是外部);关键是**不许假装限过范围**。
  return { rows, skipped, degraded: !all && !visible };
}

/** 检索档的人读回执(纯函数,模型可见)。 */
export function renderSearch(v) {
  if (!v || v.ok !== true) {
    // ⚠️ 兜底必须在**构造字符串之前** —— 表里的模板是立即求值的,`v` 为 null 时
    //   `v.message` 会在构造这一步就抛。这不是防御性编程:工具回执抛异常 = 模型那一步直接失败,
    //   而"检索失败"恰恰是最该被好好说出来的时刻。本文件第一次跑测试就抓到了这一处。
    const msg = v?.message || '(原因未知)';
    const why = {
      'search-unavailable':
        `宿主检索面不可用,这次没搜成。原因:${msg}`
        + ' 这不是"库里没有",是**通道没接上** —— 按内容找会话这条路暂时走不通,'
        + '可改用**不带参数**的 recall() 按时间翻清单。',
      'search-failed': `检索报错,这次没搜成:${msg}。换个更短的词再试(中文 2~4 字命中最好)。`,
    }[v?.reason];
    return why || `未搜到内容(${v?.reason || '未知'})。`;
  }
  const scope = v.all
    ? '**未限定范围**(all=true —— 含子代理等非主人会话)'
    : (v.localScope
      // ⚠️ 本地路**没有可见集过滤**(2026-10-06 外部文档核对抓到):它直查 `dsh_turns_raw` ——
      //   那是**全量**(实测 11,296 行 / 1,647 会话,其中 `source='dsweb'` 的 1,523 个网页端会话、
      //   未标来源的 104 个)⇒ **不许印"已在主人自己的会话内"**,那是说假话。
      ? '⚠️ **本机库全量**(这条路不过 `listSessions` 可见集:含网页端导入的会话与未标来源的会话)'
      : (v.degraded
        ? '⚠️ **没能限定范围** —— 宿主这次没给 `listSessions`,所以下面这份结果**可能含子代理或其它会话**,'
          + '不是"只搜主人自己的会话"(范围限制这条通道暂时失效,不是"库里只有这些")'
        : '已在「**主人自己的会话**」内(默认范围)'));
  // ⚠️ **原文来源必须看得出来是哪一个**(2026-10-05 夜 · 主人拍板方案 A):
  //   两条路覆盖面**不一样**,不说清就会被读成"库里只有这些"。
  //   · 本地(默认):库内原文层 —— 只含"真人消息 + 有正文的回复"(capture 侧就这么收的),
  //     我自己的长回复**中段搜不到**;代价换来的是 **2~45 毫秒**(实测)。
  //   · 宿主(显式 hostSearch):覆盖全部事件,但每次**全量对账**、实测**每次 >20 秒**。
  const layerNote = v.local
    ? '(原文来源:**本机库内原文层** —— 只含真人消息与有正文的回复,毫秒级;要全量检索请传 hostSearch=true)'
    : '';
  const hitRows = Array.isArray(v.rows) ? v.rows : [];
  const deepRows = Array.isArray(v.deep) ? v.deep : [];
  // 条目排在前:它是**结论层**(一句话说完),会话在后(要下钻才知道内容)。
  const deepBlock = deepRows.length
    ? '【深层库条目 · 结论层(从他的会话里提炼出来的,可直接用)】\n' + deepRows.map((d) => {
      const pin = Number(d.pinned) ? '📌 ' : '';
      // ⚠️ **不要在这里印 `from=`**(红队 2026-10-04):条目的 `seq_from/seq_to` 是**事件流 seq**
      //   (提炼料里的 `#N`,即 `dsh_turns_raw.seq`),而 `recall(conv, from, to)` 收的是
      //   **对话轮序号 n** —— 两个坐标系在"注入消息被折叠"的会话里会叉开。实测 274 条可比条目里
      //   **207 条(75.5%)照这条指引会直接 `out-of-range`**;偶有落在范围内的,读到的也是不相干的
      //   轮次,还会顺手给不相干条目计一次"采用"。⇒ 只给会话 id,让调用方**先看目录再取原文**。
      return `· ${pin}[${d.kind}] ${d.text}\n  ↳ 出自 ${d.conv_id} —— 要看原话:先 \`recall(conv="${d.conv_id}")\` 拿轮次,再按目录里的 \`#N\` 取`;
    }).join('\n') + '\n\n'
    : '';
  if (!hitRows.length && !deepRows.length) {
    // 超时是**另一种结论**,不能说成"没找到" —— 前者该"重发或换窄词",后者该"换词",
    //   而"库里没有"是第三种(最不该被误读成它)。
    if (v.timedOut) {
      return `查询「${v.q}」这次**没跑完**:宿主检索超过 ${Math.round((Number(v.timeoutMs) || SEARCH_TIMEOUT_MS) / 1000)} 秒没返回`
        + '(多半是它在补索引对账 —— 宿主侧的串行操作,插件打断不了它)。'
        + `\n条目层是本地库、毫秒级,它也没有命中 ⇒ 这次**两层都空**。`
        + '\n换个更窄的词(中文 2~4 字)重发一次,或稍后再试。'
        + `\n(范围:${scope})`;
    }
    return `按内容没找到(查询「${v.q}」· ${scope})${layerNote}。`
      + (v.skipped ? `\n(有 ${v.skipped} 条被范围挡掉 —— 要看它们得显式传 all=true。)\n` : '\n')
      + '换词试试:中文 **2~4 字**短词命中最好(`记忆树` / `血缘` / `注入面`);'
      + '**多个词用空格分隔 = 同时满足**(AND);**没有子串匹配**(`call` 搜不到 `recall`)。';
  }
  const rows = hitRows.map((r) => {
    const at = [r.seq !== null && r.seq !== undefined ? `#${r.seq}` : '', r.time].filter(Boolean).join(' ');
    // 「← 本会话」:它被排到了末尾(见 toSearchRows),标注是让模型知道**这条是刚发生的、不是历史** ——
    //   否则它会把"我刚说的话"当成"主人当年说过的话"来引用。
    const selfTag = r.isSelf ? ' **← 本会话(刚发生的)**' : '';
    return `· ${r.conv}${selfTag} · ${at} ${r.who}\n  ${r.snippet}`;
  });
  const head = deepRows.length && rows.length
    ? `按内容命中 **${deepRows.length} 条深层库条目** + ${rows.length} 轮原文(查询「${v.q}」· ${scope})${layerNote}:`
    : deepRows.length
      ? `按内容命中 **${deepRows.length} 条深层库条目**(查询「${v.q}」· ${scope})${layerNote}:`
      : `按内容找到 ${rows.length} 轮原文(查询「${v.q}」· ${scope})${layerNote}:`;
  const convBlock = rows.length ? `${v.local ? '【库内原文层】' : '【会话原文层】'}\n${rows.join('\n')}` : '';
  // ⚠️ 超时**不算失败**:条目层已经拿到了(本地库),必须照常交出去。这一行是"如实说明少了一半",
  //   而不是"报错" —— 两者的下一步动作不同(前者重发/换窄词,后者换通道)。
  const timeoutNote = v.timedOut
    ? `\n\n⚠️ **原文层超时**(等满 ${Math.round((Number(v.timeoutMs) || SEARCH_TIMEOUT_MS) / 1000)} 秒没返回,多半是宿主在补索引对账):`
      + (deepRows.length ? '**条目层是本地库,不受影响,就在上面** —— 先把它们用起来。' : '这次连条目也没命中。')
      + '要原文就**重发同一条**(多数第二次会快,对账已经补过了),或换更窄的词。'
    : '';
  // ⚠️ 排除本会话要**说出来**:不说就会被读成"库里只有这些"(那是说假话)。
  const selfNote = Number(v.selfExcluded) > 0
    ? `\n(另有 ${v.selfExcluded} 轮命中属于**当前会话自己**,已按默认排除 —— 要看自己刚说的传 \`includeSelf=true\`。)`
    : '';
  return `${head}\n${deepBlock}${convBlock}${timeoutNote}${selfNote}`
    + (v.skipped ? `\n(${v.skipped} 条被范围挡掉 —— 要看它们得显式传 all=true。)` : '')
    + (v.hasMore ? '\n(这一页满了,**还有更多** —— 把 limit 调大,或换个更窄的词。)' : '')
    + (deepRows.length
      ? '\n\n**下一步**:条目已经是可以直接用的结论;**要它背后那句话**就把上面的 conv 传给 `recall(conv=…)` 拿对话目录,再按目录里的 `#N` 取原文(`recall(conv, from, to)`)。'
      : '\n\n**下一步**:把某个 conv 原样传给 `recall(conv)` 看它的**对话目录**,再 `recall(conv, from, to)` 取原文。');
}
