// 记忆分枝(D9-a)单元测试:branch 表 / 会话归属 / 血缘权重(不连乘) / 枝过滤 / sessionKind 三分
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore, TRUNK_ID, LINEAGE_SAME, LINEAGE_ANCESTOR, LINEAGE_SIDE } = await imp('lib/host/memory.js');
const { sessionKind, isMemoryEligibleHeader, isTopLevelSessionHeader } = await imp('lib/host/util.js');
const { selectL1 } = await imp('lib/host/l1.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-br-'));
const db = new MemoryStore(join(dir, 'm.db'));

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 迁移:主干行自建;未登记会话默认属主干
check(db.listBranches().some((b) => b.id === TRUNK_ID && b.kind === 'trunk'), '迁移建出主干行');
check(db.branchOfSession('nobody') === TRUNK_ID, '未登记会话 → 主干');

// 2) 建枝 + 挂会话(幂等)
const brA = db.createBranch({ name: '隧道架构', kind: 'branch', parentId: TRUNK_ID, forkAt: 's-parent', forkSeq: 42 });
check(String(brA).startsWith('br:'), '枝 id 形如 br:<uuid>,实际 ' + brA);
check(db.createBranch({ id: brA, name: '别的名字' }) === brA && db.listBranches().filter((b) => b.id === brA).length === 1, '建枝幂等(同 id 不重复)');
db.setSessionBranch('s-fork', brA);
check(db.branchOfSession('s-fork') === brA, '会话挂上枝');
check(db.sessionBranchMap().get('s-fork') === brA, 'sessionBranchMap 含枝会话');

// 3) 血缘链与权重 —— 单值档位,不连乘
check(db.branchAncestors(brA).join('>') === brA + '>' + TRUNK_ID, '血缘链 枝→主干,实际 ' + db.branchAncestors(brA).join('>'));
check(db.lineageWeight(brA, brA) === LINEAGE_SAME, '同枝 = 1.0');
check(db.lineageWeight(brA, TRUNK_ID) === LINEAGE_ANCESTOR, '枝读主干(祖先) = 0.7');
check(db.lineageWeight(TRUNK_ID, brA) === LINEAGE_SIDE, '主干读枝 = 0.4');
const brB = db.createBranch({ name: '深枝', parentId: brA });
check(db.lineageWeight(brB, TRUNK_ID) === LINEAGE_ANCESTOR, '深枝读主干仍 0.7(不随深度衰减,避开 0.7^n 塌缩)');
check(db.lineageWeight(brA, brB) === LINEAGE_SIDE, '枝读子枝 = 0.4');
const wm = db.lineageWeightMap(brB);
check(wm.get(brB) === LINEAGE_SAME && wm.get(brA) === LINEAGE_ANCESTOR && wm.get(TRUNK_ID) === LINEAGE_ANCESTOR, '权重映射:自己1.0 / 父0.7 / 主干0.7');

// 4) 枝过滤(dsweb 等非 dsh 源恒属主干)
db.upsertOverview({ source: 'dsh', conv_id: 's-parent', title: '主干会话', category: 'daily', summary: '主干的内容在这', overview_ok: true });
db.upsertOverview({ source: 'dsh', conv_id: 's-fork', title: '枝里的会话', category: 'daily', summary: '枝里的内容在这', overview_ok: true });
db.upsertOverview({ source: 'dsweb', conv_id: 'w1', title: '网页历史', category: 'knowledge', overview_ok: true });
const rf = db.queryOverviews({ branch: brA });
check(rf.total === 1 && rf.items[0].conv_id === 's-fork', '枝过滤只出该枝会话,实际 ' + rf.total);
check(db.queryOverviews({ branch: TRUNK_ID }).total === 2, '主干过滤:非 dsh 源也算主干');
const bc = db.branchCounts();
check(bc.byBranch[TRUNK_ID] === 2 && bc.byBranch[brA] === 1, 'branchCounts 分档,实际 ' + JSON.stringify(bc.byBranch));

// 5) sessionKind 三分:主人的分叉(fork)与子代理(subagent)必须分开
check(sessionKind({ parentSession: 'p' }) === 'fork', 'parentSession → fork');
check(sessionKind({ origin: 'subagent' }) === 'subagent', 'origin=subagent → subagent');
check(sessionKind({ delegationDepth: 1 }) === 'subagent', 'delegationDepth → subagent');
check(sessionKind({}) === 'top', '{} → top');
check(sessionKind({ parentSession: 'p', origin: 'subagent' }) === 'subagent', 'subagent 优先于 fork');
check(sessionKind(null) === 'unknown', 'null → unknown');
check(isTopLevelSessionHeader({ parentSession: 'p' }) === false, 'fork 不是 top(旧语义保留)');
check(isMemoryEligibleHeader({ parentSession: 'p' }) === true, 'fork 可入库(D9-a 核心变更)');
check(isMemoryEligibleHeader({ origin: 'subagent' }) === false, 'subagent 仍不可入库');
check(isMemoryEligibleHeader({}) === true, '顶层会话可入库');

// 6) L1 血缘加权:枝里读自己的记忆 1.0、读主干 0.7
db.bumpHit('dsh', 's-fork');
db.bumpHit('dsh', 's-parent');
const inFork = selectL1(db, { mode: 'work', sessionId: 's-fork' });
const fFork = inFork.items.find((i) => i.conv_id === 's-fork');
const fTrunk = inFork.items.find((i) => i.conv_id === 's-parent');
check(!!fFork && fFork.lineage === LINEAGE_SAME, '在枝里:自己的记忆 lineage=1.0');
check(!!fTrunk && fTrunk.lineage === LINEAGE_ANCESTOR, '在枝里:主干记忆 lineage=0.7');
check(!!fFork && fFork.score === +(Number(fFork.raw) * 1.0).toFixed(3), 'score = raw × 血缘(1.0 档)');
const noSid = selectL1(db, { mode: 'work' });
check(noSid.items.every((i) => i.lineage === 1), '不传 sessionId 时档位恒为 1(不加权,旧调用点行为不变)');

console.log(ok ? '记忆分枝(D9-a)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
