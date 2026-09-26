// dsh-ling — 安装自检:确认 profile 里的插件入口确实指向本仓库(而非旧复制副本)。
// 背景(2026-09-11 真机踩坑):DSH 版本回退/重装会把 `file:` 依赖从 junction 换成实体复制快照,
// 于是"改了代码、重启刷新"也永不生效(服务端读的是那份旧快照)。
//
// 用法:
//   node tools/check-install.mjs                 # 自检(只读)
//   node tools/check-install.mjs --fix           # 若发现是复制副本 → 备份并重挂 junction
//   node tools/check-install.mjs --profile <dir> # 指定 profile(默认 web)
import { existsSync, lstatSync, readlinkSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PROFILE = g('profile', join(homedir(), '.dsh/profiles/web')).replace(/\\/g, '/');
const FIX = args.includes('--fix');
// 包名(发布名 @nightpainters/dsh-ling):2026-09-26 改名后,旧名 `dsh-ling` 的 junction **已删**,
// 现在只剩别名这一条入口;两个名字仍都认 —— 只认新名会把"装了旧名的部署"误报成"未安装",
// 只认旧名则会把"已切名"的部署误报成"未安装"。注:两个入口同时存在会触发客户端重复注册(见 B43)。
const PKG_NAMES = ['dsh-ling', '@nightpainters/dsh-ling'];
// Windows junction 的 readlink 可能带两种设备前缀:`\\?\`(Node 建的)与 `\??\`(mklink /J 建的)——
// 两个都要剥掉,否则"入口直连仓库"会被误判成"指向了别处"。
const norm = (p) => String(p || '')
  .replace(/^\\\\\?\\/, '')
  .replace(/^\\\?\?\\/, '')
  .replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);
const KEY_FILES = ['package.json', 'lib/index.js', 'lib/client.js', 'lib/host/api.js'];

console.log('== dsh-ling 安装自检 ==');
console.log('仓库   :', REPO);
console.log('profile:', PROFILE);
const problems = [];

// 1) 入口是否存在(两个包名都认)
const asEntry = (n) => join(PROFILE, 'node_modules', ...n.split('/'));
const realDir = (p) => { try { return norm(realpathSync(p)); } catch { return ''; } };
const entries = PKG_NAMES.map((n) => ({ name: n, path: asEntry(n) })).filter((x) => existsSync(x.path));
if (!entries.length) {
  problems.push(`profile 里既没有 node_modules/${PKG_NAMES[0]},也没有 node_modules/${PKG_NAMES[1]} —— 插件未安装(在 profile/package.json 加 "${PKG_NAMES[1]}": "file:<仓库路径>" 后安装,并在 cordis.patch.yml 追加 {id: dsh-ling, name: 'dsh-ling'})`);
} else {
  // 两个包名同时存在时:必须是**同一个目录**(别名 junction)。指向不同目录 = 其中一个是被加载的旧副本,那是真问题。
  if (entries.length === 2) {
    const [a, b] = entries.map((x) => realDir(x.path));
    if (a && b && a === b) {
      console.log(`✓ 两个包名都在(${entries.map((x) => x.name).join(' + ')}),且指向同一目录:${a}`);
    } else {
      problems.push(`两个包名指向了**不同**目录:${entries[0].name} → ${a || '(解析不出)'} / ${entries[1].name} → ${b || '(解析不出)'} —— 其中一个很可能是旧副本,先查清宿主实际加载的是哪一个`);
    }
  }
  for (const ent of entries) {
    const st = lstatSync(ent.path);
    const isLink = st.isSymbolicLink();
    const target = isLink ? norm(readlinkSync(ent.path)) : '';
    console.log(`入口[${ent.name}]:`, isLink ? '链接(junction/symlink) → ' + target : '实体目录(复制副本)');
    if (isLink) {
      if (target === norm(REPO)) {
        console.log(`  ✓ [${ent.name}] 入口直连仓库:代码改动即时生效(重启 + 刷新即可)`);
      } else {
        problems.push(`[${ent.name}] 入口链接指向了别处:${target}(期望 ${norm(REPO)})`);
      }
      continue;
    }
    // 实体副本:与仓库逐文件比对,判断"落后"
    const rows = [];
    let stale = 0;
    for (const rel of KEY_FILES) {
      const a = join(ent.path, rel);
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
      ? `[${ent.name}] 入口是实体复制副本,且 ${stale} 个关键文件落后于仓库 —— 这就是"改了不生效"的原因`
      : `[${ent.name}] 入口是实体复制副本(当前内容恰好一致,但以后改动不会自动同步)`);
    if (FIX) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${ent.path}.bak-${stamp}`;
      try {
        renameSync(ent.path, bak);
        symlinkSync(REPO, ent.path, 'junction');
        console.log(`✓ 已修复:旧副本备份为 ${bak},入口重挂为 junction → ${REPO}`);
        problems.length = 0;
      } catch (err) {
        problems.push('修复失败:' + String(err?.message ?? err) + '(可手动执行:mklink /J "' + ent.path.replace(/\//g, '\\') + '" "' + REPO.replace(/\//g, '\\') + '")');
      }
    }
  }
}

// 2) 是否启用(两条通道都算 —— 只认 patch 层会**误报**"插件不会被加载":
//    本机现场就是走 `profile/package.json` 的 `dsh.profile.bundles` 加载的,
//    而 cordis.patch.yml 里的 `- id: dsh-ling` 早已被挪进 cordis.patch.yml.disable。)
const patch = join(PROFILE, 'cordis.patch.yml');
const profPkg = join(PROFILE, 'package.json');
let enabledVia = '';
if (existsSync(patch)) {
  const txt = readFileSync(patch, 'utf8');
  if (/(^|\s)-?\s*id:\s*@?nightpainters\/dsh-ling\b/.test(txt) || /(^|\s)-?\s*id:\s*dsh-ling\b/.test(txt)) {
    enabledVia = 'cordis.patch.yml 的 `- id: dsh-ling`';
  }
}
let profDep = false;
if (existsSync(profPkg)) {
  try {
    const pj = JSON.parse(readFileSync(profPkg, 'utf8'));
    const bundles = pj?.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.some((b) => b === 'dsh-ling' || b === '@nightpainters/dsh-ling')) {
      enabledVia = enabledVia || 'profile package.json 的 dsh.profile.bundles';
    }
    profDep = !!(pj?.dependencies?.['dsh-ling'] || pj?.dependencies?.['@nightpainters/dsh-ling']);
  } catch { /* 解析不了就退回下面的判据 */ }
}
if (enabledVia) {
  console.log(`✓ 已启用 dsh-ling(${enabledVia})`);
} else if (!existsSync(patch) && !existsSync(profPkg)) {
  problems.push('找不到 cordis.patch.yml,也找不到 profile/package.json(路径:' + PROFILE + ')');
} else {
  problems.push(profDep
    ? 'profile 依赖里有 dsh-ling,但既没在 cordis.patch.yml 写 `- id: dsh-ling`,也没进 dsh.profile.bundles —— 装了但不会被加载'
    : `cordis.patch.yml 与 profile 的 dsh.profile.bundles 里都没有 dsh-ling —— 插件不会被加载(在 profile/package.json 的 dsh.profile.bundles 追加 "dsh-ling",或在 cordis.patch.yml 追加 {id: dsh-ling, name: 'dsh-ling'})`);
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
