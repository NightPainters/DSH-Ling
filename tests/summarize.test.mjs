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

// ---- G2(2026-09-17):概述重建不得清零"本机用户态字段"(置顶/命中/热度) ----
// 旧行为:概述器每轮 upsert 都写 heat=0/importance=0/hit_count=0 且 UPSERT 无条件覆盖 ⇒
// 置顶的删除保护(cleanOverviewOnArchive 的 importance>=1)与热度排序双双失效。
db.setImportance('dsh', 'sess-real', 1);
db.bumpHit('dsh', 'sess-real');
const g2a = db.overviewById('dsh', 'sess-real');
check(g2a.importance === 1 && g2a.hit_count === 1 && !!g2a.last_hit_at, 'G2 前置:置顶/命中已落库');
db.appendRawTurn('sess-real', { seq: 7, role: 'assistant', ts: '2026-09-06T10:05:00Z', model: null, text: '第七句' });
summarizeDsh(db);
const g2b = db.overviewById('dsh', 'sess-real');
check(g2b.importance === 1, 'G2:概述重建后置顶保留(实际 importance=' + g2b.importance + ')');
check(g2b.hit_count === 1, 'G2:概述重建后命中次数保留(实际 hit_count=' + g2b.hit_count + ')');
check(!!g2b.last_hit_at, 'G2:概述重建后 last_hit_at 保留');
// 反证:普通字段仍随增量刷新(用一个未深摘的新会话,避免撞上"深摘要不被浅版覆盖"的既有保护)
db.appendRawTurn('sess-g2', { seq: 1, role: 'user', ts: '2026-09-06T11:00:00Z', model: null, text: '新会话首问:这段文本要足够长,以便通过概述器的最小字符数门槛(MIN_CHARS=40),确保它会真的被概述' });
db.appendRawTurn('sess-g2', { seq: 2, role: 'assistant', ts: '2026-09-06T11:00:10Z', model: null, text: '收到,这是一条回复' });
summarizeDsh(db);
const g2s = db.overviewById('dsh', 'sess-g2');
check(g2s && g2s.summary.includes('2 条消息'), 'G2 反证:非用户态字段仍随增量刷新(summary=' + (g2s && g2s.summary) + ')');
// 新行仍按调用方给的初值落库(keep 保护只作用于 UPDATE 分支)
db.upsertOverview({ conv_id: 'sess-fresh', source: 'dsh', title: 't', importance: 1, hit_count: 3 });
const g2c = db.overviewById('dsh', 'sess-fresh');
check(g2c && g2c.importance === 1 && g2c.hit_count === 3, 'G2:新行 INSERT 分支不受影响');
// 显式整行覆盖(仅"按备份原样恢复"类场景使用)
db.upsertOverview({ ...g2b, keepUserState: false, importance: 0, hit_count: 0, last_hit_at: null });
check(db.overviewById('dsh', 'sess-real').importance === 0, 'G2:keepUserState:false 时允许整行覆盖');

// ---- G4(2026-09-17):导入原文落 'import:' 命名空间,DSH 概述器不得认领 ----
// 旧行为:导入原文写进 dsh_turns_raw 的裸 id ⇒ GROUP BY session_id 把它当成 DSH 会话重建一份
// source='dsh' 的概述(跨源双份召回),P0-8 的 15 条污染即由此而来。
db.appendRawTurn('import:uuid-import-1', { seq: 1, role: 'user', ts: '2026-09-07T10:00:00Z', model: null, text: '这是一段从别的平台导入的对话原文,长度超过概述器最小字符数门槛才会被考虑' });
db.appendRawTurn('import:uuid-import-1', { seq: 2, role: 'assistant', ts: '2026-09-07T10:00:10Z', model: null, text: '导入的回复' });
const st5 = summarizeDsh(db);
check(!db.overviewById('dsh', 'import:uuid-import-1'), 'G4:导入原文不被概述器认领(无 dsh 概述行)');
check(!db.overviewById('dsh', 'uuid-import-1'), 'G4:裸 id 也不成概述(不误伤正常会话)');
check(st5.sessions === 3, 'G4:概述器会话集不含导入命名空间(应为本库 3 个真实会话,实得 ' + st5.sessions + ')');

console.log(ok ? 'summarizer 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
