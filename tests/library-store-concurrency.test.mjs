// 1.7 图书馆 · **并发事务**永久回归(revise / withdraw / recordCheck × 第二条连接/第二个进程)。
//
// 为什么要单独一套:2026-10-07 的窄审计复现出"判定在 `BEGIN IMMEDIATE` 之前"造成的三种后果
// (陈旧修订被接受且谱系分叉 / 撤下落在已被取代的版本上 / 已完成核对被整笔回滚丢掉)。
// 这一套把它们钉成**永久回归**:修好后必须一直绿。
//
// 钩子位置(关键):装在 **`store._tx` 入口**上,不是 `st.getItem.get` 上 ——
//   ① 它对应"真实窗口":调用方读完了状态、正要进事务的那一刻;竞争者在这个点上提交;
//   ② 修好后读发生在锁内,若把钩子装在 `getItem.get` 上,钩子里去开第二条连接/子进程
//      会在父进程**已持锁**时抢锁 ⇒ 人为死锁(不是真缺陷,是探针设计的错)。
//   ③ 因此本套的语义是:**修后必须在锁内读到赢家状态**,并按赢家状态给回执。
//
// 隔离:import 任何被测模块**之前**就把 DSH_HOME/HOME/USERPROFILE 指进自建目录;
//   子进程**不自己 mkdtemp**(否则每个孩子都会漏一个 home 目录),只用父进程传进去的
//   同一份隔离目录;所有自建目录在 finally 里清,子进程有超时与强杀兜底。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 0) 隔离:必须在 import 被测模块之前 ────────────────────────────────────────────
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');       // dsh-ling/
const BOX = mkdtempSync(join(tmpdir(), 'ling-conc-'));
const HOME_DIR = join(BOX, 'home');
const TMP_DIR = join(BOX, 'db');
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
process.env.DSH_HOME = HOME_DIR;
process.env.HOME = HOME_DIR;
process.env.USERPROFILE = HOME_DIR;

