// feedback 成长回路单元测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { ingestFeedbackEntries, applySuggestionAsRule, dismissSuggestion, entriesFromFeedbackFile } = await imp('lib/host/feedback.js');

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

// 4) 采纳 → 追加惯例(去重)并置 applied
const r4 = await applySuggestionAsRule(db, settings, q[0].id);
check(r4.ok && settings.get().persona.hardRules.length === 1, '采纳后惯例 +1');
const r4b = await applySuggestionAsRule(db, settings, q[0].id);
check(!r4b.ok && r4b.reason === 'status:applied', '重复采纳被拒(状态守卫)');
const again = await ingestFeedbackEntries(db, [{ sessionId: 's1', messageId: 'm9', rating: 'negative', note: '别老引经据典,直给结论' }]);
check(again.queued === 1, '相同文案新条目可入队(采纳时按文案去重)');
const dupRow = db.listFeedback({ status: 'new' })[0];
await applySuggestionAsRule(db, settings, dupRow.id);
check(settings.get().persona.hardRules.length === 1, '同文案去重,不重复追加');

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

console.log(ok ? 'feedback 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
