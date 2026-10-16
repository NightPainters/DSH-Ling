// 1.7 图书馆 · **存储层**针对性测试(自有临时 SQLite 库;不碰任何真机库)。
//
// 覆盖范围与验收清单对齐:条目校验(必填/受控枚举/只读字段/大小写无歧义/as_of)、
// check_spec(有界行段 / RFC6901 指针 / text-lf)、修订与撤下留痕、陈旧证据、
// 伪造认证状态、LIKE 字面量口径、分页/字节上限/重开/不可用、与 200 条规模检索计时。
//
// 断言用 node:assert/strict(**每一条都有可度量的计数**),失败即计数减少 ——
// 红/绿都能当证据用:红说明对应行为没实现或退回了旧行为,绿说明它在。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LibraryStore, DEFAULT_LIBRARY_LIMITS, normalizeLibraryLimits, LibraryUnavailableError,
  LIBRARY_CATEGORIES, LIBRARY_SOURCE_KINDS, libraryContentHash, hashEqual, normalizeTextLf,
  resolveJsonPointer } = await import(pathToFileURL(join(root, 'lib/host/library-store.js')).href);

const CHECKED_AT = '2026-10-06T12:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'ling-lib-'));
const dbFile = join(dir, 'library.db');

let assertions = 0;
let failed = 0;
let sectionName = '(none)';
const count = (target, message) => {
  assertions += 1;
  try { target(); } catch (e) { failed += 1; console.log(`  ✗ [${sectionName}] ${message}\n     ${e.message}`); }
};
const section = (name) => { sectionName = name; console.log(`── ${name}`); };

const baseItem = (over = {}) => ({
  title: '公差表 示例', body: 'φ10 H7 上偏差 +0.015 / 下偏差 0', category: 'standard-value',
  source_kind: 'standard', source_ref: 'GB/T 1800.1-2020 表 1', as_of: '2026-10-06', ...over,
});

const store = new LibraryStore(dbFile);
const expectOk = (res, label) => {
  assert.equal(res.ok, true, `${label}:期望 ok=true,实际 ${JSON.stringify(res).slice(0, 300)}`);
  return res;
};

// ─────────────────────────────────────────────────────────────────────────────
section('1) 导出与限额规范化(配置错误要响亮)');
count(() => assert.equal(typeof LibraryStore, 'function'), 'LibraryStore 是构造函数');
for (const m of ['create', 'revise', 'withdraw', 'get', 'history', 'search', 'stats', 'recordCheck', 'checks', 'close']) {
  count(() => assert.equal(typeof store[m], 'function'), `store.${m}() 存在(契约签名的十种方法)`);
}
count(() => assert.deepEqual([...LIBRARY_CATEGORIES],
  ['standard-value', 'boundary', 'project-spec', 'external-api']), 'category 受控枚举四项');
count(() => assert.deepEqual([...LIBRARY_SOURCE_KINDS],
  ['standard', 'official-doc', 'manual', 'our-code', 'web']), 'source_kind 受控枚举五项');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.itemMaxBytes, 65536), '默认条目上限 64 KiB');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.resultMaxBytes, 262144), '默认响应上限 256 KiB');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.queryMaxChars, 512), '默认查询 512 字符');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.searchDefaultLimit, 20), '默认检索 20 条');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.searchMaxLimit, 100), '检索条数上限 100');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.sourceMaxBytes, 2097152), '默认取源上限 2 MiB');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.selectedTextMaxBytes, 16384), '默认选中文本 16 KiB');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.selectedTextMaxLines, 200), '默认选中行数 200');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.checkTimeoutMs, 10000), '默认核对超时 10 s');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.checkConcurrency, 2), '默认并发 2');
count(() => assert.equal(DEFAULT_LIBRARY_LIMITS.sqliteBusyTimeoutMs, 2000), '默认 busy timeout 2 s');
count(() => assert.throws(() => normalizeLibraryLimits({ itemMaxBytes: 0 }), /越界/), '限额 0 抛错(不静默夹取)');
count(() => assert.throws(() => normalizeLibraryLimits({ itemMaxBytes: 1.5 }), /整数/), '非整数限额抛错');
count(() => assert.throws(() => normalizeLibraryLimits({ nonsense: 1 }), /未知字段/), '未知限额字段抛错');
count(() => assert.throws(() => normalizeLibraryLimits({ searchDefaultLimit: 50, searchMaxLimit: 10 }), /不能大于/),
  '默认条数大于上限抛错');
count(() => assert.equal(normalizeLibraryLimits({ selectionMaxBytes: 4096 }).selectedTextMaxBytes, 4096),
  '主线短名别名 selectionMaxBytes 生效');
count(() => assert.equal(normalizeLibraryLimits({ concurrency: 4 }).checkConcurrency, 4), '别名 concurrency 生效');
count(() => assert.equal(normalizeLibraryLimits({ busyTimeoutMs: 5000 }).sqliteBusyTimeoutMs, 5000), '别名 busyTimeoutMs 生效');
count(() => assert.throws(() => normalizeLibraryLimits({ selectionMaxBytes: 4096, selectedTextMaxBytes: 8192 }), /两个名字/),
  '同一字段给两个名字抛错(语义重复不许猜)');
// ⚠️ 源码注释已改成"**只要两个名字同时出现就拒**(不比较取值)" —— 这条把"取值相同也拒"钉住,
//    免得下一个人看着旧注释以为同值放行、把配置读成两个来源。
count(() => assert.throws(() => normalizeLibraryLimits({ selectionMaxBytes: 4096, selectedTextMaxBytes: 4096 }), /两个名字/),
  '正名与别名取值相同也抛错(给两个名字本身就是语义重复)');
count(() => assert.equal(normalizeLibraryLimits({ selectionMaxLines: 300 }).selectedTextMaxLines, 300),
  '别名 selectionMaxLines 仍生效(拒的是"同时给",不是别名本身)');

