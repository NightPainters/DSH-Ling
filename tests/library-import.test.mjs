// 1.7 图书馆 · **导入通道** —— 契约 §9 七条判据的骨架(与 §3/§5/§6/§7 的接口形状一起钉死)
//
// ✅ 2026-10-12 全绿并登记进 package.json 的 test 链(在这之前它是**故意红的骨架**:实现一段、红少一片)。
//    转绿顺序:analyze 段(§9.1/§9.3/§9.6/§9.7)→ HTTP + runtime 两条门面(§10 的 analyze 半边)
//    → `store.import_key`(schema v1→v2,即 D1)一次收掉余下 15 条(§9.2/§9.4/§9.5/§8/§10 的 commit 半边)。
//
// 它钉住的接口(**实现要照这个来**,不是我抄来的既有事实):
//   lib/host/library-import.js
//     importSourceHash(text)                      → 'sha256:<64hex>'(全文摘要,幂等键的一半)
//     importKey(sourceHash, locator)              → '<16hex>:<locator>'(契约 §6 逐字口径)
//     analyzeImport({kind,name,text}, opts)        → {ok, source_hash, candidates, stats}  **纯函数,不碰库**
//     verifyImportCandidate(candidate, source)     → {...candidate, locator_verified, issues, selected}
//     commitImport(target, {source_hash, items})   → {ok, committed, skipped, rejected, ids}
//   store.create(item):接受 `import_key`;库中已有同一键 ⇒ {ok:false, reason:'duplicate_import'} 且**不写新行**
//   runtime:多两个门 analyzeImport / commitImport(与既有 create/search 同一个注入位)
//   HTTP:POST /library/import/analyze | /library/import/commit(两条都进 POST_ONLY 表)
//
// 三处**本骨架新增**(契约里没有明文,因为它们必须机器可判):
//   · 候选字段 `selected` —— 机械化"默认勾选/不勾选" = locator_verified && 无阻断性 issues;
//   · 模型桩签名 `model(ctx) → 原始候选[]`(只交 locator/evidence 等;**index 与 origin 由 analyze 补**);
//   · CSV 规则段默认**一行一条候选**(与 §4 的 locator=行号、§5 的逐行回查、§6 的 hash:locator 同源)。
//
// ⚠️ DSH_HOME 隔离(硬要求):第 10 节要 `registerApi()`,它一进来就 `rotateSurgeryTicket()` 往
//    `dshHome()` 写"每启动轮换"的票据文件 —— 不隔离就是真机副作用(与 library-api-tools 同款)。
//
// 每节用**各自独立的源**(各自的 CSV)⇒ 节与节之间不靠"哪一行已经被谁写进去了"这种隐状态,
// 单跑一节也能判(第一版是共用一份 CSV,于是第 5 节把第 4 节已入库的同一行当成"第一次"—— 已改)。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

let assertions = 0;
let failures = 0;
const check = (cond, msg) => {
  assertions += 1;
  if (!cond) { failures += 1; console.log('✗ ' + msg); }
};
const section = (t) => console.log('▶ ' + t);

const tmp = mkdtempSync(join(tmpdir(), 'ling-lib-import-'));
const realHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(tmp, 'home');

// ══ 0) 被判对象在不在(fail-closed:缺模块 ⇒ 每一节都报红,不许静默跳过)══════════════════
let lib = null;
let libErr = null;
try { lib = await imp('lib/host/library-import.js'); } catch (e) { libErr = e; }
const hasModule = (label) => {
  if (lib) return true;
  check(false, label + ' —— lib/host/library-import.js 还没实现(' + (libErr && (libErr.code || libErr.message)) + ')');
  return false;
};

const { LibraryStore, DEFAULT_LIBRARY_LIMITS, normalizeLibraryLimits, LIBRARY_STORE_SCHEMA_VERSION } =
  await imp('lib/host/library-store.js');
const store = new LibraryStore(join(tmp, 'library.db'));
const rows = () => Number(store.stats().items.total);

// ── 素材 ──────────────────────────────────────────────────────────────────────────────
const TODAY = '2026-10-10';
const HEADER = ['代号', '名称', '值', '出处'];
const source = (name, rows) => ({
  name, rows,
  payload: { kind: 'csv', name, text: rows.map((r) => r.join(',')).join('\n') + '\n' },
});
const A = source('tolerance-a.csv', [
  HEADER, ['H7', '基准孔公差带', '+0.015/0', 'GB/T 1800.1-2020'],
  ['h6', '基准轴公差带', '0/-0.009', 'GB/T 1800.1-2020'], ['js6', '过渡配合公差带', '±0.0065', 'GB/T 1800.1-2020'],
]);
const D = source('tolerance-d.csv', [
  HEADER, ['D1', '甲', 'v1', 'r'], ['D2', '乙', 'v2', 'r'], ['D3', '丙', 'v3', 'r'],
]);
const E = source('tolerance-e.csv', [HEADER, ['E1', '甲', 'v1', 'r'], ['E2', '乙', 'v2', 'r'], ['E3', '丙', 'v3', 'r']]);
const F = source('tolerance-f.csv', [HEADER, ['F1', '甲', 'v1', 'r'], ['F2', '乙', 'v2', 'r']]);
/** 一条"人审后要提交"的候选(字段面照契约 §4;commit 侧不认 index/origin/issues/selected)。 */
const cand = (src, locator, over = {}) => {
  const line = src.rows[Number(locator) - 1].join(',');
  return {
    title: src.name + ' 第 ' + locator + ' 行', body: line, category: 'standard-value',
    source_kind: 'manual', source_ref: src.name + '#' + locator, as_of: TODAY,
    locator, evidence: line, ...over,
  };
};

section('0) 模块与接口形状');
if (hasModule('0')) {
  for (const fn of ['importSourceHash', 'importKey', 'analyzeImport', 'verifyImportCandidate', 'commitImport']) {
    check(typeof lib[fn] === 'function', '导出 ' + fn + ' 是函数(实际 ' + typeof lib[fn] + ')');
  }
  const h = lib.importSourceHash(A.payload.text);
  check(/^sha256:[0-9a-f]{64}$/.test(String(h)), 'importSourceHash 回 sha256:<64hex>(实际 ' + String(h).slice(0, 24) + '…)');
  check(lib.importSourceHash(A.payload.text) === h, 'importSourceHash 确定性(同输入同摘要)');
  check(lib.importSourceHash(A.payload.text + ' ') !== h, '换一个字节就换摘要');
  const k = lib.importKey(h, '2');
  check(/^[0-9a-f]{16}:2$/.test(String(k)), 'importKey = <16hex>:<locator>(契约 §6 逐字):' + String(k));
  check(lib.importKey(h, '2') === k, 'importKey 确定性');
  check(lib.importKey(h, '3') !== k, '同源不同 locator ⇒ 不同键');
}

// ══ 1) §9.1 分析不写库(含抛错路径)════════════════════════════════════════════════════
section('1) §9.1 分析不写库(analyze 是纯函数;含模型段抛错)');
if (hasModule('§9.1')) {
  const before = rows();
  const out = await lib.analyzeImport(A.payload, { today: TODAY });
  check(out && out.ok === true, 'analyze 回 ok:true(实际 ' + JSON.stringify(out && { ok: out.ok, reason: out.reason }) + ')');
  check(out && /^sha256:[0-9a-f]{64}$/.test(String(out.source_hash)), 'analyze 回执带 source_hash(sha256:<64hex>)');
  check(out && out.source_hash === lib.importSourceHash(A.payload.text), 'source_hash 与 importSourceHash 同源同值');
  check(out && Array.isArray(out.candidates) && out.candidates.length >= 3,
    '三行数据 ⇒ 至少 3 条候选(CSV 规则段默认一行一条;实际 ' + ((out && out.candidates) || []).length + ')');
  check(rows() === before, '★analyze 前后 library_item 行数不变(前 ' + before + ' / 后 ' + rows() + ')');
  const again = await lib.analyzeImport(A.payload, { today: TODAY });
  check(again && again.ok === true && again.candidates.length === out.candidates.length, '同一入参可重跑(候选数一致)');
  check(rows() === before, '重跑同样零写入');
  // 抛错路径:模型段炸了 —— **不抛、也不冒充成功**:回降级回执(ok:true + model_error),且**不许写库**
  // (D11 放行,2026-10-14:原口径是"整发 ok:false";新判据是"**标注得出来就不算藏**")
  let boom = null;
  try { boom = await lib.analyzeImport(A.payload, { today: TODAY, model: () => { throw new Error('模型段炸了'); } }); }
  catch (e) { boom = { threw: true, message: String(e && e.message) }; }
  check(boom && boom.threw !== true && boom.ok === true && boom.stats && boom.stats.model_used === false
    && boom.stats.model === null && boom.stats.model_error && boom.stats.model_error.engine === null,
    '★模型段抛错 ⇒ 降级回执:ok:true + model_used:false + model:null + model_error(实际 '
    + JSON.stringify(boom && (boom.threw ? { threw: true } : {
      ok: boom.ok,
      model_used: boom.stats && boom.stats.model_used,
      model: boom.stats && boom.stats.model,
      has_error: !!(boom.stats && boom.stats.model_error),
    })) + ')');
  check(boom && Array.isArray(boom.candidates) && boom.candidates.length >= 3,
    '★降级不是空手:规则段三条候选照常给(实际 ' + ((boom && boom.candidates) || []).length + ' 条)');
  check(rows() === before, '★抛错路径同样零写入(前 ' + before + ' / 后 ' + rows() + ')');
  check(store.stats().checks.total === 0, 'analyze 也没写核对留痕(checks=0)');
}

