// tests/library-client.test.mjs — 1.7 图书馆(图书馆标签)**执行级**测试
//
// 口径(派单要求):
//   · 只读**真实源码** lib/client.js:用假 DOM 调 `__test__.openMemoryCenter()` → 点标签 → 点按钮,
//     走的是与真人点击**同一条**代码路径。源码正则护栏另放 §13,只用于执行级观测不到的事实
//     (例如"整个文件不许出现 innerHTML 写入")。
//   · 零真实网络:`fetch` 是本地桩,记录每一次请求并按路径回放受控回执;所有 URL 都断言只落在
//     本插件前缀 `/api/dsh-ling` 上。
//   · 不动生产代码,也不改 tests/vm-light.mjs 与其他测试(沙箱白名单照旧,本文件在**测试侧**补齐 DOM 面)。
// 证据边界(如实说明,不夸大):
//   · **真浏览器没跑过**(没有 3080 上的截图/手工验收)。这里是"够用"的假 DOM:appendChild /
//     textContent / classList / addEventListener 按浏览器语义实现,但**不做 CSS 布局、不做事件冒泡**
//     ⇒ 点按钮 = 直调它挂在该节点上的 `onclick`(等同真实点击抵达处理器那一步),并显式给出
//     stopPropagation/preventDefault 空实现。
//   · "没有 innerHTML 写入"是**真检测**:假 DOM 的 innerHTML setter 会记账,§5/§13 都查它。
import { readFileSync } from 'node:fs';
import { ok, eq, section, summary } from './harness.mjs';
import { contextify } from './vm-light.mjs';

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// ─────────────────────────── 迷你 DOM(浏览器语义的子集) ───────────────────────────
let innerHTMLWrites = [];
function mkEvent(target, over) {
  return Object.assign({
    type: 'click', target, currentTarget: target, key: '', code: '',
    stopPropagation() {}, preventDefault() {},
  }, over || {});
}
class FakeText {
  constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}
class FakeEl {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = Object.create(null);
    this.style = {};
    this.dataset = {};
    this._listeners = Object.create(null);
    this.className = '';
    this.id = '';
    this.value = '';
    this.disabled = false;
    this.type = '';
    this.placeholder = '';
    this.tabIndex = 0;
    this.title = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.onclick = null; this.oninput = null; this.onchange = null; this.onkeydown = null;
    this.onmouseenter = null; this.onmouseleave = null; this.onscroll = null;
    this.__lingCleanup = null; this.__lingScroll = null;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { let s = ''; for (const c of this.childNodes) s += c.textContent; return s; }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v === null || v === undefined || v === '') return;
    this.appendChild(new FakeText(v));
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    const i = this.childNodes.indexOf(ref);
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  dispatch(t, ev) { for (const fn of (this._listeners[t] || []).slice()) fn(ev || mkEvent(this, { type: t })); }
  get classList() {
    const self = this;
    const list = () => String(self.className).split(/\s+/).filter(Boolean);
    return {
      add(...cs) { const l = list(); for (const c of cs) if (!l.includes(c)) l.push(c); self.className = l.join(' '); },
      remove(...cs) { self.className = list().filter((c) => !cs.includes(c)).join(' '); },
      contains(c) { return list().includes(c); },
      toggle(c) { if (list().includes(c)) this.remove(c); else this.add(c); },
    };
  }
  closest(sel) { let n = this; while (n) { if (n.nodeType === 1 && matchesSel(n, sel)) return n; n = n.parentNode; } return null; }
  querySelector(sel) { const r = walk(this, sel, true); return r[0] || null; }
  querySelectorAll(sel) { return walk(this, sel, false); }
  click() { if (typeof this.onclick === 'function') this.onclick(mkEvent(this)); }
  focus() {} blur() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get innerHTML() { return this.textContent; }
  // ⚠️ 这一行是**探针**:client.js 一旦用 innerHTML 插入内容,这里就记账(§13 断言它为 0)。
  set innerHTML(v) { innerHTMLWrites.push({ tag: this.tagName, value: String(v).slice(0, 80) }); this.textContent = v; }
}
function selList(sel) { return String(sel).split(',').map((s) => s.trim()).filter(Boolean); }
function matchesSel(node, sel) {
  if (node.nodeType !== 1) return false;
  return selList(sel).some((part) => {
    const m = /^([a-zA-Z*]+)?((?:\.[^.\s]+)*)$/.exec(part);
    if (!m) return false;
    const tag = m[1] && m[1] !== '*' ? m[1].toUpperCase() : null;
    const classes = (m[2] || '').split('.').filter(Boolean);
    if (tag && node.tagName !== tag) return false;
    const have = String(node.className).split(/\s+/).filter(Boolean);
    return classes.every((c) => have.includes(c));
  });
}
function walk(root, sel, first) {
  const out = [];
  const queue = root.childNodes.slice();
  while (queue.length) {
    const n = queue.shift();
    if (n.nodeType !== 1) continue;
    if (matchesSel(n, sel)) { out.push(n); if (first) return out; }
    for (const c of n.childNodes) queue.push(c);
  }
  return out;
}
function allEls(root, out) {
  const acc = out || [];
  for (const c of root.childNodes) if (c.nodeType === 1) { acc.push(c); allEls(c, acc); }
  return acc;
}

const doc = {
  createElement: (t) => new FakeEl(t),
  createTextNode: (v) => new FakeText(v),
  createStyleSheet: () => ({ cssRules: [] }),
  documentElement: new FakeEl('html'),
  head: new FakeEl('head'),
  body: new FakeEl('body'),
  getElementById(id) {
    const all = allEls(doc.head).concat(allEls(doc.body));
    return all.find((e) => e.id === id) || null;
  },
  querySelector(sel) { const r = walk(doc.body, sel, true); return r[0] || null; },
  querySelectorAll(sel) { return walk(doc.body, sel, false); },
  addEventListener() {}, removeEventListener() {},
};
doc.documentElement.setAttribute('data-theme', 'light');

// ─────────────────────────── fetch 桩(记录 + 受控回放) ───────────────────────────
const calls = [];
let respond = () => ({ ok: true });
let confirmAnswer = true;
const confirmCalls = [];
const windowObj = {
  addEventListener() {}, removeEventListener() {},
  innerHeight: 900, innerWidth: 1400,
  confirm(msg) { confirmCalls.push(String(msg)); return confirmAnswer; },
};
function pathOf(rec) { return rec.url.replace('/api/dsh-ling', ''); }
function qsOf(rec, key) {
  const m = new RegExp('[?&]' + key + '=([^&]*)').exec(rec.url);
  return m ? decodeURIComponent(m[1]) : null;
}
function fetchStub(url, opts) {
  const rec = {
    url: String(url),
    method: (opts && opts.method) || 'GET',
    body: opts && opts.body ? JSON.parse(opts.body) : null,
    headers: (opts && opts.headers) || {},
  };
  calls.push(rec);
  return Promise.resolve()
    .then(() => respond(rec))
    .then((payload) => ({ ok: true, status: 200, json: async () => payload }));
}
function routed(routes) {
  return (rec) => {
    const p = pathOf(rec);
    for (const [prefix, reply] of routes) {
      if (p.startsWith(prefix)) return typeof reply === 'function' ? reply(rec) : reply;
    }
    return { ok: true };
  };
}
function defer() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const out = await contextify(src, { window: windowObj, document: doc, fetch: fetchStub });
const T = out && out.__test__;

await section('§0 测试钩子可达(否则下面每条都无意义)');
ok(!!T, 'exports.__test__ 存在');
ok(!!T && typeof T.openMemoryCenter === 'function', '取到真实 openMemoryCenter(图书馆标签的执行入口)');
if (!T || typeof T.openMemoryCenter !== 'function') {
  console.error('  ✗ 测试钩子不可用:后续断言无意义,立即停');
  summary();
  process.exit(1);
}

// ─────────────────────────── 夹具与操作原语 ───────────────────────────
const A = 'lib:11111111-1111-1111-1111-111111111111';
const B = 'lib:22222222-2222-2222-2222-222222222222';
const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);
function libItem(over) {
  return Object.assign({
    id: A, lineage_id: A, revision: 1, previous_id: null,
    title: '示例资料', body: '正文示例', category: 'standard-value', source_kind: 'manual',
    source_ref: '/tmp/a.txt', as_of: '2026-10-06', version: null, conditions: null,
    check_spec: null, content_hash: HASH_A, state: 'active', superseded_by: null,
    checked_state: '', checked_at: null, withdrawn_at: null, withdrawn_reason: null,
    created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z',
  }, over || {});
}
function statusPayload(over) {
  return Object.assign({
    ok: true, enabled: true, available: true,
    store: {
      ok: true, items: { total: 2, active: 2, superseded: 0, withdrawn: 0, lineages: 2, max_revision: 1 },
      checks: { total: 0, adopted: 0 },
    },
    checker: { closed: false, activeCount: 0, transport: 'native-https', codeRootCount: 0, officialUrlCount: 0 },
  }, over || {});
}
let panel = null;
function openCenter() {
  doc.body.textContent = '';
  calls.length = 0;
  innerHTMLWrites = [];
  confirmCalls.length = 0;
  confirmAnswer = true;
  T.openMemoryCenter();
  panel = doc.body.querySelector('.ling-mc');
  if (!panel) throw new Error('面板没有挂到 document.body');
  return panel;
}
function tabs() { return allEls(panel).filter((e) => String(e.className).split(/\s+/).includes('ling-tab')); }
function tabNamed(name) { return tabs().find((e) => e.textContent.trim() === name) || null; }
function bodyEl() { return panel.querySelector('.mc-body'); }
function bodyText() { return bodyEl().textContent; }
function button(label) {
  return allEls(panel).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label) || null;
}
function buttons(label) { return allEls(panel).filter((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label); }
function clickBtn(label) {
  const b = button(label);
  if (!b) throw new Error('界面上没有按钮:' + label);
  b.onclick(mkEvent(b));
  return b;
}
function clickNode(node) { if (typeof node.onclick === 'function') node.onclick(mkEvent(node)); }
function typeInto(node, v) {
  if (!node) throw new Error('要输入的节点不存在');
  node.value = v;
  if (typeof node.oninput === 'function') node.oninput(mkEvent(node));
}
function field(re) { return allEls(panel).find((e) => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.placeholder && re.test(e.placeholder)) || null; }
function pickSelItem(label) {
  const it = allEls(panel).find((e) => String(e.className).split(/\s+/).includes('ls-item') && e.textContent.trim() === label);
  if (!it) throw new Error('自绘下拉里没有选项:' + label);
  it.onclick(mkEvent(it));
  return it;
}
// ⚠️ 必须按**去掉查询串的路径逐字比**:'/library/checks'(留痕读)也以 '/library/check' 开头,
//    用 startsWith 取 [0] 会拿到留痕那一发 GET,把"核对是 POST"这类断言判成假红(本套件踩过一次)。
function libCalls(p) {
  return calls.filter((c) => {
    const x = pathOf(c).split('?')[0];
    return x === p || x.startsWith(p + '/');
  });
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 6); i++) await tick(); }
async function clickTab(name) {
  const t = tabNamed(name);
  if (!t) throw new Error('没有标签:' + name);
  t.onclick(mkEvent(t));
  await settle();
  return t;
}
async function gotoLibrary(routes) {
  openCenter();
  if (routes) respond = routed(routes);
  await settle(2);
  await clickTab('图书馆');
  return panel;
}

// ─────────────────────────── §1 面板与五个标签 ───────────────────────────
await section('§1 图书馆标签在面板里 / 原四标签保留 / 标题改了');
{
  openCenter();
  await settle(3);
  const h3 = allEls(panel).find((e) => e.tagName === 'H3');
  eq(h3 && h3.childNodes[0] && h3.childNodes[0].textContent, '记忆与数据中心', '§1 中心标题 = 记忆与数据中心');
  ok(h3 && h3.textContent.includes('图书馆'), '§1 标题下的说明提到「图书馆」');
  const labels = tabs().map((t) => t.textContent.trim());
  eq(labels.length, 6, '§1 标签数 = 6(概览/浏览/记忆树/结论层/接入历史/图书馆)');
  eq(labels.join('|'), '概览与数据|记忆浏览|记忆树|结论层|接入历史|图书馆',
    '§1 顺序 = 概览·浏览·记忆树·结论层·接入历史·图书馆(2026-10-16 用户要求:记忆相关的四面挨在一起)');
  ok(tabs()[0].className.includes('on'), '§1 默认仍停在「概览与数据」');
  ok(!tabNamed('图书馆').className.includes('on'), '§1 图书馆默认不高亮');
  // 四个旧标签照旧切换(高亮 + 内容都跟着走)
  await clickTab('记忆浏览');
  ok(tabNamed('记忆浏览').className.includes('on') && !tabNamed('图书馆').className.includes('on'),
    '§1 切到记忆浏览:高亮跟着走');
  ok(/加载中|没有匹配|共 /.test(bodyText()), '§1 记忆浏览仍是原来的内容(未被图书馆顶掉)');
  await clickTab('记忆树');
  ok(/记忆树/.test(bodyText()), '§1 记忆树标签仍是原来的内容');
  await clickTab('接入历史');
  ok(!/图书馆/.test(bodyText()), '§1 接入历史里不该出现图书馆的词');
  const libTab = await clickTab('图书馆');
  ok(libTab.className.includes('on') && !tabNamed('记忆树').className.includes('on'),
    '§1 切到图书馆:高亮与内容同源(高亮不再停在记忆树上)');
  ok(/独立于记忆库|不与记忆条目混排/.test(bodyText()), '§1 图书馆首屏写明"与记忆零混淆"');
  ok(calls.some((c) => pathOf(c) === '/library/status'), '§1 进入图书馆会读一次 /library/status');
  ok(calls.every((c) => c.url.startsWith('/api/dsh-ling')), '§1 所有请求都落在本插件前缀上(没有别的源)');
}

// ─────────────────────────── §2 状态:可用 / 未启用 / 不可用 ───────────────────────────
await section('§2 状态栏:可用 / 未启用 / 不可用 / 读不到(都不与"零命中"混为一谈)');
{
  await gotoLibrary([['/library/status', statusPayload()]]);
  ok(/图书馆可用/.test(bodyText()), '§2 可用:显式说"可用"');
  ok(/条目 2\(有效 2/.test(bodyText()), '§2 可用:报出条目统计(取自 store.stats)');
  ok(/裁判员就绪/.test(bodyText()) && /传输 native-https/.test(bodyText()), '§2 可用:报出裁判员状态与传输');
  ok(/核对只认证声明的那一处比较/.test(bodyText()), '§2 可用:口径行照写"只认证声明的那一处比较"');

  await gotoLibrary([['/library/status', statusPayload({ enabled: false })]]);
  ok(/图书馆未启用/.test(bodyText()) && /不受影响/.test(bodyText()), '§2 未启用:显式 + 说明记忆不受影响');
  ok(!/图书馆可用/.test(bodyText()), '§2 未启用不说"可用"');

  await gotoLibrary([['/library/status', statusPayload({ available: false, reason: 'db_unavailable', message: '打不开 library.db' })]]);
  ok(/图书馆不可用/.test(bodyText()) && /打不开 library.db/.test(bodyText()), '§2 不可用:带后端的 message 与 reason');
  ok(/db_unavailable/.test(bodyText()), '§2 不可用:机器码也照写(reason 不是散文)');

  await gotoLibrary([['/library/status', { ok: false, reason: 'library_disabled', message: '运行时没装配图书馆' }]]);
  ok(/图书馆不可用/.test(bodyText()) && /运行时没装配图书馆/.test(bodyText()), '§2 ok:false 也当不可用,原样给 message');

  respond = routed([['/library/status', () => { throw new Error('gateway down'); }]]);
  openCenter();
  await settle(2);
  await clickTab('图书馆');
  ok(/图书馆状态读不到/.test(bodyText()), '§2 状态拉不到:如实说"读不到"');
  ok(/而不是"图书馆是空的"/.test(bodyText()), '§2 读不到 ≠ 空库(文案里点明)');
}

// ─────────────────────────── §3 空库 / 无查询 / 空结果 三种"没有"分开说 ───────────────────────────
await section('§3 空库、无查询、检索无命中 —— 三种"没有"必须能分辨');
{
  await gotoLibrary([
    ['/library/status', statusPayload({ store: { ok: true, items: { total: 0, active: 0, superseded: 0, withdrawn: 0 }, checks: { total: 0, adopted: 0 } } })],
  ]);
  ok(/还没有资料/.test(bodyText()), '§3 空库(items.total=0):说"还没有资料"');
  ok(/不预置种子资料/.test(bodyText()) && /也不从记忆库迁移/.test(bodyText()),
    '§3 空库:明确说"不预置、不迁移"');
  ok(libCalls('/library/search').length === 0, '§3 空库:没有乱发检索请求');

  await gotoLibrary([
    ['/library/status', statusPayload({ store: { ok: true, items: { total: 5, active: 3, superseded: 1, withdrawn: 1 }, checks: { total: 0, adopted: 0 } } })],
  ]);
  ok(/还没有查询/.test(bodyText()), '§3 有资料但没查询:说"还没有查询"(不是"没有资料")');
  ok(/现有 5 条/.test(bodyText()), '§3 借用 status 的精确统计说明库里有 5 条(含历史版本)');

  // 空关键词点查询:客户端先拦,不发那个注定是 invalid_query 的请求
  const before = calls.length;
  clickBtn('查询');
  await settle(3);
  eq(calls.length, before, '§3 空关键词:一个请求都不发');
  ok(/不接受空查询/.test(bodyText()), '§3 空关键词:行内说明为什么(空查询不是检索)');
  ok(!/没有匹配/.test(bodyText()), '§3 空关键词**不**说成"没有匹配"(那会把参数错误伪装成没数据)');

  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  typeInto(field(/搜索标题/), 'zzz');
  clickBtn('查询');
  await settle(4);
  ok(/没有匹配「zzz」的资料/.test(bodyText()), '§3 检索无命中:说"没有匹配 zzz"');
  ok(/不代表图书馆是空的/.test(bodyText()), '§3 检索无命中:点明≠空库');
  eq(libCalls('/library/search').length, 1, '§3 常规查询只发一次');
  eq(qsOf(libCalls('/library/search')[0], 'q'), 'zzz', '§3 q 进了查询串');
  eq(qsOf(libCalls('/library/search')[0], 'limit'), '20', '§3 limit 进查询串');
  eq(qsOf(libCalls('/library/search')[0], 'offset'), '0', '§3 offset 进查询串');
}

// ─────────────────────────── §4 分页:只用 count/nextOffset/truncated,不造伪总数 ───────────────────────────
await section('§4 分页(无伪总数)');
{
  const page1 = [];
  for (let i = 0; i < 20; i++) page1.push(libItem({ id: 'lib:3333333' + String(i).padStart(3, '0') + '-3333-3333-3333-333333333333', title: '第' + (i + 1) + '条' }));
  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, query: 'q', items: page1, count: 20, offset: 0, limit: 20, nextOffset: 20, truncated: true }],
  ]);
  typeInto(field(/搜索标题/), 'a b');
  clickBtn('查询');
  await settle(4);
  ok(/第1条/.test(bodyText()) && /第20条/.test(bodyText()), '§4 第一页 20 条都画出来了');
  ok(/本页 20 条 · 偏移 0/.test(bodyText()), '§4 如实说"本页 20 条 · 偏移 0"');
  ok(/还有更多\(下一批从 20 开始\)/.test(bodyText()), '§4 截断时给出下一批的起点');
  ok(!/共\s*20\s*条/.test(bodyText()) && !/共\s*\d+\s*条/.test(bodyText()),
    '§4 ★回执没给 total,界面就不许出现"共 N 条"');
  eq(qsOf(libCalls('/library/search')[0], 'q'), 'a b', '§4 关键词里的空格被正确编码/解码');

  // 下一页 → 用 nextOffset
  clickBtn('下一页');
  await settle(4);
  const s2 = libCalls('/library/search')[1];
  ok(!!s2, '§4 点了下一页确实又发了一次检索');
  eq(qsOf(s2, 'offset'), '20', '§4 下一页用的是回执给的 nextOffset,不是自己 +limit 猜的');

  // 末页:nextOffset=null → 下一页禁用
  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [libItem({ title: '最后一条' })], count: 1, offset: 40, limit: 20, nextOffset: null, truncated: false }],
  ]);
  typeInto(field(/搜索标题/), 'z');
  clickBtn('查询');
  await settle(4);
  ok(/最后一条/.test(bodyText()), '§4 末页内容画出来了');
  ok(/没有更多了/.test(bodyText()), '§4 末页说"没有更多了"');
  ok(button('下一页').disabled === true, '§4 末页:下一页按钮禁用');
  ok(button('上一页').disabled === true || button('上一页').disabled === false, '§4 上一页按钮在场');
  // offset>0 时的上一页:回 offset-limit
  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [libItem()], count: 1, offset: 20, limit: 20, nextOffset: 40, truncated: true }],
  ]);
  typeInto(field(/搜索标题/), 'z');
  clickBtn('查询');
  await settle(4);
  ok(button('上一页').disabled === false, '§4 offset=20 时上一页可用');
  clickBtn('上一页');
  await settle(4);
  eq(qsOf(libCalls('/library/search')[1], 'offset'), '0', '§4 上一页回到 offset-limit(夹在 0)');
}

