// 1.8.0 · T(时间感知)单元测试 —— T①~T⑥ 的**行为**判据(不是形状判据)。
//
// 覆盖(PLAN §7 验收 1-6、10、11;HANDOFF §6 #1/#2/#3/#4/#6/#7):
//   1. `[现在]` 含 `HH:MM` 且与固定 now 一致                     (验收 1)
//   2. 新会话首轮 `[本场]` = 「不足 1 天」,不写 0 天              (验收 2 / HANDOFF §4②)
//   3. 20 天前 started_at ⇒ 「已持续 20 天」                      (验收 3)
//   4. `[跨天]` 只在跨天出现,同日不出现                          (验收 4)
//   5. `timeAnchorDate` 不含 `HH:MM`,且 `[今天]` 行尾有全角括注   (T④ / PLAN §9 最后一条)
//   6. 同一分钟两次组装逐字节相同                                  (验收 6)
//   7. 子代理只有 `[现在]`、无 `[本场]`/`[跨天]`                  (验收 10)
//   8. 空 assembly / 取不到 sessionId ⇒ 降级不抛,只出 `[现在]`    (验收 11)
//   9. 迁移二次启动不报错                                          (T⑥)
//  10. 回填只填空值;导入会话(source<>'dsh')保持 NULL              (T⑥)
//  11. m1-review 补强:跨年补年份(MF-1)、注入出口行数/无空行(MF-3)、
//      二次启动零 warn + 列集合不变(MF-2)、回填来源标记 started_at_src(MF-4)
//
// ⚠️ 本文件**不进** `package.json` 的 test 链(M1 保持 60 段):`node tests/time-t2.0.test.mjs`。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { timeAnchorDate, timeAnchorLive } = await imp('lib/host/clock.js');
const { registerMemorySection, CLOCK_CONTEXT_NAME } = await imp('lib/host/inject.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(Object.is(a, b), `${m}(实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)})`);

const dir = mkdtempSync(join(tmpdir(), 'ling-time-'));
const mem = new MemoryStore(join(dir, 'm.db'));
const settings = {}; // 不设 persona ⇒ 称呼走中性措辞,期望文本完全确定(用例只考时间)

// 固定 now:2026-10-21 23:28(深夜)—— 与 HANDOFF §3 的现场样本同一天
const NOW = new Date(2026, 9, 21, 23, 28);
const NOW_ISO = NOW.toISOString();

// ── 1) T① `[现在]` 加钟点 ────────────────────────────────────────────────────
{
  const t = timeAnchorLive(mem, settings, { now: NOW });
  check(t.includes('[现在] 深夜(23:28)'), 'T①:[现在] 含 HH:MM 且与固定 now 一致 ' + JSON.stringify(t));
  check(/\(\d{2}:\d{2}\)/.test(t), 'T①:钟点用 pad2 两位(23:28 而非 23:8)');
  eq(t.split('\n').length, 1, 'T①:没有 sessionId ⇒ 只有 [现在] 一行(不硬造 [本场])');
}

// ── 2) T② 新会话首轮 =「不足 1 天」 ─────────────────────────────────────────
mem.markSessionStarted('t-new', NOW);
{
  const t = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-new' });
  const lines = t.split('\n');
  eq(lines[0], '[现在] 深夜(23:28)', 'T②:[现在] 是第 1 段');
  eq(lines[1], '[本场] 不足 1 天(自 10-21 23:28 起)', 'T②:新会话首轮 [本场] = 不足 1 天');
  check(!t.includes('0 天'), 'T②:不出现「0 天」');
  eq(lines[2], undefined, 'T②③:同日不出现 [跨天]');
  eq(lines.length, 2, 'T②:段间是单个 \\n(不插空行)' + JSON.stringify(t));
}
// 幂等:后写不改首见时刻(resume/clear/compact 重入的等价形态)
mem.markSessionStarted('t-new', new Date(2026, 9, 25, 1, 0));
eq(mem.sessionStartedAt('t-new'), NOW_ISO, 'T②:markSessionStarted 首见为准,后写一个字节都不改');

// ── 3) T② 20 天 + T③ 跨天界线 ──────────────────────────────────────────────
const OLD_START = new Date(2026, 9, 1, 16, 12); // 10-01 16:12,now = 10-21 23:28 ⇒ 20 天 7 小时
mem.markSessionStarted('t-old', OLD_START);
{
  const t = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-old' });
  const expected = '[现在] 深夜(23:28)\n'
    + '[本场] 已持续 20 天(自 10-01 16:12 起)\n'
    + '[跨天] 本场对话已跨 20 个日历天。涉及"今天/昨天/刚才"时以 [今天] 为准,不要用"今天"指代整场。';
  eq(t, expected, 'T②③:整段逐字节等于契约文本(顺序 [现在]→[本场]→[跨天],单个 \\n)');
  check(t.includes('[本场] 已持续 20 天(自 10-01 16:12 起)'), 'T②:20 天前 started_at ⇒ 已持续 20 天');
  check(t.includes('[跨天] 本场对话已跨 20 个日历天。'), 'T③:跨天出现且天数按日历日算');
}

// 3b) T② 跨年补年份(PLAN §4② / HANDOFF §4②:跨年时补年份,如「自 2025-12-30」)
{
  const crossNow = new Date(2026, 0, 5, 10, 0); // 2026-01-05 10:00
  mem.markSessionStarted('t-xyear', new Date(2025, 11, 30, 8, 0)); // 2025-12-30 08:00 ⇒ 6 天 2 小时
  const t = timeAnchorLive(mem, settings, { now: crossNow, sessionId: 't-xyear' });
  check(t.includes('[本场] 已持续 6 天(自 2025-12-30 08:00 起)'),
    'T②:跨年补年份(自 YYYY-MM-DD HH:MM 起)且天数=6 ' + JSON.stringify(t));
  // "没有裸 MM-DD":2025-12-30 里的 12-30 前面必须是年份连字符,否则就是没补年份的旧形态
  check(!/(^|[^-0-9])12-30/.test(t), 'T②:跨年时不再出现裸 MM-DD(12-30) ' + JSON.stringify(t));
  // 对照:同年仍然不补年份(不把 YYYY- 当常态塞进每一条文本)
  const same = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-old' });
  check(/\(自 10-01 16:12 起\)/.test(same) && !/\(自 2026-10-01 16:12 起\)/.test(same),
    '对照:同年不补年份 ' + JSON.stringify(same));
}

// 4) 跨天/同日对照:昨天 09:00 起 ⇒ 跨 1 个日历天;同日 00:05 起 ⇒ 不出现
mem.markSessionStarted('t-yday', new Date(2026, 9, 20, 9, 0));
mem.markSessionStarted('t-same', new Date(2026, 9, 21, 0, 5));
{
  const y = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-yday' });
  check(y.includes('[跨天] 本场对话已跨 1 个日历天。'), 'T③:跨 1 个日历天(昨天起)出现 [跨天] ' + JSON.stringify(y));
  check(y.includes('[本场] 已持续 1 天(自 10-20 09:00 起)'), 'T②:跨天且满 1 天 ⇒ 写天数 ' + JSON.stringify(y));
  const s = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-same' });
  check(!s.includes('[跨天]'), 'T③:同日(00:05 起)不出现 [跨天] ' + JSON.stringify(s));
  check(s.includes('[本场] 不足 1 天'), 'T②:同日且不足一天 ⇒ 不足 1 天 ' + JSON.stringify(s));
}

// 5) T④ system 锚:不含 HH:MM,`[今天]` 行尾有全角括注,且同日逐字节稳定
{
  const d = timeAnchorDate(mem, settings, { now: NOW });
  check(!/\d{1,2}:\d{2}/.test(d), 'T④:timeAnchorDate 不含 HH:MM(钟点不得进 system 前缀) ' + JSON.stringify(d));
  eq(d.split('\n')[0], '[今天] 2026-10-21 周三（任何日期判断以此为准）', 'T④:[今天] 行尾全角括注逐字节');
  eq(d, timeAnchorDate(mem, settings, { now: new Date(2026, 9, 21, 8, 5) }), '验收 5:同日不同时刻 system 侧逐字节相同');
}

// 6) 同一分钟内多次组装逐字节相同(尾部快照成本判据)
{
  const a = timeAnchorLive(mem, settings, { now: new Date(2026, 9, 21, 23, 28, 1), sessionId: 't-old' });
  const b = timeAnchorLive(mem, settings, { now: new Date(2026, 9, 21, 23, 28, 59), sessionId: 't-old' });
  eq(a, b, '验收 6:同一分钟两次组装逐字节相同');
  const c = timeAnchorLive(mem, settings, { now: new Date(2026, 9, 21, 23, 29, 1), sessionId: 't-old' });
  check(a !== c, '对照:跨分钟必须变(否则 [现在] 其实没接上钟点)');
}

// 7) T⑤ 子代理闸 —— 在 registerMemorySection 真正注册出来的 context 回调上验
{
  const calls = { context: [] };
  let clockSpec = null;
  const sp = {
    section: () => () => {},
    context: (o) => { calls.context.push(o.name); clockSpec = o; return () => {}; },
  };
  const ctx = { get: (n) => (n === 'systemPrompt' ? sp : undefined) };
  const gate = { snapshotOf: () => null, isRunning: () => false, markSnap: () => {} };
  registerMemorySection(ctx, gate, mem, settings);
  eq(calls.context.length, 1, '注册点:context 只注册 1 次');
  eq(clockSpec && clockSpec.name, CLOCK_CONTEXT_NAME, '注册点:context 名 ' + CLOCK_CONTEXT_NAME);

  const clockText = clockSpec.text;
  // 用**真实 now** 的种子:这条断言不该依赖跑测机器的日期(20 天前 ⇒ 必有 [本场] 且必跨天)
  mem.markSessionStarted('t-live', new Date(Date.now() - 20 * 864e5));

  const sub = clockText({ agent: { session: { id: 't-live', header: { origin: 'subagent' } } } });
  check(sub.includes('[现在]'), '验收 10:子代理保留 [现在] ' + JSON.stringify(sub));
  check(!sub.includes('[本场]') && !sub.includes('[跨天]'),
    '验收 10:子代理没有 [本场]/[跨天](即便它也有 20 天前的 started_at) ' + JSON.stringify(sub));
  eq(sub.split('\n').length, 1, '验收 10:子代理只有一段(不夹带空行)');

  const top = clockText({ agent: { session: { id: 't-live', header: {} } } });
  check(top.includes('[现在]') && top.includes('[本场]') && top.includes('[跨天]'),
    '对照:顶层会话三段齐全 ' + JSON.stringify(top));
  check(top.indexOf('[现在]') < top.indexOf('[本场]') && top.indexOf('[本场]') < top.indexOf('[跨天]'),
    'C8 顺序:[现在] → [本场] → [跨天]');
  // 验收 12 的判据是**注入到上下文里的那段文本**,不是 `timeAnchorLive` 的返回值:
  // 注入出口还有一次 `neutralizeMustache` + `wellFormed`(LOCMAP-T §3-6 警告它会改换行/裁剪语义),
  // 故必须钉在 `clockSpec.text(assembly)` 这层,否则"join('\n') 正确"不等于"注入文本正确"。
  eq(top.split('\n').length, 3, '验收 12:注入出口(过 wellFormed)后仍是 3 行 ' + JSON.stringify(top));
  check(!top.includes('\n\n'), '验收 12:注入出口不出现空行 ' + JSON.stringify(top));

  // 8) 降级:空 assembly / 取不到 sessionId / 未知种类 ⇒ 只出 [现在],不抛
  const cases = [
    ['空 assembly(undefined)', undefined],
    ['空对象', {}],
    ['agent 无 session', { agent: {} }],
    ['取不到 header(未知种类)', { agent: { session: { id: 't-live' } } }],
  ];
  for (const [label, asm] of cases) {
    let threw = null;
    let text = '';
    try { text = clockText(asm); } catch (e) { threw = e; }
    check(threw === null, `验收 11:${label} 不抛(实际 ${threw})`);
    check(typeof text === 'string' && text.includes('[现在]') && !text.includes('[本场]') && !text.includes('[跨天]'),
      `验收 11:${label} ⇒ 只出 [现在](${JSON.stringify(text)})`);
  }
}

// 9/10) 迁移 + 存量回填(独立库,避免污染上面的用例)
{
  const dir2 = mkdtempSync(join(tmpdir(), 'ling-time-mig-'));
  const dbPath = join(dir2, 'm.db');
  const DSH_TS = '2026-01-05T00:00:00.000Z';
  const KEEP_AT = '2020-01-02T03:04:05.000Z';
  let m1 = new MemoryStore(dbPath);
  // 只回填有 dsh 原始轮的会话:两轮 ts 取 MIN
  m1.appendRawTurn('t-backfill', { seq: 1, role: 'user', ts: DSH_TS, model: null, text: '第一轮', source: 'dsh' });
  m1.appendRawTurn('t-backfill', { seq: 2, role: 'assistant', ts: '2026-01-06T00:00:00.000Z', model: 'm', text: '第二轮', source: 'dsh' });
  // 导入会话:只有 source<>'dsh' 的轮 ⇒ 必须保持 NULL
  m1.appendRawTurn('t-import', { seq: 1, role: 'user', ts: '2019-05-05T00:00:00.000Z', model: null, text: '导入轮', source: 'import' });
  // 非空 started_at:回填后一个字节都不改(哪怕 dsh 轮更早/更晚)
  m1.markSessionStarted('t-keep', KEEP_AT);
  m1.appendRawTurn('t-keep', { seq: 1, role: 'user', ts: DSH_TS, model: null, text: 'x', source: 'dsh' });
  eq(m1.sessionStartedAt('t-backfill'), null, 'T⑥ 前置:t-backfill 的 started_at 仍是 NULL');
  m1.close();

  let openThrew = null;
  let m2 = null;
  try { m2 = new MemoryStore(dbPath); } catch (e) { openThrew = e; }
  check(openThrew === null, 'T⑥:构造时迁移(含回填)跑通、不抛 ' + openThrew);
  if (m2) {
    eq(m2.sessionStartedAt('t-backfill'), DSH_TS, 'T⑥:回填取 MIN(ts) 且只取 source=\'dsh\' 的轮');
    eq(m2.sessionStartedAt('t-import'), null, 'T⑥:导入会话(只有 source=import)保持 NULL ⇒ 读侧只出 [现在]');
    eq(m2.sessionStartedAt('t-keep'), KEEP_AT, 'T⑥:非空 started_at 一个字节都不改');
    check(m2.db.prepare('PRAGMA table_info(session_meta)').all().some((c) => String(c.name) === 'started_at'),
      'T⑥:session_meta 有 started_at 列');
    // MF-4:回填的来源必须可在数据层区分(猜的 vs 看出来的)
    const srcOf = (m, sid) => m.db.prepare('SELECT started_at_src AS s FROM session_meta WHERE session_id=?').get(sid)?.s ?? null;
    eq(srcOf(m2, 't-backfill'), 'backfill', 'MF-4:回填行记 started_at_src=backfill(猜的)');
    eq(srcOf(m2, 't-keep'), 'seen', 'MF-4:markSessionStarted 写的行记 started_at_src=seen(看出来的)');
    eq(srcOf(m2, 't-import'), null, 'MF-4:导入会话既没时间也没来源标记');

    // 二次启动:不报错、不偷偷 ALTER(MF-2:ALIGN 变异③「不探列直接 ALTER」必须在这里变红)
    const colsBefore = m2.db.prepare('PRAGMA table_info(session_meta)').all().map((c) => String(c.name));
    m2.close();
    let secondThrew = null;
    let m3 = null;
    // 迁移的 catch 会把 duplicate column name 吞成一条 warn ⇒ 只断言"不抛"区分不了
    // 「探列命中、跳过 ALTER」与「无条件 ALTER、撞 duplicate column」;故把 warn 也收进来。
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.map((x) => String(x)).join(' '));
    try { m3 = new MemoryStore(dbPath); } catch (e) { secondThrew = e; } finally { console.warn = origWarn; }
    check(secondThrew === null, 'T⑥:二次启动不报错(迁移幂等) ' + secondThrew);
    eq(warns.filter((s) => s.includes('started_at')).length, 0,
      'T⑥:二次启动零 warn(started_at 迁移不该再告警;不探列直 ALTER 会在此变红) ' + JSON.stringify(warns));
    if (m3) {
      const colsAfter = m3.db.prepare('PRAGMA table_info(session_meta)').all().map((c) => String(c.name));
      eq(colsAfter.join(','), colsBefore.join(','),
        'T⑥:二次启动前后 session_meta 列集合不变(没有偷偷重复 ALTER)');
      eq(m3.sessionStartedAt('t-keep'), KEEP_AT, 'T⑥:二次启动后非空值仍逐字节不变');
      eq(m3.sessionStartedAt('t-backfill'), DSH_TS, 'T⑥:二次启动不回改写回填值');
      eq(m3.sessionStartedAt('t-import'), null, 'T⑥:二次启动仍不给导入会话编时间');
      m3.close();
    }
  }
}

// 10b) 极端输入:started_at 在 now 之后(时钟回拨/夹具写错)⇒ 不足 1 天且不跨天,不抛
{
  mem.markSessionStarted('t-future', new Date(2026, 9, 22, 0, 0));
  const t = timeAnchorLive(mem, settings, { now: NOW, sessionId: 't-future' });
  check(t.includes('[本场] 不足 1 天') && !t.includes('[跨天]'),
    '鲁棒:started_at 在 now 之后 ⇒ 不足 1 天、不跨天 ' + JSON.stringify(t));
}

mem.close();
console.log(ok ? '时间感知 T①~T⑥ 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
