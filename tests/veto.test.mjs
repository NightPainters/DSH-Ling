// M5 · V1 人格层否决权(1.8.0)── 测试套 #64
//
// 依据:DESIGN-1.8.0-三新模块 §4(留痕四字段 / 三条防故障 / 六条验收)
//      + m5-survey/V-MAP.md §7(状态机)· §8(kv schema)· §9(六条验收可执行断言)· §10(六个变异)
//
// 六组(顺序与交办单一致):
//   1) pending 期注入文本不变(assemblePersona 逐字节相同 + settings 深比较不变)
//   2) veto 留痕四字段 {at, decision, reason, fields},且**值不落盘** + afterDigest
//   3) 强制必须两跳(第 1 跳零写入 + 回 forceToken)→ 第 2 跳才执行 + `veto-overridden`
//   4) 非人格层(语气 / habitsPending / 代码配置)不进 pending + 工具通道三条查否决状态
//   5) approved 之后**缺票据仍拒**(门独立生效)+ nonce 未被消费
//   6) `veto-blocked` 反向留痕(不改 state、不放行任何写)
// 另有第 0 组 = **14 条门面 / 14 条否决面机械断言**(每条否决面 handler 块含 `gateSurgery(` + 门后 `vetoConsume`),
//   以及 `surgery.js` 覆盖面清单行数 = 14 —— `/mode/toggle` **不在门面内**(M24b:全局半边 = confirm:true + 宿主认证(远端允许);
//   会话半边 rc.4 起免门)⇒ 门面与否决面自 M24 起同为 14 条。
//   这正是 survey C7 指出的"删一条调用点测试不会红"的补丁(M7 曾把 14 拆成 15/14,M24 又并回 14/14)。
//
// ⚠️ 本文件**不起 HTTP 服务**:门判据直接调 `requireSurgery`(与 api.js 调的是同一个函数),
//   "approved 之后缺票据仍拒"因此验的是**同一条判据**,不是复刻品。
// ⚠️ 全部落在 mkdtempSync 临时目录(DSH_HOME 在 import surgery.js **之前**设好)⇒ 绝不读写 ~/.dsh。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const holder = mkdtempSync(join(tmpdir(), 'dsh-ling-veto-'));
process.env.DSH_HOME = holder;          // 票据 / 手术留痕都落到临时目录
delete process.env.DSH_LING_GUARD;      // 逃生开关不许在本套里生效

const { MemoryStore } = await imp('lib/host/memory.js');
const { assemblePersona } = await imp('lib/host/persona.js');
const S = await imp('lib/host/surgery.js');
const {
  vetoConsume, vetoAction, vetoArgsOf, vetoPatchOf, vetoKeysOf, vetoStatusFor, vetoKvBadCount,
  requireSurgery, readSurgeryTicket, VETO_PERSONA_KEYS, VETO_KV_PREFIX, VETO_REASON_CONFIRM,
  personaDigest, VETO_REASON_UNSEAL_EXTRA, VETO_REASON_UNSEAL,   // ← rc.3(F4 / §14.2 的 afterDigest 精算)
} = S;
const {
  registerLingTools, TOOL_LING_VETO, TOOL_RULE_ADD, checkLingVeto, LING_VETO_SPEC,
} = await imp('lib/host/tools.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) return;
  failures += 1;
  console.error('  ✗ ' + msg);
};
const sha16 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const J = (v) => JSON.stringify(v);

const dbDir = mkdtempSync(join(tmpdir(), 'dsh-ling-veto-db-'));
let dbSeq = 0;
/** 每组一条独立库:组之间不许互相喂状态(否则 pending/否决记录会串味)。 */
const newMem = () => new MemoryStore(join(dbDir, 'm' + (++dbSeq) + '.db'));

/** 一份"已定型"的假 settings(update 做 persona/styles 浅合并 —— 与 /persona 的写入口同语义)。
 *  ⚠️ m19-fix(MF-1):这里**必须**数写点。修前本套里的"settings 一个字节没动 / 零落库"是**恒真断言**
 *  (`vetoConsume` 全文零处 `settings.update`,那几条 `state.persona.*` 断言的左侧永真) —— 审计 S5
 *  「可被 `check(true)` 空转」换了个形状复发。现在 `update` 每被调用一次 `stats.updateCalls` +1,
 *  `stats` 是**活对象**(引用返回),所以"零落库"变成可失败判据:谁在 `vv.ok===false` 之后写,它就红。 */
function mkSettings(over = {}) {
  const state = {
    persona: {
      aiName: '小灵', aiTitle: '器灵', userTitle: '主人', pronoun: '你', duty: '',
      bottomLines: [], sealed: true, sealPhrase: '那句话', hardRules: [], habits: [], tone: 'natural',
      enabled: true, ...over,
    },
    styles: { work: '', life: '' },
    mode: { lastMode: 'life' },
    guard: { enforce: true },
  };
  const stats = { updateCalls: 0, patches: [] };
  const settings = {
    get: () => state,
    update: async (patch) => {
      stats.updateCalls += 1;                       // ← 真写点计数(零落库判据的唯一来源)
      stats.patches.push(patch);
      if (patch && typeof patch === 'object') {
        if (patch.persona && typeof patch.persona === 'object') state.persona = { ...state.persona, ...patch.persona };
        if (patch.styles && typeof patch.styles === 'object') state.styles = { ...state.styles, ...patch.styles };
      }
      return state;
    },
  };
  return { state, settings, stats };
}

/** 复刻 `/persona` handler 的两步(`api.js:2238-2239` → `:2267`):`vv.ok === false` ⇒ 直接拒、**不写**;
 *  只有 `vv.ok === true` 才 `settings.update(patch)`。`vetoConsume` 本身从不写 settings(它是判据层),
 *  所以"零落库"只在**这一层**才有意义 —— 用它把"守卫拒了 ⇒ 端点写不进去"从读代码变成跑过。 */
async function handlerAfterVeto(vv, settings, patch) {
  if (!vv.ok) return { written: false };
  await settings.update(patch);
  return { written: true };
}

/** 一条待表态记录(主人显式提议:`veto:{propose:true}`)。 */
function propose(settings, memory, patch, veto = { propose: true }, endpoint = '/persona') {
  return vetoConsume({ settings, memory, gated: true, endpoint, patch, veto });
}

