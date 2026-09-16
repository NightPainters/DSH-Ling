// dsweb 补摘要 单元测试:候选排序与过滤 / 正文组装 / 输出清洗 / 探测失败路径 / 重试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const D = await imp('lib/host/dsweb-summary.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const dir = mkdtempSync(join(tmpdir(), 'ling-dsweb-sum-'));

// ---- 造一个"源库"(conversations / messages),以及一个记忆库 ----
const srcPath = join(dir, 'src.db');
const raw = new DatabaseSync(srcPath);
raw.exec('CREATE TABLE conversations(conv_id TEXT PRIMARY KEY, title TEXT, n_user INTEGER, updated_at TEXT, inserted_at TEXT)');
raw.exec('CREATE TABLE messages(conv_id TEXT, seq INTEGER, role TEXT, text TEXT)');
const conv = raw.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)');
const msg = raw.prepare('INSERT INTO messages VALUES(?,?,?,?)');
conv.run('c1', '四轮技术讨论', 4, '2026-08-01T00:00:00Z', null);
conv.run('c2', '两轮闲聊', 2, '2026-08-02T00:00:00Z', null);
conv.run('c3', '一句话', 1, '2026-08-03T00:00:00Z', null);
conv.run('c4', '三轮复盘', 3, '2026-08-04T00:00:00Z', null);
conv.run('c5', '已有摘要的会话', 5, '2026-08-05T00:00:00Z', null);
for (let i = 1; i <= 4; i += 1) msg.run('c1', i, i % 2 ? 'USER' : 'ASSISTANT', '第一段内容' + i + '：' + '甲'.repeat(30));
for (let i = 1; i <= 2; i += 1) msg.run('c2', i, i % 2 ? 'user' : 'assistant', '闲聊内容' + i);
msg.run('c3', 1, 'USER', '只有一句');
for (let i = 1; i <= 3; i += 1) msg.run('c4', i, i % 2 ? 'USER' : 'ASSISTANT', '复盘内容' + i);
for (let i = 1; i <= 5; i += 1) msg.run('c5', i, i % 2 ? 'USER' : 'ASSISTANT', '已摘要内容' + i);
raw.close();

const mem = new MemoryStore(join(dir, 'm.db'));
const ov = (id, title, summary = '') => mem.upsertOverview({ conv_id: id, source: 'dsweb', title, category: 'knowledge', overview_ok: true, summary });
ov('c1', '四轮技术讨论');
ov('c2', '两轮闲聊');
ov('c3', '一句话');
ov('c4', '三轮复盘');
ov('c5', '已有摘要的会话', '早就补过了');
ov('c9', '源库里没有这条'); // 只在记忆库,不在源库 → 不该进候选
mem.db.prepare("UPDATE conv_overview SET hit_count=3 WHERE conv_id='c1'").run();
mem.db.prepare("UPDATE conv_overview SET hit_count=1 WHERE conv_id='c4'").run();

const src = D.openSource(srcPath);

// 1) 会话列举:轮次阈值
const all = D.listConversations(src, { includeShort: true });
const real = D.listConversations(src);
check(all.length === 5, '含短会话共 5 条,实际 ' + all.length);
check(real.length === 4 && !real.some((c) => c.conv_id === 'c3'), 'minTurns=2 排除一句话会话');
check(real[0].n_user >= 0 && typeof real[0].title === 'string', '返回结构含 n_user/title');

// 2) 正文组装:角色标注 / 预算截断 / 不存在会话
const txt = D.conversationText(src, 'c1', { budgetChars: 200, perMsg: 40 });
check(/^用户:/.test(txt), '正文以角色标注开头:' + txt.slice(0, 12));
check(txt.includes('AI:'), '含 AI 行');
check(txt.length <= 200, '预算内(≤200),实际 ' + txt.length);
const txtSmall = D.conversationText(src, 'c1', { budgetChars: 60, perMsg: 20 });
check(txtSmall.length <= 60, '小预算生效,实际 ' + txtSmall.length);
check(D.conversationText(src, 'nope') === '', '不存在的会话返回空串');

