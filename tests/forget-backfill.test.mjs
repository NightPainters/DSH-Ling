// 第 34 套:归档 / 遗忘 / 回灌(J2 · 1.5.1 红蓝对抗 B-33 —— 全项目最危险的"零覆盖裸区")
//
// 为什么单独成一套:这三个操作是**仅有的会丢弃或改写主人真实记忆**的动作,而 1.5.0 之前
// `tests/` 里没有一处引用 `archiveBefore` / `forgetEntry` / `restoreEntry` / `readArchive` /
// `listArchives` / `unforgetEntry` / `exportEntry` —— B-01(回灌绕开 rawSessionId)、
// B-02(回灌丢标题锁)这类"跑一次全流程就露头"的缺陷顺利过闸(红队 B §5.1)。
//
// 覆盖(逐条对应红队 B §5.1 的建议):
//   ① 四段对账:行数 · 召回 · undo · 回灌往返 hash
//   ② `import` 源往返单独一条断言:turns 的 `session_id` 必须仍是 `import:<id>`(B-01)
//   ③ 归档落盘的内容忠实度 + README 还原指引(B-08/B-09 的"内容忠实度满分"要有闸门)
//   ④ 归档目录名唯一化(B-07:同秒同对象两次归档不得静默覆盖)
//   ⑤ **真实工具 handler** 跑完整链路(memory_forget → memory_backfill),不是只调函数
//   ⑥ 回灌必须还原 `title_locked` / `title_by`(B-02 的回归网)
//   ⑦ 空归档守卫(B-05 的回归网)
//
// 纪律:全程 `mkdtempSync` 临时库 + 临时归档目录 —— 绝不碰 live 库
// (真机的记忆库是 WAL,复制即丢数据;本套测试连真机路径都不读)。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { archiveBefore, listArchives, readArchive, archiveRootOf } = await imp('lib/host/archive.js');
const { selectL1 } = await imp('lib/host/l1.js');
const { registerLingTools, TOOL_MEMORY_FORGET, TOOL_MEMORY_BACKFILL } = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'ling-forget-'));
const mem = new MemoryStore(join(dir, 'm.db'));
const ARC = archiveRootOf(mem); // <tmp>/forgotten —— 归档落在临时目录,不碰 live

/** 库内四张表的整体指纹(用来证明"遗忘不删行"是逐字段的,而不只是行数) */
function tableDigest() {
  const q = (sql) => {
    try { return mem.db.prepare(sql).all().map((r) => Object.values(r).join('\u0001')); } catch { return []; }
  };
  return {
    raw: sha(q('SELECT * FROM dsh_turns_raw ORDER BY session_id, seq')),
    ov: sha(q('SELECT * FROM conv_overview ORDER BY source, conv_id')),
    meta: sha(q('SELECT * FROM session_meta ORDER BY session_id')),
    turns: mem.db.prepare('SELECT COUNT(*) n FROM dsh_turns_raw').get().n,
    ovs: mem.db.prepare('SELECT COUNT(*) n FROM conv_overview').get().n,
    forgotten: mem.db.prepare('SELECT COUNT(*) n FROM forgotten').get().n,
  };
}
/** 一条记忆的全部 17 列(逐字段,含 title_locked / title_by) */
const ovRow = (s, c) => mem.db.prepare('SELECT * FROM conv_overview WHERE source=? AND conv_id=?').get(s, c);
const rawRows = (sid) => mem.db.prepare('SELECT * FROM dsh_turns_raw WHERE session_id=? ORDER BY seq').all(sid);
/** 归档 → 把内容"拿走"(模拟库被清)的落盘中转 */
const dumpPath = join(dir, 'dump.json');
const dumpOut = (e) => { writeFileSync(dumpPath, JSON.stringify(e), 'utf8'); return JSON.parse(readFileSync(dumpPath, 'utf8')); };