// ─────────────────────────── §5 资料文本一律字面渲染(XSS) ───────────────────────────
await section('§5 字面文本:标题/正文/出处里的 HTML 只能是字符,不能变成节点');
{
  const XSS = '<img src=x onerror="window.__pwned=1">';
  const SCRIPT = '<script>window.__pwned=2</script>';
  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/search', {
      ok: true,
      items: [libItem({ title: XSS, body: SCRIPT, source_ref: '/tmp/' + XSS })],
      count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false,
    }],
  ]);
  typeInto(field(/搜索标题/), 'x');
  clickBtn('查询');
  await settle(4);
  ok(bodyText().includes(XSS), '§5 标题里的 <img onerror> 原样出现在文本里(是可读字符)');
  ok(bodyText().includes('/tmp/' + XSS), '§5 source_ref 里的同一串也是字面文本');
  ok(!bodyText().includes(SCRIPT), '§5 列表行只搬标题与出处,不搬正文(正文在详情里显示)');
  eq(allEls(panel).filter((e) => e.tagName === 'IMG').length, 0, '§5 ★没有 IMG 元素被造出来');
  eq(allEls(panel).filter((e) => e.tagName === 'SCRIPT').length, 0, '§5 ★没有 SCRIPT 元素被造出来');
  eq(innerHTMLWrites.length, 0, '§5 ★全程没有一次 innerHTML 写入');

  // 详情视图 + 证据里的 HTML 同样只是文本
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/item', { ok: true, found: true, item: libItem({ title: XSS, body: SCRIPT, check_spec: { locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x', comparison: 'exact' } }) }],
    ['/library/history', { ok: true, item_id: A, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [{ id: A, revision: 1, is_current: true, state: 'active', checked_state: '', created_at: '2026-10-06T00:00:00.000Z', check_count: 1, content_hash: HASH_A }], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [{ check_sequence: 1, state: 'ok', checked_at: '2026-10-06T01:00:00.000Z', adopted: true, item_hash: HASH_A }], count: 1, offset: 0, limit: 20, total: 1, nextOffset: null, truncated: false }],
  ]);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);
  ok(bodyText().includes(XSS) && bodyText().includes(SCRIPT), '§5 详情视图同样字面渲染标题/正文');
  ok(/修订链/.test(bodyText()) && /本谱系共 1 个版本/.test(bodyText()), '§5 详情页带修订链');
  ok(/核对留痕/.test(bodyText()) && /共 1 次核对/.test(bodyText()), '§5 详情页带核对留痕(checks 的精确 total 可以照写)');
  eq(allEls(panel).filter((e) => e.tagName === 'IMG').length, 0, '§5 详情视图里也没有 IMG 元素');
  eq(innerHTMLWrites.length, 0, '§5 详情视图也没有 innerHTML 写入');

  // 后端 message 里的 HTML
  clickBtn('← 返回列表');
  await settle(2);
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: false, reason: 'library_unavailable', message: '<b>库打不开</b>' }],
  ]);
  typeInto(field(/搜索标题/), 'q');
  clickBtn('查询');
  await settle(4);
  ok(bodyText().includes('<b>库打不开</b>'), '§5 失败回执里的 HTML 也是字面文本');
  eq(allEls(panel).filter((e) => e.tagName === 'B').length, 0, '§5 没有 B 元素被造出来');
}

