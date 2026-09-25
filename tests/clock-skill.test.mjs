// clock skill(2026-09-23):精确时间按需查询 —— 随 1.5.0 起内置进器灵包。
// 本案测三件事:① skill 元数据形态合法(注册表按 name 寻址、按 description 路由);
// ② **正文不得含相邻 `{{`** —— 正文会进模型请求,而宿主 renderPrompt 对未注册变量直接抛异常
//    (1.3.1 注入面加固的同一根因),这正是"给内容加断言"的价值;
// ③ 注册函数在 services 缺失/存在两种情形下的行为,以及 disposer 的释放语义。
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ok, eq, section, summary } from './harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);

const mod = await imp('lib/host/clock-skill.js');
const {
  CLOCK_SKILL_NAME,
  CLOCK_SKILL_DESCRIPTION,
  CLOCK_SKILL_WHEN_TO_USE,
  CLOCK_SKILL_CONTENT,
  registerClockSkill,
} = mod;

// 宿主变量判据(与 dsh-system-prompt 的正则同形):命中即会被展开或抛异常
const HOST_VAR = /\{\{([^{}]*)\}\}/;
const dangerous = (s) => HOST_VAR.test(String(s ?? ''));

// ---------------- 1) 元数据形态 ----------------
section('1) skill 元数据');
{
  eq(CLOCK_SKILL_NAME, 'clock', '名字是 clock');
  ok(/^[a-z][a-z0-9-]*$/.test(CLOCK_SKILL_NAME), '名字符合 kebab-case 文法');
  ok(CLOCK_SKILL_DESCRIPTION.length > 10, 'description 非空且够路由用');
  ok(CLOCK_SKILL_WHEN_TO_USE.length > 10, 'whenToUse 非空');
  ok(CLOCK_SKILL_CONTENT.length > 400, '正文有实质内容');
}

// ---------------- 2) 注入面安全(本套最重要的断言) ----------------
section('2) 正文不含相邻 {{ (否则会让会话失效)');
{
  // 反证:判据本身有效
  ok(dangerous('{{time}}') === true, '反证:判据能识别危险载荷');
  ok(dangerous(CLOCK_SKILL_CONTENT) === false, '正文无相邻 {{');
  ok(CLOCK_SKILL_CONTENT.indexOf('\u200b') === -1, '正文不含零宽空格(未被中和过,是原始文本)');
  // 正文里刻意演示的命令不应引入模板语法
  ok(CLOCK_SKILL_CONTENT.includes('Get-Date'), '正文给出查询命令');
  ok(CLOCK_SKILL_CONTENT.includes('yyyy-MM-dd'), '正文给出格式串');
  ok(CLOCK_SKILL_CONTENT.includes('UTC+8'), '正文写明本机时区');
  ok(CLOCK_SKILL_CONTENT.includes('[现在]'), '正文说明与时间锚的分工');
}

// ---------------- 3) 无 skills 服务时:不抛错、留下重试 disposer ----------------
section('3) services 缺失时的退化');
{
  const bare = {}; // 没有 ctx.inject,也没有 skills
  let list = null;
  let threw = null;
  try {
    list = registerClockSkill(bare);
  } catch (e) {
    threw = e;
  }
  eq(threw, null, '不抛错');
  ok(Array.isArray(list), '返回数组');
  ok(list.length >= 1, '至少留下定时器 disposer');
  ok(list.every((d) => typeof d === 'function'), 'disposer 均为函数');
  // 立即释放,避免 1.5s 定时器把测试挂住
  for (const d of list) d();
  ok(true, 'disposer 可安全调用');
}

// ---------------- 4) services 就绪时:注册一次且参数完整 ----------------
section('4) skills 服务就绪');
{
  const seen = [];
  const mock = {
    skills: {
      register(skill) {
        seen.push(skill);
        return () => {
          skill.__disposed = true;
        };
      },
    },
  };
  const disposers = registerClockSkill(mock);
  eq(seen.length, 1, '注册恰好一次');
  const s = seen[0] || {};
  eq(s.name, 'clock', '注册名');
  eq(s.source, 'bundled', '来源标为 bundled');
  eq(s.content, CLOCK_SKILL_CONTENT, '正文原样传入');
  eq(s.description, CLOCK_SKILL_DESCRIPTION, '描述原样传入');
  eq(s.whenToUse, CLOCK_SKILL_WHEN_TO_USE, 'whenToUse 原样传入');
  ok(!('invocation' in s), '不传 invocation(交注册表补默认:模型与用户都可调)');

  // 两次独立调用 = 两次注册。这是**正确语义**:插件重载时旧的 disposer 先释放,
  // 新的调用必须能重新注册;若做成跨调用幂等,重载后就再也挂不上了。
  const again = registerClockSkill(mock);
  eq(seen.length, 2, '两次调用各自注册(重载后可恢复)');
  ok(Array.isArray(again), '重复挂载仍返回数组');

  // disposer 应包含注册表返回的那个
  ok(disposers.some((d) => typeof d === 'function'), 'disposer 列表非空');
  for (const d of disposers) d();
  for (const d of again) d();
  ok(true, '释放不抛错');
}

// ---------------- 5) 直取失败但 inject 成功 ----------------
section('5) ctx.inject 路径');
{
  const seen2 = [];
  const mock2 = {
    inject(services, cb) {
      eq(Array.isArray(services), true, 'inject 收到服务名数组');
      eq(services[0], 'skills', '注入的正是 skills');
      // 服务必须从回调参数取(走闭包 ctx 会报 without inject)
      cb({ skills: { register(s) { seen2.push(s); return () => {}; } } });
    },
  };
  const list2 = registerClockSkill(mock2);
  eq(seen2.length, 1, 'inject 回调内注册一次');
  ok(list2.length >= 1, '仍留下定时器 disposer 兜底');
  for (const d of list2) d();
  ok(true, '释放不抛错');
}

summary();
