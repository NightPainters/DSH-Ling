// dsh-ling host — 记忆树操作的**唯一实现**(Part G G1,2026-09-25)。
//
// 为什么要有这个文件:
//   Part G 任务书点出的洞 ——「记忆树的写操作,一条 agent 侧工具都没有。我得靠伪造成本机
//   进程的身份走 UI 的 HTTP 口,或者直接开库」。根因不是"缺工具",而是**逻辑焊在 HTTP
//   handler 里**:`api.js` 的 26 处树端点各自内联校验 + 调 memory + 写留痕,没有任何可复用
//   的内部函数 ⇒ 工具通道无处落脚,只能重写一遍(那就成了两套会各自漂移的实现)。
//
// 本模块的契约:
//   1. **一个操作一个函数**,签名统一 `(memory, args) => result`,result 至少含 `ok`。
//      失败时含 `reason`(短英文码,给界面/模型分支用);成功时含该操作的自然结果字段。
//   2. **`result.status` 是权威 HTTP 状态码** —— 由这里决定,`api.js` 只负责照发。
//      这样"哪些失败算 400"这件事只有一处定义,不会出现两条通道判定不一致。
//   3. **留痕一律经 `memory.logBranch(..., { actor })`** —— `actor` 由调用方给
//      (`'user'` 界面 / `'ling'` 器灵工具),G4 之前它恒为人,器灵改的树只能记在主人名下。
//   4. 本模块**不碰 HTTP**(不 import req/res/readBody),也**不碰模型** —— 纯逻辑,
//      便于单测,也便于工具通道直接调。
//
// 零行为变更:本文件的内容逐条搬自 `api.js` 原有 handler 的内联逻辑,搬动时**不改判定**,
//   只把 `sendJson(res, X, Y)` 换成 `return { ...Y, status: X }`。

import { TRUNK_ID } from './memory.js';

/** 枝列表 → id 索引 Map(原 `api.js:62` 的私有助手,搬来共用)。 */
export const mapBranchList = (list) => new Map((Array.isArray(list) ? list : []).map((b) => [String(b.id), b]));

/** 会话/条目存在性(审计 B#11):`conv_overview` 或 `session_meta` 里找得到才算真条目。
 *  ⚠️ `memory.sessionMeta()` 对未知会话会回一份**默认对象**(不是 null),不能当存在性判据
 *  —— 故 session_meta 侧走 `sessionBranchMap()`(真行才有键)。 */
export function convExistsIn(memory, source, convId) {
  const src = String(source || '');
  const cid = String(convId || '');
  if (!src || !cid) return false;
  try {
    if (memory.overviewById(src, cid)) return true;
  } catch { /* 查询失败按"找不到"处理 */ }
  if (src === 'dsh') {
    try {
      return memory.sessionBranchMap().has(cid);
    } catch { /* noop */ }
  }
  return false;
}

/** 枝存在性检查(D-T02,1.5.1 红蓝对抗 · 红队 D):`link`/`unlink` 是这一族里**唯一**
 *  没做存在性检查的两个(兄弟:`opBranchCreate` 查父、`opBranchAssign` 查枝、
 *  `opBranchRename`/`Reparent`/`Weight` 查自己)⇒ `link deadbeef ↔ cafebabe` 回 ok 且真落
 *  `vein_link` —— 悬空边要到渲染/对账时才炸,而制造它只要一次拼错的 id。
 *  返回**找不到的那些 id**(回执要把"哪一端"念出来,否则调用方只能猜)。 */
export function missingBranchesIn(memory, ids) {
  let known = new Set();
  try { known = new Set((memory.listBranches() || []).map((b) => String(b.id))); } catch { /* 查询失败按全缺处理 */ }
  return (ids || []).map((x) => String(x || '')).filter((x) => !known.has(x));
}

/** 统一失败构造(短码 + 权威状态码)。 */
const bad = (reason, status = 400, extra = {}) => ({ ok: false, reason, status, ...extra });
/** 统一成功构造(默认 200)。 */
const good = (extra = {}, status = 200) => ({ ok: true, status, ...extra });

/** 谁是这次改动的发起者 —— 只认 'ling',其余一律 'user'(与 `logBranch` 的归一化一致)。 */
const actorOf = (args) => (String(args?.actor || 'user').toLowerCase() === 'ling' ? 'ling' : 'user');

// ---------------------------------------------------------------- 读

/**
 * 读整树:枝/主脉嵌套 + 横向连边 + 计数。
 * @param deps.treeCounts 由调用方注入的计数函数(它依赖 api.js 侧的 memberCountOf 等,
 *   搬动成本高于收益 —— 保持单一实现,由 api.js 传入)。缺省时退化为"无计数"。
 */
