// tests/library-sqlite.test.mjs — 1.7 图书馆 **SQLite 类接入通道**(`kind:'sqlite'`)专属判据套(2026-10-15)
//
// 逐条对应 1.7-library-import-design-options.md **§11.3** 与主人 2026-10-15 拍板的 **D13–D15**:
//   · 五条安全硬约束:只读打开 / **拒自噬**(本插件自己的库,含大小写等价) / 表必须显式选(不猜最大的表)
//     / 大表**不数总数** / 打不开如实说(非库 ⇒ not_sqlite,消息里点名加密库);
//   · 抽取形状:locator = `表名#键值`(主键值;无主键走 rowid;复合主键按 **pk 次序**连);
//   · 保真:evidence 逐字落回取源层预存的整行文本(`列=值` 拼成)⇒ `locator_verified:true`;
//   · 字段直通:列名命中图书馆字段名就直通(**与 JSON 共用同一份映射**),其余列进正文、一个键都不丢;
//   · 分页:窗口在 **SQL 层**(LIMIT/OFFSET)切,`units_total` 如实给 **null**(不跑 `COUNT(*)`),
//     `next_offset` 靠"多取一格"探出来;
//   · 幂等(D15):源摘要按**文件身份**(`realpath|size|mtimeMs`)算 ⇒ 同一份源翻几页都是同一个 import_key;
//   · 参数闸:`text` 与 `path` 同给 ⇒ 参数错;没注入取源 ⇒ `sqlite_unavailable`(接线问题要说清楚);
//   · **只读硬证据**:analyze 前后源库文件 sha256 **逐字节未变**(它不是"看着像读"的通道)。
//
// ⚠️ 本套**走真实 `LibraryRuntime`**(注入根白名单与自噬清单)—— 只测模块测不出接线错。
// ⚠️ HTTP 面(path/table 白名单、`param-not-applicable`)由 `library-api-tools.test.mjs` 覆盖,本套不重复。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

let assertions = 0;
let failures = 0;
const check = (cond, msg) => {
  assertions += 1;
  if (!cond) { failures += 1; console.log('✗ ' + msg); }
};
const section = (t) => console.log('▶ ' + t);

