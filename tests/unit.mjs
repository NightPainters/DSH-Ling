// dsh-ling M1a unit tests — plain node, zero deps.
// Run: node tests/unit.mjs
import { ok, eq, section, summary } from './harness.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const imp = (rel) => import(pathToFileURL(join(root, rel)).href);

// ---------------------------------------------------------------- persona
await section('persona 组装');
{
  const { assemblePersona, coreNameOf, userTitleForMode, DEFAULT_SETTINGS, PRONOUN_PRESETS, pronounOf, pronounize } = await imp('lib/host/persona.js');
  const empty = assemblePersona(DEFAULT_SETTINGS, 'life');
  ok(empty.includes('[身份·器灵]'), '空字段输出最小身份段(标题=器灵)');
  ok(empty.includes('你是 DeepSeek 助手'), '空自称回退默认身份句');
  ok(!empty.includes('DeepSeek Harness'), '不再重复宿主已声明的平台名(瘦身)');
  ok(!empty.includes('灵灵') && !empty.includes('dsh-ling'), '空字段不出现占位自称/内部名');
  eq(coreNameOf('小灵/灵灵'), '小灵', 'coreName 取首段');
  eq(coreNameOf('灵灵/小灵'), '灵灵', 'coreName 仍取首段');
  eq(coreNameOf(' 灵灵 '), '灵灵', 'coreName 单名');
  eq(coreNameOf(''), '器灵', 'coreName 空回退');
  // 称呼按模式分档:正式名在前,昵称在后
  eq(userTitleForMode('张明/老板', 'work'), '张明', '工作模式称正式名(首段)');
  eq(userTitleForMode('张明/老板', 'life'), '老板', '生活模式称昵称(尾段)');
  eq(userTitleForMode('老板', 'work'), '老板', '单名两模式同称');
  eq(userTitleForMode('老板', 'life'), '老板', '单名两模式同称(life)');
  eq(userTitleForMode('', 'work'), '', '空称呼返回空');
  const titledWork = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, aiName: '小灵/灵灵', userTitle: '张明/老板' } }, 'work');
  ok(titledWork.includes('你称用户为"张明"') && !titledWork.includes('你称用户为"老板"'), '工作注入正式名称呼');
  const titledLife = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, aiName: '小灵/灵灵', userTitle: '张明/老板' } }, 'life');
  ok(titledLife.includes('你称用户为"老板"') && !titledLife.includes('你称用户为"张明"'), '生活注入昵称称呼');
  // aiTitle 自带句尾标点时不再补句号
  const punct = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, aiName: '灵灵', aiTitle: '拜上。' } }, 'life');
  ok(punct.includes('拜上。') && !punct.includes('。。'), '句尾标点去重');

  // 代词:默认「她」;预设不含「祂」(中文里祂专指神祇 —— 放进预设等于替用户宣称神性);自定义不受限
  eq(DEFAULT_SETTINGS.persona.pronoun, '她', '代词默认=她');
  eq(PRONOUN_PRESETS.join('/'), '她/他/TA/它', '代词预设 = 她/他/TA/它');
  ok(!PRONOUN_PRESETS.includes('祂'), '预设刻意不含「祂」');
  eq(pronounOf(DEFAULT_SETTINGS), '她', 'pronounOf 默认回退=她');
  eq(pronounOf({ persona: { pronoun: '  他 ' } }), '他', 'pronounOf 去空白');
  eq(pronounOf({ persona: { pronoun: '' } }), '她', 'pronounOf 空串回退');
  eq(pronounOf({ persona: { pronoun: '祂' } }), '祂', '自定义「祂」可透传(不禁止,只是不预设)');
  eq(pronounOf({ persona: { pronoun: '一二三四五六七八' } }), '一二三四五六', 'pronounOf 限长 6 字');
  eq(pronounize('她是器灵,让她自己说', '她'), '她是器灵,让她自己说', 'pronounize 默认不改动');
  eq(pronounize('她是器灵,让她自己说', '他'), '他是器灵,让他自己说', 'pronounize 按设定替换');
  eq(pronounize('她是器灵', ''), '她是器灵', 'pronounize 空代词不改动');

  const fish = assemblePersona({
    ...DEFAULT_SETTINGS,
    persona: {
      ...DEFAULT_SETTINGS.persona,
      aiName: '灵灵', userTitle: '老板', aiTitle: '寄居在用户设备中的器灵',
      tone: 'literary', hardRules: ['引用历史记忆必须注明出处'],
      bottomLines: ['绝不编造历史记忆'], extraLore: '与用户相识于 2025 年初。',
    },
    styles: { ...DEFAULT_SETTINGS.styles, life: '更有温度。' },
    mode: { ...DEFAULT_SETTINGS.mode, lastMode: 'life' },
  }, 'life');
  ok(fish.includes('[身份·灵灵]'), '身份段标题取自称首段');
  ok(fish.includes('你是"灵灵"'), '自称生效');
  ok(!fish.includes('存身于'), '注入面不再重复平台名(瘦身)');
  ok(fish.includes('你称用户为"老板"'), '称呼生效');
  ok(!fish.includes('铁律'), '不再出现 铁律 措辞');
  ok(fish.includes('底线:') && fish.includes('绝不编造历史记忆'), '底线段生效(在规矩前)');
  ok(fish.indexOf('底线:') < fish.indexOf('[规矩]'), '底线在规矩之前');
  ok(fish.includes('[规矩]') && fish.includes('引用历史记忆必须注明出处'), '规矩段生效');
  ok(fish.includes('[设定]') && fish.includes('2025 年初'), 'extraLore 生效');
  ok(fish.includes('[生活模式]'), '模式风格块生效');
  const firstSeg = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, aiName: '小灵/灵灵' } }, 'life');
  ok(firstSeg.includes('[身份·小灵]'), '“小灵/灵灵”标题取首段=小灵');
  const work = assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, aiName: '灵灵' } }, 'work');
  ok(work.includes('[工作模式]') && work.includes('克制'), '工作风格块生效');
  eq(assemblePersona({ ...DEFAULT_SETTINGS, persona: { ...DEFAULT_SETTINGS.persona, enabled: false } }, 'life'), '', 'enabled=false 输出空');
  // 语气基线随模式切换(P0):toneWork/toneLife 空 = 跟随 tone
  const tp = {
    ...DEFAULT_SETTINGS,
    persona: { ...DEFAULT_SETTINGS.persona, aiName: '灵灵', tone: 'natural', toneWork: 'concise', toneLife: '' },
  };
  const toneWorkText = assemblePersona(tp, 'work');
  const toneLifeText = assemblePersona(tp, 'life');
  ok(toneWorkText.includes('直接、精炼,少铺垫,结论先行'), '工作模式用 toneWork(concise)');
  ok(toneLifeText.includes('亲切自然'), '生活模式跟随 tone(natural)');
  ok(!toneWorkText.includes('亲切自然'), '工作模式不混入 natural');
}