export function opTreeRead(memory, args = {}, deps = {}) {
  const t = memory.branchTree();
  const counts = typeof deps.treeCounts === 'function' ? deps.treeCounts() : {};
  const { byBranch = {}, sessCount = {}, total = 0, memberCounts = null } = counts || {};
  const treeNode = typeof deps.treeNode === 'function' ? deps.treeNode : ((n) => n);
  return good({
    trunk: TRUNK_ID,
    total,
    memories: Number(total || 0),
    // A#6:告诉界面这次 sessions 用的是哪种口径(同一谓词 / 旧的 session_meta 计数降级)
    sessionsBasis: memberCounts ? 'members' : 'session-meta',
    roots: (t.roots || []).map((n) => treeNode(n, byBranch, sessCount)),
    links: t.links || [],
  });
}

/** 读某枝的会话级成员(R2 展开)。 */
export function opBranchMembers(memory, args = {}) {
  const id = String(args.id || TRUNK_ID);
  const limit = Number(args.limit || 300);
  const members = memory.branchMembers(id, { limit });
  return good({ id, count: members.length, members });
}

// ---------------------------------------------------------------- 建 / 删 / 挂

/** 建枝或主脉(kind='vein' 建主脉)。 */
export function opBranchCreate(memory, args = {}) {
  const kind = String(args.kind || 'branch');
  if (kind !== 'branch' && kind !== 'vein') return bad('bad-kind');
  const parentId = String(args.parentId || TRUNK_ID);
  if (!memory.listBranches().some((b) => b.id === parentId)) return bad('no-parent');
  const name = String(args.name || '').trim().slice(0, 80);
  // 审计 B#4:空名枝会成为树里一个点不开的幽灵节点;旧版**没有任何删枝端点**,建错了只能改库。
  if (!name) return bad('empty-name');
  const id = kind === 'vein'
    ? memory.createVein({ name, parentId })
    : memory.createBranch({ name, kind: 'branch', parentId });
  return good({ id, kind, name, parentId });
}

/** 删枝:trunk 不可删;非空枝(有子枝/归属/连边)默认拒绝并回报影响面,force 才动手。 */
export function opBranchDelete(memory, args = {}) {
  const r = memory.deleteBranch(String(args.id || ''), { force: args.force === true });
  if (r.ok) {
    memory.logBranch(TRUNK_ID, 'delete', {
      after: String(r.name || args.id || ''),
      note: '删枝' + (args.force ? '(force)' : ''),
      actor: actorOf(args),
    });
  }
  return { ...r, status: r.ok ? 200 : 400 };
}

/** 并脉:把枝挂到主脉下(内容零变化)。新主脉可当场建(name 非空且 parentId 尚不存在时先建 vein)。 */
export function opBranchReparent(memory, args = {}) {
  const id = String(args.id || '');
  if (!id) return bad('bad-id');
  let parentId = String(args.parentId || '');
  if (parentId && !memory.listBranches().some((b) => b.id === parentId)) {
    if (String(args.createVein || '') === '1' || args.name) {
      parentId = memory.createVein({
        name: String(args.name || '新主脉').slice(0, 80),
        parentId: String(args.veinParent || TRUNK_ID),
      });
    } else {
      return bad('no-parent');
    }
  }
  // D-T06(1.5.1 红蓝对抗 · 红队 D):缺 parentId 时旧代码把 `''` 一路带下去 ——
  // `memory.reparentBranch` 内部把 `''` 兜成主干(所以界面通道行为不变),但**留痕记的是 `''`**
  // ⇒ digest 渲染成「挪到了「?」下」,注入面看不出挪去了哪里。
  // 这里显式解析成真父:**留痕必须记实际发生的事**(工具通道另在 checkBranchEdit 里直接拒绝缺参)。
  if (!parentId) parentId = TRUNK_ID;
  const beforeRow = memory.listBranches().find((b) => b.id === id) || null;
  // 审计 B#3:id 不存在时 UPDATE 命中 0 行仍回 ok:true ⇒ 这里先挡(不写留痕)
  if (!beforeRow) return bad('no-match');
  const r = memory.reparentBranch(id, parentId);
  if (r.ok) {
    memory.logBranch(id, 'reparent', {
      before: (beforeRow && beforeRow.parentId) || '',
      after: String(parentId || ''),
      note: String(args.note || ''),
      actor: actorOf(args),
    });
  }
  return { ...r, status: r.ok ? 200 : 400 };
}

