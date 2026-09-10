// dsh-ling host — 定型锁承诺句(纯函数,无平台依赖,可单测)。
// 语义(2026-09-07 用户拍板):锁不防读取,只造庄重。
//   - 「钥匙」= 上锁时用户亲手写下的一句有意义的承诺(≥10 字);
//   - 明文存储(sealPhrase),解锁界面会回显这句,永不因遗忘卡死;
//   - 仪式感来源:解锁/保存/撤锁必须亲手把这句话敲一遍(输入框禁粘贴);
//   - 上锁(sealed false→true)必须带新承诺句 → 覆盖旧句;
//   - 兼容迁移:sealed=true 但 sealPhrase 为空(旧哈希时代数据)→ 解锁框输入的首句即被采纳。
export const KEY_MIN = 10;

export function sealOk(p, unlock) {
  // 返回 { pass:boolean, adoptKey?:string|null } — adoptKey 非空表示这句将被采纳存储
  const v = typeof unlock === 'string' ? unlock.trim() : '';
  if (!p || p.sealed !== true) return { pass: true, adoptKey: null };
  if (!v || v.length < KEY_MIN) return { pass: false, adoptKey: null };
  if (!p.sealPhrase) return { pass: true, adoptKey: v }; // 旧档案无明文:首句即设钥
  return { pass: p.sealPhrase === v, adoptKey: null };
}
