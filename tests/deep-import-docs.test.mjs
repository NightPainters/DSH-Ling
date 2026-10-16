// C 档「文档灌入结论层」的判据(2026-10-15):**本套只钉纯函数**(抽取规则 / 两道污染闸 / 三级去重),
//   **不碰真库** —— 碰库那半由 dry-run 清单 + 主人过目兜住(清单落在 plans/ 里,可复跑同一份产物)。
//
// 钉住的三件要紧事:
//   ① **限量与原点逐字钉死**:≤40 条 · origin=doc-import-v1 —— 改这些数字要在这里红
//      (它们是主人拍板的:超过 40 条会挤掉真实会话里长出来的结论);
//      硬度**不是一律 long**(2026-10-15 改):按每条自己的过时风险分档,见 §13;
//   ② **污染闸**:删除线 / 作废小节 / 状态否决集 / 超 80 字(不自动改写)/ 开头指代词 —— 一条都不许漏;
//   ③ **去重的判据为什么是重叠系数而不是包含关系**:下面用实测样本把两者的**差值**钉住
//      (同一对文本,Dice 0.889、重叠 1.0;另一对 Dice<0.85 而重叠 1.0 —— 只看 Dice 会漏)。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const M = await imp('tools/deep-import-docs.mjs');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const eq = (a, b, m) => check(a === b, `${m}(期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)})`);
const section = (t) => console.log('── ' + t);

section('1) 拍板的限量与原点(改了这里就该红)');
eq(M.TEXT_MAX, 80, 'text 上限 = 80 字(与 DDL 一致)');
eq(M.FIRST_PASS_LIMIT, 40, '第一趟限量 = 40 条(主人拍板)');
eq(M.ORIGIN, 'doc-import-v1', 'origin = doc-import-v1(与 discipline-doc-v1 同族)');
eq(M.DEFAULT_DURABILITY, 'long', '缺省硬度 = long(认不出时间锚时的落点)');

section('2) 去标记只去标记、不改词句');
eq(M.stripMarkup('**粗** 与 `码`'), '粗 与 码', '去掉 ** 与反引号');
eq(M.stripMarkup('  a   b  '), 'a b', '空白折叠');
eq(M.stripMarkup('整句**照**旧'), '整句照旧', '**只去标记**:词句一个字都不换');

section('3) 规范化键:标点/全半角/括号样式都不算差异');
eq(M.canonKey('提炼触发＝空闲边界 ＋ 手动'), M.canonKey('提炼触发 = 空闲边界 + 手动'),
  '★全角 ＝ ＋ 与半角 = + 归一(实测漏网过:同一句结论因此各占一个席位)');
eq(M.canonKey('【归属】层名归一「主动感知层」'), M.canonKey('归属层名归一(主动感知层)'),
  '【】「」() 只抹括号、留下里面的字');
eq(M.canonKey('A,B。C;D'), M.canonKey('ABCD'), '中英标点全抹');

section('4) 三级去重:为什么必须"重叠系数"而不只是 Dice');
{
  // 实测样本一:标点略异 ⇒ Dice 与重叠都在阈值之上
  const a1 = '「主人不删数据」横贯性原则：带清理／删除／过期回收动作的项默认先过这一关；本层产出只许是「看见」，处置归主人';
  const b1 = '「主人不删数据」是横贯性原则：带清理/删除/过期回收动作的项默认先过这一关；本层产出只许是"看见"，处置归主人';
  const ka = M.canonKey(a1); const kb = M.canonKey(b1);
  check(M.dice2(ka, kb) >= M.DUP_DICE, '样本一:Dice ≥ 阈值(' + M.dice2(ka, kb).toFixed(3) + ')');
  check(M.overlap2(ka, kb) >= M.DUP_DICE, '样本一:重叠系数也 ≥ 阈值(' + M.overlap2(ka, kb).toFixed(3) + ')');
  // 实测样本二(长度不对称):Dice 掉到阈值之下,而重叠系数仍是满值 —— 这就是引入重叠系数的原因
  const a2 = 'D1「气根」：条目不隶属于枝；branch_id 可空（硬挂会制造假归属）；枝可以反向引用条目';
  const b2 = 'D1「气根」的具体含义：条目不隶属于枝；branch_id 可空（硬挂会制造假归属）；枝可以反向引用条目（branch 侧要预留"引用条目"的位置）';
  const ka2 = M.canonKey(a2); const kb2 = M.canonKey(b2);
  const d2 = M.dice2(ka2, kb2); const o2 = M.overlap2(ka2, kb2);
  check(d2 < M.DUP_DICE, '★样本二:Dice 低于阈值(' + d2.toFixed(3) + ') ⇒ 只看 Dice 会漏掉这条重复');
  check(o2 >= M.DUP_DICE, '★样本二:重叠系数仍在阈值之上(' + o2.toFixed(3) + ') ⇒ 它才是判据');
  // 反向:两句**不同**的结论不能被判成同一句(免得把真内容并掉)
  const p = M.canonKey('提炼触发＝空闲边界 ＋ 手动（自动跑，允许手补／重跑）');
  const q = M.canonKey('谁来提炼：先主模型跑一次全量（历史 116 个会话作基线），之后增量用本地 9b');
  check(M.overlap2(p, q) < M.DUP_DICE, '负对照:两句不同的结论,重叠系数低于阈值(' + M.overlap2(p, q).toFixed(3) + ')');
}

