#!/usr/bin/env node
// dsh-ling — peer 闸门自检(只读):**宿主会不会因为 peerDependencies 范围不合规,把这个插件丢弃?**
//
// 为什么需要它(PITFALLS B50 / DESIGN §0.1 理念 7「静默失效优先防」):
//   宿主在装载 profile bundle 时会拿 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
//   条目跟**运行时版本**做 semver 校验;任何一条不合规 ⇒ 该 bundle 被丢进 `skippedBundles` —— **不激活、不起异常栈**;
//   **CLI 启动路径**会往 **stderr 打一行** `skipping profile bundle …`(**容易被忽略,但不完全静默**;应用自持 profile 那条路径一个字都不打,见下面 :911-912),表象常常只有"器灵突然不见了"。
//   本脚本把这件事变成**一条命令能查的事**,判据**照抄宿主语义**,不自己发明。
//
// 判据出处(宿主 checkout,2026-09-26 逐行核对):
//   <dsh>\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js
//     :15       `import semver, { parse } from "semver"` —— 宿主用的就是 npm `semver` 包
//     :257-260  runtimeVersionOf() —— 运行时版本必须是合法 semver,否则 throw
//     :271-275  getDshRuntimeVersion() —— 读的是 **dsh-app-boot 自己的 package.json** 的 version
//     :286-313  evaluatePluginCompatibility() —— 闸门本体
//       :289    没有 peerDependencies 字段 ⇒ `return void 0`(**不声明 = 完全没人拦**)
//       :293    范围不是字符串 ⇒ throw(宿主侧同样落进 :939 的 catch)
//       :294    只挑 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`(`@deepseek-ai/cordis` 之类**不参与这道判**)
//       :295-299 `workspace:^` / `workspace:~` / `workspace:*` 视为"跟随运行时版本",其余原样交给 semver
//       :300    `!semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })` ⇒ 记进不合规集合
//     :320-322  pluginCompatibilityWarning() —— 宿主那句诊断原文,本脚本照抄前缀
//     :911-912  装载侧注释逐字:"... are skipped without changing the manifest and listed in `skippedBundles`;
//               **nothing is printed**."(说的是这条装载路径;**应用自持 profile 路径一个字都不打**)
//     :515-517  reportSkippedBundles() —— 逐条往 **stderr 打一行** `skipping profile bundle …`(:511 注释:装载从不打印,
//               所以由启动器每次启动调一次);**CLI 启动路径**在 `lib\profile-boot-BZ2ZjNWi.js:188` 无条件调用它
//     :929-930  不合规且未豁免 ⇒ throw
//     :939-944  catch 后**只 push 进 `skippedBundles`**(layers 里没有这一层)
//
// semver 实现:**复用宿主自己那一份**(从宿主 checkout 里 require),不自己写近似版 ——
//   否则两边判据会各自漂移。锚点取 `dsh-app-boot/lib/index.js`,与宿主 :15 的解析起点一致。
//
// 用法:
//   node tools/check-peers.mjs                       # 自检(只读,不写任何文件)
//   node tools/check-peers.mjs --host-version 0.0.1  # 假装宿主是某个版本(不写盘;用来证明"红得出来")
//   node tools/check-peers.mjs --manifest <path>     # 换一份 package.json 来判(只读)
//   node tools/check-peers.mjs --gate-prefix "@deepseek-ai/nope-"   # 收窄判据集(**仅用于验证"抓空报警"可达**)
//   node tools/check-peers.mjs --self-test           # 内置回退变体:证明 PASS / FAIL / 抓空三条分支都可达
//   node tools/check-peers.mjs --dsh-root "D:\\path\\to\\@deepseek-ai\\dsh"
//
// 退出码:0  = 全合规(宿主闸门放行);
//         1  = **有不合规 ⇒ 宿主会把本插件丢进 `skippedBundles`,插件不会激活(线索分两条路径:**CLI 启动路径**会往 **stderr 打一行**,**应用自持 profile 那条路径一个字都不打** —— 见上面 :7 与 :911-912)**;
//         2  = **无法判定**(判据集抓空 / 宿主 semver 或宿主版本取不到 / 缺 package.json / 运行时版本非法)。
//   ⚠️ 2 **不是**通过:空集与"取不到判据"一律报警,不当通过(PITFALLS B50 · 理念 6/7)。
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const EXIT_OK = 0;
const EXIT_INCOMPATIBLE = 1;
const EXIT_UNJUDGEABLE = 2;

