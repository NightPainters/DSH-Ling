// tests/effort-ui.test.mjs — rc.4 · M22-8:推理档位滑块 + 后台模型两键的**执行级**测试
//
// 派单口径(RC4-RUNBOOK-v7.md M22-8,转引 ui.md:501-513):
//   · 假 DOM 执行级:只读**真实** `lib/client.js`,用迷你 DOM + 桩 `fetch` 调
//     `__test__.openMemoryCenter()`,走的是真人"打开面板 → 拖动 / 点按钮"**同一条**代码路径;
//     断言的是屏幕上的东西(节点属性 / 文案)与发出去的请求(方法 + body + 次数),不是源码字符串。
//   · 桩网络:`routed([...])` 里显式加上 `'/mode/effort'`、`'/model/background'` 两个**新前缀**;
//     其余路径(/state /memories /suggestions /feedback /deep/status /auto)照旧回放。
//   · **不在测试里复制生产实现**:四档值表 / 标签表 / 展示序 / 两个换算函数一律从
//     `exports.__test__` 读**真表**(M22-2 已挂在钩子上),测试里不另写一份顺序
//     —— 两份表迟早漂移,而漂移正是被测对象。
//     ⚠️ m22b-fix(MF-4)补正:只"从实现读回来自比"是恒真断言(MUT-C6a 全绿)。本文件另钉一份
//     **契约字面量**(`LIT_*`,出处 ALIGN-v2 §C.2 表 / `ui.md:337-342`),夹具与主断言都按这份
//     字面量走 ⇒ 实现换顺序 / 换词,断言必红。
//   · 本文件覆盖的三条验收:
//       C.6-6  第 1 次 POST **不带** `confirmEffort`(服务端只预览)⇒ 确认后第 2 次**带** `true`;
//              取消 ⇒ 只有那 1 次预览、**0 写**(没有任何带 `confirmEffort:true` 的请求)。
//       C.6-7  回执缺字段 / 取值不在四档内 / 展示序不一致 / 请求失败 ⇒ 控件 disabled + 如实说"读不到",
//              **不显示猜测值**(不写 `aria-valuetext`、不高亮任何刻度)。
//       C.6-9  连续两次保存成功后第三次失败 ⇒ 滑块/刻度/`aria-valuetext` 回**最近一次成功**的值
//              (第二次的值),不是打开面板时的值(旧 `paint(eff)` 缺陷的形状)。
//
// 证据边界(如实说明,不夸大,与 library-client.test.mjs:10-15 同一口径):
//   · **真浏览器没跑过**:这里是"够用"的假 DOM —— appendChild / textContent / classList /
//     属性 / onclick·oninput·onchange 按浏览器语义实现,但**不做 CSS 布局、不做事件冒泡**
//     ⇒ "拖动" = 直接写 `value` 再调节点上的 `oninput`/`onchange`(等同真实手势抵达处理器那一步)。
//   · 环境变量 `LING_CLIENT` 可指向 `lib/client.js` 的**副本**(变异实验用);不设则读真实源码。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok, eq, section, summary } from './harness.mjs';
import { contextify } from './vm-light.mjs';

const CLIENT_PATH = process.env.LING_CLIENT
  ? path.resolve(process.env.LING_CLIENT)
  : fileURLToPath(new URL('../lib/client.js', import.meta.url));
const src = readFileSync(CLIENT_PATH, 'utf8');

// ─────────────────────────── 迷你 DOM(浏览器语义的子集;测试基础设施,非生产逻辑) ───────────────────────────
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
  // 探针:client.js 一旦用 innerHTML 插入内容就记账(本文件不消费它,留着防"悄悄改成拼 HTML")
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

// ─────────────────────────── 桩网络(记录每一次请求 + 受控回放) ───────────────────────────
const calls = [];
// 真 reject 过的请求(路径 + 方法):m22b-fix MF-1 的命中计数来源(桩侧自证,不靠推断)。
const rejects = [];
let respond = () => ({ ok: true });
const windowObj = {
  addEventListener() {}, removeEventListener() {},
  innerHeight: 900, innerWidth: 1400,
  confirm() { return false; },
};
function pathOf(rec) { return rec.url.replace('/api/dsh-ling', ''); }
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
    .then((payload) => {
      // ★m22b-fix MF-1:夹具回放 `Error` ⇒ `fetch` **真 reject**(网关不可达),不再把 Error
      // 当 200 回执的 body 回放 —— 后者会让客户端 5 个 `.catch` 分支一条都到不了,
      // 而报告却写成"请求 reject",等于把未覆盖的分支记成已覆盖。
      if (payload instanceof Error) throw payload;
      return { ok: true, status: 200, json: async () => payload };
    })
    // 路由函数自己 `throw`(见 §4b⑤)也走这里:Promise 链把 throw 变成 rejection。
    // 真 reject 的路径 + 方法记一笔 —— MF-1 的命中计数由桩侧自证,不靠推断。
    .catch((err) => {
      rejects.push({ path: pathOf(rec), method: rec.method });
      throw err;
    });
}
/**
 * 前缀路由(与 library-client.test.mjs:200-208 同一套语义)。
 * ⚠️ 本文件所有夹具都在这里显式登记 `'/mode/effort'`、`'/model/background'` 两个**新前缀**
 *    —— 这是派单要求的那一步;没登记就会落到兜底 `{ok:true}` 上,而"读不到"分支会把
 *    控件禁用,断言立刻红(假绿无处可藏)。
 */
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