// ─────────────────────────────────────────────────────────────────────────────
section('2) create:必填字段与受控枚举');
for (const [label, bad] of [
  ['title 空', { title: '   ' }],
  ['title 缺失', { title: undefined }],
  ['body 空串', { body: '' }],
  ['category 非法', { category: 'tutorial' }],
  ['category 大小写不符', { category: 'Standard-Value' }],
  ['source_kind 非法', { source_kind: 'blog' }],
  ['source_ref 空', { source_ref: '   ' }],
  ['as_of 缺失', { as_of: undefined }],
  ['as_of 非 ISO', { as_of: '2026/10/06' }],
  ['as_of 无时区时刻', { as_of: '2026-10-06T12:00:00' }],
  ['as_of 假日历日', { as_of: '2026-02-30' }],
]) {
  const payload = baseItem();
  for (const [k, v] of Object.entries(bad)) { if (v === undefined) delete payload[k]; else payload[k] = v; }
  const res = store.create(payload);
  count(() => assert.equal(res.ok, false, `${label} 必须被拒`), `${label} 被拒`);
  count(() => assert.equal(typeof res.reason, 'string', `${label} 有 reason`), `${label} 带 reason`);
}
count(() => assert.equal(store.create(baseItem({ category: 'standard-value' })).ok, true), '合法条目可建');
count(() => assert.equal(store.create(baseItem({ as_of: '2026-10-06T12:34:56Z' })).ok, true), 'UTC 时刻形式 as_of 可建');
count(() => assert.equal(store.create(baseItem({ as_of: '2026-10-06 12:34:56Z' })).ok, true), '空格分隔的 UTC 时刻可建');
count(() => assert.equal(store.create(42).ok, false), '非对象载荷被拒');
count(() => assert.equal(store.create(baseItem({ extra: 1 })).reason, 'unknown_field'), '未知字段被拒(不静默剥离)');
for (const ro of ['id', 'lineage_id', 'revision', 'previous_id', 'content_hash', 'state',
  'superseded_by', 'created_at', 'updated_at', 'withdrawn_at', 'withdrawn_reason']) {
  count(() => assert.equal(store.create(baseItem({ [ro]: 'x' })).reason, 'readonly_field'),
    `只读字段 ${ro} 被拒`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('3) 伪造认证:checked_state / checked_at 写不进去');
for (const field of ['checked_state', 'checked_at']) {
  const res = store.create(baseItem({ [field]: field === 'checked_state' ? 'ok' : CHECKED_AT }));
  count(() => assert.equal(res.ok, false), `create 带 ${field} 被拒`);
  count(() => assert.equal(res.reason, 'readonly_field'), `create 带 ${field} 的 reason=readonly_field`);
}
{
  const created = expectOk(store.create(baseItem({ title: '伪造认证靶子' })), 'create');
  const id = created.item.id;
  const rev = store.revise(id, { checked_state: 'ok' }, created.item.content_hash);
  count(() => assert.equal(rev.ok, false), 'revise 带 checked_state 被拒');
  count(() => assert.equal(rev.reason, 'readonly_field'), 'revise 伪认证 reason=readonly_field');
  const after = store.get(id);
  count(() => assert.equal(after.item.checked_state, ''), '被拒的伪认证没有落库(checked_state 仍为空)');
  count(() => assert.equal(after.item.checked_at, null), '被拒的伪认证没有写 checked_at');
  count(() => assert.equal(after.item.revision, 1), '被拒的 revise 没有产生新版本');
}

// ─────────────────────────────────────────────────────────────────────────────
section('3.5) 摘要口径与比对口径(纯函数,不建条目)');
{
  const a = { ...baseItem(), version: null, conditions: null, check_spec: null };
  const b = { ...a };
  count(() => assert.equal(libraryContentHash(a), libraryContentHash(b)), '同内容摘要恒等(确定性 JSON)');
  count(() => assert.equal(libraryContentHash(a) === libraryContentHash({ ...a, body: a.body + ' ' }), false),
    '正文变化 => 摘要变');
  count(() => assert.equal(libraryContentHash(a) === libraryContentHash({ ...a, as_of: '2026-10-07' }), false),
    '取数时间变化 => 摘要变');
  count(() => assert.match(libraryContentHash(a), /^sha256:[0-9a-f]{64}$/), '摘要格式 sha256:<hex64>');
  count(() => assert.equal(hashEqual('sha256:' + 'f'.repeat(64), 'sha256:' + 'f'.repeat(64)), true),
    'hashEqual 对同一摘要为真');
  count(() => assert.equal(hashEqual('  sha256:' + 'f'.repeat(64) + '  ', 'sha256:' + 'f'.repeat(64)), true),
    'hashEqual 容忍首尾空白');
  count(() => assert.equal(hashEqual('', ''), false), 'hashEqual 不把两个空串当同一内容');
  count(() => assert.equal(hashEqual(undefined, 'sha256:' + 'f'.repeat(64)), false), 'hashEqual 对缺参为假');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4) 大小写口径(UTF-8 字节,含 JSON 元数据)');
{
  const tiny = new LibraryStore(join(dir, 'tiny.db'), { itemMaxBytes: 4096 });
  const big = store.create(baseItem({ body: 'x'.repeat(70000) }));
  count(() => assert.equal(big.ok, false, '70 KB body 超过 64 KiB 上限'), '默认库拒绝 70 KB 条目');
  count(() => assert.equal(big.reason, 'item_too_large'), '超限 reason=item_too_large');
  count(() => assert.match(big.reason + String(big.status), /item_too_large/), '超限回执可机械判定');
  const mid = store.create(baseItem({ body: 'y'.repeat(60000) }));
  count(() => assert.equal(mid.ok, true, `60 KB 条目应通过(实际 ${JSON.stringify(mid).slice(0, 120)})`), '默认库接受 60 KB 条目');
  count(() => assert.equal(mid.byte_size > 60000, true, `byte_size 是 UTF-8 字节数(实际 ${mid.byte_size})`),
    'byte_size 报真实字节');
  const over = tiny.create(baseItem({ title: 't'.repeat(200), body: 'z'.repeat(5000) }));
  count(() => assert.equal(over.ok, false), '4 KB 限额库拒绝 5 KB 条目');
  const meta = tiny.create(baseItem({ title: 'm', body: 'm', conditions: { note: 'n'.repeat(5000) } }));
  count(() => assert.equal(meta.ok, false), 'JSON 元数据也计入条目字节(conditions 撑爆限额)');
  tiny.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('5) check_spec:有界行段 / RFC6901 指针 / 非法即拒');
const goodLines = { locator: { kind: 'lines', start: 1, end: 3 }, expected: 'abc\ndef', comparison: 'text-lf' };
const goodPointer = { locator: { kind: 'json-pointer', pointer: '/a/b~1c' }, expected: 42, comparison: 'exact' };
count(() => assert.equal(store.create(baseItem({ check_spec: goodLines })).ok, true), 'lines 规格可建');
count(() => assert.equal(store.create(baseItem({ check_spec: goodPointer })).ok, true), 'json-pointer 规格可建');
count(() => assert.equal(store.create(baseItem({ check_spec: null })).ok, true), 'check_spec=null 表示不可核');
const badSpecs = [
  ['start>end', { locator: { kind: 'lines', start: 9, end: 2 }, expected: 'x', comparison: 'exact' }],
  ['start=0', { locator: { kind: 'lines', start: 0, end: 2 }, expected: 'x', comparison: 'exact' }],
  ['非整数行号', { locator: { kind: 'lines', start: 1.5, end: 3 }, expected: 'x', comparison: 'exact' }],
  ['行数超 200', { locator: { kind: 'lines', start: 1, end: 201 }, expected: 'x', comparison: 'exact' }],
  ['选中文本超 16 KiB', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x'.repeat(16385), comparison: 'exact' }],
  ['lines 的 expected 非文本', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 7, comparison: 'exact' }],
  ['comparison 非法', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x', comparison: 'fuzzy' }],
  ['locator.kind 非法', { locator: { kind: 'regex', pattern: 'a' }, expected: 'x', comparison: 'exact' }],
  ['缺 comparison', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x' }],
  ['缺 expected', { locator: { kind: 'lines', start: 1, end: 1 }, comparison: 'exact' }],
  ['check_spec 未知字段', { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x', comparison: 'exact', wait: 1 }],
  ['locator 未知字段', { locator: { kind: 'lines', start: 1, end: 1, lines: 3 }, expected: 'x', comparison: 'exact' }],
  ['指针不以 / 开头', { locator: { kind: 'json-pointer', pointer: 'a/b' }, expected: 1, comparison: 'exact' }],
  ['指针非法 ~ 转义', { locator: { kind: 'json-pointer', pointer: '/a~2b' }, expected: 1, comparison: 'exact' }],
  ['json-pointer 缺 expected', { locator: { kind: 'json-pointer', pointer: '/a' }, comparison: 'exact' }],
  ['check_spec 非对象', 'lines:1-3'],
];
for (const [label, spec] of badSpecs) {
  const res = store.create(baseItem({ check_spec: spec }));
  count(() => assert.equal(res.ok, false, `${label} 必须被拒`), `${label} 被拒`);
  count(() => assert.equal(res.reason, 'invalid_check_spec', `${label} reason=invalid_check_spec`), `${label} reason 正确`);
}
count(() => assert.deepEqual(resolveJsonPointer({ a: { 'b/c': 1 } }, '/a/b~1c'), { found: true, value: 1 }),
  'RFC6901 ~1 解码');
count(() => assert.deepEqual(resolveJsonPointer({ a: { 'b~c': 2 } }, '/a/b~0c'), { found: true, value: 2 }),
  'RFC6901 ~0 解码');
count(() => assert.deepEqual(resolveJsonPointer({ a: 1 }, '/a/b').found, false), '指针穿到标量 => 位置不存在');
count(() => assert.deepEqual(resolveJsonPointer([1, 2], '/01').found, false), 'RFC6901 数组下标前导零不存在');
count(() => assert.equal(resolveJsonPointer({ a: 1 }, '').found, true), '空指针 = 整篇');
count(() => assert.equal(normalizeTextLf('a\r\nb\rc\nd'), 'a\nb\nc\nd'), 'text-lf 只归一 CRLF/CR');
count(() => assert.equal(normalizeTextLf('a \r\n'), 'a \n'), 'text-lf 不 trim');
count(() => assert.equal(normalizeTextLf('AB'), 'AB'), 'text-lf 不折叠大小写');

// ─────────────────────────────────────────────────────────────────────────────
section('6) 修订:换新 id / 谱系与 prev 链 / 陈旧哈希 / 认证重置');
const v1res = expectOk(store.create(baseItem({ title: '修订靶子 v1', body: '第一版' })), 'create v1');
const v1 = v1res.item;
count(() => assert.equal(v1.revision, 1, '首版 revision=1'), '首版 revision=1');
count(() => assert.equal(v1.lineage_id, v1.id, '首版 lineage_id = 自身 id'), 'lineage=自身');
count(() => assert.match(v1.id, /^lib:[0-9a-f-]{36}$/), 'id 形状 lib:<uuid>');
count(() => assert.match(v1.content_hash, /^sha256:[0-9a-f]{64}$/), 'content_hash 形状 sha256:<hex64>');
count(() => assert.equal(v1.previous_id, null), '首版 previous_id 为空');
count(() => assert.equal(v1.state, 'active'), '首版 state=active');
count(() => assert.equal(v1.checked_state, ''), '首版未核空状态');

count(() => assert.equal(store.revise(v1.id, { body: '第二版' }, 'sha256:' + '0'.repeat(64)).reason, 'hash_mismatch'),
  '陈旧 expectedHash 被拒(hash_mismatch)');
count(() => assert.equal(store.get(v1.id).item.revision, 1), '被拒的陈旧修订没有动版本号');
count(() => assert.equal(store.revise('not-an-id', { body: 'x' }, v1.content_hash).reason, 'invalid_argument'),
  'id 形状非法被拒');
count(() => assert.equal(store.revise(v1.id, { body: 'x' }, '').reason, 'invalid_argument'),
  'expectedHash 空串被拒(修订必须带观测哈希)');
count(() => assert.equal(store.revise(v1.id, {}, v1.content_hash).reason, 'no_change'),
  '内容零变化不给新版本(no_change)');
count(() => assert.equal(store.revise(v1.id, { category: 'bogus' }, v1.content_hash).reason, 'invalid_category'),
  '修订同样受枚举校验');
const v2revise = store.revise(v1.id, { body: '第二版' }, v1.content_hash + ' ');
count(() => assert.equal(v2revise.ok, true), 'expectedHash 允许首尾空白(仍按同一内容处理)');
// ⚠️ 新版本要用 **revise 的回执** 拿:`get(旧 id)` 拿到的是被取代的旧版(它不是最新版)。
const v2 = v2revise.item;
count(() => assert.equal(v2.revision, 2, '第二版 revision=2'), '第二版 revision=2');
count(() => assert.notEqual(v2.id, v1.id), '新修订换新 id');
count(() => assert.equal(v2.previous_id, v1.id), 'previous_id 指向旧版 id');
count(() => assert.equal(v2.content_hash !== v1.content_hash, true), '内容变了 => content_hash 变');
count(() => assert.equal(v2.lineage_id, v1.lineage_id), '新修订继承 lineage_id');
count(() => assert.equal(v2.state, 'active'), '新修订是 active');
const oldV1 = store.get(v1.id).item;
count(() => assert.equal(oldV1.id, v1.id), 'get(旧 id) 拿到的确实是被取代的旧版');
count(() => assert.equal(oldV1.state, 'superseded'), '旧版被标 superseded');
count(() => assert.equal(oldV1.superseded_by, v2.id), 'superseded_by 指向刚建出来的下一版');
count(() => assert.equal(oldV1.title, v1.title), '旧版内容保留(只追不替)');
count(() => assert.equal(store.revise(v1.id, { body: '第三版' }, oldV1.content_hash).reason, 'not_active'),
  '不能修订已被取代的旧版');
count(() => assert.equal(store.withdraw(v1.id, '想撤下旧版', oldV1.content_hash).reason, 'not_active'),
  '不能撤下已被取代的旧版');

// 认证重置:给 v2 核一次,再修订,新版本必须是未核状态
expectOk(store.recordCheck(v2.id, v2.content_hash, {
  state: 'ok', requested_source: 'GB/T 1800.1-2020', actual_source: 'GB/T 1800.1-2020',
  observed: '一致', comparison: 'exact', checked_at: CHECKED_AT,
}), 'recordCheck ok');
count(() => assert.equal(store.get(v2.id).item.checked_state, 'ok'), 'v2 认证为 ok');
const v3ok = expectOk(store.revise(v2.id, { body: '第三版' }, v2.content_hash), 'revise v3');
count(() => assert.equal(v3ok.item.checked_state, '', '新修订重置认证状态'), '新修订不带旧认证');
count(() => assert.equal(v3ok.item.checked_at, null, '新修订重置 checked_at'), '新修订无 checked_at');
count(() => assert.equal(store.get(v2.id).item.checked_state, 'ok', '旧版仍留着自己的核对痕迹'), '旧版认证留痕');

// 重复内容防重
const v3 = v3ok.item;
count(() => assert.equal(store.revise(v3.id, { body: '第二版' }, v3.content_hash).reason, 'duplicate_content'),
  '回到本谱系已有内容被拒(duplicate_content)');

// 同谱系连续修订三次:版本号单调 + 链完整
let latestAtV6 = v3.id;
{
  let cur = v3;
  for (let i = 4; i <= 6; i += 1) {
    const next = expectOk(store.revise(cur.id, { body: `第${i}版` }, cur.content_hash), `revise v${i}`);
    assert.equal(next.item.revision, i, `v${i} revision=${i}`);
    assert.equal(next.item.previous_id, cur.id, `v${i} previous_id 指向前一版`);
    cur = next.item;
  }
  latestAtV6 = cur.id;
  const h = expectOk(store.history(cur.id), 'history');
  count(() => assert.equal(h.revisions.length, 6, `谱系共 6 版(实际 ${h.revisions.length})`), '谱系版本数正确');
  count(() => assert.equal(h.revision_count, 6), 'revision_count=6');
  count(() => assert.equal(h.revisions.map((r) => r.revision).join(','), '1,2,3,4,5,6'), '版本号升序完整');
  count(() => assert.equal(h.revisions.filter((r) => r.is_current).length, 1), '恰好一个 is_current');
  count(() => assert.equal(h.revisions.find((r) => r.is_current).revision, 6), 'is_current 是最新版');
  const chains = h.revisions.slice(1).every((r, i) => r.previous_id === h.revisions[i].id);
  count(() => assert.equal(chains, true), 'previous_id 链逐版咬合');
  // 环判据:**每一个** superseded_by 都必须指向"版本号 +1 且 previous_id 指回来的那一条"
  //  —— 这一条同时排除了自指、跳版和闭合成环(闭一条边就会破坏其中至少一项)。
  const links = h.revisions.filter((r) => r.superseded_by);
  const forwardOnly = links.every((r) => {
    const next = h.revisions.find((x) => x.id === r.superseded_by);
    return Boolean(next) && next.previous_id === r.id && next.revision === r.revision + 1;
  });
  count(() => assert.equal(links.length, 5), '5 个旧版各有 superseded_by(最新版为空)');
  count(() => assert.equal(forwardOnly, true), 'superseded_by 只指向版本号 +1 且 previous_id 指回自己的那一条(无自指/无跳版/无环)');
  count(() => assert.equal(store.get(cur.id).item.state, 'active'), '最新版是 active');
  count(() => assert.equal(store.search({ q: '修订靶子' }).items.length, 1, '默认检索只回最新一版'), '默认检索只见最新版');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7) 撤下:reason+hash 双必填,留痕不物理删');
const wres = expectOk(store.create(baseItem({ title: '撤下靶子', body: '待撤下' })), 'create 撤下靶子');
const w = wres.item;
count(() => assert.equal(store.withdraw(w.id, '', w.content_hash).reason, 'invalid_argument'), 'reason 空被拒');
count(() => assert.equal(store.withdraw(w.id, '   ', w.content_hash).reason, 'invalid_argument'), 'reason 全空白被拒');
count(() => assert.equal(store.withdraw(w.id, '过期了', '').reason, 'invalid_argument'), 'expectedHash 空被拒');
count(() => assert.equal(store.withdraw(w.id, '过期了', 'sha256:' + '1'.repeat(64)).reason, 'hash_mismatch'),
  '陈旧哈希撤下被拒');
count(() => assert.equal(store.get(w.id).item.state, 'active'), '被拒的撤下没有改状态');
const withdrawn = expectOk(store.withdraw(w.id, '被新版标准替代', w.content_hash), 'withdraw');
count(() => assert.equal(withdrawn.item.state, 'withdrawn'), '撤下后 state=withdrawn');
count(() => assert.equal(withdrawn.item.withdrawn_reason, '被新版标准替代'), '撤下理由留档');
count(() => assert.equal(typeof withdrawn.item.withdrawn_at, 'string'), '撤下有 withdrawn_at');
count(() => assert.equal(withdrawn.item.body, w.body), '撤下不改正文(留痕)');
count(() => assert.equal(store.get(w.id).ok, true), '撤下条目仍读得到(get 不隐藏留痕)');
count(() => assert.equal(store.get(w.id).item.content_hash, w.content_hash), '撤下不改 content_hash');
count(() => assert.equal(store.withdraw(w.id, '再撤一次', w.content_hash).reason, 'not_active'), '重复撤下被拒');
count(() => assert.equal(store.revise(w.id, { body: '复活' }, w.content_hash).reason, 'not_active'), '撤下后不能修订(终态)');
count(() => assert.equal(store.search({ q: '待撤下' }).items.length, 0), '默认检索排除撤下条目');
count(() => assert.equal(store.search({ q: '待撤下', includeInactive: true }).items.length, 1),
  'includeInactive 能看到撤下条目');
{
  // 物理删:none —— 直接查表证明行还在(不是靠回执自证)
  const raw = store.db.prepare('SELECT COUNT(*) AS n FROM library_item WHERE id=?').get(w.id);
  count(() => assert.equal(Number(raw.n), 1), '撤下是留痕:库里那一行仍然存在(无物理删)');
  const rawChecks = store.db.prepare('SELECT COUNT(*) AS n FROM library_check WHERE item_id=?').get(w.id);
  count(() => assert.equal(Number(rawChecks.n) >= 0, true), '撤下条目的核对表仍可查');
}

// ─────────────────────────────────────────────────────────────────────────────
section('8) 检索:字面量 / 空白分词 AND / 类目 / 分页 / 上限');
const sfx = 'Zq' + Date.now().toString(36);
const mk = (over) => expectOk(store.create(baseItem(over)), `create ${over.title}`).item;
mk({ title: `甲 ${sfx} 标题命中`, body: '正文没有那个词', category: 'boundary' });
mk({ title: '乙', body: `正文里有 ${sfx} 关键词`, category: 'boundary' });
mk({ title: '丙', body: '无关内容', category: 'project-spec' });
mk({ title: `百 100% ${sfx}`, body: '百分号在标题里' });
mk({ title: '下划线 a_b', body: `含 ${sfx}` });
count(() => assert.equal(store.search({ q: sfx }).items.length, 4),
  '四处字面命中都回(甲标题 / 乙正文 / 百分号条 / 下划线条)');
count(() => assert.equal(store.search({ q: `${sfx} 正文` }).items.length, 2, '多词 AND 收窄'), '多词 AND 生效');
count(() => assert.equal(store.search({ q: 'boundary' }).items.length >= 2, true), '类目词能命中类目(类目可检索)');
count(() => assert.equal(store.search({ q: '100%' }).items.length >= 1, true), '% 按字面量匹配(不当通配符)');
count(() => assert.equal(store.search({ q: `${sfx} 100%` }).items.length, 1),
  '带 % 的多词 AND 精确到一条(AND 里那一个字面 % 不许当通配符吃掉整段)');
count(() => assert.equal(store.search({ q: 'a_b' }).items.length >= 1, true), '_ 按字面量匹配(不当通配符)');
count(() => assert.equal(store.search({ q: 'aXb' }).items.length, 0), '_ 不会漏成任意字符(_ 转义后不误命中)');
count(() => assert.equal(store.search({ q: '%' }).items.length >= 1, true), '纯 % 查询按字面量找(可用)');
count(() => assert.equal(store.search({ q: '' }).ok, false), '空查询被拒(不是"零命中")');
count(() => assert.equal(store.search({ q: '   ' }).ok, false), '全空白查询被拒');
count(() => assert.equal(store.search({ q: 'x'.repeat(513) }).ok, false), '513 字符查询被拒');
count(() => assert.equal(store.search({ q: 'x'.repeat(512) }).ok, true), '512 字符查询可用');
count(() => assert.equal(store.search({ q: sfx, limit: 0 }).ok, false), 'limit=0 被拒');
count(() => assert.equal(store.search({ q: sfx, limit: 101 }).ok, false), 'limit>100 被拒(上限 100)');
count(() => assert.equal(store.search({ q: sfx, offset: -1 }).ok, false), 'offset 负数被拒');
count(() => assert.equal(store.search({ q: sfx, offset: 1.5 }).ok, false), 'offset 非整数被拒');
count(() => assert.equal(store.search({ q: sfx, bogus: 1 }).ok, false), '未知检索参数被拒');
count(() => assert.equal(store.search({ q: 'no-such-token-anywhere' }).items.length, 0), '真零命中回空数组');
count(() => assert.equal(store.search({ q: 'no-such-token-anywhere' }).ok, true), '零命中仍是 ok(不是不可用)');
count(() => assert.equal(store.search({ q: sfx }).truncated, false), '未满页时 truncated=false');

{ // 100 条分页面:limit 边界 + nextOffset 推进 + 不谎报 total
  const pfx = 'Pg' + Date.now().toString(36);
  for (let i = 0; i < 105; i += 1) {
    store.create(baseItem({ title: `分页 ${pfx} ${i}`, body: '分页正文', category: 'project-spec' }));
  }
  const p1 = store.search({ q: pfx, limit: 100 });
  count(() => assert.equal(p1.items.length, 100), 'limit=100 一次给满 100 条');
  count(() => assert.equal(p1.truncated, true), '满页且还有更多 => truncated=true');
  count(() => assert.equal(p1.nextOffset, 100), 'nextOffset 推进到 100');
  const p2 = store.search({ q: pfx, limit: 100, offset: p1.nextOffset });
  count(() => assert.equal(p2.items.length, 5), '第二页给出剩余 5 条');
  count(() => assert.equal(p2.truncated, false), '末页 truncated=false');
  count(() => assert.equal(p2.nextOffset, null), '末页 nextOffset=null');
  const ids = new Set([...p1.items, ...p2.items].map((i) => i.id));
  count(() => assert.equal(ids.size, 105), '两页合计无重复无遗漏(105)');
  count(() => assert.equal(Object.keys(p1).includes('total'), false),
    'JSON 回执里没有误导性 total 字段(只有 nextOffset/truncated)');
  count(() => assert.equal('total' in p1, false), '检索回执不再暴露隐藏 total 别名');
  count(() => assert.equal(p1.total, undefined), '直接读取 search().total 也没有伪总数');
  count(() => assert.equal(p1.count, 100), 'count 就是本页条数');
}
{ // 证据定位遵循实例化限额,而不是被默认 200 行上限误拒
  const wide = new LibraryStore(join(dir, 'wide-locator.db'), { selectedTextMaxLines: 300 });
  const item = expectOk(wide.create(baseItem({
    title: '宽行段证据靶子', body: 'wide',
    check_spec: { locator: { kind: 'lines', start: 1, end: 201 }, expected: 'wide', comparison: 'exact' },
  })), 'create 宽行段证据靶子').item;
  const evidence = {
    state: 'unknown', reason: '测试用源未登记', requested_source: 'test:wide-locator',
    locator: { kind: 'lines', start: 1, end: 201 }, checked_at: CHECKED_AT,
  };
  count(() => assert.equal(wide.recordCheck(item.id, item.content_hash, evidence).ok, true),
    '自定义 selectedTextMaxLines=300 时 201 行证据可记录');
  wide.close();
}

{ // 字节上限:响应超 256 KiB 时从尾部丢并如实标 truncated
  const small = new LibraryStore(join(dir, 'small.db'), { resultMaxBytes: 4096 });
  const bpfx = 'Bt' + Date.now().toString(36);
  for (let i = 0; i < 8; i += 1) {
    small.create(baseItem({ title: `大件 ${bpfx} ${i}`, body: 'L'.repeat(1200) }));
  }
  const r = small.search({ q: bpfx, limit: 8 });
  count(() => assert.equal(r.ok, true), '字节受限检索仍 ok');
  count(() => assert.equal(r.items.length < 8, true, `超限时丢到放得下(实际 ${r.items.length}/8)`), '响应字节上限生效');
  count(() => assert.equal(r.byte_size <= 4096, true, `回执自报字节 ${r.byte_size} 不超 4096`), 'byte_size 不超上限');
  count(() => assert.equal(r.truncated, true), '丢过条目 => truncated=true(不静默截断)');
  count(() => assert.equal(typeof r.nextOffset, 'number'), '丢过条目 => nextOffset 仍可续读');
  count(() => assert.equal(small.search({ q: bpfx, limit: 1 }).items.length, 1), 'limit=1 时至少给一条');
  small.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('9) 核对历史:采纳/陈旧/伪造状态/单调序号');
const c1res = expectOk(store.create(baseItem({ title: '核对靶子', body: '核对正文', check_spec: {
  locator: { kind: 'lines', start: 1, end: 1 }, expected: '核对正文', comparison: 'exact' } })), 'create 核对靶子');
const c1 = c1res.item;
count(() => assert.equal(store.checks(c1.id).checks.length, 0), '新条目核对历史为空');
count(() => assert.equal(store.checks(c1.id).ok, true), '空历史仍是 ok(不是不可用)');

const okEvidence = {
  state: 'ok', requested_source: 'GB/T 1800.1-2020 §5', actual_source: 'https://example.invalid/gb.json',
  source_hash: 'sha256:' + 'a'.repeat(64), locator: { kind: 'lines', start: 1, end: 1 },
  expected: '核对正文', observed: '核对正文', comparison: 'exact', checked_at: CHECKED_AT,
};
const rec1 = expectOk(store.recordCheck(c1.id, c1.content_hash, okEvidence), 'recordCheck ok');
count(() => assert.equal(rec1.adopted, true), '相同哈希 + active => 采纳');
count(() => assert.equal(rec1.check_sequence, 1), '首次核对序号=1(每条目独立计数,不受别的条目已核过多少次影响)');
count(() => assert.equal(store.get(c1.id).item.checked_state, 'ok'), '条目 checked_state 变 ok');
count(() => assert.equal(store.get(c1.id).item.checked_at, CHECKED_AT), 'checked_at 用证据给的时间');
count(() => assert.equal(rec1.check.requested_source, 'GB/T 1800.1-2020 §5'),
  '回执带本次核对那一行(不是别的条目的同号行)');
count(() => assert.equal(rec1.check.item_id, c1.id), '回执那一行确实属于本条目(item_id 对得上)');
count(() => assert.equal(rec1.check.adopted, true), '核对行标 adopted');

for (const [label, patch] of [
  ['state=verified 伪造', { state: 'verified' }],
  ['state=pass 伪造', { state: 'pass' }],
  ['state=pending 伪造', { state: 'pending' }],
  ['state 缺失', { state: undefined }],
]) {
  const ev = { ...okEvidence };
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete ev[k]; else ev[k] = v; }
  const res = store.recordCheck(c1.id, c1.content_hash, ev);
  count(() => assert.equal(res.ok, false, `${label} 必须被拒`), `${label} 被拒`);
  count(() => assert.equal(res.reason, 'invalid_check_state', `${label} reason=invalid_check_state`), `${label} reason 正确`);
}
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, state: 'unknown' }).ok, false),
  'unknown 无 reason 被拒(查不到必须给具体原因)');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, state: 'wrong' }).ok, false),
  'wrong 无 reason 被拒');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, reason: 'x'.repeat(5000) }).ok, false),
  '超长 reason 被拒');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, source_hash: 'deadbeef' }).ok, false),
  '非法 source_hash 被拒');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, requested_source: '' }).ok, false),
  'requested_source 空被拒(凭据必须写明查的是哪个源)');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, extra: 1 }).ok, false),
  'evidence 未知字段被拒');
