// 规矩 / 习惯 二分:域逻辑 + 注入面组装(第 17 套)
// 核心不变量:规矩可直达但**必须带原话**;习惯**不能被直接写入**,只能"提议 → 确认"。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { DEFAULT_SETTINGS, assemblePersona } = await imp('lib/host/persona.js');
const R = await imp('lib/host/rules.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-rules-'));
const settings = new SettingsFile(join(dir, 'set'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 护栏:没有原话,规矩写不进去
let r = await R.addRule({ settings, rule: '先给结论后展开', quote: '' });
check(r.ok === false && r.reason === 'no-quote', '无原话拒绝写入:' + JSON.stringify(r));
r = await R.addRule({ settings, rule: '', quote: '你以后先说结论' });
check(r.ok === false && r.reason === 'empty-rule', '空规矩拒绝');
r = await R.addRule({ settings, rule: 'x'.repeat(41), quote: '原话' });
check(r.ok === false && r.reason === 'too-long', '超长规矩拒绝');

// 2) 正常写入 + 留痕(原话/时间/会话)
r = await R.addRule({ settings, rule: '先给结论,再展开', quote: '以后回答先给结论', sessionId: 'sess-1', now: 1700000000000 });
check(r.ok && r.text === '先给结论,再展开', '规矩写入成功:' + JSON.stringify(r));
const view1 = R.rulesView(settings);
check(view1.rules.length === 1 && view1.rules[0].quote === '以后回答先给结论', '留痕含原话');
check(view1.rules[0].sessionId === 'sess-1' && view1.rules[0].at === 1700000000000, '留痕含会话与时间');
check(!view1.rules[0].warning, '未超上限时不告警');

// 3) 重复与去重(压缩空白后同一句算重复)
r = await R.addRule({ settings, rule: '  先给结论,  再展开 ', quote: '再说一遍' });
check(r.ok === false && r.reason === 'duplicate', '重复规矩被拒:' + JSON.stringify(r));

// 4) 上限:第 13 条仍写入,但带 over-cap 告警(提示合并,而非拒绝)
for (let i = 1; i <= 11; i += 1) await R.addRule({ settings, rule: '规矩' + i, quote: '原话' + i });
check(R.rulesOf(settings).length === R.RULES_MAX, '写满 ' + R.RULES_MAX + ' 条');
r = await R.addRule({ settings, rule: '第 13 条', quote: '这是原话' });
check(r.ok === true && r.warning === 'over-cap', '超上限写入并告警:' + JSON.stringify(r.warning));

// 5) 删除(连带清理留痕)
const before = R.rulesOf(settings).length;
r = await R.removeRule({ settings, rule: '规矩1' });
check(r.ok && R.rulesOf(settings).length === before - 1, '删除规矩');
check(!R.ruleMetaOf(settings).some((m) => m.text === '规矩1'), '删除后留痕一并清理');
r = await R.removeRule({ settings, rule: '不存在' });
check(r.ok === false && r.reason === 'not-found', '删除不存在的规矩 → not-found');

// 6) 习惯:只能提议,不能直接写入
r = await R.proposeHabit({ settings, habit: '先接住情绪再谈事', evidence: '3 次深夜对话里你都先说了感受', now: 1700000001000 });
check(r.ok && r.pending === 1, '习惯提议入队:' + JSON.stringify(r));
check(R.habitsOf(settings).length === 0, '提议后**不**直接成为习惯');
r = await R.proposeHabit({ settings, habit: '先接住情绪再谈事', evidence: 'dup' });
check(r.ok === false && r.reason === 'already-pending', '重复提议被拒');

// 7) 注入面:未确认的提议**不出现**;确认后才出现
let text = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, ...settings.get().persona } }, 'work');
check(!text.includes('先接住情绪再谈事'), '未确认的习惯不进注入面');
check(text.includes('[习惯](你自己长的,新增需用户确认)') === false || !text.includes('先接住情绪'), '习惯段未泄露未确认项');

const pendingId = R.habitsPendingOf(settings)[0].id;
r = await R.resolveHabit({ settings, id: pendingId, action: 'confirm', now: 1700000002000 });
check(r.ok && R.habitsOf(settings).length === 1, '确认后落地为习惯:' + JSON.stringify(r));
text = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, ...settings.get().persona } }, 'work');
check(text.includes('先接住情绪再谈事'), '已确认习惯出现在注入面');
check(text.includes('[习惯](你自己长的,新增需用户确认)'), '习惯段头写明"需用户确认"');

// 8) 驳回:清 pending,不留习惯
await R.proposeHabit({ settings, habit: '不要主动提建议', evidence: '一次' });
const p2 = R.habitsPendingOf(settings)[0].id;
r = await R.resolveHabit({ settings, id: p2, action: 'reject' });
check(r.ok && R.habitsOf(settings).length === 1 && R.habitsPendingOf(settings).length === 0, '驳回只清待确认');

