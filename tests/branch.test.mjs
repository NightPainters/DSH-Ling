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

// ============================================================================
// 7) 主脉提炼候选链 —— C-06/E2(单实例锁)· A-06(悬空候选)· A-12(定名锁)· E9(中文 message)
//    (1.5.1 红蓝对抗)
// ----------------------------------------------------------------------------
// 这一节驱动**真实的 HTTP 处理器**(registerApi + 假 webServer),而不是只调 memory 函数:
// 四条里三条的落点在 api.js 的**端点层** —— 只调底层函数证明不了。例如「C-06 没有锁」这件事,
// 必须由"第二个并发请求真的被挡回 busy"来证明,而不是"代码里出现了 batchEnter"。
// ============================================================================
const { registerApi } = await imp('lib/host/api.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { EventEmitter } = await import('node:events');
process.env.DSH_LING_GUARD = 'off'; // 栅栏不是本节要验的东西(guard.test.mjs 另有专测)
const settings = new SettingsFile(join(dir, 'set')); // guardVerdict 会读 settings.get()(即便开关是 off)
const routes = new Map();
const fakeServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
const gateStub = {
  snapshotIds: () => [], snapshotOf: () => null, isRunning: () => false,
  pendingCount: () => 0, recentSessionId: () => null, markSnapStale: () => {},
};
registerApi({ get: (n) => (n === 'webServer' ? fakeServer : undefined) }, { gate: gateStub, memory: db, settings }, {});

/** 假请求:req 用 EventEmitter 顶(readBody 只监听 data/end/error),res 收集状态码与响应体。
 *  `hold:true` = **只发请求、不发 body** ⇒ 处理器停在 `await readBody` 上、锁被真实持有 ——
 *  这样不必真调模型就能制造出"正在提炼中"的那一刻。 */
const fire = (path, body, { hold = false } = {}) => {
  const handler = routes.get('/api/dsh-ling' + path);
  if (typeof handler !== 'function') throw new Error('路由没挂上:' + path);
  const req = new EventEmitter();
  req.url = path; req.method = 'POST';
  req.headers = { host: '127.0.0.1:3080' };
  const out = { status: 0, body: null };
  const res = {
    setHeader() {},
    end(payload) {
      out.status = this.statusCode;
      try { out.body = JSON.parse(String(payload ?? '{}')); } catch { out.body = null; }
    },
  };
  const done = handler(req, res);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const send = () => { req.emit('data', Buffer.from(payload)); req.emit('end'); };
  if (!hold) send();
  return { out, done, send };
};
const call = async (path, body) => { const f = fire(path, body); await f.done; return f.out; };

// 7.1 C-06(服务端那一端)/ E2(界面那一端):提炼的单实例锁
{
  const held = fire('/vein/distill', {}, { hold: true }); // ① 抢到锁后停住(body 还没来)
  const second = await call('/vein/distill', { veinId: 'vein:nobody' });
  check(second.body && second.body.ok === false && second.body.reason === 'busy',
    'C-06:提炼进行中,第二个并发请求被单实例锁挡回 busy(实际 ' + JSON.stringify(second.body) + ')');
  check(second.status === 200, 'C-06:busy 仍是 200(不破坏既有回应语义)');
  check(!!(second.body && second.body.hint), 'C-06:busy 带中文 hint(与 judge/name 逐字同形)');
  held.send();                                            // ② 放行第一个请求
  await held.done;
  check(held.out.status === 400 && held.out.body && held.out.body.reason === 'no-vein',
    'C-06:放行后第一个请求照常走原路径(空 body → 400 no-vein),锁没有改掉它的语义');
  const third = await call('/vein/distill', { veinId: 'vein:nobody' });
  check(!!(third.body && third.body.reason !== 'busy'),
    'C-06:锁在 finally 里释放(第三个请求不再 busy,而是 404 vein-not-found,实际 ' + JSON.stringify(third.body) + ')');
}

// 7.2 A-06:候选指向的主脉已被删除 ⇒ 采纳**不得**回 ok,且一个字节都不写库
const vGone = db.createBranch({ name: '会被删掉的主脉', kind: 'vein', parentId: TRUNK_ID });
const sgGone = db.addVeinSuggestion({ veinId: vGone, text: '这条候选的结论:先看判据,再看回执。', sources: ['dsh/s1'], model: 'global', note: '测试' });
check(sgGone.ok && sgGone.id > 0, 'A-06 前置:候选入库 #' + sgGone.id);
check(db.deleteBranch(vGone, { force: true }).ok, 'A-06 前置:主脉被删掉(候选悬空)');
check(!db.listBranches().some((b) => b.id === vGone), 'A-06 前置:枝表里确实没有这条主脉了');
{
  const adopted = await call('/vein/suggestion/resolve', { id: sgGone.id, action: 'accept' });
  check(adopted.body && adopted.body.ok === false,
    'A-06:悬空候选采纳**不再谎报 ok**(实际 ' + JSON.stringify(adopted.body) + ')');
  check(adopted.body && adopted.body.reason === 'vein-not-found',
    'A-06:reason=vein-not-found(与 /vein/distill 同一文案口径)');
  check(!!(adopted.body && adopted.body.message) && /主脉已被删除/.test(String(adopted.body.message)),
    'A-06:带中文 message(与 E9 同批)');
  check(adopted.body && adopted.body.branchId === undefined,
    'A-06:回执里不再出现"我没写进去的 branchId"');
  check(db.overviewById('vein', vGone) === undefined, 'A-06:悬空候选**没有**写出主脉记忆');
  check(db.listVeinSuggestions({ status: 'new', veinId: vGone }).length === 1, 'A-06:候选仍在待审核队列里(没被动过)');

  // ★ 负对照:直接把底层函数拎出来调一次,证明**谎报仍在**(修的是端点层的判据;
  //   memory.js 里 assignConv 吞掉 no-branch 那一处归另一批 —— 见报告)。把机制钉在测试里,
  //   免得将来有人"顺手"把端点层那道门当成冗余删掉。
  const sgRaw = db.addVeinSuggestion({ veinId: vGone, text: '负对照用的候选', sources: [], model: 'global' });
  const raw = db.resolveVeinSuggestion(sgRaw.id, { action: 'accept' });
  check(raw.ok === true && raw.branchId === vGone,
    '★负对照:底层 resolveVeinSuggestion 对悬空主脉仍回 ok:true + branchId=已删枝(所以判据必须补在端点层)');
  check(db.branchOfConv('vein', vGone) !== vGone, '★负对照:而归属其实**没落库**(assignConv 吞掉了 no-branch)');
}

// 7.2b 源码护栏:锁必须抢在 `readBody` **之前**(这是整条修复的命门)
//   —— 放到 await 之后就等于没上锁(两个并发请求都能先读完 body 再一起冲进模型调用)。
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const at = src.indexOf("register('/vein/distill'");
  const enter = src.indexOf("batchEnter('distill')", at);
  const readBodyAt = src.indexOf('readBody(req)', at);
  const leave = src.indexOf("batchLeave('distill')", at);
  check(at > 0 && enter > at, 'C-06:端点里确实抢了 distill 单实例锁');
  check(enter > 0 && readBodyAt > 0 && enter < readBodyAt, 'C-06:锁抢在 readBody 之前(同 tick 原子)');
  check(leave > enter, 'C-06:释放点在抢锁点之后(finally 里成对出现)');
  check(/BATCH_MS = \{ judge: 120000, name: 300000, distill: 180000 \}/.test(src), 'C-06:总时长上限登记进 BATCH_MS(与 judge/name 同表)');
}