// ─────────────────────────── §6 新建:必填/JSON 校验在提交前 ───────────────────────────
await section('§6 新建表单:必填与 JSON 在**提交前**报错,且不抹掉已填内容');
{
  await gotoLibrary([['/library/status', statusPayload()]]);
  clickBtn('＋ 新建资料');
  await settle(2);
  ok(/新建资料/.test(bodyText()), '§6 打开新建表单');
  ok(!!field(/这条资料叫什么/), '§6 title 输入框在场');
  ok(!!field(/正文。/), '§6 body 文本域在场');
  ok(!!field(/our-code: \/abs\/path/), '§6 source_ref 输入框在场');
  ok(!!field(/2026-10-06 或/), '§6 as_of 输入框在场');
  ok(!!field(/留空 = 不声明版本/), '§6 version 输入框在场');
  ok(!!field(/platform/), '§6 conditions 输入框在场');

  // 空表单直接提交:一个请求都不发,并逐项点名
  const before = calls.length;
  clickBtn('新建');
  await settle(3);
  eq(calls.length, before, '§6 必填没填:不发请求');
  ok(/没有发出任何请求/.test(bodyText()), '§6 明说"没有发出任何请求"');
  ok(/title 必填/.test(bodyText()) && /body 必填/.test(bodyText()), '§6 点名 title/body 必填');
  ok(/source_ref 必填/.test(bodyText()) && /as_of 必填/.test(bodyText()), '§6 点名 source_ref/as_of 必填');
  ok(/提交前检查/.test(bodyText()), '§6 这段是"提交前检查"里的,不是提交后的回执');

  // 填一半 + as_of 形状不对:内容不被抹掉
  typeInto(field(/这条资料叫什么/), '镍基合金固溶温度');
  typeInto(field(/正文。/), '固溶温度 1050 ℃。');
  typeInto(field(/our-code: \/abs\/path/), '/abs/spec.md');
  typeInto(field(/2026-10-06 或/), '2026/10/06');
  clickBtn('新建');
  await settle(3);
  eq(calls.length, before, '§6 as_of 形状不对:仍然不发请求');
  ok(/as_of 形状不对/.test(bodyText()), '§6 说清 as_of 要什么形状');
  eq(field(/这条资料叫什么/).value, '镍基合金固溶温度', '§6 ★报错后 title 还在(没有抹掉)');
  eq(field(/正文。/).value, '固溶温度 1050 ℃。', '§6 ★报错后 body 还在');
  eq(field(/our-code: \/abs\/path/).value, '/abs/spec.md', '§6 ★报错后 source_ref 还在');
  typeInto(field(/2026-10-06 或/), '2026-10-06');   // 改对形状(下面还要用它走到提交)
  await settle(1);

  // 完整 JSON 模式 + 坏 JSON:在**输入时**就报(还没点提交)
  pickSelItem('完整 JSON(有限格式)');
  await settle(2);
  ok(!!field(/^\{\\n|locator/), '§6 切到完整 JSON 模式后出现 JSON 文本域');
  typeInto(allEls(panel).find((e) => e.tagName === 'TEXTAREA' && /locator/.test(e.placeholder)), '{ 坏 JSON');
  await settle(2);
  ok(/核对规格 JSON 解析失败/.test(bodyText()), '§6 ★坏 JSON 在提交前就报错(输入即报)');
  ok(/现在提交不会发出任何请求/.test(bodyText()), '§6 且明说现在提交不会发请求');
  const before2 = calls.length;
  clickBtn('新建');
  await settle(3);
  eq(calls.length, before2, '§6 坏 JSON 时点提交:一个请求都不发');

  // expected JSON 坏 + json-pointer 指针不合法
  pickSelItem('分项填写(lines / json-pointer)');
  await settle(2);
  pickSelItem('json-pointer(JSON 里的位置,RFC 6901)');
  await settle(2);
  typeInto(field(/^\/tool\/version$/), 'a/b');
  await settle(1);
  ok(/指针必须以 \/ 开头/.test(bodyText()), '§6 RFC6901 指针必须 / 开头(提交前报)');
  typeInto(field(/^\/tool\/version$/), '/tool/version');
  typeInto(field(/1\.2\.3" 或 42/), '{不是 JSON');
  await settle(1);
  ok(/expected JSON 解析失败/.test(bodyText()), '§6 expected 的 JSON 坏了也提交前报');
  typeInto(field(/1\.2\.3" 或 42/), '42');
  await settle(1);
  ok(!/提交前检查\(现在提交不会发出任何请求\)/.test(bodyText()), '§6 改对之后提交前检查通过');

  // text-lf + 非文本 expected:与 store 的判据一致,客户端也不许放过
  const cmpSel = allEls(panel).filter((e) => String(e.className).split(/\s+/).includes('ling-sel'));
  ok(cmpSel.length >= 3, '§6 三个自绘下拉(category/source_kind/comparison)在场');
  pickSelItem('text-lf(只把 CRLF/CR 归一成 LF,不 trim、不折叠大小写)');
  await settle(1);
  ok(/text-lf 只用于文本/.test(bodyText()), '§6 text-lf 配非文本 expected:提交前就拒(与 store 同判据)');
  pickSelItem('exact(逐字节;类型敏感:数字 1 ≠ 字符串 "1")');
  await settle(1);

  // 提交成功:断言提交体
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/create', { ok: true, item: libItem({ title: '镍基合金固溶温度' }) }],
    ['/library/item', { ok: true, found: true, item: libItem({ title: '镍基合金固溶温度' }) }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  clickBtn('新建');
  await settle(6);
  const createCall = libCalls('/library/create')[0];
  ok(!!createCall, '§6 通过校验后确实发了 POST /library/create');
  eq(createCall.method, 'POST', '§6 写操作是 POST');
  const sent = createCall.body && createCall.body.item;
  ok(!!sent, '§6 提交体形状 = {item:{…}}');
  eq(sent.title, '镍基合金固溶温度', '§6 title 原样(去首尾空白)');
  eq(sent.body, '固溶温度 1050 ℃。', '§6 body 原样');
  eq(sent.category, 'standard-value', '§6 category 取下拉当前值');
  eq(sent.source_kind, 'manual', '§6 source_kind 取下拉当前值');
  eq(sent.source_ref, '/abs/spec.md', '§6 source_ref 原样');
  eq(sent.as_of, '2026-10-06', '§6 as_of 原样(显式,不由创建时间推断)');
  eq(JSON.stringify(sent.check_spec),
    JSON.stringify({ locator: { kind: 'json-pointer', pointer: '/tool/version' }, expected: 42, comparison: 'exact' }),
    '§6 分项构造出的 check_spec 形状正确(expected 是 JSON 数字 42,不是字符串)');
  eq(Object.keys(sent).sort().join(','), 'as_of,body,category,check_spec,source_kind,source_ref,title',
    '§6 ★提交体只有可编辑字段(version/conditions 留空就不出现)');
  ok(!('id' in sent) && !('revision' in sent) && !('content_hash' in sent) && !('state' in sent)
    && !('checked_state' in sent) && !('checked_at' in sent) && !('lineage_id' in sent),
    '§6 ★只读字段一个都没带(带了会被 store 以 readonly_field 拒)');
  ok(libCalls('/library/create').length === 1, '§6 只发一次(没有连点重发)');
}

// ─────────────────────────── §7 修订 + 陈旧冲突 ───────────────────────────
await section('§7 修订:带观测到的 content_hash;陈旧冲突提示并重载,绝不覆盖');
{
  const item = libItem({
    title: '待修订资料',
    body: '旧正文',
    check_spec: { locator: { kind: 'lines', start: 1, end: 2 }, expected: '旧正文', comparison: 'exact' },
  });
  await gotoLibrary([
    ['/library/status', statusPayload()],
    ['/library/item', { ok: true, found: true, item: item }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [{ id: A, revision: 1, is_current: true, state: 'active', checked_state: 'ok', created_at: '2026-10-06T00:00:00.000Z', check_count: 2, content_hash: HASH_A }], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  // 从列表进详情
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [item], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/item', { ok: true, found: true, item: item }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  typeInto(field(/搜索标题/), '待修订');
  clickBtn('查询');
  await settle(4);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);
  // 每次运行都留现场:详情视图**实际**画出了什么(绿也要有证据,不靠"我记得它画了")。
  // ⚠️ 只读字段网格单独抽出来打印 —— 它是 §4① 那个同名函数覆盖缺陷唯一会露馅的地方。
  const gridNode = allEls(bodyEl()).find((e) => String(e.className).includes('lib-grid'));
  console.log('    §7 详情只读字段网格实际文本:' + JSON.stringify(gridNode ? gridNode.textContent : '(没有 lib-grid 节点!)'));
  ok(/待修订资料/.test(bodyText()), '§7 进入详情');
  ok(bodyText().includes(HASH_A), '§7 详情把 content_hash 全文写出来(只读字段要能看见)');
  ok(/认证 checked_state/.test(bodyText()) && /state/.test(bodyText()), '§7 认证状态与 state 都在详情里');
  ok(/id/.test(bodyText()) && /lineage_id/.test(bodyText()), '§7 id/lineage_id 也在(只读字段全显)');

  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/revise', { ok: true, item: libItem({ id: B, title: '待修订资料', body: '新正文', revision: 2, previous_id: A, content_hash: HASH_B, checked_state: '' }) }],
    ['/library/item', { ok: true, found: true, item: libItem({ id: B, title: '待修订资料', body: '新正文', revision: 2, previous_id: A, content_hash: HASH_B }) }],
    ['/library/history', { ok: true, revision_count: 2, counts: { active: 1, superseded: 1, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  clickBtn('修订这条');
  await settle(2);
  ok(/修订《待修订资料》/.test(bodyText()), '§7 打开修订表单');
  eq(field(/这条资料叫什么/).value, '待修订资料', '§7 ★修订表单带出原值(title)');
  eq(field(/正文。/).value, '旧正文', '§7 ★修订表单带出原值(body)');
  eq(field(/2026-10-06 或/).value, '2026-10-06', '§7 ★修订表单带出原值(as_of)');
  ok(!/提交前检查\(现在提交不会发出任何请求\)/.test(bodyText()), '§7 带出的 check_spec 一打开就通过提交前检查');
  typeInto(field(/正文。/), '新正文');
  const before = calls.length;
  clickBtn('提交修订');
  await settle(6);
  const rev = libCalls('/library/revise')[0];
  ok(!!rev && calls.length > before, '§7 修订确实发了 POST /library/revise');
  eq(rev.method, 'POST', '§7 revise 是 POST');
  eq(rev.body.id, A, '§7 修订带上被修订的 id');
  eq(rev.body.expectedHash, HASH_A, '§7 ★修订带上发起时观测到的 content_hash');
  eq(rev.body.item.body, '新正文', '§7 提交体里是新正文');
  ok(!('content_hash' in rev.body.item) && !('revision' in rev.body.item) && !('id' in rev.body.item),
    '§7 ★item 里不带只读字段(id 在外层)');

  // 陈旧冲突:只提示 + 重载,不覆盖、不重发
  clickBtn('← 返回列表');   // 从上一段的视图回到列表,才能发起新检索
  await settle(2);
  const item2 = libItem({ title: '会被别人改的资料', body: '本地看到的正文' });
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [item2], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/item', { ok: true, found: true, item: item2 }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  typeInto(field(/搜索标题/), '会被');
  clickBtn('查询');
  await settle(4);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);
  clickBtn('修订这条');
  await settle(2);
  typeInto(field(/正文。/), '我改了一半的正文');
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/revise', { ok: false, reason: 'hash_mismatch', status: 'stale', current_hash: HASH_B, message: 'expectedHash 与当前 content_hash 不一致(陈旧观测)' }],
    ['/library/item', { ok: true, found: true, item: libItem({ title: '会被别人改的资料', body: '别人改过的正文', content_hash: HASH_B, revision: 2 }) }],
    ['/library/history', { ok: true, revision_count: 2, counts: { active: 1, superseded: 1, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  const reviseBefore = libCalls('/library/revise').length;
  clickBtn('提交修订');
  await settle(6);
  ok(/陈旧冲突/.test(bodyText()) && /hash_mismatch/.test(bodyText()), '§7 ★陈旧冲突:明确说是哪一类冲突');
  ok(/没有覆盖任何内容/.test(bodyText()), '§7 ★明说没有覆盖任何内容');
  ok(bodyText().includes(HASH_B), '§7 把库中当前 hash 也摆出来(才能对照)');
  ok(/我改了一半的正文/.test(field(/正文。/).value), '§7 ★★主人填的内容没被覆盖(表单原样)');
  eq(libCalls('/library/revise').length - reviseBefore, 1, '§7 ★这次点击只发 1 个 revise(没有自动重发):'
    + reviseBefore + ' → ' + libCalls('/library/revise').length);
  ok(libCalls('/library/item').length >= 2, '§7 已重新载入当前版本(又查了一次 item)');
}

// ─────────────────────────── §8 撤下:原因 + 确认,绝不静默 ───────────────────────────
await section('§8 撤下:没有原因不发、确认取消不发、确认了才发');
{
  const item = libItem({ title: '要撤下的资料' });
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [item], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/item', { ok: true, found: true, item: item }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  openCenter();
  await settle(2);
  await clickTab('图书馆');
  typeInto(field(/搜索标题/), '要撤下');
  clickBtn('查询');
  await settle(4);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);
  ok(!!field(/撤下原因/), '§8 详情页有撤下原因输入框');
  ok(!!button('撤下这条'), '§8 详情页有撤下按钮');

  // ① 没有原因
  let n = calls.length;
  clickBtn('撤下这条');
  await settle(3);
  eq(calls.length, n, '§8 没写原因:不发请求');
  ok(/撤下必须给出原因/.test(bodyText()), '§8 说清"撤下必须给出原因"');
  eq(confirmCalls.length, 0, '§8 连确认框都不弹(参数不全就不进入确认)');

  // ② 有原因但确认取消
  typeInto(field(/撤下原因/), '规格已被新版标准取代');
  confirmAnswer = false;
  clickBtn('撤下这条');
  await settle(3);
  eq(libCalls('/library/withdraw').length, 0, '§8 ★确认取消:一个撤下请求都不发(不静默执行)');
  ok(/已取消撤下/.test(bodyText()) && /没有发出任何请求/.test(bodyText()), '§8 如实说已取消、没发请求');
  eq(confirmCalls.length, 1, '§8 弹过一次确认框');
  ok(confirmCalls[0].includes('要撤下的资料'), '§8 确认框里点名是哪一条');
  ok(confirmCalls[0].includes('规格已被新版标准取代'), '§8 确认框里带上原因(人能复核)');

  // ③ 确认通过
  confirmAnswer = true;
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/withdraw', { ok: true, item: libItem({ title: '要撤下的资料', state: 'withdrawn', withdrawn_at: '2026-10-06T02:00:00.000Z', withdrawn_reason: '规格已被新版标准取代' }) }],
    ['/library/item', { ok: true, found: true, item: libItem({ title: '要撤下的资料', state: 'withdrawn', withdrawn_at: '2026-10-06T02:00:00.000Z', withdrawn_reason: '规格已被新版标准取代' }) }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 0, superseded: 0, withdrawn: 1 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  clickBtn('撤下这条');
  await settle(6);
  const wd = libCalls('/library/withdraw')[0];
  ok(!!wd, '§8 确认后确实发了 POST /library/withdraw');
  eq(wd.method, 'POST', '§8 withdraw 是 POST');
  eq(wd.body.id, A, '§8 带上条目 id');
  eq(wd.body.reason, '规格已被新版标准取代', '§8 带上原因');
  eq(wd.body.expectedHash, HASH_A, '§8 ★带上观测到的 content_hash(防陈旧撤下)');
  eq(libCalls('/library/withdraw').length, 1, '§8 只发一次');

  // ④ 环境里根本没有确认框:一律按"取消"处理,绝不静默执行
  const savedConfirm = windowObj.confirm;
  delete windowObj.confirm;
  try {
    const item3 = libItem({ title: '没有确认框的环境' });
    respond = routed([
      ['/library/status', statusPayload()],
      ['/library/search', { ok: true, items: [item3], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
      ['/library/item', { ok: true, found: true, item: item3 }],
      ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
      ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ]);
    openCenter();
    await settle(2);
    await clickTab('图书馆');
    typeInto(field(/搜索标题/), '没有确认框');
    clickBtn('查询');
    await settle(4);
    clickBtn('详情 / 修订链 / 核对');
    await settle(6);
    typeInto(field(/撤下原因/), '测试用原因');
    clickBtn('撤下这条');
    await settle(3);
    eq(libCalls('/library/withdraw').length, 0, '§8 ★★没有确认框时也绝不静默撤下');
    ok(/本环境没有确认框,按取消处理/.test(bodyText()), '§8 并如实说明为什么按取消处理');
  } finally {
    windowObj.confirm = savedConfirm;
  }
}

// ─────────────────────────── §9 核对:取消不伪成功 ───────────────────────────
await section('§9 核对按钮:ok/wrong/unknown 口径 + 取消/失败都不伪成功');
{
  const item = libItem({ title: '要对账的资料' });
  const base = [
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [item], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/item', { ok: true, found: true, item: item }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ];
  const checksReply = { ok: true, checks: [{ check_sequence: 1, state: 'ok', checked_at: '2026-10-06T03:00:00.000Z', adopted: true, item_hash: HASH_A, reason: null }], count: 1, offset: 0, limit: 20, total: 1, nextOffset: null, truncated: false };
  respond = routed(base.concat([['/library/checks', checksReply]]));
  openCenter();
  await settle(2);
  await clickTab('图书馆');
  typeInto(field(/搜索标题/), '要对账');
  clickBtn('查询');
  await settle(4);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);

  // ① ok:不伪称整条为真
  respond = routed(base.concat([
    ['/library/checks', checksReply],
    ['/library/check', {
      ok: true, state: 'ok', reason: null, recorded: true, adopted: true,
      evidence: {
        requested_source: '/tmp/a.txt', actual_source: '/tmp/a.txt', source_hash: 'sha256:' + 'c'.repeat(64),
        locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x', observed: '<b>源里的尖括号</b>',
        comparison: 'exact', checked_at: '2026-10-06T03:00:00.000Z', state: 'ok', reason: null,
      },
    }],
  ]));
  clickBtn('核对这条');
  await settle(6);
  const ck = libCalls('/library/check')[0];
  ok(!!ck, '§9 核对发了 POST /library/check');
  eq(ck.method, 'POST', '§9 check 是 POST');
  eq(ck.body.id, A, '§9 核对只带 id(没有别的参数面)');
  eq(Object.keys(ck.body).join(','), 'id', '§9 ★核对请求体只有 id');
  ok(/核对结果:一致/.test(bodyText()), '§9 ok 显示"一致"');
  ok(/recorded=true/.test(bodyText()) && /adopted=true/.test(bodyText()), '§9 recorded/adopted 如实显示');
  ok(/只说明[\s\S]{0,2}声明的那一处比较与源一致/.test(bodyText()), '§9 ★口径行:ok 只说明那一处比较,不说明整条为真');
  ok(/核对凭据\(evidence\)/.test(bodyText()), '§9 展示核对凭据');
  ok(bodyText().includes('/tmp/a.txt'), '§9 凭据里的 requested/actual source 都显示');
  ok(bodyText().includes('<b>源里的尖括号</b>'), '§9 凭据里的 observed 同样是字面文本');
  eq(allEls(panel).filter((e) => e.tagName === 'B').length, 0, '§9 凭据里的 HTML 没有变成元素');
  ok(/共 1 次核对/.test(bodyText()), '§9 核对后刷新了留痕(checks 的 total 照写)');

  // ② unknown + 未被采纳(stale):顶层 reason 是"这次比较"的结论,采纳判词在 record.reason
  respond = routed(base.concat([
    ['/library/checks', { ok: true, checks: [], total: 1, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/check', {
      ok: true, state: 'unknown', reason: 'source_too_large', recorded: true, adopted: false,
      adoption_reason: 'stale_or_inactive', record: { ok: true, adopted: false, reason: 'stale_or_inactive', check_sequence: 7 },
      evidence: { requested_source: '/tmp/a.txt', actual_source: '/tmp/a.txt', source_hash: null, expected: 'x', observed: null, comparison: 'exact', checked_at: '2026-10-06T04:00:00.000Z', state: 'unknown', reason: 'source_too_large' },
    }],
  ]));
  clickBtn('核对这条');
  await settle(6);
  ok(/核对结果:未能判定/.test(bodyText()), '§9 unknown 显示"未能判定"(不是对/错)');
  ok(/state=unknown/.test(bodyText()) && /reason=source_too_large/.test(bodyText()), '§9 unknown 带上机器码原因');
  ok(/adopted=false/.test(bodyText()), '§9 未被采纳如实显示');
  ok(/adoption_reason=stale_or_inactive/.test(bodyText()), '§9 adoption_reason 显示(runtime/API 层字段)');
  ok(/record\.reason=stale_or_inactive/.test(bodyText()) && /check_sequence=7/.test(bodyText()),
    '§9 ★record.reason 单独显示(与顶层核对原因分开)');

  // ③ ok:false(被拒,如 in_flight):不许伪成功
  respond = routed(base.concat([
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/check', { ok: false, state: 'unknown', reason: 'in_flight', message: '同一条目已有核对在进行中', recorded: false }],
  ]));
  clickBtn('核对这条');
  await settle(6);
  ok(/核对未执行/.test(bodyText()) && /in_flight/.test(bodyText()), '§9 被拒时显示"核对未执行 + 原因"');
  ok(!/核对结果:一致/.test(bodyText()), '§9 ★被拒不显示成功');

  // ④ cancelled:取消不写认证,界面不伪成功
  respond = routed(base.concat([
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/check', { ok: false, cancelled: true, reason: 'aborted', recorded: false, state: 'unknown' }],
  ]));
  clickBtn('核对这条');
  await settle(6);
  ok(/已取消/.test(bodyText()), '§9 cancelled:说"已取消"');
  ok(/取消不写认证/.test(bodyText()) && /不把它当成功/.test(bodyText()), '§9 ★明说取消不写认证、不当成功');
  ok(!/核对结果:一致/.test(bodyText()) && !/adopted=true/.test(bodyText()), '§9 ★没有伪造一个成功结果');

  // ⑤ 网关不可达:不猜结论
  respond = routed(base.concat([['/library/checks', checksReply], ['/library/check', () => { throw new Error('down'); }]]));
  clickBtn('核对这条');
  await settle(6);
  ok(/核对失败\(网关不可达\)/.test(bodyText()) || /核对没有回执/.test(bodyText()),
    '§9 网关不可达:如实说"失败/没有回执"(fetch 抛 ⇒ catch 那支;200+坏 JSON ⇒ !r 那支,两条都诚实)');
  ok(/不知道有没有写入/.test(bodyText()), '§9 ★如实说"不知道有没有写入",不猜成功也不猜失败');
  ok(!/核对结果:一致/.test(bodyText()), '§9 没有伪成功');
}

// ─────────────────────────── §10 竞态:迟到的应答不许串条目 ───────────────────────────
await section('§10 竞态:两次检索 / 两次开条目,迟到的应答一律丢弃');
{
  // 检索竞态
  const dFirst = defer();
  const dSecond = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/library/status')) return statusPayload();
    if (p.startsWith('/library/search')) return qsOf(rec, 'q') === 'first' ? dFirst.promise : dSecond.promise;
    return { ok: true };
  };
  openCenter();
  await settle(2);
  await clickTab('图书馆');
  typeInto(field(/搜索标题/), 'first');
  clickBtn('查询');
  await settle(2);
  ok(/正在检索/.test(bodyText()), '§10 请求在飞时显示"正在检索…"(不是空结果)');
  typeInto(field(/搜索标题/), 'second');
  clickBtn('查询');
  await settle(2);
  eq(libCalls('/library/search').length, 2, '§10 两次检索都在飞');
  dSecond.resolve({ ok: true, items: [libItem({ title: '第二次的结果' })], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false });
  await settle(4);
  ok(/第二次的结果/.test(bodyText()), '§10 后发的先回:显示第二次的结果');
  dFirst.resolve({ ok: true, items: [libItem({ title: '第一次的旧结果' })], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false });
  await settle(6);
  ok(/第二次的结果/.test(bodyText()), '§10 ★★迟到的旧应答被丢弃:列表还是第二次的结果');
  ok(!/第一次的旧结果/.test(bodyText()), '§10 ★旧结果一个字都没画上去');

  // 条目竞态
  const dA = defer();
  const itemA = libItem({ id: A, title: '条目甲' });
  const itemB = libItem({ id: B, title: '条目乙', lineage_id: B });
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/library/status')) return statusPayload();
    if (p.startsWith('/library/search')) return { ok: true, items: [itemA, itemB], count: 2, offset: 0, limit: 20, nextOffset: null, truncated: false };
    if (p.startsWith('/library/item')) return qsOf(rec, 'id') === A ? dA.promise : { ok: true, found: true, item: itemB };
    if (p.startsWith('/library/history') || p.startsWith('/library/checks')) {
      return { ok: true, revision_count: 0, counts: { active: 0, superseded: 0, withdrawn: 0 }, revisions: [], checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false };
    }
    return { ok: true };
  };
  openCenter();
  await settle(2);
  await clickTab('图书馆');
  typeInto(field(/搜索标题/), 'q');
  clickBtn('查询');
  await settle(4);
  const rows = buttons('详情 / 修订链 / 核对');
  eq(rows.length, 2, '§10 列表里两个条目各有一个详情按钮');
  clickNode(rows[0]);
  await settle(2);
  clickBtn('← 返回列表');
  await settle(2);
  const rows2 = buttons('详情 / 修订链 / 核对');
  clickNode(rows2[1]);
  await settle(6);
  ok(/条目乙/.test(bodyText()), '§10 打开条目乙并显示');
  dA.resolve({ ok: true, found: true, item: itemA });
  await settle(6);
  ok(/条目乙/.test(bodyText()), '§10 ★★迟到的条目甲应答被丢弃:视图仍是条目乙');
  ok(!/条目甲/.test(bodyText()), '§10 ★条目甲没有串进来');
}

// ─────────────────────────── §11 与记忆零混淆:图书馆不读记忆面 ───────────────────────────
await section('§11 图书馆不碰记忆端点(零迁移/零混淆)');
{
  respond = routed([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [libItem()], count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/item', { ok: true, found: true, item: libItem() }],
    ['/library/history', { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 }, revisions: [], count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
    ['/library/checks', { ok: true, checks: [], total: 0, count: 0, offset: 0, limit: 20, nextOffset: null, truncated: false }],
  ]);
  openCenter();
  await settle(3);      // 让「概览与数据」那一页的异步请求先落地(它有自己的加载态)
  calls.length = 0;     // 从这里开始只算图书馆造成的请求
  await clickTab('图书馆');
  typeInto(field(/搜索标题/), 'q');
  clickBtn('查询');
  await settle(4);
  clickBtn('详情 / 修订链 / 核对');
  await settle(6);
  const memPaths = calls.filter((c) => /\/memories|\/tree|\/conflicts|\/suggestions|\/feedback|\/deep\/|\/state|\/import|\/export|\/archive/.test(pathOf(c)));
  eq(memPaths.length, 0, '§11 ★图书馆全程没有向记忆端点发过一个请求');
  eq(calls.filter((c) => pathOf(c).startsWith('/library/')).length, calls.length,
    '§11 图书馆造成的请求全部落在 /library/* 上');
  ok(bodyText().includes(HASH_A), '§11 详情展示的还是图书馆自己的字段(content_hash)');
}

// ─────────────────────────── §12 工厂级护栏(执行级观测不到的) ───────────────────────────
await section('§12 源码护栏:不许 innerHTML / 图书馆块不许出现记忆端点与写 HTML 的途径');
{
  const libStart = src.indexOf('// ---------------- 图书馆(独立库');
  const libEnd = src.indexOf('        function render() {', libStart);
  const libBlock = libStart >= 0 && libEnd > libStart ? src.slice(libStart, libEnd) : '';
  ok(libBlock.length > 8000, '§12 定位到图书馆实现块(' + libBlock.length + ' B)');
  eq(innerHTMLWrites.length, 0, '§12 ★整个套件跑完,innerHTML 写入次数 = 0');
  ok(!/\.innerHTML\s*=/.test(src), '§12 ★client.js 里没有 innerHTML 赋值');
  ok(!src.includes('insertAdjacentHTML') && !src.includes('document.write'), '§12 也没有 insertAdjacentHTML/document.write');
  // ⚠️ 只判**代码**不判注释:块首注释里就写着"一处 innerHTML 都没有"这句话 —— 不剥注释,
  //   断言会被自己的注释满足(本仓 client-batch T8 吃过同款亏)。剥法与该文件一致:去掉整行 `//`。
  const libCode = libBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/innerHTML/.test(libCode), '§12 图书馆块的**代码**里没有 innerHTML(注释不算)');
  ok(!/api\('\/memories/.test(libBlock) && !/api\("\/memories/.test(libBlock), '§12 ★图书馆块不调记忆端点');
  // ⚠️ 2026-10-12 加导入面时,这条护栏收紧 + 放宽各一处(两处都必要,写在这里免得后人"顺手"改回去):
  //   · **收紧**:直接枚举本块的所有 `api('…')` 路径,要求逐个以 `/library/` 开头 ——
  //     比下面那串子串黑名单精确(黑名单漏掉一个新端点就永远沉默,枚举法不会);
  //   · **放宽**:黑名单里的 `/import` 原本指的是记忆侧的会话导入端点,而图书馆自己的导入面
  //     就是 `/library/import/*` ⇒ 判之前先把这个自家前缀抠掉,否则**自家端点被自家护栏拦下**
  //     (实测:加完导入面这条当场变红,而它报的"别的业务端点"其实正是 /library/import/analyze)。
  const libApiPaths = [...libBlock.matchAll(/api\(\s*['"]([^'"]*)['"]/g)].map((m) => m[1]);
  ok(libApiPaths.length >= 6, '§12 图书馆块枚举到 ' + libApiPaths.length + ' 个 api 路径(≥6)');
  ok(libApiPaths.every((p) => p.startsWith('/library/')),
    '§12 ★图书馆块的每个 api 路径都以 /library/ 开头;越界的 ='
    + JSON.stringify(libApiPaths.filter((p) => !p.startsWith('/library/'))));
  const libBlockNoOwnImport = libBlock.replace(/\/library\/import/g, '/library/~import');
  ok(!/\/tree|\/conflicts|\/suggestions|\/deep\/|\/import|\/archive/.test(libBlockNoOwnImport),
    '§12 ★图书馆块里没有别的业务端点(只有 /library/*)');
  const guards = (libBlock.match(/st\.tab === 'library'/g) || []).length;
  ok(guards >= 8, '§12 每处异步回画都有 st.tab 守卫(实测 ' + guards + ' 处)—— 切走后不许把旧内容画回来');
  ok(/tabLib\.className = 'ling-tab'/.test(libBlock.slice(0, 0) + src), '§12 switchTab 里有图书馆的高亮重算');
  ok(src.includes("var tabLib = el('div', 'ling-tab', '图书馆')"), '§12 图书馆标签是第 5 个 ling-tab');
  ok(src.includes('记忆与数据中心'), '§12 中心标题改成「记忆与数据中心」');
  ok(src.includes("['记忆与数据中心(浏览/置顶/导入导出)', openMemoryCenter]"),
    '§12 侧栏菜单入口也改名(与新的中心标题一致)');
  ok(/openMemoryCenter: openMemoryCenter/.test(src), '§12 测试钩子挂的是真入口');
}

// ─────────── §13 迟到回画守卫:旧四标签的异步尾巴不得顶掉第五面板 ───────────
// 口径:受控 deferred —— 请求**确实挂在半空**时切到图书馆,再让旧请求 resolve / reject,
// 检查第五面板的内容与高亮是否还在。与 §10 的竞态不同:§10 是"图书馆自己两发请求互换",
// 这里跨的是**标签**:旧四标签的尾巴清的是**同一个 body**。
await section('§13 旧四标签的迟到回画不得顶掉第五面板(受控 deferred)');
function libPanelOn() { return !!button('＋ 新建资料'); }
function memPanelOn() { return !button('＋ 新建资料'); }
{
  // ── 13-a 记忆浏览:sources 成功应答迟到 ──
  const held = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/memories/sources')) return held.promise;   // 挂在半空
    if (p.startsWith('/library/status')) return statusPayload();
    return { ok: true };
  };
  openCenter();
  await settle(3);                          // 默认停在概览,先让它自己的请求落地
  await clickTab('记忆浏览');
  ok(/加载中/.test(bodyText()), '§13a 浏览的 sources 请求在飞:先给出加载态');
  await clickTab('图书馆');
  const libTextA = bodyText();
  ok(libPanelOn(), '§13a 图书馆内容已画上(前置条件)');
  ok(tabNamed('图书馆').className.includes('on'), '§13a 高亮在图书馆');
  held.resolve({ ok: true, total: 0, bySource: {}, branch: { total: 0, list: [] } });
  await settle(8);
  eq(bodyText(), libTextA, '§13a ★★迟到的「记忆浏览」**成功**应答一个字都没画上去(正文逐字未变)');
  ok(tabNamed('图书馆').className.includes('on') && !tabNamed('记忆浏览').className.includes('on'),
    '§13a 高亮没有被旧标签抢回去');
  ok(!bodyText().includes('全部来源'), '§13a 记忆浏览的工具条没有串进图书馆面板');
  // 切回旧标签仍可用:重新发请求 → 正常渲染
  respond = routed([
    ['/memories/sources', { ok: true, total: 0, bySource: {}, branch: { total: 0, list: [] } }],
    ['/memories', { ok: true, items: [], total: 0 }],
    ['/library/status', statusPayload()],
  ]);
  await clickTab('记忆浏览');
  await settle(6);
  ok(tabNamed('记忆浏览').className.includes('on'), '§13a 切回记忆浏览:高亮跟着回来');
  ok(/全部来源/.test(bodyText()) || /没有匹配的记忆/.test(bodyText()),
    '§13a 切回记忆浏览仍可用(工具条与空态正常渲染)');
  ok(memPanelOn(), '§13a 图书馆的内容已让位给记忆浏览');
}
{
  // ── 13-b 记忆浏览:sources **失败**应答迟到(.catch 那一路也会清 body 重画) ──
  const held2 = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/memories/sources')) return held2.promise;
    if (p.startsWith('/library/status')) return statusPayload();
    return { ok: true };
  };
  openCenter();
  await settle(3);
  await clickTab('记忆浏览');
  await clickTab('图书馆');
  const libTextB = bodyText();
  ok(libPanelOn(), '§13b 图书馆内容已画上(前置条件)');
  held2.reject(new Error('boom'));
  await settle(8);
  eq(bodyText(), libTextB, '§13b ★★迟到的「记忆浏览」**失败**应答也没能清 body');
  ok(tabNamed('图书馆').className.includes('on'), '§13b 高亮仍在图书馆');
}
{
  // ── 13-c 概览:Promise.all 的尾巴迟到 ──
  const held3 = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/suggestions')) return held3.promise;   // 四路之一挂住 ⇒ Promise.all 不结算
    if (p.startsWith('/library/status')) return statusPayload();
    return { ok: true };
  };
  openCenter();
  await settle(2);
  ok(/加载器灵概览/.test(bodyText()), '§13c 概览仍停在加载态(建议请求在飞)');
  await clickTab('图书馆');
  const libTextC = bodyText();
  ok(libPanelOn(), '§13c 图书馆内容已画上(前置条件)');
  held3.resolve({ ok: true, stats: { new: 0 } });
  await settle(8);
  eq(bodyText(), libTextC, '§13c ★★迟到的概览 Promise.all 尾巴被整条丢弃(连 body 都没清)');
  ok(!/加载器灵概览|概述总数/.test(bodyText()), '§13c 概览的内容没有顶上来');
  ok(tabNamed('图书馆').className.includes('on'), '§13c 高亮仍在图书馆');
  // 切回概览仍可用
  respond = routed([
    ['/suggestions', { ok: true, stats: { new: 0 } }],
    ['/feedback', { ok: true, stats: { new: 0 } }],
    ['/deep/status', { ok: true, done: 0 }],
    ['/state', { ok: true, persona: {}, lastMode: 'life' }],
    ['/memories', { ok: true, total: 0, items: [] }],
    ['/library/status', statusPayload()],
  ]);
  await clickTab('概览与数据');
  await settle(8);
  ok(/概述总数/.test(bodyText()), '§13c 切回概览仍可用(内容正常渲染)');
}
{
  // ── 13-d 记忆树:loadTreeAll 在飞时切走(它的 Promise.all 尾巴会 paintTree) ──
  const NODE = { id: 'br:x', kind: 'trunk', name: '迟到的主干', memories: 0, sessions: 0, children: [] };
  const held4 = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/tree')) return held4.promise;
    if (p.startsWith('/conflicts')) return { ok: true, conflicts: [] };
    if (p.startsWith('/library/status')) return statusPayload();
    return { ok: true };
  };
  openCenter();
  await settle(3);
  await clickTab('记忆树');
  ok(/正在读取记忆树/.test(bodyText()), '§13d 树请求在飞:先给出"正在读取记忆树…"(说明这一发确实在飞)');
  await clickTab('图书馆');
  const libTextD = bodyText();
  ok(libPanelOn(), '§13d 图书馆内容已画上(前置条件)');
  held4.resolve({ ok: true, roots: [NODE], links: [], total: 1 });
  await settle(8);
  eq(bodyText(), libTextD, '§13d ★★迟到的 /tree 应答被丢弃(记忆树没有顶掉第五面板)');
  ok(!/正在读取记忆树/.test(bodyText()) && !/迟到的主干/.test(bodyText()), '§13d 树内容一个字节都没画');
  // 切回记忆树仍可用:缓存未被迟到应答写入 ⇒ 重新拉取并绘制
  respond = routed([
    ['/tree', { ok: true, roots: [NODE], links: [], total: 1 }],
    ['/conflicts', { ok: true, conflicts: [] }],
    ['/library/status', statusPayload()],
  ]);
  await clickTab('记忆树');
  await settle(8);
  ok(/迟到的主干/.test(bodyText()), '§13d 切回记忆树仍可用(重新拉取并正常绘制)');
  ok(tabNamed('记忆树').className.includes('on'), '§13d 高亮回到记忆树');
}
{
  // ── 13-e 机制留痕(执行级观测不到"守卫存在"这件事,只能读源码) ──
  const drawUses = (src.match(/drawGen/g) || []).length;
  ok(src.includes('var drawGen = 0;'), '§13e 绘制代次令牌已声明');
  ok(drawUses >= 9, '§13e 代次令牌落地处 = ' + drawUses + ' 处(声明 + switchTab + 各标签入口与尾巴,≥9)');
  const treeGuards = (src.match(/if \(st\.tab !== 'tree'\) return;/g) || []).length;
  ok(treeGuards >= 3, '§13e 记忆树侧守卫 = ' + treeGuards + ' 处(paintTree / loadTreeAll / lingCenterReload,≥3)');
  ok(/if \(gen !== drawGen \|\| st\.tab !== 'overview'\) return;/.test(src), '§13e 概览尾巴的代次守卫在');
  ok(/if \(gen !== drawGen \|\| st\.tab !== 'browse'\) return;/.test(src), '§13e 记忆浏览尾巴的代次守卫在');
  ok((src.match(/if \(gen !== drawGen \|\| st\.tab !== 'browse'\) return;/g) || []).length === 2,
    '§13e 记忆浏览的**两路**(.then/.catch)都守住了');
}

// ─────────── §14 写动作之后的界面缓存同步(2026-10-07 真机缺陷的回归判据) ───────────
// 缺陷(真机实测,2026-10-07):建档 / 核对之后同页出现**两套读数** —— 核对结果盒与「核对留痕」
// 是新的,而条目标签「认证」、明细 checked_state、修订链计数、顶部「条目 / 留痕」统计,以及
// **列表那一行**,停在旧值,直到手动点「刷新状态」或重开该条。**库内数据一直是对的** ——
// 坏的是界面缓存在写动作之后没再同步。
// 手法与 §9 / §10 同源:假 DOM + 受控 deferred + 请求记录(不另造一套)。
// 判据的**有效性**在 §14e 用受控替身验:每个走查返回**事实向量**(纯布尔/数字、不含断言),
// 于是同一套事实能在"修复前 / 过度修复"的装载源上再跑一遍,断言它们**变假** ——
// 断言真的会红,而不是自说自话。装载源只在**内存**里替换字符串,磁盘上的 lib/client.js
// 一个字节都不动(负对照的 SHA256 证据见 plans/1.7-client-sync-test-report.md)。
await section('§14 写动作之后:详情三份读数 / 顶部统计 / 列表那一行,必须一起跟上');

let A14 = 0;
// COLLECT = null ⇒ 真跑(失败即 ok() 报红);COLLECT = [] ⇒ **收集**模式:只把失败的消息收进来。
// 收集模式是 §14e 负对照用的:把**同一组**断言整体跑在"坏掉的装载源"上,数一数会红几条。
let COLLECT = null;
function a14(cond, msg) {
  if (COLLECT) { if (!cond) COLLECT.push(msg); return; }
  A14 += 1;
  ok(cond, msg);
}

/** 一份独立的假 DOM(与文件顶部的 doc 同构):受控替身用它,免得污染主台面。 */
function freshDoc() {
  const d = {
    createElement: (t) => new FakeEl(t),
    createTextNode: (v) => new FakeText(v),
    createStyleSheet: () => ({ cssRules: [] }),
    documentElement: new FakeEl('html'),
    head: new FakeEl('head'),
    body: new FakeEl('body'),
    getElementById(id) {
      const all = allEls(d.head).concat(allEls(d.body));
      return all.find((e) => e.id === id) || null;
    },
    querySelector(sel) { const r = walk(d.body, sel, true); return r[0] || null; },
    querySelectorAll(sel) { return walk(d.body, sel, false); },
    addEventListener() {}, removeEventListener() {},
  };
  d.documentElement.setAttribute('data-theme', 'light');
  return d;
}
/** 一台"受控台面":一份装载源 = 一个独立 vm 上下文 + 独立假 DOM + 独立请求记录。 */
function makeStage(loadSrc) {
  const d = freshDoc();
  const S = { doc: d, calls: [], panel: null, respond: () => ({ ok: true }), T: null };
  const win = {
    addEventListener() {}, removeEventListener() {}, innerHeight: 900, innerWidth: 1400,
    confirm() { return true; },
  };
  const stub = (url, opts) => {
    const rec = {
      url: String(url), method: (opts && opts.method) || 'GET',
      body: opts && opts.body ? JSON.parse(opts.body) : null,
      headers: (opts && opts.headers) || {},
    };
    S.calls.push(rec);
    return Promise.resolve().then(() => S.respond(rec))
      .then((payload) => ({ ok: true, status: 200, json: async () => payload }));
  };
  return contextify(loadSrc, { window: win, document: d, fetch: stub }).then((out) => {
    S.T = out && out.__test__;
    if (!S.T) throw new Error('受控替身:装载源没有导出 __test__');
    return S;
  });
}
/** 主台面与替身台面**同形**:走查函数只认下面这几个方法,不认"是主台面还是替身"。 */
const MAIN = {
  label: '主台面(磁盘上的 lib/client.js)',
  calls: () => calls,
  setRespond: (f) => { respond = f; },
  panel: () => panel,
  open() { openCenter(); return panel; },
};
function variantApi(S, label) {
  return {
    label: label,
    calls: () => S.calls,
    setRespond: (f) => { S.respond = f; },
    panel: () => S.panel,
    open() {
      S.doc.body.textContent = '';
      S.calls.length = 0;
      S.T.openMemoryCenter();
      S.panel = S.doc.body.querySelector('.ling-mc');
      if (!S.panel) throw new Error(label + ':面板没有挂到 document.body');
      return S.panel;
    },
  };
}
/** 受控替身:在**内存里的装载源**上做一次唯一命中的替换(磁盘不动)。
 *  不唯一命中就当场抛 —— 那会让负对照变成假绿(补丁没打上,却以为验过了)。 */
function patchOnce(s, re, repl, label) {
  const g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g');
  const hits = s.match(g) || [];
  if (hits.length !== 1) {
    throw new Error('受控替身补丁「' + label + '」命中 ' + hits.length + ' 处(要求恰好 1 处)—— 负对照会变成假绿,立即停');
  }
  return s.replace(re, repl);
}

function sEls(A) { return allEls(A.panel()); }
function sText(A) { const b = A.panel().querySelector('.mc-body'); return b ? b.textContent : ''; }
function sField(A, re) {
  return sEls(A).find((e) => (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.placeholder && re.test(e.placeholder)) || null;
}
function sBtn(A, label) {
  return sEls(A).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label) || null;
}
function sClick(A, label) {
  const b = typeof label === 'string' ? sBtn(A, label) : label;
  if (!b) throw new Error(A.label + ':界面上没有按钮 ' + label);
  b.onclick(mkEvent(b));
  return b;
}
function sType(A, node, v) {
  if (!node) throw new Error(A.label + ':要输入的节点不存在');
  node.value = v;
  if (typeof node.oninput === 'function') node.oninput(mkEvent(node));
}
async function sTab(A, name) {
  const t = sEls(A).find((e) => String(e.className).split(/\s+/).includes('ling-tab') && e.textContent.trim() === name);
  if (!t) throw new Error(A.label + ':没有标签 ' + name);
  t.onclick(mkEvent(t));
  await settle();
  return t;
}
// ⚠️ 与 libCalls 同款:按**去掉查询串的路径逐字比** —— '/library/checks' 也以 '/library/check' 开头。
function sCalls(A, p) {
  return A.calls().filter((c) => {
    const x = pathOf(c).split('?')[0];
    return x === p || x.startsWith(p + '/');
  });
}
function sLastIdx(A, p) {
  return A.calls().map((c) => pathOf(c).split('?')[0]).lastIndexOf(p);
}
function sRows(A) { return sEls(A).filter((e) => String(e.className).split(/\s+/).includes('m-row')); }
function sRowBtn(A, i, label) {
  const r = sRows(A)[i];
  if (!r) return null;
  return allEls(r).find((e) => e.tagName === 'BUTTON' && e.textContent.trim() === label) || null;
}
function sGridText(A) {
  const g = sEls(A).find((e) => String(e.className).includes('lib-grid'));
  return g ? g.textContent : '';
}
function sResultBoxes(A) {
  return sEls(A).filter((e) => String(e.className).split(/\s+/).includes('lib-card'))
    .map((e) => e.textContent).filter((t) => t.indexOf('核对结果:') === 0);
}
function sSearchReply(items) {
  return { ok: true, items: items, count: items.length, offset: 0, limit: 20, nextOffset: null, truncated: false };
}
function sHistReply(checkedState, checkCount) {
  return { ok: true, revision_count: 1, counts: { active: 1, superseded: 0, withdrawn: 0 },
    revisions: [{ id: A, revision: 1, is_current: true, state: 'active', checked_state: checkedState,
      created_at: '2026-10-06T00:00:00.000Z', check_count: checkCount, content_hash: HASH_A }],
    count: 1, offset: 0, limit: 20, nextOffset: null, truncated: false };
}
function sChecksReply(n) {
  return { ok: true, total: n, count: n ? 1 : 0, offset: 0, limit: 20, nextOffset: null, truncated: false,
    checks: n ? [{ check_sequence: 1, state: 'ok', checked_at: '2026-10-06T05:00:00.000Z', adopted: true, item_hash: HASH_A, reason: null }] : [] };
}
function sCheckOkReply() {
  return { ok: true, state: 'ok', reason: null, recorded: true, adopted: true,
    evidence: { requested_source: '/tmp/a.txt', actual_source: '/tmp/a.txt', source_hash: 'sha256:' + 'c'.repeat(64),
      locator: { kind: 'lines', start: 1, end: 1 }, expected: 'x', observed: 'x', comparison: 'exact',
      checked_at: '2026-10-06T05:00:00.000Z', state: 'ok', reason: null } };
}

/** 走查①:详情页核对成功 —— 三份读数(条目 / 修订链 / 留痕)与顶部统计都要重读,
 *  且结果盒**不能**被重读清掉(14a / 14d)。返回事实向量,不在这里断言。 */
async function scenCheck(A) {
  const TITLE = '要对账同步的资料';
  const OLD = libItem({ title: TITLE, checked_state: '', checked_at: null, revision: 1 });
  const NEW = libItem({ title: TITLE, checked_state: 'ok', checked_at: '2026-10-06T05:00:00.000Z', revision: 1 });
  let posted = false;
  A.setRespond((rec) => {
    const p = pathOf(rec).split('?')[0];
    if (p === '/library/status') return statusPayload();
    if (p === '/library/search') return sSearchReply([posted ? NEW : OLD]);
    if (p === '/library/item') return { ok: true, found: true, item: posted ? NEW : OLD };
    if (p === '/library/history') return sHistReply(posted ? 'ok' : '', posted ? 1 : 0);
    if (p === '/library/checks') return sChecksReply(posted ? 1 : 0);
    if (p === '/library/check') { posted = true; return sCheckOkReply(); }
    return { ok: true };
  });
  A.open();
  await settle(2);
  await sTab(A, '图书馆');
  sType(A, sField(A, /搜索标题/), '要对账');
  sClick(A, '查询');
  await settle(4);
  sClick(A, '详情 / 修订链 / 核对');
  await settle(6);
  const textBefore = sText(A);
  const gridBefore = sGridText(A);
  const n0 = {
    item: sCalls(A, '/library/item').length, hist: sCalls(A, '/library/history').length,
    status: sCalls(A, '/library/status').length, checks: sCalls(A, '/library/checks').length,
    search: sCalls(A, '/library/search').length,
  };
  sClick(A, '核对这条');
  await settle(12);
  const textAfter = sText(A);
  const gridAfter = sGridText(A);
  const postIdx = sLastIdx(A, '/library/check');
  const boxes = sResultBoxes(A);
  return {
    preChip: /认证:未核对/.test(textBefore),
    preGrid: /认证 checked_state— · —/.test(gridBefore),
    preHist: /· 认证 — ·/.test(textBefore),
    checkPosts: sCalls(A, '/library/check').length,
    itemReread: sCalls(A, '/library/item').length > n0.item,
    histReread: sCalls(A, '/library/history').length > n0.hist,
    checksReread: sCalls(A, '/library/checks').length > n0.checks,
    statusReread: sCalls(A, '/library/status').length > n0.status,
    readsAfterWrite: sLastIdx(A, '/library/item') > postIdx && sLastIdx(A, '/library/history') > postIdx
      && sLastIdx(A, '/library/status') > postIdx,
    chipNew: /认证:一致/.test(textAfter),
    chipOldGone: !/认证:未核对/.test(textAfter),
    gridNew: /认证 checked_stateok · 2026-10-06T05:00:00\.000Z/.test(gridAfter),
    gridOldGone: !/认证 checked_state— · —/.test(gridAfter),
    histNew: /· 认证 ok ·/.test(textAfter) && /· 核对 1 次/.test(textAfter),
    trailNew: /共 1 次核对/.test(textAfter) && /第 1 次 · 一致/.test(textAfter),
    statusStillLoaded: /图书馆可用/.test(textAfter),
    listNotRerun: sCalls(A, '/library/search').length === n0.search,
    resultBoxCount: boxes.length,
    resultBoxKept: boxes.length === 1 && /核对结果:一致/.test(boxes[0]) && /recorded=true/.test(boxes[0])
      && /adopted=true/.test(boxes[0]) && /只说明/.test(boxes[0]),
    text: textAfter,
  };
}

/** 走查②:两个**连续**写动作(新建 → 撤下)—— 每次之后顶部统计都要重读(14b)。 */
async function scenCreate(A) {
  const TITLE = '新建后统计要跟上';
  let seq = 0;
  let withdrew = false;
  const CREATED = libItem({ id: B, lineage_id: B, title: TITLE, revision: 1, content_hash: HASH_B, checked_state: '', checked_at: null });
  const GONE = libItem({ id: B, lineage_id: B, title: TITLE, revision: 1, content_hash: HASH_B, checked_state: '', checked_at: null,
    state: 'withdrawn', withdrawn_at: '2026-10-06T06:00:00.000Z', withdrawn_reason: '回归测试用原因' });
  A.setRespond((rec) => {
    const p = pathOf(rec).split('?')[0];
    if (p === '/library/status') {
      seq += 1;   // 第 N 次回执就报 N+2 条 ⇒ 屏幕上出现哪个数字,就知道读到了第几版
      return statusPayload({
        store: { ok: true, items: { total: seq + 2, active: seq + 2, superseded: 0, withdrawn: 0, lineages: seq + 2, max_revision: 1 },
          checks: { total: seq, adopted: seq } },
      });
    }
    if (p === '/library/create') return { ok: true, item: CREATED };
    if (p === '/library/withdraw') { withdrew = true; return { ok: true, item: GONE }; }
    if (p === '/library/item') return { ok: true, found: true, item: withdrew ? GONE : CREATED };
    if (p === '/library/history') return sHistReply('', 0);
    if (p === '/library/checks') return sChecksReply(0);
    return { ok: true };
  });
  A.open();
  await settle(2);
  await sTab(A, '图书馆');
  const statusBase = sCalls(A, '/library/status').length;
  const baseTop = /条目 3\(/.test(sText(A));
  sClick(A, '＋ 新建资料');
  await settle(2);
  sType(A, sField(A, /这条资料叫什么/), TITLE);
  sType(A, sField(A, /正文。/), '正文');
  sType(A, sField(A, /our-code: \/abs\/path/), '/abs/spec.md');
  sType(A, sField(A, /2026-10-06 或/), '2026-10-06');
  sClick(A, '新建');
  await settle(12);
  const statusAfterCreate = sCalls(A, '/library/status').length;
  const textAfterCreate = sText(A);
  // 第二个写动作:撤下同一条(此时 status 早就是"已读过"的状态 ⇒ 走的是 statusLoaded 那条早退路径)
  sType(A, sField(A, /撤下原因/), '回归测试用原因');
  sClick(A, '撤下这条');
  await settle(12);
  const statusAfterWithdraw = sCalls(A, '/library/status').length;
  const textAfterWithdraw = sText(A);
  return {
    statusBase: statusBase,
    baseTop: baseTop,
    createPosts: sCalls(A, '/library/create').length,
    statusAfterCreate: statusAfterCreate,
    createRereadStatus: statusAfterCreate === statusBase + 1,
    createTopNew: /条目 4\(/.test(textAfterCreate),
    withdrawPosts: sCalls(A, '/library/withdraw').length,
    statusAfterWithdraw: statusAfterWithdraw,
    withdrawRereadStatus: statusAfterWithdraw === statusAfterCreate + 1,
    withdrawTopNew: /条目 5\(/.test(textAfterWithdraw),
    textCreate: textAfterCreate,
    textWithdraw: textAfterWithdraw,
  };
}

/** 走查③:status 读**挂在半空**时来一次写动作 —— 那次失效不能被吞(14c,最容易漏的一条)。 */
async function scenRace(A) {
  const TITLE = '状态读在飞时的写动作';
  const OLD = libItem({ title: TITLE, checked_state: '', checked_at: null });
  const NEW = libItem({ title: TITLE, checked_state: 'ok', checked_at: '2026-10-06T07:00:00.000Z' });
  const FIRST = statusPayload({ store: { ok: true, items: { total: 2, active: 2, superseded: 0, withdrawn: 0, lineages: 2, max_revision: 1 }, checks: { total: 1, adopted: 1 } } });
  const LATER = statusPayload({ store: { ok: true, items: { total: 9, active: 9, superseded: 0, withdrawn: 0, lineages: 9, max_revision: 1 }, checks: { total: 4, adopted: 4 } } });
  const held = defer();
  let statusN = 0;
  let posted = false;
  A.setRespond((rec) => {
    const p = pathOf(rec).split('?')[0];
    if (p === '/library/status') {
      statusN += 1;
      if (statusN === 1) return held.promise;    // 第一次:挂在半空
      return LATER;
    }
    if (p === '/library/search') return sSearchReply([posted ? NEW : OLD]);
    if (p === '/library/item') return { ok: true, found: true, item: posted ? NEW : OLD };
    if (p === '/library/history') return sHistReply(posted ? 'ok' : '', posted ? 1 : 0);
    if (p === '/library/checks') return sChecksReply(posted ? 1 : 0);
    if (p === '/library/check') { posted = true; return sCheckOkReply(); }
    return { ok: true };
  });
  A.open();
  await settle(2);
  await sTab(A, '图书馆');
  const statusFlying = sCalls(A, '/library/status').length;
  const flyingText = /正在读取图书馆状态/.test(sText(A));
  sType(A, sField(A, /搜索标题/), '状态');
  sClick(A, '查询');
  await settle(4);
  sClick(A, '详情 / 修订链 / 核对');
  await settle(6);
  sClick(A, '核对这条');                        // 写动作:此刻 status 仍在飞
  await settle(12);
  const duringFlight = sCalls(A, '/library/status').length;
  const chipAfterCheck = /认证:一致/.test(sText(A));
  held.resolve(FIRST);                          // 第一次状态读这才读完
  await settle(14);
  const afterResolve = sCalls(A, '/library/status').length;
  const textAfter = sText(A);
  return {
    statusFlying: statusFlying,
    flyingText: flyingText,
    duringFlight: duringFlight,
    noOverlap: duringFlight === statusFlying,
    chipAfterCheck: chipAfterCheck,
    afterResolve: afterResolve,
    rereadAfterResolve: afterResolve === statusFlying + 1,
    topNew: /条目 9\(/.test(textAfter),
    topOldGone: !/条目 2\(/.test(textAfter),
    statusStillLoaded: /图书馆可用/.test(textAfter),
    text: textAfter,
  };
}

// ── §14a 核对成功之后:三份读数都要重读,且屏幕上的「认证」必须变成新值 ──
const F_CHECK = await scenCheck(MAIN);
console.log('    §14a 核对后 /library/item×' + sCalls(MAIN, '/library/item').length
  + ' · /library/history×' + sCalls(MAIN, '/library/history').length
  + ' · /library/status×' + sCalls(MAIN, '/library/status').length
  + ' · /library/checks×' + sCalls(MAIN, '/library/checks').length);
// 断言写成"吃事实向量的函数":真台面跑一次(§14a…§14h 的真跑在下面各自的位置),
// §14e 再把**同一组**函数跑在受控替身上数红几条 —— 负对照验的就是这些断言本身。
function assert14a(C) {
  const F_CHECK = C.check;
  a14(F_CHECK.preChip && F_CHECK.preGrid && F_CHECK.preHist,
    '§14a 前置:核对**之前**标签是「认证:未核对」、明细是「认证 checked_state— · —」、修订链是「· 认证 — ·」');
  a14(F_CHECK.checkPosts === 1, '§14a 前置:核对 POST 只发一次(实测 ' + F_CHECK.checkPosts + ')');
  a14(F_CHECK.itemReread, '§14a ★核对成功后确实**又发了**一发 GET /library/item(条目读数重读)');
  a14(F_CHECK.histReread, '§14a ★又发了 GET /library/history(修订链计数重读)');
  a14(F_CHECK.checksReread, '§14a ★又发了 GET /library/checks(核对留痕重读)');
  a14(F_CHECK.statusReread, '§14a ★又发了 GET /library/status(顶部「条目 / 留痕」统计重读)');
  a14(F_CHECK.readsAfterWrite, '§14a ★这三发都在核对 POST **之后**(不是巧合落在这之前)');
  a14(F_CHECK.chipNew && F_CHECK.chipOldGone,
    '§14a ★★条目标签变成新值「认证:一致」,旧的「认证:未核对」在屏幕上不再出现');
  a14(F_CHECK.gridNew && F_CHECK.gridOldGone,
    '§14a ★★明细里「认证 checked_state」变成 ok + 新时间戳(旧的「— · —」消失)');
  a14(F_CHECK.histNew, '§14a ★★修订链那一行也跟上(「· 认证 ok ·」+「· 核对 1 次」)');
  a14(F_CHECK.trailNew, '§14a 核对留痕跟上(「共 1 次核对」+「第 1 次 · 一致」)');
  a14(F_CHECK.statusStillLoaded, '§14a 顶部状态没有卡在「正在读取图书馆状态…」(失效之后确实读回来了)');
  a14(F_CHECK.listNotRerun, '§14a 详情视图里**不**重跑检索(libReloadList 在 item 视图直接 return)');
}
assert14a({ check: F_CHECK });

// ── §14b 顶部统计跟着写动作走;而且**不是**只发一次就永久缓存 ──
const F_CREATE = await scenCreate(MAIN);
console.log('    §14b 顶部统计实测:/library/status 基线 ' + F_CREATE.statusBase
  + ' → 新建后 ' + F_CREATE.statusAfterCreate + ' → 撤下后 ' + F_CREATE.statusAfterWithdraw
  + '(屏幕上的数字:3 → 4 → 5)');
function assert14b(C) {
  const F_CREATE = C.create;
  a14(F_CREATE.baseTop, '§14b 前置:首屏顶部统计读到了第 1 版回执(条目 3)');
  a14(F_CREATE.createPosts === 1, '§14b 前置:新建只发一次 POST /library/create');
  a14(F_CREATE.createRereadStatus,
    '§14b ★创建成功后 /library/status **被重发一次**(' + F_CREATE.statusBase + ' → ' + F_CREATE.statusAfterCreate + ')');
  a14(F_CREATE.createTopNew, '§14b ★★顶部统计真的走到新值「条目 4」(不是停在写之前的 3)');
  a14(F_CREATE.withdrawPosts === 1, '§14b 前置:撤下只发一次 POST /library/withdraw');
  a14(F_CREATE.withdrawRereadStatus,
    '§14b ★★第二次写动作**仍要**重读 status(' + F_CREATE.statusAfterCreate + ' → ' + F_CREATE.statusAfterWithdraw
    + ')—— 覆盖 statusLoaded 那条早退路径,不是只发一次就永久缓存');
  a14(F_CREATE.withdrawTopNew, '§14b ★★撤下后顶部统计再走到「条目 5」');
}
assert14b({ create: F_CREATE });

// ── §14c 状态读在飞时的写动作不能被吞(statusAgain 那条补读)──
const F_RACE = await scenRace(MAIN);
console.log('    §14c /library/status 计数:进馆 ' + F_RACE.statusFlying
  + ' → 写动作期间 ' + F_RACE.duringFlight + ' → 第一次读完 ' + F_RACE.afterResolve);
function assert14c(C) {
  const F_RACE = C.race;
  a14(F_RACE.statusFlying === 1 && F_RACE.flyingText,
    '§14c 前置:第一次 status 请求确实挂在半空(屏幕上说「正在读取图书馆状态…」)');
  a14(F_RACE.noOverlap, '§14c 在飞的读遇到写动作时**不叠发**第二发(实测并发 ' + F_RACE.duringFlight + ' 发)');
  a14(F_RACE.chipAfterCheck, '§14c 写动作自己的重读照常(标签已经变成「认证:一致」)');
  a14(F_RACE.rereadAfterResolve,
    '§14c ★★第一次 status 一读完**还会再发一次**(' + F_RACE.statusFlying + ' → ' + F_RACE.afterResolve
    + ')—— 写动作那次失效没有被吞(statusAgain)');
  a14(F_RACE.topNew && F_RACE.topOldGone,
    '§14c ★★补读真的落地并重画:顶部从写之前的「条目 2」走到「条目 9」');
  a14(F_RACE.statusStillLoaded, '§14c 补读之后状态盒仍是「图书馆可用」(不是一直停在加载态)');
}
assert14c({ race: F_RACE });

// ── §14d 结果盒不被重读清掉(重读 ≠ 把刚做完的事从屏幕上撤掉)──
console.log('    §14d 重读之后的结果盒 = ' + sResultBoxes(MAIN).length + ' 个:'
  + JSON.stringify(sResultBoxes(MAIN).length ? sResultBoxes(MAIN)[0].slice(0, 42) : ''));
function assert14d(C) {
  const F_CHECK = C.check;
  a14(F_CHECK.resultBoxCount === 1, '§14d ★重读详情之后结果盒仍然**只有一个**且在场(实测 ' + F_CHECK.resultBoxCount + ' 个)');
  a14(F_CHECK.resultBoxKept,
    '§14d ★★结果盒没被 libReloadDetail 清掉:仍是「核对结果:一致」+ recorded/adopted + 口径行');
  a14(F_CHECK.resultBoxKept && F_CHECK.chipNew,
    '§14d ★★同一份渲染里"结果盒是新的"与"标签是新的"**同时**成立 —— 这正是真机上出现两套读数的那处缝');
}
assert14d({ check: F_CHECK });

/** 走查④:在**列表行**上点「核对」—— 行上那张「认证」标签是从 L.items 画的,
 *  只重读详情/统计**不足以**让它跟上,必须重跑当前检索(14f)。 */
async function scenListCheck(A) {
  const TITLE = '列表行上核对要跟上';
  const OLD = libItem({ title: TITLE, checked_state: '', checked_at: null });
  const NEW = libItem({ title: TITLE, checked_state: 'ok', checked_at: '2026-10-06T05:00:00.000Z' });
  let posted = false;
  A.setRespond((rec) => {
    const p = pathOf(rec).split('?')[0];
    if (p === '/library/status') return statusPayload();
    if (p === '/library/search') return sSearchReply([posted ? NEW : OLD]);
    if (p === '/library/item') return { ok: true, found: true, item: posted ? NEW : OLD };
    if (p === '/library/history') return sHistReply(posted ? 'ok' : '', posted ? 1 : 0);
    if (p === '/library/checks') return sChecksReply(posted ? 1 : 0);
    if (p === '/library/check') { posted = true; return sCheckOkReply(); }
    return { ok: true };
  });
  A.open();
  await settle(2);
  await sTab(A, '图书馆');
  sType(A, sField(A, /搜索标题/), '列表行');
  sClick(A, '查询');
  await settle(4);
  const rowsBefore = sRows(A).length;
  const rowBefore = sRows(A)[0] ? sRows(A)[0].textContent : '';
  const searchBefore = sCalls(A, '/library/search').length;
  const ck = sRowBtn(A, 0, '核对');
  if (!ck) throw new Error(A.label + ':列表行上没有「核对」按钮');
  ck.onclick(mkEvent(ck));
  await settle(12);
  const rowAfter = sRows(A)[0] ? sRows(A)[0].textContent : '';
  const searchAfter = sCalls(A, '/library/search').length;
  return {
    rowsBefore: rowsBefore,
    preRowChip: /认证:未核对/.test(rowBefore),
    searchRerun: searchAfter > searchBefore,
    searchAfterWrite: sLastIdx(A, '/library/search') > sLastIdx(A, '/library/check'),
    chipNew: /认证:一致/.test(rowAfter),
    chipOldGone: !/认证:未核对/.test(rowAfter),
    rowsAfter: sRows(A).length,
    text: sText(A),
  };
}

/** 走查⑤:从详情「← 返回列表」—— 必须重跑当前检索,否则返回的是一页**写之前**的旧数据
 *  (撤下的还挂在列表里、刚核对过的行标签还是旧的)(14g)。 */
async function scenBackList(A) {
  const TITLE = '撤下后不该留在列表里';
  const ACTIVE = libItem({ title: TITLE, state: 'active', checked_state: '', checked_at: null });
  const WITHDRAWN = libItem({ title: TITLE, state: 'withdrawn', checked_state: '', checked_at: null,
    withdrawn_at: '2026-10-06T06:00:00.000Z', withdrawn_reason: '回归测试用原因' });
  let withdrew = false;
  A.setRespond((rec) => {
    const p = pathOf(rec).split('?')[0];
    if (p === '/library/status') return statusPayload();
    // 写动作之后服务端默认检索里不再有它(已撤下)⇒ 重跑检索才看得出"那一行没了"
    if (p === '/library/search') return sSearchReply(withdrew ? [] : [ACTIVE]);
    if (p === '/library/item') return { ok: true, found: true, item: withdrew ? WITHDRAWN : ACTIVE };
    if (p === '/library/history') return sHistReply('', 0);
    if (p === '/library/checks') return sChecksReply(0);
    if (p === '/library/withdraw') { withdrew = true; return { ok: true, item: WITHDRAWN }; }
    return { ok: true };
  });
  A.open();
  await settle(2);
  await sTab(A, '图书馆');
  sType(A, sField(A, /搜索标题/), '撤下后');
  sClick(A, '查询');
  await settle(4);
  const rowsBefore = sRows(A).length;
  sClick(A, '详情 / 修订链 / 核对');
  await settle(6);
  sType(A, sField(A, /撤下原因/), '回归测试用原因');
  sClick(A, '撤下这条');                      // 确认框:主台面 confirmAnswer=true,替身 confirm()=true
  await settle(12);
  const searchBeforeBack = sCalls(A, '/library/search').length;
  const writeIdx = sLastIdx(A, '/library/withdraw');
  const back = sBtn(A, '← 返回列表');
  if (!back) throw new Error(A.label + ':详情页没有「← 返回列表」');
  back.onclick(mkEvent(back));
  await settle(12);
  const searchAfterBack = sCalls(A, '/library/search').length;
  const text = sText(A);
  const rowsAfter = sRows(A).length;
  return {
    rowsBefore: rowsBefore,
    rowsAfter: rowsAfter,
    withdrawPosted: writeIdx >= 0,
    searchRerun: searchAfterBack > searchBeforeBack,
    searchAfterWrite: sLastIdx(A, '/library/search') > writeIdx,
    staleRowGone: rowsAfter === 0,
    emptyState: /没有匹配/.test(text),
    text: text,
  };
}

// ── §14f 在**列表行**上核对:列表要重跑当前检索,行上那张「认证」标签要跟上 ──
const F_LIST = await scenListCheck(MAIN);
console.log('    §14f 列表行核对:/library/search 重跑=' + F_LIST.searchRerun
  + ' · 行上标签=' + (F_LIST.chipNew ? '认证:一致(新)' : '仍是旧的'));
function assert14f(C) {
  const F_LIST = C.list;
  a14(F_LIST.rowsBefore === 1 && F_LIST.preRowChip,
    '§14f 前置:列表里有 1 行,行上的标签是「认证:未核对」');
  a14(F_LIST.searchRerun, '§14f ★在列表行上核对成功后**重跑了** /library/search(列表那页读数重读)');
  a14(F_LIST.searchAfterWrite, '§14f ★这次检索发生在核对 POST **之后**(不是旧请求的尾巴)');
  a14(F_LIST.chipNew && F_LIST.chipOldGone,
    '§14f ★★行上的「认证」标签在重画后是新值「认证:一致」,旧的「认证:未核对」不再出现');
  a14(F_LIST.rowsAfter === 1, '§14f 重画之后仍是那一行(不是把列表画没了)');
}
assert14f({ list: F_LIST });

// ── §14g 从详情「← 返回列表」:必须重跑检索,否则返回的是写之前那一页 ──
const F_BACK = await scenBackList(MAIN);
console.log('    §14g 返回列表:/library/search 重跑=' + F_BACK.searchRerun
  + ' · 返回后行数=' + F_BACK.rowsAfter + '(写之前 ' + F_BACK.rowsBefore + ' 行)');
function assert14g(C) {
  const F_BACK = C.back;
  a14(F_BACK.rowsBefore === 1 && F_BACK.withdrawPosted, '§14g 前置:列表里 1 行,撤下确实发出去了');
  a14(F_BACK.searchRerun, '§14g ★点「← 返回列表」之后**重跑了** /library/search');
  a14(F_BACK.searchAfterWrite, '§14g ★这次检索发生在撤下 POST **之后**');
  a14(F_BACK.staleRowGone, '§14g ★★返回的列表里**没有**那一行旧数据(撤下的不再挂在列表里)');
  a14(F_BACK.emptyState, '§14g 并且如实说「没有匹配…」(是新一轮检索的结果,不是空白)');
}
assert14g({ back: F_BACK });

// ── §14h 源码护栏:执行级只走到 create/revise/withdraw/check 四路里的三路,
//    以及"调用顺序"这类看不见的事实 —— 按 §12/§13e 的老办法读源码。 ──
function assert14h(C) {
  const src = C.src;
  a14(/libReloadDetail\(it\.id\);\s*libInvalidateStatus\(\);\s*libReloadList\(\);/.test(src),
    '§14h 核对成功分支:重读三份读数 → status 失效 → 列表重跑,三发都在(且顺序如此)');
  a14(/libInvalidateStatus\(\);\s*if \(saved && saved\.id\) libOpenItem\(saved\.id\);/.test(src),
    '§14h 新建 / 修订成功分支:status 失效排在 libOpenItem 之前(修订与新建同一支,故一并覆盖)');
  a14(/libInvalidateStatus\(\);\s*libOpenItem\(it\.id, false\);/.test(src),
    '§14h 撤下成功分支:status 失效排在 libOpenItem 之前');
  a14(/function libReloadList\(\) \{\s*var L = st\.lib;\s*if \(L\.view === 'item'\) return;/.test(src),
    '§14h libReloadList:详情视图里直接 return(不把主人正在看的条目换掉)');
  a14(/if \(String\(L\.q \|\| ''\)\.trim\(\) === ''\) return;/.test(src),
    '§14h libReloadList:空查询不发注定失败的请求');
  a14(/\/\/ 返回列表时重跑当前检索[\s\S]{0,80}?libReloadList\(\);/.test(src),
    '§14h 「← 返回列表」的 onclick 末尾挂着 libReloadList()');
  a14(/if \(L\.statusLoading\) \{ if \(force\) L\.statusAgain = true; return; \}/.test(src),
    '§14h status 读在飞时又来了写动作 ⇒ 记一笔「读完再补一次」(不吞掉)');
  a14(/if \(L\.statusAgain\) \{ L\.statusAgain = false; libLoadStatus\(true\); \}/.test(src),
    '§14h 读完之后确实把那一笔补读发了出去');
}
assert14h({ src: src });

// ── §14e 负对照(判据有效性):把上面每一条断言对着**坏掉的装载源**再跑一遍 —— 必须变红 ──
// 做法:在**内存里**把磁盘源改回坏行为(磁盘上的 lib/client.js 一个字节都不动:见报告里的 SHA256),
// 装进独立 vm 上下文,**五个走查全跑**、再把 §14a–§14h 的**同一组**断言整组跑上去(收集模式),
// 数一数会红几条。补丁不唯一命中就当场抛(patchOnce)—— 免得"补丁没打上"被当成"验过了"。
async function runVariant(V) {
  const variantSrc = V.build(src);
  const st = await makeStage(variantSrc);
  const A = variantApi(st, V.tag);
  const out = { src: variantSrc };
  out.check = await scenCheck(A);
  out.create = await scenCreate(A);
  out.race = await scenRace(A);
  out.list = await scenListCheck(A);
  out.back = await scenBackList(A);
  const bits = [];
  const put = (k, v) => { if (v !== undefined) bits.push(k + '=' + v); };
  put('itemReread', out.check.itemReread); put('histReread', out.check.histReread); put('checksReread', out.check.checksReread); put('statusReread', out.check.statusReread); put('chipNew', out.check.chipNew); put('resultBoxKept', out.check.resultBoxKept);
  put('createRereadStatus', out.create.createRereadStatus); put('withdrawRereadStatus', out.create.withdrawRereadStatus); put('createTopNew', out.create.createTopNew);
  put('noOverlap', out.race.noOverlap); put('rereadAfterResolve', out.race.rereadAfterResolve); put('topNew', out.race.topNew);
  put('listSearchRerun', out.list.searchRerun); put('listChipNew', out.list.chipNew);
  put('backSearchRerun', out.back.searchRerun); put('staleRowGone', out.back.staleRowGone);
  console.log('    §14e ' + V.tag + ' 事实:' + bits.join(' '));
  return out;
}
/** 收集模式:把 §14a–§14h 的**同一组**断言整体跑在这个装载源的事实向量上,返回会红的那几条。 */
function countRed(ctx) {
  COLLECT = [];
  assert14a(ctx); assert14b(ctx); assert14c(ctx); assert14d(ctx);
  assert14f(ctx); assert14g(ctx); assert14h(ctx);
  const reds = COLLECT;
  COLLECT = null;
  return reds;
}
{
  // V1 = 修复前的行为:核对成功只重读「留痕」;新建/修订/撤下都不让 status 失效;返回列表不重跑检索。
  const V1 = {
    tag: 'V1(修复前)',
    build(s) {
      let out = patchOnce(s, /libReloadDetail\(it\.id\);(\s*)libInvalidateStatus\(\);(\s*)libReloadList\(\);/,
        'libLoadChecks(it.id, 0);', 'V1 核对成功分支');
      out = patchOnce(out, /libInvalidateStatus\(\);(\s*)(if \(saved && saved\.id\) libOpenItem\(saved\.id\);)/, '$2', 'V1 新建/修订分支');
      out = patchOnce(out, /libInvalidateStatus\(\);(\s*)(libOpenItem\(it\.id, false\);)/, '$2', 'V1 撤下分支');
      out = patchOnce(out, /libReloadList\(\);(\s*)\};/, '$1};', 'V1 返回列表不重跑检索');
      return out;
    },
  };
  const r1 = await runVariant(V1);
  const red1 = countRed(r1);
  console.log('    §14e V1 整组断言实测:红 ' + red1.length + ' 条 / 67');
  a14(red1.length > 0, '§14e V1 ⇒ 把 §14a–§14h 的同一组断言整体跑在"修复前"的装载源上,实测红 ' + red1.length + '/67 条');
  a14(r1.check.itemReread === false && r1.check.histReread === false && r1.check.statusReread === false,
    '§14e V1 ⇒ §14a 的「条目 / 修订链 / 统计三份重读」变假(itemReread/histReread/statusReread 全 false)');
  a14(r1.check.checksReread === true,
    '§14e V1 如实留痕:修复前**只**重读「核对留痕」⇒ 屏幕上就是"结果盒/留痕是新的、其余停在旧值"那两套读数(真机缺陷的原样)');
  a14(r1.check.chipNew === false && r1.check.chipOldGone === false && r1.check.gridNew === false
    && r1.check.histNew === false,
    '§14e V1 ⇒ §14a 的「标签 / 明细 / 修订链变成新值」变假(是真机上停在旧值的那种坏)');
  a14(r1.create.createRereadStatus === false && r1.create.createTopNew === false,
    '§14e V1 ⇒ §14b 的「创建后重发 status / 顶部走到新值」变假');
  a14(r1.create.withdrawRereadStatus === false && r1.create.withdrawTopNew === false,
    '§14e V1 ⇒ §14b 的「第二次写动作仍要重读」变假');
  a14(r1.race.rereadAfterResolve === false && r1.race.topNew === false,
    '§14e V1 ⇒ §14c 的「在飞时写动作不被吞(补读 + 重画)」变假');
  a14(r1.list.searchRerun === false && r1.list.chipNew === false,
    '§14e V1 ⇒ §14f 的「列表行核对后重跑检索 / 行标签跟上」变假');
  a14(r1.back.searchRerun === false && r1.back.staleRowGone === false,
    '§14e V1 ⇒ §14g 的「返回列表重跑检索 / 旧行消失」变假');
  a14(r1.check.resultBoxKept === true && r1.check.listNotRerun === true,
    '§14e V1 如实留痕:修复前结果盒也还在、详情里也不重跑检索 ⇒ §14d 不由 V1 覆盖(它盯的是"重读时别把结果盒清掉",见 V2)');
}
{
  // V2 = 过度修复:核对成功后整条重开(libOpenItem)而不是"重读三份读数" —— 结果盒会被清掉。
  const V2 = {
    tag: 'V2(整条重开)',
    build(s) { return patchOnce(s, /libReloadDetail\(it\.id\);/, 'libOpenItem(it.id, true);', 'V2 核对成功分支改成整条重开'); },
  };
  const r2 = await runVariant(V2);
  const red2 = countRed(r2);
  console.log('    §14e V2 整组断言实测:红 ' + red2.length + ' 条 / 67');
  a14(red2.length > 0, '§14e V2 ⇒ 同一组断言在"整条重开"的装载源上,实测红 ' + red2.length + '/67 条');
  a14(r2.check.resultBoxKept === false,
    '§14e V2 ⇒ §14d 的「结果盒不被清掉」变假(整条重开会把刚做完的核对结果从屏幕上撤掉)');
  a14(r2.check.itemReread === true && r2.check.chipNew === true,
    '§14e V2 如实留痕:那条路上重读与标签仍然为真 ⇒ §14d 是**独立**的一条判据,不是 §14a 的附庸');
}
{
  // V3 = 只调 loader、不清那次性缓存(statusLoaded 那条早退路径把写动作整个吞掉)。
  const V3 = {
    tag: 'V3(缓存没失效)',
    build(s) {
      return patchOnce(s, /function libInvalidateStatus\(\) \{\s*st\.lib\.statusLoaded = false;\s*libLoadStatus\(true\);\s*\}/,
        'function libInvalidateStatus() { libLoadStatus(); }', 'V3 status 失效只调 loader');
    },
  };
  const r3 = await runVariant(V3);
  const red3 = countRed(r3);
  console.log('    §14e V3 整组断言实测:红 ' + red3.length + ' 条 / 67');
  a14(red3.length > 0, '§14e V3 ⇒ 同一组断言在"缓存没失效"的装载源上,实测红 ' + red3.length + '/67 条');
  a14(r3.check.statusReread === false && r3.check.itemReread === true,
    '§14e V3 ⇒ §14a 的「status 重读」变假(条目那种一次性缓存不值得信任,恰恰是这次缺陷的根)');
  a14(r3.create.createRereadStatus === false && r3.create.createTopNew === false,
    '§14e V3 ⇒ §14b 的「写动作后重发 status」变假');
  a14(r3.race.rereadAfterResolve === false && r3.race.noOverlap === true,
    '§14e V3 ⇒ §14c 的「补读」变假(而且它连叠发都不叠,是真静默吞掉)');
}
{
  // V4 = 在飞时直接吞掉、不记 statusAgain —— 只打 §14c 那一处(其余判据应当仍为真)。
  const V4 = {
    tag: 'V4(在飞时吞掉)',
    build(s) {
      return patchOnce(s, /if \(L\.statusLoading\) \{ if \(force\) L\.statusAgain = true; return; \}/,
        'if (L.statusLoading) { return; }', 'V4 在飞时直接吞掉');
    },
  };
  const r4 = await runVariant(V4);
  const red4 = countRed(r4);
  console.log('    §14e V4 整组断言实测:红 ' + red4.length + ' 条 / 67');
  a14(red4.length > 0, '§14e V4 ⇒ 同一组断言在"在飞时直接吞掉"的装载源上,实测红 ' + red4.length + '/67 条');
  a14(r4.race.rereadAfterResolve === false && r4.race.topNew === false,
    '§14e V4 ⇒ §14c 的「补读」变假(读到一半来的写动作被吞掉,屏幕上统计不动)');
  a14(r4.check.statusReread === true && r4.check.chipNew === true,
    '§14e V4 如实留痕:不在飞时(status 空闲)的写动作照常重读 ⇒ §14c 是**专门**盯在飞那一支的判据');
}
{
  // V5 = 只去掉「列表行核对」那一发(详情/统计照旧)⇒ 只 §14f 变红。
  const V5 = {
    tag: 'V5(列表不重跑)',
    build(s) { return patchOnce(s, /libReloadList\(\);(\s*)(\/\/ 在列表行上核对时)/, '$2', 'V5 核对成功后不重跑列表'); },
  };
  const r5 = await runVariant(V5);
  const red5 = countRed(r5);
  console.log('    §14e V5 整组断言实测:红 ' + red5.length + ' 条 / 67');
  a14(red5.length > 0, '§14e V5 ⇒ 同一组断言在"列表不重跑"的装载源上,实测红 ' + red5.length + '/67 条');
  a14(r5.list.searchRerun === false && r5.list.chipNew === false,
    '§14e V5 ⇒ §14f 的「列表行核对后重跑检索 / 行标签跟上」变假(那一行的标签是从 L.items 画的)');
  a14(r5.back.searchRerun === true && r5.back.staleRowGone === true,
    '§14e V5 如实留痕:撤回列表那条路仍在 ⇒ §14f 与 §14g 是两条各自独立的判据');
}
{
  // V6 = 只去掉「← 返回列表」那一发 ⇒ 只 §14g 变红。
  const V6 = {
    tag: 'V6(返回不重跑)',
    build(s) { return patchOnce(s, /libReloadList\(\);(\s*)\};/, '$1};', 'V6 返回列表不重跑检索'); },
  };
  const r6 = await runVariant(V6, ['list', 'back']);
  a14(r6.back.searchRerun === false && r6.back.staleRowGone === false,
    '§14e V6 ⇒ §14g 的「返回列表重跑检索 / 旧行消失」变假(返回的是一页写之前的旧数据)');
  a14(r6.list.searchRerun === true && r6.list.chipNew === true,
    '§14e V6 如实留痕:列表行那条路仍在 ⇒ 两条判据互不代偿');
}

console.log('    §14 断言点 = ' + A14 + ' 条(全部执行;负对照 6 个受控替身 × 15 次走查另计)');

// ─────────────────── §15 导入面(图书馆):分析不写库 · 人审才入库 ───────────────────
// 口径:与真人点击走**同一条**代码路径(切标签 → 点按钮 → 填框 → 再点),断言分三层:
//   ① 请求侧:发了几发、发给谁、body 里带了什么(**尤其"没带什么"**);
//   ② 界面侧:勾选框的默认值是不是只认服务端的 `selected`、计数跟不跟得上;
//   ③ 措辞侧:回执有没有说谎(没有候选 ≠ 导入成功;跳过 ≠ 失败;没跑模型 ≠ 跑了模型)。
await section('§15 导入面:分析不写库 · 逐条人审 · 回执不说谎');
const IMP_ANALYZE = '/library/import/analyze';
const IMP_COMMIT = '/library/import/commit';
function impCand(over) {
  return Object.assign({
    index: 1, title: 'H7 基准孔', body: 'H7: +0.015/0', category: 'standard-value', source_kind: 'manual',
    source_ref: 'probe.csv#2', as_of: '2026-10-12', locator: '2', evidence: 'H7: +0.015/0',
    origin: 'rule', locator_verified: true, issues: [], selected: true,
  }, over || {});
}
function impAnalyzeReply(over) {
  return Object.assign({
    ok: true, source_hash: HASH_A,
    candidates: [
      impCand(),
      impCand({
        index: 2, locator: '3', title: '第 3 行', evidence: '原文里没有的串',
        locator_verified: false, issues: ['evidence_not_found'], selected: false,
      }),
    ],
    stats: { rows: 2, candidates: 2, rejected: 1, model_used: false, model: null },
  }, over || {});
}
function impRoutes(analyzeReply) {
  return [
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [], nextOffset: null, truncated: false }],
    [IMP_ANALYZE, analyzeReply],
    [IMP_COMMIT, { ok: true, committed: 1, skipped: 1, rejected: [{ index: 2, reason: 'unknown_field', message: '条目含未知字段:x' }], ids: [A] }],
  ];
}
async function gotoImport(routes) {
  await gotoLibrary(routes);
  await settle(2);
  clickBtn('⬆ 导入(粘贴 / 文件)');
  await settle(2);
  return panel;
}
function impChecks() { return allEls(panel).filter((e) => e.tagName === 'INPUT' && e.type === 'checkbox'); }

{
  await gotoLibrary(impRoutes(impAnalyzeReply()));
  await settle(3);
  ok(!!button('⬆ 导入(粘贴 / 文件)'), '§15.1 列表页有「⬆ 导入(粘贴 / 文件)」入口');
  const n0 = calls.length;
  clickBtn('⬆ 导入(粘贴 / 文件)');
  await settle(2);
  eq(calls.length, n0, '§15.1 ★切进导入面零请求(只换视图,不预读、不预分析)');
  ok(!!field(/源名/), '§15.1 有源名输入框');
  ok(!!field(/把 CSV/), '§15.1 有粘贴框');
  ok(!!button('① 分析(不写库)'), '§15.1 有「① 分析(不写库)」');
  ok(!button('② 提交入库(0 条)'), '§15.1 还没分析 ⇒ 没有提交按钮(没东西可提交)');
  ok(!/② 候选/.test(bodyText()), '§15.1 还没分析 ⇒ 界面上没有候选区');
}

{
  await gotoImport(impRoutes(impAnalyzeReply()));
  clickBtn('① 分析(不写库)');
  await settle(2);
  eq(libCalls(IMP_ANALYZE).length, 0, '§15.2 源名为空 ⇒ 零请求');
  ok(/源名必填/.test(bodyText()), '§15.2 如实说明为什么没发出去');
  typeInto(field(/源名/), 'probe.csv');
  await settle(1);
  clickBtn('① 分析(不写库)');
  await settle(2);
  eq(libCalls(IMP_ANALYZE).length, 0, '§15.2 源文本为空 ⇒ 也零请求');
  ok(/源文本是空的/.test(bodyText()), '§15.2 空源说的是"没有东西可读",不是"导入 0 条"');
}

{
  await gotoImport(impRoutes(impAnalyzeReply()));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,基准孔\nH8,轴');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const a = libCalls(IMP_ANALYZE);
  eq(a.length, 1, '§15.3 一次点击 = 一发 analyze');
  eq(a[0].method, 'POST', '§15.3 analyze 是 POST');
  eq(a[0].body.kind, 'csv', '§15.3 带上 kind');
  eq(a[0].body.name, 'probe.csv', '§15.3 带上源名(它是 source_ref 的前半截)');
  ok(String(a[0].body.text).indexOf('H7') >= 0, '§15.3 带上源文本');
  ok(String(a[0].body.as_of).length === 10, '§15.3 带上 as_of(面板给"今天")');
  ok(!Object.prototype.hasOwnProperty.call(a[0].body, 'model'),
    '§15.3 ★引擎为默认(不用模型)⇒ body 里**没有** model 字段(不替主人决定调模型)');
  ok(!Object.prototype.hasOwnProperty.call(a[0].body, 'category'),
    '§15.3 类目选"不指定"⇒ 不带 category(不在这里镜像服务端的默认值)');
  eq(libCalls(IMP_COMMIT).length, 0, '§15.3 ★分析不写库:这一发没带任何 commit');
  const cs = impChecks();
  eq(cs.length, 2, '§15.3 两条候选各一个勾选框(实测 ' + cs.length + ')');
  eq(cs[0].checked, true, '§15.3 定位回查通过的条目默认勾选');
  eq(cs[1].checked, false, '§15.3 ★定位没回查到的条目默认**不勾**');
  ok(/模型段:没跑/.test(bodyText()), '§15.3 回执如实说"模型段没跑"');
  ok(!/模型段:跑了/.test(bodyText()), '§15.3 没有把"没跑"写成"跑了"');
  ok(!!button('② 提交入库(1 条)'), '§15.3 提交按钮上的条数 = 当前勾选数(默认 1 条)');
  ok(/默认未勾 1 条/.test(bodyText()), '§15.3 默认未勾的条数显式说出来');
}

{
  await gotoImport(impRoutes(impAnalyzeReply({
    stats: { rows: 1, candidates: 1, rejected: 0, model_used: true, model: 'assistant:qwen-test', model_rows: 1, model_rows_capped: true },
  })));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,基准孔');
  pickSelItem('本机小助手(零成本)');
  await settle(2);
  clickBtn('① 分析(不写库)');
  await settle(3);
  const a = libCalls(IMP_ANALYZE);
  eq(a.length, 1, '§15.4 选引擎之后仍是一发(不是"选一下发一发")');
  eq(a[0].body.model, 'assistant', '§15.4 ★选了引擎才带 model 字段');
  ok(/模型段:跑了 assistant:qwen-test/.test(bodyText()),
    '§15.4 ★回执如实写出模型名(契约 §3:不许把"两次结果不一样"藏起来)');
  ok(/触到成本闸/.test(bodyText()), '§15.4 送模型条数触到成本闸 ⇒ 说出来');
}

{
  await gotoImport(impRoutes(impAnalyzeReply()));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,基准孔');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const cs = impChecks();
  cs[0].checked = false;
  cs[0].onchange(mkEvent(cs[0]));
  await settle(2);
  ok(!!button('② 提交入库(0 条)'), '§15.5 按钮上的条数跟着勾选走(全取消 ⇒ 0 条)');
  clickBtn('② 提交入库(0 条)');
  await settle(2);
  eq(libCalls(IMP_COMMIT).length, 0, '§15.5 ★一条都没勾 ⇒ 零请求(分析不会自动入库)');
  ok(/一条都没勾/.test(bodyText()), '§15.5 如实说明"没有发出任何请求"');
}

{
  await gotoImport(impRoutes(impAnalyzeReply()));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,基准孔');
  clickBtn('① 分析(不写库)');
  await settle(3);
  clickBtn('② 提交入库(1 条)');
  await settle(3);
  const cm = libCalls(IMP_COMMIT);
  eq(cm.length, 1, '§15.6 一次提交 = 一发 commit');
  eq(cm[0].method, 'POST', '§15.6 commit 是 POST');
  eq(cm[0].body.source_hash, HASH_A, '§15.6 带回分析时给的源摘要(幂等键的一半)');
  eq(cm[0].body.items.length, 1, '§15.6 ★只送勾了的那条');
  eq(cm[0].body.items[0].locator, '2', '§15.6 送的是被勾的那条(定位 2)');
  eq(cm[0].body.items[0].origin, 'rule', '§15.6 候选**原样**送出(剥导入层字段是服务端的事,客户端不抢先剥)');
  const txt = bodyText();
  ok(/写入 1 条/.test(txt), '§15.6 回执如实写"写入 1 条"');
  ok(/跳过 1 条/.test(txt) && /幂等命中,这是成功不是失败/.test(txt), '§15.6 ★幂等跳过说的是成功,不是失败');
  ok(/被拒 1 条/.test(txt), '§15.6 被拒的条数显式印出来');
  ok(/unknown_field/.test(txt), '§15.6 ★被拒的 reason 逐条原样印出(不翻译、不吞掉)');
  const iCm = calls.findIndex((c) => pathOf(c).split('?')[0] === IMP_COMMIT);
  const iSt = calls.findIndex((c, i) => i > iCm && pathOf(c).split('?')[0] === '/library/status');
  ok(iSt > iCm, '§15.6 入库后重读 status(条数与留痕的读数不留在写之前)');
}

{
  await gotoImport(impRoutes(impAnalyzeReply({
    candidates: [], stats: { rows: 0, candidates: 0, rejected: 0, model_used: false, model: null },
  })));
  typeInto(field(/源名/), 'empty.csv');
  typeInto(field(/把 CSV/), '代号,名称\n');
  clickBtn('① 分析(不写库)');
  await settle(3);
  ok(/没有候选/.test(bodyText()), '§15.7 ★只有表头 ⇒ 说的是"没有候选"');
  // ⚠️ 这里**故意不用** `/!/导入成功/.test(txt)` 这种裸子串断言:空候选的文案里本来就写着
  //   "这不是「导入成功 0 条」" —— 裸子串会被**自己的否定句**满足(本套件 §12 的 innerHTML
  //   断言在注释上吃过同款亏)。判"有没有把它说成成功"要看**成功态的结构与词汇**:
  //   空候选路径不许打成功标记(✓)、不许出现只有入库回执才配说的"写入 N 条"。
  const txt7 = bodyText();
  ok(!/[✓✔]/.test(txt7), '§15.7 ★空源不打成功标记(✓)');
  ok(!/写入\s*\d+\s*条|已写入/.test(txt7), '§15.7 ★空源不出现入库词汇("写入 N 条"只配在入库回执里说)');
  ok(!button('② 提交入库(0 条)'), '§15.7 没有候选 ⇒ 连提交按钮都不出现');
}

{
  // ⚠️ 2026-10-14 D11 之后,这条改钉**通用**失败路径(参数被拒 / 网关回 ok:false):
  //    模型段失败**不再**走这里 —— 它现在是 200 + `stats.model_error`(见 §18)。
  await gotoImport(impRoutes({ ok: false, reason: 'invalid_limit', message: 'limit 必须是 1..100' }));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,基准孔');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const txt = bodyText();
  ok(/分析被拒/.test(txt) && /limit 必须是/.test(txt), '§15.8 ★失败回执原样印出(message 优先,reason 也在)');
  ok(!/② 候选/.test(txt), '§15.8 ★失败时不画候选区(失败回执里本来就没有候选)');
  ok(!button('② 提交入库(0 条)') && !button('② 提交入库(1 条)'), '§15.8 失败时没有提交按钮');
  eq(libCalls(IMP_COMMIT).length, 0, '§15.8 失败路径没有发出 commit');
}

{
  await gotoImport(impRoutes(impAnalyzeReply()));
  const fin = allEls(panel).find((e) => e.tagName === 'INPUT' && e.type === 'file');
  ok(!!fin, '§15.9 有选文件入口');
  fin.files = [{ name: 'gb.csv', text: async () => '代号,名称\nH7,x' }];
  fin.onchange(mkEvent(fin));
  await settle(3);
  eq(field(/把 CSV/).value, '代号,名称\nH7,x', '§15.9 选文件 = 内容读进粘贴框(发的仍是文本,不是文件本身)');
  eq(field(/源名/).value, 'gb.csv', '§15.9 源名留空时从文件名补上');
  eq(libCalls(IMP_ANALYZE).length, 0, '§15.9 读文件本身零请求');
  fin.files = [{ name: 'x.csv' }];
  fin.onchange(mkEvent(fin));
  await settle(2);
  ok(/读不了文件内容/.test(bodyText()), '§15.9 没有 File.text() 的浏览器里如实说,并给出"粘贴"这条路');
}

console.log('    §15 断言点 = 45 条(导入面:请求侧 / 界面侧 / 措辞侧)');

// ─────────────── §16 浏览面(第七面):只读 · 不搜也能翻 · 骨架来自服务端 ───────────────
// 口径(用户 2026-10-13 拍板,形态 A):
//   ① **只读**:这一面不许出现任何写按钮,发出的请求必须全是 GET;
//   ② 树的骨架来自服务端回的 `groups`(恒定全量),**不是**从"当前这一页条目"反推 ——
//      所以"进面 = 1 发骨架请求""不展开就不取条目"这两条可以逐发数出来;
//   ③ 服务端不给 total ⇒ 界面**不许**写"共 N 条"(契约禁止误导性 total);
//   ④ 迟到回画守卫:切走标签之后回来的回执**整条丢弃**,不许画进别的标签。
await section('§16 浏览面:只读 · 骨架来自服务端 · 懒加载 · 迟到回画丢弃');
const BR = '/library/browse';
const BR_ITEM = '/library/item';
const BR_HIST = '/library/history';
const BR_CK = '/library/checks';
const C = 'lib:33333333-3333-3333-3333-333333333333';
const D = 'lib:44444444-4444-4444-4444-444444444444';
function brGroups() {
  return [
    { category: 'standard-value', source_kind: 'manual', count: 3, active: 1 },
    { category: 'official-doc', source_kind: 'code', count: 2, active: 2 },
  ];
}
function brReply(over) {
  return Object.assign({
    ok: true, groups: brGroups(), items: [], offset: 0, limit: 20, count: 0,
    nextOffset: null, truncated: false,
  }, over || {});
}
function brItemsReply(over) {
  return brReply(Object.assign({
    items: [libItem({ id: A, title: '第一条', import_key: 'deadbeefdeadbeef:2' }), libItem({ id: B, title: '第二条' })],
    count: 2,
  }, over || {}));
}
function brHistReply(over) {
  return Object.assign({
    ok: true, found: true, item_id: A, lineage_id: A, revision_count: 2, check_total: 1,
    counts: { active: 1, superseded: 1, withdrawn: 0 }, offset: 0, limit: 20, count: 2,
    nextOffset: null, truncated: false,
    revisions: [
      { id: A, revision: 2, previous_id: B, state: 'active', checked_state: '', check_count: 1, is_current: true, created_at: '2026-10-13T00:00:00.000Z' },
      { id: B, revision: 1, previous_id: null, state: 'superseded', checked_state: '', check_count: 0, is_current: false, created_at: '2026-10-12T00:00:00.000Z' },
    ],
  }, over || {});
}
function brChecksReply(over) {
  return Object.assign({
    ok: true, item_id: A, lineage_id: A, total: 1, offset: 0, limit: 20, count: 1,
    checks: [{ check_sequence: 1, state: 'ok', checked_at: '2026-10-13T01:00:00.000Z', adopted: true, reason: '' }],
  }, over || {});
}
function brRoutes(over) {
  const o = over || {};
  return [
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [], nextOffset: null, truncated: false }],
    [BR, (rec) => {
      if (qsOf(rec, 'category')) return o.group ? o.group(rec) : brItemsReply();
      return o.groups ? o.groups(rec) : brReply();
    }],
    [BR_ITEM, { ok: true, found: true, item: libItem({ id: A, title: '第一条', body: '正文', import_key: 'deadbeefdeadbeef:2' }) }],
    [BR_HIST, brHistReply()],
    [BR_CK, brChecksReply()],
  ];
}
async function gotoBrowse(routes) {
  await gotoLibrary(routes);
  await settle(2);
  clickBtn('🗂 浏览(不搜也能翻)');
  await settle(3);
  return panel;
}
function brHeads() { return allEls(panel).filter((e) => String(e.className).split(/\s+/).includes('lib-br-head')); }
function brLeaves() { return allEls(panel).filter((e) => String(e.className).split(/\s+/).includes('lib-br-leaf')); }
function brPanelButtons() { return allEls(panel).filter((e) => e.tagName === 'BUTTON').map((e) => e.textContent.trim()); }
/** 树容器 = 从任一分组头往上走,第一个挂着 `onscroll` 的祖先(浏览面把"保滚动位置 + 滚到底续页"都挂在那一个上)。 */
function brTreeBox() {
  let n = brHeads()[0];
  while (n && !n.onscroll) n = n.parentNode;
  return n;
}

{
  await gotoLibrary(brRoutes());
  await settle(3);
  ok(!!button('🗂 浏览(不搜也能翻)'), '§16.1 列表页有「🗂 浏览(不搜也能翻)」入口');
  const b0 = libCalls(BR).length;
  clickBtn('🗂 浏览(不搜也能翻)');
  await settle(3);
  eq(libCalls(BR).length - b0, 1, '§16.1 ★切进浏览面只发 1 发 browse(取骨架),不做别的预读');
  eq(qsOf(libCalls(BR)[libCalls(BR).length - 1], 'category'), null,
    '§16.1 骨架那一发不带 category(要的是恒定全量的分组表)');
  ok(!!button('← 回到列表(维护面)') && !!button('刷新'), '§16.1 面内工具只有「返回」与「刷新」');
  ok(!button('② 提交入库(0 条)'), '§16.1 浏览面里没有导入面的提交按钮');
}

{
  await gotoBrowse(brRoutes());
  const bt = bodyText();
  ok(/\(3 条 · 有效 1\)/.test(bt), '§16.2 ★组头的计数逐字来自服务端 groups(实测缺 (3 条 · 有效 1))');
  ok(/\(3 条\)/.test(bt), '§16.2 类目头的计数 = 其下各组之和');
  eq(libCalls(BR).filter((c) => qsOf(c, 'category')).length, 0,
    '§16.2 ★没展开任何组 ⇒ 零发条目请求(懒加载)');
  const empty = brHeads().find((h) => /\(0 条\)/.test(h.textContent));
  ok(!!empty && typeof empty.onclick !== 'function',
    '§16.2 空类目不假装能点(没有 onclick,只给一句 title)');
}

{
  await gotoBrowse(brRoutes());
  const src = brHeads().find((h) => /有效 1/.test(h.textContent));
  ok(!!src, '§16.3 找到来源组头');
  clickNode(src);
  await settle(4);
  const bs = libCalls(BR).filter((c) => qsOf(c, 'category'));
  eq(bs.length, 1, '§16.3 展开一组 = 恰好 1 发');
  eq(qsOf(bs[0], 'category'), 'standard-value', '§16.3 带上类目');
  eq(qsOf(bs[0], 'source_kind'), 'manual', '§16.3 带上来源');
  eq(qsOf(bs[0], 'limit') + '/' + qsOf(bs[0], 'offset'), '200/0', '§16.3 首页 = limit 200 / offset 0(默认一页 200 条)');
  eq(brLeaves().length, 2, '§16.3 这一页几条就画几条(实测 ' + brLeaves().length + ')');
}

{
  await gotoBrowse(brRoutes());
  clickNode(brHeads().find((h) => /有效 1/.test(h.textContent)));
  await settle(4);
  clickNode(brLeaves()[0]);
  await settle(5);
  eq(libCalls(BR_ITEM).length, 1, '§16.4 选中一条 = 1 发取条目本体');
  eq(libCalls(BR_HIST).length, 1, '§16.4 同时 1 发取谱系链');
  eq(libCalls(BR_CK).length, 1, '§16.4 同时 1 发取核对史');
  const bt = bodyText();
  ok(/详情\(这一面只读\)/.test(bt), '§16.4 ★详情区自己就写着"只读"');
  ok(/content_hash/.test(bt) && /import_key/.test(bt), '§16.4 字段逐项印出(含 content_hash 与 import_key)');
  ok(/本谱系共 2 个版本\(有效 1 \/ 已取代 1 \/ 已撤下 0\)/.test(bt),
    '§16.4 ★谱系链来自 history 回执(版本数与三态计数逐字对上)');
  ok(/r2 \(当前\)/.test(bt), '§16.4 当前版本被标出来');
  ok(/第 1 次/.test(bt) && /adopted=true/.test(bt), '§16.4 核对史逐条印(序号 / 状态 / adopted)');
}

{
  const gets = libCalls(BR).concat(libCalls(BR_ITEM), libCalls(BR_HIST), libCalls(BR_CK));
  ok(gets.length > 0 && gets.every((c) => c.method === 'GET'),
    '§16.5 ★浏览面发出的每一发都是 GET(实测 ' + gets.length + ' 发)');
  const labels = brPanelButtons();
  ok(!labels.some((l) => /新建|修订|撤下|核对|提交入库|删除|保存/.test(l)),
    '§16.5 ★这一面一个写按钮都没有(实测按钮:' + labels.join(' / ') + ')');
  ok(!/共\s*\d+\s*条/.test(bodyText()),
    '§16.5 ★不写"共 N 条"(服务端不给 total,界面不许自己编一个总数出来)');
}

{
  const held = defer();
  await gotoLibrary([['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [], nextOffset: null, truncated: false }],
    [BR, (rec) => (qsOf(rec, 'category') ? brItemsReply() : held.promise)]]);
  await settle(2);
  clickBtn('🗂 浏览(不搜也能翻)');
  await settle(2);
  ok(/正在读取分组…/.test(bodyText()), '§16.6 骨架在飞时如实说"正在读取分组…"');
  await clickTab('记忆浏览');
  await settle(2);
  held.resolve(brReply());
  await settle(4);
  ok(!/浏览面 —— 只读/.test(bodyText()),
    '§16.6 ★切走之后迟到的那一发**整条丢弃**,没有画进另一个标签(记忆浏览里不见浏览面的字)');
}

{
  let page = 0;
  const groupReply = () => {
    page += 1;
    return page === 1
      ? brItemsReply({
        items: [libItem({ id: A, title: '第一条' }), libItem({ id: B, title: '第二条' })],
        truncated: true, nextOffset: 200,
      })
      : brItemsReply({
        items: [libItem({ id: C, title: '第三条' }), libItem({ id: D, title: '第四条' })],
        offset: 200, truncated: false, nextOffset: null,
      });
  };
  await gotoBrowse(brRoutes({ group: groupReply }));
  clickNode(brHeads().find((h) => /有效 1/.test(h.textContent)));
  await settle(4);
  const first = libCalls(BR).filter((c) => qsOf(c, 'category'));
  eq(qsOf(first[0], 'limit'), '200', '§16.7 ★默认一页 200 条(2026-10-13 主人定)');
  eq(qsOf(first[0], 'fields'), 'row',
    '§16.7 ★列表行不带正文(fields=row)—— 否则 200 条会被 256 KiB 的响应字节闸截成几条');
  ok(!!button('继续加载 ▾'), '§16.7 还没取完 ⇒ 出现「继续加载 ▾」(不假装已经取完)');
  eq(brLeaves().length, 2, '§16.7 第一页两条');
  clickBtn('继续加载 ▾');
  await settle(4);
  const bs = libCalls(BR).filter((c) => qsOf(c, 'category'));
  eq(qsOf(bs[bs.length - 1], 'offset'), '200', '§16.7 ★续页带的是服务端给的 nextOffset(不自己算偏移)');
  eq(brLeaves().length, 4, '§16.7 ★第二页是**追加**不是替换(2 → 4,实测 ' + brLeaves().length + ')');
  ok(!button('继续加载 ▾'), '§16.7 末页 nextOffset=null ⇒ 「继续加载」消失');
  ok(/— 已到最早 —/.test(bodyText()), '§16.7 ★取完了要有终止句(不能让人一直等着"也许还能翻")');
}

{
  // 总量 2500 > 1000 ⇒ 展开那一刻就走**分页**(只留当前页,不累积)
  const GROUPS = [{ category: 'standard-value', source_kind: 'manual', count: 2500, active: 2400 }];
  const bigGroups = () => brReply({
    groups: GROUPS,
    items: [libItem({ id: A, title: '大组第一条' }), libItem({ id: B, title: '大组第二条' })],
    count: 2, nextOffset: 200, truncated: true,
  });
  const pageReply = (rec) => {
    const off = qsOf(rec, 'offset') || '0';
    return brReply({
      groups: GROUPS,
      items: off === '200'
        ? [libItem({ id: C, title: '第二页第一条' })]
        : [libItem({ id: A, title: '大组第一条' }), libItem({ id: B, title: '大组第二条' })],
      offset: Number(off), count: off === '200' ? 1 : 2,
      nextOffset: off === '200' ? 400 : 200, truncated: true,
    });
  };
  await gotoBrowse([
    ['/library/status', statusPayload()],
    ['/library/search', { ok: true, items: [], nextOffset: null, truncated: false }],
    [BR, (rec) => (qsOf(rec, 'category') ? pageReply(rec) : bigGroups())],
    [BR_ITEM, { ok: true, found: true, item: libItem({ id: A, title: '大组第一条' }) }],
    [BR_HIST, brHistReply()],
    [BR_CK, brChecksReply()],
  ]);
  // ⚠️ 必须点**来源层**的头:类目头的计数是各组之和(这里同样含"2500 条"),点它会去折叠类目而不是展开组
  clickNode(brHeads().find((h) => /2500 条 · 有效 2400/.test(h.textContent)));
  await settle(4);
  ok(!!button('下一页 ›'), '§16.8 ★总量 2500 > 1000 ⇒ 切分页(出现「下一页 ›」)');
  ok(!button('继续加载 ▾'), '§16.8 ★分页模式下**没有**「继续加载」(这一模式就是要人点页码,不许一路累积)');
  eq(brLeaves().length, 2, '§16.8 第一页两条');
  ok(/第 1 \/ 13 页/.test(bodyText()), '§16.8 ★页码算得对(2500 条 ÷ 200 = 13 页)');
  clickBtn('下一页 ›');
  await settle(4);
  const bc = libCalls(BR).filter((c) => qsOf(c, 'category'));
  eq(qsOf(bc[bc.length - 1], 'offset'), '200', '§16.8 ★翻页 = 按页边界取 offset=200');
  eq(brLeaves().length, 1, '§16.8 ★翻页是**替换**不是追加(2 → 1):缓存里只留当前页');
  ok(/第二页第一条/.test(bodyText()), '§16.8 ★第二页的内容真的画出来了');
  ok(!/大组第一条/.test(bodyText()), '§16.8 ★第一页的内容已经不在树里(被换掉)');
  ok(!!button('‹ 上一页'), '§16.8 有「上一页」可回退');
}

{
  // 与「记忆浏览」同款:滚到底自动续页 —— 这里钉住"树容器上真的挂了 scroll 入口,且会触发取下一发"
  let page = 0;
  const groupReply = () => {
    page += 1;
    return page === 1
      ? brItemsReply({ items: [libItem({ id: A, title: '滚动第一条' })], count: 1, truncated: true, nextOffset: 200 })
      : brItemsReply({ items: [libItem({ id: B, title: '滚动第二条' })], offset: 200, count: 1, truncated: false, nextOffset: null });
  };
  await gotoBrowse(brRoutes({ group: groupReply }));
  clickNode(brHeads().find((h) => /有效 1/.test(h.textContent)));
  await settle(4);
  eq(brLeaves().length, 1, '§16.9 第一页一条');
  const tb = brTreeBox();
  ok(!!tb && typeof tb.onscroll === 'function', '§16.9 ★树容器上挂着 scroll(滚到底续页的入口)');
  tb.scrollHeight = 1000;
  tb.clientHeight = 300;
  tb.scrollTop = 600; // 600+300 >= 1000-170 ⇒ 落在"距底 170px 内"
  tb.onscroll();
  await settle(4);
  eq(brLeaves().length, 2, '§16.9 ★滚到底自动续页(距底 170px 内就取下一发,与记忆浏览同款)');
  ok(/滚动第二条/.test(bodyText()), '§16.9 ★续来的那一条真的画上了');
}

// 本套 harness 只记失败数、不记总数 ⇒ 这里**不自报条数**(写死的数字会随改动静默过期,§15 那行就是这么漂的)。
console.log('    §16 断言点:浏览面 —— 请求侧 / 界面侧 / 措辞侧 / 渐进与分页 / 迟到回画');

// ─────────────── §17 导入面的装载(2026-10-13,D12):往下翻再加载 · 源太大就翻页 ───────────────
// 口径(用户原话):默认 200 条,人往下翻就再加载;这份源的内容单元到 1000 个 ⇒ 切分页,免得缓存撑爆。
// 三条硬判据:① 续页请求带 `offset`,候选**追加**不替换;② **跨页勾的条目在提交时算数**;
//            ③ 空段不出现提交按钮,但装载控制条照给(空的是这一页,不是这份源)。
await section('§17 导入面装载:续页追加 / 跨页勾选作数 / 源太大切分页 / 空段不给提交按钮');
function impBody(rec) {
  try { return typeof rec.body === 'string' ? JSON.parse(rec.body) : (rec.body || {}); } catch { return {}; }
}
const IMP_P1 = impAnalyzeReply({
  candidates: [impCand({ index: 1, locator: '2', title: '第 1 页的条' })],
  stats: { rows: 300, candidates: 1, rejected: 0, model_used: false, model: null, offset: 0, units_total: 300, next_offset: 200 },
});
const IMP_P2 = impAnalyzeReply({
  candidates: [impCand({ index: 1, locator: '202', title: '第 2 页的条' })],
  stats: { rows: 300, candidates: 1, rejected: 0, model_used: false, model: null, offset: 200, units_total: 300, next_offset: null },
});
{
  const routes = impRoutes((rec) => (impBody(rec).offset === 200 ? IMP_P2 : IMP_P1));
  await gotoImport(routes);
  typeInto(field(/源名/), 'big.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1\nB,2');
  clickBtn('① 分析(不写库)');
  await settle(3);
  ok(!!button('继续加载 ▾'), '§17 还有下一页 ⇒ 出现「继续加载 ▾」');
  ok(/300 个内容单元/.test(bodyText()), '§17 如实说这份源共多少内容单元(不写"共 N 条")');
  const n1 = libCalls(IMP_ANALYZE).length;
  clickBtn('继续加载 ▾');
  await settle(3);
  const a2 = libCalls(IMP_ANALYZE);
  eq(a2.length, n1 + 1, '§17 点「继续加载」⇒ 多发一发 analyze');
  eq(impBody(a2[a2.length - 1]).offset, 200, '§17 ★续页请求带 offset=200(不是从头再读一遍)');
  ok(/第 1 页的条/.test(bodyText()) && /第 2 页的条/.test(bodyText()), '§17 ★两页候选**并存**(追加,不是替换)');
  ok(!button('继续加载 ▾'), '§17 取完(next_offset 为 null)⇒ 不再给续页按钮');
  ok(/— 已到最早 —/.test(bodyText()), '§17 收口句是"已经到底",不是"没东西"');
}

{
  // 跨页勾选:第 1 页那条勾着不动,续到第 2 页再提交 ⇒ **两条都要送**(否则翻页会把前面勾的抹掉)
  const routes = impRoutes((rec) => (impBody(rec).offset === 200 ? IMP_P2 : IMP_P1));
  await gotoImport(routes);
  typeInto(field(/源名/), 'big.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1\nB,2');
  clickBtn('① 分析(不写库)');
  await settle(3);
  clickBtn('继续加载 ▾');
  await settle(3);
  eq(impChecks().length, 2, '§17 两页的候选都渲染了(实际 ' + impChecks().length + ' 条)');
  ok(!!button('② 提交入库(2 条)'), '§17 ★计数把两页勾着的一起算(2 条)');
  clickBtn('② 提交入库(2 条)');
  await settle(3);
  const c = libCalls(IMP_COMMIT);
  eq(c.length, 1, '§17 提交只发一发');
  const items = impBody(c[0]).items || [];
  eq(items.length, 2, '§17 ★提交送的是**跨页勾过的**条(实际 ' + items.length + ' 条)');
  eq(items.map((x) => x.locator).sort().join(','), '2,202', '§17 ★第 1 页那条没有被翻页抹掉');
}

{
  // 源太大 ⇒ 分页(不是一路追加)
  const routes = impRoutes(impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '2' })],
    stats: { rows: 2500, candidates: 1, rejected: 0, model_used: false, model: null, offset: 0, units_total: 2500, next_offset: 200 },
  }));
  await gotoImport(routes);
  typeInto(field(/源名/), 'huge.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1');
  clickBtn('① 分析(不写库)');
  await settle(3);
  ok(!!button('下一页 ›'), '§17 ★源有 2500 个单元(> 1000)⇒ 走分页:出现「下一页 ›」');
  ok(!button('继续加载 ▾'), '§17 分页模式**不**给「继续加载 ▾」(那正是"免得缓存撑爆"要做的事)');
  ok(/第 1 \/ 13 页/.test(bodyText()), '§17 页码与总页数如实(2500 / 200 ⇒ 13 页)');
  const before = libCalls(IMP_ANALYZE).length;
  clickBtn('下一页 ›');
  await settle(3);
  const a = libCalls(IMP_ANALYZE);
  eq(a.length, before + 1, '§17 翻页 ⇒ 多发一发 analyze');
  eq(impBody(a[a.length - 1]).offset, 200, '§17 ★翻页请求带 offset=200');
}

{
  // 空页两种情况要分清(这条自己踩过一次):
  //   追加模式里"下一页空"⇒ 视图**不空**(前面那页还在)⇒ 只该有一句"这一页没有候选";
  //   分页模式里"这一页空"⇒ 视图真的空 ⇒ 出空态、不给提交按钮,但页码条照给。
  const empty2 = impAnalyzeReply({
    candidates: [],
    stats: { rows: 300, candidates: 0, rejected: 0, model_used: false, model: null, offset: 200, units_total: 300, next_offset: null },
  });
  const routes = impRoutes((rec) => (impBody(rec).offset === 200 ? empty2 : IMP_P1));
  await gotoImport(routes);
  typeInto(field(/源名/), 'big.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1\nB,2');
  clickBtn('① 分析(不写库)');
  await settle(3);
  clickBtn('继续加载 ▾');
  await settle(3);
  ok(/这一页没有候选/.test(bodyText()), '§17 追加模式下空页如实说明("这一页没有候选",不是"导入成功 0 条")');
  ok(/第 1 页的条/.test(bodyText()), '§17 追加模式下空页**不清掉**已取的那页(视图不空)');
  ok(!!button('② 提交入库(1 条)'), '§17 已取的那条仍可提交(空页不等于清空)');
}

{
  // 分页模式下的空页:视图真空 ⇒ 空态 + 无提交按钮 + 页码条还在
  const page1big = impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '2' })],
    stats: { rows: 2500, candidates: 1, rejected: 0, model_used: false, model: null, offset: 0, units_total: 2500, next_offset: 200 },
  });
  const page2empty = impAnalyzeReply({
    candidates: [],
    stats: { rows: 2500, candidates: 0, rejected: 0, model_used: false, model: null, offset: 200, units_total: 2500, next_offset: 400 },
  });
  const routes = impRoutes((rec) => (impBody(rec).offset === 200 ? page2empty : page1big));
  await gotoImport(routes);
  typeInto(field(/源名/), 'huge.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1');
  clickBtn('① 分析(不写库)');
  await settle(3);
  clickBtn('下一页 ›');
  await settle(3);
  ok(/这一段没有候选/.test(bodyText()), '§17 分页模式下空页 ⇒ 空态如实说明');
  ok(!button('② 提交入库(0 条)'), '§17 ★空段**不出现**提交按钮(没东西可勾就别递按钮)');
  ok(/第 2 \/ 13 页/.test(bodyText()), '§17 但页码条照给 —— 空的是这一页,不是这份源');
}

// ══ 18) 降级回执的界面口径(D11,2026-10-14 放行)══════════════════════════════════════
// 为什么要有这一节:模型段失败从"整发失败"变成了"降级但必须显式标注",而**标注是界面的事** ——
// 服务端说得出 `model_error`,界面要是只当一行灰字(或者干脆不说),那 D11 就等于把"没跑成"藏起来了。
section('§18 降级告警:块不是灰字 · 部分成功也告警 · 重试只重试这一页');
{
  const degraded = impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '2' })],
    stats: {
      rows: 3, candidates: 1, rejected: 0, model_used: false, model: null,
      offset: 0, units_total: 3, next_offset: null,
      model_error: {
        engine: 'assistant:qwen-test',
        message: '本机小助手没给出可用回复(fetch failed)',
        rows_offered: 3,
      },
    },
  });
  await gotoImport(impRoutes(degraded));
  typeInto(field(/源名/), 'probe.csv');
  typeInto(field(/把 CSV/), '代号,名称\nH7,x');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const warns = allEls(panel).filter((e) => String(e.className || '').indexOf('lib-warn') >= 0);
  ok(warns.length === 1, '§18.1 ★降级 ⇒ 有专门的告警块(.lib-warn),不是一行灰字');
  const t18 = bodyText();
  ok(/模型段没跑成/.test(t18) && /fetch failed/.test(t18), '§18.1 ★告警说清是哪一段没跑成 + 原话原因');
  ok(/assistant:qwen-test/.test(t18), '§18.1 写明是哪一档引擎(不许含糊成"模型出错了")');
  ok(/规则段候选照常给/.test(t18), '§18.1 ★降级不等于失败:明说规则段候选照给');
  ok(/本来要送模型 3 行/.test(t18), '§18.1 如实写"本来要送几行"');
  ok(impChecks().length === 1, '§18.1 ★降级时候选清单照常渲染(告警块不吞候选)');
  ok(!/分析被拒/.test(t18), '§18.1 ★降级**不许**说成"分析被拒" —— 那是整发失败的说法');
  ok(!!button('重试这一页(含模型段)'), '§18.1 给一条出路:只重试这一页');
  const n0 = libCalls(IMP_ANALYZE).length;
  clickBtn('重试这一页(含模型段)');
  await settle(3);
  const n1 = libCalls(IMP_ANALYZE).length;
  eq(n1, n0 + 1, '§18.2 ★重试真的重发 analyze(一次,不是两发)');
  eq(impBody(libCalls(IMP_ANALYZE)[n1 - 1]).offset, undefined, '§18.2 第一页重试 ⇒ 不带 offset(与首次同形)');
  eq(impChecks().length, 1, '§18.2 ★第一页重试是**替换**不是追加(候选不翻倍)');
}