count(() => assert.equal(store.recordCheck(c1.id, c1.content_hash, null).ok, false), 'evidence 非对象被拒');
count(() => assert.equal(store.recordCheck(c1.id, 'not-a-hash', okEvidence).ok, false), '非法 hash 参数被拒');
count(() => assert.equal(store.recordCheck('lib:' + 'x'.repeat(36), c1.content_hash, okEvidence).ok, false),
  '非法 itemId 被拒');
count(() => assert.equal(store.checks(c1.id).checks.length, 1), '被拒的伪造核对没有落库(历史仍只 1 条)');

const unknownRec = expectOk(store.recordCheck(c1.id, c1.content_hash, {
  state: 'unknown', reason: '源未登记', requested_source: 'GB/T 1800.1-2020 §5',
  checked_at: '2026-10-06T12:05:00.000Z',
}), 'recordCheck unknown');
count(() => assert.equal(unknownRec.adopted, true), 'unknown 也是完成态核对 => 采纳');
count(() => assert.equal(store.get(c1.id).item.checked_state, 'unknown'), '最新状态覆盖为 unknown');
count(() => assert.equal(unknownRec.check_sequence, 2), '序号单调 +1');
count(() => assert.equal(store.checks(c1.id).checks[0].check_sequence, 1), '历史里第一条仍是序号 1(每次都留档)');

