// dsh-ling — 网页端(dsweb)概述补摘要:回源库取正文 → 本机小助手写摘要 → 只更新 summary 字段。
//
// 用法:
//   node tools/backfill-dsweb-summary.mjs --list                     # 只看候选(不发模型、不写库)
//   node tools/backfill-dsweb-summary.mjs --write --limit 50         # 真跑 50 条
//   node tools/backfill-dsweb-summary.mjs --write --all              # 含轮次不足的短会话
//   node tools/backfill-dsweb-summary.mjs --write --only-hit         # 只补"进过 L1"的(最划算)
// 选项:
//   --db <源库> --memory <记忆库> --min-turns N --limit N --model <名> --base <url>
//
// 铁律(用户 2026-09-16):**绝不静默切换到大模型** —— 小助手不可用就停,由人来选。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import('file://' + join(root, p).replace(/\\/g, '/'));
const { MemoryStore } = await imp('lib/host/memory.js');
const {
  openSource, buildCandidates, conversationText, probeAssistant, summarizeWithRetry,
  touchMemoryVersion,
  ASSISTANT_DEFAULT, ASSISTANT_MODEL_DEFAULT, MIN_TURNS_DEFAULT, MSG_BUDGET_DEFAULT, PER_MSG_DEFAULT,
} = await imp('lib/host/dsweb-summary.js');

// dsh-ling 数据目录(可用 DSH_HOME 覆盖)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';

const args = process.argv.slice(2);
const g = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (k) => args.includes('--' + k);

const source = g('db', process.env.DSH_LING_DSWEB_DB || '');
const memPath = g('memory', join(LING_DIR, 'memory.db'));
const minTurns = Number(g('min-turns', MIN_TURNS_DEFAULT)) || MIN_TURNS_DEFAULT;
const limit = Number(g('limit', 0)) || 0;
const includeShort = has('all');
const onlyHit = has('only-hit');
const budgetChars = Number(g('budget', MSG_BUDGET_DEFAULT)) || MSG_BUDGET_DEFAULT;
const perMsg = Number(g('per', PER_MSG_DEFAULT)) || PER_MSG_DEFAULT;
const base = g('base', process.env.DSH_LING_ASSISTANT || ASSISTANT_DEFAULT);
const model = g('model', process.env.DSH_LING_ASSISTANT_MODEL || ASSISTANT_MODEL_DEFAULT);
const doWrite = has('write');
const doList = has('list') || !doWrite;

if (!source) { console.error('缺少源库:请用 --db <deepseek_library.db> 指定(或设 DSH_LING_DSWEB_DB)'); process.exit(1); }
if (!existsSync(source)) { console.error('源库不存在:', source); process.exit(1); }
if (!existsSync(memPath)) { console.error('记忆库不存在:', memPath); process.exit(1); }

const src = openSource(source);
const memory = new MemoryStore(memPath);
const cands = buildCandidates(memory, src, { minTurns, includeShort, onlyHit });

console.log(`== dsweb 补摘要 ==`);
console.log(`源库   : ${source}`);
console.log(`记忆库 : ${memPath}`);
console.log(`候选   : ${cands.length} 条(阈值 轮次≥${includeShort ? '0(--all)' : minTurns}${onlyHit ? ' · 仅命中过' : ''})`);
const hitN = cands.filter((c) => c.hit_count > 0).length;
console.log(`其中进过 L1(命中>0): ${hitN} 条`);

if (doList) {
  console.log('\n前 20 条(命中优先 → 轮次降序):');
  for (const c of cands.slice(0, 20)) {
    console.log(`  ${String(c.hit_count).padStart(3)} 命中 · ${String(c.n_user).padStart(3)} 轮 · [${c.category}] ${c.title.slice(0, 44)}`);
  }
  console.log('\n(加 --write 才会真正调用模型并写库)');
  memory.close();
  process.exit(0);
}

// ---- 真跑:先探测小助手,不可用就停(绝不静默换大模型)----
const probe = await probeAssistant(base);
if (!probe.ok) {
  console.error(`\n✗ 本机小助手不可用(${probe.reason}) —— 已停止,不自动改用大模型。`);
  console.error(`  检查 ${base} 是否在跑;或显式指定 --base/--model。`);
  memory.close();
  process.exit(2);
}
const useModel = probe.models.includes(model) ? model : probe.models[0];
console.log(`小助手 : ${base} · 模型 ${useModel}(可用:${probe.models.join(', ')})`);

const todo = limit > 0 ? cands.slice(0, limit) : cands;
console.log(`本轮计划: ${todo.length} 条\n`);

let okN = 0; let failN = 0; const t0 = Date.now();
for (let i = 0; i < todo.length; i += 1) {
  const c = todo[i];
  const text = conversationText(src, c.conv_id, { budgetChars, perMsg });
  if (!text) { failN += 1; console.log(`  [${i + 1}/${todo.length}] 空正文,跳过 · ${c.title.slice(0, 30)}`); continue; }
  const payload = `会话标题:${c.title}\n\n对话正文:\n${text}`;
  const r = await summarizeWithRetry(base, useModel, { text: payload, maxTokens: Number(g('max-tokens', 0)) || undefined });
  if (!r.ok) {
    failN += 1;
    const d = has('debug') ? ' [diag ' + JSON.stringify(r.attempts.map((a) => ({ t: a.tag, mt: a.maxTokens, e: a.error, d: a.diag }))) + ']' : '';
    console.log(`  [${i + 1}/${todo.length}] 失败(${r.error})${d} · ${c.title.slice(0, 30)}`);
    continue;
  }
  try {
    const row = memory.overviewById('dsweb', c.conv_id);
    if (row) memory.upsertOverview({ ...row, summary: r.summary });
    okN += 1;
    console.log(`  [${i + 1}/${todo.length}] ✓ ${r.ms}ms · ${c.title.slice(0, 26)} → ${r.summary.slice(0, 46)}`);
  } catch (e) {
    failN += 1;
    console.log(`  [${i + 1}/${todo.length}] 写库失败:${String(e?.message ?? e).slice(0, 60)}`);
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
// 补摘要改的是记忆内容 → bump memory_version,长会话才会在空闲边界追平(只有概述器会 bump)
const touched = touchMemoryVersion(memory);
console.log(`\n完成:成功 ${okN} · 失败/跳过 ${failN} · 用时 ${mins} 分钟`);
console.log(touched ? 'memory_version 已更新:长会话下次空闲时会自动追平这批摘要' : '⚠ memory_version 未更新,长会话不会追平');
memory.close();