// ══ 2) §9.2 入库只走既有 create ═══════════════════════════════════════════════════════
section('2) §9.2 只走 create(桩 target 只实现 create,别的什么都没有)');
if (hasModule('§9.2')) {
  const H = lib.importSourceHash(A.payload.text);
  const seen = [];
  const stub = { create: (it) => { seen.push(it); return { ok: true, item: { id: 'lib:stub', ...it } }; } };
  const r = await lib.commitImport(stub, { source_hash: H, items: [cand(A, '2'), cand(A, '3')] });
  check(seen.length === 2 && r.ok === true && r.committed === 2,
    '★只给 create 一个入口也能入库 ⇒ 导入通道**没有**另开写入口(create 调用数 ' + seen.length + ')');
  // ⚠️ 必须连 `seen.length === 2` 一起判:`[].every(...)` 恒真 —— 只写 every 的话
  //    "一条都没走 create"会**假绿**(骨架第一版就是这个毛病)。
  check(seen.length === 2 && seen.every((it) => typeof it.import_key === 'string' && it.import_key !== ''),
    '★每条都带上 import_key(否则重复导入无处可拦)');
  check(seen[0].import_key === lib.importKey(H, '2'), 'import_key = importKey(source_hash, locator) 逐字一致');
  // 伪造认证:塞 checked_state ⇒ 真 store 必须拒 readonly_field(认证只由裁判员写;这条走真库)
  const forgedBefore = rows();
  const forged = await lib.commitImport(store, { source_hash: H, items: [cand(A, '2', { checked_state: 'ok' })] });
  check(forged.rejected.length === 1 && forged.rejected[0].reason === 'readonly_field',
    '★塞 checked_state ⇒ rejected 里点名 readonly_field(实际 ' + JSON.stringify(forged.rejected) + ')');
  check(forged.committed === 0 && rows() === forgedBefore, '被拒那条**零写入**(行数 ' + forgedBefore + ' → ' + rows() + ')');
}

// ══ 3) §9.3 定位回查有效(第 1 道闸)═══════════════════════════════════════════════════
section('3) §9.3 定位回查:evidence 必须落回原文,落不回就不勾选');
if (hasModule('§9.3')) {
  const okCand = lib.verifyImportCandidate(cand(A, '2'), A.payload);
  check(okCand.locator_verified === true && okCand.selected === true,
    '第 2 行的原文片段 ⇒ 定位通过且**默认勾选**(实际 ' + JSON.stringify({ v: okCand.locator_verified, s: okCand.selected }) + ')');
  check(!(okCand.issues || []).includes('evidence_not_found'), '通过的那条不带 evidence_not_found');
  const tampered = lib.verifyImportCandidate(cand(A, '2', { evidence: '这段字原文里根本没有★' }), A.payload);
  check(tampered.locator_verified === false, '★篡改 evidence ⇒ locator_verified:false');
  check((tampered.issues || []).includes('evidence_not_found'),
    '★issues 点名 evidence_not_found(实际 ' + JSON.stringify(tampered.issues) + ')');
  check(tampered.selected === false, '★默认**不勾选**(selected:false ⇒ 要人工显式保留才进)');
  const badLine = lib.verifyImportCandidate(cand(A, '2', { locator: '99', evidence: 'x' }), A.payload);
  check(badLine.locator_verified === false, 'locator 指向不存在的行 ⇒ 同样拦下');
}

// ══ 4) §9.4 逐条拒、其余照进(回执自洽)════════════════════════════════════════════════
section('4) §9.4 一条超限不连坐整批;committed+skipped+rejected ≡ items');
if (hasModule('§9.4')) {
  const before = rows();
  const bigLine = 'x'.repeat(Number(DEFAULT_LIBRARY_LIMITS.itemMaxBytes) + 1);
  const out = await lib.commitImport(store, {
    source_hash: lib.importSourceHash(D.payload.text),
    items: [cand(D, '2'), cand(D, '3', { body: bigLine, evidence: bigLine }), cand(D, '4')],
  });
  check(out.rejected.length === 1 && Number(out.rejected[0].index) === 2,
    '★只拒第 2 条(超限),index 对得上(实际 ' + JSON.stringify(out.rejected) + ')');
  check(out.committed === 2 && out.ids.length === 2, '其余两条**照进**(committed=' + out.committed + ')');
  check(Number(out.committed) + Number(out.skipped) + out.rejected.length === 3,
    '★总数自洽:committed+skipped+rejected === items.length(实际 '
    + (out.committed + out.skipped + out.rejected.length) + ' / 3)');
  check(rows() === before + 2, '★库里真的只多了 2 行(' + before + ' → ' + rows() + ')');
  check(typeof out.rejected[0].reason === 'string' && out.rejected[0].reason !== '', '被拒条目带原因(不许只给个 false)');
}

// ══ 5) §9.5 幂等(source_hash + locator 不变 ⇒ 第二次 skipped)════════════════════════
section('5) §9.5 幂等:同 source_hash+locator 提交两次 ⇒ 第二次 skipped=1,行数不变');
if (hasModule('§9.5')) {
  const H = lib.importSourceHash(E.payload.text);
  const before = rows();
  const one = await lib.commitImport(store, { source_hash: H, items: [cand(E, '2')] });
  check(one.committed === 1 && one.skipped === 0, '第一次真入库(committed=1)');
  const afterFirst = rows();
  check(afterFirst === before + 1, '第一次后行数 +1(' + before + ' → ' + afterFirst + ')');
  const two = await lib.commitImport(store, { source_hash: H, items: [cand(E, '2')] });
  check(two.skipped === 1 && two.committed === 0,
    '★第二次 skipped=1 / committed=0(实际 ' + JSON.stringify({ c: two.committed, s: two.skipped }) + ')');
  check(rows() === afterFirst, '★第二次**行数不变**(撤下是留痕不删 ⇒ 重复入库的代价是永久的)');
  // 存储层的直接判据(幂等的本体在 create 里,不在导入层)。
  // ⚠️ 喂给 store.create 的必须是**条目**,不是候选:`cand()` 产出的是导入层对象(带 locator/evidence/…),
  //    直接递给 create 会(**正确地**)报 unknown_field —— 导入层字段进 create 前先剥掉那张表
  //    (commitImport 同款做法;这正是"只剥导入层、其余原样交 create 判"的口径)。
  const asItem = (c) => {
    const out = {};
    for (const [k, v] of Object.entries(c)) if (!lib.IMPORT_ONLY_KEYS.includes(k)) out[k] = v;
    return out;
  };
  const mk = lib.importKey(H, 'zz');
  const c1 = store.create(asItem(cand(E, '3', { import_key: mk })));
  check(c1.ok === true, 'store.create 接受 import_key(实际 ' + JSON.stringify(c1).slice(0, 160) + ')');
  const c2 = store.create(asItem(cand(E, '3', { import_key: mk })));
  check(c2.ok === false && c2.reason === 'duplicate_import',
    '★同 import_key 再 create ⇒ duplicate_import(实际 ' + JSON.stringify(c2).slice(0, 160) + ')');
  const c3 = store.create(asItem(cand(E, '3', { import_key: mk + '-other' })));
  check(c3.ok === true, '换一个 import_key 照常入库(去重认的是键,不是"内容一样就拒")');
  // 修订**不继承**导入键:否则导入过的条目一旦修订,新版本会被旧版占着的键挡住(永远无法修订)。
  const c4 = store.revise(c1.item.id, asItem(cand(E, '3', { body: '改过的正文', import_key: mk })), c1.item.content_hash);
  check(c4.ok === false && c4.reason === 'readonly_field',
    '★修订时给 import_key ⇒ readonly_field(不继承导入键;实际 ' + JSON.stringify(c4).slice(0, 160) + ')');
  const c5 = store.revise(c1.item.id, asItem(cand(E, '3', { body: '改过的正文' })), c1.item.content_hash);
  check(c5.ok === true, '不给 import_key 的修订照常成功(实际 ' + JSON.stringify(c5).slice(0, 160) + ')');
  check(c5.ok === true && c5.item.import_key === null, '★新版本**不带**导入键(实际 ' + JSON.stringify(c5.ok ? c5.item.import_key : null) + ')');
  check(c5.ok === true && c1.item.import_key === mk, '旧版仍持有原键(留痕;重复导入照旧被挡)');
}

// ══ 6) §9.6 模型幻觉:定位对不上 ⇒ 被第 1 道闸拦下 ════════════════════════════════════
section('6) §9.6 模型幻觉(含"确有本事的模型"这个正对照)');
if (hasModule('§9.6')) {
  const halluc = await lib.analyzeImport(A.payload, {
    today: TODAY, model: async () => ([{
      locator: '2', evidence: '这个值原文里没有', title: '编的', body: '编的值',
      category: 'standard-value', source_kind: 'manual', source_ref: A.name + '#2', as_of: TODAY,
    }]),
  });
  check(halluc.stats && halluc.stats.model_used === true, 'stats.model_used=true(用过模型就如实说)');
  const mc = (halluc.candidates || []).find((c) => c.origin === 'model');
  check(!!mc, '模型提的候选在册且 origin=model(实际 ' + JSON.stringify((halluc.candidates || []).map((c) => c.origin)) + ')');
  check(mc && mc.locator_verified === false && (mc.issues || []).includes('evidence_not_found'),
    '★模型编的值被第 1 道闸拦下(实际 ' + JSON.stringify(mc && { v: mc.locator_verified, i: mc.issues }) + ')');
  check(mc && mc.selected === false, '★编的那条默认不勾选');
  // 正对照:同一位置给**真的**原文片段 ⇒ 必须通过(否则"拦下"可能只是"全都拦")
  const honest = await lib.analyzeImport(A.payload, {
    today: TODAY, model: async () => ([{
      locator: '2', evidence: A.rows[1].join(','), title: '诚实条目', body: A.rows[1].join(','),
      category: 'standard-value', source_kind: 'manual', source_ref: A.name + '#2', as_of: TODAY,
    }]),
  });
  const hc = (honest.candidates || []).find((c) => c.origin === 'model');
  check(hc && hc.locator_verified === true && hc.selected === true,
    '正对照:定位对得上的模型候选**通过**(实际 ' + JSON.stringify(hc && { v: hc.locator_verified, s: hc.selected }) + ')');
  const noModel = await lib.analyzeImport(A.payload, { today: TODAY });
  check(noModel.stats && noModel.stats.model_used === false, '没给 model ⇒ model_used=false(不许假称用过模型)');
}