// ══ 0) 14 条门面 / 14 条否决面机械断言(交办单硬要求;也是 survey C7 的补丁)══════════════
console.log('▶ 0) 14 条门面逐条接上手术门 + 14 条否决面接上否决状态机');
{
  const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const blockOf = (route) => {
    const i = apiSrc.indexOf(`register('${route}'`);
    if (i < 0) return '';
    const j = apiSrc.indexOf('disposers.push(register(', i + 10);
    return apiSrc.slice(i, j < 0 ? apiSrc.length : j);
  };
  // ── MF-9(本次闭合):端点清单**从 api.js 解析**,不再自比一张字面量 ──────────────────────
  //   修前 `EPS.length === 14` 是恒真断言(数组就是那 14 个字面量写的):删掉一个 handler 块里的
  //   gateSurgery 也不会红,这张"覆盖面表"只是抄写。现在:扫描 api.js 的所有 `register('<route>'`,
  //   取 handler 块内含 `gateSurgery(` 的那些 ⇒ 必须**恰好**等于期望的门面(多一条/少一条都红)。
  const gatedEpsInSrc = () => {
    const out = [];
    const re = /register\('([^']+)'/g;
    let m;
    while ((m = re.exec(apiSrc)) !== null) {
      const start = m.index;
      const next = apiSrc.indexOf('disposers.push(register(', start + 10);
      const block = apiSrc.slice(start, next < 0 ? apiSrc.length : next);
      if (/gateSurgery\(/.test(block)) out.push(m[1]);
    }
    return out;
  };
  // ── M24:`/mode/toggle` 移出门面 ⇒ **门面 14 条 = 否决面 14 条** ─────────────────────────────
  //   它在 M7 曾由"已知例外"并进手术门(档位/模型写面,而 `mode.*` 不在 VETO_PERSONA_KEYS 这 10 键内
  //   ⇒ 只过门、不享否决权);M24b 把全局半边降为「confirm:true + 宿主认证(远端允许)」(会话半边 rc.4 起就免门)
  //   ⇒ 两半边都**不在门面内**,`/mode/toggle` 与两张清单同时脱钩。
  const EPS = [
    '/persona', '/persona/check', '/persona/self-summary', '/persona/hint-adopt',
    '/persona/rule', '/persona/habit', '/persona/habits/scan', '/persona/habits/reflect',
    '/persona/grow', '/persona/rollback', '/persona/genesis',
    '/feedback/apply', '/suggestions/apply', '/import',
  ];
  /** 否决面 = 门面(M24 起两者同为 14 条,与 V1 的 10 键白名单对齐)。 */
  const VETO_EPS = EPS.slice();
  const EPS_PARSED = gatedEpsInSrc();
  check(EPS_PARSED.length === 14,
    '前置:api.js 里接了 gateSurgery 的端点 = 14 条(实测 ' + EPS_PARSED.length + ':' + EPS_PARSED.join(',') + ')');
  check(J(EPS_PARSED.slice().sort()) === J(EPS.slice().sort()),
    '前置:解析出的端点集合 = 期望的 14 条(不是恒真的字面量自比)—— 实测 ' + J(EPS_PARSED.slice().sort()));
  check(VETO_EPS.length === 14,
    '前置:否决面 = 门面 = 14 条(M24 起 `/mode/toggle` 不在门面内;实测 ' + VETO_EPS.length + ')');
  for (const ep of VETO_EPS) {
    const b = blockOf(ep);
    check(b.length > 0, `前置:找得到 ${ep} 的 handler 块`);
    check(/gateSurgery\(/.test(b), `★${ep}:handler 块内接了 gateSurgery(`);
    check(/vetoConsume\(\{ settings, memory, req \}\)/.test(b), `★${ep}:门**之后**调 vetoConsume({settings,memory,req})`);
    check(/if \(!vv\.ok\) return vetoReject\(res, sendJson, vv\);/.test(b), `★${ep}:否决未通过时立刻 return(写面不动)`);
    check(new RegExp('veto: vetoArgsOf\\((body|parsed)\\)').test(b), `★${ep}:把否决票据交给门(交参)`);
  }
  // ── MF-3:每个端点的**交参字段集**进机械断言(修前组 0 只查 gateSurgery/vetoConsume/vetoArgsOf,
  //   把 `/persona` 的 `patch: vetoPatchOf(body)` 删成 `patch: {}` ⇒ 否决面整体失效而 64 个脚本全绿)──────
  const gateCallOf = (b) => {
    const i = b.indexOf('gateSurgery(req, res, sendJson');
    if (i < 0) return '';
    const j = b.indexOf('const vv = vetoConsume', i);
    return b.slice(i, j < 0 ? b.length : j);
  };
  /** 从门调用里取出 `patch:` 的表达式(支持 `{...}` 与 `vetoPatchOf(body)` 两种形状)。 */
  const patchExprOf = (call) => {
    const i = call.indexOf('patch:');
    if (i < 0) return '';
    const s = call.slice(i + 'patch:'.length).trimStart();
    if (!s.startsWith('{')) return s.split(/,\s*(?:keys|whole|veto|endpoint)\s*:/)[0].trim();
    let depth = 0;
    for (let k = 0; k < s.length; k += 1) {
      if (s[k] === '{') depth += 1;
      else if (s[k] === '}') { depth -= 1; if (!depth) return s.slice(0, k + 1); }
    }
    return s;
  };
  const keysListOf = (call) => {
    const m = call.match(/keys:\s*\[([^\]]*)\]/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
  };
  /** 静态解析字面 patch 里的 persona 字段名(`vetoPatchOf(...)` 交给运行时归一器验)。 */
  const personaKeysOfExpr = (expr) => {
    if (!expr) return [];
    if (/vetoPatchOf\(/.test(expr)) return 'BODY';
    const m = expr.match(/persona\s*:\s*\{([^{}]*)\}/);
    if (!m) return [];
    return [...m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
  };
  const EXPECT_KEYS = {
    '/persona': 'BODY',                        // 整份 body 交给 vetoPatchOf ⇒ 字段集由归一器算
    '/persona/check': [],                      // patch: {} ⇒ 不碰 10 键
    '/persona/self-summary': ['aiTitle'],
    '/persona/hint-adopt': ['habits'],
    '/persona/rule': ['hardRules'],
    '/persona/habit': ['habits'],
    '/persona/habits/scan': ['habitsPending'],   // 碰到 persona 子树、但**不在** 10 键白名单
    '/persona/habits/reflect': ['habitsPending'],
    '/persona/grow': ['tone'],                   // ditto(tone 被 CEO-AUTH §2 排除)
    '/persona/rollback': 'WHOLE',
    '/persona/genesis': [],
    // MF-5(已闭合):两处 apply 交的是**字段名** `keys`(值在门这一跳不可知),不是 `body.id`。
    //   `/feedback/apply` 实际落 habits(feedback.js:211 → proposeHabit,不是 hardRules);
    //   `/suggestions/apply` 的 kind 门后才读 ⇒ aiName / userTitle / habits 三种落点都要在否决面内。
    '/feedback/apply': ['habits'],
    '/suggestions/apply': ['aiName', 'userTitle', 'habits'],
    '/import': 'IMPORT',                         // whole 由 `parsed.persona === true` 动态决定
  };
  // ⚠️ MF-3 的"交参字段集"只对**否决面**有意义:`/mode/toggle` 不在 EXPECT_KEYS 里(它不交 patch)。
  for (const ep of VETO_EPS) {
    const call = gateCallOf(blockOf(ep));
    check(call.length > 0, `★MF-3 ${ep}:找得到门调用`);
    const expr = patchExprOf(call);
    const declaredKeys = keysListOf(call);
    const got = declaredKeys || personaKeysOfExpr(expr);
    const want = EXPECT_KEYS[ep];
    if (want === 'BODY') {
      check(/vetoPatchOf\(/.test(expr), '★MF-3 ' + ep + ':交参是整份 body(vetoPatchOf(body)),不是被写死的空对象');
      check(J(vetoKeysOf(vetoPatchOf({ persona: { aiTitle: 'x' } }))) === J(['aiTitle']),
        '★MF-3 /persona:vetoPatchOf ⇒ 归一器能从中挑出 persona 字段(aiTitle)');
      check(J(vetoKeysOf(vetoPatchOf({ persona: { sealed: false } }))) === J(['sealed']),
        '★MF-3 /persona:撤锁那一跳只命中 sealed(MF-2 的前置事实)');
    } else if (want === 'WHOLE') {
      check(/whole:\s*true/.test(call), '★MF-3 /persona/rollback:交参带 whole:true(整体回写 ⇒ 全 10 键)');
      check(vetoKeysOf({}, { whole: true }).length === 10, '★MF-3 /persona/rollback:whole ⇒ 10 键全在否决面内');
    } else if (want === 'IMPORT') {
      check(/whole:\s*parsed\.persona === true/.test(call), '★MF-3 /import:whole 由 `parsed.persona === true` 动态决定');
    } else {
      check(J(got) === J(want), '★MF-3 ' + ep + ':交参字段集 = ' + J(want) + '(实测 ' + J(got) + ')');
      // 交集才是"否决面会不会真的进"(habitsPending / tone 这类进不了 10 键)
      check(J(got.filter((k) => VETO_PERSONA_KEYS.includes(k))) === J(want.filter((k) => VETO_PERSONA_KEYS.includes(k))),
        '★MF-3 ' + ep + ':交参与 10 键白名单的交集对得上');
    }
  }
  // ── M24b(反转)**负向断言**:`/mode/toggle` **不在**门面内,也**不再有**本机限制 ──────────────
  //   M7 时它是"第 15 条门面";M24b 起全局半边改「confirm:true + 宿主认证(远端允许)」、会话半边 rc.4 起免门
  //   ⇒ 必须**移出门面**(块内不许再出现 gateSurgery)。谁把门加回任一半边,下面这条 + EPS_PARSED 都会红。
  {
    const tb = blockOf('/mode/toggle');
    check(tb.length > 0, '★M24 /mode/toggle:找得到 handler 块');
    check(!/gateSurgery\(/.test(tb), '★M24 /mode/toggle:块内**不再**有 gateSurgery(两半边都免门)');
    check(!EPS_PARSED.includes('/mode/toggle'), '★M24 /mode/toggle:已移出门面(解析结果里不含它)');
    check(!/readIsLocal\(req\)/.test(tb), '★M24b /mode/toggle:全局半边不写死本机判据(远端也可设新会话默认)');
    check(!/if \(!readIsLocal\(req\)\) return sendJson\(res, 403/.test(tb), '★M24b /mode/toggle:全局半边不挂 local-only 403 闸(远端也可设新会话默认)');
    check(!/vetoConsume\(/.test(tb), '★M24 /mode/toggle:块内不含 vetoConsume(档位写面不享否决权)');
    check(!/vetoReject\(/.test(tb), '★M24 /mode/toggle:块内不含 vetoReject(同上)');
  }
  // ── MF-5(已闭合):两处 apply 端点交**字段名**(`keys`),不再拿 `body.id`(建议行号)冒充字段值。
  //   值要到 handler 里从库里读出来才知道 ⇒ 引擎落 fields='unknown' / afterDigest=null
  //   (surgery.js vetoFieldsOf(...,{explicit}) / vetoProjection)。修前这里是"已知缺陷仍在"的登记,
  //   现在改成**闭合断言**:有 `keys:`、且门调用里没有 `body.id` / `字段: body.id` 这种冒充。
  const APPLY_KEYS = { '/feedback/apply': ['habits'], '/suggestions/apply': ['aiName', 'userTitle', 'habits'] };
  for (const ep of Object.keys(APPLY_KEYS)) {
    const call = gateCallOf(blockOf(ep));
    check(call.length > 0, `★MF-5 ${ep}:找得到门调用`);
    check(J(keysListOf(call)) === J(APPLY_KEYS[ep]),
      `★MF-5 ${ep}:交参是字段名 keys=${J(APPLY_KEYS[ep])}(实测 ${J(keysListOf(call))})`);
    check(!/body\.id/.test(call), `★MF-5 ${ep}:门调用里不再出现 body.id(行号冒充字段值)`);
    check(!/\b(?:hardRules|habits|aiName|userTitle)\s*:\s*body\.id/.test(call),
      `★MF-5 ${ep}:没有「字段: body.id」这种把行号当值的写法`);
    // keys-only ⇒ 引擎必须记 unknown;执行时 afterDigest=null(端到端验一次形状,不 mock)
    const m5mem = newMem();
    const { settings: m5set } = mkSettings();
    const r = vetoConsume({
      settings: m5set, memory: m5mem, gated: true, endpoint: ep, patch: {}, keys: APPLY_KEYS[ep],
      veto: { propose: true },
    });
    check(r.ok === false && r.reason === 'veto-pending', `★MF-5 ${ep}:keys-only 提议 ⇒ 仍开 pending 记录`);
    const recNew = JSON.parse(String(m5mem.kvGet(VETO_KV_PREFIX + r.id)));
    check(J(Object.keys(recNew.fields || {})) === J(APPLY_KEYS[ep]),
      `★MF-5 ${ep}:记录 fields 只含字段名(实测 ${J(Object.keys(recNew.fields || {}))})`);
    check(Object.values(recNew.fields || {}).every((v) => v === 'unknown'),
      `★MF-5 ${ep}:值未知 ⇒ 每条指纹都是 'unknown',不拿旧值/行号冒充(实测 ${J(recNew.fields)})`);
    const ap = vetoAction({ memory: m5mem, settings: m5set, action: 'approve', id: r.id });
    check(ap.ok === true && ap.oneShot === true, `★MF-5 ${ep}:她同意(approve)⇒ 一次性 nonce`);
    const done = vetoConsume({
      settings: m5set, memory: m5mem, gated: true, endpoint: ep, patch: {}, keys: APPLY_KEYS[ep],
      veto: { id: r.id, nonce: ap.nonce },
    });
    check(done.ok === true && done.applied === true, `★MF-5 ${ep}:持票执行放行(实测 ${J(done.reason || done.applied)})`);
    const recDone = JSON.parse(String(m5mem.kvGet(VETO_KV_PREFIX + r.id)));
    check(recDone.afterDigest === null && recDone.afterDigestKnown === false,
      `★MF-5 ${ep}:执行后 afterDigest=null + afterDigestKnown=false(实测 ${J(recDone.afterDigest)}/${J(recDone.afterDigestKnown)})`);
  }
  // 清单行数 = 14(surgery.js:15 的口径:条数一律以清单行数为准;M7 曾 15,M24 移出 `/mode/toggle` ⇒ 14)
  const ssrc = readFileSync(join(root, 'lib/host/surgery.js'), 'utf8');
  const listRows = ssrc.split('\n').filter((l) => /^\s*\/\/\s+\d+\s+\//.test(l));
  check(listRows.length === 14, `★覆盖面清单行数 = 14(实测 ${listRows.length})`);
  // 清单不许悄悄变多/变少:唯一一条例外(`/inject`)必须**写在注释里**,不许偷偷并进清单
  check(/\+ 1 条已知例外/.test(ssrc), '★surgery.js:15 口径改成「14 条 + 1 条已知例外」');
  check(/\/inject/.test(ssrc), '★例外逐字点名(/inject)');
  // ⚠️ M24 起 `/mode/toggle` **不在清单里**(全局半边改 confirm:true + 宿主认证、会话半边免门)⇒ 反向断言:它不许出现。
  check(!listRows.some((l) => l.includes('/mode/toggle')), '★/mode/toggle 已移出覆盖面清单(门面 14 条)');
  // MF-9(本次闭合):唯一一条例外**逐条**验 handler 块 —— 它不在 V1 否决面内,块内不许出现 `vetoConsume(`。
  //   否则"15 + 1 例外"的口径会在没人改注释的情况下失真(例外悄悄进了否决面 / 清单悄悄漏了谁)。
  for (const ex of ['/inject']) {
    const eb = blockOf(ex);
    check(eb.length > 0, `★例外 ${ex}:找得到 handler 块`);
    check(!/vetoConsume\(/.test(eb), `★例外 ${ex}:handler 块内不含 vetoConsume(不在 14 条否决面内)`);
  }
  // 10 键白名单且含 hardRules/habits
  check(VETO_PERSONA_KEYS.length === 10
    && ['aiName', 'aiTitle', 'userTitle', 'pronoun', 'duty', 'bottomLines', 'sealed', 'sealPhrase', 'hardRules', 'habits'].every((k) => VETO_PERSONA_KEYS.includes(k)),
    '★人格层字段白名单 = 10 键(含 hardRules/habits)');
}

// ══ 1) pending 期注入面逐字节不变 ══════════════════════════════════════════════════════
console.log('▶ 1) pending 期:写请求不生效、注入面仍是旧文本');
const memA = newMem();
const A = mkSettings();
let pendingId = '';
{
  const { settings } = A;
  const before = assemblePersona(settings.get(), 'life');
  const beforePersona = J(settings.get().persona);
  const r = propose(settings, memA, { persona: { aiTitle: '不该落盘的新自述' } });
  check(r.ok === false && r.reason === 'veto-pending', '提议 ⇒ 回 veto-pending(实测 ' + J(r.reason) + ')');
  check(/^v[0-9a-z]+-[0-9a-f]{8}$/.test(String(r.id)), '回执带 id(实测 ' + r.id + ')');
  pendingId = r.id;
  check(assemblePersona(settings.get(), 'life') === before, '★注入面文本**逐字节**不变(assemblePersona 前后 ===)');
  check(J(settings.get().persona) === beforePersona, '★settings.persona 深比较不变(一个字节都没写)');
  // 同一字段**再写一次**(这次连 propose 都不带)⇒ 仍被 pending 拦住,不许"偷偷生效"
  const r2 = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: '偷偷改' } }, veto: {} });
  check(r2.ok === false && r2.reason === 'veto-pending' && r2.id === pendingId, 'pending 期间同字段的后续写 ⇒ 仍 veto-pending(同一个 id)');
  check(assemblePersona(settings.get(), 'life') === before, '★第二次也没生效(注入面依旧 ===)');
  check(J(settings.get().persona) === beforePersona, '★第二次也没写 settings');
  // list 只读
  const ls = vetoAction({ memory: memA, action: 'list' });
  check(ls.ok === true && ls.count >= 1 && ls.items.some((it) => it.id === pendingId && it.state === 'pending'), 'list:看得见这条 pending');
  check(ls.items.every((it) => Array.isArray(it.fields) && it.layer === 'persona'), 'list:每条都带 fields / layer');
}

// ══ 2) veto:四字段留痕 + 值不落盘 ═════════════════════════════════════════════════════
console.log('▶ 2) veto:kv `veto.<id>` 四字段齐、值不落盘、afterDigest');
const vetoedId = pendingId;
{
  const { settings } = A;
  const reason = '这条自述我不想改';
  const r = await vetoAction({ memory: memA, settings, action: 'veto', id: pendingId, reason });
  check(r.ok === true && r.state === 'vetoed' && r.decision === 'veto', 'veto ⇒ pending→vetoed(实测 ' + J(r.state) + ')');
  const raw = String(memA.kvGet(VETO_KV_PREFIX + pendingId));
  check(!!raw && raw !== 'undefined', '★kv 里确实有 ' + VETO_KV_PREFIX + pendingId + '(不是 undefined —— memory.js:2328 的语义)');
  const rec = JSON.parse(raw);
  check(typeof rec.at === 'string' && !Number.isNaN(Date.parse(rec.at)), '★四字段① at(提议时刻,实测 ' + rec.at + ')');
  check(rec.decision === 'veto', '★四字段② decision = veto');
  check(rec.reason === reason, '★四字段③ reason = 我的否决理由');
  check(!!rec.fields && typeof rec.fields === 'object' && Object.keys(rec.fields).includes('aiTitle'),
    '★四字段④ fields = 涉及字段名(实测 ' + J(Object.keys(rec.fields || {})) + ')');
  // 值不落盘(V-MAP §8 硬断言):每个 value 只能是指纹/类型,不能是原文
  const FPRULE = /^(s:[0-9a-f]{16}|null|a\d+|string|number|boolean|object|undefined)$/;
  check(Object.values(rec.fields).every((v) => FPRULE.test(String(v))), '★fields 的值全是指纹/类型(实测 ' + J(rec.fields) + ')');
  check(!raw.includes('不该落盘的新自述') && !raw.includes('小灵'), '★原文一个字都没落盘(new aiTitle / 当前 aiName 都不在 kv 里)');
  check(!/"patch"\s*:/.test(raw) && !/"value"\s*:/.test(raw), '★proposal 里没有 patch/value 这类真值字段');
  check(/^[0-9a-f]{16}$/.test(String(rec.afterDigest)), '★额外写 afterDigest(16 位,实测 ' + rec.afterDigest + ')');
  check(rec.afterDigest === sha16(J(settings.get().persona)), '★afterDigest = sha256(JSON.stringify(settings.persona)) 前 16 位');
  check(rec.state === 'vetoed' && Object.keys(rec.proposal || {}).length > 0, 'proposal 摘要存在(只含 endpoint/patchKeys/digest/chars)');
  // 否决后同字段写仍然不生效
  const r2 = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: '绕过否决' } }, veto: {} });
  check(r2.ok === false && r2.reason === 'veto-vetoed', '否决后不生效 ⇒ veto-vetoed');
}

// ══ 3) 强制:两次确认才执行 + veto-overridden ═══════════════════════════════════════════
console.log('▶ 3) 强制覆盖:第 1 跳零写入、第 2 跳才执行 + `veto-overridden`');
{
  const { settings, stats } = A;
  const patch = { persona: { aiTitle: '主人坚持要改成的自述' } };
  const beforePersona = J(settings.get().persona);
  const beforeText = assemblePersona(settings.get(), 'life');
  // 只带 confirm(不带 token)⇒ 第 1 跳:发一次性 forceToken,**零写入**
  const hop1 = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch, veto: { id: vetoedId, confirm: true } });
  check(hop1.ok === false && hop1.reason === 'veto-confirm-required', '第 1 跳 ⇒ veto-confirm-required(实测 ' + J(hop1.reason) + ')');
  check(/^[0-9a-f]{64}$/.test(String(hop1.forceToken)), '第 1 跳回一次性 forceToken(32 字节 hex)');
  // ── m23-1 / N1 恒真清理:修前这行是 `J(settings.get().persona) === beforePersona` —— `vetoConsume`
  //    是**判据层**、全文零处 `settings.update`(surgery.js 只有 `:1199` 的注释提到它),所以"一个字节没变"
  //    的左侧永真。按 §14.2 模板(`:890-892`)改成**端点两步 + 写点计数**:`handlerAfterVeto` 复刻
  //    `api.js` 的 `if (!vv.ok) return` ⇒ 才写,`stats.updateCalls` 是 `mkSettings().update` 的真实计数。
  const hop1Write = await handlerAfterVeto(hop1, settings, patch);
  check(hop1Write.written === false && stats.updateCalls === 0,
    '★第 1 跳**零写入**:端点两步也不写(实测 written=' + J(hop1Write.written)
      + '/updateCalls=' + J(stats.updateCalls) + ')');
  check(assemblePersona(settings.get(), 'life') === beforeText, '★第 1 跳注入面不变');
  // 不带 confirm 的普通重试:仍拒(vetoed 不会自己失效)
  const plain = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch, veto: {} });
  check(plain.ok === false && plain.reason === 'veto-vetoed', '不带 confirm 的重试仍 veto-vetoed');
  // 带 confirm + 错的 token ⇒ 仍拒
  const wrong = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch, veto: { id: vetoedId, confirm: true, token: 'f'.repeat(64) } });
  check(wrong.ok === false && wrong.reason === 'veto-confirm-required', 'confirm 对、token 错 ⇒ 仍不放行');
  check(J(settings.get().persona) === beforePersona, 'token 错的那次也没写');
  // 带 confirm + 对的 token ⇒ 第 2 跳放行
  const hop2 = vetoConsume({ settings, memory: memA, gated: true, endpoint: '/persona', patch, veto: { id: vetoedId, confirm: true, token: hop1.forceToken } });
  check(hop2.ok === true && hop2.overridden === true && hop2.decision === 'veto-overridden',
    '★第 2 跳才放行 + decision=veto-overridden(实测 ' + J(hop2.decision) + ')');
  // 端点在这之后才写(与本文件 mkSettings().update 同语义)
  await settings.update(patch);
  const rec = JSON.parse(String(memA.kvGet(VETO_KV_PREFIX + vetoedId)));
  check(rec.state === 'overridden' && rec.decision === 'veto-overridden', '★留痕:state=overridden + decision=veto-overridden');
  check(rec.afterDigest === sha16(J(settings.get().persona)), '★afterDigest 与**落库后**的人格对得上(打脸证据的半张)');
  check(Array.isArray(rec.hist) && rec.hist.some((h) => h.decision === 'veto-overridden'), 'hist 追加了 veto-overridden');
  check(settings.get().persona.aiTitle === '主人坚持要改成的自述', '强制之后**真的**写进去了');
}

