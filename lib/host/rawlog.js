// dsh-ling host — 直通原文(1.6 · P2 第一优先)。
//
// 为什么要有这个模块(2026-10-04 用户定「第一优先级就是先把读原文的这个事儿给办了」):
//   器灵此前**没有任何正规通道**能读会话原文 —— 7 个工具里一个都读不到,
//   而 memory.db 的 `dsh_turns_raw` 是**残的**(本会话实测:库里 13 条 vs 磁盘 473 条,≈2.7%)。
//   真全文只躺在磁盘上: ~/.dsh/sessions/<项目目录>/<会话目录>/session.v4.jsonl.zstd
//
// 磁盘格式(实测): **多 frame zstd 容器**,一帧一批事件,帧内是 JSONL。
//   ⚠️ 三个坑,每个都踩过:
//     ① `zstdDecompressSync(整文件)` 只解**第一帧**就返回(实测本会话只出 191 字节的会话头),
//        看起来"解压成功",极易被当成"文件就是这么小";
//     ② 流式 `createZstdDecompress()` 直接报 `Unknown frame descriptor`;
//     ③ 靠 magic 逐字节暴力试解边界是 **O(n²)** —— 实测 498 帧耗时 **119 秒**,不可用。
//   ⇒ 正解是**纯结构扫描**帧边界(不解压),再逐帧解压。本模块照 DSH 官方实现重写
//     (@deepseek-ai/dsh-session-persistence-jsonl 的 `scanZstdFrames`,见其 lib/index.js:1300-1363),
//     实测 **516 帧扫描 1ms + 全量解压解析 53ms**(相对暴力法快约 2200 倍)。
//     抄而不 import 的理由:不把插件绑到宿主内部包上(那是 P3 的劣,主人 2026-10-04 拍「先 P2」)。
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync, constants as zc } from 'node:zlib';
import { isMemoryEligibleHeader, dshHome } from './util.js';   // F3(2026-10-04):真人判据要按**会话级**分通道

/** Zstandard 帧魔数(小端读作 UInt32LE 时的值)。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 未完成末帧的兜底解压选项(与官方同款:`ZSTD_e_flush` 抑制末帧/校验和完成判定)。 */
const INCOMPLETE_FRAME_OPTIONS = { finishFlush: zc.ZSTD_e_flush };
/** 会话日志的候选文件名(**新→旧**)。DSH 换过三代: v4 / v3 / 无版本。
 *  ⚠️ 2026-10-04 实测:此处原先写死 v4 ⇒ 磁盘上 **117 个 `session.v3.jsonl.zstd` + 53 个
 *  `session.jsonl.zstd`** 全部读不到(仅**一个**会话目录下就有 82 个)。
 *  而三代**事件同构** —— 都以 `{"type":"session","version":N}` 开头、事件类型一致、
 *  `dialogTurns` 直接可用(v3 与无版本各实测两份,零格式适配)。
 *  ⇒ 判据只能是「**文件在不在**」,不是「叫什么名字」。 */
const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd'];

/** 在一个会话目录里按 新→旧 找到日志文件;找不到返回 null。
 *  @returns {{file:string,name:string,bytes:number,mtime:number}|null} */
function findLogIn(dir) {
  for (const name of SESSION_LOG_NAMES) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) return { file, name, bytes: st.size, mtime: Math.round(st.mtimeMs) };
    } catch { /* 试下一个名字 */ }
  }
  return null;
}

/** 会话根目录: `$DSH_HOME/sessions`(未设时 `~/.dsh/sessions`)。
 *  ⚠️ 2026-10-05 修正(A-4,交办单最后一处漏点):本函数原先是 `join(os.homedir(), '.dsh', 'sessions')`
 *  —— 绕过 `$DSH_HOME`,是全仓最后一处这么写的地方(`backfill.js:45-51` 记着另两处早在
 *  2026-09-29 就统一到 `dshHome()` 了)。不设 `DSH_HOME` 时两者等价,**缺陷因此长期隐身**;
 *  一旦设了(导入测试台就是靠它做隔离,`DESIGN-导入测试台.md:25` 明写"`DSH_HOME` 层面隔离才有效"),
 *  这里就会去读**真机**会话目录 —— 不报错、只读,但结论不可复现,还会把真历史灌进测试库。
 *  现统一到 `dshHome()`(= `$DSH_HOME` 优先,否则 `~/.dsh`),与扫描侧/取原文侧同源。 */
