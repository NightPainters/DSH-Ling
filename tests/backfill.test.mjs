// N1/BUG-2 回归:会话文件名代次匹配(session[.vN].jsonl.zstd)+ 零候选归因。
// 用法:node --test tests/backfill.test.mjs(或 node tests/backfill.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { SESSION_FILE_RE, pickSessionFile, candidateSessionFiles, scanDshHistory, defaultSessionsRoot } = await imp('lib/host/backfill.js');

const tmp = mkdtempSync(join(tmpdir(), 'ling-backfill-'));
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
let seq = 0;
const newDir = () => { const d = join(tmp, 'd' + (++seq)); mkdirSync(d, { recursive: true }); return d; };
const put = (dir, name, body = 'x') => { writeFileSync(join(dir, name), body); return join(dir, name); };

test('正则认下三代文件名,且不误伤其它名字', () => {
  assert.ok(SESSION_FILE_RE.test('session.jsonl.zstd'));
  assert.ok(SESSION_FILE_RE.test('session.v3.jsonl.zstd'));
  assert.ok(SESSION_FILE_RE.test('session.v4.jsonl.zstd'));
  assert.ok(SESSION_FILE_RE.test('session.v10.jsonl.zstd'));
  for (const bad of ['session.jsonl', 'session.jsonl.zst', 'session.v3.jsonl', 'other.jsonl.zstd', 'session.v3.jsonl.zstd.bak']) {
    assert.equal(SESSION_FILE_RE.test(bad), false, bad + ' 不该被认');
  }
});

test('三代并存:只取版本号最高的那一代', () => {
  const d = newDir();
  put(d, 'session.jsonl.zstd');
  put(d, 'session.v3.jsonl.zstd');
  put(d, 'session.v4.jsonl.zstd');
  const hit = pickSessionFile(d);
  assert.equal(hit.name, 'session.v4.jsonl.zstd');
  assert.equal(hit.ver, 4);
  assert.equal(hit.f, join(d, 'session.v4.jsonl.zstd'));
});

test('最高代次是 0 字节 → 跳过它,退到有内容的低代次', () => {
  const d = newDir();
  put(d, 'session.v3.jsonl.zstd', 'has-content');
  put(d, 'session.v4.jsonl.zstd', ''); // 写盘未完成的空壳
  const hit = pickSessionFile(d);
  assert.equal(hit.name, 'session.v3.jsonl.zstd');
  assert.equal(hit.ver, 3);
});

test('版本号按数值比大小(v10 > v9),不按字典序', () => {
  const d = newDir();
  put(d, 'session.v9.jsonl.zstd');
  put(d, 'session.v10.jsonl.zstd');
  assert.equal(pickSessionFile(d).name, 'session.v10.jsonl.zstd');
});

test('只有无版本号那个文件时,兜底取到它(无版本 = 最低)', () => {
  const d = newDir();
  put(d, 'session.jsonl.zstd');
  const hit = pickSessionFile(d);
  assert.equal(hit.name, 'session.jsonl.zstd');
  assert.equal(hit.ver, 0);
});

test('无版本号与 v3 并存:取 v3(旧写死逻辑漏的那一代)', () => {
  const d = newDir();
  put(d, 'session.jsonl.zstd');
  put(d, 'session.v3.jsonl.zstd');
  assert.equal(pickSessionFile(d).ver, 3);
});

test('目录不存在 / 空目录 / 无匹配文件 / 全是 0 字节 → null', () => {
  assert.equal(pickSessionFile(join(tmp, 'does-not-exist')), null, '目录不存在');
  assert.equal(pickSessionFile(newDir()), null, '空目录');
  const d1 = newDir();
  put(d1, 'notes.jsonl.zstd');
  put(d1, 'session.jsonl');
  assert.equal(pickSessionFile(d1), null, '只有无关文件');
  const d2 = newDir();
  put(d2, 'session.v4.jsonl.zstd', '');
  assert.equal(pickSessionFile(d2), null, '全是 0 字节');
});