// 3) 候选:排序(命中优先 → 轮次降序)、过滤(已有摘要/源库缺失/短会话)
const cands = D.buildCandidates(mem, src, {});
check(cands.map((c) => c.conv_id).join(',') === 'c1,c4,c2', '排序 = 命中 c1(3) → c4(1) → c2,实际 ' + cands.map((c) => c.conv_id).join(','));
check(!cands.some((c) => c.conv_id === 'c5'), '已有摘要的不进候选');
check(!cands.some((c) => c.conv_id === 'c9'), '源库缺失的不进候选');
check(!cands.some((c) => c.conv_id === 'c3'), '短会话默认不进候选');

// 4) 候选:onlyHit / includeShort 两个开关
const hitOnly = D.buildCandidates(mem, src, { onlyHit: true });
check(hitOnly.length === 2 && hitOnly[0].conv_id === 'c1', 'onlyHit 只留命中过的');
const withShort = D.buildCandidates(mem, src, { includeShort: true });
check(withShort.some((c) => c.conv_id === 'c3'), 'includeShort 收进短会话');

// 5) 清洗:思考块 / 前缀 / 引号 / 换行 / 超长
check(D.cleanSummary('<thinking>我先想想</thinking>摘要：这是一句总结。') === '这是一句总结。', '去掉思考块与"摘要:"前缀:' + D.cleanSummary('<thinking>x</thinking>摘要：这是一句总结。'));
check(D.cleanSummary('「带引号的摘要」') === '带引号的摘要', '首尾引号剥离');
check(D.cleanSummary('第一行\n\n第二行') === '第一行 第二行', '换行折叠为空格');
check(D.cleanSummary('字'.repeat(400)).length === 300, '超长截到 300');
check(D.cleanSummary('') === '' && D.cleanSummary(null) === '', '空输入返回空串');

// 6) 探测失败路径(不可达端口)—— 必须"快速失败且给出原因",绝不静默改道
const probe = await D.probeAssistant('http://127.0.0.1:9/v1', { timeoutMs: 800 });
check(probe.ok === false, '不可达端点 → ok:false');
check(typeof probe.reason === 'string' && probe.reason.length > 0, '失败给出 reason:' + probe.reason);

// 7) 重试路径(打桩 fetch:第一次只出思考,第二次出正文)—— 不花真实额度
const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push(String(url));
  const body = JSON.parse(String(opts?.body || '{}'));
  const big = Number(body?.options?.num_predict || body?.max_tokens || 0) >= 2048;
  return {
    ok: true,
    json: async () => (big
      ? { message: { content: '这是补出来的摘要' }, done: true, done_reason: 'stop' }
      : { message: { content: '', thinking: '思考占满了预算' }, done: true, done_reason: 'length' }),
  };
};
try {
  const r1 = await D.summarizeWithRetry('http://127.0.0.1:11434/v1', 'qwen3.5:9b', { text: '材料' });
  check(r1.ok === true && r1.summary === '这是补出来的摘要', '首次只有思考 → 重试拿到正文');
  check(r1.attempts.length === 2 && r1.attempts[0].tag === 'no-think' && r1.attempts[1].tag === 'big-budget', '两次尝试的标签与顺序正确');
  check(calls.every((u) => u.includes('/api/chat')), '默认走原生端点(/api/chat):' + calls[0]);
  check(r1.attempts[1].maxTokens >= 2048, '重试预算放大到 ≥2048,实际 ' + r1.attempts[1].maxTokens);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: { content: '', thinking: '只会思考' }, done: true, done_reason: 'length' }) });
  const r2 = await D.summarizeWithRetry('http://127.0.0.1:11434/v1', 'qwen3.5:9b', { text: '材料' });
  check(r2.ok === false && r2.summary === '', '两档都空 → ok:false');
  check(r2.error === 'reasoning-only' || r2.error === 'empty', '失败原因可读:' + r2.error);
} finally {
  globalThis.fetch = realFetch;
}

// 8) 版本号 bump:补摘要改了记忆内容,长会话空闲时靠它追平
check(D.touchMemoryVersion(mem, 12345) === true && mem.kvGet('memory_version') === '12345', 'touchMemoryVersion 写入版本号');

try { src.close(); } catch { /* ignore */ }
console.log(ok ? 'dsweb 补摘要 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
