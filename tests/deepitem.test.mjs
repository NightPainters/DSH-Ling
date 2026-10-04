// 深层库条目表(1.6 步 2,2026-10-04):**结论层**的落点 —— 从原文里提炼出的、可独立读懂的结论。
//   主人给的架构口径(逐字):「从浅层记忆库落入深层库的时候,就是从浅层库中提取关键的东西,落入深层库,
//   把浅层库的那些什么工具调用,还有过时历史,比如反复调节UI之类的东西剥离掉,重要的东西比如我答应过你
//   要尽快做完记忆库然后做主动开口层。然后在召回的时候再重新装配。」
//   本套**只钉结构**(表 / 列 / 索引 / 版本 / 三个语义位):
//     ① 为什么单独一套 —— 这一步只落"落点",提炼与召回判据在步 3/4;结构锁不先钉住,
//        后面动 DDL(以及 v16→v17 迁移)时没有回归面。
//     ② 三个要一直成立的语义位:origin='user' 不许被自动覆盖、superseded_by 只追不替、
//        branch_id 是"气根"(可空 ⇒ 条目**不隶属**任何枝,填了也**不动** branch 表)。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
const section = (t) => console.log('── ' + t);

const dir = mkdtempSync(join(tmpdir(), 'ling-deep-'));
const m = new MemoryStore(join(dir, 'a.db'));

section('1) 表就位 + 列齐');
eq(String(m.kvGet('schema_version')), '17', 'E1:schema_version 前进到 17');
const cols = m.db.prepare('PRAGMA table_info(deep_item)').all().map((c) => c.name);
check(cols.length > 0, 'E1:deep_item 表存在');
const want = ['id', 'kind', 'text', 'at', 'conv_id', 'seq_from', 'seq_to', 'src', 'hit_count',
  'pinned', 'durability', 'superseded_by', 'origin', 'branch_id', 'created_at', 'updated_at'];
for (const c of want) check(cols.includes(c), `E1:deep_item 缺列 ${c}(实际 ${cols.join(',')})`);
// 可下钻验证的三列必须可空写(它们默认 '' 或 0,允许"只知道会话、不知道轮次")
const nn = m.db.prepare('PRAGMA table_info(deep_item)').all().filter((c) => c.name === 'text' || c.name === 'kind');
check(nn.every((c) => Number(c.notnull) === 1), 'E1:kind / text 是 NOT NULL(条目没有这两样就不成立)');

section('2) 索引');
const idx = m.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deep_item'").all().map((r) => r.name);
for (const n of ['deep_item_kind', 'deep_item_conv', 'deep_item_branch', 'deep_item_rank']) {
  check(idx.includes(n), `E2:缺索引 ${n}(实际 ${idx.join(',')})`);
}

section('3) 默认值');
m.db.prepare('INSERT INTO deep_item (id, kind, text) VALUES (?,?,?)').run('di:test-1', 'commitment', '我答应过要尽快做完记忆库');
const r = m.db.prepare('SELECT * FROM deep_item WHERE id=?').get('di:test-1');
eq(String(r.origin), 'auto', 'E3:origin 默认 auto');
eq(Number(r.hit_count), 0, 'E3:hit_count 默认 0(加固是**后验**的,不预设)');
eq(Number(r.pinned), 0, 'E3:pinned 默认 0');
eq(String(r.branch_id), '', 'E3:branch_id 默认空(条目**不隶属**任何枝)');
check(!!r.created_at, 'E3:created_at 自动填');

section('4) 气根:枝侧可反向引用,但**不动树**');
// 注:干净库建出来**自带 1 行主干**,所以判据是"前后不变"而不是"等于 0"。
const treeBefore = Number(m.db.prepare('SELECT COUNT(*) n FROM branch').get().n);
m.db.prepare('UPDATE deep_item SET branch_id=? WHERE id=?').run('br:vein-x', 'di:test-1');
eq(String(m.db.prepare('SELECT branch_id FROM deep_item WHERE id=?').get('di:test-1').branch_id), 'br:vein-x',
  'E4:branch_id 可被填(气根)');
eq(Number(m.db.prepare('SELECT COUNT(*) n FROM branch').get().n), treeBefore,
  'E4:挂气根**不改** branch 表行数(深层库与记忆树并立 —— D1 已拍)');

section('5) 只追不替 + origin=user 的语义位');
m.db.prepare('INSERT INTO deep_item (id,kind,text,superseded_by,origin) VALUES (?,?,?,?,?)')
  .run('di:test-2', 'fact', '旧结论', 'di:test-3', 'user');
const r3 = m.db.prepare('SELECT superseded_by, origin FROM deep_item WHERE id=?').get('di:test-2');
eq(String(r3.superseded_by), 'di:test-3', 'E5:superseded_by 记下"被谁取代"(旧的留痕)');
eq(String(r3.origin), 'user', 'E5:origin=user 可写(主人手写位 —— 后续提炼不许覆盖它)');
eq(Number(m.db.prepare('SELECT COUNT(*) n FROM deep_item').get().n), 2, 'E5:两条都在(**没有**删旧行)');