// ── 种子 ───────────────────────────────────────────────────────────────────
const SID = 'sess-forget-1';
const TURNS = [
  { seq: 1, role: 'user', ts: '2026-09-25T01:00:00Z', model: null, text: '记住:归档之前一定要先落盘,别相信内存。' },
  { seq: 2, role: 'assistant', ts: '2026-09-25T01:00:05Z', model: 'deepseek', text: '记下了。顺序不能反 —— 归档失败就绝不打标记。' },
  { seq: 3, role: 'user', ts: '2026-09-25T01:01:00Z', model: null, text: '还有:回灌比遗忘更危险,因为它更难察觉。' },
  { seq: 4, role: 'assistant', ts: '2026-09-25T01:01:09Z', model: 'deepseek', text: '所以回灌前也要先备份当前状态。' },
  { seq: 5, role: 'user', ts: '2026-09-25T01:02:00Z', model: null, text: '对。两条独立还原路径,断一条还有另一条。' },
];
for (const t of TURNS) mem.appendRawTurn(SID, t);
mem.upsertOverview({
  source: 'dsh', conv_id: SID, title: '归档与遗忘的纪律', summary: '归档先于标记;回灌先于备份。'.repeat(3),
  category: 'knowledge', keywords: ['归档', '遗忘'], overview_ok: true,
  started_at: '2026-09-25T01:00:00Z', updated_at: '2026-09-25T01:02:00Z',
});
// 主人手改过标题 ⇒ 上锁(D2)。B-02 要证的正是"这条被锁过"这个事实能不能随回灌一起回去。
mem.renameTitle('dsh', SID, '归档纪律(主人定名)', { lock: true, by: 'user' });
// 一条对照组:没被遗忘的记忆必须照常参与召回(负对照 —— 否则"排除"可能只是整体召回坏了)
mem.upsertOverview({ source: 'dsh', conv_id: 'sess-keep-1', title: '对照组', summary: '不该被遗忘影响。', category: 'daily', overview_ok: true });

const L1 = { mode: 'work', categoryWeights: { work: { knowledge: 1.0, daily: 0.6, feeling: 0.2 } }, maxItems: 20, budgetChars: 100000, sessionId: SID };
const l1Ids = () => selectL1(mem, L1).items.map((i) => i.conv_id);

// ── ① 归档落盘:内容忠实度 + 还原指引 ─────────────────────────────────────
const a1 = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'forget', reason: '测试:归档忠实度', actor: 'ling' });
check(a1.ok === true && a1.turns === 5, '归档成功且如实回报轮数:' + JSON.stringify({ ok: a1.ok, turns: a1.turns }));
check(readFileSync(join(a1.dir, 'turns.jsonl'), 'utf8').trim().split('\n').length === 5, 'turns.jsonl 逐行 5 条');
const a1read = readArchive(mem, a1.dir.slice(a1.dir.lastIndexOf('\\') + 1));
check(a1read.ok && a1read.turns.length === 5 && a1read.turns[2].text === TURNS[2].text, '读回的第 3 轮原文逐字相同');
check(a1read.turns[3].model === 'deepseek' && a1read.turns[0].ts === '2026-09-25T01:00:00.000Z', 'model/ts 字段没有在往返里丢失');
check(a1read.overview && a1read.overview.title === '归档纪律(主人定名)' && a1read.overview.title_locked === true,
  '归档里的概述带 title_locked(否则回灌无从还原 —— B-02 的前提)');
const readme1 = readFileSync(join(a1.dir, 'README.md'), 'utf8');
check(/DELETE FROM forgotten WHERE source='dsh' AND conv_id='sess-forget-1'/.test(readme1),
  'README 给出的是**可执行**的还原 SQL(带着真实 source/conv_id)');
check(/永远不做彻底删除/.test(readme1), 'README 写明原则口径');
check(listArchives(mem).some((x) => x.name === a1read.name), 'listArchives 能列出这份归档');
check(readArchive(mem, 'no-such-dir').turns.length === 0 && readArchive(mem, '../../etc/passwd').ok === true,
  'readArchive 对不存在/带路径分隔符的名字都不抛错(名字被消毒)');
