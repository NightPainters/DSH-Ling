#!/usr/bin/env node
// E4 访问日志 · 核心补丁脚本（幂等 / 可回滚 / 可自检）
//
// 背景：`/api` 的 403/401 栅栏在 core 里（dsh-client-connection），插件层看不到 ——
// 而"谁在什么时候被拦下"恰恰是悬案最缺的那条证据（任务书 §3.4 首选落点）。
// 解决办法不是把逻辑搬进 core，而是让 core 多一行**可选调用**：
//
//     globalThis.__dshAccessLogObserve?.(req, res); // E4 access log (dsh-ling patch)
//
// 实现全在 dsh-ling（lib/audit/），升级 DSH 后重跑本脚本一次即可。
//
// 用法：
//   node tools/apply-access-log-patch.mjs            # 应用（已是 applied 则跳过）
//   node tools/apply-access-log-patch.mjs --check    # **只读**自检（不写状态文件）；未打/锚点漂移/复核不过时退出码 2
//   node tools/apply-access-log-patch.mjs --revert   # 回滚（删掉插进去的那几行）
//   node tools/apply-access-log-patch.mjs --dsh-root "D:\\path\\to\\@deepseek-ai\\dsh"
//
// 退出码：0 = 就绪（applied / 已回滚）；2 = **未打或锚点漂移**；1 = 其它问题（歧义、目标文件缺失、异常）。
//
// 纪律：锚点必须**唯一命中**才动手 —— 宁可不动，也不能在 core 里插错地方（内部踩坑记录 B3）。
// 目标可以带**多个候选锚点**（同一处 core 代码在不同 DSH cohort 里写法不同，如 dsh-api-gateway 的
// `/api/remote.mux` upgrade）：逐个试，**恰好一个**候选唯一命中才可用；
//   · 多个候选同时唯一命中 ⇒ **歧义**（同一份代码里两种 cohort 的写法都在）⇒ 拒绝改动并报错，不许猜；
//   · 全都不命中 ⇒ **漂移**（drifted）⇒ 一个字也不改，退出码 2，等人工更新锚点。
// 判据是 lib/audit/patch-spec.js 的纯函数 `resolveAnchor()`（脚本与单测共用，免得两处判据各自漂移）。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  PATCH_TARGETS, PATCH_MARKER, PATCH_STATE_FILE, targetPath, resolveAnchor, verifyPatched, stripHookLines,
} from '../lib/audit/patch-spec.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const MODE = has('--check') ? 'check' : has('--revert') ? 'revert' : 'apply';
const ORIG_SUFFIX = '.e4-access-log.orig';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 找 DSH 包根：显式参数 → 环境变量 → 运行中的进程 argv → 全局 npm 目录。 */
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
  candidates.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh'));
  for (const c of candidates) {
    try {
      if (c && existsSync(join(c, 'package.json'))) return c;
    } catch {}
  }
  throw new Error(`找不到 DSH 包根；请用 --dsh-root 指定（找过：${candidates.join(' | ')}）`);
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** 逐候选的命中数摘要（人工核对时一眼看出"哪个 cohort 命中几次"）。 */
const hitsDetail = (counts) => (counts || []).map((c) => `${c.cohort}×${c.hits}`).join(' · ');

/**
 * 删标记行（回滚）的判据在 `lib/audit/patch-spec.js` 的 `stripHookLines()` 里 ——
 * 与 `--check` 的复核（`isHookLine`）**共用同一个判据**，免得"什么算钩子行"两处各自漂移。
 */

