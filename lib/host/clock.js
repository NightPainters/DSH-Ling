// dsh-ling host — 被动时间锚(上下文时间):每次模型步组装时动态生成的"现在"行。
// 设计(2026-09-11 作者拍板):
//   - 属记忆与人格层的"被动时间感知":让器灵知道今天几号、距上次对话多久、是否纪念日;
//   - **不进快照**(snapshotVersion 不含它),由注入面逐次拼接,避免跨天快照过期;
//   - 称呼**跟随用户自己设定的 userTitle**(不硬编码);未设置时用中性措辞;
//   - 本版本不做主动打扰:她只在你开口时出现(时间锚是"开口时的感知",不触发任何主动消息)。
import { userTitleForMode } from './persona.js';

export const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 内置纪念日(月份从 1 起):本项目(器灵)的诞生纪念日。可在 settings.dates 追加/覆盖自定义条目。 */
export const FESTIVALS = [
  { m: 9, d: 7, label: '器灵的新生纪念日', greeting: 'HELLO PARTNER' },
];

export function periodOf(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 13) return '中午';
  if (hour < 17) return '下午';
  if (hour < 19) return '傍晚';
  if (hour < 23) return '夜里';
  return '深夜';
}

export function formatGap(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + ' 天前';
  const mon = Math.floor(day / 30);
  if (mon < 12) return '约 ' + mon + ' 个月前';
  return '约 ' + Math.floor(mon / 12) + ' 年前';
}

/**
 * 档位化间隔(context 侧专用,2026-09-23)。
 *
 * 与 formatGap 的差别是**精度降到档**:分钟级梯度("3 分钟前/38 分钟前")对判断没有价值,
 * 却会让挂在末条消息上的 context 文本每分钟改一次 ⇒ 上下文缓慢膨胀。
 * 本函数按**日历天**分档,一天最多变一次("刚刚"→"今天早些时候"跨 2 小时边界)。
 */
