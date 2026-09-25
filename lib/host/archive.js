// dsh-ling host — 改动前的归档落盘(Part G · G2,2026-09-25)
//
// **原则(用户定):永远不做彻底删除。**
// 任何"清除/覆盖"类的操作,动手之前先把原数据**完整写到磁盘上的历史目录**,并附一份
// 人可读的改动日志 —— 谁、什么时候、为什么、以及怎么还原。
//
// 为什么单独成模块:遗忘与回灌是这套系统里仅有的两个"会让人后悔"的操作。
// 库内标记(`forgotten` 表)与磁盘归档是**两条独立的还原路径**:库里没删行,所以撤销标记即可;
// 就算库没了,归档文件还在。任何一条断了都还有另一条。

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 本地时间戳(目录名用;不用 toISOString —— 那是 UTC,会和主人的钟差 8 小时)。 */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 人看的时间(写进日志)。 */
function humanTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 短 id(目录名用;完整 id 太长,而归档目录要能一眼看出对应哪一条)。 */
function shortId(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'unknown';
}

/** 归档根目录:与 memory.db 同级,便于整体搬走/备份。 */
export function archiveRootOf(memory) {
  const dbPath = String(memory?.dbPath || '');
  const base = dbPath ? dirname(dbPath) : '.';
  return join(base, 'forgotten');
}

/**
 * 把一条记忆的**全部数据**归档落盘。
 *
 * @param {object} memory  MemoryStore(需要 exportEntry / dbPath)
 * @param {object} opts
 * @param {string} opts.source    来源域(dsh / dsweb / import)
 * @param {string} opts.convId    条目 id
 * @param {string} opts.kind      'forget' | 'backfill'(决定目录前缀与日志措辞)
 * @param {string} opts.reason    为什么动它(人写的话)
 * @param {string} opts.actor     'user' | 'ling'
 * @returns {{ok:boolean, dir?:string, turns?:number, reason?:string, message?:string}}
 */
export function archiveBefore(memory, { source, convId, kind = 'forget', reason = '', actor = 'user' } = {}) {
  const s = String(source || '').trim();
  const c = String(convId || '').trim();
  if (!s || !c) return { ok: false, reason: 'bad-key' };
  let data;
  try {
    data = memory.exportEntry(s, c);
  } catch (e) {
    return { ok: false, reason: 'export-failed', message: String(e?.message ?? e).slice(0, 160) };
  }
  const at = new Date();
  const dir = join(archiveRootOf(memory), `${localStamp(at)}-${kind}-${shortId(c)}`);
  const isForget = kind === 'forget';
  try {
    mkdirSync(dir, { recursive: true });
    // 原文逐行 JSONL —— 能 grep、能逐行还原,比一个大 JSON 数组更耐损
    const turnsText = (data.turns || []).map((t) => JSON.stringify(t)).join('\n');
    writeFileSync(join(dir, 'turns.jsonl'), turnsText ? turnsText + '\n' : '', 'utf8');
    writeFileSync(join(dir, 'overview.json'), JSON.stringify(data.overview || null, null, 2), 'utf8');
    writeFileSync(join(dir, 'session-meta.json'), JSON.stringify(data.sessionMeta || null, null, 2), 'utf8');
    writeFileSync(join(dir, 'README.md'), readme({
      at, s, c, kind, reason, actor, turns: (data.turns || []).length,
    }), 'utf8');
  } catch (e) {
    return { ok: false, reason: 'write-failed', message: String(e?.message ?? e).slice(0, 160) };
  }
  if (!existsSync(join(dir, 'README.md'))) return { ok: false, reason: 'write-failed' };
  return { ok: true, dir, turns: (data.turns || []).length, isForget };
}

/** 改动日志 —— 这份文件是给**将来的人**看的,所以写全:是什么、为什么、怎么还原。 */
function readme({ at, s, c, kind, reason, actor, turns }) {
  const who = actor === 'ling' ? '器灵(工具通道)' : '主人(界面通道)';
  const what = kind === 'forget' ? '遗忘(软标记 —— **库里的行没有删**)'
    : '回灌(用归档恢复一条记忆 —— **覆盖前的状态已存这里**)';
  return `# 归档:${kind === 'forget' ? '遗忘前' : '回灌前'}的原始数据

| | |
|---|---|
| 操作 | ${what} |
| 对象 | \`source=${s}\` · \`conv_id=${c}\` |
| 时间 | ${humanTime(at)} |
| 操作者 | ${who} |
| 原因 | ${reason || '(未填写)'} |

## 这里有什么

- \`turns.jsonl\` —— 原文 **${turns}** 轮(每行一条 JSON,字段与库表 \`dsh_turns_raw\` 同构)
- \`overview.json\` —— 概述行(标题 / 摘要 / 关键词 / 权重 / 置顶 …)
- \`session-meta.json\` —— 会话元数据(模式 / 枝归属 …)

## 怎么还原

**库里没有删任何行** —— ${kind === 'forget'
    ? '只是多了一条 `forgotten` 标记,召回路径不再选它。撤销方式二选一:'
    : '回灌只是把归档写回去,而**它覆盖之前的状态存在这里**。要退回去:'}

1. 让器灵调工具撤销(\`memory_forget\` 的 \`undo\` / 再回灌一次旧档),或
2. 直接删标记:
   \`\`\`sql
   DELETE FROM forgotten WHERE source='${s}' AND conv_id='${c}';
   \`\`\`

万一库本身没了(换机 / 误删),用这里的文件重建:

- 原文:\`turns.jsonl\` 逐行 \`INSERT INTO dsh_turns_raw (session_id,seq,role,ts,model,text) VALUES (…)\`
- 概述:按 \`overview.json\` 写回 \`conv_overview\`

## 为什么保留

忘错了要能回头。这是用户定的规矩:**永远不做彻底删除** ——
所以这个目录是"曾经发生过什么"的证据,不是垃圾。不要随手清。

> 生成于 dsh-ling · Part G(器灵侧正规通道)
`;
}

/** 列出归档目录(最近的在前)—— 回答"这里能回灌什么"。 */
export function listArchives(memory, { limit = 50 } = {}) {
  const root = archiveRootOf(memory);
  let names = [];
  try {
    names = readdirSync(root).filter((n) => /^\d{8}-\d{6}-/.test(n));
  } catch {
    return [];
  }
  names.sort().reverse();
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return names.slice(0, n).map((name) => {
    const dir = join(root, name);
    let turns = 0;
    try {
      turns = readFileSync(join(dir, 'turns.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch { /* 没有原文的归档也算一条记录 */ }
    return { name, dir, turns };
  });
}

/** 读回一个归档目录(名字取自 listArchives)。 */
export function readArchive(memory, name) {
  const safe = String(name || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return { ok: false, reason: 'bad-name' };
  const dir = join(archiveRootOf(memory), safe);
  const out = { ok: true, name: safe, dir, turns: [], overview: null, note: '' };
  try {
    out.turns = readFileSync(join(dir, 'turns.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { /* 允许无原文 */ }
  try { out.overview = JSON.parse(readFileSync(join(dir, 'overview.json'), 'utf8')); } catch { /* ignore */ }
  try {
    // 日志里的"对象/操作者/原因"三行 —— 回灌之前让人先看一眼:当初为什么把它忘掉的
    const md = readFileSync(join(dir, 'README.md'), 'utf8');
    out.note = md.split('\n').filter((l) => /操作者|原因|对象/.test(l)).join(' ').replace(/\s+/g, ' ').slice(0, 300);
  } catch { /* ignore */ }
  return out;
}