check(readArchive(mem, '../../etc/passwd').name === 'etcpasswd', '名字里的路径分隔符被剥掉,不越出归档根目录');

// ── ② B-07:归档目录名必须唯一(同秒同对象两次归档不得静默覆盖) ─────────────
const a1b = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'forget', reason: '测试:目录名唯一化', actor: 'ling' });
check(a1b.ok && a1b.dir !== a1.dir, '同一秒第二次归档拿到**不同**目录:' + a1b.dir.slice(-18));
// ⚠️ 这里原来写的是 `listArchives(mem).filter((x) => x.name.startsWith(a1read.name.slice(0, 15)))`
//   —— 那 15 个字符**正好是目录名的秒级时间戳**(`lib/host/archive.js:15-18` 的 `localStamp` =
//   `YYYYMMDD-HHMMSS`,由 `:64` 拼在 stem 最前头 ⇒ `20260926-175714`)。于是**只要上面那次
//   `archiveBefore` 与这一行之间跨过一次秒边界**,两次归档的前缀就不同,过滤出来只剩 1 条
//   ⇒ 误报"上一份被静默覆盖"(而盘上其实老老实实躺着两份)。
//   实测:两次调用间隔约 8ms(2026-09-26 17:57 那次是 92.0ms → 100.0ms),所以约 0.8% 的跑法
//   会跨秒;机器一忙窗口更大。**判据只能看名字本身,不能看时间的形状。**
const a1bName = a1b.dir.slice(a1b.dir.lastIndexOf('\\') + 1);
const arcNames = listArchives(mem).map((x) => x.name);
check(arcNames.includes(a1read.name) && arcNames.includes(a1bName) && a1read.name !== a1bName,
  '两份归档**同时**在盘上且是两个条目(唯一化一坏,第二次就落进同一个目录,清单里只剩 1 条):'
  + JSON.stringify({ a1: a1read.name, a1b: a1bName, listed: arcNames }));
const a1bRead = readArchive(mem, a1bName);
check(a1bRead.turns.length === 5 && a1bRead.turns[2].text === TURNS[2].text
  && /测试:目录名唯一化/.test(a1bRead.note),
  '第二份是**它自己那一份**(5 轮原文 + 它自己的原因),不是第一份被覆盖后剩下的残骸');
// 判据要打在**实害**上:"静默覆盖"这四个字的后果就是第一份的 README 被第二份顶掉。
// 所以直接回头再读一次第一份,问它"你的原因还是你自己的吗"。
const a1Again = readArchive(mem, a1read.name);
check(/测试:归档忠实度/.test(a1Again.note) && !/测试:目录名唯一化/.test(a1Again.note),
  '第一份**没有被第二份覆盖**(它的 README 里原因仍是它自己的):' + a1Again.note.slice(0, 100));

// ── ③ 遗忘:库里**一行都不删**,标记与归档同时就位 ──────────────────────────
// 先确认"遗忘前它确实在召回里" —— 否则后面的"排除"断言可能只是召回整体坏了(负对照)
check(l1Ids().includes(SID), '遗忘前 L1 召回里有它(前置条件):' + JSON.stringify(l1Ids()));
check(l1Ids().includes('sess-keep-1'), '遗忘前对照组也在召回里(负对照前置)');
const before = tableDigest();
const arc = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'forget', reason: '测试:遗忘纪律', actor: 'ling' });
check(arc.ok && arc.turns === 5, '遗忘前归档成功');
const f1 = mem.forgetEntry({ source: 'dsh', convId: SID, reason: '测试:遗忘纪律', archivePath: arc.dir, actor: 'ling' });
check(f1.ok === true, '打标记成功');
const afterF = tableDigest();
check(afterF.raw === before.raw && afterF.ov === before.ov && afterF.meta === before.meta,
  '遗忘后原文/概述/会话元数据**逐字段全等**(只多了一行标记)');