export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/**
 * 纯结构扫描 zstd 帧边界 —— **不解压任何 block**。
 * 逐帧: magic(4) → frame header descriptor(1) → 剩余头 → block 循环(每块 3 字节头 + 载荷)。
 * @param {Buffer} buffer 会话日志的全部字节
 * @param {number} [maxFrames] 只要前 N 帧(元数据读取用;省掉后面的扫描)
 * @returns {{frames:{start:number,end:number}[], tornStart?:number}} 完整帧区间;末尾被截断时给起始偏移
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`会话日志损坏:字节 ${offset} 处不是 zstd 帧头`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`会话日志损坏:字节 ${offset - 1} 处保留位非零`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`会话日志损坏:字节 ${offset - 3} 处保留块类型`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * 列出磁盘上的会话目录(权威的"有原文可读"清单) —— 只读目录名与文件大小,不解压。
 * 为什么不从库里列: `conv_overview` 只有 1,600+ 概述、`dsh_turns_raw` 只有 116 个会话,
 * 而磁盘有 500+ 个会话目录 ⇒ **库比磁盘少**,要读原文就得认磁盘。
 * @returns {{ok:boolean, sessions:{conv:string, project:string, bytes:number, mtime:number}[], projects:number}}
 */
export function listSessionFiles({ limit = 40, project = '' } = {}) {
  const root = sessionsRoot();
  let projs;
  try {
    projs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    return { ok: false, reason: 'no-sessions-root', message: String(e?.message ?? e), sessions: [], projects: 0 };
  }
  const sessions = [];
  for (const p of projs) {
    if (project && p !== project) continue;
    let dirs;
    try {
      dirs = fs.readdirSync(path.join(root, p), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { continue; }
    for (const c of dirs) {
      const hit = findLogIn(path.join(root, p, c));   // 没有会话日志的目录(如纯 taskfold)不算
      if (!hit) continue;
      sessions.push({ conv: c, project: p, bytes: hit.bytes, mtime: hit.mtime, log: hit.name });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);       // 最近动过的在前 —— 想读的多半是刚发生的
  return { ok: true, sessions: sessions.slice(0, Math.max(1, limit)), total: sessions.length, projects: projs.length };
}

/**
 * 定位一个会话的日志文件。conv 接受三种写法: `session-<uuid>` / `<uuid>` / 目录名原样。
 * @returns {{file:string, dir:string, project:string, id:string}|null}
 */
export function resolveSessionFile(conv) {
  const want = String(conv || '').trim();
  if (!want) return null;
  const bare = want.replace(/^session-/, '');
  const names = Array.from(new Set([want, bare, `session-${bare}`]));
  const root = sessionsRoot();
  let projs;
  try {
    projs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return null; }
  for (const p of projs) {
    for (const n of names) {
      const dir = path.join(root, p, n);
      const hit = findLogIn(dir);
      if (hit) return { file: hit.file, dir, project: p, id: n, log: hit.name };
    }
  }
  return null;
}

/**
 * 读一个会话的全部事件。**这是唯一"解压"的入口** —— 单会话实测 ~53ms。
 * @returns {{ok:boolean, reason?:string, events?:object[], frames?:number, tornStart?:number, bytes?:number}}
 */
export function readSessionEvents(conv) {
  const hit = resolveSessionFile(conv);
  if (!hit) return { ok: false, reason: 'no-session', conv: String(conv || '') };
  let buf;
  try { buf = fs.readFileSync(hit.file); } catch (e) {
    return { ok: false, reason: 'io', conv: hit.id, message: String(e?.message ?? e) };
  }
  let scanned;
  try { scanned = scanZstdFrames(buf); } catch (e) {
    return { ok: false, reason: 'corrupt', conv: hit.id, message: String(e?.message ?? e) };
  }
  const events = [];
  for (const { start, end } of scanned.frames) {
    let txt;
    try { txt = zstdDecompressSync(buf.subarray(start, end)).toString('utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 半行/非 JSON,跳过 */ }
    }
  }
  let tornPlain = 0;
  if (scanned.tornStart !== undefined) {
    // 末帧被截断(会话正写到一半):官方用 ZSTD_e_flush 兜底 —— 捞出能捞的部分,别整份判失败。
    try {
      tornPlain = zstdDecompressSync(buf.subarray(scanned.tornStart), INCOMPLETE_FRAME_OPTIONS)
        .toString('utf8').split('\n').filter((l) => l.trim()).length;
    } catch { /* 捞不出来就算了 */ }
  }
  return {
    ok: true, ...hit, events,
    frames: scanned.frames.length,
    tornStart: scanned.tornStart,
    tornLines: tornPlain,
    bytes: buf.length,
  };
}

/** 从 content 数组里取文本(可限制只取哪几类块;默认只取正文,不取思维链)。 */
function textOfContent(content, allow = ['text']) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (!allow.includes(b.type)) continue;
    if (typeof b.text === 'string' && b.text) parts.push(b.text);
  }
  return parts.join('\n');
}

/**
 * 把事件流收成**对话轮** —— 这就是"深层库要什么"的第一层过滤:
 * 只留 `user/message` 与 `assistant/message`,丢掉 tool/call、tool/result、step、compaction 等全部过程事件。
 * ⚠️ user 消息里**真人只占少数**(注入的 runtime-context / skill-catalog / task-marks 也是 user/message)。
 *   判据是 `data.source.kind === 'user'`(真人)**且**带 rpcId;其余一律标 `human:false`。
 * @returns {{turns:object[], injected:number, assistantEmpty:number}}
 */
export function dialogTurns(events) {
  const evs = events || [];
  // ⚠️ F3(蓝队 2026-10-04 全盘实测 + 修法设计):事件里**没有通道字段** —— 飞书真人、身份注入块、
  //   子代理委托种子在消息级**完全同形**(都经 `agent/inbox/spliced`)。"按通道分"只能落在**会话级**:
  //   从 `session` 事件取 header(**字段在事件顶层,不在 `data` 里**)过 `isMemoryEligibleHeader`,
  //   与捕获侧(`lifecycle.js:217/355`)同一把尺。
  //   判据五条:① `kind==='user'` ② 会话合格(top|fork) ③ 合格会话里**无 rpcId** 的 user 认真人
  //   (飞书桥来的主人真话没有 rpcId) ④ 正文行首 `/^\[身份[·・]/` 仍算注入(persona.js 自有段头)
  //   ⑤ 取不到 session 头 ⇒ 只认 rpcId(与修前逐字同解,保住无头夹具与旧日志)。
  //   实测(蓝队全盘 501 会话):真人轮 951 → **1001**(+49 飞书真人 +1 探针),注入 7049 → 6999,
  //   子代理种子 387 条 **true→false 回归 0**。
  let sessionEligible = null;
  for (const e of evs) {
    if (e && typeof e === 'object' && e.type === 'session') {
      // ⚠️ **踩坑(2026-10-04,实测抓出)**:`session` 事件里**没有 `header` 子对象** ——
      //   判据要的字段(`id` / `parentSession` / `delegationDepth` / `origin`)就**平铺在事件顶层**
      //   (`{"type":"session","version":4,"id":"feishu-…","cwd":"…","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}`)。
      //   第一版写成 `isMemoryEligibleHeader(e.header)` ⇒ 恒为 `undefined` ⇒ `sessionEligible` 永远取不到
      //   ⇒ 判据退回 ⑤(只认 rpcId)⇒ **全盘净增 0、F3 一行没生效**,而注释里却写着"已修"。
      //   所以这里传**事件本身**(兼容将来真加了 `header` 的形态)。
      sessionEligible = isMemoryEligibleHeader(e.header ?? e);
      break;
    }
  }
  const turns = [];
  let injected = 0;
  let assistantEmpty = 0;
  for (const e of evs) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'user/message') {
      const d = e.data || {};
      const src = d?.source || {};
      const text = textOfContent(d.content);
      const identityBlock = /^\[身份[·・]/.test(String(text || '').trim());
      let human;
      if (identityBlock) human = false;                    // ④ 身份块永远是注入
      else if (src.kind !== 'user') human = false;         // ① kind 必须是 user
      else if (src.rpcId) human = sessionEligible !== false; // ②⑤ 有 rpcId:沿用旧判据(子代理会话除外)
      else human = sessionEligible === true;               // ③ 无 rpcId:只在合格会话里认真人
      if (!human) injected += 1;
      turns.push({
        seq: e.seq, time: e.time, role: 'user', human, text,
      });
    } else if (e.type === 'assistant/message') {
      const d = e.data || {};
      const msg = d.message || {};
      const text = textOfContent(msg.content, ['text']);
      // ⚠️ 实测(本会话 114 条 assistant/message):`text` 块只有 10 条,**绝大多数轮次是"只调工具、没有正文"**
      //   (块类型是 `reasoning` / `tool-call` / `text` —— 注意是 `tool-call` 不是 `tool_use`)。
      //   ⇒ 无正文时把**调了哪些工具**带出来,否则目录里会是一串空白行,读不出发生过什么。
      //   同名工具**合并计数**(实测:一轮里并行调两个 pwsh,原样列出就是 `pwsh, pwsh` 这种噪音)。
      const tools = [];
      if (Array.isArray(msg.content)) {
        const counts = new Map();
        for (const b of msg.content) {
          if (b?.type !== 'tool-call' || !b.name) continue;
          const k = String(b.name);
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        for (const [k, c] of counts) tools.push(c > 1 ? `${k}×${c}` : k);
      }
      if (!text) assistantEmpty += 1;
      turns.push({ seq: e.seq, time: e.time, role: 'assistant', human: false, text, tools, turn: d.turn, step: d.step });
    }
  }
  turns.forEach((t, i) => { t.n = i + 1; });   // 人读序号(1-based);seq 是事件流里的原始序号
  return { turns, injected, assistantEmpty };
}

/** 把 `dsh_turns_raw` 的行(seq/role/ts/text)还原成**事件形状**,好让 `dialogTurns` 直接吃。
 *  1.6(2026-10-04):`recall` 原本只读磁盘 ⇒ 库里的原文(实测 15 个 `import:<id>` 会话)够不着,
 *  而磁盘那 465 个会话里没有它们。这是"读侧改道"的**反面补充** —— 库里那份也要能读,
 *  只是它没有事件流、只有轮次。
 *  ⚠️ 库里的 user 行**都已是真人**(写入时已按 `source.kind === 'user'` 过滤过) ⇒ 直接按真人标。 */
export function eventsFromRows(rows) {
  return (rows || []).map((r) => {
    const ts = Date.parse(r?.ts);
    const time = Number.isFinite(ts) ? ts : 0;
    const text = String(r?.text ?? '');
    return r?.role === 'user'
      ? { type: 'user/message', seq: r?.seq, time, data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'db' } } }
      : { type: 'assistant/message', seq: r?.seq, time, data: { message: { content: [{ type: 'text', text }] } } };
  });
}

