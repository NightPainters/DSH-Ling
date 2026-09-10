// dsh-ling v0 import — DeepSeek 网页端历史语料 → 插件记忆库 conv_overview。
// 数据源:你自己机器上网页端聊天记录库(deepseek_library.db 之类),用 --ds 指定路径。
// 用法:
//   node tools/import-dsweb.mjs --ds <聊天记录.db> [--target <memory.db>]
//                              [--limit N] [--dry-run] [--since 2025-01-31]
// 类别启发式 + 关键词抽取为 v0 方案;LLM 概述升级在 M2。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// dsh-ling 数据目录(可用 DSH_HOME 覆盖)
const LING_DIR = (process.env.DSH_HOME ? process.env.DSH_HOME.replace(/\\/g, '/') : join(homedir(), '.dsh')) + '/cache/dsh-ling';

const DS_DEFAULT = process.env.DSH_LING_DSWEB_DB || '';
const TARGET_DEFAULT = join(LING_DIR, 'memory.db');

// ---------- 类别启发式 ----------
const KNOW_PAT = /物理|模拟|材料|合金|金属|固溶|热处理|退火|淬火|SLM|激光|3D|打印|工艺|实验|力学|运动|弹簧|电|磁|机械|轴承|齿轮|螺栓|公差|图纸|仿真|计算|推导|方程|函数|算法|代码|编程|程序|开发|设计|架构|编辑器|工具|软件|系统|虚拟机|显示|显卡|显示器|网络|协议|数据|数据库|安全|加密|AI|GPT|LLM|模型|HTML|CSS|插件|开源|文献|论文|综述|研究|分析|优化|参数|标准|工程|仿真|python|前端|后端|电路|噪声|声|光|波|流体|温度|硬度|刚度|强度|疲劳|失效|锈|腐蚀|焊接|铸造|锻|粉末|显微|扫描|衍射|晶体|薄膜|电池|半导体|传感器|嵌入式|单片机|遥控|信号|频|放大器|扬声器|摄像头|无人|遥控器|传感器|直线|滚珠|丝杆|导轨|减速|电机|驱动|单片机|stm|arduino|树莓派|统计|概率|几何|代数|微积分|复变|信号与系统|傅里叶|拉普拉斯|微分方程|数值|离散|连续|随机/;
const FEEL_PAT = /失眠|睡眠|睡不着|焦虑|烦躁|抑郁|emo|情绪|心情|感情|关系|朋友|家人|父母|孤独|迷茫|人生|困惑|害怕|恐惧|压力|疲惫|累|休息|放松|静心|呼吸|梦境|梦|倾诉|共鸣|温暖|鼓励|安慰|不安|内耗|自我|意义|幸福|遗憾|夜|月亮|散文|随想|杂感|闲聊|谈心|牢骚|吐槽|习惯|拖延|自律|动力|目标感|虚无|发呆|感性|告别|怀念|感谢|感动|爱|喜欢(一个人)?/;
const CAT_TITLE_HINT = { knowledge: KNOW_PAT, feeling: FEEL_PAT };

// ---------- 关键词抽取(CJK 分块,朴素 v0) ----------
const CJK_SEG = /[\u4e00-\u9fff]{2,}/g;
function keywordsFromText(text, max = 14) {
  if (!text) return [];
  const out = [];
  const segs = String(text).match(CJK_SEG) || [];
  for (const seg of segs.slice(0, 8)) {
    const step = Math.min(6, seg.length);
    for (let i = 0; i + step <= seg.length && out.length < max; i += step) {
      const kw = seg.slice(i, i + step);
      if (!out.includes(kw)) out.push(kw);
    }
  }
  return out.slice(0, max);
}

function categorize(title) {
  if (FEEL_PAT.test(title)) return 'feeling';
  if (KNOW_PAT.test(title)) return 'knowledge';
  return 'daily';
}

// ---------- 主流程 ----------
function parseArgs() {
  const a = process.argv.slice(2);
  const g = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  return {
    ds: g('ds', DS_DEFAULT),
    target: g('target', TARGET_DEFAULT),
    limit: Number(g('limit', '0')) || 0,
    dryRun: a.includes('--dry-run'),
    since: g('since', ''),
  };
}