// ─────────────────────────── §0 钩子与真表 ───────────────────────────
await section('§0 测试钩子 / 四档真表(否则下面每条都无意义)');
ok(!!T, 'exports.__test__ 存在');
ok(!!T && typeof T.openMemoryCenter === 'function', '取到真实 openMemoryCenter(面板的执行入口)');
// 真表从钩子读(用于"实现自洽"旁证;字面量见下面的 LIT_*)
const V = (T && Array.isArray(T.EFFORT_VALUES)) ? T.EFFORT_VALUES.slice() : [];
const L = (T && T.EFFORT_LABELS) ? T.EFFORT_LABELS : {};
const TICKS = (T && Array.isArray(T.EFFORT_TICKS)) ? T.EFFORT_TICKS.slice() : [];
// ★m22b-fix MF-4:契约字面量 —— **不从 `__test__` 取**,逐字照 ALIGN-v2 §C.2 表 / `ui.md:337-342`
//   (与 `m22-2/selfcheck.mjs:20-22` 同一份口径)。夹具与主断言都按这里走 ⇒
//   把 `EFFORT_VALUES` 换成 `['max','high','low','off']`(MUT-C6a)时必有断言红。
const LIT_VALUES = ['off', 'low', 'high', 'max'];
const LIT_LABELS = { off: '省电', low: '均衡', high: '深入', max: '极致' };
const LIT_TICKS = ['省电', '均衡', '深入', '极致'];
eq(V.length, 4, '§0 钩子给出的四档值表长度 = 4');
// ★字面量断言(不依赖 `__test__`):期望值是上面写死的契约,不是"读回来再和自己比"
eq(V.join(','), 'off,low,high,max', '§0 ★字面量:值表逐字 = off,low,high,max(MUT-C6a 会红)');
eq(LIT_VALUES.map((v) => L[v]).join('|'), '省电|均衡|深入|极致',
  '§0 ★字面量:标签表按值表取词 = 省电|均衡|深入|极致(逐字)');
eq(V.join('|'), LIT_VALUES.join('|'), '§0 值表与契约字面量逐条同序');
ok(TICKS.join('|') === '省电|均衡|深入|极致', '§0 ★字面量:展示序 = 省电|均衡|深入|极致(逐字;不读实现自比)');
ok(!!T && T.effortIndexOf('high') === 2 && T.effortLabelOf(2) === '深入',
  '§0 换算函数按契约钉死:index 2 ⇔ high ⇔ 深入(期望不读实现反推)');
ok(!!T && T.effortIndexOf('banana') === -1 && T.effortLabelOf(-1) === '',
  '§0 换算函数对非法输入给 -1 / 空串(不兜底成某个档)');
if (!T || typeof T.openMemoryCenter !== 'function' || V.length !== 4) {
  console.error('  ✗ 测试钩子/真表不可用:后续断言无意义,立即停');
  summary();
  process.exit(1);
}

// ─────────────────────────── 夹具与操作原语 ───────────────────────────
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 6); i++) await tick(); }
let panel = null;

/** GET /mode/effort 的正常回执(字段照 m22-0/contract.md §1 的 B4 形状)。
 *  ★m22b-fix MF-4:值用**契约字面量**(LIT_*),不再 `V[2]` 现取 —— 后者让夹具跟着实现漂移,
 *  实现一换顺序(MUT-C6a)夹具就跟着换,断言抓不住。 */
