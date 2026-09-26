// dsh-ling host — DSH 存量会话回溯(把捕捉上线前的磁盘会话纳入记忆)。
// 语义与 tools/backfill-dsh.mjs 一致,读侧独立为模块供 API 使用;
// 写侧走传入的 MemoryStore(与运行中实例同库,免并发双开)。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { categorizeTitle } from './classify.js';
import { keywordsFrom } from './inject-common.js';
import { decodeAll } from './zstd.js';

/**
 * 会话转储文件名(代次可变)。
 * DSH 升级会改写文件名:session.jsonl.zstd → session.v3.jsonl.zstd → session.v4.jsonl.zstd …
 * 旧的写死匹配漏掉 v3/v4(本机实测 204 个会话只看见 53 个),故一律按此正则认。
 */
export const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 在一个会话目录里挑出会话转储文件。
 * 规则:匹配 SESSION_FILE_RE → 取版本号最高的一代(无版本号视为 0,即最低)→ 跳过 0 字节文件(写盘未完成)。
 * @returns {{f:string,name:string,ver:number,size:number}|null} 无匹配返回 null
 */
export function pickSessionFile(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names.slice().sort()) { // 排序:同代次多文件时结果稳定
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;
    const ver = m[1] ? Number(m[1]) : 0;
    let st;
    try { st = statSync(join(dir, name)); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (!best || ver > best.ver) best = { f: join(dir, name), name, ver, size: st.size };
  }
  return best;
}

/**
 * DSH 会话根目录的默认位置 —— **单一来源**:`candidateSessionFiles` 的默认值与
 * `scanDshHistory` 的入口解析共用它,不允许各写一份。
 * 为什么必须是一个显式函数:不传 root 时,扫描侧有默认值照常工作,而归因探针侧
 * 拿到 `undefined` → `readdirSync(undefined)` 抛错被吞 → 恒判 `no-sessions-root`,
 * 界面渲染成「未找到 DSH 会话目录:undefined」(BUG-2 归因几乎不可达)。
 */
export function defaultSessionsRoot() {
  return join(homedir(), '.dsh', 'sessions');
}

/** 候选会话文件: ~/.dsh/sessions/<workspace>/<sid>/{session[.vN].jsonl.zstd} */
export function candidateSessionFiles(root = defaultSessionsRoot()) {
  const jobs = [];
  let ws;
  try { ws = readdirSync(root, { withFileTypes: true }); } catch { return jobs; }
  for (const w of ws) {
    if (!w.isDirectory()) continue;
    const wsDir = join(root, w.name);
    let subs;
    try { subs = readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      const hit = pickSessionFile(join(wsDir, d.name));
      if (hit) jobs.push({ f: hit.f, ws: w.name, sid: d.name, file: hit.name, ver: hit.ver });
    }
  }
  return jobs;
}

/**
 * 「0 候选」的归因探针(仅在扫到 0 时调用,代价可忽略)。
 * 让「一个会话文件都没匹配上」与「这台机器根本没历史」可区分(BUG-2)。
 */
function emptyScanInfo(root) {
  const info = { root, rootExists: false, sessionDirs: 0, emptyFiles: 0, fileNames: [] };
  let ws;
  try { ws = readdirSync(root, { withFileTypes: true }); } catch { return withNote(info); }
  info.rootExists = true;
  for (const w of ws) {
    if (!w.isDirectory()) continue;
    let subs;
    try { subs = readdirSync(join(root, w.name), { withFileTypes: true }); } catch { continue; }
    for (const d of subs) {
      if (!d.isDirectory()) continue;
      info.sessionDirs += 1;
      let names;
      try { names = readdirSync(join(root, w.name, d.name)); } catch { continue; }
      for (const n of names) {
        if (!/\.jsonl(\.zst|\.zstd)?$/.test(n)) continue;
        if (info.fileNames.length < 8 && !info.fileNames.includes(n)) info.fileNames.push(n);
        if (!SESSION_FILE_RE.test(n)) continue;
        try { if (statSync(join(root, w.name, d.name, n)).size === 0) info.emptyFiles += 1; } catch {}
      }
    }
  }
  return withNote(info);
}

function withNote(info) {
  if (!info.rootExists) {
    info.reason = 'no-sessions-root';
    info.note = `未找到 DSH 会话目录:${info.root}(这台机器可能没跑过 DSH,或用 DSH_HOME 指到了别处)`;
  } else if (info.sessionDirs === 0) {
    info.reason = 'no-session-dirs';
    info.note = `会话目录存在但没有任何会话子目录:${info.root}`;
  } else if (info.emptyFiles > 0) {
    info.reason = 'empty-session-files';
    info.note = `${info.emptyFiles} 个会话文件是 0 字节(已跳过,可能是写盘未完成):${info.root}`;
  } else if (info.fileNames.length) {
    info.reason = 'no-session-files';
    info.note = `未找到会话文件(可能是 DSH 会话格式版本变化);目录里见到的相关文件:${info.fileNames.join('、')}`;
  } else {
    info.reason = 'no-session-files';
    info.note = `未找到会话文件(可能是 DSH 会话格式版本变化):${info.root}`;
  }
  return info;
}

function parseHeader(firstLine) {
  try {
    const j = JSON.parse(firstLine);
    return {
      deleg: Number(j.delegationDepth ?? 0),
      origin: j.origin,
      parent: !!j.parentSession,
      id: j.id || '',
      cwd: j.cwd || '',
      preset: j.agentPreset || '',
    };
  } catch {
    return null;
  }
}

