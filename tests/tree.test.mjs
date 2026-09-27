// 记忆树(D9-b)单元测试:主脉 / 并脉(防环) / 连边 / 矛盾标记层(未复盘 → 以最新为准)
// 核心不变量:任何树操作与矛盾标记都**不改写任何一条记忆的内容**。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore, TRUNK_ID, CONFLICT_DOWNWEIGHT } = await imp('lib/host/memory.js');
const { selectL1 } = await imp('lib/host/l1.js');
// B3(1.5.2):水位推进是**注入侧**的行为 ⇒ 必须走真实投递路径(renderMemorySection)。
// 只测 branchLogDigest 会把"水位怎么走"整段漏掉 —— 那正是 B3-2 的病根所在。
const { renderMemorySection } = await imp('lib/host/inject.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-tree-'));
const db = new MemoryStore(join(dir, 'm.db'));

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const addOv = (cid, title, summary, when) => db.upsertOverview({ source: 'dsh', conv_id: cid, title, category: 'knowledge', summary, overview_ok: true, updated_at: when || null });

// 1) 主脉(kind='vein')
const v = db.createVein({ name: '力学' });
check(String(v).startsWith('vein:'), '主脉 id 形如 vein:<uuid>,实际 ' + v);
check(db.listBranches().find((b) => b.id === v)?.kind === 'vein', '主脉 kind=vein');
check(db.createVein({ id: v, name: '别的' }) === v, '建主脉幂等');

// 2) 连边(横向关联,不改内容)
const brA = db.createBranch({ name: '工程力学' });
const brB = db.createBranch({ name: '材料科学' });
check(db.linkVeins(brA, brB, { kind: 'related', note: '力学 ↔ 材料' }).ok, '连边成功');
check(db.linkVeins(brA, brB, { kind: 'prerequisite' }).ok && db.listVeinLinks().length === 1, '连边幂等(同对只一条)');
check(db.listVeinLinks()[0].kind === 'prerequisite', '连边可改 kind');
check(db.linkVeins(brA, brA).ok === false, '自连被拒');
check(db.unlinkVein(brA, brB).removed === 1 && db.listVeinLinks().length === 0, '断边');
db.linkVeins(brA, brB, { kind: 'related', note: 'x' });

// 3) 并脉 + 防环
check(db.reparentBranch(brA, v).ok, '并脉:枝挂到主脉下');
check(db.branchAncestors(brA).join('>') === [brA, v, TRUNK_ID].join('>'), '血缘链穿过主脉,实际 ' + db.branchAncestors(brA).join('>'));
check(db.branchDescendants(v).includes(brA), '主脉的后代含该枝');
check(db.reparentBranch(v, brA).reason === 'cycle', '防环:不能挂到自己的后代下');
check(db.reparentBranch(brA, brA).reason === 'self-parent', '防环:不能自挂');
check(db.reparentBranch(TRUNK_ID, v).reason === 'trunk-immutable', '主干不可移动');
check(db.reparentBranch(brA, 'vein:nope').reason === 'no-parent', '父不存在被拒');
check(db.reparentBranch(brA, TRUNK_ID).ok, '并脉可回主干');

// 4) 改名 / 复盘期权重
check(db.renameBranch(v, '力学(三大)').ok && db.listBranches().find((b) => b.id === v).name === '力学(三大)', '主脉改名');
check(db.listBranches().find((b) => b.id === v).nameLocked === 1, '改名即上锁(同 D2 的 title_locked 语义)');
check(db.renameBranch(v, '   ').reason === 'empty-name', '空名被拒');
check(db.setBranchWeight(brA, 1.5).weightScale === 1.5, '复盘期权重可调');
check(db.setBranchWeight(brA, 9).weightScale === 2, '权重上夹到 2');
check(db.setBranchWeight(brA, -1).weightScale === 0, '权重下夹到 0');
db.setBranchWeight(brA, 1);
db.reparentBranch(brA, v); // 复原成 主脉 → 枝

// 5) 整树(branchTree)
db.setSessionBranch('s-a', brA);
const t = db.branchTree();
check(t.total >= 3, '整树含主干/主脉/枝,实际 ' + t.total);
const trunkNode = t.roots.find((r) => r.id === TRUNK_ID);
check(!!trunkNode, '树根是主干');
const veinNode = trunkNode?.children?.find((c) => c.id === v);
check(!!veinNode, '主干下挂主脉');
const aNode = veinNode?.children?.find((c) => c.id === brA);
check(!!aNode, '主脉下挂枝');
check(aNode?.sessions === 1, '枝的会话计数,实际 ' + aNode?.sessions);
check(t.links.length === 1, '整树带连边');

