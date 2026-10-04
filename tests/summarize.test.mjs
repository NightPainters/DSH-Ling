// summarizer 单元测试(临时库:建原始轮次 → 概述 → 幂等 → 增量)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');

const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-sum-'));
const db = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 两个会话:一个有实质对话;一个只有单条短消息(应跳过)
db.appendRawTurn('sess-real', { seq: 1, role: 'user', ts: '2026-09-06T10:00:00Z', model: null, text: '帮我优化材料串联落地模拟的代码' });
db.appendRawTurn('sess-real', { seq: 2, role: 'assistant', ts: '2026-09-06T10:00:10Z', model: null, text: '已优化:引入速度Verlet' });
db.appendRawTurn('sess-real', { seq: 3, role: 'user', ts: '2026-09-06T10:01:00Z', model: null, text: '阻尼参数再加一个滑杆' });
db.appendRawTurn('sess-real', { seq: 4, role: 'assistant', ts: '2026-09-06T10:01:20Z', model: null, text: '好的,已加' });
db.appendRawTurn('sess-tiny', { seq: 1, role: 'user', ts: '2026-09-06T10:02:00Z', model: null, text: 'hi' });

const st1 = summarizeDsh(db);
check(st1.created === 1, '仅实质会话成概述,实际 created=' + st1.created);
const row = db.overviewById('dsh', 'sess-real');
check(row && row.title.includes('材料串联'), '标题来自首问: ' + (row && row.title));
check(row && row.category === 'knowledge', '类别=knowledge: ' + (row && row.category));
check(row && row.summary.includes('4 条消息'), '摘要含轮次: ' + (row && row.summary));
check(row && row.overview_ok === true && row.source === 'dsh', 'source=dsh & ok');

const st2 = summarizeDsh(db);
check(st2.skipped === 2 && st2.created === 0, '幂等:二次全跳过, skipped=' + st2.skipped);

// 新增轮次 → 只重建该会话
db.appendRawTurn('sess-real', { seq: 5, role: 'assistant', ts: '2026-09-06T10:03:00Z', model: null, text: '又聊了一句' });
const st3 = summarizeDsh(db);
check(st3.updated === 1, '增量更新 1 个, updated=' + st3.updated);
const row2 = db.overviewById('dsh', 'sess-real');
check(row2.summary.includes('5 条消息'), '摘要轮次更新为 5');

// 已深摘会话:增量刷新不覆盖深摘要
db.kvSet('deep:sess-real', 'done:2026-09-07T00:00:00Z');
const deepSum = '主旨:深摘要内容保留测试';
db.upsertOverview({ ...db.overviewById('dsh', 'sess-real'), summary: deepSum });
db.appendRawTurn('sess-real', { seq: 6, role: 'assistant', ts: '2026-09-06T10:04:00Z', model: null, text: '再聊一句' });
const st4 = summarizeDsh(db);
check(st4.updated === 1, '深摘后增量仍更新日期, updated=' + st4.updated);
check(db.overviewById('dsh', 'sess-real').summary === deepSum, '深摘要未被浅版覆盖');

// ---- G2(2026-09-17):概述重建不得清零"本机用户态字段"(置顶/命中/热度) ----
// 旧行为:概述器每轮 upsert 都写 heat=0/importance=0/hit_count=0 且 UPSERT 无条件覆盖 ⇒
// 置顶的删除保护(cleanOverviewOnArchive 的 importance>=1)与热度排序双双失效。
db.setImportance('dsh', 'sess-real', 1);
db.bumpHit('dsh', 'sess-real');
const g2a = db.overviewById('dsh', 'sess-real');
check(g2a.importance === 1 && g2a.hit_count === 1 && !!g2a.last_hit_at, 'G2 前置:置顶/命中已落库');
db.appendRawTurn('sess-real', { seq: 7, role: 'assistant', ts: '2026-09-06T10:05:00Z', model: null, text: '第七句' });
summarizeDsh(db);
const g2b = db.overviewById('dsh', 'sess-real');
check(g2b.importance === 1, 'G2:概述重建后置顶保留(实际 importance=' + g2b.importance + ')');
check(g2b.hit_count === 1, 'G2:概述重建后命中次数保留(实际 hit_count=' + g2b.hit_count + ')');
check(!!g2b.last_hit_at, 'G2:概述重建后 last_hit_at 保留');
// 反证:普通字段仍随增量刷新(用一个未深摘的新会话,避免撞上"深摘要不被浅版覆盖"的既有保护)
db.appendRawTurn('sess-g2', { seq: 1, role: 'user', ts: '2026-09-06T11:00:00Z', model: null, text: '新会话首问:这段文本要足够长,以便通过概述器的最小字符数门槛(MIN_CHARS=40),确保它会真的被概述' });
db.appendRawTurn('sess-g2', { seq: 2, role: 'assistant', ts: '2026-09-06T11:00:10Z', model: null, text: '收到,这是一条回复' });
summarizeDsh(db);
const g2s = db.overviewById('dsh', 'sess-g2');
check(g2s && g2s.summary.includes('2 条消息'), 'G2 反证:非用户态字段仍随增量刷新(summary=' + (g2s && g2s.summary) + ')');
// 新行仍按调用方给的初值落库(keep 保护只作用于 UPDATE 分支)
db.upsertOverview({ conv_id: 'sess-fresh', source: 'dsh', title: 't', importance: 1, hit_count: 3 });
const g2c = db.overviewById('dsh', 'sess-fresh');
check(g2c && g2c.importance === 1 && g2c.hit_count === 3, 'G2:新行 INSERT 分支不受影响');
// 显式整行覆盖(仅"按备份原样恢复"类场景使用)
db.upsertOverview({ ...g2b, keepUserState: false, importance: 0, hit_count: 0, last_hit_at: null });
check(db.overviewById('dsh', 'sess-real').importance === 0, 'G2:keepUserState:false 时允许整行覆盖');