// ---------------------------------------------------------------- seal 定型锁
await section('seal 定型锁(承诺句·明文)');
{
  const { sealOk, KEY_MIN } = await imp('lib/host/seal.js');
  const key = '我将会不移本心不改真心地只修改少量缺陷';
  ok(key.length >= KEY_MIN, '测试承诺句 ≥' + KEY_MIN + ' 字');
  const noLock = sealOk({ sealed: false }, 'x');
  ok(noLock.pass === true && !noLock.adoptKey, '未定型无校验');
  const pNoPhrase = { sealed: true, sealPhrase: '' };
  ok(!sealOk(pNoPhrase, '123').pass, '旧档案无明文:过短拒绝');
  const adopt = sealOk(pNoPhrase, '1234567890');
  ok(adopt.pass && adopt.adoptKey === '1234567890', '旧档案无明文:≥' + KEY_MIN + ' 字采纳为承诺');
  const pKey = { sealed: true, sealPhrase: key };
  ok(!sealOk(pKey, key.slice(1)).pass, '错误承诺句拒绝');
  const g = sealOk(pKey, key);
  ok(g.pass === true && !g.adoptKey, '正确承诺句放行且不重设');
  ok(!sealOk(pKey, '   ').pass, '空白拒绝');
  ok(!sealOk(pKey, key + '。').pass, '句末多一字也拒绝(逐字比对)');
}