// ══ 4) 非人格层不进 pending + 工具通道三条查否决状态 ═══════════════════════════════════
console.log('▶ 4) 非人格层(语气 / habitsPending / 代码配置)不进 pending');
const memB = newMem();
{
  const { settings } = mkSettings();
  const n0 = memB.kvList(VETO_KV_PREFIX).length;
  const tone = propose(settings, memB, { persona: { tone: 'literary' } }, { propose: true }, '/persona/grow');
  check(tone.ok === true && tone.engaged === false && tone.layer === 'other', '语气(tone)⇒ 直接放行,不进 pending');
  const hp = propose(settings, memB, { persona: { habitsPending: true } }, { propose: true }, '/persona/habits/scan');
  check(hp.ok === true && hp.engaged === false, 'habitsPending(候选队列)⇒ 不进 pending');
  const cfg = propose(settings, memB, { guard: { enforce: false }, mode: { lastMode: 'work' } }, { propose: true }, '/mode/toggle');
  check(cfg.ok === true && cfg.engaged === false, '代码/配置(guard/mode)⇒ 不进 pending');
  check(memB.kvList(VETO_KV_PREFIX).length === n0, '★kv `veto.` 一条都没新增(实测 ' + n0 + ')');
  check(vetoKeysOf({ persona: { tone: 'literary', habits: [] } }).join(',') === 'habits', '白名单是交集:只挑出 10 键里的字段');
  // 对"非人格层"的记录调 veto ⇒ not-persona-layer(不新造第二套判断,只认 layer 字段)
  memB.kvSet(VETO_KV_PREFIX + 'vother-00000000', J({ v: 1, id: 'vother-00000000', state: 'pending', layer: 'memory', at: new Date().toISOString(), fields: { aiName: 's:0000000000000000' } }));
  const bad = vetoAction({ memory: memB, settings, action: 'veto', id: 'vother-00000000', reason: '不该否决记忆层' });
  check(bad.ok === false && bad.reason === 'not-persona-layer', '非人格层的记录 ⇒ veto 被拒(not-persona-layer)');
  memB.kvDel(VETO_KV_PREFIX + 'vother-00000000');
  // 工具通道三条:规矩/习惯写 hardRules/habits 之前必须查否决状态
  //   ⚠️ 用**未定型**(sealed:false)的 settings:那样 `sealedRefusal()` 一定不拦 ⇒ 拦住它的只能是否决状态,
  //      这条断言才真的验到"三条工具通道查 veto",而不是被既有那条更粗的线顺手挡住。
  const { settings: unsealed } = mkSettings({ sealed: false });
  const pendR = propose(unsealed, memB, { persona: { hardRules: '先给结论' } });
  check(pendR.reason === 'veto-pending', '前置:造一条覆盖 hardRules 的 pending');
  const pend = propose(unsealed, memB, { persona: { habits: '先给结论' } });
  check(pend.reason === 'veto-pending', '前置:造一条覆盖 habits 的 pending');
  const reg = [];
  registerLingTools({ tools: { register: (s) => { reg.push(s); return () => {}; } } }, { gate: { snapshotIds: () => [] }, memory: memB, settings: unsealed });
  const ruleTool = reg.find((s) => s.name === TOOL_RULE_ADD);
  const w = await ruleTool.execute({ rule: '先给结论再展开', quote: '以后都先给结论' }, {});
  check(w.ok === false && w.reason === 'veto-pending', '★rule_add 写 hardRules 前查否决状态 ⇒ 被 pending 拦住(实测 ' + J(w.reason) + ')');
  check((unsealed.get().persona.hardRules || []).length === 0, '被拦之后规矩一条没写进去');
  const st = vetoStatusFor(memB, ['habits']);
  check(st && st.ok === false && st.reason === 'veto-pending', 'vetoStatusFor(单一来源)对 habits 也返回否决中');
  check(vetoStatusFor(memB, ['tone']) === null, '白名单外的字段查否决状态 ⇒ null(不误伤)');
}

// ══ 5) approved 之后:缺票据仍拒(门独立生效)、nonce 不被消费 ═════════════════════════════
console.log('▶ 5) 门独立生效:approve 过了,缺票据照样拒');
const memC = newMem();
const C = mkSettings();
{
  const { settings, stats } = C;
  const patch = { persona: { bottomLines: ['不撒谎'] } };
  const p = propose(settings, memC, patch);
  const approvedId = p.id;
  const ap = await vetoAction({ memory: memC, settings, action: 'approve', id: approvedId });
  check(ap.ok === true && ap.state === 'approved', 'approve ⇒ pending→approved');
  check(/^[0-9a-f]{64}$/.test(String(ap.nonce)) && ap.oneShot === true, 'approve 发一次性 nonce(oneShot:true)');
  const beforePersona = J(settings.get().persona);
  // 门:已定型 + 本机(带 UA)+ **无票据** ⇒ 拒
  const noTicket = requireSurgery({ host: '127.0.0.1:3080', 'user-agent': 'Mozilla/5.0 (test)' }, { unlock: '那句话' }, { settings });
  check(noTicket.ok === false && noTicket.reason === 'surgery-ticket',
    '★缺票据仍拒(与非决状态无关,实测 ' + J(noTicket.reason) + ')');
  // ── m23-1 / N1 恒真清理:同上 —— 门(`requireSurgery`)也不写 settings,纯字节比对永真。
  const ticketWrite = await handlerAfterVeto(noTicket, settings, patch);
  check(ticketWrite.written === false && stats.updateCalls === 0
    && J(settings.get().persona) === beforePersona,
    '★被门拒的那次零写入:端点两步也不写(实测 written=' + J(ticketWrite.written)
      + '/updateCalls=' + J(stats.updateCalls) + ')');
  const rec = JSON.parse(String(memC.kvGet(VETO_KV_PREFIX + approvedId)));
  check(rec.state === 'approved', '门拒之后状态仍是 approved(否决权没被消费)');
  check(rec.nonceUsedAt === null, '★nonce 未被消费(nonceUsedAt===null)');
  // 带票 + 原句 ⇒ 门过;再用 approve 的 nonce ⇒ 状态机才放行
  const okGate = requireSurgery({
    host: '127.0.0.1:3080', 'user-agent': 'Mozilla/5.0 (test)',
    'x-dsh-ling-surgery': readSurgeryTicket(),
  }, { unlock: '那句话' }, { settings });
  check(okGate.ok === true && okGate.gated === true, '本机 + 票据 + 原句 ⇒ 门放行');
  const badNonce = vetoConsume({ settings, memory: memC, gated: true, endpoint: '/persona', patch, veto: { id: approvedId, nonce: 'f'.repeat(64) } });
  check(badNonce.ok === false && badNonce.reason === 'veto-nonce', 'nonce 不对 ⇒ veto-nonce(仍不写)');
  const ok2 = vetoConsume({ settings, memory: memC, gated: true, endpoint: '/persona', patch, veto: { id: approvedId, nonce: ap.nonce } });
  check(ok2.ok === true && ok2.applied === true && /^[0-9a-f]{16}$/.test(String(ok2.afterDigest)),
    '★approved + 对的 nonce ⇒ 放行写 + afterDigest');
  await settings.update(patch);
  const rec2 = JSON.parse(String(memC.kvGet(VETO_KV_PREFIX + approvedId)));
  check(typeof rec2.nonceUsedAt === 'string', 'nonce 被消费(nonceUsedAt 有值)');
  const again = vetoConsume({ settings, memory: memC, gated: true, endpoint: '/persona', patch, veto: { id: approvedId, nonce: ap.nonce } });
  check(again.ok === false && again.reason === 'veto-nonce', '一次性:同一枚 nonce 第二次 ⇒ veto-nonce');
  // 范围判据:批了 aiTitle,却想顺手改 aiName ⇒ veto-scope
  const p2 = propose(settings, memC, { persona: { aiTitle: '只批这一项' } });
  const ap2 = await vetoAction({ memory: memC, settings, action: 'approve', id: p2.id });
  // MF-4:nonce **必填** —— 不带票的写不再短路放行(修前是 `rec.nonce && veto.nonce && …` 三个 and)
  const noNonce = vetoConsume({ settings, memory: memC, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: '只批这一项' } }, veto: { id: p2.id } });
  check(noNonce.ok === false && noNonce.reason === 'veto-nonce', '★approve 之后不带 nonce ⇒ veto-nonce(票是必填的)');
  const scope = vetoConsume({ settings, memory: memC, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: '只批这一项', aiName: '顺手改名' } }, veto: { id: p2.id, nonce: ap2.nonce } });
  check(scope.ok === false && scope.reason === 'veto-scope'
    && scope.message === '这次改动超出了这条否决记录覆盖的字段（aiTitle）。',
    '批了 A 却改 A+B ⇒ veto-scope + 统一文案(实测 ' + J(scope.reason) + '/' + J(scope.message) + ')');
}

// ══ 6) veto-blocked 反向留痕:不改 state、不放行任何写 ════════════════════════════════════
console.log('▶ 6) `veto-blocked`:反向留痕(防止"保守否决"永远无代价)');
const memD = newMem();
{
  const { settings } = mkSettings();
  const p = propose(settings, memD, { persona: { userTitle: '换个称呼' } });
  const v = await vetoAction({ memory: memD, settings, action: 'veto', id: p.id, reason: '这个称呼我不想换' });
  check(v.ok === true && v.decision === 'veto', '前置:先否决一条');
  // 主人代写复盘:要二次确认(同一个入口,不新造权限判断)
  const byMaster = await vetoAction({ memory: memD, settings, action: 'blocked', id: p.id, by: 'master', reason: '主人代写复盘' });
  check(byMaster.ok === false && byMaster.reason === 'need-confirm', '主人代写 blocked 需 confirm:true');
  // 她自陈判断失误
  const bl = await vetoAction({ memory: memD, settings, action: 'blocked', id: p.id, reason: '事后发现确实该换' });
  check(bl.ok === true && bl.decision === 'veto-blocked' && bl.written === true,
    '★blocked ⇒ decision=veto-blocked(实测 ' + J(bl.decision) + ')');
  const rec = JSON.parse(String(memD.kvGet(VETO_KV_PREFIX + p.id)));
  check(rec.state === 'vetoed', '★不改 state(仍是 vetoed)');
  check(rec.decision === 'veto-blocked', '★decision 改写为 veto-blocked(留痕可翻出)');
  check(Array.isArray(rec.hist) && rec.hist.some((h) => h.decision === 'veto-blocked'), 'hist 追加一条');
  const again = vetoConsume({ settings, memory: memD, gated: true, endpoint: '/persona', patch: { persona: { userTitle: '再试一次' } }, veto: {} });
  check(again.ok === false && again.reason === 'veto-vetoed', '★veto-blocked **不放行任何写**(仍 veto-vetoed)');
  // 没否决过的不许标 blocked
  const p2 = propose(settings, memD, { persona: { duty: '守着这个家' } });
  const noVeto = await vetoAction({ memory: memD, settings, action: 'blocked', id: p2.id, reason: '还没否决过呢' });
  check(noVeto.ok === false && noVeto.reason === 'not-vetoed', '没否决过的记录 ⇒ blocked 被拒(not-vetoed)');
  // 主人代写 + confirm:另起一条已否决的记录(不改前一条的 decision)
  const p3 = propose(settings, memD, { persona: { duty: '守着这个家' } }, { propose: true, id: '' });
  await vetoAction({ memory: memD, settings, action: 'veto', id: p3.id, reason: '这条职责先别加' });
  const byMaster2 = await vetoAction({ memory: memD, settings, action: 'blocked', id: p3.id, by: 'master', confirm: true, reason: '主人代写复盘' });
  check(byMaster2.ok === true && byMaster2.decision === 'veto-blocked', '带 confirm 才写入');
}

