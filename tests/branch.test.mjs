// 记忆分枝(D9-a)单元测试:branch 表 / 会话归属 / 血缘权重(不连乘) / 枝过滤 / sessionKind 三分
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
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
// 7.6 POST_ONLY 补三条(1.5.3 —— 主会话校正:本批未发布,不是 1.5.4;2026-09-29 夜;依据 plans\AUDIT-dsh-ling-1.5.3-端点写面-未进POST_ONLY.md):
//     `/branch-log/pending`(差集里**唯一一条真写** —— 会一次性补种水位)、`/persona/draft`(GET 就能花一次
//     模型额度)、`/persona/check`(handler 读 body,形态已像 POST)。这里驱动**真实端点**验两件事:
//     GET ⇒ 405 且 `want:'POST'`;POST ⇒ 走到正常分支(不是被方法闸拦下的)。
//     ⚠️ 上面 `fire()` 把 method 硬编码成 POST(7.1 的并发锁要用它),所以另开一个可指定方法的旁路 ——
//     改 `fire` 本身会动到既有断言的共用装台。
const fireAs = (method, path) => {
  const handler = routes.get('/api/dsh-ling' + path);
  if (typeof handler !== 'function') throw new Error('路由没挂上:' + path);
  const req = new EventEmitter();
  req.url = path; req.method = method;
  req.headers = { host: '127.0.0.1:3080' };
  const out = { status: 0, body: null };
  const res = {
    setHeader() {},
    end(payload) {
      out.status = this.statusCode;
      try { out.body = JSON.parse(String(payload ?? '{}')); } catch { out.body = null; }
    },
  };
  // 真发一个空 body:被闸挡下的请求不会再读它(读 body 的 promise 自己收尾),
  // 而**万一**哪天方法闸被挪到 readBody 之后,这里能立刻拿到 405(而不是卡到 30s 排空闸)。
  const send = () => { req.emit('data', Buffer.from('')); req.emit('end'); };
  return { out, done: handler(req, res), send };
};
const postOnlyNow = ['/branch-log/pending', '/persona/draft', '/persona/check'];
for (const p of postOnlyNow) {
  const g = fireAs('GET', p); // 方法闸同步执行、先于 handler 里任何 await ⇒ 此刻状态码已定
  check(g.out.status === 405, 'POST_ONLY:GET ' + p + ' 被挡回 405(实际 ' + g.out.status + ')');
  check(!!(g.out.body && g.out.body.error === 'method-not-allowed' && g.out.body.want === 'POST'),
    'POST_ONLY:GET ' + p + ' 的 405 带 method-not-allowed/want:POST(实际 ' + JSON.stringify(g.out.body) + ')');
  check(g.out.status !== 0, 'POST_ONLY:GET ' + p + ' 的拒绝在"body 还没到"时就已发出(方法闸先于 readBody)');
  g.send();
  await g.done;
}
{
  const d = await call('/persona/draft', {});
  check(d.status !== 405, 'POST /persona/draft 没被方法闸拦(实际 ' + d.status + ')');
  check(!!d.body && d.body.ok === false && d.body.reason === 'llm',
    'POST /persona/draft 走到 handler 正常分支(无 llm 服务 ⇒ ok:false + reason=llm;实际 ' + JSON.stringify(d.body) + ')');
  const b = await call('/branch-log/pending', {});
  check(b.status !== 405 && b.body && b.body.ok === true && typeof b.body.pending === 'number',
    'POST /branch-log/pending 走到 handler 正常分支(实际 ' + b.status + ' ' + JSON.stringify(b.body) + ')');
  const c = await call('/persona/check', { unlock: 'x' });
  check(c.status !== 405 && c.body && c.body.ok === true,
    'POST /persona/check 走到 handler 正常分支(实际 ' + c.status + ' ' + JSON.stringify(c.body) + ')');
}

