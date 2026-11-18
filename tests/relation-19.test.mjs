// M6b / 1.9 · 关系定位三档 + 门顺序 + 「未持票不覆盖记忆」
//
// 判据来源:PLAN-1.9 §4(三档判据/输出形态)、§5(门位置二分结论 = **不改**)、§7.2(I-3 / I-4)、
//           §7.5(门顺序 / 未持票不覆盖 / 全链)、RELATION-MAP §3(判据)、GATE-POSITION §5(落点)。
//
// 本文件钉住四件事:
//   ① 三档 `same-session` / `cross-session` / `unknown` 的**快照**(counts + tier 序列 + reasons 序列);
//      变异"三档输出同一句" ⇒ 这里当场红(I-3);
//   ② `unknown` 的四种触发各有**机器短码**,不许并列、不许静默降级成 same-session;
//   ③ 门顺序 = **取行号**比较(`register('/import') < endpoint:'/import' < memory.importBundle(`),
//      **不写死行号**(GATE-POSITION §3 已证这三个数一个月漂了 49 行);门被后移 ⇒ 这里红(I-4);
//   ④ 「未持票不覆盖记忆」:已定型 + 无票 ⇒ 记忆表一个字节都不动(现状应绿)+ 一条**正对照**
//      (持票 + 原句对 ⇒ 真的落库),否则④的绿可能只是"路由没挂上"的假绿。
//
// ⚠️ DSH_HOME 隔离(硬要求):`registerApi()` 一进来就 `rotateSurgeryTicket()` 往 `dshHome()` 写票据文件。
// ⚠️ 三档口径:这是**数据面**(条目 ↔ 当前会话)。人格面 `relationshipProfile: neutral/companion/custom`
//    (`genesis.js`)是**另一件事**,本文件一个字都不碰(RELATION-MAP §0)。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const dir = mkdtempSync(join(tmpdir(), 'ling-rel19-'));
const realHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(dir, 'home'); // 必须在 registerApi() 之前

let assertions = 0;
let failures = 0;
const check = (cond, msg) => {
  assertions += 1;
  if (!cond) { failures += 1; console.log('✗ ' + msg); }
};
const section = (t) => console.log('▶ ' + t);

const { MemoryStore, sessionRelation, sessionRelationBatch, RELATION_TIERS, RELATION_REASONS } =
  await imp('lib/host/memory.js');

// ══ 1) 三档快照(12 行:4 same / 4 cross / 4 unknown)══════════════════════════════════
section('1 · 三档快照(same-session / cross-session / unknown)');
check(JSON.stringify(RELATION_TIERS) === '["same-session","cross-session","unknown"]',
  '1.0 三档枚举与 PLAN §4.1 逐字一致,实际 ' + JSON.stringify(RELATION_TIERS));
check(JSON.stringify(RELATION_REASONS) === '["superseded","same-conv","same-ns","same-branch","other-conv","no-conv","no-src","unknown-src","conv-missing"]',
  '1.0 reasons 短码枚举序固定(快照可比对),实际 ' + JSON.stringify(RELATION_REASONS));

/** 离线 io 桩:三档判据只能靠"给定 item + ctx + 假数据"来判(RELATION-MAP §6 的离线可判清单)。 */
const IO = {
  overviewById: (s, c) => (['dsh|s1', 'dsh|s2', 'dsh|s3', 'dsweb|w1', 'dsweb|s1', 'import|i1'].includes(s + '|' + c) ? { conv_id: c, source: s } : null),
  branchOfConv: (s, c) => ({
    'dsh|s1': 'br:a', 'dsh|s2': 'br:a', 'dsh|s3': 'trunk',
    'dsweb|w1': 'trunk', 'dsweb|s1': 'trunk', 'import|i1': 'trunk',
  }[s + '|' + c] || 'trunk'),
  hasSession: (id) => ['s1', 's2', 's3'].includes(String(id)),
};
const CTX = { source: 'dsh', convId: 's1' };

