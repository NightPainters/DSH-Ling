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
//   node tools/apply-access-log-patch.mjs --check    # 自检，未打/锚点漂移时退出码 2
//   node tools/apply-access-log-patch.mjs --revert   # 回滚（删掉插进去的那几行）
//   node tools/apply-access-log-patch.mjs --dsh-root "D:\\path\\to\\@deepseek-ai\\dsh"
//
// 纪律：锚点必须**唯一命中**才动手；命中数不是 1 直接中止并报出实际命中数 ——
// 宁可不动，也不能在 core 里插错地方（PITFALLS B3：判据过宽/过窄都是坑）。

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PATCH_TARGETS, PATCH_MARKER, PATCH_STATE_FILE, targetPath } from '../lib/audit/patch-spec.js';

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
const countMatches = (source, re) => {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (source.match(g) || []).length;
};

/** 删除标记行（回滚）。只删含 PATCH_MARKER 且形如钩子调用的行，绝不误删别的代码。 */
function stripMarkerLines(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => !(line.includes(PATCH_MARKER) && line.includes('globalThis.__dshAccessLog')))
    .join('\n');
}

function processTarget(root, target) {
  const file = targetPath(root, target);
  if (!existsSync(file)) {
    return { id: target.id, file, state: 'missing-file', note: '目标文件不存在（DSH 布局变了？）' };
  }
  const original = readFileSync(file, 'utf8');
  const applied = original.includes(PATCH_MARKER);
  const backup = `${file}${ORIG_SUFFIX}`;

  if (MODE === 'check') {
    if (applied) return { id: target.id, file, state: 'applied' };
    const hits = countMatches(original, target.anchor);
    return {
      id: target.id,
      file,
      state: hits === 1 ? 'not-applied' : 'drifted',
      note: hits === 1 ? '可应用' : `锚点命中 ${hits} 次（应为 1）`,
    };
  }

  if (MODE === 'revert') {
    if (!applied) return { id: target.id, file, state: 'not-applied' };
    const stripped = stripMarkerLines(original);
    writeFileSync(file, stripped, 'utf8');
    const matchesBackup = existsSync(backup) ? readFileSync(backup, 'utf8') === stripped : undefined;
    return {
      id: target.id,
      file,
      state: 'reverted',
      note: matchesBackup === undefined ? '（无 .orig 备份可比对）' : matchesBackup ? '与备份逐字节一致' : '⚠ 与备份不一致',
    };
  }

  // apply
  if (applied) return { id: target.id, file, state: 'applied', note: '已是 applied，跳过' };
  const hits = countMatches(original, target.anchor);
  if (hits !== 1) {
    return { id: target.id, file, state: 'drifted', note: `锚点命中 ${hits} 次（应为 1）→ 未改动，请人工核对` };
  }
  const patched = original.replace(target.anchor, (...args) => {
    const match = args[0];
    const groups = args.slice(1, -2).map((g) => g ?? '');
    const anchorIndent = groups[groups.length - 1] ?? '';
    const lastLineIndent = (match.split(/\r?\n/).filter((l) => l.trim()).pop() || '').match(/^[ \t]*/)[0];
    const delta = Number.isInteger(target.indentDelta) ? target.indentDelta : 1;
    const insert = target.line((lastLineIndent || anchorIndent) + '\t'.repeat(delta));
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
    sha256Before: sha256(original),
    sha256After: sha256(patched),
    backup,
  };
}

function writeState(root, results) {
  const dir = join(dshHome(), 'logs');
  try {
    mkdirSync(dir, { recursive: true });
    const state = {
      marker: PATCH_MARKER,
      tool: 'dsh-ling/tools/apply-access-log-patch.mjs',
      mode: MODE,
      at: new Date().toISOString(),
      dshRoot: root,
      targets: results.map((r) => ({ id: r.id, file: r.file, state: r.state })),
    };
    writeFileSync(join(dir, PATCH_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return join(dir, PATCH_STATE_FILE);
  } catch (err) {
    return `(状态文件写入失败：${err.message})`;
  }
}

function main() {
  const root = findDshRoot();
  const results = PATCH_TARGETS.map((t) => processTarget(root, t));
  const stateFile = writeState(root, results);

  console.log(`# E4 access log patch · ${MODE}`);
  console.log(`  DSH 包根: ${root}`);
  for (const t of PATCH_TARGETS) {
    const r = results.find((x) => x.id === t.id);
    console.log(`  [${r.state}] ${t.label}`);
    console.log(`      ${r.file}`);
    if (r.note) console.log(`      ${r.note}`);
  }
  console.log(`  状态文件: ${stateFile}`);

  const bad = results.filter((r) => r.state === 'drifted' || r.state === 'missing-file');
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
    console.error('  ✖ 有目标未按预期处理，请人工核对（未强行改动任何文件）');
    process.exitCode = 1;
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
