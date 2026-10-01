// feedback 成长回路单元测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { ingestFeedbackEntries, applySuggestionAsRule, dismissSuggestion, entriesFromFeedbackFile,
  registerFeedbackListener, entriesFromSessionEvents, FEEDBACK_COMMITTED_EVENT } = await imp('lib/host/feedback.js');
const { readFileSync } = await import('node:fs');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-fb-'));
const db = new MemoryStore(join(dir, 'm.db'));
const settings = new SettingsFile(join(dir, 'set'));
db.upsertOverview({ conv_id: 'sess-hit', source: 'dsh', title: '点赞目标', category: 'daily', overview_ok: true });

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 差评带理由 → 入队;无理由/坏评级/重复 → 跳过
const entries = [
  { sessionId: 's1', messageId: 'm1', rating: 'negative', note: ' 别老引经据典,直给结论 ', createdAt: Date.now() },
  { sessionId: 's1', messageId: 'm2', rating: 'negative', note: '  ' },
  { sessionId: 's1', messageId: 'm3', rating: 'weird', note: 'x' },
  { sessionId: 's1', messageId: 'm1', rating: 'negative', note: '重复的' },
];
const r1 = ingestFeedbackEntries(db, entries);
check(r1.queued === 1 && r1.skipped === 3, '入队1/跳过3,实际 q=' + r1.queued + ' s=' + r1.skipped);
const q = db.listFeedback({ status: 'new' });
check(q.length === 1 && q[0].note === '别老引经据典,直给结论', 'note 保留并 trim');
check(db.kvGet('fb.seen') && db.kvGet('fb.seen').includes('s1:m1'), 'seen 持久化');

// 2) 重复拉取 → 全部跳过
const r2 = ingestFeedbackEntries(db, entries, { seen: JSON.parse(db.kvGet('fb.seen')) });
check(r2.queued === 0 && r2.seenAdded === 0, '重拉不重复');

// 3) 点赞 → 命中存在的 dsh 概述则热度 +1
const before = db.overviewById('dsh', 'sess-hit').hit_count;
ingestFeedbackEntries(db, [{ sessionId: 'sess-hit', messageId: 'am1', rating: 'positive', note: '' }]);
const after = db.overviewById('dsh', 'sess-hit').hit_count;
check(after === before + 1, '点赞热度 +1: ' + before + '→' + after);

// 4) 采纳 → 落到**习惯**(2026-09-15 二分:点踩建议是她长出来的东西,不再直达规矩)
const r4 = await applySuggestionAsRule(db, settings, q[0].id);
check(r4.ok && settings.get().persona.habits.length === 1, '采纳后习惯 +1');
const r4b = await applySuggestionAsRule(db, settings, q[0].id);
check(!r4b.ok && r4b.reason === 'status:applied', '重复采纳被拒(状态守卫)');
const again = await ingestFeedbackEntries(db, [{ sessionId: 's1', messageId: 'm9', rating: 'negative', note: '别老引经据典,直给结论' }]);
check(again.queued === 1, '相同文案新条目可入队(采纳时按文案去重)');
const dupRow = db.listFeedback({ status: 'new' })[0];
await applySuggestionAsRule(db, settings, dupRow.id);
check(settings.get().persona.habits.length === 1, '同文案去重,不重复追加');

// 5) 忽略
const r5 = await ingestFeedbackEntries(db, [{ sessionId: 's2', messageId: 'm1', rating: 'negative', note: '忽略我' }]);
const row = db.listFeedback({ status: 'new' })[0];
const dr = dismissSuggestion(db, row.id);
check(dr.ok && db.countFeedback('dismissed') === 1, '忽略生效');

// 6) sidecar 文件结构 → 条目映射(平台 message_feedback.json 形态)
const fileObj = {
  unit: { name: 'message_feedback', version: 0 },
  global: null,
  tables: {
    sessions: {
      'session-a': {
        session: { createdAt: 1, cwd: 'E:\\daily' },
        items: [
          { messageId: 'm1', rating: 'negative', note: '太晦涩', version: 'v1', createdAt: 2, updatedAt: 3 },
          { messageId: 'm2', rating: 'positive' },
          { messageId: '', rating: 'negative', note: 'bad' },
        ],
      },
      'session-b': { session: {}, items: [] },
    },
  },
};
const mapped = entriesFromFeedbackFile(fileObj);
check(mapped.length === 2, '文件映射 2 条有效条目,实际 ' + mapped.length);
check(mapped[0].sessionId === 'session-a' && mapped[0].note === '太晦涩', '映射字段正确');
const ingest = ingestFeedbackEntries(db, mapped);
check(ingest.queued === 1, '文件条目入队 1(negative 带理由),实际 ' + ingest.queued);

// ── U7(2026-10-01)事件驱动:轮询必须不再回来,推送必须挂在位 ─────────────────
const srcIndex = readFileSync(join(root, 'lib/index.js'), 'utf8');
const srcFeedback = readFileSync(join(root, 'lib/host/feedback.js'), 'utf8');
const srcLifecycle = readFileSync(join(root, 'lib/host/lifecycle.js'), 'utf8');