// ---------------------------------------------------------------- freeze
await section('FreezeGate(D4)');
{
  const { FreezeGate } = await imp('lib/host/freeze.js');
  const flushed = [];
  const g = new FreezeGate({ onFlush: (sid, st) => flushed.push([sid, !!st.snapStale]) });
  g.ensure('s1', { mode: 'life' });
  let aRan = false;
  const a = g.act('s1', () => { aRan = true; });
  ok(a.applied === true && !a.queued && aRan, 'idle 时立即应用');
  g.setRunning('s1', true);
  let bRan = false;
  const b = g.act('s1', () => { bRan = true; });
  ok(!b.applied && b.queued && g.pendingCount('s1') === 1 && !bRan, 'running 时排队');
  g.markSnapStale('s1');
  ok(g.snapshotOf('s1').stale, 'stale 标记生效');
  const flipped = g.setRunning('s1', false);
  ok(flipped === true, 'running→idle 触发 flush');
  ok(g.pendingCount('s1') === 0 && bRan, '边界执行了排队 op');
  ok(flushed.length === 1 && flushed[0][1] === true, 'onFlush 携带 stale 状态');
  // enqueueIfRunning
  g.setRunning('s2', true);
  const queued = g.enqueueIfRunning('s2', () => {});
  ok(queued === true, 'enqueueIfRunning running=true');
  g.setRunning('s2', false);
  ok(g.pendingCount('s2') === 0, 'flush 清空 pending');
}

// ---------------------------------------------------------------- memory
await section('MemoryStore + export/import');
{
  const { MemoryStore } = await imp('lib/host/memory.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-test-'));
  const db = new MemoryStore(join(dir, 'm.db'));
  db.upsertOverview({ source: 'dsweb', conv_id: 'a1', title: '项目讨论', domain_tags: ['工作-物理'], category: 'knowledge', keywords: ['弹簧'], summary: '模拟器', overview_ok: true, heat: 5 });
  db.upsertOverview({ source: 'dsweb', conv_id: 'a2', title: '深夜情绪', category: 'feeling', overview_ok: true });
  eq(db.listOverviews({ onlyOk: true }).length, 2, 'overview 两条');
  db.appendRawTurn('sess-x', { seq: 1, role: 'user', ts: null, model: null, text: '你好' });
  db.appendRawTurn('sess-x', { seq: 2, role: 'assistant', ts: null, model: 'deepseek-reasoner', text: '你好呀' });
  eq(db.rawTurnCount('sess-x'), 2, 'raw turns');
  eq(db.rawSessionCount(), 1, 'raw sessions');
  const bundle = db.exportBundle({ includeRaw: true });
  eq(bundle.format, 'dsh-ling-memory', 'export 格式');
  ok(bundle.overviews.length === 2 && bundle.rawTurns.length === 2, 'export 内容');

  const db2 = new MemoryStore(join(dir, 'm2.db'));
  const rep1 = db2.importBundle(bundle);
  eq(rep1.added, 2, 'import 新增 2');
  const rep2 = db2.importBundle(bundle);
  eq(rep2.skipped, 2, '重复导入跳过 2');
  db2.upsertOverview({ source: 'dsweb', conv_id: 'a1', title: '项目讨论 v2', category: 'knowledge', overview_ok: true });
  const rep3 = db2.importBundle(bundle, { overwrite: true });
  eq(rep3.overwritten, 2, 'overwrite 覆盖 2');
  const bad = db2.importBundle({ format: 'other' });
  eq(bad.errors, 1, '非法包报错');
  ok(db2.fingerprint().length === 64, '指纹');
  // 人格快照修剪回归(2026-09-07 真机 bug:sqlite 行是空原型对象,裸 .sort()/kvDel(行) 抛
  // 'Cannot convert object to primitive value';现按 key 排序、按 key 删除)
  for (let i = 0; i < 34; i++) {
    db.kvSet(`persona.hist.${1700000000000 + i}`, JSON.stringify({ n: i }));
  }
  const hists = db.kvList('persona.hist.').map((r) => String(r.key)).sort();
  eq(hists.length, 34, '34 份快照列出');
  let rawSortThrows = false;
  try {
    const rows = db.kvList('persona.hist.');
    rows.sort();
  } catch { rawSortThrows = true; }
  if (Object.getPrototypeOf(db.kvList('persona.hist.')[0]) === null) {
    ok(rawSortThrows, '空原型行上裸 sort 必须抛(否则 map-key 修复会退化)');
  }
  while (hists.length > 30) db.kvDel(hists.shift());
  eq(db.kvList('persona.hist.').length, 30, '按 key 修剪到 30 份');
  db.close(); db2.close();
}

