// dsh-ling host — loopback HTTP gateway /api/dsh-ling/*
// webServer acquisition is robust to boot order: direct svc → ctx.inject
// scope → periodic retry until mounted (routes disappear if unavailable).
import { svc, pick, isoDate } from './util.js';
import { assemblePersona, pronounOf, pronounize } from './persona.js';
import { applyModeToSession, currentMode, currentModelSelection, MODE_LABEL, resolveModeConfig } from './mode.js';
import { invalidateSession, refreshStats } from './inject.js';
import { selectL1 } from './l1.js';
import { applySuggestionAsRule, dismissSuggestion } from './feedback.js';
import { applyCorpusSuggestion, dismissCorpusSuggestion } from './suggestions.js';
import { runDeepPass, rerunOne, candidateFor, deepSummarizeOne, llmOnce, importRawTargets } from './deepsummary.js';
import { GENESIS_SYS, parseGenesisResult, buildGenesisSource, composeGenesisRows, filterNamePairs } from './genesis.js';
import { scanIntoMemory } from './scan-dsweb.js';
import { scanDshHistory } from './backfill.js';
import { applyImportItems } from './import-file.js';
import { sealOk, KEY_MIN } from './seal.js';
import { timeAnchor } from './clock.js';
import { TONE_ADVICE_SYS, TONE_SET, sampleToneRows, parseToneAdvice, appendStyleNote } from './tone-advice.js';
import { logImport, listImportLog, formatLogLine } from './import-log.js';
import { checkRequest, lanAddresses, sanitizePersonaPatch } from './guard.js';
import { retitleOne, retitleOneGlobal, heuristicRetitle } from './retitle.js';
import {
  addRule, removeRule, proposeHabit, resolveHabit, removeHabit, amendHabit, habitsOf, rulesView, RULE_MAX_CHARS,
  habitsPendingOf, pendingMaxOf,
} from './rules.js';
import {
  scanCorrections, evidenceOf, SCAN_DEFAULTS, summarizeScan,
  HABIT_REFLECT_SYS, buildReflectMaterial, parseReflect, REFLECT_DEFAULTS, reflectWithRetry,
} from './habit-gen.js';
import {
  openSource, buildCandidates, conversationText, probeAssistant, summarizeWithRetry, cleanSummary,
  touchMemoryVersion, resolveAssistant, MIN_TURNS_DEFAULT, SUMMARY_SYS,
} from './dsweb-summary.js';
import { TRUNK_ID } from './memory.js';
import { bucketize, nameBucket } from './autotree.js';

// (旧)只校验 cookie 名形状的守卫已废弃 —— 见 guard.js:来源栅栏 + 名字对撞(2026-09-16 加固 ①+②)
// 网页端聊天记录库的默认路径:私有路径不写死在代码里 —— 由 UI 传入,或用 DSH_LING_DSWEB_DB 环境变量覆盖。
const DSWEB_DB_DEFAULT = process.env.DSH_LING_DSWEB_DB || '';
const MSG_KEY = '定型门:档案已定型 — 请在「解锁修改」弹窗里亲手敲一遍你的承诺句(输入框禁粘贴;若旧档案无明文记录,输入一句新的 ≥' + KEY_MIN + ' 字承诺即被采纳)。';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/** 记忆来源白名单(D2/D8,2026-09-17):旧代码写死 `body.source === 'dsh' ? 'dsh' : 'dsweb'`,
 *  会把 source='import' 的置顶/删除误打到 dsweb 源上。 */
const MEM_SOURCES = ['dsh', 'dsweb', 'import'];