check(afterF.turns === before.turns && afterF.ovs === before.ovs, `行数守恒:原文 ${before.turns}→${afterF.turns} / 概述 ${before.ovs}→${afterF.ovs}`);
check(afterF.forgotten === 1 && mem.listForgotten()[0].archivePath === arc.dir, '遗忘表 1 行且记着归档路径');
check(ovRow('dsh', SID).title_locked === 1 && ovRow('dsh', SID).title === '归档纪律(主人定名)', '被锁的标题在遗忘后仍是原样');

// ── ④ 召回:遗忘的排除、未遗忘的照常(负对照) ─────────────────────────
check(!l1Ids().includes(SID), '遗忘后 L1 **不再选它** —— "忘了"不是界面幻觉');
check(l1Ids().includes('sess-keep-1'), '对照组仍在召回里(是排除,不是把召回弄坏了)');
check(mem.listOverviews({ onlyOk: true }).length === 2, 'listOverviews 仍返回 2 条(软标记:行没删)');
check(mem.forgottenConvIdSet().has('dsh|' + SID), '召回的排除键是 `source|conv_id`');

// ── ⑤ undo:撤销即恢复,且**归档文件不动** ────────────────────────────────
const u1 = mem.unforgetEntry({ source: 'dsh', convId: SID });
check(u1.ok === true && u1.removed === 1, 'undo 删掉 1 行标记');
check(l1Ids().includes(SID), '撤销后它重新参与召回');
check(mem.unforgetEntry({ source: 'dsh', convId: SID }).removed === 0, '重复撤销是幂等空操作(B-14)');
check(tableDigest().raw === before.raw && tableDigest().ov === before.ov,
  '遗忘→撤销一整圈下来,库内数据与最初**逐字段全等**');
check(listArchives(mem).some((x) => x.dir === arc.dir), '归档文件留在原处(那是"曾经忘过"的证据)');

// ── ⑥ 遗忘 → 回灌 往返:先把内容真的毁掉,再证明能恢复 ────────────────────
const lockedBefore = ovRow('dsh', SID);
const rawHashBefore = sha(rawRows(SID));
const good = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'forget', reason: '往返测试', actor: 'ling' });
const name = good.dir.slice(good.dir.lastIndexOf('\\') + 1);
const exported = dumpOut(mem.exportEntry('dsh', SID));         // 归档 → 落盘中转站
const reads = readArchive(mem, name);
check(reads.turns.length === 5, '回灌源:从归档读回 5 轮');

// 毁掉它:原文 + 概述都删掉(模拟"库里真没了")
mem.db.prepare('DELETE FROM dsh_turns_raw WHERE session_id=?').run(SID);
mem.deleteOverview('dsh', SID);
check(mem.rawTurnCount(SID) === 0 && !mem.overviewById('dsh', SID), '内容已毁(前置条件)');

const cur = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'backfill', reason: '回灌前备份', actor: 'ling' });
check(cur.ok === true, '回灌前对"已空的目标"备份不报硬失败:' + JSON.stringify({ ok: cur.ok, turns: cur.turns, reason: cur.reason }));
const bf = mem.restoreEntry({ source: 'dsh', convId: SID, turns: reads.turns, overview: reads.overview, origin: 'backfill-v1' });
check(bf.ok === true && bf.turns === 5 && bf.overview === true, '回灌写回 5 轮 + 概述');
check(sha(rawRows(SID)) === rawHashBefore, '往返后原文**逐字段 hash 与毁掉之前相同**' + (rawHashBefore === sha(rawRows(SID)) ? '' : '(不符)'));
check(rawRows(SID).length === 5 && rawRows(SID)[4].text === TURNS[4].text, '第 5 轮原文逐字相同');
const lockedAfter = ovRow('dsh', SID);
check(lockedAfter.title === lockedBefore.title, '标题文本还原:' + String(lockedAfter.title));
check(lockedAfter.title_locked === 1, '★ title_locked 被还原(锁没丢)—— B-02 的回归断言');
check(lockedAfter.title_by === 'user', '★ title_by 被还原(记着"这是主人定的名")');
check(lockedAfter.origin === 'backfill-v1', '概述带 origin=backfill-v1 标记(界面上看得出是灌回来的)');
check(Number(lockedAfter.importance) === Number(lockedBefore.importance), '主人留下的置顶状态没被夺走');
// 破坏性证明:锁**真的**在生效,而不只是那一位 bit 被写回
mem.upsertOverview({ source: 'dsh', conv_id: SID, title: '机器想改的名字', summary: 'x', category: 'daily', overview_ok: true });
check(ovRow('dsh', SID).title === '归档纪律(主人定名)', '回灌后的锁**拦得住后续自动改名**(bit 不是摆设)');
check(exported.overview.title_locked === true && exported.turns.length === 5, 'exportEntry 本身就是无损的(归档的输入端)');