// 宿主 :294 的闸门名判据(默认值;`--gate-prefix` 只用于验证"抓空报警"可达,不是常规用法)
const GATE_EXACT = '@deepseek-ai/dsh';
const GATE_PREFIX = '@deepseek-ai/dsh-';
const WORKSPACE_RANGES = ['workspace:^', 'workspace:~', 'workspace:*'];

/** 找 DSH 包根:显式参数 → 环境变量 → 运行中的进程 argv → 全局 npm 目录(与 tools/apply-access-log-patch.mjs 同口径)。 */
function findDshRoot() {
  const candidates = [];
  const explicit = argOf('--dsh-root');
  if (explicit) candidates.push(explicit);
  if (process.env.DSH_PKG_ROOT) candidates.push(process.env.DSH_PKG_ROOT);
  for (const a of process.argv) {
    const m = String(a).match(/^(.*)[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]/);
    if (m) candidates.push(join(m[1], '@deepseek-ai', 'dsh'));
  }
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  return candidates.find((p) => p && existsSync(p));
}

/** 复用宿主那一份 semver:锚点 = dsh-app-boot 的入口文件(宿主 :15 就从这里解析)。 */
function loadHostSemver(dshRoot) {
  const anchor = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
  if (!existsSync(anchor)) return { error: `找不到宿主闸门所在文件:${anchor}` };
  try {
    const req = createRequire(anchor);
    const file = req.resolve('semver');
    const semver = req('semver');
    if (typeof semver.satisfies !== 'function') return { error: `${file} 里没有 satisfies():不是预期的 npm semver` };
    let version = '(未知)';
    try { version = req(join(dirname(file), 'package.json')).version; } catch { /* 版本读不到不影响判定 */ }
    return { semver, file, version };
  } catch (e) {
    return { error: `从 ${anchor} 解析 semver 失败:${e.message}` };
  }
}

/** 读一份 package.json 的 version。 */
function readVersion(file) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return typeof j.version === 'string' && j.version.trim() ? j.version : undefined;
}

/** 宿主版本:默认复刻 :271-275(读 dsh-app-boot 自己的 package.json);拿不到再退回 dsh 包本体。 */
function hostRuntimeVersion(dshRoot) {
  const boot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json');
  if (existsSync(boot)) {
    try { return { version: readVersion(boot), source: boot, viaAppBoot: true }; }
    catch (e) { return { error: `读不了 ${boot}:${e.message}` }; }
  }
  const own = join(dshRoot, 'package.json');
  if (existsSync(own)) {
    try { return { version: readVersion(own), source: own, viaAppBoot: false }; }
    catch (e) { return { error: `读不了 ${own}:${e.message}` }; }
  }
  return { error: `既没有 ${boot},也没有 ${own} —— 宿主版本取不到` };
}

/**
 * 照抄 :286-313 的判定语义(纯函数,不碰磁盘 —— `--self-test` 复用同一份实现)。
 * @returns {{verdict:'ok'|'incompatible'|'unjudgeable', why?:string, rows:Array, gated:number, bad:object}}
 */