function effortGet(over) {
  return Object.assign({
    ok: true,
    mode: 'life',
    effort: 'high',
    efforts: LIT_VALUES.slice(),
    labels: Object.assign({}, LIT_LABELS),
    mapping: { work: 'max', life: 'high' },
    source: { work: 'settings', life: 'settings' },
  }, over || {});
}
/** 第 1 次 POST 的回执:服务端**只预览、0 写**(D-1 轻确认)。 */
function previewReply(fromIdx, toIdx) {
  return {
    ok: false, reason: 'confirmation-required', applied: 'none', mode: 'life',
    effort: { from: LIT_VALUES[fromIdx], to: LIT_VALUES[toIdx] },
    message: '这会改「生活模式」用的推理档位:' + LIT_VALUES[fromIdx] + ' → ' + LIT_VALUES[toIdx] + '(下次切换模式 / 新会话时生效)。',
  };
}
/** 第 2 次 POST(带 confirmEffort:true)的成功回执:`effective` 才是服务端真的写成什么。 */
function savedReply(idx, fromIdx) {
  return {
    ok: true, applied: 'saved', mode: 'life',
    effort: LIT_VALUES[idx], effective: LIT_VALUES[idx], from: LIT_VALUES[fromIdx], to: LIT_VALUES[idx],
    efforts: LIT_VALUES.slice(), labels: Object.assign({}, LIT_LABELS),
    mapping: { work: 'max', life: LIT_VALUES[idx] },
    source: { work: 'settings', life: 'settings' },
  };
}
/** GET /model/background 的正常回执(照 backgroundView 形状)。 */
function bgGet(over) {
  return Object.assign({
    ok: true,
    configured: { provider: '', model: '' },
    effective: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    source: 'fallback', followed: true, lastError: null,
  }, over || {});
}
/** 概览渲染要的那六路 + 本单新增的两路前缀。patch 按前缀覆盖(位置不变,前缀顺序稳定)。 */
function baseRoutes(patch) {
  const m = new Map([
    ['/state', { ok: true, persona: {}, lastMode: 'life' }],
    ['/suggestions', { ok: true, stats: { new: 0 } }],
    ['/feedback', { ok: true, stats: { new: 0 } }],
    ['/deep/status', { ok: true, done: 0 }],
    // /auto 的回执要带 effective 五键(否则 autoZone 认为"读不到生效值"直接早退,后台模型卡根本不建:
    // 那是 client.js 里既有的 early-return,不是本单的东西 —— 夹具照真 handler 的形状给全)。
    ['/auto', {
      ok: true,
      effective: {
        deepSummary: true, deepIntervalMin: 30, deepMaxPerRun: 2, bootProbeDelayMs: 12000, feedbackAuto: true,
        source: { deepSummary: 'default', deepIntervalMin: 'default', deepMaxPerRun: 'default', bootProbeDelayMs: 'config', feedbackAuto: 'default' },
      },
      stored: {}, pluginConfig: {},
    }],
    ['/memories', { ok: true, total: 0, items: [] }],
    ['/mode/effort', effortGet()],
    ['/model/background', bgGet()],
  ]);
  for (const k of Object.keys(patch || {})) m.set(k, patch[k]);
  return Array.from(m);
}
/** 依次吐出预置回执(用完之后一直吐最后一个);Error ⇒ 抛出,模拟网关不可达。 */
function oneShot(replies) {
  let i = 0;
  return () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
}
/** `/mode/effort` 一路:GET 读初始值,POST 按脚本逐次回放(预览 / 落笔 / 失败)。 */
function effortRoute(postReplies, getPayload) {
  const next = oneShot(postReplies || []);
  return (rec) => {
    if (rec.method === 'POST') return (postReplies && postReplies.length) ? next() : { ok: true };
    return getPayload === undefined ? effortGet() : getPayload;
  };
}
async function openOverview(routes, n) {
  doc.body.textContent = '';
  calls.length = 0;
  rejects.length = 0;
  innerHTMLWrites = [];
  respond = routed(routes || baseRoutes());
  T.openMemoryCenter();
  panel = doc.body.querySelector('.ling-mc');
  if (!panel) throw new Error('面板没有挂到 document.body');
  await settle(n || 14);
  return panel;
}
const clsOf = (n) => String((n && n.className) || '').split(/\s+/).filter(Boolean);
function effortCard() { return panel.querySelector('.effort-card'); }
function inCard() { const c = effortCard(); return c ? allEls(c) : []; }
function effortRange() { const c = effortCard(); return c ? c.querySelector('.effort-range') : null; }
function ticks() { return inCard().filter((e) => clsOf(e).includes('effort-tick')); }
function tickOn() { return ticks().findIndex((e) => clsOf(e).includes('on')); }
function btnOf(k) { return inCard().find((e) => e.tagName === 'BUTTON' && clsOf(e).includes(k)) || null; }
function saveBtn() { return btnOf('effort-save'); }
function cancelBtn() { return btnOf('effort-cancel'); }
function statusEl() { const c = effortCard(); return c ? c.querySelector('.effort-status') : null; }
function statusText() { return statusEl() ? statusEl().textContent : ''; }
function ariaValueText() { const r = effortRange(); return r ? r.getAttribute('aria-valuetext') : null; }
function bgProvInput() { return allEls(panel).find((e) => e.getAttribute('aria-label') === '后台模型的 provider') || null; }
function bgModelInput() { return allEls(panel).find((e) => e.getAttribute('aria-label') === '后台模型的 model') || null; }
function bgSaveBtn() {
  const p = bgProvInput();
  return p ? (allEls(panel).find((e) => e.tagName === 'BUTTON' && e.parentNode === p.parentNode) || null) : null;
}
function bgStatusEl() {
  // 本卡自己的状态行:aria-live=polite 且 class 含 m-meta(滑块那张卡的状态行是 .effort-status,不会混)
  return allEls(panel).find((e) => e.getAttribute('aria-live') === 'polite' && clsOf(e).includes('m-meta')) || null;
}
function bgStatusText() { return bgStatusEl() ? bgStatusEl().textContent : ''; }
function clickNode(n) { if (n && typeof n.onclick === 'function') n.onclick(mkEvent(n)); }
function effortPosts() { return calls.filter((c) => c.method === 'POST' && pathOf(c).split('?')[0] === '/mode/effort'); }
function bgPosts() { return calls.filter((c) => c.method === 'POST' && pathOf(c).split('?')[0] === '/model/background'); }
function togglePosts() { return calls.filter((c) => c.method === 'POST' && pathOf(c).split('?')[0] === '/mode/toggle'); }
function confirmWrites() {
  return effortPosts().filter((c) => c.body && c.body.confirmEffort === true);
}
/** 拖动:只写 value(浏览器里由指针操作完成),再送 oninput —— 松手前不发请求。 */
function dragTo(idx) {
  const r = effortRange();
  r.value = String(idx);
  if (typeof r.oninput === 'function') r.oninput(mkEvent(r));
}
/** 松手:onchange 才发起请求(与真人 release 同一条路)。 */
async function releaseSlider() {
  const r = effortRange();
  if (typeof r.onchange === 'function') r.onchange(mkEvent(r));
  await settle(8);
}
async function slideTo(idx) { dragTo(idx); await releaseSlider(); }