// ── ⑦ B-01:import 源往返必须仍是 `import:<id>`(不许出现裸 id 的 dsh 行) ──
const IMP = 'imp-7';
mem.appendRawTurn('import:' + IMP, { seq: 1, role: 'user', ts: '2026-09-25T02:00:00Z', model: null, text: '导入文档的第一段。' });
mem.appendRawTurn('import:' + IMP, { seq: 2, role: 'assistant', ts: '2026-09-25T02:00:02Z', model: null, text: '导入文档的第二段。' });
mem.upsertOverview({ source: 'import', conv_id: 'import:' + IMP, title: '导入件', summary: '导入件的概述。', category: 'knowledge', overview_ok: true });
const impDump = dumpOut(mem.exportEntry('import', IMP));
check(impDump.turns.length === 2, '导入源按裸 id 也能导出(导出端的回退路径还在)');
mem.db.prepare('DELETE FROM dsh_turns_raw WHERE session_id=?').run('import:' + IMP);
const impBf = mem.restoreEntry({ source: 'import', convId: IMP, turns: impDump.turns, overview: impDump.overview });
check(impBf.ok === true && impBf.convId === 'import:' + IMP, '回灌时 convId 已归一成 `import:imp-7`:' + String(impBf.convId));
check(mem.rawTurnCount('import:' + IMP) === 2, '原文落在带前缀的命名空间里');
check(mem.db.prepare("SELECT COUNT(*) n FROM dsh_turns_raw WHERE session_id=?").get(IMP).n === 0,
  '★ 没有裸 id 的原文行(1.3.0 修掉的跨源污染不许复发 —— B-01)');
check(mem.db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source<>'import' AND conv_id LIKE 'import:%'").get().n === 0,
  '★ 也没有 source 不是 import 的镜像行(跨源污染的二代形态)');
check(mem.restoreEntry({ source: 'import', convId: 'import:' + IMP, turns: impDump.turns, overview: null }).convId === 'import:' + IMP,
  '已带前缀的输入不二次加前缀(幂等)');
check(mem.restoreEntry({ source: 'dsh', convId: SID, turns: [], overview: null }).ok === true, '非 import 源的 convId 原样(没有被误加前缀)');
check(mem.restoreEntry({ source: '', convId: '' }).reason === 'bad-key', '空键默认拒绝(bad-key)');

