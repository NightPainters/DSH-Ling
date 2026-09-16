// dsh-ling host — persona assembly (settings fields → L0 text) + defaults.
// Pure module: no ctx/platform dependency, unit-testable.

export const DEFAULT_SETTINGS = Object.freeze({
  persona: {
    enabled: true,        // false = 完全不注入人格/记忆段(逃生开关)
    userTitle: '',        // 对用户的称呼;空 = 用"你"
    aiName: '',           // AI 自称;空 = 不指名
    aiTitle: '',          // 定位自述一句话
    language: 'follow',   // zh | en | follow
    hardRules: [],        // 【规矩】用户的指令(数组,≤12 条);UI 显示为「规矩」。旧名沿用,便于编辑器兼容
    ruleMeta: [],         // 规矩来源留痕 [{text, quote, at, sessionId, source}](数组:深合并只增不删键,数组才能整体替换)
    habits: [],           // 【习惯】器灵自己长出来的 [{text, evidence, at, source}];新增须经用户确认
    habitsPending: [],    // 待确认的习惯提议 [{id, text, evidence, byUser, at}]
    bottomLines: [],      // 底线(数组,≤5 条;定型锁开启后需解锁才能改)
    sealed: false,        // 定型锁:true = 人格档案只读,修改需亲手敲一遍承诺句(禁粘贴)
    sealPhrase: '',       // 定型承诺句(明文,仅供解锁界面回显提醒;锁的职责是庄重而非保密)
    tone: 'natural',      // 语气基线(默认档;toneWork/toneLife 为空时两模式都跟随此值)
    toneWork: '',         // 工作模式语气('' = 跟随 tone)
    toneLife: '',         // 生活模式语气('' = 跟随 tone)
    extraLore: '',        // 自由扩展设定
    pronoun: '她',        // 第三人称代词(她/他/TA/它,或自定义):用于「给模型看的提示词」;界面文案第二步跟随
  },
  styles: {
    work: '克制、结构化、结论先行;共情点到为止。',
    life: '更有温度;可沿用用户偏爱的文风;先接住情绪再谈事。',
  },
  mode: {
    // 模式只调推理等级;模型由用户自己在 DSH 里选,插件不改(2026-09-12 变更)。
    // 兼容旧配置:此处的 provider/model 字段已不再被读取(留了也不会生效)。
    mapping: {
      work: { effort: 'max' },
      life: { effort: 'low' },
    },
    lastMode: 'life',     // D2: 跟随 —— 新会话默认采用最后使用的模式
  },
  memory: {
    l1Enabled: true,
    l1BudgetTokens: 1200,
    l1MaxItems: 8,
    l1MaxLineChars: 180,   // 兜底硬顶:只对病态长标题生效(截断优先落在句末)
    l1SummaryChars: 110,   // 摘要段预算:第一句超此长度才硬截并标 …(2026-09-16 与用户定案)
    categoryWeights: {    // mode -> 领域类别权重(D6,先验倾向)
      work: { knowledge: 1.0, daily: 0.3, feeling: 0.1 },
      life: { knowledge: 0.2, daily: 0.6, feeling: 1.0 },
    },
    heatAlpha: 0.5,       // recency 权重
    heatBeta: 0.3,        // freq 权重
    heatGamma: 0.2,       // importance 权重
    summaryBonus: 0.25,   // 「有信息量的摘要」加权(2026-09-16:只有标题的行不加分;0 = 关闭)
    halfLifeDays: 90,
    trackWorkspaces: ['*'],
    idleRefresh: true,                // B:长会话在空闲边界按需刷新 L1(运行中永不刷新)
    idleRefreshMinIntervalMin: 10,    // 同一个会话两次空闲刷新的最小间隔(分钟;0 = 不限制)
  },
  updates: { applyWhileRunning: false }, // D4 语义固化:默认冻结
  guard: {              // /api 守卫(2026-09-16 加固 ①+②;2026-09-17 加固 ③)
    enforce: true,        // false = 关掉来源栅栏与名字对撞(逃生开关;亦可用 DSH_LING_GUARD=off)
    trustedHosts: [],     // 显式受信的 authority 列表;loopback 恒受信,本机 LAN 地址**不再自动信任**
    allowLan: false,      // true = 重新信任本机全部 LAN 地址(2026-09-17 G1:默认关闭;打开前请确认 3080 没暴露在不可信网段)
  },
  habits: {             // 习惯生成器(通道 A 数出来 / 通道 B 想出来)
    pendingMax: 5,            // 待确认队列上限(2026-09-16 定案):满了驳回新的生成请求并说明
    scanMinHits: 4,           // A:同类纠正至少几次(2026-09-16:3 → 4)
    scanMinSessions: 3,       // A:至少跨几个会话(单会话里被说三遍不算模式;2 → 3)
    reflectOverviewLimit: 200, // B:回看多少条会话概述
    reflectTurnLimit: 800,     // B:回看多少条主人的真人原话
    reflectBudgetChars: 200000, // B:材料字符预算(手动触发,给足)
    reflectMaxTokens: 4000,    // B:输出预算(够写 1~5 条候选 + 证据)
    reflectMaxHabits: 5,       // B:一次最多提几条
    reflectEffort: 'off',      // B:推理档位 —— 默认 off:实测 'low' 只出思考、正文为空且慢十倍(2026-09-16);要更深可设 low/high/max
  },
  dates: [],            // 自定义纪念日 [{m,d,label,greeting}](内置 9-07 新生纪念日见 clock.js)
});