// 6) 矛盾标记层
addOv('c-old', '不做知识库', '我们决定暂时不做知识库,只做记忆树。', '2026-03-01T00:00:00.000Z');
addOv('c-new', '做知识库', '我们决定做知识库,因为归并需要它。', '2026-07-01T00:00:00.000Z');
const rc = db.recordConflict({ aSource: 'dsh', aConvId: 'c-new', bSource: 'dsh', bConvId: 'c-old', kind: 'contradict', score: 0.82, reason: '同题反结论' });
check(rc.ok && rc.id > 0, '记录矛盾');
const rc2 = db.recordConflict({ aSource: 'dsh', aConvId: 'c-old', bSource: 'dsh', bConvId: 'c-new' });
check(rc2.id === rc.id && db.listConflicts().length === 1, '记录幂等且与先后无关(归一排序)');
check(db.recordConflict({ aSource: 'dsh', aConvId: 'x', bSource: 'dsh', bConvId: 'x' }).ok === false, '自己与自己不算矛盾');
check(db.listConflicts({ status: 'pending' }).length === 1, '按状态筛选');
check(db.listConflicts()[0].score === 0.82, '相似度落库');

// 6a) 未复盘 → 以最新为准(旧的一方降权)
let dm = db.conflictDowngradeMap();
check(dm.get('dsh\u0000c-old') === CONFLICT_DOWNWEIGHT, '未复盘:旧的被降权(以最新为准),实际 ' + dm.get('dsh\u0000c-old'));
check(!dm.has('dsh\u0000c-new'), '未复盘:新的不降权');

// 6b) 复盘裁定 → 按裁定
check(db.resolveConflict(rc.id, {}).ok === false, '裁定必须给 winner');
check(db.resolveConflict(rc.id, { winner: 'b' }).ok, '裁定 b 为准(b=旧的)');
dm = db.conflictDowngradeMap();
check(dm.get('dsh\u0000c-new') === CONFLICT_DOWNWEIGHT && !dm.has('dsh\u0000c-old'), '裁定 b 为准 → 新的降权(覆盖"以最新为准")');

// 6c) 驳回 → 不降权
check(db.resolveConflict(rc.id, { status: 'dismissed' }).ok, '驳回矛盾');
check(db.conflictDowngradeMap().size === 0, '驳回后不降权');

// 6d) duplicate 不降权(两条内容相同,降谁都会丢信息)
addOv('c-dup1', '重复一', '同一条内容的两种写法甲。', '2026-01-01T00:00:00.000Z');
addOv('c-dup2', '重复二', '同一条内容的两种写法乙。', '2026-02-01T00:00:00.000Z');
check(db.recordConflict({ aSource: 'dsh', aConvId: 'c-dup1', bSource: 'dsh', bConvId: 'c-dup2', kind: 'duplicate' }).ok, '记录重复对');
check(db.conflictDowngradeMap().size === 0, 'duplicate 不降权');

// 7) L1 集成:score = raw × 血缘 × 矛盾系数
db.bumpHit('dsh', 'c-old');
db.bumpHit('dsh', 'c-new');
check(db.recordConflict({ aSource: 'dsh', aConvId: 'c-new', bSource: 'dsh', bConvId: 'c-old' }).ok, '再记矛盾(pending)');
check(!!db.listConflicts().find((c) => c.kind === 'contradict' && c.status === 'pending'), '被驳回的矛盾再次检出 → 重新提起(回到 pending)');
const l1 = selectL1(db, { mode: 'work' });
const iOld = l1.items.find((i) => i.conv_id === 'c-old');
const iNew = l1.items.find((i) => i.conv_id === 'c-new');
check(l1.items.every((i) => i.conf === 1 || i.conf === CONFLICT_DOWNWEIGHT), 'conf 字段只取 1 或降权系数');
check(!!iNew && iNew.conf === 1, '新的 conf=1');
check(!!iOld && iOld.conf === CONFLICT_DOWNWEIGHT, '旧的 conf=' + CONFLICT_DOWNWEIGHT + ',实际 ' + iOld?.conf);
if (iOld) check(Math.abs(iOld.score - iOld.raw * iOld.lineage * iOld.conf) < 0.002, 'score = raw × 血缘 × 矛盾系数');

// 7b) 不传 sessionId 时仍不做血缘加权,但矛盾降权照旧(与血缘无关)
const l1b = selectL1(db, { mode: 'work' });
check(l1b.items.every((i) => i.lineage === 1), '不传 sessionId:血缘恒为 1');
check(l1b.items.find((i) => i.conv_id === 'c-old')?.conf === CONFLICT_DOWNWEIGHT, '不传 sessionId:矛盾降权仍生效');

