// 记忆标题(D2 2026-09-17):启发式 → 手改上锁 → 概述器不覆盖;附 D8 排序与来源计数
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');
const {
  heuristicTitle, isVagueTitle, stripPreamble, cleanTitle, retitleCandidates, TITLE_MAX_CHARS,
} = await imp('lib/host/retitle.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-title-'));
const db = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const turn = (sid, seq, role, text) => db.appendRawTurn(sid, { seq, role, ts: `2026-09-17T10:00:0${seq}Z`, model: null, text });

// ---- 1) 剥称呼/问候前缀 ----
check(stripPreamble('晚上好器灵，我小加班了一会，回来了') === '我小加班了一会，回来了', '剥「晚上好器灵，」: ' + stripPreamble('晚上好器灵，我小加班了一会，回来了'));
check(stripPreamble('器灵，接下来在这里继续开发') === '接下来在这里继续开发', '剥「器灵，」');
check(stripPreamble('哈喽器灵~ 今天做什么') === '今天做什么', '剥「哈喽器灵~ 」');

// ---- 2) 无信息量首句判定 ----
check(isVagueTitle('你好') === true, '「你好」= 无信息量');
check(isVagueTitle('下午好') === true, '「下午好」= 无信息量');
check(isVagueTitle('已测试聊天') === true, '「已测试聊天」= 无信息量');
check(isVagueTitle('UI测试，回复数字2') === true, '「UI测试…」= 无信息量');
check(isVagueTitle('现在你有计算器插件吗？没有的话挑一个装上') === false, '实质问句 ≠ 无信息量');

// ---- 3) 句读处收尾,不切半句(旧行为 46 字硬截) ----
const LONG = '器灵，接下来在这里继续开发生长型人格与记忆树模块，继续走你的新生之路。我刚刚对1.2.1的代码做了审计，发现问题';
const t = heuristicTitle(LONG);
check(t === '接下来在这里继续开发生长型人格与记忆树模块，继续走你的新生之路', '在「。」处收尾: ' + t);
check(t.length <= TITLE_MAX_CHARS, '不超上限: ' + t.length);
check(!t.endsWith('的') && !t.endsWith('，'), '不在半句/逗号处收尾: ' + t);
check(heuristicTitle('你好') === '', '无信息量返回空串(调用方改取后续)');

// 无句号的长句 → 退到最近的逗号
const long2 = heuristicTitle('本机环境不全先装这些东西包括git for windows还有第三方源码以及其他的一些基础工具链');
check(long2.length <= TITLE_MAX_CHARS, '超长硬截仍在上限内: ' + long2.length);

// ---- 4) 清洗模型输出 ----
check(cleanTitle('「记忆树标题设计」') === '记忆树标题设计', '去书名号/引号: ' + cleanTitle('「记忆树标题设计」'));
check(cleanTitle('标题: 守卫加固 ③④。') === '守卫加固 ③④', '去「标题:」与结尾标点: ' + cleanTitle('标题: 守卫加固 ③④。'));
check(cleanTitle('<think>思考一下</think>记忆标题') === '记忆标题', '去思考块');
check(cleanTitle('x'.repeat(80)).length === 40, '机器标题限长 40');

// ---- 5) 概述器:首句无信息量时改取后续有实义的首句 ----
turn('s-greet', 1, 'user', '你好');
turn('s-greet', 2, 'assistant', '你好,我在');
turn('s-greet', 3, 'user', '现在你有计算器插件吗？没有的话挑一个装上，涉及算数的时候用它');
turn('s-greet', 4, 'assistant', '好的,已装上');
summarizeDsh(db);
const g = db.overviewById('dsh', 's-greet');
check(g && String(g.title).startsWith('现在你有计算器插件吗'), '跳过「你好」取后续首句: ' + (g && g.title));