// ---- G4(2026-09-17):导入原文落 'import:' 命名空间,DSH 概述器不得认领 ----
// 旧行为:导入原文写进 dsh_turns_raw 的裸 id ⇒ GROUP BY session_id 把它当成 DSH 会话重建一份
// source='dsh' 的概述(跨源双份召回),P0-8 的 15 条污染即由此而来。
db.appendRawTurn('import:uuid-import-1', { seq: 1, role: 'user', ts: '2026-09-07T10:00:00Z', model: null, text: '这是一段从别的平台导入的对话原文,长度超过概述器最小字符数门槛才会被考虑' });
db.appendRawTurn('import:uuid-import-1', { seq: 2, role: 'assistant', ts: '2026-09-07T10:00:10Z', model: null, text: '导入的回复' });
const st5 = summarizeDsh(db);
check(!db.overviewById('dsh', 'import:uuid-import-1'), 'G4:导入原文不被概述器认领(无 dsh 概述行)');
check(!db.overviewById('dsh', 'uuid-import-1'), 'G4:裸 id 也不成概述(不误伤正常会话)');
check(st5.sessions === 3, 'G4:概述器会话集不含导入命名空间(应为本库 3 个真实会话,实得 ' + st5.sessions + ')');

// ── E2(2026-10-01):黑名单免检 → 正向白名单(判据唯一一处定义)+ 未知来源 kv 告警 ──────────
// 旧写法是**黑名单**:把「已知的那一个外来命名空间(`import:` 前缀)」排除掉,其余**全部**当真
// DSH 会话 ⇒ 任何没见过的来源都会被概述器当成主人的会话重建、被习惯生成当成主人的纠正信号。
// 审计原话:「最该被质疑的内容带着最真诚的标记」。新判据反过来:只有明确落在 DSH 宿主命名空间
// 里的裸 id 入选;未知前缀一律排除**并**写一条 kv 告警(否则只是把"被误信"换成"被静默丢弃")。
const { readFileSync, readdirSync } = await import('node:fs');
const {
  isDshSessionId, dshSessionSql, rawNamespaceOf, RAW_UNKNOWN_NS_KEY,
  DSH_RAW_NAMESPACE, KNOWN_FOREIGN_RAW_NAMESPACES, RAW_NS_SEP,
} = await imp('lib/host/summarizer.js');

// ① 负对照:只放真 DSH 会话的库 ⇒ 修后结果与**修前实测**逐字一致(golden 于 2026-10-01 修前采集)
const e2a = new MemoryStore(join(dir, 'e2a.db'));
e2a.appendRawTurn('sess-real', { seq: 1, role: 'user', ts: '2026-09-06T10:00:00Z', model: null, text: '帮我优化材料串联落地模拟的代码' });
e2a.appendRawTurn('sess-real', { seq: 2, role: 'assistant', ts: '2026-09-06T10:00:10Z', model: null, text: '已优化:引入速度Verlet' });
e2a.appendRawTurn('sess-real', { seq: 3, role: 'user', ts: '2026-09-06T10:01:00Z', model: null, text: '阻尼参数再加一个滑杆' });
e2a.appendRawTurn('sess-real', { seq: 4, role: 'assistant', ts: '2026-09-06T10:01:20Z', model: null, text: '好的,已加' });
e2a.appendRawTurn('sess-tiny', { seq: 1, role: 'user', ts: '2026-09-06T10:02:00Z', model: null, text: 'hi' });
const stE2a = summarizeDsh(e2a);
const E2_GOLD_STATS = '{"sessions":2,"created":1,"updated":0,"skipped":1,"watermarkSet":2,"archivedSkipped":0}';
check(JSON.stringify(stE2a) === E2_GOLD_STATS, 'E2①:白名单内会话的 stats 与修前逐字一致(实际 ' + JSON.stringify(stE2a) + ')');
// 用 String.raw:golden 里带 JSON 转义的反斜杠(`[\"知识\"]`),普通引号字符串会把 \" 吃成 " ⇒ 假红
const E2_GOLD_ROWS = String.raw`[{"conv_id":"sess-real","source":"dsh","title":"帮我优化材料串联落地模拟的代码","started_at":"2026-09-06T10:00:00.000Z","updated_at":"2026-09-06T10:01:20.000Z","domain_tags":"[\"知识\"]","category":"knowledge","keywords":"[\"帮我优化\",\"优化材料\",\"材料串联\",\"串联落地\",\"落地模拟\",\"模拟的代\",\"帮我优化材料\"]","summary":"帮我优化材料串联落地模拟的代码 — 4 条消息","heat":0,"importance":0,"last_hit_at":null,"hit_count":0,"overview_ok":1,"origin":"dsh-summarizer-v1","title_locked":0,"title_by":""}]`;
const e2rows = e2a.db.prepare('SELECT * FROM conv_overview ORDER BY source, conv_id').all();
check(JSON.stringify(e2rows) === E2_GOLD_ROWS, 'E2①:概述行(标题/类别/关键词/摘要/来源)与修前逐字一致(实际 ' + JSON.stringify(e2rows) + ')');
const e2kv = e2a.db.prepare('SELECT key, value FROM kv ORDER BY key').all()
  .map((r) => ({ key: r.key, value: (r.key === 'memory_version' || r.key === 'schema_version') ? '<v>' : r.value }));