// 9) 已成习惯再提议 → already-habit;确认不存在的 id → not-found;非法 action
r = await R.proposeHabit({ settings, habit: '先接住情绪再谈事', evidence: 'x' });
check(r.ok === false && r.reason === 'already-habit', '已成习惯再提议被拒');
r = await R.resolveHabit({ settings, id: 'nope', action: 'confirm' });
check(r.ok === false && r.reason === 'not-found', '确认不存在的提议 → not-found');
r = await R.resolveHabit({ settings, id: p2, action: 'weird' });
check(r.ok === false, '非法 action 被拒');

// 10) 规矩段头语义 + 旧档案兼容(只有 hardRules 的旧设置也能注入)
const legacy = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, hardRules: ['讲话别太晦涩'] } }, 'work');
check(legacy.includes('[规矩](用户的指令,可直接追加)') && legacy.includes('- 讲话别太晦涩'), '旧 hardRules 兼容为规矩');

// 11) 用户也能提议习惯(byUser),仍须确认才落地
r = await R.proposeHabit({ settings, habit: '少用感叹号', evidence: '用户提议', byUser: true });
check(r.ok && R.habitsPendingOf(settings).some((h) => h.byUser === true), '用户可提议习惯');
check(R.habitsOf(settings).length === 1, '用户提议同样不直接落地');

// 12) 源码护栏:人格中心的投影必须带出 habits / habitsPending
//     (2026-09-16 真机 bug:api.js 的 personaInfo 是白名单投影,漏了这两个字段 → 数据在、注入面也有,
//      但人格中心恒显示"还没有习惯"。这类"漏字段"只会在界面上表现为莫名其妙,故用源码断言钉住。)
import { readFileSync } from 'node:fs';
const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
const infoBlock = apiSrc.slice(apiSrc.indexOf('const personaInfo'), apiSrc.indexOf('const touchesPersona'));
check(/habits:\s*Array\.isArray/.test(infoBlock), 'personaInfo 带出 habits');
check(/habitsPending:\s*Array\.isArray/.test(infoBlock), 'personaInfo 带出 habitsPending');
check(/pronoun:\s*s\?\.persona\?\.pronoun/.test(infoBlock), 'personaInfo 带出 pronoun(同类漏字段=界面静默错)');

// 13) 源码护栏:代词属"契约类" → 定型(未解锁)时界面必须禁用;习惯区不得再解释"需做手术"
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
check(/function inputLock[\s\S]{0,600}pronounSel\.disabled\s*=\s*locked/.test(clientSrc), 'inputLock 禁用代词选择器(契约类,与自称/称呼同规格)');
check(/pronounInput\.disabled\s*=\s*locked/.test(clientSrc), 'inputLock 禁用代词自定义输入框');
check(!/确需删改/.test(clientSrc), '习惯区不再解释"改动需手术"(只读即说明,2026-09-16 用户)');

// 14) 待确认队列上限(2026-09-16 定案:5)
//     珍贵的东西不排队:满了要**明确驳回并说明**,而不是无限堆积或静默丢弃。
check(R.PENDING_MAX_DEFAULT === 5, 'PENDING_MAX_DEFAULT = 5');
{
  const capDir = mkdtempSync(join(tmpdir(), 'ling-cap-'));
  const capSet = new SettingsFile(join(capDir, 'set'));
  const ids = [];
  for (let i = 1; i <= 5; i += 1) {
    const rr = await R.proposeHabit({ settings: capSet, habit: `习惯样本${i}`, evidence: 'e' });
    if (rr.ok) ids.push(rr.id);
  }
  check(ids.length === 5 && R.habitsPendingOf(capSet).length === 5, '可以积满 5 条待确认');
  const over = await R.proposeHabit({ settings: capSet, habit: '第六条的样本', evidence: 'e' });
  check(over.ok === false && over.reason === 'pending-full' && over.limit === 5 && over.pending === 5, '第 6 条被驳回(pending-full / 上限 5):' + JSON.stringify(over));
  check(R.habitsPendingOf(capSet).length === 5, '被驳回的提议没有偷偷入队');
  const rej = await R.resolveHabit({ settings: capSet, id: ids[0], action: 'reject' });
  check(rej.ok === true && R.habitsPendingOf(capSet).length === 4, '驳回一条即腾出位子');
  const again = await R.proposeHabit({ settings: capSet, habit: '第六条的样本', evidence: 'e' });
  check(again.ok === true, '腾出位子后可以再提');
  await capSet.update({ habits: { pendingMax: 2 } });
  check(R.pendingMaxOf(capSet) === 2, 'pendingMax 可配(settings.habits.pendingMax)');
  const over2 = await R.proposeHabit({ settings: capSet, habit: '第七条的样本', evidence: 'e' });
  check(over2.ok === false && over2.limit === 2, '改配置后按新上限驳回');
  check(R.rulesView(capSet).caps.pending === 2, 'rulesView.caps.pending 暴露上限(面板显示 5/5 用)');
}

console.log(ok ? '规矩/习惯 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