// ══ 7) 工具规格面(spec 自校验 + 注册 + 不套 sealedRefusal + 不碰 settings)════════════════
console.log('▶ 7) `ling_veto` 规格 / 注册 / 边界');
const memE = newMem();
{
  check(LING_VETO_SPEC.name === TOOL_LING_VETO && TOOL_LING_VETO === 'ling_veto', '工具名 ling_veto');
  check(LING_VETO_SPEC.parameters.required.includes('action'), 'action 是必填参数');
  check(['list', 'approve', 'veto', 'blocked'].every((a) => LING_VETO_SPEC.parameters.properties.action.enum.includes(a)),
    'action 枚举含 list/approve/veto + blocked(V-MAP §7.6 的反向留痕入口)');
  check(['id', 'reason', 'confirm'].every((k) => !!LING_VETO_SPEC.parameters.properties[k]), 'id / reason / confirm 三个参数在位');
  check(checkLingVeto({ action: 'veto', id: 'v1' }).reason === 'no-reason', 'veto 缺理由 ⇒ no-reason');
  check(checkLingVeto({ action: 'veto', id: 'v1', reason: '三个字' }).reason === 'no-reason', '理由 <4 字 ⇒ no-reason');
  check(checkLingVeto({ action: 'approve' }).reason === 'no-id', 'approve 缺 id ⇒ no-id');
  check(checkLingVeto({ action: 'list' }).ok === true, 'list 不需要 id/理由');
  // 不套 sealedRefusal:已定型(sealed:true)时这条工具照常可执行 —— 否则状态机死锁
  const { settings } = mkSettings({ sealed: true });
  const reg = [];
  registerLingTools({ tools: { register: (s) => { reg.push(s); return () => {}; } } }, { gate: { snapshotIds: () => [] }, memory: memE, settings });
  check(reg.length === 13, '注册 13 件工具(12 + ling_veto)');
  const tool = reg.find((s) => s.name === TOOL_LING_VETO);
  check(!!tool, 'ling_veto 已注册');
  const p = propose(settings, memE, { persona: { pronoun: '你' } });
  const ap = await tool.execute({ action: 'approve', id: p.id }, {});
  check(ap.ok === true, '★已定型时 ling_veto 照常可用(不套 sealedRefusal ⇒ 状态机不死锁)');
  const before = J(settings.get().persona);
  const notFound = await tool.execute({ action: 'veto', id: 'v-missing', reason: '不存在的一条' }, {});
  check(notFound.ok === false && notFound.reason === 'not-found', '不存在的 id ⇒ not-found');
  check(J(settings.get().persona) === before, 'ling_veto 全程不写 settings(它的写面只有 kv veto.*)');
  // 参数归一(端点侧唯一来源)
  check(vetoArgsOf({ vetoId: 'v1', vetoConfirm: true }).confirm === true, 'vetoArgsOf:平铺形状');
  check(vetoArgsOf({ veto: { id: 'v2', propose: true } }).propose === true, 'vetoArgsOf:嵌套 veto 形状');
  check(vetoArgsOf({ vetoForce: { id: 'v3', token: 'abc' } }).token === 'abc', 'vetoArgsOf:vetoForce 形状');
  check(vetoArgsOf('raw text body').id === '', 'vetoArgsOf:字符串载荷(/import 原文)⇒ 空票据');
}

// ══ 8) MF-1:pending 的**主人侧出口**(两跳强制 / drop 归档 rejected)════════════════════════
console.log('▶ 8) MF-1:pending 出口 —— 两跳强制 + drop ⇒ rejected(修前 rejected 是不可达死态)');
const memF = newMem();
{
  const { settings, stats } = mkSettings();
  const patch = { persona: { duty: '守着这个家' } };
  const p = propose(settings, memF, patch);
  check(p.reason === 'veto-pending', '前置:造一条覆盖 duty 的 pending');
  const before = J(settings.get().persona);
  const plain = vetoConsume({ settings, memory: memF, gated: true, endpoint: '/persona', patch, veto: {} });
  check(plain.ok === false && plain.reason === 'veto-pending', '不带 confirm 仍 veto-pending');
  check(/drop/.test(String(plain.message)), '★pending 的拒文里点名主人侧出口(drop / confirm)');
  // 第 1 跳:只发 forceToken,**零写入**
  const hop1 = vetoConsume({ settings, memory: memF, gated: true, endpoint: '/persona', patch, veto: { confirm: true } });
  check(hop1.ok === false && hop1.reason === 'veto-confirm-required' && /^[0-9a-f]{64}$/.test(String(hop1.forceToken)),
    '★pending + confirm 第 1 跳 ⇒ veto-confirm-required + forceToken(实测 ' + J(hop1.reason) + ')');
  // ── m23-1 / N1 恒真清理:同 §3 —— 第 1 跳只发 token、不写(判据层零写点),字节比对永真。
  const hop1Write = await handlerAfterVeto(hop1, settings, patch);
  check(hop1Write.written === false && stats.updateCalls === 0
    && J(settings.get().persona) === before,
    '★第 1 跳零写入:端点两步也不写(实测 written=' + J(hop1Write.written)
      + '/updateCalls=' + J(stats.updateCalls) + ')');
  const wrongT = vetoConsume({ settings, memory: memF, gated: true, endpoint: '/persona', patch, veto: { confirm: true, token: 'f'.repeat(64) } });
  check(wrongT.ok === false && wrongT.wrote === false, 'token 错 ⇒ 仍不放行');
  const hop2 = vetoConsume({ settings, memory: memF, gated: true, endpoint: '/persona', patch, veto: { confirm: true, token: hop1.forceToken } });
  check(hop2.ok === true && hop2.decision === 'veto-overridden-on-pending',
    '★pending 第 2 跳才放行 + decision=veto-overridden-on-pending(实测 ' + J(hop2.decision) + ')');
  const recF = JSON.parse(String(memF.kvGet(VETO_KV_PREFIX + p.id)));
  check(recF.state === 'overridden' && recF.decision === 'veto-overridden-on-pending', '★留痕:state=overridden + 新 decision');
  check(Array.isArray(recF.hist) && recF.hist.some((h) => h.decision === 'pending-force-requested')
    && recF.hist.some((h) => h.decision === 'veto-overridden-on-pending'), '★hist 两跳都留了痕');
  await settings.update(patch);
  check(settings.get().persona.duty === '守着这个家', '强制之后**真的**写进去了');
}
const memG = newMem();
{
  const { settings } = mkSettings();
  const patch = { persona: { pronoun: '您' } };
  const p = propose(settings, memG, patch);
  const noConfirm = await vetoAction({ memory: memG, settings, action: 'drop', id: p.id, by: 'master' });
  check(noConfirm.ok === false && noConfirm.reason === 'need-confirm', 'drop by=master 需 confirm:true');
  const d = await vetoAction({ memory: memG, settings, action: 'drop', id: p.id, by: 'master', confirm: true, reason: '这次先不改' });
  check(d.ok === true && d.state === 'rejected' && d.decision === 'veto-dropped',
    '★drop ⇒ state=rejected(可达态)+ decision=veto-dropped(实测 ' + J(d.state) + ')');
  const recD = JSON.parse(String(memG.kvGet(VETO_KV_PREFIX + p.id)));
  check(recD.state === 'rejected' && Array.isArray(recD.hist) && recD.hist.some((h) => h.decision === 'veto-dropped'),
    '★kv 里 state=rejected + hist 留了一条 veto-dropped');
  const after = vetoConsume({ settings, memory: memG, gated: true, endpoint: '/persona', patch, veto: {} });
  check(after.ok === true && after.engaged === false, '★归档 rejected 之后该字段恢复可写');
  // 工具面:drop 是同一个工具的第 5 个动作(不新端点 —— 否则就是第 16 条写面)
  check(LING_VETO_SPEC.parameters.properties.action.enum.includes('drop'), '★ling_veto 的 action 枚举含 drop');
  check(checkLingVeto({ action: 'drop', id: 'v1' }).ok === true, 'drop 不需要理由');
  check(checkLingVeto({ action: 'drop', id: 'v1', by: 'master' }).reason === 'need-confirm', '工具侧 drop by=master 也要 confirm');
  check(checkLingVeto({ action: 'drop' }).reason === 'no-id', 'drop 缺 id ⇒ no-id');
}

// ══ 9) MF-2:撤锁(sealed:false)不再是"两跳、无留痕、10 键全免"的绕过 ═══════════════════════
console.log('▶ 9) MF-2:撤锁要二次确认 + 留痕,且不能解除已挂起的否决');
const memH = newMem();
{
  const { settings, state, stats } = mkSettings();       // sealed:true ⇒ 门真的进
  const titlePatch = { persona: { aiTitle: '撤锁后想偷改的自述' } };
  const p = propose(settings, memH, titlePatch);
  check(p.reason === 'veto-pending', '前置:aiTitle 上一条 pending');
  const unseal = { persona: { sealed: false } };
  const u0 = vetoConsume({ settings, memory: memH, gated: true, endpoint: '/persona', patch: unseal, veto: {} });
  check(u0.ok === false && u0.reason === 'veto-unseal-confirm-required',
    '★撤锁那一跳带在挂记录 ⇒ 需 confirm(实测 ' + J(u0.reason) + ')');
  // ── m23-1 / N1 恒真清理:`state.persona.sealed === true` 只是"一个字段没变",判据层根本不写 ⇒ 永真。
  //    改成端点两步 + 写点计数,`sealed` 终态作为附加判据保留(模板 §14.2 `:890-892`)。
  const u0Write = await handlerAfterVeto(u0, settings, unseal);
  check(u0Write.written === false && stats.updateCalls === 0 && state.persona.sealed === true,
    '★被拒的那次零写入:端点两步也不写 + sealed 仍是 true(实测 written=' + J(u0Write.written)
      + '/updateCalls=' + J(stats.updateCalls) + '/sealed=' + J(state.persona.sealed) + ')');
  check(JSON.parse(String(memH.kvGet(VETO_KV_PREFIX + p.id))).unsealPinned !== true, '被拒的那次没有 pin 任何记录');
  const u1 = vetoConsume({ settings, memory: memH, gated: true, endpoint: '/persona', patch: unseal, veto: { confirm: true } });
  check(u1.ok === false && /^[0-9a-f]{64}$/.test(String(u1.forceToken)), 'confirm 第 1 跳 ⇒ forceToken、零写入');
  // ── m23-1 / N1 恒真清理:同上一处(confirm 第 1 跳也只发 token);附带用 `u0Write.written` 交叉核对。
  const u1Write = await handlerAfterVeto(u1, settings, unseal);
  check(u1Write.written === false && stats.updateCalls === 0 && state.persona.sealed === true,
    '★第 1 跳零写入:端点两步也不写 + sealed 仍是 true(实测 written=' + J(u1Write.written)
      + '/updateCalls=' + J(stats.updateCalls) + '/sealed=' + J(state.persona.sealed) + ')');
  const u2 = vetoConsume({ settings, memory: memH, gated: true, endpoint: '/persona', patch: unseal, veto: { confirm: true, token: u1.forceToken } });
  check(u2.ok === true && u2.decision === 'veto-unseal-forced', '★二次确认后才撤锁 + decision=veto-unseal-forced');
  check(Array.isArray(u2.pinned) && u2.pinned.includes(p.id), '★在挂记录被 pin(回执里点名)');
  const recU = JSON.parse(String(memH.kvGet(VETO_KV_PREFIX + p.id)));
  check(recU.unsealPinned === true && recU.hist.some((h) => h.decision === 'veto-unseal-forced'),
    '★hist 留了 veto-unseal-forced(修前这一跳无 confirm、无 hist)');
  await settings.update(unseal);                   // 端点在这一跳之后才写
  // 撤锁之后:门不再进(gated:false),但被 pin 的 pending 仍拦它覆盖的键
  const afterUnseal = vetoConsume({ settings, memory: memH, gated: false, endpoint: '/persona', patch: titlePatch, veto: {} });
  check(afterUnseal.ok === false && afterUnseal.reason === 'veto-pending',
    '★撤锁之后该键的写**仍拒**(修前这里直接放行 ⇒ 10 键全免)');
  const other = vetoConsume({ settings, memory: memH, gated: false, endpoint: '/persona', patch: { persona: { bottomLines: ['x'] } }, veto: {} });
  check(other.ok === true && other.note === 'veto-inactive-outside-gate', '门外未被 pin 的字段照旧放行(不误伤)');
  await vetoAction({ memory: memH, settings, action: 'drop', id: p.id, by: 'master', confirm: true });
  const freed = vetoConsume({ settings, memory: memH, gated: false, endpoint: '/persona', patch: titlePatch, veto: {} });
  check(freed.ok === true, '★出口在 drop(归档 rejected),不在撤锁');
}

// ══ 10) MF-6:kv 坏条目 ⇒ 两种口径统一为 fail-closed ═══════════════════════════════════════
console.log('▶ 10) MF-6:kv `veto.*` 有坏条目 ⇒ fail-closed(修前不带 id 的路径 fail-open)');
const memI = newMem();
{
  const { settings } = mkSettings();
  memI.kvSet(VETO_KV_PREFIX + 'vbroken-00000000', '{坏 JSON');
  check(vetoKvBadCount(memI) === 1, '坏条目计数 = 1(可观测,不再静默跳过)');
  const noId = vetoConsume({ settings, memory: memI, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: 'x' } }, veto: {} });
  check(noId.ok === false && noId.reason === 'veto-kv-corrupt', '★不带 id 的普通写 ⇒ veto-kv-corrupt(修前放行)');
  const withId = vetoConsume({ settings, memory: memI, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: 'x' } }, veto: { id: 'vx-00000000' } });
  check(withId.ok === false && withId.reason === 'veto-kv-corrupt', '★带 id 也拒(同一份损坏不再给出相反结论)');
  const notPersona = vetoConsume({ settings, memory: memI, gated: true, endpoint: '/persona/grow', patch: { persona: { tone: 'x' } }, veto: {} });
  check(notPersona.ok === true && notPersona.engaged === false, '非人格层不受影响(坏条目只拦 10 键写面)');
}

// ══ 11) MF-5(已闭合):只知字段名时 fields=unknown、afterDigest 不许冒充落库后人格 ═══════════
console.log('▶ 11) MF-5:keys-only 交参 ⇒ fields=unknown、afterDigest=null(端点侧已改交 keys)');
const memJ = newMem();
{
  const { settings } = mkSettings();
  const r = vetoConsume({
    settings, memory: memJ, gated: true, endpoint: '/feedback/apply', patch: undefined, keys: ['habits'], veto: { propose: true },
  });
  check(r.reason === 'veto-pending', '前置:keys-only 提议 ⇒ pending');
  const rec = JSON.parse(String(memJ.kvGet(VETO_KV_PREFIX + r.id)));
  check(rec.fields.habits === 'unknown', '★只给字段名时 fields 记 unknown(不拿旧值/行号冒充值)');
  check(!Object.prototype.hasOwnProperty.call(rec.fields, 'hardRules'),
    '★不再把 hardRules 塞进交参(/feedback/apply 落的是 habits)');
  check(J(Object.keys(rec.fields)) === J(['habits']), '★交参字段集只有 habits(实测 ' + J(Object.keys(rec.fields)) + ')');
  check(rec.afterDigest === sha16(J(settings.get().persona)), '提议那一刻的 afterDigest 仍是**当前**人格(真实值)');
  const hop1 = vetoConsume({ settings, memory: memJ, gated: true, endpoint: '/feedback/apply', patch: undefined, keys: ['habits'], veto: { confirm: true } });
  check(/^[0-9a-f]{64}$/.test(String(hop1.forceToken)), '前置:pending 第 1 跳给 forceToken');
  const hop2 = vetoConsume({ settings, memory: memJ, gated: true, endpoint: '/feedback/apply', patch: undefined, keys: ['habits'], veto: { confirm: true, token: hop1.forceToken } });
  check(hop2.ok === true && hop2.afterDigest === null && hop2.afterDigestKnown === false,
    '★值不可预知 ⇒ afterDigest=null + afterDigestKnown:false(不冒充落库后人格)');
  const rec2 = JSON.parse(String(memJ.kvGet(VETO_KV_PREFIX + r.id)));
  check(rec2.afterDigest === null && rec2.afterDigestKnown === false, '★kv 里也是 null + known:false(D7 的适用范围因此收窄)');
}