/** 毫秒时间戳 → 本地 `MM-DD HH:mm`(与 memory.js 的口径一致:给人看的走本地钟)。 */
export function localStamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ⚠️ **孤立代理净化**(F4 修复批次,2026-10-17)。
 *
 *  为什么必须有它:JavaScript 字符串允许**半个代理对**存在(高位 `U+D800–DBFF` 或低位
 *  `U+DC00–DFFF` 落单),那是**非法 UTF-16** —— 而它一旦被送进请求体,上游 JSON 解析器
 *  **直接崩**(不是"显示怪",是整条请求 400)。
 *
 *  实测两起事故(2026-10-17 全库核实,550 会话 / 真 400 共 9 次):
 *    · `session-bc00b39b` #6331:低代理 `0xdd12` @870 —— 源自 `recall` snippet **起点**切在 emoji 中间;
 *    · `session-7ff65dd7` seq=58:高代理 `U+D83C` —— 源自 `recall` snippet **终点**切在 emoji 中间。
 *  两例**都**触发了 400(杀伤率 100%),没有侥幸活下来的样本。
 *
 *  ⇒ 口径:**凡是往外送(进模型上下文 / 落盘 / 进请求体)的文本,先过这里**。
 *  落单代理一律换成 `U+FFFD`(与浏览器、流式 UTF-8 解码同款口径)。
 *  优先用运行时自带的 `String.prototype.toWellFormed`(ES2024),没有就手写等价实现。 */