// 8) 方案 A(2026-09-21):非会话源的枝归属覆盖层 conv_branch
//    背景:dsweb/import 的历史条目不是 DSH 会话,session_meta 推不出枝 ⇒ 永远留主干,"一键生成树"对它们无效。
const vEng = db.createVein({ name: '工程学' });
db.upsertOverview({ source: 'dsweb', conv_id: 'w2', title: '网页端二', category: 'knowledge', summary: '结构力学与材料性能的问答记录。', overview_ok: true, updated_at: '2026-03-02T00:00:00.000Z' });
check(db.branchOfConv('dsweb', 'w2') === TRUNK_ID, '未指定 → 主干');
check(db.setConvBranch('dsweb', 'w2', vEng).ok, '显式指定非会话源的枝归属');
check(db.branchOfConv('dsweb', 'w2') === vEng, '显式覆盖生效');
check(db.convBranchMap().get('dsweb\u0000w2') === vEng, '覆盖层映射键为 source\\0convId');
const qA = db.queryOverviews({ branch: vEng, limit: 200 });
check(qA.items.some((i) => i.conv_id === 'w2'), '按枝过滤查得到非会话源条目');
const qTrunk = db.queryOverviews({ branch: TRUNK_ID, limit: 500 });
check(!qTrunk.items.some((i) => i.conv_id === 'w2'), '归属后不再计入主干');
const bc = db.branchCounts();
check(bc.byBranch[vEng] === 1, 'branchCounts 计入覆盖层,实际 ' + bc.byBranch[vEng]);
check(db.setConvBranch('dsweb', 'w2', vEng).ok && db.convBranchMap().size === 1, '重复指定幂等(不新增行)');

// 8b) L1 血缘加权对覆盖层条目同样生效
db.setSessionBranch('s-in-vein', vEng);
const l1c = selectL1(db, { mode: 'work', sessionId: 's-in-vein', maxItems: 50 });
const iw2 = l1c.items.find((i) => i.conv_id === 'w2');
check(!!iw2 && iw2.lineage === 1, '同枝(经覆盖层)→ lineage=1,实际 ' + iw2?.lineage);

// 8c) 撤销覆盖 → 回到主干
check(db.clearConvBranch('dsweb', 'w2').removed === 1, '撤销覆盖');
check(db.branchOfConv('dsweb', 'w2') === TRUNK_ID, '撤销后回到主干');
check(db.queryOverviews({ branch: TRUNK_ID, limit: 500 }).items.some((i) => i.conv_id === 'w2'), '撤销后重新计入主干');

// ── 9) B3(1.5.2):树改动播报 —— 双水位 / 时间窗 / 开关 / 超量折叠 ────────────────
// 本节换用**独立库**:id 从 1 起、留痕全由本节造 ⇒ FIFO 与水位才断言得动。
// 每条都走**真实投递路径**,压的是"注入面文本 + kv 水位",不是某个内部函数。
const dir2 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree-wm-'));
const lg = new MemoryStore(join(dir2, 'wm.db'));
const SET = { persona: { enabled: false }, styles: {}, mode: { lastMode: 'life' }, memory: { l1Enabled: false, branchLogEnabled: true } };
const settingsOf = (mem) => ({ get: () => ({ ...SET, memory: { ...SET.memory, ...(mem || {}) } }) });
// 不冻结的 gate:每次投递都重新成文(= "每说一句注入一次"的真实节奏;D4 的冻结另有专门测试)
const GATE = { snapshotOf: () => null, isRunning: () => false, markSnap: () => {} };
const asm = (sid) => ({ agent: { session: { id: sid, header: {} } } });
const deliver = (sid, mem) => renderMemorySection(asm(sid), GATE, lg, settingsOf(mem));
const kv = (k) => Number(lg.kvGet(k) || 0);
const detail = (t) => t.split('\n').filter((x) => x.startsWith('- ') && !x.includes('另有'));
const fold = (t) => t.split('\n').find((x) => x.includes('另有')) || '';
const addLog = (before, after) => {
  lg.logBranch(TRUNK_ID, 'rename', { before, after });
  return Number(lg.db.prepare('SELECT MAX(id) AS m FROM branch_log').get().m);
};
// logBranch 一律写"当前时刻",时间窗要"旧行"就得自己改 at(只改时间,不改内容)
const age = (id, days) => lg.db.prepare('UPDATE branch_log SET at = ? WHERE id = ?')
  .run(new Date(Date.now() - days * 864e5).toISOString(), id);

