// core 补丁的**多 cohort 候选锚点**(第 32 套):判据是纯函数,fixture 用本机 core 摘出来的真实行。
//
// 为什么需要这一套:第二个补丁目标(dsh-api-gateway 的 `/api/remote.mux` upgrade)的锚点
// **随 DSH 版本漂移** —— 0.1.5 是 `requestRejection(req)`,0.1.7 起 requestRejection() 不再公开,
// 改成 `admit(req)` 的返回值,连**钩子行文本也不同**(旧的要交 `rejection` 变量,新的得从 `admission` 里取)。
// 单锚点必然顾此失彼:只留新锚点 ⇒ 还在 0.1.5 的用户锚点失配 ⇒ 补丁打不上 ⇒ **日志静默不记**。
// 而"多候选"本身又引入两种新失败,必须在这里钉死:
//   · **歧义**:两个候选同时唯一命中(同一份代码里两种写法都在)⇒ 拒绝改动,不许猜;
//   · **全漂**:一个候选都不唯一命中 ⇒ drifted(脚本退出码 2),等人工更新锚点。
// 本套只做纯函数断言,不碰文件系统、不 import 补丁脚本(那个一 import 就会去改 node_modules)。
import { ok, eq, section, summary } from './harness.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const {
  PATCH_TARGETS, PATCH_MARKER, OBSERVE_GLOBAL, UPGRADE_GLOBAL,
  anchorCandidates, resolveAnchor, countAnchorHits,
  verifyPatched, isHookLine, stripHookLines,
} = await imp('lib/audit/patch-spec.js');

const T = (id) => PATCH_TARGETS.find((t) => t.id === id);
const CONN = T('client-connection-api');
const MUX = T('api-gateway-mux');

// ---------------- 真实片段(逐字节摘自带补丁的本机 core,hook 行已去掉) ----------------
// ① dsh-client-connection/lib/index.js:830-837(DSH 0.1.7-rc.2)= 第一个目标的落点
const REAL_CONN_017 = [
  '\t\t\tconst route = {',
  '\t\t\t\tkind: "prefix",',
  '\t\t\t\tpath: API_PATH,',
  '\t\t\t\thandler: async (req, res) => {',
  '\t\t\t\t\tconst admission = connection.admit(req);',
  '\t\t\t\t\tif ("rejection" in admission) {',
  '\t\t\t\t\t\tres.writeHead(admission.rejection);',
  '\t\t\t\t\t\treturn;',
  '\t\t\t\t\t}',
].join('\n') + '\n';
// ② dsh-api-gateway/lib/index.js:631-641(DSH 0.1.7-rc.2)= 第二个目标的 0.1.7 cohort
const REAL_MUX_017 = [
  '\t\t\t\t\tconst route = {',
  '\t\t\t\t\t\tpath: REMOTE_STREAM_MUX_PATH,',
  '\t\t\t\t\t\thandler: (req, socket, head) => {',
  '\t\t\t\t\t\t\tconst admission = webCtx.connection.admit(req);',
  '\t\t\t\t\t\t\tif ("rejection" in admission) {',
  '\t\t\t\t\t\t\t\trejectRemoteStreamUpgrade(socket, admission.rejection);',
  '\t\t\t\t\t\t\t\treturn;',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\tmux.handleUpgrade(req, socket, head, admission.peer);',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t};',
].join('\n') + '\n';
// ③ dsh-api-gateway/lib/index.js:459-471(升级前备份的 0.1.5 cohort)= 第二个目标的 0.1.5 cohort
const REAL_MUX_015 = [
  '\t\t\twebCtx.effect(() => {',
  '\t\t\t\tconst route = {',
  '\t\t\t\t\tpath: REMOTE_STREAM_MUX_PATH,',
  '\t\t\t\t\thandler: (req, socket, head) => {',
  '\t\t\t\t\t\tconst rejection = webCtx.connection.requestRejection(req);',
  '\t\t\t\t\t\tif (rejection !== void 0) {',
  '\t\t\t\t\t\t\trejectRemoteStreamUpgrade(socket, rejection);',
  '\t\t\t\t\t\t\treturn;',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t\tmux.handleUpgrade(req, socket, head);',
  '\t\t\t\t\t}',
  '\t\t\t\t};',
].join('\n') + '\n';
// ④ 两个 cohort 里**已经插好的**钩子行(逐字节摘自带补丁的 core):插入行必须与它们完全一致
const HOOK_CONN_017 = '\t\t\t\tglobalThis.__dshAccessLogObserve?.(req, res); // E4 access log (dsh-ling patch)';
const HOOK_MUX_017 = '\t\t\t\t\t\t\tglobalThis.__dshAccessLogUpgrade?.(req, "rejection" in admission ? admission.rejection : void 0); // E4 access log (dsh-ling patch)';
const HOOK_MUX_015 = '\t\t\t\t\t\tglobalThis.__dshAccessLogUpgrade?.(req, rejection); // E4 access log (dsh-ling patch)';

