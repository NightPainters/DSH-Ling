// m19 · 测试链包含性护栏(S7)── 本文件**只读**,不写盘、不 spawn、不起服务。
//
// 为什么需要它(审计 §7.2 / S7):`package.json` 的 `scripts.test` 是一张**手写清单**。
//   删掉一段(`candidate` 67 段 → seeded 66 段)是**零成本**的:没有任何判据会红,
//   而 `CHANGELOG.md` 里那句"测试链 66 段"还会让这个数字看起来"自洽"。
//   ⇒ 必须有东西**从磁盘反查清单**,而不是数一个手写数字。
//
// 五条判据:
//   ① 链上每一段 `tests/*.mjs` 在磁盘上**都存在**(拼错 / 改名 / 漏文件 ⇒ 红);
//   ② 磁盘上每个 `tests/*.test.mjs` **都在链上**,唯一的例外是 `EXCLUDED` 里**显式列出并给出理由**的
//      —— "故意排除"与"漏登记"因此可区分(静默漏 ⇒ 红);
//   ③ `tests/unit.mjs` 在链上(它不是 `*.test.mjs`,不会被 ①② 覆盖);
//   ④ 关键套件 + **本文件自己**在链上(护栏自己被摘掉也红);
//   ⑤ **大小**:链段数与磁盘 `tests/*.test.mjs` 数各钉一个**常量**(m19-fix / MF-2)—— ①② 只判集合一致性,
//      挡不住"把某个非关键套件文件**连同它的链段一起**删掉"(集合仍一致 ⇒ 全绿)。⑤ 让那次删除必红。
//
// ⚠️ 纪律:本文件**不改** `package.json`,只断言。要加/删链上的一段,改 `package.json` 再跑它。
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (cond, msg) => {
  if (cond) return;
  failures += 1;
  console.error('  ✗ ' + msg);
};
const J = (v) => JSON.stringify(v);
const sorted = (arr) => arr.slice().sort();

// ── 显式排除白名单(**必须**列文件名 + 理由;不许"静默漏")─────────────────────────────
//   只登记**有据可依**的排除:文件自己的头部自述说它不进链。
//   ⚠️ 这份白名单是"故意排除"与"漏登记"之间唯一的区分点:条目必须①文件存在②不在链上③理由非空,
//   任何一条不成立就红(白名单不许腐烂成静默漏登记的遮盖布)。
const EXCLUDED = new Map([
  ['tests/time-t2.0.test.mjs',
    '该文件头部自述显式排除(tests/time-t2.0.test.mjs:17:「本文件**不进** `package.json` 的 test 链'
    + '(M1 保持 60 段)」),不是漏登记。m19 实测它单独跑 `node tests/time-t2.0.test.mjs` = exit 0'
    + '(2026-11-13,本机),所以这是一个**可随时提升进链**的手工套件:'
    + '要提升只需把它加进 scripts.test **并**改掉它第 17 行那句自述(后者不在 m19 的改写范围内,'
    + '否则文档与代码互相打架)。在那之前它按"手工套件"保留:node tests/time-t2.0.test.mjs'],
]);

console.log('▶ S7:package.json 的 test 链 ⇄ tests/ 磁盘文件 的包含性');

// ── 链本身:切段 + 形状 ───────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const chainRaw = String(pkg?.scripts?.test || '');
check(chainRaw.length > 0, 'package.json 里有 scripts.test');
const segs = chainRaw.split('&&').map((s) => s.trim()).filter(Boolean);
check(segs.length > 0, 'scripts.test 至少有一段的(实测 ' + J(segs.length) + ')');
const SEG_RE = /^node\s+tests\/[A-Za-z0-9_.-]+\.mjs$/;
const badSegs = segs.filter((s) => !SEG_RE.test(s));
check(badSegs.length === 0,
  '★链上每一段都是 `node tests/<file>.mjs` 形状(异常段:' + J(badSegs) + ')');
const chainFiles = segs.map((s) => s.replace(/^node\s+/, ''));
const chainSet = new Set(chainFiles);
check(chainSet.size === chainFiles.length,
  '★链上没有重复登记(实测 ' + J(chainFiles.length) + ' 段 / ' + J(chainSet.size) + ' 个不同文件)');

// ── ① 链上每一段都在磁盘上 ───────────────────────────────────────────────────────────
const missing = chainFiles.filter((f) => !existsSync(join(root, f)));
check(missing.length === 0, '★① 链上每一段都在磁盘上(缺失:' + J(missing) + ')');

// ── ② 磁盘上每个 *.test.mjs 都在链上(白名单除外)────────────────────────────────────
const diskNames = readdirSync(join(root, 'tests'));
const diskTests = sorted(diskNames.filter((n) => n.endsWith('.test.mjs')).map((n) => 'tests/' + n));
const chainTests = chainFiles.filter((f) => f.endsWith('.test.mjs'));
const missingOnChain = diskTests.filter((f) => !chainSet.has(f) && !EXCLUDED.has(f));
check(missingOnChain.length === 0,
  '★★② 磁盘上每个 tests/*.test.mjs 都在 test 链上(漏登记:' + J(missingOnChain)
    + ';若确为"故意排除",请写进本文件 EXCLUDED 并给理由)');