section('6) 读写方法(1.6 步 3 的落点)');
const a1 = m.addDeepItem({ kind: 'commitment', text: '我答应过尽快做完记忆库然后做主动开口层', convId: 'sess-a', seqFrom: 10, seqTo: 12, at: '2026-10-03T10:00:00Z' });
check(a1.ok && a1.id.startsWith('di:'), 'E6:addDeepItem 返回 di: 前缀的 id');
eq(a1.existed, false, 'E6:首次写入 existed=false');
eq(String(m.deepItemById(a1.id).src), 'dsh', 'E6:src 缺省按 conv_id 推导(rawSourceOf)');
// 幂等:同 (conv_id, seq_from, seq_to, text) 再写一遍 ⇒ 不新增行、返回同一个 id
const a2 = m.addDeepItem({ kind: 'commitment', text: '我答应过尽快做完记忆库然后做主动开口层', convId: 'sess-a', seqFrom: 10, seqTo: 12 });
eq(a2.existed, true, 'E6:重复提炼 existed=true(提炼器可安全重跑)');
eq(a2.id, a1.id, 'E6:重复提炼返回同一个 id');
eq(Number(m.db.prepare('SELECT COUNT(*) n FROM deep_item WHERE conv_id=?').get('sess-a').n), 1, 'E6:重复提炼**没有**多写一行');
eq(m.addDeepItem({ kind: '', text: 'x' }).ok, false, 'E6:空 kind 拒绝');
eq(m.addDeepItem({ kind: 'fact', text: '   ' }).ok, false, 'E6:空 text 拒绝');

const a3 = m.addDeepItem({ kind: 'fact', text: '记忆库跑在 WAL 模式,备份必须用 VACUUM INTO', convId: 'sess-b', seqFrom: 5, seqTo: 5 });
m.supersedeDeepItem(a1.id, a3.id);
eq(String(m.deepItemById(a1.id).superseded_by), a3.id, 'E6:supersede 记下"被谁取代"');
check(!m.listDeepItems().some((r) => r.id === a1.id), 'E6:listDeepItems 默认**排除**已被取代的');
check(m.listDeepItems({ includeSuperseded: true }).some((r) => r.id === a1.id), 'E6:includeSuperseded:true 能看见旧的(只追不替)');
eq(m.supersedeDeepItem('di:nope', a3.id).reason, 'not-found', 'E6:取代不存在的条目被拒');

eq(m.bumpDeepHit(a3.id).ok, true, 'E6:bumpDeepHit 成功');
eq(Number(m.deepItemById(a3.id).hit_count), 1, 'E6:加固 +1(⚠️ 只应由"真被采用"调用)');
m.setDeepPinned(a3.id, true);
eq(Number(m.deepItemById(a3.id).pinned), 1, 'E6:置顶写入');
eq(m.listDeepItems()[0].id, a3.id, 'E6:排面按 置顶 → 加固 → 新(置顶的排最前)');
check(m.deepItemCount() >= 3, 'E6:deepItemCount 计数');
eq(m.listDeepItems({ kind: 'commitment' }).every((r) => r.kind === 'commitment'), true, 'E6:按 kind 过滤');

// 7) **老库迁移**:v16 结构(deep_item 已存在、但没有 durability 列)⇒ 重开必须自愈。
//   ⚠️ 这条专打 2026-10-04 那个只在「老库 + 新代码」下才炸的 bug:当时把
//   `CREATE INDEX ... ON deep_item(durability)` 写进了 DDL,而 DDL **先于迁移**执行 ⇒
//   老库建索引时列还不存在 ⇒ **整条 db.exec(DDL) 失败 ⇒ 插件加载失败**。
//   全链 44 套当时**全绿**都没抓到,原因就在这一句:所有测试库都是**新建**的(DDL 建表时就带上新列),
//   而生产库恰恰是老库。⇒ 断言因此必须落在"老库重开"这条组合上。
{
  const { DatabaseSync } = await import('node:sqlite');
  const p = join(dir, 'old-v16.db');
  const raw = new DatabaseSync(p);
  raw.exec(`CREATE TABLE deep_item (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT '', conv_id TEXT NOT NULL DEFAULT '', seq_from INTEGER NOT NULL DEFAULT 0,
    seq_to INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL DEFAULT '', hit_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0, superseded_by TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'auto',
    branch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT '')`);
  raw.prepare("INSERT INTO deep_item (id,kind,text) VALUES ('di:old','fact','老库条目')").run();
  raw.close();
  let m2 = null; let err = null;
  try { m2 = new MemoryStore(p); } catch (e) { err = e; }
  check(m2 !== null, 'E7:老库重开成功(修前:DDL 因索引列不存在而整个失败)实际 err=' + String(err?.message ?? err).slice(0, 80));
  if (m2) {
    const c2 = m2.db.prepare('PRAGMA table_info(deep_item)').all().map((c) => c.name);
    check(c2.includes('durability'), 'E7:老库补上 durability 列');
    eq(String(m2.kvGet('schema_version')), '17', 'E7:老库迁移后 schema_version 前进到 17');
    eq(m2.db.prepare("SELECT durability FROM deep_item WHERE id='di:old'").get()?.durability, 'long',
      'E7:存量行按中性档回填 long(既不冒进进开场、也不被永久排除)');
    check(m2.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='deep_item_durability'").get() !== undefined,
      'E7:索引发迁移里建出来(⚠️ 不许再挪回 DDL)');
    try { m2.db.close(); } catch { /* ignore */ }
  }
}

try { m.db.close(); } catch { /* 关不掉不影响结论 */ }
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶发占用,留给系统清 */ }
console.log(ok ? '✓ deepitem 全部通过' : '✗ deepitem 有失败');
process.exit(ok ? 0 : 1);
