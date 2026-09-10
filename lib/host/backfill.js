// dsh-ling host — DSH 存量会话回溯(把捕捉上线前的磁盘会话纳入记忆)。
// 语义与 tools/backfill-dsh.mjs 一致,读侧独立为模块供 API 使用;
// 写侧走传入的 MemoryStore(与运行中实例同库,免并发双开)。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { categorizeTitle } from './classify.js';
import { keywordsFrom } from './inject-common.js';
import { decodeAll } from './zstd.js';

/** 候选会话文件: ~/.dsh/sessions/<workspace>/<sid>/session.jsonl.zstd */
export function candidateSessionFiles(root = join(homedir(), '.dsh', 'sessions')) {
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
      const f = join(wsDir, d.name, 'session.jsonl.zstd');
      try { statSync(f); jobs.push({ f, ws: w.name, sid: d.name }); } catch {}
    }
  }
  return jobs;
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
  const jobs = candidateSessionFiles(root);
  const report = { scanned: 0, topLevel: 0, decoded: 0, eligible: 0, created: 0, skippedExists: 0, skippedWeak: 0, failed: 0 };
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
