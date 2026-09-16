// 归档清理 单元测试(2026-09-16 定案 A:**取消自动清理**,只保留人工入口)。
// 覆盖:①归档会话的概述**不再被自动清**(lifecycle 侧源码护栏)②人工工具仍可清
//      ③置顶/已深摘受保护 ④清掉后概述器不复活(归档=停更) ⑤会话复活→重新纳入
//      ⑥未归档的测试会话一律不动 ⑦live 库不动(全部在临时库上跑)
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-archive-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

/** 造一个够格的会话(≥1 真人 + ≥2 条消息 + ≥40 字)。 */
function seed(sid, text) {
  mem.appendRawTurn(sid, { seq: 1, role: 'user', ts: '2026-09-16T01:00:00Z', model: null, text });
  mem.appendRawTurn(sid, { seq: 2, role: 'assistant', ts: '2026-09-16T01:00:05Z', model: null, text: '收到,这是一条足够长的助手回复,用于满足概述器的字符门槛要求。' });
}

// 1) 三个会话都先正常入库
seed('keep-1', '这个是未归档的测试会话,按约定不该被清理');
seed('arch-1', '这个是归档会话,概述该被清掉');
seed('arch-pin', '这个是归档但被置顶的会话,应该保留');
seed('arch-deep', '这个是归档但已深摘的会话,应该保留');
const st0 = summarizeDsh(mem);
check(st0.created === 4, '四个会话都生成了概述,实际 ' + st0.created);
mem.setImportance('dsh', 'arch-pin', 1);           // 置顶保护
mem.kvSet('deep:arch-deep', 'done:2026-09-16T02:00:00Z'); // 深摘保护

// 2) 候选清单:只列可清项,保护的带 reason
const cand0 = mem.archivedOverviewCandidates();
check(cand0.scanned === 0, '尚无归档 → 候选为空,实际 ' + cand0.scanned);

mem.markArchived('arch-1');
mem.markArchived('arch-pin');
mem.markArchived('arch-deep');
const cand = mem.archivedOverviewCandidates();
check(cand.scanned === 3, '三个归档会话进入扫描,实际 ' + cand.scanned);
check(cand.removable.length === 1 && cand.removable[0].conv_id === 'arch-1', '仅 arch-1 可清:' + JSON.stringify(cand.removable.map((r) => r.conv_id)));
check(cand.kept.length === 2, '两条受保护,实际 ' + cand.kept.length);
check(cand.kept.some((k) => k.conv_id === 'arch-pin' && k.reason === 'pinned'), '置顶保护');
check(cand.kept.some((k) => k.conv_id === 'arch-deep' && k.reason === 'deep'), '深摘保护');

// 3) 归档即清理:arch-1 的概述被删,受保护的照旧
const r1 = mem.cleanOverviewOnArchive('arch-1');
check(r1.removed === true && r1.reason === 'archived', 'arch-1 概述已清:' + JSON.stringify(r1));
check(!mem.overviewById('dsh', 'arch-1'), 'arch-1 确实查不到了');
check(!!mem.overviewById('dsh', 'arch-pin') && !!mem.overviewById('dsh', 'arch-deep'), '受保护的两条仍在');
check(mem.cleanOverviewOnArchive('arch-pin').reason === 'pinned', '置顶会话调用清理被拒(pinned)');
check(mem.cleanOverviewOnArchive('arch-deep').reason === 'deep', '深摘会话调用清理被拒(deep)');
check(mem.cleanOverviewOnArchive('no-such').reason === 'no-overview', '不存在览为空操作');
check(mem.rawTurnCount('arch-1') === 2, '原文保留(清的是概述,不是走过的路)');

// 4) 归档会话不会被概述器复活;未归档会话照常
const st1 = summarizeDsh(mem);
check(!mem.overviewById('dsh', 'arch-1'), '概述器没有复活归档会话');
check(st1.archivedSkipped >= 3, '统计里能看到被跳过的归档会话,实际 ' + st1.archivedSkipped);
check(!!mem.overviewById('dsh', 'keep-1'), '未归档测试会话不受影响(按约定不清理)');

// 5) 会话复活:归档会话来了新轮次 → 清归档标记 → 概述重建
mem.appendRawTurn('arch-1', { seq: 3, role: 'user', ts: '2026-09-16T03:00:00Z', model: null, text: '归档之后又说话了,这个会话应该复活' });
check(mem.sessionMeta('arch-1').archived === 0, '新轮次把归档标记清掉了(复活)');
const st2 = summarizeDsh(mem);
check(!!mem.overviewById('dsh', 'arch-1'), '复活后概述被重建');
check(st2.created + st2.updated >= 1, '重建会计入统计:' + JSON.stringify({ c: st2.created, u: st2.updated }));

// 6) 强制模式(CLI --force)仍可越过归档跳过
mem.markArchived('arch-1');
mem.deleteOverview('dsh', 'arch-1');
summarizeDsh(mem, { force: true });
check(!!mem.overviewById('dsh', 'arch-1'), 'force 时可强制重建(CLI 显式动作)');

// 7) 源码护栏(定案 A):归档点只打标记,**不得**自动清理 —— 否则每个关闭的会话都会被删概述,长期掏空记忆库
const lifecycleSrc = readFileSync(join(root, 'lib/host/lifecycle.js'), 'utf8');
check(!/cleanOverviewOnArchive/.test(lifecycleSrc), 'lifecycle 不再调用自动清理(定案 A:取消自动清理)');
check(/memory\.markArchived\(sid\)/.test(lifecycleSrc), 'lifecycle 仍然打归档标记(归档=停更,不是删除)');
check(/归档\*\*不做自动清理\*\*|不做自动清理/.test(lifecycleSrc), 'lifecycle 里留了"为何不自动清"的注释(防后人误加回)');

console.log(ok ? '归档清理(人工)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
