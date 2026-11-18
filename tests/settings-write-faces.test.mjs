// dsh-ling — M21-3 · settings 写面源级枚举断言(rc.4 · ALIGN-v7 §1.4)
// -------------------------------------------------------------------------------------------
// 本文件 = 两件事:
//   ① 常量 `SETTINGS_WRITE_FACES`(21 行 / 20 端点),逐行 = ALIGN-v7 §1.3 的 21 行表;
//   ② 断言组(源级,读源码法,模板 = tests/mode.test.mjs:218-226 的 readFileSync + check):
//      E1  长度 === 21(「登记后 21」:M21-4 / M21-7 各 +1 行;rc.4 前的 19 不是断言基数)
//      E2  去重端点 === 20(「登记后 20」;登记前 18)
//      E3  每行 regAt/endAt 与现树实测逐字相等(register 行 / 第一条 `    }));`)
//      E4  table → source:每个写点在源码里真的是非注释的 `settings.update(` 行
//      E5  endpoint 类写点 `file:line` 在数组里恰好出现一次(api.js:3676 只许挂在 /suggestions/apply),
//          且 endpoint 类写点条数 === 14(现树 api.js 的 14 条真写点;少一条即红)
//      E6  `writeAt:null` 白名单 === ['/persona/check','/persona/genesis'],其余行非空
//      E7  endpoint 类写点 `line ∈ [regAt,endAt]`(同一文件;跨文件即红)
//      E8  helper 类写点 `calledFrom ∈ [regAt,endAt]` 且 file ∈ {rules.js,suggestions.js,mode.js}
//      E9  `gate:'surgery'` 行的门行号 < **被判定写点的那一行**(endpoint 用 writeAt.line,
//          helper 用 calledFrom;**绝不**拿 helper 文件行号比 —— rules.js:81 比任何 api.js 行都小)
//      E10 `if (!gateSurgery(` 非注释出现 === 14(M24b:全局半边去门、远端允许,门调用点 15 → 14)
//      E11 门级别自洽:surgery 行 handler 内恰 1 条门;其余行 0 条;confirm 行含 confirmEffort;
//          local 行含本机判据
//      E12 双向补集 A:api.js 里每个"直写 settings 的 handler"都必须登记,且该 handler 的写行集合
//          与表里该端点的 endpoint 类写点集合**相等**(新端点不登记 ⇒ 红)
//      E13 双向补集 B:三个 helper 文件里的每条 `settings.update(` 都必须被某个 helper 写点覆盖
//      E14 helper 覆盖数:rules.js:81 === 7 个端点(§1.3 行 4/5/6/7/8/12/13)、suggestions.js:32 === 1、
//          mode.js:91 === 1
//      E15 清单自洽(surgery.js):第 15 行含「14 行 = 14 个受门端点」、第 19 行含「实际 15 条」、
//          第 51 行 === 79 字符表头逐字、第 65 行 === 90 字符历史行逐字、清单 14 行且序号 1..14
//
// 跑法(交付目录内):
//   node settings-write-faces.test.mjs                 # 基线:全绿 exit 0
//   node settings-write-faces.test.mjs --table         # 另打印 21 行证据表
//   node settings-write-faces.test.mjs --mutate=MUT-A1 # 变异:期望变红(exit 0 = 如期红),日志即证据
// 变异 id:MUT-A1 / MUT-A2 / MUT-DROP / MUT-UNREG / MUT-3454
//
// ⚠️ 写边界:M21-3 的交付目录 = _crew/reports/m21-3(本文件所在)。落到产品位置请由集成方二选一:
//   a) `SETTINGS_WRITE_FACES` 段搬进 `lib/host/surgery.js`(顶部清单旁)+ 本文件搬进 `tests/`;
//   b) 整份搬进 `tests/settings-write-faces.test.mjs`(自包含,根目录靠向上找 `lib/host/api.js`)。
// -------------------------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 常量:settings 写面全景(21 行 / 20 端点;行号 = 本卡开工时 M21-4 + M21-7 落地后的实测值)
// 形状 = { endpoint, gate:'surgery'|'confirm'|'local'|'none', regAt, endAt, writeAt, reason }
//   writeAt = null                        // 0 settings 写(只许 §1.4-2 的白名单两项)
//           | { file, line, kind:'endpoint'|'helper', calledFrom? }
//           | [ 同上, … ]                 // 一个端点有多条写点行时用数组(逐条都判区间)
//   多写点的行(/assistant/config、/inject、/suggestions/apply、/persona/hint-adopt 等)用数组,
//   否则 21 行装不下 27 个写点 —— 形状的"一个端点一行"口径来自 ALIGN-v7 §1.3,不拆行。
// ═══════════════════════════════════════════════════════════════════════════════════════════
export const SETTINGS_WRITE_FACES = [
  // ── §1.3 行 1–14:受手术门的 14 个端点(其中行 2、行 11 是 0 settings 写) ───────────────────
  { endpoint: '/persona', gate: 'surgery', regAt: 2357, endAt: 2411,
    writeAt: { file: 'api.js', line: 2393, kind: 'endpoint' },
    reason: '写 persona.* / styles.*(api.js:2393 settings.update(appended ? {persona,styles} : {persona}))' },

  { endpoint: '/persona/check', gate: 'surgery', regAt: 2697, endAt: 2714, writeAt: null,
    reason: '验句预言机,0 settings 写(api.js:2698 自述):只过门、不落盘' },

  { endpoint: '/persona/self-summary', gate: 'surgery', regAt: 2732, endAt: 2753,
    writeAt: { file: 'api.js', line: 2743, kind: 'endpoint' },
    reason: '写 persona.aiTitle(api.js:2743)' },

  { endpoint: '/persona/hint-adopt', gate: 'surgery', regAt: 2758, endAt: 2787,
    writeAt: [
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2773 }, // proposeHabit → persist
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2775 }, // resolveHabit → persist
    ],
    reason: '写 habits / habitsPending(rules.js:81 ← api.js:2773/2775);**不写 ruleMeta**(ruleMeta 只由 addRule/removeRule 写 = 行 5)' },

  { endpoint: '/persona/rule', gate: 'surgery', regAt: 2800, endAt: 2840,
    writeAt: [
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2809 }, // removeRule → persist
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2820 }, // addRule → persist
    ],
    reason: '写 hardRules / ruleMeta(rules.js:81 ← api.js:2809 removeRule / 2820 addRule)' },

  { endpoint: '/persona/habit', gate: 'surgery', regAt: 2844, endAt: 2876,
    writeAt: [
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2853 }, // proposeHabit → persist
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2866 }, // resolveHabit → persist
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2872 }, // removeHabit → persist
    ],
    reason: '写 habits / habitsPending(rules.js:81 ← api.js:2853/2866/2872)' },

  { endpoint: '/persona/habits/scan', gate: 'surgery', regAt: 2880, endAt: 2926,
    writeAt: { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 2913 },
    reason: '写 habitsPending(rules.js:81 ← api.js:2913 proposeHabit)' },

  { endpoint: '/persona/habits/reflect', gate: 'surgery', regAt: 2930, endAt: 3043,
    writeAt: { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 3030 },
    reason: '写 habitsPending(rules.js:81 ← api.js:3030 proposeHabit;另写 kv habits.reflect.* = 运行记录,非 settings)' },

  { endpoint: '/persona/grow', gate: 'surgery', regAt: 3102, endAt: 3137,
    writeAt: { file: 'api.js', line: 3127, kind: 'endpoint' },
    reason: '写 persona.*(+styles)(api.js:3127)' },

  { endpoint: '/persona/rollback', gate: 'surgery', regAt: 3140, endAt: 3169,
    writeAt: { file: 'api.js', line: 3159, kind: 'endpoint' },
    reason: '写 persona / styles 回滚(api.js:3159)' },

  { endpoint: '/persona/genesis', gate: 'surgery', regAt: 3537, endAt: 3586, writeAt: null,
    reason: '0 settings 写(writeAt:null 白名单第 2 项):唯一写盘 = api.js:3581 memory.kvSet("genesis.last", …),非 settings' },

  { endpoint: '/feedback/apply', gate: 'surgery', regAt: 3607, endAt: 3629,
    writeAt: { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 3617 },
    reason: '写 habits(rules.js:81 ← api.js:3617 applySuggestionAsRule → feedback.js:211/213 proposeHabit/resolveHabit)' },

  { endpoint: '/suggestions/apply', gate: 'surgery', regAt: 3655, endAt: 3690,
    writeAt: [
      { file: 'api.js', line: 3676, kind: 'endpoint' },                                // 身份支 sealPhrase
      { file: 'suggestions.js', line: 32, kind: 'helper', calledFrom: 3678 },           // aiName/userTitle
      { file: 'rules.js', line: 81, kind: 'helper', calledFrom: 3678 },                 // hardrule 支 → proposeHabit
    ],
    reason: '写 sealPhrase(api.js:3676 身份支)+ aiName/userTitle/…(suggestions.js:32 ← api.js:3678)+ habits(rules.js:81 ← 同跳 hardrule 支)。api.js:3676 **只**属于本行(不许挂回 /persona/genesis)' },

  { endpoint: '/import', gate: 'surgery', regAt: 3812, endAt: 3863,
    writeAt: { file: 'api.js', line: 3846, kind: 'endpoint' },
    reason: '写整包(api.js:3846)' },

  // ── §1.3 行 15/16:`/mode/toggle` 两半边(同一 register,两行) ──────────────────────────────
  { endpoint: '/mode/toggle', half: 'global', gate: 'none', regAt: 2150, endAt: 2231,
    writeAt: { file: 'api.js', line: 2205, kind: 'endpoint' },
    reason: '全局半边(M24b 起):**confirm:true + 宿主认证;不限定本机**(远端也可设新会话默认);模型原样;不过手术门 ⇒ 写 mode.lastMode(api.js:2205)+ 平台默认档位(api.js:2195 saveSelection,只换 reasoningEffort)' },

  { endpoint: '/mode/toggle', half: 'session', gate: 'none', regAt: 2150, endAt: 2231,
    writeAt: { file: 'mode.js', line: 91, kind: 'helper', calledFrom: 2227 },
    reason: '会话半边:**门已删(D-2),rc.4 后 0 settings 写** —— mode.js:91 只在 opts.setDefault===true 时执行,而 mode.js:105 缺省 false + api.js:2227 显式 {setDefault:false} ⇒ 双侧钉死(仓内无到达点)。登记它只为补集断言:E13 的"第 17 条真调用"不成孤儿' },

  // ── §1.3 行 17–19:免手术门的三个已建写面 ────────────────────────────────────────────────
  { endpoint: '/inject', gate: 'none', regAt: 2477, endAt: 2596,
    writeAt: [
      { file: 'api.js', line: 2525, kind: 'endpoint' }, // inject.* 收窄后
      { file: 'api.js', line: 2536, kind: 'endpoint' }, // persona.enabled + inject.memoryEnabled(入位支)
    ],
    reason: '已知例外(有意不过门,surgery.js:16-18):写 inject.* / persona.enabled(api.js:2525/2536);端点内自有白名单' },

  { endpoint: '/auto', gate: 'none', regAt: 2420, endAt: 2456,
    writeAt: { file: 'api.js', line: 2440, kind: 'endpoint' },
    reason: '免手术门:写 auto 五键(api.js:2440);端点内自有 sanitizeAutoPatch 白名单 + AUTO_NUMBER_RANGES 区间' },

  { endpoint: '/assistant/config', gate: 'none', regAt: 2099, endAt: 2129,
    writeAt: [
      { file: 'api.js', line: 2103, kind: 'endpoint' }, // 清空支
      { file: 'api.js', line: 2118, kind: 'endpoint' }, // 收窄后 patch
    ],
    reason: '免手术门:写 assistant.baseUrl/model(api.js:2103 清空支 / 2118 收窄支);端点内双键窄口 + ^https?:// 正则' },

  // ── §1.3 行 20/21:rc.4 两个新端点(M21-7 / M21-4 落地后各登记一行) ────────────────────────
  { endpoint: '/mode/effort', gate: 'confirm', regAt: 2277, endAt: 2340,
    writeAt: { file: 'api.js', line: 2319, kind: 'endpoint' },
    reason: 'rc.4 新端点(M21-7):轻确认 + 仅本机;不带 confirmEffort ⇒ 200 confirmation-required + applied:none + 0 写;带 true ⇒ 只写 mode.mapping.<mode>.effort(api.js:2319);不过手术门、不进 surgery-*.jsonl' },

  { endpoint: '/model/background', gate: 'local', regAt: 2654, endAt: 2692,
    writeAt: { file: 'api.js', line: 2688, kind: 'endpoint' },
    reason: 'rc.4 新端点(M21-4):仅本机 + 类型校验(只收 string)+ 拒 __proto__/constructor/prototype;写 model.background.{provider,model}(api.js:2688);不过手术门' },
];