// 9-1) 新会话不重播(B3-1):A 播过的,B 不该再看到
const i1 = addLog('甲', '乙');
const i2 = addLog('丙', '丁');
const tA = deliver('sess-A');
check(tA.includes('记忆树有改动'), 'B3 段确实成文(否则本节断言是空的):' + JSON.stringify(tA.slice(0, 120)));
check(detail(tA).length === 2, 'A 看到 2 条,实际 ' + detail(tA).length);
check(kv('branch_log_wm.sess-A') === i2, 'A 的会话水位 = 真正示人的最大 id ' + i2 + ',实际 ' + kv('branch_log_wm.sess-A'));
const tB = deliver('sess-B');
check(!tB.includes('记忆树有改动'), '**新会话 B 不重播** A 已播过的(B3-1),实际 ' + JSON.stringify(tB.slice(0, 120)));
check(kv('branch_log_wm.sess-B') === 0, 'B 什么都没看到 ⇒ B 自己的水位不动');
check(!!lg.kvGet('branch_log_wm.sess-A') && !lg.kvGet('branch_log_wm.sess-B'), '会话水位仍**按会话**存(没退回全局单键)');
check(kv('branch_log_wm.announced') === i2, '全局"已示人"水位 = ' + i2 + ',实际 ' + kv('branch_log_wm.announced'));

// 9-2) 不"没看就清"(B3-2):候选(8)> 渲染条数(5) ⇒ 水位只到**真正展示的最大 id**
const ids = [];
for (let i = 0; i < 8; i++) ids.push(addLog('旧' + i, '新' + i));
const t1 = deliver('sess-C');
check(detail(t1).length === 5, '一轮只展开 limit=5 条,实际 ' + detail(t1).length);
check(kv('branch_log_wm.announced') === ids[4], '已示人水位只到**第 5 条** ' + ids[4] + ',实际 ' + kv('branch_log_wm.announced'));
check(kv('branch_log_wm.announced') < ids[7], '水位**没有**跳到全表最新 ' + ids[7] + '(跳到那儿就是 B3-2)');
check(fold(t1).includes('另有 3 笔改动'), '折叠行如实说还剩 3 笔,实际 ' + JSON.stringify(fold(t1)));
// 就在"两条水位分岔"的这一刻钉住 `.last`:它必须已经是全表最大 id(复盘退出判据,§1.3)
check(kv('branch_log_wm.last') === ids[7], '同一轮里 `.last` 已到全表最大 ' + ids[7] + ',而"已示人"水位只到 ' + ids[4] + ',实际 .last=' + kv('branch_log_wm.last'));
const t2 = deliver('sess-C');
check(detail(t2).length === 3 && detail(t2)[0].includes('新5'), '下一轮还能看到剩下的(从第 6 条接着来),实际 ' + JSON.stringify(detail(t2)));
check(!t2.includes('新0'), '上一轮那 5 条不重播');
check(kv('branch_log_wm.announced') === ids[7], '第二轮把剩下的走完 ⇒ 水位到 ' + ids[7]);

// 9-3) `branch_log_wm.last` 行为**一字不变**:仍推到全表最大 id(复盘模式的退出判据)
check(kv('branch_log_wm.last') === ids[7], '`.last` = 全表最大 id ' + ids[7] + '(同一时刻 announced 只到 ' + ids[4] + ')');
const pId = addLog('p0', 'p1');
check(lg.branchLogPending().pending === 1, '新增 1 笔 ⇒ 复盘待交代 1 笔(侧栏拦门判据),实际 ' + lg.branchLogPending().pending);
deliver('sess-D');
check(kv('branch_log_wm.last') === pId, '`.last` 跟到 ' + pId);
check(lg.branchLogPending().pending === 0, '器灵一开口就归零 ⇒ **复盘模式仍能正常退出**(记忆树那份守门没被 B3 破坏)');

// 9-4) 时间窗(§2):超窗只计数不展开,且**不算已示人**
const oldId = addLog('老甲', '老乙');
age(oldId, 30);
const n1 = addLog('新甲', '新乙');
const n2 = addLog('再甲', '再乙');
const t4 = deliver('sess-E');
check(!t4.includes('老乙') && !t4.includes('老甲'), '30 天前的改动**不展开**(不占注入行)');
check(detail(t4).length === 2, '只展开窗内 2 条,实际 ' + detail(t4).length);
check(fold(t4).includes('已超过 3 天'), '折叠行交代超窗笔数,实际 ' + JSON.stringify(fold(t4)));
check(kv('branch_log_wm.announced') === n2, '`announced` 只到真正示人的 ' + n2 + ',实际 ' + kv('branch_log_wm.announced'));
check(kv('branch_log_wm.retired') >= oldId, '超窗行记在 `retired`(只计数不展开),实际 ' + kv('branch_log_wm.retired'));
// 4b) **死锁构造**(已固化为回归):超窗行的 id **更大**(导入/回灌会写"旧时间戳的新行")
//     ⇒ 这一轮"可展开行 = 0"(`shownMaxId` 为 0)。两条错路在这里现形:
//     不给超窗行独立游标 ⇒ 水位永不前进、每轮重播同一行;并进 announced ⇒ 就是"没看就清"。
//     ⇒ 断言:水位不许越过它,但 `retired` 必须越过它,且下一轮(9-4c)不许重算。
const oldHigh = addLog('倒甲', '倒乙');
age(oldHigh, 30);
const t4b = deliver('sess-F');
check(kv('branch_log_wm.announced') === n2, '超窗行(id 更大)没把 `announced` 顶上去 —— **它不算已示人**,实际 ' + kv('branch_log_wm.announced'));
check(kv('branch_log_wm.retired') === oldHigh, '它只记进 `retired`,实际 ' + kv('branch_log_wm.retired'));
// ↓ 零明细 ⇒ 整段**不出现**(计数行也不再撑起它)。这条原先是「只剩计数行」,
//   2026-09-27 主人拍板后反过来钉;本条的正文仍是上面那两条水位断言(不越过 / 越过)。
check(!t4b.includes('记忆树有改动') && !t4b.includes('另有'),
  '零明细(可展开明细 = 0)⇒ 连计数行也不出现(整段不成文),实际 ' + JSON.stringify(t4b.slice(0, 120)));