function readBody(req, maxBytes = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('单次请求体过大(超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限),请拆分后重试'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function registerApi(ctx, deps, config) {
  const { gate, memory, settings } = deps;

  // ---- 获取 webServer:直取 → inject 子作用域 → 定时重试 ----
  let disposed = false;
  let disposeRoutes = null;
  let timer = null;

  const tryMount = () => {
    if (disposed || disposeRoutes) return;
    let server = svc(ctx, 'webServer');
    let scopeCtx = null;
    if (!server || typeof server.register !== 'function') {
      // ctx.inject(['webServer'], cb) 在服务可用时立刻回调子 ctx
      try {
        ctx.inject?.(['webServer'], (child) => {
          scopeCtx = child;
          const s2 = child?.webServer;
          if (s2 && typeof s2.register === 'function' && !disposeRoutes) {
            disposeRoutes = mountRoutes(s2);
            memory.kvSet('api.registered', '1');
          }
        });
      } catch (e) {
        console.debug('[dsh-ling] ctx.inject webServer failed', e);
      }
      server = scopeCtx?.webServer ?? null;
    }
    if (server && typeof server.register === 'function') {
      disposeRoutes = mountRoutes(server);
      memory.kvSet('api.registered', '1');
    }
  };

  const mountRoutes = (server) => {
    const disposers = [];
    // 一键深摘(import 源)的运行状态:单实例串行,防并发重入
    const impRun = { running: false, total: 0, done: [], startedAt: 0, finishedAt: 0 };
    // 网页端库"补摘要"运行状态(与深摘同纪律:单实例串行 + 轮询进度)
    const dswebRun = {
      running: false, total: 0, done: [], ok: 0, fail: 0, current: '', engine: '',
      startedAt: 0, finishedAt: 0, lastError: null, db: '',
    };
    // 守卫(2026-09-16 加固 ①+②,2026-09-17 加固 ③):来源栅栏(loopback / **显式** trustedHosts
    // + 非 cross-site + Origin 同源)+ 会话 cookie **名字对撞**(期望名由 Host 派生,与 DSH 同法)。
    // ③(G1)= 本机 LAN 地址不再自动信任:settings.guard.allowLan 默认 false,要开局域网访问须显式打开。
    // 逃生开关:DSH_LING_GUARD=off 或 settings.guard.enforce=false(误判时不会把人锁在门外)。
    const guardVerdict = (req) => {
      const g = (settings.get().guard && typeof settings.get().guard === 'object') ? settings.get().guard : {};
      if (process.env.DSH_LING_GUARD === 'off' || g.enforce === false) return { ok: true, reason: 'disabled' };
      const extra = Array.isArray(g.trustedHosts) ? g.trustedHosts : [];
      return checkRequest(req.headers, { trustedHosts: extra, allowLan: g.allowLan === true });
    };
    const guard = (handler) => async (req, res) => {
      const verdict = guardVerdict(req);
      if (!verdict.ok) {
        console.info('[dsh-ling] guard rejected: %s (host=%s site=%s origin=%s)',
          verdict.reason, req.headers.host, req.headers['sec-fetch-site'], req.headers.origin);
        sendJson(res, 403, { ok: false, error: 'forbidden', reason: verdict.reason });
        return;
      }
      try {
        await handler(req, res);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
      }
    };
    // 供状态/自检使用:本机 LAN 地址(G1 之后**不再**自动受信,仅用于提示"要不要显式打开 allowLan")
    const guardInfo = () => ({
      lan: lanAddresses(),
      enabled: process.env.DSH_LING_GUARD !== 'off',
      allowLan: settings.get().guard?.allowLan === true,
    });
    const register = (path, handler) =>
      server.register({ kind: 'exact', path: '/api/dsh-ling' + path, handler: guard(handler) });

    /** 批量失效所有已定稿快照(规矩/习惯写入后调用;运行中的会话只标记 stale,空闲边界再生效)。 */
    const invalidateAllSummaries = () =>
      allSnapshotSessionIds(gate).map((sid) => ({ sessionId: sid, result: invalidateSession(gate, memory, settings, sid) }));

    /** L0 预览 = 人格段 + 实时时间锚(与注入面一致,便于用户在状态页看到"现在")。 */
    const l0WithClock = (s, mode) => {
      const base = assemblePersona(s, mode);
      const anchor = timeAnchor(memory, settings);
      return anchor ? (base ? base + '\n\n' + anchor : anchor) : base;
    };

    const personaInfo = (s) => ({
      enabled: s?.persona?.enabled !== false,
      userTitle: s?.persona?.userTitle ?? '',
      aiName: s?.persona?.aiName ?? '',
      aiTitle: s?.persona?.aiTitle ?? '',
      tone: s?.persona?.tone ?? 'natural',
      toneWork: s?.persona?.toneWork ?? '',
      toneLife: s?.persona?.toneLife ?? '',
      language: s?.persona?.language ?? 'follow',
      hardRules: Array.isArray(s?.persona?.hardRules) ? s.persona.hardRules : [],
      // 规矩/习惯(2026-09-15 二分):人格中心要看到它们,否则会显示"还没有习惯"(数据其实在,只是没被这个白名单带出来)
      habits: Array.isArray(s?.persona?.habits) ? s.persona.habits : [],
      habitsPending: Array.isArray(s?.persona?.habitsPending) ? s.persona.habitsPending : [],
      ruleMeta: Array.isArray(s?.persona?.ruleMeta) ? s.persona.ruleMeta : [],
      bottomLines: Array.isArray(s?.persona?.bottomLines) ? s.persona.bottomLines : [],
      sealed: s?.persona?.sealed === true,
      hasSeal: !!s?.persona?.sealPhrase,
      sealPhrase: s?.persona?.sealPhrase ?? '', // 明文回显用(锁只造庄重,不保密)
      extraLore: s?.persona?.extraLore ?? '',
      pronoun: s?.persona?.pronoun || '她', // 第三人称代词(用户设定;预设 她/他/TA/它,可自定义)
      stylesWork: s?.styles?.work ?? '',
      stylesLife: s?.styles?.life ?? '',
    });

    const touchesPersona = (patch) =>
      (patch && typeof patch === 'object') &&
      ((patch.persona && typeof patch.persona === 'object' && Object.keys(patch.persona).length) ||
        (patch.styles && typeof patch.styles === 'object' && Object.keys(patch.styles).length));
    const clampBottomLines = (patch) => {
      const bl = patch?.persona?.bottomLines;
      if (Array.isArray(bl) && bl.length > 5) {
        patch.persona.bottomLines = bl.slice(0, 5); // 底线上限 5 条(host 侧硬保险)
        patch._bottomCapped = true;
      }
      return patch;
    };
    /**
     * 存档一份人格档案快照(语义 = 「那次操作之后的档案」,用户直觉即所见;回滚前
     * 额外用 kind='pre-rollback' 留一份当前档案便于反悔)。与最新一份完全相同则跳过。
     * 上限 30 份(hist/log 同步修剪)。
     */
    const archivePersona = async (s, kind = 'result') => {
      const at = Date.now();
      const p = s.persona || {};
      const rows = memory.kvList('persona.hist.');
      if (rows.length) {
        const latest = rows[rows.length - 1]; // kvList 升序,最后一行最新
        try {
          const lv = JSON.parse(String(latest.value));
          if (lv && JSON.stringify(lv.persona || null) === JSON.stringify(p) &&
              JSON.stringify(lv.styles || null) === JSON.stringify(s.styles || {})) {
            return null; // 内容无变化(连点保存等),不重复留档
          }
        } catch {}
      }
      const histKey = `persona.hist.${at}`;
      await memory.kvSet(histKey, JSON.stringify({ persona: p, styles: s.styles || {}, kind }));
      await memory.kvSet(`persona.log.${at}`, JSON.stringify({
        at, kind,
        keys: Object.keys(p),
        sample: JSON.stringify(p).slice(0, 60),
      }));
      const hists = memory.kvList('persona.hist.').map((r) => String(r.key)).sort();
      const logs = memory.kvList('persona.log.').map((r) => String(r.key)).sort();
      while (hists.length > 30) {
        const victim = hists.shift();
        await memory.kvDel(victim);
      }
      while (logs.length > 30) {
        const victim = logs.shift();
        await memory.kvDel(victim);
      }
      return histKey;
    };

    /** GET 参数预览覆写:合成一份临时 settings(不落盘)供 L0 实时预览。 */
    const previewOverrides = (q) => {
      if (!q) return null;
      const pp = q.get('previewPersona');
      const ps = q.get('previewStyles');
      if (!pp && !ps) return null;
      const tmp = structuredClone(settings.get());
      if (pp) {
        try {
          const patch = JSON.parse(pp);
          if (patch && typeof patch === 'object') tmp.persona = { ...(tmp.persona || {}), ...patch };
        } catch {}
      }
      if (ps) {
        try {
          const patch = JSON.parse(ps);
          if (patch && typeof patch === 'object') tmp.styles = { ...(tmp.styles || {}), ...patch };
        } catch {}
      }
      return tmp;
    };

    const stateForGlobal = (q) => {
      const base = settings.get();
      const tmp = previewOverrides(q) || base;
      const mode = base.mode?.lastMode === 'work' ? 'work' : 'life';
      const all = memory.listOverviews({ onlyOk: true });
      const wantPreview = q && q.get('l0Preview') === '1';
      return {
        ok: true,
        plugin: 'dsh-ling',
        sessionId: null,
        scope: 'global',
        mode,
        modeLabel: MODE_LABEL[mode],
        running: false,
        pending: 0,
        snapshot: null,
        l0PreviewText: wantPreview ? l0WithClock(tmp, mode) : undefined,
        persona: personaInfo(base),
        modeMapping: base.mode?.mapping ?? {},
        lastMode: mode,
        memory: {
          overviews: all.length,
          rawTurnSessions: rawTurnSessionCount(memory),
          fingerprint: memory.fingerprint(),
        },
        updates: base.updates ?? {},
      };
    };

    const stateFor = (sessionId, { l0Preview = false, q } = {}) => {
      const base = settings.get();
      const tmp = q ? (previewOverrides(q) || base) : base;
      const mode = currentMode(memory, settings, sessionId);
      const snap = gate.snapshotOf(sessionId);
      const all = memory.listOverviews({ onlyOk: true });
      const l1 = base.memory?.l1Enabled === false ? null : selectL1(memory, {
        mode,
        sessionId, // D9-a 血缘加权:按该会话所属枝给记忆定档
        categoryWeights: base.memory?.categoryWeights,
        maxItems: base.memory?.l1MaxItems,
        budgetChars: Math.max(200, Math.round((base.memory?.l1BudgetTokens ?? 1200) * 1.4)),
      });
      return {
        ok: true,
        plugin: 'dsh-ling',
        sessionId,
        mode,
        modeLabel: MODE_LABEL[mode] ?? mode,
        running: gate.isRunning(sessionId),
        pending: gate.pendingCount(sessionId),
        snapshot: snap
          ? { exists: true, builtAt: snap.builtAt ?? null, mode: snap.mode ?? null, stale: !!snap.stale, chars: (snap.text || '').length }
          : { exists: false },
        idleRefresh: refreshStats(memory, sessionId), // B:空闲边界刷新留痕(次数 + 最近时间)
        l0PreviewText: l0Preview ? l0WithClock(tmp, mode) : undefined,
        persona: personaInfo(base),
        modeMapping: base.mode?.mapping ?? {},
        lastMode: base.mode?.lastMode ?? 'life',
        memory: {
          overviews: all.length,
          rawTurnSessions: rawTurnSessionCount(memory),
          fingerprint: memory.fingerprint(),
          l1: l1 ? {
            items: l1.items.map((i) => ({
              conv_id: i.conv_id, title: i.title, date: isoDate(i.updated_at || i.started_at),
              category: i.category, score: i.score, line: i.line,
            })),
            totalChars: l1.totalChars,
            dropped: l1.dropped,
          } : null,
        },
        updates: base.updates ?? {},
      };
    };

    // GET /health
    disposers.push(register('/health', async (_req, res) => {
      sendJson(res, 200, { ok: true, plugin: 'dsh-ling', version: config.version });
    }));

    // ---- 记忆中心 ----
    const memSourceOf = (v) => (MEM_SOURCES.includes(String(v)) ? String(v) : '');

    // GET /memories/sources —— 各来源条数(D8:筛选栏显示「历史网页端 (1523)」,一眼看到库里有什么)
    //                        + 各枝条数(D9-a 记忆分枝:枝名与计数一次带回,省一个往返)
    disposers.push(register('/memories/sources', async (req, res) => {
      const bc = memory.branchCounts();
      const byId = new Map(memory.listBranches().map((b) => [b.id, b]));
      const list = Object.keys(bc.byBranch || {}).map((id) => {
        const b = byId.get(id) || {};
        return {
          id,
          name: String(b.name || (id === TRUNK_ID ? '主干' : id)),
          kind: String(b.kind || (id === TRUNK_ID ? 'trunk' : 'branch')),
          memories: Number(bc.byBranch[id] || 0),
        };
      });
      list.sort((a, b) => (a.id === TRUNK_ID ? -1 : b.id === TRUNK_ID ? 1 : b.memories - a.memories));
      sendJson(res, 200, {
        ok: true,
        ...memory.sourceCounts(),
        trunk: TRUNK_ID,
        branch: { total: bc.total, byBranch: bc.byBranch, list },
      });
    }));

    // GET /branches —— 枝列表(记忆分枝 D9-a,只读):每条枝带自己的会话数与记忆数。
    //   主干恒在列表首位;枝按建立时间排。界面用它渲染「枝」下拉与枝名标记。
    disposers.push(register('/branches', async (req, res) => {
      const counts = memory.branchCounts().byBranch || {};
      const sess = memory.sessionBranchMap();
      const sessCount = {};
      for (const bid of sess.values()) sessCount[bid] = (sessCount[bid] || 0) + 1;
      const list = memory.listBranches().map((b) => ({
        ...b,
        memories: Number(counts[b.id] || 0),
        sessions: Number(sessCount[b.id] || 0),
      }));
      list.sort((a, b) => (a.id === TRUNK_ID ? -1 : b.id === TRUNK_ID ? 1 : String(a.createdAt || '').localeCompare(String(b.createdAt || ''))));
      sendJson(res, 200, { ok: true, trunk: TRUNK_ID, branches: list });
    }));

    // ---- 记忆树:复盘驱动的树操作(D9-b,2026-09-19) ----
    //
    // 全部操作**不改写任何记忆内容**(设计稿 §4 核心不变量):分枝/并脉/连边只增加"关系"。
    // 复盘界面用 /tree 一次拿全量结构,用下面几个 POST 落地主人与器灵的归类决定。

    const treeCounts = () => {
      const bc = memory.branchCounts();
      const byBranch = bc.byBranch || {};
      const sess = memory.sessionBranchMap();
      const sessCount = {};
      for (const bid of sess.values()) sessCount[bid] = (sessCount[bid] || 0) + 1;
      return { total: bc.total, byBranch, sessCount };
    };
    const treeNode = (n, byBranch, sessCount) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      parentId: n.parentId,
      forkAt: n.forkAt,
      nameLocked: n.nameLocked,
      weightScale: n.weightScale,
      visibility: n.visibility,
      status: n.status,
      createdAt: n.createdAt,
      memories: Number(byBranch[n.id] || 0),
      sessions: Number(sessCount[n.id] || 0),
      children: (n.children || []).map((c) => treeNode(c, byBranch, sessCount)),
    });

    // GET /tree —— 整树(枝/主脉嵌套 + 横向连边 + 计数),复盘界面一次渲染
    disposers.push(register('/tree', async (_req, res) => {
      const t = memory.branchTree();
      const { byBranch, sessCount, total } = treeCounts();
      sendJson(res, 200, {
        ok: true,
        trunk: TRUNK_ID,
        total,
        memories: Number(total || 0),
        roots: (t.roots || []).map((n) => treeNode(n, byBranch, sessCount)),
        links: t.links || [],
      });
    }));

    // POST /branches/create { name, kind, parentId } —— 手建枝或主脉(kind='vein')
    disposers.push(register('/branches/create', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const kind = String(body.kind || 'branch');
      if (kind !== 'branch' && kind !== 'vein') return sendJson(res, 400, { ok: false, reason: 'bad-kind' });
      const parentId = String(body.parentId || TRUNK_ID);
      if (!memory.listBranches().some((b) => b.id === parentId)) return sendJson(res, 400, { ok: false, reason: 'no-parent' });
      const name = String(body.name || '').trim().slice(0, 80);
      const id = kind === 'vein'
        ? memory.createVein({ name, parentId })
        : memory.createBranch({ name, kind: 'branch', parentId });
      sendJson(res, 200, { ok: true, id, kind, name, parentId });
    }));

    // POST /branches/reparent { id, parentId, name } —— **并脉**:把枝/主干挂到主脉下(内容零变化)
    //   新主脉可当场建(name 非空且 parentId 尚不存在时先建 vein)。
    disposers.push(register('/branches/reparent', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const id = String(body.id || '');
      if (!id) return sendJson(res, 400, { ok: false, reason: 'bad-id' });
      let parentId = String(body.parentId || '');
      if (parentId && !memory.listBranches().some((b) => b.id === parentId)) {
        if (String(body.createVein || '') === '1' || body.name) {
          parentId = memory.createVein({ name: String(body.name || '新主脉').slice(0, 80), parentId: String(body.veinParent || TRUNK_ID) });
        } else {
          return sendJson(res, 400, { ok: false, reason: 'no-parent' });
        }
      }
      const beforeRow = memory.listBranches().find((b) => b.id === id) || null;
      const r = memory.reparentBranch(id, parentId);
      if (r.ok) memory.logBranch(id, 'reparent', {
        before: (beforeRow && beforeRow.parentId) || '',
        after: String(parentId || ''),
        note: String(body.note || ''),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // POST /branches/rename { id, name, lock }
    disposers.push(register('/branches/rename', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return sendJson(res, 400, { ok: false, reason: 'empty-name' });
      const beforeRow = memory.listBranches().find((b) => b.id === String(body.id || '')) || null;
      const r = memory.renameBranch(String(body.id || ''), name, { lock: body.lock !== false });
      if (r.ok) memory.logBranch(String(body.id || ''), 'rename', {
        before: (beforeRow && beforeRow.name) || '',
        after: name,
        note: String(body.note || ''),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // POST /branches/weight { id, weightScale } —— 复盘时调枝系数(平时只读,设计稿 §3.3)
    disposers.push(register('/branches/weight', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const beforeRow = memory.listBranches().find((b) => b.id === String(body.id || '')) || null;
      const r = memory.setBranchWeight(String(body.id || ''), body.weightScale);
      if (r.ok) memory.logBranch(String(body.id || ''), 'weight', {
        before: String((beforeRow && beforeRow.weightScale) ?? ''),
        after: String(r.weightScale),
        note: String(body.note || ''),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // GET /branch-log?limit=N —— 复盘留痕(改了什么、为什么;只记结构操作,不记记忆内容)
    disposers.push(register('/branch-log', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const names = new Map(memory.listBranches().map((b) => [b.id, b.name || b.id]));
      const list = memory.listBranchLog({ limit: q.get('limit') || 100 })
        .map((e) => ({ ...e, branchName: names.get(e.branchId) || e.branchId }));
      sendJson(res, 200, { ok: true, total: list.length, log: list });
    }));

    // POST /veins/link { from, to, kind, note } / POST /veins/unlink { from, to }
    disposers.push(register('/veins/link', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = memory.linkVeins(String(body.from || ''), String(body.to || ''), {
        kind: String(body.kind || 'related'),
        note: String(body.note || '').slice(0, 300),
      });
      if (r.ok) memory.logBranch(String(body.from || ''), 'link', {
        before: '', after: String(body.to || ''), note: String(body.kind || 'related'),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));
    disposers.push(register('/veins/unlink', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = memory.unlinkVein(String(body.from || ''), String(body.to || ''));
      if (r.ok) memory.logBranch(String(body.from || ''), 'unlink', {
        before: String(body.to || ''), after: '', note: '',
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // ---- 矛盾标记层(D9-b):检出但**不改写内容**;未复盘 → 以最新为准 ----

    // GET /conflicts?status=pending|confirmed|dismissed —— 待复盘矛盾(带两侧标题,复盘界面直接可读)
    disposers.push(register('/conflicts', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      // 2026-09-21:补两侧**摘要全文** —— 只给标题时人根本判不出"到底哪矛盾"(用户实测反馈)。
      const ovOf = (src, cid) => {
        try { return memory.overviewById(String(src), String(cid)) || null; } catch { return null; }
      };
      // 2026-09-21:涉及归档会话的矛盾不进列表 —— 归档意味着"这条别再提了",
      //   但已登记的旧记录不会自动消失,所以在这里按当前归档状态实时筛(用户实测反馈:
      //   扫描侧上一轮已排除归档,可已存在的记录仍会一直显示)。
      const archSet = memory.archivedConvIdSet();
      const isArch = (side) => side && side.source === 'dsh' && archSet.has(String(side.convId));
      const list = memory.listConflicts({ status: q.get('status') || '', limit: q.get('limit') || 100 })
        .filter((c) => !isArch(c.a) && !isArch(c.b))
        .map((c) => {
          const oa = ovOf(c.a.source, c.a.convId);
          const ob = ovOf(c.b.source, c.b.convId);
          return {
            ...c,
            aTitle: (oa && oa.title) || memory.overviewTitleOf(c.a.convId) || c.a.convId,
            bTitle: (ob && ob.title) || memory.overviewTitleOf(c.b.convId) || c.b.convId,
            aSummary: String((oa && oa.summary) || ''),
            bSummary: String((ob && ob.summary) || ''),
          };
        });
      sendJson(res, 200, { ok: true, total: list.length, conflicts: list });
    }));

    // POST /conflicts/record { a:{source,conv_id}, b:{...}, kind, reason } —— 手工/LLM 检出登记
    disposers.push(register('/conflicts/record', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const a = body.a || {};
      const b = body.b || {};
      const r = memory.recordConflict({
        aSource: a.source, aConvId: a.conv_id || a.convId,
        bSource: b.source, bConvId: b.conv_id || b.convId,
        kind: String(body.kind || 'contradict'),
        detectedBy: String(body.detectedBy || 'user'),
        reason: String(body.reason || ''),
      });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // ---- 一键生成记忆树(D9-b,2026-09-21 与用户定案) ----
    //   两阶段:① 机械分段(零成本、只读) ② 小助手命名 ③ 主人审核后落库。
    //   不变量:不改写任何记忆内容 —— 只建枝/主脉 + 挂会话归属。
    const autoSeg = (gapDays, maxSize) => bucketize(memory.overviewIndex(), { gapDays, maxSize });

    // GET /tree/autobuild/preview?gapDays=14&maxSize=40 —— 机械分段(只读,不调模型)
    disposers.push(register('/tree/autobuild/preview', async (req, res) => {
      const u = new URL(String(req.url || '/'), 'http://x');
      const gapDays = Math.max(1, Math.min(365, Number(u.searchParams.get('gapDays')) || 14));
      const maxSize = Math.max(5, Math.min(200, Number(u.searchParams.get('maxSize')) || 40));
      const buckets = autoSeg(gapDays, maxSize);
      const bySource = {};
      for (const b of buckets) bySource[b.source] = (bySource[b.source] || 0) + 1;
      sendJson(res, 200, {
        ok: true,
        gapDays,
        maxSize,
        total: buckets.length,
        bySource,
        buckets: buckets.map((b) => ({
          id: b.id, source: b.source, count: b.count, from: b.from, to: b.to,
          sample: b.items.slice(0, 16).map((it) => it.title || it.convId),
        })),
      });
    }));

    // POST /tree/autobuild/name { bucketIds?, gapDays?, maxSize?, limit? } —— 给指定簇起名(批量,每次 limit 个)
    disposers.push(register('/tree/autobuild/name', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const gapDays = Math.max(1, Math.min(365, Number(body.gapDays) || 14));
      const maxSize = Math.max(5, Math.min(200, Number(body.maxSize) || 40));
      const limit = Math.max(1, Math.min(20, Number(body.limit) || 5));
      const asst = resolveAssistant(settings);
      const probe = await probeAssistant(asst.baseUrl, { timeoutMs: 5000 });
      if (!probe.ok) {
        return sendJson(res, 200, { ok: false, reason: 'assistant-unavailable', hint: '命名需要模型;地址可在「接入历史」里配置' });
      }
      const all = autoSeg(gapDays, maxSize);
      const want = Array.isArray(body.bucketIds) && body.bucketIds.length
        ? new Set(body.bucketIds.map((x) => String(x))) : null;
      const targets = (want ? all.filter((b) => want.has(b.id)) : all).slice(0, limit);
      // 并发命名:小助手单条命名可能要 10~20 秒,串行 5 条会超过浏览器/网关的容忍时间而被断开
      // (前端表现为 fetch reject → "命名失败(网关)")。并发把总耗时压到 ≈ 最慢的那一条。
      const t0 = Date.now();
      const out = await Promise.all(targets.map(async (b) => {
        const r = await nameBucket(asst.baseUrl, asst.model, b, { call: summarizeWithRetry });
        return {
          bucketId: b.id, source: b.source, count: b.count, from: b.from, to: b.to,
          ok: !!r.ok, name: r.name || '', note: r.note || '', error: r.error || null,
        };
      }));
      sendJson(res, 200, {
        ok: true,
        named: out.filter((x) => x.ok).length,
        failed: out.filter((x) => !x.ok).length,
        engine: String((asst && asst.model) || ''),
        ms: Date.now() - t0,
        items: out,
      });
    }));

    // POST /tree/autobuild/apply { plan:[{bucketId,mode:'branch'|'vein',name,parentId}] } —— 落库(只建结构)
    disposers.push(register('/tree/autobuild/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const gapDays = Math.max(1, Math.min(365, Number(body.gapDays) || 14));
      const maxSize = Math.max(5, Math.min(200, Number(body.maxSize) || 40));
      const plan = Array.isArray(body.plan) ? body.plan.slice(0, 200) : [];
      if (!plan.length) return sendJson(res, 200, { ok: false, reason: 'empty-plan' });
      const byId = new Map(autoSeg(gapDays, maxSize).map((b) => [b.id, b]));
      const created = [];
      let assigned = 0;
      let skipped = 0;
      // 零散合簇(用户 2026-09-21 裁决):名字含「零散」的簇统一挂到同一个主脉「零散会话」下。
      //   理由:历史网页端的一次性问答主题天然分散、不属于任何工作线;合并成一簇后可在
      //   复盘时展开细化(设计稿 §10.3)。主脉按名复用,不重复建。
      const ZERO_NAME = '零散会话';
      let zeroVeinId = null;
      const zeroVeinOf = () => {
        if (zeroVeinId) return zeroVeinId;
        const exist = memory.listBranches().find((x) => x.kind === 'vein' && x.name === ZERO_NAME);
        zeroVeinId = exist ? exist.id : memory.createVein({ name: ZERO_NAME });
        if (!exist) memory.logBranch(zeroVeinId, 'autobuild', { after: ZERO_NAME, note: '零散会话合簇(自动创建)' });
        return zeroVeinId;
      };
      for (const p of plan) {
        const b = byId.get(String(p.bucketId || ''));
        const name = String(p.name || '').trim().slice(0, 60);
        if (!b || !name) { skipped += 1; continue; }
        const parentId = (/零散/.test(name) && !p.parentId) ? zeroVeinOf() : String(p.parentId || TRUNK_ID);
        const mode = String(p.mode || 'branch');
        const bid = mode === 'vein'
          ? memory.createVein({ name, parentId })
          : memory.createBranch({ name, parentId, kind: 'branch' });
        // 归属两条链(方案 A,2026-09-21):
        //   dsh 会话 → session_meta(D9-a 既有链路,零变化);
        //   其余源(dsweb/import)→ conv_branch 覆盖层 —— 它们不是 DSH 会话,推不出枝。
        let n = 0;
        for (const it of b.items) {
          if (it.source === 'dsh') memory.setSessionBranch(it.convId, bid);
          else memory.setConvBranch(it.source, it.convId, bid);
          n += 1;
          assigned += 1;
        }
        memory.logBranch(bid, 'autobuild', { after: name, note: '一键生成:' + b.source + ' ' + b.count + ' 条(挂上 ' + n + ')' });
        created.push({ id: bid, name, mode, parentId, source: b.source, count: b.count, assigned: n });
      }
      sendJson(res, 200, {
        ok: true,
        created,
        assigned,
        skipped,
        zeroVein: zeroVeinId,
        note: '归属已写入 ' + assigned + ' 条(DSH 会话走 session_meta,历史网页端/导入条目走 conv_branch 覆盖层)'
          + (zeroVeinId ? ';零散簇已合并到主脉「' + ZERO_NAME + '」' : ''),
      });
    }));

    // POST /branches/gather { pattern='零散', veinName='零散会话' }
    //   —— 把**已存在**的枝按名字归并到同一个主脉下(幂等,可重复跑)。
    //   为什么需要它:一键生成树在旧逻辑下已经建出多个「零散记录」枝,`/tree/autobuild/apply`
    //   的合簇只对**新应用**生效,追不回存量;本端点负责把存量收进主脉。
    //   同时它也是复盘期的批量归类原语:把名字含某关键词的枝一次归到一个主脉。
    disposers.push(register('/branches/gather', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const pattern = String(body.pattern || '零散').trim().slice(0, 30);
      const veinName = String(body.veinName || '零散会话').trim().slice(0, 60);
      if (!pattern) return sendJson(res, 200, { ok: false, reason: 'empty-pattern' });
      const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc);
      let vein = memory.listBranches().find((x) => x.kind === 'vein' && x.name === veinName);
      let veinCreated = false;
      if (!vein) {
        const vid = memory.createVein({ name: veinName });
        memory.logBranch(vid, 'gather', { after: veinName, note: '归并目标主脉(自动创建)' });
        vein = { id: vid, name: veinName };
        veinCreated = true;
      }
      const moved = [];
      for (const b of memory.listBranches()) {
        if (b.id === vein.id || b.kind === 'vein') continue;
        if (!re.test(String(b.name || ''))) continue;
        if (String(b.parentId || '') === String(vein.id)) continue; // 已就位,幂等跳过
        const r = memory.reparentBranch(b.id, vein.id);
        if (r && r.ok) {
          memory.logBranch(b.id, 'gather', {
            before: String(b.parentId || 'trunk'),
            after: String(vein.id),
            note: '归并到主脉「' + veinName + '」(匹配 ' + pattern + ')',
          });
          moved.push({ id: b.id, name: String(b.name || '') });
        }
      }
      sendJson(res, 200, {
        ok: true, vein: vein.id, veinName, veinCreated,
        moved: moved.length, movedList: moved.slice(0, 60),
        note: moved.length ? ('已把 ' + moved.length + ' 条含「' + pattern + '」的枝归并到主脉「' + veinName + '」')
          : (veinCreated ? ('已建主脉「' + veinName + '」,但没有匹配的枝') : '没有需要归并的枝(已就位)'),
      });
    }));

    // ---- 树的保存 / 恢复(R1,2026-09-22)+ 会话级展开(R2) ----

    /** 从 req.url 取查询参数(不依赖 URL 类,与既有 GET 端点同风格)。 */
    const qArg = (url, key) => {
      const m = new RegExp('[?&]' + key + '=([^&]*)').exec(String(url || ''));
      return m ? decodeURIComponent(m[1]) : '';
    };

    // GET /tree/snapshots?limit=N —— 快照列表(不带快照体 —— 体可能很大)
    disposers.push(register('/tree/snapshots', async (req, res) => {
      const limit = Number(qArg(req.url, 'limit') || 50);
      sendJson(res, 200, { ok: true, snapshots: memory.listTreeSnapshots({ limit }) });
    }));

    // POST /tree/snapshot { name, note } —— 存一份当前树结构(只存结构,不存记忆内容)
    disposers.push(register('/tree/snapshot', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = memory.snapshotTree({ name: body.name, note: body.note });
      if (r.ok) memory.logBranch(TRUNK_ID, 'snapshot', { after: String(body.name || ('#' + r.id)), note: '手动保存树快照' });
      sendJson(res, 200, r);
    }));

    // POST /tree/restore { id } —— 恢复树结构;恢复前**自动存一份当前状态**(返回 backupId)
    disposers.push(register('/tree/restore', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, memory.restoreTree(body.id));
    }));

    // POST /tree/snapshot/delete { id }
    disposers.push(register('/tree/snapshot/delete', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, memory.deleteTreeSnapshot(body.id));
    }));

    // GET /branch/members?id=<branchId>&limit=N —— 会话级展开(R2):该枝下的会话/条目
    disposers.push(register('/branch/members', async (req, res) => {
      const id = String(qArg(req.url, 'id') || TRUNK_ID);
      const limit = Number(qArg(req.url, 'limit') || 300);
      const members = memory.branchMembers(id, { limit });
      sendJson(res, 200, { ok: true, id, count: members.length, members });
    }));

    // POST /branch/assign { source, convId, branchId } —— 拖动会话/条目改归属(R2/R3)
    disposers.push(register('/branch/assign', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = memory.assignConv(body.source, body.convId, body.branchId);
      if (r.ok) {
        memory.logBranch(String(body.branchId || TRUNK_ID), 'assign', {
          before: String(r.prev || ''),
          after: String(body.source || '') + '/' + String(body.convId || ''),
          note: '把一条' + (String(body.source) === 'dsh' ? '会话' : '历史条目') + '挪到本枝',
        });
      }
      sendJson(res, 200, r);
    }));

    // POST /conflicts/resolve { id, winner:'a'|'b'|null, status:'confirmed'|'dismissed' }
    disposers.push(register('/conflicts/resolve', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = memory.resolveConflict(body.id, { winner: body.winner ?? null, status: String(body.status || 'confirmed') });
      sendJson(res, r.ok ? 200 : 400, r);
    }));

    // POST /conflicts/judge { limit } —— **复盘环节**:让模型读两侧摘要全文,判定这条候选到底是什么。
    //   启发式(2-gram)只能找"措辞重复";判"同题反结论"必须读懂意思 ⇒ 这一步只能交给模型。
    //   分批(默认 5 条,上限 20),前端循环调用并显示进度 —— 避免一个长任务把 HTTP 连接拖死。
    //   unrelated → 直接驳回(清洗假阳性);duplicate / contradict → 回写性质,留给主人裁定。
    const JUDGE_SYS = '你在帮主人整理长期记忆。下面给你两条记忆的摘要(A 和 B)。'
      + '请判断它们的关系,只回一个词:\n'
      + '- unrelated:讲的是不同的事(哪怕用词相近)\n'
      + '- duplicate:讲的是同一件事\n'
      + '- contradict:讲的是同一件事但结论相反\n'
      + '只回那一个词,不要解释,不要标点。';
    const parseVerdict = (s) => {
      const t = String(s || '').toLowerCase();
      if (t.includes('contradict')) return 'contradict';
      if (t.includes('duplicate')) return 'duplicate';
      if (t.includes('unrelated')) return 'unrelated';
      return 'unknown';
    };
    disposers.push(register('/conflicts/judge', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const limit = Math.max(1, Math.min(20, Number(body.limit) || 5));
      const asst = resolveAssistant(settings);
      const probe = await probeAssistant(asst.baseUrl, { timeoutMs: 5000 });
      if (!probe.ok) return sendJson(res, 200, { ok: false, reason: 'assistant-unavailable', hint: '小助手不可用时可跳过模型判定,直接人工裁定' });
      const pend = memory.listConflicts({ status: 'pending', limit: 200 });
      const done = [];
      let left = 0;
      for (const c of pend) {
        if (done.filter((d) => !d.skip).length >= limit) { left += 1; continue; }
        const pickOv = (src, cid) => { try { return memory.overviewById(String(src), String(cid)) || null; } catch { return null; } };
        const oa = pickOv(c.a.source, c.a.convId);
        const ob = pickOv(c.b.source, c.b.convId);
        const ta = String((oa && oa.summary) || '').trim().slice(0, 700);
        const tb = String((ob && ob.summary) || '').trim().slice(0, 700);
        if (!ta || !tb) { done.push({ id: c.id, skip: 'no-summary' }); continue; }
        let verdict = 'unknown';
        let why = '';
        try {
          const r = await summarizeWithRetry(asst.baseUrl, asst.model, {
            text: 'A:\n' + ta + '\n\nB:\n' + tb,
            system: JUDGE_SYS,
          });
          verdict = parseVerdict(r && r.summary);
          why = String((r && r.summary) || '').slice(0, 200);
        } catch (e) {
          verdict = 'unknown';
          why = String(e?.message ?? e).slice(0, 120);
        }
        // 保守:只对明确判定动作,unknown 一律不动(宁可留给人工,也不误驳回)。
        if (verdict === 'unrelated') memory.resolveConflict(c.id, { status: 'dismissed' });
        else if (verdict === 'duplicate' || verdict === 'contradict') {
          memory.setConflictKind(c.id, { kind: verdict, detectedBy: 'llm', reason: why });
        }
        done.push({ id: c.id, verdict });
      }
      sendJson(res, 200, {
        ok: true,
        judged: done.filter((d) => !d.skip).length,
        skipped: done.filter((d) => d.skip).length,
        left,
        engine: String((asst && asst.model) || ''),
        items: done,
      });
    }));

    // POST /conflicts/scan { limit, threshold } —— 启发式检出**重复**(duplicate)
    //   范围刻意收窄:只扫最近的 dsh/import 概述(不含 dsweb 海量短会话),两两比 2-gram Jaccard。
    //   语义矛盾(反结论)检出需要 LLM 判读,不在本端点假装能做 —— 它产出的是待复盘候选。
    disposers.push(register('/conflicts/scan', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const limit = Math.max(10, Math.min(200, Number(body.limit) || 60));
      const threshold = Math.max(0.3, Math.min(0.95, Number(body.threshold) || 0.55));
      // 2026-09-21:排除**已归档**会话 —— 封存的对话不该再被拉出来互相判矛盾(用户实测反馈)。
      const archived = memory.archivedConvIdSet();
      const rows = memory.queryOverviews({ limit }).items
        .filter((r) => r.source === 'dsh' || r.source === 'import')
        .filter((r) => !archived.has(String(r.conv_id)))
        .filter((r) => String(r.summary || '').trim().length >= 20);
      const grams = (s) => {
        const t = String(s).replace(/[\s\p{P}]+/gu, '');
        const g = new Set();
        for (let i = 0; i + 2 <= t.length; i++) g.add(t.slice(i, i + 2));
        return g;
      };
      const sets = rows.map((r) => grams(r.summary));
      const found = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const A = sets[i]; const B = sets[j];
          if (!A.size || !B.size) continue;
          let inter = 0;
          for (const g of A) if (B.has(g)) inter++;
          const jac = inter / (A.size + B.size - inter);
          if (jac >= threshold) {
            const rec = memory.recordConflict({
              aSource: rows[i].source, aConvId: rows[i].conv_id,
              bSource: rows[j].source, bConvId: rows[j].conv_id,
              kind: 'duplicate', detectedBy: 'heuristic',
              score: Number(jac.toFixed(3)),
              reason: `2-gram Jaccard ${jac.toFixed(3)} ≥ ${threshold}`,
            });
            found.push({ a: rows[i].conv_id, b: rows[j].conv_id, score: Number(jac.toFixed(3)), id: rec.id, reopened: !!rec.reopened });
          }
        }
      }
      sendJson(res, 200, { ok: true, scanned: rows.length, threshold, found: found.length, pairs: found.slice(0, 50) });
    }));

    // GET /memories?source=&category=&q=&sort=&limit=&offset=
    disposers.push(register('/memories', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const r = memory.queryOverviews({
        source: q.get('source') || undefined,
        category: q.get('category') || undefined,
        q: q.get('q') || undefined,
        sort: q.get('sort') || 'updated',
        branch: q.get('branch') || undefined,
        limit: q.get('limit') || undefined,
        offset: q.get('offset') || undefined,
      });
      sendJson(res, 200, { ok: true, ...r });
    }));

    // POST /memories/pin { source, conv_id, pin }
    disposers.push(register('/memories/pin', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      if (!memory.overviewById(src, body.conv_id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
      memory.setImportance(src, body.conv_id, body.pin === false ? 0 : 1);
      sendJson(res, 200, { ok: true, source: src, conv_id: body.conv_id, pinned: body.pin !== false });
    }));

    // POST /memories/delete { source, conv_id }
    disposers.push(register('/memories/delete', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      const existed = !!memory.overviewById(src, body.conv_id);
      if (existed) memory.deleteOverview(src, body.conv_id);
      sendJson(res, 200, { ok: true, existed });
    }));

    // POST /memories/rename { source, conv_id, title, lock? }
    // 主人手改标题(D2):默认上锁(title_locked=1) —— 概述器重建、批量重命名此后都不再覆盖。
    disposers.push(register('/memories/rename', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      if (!memory.overviewById(src, body.conv_id)) return sendJson(res, 404, { ok: false, error: 'not-found' });
      const r = memory.renameTitle(src, body.conv_id, body.title, { lock: body.lock !== false });
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.reason || 'rename-failed' });
      touchMemoryVersion(memory);
      sendJson(res, 200, { ok: true, source: src, conv_id: body.conv_id, title: r.title, locked: r.locked });
    }));

    // POST /memories/retitle { source, conv_id, baseUrl?, model?, heuristic? }
    // 用小助手给一条记忆起名(D2)。**机器起的名字同样上锁** —— 2026-09-17 实测教训:
    // 不上锁时,跑在旧代码里的概述器一轮增量重建就把 AI 起的名字覆盖回"首句硬截 46 字"的半句。
    // 已上锁的行**允许**再次起名(用户点按钮=显式意图),结果仍是"定过的名字"。
    disposers.push(register('/memories/retitle', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const src = memSourceOf(body.source);
      if (!src) return sendJson(res, 400, { ok: false, error: 'bad-source' });
      if (!body.conv_id) return sendJson(res, 400, { ok: false, error: 'conv_id required' });
      const ov = memory.overviewById(src, body.conv_id);
      if (!ov) return sendJson(res, 404, { ok: false, error: 'not-found' });
      const t0 = Date.now();
      // heuristic:true 走纯启发式(不调模型) —— 小助手不可用时的兜底,也是测试用的稳定路径
      if (body.heuristic === true) {
        const h = heuristicRetitle(memory, { source: src, conv_id: body.conv_id });
        if (h.ok) {
          memory.renameTitle(src, body.conv_id, h.title, { lock: true, by: 'ai' });
          touchMemoryVersion(memory);
        }
        return sendJson(res, h.ok ? 200 : 502, {
          ok: h.ok, source: src, conv_id: body.conv_id, title: h.title || '',
          engine: 'heuristic', error: h.error || null, ms: Date.now() - t0,
        });
      }
      // 引擎(D2/S7):默认 auto —— 优先本机小助手(零成本),探测不到才落全局大模型;
      // 实际用了哪个写回响应(engine/note),不做"静默换引擎"。
      const want = body.engine === 'global' ? 'global' : body.engine === 'assistant' ? 'assistant' : 'auto';
      const asst = resolveAssistant(settings);   // S7:settings → 环境变量 → 内置默认(loopback)
      let engine = want;
      let note = '';
      if (want === 'auto') {
        const probe = await probeAssistant(String(body.baseUrl || asst.baseUrl));
        engine = probe.ok ? 'assistant' : 'global';
        note = probe.ok ? '' : '本机小助手不可用(' + probe.reason + ' @ ' + asst.baseUrl + ') → 本次改用当前全局大模型';
      }
      const r = engine === 'global'
        ? await retitleOneGlobal(ctx, { memory, source: src, conv_id: body.conv_id })
        : await retitleOne(String(body.baseUrl || asst.baseUrl), String(body.model || asst.model), {
          memory, source: src, conv_id: body.conv_id,
        });
      if (r.ok) touchMemoryVersion(memory);
      sendJson(res, r.ok ? 200 : 502, {
        ok: r.ok, source: src, conv_id: body.conv_id, title: r.title || '',
        engine, from: r.source || engine, note: note || undefined,
        error: r.error || null, ms: r.ms || (Date.now() - t0),
      });
    }));

    // ---- S7(2026-09-18 与用户定):小助手(本机小模型)地址 —— 三级覆盖 ----
    // 一个路径按 method 分派(平台的 exact 路由表不允许同 path 注册两次):
    //   GET  /assistant/config → 生效值 + **来源**(settings/env/default) + 各级候选值(不做网络探测,秒回)
    //   POST /assistant/config { baseUrl?, model?, clear? } → 只写这两个键(不开放任意设置写入)
    // 真实探测在 /assistant/test。
    disposers.push(register('/assistant/config', async (req, res) => {
      if (String(req.method || 'GET').toUpperCase() === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (body.clear === true) {
          await settings.update({ assistant: { baseUrl: '', model: '' } });
        } else {
          const patch = {};
          if (body.baseUrl !== undefined) {
            const v = String(body.baseUrl || '').trim();
            if (v && !/^https?:\/\//i.test(v)) {
              return sendJson(res, 400, {
                ok: false, error: 'bad-url',
                message: '地址需以 http:// 或 https:// 开头(留空 = 回到环境变量 / 内置默认)',
              });
            }
            patch.baseUrl = v.slice(0, 300);
          }
          if (body.model !== undefined) patch.model = String(body.model || '').trim().slice(0, 120);
          if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'nothing-to-update' });
          await settings.update({ assistant: patch });
        }
        const after = resolveAssistant(settings);
        return sendJson(res, 200, { ok: true, baseUrl: after.baseUrl, model: after.model, source: after.source });
      }
      const asst = resolveAssistant(settings);
      return sendJson(res, 200, {
        ok: true,
        baseUrl: asst.baseUrl, model: asst.model, source: asst.source,
        configured: asst.configured, env: asst.env, defaults: asst.defaults,
      });
    }));

    // POST /assistant/test { baseUrl?, model? } —— 探活(不改配置);UI 的「测试连通」用
    disposers.push(register('/assistant/test', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const asst = resolveAssistant(settings);
      const baseUrl = String(body.baseUrl || asst.baseUrl).trim();
      const probe = await probeAssistant(baseUrl, { timeoutMs: 5000 });
      sendJson(res, 200, {
        ok: probe.ok, baseUrl, model: String(body.model || asst.model),
        reason: probe.reason || null, models: probe.models || [],
        // 填错地址最常见的两种:忘了 /v1、把它当成文件夹路径 —— 按形态给不同的提示
        hint: probe.ok ? null : (String(baseUrl).includes('/v1')
          ? '确认小助手(Ollama)已启动,且该地址从本机可达 —— 要带 http:// 前缀与端口(默认 11434)。'
          : '这个地址看起来少了 /v1 结尾(Ollama 的 OpenAI 兼容端点在 /v1/models,而 /models 不存在)。'
            + '单机自用填 http://127.0.0.1:11434/v1;小助手在别的机器上就把 127.0.0.1 换成那台的 IP。'),
      });
    }));

    // POST /mode/toggle { sessionId?, mode?, defaultOnly? }
    disposers.push(register('/mode/toggle', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const wantDefault = body.defaultOnly === true;
      const sessionId = wantDefault ? null : (body.sessionId || gate.recentSessionId());
      if (!sessionId) {
        // 全局默认路径(无会话或显式 defaultOnly):
        // ① 平台默认模型(agent-default-model)→ 只同步**推理等级**;模型原样保留
        // ② 自有 lastMode(D2 跟随源)
        const cur = settings.get().mode?.lastMode === 'work' ? 'work' : 'life';
        const next = body.mode && ['work', 'life'].includes(body.mode) ? body.mode : (cur === 'work' ? 'life' : 'work');
        const cfg = resolveModeConfig(settings.get(), next); // 只含 reasoningEffort
        let warning;
        const adm = svc(ctx, 'agentDefaultModel');
        if (adm && typeof adm.saveSelection === 'function') {
          const keep = currentModelSelection(ctx); // 当前模型:原样带回,不改
          if (!keep) {
            warning = 'unknown-current-model; 默认推理等级未同步(拒绝替用户指定模型)';
            console.debug('[dsh-ling]', warning);
          } else {
            try {
              // saveSelection 需要完整选择(provider/model 必填)→ 只替换 reasoningEffort
              await adm.saveSelection({ provider: keep.provider, model: keep.model, reasoningEffort: cfg.reasoningEffort });
            } catch (e) {
              warning = 'default-model sync failed: ' + String(e?.message ?? e);
              console.debug('[dsh-ling] saveSelection warning', warning);
            }
          }
        } else {
          warning = 'agentDefaultModel unavailable; new-session effort not synced';
          console.debug('[dsh-ling]', warning);
        }
        const s2 = await settings.update({ mode: { lastMode: next } });
        // 修法 A 补完:空会话(无真人输入)语义上"跟随默认",默认变了 → 它们的快照必须失效;
        // 有内容的旧会话保持自己的模式(不动)。running 的走 stale,空闲则立即重建。
        const refreshed = [];
        for (const sid of allSnapshotSessionIds(gate)) {
          if (memory.hasUserTurns(sid)) continue;
          const r2 = invalidateSession(gate, memory, settings, sid);
          refreshed.push({ sessionId: sid, ...r2 });
        }
        return sendJson(res, 200, {
          ok: true, mode: next, applied: 'default-only', sessionId: null,
          lastMode: s2.mode.lastMode, platformDefaultSynced: !warning, warning,
          emptySessionsRefreshed: refreshed.length,
        });
      }
      const cur = currentMode(memory, settings, sessionId);
      const next = body.mode && ['work', 'life'].includes(body.mode) ? body.mode : (cur === 'work' ? 'life' : 'work');
      const r = await applyModeToSession(ctx, gate, memory, settings, sessionId, next);
      if (r.ok && !r.queued) invalidateSession(gate, memory, settings, sessionId);
      else if (r.ok && r.queued) gate.markSnapStale(sessionId); // 运行中:排队;空闲后重建会读新模式
      sendJson(res, 200, { ok: r.ok, ...r, running: gate.isRunning(sessionId) });
    }));

    // GET /state?sessionId=&scope=global&l0Preview=1&previewPersona=&previewStyles=
    disposers.push(register('/state', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      if (q.get('scope') === 'global') return sendJson(res, 200, stateForGlobal(q));
      const sessionId = reqSessionId(req.url) || gate.recentSessionId();
      if (!sessionId) return sendJson(res, 200, stateForGlobal(q));
      sendJson(res, 200, stateFor(sessionId, { l0Preview: q.get('l0Preview') === '1', q }));
    }));

    // POST /persona  字段补丁 → settings + 全局失效(按冻结门)
    // 定型门(承诺句版):sealed 后动 persona/styles 需带 unlock=定型时亲手写下的句子(哈希比对);
    //   上锁(sealed:true)需带新承诺句 → 覆盖哈希;撤锁清哈希;每次成功变更后存「结果档案」。
    disposers.push(register('/persona', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const raw = clampBottomLines(body.patch && typeof body.patch === 'object' ? body.patch : body);
      // 2026-09-17 加固④(G10):白名单收窄 —— 补丁只能落在 persona / styles 两棵子树内。
      // 此前 body 被原样深合并进 settings.json,`{"guard":{"enforce":false}}` 可持久化关停本守卫。
      const { clean: patch, dropped } = sanitizePersonaPatch(raw);
      if (dropped.length) console.warn('[dsh-ling] /persona 丢弃白名单外的字段: %s', dropped.join(', '));
      const cur = settings.get();
      const wantLock = patch.persona?.sealed === true;
      const wasSealed = cur.persona?.sealed === true;
      const doUnseal = patch.persona?.sealed === false;
      if (touchesPersona(patch)) {
        if (wantLock) {
          const k = String(body.unlock || '').trim();
          if (k.length < KEY_MIN) return sendJson(res, 200, { ok: false, reason: 'sealed', message: '上锁需先亲手写下一句 ≥' + KEY_MIN + ' 字的承诺句(明文保存,仅供解锁界面回显提醒)。' });
          patch.persona.sealPhrase = k; // 覆盖旧承诺
        } else if (wasSealed) {
          const g = sealOk(cur.persona, body.unlock);
          if (!g.pass) return sendJson(res, 200, { ok: false, reason: 'sealed', message: MSG_KEY });
          if (g.adoptKey) patch.persona.sealPhrase = g.adoptKey; // 旧档案无明文:采纳为承诺句
          if (doUnseal) patch.persona.sealPhrase = ''; // 永久撤锁 → 清句
        }
      }
      const s2 = await settings.update(patch);
      const histKey = touchesPersona(patch) ? await archivePersona(s2, 'result') : null;
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true,
        affected,
        lastMode: s2.mode?.lastMode,
        sealed: s2.persona?.sealed === true,
        hasSeal: !!s2.persona?.sealPhrase,
        bottomCapped: raw._bottomCapped === true,
        ignored: dropped.length ? dropped : undefined,
        histKey,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /persona/check { unlock }  客户端「解锁修改」先验钥(只读,不落盘)
    disposers.push(register('/persona/check', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const cur = settings.get();
      if (cur.persona?.sealed !== true) {
        return sendJson(res, 200, { ok: true, valid: true, sealed: false, message: '档案未定型' });
      }
      const g = sealOk(cur.persona, body.unlock);
      sendJson(res, 200, {
        ok: true, valid: g.pass, sealed: true, adopt: !!g.adoptKey,
        message: g.pass ? (g.adoptKey ? '旧档案无明文:这句话将被采纳为定型承诺句' : '承诺句一致') : MSG_KEY,
      });
    }));

    // GET /persona/history  人格档案存档(每次保存后的结果;回滚前另有 pre-rollback 档)
    disposers.push(register('/persona/history', async (_req, res) => {
      const items = memory.kvList('persona.hist.').map((r) => {
        const k = String(r.key);
        let v = null;
        try { v = JSON.parse(String(r.value)); } catch {}
        return { ts: Number(k.slice('persona.hist.'.length)) || null, persona: v?.persona ?? null, styles: v?.styles ?? null, kind: v?.kind || 'result' };
      }).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
      sendJson(res, 200, { ok: true, items });
    }));

    // POST /persona/self-summary { text }  自我总结成长通道(自由生长的一部分):
    //   无论是否定型,只允许更新 persona.aiTitle(定位自述)单字段;其余字段仍需手术/承诺句。
    disposers.push(register('/persona/self-summary', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text ?? '').trim();
      if (!text) return sendJson(res, 200, { ok: false, reason: 'empty', message: '内容为空' });
      if (text.length > 500) return sendJson(res, 200, { ok: false, reason: 'long', message: '自述过长(≤500 字)' });
      const cur = settings.get();
      const histKey = await archivePersona(cur, 'result');
      const s2 = await settings.update({ persona: { aiTitle: text } });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true, affected, histKey, chars: text.length,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /persona/hint-adopt { text }  诞生建议(语气建议/相处观察)采纳:
    //   属"成长回路"—— 建议中心里按下那一下 = 确认,故走「提议 → 确认」状态机落到**习惯**
    //   (习惯不能直达;这里的用户点击就是确认动作),重量前先归档。
    disposers.push(register('/persona/hint-adopt', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text ?? '').trim();
      if (text.length < 4 || text.length > 400) {
        return sendJson(res, 200, { ok: false, reason: 'bad', message: '内容需在 4~400 字之间' });
      }
      const existing = habitsOf(settings).some((h) => String(h.text).replace(/\s+/g, '') === text.replace(/\s+/g, ''));
      if (existing) {
        return sendJson(res, 200, { ok: true, exists: true, habits: habitsOf(settings).length, message: '这条已经是习惯里的了' });
      }
      const histKey = await archivePersona(settings.get(), 'result');
      const prop = await proposeHabit({ settings, habit: text, evidence: '建议中心采纳', byUser: true });
      if (!prop.ok) return sendJson(res, 200, { ok: false, reason: prop.reason, message: '未记入:' + prop.reason });
      const done = await resolveHabit({ settings, id: prop.id, action: 'confirm' });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const s2 = settings.get();
      sendJson(res, 200, {
        ok: done.ok, affected, histKey,
        habits: habitsOf(settings).length,
        warning: done.warning,
        l0PreviewText: l0WithClock(s2, s2.mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // ---- 规矩 / 习惯(2026-09-15 定稿:指令直达,人格不直达)----
    // GET /persona/rules  规矩 + 习惯 + 待确认提议(面板用)
    disposers.push(register('/persona/rules', async (_req, res) => {
      sendJson(res, 200, { ok: true, ...rulesView(settings) });
    }));

    // POST /persona/rule { action:'add'|'remove', rule, quote? }
    //   规矩直达:add 必须带原话(quote);remove 只需正文。
    disposers.push(register('/persona/rule', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const action = String(body.action || 'add');
      if (action === 'remove') {
        const r = await removeRule({ settings, rule: body.rule });
        return sendJson(res, 200, r.ok
          ? { ok: true, ...r, affected: invalidateAllSummaries() }
          : { ok: false, reason: r.reason, message: '没有这条规矩' });
      }
      if (action !== 'add') return sendJson(res, 200, { ok: false, reason: 'bad-action' });
      const r = await addRule({
        settings, rule: body.rule, quote: body.quote, sessionId: String(body.sessionId || 'panel'),
        source: body.quote ? 'session' : 'panel',   // 面板直接写入:用户自己敲的就是同意
      });
      const message = !r.ok
        ? {
          'no-quote': '规矩必须附上原话(你说的那一句)才能写入 —— 这是"经同意"的凭据。',
          'empty-rule': '规矩内容为空。',
          'too-long': `规矩太长(上限 ${RULE_MAX_CHARS} 字),请压缩成一条短句。`,
          duplicate: '已有同义规矩,未重复写入。',
        }[r.reason] || ('未写入:' + r.reason)
        : undefined;
      sendJson(res, 200, { ok: r.ok, ...r, message, affected: r.ok ? invalidateAllSummaries() : [] });
    }));

    // POST /persona/habit { action:'propose'|'confirm'|'reject'|'remove', habit?, evidence?, id? }
    //   习惯不直达:propose(任一方可提)/ confirm(对方点头)/ reject / remove。
    disposers.push(register('/persona/habit', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const action = String(body.action || 'propose');
      if (action === 'propose') {
        const r = await proposeHabit({
          settings, habit: body.habit, evidence: body.evidence, byUser: body.byUser !== false,
        });
        return sendJson(res, 200, {
          ok: r.ok, ...r,
          message: r.ok
            ? '已作为候选记下,确认后才成为习惯'
            : (r.reason === 'pending-full'
              ? `待确认的习惯已经有 ${r.pending} 条(上限 ${r.limit})—— 先处理完这些,再看新的。`
              : ('未记录:' + r.reason)),
        });
      }
      if (action === 'confirm' || action === 'reject') {
        const r = await resolveHabit({ settings, id: body.id, action });
        return sendJson(res, 200, { ok: r.ok, ...r, affected: r.ok ? invalidateAllSummaries() : [] });
      }
      if (action === 'remove') {
        // 习惯属于她:删改属"对她做手术",定型状态下需先解锁(承诺句);提议/认可/不认可仍免手术。
        const cur = settings.get();
        const gate = cur.persona?.sealed === true ? sealOk(cur.persona, body.unlock) : { pass: true, adoptKey: null };
        if (!gate.pass) {
          return sendJson(res, 200, {
            ok: false, reason: 'sealed',
            message: pronounize('习惯是她长出来的 —— 删改需走手术门:请在人格中心「🔓 对人格做手术…」解锁后再试。', pronounOf(settings.get())) + MSG_KEY,
          });
        }
        const r = await removeHabit({ settings, habit: body.habit });
        return sendJson(res, 200, { ok: r.ok, ...r, affected: r.ok ? invalidateAllSummaries() : [] });
      }
      sendJson(res, 200, { ok: false, reason: 'bad-action' });
    }));

    // POST /persona/habits/scan  通道 A:零模型,扫"跨会话重复出现的纠正"→ 落成习惯候选(待确认)
    //   阈值:同类纠正 ≥3 次 且 跨 ≥2 个会话(单次会话里被说三遍不算模式)
    disposers.push(register('/persona/habits/scan', async (_req, res) => {
      try {
        // 上限(2026-09-16 定案):待确认满了就**明确驳回**,并说明为什么 —— 不排队、不静默丢弃。
        const capS = pendingMaxOf(settings);
        const pendS = habitsPendingOf(settings).length;
        if (pendS >= capS) {
          return sendJson(res, 200, {
            ok: false, reason: 'pending-full', pending: pendS, limit: capS,
            message: `待确认的习惯已经有 ${pendS} 条(上限 ${capS})—— 先把手上的处理完(认可 / 先不要),再看新的。`,
          });
        }
        const cands = scanCorrections(memory);
        if (!cands.length) {
          return sendJson(res, 200, {
            ok: true, found: 0, proposed: 0, skipped: [],
            message: `没发现"跨会话重复"的纠正信号(阈值:同类 ≥${SCAN_DEFAULTS.minHits} 次且跨 ≥${SCAN_DEFAULTS.minSessions} 个会话)。`,
          });
        }
        const proposed = [];
        const skipped = [];
        for (const c of cands) {
          const r = await proposeHabit({ settings, habit: c.rule, evidence: evidenceOf(c), byUser: false });
          if (r.ok) proposed.push({ id: r.id, text: c.rule, hits: c.hits, sessions: c.sessions, evidence: evidenceOf(c) });
          else skipped.push({ text: c.rule, reason: r.reason, hits: c.hits });
        }
        sendJson(res, 200, {
          ok: true, found: cands.length, proposed: proposed.length, skipped, items: proposed,
          message: proposed.length
            ? `从纠正记录里长出 ${proposed.length} 条习惯候选(等你确认)`
            : '候选都已经在习惯里或待确认列表里了',
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'scan', message: '扫描失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /persona/habits/reflect  通道 B:让她"回想最近的相处" → 1~5 条习惯候选(一次 LLM,只提议不落盘)
    // 手动触发,材料给足:主人真人原话 + 记忆概述 + 纠正统计 + 她现状(默认预算 20 万字符,可用 settings.habits.reflect* 覆盖)
    disposers.push(register('/persona/habits/reflect', async (_req, res) => {
      try {
        // 上限(2026-09-16 定案):与 scan 同一条规则 —— 满了明确驳回,不排队、不静默丢弃。
        const capR = pendingMaxOf(settings);
        const pendR = habitsPendingOf(settings).length;
        if (pendR >= capR) {
          return sendJson(res, 200, {
            ok: false, reason: 'pending-full', pending: pendR, limit: capR,
            message: `待确认的习惯已经有 ${pendR} 条(上限 ${capR})—— 先把手上的处理完(认可 / 先不要),再让她看新的。`,
          });
        }
        const hs = settings.get()?.habits || {};
        // 注意:scanCorrections 用的是"展开覆盖"语义,传 undefined 会把默认值顶掉 —— 只在有值时传
        const scanOpts = {};
        if (hs.scanMinHits != null) scanOpts.minHits = Number(hs.scanMinHits) || SCAN_DEFAULTS.minHits;
        if (hs.scanMinSessions != null) scanOpts.minSessions = Number(hs.scanMinSessions) || SCAN_DEFAULTS.minSessions;
        const scan = summarizeScan(scanCorrections(memory, scanOpts));
        // 轮询游标:每次读上一轮没读过的那一段;读满一圈回到最新(kv 持久化,跨会话累计)
        let cursor = null;
        try { cursor = JSON.parse(memory.kvGet('habits.reflect.cursor') || 'null') || null; } catch { cursor = null; }
        const { text: material, stats, nextCursor } = buildReflectMaterial(memory, {
          scan,
          rules: settings.get()?.persona?.hardRules || [],
          habits: settings.get()?.persona?.habits || [],
          overviewLimit: hs.reflectOverviewLimit,
          turnLimit: hs.reflectTurnLimit,
          budgetChars: hs.reflectBudgetChars,
          cursor,
        });
        try { if (nextCursor) memory.kvSet('habits.reflect.cursor', JSON.stringify(nextCursor)); } catch { /* 游标没存上只影响下一轮,不影响本次 */ }
        const cov = stats?.coverage ? ` ${stats.coverage}` : '';
        if (!material) {
          return sendJson(res, 200, {
            ok: false, reason: 'empty',
            message: pronounize('没有可回想的材料 —— 先接入一些历史,她才有相处的痕迹可读。', pronounOf(settings.get())),
          });
        }
        const eff = hs.reflectEffort || REFLECT_DEFAULTS.effort;
        const maxTok = Number(hs.reflectMaxTokens) || REFLECT_DEFAULTS.maxTokens;
        const { text, attempts, retried } = await reflectWithRetry(
          (o) => llmOnce(ctx, o),
          { system: pronounize(HABIT_REFLECT_SYS, pronounOf(settings.get())), material, maxTokens: maxTok, effort: eff },
        );
        const cands = parseReflect(text, { max: Number(hs.reflectMaxHabits) || REFLECT_DEFAULTS.maxHabits });
        // 每次运行都留一条运行记录(不只是空回复时):否则"跑了但没结果"这类问题只能靠猜
        // —— 2026-09-16 实测:上一版只在空回复时写 kv,结果连"跑没跑、读到什么"都查不到。
        try {
          const first = attempts[0] || {};
          memory.kvSet('habits.reflect.last', JSON.stringify({
            at: new Date().toISOString(),
            round: cursor?.round ?? 1,
            materialChars: material.length,
            maxTokens: maxTok,
            effort: eff,
            retried: !!retried,
            textLen: String(text || '').length,
            empty: !String(text || '').trim(),
            candidates: cands.length,
            target: first.target ? `${first.target.provider}/${first.target.model}` : null,
            attempts: (attempts || []).map((a) => ({
              tag: a.tag, effort: a.effort, chars: a.chars, ms: a.ms, ok: a.ok, len: a.len,
              chunkTypes: a.chunkTypes, error: a.error ? String(a.error).slice(0, 200) : undefined,
            })),
            coverage: stats?.coverage || null,
          }));
        } catch { /* 运行记录没写上不影响主流程 */ }
        if (!cands.length) {
          const empty = !String(text || '').trim();
          const first = attempts[0] || {};
          if (empty) {
            // 空回复必须留下"为什么":否则只能靠猜(旧版就是这样瞒了一整天)
            try {
              memory.kvSet('habits.reflect.debug', JSON.stringify({
                at: new Date().toISOString(), materialChars: material.length, maxTokens: maxTok, effort: eff, attempts, stats,
              }));
            } catch { /* 诊断没写上不影响主流程 */ }
          }
          const tgt = first.target ? `${first.target.provider}/${first.target.model}` : '(未知目标模型)';
          const chunks = Array.isArray(first.chunkTypes) && first.chunkTypes.length ? first.chunkTypes.join(',') : '(无 chunk)';
          return sendJson(res, 200, {
            ok: true, found: 0, proposed: 0, skipped: [], items: [], material: stats, retried,
            message: pronounize(`她读完${cov},觉得还不足以长出一条习惯(宁缺勿滥)。`, pronounOf(settings.get())) +
              (empty
                ? `(模型没有返回内容:目标 ${tgt} · 材料 ${material.length} 字 · ${maxTok} token · chunk=[${chunks}]` +
                  `${retried ? ' · 已用 off 档 + 裁短材料重试一次仍空' : ''};诊断已存 kv habits.reflect.debug —— ` +
                  '多半是材料超出当前模型上下文,或思考档吃掉了预算:可调小 reflectBudgetChars 或提高 reflectMaxTokens)'
                : ''),
          });
        }
        const proposed = [];
        const skipped = [];
        for (const c of cands) {
          const r = await proposeHabit({ settings, habit: c.text, evidence: c.evidence || '她回想最近的相处时归纳', byUser: false });
          if (r.ok) proposed.push({ id: r.id, text: c.text, evidence: c.evidence });
          else skipped.push({ text: c.text, reason: r.reason });
        }
        sendJson(res, 200, {
          ok: true, found: cands.length, proposed: proposed.length, skipped, items: proposed, material: stats,
          message: proposed.length
            ? pronounize(`她回想${cov},提出 ${proposed.length} 条习惯候选(等你确认)`, pronounOf(settings.get()))
            : '候选都已经在习惯里或待确认列表里了',
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'reflect', message: '回想失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // ---- 语气 P1(自性类 = 自由生长,锁定下免手术)----
    // POST /persona/tone-advice  按记忆分类(工作侧知识 / 生活侧情感)归纳两档语气候选(只读,不落盘)
    disposers.push(register('/persona/tone-advice', async (_req, res) => {
      try {
        const pnTone = pronounOf(settings.get());
        const workSide = sampleToneRows(memory, { side: 'work', limit: 40, pronoun: pnTone });
        const lifeSide = sampleToneRows(memory, { side: 'life', limit: 40, pronoun: pnTone });
        const srcWork = buildGenesisSource(workSide.rows, { cap: 9000 });
        const srcLife = buildGenesisSource(lifeSide.rows, { cap: 9000 });
        if (!srcWork && !srcLife) {
          return sendJson(res, 200, { ok: false, reason: 'empty', message: pronounize('记忆库还是空的——先接入历史,她才有可观察的素材。', pronounOf(settings.get())) });
        }
        const material = '【工作侧材料(知识/技术为主)】\n' + (srcWork || '(无)') +
          '\n\n【生活侧材料(情感/日常为主)】\n' + (srcLife || '(无)');
        const { text } = await llmOnce(ctx, {
          system: pronounize(TONE_ADVICE_SYS, pronounOf(settings.get())),
          text: material,
          maxTokens: 1000,
          effort: 'low',
        });
        let result = parseToneAdvice(text);
        let raw = text;
        if (!result.work.tone && !result.life.tone) {
          // 一次强化重试:明确只输出 JSON、tone 用小写英文枚举
          const retry = await llmOnce(ctx, {
            system: '只输出一个 JSON 对象,不要 markdown 围栏、不要解释。格式:{"work":{"tone":"natural|literary|concise|playful","note":"…","evidence":"…"},"life":{…}}。tone 必须是小写英文枚举之一,禁止中文。',
            text: material,
            maxTokens: 1000,
            effort: 'off',
          });
          raw = retry.text;
          result = parseToneAdvice(retry.text);
        }
        if (!result.work.tone && !result.life.tone) {
          // 留下原始输出,便于定位(可在同一位置读 kv 查看)
          memory.kvSet('tone.advice.debug', JSON.stringify({
            at: new Date().toISOString(),
            raw: String(raw || '').slice(0, 1200),
            sampled: { work: workSide.sampled, life: lifeSide.sampled },
          }));
          return sendJson(res, 200, {
            ok: false, reason: 'parse',
            message: '模型没给出可用的语气建议(原始输出已留存)。再试一次,或看看这次它说了什么:' + String(raw || '').slice(0, 120),
          });
        }
        memory.kvSet('tone.advice.last', JSON.stringify({ at: new Date().toISOString(), result, sampled: { work: workSide.sampled, life: lifeSide.sampled } }));
        sendJson(res, 200, {
          ok: true, result,
          sampled: { work: workSide.sampled, life: lifeSide.sampled, workPool: workSide.pool, lifePool: lifeSide.pool },
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '归纳失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /persona/grow { tone?: {work?,life?,default?}, styleAppend?: {work?,life?} }
    //   自性类成长通道:白名单字段(语气枚举 + 风格追加),锁定下亦可采纳;不可逆操作一律不做。
    disposers.push(register('/persona/grow', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const patch = {};
      const toneIn = body.tone && typeof body.tone === 'object' ? body.tone : {};
      if (toneIn.default && TONE_SET.includes(String(toneIn.default))) patch.tone = String(toneIn.default);
      if (toneIn.work && TONE_SET.includes(String(toneIn.work))) patch.toneWork = String(toneIn.work);
      if (toneIn.life && TONE_SET.includes(String(toneIn.life))) patch.toneLife = String(toneIn.life);
      const styleIn = body.styleAppend && typeof body.styleAppend === 'object' ? body.styleAppend : {};
      const cur = settings.get();
      const styles = { ...(cur.styles || {}) };
      let appended = false;
      for (const side of ['work', 'life']) {
        const note = String(styleIn[side] ?? '').trim();
        if (!note) continue;
        const next = appendStyleNote(styles[side], note);
        if (next !== styles[side]) { styles[side] = next; appended = true; }
      }
      if (!Object.keys(patch).length && !appended) {
        return sendJson(res, 200, { ok: false, reason: 'noop', message: '没有可应用的有效更改(语气需为四档之一,风格注只追加不覆盖)' });
      }
      const histKey = await archivePersona(cur, 'result');
      const s2 = await settings.update(appended ? { persona: patch, styles } : { persona: patch });
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, affected, histKey, appended,
        tone: { tone: s2.persona?.tone, toneWork: s2.persona?.toneWork, toneLife: s2.persona?.toneLife },
        l0PreviewText: l0WithClock(s2, s2.mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /persona/rollback { ts, unlock? }  回滚到某历史存档(同样受定型门约束)
    disposers.push(register('/persona/rollback', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const ts = Number(body.ts);
      const raw = ts ? memory.kvGet('persona.hist.' + ts) : null;
      if (!raw) return sendJson(res, 200, { ok: false, reason: 'notfound', message: '存档不存在' });
      let snap = null;
      try { snap = JSON.parse(String(raw)); } catch {}
      if (!snap || !snap.persona) return sendJson(res, 200, { ok: false, reason: 'bad', message: '存档内容损坏' });
      const cur = settings.get();
      const g = cur.persona?.sealed === true ? sealOk(cur.persona, body.unlock) : { pass: true, adoptKey: null };
      if (!g.pass) return sendJson(res, 200, { ok: false, reason: 'sealed', message: MSG_KEY });
      await archivePersona(cur, 'pre-rollback'); // 回滚前再留一份当前档案,可再反悔
      const patch2 = { persona: { ...snap.persona }, styles: { ...(snap.styles || {}) } };
      if (g.adoptKey) patch2.persona.sealPhrase = g.adoptKey; // 旧档案无明文:采纳当前键入句子
      const s2 = await settings.update(patch2);
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      const mode = s2.mode?.lastMode === 'work' ? 'work' : 'life';
      sendJson(res, 200, {
        ok: true, affected, sealed: s2.persona?.sealed === true,
        l0PreviewText: l0WithClock(s2, mode),
      });
    }));

    // POST /memory/refresh { sessionId? }
    disposers.push(register('/memory/refresh', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sessionId = body.sessionId || null;
      if (sessionId) {
        return sendJson(res, 200, { ok: true, ...invalidateSession(gate, memory, settings, sessionId) });
      }
      const affected = allSnapshotSessionIds(gate).map((sid) => ({ sessionId: sid, result: invalidateSession(gate, memory, settings, sid) }));
      sendJson(res, 200, { ok: true, affected });
    }));

    // GET /import/history  导入记录(三条入口共用:文件导入 / 本机 DSH 扫描 / 网页端库扫描)
    disposers.push(register('/import/history', async (_req, res) => {
      const items = listImportLog(memory, { limit: 50 }).map((it) => ({ ...it, line: formatLogLine(it) }));
      sendJson(res, 200, { ok: true, items, keep: 50 });
    }));

    // GET /persona/draft  基于当前档案(惯例/底线/设定/风格)起草「定位自述」候选。
    // 只读操作,不受定型门约束(不落盘;采用仍需常规保存流程)。
    disposers.push(register('/persona/draft', async (_req, res) => {
      const s = settings.get();
      const p = s.persona || {};
      const parts = [];
      const toneName = { natural: '自然亲切', literary: '文雅', concise: '简洁直接', playful: '活泼俏皮' }[p.tone] || p.tone || '自然';
      parts.push('自称:' + (p.aiName || '(未设置)') + ' | 对用户称呼:' + (p.userTitle || '(用你)'));
      parts.push('语气:' + toneName + ' | 语言:' + (p.language === 'zh' ? '中文' : p.language === 'en' ? 'English' : '跟随用户'));
      if (Array.isArray(p.bottomLines) && p.bottomLines.length) parts.push('底线:\n' + p.bottomLines.map((x) => '- ' + x).join('\n'));
      if (Array.isArray(p.hardRules) && p.hardRules.length) parts.push('规矩(用户的指令):\n' + p.hardRules.map((x) => '- ' + x).join('\n'));
      if (Array.isArray(p.habits) && p.habits.length) parts.push('习惯(她长出来的):\n' + p.habits.map((x) => '- ' + (x?.text || x)).join('\n'));
      if (typeof p.extraLore === 'string' && p.extraLore.trim()) parts.push('扩展设定/身世:\n' + p.extraLore.trim().slice(0, 1200));
      parts.push('工作模式风格:' + (s.styles?.work || '(空)'));
      parts.push('生活模式风格:' + (s.styles?.life || '(空)'));
      if (!parts.length) return sendJson(res, 200, { ok: false, reason: 'empty', message: '档案为空,先填一些内容再起草' });
      try {
        const { text } = await llmOnce(ctx, {
          system: '你是人格档案文案起草助手。依据档案要素起草「定位自述」:说清 AI 是谁、什么气质、与用户是什么关系,自然、克制、不空泛、不堆砌辞藻,与档案语气一致,每段不超过 200 字。输出 1 到 3 个候选,每行一个:不带序号、不加引号、不写解释。',
          text: parts.join('\n'),
          maxTokens: 600,
          effort: 'low',
        });
        const candidates = String(text || '')
          .split('\n').map((l) => l.trim().replace(/^[\s\-•·*]*\d*[.、)）]\s*/, '').replace(/^["「『]|["」』]$/g, '').trim())
          .filter((l) => l.length >= 4 && l.length <= 200)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 3);
        if (!candidates.length && String(text || '').trim().length <= 220) candidates.push(String(text).trim());
        if (!candidates.length) return sendJson(res, 200, { ok: false, reason: 'empty-reply', message: '模型没有给出可用候选,再试一次' });
        sendJson(res, 200, { ok: true, candidates });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '起草失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // POST /dsweb/scan { db?, limit? }  网页端历史库(聊天记录 .db)增量扫描入库
    disposers.push(register('/dsweb/scan', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const dbPath = String(body.db || DSWEB_DB_DEFAULT || '').trim();
      if (!dbPath) {
        return sendJson(res, 200, {
          ok: false, reason: 'no-db',
          message: '请先填写网页端聊天记录库的完整路径(本插件不预设私有路径;也可用 DSH_LING_DSWEB_DB 环境变量指定)',
        });
      }
      try {
        const r = scanIntoMemory(memory, dbPath, { limit: body.limit ? Number(body.limit) : 0 });
        const affected = allSnapshotSessionIds(gate).map((sid) => ({
          sessionId: sid,
          result: invalidateSession(gate, memory, settings, sid),
        }));
        logImport(memory, {
          kind: 'dsweb', name: String(dbPath).split(/[\\/]/).pop(),
          seen: r.seen, newRows: r.added, refreshed: r.refreshed,
        });
        sendJson(res, 200, { ok: true, db: dbPath, ...r, affected: affected.length });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'scan', message: '扫描失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /dsh/backfill { limit? }  通道 A:DSH 存量会话一键扫描入库(幂等;已存在跳过)
    disposers.push(register('/dsh/backfill', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const { report } = await scanDshHistory({ memory, limit: body.limit ? Number(body.limit) : 0 });
        const total = memory.db.prepare("SELECT COUNT(*) n FROM conv_overview WHERE source='dsh'").get().n;
        logImport(memory, { kind: 'dsh', name: '本机会话', seen: report.scanned, newRows: report.created });
        sendJson(res, 200, { ok: true, ...report, totalDsh: Number(total) });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'backfill', message: '扫描失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /import/file/batch { items, file?, runId?, at? }  通道 B:会话契约文件导入(每批 ≤500;客户端分页)
    //   file/runId/at 仅用于记账:同一次导入(同 runId)的多批累加进**一条**账,at = 导入开始时刻
    disposers.push(register('/import/file/batch', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
      if (!items.length) return sendJson(res, 200, { ok: false, reason: 'empty', message: '本批没有条目' });
      try {
        const r = await applyImportItems(memory, items);
        logImport(memory, {
          kind: 'file', name: body.file, runId: body.runId, at: body.at,
          accepted: r.accepted, newRows: r.newRows, refreshed: r.refreshed,
          upgraded: r.upgraded, folded: r.folded, removedImport: r.removedImport,
          degraded: r.degraded, rejected: (r.rejected || []).length,
        });
        sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'import', message: '导入失败:' + String(e?.message ?? e).slice(0, 200) });
      }
    }));

    // POST /import/log { runId, at?, file?, errors? }  记账补充:客户端上报**失败批**(成功批由上面自己记账)
    disposers.push(register('/import/log', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String(body.runId || '').slice(0, 64);
      if (!runId) return sendJson(res, 200, { ok: false, reason: 'runId', message: '缺少 runId' });
      const key = logImport(memory, {
        kind: 'file', name: body.file, runId, at: body.at,
        errors: Math.max(1, Number(body.errors) || 1),
      });
      sendJson(res, 200, { ok: true, key });
    }));

    // ---- 诞生仪式:一键深摘(import 源)+ 人格初稿 ----
    // POST /deep/run-import  对"文件导入"会话中**尚未读过**的批量深摘(后台串行;GET 轮询状态;
    //   已 done/skip 的跳过 —— 重复点击推进的是未读部分,不会重读)
    disposers.push(register('/deep/run-import', async (req, res) => {
      if (impRun.running) {
        return sendJson(res, 200, { ok: true, busy: true, total: impRun.total, finished: impRun.done.length });
      }
      const targets = importRawTargets(memory, { limit: 200, excludeProcessed: true }); // 一次跑完所有未读(含快速通过的短会话)
      if (!targets.length) {
        return sendJson(res, 200, { ok: false, reason: 'none', message: '已全部读过(可换新导入的历史再来)' });
      }
      impRun.running = true;
      impRun.total = targets.length;
      impRun.done = [];
      impRun.startedAt = Date.now();
      impRun.finishedAt = 0;
      (async () => {
        for (const t of targets) {
          let r;
          try {
            r = await deepSummarizeOne(ctx, memory, candidateFor(memory, t.session_id));
            impRun.done.push({ id: t.session_id.slice(0, 8), ok: !!r.ok, chars: r.chars || null, reason: r.reason || null });
          } catch (e) {
            impRun.done.push({ id: t.session_id.slice(0, 8), ok: false, reason: 'err:' + String(e?.message ?? e).slice(0, 120) });
          }
        }
        impRun.running = false;
        impRun.finishedAt = Date.now();
      })();
      sendJson(res, 200, { ok: true, started: true, total: targets.length });
    }));

    // GET /deep/run-status  一键深摘进度
    disposers.push(register('/deep/run-status', async (_req, res) => {
      sendJson(res, 200, {
        ok: true, running: impRun.running, total: impRun.total,
        done: impRun.done, startedAt: impRun.startedAt, finishedAt: impRun.finishedAt,
      });
    }));

    // ---- 网页端历史(dsweb)补摘要:候选预览 / 后台串行执行 / 进度 ----
    // 为什么要有 UI:CLI 只适合本机;给别人用时,引擎选择必须是**显式动作** —— 绝不静默花用户的钱。
    const dswebDbOf = (v) => String(v || DSWEB_DB_DEFAULT || '').trim();
    const dswebQuery = (req) => new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams;

    // GET /dsweb/summary/preview?db=&minTurns=&all=1&onlyHit=1&limit=
    disposers.push(register('/dsweb/summary/preview', async (req, res) => {
      const q = dswebQuery(req);
      const db = dswebDbOf(q.get('db'));
      if (!db) {
        return sendJson(res, 200, {
          ok: false, reason: 'no-db',
          message: '请先填写网页端聊天记录库(.db)的完整路径(也可用 DSH_LING_DSWEB_DB 环境变量指定)',
        });
      }
      const minTurns = Number(q.get('minTurns') || MIN_TURNS_DEFAULT) || MIN_TURNS_DEFAULT;
      const includeShort = q.get('all') === '1';
      const onlyHit = q.get('onlyHit') === '1';
      const limit = Math.max(1, Math.min(Number(q.get('limit') || 20) || 20, 200));
      let src;
      try { src = openSource(db); } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'db', message: '打不开源库:' + String(e?.message ?? e).slice(0, 160) });
      }
      try {
        const list = buildCandidates(memory, src, { minTurns, includeShort, onlyHit });
        const asst = resolveAssistant(settings);
        const assistant = await probeAssistant(asst.baseUrl);
        sendJson(res, 200, {
          ok: true, db, total: list.length, minTurns, includeShort, onlyHit,
          assistant: { ok: assistant.ok, reason: assistant.reason, models: assistant.models, base: asst.baseUrl, model: asst.model, source: asst.source },
          items: list.slice(0, limit),
        });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'preview', message: String(e?.message ?? e).slice(0, 200) });
      } finally { try { src.close(); } catch { /* ignore */ } }
    }));

    // POST /dsweb/summary/run { db, engine:'assistant'|'global', limit?, minTurns?, all?, onlyHit?, baseUrl?, model? }
    disposers.push(register('/dsweb/summary/run', async (req, res) => {
      if (dswebRun.running) {
        return sendJson(res, 200, { ok: true, busy: true, total: dswebRun.total, finished: dswebRun.done.length });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const db = dswebDbOf(body.db);
      if (!db) return sendJson(res, 200, { ok: false, reason: 'no-db', message: '请先填写网页端聊天记录库路径' });
      const engine = body.engine === 'global' ? 'global' : 'assistant';
      const asst = resolveAssistant(settings);
      const baseUrl = String(body.baseUrl || asst.baseUrl);
      const model = String(body.model || asst.model);
      if (engine === 'assistant') {
        const probe = await probeAssistant(baseUrl);
        if (!probe.ok) {
          return sendJson(res, 200, {
            ok: false, reason: 'no-assistant',
            message: '本机小助手探测失败(' + probe.reason + ' @ ' + baseUrl + ')—— 我们不会替你静默换引擎;请确认它在线,或**显式**改选「当前全局大模型」。',
          });
        }
      }
      let src;
      try { src = openSource(db); } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'db', message: '打不开源库:' + String(e?.message ?? e).slice(0, 160) });
      }
      const minTurns = Number(body.minTurns || MIN_TURNS_DEFAULT) || MIN_TURNS_DEFAULT;
      const includeShort = !!body.all;
      const onlyHit = !!body.onlyHit;
      const cap = Math.max(0, Math.min(Number(body.limit || 0) || 0, 2000));
      let list;
      try {
        list = buildCandidates(memory, src, { minTurns, includeShort, onlyHit });
      } catch (e) {
        try { src.close(); } catch { /* ignore */ }
        return sendJson(res, 200, { ok: false, reason: 'candidates', message: String(e?.message ?? e).slice(0, 200) });
      }
      if (cap) list = list.slice(0, cap);
      if (!list.length) {
        try { src.close(); } catch { /* ignore */ }
        return sendJson(res, 200, { ok: false, reason: 'none', message: '没有待补摘要的候选(可能都已补过,或轮次数不足)' });
      }
      dswebRun.running = true; dswebRun.total = list.length; dswebRun.done = [];
      dswebRun.ok = 0; dswebRun.fail = 0; dswebRun.current = ''; dswebRun.engine = engine;
      dswebRun.startedAt = Date.now(); dswebRun.finishedAt = 0; dswebRun.lastError = null; dswebRun.db = db;
      (async () => {
        try {
          for (const it of list) {
            dswebRun.current = String(it.title || it.conv_id).slice(0, 40);
            const short = String(it.conv_id).slice(0, 8);
            try {
              const text = conversationText(src, it.conv_id);
              if (!text) { dswebRun.fail += 1; dswebRun.done.push({ id: short, ok: false, reason: 'no-text' }); continue; }
              let summary = '';
              let reason = null;
              if (engine === 'assistant') {
                const r = await summarizeWithRetry(baseUrl, model, { text, system: SUMMARY_SYS });
                summary = r.ok ? String(r.summary || '') : '';
                reason = r.ok ? null : (r.error || 'failed');
              } else {
                const r = await llmOnce(ctx, { system: SUMMARY_SYS, text, maxTokens: 600, effort: 'off' });
                summary = cleanSummary(r?.text);
                reason = summary ? null : 'empty';
              }
              if (!summary) { dswebRun.fail += 1; dswebRun.lastError = reason; dswebRun.done.push({ id: short, ok: false, reason }); continue; }
              const ov = memory.overviewById('dsweb', it.conv_id);
              if (ov) memory.upsertOverview({ ...ov, summary });
              dswebRun.ok += 1; dswebRun.done.push({ id: short, ok: true, chars: summary.length });
            } catch (e) {
              dswebRun.fail += 1;
              dswebRun.lastError = String(e?.message ?? e).slice(0, 120);
              dswebRun.done.push({ id: short, ok: false, reason: 'err' });
            }
          }
        } finally {
          touchMemoryVersion(memory);          // 补摘要改了记忆内容 → 长会话空闲时才会追平
          try { src.close(); } catch { /* ignore */ }
          dswebRun.running = false; dswebRun.finishedAt = Date.now(); dswebRun.current = '';
        }
      })();
      sendJson(res, 200, { ok: true, started: true, total: list.length, engine });
    }));

    // GET /dsweb/summary/status  补摘要进度(前端 2 秒轮询)
    disposers.push(register('/dsweb/summary/status', async (_req, res) => {
      sendJson(res, 200, {
        ok: true, running: dswebRun.running, total: dswebRun.total, finished: dswebRun.done.length,
        okCount: dswebRun.ok, failCount: dswebRun.fail, current: dswebRun.current, engine: dswebRun.engine,
        startedAt: dswebRun.startedAt, finishedAt: dswebRun.finishedAt, lastError: dswebRun.lastError,
        tail: dswebRun.done.slice(-5),
      });
    }));

    // POST /persona/genesis { scope?: 'import'|'all' }
    //   合成"她对自己的第一次介绍"。原料:scope='import'=刚请进来的历史;'all'=全部记忆
    //   (生活/情感优先加权抽样)。每行三级取用:深摘 → 非占位概述 → 原文片段/线索。
    disposers.push(register('/persona/genesis', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const scope = body.scope === 'all' ? 'all' : 'import';
      const pn = pronounOf(settings.get());
      const comp = composeGenesisRows(memory, { scope, pronoun: pn });
      const sourceText = buildGenesisSource(comp.rows);
      if (!sourceText) {
        return sendJson(res, 200, { ok: false, reason: 'empty', message: pronounize('还没有可读的历史——先在「接入历史」把一段对话请进来,她才能开始认识自己。', pronounOf(settings.get())) });
      }
      try {
        const { text } = await llmOnce(ctx, {
          system: pronounize(GENESIS_SYS, pn),
          text: pronounize(`请阅读以下"她与用户的共同历史材料"(${scope === 'all' ? '来自全部记忆,已按生活/情感优先抽样 ' + comp.sampled + ' 条' : '来自刚导入的一段历史 ' + comp.sampled + ' 条'}),完成自我介绍:\n\n`, pn) + sourceText,
          maxTokens: 1600,
          effort: 'low',
        });
        const result = parseGenesisResult(text);
        if (!result.self_intros.length && !result.name_pairs.length) {
          return sendJson(res, 200, { ok: false, reason: 'parse', message: '模型输出无法解读,再试一次' });
        }
        // 名字必须属于"她":剔除用户称谓/称呼(userTitle 成分 + 常见称谓词)
        const userTitle = settings.get().persona?.userTitle || '';
        result.name_pairs = filterNamePairs(result.name_pairs, userTitle);
        memory.kvSet('genesis.last', JSON.stringify({ at: new Date().toISOString(), scope, result }));
        sendJson(res, 200, { ok: true, scope, sampled: comp.sampled, result });
      } catch (e) {
        sendJson(res, 200, { ok: false, reason: 'llm', message: '诞生仪式失败:' + String(e?.message ?? e).slice(0, 160) });
      }
    }));

    // ---- 成长回路(修订建议队列,人审闭环) ----
    // GET /feedback
    disposers.push(register('/feedback', async (_req, res) => {
      const items = memory.listFeedback({ status: 'new' }).map((it) => ({
        id: it.id, created_at: it.created_at, session_id: it.session_id,
        note: it.note, rating: it.rating,
      }));
      sendJson(res, 200, {
        ok: true,
        items,
        stats: {
          new: items.length,
          applied: memory.countFeedback('applied'),
          dismissed: memory.countFeedback('dismissed'),
        },
      });
    }));

    // POST /feedback/apply { id }
    disposers.push(register('/feedback/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await applySuggestionAsRule(memory, settings, body.id);
      if (!r.ok) return sendJson(res, 200, { ok: false, reason: r.reason });
      await archivePersona(settings.get(), 'result'); // 惯例成长也留档
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, id: r.id, hardRules: r.hardRules,
        affected: affected.length,
        l0PreviewText: l0WithClock(settings.get(), settings.get().mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /feedback/dismiss { id }
    disposers.push(register('/feedback/dismiss', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, dismissSuggestion(memory, body.id));
    }));

    // ---- 语料提炼建议(人格档案) ----
    // GET /suggestions
    disposers.push(register('/suggestions', async (_req, res) => {
      const items = memory.listPersonaSuggestions({ status: 'new' }).map((it) => ({
        id: it.id, kind: it.kind, value: it.value, note: it.note, evidence: it.evidence,
      }));
      sendJson(res, 200, {
        ok: true,
        items,
        stats: {
          new: items.length,
          adopted: memory.countPersonaSuggestion('adopted'),
          dismissed: memory.countPersonaSuggestion('dismissed'),
        },
      });
    }));

    // POST /suggestions/apply { id }
    disposers.push(register('/suggestions/apply', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const row = memory.getPersonaSuggestion(Number(body.id));
      const kind = row?.kind ?? '';
      // 定型门:自称/称呼属身份保护区,采纳需钥匙;惯例类建议(成长回路)可自由追加
      if (kind === 'aiName' || kind === 'userTitle') {
        const cur = settings.get();
        const g = cur.persona?.sealed === true ? sealOk(cur.persona, body.unlock) : { pass: true, adoptKey: null };
        if (!g.pass) {
          return sendJson(res, 200, { ok: false, reason: 'sealed', message: '人格已定型 — 采纳「' + (kind === 'aiName' ? '自称' : '称呼') + '」需先输入承诺句(' + MSG_KEY + ')。惯例类建议仍可直接采纳。' });
        }
        if (g.adoptKey) await settings.update({ persona: { sealPhrase: g.adoptKey } });
      }
      const r = await applyCorpusSuggestion(memory, settings, body.id);
      if (!r.ok) return sendJson(res, 200, { ok: false, reason: r.reason });
      await archivePersona(settings.get(), 'result'); // 建议采纳后的档案留档
      const affected = allSnapshotSessionIds(gate).map((sid) => ({
        sessionId: sid,
        result: invalidateSession(gate, memory, settings, sid),
      }));
      sendJson(res, 200, {
        ok: true, id: r.id, kind: r.kind, kindName: r.kindName, value: r.value,
        affected: affected.length,
        l0PreviewText: l0WithClock(settings.get(), settings.get().mode?.lastMode === 'work' ? 'work' : 'life'),
      });
    }));

    // POST /suggestions/dismiss { id }
    disposers.push(register('/suggestions/dismiss', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, dismissCorpusSuggestion(memory, body.id));
    }));

    // ---- LLM 深摘要 ----
    // GET /deep/status
    disposers.push(register('/deep/status', async (_req, res) => {
      const probeRaw = memory.kvGet('llm.probe');
      const lastRaw = memory.kvGet('deep.last');
      const doneRow = memory.db.prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'deep:%' AND value LIKE 'done:%'").get();
      sendJson(res, 200, {
        ok: true,
        probe: probeRaw ? JSON.parse(probeRaw) : null,
        last: lastRaw ? JSON.parse(lastRaw) : null,
        done: doneRow ? Number(doneRow.n) : 0,
      });
    }));

    // POST /deep/run { limit? }
    disposers.push(register('/deep/run', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await runDeepPass(ctx, memory, { limit: body.limit ? Number(body.limit) : undefined });
      sendJson(res, 200, { ok: r.ok, reason: r.reason, candidates: r.candidates, done: r.done });
    }));

    // POST /deep/one { sessionId }  — 对单个会话强制重深摘(自动过 skip/done)
    disposers.push(register('/deep/one', async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}');
      const sid = body.sessionId;
      if (!sid) return sendJson(res, 400, { ok: false, error: 'sessionId required' });
      rerunOne(memory, sid);
      const cand = candidateFor(memory, sid);
      if (!cand) {
        return sendJson(res, 200, { ok: false, reason: 'no-candidate', message: '该会话没有可深摘的内容' });
      }
      const r = await deepSummarizeOne(ctx, memory, cand);
      let message;
      if (!r.ok) {
        if (r.reason === 'below-min') message = '会话较短,未达深摘门槛(短会话无需深摘;它的标题与片段已可检索),是正常现象';
        else if (r.reason === 'no-overview') message = '该会话没有可回写深摘的档案行';
      }
      sendJson(res, 200, { ok: r.ok, sessionId: sid, reason: r.reason || null, message, chars: r.chars || null });
    }));

    // GET /export
    disposers.push(register('/export', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const bundle = memory.exportBundle({ includeRaw: q.get('includeRaw') === '1' });
      const s = settings.get();
      // 人格/风格/最后模式随包附载(默认不在合并时覆盖目标)
      bundle.persona = {
        persona: s.persona || {},
        styles: s.styles || {},
        lastMode: s.mode?.lastMode || 'life',
      };
      const payload = JSON.stringify(bundle, null, 2);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dsh-ling-memory-${new Date().toISOString().slice(0, 10)}.dshling.json"`);
      res.end(payload);
    }));

    // POST /import   body = bundle(JSON) 或 { bundle, persona?: true };?overwrite=1
    disposers.push(register('/import', async (req, res) => {
      const q = new URL(req.url, 'http://dsh.internal').searchParams;
      const text = await readBody(req);
      const parsed = JSON.parse(text || '{}');
      const bundle = parsed.bundle || parsed;
      const report = memory.importBundle(bundle, { overwrite: q.get('overwrite') === '1' });
      // 人格默认不覆盖;仅当显式 persona:true(如备份恢复)才合并(外来条目不污染本地人格)
      let personaApplied = false;
      if (parsed.persona === true && bundle.persona) {
        const cur = settings.get();
        // 定型门:已定型时整体覆盖人格需钥匙
        const g = cur.persona?.sealed === true ? sealOk(cur.persona, parsed.unlock) : { pass: true, adoptKey: null };
        if (!g.pass) {
          return sendJson(res, 200, { ok: false, reason: 'sealed', message: MSG_KEY + '只并入记忆/建议则不受影响。', report });
        }
        const p = bundle.persona.persona || {};
        const st = bundle.persona.styles || {};
        if (g.adoptKey) p.sealPhrase = g.adoptKey;
        const { clean } = sanitizePersonaPatch({ persona: p, styles: st }); // 加固④:外来 bundle 同样过白名单
        await settings.update(clean);
        await archivePersona(settings.get(), 'result'); // 备份覆盖后档案留档
        personaApplied = true;
        for (const sid of allSnapshotSessionIds(gate)) {
          invalidateSession(gate, memory, settings, sid);
        }
      }
      sendJson(res, 200, { ok: report.errors === 0, personaApplied, report });
    }));

    return () => {
      for (const d of disposers) {
        try {
          d();
        } catch {}
      }
    };
  };

  const reqSessionId = (url) => {
    const q = new URL(url || '/', 'http://dsh.internal').searchParams;
    return q.get('sessionId') || q.get('sid') || null;
  };

  tryMount();
  if (!disposeRoutes) {
    // 服务启动顺序兜底:每 3s 重试,成功或插件卸载即停
    timer = setInterval(() => {
      if (disposed || disposeRoutes) {
        clearInterval(timer);
        timer = null;
        return;
      }
      tryMount();
    }, 3000);
  }

  return () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (disposeRoutes) {
      try {
        disposeRoutes();
      } catch {}
      disposeRoutes = null;
    }
  };
}

function allSnapshotSessionIds(gate) {
  return gate.snapshotIds();
}

function rawTurnSessionCount(memory) {
  return memory.rawSessionCount();
}
