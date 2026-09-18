// 注入面 {{…}} 中和(2026-09-18):宿主 renderPrompt 无 try/catch,而它每一步模型调用都渲染一次,
// 故一条含**未注册** `{{名字}}` 的记忆就能让该会话彻底不能说话;已注册名({{model}}/{{cwd}})则被
// 静默替换成别的内容(更隐蔽)。本案测两件事:中和函数本身,以及两条注入出口确实过了它。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { ok, eq, section, summary } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { neutralizeMustache: n } = await imp('lib/host/util.js');
const { buildSnapshotText } = await imp('lib/host/snapshot.js');

// 宿主判据(与 dsh-system-prompt 的变量正则同形):命中即会被展开/抛异常
const HOST_VAR = /\{\{([^{}]*)\}\}/;
const dangerous = (s) => HOST_VAR.test(String(s ?? ''));
const ZWSP = '\u200b';

// ---------------- 1) 中和函数本体 ----------------
section('1) neutralizeMustache 本体');
{
  // 反证:载荷本身确实是危险的(否则下面的断言只是在测空气)
  ok(dangerous('{{time}}') === true, '反证:未中和的 {{time}} 会被宿主当变量');
  ok(dangerous(n('{{time}}')) === false, '中和后不再是变量');
  ok(dangerous(n('{{time}}{{date}}{{weekday}}')) === false, '本机实际载荷(三连)被中和');
  ok(dangerous(n('{{model}}')) === false, '已注册名也中和(它会静默替换,更隐蔽)');
  ok(dangerous(n('aaa {{ pool }} bbb')) === false, '带空格的变量名同样中和');
  ok(dangerous(n('{{{a}}}')) === false, '三连大括号(朴素 replace 会漏网的那种)');
  ok(dangerous(n('{{{{')) === false, '四个左括号');
  ok(dangerous(n('x{{a}}y{{b}}z')) === false, '同段多处变量');

  // 可逆性:去掉零宽空格应当逐字还原,主人的原文没有被改写
  eq(n('{{time}}').split(ZWSP).join(''), '{{time}}', '中和可逆(内容零损失)');
  eq(n('{{time}}{{date}}').split(ZWSP).join(''), '{{time}}{{date}}', '多处可逆');

  // 幂等:出口①中和过的文本再经出口②,不应继续变化
  eq(n(n('{{time}}')), n('{{time}}'), '幂等');

  // 不该误伤的形态
  eq(n('{ {'), '{ {', '间隔花括号原样保留');
  eq(n('单个 { 左括号'), '单个 { 左括号', '单个左括号原样保留');
  eq(n('a }} b'), 'a }} b', '只有右括号时原样保留');
  eq(n(''), '', '空串');
  eq(n(undefined), undefined, '非字符串原样返回(undefined)');
  eq(n(null), null, '非字符串原样返回(null)');
}

// ---------------- 2) 出口① 快照成文 ----------------
section('2) 出口① buildSnapshotText(L0 人格 + L1 记忆)');
{
  const iso = () => new Date(Date.now() - 864e5).toISOString();
  const row = (o = {}) => ({
    conv_id: o.conv_id || 'c1',
    source: o.source || 'dsh',
    title: o.title ?? '',
    summary: o.summary ?? '',
    category: o.category || 'knowledge',
    domain_tags: [],
    keywords: o.keywords || [],
    updated_at: iso(),
    started_at: iso(),
    importance: o.importance ?? 0,
    hit_count: o.hit_count ?? 0,
    overview_ok: 1,
  });
  const S = {
    persona: {
      enabled: true, aiName: '小灵', userTitle: '', aiTitle: '', language: 'follow',
      tone: 'natural', toneWork: '', toneLife: '', extraLore: '',
      hardRules: [], habits: [], habitsPending: [], bottomLines: [], ruleMeta: [],
      sealed: false, sealPhrase: '', pronoun: '她',
    },
    styles: { work: '', life: '' },
    mode: { lastMode: 'life' },
    memory: { l1Enabled: true, l1BudgetTokens: 1200, l1MaxItems: 8 },
  };
  const memWith = (rows) => ({
    kvGet: () => '', kvSet: () => {}, bumpHit: () => {}, listOverviews: () => rows,
    sessionMeta: () => null,
  });
  const build = (rows, settings) =>
    buildSnapshotText(null, memWith(rows), { get: () => settings || S }, 'sid-x', { keywords: [] }).text;

  // L1 侧:一条记忆的措辞就能炸掉会话 —— 成文后必须已中和
  const l1Text = build([row({ title: '模板变量用法', summary: '记 `{{time}}` 与 `{{pool}}` 的展开时机' })]);
  ok(l1Text.length > 0, 'L1 段确实成文(否则断言是空的)');
  ok(dangerous(l1Text) === false, 'L1 记忆里的 {{…}} 未进提示面');
  ok(l1Text.includes('time'), '内容本身保留(只是定界符被拆开)');

  // L0 侧:规矩是每次必注入的,一旦中招是**所有会话**一起失效
  const s2 = JSON.parse(JSON.stringify(S));
  s2.persona.hardRules = ['引用变量时要写成 {{变量名}} 的形式'];
  const l0Text = build([row({ title: 't', summary: 's' })], s2);
  ok(l0Text.includes('引用变量时要写成'), '规矩确实进了 L0(否则断言是空的)');
  ok(dangerous(l0Text) === false, '规矩里的 {{…}} 未进提示面');

  // 混合:两段同时带载荷
  const both = build([row({ title: '{{a}}', summary: '{{b}}' })], s2);
  ok(dangerous(both) === false, 'L0+L1 同时带载荷仍安全');
}

// ---------------- 3) 出口② 源码护栏(时间锚与未来新增 part 的兜底) ----------------
section('3) 出口② inject.js 最外层');
{
  const src = readFileSync(join(root, 'lib/host/inject.js'), 'utf8');
  ok(/neutralizeMustache/.test(src), 'inject.js 引入了 neutralizeMustache');
  ok(/const body = neutralizeMustache\(text \|\| ''\)/.test(src), '正文经中和');
  ok(/neutralizeMustache\(anchor\)/.test(src), '时间锚经中和(它不经快照)');
  // 所有返回都走 withAnchor:漏一条就是漏一个出口
  const returns = [...src.matchAll(/return withAnchor\(/g)].length;
  ok(returns >= 5, 'withAnchor 覆盖了全部返回路径(实测 ' + returns + ' 处)');
  ok(!/return (?!withAnchor|'';|\{)[^\n]*built\.text/.test(src), '没有绕过 withAnchor 直返 built.text 的路径');

  const snapSrc = readFileSync(join(root, 'lib/host/snapshot.js'), 'utf8');
  ok(
    /neutralizeMustache\(parts\.join\('\\n\\n'\)\)/.test(snapSrc),
    'snapshot.js 成文即中和(parts.join 被包住)',
  );
}

summary();