// 修订后:旧哈希证据变陈旧,仍留档但不采纳
const c2 = expectOk(store.revise(c1.id, { body: '核对正文 v2' }, c1.content_hash), 'revise 核对靶子').item;
const stale = store.recordCheck(c1.id, c1.content_hash, { ...okEvidence, checked_at: '2026-10-06T12:10:00.000Z' });
count(() => assert.equal(stale.ok, true), '陈旧证据不报错(它是历史证据)');
count(() => assert.equal(stale.adopted, false), '陈旧证据 adopted=false');
count(() => assert.equal(stale.reason, 'stale_or_inactive'), '陈旧 reason=stale_or_inactive');
count(() => assert.equal(store.get(c2.id).item.checked_state, '', '陈旧证据没有污染新版本认证'), '陈旧不覆盖新版本');
const stale2 = store.recordCheck(c1.id, c2.content_hash, okEvidence);
count(() => assert.equal(stale2.adopted, false), '已 superseded 的旧版即使哈希一致也不采纳');
count(() => assert.equal(store.get(c1.id).item.checked_state, 'unknown', '旧版认证保留原值(不被陈旧结果改写)'),
  '旧版认证不被陈旧改写');
const c2rec = expectOk(store.recordCheck(c2.id, c2.content_hash, { ...okEvidence, checked_at: '2026-10-06T12:20:00.000Z' }), 'recordCheck 新版');
count(() => assert.equal(c2rec.adopted, true), '新版哈希一致 => 采纳');
count(() => assert.equal(store.get(c2.id).item.checked_state, 'ok'), '新版认证为 ok');

