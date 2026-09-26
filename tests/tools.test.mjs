// 第 18 套:会话内工具层(rule_add / habit_propose)—— 纯对象注册、自校验、护栏
// 覆盖:注册契约(不依赖 dsh-tools)、缺原话拒绝、习惯不可直达、渲染回执、无 tools 服务时降级
// 2026-09-26 加:关①.6 合规判据表(tools/compliance-spec.mjs)的纯函数行为 + README 声明面现状
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { MemoryStore } = await imp('lib/host/memory.js');
const { rulesOf, habitsOf, habitsPendingOf } = await imp('lib/host/rules.js');
const {
  registerLingTools, checkRuleAdd, checkHabitPropose, checkHabitResolve,
  checkTreeRead, checkBranchEdit, checkForget, checkBackfill,
  RULE_ADD_SPEC, HABIT_PROPOSE_SPEC, HABIT_RESOLVE_SPEC,
  TREE_READ_SPEC, BRANCH_EDIT_SPEC, MEMORY_FORGET_SPEC, MEMORY_BACKFILL_SPEC,
  TOOL_RULE_ADD, TOOL_HABIT_PROPOSE, TOOL_HABIT_RESOLVE, TOOL_TREE_READ, TOOL_BRANCH_EDIT,
  TOOL_MEMORY_FORGET, TOOL_MEMORY_BACKFILL,
} = await imp('lib/host/tools.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-tools-'));
const settings = new SettingsFile(join(dir, 'set'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 参数自校验:规矩必须带原话
check(checkRuleAdd({ rule: '先给结论', quote: '以后都先给结论' }).ok === true, '规矩:带原话通过');
check(checkRuleAdd({ rule: '先给结论' }).reason === 'no-quote', '规矩:缺原话 → no-quote');
check(checkRuleAdd({ rule: '   ', quote: 'x' }).reason === 'empty-rule', '规矩:空正文 → empty-rule');
check(checkHabitPropose({ habit: '少用感叹号' }).ok === true, '习惯:正文即可(证据可选)');
check(checkHabitPropose({}).reason === 'empty-habit', '习惯:空正文 → empty-habit');

// 2) 注册契约:纯 JSON-Schema 对象(不得出现 dsh-tools 依赖)
check(RULE_ADD_SPEC.name === 'rule_add' && HABIT_PROPOSE_SPEC.name === 'habit_propose', '工具名');
check(RULE_ADD_SPEC.parameters.required.includes('rule') && RULE_ADD_SPEC.parameters.required.includes('quote'),
  '规矩工具:rule 与 quote 均为必填');
check(/记进规矩/.test(RULE_ADD_SPEC.description) && /绝不从闲聊/.test(RULE_ADD_SPEC.description),
  '规矩工具:描述里写明触发纪律');
check(/不能直接写入/.test(HABIT_PROPOSE_SPEC.description), '习惯工具:描述里写明不可直达');
const src = await import('node:fs').then((m) => m.readFileSync(join(root, 'lib/host/tools.js'), 'utf8'));
check(!/from ['"]@deepseek-ai\//.test(src), '工具模块不 import 任何 @deepseek-ai 包');

// 2b) G1(Part G)树工具:参数自校验 —— 改结构必须给理由
check(TREE_READ_SPEC.name === 'tree_read' && BRANCH_EDIT_SPEC.name === 'branch_edit', '树工具:名字');
check(checkTreeRead({}).ok === true && checkTreeRead({}).action === 'tree', 'tree_read:默认 action=tree');
check(checkTreeRead({ action: 'members' }).reason === 'no-id', 'tree_read:members 缺 id → no-id');
check(checkTreeRead({ action: 'nope' }).reason === 'bad-action', 'tree_read:未知 action → bad-action');
check(checkBranchEdit({ action: 'rename', id: 'br:x', name: 'B', reason: '太乱了整理' }).ok === true,
  'branch_edit:改名通过');
check(checkBranchEdit({ action: 'rename', id: 'br:x', name: 'B' }).reason === 'no-reason',
  'branch_edit:缺理由 → no-reason(改动必须可审计)');
check(checkBranchEdit({ action: 'create', name: 'A', reason: '整理一下' }).ok === true, 'branch_edit:建枝通过');
check(checkBranchEdit({ action: 'create', reason: '整理一下' }).reason === 'empty-name',
  'branch_edit:建枝缺名 → empty-name');
check(checkBranchEdit({ action: 'link', id: 'a', reason: '有关联需要记下来' }).reason === 'no-id',
  'branch_edit:连边缺 to → no-id');
check(checkBranchEdit({ action: 'oops', reason: '整理一下' }).reason === 'bad-action',
  'branch_edit:未知 action → bad-action');
check(/只在主人明确要求/.test(BRANCH_EDIT_SPEC.description), 'branch_edit:描述里写明调用纪律');
check(BRANCH_EDIT_SPEC.parameters.required.includes('reason'), 'branch_edit:reason 是必填参数');

// 2c) G2(Part G)遗忘与回灌 —— **永远不做彻底删除**,目标与理由都必填
check(MEMORY_FORGET_SPEC.name === 'memory_forget' && MEMORY_BACKFILL_SPEC.name === 'memory_backfill',
  '遗忘/回灌:名字');
check(checkForget({ action: 'forget', source: 'dsh', convId: 'c1', reason: '主人说别再提' }).ok === true,
  'forget:目标+理由齐全 → 通过');
check(checkForget({ action: 'forget', source: 'dsh', convId: 'c1' }).reason === 'no-reason',
  'forget:缺理由 → no-reason(遗忘也要可审计)');
check(checkForget({ action: 'forget', reason: '别再提了' }).reason === 'no-target', 'forget:缺目标 → no-target');
check(checkForget({ action: 'list' }).ok === true && checkForget({ action: 'list' }).limit === 30,
  'forget:list 不需要理由');
check(checkBackfill({ action: 'restore', name: 'x' }).reason === 'no-reason', 'backfill:restore 缺理由 → no-reason');
check(checkBackfill({ action: 'inspect' }).reason === 'no-name', 'backfill:inspect 缺归档名 → no-name');
check(checkBackfill({}).ok === true && checkBackfill({}).action === 'list', 'backfill:默认 action=list');
check(/永远不做彻底删除/.test(MEMORY_FORGET_SPEC.description), 'forget:描述写明不会彻底删除');
check(/比遗忘更危险/.test(MEMORY_BACKFILL_SPEC.description), 'backfill:描述写明它更危险');

// 3) 注册行为:可用 ctx / 假 tools 服务
const registered = [];
const fakeCtx = { tools: { register: (spec) => { registered.push(spec); return () => {}; } } };
const r1 = registerLingTools(fakeCtx, { gate: { snapshotIds: () => [] }, memory: { kvSet: () => {} }, settings });
check(r1.ok === true && registered.length === 7, '注册成功:七个工具(G1 加树工具,G2 加遗忘/回灌)');
check(registered.map((s) => s.name).sort().join(',')
  === 'branch_edit,habit_propose,habit_resolve,memory_backfill,memory_forget,rule_add,tree_read',
  '注册的是这七个名字');
const r2 = registerLingTools({ get: () => null }, { gate: null, memory: null, settings });
check(r2.ok === false && r2.reason === 'no-tools', '无 tools 服务 → 优雅降级(不抛错)');

// 4) 端到端:规矩写入 / 缺原话拒绝 / 习惯只进待确认
const ruleTool = registered.find((s) => s.name === TOOL_RULE_ADD);
const habitTool = registered.find((s) => s.name === TOOL_HABIT_PROPOSE);
const w1 = await ruleTool.execute({ rule: '先给结论,再展开', quote: '以后回答都先给结论' }, {});
check(w1.ok === true && rulesOf(settings).length === 1, '会话内写入规矩成功');
check(w1.total === 1 && /已记入规矩/.test(ruleTool.output.render({}, w1)[0].text), '回执含正文与计数');
const w2 = await ruleTool.execute({ rule: '不要长篇大论' }, {});
check(w2.ok === false && w2.reason === 'no-quote', '缺原话:工具拒绝写入');
check(rulesOf(settings).length === 1, '拒绝后规矩条数不变');
const w3 = await ruleTool.execute({ rule: '先给结论，再展开', quote: '重复' }, {});
check(w3.ok === false && w3.reason === 'duplicate', '同义(空格/标点差异)重复 → duplicate');
const h1 = await habitTool.execute({ habit: '少用感叹号', evidence: '三次纠正' }, {});
check(h1.ok === true && habitsOf(settings).length === 0, '习惯提议:不进 habits(不可直达)');
check(habitsPendingOf(settings).length === 1, '习惯提议:进入待确认队列');
const h2 = await habitTool.execute({ habit: '少用感叹号' }, {});
check(h2.ok === false && h2.reason === 'already-pending', '同条习惯不重复提议');
check(/还不是习惯/.test(habitTool.output.render({}, h1)[0].text), '习惯回执:明确"还不是习惯"');

// 5) 写入规矩后触发快照失效(空闲会话:立即重建,走 markSnap;运行中才走 markSnapStale)
let rebuilt = 0;
let staled = 0;
const reg2 = [];
const ctx2 = { tools: { register: (spec) => { reg2.push(spec); return () => {}; } } };
const gate2 = {
  snapshotIds: () => ['s-a', 's-b'],
  isRunning: () => false,
  ensure: () => ({ mode: 'work', running: false, pending: [], snap: null, snapStale: false }),
  snapshotOf: () => null,
  markSnap: () => { rebuilt += 1; },
  markSnapStale: () => { staled += 1; },
  act: () => ({ applied: true, queued: false }),
};
const memReal = new MemoryStore(join(dir, 'm.db'));   // 真库:让"写入后失效"走真实路径(不必逐一伪造方法)
registerLingTools(ctx2, { gate: gate2, memory: memReal, settings });
const tool2 = reg2.find((s) => s.name === TOOL_RULE_ADD);
await tool2.execute({ rule: '遇事先给数字', quote: '遇到事先给数字' }, {});
check(rebuilt === 2 && staled === 0, '写入后两个空闲会话的快照立即重建(实际 rebuilt=' + rebuilt + ', staled=' + staled + ')');

// 6) 通道 D:他提议 → 我表态(habit_resolve)
check(checkHabitResolve({ action: 'accept' }).ok === true, '表态:accept 合法');
check(checkHabitResolve({ action: 'amend' }).reason === 'empty-habit', '表态:amend 缺 text → empty-habit');
check(checkHabitResolve({ action: 'whatever' }).reason === 'bad-action', '表态:非法 action → bad-action');
check(HABIT_RESOLVE_SPEC.name === 'habit_resolve' && HABIT_RESOLVE_SPEC.parameters.required.includes('action'), '表态工具:名字与必填 action');
check(/待我回应/.test(HABIT_RESOLVE_SPEC.description), '表态工具:描述写明触发时机');

const { assemblePersona } = await imp('lib/host/persona.js');
const { proposeHabit: propose2 } = await imp('lib/host/rules.js');
const resolveTool = registered.find((s) => s.name === TOOL_HABIT_RESOLVE);
const p1 = await propose2({ settings, habit: '先问清再动手', evidence: '他两次提到', byUser: true });
check(p1.ok === true, '他提议一条习惯');
const l0 = assemblePersona(settings.get(), 'work');
check(l0.includes('[待我回应]') && l0.includes('先问清再动手'), '注入面出现 [待我回应] 且含候选正文');
const a1 = await resolveTool.execute({ action: 'accept' }, {});
check(a1.ok === true && habitsOf(settings).some((h) => h.text === '先问清再动手'), 'accept:落地为习惯');
check(!assemblePersona(settings.get(), 'work').includes('[待我回应]'), 'accept 后不再出现 [待我回应]');

await propose2({ settings, habit: '少讲道理多给方案', evidence: '他一次提到', byUser: true });
const a2 = await resolveTool.execute({ action: 'amend', text: '先给可执行方案,再讲道理' }, {});
check(a2.ok === true && a2.from === '少讲道理多给方案', 'amend:回执含原提议');
check(habitsPendingOf(settings).some((h) => h.text === '先给可执行方案,再讲道理' && h.amendedBy === 'ling'), 'amend:改说法并标记由我改的');
check(!habitsPendingOf(settings).some((h) => h.text === '少讲道理多给方案'), 'amend:旧说法被替换');
check(!assemblePersona(settings.get(), 'work').includes('[待我回应]'), 'amend 后不再催我回应(轮到他确认)');

await propose2({ settings, habit: '每天汇报进度', evidence: 'x', byUser: true });
const a3 = await resolveTool.execute({ action: 'decline' }, {});
check(a3.ok === true && !habitsPendingOf(settings).some((h) => h.text === '每天汇报进度'), 'decline:从待确认移除');
const a4 = await resolveTool.execute({ action: 'accept' }, {});
check(a4.ok === false && a4.reason === 'not-found', '没有待回应提议时:not-found(不误伤)');
// 关键不变量:我**不能**确认自己提的习惯(人格不直达)
const mine = await propose2({ settings, habit: '我自己觉得该多留白', evidence: '我自己观察', byUser: false });
check(mine.ok === true, '我提议一条习惯(byUser=false)');
const a5 = await resolveTool.execute({ action: 'accept' }, {});
check(a5.ok === false && a5.reason === 'not-found', '我提的习惯:我无法自己确认(仍待他点确认)');
check(habitsOf(settings).every((h) => h.text !== '我自己觉得该多留白'), '自提习惯未被我自行收下');
const a6 = await resolveTool.execute({ action: 'accept', id: mine.id }, {});
check(a6.ok === false && a6.reason === 'not-awaiting', '显式指定 id 也不能绕过(not-awaiting)');

// 2d) 实测报告(2026-09-24)七条缺陷的回归门 —— 每一条都先红过,再钉住
const treeTool = reg2.find((s) => s.name === TOOL_TREE_READ);
const editTool = reg2.find((s) => s.name === TOOL_BRANCH_EDIT);
// E1:写入成功却回「失败」的根因是返回值里带 undefined(平台做**无损 JSON** 校验,含 undefined 即整次报失败)
const hasUndef = (v, seen = new Set()) => {
  if (v === null || typeof v !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => x === undefined || hasUndef(x, seen));
  return Object.entries(v).some(([, x]) => x === undefined || hasUndef(x, seen));
};
const mkA = await editTool.execute({ action: 'create', name: '回归验证枝A', reason: '实测报告回归门' }, {});
check(mkA.ok === true, 'branch_edit.create 成功');
check(!hasUndef(mkA), 'E1:create 回执无 undefined(此前 weightScale:undefined 直接判失败)');
const mkB = await editTool.execute({ action: 'create', name: '回归验证枝B', reason: '实测报告回归门' }, {});
check(mkB.ok === true && !hasUndef(mkB), 'E1:第二个 create 回执同样干净');
const linkR = await editTool.execute({ action: 'link', id: mkA.id, to: mkB.id, reason: '验证连边不再假失败' }, {});
check(linkR.ok === true && !hasUndef(linkR), 'E1:link 回执 ok 且无 undefined(此前复现 3/3 假失败)');
check(memReal.listVeinLinks().some((l) => l.from === mkA.id && l.to === mkB.id),
  'E1:link 确实落库(回执与库一致 —— 这一条正是报告里"假失败诱使重发"的防线)');
check(linkR.kind === 'related', 'E2:link 默认 kind=related');
const linkR2 = await editTool.execute({ action: 'link', id: mkA.id, to: mkB.id, kind: 'prerequisite', reason: '改语义为前置' }, {});
check(linkR2.ok === true && linkR2.kind === 'prerequisite', 'E2:link 可指定 kind=prerequisite');
check(memReal.listVeinLinks().some((l) => l.from === mkA.id && l.to === mkB.id && l.kind === 'prerequisite'),
  'E2:边类型真的落进 vein_link.kind(不再被压成 related 自由文本)');
check(checkBranchEdit({ action: 'link', id: 'a', to: 'b', kind: 'nope', reason: '验证非法边型' }).reason === 'bad-link-kind',
  'E2:非法边 kind → bad-link-kind');
check(checkBranchEdit({ action: 'create', name: 'A', kind: 'nope', reason: '验证非法枝型' }).reason === 'bad-kind',
  'E2:非法枝 kind 仍是 bad-kind(两用 kind 按 action 分流)');

// E3 + B4:树概览要出 id 与连边
// ⚠️ **契约变了**(D-T01,1.5.1 红蓝对抗 · 红队 D):概览行尾**只印全长 id**。
//    此前这里是 `check(lines.some(l => /｜[0-9a-f]{8}$/.test(l)))` —— 只断言"行尾有 8 位短 id",
//    而全库**没有任何输入侧解析器** ⇒ 把"印了却不能用"钉成了期望行为(审计 §6.5:测试覆盖了
//    输出形状,却没覆盖"照着自己给的提示走一遍")。现在改成**照提示走一遍**。
const treeR = await treeTool.execute({ action: 'tree' }, {});
check(treeR.ok === true && (treeR.lines || []).some((l) => l.includes('回归验证枝A')), 'tree:列出新建的枝');
const lineA = (treeR.lines || []).find((l) => l.includes('回归验证枝A')) || '';
const idOnLine = (lineA.split('｜').pop() || '').trim();
check(idOnLine === mkA.id, 'D-T01:概览行尾就是全长 id(改之前印 8 位短 id)');
check(!/｜[0-9a-f]{8}$/.test(lineA), 'D-T01:行尾不再是 8 位短 id(短 id 无人解析,印它就是骗模型)');
const byPrinted = await treeTool.execute({ action: 'members', id: idOnLine }, {});
check(byPrinted.ok === true && byPrinted.id === mkA.id, 'D-T01:照概览行尾的 id 调 members 能命中(改之前必 no-match)');
const renPrinted = await editTool.execute({ action: 'rename', id: idOnLine, name: '回归验证枝A', reason: 'D-T01 照着行尾的 id 改名' }, {});
check(renPrinted.ok === true, 'D-T01:照概览行尾的 id 改名也能命中(改之前必 no-match)');
check(Array.isArray(treeR.links) && treeR.links.length >= 1, 'E3:tree 回传连边(连边动作从此可自查)');
check((treeR.links || []).every((l) => memReal.listBranches().some((b) => b.id === l.from)),
  'D-T01:连边两端印的也是全长 id(能在树里找到,不是短号)');
check(!hasUndef(treeR), 'E1:tree 回执无 undefined');

// B2:传枝名当 id → no-match(此前静默回「0 条会话(暂无)」,看起来就像空枝)
const byName = await treeTool.execute({ action: 'members', id: '回归验证枝A' }, {});
check(byName.ok === false && byName.reason === 'no-match', 'B2:传枝名 → no-match,不再静默 0 条');
check(/全长 id/.test(treeTool.output.render({}, byName)[0].text),
  'D-T01:no-match 的提示语与印出来的 id 同口径(不再教"用概览行尾那 8 位")');
// B3:limit 生效(此前写死 slice(0,40))
const memR3 = await treeTool.execute({ action: 'members', id: mkA.id, limit: 5 }, {});
check(memR3.ok === true && (memR3.members || []).length <= 5, 'B3:members 遵守 limit');
check(Number.isFinite(Number(memR3.shown)), 'B3:members 回执带 shown(截断可被显式说明)');
// B1:计数的取法必须落在 .members 那一层(实测报告定位到的根因)
const bcR = memReal.branchMemberCounts();
check(bcR && bcR.members !== undefined, 'B1:branchMemberCounts() 的 per-branch 计数确实在 .members');
check(/branchMemberCounts\(\) \|\| \{\}\)\.members/.test(src), 'B1 护栏:treeLines 从 .members 取计数(防改回恒 0)');
check(/function lossless/.test(src) && /return lossless\(await fn/.test(src), 'E1 护栏:guard 统一过 lossless()');
check(/const LINK_KINDS/.test(src), 'E2 护栏:边类型白名单存在');

// ---- D-T02(1.5.1 红蓝对抗 · 红队 D):link/unlink 必须校验两端存在性
// 此前 `link deadbeef ↔ cafebabe` 回 ok:true 并真落 vein_link(悬空边),只在渲染/对账时才炸。
const bogus = await editTool.execute({ action: 'link', id: 'deadbeef', to: 'cafebabe', reason: 'D-T02 悬空连边回归门' }, {});
check(bogus.ok === false && bogus.reason === 'no-match', 'D-T02:悬空连边被拒(改之前 ok:true)');
check(Array.isArray(bogus.missing) && bogus.missing.length === 2, 'D-T02:回执点名两端都找不到(不必猜是哪一端)');
check(!memReal.listVeinLinks().some((l) => l.from === 'deadbeef' || l.to === 'cafebabe'), 'D-T02:库里零悬空边');
check(/找不到这些 id/.test(editTool.output.render({}, bogus)[0].text), 'D-T02:回执把找不到的 id 念出来');
const bogusUn = await editTool.execute({ action: 'unlink', id: 'deadbeef', to: 'cafebabe', reason: 'D-T02 断一条不存在的边' }, {});
check(bogusUn.ok === false && bogusUn.reason === 'no-match', 'D-T02:断不存在的边 → no-match(不再写假留痕)');
check((await editTool.execute({ action: 'link', id: mkA.id, to: mkA.id, reason: 'D-T02 自连边' }, {})).reason === 'bad-arg',
  'D-T02:自连边是 bad-arg(参数问题与"找不到枝"分开报)');
// 失败路径也要认得自己是谁(本轮补):render 的 no-match 措辞按 action 分流(连边没落 / 断边没得断),
// 而 handler 的失败分支此前不回传 `action` ⇒ `v.action === 'unlink'` 恒为假,断一条不存在的边
// 会念成"连边两端都必须是树里真有的枝,所以没有落这条边"(把断边说成了连边)。
const bogusUnText = editTool.output.render({}, bogusUn)[0].text;
check(bogusUn.action === 'unlink', 'D-T02:断边失败的回执也带 action=unlink(改之前 undefined,措辞分不了流)');
check(/这条边也不在/.test(bogusUnText) && !/没有落这条边/.test(bogusUnText),
  'D-T02:断不存在的边 → 回执说"没有任何东西被断开",不再借用连边的措辞 —— 实际:' + JSON.stringify(bogusUnText.slice(0, 70)));

// ---- D-T03:weight 回执必须说**库里的值**(此前用入参覆盖:请求 99、库存 2、回执说 99)
const w99 = await editTool.execute({ action: 'weight', id: mkA.id, weightScale: 99, reason: 'D-T03 越界权重回归门' }, {});
const w99stored = Number((memReal.listBranches().find((b) => b.id === mkA.id) || {}).weightScale);
const w99text = editTool.output.render({}, w99)[0].text;
check(w99.ok === true && Number(w99.weightScale) === 2, 'D-T03:回执回传库里的夹取值 2(改之前回 99)');
check(Number(w99.weightRequested) === 99 && w99stored === 2, 'D-T03:请求值 99 与落库值 2 都能对上账');
check(/设为 2/.test(w99text) && !/调到了 99/.test(w99text), 'D-T03:回执文案与库一致(不再说"调到了 99")');
check(/不参与检索打分/.test(w99text), 'D-T03:回执写明该字段不参与打分(applied:false 不再只活在返回值里)');
// D-T03 加强(本轮补):回执里的数字必须来自**库**,不是"我以为写了多少"。
// `setBranchWeight` 的返回值是它自己算出来的夹取值(UPDATE 命中 0 行也回 ok)⇒ opBranchWeight
// 现在写后读回 branch 表一次(`stored`),回执与留痕都以读回值为准。
check(Number(w99.stored) === w99stored && Number(w99.weightScale) === w99stored,
  'D-T03:回执里的 2 与 branch 表里的真值是同一个数(写后读回 stored=' + w99.stored + ')');

// ---- D-T05:非空枝删除的 impact 闸门(此前 why 表没有 not-empty 键 ⇒ impact 四个数字被整个丢掉)
const mkP = await editTool.execute({ action: 'create', name: '回归验证父枝', reason: 'D-T05 造一条非空枝' }, {});
const mkC = await editTool.execute({ action: 'create', name: '回归验证子枝', parentId: mkP.id, reason: 'D-T05 给父枝加子枝' }, {});
check(mkC.ok === true && mkC.parentId === mkP.id, 'D-T05 前置:子枝挂在父枝下(父枝因此非空)');
const delNE = await editTool.execute({ action: 'delete', id: mkP.id, reason: 'D-T05 非空枝不给 force' }, {});
const delNEtext = editTool.output.render({}, delNE)[0].text;
check(delNE.ok === false && delNE.reason === 'not-empty', 'D-T05:非空枝不给 force → 仍然拒绝(闸门本身没坏)');
check(Number((delNE.impact || {}).children) === 1, 'D-T05:impact 落在返回值里');
check(/子枝 1 条/.test(delNEtext) && /force/.test(delNEtext) && /回退到主干/.test(delNEtext),
  'D-T05:回执念出影响面并说明 force 的真实后果(改之前只有「未执行(not-empty)」)');
check(memReal.listBranches().some((b) => b.id === mkP.id), 'D-T05:拒绝后枝还在(库没有变化)');
// 死键 is-trunk → 真值 trunk-immutable(此前主干被拒时回执只会吐「未执行(trunk-immutable)」)
const delTrunk = await editTool.execute({ action: 'delete', id: 'trunk', reason: 'D-T05 主干守卫文案回归门' }, {});
check(delTrunk.ok === false && delTrunk.reason === 'trunk-immutable', 'D-T05:删主干 → trunk-immutable');
check(/主干不能删/.test(editTool.output.render({}, delTrunk)[0].text), 'D-T05:trunk-immutable 有中文解释(is-trunk 是死键)');
// D-T05 的**成功路径**那一半(本轮补,报告里没有):force 真删成之后,回执必须说清它动了什么 ——
// 改之前库里被静默 UPDATE(子枝/会话归属回主干)与 DELETE(条目归属/连边),回执只有一句
// 「删掉了枝「br:…」」:名字就取在手上(idName)却不用,归属去哪了只字未提。
// 这里让 impact 的四个数各有来源,好把"回退"与"删除"两种后果分开钉住。
const nowIso2 = new Date().toISOString();
memReal.db.prepare('INSERT INTO session_meta (session_id,mode,mode_updated_at,archived,raw_seq,branch_id) VALUES (?,?,?,0,?,?)')
  .run('t-force-1', 'work', nowIso2, 1, mkP.id);
memReal.assignConv('dsweb', 't-force-conv', mkP.id); // 非 dsh 源才落 conv_branch(条目归属)
const delF = await editTool.execute({ action: 'delete', id: mkP.id, force: true, reason: 'D-T05 force 删非空枝回归门' }, {});
const delFtext = editTool.output.render({}, delF)[0].text;
check(delF.ok === true && Number((delF.impact || {}).children) === 1 && Number((delF.impact || {}).sessions) === 1
  && Number((delF.impact || {}).convs) === 1, 'D-T05:force 删成功,影响面仍在回执数据里(子枝1/会话1/条目1)');
check(/回归验证父枝/.test(delFtext), 'D-T05:删枝回执念出被删枝的**名字**(改之前只有裸全长 id:「删掉了枝「br:…」」)');
check(/回退到主干/.test(delFtext) && /一并删除/.test(delFtext),
  'D-T05:成功回执把"回退主干"与"记录删除"分开说(改之前静默)—— 实际:' + JSON.stringify(delFtext.slice(0, 90)));
check((memReal.listBranches().find((b) => b.id === mkC.id) || {}).parentId === 'trunk',
  'D-T05:与回执相符 —— 子枝的父确实被改成了 trunk');
check(String(memReal.sessionMeta('t-force-1').branch_id) === 'trunk', 'D-T05:与回执相符 —— 会话归属确实回退到 trunk');
check(!memReal.db.prepare('SELECT 1 FROM conv_branch WHERE conv_id=?').all('t-force-conv').length,
  'D-T05:条目归属行是**删除**(与回执措辞一致:删除 ≠ 回退)');
// D-T05 的同一族,反方向(本轮自查补):**有代码会产生的原因码,why 表里必须都有文本** ——
// 否则回执只剩「未执行(码)」,与"回执要说人话"直接冲突(is-trunk 是死键那一族的镜像)。
// 这三个码分别来自 memory.reparentBranch/renameBranch(no-branch)、空 id(bad-id)、
// deleteBranch/unlinkVein 的 catch(db);前两个上游已挡,但配对要求与可达性无关。
check(['no-branch', 'bad-id', 'db'].every((k) => src.includes("'" + k + "':")),
  'D-T05 家族:产生的每个 reason 都有回执文本(no-branch / bad-id / db 不缺键)');

// ---- D-T06:reparent 缺 parentId 不再静默挂主干(此前 ok:true + 留痕 after:'' ⇒ 注入面「挪到了「?」下」)
const mkV = await editTool.execute({ action: 'create', name: '回归验证主脉V', kind: 'vein', reason: 'D-T06 造一个非主干父' }, {});
const mkD = await editTool.execute({ action: 'create', name: '回归验证枝D', parentId: mkV.id, reason: 'D-T06 把枝挂在主脉下' }, {});
check(mkV.ok === true && mkD.ok === true && mkD.parentId === mkV.id, 'D-T06 前置:枝挂在主脉下(不是主干)');
check(checkBranchEdit({ action: 'reparent', id: 'br:x', reason: '缺父参数' }).reason === 'no-parent-id',
  'D-T06:参数侧就拒绝缺 parentId(no-parent-id)');
const rpNo = await editTool.execute({ action: 'reparent', id: mkD.id, reason: 'D-T06 缺父并脉' }, {});
check(rpNo.ok === false && rpNo.reason === 'no-parent-id', 'D-T06:缺 parentId 不执行(改之前 ok:true 且真挪走)');
check((memReal.listBranches().find((b) => b.id === mkD.id) || {}).parentId === mkV.id,
  'D-T06:枝仍在原父下(没有静默挂主干)');
check(/parentId/.test(editTool.output.render({}, rpNo)[0].text), 'D-T06:回执说明要显式给 parentId(挂主干就传 trunk)');
const rpTrunk = await editTool.execute({ action: 'reparent', id: mkD.id, parentId: 'trunk', reason: 'D-T06 显式挂回主干' }, {});
check(rpTrunk.ok === true && rpTrunk.parentId === 'trunk'
  && (memReal.listBranches().find((b) => b.id === mkD.id) || {}).parentId === 'trunk',
  'D-T06:显式传 trunk 才真的挂主干(回执 parentId = 真父,不是空串)');
check(/回归验证枝D/.test(editTool.output.render({}, rpTrunk)[0].text), 'D-T06:回执用枝名而不是裸 uuid');

// ---- B-11 ≡ D-T07:source 白名单 + 不为不存在的条目打遗忘标记
check(checkForget({ action: 'forget', source: '随便什么域', convId: 'x1', reason: '乱写来源域' }).reason === 'bad-source',
  'B-11:source 不在白名单 → bad-source(改之前任意字符串都收)');
check(checkForget({ action: 'forget', source: 'dsh', convId: 'c1', reason: '正常来源域' }).ok === true, 'B-11:dsh 仍通过');
check(checkForget({ action: 'forget', source: 'trunk', convId: 'c1', reason: '枝 id 不是来源域' }).reason === 'bad-source',
  'B-11:拿枝 id 当 source → bad-source(白名单不是"看谁顺眼")');
check(checkForget({ action: 'forget', source: 'vein', convId: 'vein:x', reason: '主脉主题也是库内来源域' }).ok === true,
  'B-11:vein 在白名单里(库内第 5 个来源,与 api.js 的 MEM_SOURCES 对齐 —— 漏了它会误拒真目标)');
check(checkBackfill({ action: 'restore', name: 'a', source: '乱写', reason: '回灌到乱来源域' }).reason === 'bad-source',
  'B-11:memory_backfill 的 source 走同一份白名单');
const forgetTool = reg2.find((s) => s.name === TOOL_MEMORY_FORGET);
const fGhost = await forgetTool.execute({ action: 'forget', source: 'dsh', convId: 'sess-不存在', reason: 'D-T07 忘掉不存在的一条' }, {});
check(fGhost.ok === false && fGhost.reason === 'no-such-entry', 'D-T07:不存在的条目 → no-such-entry(改之前 ok:true)');
check(!memReal.listForgotten({ limit: 50 }).some((f) => f.convId === 'sess-不存在'), 'D-T07:没有留下永不召回的 forgotten 行');
// 正例:真条目必须仍然忘得掉(存在性闸不能误伤),而且要能撤销
const nowIso = new Date().toISOString();
memReal.db.prepare('INSERT INTO session_meta (session_id,mode,mode_updated_at,archived,raw_seq,branch_id) VALUES (?,?,?,0,?,?)')
  .run('t-forget-1', 'work', nowIso, 1, 'trunk');
memReal.db.prepare('INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES (?,?,?,?,?,?)')
  .run('t-forget-1', 1, 'user', nowIso, 'm', '要被忘掉的一轮');
memReal.upsertOverview({ source: 'dsh', conv_id: 't-forget-1', title: '待忘条目', summary: '摘要' });
const fReal = await forgetTool.execute({ action: 'forget', source: 'dsh', convId: 't-forget-1', reason: 'D-T07 正例:真条目' }, {});
check(fReal.ok === true && Number(fReal.turns) === 1, 'D-T07:真条目仍然忘得掉(归档 1 轮)');
check(memReal.listForgotten({ limit: 50 }).some((f) => f.convId === 't-forget-1'), 'D-T07:真条目落了 forgotten 标记');
const fUndo = await forgetTool.execute({ action: 'undo', source: 'dsh', convId: 't-forget-1', reason: 'D-T07 撤销遗忘' }, {});
check(fUndo.ok === true && Number(fUndo.removed) === 1, 'D-T07:undo 清掉标记(可逆)');
// B-05 的调用侧闸门(顺带,同属"闸门失效"一族):只剩标题的空壳过得了存在性检查,
// 但归档里什么都没有(0 轮 + 无正文 + 无会话元数据)⇒ 不许打标记,且回执要说清是"归档空了"。
memReal.upsertOverview({ source: 'dsh', conv_id: 't-shell-1', title: '只剩标题的空壳', category: 'daily', overview_ok: true });
const fShell = await forgetTool.execute({ action: 'forget', source: 'dsh', convId: 't-shell-1', reason: 'B-05 空归档回归门' }, {});
check(fShell.ok === false && fShell.reason === 'empty-archive', 'B-05:归档里什么都没保住 → empty-archive(不打标记)');
check(!memReal.listForgotten({ limit: 50 }).some((f) => f.convId === 't-shell-1'), 'B-05:空归档不落 forgotten 行');
const fShellText = forgetTool.output.render({}, fShell)[0].text;
check(/没有任何内容/.test(fShellText) && !/未执行\(/.test(fShellText),
  'B-05:回执说清是"归档空了",不是含混的「未执行(empty-archive)」—— 实际:' + JSON.stringify(fShellText.slice(0, 60)));
// B-05 的**第二条路**(本轮补):概述有正文、只是原文 0 轮 —— 这种归档 `arc.empty === false`
// (概述确实保住了),拦下它的是 `memory.forgetEntry` 的**验盘**闸门。此时回执若照抄第一路的
// "概述也没有正文"就是**撒谎**:那段正文就在 overview.json 里。两条路必须分开说。
memReal.upsertOverview({ source: 'dsh', conv_id: 't-sum-only', title: '只有概述正文的条目', summary: '一段真实存在的概述正文' });
const fSum = await forgetTool.execute({ action: 'forget', source: 'dsh', convId: 't-sum-only', reason: 'B-05 第二路:概述在原文空' }, {});
const fSumText = forgetTool.output.render({}, fSum)[0].text;
check(fSum.ok === false && fSum.reason === 'empty-archive' && Number(fSum.turns) === 0,
  'B-05 第二路:概述在、原文 0 轮 → 仍拒绝打标记(验盘闸门)');
check(!memReal.listForgotten({ limit: 50 }).some((f) => f.convId === 't-sum-only'), 'B-05 第二路:不落 forgotten 行');
check(/没有原文/.test(fSumText) && !/概述也没有正文/.test(fSumText),
  'B-05 第二路:回执不许说"概述也没有正文"(它在 overview.json 里)—— 实际:' + JSON.stringify(fSumText.slice(0, 70)));

// 收尾:拆掉回归用的枝,不给库留垃圾
await editTool.execute({ action: 'unlink', id: mkA.id, to: mkB.id, reason: '回归验证收尾' }, {});
await editTool.execute({ action: 'delete', id: mkC.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkP.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkD.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkV.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkB.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkA.id, reason: '回归验证收尾清理' }, {});
check(!memReal.listBranches().some((b) => ['回归验证枝A', '回归验证枝B', '回归验证父枝', '回归验证子枝',
  '回归验证主脉V', '回归验证枝D'].includes(b.name)), '收尾:回归用的枝已清干净');

// ---- 关①.6 合规判据表(2026-09-26 加):tools/compliance-spec.mjs 的纯函数行为 + README 声明面现状
// ⚠ fixture 里的禁用措辞与出站模式必须**拼出来**:tests/ 也在关①.6 的扫描范围内,写成连续
//   字面量会让"禁用措辞 0 命中""出站基线 4 处"这两条判据命中本文件自己(判据表用的是同一招)。
// ⚠ 这里**不**引用 release\ 下的手册:那不在 npm 包里,包里跑测试会 ENOENT;手册纪律由关①.6 运行器核。
const { FORBIDDEN, REQUIRED, OUTBOUND, scanText } = await imp('tools/compliance-spec.mjs');
check(FORBIDDEN.length === 3 && REQUIRED.length >= 15,
  `判据表规模:禁用族 ${FORBIDDEN.length} 条 · 必备声明 ${REQUIRED.length} 条`);

const FETCH = ['fet', 'ch('].join('');
const W_MAIN = ['仅', '限', '个人', '使', '用'].join('');   // 拼装:碎片本身也不得构成判据字面量
const W_SUB = ['最安', '全'].join('');
const W_CARE = ['情感边界', '引导'].join('');
const cw1 = scanText('x.md', `本软件${W_MAIN}。`).problems;
check(cw1.some((p) => p.id === 'F-DISABLED-WORDING'), '禁用措辞主族:命中被报出来');
check(cw1.every((p) => p.file === 'x.md' && p.line === 1), '命中带文件名与行号');
check(scanText('x.md', `据说是${W_SUB}的方案`).problems.some((p) => p.id === 'F-DISABLED-WORDING-2'),
  '禁用措辞兜底族:换个字的写法也报');
check(scanText('x.md', `一条${W_CARE}的话术`).problems.some((p) => p.id === 'F-CARE-FEATURES'),
  '关怀功能关键词:命中被报出来(§2 明确不做)');
check(scanText('x.md', '这是一个本地运行的软件,记忆全在你自己机器上。').problems.length === 0, '干净文本不报');

const miss = scanText('README.md', '正文里没有任何声明').problems.filter((p) => /^M/.test(p.id));
check(miss.length >= 5 && miss.some((p) => p.id === 'M1-1'),
  `必备声明缺失 → 逐条点名(M1 五子句 / M2 / M3 / M4;实际 ${miss.length} 条:${miss.map((p) => p.id).join(',')})`);

const obOk = scanText('lib/client.js', 'function api(p){ return ' + FETCH + 'API + p); }');
check(obOk.outbound.length === 1 && !obOk.problems.some((p) => p.id === 'F-OUTBOUND-NOT-WHITELISTED'),
  '出站:白名单内(归属函数 api)不算问题');
const obBad = scanText('lib/client.js', 'function evil(){ return ' + FETCH + "'https://example.com/x'); }");
check(obBad.problems.some((p) => p.id === 'F-OUTBOUND-NOT-WHITELISTED'),
  '出站:白名单外的调用被报出来(按归属函数判定,不按行号)');
check(OUTBOUND.baseline === 4 && OUTBOUND.re.test(FETCH), `出站:基线 ${OUTBOUND.baseline} 处,模式对 ${FETCH} 有效`);

// 真实现状:README 的声明面(另一路 2026-09-26 已补齐 M1/M2/M3/M4;缺了会在这里点名)
const { readFileSync: rf } = await import('node:fs');
const readmeBad = scanText('README.md', rf(join(root, 'README.md'), 'utf8')).problems;
console.log('  README 声明面现状:' + (readmeBad.length
  ? `${readmeBad.length} 条问题 —— ${readmeBad.map((p) => p.id).join(', ')}`
  : 'M1 五子句 · M2 · M3 · M4 · A5 两条全在(0 条问题)'));
check(readmeBad.length === 0, 'README 声明面齐全(实际:' + readmeBad.map((p) => p.id).join(',') + ')');
const specBad = scanText('tools/compliance-spec.mjs', rf(join(root, 'tools/compliance-spec.mjs'), 'utf8')).problems;
check(specBad.length === 0,
  '判据表自身 0 命中(判据字面量必须用 `·` 断开,否则扫描器永久命中自己;实际:' + specBad.map((p) => p.id).join(',') + ')');
check(REQUIRED.some((r) => r.file === 'PUBLISH-WORKFLOW.md' && r.id === 'C6-STORE'),
  '判据 5(不上架商店)在表里 —— 手册不在包内,由 release 侧运行器核');

console.log(ok ? '会话内工具 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);