test('candidateSessionFiles:一个会话目录只出一个候选(按最高代次去重)', () => {
  const r = join(tmp, 'root-multi');
  mkdirSync(join(r, 'ws-a', 'sid-full'), { recursive: true });
  mkdirSync(join(r, 'ws-a', 'sid-old'), { recursive: true });
  mkdirSync(join(r, 'ws-b', 'sid-empty'), { recursive: true });
  mkdirSync(join(r, 'ws-b', 'not-a-session'), { recursive: true });
  put(join(r, 'ws-a', 'sid-full'), 'session.jsonl.zstd');
  put(join(r, 'ws-a', 'sid-full'), 'session.v3.jsonl.zstd');
  put(join(r, 'ws-a', 'sid-full'), 'session.v4.jsonl.zstd');
  put(join(r, 'ws-a', 'sid-old'), 'session.jsonl.zstd');
  put(join(r, 'ws-b', 'sid-empty'), 'session.v4.jsonl.zstd', '');
  writeFileSync(join(r, 'ws-a', 'loose.jsonl.zstd'), 'x'); // 工作区根上的散文件不算会话
  const jobs = candidateSessionFiles(r);
  assert.equal(jobs.length, 2, '只该有 2 个候选(同目录不分叉、0 字节不算、散文件不算)');
  const bySid = Object.fromEntries(jobs.map((j) => [j.sid, j]));
  assert.equal(bySid['sid-full'].file, 'session.v4.jsonl.zstd');
  assert.equal(bySid['sid-full'].ver, 4);
  assert.equal(bySid['sid-old'].file, 'session.jsonl.zstd');
  assert.equal(bySid['sid-old'].ws, 'ws-a');
});

test('BUG-2:0 候选且目录存在 → 给出「未找到会话文件」原因,不与「没历史」混淆', async () => {
  const r = join(tmp, 'root-empty');
  mkdirSync(join(r, 'ws-a', 'sid-1'), { recursive: true });
  put(join(r, 'ws-a', 'sid-1'), 'session.v5.jsonl.zst'); // 未来代次/换扩展名:一个都不匹配
  const { report } = await scanDshHistory({ root: r });
  assert.equal(report.scanned, 0);
  assert.equal(report.rootExists, true);
  assert.equal(report.sessionDirs, 1);
  assert.equal(report.reason, 'no-session-files');
  assert.match(report.note, /未找到会话文件/);
  assert.match(report.note, /版本变化/);
  assert.match(report.note, /session\.v5\.jsonl\.zst/, '原因里要带上实际见到的文件名');
});

test('BUG-2:会话根目录不存在 → 另一种原因(没跑过 DSH / DSH_HOME 指错)', async () => {
  const { report } = await scanDshHistory({ root: join(tmp, 'no-such-root') });
  assert.equal(report.scanned, 0);
  assert.equal(report.rootExists, false);
  assert.equal(report.reason, 'no-sessions-root');
  assert.match(report.note, /未找到 DSH 会话目录/);
});

test('有候选时不带归因字段(note/reason 只在 0 候选出现)', async () => {
  const r = join(tmp, 'root-ok');
  mkdirSync(join(r, 'ws-a', 'sid-ok'), { recursive: true });
  put(join(r, 'ws-a', 'sid-ok'), 'session.v4.jsonl.zstd', 'not-really-zstd-but-counted');
  const { report } = await scanDshHistory({ root: r });
  assert.equal(report.scanned, 1);
  assert.equal(report.reason, undefined);
  assert.equal(report.note, undefined);
});

