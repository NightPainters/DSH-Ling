// B:长会话空闲刷新单元测试(第 16 套)。
// 覆盖:running 期间绝不刷新(D4)、idle + 版本变化才重建、内容判等与最小间隔、
//       关键词上下文在重建中不丢(既有 bug)、开关、异常不冒泡、留痕计数。
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = join(import.meta.dirname, '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { FreezeGate } = await imp('lib/host/freeze.js');
const { DEFAULT_SETTINGS } = await imp('lib/host/persona.js');
const { freezeSnapshotForSession, invalidateSession, refreshIdleSnapshot, refreshStats } = await imp('lib/host/inject.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-idle-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const silent = (fn) => { const d = console.debug; console.debug = () => {}; try { return fn(); } finally { console.debug = d; } };

function mkSettings(patch = {}) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  return {
    get: () => ({
      ...base,
      ...patch,
      persona: { ...base.persona, aiName: '器灵', userTitle: '老板', ...(patch.persona || {}) },
      memory: { ...base.memory, ...(patch.memory || {}) },
    }),
  };
}

const fakeAgent = (sid, text) => ({
  session: {
    id: sid,
    header: {},
    snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: text } }],
  },
});

function seed(mem2, id, title, category = 'knowledge') {
  mem2.upsertOverview({
    conv_id: id, source: 'dsh', title, category, overview_ok: 1,
    summary: title + ' 的摘要', updated_at: new Date().toISOString(), origin: 'test',
  });
}

const SID = 'sess-idle';
seed(mem, 'old-1', '串联材料模拟怎么做');
mem.setSessionMode(SID, 'work');
const settings = mkSettings({ mode: { ...DEFAULT_SETTINGS.mode, lastMode: 'work' }, memory: { idleRefreshMinIntervalMin: 0 } });
const gate = new FreezeGate({});

// 1) 首建:快照存在,且关键词上下文被存下来(修 bug 的前提)
const created = freezeSnapshotForSession(gate, mem, settings, fakeAgent(SID, '材料模拟的边界条件怎么设'));
check(created && created.sessionId === SID, '首建快照成功');
const snap0 = gate.snapshotOf(SID);
check(!!snap0 && !!snap0.text, '快照文本非空');
check(Array.isArray(snap0.keywords) && snap0.keywords.length > 0, '关键词随快照存下:' + JSON.stringify(snap0.keywords));
const kw0 = JSON.stringify(snap0.keywords);
const text0 = snap0.text;
check(/材料模拟/.test(text0), 'L1 命中既有概述');

// 2) 运行中:即使记忆变了也绝不刷新(D4)
gate.setRunning(SID, true);
mem.kvSet('memory_version', 'v-running');
seed(mem, 'new-1', '主动意识层设计讨论');
const rRunning = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 1000, minIntervalMin: 0 }));
check(rRunning.refreshed === false && rRunning.reason === 'running', 'running 时拒绝刷新:' + JSON.stringify(rRunning));
check(gate.snapshotOf(SID).text === text0, 'running 期间快照文本逐字节不变(D4)');
gate.setRunning(SID, false); // running→idle 翻转

// 3) 空闲 + 版本变化 → 重建,且新概述进来
const r1 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 2000, minIntervalMin: 0 }));
check(r1.refreshed === true && r1.reason === 'rebuilt', '空闲边界重建成功:' + JSON.stringify(r1));
const text1 = gate.snapshotOf(SID).text;
check(/主动意识层设计讨论/.test(text1), '新概述进入 L1');
check(gate.snapshotOf(SID).keywords && JSON.stringify(gate.snapshotOf(SID).keywords) === kw0, '重建后关键词上下文保持');

// 4) 留痕:重建计数 +1
check(refreshStats(mem, SID).count === 1, '留痕计数 = 1:' + JSON.stringify(refreshStats(mem, SID)));

// 5) 版本未变 → unchanged(不重建)
const r2 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 3000, minIntervalMin: 0 }));
check(r2.refreshed === false && r2.reason === 'unchanged', '版本未变不重建:' + JSON.stringify(r2));

// 6) 版本变了但内容相同 → same-text(不计数、不替换)
mem.kvSet('memory_version', 'v-same');
const r3 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 4000, minIntervalMin: 0 }));
check(r3.refreshed === false && r3.reason === 'same-text', '内容判等生效:' + JSON.stringify(r3));
check(refreshStats(mem, SID).count === 1, 'same-text 不计数');

// 7) 最小间隔:10 分钟内的第二次变化被节流
seed(mem, 'new-2', '规则与习惯的拆分设计');
mem.kvSet('memory_version', 'v-throttle');
const r4 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 4000 + 60_000, minIntervalMin: 10 }));
check(r4.refreshed === false && r4.reason === 'throttled', '10 分钟内被节流:' + JSON.stringify(r4));
const r5 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 4000 + 11 * 60_000, minIntervalMin: 10 }));
check(r5.refreshed === true, '超过间隔后放行:' + JSON.stringify(r5));
check(/规则与习惯的拆分设计/.test(gate.snapshotOf(SID).text), '节流放行后新概述进入 L1');

// 8) 开关关闭 → disabled
const offSettings = mkSettings({ memory: { idleRefresh: false } });
mem.kvSet('memory_version', 'v-off');
const r6 = silent(() => refreshIdleSnapshot(gate, mem, offSettings, SID, { now: 10 ** 7, minIntervalMin: 0 }));
check(r6.refreshed === false && r6.reason === 'disabled', '开关关闭时不刷新:' + JSON.stringify(r6));

// 9) 无快照 → no-snapshot
const r7 = silent(() => refreshIdleSnapshot(gate, mem, settings, 'sess-unknown', { now: 10 ** 7, minIntervalMin: 0 }));
check(r7.refreshed === false && r7.reason === 'no-snapshot', '无快照会话不刷新:' + JSON.stringify(r7));

// 10) 可选项:刷新前先跑一次增量概述
mem.kvSet('memory_version', 'v-sum');
let summarized = 0;
const r8 = silent(() => refreshIdleSnapshot(gate, mem, settings, SID, { now: 10 ** 8, minIntervalMin: 0, summarize: () => { summarized += 1; } }));
check(summarized === 1, 'summarize 钩子被调用一次');
check(typeof r8.refreshed === 'boolean', 'summarize 存在时仍返回结果:' + JSON.stringify(r8));

// 11) 库异常不冒泡:保留旧快照,返回 error
const boomMemory = {
  kvGet: () => { throw new Error('db locked'); },
  kvSet: () => { throw new Error('db locked'); },
};
const before = gate.snapshotOf(SID).text;
const r9 = silent(() => refreshIdleSnapshot(gate, boomMemory, settings, SID, { now: 10 ** 8, minIntervalMin: 0 }));
check(r9.refreshed === false && r9.reason === 'error', '库异常被吞掉:' + JSON.stringify(r9));
check(gate.snapshotOf(SID).text === before, '异常后旧快照照常服务');

// 12) 既有失效路径也必须带关键词(此前 invalidateSession 传 {} 会丢上下文)
invalidateSession(gate, mem, settings, SID);
check(JSON.stringify(gate.snapshotOf(SID).keywords) === kw0, 'invalidateSession 后关键词仍在');

console.log(ok ? 'B 空闲刷新 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