// ══ 7) §9.7 空表:只有表头 ⇒ "没有候选",不是"导入成功 0 条" ══════════════════════════
section('7) §9.7 空表(只有表头 / 空文本)');
if (hasModule('§9.7')) {
  const before = rows();
  const headerOnly = await lib.analyzeImport(source('empty.csv', [HEADER]).payload, { today: TODAY });
  check(headerOnly.ok === true && headerOnly.candidates.length === 0, '★只有表头 ⇒ ok:true 且**零候选**');
  check(headerOnly.stats && Number(headerOnly.stats.candidates) === 0, 'stats.candidates=0(如实说"没有候选")');
  check(!('committed' in headerOnly) && !JSON.stringify(headerOnly).includes('"committed"'),
    '★分析回执**不带**入库词汇(不许把"没有候选"说成"导入成功 0 条")');
  const emptyText = await lib.analyzeImport({ kind: 'text', name: '空文本', text: '   \n  \n' }, { today: TODAY });
  check(emptyText.ok === true && emptyText.candidates.length === 0, '空/纯空白文本 ⇒ 零候选(不是抛错)');
  check(rows() === before, '这一节同样零写入');
}

// ══ 8) 迁移自证(schema v1 → v2)与"不许静默改库" ═══════════════════════════════════════
section('8) schema v1→v2:老库必须被**显式迁移**,不认识的版本必须**抛**');
// v1 的建表语句**逐字抄自**当前 library-store.js 的 SCHEMA_DDL(没有 import_key 那一版)——
// 不拿"当前代码"去造 v1 库:那样等代码升到 v2 时,这个测试会拿 v2 库冒充 v1 而变空转。
const V1_DDL = `CREATE TABLE IF NOT EXISTS library_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS library_item (
  id               TEXT PRIMARY KEY,
  lineage_id       TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  previous_id      TEXT NOT NULL DEFAULT '',
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  category         TEXT NOT NULL,
  source_kind      TEXT NOT NULL,
  source_ref       TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  version          TEXT,
  conditions       TEXT,
  check_spec       TEXT,
  content_hash     TEXT NOT NULL,
  checked_state    TEXT NOT NULL DEFAULT '',
  checked_at       TEXT,
  superseded_by    TEXT NOT NULL DEFAULT '',
  withdrawn_at     TEXT,
  withdrawn_reason TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);`;