// ── ⑧ B-05:空归档不许当作"备份成功" ────────────────────────────────────
const ghostArc = archiveBefore(mem, { source: 'dsh', convId: 'sess-ghost-does-not-exist', kind: 'forget', reason: '测试:空归档', actor: 'ling' });
check(ghostArc.ok === true && ghostArc.turns === 0, '空目标归档仍"落盘成功"(目录与 README 都在)');
check(ghostArc.empty === true, '★ 但它被明确标成 empty —— 调用方据此拒绝对"还不存在的记忆"打标记(B-05 的判据)');
check(listArchives(mem).some((x) => x.name === ghostArc.dir.slice(ghostArc.dir.lastIndexOf('\\') + 1)), '空归档也出现在清单里(可被 inspect 看见)');
const realArc = archiveBefore(mem, { source: 'dsh', convId: SID, kind: 'forget', reason: 'x', actor: 'ling' });
check(realArc.empty === false && realArc.turns > 0, '真有内容的归档不会被误判成 empty');
// 判据强度:不是"因为条目不在库才空",而是"归档里确实什么都没保住"
//(`empty` = 0 轮原文 **且** 概述没有正文 **且** 没有会话元数据 —— 光有标题不算保住内容)
const ghostOv = archiveBefore(mem, { source: 'dsh', convId: 'sess-ghost-titleonly', kind: 'forget', reason: 'x', actor: 'ling' });
check(ghostOv.empty === true, '不存在的条目:0 轮 + 无概述 + 无会话元数据 ⇒ empty');
mem.upsertOverview({ source: 'dsh', conv_id: 'sess-shell-only', title: '只剩标题的壳', category: 'daily', overview_ok: true });
const titleOnly = archiveBefore(mem, { source: 'dsh', convId: 'sess-shell-only', kind: 'forget', reason: 'x', actor: 'ling' });
check(titleOnly.empty === true, '只有标题、没有正文的壳 ⇒ 也算 empty(标题不构成"保住了内容")');
mem.upsertOverview({ source: 'dsh', conv_id: 'sess-shell-only', title: '只剩标题的壳', summary: '正文还在。', category: 'daily', overview_ok: true });
const withSummary = archiveBefore(mem, { source: 'dsh', convId: 'sess-shell-only', kind: 'forget', reason: 'x', actor: 'ling' });
check(withSummary.empty === false, '有正文的概述 ⇒ 不算 empty(归档确实保住了一份内容,可以放心忘)');

// ── ⑧b B-05 的**执行侧**守卫:空归档不许换来一条遗忘标记(数据层) ──────────────
// 台账原文:「forget 对空归档放行(backfill 有 empty-archive 守卫,forget 没有)
// ⇒ 可永久压制一条"还不存在"的记忆;回执谎称"已归档"」。
// 判据(两半都要):① 归档如实标 empty ② **标记真的没打上**。
{
  const ghost = 'sess-ghost-2';
  check(mem.forgetEntry({ source: 'dsh', convId: ghost, reason: '空归档过关测试' }).ok === false,
    '★ 没给归档路径 ⇒ forgetEntry 直接拒绝(默认拒绝形态)');
  check(!mem.listForgotten().some((f) => f.convId === ghost), '★ 拒绝之后库里**没有任何变化**(没有留下永远召不回的标记)');
  check(mem.forgetEntry({ source: 'dsh', convId: ghost, reason: 'x', archivePath: ghostArc.dir }).reason === 'empty-archive',
    '★ 空归档目录 ⇒ 拒绝(reason=empty-archive):"归档成功"不等于"备份到了东西"');
  check(mem.forgetEntry({ source: 'dsh', convId: ghost, reason: 'x', archivePath: ghostArc.dir, archiveTurns: 0 }).reason === 'empty-archive',
    '调用方自己声明 0 轮 ⇒ 同样拒绝(声明不能把空的说成有的)');
  check(!mem.listForgotten().some((f) => f.convId === ghost), '三种拒绝路径都没有写库(逐条查过)');
  // 正向:真归档照样能忘 —— 守卫不能把正常路径也堵死
  mem.appendRawTurn('sess-keep-2', { seq: 1, role: 'user', ts: '2026-09-25T05:00:00Z', model: null, text: '守卫的正向对照:这条真有原文。' });
  const freshArc = archiveBefore(mem, { source: 'dsh', convId: 'sess-keep-2', kind: 'forget', reason: '正向对照', actor: 'ling' });
  check(freshArc.empty === false && mem.forgetEntry({
    source: 'dsh', convId: 'sess-keep-2', reason: '正向对照', archivePath: freshArc.dir, actor: 'ling',
  }).ok === true, '★ 有内容的归档照常打标记(守卫是拦空的,不是拦正常的)');
  check(mem.forgetEntry({
    source: 'dsh', convId: 'sess-legacy-caller', reason: 'HTTP 口径', archivePath: freshArc.dir, archiveTurns: 3,
  }).ok === true, '调用方按 HTTP 口径传 archiveTurns 时不再验盘(旧调用点不会被这道闸门误伤)');
}

