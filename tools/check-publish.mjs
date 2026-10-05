// dsh-ling — 发布前检查:扫一遍仓库目录,揪出"绝不该公开"的东西。
//
// 为什么需要它:`.gitignore` 只在 git 操作时生效 —— 用网页界面拖拽上传、打包分发、
// 或把目录复制到别处发布时,它都不起作用。发布前跑一次本脚本,是最后一道闸。
//
// 用法: node tools/check-publish.mjs
// 退出码:0 = 干净可以发布;1 = 有必须处理的东西
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git']);

// 1) 目录/文件名:命中即"禁止上传"
const FORBIDDEN_DIR = [/^node_modules$/, /^\.dsh$/, /^data$/, /^cache$/, /^docs\/img\/private$/];
const FORBIDDEN_FILE = [
  [/\.db$/, '记忆库/历史数据库(SQLite)'],
  [/\.db-wal$/, 'SQLite WAL 临时文件'],
  [/\.db-shm$/, 'SQLite 共享内存文件'],
  [/^settings\.json$/, '插件设置(含人格档案/承诺句)'],
  [/\.bak($|-)/, '备份文件(可能含旧数据)'],
  // 2026-09-26 补(F2 同族缺口):上面那条只认 `.bak`,而 `x.redproof-bak` / `x-backup-20260911` /
  // `x.orig` / `x~` 这类**游离备份**同样会被 walk() 计入文件数与体积、并随发布公开出去。
  // 触发本条的实证:红证脚本留下的 `lib/client.js.redproof-bak`(313KB)曾被计入门禁统计,而且仍然判「✓ 干净」。
  [/[-._](bak|backup|orig|old|tmp|temp|swp|swo|save|redproof)([-._]|$)/i, '游离备份/临时文件(可能含旧数据或私人痕迹)'],
  [/~$/, '编辑器备份文件'],
  [/\.env(\.|$)/, '环境变量文件(可能含密钥)'],
  [/\.log$/, '日志'],
  [/\.zip$/, '压缩包(可能含数据)'],
];
// 2) 内容:命中即"疑似泄漏/隐私"
const CONTENT_PATTERNS = [
  [/[A-Z]:[\\/]Users[\\/][^\\/\s"')]+/i, '疑似绝对路径(含用户名)'],
  [/(?:\/Users\/|\/home\/)[a-zA-Z0-9._-]+/, '疑似绝对路径(含用户名)'],
  [/\bsk-[A-Za-z0-9]{16,}/, '疑似 API Key'],
  [/\bghp_[A-Za-z0-9]{20,}/, '疑似 GitHub Token'],
  [/\bAIza[0-9A-Za-z_\-]{20,}/, '疑似 Google API Key'],
];
// 2b) 真机绝对路径(**硬拦**,计入 problems ⇒ 退出码 1)。上面那两条只认 `<盘符>:\Users\…` 与
//     `/Users|/home/…`,**非 Users 的盘符路径**(盘符 + 真实目录名 + 真实文件名,例如作者本机的
//     项目/文档目录)每次都静默通过。2026-09-27 实测:一个同时含三条「盘符 + 三层目录 + 文件名」
//     的样本,旧判据只报出含用户名的那一行,另两条判「✓ 干净」。
//     为什么是硬拦而不是"请人工确认":盘符绝对路径不是"疑似",它就是作者本机目录结构本身;
//     而且判据已收窄到不会命中合法字面量(见下),误报为 0 才敢硬拦。
//     口径 = 盘符 + ≥3 层目录,每层以 [A-Za-z0-9_] 开头 ⇒ 2026-09-27 全树实测的 8 处合法字面量
//     全部放过(逐处:DESIGN.md:222(那条 `pnpm add file:<仓库路径>` 安装步骤,句内自带"文中盘符路径均为作者本机路径、按实际替换"的说明)· lib/host/api.js:1357(JS 转义样本 `'A:\n'`,不是路径)· lib/host/retitle.js:52,53(两个中文目录名样本:`<盘符>:\某工作目录\license` 与 `<盘符>:\某目录\某前缀`)·
//     tests/feedback.test.mjs:67(`cwd: '<盘符>:\\daily'`,只有一层,层数不足)· tools/apply-access-log-patch.mjs:16(`--dsh-root "<盘符>:\path\to\@deepseek-ai\dsh"` 那句占位路径)· tools/apply-access-log-patch.mjs:61(`<盘符>:\Program Files`,含空格且只有一层)· tools/check-peers.mjs:38(那行 `--dsh-root "<盘符>:\…"` 的占位路径))。
//     放过的原因:省略号/空格/`@` 开头的那一层不成立(占位写法)、层数不足(单层或中文目录名)、
//     以及 JS 字符串转义(形如 `A:\n`)根本不是路径。
//     ⚠ 本段注释自身也在扫描范围内:示例一律用 `<盘符>:\<目录>\…` 占位,别写成真的作者路径 ——
//     否则判据会命中它自己,或又把本机目录结构写进这个同样公开的文件。
//     前置 (?<![A-Za-z0-9]) 不可省:否则 `http://a/b/c` 会被当成 `p:` 开头的盘符路径。
const HARD_CONTENT_PATTERNS = [
  [/(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}(?:[A-Za-z0-9_][^\\/\s"']*[\\/]{1,2}){2,}[A-Za-z0-9_][^\\/\s"']*/, '真机绝对路径(盘符 + 3 层以上目录,疑似作者本机目录结构)'],
];
const MAX_BYTES = 5 * 1024 * 1024; // 单文件超过 5MB 值得人工确认

// 3) 对外文档:内部流程术语(**警告级**,不阻断发布)。2026-10-05 补(尝生拍板):
//    发布关此前只拦"别泄密 / 别黑屏"两类事,**没有任何一条管对外文案** —— 于是 1.6.1 的
//    CHANGELOG 里写满了「3×3 红蓝对抗审计 / 红队 3 路 + 蓝队 3 路 / 6 个独立审计员 / 总账」,
//    末尾还附了 6 份内部文档路径;对外读者零信息量。那一版是**人眼**看出来的,脚本没拦住。
//    口径:**只警告、不阻断** —— 「主人」「器灵」「子代理」这类词在设定语境里**是该出现的**
//    (README 的「设定全文(对外面)」整节就在讲这个),硬拦必然误报,人会被训练成无视它。
//    只在**对外文档**上判:仓库里的内部笔记/审计报告不受影响(它们本来就该写全套术语)。
const EXTERNAL_DOCS = /^(README|CHANGELOG|DESIGN|ACCESS-DESIGN)\.md$|^package\.json$/;
const JARGON_PATTERNS = [
  [/红蓝对抗|红队|蓝队/, '内部审计流程术语(对外读者无信息量 ⇒ 换成「发布前检查」或直接删)'],
  [/\d\s*[×xX]\s*\d\s*(?:路|的)?\s*(?:对抗|红蓝|审计)/, '内部审计流程术语(同上)'],
  [/独立审计员|审计员/, '内部角色称呼(同上)'],
  [/审计出处/, '内部文档索引(内网路径,对外无意义)'],
];

const problems = [];
const warnings = [];
let files = 0;
let bytes = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(REPO, full).replace(/\\/g, '/');
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (FORBIDDEN_DIR.some((re) => re.test(name))) {
        problems.push(`${rel}/ —— 不该上传的目录(${name})`);
        continue;
      }
      walk(full);
      continue;
    }
    files += 1;
    bytes += st.size;
    for (const [re, why] of FORBIDDEN_FILE) {
      if (re.test(name)) { problems.push(`${rel} —— ${why}`); break; }
    }
    if (st.size > MAX_BYTES) warnings.push(`${rel} —— ${(st.size / 1048576).toFixed(1)}MB,上传前确认是否必要`);
    if (st.size > 1024 * 1024) continue; // 内容扫描只做小文件
    if (!/\.(mjs|js|json|md|yml|yaml|txt|ts)$/i.test(name)) continue;
    let text = '';
    try { text = readFileSync(full, 'utf8'); } catch { continue; }
    for (const [re, why] of CONTENT_PATTERNS) {
      const m = text.match(re);
      if (m) warnings.push(`${rel} —— ${why}:${String(m[0]).slice(0, 40)}`);
    }
    for (const [re, why] of HARD_CONTENT_PATTERNS) {
      const m = text.match(re);
      if (m) problems.push(`${rel} —— ${why}:${String(m[0]).slice(0, 40)}`);
    }
    // 对外文案的术语检查(警告级,不阻断 —— 口径见上方 JARGON_PATTERNS 的注释)
    if (EXTERNAL_DOCS.test(name)) {
      for (const [re, why] of JARGON_PATTERNS) {
        const m = text.match(re);
        if (m) warnings.push(`${rel} —— 对外文案含${why}:「${String(m[0]).slice(0, 30)}」`);
      }
    }
  }
}

walk(REPO);

// ---- 客户端注册 id 必须逐字等于包名(2026-09-26 黑屏事故的根因;接在这里 = 发布前必过的一关)----
// 机制:客户端模块表以「包名」为 row id(dsh-client-modules/lib/index.js:884 graphRow(packageName,…)),
// 而 bundle 的注册 id 是脚本自报的;两者不符时客户端判"该 row 没到货",会回退去取单资源 URL
// 把同一份字节再执行一遍,第二次注册抛 `duplicate factory registration for "…"` ⇒
// `web boot: 1 entry did not activate` ⇒ 前端整片黑屏。本脚本由同步脚本在
// dry-run 里调用、失败即 die ⇒ 接进去零额外接线。注意:加载器只认 exports["./client"],
// 补 dsh.client 的入口字段是无效配置(loader 不读)。
const readFileSyncSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const notes = [];
{
  let pkgName = null;
  let entryRel = null;
  let wantsClient = false;
  try {
    const pkg = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'));
    pkgName = pkg.name;
    wantsClient = !!(pkg.dsh && pkg.dsh.client);
    const ce = pkg.exports && pkg.exports['./client'];
    if (typeof ce === 'string') entryRel = ce;
    else if (ce && typeof ce.default === 'string') entryRel = ce.default;
  } catch (e) {
    problems.push(`package.json 读不出 name / 客户端入口:${e.message}`);
  }
  if (!entryRel) {
    if (wantsClient) problems.push('声明了 dsh.client,但 exports["./client"] 缺失 —— 加载器只认这个导出,缺了会在加载期直接 throw(前端整片不激活)');
  } else if (pkgName) {
    const rel = String(entryRel).replace(/^\.\//, '');
    const src = readFileSyncSafe(`${REPO}/${rel}`);
    if (src === null) {
      problems.push(`客户端入口不存在:${rel}(loader 会判 missing bundle ⇒ 整片前端不激活)`);
    } else {
      // 不做"块注释屏蔽"启发式:本文件(及常见插件)注释里会出现字面的 `/*`(例如 `@scope/*`),
      // 非贪婪匹配会从那里一路吃到后面某处的 `*/`,把真正的注册行一起吞掉 ⇒ 假失败。
      // 改取**第一处**注册调用:注释里若抄了带引号字面量的样本会先命中,故注释样本请用 `…` 占位。
      const m = src.match(/__ModuleLoader__\s*\.\s*load\(\s*\{\s*id:\s*(['"])([^'"]+)\1/);
      if (!m) problems.push(`${rel} —— 找不到 window.__ModuleLoader__.load({ id: '<字面量>' })(动态 id 也会落到这里)`);
      else if (m[2] !== pkgName) problems.push(`${rel} 的注册 id "${m[2]}" ≠ package.json 的 name "${pkgName}" —— 客户端必回退重取并二次执行 ⇒ 前端整片黑屏`);
      else notes.push(`✓ 客户端注册 id 与包名逐字一致:${m[2]}`);
    }
  }
}

console.log('== dsh-ling 发布前检查 ==');
console.log('目录:', REPO);
console.log(`文件 ${files} 个 · 合计 ${(bytes / 1048576).toFixed(2)} MB\n`);
for (const n of notes) console.log(n);
if (notes.length) console.log('');

if (problems.length) {
  console.log('❌ 必须处理(不要上传这些):');
  for (const p of problems) console.log('   -', p);
  console.log('');
}
if (warnings.length) {
  console.log('⚠️  请人工确认(不一定是问题):');
  for (const w of warnings) console.log('   -', w);
  console.log('');
}
if (!problems.length && !warnings.length) console.log('✓ 干净:没有发现不该上传的文件或可疑内容。\n');

console.log('提示:`.gitignore` 只在 git 操作时生效,直接复制/拖拽上传不受它约束 —— 发布前跑一次本脚本。');
process.exit(problems.length ? 1 : 0);