// ══ 12) 已归档提案 id **不是**"放行凭据"(rejected / overridden 不许盖住同字段的 pending)═══════
//   缺陷(蓝队 B1-4 / red1 第 5 条):`veto.id` 一给就整条跳过"覆盖这些字段的未落定记录"的查找
//   (surgery.js `vetoConsume` 里的 `let rec = veto.id ? readVeto(...) : vetoFindIn(...)`),
//   于是一条**历史已归档**的、与本次字段无关的 id 走到 `note:'veto-terminal'` ⇒ `ok:true` 放行,
//   而同一份写在同一张票同一句原句下、不带 id 时是被 pending 拦住的。
//   本组把"同一份写、只差一个归档 id"钉成两条相邻断言(修前:不带 id 拒 / 带 id 放行)。
console.log('▶ 12) 已归档(rejected/overridden)id 不许绕过同字段仍挂起的 pending');
const memK = newMem();
{
  const { settings } = mkSettings();                // sealed:true ⇒ 门真的进
  // ① hardRules 上一条 pending(A)
  const A = propose(settings, memK, { persona: { hardRules: ['先给结论'] } }, { propose: true }, '/persona/rule');
  check(A.ok === false && A.reason === 'veto-pending' && !!A.id, '前置:hardRules 上一条 pending(实测 ' + J(A.reason) + ')');
  // ② 另一字段(aiTitle)的提案 B,by master drop ⇒ 归档 rejected(终态,已了结)
  const B = propose(settings, memK, { persona: { aiTitle: '新的自述' } });
  const d = await vetoAction({ memory: memK, settings, action: 'drop', id: B.id, by: 'master', confirm: true, reason: '这条先不改' });
  check(d.ok === true && d.state === 'rejected', '前置:B 落到终态 rejected(实测 ' + J(d.state) + ')');

  const write = { persona: { hardRules: ['绕过 pending 的规矩'] } };
  // ③ 对照:不带 id ⇒ 被 A 拦住(这一段在修前也是对的 —— 它证明"保护层本来生效")
  const plain = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona/rule', patch: write, veto: {} });
  check(plain.ok === false && plain.reason === 'veto-pending', '★对照:不带 id ⇒ veto-pending(实测 ' + J(plain.reason) + ')');
  // ④ 只多一个**已归档**的 id ⇒ 仍必须被 A 挡住(修前 ok:true + note=veto-terminal)
  const withArchived = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona/rule', patch: write, veto: { id: B.id } });
  check(withArchived.ok === false && withArchived.reason === 'veto-pending',
    '★带已归档 id ⇒ 仍 veto-pending(修前 ok:true/note=veto-terminal,实测 '
      + J(withArchived.ok) + '/' + J(withArchived.reason || withArchived.note) + ')');
  check(withArchived.id === A.id,
    '★被咨询的是那条 pending(' + A.id + '),不是归档 id(' + B.id + ')(实测 ' + J(withArchived.id) + ')');
  // ⑤ A 仍是 pending:没被静默消费/覆盖(修前就是"不消费、不落痕",所以只靠 ok:false 不够)
  const recA = JSON.parse(String(memK.kvGet(VETO_KV_PREFIX + A.id)));
  check(recA.state === 'pending', '★A 仍是 pending(归档 id 没有把它消费掉,实测 ' + J(recA.state) + ')');
  // ⑥ 反向对照:该字段**没有**在挂记录 ⇒ 归档 id 照旧终态放行(不误伤"归档后该字段恢复可写")
  const solo = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona', patch: { persona: { aiTitle: '归档之后该字段照旧可写' } }, veto: { id: B.id } });
  check(solo.ok === true && solo.note === 'veto-terminal', '★反向对照:无在挂记录 ⇒ 归档 id 照旧终态放行(实测 ' + J(solo.note) + ')');
  // ⑦ overridden 同属终态:拿它当凭据同样不许绕过 hardRules 上的 pending
  const cPatch = { persona: { aiTitle: '主人同意的自述' } };
  const C = propose(settings, memK, cPatch);
  const h1 = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona', patch: cPatch, veto: { confirm: true } });
  const h2 = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona', patch: cPatch, veto: { confirm: true, token: h1.forceToken } });
  check(h2.ok === true && h2.decision === 'veto-overridden-on-pending', '前置:C 强制落地 ⇒ overridden(实测 ' + J(h2.decision) + ')');
  const withOverridden = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona/rule', patch: write, veto: { id: C.id } });
  check(withOverridden.ok === false && withOverridden.reason === 'veto-pending',
    '★带 overridden(终态)id ⇒ 同样不许绕过 hardRules 上的 pending(实测 '
      + J(withOverridden.ok) + '/' + J(withOverridden.reason || withOverridden.note) + ')');
  // ⑧ 带 pending 自己的 id ⇒ 仍是 veto-pending(id 路径本身照旧被认真对待)
  const withPendingId = vetoConsume({ settings, memory: memK, gated: true, endpoint: '/persona/rule', patch: write, veto: { id: A.id } });
  check(withPendingId.ok === false && withPendingId.reason === 'veto-pending', '反向对照:带 pending 自己的 id ⇒ 仍 veto-pending');
}

// ══ 13) N1:已否决(vetoed,仍是 active)的 id **不是**"范围通行证" ════════════════════════════
//   缺陷(m12-review §2 N1):`let rec = veto.id ? readVeto(...) : vetoFindIn(...)` 一旦给了 id 就
//   只按那条记录判;若它是 **vetoed(active)** 而本次写的是**另一批字段**,`vetoed` 分支不看
//   `rec.fields` ⇒ confirm + token 对上就 ok:true —— 而本次字段上仍挂着的 pending 从头到尾没被咨询
//   (违反 surgery.js 自己写的契约:同字段有 pending/vetoed 时,同字段的任何后续写都不生效)。
//   本组三条:① 别的字段上的 pending 仍要拦(且被点名的是那条 pending)/ ② 它自己覆盖的字段照旧拦 /
//   ③ 既不是自己的字段、也没有覆盖本次字段的记录 ⇒ veto-scope(不再拿别人的票当通行证)。
console.log('▶ 13) N1:vetoed(active)id 不越界 —— 只对自己覆盖的字段有发言权');
{
  // ① vetoed X(aiTitle) + pending Y(hardRules):写 hardRules 带 X 的 id ⇒ 仍被 Y 拦住
  const memL = newMem();
  const { settings } = mkSettings();
  const X = propose(settings, memL, { persona: { aiTitle: '被否决过的新自述' } }, { propose: true }, '/persona');
  check(X.ok === false && X.reason === 'veto-pending' && !!X.id, '前置:aiTitle 上一条 pending X(实测 ' + J(X.reason) + ')');
  const vx = await vetoAction({ memory: memL, settings, action: 'veto', id: X.id, reason: '这条自述先别改' });
  check(vx.ok === true && vx.state === 'vetoed', '前置:X 落到 vetoed(仍是 active,实测 ' + J(vx.state) + ')');
  const Y = propose(settings, memL, { persona: { hardRules: ['先给结论'] } }, { propose: true }, '/persona/rule');
  check(Y.ok === false && Y.reason === 'veto-pending' && Y.id !== X.id,
    '前置:另一字段 hardRules 上一条 pending Y(与 X 不重叠 ⇒ 两条可并存,实测 ' + J(Y.reason) + ')');
  const crossWrite = vetoConsume({
    settings, memory: memL, gated: true, endpoint: '/persona/rule',
    patch: { persona: { hardRules: ['绕过 pending 的规矩'] } }, veto: { id: X.id },
  });
  check(crossWrite.ok === false && crossWrite.reason === 'veto-pending',
    '★写别的字段并带 vetoed 的 id ⇒ 仍 veto-pending(修前只按 X 判 ⇒ veto-vetoed,实测 '
      + J(crossWrite.ok) + '/' + J(crossWrite.reason || crossWrite.decision) + ')');
  check(crossWrite.id === Y.id,
    '★被咨询的是那条 pending(' + Y.id + '),不是 vetoed 的 id(' + X.id + ')(实测 ' + J(crossWrite.id) + ')');
  const recX1 = JSON.parse(String(memL.kvGet(VETO_KV_PREFIX + X.id)));
  check(recX1.state === 'vetoed', '★X 仍是 vetoed(没被这次写消费成 overridden,实测 ' + J(recX1.state) + ')');

  // ② vetoed X **自己覆盖的字段**照旧拦(范围守卫生效,不等于把 vetoed 放行了)
  const memM = newMem();
  const { settings: settings2 } = mkSettings();
  const X2 = propose(settings2, memM, { persona: { aiTitle: '被否决过的新自述' } }, { propose: true }, '/persona');
  await vetoAction({ memory: memM, settings: settings2, action: 'veto', id: X2.id, reason: '这条自述先别改' });
  const ownWrite = vetoConsume({
    settings: settings2, memory: memM, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '绕过否决' } }, veto: { id: X2.id },
  });
  check(ownWrite.ok === false && ownWrite.reason === 'veto-vetoed' && ownWrite.id === X2.id,
    '★它自己的字段仍被拦 ⇒ veto-vetoed(实测 ' + J(ownWrite.reason) + '/' + J(ownWrite.id) + ')');

  // ③ vetoed X(aiTitle) + 写 hardRules 带 X 的 id、且**没有**覆盖 hardRules 的 active 记录 ⇒ veto-scope
  const memN = newMem();
  const { settings: settings3, stats: stats3 } = mkSettings();
  const X3 = propose(settings3, memN, { persona: { aiTitle: '被否决过的新自述' } }, { propose: true }, '/persona');
  await vetoAction({ memory: memN, settings: settings3, action: 'veto', id: X3.id, reason: '这条自述先别改' });
  const outOfScope = vetoConsume({
    settings: settings3, memory: memN, gated: true, endpoint: '/persona/rule',
    patch: { persona: { hardRules: ['没人为这组字段签过字'] } }, veto: { id: X3.id },
  });
  check(outOfScope.ok === false && outOfScope.reason === 'veto-scope',
    '★vetoed 的 id 盖不住硬规矩 ⇒ veto-scope(修前只按 X 判 ⇒ veto-vetoed,实测 '
      + J(outOfScope.ok) + '/' + J(outOfScope.reason || outOfScope.decision) + ')');
  check(J(outOfScope.allowed) === J(['aiTitle']) && J(outOfScope.got) === J(['hardRules']),
    '★回执点名 allowed / got(实测 ' + J(outOfScope.allowed) + '/' + J(outOfScope.got) + ')');
  check(outOfScope.id === X3.id && outOfScope.state === 'vetoed',
    '★回执指向那条 vetoed 记录(实测 ' + J(outOfScope.id) + '/' + J(outOfScope.state) + ')');
  check(/这次改动超出了这条否决记录覆盖的字段/.test(String(outOfScope.message)),
    '★回执文案说清了是"这条记录覆盖的字段"不够(实测 ' + J(outOfScope.message) + ')');
  const recX3 = JSON.parse(String(memN.kvGet(VETO_KV_PREFIX + X3.id)));
  // ── m23-1 / N1 恒真清理:"零写入"原来只靠 kv 终态(记录仍 vetoed / 没发 token)承担,`settings` 侧
  //    一个字都没查 —— 判据层不写 settings,所以那句话当年是永真的。现在补**写点计数 + 端点两步**,
  //    kv 终态(仍 vetoed / 无 forceToken)按 §D N1 要求**原样保留**。
  const scopeWrite = await handlerAfterVeto(outOfScope, settings3, { persona: { hardRules: ['没人为这组字段签过字'] } });
  check(scopeWrite.written === false && stats3.updateCalls === 0
    && recX3.state === 'vetoed' && !recX3.forceToken,
    '★越界的那次零写入:端点两步也不写 + state 仍 vetoed、也没发 forceToken(实测 written='
      + J(scopeWrite.written) + '/updateCalls=' + J(stats3.updateCalls) + '/'
      + J(recX3.state) + '/' + J(recX3.forceToken) + ')');
  // ③' 两跳强制的入口同样不许越界(修前:第 1 跳发 token、第 2 跳 ok:true —— 那才是真正的旁路)
  const forcedHop1 = vetoConsume({
    settings: settings3, memory: memN, gated: true, endpoint: '/persona/rule',
    patch: { persona: { hardRules: ['没人为这组字段签过字'] } }, veto: { id: X3.id, confirm: true },
  });
  check(forcedHop1.ok === false && forcedHop1.reason === 'veto-scope' && !forcedHop1.forceToken,
    '★带 confirm 也越不过去:仍 veto-scope、**不发 forceToken**(修前第 1 跳给 token + veto-confirm-required,实测 '
      + J(forcedHop1.ok) + '/' + J(forcedHop1.reason || forcedHop1.decision) + '/' + J(forcedHop1.forceToken) + ')');
  const recX3b = JSON.parse(String(memN.kvGet(VETO_KV_PREFIX + X3.id)));
  check(!recX3b.forceToken && recX3b.hist.length === 2,
    '★kv 里也没留下 forceToken / 没有新 hist(实测 forceToken=' + J(recX3b.forceToken) + ',hist=' + recX3b.hist.length + ')');
}