// 撤下后:不再采纳
const w2 = expectOk(store.create(baseItem({ title: '核对后撤下' })), 'create 核对后撤下').item;
expectOk(store.recordCheck(w2.id, w2.content_hash, okEvidence), 'recordCheck 后撤下');
expectOk(store.withdraw(w2.id, '撤下', w2.content_hash), 'withdraw');
const afterWithdraw = store.recordCheck(w2.id, w2.content_hash, { ...okEvidence, state: 'wrong', reason: '源说不对' });
count(() => assert.equal(afterWithdraw.adopted, false), '撤下后不再采纳核对(adopted=false)');
count(() => assert.equal(store.checks(w2.id).checks.length, 2), '撤下后核对历史仍完整留档(2 条)');

// 不存在的条目:证据留档(审计),不采纳
const ghost = store.recordCheck('lib:' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), c1.content_hash, okEvidence);
count(() => assert.equal(ghost.ok, true), '陌生 itemId 的核对仍留档(不丢证据)');
count(() => assert.equal(ghost.adopted, false), '陌生 itemId adopted=false');
count(() => assert.equal(ghost.reason, 'item_missing'), '陌生 itemId reason=item_missing');

// 分页与总数
{
  const pfx = 'Ch' + Date.now().toString(36);
  const it = expectOk(store.create(baseItem({ title: `核对分页 ${pfx}` })), 'create 核对分页靶子').item;
  for (let i = 0; i < 7; i += 1) {
    expectOk(store.recordCheck(it.id, it.content_hash, {
      ...okEvidence, checked_at: `2026-10-06T13:0${i}:00.000Z`,
    }), `recordCheck ${i}`);
  }
  const all = store.checks(it.id, { limit: 5 });
  count(() => assert.equal(all.checks.length, 5), '核对历史 limit=5 生效');
  count(() => assert.equal(all.total, 7), '核对历史 total 精确(单条目 COUNT)');
  count(() => assert.equal(all.truncated, true), '还有 2 条 => truncated=true');
  count(() => assert.equal(all.nextOffset, 5), 'nextOffset=5');
  const rest = store.checks(it.id, { limit: 5, offset: 5 });
  count(() => assert.equal(rest.checks.length, 2), '第二页 2 条');
  count(() => assert.equal(rest.truncated, false), '末页 truncated=false');
  count(() => assert.equal(store.checks(it.id, { limit: 0 }).ok, false), '核对历史 limit=0 被拒');
  count(() => assert.equal(store.checks(it.id, { offset: -3 }).ok, false), '核对历史 offset 负数被拒');
  count(() => assert.equal(store.checks(it.id, { nope: 1 }).ok, false), '核对历史未知参数被拒');
  const seqs = store.checks(it.id, { limit: 100 }).checks.map((c) => c.check_sequence);
  count(() => assert.equal(seqs.join(','), '1,2,3,4,5,6,7'), '序号按条目独立单调 1..7');
  count(() => assert.equal(new Set(seqs).size, 7), '序号无重复');
}
count(() => assert.equal(store.checks(c1.id, { limit: 100 }).truncated, false), '核对历史未满页 truncated=false');
count(() => assert.equal(store.checks(c1.id, { limit: 100 }).nextOffset, null), '核对历史未满页 nextOffset=null');