// ── BUG-2 的**真实调用路径**:调用方**一个 root 都不传**(api.js 的 /dsh/backfill 就是
//    这么调的:`scanDshHistory({ memory, limit })`)。上面所有用例都显式传了 root,
//    所以即使入口不解析 root 也照样全绿 —— 这个缺陷此前正是这样漏过闸门的。
//
// 隔离手法:os.homedir() 在 Windows 读 USERPROFILE、POSIX 读 HOME,且**每次调用现读**
// ⇒ 把这两个变量临时指到 mkdtemp 出来的假 home,就能在**完全不碰主人真实 ~/.dsh** 的
// 前提下走完「不传 root」的整条路径。修之前:两条用例都会得到 rootExists=false /
// reason='no-sessions-root' / note 里带 "undefined"。
const fakeHomeA = join(tmp, 'home-A'); // 故意不建:根目录不存在
const fakeHomeB = join(tmp, 'home-B'); // 建了根目录,但没有一个文件名符合代次
mkdirSync(join(fakeHomeB, '.dsh', 'sessions', 'ws-a', 'sid-1'), { recursive: true });
put(join(fakeHomeB, '.dsh', 'sessions', 'ws-a', 'sid-1'), 'session.v5.jsonl.zst', 'x');
const realProfile = process.env.USERPROFILE;
const realHomeEnv = process.env.HOME;
/** 在假 home 里跑一段:期间 homedir() 指向它,结束必还原(失败也不污染后续用例)。 */
async function inFakeHome(home, fn) {
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try { return await fn(); } finally {
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    if (realHomeEnv === undefined) delete process.env.HOME; else process.env.HOME = realHomeEnv;
  }
}
// 前提自检:homedir() 必须真的被环境变量带走,否则这套隔离不成立(此时跳过而不是假装通过)
const homeHonored = await inFakeHome(fakeHomeA, () => homedir() === fakeHomeA);
const skipIfNotHonored = homeHonored ? false : 'os.homedir() 不读 USERPROFILE/HOME,无法在本平台隔离默认根目录';

test('BUG-2(不传 root):默认根目录本身要能被解析出来,不是一个 undefined', { skip: skipIfNotHonored }, async () => {
  await inFakeHome(fakeHomeA, async () => {
    assert.equal(defaultSessionsRoot(), join(fakeHomeA, '.dsh', 'sessions'), 'defaultSessionsRoot 要跟着 homedir() 走');
  });
});

test('BUG-2(不传 root):根目录不存在 → no-sessions-root,且 note 里是**真路径**不是 undefined', { skip: skipIfNotHonored }, async () => {
  const { report } = await inFakeHome(fakeHomeA, () => scanDshHistory({})); // ← 一个参数都不给
  assert.equal(report.scanned, 0);
  assert.equal(report.root, join(fakeHomeA, '.dsh', 'sessions'), 'report.root 必须是解析后的真实路径');
  assert.equal(report.rootExists, false);
  assert.equal(report.reason, 'no-sessions-root');
  assert.match(report.note, /未找到 DSH 会话目录/);
  assert.ok(!/undefined/.test(report.note), 'note 里不许出现 undefined(旧行为就是它):' + report.note);
  assert.ok(report.note.includes(join(fakeHomeA, '.dsh', 'sessions')), 'note 要写出真实的会话根目录:' + report.note);
});

test('BUG-2(不传 root):根目录存在但没有合格文件名 → no-session-files(**另一种**原因)', { skip: skipIfNotHonored }, async () => {
  const { report } = await inFakeHome(fakeHomeB, () => scanDshHistory({})); // ← 同样不传 root
  assert.equal(report.scanned, 0);
  assert.equal(report.root, join(fakeHomeB, '.dsh', 'sessions'));
  assert.equal(report.rootExists, true, '根目录这次是存在的');
  assert.equal(report.sessionDirs, 1);
  assert.equal(report.reason, 'no-session-files', '两种原因必须能分辨(旧行为恒为 no-sessions-root)');
  assert.match(report.note, /未找到会话文件/);
  assert.match(report.note, /session\.v5\.jsonl\.zst/, '原因里要带上实际见到的文件名');
  assert.ok(!/undefined/.test(report.note), 'note 里不许出现 undefined:' + report.note);
});