/** 改枝名(lock 默认 true ⇒ 起名即定名,机器不再覆盖)。 */
export function opBranchRename(memory, args = {}) {
  const name = String(args.name || '').trim().slice(0, 80);
  if (!name) return bad('empty-name');
  const id = String(args.id || '');
  const beforeRow = memory.listBranches().find((b) => b.id === id) || null;
  if (!beforeRow) return bad('no-match'); // 审计 B#3
  const r = memory.renameBranch(id, name, { lock: args.lock !== false });
  if (r.ok) {
    memory.logBranch(id, 'rename', {
      before: (beforeRow && beforeRow.name) || '',
      after: name,
      note: String(args.note || ''),
      actor: actorOf(args),
    });
  }
  return { ...r, status: r.ok ? 200 : 400 };
}

/** 调枝系数(设计稿 §3.3:权重**仅复盘时**修改 —— 平时只读,由工具层的策略把关)。 */
export function opBranchWeight(memory, args = {}) {
  const id = String(args.id || '');
  const beforeRow = memory.listBranches().find((b) => b.id === id) || null;
  if (!beforeRow) return bad('no-match'); // 审计 B#3
  const r = memory.setBranchWeight(id, args.weightScale);
  if (!r.ok) return { ...r, status: 400 };
  // D-T03(1.5.1 红蓝对抗,加强):回执与留痕里的数字必须来自**库**,不能来自"我以为写了多少" ——
  // `setBranchWeight` 的返回值是它**自己算出来的**夹取值(`UPDATE ... WHERE id=?` 命中 0 行它照样回 ok)。
  // 这里写后读回一次,以后的每一处消费都以读回值为准;读不回来(行没了)时如实用 null 表示,
  // 绝不拿"计算值"冒充"落库值"。 */
  const afterRow = memory.listBranches().find((b) => b.id === id) || null;
  const stored = afterRow ? Number(afterRow.weightScale) : null;
  const wrote = Number.isFinite(stored) ? stored : r.weightScale;
  memory.logBranch(id, 'weight', {
    before: String((beforeRow && beforeRow.weightScale) ?? ''),
    after: String(wrote),
    note: String(args.note || ''),
    actor: actorOf(args),
  });
  return { ...r, weightScale: wrote, stored, status: 200 };
}

// ---------------------------------------------------------------- 连边

/** 主脉间连边(横向关系,不影响归属)。 */
export function opVeinLink(memory, args = {}) {
  const from = String(args.from || '');
  const to = String(args.to || '');
  // 缺参与"两端相同"是**参数问题**(bad-arg),与"id 不存在"(no-match)分开报 —— 两件事。
  if (!from || !to) return bad('bad-arg', 400, { hint: '连边要给出两端 id(from / to)' });
  if (from === to) return bad('bad-arg', 400, { hint: '两端相同 —— 一条边连不上自己' });
  // D-T02:两端都必须是树里真有的枝 —— 这里是"悬空边"唯一的产生口,必须挡在写之前。
  // (只挡 here,不改 memory.linkVeins 的签名:错要错得一致,但闸要立在写入侧。)
  const missing = missingBranchesIn(memory, [from, to]);
  if (missing.length) {
    return bad('no-match', 400, {
      missing, from, to, hint: '连边两端都必须是树里真实存在的枝:拒绝落悬空边',
    });
  }
  const r = memory.linkVeins(from, to, {
    kind: String(args.kind || 'related'),
    note: String(args.note || '').slice(0, 300),
  });
  if (r.ok) {
    memory.logBranch(from, 'link', {
      before: '', after: to, note: String(args.kind || 'related'), actor: actorOf(args),
    });
  }
  return { ...r, status: r.ok ? 200 : 400 };
}

/** 断边。 */
export function opVeinUnlink(memory, args = {}) {
  const from = String(args.from || '');
  const to = String(args.to || '');
  if (!from || !to) return bad('bad-arg', 400, { hint: '断边要给出两端 id(from / to)' });
  if (from === to) return bad('bad-arg', 400, { hint: '两端相同 —— 不存在这样的边' });
  // D-T02(有意与 link 不同):**不用存在性拒绝**。库里可能本来就躺着悬空边(1.5.0 造的),
  // 而 unlink 是清掉它**唯一**的通道 —— 若以"两端必须存在"为由拒绝,悬空边就永远删不掉了。
  // 所以这里:① 边本身不存在 → no-match(原有闸,防假留痕);② 边在、但某端已不在树里 →
  // 照删,把 `dangling` 如实回传(回执说"清掉的是一条悬空边",不再假装两端都在)。
  const dangling = missingBranchesIn(memory, [from, to]);
  const r = memory.unlinkVein(from, to);
  // 审计 B#3:边不存在时 DELETE 命中 0 行 —— 旧版照样回 ok:true 并留痕「断开了边」(假留痕)
  if (r.ok && !(Number(r.removed) > 0)) return bad('no-match', 400, { removed: 0, missing: dangling });
  if (r.ok) {
    memory.logBranch(from, 'unlink', {
      before: to, after: '',
      note: dangling.length ? '断开一条悬空边(一端已不在树里:' + dangling.join(',') + ')' : '',
      actor: actorOf(args),
    });
  }
  return { ...r, status: r.ok ? 200 : 400, dangling };
}

