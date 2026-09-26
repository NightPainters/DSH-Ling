// dsh-ling — 合规判据表(纯数据 + 纯函数:**不读文件系统、不写盘**)。
//
// 判据出处(两份文档本身不入库,措辞在此固化;改判据 = 改这张表):
//   · E:\DSH\V1\plans\AUDIT-dsh-ling-合规安全审计注意事项.md —— §2 A-2/A-4/A-6 · §4 C-4/C-6 · §5.1/§5.2
//   · E:\DSH\V1\plans\COMPLIANCE-CORRECTIONS.md —— §A1(形态声明草案)· §A3(定性归属句定稿)·
//     §A4(AI 生成标识文案)· §A5(安装路径)· §A6(面向性声明)· §A7(不上架商店)· §2(明确不做)
//
// 用法:release\check-compliance.mjs 读盘 → 喂 scanText/scanCorpus → 印结论(默认干跑,无写盘能力)。
//
// ⚠ 书写约定(不是风格问题,是判据自洽问题):凡**判据自身的字面量**,一律在词中间插 `·`,
//   编译时由 S() 去掉。原因:本文件也在关①.6 的扫描范围内 —— 若把判据原文写成连续字面量,
//   扫描器会**永久命中它自己**,"0 命中"那条判据从此永远报红。tests/tools.test.mjs 里有自检钉住它。

const S = (s) => s.replace(/·/g, '');
const re = (s) => new RegExp(S(s));

// ---------------------------------------------------------------- 判据 1 / 8a:禁用与关怀措辞
// 判据 1(`F-DISABLED-WORDING` / `F-DISABLED-WORDING-2`)逐字取自 AUDIT §5.1 原文正则 + 主会话定的兜底族。
// 判据 8a(`F-CARE-FEATURES`)取自 COMPLIANCE-CORRECTIONS §2 的"明确不做"清单。
export const FORBIDDEN = [
  {
    id: 'F-DISABLED-WORDING',
    re: re('仅限个·人使用|不得商·用|禁止商·用|已合·规|符合.{0,8}(办·法|条·例)|包·治|保证.{0,4}(有·效|安·全)'),
    reason: 'AUDIT §5.1 原文正则(A-2):与 Apache-2.0 冲突,或无依据的合规承诺与功效/绝对化说法(= 虚假陈述)',
  },
  {
    id: 'F-DISABLED-WORDING-2',
    re: re('仅限个·人|仅供个·人|个人使·用|非商·用|不可商·用|最安·全|100% ?有·效|疗·效|治·愈'),
    reason: 'A-2 兜底族:同类措辞的变体写法(主会话 2026-09-26 定;别让换个字的写法溜过去)',
  },
  {
    id: 'F-CARE-FEATURES',
    re: re('2\\s*小时使用提·醒|沉迷弹·窗|情感边界引·导|极端干·预|账号体·系|监护人绑·定|紧急联·系人'),
    reason: 'COMPLIANCE-CORRECTIONS §2 明确不做:这些是「服务提供者」的义务,本地软件做了等于自我定性',
  },
];