export function wellFormed(s) {
  const t = String(s ?? '');
  if (typeof t.toWellFormed === 'function') return t.toWellFormed();
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < t.length ? t.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += t[i] + t[i + 1]; i += 1; } else out += '\uFFFD';
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += t[i];
    }
  }
  return out;
}

/** **不切断代理对**的截断(超出留 `…`)。与 `slice(0, n)` **同口径** —— `cap` 数的是
 *  **UTF-16 单元**(emoji 算 2),唯一差别是切点若落在代理对中间就**回退一格**,
 *  绝不吐出半个字符。⇒ 代价只有"含 emoji 的文本少显示一两个字",换来的是回执永远合法。
 *  实现刻意做成 O(1)(只回退一格,不构造码点数组)—— 它会被高频调用。 */
export function clipChars(s, cap) {
  const t = wellFormed(s);
  const k = Math.max(1, Number(cap) || 0);
  if (t.length <= k) return t;
  let end = k;
  // 切点前一个单元是高代理 ⇒ 它的低代理会被丢掉 ⇒ 回退一格,把整个字符留在片段里
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return t.slice(0, end) + '…';
}

/** 按**码点**安全取区间(起点与终点都不切断代理对)。`recall` 的"命中位置附近截一段"用它。
 *  起点落在低代理上 ⇒ 回退一格(宁可多带一个字符,也不留下半个 emoji)。 */