check(JSON.stringify(e2kv) === '[{"key":"memory_version","value":"<v>"},{"key":"schema_version","value":"<v>"},{"key":"sumdsh:sess-real","value":"4"},{"key":"sumdsh:sess-tiny","value":"1"}]',
  'E2①:干净库下 kv 键集合不变(未凭空多出告警键),实际 ' + JSON.stringify(e2kv));

// 判据两形态必须同解(JS 形态与 SQL 形态同源):SQL 用绑定参数跑 instr(?, ':') = 0
const verdictSql = (id) => Number(e2a.db.prepare(`SELECT ${dshSessionSql('?')} AS ok`).get(id)?.ok) === 1;
for (const id of ['sess-real', 'own-1', 'import:x', 'weird:y', 'vein:z', 'a:b:c', '中文会话']) {
  check(verdictSql(id) === isDshSessionId(id), `E2:判据两形态同解(${id}: SQL=${verdictSql(id)} JS=${isDshSessionId(id)})`);
}
check(DSH_RAW_NAMESPACE === '' && RAW_NS_SEP === ':' && KNOWN_FOREIGN_RAW_NAMESPACES.includes('import:'), 'E2:白名单/外来命名空间常量就位');
check(rawNamespaceOf('import:x') === 'import:' && rawNamespaceOf('weird:y') === 'weird:' && rawNamespaceOf('own-1') === DSH_RAW_NAMESPACE, 'E2:命名空间前缀解析');

// ② `import:`(已知外来)照旧被排除,且**不算**未知来源 ⇒ 不写告警
const e2b = new MemoryStore(join(dir, 'e2b.db'));
e2b.appendRawTurn('own-e2', { seq: 1, role: 'user', ts: '2026-09-07T10:00:00Z', model: null, text: '主人自己的会话:这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)校验' });
e2b.appendRawTurn('own-e2', { seq: 2, role: 'assistant', ts: '2026-09-07T10:00:10Z', model: null, text: '回复' });
e2b.appendRawTurn('import:uuid-e2', { seq: 1, role: 'user', ts: '2026-09-07T10:01:00Z', model: null, text: '这是一段从别的平台导入的对话原文,长度超过概述器最小字符数门槛才会被考虑' });
e2b.appendRawTurn('import:uuid-e2', { seq: 2, role: 'assistant', ts: '2026-09-07T10:01:10Z', model: null, text: '导入的回复' });
const stE2b = summarizeDsh(e2b);
check(stE2b.sessions === 1, 'E2②:import: 不进会话集(实际 sessions=' + stE2b.sessions + ')');
check(!e2b.overviewById('dsh', 'import:uuid-e2') && !e2b.overviewById('dsh', 'uuid-e2'), 'E2②:导入原文不被认领(带前缀与裸 id 都不成概述)');
check(!!e2b.overviewById('dsh', 'own-e2'), 'E2②:同一库里主人自己的会话照旧成概述(不是"一刀切不概述")');
check(e2b.kvGet(RAW_UNKNOWN_NS_KEY) === undefined, 'E2②:已知外来命名空间不触发"未知来源"告警(不误报)');

// ③ 未知前缀(自造 `weird:%`)⇒ 排除 **且** 留证:kv 告警能让人发现"有东西进来了"
const e2c = new MemoryStore(join(dir, 'e2c.db'));
e2c.appendRawTurn('own-e2c', { seq: 1, role: 'user', ts: '2026-09-08T10:00:00Z', model: null, text: '主人自己的会话:这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)校验' });
e2c.appendRawTurn('own-e2c', { seq: 2, role: 'assistant', ts: '2026-09-08T10:00:10Z', model: null, text: '回复' });
e2c.appendRawTurn('weird:uuid-e2', { seq: 1, role: 'user', ts: '2026-09-08T10:01:00Z', model: null, text: '某个将来才会出现的新来源:长度同样超过最小字符数门槛' });
e2c.appendRawTurn('weird:uuid-e2', { seq: 2, role: 'assistant', ts: '2026-09-08T10:01:10Z', model: null, text: '新来源的回复' });
const stE2c = summarizeDsh(e2c);
check(stE2c.sessions === 1, 'E2③:未知前缀不进会话集(实际 sessions=' + stE2c.sessions + ')');
check(!e2c.overviewById('dsh', 'weird:uuid-e2') && !e2c.overviewById('dsh', 'uuid-e2'), 'E2③:未知前缀不被当成 DSH 会话重建(旧黑名单会认领它)');
check(!!e2c.overviewById('dsh', 'own-e2c'), 'E2③:未知来源在场时,白名单内的会话照旧被处理');
const rawAlarm = e2c.kvGet(RAW_UNKNOWN_NS_KEY);
check(typeof rawAlarm === 'string' && rawAlarm.length > 0, 'E2③:未知来源必须留证 —— kv 告警已写(' + RAW_UNKNOWN_NS_KEY + ')');
let alarm = null; try { alarm = JSON.parse(String(rawAlarm)); } catch { alarm = null; }
check(!!alarm && !!alarm.namespaces && !!alarm.namespaces['weird:'], 'E2③:告警点名了未知命名空间 weird:');
check(!!alarm && (alarm.namespaces['weird:']?.samples || []).includes('weird:uuid-e2'), 'E2③:告警带样本 id(人能认出"进来的是什么")');
check(!!alarm && Number(alarm.namespaces['weird:']?.turns) === 2, 'E2③:告警记了条数(实际 ' + (alarm && alarm.namespaces['weird:']?.turns) + ')');
check(!!alarm && !alarm.namespaces['import:'] && !alarm.namespaces[''], 'E2③:告警只记未知来源(白名单与已知外来都不入告警)');
check(!!alarm && /未知来源|排除/.test(String(alarm.note || '')), 'E2③:告警带人读说明(为什么记它)');
check(!!alarm && !!alarm.namespaces['weird:']?.firstSeenAt && !!alarm.namespaces['weird:']?.lastSeenAt, 'E2③:告警有首次/最近时间');

