// 1.7 · 图书馆 **浏览面**(只读 · 不搜也能翻)—— 专属判据套(2026-10-13)
//
// 覆盖(逐条对应 1.7-library-browse-design-options.md 的形态 A):
//   · 分组计数表 `groups`:**恒定全量**(与筛选无关)+ 区分 active/留痕 —— 浏览树的骨架靠它、
//     否则每翻一页骨架都会跟着变;
//   · 含留痕行:撤下 / 被取代的行**也在**条目流里(留痕是馆藏),靠 `state` 自证;
//   · 分页:多取一条判"后面还有没有" ⇒ `nextOffset` / `truncated`;末页 `nextOffset:null`;
//   · **不给 total**(契约禁止误导性 total)—— 连回执的 JSON 文本里都不许出现这个键;
//   · 参数闸:未知键 / 非法 category / 非法 source_kind / 非法 limit / 非法 offset —— 一律点名拒;
//   · **只读硬证据**:browse 前后**库文件 sha256 逐字节未变** + 全表内容未变(它不是"看着像读"的写面);
//   · runtime 门面:参数白名单先收一道 + 关闭态如实回 `closed`(不冒充"零条目")。
//
// ⚠️ HTTP 面(405 want:GET / 200 带 groups / 未知 query 400)由 `library-api-tools.test.mjs` 覆盖,本套不重复。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

const tmp = mkdtempSync(join(tmpdir(), 'ling-lib-browse-'));
const realHome = process.env.DSH_HOME;
process.env.DSH_HOME = join(tmp, 'home');   // 隔离每启动票据的真机写入(与另两套同款)

const { LibraryStore, LIBRARY_CATEGORIES, LIBRARY_SOURCE_KINDS } = await imp('lib/host/library-store.js');
const { LibraryRuntime } = await imp('lib/host/library-runtime.js');

const dbPath = join(tmp, 'library.db');
const store = new LibraryStore(dbPath);
const fileHash = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
const dump = () => JSON.stringify(store.db.prepare('SELECT * FROM library_item ORDER BY id').all());

// ── 素材:四个类目/来源各一条,其中一条撤下、一条修订(制造留痕)────────────────────────────
const today = (d) => d;
const mk = (title, category, source_kind, ref) => ({
  title, body: `${title} 的正文摘要。`, category, source_kind, source_ref: ref, as_of: today('2026-10-01'),
});
const rActive = store.create(mk('GB/T 1800.1-2020 极限与配合', 'standard-value', 'standard', 'GB/T 1800.1-2020'));
const rGone = store.create(mk('边界:仅当 X 时成立', 'boundary', 'manual', '内部分析-1'));
const rRev = store.create(mk('GB/T 1184-1996 形位公差', 'standard-value', 'standard', 'GB/T 1184-1996'));
const rApi = store.create(mk('某外部接口的字段口径', 'external-api', 'official-doc', 'https://example.com/api'));
check([rActive, rGone, rRev, rApi].every((r) => r.ok === true), '★前置:四条素材都入库成功');
const goneId = rGone.ok ? rGone.item.id : null;
const revId = rRev.ok ? rRev.item.id : null;
const revHash = rRev.ok ? rRev.item.content_hash : null;
const withdrawn = store.withdraw(goneId, '浏览面测试:撤下留痕,不物理删除。', rGone.ok ? rGone.item.content_hash : null);
check(withdrawn.ok === true, '★前置:一条已撤下(留痕)');
const revised = store.revise(revId, { ...mk('GB/T 1184-1996 形位公差', 'standard-value', 'standard', 'GB/T 1184-1996'), body: '改过一版的正文。' }, revHash);
check(revised.ok === true, '★前置:一条已修订(旧版被取代)');
const rowsTotal = Number(store.stats().items.total);
check(rowsTotal === 5, '★前置:库内共 5 行 = 3 条 create + 1 条修订多出的一版 + 撤下那条仍在(实际 ' + rowsTotal + ')');