{
  // 部分成功:batch 1 成了、batch 2 炸了 ⇒ model_used 仍是 true,**但必须告警**。
  // 这条是这一节的重点:只看 model_used 会把"半份模型结果"读成"模型全跑完了"。
  const partial = impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '2' }), impCand({ index: 2, locator: '3', title: '第三条' })],
    stats: {
      rows: 24, candidates: 2, rejected: 0, model_used: true, model: 'assistant:qwen-test',
      model_rows: 24, model_batches: 3, offset: 0, units_total: 24, next_offset: null,
      model_error: {
        engine: 'assistant:qwen-test',
        message: '第 2 / 3 批没跑成:模型没回 JSON 数组',
        rows_offered: 24, batches_total: 3, batches_ok: 1, batches_failed: [2],
      },
    },
  });
  await gotoImport(impRoutes(partial));
  typeInto(field(/源名/), 'big.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const t = bodyText();
  ok(/⚠ 模型段没跑成/.test(t), '§18.3 ★部分成功(model_used:true + model_error)同样告警');
  ok(/第 2 \/ 3 批炸了/.test(t), '§18.3 告警写明第几批炸了 / 共几批(不写"模型出错了"这种含糊话)');
  ok(/已成功的批结果保留/.test(t), '§18.3 明说已成功的批没被丢掉');
  ok(/模型段:跑了/.test(t), '§18.3 同时照旧如实写"模型段跑了"(两件事都要说,不互相盖)');
  eq(impChecks().length, 2, '§18.3 部分成功时候选照常渲染');
}