// ── 口径常量(断言读这里,不许散落) ─────────────────────────────────────────────────────────
export const EXPECTED_ROWS = 21;                      // 登记后 21(rc.4 前 19 不作基数)
export const EXPECTED_ENDPOINTS = 20;                 // 登记后 20(登记前 18)
export const EXPECTED_GATE_CALLS = 14;                // `if (!gateSurgery(` 非注释
export const NULL_WRITE_WHITELIST = ['/persona/check', '/persona/genesis'];
export const HELPER_WRITE_FILES = ['rules.js', 'suggestions.js', 'mode.js'];
export const SOURCE_FILES = ['api.js', 'surgery.js', 'rules.js', 'suggestions.js', 'mode.js'];
// §1.4-7 的两条逐字串(94 / 79 字符;不切列、不查列下标)
export const SURGERY_LIST_HEADER = '//    #  端点                      register 行   "原"过门情况(改前)                    改后';
export const SURGERY_LIST_LAST_ROW = '//    14 /import                     3812     过门(2788)⚠️ 见下                        过门 + 前移';

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 读源码 + 实测(模板:mode.test.mjs:218-226 —— readFileSync + 正则判)
// ═══════════════════════════════════════════════════════════════════════════════════════════
function findRoot() {
  if (process.env.DSH_LING_SOURCE_ROOT) return resolve(process.env.DSH_LING_SOURCE_ROOT);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'lib', 'host', 'api.js'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('找不到 source 根目录(需要 lib/host/api.js);可用 DSH_LING_SOURCE_ROOT 指定');
}