// ⚠️ 摘要口径的断言**故意放在检索之前**:它用 baseItem() 调 libraryContentHash(纯函数,不建条目),
//    但一旦这里改成真建条目,检索段的"字面命中 3 条"就会被它多出来的第 4 条打破 —— 顺序敏感处写清。

// ─────────────────────────────────────────────────────────────────────────────
section('10) get / history / stats 的边界与不变式');
count(() => assert.equal(store.get('lib:xx').ok, false), 'get 非法 id 被拒');
count(() => assert.equal(store.get('lib:xx').reason, 'invalid_argument'), 'get 非法 id reason=invalid_argument');
count(() => assert.equal(store.get('lib:' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)).reason, 'not_found'),
  'get 合法但不存在 => not_found');
count(() => assert.equal(store.get('lib:' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)).found, false),
  'not_found 回执带 found:false');
count(() => assert.equal(store.history('lib:xx').ok, false), 'history 非法 id 被拒');
count(() => assert.equal(store.history('lib:' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12)).reason, 'not_found'),
  'history 不存在 => not_found');
{
  const h = store.history(v3.id, { limit: 2 });
  count(() => assert.equal(h.revisions.length, 2), 'history limit=2 生效');
  count(() => assert.equal(h.truncated, true), 'history 还有更多 => truncated');
  count(() => assert.equal(h.nextOffset, 2), 'history nextOffset=2');
  count(() => assert.equal(h.revision_count, 6), 'history revision_count 是全谱系版本数(不是本页数)');
  count(() => assert.equal(h.count, 2), 'history count 是本页条数');
  count(() => assert.equal(h.items.length, 2), 'history().items 兼容别名可用');
  count(() => assert.equal(store.history(v3.id, { limit: 101 }).ok, false), 'history limit>100 被拒');
}
{
  const s = store.stats();
  count(() => assert.equal(s.ok, true), 'stats ok');
  count(() => assert.equal(Number.isInteger(s.items.total), true), 'stats 报条目总数');
  count(() => assert.equal(s.items.active >= 1, true), 'stats 报 active 数');
  count(() => assert.equal(s.items.superseded >= 5, true), 'stats 报 superseded 数');
  count(() => assert.equal(s.items.withdrawn >= 2, true), 'stats 报 withdrawn 数');
  count(() => assert.equal(s.items.total, s.items.active + s.items.superseded + s.items.withdrawn),
    'stats 三态之和 = 总数(口径自洽)');
  count(() => assert.equal(s.checks.total >= 10, true), 'stats 报核对总数');
  count(() => assert.equal(s.checks.adopted >= 1, true), 'stats 报采纳数');
  count(() => assert.equal(s.limits.itemMaxBytes, 65536), 'stats 回显生效限额');
  // v1 → v2(2026-10-12,1.7 导入通道的幂等键 library_item.import_key)。这条断言随版本走:
  // 它钉住的是"stats 如实回显本版结构版本",不是"版本永远是 1"。
  count(() => assert.equal(s.schema_version, 2), 'stats 报 schema 版本');
}

// ─────────────────────────────────────────────────────────────────────────────
section('11) 重开一致 / 关闭 / 不可用与真异常不冒充零命中');
{
  const before = store.stats();
  const allHashes = store.db.prepare('SELECT id, content_hash, checked_state FROM library_item ORDER BY id').all();
  const memHashes = allHashes.map((r) => `${r.id}|${r.content_hash}|${r.checked_state}`);
  store.close();
  count(() => assert.equal(store.close().already, true), 'close 幂等(第二次标 already)');
  // ⚠️ 关闭回执的口径**故意改过**:reason 只放机器短码 `closed`,人话进 message(与其余回执同一口径)。
  const closedSearch = store.search({ q: 'x' });
  count(() => assert.equal(closedSearch.reason, 'closed'), '关闭后 reason 是机器短码 closed(人话不再塞在 reason 里)');
  count(() => assert.match(closedSearch.reason, /^[a-z][a-z_]*$/), '关闭 reason 是纯机器短码(可机械分流)');
  count(() => assert.equal(closedSearch.message, '图书馆库已关闭'), '关闭后 message 是人话');
  count(() => assert.equal(closedSearch.code, 'closed'), '关闭回执保留 code=closed');
  count(() => assert.equal(closedSearch.ok, false), '关闭后 search ok=false(不是零命中)');
  count(() => assert.equal(store.create(baseItem()).ok, false), '关闭后 create ok=false');
  count(() => assert.equal(store.create(baseItem()).reason, 'closed'), '关闭后 create 也回 closed 短码');
  count(() => assert.equal(store.stats().ok, false), '关闭后 stats ok=false');
  count(() => assert.equal(store.stats().message, '图书馆库已关闭'), '关闭后 stats 同样带人话 message');

  const again = new LibraryStore(dbFile);
  const after = again.stats();
  count(() => assert.equal(after.items.total, before.items.total), '重开后条目总数一致');
  count(() => assert.equal(after.checks.total, before.checks.total), '重开后核对总数一致');
  const againHashes = again.db.prepare('SELECT id, content_hash, checked_state FROM library_item ORDER BY id').all();
  count(() => assert.equal(againHashes.map((r) => `${r.id}|${r.content_hash}|${r.checked_state}`).join('\n'),
    memHashes.join('\n')), '重开后 id/哈希/认证逐行一致');
  count(() => assert.equal(again.get(latestAtV6).item.state, 'active'), '重开后最新版状态一致(active)');
  count(() => assert.equal(again.get(v1.id).item.state, 'superseded'), '重开后旧版仍是 superseded(留痕没丢)');
  count(() => assert.equal(again.search({ q: '修订靶子' }).items.length, 1), '重开后检索仍只见最新版');
  again.close();
}
{
  // 文件不是 SQLite 库:必须**响亮**报不可用,不能当成"空库零命中"
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, '这不是一个 SQLite 数据库,只是一段文本');
  let caught = null;
  try { new LibraryStore(junk); } catch (e) { caught = e; }
  count(() => assert.notEqual(caught, null), '非 SQLite 文件 => 构造抛错(不静默建空库)');
  count(() => assert.equal(caught instanceof LibraryUnavailableError, true), '抛的是 LibraryUnavailableError');
  count(() => assert.equal(caught.code, 'library-unavailable'), '错误码 library-unavailable');
  count(() => assert.match(caught.message, /打不开|初始化失败/), '错误信息说明"打不开"');
}
{
  // 目录路径当成库文件:同样必须响亮
  let caught = null;
  try { new LibraryStore(dir); } catch (e) { caught = e; }
  count(() => assert.equal(caught instanceof LibraryUnavailableError, true), '把目录当库文件 => 不可用错误');
}
{
  // 真写锁:busy_timeout 到期后**抛错**,不许吞成 {ok:false} 或空结果
  const lockedFile = join(dir, 'locked.db');
  const a = new LibraryStore(lockedFile, { busyTimeoutMs: 150 });
  const b = new LibraryStore(lockedFile, { busyTimeoutMs: 150 });
  b.db.exec('BEGIN IMMEDIATE');
  let caught = null;
  try { a.create(baseItem({ title: '写锁下的条目' })); } catch (e) { caught = e; }
  count(() => assert.notEqual(caught, null), '写锁 + busy_timeout 到期 => 抛错(不静默成功/静默失败)');
  count(() => assert.match(String(caught?.message ?? ''), /locked|busy|SQLITE/i), '抛出的是可诊断的锁错误');
  count(() => assert.equal(caught?.ok, undefined), '锁错误不是 {ok:false} 回执(不能伪装成业务拒绝)');
  b.db.exec('ROLLBACK');
  count(() => assert.equal(a.create(baseItem({ title: '锁释放后条目' })).ok, true), '锁释放后同一连接可正常写');
  a.close();
  b.close();
}
count(() => assert.equal(existsSync(dbFile), true), '库文件确实落在磁盘上(不是只活在内存)');
count(() => assert.equal(statSync(dbFile).size > 0, true), '库文件非空');