let assertions = 0;
let failed = 0;
const liveStores = new Set();
const liveChildren = new Set();
function cleanup() {
  for (const child of liveChildren) { try { child.kill('SIGKILL'); } catch {} }
  for (const store of [...liveStores]) { try { store.close(); } catch {} }
  try { rmSync(BOX, { recursive: true, force: true }); return true; }
  catch (error) { console.error('临时目录清理失败:', error.message); return false; }
}
// Register before imports/scenarios, not after they have already run.
process.once('exit', cleanup);
const watchdog = setTimeout(() => {
  console.error('library-store-concurrency 超时(60 s)');
  cleanup();
  process.exit(1);
}, 60000);
watchdog.unref();
try {
const { LibraryStore: BaseLibraryStore } = await import(pathToFileURL(join(ROOT, 'lib/host/library-store.js')).href);
class LibraryStore extends BaseLibraryStore {
  constructor(...args) { super(...args); liveStores.add(this); }
  close() { try { return super.close(); } finally { liveStores.delete(this); } }
}
const STORE_URL = pathToFileURL(join(ROOT, 'lib/host/library-store.js')).href;

// ── 1) 计数器(每条断言都计数;红/绿都能当证据)────────────────────────
let sectionName = '(none)';
const count = (target, message) => {
  assertions += 1;
  try { target(); } catch (e) { failed += 1; console.log(`  ✗ [${sectionName}] ${message}\n     ${e.message}`); }
};
const section = (name) => { sectionName = name; console.log(`── ${name}`); };
const eq = (a, b, m) => count(() => assert.equal(a, b, m), m);
const ok = (c, m) => count(() => assert.equal(Boolean(c), true, m), m);

// ── 2) 竞争者:写到 TMP_DIR 里的一次性子脚本(**不**自己建 home,不碰别的目录)──────
const COMPETITOR = join(TMP_DIR, 'competitor.mjs');
writeFileSync(COMPETITOR, `import { appendFileSync, existsSync } from 'node:fs';
// ⚠️ LING_STORE_URL 已经是 file:// URL 字符串(父进程用 pathToFileURL(...).href 生成),
//    这里**不能**再包一层 pathToFileURL —— 那样会变成 file:///E:/.../file:///E:/... ,
//    子进程直接 ERR_MODULE_NOT_FOUND(第一次跑本套时就是这么整片红的,错的不是被测代码)。
const { LibraryStore } = await import(process.env.LING_STORE_URL);
const [action, dbPath, id, observedHash] = process.argv.slice(2);
const out = { action, pid: process.pid };
const store = new LibraryStore(dbPath);
const evidence = (at) => ({
  state: 'ok', requested_source: 'concurrency-suite:requested', actual_source: 'concurrency-suite:actual',
  source_hash: 'sha256:' + 'a'.repeat(64), observed: 'observed', comparison: 'exact', checked_at: at,
});
try {
  if (action === 'revise') {
    const cur = store.get(id);
    const res = store.revise(id, { body: 'competitor-revise-' + process.pid }, cur.item.content_hash);
    out.ok = res.ok === true; out.reason = res.reason ?? null; out.new_revision = res.item?.revision ?? null;
    out.hash = res.item?.content_hash ?? null;
  } else if (action === 'withdraw') {
    const cur = store.get(id);
    const res = store.withdraw(id, 'competitor-withdraw', cur.item.content_hash);
    out.ok = res.ok === true; out.reason = res.reason ?? null;
  } else if (action === 'recordCheck') {
    const res = store.recordCheck(id, observedHash, evidence('2026-10-07T01:00:00.000Z'));
    out.ok = res.ok === true; out.adopted = res.adopted ?? null; out.seq = res.check_sequence ?? null;
  } else if (action === 'recordCheck-barrier') {
    appendFileSync(process.env.LING_GATE_ARRIVAL, String(process.pid) + '\\n');   // 已开库、就位
    const t0 = Date.now();
    while (!existsSync(process.env.LING_GATE_RELEASE)) {                          // 等父进程放行
      if (Date.now() - t0 > 10000) { out.barrier_timeout = true; break; }
    }
    out.barrier_seen = !out.barrier_timeout;
    const s = process.hrtime.bigint();
    try {
      const res = store.recordCheck(id, observedHash, evidence('2026-10-07T01:00:01.000Z'));
      out.ok = res.ok === true; out.adopted = res.adopted ?? null; out.seq = res.check_sequence ?? null;
    } catch (e) { out.ok = false; out.threw = String(e?.message ?? e).slice(0, 200); }
    out.write_ms = Number(process.hrtime.bigint() - s) / 1e6;
  } else throw new Error('unknown action: ' + action);
} catch (e) { out.ok = false; out.threw = String(e?.name ?? 'Error') + ': ' + String(e?.message ?? e).slice(0, 240); }
try { store.close(); } catch { /* 关不掉不改变结论 */ }
appendFileSync(process.env.LING_RESULT_FILE, JSON.stringify(out) + '\\n');
process.exit(out.ok === false && !out.barrier_timeout ? 1 : 0);
`, 'utf8');

let competitorSeq = 0;
/**
 * 起一个真进程,在同一个库文件上做一笔写;结果经**文件**回传
 * (`spawnSync` 默认 `stdio:'pipe'` 在本机沙箱是 EPERM,所以用 inherit + 结果文件)。
 */
function compete(args, extraEnv = {}, timeoutMs = 20000) {
  competitorSeq += 1;
  const resultFile = join(TMP_DIR, `result-${competitorSeq}.jsonl`);
  const run = spawnSync(process.execPath, [COMPETITOR, ...args], {
    stdio: 'inherit',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',                 // 卡住就强杀,不留孤儿进程
    env: {
      ...process.env,
      LING_STORE_URL: STORE_URL,
      LING_RESULT_FILE: resultFile,
      ...extraEnv,
    },
  });
  let parsed = null;
  if (existsSync(resultFile)) {
    const lines = readFileSync(resultFile, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) { try { parsed = JSON.parse(last); } catch { parsed = { parse_error: last.slice(0, 200) }; } }
  }
  return {
    status: run.status,
    signal: run.signal ?? null,
    spawn_error: run.error ? `${run.error.code ?? ''}`.trim() || String(run.error.message) : null,
    child: parsed,
  };
}

/**
 * 把 `store._tx` 包一层:进事务的**那一刻**先把竞争者放出去提交,再执行原 `_tx`。
 * 修后原 `_tx` 才能拿到锁 ⇒ 原方法的**读发生在竞争者提交之后**,必须看到赢家状态。
 */
function armTxHook(store, fire) {
  const original = store._tx;
  let fired = false;
  store._tx = function (fn) {
    if (!fired) { fired = true; fire(); }
    return original.call(this, fn);
  };
  return { fired: () => fired, disarm: () => { store._tx = original; } };
}

/** 读一个结果文件里最后一行 JSON(子进程可能写多行,最后一行才是终局)。 */
function readLastJson(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try { return JSON.parse(last); } catch { return { parse_error: last.slice(0, 200) }; }
}

/**
 * 等异步子进程退出,带硬超时与强杀 —— 永久回归不许因为一个卡住的孩子把整个测试挂死。
 * ⚠️ **必须 await 事件**:`child.exitCode` 要靠事件循环收到子进程退出才会被赋值;
 *    早先这里用同步自旋读 exitCode ⇒ 事件循环根本没机会跑,永远读到 null,
 *    于是"子进程明明写完了却被判成没退出"(第一次跑本套时的 6.2 就是这么红的)。
 */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve(value); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 可能已经退出 */ }
      killTimer = setTimeout(() => finish(false), 5000);
    }, timeoutMs);
    let killTimer = null;
    child.once('exit', () => finish(true));
    child.once('error', () => finish(false));
  });
}

