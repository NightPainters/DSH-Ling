// 第 18 套:会话内工具层(rule_add / habit_propose)—— 纯对象注册、自校验、护栏
// 覆盖:注册契约(不依赖 dsh-tools)、缺原话拒绝、习惯不可直达、渲染回执、无 tools 服务时降级
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

// E3 + B4:树概览要出短 id 与连边
const treeR = await treeTool.execute({ action: 'tree' }, {});
check(treeR.ok === true && (treeR.lines || []).some((l) => l.includes('回归验证枝A')), 'tree:列出新建的枝');
check((treeR.lines || []).some((l) => /｜[0-9a-f]{8}$/.test(l)), 'B4:概览行尾带短 id(不必再另找办法拿 id)');
check(Array.isArray(treeR.links) && treeR.links.length >= 1, 'E3:tree 回传连边(连边动作从此可自查)');
check(!hasUndef(treeR), 'E1:tree 回执无 undefined');

// B2:传枝名当 id → no-match(此前静默回「0 条会话(暂无)」,看起来就像空枝)
const byName = await treeTool.execute({ action: 'members', id: '回归验证枝A' }, {});
check(byName.ok === false && byName.reason === 'no-match', 'B2:传枝名 → no-match,不再静默 0 条');
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

// 收尾:拆掉回归用的两条枝,不给库留垃圾
await editTool.execute({ action: 'unlink', id: mkA.id, to: mkB.id, reason: '回归验证收尾' }, {});
await editTool.execute({ action: 'delete', id: mkB.id, reason: '回归验证收尾清理' }, {});
await editTool.execute({ action: 'delete', id: mkA.id, reason: '回归验证收尾清理' }, {});
check(!memReal.listBranches().some((b) => b.name === '回归验证枝A' || b.name === '回归验证枝B'),
  '收尾:回归用的枝已清干净');

console.log(ok ? '会话内工具 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);