const ITEMS = [
  // 4 × same-session(同域 + 同 conv_id)
  { id: 'same-1', conv_id: 's1', src: 'dsh', superseded_by: '' },
  { id: 'same-2', conv_id: 's1', src: 'dsh', superseded_by: '' },
  { id: 'same-3', conv_id: 's1', src: 'dsh', superseded_by: '' },
  { id: 'same-4', conv_id: 's1', src: 'dsh', superseded_by: 'di:retired' }, // 已作废不改变 tier(两轴)
  // 4 × cross-session(有会话身份、但不是当前会话)
  { id: 'cross-1', conv_id: 's2', src: 'dsh', superseded_by: '' },   // 同枝(br:a)
  { id: 'cross-2', conv_id: 's3', src: 'dsh', superseded_by: '' },   // trunk ⇒ 不算同枝
  { id: 'cross-3', conv_id: 'w1', src: 'dsweb', superseded_by: '' },
  { id: 'cross-4', conv_id: 'i1', src: 'import', superseded_by: '' },
  // 4 × unknown(四种触发各一)
  { id: 'unk-no-conv', conv_id: '', src: 'dsh', superseded_by: '' },
  { id: 'unk-no-src', conv_id: 's1x', src: '', superseded_by: '' },
  { id: 'unk-bad-src', conv_id: 's1x', src: 'weird', superseded_by: '' },
  { id: 'unk-missing', conv_id: 'gone', src: 'dsh', superseded_by: '' },
];

const batch = sessionRelationBatch(ITEMS, CTX, IO);
check(batch.profileVersion === 1, '1.1 批量形态带 profileVersion:1');
check(JSON.stringify(batch.counts) === JSON.stringify({ 'same-session': 4, 'cross-session': 4, unknown: 4 }),
  '★1.2 三档计数快照必须 {same:4,cross:4,unknown:4}(三档同一句 ⇒ 这里红),实际 ' + JSON.stringify(batch.counts));
check(JSON.stringify(batch.items.map((x) => x.tier)) === JSON.stringify([
  'same-session', 'same-session', 'same-session', 'same-session',
  'cross-session', 'cross-session', 'cross-session', 'cross-session',
  'unknown', 'unknown', 'unknown', 'unknown',
]), '★1.3 tier 序列快照,实际 ' + JSON.stringify(batch.items.map((x) => x.tier)));
check(JSON.stringify(batch.items.map((x) => x.reasons)) === JSON.stringify([
  ['same-conv'], ['same-conv'], ['same-conv'], ['superseded', 'same-conv'],
  ['same-branch', 'other-conv'], ['other-conv'], ['other-conv'], ['other-conv'],
  ['no-conv'], ['no-src'], ['unknown-src'], ['conv-missing'],
]), '★1.4 reasons 短码快照(有序、白名单枚举内),实际 ' + JSON.stringify(batch.items.map((x) => x.reasons)));
check(Object.keys(batch.items[0].evidence).join(',') === 'itemConvId,ctxConvId,itemBranch,ctxBranch,src,nsMatched',
  '1.5 evidence 键序固定,实际 ' + Object.keys(batch.items[0].evidence).join(','));
check(batch.items[4].evidence.itemBranch === 'br:a' && batch.items[4].evidence.ctxBranch === 'br:a',
  '1.6 evidence 里看得见"为什么同枝"(两侧 br:a),实际 ' + JSON.stringify(batch.items[4].evidence));
check(batch.items[0].evidence.itemBranch === 'br:a' && batch.items[1].evidence.ctxBranch === 'br:a',
  '1.6b 同会话行的两侧枝也照实报(br:a)');

// ══ 2) unknown 先于 cross-session 判(顺序不许并列)══════════════════════════════════════
section('2 · unknown 先判(外来包缺会话行不许算成跨会话)');
const relMissing = sessionRelation({ id: 'x', conv_id: 'not-here', src: 'import' }, CTX, IO);
check(relMissing.tier === 'unknown' && relMissing.reasons.includes('conv-missing'),
  '★2.1 库内查无此会话 ⇒ unknown/conv-missing(不许算成 cross-session),实际 ' + JSON.stringify([relMissing.tier, relMissing.reasons]));
check(sessionRelation({ id: 'x', conv_id: '', src: '' }, { source: 'dsh', convId: '' }, IO).tier === 'unknown',
  '★2.2 conv_id 与 ctx 都是空串 ⇒ unknown(空串必须先排除,否则 `\'\' === \'\'` 会假判同会话)');