// ─────────────────────────── §1 卡片落在概览、初值只认服务端 ───────────────────────────
await section('§1 推理档位卡:落在概览、四刻度来自真表、初值只认 GET 回执');
{
  await openOverview(baseRoutes());
  ok(!!effortCard(), '§1 概览里有 .effort-card');
  const r = effortRange();
  ok(!!r && r.tagName === 'INPUT' && r.type === 'range', '§1 原生滑块(<input type="range">)');
  eq(r && r.min, '0', '§1 滑块 min = 0');
  eq(r && r.max, '3', '§1 滑块 max = 3');
  eq(r && r.step, '1', '§1 滑块 step = 1');
  eq(ticks().map((t) => t.textContent).join('|'), '省电|均衡|深入|极致',
    '§1 ★字面量(DOM,不经 __test__):四个刻度逐字 = 省电|均衡|深入|极致');
  eq(ticks().map((t) => t.textContent).join('|'), LIT_TICKS.join('|'), '§1 四个刻度与契约展示序同序');
  eq(r && r.value, '2', '§1 回执 effort=high ⇒ 滑块落在 index 2');
  eq(ariaValueText(), '深入', '§1 ★字面量:aria-valuetext = 深入(不放原始值 high)');
  eq(tickOn(), 2, '§1 高亮刻度 = index 2');
  eq(r && r.disabled, false, '§1 读到值后滑块可用');
  eq(saveBtn() && saveBtn().disabled, false, '§1 读到值后保存可用');
  eq(cancelBtn() && cancelBtn().disabled, true, '§1 没有待办时「取消」不可用(不制造假动作)');
  ok(/当前为/.test(statusText()), '§1 状态行报出当前档位');
  eq(effortPosts().length, 0, '§1 只读页面:0 个 POST');
  ok(calls.every((c) => c.url.startsWith('/api/dsh-ling')), '§1 所有请求都落在本插件前缀上');
}