// ══ 0) 接口形状 ═══════════════════════════════════════════════════════════════════════
section('0) 接口形状:store.browse 与 runtime 门面都在');
check(typeof store.browse === 'function', 'store.browse 是函数');
check(typeof LibraryRuntime.prototype.browse === 'function', 'LibraryRuntime#browse 门面在册');
const r0 = store.browse({});
check(r0.ok === true && Array.isArray(r0.items) && Array.isArray(r0.groups), '空参数也能翻(不搜就能看)');

// ══ 1) 分组计数表:恒定全量,与筛选无关 ═══════════════════════════════════════════════
section('1) 分组计数表 groups:覆盖全库且不随筛选变化');
const g1 = store.browse({}).groups;
check(g1.length === 3, '三个"类目/来源"组(实际 ' + JSON.stringify(g1.map((g) => g.category + '/' + g.source_kind)) + ')');
check(JSON.stringify(g1) === JSON.stringify([
  { category: 'boundary', source_kind: 'manual', count: 1, active: 0 },
  { category: 'external-api', source_kind: 'official-doc', count: 1, active: 1 },
  { category: 'standard-value', source_kind: 'standard', count: 3, active: 2 },
]), '★groups 逐条相等(含 count 与 active;留痕计入 count 但不计入 active):' + JSON.stringify(g1));
const g2 = store.browse({ category: 'standard-value' }).groups;
check(JSON.stringify(g2) === JSON.stringify(g1), '★带筛选时 groups 仍是**全量**(否则翻一页骨架就变一次)');
check(LIBRARY_CATEGORIES.every((c) => g1.some((g) => g.category === c) || c === 'project-spec'),
  'groups 的 category 取值都在 LIBRARY_CATEGORIES 里(project-spec 本次没有素材)');
check(g1.every((g) => LIBRARY_SOURCE_KINDS.includes(g.source_kind)), 'groups 的 source_kind 取值都在枚举里');

// ══ 2) 条目流:含留痕行,靠 state 自证 ════════════════════════════════════════════════
section('2) 条目流含撤下/被取代的行(留痕是馆藏的一部分)');
const all = store.browse({}).items;
check(all.length === 5, '不带筛选时 5 行全出(实际 ' + all.length + ')');
const states = all.map((it) => it.state).sort();
check(JSON.stringify(states) === JSON.stringify(['active', 'active', 'active', 'superseded', 'withdrawn']),
  '★三种状态并存:active×3 + superseded×1 + withdrawn×1(实际 ' + JSON.stringify(states) + ')');
check(all.every((it) => typeof it.title === 'string' && it.title !== ''), '每行都带标题(树叶子要显示)');
check(all.every((it) => typeof it.category === 'string' && typeof it.source_kind === 'string'),
  '每行都带 category + source_kind(分组维度自己带着走)');
const onlyStd = store.browse({ category: 'standard-value' }).items;
check(onlyStd.length === 3 && onlyStd.every((it) => it.category === 'standard-value'), '按类目筛:只剩该类目 3 行');
const pair = store.browse({ category: 'standard-value', source_kind: 'standard' }).items;
check(pair.length === 3, '按 类目+来源 两个维度一起筛也成立');
const miss = store.browse({ category: 'project-spec' });
check(miss.ok === true && miss.items.length === 0 && miss.count === 0, '空组是**合法的零条目**,不是错误(ok 仍为 true)');
check(miss.groups.length === 3, '空组回执里 groups 照样全量(树不能因为点了空组就塌了)');
check(store.browse({ includeInactive: true }).reason === 'unknown_field',
  'browse **不收** includeInactive(它本来就含留痕,收下这个键等于让调用方以为默认过滤了)');