// 7.7 客户端护栏(源码级,防止"服务端进 POST_ONLY、前端仍打 GET"这种静默 405 回归):
//     先把 `//` 注释行整行剥掉再匹配 —— 否则注释里那句「`/branch-log/pending` 的 pending 就是…」会误命中。
{
  const { readFileSync } = await import('node:fs');
  const srcRaw = readFileSync(join(root, 'lib/client.js'), 'utf8').split('\n');
  const srcNoLine = srcRaw.map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  for (const p of postOnlyNow) {
    const apiCall = new RegExp("api\\('" + p.replace(/[/-]/g, (m) => '\\' + m) + "'\\s*,\\s*\\{[^}]*method\\s*:\\s*'POST'");
    check(apiCall.test(srcNoLine), 'V3 客户端护栏:client.js 里 api(\'' + p + '\') 显式带 method:\'POST\'');
  }
  const bareCount = (srcNoLine.match(/api\('\/branch-log\/pending'\)/g) || []).length;
  check(bareCount === 0, 'V3 客户端护栏:client.js 里没有"裸 GET"形态的 api(\'/branch-log/pending\')(实际 ' + bareCount + ' 处)');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 7.8 手术门 · 端点级(2026-09-30 深夜;PLAN-手术门-实施 §1.1–§1.3 / §3 验收判据 V1+V2)
// -------------------------------------------------------------------------------------------
// 为什么要**另起一套装台**:7.1–7.7 那套把 `DSH_LING_GUARD` 设成 'off'(栅栏不是那一节要验的东西),
// 而 'off' 正是手术门的**逃生开关**(§1.5)⇒ 拿那套装台测手术门 = 门被整体放行,测了个寂寞。
// 故本节自建:守卫**开着**(真 `guardVerdict`),`DSH_HOME` 指向临时目录(票据/留痕都不落真机)。
// 判据(改前 → 改后):
//   · 带 `x-forwarded-for` 打手术端点 ⇒ 拒且 `surgery === 'surgery-local-only'`(**这是 (a) 的命门**);
//   · 本机无票据 ⇒ `surgery-ticket`;本机 + 票据 + 原句 ⇒ 放行;
//   · 原句错 ⇒ `surgery-phrase`;**`wantLock` 绕过不再成立**(旧代码下这一条应红);
//   · **未 sealed ⇒ 行为与现状逐字一致**(负对照);逃生开关两条各一条。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const sHome = mkdtempSync(join(tmpdir(), 'dsh-ling-surgery-'));
  process.env.DSH_HOME = sHome;
  // ⚠️ 环境变量优先于设置:逃生开关是 `DSH_LING_GUARD==='off' || settings.guard.enforce===false`,
  //    而本文件开头把环境变量设成了 'off' ⇒ **只覆写 settings 视图不够**(第一版就是这么被整体放行的)。
  //    故本节临时清掉它(段末恢复);`delete` 之后各段独立进程,不会牵动 7.1–7.7 的既有语义。
  delete process.env.DSH_LING_GUARD;
  const { expectedCookieName } = await imp('lib/host/guard.js');
  const ProxyAuthority = 'ling.example.com';        // 主人真机上的反代入口(等价配置)
  const cookieOf = (authority) => ({ cookie: expectedCookieName(authority) + '=1' });
  // ⚠️ 2026-10-01 晚:本机判据已加强为「无代理头 **且 带 UA**」⇒ `LOCAL` 必须**如实长成本机浏览器的样子**
  //    (带 UA)。这不是为了让测试变绿:加强之前,本节所有"本机"腿都**没有 UA** —— 也就是说
  //    它们自己正是被修的那一类请求(中继重建的头也长这样)。补上 UA 后,`LOCAL` 才是真·本机浏览器。
  const UA_LOCAL = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
  const LOCAL = { host: '127.0.0.1:3080', 'user-agent': UA_LOCAL, ...cookieOf('127.0.0.1:3080') };
  const PROXY = { host: ProxyAuthority, ...cookieOf(ProxyAuthority), 'x-forwarded-for': '203.0.113.9' };
  /** 远端面板那条路的**真实指纹**:中继重建请求头 ⇒ 无代理头、无 Origin、**无 UA**。
   *  ⚠️ 用**符号**标记而不是对象同一性:V2' 要测"连票据都拿到了"的最坏情况,那一刻头对象是
   *     `{...RELAY, ...tk}`(**新对象**)⇒ 若按 `=== RELAY` 判断,它会退回叠法、**静默继承本机 UA**,
   *     断言就永远是绿的假绿(第一版正是这么写的)。符号跟着对象走,叠不出错。 */
  const RELAY_MARK = Symbol('relay-shaped-request');
  const RELAY = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...cookieOf('127.0.0.1:3080') };
  /** 远端中继形请求头(**整份替换**,不继承 LOCAL 的 UA);需再叠票据时用这个包一层。 */
  const relayHeaders = (extra) => ({ ...RELAY, ...(extra || {}), [RELAY_MARK]: true });
  const PHRASE = '这是我在定型时亲手写下的承诺句。';

  const sSet = new SettingsFile(join(sHome, 'set'));
  await sSet.update({ guard: { trustedHosts: [ProxyAuthority] } });   // 让"经代理"这一路能过守卫(才轮得到手术门判)
  await sSet.update({ persona: { sealed: true, sealPhrase: PHRASE, aiName: '器灵' } });
  // ⚠️ 本文件开头把 `DSH_LING_GUARD` 设成了 'off'(7.1–7.7 不需要栅栏),而 'off' 正是手术门的**逃生开关**
  //    ⇒ 若不处理,本节每一条都会被整体放行(第一版就是这么被喂成"门漏了"的假红/假绿)。
  //    这里**不改环境变量**(那会连带改掉 7.1–7.7 的既有语义),而是给本节一套 settings 视图:
  //    在真 SettingsFile 之上覆写 `guard.enforce = true` —— 逃生开关只在"显式关掉"时放行。
  //    用 Proxy 而不是手写对象:端点还会调 `settings.update()` 等**别的**方法,
  //    手写对象会把它们漏掉(第一版就是这么把端点打成 "settings.update is not a function" 的)。
  const sView = new Proxy(sSet, {
    get(target, prop, recv) {
      if (prop === 'get') {
        return () => {
          const base = target.get();
          return { ...base, guard: { ...(base.guard || {}), enforce: true } };
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const sRoutes = new Map();
  const sServer = { register: (r) => { sRoutes.set(r.path, r.handler); return () => sRoutes.delete(r.path); } };
  // 留痕指向**本节专属**的临时文件:否则"链是否完好"会被上一段测试(或真机历史)留下的旧行干扰。
  const sLog = join(sHome, 'surgery-test.jsonl');
  registerApi({ get: (n) => (n === 'webServer' ? sServer : undefined) }, { gate: gateStub, memory: db, settings: sView }, { surgeryLog: sLog });

  /** 与 7.1 的 fire 同形,只多一个 headers 注入口(默认本机)。
   *  路由**没挂上**时不抛,而是合成一个 404 回执:双向验证(把改动前的实现换回来跑)时
   *  `/surgery/ticket` 压根不存在 —— 那时应当**逐条断言打红**(看得到红在哪几条),
   *  而不是整个文件停在这一行("路由没挂上"等于什么都没验,还看不到下文)。 */
  const sFire = (path, body, headers) => {
    const handler = sRoutes.get('/api/dsh-ling' + path);
    if (typeof handler !== 'function') {
      return { out: { status: 404, body: { error: 'route-not-mounted', path } }, done: Promise.resolve() };
    }
    const req = new EventEmitter();
    req.url = path; req.method = 'POST';
    // §7.8 的叠法保持不变(既有语义零改动);带 RELAY_MARK 的那一路走**整份替换** ——
    // 理由见 V2' 的注释(中继是**重建**请求头,不是往本机头上叠几个字段)。
    req.headers = headers && headers[RELAY_MARK] ? { ...headers } : { ...LOCAL, ...(headers || {}) };
    delete req.headers[RELAY_MARK];
    const out = { status: 0, body: null };
    const res = {
      setHeader() {},
      end(payload) {
        out.status = this.statusCode;
        try { out.body = JSON.parse(String(payload ?? '{}')); } catch { out.body = null; }
      },
    };
    const done = handler(req, res);
    const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('data', Buffer.from(payload)); req.emit('end');
    return { out, done };
  };
  const sCall = async (path, body, headers) => { const f = sFire(path, body, headers); await f.done; return f.out; };
  /** 手术拒的**统一形状**:`surgery` 字段说真因,`reason:'sealed'` 保持既有客户端分支可用。 */
  const denyReason = (o) => (o.body && o.body.surgery) || '(无 surgery 字段:' + JSON.stringify(o.body) + ')';

  // ── V2 票据:带代理头取票 ⇒ 拒;本机取 ⇒ 得到 64 位十六进制 ──────────────────────
  const tRemote = await sCall('/surgery/ticket', {}, PROXY);
  check(tRemote.status === 403 && tRemote.body && tRemote.body.reason === 'surgery-local-only',
    'V2 经代理取票 ⇒ 403 surgery-local-only(实测 ' + tRemote.status + ' ' + JSON.stringify(tRemote.body) + ')');
  const tLocal = await sCall('/surgery/ticket', {}, {});
  const TICKET = tLocal.body && tLocal.body.ticket;
  check(tLocal.status === 200 && /^[0-9a-f]{64}$/.test(String(TICKET)),
    'V2 本机取票 ⇒ 200 + 64 位十六进制(实测长度 ' + String(TICKET || '').length + ')');
  const tk = { 'x-dsh-ling-surgery': TICKET };

  // ── ★V2' **远端面板那条路**(2026-10-01 晚新增;就是本次修的那条)─────────────────────
  //   真实链路:远端浏览器 → nginx:8443 → frpc → 宿主内 remote-web-ui 中继 → 127.0.0.1:3080。
  //   中继(loopback-proxy.ts pipeLoopbackHttp)**重建**请求头:改写 Host、合成 `sec-fetch-site: same-origin`、
  //   丢掉 Origin / UA / XFF ⇒ 在中继之后看,它**既没有代理头、也没有 Origin**,与真本机同形。
  //   ⚠️ 中继是**重建**、不是"改几个字段" ⇒ 这一路必须**整份替换**请求头(不是往 LOCAL 上叠):
  //     本文件原来的 sFire 是 `{...LOCAL, ...headers}`,而 LOCAL 带 UA —— 若沿用叠法,
  //     中继那一路会**继承本机的 UA**,这两条断言就永远是绿的假绿(第一版就是这么写的,被 sCall 打出 200 才现形)。
  //   `{...RELAY, ...tk}` 是"**连票据都拿到了**"的最坏情况(票据本不该发给它)。
  //   ⚠️ 修前这两条必红(旧判据只看代理头 ⇒ 判成本机 ⇒ 放行);这就是 V1 第二态在端点级的形态。
  const tRelay = await sCall('/surgery/ticket', {}, relayHeaders());
  check(tRelay.status === 403 && tRelay.body && tRelay.body.reason === 'surgery-local-only',
    '★V2\' 远端中继形请求(无代理头、无 UA)取票 ⇒ 403 surgery-local-only(实测 ' + tRelay.status + ' ' + JSON.stringify(tRelay.body) + ')');
  //   ⚠️ 这里打 `/persona/check`(本段 7.8 自己 registerApi 挂上的写面)而不是 `/persona`:
  //     `sRoutes` 是 Map,同一进程里**后 register 的同路径会覆盖前一段的** ⇒ `/persona` 在本段拿到的是
  //     7.1–7.7 那段留下的处理器(不过手术门),打它会得到"看起来像放行"的假红(实测 ok:true + affected:[])。
  const rRelay = await sCall('/persona/check', { unlock: PHRASE }, relayHeaders(tk));
  check(denyReason(rRelay) === 'surgery-local-only',
    '★V2\' 远端中继形请求(票据对、原句也对)打手术端点 /persona/check ⇒ 拒 surgery-local-only(实测 ' + denyReason(rRelay) + ')');

  // ── V1 端点级(全部打真端点 /persona;判据在 surgery.js 一处)───────────────────
  const patchTo = (name) => ({ patch: { persona: { aiName: name } }, unlock: PHRASE });

  const rProxy = await sCall('/persona', patchTo('远端想改的名字'), { ...PROXY, ...tk });
  check(denyReason(rProxy) === 'surgery-local-only',
    '★V1 (a) 命门:带 XFF 打手术端点(**票据对、原句也对**)⇒ 拒 surgery-local-only(实测 ' + denyReason(rProxy) + ')');
  check(rProxy.body && rProxy.status === 200, 'V1 拒绝仍是 200 + reason:sealed(不动既有客户端分支;实测 ' + rProxy.status + ')');

  const rNoTicket = await sCall('/persona', patchTo('无票想改的名字'), {});
  check(denyReason(rNoTicket) === 'surgery-ticket', 'V1 本机无票据 ⇒ 拒 surgery-ticket(实测 ' + denyReason(rNoTicket) + ')');

  const rBadTicket = await sCall('/persona', patchTo('错票想改的名字'), { 'x-dsh-ling-surgery': 'deadbeef'.repeat(8) });
  check(denyReason(rBadTicket) === 'surgery-ticket', 'V1 本机错票据 ⇒ 拒 surgery-ticket(实测 ' + denyReason(rBadTicket) + ')');

  const rBadPhrase = await sCall('/persona', { patch: { persona: { aiName: '错句想改的名字' } }, unlock: '根本不是那句承诺句' }, tk);
  check(denyReason(rBadPhrase) === 'surgery-phrase', 'V1 本机 + 票据 + **原句错** ⇒ 拒 surgery-phrase(实测 ' + denyReason(rBadPhrase) + ')');

  // ★wantLock 绕过(侦察 F9):旧代码里"带 sealed:true 的补丁"排在验句之前 ⇒ 随便给一句就过。
  const rWantLock = await sCall('/persona', { patch: { persona: { sealed: true, aiName: '靠 wantLock 改的名字' } }, unlock: '随便一句根本不是原文的句子' }, tk);
  check(denyReason(rWantLock) === 'surgery-phrase',
    '★V1 wantLock 绕过**不再成立**(旧代码下这条应红;实测 ' + denyReason(rWantLock) + ')');

  const rPass = await sCall('/persona', patchTo('本机该改成的名字'), tk);
  check(rPass.status === 200 && rPass.body && rPass.body.ok === true, 'V1 本机 + 票据 + 原句对 ⇒ 放行(实测 ok=' + (rPass.body && rPass.body.ok) + ')');
  check(sSet.get().persona.aiName === '本机该改成的名字', 'V1 放行那次**真的落库**(aiName 实测 ' + sSet.get().persona.aiName + ')');
  check(sSet.get().persona.aiName !== '远端想改的名字' && sSet.get().persona.aiName !== '无票想改的名字'
    && sSet.get().persona.aiName !== '错票想改的名字' && sSet.get().persona.aiName !== '靠 wantLock 改的名字'
    && sSet.get().persona.aiName !== '错句想改的名字',
    '★V1 五次被拒**一个字节都没写库**(落库只发生了放行那一次 ⇒ 拒不是"拒了但已经改了")');

  // 覆盖面:其余写面同一条判据(经代理 ⇒ 一律 surgery-local-only)
  for (const [p, b] of [
    ['/persona/check', { unlock: PHRASE }],
    ['/persona/self-summary', { text: '远端想改的自述' }],
    ['/persona/hint-adopt', { text: '远端想落的习惯' }],
    ['/persona/rule', { action: 'add', rule: '远端想加的规矩', quote: '远端说的' }],
    ['/persona/habit', { action: 'propose', habit: '远端想提的习惯' }],
    ['/persona/grow', { tone: { default: 'playful' } }],
    ['/persona/rollback', { ts: 1 }],
    ['/feedback/apply', { id: 1 }],
    ['/suggestions/apply', { id: 1 }],
    ['/import', JSON.stringify({ bundle: { items: [] } })],
  ]) {
    const o = await sCall(p, b, { ...PROXY, ...tk });
    check(denyReason(o) === 'surgery-local-only', 'V1 覆盖面:经代理打 ' + p + ' ⇒ 拒(实测 ' + denyReason(o) + ')');
  }
  const oLocalCheck = await sCall('/persona/check', { unlock: PHRASE }, tk);
  check(oLocalCheck.body && oLocalCheck.body.ok === true, 'V1 覆盖面正对照:本机带票打 /persona/check ⇒ 照常(实测 ' + JSON.stringify(oLocalCheck.body) + ')');

  // ── V1 负对照:未 sealed ⇒ 行为与现状**逐字一致** ────────────────────────────────
  const rUnseal = await sCall('/persona', { patch: { persona: { sealed: false } }, unlock: PHRASE }, tk);
  check(rUnseal.body && rUnseal.body.ok === true && sSet.get().persona.sealed === false, 'V1 负对照前置:撤锁成功(sealed 实测 ' + sSet.get().persona.sealed + ')');
  const rOpenRemote = await sCall('/persona', { patch: { persona: { aiName: '未定型时远端也能改' } }, unlock: '随便一句' }, PROXY);
  check(rOpenRemote.body && rOpenRemote.body.ok === true && sSet.get().persona.aiName === '未定型时远端也能改',
    '★V1 负对照:未 sealed ⇒ **经代理也照常放行**(行为与现状逐字一致 —— 门根本没进;实测 aiName=' + sSet.get().persona.aiName + ')');

  // ── V1 逃生开关:settings.guard.enforce=false ⇒ 整体放行(与"未 sealed"那条**不同**:
  //    这条路上档案**仍是定型的**,门是被开关整体让开的)。
  //    ⚠️ 本节 sView 把 enforce 钉死为 true ⇒ 这里**不能**用端点验(会把门钉开着),
  //    改验两件能落成断言的事:①这条开关**确实是 settings 里的显式 false**(不是我以为的);
  //    ②`DSH_LING_GUARD` 未被设成 off ⇒ 本节的判据全落在 settings 与门本身上。
  //    开关"整体放行"的行为判据在 tests/guard.test.mjs 8.4 两条(环境变量 + settings)各验一次。
  await sSet.update({ guard: { enforce: false, trustedHosts: [ProxyAuthority] } });
  const sSaved = JSON.parse(readFileSync(join(sHome, 'set', 'settings.json'), 'utf8'));
  check(sSaved.user.guard.enforce === false, 'V1 逃生开关前置:settings.json 里 guard.enforce 确实被显式写成 false(实测 '
    + JSON.stringify(sSaved.user.guard) + ')');
  check(process.env.DSH_LING_GUARD === undefined, 'V1 前置:本节内 DSH_LING_GUARD 未设(否则整节都会被逃生开关放行)');
  await sSet.update({ guard: { enforce: true, trustedHosts: [ProxyAuthority] } });

  // ── V3 留痕:本节的手术尝试都进**同一个**链,且链完好 ─────────────────────────────
  // 文件可能压根不存在(旧实现根本不写留痕)⇒ 不抛异常,而是把"没有文件"当成链不成立打红,
  // 这样双向验证时能看到"红在哪一条",而不是整个文件停在 readFileSync 上。
  const { verifySurgeryChain } = await imp('lib/host/surgery.js');
  const chain = verifySurgeryChain(sLog);
  check(existsSync(sLog) && chain.ok === true && chain.count >= 12,
    'V3 留痕:本节的手术尝试都留了痕且链完好(实测文件存在=' + existsSync(sLog) + ' ' + JSON.stringify(chain) + ')');
  const rawLog = existsSync(sLog) ? readFileSync(sLog, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
  const parsedLog = rawLog.map((l) => JSON.parse(l));
  check(parsedLog.length >= 12 && parsedLog.every((e, i) => (i === 0 ? e.prevLineHash === null : e.prevLineHash === parsedLog[i - 1].hash)),
    'V3 留痕:' + parsedLog.length + ' 条逐条串成一条链(每条 prevLineHash === 上一条 hash)');
  check(parsedLog.some((e) => e.channel === 'proxy' && e.reason === 'surgery-local-only'),
    'V3 留痕:那次"经代理伸手"被记下来了(channel=proxy / reason=surgery-local-only)');
  check(parsedLog.length > 0 && parsedLog.every((e) => !JSON.stringify(e).includes(PHRASE)),
    'V3 留痕:承诺句**原文**一个字都没进留痕(只有指纹)');

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // 7.9 §6.1(a) 读面**按渠道分流**(2026-10-01 下午 · A′ 定稿)
  // -------------------------------------------------------------------------------------------
  // 唯一实质改动:三条读面(`/state` 的 personaInfo · `/persona/history` · `/export`)——
  //   **带代理头 ⇒ 不回承诺句(只回 hasSeal)**;无代理头(本机直连)⇒ **照旧回明文**(负对照,证明没误伤本机)。
  // 判据单一来源:api.js 的 readIsLocal → surgery.js 的 isLocalSurgeryRequest(headers)
  //   → guard.js 的 realPeerAddress(headers) === undefined(与守卫⑤、与 surgery-local-only 同源)。
  // ⚠️ 断言只对**响应体原文**做检查(不看实现)⇒ 换回旧实现时必红;且"不含 sealPhrase"按**字段名**与
  //    **子串**两种口径各断一次(标记字段特意叫 phraseHidden —— 名字里带 sealPhrase 子串就会让子串口径假红)。
  // ═══════════════════════════════════════════════════════════════════════════════════════
  {
    await sSet.update({ persona: { sealed: true, sealPhrase: PHRASE, aiName: '读面分流' } });
    const rSeed = await sCall('/persona', { patch: { persona: { aiName: '读面分流' } }, unlock: PHRASE }, tk);
    check(rSeed.body && rSeed.body.ok === true, '7.9 前置:本机 + 票据 + 原句 ⇒ 一次真保存(让历史存档有内容可读;实测 ok='
      + JSON.stringify(rSeed.body && rSeed.body.ok) + ')');

    /** 带查询串的只读请求:§7.8 的 sFire 按原样查路由(带 `?…` 会 404),这里路由键只取 `?` 之前那段
     *  (与生产里 guard 剥查询串同一条路),`req.url` 仍是完整 url ⇒ 走的是**真实**查询分支。 */
    const qCall = async (url, headers) => {
      const handler = sRoutes.get('/api/dsh-ling' + url.split('?')[0]);
      if (typeof handler !== 'function') return { status: 404, body: { error: 'route-not-mounted', url } };
      const req = new EventEmitter();
      req.url = url; req.method = 'GET';
      req.headers = headers && headers[RELAY_MARK] ? { ...headers } : { ...LOCAL, ...(headers || {}) };
      delete req.headers[RELAY_MARK];
      const out = { status: 0, body: null };
      const res = {
        setHeader() {},
        end(payload) {
          out.status = this.statusCode;
          try { out.body = JSON.parse(String(payload ?? '{}')); } catch { out.body = null; }
        },
      };
      const done = handler(req, res);
      req.emit('data', Buffer.from(''));
      req.emit('end');
      await done;
      return out;
    };
    const FACE_KEY = /"sealPhrase"\s*:/;   // **字段名**口径(不是子串口径)
    const faces = [
      ['/state?scope=global', (b) => (b && b.persona) || null],
      ['/state?scope=global&l0Preview=1', (b) => (b && b.persona) || null],   // 面板档也带上(重字段那一支)
      ['/state?sessionId=7.9-probe', (b) => (b && b.persona) || null],
      ['/persona/history', (b) => (b && Array.isArray(b.items) && b.items.length ? b.items[0].persona : null)],
      ['/export', (b) => (b && b.persona && b.persona.persona) || null],
    ];
    for (const [url, pick] of faces) {
      const remote = await qCall(url, PROXY);
      const rawR = JSON.stringify(remote.body);
      const pr = pick(remote.body);
      check(remote.status === 200 && !rawR.includes(PHRASE) && !rawR.includes('sealPhrase') && !FACE_KEY.test(rawR),
        '★7.9 V1 经代理打 ' + url + ' ⇒ 响应体**既不含承诺句原文、也不含 sealPhrase 字段**'
        + '(实测 status=' + remote.status + ' 含原句=' + rawR.includes(PHRASE) + ' 含该词=' + rawR.includes('sealPhrase') + ')');
      check(pr && pr.hasSeal === true,
        '7.9 V1 经代理的 ' + url + ' 仍带 hasSeal:true(界面据此知道"有这句")(实测 ' + JSON.stringify(pr && pr.hasSeal) + ')');

      // 负对照:同一条读面、**本机直连** ⇒ 照旧回明文(逐字含原句)
      const local = await qCall(url, {});
      const rawL = JSON.stringify(local.body);
      check(local.status === 200 && rawL.includes(PHRASE) && FACE_KEY.test(rawL),
        '★7.9 V1 负对照:本机直连打 ' + url + ' ⇒ **照旧含**承诺句原文与 sealPhrase 字段(没误伤本机)'
        + '(实测 status=' + local.status + ' 含原句=' + rawL.includes(PHRASE) + ')');
      // 本机那条路的**形状**也没变:`sealPhrase` 仍在 `hasSeal` 之后紧邻(同一个展开点决定位置)⇒ 前端零改动
      if (url.startsWith('/state')) {
        const ks = Object.keys((local.body && local.body.persona) || {});
        check(ks.indexOf('sealPhrase') === ks.indexOf('hasSeal') + 1,
          '7.9 本机 ' + url + ' 的 personaInfo 里 sealPhrase 紧跟 hasSeal(字段位置未变;实测 '
          + JSON.stringify(ks.slice(Math.max(0, ks.indexOf('hasSeal') - 1), ks.indexOf('sealPhrase') + 2)) + ')');
      }
      // ── ★中继形请求(无代理头、**无 UA**、只有中继合成的那句 sec-fetch-site):这就是本次修的那条 ──
      //   ⚠️ 修前这条必红(旧判据只看代理头 ⇒ 判成本机 ⇒ **把明文承诺句交给远端**);这就是 V1 第二态。
      const relay = await qCall(url, relayHeaders());
      const rawRelay = JSON.stringify(relay.body);
      check(relay.status === 200 && !rawRelay.includes(PHRASE) && !rawRelay.includes('sealPhrase') && !FACE_KEY.test(rawRelay),
        '★7.9 V1 中继形请求打 ' + url + ' ⇒ 响应体**既不含承诺句原文、也不含 sealPhrase 字段**'
        + '(实测 status=' + relay.status + ' 含原句=' + rawRelay.includes(PHRASE) + ' 含该词=' + rawRelay.includes('sealPhrase') + ')');
      check(pick(relay.body) && pick(relay.body).hasSeal === true,
        '7.9 V1 中继形请求的 ' + url + ' 仍带 hasSeal:true(远端界面据此知道"有这句")(实测 '
        + JSON.stringify(pick(relay.body) && pick(relay.body).hasSeal) + ')');

      console.log('    7.9 ' + url
        + ' · 远端 status=' + remote.status + ' 含原句=' + rawR.includes(PHRASE)
        + ' 含该词=' + rawR.includes('sealPhrase') + ' hasSeal=' + JSON.stringify(pr && pr.hasSeal)
        + ' 敏感键=' + JSON.stringify(Object.keys(pr || {}).filter((k) => /seal|phrase/i.test(k)))
        + ' · 本机 status=' + local.status + ' 含原句=' + rawL.includes(PHRASE)
        + ' 含字段=' + FACE_KEY.test(rawL)
        + ' · 中继形 status=' + relay.status + ' 含原句=' + rawRelay.includes(PHRASE));
    }

    // ── 客户端那一半(**源码护栏**,与 client-batch 的 T8 同一条纪律:UI 闭包执行不到就只钉源码)──
    //   ⚠️ 证据边界:这里**不执行** DOM(本文件没有浏览器环境)⇒ 只能证明"代码在、且本机那条路逐字未动",
    //      不能证明"屏幕上长什么样"。真机观感要人来看一眼。
    const csrc = readFileSync(join(root, 'lib/client.js'), 'utf8');
    check(csrc.includes('sealHidden = p.phraseHidden === true'),
      '7.9 客户端:认领服务端的"这句只在本机显示"标记(远端时不是空的、更不报错)');
    check(csrc.includes('承诺句只在本机显示'),
      '7.9 客户端:远端解锁框有**优雅退化**文案(说清是渠道问题 + 给出"回本机"的路)');
    check(csrc.includes("'你定型时写下的承诺句是:\\n「' + hintPhrase + '」\\n\\n手术前请郑重地亲手敲一遍以确认(输入框禁粘贴,逐字敲出)。'"),
      '7.9 客户端:**本机**那条提示**逐字未变**(hintPhrase 命中时走的还是原来那句)');

    // ── 渠道判据的**单一来源**源码护栏:三条读面都必须走同一个 `readIsLocal`,不许各写一份代理头判断 ──
    const apiSrc79 = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
    check(/const readIsLocal = \(req\) => isLocalSurgeryRequest\(req\?\.headers\);/.test(apiSrc79),
      '7.9 护栏:渠道判据 = surgery.js 的 isLocalSurgeryRequest(「无代理头 **且** 带 UA」),'
      + '与守卫⑤ / surgery-local-only 同源 —— 不是在 api.js 里另写一份 IP / UA 判断');
    check((apiSrc79.match(/readIsLocal\(/g) || []).length === 3 && /const readIsLocal = \(req\) =>/.test(apiSrc79),
      '7.9 护栏:readIsLocal =「1 处定义 + 恰好 3 个读面调用」(state / persona-history / export;实测调用 '
      + ((apiSrc79.match(/readIsLocal\(/g) || []).length) + ' 处)');
    // ⚠️ **判据本体的源码护栏**(2026-10-01 晚加):防"将来被优化掉" —— 两条命门都必须逐字在位。
    //   只钉"两条都在",不钉实现细节:改写成等价写法(如拆成两个函数)时这两条仍应为真,
    //   而**删掉任意一条**必红 —— 那正是要拦的"优化"。
    const sSrc79 = readFileSync(join(root, 'lib/host/surgery.js'), 'utf8');
    check(/realPeerAddress\(headers\) !== undefined\) return false/.test(sSrc79),
      '7.9 护栏:判据第①条(代理头)在位 —— 公网直连时 nginx 追加的 XFF 是全链最可靠的一道,不许删');
    //   ⚠️ 第②条**必须整段一起匹配**(2026-10-01 晚 · 双向验证时抓到的假绿):
    //      只钉 `headerOf(headers, 'user-agent')` 与 `ua.trim() !== ''` 两个**片段**时,
    //      「换回旧判据(只看代理头)+ 旁边留一个同名局部变量」也能把两个片段凑齐 ⇒ 护栏假绿。
    //      改成整段匹配后,"换回旧写法"必红 —— 这正是要拦的那件事。
    check(/if \(realPeerAddress\(headers\) !== undefined\) return false;\s*\n\s*const ua = headerOf\(headers, 'user-agent'\);\s*\n\s*return typeof ua === 'string' && ua\.trim\(\) !== '';/.test(sSrc79),
      '7.9 护栏:判据第②条(**UA 必须存在且非空**)整段在位 —— 远端中继重建请求头时会丢 UA,那是那条路的指纹');
    check((sSrc79.match(/export function isLocalSurgeryRequest/g) || []).length === 1,
      '7.9 护栏:isLocalSurgeryRequest **只有 1 处定义**(单一来源;实测 '
      + ((sSrc79.match(/export function isLocalSurgeryRequest/g) || []).length) + ' 处)');
    check((sSrc79.match(/isLocalSurgeryRequest\(/g) || []).length === 2,
      '7.9 护栏:手术门侧调用点与现状一致(surgery.js 内 = 1 处定义 + 1 处 requireSurgery 使用;实测 '
      + ((sSrc79.match(/isLocalSurgeryRequest\(/g) || []).length) + ' 处)');

    // ── ★7.9c 追加(2026-10-01 晚):链基线 `knownGaps` **去重** ──────────────────────────────
    //   真机实况:5 行日志里 4 行落在**同一个**已知区间 ⇒ 旧实现逐行 push,回执报出 4 条**一模一样**的
    //   {from:1,to:5}(只有 at 不同);1000 行的缺口会膨胀成 999 条 —— 噪声重新把信号淹掉。
    //   规格两条:① **每个区间一条**,`at` = **首次**命中该区间的行号;② **判据一个字没改** ——
    //   区间**外**仍 ok:false、**区间内的自哈希照样核**(③④ 就是这两条负对照,防"去重顺手改松")。
    //   ⚠️ 构造手法与 guard.test.mjs §8.7 同一条纪律:**不自己复算哈希公式** —— 孤儿行(自哈希正确、
    //     prevLineHash=null)一律用生产代码 createSurgeryEvent 在**空文件**里写出来。⚠️ 它会**自己
    //     append**,所以"第 N 条重新接上"只需再调一次;若在调用之后再手工回写那一行,会造出重复行、
    //     把断点挤到区间外(探针阶段踩过这个坑)。
    {
      const dir79 = mkdtempSync(join(tmpdir(), 'dsh-ling-gapdedup-'));
      const ev79 = () => ({ endpoint: '/persona', reason: 'ok', channel: 'local', phraseOk: true });
      const { createSurgeryEvent, verifySurgeryChain: verify79, listSurgeryEvents: list79 } = await imp('lib/host/surgery.js');
      const orphan79 = () => {   // 自哈希正确、prevLineHash=null 的孤儿行(在空文件里用生产代码写一次)
        const f = join(dir79, 'orphan.jsonl');
        writeFileSync(f, '');
        return JSON.stringify(createSurgeryEvent(ev79(), { file: f, at: '2026-01-01T00:00:00.000Z' }));
      };
      const append79 = (file, text) => writeFileSync(file, readFileSync(file, 'utf8') + text);
      const ranges79 = (list) => {
        const f = join(dir79, 'baseline-' + list.map((r) => r.from + '-' + r.to).join('_') + '.json');
        writeFileSync(f, JSON.stringify({ brokenRanges: list }));
        return f;
      };

      // ① 一个区间盖 4 行:第 1 条正常 + 第 2~5 条孤儿(全落在区间 1–5 内)+ 第 6 条重新接上
      const base1 = ranges79([{ from: 1, to: 5, reason: '测试:一区间盖4行', at: '2026-02-02' }]);
      const log1 = join(dir79, 'chain-in.jsonl');
      writeFileSync(log1, '');
      createSurgeryEvent(ev79(), { file: log1, at: '2026-01-01T00:00:01.000Z' });                     // 第 1 条
      append79(log1, [orphan79(), orphan79(), orphan79(), orphan79()].join('\n') + '\n');             // 第 2~5 条
      createSurgeryEvent(ev79(), { file: log1, at: '2026-01-01T00:00:06.000Z' });                     // 第 6 条(接上)
      const v79a = verify79(log1, { baselineFile: base1 });
      const g79a = Array.isArray(v79a.knownGaps) ? v79a.knownGaps : [];
      check(v79a.ok === true && v79a.count === 6 && g79a.length === 1 && g79a[0] && g79a[0].at === 2
        && g79a[0].from === 1 && g79a[0].to === 5 && g79a[0].reason === '测试:一区间盖4行',
        '★7.9c① 一个区间盖 4 行 ⇒ knownGaps **只报一条**(旧实现 4 条)、at = **首次**命中行(第 2 行)(实测 '
        + JSON.stringify(v79a.knownGaps) + ' · 整链 ' + JSON.stringify(v79a.ok) + ')');
      const ls79 = list79(10, { file: log1, baselineFile: base1 });   // 读面(GET /surgery/events 走的就是这条)
      check(Array.isArray(ls79.chain.knownGaps) && ls79.chain.knownGaps.length === 1 && ls79.chain.knownGaps[0].at === 2,
        '★7.9c① 读面 chain.knownGaps 同样只报一条(实测 ' + JSON.stringify(ls79.chain.knownGaps) + ')');

      // ② **两个不相邻**区间(1–2 与 4–5)各断一次 ⇒ 各报一条,at 分别是 2 与 4
      const base2 = ranges79([{ from: 1, to: 2, reason: '测试:区间甲', at: '2026-03-03' }, { from: 4, to: 5, reason: '测试:区间乙', at: '2026-03-04' }]);
      const log2 = join(dir79, 'chain-two.jsonl');
      writeFileSync(log2, '');
      createSurgeryEvent(ev79(), { file: log2, at: '2026-01-01T00:00:01.000Z' });                     // 1 ✓
      append79(log2, orphan79() + '\n');                                                             // 2 ✗(区间甲)
      createSurgeryEvent(ev79(), { file: log2, at: '2026-01-01T00:00:03.000Z' });                     // 3 ✓(接上)
      append79(log2, orphan79() + '\n' + orphan79() + '\n');                                         // 4、5 ✗(区间乙)
      createSurgeryEvent(ev79(), { file: log2, at: '2026-01-01T00:00:06.000Z' });                     // 6 ✓(接上)
      const v79b = verify79(log2, { baselineFile: base2 });
      const g79b = Array.isArray(v79b.knownGaps) ? v79b.knownGaps : [];
      check(v79b.ok === true && v79b.count === 6 && g79b.length === 2 && g79b[0] && g79b[0].at === 2
        && g79b[0].from === 1 && g79b[0].to === 2 && g79b[1] && g79b[1].at === 4 && g79b[1].from === 4 && g79b[1].to === 5,
        '★7.9c② 两个**不相邻**区间 ⇒ 各报一条(at=2 与 at=4;实测 ' + JSON.stringify(v79b.knownGaps) + ')');

      // ③ 负对照 · 断链落在区间**外** ⇒ 仍 ok:false(去重不许把区间外放进来)
      const base3 = ranges79([{ from: 1, to: 2, reason: '测试:只豁免前两行', at: '2026-03-05' }]);
      const v79c = verify79(log2, { baselineFile: base3 });
      check(v79c.ok === false && v79c.brokenAt === 4 && v79c.reason === 'chain',
        '★7.9c③ 负对照:断链落在区间**外**(第 4 行)⇒ 仍 ok:false / reason=chain(实测 ' + JSON.stringify(v79c) + ')');

      // ④ 负对照 · 区间**内**的行被改过 ⇒ 自哈希照样核(命门:豁免的只有链,不是整条记录)
      const lines79 = readFileSync(log1, 'utf8').split('\n').filter((l) => l.trim() !== '');
      const tamper79 = join(dir79, 'chain-in-tampered.jsonl');
      lines79[2] = lines79[2].replace('"reason":"ok"', '"reason":"ok!改过了"');   // 第 3 行(区间 1–5 内)
      writeFileSync(tamper79, lines79.join('\n') + '\n');
      const v79d = verify79(tamper79, { baselineFile: base1 });
      check(v79d.ok === false && v79d.brokenAt === 3 && v79d.reason === 'hash',
        '★7.9c④ 负对照:区间**内**被改一行 ⇒ 自哈希照样被抓 ok:false / reason=hash(实测 ' + JSON.stringify(v79d) + ')');

      console.log('    7.9c knownGaps 实测:① 4行同区间=' + JSON.stringify(v79a.knownGaps)
        + ' · 读面=' + JSON.stringify(ls79.chain.knownGaps)
        + ' · ② 两不相邻区间=' + JSON.stringify(v79b.knownGaps)
        + ' · ③ 区间外=' + JSON.stringify(v79c)
        + ' · ④ 区间内改行=' + JSON.stringify(v79d));
    }
  }
}

// 7.8b 链的**默认路径**也必须串得上(2026-10-01 真机实测坐实的 bug)
//   · 旧 `createSurgeryEvent` 先算 `prevLineHash(opts.file)`、**后**解析 `opts.file || surgeryLogPath()`
//     ⇒ 线上调用方不传 `opts.file` 时 `readFileSync(undefined)` 抛错被吞、恒回 null
//     ⇒ **每条记录的 prevLineHash 都是 null,链永远串不上**(真机 5 条全 nil,verifySurgeryChain 报 brokenAt=2)。
//   · 上面 §7.8 之所以没抓到:它**总是显式传 `surgeryLog`**,恰好绕开了默认路径那条分支。
//   · 本条用 `DSH_HOME` 指向临时目录 ⇒ 走**默认路径**(不传 opts.file),两条事件必须串上。
{
  const { createSurgeryEvent, verifySurgeryChain, surgeryLogPath } = await imp('lib/host/surgery.js');
  const savedHome = process.env.DSH_HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-ling-surgeryhome-'));
  process.env.DSH_HOME = fakeHome;
  try {
    const logPath = surgeryLogPath();
    check(logPath.startsWith(fakeHome), '7.8b 默认留痕路径跟随 DSH_HOME(实测 ' + logPath + ')');
    const e1 = createSurgeryEvent({ endpoint: '/persona', reason: 'ok', channel: 'local', phraseOk: true }, { at: '2026-01-01T00:00:00.000Z' });
    const e2 = createSurgeryEvent({ endpoint: '/persona', reason: 'ok', channel: 'local', phraseOk: true }, { at: '2026-01-01T00:00:01.000Z' });
    check(e1.prevLineHash === null, '7.8b 链首 prevLineHash 为 null(实测 ' + JSON.stringify(e1.prevLineHash) + ')');
    check(e2.prevLineHash === e1.hash,
      '7.8b 不传 opts.file 时第二条也要指向第一条的 hash(实测 ' + JSON.stringify(e2.prevLineHash) + ' vs ' + JSON.stringify(e1.hash) + ')');
    const v = verifySurgeryChain();
    check(v.ok === true && v.count === 2, '7.8b 默认路径的链自校验通过(实测 ' + JSON.stringify(v) + ')');
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 7.10 E2 可见化(2026-10-01):未知原文来源的告警**真的走到了读面**(端点级 + 真调处理器)
// -------------------------------------------------------------------------------------------
// 主人拍板:「E2 告诉前台到底发生啥了就行,加吧」—— 上一版把未知来源排除掉却只留 kv 留痕,
// 主人**看不见**。这一节驱动**真实 HTTP 处理器**(沿用上面同一套假 webServer + 同一份临时库)证明三件事:
//   V1 **负对照**:kv 里没有那条键 ⇒ 五条读面(健康面 + /state 两个档 × 全局/会话)**一个字符都不提它**,
//      且老键的顺序与取值逐字未变(源码级形状护栏在 tests/guard.test.mjs §9.5);
//   V2 **有告警**:五个要素(几个来源/叫什么/各几轮/首次最近/一句人话)一个不少,老键取值不动;
//   V3 **不显示假读数**:空壳(namespaces:{})· 坏 JSON · 清干净 三种负对照都不许冒出空行或崩溃,
//      清干净后响应体与告警前**逐字相同**(往返可逆)。
// ⚠️ 全部落在上面那个 mkdtempSync 临时库上(kv 是临时库里的键)⇒ 真机库零字节写入。
// ⚠️ 措辞诚实性也是断言的一部分:那句"没混进你的会话统计"**不许**出现 —— memory.rawSessionCount()
//    数的是全表 DISTINCT session_id,**含**外来命名空间,那句话听着漂亮但是假的。
// ═══════════════════════════════════════════════════════════════════════════════════════════
{
  /** GET 一条读面:路由键取 `?` 之前那段(与生产 guard 剥查询串同一条路),`req.url` 仍是完整 url。
   *  ⚠️ 头必须长成**真·本机浏览器**的样子(host + UA + 本机 cookie):守卫此刻是**开着**的
   *  (§7 段首 `delete process.env.DSH_LING_GUARD` 之后就一直是开的)—— 少了 cookie 会被 403 挡在
   *  守卫层,那时下面每条断言都会"红在守卫上"、而不是红在被测的读面上(第一版正是这样红了一整片)。 */
  const { expectedCookieName } = await imp('lib/host/guard.js');
  const UA710 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0';
  const LOCAL710 = {
    host: '127.0.0.1:3080', 'user-agent': UA710,
    cookie: expectedCookieName('127.0.0.1:3080') + '=1',
  };
  const get710 = async (url) => {
    const handler = routes.get('/api/dsh-ling' + url.split('?')[0]);
    if (typeof handler !== 'function') return { status: 404, body: null, raw: '' };
    const req = new EventEmitter();
    req.url = url; req.method = 'GET';
    req.headers = { ...LOCAL710 };
    const out = { status: 0, body: null, raw: '' };
    const res = {
      setHeader() {},
      end(payload) {
        out.status = this.statusCode;
        out.raw = String(payload ?? '');
        try { out.body = JSON.parse(out.raw || '{}'); } catch { out.body = null; }
      },
    };
    const done = handler(req, res);
    req.emit('data', Buffer.from(''));
    req.emit('end');
    await done;
    return out;
  };
  const has710 = (b) => !!(b && Object.prototype.hasOwnProperty.call(b, 'rawUnknownSources'));
  const FACES710 = [
    '/health',
    '/state?scope=global',
    '/state?scope=global&l0Preview=1',   // 面板档(重字段那一支)
    '/state?sessionId=7.10-probe',
    '/state?sessionId=7.10-probe&l0Preview=1',
  ];

  // ---- V1 负对照:没有告警 ⇒ 五条读面逐字照旧(不含新字段) ----
  const clean710 = {};
  for (const url of FACES710) {
    const r = await get710(url);
    clean710[url] = r.raw;
    check(r.status === 200 && !has710(r.body),
      '★7.10 V1 负对照(kv 里没有那条键):' + url + ' **不含** rawUnknownSources(实测 status=' + r.status
      + ' 含该键=' + has710(r.body) + ')');
  }
  check((await get710('/health')).raw === clean710['/health'],
    '★7.10 V1 /health 连发两次**逐字相同**(读数自稳 ⇒ "逐字比对"这个判据本身成立)');
  const hClean = JSON.parse(clean710['/health']);
  // ⚠️ 不把键表写成字面量:本测试台的 registerApi 收的是 `{}` ⇒ `config.version` 是 undefined
  //    ⇒ JSON 里**本来就不出现** version(实测 ok,plugin,audit,sessionLine)。这里钉的是**顺序与边界**:
  //    头两键、audit 的位置、末键都照旧 —— 与"逐字不变"等价,又不把测试台的偶然形状抄成契约。
  const kClean = Object.keys(hClean);
  check(kClean[0] === 'ok' && kClean[1] === 'plugin' && kClean[2] === 'audit' && kClean[kClean.length - 1] === 'sessionLine',
    '★7.10 V1 /health 老键的**顺序**逐字未变(ok → plugin → audit … → sessionLine;version 在测试台上是 undefined '
    + '⇒ JSON 里不出现;实测 ' + kClean.join(',') + ')');

  // ---- V2 有告警 ⇒ 新字段出现,五个要素齐 ----
  db.kvSet('dbg.raw_unknown_namespace', JSON.stringify({
    at: '2026-10-01T11:00:00.000Z',
    where: 'summarizer.summarizeDsh',
    note: '(测试造的留痕:形状照抄 summarizer.js noteUnknownRawNamespaces)',
    namespaces: {
      'import2:': { turns: 5, samples: ['import2:aaa'], firstSeenAt: '2026-09-30T02:03:04.000Z', lastSeenAt: '2026-10-01T11:00:00.000Z' },
      'sync3:': { turns: 2, samples: ['sync3:bbb'], firstSeenAt: '2026-09-25T01:00:00.000Z', lastSeenAt: '2026-09-28T09:30:00.000Z' },
    },
  }));
  const h2 = await get710('/health');
  const ru = h2.body && h2.body.rawUnknownSources;
  check(!!ru, '★7.10 V2 有告警时 /health **出现** rawUnknownSources(实测 ' + JSON.stringify(h2.body && Object.keys(h2.body)) + ')');
  check(!!ru && ru.count === 2, '★7.10 V2 要素①未知来源**个数**(实测 ' + JSON.stringify(ru && ru.count) + ')');
  check(!!ru && JSON.stringify(ru.names) === JSON.stringify(['import2:', 'sync3:']),
    '★7.10 V2 要素②它们**叫什么**(按轮数降序;实测 ' + JSON.stringify(ru && ru.names) + ')');
  const byNs710 = new Map((((ru && ru.namespaces) || [])).map((x) => [x.ns, x]));
  check(!!ru && byNs710.get('import2:') && byNs710.get('import2:').turns === 5
    && byNs710.get('sync3:') && byNs710.get('sync3:').turns === 2 && ru.turns === 7,
    '★7.10 V2 要素③**各有多少轮**原文 + 合计(实测 import2:=' + JSON.stringify(byNs710.get('import2:') && byNs710.get('import2:').turns)
    + ' sync3:=' + JSON.stringify(byNs710.get('sync3:') && byNs710.get('sync3:').turns) + ' 合计=' + JSON.stringify(ru && ru.turns) + ')');
  check(!!ru && ru.firstSeenAt === '2026-09-25T01:00:00.000Z' && ru.lastSeenAt === '2026-10-01T11:00:00.000Z',
    '★7.10 V2 要素④**首次/最近**见到(取各来源的极值;实测 ' + JSON.stringify(ru && [ru.firstSeenAt, ru.lastSeenAt]) + ')');
  check(!!ru && typeof ru.text === 'string' && ru.text.length > 20 && /2 个/.test(ru.text)
    && ru.text.includes('import2:') && ru.text.includes('sync3:') && ru.text.includes('7 轮'),
    '★7.10 V2 要素⑤一句**人话**(个数/名字/轮数都在句子里;实测 ' + JSON.stringify(ru && ru.text) + ')');
  check(!!ru && !/没混进/.test(ru.text),
    '★7.10 措辞诚实:那句"没混进你的会话统计"**没有**出现(rawSessionCount 数全表、含外来命名空间 ⇒ 那句是假话)');
  check(h2.body.ok === hClean.ok && h2.body.plugin === hClean.plugin && h2.body.version === hClean.version
    && JSON.stringify(h2.body.audit) === JSON.stringify(hClean.audit)
    && JSON.stringify(h2.body.sessionLine) === JSON.stringify(hClean.sessionLine),
    '★7.10 V2 老键取值逐字未变(ok/plugin/version/audit/sessionLine;实测 audit 相同='
    + (JSON.stringify(h2.body.audit) === JSON.stringify(hClean.audit)) + ')');
  const k2 = Object.keys(h2.body);
  check(k2[k2.length - 1] === 'rawUnknownSources' && k2.slice(0, -1).join(',') === kClean.join(','),
    '★7.10 V2 新键**追加在最后**、老键序逐字未变(实测 ' + k2.join(',') + ' vs 告警前 ' + kClean.join(',') + ')');
  for (const url of FACES710.slice(1)) {
    const r = await get710(url);
    check(!!(r.body && r.body.rawUnknownSources) && r.body.rawUnknownSources.count === 2,
      '★7.10 V2 ' + url + ' 也带上同一份告警(面板不必重开就看得见;实测 '
      + JSON.stringify(r.body && r.body.rawUnknownSources && r.body.rawUnknownSources.count) + ')');
  }

  // ---- V3 三种"不许显示假读数"的负对照 ----
  db.kvSet('dbg.raw_unknown_namespace', JSON.stringify({ at: '2026-10-01T11:00:00.000Z', namespaces: {} }));
  const shell710 = await get710('/health');
  check(shell710.status === 200 && !has710(shell710.body),
    '★7.10 V3 空壳负对照:namespaces 是空表(有键没内容)⇒ 不冒空行(实测含该键=' + has710(shell710.body) + ')');
  db.kvSet('dbg.raw_unknown_namespace', '这不是 JSON{{{');
  const junk710 = await get710('/health');
  check(junk710.status === 200 && !has710(junk710.body),
    '★7.10 V3 脏值负对照:kv 里是坏 JSON ⇒ 读面**不许崩**,按"没有告警"处理(实测 status='
    + junk710.status + ' 含该键=' + has710(junk710.body) + ')');
  db.kvSet('dbg.raw_unknown_namespace', '');   // 清干净(临时库;进程结束即弃)
  const cleared710 = await get710('/health');
  check(cleared710.status === 200 && !has710(cleared710.body), '7.10 V3 清干净 ⇒ 字段重新消失');
  check(cleared710.raw === clean710['/health'],
    '★7.10 V3 往返可逆:清干净后的 /health 与告警前**逐字相同**(没有残留、没有把读数留在半路)');
  console.log('    7.10 实测:V1 五条读面含新键=false ' + FACES710.map((u) => u + '=' + has710(JSON.parse(clean710[u]))).join(' ')
    + ' · V2 /health 含新键=' + has710(h2.body) + ' 个数=' + JSON.stringify(ru && ru.count) + ' 合计轮=' + JSON.stringify(ru && ru.turns)
    + ' · V3 空壳/脏值/清空 三态含新键=false · 清空后逐字相同=' + (cleared710.raw === clean710['/health']));
  console.log('    7.10 前台要显示的那句话(原样):' + JSON.stringify('⚠ ' + (ru && ru.text)));
}

delete process.env.DSH_LING_GUARD;

console.log(ok ? '记忆分枝(D9-a + 主脉候选链)全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