// 7.3 正对照:主脉还在时候选照常采纳,且归属**真的**落库(A-06 的判据不许误杀正常路径)
const vAlive = db.createBranch({ name: '活着的主脉', kind: 'vein', parentId: TRUNK_ID });
const sg1 = db.addVeinSuggestion({ veinId: vAlive, text: '第一版结论:归纳要能被追溯。', sources: [], model: 'global' });
{
  const ok1 = await call('/vein/suggestion/resolve', { id: sg1.id, action: 'accept' });
  check(ok1.body && ok1.body.ok === true && ok1.body.status === 'accepted', 'A-06 正对照:主脉存在时采纳照常成功');
  check(ok1.body && ok1.body.assigned === true, 'A-06:回执带 assigned:true(新增字段,既有字段一个没动)');
  check(db.branchOfConv('vein', vAlive) === vAlive, 'A-06:归属**真的**落进 conv_branch(不是回执说了算)');
}

// 7.4 A-12:主人手改过名字(title_locked=1)的主脉记忆,再次采纳会换掉**正文** —— 必须"说出来"
//     「锁」的语义(DESIGN.md)是"锁住自动重写、不锁主人" ⇒ 端点**不**扩权去挡主人的显式采纳,
//     但必须把"名字是你的、正文被换了、旧版去哪了"如实回报(此前只回一个 replaced,界面零提示)。
check(db.renameTitle('vein', vAlive, '我给这条起的名').ok, 'A-12 前置:主人手改名(上锁 title_locked=1)');
const sg2 = db.addVeinSuggestion({ veinId: vAlive, text: '第二版结论:判据要落在存在性上,而不是回执上。', sources: [], model: 'global' });
{
  const ok2 = await call('/vein/suggestion/resolve', { id: sg2.id, action: 'accept' });
  check(ok2.body && ok2.body.ok === true, 'A-12:采纳本身仍成功(不把锁扩权成"挡主人")');
  check(db.overviewById('vein', vAlive).title === '我给这条起的名', 'A-12:已定名的名字保持不动(锁的既有作用面不变)');
  check(String(db.overviewById('vein', vAlive).summary).includes('第二版结论'), 'A-12:正文确实被换掉了(这才是有话要说的地方)');
  check(!!(ok2.body && ok2.body.naming) && ok2.body.naming.title === '我给这条起的名' && ok2.body.naming.titleBy === 'user',
    'A-12:回执如实回报"名字已定过(主人手改)"(实际 ' + JSON.stringify(ok2.body && ok2.body.naming) + ')');
  check(!!(ok2.body && ok2.body.message) && String(ok2.body.message).includes('我给这条起的名'),
    'A-12/E10:带中文 message 说清"名字不动、正文换了"(实际 ' + JSON.stringify(ok2.body && ok2.body.message) + ')');
  check(!!(ok2.body && ok2.body.replaced && ok2.body.replaced.dir), 'A-01/E10:回执仍带 replaced.dir(旧版已归档,前端据此提示)');
}

