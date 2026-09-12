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
const MAX_BYTES = 5 * 1024 * 1024; // 单文件超过 5MB 值得人工确认

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
  }
}

walk(REPO);

console.log('== dsh-ling 发布前检查 ==');
console.log('目录:', REPO);
console.log(`文件 ${files} 个 · 合计 ${(bytes / 1048576).toFixed(2)} MB\n`);

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