section('5) 状态列:接受集与否决集分开');
check(M.judgeStatus('已拍板').ok === true, '已拍板 ⇒ 收');
check(M.judgeStatus('已拍板（D3）').ok === true && M.judgeStatus('已拍板（D3）').score === 3, '带后缀照样认(前缀匹配)');
check(M.judgeStatus('已落地').score === 1, '已落地 = 硬度 1(比"已拍板"软)');
check(M.judgeStatus('草案').ok === false, '★草案 ⇒ 丢(污染闸①)');
check(M.judgeStatus('待拍板').ok === false, '★待拍板 ⇒ 丢');
check(M.judgeStatus('').ok === false, '空状态 ⇒ 丢(不接受集就丢,不默认收)');

section('6) 过闸:污染闸与"不自动改写"');
const G = (o) => M.gateCandidate(o);
const good = { text: '凡要写进规格的机制条目,必须附一次源码复核', status: '已拍板', line: '', sectionStale: false };
check(G(good).ok === true, '正例:一句话结论过闸');
eq(G({ ...good, text: 'x'.repeat(81) }).reason.includes('不自动改写'), true, '★超 80 字:拒收,理由里写明不自动改写');
check(G({ ...good, text: 'x'.repeat(80) }).ok === true, '刚好 80 字:收(边界不多不少)');
check(G({ ...good, text: '这条指的是上面那个东西的结论' }).ok === false, '★开头指代词 ⇒ 离开上下文读不懂,丢');
check(G({ ...good, line: '~~旧结论~~' }).ok === false, '★删除线 ⇒ 丢(污染闸①)');
check(G({ ...good, sectionStale: true }).ok === false, '★落在"已过时/作废"小节里 ⇒ 丢(污染闸①)');
check(G({ ...good, text: 'node tests/library-sqlite.test.mjs 跑一遍' }).ok === false, '命令不像结论 ⇒ 丢');
check(G({ ...good, text: '很短的' }).ok === false, '太短 ⇒ 丢');
check(G({ ...good, status: '计划中' }).ok === false, '状态属否决集 ⇒ 丢');

section('7) kind 判定:不确定就不落(纪律类永不自动落库)');
eq(M.classifyKind('某句', '纪律').pending, true, '★状态列自称纪律 ⇒ pending(缺①③)');
eq(M.classifyKind('探针一律在副本上跑，绝不碰真机库', '已定').pending, true, '★含禁令词 ⇒ pending,不许自动当"纪律"落库');
eq(M.classifyKind('我答应过要把主动开口层做完', '已定').kind, '承诺', '承诺词 ⇒ 承诺');
eq(M.classifyKind('这条已拍板:图书馆放 1.6.1', '已定').kind, '决定', '拍板词 ⇒ 决定');
eq(M.classifyKind('他讨厌文档滞后于实现', '已定').kind, '偏好', '偏好词 ⇒ 偏好(与状态列无关)');
eq(M.classifyKind('归属 —— 规矩是主人的,习惯是器灵的', '主人拍板').kind, '决定',
  '★"习惯"是领域名词,不该触发偏好(实测漏网:设计理念第 1 条曾被误判成偏好)');