// ---------------- 1) 规格形态(新形态 + 旧形态兼容) ----------------
section('1) 规格形态');
{
  eq(PATCH_TARGETS.length, 2, '补丁目标两条');
  // 第一个目标保持旧形态(单锚点),新兼容层不得逼它改写法
  ok(!('anchors' in CONN), '第一个目标仍是旧形态(顶层 anchor/line)');
  ok(CONN.anchor instanceof RegExp && typeof CONN.line === 'function', '旧形态字段齐备');
  eq(anchorCandidates(CONN).length, 1, '旧形态归一成 1 个候选');
  eq(anchorCandidates(CONN)[0].cohort, 'legacy', '旧形态候选带 legacy 标签');
  eq(anchorCandidates(CONN)[0].indentDelta, 1, '旧形态候选沿用顶层 indentDelta');

  // 第二个目标:两个候选,各自带 anchor + line
  ok(Array.isArray(MUX.anchors) && MUX.anchors.length === 2, '第二个目标带 2 个候选锚点');
  eq(MUX.anchors.map((a) => a.cohort), ['0.1.7+', '0.1.5'], '候选按 cohort 标注');
  ok(MUX.anchors.every((a) => a.anchor instanceof RegExp && typeof a.line === 'function'), '每个候选自带 anchor + line');
  eq(anchorCandidates(MUX).length, 2, '新形态归一成 2 个候选');
  eq(anchorCandidates(MUX).map((c) => c.indentDelta), [0, 0], '两个 cohort 都是同级插入(锚点行原地)');
  // 老读法(插件侧状态检查 / tests/access-log.test.mjs 读顶层字段)必须还在,而且是派生的、不是第二份手写副本
  ok(MUX.anchor instanceof RegExp && typeof MUX.line === 'function', '顶层 anchor/line 仍可读(兼容老消费方)');
  ok(MUX.anchor === MUX.anchors[0].anchor, '顶层 anchor 是**同一个对象**(派生自第一个候选,不是第二份手写副本)');
  ok(MUX.line === MUX.anchors[0].line, '顶层 line 也是同一个对象');
}

// ---------------- 2) 两个 cohort 的真实片段各自唯一命中 ----------------
section('2) 两个 cohort 各自唯一命中');
{
  const r017 = resolveAnchor(MUX, REAL_MUX_017);
  eq(r017.state, 'hit', '0.1.7 片段:恰好一个候选唯一命中');
  eq(r017.cohort, '0.1.7+', '选中的是 0.1.7+ 候选');
  eq(r017.counts.map((c) => `${c.cohort}×${c.hits}`), ['0.1.7+×1', '0.1.5×0'], '逐候选命中数(0.1.7 片段)');

  const r015 = resolveAnchor(MUX, REAL_MUX_015);
  eq(r015.state, 'hit', '0.1.5 片段:恰好一个候选唯一命中');
  eq(r015.cohort, '0.1.5', '选中的是 0.1.5 候选');
  eq(r015.counts.map((c) => `${c.cohort}×${c.hits}`), ['0.1.7+×0', '0.1.5×1'], '逐候选命中数(0.1.5 片段)');

  // 反证:两个锚点互不串门(串了就是"新 cohort 被插了旧 cohort 的钩子行")
  eq(countAnchorHits(REAL_MUX_017, MUX.anchors[1].anchor), 0, '0.1.5 锚点不得命中 0.1.7 的文件');
  eq(countAnchorHits(REAL_MUX_015, MUX.anchors[0].anchor), 0, '0.1.7 锚点不得命中 0.1.5 的文件');

  // 换行符容错:锚点写的是 \r?\n,CRLF 的 core 也不该被误判成漂移
  const crlf = REAL_MUX_015.replace(/\n/g, '\r\n');
  eq(resolveAnchor(MUX, crlf).state, 'hit', 'CRLF 行尾同样唯一命中');
}