// ─────────────────────────── §2 C.6-6:第 1 次预览 / 确认后第 2 次落笔 ───────────────────────────
await section('§2 C.6-6 第 1 次不带 confirmEffort、确认后第 2 次带 true');
{
  await openOverview(baseRoutes({ '/mode/effort': effortRoute([previewReply(2, 1), savedReply(1, 2)]) }));
  eq(effortPosts().length, 0, '§2 前置:打开概览只发 GET');

  dragTo(1);
  await settle(2);
  eq(effortPosts().length, 0, '§2 拖动途中(oninput)一个请求都不发(松手才发)');
  eq(ariaValueText(), '均衡', '§2 拖动时标签跟着走(仍是人类语言:均衡)');

  await releaseSlider();
  const p1 = effortPosts();
  eq(p1.length, 1, '§2 松手后第 1 次 POST:有且只有一发');
  eq(p1[0] && p1[0].body && p1[0].body.mode, 'life', '§2 第 1 次 POST 带上回执里的 mode(不自己猜)');
  eq(p1[0] && p1[0].body && p1[0].body.effort, 'low', '§2 第 1 次 POST 的 effort = 主人选的那一档(index 1 = low)');
  ok(p1[0] && p1[0].body && !Object.prototype.hasOwnProperty.call(p1[0].body, 'confirmEffort'),
    '§2 ★第 1 次 POST **不带** confirmEffort 键(服务端只预览、0 写)');
  eq(p1[0] && p1[0].body && p1[0].body.confirmEffort, undefined, '§2 第 1 次的 confirmEffort 是 undefined');
  ok(/再点一次/.test(statusText()) && statusText().includes('「均衡」'),
    '§2 状态行念出后果:目标档位「均衡」+ "再点一次确认"(C.6-6 的"念后果"那一步)');
  eq(saveBtn() && saveBtn().textContent, '确认保存', '§2 同一个按钮此刻承担"确认":文案变了(否则主人以为还是预览)');
  eq(cancelBtn() && cancelBtn().disabled, false, '§2 有待确认的档位 ⇒ 「取消」可用');
  eq(effortPosts().length, 1, '§2 预览之后没有偷偷再发一发');

  clickNode(saveBtn());   // 第 2 次:确认
  await settle(8);
  const p2 = effortPosts();
  eq(p2.length, 2, '§2 确认后第 2 次 POST');
  eq(p2[1] && p2[1].body && p2[1].body.confirmEffort, true, '§2 ★第 2 次 POST 带 confirmEffort:true(这才落笔)');
  eq(p2[1] && p2[1].body && p2[1].body.effort, 'low', '§2 第 2 次 POST 的 effort 仍是主人选的那一档(low)');
  eq(p2[1] && p2[1].body && p2[1].body.mode, 'life', '§2 第 2 次 POST 的 mode 与第 1 次一致(没被改写)');
  eq(effortRange() && effortRange().value, '1', '§2 成功后滑块 = 服务端生效值(index 1)');
  eq(ariaValueText(), '均衡', '§2 成功后 aria-valuetext 跟到 均衡');
  eq(tickOn(), 1, '§2 成功后高亮刻度跟到 index 1');
  ok(/已保存/.test(statusText()) && statusText().includes('均衡'), '§2 状态行说"已保存"并报出人类标签(均衡)');
  eq(saveBtn() && saveBtn().textContent, '保存', '§2 落笔后按钮文案回到「保存」');
  eq(confirmWrites().length, 1, '§2 落笔请求恰好一发(单飞,没有重发)');
  eq(togglePosts().length, 0, '§2 全程不碰 /mode/toggle(桩计数器 = 0)');
  ok(calls.every((c) => c.url.startsWith('/api/dsh-ling')), '§2 所有请求都落在本插件前缀上');
}

// ─────────────────────────── §3 C.6-6 取消:只有那 1 次预览、0 写 ───────────────────────────
await section('§3 C.6-6 取消 ⇒ 只发 1 次 POST、0 写');
{
  await openOverview(baseRoutes({ '/mode/effort': effortRoute([previewReply(2, 0)]) }));
  dragTo(0);
  await releaseSlider();
  eq(effortPosts().length, 1, '§3 前置:第 1 次预览已发出');
  ok(/再点一次/.test(statusText()), '§3 前置:后果已念出,等主人表态');

  clickNode(cancelBtn());
  await settle(8);
  eq(effortPosts().length, 1, '§3 ★取消后**仍然只有那 1 次**预览 POST(不再发第二发)');
  eq(confirmWrites().length, 0, '§3 ★取消 ⇒ 盘上 0 写:没有任何带 confirmEffort:true 的 POST');
  eq(effortRange() && effortRange().value, '2', '§3 滑块回到最近一次服务端确认过的值(index 2)');
  eq(ariaValueText(), '深入', '§3 aria-valuetext 一起回到 深入');
  eq(tickOn(), 2, '§3 刻度高亮回到 index 2');
  eq(saveBtn() && saveBtn().textContent, '保存', '§3 取消后按钮文案回到「保存」(确认态已作废)');
  ok(/已取消/.test(statusText()), '§3 状态行如实说"已取消"');
  eq(togglePosts().length, 0, '§3 取消路径也不碰 /mode/toggle');
}

