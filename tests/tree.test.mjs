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

console.log(ok ? '记忆树(D9-b)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
