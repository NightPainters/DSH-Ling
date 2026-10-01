// dsh-ling host — 会话契约文件导入(ACCESS-DESIGN §1/§3)。
// 统一搬运格式:JSON {sessions:[…]}/数组 或 JSONL 逐行一会话;两档深度:
//   完整档 messages[{role,text,at}] / 轻量档 summary+keywords(仅标题+时间也可)。
// source 恒为 'import'(与 dsweb/dsh 区分),conv_id 建议含平台命名空间(如 "webchat:123")。
// 2026-09-08:适配 DeepSeek 官方「导出所有历史会话」conversations.json(ChatGPT 风格 mapping 树:
//   会话 {id,title,inserted_at,updated_at,mapping},消息在 mapping 节点的 message.fragments,
//   REQUEST=用户 / RESPONSE=助手 / THINK/工具/FILE 忽略);同 uuid 命中 dsweb 旧域时自动折叠归并。
import { sha256Text } from './util.js';
import { heuristicTitle, TITLE_MAX_CHARS } from './retitle.js';
import { rawSessionId, rawSessionCandidates } from './memory.js';
import { categorizeTitle } from './classify.js';
import { keywordsFrom } from './inject-common.js';

export const IMPORT_SOURCE = 'import';
export const CAT_NAME = { knowledge: '知识', daily: '日常', feeling: '生活' };

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

/** 时间值清洗:ISO 字符串可能带 6 位微秒与偏移(如 .412000+08:00),截为 3 位毫秒再解析 */
function cleanTimeStr(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/(\.\d{3})\d+(?=(?:Z|[+-]\d{2}:?\d{2})?$)/, '$1');
}
/** epoch 归一:ChatGPT 的 create_time 是**秒**(浮点),DeepSeek 的是毫秒。
 *  S5(2026-09-17):旧实现一律当毫秒,于是 ChatGPT 导出的时间全部落到 1970 年。 */
function normEpoch(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return null;
  if (x > 1e11) return x;       // 毫秒(13 位)
  if (x > 1e8) return x * 1000; // 秒(10 位)→ 毫秒
  return null;
}
function isoTime(v) {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? normEpoch(v) : null;
  const t = ms != null ? new Date(ms) : new Date(cleanTimeStr(String(v)));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return normEpoch(v);
  const t = Date.parse(cleanTimeStr(String(v)));
  if (Number.isFinite(t)) return t;
  return normEpoch(Number(v));
}

/** 从 mapping 节点取一轮(role,text)。兼容两种官方导出形态:
 *  ① DeepSeek:fragments[{type:'REQUEST'|'RESPONSE', content}] —— REQUEST=主人 / RESPONSE=器灵
 *  ② ChatGPT :author.role('user'|'assistant') + content.parts[] */
function turnOfNode(node) {
  const msg = node && typeof node.message === 'object' && node.message ? node.message : null;
  if (!msg) return { role: '', text: '', ts: null };
  const ts = toMs(msg.inserted_at ?? msg.insertedAt ?? msg.create_time ?? msg.createTime ?? msg.time);
  const frags = Array.isArray(msg.fragments) ? msg.fragments : [];
  let role = '';
  const texts = [];
  for (const fr of frags) {
    if (!fr || typeof fr !== 'object') continue;
    if (fr.type === 'REQUEST') role = 'user';
    else if (fr.type === 'RESPONSE') role = 'assistant';
    if (typeof fr.content === 'string' && fr.content.trim() && (fr.type === 'REQUEST' || fr.type === 'RESPONSE')) {
      texts.push(fr.content.trim());
    }
  }
  if (role && texts.length) return { role, text: texts.join('\n'), ts };
  const ar = String((msg.author && msg.author.role) || '').toLowerCase();
  const role2 = ar === 'user' ? 'user' : (ar === 'assistant' ? 'assistant' : '');
  if (role2) {
    const parts = Array.isArray(msg.content && msg.content.parts) ? msg.content.parts : [];
    const text2 = parts.filter((p) => typeof p === 'string' && p.trim()).join('\n').trim();
    if (text2) return { role: role2, text: text2, ts };
  }
  return { role: '', text: '', ts };
}

