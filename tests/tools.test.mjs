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
  RULE_ADD_SPEC, HABIT_PROPOSE_SPEC, HABIT_RESOLVE_SPEC,
  TOOL_RULE_ADD, TOOL_HABIT_PROPOSE, TOOL_HABIT_RESOLVE,
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

// 3) 注册行为:可用 ctx / 假 tools 服务
const registered = [];
const fakeCtx = { tools: { register: (spec) => { registered.push(spec); return () => {}; } } };
const r1 = registerLingTools(fakeCtx, { gate: { snapshotIds: () => [] }, memory: { kvSet: () => {} }, settings });
check(r1.ok === true && registered.length === 3, '注册成功:三个工具');
check(registered.map((s) => s.name).sort().join(',') === 'habit_propose,habit_resolve,rule_add', '注册的是这三个名字');
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

console.log(ok ? '会话内工具 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);