{
  // 续页降级 + 重试:重试必须**替换本页**,不许走追加路径(否则点一次多一份重复候选)。
  const p1 = impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '2' })],
    stats: { rows: 300, candidates: 1, rejected: 0, model_used: false, model: null, offset: 0, units_total: 300, next_offset: 200 },
  });
  const p2 = impAnalyzeReply({
    candidates: [impCand({ index: 1, locator: '202', title: '第二页那条' })],
    stats: {
      rows: 300, candidates: 1, rejected: 0, model_used: false, model: null,
      offset: 200, units_total: 300, next_offset: null,
      model_error: {
        engine: 'assistant:qwen-test', message: '第 1 / 1 批没跑成:超时',
        rows_offered: 10, batches_total: 1, batches_ok: 0, batches_failed: [1],
      },
    },
  });
  await gotoImport(impRoutes((rec) => (impBody(rec).offset === 200 ? p2 : p1)));
  typeInto(field(/源名/), 'big.csv');
  typeInto(field(/把 CSV/), '代号,名称\nA,1');
  clickBtn('① 分析(不写库)');
  await settle(3);
  eq(impChecks().length, 1, '§18.4 第一页 1 条');
  clickBtn('继续加载 ▾');
  await settle(3);
  eq(impChecks().length, 2, '§18.4 续页后 2 条');
  ok(!!button('重试这一页(含模型段)'), '§18.4 续页降级同样给重试按钮');
  clickBtn('重试这一页(含模型段)');
  await settle(3);
  eq(impChecks().length, 2, '§18.4 ★续页重试**不追加重复**(替换本页,不是又追加一遍)');
  eq(impBody(libCalls(IMP_ANALYZE).slice(-1)[0]).offset, 200, '§18.4 重试发的还是这一页(offset=200),没回到第一页');
}

