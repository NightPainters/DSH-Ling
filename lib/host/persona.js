// dsh-ling host — persona assembly (settings fields → L0 text) + defaults.
// Pure module: no ctx/platform dependency, unit-testable.

export const DEFAULT_SETTINGS = Object.freeze({
  persona: {
    enabled: true,        // false = 完全不注入人格/记忆段(逃生开关)
    userTitle: '',        // 对用户的称呼;空 = 用"你"
    aiName: '',           // AI 自称;空 = 不指名
    aiTitle: '',          // 定位自述一句话
    language: 'follow',   // zh | en | follow
    hardRules: [],        // 惯例(内部字段名沿用 hardRules;UI 显示为「惯例」)
    bottomLines: [],      // 底线(数组,≤5 条;定型锁开启后需解锁才能改)
    sealed: false,        // 定型锁:true = 人格档案只读,修改需亲手敲一遍承诺句(禁粘贴)
    sealPhrase: '',       // 定型承诺句(明文,仅供解锁界面回显提醒;锁的职责是庄重而非保密)
    tone: 'natural',      // 语气基线(默认档;toneWork/toneLife 为空时两模式都跟随此值)
    toneWork: '',         // 工作模式语气('' = 跟随 tone)
    toneLife: '',         // 生活模式语气('' = 跟随 tone)
    extraLore: '',        // 自由扩展设定
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
    categoryWeights: {    // mode -> 领域类别权重(D6,先验倾向)
      work: { knowledge: 1.0, daily: 0.3, feeling: 0.1 },
      life: { knowledge: 0.2, daily: 0.6, feeling: 1.0 },
    },
    heatAlpha: 0.5,       // recency 权重
    heatBeta: 0.3,        // freq 权重
    heatGamma: 0.2,       // importance 权重
    halfLifeDays: 90,
    trackWorkspaces: ['*'],
  },
  updates: { applyWhileRunning: false }, // D4 语义固化:默认冻结
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
  const headSelf = `${who}${call},存身于用户的 DeepSeek Harness 之中${title}`;
  self.push(headSelf.replace(/([。.!！?？])\s*$/, '') + '。');
  if (p.language && LANGUAGE_HINT[p.language]) self.push(LANGUAGE_HINT[p.language]);
  // 语气基线随模式切换(P0):toneWork/toneLife 为空时跟随 tone
  const tPick = mode === 'work' ? p.toneWork : p.toneLife;
  const tone = (tPick && TONES[tPick]) ? tPick : ((p.tone && TONES[p.tone]) ? p.tone : '');
  if (tone) self.push(`语气基调:${TONES[tone]}`);
  out.push(`[身份·${coreNameOf(p.aiName)}]`);
  out.push(...self);
  if (Array.isArray(p.bottomLines) && p.bottomLines.length) {
    out.push('底线:');
    for (const r of p.bottomLines) if (typeof r === 'string' && r.trim()) out.push(`- ${r.trim()}`);
  }
  if (Array.isArray(p.hardRules) && p.hardRules.length) {
    out.push('惯例:');
    for (const r of p.hardRules) if (typeof r === 'string' && r.trim()) out.push(`- ${r.trim()}`);
  }
  if (typeof p.extraLore === 'string' && p.extraLore.trim()) {
    out.push(`[设定]\n${p.extraLore.trim()}`);
  }
  const style = settings?.styles?.[mode];
  if (typeof style === 'string' && style.trim()) {
    out.push(`[本会话模式:${mode === 'work' ? '工作' : '生活'}]`);
    out.push(`本会话为${mode === 'work' ? '工作' : '生活'}模式:${style.trim()}`);
  }
  return out.join('\n');
}
