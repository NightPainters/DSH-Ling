// dsh-ling — 命令行兜底:解除定型锁(GUI 仪式之外的硬逃生门;能摸到本机即持有者本人)。
// 用法: node tools/unseal.mjs [settings.json 路径]
// 默认路径:$DSH_HOME/cache/dsh-ling/settings.json(可用 DSH_LING_SETTINGS 环境变量覆盖)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// dsh-ling 数据目录(可用 DSH_HOME 覆盖)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';

const HOME = process.env.DSH_LING_SETTINGS || join(LING_DIR, 'settings.json');
const file = process.argv[2] || HOME;
if (!existsSync(file)) {
  console.error('settings.json 不存在:', file);
  console.error('用法: node tools/unseal.mjs [settings.json]');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(file, 'utf8'));
const user = raw.user || {};
const before = { sealed: user.persona?.sealed === true, phrase: !!user.persona?.sealPhrase };
if (user.persona) {
  user.persona.sealed = false;
  user.persona.sealPhrase = '';
  delete user.persona.sealHash; // 清理旧哈希时代遗留字段
} else {
  user.persona = { sealed: false, sealPhrase: '' };
}
writeFileSync(file, JSON.stringify({ __v: 2, user }, null, 2) + '\n', 'utf8');
console.log('已解除定型(sealed→false,承诺句已清空)。');
console.log('提示:① 若插件正在运行,请随后在 GUI 里做一次任意保存或重启,让运行中状态与磁盘一致;');
console.log('       ② 档案内容未动;人格编辑器里可重新定型(会再写一句新承诺)。');
if (!before.sealed && !before.phrase) console.log('(此前本就未定型,无变化)');