// ══ 3) 分页:nextOffset / truncated ══════════════════════════════════════════════════
section('3) 分页:多取一条判"后面还有没有",不靠 total');
const p1 = store.browse({ limit: 2 });
check(p1.count === 2 && p1.offset === 0 && p1.limit === 2, '第一页:count/offset/limit 如实回显');
check(p1.truncated === true && p1.nextOffset === 2, '★第一页:truncated=true 且 nextOffset=2(实际 ' + p1.nextOffset + ')');
const p2 = store.browse({ limit: 2, offset: 2 });
check(p2.count === 2 && p2.nextOffset === 4 && p2.truncated === true, '第二页:nextOffset=4、truncated 仍 true');
const p3 = store.browse({ limit: 2, offset: 4 });
check(p3.count === 1 && p3.truncated === false && p3.nextOffset === null, '★末页:count=1、truncated=false、nextOffset=null');
const seen = [...p1.items, ...p2.items, ...p3.items].map((it) => it.id);
check(seen.length === 5 && new Set(seen).size === 5, '三页拼起来 = 全库 5 行且**无重复**(分页稳定,排序键唯一)');
check(p3.nextOffset === null, '末页不许给出"还指回同一 offset"的假下一页');

// ══ 4) 不给 total ════════════════════════════════════════════════════════════════════
section('4) 回执**没有** total(契约禁止误导性 total)');
const r4 = store.browse({ limit: 1 });
check(!('total' in r4) && !JSON.stringify(r4).includes('"total"'), '★回执里连 total 这个键都不存在(不是置 null)');
check(Object.keys(r4).includes('truncated') && Object.keys(r4).includes('nextOffset'),
  '不给 total,但必须给 truncated + nextOffset —— 否则"还有没有下一页"无从得知');

// ══ 5) 参数闸:一律点名拒,不静默忽略 ═════════════════════════════════════════════════
section('5) 参数闸:未知键与非法值都点名拒');
check(store.browse({ q: 'x' }).reason === 'unknown_field', '检索词 q 是 search 的参数,**不是** browse 的 ⇒ unknown_field');
check(store.browse({ size: 10 }).reason === 'unknown_field', '未知键 size ⇒ unknown_field');
check(store.browse({ category: 'standard-values' }).reason === 'invalid_argument',
  '★类目拼错(s)⇒ invalid_argument,不静默回空集');
check(store.browse({ source_kind: 'std' }).reason === 'invalid_argument', '来源拼错 ⇒ invalid_argument');
check(store.browse({ category: '' }).reason === 'invalid_argument', '空串类目 ⇒ invalid_argument(空串=没写,不许当通配)');
check(store.browse({ limit: 0 }).reason === 'invalid_limit', 'limit=0 ⇒ invalid_limit');
check(store.browse({ limit: 999999 }).reason === 'invalid_limit', 'limit 超上限 ⇒ invalid_limit');
check(store.browse({ offset: -1 }).reason === 'invalid_offset', 'offset=-1 ⇒ invalid_offset');
check(store.browse({ offset: 1.5 }).reason === 'invalid_offset', 'offset 非整数 ⇒ invalid_offset');
check(store.browse(null).ok === true && store.browse(undefined).ok === true, 'null/undefined 参数按"空筛选"处理(不是崩溃)');
check(store.browse('x').reason === 'invalid_type', '非对象参数 ⇒ invalid_type');

// ══ 6) 只读硬证据:库文件逐字节未变 ═══════════════════════════════════════════════════
section('6) 只读硬证据:browse 前后库文件与内容逐字节未变');
const beforeHash = fileHash();
const beforeDump = dump();
const beforeSize = statSync(dbPath).size;
for (let i = 0; i < 3; i += 1) {
  store.browse({});
  store.browse({ category: 'standard-value', limit: 2 });
  store.browse({ source_kind: 'standard', offset: 1 });
}
const afterHash = fileHash();
check(afterHash === beforeHash, '★库文件 sha256 未变(' + beforeHash.slice(0, 12) + '…):浏览面一个字节都没写');
check(statSync(dbPath).size === beforeSize, '库文件大小未变');
check(dump() === beforeDump, '★全表内容未变(9 次 browse 之后逐行相等)');
check(Number(store.stats().items.total) === 5, '行数仍是 5');