const t4c = deliver('sess-G');
check(!t4c.includes('另有') && !t4c.includes('记忆树有改动'), '同一批老账不会每轮重复计数(水位确实前进了),实际 ' + JSON.stringify(t4c.slice(0, 120)));

// 9-5) 开关(§3):关闭 ⇒ 不播报、不推进"已示人"水位;`.last` 照走;再打开仍看得到
//      —— 即「开关只管渲染,不管"交代记账"」的回归(缺了它,以后有人"顺手"把 `.last`
//      也一起冻住,复盘模式会**静默卡死**在"还有 N 笔没说")
const offId = addLog('关甲', '关乙');
const beforeA = kv('branch_log_wm.announced');
const beforeH = kv('branch_log_wm.sess-H');
const t5 = deliver('sess-H', { branchLogEnabled: false });
check(!t5.includes('记忆树有改动'), '开关关闭 ⇒ 不播报,实际 ' + JSON.stringify(t5.slice(0, 120)));
check(kv('branch_log_wm.announced') === beforeA && kv('branch_log_wm.sess-H') === beforeH, '开关关闭 ⇒ **不推进任何"已示人"水位**(否则关着开着就丢一段内容)');
check(kv('branch_log_wm.last') === offId, '`.last`(复盘退出判据)照走 —— 否则复盘会卡在"还有 1 笔没交代"退不出去,实际 ' + kv('branch_log_wm.last'));
const t5b = deliver('sess-H');
check(t5b.includes('关乙'), '重新打开 ⇒ 那条改动仍在(关着的时候没被标成已读),实际 ' + JSON.stringify(t5b.slice(0, 160)));

// 9-6) B#9 的"别漏"那一半仍在,但**有意收窄**:显式 afterId=0 也不再回看已示人过的改动
check(lg.branchLogDigest({ limit: 5, afterId: 0 }).lines.length === 0, '`announced` 是全局下界 ⇒ afterId=0 不再回看已播过的(B3-1 取向的收窄)');
check(lg.branchLogDigest({ limit: 5, afterId: 10 ** 9 }).lines.length === 0, 'afterId 更大 ⇒ 同样没有可播的(下界取三者更大者)');