export function safeSlice(s, from, to) {
  const t = wellFormed(s);
  const n = t.length;
  let a = Math.max(0, Math.min(Number(from) || 0, n));
  let b = Math.max(a, Math.min(Number(to) || 0, n));
  const ca = t.charCodeAt(a);
  if (ca >= 0xdc00 && ca <= 0xdfff) a = Math.max(0, a - 1);
  const cb = t.charCodeAt(b - 1);
  if (cb >= 0xd800 && cb <= 0xdbff) b = Math.min(n, b + 1);
  return t.slice(a, b);
}

/** 单行化 + 截断(目录视图用)。名字不叫 flatOne:`tools.js` 里已有一个同名的(签名不同)。
 *  ⚠️ F4(2026-10-17):截断改走 `clipChars`(按码点)—— 原来直接 `slice` 会把 emoji 切成半个,
 *  那半个代理会随工具回执进上下文、并把官方路由打成 400(见 `wellFormed` 的事故记录)。 */
export function oneLine(s, cap = 60) {
  const t = wellFormed(String(s || '').replace(/\s+/g, ' ').trim());
  if (!t) return '';
  return clipChars(t, cap);
}

// ══ 1.7.2 · recall 回执降噪(2026-10-23)══════════════════════════════════════════
// 三个纯函数,对应交接单的 M1 / M3 / M6。**放在文本出口这一层,不塞进渲染器** ——
// 回执有四个出口(检索档、目录档、原文档、错误档),每个各写一份就会各错一处
// (1.7 的 F-01 正是"修了三处、漏了两处"的现场)。

/** 删掉 `token` **最后出现**的那一处(只用于末尾未闭合的标记,不重排正文)。 */
function cutLastToken(t, token) {
  const i = t.lastIndexOf(token);
  if (i < 0) return t;
  return t.slice(0, i) + t.slice(i + token.length);
}

/** **M1 · 截断后清理未闭合标记**(不补闭合,只剥掉末尾那个)。
 *
 *  现场:实测 51 条回执平均 1,211 字符,`**`/`` ` `` 约占 3.5%;而截断常常落在标记中间,
 *  于是回执末尾留一个孤零零的 `**` 或 `` ` `` —— 模型读到的是一段**语法已坏**的文本,
 *  却看不出这是截断造成的(它会以为正文里本来就有个星号)。
 *
 *  口径三条:
 *   ① 只数 `**` / `` ` `` / `[` / `【` 的**奇偶**;奇数 ⇒ 最后一个没闭合 ⇒ 剥掉它
 *      (`【` 是回执自己的大纲符号,清单 §3 M1 明确要求一起数);
 *   ② **不补**闭合标记 —— 补会凭空造字(补在句中断句处,读起来更假);
 *   ③ 只动**末尾那一处**,中间成对的标记是回执自己的格式,一个字不动。 */