check(sessionRelation({ id: 'x', conv_id: 's2', src: 'dsh' }, { source: 'dsh', convId: '' }, IO).tier === 'cross-session',
  '2.3 ctx 的 convId 为空但条目有身份 ⇒ 仍是 cross-session(不是同会话)');
check(sessionRelation({ id: 'x', conv_id: 's9', src: 'dsh', superseded_by: 'di:y' }, CTX, IO).reasons.includes('superseded'),
  '2.4 已作废只加短码,不改变 tier');
check(sessionRelation({ id: 'x', conv_id: 's2', src: 'dsh' }, CTX, IO).reasons.includes('same-branch') === true
  && sessionRelation({ id: 'x', conv_id: 's3', src: 'dsh' }, CTX, IO).reasons.includes('same-branch') === false,
  '2.5 同枝加强:两侧同枝(br:a)才算;trunk==trunk 不算(trunk 是"无信息"默认值)');

// ══ 3) 命名空间归一:同域内别名算同一会话,跨域同 id **不算**认领 ═══════════════════════
section('3 · 命名空间(`import:<id>` 双写法)与跨域镜像');
const relNs = sessionRelation({ id: 'x', conv_id: 'import:i1', src: 'import' }, { source: 'import', convId: 'i1' }, IO);
check(relNs.tier === 'same-session' && relNs.reasons.includes('same-ns'),
  '3.1 同域双写法(import:i1 vs i1)⇒ same-session/same-ns,实际 ' + JSON.stringify([relNs.tier, relNs.reasons]));
const relMirror = sessionRelation({ id: 'x', conv_id: 's1', src: 'dsweb' }, CTX, IO);
check(relMirror.tier === 'cross-session',
  '★3.2 跨域同 id(dsweb/s1 vs dsh/s1)⇒ cross-session(镜像行不许被认领成本会话),实际 ' + relMirror.tier);
check(relMirror.evidence.nsMatched === true && !relMirror.reasons.includes('same-ns'),
  '3.3 跨域同 id 的 nsMatched 是 true,但**不给** same-ns(域不同 ⇒ 不认领)');
check(sessionRelationBatch([], CTX, IO).counts['same-session'] === 0, '3.4 空批次不抛(counts 全 0)');
check(sessionRelationBatch(null, CTX, IO).items.length === 0, '3.5 null 批次不抛');