const args = parseArgs();
if (!args.ds) { console.error('缺少数据源:请用 --ds <聊天记录.db> 指定(或用 DSH_LING_DSWEB_DB 环境变量)'); process.exit(1); }
if (!existsSync(args.ds)) { console.error('数据源不存在:', args.ds); process.exit(1); }

const src = new DatabaseSync(args.ds, { readOnly: true });
const convRows = src.prepare(
  'SELECT conv_id, title, inserted_at, updated_at, n_user FROM conversations ORDER BY idx',
).all();
const userMsg = src.prepare(
  "SELECT conv_id, text FROM messages WHERE role='USER' AND conv_id=? AND text IS NOT NULL AND length(text)>0 ORDER BY seq LIMIT 1",
);
const firstUserText = new Map();
for (const c of convRows) {
  const r = userMsg.get(c.conv_id);
  if (r && r.text) firstUserText.set(c.conv_id, r.text);
}
src.close();

const rows = [];
for (const c of convRows) {
  const title = String(c.title || '').trim();
  if (!title) continue;
  const inserted = c.inserted_at ? String(c.inserted_at) : '';
  const updated = c.updated_at ? String(c.updated_at) : inserted;
  if (args.since && inserted.slice(0, 10) < args.since) continue;
  const first = firstUserText.get(c.conv_id) || title;
  const category = categorize(title);
  const keywords = keywordsFromText((title + ' ' + first).slice(0, 300));
  rows.push({
    conv_id: String(c.conv_id),
    source: 'dsweb',
    title,
    started_at: inserted,
    updated_at: updated,
    domain_tags: [category === 'knowledge' ? '知识' : category === 'feeling' ? '生活' : '日常'],
    category,
    keywords,
    summary: '',
    heat: 0,
    importance: 0,
    last_hit_at: null,
    hit_count: 0,
    overview_ok: 1,
    origin: 'dsweb-import-v0',
  });
}
if (args.limit > 0) rows.length = Math.min(rows.length, args.limit);

const catCount = rows.reduce((m, r) => { m[r.category] = (m[r.category] || 0) + 1; return m; }, {});
console.log(`读取会话 ${convRows.length} 个,过滤后生成 overview ${rows.length} 行`);
console.log('类别分布:', JSON.stringify(catCount));

if (args.dryRun) {
  console.log('[dry-run] 示例 6 条:');
  for (const r of rows.slice(0, 6)) {
    console.log(`  [${r.category}] ${r.started_at.slice(0, 10)} ${r.title.slice(0, 40)} kw=${r.keywords.slice(0, 4).join('/')}`);
  }
  process.exit(0);
}

// 写入目标库(与运行中插件并发安全:WAL + busy_timeout + 单事务)
const target = args.target;
if (!existsSync(target)) { console.error('目标记忆库不存在(先启动过插件?):', target); process.exit(1); }
const db = new DatabaseSync(target);
db.exec('PRAGMA busy_timeout=15000;');
db.exec('BEGIN');
const upsert = db.prepare(`
  INSERT INTO conv_overview
    (conv_id, source, title, started_at, updated_at, domain_tags, category, keywords, summary,
     heat, importance, last_hit_at, hit_count, overview_ok, origin)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(source, conv_id) DO UPDATE SET
    title=excluded.title, updated_at=excluded.updated_at, domain_tags=excluded.domain_tags,
    category=excluded.category, keywords=excluded.keywords, summary=excluded.summary,
    overview_ok=excluded.overview_ok, origin=excluded.origin
`);
try {
  for (const r of rows) {
    upsert.run(
      r.conv_id, r.source, r.title, r.started_at || null, r.updated_at || null,
      JSON.stringify(r.domain_tags), r.category, JSON.stringify(r.keywords), r.summary,
      r.heat, r.importance, r.last_hit_at, r.hit_count, r.overview_ok, r.origin,
    );
  }
  db.exec('COMMIT');
  const n = db.prepare('SELECT COUNT(*) AS n FROM conv_overview WHERE source=?').get('dsweb');
  console.log(`写入完成。库内 dsweb 概述总数: ${n.n}`);
  db.close();
} catch (e) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('写入失败,已回滚:', e.message);
  process.exit(1);
}
