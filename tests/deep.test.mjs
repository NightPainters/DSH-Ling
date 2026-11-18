// deepsummary 单元测试(候选筛选/转录截断/探针门)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { deepCandidates, buildTranscript, runDeepPass, probeLLM } = await imp('lib/host/deepsummary.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-deep-'));
const db = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
/** 临时静音被测代码的 console.debug(兜底分支会打一行),保持测试输出干净。 */
const silent = async (fn) => {
  const orig = console.debug;
  console.debug = () => {};
  try { return await fn(); } finally { console.debug = orig; }
};

// 造两会话:大会话(可深摘)+ 小会话(不达门槛)
const big = 'sess-big';
const small = 'sess-small';
db.upsertOverview({ conv_id: big, source: 'dsh', title: '大讨论', category: 'daily', overview_ok: true });
db.upsertOverview({ conv_id: small, source: 'dsh', title: '短聊', category: 'daily', overview_ok: true });
let seq = 1;
const longText = '这是一段用于凑长度的会话文本。'.repeat(300);
for (let i = 0; i < 14; i++) {
  db.appendRawTurn(big, { seq: seq++, role: i % 2 ? 'assistant' : 'user', ts: '2026-09-06T10:0' + i + ':00Z', text: longText });
}
db.appendRawTurn(small, { seq: 1, role: 'user', ts: '2026-09-06T11:00:00Z', text: '你好' });
db.appendRawTurn(small, { seq: 2, role: 'assistant', ts: '2026-09-06T11:00:05Z', text: '你好呀' });

// 1) 候选:只有 big 达标
const cands = deepCandidates(db, { limit: 5 });
check(cands.length === 1 && cands[0].session_id === big, '候选只含大会话: ' + JSON.stringify(cands.map(c => c.session_id)));

// 2) 转录截断(超长保头尾)
const tr = buildTranscript(db, big, { cap: 4000 });
check(tr.text.includes('[中段省略]') && tr.text.length <= 4000, '转录截断生效: ' + tr.text.length);
const trSmall = buildTranscript(db, small);
check(trSmall.text.includes('你好呀'), '小会话转录正常');

// 3) 无探针 → runDeepPass 拒绝
const noCtx = { get: () => undefined };
const r1 = await runDeepPass(noCtx, db);
check(r1.ok === false && String(r1.reason).includes('probe-not-ok'), '探针未通过时拒绝执行: ' + r1.reason);

// 4) 探针失败(无 llm 服务)会落盘错误
const p = await probeLLM(noCtx, db);
check(p.ok === false && db.kvGet('llm.probe').includes('"ok":false'), '探针失败落盘');

// 5) done 后不再候选
db.kvSet('deep:' + big, 'done:2026-09-06T12:00:00Z');
check(deepCandidates(db).length === 0, '深摘要后不再重复候选');

// 6) 循环外调用跟随当前模型选择:llm.stream 收到的 provider/model = 当前选择(不是兜底常量)
const { llmOnce, resolveLlmTarget, DEEP_CFG } = await imp('lib/host/deepsummary.js');
let seen = null;
const curModel = { provider: 'pp-custom', model: 'mm-custom-9' };
const curCtx = {
  get: (n) => (n === 'llm'
    ? { stream: (req) => { seen = req; return (async function* () { yield { type: 'text-delta', text: 'ok' }; })(); } }
    : n === 'agentDefaultModel' ? { currentSelection: () => curModel } : undefined),
};
await llmOnce(curCtx, { system: 's', text: 't' });
check(seen && seen.provider === 'pp-custom' && seen.model === 'mm-custom-9', '循环外调用跟随当前模型: ' + JSON.stringify(seen && { p: seen.provider, m: seen.model }));
check(seen.reasoningEffort === DEEP_CFG.effort, '循环外调用仍用低档 effort(与模式档位无关)');
check(seen.provider !== DEEP_CFG.fallbackProvider && seen.model !== DEEP_CFG.fallbackModel, '未落回兜底常量');
const tgt = resolveLlmTarget(curCtx);
check(tgt.followed === true, 'resolveLlmTarget 标记 followed');

