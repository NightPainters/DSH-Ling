// M6a / 1.9 · 导出覆盖面(16 表)—— 逐表列集 + 表数 + includeRaw + 旧字段不变
//
// 判据来源:PLAN-1.9 §1.2(逐表口径)/ §2.3(包形状)/ §2.4(旧包兼容)/ §7.3(逐表列集断言)。
// 本文件是导出侧**唯一事实源**的镜像:`TABLES` 与 `lib/host/memory.js` 的 `EXPORT_TABLES`
// 逐条对得上(表名 / 段名 / mode / 列数);两边任何一边改了都会红。
//
// 四个必红变异对应用例:
//   ① 少导一张「导」表        → 「manifest.tables 必须 16 条」/「恒导段必须存在」红
//   ② kv 扩成全表             → 「deep 段只能含 deep%」/「kvExtra 只导白名单前缀」红
//   ③ includeRaw=false 却导 raw → 「rawTurns 必须不存在」+「manifest/include 双向一致」红
//   ④ deep_item 列集缺列      → 「deepItems 列集精确相等」红(错误信息列出缺列)
//
// 全部在 mkdtempSync 临时库上跑(不写源码树、不碰 live memory.db)。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const sorted = (a) => [...a].map(String).sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** 逐表列集断言:精确集合相等(缺 1 列红、多 1 列也红),错误信息打印缺/多列。 */
const checkCols = (label, rows, expect) => {
  check(Array.isArray(rows), `${label}: 段必须存在且为数组`);
  if (!Array.isArray(rows) || rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const missing = expect.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !expect.includes(k));
  check(missing.length === 0, `${label}: 缺列 ${missing.join(',')}`);
  check(extra.length === 0, `${label}: 多列 ${extra.join(',')}`);
  const bad = rows.findIndex((r) => !sameSet(Object.keys(r), expect));
  check(bad < 0, `${label}: 第 ${bad} 行列集与 spec 不等(实际 ${Object.keys(rows[bad] || {}).join(',')})`);
};

// ── 16 表 spec(与 PLAN-1.9 §1.2 逐字一致;`columns` = 导出行列集,自增 id 已剥) ──
const TABLES = [
  {
    name: 'conv_overview', segment: 'overviews', mode: 'always',
    columns: ['conv_id', 'source', 'title', 'started_at', 'updated_at', 'domain_tags', 'category', 'keywords',
      'summary', 'heat', 'importance', 'last_hit_at', 'hit_count', 'overview_ok', 'origin', 'title_locked', 'title_by'],
  },
  {
    name: 'deep_item', segment: 'deepItems', mode: 'always',
    columns: ['id', 'kind', 'text', 'at', 'conv_id', 'seq_from', 'seq_to', 'src', 'hit_count', 'pinned',
      'durability', 'superseded_by', 'origin', 'branch_id', 'created_at', 'updated_at'],
  },
  { name: 'kv', segment: 'deep', extraSegment: 'kvExtra', mode: 'always', columns: ['key', 'value'] },
  { name: 'feedback_queue', segment: 'feedbackQueue', mode: 'always', columns: ['created_at', 'session_id', 'message_id', 'rating', 'note', 'status'] },
  { name: 'persona_suggestions', segment: 'suggestions', mode: 'always', columns: ['kind', 'value', 'note', 'evidence', 'status', 'created_at'] },
  { name: 'session_meta', segment: 'sessions', mode: 'always', columns: ['session_id', 'mode', 'mode_updated_at', 'archived', 'raw_seq', 'branch_id', 'started_at', 'started_at_src'] },
  { name: 'branch', segment: 'branches', mode: 'always', columns: ['id', 'name', 'kind', 'parent_id', 'fork_at', 'fork_seq', 'name_locked', 'weight_scale', 'visibility', 'status', 'created_at', 'updated_at'] },
  { name: 'vein_link', segment: 'veinLinks', mode: 'always', columns: ['from_branch', 'to_branch', 'kind', 'note', 'created_at'] },
  { name: 'conv_branch', segment: 'convBranches', mode: 'always', columns: ['source', 'conv_id', 'branch_id', 'created_at'] },
  { name: 'memory_conflict', segment: 'conflicts', mode: 'always', columns: ['created_at', 'a_source', 'a_conv_id', 'b_source', 'b_conv_id', 'kind', 'detected_by', 'score', 'reason', 'status', 'winner_side', 'resolved_at'] },
  { name: 'branch_log', segment: 'branchLogs', mode: 'always', columns: ['at', 'branch_id', 'action', 'before_val', 'after_val', 'note', 'actor'] },
  { name: 'vein_suggestions', segment: 'veinSuggestions', mode: 'always', columns: ['at', 'vein_id', 'text', 'sources', 'model', 'status', 'note', 'resolved_at'] },
  { name: 'dsh_turns_raw', segment: 'rawTurns', mode: 'opt-in', option: 'includeRaw', columns: ['session_id', 'seq', 'role', 'ts', 'model', 'text', 'source'] },
  { name: 'tree_snapshot', segment: 'snapshots', mode: 'opt-in', option: 'includeSnapshots', columns: ['at', 'name', 'note', 'data', 'kind'] },
  { name: 'forgotten', segment: 'forgotten', mode: 'opt-in', option: 'includeForgotten', columns: ['source', 'conv_id', 'at', 'reason', 'archive_path', 'actor'] },
  { name: 'inject_log', segment: null, mode: 'never', reason: 'local-instrumentation', columns: [] },
];
const spec = (name) => TABLES.find((t) => t.name === name);
const byMode = (m) => TABLES.filter((t) => t.mode === m);