export function stripDanglingMarkers(s) {
  let t = String(s ?? '');
  for (let round = 0; round < 4; round += 1) {
    const before = t;
    // ⚠️ 代码围栏 ` ``` ` 必须**整体**算一个标记(2026-10-23 夜 · 对抗审计 A 抓到):
    //   围栏是 3 个反引号,按"单个反引号"的奇偶去算会把它拆成 2+1 —— 于是截断后的围栏
    //   会剩两个反引号(` ``js`)、甚至反过来把前文成对的行内代码当成悬空的那个。
    //   先整段剥围栏,再数单个反引号,两个口径就不会互相污染。
    if ((t.split('```').length - 1) % 2 === 1) t = cutLastToken(t, '```');
    if ((t.split('**').length - 1) % 2 === 1) t = cutLastToken(t, '**');
    if ((t.split('`').length - 1) % 2 === 1) t = cutLastToken(t, '`');
    const open = (t.match(/\[/g) || []).length;
    const close = (t.match(/]/g) || []).length;
    if (open > close) t = cutLastToken(t, '[');
    const openCjk = (t.match(/【/g) || []).length;
    const closeCjk = (t.match(/】/g) || []).length;
    if (openCjk > closeCjk) t = cutLastToken(t, '【');
    if (t === before) break;
  }
  return t;
}

/** **M3 · 只剥 snippet 里的成对标记**(选项 C:回执自身格式保留)。
 *
 *  为什么只剥"成对"的:`**粗体**` 在 GUI 里有意义,在上下文里只是两个字符;
 *  但**没配对的**那个是截断残渣,归 M1 管 —— 两件事分开做,才各自可测。
 *  支持三种成对形态:粗体 `**x**` · 行内代码 `` `x` `` · 行内链接 `[x](url)`(留文字丢地址)。 */
export function stripPairedMarkdown(s) {
  let t = String(s ?? '');
  for (let round = 0; round < 3; round += 1) {
    const before = t;
    t = t
      .replace(/\*\*([^*\n]+)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1');
    if (t === before) break;
  }
  return t;
}

/** **M6 · 回执总字数上限**(默认 4,000)。
 *
 *  超了**截断并报出还剩多少** —— 绝不静默截断(那会让"没显示"读成"没有")。
 *  返回 `{ text, truncated, remaining }`;`remaining` 是被切掉的**字符数**(UTF-16 单元),
 *  报给模型的是"还有多少没看到",不是"还有多少轮"(轮数是 read 档的 `remaining`,别混)。
 *  ⚠️ 切点走 `clipChars`(不切半个 emoji) —— 与 F4 同一道防线。
 *
 *  ⚠️⚠️ `keepTail`(2026-10-23 夜 · 对抗审计抓到后加的):**末尾的语义警告必须保住**。
 *  回执的"本会话被排除 N 轮 / 被范围挡掉 N 条 / 还有更多 / 库里另有 N 条只有概述"全都拼在**末尾**
 *  —— 直接按字数截断会把它们连正文一起切掉,于是"排除了 7 轮"变成"没有这回事"。
 *  实测(审计员给的数):search 40 条长片段时三者**全部消失**,布尔 self/scope/more 均 false。
 *  ⇒ 口径:截断只截**正文**,`keepTail` 那段**原样保留**,并从预算里先扣掉它的长度。 */
export const RECEIPT_CHARS_MAX = 4000;
export function capReceiptText(s, cap = RECEIPT_CHARS_MAX, keepTail = '') {
  const t = String(s ?? '');
  const tail = String(keepTail ?? '');
  const k = Math.max(400, Number(cap) || RECEIPT_CHARS_MAX);
  if (t.length <= k) return { text: t, truncated: false, remaining: 0 };
  const budget = Math.max(200, k - tail.length);
  const head = clipChars(t, budget);
  const shown = Math.max(0, head.length - 1); // 末尾那个 '…' 不算正文
  const remaining = Math.max(0, t.length - shown - tail.length);
  return {
    text: head
      + `\n\n…(回执到 ${k} 字上限,**还有 ${remaining} 字没显示** —— 缩小查询词,或分次取(原文档用 from/to,清单档用更小的 limit)。)`
      + tail,
    truncated: true,
    remaining,
  };
}