// ─────────────────────────────────────────────────────────────────────────────
section('12) 200 条规模检索计时(独立测试库,不用旧记忆库的数字代替)');
{
  const perfDir = mkdtempSync(join(tmpdir(), 'ling-lib-perf-'));
  const perf = new LibraryStore(join(perfDir, 'perf.db'));
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) {
    const res = perf.create(baseItem({
      title: `性能条目 ${i} 螺纹规格`,
      body: `第 ${i} 条正文:材料 45 钢,公差 0.0${i % 10} mm,工况系数 1.${i % 9}`,
      category: i % 2 === 0 ? 'standard-value' : 'boundary',
      source_ref: `GB/T 1${i % 10}00-2020 表 ${i}`,
      check_spec: { locator: { kind: 'lines', start: 1, end: 1 }, expected: `第 ${i} 条`, comparison: 'text-lf' },
    }));
    if (!res.ok) throw new Error(`性能库第 ${i} 条建不进去:${res.reason}`);
  }
  const buildMs = Date.now() - t0;
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const s = process.hrtime.bigint();
    const r = perf.search({ q: i % 2 === 0 ? '螺纹' : `条目 ${i} 规范`, limit: 20 });
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    if (!r.ok) throw new Error(`性能检索失败:${r.reason}`);
    samples.push(ms);
  }
  samples.sort((x, y) => x - y);
  const p50 = samples[Math.floor(samples.length / 2)];
  const max = samples[samples.length - 1];
  count(() => assert.equal(perf.stats().items.active, 200), '性能库正好 200 条 active');
  count(() => assert.equal(perf.search({ q: '螺纹', limit: 20 }).items.length, 20), '200 条下 limit=20 给满');
  count(() => assert.equal(max < 200, true, `单次检索 ${max.toFixed(2)} ms 应在 200 ms 内`), '检索耗时有界');
  console.log(`  · 建 200 条 ${buildMs} ms;检索 40 次 p50=${p50.toFixed(2)} ms p95=${samples[Math.floor(samples.length * 0.95)].toFixed(2)} ms max=${max.toFixed(2)} ms`);
  perf.close();
  try { rmSync(perfDir, { recursive: true, force: true }); } catch { /* Windows 偶发占用,交给系统清 */ }
}

// ─────────────────────────────────────────────────────────────────────────────
section('13) 存储 JSON 完整性:非有限数 / 环 / 空位 / 原形安全 / text-lf 文本');
{
  // 这一节的靶子是"**能序列化但会静默变值**的 JSON":JSON.stringify 把 Infinity/NaN 变成
  // null、把值为 undefined/函数/Symbol 的键整个丢掉、把数组空位变成 null、把 -0 变成 0,
  // 对 BigInt/环则直接抛。加固前这些值**建得进库**,读回却是另一份数据(内容摘要跟着漂),
  // 所以每一种都单独留断言,而不是只测一个代表。
  const js = new LibraryStore(join(dir, 'json-integrity.db'));
  const specOf = (expected, comparison = 'exact') =>
    ({ locator: { kind: 'json-pointer', pointer: '/a' }, expected, comparison });

  for (const [label, expected] of [
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['嵌套非有限数', { a: [1, { b: NaN }] }],
    ['对象里的 undefined', { a: undefined }],
    ['函数值', { a: () => 1 }],
    ['BigInt', { a: 10n }],
    ['数组空位', [1, , 3]],
    ['Date 对象', { a: new Date(0) }],
    ['-0', -0],
  ]) {
    const res = js.create(baseItem({ check_spec: specOf(expected) }));
    count(() => assert.equal(res.ok, false, `${label} 的 expected 必须被拒`),
      `json-pointer expected=${label} 被拒(不静默改成 null / 不丢键)`);
    count(() => assert.equal(res.reason, 'invalid_check_spec'), `expected=${label} reason=invalid_check_spec`);
  }
  {
    const cyc = {}; cyc.self = cyc;
    const res = js.create(baseItem({ check_spec: specOf(cyc) }));
    count(() => assert.equal(res.ok, false), '自引用环 expected 被拒');
    count(() => assert.equal(res.reason, 'invalid_check_spec'), '环 expected reason=invalid_check_spec');
    count(() => assert.match(String(res.message), /环/), '环被点名(不是"超出字节上限"的误导回执)');
  }
  count(() => assert.equal(js.create(baseItem({ check_spec: goodPointer })).ok, true),
    '合法 JSON expected 仍可建(宁严不误伤)');
  count(() => assert.equal(js.create(baseItem({ check_spec: goodLines })).ok, true),
    '合法 lines 规格(文本 expected)仍可建');

  count(() => assert.equal(js.create(baseItem({ conditions: { a: Infinity } })).reason, 'invalid_conditions'),
    'conditions 非有限数字被拒(JSON 会悄悄变成 null)');
  count(() => assert.equal(js.create(baseItem({ conditions: { a: NaN } })).reason, 'invalid_conditions'),
    'conditions NaN 被拒');
  count(() => assert.equal(js.create(baseItem({ conditions: { a: -0 } })).reason, 'invalid_conditions'),
    'conditions -0 被拒(JSON 会悄悄变成 0)');
  count(() => assert.equal(js.create(baseItem({ conditions: ['甲', , '乙'] })).reason, 'invalid_conditions'),
    'conditions 数组空位被拒(every/map 会跳过空位,旧写法放行)');
  count(() => assert.equal(js.create(baseItem({ version: ['1', , '2'] })).reason, 'invalid_version'),
    'version 数组空位被拒(join 会把它悄悄变成 `1+`)');
  count(() => assert.equal(js.create(baseItem({ conditions: { temp: 20, ok: true, note: null } })).ok, true),
    '合法 conditions(字符串/有限数字/布尔/null)仍可建');

  { // conditions 里的自有键 __proto__:必须原样保留,且不许碰原型链
    const protoConds = Object.fromEntries([['__proto__', 'owner'], ['temp', 20]]);
    const created = js.create(baseItem({ title: '原形安全靶子', body: 'proto', conditions: protoConds }));
    count(() => assert.equal(created.ok, true, `实际 ${JSON.stringify(created).slice(0, 160)}`),
      '自有键 __proto__ 的 conditions 可建(旧写法 o[k]=v 会静默丢键)');
    const back = js.get(created.item.id).item.conditions;
    count(() => assert.equal(Object.prototype.hasOwnProperty.call(back, '__proto__'), true),
      '落库读回后 __proto__ 仍是自有键(没被吞掉)');
    count(() => assert.equal(JSON.stringify(back), JSON.stringify(protoConds)), 'conditions 原样往返(键与键序不变)');
    count(() => assert.equal(Object.getPrototypeOf(back), Object.prototype), '读回的 conditions 原型仍是 Object.prototype');
    count(() => assert.equal({}.owner, undefined), 'Object.prototype 没有被污染');
    count(() => assert.equal(libraryContentHash(js.get(created.item.id).item), created.item.content_hash),
      '按落库内容重算摘要一致(键没丢,摘要才不漂)');
  }

  { // evidence 的 expected/observed 同样只收能无损序列化的 JSON 值
    const target = expectOk(js.create(baseItem({ title: '证据完整性靶子', body: 'ev' })), 'create 证据靶子').item;
    const baseEv = { state: 'ok', requested_source: 'test:json-integrity', actual_source: 'test:json-integrity' };
    for (const [label, patch] of [
      ['expected=Infinity', { expected: Infinity }],
      ['expected=NaN', { expected: NaN }],
      ['observed 深层 NaN', { observed: { n: [NaN] } }],
      ['expected 里的 undefined', { expected: { a: undefined } }],
      ['observed 是函数', { observed: () => 1 }],
      ['expected 是 BigInt', { expected: 1n }],
      ['observed 数组空位', { observed: [1, , 3] }],
    ]) {
      const res = js.recordCheck(target.id, target.content_hash, { ...baseEv, ...patch });
      count(() => assert.equal(res.ok, false, `${label} 必须被拒`), `evidence ${label} 被拒(不静默变成 null/丢键)`);
      count(() => assert.equal(res.reason, 'invalid_evidence'), `evidence ${label} reason=invalid_evidence`);
    }
    {
      const cyc = {}; cyc.self = cyc;
      const res = js.recordCheck(target.id, target.content_hash, { ...baseEv, expected: cyc });
      count(() => assert.equal(res.reason, 'invalid_evidence'), '环证据被拒');
      count(() => assert.match(String(res.message), /环/), '环证据被点名(不是"超过 65536 字节上限")');
    }
    count(() => assert.equal(js.checks(target.id).checks.length, 0), '被拒的证据一条都没落库(不留半截)');
    count(() => assert.equal(js.recordCheck(target.id, target.content_hash,
      { ...baseEv, expected: { a: [1, null, 'x'] }, observed: 42 }).ok, true),
    '合法 JSON 证据仍可记录(宁严不误伤)');
    const stored = js.checks(target.id).checks[0];
    count(() => assert.equal(JSON.stringify(stored.expected), JSON.stringify({ a: [1, null, 'x'] })),
      '合法证据原样落库(读回与写入一致)');
    count(() => assert.equal(stored.observed, 42), 'observed 数字原样落库(没被 String 化)');
  }

  count(() => assert.equal(js.create(baseItem({ check_spec: specOf(42, 'text-lf') })).reason, 'invalid_check_spec'),
    'text-lf + 非文本 expected 被拒(加固前建得进,一到裁判员就必然 mismatch)');
  count(() => assert.equal(js.create(baseItem({ check_spec: specOf(42, 'exact') })).ok, true),
    'exact + 数字 expected 仍可建(text-lf 的限制不外溢到 exact)');
  count(() => assert.equal(js.create(baseItem({ check_spec: {
    locator: { kind: 'lines', start: 1, end: 1 }, expected: '文本', comparison: 'text-lf' } })).ok, true),
  'text-lf + 文本 expected 仍可建');

  js.close();
}

