// recall(1.6 · P2 直通原文):帧扫描 + 三档下钻 + 真人/注入判据
// 为什么单独立一套:这条通道此前**不存在**(7 个工具一个都读不到原文),而它要绕开三个已实测的坑 ——
// ① 单次 zstdDecompressSync 只解第一帧;② 流式解压报 Unknown frame descriptor;
// ③ 暴力试解帧边界是 O(n²)(498 帧 119 秒)。帧扫描的正确性因此必须被钉住。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { scanZstdFrames, dialogTurns, oneLine, localStamp, listSessionFiles, readSessionEvents } = await imp('lib/host/rawlog.js');
const { checkRecall, RECALL_SPEC } = await imp('lib/host/tools.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 帧边界:两帧拼一起必须认出两帧(整文件一次性解压只出第一帧 —— 那正是要绕开的坑)
{
  const f1 = zstdCompressSync(Buffer.from('{"type":"session","id":"x"}\n'));
  const f2 = zstdCompressSync(Buffer.from('{"type":"user/message","seq":1}\n{"type":"assistant/message","seq":2}\n'));
  const buf = Buffer.concat([f1, f2]);
  const s = scanZstdFrames(buf);
  check(s.frames.length === 2, '两帧拼接应扫出 2 帧,实得 ' + s.frames.length);
  check(s.frames[0].start === 0, '首帧起点应为 0');
  check(s.frames[1].end === buf.length, '末帧终点应等于文件长度');
  check(s.tornStart === undefined, '完整文件不该有 tornStart');
  const torn = scanZstdFrames(buf.subarray(0, buf.length - 3));
  check(torn.frames.length === 1 && torn.tornStart !== undefined, '末帧被截断 ⇒ 完整帧照列 + 报 tornStart');
  check(scanZstdFrames(buf, 1).frames.length === 1, 'maxFrames=1 应只扫一帧');
}

// 2) 对话轮判据:真人 / 注入 / 工具轮
{
  const ev = [
    { type: 'user/message', seq: 9, time: 1, data: { content: [{ type: 'text', text: '真人说的' }], source: { kind: 'user', rpcId: 'r1' } } },
    { type: 'user/message', seq: 10, time: 2, data: { content: [{ type: 'text', text: '注入的' }], source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', seq: 11, time: 3, data: { message: { content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '答' }] } } },
    { type: 'assistant/message', seq: 12, time: 4, data: { message: { content: [{ type: 'tool-call', name: 'read' }, { type: 'tool-call', name: 'grep' }] } } },
    { type: 'tool/call', seq: 13, time: 5, data: { name: 'read' } },
    { type: 'tool/result', seq: 14, time: 6, data: {} },
  ];
  const r = dialogTurns(ev);
  check(r.turns.length === 4, 'tool/call 与 tool/result 不该进对话轮,实得 ' + r.turns.length);
  check(r.turns[0].human === true, '真人的判据 = source.kind==="user" 且有 rpcId');
  check(r.turns[1].human === false, '注入的 user 消息必须标 human:false');
  check(r.turns[2].text === '答', 'assistant 只取 text 块');
  check(!String(r.turns[2].text).includes('想'), 'assistant 不取 reasoning(思维链不进回执)');
  check(r.turns[3].text === '' && r.turns[3].tools.join(',') === 'read,grep', '无正文的轮次要带出工具名');
  check(r.turns[0].n === 1 && r.turns[3].n === 4, '序号 1-based 连续');
  check(r.injected === 1 && r.assistantEmpty === 1, '注入计数与无正文计数');
  const noRpc = dialogTurns([{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } }]);
  check(noRpc.turns[0].human === false, 'kind=user 但缺 rpcId ⇒ 不算真人(防误判)');
}

// 3) 三档参数校验(纯函数)
{
  check(checkRecall({}).action === 'map', '不给 conv ⇒ map');
  check(checkRecall({ conv: 'x' }).action === 'outline', '给 conv ⇒ outline');
  check(checkRecall({ conv: 'x', from: 3, to: 5 }).action === 'read', '给 conv + 范围 ⇒ read');
  check(checkRecall({ from: 1 }).ok === false, '给了范围却不给 conv ⇒ 拒绝(否则不知道读哪个会话)');
  const r = checkRecall({ conv: 'x', from: 5 });
  check(r.from === 5 && r.to === 14, '缺省 to = from+9,实得 ' + r.to);
  const r2 = checkRecall({ conv: 'x', from: -3, to: 1 });
  check(r2.from === 1 && r2.to === 1, 'from 下限夹到 1');
  const r3 = checkRecall({ conv: 'x', from: 1, to: 100000 });
  check(r3.to === 200, '单次最多 200 轮,实得 ' + r3.to);
  check(checkRecall({}).limit === 40, 'map 缺省 40 条');
  check(checkRecall({ limit: 9999 }).limit === 200, 'map 上限 200 条');
}

// 4) 展示小工具
{
  check(oneLine('a  b\n c', 10) === 'a b c', '单行化应折叠空白');
  check(oneLine('abcdefghij', 4) === 'abcd…', '超长应截断并加省略号');
  check(oneLine('', 4) === '', '空串仍是空串');
  check(localStamp(0) === '' && localStamp('x') === '', '非法时间戳返回空串,不抛');
}

// 5) 回执渲染:错误分支不许抛(回执是模型唯一看得到的东西)
{
  const cases = [
    { ok: false, reason: 'no-session', conv: 'x' },
    { ok: false, reason: 'out-of-range', total: 5 },
    { ok: false, reason: 'conv-required' },
    { ok: false, reason: 'corrupt', message: '坏了' },
    { ok: false, reason: '从没见过的原因' },
  ];
  for (const c of cases) {
    let t = '';
    try { t = RECALL_SPEC.output.render(null, c)[0].text; } catch (e) { t = ''; }
    check(typeof t === 'string' && t.length > 0, '错误分支渲染应有文本:' + c.reason);
  }
}

// 6) 真机(本机有会话目录才跑;没有就跳过 —— 别的机器上这套测试也应当能过)
{
  const map = listSessionFiles({ limit: 3 });
  if (map.ok && map.total > 0) {
    check(map.sessions.length <= 3, 'map 应尊重 limit');
    check(map.sessions.every((s) => s.conv && typeof s.bytes === 'number'), 'map 每项应有 conv/bytes');
    const s = map.sessions[0];
    const r = readSessionEvents(s.conv);
    check(r.ok === true, '真机会话应能读出:' + r.reason);
    check(r.frames > 0 && r.events.length > 0, '应解出事件');
    const d = dialogTurns(r.events);
    check(d.turns.length > 0, '真机会话应有对话轮');
    check(d.turns.some((t) => t.role === 'user'), '真机会话应有 user 轮');
    // 1.6 ·(2026-10-04)三代日志文件名都要认:`session.v4` / `session.v3` / 无版本 `session`。
    //   此前 `SESSION_LOG_NAME` 写死 v4 ⇒ 磁盘上 130 个旧会话(117 个 v3 + 53 个无版本,有重叠)
    //   **读不到**,而三代事件同构、`dialogTurns` 零适配可用。这条断言锁住"判据是文件在不在"。
    const all = listSessionFiles({ limit: 100000 });
    const legacy = all.sessions.find((x) => x.log && x.log !== 'session.v4.jsonl.zstd');
    check(typeof all.total === 'number' && all.total >= all.sessions.length, 'map 应报出会话总数');
    if (legacy) {
      const r3 = readSessionEvents(legacy.conv);
      check(r3.ok === true, `旧版日志(${legacy.log})应能读出:${r3.reason || ''}`);
      check(Array.isArray(r3.events) && r3.events.length > 0, `旧版日志(${legacy.log})应解出事件`);
      const d3 = dialogTurns(r3.events);
      check(d3.turns.length > 0, `旧版日志(${legacy.log})应有对话轮`);
    }
    // 裸 uuid 与带前缀两种写法都要能定位到同一个文件
    const bare = s.conv.replace(/^session-/, '');
    if (bare !== s.conv) {
      const r2 = readSessionEvents(bare);
      check(r2.ok === true && r2.id === s.conv, '裸 uuid 应定位到同一个会话');
    }
    // 渲染整条链路(档 2 的回执)
    const outline = d.turns.map((t) => ({
      n: t.n, seq: t.seq, time: localStamp(t.time), role: t.role, human: t.human,
      head: oneLine(t.text, 70), tools: t.tools || [],
    }));
    const txt = RECALL_SPEC.output.render(null, {
      ok: true, action: 'outline', conv: s.conv, project: s.project, frames: r.frames, bytes: r.bytes,
      totalTurns: d.turns.length, injected: d.injected, assistantEmpty: d.assistantEmpty,
      outline, callName: '尝生',
    })[0].text;
    check(txt.includes(s.conv), '目录回执应含会话 id');
    // ⚠️ 判据**不能写死 `#1`**(2026-10-04 修):`listSessionFiles()[0]` 是**此刻最新**的会话,
    //   而它完全可能是一条**子代理会话** —— 那种会话的第 1 轮是调用方注入的 prompt
    //   (`source.kind==='user'` 但没有 rpcId ⇒ `human:false`),渲染时被折叠,
    //   于是回执里根本不出现 `#1`(序号跳号**正是**折叠的显示,回执里也这么解释)。
    //   判据要落在"**首条非注入轮**"上,否则这套测试会随"此刻谁在跑"时红时绿。
    const firstVisible = d.turns.find((t) => !(t.role === 'user' && !t.human));
    check(Boolean(firstVisible) && txt.includes('#' + firstVisible.n + ' '), '目录回执应有首条非注入轮的行');
    check(RECALL_SPEC.output.render(null, {
      ok: true, action: 'read', conv: s.conv, project: s.project, frames: r.frames, bytes: r.bytes,
      totalTurns: d.turns.length, injected: 0, assistantEmpty: 0, remaining: 3, nextFrom: 9,
      turns: [{ n: 1, time: '01-01 00:00', role: 'user', human: true, text: '甲' }], callName: '尝生',
    })[0].text.includes('还有 3 轮没给'), '正文档溢出必须明说还剩几轮');
  } else {
    console.log('· 跳过真机断言(本机没有可读的会话目录)');
  }
}

console.log(ok ? '✓ recall 全部通过' : '✗ recall 有失败');
process.exit(ok ? 0 : 1);