// ══ 4) 门顺序断言(取行号,不写死)══════════════════════════════════════════════════════
section('4 · 门位置:register < gateSurgery < importBundle(取行号)');
{
  const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8').split(/\r?\n/);
  // 取**首次匹配行号**;`codeOnly` 用来跳过注释行 —— 门位置的注释里就写着 `memory.importBundle(`(历史说明),
  // 拿它当"落库行"会把顺序判反(实测先踩过:注释 3582 < 门 3587)。
  const lineOf = (re, codeOnly = false) => apiSrc.findIndex((l) => (codeOnly ? !/^\s*\/\//.test(l) : true) && re.test(l)) + 1;
  const Lregister = lineOf(/register\('\/import'/);
  const Lgate = lineOf(/endpoint:\s*'\/import'/, true);
  const Limport = lineOf(/memory\.importBundle\(/, true);
  check(Lregister > 0, '4.0 api.js 里找得到 register(\'/import\')');
  check(Lgate > 0, '4.0 api.js 里找得到 gateSurgery(... endpoint: \'/import\' ...)');
  check(Limport > 0, '4.0 api.js 里找得到 memory.importBundle(');
  check(Lregister < Lgate, `4.1 端点注册必须在门之前(${Lregister} < ${Lgate})`);
  check(Lgate < Limport,
    `★4.2 门必须在落库之前(${Lgate} < ${Limport});若门被后移 ⇒ 未持票也能换记忆`);
  // 门与落库必须挨在同一个 handler 里(不是"文件里随便找一行"),
  // 取法照 tests/veto.test.mjs 的 `gatedEpsInSrc()`:按 register() 切块,不按行号猜。
  const bodyStart = apiSrc.findIndex((l, i) => i + 1 >= Lregister && /\{/.test(l));
  const block = apiSrc.slice(Lregister - 1, Limport + 40).join('\n');
  check(bodyStart >= 0 && /gateSurgery\(req, res, sendJson/.test(block) && /memory\.importBundle\(/.test(block),
    '4.3 门与落库在 `/import` 的同一块里(块内两样都有)');
  check(Limport - Lgate < 50, '4.4 门紧贴落库(' + (Limport - Lgate) + ' 行)—— 中间不许插进落库前的写操作');
  // 反向失败信息(照 PLAN §5.3 的要求给人看)
  if (!(Lgate < Limport)) {
    console.log(`   门在 ${Lgate}、落库在 ${Limport}(差 ${Limport - Lgate} 行);L(gate) > L(importBundle) ⇒ 门被后移 = 未持票也能换记忆`);
  }

  // ★MF-6:三处模式的**命中计数**(照 PLAN §5.3 重写测试时必须仍绿)
  //   `memory.importBundle(` 在 api.js 里有 **2** 处命中:1 处是门位置的**注释**(历史说明),
  //   1 处是真落库行。PLAN §5.3 的"取首次匹配行号"没写"跳过注释" ⇒ 照抄会把 3582 行注释当落库行,
  //   正确实现被判红(`L(gate) < L(import)` 变成 `3587 < 3582` 假红),还会把人误导去改门的顺序。
  //   这里把"注释里有几处 / 代码里有几处"钉死,并把"取行号必须跳过 `//`"写成断言。
  const countOf = (re, codeOnly = false) => apiSrc.filter((l) => (codeOnly ? !/^\s*\/\//.test(l) : true) && re.test(l)).length;
  check(countOf(/register\('\/import'/) === 1, '★4.5 `register(\'/import\'` 在 api.js 里必须恰好 1 处,实际 ' + countOf(/register\('\/import'/));
  check(countOf(/endpoint:\s*'\/import'/) === 1 && countOf(/endpoint:\s*'\/import'/, true) === 1,
    '★4.5 `endpoint: \'/import\'` 必须恰好 1 处(且不在注释里),实际 ' + countOf(/endpoint:\s*'\/import'/) + '/' + countOf(/endpoint:\s*'\/import'/, true));
  check(countOf(/memory\.importBundle\(/) === 2 && countOf(/memory\.importBundle\(/, true) === 1,
    '★4.5 `memory.importBundle(` 必须"注释 1 + 代码 1"(照 PLAN §5.3 取首次命中会取到注释行),实际 '
      + countOf(/memory\.importBundle\(/) + '/' + countOf(/memory\.importBundle\(/, true));
  const commentImport = apiSrc.findIndex((l) => /^\s*\/\//.test(l) && /memory\.importBundle\(/.test(l)) + 1;
  check(commentImport > 0 && commentImport < Lgate,
    '★4.5 那处注释行确实在门之前(' + commentImport + ' < ' + Lgate + ')⇒ 不跳过注释就必然假红');
  check(Limport === apiSrc.findIndex((l, i) => i + 1 > commentImport && /memory\.importBundle\(/.test(l)) + 1,
    '★4.5 代码侧 `importBundle(` 命中 = 注释之后的第一处(取行号必须 codeOnly)');
}

// ══ 4b) ★MF-3:`GET /export` 必须真的转发三个条件段开关(接线断言,不靠"实现者记得")══════════
// 只把开关做进 `exportBundle()`、HTTP 面不转发 ⇒ 真 host 上 `tree_snapshot`/`forgotten` 永远打不开
// (16 表覆盖率最多 13/16),而直调 `exportBundle({includeSnapshots:true})` 的单测会全绿 —— 范围缺口被掩盖。
{
  const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8').split(/\r?\n/);
  const expStart = apiSrc.findIndex((l) => /register\('\/export'/.test(l));
  check(expStart >= 0, '4b.0 api.js 里找得到 register(\'/export\')');
  const nextRegister = apiSrc.findIndex((l, i) => i > expStart && /register\('/.test(l) && !/register\('\/export'/.test(l));
  const exportBlock = apiSrc.slice(expStart, nextRegister > expStart ? nextRegister : expStart + 60).join('\n');
  check(/memory\.exportBundle\(/.test(exportBlock), '4b.1 `/export` 块里确实调用了 memory.exportBundle(');
  for (const q of ['includeRaw', 'includeSnapshots', 'includeForgotten']) {
    check(new RegExp("q\\.get\\('" + q + "'\\)").test(exportBlock),
      '★4b.2 `/export` 块里必须转发 query `' + q + '`(现状缺一个 ⇒ 那张表端到端不可达)');
  }
}

// ══ 5) 「未持票不覆盖记忆」(现状应绿)+ 正对照 ═════════════════════════════════════════
section('5 · 未持票不覆盖记忆(已定型 + 无票 ⇒ 一个字节都不落)');
const { registerApi } = await imp('lib/host/api.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');
const { expectedCookieName } = await imp('lib/host/guard.js');
// ⚠️ 逃生开关是 `DSH_LING_GUARD==='off' || settings.guard.enforce===false` ⇒ 本节必须**确保没关**它,
//   否则每一条都会被整体放行(那是"假绿",不是门在工作)。
delete process.env.DSH_LING_GUARD;
/** 假请求必须**像真本机浏览器**:守卫要 cookie、手术门要 UA、且不能带代理头。
 *  三样缺一样,打的就不是"未持票"那一条(实测先踩过:缺 cookie ⇒ 403 no-cookie,缺 UA ⇒ surgery-local-only)。 */
const LOCAL_HEADERS = {
  host: '127.0.0.1:3080',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0',
  cookie: expectedCookieName('127.0.0.1:3080') + '=1',
};
const PHRASE = '这是我在定型时亲手写下的承诺句。';
const db = new MemoryStore(join(dir, 'm.db'));
const settings = new SettingsFile(join(dir, 'set'));
await settings.update({ persona: { sealed: true, sealPhrase: PHRASE, aiName: '器灵' } });
// 门的另一条输入是 `guard.enforce`(environment 'off' 会整体放行)⇒ 用 Proxy 覆写 get(),
// 不动环境变量(那会连带改掉别的语义)。照 tests/branch.test.mjs §7.8 的做法。
const settingsView = new Proxy(settings, {
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
const gateStub = {
  snapshotIds: () => [], snapshotOf: () => null, isRunning: () => false,
  pendingCount: () => 0, recentSessionId: () => null, markSnapStale: () => {},
};
const routes = new Map();
const fakeServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
registerApi({ get: (n) => (n === 'webServer' ? fakeServer : undefined) }, { gate: gateStub, memory: db, settings: settingsView }, { surgeryLog: join(dir, 'surgery.jsonl') });

const fire = (path, body, method = 'POST') => {
  const pathOnly = path.split('?')[0]; // 路由按路径注册;query 留在 req.url 上给 handler 读
  const handler = routes.get('/api/dsh-ling' + pathOnly);
  const req = new EventEmitter();
  req.url = path; req.method = method;
  req.headers = { ...LOCAL_HEADERS };
  const out = { status: 0, body: null };
  const res = {
    setHeader() {},
    end(payload) {
      out.status = this.statusCode;
      try { out.body = JSON.parse(String(payload ?? '{}')); } catch { out.body = null; }
    },
  };
  if (typeof handler !== 'function') {
    // 路由没挂上时**不抛**:合成 404 回执,让下面的断言逐条打红(看得见红在哪一条)
    return { out: { status: 404, body: { error: 'route-not-mounted', path } }, done: Promise.resolve() };
  }
  const done = handler(req, res);
  const payload = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  req.emit('data', Buffer.from(payload));
  req.emit('end');
  return { out, done };
};
const call = async (path, body, method = 'POST') => { const f = fire(path, body, method); await f.done; return f.out; };

const nightPkg = {
  format: 'dsh-ling-memory',
  identity_scope: { schema: 1, host: 'NIGHT-PC', user: 'someone', hostHash: 'deadbeefdead', packageId: '0011223344556677' },
  overviews: [{ conv_id: 'night-1', source: 'dsh', title: '夜里被偷塞的概述', overview_ok: true, summary: 'x' }],
  deepItems: [{ id: 'di:night-1', kind: '事实', text: '夜里被偷塞的结论', at: '2026-09-07T00:00:00Z', conv_id: 'night-1', src: 'dsh', origin: 'auto', branch_id: '' }],
};
const ovCount = () => Number(db.db.prepare('SELECT COUNT(*) AS n FROM conv_overview').get().n);
const diCount = () => Number(db.db.prepare('SELECT COUNT(*) AS n FROM deep_item').get().n);
const ovBefore = ovCount();
const diBefore = diCount();

const rNoTicket = await call('/import', { bundle: nightPkg, unlock: PHRASE });
check(rNoTicket.status === 200 && rNoTicket.body && rNoTicket.body.ok === false, '5.1 无票 ⇒ 200 + ok:false(实测 ' + rNoTicket.status + ')');
check(rNoTicket.body && rNoTicket.body.reason === 'sealed', '5.2 无票 ⇒ reason=sealed(既有客户端分支可用)');
check(rNoTicket.body && rNoTicket.body.surgery === 'surgery-ticket',
  '★5.3 无票 ⇒ surgery=surgery-ticket(判据在 surgery.js 一处),实际 ' + JSON.stringify(rNoTicket.body && rNoTicket.body.surgery));
check(rNoTicket.body && rNoTicket.body.report === undefined,
  '★5.4 被拒在门那一跳 ⇒ 回执里**没有** report(importBundle 一次都没执行)');
check(db.overviewById('dsh', 'night-1') === undefined, '★5.5 记忆表零落库:overviewById 必须 undefined(实测 ' + JSON.stringify(db.overviewById('dsh', 'night-1')) + ')');
check(db.deepItemById('di:night-1') === undefined, '★5.6 记忆表零落库:deepItemById 必须 undefined');
check(ovCount() === ovBefore && diCount() === diBefore,
  '★5.7 两张表行数不变(' + ovBefore + '/' + diBefore + ' → ' + ovCount() + '/' + diCount() + ')');

// 正对照:持票 + 原句对 ⇒ **真的落库**。没有这一条,5.x 的绿可能只是"路由没挂上/门永远拒"的假绿。
const tTicket = await call('/surgery/ticket', {}, 'POST');
const TICKET = tTicket.body && tTicket.body.ticket;
check(tTicket.status === 200 && /^[0-9a-f]{64}$/.test(String(TICKET)), '5.8 本机取票 ⇒ 200 + 64 位十六进制(实测 ' + String(TICKET || '').length + ')');
const rPass = await (async () => {
  const handler = routes.get('/api/dsh-ling/import');
  const req = new EventEmitter();
  req.url = '/import'; req.method = 'POST';
  req.headers = { ...LOCAL_HEADERS, 'x-dsh-ling-surgery': String(TICKET) };
  const out = { status: 0, body: null };
  const res = { setHeader() {}, end(p) { out.status = this.statusCode; try { out.body = JSON.parse(String(p ?? '{}')); } catch { out.body = null; } } };
  const done = handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ bundle: nightPkg, unlock: PHRASE })));
  req.emit('end');
  await done;
  return out;
})();
check(rPass.status === 200 && rPass.body && rPass.body.ok === true, '5.9 正对照:持票 + 原句对 ⇒ ok:true(实测 ' + rPass.status + ' ' + JSON.stringify(rPass.body && rPass.body.reason) + ')');
check(!!rPass.body && !!rPass.body.report && rPass.body.report.errors === 0, '5.9 正对照:回执里真的有 report 且 errors=0');
check(db.overviewById('dsh', 'night-1')?.title === '夜里被偷塞的概述', '5.9 正对照:概述真的落库(证明门后的路是通的)');
check(!!db.deepItemById('di:night-1'), '5.9 正对照:结论真的落库');
check(rPass.body && rPass.body.identity && rPass.body.identity.detected === 'foreign-host',
  '5.9 正对照:回执顶层就带 identity(外来包),实际 ' + JSON.stringify(rPass.body && rPass.body.identity && rPass.body.identity.detected));

// ══ 6) GET /deep/items 只增字段(无 sessionId 时响应逐字不变)════════════════════════════
section('6 · GET /deep/items?sessionId= 只增 relation 字段');
{
  db.upsertOverview({ conv_id: 's1', source: 'dsh', title: '当前会话', overview_ok: true, summary: 's' });
  // 会话身份可证实的"别的会话" —— 没有这一行它会退化成 unknown(conv-missing),那正是判据的顺序(PLAN §4.2)
  db.upsertOverview({ conv_id: 'other-1', source: 'dsh', title: '别的会话', overview_ok: true, summary: 's' });
  db.addDeepItem({ kind: '事实', text: '当前会话里的结论', at: '2026-09-07T00:00:00Z', convId: 's1', seqFrom: 1, seqTo: 1, src: 'dsh', origin: 'auto' });
  db.addDeepItem({ kind: '事实', text: '别的会话的结论', at: '2026-09-07T00:00:00Z', convId: 'other-1', seqFrom: 1, seqTo: 1, src: 'dsh', origin: 'auto' });
  const plain = await call('/deep/items', undefined, 'GET');
  check(plain.status === 200 && Array.isArray(plain.body.items) && plain.body.items.length >= 2, '6.0 GET /deep/items 正常返回');
  check(plain.body.items.every((it) => !Object.hasOwn(it, 'relation')),
    '★6.1 无 sessionId ⇒ **每一行都没有 relation 键**(响应逐字不变,既有消费者零回归)');
  const withRel = await call('/deep/items?sessionId=s1', undefined, 'GET');
  check(withRel.status === 200 && withRel.body.items.every((it) => it.relation && RELATION_TIERS.includes(it.relation.tier)),
    '6.2 给了 sessionId ⇒ 每行都有 relation 且 tier 在三档内');
  const same = withRel.body.items.find((it) => it.conv_id === 's1');
  const cross = withRel.body.items.find((it) => it.conv_id === 'other-1');
  check(same && same.relation.tier === 'same-session', '6.3 当前会话的条目 ⇒ same-session');
  check(cross && cross.relation.tier === 'cross-session', '6.4 别的会话且会话身份查不到 ⇒ cross-session(有 overview 才算,否则 unknown)');
  check(withRel.body.shown === plain.body.shown && withRel.body.all === plain.body.all,
    '6.5 只增字段:shown/all/retired 三个既有计数不变');
}

// ══ 7) ★MF-3:`GET /export?includeSnapshots=1&includeForgotten=1` 端到端可达 ═════════════════
// 4b 是接线断言(静态);这里是**真路由**打一遍:两个条件段在 HTTP 面真的能拿到,缺省仍不导。
section('7 · GET /export 的三个条件段开关端到端可达(16 表覆盖率的三个 opt-in)');
{
  db.snapshotTree({ name: '导出快照', note: '手动', kind: 'manual' });
  db.db.prepare('INSERT INTO forgotten (source,conv_id,at,reason,archive_path,actor) VALUES (?,?,?,?,?,?)')
    .run('dsh', 'forgotten-1', '2026-09-07T00:00:00Z', '测试遗忘', 'forgotten/dsh-forgotten-1', 'user');

  const expPlain = await call('/export', undefined, 'GET');
  check(expPlain.status === 200 && expPlain.body && Array.isArray(expPlain.body.overviews),
    '7.1 GET /export 正常返回整包(实测 ' + expPlain.status + ')');
  check(!Object.hasOwn(expPlain.body, 'snapshots') && !Object.hasOwn(expPlain.body, 'forgotten'),
    '7.2 缺省 ⇒ 两个条件段都不导(旧调用点语义不变)');
  const expAll = await call('/export?includeSnapshots=1&includeForgotten=1&includeRaw=1', undefined, 'GET');
  check(Array.isArray(expAll.body && expAll.body.snapshots) && expAll.body.snapshots.length >= 1,
    '★7.3 includeSnapshots=1 ⇒ 响应里真有 snapshots(实测 ' + JSON.stringify(expAll.body && expAll.body.snapshots && expAll.body.snapshots.length) + ')');
  check(Array.isArray(expAll.body && expAll.body.forgotten) && expAll.body.forgotten.length >= 1,
    '★7.4 includeForgotten=1 ⇒ 响应里真有 forgotten(实测 ' + JSON.stringify(expAll.body && expAll.body.forgotten && expAll.body.forgotten.length) + ')');
  check(Array.isArray(expAll.body && expAll.body.rawTurns), '★7.5 includeRaw=1 ⇒ 响应里真有 rawTurns');
  check(expAll.body && expAll.body.manifest && expAll.body.manifest.includeSnapshots === true
    && expAll.body.manifest.includeForgotten === true,
    '7.6 manifest.include* 与段存在性双向一致');

  // ★7.7 R9(1.9 残余 · M8):7.6 的"双向"原先**只测了一个方向**(开了 ⇒ flag true)。
  //   缺的另一半:① 缺省 ⇒ 三个 flag 必须都是 false(且三段都不在)—— 否则"manifest 永远写 true"
  //   的实现能蒙混过关(段不导、flag 说导了);② 单开一个 ⇒ 只有对应的那一段与那一个 flag,
  //   证明三个开关**互不串台**(打开 snapshots 不许顺带把 forgotten 也导出去)。
  check(expPlain.body && expPlain.body.manifest && expPlain.body.manifest.includeRaw === false
    && expPlain.body.manifest.includeSnapshots === false && expPlain.body.manifest.includeForgotten === false,
    '★7.7 缺省 ⇒ 三个 include* flag 必须全是 false(反向),实际 ' + JSON.stringify(expPlain.body && expPlain.body.manifest));
  check(!Object.hasOwn(expPlain.body, 'rawTurns'), '★7.7 缺省 ⇒ rawTurns 段也不存在');

  const expRaw = await call('/export?includeRaw=1', undefined, 'GET');
  check(expRaw.body && expRaw.body.manifest && expRaw.body.manifest.includeRaw === true
    && expRaw.body.manifest.includeSnapshots === false && expRaw.body.manifest.includeForgotten === false,
    '★7.7 只开 includeRaw ⇒ 只有 includeRaw=true,实际 ' + JSON.stringify(expRaw.body && expRaw.body.manifest));
  check(Array.isArray(expRaw.body && expRaw.body.rawTurns)
    && !Object.hasOwn(expRaw.body, 'snapshots') && !Object.hasOwn(expRaw.body, 'forgotten'),
    '★7.7 只开 includeRaw ⇒ 只有 rawTurns 段(另两段仍不存在)');

  const expSnap = await call('/export?includeSnapshots=1', undefined, 'GET');
  check(expSnap.body && expSnap.body.manifest && expSnap.body.manifest.includeSnapshots === true
    && expSnap.body.manifest.includeRaw === false && expSnap.body.manifest.includeForgotten === false,
    '★7.7 只开 includeSnapshots ⇒ 只有 includeSnapshots=true,实际 ' + JSON.stringify(expSnap.body && expSnap.body.manifest));
  check(Array.isArray(expSnap.body && expSnap.body.snapshots)
    && !Object.hasOwn(expSnap.body, 'rawTurns') && !Object.hasOwn(expSnap.body, 'forgotten'),
    '★7.7 只开 includeSnapshots ⇒ 只有 snapshots 段');

  const expForg = await call('/export?includeForgotten=1', undefined, 'GET');
  check(expForg.body && expForg.body.manifest && expForg.body.manifest.includeForgotten === true
    && expForg.body.manifest.includeRaw === false && expForg.body.manifest.includeSnapshots === false,
    '★7.7 只开 includeForgotten ⇒ 只有 includeForgotten=true,实际 ' + JSON.stringify(expForg.body && expForg.body.manifest));
  check(Array.isArray(expForg.body && expForg.body.forgotten)
    && !Object.hasOwn(expForg.body, 'rawTurns') && !Object.hasOwn(expForg.body, 'snapshots'),
    '★7.7 只开 includeForgotten ⇒ 只有 forgotten 段');
  check(expAll.body && expAll.body.manifest && expAll.body.manifest.includeRaw === true,
    '★7.7 三开 ⇒ includeRaw 也必须是 true(三个方向都断言,不只 snapshots/forgotten)');
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────────────
try { db.close(); } catch { /* noop */ }
if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome;
try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响判据 */ }
console.log('\n断言 ' + assertions + ' 条,失败 ' + failures + ' 条');
if (failures) {
  console.log('↑ 有红:三档/门顺序/未持票这三件事都是"静默就会出事"的类型,别靠放宽断言让它变绿。');
  process.exitCode = 1;
} else {
  console.log('✓ relation-19 全部通过 —— 三档快照 / 门顺序 / 未持票不覆盖记忆');
}
