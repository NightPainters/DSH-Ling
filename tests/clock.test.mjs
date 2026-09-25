// 被动时间锚 + 模式固化(修法 A)单元测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { timeAnchor, timeAnchorDate, timeAnchorLive, festivalToday, periodOf, formatGap, FESTIVALS } = await imp('lib/host/clock.js');
const { currentMode } = await imp('lib/host/mode.js');
const { SettingsFile } = await imp('lib/host/settings-file.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-clock-'));
const mem = new MemoryStore(join(dir, 'm.db'));
const settings = new SettingsFile(join(dir, 'set'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 1) 时段/间隔/纪念日基础
check(periodOf(3) === '深夜' && periodOf(9) === '上午' && periodOf(15) === '下午' && periodOf(21) === '夜里' && periodOf(0) === '深夜', '时段划分');
check(formatGap(30 * 1000) === '刚刚', '间隔:刚刚');
check(formatGap(30 * 60000) === '30 分钟前', '间隔:分钟');
check(formatGap(5 * 3600e3) === '5 小时前', '间隔:小时');
check(formatGap(3 * 864e5) === '3 天前', '间隔:天');
const fest907 = festivalToday({ dates: [] }, new Date(2026, 8, 7, 10, 0));
check(fest907 && fest907.label.includes('新生纪念日') && fest907.greeting === 'HELLO PARTNER', '内置 9-07 纪念日命中');
check(festivalToday({ dates: [] }, new Date(2026, 8, 8, 10, 0)) === null, '非纪念日不命中');
check(festivalToday({ dates: [{ m: 5, d: 20, label: '自定义日' }] }, new Date(2026, 4, 20, 0, 0)).label === '自定义日', '自定义纪念日命中');
check(FESTIVALS.length >= 1, '内置纪念日存在');

// 2) 时间锚文本(2026-09-23 拆分后):system 侧=日期+星期+纪念日;context 侧=时段+间隔
mem.appendRawTurn('s-x', { seq: 1, role: 'user', ts: new Date(2026, 8, 7, 20, 33).toISOString(), model: null, text: '在吗' });
const dA = timeAnchorDate(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
const lA = timeAnchorLive(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
check(dA.includes('[今天] 2026-09-07 周一'), 'system 侧日期行: ' + dA.split('\n')[0]);
check(lA.includes('夜里'), 'context 侧时段: ' + lA);
check(lA.includes('距上次对话:刚刚'), '未设称呼时用中性措辞: ' + lA);
check(dA.includes('开场第一句先说:HELLO PARTNER'), '纪念日触发问候(一天变一次,放 system 侧)');
const dB = timeAnchorDate(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
const lB = timeAnchorLive(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(!dB.includes('HELLO PARTNER'), '非纪念日不带问候');
check(lB.includes('距上次对话:'), '仍含间隔信息');

// 2b) 称呼跟随用户设定(不硬编码):userTitle='张明/明明' → 生活模式称昵称,工作模式称正式名
await settings.update({ persona: { userTitle: '张明/明明' }, mode: { lastMode: 'life' } });
const liveLife = timeAnchorLive(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(liveLife.includes('距上次与明明对话:'), '生活模式用昵称(尾段)');
await settings.update({ mode: { lastMode: 'work' } });
const liveWork = timeAnchorLive(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(liveWork.includes('距上次与张明对话:'), '工作模式用正式名(首段)');
// 单名两模式同称;纪念日问候也带称呼(称呼两侧都跟随)
await settings.update({ persona: { userTitle: '老板' }, mode: { lastMode: 'life' } });
const liveBoss = timeAnchorLive(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
const dateBoss = timeAnchorDate(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
check(liveBoss.includes('距上次与老板对话:'), '单名两模式同称');
check(dateBoss.includes('开场第一句先对老板说:HELLO PARTNER'), '纪念日问候带称呼: ' + dateBoss.split('\n').pop());
await settings.update({ persona: { userTitle: '' } });

// 3) 修法 A:空会话跟随当前默认;有内容的会话保留自己的模式
check(currentMode(mem, settings, 'empty-shell') === 'life', '空会话(无 meta)跟随默认 life');
mem.setSessionMode('has-msg', 'work');
mem.appendRawTurn('has-msg', { seq: 1, role: 'user', ts: null, model: null, text: '干活' });
check(currentMode(mem, settings, 'has-msg') === 'work', '有内容会话保留自己的模式');
mem.setSessionMode('shell2', 'life');
check(mem.hasUserTurns('shell2') === false, '空壳判定:无真人轮次');
mem.clearSessionMode('shell2');
check(currentMode(mem, settings, 'shell2') === 'life' && mem.sessionMeta('shell2').mode === null, 'clearSessionMode 后回到跟随默认');
await settings.update({ mode: { lastMode: 'work' } });
check(currentMode(mem, settings, 'shell2') === 'work', '默认切到 work 后,空会话随即跟随');

// 4) lastUserTurnAt 只取真人
check(String(mem.lastUserTurnAt()).startsWith('2026-09-07'), 'lastUserTurnAt 取最近真人轮次');

// 5) 【病灶门】时间锚跨分钟字节恒稳(2026-09-23 搬迁)
//    system 侧必须跨分钟逐字节相同,否则每个模型步组装都会让会话前缀整体失效
//    (实测:回合内断裂 174 次 = 未缓存 token 43.96%,全项目最大单点)。
//    T1/T2 **刻意跨分钟**(差 3 分钟):同一分钟内取样会假绿。
const T1 = new Date(2026, 8, 7, 21, 3);
const T2 = new Date(2026, 8, 7, 21, 6);
check(typeof timeAnchorDate === 'function', 'clock.js 导出 timeAnchorDate(system 侧)');
check(typeof timeAnchorLive === 'function', 'clock.js 导出 timeAnchorLive(context 侧)');
if (typeof timeAnchorDate === 'function') {
  const d1 = timeAnchorDate(mem, settings, { now: T1 });
  const d2 = timeAnchorDate(mem, settings, { now: T2 });
  check(d1 === d2, 'system 侧跨分钟字节恒稳(前缀缓存友好): ' + JSON.stringify(d1));
  check(!/\d{1,2}:\d{2}/.test(d1), 'system 侧不含时分: ' + JSON.stringify(d1));
  check(d1.includes('2026-09-07') && d1.includes('周一'), 'system 侧含日期与星期');
  check(!d1.includes('夜里') && !d1.includes('距上次'), 'system 侧不含时段与间隔(已移出)');
}
if (typeof timeAnchorLive === 'function') {
  const l1 = timeAnchorLive(mem, settings, { now: T1 });
  check(l1.includes('夜里'), 'context 侧含时段: ' + JSON.stringify(l1));
  check(l1.includes('距上次'), 'context 侧含间隔: ' + JSON.stringify(l1));
  check(!/\d{1,2}:\d{2}/.test(l1), 'context 侧也不含时分(精度已降档)');
}

console.log(ok ? '时间锚与模式固化 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