eq(M.classifyKind('我们约定 9-07 是新生纪念日', '已定').kind, '关系', '关系词 ⇒ 关系');
eq(M.classifyKind('宿主在 E:\DSH\V1 这台机器上', '实测').kind, '事实', '其余 ⇒ 事实(他的项目/环境的稳定事实)');

section('8) 表格与 DESIGN 两节的解析(体例一变就该在这里红)');
{
  const md = [
    '| 编号 | 结论 | 类别 | 出处 | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| C1 | 一句话结论甲 | 机制 | `a.md:1` | 已拍板 |',
    '| C2 | 一句话结论乙 | 对外 | `b.md:2` | 草案 |',
  ].join('\n');
  const tabs = M.parseTables(md);
  eq(tabs.length, 1, '解析出 1 张表');
  eq(tabs[0].header.length, 5, '表头 5 列');
  eq(tabs[0].rows.length, 2, '分隔行不算数据行(2 行)');
  eq(tabs[0].rows[0].cells[1], '一句话结论甲', '列位稳定:第 2 格是结论');
}
{
  const src = readFileSync(join(root, 'DESIGN.md'), 'utf8');
  const d = M.extractDesignSections(src);
  check(d.decisions.length >= 7, '★DESIGN.md §0 决策表至少 D1–D7(' + d.decisions.length + ' 行)');
  eq(d.decisions[0].id, 'D1', '第一行是 D1');
  check(d.principles.length >= 12, '★§0.1 设计理念至少 12 条(' + d.principles.length + ' 条)');
  check(d.principles[0].text.length > 4, '理念条正文非空(实际:' + d.principles[0].text + ')');
}

section('9) 料源清单(本机真文档;缺目录就跳过,不假绿)');
{
  const rootDir = join(root, '..');
  if (existsSync(join(rootDir, 'plans', 'spec-extract'))) {
    const docs = M.listSpecExtractDocs(rootDir);
    eq(docs.length, 5, 'plans/spec-extract 下 5 份规格抽取文档');
    check(docs.every((d) => d.endsWith('.md')), '清单里全是 .md');
  } else {
    console.log('  (跳过:本机没有 plans/spec-extract —— 发布包里本来就不该有)');
  }
}

section('10) 自审加的两道形态闸(2026-10-15:清单出来之后、给主人看之前抓出来的)');
{
  // 闸一 · 过程与当场读数(prompt.md 判据③ 逐字:工具输出 / 报错 / 进度播报 / 当时的时间·状态·数字)
  eq(M.isProcessReading('本次不需要改 lib/client.js'), true, '★含"本次" ⇒ 判为过程读数');
  eq(M.isProcessReading('凡要写进规格的机制条目,必须附一次源码复核'), false, '负对照:真结论不被拦');
  eq(M.isProcessReading('昨晚那条读数'), true, '含"昨晚" ⇒ 过程读数');
  eq(M.isProcessReading('昨天那条读数'), false,
    '⚠️ "昨天"**不**禁(只有"昨晚"):实测"昨天"常出现在稳定事实里,禁掉会误伤');
  // 闸二 · 一条一事(prompt.md 逐字:「不许把两件事塞进一条」)
  eq(M.clauseCount('触发＝A；视野＝B；升格去向＝C；燃料＝D'), 4, '★四个分句 ⇒ 计 4(≥3 ⇒ 拒收退回让人拆)');
  eq(M.clauseCount('记忆树是空间维度；深层库是内容维度'), 2, '两个分句 ⇒ 计 2(对照句本身是一条结论,照收)');
  check(M.clauseCount('跑 1;2 次') <= 1, '⚠️ 短片段不算分句(「跑 1」不足 4 字),别把标点当分句');
}

section('11) 自审加的两个桶与"待判去重"(去重原先只跑在 candidates 上)');
{
  const src = readFileSync(join(root, 'tools', 'deep-import-docs.mjs'), 'utf8');
  check(/pendingMerged: \[\], suspicious: \[\]/.test(src),
    '★collect 的 report 里有 pendingMerged / suspicious 两个桶(文档生成处按名字取,改名会静默变空)');
  check(/待判清单也要去重/.test(src), '★待判去重那段带来源注释(实测:同一句纪律在待判里出现两次)');
  check(/须人补③/.test(src), '★待判条目写明"须人补③"(那是它为什么不能自动落库的唯一理由)');
  check(/疑似过程读数|isProcessReading/.test(src), '★过程读数那道闸在,且有名字可测');
}