/**
 * 官方导出:mapping 树 → 有序轮次(REQUEST→user / RESPONSE→assistant;
 * THINK/FILE/SEARCH/TOOL_* 跳过;节点可混合多个 fragment)。
 *
 * S5(2026-09-17 导入诚实化):旧实现只走 `walk('root')`,而 **ChatGPT 的 mapping 根本没有 root 键**
 * (根是 parent 为 null 的随机 uuid 节点)⇒ 真正的 ChatGPT 导出解析出 0 轮却仍报"导入完成"。
 * 现在三级取链:
 *   ① current_node 沿 parent 回溯(主对话链;ChatGPT 有重生成分支,回溯才不会把分支全算进来)
 *   ② root + children 深度优先(DeepSeek 形态)
 *   ③ 兜底:全节点按时间排序(结构异形时至少不丢内容)
 * @returns [{seq,role,ts,text}]
 */
export function turnsFromOfficialMapping(mapping, { currentNode = '' } = {}) {
  const map = mapping && typeof mapping === 'object' ? mapping : {};
  const ids = Object.keys(map);
  const order = [];
  const seen = new Set();
  const push = (id) => {
    const k = String(id);
    if (!k || !map[k] || seen.has(k)) return;
    seen.add(k);
    order.push(k);
  };
  // ① 主链回溯
  const cur = str(currentNode) || str(map.current_node) || str(map.currentNode);
  if (cur && map[cur]) {
    const chain = [];
    let id = cur;
    const guard = new Set();
    while (id && map[id] && !guard.has(id)) {
      guard.add(id);
      chain.push(id);
      id = String(map[id].parent == null ? '' : map[id].parent);
    }
    chain.reverse().forEach(push);
  }
  // ② root + children DFS
  if (!order.length && map.root) {
    const walk = (id) => {
      push(id);
      const node = map[id];
      if (node && Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk('root');
  }
  // ③ 兜底:整表按时间排序
  if (!order.length) {
    const rows = ids.map((id) => ({ id, ts: turnOfNode(map[id]).ts }));
    rows.sort((a, b) => (Number(a.ts || 0) - Number(b.ts || 0)));
    rows.forEach((r) => push(r.id));
  }
  const turns = [];
  let seq = 0;
  for (const id of order) {
    const t = turnOfNode(map[id]);
    if (!t.role || !t.text) continue;
    seq += 1;
    turns.push({ seq, role: t.role, ts: t.ts, text: t.text });
  }
  return turns;
}

/** 规范化一个契约对象 → {ok, row, rawTurns?, degraded?, reason?} */
export function normalizeImportItem(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '非对象条目' };
  const s = raw;
  const title = str(s.title) || str(s.name);
  // S5:补 ChatGPT 原生字段名(create_time/update_time/conversation_id) —— 它们此前不在别名链里,
  // 于是真正的 ChatGPT 导出连时间都拿不到(叠加"秒被当毫秒"→ 落 1970)。
  const started = isoTime(s.inserted_at ?? s.startedAt ?? s.started_at ?? s.insertedAt ?? s.startTime ?? s.time ?? s.create_time ?? s.createTime);
  const updated = isoTime(s.updated_at ?? s.updatedAt ?? s.update_time ?? s.updateTime) || started;
  if (!title && !started && !s.mapping) return { ok: false, reason: '缺标题与时间(至少要有一项)' };

  // messages(完整档);官方导出走 mapping 树
  const rawTurns = [];
  const hasMapping = s.mapping && typeof s.mapping === 'object';
  if (hasMapping) {
    rawTurns.push(...turnsFromOfficialMapping(s.mapping, { currentNode: str(s.current_node ?? s.currentNode) }));
  } else if (Array.isArray(s.messages) && s.messages.length) {
    let seq = 0;
    for (const m of s.messages) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'assistant' || m.role === 'bot' || m.role === 'ai' ? 'assistant'
        : m.role === 'user' || m.role === 'human' ? 'user' : '';
      const text = str(m.text ?? m.content);
      if (!role || !text) continue;
      seq += 1;
      rawTurns.push({ seq, role, ts: toMs(m.at ?? m.ts ?? m.time), text });
    }
  }

  const category = s.category === 'knowledge' || s.category === 'daily' || s.category === 'feeling'
    ? s.category : categorizeTitle(title || (rawTurns.length ? rawTurns[0].text.slice(0, 80) : ''));
  const firstUserText = rawTurns.length ? (rawTurns.find((t) => t.role === 'user')?.text || '') : '';
  // D2(2026-09-17):与 DSH 会话侧共用同一套启发式(剥称呼/问候前缀、句读处收尾),不再硬截 46 字
  const rawOne = (title || firstUserText).replace(/\s+/g, ' ').trim();
  const oneLine = heuristicTitle(rawOne) || rawOne.slice(0, TITLE_MAX_CHARS);
  const finalTitle = oneLine || '(未命名会话)';
  const summary0 = rawTurns.length
    ? (str(s.summary) || `${oneLine.slice(0, 140)} — ${rawTurns.length} 条消息`)
    : str(s.summary);
  const summary = summary0 || `${oneLine.slice(0, 140)}(轻量条目,摘要待深摘补充)`;
  if (!rawTurns.length && !summary && !title) return { ok: false, reason: '既无消息也无摘要,无法成档' };
  // S5(2026-09-17 导入诚实化):「说有内容、却解析不出任何轮次」一律标记 degraded,
  // 且必须覆盖 mapping 分支 —— 旧判定只看 messages 数组,于是 mapping 树解析 0 轮
  // (真正的 ChatGPT 导出 / 导出格式变更)被当成成功,界面显示"✓ 导入完成"而原文一条没进。
  const claimed = (Array.isArray(s.messages) && s.messages.length > 0) || hasMapping;
  const degraded = claimed && !rawTurns.length;
  const degradedReason = degraded
    ? (hasMapping ? 'mapping 树解析出 0 轮(导出格式未识别)' : 'messages 里没有可用的 user/assistant 文本')
    : '';
  const givenKw = Array.isArray(s.keywords) ? s.keywords.map((k) => str(k)).filter(Boolean).slice(0, 20) : [];
  const keywords = givenKw.length
    ? givenKw
    : keywordsFrom((finalTitle + ' ' + (str(s.summary) || firstUserText)).slice(0, 400));

  let id = str(s.id ?? s.convId ?? s.sessionId ?? s.conversation_id ?? s.conversationId);
  if (!id) {
    id = 'auto:' + sha256Text(String(finalTitle) + '|' + String(started || '')).slice(0, 16);
  }
  const row = {
    conv_id: id,
    source: IMPORT_SOURCE,
    title: finalTitle,
    started_at: started,
    updated_at: updated,
    domain_tags: [CAT_NAME[category] || '日常'],
    category,
    keywords,
    summary,
    heat: 0,
    importance: 0,
    last_hit_at: null,
    hit_count: 0,
    overview_ok: 1,
    origin: 'import-file-v1',
  };
  return { ok: true, row, rawTurns, degraded, degradedReason };
}

