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
 * 生成时间锚文本(每次组装实时调用)。
 * @param {{lastUserTurnAt?: () => (string|null)}} memory
 * @param {object} settings 传入 SettingsFile 或已解包的 settings 对象
 * @param {Date} now 便于测试注入
 */
export function timeAnchor(memory, settings, { now = new Date() } = {}) {
  const s = settings && typeof settings.get === 'function' ? settings.get() : (settings || {});
  const mode = s?.mode?.lastMode || 'life';
  const callName = userTitleForMode(s?.persona?.userTitle, mode); // 称呼跟随用户设定;空则中性措辞
  const lines = [];
  const week = WEEK_CN[now.getDay()];
  lines.push(`[现在] ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${week} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())} · ${periodOf(now.getHours())}`);
  try {
    const last = memory && typeof memory.lastUserTurnAt === 'function' ? memory.lastUserTurnAt() : null;
    if (last) {
      const t = Date.parse(last);
      if (Number.isFinite(t)) {
        const gap = formatGap(now.getTime() - t);
        if (gap) lines.push(callName ? `距上次与${callName}对话:${gap}` : `距上次对话:${gap}`);
      }
    }
  } catch {}
  const fest = festivalToday(s, now);
  if (fest) {
    const greet = fest.greeting ? ` —— 开场第一句${callName ? `先对${callName}说` : '先说'}:${fest.greeting}` : '';
    lines.push(`今天是 ${fest.label}(${now.getMonth() + 1}-${now.getDate()})${greet}。`);
  }
  return lines.join('\n');
}