// ---------------------------------------------------------------- dsweb 扫描
await section('dsweb 扫描(增量,幂等)');
{
  const { MemoryStore } = await imp('lib/host/memory.js');
  const { scanIntoMemory, readDswebRows } = await imp('lib/host/scan-dsweb.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-scan-'));
  const { DatabaseSync } = await import('node:sqlite');
  const srcPath = join(dir, 'deepseek_library.db');
  const src = new DatabaseSync(srcPath);
  src.exec('CREATE TABLE conversations (idx INTEGER, conv_id TEXT, title TEXT, inserted_at TEXT, updated_at TEXT, n_user INTEGER);');
  src.exec("CREATE TABLE messages (conv_id TEXT, seq INTEGER, role TEXT, text TEXT);");
  src.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run(1, 'c1', '镍钴高熵合金热处理', '2025-01-01T10:00:00.000Z', '2025-01-02T10:00:00.000Z', 3);
  src.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run(2, 'c2', '深夜情绪碎碎念', '2025-02-01T10:00:00.000Z', '2025-02-01T10:00:00.000Z', 2);
  src.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('c1', 1, 'USER', '想算一下固溶时间对硬度的关系');
  src.prepare('INSERT INTO messages VALUES (?,?,?,?)').run('c2', 1, 'USER', '睡不着,脑子里全是声音');
  src.close();
  const r = readDswebRows(srcPath);
  eq(r.sourceTotal, 2, '源库读取 2 个会话');
  eq(r.rows.length, 2, '全部生成 overview 行');
  ok(r.rows.find((x) => x.conv_id === 'c1').category === 'knowledge', 'c1 判为 knowledge');
  ok(r.rows.find((x) => x.conv_id === 'c2').category === 'feeling', 'c2 判为 feeling');
  ok(r.rows[0].keywords.length > 0, '首问文本参与关键词');
  const mem = new MemoryStore(join(dir, 'mem.db'));
  const s1 = scanIntoMemory(mem, srcPath);
  eq(s1.added, 2, '首次扫描全部新增');
  eq(s1.total, 2, '库内 dsweb 共 2');
  // 源库新增一个会话,再扫 → 只增 1,已有 2 条只刷新元数据
  const src2 = new DatabaseSync(srcPath);
  src2.prepare('INSERT INTO conversations VALUES (?,?,?,?,?,?)').run(3, 'c3', '买菜清单', '2025-03-01T10:00:00.000Z', '2025-03-01T10:00:00.000Z', 1);
  src2.close();
  const s2 = scanIntoMemory(mem, srcPath);
  eq(s2.added, 1, '二次扫描只新增 c3');
  eq(s2.refreshed, 2, '已有两条元数据刷新');
  eq(s2.total, 3, '库内 dsweb 共 3');
  // 幂等:summary/importance 用户态不被扫描覆盖
  mem.upsertOverview({ source: 'dsweb', conv_id: 'c3', title: '买菜清单', category: 'daily', summary: '深摘或用户摘要', importance: 1.2, overview_ok: true });
  const s3 = scanIntoMemory(mem, srcPath);
  const row = mem.db.prepare("SELECT summary, importance FROM conv_overview WHERE source='dsweb' AND conv_id='c3'").get();
  eq(row.summary, '深摘或用户摘要', '扫描不覆盖本地 summary');
  eq(Number(row.importance), 1.2, '扫描不覆盖本地 importance');
  eq(s3.added, 0, '第三次无新增');
  let missing = false;
  try { readDswebRows(join(dir, 'nope.db')); } catch (e) { missing = true; }
  ok(missing, '源库不存在报错');
  mem.close();
}

// ---------------------------------------------------------------- l1
await section('L1 选择');
{
  const { MemoryStore } = await imp('lib/host/memory.js');
  const { selectL1, formatL1Section } = await imp('lib/host/l1.js');
  const { DEFAULT_SETTINGS } = await imp('lib/host/persona.js');
  const cw = DEFAULT_SETTINGS.memory.categoryWeights; // work:{knowledge:1,daily:.3,feeling:.1} life:{knowledge:.2,daily:.6,feeling:1}
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-l1-'));
  const db = new MemoryStore(join(dir, 'm.db'));
  const now = Date.now();
  const iso = (d) => new Date(now - d * 864e5).toISOString();
  db.upsertOverview({ source: 'dsweb', conv_id: 'k1', title: '镍钴基高熵合金固溶时间', started_at: iso(5), updated_at: iso(5), category: 'knowledge', keywords: ['镍钴', '固溶'], summary: '热处理工艺研究。', overview_ok: true, heat: 3 });
  db.upsertOverview({ source: 'dsh', conv_id: 'f1', title: '夜里胡思乱想', started_at: iso(2), updated_at: iso(2), category: 'feeling', keywords: ['失眠'], summary: '想了很多。', overview_ok: true });
  db.upsertOverview({ source: 'dsweb', conv_id: 'd1', title: '买菜清单', started_at: iso(30), updated_at: iso(30), category: 'daily', overview_ok: true });
  const life = selectL1(db, { mode: 'life', categoryWeights: cw, maxItems: 5, budgetChars: 4000 });
  ok(life.items.length >= 1 && life.items[0].conv_id === 'f1', 'life 模式优先 feeling(近期)');
  const work = selectL1(db, { mode: 'work', categoryWeights: cw, maxItems: 5, budgetChars: 4000 });
  ok(work.items[0].conv_id === 'k1', 'work 模式优先 knowledge(词条命中权重)');
  const kw = selectL1(db, { mode: 'life', categoryWeights: cw, keywords: ['镍钴'], maxItems: 5, budgetChars: 4000 });
  ok(kw.items.some((i) => i.conv_id === 'k1'), '关键词预筛能把 life 下的知识会话拉进来');
  const fmt = formatL1Section(work);
  ok(fmt.includes('[记忆·开场]') && fmt.includes('k1'.slice(0, 8)), '格式化含来源');
  db.close();
}