/**
 * 落库一批(≤500/批,幂等):
 *  - 折叠:同 conv_id 命中 dsweb 旧域(官方导出与历史抓取同源)→ 元数据与原文并入 dsweb,
 *    并移除本域残留副本(避免 L1 双份召回);
 *    ⚠️ A(2026-09-30):折叠**绝不覆盖目标会话已有的原文** —— 详见下面折叠分支的注释与 `foldSkippedRaw`;
 *  - 否则:新行全量 upsert;已存在只刷新 标题/时间/类别/关键词(不动 summary/importance/置顶/热度);
 *  - 完整档 raw 轮次按 (session_id,seq) 覆盖写,重复导入天然幂等。
 * @returns {{ok, newRows, refreshed, folded, removedImport, foldSkippedRaw, accepted, degraded, rejected}}
 */
export async function applyImportItems(memory, items) {
  const rejected = [];
  const stat = { ok: true, accepted: 0, newRows: 0, refreshed: 0, upgraded: 0, folded: 0, removedImport: 0, foldSkippedRaw: 0, degraded: 0, degradedReasons: {} };
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const n = normalizeImportItem(list[i]);
    if (!n.ok) { rejected.push({ i, reason: n.reason }); continue; }
    stat.accepted += 1;
    if (n.degraded) {
      stat.degraded += 1;
      const why = n.degradedReason || '未识别';
      stat.degradedReasons[why] = (Number(stat.degradedReasons[why]) || 0) + 1;
    }
    const id = n.row.conv_id;
    const dswebRow = memory.overviewById('dsweb', id);
    if (dswebRow) {
      // 官方导出/历史抓取同源:并入 dsweb 域(不动其 summary/importance;raw 落到 dsweb conv)
      memory.db.prepare(
        `UPDATE conv_overview SET title=?, started_at=?, updated_at=?, domain_tags=?, category=?, keywords=?, origin=?
         WHERE source='dsweb' AND conv_id=?`,
      ).run(
        n.row.title,
        n.row.started_at ?? dswebRow.started_at,
        n.row.updated_at ?? dswebRow.updated_at,
        JSON.stringify(n.row.domain_tags), n.row.category, JSON.stringify(n.row.keywords),
        n.row.origin, id,
      );
      const impDup = memory.overviewById(IMPORT_SOURCE, id);
      if (impDup) {
        memory.db.prepare("DELETE FROM conv_overview WHERE source=? AND conv_id=?").run(IMPORT_SOURCE, id);
        stat.removedImport += 1;
      }
      stat.folded += 1;
      // 折叠分支的原文归 dsweb 域(裸 id):它本就与 dsweb 抓取同源,G4 的 import 前缀不适用。
      // ── A(2026-09-30,修缺陷「折叠覆盖真原文」)────────────────────────────────
      // 缺陷:旧实现把**导入侧的 seq** 直接 appendRawTurn 进这个 dsweb 会话,而
      //   `dsh_turns_raw` 的主键是 (session_id, seq)、`appendRawTurn` 是
      //   `ON CONFLICT(session_id, seq) DO UPDATE SET text=excluded.text`
      //   ⇒ 折叠侧 seq 从 1 重新数,与目标会话既有轮次**必然同号**,于是目标里的真原文
      //   被逐条静默换成导入副本:**行数不增、内容被换、一个字都不报**(离线测试台 S6d 实测
      //   clobbered=3)。属"会丢数据 + 静默"那一档。
      // 判据(顺序不可调):
      //   ① 目标**一个字原文都没有** ⇒ 照旧写入(这是"把原文补进去"的升级路径,**不许堵死**);
      //   ② 目标已有原文 ⇒ 逐条按 (role,text) 比:
      //        · 完全相同 ⇒ 跳过(幂等:重复导入同一份不报错、也不算丢失);
      //        · 不同     ⇒ **保留现有的**(绝不覆盖),计入 `foldSkippedRaw`。
      //   ⚠️ **不许**"按 max(seq) 往后追加"(同一段对话在库里变成两份 ⇒ 污染 L1 检索),
      //      **也不许**整段替换(那是丢真的方向)。
      //   代价(已留证):目标已有原文且内容不同时,导入侧的这几轮**进不去** —— 这是**故意的**取舍:
      //     宁可少一份副本,不可换掉真原文。它必须**说出来**(foldSkippedRaw → 回执/界面/账本),
      //     静默与丢失同样不可接受。
      // ── A'(2026-09-30 补,G4 裂缝「判据漏了 import 命名空间」)────────────────────
      //   只看写入目标(裸 id)会漏 `import:<id>` 侧:若该会话在 import 命名空间下**已有原文**
      //   (例如先前做过一次普通文件导入),而裸 id 这侧 0 轮,折叠就会把同一段对话**再写一份**
      //   进裸 id ⇒ 库里同一段对话出现两个 session_id、两份原文 —— 正是折叠机制本来要消灭的
      //   「L1 双份召回」。故"已有原文"按**候选链任一侧**判(复用 memory.rawSessionCandidates,
      //   与上方 upgraded 判据同一套口径,不另发明)。
      //   任一侧已有原文 ⇒ 不写裸 id、也不动 `import:` 侧的行;被挡下的轮数照旧计入 foldSkippedRaw。
      //   ⚠️ 这里**不做**数据迁移(把 `import:` 侧原文搬到裸 id):那是另一档风险,留待拍板。
      const targetHasRaw = rawSessionCandidates(IMPORT_SOURCE, id).some((k) => memory.rawTurnCount(k) > 0);
      if (!targetHasRaw) {
        for (const t of n.rawTurns) {
          // v14(2026-10-01)来源列:这里**刻意不给** source,由 appendRawTurn 按 id 形状推导(裸 id ⇒ 'dsh')。
          // 两条理由:① 本分支的写入目标由候选链决定,来源应当与**实际写进去的那个 id**同解(读者的回落
          //   判据就是这个),写死一个常量会在 id 形态变化时与它脱钩;② 折叠进来的原文按现有裁决**仍被
          //   概述器认领**(它落在裸 id 上)—— 若改记成 'dsweb',这些轮次会当场从概述器眼里消失,
          //   那是**越权改裁决**,不属于"加一列"的授权范围(真机库实测该分支 0 行,留作残余风险上报)。
          memory.appendRawTurn(id, { seq: t.seq, role: t.role, ts: t.ts, model: null, text: t.text });
        }
      } else if (n.rawTurns.length) {
        // (role,text) 指纹:JSON 化再比 —— role 与 text 里可能出现分隔符,拼接字符串会误判相同。
        // ── A''(2026-09-30 补,C′ 裂缝「指纹只取写入目标」)─────────────────────────
        //   A' 只把"要不要写"的存在判据扩到了候选链;**逐条比对的指纹**仍只取写入目标(裸 id)
        //   ⇒ 两侧都有原文时,`import:` 侧**已有的同一轮**再次进来会被算成"未替换"
        //   (计数偏大、方向保守:把幂等重复说成丢失)。既然"已有原文"按候选链任一侧判,
        //   指纹集就必须**同一口径** —— 两侧的轮次合起来建集合,否则同一条链上并存两种口径。
        //   ⚠️ 本分支以 `targetHasRaw === true` 进入,里面**一行都不写** ⇒ 这里只让**计数更准**:
        //   不动任何数据、不做迁移(`import:` 侧的行原样留着)。
        const fp = (role, text) => JSON.stringify([String(role), String(text)]);
        const have = new Set();
        for (const k of rawSessionCandidates(IMPORT_SOURCE, id)) {
          for (const r of memory.db.prepare('SELECT role, text FROM dsh_turns_raw WHERE session_id=?').all(k)) {
            have.add(fp(r.role, r.text));
          }
        }
        for (const t of n.rawTurns) {
          if (have.has(fp(t.role, t.text))) continue; // 幂等:同 (role,text) 已在 ⇒ 跳过,不计
          stat.foldSkippedRaw += 1;                   // 不同 ⇒ 保留现有的,只计数(一个字节都不写)
        }
      }
      continue;
    }
    const existed = memory.overviewById(IMPORT_SOURCE, id);
    if (existed) {
      memory.db.prepare(
        `UPDATE conv_overview SET title=?, started_at=?, updated_at=?, domain_tags=?, category=?, keywords=?,
           overview_ok=1, origin=? WHERE source=? AND conv_id=?`,
      ).run(
        n.row.title,
        n.row.started_at ?? existed.started_at,
        n.row.updated_at ?? existed.updated_at,
        JSON.stringify(n.row.domain_tags), n.row.category, JSON.stringify(n.row.keywords),
        n.row.origin, IMPORT_SOURCE, id,
      );
      stat.refreshed += 1;
      // 轻量行升级为完整档:本次带来原文而原行没有 raw → 记为「补全原文」
      // (G4:原文落在 import 命名空间,旧数据是裸 id —— 候选链任一有行即算已有原文)
      if (n.rawTurns.length && !rawSessionCandidates(IMPORT_SOURCE, id).some((k) => memory.rawTurnCount(k) > 0)) stat.upgraded += 1;
    } else {
      memory.upsertOverview(n.row);
      stat.newRows += 1;
    }
    // G4(2026-09-17):导入原文落 'import:<id>' 命名空间 —— 与 DSH 会话原文物理隔离。
    // 否则概述器(GROUP BY session_id)会把它当成 DSH 会话重建(跨源双份),同 id 时还会互相覆盖原文。
    // 写入侧坐实(2026-10-01 grep):本文件的实际来源命名空间 = `IMPORT_SOURCE`('import'),
    //   落成的 id = `rawSessionId(IMPORT_SOURCE, id)` = `import:<id>` ⇒ v14 的 source 列记 'import'。
    const rawId = rawSessionId(IMPORT_SOURCE, id);
    for (const t of n.rawTurns) {
      memory.appendRawTurn(rawId, { seq: t.seq, role: t.role, ts: t.ts, model: null, text: t.text, source: IMPORT_SOURCE });
    }
  }
  return { ok: true, ...stat, rejected };
}
