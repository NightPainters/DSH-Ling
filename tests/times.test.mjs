// 时间戳归一(修 A)单测:混合形态时间戳的解析 / 写侧归一 / 热度衰减 / 展示日期 / 时间锚取最近。
// 背景:早期写入路径把毫秒时间戳当浮点存成了 text("1789006881011.0"),
// 使 Date.parse 返回 NaN → 新近度恒为 1.0(永不衰减)、注入文本里出现 "(1789006881)"。
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { toEpochMs, toIso, isoDate } = await imp('lib/host/util.js');
const { MemoryStore } = await imp('lib/host/memory.js');
const { computeHeat, selectL1 } = await imp('lib/host/l1.js');
const { summarizeDsh } = await imp('lib/host/summarizer.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };
const DAY = 86_400_000;
const BAD = '1789006881011.0';           // 遗留浮点串(真实数据里的形态)
const BAD_MS = 1789006881011;
const BAD_ISO = new Date(BAD_MS).toISOString();
const BAD_DATE = BAD_ISO.slice(0, 10);

// 1) 解析层:各种形态都能归一,坏值绝不返回 NaN
check(toEpochMs(BAD) === BAD_MS, '浮点串 → epoch ms');
check(toEpochMs('1789006881') === 1789006881000, '10 位按秒');
check(toEpochMs(1789006881011) === BAD_MS, '数字毫秒');
check(toEpochMs('2026-09-09T12:00:00.000Z') === Date.parse('2026-09-09T12:00:00.000Z'), 'ISO 字符串');
check(toEpochMs(new Date(BAD_MS)) === BAD_MS, 'Date 实例');
check(toEpochMs('') === null && toEpochMs(null) === null && toEpochMs(undefined) === null, '空值 → null');
check(toEpochMs('不是时间') === null && toEpochMs('-5') === null && toEpochMs(0) === null, '垃圾/非正数 → null');
check(Number.isNaN(toEpochMs('xxx')) === false, '永不返回 NaN');
check(toIso(BAD) === BAD_ISO, 'toIso 归一遗留串');
check(isoDate(BAD) === BAD_DATE, 'isoDate 归一遗留串:' + isoDate(BAD));
check(isoDate('不是时间') === '', '坏值 isoDate 返回空串');
check(isoDate('2026-09-09T23:59:59.000Z') === '2026-09-09', 'ISO 取日期(UTC)');

// 2) 热度:坏串过去也能正常衰减 —— 修 A 的核心
const nowMs = Date.now();
const oldBad = { updated_at: String(nowMs - 90 * DAY) + '.0', hit_count: 0, importance: 0 };
const fresh = { updated_at: new Date(nowMs).toISOString(), hit_count: 0, importance: 0 };
const hOld = computeHeat(oldBad, nowMs, {});
const hNew = computeHeat(fresh, nowMs, {});
check(Math.abs(hOld - 0.25) < 0.02, `90 天前的遗留串 recency≈0.5 → heat≈0.25,实际 ${hOld.toFixed(3)}`);
check(Math.abs(hNew - 0.5) < 0.02, `刚更新 heat≈0.5,实际 ${hNew.toFixed(3)}`);
check(hOld < hNew, '旧的遗留串不再拿满分(修 A 前两者都为 0.5 的 recency=1)');
const junk = computeHeat({ updated_at: '不是时间', hit_count: 0, importance: 0 }, nowMs, {});
check(Math.abs(junk - 0.5) < 0.02, '不可解析时按"刚更新"处理(不惩罚未知)');

// 3) 端到端:写侧归一 + L1 展示日期 + 时间锚取最近
const dir = mkdtempSync(join(tmpdir(), 'ling-times-'));
const mem = new MemoryStore(join(dir, 'm.db'));

mem.appendRawTurn('s-bad', { seq: 1, role: 'user', ts: BAD, model: null, text: '这是第一条足够长的用户消息,用来验证概述器的最短字符门槛是否被正确通过(需要累计不少于四十个字符,所以这句话写得长一些)。' });
mem.appendRawTurn('s-bad', { seq: 2, role: 'assistant', ts: BAD, model: null, text: '收到,已处理。' });
const stored = mem.db.prepare("SELECT ts FROM dsh_turns_raw WHERE session_id='s-bad' ORDER BY seq").all().map((r) => String(r.ts));
check(stored[0] === BAD_ISO, '写侧统一存 ISO:' + stored[0]);
check(!stored.some((t) => /^-?\d+(?:\.\d+)?$/.test(t)), '表里不再出现"纯数字时间串"');

const st = summarizeDsh(mem);
check(st.created >= 1, '概述器建行:' + JSON.stringify(st));
const ov = mem.overviewById('dsh', 's-bad');
check(!!ov && ov.updated_at === BAD_ISO, '概述时间归一为 ISO:' + (ov && ov.updated_at));

const l1 = selectL1(mem, { mode: 'work', maxItems: 8, budgetChars: 6000 });
const line = (l1.items.find((i) => i.conv_id === 's-bad') || {}).line || '';
check(line.includes('(' + BAD_DATE + ')'), 'L1 行显示真实日期:' + line.slice(0, 60));
check(!/\(17\d{8}\)/.test(line), 'L1 行不再出现 (1789006881) 这种截断数字');

// 时间锚:混合形态时取真正的最近一次
mem.appendRawTurn('s-mix', { seq: 1, role: 'user', ts: '1789006881011.0', model: null, text: '遗留串' });
const newerIso = new Date(Date.now() - 3600e3).toISOString();
mem.appendRawTurn('s-mix', { seq: 2, role: 'user', ts: newerIso, model: null, text: '较新的一条' });
check(mem.lastUserTurnAt() === newerIso, 'lastUserTurnAt 取较新者(不被遗留串压住):' + mem.lastUserTurnAt());

// 4) 回归护栏:util 里不得再出现裸 Date.parse 作为唯一解析路径
const utilSrc = readFileSync(join(root, 'lib/host/util.js'), 'utf8');
check(utilSrc.includes('export function toEpochMs'), 'util 暴露 toEpochMs');
check(utilSrc.includes('export function toIso') && utilSrc.includes('export function isoDate'), 'util 暴露 toIso/isoDate');

mem.close();
console.log(ok ? '时间戳归一(修 A)全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