// 9-7) **超窗计数不许被扫描窗口封顶**(2026-09-27 实测低报 248 笔的回归)────────────
// 病根:`expired` 原先只在 rows(水位之上最早 **120** 行)里逐行累加 ⇒ 超窗行多过 120 时
// 计数**恒等于 120**,与真实存量无关。live 实测:真库 395 行、真分界 id=368
// (超窗 368 / 窗内 27),注入面却报「其中 120 笔已超过 3 天」。
// 构造要点:超窗行数(130)**必须大于扫描窗口 120** —— 否则低报根本不现形,测试是假的。
// 换**独立库**并把三个水位键按 0 起算:本条要的是"水位之上有 130 条超窗行"这个可控构型,
// 而 9-1~9-6 已经消费掉了 `lg` 的前 130 个 id(水位一旦越过它们,它们就不再参与计数)。
const dir3 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree-exp-'));
const x = new MemoryStore(join(dir3, 'exp.db'));
const deliver7 = (sid) => renderMemorySection(asm(sid), GATE, x, settingsOf());
const kv7 = (k) => Number(x.kvGet(k) || 0);
// 水位按 0 起算(且可在两段之间重置):`wm = max(会话, announced, retired)`,三者任一被
// 前面那段推上去,后面的"水位之上有多少超窗行"就不可控了 —— 构型会悄悄变空。
const wm7 = (a = 0, b = 0, c = 0) => { x.kvSet('branch_log_wm.sess-X', String(a)); x.kvSet('branch_log_wm.announced', String(b)); x.kvSet('branch_log_wm.retired', String(c)); };
wm7();
const at7 = (ms) => new Date(ms).toISOString();
const insLogAt = (at) => {
  x.db.prepare('INSERT INTO branch_log (at,branch_id,action,before_val,after_val,note,actor) VALUES (?,?,?,?,?,?,?)')
    .run(at, TRUNK_ID, 'rename', '旧', '新', '', 'user');
  return Number(x.db.prepare('SELECT MAX(id) AS m FROM branch_log').get().m);
};
// 时间账(算错这条测试就变成假的):
//   · 超窗行取 30 天前起 —— 离判定线足够远;
//   · **边界行**取 `NOW7 - 3d`,与 `branchLogDigest({now:NOW7})` 算出的 cutoff **逐毫秒相等**
//     ⇒ 直接压 `t < cutoff` 这个**严格小于**:相等必须判"窗内";
//   · 窗内行取 12 小时前(不取"0 天前"):它们必须同时在**两个时钟**下都在窗内 ——
//     显式 now 的 cutoff=NOW7-3d,而真实投递路径(`renderMemorySection`)不给 digest 传 now,
//     cutoff=Date.now()-3d(比前者晚若干毫秒)。12 小时余量让 130/131 的差**只**来自边界行。
const NOW7 = Date.now();
const CUT7 = NOW7 - 3 * 864e5;
const EX7 = 130;                                  // > 120:超窗行数必须越过扫描窗口
for (let i = 0; i < EX7; i++) insLogAt(at7(NOW7 - (30 + i) * 864e5));   // 30~159 天前
const BOUND7 = insLogAt(at7(CUT7));               // **边界行**:at 恰好 == cutoff(算窗内)
const IN7 = 15;
for (let i = 0; i < IN7; i++) insLogAt(at7(NOW7 - 12 * 36e5));          // 12 小时前(两边都窗内)
const TOTAL7 = EX7 + 1 + IN7;                     // 146
// 真值:逐行毫秒自己算(不看 expired 的实现),它是断言的分母而不是被测对象
const truth7 = (cut) => x.db.prepare('SELECT COUNT(*) AS n FROM branch_log WHERE at < ?').get(at7(cut)).n;
const truthNow = truth7(CUT7);
check(truthNow === EX7 && x.db.prepare('SELECT COUNT(*) AS n FROM branch_log').get().n === TOTAL7,
  '构型自检:超窗 ' + EX7 + ' / 边界 1 / 窗内 ' + IN7 + ',实际超窗 ' + truthNow);
// 真实投递路径自己算一遍(cutoff 取渲染时刻 ⇒ 边界行**此刻刚过 3 天**,归超窗那侧 ⇒ 131)
const renderTruth = (() => {
  const cut = Date.now() - 3 * 864e5;             // 显式 now 的时钟无法注入投递路径,只能照实算
  return { expired: truth7(cut), winStart: BOUND7 + 1 };   // 窗内行从边界行之后的第一条起
})();

// ① **真实投递路径**(renderMemorySection → snapshot → branchLogDigest):注入面文本 + 水位。
//    ↓ 这两条断言就是"**回退即红**":旧实现逐行只数扫描窗口 ⇒ 报出的永远是常数 120(上限)。
const t7 = deliver7('sess-X');
// 这一轮的形态(如实钉住,别写成"理想形态"):水位之上 1..131 全是老账,而扫描窗口只有 120 行
// ⇒ 这一轮**一条明细都排不进来**。**零明细 ⇒ 整段不渲染**(2026-09-27 主人拍板):段头与那行
// 计数都不出现 —— 旧实现把计数行 push 进 `lines`,`lines.length` 于是非零,整段靠一行
// "另有 N 笔"撑起来(主人截图:395 笔改动、一条明细也没有)。**回退即红的就是下面这两条**。
// 超窗计数"不被扫描窗口 120 封顶"的回归证据移到两处:下一行的 `retired` 水位(= 真值 131 > 120;
// 封顶时它只会是 120)与 ② 的 `d7.expired === EX7`(直连 digest、显式 now)—— 计数照算,
// 只是不再单独撑起一整段。
check(detail(t7).length === 0, '构型自检:这一轮确实一条明细都排不进来,实际 ' + detail(t7).length);
check(!t7.includes('记忆树有改动') && !t7.includes('另有'),
  '零明细(老账占满窗口)⇒ 整段不渲染:段头与计数行都不出现,实际 ' + JSON.stringify(t7.slice(0, 120)));