section('12) 出处核验闸(2026-10-15 · 对抗审计之后加:判据不在"抄得准不准",在"真源认不认")');
{
  // ① 表头 → 列角色:**各料源列序不同**,硬取第 5 格会张冠李戴(实测 0-合并索引 的出处列在第 4 格)
  const a = M.columnRoles(['#', '设定条目', '标签', '出处', '状态线索']);
  eq(a.conclusion, 1, '0-合并索引 形状:结论列 = 1');
  eq(a.source, 3, '★0-合并索引 形状:出处列 = 3(第 4 格)');
  eq(a.status, 4, '状态线索列 = 4');
  const b = M.columnRoles(['#', '设定条目（一句话，可执行）', '出处', '类别', '实现线索']);
  eq(b.source, 2, '★2-DESIGN-星 形状:出处列 = 2 —— 与上面**不是同一格**');
  const c = M.columnRoles(['#', '节名', '行号范围', '承担职责', '该节里的可执行承诺条数', '备注']);
  check(c.isConclusionTable === false,
    '★4-README与CHANGELOG基线 形状 ⇒ 不是结论表(整表不入料:那是"哪一节写了什么"的目录)');
  check(a.isConclusionTable === true, '正对照:0-合并索引 是结论表');
  // ② 出处格 → 指针(多个指针都要留下 —— 取"最有力证据"时要用第二条)
  const ps = M.parsePointers('`DESIGN-主动层-讨论底稿.md:45` · `DESIGN.md:17,354,358`');
  eq(ps.length, 2, '解析出 2 个指针');
  eq(ps[0].file, 'DESIGN-主动层-讨论底稿.md', '指针①的文件名');
  eq(ps[1].lines.join(','), '17,354,358', '★指针②的多个行号全都留下');
  // ③ 结构行:被当"结论行"引用就是锚错位(审计实测:语音:28 / cordis.patch.yml:12 都是这种)
  eq(M.isStructuralLine('|---|---|---|'), true, '★表头分隔行 ⇒ 结构行');
  eq(M.isStructuralLine('---'), true, '--- ⇒ 结构行');
  eq(M.isStructuralLine('| ① | 变更感知（未读水位） |'), false, '负对照:真数据行不是结构行');
  // ④ flatKey:二手件把 `|` 换成 `:`,不去竖线就判不出"真源其实有这句"(D5 删节样本)
  const flatD5 = M.flatKey('| D5 | 记忆加载策略 | 三层记忆（L0 常驻人格） | 早前拍板 |');
  check(flatD5.includes(M.flatKey('记忆加载策略:三层记忆（L0 常驻人格）')),
    '★D5 样本:去掉竖线后,真源表格行**包含**二手件那句');
  check(!flatD5.includes(M.flatKey('记忆加载策略:三层记忆（L0 常驻人格）').slice(0, 4)) === false,
    '负对照:同样的前缀当然也包含(判的是"包含",不是"相等")');
  // ⑤ 读数闸:必须分常量与读数 —— 「上限 5 条」不该拦,「116 个会话」该拦
  eq(M.isReadingBearing('底线 bottomLines 上限 5 条；定型锁 sealed=true 时人格档案只读'), false,
    '★负对照:设计常量(上限 5 条)**不**算当场读数');
  eq(M.isReadingBearing('/state 按消费者实际需要拆成两档（轮询档／面板档），热路径从 ~24ms 降到 ~1ms 量级'), true,
    '★实测读数(~24ms 降到 ~1ms)⇒ 拦(审计实测 #37 就是这条)');
  eq(M.isReadingBearing('谁来提炼：先主模型跑一次全量（历史 116 个会话作基线）'), true,
    '★「116 个会话」⇒ 拦(真源自己写着 116→1,616,半年后必误导)');
}
{
  // ⑥ "取最有力证据"而不是"取第一条指针"(合成对照:第一条只中片段、第二条逐字命中)
  const os = await import('node:os');
  const fs2 = await import('node:fs');
  const dir = fs2.mkdtempSync(join(os.tmpdir(), 'dsh-prov-'));
  fs2.mkdirSync(join(dir, 'plans'), { recursive: true });
  fs2.writeFileSync(join(dir, 'plans', 'B.md'),
    '前言\n\n| ② | **变更感知（未读水位）** | 主人对记忆树的结构改动，在她下一次开口前注入；只报没见过的 |\n', 'utf8');
  fs2.writeFileSync(join(dir, 'plans', 'A.md'),
    'x\n\n| ① | D4 冻结门：运行中注入面逐字节不变，排队到 idle 才落地 |\n', 'utf8');
  const text = 'D4 冻结门：运行中注入面逐字节不变，排队到 idle 才落地';
  const r = M.verifyProvenance(text, [{ file: 'B.md', lines: [1] }, { file: 'A.md', lines: [3] }], M.buildCorpus(dir), { root: dir });
  eq(r.status, 'verified', '★取最有力证据:第一条只中片段、第二条逐字 ⇒ 判 verified(不许被第一条带偏)');
  eq(r.file, 'plans/A.md', '并且指向真正命中的那一份');
  eq(M.provenanceVerdict(r).ok, true, 'verified ⇒ 可落');
  // 真源那一行自称「草案/建议」⇒ 打旗标(实测:二手件标「已拍板(D3)」,真源原文却是「草案建议:…」)
  fs2.appendFileSync(join(dir, 'plans', 'A.md'), '草案建议：先跑一遍全量，允许手补重跑\n', 'utf8');
  const st = M.verifyProvenance('先跑一遍全量，允许手补重跑', [{ file: 'A.md', lines: [4] }], M.buildCorpus(dir), { root: dir });
  eq(st.status, 'verified', '措辞是草案也照样命中(判的是真源有没有这句,不是真源怎么说)');
  check(/草案/.test(st.flag), '★但旗标里必须写明真源自称草案/建议(实际:' + st.flag + ')');
  const miss = M.verifyProvenance('这句话真源里绝对没有,我是二手件自己编的', [{ file: 'A.md', lines: [3] }], M.buildCorpus(dir), { root: dir });
  eq(miss.status, 'missing', '★负对照:真源里没有 ⇒ missing');
  eq(M.provenanceVerdict(miss).ok, false, 'missing ⇒ 不落库(退待判)');
  fs2.rmSync(dir, { recursive: true, force: true });
}
{
  // ⑦ 主闸用**真机真源**跑两个实测样本(缺文件就跳过,不假绿)
  const rootDir = join(root, '..');
  if (existsSync(join(rootDir, 'plans', 'DESIGN-主动层-讨论底稿.md'))) {
    const corpus = M.buildCorpus(rootDir);
    check(corpus.length > 5, '真源语料库非空(' + corpus.length + ' 份)');
    check(!corpus.some((d) => /spec-extract|清单/.test(d.rel)),
      '★语料库里**没有** spec-extract 与清单类产物(否则清单那 40 条会自证)');
    const w = M.verifyProvenance('记忆树变更感知（未读水位）：主人的结构改动在她下一次开口前注入，只报没见过的',
      [{ file: 'DESIGN-主动层-讨论底稿.md', lines: [45] }], corpus, { root: rootDir });
    eq(w.status, 'weak', '★实测样本一:二手件改写 ⇒ weak(升级前会错报"真源没有这句话")');
    check(String(w.raw).length > 10, 'weak 也带真源原文(让人一眼看出是改写还是自撰)');
    eq(M.provenanceVerdict(w).ok, false, 'weak ⇒ 不落库(退待判)');
    const p = M.verifyProvenance('【其它】隐私红线只圈「器灵记忆库 ＋ 人格层」；传感器数据（定位／摄像头／麦克风／手环）没有「必须不出本机」的硬要求',
      [{ file: 'DESIGN-主动层-讨论底稿.md', lines: [345] }], corpus, { root: rootDir });
    eq(p.status, 'partial', '★实测样本二:真源 L349 是同一件事 ⇒ partial');
    eq(p.delta >= 1, true, '且记下指针漂移(实测 delta=' + p.delta + ')');
    eq(M.provenanceVerdict(p).ok, true, 'partial ⇒ 可落(带旗标)');
  } else {
    console.log('  (跳过:本机没有 plans/DESIGN-主动层-讨论底稿.md)');
  }
}
{
  // ⑧ 源码级:这几个桶/名字改名会让清单静默变空(与 §11 同一路数)
  const src = readFileSync(join(root, 'tools', 'deep-import-docs.mjs'), 'utf8');
  check(/pendingProv: \[\], readings: \[\], tables: \[\]/.test(src), '★collect 里有 pendingProv / readings / tables 三个桶');
  check(/weakMin/.test(src) && /const RANK = \{/.test(src), '★三档阈值与"取最有力证据"的 RANK 表都在');
  check(/columnRoles\(cells\)/.test(src), '★列位是按表头名取的(columnRoles),不是硬编码 cells[4]');
  check(/真源原文\(逐字,截 90 字\)/.test(src), '★清单印「真源原文」那一列(出处核对的决定性一列)');
  check(/STANCE_WEAK/.test(src), '★真源自称草案/建议要打旗标(实测:二手件标已拍板、真源原文写草案建议)');
}

section('13) 过时风险 → durability 分档(2026-10-15:主人问「过时条目怎么弄」之后加)');
{
  //  判据只认**文本里看得见的时间锚**,不猜语义(猜"这句会不会过时"要人)。
  //  源码口径(已复核):ephemeral 在 l1.js:400-403 被 continue 掉 ⇒ **不进开场**;durable 吃 +0.6 排序加权(l1.js:162)。
  eq(M.classifyDurability('历史 116 个会话').durability, 'ephemeral', '含读数 ⇒ 当次(不进开场)');
  eq(M.classifyDurability('接 v1.7 的客户端').durability, 'ephemeral', '带 v 前缀的版本号 ⇒ 当次');
  eq(M.classifyDurability('当前按 A 方案走').durability, 'ephemeral', '含时点状态(当前) ⇒ 当次');
  eq(M.classifyDurability('手术门今晚不重启宿主').durability, 'ephemeral', '含时间副词(今晚) ⇒ 当次');
  //  ★负例(实测踩过):最初写成"任意 数字.数字" ⇒ **「Apache-2.0」被当成版本号**,一句合规措辞的结论
  //    被误判成"当次"(不进开场)。许可名与小数都不是"会过期的版本"。
  eq(M.classifyDurability('合规措辞红线:禁写与 Apache-2.0 再分发许可矛盾的使用范围限制条款').durability,
    'long', '★「Apache-2.0」不是会过期的版本号(实测误判过)');
  eq(M.classifyDurability('阈值取 0.85 才有区分度').durability, 'long', '★裸小数不是版本号');
  eq(M.classifyDurability('两人约定:发布永远放最后一步', '关系').durability, 'durable', '原则词(永远) + 关系类 ⇒ 永久');
  eq(M.classifyDurability('效果优先于成本', '偏好').durability, 'durable',
    '★DDL(memory.js:331)自己举的 durable 例子就是价值排序形(A 优先于 B),没有"永远/一律"这类词');
  eq(M.classifyDurability('一律不许写"通过认证"这类话', '承诺').durability, 'durable', '「一律不许」也是原则词');
  eq(M.classifyDurability('一律不许写"通过认证"这类话', '决定').durability, 'long',
    '★同一句话当「决定」就不标永久(决定天生是某个时点的判断)');
  eq(M.classifyDurability('记忆加载策略:三层记忆', '决定').durability, 'long', '默认:稳定结论');
  eq(M.DEEP_DURABILITIES.length, 3, '三档与宿主 tools.js 的 DEEP_DURABILITIES 同集');
}
section('13b) 复查清单:机器挑信号,人裁(内存库自证,不碰真库)');
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE deep_item (id TEXT PRIMARY KEY, kind TEXT, text TEXT, at TEXT, conv_id TEXT,"
    + " seq_from INT, seq_to INT, src TEXT, origin TEXT, durability TEXT NOT NULL DEFAULT 'long',"
    + " hit_count INT DEFAULT 0, pinned INT DEFAULT 0, superseded_by TEXT DEFAULT '',"
    + " branch_id TEXT DEFAULT '', updated_at TEXT)");
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const ins = db.prepare('INSERT INTO deep_item (id,kind,text,at,durability,hit_count,pinned,superseded_by)'
    + ' VALUES (?,?,?,?,?,?,?,?)');
  ins.run('di:a', '事实', '历史 116 个会话都受影响', old, 'long', 3, 0, '');              // ① 含读数却当着长期条
  ins.run('di:b', '决定', '当前先按 A 方案走', old, 'ephemeral', 0, 0, '');               // ② 当次档够老
  ins.run('di:c', '决定', '记忆加载策略:三层记忆', old, 'long', 0, 0, '');                 // ③ 从没被加固过
  ins.run('di:d', '关系', '两人约定:发布永远放最后一步', new Date().toISOString(), 'durable', 5, 0, ''); // 负对照
  ins.run('di:e', '决定', '已被取代的旧条', old, 'long', 0, 0, 'di:zzz');                 // 负对照:退役的
  const rv = M.reviewPlan(db);
  eq(rv.total, 4, '只数在役(退役那条不进任何桶)');
  eq(rv.counts.staleRisk, 1, '① 含时间锚却当着长期条 = 1');
  eq(rv.staleRisk[0].id, 'di:a', '① 命中的正是那一条');
  eq(rv.counts.expired, 1, '② 当次档够老(≥' + M.EPHEMERAL_TTL_DAYS + ' 天) = 1');
  eq(rv.counts.neverUsed, 2, '③ 从没被加固过 + 够老 = 2');
  check(rv.neverUsed.every((x) => x.hit === 0), '③ 的每一条 hit 都是 0');
  eq(rv.byDurability.ephemeral, 1, '总账按硬度分档');
  eq(M.ageDays('不是日期'), null, '★日期解析不出就返回 null —— 不当 0(当 0 会让它永远进不了复查)');
  db.close();
}