// 7) 源码级:60 秒轮询与死 sidecar 路径已消失
check(!srcIndex.includes('feedbackPollSec'), 'index.js 不再有 feedbackPollSec(轮询配置已删)');
check(!srcIndex.includes('message-feedback.json'), 'index.js 不再读 sidecar 死文件');
check(!/pollFeedback/.test(srcIndex), 'index.js 不再有 pollFeedback');
check(!/fbTimer/.test(srcIndex), 'index.js 不再有 fbTimer(定时器已删)');
check(srcIndex.includes('registerFeedbackListener(ctx, memory)'), 'index.js 挂上了事件驱动的监听');

// 8) 源码级:订阅在位(事件名钉死;改错名这条会红)
check(FEEDBACK_COMMITTED_EVENT === 'feedback/committed', '事件名常量 = feedback/committed');
check(srcFeedback.includes("ctx.on(FEEDBACK_COMMITTED_EVENT") && srcFeedback.includes("ctx.on('session/event'"),
  'feedback.js 订了 feedback/committed + session/event 两条');
check(!/setInterval\s*\(\s*poll/.test(srcFeedback), 'feedback.js 里没有残留轮询');
// lifecycle 那侧:feedback/* 必须被放行,否则事件到不了下游
check(/type === 'feedback\/message-put'/.test(srcLifecycle), 'lifecycle.js 放行 feedback/message-put');

// 9) 行为级:喂一条 feedback/committed ⇒ 处理路径真的被走到(假 ctx)
const dispatched = [];
const fakeCtx = { on: (name, fn) => { dispatched.push(name); return () => { const i = dispatched.indexOf(name); if (i >= 0) dispatched.splice(i, 1); }; } };
const disposeFb = registerFeedbackListener(fakeCtx, db);
check(dispatched.includes('feedback/committed') && dispatched.includes('session/event'),
  '注册后两条订阅都在位,实际: ' + JSON.stringify(dispatched));
const beforePush = db.overviewById('dsh', 'sess-hit').hit_count;
const makeInspection = () => ({
  meta: { id: 'sess-hit' },
  inheritedEventCount: 0,
  events: [
    { type: 'assistant/message', seq: 0, data: {} },
    { type: 'feedback/message-put', seq: 1, data: { sessionId: 'sess-hit', item: { messageId: 'am9', rating: 'positive', version: 'v1', createdAt: 5 } } },
  ],
});
// 直接从假 ctx 找回 handler:注册时拿到的那个
const handlers = new Map();
const ctx2 = { on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } };
const disposeFb2 = registerFeedbackListener(ctx2, db);
const committedHandler = handlers.get('feedback/committed');
check(typeof committedHandler === 'function', '拿到 feedback/committed handler');
committedHandler(makeInspection());
check(db.overviewById('dsh', 'sess-hit').hit_count === beforePush + 1,
  '推送到达 ⇒ 点赞热度 +1: ' + beforePush + '→' + db.overviewById('dsh', 'sess-hit').hit_count);
check(!!db.kvGet('feedback.last'), 'feedback.last 记账写了');
// 幂等:同一条再投递一次,不重复处理
committedHandler(makeInspection());
check(db.overviewById('dsh', 'sess-hit').hit_count === beforePush + 1, '同事件重放不重复加权');
// 宿主 no-op append 也会发这个通知:末条不是 put ⇒ 不许处理
committedHandler({ meta: { id: 'sess-hit' }, inheritedEventCount: 0, events: [{ type: 'assistant/message', seq: 0, data: {} }] });
check(db.overviewById('dsh', 'sess-hit').hit_count === beforePush + 1, '空提交(no-op)不产生副作用');
// update 语义:同一个 messageId 改评级 → 当前值以末条为准
const upd = entriesFromSessionEvents('sx', [
  { type: 'feedback/message-put', data: { sessionId: 'sx', item: { messageId: 'm1', rating: 'positive' } } },
  { type: 'feedback/message-put', data: { sessionId: 'sx', item: { messageId: 'm1', rating: 'negative', note: '改主意' } } },
]);
check(upd.length === 1 && upd[0].rating === 'negative' && upd[0].note === '改主意', '重放后取当前值(put 覆盖)');
// delete 语义:同 messageId 的 delete 抹掉该条
const deld = entriesFromSessionEvents('sx', [
  { type: 'feedback/message-put', data: { sessionId: 'sx', item: { messageId: 'm1', rating: 'positive' } } },
  { type: 'feedback/message-delete', data: { sessionId: 'sx', messageId: 'm1' } },
]);
check(deld.length === 0, 'delete 后当前条目为空');
disposeFb2();
disposeFb();
check(handlers.size === 0, '卸载函数退订生效');

console.log(ok ? 'feedback 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