// ══ 7) runtime 门面:白名单 + 关闭态如实 ═══════════════════════════════════════════════
section('7) runtime 门面:参数白名单先收一道,关闭态不冒充"零条目"');
mkdirSync(join(tmp, 'rt'), { recursive: true });
const rt = new LibraryRuntime(join(tmp, 'rt'));
const rtOk = rt.browse({});
check(rtOk.ok === true && rtOk.items.length === 0 && rtOk.groups.length === 0, '空库上 browse 如实回"零条目 + 零分组"');
check(rt.browse({ q: 'x' }).reason === 'invalid_argument', 'runtime 层先收白名单(q 进不来)');
check(rt.browse({ category: 'nope' }).reason === 'invalid_argument', 'runtime 透传到 store 的枚举闸(invalid_argument)');
check(rt.browse({ fields: 'row' }).ok === true, 'runtime 放行 fields(列表行投影——浏览面靠它把 200 条塞进一次响应)');
check(rt.browse({ fields: 'bogus' }).reason === 'invalid_argument', 'runtime 只收白名单,值的合法性由 store 判(invalid_argument)');
await rt.close();
const rtClosed = rt.browse({});
check(rtClosed.ok === false && rtClosed.reason === 'closed', '★关闭后如实回 closed(不是空结果冒充成功)');

// ══ 8) 列表行投影 + 浏览面专用限额(2026-10-13 主人定:默认 200 / 到 1000 切分页) ═══════
section('8) 列表行不带正文(fields=row)+ 浏览面自己那两把尺');
const rDef = store.browse({});
check(rDef.limit === 200, 'limit 缺省 = browseDefaultLimit(200) —— 不再借用检索的 20');
check(rDef.fields === 'full', 'fields 缺省 = full(整条含正文):老调用方的行为一字未变');
const rFull = store.browse({ limit: 3 });
check(rFull.items.length > 0 && rFull.items.every((it) => typeof it.body === 'string'), '默认整条带 body');
const rRow = store.browse({ limit: 3, fields: 'row' });
check(rRow.items.length === rFull.items.length && rRow.items.every((it) => !('body' in it)),
  '★fields=row ⇒ 列表行**没有** body 字段(否则单条 64 KiB、200 条撑爆 256 KiB 的响应预算)');
check(rRow.items.every((it) => typeof it.body_chars === 'number' && it.body_chars >= 0),
  '★但给出 body_chars —— 人还能知道正文有多长,不用点开也知道值不值得看');
check(rRow.items.every((it) => typeof it.id === 'string' && typeof it.title === 'string'),
  '标题与 id 照旧在(列表要有东西可画)');
check(rRow.items[0].id === rFull.items[0].id && rRow.items[0].content_hash === rFull.items[0].content_hash,
  '同筛选下 row 与 full 是同一批条目、同一顺序(投影只去掉正文,不改口径)');
check(store.browse({ fields: 'bogus' }).reason === 'invalid_argument', 'fields 只认 full / row ⇒ 非法值点名拒');
check(store.browse({ limit: 1000 }).ok === true, 'limit=1000 收(browseMaxLimit = 切分页的阈值,同一个数)');
check(store.browse({ limit: 1001 }).reason === 'invalid_limit', 'limit=1001 ⇒ invalid_limit(浏览面的尺与检索那把分开)');
check(store.browse({ limit: 5000 }).reason === 'invalid_limit' && store.browse({ limit: 20 }).ok === true,
  '两把尺互不干扰:检索仍是 1..100,浏览面是 1..1000');

store.close();
if (realHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = realHome;

console.log('\n断言 ' + assertions + ' 条,失败 ' + failures + ' 条');
if (failures) process.exitCode = 1;
else console.log('✓ library-browse 全部通过 —— 浏览面的判据可当回归护栏了');