export function loadSources(root, overrides) {
  const out = {};
  for (const f of SOURCE_FILES) {
    const text = overrides && typeof overrides[f] === 'string'
      ? overrides[f]
      : readFileSync(join(root, 'lib', 'host', f), 'utf8');
    out[f] = text.split(/\r?\n/);
  }
  return out;
}

const isComment = (ln) => /^\s*(\/\/|\*|\/\*)/.test(ln);
const isSettingsUpdate = (ln) => ln.includes('settings.update(') && !isComment(ln);
const isGateCall = (ln) => /if \(!gateSurgery\(/.test(ln) && !isComment(ln);

export function measureRoutes(apiLines) {
  const routes = [];
  for (let i = 0; i < apiLines.length; i++) {
    const m = /disposers\.push\(register\('([^']+)'/.exec(apiLines[i]);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < apiLines.length; j++) {
      // handler 末行:`    }));`(/persona/*)或 `    })));`(libraryRoute 包裹)
      if (/^\s{4}\}\)+;\s*$/.test(apiLines[j])) { end = j + 1; break; }
    }
    routes.push({ path: m[1], reg: i + 1, end });
  }
  return routes;
}

export function measureWriteLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) if (isSettingsUpdate(lines[i])) out.push(i + 1);
  return out;
}