// ── 3) 固定件与自检 ────────────────────────────────────────────────────────────────
const dbFile = (name) => join(TMP_DIR, `${name}.db`);

function seed(store, over = {}) {
  const res = store.create({
    title: '并发回归靶子', body: '第一版正文', category: 'project-spec', source_kind: 'our-code',
    source_ref: 'concurrency-suite:seed', as_of: '2026-10-07', ...over,
  });
  if (!res.ok) throw new Error(`seed 失败:${JSON.stringify(res)}`);
  return res.item;
}

const evidence = (at = '2026-10-07T01:00:02.000Z', over = {}) => ({
  state: 'ok', requested_source: 'concurrency-suite:requested', actual_source: 'concurrency-suite:actual',
  source_hash: 'sha256:' + 'a'.repeat(64), observed: 'observed', comparison: 'exact', checked_at: at, ...over,
});

/** 谱系自检:previous_id 链必须逐版咬合、active 只能有一个。 */
function audit(store, anyId) {
  const h = store.history(anyId);
  const items = h.revisions;
  const byId = new Map(items.map((x) => [x.id, x]));
  const breaks = [];
  for (const item of items) {
    if (!item.previous_id) continue;
    const prev = byId.get(item.previous_id);
    if (!prev) { breaks.push(`版本 ${item.revision}:previous_id 不在谱系里`); continue; }
    if (prev.superseded_by !== item.id) {
      breaks.push(`版本 ${item.revision}:前一版 superseded_by=${prev.superseded_by ?? '(空)'},不是它`);
    }
  }
  const active = items.filter((x) => x.state === 'active');
  const bothMarked = items.filter((x) => x.superseded_by && x.withdrawn_at).map((x) => x.revision);
  return { items, breaks, active, bothMarked, revisionCount: items.length };
}

