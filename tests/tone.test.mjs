// 语气 P1 单元测试:两侧取样权重 / 输出清洗 / 风格追加(只追加不删除)
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { MemoryStore } = await imp('lib/host/memory.js');
const { sampleToneRows, parseToneAdvice, appendStyleNote, TONE_SET, normalizeTone } = await imp('lib/host/tone-advice.js');

const dir = mkdtempSync(join(tmpdir(), 'ling-tone-'));
const mem = new MemoryStore(join(dir, 'm.db'));
let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

// 数据:知识/情感/日常 各若干,含置顶与深摘
mem.upsertOverview({ conv_id: 'k1', source: 'dsweb', title: '合金固溶与热处理', category: 'knowledge', overview_ok: true, summary: '工艺研究。', updated_at: '2026-08-01T00:00:00Z' });
mem.upsertOverview({ conv_id: 'k2', source: 'dsh', title: '项目讨论', category: 'knowledge', overview_ok: true, summary: '物理模拟。', updated_at: '2026-08-02T00:00:00Z' });
mem.upsertOverview({ conv_id: 'f1', source: 'dsweb', title: '深夜闲聊', category: 'feeling', overview_ok: true, summary: '夜聊与自省。', updated_at: '2026-08-03T00:00:00Z' });
mem.upsertOverview({ conv_id: 'f2', source: 'dsweb', title: '情绪碎碎念', category: 'feeling', overview_ok: true, summary: '情绪记录。', importance: 1, updated_at: '2026-08-04T00:00:00Z' });
mem.upsertOverview({ conv_id: 'd1', source: 'dsweb', title: '买菜清单', category: 'daily', overview_ok: true, updated_at: '2026-08-05T00:00:00Z', keywords: ['买菜', '清单'] });

// 1) 取样:工作侧知识优先,生活侧情感优先,置顶加成
const w = sampleToneRows(mem, { side: 'work', limit: 5 });
check(w.rows.length === 5, 'work 侧取样 5 条: ' + w.rows.length);
check(w.rows[0].category === 'knowledge', 'work 侧首选知识类: ' + w.rows[0].category + '/' + w.rows[0].title);
const l = sampleToneRows(mem, { side: 'life', limit: 5 });
check(l.rows[0].category === 'feeling', 'life 侧首选情感类: ' + l.rows[0].category + '/' + l.rows[0].title);
check(l.rows[0].title === '情绪碎碎念', '置顶情感条目排最前(加成生效)');
const kIdxW = w.rows.findIndex((r) => r.category === 'knowledge');
const fIdxW = w.rows.findIndex((r) => r.category === 'feeling');
check(kIdxW >= 0 && (fIdxW < 0 || kIdxW < fIdxW), 'work 侧知识排在情感之前');
check(l.sampled === 5 && l.pool === 5, '取样元数据(pool/sampled)');
const none = sampleToneRows(mem, { side: 'work', limit: 0 });
check(none.sampled === 1, 'limit 下限保底 1');

// 2) 输出清洗:枚举白名单 / 长度 / 围栏 / 非法降级
const good = parseToneAdvice(JSON.stringify({
  work: { tone: 'concise', note: '干活时别绕弯', evidence: '他反复要求结论先行' },
  life: { tone: 'playful', note: 'x'.repeat(120), evidence: 'y'.repeat(300) },
}));
check(good.work.tone === 'concise' && good.life.tone === 'playful', '合法枚举解析');
check(good.life.note.length === 80 && good.life.evidence.length === 120, 'note/evidence 截断');
const fenced = parseToneAdvice('```json\n{"work":{"tone":"literary"},"life":{"tone":"不存在的档"}}\n```');
check(fenced.work.tone === 'literary', 'markdown 围栏解析');
check(fenced.life.tone === '', '非白名单枚举降级为空');
const bad = parseToneAdvice('完全不是 JSON');
check(bad.work.tone === '' && bad.life.tone === '', '不可解析 → 双侧空');
check(TONE_SET.length === 4, '四档枚举不变');

// 2b) 枚举容错:中文/大小写/近义/带括号
check(normalizeTone('简洁直接') === 'concise', '中文标签归一(简洁直接→concise)');
check(normalizeTone('Concise') === 'concise', '大小写归一');
check(normalizeTone('concise(简洁直接)') === 'concise', '带括号说明归一');
check(normalizeTone('活泼俏皮') === 'playful' && normalizeTone('文雅') === 'literary' && normalizeTone('亲切') === 'natural', '其它中文标签归一');
check(normalizeTone('不要太长') === '', '无法判断时不猜(返回空)');
const cnKeys = parseToneAdvice(JSON.stringify({ 工作: { tone: '简洁' }, 生活: { tone: '俏皮', note: '夜里的话软一点' } }));
check(cnKeys.work.tone === 'concise' && cnKeys.life.tone === 'playful', '中文键名 + 中文枚举也能解析');

// 3) 风格追加:只追加、不删除、去重
check(appendStyleNote('克制、结构化。', '干活时别绕弯') === '克制、结构化。\n干活时别绕弯', '追加到既有文本尾部(换行分隔)');
check(appendStyleNote('克制、结构化。\n干活时别绕弯', '干活时别绕弯') === '克制、结构化。\n干活时别绕弯', '重复注不重复追加');
check(appendStyleNote('', '只有一条') === '只有一条', '空文本直接写入');
check(appendStyleNote('原文', '') === '原文', '空注不改动(不删除原文)');
check(appendStyleNote('原文\n', '补一句') === '原文\n补一句', '去除尾部空行后追加');

console.log(ok ? '语气 P1 全部通过 ✓' : '存在失败 ✗');
process.exit(ok ? 0 : 1);