// ─────────────── §19 SQLite 通道(2026-10-15,路 A):源在盘上 —— 路径 + 表,不走文本框 ───────────────
// 口径(选项文档 §11.3 / D14 路 A):源库**只读打开**、表必须点名(不许猜)、大表不数总数。
// 客户端侧三条硬判据:
//   ① 切到 sqlite ⇒ 出现路径/表输入,粘贴框**藏起来**(这一路不进文本框);
//   ② payload 带 `path`/`table` 且 `text` 为空 —— "源在盘上"不等于"没有源";
//   ③ `units_total: null`(服务端如实说没数)⇒ 界面必须跟着说"没数",**不许**显示成"共 0 个内容单元"
//      (那会让人以为源是空的),而且**不许**走分页(不知道总数就画不出页码)。
await section('§19 SQLite 通道:路 A 路径接入 · 表必须点名 · 总数没数就如实说');
const IMP_SQL = impAnalyzeReply({
  candidates: [impCand({
    index: 1, locator: 'std#1', title: 'std 第 1 行', source_ref: '源库.db#std#1', evidence: 'name=螺栓',
  })],
  stats: {
    rows: 1, candidates: 1, rejected: 0, model_used: false, model: null,
    offset: 0, units_total: null, next_offset: 200,
    sqlite_table: 'std', sqlite_key: 'pk', sqlite_source: 'D:\\资料\\源库.db|4096|1', sqlite_has_more: true,
  },
});
{
  await gotoImport(impRoutes(IMP_SQL));
  pickSelItem('SQLite 库(选一张表;填路径)');
  await settle(2);
  ok(!!field(/例如 D:/), '§19.1 切到 sqlite ⇒ 出现「库文件路径」输入框');
  ok(!!field(/表名\(必填/), '§19.1 出现表名输入框(必填)');
  const taSql = field(/把 CSV/);
  ok(taSql && taSql.style && taSql.style.display === 'none',
    '§19.1 ★粘贴框藏起来了(这一路不进文本框:文本量由服务端按页取)');
  ok(/只读打开/.test(bodyText()), '§19.1 面板讲明"源库只读打开、拒开自己的库、表必须点名"');
  const n0 = libCalls(IMP_ANALYZE).length;
  typeInto(field(/源名/), '源库.db');
  clickBtn('① 分析(不写库)');
  await settle(2);
  eq(libCalls(IMP_ANALYZE).length, n0, '§19.2 只填源名、没填路径 ⇒ 零请求');
  ok(/要填库文件路径/.test(bodyText()), '§19.2 如实说为什么没发出去(不是"源文本为空")');
  typeInto(field(/例如 D:/), 'D:\\资料\\源库.db');
  clickBtn('① 分析(不写库)');
  await settle(2);
  eq(libCalls(IMP_ANALYZE).length, n0, '§19.3 有路径、没表名 ⇒ 零请求(服务端不替你猜哪张表)');
  ok(/点名一张表/.test(bodyText()), '§19.3 提示要**点名一张表**');
  typeInto(field(/表名\(必填/), 'std');
  clickBtn('① 分析(不写库)');
  await settle(3);
  const aSql = libCalls(IMP_ANALYZE);
  eq(aSql.length, n0 + 1, '§19.4 三项齐 ⇒ 一发 analyze');
  eq(impBody(aSql[aSql.length - 1]).kind, 'sqlite', '§19.4 kind=sqlite');
  eq(impBody(aSql[aSql.length - 1]).path, 'D:\\资料\\源库.db', '§19.4 ★带上 path(源在盘上)');
  eq(impBody(aSql[aSql.length - 1]).table, 'std', '§19.4 ★带上 table(点名的那张)');
  eq(impBody(aSql[aSql.length - 1]).text, '', '§19.4 text 为空 —— 空文本不是"没有源",路径才是源');
  ok(/std 第 1 行/.test(bodyText()), '§19.4 候选照常渲染(规则段读出来的那条)');
  ok(/内容单元数没数/.test(bodyText()), '§19.5 ★units_total=null ⇒ 界面如实说"没数"');
  ok(!/共 0 个内容单元/.test(bodyText()), '§19.5 ★不许显示成"共 0 个内容单元"(那会让人以为源是空的)');
  ok(!!button('继续加载 ▾'), '§19.5 null 走**渐进**:还有下一页就给续页按钮');
  ok(!button('下一页 ›'), '§19.5 ★null 不走分页(不知道总数就画不出页码)');
  clickBtn('继续加载 ▾');
  await settle(3);
  eq(impBody(libCalls(IMP_ANALYZE).slice(-1)[0]).offset, 200,
    '§19.5 续页请求带 offset=200(服务端按 SQL 的 LIMIT/OFFSET 取下一页)');
}
{
  // 换源类型 = 换源 ⇒ 旧候选必须清掉(否则 CSV 的候选会跟着"SQLite 这份源"被提交)
  await gotoImport(impRoutes(IMP_SQL));
  pickSelItem('SQLite 库(选一张表;填路径)');
  await settle(2);
  typeInto(field(/源名/), '源库.db');
  typeInto(field(/例如 D:/), 'D:\\资料\\源库.db');
  typeInto(field(/表名\(必填/), 'std');
  clickBtn('① 分析(不写库)');
  await settle(3);
  ok(/std 第 1 行/.test(bodyText()), '§19.6 ★前置:候选已在界面上');
  const n1 = libCalls(IMP_ANALYZE).length;
  pickSelItem('CSV 表格(第 1 行是表头)');
  await settle(2);
  eq(libCalls(IMP_ANALYZE).length, n1, '§19.6 换类型本身不发请求(只清账,不偷偷重跑)');
  ok(!/std 第 1 行/.test(bodyText()), '§19.6 ★换源类型 ⇒ 旧候选清掉(不跟着新源走)');
  ok(!button('② 提交入库(1 条)'), '§19.6 清过账 ⇒ 没有可提交的东西(要重新分析)');
  ok(!!field(/把 CSV/), '§19.6 回到文本通道 ⇒ 粘贴框重新出现');
}
// ─────────────────────────── §20 结论层页签(B 档,2026-10-15) ───────────────────────────
// 这一面钉四件事:①两个计数**分开报**(退役的不算进"有多少条结论");
// ②行里给出的字段够用(正文/类别/硬度/加固/置顶);③默认不列退役的,点开才列,且状态与按钮同源;
// ④**只读**:面板对 /deep/ 只发 GET,源码里只有一个调用点、不带 method ——
// 落条与作废是"经主人授权"的动作,走工具,面板不提供写入口。
await section('§20 结论层:只读页签(在役/退役分开报 · 行字段 · 默认不列退役 · 只发 GET)');
{
  const A1 = {
    id: 'di:a1', kind: '纪律', text: '凡要写进规格的机制条目,必须附一次源码复核', durability: 'durable',
    hit_count: 7, pinned: 1, conv_id: 'sess-1', src: 'dsh', at: '2026-10-15T00:00:00.000Z',
    superseded_by: '', branch_id: '',
  };
  const A2 = {
    id: 'di:a2', kind: '事实', text: '检索类结论必须回真库实测', durability: 'long',
    hit_count: 3, pinned: 0, conv_id: 'sess-2', src: 'dsh', at: '2026-10-14T00:00:00.000Z',
    superseded_by: '', branch_id: '',
  };
  const B1 = {
    id: 'di:b1', kind: '决定', text: '这条后来被取代了', durability: 'long',
    hit_count: 0, pinned: 0, conv_id: 'sess-3', src: 'dsh', at: '2026-10-01T00:00:00.000Z',
    superseded_by: 'di:c9', branch_id: '',
  };
  const nBefore = calls.filter((c) => pathOf(c).startsWith('/deep/items')).length;
  respond = routed([
    ['/deep/items', { ok: true, items: [A1, A2], shown: 2, all: 408, retired: 3 }],
    ['/library/status', statusPayload()],
  ]);
  openCenter();
  await settle(3);
  await clickTab('结论层');
  await settle(4);
  const t = bodyText();
  ok(t.includes(A1.text) && t.includes(A2.text), '§20 条目正文画上了(两句都能读到)');
  ok(/在役 408 条 · 已退役 3 条/.test(t),
    '§20 ★两个计数分开报(把退役的算进"有多少条结论"会让人以为它们还在参与开场选择)');
  ok(t.includes('纪律') && t.includes('硬度:durable'), '§20 行里有类别与硬度(判"这条能活多久")');
  ok(t.includes('加固 7') && t.includes('置顶'), '§20 行里有加固次数与置顶标记');
  ok(t.includes('di:a1') && /来源 sess-1/.test(t), '§20 行里给 id 与来源(可回原始会话)');
  ok(/列出 2 条\(上限 500\)/.test(t), '§20 ★如实说"列出几条 + 上限"(检索类回执不给总数的老规矩)');
  ok(!t.includes(B1.text) && !/已被取代/.test(t),
    '§20 ★默认**只列在役** —— 退役的不是静默消失,而是要点开才看(按钮上写着"连已退役一起看")');
  ok(/纯读/.test(t) && /面板里不写库/.test(t), '§20 面上写明"纯读"与"不写库"');
  const dc1 = calls.filter((c) => pathOf(c).startsWith('/deep/items')).slice(nBefore);
  eq(dc1.length, 1, '§20 切到这一面只发一发请求');
  eq(dc1[0].method, 'GET', '§20 ★只发 GET');
  eq(qsOf(dc1[0], 'limit'), '500', '§20 上限 500(服务端也夹到 500)');
  eq(qsOf(dc1[0], 'includeSuperseded'), null, '§20 默认不带 includeSuperseded(只要在役的)');
  // 点开"连已退役一起看":请求带上 includeSuperseded=1,退役行标出来,按钮换成反向说法
  respond = routed([
    ['/deep/items', { ok: true, items: [A1, A2, B1], shown: 3, all: 408, retired: 3 }],
    ['/library/status', statusPayload()],
  ]);
  clickBtn('连已退役一起看');
  await settle(4);
  const t2 = bodyText();
  const dc2 = calls.filter((c) => pathOf(c).startsWith('/deep/items')).slice(-1)[0];
  eq(qsOf(dc2, 'includeSuperseded'), '1', '§20 点开退役 ⇒ 请求带 includeSuperseded=1');
  ok(t2.includes(B1.text) && /已被取代/.test(t2),
    '§20 ★退役行画出来了并标明"已被取代"(留痕也是信息,不是静默隐藏)');
  ok(/在役 408 条 · 已退役 3 条/.test(t2), '§20 计数与列表同源于一次回执(不各算各的)');
  ok(!!button('只看在役'), '§20 按钮换成反向说法(状态与按钮同源,不留"点过了但看不出来")');
  // 源码级:这一个面上只有一个调用点,且不带 method(面板不提供写入口)
  eq((src.match(/\/deep\/items/g) || []).length, 1, '§20 ★面板里 /deep/items 只有一个调用点');
  ok(!/\/deep\/items[\s\S]{0,80}method:/.test(src), '§20 ★面板对结论层不发带 method 的请求(只读)');
  // ⚠️ 这条断言原先写的是"整个 client.js 不许出现 /deep/run" —— **写错了**:概览面的深摘按钮
  //   本来就要调 `/deep/run`(那是概览/状态面的事),是合法的另一处。收窄到**这一面**才有意义:
  //   要钉的是"结论层这一面不碰写面",不是"面板从不写深摘要"。
  const iFace = src.indexOf('function renderDeep()');
  const faceSrc = iFace >= 0 ? src.slice(iFace, src.indexOf('        function render() {', iFace)) : '';
  ok(faceSrc.length > 1000, '§20 前置:定位到结论层面本体(' + faceSrc.length + ' B)');
  ok(!/\/deep\/(run|one|run-import)/.test(faceSrc),
    '§20 ★结论层这一面不碰深摘要那三条写面(概览的深摘按钮是另一处,不在这一面)');
}
console.log('    §20 断言点:结论层只读面 —— 计数分开 / 行字段 / 默认不列退役 / 只发 GET / 单一调用点');
console.log('    §21 断言点:结论层迟到回画守卫 —— 在飞旧请求被作废(含失败尾巴)/ 立刻按新筛选重发');

// ─────────────────────────── §21 结论层:迟到回画守卫(F18,2026-10-15) ───────────────────────────
// 缺陷(主会话在 lib/client.js 逐字确证):deepLoad 只有 busy 标志、**没有代次令牌**;切按钮时
//   老请求还在飞,`if (D.busy) return;` 把"按新筛选重发"这一次**挡回**,而按钮文字已经翻转 ⇒
//   老应答回来写的是**旧筛选**的数据、按钮却写着新状态 ⇒ 列表与按钮相反。
// 判据为什么长这样:同文件 :2291 写明"迟到回画守卫"的统一做法(切标签/派发渲染各 +1,异步尾巴
//   回来时代次不一致就整条丢弃),图书馆面有 libSeq、记忆树与导入面也都有 —— 只有这一处漏了。
//   所以要钉的不是"这一面能显示退役条目"(§20 已钉),而是"**在飞的旧请求被作废**"。
// 手法:受控 deferred —— 让第一发(默认"只要在役的")真挂在半空,再点按钮,再放老应答回来。
await section('§21 结论层:迟到回画守卫(作废在飞的旧请求 · 失败尾巴也挡)');
{
  const C1 = {
    id: 'di:c1', kind: '纪律', text: '凡要写进规格的机制条目,必须附一次源码复核', durability: 'durable',
    hit_count: 2, pinned: 0, conv_id: 'sess-9', src: 'dsh', at: '2026-10-15T00:00:00.000Z',
    superseded_by: '', branch_id: '',
  };
  const C2 = {
    id: 'di:c2', kind: '决定', text: '这条只有点开退役才看得见', durability: 'long',
    hit_count: 0, pinned: 0, conv_id: 'sess-9', src: 'dsh', at: '2026-10-01T00:00:00.000Z',
    superseded_by: 'di:cX', branch_id: '',
  };
  const held = defer();   // 第一发(只要在役的)吊在半空 —— 竞态的现场
  const nDeep = () => calls.filter((c) => pathOf(c).startsWith('/deep/items'));
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/deep/items')) {
      // "要退役的"那一发立刻回;默认那一发吊住(老筛选、晚到)
      if (qsOf(rec, 'includeSuperseded') === '1') return { ok: true, items: [C1, C2], shown: 2, all: 408, retired: 1 };
      return held.promise;
    }
    return { ok: true };
  };
  openCenter();
  await settle(2);
  // ⚠️ 基线必须在 openCenter() **之后**取:openCenter 会清空 calls(踩过一次 —— 拿清空前的数当基线
  //    会让差值变成负数,还会把"到底发了几发"的判断带偏)。
  const n0 = nDeep().length;
  await clickTab('结论层');
  await settle(4);
  ok(/正在读结论层…/.test(bodyText()), '§21 前置:第一发请求真的挂在半空(界面在读)');
  eq(nDeep().length - n0, 1, '§21 前置:切到这一面只发了一发请求');
  ok(!!button('刷新'), '§21 前置:刷新按钮在(忙标志只挡重入,不改已画好的按钮)');
  // 点开"连已退役一起看":筛选翻了 ⇒ 在飞的老请求必须作废、并**立刻按新筛选重发**
  clickBtn('连已退役一起看');
  await settle(4);
  const mid = nDeep().slice(n0);
  eq(mid.length, 2, '§21 ★点开退役时**立刻按新筛选重发**(不能因为老请求还在飞就被挡回:那会让列表与按钮相反)');
  eq(qsOf(mid.slice(-1)[0], 'includeSuperseded'), '1', '§21 ★重发的那一发带的是**新**筛选(includeSuperseded=1)');
  const midTxt = bodyText();
  ok(midTxt.includes(C2.text), '§21 ★点开退役后界面立刻换上**新**筛选的结果(不等老请求回来)');
  ok(!!button('只看在役'), '§21 按钮文字随筛选翻过来(与列表同一次渲染)');
  // 老应答现在才回来(带的是旧筛选的在役数据):必须**整条丢弃**
  held.resolve({ ok: true, items: [C1], shown: 1, all: 408, retired: 1 });
  await settle(6);
  const lateTxt = bodyText();
  ok(lateTxt.includes(C2.text), '§21 ★迟到的旧应答被丢弃:列表仍是新筛选的结果(退役那条还在)');
  ok(/列出 2 条/.test(lateTxt), '§21 ★迟到应答没有把列表改回旧回执的条数(旧的是 1 条)');
  ok(!/正在读结论层…/.test(lateTxt), '§21 迟到应答不会把界面重新拉回"读取中"');
  ok(!!button('只看在役'), '§21 迟到应答也没把按钮文字顶回去(状态与视图同源)');
}
{
  // 失败尾巴同样会写状态(D.err)并重绘 ⇒ 也要按代次挡掉:否则"已经作废的那一发"会凭空报一个错
  const D1 = {
    id: 'di:d1', kind: '事实', text: '失败尾巴不许写到新筛选的视图上', durability: 'long',
    hit_count: 0, pinned: 0, conv_id: 'sess-10', src: 'dsh', at: '2026-10-15T00:00:00.000Z',
    superseded_by: '', branch_id: '',
  };
  const D2 = {
    id: 'di:d2', kind: '决定', text: '这条是点开退役之后才看得见的', durability: 'long',
    hit_count: 0, pinned: 0, conv_id: 'sess-10', src: 'dsh', at: '2026-10-02T00:00:00.000Z',
    superseded_by: 'di:dX', branch_id: '',
  };
  const held2 = defer();
  respond = (rec) => {
    const p = pathOf(rec);
    if (p.startsWith('/deep/items')) {
      if (qsOf(rec, 'includeSuperseded') === '1') return { ok: true, items: [D1, D2], shown: 2, all: 408, retired: 1 };
      return held2.promise;
    }
    return { ok: true };
  };
  openCenter();
  await settle(2);
  await clickTab('结论层');
  await settle(3);
  clickBtn('连已退役一起看');
  await settle(4);
  ok(bodyText().includes(D2.text), '§21 前置:新筛选的结果已经在界面上(老请求还在飞)');
  held2.reject(new Error('boom'));
  await settle(6);
  const t2 = bodyText();
  ok(!/网关不可达|网关回了不带 ok/.test(t2),
    '§21 ★迟到的**失败**尾巴也被丢弃(不然会给已经作废的那一发凭空报错,还把新结果顶掉)');
  ok(t2.includes(D2.text), '§21 新筛选的结果没有被迟到的失败顶掉');
}

console.log('    §19 断言点:SQLite 通道 —— 路径与表 / payload 形状 / 总数没数 / 换类型清账');

// ─────────────────────────── §22 D2：手术票重试上限 ───────────────────────────
// 背景(:169-192 + :207):surgeryTicket* 是 IIFE 外层闭包变量,整个页面生命周期共享;
//   取票失败时解锁(surgeryTicketTried=false)并计次(surgeryTicketFailCount++);
//   条件 `!surgeryTicketTried && surgeryTicketFailCount < 2` 把自动取票限在 2 次以内。
//   surgeryTicket* 在 IIFE 作用域 ⇒ 每个子测试用独立 vm 上下文从零起步。
//   /import/history 由「接入历史」标签里的 renderImportLog() 发出(:3947)。
await section('§22 D2：手术票重试上限');
{
  async function mkIso() {
    const ic = [];
    let ir = () => ({ ok: true });
    function ipathOf(rec) { return rec.url.replace('/api/dsh-ling', ''); }
    const iDoc = {
      createElement: (t) => new FakeEl(t),
      createTextNode: (v) => new FakeText(v),
      createStyleSheet: () => ({ cssRules: [] }),
      documentElement: new FakeEl('html'),
      head: new FakeEl('head'),
      body: new FakeEl('body'),
      getElementById(id) {
        const all = allEls(iDoc.head).concat(allEls(iDoc.body));
        return all.find((e) => e.id === id) || null;
      },
      querySelector(sel) { return walk(iDoc.body, sel, true)[0] || null; },
      querySelectorAll(sel) { return walk(iDoc.body, sel, false); },
      addEventListener() {}, removeEventListener() {},
    };
    iDoc.documentElement.setAttribute('data-theme', 'light');
    const iWin = {
      addEventListener() {}, removeEventListener() {},
      innerHeight: 900, innerWidth: 1400,
      confirm() { return true; },
    };
    function iStub(url, opts) {
      const rec = {
        url: String(url),
        method: (opts && opts.method) || 'GET',
        headers: (opts && opts.headers) || {},
      };
      ic.push(rec);
      return Promise.resolve()
        .then(() => ir(rec))
        .then((p) => ({ ok: true, status: 200, json: async () => p }));
    }
    const iOut = await contextify(src, { window: iWin, document: iDoc, fetch: iStub });
    return {
      calls: ic,
      setRespond(fn) { ir = fn; },
      T: iOut && iOut.__test__,
      doc: iDoc,
      pathOf: ipathOf,
      tcCalls() { return ic.filter((c) => ipathOf(c) === '/surgery/ticket'); },
      ihCalls() { return ic.filter((c) => ipathOf(c) === '/import/history'); },
    };
  }
  function openAccess(env) {
    env.T.openMemoryCenter();
    const mp = env.doc.body.querySelector('.ling-mc');
    const tab = allEls(mp)
      .filter((e) => String(e.className).split(/\s+/).includes('ling-tab'))
      .find((e) => e.textContent.trim() === '接入历史');
    if (tab) tab.onclick(mkEvent(tab));
    return mp;
  }
  function refreshBtn(mp) {
    return allEls(mp).find(
      (e) => e.tagName === 'BUTTON' && e.textContent.trim() === '刷新'
    ) || null;
  }

  // ── 子测试 A：成功分支 — 取到票后原样重发一次，重发请求带 x-dsh-ling-surgery ──
  {
    const env = await mkIso();
    let ihHit = 0;
    env.setRespond((rec) => {
      const p = env.pathOf(rec);
      if (p === '/surgery/ticket') return { ok: true, ticket: 'tok-d2' };
      if (p === '/import/history') {
        ihHit++;
        return ihHit === 1 ? { ok: false, surgery: 'surgery-ticket' } : { ok: true, items: [] };
      }
      return { ok: true };
    });
    openAccess(env);
    await settle(12);

    eq(env.tcCalls().length, 1, '§22 A：票据只取一次');
    eq(env.ihCalls().length, 2, '§22 A：/import/history 共调两次（原发+重发）');
    const retried = env.ihCalls().filter((c) => c.headers && c.headers['x-dsh-ling-surgery']);
    eq(retried.length, 1, '§22 A：重发那一次带 x-dsh-ling-surgery 头');
    ok(retried[0] && retried[0].headers['x-dsh-ling-surgery'] === 'tok-d2',
      '§22 A：头里的票据值与取到的一致');
  }

  // ── 子测试 B：失败分支 — 最多取 2 次票，第 3 次不再触发 ──
  // 反证:去掉 :207 的 `&& surgeryTicketFailCount < 2` 后,第 3 次也会取票 ⇒ tcCalls().length === 3 ⇒ eq 变红。
  {
    const env2 = await mkIso();
    env2.setRespond((rec) => {
      const p = env2.pathOf(rec);
      if (p === '/surgery/ticket') return { ok: false };
      if (p === '/import/history') return { ok: false, surgery: 'surgery-ticket' };
      return { ok: true };
    });
    const mp2 = openAccess(env2);
    await settle(12);   // 自动那发 → 取票失败 → failCount=1

    const rb = refreshBtn(mp2);
    if (rb && typeof rb.onclick === 'function') rb.onclick(mkEvent(rb));
    await settle(12);   // 第 2 次 → failCount=2

    if (rb && typeof rb.onclick === 'function') rb.onclick(mkEvent(rb));
    await settle(12);   // 第 3 次 → failCount<2 为 false → 不取票

    eq(env2.tcCalls().length, 2, '§22 B：取票次数 === 2（上限，第 3 次手术请求不再触发）');
    ok(env2.ihCalls().length >= 3, '§22 B：/import/history 确实发了 ≥3 次（只是不再触发取票）');
  }
}

// ─────────────────────────── §23 F-06：导入日志迟到响应守卫 ───────────────────────────
// 背景(:3927-3945):importLogSeq 是 renderAccess() 内的局部变量,每次切到「接入历史」都从 0 起步;
//   renderImportLog() 每次调用 ++importLogSeq 得 token,回调里 token !== importLogSeq 即丢弃。
//   /import/history 由「接入历史」标签里的 renderImportLog() 发出(:3947)。
// 反证:删除 :3931 或 :3942 的 token 守卫后,迟到应答会写进新视图 ⇒ 断言变红。
await section('§23 F-06：导入日志迟到响应守卫');
{
  // ── 子测试 A：旧应答后到 → 被丢弃，最终显示后发那次的数据 ──
  {
    const held1 = defer();
    let ihCount1 = 0;
    respond = (rec) => {
      const p = pathOf(rec);
      if (p === '/import/history') {
        ihCount1++;
        if (ihCount1 === 1) return held1.promise;   // 第一发(自动):挂在半空
        return { ok: true, items: [{ line: 'F06新数据' }] };
      }
      return { ok: true };
    };
    openCenter();
    await settle(2);
    await clickTab('接入历史');
    await settle(6);

    // 找 import-log 的「刷新」按钮,点一次 → 第二发立刻拿到新数据(token=2)
    const rb = allEls(panel).find(
      (e) => e.tagName === 'BUTTON' && e.textContent.trim() === '刷新'
    );
    if (rb && typeof rb.onclick === 'function') rb.onclick(mkEvent(rb));
    await settle(8);
    ok(bodyText().includes('F06新数据'), '§23 A 前置：后发（新）那次数据已渲染');

    // 放旧应答回来:token=1 !== importLogSeq=2 → 守卫拦截
    held1.resolve({ ok: true, items: [{ line: 'F06旧数据' }] });
    await settle(8);
    ok(!bodyText().includes('F06旧数据'), '§23 A ★迟到的旧应答被丢弃（旧数据没有写进新视图）');
    ok(bodyText().includes('F06新数据'), '§23 A ★迟到旧应答后新数据仍然在界面上');
  }

  // ── 子测试 B：旧请求失败的 catch 不写新视图 ──
  {
    const held2 = defer();
    let ihCount2 = 0;
    respond = (rec) => {
      const p = pathOf(rec);
      if (p === '/import/history') {
        ihCount2++;
        if (ihCount2 === 1) return held2.promise;   // 第一发(自动):挂在半空,稍后 reject
        return { ok: true, items: [{ line: 'F06B新数据' }] };
      }
      return { ok: true };
    };
    openCenter();
    await settle(2);
    await clickTab('接入历史');
    await settle(6);

    const rb2 = allEls(panel).find(
      (e) => e.tagName === 'BUTTON' && e.textContent.trim() === '刷新'
    );
    if (rb2 && typeof rb2.onclick === 'function') rb2.onclick(mkEvent(rb2));
    await settle(8);
    ok(bodyText().includes('F06B新数据'), '§23 B 前置：新数据已渲染（token=2）');

    // 让旧请求以错误结束:token=1 ≠ importLogSeq=2 → catch 守卫拦截
    held2.reject(new Error('网络错误'));
    await settle(8);
    ok(!/记录加载失败/.test(bodyText()), '§23 B ★旧请求失败的 catch 被守卫挡住（不写新视图）');
    ok(bodyText().includes('F06B新数据'), '§23 B ★旧请求失败后新数据仍然在界面上');
  }
}

summary();