// 7.5 E9:失败时把英文内部码译成中文;`ok` / `reason` 逐字兼容(前端可能仍在读 reason)
{
  const noId = await call('/vein/suggestion/resolve', { id: 999999, action: 'accept' });
  check(noId.body && noId.body.ok === false && noId.body.reason === 'not-found',
    'E9:未知 id 仍是 ok:false + reason=not-found(兼容第一)');
  check(!!(noId.body && noId.body.message) && /不存在/.test(String(noId.body.message)),
    'E9:not-found 带中文 message(实际 ' + JSON.stringify(noId.body && noId.body.message) + ')');
  const badAct = await call('/vein/suggestion/resolve', { id: sg1.id, action: 'adopt' });
  check(badAct.body && badAct.body.ok === false && badAct.body.reason === 'bad-action', 'E9:非法动作仍是 bad-action');
  check(!!(badAct.body && badAct.body.message) && /采纳/.test(String(badAct.body.message)),
    'E9:bad-action 带中文 message(实际 ' + JSON.stringify(badAct.body && badAct.body.message) + ')');
  const empty = await call('/vein/suggestion/resolve', { id: sg1.id, action: 'accept', text: '   ' });
  check(empty.body && empty.body.ok === false && empty.body.reason === 'empty-text', 'E9:空正文仍是 empty-text');
  check(!!(empty.body && empty.body.message) && String(empty.body.message).length > 0,
    'E9:empty-text 带中文 message(实际 ' + JSON.stringify(empty.body && empty.body.message) + ')');
  check(empty.body && !/empty-text/.test(String(empty.body.message)), 'E9:message 里不再出现英文内部码');
}
delete process.env.DSH_LING_GUARD;

console.log(ok ? '记忆分枝(D9-a + 主脉候选链)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