// ---------------- 3) 插入行与 live core 里那行逐字节一致 ----------------
section('3) 插入行文本(含缩进)');
{
  eq(MUX.anchors[0].line('\t'.repeat(7)), `${HOOK_MUX_017}\n`, '0.1.7 插入行 = live core 里那行(7 个 tab)');
  eq(MUX.anchors[1].line('\t'.repeat(6)), `${HOOK_MUX_015}\n`, '0.1.5 插入行 = 升级前备份里那行(6 个 tab)');
  eq(CONN.line('\t'.repeat(4)), `${HOOK_CONN_017}\n`, '第一个目标插入行 = live core 里那行(4 个 tab)');

  // 每个候选的钩子行都必须自带标记与可选链(老读法只检查了顶层 line,这里逐候选查)
  for (const [id, cand] of [['0.1.7+', MUX.anchors[0]], ['0.1.5', MUX.anchors[1]]]) {
    const line = cand.line('\t');
    ok(line.includes(PATCH_MARKER), `${id} 插入行含标记(回滚认得出)`);
    ok(line.startsWith('\tglobalThis.__dshAccessLog') && line.includes('?.('), `${id} 是 globalThis 上的可选调用(插件缺席即 no-op)`);
    ok(line.includes(UPGRADE_GLOBAL), `${id} 打的是 upgrade 钩子`);
  }

  // 变量必须对得上各自的 cohort —— 写错是**每个 upgrade 请求都炸**(`?.` 保不住未声明的标识符)
  ok(MUX.anchors[0].line('\t').includes('"rejection" in admission ? admission.rejection : void 0'), '0.1.7 钩子行从 admission 里取 rejection');
  ok(!MUX.anchors[1].line('\t').includes('admission'), '0.1.5 钩子行**不得**出现 admission(那个文件里没有这个名字)');
  ok(MUX.anchors[1].line('\t').includes(`${UPGRADE_GLOBAL}?.(req, rejection)`), '0.1.5 钩子行直接交 rejection');
  ok(!MUX.anchors[0].line('\t').includes('?.(req, rejection)'), '0.1.7 钩子行不得退化成裸 rejection');
}

// ---------------- 4) 歧义:两个候选同时唯一命中 ⇒ 拒绝改动 ----------------
section('4) 歧义被拒(不许猜)');
{
  const both = `${REAL_MUX_017}${REAL_MUX_015}`;
  const r = resolveAnchor(MUX, both);
  eq(r.state, 'ambiguous', '两个候选都唯一命中 ⇒ ambiguous');
  eq(r.counts.map((c) => c.hits), [1, 1], '两个候选各命中 1 次');
  eq(r.candidate, null, '歧义时不给候选(脚本据此拒绝改动)');
  eq(r.cohort, null, '歧义时不给 cohort');
}

// ---------------- 5) 漂移:一个候选都不唯一命中 ⇒ drifted ----------------
section('5) 漂移判定');
{
  // 5a) 完全陌生的写法(下一次 DSH 漂移的样子)
  const future = REAL_MUX_017.replace('const admission = webCtx.connection.admit(req);', 'const verdict = webCtx.connection.verify(req);');
  const r1 = resolveAnchor(MUX, future);
  eq(r1.state, 'drifted', '两个候选都不命中 ⇒ drifted');
  eq(r1.counts.map((c) => c.hits), [0, 0], '逐候选命中 0 次');
  eq(r1.candidate, null, '漂移时不给候选');

  // 5b) 锚点命中 2 次也不算可用(判据是"恰好一次",不是"至少一次")—— 命中多处插错地方更危险
  const dup = `${REAL_MUX_017}${REAL_MUX_017}`;
  const r2 = resolveAnchor(MUX, dup);
  eq(r2.state, 'drifted', '唯一候选命中 2 次 ⇒ drifted');
  eq(r2.counts.map((c) => c.hits), [2, 0], '命中数如实报出(2 次)');

  // 5c) 空文件/无关文件
  eq(resolveAnchor(MUX, 'const x = 1;\n').state, 'drifted', '无关文件 ⇒ drifted');
  eq(resolveAnchor(CONN, 'const x = 1;\n').state, 'drifted', '旧形态单锚点同样判漂移');
}

