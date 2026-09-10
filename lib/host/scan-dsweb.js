// dsh-ling host — 网页端(ds-search)库增量扫描 → 记忆库 conv_overview。
// 数据源形态与 tools/import-dsweb.mjs 一致:ds-search 生成的 deepseek_library.db
// (conversations / messages 两张表)。本模块供 API 层与工具共用,幂等(按 conv_id
// upsert 元数据,不动本地 summary/importance/置顶等用户态字段)。
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

// ---------- 类别启发式(与 v0 工具同源,保证一致性) ----------
const KNOW_PAT = /物理|模拟|材料|合金|金属|固溶|热处理|退火|淬火|SLM|激光|3D|打印|工艺|实验|力学|运动|弹簧|电|磁|机械|轴承|齿轮|螺栓|公差|图纸|仿真|计算|推导|方程|函数|算法|代码|编程|程序|开发|设计|架构|编辑器|工具|软件|系统|虚拟机|显示|显卡|显示器|网络|协议|数据|数据库|安全|加密|AI|GPT|LLM|模型|HTML|CSS|插件|开源|文献|论文|综述|研究|分析|优化|参数|标准|工程|仿真|python|前端|后端|电路|噪声|声|光|波|流体|温度|硬度|刚度|强度|疲劳|失效|锈|腐蚀|焊接|铸造|锻|粉末|显微|扫描|衍射|晶体|薄膜|电池|半导体|传感器|嵌入式|单片机|遥控|信号|频|放大器|扬声器|摄像头|无人|遥控器|传感器|直线|滚珠|丝杆|导轨|减速|电机|驱动|单片机|stm|arduino|树莓派|统计|概率|几何|代数|微积分|复变|信号与系统|傅里叶|拉普拉斯|微分方程|数值|离散|连续|随机/;
const FEEL_PAT = /失眠|睡眠|睡不着|焦虑|烦躁|抑郁|emo|情绪|心情|感情|关系|朋友|家人|父母|孤独|迷茫|人生|困惑|害怕|恐惧|压力|疲惫|累|休息|放松|静心|呼吸|梦境|梦|倾诉|共鸣|温暖|鼓励|安慰|不安|内耗|自我|意义|幸福|遗憾|夜|月亮|散文|随想|杂感|闲聊|谈心|牢骚|吐槽|习惯|拖延|自律|动力|目标感|虚无|发呆|感性|告别|怀念|感谢|感动|爱|喜欢(一个人)?/;

const CJK_SEG = /[\u4e00-\u9fff]{2,}/g;

export function keywordsFromText(text, max = 14) {
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

export function categorize(title) {
  if (FEEL_PAT.test(String(title))) return 'feeling';
  if (KNOW_PAT.test(String(title))) return 'knowledge';
  return 'daily';
}

const CAT_NAME = { knowledge: '知识', feeling: '生活', daily: '日常' };

/** 读源库 → overview 行(不写库)。返回 { sourceTotal, rows, skipped }。 */
export function readDswebRows(dbPath, { limit = 0, since = '' } = {}) {
  if (!dbPath || !existsSync(String(dbPath))) {
    const e = new Error('数据源不存在:' + dbPath);
    e.code = 'ENOENT_SRC';
    throw e;
  }
  const src = new DatabaseSync(String(dbPath), { readOnly: true });
  try {
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
    const rows = [];
    for (const c of convRows) {
      const title = String(c.title || '').trim();
      if (!title) continue;
      const inserted = c.inserted_at ? String(c.inserted_at) : '';
      if (since && inserted.slice(0, 10) < since) continue;
      const first = firstUserText.get(c.conv_id) || title;
      const category = categorize(title);
      rows.push({
        conv_id: String(c.conv_id),
        source: 'dsweb',
        title,
        started_at: inserted,
        updated_at: c.updated_at ? String(c.updated_at) : inserted,
        domain_tags: [CAT_NAME[category] || '日常'],
        category,
        keywords: keywordsFromText((title + ' ' + first).slice(0, 300)),
        summary: '',
        heat: 0,
        importance: 0,
        last_hit_at: null,
        hit_count: 0,
        overview_ok: 1,
        origin: 'dsweb-import-v0',
      });
    }
    if (limit > 0) rows.length = Math.min(rows.length, limit);
    return { sourceTotal: convRows.length, rows };
  } finally {
    src.close();
  }
}

/** 增量入库:已存在 = 仅刷新元数据(updated/title/category/keywords);不动 summary/importance/置顶。 */
export function scanIntoMemory(memory, dbPath, { limit = 0, since = '' } = {}) {
  const { sourceTotal, rows } = readDswebRows(dbPath, { limit, since });
  const existing = new Set(
    memory.db.prepare("SELECT conv_id FROM conv_overview WHERE source='dsweb'").all().map((r) => String(r.conv_id)),
  );
  let added = 0;
  let refreshed = 0;
  for (const r of rows) {
    if (existing.has(r.conv_id)) {
      memory.db.prepare(
        `UPDATE conv_overview SET title=?, updated_at=?, domain_tags=?, category=?, keywords=?,
           overview_ok=1, origin=? WHERE source='dsweb' AND conv_id=?`,
      ).run(r.title, r.updated_at || null, JSON.stringify(r.domain_tags), r.category, JSON.stringify(r.keywords), r.origin, r.conv_id);
      refreshed++;
    } else {
      memory.upsertOverview(r);
      added++;
    }
  }
  const total = memory.db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source='dsweb'").get().n;
  return { sourceTotal, seen: rows.length, added, refreshed, total: Number(total), skipped: sourceTotal - rows.length };
}