check(kv7('branch_log_wm.retired') === renderTruth.expired,
  '`retired` 一次越过**整段连续超窗前缀** = ' + renderTruth.expired + '(含刚过线的边界行),实际 ' + kv7('branch_log_wm.retired'));

// 9-8) **老账不许饿死明细行**(修 expired 时暴露的饥饿,与 B3-2 是同一类病):水位越过那段
//      老账之后,窗内明细必须能正常展开 —— 否则"水位卡死 + 窗口被老账占满"会让注入面
//      **永远只剩一行计数**,主人再也看不到任何改动明细(live 实测就卡在这个形态)。
//      15 条窗内行 × limit 5 ⇒ 恰好三轮走完(第 1 轮排不进明细,水位的账上面那条已经钉过)。
const t8 = deliver7('sess-X');
check(detail(t8).length === 5, '第二轮立刻能展开 5 条窗内明细(不再饿死),实际 ' + detail(t8).length);
check(detail(t8)[0].includes('旧') && detail(t8)[0].includes('新'), '展开的是真明细(改名句),实际 ' + JSON.stringify(detail(t8)[0]));
check(kv7('branch_log_wm.sess-X') === renderTruth.winStart + 4,
  '会话水位推进到真正示人的第 5 条窗内行 ' + (renderTruth.winStart + 4) + ',实际 ' + kv7('branch_log_wm.sess-X'));
const t9 = deliver7('sess-X');
check(detail(t9).length === 5, '第三轮接着展开 5 条,实际 ' + detail(t9).length);
check(kv7('branch_log_wm.sess-X') === renderTruth.winStart + 9, '水位跟到第 10 条窗内行 ' + (renderTruth.winStart + 9) + ',实际 ' + kv7('branch_log_wm.sess-X'));
const t10 = deliver7('sess-X');
check(detail(t10).length === IN7 - 10, '第四轮走完剩下的 ' + (IN7 - 10) + ' 条,实际 ' + detail(t10).length);
check(kv7('branch_log_wm.sess-X') === TOTAL7, '走到最后一条 ⇒ 会话水位 = 全表最大 id ' + TOTAL7 + ',实际 ' + kv7('branch_log_wm.sess-X'));
const t11 = deliver7('sess-X');
check(!t11.includes('记忆树有改动'), '全部交代完 ⇒ 段不再成文(不留"永远还有 N 笔"的尾巴),实际 ' + JSON.stringify(t11.slice(0, 80)));

// ② branchLogDigest 显式 now:cutoff 与边界行**逐毫秒相等** ⇒ 这几条是确定性的,不看真实时钟
wm7();                                           // 重置水位:模型①已经把它们推上去了
const d7 = x.branchLogDigest({ limit: 5, afterId: 0, now: NOW7 });
check(d7.expired === EX7, '**报出的 expired 恰等于真实超窗行数 ' + EX7 + '**,实际 ' + d7.expired);
check(d7.total === TOTAL7, '真实存量 ' + TOTAL7 + ' 笔,实际 ' + d7.total);
check(d7.expired === truthNow, 'expired 与逐行毫秒真值一致(' + truthNow + '),实际 ' + d7.expired);
check(d7.total - d7.expired === 1 + IN7,
  '**边界行(at == cutoff)被算进"窗内"而不是"超窗"**(窗内 ' + (1 + IN7) + ' 行),实际 ' + (d7.total - d7.expired));
check(d7.expired <= Math.max(0, d7.total - 5),
  'expired(' + d7.expired + ') <= pending(' + Math.max(0, d7.total - 5) + ') ⇒ Math.min 夹取不会被触发');
// 零明细那一轮:digest **仍然**产出那行计数 —— 不渲染是**渲染面**的取舍,不是把计数算丢了。
check(d7.lines.length === 1 && String(d7.lines[0]).includes('另有 ' + TOTAL7 + ' 笔改动'),
  '零明细时 digest 仍产出计数行(另有 ' + TOTAL7 + ' 笔),实际 ' + JSON.stringify(d7.lines));
check(d7.shownMaxId === 0 && d7.lines.every((x) => /^…另有 \d+ 笔改动/.test(String(x))),
  '零明细 ⇒ shownMaxId=0,且 `lines` 里**全是**计数行(渲染闸门认的就是这个),实际 '
    + d7.shownMaxId + '/' + JSON.stringify(d7.lines));
// ③ 幂等:再问一次同值(计数扫描只读,不碰任何水位)
const d7b = x.branchLogDigest({ limit: 5, afterId: 0, now: NOW7 });
check(d7b.expired === EX7 && d7b.retiredMaxId === d7.retiredMaxId && d7b.shownMaxId === d7.shownMaxId,
  '计数扫描只读:再问一次同值(实际 ' + d7b.expired + '/' + d7b.retiredMaxId + '/' + d7b.shownMaxId + ')');