// ---------------- 6) 旧形态(第一个目标)与锚点特异性 ----------------
section('6) 旧形态与锚点特异性');
{
  const rc = resolveAnchor(CONN, REAL_CONN_017);
  eq(rc.state, 'hit', '第一个目标的真实片段唯一命中(旧形态未被本次改动影响)');
  eq(rc.cohort, 'legacy', '旧形态候选标签');

  // 插进去之后文件带标记 —— 这就是"已打过补丁 ⇒ 幂等短路"的依据
  const patched = REAL_CONN_017.replace(rc.candidate.anchor, (m) => `${m}${rc.candidate.line('\t'.repeat(4))}`);
  ok(patched.includes(PATCH_MARKER), '打过补丁的文件带标记(幂等短路的判据)');
  ok(patched.includes(`\t\t\t\thandler: async (req, res) => {\n${HOOK_CONN_017}\n`), '钩子行紧跟在锚点行下方,缩进进块内一级');

  // 第二个目标的锚点必须**认得出 receiver**:/api 入口里的 `connection.admit(req)` 不是它
  eq(resolveAnchor(MUX, REAL_CONN_017).state, 'drifted', 'webCtx.connection.admit 的锚点不误命中 connection.admit');

  // 真·两个 cohort 的补丁文本:插好之后也必须仍被判成 applied(短路不看锚点)
  const patched015 = REAL_MUX_015.replace(MUX.anchors[1].anchor, (m) => `${m}${MUX.anchors[1].line('\t'.repeat(6))}`);
  ok(patched015.includes(PATCH_MARKER), '0.1.5 补丁后带标记');
  ok(patched015.includes(`\t\t\t\t\t\tconst rejection = webCtx.connection.requestRejection(req);\n${HOOK_MUX_015}\n`), '0.1.5 钩子行插在锚点行正下方(同级缩进)');
}