export function measureGateLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) if (isGateCall(lines[i])) out.push(i + 1);
  return out;
}

const pointsOf = (entry) => (entry.writeAt == null ? [] : (Array.isArray(entry.writeAt) ? entry.writeAt : [entry.writeAt]));
const routeOf = (routes, endpoint) => routes.find((r) => r.path === endpoint);
const inHandler = (line, route) => line >= route.reg && line <= route.end;

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 断言组
// ═══════════════════════════════════════════════════════════════════════════════════════════
export function runAssertions({ sources, faces }) {
  const checks = [];
  const chk = (code, ok, msg) => checks.push({ code, ok, msg });

  const api = sources['api.js'];
  const routes = measureRoutes(api);
  const apiWriteLines = measureWriteLines(api);
  const apiGateLines = measureGateLines(api);

  // ── E1 长度 ─────────────────────────────────────────────────────────────────────────────
  chk('E1', faces.length === EXPECTED_ROWS,
    `SETTINGS_WRITE_FACES 长度 === 21(**登记后 21**:M21-4/M21-7 各 +1 行;rc.4 前的 19 不是断言基数),实际 ${faces.length}`);

  // ── E2 去重端点 ─────────────────────────────────────────────────────────────────────────
  const endpoints = new Set(faces.map((f) => f.endpoint));
  chk('E2', endpoints.size === EXPECTED_ENDPOINTS,
    `去重端点 === 20(**登记后 20**;登记前 18),实际 ${endpoints.size}`);

  // ── E3 regAt/endAt 与现树实测逐字相等 ───────────────────────────────────────────────────
  for (const f of faces) {
    const r = routeOf(routes, f.endpoint);
    const tag = f.half ? `${f.endpoint}[${f.half}]` : f.endpoint;
    if (!r) { chk('E3', false, `${tag}: 源码里找不到 register('${f.endpoint}')`); continue; }
    chk('E3', r.reg === f.regAt, `${tag}: regAt 表内 ${f.regAt} vs 实测 ${r.reg}`);
    chk('E3', r.end === f.endAt, `${tag}: endAt 表内 ${f.endAt} vs 实测 ${r.end}`);
  }

  // ── E4 table → source:写点在源码里真是非注释的 settings.update( ──────────────────────────
  for (const f of faces) {
    for (const p of pointsOf(f)) {
      const lines = sources[p.file];
      const ok = Array.isArray(lines) && lines[p.line - 1] !== undefined && isSettingsUpdate(lines[p.line - 1]);
      chk('E4', ok,
        `${f.endpoint}${f.half ? `[${f.half}]` : ''}: ${p.file}:${p.line} 必须是**非注释**的 settings.update( 行` +
        (ok ? '' : ` —— 实际="${String(lines && lines[p.line - 1]).trim().slice(0, 100)}"`));
    }
  }

  // ── E5 endpoint 类写点唯一(api.js:3676 只许挂在 /suggestions/apply) ────────────────────
  const seen = new Map();
  for (const f of faces) {
    for (const p of pointsOf(f)) {
      if (p.kind !== 'endpoint') continue;
      const key = `${p.file}:${p.line}`;
      const owner = `${f.endpoint}${f.half ? `[${f.half}]` : ''}`;
      if (seen.has(key)) chk('E5', false, `endpoint 写点 ${key} 出现两次:${seen.get(key)} 与 ${owner}(每个 file:line 恰好一次)`);
      else seen.set(key, owner);
    }
  }
  chk('E5', seen.size === 14, `endpoint 类写点唯一性已逐条判(现树 endpoint 类写点 === 14 条 api.js 写点,各 1 次;实际 ${seen.size})`);

  // ── E6 writeAt:null 白名单 ─────────────────────────────────────────────────────────────
  const nullFaces = faces.filter((f) => f.writeAt == null).map((f) => f.endpoint).sort();
  const wantNull = [...NULL_WRITE_WHITELIST].sort();
  chk('E6', JSON.stringify(nullFaces) === JSON.stringify(wantNull),
    `writeAt:null 白名单只许 ${JSON.stringify(NULL_WRITE_WHITELIST)},实际 ${JSON.stringify(nullFaces)}`);
  for (const f of faces) {
    if (f.writeAt != null && pointsOf(f).length === 0) chk('E6', false, `${f.endpoint}: writeAt 非空但无写点`);
  }

  // ── E7 endpoint 类:line ∈ [regAt,endAt](同文件) ────────────────────────────────────────
  for (const f of faces) {
    const r = routeOf(routes, f.endpoint);
    for (const p of pointsOf(f)) {
      if (p.kind !== 'endpoint') continue;
      const tag = `${f.endpoint}${f.half ? `[${f.half}]` : ''}`;
      if (p.file !== 'api.js') { chk('E7', false, `${tag}: endpoint 类写点必须同文件 api.js,实际 ${p.file}`); continue; }
      chk('E7', r && inHandler(p.line, r),
        `${tag}: 写点 ${p.file}:${p.line} 必须落在 handler [${r ? r.reg : '?'},${r ? r.end : '?'}] 内` +
        (r && !inHandler(p.line, r) ? `(endAt=${r.end} < ${p.line} ⇒ 区间判定红;旧"门行 < 写行"判据仍会假绿)` : ''));
    }
  }

  // ── E8 helper 类:calledFrom ∈ [regAt,endAt] 且 file ∈ helper 集 ─────────────────────────
  for (const f of faces) {
    const r = routeOf(routes, f.endpoint);
    for (const p of pointsOf(f)) {
      if (p.kind !== 'helper') continue;
      const tag = `${f.endpoint}${f.half ? `[${f.half}]` : ''}`;
      chk('E8', HELPER_WRITE_FILES.includes(p.file),
        `${tag}: helper 写点 file 必须 ∈ ${JSON.stringify(HELPER_WRITE_FILES)},实际 ${p.file}`);
      chk('E8', Number.isInteger(p.calledFrom),
        `${tag}: helper 写点必须带 calledFrom(调用它的 api.js 行),实际 ${String(p.calledFrom)}`);
      chk('E8', r && Number.isInteger(p.calledFrom) && inHandler(p.calledFrom, r),
        `${tag}: helper calledFrom=${p.calledFrom} 必须落在 [${r ? r.reg : '?'},${r ? r.end : '?'}] 内`);
    }
  }

  // ── E9 surgery 行:门行号 < 被判定写点的那一行(endpoint→writeAt.line;helper→calledFrom) ──
  for (const f of faces) {
    if (f.gate !== 'surgery') continue;
    // 0 写的两行(/persona/check、/persona/genesis)没有"被判定写点",门后没有写点可比 ⇒ 由 E6 白名单判
    if (pointsOf(f).length === 0) continue;
    const r = routeOf(routes, f.endpoint);
    const tag = `${f.endpoint}${f.half ? `[${f.half}]` : ''}`;
    const gates = r ? apiGateLines.filter((l) => inHandler(l, r)) : [];
    chk('E9', gates.length === 1, `${tag}: surgery 行必须恰有 1 条 gateSurgery,实际 ${JSON.stringify(gates)}`);
    if (gates.length !== 1) continue;
    const judged = pointsOf(f).map((p) => (p.kind === 'helper' ? p.calledFrom : p.line)).filter((n) => Number.isInteger(n));
    chk('E9', judged.length > 0, `${tag}: surgery 行必须有可判定的写点(不许 writeAt:null)`);
    for (const line of judged) {
      chk('E9', gates[0] < line,
        `${tag}: 门行 ${gates[0]} < 写点行 ${line}(helper 一律用 calledFrom,不拿 ${'rules.js:81'} 这类 helper 行号比)`);
    }
  }

  // ── E10 gateSurgery 调用点 === 14(M24b:全局半边去门,门调用点 −1)──────────────────────
  chk('E10', apiGateLines.length === EXPECTED_GATE_CALLS,
    `if (!gateSurgery( 非注释出现 === 14,实际 ${apiGateLines.length} @ ${JSON.stringify(apiGateLines)}`);

  // ── E11 门级别自洽 ──────────────────────────────────────────────────────────────────────
  // ⚠️ `/mode/toggle` 两半边**共用同一个 handler**(同一 register)⇒ 门数按"端点"判:
  //    handler 内门数 === 该端点**表内 surgery 行数**(M24 起 = 0,全局半边改 `local`、会话半边 `none`)。
  //    任一半边加回门 ⇒ 1 ≠ 0 ⇒ 红(MUT-A1);全局半边的仅本机判据被拆 ⇒ `local` 行的 readIsLocal 断言红(MUT-A2)。
  for (const ep of [...new Set(faces.map((f) => f.endpoint))]) {
    const rows = faces.filter((f) => f.endpoint === ep);
    const r = routeOf(routes, ep);
    if (!r) continue;
    const gates = apiGateLines.filter((l) => inHandler(l, r));
    const want = rows.filter((f) => f.gate === 'surgery').length;
    chk('E11', gates.length === want,
      `${ep}: handler 内 gateSurgery ${gates.length} 条 vs 表内 surgery 行 ${want} 行(相差即红` +
      `${ep === '/mode/toggle' ? ';两半边共用 handler,会话半边不许再加门' : ''})`);
    // ⚠️ 只认**非注释**行:注释里提到 `readIsLocal` / `confirmEffort` 不算数
    //    (否则把调用删掉、注释留着仍绿 —— MUT-A2 已删除,不再自证)。
    const body = api.slice(r.reg - 1, r.end).filter((ln) => !isComment(ln)).join('\n');
    for (const f of rows) {
      const tag = `${ep}${f.half ? `[${f.half}]` : ''}`;
      if (f.gate === 'confirm') chk('E11', body.includes('confirmEffort'), `${tag}: gate='confirm' ⇒ handler 内必须含 confirmEffort`);
      if (f.gate === 'local') chk('E11', /readIsLocal|isLocalSurgeryRequest/.test(body), `${tag}: gate='local' ⇒ handler 内必须含本机判据`);
      if (f.gate === 'none' && !f.half) chk('E11', gates.length === 0, `${tag}: gate='none' ⇒ handler 内 gateSurgery 必须为 0,实际 ${JSON.stringify(gates)}`);
    }
  }

  // ── E12 双向补集 A:直写 settings 的 api.js handler 全部登记,且写行集合相等 ───────────────
  const writableHandlers = routes.filter((r) => apiWriteLines.some((l) => inHandler(l, r)));
  chk('E12', writableHandlers.length === 12,
    `api.js 里"直写 settings 的 handler" === 12(§1.3:12 条 api.js 真调用),实际 ${writableHandlers.length}:${JSON.stringify(writableHandlers.map((r) => r.path))}`);
  for (const r of writableHandlers) {
    const rows = faces.filter((f) => f.endpoint === r.path);
    if (!rows.length) {
      chk('E12', false, `handler ${r.path}(${r.reg}..${r.end})直写 settings,但枚举表里没有它(新端点未登记 / 枚举项被删)`);
      continue;
    }
    const measured = apiWriteLines.filter((l) => inHandler(l, r));
    const declared = [...new Set(rows.flatMap(pointsOf).filter((p) => p.kind === 'endpoint' && p.file === 'api.js').map((p) => p.line))].sort((a, b) => a - b);
    chk('E12', JSON.stringify(measured) === JSON.stringify(declared),
      `${r.path}: 直写行 ${JSON.stringify(measured)} 必须与表内 endpoint 写点 ${JSON.stringify(declared)} 逐一相等`);
  }
  // 方向二:表里每个 endpoint 写点必须属于某个直写 handler(孤儿写点即红)
  for (const f of faces) {
    for (const p of pointsOf(f)) {
      if (p.kind !== 'endpoint' || p.file !== 'api.js') continue;
      const r = routeOf(routes, f.endpoint);
      chk('E12', r && inHandler(p.line, r),
        `${f.endpoint}: 表内写点 ${p.line} 必须属于该端点的 handler(不许挂在别人的行上)`);
    }
  }

  // ── E13 双向补集 B:三个 helper 文件里的每条 settings.update( 都被覆盖 ───────────────────
  for (const hf of HELPER_WRITE_FILES) {
    const measured = measureWriteLines(sources[hf]);
    const declared = [...new Set(faces.flatMap(pointsOf).filter((p) => p.kind === 'helper' && p.file === hf).map((p) => p.line))].sort((a, b) => a - b);
    chk('E13', JSON.stringify(measured) === JSON.stringify(declared),
      `${hf}: settings.update( 行 ${JSON.stringify(measured)} 必须与表内 helper 写点 ${JSON.stringify(declared)} 逐一相等(第 ${measured.length} 类真调用不许成孤儿)`);
  }

  // ── E14 helper 覆盖数:rules.js:81 === 7 个端点 ──────────────────────────────────────────
  const rulesOwners = new Set(faces.filter((f) => pointsOf(f).some((p) => p.file === 'rules.js' && p.line === 81)).map((f) => f.endpoint));
  const wantRulesOwners = ['/persona/hint-adopt', '/persona/rule', '/persona/habit', '/persona/habits/scan', '/persona/habits/reflect', '/feedback/apply', '/suggestions/apply'].sort();
  chk('E14', JSON.stringify([...rulesOwners].sort()) === JSON.stringify(wantRulesOwners),
    `rules.js:81 的登记端点数必须 = 调用它的 7 个端点(§1.3 行 4/5/6/7/8/12/13),实际 ${rulesOwners.size}:${JSON.stringify([...rulesOwners].sort())}`);
  const suggOwners = new Set(faces.filter((f) => pointsOf(f).some((p) => p.file === 'suggestions.js')).map((f) => f.endpoint));
  chk('E14', JSON.stringify([...suggOwners]) === JSON.stringify(['/suggestions/apply']),
    `suggestions.js:32 只许挂在 /suggestions/apply,实际 ${JSON.stringify([...suggOwners])}`);
  const modeOwners = new Set(faces.filter((f) => pointsOf(f).some((p) => p.file === 'mode.js')).map((f) => f.endpoint));
  chk('E14', JSON.stringify([...modeOwners]) === JSON.stringify(['/mode/toggle']),
    `mode.js:91 只许挂在 /mode/toggle,实际 ${JSON.stringify([...modeOwners])}`);

  // ── E15 清单自洽(surgery.js 文档级:数字 + 两张逐字串 + 14 行) ───────────────────────────
  const surg = sources['surgery.js'];
  chk('E15', String(surg[14] || '').includes('14 行 = 14 个受门端点'),
    `surgery.js:15 必须含"14 行 = 14 个受门端点"(14 是**行数**,不是调用点)`);
  chk('E15', String(surg[18] || '').includes('14 行 + 本节 1 行例外 = 实际 15 条'),
    `surgery.js:19 必须含"14 行 + 本节 1 行例外 = 实际 15 条"`);
  chk('E15', surg[50] === SURGERY_LIST_HEADER,
    `surgery.js:51 表头必须逐字 === 79 字符原串(实际 ${String(surg[50]).length} 字符)`);
  chk('E15', surg[64] === SURGERY_LIST_LAST_ROW,
    `surgery.js:65 必须逐字 === 90 字符历史行(实际 ${String(surg[64]).length} 字符;不切列、不查列下标)`);
  const listRows = [];
  for (let i = 51; i <= 64; i++) {
    const m = /^\/\/\s+(\d+)\s+(\S+)/.exec(String(surg[i] || ''));
    if (m) listRows.push(Number(m[1]));
  }
  chk('E15', JSON.stringify(listRows) === JSON.stringify([...Array(14)].map((_, i) => i + 1)),
    `surgery.js:52-65 必须是 14 行、序号 1..14,实际 ${JSON.stringify(listRows)}`);

  return checks;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 变异(每条都给"期望变红"的断言码;跑红 = 断言组不是恒真)
// ═══════════════════════════════════════════════════════════════════════════════════════════
const SUGGESTIONS_WRITE_LINE = 3676;   // /suggestions/apply 的 api.js 写点(ALIGN-v7 的 3454 在本树 = 3676)
const GENESIS_GATE_LINE = 3545;        // /persona/genesis 的门行(= ALIGN-v7 的 3323)
const GENESIS_END_AT = 3586;           // /persona/genesis 的 endAt(= ALIGN-v7 的 3364)

export const MUTATIONS = {
  // MUT-A1:把会话半边的 gateSurgery 加回(ALIGN-v2 §F = "api.js:2207 门加回")
  'MUT-A1': {
    desc: '把 /mode/toggle 会话半边的 gateSurgery 加回(等行替换,不移动行号)',
    expect: ['E10', 'E11'],
    apply(env) {
      const api = env.sources['api.js'];
      const idx = api.findIndex((ln, i) => i > 2200 && i < 2230 && /^\s*const cur = currentMode\(memory, settings, sessionId\);/.test(ln));
      if (idx < 0) throw new Error('MUT-A1:没找到会话半边的锚点行');
      api[idx] = "        if (!gateSurgery(req, res, sendJson, { unlock: body.unlock }, { settings, logFile: surgeryLog, endpoint: '/mode/toggle' })) return; // MUT-A1";
    },
  },
  // MUT-A2 已删除：M24b 起全局半边不再有 readIsLocal 判据；本机/远端都能切。保留此注记，避免旧变异复活。
  // 删一条枚举项
  'MUT-DROP': {
    desc: '从枚举表删掉 /import 一行(长度 21 → 20)',
    expect: ['E1', 'E2', 'E12'],
    apply(env) {
      env.faces = env.faces.filter((f) => f.endpoint !== '/import');
    },
  },
  // 新端点不登记:api.js 追加一个直写 settings 的 handler,枚举表里没有它
  'MUT-UNREG': {
    desc: 'api.js 追加一个新写面 handler(/brand/new)但不登记进枚举表',
    expect: ['E12'],
    apply(env) {
      const api = env.sources['api.js'];
      api.push(
        '    // ---- MUT-UNREG:新写面不登记(变异) ----',
        "    disposers.push(register('/brand/new', async (req, res) => {",
        '      const body = JSON.parse((await readBody(req)) || \'{}\');',
        '      const s2 = await settings.update({ brand: { on: body.on === true } });',
        '      sendJson(res, 200, { ok: true, brand: s2.brand });',
        '    }));',
      );
    },
  },
  // 反例:把 /suggestions/apply 的 api.js 写点挂回 /persona/genesis
  'MUT-3454': {
    desc: `把 api.js:${SUGGESTIONS_WRITE_LINE} 挂回 /persona/genesis(ALIGN-v7 的 3454/3364;本树 3676/3586)`,
    expect: ['E7', 'E12'],
    apply(env) {
      const g = env.faces.find((f) => f.endpoint === '/persona/genesis');
      if (!g) throw new Error('MUT-3454:枚举表里没有 /persona/genesis');
      g.writeAt = { file: 'api.js', line: SUGGESTIONS_WRITE_LINE, kind: 'endpoint' };
    },
  },
};

export { findRoot, SUGGESTIONS_WRITE_LINE, GENESIS_GATE_LINE, GENESIS_END_AT };

// ═══════════════════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════════════════
function printTable(faces) {
  console.log('\n— SETTINGS_WRITE_FACES(21 行 / 20 端点;行号 = 现树实测) —————————————————————');
  console.log('  #  endpoint                          gate      regAt..endAt    写点');
  faces.forEach((f, i) => {
    const pts = f.writeAt == null
      ? 'null(白名单)'
      : pointsOf(f).map((p) => (p.kind === 'helper'
        ? `${p.file}:${p.line} ← calledFrom ${p.calledFrom}`
        : `${p.file}:${p.line}`)).join(' + ');
    console.log(`  ${String(i + 1).padStart(2)}  ${(f.endpoint + (f.half ? `[${f.half}]` : '')).padEnd(32)} ${f.gate.padEnd(9)} ${String(f.regAt).padStart(4)}..${String(f.endAt).padEnd(6)}  ${pts}`);
  });
  console.log('');
}

function main() {
  const argv = process.argv.slice(2);
  const root = findRoot();
  const base = loadSources(root);
  const mutateId = (argv.find((a) => a.startsWith('--mutate=')) || '').slice('--mutate='.length);

  if (argv.includes('--table') && !mutateId) printTable(SETTINGS_WRITE_FACES);

  if (!mutateId) {
    console.log(`# M21-3 源级枚举断言 · 基线 · root=${root}`);
    const checks = runAssertions({ sources: base, faces: SETTINGS_WRITE_FACES });
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) if (!c.ok) console.log(`  [FAIL ${c.code}] ${c.msg}`);
    const codes = [...new Set(checks.map((c) => c.code))].sort();
    console.log(`  [PASS] ${checks.length - failed.length}/${checks.length} 条断言通过;断言组 ${codes.join(',')}`);
    console.log(`  [${failed.length ? 'RED' : 'GREEN'}] failures=${failed.length}`);
    process.exit(failed.length ? 1 : 0);
  }

  const mut = MUTATIONS[mutateId];
  if (!mut) { console.log(`未知变异:${mutateId}(可:${Object.keys(MUTATIONS).join(',')})`); process.exit(2); }
  const env = { sources: Object.fromEntries(Object.entries(base).map(([k, v]) => [k, [...v]])), faces: SETTINGS_WRITE_FACES.map((f) => ({ ...f })) };
  mut.apply(env);
  console.log(`# M21-3 变异 ${mutateId} · ${mut.desc} · root=${root}`);
  const baseline = runAssertions({ sources: base, faces: SETTINGS_WRITE_FACES });
  const mutated = runAssertions({ sources: env.sources, faces: env.faces });
  const failed = mutated.filter((c) => !c.ok);
  for (const c of failed) console.log(`  [RED ${c.code}] ${c.msg}`);
  const redCodes = [...new Set(failed.map((c) => c.code))];
  let ok = true;
  for (const code of mut.expect) {
    const baseGreen = baseline.filter((c) => c.code === code).every((c) => c.ok);
    const nowRed = redCodes.includes(code);
    console.log(`  [期望红] ${code}: 基线${baseGreen ? '绿' : '红'} → 变异后${nowRed ? '红' : '仍绿'}`);
    if (!nowRed) ok = false;
  }
  // 反例专用:旧判据(门行 < 写行)仍会假绿 —— 显式打出来
  if (mutateId === 'MUT-3454') {
    const oldGreen = GENESIS_GATE_LINE < SUGGESTIONS_WRITE_LINE;
    console.log(`  [旧判据对照] /persona/genesis 门行 ${GENESIS_GATE_LINE} < 写行 ${SUGGESTIONS_WRITE_LINE} ⇒ ${oldGreen ? 'True(**假绿**:旧"门行 < 写行"判据放它过)' : 'False'}`);
    console.log(`  [区间对照]   /persona/genesis endAt ${GENESIS_END_AT} < ${SUGGESTIONS_WRITE_LINE} ⇒ ${GENESIS_END_AT < SUGGESTIONS_WRITE_LINE ? 'True(**区间断言红**)' : 'False'}`);
  }
  console.log(`  [${ok ? 'OK' : 'SURVIVED'}] ${mutateId} failures=${failed.length} redCodes=${JSON.stringify(redCodes)}`);
  process.exit(ok ? 0 : 2);
}

main();