// ─────────────────────────── §4 C.6-7 缺字段 / 失败:控件禁用、不猜值 ───────────────────────────
await section('§4 C.6-7 回执缺字段 / 值非法 / 展示序不一致 / 请求失败 ⇒ 禁用 + 不猜值');
{
  const cases = [
    { name: '缺 effort 字段', get: { ok: true, mode: 'life' } },
    { name: 'effort 不在四档内', get: { ok: true, mode: 'life', effort: 'banana', efforts: LIT_VALUES.slice() } },
    { name: 'mode 不认识', get: { ok: true, mode: 'other', effort: 'high', efforts: LIT_VALUES.slice() } },
    { name: 'efforts 展示序与四档不一致', get: { ok: true, mode: 'life', effort: 'high', efforts: LIT_VALUES.slice().reverse() } },
    { name: '网关不可达', get: new Error('gateway down') },
  ];
  for (const c of cases) {
    await openOverview(baseRoutes({ '/mode/effort': effortRoute([], c.get) }));
    ok(!!effortCard(), '§4[' + c.name + '] 卡片仍画出来了(读不到不等于整页空)');
    eq(effortRange() && effortRange().disabled, true, '§4[' + c.name + '] 滑块 disabled');
    eq(saveBtn() && saveBtn().disabled, true, '§4[' + c.name + '] 保存 disabled');
    eq(cancelBtn() && cancelBtn().disabled, true, '§4[' + c.name + '] 取消 disabled');
    ok(/读不到/.test(statusText()), '§4[' + c.name + '] 状态行如实说"读不到"');
    ok(/不显示猜测值/.test(statusText()), '§4[' + c.name + '] 明说不显示猜测值');
    eq(ariaValueText(), null, '§4[' + c.name + '] ★没有 aria-valuetext(不拿本地值冒充服务端读数)');
    eq(tickOn(), -1, '§4[' + c.name + '] ★没有任何刻度被高亮(不显示猜测档位)');
    eq(effortPosts().length, 0, '§4[' + c.name + '] 读不到就不许保存:0 个 POST');
  }

  // 后台模型两键:缺 configured / 请求失败 ⇒ 两格留空 + 保存禁用 + 如实说读不到
  const bgCases = [
    { name: '缺 configured 字段', get: { ok: true, effective: { provider: 'deepseek-official', model: 'v' }, source: 'fallback' } },
    { name: '网关不可达', get: new Error('gateway down') },
  ];
  for (const c of bgCases) {
    await openOverview(baseRoutes({ '/model/background': c.get }));
    const p = bgProvInput(); const m = bgModelInput();
    ok(!!p && !!m, '§4[后台模型·' + c.name + '] 两个输入框都在');
    eq(p && p.value, '', '§4[后台模型·' + c.name + '] provider 格留空(不拿 effective 反推)');
    eq(m && m.value, '', '§4[后台模型·' + c.name + '] model 格留空(不拿 effective 反推)');
    eq(bgSaveBtn() && bgSaveBtn().disabled, true, '§4[后台模型·' + c.name + '] 保存 disabled');
    // ★m22b-fix MF-5:两格在"读不到 / 失败"时也 disabled(与滑块卡同一口径,不只是"保存禁用")
    eq(p && p.disabled, true, '§4[后台模型·' + c.name + '] provider 格 disabled(控件禁用,不只是保存)');
    eq(m && m.disabled, true, '§4[后台模型·' + c.name + '] model 格 disabled');
    ok(/读不到/.test(bgStatusText()), '§4[后台模型·' + c.name + '] 状态行如实说"读不到"');
    ok(/不显示猜测值/.test(bgStatusText()), '§4[后台模型·' + c.name + '] 明说不显示猜测值');
    clickNode(bgSaveBtn());
    await settle(2);
    eq(bgPosts().length, 0, '§4[后台模型·' + c.name + '] 读不到就不许写盘:0 个 POST');
  }

  // 正控:读得到 ⇒ 控件可用、只显示 `configured`(主人真写过的),不拿 effective 反推
  await openOverview(baseRoutes({
    '/model/background': bgGet({
      configured: { provider: 'my-prov', model: 'my-model' },
      effective: { provider: 'other-prov', model: 'other-model' },
      source: 'settings', followed: false,
    }),
  }));
  eq(bgProvInput() && bgProvInput().value, 'my-prov', '§4[后台模型·正控] provider 格 = 回执的 configured(不是 effective)');
  eq(bgModelInput() && bgModelInput().value, 'my-model', '§4[后台模型·正控] model 格 = 回执的 configured(不是 effective)');
  eq(bgSaveBtn() && bgSaveBtn().disabled, false, '§4[后台模型·正控] 读得到 ⇒ 保存可用(证明上面的 disabled 不是恒禁用)');
  eq(bgProvInput() && bgProvInput().disabled, false, '§4[后台模型·正控] 读得到 ⇒ provider 格恢复可编辑(MF-5 的"成功恢复")');
  eq(bgModelInput() && bgModelInput().disabled, false, '§4[后台模型·正控] 读得到 ⇒ model 格恢复可编辑');
  ok(/当前生效/.test(bgStatusText()), '§4[后台模型·正控] 状态行报出当前生效值');
}