// ── 9-9) **明细 0 条 ⇒ 整段不渲染**(2026-09-27 主人拍板)─────────────────────────
// 病根:计数行「…另有 N 笔改动」**也装在 `lines` 里**(memory.js 的 branchLogDigest 在明细
// 之后 push),闸门若只看 `lines.length` ⇒ 零明细时整段照样成文,注入面只剩一行不放内容的计数。
// 本节两条断言压两头:①**有明细** ⇒ 段头 / 明细 / 计数行**一个都不能少**(防"顺手把计数行
// 也删了"的过度抑制);②**零明细** ⇒ 与"没这回事"同形(段头与计数行都不出现)。
// 独立库(同 9-7 的理由):id 从 1 起、三个水位全 0,"几条明细 / 几条超窗"才算得动。
const dir4 = mkdtempSync(join(tmpdir(), 'dsh-ling-tree-zero-'));
const z = new MemoryStore(join(dir4, 'zero.db'));
const deliverZ = (sid) => renderMemorySection(asm(sid), GATE, z, settingsOf());
const kvZ = (k) => Number(z.kvGet(k) || 0);
const addZ = (before, after) => {
  z.logBranch(TRUNK_ID, 'rename', { before, after });
  return Number(z.db.prepare('SELECT MAX(id) AS m FROM branch_log').get().m);
};
const ageZ = (id, days) => z.db.prepare('UPDATE branch_log SET at = ? WHERE id = ?')
  .run(new Date(Date.now() - days * 864e5).toISOString(), id);

// ① 有明细(2 条窗内)+ 真剩余(另有 3 笔,且这 3 笔都超窗 ⇒ 括号照出)
addZ('窗甲', '窗乙');
addZ('窗丙', '窗丁');
for (let i = 0; i < 3; i++) ageZ(addZ('老' + i + '甲', '老' + i + '乙'), 30);
const tz1 = deliverZ('sess-Z1');
check(tz1.includes('【记忆树有改动】'), '有明细 ⇒ 段头在,实际 ' + JSON.stringify(tz1.slice(0, 120)));
check(detail(tz1).length === 2 && tz1.includes('窗乙') && tz1.includes('窗丁'),
  '有明细 ⇒ 明细行在(2 条),实际 ' + JSON.stringify(detail(tz1)));
check(tz1.includes('- …另有 3 笔改动(其中 3 笔已超过 3 天,只计数不展开)'),
  '有明细 ⇒ 计数行**照旧显示**(真剩余 3 笔 / 超窗 3 笔),实际 '
    + JSON.stringify(tz1.split('\n').filter((x) => x.includes('另有'))));

// ② 零明细:再积两笔**全超窗**的改动 —— 新会话的水位 = max(0, announced=2, retired=5) = 5
//    ⇒ 候选只有这两笔、且都超窗 ⇒ 可展开明细 = 0。先直连 digest 做**构型自检**
//    (digest 只读,9-7 ③ 已钉):否则"渲染面没有这段"可能是因为压根没东西可播而**假通过**。
ageZ(addZ('沉甲', '沉乙'), 30);
ageZ(addZ('沉丙', '沉丁'), 30);
const dz = z.branchLogDigest({ limit: 5, afterId: 5 });
check(dz.lines.length === 1 && dz.shownMaxId === 0 && String(dz.lines[0]).includes('另有 2 笔改动'),
  '构型自检:这一轮 digest **确实**只剩一行计数(另有 2 笔)且 shownMaxId=0,实际 '
    + dz.shownMaxId + '/' + JSON.stringify(dz.lines));
const tz2 = deliverZ('sess-Z2');
check(!tz2.includes('记忆树有改动') && !tz2.includes('另有'),
  '**零明细 ⇒ 整段不出现**(段头与计数行都没有),实际 ' + JSON.stringify(tz2.slice(0, 160)));
// 不渲染 ≠ 水位不动:那两笔老账仍被"计数式处置"越过(`.last` 是复盘退出判据,照走),
// 而"已示人"水位**不动**(没示人就是没示人)。
check(kvZ('branch_log_wm.retired') === 7 && kvZ('branch_log_wm.last') === 7,
  '零明细不渲染,但 retired / `.last` 照旧越过那两笔(到 7),实际 '
    + kvZ('branch_log_wm.retired') + '/' + kvZ('branch_log_wm.last'));
check(kvZ('branch_log_wm.announced') === 2 && kvZ('branch_log_wm.sess-Z2') === 0,
  '而"已示人"水位一字未动(announced=2 / sess-Z2=0),实际 '
    + kvZ('branch_log_wm.announced') + '/' + kvZ('branch_log_wm.sess-Z2'));

console.log(ok ? '记忆树(D9-b)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