const OLD_ID = 'lib:11111111-1111-4111-8111-111111111111';
const oldDb = join(tmp, 'legacy-v1.db');
{
  const raw = new DatabaseSync(oldDb);
  raw.exec(V1_DDL);
  raw.prepare('INSERT INTO library_meta(key,value) VALUES(?,?)').run('schema_version', '1');
  raw.prepare(`INSERT INTO library_item
    (id,lineage_id,revision,previous_id,title,body,category,source_kind,source_ref,as_of,
     version,conditions,check_spec,content_hash,checked_state,checked_at,superseded_by,
     withdrawn_at,withdrawn_reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    OLD_ID, OLD_ID, 1, '', '老库里的条目', '正文', 'standard-value', 'standard', 'GB/T 1800.1-2020', '2020-03-31',
    null, null, null, 'sha256:' + 'a'.repeat(64), '', null, '', null, null,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  raw.close();
}
check(Number(LIBRARY_STORE_SCHEMA_VERSION) === 2, '本版 schema_version 常量是 2(实际 ' + LIBRARY_STORE_SCHEMA_VERSION + ')');
let migrated = null;
let migrateErr = null;
try { migrated = new LibraryStore(oldDb); } catch (e) { migrateErr = e; }
check(!migrateErr, '★老库(v1)能被本版打开(实际抛:' + (migrateErr && migrateErr.message) + ')');
if (migrated) {
  const cols = migrated.db.prepare('PRAGMA table_info(library_item)').all().map((c) => c.name);
  check(cols.includes('import_key'), '★迁移后 library_item 有 import_key 列(实际缺)');
  check(migrated.db.prepare('SELECT value FROM library_meta WHERE key=?').get('schema_version').value === '2',
    '★迁移后 schema_version 前进到 2');
  check(migrated.stats().items.total === 1 && migrated.stats().schema_version === 2,
    '★老数据还在(1 行),没有重建库');
  check(migrated.get(OLD_ID).ok === true, '老行照常读得出来');
  migrated.close();
}
// 反向:不认识的版本**必须**拒绝(这条今天就是绿的 —— 它是"不许被削弱"的护栏)
const futureDb = join(tmp, 'future-v99.db');
{
  const raw = new DatabaseSync(futureDb);
  raw.exec(V1_DDL);
  raw.prepare('INSERT INTO library_meta(key,value) VALUES(?,?)').run('schema_version', '99');
  raw.close();
}
let futureThrew = null;
try { new LibraryStore(futureDb).close(); } catch (e) { futureThrew = e; }
check(!!futureThrew, '★schema_version=99 的老库 ⇒ **抛**(不认识的库不许就地改写)');

// ══ 9) 限额键名与默认值(契约 §7 的数**逐字**钉住;双限两把尺都要在)════════════════════
section('9) 限额:规范键名 + 契约默认值(条数 × 字节两把尺)');
const lim = normalizeLibraryLimits({});
for (const [key, want] of [
  ['importBatchMaxItems', 200], ['importBatchMaxBytes', 3145728],
  ['importTextMaxBytes', 1048576], ['importCandidateMaxBytes', 65536], ['importModelMaxItems', 60],
]) {
  check(Number(lim[key]) === want, 'library.limits.' + key + ' 默认 ' + want + '(实际 ' + lim[key] + ')');
}
let limErr = null;
try { normalizeLibraryLimits({ importBatchMaxItems: 5, importModelMaxItems: 3 }); } catch (e) { limErr = e; }
check(!limErr, '配置面接受这五个键(实际 ' + (limErr && limErr.message) + ')');

// ══ 10) HTTP 面:两条写面进 POST_ONLY + 严格载荷 + analyze 走 HTTP 也不写库 ════════════
section('10) HTTP:POST_ONLY 两条 / 严格 body / 走 HTTP 的 analyze 同样零写入');
if (hasModule('HTTP 面')) {
  const adapter = {
    limits: store.limits,
    status: () => ({ ok: true, ...store.stats() }),
    analyzeImport: (input, opts) => lib.analyzeImport(input, opts),
    commitImport: (payload) => lib.commitImport(store, payload),
    close: async () => {},
  };
  const routes = new Map();
  const webServer = { register: (r) => { routes.set(r.path, r.handler); return () => routes.delete(r.path); } };
  // 一个**确定没人监听**的端口:绑一下拿到号再关掉 —— 用它当"小助手不可达"的确定性来源
  // (比写死 127.0.0.1:9 稳:真实机器上端口占用情况不是本测试能假设的)。
  const probeSrv = createServer(() => {});
  probeSrv.listen(0, '127.0.0.1');
  await once(probeSrv, 'listening');
  const deadPort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(() => r()));
  const httpSettings = {
    get: () => ({
      guard: { enforce: false },
      assistant: { baseUrl: 'http://127.0.0.1:' + deadPort, model: 'dead-assistant' },
    }),
  };
  const { registerApi } = await imp('lib/host/api.js');
  const dispose = registerApi({ get: () => webServer },
    { gate: {}, memory: { kvSet() {}, listOverviews: () => [], fingerprint: () => '' },
      settings: httpSettings, library: adapter },
    { version: 'test-1.7-import' });
  const server = createServer((req, res) => {
    const p = String(req.url || '').split('?')[0];
    const h = routes.get(p);
    if (!h) { res.statusCode = 404; res.end('{"ok":false,"reason":"no-route"}'); return; }
    h(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 照测 */ }
    return { status: res.status, json, text };
  };
  const ANA = '/api/dsh-ling/library/import/analyze';
  const COM = '/api/dsh-ling/library/import/commit';
  check(routes.has(ANA) && routes.has(COM),
    '两条导入路由在册(实际 ' + [...routes.keys()].filter((k) => k.includes('import')).join(', ') + ')');
  for (const p of [ANA, COM]) {
    const r = await call('GET', p);
    check(r.status === 405 && r.json && r.json.want === 'POST',
      '写面 GET ⇒ 405 want:POST:' + p + '(实际 ' + r.status + '/' + JSON.stringify(r.json) + ')');
  }
  const before = rows();
  const ra = await call('POST', ANA, A.payload);
  check(ra.status === 200 && ra.json && ra.json.ok === true && Array.isArray(ra.json.candidates),
    'POST analyze ⇒ 200(实际 ' + ra.status + '/' + ra.text.slice(0, 120) + ')');
  check(rows() === before, '★走 HTTP 的 analyze 同样零写入(' + before + ' → ' + rows() + ')');
  const rUnk = await call('POST', ANA, { ...A.payload, extra: 1 });
  check(rUnk.status === 400 && rUnk.json && rUnk.json.reason === 'unknown-field',
    'analyze 未知 body 字段 ⇒ 400 unknown-field(实际 ' + rUnk.status + '/' + (rUnk.json && rUnk.json.reason) + ')');
  // SQLite 通道(路 A,D14,2026-10-15):`path` / `table` 进白名单(**不许**当 unknown-field 拒),
  // 且**只对 kind=sqlite 有意义** —— 别的通道带上它就是参数错(静默丢参数正是复核 §11.6 A.3 点名的坑)。
  const rPathCsv = await call('POST', ANA, { ...A.payload, path: 'C:/x.db' });
  check(rPathCsv.status === 400 && rPathCsv.json && rPathCsv.json.reason === 'param-not-applicable',
    '★kind=csv 带 path ⇒ 400 param-not-applicable(实际 ' + rPathCsv.status + '/' + (rPathCsv.json && rPathCsv.json.reason) + ')');
  const rPathBad = await call('POST', ANA, { kind: 'sqlite', name: '源库', path: 123, table: 't' });
  check(rPathBad.status === 400 && rPathBad.json && rPathBad.json.reason === 'path-invalid',
    'path 不是字符串 ⇒ 400 path-invalid(实际 ' + rPathBad.status + '/' + (rPathBad.json && rPathBad.json.reason) + ')');
  const rSqlite = await call('POST', ANA, { kind: 'sqlite', name: '源库', path: 'C:/x.db', table: 't' });
  check(rSqlite.status === 503 && rSqlite.json && rSqlite.json.reason === 'sqlite_unavailable',
    '★kind=sqlite 带 path/table ⇒ 过路由(不是 unknown-field),由分析层如实说"没接线"(实际 '
    + rSqlite.status + '/' + (rSqlite.json && rSqlite.json.reason) + ')');
  // 模型段的三档(2026-10-12):不传 / 传空串 / 传合法值 / 传非法值 —— 四态各判一次
  const rNoModel = await call('POST', ANA, { ...A.payload, model: '' });
  check(rNoModel.status === 200 && rNoModel.json && rNoModel.json.ok === true
    && rNoModel.json.stats && rNoModel.json.stats.model_used === false,
    '★model 空串 = 不调模型(零额度、零等待;实际 ' + rNoModel.status + '/' + JSON.stringify(rNoModel.json && rNoModel.json.stats) + ')');
  const rBadModel = await call('POST', ANA, { ...A.payload, model: 'nope' });
  check(rBadModel.status === 400 && rBadModel.json && rBadModel.json.reason === 'model-invalid',
    '★model 值不合法 ⇒ 400 model-invalid(不许静默回落成"没选模型";实际 ' + rBadModel.status + '/' + (rBadModel.json && rBadModel.json.reason) + ')');
  // D11 放行(2026-10-14):小助手不可达 ⇒ **不再 503 整发失败**,改成 200 + 显式标注的降级回执。
  const rDead = await call('POST', ANA, { ...A.payload, model: 'assistant' });
  check(rDead.status === 200 && rDead.json && rDead.json.ok === true
    && rDead.json.stats && rDead.json.stats.model_used === false && rDead.json.stats.model_error
    && rDead.json.stats.model === null
    && Array.isArray(rDead.json.candidates) && rDead.json.candidates.length > 0,
    '★小助手不可达 ⇒ 200 + 降级回执(规则段候选照给、model_error 显式标注、model 为 null;实际 '
    + rDead.status + '/' + JSON.stringify(rDead.json && rDead.json.stats && {
      model_used: rDead.json.stats.model_used,
      model: rDead.json.stats.model,
      err: rDead.json.stats.model_error && rDead.json.stats.model_error.message,
    }) + ')');
  check(rows() === before, '★带模型的三趟 analyze 同样零写入(' + before + ' → ' + rows() + ')');
  const rBad = await call('POST', COM, '{oops');
  check(rBad.status === 400 && rBad.json && rBad.json.reason === 'bad-json', '坏 JSON ⇒ 400 bad-json(不是 500)');
  const rc = await call('POST', COM, { source_hash: lib.importSourceHash(F.payload.text), items: [cand(F, '2')] });
  check(rc.status === 200 && rc.json && rc.json.committed === 1,
    'POST commit ⇒ 200 committed=1(实际 ' + rc.status + '/' + rc.text.slice(0, 140) + ')');
  check(Number(rc.json.committed) + Number(rc.json.skipped) + (rc.json.rejected || []).length === 1,
    '★HTTP 回执同样总数自洽');
  const afterCommit = rows();
  check(afterCommit === before + 1, 'HTTP commit 真落库 1 行(' + before + ' → ' + afterCommit + ')');
  const g = await call('GET', COM);
  check(g.status === 405 && rows() === afterCommit, '405 那次没有任何写入(行数仍是 ' + afterCommit + ')');
  // 分段/翻页口(D12,2026-10-13):offset 非法 ⇒ 400;合法 ⇒ 回执带 offset / units_total / next_offset
  const rOffBad = await call('POST', ANA, { ...A.payload, offset: -1 });
  check(rOffBad.status === 400 && rOffBad.json && rOffBad.json.reason === 'offset-invalid',
    '★offset 非法 ⇒ 400 offset-invalid(不许静默当 0 —— 把"第 2 页"悄悄换成第 1 页是最坏的一种回执;实际 '
    + rOffBad.status + '/' + (rOffBad.json && rOffBad.json.reason) + ')');
  const rOff0 = await call('POST', ANA, { ...A.payload, offset: 0 });
  check(rOff0.status === 200 && rOff0.json && rOff0.json.stats
    && rOff0.json.stats.units_total === A.rows.length - 1 && rOff0.json.stats.next_offset === null,
    'HTTP 首页:units_total = 数据行数、取完 ⇒ next_offset=null(实际 ' + JSON.stringify(rOff0.json && rOff0.json.stats) + ')');
  // JSON 通道(2026-10-15):走 HTTP 的两态 —— 合法源 ⇒ 200(形态如实回);坏源 ⇒ 400 + 如实报错。
  // 这条判据的价值在于"**端到端**":body 白名单 / kind 透传 / `libraryHttpStatus` 落码三处任一被改坏,这里都会红。
  const jOk = await call('POST', ANA, {
    kind: 'json', name: 'http.json',
    text: '[{"title":"甲","body":"一"},{"title":"乙","body":"二"}]',
  });
  check(jOk.status === 200 && jOk.json && jOk.json.ok === true
    && jOk.json.stats && jOk.json.stats.json_form === 'array'
    && Array.isArray(jOk.json.candidates) && jOk.json.candidates.length === 2
    && jOk.json.candidates.every((c) => c.locator_verified === true),
    '★HTTP:kind=json ⇒ 200 且 stats.json_form=array(实际 ' + jOk.status + '/' + JSON.stringify(jOk.json && jOk.json.stats) + ')');
  const jBad = await call('POST', ANA, { kind: 'json', name: 'http.json', text: '{"a": 1} trailing' });
  check(jBad.status === 400 && jBad.json && jBad.json.reason === 'invalid_json'
    && String(jBad.json.message).indexOf('(1:10)') > 0,
    '★HTTP:坏 JSON ⇒ 400 invalid_json 且坐标准(1:10;不是 500、也不是"0 个候选";实际 '
    + jBad.status + '/' + (jBad.json && jBad.json.reason) + '/' + (jBad.json && jBad.json.message) + ')');
  const jNoPos = await call('POST', ANA, { kind: 'json', name: 'http.json', text: '{"a":}' });
  check(jNoPos.status === 400 && jNoPos.json && jNoPos.json.reason === 'invalid_json'
    && !/\(\d+:\d+\)/.test(String(jNoPos.json.message)),
    '★HTTP:拿不到位置时**不写坐标**(不许印假的 1:1;实际 ' + jNoPos.status + '/' + String(jNoPos.json && jNoPos.json.message) + ')');
  check(rows() === afterCommit, '★两趟 JSON analyze 同样零写入(' + afterCommit + ' → ' + rows() + ')');
  try { server.closeAllConnections?.(); } catch { /* 老 Node 没有这个方法 */ }
  await new Promise((r) => server.close(() => r()));
  dispose();
}

// ══ 11) 模型段接线(契约 §11.1「导入栏同款选择器」;2026-10-12 随面板导入面同批)══════════
section('11) 模型段接线(两档引擎 / 送模型条数上限 / 幻觉仍被拦 / 失败不冒充成功)');
let eng = null;
let engErr = null;
try { eng = await imp('lib/host/library-import-engine.js'); } catch (e) { engErr = e; }
if (!eng) {
  check(false, '11 —— lib/host/library-import-engine.js 还没实现(' + (engErr && (engErr.code || engErr.message)) + ')');
} else {
  // 引擎 A「本机小助手」:桩掉全局 fetch,把**请求体**记下来(零真实网络)。
  // 为什么连请求体一起断言:关思考只有一条实测有效的路(`think:false` + 原生端点),
  // 而"模型来源不另配一套"也必须能被看出来 —— 改了 settings.assistant,请求就得跟着改。
  const realFetch = globalThis.fetch;
  const seen = [];
  let reply = '';
  let boom = null;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { /* 非 JSON 照记 */ }
    seen.push({ url: String(url), body });
    if (boom) throw new Error(boom);
    return { ok: true, json: async () => ({ message: { content: reply } }) };
  };
  const settings = { get: () => ({ assistant: { baseUrl: 'http://127.0.0.1:9/zzz', model: 'qwen-test' } }) };
  try {
    const built = eng.makeImportModelHook({ engine: 'assistant', ctx: {}, settings });
    check(typeof built.hook === 'function' && built.label === 'assistant:qwen-test',
      'assistant 引擎的 label 取 settings.assistant.model(实际 ' + String(built && built.label) + ')');

    const line2 = A.rows[1].join(',');
    reply = JSON.stringify([
      { locator: '2', title: 'H7 基准孔公差带', body: line2, category: 'standard-value', source_kind: 'standard', as_of: TODAY, evidence: line2 },
      { locator: '99', title: '编的定位', body: line2, category: 'standard-value', source_kind: 'standard', as_of: TODAY, evidence: line2 },
    ]);
    seen.length = 0;
    const out = await lib.analyzeImport(A.payload, { today: TODAY, model: built.hook, modelLabel: built.label });
    check(out && out.ok === true && out.stats && out.stats.model_used === true && out.stats.model === 'assistant:qwen-test',
      '★模型真跑了 ⇒ 回执如实写 model_used + 模型名(实际 ' + JSON.stringify(out && out.stats) + ')');
    check(out && out.candidates.some((c) => c.origin === 'model' && c.locator === '2' && c.locator_verified === true && c.selected === true),
      '★模型段产出的候选进结果、定位回查通过、默认勾上');
    const bogus = out ? out.candidates.filter((c) => c.locator === '99') : [];
    check(bogus.length > 0 && bogus.every((c) => c.locator_verified === false && c.selected === false),
      '★模型编的 locator ⇒ 定位回查失败、默认不勾(第 1 道闸拦下)');
    const req = seen[0] || {};
    check(/\/api\/chat$/.test(String(req.url)), '走**原生** /api/chat(兼容端点不认 think:false):' + String(req.url));
    check(req.body && req.body.think === false, '★think:false(实测唯一有效的关思考路径)');
    const prompt = req.body && Array.isArray(req.body.messages) ? String(req.body.messages[1].content) : '';
    check(prompt.includes('locator=2 | ') && prompt.includes('locator=4 | '),
      'prompt 逐行带上 locator= 前缀(模型才知道该照抄什么)');

    // 送模型条数上限:超出的行**只走规则段**,回执必须说出来(不许静默截)
    seen.length = 0;
    reply = '[]';
    const capped = await lib.analyzeImport(A.payload, {
      today: TODAY, model: built.hook, modelLabel: built.label,
      limits: { ...DEFAULT_LIBRARY_LIMITS, importModelMaxItems: 1 },
    });
    const capPrompt = seen[0] && seen[0].body && Array.isArray(seen[0].body.messages) ? String(seen[0].body.messages[1].content) : '';
    check(seen.length === 1 && capPrompt.includes('locator=2 | ') && !capPrompt.includes('locator=3 | '),
      '★importModelMaxItems=1 ⇒ 只把第 1 行送模型(实际送了 ' + seen.length + ' 次)');
    check(capped && capped.stats && capped.stats.model_rows === 1 && capped.stats.model_rows_capped === true,
      '★被截的条数如实进回执(实际 ' + JSON.stringify(capped && capped.stats) + ')');

    // 失败路径:非 JSON / 端点不可达 —— **都走降级回执**(D11 放行,2026-10-14)
    // 三件套缺一不可:①ok:true(降级不等于失败)②model_used:false + model:null(不许声称模型成功)
    // ③model_error 在场(显式标注)④规则段候选照给(降级不是空手)。
    reply = '对不起,我做不了这个。';
    const bad = await lib.analyzeImport(A.payload, { today: TODAY, model: built.hook, modelLabel: built.label });
    check(bad && bad.ok === true && bad.stats && bad.stats.model_used === false && bad.stats.model === null,
      '★模型回非 JSON ⇒ 降级回执:ok:true + model_used:false + model:null(实际 '
      + JSON.stringify(bad && { ok: bad.ok, stats: bad.stats && { model_used: bad.stats.model_used, model: bad.stats.model } }) + ')');
    check(bad && bad.stats && bad.stats.model_error && bad.stats.model_error.message
      && bad.stats.model_error.engine === built.label && bad.stats.model_error.rows_offered >= 1,
      '★降级必须**显式标注**:model_error 带原因 + 引擎名 + 送过几行(实际 ' + JSON.stringify(bad && bad.stats && bad.stats.model_error) + ')');
    check(bad && Array.isArray(bad.candidates) && bad.candidates.length >= 3
      && bad.candidates.every((c) => c.origin === 'rule'),
      '★降级不是空手:规则段候选照常给、且**不带**任何模型产出(实际 ' + ((bad && bad.candidates) || []).length + ' 条)');
    boom = 'ECONNREFUSED';
    const down = await lib.analyzeImport(A.payload, { today: TODAY, model: built.hook, modelLabel: built.label });
    check(down && down.ok === true && down.stats && down.stats.model_error
      && String(down.stats.model_error.message).includes('ECONNREFUSED'),
      '小助手不可达 ⇒ 同样降级(原话进 model_error;既不静默退回规则段,也不整发失败):'
      + JSON.stringify(down && down.stats && down.stats.model_error && down.stats.model_error.message));
    boom = null;

    // 引擎 B「当前全局大模型」:桩 ctx.llm.stream(跟随当前选择,不自己指定模型)
    const gline = A.rows[2].join(',');
    const gpayload = JSON.stringify([{ locator: '3', title: 'h6 基准轴公差带', body: gline, category: 'standard-value', source_kind: 'standard', as_of: TODAY, evidence: gline }]);
    const gctx = {
      get(name) {
        if (name === 'llm') {
          return { stream: () => (async function* gen() { yield { type: 'text-delta', text: gpayload }; })() };
        }
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) };
        return undefined;
      },
    };
    const gBuilt = eng.makeImportModelHook({ engine: 'global', ctx: gctx, settings });
    check(gBuilt.label === 'global:deepseek-official/deepseek-v4-flash',
      'global 引擎的 label 如实写出跟随到的 provider/model(实际 ' + String(gBuilt.label) + ')');
    const gout = await lib.analyzeImport(A.payload, { today: TODAY, model: gBuilt.hook, modelLabel: gBuilt.label });
    check(gout && gout.ok === true && gout.candidates.some((c) => c.origin === 'model' && c.locator === '3' && c.locator_verified === true),
      '★global 引擎同样产出可回查的候选(实际 ' + JSON.stringify(gout && { ok: gout.ok, reason: gout.reason }) + ')');
    check(eng.IMPORT_ENGINES.join(',') === 'assistant,global', '两档引擎名与 UI 的 makeSel 两项逐字一致(实际 ' + eng.IMPORT_ENGINES.join(',') + ')');
    let threw = false;
    try { eng.makeImportModelHook({ engine: 'nope', ctx: {}, settings }); } catch { threw = true; }
    check(threw, '未知引擎 ⇒ 抛(HTTP 层另有 model-invalid 400)');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ══ 12) 模型段**分批**(2026-10-13 定;D10:2048 token 的回复预算装不下 60 行)════════════
// 为什么必须有这一节:真机实测 10 行过、**20 行必炸**(回复被 maxTokens 截断 ⇒ 没有收尾的 `]`
// ⇒ parse 报"没回 JSON 数组"⇒ 整发 analyze 503,**连规则段候选一起丢**)。这一节钉的就是
// "每批几行 / 批序拼回 / 批数如实进回执 / 中途炸了不许冒充成功"。
section('12) 模型段分批:每批 ≤10 行 / 批序拼回 / 批数如实进回执 / 中途失败仍不冒充成功');
if (!eng) {
  check(false, '12 —— lib/host/library-import-engine.js 没装上,分批判据无从谈起');
} else {
  const chunked = eng.chunkRows(Array.from({ length: 25 }, (_, i) => i + 1));
  check(chunked.length === 3 && chunked[0].length === 10 && chunked[1].length === 10 && chunked[2].length === 5,
    'chunkRows:25 行按 10 切 ⇒ 10 / 10 / 5(实际 ' + JSON.stringify(chunked.map((c) => c.length)) + ')');
  check(eng.IMPORT_MODEL_BATCH_ROWS === 10, '每批 10 行(真机实测的配平值,实际 ' + eng.IMPORT_MODEL_BATCH_ROWS + ')');
  check(eng.chunkRows([]).length === 0 && eng.chunkRows(null).length === 0, '空行表 / 非数组 ⇒ 0 批(一次都不调模型)');

  // 24 条数据行(表头 1 行 + 24 行)⇒ 预期 3 批:10 / 10 / 4
  const big = source('tolerance-many.csv', [HEADER].concat(
    Array.from({ length: 24 }, (_, i) => ['M' + (i + 1), '第 ' + (i + 1) + ' 条', 'v' + (i + 1), 'r']),
  ));
  const realFetch2 = globalThis.fetch;
  const calls = [];
  let midBad = false;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { /* 非 JSON 照记 */ }
    const text = body && Array.isArray(body.messages) ? String(body.messages[1].content) : '';
    const lines = text.split('\n').filter((l) => l.indexOf('locator=') === 0);
    calls.push({ lines: lines.length, text });
    if (midBad && calls.length === 2) return { ok: true, json: async () => ({ message: { content: '这一批我做不了。' } }) };
    const arr = lines.map((l) => {
      const rest = l.slice('locator='.length);
      const cut = rest.indexOf(' | ');
      const loc = cut < 0 ? rest : rest.slice(0, cut);
      const raw = cut < 0 ? '' : rest.slice(cut + 3);
      return { locator: loc, title: '第 ' + loc + ' 行', body: raw, category: 'standard-value', source_kind: 'manual', as_of: TODAY, evidence: raw };
    });
    return { ok: true, json: async () => ({ message: { content: JSON.stringify(arr) } }) };
  };
  try {
    const builtB = eng.makeImportModelHook({
      engine: 'assistant', ctx: {},
      settings: { get: () => ({ assistant: { baseUrl: 'http://127.0.0.1:9/zzz', model: 'qwen-test' } }) },
    });
    const bigOut = await lib.analyzeImport(big.payload, { today: TODAY, model: builtB.hook, modelLabel: builtB.label });
    check(calls.length === 3, '★24 条数据行 ⇒ 3 次调用(实际 ' + calls.length + ' 次)');
    check(calls.every((c) => c.lines >= 1 && c.lines <= eng.IMPORT_MODEL_BATCH_ROWS),
      '★每一批带的行数都 ≤ ' + eng.IMPORT_MODEL_BATCH_ROWS + '(实际 ' + JSON.stringify(calls.map((c) => c.lines)) + ')');
    check(calls[0].lines === 10 && calls[1].lines === 10 && calls[2].lines === 4,
      '★各批覆盖全部行、无重无漏:10 / 10 / 4(实际 ' + JSON.stringify(calls.map((c) => c.lines)) + ')');
    check(calls[0].text.includes('第 1 / 3 批') && calls[2].text.includes('第 3 / 3 批'),
      '多批时 prompt 写明"这是第几批"(否则模型会把行不全理解成该补全)');
    check(bigOut && bigOut.ok === true && bigOut.stats && bigOut.stats.model_batches === 3,
      '★批数如实进回执(实际 ' + JSON.stringify(bigOut && bigOut.stats) + ')');
    const mCands = bigOut ? bigOut.candidates.filter((c) => c.origin === 'model') : [];
    check(mCands.length === 24 && mCands.every((c) => c.locator_verified === true && c.selected === true),
      '★三批候选全部拼回、逐条过定位回查、默认勾上(实际 ' + mCands.length + ' 条)');

    // 单批:与分批前**逐字一致**(不多一次调用、prompt 不提"批"、回执不多一个字段)
    calls.length = 0;
    const small = await lib.analyzeImport(A.payload, { today: TODAY, model: builtB.hook, modelLabel: builtB.label });
    check(calls.length === 1 && !calls[0].text.includes('这一份是第'),
      '行数 ≤ 每批上限 ⇒ 一次调用、且 prompt 里**不提**批(老行为逐字不变;实际 ' + calls.length + ' 次)');
    check(small && small.stats.model_batches === undefined,
      '单批 ⇒ 回执里不出现 model_batches(实际 ' + JSON.stringify(small && small.stats) + ')');

    // 中途炸:第 2 批回非 JSON ⇒ **部分成功 + 显式标注**(D11 放行,2026-10-14)
    // 口径:①已跑成功的批**保留**(丢掉等于白烧额度)②**不再往后跑**(端点死了还硬跑剩余批 = 拿几倍超时
    // 换一份一样失败的账)③失败写进 model_error(带批号/总数/成功数)④回执里不许有"模型全跑完了"的口吻。
    calls.length = 0;
    midBad = true;
    const mid = await lib.analyzeImport(big.payload, { today: TODAY, model: builtB.hook, modelLabel: builtB.label });
    check(mid && mid.ok === true && mid.stats && mid.stats.model_error
      && Array.isArray(mid.stats.model_error.batches_failed)
      && mid.stats.model_error.batches_failed.join(',') === '2'
      && mid.stats.model_error.batches_total === 3 && mid.stats.model_error.batches_ok === 1,
      '★某一批炸了 ⇒ 部分成功 + 显式标注(失败批号 / 总批数 / 成功批数;实际 ' + JSON.stringify(mid && mid.stats && mid.stats.model_error) + ')');
    check(mid && Array.isArray(mid.candidates) && mid.candidates.filter((c) => c.origin === 'model').length === 10,
      '★已成功那批的候选**保留**(10 条模型候选),不被整段丢掉(实际 '
      + (mid && mid.candidates ? mid.candidates.filter((c) => c.origin === 'model').length : -1) + ' 条)');
    check(mid && mid.stats.model_used === true && mid.stats.model === builtB.label,
      '★部分成功照样如实写 model_used/model(标注靠 model_error,不靠把 model_used 说成 false)');
    check(mid && calls.length === 2,
      '★炸了就不往后跑:第 2 批失败后没再发第 3 批(实际发了 ' + calls.length + ' 次 = 成功 1 + 失败 1)');
    midBad = false;
  } finally {
    globalThis.fetch = realFetch2;
  }
}

// ══ 13) 分段/翻页口(D12,2026-10-13 定)════════════════════════════════════════════════
// 为什么必须有:1000 行的表原本只能交出前 200 条,而 **没有第二个口** —— 后 800 条物理上进不来。
// 这一节钉的是"一页多大 / 逐页不重不漏 / next_offset 自洽 / 模型段跟着同一个窗口"。
section('13) 分段取源:一页 = importBatchMaxItems / 逐页不重不漏 / next_offset 自洽 / 模型段同一窗口');
{
  const big13 = source('tolerance-page.csv', [HEADER].concat(
    Array.from({ length: 25 }, (_, i) => ['P' + (i + 1), '第 ' + (i + 1) + ' 条', 'v' + (i + 1), 'r']),
  ));
  const pageLimits = { ...DEFAULT_LIBRARY_LIMITS, importBatchMaxItems: 10 };
  const p1 = await lib.analyzeImport(big13.payload, { today: TODAY, limits: pageLimits });
  const p2 = await lib.analyzeImport(big13.payload, { today: TODAY, limits: pageLimits, offset: 10 });
  const p3 = await lib.analyzeImport(big13.payload, { today: TODAY, limits: pageLimits, offset: 20 });
  check(p1.ok && p1.candidates.length === 10 && p1.stats.offset === 0
    && p1.stats.units_total === 25 && p1.stats.next_offset === 10,
    '第 1 页:10 条 / offset=0 / units_total=25 / next_offset=10(实际 ' + JSON.stringify(p1.stats) + ')');
  check(p2.ok && p2.candidates.length === 10 && p2.stats.offset === 10 && p2.stats.next_offset === 20,
    '第 2 页接着来(offset=10 ⇒ next_offset=20;实际 ' + JSON.stringify(p2.stats) + ')');
  check(p3.ok && p3.candidates.length === 5 && p3.stats.next_offset === null, '最后一页:5 条 / next_offset=null');
  const locsOf = (p) => p.candidates.map((c) => c.locator);
  const all = new Set([...locsOf(p1), ...locsOf(p2), ...locsOf(p3)]);
  check(all.size === 25, '★三页拼起来 = 25 条,**不重不漏**(实际 ' + all.size + ' 条)');
  check(!p1.stats.dropped_by_batch_limit,
    '翻页之后不再报 dropped_by_batch_limit —— "还没取到的"不是"被丢掉的"(实际 ' + JSON.stringify(p1.stats) + ')');

  // 模型段必须跟同一窗口(两段各切各的 ⇒ "第 2 页"在两边会对不上)
  const seen13 = [];
  const realFetch13 = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let body = null;
    try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { /* 非 JSON 照记 */ }
    const text = body && Array.isArray(body.messages) ? String(body.messages[1].content) : '';
    seen13.push(text.split('\n').filter((l) => l.indexOf('locator=') === 0)
      .map((l) => l.slice('locator='.length).split(' | ')[0]));
    return { ok: true, json: async () => ({ message: { content: '[]' } }) };
  };
  try {
    const built13 = eng.makeImportModelHook({
      engine: 'assistant', ctx: {},
      settings: { get: () => ({ assistant: { baseUrl: 'http://127.0.0.1:9/zzz', model: 'qwen-test' } }) },
    });
    await lib.analyzeImport(big13.payload, {
      today: TODAY, limits: pageLimits, offset: 10, model: built13.hook, modelLabel: built13.label,
    });
    check(seen13.length === 1 && seen13[0].length === 10 && seen13[0][0] === '12' && seen13[0][9] === '21',
      '★模型段只吃本页窗口(第 2 页 = 源行 12..21;实际 ' + JSON.stringify(seen13[0]) + ')');
  } finally {
    globalThis.fetch = realFetch13;
  }
}

// ══ 14) JSON 类(2026-10-15):三形态自动判 / 原文保真 / 字段映射 / 拒法 / 分段 / 幂等 ══════════
// 这一节钉的是「选项文档 §11.2」那套口径 —— 尤其是**不许拿 JSON.stringify 的结果当原文**:
// 它必然假红(键序与空白会变样、整数样键会被重排),所以另有一个顶层元素边界扫描器。
section('14) JSON 类:三形态自动判 / 原文保真(不许 stringify) / 字段映射 / 拒法 / 分段 / 幂等');
if (hasModule('JSON')) {
  const J = (name, text) => ({ kind: 'json', name, text });
  const analyzeJson = (name, text, opts) => lib.analyzeImport(J(name, text), { today: TODAY, ...(opts || {}) });
  const locs = (r) => (r && r.ok ? r.candidates.map((c) => c.locator) : null);

  // ── 14.1 三形态自动判(+ 形态如实回在 stats.json_form)────────────────────────────────
  const jArr = '[\n  { "title": "公差带 H7", "body": "  螺纹公差 6g  " },\n  { "title": "公差带 h6", "body": "0/-0.009" }\n]';
  const a1 = await analyzeJson('spec.json', jArr);
  check(a1.ok === true && a1.stats.json_form === 'array', '数组形态判成 array(实际 ' + JSON.stringify(a1.stats && a1.stats.json_form) + ')');
  check(a1.ok && a1.candidates.length === 2, '数组 ⇒ 一个元素一条(实际 ' + ((a1.candidates || []).length) + ')');
  check(JSON.stringify(locs(a1)) === '["[1]","[2]"]', '★locator = [i](含方括号、1-based):' + JSON.stringify(locs(a1)));
  check(a1.ok && a1.candidates[0].source_ref === 'spec.json#[1]', 'source_ref = <name>#[i](实际 ' + (a1.ok ? a1.candidates[0].source_ref : '') + ')');
  check(a1.ok && a1.candidates.every((c) => c.locator_verified === true && c.selected === true), '★每个元素都过了定位回查(evidence 落在原文切片里)');
  check(a1.ok && a1.candidates[0].body === '  螺纹公差 6g  ',
    '★正文逐字保真(前后空白没被吃掉 ⇒ 没走 stringify 回查;实际 ' + JSON.stringify(a1.ok ? a1.candidates[0].body : '') + ')');

  // 反向硬证据:`JSON.parse` 会把**整数样键**重排(`{"10":…,"2":…}` ⇒ 解析后 2 排在 10 前面)
  // ⇒ "拿 stringify 的结果当原文"在这里必然暴露。注意**保真的落点是 evidence(回查用原文切片)**,
  // 不是 body —— body 是按解析结果重写的视图,而 JSON 本身也不保证对象键序。
  const rawOrder = '[{"10": "十", "2": "二", "z": "末"}]';
  const aOrder = await analyzeJson('order.json', rawOrder);
  const evOrder = aOrder.ok ? String(aOrder.candidates[0].evidence) : '';
  check(evOrder === '{"10": "十", "2": "二", "z": "末"}',
    '★回查用的原文切片**逐字**是源里那一段(键序/空白原样 —— 这正是不能用 stringify 当原文的原因):' + JSON.stringify(evOrder));
  check(aOrder.ok && aOrder.candidates[0].locator_verified === true, '★同上这条也过了定位回查(切片与证据同源)');
  const bodyOrder = aOrder.ok ? aOrder.candidates[0].body : '';
  check(bodyOrder.indexOf('10: 十') >= 0 && bodyOrder.indexOf('2: 二') >= 0,
    'body 是按解析结果重写的视图(整数样键的顺序随引擎):' + JSON.stringify(bodyOrder));

  const a2 = await analyzeJson('single.json', '{ "title": "整份一条", "body": "只有一个对象" }');
  check(a2.ok && a2.stats.json_form === 'object' && a2.candidates.length === 1,
    '单对象 ⇒ 整份一条(实际 ' + (a2.ok ? a2.stats.json_form + '/' + a2.candidates.length : a2.reason) + ')');
  check(a2.ok && a2.candidates[0].locator === '$' && a2.candidates[0].source_ref === 'single.json#$', '单对象的 locator / source_ref = $');

  const a3 = await analyzeJson('list.jsonl', '{ "title": "甲", "body": "一" }\n{ "title": "乙", "body": "二", "notes": "多一个键" }\n');
  check(a3.ok && a3.stats.json_form === 'jsonl' && a3.candidates.length === 2,
    'JSONL ⇒ 一行一条(实际 ' + (a3.ok ? a3.stats.json_form + '/' + a3.candidates.length : a3.reason) + ')');
  check(JSON.stringify(locs(a3)) === '["1","2"]', 'JSONL 的 locator = 裸行号(实际 ' + JSON.stringify(locs(a3)) + ')');
  check(a3.ok && a3.candidates[1].body.indexOf('notes: 多一个键') >= 0,
    '★JSONL 里没映射上的键进正文(不静默丢):' + JSON.stringify(a3.ok ? a3.candidates[1].body : ''));

  // ── 14.2 字段映射(直通 / 直通≠绕过校验 / 非标量 / 标量元素)──────────────────────────
  const a4 = await analyzeJson('full.json',
    '[{"title":"T","body":"B","category":"boundary","source_kind":"standard","source_ref":"GB/T 1-2020","as_of":"2020-01-01"}]');
  const c4 = a4.ok ? a4.candidates[0] : {};
  check(c4.title === 'T' && c4.body === 'B' && c4.category === 'boundary' && c4.source_kind === 'standard'
    && c4.source_ref === 'GB/T 1-2020' && c4.as_of === '2020-01-01',
    '★图书馆字段名直通:' + JSON.stringify({ title: c4.title, category: c4.category, source_kind: c4.source_kind, source_ref: c4.source_ref, as_of: c4.as_of }));
  check(Array.isArray(c4.issues) && c4.issues.length === 0 && c4.selected === true, '直通且字段面干净 ⇒ 默认勾选(实际 issues=' + JSON.stringify(c4.issues) + ')');

  const a5 = await analyzeJson('bad.json', '[{"title":"T","body":"B","category":"不存在的类目"}]');
  const c5 = a5.ok ? a5.candidates[0] : { issues: [] };
  check(c5.issues.indexOf('bad_category') >= 0 && c5.selected === false,
    '★直通≠绕过校验:类目值非法仍被字段闸拦下(实际 ' + JSON.stringify(c5.issues) + ')');
  const a5b = await analyzeJson('forge.json', '[{"title":"T","body":"B","checked_state":"verified"}]');
  const c5b = a5b.ok ? a5b.candidates[0] : {};
  check(c5b.checked_state === undefined, '★源里的 checked_state **不会**变成条目字段(实际 ' + JSON.stringify(c5b.checked_state) + ')');
  check(typeof c5b.body === 'string' && c5b.body.indexOf('checked_state: verified') >= 0, '它进正文里如实留着(不静默丢)');

  const a6 = await analyzeJson('nest.json', '[{"title":"T","spec":{"tol":0.02,"grade":"6g"},"tags":["机械","紧固件"]}]');
  const b6 = a6.ok ? a6.candidates[0].body : '';
  check(b6.indexOf('spec: {"tol":0.02,"grade":"6g"}') >= 0, '★非标量值用紧凑 JSON 进正文:' + JSON.stringify(b6));
  check(b6.indexOf('tags: ["机械","紧固件"]') >= 0, '数组值同样进正文(一个键都不丢)');
  const a6b = await analyzeJson('nest2.json', '[{"title":"T","body":"原样正文","x":1}]');
  const b6b = a6b.ok ? a6b.candidates[0].body : '';
  check(b6b.indexOf('原样正文') === 0 && b6b.indexOf('— 其他字段 —') > 0 && b6b.indexOf('x: 1') > 0,
    '★对象自带 body 时,其余键拼在正文后面(带分隔行,一样不丢):' + JSON.stringify(b6b));

  const a7 = await analyzeJson('scalars.json', '["标准 A","标准 B", 42]');
  check(a7.ok && a7.candidates.length === 3 && a7.candidates[0].body === '标准 A' && a7.candidates[2].body === '42',
    '★数组里是标量也照出候选(正文 = 紧凑字面量;实际 ' + JSON.stringify(a7.ok ? a7.candidates.map((c) => c.body) : null) + ')');
  check(a7.ok && a7.candidates[0].title === 'scalars.json 第 1 条', '标量元素标题取 <name> 第 N 条(实际 ' + JSON.stringify(a7.ok ? a7.candidates[0].title : '') + ')');

  // ── 14.3 空 / 拒法(一律点名,不静默)────────────────────────────────────────────────
  const a8 = await analyzeJson('empty.json', '[]');
  check(a8.ok === true && a8.candidates.length === 0 && a8.stats.units_total === 0,
    '★空数组 ⇒ "没有候选"(ok:true + 0 条,不是"导入成功 0 条";实际 ' + JSON.stringify(a8.ok ? a8.stats : a8.reason) + ')');
  for (const [label, text, reason] of [
    ['坏 JSON', '{"a": }', 'invalid_json'],
    ['HTML', '<html></html>', 'kind_mismatch'],
    ['顶层字符串', '"只是一句话"', 'json_not_object'],
    ['顶层 null', 'null', 'json_not_object'],
  ]) {
    const r = await analyzeJson('bad.json', text);
    check(r.ok === false && r.reason === reason, '拒法 ' + label + ' ⇒ ' + reason + '(实际 ' + JSON.stringify(r.reason) + ')');
  }
  // ⚠️ 消息里的 行:列 **只有拿得到时才写**(2026-10-15 复核后改):新版 V8 对最常见的语法错只回一句
  // 贴片段,消息里**根本没有** position ⇒ 老写法用它回落成 `(1:1)`,等于印一个自己不知道的坐标。
  // 所以这里判**两态**:拿不到 ⇒ 不许出现坐标;拿得到 ⇒ 坐标必须准。旧那条只验形状(`/\(\d+:\d+\)/`),
  // 恒真 —— jsonPos 永远回 `1:1` 也能过,正是它放过了这个 bug。
  const rMsg = await analyzeJson('bad.json', '{"a": }');
  check(!/\(\d+:\d+\)/.test(String(rMsg.message)),
    '★拿不到位置就**不写坐标**(不许印假的 (1:1);实际 ' + JSON.stringify(rMsg.message) + ')');
  const rPos = await analyzeJson('bad.json', '{"a": 1} trailing');
  check(String(rPos.message).indexOf('(1:10)') > 0,
    '★拿得到位置时写准坐标(1:10;实际 ' + JSON.stringify(rPos.message) + ')');
  const rDeep = await analyzeJson('deep.json', '['.repeat(40) + ']'.repeat(40));
  check(rDeep.ok === false && rDeep.reason === 'json_too_deep', '嵌套 40 层 ⇒ json_too_deep(实际 ' + JSON.stringify(rDeep.reason) + ')');
  const rBig = await analyzeJson('big.json', '[' + JSON.stringify({ body: 'x'.repeat(200) }) + ']',
    { limits: { ...DEFAULT_LIBRARY_LIMITS, importTextMaxBytes: 64 } });
  check(rBig.ok === false && rBig.reason === 'text_too_large', 'JSON 走同一把文本尺(超 importTextMaxBytes ⇒ 当场拒;实际 ' + JSON.stringify(rBig.reason) + ')');

  // ── 14.4 分段(尺切在"内容单元"= 数组元素上)──────────────────────────────────────────
  const five = JSON.stringify([1, 2, 3, 4, 5].map((i) => ({ title: 'T' + i, body: 'B' + i })));
  const pageJ = { ...DEFAULT_LIBRARY_LIMITS, importBatchMaxItems: 2 };
  const q1 = await lib.analyzeImport(J('five.json', five), { today: TODAY, limits: pageJ });
  const q2 = await lib.analyzeImport(J('five.json', five), { today: TODAY, limits: pageJ, offset: 2 });
  const q3 = await lib.analyzeImport(J('five.json', five), { today: TODAY, limits: pageJ, offset: 4 });
  check(q1.ok && q1.candidates.length === 2 && q1.stats.units_total === 5 && q1.stats.next_offset === 2,
    'JSON 也按内容单元分段(第 1 页 2 条 / units_total=5 / next_offset=2;实际 ' + JSON.stringify(q1.stats) + ')');
  check(q3.ok && q3.candidates.length === 1 && q3.stats.next_offset === null, '最后一页 1 条 / next_offset=null');
  const locJ = new Set([...q1.candidates, ...q2.candidates, ...q3.candidates].map((c) => c.locator));
  check(locJ.size === 5, '★三页拼起来 = 5 个元素,不重不漏(实际 ' + locJ.size + ')');

  // ── 14.5 幂等:locator 含方括号照样进键;同一份 JSON 再提交 ⇒ 全 skipped ────────────────
  const jKey = lib.importKey(lib.importSourceHash(five), '[3]');
  check(/^[0-9a-f]{16}:\[3\]$/.test(jKey), '★幂等键 = <16hex>:[3](locator 原样进键;实际 ' + jKey + ')');
  const JP = { kind: 'json', name: 'commit.json', text: '[{"title":"入库甲","body":"正文甲"},{"title":"入库乙","body":"正文乙"}]' };
  const ja = await lib.analyzeImport(JP, { today: TODAY });
  const items14 = ja.ok ? ja.candidates.map((c) => ({ ...c })) : [];
  const before14 = rows();
  const k1 = await lib.commitImport(store, { source_hash: ja.source_hash, items: items14 });
  check(k1.ok && k1.committed === 2 && k1.skipped === 0,
    'JSON 候选能入库(实际 ' + JSON.stringify({ committed: k1.committed, skipped: k1.skipped, rejected: k1.rejected }) + ')');
  const k2 = await lib.commitImport(store, { source_hash: ja.source_hash, items: items14 });
  check(k2.ok && k2.committed === 0 && k2.skipped === 2 && rows() === before14 + 2,
    '★同一份 JSON 再提交 ⇒ 全 skipped、行数不变(幂等键在 JSON 上也成立;实际 ' + JSON.stringify({ c: k2.committed, s: k2.skipped, rows: rows() }) + ')');

  // ── 14.7 扫描器硬案例(2026-10-15 复核点名:这些**一条都没被判据覆盖**)────────────────────
  // 存在的意义:顶层元素边界扫描器是"原文保真"的唯一实现,它切偏 = 证据全部假红/假绿。
  const hard = '[{"t":"带 ] 与 { 的正文","b":"a]b{c"}, {"t":"转义","b":"引号\\" 与反斜杠\\\\"}, [[1,2],[3,4]], "裸字符串", 42, null, {"t":"尾","b":"末"}]';
  const h1 = await analyzeJson('hard.json', hard);
  check(h1.ok && h1.candidates.length === 7 && JSON.stringify(locs(h1)) === '["[1]","[2]","[3]","[4]","[5]","[6]","[7]"]',
    '★串里的 ] 与 { 、转义引号、嵌套数组都切对(7 个元素;实际 ' + JSON.stringify(locs(h1)) + ')');
  check(h1.ok && h1.candidates.every((c) => c.locator_verified === true),
    '★七条 evidence 全部落回原文切片(切偏一条这里就红)');
  check(h1.ok && String(h1.candidates[1].body).indexOf('引号" 与反斜杠\\') > 0,
    '★转义原样保真(不是还原后再拼):' + JSON.stringify(h1.ok ? h1.candidates[1].body : ''));
  check(h1.ok && h1.candidates[2].body === '[[1,2],[3,4]]', '嵌套数组元素 ⇒ 正文取紧凑字面量(实际 ' + JSON.stringify(h1.ok ? h1.candidates[2].body : '') + ')');
  check(h1.ok && h1.candidates[5].issues.indexOf('empty_body') >= 0 && h1.candidates[5].selected === false,
    'null 元素 ⇒ empty_body 且默认不勾(不许造一条正文写着 "null" 的假条目)');
  const h2 = await analyzeJson('space.json', '[\n\t{"t":"甲"}\n ,  {"t":"乙"}\n]');
  check(h2.ok && JSON.stringify(locs(h2)) === '["[1]","[2]"]' && h2.candidates[0].evidence === '{"t":"甲"}',
    '★元素之间的空白/换行/制表符不进切片(实际 evidence=' + JSON.stringify(h2.ok ? h2.candidates[0].evidence : '') + ')');
  const h3 = await analyzeJson('emptystr.json', '["", "有内容"]');
  check(h3.ok && h3.candidates.length === 2 && h3.candidates[0].selected === false
    && h3.candidates[0].issues.indexOf('empty_body') >= 0 && h3.candidates[1].selected === true,
    '空串元素 ⇒ empty_body 不勾,但**照样出候选**(不静默吞;实际 ' + JSON.stringify(h3.ok ? h3.candidates.map((c) => c.selected) : null) + ')');

  // ── 14.8 BOM / CRLF / 空源(复核抓出的那条**真 bug**在这里被钉成回归)────────────────────
  const BOM = '\uFEFF';
  const bomArr = await analyzeJson('bom.json', BOM + '[{"t":"甲","b":"一"}]');
  const bomObj = await analyzeJson('bom.json', BOM + '{"t":"甲","b":"一"}');
  const bomJsonl = await analyzeJson('bom.jsonl', BOM + '{"t":"甲","b":"一"}\n{"t":"乙","b":"二"}');
  check(bomArr.ok && bomArr.stats.json_form === 'array', 'BOM + 数组 ⇒ 正常(实际 ' + JSON.stringify(bomArr.stats && bomArr.stats.json_form) + ')');
  check(bomObj.ok && bomObj.stats.json_form === 'object', 'BOM + 单对象 ⇒ 正常');
  check(bomJsonl.ok && bomJsonl.stats.json_form === 'jsonl' && bomJsonl.candidates.length === 2,
    '★BOM + JSONL ⇒ 正常(整份路径 trim 剥了 BOM、逐行路径原先没剥 ⇒ 同一通道两种行为;实际 '
    + JSON.stringify(bomJsonl.ok ? bomJsonl.stats.json_form : bomJsonl.reason) + ')');
  check(bomJsonl.ok && bomJsonl.candidates.every((c) => c.locator_verified === true),
    '★带 BOM 的 JSONL 逐条仍过定位回查(切片与证据同源)');
  const crlf = await analyzeJson('crlf.jsonl', '{"t":"甲"}\r\n{"t":"乙"}\r\n');
  check(crlf.ok && crlf.stats.json_form === 'jsonl' && crlf.candidates.length === 2, 'CRLF 的 JSONL 同样正常');
  for (const [label, t, reason] of [['空源', '', 'empty_source'], ['全空白', '   \n  ', 'empty_source']]) {
    const r = await analyzeJson('empty.json', t);
    check(r.ok === false && r.reason === reason, '拒法 ' + label + ' ⇒ ' + reason + '(实际 ' + JSON.stringify(r.reason) + ')');
  }
  // JSONL 口径**收紧**(2026-10-15 复核后定):一行必须是一个**对象**;数组/标量行 ⇒ 坏行并点名
  for (const [label, t] of [['数组行', '[1,2]\n{"t":"乙"}'], ['标量行', '1\n2']]) {
    const r = await analyzeJson('x.jsonl', t);
    check(r.ok === false && r.reason === 'invalid_json' && String(r.message).indexOf('第 1 行也不合法') > 0,
      '★JSONL ' + label + ' ⇒ invalid_json 且点名行号(实际 ' + JSON.stringify(r.reason) + ')');
  }

  // ── 14.9 check_spec / version / conditions 三个直通键(复核抓出的 gap)────────────────────
  const cspec = { type: 'code', path: 'GB-T1800.1.md', locator: { kind: 'lines', start: 3, end: 3 }, expected: '6g', comparison: 'text-lf' };
  const a9 = await analyzeJson('check.json', JSON.stringify([{ title: 'T', body: 'B', check_spec: cspec, version: '2020', conditions: { a: 1 } }]));
  const c9 = a9.ok ? a9.candidates[0] : {};
  check(JSON.stringify(c9.check_spec) === JSON.stringify(cspec),
    '★check_spec 直通成**条目字段**(它是机器可核对的那处比较;降级成正文 prose = 把核对变成人肉读;实际 ' + JSON.stringify(c9.check_spec) + ')');
  check(c9.version === '2020' && JSON.stringify(c9.conditions) === '{"a":1}',
    'version / conditions 同样直通(实际 ' + JSON.stringify({ v: c9.version, c: c9.conditions }) + ')');
  check(String(c9.body).indexOf('check_spec') < 0, '★直通之后不再往正文抄一份(实际 ' + JSON.stringify(String(c9.body)) + ')');

  // ── 14.10 JSON + 模型段(复核点名"完全没覆盖";这里钉住 u.m 那条喂给模型的原文线)──────────
  const mseen = [];
  const a10 = await lib.analyzeImport(J('m.json', '[{"t":"甲","b":"一"},{"t":"乙","b":"二"}]'), {
    today: TODAY,
    model: async (ctx) => {
      mseen.push(ctx.rows.map((r) => ({ locator: r.locator, text: r.text })));
      return ctx.rows.map((row) => ({
        locator: row.locator, title: '模型 ' + row.locator, body: String(row.text).trim(),
        evidence: String(row.text).trim(), category: 'standard-value', source_kind: 'manual',
        source_ref: 'm.json#' + row.locator, as_of: TODAY,
      }));
    },
  });
  check(a10.ok && a10.stats.model_used === true && a10.candidates.length === 4
    && JSON.stringify(locs(a10)) === '["[1]","[2]","[1]","[2]"]',
    '★JSON + 模型段:规则段与模型段各 2 条,locator 对得上(实际 ' + JSON.stringify(locs(a10)) + ')');
  check(a10.ok && a10.candidates.every((c) => c.locator_verified === true),
    '★模型段吃的是**原文切片** u.m(模型产的 [i] 候选能过定位回查;喂错东西这里必红)');
  check(mseen.length === 1 && mseen[0][0].text === '{"t":"甲","b":"一"}',
    '★送给模型的就是该元素的原文切片(实际 ' + JSON.stringify(mseen[0] && mseen[0][0] && mseen[0][0].text) + ')');

  // ── 14.6 静态护栏:每个 kind 都必须有**显式分支**(没分支 ⇒ 源会被静默按空行切碎)────────
  // 盯的是"给 IMPORT_KINDS 加值却忘了加分支"这个具体失误(选项文档 §11.6 A.1 点名过一次)。
  // 为什么用源码断言:这个失败模式**跑不出来**(加了值的那天才会显形),只能靠形状钉住。
  const srcImp = readFileSync(join(root, 'lib/host/library-import.js'), 'utf8');
  for (const k of lib.IMPORT_KINDS) {
    check(srcImp.includes("kind === '" + k + "'"),
      "★IMPORT_KINDS 的 '" + k + "' 在源码里有显式分支(没有 ⇒ 会静默落进文本分支)");
  }
  const tail = srcImp.slice(srcImp.indexOf("kind === 'text'"));
  check(/else \{[\s\S]*?reason: 'invalid_kind'/.test(tail),
    '★分发末尾的兜底 = **拒**(invalid_kind),不是落文本');
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────────────
try { store.close(); } catch { /* 已经关了就算了 */ }
if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome;
try { rmSync(tmp, { recursive: true, force: true }); } catch (e) { check(false, '临时目录清理失败:' + e.message); }
console.log('\n断言 ' + assertions + ' 条,失败 ' + failures + ' 条');
if (failures) {
  console.log('↑ 有红:导入通道的判据是逐条钉住的 —— 先看上面点名的那几节,再改代码。'
    + '别靠放宽断言让它变绿(§8 迁移自证与 §9.5 幂等是这套的骨头)。');
  process.exitCode = 1;
} else {
  console.log('✓ library-import 全部通过 —— 可以登记进 package.json 的 test 链了');
}
