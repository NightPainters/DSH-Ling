// captureSessionDiff 单元测试(空闲差分捕捉,真实事件形状:
// { type, seq, time, data: { content|message.content, source:{kind} } })
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const imp = (p) => import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', p)).href);
const { captureSessionDiff } = await imp('lib/host/lifecycle.js');

function fakeMemory() {
  const kv = {};
  const raw = [];
  return {
    kvGet: (k) => kv[k],
    kvSet: (k, v) => { kv[k] = String(v); },
    appendRawTurn: (sid, row) => raw.push({ sid, ...row }),
    _kv: kv, _raw: raw,
  };
}

const ev = (seq, type, data, time = 1788707000000 + seq) => ({ seq, type, time, data });
const userMsg = (seq, text, kind = 'user') => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind } });
const asstMsg = (seq, texts) => ev(seq, 'assistant/message', {
  message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考…' }, ...texts.map((t) => ({ type: 'text', text: t }))] },
});

let ok = true;
const check = (cond, msg) => { if (!cond) { ok = false; console.log('✗', msg); } };

// 1) 首轮差分:真实消息入库、plugin 注入跳过、思考块过滤、水位推进
{
  const m = fakeMemory();
  const sess = {
    id: 's1', header: {},
    snapshotEvents: () => [
      ev(1, 'turn/start', { turn: 1 }),
      userMsg(2, '你好'),
      userMsg(3, 'runtime context', 'plugin'),
      ev(4, 'step/start', { turn: 1, step: 1 }),
      asstMsg(5, ['好的', '继续']),
    ],
  };
  const added = captureSessionDiff(m, sess);
  check(added === 2, '首轮入库 2 条(plugin 跳过),实际 ' + added);
  check(m._raw.length === 2 && m._raw[0].text === '你好', 'user 文本正确');
  check(m._raw[1].text === '好的\n继续' && !m._raw[1].text.includes('思考'), 'assistant 只取 text 块');
  check(m._raw[1].ts && m._raw[1].ts.startsWith('2026-'), 'time→ISO 时间');
  check(m._kv['wm:s1'] === '5', '水位=5,实际 ' + m._kv['wm:s1']);
}

// 2) 再次差分无新事件:0 条,不重复
{
  const m = fakeMemory();
  const sess = { id: 's1', header: {}, snapshotEvents: () => [userMsg(1, 'a'), asstMsg(2, ['b'])] };
  captureSessionDiff(m, sess);
  check(captureSessionDiff(m, sess) === 0 && m._raw.length === 2, '重复差分不重复');
}

// 3) 增量只取新增
{
  const m = fakeMemory();
  let events = [userMsg(1, 'a'), asstMsg(2, ['b'])];
  const sess = { id: 's2', header: {}, snapshotEvents: () => events };
  check(captureSessionDiff(m, sess) === 2, '初始 2');
  events.push(userMsg(4, '新消息'), asstMsg(5, ['回复']));
  check(captureSessionDiff(m, sess) === 2, '增量 2');
  check(m._raw[2].text === '新消息', '增量文本正确');
}

// 4) 子代理跳过
{
  const m = fakeMemory();
  const sess = { id: 'child', header: { parentSession: 'p1' }, snapshotEvents: () => [userMsg(1, 'x')] };
  check(captureSessionDiff(m, sess) === 0, '子代理不入库');
}

// 5) 无 seq 安全跳过;null 会话返回 0
{
  const m = fakeMemory();
  const sess = { id: 's3', header: {}, snapshotEvents: () => [{ type: 'user/message', data: { content: 'x' } }] };
  check(captureSessionDiff(m, sess) === 0, '无 seq 跳过');
  check(captureSessionDiff(m, null) === 0, 'null 会话返回 0');
}

console.log(ok ? 'captureSessionDiff 全部通过 ✓' : '存在失败');
process.exitCode = ok ? 0 : 1;