// ══ 14) R1/R2/R3:多键超集 / 无 id 整包两跳 / approved 两支文案 ═══════════════════════════
console.log('▶ 14) R1/R2/R3:多键超集、无 id 整包强制、approved 两支统一文案');
{
  // 14.1 R1:记录覆盖 aiTitle + userTitle,本次 patch 还多一个 aiName ⇒ 必须按 every-covered 判越界。
  //   若 helper 被换成 `vetoFindIn`(any-overlap),它会命中这条记录并返回 `veto-pending`,本断言即红。
  const memP = newMem();
  const { settings } = mkSettings();
  const X = propose(settings, memP, { persona: { aiTitle: '被否决过的新自述', userTitle: '主人' } }, { propose: true }, '/persona');
  check(X.ok === false && X.reason === 'veto-pending' && !!X.id, '14.1 前置:aiTitle+userTitle 上一条 pending X');
  const over = vetoConsume({
    settings, memory: memP, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '绕过否决', userTitle: '主人', aiName: '顺手改名' } },
    veto: { id: X.id },
  });
  // ── §14.1/§14.2 加固(m19)断言加固:把 `ok` 与 `reason` **拆开**断言(同一条 check 兼两个判据时,
  //    单点弱化就能静默降级 —— 审计 S6),并把 allowed/got 从"只断长度"改成**逐字**。
  check(over.ok === false, '14.1 ★3 键超集 ⇒ 拒(实测 ' + J(over.ok) + ')');
  check(over.reason === 'veto-scope', '14.1 ★reason 逐字 = veto-scope(实测 ' + J(over.reason) + ')');
  check(J(over.allowed) === J(['aiTitle', 'userTitle']),
    '14.1 ★allowed 逐字(实测 ' + J(over.allowed) + ')');
  check(J(over.got) === J(['aiName', 'aiTitle', 'userTitle']),
    '14.1 ★got 逐字 = 白名单顺序(实测 ' + J(over.got) + ')');
  check(over.id === X.id, '14.1 ★id === X.id(实测 ' + J(over.id) + ')');
  check(String(over.message) === '这次改动超出了这条否决记录覆盖的字段（aiTitle/userTitle）。',
    '14.1 ★文案逐字(实测 ' + J(String(over.message)) + ')');
  const recP1 = JSON.parse(String(memP.kvGet(VETO_KV_PREFIX + X.id)));
  check(recP1.state === 'pending' && recP1.hist.length === 1
    && !recP1.pendingForceToken && !recP1.forceToken && !recP1.decision,
    '14.1 ★零写入:state 仍 pending / hist 仍 1 条 / 两枚 token 都没有(实测 '
      + J(recP1.state) + '/hist=' + recP1.hist.length + '/pendingToken=' + J(recP1.pendingForceToken)
      + '/forceToken=' + J(recP1.forceToken) + ')');
}
{
  // 14.5 ★MF-2(m16):`vetoFindIn` 的 **some 侧**镜像 —— 记录**超集**、本次写**子集**。
  //   14.1 只钉住了 `vetoFindCover` 的 `every`(本次多一个键 ⇒ 越界);本段钉住另一半:
  //   记录覆盖 `aiTitle + userTitle`、本次**不带 id** 只写 `aiTitle` ⇒ 仍命中那条记录 ⇒ `veto-pending`。
  //   把 `surgery.js:892` 的 `got.some(...)` 换成 `got.every(...)` 后返回 null ⇒ 这次写会
  //   `ok:true / note:'no-veto-in-play'` 静默落库,本段立刻红(修前 M3 变异整套 exit 0)。
  const memS = newMem();
  // ── m23-3 / §D D8 补强:本段原来只钉"回执(`ok/reason/id`)+ kv 终态",`settings` 侧一个写点都没数 ——
  //    判据层(`vetoConsume`)若顺手 `settings.update(...)`,上面三条全绿、且 `vv.ok===false` 时
  //    `handlerAfterVeto` 本来就不写 ⇒ 端到端也看不见。所以**按 §14.1/§14.2 模板补一条写点计数**
  //    (`mkSettings().update` 真计数,`stats` 是活对象),kv 终态断言**原样保留**、不改。
  const { settings, stats } = mkSettings();
  const p = propose(settings, memS, { persona: { aiTitle: '被否决过的新自述', userTitle: '主人' } }, { propose: true }, '/persona');
  check(p.ok === false && p.reason === 'veto-pending' && !!p.id,
    '14.5 前置:aiTitle+userTitle 上一条 pending(实测 ' + J(p.reason) + ')');
  const sub = vetoConsume({
    settings, memory: memS, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '只写一个键' } }, veto: {},
  });
  check(sub.ok === false && sub.reason === 'veto-pending' && sub.id === p.id,
    '14.5 ★MF-2 记录超集 / 本次子集(不带 id)⇒ veto-pending 且点名那条记录(M3 变异 some→every 后此处变 ok:true/no-veto-in-play,实测 '
      + J(sub.ok) + '/' + J(sub.reason || sub.note) + '/' + J(sub.id) + ')');
  const recS = JSON.parse(String(memS.kvGet(VETO_KV_PREFIX + p.id)));
  check(recS.state === 'pending' && recS.hist.length === 1,
    '14.5 ★记录仍是 pending 且零写入(没被这次子集写消费,实测 '
      + J(recS.state) + '/hist=' + recS.hist.length + ')');
  // ── m23-3 / §D D8:补 `stats.updateCalls === 0` 一条(挨着 §14.5 的既有断言,不重写主体)。
  //    判据层写 settings 时 `written` 仍是 false(`vv.ok===false` ⇒ handler 不写),只有这条会红;
  //    `some→every` 时 `sub.ok` 变 true ⇒ `written` 也变 true,这条同时兜住「静默落库」。
  const subWrite = await handlerAfterVeto(sub, settings, { persona: { aiTitle: '只写一个键' } });
  check(subWrite.written === false && stats.updateCalls === 0,
    '14.5 ★零落库:判据层不写 settings、端点两步也不写(实测 written='
      + J(subWrite.written) + '/updateCalls=' + J(stats.updateCalls) + ')');
}
{
  // 14.2 R2-A:记录只覆盖 aiTitle;10 键 `whole:true`、**不带 vetoId**,两跳强制必须仍可走通。
  const memW = newMem();
  const { settings, state, stats } = mkSettings();  // ← §14.1/§14.2 加固 + m19-fix:要断"两跳期间 settings 一个字节没动"
  const p = propose(settings, memW, { persona: { aiTitle: '整包前的自述' } }, { propose: true }, '/persona/rollback');
  check(p.ok === false && p.reason === 'veto-pending' && !!p.id, '14.2 前置:aiTitle 上一条 pending');
  const values = {
    aiName: '小灵', aiTitle: '回滚后的自述', userTitle: '主人', pronoun: '你', duty: '守着这个家',
    bottomLines: ['不撒谎'], sealed: true, sealPhrase: '那句话', hardRules: [], habits: [],
  };
  const wholePatch = { persona: Object.fromEntries(VETO_PERSONA_KEYS.map((k) => [k, values[k]])) };
  check(Object.keys(wholePatch.persona).length === 10, '14.2 前置:整包 patch = VETO_PERSONA_KEYS 的 10 键');
  const hop1 = vetoConsume({
    settings, memory: memW, gated: true, endpoint: '/persona/rollback',
    patch: wholePatch, whole: true, veto: { confirm: true },
  });
  check(hop1.ok === false && !!hop1.forceToken && hop1.reason === VETO_REASON_CONFIRM,
    '14.2 ★第 1 跳(无 id)⇒ forceToken + VETO_REASON_CONFIRM(实测 ' + J(hop1.reason) + ')');
  // ── §14.1/§14.2 加固(m19):第 1 跳的 **kv 终态**不许只靠回执判断(审计 S5:「可被 check(true) 空转」)——
  //    记录必须仍 pending、**只**多一枚 `pendingForceToken`、hist 恰好 2 条(第 2 条 = pending-force-requested)。
  const recW1 = JSON.parse(String(memW.kvGet(VETO_KV_PREFIX + p.id)));
  check(recW1.state === 'pending' && !recW1.decision && Array.isArray(recW1.hist) && recW1.hist.length === 2
    && recW1.hist[1].decision === 'pending-force-requested'
    && /^[0-9a-f]{64}$/.test(String(recW1.pendingForceToken))
    && !recW1.forceToken && !recW1.unsealPinned,
    '14.2 ★第 1 跳零写入:state 仍 pending / hist 恰 2 条 + 第 2 条 pending-force-requested / '
      + '只多一枚 pendingForceToken / 没有 unsealPinned(实测 ' + J(recW1.state) + '/hist='
      + J((recW1.hist || []).map((h) => h.decision)) + '/token=' + J(recW1.pendingForceToken) + ')');
  check(stats.updateCalls === 0 && state.persona.aiTitle === '器灵' && state.persona.sealed === true,
    '14.2 ★第 1 跳之后 settings 一个字节没动:updateCalls = 0(实测 updateCalls=' + J(stats.updateCalls)
      + '/aiTitle=' + J(state.persona.aiTitle) + '/sealed=' + J(state.persona.sealed) + ')');
  const hop2 = vetoConsume({
    settings, memory: memW, gated: true, endpoint: '/persona/rollback',
    patch: wholePatch, whole: true, veto: { confirm: true, token: hop1.forceToken },
  });
  check(hop2.ok === true && hop2.decision === 'veto-overridden-on-pending',
    '14.2 ★第 2 跳 ⇒ ok:true / veto-overridden-on-pending(实测 ' + J(hop2.ok) + '/' + J(hop2.decision) + ')');
  const recW = JSON.parse(String(memW.kvGet(VETO_KV_PREFIX + p.id)));
  check(recW.state === 'overridden' && recW.decision === 'veto-overridden-on-pending',
    '14.2 ★kv 终态(实测 ' + J(recW.state) + '/' + J(recW.decision) + ')');
  check(Array.isArray(recW.hist) && recW.hist.length === 3
    && recW.hist[2].decision === 'veto-overridden-on-pending',
    '14.2 ★hist 第 3 条 = veto-overridden-on-pending(实测 ' + J((recW.hist || []).map((h) => h.decision)) + ')');
  check(recW.afterDigestKnown === true
    && recW.afterDigest === personaDigest({ ...state.persona, ...values })
    && recW.afterDigest === hop2.afterDigest,
    '14.2 ★afterDigest = 投影后的 10 键人格、且 known:true(期望 '
      + J(personaDigest({ ...state.persona, ...values })) + ',实测 ' + J(recW.afterDigest)
      + '/known=' + J(recW.afterDigestKnown) + ')');
  // 两跳都只改 kv:**settings 始终没被写**(端点才在这一跳之后 `settings.update(patch)`)
  check(stats.updateCalls === 0 && state.persona.aiTitle === '器灵' && state.persona.sealed === true,
    '14.2 ★两跳期间 settings 未写:updateCalls = 0(实测 updateCalls=' + J(stats.updateCalls)
      + '/aiTitle=' + J(state.persona.aiTitle) + '/sealed=' + J(state.persona.sealed) + ')');
}
{
  // 14.6 ★MF-3(m16):`whole:true` + **回显 vetoId** + 记录只覆盖**部分键** ⇒ 拒,且一个字节都不动。
  //   靶心是新守卫(`surgery.js:1251-1265`):把它改成"whole 例外"(`&& whole !== true`)后,
  //   这次整包写会掉进 pending 分支、第 1 跳发 `forceToken` ⇒ 本段立刻红(M6 变异此前整套 exit 0)。
  //   与 14.2 的区别只有一个:**带不带 id**(14.2 无 id 是主人整包回滚的出口,照旧两跳放行)。
  const memT = newMem();
  const { settings } = mkSettings();
  const p = propose(settings, memT, { persona: { aiTitle: '整包前的自述', userTitle: '主人' } }, { propose: true }, '/persona/rollback');
  check(p.ok === false && p.reason === 'veto-pending' && !!p.id,
    '14.6 前置:aiTitle+userTitle 上一条 pending(实测 ' + J(p.reason) + ')');
  const valuesT = {
    aiName: '小灵', aiTitle: '回滚后的自述', userTitle: '主人', pronoun: '你', duty: '守着这个家',
    bottomLines: ['不撒谎'], sealed: true, sealPhrase: '那句话', hardRules: [], habits: [],
  };
  const wholePatchT = { persona: Object.fromEntries(VETO_PERSONA_KEYS.map((k) => [k, valuesT[k]])) };
  check(Object.keys(wholePatchT.persona).length === 10, '14.6 前置:整包 patch = 10 键');
  const r = vetoConsume({
    settings, memory: memT, gated: true, endpoint: '/persona/rollback',
    patch: wholePatchT, whole: true, veto: { id: p.id, confirm: true },
  });
  check(r.ok === false && r.reason === 'veto-scope' && !r.forceToken,
    '14.6 ★MF-3 whole + 只覆盖 2 键的记录 id ⇒ veto-scope 且**不发 forceToken**(M6 变异后变 '
      + 'veto-confirm-required + token,实测 ' + J(r.ok) + '/' + J(r.reason || r.decision) + '/token=' + J(r.forceToken) + ')');
  check(J(r.allowed) === J(['aiTitle', 'userTitle']) && Array.isArray(r.got) && r.got.length === 10,
    '14.6 ★回执点名 allowed(2 键)/ got(10 键)(实测 ' + J(r.allowed) + '/' + J(r.got && r.got.length) + ')');
  const recT = JSON.parse(String(memT.kvGet(VETO_KV_PREFIX + p.id)));
  check(recT.state === 'pending' && recT.hist.length === 1 && !recT.pendingForceToken,
    '14.6 ★kv 零写入:state 仍 pending、hist 仍 1 条、没有 pendingForceToken(实测 '
      + J(recT.state) + '/hist=' + recT.hist.length + '/token=' + J(recT.pendingForceToken) + ')');
}
{
  // 14.3 R3-a:approved 记录只覆盖 aiTitle;不带 id ⇒ 走 `vetoFindIn` → approved 内置范围分支,
  //   这条路径是新守卫(带 id)打不到的,专门钉住统一后的文案。
  const memQ = newMem();
  const { settings } = mkSettings();
  const p = propose(settings, memQ, { persona: { aiTitle: '只批这一项' } });
  const ap = await vetoAction({ memory: memQ, settings, action: 'approve', id: p.id });
  check(ap.ok === true && /^[0-9a-f]{64}$/.test(String(ap.nonce)), '14.3 前置:approve + 一次性 nonce');
  const scopeMsg = '这次改动超出了这条否决记录覆盖的字段（aiTitle）。';
  const rNoId = vetoConsume({
    settings, memory: memQ, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '只批这一项', aiName: '顺手改名' } },
    veto: { nonce: ap.nonce },
  });
  check(rNoId.ok === false && rNoId.reason === 'veto-scope',
    '14.3 ★不带 id 的 approved 越界 ⇒ veto-scope(实测 ' + J(rNoId.reason) + ')');
  check(String(rNoId.message) === scopeMsg,
    '14.3 ★文案 = vetoScopeMessage([\'aiTitle\'])(实测 ' + J(String(rNoId.message)) + ')');

  // 14.4 ★MF-4(m16):新守卫的**行为**回归网 —— 错 nonce + 越界 keys,带 id。
  //   守卫在:`:1251-1265` 先拒 ⇒ `veto-scope`(note:nonce 根本没被读到);
  //   守卫被删/被"whole 例外"短路:掉进 approved 分支 ⇒ 先撞 `:1390` 的 nonce 比较 ⇒ `veto-nonce`。
  //   修前这条用的是**对的** nonce:那样 approved 分支自己的范围检查也会给 `veto-scope`,
  //   于是删掉新守卫整套仍绿(§5 `:459-468` 的同形复制,不是回归网)。
  const rWithId = vetoConsume({
    settings, memory: memQ, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '只批这一项', aiName: '顺手改名' } },
    veto: { id: p.id, nonce: 'f'.repeat(64) },
  });
  check(rWithId.reason === 'veto-scope',
    '14.4 ★MF-4 带 id + 错 nonce + 越界 keys ⇒ 先被新守卫拒(veto-scope;守卫被删时是 veto-nonce,实测 '
      + J(rWithId.reason) + ')');
  check(String(rWithId.message) === String(rNoId.message) && String(rWithId.message) === scopeMsg,
    '14.4 ★带 id 与 14.3 的文案逐字相同(实测 ' + J(String(rWithId.message)) + ')');
  const recQ = JSON.parse(String(memQ.kvGet(VETO_KV_PREFIX + p.id)));
  check(recQ.state === 'approved' && recQ.nonceUsedAt === null,
    '14.4 ★被拒的那次零写入:state 仍 approved、nonce 没被消费(实测 '
      + J(recQ.state) + '/' + J(recQ.nonceUsedAt) + ')');
}
{
  // 14.7 ★MF-1(m16 · 行为):**两跳强制不许越过另一条 pending**。
  //   缺陷:`vetoFindIn`(any-overlap)只挑**一条**;无 id 的 10 键整包(`whole:true`,`/persona/rollback`
  //   与 `/import` 的交参形状)两跳 confirm 后 `ok:true`,把 10 键整包写进去 —— 另一条覆盖
  //   `hardRules` 的 pending 全程**不被咨询、不消费、不留痕**,与 `surgery.js:699` 的契约
  //   (「一旦有 pending/vetoed 记录覆盖了这些字段,同字段的任何后续写都不生效」)相反。
  //   now:被越过的那条仍在 ⇒ 按 14.1 同一判据拒(`veto-scope`,回执点名 allowed/got/crossed)。
  const memR = newMem();
  const { settings } = mkSettings();
  const recA = propose(settings, memR, { persona: { aiTitle: '整包前的自述' } }, { propose: true }, '/persona/rollback');
  check(recA.ok === false && recA.reason === 'veto-pending' && !!recA.id,
    '14.7 前置:aiTitle 上一条 pending(实测 ' + J(recA.reason) + ')');
  const recB = propose(settings, memR, { persona: { hardRules: ['先给结论'] } }, { propose: true }, '/persona/rule');
  check(recB.ok === false && recB.reason === 'veto-pending' && recB.id !== recA.id,
    '14.7 前置:hardRules 上另一条 pending(两条不重叠 ⇒ 可并存,实测 ' + J(recB.reason) + ')');
  const valuesR = {
    aiName: '小灵', aiTitle: '回滚后的自述', userTitle: '主人', pronoun: '你', duty: '守着这个家',
    bottomLines: ['不撒谎'], sealed: true, sealPhrase: '那句话', hardRules: ['被越过的规矩'], habits: [],
  };
  const wholePatchR = { persona: Object.fromEntries(VETO_PERSONA_KEYS.map((k) => [k, valuesR[k]])) };
  const hop1 = vetoConsume({
    settings, memory: memR, gated: true, endpoint: '/persona/rollback',
    patch: wholePatchR, whole: true, veto: { confirm: true },
  });
  check(hop1.ok === false && hop1.reason === 'veto-scope' && !hop1.forceToken,
    '14.7 ★MF-1 第 1 跳就不许开票:被越过的 pending 还在 ⇒ veto-scope + 无 forceToken(修前 '
      + 'veto-confirm-required + token,实测 ' + J(hop1.ok) + '/' + J(hop1.reason || hop1.decision)
      + '/token=' + J(hop1.forceToken) + ')');
  const otherId = hop1.id === recA.id ? recB.id : recA.id;
  check(J(hop1.crossed) === J([otherId]),
    '14.7 ★回执点名"被越过的那条"(' + otherId + '),实测 ' + J(hop1.crossed) + '(命中 id=' + J(hop1.id) + ')');
  const hitKv = JSON.parse(String(memR.kvGet(VETO_KV_PREFIX + hop1.id)));
  check(J(hop1.allowed) === J(Object.keys(hitKv.fields)) && Array.isArray(hop1.got) && hop1.got.length === 10,
    '14.7 ★allowed/got 与 14.1 同形(命中记录自己覆盖的字段 vs 本次 10 键,实测 '
      + J(hop1.allowed) + '/' + J(hop1.got && hop1.got.length) + ')');
  const kvA = JSON.parse(String(memR.kvGet(VETO_KV_PREFIX + recA.id)));
  const kvB = JSON.parse(String(memR.kvGet(VETO_KV_PREFIX + recB.id)));
  check(kvA.state === 'pending' && kvB.state === 'pending',
    '14.7 ★两条都仍是 pending(一条都没被这次整包消费掉,实测 ' + J(kvA.state) + '/' + J(kvB.state) + ')');
  check(!kvA.forceToken && !kvB.forceToken && !kvA.pendingForceToken && !kvB.pendingForceToken
    && kvA.hist.length === 1 && kvB.hist.length === 1 && !kvA.decision && !kvB.decision,
    '14.7 ★kv 零写入:没有 forceToken / 没有新 hist / 没有 decision(实测 hist='
      + kvA.hist.length + '/' + kvB.hist.length + ')');
  const hop2 = vetoConsume({
    settings, memory: memR, gated: true, endpoint: '/persona/rollback',
    patch: wholePatchR, whole: true, veto: { confirm: true, token: hop1.forceToken || 'x'.repeat(64) },
  });
  check(hop2.ok === false && hop2.reason === 'veto-scope',
    '14.7 ★MF-1 第 2 跳(带任何 token)同样拒 —— 没有票可越过另一条 pending(修前 ok:true / '
      + 'veto-overridden-on-pending,实测 ' + J(hop2.ok) + '/' + J(hop2.reason || hop2.decision) + ')');
  // 反向对照:被越过的那条一旦了结(rejected),整包强制照旧可走 —— 守卫只拦"仍在挂"的记录。
  const dropped = await vetoAction({ memory: memR, settings, action: 'drop', id: recB.id, by: 'master', confirm: true, reason: '这条先不改' });
  check(dropped.ok === true && dropped.state === 'rejected',
    '14.7 前置:把被越过的那条 drop 成 rejected(实测 ' + J(dropped.state) + ')');
  const afterDrop = vetoConsume({
    settings, memory: memR, gated: true, endpoint: '/persona/rollback',
    patch: wholePatchR, whole: true, veto: { confirm: true },
  });
  check(afterDrop.ok === false && afterDrop.reason === VETO_REASON_CONFIRM && !!afterDrop.forceToken,
    '14.7 ★反向对照:被越过的那条已了结 ⇒ 整包强制照旧可走(第 1 跳给 token,实测 '
      + J(afterDrop.reason) + '/token=' + J(afterDrop.forceToken) + ')');
}