// ---- 6) 主人手改 → 上锁 → 概述器重建不覆盖 ----
const rn = db.renameTitle('dsh', 's-greet', '计算器插件安装', { lock: true });
check(rn.ok && rn.locked === true, '改名成功并上锁');
check(db.overviewById('dsh', 's-greet').title === '计算器插件安装', '标题已写入');
turn('s-greet', 5, 'assistant', '又聊了一句');
summarizeDsh(db);
const after = db.overviewById('dsh', 's-greet');
check(after.title === '计算器插件安装', '概述器重建不覆盖主人改的标题(实际=' + after.title + ')');
check(after.title_locked === true, 'title_locked 持久可读');
check(String(after.summary).includes('5 条消息'), '摘要仍随轮次刷新(锁只锁标题)');

// 解锁后交还机器
db.unlockTitle('dsh', 's-greet');
turn('s-greet', 6, 'assistant', '再一句');
summarizeDsh(db);
check(db.overviewById('dsh', 's-greet').title !== '计算器插件安装', '解锁后恢复机器命名');
check(db.overviewById('dsh', 's-greet').title_locked === false, '解锁后 title_locked=0');

// ---- 7) 空标题被拒(不让手滑清空) ----
check(db.renameTitle('dsh', 's-greet', '   ').ok === false, '空标题拒绝');
check(db.renameTitle('dsh', '不存在的会话', 'x').ok === false, '不存在的行拒绝');

// ---- 8) 库结构:title_locked 列存在(新库 DDL + 旧库 ALTER 迁移) ----
const cols = db.db.prepare('PRAGMA table_info(conv_overview)').all().map((c) => String(c.name));
check(cols.includes('title_locked'), 'title_locked 列存在');

// ---- 9) D8:热度排序改用真实落库的 hit_count(旧写法按恒为 0 的 heat 排 = 没排) ----
db.upsertOverview({ conv_id: 'h-low', source: 'dsweb', title: '低命中', summary: 'x' });
db.upsertOverview({ conv_id: 'h-high', source: 'dsweb', title: '高命中', summary: 'x' });
for (let i = 0; i < 5; i += 1) db.bumpHit('dsweb', 'h-high');
db.upsertOverview({ conv_id: 'h-pin', source: 'dsweb', title: '置顶', summary: 'x' });
db.setImportance('dsweb', 'h-pin', 1);
const heat = db.queryOverviews({ source: 'dsweb', sort: 'heat', limit: 10 });
check(heat.items[0].conv_id === 'h-high', '热度档第一条=命中最多者(实际=' + heat.items[0].conv_id + ')');
check(heat.items[1].conv_id === 'h-pin', '命中相同/为零时 importance 次之(实际=' + heat.items[1].conv_id + ')');

// ---- 10) D8:各来源条数 ----
const sc = db.sourceCounts();
check(sc.total === 4 && sc.bySource.dsh === 1 && sc.bySource.dsweb === 3, 'sourceCounts: ' + JSON.stringify(sc));

// ---- 11) 重命名候选:像样的标题与上锁的标题都排除在外 ----
const LONG_TITLE = 'x'.repeat(58); // 长度达旧上限 → 会被判"被截断过"
db.upsertOverview({ conv_id: 'nice-1', source: 'dsweb', title: '一条很像样的记忆标题', summary: 'x' });
db.upsertOverview({ conv_id: 'trunc-1', source: 'dsweb', title: LONG_TITLE, summary: 'x' });
db.upsertOverview({ conv_id: 'locked-1', source: 'dsweb', title: LONG_TITLE, summary: 'x' });
db.renameTitle('dsweb', 'locked-1', LONG_TITLE, { lock: true });
const cands = retitleCandidates(db, { limit: 50 });
check(!cands.some((c) => c.conv_id === 'nice-1'), '像样的标题不在候选里');
check(cands.some((c) => c.conv_id === 'trunc-1'), '未上锁的截断标题在候选里');
check(!cands.some((c) => c.conv_id === 'locked-1'), '上锁的标题不在候选里(即使被截断)');
check(cands.every((c) => c.source && c.conv_id), '候选行形状完整');

console.log(ok ? '\n记忆标题(D2)+ 排序修正(D8) 全部通过 ✓' : '\n记忆标题(D2) 有失败项');
if (!ok) process.exitCode = 1;
