// 注入面双开关(1.7.3 / issue #2 的正面修法) —— 2026-10-27
//
// 缘起(实测,不是推测):1.7.2 的面板只有一个勾「启用人格与记忆注入(关=完全原生助手)」,
// 而它的真实行为两头都不对:
//   · L1 记忆段的判据是 `personaEnabled && l1Enabled`(snapshot.js:34)⇒ **关人格会连记忆一起关**;
//     文案说"人格与记忆",行为是"两件一起没了"。
//   · 关掉之后【记忆树有改动】播报、时间锚、11 件记忆/图书馆工具**照旧在**
//     ⇒「完全原生助手」也不成立。
// 1.7.3 把注入面拆成两条独立闸:
//   ① 人格:settings.persona.enabled(既有键,语义收窄为"只关 L0")
//   ② 记忆与图书馆:settings.inject.memoryEnabled(新键,默认 true = 1.7.2 行为逐字不变)
//
// 本文件钉四件事:
//   1) 四象限矩阵(persona × memory)下 buildSnapshotText 到底产出什么;
//   2) 写面白名单 sanitizeInjectPatch 只收真布尔、只收白名单键;
//   3) 工具面那 8 件确实挂在 ② 上(静态度量,运行期矩阵由 library-runtime/tool-remount 覆盖);
//   4) 接线判据(端点/方法闸/面板文案) —— 防止"代码改了、面板没接上"这类静默失效。
//
// ⚠️ 真实 HTTP 面**刻意不在本文件**:`registerApi()` 一进来就 rotateSurgeryTicket()(真机副作用),
//    且关①.6 出站白名单按「文件 + 归属函数」登记,新增 HTTP 套要同步改 tools/compliance-spec.mjs。
//    那部分是 U2-B 的独立收尾项(见交付单),不与本文件的纯函数判据混在一起。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { buildSnapshotText } = await imp('lib/host/snapshot.js');
const { sanitizeInjectPatch } = await imp('lib/host/guard.js');
const { DEFAULT_SETTINGS } = await imp('lib/host/persona.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const section = (t) => console.log('\n── ' + t);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

// ---------------- 桩:一条深层库条目 + 一条树改动 + 一个 settings ----------------
const DEEP_TEXT = '把注入面拆成两个开关';
const DEEP = {
  id: 'di:1', kind: '决定', durability: 'long', text: DEEP_TEXT,
  at: iso(1), created_at: iso(1), conv_id: 'c1', src: 'dsh',
  hit_count: 1, pinned: 0, superseded_by: '',
};
const LOG_LINE = '主人把「记忆树」的一条枝改了名';
const LOG_SECTION = '记忆树有改动';

function mkMemory() {
  const kv = new Map();
  return {
    listDeepItems: () => [DEEP],
    branchLogDigest: () => ({ lines: [LOG_LINE], maxId: 7, shownMaxId: 7, retiredMaxId: 0 }),
    // currentMode() 要读会话元信息(会话级模式覆盖);`null` = 没设过 ⇒ 落到全局 lastMode
    sessionMeta: () => null,
    kvGet: (k) => kv.get(k),
    kvSet: (k, v) => { kv.set(k, v); },
    bumpHit() {},
    bumpDeepHit() {},
  };
}
/** `inject` 缺席时**不写这个键** —— 用来证明"没设置过"与"显式 true"等价(默认值不变)。 */
function mkSettings({ persona = true, memory = true, setMemoryKey = true, away = false } = {}) {
  const s = {
    persona: { ...DEFAULT_SETTINGS.persona, enabled: persona, aiName: '器灵', userTitle: '用户' },
    styles: { ...DEFAULT_SETTINGS.styles },
    mode: { lastMode: 'work', mapping: { work: { effort: 'max' }, life: { effort: 'low' } } },
    memory: { ...DEFAULT_SETTINGS.memory },
    guard: { ...DEFAULT_SETTINGS.guard },
    dates: [],
  };
  if (setMemoryKey) s.inject = { memoryEnabled: memory, away };
  return { get: () => s };
}
const build = (opts = {}) => buildSnapshotText(null, mkMemory(), mkSettings(opts), 's1', { keywords: [], now: Date.now() });
const textOf = (opts) => String((build(opts) || {}).text || '');

// ---------------- 1) 默认值:1.7.2 的行为一个字节都不变 ----------------
section('默认值(关掉"新功能悄悄改默认"这条老路)');
check(DEFAULT_SETTINGS.inject && DEFAULT_SETTINGS.inject.memoryEnabled === true,
  'DEFAULT_SETTINGS.inject.memoryEnabled 默认 true(1.7.2 行为不变)');
{
  const noKey = textOf({ setMemoryKey: false });   // 设置里压根没有 inject 子树
  const explicit = textOf({ memory: true });       // 显式 memoryEnabled:true
  check(noKey === explicit, '未设置 inject.memoryEnabled ≡ 显式 true(两条路径产出同一段文本)');
  check(noKey.includes('器灵') && noKey.includes(DEEP_TEXT) && noKey.includes(LOG_SECTION),
    '默认:人格 + 记忆 + 树改动三段都在');
}

// ---------------- 2) 三键别名矩阵(1.7.3 夜 F 类盲审后的核心判据) ----------------
// 判据:任何一个"少给她一点"的旧配置,一律归为暂离 —— **半开状态不可达**。
// 这组断言全部是"反转"自 1.7.3 白天版的双开关矩阵:那版被测出的洞正是
// `persona.enabled=false` + `memoryEnabled=true` 会产出"人格不出、记忆照出"。
section('三键别名矩阵:任一为关 ⇒ 全部暂离(不存在半开)');
{
  const t = textOf({ persona: true, memory: true });
  check(t.includes('器灵'), '①开②开:人格段在');
  check(t.includes(DEEP_TEXT), '①开②开:L1 深层库条目在');
  check(t.includes(LOG_SECTION), '①开②开:树改动播报在');
}
{
  const t = textOf({ persona: true, memory: false });
  check(!t.includes('器灵'), '①开②关:人格段**也消失**(旧键是 away 的别名,不再允许"关记忆留人格")');
  check(!t.includes(DEEP_TEXT), '①开②关:L1 记忆段消失');
  check(!t.includes(LOG_SECTION), '①开②关:树改动播报一起消失(它属记忆面)');
}
{
  const t = textOf({ persona: false, memory: true });
  check(!t.includes('器灵'), '①关②开:人格段消失');
  check(!t.includes(DEEP_TEXT), '①关②开:L1 记忆段**也消失**(不许出现"别人在读她档案"的半开态)');
  check(!t.includes(LOG_SECTION), '①关②开:树改动播报一起消失');
}
{
  const t = textOf({ persona: false, memory: false });
  check(!t.includes('器灵') && !t.includes(DEEP_TEXT) && !t.includes(LOG_SECTION),
    '①关②关:三段全无(时间锚不在快照里,由 inject.js 兜底)');
  check(t.trim().length < 200, '①关②关:文本接近空(实际 ' + t.trim().length + ' 字)');
}
// 1.7.3 夜新增总闸:away 一开,两个细档怎么写都无效
{
  const t = textOf({ persona: true, memory: true, away: true });
  check(!t.includes('器灵') && !t.includes(DEEP_TEXT) && !t.includes(LOG_SECTION),
    '③away=true:两个细档都为开时,三段仍然全无(总闸压过别名)');
}

// ---------------- 3) 记忆闸不该顺手关掉"细一档"的既有开关 ----------------
section('细一档的既有开关仍各自独立(不因新闸上线而失效)');
{
  const s = mkSettings({ persona: true, memory: true });
  const st = s.get();
  st.memory.l1Enabled = false;
  const t = String((buildSnapshotText(null, mkMemory(), s, 's1', { keywords: [] }) || {}).text || '');
  check(!t.includes(DEEP_TEXT), 'memory.l1Enabled=false 仍能单独关掉 L1');
  check(t.includes(LOG_SECTION), 'memory.l1Enabled=false 不影响树改动播报(两件事)');
}

// ---------------- 4) 写面白名单 ----------------
section('写面白名单:只收白名单键 + 只收真布尔');
{
  const a = sanitizeInjectPatch({ memoryEnabled: false });
  check(a.clean && a.clean.memoryEnabled === false, 'memoryEnabled:false 被采纳');
  check(!a.dropped || !a.dropped.length, 'memoryEnabled:false 无丢弃');
}
{
  const a = sanitizeInjectPatch({ memoryEnabled: true });
  check(a.clean && a.clean.memoryEnabled === true, 'memoryEnabled:true 被采纳');
}
{
  // 字符串 "false" 不猜:面板/脚本传错类型时,宁可丢弃也不要把"关"读成"开"(或反之)
  for (const bad of ['false', 'true', 0, 1, null]) {
    const a = sanitizeInjectPatch({ memoryEnabled: bad });
    check(!a.clean || !Object.prototype.hasOwnProperty.call(a.clean, 'memoryEnabled'),
      '非布尔值 ' + JSON.stringify(bad) + ' 不被采纳');
    check(Array.isArray(a.dropped) && a.dropped.includes('memoryEnabled'),
      '非布尔值 ' + JSON.stringify(bad) + ' 进 dropped(如实回报丢在哪)');
  }
}
{
  const a = sanitizeInjectPatch({ persona: { enabled: false }, l1Enabled: false, branchLogEnabled: false });
  check(!Object.keys(a.clean || {}).length, '白名单外的键一个都不落(人格走 /persona,细档走各自入口)');
  check(Array.isArray(a.dropped) && a.dropped.length === 3, '三个白名单外键全部进 dropped');
}

// ---------------- 5) 接线判据(防"代码改了门没接上") ----------------
section('接线判据:端点 / 方法闸 / 工具面 / 面板文案');
const read = (p) => readFileSync(join(root, p), 'utf8');
{
  const api = read('lib/host/api.js');
  check(api.includes("register('/inject'"), '/inject 端点已注册');
  check(api.includes('sanitizeInjectPatch('), '/inject 走白名单收窄(不是原样深合并)');
  check(/DUAL_METHOD_READ_PATHS\s*=\s*new Set\(\[[^\]]*'\/inject'/.test(api), '/inject 进双方法只读名单(GET 能读)');
  check(/POST_ONLY[\s\S]{0,4000}?\/inject/.test(api), '/inject 进 POST_ONLY(写面只认 POST)');
  check(api.includes("settings.update({ inject: clean })"), '/inject 落的是 inject 子树');
  check(api.includes('invalidateSession(gate, memory, settings, sid)'), '/inject 写后让快照失效(下一轮生效)');
  // 审计红2b 追加:`memory` 只是开关值,L1 还受 memory.l1Enabled 与仓外总闸管 ⇒
  // 必须另报一个"真的在注入"(memoryActive),否则面板会出现"开关开着却没注入"的说谎态。
  check(api.includes('memoryActive:'), 'GET /inject 分开报开关值(memory)与真实注入态(memoryActive)');
  // 1.7.3 夜:`away` 也进 this合取 —— 不在场就没有"真的在注入"这回事
  check(/memoryActive: !away && master && memory && l1/.test(api), 'memoryActive = 非离场 && 总闸 && 开关 && 细档(四闸合取)');
}
{
  const guard = read('lib/host/guard.js');
  check(/INJECT_PATCH_KEYS\s*=\s*Object\.freeze\(\[[^\]]*'memoryEnabled'/.test(guard), 'INJECT_PATCH_KEYS 已冻结且含 memoryEnabled');
  check(guard.includes('export function sanitizeInjectPatch'), 'sanitizeInjectPatch 已导出');
}
{
  // 2026-10-27 主人定:**工具不随开关②收走** —— 要剥离工具的只有子代理(子代理不算器灵,
  // 算被临时拉起来的外包人员)。所以这里钉的是"工具面**不**读这个键",而不是反过来。
  const tools = read('lib/host/tools.js');
  check(!tools.includes('MEMORY_FACE_TOOLS'), '工具面不再按记忆开关少注册(主人当日否掉)');
  check(!/inject\?\.memoryEnabled\s*!==\s*false/.test(tools), 'tools.js 不得再读 inject.memoryEnabled');
  check(tools.includes("tools.memory_skipped', '0'"), '旧的"少注册"留痕被显式清零(防止读到历史误判)');
  for (const n of ['TOOL_TREE_READ', 'TOOL_BRANCH_EDIT', 'TOOL_RECALL', 'TOOL_DEEP_ITEM', 'TOOL_LIBRARY_SEARCH', 'TOOL_LIBRARY_CHECK', 'TOOL_RULE_ADD', 'TOOL_HABIT_PROPOSE']) {
    check(tools.includes(n), '器灵本体仍注册 ' + n + '(关记忆不夺走她自己的工具)');
  }
  // 子代理那一刀在注册期:agent-tools.js 的 bindOne() 里按 sessionKind 早退
  const at = read('lib/host/agent-tools.js');
  check(at.includes("sessionKind(header) === 'subagent'"), '子代理剥离仍在 agent-tools.js 注册期');
  check(at.includes("reason: 'subagent-skip'"), '子代理跳过有专属 reason(可观测)');
  check(at.includes('subagentSkipped'), '子代理跳过有计数暴露');
  // 后台随闸:自动深摘 + 反馈成长回路必须与记忆开关同源
  const idx = read('lib/index.js');
  check(/const memoryFaceOn/.test(idx), 'index.js 有记忆面开关判据');
  // 1.7.3 夜:离场是**运行时**动作 ⇒ 门槛从"启动时装不装监听"改成"每次现问"。
  //   所以这里钉的是"判据是个函数、且两处调用都带括号",而不是旧的 `&& memoryFaceOn` 形态。
  check(/registerFeedbackListener\(ctx, memory, settings\)/.test(idx), '反馈成长回路:监听常驻,离场闸在 handler 里现问');
  // 1.7.3 夜 F 类第三轮(盲审 F3):定时器**注册**不再被"此刻在不在场"挡住 ——
  //   挡住的话,启动时正暂离 ⇒ timer 根本不存在,回来也没有补挂路径(要重启才恢复)。
  check(/if \(!disposed && p\.ok && auto\.deepSummary\)/.test(idx),
    '自动深摘定时器不按启动时的在场状态决定注册(否则启动即离场 ⇒ 回来不恢复)');
  check(/if \(!memoryFaceOn\(\)\) return;/.test(idx), '自动深摘定时器每轮现问一次(离场不用重启)');
  // 审计红2b(2026-10-27)追加:上面几条只 grep 字面量名,**不验值** ⇒ 把 `memoryFaceOn` 写成
  // 硬编码 `true`(等于关了也照跑后台)时,这几条仍然全绿。补一条盯住它**真的读设置**。
  check(/const memoryFaceOn = \(\) => \{[\s\S]{0,200}?return !awayFromSettings\(settings\?\.get\?\.\(\)\);[\s\S]{0,80}?catch/.test(idx),
    'memoryFaceOn 真的读设置(走 awayFromSettings 这一个判据,不是硬编码常量)');
}
{
  const client = read('lib/client.js');
  // 1.7.3 夜(2026-10-27 主人定):面板回到**一个**开关「器灵在场 / 她暂离」。
  //   旧断言钉的是"两个勾都在",现在反过来钉:"只有在场这一个,且旧的人格单勾已撤"
  //   —— 因为两个勾能拼出两种不是人的状态(见文件头第 5 节)。
  check(client.includes('器灵在场'), '面板:一个开关「器灵在场」');
  check(!client.includes('启用人格注入'), '面板:旧的人格单勾已撤(不许留成第二个零件)');
  check(!client.includes('启用记忆与图书馆'), '面板:旧的记忆单勾已撤');
  // 只查**界面字面量**:注释里留着"旧文案错在哪"的历史说明是有价值的,不能一起打死
  const liveOldLabel = client.split('\n').filter((l) => l.includes('完全原生助手') && !l.trim().startsWith('//'));
  check(!liveOldLabel.length, '面板:不再承诺「完全原生助手」(旧界面文案已撤,' + liveOldLabel.length + ' 处残留)');
  check(client.includes("api('/inject', { method: 'POST'"), '面板:开关有真实写回路');
  check(client.includes('injectEnabled:false'), '面板:能说破仓外总闸(cfg.injectEnabled)已关');
  // 悬浮注解(2026-10-27 主人:「关记忆一起停,但是要悬浮注解说出来」→ 离场是四处一起停,更要写清)
  check(client.includes('关掉这个勾 = 她暂离'), '面板悬浮注解:一句话说清这是一个状态');
  check(client.includes('后台停止整理'), '面板悬浮注解:说清后台会停(深摘/反馈成长)');
  check(client.includes('离场期间产生的会话**不入库**'), '面板悬浮注解:说清离场期间的会话不入库');
  check(client.includes('看得见,但不进记忆库'), '面板悬浮注解:说清"续聊旧会话会被宿主当上下文"(看得见≠记得住)');
  check(client.includes('memory.index') === false, '面板悬浮注解:不夹带内部术语(memory.index)');
  check(client.includes('memRow.title = MEM_TIP'), '面板悬浮注解:真的挂到了控件上(不是只写了字符串)');
  // 审计蓝2(2026-10-27)追加:开关切换的 toast 一度还在说"工具要新会话才有 / 已绑的留到会话结束",
  // 与主人当日定下的「工具不收、只对子代理剥离」矛盾 —— 面板三处文案必须同口径。
  check(!/已绑的?工具留到|新会话不再给工具|工具要新会话才有/.test(client),
    '面板 toast 不得再声称开关② 会增删器灵本体的工具(口径:工具不收)');
  // ── U4 的护栏(2026-10-27 反证抓出来的缺口)────────────────────────────────
  // 原先没有任何断言钉住「渲染期写 store 已搬进 effect」:把 effect 删掉、回到
  // `if (sidFromProps && st.sessionId !== sidFromProps) store.set(...)` 的渲染期写法,
  // 整链 58 段**仍然全绿**(反证脚本 counterproof.mjs 的 F4 实测)⇒ 那是一条无护栏的修复。
  // 现在三条钉死:effect 存在、依赖带 sidFromProps、渲染路径里只留这一处写。
  check(client.includes('if (store.get().sessionId !== sidFromProps) store.set({ sessionId: sidFromProps });'),
    'U4:sessionId 校正走 effect(现读 store,不在渲染期用快照值)');
  check(/}, \[sidFromProps\]\);/.test(client), 'U4:effect 依赖带 sidFromProps(同实例换会话也校正)');
  const sidWrites = client.split('\n').filter((l) => l.includes('store.set({ sessionId: sidFromProps })') && !l.trim().startsWith('//'));
  check(sidWrites.length === 1, 'U4:渲染路径不再直接写 store(只该剩 effect 里那 1 处,' + sidWrites.length + ' 处)');
  // 蓝2 反证(2026-10-27)追加:下面两条在真树上撤回后**发布测试仍全绿**(蓝2 只能靠自写 VM 探针抓)。
  // 它们属"面板接线"这一族,用静态判据钉住,免得将来改错字段/删掉绑定却没人发现。
  check(client.includes('memBox.checked = !away;'), '面板:勾选状态读的是 eff.away(一个键,不是 persona/其它字段)');
  check(/memBox\.addEventListener\('change'/.test(client), '面板:开关② 真的绑了 change 事件(不是定义完没人调)');
  check(client.includes('applyMemorySwitch(memBox.checked)'), '面板:change 事件把当前值交给写回路');
}

// ---------------- 5b) 仓外总闸必须也管住"不走 section 的记忆内容"(1.7.3 E 类补审) --------
// 缺陷(红队 E-6 实测):`cfg.injectEnabled:false` 只关掉 `registerMemorySection`(section + 时间锚),
//   而 `wireSessionLine` 仍每轮把 `[本次会话·进展] {标题}{进展}` 当 **user 消息**塞进
//   `decision.messages`,内容取自 `memory.overviewById` —— **记忆照样进上下文**;索引 skill 也照挂。
//   而面板写着"整段注入(含时间锚)已被总闸关掉" ⇒ issue #2 同款的"说了没做",且是我们自己写的那句。
// 修法:两条旁路同取 `cfg.injectEnabled`;关到底时把"段注册实况"写成显式 0(不留下上一轮的 '1')。
{
  const idx = read('lib/index.js');
  check(/if \(cfg\.injectEnabled !== false\)\s*disposers\.push\(wireSessionLine\(/.test(idx),
    '总闸也管进展行:关到底是"记忆内容一条都不进上下文",不是"只剩 section 关了"');
  // 1.7.3 夜 F 类:判据收成 awayFromSettings(三个键的别名),所以断言钉"总闸 + 该函数",
  //   而不是再钉两个字面键名 —— 键名的比较已经搬进 away.js,由 F 类专测覆盖。
  check(/cfg\.injectEnabled !== false[\s\S]{0,120}?!awayFromSettings\(settings\.get\(\)\)/.test(idx),
    '索引 skill 同时受总闸 + 离场判据管(否则注入关了、说明书还教模型去 recall)');
  check(read('lib/client.js').includes('进展行与索引技能都已被总闸关掉'),
    '面板文案与实情一致(总闸关时到底关了什么,逐项说清)');
  // 真出口:关到底时 kv 必须写显式读数 —— 否则 `GET /inject` 会把上一轮启动留下的 '1' 当"段注册实况"回出去
  const { registerMemorySection } = await imp('lib/host/inject.js');
  const kv = new Map();
  const mem = { kvSet: (k, v) => kv.set(k, v) };
  registerMemorySection({}, {}, mem, { get: () => ({}) }, { enabled: false });
  check(kv.get('inject.section_registered') === '0:inject-disabled',
    '总闸关到底:留显式读数 0:inject-disabled(不留下上一轮的 "1" 骗面板)');
}

// ---------------- 6) 升级迁移:老用户"关过注入"的意图不能变 ----------------
// 1.7.2 的判据是 `personaEnabled && l1Enabled`:关掉那个勾 ⇒ L0 与 L1 一起消失。
// 1.7.3 解绑后若不迁移,`inject.memoryEnabled` 的默认 true 会把记忆段**悄悄打开** ——
// 这正是"能力静默变化"里最伤人的一类(用户以为关着,其实回来了)。三条钉死:
//   ① 老用户(只写过 persona.enabled=false、没写过 inject 键)⇒ 迁移成 memoryEnabled=false;
//   ② 他已经写过 inject.memoryEnabled(哪怕 true)⇒ 迁移**不再**覆盖他的选择;
//   ③ 全新用户(什么都没写)⇒ 两个开关都是开的(1.7.2 默认行为逐字不变)。
section('升级迁移:老用户关掉注入的意图要保住');
{
  const { SettingsFile } = await imp('lib/host/settings-file.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const mk = () => mkdtempSync(join(tmpdir(), 'ling-inj-mig-'));

  // ① 老用户:只写过 persona.enabled=false
  const d1 = mk();
  writeFileSync(join(d1, 'settings.json'), JSON.stringify({ __v: 2, user: { persona: { enabled: false, aiName: 'x' } } }));
  const s1 = new SettingsFile(d1);
  check(s1.get().inject?.away === true, '老用户 persona.enabled=false ⇒ 迁移后 away=true(整个器灵暂离)');
  check(s1.get().inject?.memoryEnabled !== false, '迁移**不许**写成 memoryEnabled=false(那会留下「失忆的她」)');
  check(s1.get().persona?.enabled === false, '迁移不动人格开关本身');
  check(s1.get().persona?.aiName === 'x', '迁移不丢其它用户字段');
  check(s1.migratedFrom.length === 1, '迁移留痕 1 条: ' + JSON.stringify(s1.migratedFrom));

  // ② 1.7.3 夜 F 类**反转**:写过 `memoryEnabled:true` 但没写 `away`、且人格是关的 ——
  //    这正是白天版漏网的那个组合(迁移原条件要求"没有 memoryEnabled 键",于是它原样留在
  //    `enabled=false + memoryEnabled=true` ⇒ 人格不出、记忆照出)。现在必须迁成暂离。
  const d2 = mk();
  writeFileSync(join(d2, 'settings.json'), JSON.stringify({ __v: 2, user: { persona: { enabled: false }, inject: { memoryEnabled: true } } }));
  const s2 = new SettingsFile(d2);
  check(s2.get().inject?.away === true, '漏网组合(enabled=false + memoryEnabled=true)⇒ 迁移成 away=true');
  check(s2.migratedFrom.length === 1, '该组合迁移留痕 1 条: ' + JSON.stringify(s2.migratedFrom));

  // ②b 已经显式写过 `away` ⇒ 尊重它,不再替他改(此处 away:false + 人格关 ⇒ 由判据层兜住)
  const d2b = mk();
  writeFileSync(join(d2b, 'settings.json'), JSON.stringify({ __v: 2, user: { persona: { enabled: false }, inject: { away: false } } }));
  const s2b = new SettingsFile(d2b);
  check(s2b.get().inject?.away === false, '显式 away:false 不被迁移覆盖');
  check(!s2b.migratedFrom.length, '不迁移时不留痕');
  const { awayFromSettings } = await imp('lib/host/away.js');
  check(awayFromSettings(s2b.get()) === true, '但判据层仍判暂离(别名:人格关 ⇒ 暂离),半开不可达');

  // ③ 全新用户:在场(memoryEnabled 默认 true、away 默认 false)
  const s3 = new SettingsFile(mk());
  check(s3.get().inject?.memoryEnabled === true, '全新用户 memoryEnabled=true');
  check(s3.get().inject?.away === false, '全新用户 away=false(在场)');
  check(s3.get().persona?.enabled === true, '全新用户 persona.enabled=true');
  check(!s3.migratedFrom.length, '全新用户不触发迁移');

  // ④(2026-10-27 A 路审计补):迁移**必须**能被随后的 update() 顺带落盘 ——
  //    审计提"只改内存不落盘 ⇒ 用户开人格后重启,迁移不再触发 ⇒ 记忆静默回来"。
  //    实测这条不成立(update() 写的是整份 this.user,迁移已在其中),但这是**靠实现细节
  //    撑着的一致性**,必须钉住:哪天 update() 改成"只写 patch",这条就会真的坏。
  const d4 = mk();
  writeFileSync(join(d4, 'settings.json'), JSON.stringify({ __v: 2, user: { persona: { enabled: false } } }));
  const s4 = new SettingsFile(d4);
  await s4.update({ persona: { enabled: true } });
  const { readFileSync } = await import('node:fs');
  const disk4 = JSON.parse(readFileSync(join(d4, 'settings.json'), 'utf8'));
  check(disk4.user?.inject?.away === true, 'update() 之后盘上带着迁移结果: ' + JSON.stringify(disk4.user));
  // 且重启后**不再**触发迁移(它已经成了用户自己的显式值),但她仍是暂离的
  const s4b = new SettingsFile(d4);
  check(s4b.get().inject?.away === true, '重启后仍是暂离(迁移已落盘)');
  check(!s4b.migratedFrom.length, '重启后不再重复迁移');

  // ⑤(A 路审计补):`inject` 被手改成非纯对象时,不许**静默**被迁移覆盖 —— 至少要有警告
  const d5 = mk();
  writeFileSync(join(d5, 'settings.json'), JSON.stringify({ __v: 2, user: { persona: { enabled: false }, inject: 'disabled' } }));
  const s5 = new SettingsFile(d5);
  check(s5.warnings.length >= 1, '非法 inject(字符串)要有警告: ' + JSON.stringify(s5.warnings));
  check(s5.warnings.some((w) => w.indexOf('不是对象') >= 0), '警告里说清是"不是对象"');
  check(s5.get().inject?.away === true, '非法值不拦住迁移(结果仍是暂离)');
  const d6 = mk();
  writeFileSync(join(d6, 'settings.json'), JSON.stringify({ __v: 2, user: { inject: [] } }));
  const s6 = new SettingsFile(d6);
  check(s6.warnings.some((w) => w.indexOf('不是对象') >= 0), '数组形态也给警告');
}

// ---------------- 3) 水位:关着的时候**不许**把没示人的改动标成已读 ----------------
// 红队 B 路抓到的那条(2026-10-27):快照侧渲染已被 memoryEnabled 闸住,但 inject.advanceLogWatermark
// 的 announceOn 原来只判 branchLogEnabled ⇒ 关着期间 shown/retired 照旧被消费,重新打开后
// 那批改动**永远看不到**。这里直接跑 renderMemorySection(真出口),验两件事:
//   ① 记忆关着 ⇒ 文本里没有播报(现有行为);② 两个水位**一动不动**,而 `.last` 照走。
section('水位:关记忆期间不消费"已示人/已处置"(重新打开仍看得见)');
{
  const { renderMemorySection } = await imp('lib/host/inject.js');
  const mkGate = () => ({
    _snap: new Map(),
    snapshotOf(sid) { return this._snap.get(sid); },
    isRunning() { return false; },              // 走"懒重建"分支,一次性把水位推进逻辑跑完
    markSnap(sid, v) { this._snap.set(sid, v); },
    markSnapStale() {},
    recentSessionId: () => 's1',
    snapshotIds: () => ['s1'],
  });
  const asm = { agent: { session: { id: 's1', header: {} } } };

  // ① 关着:文本不含播报,且 shown/announced/retired 一个都不写
  const memOff = mkMemory();
  const gateOff = mkGate();
  const txtOff = renderMemorySection(asm, gateOff, memOff, mkSettings({ memory: false }));
  check(!txtOff.includes(LOG_SECTION), '关记忆:文本里没有树改动播报');
  check(memOff.kvGet('branch_log_wm.s1') === undefined, '关记忆:不写会话级"已示人"水位');
  check(memOff.kvGet('branch_log_wm.announced') === undefined, '关记忆:不写全局 announced 水位');
  check(memOff.kvGet('branch_log_wm.retired') === undefined, '关记忆:不写 retired 水位');
  check(String(memOff.kvGet('branch_log_wm.last')) === '7', '关记忆:.last 照走(复盘退出判据不停摆)');

  // ② 打开:同一批改动仍然会被播报(证明上面没把它标成已读)
  const gateOn = mkGate();
  const txtOn = renderMemorySection(asm, gateOn, memOff, mkSettings({ memory: true }));
  check(txtOn.includes(LOG_SECTION), '重新打开:那批改动仍被播报(没被吞)');
  check(String(memOff.kvGet('branch_log_wm.s1')) === '7', '打开后:会话级水位正常推进到 7');
}

// ---------------- 4b) 索引层 skill 也挂在 ② 上 ----------------
// 红队审计(2026-10-27)指出:8 件工具关掉之后,`memory-index` 这份 skill 仍在目录里,
// 而它的 description/正文都在教模型"用 recall 搜我的记忆" ⇒ 指令与能力对不上。
section('索引层 skill 随「记忆与图书馆」开关');
{
  const { registerIndexSkill } = await imp('lib/host/deep-index-skill.js');
  let registered = 0;
  const fakeCtx = { skills: { register: () => { registered += 1; return () => {}; } } };
  const off = registerIndexSkill(fakeCtx, { enabled: false });
  check(Array.isArray(off) && off.length === 0, '关着:不注册、也不留 disposer');
  check(registered === 0, '关着:skills.register 一次都没被调用');
  registerIndexSkill(fakeCtx, { enabled: true });
  check(registered === 1, '开着:正常注册一次');
  // 接线判据:index.js 必须真的把开关传下去(否则上面的函数再对也没人用)
  const idx = readFileSync(join(root, 'lib/index.js'), 'utf8');
  // 允许 `{` 与 `enabled:` 之间夹注释(1.7.3 夜在两者之间写了离场判据的说明)—— 判的是"传了参数",不是格式
  check(/registerIndexSkill\(ctx,\s*\{[\s\S]{0,400}?enabled:/.test(idx), 'index.js 把开关(含离场)传给了 registerIndexSkill');
}

// ---------------- 5) 「在场 / 暂离」= 一个键的总闸(1.7.3 夜 · 2026-10-27 主人定) ----------------
// 判据来源:两个并列开关能拼出"人格开+记忆关"(有身份没经历)与"人格关+记忆开"(别人在读她的档案)
// 两种不是人的状态;主人拍板「关了就全关,是暂时分别」⇒ 用一条总闸压住,坏格子**不可达**。
section('在场 / 暂离:一个键派生四处');
{
  const { withinAwayWindow, syncAwayWindow, awaySummary, isAwayNow } = await imp('lib/host/away.js');
  check(DEFAULT_SETTINGS.inject.away === false, 'DEFAULT_SETTINGS.inject.away 默认 false(= 在场,行为与 1.7.2 逐字相同)');

  // 写面白名单:away 必须能被 /inject 写,且只收真布尔
  check(sanitizeInjectPatch({ away: true }).clean.away === true, 'sanitizeInjectPatch 放行 away=true');
  check(sanitizeInjectPatch({ away: 'false' }).dropped.includes('away'), 'away 只收真布尔(字符串 "false" 被丢)');

  // 快照层:away=true 时人格段与记忆段**一起不出**(总闸,不是靠两个细档各让一步)
  const sAway = (() => { const base = mkSettings({}).get(); base.inject = { ...(base.inject || {}), away: true }; return { get: () => base }; })();
  const awayText = String((buildSnapshotText(null, mkMemory(), sAway, 's1', { keywords: [], now: Date.now() }) || {}).text || '');
  check(!awayText.includes(DEEP_TEXT), '暂离:深层库/记忆段不注入');
  check(!awayText.includes(LOG_SECTION), '暂离:树改动播报不注入');
  check(!awayText.includes('用户'), '暂离:人格段(称呼/身份)不注入');
  const onText = textOf({});
  check(onText.includes(DEEP_TEXT) && onText.includes('用户'), '在场:同一份数据照常注入(负对照 —— 免得"永远不注入"也过)');

  // 区间台账:开 ⇒ 记 from(to=null);关 ⇒ 补 to;两个入口(实时/差分)都按区间判
  const mem = mkMemory();
  const mkS = (away) => ({ get: () => ({ inject: { away } }) });
  check(isAwayNow(mkS(true)) === true && isAwayNow(mkS(false)) === false, 'isAwayNow:读的是 inject.away');
  check(syncAwayWindow(mem, mkS(true), Date.UTC(2026, 9, 27, 12, 0, 0)) === 'opened', 'sync:离场 ⇒ 开一段区间');
  check(awaySummary(mem).open === true, '区间台账:open=true 表示"至今未归"');
  check(withinAwayWindow(mem, Date.UTC(2026, 9, 27, 12, 5, 0)) === true, '离场区间内的消息 ⇒ 判为"不入库"');
  check(withinAwayWindow(mem, Date.UTC(2026, 9, 27, 11, 55, 0)) === false, '离场之前的消息 ⇒ 照常入库');
  check(syncAwayWindow(mem, mkS(true), Date.UTC(2026, 9, 27, 12, 30, 0)) === null, 'sync 幂等:开关没变就不新开一段');
  check(syncAwayWindow(mem, mkS(false), Date.UTC(2026, 9, 27, 13, 0, 0)) === 'closed', 'sync:回来 ⇒ 补 to');
  check(withinAwayWindow(mem, Date.UTC(2026, 9, 27, 14, 0, 0)) === false, '回来之后的消息 ⇒ 照常入库');

  // 接线判据(源码级):四处派生都得真的接上,否则"总闸"只是文档里的一句话
  const srcSnap = readFileSync(join(root, 'lib/host/snapshot.js'), 'utf8');
  const srcLine = readFileSync(join(root, 'lib/host/session-line.js'), 'utf8');
  const srcTools = readFileSync(join(root, 'lib/host/tools.js'), 'utf8');
  const srcLife = readFileSync(join(root, 'lib/host/lifecycle.js'), 'utf8');
  const srcIdx = readFileSync(join(root, 'lib/index.js'), 'utf8');
  const srcClient = readFileSync(join(root, 'lib/client.js'), 'utf8');
  check(/const away = awayFromSettings\(s\)/.test(srcSnap), 'snapshot.js 由唯一判据 awayFromSettings 派生人格/记忆两条闸');
  check(/awayFromSettings\(s\)\) return false/.test(srcLine), 'session-line.js:离场时进展行也不出(走同一判据)');
  check(/const awayRefusal = \(\) =>/.test(srcTools) && /awayGated\(spec\)/.test(srcTools), 'tools.js:记忆工具执行即拒(不是不注册)');
  check(/withinAwayWindow\(memory, time\)/.test(srcLife), 'lifecycle.js:两个入库入口都按离场区间过滤');
  // 1.7.3 夜 F 类盲审补:深摘是**第二个绕过去**的入口(回退磁盘转录,不认离场窗口)
  const srcDeep = readFileSync(join(root, 'lib/host/deepsummary.js'), 'utf8');
  check(/transcriptFromFile\(candidate\.file, \{ skipTime: inAway \}\)/.test(srcDeep),
    'deepsummary.js:磁盘转录按离场窗口过滤(堵住"归来后自动深摘补记离场内容")');
  check(/buildTranscript\(memory, sessionId, \{ source: overview\.source, skipTime: inAway \}\)/.test(srcDeep),
    'deepsummary.js:DB 转录同判据(两条通道不许一条过滤一条不过滤)');
  check(/reason: 'away-only'/.test(srcDeep) && /deep\.away:/.test(srcDeep),
    'deepsummary.js:整段都在离场窗口 ⇒ 独立标记(不用 deep.skip,免得 1.8 补课捞不起来)');
  check(/const memoryFaceOn = \(\) =>/.test(srcIdx), 'index.js:后台闸是运行时函数(离场不用重启)');
  check(srcClient.includes('器灵在场'), '面板:一个开关「器灵在场」');
  check(!srcClient.includes('启用人格注入'), '面板:旧的人格单勾已撤(不许留成"第二个零件")');
}

// ---------------- 7) F 类盲审回修:三键别名 + 深摘不得从磁盘绕过 ----------------
section('F 类:三键别名与深摘的离场过滤');
{
  const { awayFromSettings } = await imp('lib/host/away.js');
  check(awayFromSettings({ inject: { away: true } }) === true, 'away=true ⇒ 暂离');
  check(awayFromSettings({ persona: { enabled: false } }) === true, 'persona.enabled=false ⇒ 暂离(别名)');
  check(awayFromSettings({ inject: { memoryEnabled: false } }) === true, 'inject.memoryEnabled=false ⇒ 暂离(别名)');
  check(awayFromSettings({ persona: { enabled: true }, inject: { away: false, memoryEnabled: true } }) === false,
    '三键全开 ⇒ 在场');
  check(awayFromSettings(null) === false && awayFromSettings({}) === false, '空设置 ⇒ 在场(fail-open,不误伤)');
}
{
  const { transcriptFromFile } = await imp('lib/host/deepsummary.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { zstdCompressSync } = await import('node:zlib');
  const dir = mkdtempSync(join(tmpdir(), 'ling-away-tr-'));
  const file = join(dir, 's.jsonl');
  const userLine = (t, text) => JSON.stringify({ type: 'user/message', time: t, data: { kind: 'user', content: [{ type: 'text', text }] } }) + '\n';
  const asstLine = (t, text) => JSON.stringify({ type: 'assistant/message', time: t, data: { message: { content: [{ type: 'text', text }] } } }) + '\n';
  // ⚠️ 会话文件是 **zstd 拼接帧**(`decodeAll` 只解帧,纯文本会被解成空串)⇒ 夹具必须真的压缩。
  const frames = [
    userLine(1000, '离场期间说的话'),
    asstLine(1001, '离场期间的回复'),
    userLine(9000, '她回来之后的话'),
  ].map((s) => zstdCompressSync(Buffer.from(s, 'utf8')));
  writeFileSync(file, Buffer.concat(frames));
  const tr = transcriptFromFile(file, { skipTime: (ms) => ms >= 0 && ms < 5000 });
  check(tr.dropped === 2, '深摘转录:离场窗口内的 2 条被丢(实际 ' + tr.dropped + ' 条)');
  check(!tr.text.includes('离场期间'), '深摘转录:被丢的消息**不进** LLM 输入(否则就是伪造记忆)');
  check(tr.text.includes('她回来之后') && tr.users === 1, '深摘转录:离场之后的消息照常保留');
}

// ---------------- 8) 离场边界分级:复盘产物停,档案整理照常 ----------------
// 判据(2026-10-27 夜 · 主人原话):「离开之后动手术不行…给那些乱七八糟的会话名字命名这种可以,
// 复盘改记忆树结构也不行 —— 对坐复盘,人都不在了,还复盘啥呀」。
// ⇒ 闸不是"一律",而是按**要不要她参与判断**分两类。
section('离场边界:复盘产物停,档案整理照常');
{
  const srcApi = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const guarded = (p) => new RegExp(
    "register\\('" + esc(p) + "', async \\(req, res\\) => \\{\\s*if \\(awayGuard\\(res, 'structure'\\)\\) return;").test(srcApi);

  // ① 需要她参与判断/不可逆的写面:必须接结构闸
  const STRUCTURE = [
    '/branches/create', '/branches/delete', '/branches/reparent', '/branches/rename', '/branches/weight',
    '/veins/link', '/veins/unlink',
    '/conflicts/record', '/conflicts/resolve', '/conflicts/judge', '/conflicts/scan',
    '/vein/distill', '/vein/suggestion/resolve',
    '/tree/snapshot', '/tree/restore', '/tree/snapshot/delete', '/tree/autobuild/apply',
    '/branch/assign', '/suggestions/apply',
    '/memories/delete',
  ].filter((p) => !guarded(p));
  check(STRUCTURE.length === 0, '结构类写面 20 处全接离场闸(漏:' + (STRUCTURE.join(',') || '无') + ')');

  // ② 纯整理类:不许误拦(她不在也能改会话名)
  const ALLOWED = ['/memories/rename', '/memories/retitle', '/memories/pin'].filter((p) => guarded(p));
  check(ALLOWED.length === 0, '会话改名/标签离场照常(误拦:' + (ALLOWED.join(',') || '无') + ')');

  // ③ 提示分两种口径,不再"一律停";且要点明"复盘"这件事
  check(/kind === 'structure'/.test(srcApi), '离场回执分两级(结构 / 写入),不是一句"一律停"');
  check(/复盘/.test(srcApi), '结构级回执说明理由:这些是复盘产物,要她本人在场');
  check(!/记忆写入一律停/.test(srcApi), '旧的"写入一律停"措辞已撤(那句会把"给会话改名"也冤枉进去)');
}

// ---------------- 收口 ----------------
if (!ok) {
  console.log('\n注入面双开关 有断言失败 ✗');
  process.exit(1);
}
console.log('\n注入面双开关(人格 / 记忆与图书馆) 全部通过 ✓');