// 7) 读不到当前选择 → 退兜底并标记 followed=false(不是静默替用户指定)
const fb = await silent(() => resolveLlmTarget(noCtx));
check(fb.followed === false && fb.provider === DEEP_CFG.fallbackProvider && fb.model === DEEP_CFG.fallbackModel, '不可读时退兜底并标记: ' + JSON.stringify(fb));

// 8) 显式传入 provider/model 优先于当前选择(供测试/覆盖)
let seen2 = null;
const overrideCtx = {
  get: (n) => (n === 'llm'
    ? { stream: (req) => { seen2 = req; return (async function* () { yield { type: 'text-delta', text: 'ok' }; })(); } }
    : n === 'agentDefaultModel' ? { currentSelection: () => curModel } : undefined),
};
await llmOnce(overrideCtx, { system: 's', text: 't', provider: 'p-explicit', model: 'm-explicit' });
check(seen2.provider === 'p-explicit' && seen2.model === 'm-explicit', '显式模型优先: ' + JSON.stringify({ p: seen2.provider, m: seen2.model }));

// 9) rc.4(M21-5):`resolveLlmTarget(ctx, settings)` 四级(ALIGN-v7 §4.3-5 / 验收 B.7-1/2/3)
//    口径:显式入参 > settings.model.background(两键齐全) > 平台 currentSelection > 常量兜底;
//    `provider`/`model`/`followed` 三字段逐字不变,`source` 为**新增附加字段**(消费方不得做对象全等比较)。
//    B.7-1 两键皆空 => source:'platform'(三字段与 6) 的旧口径逐字相同)
const emptyBg = { model: { background: { provider: '', model: '' } } };
const tSet1 = resolveLlmTarget(curCtx, emptyBg);
check(tSet1.source === 'platform', 'B.7-1 空设置 ⇒ source=platform: ' + tSet1.source);
check(tSet1.provider === 'pp-custom' && tSet1.model === 'mm-custom-9' && tSet1.followed === true,
  'B.7-1 空设置 ⇒ provider/model/followed 三字段逐字: ' + JSON.stringify({ p: tSet1.provider, m: tSet1.model, f: tSet1.followed }));
//    第二参缺省(旧单参调用)== 空设置:②恒不命中,行为与 rc.4 之前一致
const tSet0 = resolveLlmTarget(curCtx);
check(tSet0.source === 'platform' && tSet0.provider === tSet1.provider && tSet0.model === tSet1.model && tSet0.followed === tSet1.followed,
  '第二参缺省 ⇒ 与空设置逐字同源: ' + JSON.stringify(tSet0));

//    B.7-2 两键齐全 => source:'settings';桩 llm.stream 收到的 provider/model = 设置值
const bothBg = { model: { background: { provider: 'bg-p', model: 'bg-m' } } };
const tSet2 = resolveLlmTarget(curCtx, bothBg);
check(tSet2.source === 'settings' && tSet2.provider === 'bg-p' && tSet2.model === 'bg-m',
  'B.7-2 两键齐全 ⇒ source=settings: ' + JSON.stringify(tSet2));
let seen3 = null;
const bgCtx = {
  get: (n) => (n === 'llm'
    ? { stream: (req) => { seen3 = req; return (async function* () { yield { type: 'text-delta', text: 'ok' }; })(); } }
    : n === 'agentDefaultModel' ? { currentSelection: () => curModel } : undefined),
};
const out3 = await llmOnce(bgCtx, { system: 's', text: 't', settings: bothBg });
check(seen3 && seen3.provider === 'bg-p' && seen3.model === 'bg-m',
  'B.7-2 llm.stream 收到设置值: ' + JSON.stringify(seen3 && { p: seen3.provider, m: seen3.model }));
check(out3.target && out3.target.source === 'settings', 'B.7-2 回执 target.source=settings: ' + JSON.stringify(out3.target));
//    SettingsFile 实例形态(读 `.user.model.background`,真实运行时由 api 传入的正是实例)
const tInst = resolveLlmTarget(curCtx, { user: bothBg });
check(tInst.source === 'settings' && tInst.provider === 'bg-p' && tInst.model === 'bg-m',
  'SettingsFile 实例(.user)同源: ' + JSON.stringify(tInst));