// 反方向:链上登记的 `*.test.mjs` 必须都在磁盘的 *.test.mjs 集合里(拼错名字 ⇒ 红)
const diskSet = new Set(diskTests);
const phantom = chainTests.filter((f) => !diskSet.has(f));
check(phantom.length === 0, '★②\' 链上登记的每个 *.test.mjs 都真的在 tests/ 里(幽灵:' + J(phantom) + ')');

// ── ③ tests/unit.mjs 在链上(它不叫 *.test.mjs,①② 都看不见它)─────────────────────────
check(chainSet.has('tests/unit.mjs'), '★★③ tests/unit.mjs 在 test 链上');
check(existsSync(join(root, 'tests/unit.mjs')), '③ tests/unit.mjs 在磁盘上');

// ── 白名单自身不许腐烂:文件存在 / 不在链上 / 理由非空 / **理由属实**(头部自述)──────────────
for (const [file, reason] of EXCLUDED) {
  check(existsSync(join(root, file)), '白名单里的 ' + file + ' 在磁盘上(否则这条白名单该删了)');
  check(!chainSet.has(file),
    '白名单里的 ' + file + ' **不在**链上(它若已登记进链,白名单就是陈旧的,该删)');
  check(String(reason).trim().length >= 10, '白名单里的 ' + file + ' 写清了排除理由(实测 ' + J(reason) + ')');
  // ★"理由属实"机械校验(m19-fix / MF-2):光写 10 个字就能排除**任意**新文件 —— 那是静默漏登记的遮羞布。
  //   被排除的文件**自己**必须在头部(前 40 行)说明"不进链",否则红。
  const head = String(readFileSync(join(root, file), 'utf8')).split(/\r?\n/).slice(0, 40).join('\n');
  check(/不进|不加入|不登记/.test(head),
    '★★白名单里的 ' + file + ' 自己在前 40 行里说了"不进"链(理由必须属实;'
      + '把任意文件塞进 EXCLUDED 不能替代"文件自述"——实测头部没找到该字样)');
}

// ── ④ 关键套件 + 本文件自己在链上 ───────────────────────────────────────────────────
const KEY_SUITES = [
  'tests/veto.test.mjs',        // 否决权(M5/M7 + rc.3 的 F4 §14.8/14.9 + §14.1/14.2 加固)
  'tests/tree4.test.mjs',       // 树第 4 层
  'tests/branch.test.mjs',      // 手术门分支(含 F9 反例)
  'tests/guard.test.mjs',       // 守卫 / patch 收窄
  'tests/package-chain.test.mjs',   // ← 本文件自己:护栏被摘掉也要红
];
for (const f of KEY_SUITES) {
  check(chainSet.has(f), '★★④ 关键套件在链上:' + f);
}
check(chainSet.has('tests/package-chain.test.mjs'),
  '★★④ 本护栏自己被摘出链就红(自我登记)');

// ── ⑤ 大小判据(m19-fix / MF-2)──────────────────────────────────────────────────────
//   ①④ 判"存在/包含"、② 判"集合一致性" —— 它们一起仍留一个静默口:**把一个非关键套件文件
//   连同 `package.json` 里同名的那段一起删掉**,集合仍一致 ⇒ 全绿。所以这里把**大小**钉成常量。
//   ⚠️ 这两个数字**故意手写**:加/删链段(或加/删 `tests/*.test.mjs`)必须同步改它 ——
//   改这个常量就是一次**需要 review 的动作**,不许顺手改绿。
const EXPECTED_SEGS = 70;          // unit.mjs(1) + tests/*.test.mjs(69;含 rc.4/M22-8 新增的 effort-ui)
const EXPECTED_DISK_TESTS = 70;    // 磁盘上的 tests/*.test.mjs(含 EXCLUDED 里那 1 个 + M22-8 新增 1 个)
check(segs.length === EXPECTED_SEGS,
  '★★⑤ 链上段数 = ' + EXPECTED_SEGS + '(实测 ' + J(segs.length) + ';删/加一段必须同步改 EXPECTED_SEGS ——'
    + '删段不删文件由 ①② 抓,删文件又删段只由这条抓)');
check(diskTests.length === EXPECTED_DISK_TESTS,
  '★★⑤ 磁盘 tests/*.test.mjs 数 = ' + EXPECTED_DISK_TESTS + '(实测 ' + J(diskTests.length)
    + ';删文件必须同步改 EXPECTED_DISK_TESTS)');

// ── 概览(数字**算出来的**,不是手写的;CHANGELOG 的"段数"口径同此:按 `&&` 切开的段数)──
const testCount = chainFiles.length - 1;      // 减去 tests/unit.mjs
console.log('  链上 ' + segs.length + ' 段 = tests/unit.mjs(1)+ tests/*.test.mjs(' + testCount + ')'
  + ';磁盘 tests/*.test.mjs = ' + diskTests.length
  + ';显式排除 = ' + EXCLUDED.size + '(' + Array.from(EXCLUDED.keys()).join(',') + ')');

console.log('');
if (failures) {
  console.error(failures + ' 项失败');
  process.exitCode = 1;
} else {
  console.log('S7 测试链包含性:链 ⇄ 磁盘一致 + 关键套件在位 + 白名单有理由 ✓');
}