const tmp = mkdtempSync(join(tmpdir(), 'ling-lib-sqlite-'));
process.env.DSH_HOME = join(tmp, 'home');   // 隔离"每启动票据"的真机写入(与另几套同款)
const srcDir = join(tmp, 'sources');
const dataDir = join(tmp, 'data');
const dataDirP = join(tmp, 'dataP');
mkdirSync(srcDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(dataDirP, { recursive: true });

const src = join(srcDir, '源库.db');
const note = (dbPath) => dbPath;
// ── 素材源库:一张"列名命中图书馆字段"的表(std) + 一张纯业务表(plain) + 一个视图 + 一个垃圾文件 ──
{
  const d = new DatabaseSync(src);
  d.exec('CREATE TABLE std (id INTEGER PRIMARY KEY, title TEXT, body TEXT, category TEXT,'
    + ' source_kind TEXT, as_of TEXT, source_ref TEXT, qty INTEGER, note TEXT, big INTEGER, nul TEXT)');
  const ins = d.prepare('INSERT INTO std VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  ins.run(1, 'GB/T 1800.1-2020 极限与配合', '公差带与偏差的基准。', 'standard-value', 'standard',
    '2026-10-01', 'GB/T 1800.1-2020', 3, '螺纹 M8', 9223372036854775807n, null);
  ins.run(2, '第二行:只有标题与正文', '第二行正文。', null, null, null, null, 7, null, 1n, 'x');
  ins.run(3, null, '第三行没有标题(该由通道补一个能认出来的默认标题)。', null, null, null, null, 9, null, 2n, 'y');
  d.exec('CREATE TABLE plain (k TEXT, v TEXT)');
  d.exec("INSERT INTO plain VALUES ('甲','一'),('乙','二')");
  d.exec('CREATE VIEW vw AS SELECT * FROM std');
  d.close();
}
const junk = join(srcDir, '不是库.db');
writeFileSync(junk, Buffer.from('这不是 SQLite,只是一段普通文本', 'utf8'));

const { LibraryRuntime } = await imp('lib/host/library-runtime.js');
const { analyzeImport, IMPORT_KINDS } = await imp('lib/host/library-import.js');

// 根白名单**同时**登记源目录与数据目录 —— 后者是为了让"拒自噬"这条能真的走到(它排在根闸之后)。
const runtime = new LibraryRuntime(dataDir, { codeRoots: [srcDir, dataDir] });
const runtimeP = new LibraryRuntime(dataDirP, { codeRoots: [srcDir, dataDirP], limits: { importBatchMaxItems: 2 } });
const ana = (input, opts) => runtime.analyzeImport(input, opts);
const anaP = (input, opts) => runtimeP.analyzeImport(input, opts);
const SRC = { kind: 'sqlite', name: '机械标准源库', path: src, table: 'std' };
const libPath = join(dataDir, 'library.db');
const srcHash = () => createHash('sha256').update(readFileSync(src)).digest('hex');

check(IMPORT_KINDS.includes('sqlite'), '★前置:通道清单里有 sqlite');
check((await ana({ ...SRC })).ok === true, '★前置:能读源库(后面的"拒绝"才有意义)');

// ── §1 五条安全硬约束 ─────────────────────────────────────────────────────────────────
section('§1 安全:路径 / 白名单根 / 拒自噬 / 表必须显式选 / 打不开如实说');
{
  const r1 = await ana({ ...SRC, path: 'relative/库.db' });
  check(r1.ok === false && r1.reason === 'source_path_invalid', `相对路径 ⇒ source_path_invalid(实际 ${r1.reason})`);

  const r2 = await ana({ ...SRC, path: `${srcDir}\\..\\x.db` });
  check(r2.ok === false && r2.reason === 'source_path_invalid', `带字面 .. 的路径 ⇒ source_path_invalid(路径闸先拦:不解析就拒)(实际 ${r2.reason})`);

  const outside = join(tmp, 'outside.db');
  const r3 = await ana({ ...SRC, path: outside });
  check(r3.ok === false && r3.reason === 'source_path_not_allowed', `未登记根下的路径 ⇒ source_path_not_allowed(实际 ${r3.reason})`);

  const r4 = await ana({ ...SRC, path: libPath });
  check(r4.ok === false && r4.reason === 'source_locked', `指向本插件自己的库 ⇒ source_locked(实际 ${r4.reason})`);
  const r5 = await ana({ ...SRC, path: libPath.toUpperCase() });
  check(r5.ok === false && r5.reason === 'source_locked', `同上但大小写不同 ⇒ 照样认出(实际 ${r5.reason})`);

  const r6 = await ana({ ...SRC, path: junk });
  check(r6.ok === false && r6.reason === 'not_sqlite', `不是 SQLite 的文件 ⇒ not_sqlite(实际 ${r6.reason})`);
  check(typeof r6.message === 'string' && /SQLCipher|加密/.test(r6.message), 'not_sqlite 的消息点名加密库(不让人瞎猜)');

  const r7 = await ana({ ...SRC, path: join(srcDir, '不存在.db') });
  check(r7.ok === false && r7.reason === 'source_unreadable', `文件不存在 ⇒ source_unreadable(实际 ${r7.reason})`);

  const r8 = await ana({ ...SRC, table: '' });
  check(r8.ok === false && r8.reason === 'table_required', `不给表名 ⇒ table_required(实际 ${r8.reason})`);
  check(typeof r8.message === 'string' && r8.message.includes('std'), 'table_required 的消息列出库里可选的表');

  const r9 = await ana({ ...SRC, table: '没有这张表' });
  check(r9.ok === false && r9.reason === 'table_not_found', `表不存在 ⇒ table_not_found(实际 ${r9.reason})`);

  const r10 = await ana({ ...SRC, table: 'vw' });
  check(r10.ok === false && r10.reason === 'table_not_found', `视图不接 ⇒ table_not_found(实际 ${r10.reason})`);
  check(typeof r10.message === 'string' && /视图/.test(r10.message), '视图那条消息讲明为什么(视图没有稳定主键 ⇒ 会造出假幂等)');
}

// ── §2 抽取形状与保真 ─────────────────────────────────────────────────────────────────
section('§2 抽取:locator 形状 / evidence 落回 / 字段直通 / 值保真');
{
  const r = await ana(SRC);
  check(r.ok === true, '★前置:std 读成功');
  check(r.source_hash.startsWith('sha256:'), `source_hash 是 sha256:<hex> 形状(${r.source_hash.slice(0, 16)}…)`);
  check(Array.isArray(r.candidates) && r.candidates.length === 3, `三行三候选(实际 ${r.candidates && r.candidates.length})`);
  check(r.candidates[0].locator === 'std#1', `locator = 表名#主键值(实际 ${r.candidates[0].locator})`);
  check(r.candidates[0].locator_verified === true, 'evidence 逐字落回取源层预存的整行文本(定位回查通过)');
  check(r.candidates[0].selected === true, '干净的行默认勾选');

  // 字段直通:列名命中图书馆字段名 ⇒ 原样用(不是"重新拼正文")
  const c1 = r.candidates[0];
  check(c1.title === 'GB/T 1800.1-2020 极限与配合', `title 直通(实际 ${JSON.stringify(c1.title)})`);
  check(c1.category === 'standard-value', `category 直通(实际 ${JSON.stringify(c1.category)})`);
  check(c1.source_kind === 'standard', `source_kind 直通(实际 ${JSON.stringify(c1.source_kind)})`);
  check(c1.as_of === '2026-10-01', `as_of 直通(实际 ${JSON.stringify(c1.as_of)})`);
  check(c1.source_ref === 'GB/T 1800.1-2020', 'source_ref 直通(源自带出处优先)');
  check(typeof c1.body === 'string' && c1.body.includes('公差带与偏差的基准'), 'body 直通(是源里的正文)');

  // 其余列 ⇒ 进正文,一个都不许丢
  check(typeof c1.body === 'string' && c1.body.includes('qty: 3'), '非图书馆列 qty 进正文');
  check(typeof c1.body === 'string' && c1.body.includes('note: 螺纹 M8'), '中文值原样(没被转义/乱码)');
  check(typeof c1.body === 'string' && c1.body.includes('big: 9223372036854775807'), '大整数**原样**(没丢精度)');
  check(typeof c1.body === 'string' && /nul:\s*null/.test(c1.body), 'NULL 如实写成 null');

  // 缺省兜底:键不在场才补 —— 但补出来的标题必须能认出来源
  const c3 = r.candidates[2];
  check(typeof c3.title === 'string' && c3.title.includes('std') && c3.title.includes('3'),
    `没标题的行补一个能认出来的默认标题(实际 ${JSON.stringify(c3.title)})`);
  check(c3.selected === true, '没标题的行仍可入库(标题是通道补的,不是源缺字段)');

  // 纯业务表:列名一个都不命中 ⇒ 全进正文
  const p = await ana({ ...SRC, table: 'plain' });
  check(p.ok === true && p.candidates.length === 2, 'plain 两行两候选');
  check(p.candidates[0].locator === 'plain#1', `plain 的 locator 形状相同(实际 ${p.candidates[0].locator})`);
  check(typeof p.candidates[0].body === 'string' && p.candidates[0].body.includes('k: 甲')
    && p.candidates[0].body.includes('v: 一'), '列名不命中 ⇒ 键值对进正文(不丢列)');

  // 回执里的 SQLite 账
  check(r.stats.sqlite_table === 'std', `回执写明认的是哪张表(实际 ${r.stats.sqlite_table})`);
  check(r.stats.sqlite_key === 'pk', `回执写明定位用的是主键(实际 ${r.stats.sqlite_key})`);
  check(r.stats.sqlite_has_more === false, '三行一次读完 ⇒ sqlite_has_more:false');
  check(r.stats.units_total === null, '**总数据实给 null**(大表不跑 COUNT(*)⇒ 不知道就不编)');
  check(r.stats.next_offset === null, '一次读完 ⇒ next_offset:null');
}

// ── §3 分页(SQL 层窗口)──────────────────────────────────────────────────────────────
section('§3 分页:窗口在 SQL 层 / units_total 恒 null / 多取一格探 next_offset');
{
  const p1 = await anaP(SRC);
  check(p1.ok === true, '★前置:小页尺的运行时可用');
  check(p1.candidates.length === 2, `一页 2 条(尺 = importBatchMaxItems,实际 ${p1.candidates.length})`);
  check(p1.stats.units_total === null, '页大小不影响"不数总数"这条');
  check(p1.stats.next_offset === 2, `还有下一页 ⇒ next_offset:2(实际 ${p1.stats.next_offset})`);
  check(p1.stats.sqlite_has_more === true, '如实说还有更多');

  const p2 = await anaP(SRC, { offset: 2 });
  check(p2.candidates.length === 1, `第二页 1 条(实际 ${p2.candidates.length})`);
  check(p2.stats.next_offset === null, '第二页取完 ⇒ next_offset:null');
  check(p2.stats.offset === 2, '回执如实写 offset');

  const locs = [...p1.candidates, ...p2.candidates].map((c) => c.locator);
  check(locs.join(',') === 'std#1,std#2,std#3', `两页拼接不重不漏(实际 ${locs.join(',')})`);

  const far = await anaP(SRC, { offset: 99 });
  check(far.ok === true && far.candidates.length === 0, '越界 offset ⇒ 空页,且**不报错**(不是故障)');
  check(far.stats.next_offset === null, '越界页 next_offset:null');

  const neg = await anaP(SRC, { offset: -5 });
  check(neg.ok === true && neg.candidates[0].locator === 'std#1', '负数 offset 按 0 处理(与 CSV/text 同一口径)');
}

// ── §4 幂等与落库(D15 的源身份)──────────────────────────────────────────────────────
section('§4 幂等:源摘要按文件身份 / 同源同定位不重复建条目');
{
  const a1 = await ana(SRC);
  const a2 = await ana(SRC);
  check(a1.source_hash === a2.source_hash, '同一份源两次 analyze ⇒ 同一个 source_hash');
  const p2h = await anaP(SRC, { offset: 2 });
  check(p2h.source_hash === a1.source_hash, '翻到第 2 页 ⇒ 源摘要不变(D15:按文件身份算,不按这一页的内容)');

  const first = await runtime.commitImport({
    source_hash: a1.source_hash,
    items: a1.candidates.slice(0, 2),
  });
  check(first.ok === true && first.committed === 2 && first.skipped === 0,
    `首次落库 2 条(实际 committed=${first.committed} skipped=${first.skipped})`);

  const again = await runtime.commitImport({
    source_hash: a1.source_hash,
    items: a1.candidates.slice(0, 2),
  });
  check(again.ok === true && again.committed === 0 && again.skipped === 2,
    `同一份源再提交 ⇒ 全部 skipped(实际 committed=${again.committed} skipped=${again.skipped})`);

  const db = new DatabaseSync(libPath, { readOnly: true });
  const keys = db.prepare("SELECT import_key FROM library_item WHERE import_key<>'' ORDER BY import_key").all()
    .map((r) => r.import_key);
  db.close();
  check(keys.length === 2, `库里两条带键条目(实际 ${keys.length})`);
  check(keys.every((k) => /^[0-9a-f]{16}:std#[12]$/.test(k)), `import_key = 源摘要16位:locator(实际 ${keys.join(' ')})`);
  check(keys.every((k) => k.startsWith(a1.source_hash.replace(/^sha256:/, '').slice(0, 16))),
    '键里的源摘要就是**文件身份**摘要(D15)');

  // 源变了(加一行)⇒ 文件身份的 size/mtime 变 ⇒ 源摘要跟着变(不是"永远一样")
  {
    const d = new DatabaseSync(src);
    d.exec('CREATE TABLE extra (id INTEGER PRIMARY KEY)');
    d.close();
  }
  const a3 = await ana(SRC);
  check(a3.source_hash !== a1.source_hash, '源库变了 ⇒ 源摘要跟着变(幂等的"源"是文件身份,不是路径字符串)');
}

// ── §5 参数闸与接线 ─────────────────────────────────────────────────────────────────
section('§5 参数与接线:text 与 path 不许同时给 / 没接线要说清楚');
{
  const both = await ana({ ...SRC, text: '顺带粘了点文本' });
  check(both.ok === false && both.reason === 'invalid_argument',
    `text 与 path 同给 ⇒ invalid_argument(实际 ${both.reason})`);
  const noPath = await ana({ ...SRC, path: '' });
  check(noPath.ok === false && noPath.reason === 'source_path_invalid',
    `不给 path ⇒ source_path_invalid(实际 ${noPath.reason})`);

  // 直接把 analyzeImport 当纯函数用(没有注入取源)⇒ 必须说"接线问题",不许假装源有问题
  const bare = await analyzeImport({ ...SRC });
  check(bare.ok === false && bare.reason === 'sqlite_unavailable',
    `没注入取源 ⇒ sqlite_unavailable(实际 ${bare.reason})`);
  check(typeof bare.message === 'string' && /接线|readSqlite/.test(bare.message),
    '那条消息指明是接线问题(不是源的问题)');

  // 非 sqlite 的通道带上 path:analyzeImport 只管自己那条道(path 由 api 层拦,见 API 套件)
  const t = await analyzeImport({ kind: 'text', name: '粘贴文本', text: '一\n\n二', path: '/tmp/x.db' });
  check(t.ok === true && t.candidates.length === 2, 'kind=text 时 path 被忽略,文本分段照常');
}

// ── §6 只读硬证据 ───────────────────────────────────────────────────────────────────
section('§6 只读:源库一个字节都不许变');
{
  const h1 = srcHash();
  const r = await ana(SRC);
  const h2 = srcHash();
  check(r.ok === true, '★前置:读是成功的(下面那条不是"因为没读")');
  check(h1 === h2, 'analyze 前后源库 sha256 逐字节一致');
}

// ── §7 行序与回查口径(2026-10-15:异源复核 + 自查各抓到一条,两条都先复现后修)─────────────
//   ① `LIMIT ? OFFSET ?` **不排序**时"第几页是哪些行"是**未定义**的 ⇒ 必须显式 `ORDER BY`;
//      修前复现:插入 m,a,z ⇒ 回 `t#m,t#a,t#z`(插入序);修后 = 主键序 `t#a,t#m,t#z`。
//   ② 回查只把 `evidence` 归一到 LF、`span` 没归一 ⇒ 源值里含 `\r\n` 时**假红**;
//      修前复现:`verified:false` + `issues:['evidence_not_found']`;修后 = `true` / 空。
section('§7 行序必须显式排序(不排就是"未定义")· CRLF 值不许假红');
const src2 = join(srcDir, '源库2.db');
{
  const d = new DatabaseSync(src2);
  d.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)');
  d.exec("INSERT INTO t VALUES ('m','M 行'),('a','A 行'),('z','Z 行')"); // 主键序 ≠ 插入序
  d.exec('CREATE TABLE crlf (k TEXT, v TEXT)');
  d.prepare('INSERT INTO crlf VALUES (?,?)').run('r1', '第一行\r\n第二行'); // TEXT 里放真 CRLF
  d.close();
}
{
  const r = await ana({ kind: 'sqlite', name: '源库2.db', path: src2, table: 't' });
  check(r.ok === true, '★前置:这张表读得到(下面几条不是"因为没读到")');
  const locs = (r.candidates || []).map((c) => c.locator);
  check(JSON.stringify(locs) === JSON.stringify(['t#a', 't#m', 't#z']),
    '★行序按**主键**升序,不是插入序(实际 ' + locs.join(',') + ')');
  check(String(r.stats && r.stats.sqlite_order_by).indexOf('k') >= 0,
    '回执如实报出 ORDER BY 用了哪一列(实际 ' + (r.stats && r.stats.sqlite_order_by) + ')');
  const r2 = await ana({ kind: 'sqlite', name: '源库2.db', path: src2, table: 't' }, { offset: 1 });
  const locs2 = (r2.candidates || []).map((c) => c.locator);
  check(JSON.stringify(locs2) === JSON.stringify(['t#m', 't#z']),
    '★第 2 页接着第 1 页走(offset=1 ⇒ ' + locs2.join(',') + ')');
}
{
  // 非空测:先证明到手的 evidence 里**真的**带着 CRLF,否则下面那条断言是空测。
  // ⚠️ 这里**不直接调 `readSqliteSource`**:它是 `async`,而且 `roots` 要的是 `normalizeRoots()` 之后的形状
  //    (runtime 注入的就是那个) —— 绕过 runtime 手搓参数正是"只测模块测不出接线错"的另一种写法。
  //    evidence 本身就取自取源层的整行原文(`library-import.js` 的 `evidence: span`),拿它证明非空测最直接。
  const c = await ana({ kind: 'sqlite', name: '源库2.db', path: src2, table: 'crlf' });
  const cand = (c.candidates || [])[0];
  check(c.ok === true && !!cand, '★前置:候选出来了');
  check(String(cand.evidence).indexOf('\r\n') >= 0,
    '★前置:这条候选的 evidence 里**确实**有 CRLF(所以下面那条不是空测)');
  check(cand.locator_verified === true, '★值里含 CRLF 的行照旧回查通过(不许假红)');
  check((cand.issues || []).indexOf('evidence_not_found') < 0, '不许报 evidence_not_found');
}

// ── §8 安全硬化(2026-10-15:异源安全复核报的三条,逐条**先实测复现再修**)───────────────────────
//   ① 硬链接绕自噬闸 —— 修前实测:`ok:true` 且读出 `memory-机密`;修后 = `source_locked`(比 dev+ino,不只比路径串);
//   ② WAL 库只读打开会在源目录留下 `-shm`(SQLite 自己的行为,实测复现)—— 不装作没发生,**如实进回执**;
//   ③ 读完身份复验(缩小 TOCTOU 窗口;`node:sqlite` 只收路径、拿不到 fd,给不了 `O_NOFOLLOW` 那层)。
section('§8 安全硬化:硬链接不许绕锁 · 源目录侧写如实报 · 读完身份复验');
{
  const hard = join(srcDir, '硬链.db');
  let linked = true;
  try { linkSync(join(dataDir, 'library.db'), hard); } catch { linked = false; }
  if (!linked) {
    console.log('    ⚠️ 这台机器建不了硬链接 ⇒ 跳过"硬链接不许绕锁"那条(不是通过,是没测到)');
  } else {
    const h = await ana({ kind: 'sqlite', name: '硬链.db', path: hard, table: 'any' });
    check(h.ok === false && h.reason === 'source_locked',
      '★硬链接指向自有库 ⇒ 必须拒(修前实测能读到 memory.db;实际 ' + h.reason + ')');
  }
  const r = await ana(SRC);
  check(r.ok === true, '★前置:正常读一次是成功的');
  check(Array.isArray(r.stats.sqlite_sidecars_created),
    '回执如实带上"源目录里新增了哪些侧文件"(实际 ' + JSON.stringify(r.stats.sqlite_sidecars_created) + ')');
  check(r.stats.sqlite_identity_changed === false,
    '读的过程中源身份没变(identity_changed=false,实际 ' + r.stats.sqlite_identity_changed + ')');
}

runtime.close();
runtimeP.close();
console.log(failures === 0 ? `✓ library-sqlite 全部通过(${assertions} 断言)` : `✗ library-sqlite 有 ${failures} 条失败(共 ${assertions} 断言)`);
process.exitCode = failures === 0 ? 0 : 1;