// ─────────────────────────── §4b m22b-fix MF-1:真 reject ⇒ 五个失败分支各命中 ───────────────────────────
await section('§4b 请求真 reject(网关不可达)⇒ client.js 五个 .catch 分支各命中至少一次');
// 判据:五个失败分支(行号 = 本单修完后的盘上位置)
//   :2982 预览 POST 的 .catch · :3000 落笔 POST 的 .catch
//   :3046 GET /mode/effort 的 .catch · :3633 POST /model/background 的 .catch
//   :3664 GET /model/background 的 .catch
// 夹具口径:回放 `Error`(或路由函数 throw)⇒ fetchStub **reject**;`rejects[]` 记路径+方法。
{
  const seen = [];
  const collect = () => { for (const r of rejects) seen.push(r); };

  // ① GET /mode/effort reject ⇒ client.js:3046
  await openOverview(baseRoutes({ '/mode/effort': effortRoute([], new Error('gateway down')) }));
  collect();
  eq(rejects.length, 1, '§4b① GET /mode/effort 真 reject 了 1 次(不是当 200 body 回放)');
  eq(rejects[0] && rejects[0].method, 'GET', '§4b① reject 的确实是 GET');
  eq(rejects[0] && rejects[0].path, '/mode/effort', '§4b① reject 路径 = /mode/effort');
  eq(effortRange() && effortRange().disabled, true, '§4b① 分支 :3046 命中 ⇒ 滑块 disabled');
  ok(/读不到当前推理档位\(请求失败\)/.test(statusText()), '§4b① 状态行 = catch 专属文案"读不到当前推理档位(请求失败)"');
  eq(ariaValueText(), null, '§4b① 不猜值:aria-valuetext 仍为空');

  // ② GET /model/background reject ⇒ client.js:3664
  await openOverview(baseRoutes({ '/model/background': new Error('gateway down') }));
  collect();
  eq(rejects.length, 1, '§4b② GET /model/background 真 reject 了 1 次');
  eq(bgProvInput() && bgProvInput().disabled, true, '§4b② 分支 :3664 命中 ⇒ provider 格 disabled');
  eq(bgModelInput() && bgModelInput().disabled, true, '§4b② model 格也 disabled');
  eq(bgSaveBtn() && bgSaveBtn().disabled, true, '§4b② 保存 disabled');
  ok(/读不到当前的后台模型设置\(请求失败\)/.test(bgStatusText()), '§4b② 状态行 = catch 专属文案"读不到当前的后台模型设置(请求失败)"');

  // ③ 预览 POST reject ⇒ client.js:2982
  await openOverview(baseRoutes({ '/mode/effort': effortRoute([new Error('gateway down')]) }));
  await slideTo(1);
  collect();
  eq(rejects.length, 1, '§4b③ 预览 POST 真 reject 了 1 次');
  eq(rejects[0] && rejects[0].method, 'POST', '§4b③ reject 的确实是 POST');
  eq(effortPosts().length, 1, '§4b③ 预览确实发出去了(才谈得上 reject)');
  ok(/保存失败:没能连上宿主/.test(statusText()), '§4b③ 分支 :2982 命中 ⇒ 状态行"保存失败:没能连上宿主"');
  eq(effortRange() && effortRange().value, '2', '§4b③ 失败回滚到 lastGood(2),不是主人拖到的 1');
  eq(tickOn(), 2, '§4b③ 刻度高亮一起回滚到 index 2');
  eq(ariaValueText(), '深入', '§4b③ aria-valuetext 回滚到 深入');

  // ④ 落笔 POST reject ⇒ client.js:3000
  await openOverview(baseRoutes({ '/mode/effort': effortRoute([previewReply(2, 1), new Error('gateway down')]) }));
  await slideTo(1);
  clickNode(saveBtn());
  await settle(8);
  collect();
  eq(rejects.length, 1, '§4b④ 落笔 POST 真 reject 了 1 次(预览那发是正常回放)');
  eq(effortPosts().length, 2, '§4b④ 两次 POST 都发出去了(预览 + 落笔)');
  eq(confirmWrites().length, 1, '§4b④ 被 reject 的确实是落笔那一发(带 confirmEffort:true)');
  ok(/保存失败:没能连上宿主/.test(statusText()), '§4b④ 分支 :3000 命中 ⇒ 状态行"保存失败:没能连上宿主"');
  eq(effortRange() && effortRange().value, '2', '§4b④ 回滚到 lastGood(2)');
  eq(saveBtn() && saveBtn().disabled, false, '§4b④ 失败后仍可再试(不锁死)');

  // ⑤ POST /model/background reject ⇒ client.js:3633
  //    GET 正常(两格可编辑)⇒ 点保存 ⇒ POST 由路由函数 throw ⇒ fetch reject
  await openOverview(baseRoutes({
    '/model/background': (rec) => {
      if (rec.method === 'POST') throw new Error('gateway down');
      return bgGet({ configured: { provider: 'my-prov', model: 'my-model' }, source: 'settings' });
    },
  }));
  eq(bgProvInput() && bgProvInput().value, 'my-prov', '§4b⑤ 前置:GET 成功 ⇒ 两格填 configured');
  clickNode(bgSaveBtn());
  await settle(8);
  collect();
  eq(rejects.length, 1, '§4b⑤ 保存 POST 真 reject 了 1 次(路由函数 throw ⇒ fetch reject)');
  eq(bgPosts().length, 1, '§4b⑤ 保存请求确实发出去了(才谈得上 reject)');
  ok(/✗ 保存失败\(网关不可达\)/.test(bgStatusText()), '§4b⑤ 分支 :3633 命中 ⇒ 状态行"✗ 保存失败(网关不可达)"');
  ok(/盘上没改/.test(bgStatusText()), '§4b⑤ 明说"盘上没改"(不假装成功)');
  eq(bgProvInput() && bgProvInput().value, 'my-prov', '§4b⑤ 失败不改框');

  // 命中计数(桩侧自证):每条 reject 都记了路径 + 方法
  const cnt = (p, m) => seen.filter((x) => x.path === p && x.method === m).length;
  const tally = 'GET /mode/effort=' + cnt('/mode/effort', 'GET')
    + ' · GET /model/background=' + cnt('/model/background', 'GET')
    + ' · POST /mode/effort=' + cnt('/mode/effort', 'POST')
    + ' · POST /model/background=' + cnt('/model/background', 'POST');
  console.log('  §4b 真 reject 计数(桩侧): ' + tally + ' · 合计=' + seen.length);
  eq(cnt('/mode/effort', 'GET'), 1, '§4b 计数:GET /mode/effort reject = 1(分支 :3046)');
  eq(cnt('/model/background', 'GET'), 1, '§4b 计数:GET /model/background reject = 1(分支 :3664)');
  eq(cnt('/mode/effort', 'POST'), 2, '§4b 计数:POST /mode/effort reject = 2(预览 :2982 + 落笔 :3000 各一)');
  eq(cnt('/model/background', 'POST'), 1, '§4b 计数:POST /model/background reject = 1(分支 :3633)');
  eq(seen.length, 5, '§4b 合计 5 次真 reject = 5 个失败分支各命中一次');
}

