// summarizer 单元测试(临时库:建原始轮次 → 概述 → 幂等 → 增量)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-sum-'));
const db = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 两个会话:一个有实质对话;一个只有单条短消息(应跳过)
db.appendRawTurn('sess-real', { seq: 1, role: 'user', ts: '2026-09-06T10:00:00Z', model: null, text: '帮我优化材料串联落地模拟的代码' });
db.appendRawTurn('sess-real', { seq: 2, role: 'assistant', ts: '2026-09-06T10:00:10Z', model: null, text: '已优化:引入速度Verlet' });
db.appendRawTurn('sess-real', { seq: 3, role: 'user', ts: '2026-09-06T10:01:00Z', model: null, text: '阻尼参数再加一个滑杆' });
db.appendRawTurn('sess-real', { seq: 4, role: 'assistant', ts: '2026-09-06T10:01:20Z', model: null, text: '好的,已加' });
db.appendRawTurn('sess-tiny', { seq: 1, role: 'user', ts: '2026-09-06T10:02:00Z', model: null, text: 'hi' });

const st1 = summarizeDsh(db);
check(st1.created === 1, '仅实质会话成概述,实际 created=' + st1.created);
const row = db.overviewById('dsh', 'sess-real');
check(row && row.title.includes('材料串联'), '标题来自首问: ' + (row && row.title));
check(row && row.category === 'knowledge', '类别=knowledge: ' + (row && row.category));
check(row && row.summary.includes('4 条消息'), '摘要含轮次: ' + (row && row.summary));
check(row && row.overview_ok === true && row.source === 'dsh', 'source=dsh & ok');

const st2 = summarizeDsh(db);
check(st2.skipped === 2 && st2.created === 0, '幂等:二次全跳过, skipped=' + st2.skipped);

// 新增轮次 → 只重建该会话
db.appendRawTurn('sess-real', { seq: 5, role: 'assistant', ts: '2026-09-06T10:03:00Z', model: null, text: '又聊了一句' });
const st3 = summarizeDsh(db);
check(st3.updated === 1, '增量更新 1 个, updated=' + st3.updated);
const row2 = db.overviewById('dsh', 'sess-real');
check(row2.summary.includes('5 条消息'), '摘要轮次更新为 5');

// 已深摘会话:增量刷新不覆盖深摘要
db.kvSet('deep:sess-real', 'done:2026-09-07T00:00:00Z');
const deepSum = '主旨:深摘要内容保留测试';
db.upsertOverview({ ...db.overviewById('dsh', 'sess-real'), summary: deepSum });
db.appendRawTurn('sess-real', { seq: 6, role: 'assistant', ts: '2026-09-06T10:04:00Z', model: null, text: '再聊一句' });
const st4 = summarizeDsh(db);
check(st4.updated === 1, '深摘后增量仍更新日期, updated=' + st4.updated);
check(db.overviewById('dsh', 'sess-real').summary === deepSum, '深摘要未被浅版覆盖');

console.log(ok ? 'summarizer 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