// ══ 14.8 · F4(m19 · 记录感知版):撤锁不许夹带**正被否决覆盖**的字段 ══════════════════════════
//   缺陷(F4,CEO 裁决 2026-11-13):`surgery.js` 的撤锁分支只判"有没有在挂记录",**从不看
//   `keys` 里除 `sealed` 还带了什么** ⇒ `{sealed:false, aiTitle}` + confirm + 第 2 跳 token
//   会 `ok:true`,`/persona` handler 随即 `settings.update(patch)` ⇒ 一次请求可同时撤锁并写
//   任意 persona 字段,绕过该字段上的 pending/vetoed,且记录**仍是 pending**(不消费、不落痕)。
//   now:采用 CEO 裁决的**变体①′**(记录感知)—— 只有"撤锁夹带的键**正被 active 记录覆盖**"时才拒;
//   **没有 active 记录时照旧放行**(否则面板「重归摇篮」整表单撤锁会被 100% 误杀,见 14.8b)。
console.log('▶ 14.8 F4:撤锁不许夹带正被否决覆盖的字段(记录感知版)');
{
  // ── 14.8 ── 最小复现:记录只覆盖 aiTitle,同包 `{sealed:false, aiTitle}` + confirm ⇒ 拒、零写入
  const memX = newMem();
  const { settings, state, stats } = mkSettings();          // sealed:true ⇒ 门真的进
  const p = propose(settings, memX, { persona: { aiTitle: '被挂起的自述' } });
  check(p.ok === false && p.reason === 'veto-pending' && !!p.id,
    '14.8 前置:aiTitle 上一条 pending(实测 ' + J(p.reason) + ')');
  const kvBefore = JSON.parse(String(memX.kvGet(VETO_KV_PREFIX + p.id)));
  const f4 = vetoConsume({
    settings, memory: memX, gated: true, endpoint: '/persona',
    patch: { persona: { sealed: false, aiTitle: 'F4-PWN' } }, veto: { confirm: true },
  });
  // ⚠️ 这条 `check` **不具区分力**(m19-fix 如实标注):修前那次调用**也是** `ok:false`,只是原因不同
  //    ——修前形状 = `reason:'veto-unseal-confirm-required'` + 一枚 64 hex `forceToken`(M1 变异日志自证)。
  //    真正的区分点是下面的 reason / 无 token / kv 无新 hist,不是 `ok`。文案不再写"修前 ok:true"。
  check(f4.ok === false, '14.8 ★F4 复现:撤锁夹带被否决字段 ⇒ 拒(实测 ' + J(f4.ok)
    + ';非区分断言:修前也是 ok:false / "veto-unseal-confirm-required" + 一枚 64 hex token)');
  check(f4.reason === 'veto-unseal-extra-keys',
    '14.8 ★reason = veto-unseal-extra-keys(实测 ' + J(f4.reason) + ')');
  check(f4.reason === VETO_REASON_UNSEAL_EXTRA && VETO_REASON_UNSEAL_EXTRA !== 'veto-scope',
    '14.8 ★新常量不复用 veto-scope 的文案语义(实测 ' + J(VETO_REASON_UNSEAL_EXTRA) + ')');
  check(J(f4.extraKeys) === J(['aiTitle']), '14.8 ★extraKeys 逐字 = [\'aiTitle\'](实测 ' + J(f4.extraKeys) + ')');
  check(J(f4.allowed) === J(['sealed', 'sealPhrase']),
    '14.8 ★allowed = [sealed, sealPhrase](实测 ' + J(f4.allowed) + ')');
  check(J(f4.got) === J(['aiTitle', 'sealed']), '14.8 ★got = 本次 keys(实测 ' + J(f4.got) + ')');
  check(f4.wrote === false, '14.8 ★wrote:false(实测 ' + J(f4.wrote) + ')');
  // ★ 硬约束:守卫在**发第一枚 unsealForceToken 之前** ⇒ 回执里根本没有 token 这个字段
  check(!Object.prototype.hasOwnProperty.call(f4, 'forceToken') && !f4.forceToken,
    '14.8 ★★没有 forceToken(修前第 1 跳就发一枚 64 hex,实测 ' + J(f4.forceToken) + ')');
  check(!String(f4.message).includes('再发一次'), '14.8 ★回执不是"再发一次带 token"(实测 ' + J(String(f4.message)) + ')');
  // ── 零落库(m19-fix / MF-1):修前这里是 `state.persona.aiTitle === '器灵' && sealed === true` —— 恒真断言
  //    (`vetoConsume` 全文零处 `settings.update`,左侧永真;审计 S5 换个形状复发)。现在两步都真:
  //    ① `handlerAfterVeto` 按 `api.js:2238-2267` 的顺序走到写点(只有 `vv.ok===true` 才写)⇒ written 真能是 true;
  //    ② `stats.updateCalls` 是 `mkSettings().update` 的真实计数 ⇒ 谁在拒之后写就会红。
  const hop1Write = await handlerAfterVeto(f4, settings, { persona: { sealed: false, aiTitle: 'F4-PWN' } });
  check(hop1Write.written === false && stats.updateCalls === 0
    && state.persona.aiTitle === '器灵' && state.persona.sealed === true,
    '14.8 ★★零落库:被拒 ⇒ handler 不调 settings.update(实测 written=' + J(hop1Write.written)
      + '/updateCalls=' + J(stats.updateCalls) + '/aiTitle=' + J(state.persona.aiTitle)
      + '/sealed=' + J(state.persona.sealed) + ')');
  const kvAfter = JSON.parse(String(memX.kvGet(VETO_KV_PREFIX + p.id)));
  check(kvAfter.state === 'pending' && kvAfter.decision == null,
    '14.8 ★记录仍 pending、无 decision(实测 ' + J(kvAfter.state) + '/' + J(kvAfter.decision) + ')');
  check(kvAfter.hist.length === kvBefore.hist.length && kvAfter.hist.length === 1,
    '14.8 ★kv 无新 hist(实测 ' + J(kvAfter.hist.length) + ',修前是 ' + J(kvBefore.hist.length) + ' ⇒ 3)');
  check(!kvAfter.unsealForceToken && !kvAfter.unsealPinned && !kvAfter.unsealAt,
    '14.8 ★kv 里也没有 unsealForceToken / unsealPinned(实测 '
      + J(kvAfter.unsealForceToken) + '/' + J(kvAfter.unsealPinned) + ')');
  // 第 2 跳带上任何 token 也一样(没有票可拿)
  //   ⚠️ m19-fix:token 取 `f4.forceToken || 占位串` —— 修好时第 1 跳**不发** token(占位串探"没有票");
  //   守卫被删时第 1 跳会发一枚**真** token,用它才能把"第 2 跳真的会写"复现出来(否则本段在变异下
  //   仍停在 confirm-required,下面的"零落库"就永远不红 —— 那正是评审说的恒真形状)。
  const f4Token = f4.forceToken || 'f'.repeat(64);
  const f4hop2 = vetoConsume({
    settings, memory: memX, gated: true, endpoint: '/persona',
    patch: { persona: { sealed: false, aiTitle: 'F4-PWN' } },
    veto: { confirm: true, token: f4Token },
  });
  check(f4hop2.ok === false && f4hop2.reason === 'veto-unseal-extra-keys' && !f4hop2.forceToken,
    '14.8 ★第 2 跳(带任何 token)同样拒且不发 token(实测 '
      + J(f4hop2.ok) + '/' + J(f4hop2.reason || f4hop2.decision) + '/token=' + J(f4hop2.forceToken) + ')');
  // ── 零落库(m19-fix / MF-1):**第 2 跳**才是 F4 的真正写入口(修前它是 ok:true ⇒ 端点必写)。
  //    删掉守卫整块后这条会红:第 2 跳变 ok:true ⇒ `handlerAfterVeto` 真的调 `settings.update`
  //    ⇒ `updateCalls` 变 1 ⇒ 红在"零落库"上(而不是只在 reason 上)。
  const hop2Write = await handlerAfterVeto(f4hop2, settings, { persona: { sealed: false, aiTitle: 'F4-PWN' } });
  check(hop2Write.written === false && stats.updateCalls === 0
    && state.persona.aiTitle === '器灵' && state.persona.sealed === true,
    '14.8 ★★第 2 跳零落库:带 token 也被拒 ⇒ settings.update 一次都没被调(实测 written='
      + J(hop2Write.written) + '/updateCalls=' + J(stats.updateCalls) + '/aiTitle=' + J(state.persona.aiTitle)
      + '/sealed=' + J(state.persona.sealed) + ')');
}
/** 面板「重归摇篮」实际发的形状:`collect()` 的 7 个 persona 键(`client.js:1893-1919`)
 *  + `sealed:false`(`client.js:2102`)。**守住这个形状 = 守住一个手动按钮**。 */