//    `library-import-engine.js:199` 同批传 settings:global 引擎的 label 直接反映设置级(不传 ⇒ 平台)
const { makeImportModelHook } = await imp('lib/host/library-import-engine.js');
const hookWith = makeImportModelHook({ engine: 'global', ctx: bgCtx, settings: bothBg });
check(hookWith.label === 'global:bg-p/bg-m', 'library-import-engine 传 settings ⇒ label 走设置级: ' + hookWith.label);
const hookWithout = makeImportModelHook({ engine: 'global', ctx: bgCtx, settings: emptyBg });
check(hookWithout.label === 'global:pp-custom/mm-custom-9', 'library-import-engine 空设置 ⇒ label 走平台: ' + hookWithout.label);

//    B.7-3 只填 model(provider 空/全空白)=> source:'platform',**整对忽略**,无混搭
const halfBg = { model: { background: { provider: '  ', model: 'bg-m' } } };
const tSet3 = resolveLlmTarget(curCtx, halfBg);
check(tSet3.source === 'platform' && tSet3.provider === 'pp-custom' && tSet3.model === 'mm-custom-9',
  'B.7-3 单键命中必须整对忽略(不许 p 设置 × m 平台): ' + JSON.stringify(tSet3));
const halfBg2 = { model: { background: { provider: 'bg-p', model: '' } } };
const tSet4 = resolveLlmTarget(curCtx, halfBg2);
check(tSet4.source === 'platform' && tSet4.provider === 'pp-custom' && tSet4.model === 'mm-custom-9',
  'B.7-3(反向)只填 provider 也整对忽略: ' + JSON.stringify(tSet4));

//    ① 显式入参仍是第一级:设置级两键齐全也压不过 llmOnce 的显式覆盖
let seen4 = null;
const expCtx = {
  get: (n) => (n === 'llm'
    ? { stream: (req) => { seen4 = req; return (async function* () { yield { type: 'text-delta', text: 'ok' }; })(); } }
    : n === 'agentDefaultModel' ? { currentSelection: () => curModel } : undefined),
};
const out4 = await llmOnce(expCtx, { system: 's', text: 't', provider: 'p-explicit', model: 'm-explicit', settings: bothBg });
check(seen4.provider === 'p-explicit' && seen4.model === 'm-explicit',
  '显式入参 > 设置级: ' + JSON.stringify({ p: seen4.provider, m: seen4.model }));
check(out4.target && out4.target.source === 'explicit', '显式入参 ⇒ source=explicit: ' + JSON.stringify(out4.target));