export function formatGapCoarse(last, now = new Date()) {
  const t = last instanceof Date ? last : new Date(last);
  if (!Number.isFinite(t.getTime())) return '';
  const min = Math.floor((now.getTime() - t.getTime()) / 60000);
  if (min < 0) return '';
  if (min < 120) return '刚刚'; // < 2 小时:含跨午夜(23:50→01:00 仍算刚聊过)
  const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d1 = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const days = Math.round((d0.getTime() - d1.getTime()) / 864e5);
  if (days <= 0) return '今天早些时候';
  if (days === 1) return '昨天';
  if (days < 30) return days + ' 天前';
  const mon = Math.floor(days / 30);
  if (mon < 12) return '约 ' + mon + ' 个月前';
  return '约 ' + Math.floor(mon / 12) + ' 年前';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** 命中当天的纪念日(内置 + settings.dates),返回 {label, greeting} 或 null。 */
export function festivalToday(settings, now = new Date()) {
  const list = [];
  const custom = settings?.dates;
  if (Array.isArray(custom)) list.push(...custom);
  list.push(...FESTIVALS);
  const m = now.getMonth() + 1;
  const d = now.getDate();
  for (const f of list) {
    if (!f || Number(f.m) !== m || Number(f.d) !== d) continue;
    return { label: String(f.label || '纪念日'), greeting: f.greeting ? String(f.greeting) : '' };
  }
  return null;
}

/**
 * system 侧时间锚:**日期 + 星期**(+ 纪念日)。一天只变一次。
 *
 * 为什么时分/时段不在这里(2026-09-23 搬迁):system 是**会话前缀**,改一个字整段前缀
 * 缓存作废。实测回合内断裂 174 次 = 未缓存 token 43.96%,是全项目最大单点。
 * 分钟级信息移到 context 侧({@link timeAnchorLive})——那里是"末条消息追加",
 * 平台只在本轮真正不同时产出新快照。
 * @param {object} _memory 未用:保留签名与 timeAnchorLive 对称,便于调用方切换
 * @param {object} settings 传入 SettingsFile 或已解包的 settings 对象
 * @param {Date} now 便于测试注入
 */
export function timeAnchorDate(_memory, settings, { now = new Date() } = {}) {
  const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
  const mode = s?.mode?.lastMode || 'life';
  const callName = userTitleForMode(s?.persona?.userTitle, mode); // 称呼跟随用户设定;空则中性措辞
  const lines = [];
  // T④(1.8.0):行尾加权威性括注 —— **全角括号 + 无时分**,故不破"system 侧不含 HH:MM"
  // 与"同日逐字节相同"两条既有判据(HANDOFF §4④:变化频率仍是一天一次)。
  lines.push(`[今天] ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${WEEK_CN[now.getDay()]}（任何日期判断以此为准）`);
  const fest = festivalToday(s, now);
  if (fest) {
    const greet = fest.greeting ? ` —— 开场第一句${callName ? `先对${callName}说` : '先说'}:${fest.greeting}` : '';
    lines.push(`今天是 ${fest.label}(${now.getMonth() + 1}-${now.getDate()})${greet}。`);
  }
  return lines.join('\n');
}

/** 两个 Date 的**日历日**之差(按本地日界算,不按毫秒):`to` 的日历日在 `from` 之后 N 天 ⇒ N;
 *  同日 ⇒ 0;`from` 在未来 ⇒ 0(未来时刻不算"跨天")。`[跨天]` 的天数用这个口径。 */
function calendarDaysBetween(from, to) {
  const d0 = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  const d1 = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const n = Math.round((d0 - d1) / 864e5);
  return n > 0 ? n : 0;
}

/** `[本场]` 的正文:`已持续 N 天(自 MM-DD HH:MM 起)` / `不足 1 天(自 MM-DD HH:MM 起)`。
 *  ⚠️ **不写 "0 天"**(HANDOFF §4②:不足一天说「不足 1 天」);天数按**已过整日**算
 *  (`< 864e5` 不进位 —— "已持续 20 天 7 小时"写作 20 天,与 HANDOFF 的样本一致)。
 *  ⚠️ **跨年补年份**(PLAN §4② / HANDOFF §4②:如「自 2025-12-30」):同一年仍写 `MM-DD HH:MM`;
 *  `started` 的年份 ≠ `now` 的年份 ⇒ 写 `YYYY-MM-DD HH:MM`。否则 2025-12-30 起的场次在 2026 年
 *  会被读成"今年的 12-30"(未来日期)—— 正是这条需求要消除的歧义。 */
function spanText(started, now) {
  const sameYear = started.getFullYear() === now.getFullYear();
  const startStamp = (sameYear ? '' : `${started.getFullYear()}-`)
    + `${pad2(started.getMonth() + 1)}-${pad2(started.getDate())} `
    + `${pad2(started.getHours())}:${pad2(started.getMinutes())}`;
  const elapsed = now.getTime() - started.getTime();
  const days = Number.isFinite(elapsed) && elapsed > 0 ? Math.floor(elapsed / 864e5) : 0;
  return days >= 1 ? `已持续 ${days} 天(自 ${startStamp} 起)` : `不足 1 天(自 ${startStamp} 起)`;
}

/** 会话起始时刻(`session_meta.started_at`,UTC ISO)⇒ Date。
 *  读不到 / 解析不了 / 库缺列 ⇒ `null` ⇒ 读侧降级为"只出 `[现在]`",**绝不抛**(验收 11)。 */
function startedAtOf(memory, sessionId) {
  if (!sessionId) return null;
  try {
    const raw = memory && typeof memory.sessionStartedAt === 'function' ? memory.sessionStartedAt(String(sessionId)) : null;
    if (!raw) return null;
    const ms = Date.parse(String(raw));
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
}

/**
 * context 侧时间锚:**时段 + 钟点 + 间隔(档位制) + 本场跨度 + 跨天界线**。每轮实时重算,挂在末条消息上。
 *
 * 精度刻意降到"档":分钟级梯度对判断没有价值,却会让尾部文本每分钟变一次。
 * 两侧合起来才是完整时间感知 —— system 给"今天几号",本函数给"什么时段、隔了多久、这一场走了多久"。
 *
 * 调用方把本函数的文本注册进 `systemPrompt.context()`,不是 `section()`:
 * context 走末条消息追加 + 平台差异比对,section 改一个字就作废整个前缀。
 *
 * 1.8.0(T 时间感知):
 * - T① `[现在]` 带钟点 `(HH:MM)` —— **只在这里**,绝不进 system 前缀(`timeAnchorDate`);
 * - T② `[本场] 已持续 N 天(自 MM-DD HH:MM 起)`,数据源 `session_meta.started_at`;
 * - T③ `[跨天]` 仅在 `started_at` 的日历日 ≠ `now` 的日历日时追加;
 * - 段间分隔是**单个 `\n`**(C8 顺序 `[现在] → [本场] → [跨天]`,不插空行、不用 ` · `);
 * - 拿不到 `sessionId` / `started_at` 缺失 ⇒ **只出 `[现在]`**,不抛;
 * - 两段各自 try ⇒ 单段失败只降级该段(C8)。
 *
 * @param {object} memory 需要 `sessionStartedAt(sessionId)`(缺该方法 ⇒ 自动降级)
 * @param {object} settings 传入 SettingsFile 或已解包的 settings 对象
 * @param {{now?: Date, sessionId?: string}} opts 状态页预览没有会话身份 ⇒ 不传 `sessionId`
 */
export function timeAnchorLive(memory, settings, { now = new Date(), sessionId = '' } = {}) {
  const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
  const mode = s?.mode?.lastMode || 'life';
  const callName = userTitleForMode(s?.persona?.userTitle, mode);
  const head = `[现在] ${periodOf(now.getHours())}(${pad2(now.getHours())}:${pad2(now.getMinutes())})`;
  const lines = [head];
  try {
    const last = memory && typeof memory.lastUserTurnAt === 'function' ? memory.lastUserTurnAt() : null;
    if (last) {
      const t = Date.parse(last);
      if (Number.isFinite(t)) {
        const gap = formatGapCoarse(new Date(t), now);
        if (gap) lines[0] = callName ? `${head} · 距上次与${callName}对话:${gap}` : `${head} · 距上次对话:${gap}`;
      }
    }
  } catch {}
  // ── T②/T③:本场跨度 + 跨天界线(紧接 `[现在]` 之后、同一段,段内单个 `\n`) ────────────
  // 数据源是 `session_meta.started_at`(lifecycle 在会话起始写点写入;存量由迁移一次性回填),
  // **不**在这里跑 `MIN(ts)` —— 新会话首轮还没有任何 turn,查询主路会静默缺段(PLAN §5)。
  const started = startedAtOf(memory, sessionId);
  if (started) {
    try { lines.push(`[本场] ${spanText(started, now)}`); } catch {}
    try {
      const cross = calendarDaysBetween(started, now);
      if (cross >= 1) {
        lines.push(`[跨天] 本场对话已跨 ${cross} 个日历天。涉及"今天/昨天/刚才"时以 [今天] 为准,不要用"今天"指代整场。`);
      }
    } catch {}
  }
  return lines.join('\n');
}