// ---------------------------------------------------------------- settings
await section('SettingsFile');
{
  const { SettingsFile } = await imp('lib/host/settings-file.js');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ling-set-'));
  const s = new SettingsFile(dir);
  eq(s.get().mode.lastMode, 'life', '默认 life');
  await s.update({ mode: { lastMode: 'work' }, persona: { aiName: '灵灵' } });
  eq(s.get().mode.lastMode, 'work', 'update 生效');
  eq(s.get().persona.aiName, '灵灵', '深度合并');
  const s2 = new SettingsFile(dir);
  eq(s2.get().mode.lastMode, 'work', '持久化读回');
  eq(s2.get().persona.tone, 'natural', '缺省字段保留');
}

// ---------------------------------------------------------------- client
await section('client 契约形状 + apply 桩');
{
  const src = readFileSync(join(root, 'lib/client.js'), 'utf8');
  ok(src.includes('window.__ModuleLoader__.load'), 'client 经 ModuleLoader 装载');
  // 最小 DOM/fetch 桩环境
  const elStub = () => ({
    style: {}, dataset: {}, children: [], textContent: '', className: '', id: '',
    appendChild(c) { this.children.push(c); return c; }, remove() {},
    addEventListener() {}, removeEventListener() {}, click() {}, setAttribute() {},
  });
  const doc = {
    createElement: elStub,
    createStyleSheet: () => ({ cssRules: [] }),
    documentElement: { getAttribute: () => 'light' },
    head: { appendChild() {} },
    body: { appendChild: elStub().appendChild.bind(elStub()) },
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
  const win = {
    __ModuleLoader__: { load(opts) { win.loaded = opts; } },
    addEventListener() {}, removeEventListener() {},
  };
  let reactCalls = 0;
  const react = {
    createElement: () => ({ tag: 'x' }),
    useEffect: (fn) => { try { const r = fn(); if (typeof r === 'function') { r(); } } catch {} },
  };
  const requireStub = (id) => (id === 'react' ? react : {});
  const ctx = {
    slots: {
      inject(name, gen) { (ctx.injected = ctx.injected || []).push(name); },
      register() { return () => {}; },
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d() : undefined; },
  };
  // 以 vm 执行(全局补 window/document)
  const { contextify } = await imp('tests/vm-light.mjs');
  const out = await contextify(src, { window: win, document: doc, fetch: async () => ({ json: async () => ({ ok: true, sessionId: 't1', mode: 'life', running: false, pending: 0, persona: {}, memory: { overviews: 0, rawTurnSessions: 0, l1: null }, l0PreviewText: '' }), blob: async () => new Blob() }) });
  ok(out && out.name === 'dsh-ling', 'client 导出 name');
  ok(typeof out.apply === 'function', 'client 导出 apply');
  ok(Array.isArray(out.inject) && out.inject.includes('slots'), 'client 导出 inject 服务声明(slots)');
  ok(src.includes('HOVER_MS = 1500') && src.includes('onMouseEnter') && src.includes('onMouseLeave'), '悬停 1.5s 菜单交互存在');
  ok(!/onContextMenu[^,]*openMenu/.test(src), '不再用右键打开菜单');
  // apply 桩执行:不应抛错(内部 slot 注册尝试)
  let threw = null;
  try { out.apply(ctx); } catch (e) { threw = e; }
  eq(threw, null, 'apply 在桩环境下不抛错');
  ok(Array.isArray(ctx.injected), 'slots.inject 被调用');
  ok(ctx.injected.includes('conversation.session.header.utilities'), '注入了会话头工具槽');
  ok(ctx.injected.includes('sidebar.footer.action'), '注入了侧栏底栏(全局默认)槽');
}

summary();