// 10) rc.4(M21-6 / D-3):「坏值最小回显」——新键 `llm.background.lastError`(ALIGN-v7 §4.6 B.5-1/2/5)
//    口径:`llmOnce` 只包 `llm.stream` + `for await`;catch 里 `error: String(e?.message ?? e).slice(0, 200)`
//    (**截断只此一处**),记录经 sink 落盘,抛错语义逐字不改;`llm.probe` 与 `runDeepPass` 的闸一个字不动。
{
  const { setLlmErrorSink, llmLastError, LLM_BG_ERROR_KEY } = await imp('lib/host/deepsummary.js');
  check(LLM_BG_ERROR_KEY === 'llm.background.lastError', 'D-3 键名逐字 = llm.background.lastError(不复用 llm.probe): ' + LLM_BG_ERROR_KEY);
  /** 真 kv 的替身:sink 落这里,断言"落盘"这一条路径。 */
  const memKv = new Map();
  const sinkRecs = [];
  setLlmErrorSink((rec) => { sinkRecs.push(rec); memKv.set(LLM_BG_ERROR_KEY, JSON.stringify(rec)); });
  const failCtx = (message) => ({
    get: (n) => (n === 'llm' ? { stream: () => { throw new Error(message); } } : undefined),
  });
  const okCtx = {
    get: (n) => (n === 'llm'
      ? { stream: () => (async function* () { yield { type: 'text-delta', text: 'pong' }; })() }
      : undefined),
  };

  // B.5-1:桩 `llm.stream` 抛 `Error('model x not found')`,两键设为 p/m ⇒ 记录四字段;错误照原样再抛
  let thrown1 = null;
  try {
    await llmOnce(failCtx('model x not found'), { system: 's', text: 't', provider: 'p', model: 'm' });
  } catch (e) { thrown1 = e; }
  check(thrown1 instanceof Error && thrown1.message === 'model x not found',
    'B.5-1 错误照原样再抛给调用方(llmOnce 不吞): ' + String(thrown1 && thrown1.message));
  const rec1 = JSON.parse(String(memKv.get(LLM_BG_ERROR_KEY) || 'null'));
  check(rec1 && rec1.provider === 'p' && rec1.model === 'm' && rec1.error === 'model x not found',
    'B.5-1 kv 记录 provider/model/error 逐字: ' + JSON.stringify(rec1));
  check(rec1 && typeof rec1.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(rec1.at),
    'B.5-1 kv 记录带 ISO 时间: ' + JSON.stringify(rec1 && rec1.at));
  check(Object.keys(rec1 || {}).sort().join(',') === 'at,error,model,provider',
    'B.5-1 记录只有四字段(不做分类学,无 reason/kind): ' + JSON.stringify(rec1));
  check(sinkRecs.length === 1, 'B.5-1 sink 恰好被叫一次(失败一次记一次): ' + sinkRecs.length);
  // 截断只在 catch 这一处:500 字符的消息落盘 200 字符,原样前 200
  const longMsg = 'x'.repeat(500);
  try { await llmOnce(failCtx(longMsg), { system: 's', text: 't', provider: 'p', model: 'm' }); } catch { /* 预期抛 */ }
  const recLong = JSON.parse(String(memKv.get(LLM_BG_ERROR_KEY) || 'null'));
  check(recLong && recLong.error === 'x'.repeat(200), 'B.5-1 长消息截到 200 字符(截断只此一处): ' + String(recLong && recLong.error && recLong.error.length));

  // B.5-2:同一轮失败后 `llm.probe` **逐字等于**写前,且 `runDeepPass` 仍 ok:true(证明没关功能)
  //    ⚠️ 这一条的 sink 必须写进**与 probeLLM 同一本 kv**(`db`),否则"复用旧键"的变异
  //    (MUT-B7)会打在测试桩上、打不到 `llm.probe` —— 那样这条断言是假绿(实测踩过)。
  const probe = await probeLLM(okCtx, db);
  check(probe.ok === true, 'B.5-2 探针桩:probeLLM 落 ok:true');
  const probeBefore = db.kvGet('llm.probe');
  setLlmErrorSink((rec) => db.kvSet(LLM_BG_ERROR_KEY, JSON.stringify(rec)));  // = index.js 注入的形状
  try { await llmOnce(failCtx('model x not found'), { system: 's', text: 't', provider: 'p', model: 'm' }); } catch { /* 预期抛 */ }
  check(JSON.parse(String(db.kvGet(LLM_BG_ERROR_KEY) || 'null'))?.error === 'model x not found',
    'B.5-2 失败记录落进**新键**(不是 llm.probe): ' + String(db.kvGet(LLM_BG_ERROR_KEY)).slice(0, 120));
  check(db.kvGet('llm.probe') === probeBefore, 'B.5-2 一次 llmOnce 失败后 llm.probe 逐字未变(新键不复用旧键)');
  check(JSON.parse(String(probeBefore)).ok === true, 'B.5-2 llm.probe 里 probe.ok 仍是 true(没被新形状抹掉)');
  const deepPass = await runDeepPass(okCtx, db);
  check(deepPass.ok === true, 'B.5-2 runDeepPass 仍返回 ok:true(不是 probe-not-ok): ' + JSON.stringify(deepPass.reason || 'ok'));
  check(JSON.parse(String(db.kvGet('llm.probe'))).ok === true, 'B.5-2 runDeepPass 之后 llm.probe 仍是 ok:true');

  // B.5-5:未注入 sink(只 llmOnce 失败)⇒ `llmLastError()` 有记录(同进程回落)
  setLlmErrorSink(null);
  const beforeFallback = llmLastError();
  let thrown5 = null;
  try {
    await llmOnce(failCtx('sink-less boom'), { system: 's', text: 't', provider: 'pp', model: 'mm' });
  } catch (e) { thrown5 = e; }
  const fb = llmLastError();
  check(thrown5 && thrown5.message === 'sink-less boom', 'B.5-5 未注入 sink 时照原样抛错');
  check(fb && fb.provider === 'pp' && fb.model === 'mm' && fb.error === 'sink-less boom',
    'B.5-5 未注入 sink 仍有同进程记录: ' + JSON.stringify(fb));
  check(JSON.stringify(beforeFallback) !== JSON.stringify(fb), 'B.5-5 回落记录随最近一次失败更新');
  check(llmLastError() !== fb, 'B.5-5 llmLastError() 返回拷贝(外部改不到模块状态)');
  setLlmErrorSink(null);   // 收尾:模块级单例不许带着本段的桩离开

  // 接线判据(源码级):键只有一处常量,index.js 注入的字面量必须与它一致;dispose 必须清空 sink
  const idxSrc = readFileSync(join(root, 'lib/index.js'), 'utf8');
  check(idxSrc.includes("memory.kvSet('" + LLM_BG_ERROR_KEY + "'"),
    'index.js 注入 sink 写的键 = LLM_BG_ERROR_KEY(字面量不许漂)');
  check(/setLlmErrorSink\(null\)/.test(idxSrc), 'index.js 的 dispose 清空 sink(setLlmErrorSink(null))');
}