// ---------------- 7) C-09:已打补丁的文件必须**复核锚点**,不许"看见标记就报 applied" ----------------
// 背景(审计 C-09 实测):旧判据是 `source.includes(PATCH_MARKER)` ⇒ 标记行还在、但插入点那几行
// 已经变了的文件照样报 applied 并退出 0 ⇒ 用户以为 E4 在记,实际一行都不会记。
// 这一节把三种"标记在、实体不对"的形态逐个钉死,并用真实插入逻辑生成的健康文本做正例。
section('7) C-09 已打补丁文件的复核(判据必须落在实体上)');
{
  /** 用**真实插入逻辑**生成已打补丁的文本(不手写钩子行,免得测出一个现实中不存在的形态)。 */
  const patchWith = (anchor, text, indent) => text.replace(anchor.anchor, (m) => `${m}${anchor.line(indent)}`);

  const connPatched = patchWith(anchorCandidates(CONN)[0], REAL_CONN_017, '\t'.repeat(4));
  const mux017Patched = patchWith(MUX.anchors[0], REAL_MUX_017, '\t'.repeat(7));
  const mux015Patched = patchWith(MUX.anchors[1], REAL_MUX_015, '\t'.repeat(6));

  // 7a) 正例:三种健康补丁文本都必须判 applied,并报出各自的 cohort
  const vc = verifyPatched(CONN, connPatched);
  eq(vc.state, 'applied', '健康补丁(CONN)判 applied');
  eq(vc.cohort, 'legacy', 'CONN 报 legacy cohort');
  eq(vc.hooks, 1, 'CONN 恰好一条钩子行');
  const v17 = verifyPatched(MUX, mux017Patched);
  eq(v17.state, 'applied', '健康补丁(MUX 0.1.7)判 applied');
  eq(v17.cohort, '0.1.7+', 'MUX 0.1.7 报 0.1.7+ cohort');
  eq(v17.counts.map((c) => `${c.cohort}×${c.hits}`), ['0.1.7+×1', '0.1.5×0'], 'MUX 0.1.7 复核时逐候选命中数');
  const v15 = verifyPatched(MUX, mux015Patched);
  eq(v15.state, 'applied', '健康补丁(MUX 0.1.5)判 applied');
  eq(v15.cohort, '0.1.5', 'MUX 0.1.5 报 0.1.5 cohort');

  // 7b) **C-09 核心回归**:锚点那行被改掉、钩子行还在 ⇒ 必须是 stale,绝不许 applied
  //     (旧判据在这一份文本上会返回 applied/退出 0 —— 下面第一条断言就是这个反证)
  const mangled = mux017Patched.replace('const admission = webCtx.connection.admit(req);', 'const verdict = webCtx.connection.verify(req);');
  ok(mangled.includes(PATCH_MARKER), '(反证)锚点坏掉的文件里标记行仍在 ⇒ 旧判据("标记行存在")会误报 applied');
  const vm = verifyPatched(MUX, mangled);
  eq(vm.state, 'stale', '锚点已失效 ⇒ stale(不再短路成 applied)');
  eq(vm.hooks, 1, 'stale 时仍如实报出"有 1 条钩子行"');
  eq(vm.counts.map((c) => c.hits), [0, 0], 'stale 时逐候选命中 0 次(证据留给人工核对)');
  // 同一种坏法在第一个目标(单锚点)上同样要判 stale
  eq(verifyPatched(CONN, connPatched.replace('handler: async (req, res) => {', 'handler: async (req, res) => { /*moved*/')).state, 'stale', 'CONN 锚点失效同样判 stale');

  // 7c) 钩子行文本是**另一个 cohort** 的 ⇒ cohort-mismatch(0.1.7 的文件里放 0.1.5 的行
  //     = 每个 upgrade 请求 ReferenceError;`?.` 保不住未声明的标识符)
  const wrongCohort = REAL_MUX_017.replace(MUX.anchors[0].anchor, (m) => `${m}${HOOK_MUX_015}\n`);
  const vw = verifyPatched(MUX, wrongCohort);
  eq(vw.state, 'cohort-mismatch', '钩子行来自另一个 cohort ⇒ cohort-mismatch');
  ok(vw.expected.includes('"rejection" in admission'), 'mismatch 时给出期望的钩子行(带 admission)');
  ok(vw.actual.includes('?.(req, rejection)'), 'mismatch 时给出实际的钩子行(裸 rejection)');

  // 7d) 重复打过补丁 ⇒ 每行日志记两遍,必须报 duplicated
  const twice = patchWith(MUX.anchors[0], mux017Patched, '\t'.repeat(7));
  eq(verifyPatched(MUX, twice).state, 'duplicated', '两条钩子行 ⇒ duplicated');

  // 7e) 没打过 ⇒ not-applied,并仍给出"能不能打"的参考(cohort/counts)
  const vn = verifyPatched(MUX, REAL_MUX_017);
  eq(vn.state, 'not-applied', '无钩子行 ⇒ not-applied');
  eq(vn.hooks, 0, '无钩子行时 hooks=0');
  eq(vn.cohort, '0.1.7+', 'not-applied 仍报出可用的候选 cohort');
  eq(verifyPatched(CONN, REAL_CONN_017).state, 'not-applied', 'CONN 未打 ⇒ not-applied');
}

// ---------------- 8) 判据单源:isHookLine / stripHookLines(回滚与复核共用同一个"什么算钩子行") ----------------
section('8) isHookLine / stripHookLines');
{
  ok(isHookLine(HOOK_CONN_017), '真钩子行(带缩进)认得出');
  ok(isHookLine(HOOK_MUX_017) && isHookLine(HOOK_MUX_015), '两个 cohort 的钩子行都认得出');
  ok(!isHookLine(`// ${PATCH_MARKER} 说明文字`), '只提到标记、不是钩子调用的注释**不算**钩子行');
  ok(!isHookLine(''), '空行不算钩子行');
  ok(!isHookLine('globalThis.__dshAccessLogObserve?.(req, res);'), '缺标记的调用不算钩子行');

  const before = REAL_CONN_017.split(/\r?\n/).length;
  const stripped = stripHookLines(`${REAL_CONN_017}${HOOK_CONN_017}\n`);
  eq(stripped.split(/\r?\n/).length, before, '删钩子行:行数减 1(其余逐行不动)');
  ok(!stripped.includes('globalThis.__dshAccessLog'), '删干净了');
  const keepComment = `${REAL_CONN_017}// ${PATCH_MARKER} 说明文字\n`;
  eq(stripHookLines(keepComment), keepComment, '只提标记的注释行**保留**(回滚不误伤)');
}

summary();