const PANEL_7 = Object.freeze({
  aiName: '小灵', aiTitle: '器灵', userTitle: '主人', pronoun: '你',
  duty: '', bottomLines: [], hardRules: [],
});
const panelUnsealPatch = () => ({ persona: { ...PANEL_7, sealed: false } });
{
  // ── 14.8b ── 面板整表单撤锁 + **没有任何 active 记录** ⇒ 必须放行(严格版会 100% 打死这个按钮)
  const memY = newMem();
  const { settings } = mkSettings();
  const r = vetoConsume({
    settings, memory: memY, gated: true, endpoint: '/persona',
    patch: panelUnsealPatch(), veto: {},
  });
  check(r.ok === true, '14.8b ★★面板「重归摇篮」(7 键 + sealed:false,无在挂记录)⇒ ok:true(实测 '
    + J(r.ok) + '/' + J(r.reason || r.note) + ')');
  check(r.engaged === false && r.note === 'no-veto-in-play',
    '14.8b ★走的是既有"无记录"路径,不是被新守卫改写成别的形状(实测 ' + J(r.note) + ')');
  check(J(r.keys) === J(['aiName', 'aiTitle', 'userTitle', 'pronoun', 'duty', 'bottomLines', 'sealed', 'hardRules']),
    '14.8b ★7 个表单键 + sealed 都进了本次 keys(白名单顺序,实测 ' + J(r.keys) + ')');
}
{
  // ── 14.8c ── 同一份面板整表单撤锁,但 aiTitle 上有 pending ⇒ 拒,且 aiTitle 不变
  const memZ = newMem();
  const { settings, state, stats } = mkSettings();
  const p = propose(settings, memZ, { persona: { aiTitle: '被挂起的自述' } });
  check(p.ok === false && p.reason === 'veto-pending', '14.8c 前置:aiTitle 上一条 pending(实测 ' + J(p.reason) + ')');
  const r = vetoConsume({
    settings, memory: memZ, gated: true, endpoint: '/persona',
    patch: panelUnsealPatch(), veto: { confirm: true },
  });
  check(r.ok === false && r.reason === 'veto-unseal-extra-keys',
    '14.8c ★面板整表单 + active aiTitle ⇒ veto-unseal-extra-keys(实测 ' + J(r.ok) + '/' + J(r.reason) + ')');
  check(J(r.extraKeys) === J(['aiTitle']),
    '14.8c ★只有**被覆盖的那一个**键被点名(其它 6 个未挂字段不算夹带,实测 ' + J(r.extraKeys) + ')');
  check(J(r.got) === J(['aiName', 'aiTitle', 'userTitle', 'pronoun', 'duty', 'bottomLines', 'sealed', 'hardRules']),
    '14.8c ★got 仍是整份表单的 8 键(白名单顺序,实测 ' + J(r.got) + ')');
  // ── 零落库(m19-fix / MF-1):同 14.8,把恒真的 `aiTitle/sealed 都没变` 换成"handler 一步走完也没写"
  const cWrite = await handlerAfterVeto(r, settings, panelUnsealPatch());
  check(cWrite.written === false && stats.updateCalls === 0
    && state.persona.aiTitle === '器灵' && state.persona.sealed === true,
    '14.8c ★★零落库:面板整表单被拒 ⇒ settings.update 未被调用(实测 written=' + J(cWrite.written)
      + '/updateCalls=' + J(stats.updateCalls) + '/aiTitle=' + J(state.persona.aiTitle)
      + '/sealed=' + J(state.persona.sealed) + ')');
  const rec = JSON.parse(String(memZ.kvGet(VETO_KV_PREFIX + p.id)));
  check(rec.state === 'pending' && rec.hist.length === 1 && !rec.unsealForceToken,
    '14.8c ★记录仍 pending、hist 仍 1 条、无 token(实测 ' + J(rec.state) + '/hist=' + rec.hist.length + ')');
}
{
  // ── 14.8d ── **单独**撤锁(只有 sealed:false)+ confirm/token,且有 active 记录 ⇒ 仍两跳成功
  const memU = newMem();
  const { settings } = mkSettings();
  const p = propose(settings, memU, { persona: { aiTitle: '被挂起的自述' } });
  check(p.ok === false && p.reason === 'veto-pending', '14.8d 前置:aiTitle 上一条 pending');
  const unseal = { persona: { sealed: false } };
  const h1 = vetoConsume({ settings, memory: memU, gated: true, endpoint: '/persona', patch: unseal, veto: { confirm: true } });
  check(h1.ok === false && h1.reason === VETO_REASON_UNSEAL && /^[0-9a-f]{64}$/.test(String(h1.forceToken)),
    '14.8d ★单独撤锁第 1 跳照旧给 forceToken(新守卫不许碰它,实测 '
      + J(h1.reason) + '/token=' + J(h1.forceToken) + ')');
  check(h1.wrote === false, '14.8d ★第 1 跳零写入(实测 ' + J(h1.wrote) + ')');
  const h2 = vetoConsume({
    settings, memory: memU, gated: true, endpoint: '/persona', patch: unseal,
    veto: { confirm: true, token: h1.forceToken },
  });
  check(h2.ok === true && h2.decision === 'veto-unseal-forced' && Array.isArray(h2.pinned) && h2.pinned.includes(p.id),
    '14.8d ★★单独撤锁第 2 跳仍成功 + pin 住在挂记录(实测 '
      + J(h2.ok) + '/' + J(h2.decision) + '/' + J(h2.pinned) + ')');
  check(h2.unseal === true && J(h2.keys) === J(['sealed']),
    '14.8d ★该分支既有回执字段没被改动(unseal:true / keys=[sealed],实测 ' + J(h2.unseal) + '/' + J(h2.keys) + ')');
  const rec = JSON.parse(String(memU.kvGet(VETO_KV_PREFIX + p.id)));
  check(rec.unsealPinned === true && rec.hist.some((h) => h.decision === 'veto-unseal-forced'),
    '14.8d ★记录被 pin 且留痕 veto-unseal-forced(实测 ' + J(rec.unsealPinned) + ')');
  await settings.update(unseal);                     // 端点在第 2 跳之后才写
  // ── 14.8e ── 撤锁之后写 aiTitle ⇒ 门外仍被 pinned 记录拦
  const after = vetoConsume({
    settings, memory: memU, gated: false, endpoint: '/persona',
    patch: { persona: { aiTitle: '撤锁后偷改' } }, veto: {},
  });
  check(after.ok === false && after.reason === 'veto-pending' && after.id === p.id,
    '14.8e ★撤锁之后该键的写仍拒(veto-pending,实测 ' + J(after.ok) + '/' + J(after.reason) + ')');
  const freeKey = vetoConsume({
    settings, memory: memU, gated: false, endpoint: '/persona',
    patch: { persona: { bottomLines: ['不撒谎'] } }, veto: {},
  });
  check(freeKey.ok === true && freeKey.note === 'veto-inactive-outside-gate',
    '14.8e ★未被覆盖的字段门外照旧放行(不误伤,实测 ' + J(freeKey.note) + ')');
}

// ══ 14.8f · MF-1(m19-fix):`/persona` handler 的**顺序**机械断言 ═══════════════════════════════
//   "零落库"不能只靠回执字段:真正让它成立的是 `api.js` 里 `vetoConsume` → `if (!vv.ok) return
//   vetoReject(...)` → `settings.update(patch)` 这个**顺序**。两条变异各自红在不同断言上:
//   ① 删掉 `if (!vv.ok) return vetoReject(...)` ⇒ 本节红(拒门不见了);
//   ② 把 `settings.update(patch)` 挪到 `vetoConsume` 之前 ⇒ 本节红(写点跑到了判据之前)。
//   (这是评审 MF-1 的②:与第 0 组的门面/否决面机械断言同风格 —— 只读源码,不起服务。)
console.log('▶ 14.8f /persona handler 顺序:vetoConsume ⇒ 拒 ⇒ 才写(零落库的结构判据)');
{
  const apiSrc = readFileSync(join(root, 'lib/host/api.js'), 'utf8');
  const s0 = apiSrc.indexOf("register('/persona'");
  const e0 = apiSrc.indexOf('disposers.push(register(', s0 + 10);
  const block = s0 < 0 ? '' : apiSrc.slice(s0, e0 < 0 ? apiSrc.length : e0);
  check(block.length > 0, '14.8f 前置:在 api.js 里找到 /persona 的 handler 块(实测长度 ' + J(block.length) + ')');
  const idxVeto = block.indexOf('vetoConsume(');
  const idxReject = block.indexOf('if (!vv.ok) return vetoReject(');
  const idxWrite = block.indexOf('settings.update(');
  check(idxVeto >= 0 && idxReject > idxVeto && idxWrite > idxReject,
    '14.8f ★★顺序 = vetoConsume ⇒ if (!vv.ok) return vetoReject ⇒ settings.update(实测下标 '
      + J(idxVeto) + ' / ' + J(idxReject) + ' / ' + J(idxWrite) + ')');
  check(block.slice(idxVeto, idxWrite).includes('if (!vv.ok) return vetoReject('),
    '14.8f ★★拒门夹在否决面与写点之间(删掉它 ⇒ 本节和 14.8/14.8c 一起红)');
  check(!block.slice(0, idxVeto).includes('settings.update('),
    '14.8f ★★写点在判据之后:第一次出现 settings.update 的位置必须晚于 vetoConsume');
  // 计数只看**代码行**(切块会带上下一段 handler 的注释,那里恰好提到一句 `settings.update({ auto: clean })`)
  const codeOnly = block.split(/\r?\n/).filter((ln) => !/^\s*\/\//.test(ln)).join('\n');
  const writeCount = (codeOnly.match(/settings\.update\(/g) || []).length;
  check(writeCount === 1,
    '14.8f ★/persona 块里 settings.update 恰好 1 处(多出来的写点会绕过这道拒门,实测 ' + J(writeCount) + ')');
}

// ══ 14.9 · S4:多字段文案 —— `allowed.join('/')` 的分隔符只在多字段时才出现 ═══════════════════
//   §14.3 只用**单字段** `['aiTitle']` 的文案做字面量 oracle ⇒ 分隔符从未出现在断言里,
//   `join('/')` 被改成 `join(' / ')` 不会红。本段把**两字段**的两条文案都钉成逐字。
console.log('▶ 14.9 多字段文案(两条 veto 出口的分隔符都要被钉住)');
{
  const memV = newMem();
  const { settings } = mkSettings();
  const p = propose(settings, memV, { persona: { aiTitle: '甲', userTitle: '乙' } }, { propose: true }, '/persona');
  check(p.ok === false && p.reason === 'veto-pending', '14.9 前置:aiTitle+userTitle 上一条 pending');
  const r = vetoConsume({
    settings, memory: memV, gated: true, endpoint: '/persona',
    patch: { persona: { aiTitle: '甲', userTitle: '乙', aiName: '丙' } }, veto: { id: p.id },
  });
  check(r.ok === false && r.reason === 'veto-scope', '14.9 前置:多字段越界 ⇒ veto-scope(实测 ' + J(r.reason) + ')');
  check(J(r.allowed) === J(['aiTitle', 'userTitle']), '14.9 ★allowed 两字段逐字(实测 ' + J(r.allowed) + ')');
  check(String(r.message) === '这次改动超出了这条否决记录覆盖的字段（aiTitle/userTitle）。',
    '14.9 ★★veto-scope 多字段文案逐字(实测 ' + J(String(r.message)) + ')');
  check(String(r.message).includes('aiTitle/userTitle'), '14.9 ★分隔符 = "/"(不留空格)');
  check(!/aiTitle\s+\/\s+userTitle/.test(String(r.message)), '14.9 ★不许变成 " / "(S4 的靶)');
}
{
  // 撤锁夹带这条出口自己的多字段文案:两个 extraKeys ⇒ "aiTitle / userTitle"
  const memV2 = newMem();
  const { settings } = mkSettings();
  const p = propose(settings, memV2, { persona: { aiTitle: '甲', userTitle: '乙' } }, { propose: true }, '/persona');
  check(p.ok === false && p.reason === 'veto-pending', '14.9b 前置:一条记录覆盖 aiTitle + userTitle');
  const r = vetoConsume({
    settings, memory: memV2, gated: true, endpoint: '/persona',
    patch: { persona: { sealed: false, aiTitle: '甲', userTitle: '乙' } }, veto: { confirm: true },
  });
  check(r.reason === 'veto-unseal-extra-keys', '14.9b 前置:撤锁夹带两个被覆盖字段 ⇒ 拒(实测 ' + J(r.reason) + ')');
  check(J(r.extraKeys) === J(['aiTitle', 'userTitle']),
    '14.9b ★extraKeys 两字段逐字(实测 ' + J(r.extraKeys) + ')');
  check(String(r.message).includes('aiTitle / userTitle'),
    '14.9b ★★撤锁夹带的多字段文案用 " / " 分隔(实测 ' + J(String(r.message)) + ')');
  check(String(r.message).startsWith('撤锁（sealed:false）夹带了正被否决覆盖的字段：'),
    '14.9b ★文案开头说清了是"撤锁夹带被否决覆盖的字段"(实测 ' + J(String(r.message)) + ')');
}

console.log('');
if (failures) {
  console.error(failures + ' 项失败');
  process.exitCode = 1;
} else {
  console.log('M5/M7 人格层否决权:六组验收 + 14 条门面 / 14 条否决面机械断言全部通过 ✓');
}