// ── 造数据:每张表都落至少 1 行(否则"段存在"可能是空数组假绿) ─────────────
const dir = mkdtempSync(join(tmpdir(), 'ling-x19-'));
const m = new MemoryStore(join(dir, 'm.db'));
const dirB = mkdtempSync(join(tmpdir(), 'ling-x19b-'));
const m2 = new MemoryStore(join(dirB, 'm2.db'));

// conv_overview:3 行(三种 source,覆盖 17 列)
m.upsertOverview({ conv_id: 'a1', source: 'dsweb', title: '材料模拟', category: 'knowledge', overview_ok: true, summary: '浅' });
m.upsertOverview({ conv_id: 's1', source: 'dsh', title: '深摘会话', category: 'daily', overview_ok: true, summary: '深摘要文本' });
m.upsertOverview({ conv_id: 'imp-1', source: 'import', title: '文件导入的会话', category: 'daily', overview_ok: true, summary: '导入摘要' });
// feedback_queue / persona_suggestions
m.addFeedback({ session_id: 's1', message_id: 'm1', rating: 'negative', note: '别文言', created_at: '2026-09-07T00:00:00Z' });
m.addFeedback({ session_id: 's1', message_id: 'm2', rating: 'negative', note: '别啰嗦', created_at: '2026-09-07T00:01:00Z' });
m.addPersonaSuggestion({ kind: 'aiName', value: '灵灵', note: '自称建议', evidence: { count: 4 } });
m.addPersonaSuggestion({ kind: 'hardrule', value: '结构化呈现', note: '规则', evidence: { count: 3 } });
// kv:deep 段(2) + 人格历史白名单(2) + 明确不导的键(构造器已写 schema_version;再塞 veto./dbg.)
m.kvSet('deep:s1', 'done:2026-09-07T01:00:00Z');
m.kvSet('deep.sum:s1', '深摘要文本');
m.kvSet('persona.hist.mode', 'work');
m.kvSet('persona.log.2026-11-12', '{"note":"persona log"}');
// 人格历史里含**承诺句**(api.js archivePersona 存的是整份人格快照)——
// 出站必须脱敏:GET /export 经代理时不许泄漏(tests/branch.test.mjs 7.9 的断言同源)
const SEAL_PHRASE = '这是我在定型时亲手写下的承诺句。';
m.kvSet('persona.hist.1000', JSON.stringify({ persona: { aiName: '灵', sealed: true, sealPhrase: SEAL_PHRASE }, styles: {}, kind: 'result' }));
m.kvSet('persona.log.1000', JSON.stringify({ at: 1000, kind: 'result', keys: ['aiName', 'sealed', 'sealPhrase'], sample: '{"sealed":true,"sealPhrase":"' + SEAL_PHRASE.slice(0, 20) }));
m.kvSet('veto.last', '{"reason":"secret"}');
m.kvSet('dbg.some_key', 'debug-only');
// deep_item:60 行(> listDeepItems 默认 50),其中 1 行已作废、1 行 origin='user'
{
  const ins = m.db.prepare(`INSERT INTO deep_item
    (id,kind,text,at,conv_id,seq_from,seq_to,src,hit_count,pinned,durability,superseded_by,origin,branch_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 60; i += 1) {
    const id = 'di:bulk-' + String(i).padStart(2, '0');
    ins.run(id, '事实', '第 ' + i + ' 条结论', '2026-09-07T00:00:00Z', 's1', i, i, 'dsh',
      i === 1 ? 3 : 0, i === 1 ? 1 : 0, 'long',
      i === 0 ? 'di:bulk-01' : '', // 已作废/被取代的留痕:必须照样进包
      i === 1 ? 'user' : 'auto', '', '2026-09-07T00:00:00Z', '');
  }
}
// session_meta:8 列全给(含 started_at_src 的"诚实来源标记")
m.db.prepare(`INSERT INTO session_meta
  (session_id,mode,mode_updated_at,archived,raw_seq,branch_id,started_at,started_at_src)
  VALUES (?,?,?,?,?,?,?,?)`).run('s1', 'work', '2026-09-07T00:00:00Z', 0, 12, 'trunk', '2026-09-01T00:00:00Z', 'seen');
// branch:主干是新库自带的一行 + 新建一条
const brId = m.createBranch({ name: '实验枝', kind: 'branch', parentId: 'trunk' });
// vein_link / conv_branch
m.linkVeins(brId, 'trunk', { kind: 'related', note: '测试连边' });
m.setConvBranch('dsweb', 'a1', brId);
// memory_conflict
m.recordConflict({ aSource: 'dsh', aConvId: 's1', bSource: 'dsweb', bConvId: 'a1', kind: 'contradict', score: 0.8, reason: '测试矛盾' });
// branch_log / vein_suggestions
m.logBranch('trunk', 'create', { after: '实验枝', note: '测试留痕', actor: 'ling' });
m.addVeinSuggestion({ veinId: brId, text: '主脉建议文本', sources: ['s1'], model: 'test-model', note: '测试' });
// tree_snapshot(条件段)
m.snapshotTree({ name: '测试快照', note: '手动', kind: 'manual' });
// forgotten(条件段)
m.db.prepare('INSERT INTO forgotten (source,conv_id,at,reason,archive_path,actor) VALUES (?,?,?,?,?,?)')
  .run('dsh', 'gone-1', '2026-09-07T00:00:00Z', '测试遗忘', 'forgotten/dsh-gone-1', 'user');
// dsh_turns_raw(条件段)
{
  const ins = m.db.prepare('INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text,source) VALUES (?,?,?,?,?,?,?)');
  ins.run('s1', 1, 'user', '2026-09-07T00:00:00Z', 'm', '你好', 'dsh');
  ins.run('s1', 2, 'assistant', '2026-09-07T00:01:00Z', 'm', '在', 'dsh');
}
// inject_log(永不导出;塞一个只可能来自这张表的哨兵串)
m.db.prepare('INSERT INTO inject_log (at,session_id,reason,text_hash,note) VALUES (?,?,?,?,?)')
  .run('2026-09-07T00:00:00Z', 's1', 'first', 'INJECT-LOG-ONLY-SENTINEL-HASH', 'INJECT-LOG-ONLY-SENTINEL-NOTE');

// ── 1) 默认导出(includeRaw=false) ────────────────────────────────────────
const b0 = m.exportBundle();
// 段缺失时按空数组读:变异用例要的是"断言红",而不是 TypeError 把测试中断在半路
// (红必须红在判据上,否则看不出"少导了哪张表")。
const arr = (v) => (Array.isArray(v) ? v : []);

// 1.1 旧 10 键:键名/顺序/取值口径冻结
const OLD_KEYS = ['format', 'schemaVersion', 'exportScope', 'exportedAt', 'sourceFingerprint', 'origin',
  'overviews', 'feedbackQueue', 'suggestions', 'deep'];
check(JSON.stringify(Object.keys(b0).slice(0, 10)) === JSON.stringify(OLD_KEYS),
  '旧 10 键必须仍在最前且顺序不变,实际 ' + Object.keys(b0).slice(0, 10).join(','));
check(b0.format === 'dsh-ling-memory', 'format 冻结');
check(b0.schemaVersion === 17, 'schemaVersion 冻结为库 schema 版本 17,实际 ' + b0.schemaVersion);
check(b0.exportScope === 2, 'exportScope 冻结为 2(旧读者看到的仍是 2),实际 ' + b0.exportScope);
check(b0.origin === 'local-default', 'origin 冻结');
check(typeof b0.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(b0.exportedAt), 'exportedAt 仍是 ISO 串');
check(b0.sourceFingerprint === sha256(JSON.stringify(b0.overviews)),
  'sourceFingerprint 冻结:仍只对 overviews 求 sha256');
check(b0.overviews.length === 3, 'overviews 行数,实际 ' + b0.overviews.length);
check(b0.feedbackQueue.length === 2, 'feedbackQueue 行数,实际 ' + b0.feedbackQueue.length);
check(b0.suggestions.length === 2, 'suggestions 行数,实际 ' + b0.suggestions.length);

// 1.2 旧四段的列集一个字不改
checkCols('overviews(conv_overview 17 列)', b0.overviews, spec('conv_overview').columns);
checkCols('feedbackQueue(6 列)', b0.feedbackQueue, spec('feedback_queue').columns);
checkCols('suggestions(6 列)', b0.suggestions, spec('persona_suggestions').columns);
checkCols('deep(kv 段①,2 列)', b0.deep, spec('kv').columns);

// 1.3 manifest:16 条、逐表 mode/段名/列数
const mt = b0.manifest?.tables;
check(Array.isArray(mt), 'manifest.tables 必须存在且为数组');
check(mt.length === 16, 'manifest.tables 必须 16 条(恒 12 + 条件 3 + 不导 1),实际 ' + mt?.length);
check(mt.map((t) => t.name).join(',') === TABLES.map((t) => t.name).join(','),
  'manifest 表名/顺序必须与 16 表清单逐字相等');
check(new Set(mt.map((t) => t.name)).size === 16, 'manifest 表名不得重复');
for (const s of TABLES) {
  const e = mt.find((t) => t.name === s.name);
  check(!!e, `manifest 缺表 ${s.name}`);
  if (!e) continue;
  check(e.mode === s.mode, `${s.name}: mode 必须 '${s.mode}',实际 ${e.mode}`);
  check(e.segment === s.segment, `${s.name}: segment 必须 ${JSON.stringify(s.segment)},实际 ${JSON.stringify(e.segment)}`);
  check(Number(e.columns) === s.columns.length, `${s.name}: columns 必须 ${s.columns.length},实际 ${e.columns}`);
  if (s.mode === 'opt-in') check(e.option === s.option, `${s.name}: opt-in 必须标开关名 ${s.option}`);
  if (s.mode === 'never') check(e.reason === s.reason, `${s.name}: never 必须带 reason '${s.reason}'`);
}
check(byMode('always').length === 12, 'spec 恒导必须 12 张');
check(byMode('opt-in').length === 3, 'spec 条件导必须 3 张');
check(byMode('never').length === 1, 'spec 不导必须 1 张');
check(b0.manifest.bundleVersion === 3 && b0.manifest.scope === 3 && b0.manifest.minReader === 2,
  'manifest bundleVersion/scope/minReader 按 PLAN §2.3');

// 1.3b ★MF-1:表数**按表数**对账(不是"硬编码常量 × 硬编码常量")
//   上面 `mt.length === 16` 两端同源(manifest 来自 `EXPORT_TABLES` 字面量,期望值来自本文件 `TABLES`
//   字面量),只能抓"实现与常量漂移",抓不到"库真长出第 17 张业务表而两个常量都没改"。
//   ⇒ 从 `sqlite_master` 取**运行期真实表集合**,与 `manifest.tables` 双向差集;新增任何业务表必红。
//   唯一白名单 = 迁移临时表(建完即 drop:`conv_overview_v2`,见 memory.js 的 `migrateSourceCheck`);
//   被排除者**逐个打印** ⇒ 谁也别想偷偷把真表塞进排除名单。
const MIGRATION_TMP_TABLES = ['conv_overview_v2'];
const dbTableNames = m.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map((r) => String(r.name));
const excludedTmp = dbTableNames.filter((n) => MIGRATION_TMP_TABLES.includes(n));
for (const n of excludedTmp) console.log('   [表数对账] 按迁移临时表白名单排除:' + n);
const businessTableNames = dbTableNames.filter((n) => !MIGRATION_TMP_TABLES.includes(n));
const manifestNames = (Array.isArray(mt) ? mt : []).map((t) => String(t.name));
const dbOnly = businessTableNames.filter((n) => !manifestNames.includes(n));
const manifestOnly = manifestNames.filter((n) => !businessTableNames.includes(n));
check(dbOnly.length === 0,
  '★1.3b 库里的业务表必须全部登记进 manifest.tables(漏登记/漏导表:' + (dbOnly.join(',') || '无') + ')');
check(manifestOnly.length === 0,
  '★1.3b manifest.tables 不得登记库里不存在的表(幽灵表:' + (manifestOnly.join(',') || '无') + ')');
check(businessTableNames.length === manifestNames.length,
  '★1.3b 业务表数必须 = manifest 条数(库 ' + businessTableNames.length + ' / manifest ' + manifestNames.length + ')');
check(JSON.stringify(businessTableNames) === JSON.stringify([...manifestNames].sort()),
  '★1.3b 业务表集合与 manifest 集合**逐名相等**(排序后),实际库 ' + JSON.stringify(businessTableNames));

// 1.4 恒导 12 张:段必须存在、非空、列集精确
const ALWAYS = byMode('always');
for (const s of ALWAYS) {
  check(Array.isArray(b0[s.segment]), `恒导段缺失:${s.name} → ${s.segment}`);
  if (s.extraSegment) check(Array.isArray(b0[s.extraSegment]), `恒导第二段缺失:${s.name} → ${s.extraSegment}`);
}
check(arr(b0.deepItems).length === 60, 'deep_item 必须导出全部 60 行(含 superseded / origin=user),实际 ' + arr(b0.deepItems).length);
check(arr(b0.sessions).length === 1, 'session_meta 行数,实际 ' + arr(b0.sessions).length);
check(arr(b0.branches).length >= 2, 'branch 行数(主干 + 新建),实际 ' + arr(b0.branches).length);
check(arr(b0.veinLinks).length === 1, 'vein_link 行数,实际 ' + arr(b0.veinLinks).length);
check(arr(b0.convBranches).length === 1, 'conv_branch 行数,实际 ' + arr(b0.convBranches).length);
check(arr(b0.conflicts).length === 1, 'memory_conflict 行数,实际 ' + arr(b0.conflicts).length);
check(arr(b0.branchLogs).length === 1, 'branch_log 行数,实际 ' + arr(b0.branchLogs).length);
check(arr(b0.veinSuggestions).length === 1, 'vein_suggestions 行数,实际 ' + arr(b0.veinSuggestions).length);
check(arr(b0.kvExtra).length === 4, 'kvExtra 行数(2 条普通 + 2 条人格历史),实际 ' + arr(b0.kvExtra).length);

checkCols('deepItems(deep_item 16 列)', b0.deepItems, spec('deep_item').columns);
checkCols('sessions(8 列)', b0.sessions, spec('session_meta').columns);
checkCols('branches(12 列)', b0.branches, spec('branch').columns);
checkCols('veinLinks(5 列)', b0.veinLinks, spec('vein_link').columns);
checkCols('convBranches(4 列)', b0.convBranches, spec('conv_branch').columns);
checkCols('conflicts(12 列,剥 id)', b0.conflicts, spec('memory_conflict').columns);
checkCols('branchLogs(7 列,剥 id)', b0.branchLogs, spec('branch_log').columns);
checkCols('veinSuggestions(8 列,剥 id)', b0.veinSuggestions, spec('vein_suggestions').columns);
checkCols('kvExtra(kv 段②,2 列)', b0.kvExtra, spec('kv').columns);

// 1.5 deep_item 关键列(变异点④):origin / seq_from / seq_to 必须在
for (const k of ['origin', 'seq_from', 'seq_to']) {
  check(spec('deep_item').columns.includes(k), `deep_item spec 必须含 ${k}`);
  check(arr(b0.deepItems).every((r) => Object.hasOwn(r, k)), `deepItems 每行必须含 ${k}`);
}
check(arr(b0.deepItems).some((r) => r.superseded_by === 'di:bulk-01'), '被取代的留痕必须照样进包(不许复用 listDeepItems 默认过滤)');
check(arr(b0.deepItems).some((r) => r.origin === 'user'), 'origin=user 的行必须照样进包');

// 1.6 kv 范围(变异点②):deep 段只 deep%,kvExtra 只白名单前缀,合起来不许等于全表
check(b0.deep.every((d) => String(d.key).startsWith('deep')), 'deep 段只能含 deep% 键');
check(arr(b0.kvExtra).every((d) => String(d.key).startsWith('persona.hist.') || String(d.key).startsWith('persona.log.')),
  'kvExtra 只能含 persona.hist./persona.log. 白名单前缀');
const banned = ['schema_version', 'veto.last', 'dbg.some_key'];
for (const k of banned) {
  check(!b0.deep.some((d) => d.key === k) && !arr(b0.kvExtra).some((d) => d.key === k), `kv 不得导出 ${k}`);
}
const deepCount = Number(m.db.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'deep%'").get().n);
const kvTotal = Number(m.db.prepare('SELECT COUNT(*) n FROM kv').get().n);
check(b0.deep.length === deepCount, `deep 段计数必须 = kv 表 deep% 行数(${deepCount}),实际 ${b0.deep.length}`);
check(b0.deep.length + arr(b0.kvExtra).length < kvTotal,
  `kv 两段合起来(${b0.deep.length}+${arr(b0.kvExtra).length})必须仍小于全表 ${kvTotal}(证明没扩成全 kv)`);

// 1.6b 人格历史出站脱敏:承诺句 / sealPhrase 不得随包出站
//   (api.js 的 personaForRead 只脱敏 bundle.persona,不认 kv 段 ⇒ 这条只能由导出侧保证)
check(!JSON.stringify(b0).includes(SEAL_PHRASE), '导出包不得含承诺句原文(persona.hist 旁路)');
check(!JSON.stringify(arr(b0.kvExtra)).includes('sealPhrase'), 'kvExtra 不得含 sealPhrase 字段名');
const histRow = arr(b0.kvExtra).find((d) => d.key === 'persona.hist.1000');
check(!!histRow, 'persona.hist.1000 必须仍在包里(脱敏不等于丢行)');
if (histRow) {
  check(JSON.parse(histRow.value).persona?.aiName === '灵', '脱敏只删承诺句,其余人格字段保真');
  check(!Object.hasOwn(JSON.parse(histRow.value).persona || {}, 'sealPhrase'), 'persona.hist 出站必须无 sealPhrase');
}
const logRow = arr(b0.kvExtra).find((d) => d.key === 'persona.log.1000');
if (logRow) {
  check(!logRow.value.includes('sealPhrase'), 'persona.log 的 keys/sample 必须一起去掉 sealPhrase');
}
// 库里的行一个字节都不动(过滤只在出站层)
const rawHist = String(m.kvGet('persona.hist.1000'));
check(rawHist.includes('sealPhrase') && rawHist.includes(SEAL_PHRASE), '库内 persona.hist 原样保留(出站过滤不改数据)');

// 1.7 条件段默认缺席(变异点③):键不存在 + manifest 布尔为 false(双向一致)
check(!Object.hasOwn(b0, 'rawTurns'), 'includeRaw=false 时 rawTurns 必须不存在');
check(!Object.hasOwn(b0, 'snapshots'), 'includeSnapshots=false 时 snapshots 必须不存在');
check(!Object.hasOwn(b0, 'forgotten'), 'includeForgotten=false 时 forgotten 必须不存在');
check(b0.manifest.includeRaw === false && b0.manifest.includeSnapshots === false && b0.manifest.includeForgotten === false,
  'manifest.include* 默认必须全 false');
check((b0.manifest.includeRaw === true) === Object.hasOwn(b0, 'rawTurns'), 'includeRaw 与 rawTurns 存在性必须双向一致');
check((b0.manifest.includeSnapshots === true) === Object.hasOwn(b0, 'snapshots'), 'includeSnapshots 与 snapshots 存在性必须双向一致');
check((b0.manifest.includeForgotten === true) === Object.hasOwn(b0, 'forgotten'), 'includeForgotten 与 forgotten 存在性必须双向一致');

// 1.8 inject_log 永不导出(唯一 never):任何开关下都不出现,哨兵串不进包
const sentinel = 'INJECT-LOG-ONLY-SENTINEL';
check(!JSON.stringify(b0).includes(sentinel), 'inject_log 内容绝不许进包');
check(!Object.keys(b0).some((k) => /inject/i.test(k)), '包内不得出现 inject_log 段');

// 1.9 manifest.bytes / contentHash / identity_scope
check(/^[0-9a-f]{16}$/.test(String(b0.manifest.contentHash)), 'manifest.contentHash 必须是 sha256 前 16 位 hex');
check(b0.manifest.bytes === Buffer.byteLength(JSON.stringify(b0), 'utf8'),
  `manifest.bytes 必须 = 整包 UTF-8 字节数(${Buffer.byteLength(JSON.stringify(b0), 'utf8')}),实际 ${b0.manifest.bytes}`);
check(b0.identity_scope?.schema === 1, 'identity_scope.schema 必须是 1');
check(/^[0-9a-f]{12}$/.test(String(b0.identity_scope.hostHash)), 'identity_scope.hostHash 必须是 sha256 前 12 位 hex');
check(/^[0-9a-f]{16}$/.test(String(b0.identity_scope.packageId)), 'identity_scope.packageId 必须是 sha256 前 16 位 hex');
check(b0.identity_scope.exportedAt === b0.exportedAt, 'identity_scope.exportedAt 必须与包 exportedAt 同值');
const b0b = m.exportBundle();
check(b0b.identity_scope.packageId === b0.identity_scope.packageId, '同一库两次导出 packageId 必须稳定');
check(b0b.manifest.contentHash === b0.manifest.contentHash, '同一库两次导出 contentHash 必须稳定');

// ── 2) includeRaw=true:rawTurns 出现且列集 7 ─────────────────────────────
const bRaw = m.exportBundle({ includeRaw: true });
check(Object.keys(bRaw)[10] === 'rawTurns', 'rawTurns 必须仍在旧位置(旧 10 键之后紧跟),实际 ' + Object.keys(bRaw)[10]);
check(Array.isArray(bRaw.rawTurns) && bRaw.rawTurns.length === 2, 'includeRaw=true 时 rawTurns 2 行,实际 ' + bRaw.rawTurns?.length);
checkCols('rawTurns(dsh_turns_raw 7 列)', bRaw.rawTurns, spec('dsh_turns_raw').columns);
check(bRaw.manifest.includeRaw === true, 'includeRaw=true 必须写进 manifest');
check((bRaw.manifest.includeRaw === true) === Object.hasOwn(bRaw, 'rawTurns'), 'includeRaw 与 rawTurns 存在性必须双向一致');
check(!Object.hasOwn(bRaw, 'snapshots') && !Object.hasOwn(bRaw, 'forgotten'), '只开 includeRaw 不得顺带导出其他条件段');
check(!JSON.stringify(bRaw).includes(sentinel), 'includeRaw=true 也不得导出 inject_log');
// rawTurns 仍不做任何过滤(整张原文表,只加开关)
const rawCount = Number(m.db.prepare('SELECT COUNT(*) n FROM dsh_turns_raw').get().n);
check(arr(bRaw.rawTurns).length === rawCount, `rawTurns 行数必须 = 原文表行数(${rawCount})`);

// ── 3) includeSnapshots / includeForgotten ───────────────────────────────
const bSnap = m.exportBundle({ includeSnapshots: true });
check(Array.isArray(bSnap.snapshots) && bSnap.snapshots.length === 1, 'includeSnapshots=true 时 snapshots 1 行');
checkCols('snapshots(tree_snapshot 5 列,剥 id)', bSnap.snapshots, spec('tree_snapshot').columns);
check(bSnap.manifest.includeSnapshots === true && !Object.hasOwn(bSnap, 'rawTurns'), 'snapshots 开关独立');
const bForg = m.exportBundle({ includeForgotten: true });
check(Array.isArray(bForg.forgotten) && bForg.forgotten.length === 1, 'includeForgotten=true 时 forgotten 1 行');
checkCols('forgotten(6 列)', bForg.forgotten, spec('forgotten').columns);
check(bForg.manifest.includeForgotten === true && !Object.hasOwn(bForg, 'snapshots'), 'forgotten 开关独立');

// ── 4) 旧版本仍能导新包(只读它认识的 5 段;新键被静默忽略) ──────────────
//    这里直接复用**未改动**的 importBundle(即 v2 读者)导 v3 包。
const rep = m2.importBundle(b0);
check(rep.errors === 0, '旧导入路径导 v3 包:errors 必须 0,实际 ' + JSON.stringify(rep));
check(rep.added === 3, '旧导入路径导 v3 包:added 必须 3(overviews),实际 ' + rep.added);
check(rep.queueAdded === 2 && rep.suggAdded === 2, '旧导入路径仍按旧 5 段落队列/建议');
check(!!m2.overviewById('dsh', 's1'), '旧导入路径确实落了概述行');

// 旧包(无新键)仍能导:最小 v2 包
const legacy = {
  format: 'dsh-ling-memory',
  overviews: [{ conv_id: 'legacy-1', source: 'dsh', title: '旧包概述', overview_ok: true, summary: 's' }],
  feedbackQueue: [{ session_id: 'legacy-1', message_id: 'm1', rating: 'negative' }],
  suggestions: [{ kind: 'aiName', value: '旧名' }],
  deep: [],
};
const repLegacy = m2.importBundle(legacy);
check(repLegacy.errors === 0 && repLegacy.added === 1, '最小 v2 旧包仍能导,实际 ' + JSON.stringify(repLegacy));

console.log(ok ? '导出 16 表覆盖 / 列集 / includeRaw / 旧字段不变:全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