// ─────────────────────────────────────────────────────────────────────────────
section('14) 证据完整性:剔除影子 hash 字段 / 显式 checked_at 必须是真 UTC 时刻');
{
  // 这一节盯的是两处"**账实不符**"的入口:
  //   ① `evidence.hash` 曾在这张白名单里,却**既不校验也不落库**(影子字段:核对对象的摘要本来就
  //      由 `recordCheck(itemId, hash, …)` 的第二个参数给,落 `library_check.item_hash`);
  //   ② 显式给的 `checked_at` 只要不是"非空字符串"就静默回落 `now()` ⇒ 证据写着 12:00、落库却是
  //      此刻,而 `checked_at` 正是这次认证的**观测时间**,被悄悄改写等于伪造时间戳。
  const es = new LibraryStore(join(dir, 'evidence-integrity.db'));
  const evBase = { state: 'ok', requested_source: 'test:evidence-integrity' };
  const mkTarget = (tag) => expectOk(es.create(baseItem({ title: `证据靶子 ${tag}`, body: tag })), `create ${tag}`).item;

  { // ① evidence.hash:整条删掉 ⇒ unknown_field;摘要只认第 2 参数
    const t1 = mkTarget('hash');
    const withHash = es.recordCheck(t1.id, t1.content_hash, { ...evBase, hash: t1.content_hash });
    count(() => assert.equal(withHash.ok, false), 'evidence.hash 被拒(不许夹带第二份摘要)');
    count(() => assert.equal(withHash.reason, 'unknown_field'), 'evidence.hash reason=unknown_field(不是静默忽略)');
    count(() => assert.match(String(withHash.message), /hash/), '回执点名 hash');
    count(() => assert.equal(es.checks(t1.id).checks.length, 0), '带 hash 的证据一条都没落库');

    const good = expectOk(es.recordCheck(t1.id, t1.content_hash, { ...evBase, checked_at: CHECKED_AT }), '不带 hash 的证据');
    count(() => assert.equal(good.check.item_hash, t1.content_hash),
      '核对对象的摘要是 recordCheck 第 2 参数(落 item_hash)');
    count(() => assert.equal(good.check.checked_at, CHECKED_AT), '合法 checked_at 原样落库');
  }

  { // ② 显式 checked_at:非法一律拒,绝不静默回落 now()
    const t2 = mkTarget('checked_at');
    for (const [label, bad] of [
      ['空串', ''],
      ['带首尾空白', ' 2026-10-06T12:00:00.000Z '],
      ['无 Z 的本地时刻', '2026-10-06T12:00:00.000'],
      ['带 +08:00 偏移量', '2026-10-06T12:00:00+08:00'],
      ['纯日期', '2026-10-06'],
      ['月份 13', '2026-13-01T00:00:00Z'],
      ['不存在的 02-30', '2026-02-30T00:00:00Z'],
      ['时 25', '2026-10-06T25:00:00Z'],
      ['分 60', '2026-10-06T12:60:00Z'],
      ['null', null],
      ['数字时间戳', 1770000000000],
      ['数组', ['2026-10-06T12:00:00.000Z']],
    ]) {
      const res = es.recordCheck(t2.id, t2.content_hash, { ...evBase, checked_at: bad });
      count(() => assert.equal(res.ok, false, `checked_at=${label} 必须被拒`), `checked_at=${label} 被拒`);
      count(() => assert.equal(res.reason, 'invalid_evidence'), `checked_at=${label} reason=invalid_evidence`);
    }
    count(() => assert.equal(es.get(t2.id).item.checked_at, null), '被拒的显式 checked_at 没把当前时刻写进条目');
    count(() => assert.equal(es.checks(t2.id).checks.length, 0), '被拒的 checked_at 一条都没落库');

    const fractional = '2026-10-06T12:00:00.123456789Z';
    const kept = expectOk(es.recordCheck(t2.id, t2.content_hash, { ...evBase, checked_at: fractional }), '纳秒精度 UTC 时刻');
    count(() => assert.equal(kept.checked_at, fractional), '9 位小数的合法 UTC 时刻原样保留(不被改写成毫秒)');
    count(() => assert.equal(es.get(t2.id).item.checked_at, fractional), '条目上的 checked_at 与证据一致(没被换成 now)');

    const t3 = mkTarget('checked_at-缺省');
    const before = Date.now();
    const auto = expectOk(es.recordCheck(t3.id, t3.content_hash, { ...evBase }), '缺省 checked_at');
    const after = Date.now();
    count(() => assert.equal(auto.adopted, true), '缺省 checked_at 仍可采纳(内部调用不必传该字段)');
    count(() => assert.match(String(auto.checked_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      '缺省时取 nowIso()(标准 UTC ISO 形状)');
    count(() => assert.ok(Date.parse(auto.checked_at) >= before - 1000 && Date.parse(auto.checked_at) <= after + 1000),
      '缺省时取的时刻落在本次调用前后(确实是当前时刻)');
  }

  es.close();
}

// ─────────────────────────────────────────────────────────────────────────────
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用,交给系统清 */ }
console.log(`\n断言 ${assertions} 条,失败 ${failed} 条`);
console.log(failed === 0 ? '✓ library-store 全部通过' : `✗ library-store 有 ${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