/** DSH 版本（F6②/E10：状态文件里记下**打补丁那一刻**的版本，升级后才有的比）。 */
function dshVersionOf(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 读上一次的状态记录（只用于"版本变了"这类旁证提示，不影响判据）。 */
function readStateFile() {
  try {
    return JSON.parse(readFileSync(join(dshHome(), 'logs', PATCH_STATE_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

function processTarget(root, target) {
  const file = targetPath(root, target);
  if (!existsSync(file)) {
    return { id: target.id, file, state: 'missing-file', note: '目标文件不存在（DSH 布局变了？）' };
  }
  const original = readFileSync(file, 'utf8');
  const backup = `${file}${ORIG_SUFFIX}`;

  // ---- C-09：判据改看**实体**（2026-09-26）--------------------------------------------
  // 旧写法是 `original.includes(PATCH_MARKER)`（"文件里出现过标记"）⇒ **绿色短路**：标记行还在、
  // 但插入点那几行已被改掉的文件照样报 applied / 退出 0。现在一律走 verifyPatched() 的三合一复核：
  //   ① 有钩子行 ② 锚点仍恰好唯一命中 ③ 钩子行正文 = 本站 cohort 期望的那行。
  // 这三条同时被**插件启动提示**（lib/audit/index.js）复用 —— 单一真源，判据不分叉。
  const verdict = verifyPatched(target, original);
  const vdetail = hitsDetail(verdict.counts);
  const hasHook = verdict.state !== 'not-applied';

  if (hasHook) {
    // 回滚：删钩子行（判据与 --check 共用 stripHookLines）。
    if (MODE === 'revert') {
      const stripped = stripHookLines(original);
      writeFileSync(file, stripped, 'utf8');
      const matchesBackup = existsSync(backup) ? readFileSync(backup, 'utf8') === stripped : undefined;
      return {
        id: target.id,
        file,
        state: 'reverted',
        note: matchesBackup === undefined ? '（无 .orig 备份可比对）' : matchesBackup ? '与备份逐字节一致' : '⚠ 与备份不一致',
      };
    }
    // 复核不过 ⇒ **一个字也不改**，更不许报 applied（那正是 C-09 的谎报）。退出码 2，等人工核对。
    if (verdict.state !== 'applied') {
      return {
        id: target.id,
        file,
        state: verdict.state,
        note:
          `钩子行在，但复核不过（${verdict.state}；${vdetail}）⇒ 未改动` +
          (verdict.expected ? `；期望钩子行: ${verdict.expected}` : '') +
          (verdict.actual ? `；实际: ${verdict.actual}` : ''),
      };
    }
    return {
      id: target.id,
      file,
      state: 'applied',
      cohort: verdict.cohort,
      sha256: sha256(original),
      note:
        MODE === 'apply'
          ? `已是 applied，跳过（复核通过：cohort ${verdict.cohort}；${vdetail}）`
          : `复核通过：cohort ${verdict.cohort} 的锚点与钩子行都在原处（${vdetail}）`,
    };
  }

  // 未打补丁的文件没什么可回滚（与从前的语义一致：不回滚也不解析锚点）。
  if (MODE === 'revert') return { id: target.id, file, state: 'not-applied' };

  // 候选锚点解析：恰好一个唯一命中才可用；多个同时命中 = 歧义；全不命中 = 漂移。
  const res = resolveAnchor(target, original);
  const detail = hitsDetail(res.counts);

  if (MODE === 'check') {
    if (res.state === 'hit') {
      return { id: target.id, file, state: 'not-applied', note: `可应用（候选 cohort ${res.cohort}；${detail}）` };
    }
    if (res.state === 'ambiguous') {
      return { id: target.id, file, state: 'ambiguous', note: `歧义：${detail} —— 多个候选同时唯一命中，拒绝改动` };
    }
    return { id: target.id, file, state: 'drifted', note: `锚点未命中：${detail}` };
  }

  // apply
  if (res.state === 'ambiguous') {
    return { id: target.id, file, state: 'ambiguous', note: `歧义：${detail} —— 多个候选同时唯一命中 → 拒绝改动（不许猜）` };
  }
  if (res.state === 'drifted') {
    return { id: target.id, file, state: 'drifted', note: `锚点全漂：${detail} → 未改动，请人工核对/更新锚点` };
  }
  const candidate = res.candidate;
  const patched = original.replace(candidate.anchor, (...args) => {
    const match = args[0];
    const groups = args.slice(1, -2).map((g) => g ?? '');
    const anchorIndent = groups[groups.length - 1] ?? '';
    const lastLineIndent = (match.split(/\r?\n/).filter((l) => l.trim()).pop() || '').match(/^[ \t]*/)[0];
    const delta = Number.isInteger(candidate.indentDelta) ? candidate.indentDelta : 1;
    const insert = candidate.line((lastLineIndent || anchorIndent) + '\t'.repeat(delta));
    return `${match}${insert}`;
  });
  if (patched === original) {
    return { id: target.id, file, state: 'drifted', note: '替换未产生变化 → 未改动' };
  }
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, patched, 'utf8');
  return {
    id: target.id,
    file,
    state: 'applied',
    cohort: res.cohort,
    note: `按候选 cohort ${res.cohort} 的锚点插入（${detail}）`,
    sha256: sha256(patched),
    sha256Before: sha256(original),
    sha256After: sha256(patched),
    backup,
  };
}

function writeState(root, results) {
  // F6①：`--check` 是**只读自检** —— 不再写状态文件。
  // 旧写法在 check 模式下也写盘：① 把上一次 apply 的记录覆盖成本次的 dshRoot（C-10/C-11），
  // ② 让"在只读沙箱里自检"变成不可能，③ 与"检查"这个词的语义相反。判据侧不受影响：
  // 插件启动提示现在直接读 core 实体（F8），不再依赖状态文件是否存在。
  if (MODE === 'check') return null;
  const dir = join(dshHome(), 'logs');
  try {
    mkdirSync(dir, { recursive: true });
    const state = {
      marker: PATCH_MARKER,
      tool: 'dsh-ling/tools/apply-access-log-patch.mjs',
      mode: MODE,
      at: new Date().toISOString(),
      dshRoot: root,
      // F6②/E10：**打补丁那一刻的 DSH 版本** —— 插件启动时与当前版本比对，升级后才有得提示。
      dshVersion: dshVersionOf(root),
      node: process.version,
      targets: results.map((r) => ({
        id: r.id,
        file: r.file,
        state: r.state,
        ...(r.cohort ? { cohort: r.cohort } : {}),
        // F8③：打补丁后目标文件的 sha256 —— 文件被换掉（升级/重装）即可发现，不必等锚点失配。
        ...(r.sha256 ? { sha256: r.sha256 } : {}),
      })),
    };
    writeFileSync(join(dir, PATCH_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return join(dir, PATCH_STATE_FILE);
  } catch (err) {
    return `(状态文件写入失败：${err.message})`;
  }
}

/** 只有人工能处理的状态（锚点要更新 / 钩子行 cohort 错 / 重复打过）——退出码 2，与 --check 同义。 */
const HUMAN_STATES = new Set(['drifted', 'stale', 'cohort-mismatch', 'duplicated']);
/** 别的问题（同一份代码里两种 cohort 都在 / 目标文件不在）。 */
const OTHER_STATES = new Set(['ambiguous', 'missing-file']);

function main() {
  const root = findDshRoot();
  const version = dshVersionOf(root);
  const prev = readStateFile();
  const results = PATCH_TARGETS.map((t) => processTarget(root, t));
  const stateFile = writeState(root, results);

  console.log(`# E4 access log patch · ${MODE}`);
  console.log(`  DSH 包根: ${root}${version ? `（DSH ${version}）` : ''}`);
  // F6②/E10：版本变了 = 升级过 —— 而升级会覆盖 core（这正是 F8 那条"提示静默失灵"的现场）。
  if (prev && prev.dshVersion && version && prev.dshVersion !== version) {
    console.log(`  ⚠ 上次打补丁时是 DSH ${prev.dshVersion}，现在是 ${version} —— 升级会覆盖 core，须复核补丁`);
  }
  for (const t of PATCH_TARGETS) {
    const r = results.find((x) => x.id === t.id);
    console.log(`  [${r.state}] ${t.label}`);
    console.log(`      ${r.file}`);
    if (r.note) console.log(`      ${r.note}`);
  }
  console.log(
    stateFile
      ? `  状态文件: ${stateFile}`
      : `  状态文件: （--check 只读自检，本次不写盘；上一次的记录见 ${join(dshHome(), 'logs', PATCH_STATE_FILE)}）`,
  );

  const bad = results.filter((r) => HUMAN_STATES.has(r.state) || OTHER_STATES.has(r.state));
  if (MODE === 'check') {
    const pending = results.filter((r) => r.state !== 'applied');
    if (pending.length || bad.length) {
      console.log(`  ⚠ 未就绪: ${pending.map((r) => `${r.id}=${r.state}`).join(', ')}`);
      process.exitCode = 2;
    } else {
      console.log('  ✅ 两条补丁均已应用');
    }
    return;
  }
  if (bad.length) {
    // 需要人工处理（漂移/stale/cohort 错/重复）= 退出码 2（与 --check 的语义一致）；歧义/缺文件 = 1。
    const human = results.some((r) => HUMAN_STATES.has(r.state));
    console.error(`  ✖ 有目标未按预期处理：${bad.map((r) => `${r.id}=${r.state}`).join('、')}（未强行改动任何文件）`);
    process.exitCode = human ? 2 : 1;
    return;
  }
  console.log(`  ℹ 改动 core 后需重启 dsh web 才生效（host 侧无热载，见 BACKLOG E1）`);
}

try {
  main();
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exitCode = 1;
}