function judge(manifest, runtimeVersion, semver, gate = {}) {
  const exact = gate.exact ?? GATE_EXACT;
  const prefix = gate.prefix ?? GATE_PREFIX;
  const isGated = (name) => name === exact || (prefix !== '' && name.startsWith(prefix));

  const empty = { rows: [], gated: 0, bad: {} };
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { verdict: 'incompatible', why: 'manifest 不是对象(宿主 :288 直接 throw ⇒ 同样丢)', ...empty };
  }
  // :289 —— 没有这个字段,宿主 `return void 0`:这道闸门根本不会拦。
  if (!Object.hasOwn(manifest, 'peerDependencies')) {
    return { verdict: 'unjudgeable', why: 'no-field', ...empty };
  }
  const deps = manifest.peerDependencies;
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
    return { verdict: 'incompatible', why: 'peerDependencies 不是对象(宿主 :290 throw ⇒ 同样丢)', ...empty };
  }

  const rows = [];
  const bad = {};
  let gated = 0;
  let fatal;
  for (const [name, range] of Object.entries(deps)) {
    const g = isGated(name);
    if (g) gated++;
    // :293 —— 范围不是字符串 ⇒ throw。**与名字无关**(这一步在 :294 的 continue 之前)⇒ 整包被丢。
    if (typeof range !== 'string') {
      fatal ??= `peerDependencies[${JSON.stringify(name)}] 不是字符串(宿主 :293 throw ⇒ 整包被丢)`;
      rows.push({ name, range: String(range), gated: g, ok: false, reason: '范围不是字符串' });
      continue;
    }
    // :295-299
    const requirement = WORKSPACE_RANGES.includes(range) ? runtimeVersion : range;
    let ok = true;
    let reason = '';
    if (requirement.trim() === '') {
      ok = false;
      reason = '范围为空';
    } else {
      try {
        ok = semver.satisfies(runtimeVersion, requirement, { includePrerelease: true }); // :300
        if (!ok) reason = 'satisfies === false';
      } catch (e) {
        // 非法区间:本机 semver 7.8.5 下 `satisfies()` 内部 catch 后**返回 false**,**不抛** ⇒ 与 satisfies === false 同一路
        // (照旧被判不合规、照旧被丢弃);下面这个 catch 是防御分支,当前版本走不到。范围非法**不是**通过。
        ok = false;
        reason = `范围非法(${e.message})`;
      }
    }
    rows.push({ name, range, gated: g, ok, reason });
    if (g && !ok) bad[name] = range;
  }

  if (fatal) return { verdict: 'incompatible', why: fatal, rows, gated, bad };
  if (Object.keys(bad).length) return { verdict: 'incompatible', why: 'peer-mismatch', rows, gated, bad };
  if (gated === 0) return { verdict: 'unjudgeable', why: 'empty-criteria', rows, gated, bad };
  return { verdict: 'ok', rows, gated, bad };
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function printTable(rows, runtimeVersion) {
  const head = [pad('包名', 46), pad('声明范围', 20), pad('宿主版本', 13), '结论'];
  console.log('  ' + head.join(''));
  console.log('  ' + '-'.repeat(46 + 20 + 13 + 28));
  for (const r of rows) {
    // ⚠ 不参与闸门的条目**故意不给 satisfies 结论**:宿主拿 dsh 的运行时版本去比它本来就是错的语义
    //(实例:`@deepseek-ai/cordis >=4.0.4` 对 `0.1.7-rc.2` 恒为 false,那是两个独立版本线)。
    // 只有"范围本身非法"才值得报 —— 那是真会咬人的写法。
    const verdict = !r.gated
      ? (/^范围非法/.test(r.reason) ? `⚠  不参与闸门,但范围非法(${r.reason})` : '·  不参与闸门(宿主 :294 跳过)')
      : r.ok
        ? '✓  合规'
        : `✗  不合规 → 宿主会丢弃(${r.reason})`;
    console.log('  ' + [pad(r.name, 46), pad(r.range, 20), pad(runtimeVersion, 13), verdict].join(''));
  }
}