// ── ⑨ 真实工具 handler 全链路(不是只调函数 —— 台账点名的那条) ──────────────
{
  const dir2 = mkdtempSync(join(tmpdir(), 'ling-forget-tool-'));
  const mem2 = new MemoryStore(join(dir2, 'm.db'));
  mem2.appendRawTurn('tool-sess-1', { seq: 1, role: 'user', ts: '2026-09-25T03:00:00Z', model: null, text: '工具链路测试用的一轮原文。' });
  mem2.appendRawTurn('tool-sess-1', { seq: 2, role: 'assistant', ts: '2026-09-25T03:00:01Z', model: null, text: '工具链路测试用的第二轮原文。' });
  mem2.upsertOverview({ source: 'dsh', conv_id: 'tool-sess-1', title: '工具链路的会话', summary: '这条用来跑真实 handler。', category: 'daily', overview_ok: true });
  mem2.renameTitle('dsh', 'tool-sess-1', '工具链路(主人定名)', { lock: true, by: 'user' });

  const handlers = {};
  const reg = registerLingTools({ tools: { register: (spec) => { handlers[spec.name] = spec.execute; return () => {}; } } },
    { gate: {}, memory: mem2, settings: {} });
  check(reg.ok === true && typeof handlers[TOOL_MEMORY_FORGET] === 'function' && typeof handlers[TOOL_MEMORY_BACKFILL] === 'function',
    '七个工具注册成功且拿到了真实 execute');

  const bad = await handlers[TOOL_MEMORY_FORGET]({ action: 'forget', source: 'dsh', convId: 'tool-sess-1', reason: 'x' });
  check(bad.ok === false && bad.reason === 'no-reason', 'reason 太短被自校验挡下');

  const listed0 = await handlers[TOOL_MEMORY_BACKFILL]({ action: 'list' });
  check(listed0.ok === true && listed0.count === 0, '归档清单起初为空');

  const forgot = await handlers[TOOL_MEMORY_FORGET]({ action: 'forget', source: 'dsh', convId: 'tool-sess-1', reason: '工具链路:先忘掉' });
  check(forgot.ok === true && forgot.action === 'forget' && forgot.turns === 2, '工具通道遗忘成功且回报归档轮数:' + JSON.stringify({ turns: forgot.turns }));
  check(mem2.rawTurnCount('tool-sess-1') === 2 && mem2.overviewById('dsh', 'tool-sess-1'), '工具通道遗忘后行仍在库里(软标记)');
  check(mem2.listForgotten().length === 1 && mem2.listForgotten()[0].actor === 'ling', '遗忘记在"器灵"名下(actor=ling)');
  const log = mem2.db.prepare("SELECT * FROM branch_log WHERE action='forget'").all();
  check(log.length === 1 && /归档 2 轮/.test(log[0].note), 'branch_log 留痕写明归档了几轮');

  // ★ B-05 的**复现形态**(台账原文的现象,在真实 handler 上跑):
  //   目标**过得了存在性检查**(session_meta 里有它的行),但库里已经没有它的任何内容
  //   (无概述行、无原文轮次)—— 这份归档 0 轮,且什么都没保住。
  //   旧行为会放行并打上遗忘标记:那条 id 永不召回、界面显示"忘过了"、回执还写着"原文与概述已归档"。
  //   修好后它必须被挡下,且**库零变化**。
  mem2.db.prepare('INSERT INTO session_meta(session_id,raw_seq) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET raw_seq=excluded.raw_seq')
    .run('tool-hollow-1', 0);
  check(!mem2.overviewById('dsh', 'tool-hollow-1') && mem2.rawTurnCount('tool-hollow-1') === 0,
    '前置条件:没有概述行、没有原文 —— 只剩一条 session_meta(所以"存在性检查"过得去)');
  const hollow = await handlers[TOOL_MEMORY_FORGET]({ action: 'forget', source: 'dsh', convId: 'tool-hollow-1', reason: '复现 B-05:空归档' });
  check(hollow.ok === false, '★ 空归档的遗忘被挡下(旧行为:ok:true + 一条永久标记)—— 实际 ' + JSON.stringify({ ok: hollow.ok, reason: hollow.reason, turns: hollow.turns }));
  check(hollow.reason === 'empty-archive', '★ 拒绝理由是 empty-archive(不是含糊的"未执行"):实际 ' + String(hollow.reason));
  check(!mem2.listForgotten().some((f) => f.convId === 'tool-hollow-1'), '★ 被挡下后 forgotten 表**没有**这条(标记永不召回 = B-05 的实害)');
  check(mem2.db.prepare("SELECT COUNT(*) n FROM branch_log WHERE action='forget'").get().n === 1,
    '也没有为它写"忘了"的留痕(留痕会让人以为真忘过)');

  const listed1 = await handlers[TOOL_MEMORY_BACKFILL]({ action: 'list' });
  const nm = listed1.list[0].name;
  const ins = await handlers[TOOL_MEMORY_BACKFILL]({ action: 'inspect', name: nm });
  check(ins.ok === true && ins.turns === 2 && /归档|原因|对象/.test(ins.note || ''), 'inspect 回报轮数并把"当初为什么忘"带回给人看');
  check(/turns\.jsonl|原文/.test(ins.preview) || ins.preview.length > 0, 'inspect 带首轮预览');

  mem2.db.prepare('DELETE FROM dsh_turns_raw WHERE session_id=?').run('tool-sess-1');
  mem2.deleteOverview('dsh', 'tool-sess-1');
  const restored = await handlers[TOOL_MEMORY_BACKFILL]({ action: 'restore', name: nm, reason: '工具链路:灌回去' });
  check(restored.ok === true && restored.action === 'restore' && restored.turns === 2, '工具通道回灌成功');
  check(mem2.rawTurnCount('tool-sess-1') === 2, '原文回来了');
  check(mem2.overviewById('dsh', 'tool-sess-1').title_locked === true,
    '★ 走真实工具通道往返后锁仍在(B-02 在工具面也立得住)');
  check(mem2.listForgotten().length === 0, '灌回来 ⇒ 不再算遗忘(unforget 自动做掉)');
  check(mem2.db.prepare("SELECT COUNT(*) n FROM branch_log WHERE action='backfill'").get().n === 1, '回灌也留痕');
  const emptyName = listed1.list[0].name;
  rmSync(join(archiveRootOf(mem2), emptyName, 'turns.jsonl'), { force: true });
  const emptyTry = await handlers[TOOL_MEMORY_BACKFILL]({ action: 'restore', name: emptyName, reason: '工具链路:空归档' });
  check(emptyTry.ok === false && emptyTry.reason === 'empty-archive', '空归档回灌被守卫挡下(这一侧的守卫 1.5.0 就有 —— 用来对比 B-05 的缺口)');
  mem2.close();
  try { rmSync(dir2, { recursive: true, force: true }); } catch { /* Windows 上 WAL 句柄可能还占着一瞬间,临时目录留给系统清 */ }
}

// ── ⑩ live 隔离:所有产物都在临时目录里 ────────────────────────────────────
check(ARC.startsWith(tmpdir()), '归档根目录在临时目录里:' + ARC);
check(!ARC.includes('.dsh'), '没有写进主人真实的 cache\\dsh-ling');

mem.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录留给系统清 */ }
console.log(ok ? '归档 / 遗忘 / 回灌全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);