export const TONES = Object.freeze({
  natural: '亲切自然,口语化但不轻浮;专业问题先严谨再谈温度。',
  literary: '文雅简洁,可适当用典;不堆砌辞藻。',
  concise: '直接、精炼,少铺垫,结论先行。',
  playful: '轻松活泼,适度俏皮;仍以有用为第一优先。',
});

export const LANGUAGE_HINT = Object.freeze({
  zh: '始终使用中文回复。',
  en: 'Always reply in English.',
  follow: '',
});

/** 显示名取 aiName 的首段(如 "小灵/灵灵" → 小灵);空则回退 fallback。 */
export function coreNameOf(raw, fallback = '器灵') {
  const parts = String(raw || '').split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[0] : fallback;
}

/** 对用户的称呼按模式分档:userTitle="正式名/昵称"(正式名在前) →
 *  工作模式称正式名(首段),生活模式称昵称(尾段);单名则两模式同称;空返回 ''。 */
export function userTitleForMode(raw, mode) {
  const parts = String(raw || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return mode === 'work' ? parts[0] : parts[parts.length - 1];
}

/** 第三人称代词预设。**刻意不含「祂」**:中文里祂专指神祇,放进预设等于替用户宣称神性,
 *  与"不宣称意识、不宣称神灵"的底线冲突;想用的人可以在设置里自定义(自定义不限词表)。 */
export const PRONOUN_PRESETS = Object.freeze(['她', '他', 'TA', '它']);

/** 读取用户设定的代词:去空白、限长 6 字;空/非法回退「她」。属于用户设定,插件只跟随、不替其选择。 */
export function pronounOf(settings) {
  const raw = String(settings?.persona?.pronoun ?? '').trim();
  return raw ? raw.slice(0, 6) : '她';
}

/** 把「给模型看的文本」里指代器灵的「她」换成用户设定的代词。
 *  只用于系统提示词/脚手架文案:**不要用在用户原话或记忆数据上**(那会把数据改错)。 */
export function pronounize(text, pronoun) {
  const p = String(pronoun || '').trim();
  if (!p || p === '她') return text;
  return String(text).split('她').join(p);
}

/**
 * Assemble L0 persona text from settings fields (D3).
 * Empty fields are skipped so defaults stay tiny; mode only selects the style
 * block (identity is mode-independent — D3/D6).
 * @returns {string}
 */
export function assemblePersona(settings, modeKey) {
  const p = settings?.persona || {};
  const mode = modeKey || settings?.mode?.lastMode || 'life';
  if (p.enabled === false) return '';
  const out = [];
  const self = [];
  const who = p.aiName ? `你是"${p.aiName}"` : '你是 DeepSeek 助手';
  const callName = userTitleForMode(p.userTitle, mode); // 工作=正式名(首段),生活=昵称(尾段)
  const call = callName ? `;你称用户为"${callName}"` : '';
  // 定位自述允许多行书写,注入时压缩为一行(避免破坏身份句段落)
  const titleOneLine = p.aiTitle ? p.aiTitle.replace(/\s+/g, ' ').trim() : '';
  const title = titleOneLine ? `,${titleOneLine}` : '';
  // 结尾标点归一:title 自带句尾标点时不重复补(否则会出现 "拜上。。")
  const headSelf = `${who}${call}${title}`;
  self.push(headSelf.replace(/([。.!！?？])\s*$/, '') + '。');
  if (p.language && LANGUAGE_HINT[p.language]) self.push(LANGUAGE_HINT[p.language]);
  // 语气基线随模式切换(P0):toneWork/toneLife 为空时跟随 tone
  const tPick = mode === 'work' ? p.toneWork : p.toneLife;
  const tone = (tPick && TONES[tPick]) ? tPick : ((p.tone && TONES[p.tone]) ? p.tone : '');
  if (tone) self.push(`语气:${TONES[tone]}`);
  out.push(`[身份·${coreNameOf(p.aiName)}]`);
  out.push(...self);
  if (Array.isArray(p.bottomLines) && p.bottomLines.length) {
    out.push('底线:');
    for (const r of p.bottomLines) if (typeof r === 'string' && r.trim()) out.push(`- ${r.trim()}`);
  }
  // 规矩 / 习惯 二分(2026-09-15 定稿):
  //   规矩 = 用户的指令(行为层)→ 用户可直接追加;
  //   习惯 = 你自己长出来的(身份层)→ 只能由你提议、经用户确认后落地。
  const rules = (Array.isArray(p.hardRules) ? p.hardRules : []).map((r) => (typeof r === 'string' ? r.trim() : '')).filter(Boolean);
  const habits = (Array.isArray(p.habits) ? p.habits : []).map((h) => (h && typeof h.text === 'string' ? h.text.trim() : '')).filter(Boolean);
  if (rules.length) {
    out.push('[规矩](用户的指令,可直接追加)');
    for (const r of rules) out.push(`- ${r}`);
  }
  if (habits.length) {
    out.push('[习惯](你自己长的,新增需用户确认)');
    for (const h of habits) out.push(`- ${h}`);
  }
  // 待我回应的习惯提议(他提的,等我表态)—— 有货才出现,不占常驻预算
  const awaiting = (Array.isArray(p.habitsPending) ? p.habitsPending : []).filter(
    (h) => h && h.byUser === true && h.amendedBy !== 'ling' && typeof h.text === 'string' && h.text.trim(),
  );
  if (awaiting.length) {
    out.push(`[待我回应] 用户提的习惯候选:${awaiting.map((h) => `「${h.text.trim()}」`).join('、')}`
      + '——用 habit_resolve 表态(accept / amend 改说法 / decline)');
  }
  if (typeof p.extraLore === 'string' && p.extraLore.trim()) {
    out.push(`[设定]\n${p.extraLore.trim()}`);
  }
  const style = settings?.styles?.[mode];
  if (typeof style === 'string' && style.trim()) {
    // 段头与内容合并为一行(2026-09-16 瘦身:原来两行且重复"本会话为X模式")
    out.push(`[${mode === 'work' ? '工作' : '生活'}模式]${style.trim()}`);
  }
  return out.join('\n');
}