// ─────────────────────────── §5 C.6-9 连续两次成功后失败 ⇒ 回最近成功值 ───────────────────────────
await section('§5 C.6-9 连续两次保存成功后第三次失败 ⇒ 回最近一次成功的值');
{
  await openOverview(baseRoutes({
    '/mode/effort': effortRoute([
      previewReply(2, 1), savedReply(1, 2),                       // 第 1 次:2 → 1,成功
      previewReply(1, 3), savedReply(3, 1),                       // 第 2 次:1 → 3,成功
      previewReply(3, 0), { ok: false, reason: 'write-failed', message: '模拟:盘写不进去' }, // 第 3 次:3 → 0,失败
    ]),
  }));
  eq(effortRange() && effortRange().value, '2', '§5 前置:初值 = high(index 2,契约字面量)');

  // ---- 第 1 次成功:index 2 → 1 ----
  await slideTo(1);
  eq(effortPosts().length, 1, '§5 第 1 次预览已发');
  clickNode(saveBtn());
  await settle(8);
  eq(effortPosts().length, 2, '§5 第 1 次确认已发');
  eq(effortRange() && effortRange().value, '1', '§5 第 1 次成功后滑块 = 服务端 effective(index 1)');
  eq(ariaValueText(), '均衡', '§5 第 1 次成功后 aria-valuetext = 均衡');
  eq(tickOn(), 1, '§5 第 1 次成功后高亮 = index 1');

  // ---- 第 2 次成功:index 1 → 3 ----
  await slideTo(3);
  eq(effortPosts().length, 3, '§5 第 2 次预览已发');
  clickNode(saveBtn());
  await settle(8);
  eq(effortPosts().length, 4, '§5 第 2 次确认已发');
  eq(effortRange() && effortRange().value, '3', '§5 第 2 次成功后滑块 = 服务端 effective(index 3)');
  eq(ariaValueText(), '极致', '§5 第 2 次成功后 aria-valuetext = 极致');
  eq(tickOn(), 3, '§5 第 2 次成功后高亮 = index 3');

  // ---- 第 3 次:落笔失败 ⇒ 必须回**第二次**成功的值,不是打开面板时的 2 ----
  await slideTo(0);
  eq(effortPosts().length, 5, '§5 第 3 次预览已发');
  clickNode(saveBtn());
  await settle(8);
  const p = effortPosts();
  eq(p.length, 6, '§5 第 3 次确认已发(真的去写盘了,不是本地假成功)');
  eq(p[5] && p[5].body && p[5].body.confirmEffort, true, '§5 失败的这一发确实是"落笔"请求(带 confirmEffort:true)');
  eq(effortRange() && effortRange().value, '3',
    '§5 ★★C.6-9 失败后滑块 = 最近一次成功的值(index 3),不是打开面板时的 2');
  ok(effortRange() && effortRange().value !== '2',
    '§5 ★★不是"打开页面那一刻"的快照值(旧 paint(eff) 缺陷的形状:连续成功后一次失败退回初值)');
  eq(ariaValueText(), '极致', '§5 失败后 aria-valuetext 也回滚到 极致(不留下失败档的残影)');
  eq(tickOn(), 3, '§5 失败后刻度高亮回滚到 index 3');
  ok(/保存失败/.test(statusText()), '§5 状态行不吞失败:明说"保存失败"');
  ok(/盘写不进去/.test(statusText()), '§5 状态行照抄回执里的 message(不编原因、不糊 JSON)');
  ok(/已退回上次成功的值/.test(statusText()), '§5 状态行说清"已退回上次成功的值"');
  eq(saveBtn() && saveBtn().disabled, false, '§5 失败后仍可再试(不把控件永久锁死)');
  eq(togglePosts().length, 0, '§5 全程不碰 /mode/toggle(桩计数器 = 0)');
}

summary();