// ---------------------------------------------------------------- 判据 3/4/5/6/7/8b:必须存在的声明与入口
// file:树内相对路径(正斜杠);re:语义正则(措辞逐字,标点/加粗留容差)。
export const REQUIRED = [
  // 判据 3 —— M1「本项目是什么形态」声明块的 5 个子句(措辞逐字取自 COMPLIANCE-CORRECTIONS §A1 草案)
  {
    id: 'M1-1',
    file: 'README.md',
    re: re('本地运行的软件[\\s\\S]{0,200}?你自己的机器'),
    reason: 'A1 第 1 句:形态 = 本地运行的软件,跑在你自己的机器上',
  },
  {
    id: 'M1-2',
    file: 'README.md',
    re: re('上游不提供任何在线服务[\\s\\S]{0,60}?不运营任何服务端[\\s\\S]{0,60}?不托管任何用户数据[\\s\\S]{0,200}?作者不接触、不接收你的会话内容'),
    reason: 'A1 第 2 句:上游不提供在线服务 / 不运营服务端 / 不托管数据,作者不接触会话内容',
  },
  {
    id: 'M1-3',
    file: 'README.md',
    re: re('不上架任何应用商店[\\s\\S]{0,80}?仅通过\\s*\\**GitHub[\\s\\S]{0,60}?npm'),
    reason: 'A1 第 3 句(= A7 纪律):只走 GitHub + npm 分发',
  },
  {
    id: 'M1-4',
    file: 'README.md',
    re: re('模型与\\s*\\**API\\s*Key\\**\\s*由使用者自行提供和承担'),
    reason: 'A1 第 4 句:模型与 API Key 由使用者自备,与上游无关',
  },
  {
    id: 'M1-5',
    file: 'README.md',
    re: re('不提供医疗、心理、法律或紧急救助服务[\\s\\S]{0,120}?联络当地紧急服务或专业机构'),
    reason: 'A1 第 5 句:不提供医疗/心理/法律/紧急救助,遇危机联络当地专业机构',
  },
  // 判据 4 —— M2 定性归属句(**主人定稿逐字**,见 COMPLIANCE-CORRECTIONS §A3;别用初版"也可以是别的")
  {
    id: 'M2',
    file: 'README.md',
    re: re('本项目不定义你与它的关系[\\s\\S]{0,8}?它可以是同事、搭档[\\s\\S]{0,24}?取决于你怎么用它'),
    reason: 'A3 定稿逐字:「本项目不定义你与它的关系:它可以是同事、搭档,或其他 —— 取决于你怎么用它。」',
  },
  // 判据 5 —— 不上架商店的硬纪律(A7;落点 = 发布手册,不是 README)
  {
    id: 'C6-STORE',
    file: 'PUBLISH-WORKFLOW.md',
    re: re('不上架任何应用商店'),
    reason: 'A7 / AUDIT §4 C-6:只走 GitHub + npm;写进发布手册作为硬纪律',
  },
  // 判据 6 —— M3 AI 生成标识 + M4 面向性声明(文案逐字取自 COMPLIANCE-CORRECTIONS §A4 / §A6)
  {
    id: 'M3',
    file: 'README.md',
    re: re('本插件的回答与记忆摘要[\\s\\S]{0,24}?由人工智能生成[\\s\\S]{0,80}?可能存在错误[,，]?请自行判断'),
    reason: 'A4:回答与记忆摘要由人工智能生成,可能存在错误,请自行判断',
  },
  {
    id: 'M4',
    file: 'README.md',
    re: re('本项目面向[\\s\\S]{0,40}?具备自行配置与运维能力[\\s\\S]{0,40}?的用户[\\s\\S]{0,160}?不面向未成年人[\\s\\S]{0,120}?不提供任何形式的在线陪伴服务'),
    reason: 'A6:面向具备自行配置与运维能力的用户;不面向未成年人,不提供在线陪伴服务',
  },
  // 判据 7 —— 安装路径语义断言(A5:显式安装命令 + 同名包提示;语义等价即算过,不锁死句式)
  {
    id: 'A5-INSTALL',
    file: 'README.md',
    re: re('(npm\\s+(i|install)\\s+@nightpainters/dsh-ling)|(add\\s+@nightpainters/dsh-ling)'),
    reason: 'A5:README 必须给显式安装命令(scoped 名),否则用户装到别人占的裸名包',
  },
  {
    id: 'A5-SAMENAME',
    file: 'README.md',
    re: re('(?<![\\w@/-])`?dsh-ling`?(?![\\w/-])[^\\n]{0,40}?(与本项目无关|已被他人占用|由第三方占用)'),
    reason: 'A5:必须说明 npm 上另有同名包与本项目无关(防装错)',
  },
  // 判据 8b —— 关怀功能 0 命中的同时,导出 / 删除入口必须仍在(B-3/B-4:§2「已有的本地能力不撤」)
  {
    id: 'B4-EXPORT-API',
    file: 'lib/host/api.js',
    re: re("register\\('/export'"),
    reason: 'B-4:记忆导出入口(宿主侧 HTTP 路由)—— 出口没了,"数据可带走"就不再是事实主张',
  },
  {
    id: 'B4-DELETE-API',
    file: 'lib/host/api.js',
    re: re("register\\('/memories/delete'"),
    reason: 'B-4:删除入口(宿主侧 HTTP 路由)—— 本地形态下"可删除"是硬事实,不许被删掉',
  },
  {
    id: 'B4-EXPORT-CLIENT',
    file: 'lib/client.js',
    re: re('function exportMemory\\('),
    reason: 'B-4:面板侧的导出入口(把 /export 变成用户按得到的按钮)',
  },
  {
    id: 'B4-DELETE-KEEP-ARCHIVE',
    file: 'lib/host/tools.js',
    re: re('永远不做彻底删除'),
    reason: 'B-4:删除语义(先归档再打遗忘标记,可撤销)—— 别把"可删除"改成"不可逆销毁"',
  },
];