/** 回执与落库一致:recordCheck 的回执必须与同事务结果一致。 */
function checkReceiptConsistency(store, id, receipt) {
  const row = store.get(id).item;
  const checks = store.checks(id);
  return {
    rowState: row.state,
    rowCheckedState: row.checked_state,
    receiptAdopted: receipt.adopted,
    receiptCheckedState: receipt.checked_state,
    checksTotal: checks.total,
    adoptedRows: checks.checks.filter((c) => c.adopted).length,
    lastCheck: checks.checks[checks.checks.length - 1] ?? null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════
section('0) 串行对照:无竞争时语义必须自洽(修前修后都应绿)');
{
  const db = dbFile('serial');
  const s = new LibraryStore(db);
  const item = seed(s);
  const competitor = compete(['revise', db, item.id]);
  eq(competitor.child?.ok, true, '0.1 竞争者在串行下修订成功');
  const stale = s.revise(item.id, { body: '陈旧修订' }, item.content_hash);
  eq(stale.ok, false, '0.2 串行下陈旧 revised 被拒');
  eq(['not_active', 'hash_mismatch'].includes(stale.reason), true, `0.3 同步被拒的 reason 可判定(实际 ${stale.reason})`);
  const a = audit(s, item.id);
  eq(a.breaks.length, 0, '0.4 串行谱系无断链');
  eq(a.active.length, 1, '0.5 串行恰好一个 active');
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('0b) 拒绝码口径:并发场景的"拒"必须是可判定的短码,不能靠人话');
{
  const db = dbFile('reason-codes');
  const s = new LibraryStore(db);
  const item = seed(s);
  // ① 条目仍 active、但观测哈希不对 ⇒ hash_mismatch/stale
  const wrongHash = 'sha256:' + 'b'.repeat(64);
  const stale = s.revise(item.id, { body: '别的正文' }, wrongHash);
  eq(stale.ok, false, '0b.1 哈希不等 ⇒ 拒');
  eq(stale.reason, 'hash_mismatch', '0b.2 哈希不等 ⇒ reason=hash_mismatch');
  eq(stale.status, 'stale', '0b.3 哈希不等 ⇒ status=stale(第二机器档)');
  // ② 条目已被取代 ⇒ not_active(与 hash_mismatch 可区分)
  const r2 = s.revise(item.id, { body: '第二版' }, item.content_hash);
  eq(r2.ok, true, '0b.4 正常修订成功');
  const again = s.revise(item.id, { body: '第三版' }, item.content_hash);
  eq(again.ok, false, '0b.5 已被取代的版本不能再修订');
  eq(again.reason, 'not_active', '0b.6 已被取代 ⇒ reason=not_active(不是 hash_mismatch)');
  // ③ 同哈希撤下两次 ⇒ 第二次 not_active
  const w1 = s.withdraw(r2.item.id, '第一次撤下', r2.item.content_hash);
  eq(w1.ok, true, '0b.7 第一次撤下成功');
  const w2 = s.withdraw(r2.item.id, '第二次撤下', r2.item.content_hash);
  eq(w2.ok, false, '0b.8 第二次撤下被拒');
  eq(w2.reason, 'not_active', '0b.9 重复撤下 ⇒ reason=not_active');
  eq(s.get(r2.item.id).item.withdrawn_reason, '第一次撤下', '0b.10 留痕仍是先到者的理由');
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('1) revise vs revise(竞争者在 _tx 入口提交下一版)');
{
  const db = dbFile('revise-revise');
  const s = new LibraryStore(db);
  const item = seed(s);
  let hookResult = null;
  const hook = armTxHook(s, () => { hookResult = compete(['revise', db, item.id]); });
  let res = null;
  let threw = null;
  try { res = s.revise(item.id, { body: '父进程陈旧修订' }, item.content_hash); }
  catch (e) { threw = String(e?.message ?? e); }
  const a = audit(s, item.id);
  ok(hook.fired(), '1.0 钩子确实在 _tx 入口触发');
  eq(hookResult?.child?.ok, true, '1.1 竞争者提交了下一版');
  eq(threw, null, `1.2 父进程不得抛异常(实际 ${threw ?? '未抛'})`);
  eq(res?.ok, false, '1.3 竞争下陈旧修订必须被拒(**修前此处红**)');
  eq(a.active.length, 1, `1.4 库内只能有一个 active(实际 ${a.active.length}:${a.active.map((x) => x.revision).join(',')})(**修前此处红**)`);
  eq(a.breaks.length, 0, `1.5 谱系不得断链/被改指(实际 ${a.breaks.join(' / ') || '无断链'})(**修前此处红**)`);
  hook.disarm();
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('2) withdraw vs revise(竞争者在窗口内取代该版本)');
{
  const db = dbFile('withdraw-revise');
  const s = new LibraryStore(db);
  const item = seed(s);
  let hookResult = null;
  const hook = armTxHook(s, () => { hookResult = compete(['revise', db, item.id]); });
  const res = s.withdraw(item.id, '父进程在窗口内撤下', item.content_hash);
  const a = audit(s, item.id);
  const oldRow = s.get(item.id).item;
  ok(hook.fired(), '2.0 钩子在 _tx 入口触发');
  eq(hookResult?.child?.ok, true, '2.1 竞争者取代成功');
  eq(res.ok, false, '2.2 竞争下不得撤下"已被取代的版本"(**修前此处红**)');
  eq(oldRow.withdrawn_at, null, '2.3 被取代的旧版本不该带上 withdrawn_at(**修前此处红**)');
  eq(a.bothMarked.length, 0, `2.4 没有"既 withdrawn 又 superseded"的行(实际 ${a.bothMarked.join(',') || '无'})(**修前此处红**)`);
  eq(a.active.length, 1, '2.5 恰好一个 active');
  hook.disarm();
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('3) withdraw vs withdraw(双撤下同一版本)');
{
  const db = dbFile('withdraw-withdraw');
  const s = new LibraryStore(db);
  const item = seed(s);
  let hookResult = null;
  const hook = armTxHook(s, () => { hookResult = compete(['withdraw', db, item.id]); });
  const res = s.withdraw(item.id, '父进程也撤下', item.content_hash);
  const row = s.get(item.id).item;
  ok(hook.fired(), '3.0 钩子在 _tx 入口触发');
  eq(hookResult?.child?.ok, true, '3.1 竞争者撤下成功');
  eq(res.ok, false, '3.2 第二次撤下必须被拒(**修前此处红**)');
  eq(row.state, 'withdrawn', '3.3 该版本确实处于 withdrawn');
  eq(row.checked_state, '', '3.4 撤下不涉及认证状态');
  eq(res.item?.withdrawn_reason ?? row.withdrawn_reason, 'competitor-withdraw', '3.5 留痕是**先到者**的理由,不被后到者覆盖');
  hook.disarm();
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('4) recordCheck vs revise(核对目标在窗口内被取代)');
{
  const db = dbFile('check-revise');
  const s = new LibraryStore(db);
  const item = seed(s);
  let hookResult = null;
  const hook = armTxHook(s, () => { hookResult = compete(['revise', db, item.id]); });
  let res = null;
  let threw = null;
  try { res = s.recordCheck(item.id, item.content_hash, evidence()); } catch (e) { threw = String(e?.message ?? e); }
  const rec = checkReceiptConsistency(s, item.id, res ?? {});
  ok(hook.fired(), '4.0 钩子在 _tx 入口触发');
  eq(hookResult?.child?.ok, true, '4.1 竞争者取代成功');
  eq(threw, null, `4.2 竞争下不得抛异常(实际 ${threw ?? '未抛'})(**修前此处红**)`);
  eq(res?.ok, true, '4.3 已完成的核对必须留档(ok:true)(**修前此处红**)');
  eq(rec.checksTotal, 1, `4.4 核对历史里必须有这一条(实际 ${rec.checksTotal})(**修前此处红**)`);
  eq(res?.adopted, false, '4.5 目标已被取代 ⇒ 不得采纳');
  eq(rec.adoptedRows, 0, '4.6 库里 adopted 标记不得落地');
  eq(rec.rowCheckedState, '', '4.7 被取代版本的 checked_state 不受影响');
  eq(res?.checked_state, rec.rowCheckedState, '4.8 回执的 checked_state 与库内一致(同事务复读)');
  hook.disarm();
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('5) recordCheck vs withdraw(核对目标在窗口内被撤下)');
{
  const db = dbFile('check-withdraw');
  const s = new LibraryStore(db);
  const item = seed(s);
  let hookResult = null;
  const hook = armTxHook(s, () => { hookResult = compete(['withdraw', db, item.id]); });
  let res = null;
  let threw = null;
  try { res = s.recordCheck(item.id, item.content_hash, evidence()); } catch (e) { threw = String(e?.message ?? e); }
  const rec = checkReceiptConsistency(s, item.id, res ?? {});
  ok(hook.fired(), '5.0 钩子在 _tx 入口触发');
  eq(hookResult?.child?.ok, true, '5.1 竞争者撤下成功');
  eq(threw, null, `5.2 竞争下不得抛异常(实际 ${threw ?? '未抛'})(**修前此处红**)`);
  eq(res?.ok, true, '5.3 已完成的核对必须留档(**修前此处红**)');
  eq(rec.checksTotal, 1, `5.4 核对历史里必须有这一条(实际 ${rec.checksTotal})(**修前此处红**)`);
  eq(res?.adopted, false, '5.5 目标已撤下 ⇒ 不得采纳');
  eq(rec.adoptedRows, 0, '5.6 库里 adopted 标记不得落地');
  eq(rec.rowCheckedState, '', '5.7 已撤下版本不被贴认证');
  eq(res?.checked_state, rec.rowCheckedState, '5.8 回执与库内一致');
  hook.disarm();
  s.close();
}

// ═════════════════════════════════════════════════════════════════════════════════
section('6) 序号正对照:两个进程由同一闸门释放写核对(异步 spawn + 双文件闸门)');
{
  const db = dbFile('seq-true');
  const s = new LibraryStore(db);
  const item = seed(s);
  const arrival = join(TMP_DIR, 'true-arrival');
  const release = join(TMP_DIR, 'true-release');
  const childResult = join(TMP_DIR, 'true-result.jsonl');
  for (const f of [arrival, release, childResult]) { try { rmSync(f, { force: true }); } catch { /* 不存在更好 */ } }
  const { spawn } = await import('node:child_process');
  // ⚠️ 这里必须是**异步** spawn:`spawnSync` 会阻塞父进程直到子进程退出,
  //   于是"父进程放行闸门"永远发生在子进程退出**之后** —— 那就不是同时,只是顺序写
  //   (旧版 A4 正是这么错的,已被独立探针抓出)。异步 spawn 才能让两边真正并存。
  const child = spawn(process.execPath, [COMPETITOR, 'recordCheck-barrier', db, item.id, item.content_hash], {
    stdio: 'inherit',
    env: {
      ...process.env, LING_STORE_URL: STORE_URL, LING_RESULT_FILE: childResult,
      LING_GATE_ARRIVAL: arrival, LING_GATE_RELEASE: release,
    },
  });
  liveChildren.add(child);
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });
  // 等子进程"已开库、正在闸门上等"的到达信号(带超时,避免挂死)
  const arrivedDeadline = Date.now() + 15000;
  while (!existsSync(arrival) && !spawnError && child.exitCode === null && Date.now() < arrivedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  ok(existsSync(arrival), '6.1 子进程已就位(到达信号出现)');
  let parentRes = null;
  let parentThrew = null;
  let parentMs = 0;
  if (existsSync(arrival)) {
    writeFileSync(release, 'go');                        // 放行:两边此后各自立刻发写
    const t0 = process.hrtime.bigint();
    try { parentRes = s.recordCheck(item.id, item.content_hash, evidence('2026-10-07T01:00:03.000Z')); }
    catch (e) { parentThrew = String(e?.message ?? e); }
    parentMs = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const exited = spawnError ? false : await waitForExit(child, 20000);
  if (exited) liveChildren.delete(child);
  const childOut = readLastJson(childResult);
  const checks = s.checks(item.id);
  const seqs = checks.checks.map((c) => c.check_sequence);
  eq(exited, true, '6.2 子进程在超时前退出(无孤儿进程)');
  eq(childOut?.barrier_seen, true, '6.3 子进程确实看到了放行信号');
  eq(parentThrew, null, `6.4 父进程写核对不得抛异常(实际 ${parentThrew ?? '未抛'})`);
  eq(childOut?.threw ?? null, null, `6.5 子进程写核对不得抛异常(实际 ${childOut?.threw ?? '未抛'})`);
  eq(parentRes?.ok, true, '6.6 父进程的核对要留档');
  eq(childOut?.ok, true, '6.7 子进程的核对要留档');
  eq(checks.total, 2, `6.8 两笔核对都要在库里(实际 ${checks.total})`);
  eq(new Set(seqs).size, seqs.length, `6.9 序号不得重复(实际 ${seqs.join(',')})`);
  eq(seqs.join(','), '1,2', '6.10 序号按条目独立单调 1,2(两条连接同时来也不会撞号/丢号)');
  eq(parentRes?.adopted, true, '6.11 两笔哈希都等于当前 active 内容 ⇒ 都满足采纳条件');
  eq(childOut?.adopted, true, '6.12 子进程那笔也满足采纳条件');
  eq(s.get(item.id).item.checked_state, 'ok', '6.13 条目认证状态与最后采纳者一致(后写者胜,不存在假回执)');
  eq(checks.checks[0].adopted && checks.checks[1].adopted, true, '6.14 两笔在库里都标 adopted(同一内容、先后两次认证)');
  console.log(`  · 父进程写 ${parentMs.toFixed(2)} ms,子进程写 ${Number(childOut?.write_ms ?? 0).toFixed(2)} ms`
    + '(两个进程从同一释放信号开始写;耗时差不作为锁竞争或同时入锁的证明)');
  s.close();
}

} finally {
  // Real finally covers every scenario, including thrown assertions or I/O.
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  const cleaned = cleanup();
  clearTimeout(watchdog);
  process.removeListener('exit', cleanup);
  if (!cleaned) failed += 1;
  console.log(cleaned ? '✓ 自建临时目录已清理' : '✗ 自建临时目录未清理');
}
console.log(`\n断言 ${assertions} 条,失败 ${failed} 条`);
console.log(failed === 0 ? '✓ library-store-concurrency 全部通过' : `✗ library-store-concurrency 有 ${failed} 条失败`);
process.exitCode = failed === 0 ? 0 : 1;
