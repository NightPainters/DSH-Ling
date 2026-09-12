// deepsummary 单元测试(候选筛选/转录截断/探针门)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
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

console.log(ok ? 'deepsummary 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