/** 对单个会话文件:判定顶层、抽取真实消息 → 概述行(不写库)。 */
export function overviewRowFromFile(file, ws, sid) {
  let text;
  try {
    text = decodeAll(readFileSync(file));
  } catch {
    return { skip: 'failed', row: null };
  }
  // 顶层判定:从解码全文找 header 行(type=session)
  let isChild = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (line.includes('"type":"session"')) {
      const h = parseHeader(line);
      if (h) isChild = !!(h.parent || h.origin === 'subagent' || h.deleg > 0);
      break;
    }
    if (!line.includes('"type"')) continue;
    break;
  }
  if (isChild) return { skip: 'child', row: null };

  let firstUser = '';
  let nUser = 0;
  let nAsst = 0;
  let totalChars = 0;
  let t0 = null;
  let t1 = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user/message"') && !line.includes('"type":"assistant/message"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const kind = ev?.data?.source?.kind;
    const t = Number(ev?.time);
    if (t) { if (t0 === null || t < t0) t0 = t; if (t1 === null || t > t1) t1 = t; }
    if (ev.type === 'user/message') {
      if (kind !== 'user') continue; // 只留真人
      const body = ev?.data?.content;
      const u = Array.isArray(body)
        ? body.filter((b) => b?.type !== 'reasoning' && b?.type !== 'tool-call').map((b) => b?.text || b?.content || '').join('\n')
        : '';
      if (!u) continue;
      nUser += 1;
      totalChars += u.length;
      if (!firstUser) firstUser = u.trim();
    } else {
      const msg = ev?.data?.message;
      const body = msg?.content;
      const a = Array.isArray(body)
        ? body.filter((b) => b?.type === 'text' || !b?.type).map((b) => b?.text || b?.content || '').join('\n')
        : '';
      if (!a) continue;
      nAsst += 1;
      totalChars += a.length;
    }
  }
  if (!firstUser) return { skip: 'no-user', row: null };
  const oneLine = firstUser.replace(/\s+/g, ' ').trim();
  const weak = nUser < 1 || nUser + nAsst < 2 || totalChars < 40;
  const trivial = nUser <= 2 && /^(hello|hi|test|你好|嗨|哈喽|在吗|还在吗|嗯|哈哈|测试|123)/i.test(oneLine);
  if (weak || trivial) return { skip: 'weak', row: null };
  const cat = categorizeTitle(oneLine);
  return {
    skip: null,
    row: {
      conv_id: sid,
      source: 'dsh',
      title: oneLine.slice(0, 46) || '(未命名会话)',
      started_at: t0 ? new Date(t0).toISOString() : null,
      updated_at: t1 ? new Date(t1).toISOString() : null,
      domain_tags: [cat === 'knowledge' ? '知识' : cat === 'feeling' ? '生活' : '日常'],
      category: cat,
      keywords: keywordsFrom((oneLine + ' ' + firstUser).slice(0, 400)),
      summary: `${oneLine.slice(0, 140)} — ${nUser + nAsst} 条消息`,
      heat: 0,
      importance: 0,
      last_hit_at: null,
      hit_count: 0,
      overview_ok: 1,
      origin: 'dsh-backfill-v1',
    },
  };
}

/**
 * 全量扫描:枚举 → 解码 → 顶层/弱会话过滤 → (可选)写入 memory。
 * @param {object} opts { memory?: MemoryStore(提供则写入), root?, limit? }
 * @returns {{report, rows}} report 字段与 CLI 版一致;rows 为本次新增行。
 */
export async function scanDshHistory({ memory = null, root, limit = 0 } = {}) {
  // BUG-2:入口处**一次解析** root,扫描与归因共用同一个值。
  // 旧写法把 `root`(可能是 undefined)直接交给 emptyScanInfo,而 api.js 的
  // `/dsh/backfill` 只传 `{ memory, limit }` ⇒ 归因恒判 no-sessions-root、note 里
  // 打印 undefined,并被 client 显示给用户。此处解析后,任何调用方(HTTP / CLI / 工具)
  // 不传 root 都能拿到真实根目录。
  const sessionsRoot = root ?? defaultSessionsRoot();
  const jobs = candidateSessionFiles(sessionsRoot);
  const report = { scanned: 0, topLevel: 0, decoded: 0, eligible: 0, created: 0, skippedExists: 0, skippedWeak: 0, failed: 0 };
  // BUG-2:「0 候选」必须给出原因,否则和「这台机器没历史」在界面上长得一模一样
  if (!jobs.length) Object.assign(report, emptyScanInfo(sessionsRoot));
  const rows = [];
  const seen = new Set();
  if (memory) {
    for (const r of memory.listOverviews({ source: 'dsh' })) seen.add(String(r.conv_id));
  }
  for (const job of jobs) {
    report.scanned += 1;
    const { skip, row } = overviewRowFromFile(job.f, job.ws, job.sid);
    if (skip === 'failed') { report.failed += 1; continue; }
    report.decoded += 1;
    if (skip === 'child') continue;
    report.topLevel += 1;
    if (skip) { report.skippedWeak += 1; continue; }
    if (seen.has(job.sid)) { report.skippedExists += 1; continue; }
    report.eligible += 1;
    rows.push(row);
    if (limit > 0 && rows.length >= limit) break;
  }
  if (memory && rows.length) {
    memory.db.exec('BEGIN');
    try {
      for (const r of rows) memory.upsertOverview(r);
      memory.db.exec('COMMIT');
    } catch (e) {
      try { memory.db.exec('ROLLBACK'); } catch {}
      throw e;
    }
    report.created = rows.length;
    memory.kvSet('backfill.last', JSON.stringify({ at: new Date().toISOString(), ...report, inserted: rows.length }));
  } else if (memory) {
    memory.kvSet('backfill.last', JSON.stringify({ at: new Date().toISOString(), ...report, inserted: 0 }));
  }
  return { report, rows };
}