section('14) 重复跑预算闸(2026-10-15 实测事故:连跑两遍 --commit 落成 80 条)');
{
  //  事故经过:第二遍 `--commit` 印的是「新写入 40 | 幂等命中 0」——
  //  去重只保证"同一句话不落两次",而选取取的是**库里还没有的候选** ⇒ 它落的是第 41~80 名。
  //  ⇒ `≤40 条`是**全趟总预算**,`collect` 必须自己扣掉本 origin 已落条数。
  const { DatabaseSync } = await import('node:sqlite');
  const mk = () => {
    const db2 = new DatabaseSync(':memory:');
    db2.exec("CREATE TABLE deep_item (id TEXT PRIMARY KEY, kind TEXT, text TEXT, at TEXT, conv_id TEXT,"
      + " seq_from INT, seq_to INT, src TEXT, origin TEXT, durability TEXT NOT NULL DEFAULT 'long',"
      + " hit_count INT DEFAULT 0, pinned INT DEFAULT 0, superseded_by TEXT DEFAULT '',"
      + " branch_id TEXT DEFAULT '', updated_at TEXT)");
    return db2;
  };
  const db0 = mk();
  eq(M.remainingBudget(db0).budget, M.FIRST_PASS_LIMIT, '空库 ⇒ 预算 = 限量');
  const ins0 = db0.prepare('INSERT INTO deep_item (id,text,origin) VALUES (?,?,?)');
  for (let i = 0; i < M.FIRST_PASS_LIMIT - 2; i++) ins0.run('di:x' + i, '占位 ' + i, M.ORIGIN);
  const b1 = M.remainingBudget(db0);
  eq(b1.alreadyImported, M.FIRST_PASS_LIMIT - 2, '已落条数按 origin 数');
  eq(b1.budget, 2, '预算 = 限量 − 已落 = 2');
  const rootDir2 = join(root, '..');
  if (existsSync(join(rootDir2, 'plans', 'spec-extract', '0-合并索引.md'))) {
    const rep2 = M.collect({ root: rootDir2, db: db0 });
    eq(rep2.selected.length, 2, '★只剩 2 条预算 ⇒ 只准选 2 条(不许"每次都能落 40"再落一趟)');
    eq(rep2.overLimit.length > 0, true, '其余全部留第二趟(不静默丢)');
    const db1 = mk();
    const ins1 = db1.prepare('INSERT INTO deep_item (id,text,origin) VALUES (?,?,?)');
    for (let i = 0; i < M.FIRST_PASS_LIMIT; i++) ins1.run('di:y' + i, '占位 ' + i, M.ORIGIN);
    eq(M.remainingBudget(db1).budget, 0, '已落 = 限量 ⇒ 预算 0');
    eq(M.collect({ root: rootDir2, db: db1 }).selected.length, 0, '★预算 0 ⇒ 一条都不选(CLI 侧据此拒绝 --commit)');
    db1.close();
  } else {
    console.log('  (跳过:本机没有 plans/spec-extract/0-合并索引.md)');
  }
  db0.close();
}

console.log(ok ? '✓ deep-import-docs 全部通过' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