// ---------------------------------------------------------------- 归属

/** 把一条会话/条目挪到某枝(拖动,R2/R3)。 */
export function opAssignConv(memory, args = {}) {
  // ⚠️ 审计 B#11:此前接受**任意** branchId / convId ⇒ "幽灵行"真落库(覆盖层里指向一条
  //   不存在的枝 / 一个不存在的条目),表现为界面出现"名字 = 裸 UUID"的枝。
  //   写入侧两侧都挡(读取侧另在 branchCounts 对账):
  //   ① 枝必须存在(trunk 恒在);② 条目必须能在 conv_overview 或 session_meta 里找到。
  const bid = String(args.branchId || TRUNK_ID);
  if (bid !== TRUNK_ID && !mapBranchList(memory.listBranches()).has(bid)) return bad('no-branch');
  const src = String(args.source || '');
  const cid = String(args.convId || '');
  if (!src || !cid) return bad('bad-arg');
  if (!convExistsIn(memory, src, cid)) {
    return bad('no-conv', 400, { hint: '该条目不在 conv_overview / session_meta 里:拒绝落幽灵行' });
  }
  const r = memory.assignConv(src, cid, bid);
  if (r.ok) {
    memory.logBranch(bid, 'assign', {
      before: String(r.prev || ''),
      after: src + '/' + cid,
      note: '把一条' + (src === 'dsh' ? '会话' : '历史条目') + '挪到本枝',
      actor: actorOf(args),
    });
  }
  return { ...r, status: 200 }; // 原 handler 成功与否都回 200(失败走上面的早返回)
}

// ---------------------------------------------------------------- 矛盾

/** 裁定一对矛盾(复盘环节:确认哪条作数 / 驳回)。**只改权重与状态,不改内容**。 */
export function opConflictResolve(memory, args = {}) {
  const r = memory.resolveConflict(String(args.id || ''), {
    winner: args.winner ?? null,
    status: String(args.status || 'confirmed'),
  });
  return { ...r, status: r.ok ? 200 : 400 };
}

// ---------------------------------------------------------------- 快照

/** 存一份树快照(超上限时先裁掉最旧的一份**非自动**快照 —— 自动备份是撤回路径,不裁)。 */
export function opSnapshotTree(memory, args = {}, deps = {}) {
  const max = Number(deps.maxSnapshots || 0);
  if (max > 0) {
    try {
      const all = memory.listTreeSnapshots({ limit: 200 });
      if (all.length >= max) {
        // 列表按 id 倒序 → 从末位(最旧)往前找第一条可裁的
        const victim = [...all].reverse().find((s) => s && s.id && String(s.kind || 'manual') !== 'auto');
        // 传改过签名的 deleteTreeSnapshot(id, {force}) 一个参数是安全的;软链未落地时它读不到 force
        // (undefined → 默认 false,保护默认开启)⇒ 绝不强删
        if (victim) memory.deleteTreeSnapshot(victim.id);
      }
    } catch { /* 上限清理失败不该挡住保存 */ }
  }
  const r = memory.snapshotTree({ name: args.name, note: args.note });
  if (r.ok) {
    memory.logBranch(TRUNK_ID, 'snapshot', {
      after: String(args.name || ('#' + r.id)), note: '保存树快照', actor: actorOf(args),
    });
  }
  return { ...r, status: 200 }; // 原 handler 无条件 200
}

/** 恢复树结构;恢复前**自动存一份当前状态**(由 memory.restoreTree 内部完成,返回 backupId)。 */
export function opRestoreTree(memory, args = {}) {
  const r = memory.restoreTree(args.id);
  return { ...r, status: 200 };
}

/** 删快照。 */
export function opDeleteSnapshot(memory, args = {}) {
  const r = memory.deleteTreeSnapshot(args.id);
  return { ...r, status: 200 };
}
