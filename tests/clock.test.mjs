// 被动时间锚 + 模式固化(修法 A)单元测试
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { timeAnchor, festivalToday, periodOf, formatGap, FESTIVALS } = await imp('lib/host/clock.js');
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

// 2) 时间锚文本:含日期/星期/时段;距上次对话;纪念日提示;称呼跟随 userTitle
mem.appendRawTurn('s-x', { seq: 1, role: 'user', ts: new Date(2026, 8, 7, 20, 33).toISOString(), model: null, text: '在吗' });
const anchor = timeAnchor(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
check(anchor.includes('[现在] 2026-09-07 周一 21:03 · 夜里'), '时间行格式: ' + anchor.split('\n')[0]);
check(anchor.includes('距上次对话:30 分钟前'), '未设称呼时用中性措辞: ' + anchor.split('\n')[1]);
check(anchor.includes('开场第一句先说:HELLO PARTNER'), '纪念日触发问候');
const anchor2 = timeAnchor(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(!anchor2.includes('HELLO PARTNER'), '非纪念日不带问候');
check(anchor2.includes('距上次对话:'), '仍含间隔信息');

// 2b) 称呼跟随用户设定(不硬编码):userTitle='张明/明明' → 生活模式称昵称,工作模式称正式名
await settings.update({ persona: { userTitle: '张明/明明' }, mode: { lastMode: 'life' } });
const anchorLife = timeAnchor(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(anchorLife.includes('距上次与明明对话:'), '生活模式用昵称(尾段)');
await settings.update({ mode: { lastMode: 'work' } });
const anchorWork = timeAnchor(mem, settings, { now: new Date(2026, 8, 9, 8, 5) });
check(anchorWork.includes('距上次与张明对话:'), '工作模式用正式名(首段)');
// 单名两模式同称;纪念日问候也带称呼
await settings.update({ persona: { userTitle: '老板' }, mode: { lastMode: 'life' } });
const anchorBoss = timeAnchor(mem, settings, { now: new Date(2026, 8, 7, 21, 3) });
check(anchorBoss.includes('距上次与老板对话:'), '单名两模式同称');
check(anchorBoss.includes('开场第一句先对老板说:HELLO PARTNER'), '纪念日问候带称呼: ' + anchorBoss.split('\n').pop());
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

console.log(ok ? '时间锚与模式固化 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