// ---------------------------------------------------------------- 判据 2:出站固定域名扫描
// 基线 4 处(AUDIT §3 B-1 实测):lib/client.js ×2(本地面板 API)+ lib/host/dsweb-summary.js ×2
// (用户自配 provider baseUrl)。白名单按「文件 + 归属函数」判定,不按行号 —— 行号最容易过期。
export const OUTBOUND = {
  re: re('fe·tch\\(|no·de:https|no·de:net|ax·ios|un·dici|new ·WebSocket|Event·Source|XMLHttp·Request|https?\\.req·uest'),
  baseline: 4,
  whitelist: [
    {
      file: 'lib/client.js',
      fn: ['api', 'exportMemory'],
      why: '本地面板 API:走文件内的 API 常量(同源 / 回环),不算外发',
    },
    {
      file: 'lib/host/dsweb-summary.js',
      fn: ['probeAssistant', 'summarizeLocal'],
      why: '用户自配 provider:地址由 baseUrl 参数给出(settings.assistant → 环境变量 → 内置 loopback)',
    },
  ],
};

// ---------------------------------------------------------------- 纯函数
const allHits = (text, re) => [...String(text).matchAll(new RegExp(re.source, 'g'))];
const lineAt = (text, index) => String(text).slice(0, index).split('\n').length;
/** 树内相对路径(正斜杠)是否命中判据里的 file(允许 runner 带 release/ 之类前缀)。 */
const fileMatches = (name, file) => name === file || String(name).endsWith('/' + file);

/** 取第 idx 行(0 基)往上最近的函数声明名 —— 出站调用的"归属函数"(白名单靠它,而不是行号)。 */
function enclosingFn(lines, idx) {
  for (let i = idx; i >= 0; i -= 1) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) return m[1];
  }
  return null;
}

function scanOutbound(name, text) {
  const lines = String(text).split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(new RegExp(OUTBOUND.re.source, 'g'))) {
      const fn = enclosingFn(lines, i);
      const wl = OUTBOUND.whitelist.find((w) => fileMatches(name, w.file) && w.fn.includes(fn));
      hits.push({ file: name, line: i + 1, at: m[0], fn, allowed: !!wl, why: wl ? wl.why : null });
    }
  }
  return hits;
}

/**
 * 扫一份文本(纯函数)。返回 `{ problems, outbound }` —— problems 每条含
 * `{ id, file, line, msg, reason }`(line=0 表示"整篇/文件级"问题)。
 */
export function scanText(name, text) {
  const t = String(text ?? '');
  const problems = [];
  for (const rule of FORBIDDEN) {
    for (const h of allHits(t, rule.re)) {
      problems.push({
        id: rule.id, file: name, line: lineAt(t, h.index),
        msg: `命中禁用/关怀措辞「${h[0].slice(0, 24)}」`, reason: rule.reason,
      });
    }
  }
  for (const rule of REQUIRED) {
    if (!fileMatches(name, rule.file)) continue;
    if (!rule.re.test(t)) {
      problems.push({ id: rule.id, file: name, line: 0, msg: `缺少必需声明:${rule.id}(${rule.file})`, reason: rule.reason });
    }
  }
  const outbound = scanOutbound(name, t);
  for (const h of outbound) {
    if (h.allowed) continue;
    problems.push({
      id: 'F-OUTBOUND-NOT-WHITELISTED', file: name, line: h.line,
      msg: `出站模式命中「${h.at}」但归属函数 ${h.fn ?? '(顶层)'} 不在白名单`,
      reason: 'AUDIT §5.2:指向上游/第三方固定域名的调用 = 红灯;判据文件自命中也算红',
    });
  }
  return { problems, outbound };
}

/**
 * 扫一批文件(纯函数):`entries = [{ name, text }]`。除逐文件判据外,还核对
 * ①出站命中总数 == 基线(不漂移)②每条判据要求的文件确实在扫描集里(否则"缺声明"会静默消失)。
 */
export function scanCorpus(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const problems = [];
  const outbound = [];
  for (const e of list) {
    const r = scanText(e.name, e.text);
    problems.push(...r.problems);
    outbound.push(...r.outbound);
  }
  for (const rule of REQUIRED) {
    if (!list.some((e) => fileMatches(e.name, rule.file))) {
      problems.push({
        id: 'F-MISSING-FILE', file: rule.file, line: 0,
        msg: `判据要求的文件没有被扫描到:${rule.file}("缺声明"不该靠漏扫来消失)`, reason: rule.reason,
      });
    }
  }
  if (outbound.length !== OUTBOUND.baseline) {
    problems.push({
      id: 'F-OUTBOUND-DRIFT', file: '(全库)', line: 0,
      msg: `出站模式命中 ${outbound.length} 处 ≠ 基线 ${OUTBOUND.baseline} 处`,
      reason: 'B-1 基线:面板 API ×2 + 用户自配 baseUrl ×2;漂移时逐处理清,再更新基线',
    });
  }
  return { problems, outbound, stats: { files: list.length, outboundHits: outbound.length } };
}