/** 内置回退变体:证明 PASS / FAIL / 抓空三条分支都"红得出来"(理念 6)。 */
function selfTest() {
  const probes = [
    ['合规:开区间覆盖当前宿主', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.7-rc.2' } }, '0.1.7-rc.2', 'ok'],
    ['不合规:开区间高于宿主', { peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.7-rc.2' } }, '0.1.6', 'incompatible'],
    ['不合规:闭区间(B50 实证 ~0.1.7-rc.2 对 0.2.0 为 false)', { peerDependencies: { '@deepseek-ai/dsh-tools': '~0.1.7-rc.2' } }, '0.2.0', 'incompatible'],
    ['合规:workspace:* 视为跟随运行时', { peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:*' } }, '0.1.7-rc.2', 'ok'],
    ['不合规:范围非法(satisfies 判 false,同样丢弃)', { peerDependencies: { '@deepseek-ai/dsh-tools': 'not a range' } }, '0.1.7-rc.2', 'incompatible'],
    ['不合规:范围不是字符串(:293 throw)', { peerDependencies: { '@deepseek-ai/dsh-tools': 7 } }, '0.1.7-rc.2', 'incompatible'],
    ['抓空:只有 cordis(闸门 :294 看不见它)', { peerDependencies: { '@deepseek-ai/cordis': '>=4.0.4' } }, '0.1.7-rc.2', 'unjudgeable'],
    ['抓空:没有 peerDependencies 字段(:289 return void 0)', {}, '0.1.7-rc.2', 'unjudgeable'],
  ];
  const semver = loadHostSemver(findDshRoot() || '');
  if (semver.error) { console.log('✗ self-test 需要宿主 semver:', semver.error); return EXIT_UNJUDGEABLE; }
  console.log('== check-peers --self-test(回退变体 ⇒ 每条判据都得红得出来)==');
  let fail = 0;
  for (const [title, manifest, host, want] of probes) {
    let got;
    try { got = judge(manifest, host, semver.semver).verdict; } catch (e) { got = 'throw:' + e.message; }
    const hit = got === want;
    if (!hit) fail++;
    console.log(`  ${hit ? '✓' : '✗'} ${pad(title, 52)} 期望 ${pad(want, 14)} 实得 ${got}`);
  }
  console.log(fail ? `\n✗ self-test 有 ${fail} 条与期望不符 —— 判据失效,别信本脚本的绿灯。` : `\n✓ self-test ${probes.length}/${probes.length} 通过(三态分支均可达)。`);
  return fail ? EXIT_UNJUDGEABLE : EXIT_OK;
}

function main() {
  if (has('--help') || has('-h')) {
    console.log('用法: node tools/check-peers.mjs [--host-version x.y.z] [--manifest <pkg.json>] [--dsh-root <dir>] [--self-test]');
    console.log('退出码: 0=全合规  1=有不合规(宿主会把本插件丢进 skippedBundles,不激活)  2=无法判定(含判据集抓空)');
    return EXIT_OK;
  }
  if (has('--self-test')) return selfTest();

  const dshRoot = findDshRoot();
  if (!dshRoot) {
    console.log('✗ 找不到 DSH 包根 —— 无法取到宿主判据。可用 --dsh-root 指定,或设 DSH_PKG_ROOT。');
    return EXIT_UNJUDGEABLE;
  }
  const manifestPath = argOf('--manifest') ?? join(REPO, 'package.json');
  if (!existsSync(manifestPath)) {
    console.log(`✗ 读不到 ${manifestPath}`);
    return EXIT_UNJUDGEABLE;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const semver = loadHostSemver(dshRoot);
  if (semver.error) { console.log('✗', semver.error, '⇒ 判据取不到,不能视为通过。'); return EXIT_UNJUDGEABLE; }

  const override = argOf('--host-version');
  const host = override !== undefined ? { version: override, source: '(命令行 --host-version)', viaAppBoot: null } : hostRuntimeVersion(dshRoot);
  if (host.error) { console.log('✗', host.error, '⇒ 判据取不到,不能视为通过。'); return EXIT_UNJUDGEABLE; }
  if (typeof host.version !== 'string' || semver.semver.valid(host.version) === null) {
    console.log(`✗ 宿主版本 ${JSON.stringify(host.version)} 不是合法 semver(宿主 :258 同判)⇒ 无法判定。`);
    return EXIT_UNJUDGEABLE;
  }

  const prefix = argOf('--gate-prefix') ?? GATE_PREFIX;
  const nonDefaultGate = prefix !== GATE_PREFIX;

  console.log('== dsh-ling peer 闸门自检(只读)==');
  console.log('  被判文件   :', manifestPath);
  console.log('  包名 / 版本:', `${manifest.name ?? '(无 name)'}@${manifest.version ?? '(无 version)'}`);
  console.log('  宿主包根   :', dshRoot);
  console.log('  宿主版本   :', host.version, `(${host.source}${host.viaAppBoot === false ? ' · ⚠ 退回 dsh 包本体,dsh-app-boot 不在预期位置' : ''})`);
  console.log('  宿主 semver:', `${semver.version}  ${semver.file}(本脚本复用的就是这一份)`);
  console.log('  闸门判据   :', `:289/294/295-300 —— 命中 ${GATE_EXACT} 或 ${prefix}* 的条目才参与`);
  if (nonDefaultGate) console.log(`  ⚠️ 非默认判据集:--gate-prefix ${prefix}(**只用于验证"抓空报警"可达**,不是宿主真实判据)`);
  console.log('');

  let res;
  try { res = judge(manifest, host.version, semver.semver, { prefix }); }
  catch (e) { console.log('✗ 判定过程抛错:', e.message); return EXIT_UNJUDGEABLE; }

  if (res.verdict === 'unjudgeable' && res.why === 'no-field') {
    console.log('✗ package.json 里**没有 peerDependencies 字段** —— 宿主 :289 直接 `return void 0`,这道闸门不会拦你。');
    console.log('  "不声明 = 完全没人拦"(PITFALLS B50):插件装得上、跑得动,但"我在哪个宿主版本上能工作"没有任何机器判据。');
    console.log('  ⇒ 本脚本**无判据可判**。空集不许当"通过"(理念 6/7)⇒ 退出码 2。');
    return EXIT_UNJUDGEABLE;
  }

  printTable(res.rows, host.version);
  console.log('');

  if (res.verdict === 'incompatible') {
    if (res.why !== 'peer-mismatch') console.log(`✗ ${res.why}`);
    const key = `${manifest.name}@${manifest.version}`;
    console.log(`✗ 宿主会把本插件丢进 \`skippedBundles\`,插件不会激活(线索分两条路径:见下两行)。`);
    console.log(`  宿主诊断原文(dsh-app-boot\\lib\\index.js:322 前缀):Plugin ${key} is incompatible with dsh ${host.version}: peerDependencies ${JSON.stringify(res.bad)}.`);
    console.log('  装载侧 :911-912 注释逐字:"...listed in `skippedBundles`; nothing is printed." —— 说的是装载路径;**应用自持 profile 路径一个字都不打**;');
    console.log('  而 **CLI 启动路径**(lib\\profile-boot-BZ2ZjNWi.js:188 无条件调用)会往 stderr 打一行 `skipping profile bundle …` —— 容易被忽略,但不完全静默。');
    console.log('  修法:范围一律开区间 `>=X.Y.Z`(不要 `^` / `~` / 钉死);`peerDependenciesMeta.optional` **不豁免**这道闸门。');
    return EXIT_INCOMPATIBLE;
  }
  if (res.verdict === 'unjudgeable') {
    console.log(`✗ 判据集为空:peerDependencies 里 **一条都没命中**闸门名(${GATE_EXACT} 或 ${prefix}*)⇒ 这道闸门**这次什么也没判**。`);
    console.log('  宿主 :294 会把未命中者全部 `continue` 跳过;:302 的 `peers` 为空 ⇒ `return void 0` ⇒ 装载不被拦。');
    console.log('  ⚠️ "宿主没拦" ≠ "声明合规"。空集不许当"通过"(PITFALLS B50 · 理念 6/7)⇒ 退出码 2。');
    return EXIT_UNJUDGEABLE;
  }

  console.log(`✓ 总检:${res.gated}/${res.gated} 条闸门 peer 全部合规(宿主版本 ${host.version})⇒ 宿主闸门放行,本插件不会被丢进 skippedBundles。`);
  console.log('  ⚠️ 本脚本只复刻 `dsh-app-boot` 的**判据**;它不覆盖"闸门在别处也拦"(发布/安装期)与"插件装载后是否真的激活"(见 PITFALLS B46)。');
  return EXIT_OK;
}

process.exit(main());
