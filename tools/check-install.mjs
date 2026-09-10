// dsh-ling — 安装自检:确认 profile 里的插件入口确实指向本仓库(而非旧复制副本)。
// 背景(2026-09-11 真机踩坑):DSH 版本回退/重装会把 `file:` 依赖从 junction 换成实体复制快照,
// 于是"改了代码、重启刷新"也永不生效(服务端读的是那份旧快照)。
//
// 用法:
//   node tools/check-install.mjs                 # 自检(只读)
//   node tools/check-install.mjs --fix           # 若发现是复制副本 → 备份并重挂 junction
//   node tools/check-install.mjs --profile <dir> # 指定 profile(默认 web)
import { existsSync, lstatSync, readlinkSync, readdirSync, readFileSync, renameSync, symlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROFILE = g('profile', join(homedir(), '.dsh/profiles/web')).replace(/\\/g, '/');
const FIX = args.includes('--fix');
const LINK = join(PROFILE, 'node_modules', 'dsh-ling');
const norm = (p) => String(p || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);
const KEY_FILES = ['package.json', 'lib/index.js', 'lib/client.js', 'lib/host/api.js'];

console.log('== dsh-ling 安装自检 ==');
console.log('仓库   :', REPO);
console.log('profile:', PROFILE);
const problems = [];

// 1) 入口是否存在
if (!existsSync(LINK)) {
  problems.push('profile 里没有 node_modules/dsh-ling —— 插件未安装(在 profile/package.json 加 "dsh-ling": "file:<仓库路径>" 后安装,并在 cordis.patch.yml 追加 {id: dsh-ling, name: \'dsh-ling\'})');
} else {
  const st = lstatSync(LINK);
  const isLink = st.isSymbolicLink();
  const target = isLink ? norm(readlinkSync(LINK)) : '';
  console.log('入口类型:', isLink ? '链接(junction/symlink) → ' + target : '实体目录(复制副本)');
  if (isLink) {
    if (target === norm(REPO)) {
      console.log('✓ 入口直连仓库:代码改动即时生效(重启 + 刷新即可)');
    } else {
      problems.push(`入口链接指向了别处:${target}(期望 ${norm(REPO)})`);
    }
  } else {
    // 实体副本:与仓库逐文件比对,判断"落后"
    const rows = [];
    let stale = 0;
    for (const rel of KEY_FILES) {
      const a = join(LINK, rel);
      const b = join(REPO, rel);
      if (!existsSync(a) || !existsSync(b)) { rows.push([rel, '缺失', '']); continue; }
      const ha = sha(a);
      const hb = sha(b);
      const same = ha === hb;
      if (!same) stale += 1;
      rows.push([rel, same ? '一致' : '落后', same ? '' : `${ha} ≠ ${hb}`]);
    }
    console.log('关键文件:');
    for (const [rel, verdict, detail] of rows) console.log('  ', rel.padEnd(22), verdict, detail);
    problems.push(stale
      ? `入口是实体复制副本,且 ${stale} 个关键文件落后于仓库 —— 这就是"改了不生效"的原因`
      : '入口是实体复制副本(当前内容恰好一致,但以后改动不会自动同步)');
    if (FIX) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${LINK}.bak-${stamp}`;
      try {
        renameSync(LINK, bak);
        symlinkSync(REPO, LINK, 'junction');
        console.log(`✓ 已修复:旧副本备份为 ${bak},入口重挂为 junction → ${REPO}`);
        problems.length = 0;
      } catch (e) {
        problems.push('修复失败:' + String(e?.message ?? e) + '(可手动执行:mklink /J "' + LINK.replace(/\//g, '\\') + '" "' + REPO.replace(/\//g, '\\') + '")');
      }
    }
  }
}

// 2) cordis.patch.yml 是否启用
const patch = join(PROFILE, 'cordis.patch.yml');
if (existsSync(patch)) {
  const txt = readFileSync(patch, 'utf8');
  if (/(^|\s)-?\s*id:\s*dsh-ling\b/.test(txt)) console.log('✓ cordis.patch.yml 已启用 dsh-ling');
  else problems.push('cordis.patch.yml 中没有 dsh-ling 行 —— 插件不会被加载');
} else {
  problems.push('找不到 cordis.patch.yml(路径:' + patch + ')');
}

// 3) 数据目录
const HOME = (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/');
const dataDir = join(HOME, 'cache', 'dsh-ling');
for (const f of ['settings.json', 'memory.db']) {
  const p = join(dataDir, f);
  console.log((existsSync(p) ? '✓' : '·'), 'data:', f, existsSync(p) ? `(${statSync(p).size} B)` : '(尚未生成,首次启动插件时创建)');
}

// 4) 结论
console.log('\n== 结论 ==');
if (!problems.length) {
  console.log('一切正常。若改了代码仍不见效:先一键重启(host),再 Ctrl+Shift+R 刷新页面(client)。');
  process.exit(0);
}
for (const p of problems) console.log('✗', p);
console.log('\n建议:优先执行 `node tools/check-install.mjs --fix` 修复入口;修完一键重启 + 刷新。');
process.exit(1);