// 11) M21c(N-1):设置级后台模型必须接进**主路径**,不是只接 library-import-engine。
//     判法(不是 check(true)):真造一个够门槛的会话 + 通过的探针,跑 `runDeepPass`,抓桩 `llm.stream`
//     实际收到的 provider/model;设置级两键齐全 ⇒ 必须 = 设置值;空设置 ⇒ 必须**逐字**回退平台选择。
//     另加源码级双向判据:api.js 的 7 个 `llmOnce(ctx, …)` 调用点逐个必须带 `settings`(少一个即红)。
{
  const mainCtx = (sink) => ({
    get: (n) => (n === 'llm'
      ? { stream: (req) => { sink.v = req; return (async function* () { yield { type: 'text-delta', text: '这一段是深摘结果。' }; })(); } }
      : n === 'agentDefaultModel' ? { currentSelection: () => curModel } : undefined),
  });
  const seed = (dbf, sid) => {
    dbf.upsertOverview({ conv_id: sid, source: 'dsh', title: '主路径会话', category: 'daily', overview_ok: true });
    for (let i = 0; i < 14; i++) {
      dbf.appendRawTurn(sid, { seq: i + 1, role: i % 2 ? 'assistant' : 'user', ts: '2026-09-07T10:' + String(i).padStart(2, '0') + ':00Z', text: longText });
    }
    dbf.kvSet('llm.probe', JSON.stringify({ ok: true, attempts: [] }));   // runDeepPass 的闸,与 settings 无关
  };
  const bgSettings = { model: { background: { provider: 'bg-p', model: 'bg-m' } } };

  // 11a 主路径(设置级两键齐全)⇒ llm.stream 收到设置值,且深摘真跑成
  const d1 = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-ling-n1-set-')), 'm.db'));
  seed(d1, 'sess-main-set');
  const got1 = { v: null };
  const pass1 = await runDeepPass(mainCtx(got1), d1, { settings: bgSettings });
  check(pass1.ok === true && pass1.candidates === 1 && pass1.done.length === 1 && pass1.done[0].ok === true,
    'N-1 runDeepPass 真跑到深摘(候选 1 / 成功 1): ' + JSON.stringify(pass1.done));
  check(got1.v && got1.v.provider === 'bg-p' && got1.v.model === 'bg-m',
    'N-1 主路径 runDeepPass 用**设置级**后台模型(不是平台): ' + JSON.stringify(got1.v && { p: got1.v.provider, m: got1.v.model }));

  // 11b 空设置 ⇒ 逐字回退平台当前选择(provider/model 两字段全等,不是"只回退一半")
  const d2 = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-ling-n1-empty-')), 'm.db'));
  seed(d2, 'sess-main-empty');
  const got2 = { v: null };
  const pass2 = await runDeepPass(mainCtx(got2), d2, { settings: { model: { background: { provider: '', model: '' } } } });
  check(pass2.ok === true && pass2.done.length === 1 && pass2.done[0].ok === true, 'N-1 空设置仍跑完深摘');
  check(got2.v && got2.v.provider === curModel.provider && got2.v.model === curModel.model,
    'N-1 空设置 ⇒ 逐字回退平台 currentSelection: ' + JSON.stringify(got2.v && { p: got2.v.provider, m: got2.v.model }));

  // 11c 不传 settings(旧单参口径)== 空设置(逐字同源)
  const d3 = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'dsh-ling-n1-none-')), 'm.db'));
  seed(d3, 'sess-main-none');
  const got3 = { v: null };
  await runDeepPass(mainCtx(got3), d3);
  check(got3.v && got3.v.provider === got2.v.provider && got3.v.model === got2.v.model,
    'N-1 不传 settings 与空设置逐字同源: ' + JSON.stringify(got3.v && { p: got3.v.provider, m: got3.v.model }));

  // 11d 源码级:api.js 的每个 `llmOnce(ctx, …)` 调用点都必须显式带 settings(7 处;少一处 ⇒ 红)
  const readCallArgs = (src, from) => {   // from = '(' 之后的下标;按括号/字符串状态取到本调用收尾
    let depth = 0; let quote = null; let out = '';
    for (let i = from; i < src.length; i++) {
      const ch = src[i];
      if (quote) { out += ch; if (ch === '\\') { out += src[++i]; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth += 1; out += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth -= 1; out += ch; continue; }
      out += ch;
    }
    return out;
  };
  const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const callIdxs = [...apiSrc.matchAll(/llmOnce\(ctx/g)].map((m) => m.index);
  const noSettings = callIdxs
    .map((idx) => ({ line: apiSrc.slice(0, idx).split('\n').length, args: readCallArgs(apiSrc, idx + 'llmOnce(ctx'.length) }))
    .filter((c) => !/\bsettings\b/.test(c.args));
  check(callIdxs.length === 7, 'N-1 api.js `llmOnce(ctx` 调用点 === 7,实际 ' + callIdxs.length);
  check(noSettings.length === 0,
    'N-1 api.js 全部 llmOnce 调用点都传 settings;缺的:' + JSON.stringify(noSettings.map((c) => c.line)));

  // 11e 源码级:index.js 两处后台 runDeepPass 都把 settings 传进去;deepsummary 内部把它交给深摘
  const idxSrc2 = readFileSync(join(root, 'lib/index.js'), 'utf8');
  const idxPasses = [...idxSrc2.matchAll(/runDeepPass\(ctx, memory, \{[^}]*\}\)/g)].map((m) => m[0]);
  check(idxPasses.length === 2 && idxPasses.every((s) => /\bsettings\b/.test(s)),
    'N-1 index.js 自动深摘两处 runDeepPass 都传 settings: ' + JSON.stringify(idxPasses.map((s) => /\bsettings\b/.test(s))));
  const deepSrc = readFileSync(join(root, 'lib/host/deepsummary.js'), 'utf8');
  check(/deepSummarizeOne\(ctx, memory, c, \{ shouldStop, settings \}\)/.test(deepSrc),
    'N-1 runDeepPass → deepSummarizeOne 透传 settings');
  check(/llmOnce\(ctx, \{ system: SYS, text: tr\.text, settings \}\)/.test(deepSrc),
    'N-1 deepSummarizeOne 的 llmOnce 主调用收到 settings');
}

console.log(ok ? 'deepsummary 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