// ── V2 源码护栏:旧黑名单写法(4 处)必须消失,且正向判据全包只有一处定义 ──────────────
const walkJs = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walkJs(join(d, e.name)) : (e.name.endsWith('.js') ? [join(d, e.name)] : [])));
const libFiles = walkJs(join(root, 'lib'));
const src = (p) => readFileSync(p, 'utf8');
const sumSrc = src(join(root, 'lib/host/summarizer.js'));
const habSrc = src(join(root, 'lib/host/habit-gen.js'));
const OLD_CLAUSE = "session_id NOT LIKE 'import:%'";
check(!sumSrc.includes(OLD_CLAUSE) && !habSrc.includes(OLD_CLAUSE), 'V2:两文件都不再含旧写法 ' + OLD_CLAUSE);
check(!/NOT LIKE/.test(sumSrc) && !/NOT LIKE/.test(habSrc), 'V2:两文件不再出现任何 NOT LIKE 式范围判据(旧 4 处:summarizer:20 与 habit-gen:39/152/157)');
const oldLeft = libFiles.filter((f) => src(f).includes(OLD_CLAUSE)).map((f) => f.slice(root.length + 1));
check(oldLeft.length === 0, 'V2:全包范围内旧写法清零(残留 ' + JSON.stringify(oldLeft) + ')');
const defSites = libFiles.filter((f) => /export\s+function\s+dshSessionSql\s*\(/.test(src(f))).map((f) => f.slice(root.length + 1));
check(defSites.length === 1 && defSites[0].endsWith('summarizer.js'), 'V2:正向判据(SQL 形态)全包唯一一处定义:' + JSON.stringify(defSites));
const alarmDefs = libFiles.filter((f) => /export\s+const\s+RAW_UNKNOWN_NS_KEY\s*=/.test(src(f))).map((f) => f.slice(root.length + 1));
check(alarmDefs.length === 1, 'V2:告警键也只有一个定义处:' + JSON.stringify(alarmDefs));
const uses = (s) => (s.match(/\$\{dshSessionSql\(\)\}/g) || []).length;
check(uses(sumSrc) === 1 && uses(habSrc) === 3, 'V2:4 处调用点全部经同一 helper(实际 summarizer=' + uses(sumSrc) + ' habit-gen=' + uses(habSrc) + ')');
check(/from '\.\/summarizer\.js'/.test(habSrc), 'V2:habit-gen 复用 summarizer 的那一份判据,不另写一份');
check(/noteUnknownRawNamespaces\(memory, 'summarizer\.summarizeDsh'\)/.test(sumSrc)
  && /noteUnknownRawNamespaces\(memory, 'habit-gen\.scanCorrections'\)/.test(habSrc)
  && /noteUnknownRawNamespaces\(memory, 'habit-gen\.buildReflectMaterial'\)/.test(habSrc), 'V2:四条查询的入口都先留证未知来源');

// ── E3(2026-10-01,主人拍板「来源也加个列吧」):来源从**推断**变**记录** ─────────────────────
// E2 的边界写在上面第 31-32 行:「将来若出现**不带前缀**的新来源,判据无法分辨」。加 `source` 列之后
// 分得出来了 —— 下面 ③ 就是"不带冒号、只有 source 列能认出它"的那一类。三件事须同时成立:
//   ① source 非空的行**只认 source**(='dsh' 才入选,与 id 文本长什么样无关);
//   ② source 为空的行**回落旧"裸 id"判据**(半迁移:同一份库里不许出现两种行为);
//   ③ 判据两形态(JS / SQL)对 (id, source) **同解** —— 任一形态改动都要在这里对账。
const { rawSourceOf, RAW_SOURCE_DSH, normalizeRawSource } = await imp('lib/host/memory.js');
const { isDshRawRow } = await imp('lib/host/summarizer.js');

// ③-a 列就位:纯增列(列尾、可空),主键 (session_id,seq) 未动 ⇒ 既有按列名读法全不受影响
const rawCols = e2a.db.prepare('PRAGMA table_info(dsh_turns_raw)').all();
check(rawCols.some((c) => c.name === 'source' && String(c.type).toUpperCase() === 'TEXT' && Number(c.notnull) === 0),
  'E3:source 列就位(TEXT,可空),实际=' + JSON.stringify(rawCols.map((c) => `${c.name}:${c.type}:notnull=${c.notnull}`)));
check(rawCols.length === 7 && rawCols[6].name === 'source' && rawCols[0].pk === 1 && rawCols[1].pk === 2,
  'E3:列尾追加 + 主键仍是 (session_id,seq),实际末列=' + rawCols[rawCols.length - 1].name);
check(String(e2a.kvGet('schema_version')) === '17', 'E3:schema_version=17(实际 ' + e2a.kvGet('schema_version') + ')');
check(e2a.kvGet('dbg.raw_source_col') === undefined,
  'E3:迁移**成功路径零 kv 写入**(诊断键只在迁移失败时出现 —— 干净库的 kv 键集合因此不变,实际='
  + String(e2a.kvGet('dbg.raw_source_col')) + ')');

// ② 半迁移的真实形态:老行是"INSERT 不带 source"写进去的 ⇒ NULL ⇒ 回落旧判据(与修前一致)
e2a.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('legacy-bare',1,'user',NULL,NULL,'老行(无 source)')").run();
check(Number(e2a.db.prepare("SELECT COUNT(*) n FROM dsh_turns_raw WHERE session_id='legacy-bare' AND source IS NULL").get().n) === 1,
  'E3:前置:造出一条 source IS NULL 的老行(模拟迁移前的行)');
const judgeRowSql = (id) => Number(e2a.db.prepare(`SELECT ${dshSessionSql()} AS ok FROM dsh_turns_raw WHERE session_id=? LIMIT 1`).get(id)?.ok) === 1;
check(judgeRowSql('legacy-bare') === true && isDshRawRow('legacy-bare', null) === true,
  'E3②:半迁移(列空)回落旧"裸 id"判据 ⇒ 照旧入内(两形态一致)');

// ③-b 写入侧如实:不传 source ⇒ 按 id 推导;传了 ⇒ 按传的记(裸 id 也能记成别的来源)
const e3w = new MemoryStore(join(dir, 'e3w.db'));
e3w.appendRawTurn('bare-w', { seq: 1, role: 'user', ts: null, model: null, text: '裸 id 会话' });
e3w.appendRawTurn('import:imp-w', { seq: 1, role: 'user', ts: null, model: null, text: '导入命名空间' });
e3w.appendRawTurn('weird:uuid-w', { seq: 1, role: 'user', ts: null, model: null, text: '未知前缀' });
e3w.appendRawTurn('weird-bare-w', { seq: 1, role: 'user', ts: null, model: null, text: '不带冒号的未知来源', source: 'weird-x' });
const srcOf = (sid) => e3w.db.prepare('SELECT source FROM dsh_turns_raw WHERE session_id=?').get(sid)?.source ?? null;
check(srcOf('bare-w') === 'dsh' && srcOf('import:imp-w') === 'import' && srcOf('weird:uuid-w') === 'weird' && srcOf('weird-bare-w') === 'weird-x',
  'E3:写入侧如实(裸⇒dsh / import⇒import / 未知前缀⇒去尾冒号 / 显式⇒按传的),实得 '
  + JSON.stringify([srcOf('bare-w'), srcOf('import:imp-w'), srcOf('weird:uuid-w'), srcOf('weird-bare-w')]));
check(rawSourceOf('bare-w') === RAW_SOURCE_DSH && rawSourceOf('import:imp-w') === 'import' && normalizeRawSource('  import: ') === 'import:',
  'E3:缺省推导 + 归一(只 TRIM —— 读侧 SQL 形态没有别的归一动作,两形态才不会分岔)');

// ③-c 整行判据矩阵:source 非空只认 source;source 空回落裸 id;两形态同解
const JUDGE_MATRIX = [
  ['bare-1', 'dsh', true], ['bare-1', null, true], ['bare-1', 'weird-x', false], ['bare-1', 'import', false],
  ['import:x', 'import', false], ['import:x', null, false], ['import:x', 'dsh', true],
  ['weird-bare', null, true], ['weird-bare', 'weird-x', false], ['weird:x', 'weird', false],
];
for (const [id, source, want] of JUDGE_MATRIX) {
  const got = isDshRawRow(id, source);
  check(got === want, `E3:整行判据 ${JSON.stringify([id, source])} ⇒ ${got}(期望 ${want})`);
  const rowSql = Number(e2a.db.prepare(`SELECT ${dshSessionSql()} AS ok FROM (SELECT ? AS session_id, ? AS source)`).get(id, source)?.ok) === 1;
  check(rowSql === want, `E3:SQL 形态同解 ${JSON.stringify([id, source])} ⇒ ${rowSql}(期望 ${want})`);
}
// ⚠️ 空 id 的两形态差异**修前就有**(`instr('', ':') = 0` 为真,而 `isDshSessionId('')` 为假):本次只加列,
//    不"顺手统一"它(那会改掉既有断言钉着的 id 纯函数形态)。这里把它显式记下来,不混进上面的同解矩阵。
check(isDshSessionId('') === false && Number(e2a.db.prepare(`SELECT ${dshSessionSql('?')} AS ok`).get('')?.ok) === 1,
  'E3:空 id 两形态差异是既有事实(本次未扩大也未修)');

// ③-d V3/V4 端到端:同一库里 显式 dsh / 推导 dsh / 半迁移 NULL / 不带冒号的未知来源 四类行一起跑
const e3f = new MemoryStore(join(dir, 'e3f.db'));
e3f.appendRawTurn('own-e3f', { seq: 1, role: 'user', ts: '2026-10-01T09:00:00Z', model: null, text: '主人自己的会话(推导来源):这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)' });
e3f.appendRawTurn('own-e3f', { seq: 2, role: 'assistant', ts: '2026-10-01T09:00:10Z', model: null, text: '回复' });
e3f.appendRawTurn('own-e3f2', { seq: 1, role: 'user', ts: '2026-10-01T09:01:00Z', model: null, text: '显式记 source=dsh 的会话:这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)', source: 'dsh' });
e3f.appendRawTurn('own-e3f2', { seq: 2, role: 'assistant', ts: '2026-10-01T09:01:10Z', model: null, text: '回复' });
// 半迁移老行:直接 INSERT(不写 source)⇒ NULL
e3f.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('legacy-e3f',1,'user','2026-10-01T09:02:00Z',NULL,?)")
  .run('半迁移老行(无 source):这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)');
e3f.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('legacy-e3f',2,'assistant','2026-10-01T09:02:10Z',NULL,'回复')").run();
// 不带冒号的未知来源:只有 source 列认得出它
e3f.appendRawTurn('weird-bare-1', { seq: 1, role: 'user', ts: '2026-10-01T09:03:00Z', model: null, text: '别的来源的对话:这段文本要足够长,以便通过概述器的最小字符数门槛(≥40 字)', source: 'weird-x' });
e3f.appendRawTurn('weird-bare-1', { seq: 2, role: 'assistant', ts: '2026-10-01T09:03:10Z', model: null, text: '回复', source: 'weird-x' });
const stE3f = summarizeDsh(e3f);
check(stE3f.sessions === 3, 'E3①:会话集 = 3(显式 dsh + 推导 dsh + 半迁移 NULL 回落入内;weird-x 出),实际 ' + stE3f.sessions);
check(!!e3f.overviewById('dsh', 'own-e3f') && !!e3f.overviewById('dsh', 'own-e3f2') && !!e3f.overviewById('dsh', 'legacy-e3f'),
  'E3①:source=dsh(显式/推导)与半迁移 NULL 三类行**照旧**被处理');
check(!e3f.overviewById('dsh', 'weird-bare-1'), 'E3③:不带冒号的未知来源没被当成 DSH 会话重建 —— 这一条正是本次加列的意义(旧判据:裸 id ⇒ 主人的会话)');
let a3 = null; try { a3 = JSON.parse(String(e3f.kvGet(RAW_UNKNOWN_NS_KEY) || '')); } catch { a3 = null; }
check(!!a3?.namespaces?.['weird-x'], 'E3③:告警点名**记录下来的来源名** weird-x(实际键=' + JSON.stringify(Object.keys(a3?.namespaces || {})) + ')');
check(a3?.namespaces?.['weird-x']?.by === 'source' && a3?.namespaces?.['weird-x']?.source === 'weird-x'
  && Number(a3?.namespaces?.['weird-x']?.turns) === 2 && (a3?.namespaces?.['weird-x']?.samples || []).includes('weird-bare-1'),
  'E3③:告警说清"这个来源名"及其来路(by=source ⇒ 不是靠 id 前缀猜的),条目=' + JSON.stringify(a3?.namespaces?.['weird-x']));
check(!a3?.namespaces?.[''] && !a3?.namespaces?.['import:'] && !a3?.namespaces?.['dsh'],
  'E3:白名单(source=dsh)、半迁移回落的裸 id、已知外来都不入告警(不误报),实际键=' + JSON.stringify(Object.keys(a3?.namespaces || {})));

// ③-e 缺省推导与回填工具的"同解"前提:fallback 行的判据结果 === 回填后的判据结果(逐行对账)
const e3g = new MemoryStore(join(dir, 'e3g.db'));
e3g.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('bare-g',1,'user',NULL,NULL,'x')").run();
e3g.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('import:g',1,'user',NULL,NULL,'y')").run();
e3g.db.prepare("INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES ('weird:g',1,'user',NULL,NULL,'z')").run();
const beforeG = e3g.db.prepare(`SELECT session_id, ${dshSessionSql()} AS ok FROM dsh_turns_raw ORDER BY session_id`).all();
const bf = e3g.backfillRawSource();
const afterG = e3g.db.prepare(`SELECT session_id, ${dshSessionSql()} AS ok FROM dsh_turns_raw ORDER BY session_id`).all();
check(bf.filled === 3 && bf.bySource && bf.bySource.dsh === 1 && bf.bySource.import === 1 && bf.bySource.weird === 1,
  'E3:回填按来源汇报条数,实际 ' + JSON.stringify(bf));
check(bf.unresolved === 0, 'E3:回填后没有仍推不出来源的行(实际 unresolved=' + bf.unresolved + ')');
check(JSON.stringify(beforeG) === JSON.stringify(afterG), 'E3:回填**不改变任何一行的裁决**(逐行对账逐字一致):' + JSON.stringify(afterG.map((r) => [r.session_id, r.ok])));
const bf2 = e3g.backfillRawSource();
check(bf2.filled === 0 && bf2.scanned === 0, 'E3:回填幂等(第二遍零行可填),实际 ' + JSON.stringify(bf2));
check(String(e3g.db.prepare("SELECT source FROM dsh_turns_raw WHERE session_id='bare-g'").get().source) === 'dsh'
  && String(e3g.db.prepare("SELECT source FROM dsh_turns_raw WHERE session_id='import:g'").get().source) === 'import',
  'E3:回填值 = 裸 id⇒dsh / 前缀⇒去尾冒号');

// ── E4(2026-10-01,发布阻断项回归守卫):迁移诊断**永不阻断构造** ─────────────────────────
// 背景(红队实测,同一份忠实 v13 库):`source` 列迁移自证失败时裸调 kvSet,而 kvSet 裸调 `this._kvSet.run()`
// ⇒ 库只读(SQLITE_READONLY)/被写锁(SQLITE_BUSY)时**这一笔必抛**,异常一路冒到 lib/index.js 的 apply()
// ⇒ 整个插件加载失败;于是那条"为迁移失败准备的降级路径"(else 分支 + 读侧回落裸 id 判据)反而永远走不到。
// 三组断言:①只读库 ⇒ 构造成功 + 有可观测降级信号;②写锁库 ⇒ 构造成功(不空等 busy_timeout);
// ③负对照(可写库)⇒ 迁移成功、行为不变、dbg 键**不写**(既有的干净库 kv 键集合断言继续钉着)。
// 库形态「忠实 v13」= 先用当前代码建全库,再 `ALTER TABLE dsh_turns_raw DROP COLUMN source` 并把 kv 的
// schema_version 退回 '13' —— 与真机上"只差这一列"的老库同构(纯增列,没有别的结构差异)。
const { DatabaseSync } = await import('node:sqlite');
const { chmodSync, existsSync } = await import('node:fs');
const makeV13 = (name) => {
  const p = join(dir, name);
  const s = new MemoryStore(p);
  s.appendRawTurn('keep-me', { seq: 1, role: 'user', ts: '2026-10-01T09:00:00Z', model: null, text: '老库里的原文' });
  s.kvSet('schema_version', '13');
  s.close();
  const d = new DatabaseSync(p);
  d.exec('ALTER TABLE dsh_turns_raw DROP COLUMN source');
  d.exec("UPDATE kv SET value='13' WHERE key='schema_version'");
  const cols = d.prepare('PRAGMA table_info(dsh_turns_raw)').all().map((c) => c.name);
  const ver = d.prepare("SELECT value FROM kv WHERE key='schema_version'").get()?.value;
  d.close();
  check(cols.length === 6 && !cols.includes('source') && String(ver) === '13',
    'E4 前置:忠实 v13 库(6 列、无 source、schema_version=13),实际 ' + JSON.stringify([cols, ver]));
  return p;
};
const tryConstruct = (p) => {
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => { warns.push(a.map((x) => String(x)).join(' ')); };
  let m = null; let err = null;
  try { m = new MemoryStore(p); } catch (e) { err = String(e?.message ?? e).slice(0, 200); } finally { console.warn = orig; }
  return { m, err, warns };
};

// ① 库**只读**(OS 级只读属性:SQLITE_READONLY 在打开后落到每一笔写上 —— 这是构造器唯一会遇到的"写不进去"形态)
{
  const p = makeV13('e4-ro.db');
  // 留一个连接开着,让 -wal/-shm 在位(否则 WAL 库只读打开会先退化成"打不开",测不到本回归)
  const holder = new DatabaseSync(p);
  holder.exec('PRAGMA journal_mode=WAL;');
  holder.prepare('SELECT COUNT(*) n FROM kv').get();
  for (const f of [p, p + '-wal', p + '-shm']) if (existsSync(f)) chmodSync(f, 0o444);
  const r = tryConstruct(p);
  const dbg = holder.prepare("SELECT value FROM kv WHERE key='dbg.raw_source_col'").get()?.value ?? null;
  holder.close();
  for (const f of [p, p + '-wal', p + '-shm']) if (existsSync(f)) { try { chmodSync(f, 0o666); } catch {} }
  check(r.err === null, 'E4①:库只读时构造**不抛**(修前抛 attempt to write a readonly database,实际 ' + r.err + ')');
  check(r.m !== null, 'E4①:构造器返回了可用对象(读侧仍要能用)');
  check(r.warns.some((w) => /迁移诊断没能写进库/.test(w)), 'E4①:降级信号之一 —— warn 如实说明"诊断没写进去"(实际 ' + JSON.stringify(r.warns) + ')');
  check(r.warns.some((w) => /source 列缺失\(迁移未生效\)/.test(w)), 'E4①:降级信号之二 —— warn 说明迁移未生效(读侧要回落裸 id 判据)');
  check(dbg === null, 'E4①:诊断键确实**没**落库(不是"写进去了")');
  if (r.m) {
    const cols = r.m.db.prepare('PRAGMA table_info(dsh_turns_raw)').all().map((c) => c.name);
    check(!cols.includes('source'), 'E4①:只读 ⇒ ALTER 自然失败,列仍未补(实际 ' + JSON.stringify(cols) + ')');
    check(String(r.m.kvGet('schema_version')) === '13', 'E4①:迁移未生效 ⇒ schema_version 停在 13(下次启动重试)');
    check(isDshRawRow('keep-me', null) === true && isDshRawRow('import:x', null) === false,
      'E4①:读侧回到"裸 id"回落判据,与修前同解');
    r.m.close();
  }
}

// ② 库**被写锁**(外部 BEGIN IMMEDIATE)。⚠️ 构造器在 memory.js:427 把 busy_timeout 硬设 15000,
// 而库锁期间有 3 笔串行写(migrateBranchCols 的 branch INSERT / source ALTER / 本诊断写)⇒ 真等要 45s+。
// 故用例里拦一条 PRAGMA 把它压到 40ms(并**自报命中数**,免得拦不中时用例静默变成 45s 慢用例)。
{
  const p = makeV13('e4-lock.db');
  const holder = new DatabaseSync(p);
  holder.exec('PRAGMA busy_timeout=200;');
  holder.exec('BEGIN IMMEDIATE');
  const desc = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'exec');
  const realExec = desc.value;
  let shimHits = 0;
  DatabaseSync.prototype.exec = function (sql, ...rest) {
    if (/busy_timeout\s*=\s*15000/.test(String(sql))) { shimHits++; return realExec.call(this, 'PRAGMA busy_timeout=40;', ...rest); }
    return realExec.call(this, sql, ...rest);
  };
  let r;
  try { r = tryConstruct(p); } finally {
    Object.defineProperty(DatabaseSync.prototype, 'exec', desc);
    try { holder.exec('ROLLBACK'); } catch {}
    holder.close();
  }
  check(shimHits >= 1, 'E4②:前置 —— busy_timeout 确实被压到 40ms(shim 命中 ' + shimHits + ' 次;0 次说明这条用例会空等 15s×3)');
  check(r.err === null, 'E4②:库被写锁时构造**不抛**(修前抛 database is locked,实际 ' + r.err + ')');
  check(r.warns.some((w) => /database is locked/.test(w) && /迁移诊断没能写进库/.test(w)),
    'E4②:降级信号 —— warn 记下"被锁挡住的那笔诊断"(实际 ' + JSON.stringify(r.warns) + ')');
  if (r.m) {
    check(String(r.m.kvGet('schema_version')) === '13' && !r.m.db.prepare('PRAGMA table_info(dsh_turns_raw)').all().some((c) => c.name === 'source'),
      'E4②:锁住期间迁移没生效 ⇒ 仍停在 v13(锁释放后的下一次启动会自愈)');
    r.m.close();
  }
  // 锁释放后重开:**自愈**(探列幂等 ⇒ 迁移补上、诊断键清掉、schema_version 前进)
  const heal = new MemoryStore(p);
  const healCols = heal.db.prepare('PRAGMA table_info(dsh_turns_raw)').all().map((c) => c.name);
  check(healCols.includes('source') && String(heal.kvGet('schema_version')) === '17' && heal.kvGet('dbg.raw_source_col') === undefined,
    'E4②:锁释放后重开自愈(source 列补上、schema_version=17、诊断键不残留),实际 ' + JSON.stringify([healCols, heal.kvGet('schema_version'), heal.kvGet('dbg.raw_source_col')]));
  check(String(heal.db.prepare("SELECT text FROM dsh_turns_raw WHERE session_id='keep-me'").get()?.text) === '老库里的原文',
    'E4②:迁移没动任何既有行的字节(原文仍在)');
  heal.close();
}

