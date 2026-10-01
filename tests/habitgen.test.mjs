// 通道 A · 习惯候选生成器(零模型,从纠正信号里数重复模式)—— 第 20 套测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const {
  scanCorrections, evidenceOf, summarizeScan, SCAN_DEFAULTS,
  HABIT_REFLECT_SYS, buildReflectMaterial, parseReflect, REFLECT_DEFAULTS, reflectWithRetry, REFLECT_RETRY,
} = await imp('lib/host/habit-gen.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-habitgen-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
let seq = 0;
const turn = (sid, role, text) => mem.appendRawTurn(sid, { seq: ++seq, role, ts: null, model: null, text });

// 0) 空库:不炸、返回空
check(Array.isArray(scanCorrections(mem)) && scanCorrections(mem).length === 0, '空库返回空数组');

// 1) 跨会话重复 → 命中
turn('s1', 'user', '太啰嗦了,说重点');
turn('s1', 'user', '回答太长,能不能短点');
turn('s2', 'user', '废话太多,直接给结论');
// 2) 同一会话里说三遍 → **不算模式**(缺跨会话)
turn('s3', 'user', '太文言了');
turn('s3', 'user', '又在咬文嚼字');
turn('s3', 'user', '别拽文');
// 3) 只出现一次的其它类 → 不命中
turn('s4', 'user', '太虚了,来点实际的');
// 4) 助手的轮次不算(只扫真人)
turn('s5', 'assistant', '太啰嗦了太啰嗦了太啰嗦了');

// 显式放宽到旧阈值(3 次 / 2 会话)跑下面的语义断言;现行默认是 4 次 / 3 会话(见第 6 节)
const cands = scanCorrections(mem, { minHits: 3, minSessions: 2 });
check(cands.length === 1, `只应有 1 条候选,实得 ${cands.length}:${JSON.stringify(cands.map((c) => c.key))}`);
check(scanCorrections(mem).length === 0, '默认阈值(≥4 次且跨 ≥3 会话)下,3 次/2 会话的样本不算模式(2026-09-16 定案)');
const v = cands[0] || {};
check(v.key === 'verbose', '命中的是「啰嗦」桶:' + v.key);
check(v.hits === 3, `命中 3 次,实得 ${v.hits}`);
check(v.sessions === 2, `跨 2 个会话,实得 ${v.sessions}`);
check((v.samples || []).length === 3 && v.samples.every((s) => typeof s === 'string' && s.length > 0), '带原话摘录');
check(typeof v.rule === 'string' && v.rule.length > 4, '候选文本取自纠正桶的规则文案:' + v.rule);

// 5) 阈值可调:允许单会话时,「文言」桶就进来了
const loose = scanCorrections(mem, { minSessions: 1, minHits: 3 });
check(loose.some((c) => c.key === 'classical'), '放宽到单会话后,文言桶命中');
check(loose.length === 2, `放宽后应 2 条,实得 ${loose.length}`);
const strict = scanCorrections(mem, { minHits: 4 });
check(strict.length === 0, '把次数阈值提到 4 → 无候选');
const capped = scanCorrections(mem, { maxTurns: 2 });
check(capped.length === 0, 'maxTurns 限制回看范围(只回看 2 轮 → 无模式)');

// 6) 证据串与人读摘要
const ev = evidenceOf({ hits: 3, sessions: 2, samples: ['太啰嗦了', '回答太长'] });
check(ev.includes('跨 2 个会话') && ev.includes('3 次'), '证据串含会话数与次数:' + ev);
check(ev.includes('太啰嗦了'), '证据串含原话');
check(ev.length <= 300, '证据串 ≤300 字,实得 ' + ev.length);
const sum = summarizeScan(cands);
check(sum.length === 1 && sum[0].text === v.rule && sum[0].hits === 3 && sum[0].sessions === 2, '人读摘要字段齐全');
check(SCAN_DEFAULTS.minHits === 4 && SCAN_DEFAULTS.minSessions === 3, '默认阈值 = 4 次 / 跨 3 会话(2026-09-16 定案:3/2 → 4/3)');

// 7) 库结构异常时静默退化(不能拖累调用方)
const broken = { db: { prepare() { throw new Error('db busy'); } } };
check(Array.isArray(scanCorrections(broken)) && scanCorrections(broken).length === 0, '库异常时返回空数组而不抛错');

// ── 通道 B:「让她回想」:结果解析(容错) ─────────────────────────────
const fenced = '```json\n{"habits":[{"text":"先给结论再展开","evidence":"你三次说太啰嗦"},{"habit":"夜里说话更轻","why":"凌晨的对话里更安静"}]}\n```';
const parsed = parseReflect(fenced);
check(parsed.length === 2 && parsed[0].text === '先给结论再展开', '围栏 JSON 可解析:' + JSON.stringify(parsed.map((x) => x.text)));
check(parsed[1].text === '夜里说话更轻' && parsed[1].evidence.includes('凌晨'), '英文字段名 habit/why 兼容');
check(parseReflect(`{"habits":[{"text":"${'长'.repeat(60)}"}]}`).length === 0, '超过 40 字的候选被丢弃');
check(parseReflect('{"habits":[{"text":"A"},{"text":"A"}]}').length === 1, '同文本去重');
const many = parseReflect(JSON.stringify({ habits: [1, 2, 3, 4, 5].map((i) => ({ text: '候选' + i })) }));
check(many.length === REFLECT_DEFAULTS.maxHabits, '最多 ' + REFLECT_DEFAULTS.maxHabits + ' 条,实得 ' + many.length);
check(parseReflect('模型今天不想说话').length === 0, '非 JSON 回复 → 空数组(不抛错)');
check(/只输出 JSON/.test(HABIT_REFLECT_SYS) && /习惯/.test(HABIT_REFLECT_SYS), '系统提示含 JSON 契约与习惯语义');
check(/不要提"称呼、名字、底线、安全"/.test(HABIT_REFLECT_SYS), '系统提示排除契约类内容(名字/底线不属习惯)');

// ── 通道 B:材料组装(真人原话 + 概述 + 纠正统计 + 她现状;返回 {text, stats}) ──
mem.upsertOverview({ source: 'dsh', conv_id: 'r1', title: '项目讨论记录', category: 'daily', overview_ok: true, summary: '聊了新功能', updated_at: '2026-09-15T10:00:00Z' });
mem.upsertOverview({ source: 'dsh', conv_id: 'r2', title: '材料模拟', category: 'knowledge', overview_ok: true, summary: '模拟参数', updated_at: '2026-09-14T10:00:00Z' });
const M = buildReflectMaterial(mem, { scan: summarizeScan(cands), rules: ['多用结构化呈现'], habits: ['先给结论'] });
check(typeof M.text === 'string' && M.stats && typeof M.stats === 'object', '返回 {text, stats} 结构');
check(M.text.includes('她读过的会话概述') && M.text.includes('项目讨论记录'), '材料含会话概述');
check(M.text.indexOf('项目讨论记录') < M.text.indexOf('材料模拟'), '概述按时间新→旧排序');
check(M.text.includes('主人最近说过的话') && M.text.includes('太啰嗦了'), '材料含主人真人原话(相处片段)');
check(M.text.includes('反复纠正过的地方') && M.text.includes('个会话'), '材料含纠正统计(带跨会话计数)');
check(!/undefined/.test(M.text), '材料里不得出现 undefined(字段口径必须对齐)');
check(M.text.includes('先给结论') || M.text.includes('控制篇幅'), '纠正统计用的是人读规则文案,不是内部键');
check(M.text.includes('她现在的规矩与习惯') && M.text.includes('先用结构化') === false && M.text.includes('多用结构化呈现'), '材料含她现状(避免重复提议)');
check(M.stats.turns >= 3 && M.stats.overviews === 2 && M.stats.corrections >= 1, '统计数字对得上:' + JSON.stringify(M.stats));
check(M.text.includes('材料统计'), '末尾附材料统计行(让人看见喂了多少)');
check(M.stats.chars > 100 && M.stats.chars <= REFLECT_DEFAULTS.budgetChars, '字符统计在预算内:' + M.stats.chars);
// 预算裁剪:预算极小时只保留高优先级块,且不超预算太多
const tiny = buildReflectMaterial(mem, { scan: summarizeScan(cands), budgetChars: 200 });
check(tiny.text.length < M.text.length && tiny.text.includes('反复纠正过的地方'), '预算收紧时从尾部截断,高优先级块保留');
const empty = buildReflectMaterial({ listOverviews: () => [] }, { scan: [] });
check(empty.text === '' && empty.stats.chars === 0, '无材料时 text 为空串(接口据此提示)');
check(buildReflectMaterial({ listOverviews: () => { throw new Error('db busy'); } }, { scan: [] }).text === '', '库异常时退化为空串而不抛错');
check(REFLECT_DEFAULTS.overviewLimit >= 100 && REFLECT_DEFAULTS.turnLimit >= 500 && REFLECT_DEFAULTS.budgetChars >= 100000, '回想材料默认给足(手动触发不必省)');

// ── 通道 B:轮询(每轮回看上一轮没读过的那一段;读满一圈回到最新) ──
const c0 = buildReflectMaterial(mem, { scan: [], turnLimit: 2, overviewLimit: 1 });
check(c0.text.startsWith('（回想材料 ·'), '材料开头标注本轮覆盖:' + c0.text.split('\n')[0].slice(0, 60));
check(c0.stats.coverage.includes('第 1 轮') && c0.stats.coverage.includes('共'), '覆盖行含轮次与总量');
check(c0.stats.turnOffset === 0 && c0.stats.turnTotal >= 3, '第一轮从最新开始,并统计总量:' + c0.stats.turnTotal);
check(c0.nextCursor && c0.nextCursor.round === 2, '游标轮次递增(下一轮=2)');
const c1 = buildReflectMaterial(mem, { scan: [], turnLimit: 2, overviewLimit: 1, cursor: c0.nextCursor });
check(c1.stats.round === 2, '第二轮轮次正确');
check(c1.stats.turnOffset >= 2, '第二轮的原话窗口已推进:' + c1.stats.turnOffset);
check(c1.text !== c0.text, '两轮材料不同(不是每次喂同一批)');
check(c0.text.includes('项目讨论记录') && !c1.text.includes('项目讨论记录'), '概述窗口不重叠:第二轮读到的是上一轮没读过的那条');
const cW = buildReflectMaterial(mem, { scan: [], turnLimit: 100000, overviewLimit: 100000, cursor: { round: 9, turnOffset: 999999, ovOffset: 999999 } });
check(cW.stats.wrapped === true && cW.stats.turnOffset === 0 && cW.stats.ovOffset === 0, '读满一圈后回到最新(wrapped)');
check(cW.stats.coverage.includes('已读完一圈'), '覆盖行明确告知已读完一圈');
check(cW.stats.round === 9, '传进来的轮次被沿用(不由内部重置)');

// ── 通道 B:空回复重试(复刻 probeLLM 的经验:思考档可能吃光预算 → 空回复) ──
const rCalls = [];
const llmEmptyThenOk = async (o) => {
  rCalls.push({ effort: o.effort, chars: o.text.length, maxTokens: o.maxTokens });
  return {
    text: o.effort === 'off' ? '{"habits":[{"text":"先给结论再展开"}]}' : '',
    chunkLog: ['reasoning-delta'],
    target: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  };
};
const r1 = await reflectWithRetry(llmEmptyThenOk, { system: 's', material: 'x'.repeat(200000), maxTokens: 4000, effort: 'low' });
check(rCalls.length === 2 && rCalls[0].effort === 'low' && rCalls[1].effort === 'off', '空回复 → 用 off 档再试一次:' + JSON.stringify(rCalls.map((c) => c.effort)));
check(rCalls[1].chars === REFLECT_RETRY.retryMaterialChars, '重试时把材料裁短到上限:' + rCalls[1].chars);
check(r1.retried === true && r1.attempts.length === 2, '两次尝试都被记录(retried=true)');
check(r1.text.includes('先给结论'), '重试命中内容');
check(r1.attempts[0].ok === false && r1.attempts[0].chunkTypes.join() === 'reasoning-delta', '首次只收到 reasoning-delta(诊断为"思考吃预算")');
check(parseReflect(r1.text, { max: 3 }).length === 1, '重试结果可被 parseReflect 正常解析');

const onceCalls = [];
const llmOk = async (o) => { onceCalls.push(o.effort); return { text: '{"habits":[]}', chunkLog: ['text-delta'] }; };
const r2 = await reflectWithRetry(llmOk, { system: 's', material: 'x'.repeat(1000), maxTokens: 4000, effort: 'low' });
check(onceCalls.length === 1 && r2.retried === false, '首次即有内容 → 不重试(省一次调用)');

const throwCalls = [];
const llmThrow = async (o) => { throwCalls.push(o.effort); if (o.effort !== 'off') throw new Error('boom'); return { text: '{"habits":[]}', chunkLog: ['text-delta'] }; };
const r3 = await reflectWithRetry(llmThrow, { system: 's', material: 'x'.repeat(5000), maxTokens: 4000, effort: 'low' });
check(throwCalls.join() === 'low,off' && r3.text.trim().length > 0, '首次抛错也会退到重试');
check(!!r3.attempts[0].error && r3.attempts[0].error.includes('boom'), '异常被记进 attempts(供 kv 诊断)');

const bothCalls = [];
const llmBothEmpty = async (o) => { bothCalls.push(o.effort); return { text: '', chunkLog: ['reasoning-delta'] }; };
const r4 = await reflectWithRetry(llmBothEmpty, { system: 's', material: 'x'.repeat(500), maxTokens: 4000, effort: 'low' });
check(bothCalls.join() === 'low,off' && r4.attempts.length === 2 && r4.text === '', '两档皆空:调用两次、text 仍为空(接口据此落诊断)');
check(REFLECT_RETRY.retryEffort === 'off', '重试档位固定为 off(不思考,保证有可见输出)');

// ── 通道 A:新默认阈值(≥4 次且跨 ≥3 会话)仍然接受真实模式 ──
const mem2 = new MemoryStore(join(dir, 'm2.db'));
let seq2 = 0;
const turn2 = (sid, text) => mem2.appendRawTurn(sid, { seq: ++seq2, role: 'user', ts: null, model: null, text });
turn2('t1', '太啰嗦了,说重点');
turn2('t1', '回答太长');
turn2('t2', '废话太多,直接给结论');
turn2('t3', '能不能短点');
const strictCands = scanCorrections(mem2);
check(strictCands.length === 1 && strictCands[0].key === 'verbose', '4 次纠正跨 3 个会话 → 默认阈值下仍命中');
check(strictCands[0].hits === 4 && strictCands[0].sessions === 3, `命中统计正确(4 次 / 3 会话),实得 ${strictCands[0].hits} 次 / ${strictCands[0].sessions} 会话`);

// ── G4(2026-09-17):导入命名空间的原文不算"主人原话" ──
// 旧行为:导入的他人对话躺在 dsh_turns_raw 裸 id 下,被习惯生成当主人的纠正信号/原话。
const mem3 = new MemoryStore(join(dir, 'm3.db'));
let seq3 = 0;
const turn3 = (sid, role, text) => mem3.appendRawTurn(sid, { seq: ++seq3, role, ts: null, model: null, text });
turn3('import:conv-w', 'user', '这是导入的他人对话:太啰嗦了');
turn3('import:conv-x', 'user', '导入内容二:回答太长');
turn3('import:conv-y', 'user', '导入内容三:废话太多');
turn3('import:conv-z', 'user', '导入内容四:能不能短点');
check(scanCorrections(mem3).length === 0, 'G4:导入(他人)对话里的"纠正"不算主人的习惯信号');
const M3 = buildReflectMaterial(mem3, { scan: [] });
check(M3.stats.turnTotal === 0, 'G4:原话轮次统计不含导入(实际 ' + M3.stats.turnTotal + ')');
// 主人自己的会话照样参与
turn3('own-1', 'user', '太啰嗦了,说重点');
turn3('own-2', 'user', '回答太长');
turn3('own-3', 'user', '废话太多');
turn3('own-4', 'user', '能不能短点');
const ownCands = scanCorrections(mem3);
check(ownCands.length === 1 && ownCands[0].sessions === 4, 'G4:主人自己的 4 次跨 4 会话仍正常命中(sessions=' + (ownCands[0] && ownCands[0].sessions) + ')');
const M4 = buildReflectMaterial(mem3, { scan: [] });
check(M4.text.includes('太啰嗦了') && !M4.text.includes('导入的他人对话'), 'G4:回想材料只含主人原话,不含导入内容');

// ── E2(2026-10-01):黑名单免检 → 正向白名单(与概述器共用同一处判据)+ 未知来源 kv 告警 ──────
// 旧写法:`… AND session_id NOT LIKE 'import:%'`(排除已知的那一个外来命名空间,其余全当真
// DSH 会话)⇒ 任何没见过的来源都会被当成**主人的**纠正信号,长成"她自己的习惯"。
// 新判据:只有落在 DSH 宿主命名空间里的裸 id 入选;未知前缀排除**并**写一条 kv 告警。
const { isDshSessionId, RAW_UNKNOWN_NS_KEY } = await imp('lib/host/summarizer.js');
const mem4 = new MemoryStore(join(dir, 'm4.db'));
let seq4 = 0;
const turn4 = (sid, role, text) => mem4.appendRawTurn(sid, { seq: ++seq4, role, ts: null, model: null, text });

// ① 负对照:白名单内(裸 id)的会话照旧参与扫描 —— 4 个会话、各 1 次「啰嗦」纠正 ⇒ 仍应命中
turn4('own-a', 'user', '太啰嗦了,说重点');
turn4('own-b', 'user', '回答太长');
turn4('own-c', 'user', '废话太多');
turn4('own-d', 'user', '能不能短点');
// ② 已知外来 `import:`(他人的对话)⇒ 排除,且不算"未知来源"
turn4('import:n1', 'user', '导入的他人对话:太啰嗦了');
turn4('import:n2', 'user', '导入的他人对话:回答太长');
turn4('import:n3', 'user', '导入的他人对话:废话太多');
// ③ 自造的未知前缀 `weird:` ⇒ 排除 **且** 留证(kv 告警)
turn4('weird:n1', 'user', '未知来源:太啰嗦了');
turn4('weird:n2', 'user', '未知来源:回答太长');
turn4('weird:n3', 'user', '未知来源:废话太多');
turn4('weird:n4', 'user', '未知来源:别拽文');
const e2cands = scanCorrections(mem4);
check(e2cands.length === 1 && e2cands[0].key === 'verbose', 'E2:恰好 1 条候选(实得 ' + JSON.stringify(e2cands.map((c) => c.key)) + ')');
check(e2cands[0] && e2cands[0].hits === 4 && e2cands[0].sessions === 4, `E2①:白名单内 4 个会话照旧命中(实得 ${e2cands[0] && e2cands[0].hits} 次 / ${e2cands[0] && e2cands[0].sessions} 会话)`);
check((e2cands[0]?.samples || []).every((s) => !s.includes('导入') && !s.includes('未知来源')), 'E2②③:import:/weird: 的原话都不进纠正信号(旧黑名单会把 weird: 算成主人的纠正)');
const rawAlarmH = mem4.kvGet(RAW_UNKNOWN_NS_KEY);
check(typeof rawAlarmH === 'string' && rawAlarmH.length > 0, 'E2③:习惯扫描也留证未知来源(kv 告警 ' + RAW_UNKNOWN_NS_KEY + ')');
let alarmH = null; try { alarmH = JSON.parse(String(rawAlarmH)); } catch { alarmH = null; }
check(!!alarmH && !!alarmH.namespaces?.['weird:'], 'E2③:告警点名 weird:');
check(!!alarmH && Number(alarmH.namespaces['weird:']?.turns) === 4, 'E2③:告警记了条数(实际 ' + (alarmH && alarmH.namespaces['weird:']?.turns) + ')');
check(!!alarmH && (alarmH.namespaces['weird:']?.samples || []).includes('weird:n1'), 'E2③:告警带样本 id');
check(!!alarmH && !alarmH.namespaces['import:'] && !alarmH.namespaces[''], 'E2②③:已知外来与白名单都不入告警(不误报)');
check(/habit-gen\.(scanCorrections|buildReflectMaterial)/.test(String(alarmH?.where || '')), 'E2③:告警标注了是谁发现的(where=' + String(alarmH?.where) + ')');

// 回想材料的两条查询(COUNT + 分页)也必须走同一判据
const ME2 = buildReflectMaterial(mem4, { scan: [] });
check(ME2.stats.turnTotal === 4, 'E2:回想材料的原话总量只数白名单内的会话(实际 ' + ME2.stats.turnTotal + ',应为 4)');
check(ME2.text.includes('太啰嗦了') && !ME2.text.includes('导入的他人对话') && !ME2.text.includes('未知来源:'), 'E2:回想材料只含主人原话(不含 import:/weird: 内容)');
check(isDshSessionId('sess-real') && isDshSessionId('own-a') && !isDshSessionId('import:x') && !isDshSessionId('weird:x') && !isDshSessionId('vein:z') && !isDshSessionId(''), 'E2:判据边界(裸 id 入,任何带命名空间前缀者出)');

// ── E3(2026-10-01):来源列落地 —— 判据边界从"id 文本"变成"记录下来的来源" ──────────────────
// E2 的边界(上一段)是:「将来若出现**不带前缀**的新来源,判据无法分辨」。加 source 列之后分得出来:
// 下面这台来源就是"不带冒号、只有 source 列认得出它"的那一类(旧判据会把它当主人的纠正信号)。
// 同时验证半迁移回落:列空的**老行**照旧按裸 id 放行 ⇒ 与修前行为一致。
const { rawSourceOf, RAW_SOURCE_DSH } = await imp('lib/host/memory.js');
const mem5 = new MemoryStore(join(dir, 'm5.db'));
let seq5 = 0;
const turn5 = (sid, role, text, source) => mem5.appendRawTurn(sid, { seq: ++seq5, role, ts: null, model: null, text, source });
turn5('own-e3a', 'user', '太啰嗦了,说重点');
turn5('own-e3b', 'user', '回答太长');
turn5('own-e3c', 'user', '废话太多');
turn5('own-e3d', 'user', '能不能短点');
// 不带冒号的未知来源(自造 'weird-x')—— 只有 source 列认得出它
turn5('weird-bare-1', 'user', '别的来源:太啰嗦了', 'weird-x');
turn5('weird-bare-2', 'user', '别的来源:回答太长', 'weird-x');
turn5('weird-bare-3', 'user', '别的来源:废话太多', 'weird-x');
turn5('weird-bare-4', 'user', '别的来源:能不能短点', 'weird-x');
// 半迁移老行:直接 INSERT(不写 source)⇒ NULL ⇒ 回落旧"裸 id"判据,与修前一样参与扫描
mem5.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('legacy-h',1,'user',NULL,NULL,'老行(无 source):太啰嗦了')").run();
const e3cands = scanCorrections(mem5);
check(e3cands.length === 1 && e3cands[0].key === 'verbose' && e3cands[0].sessions === 5,
  'E3①④:白名单内 4 个真会话 + 1 条半迁移老行照旧命中(实得 ' + JSON.stringify(e3cands.map((c) => [c.key, c.sessions])) + ')');
check((e3cands[0]?.samples || []).every((s) => !s.includes('别的来源')), 'E3③:不带冒号的未知来源的原话**不进**纠正信号(旧判据:裸 id = 主人)');
const ME3 = buildReflectMaterial(mem5, { scan: [] });
check(ME3.stats.turnTotal === 5, 'E3:回想材料的原话总量 = 5(4 条主人原话 + 1 条半迁移老行;weird-x 的 4 条不计),实际 ' + ME3.stats.turnTotal);
check(!ME3.text.includes('别的来源'), 'E3:回想材料只含主人原话(不含 weird-x 的内容)');
let alarm3 = null; try { alarm3 = JSON.parse(String(mem5.kvGet(RAW_UNKNOWN_NS_KEY) || '')); } catch { alarm3 = null; }
check(!!alarm3?.namespaces?.['weird-x'], 'E3③:告警点名**记录下来的来源名** weird-x(实际键=' + JSON.stringify(Object.keys(alarm3?.namespaces || {})) + ')');
check(alarm3?.namespaces?.['weird-x']?.by === 'source' && Number(alarm3?.namespaces?.['weird-x']?.turns) === 8,
  'E3③:告警说清来路(by=source ⇒ 不是靠 id 前缀猜的)+ 条数;条数为 8 = 4 行 × 两个入口'
  + '(scanCorrections + buildReflectMaterial 各记一遍,同一命名空间**累加** —— 既有口径),条目=' + JSON.stringify(alarm3?.namespaces?.['weird-x']));
check(!alarm3?.namespaces?.[''] && !alarm3?.namespaces?.['import:'], 'E3:半迁移回落的裸 id 不入告警(不误报)');
check(rawSourceOf('weird-bare-1') === RAW_SOURCE_DSH && rawSourceOf('import:x') === 'import',
  'E3:缺省来源推导(裸 id ⇒ ' + RAW_SOURCE_DSH + ';前缀 ⇒ 去尾冒号)');

console.log(ok ? '习惯生成器(A 数出来的 + B 想出来的)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