// ③ 负对照:正常可写的 v13 库 ⇒ 迁移成功、行为不变、dbg 键**不写**(真正要保住的语义)
{
  const p = makeV13('e4-ok.db');
  const r = tryConstruct(p);
  check(r.err === null && r.m !== null, 'E4③:可写库照旧构造成功(实际 ' + r.err + ')');
  check(r.warns.length === 0, 'E4③:可写库零告警(不该有降级噪音,实际 ' + JSON.stringify(r.warns) + ')');
  if (r.m) {
    const cols = r.m.db.prepare('PRAGMA table_info(dsh_turns_raw)').all().map((c) => c.name);
    check(cols.length === 7 && cols[6] === 'source', 'E4③:迁移成功 —— source 补在列尾(实际 ' + JSON.stringify(cols) + ')');
    check(String(r.m.kvGet('schema_version')) === '17', 'E4③:schema_version 前进到 17(实际 ' + r.m.kvGet('schema_version') + ')');
    check(r.m.kvGet('dbg.raw_source_col') === undefined, 'E4③:迁移**成功路径零 kv 写入** —— dbg 键不写(实际 ' + String(r.m.kvGet('dbg.raw_source_col')) + ')');
    check(Number(r.m.db.prepare("SELECT COUNT(*) n FROM dsh_turns_raw WHERE source IS NULL").get().n) === 1,
      'E4③:纯增列不动既有行(老行 source 仍 NULL)⇒ 读侧判据逐字同解');
    check(isDshRawRow('keep-me', null) === true, 'E4③:老行仍按裸 id 判据入内(行为不变)');
    r.m.appendRawTurn('after-mig', { seq: 1, role: 'user', ts: null, model: null, text: 'x' });
    check(String(r.m.db.prepare("SELECT source FROM dsh_turns_raw WHERE session_id='after-mig'").get()?.source) === 'dsh',
      'E4③:迁移后写入侧照旧按 id 推导来源');
    r.m.close();
  }
}

console.log(ok ? 'summarizer 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
