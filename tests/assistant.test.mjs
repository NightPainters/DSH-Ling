// S7 小助手地址可配置 单元测试:三级覆盖(settings → env → 内置默认)/ 默认值中性化 / 探测失败路径
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const D = await imp('lib/host/dsweb-summary.js');
const P = await imp('lib/host/persona.js');

let ok = true;
const check = (c, m) => { if (!c) { ok = false; console.log('✗', m); } };

const ENV_KEYS = ['DSH_LING_ASSISTANT', 'DSH_LING_ASSISTANT_MODEL'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
const clearEnv = () => { for (const k of ENV_KEYS) delete process.env[k]; };
const setEnv = (u, m) => {
  clearEnv();
  if (u !== undefined) process.env.DSH_LING_ASSISTANT = u;
  if (m !== undefined) process.env.DSH_LING_ASSISTANT_MODEL = m;
};

// ---- 1) 内置默认:loopback,不含任何私有网段(发布安全) ----
check(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(D.ASSISTANT_DEFAULT), 'ASSISTANT_DEFAULT 应为 loopback');
check(!/192\.168\.|(^|[/:])10\.|172\.(1[6-9]|2\d|3[01])\./.test(D.ASSISTANT_DEFAULT), 'ASSISTANT_DEFAULT 不得含私有网段');
check(D.ASSISTANT_MODEL_DEFAULT === 'qwen3.5:9b', 'ASSISTANT_MODEL_DEFAULT 未变');
check(P.DEFAULT_SETTINGS.assistant && P.DEFAULT_SETTINGS.assistant.baseUrl === '' && P.DEFAULT_SETTINGS.assistant.model === '',
  'DEFAULT_SETTINGS.assistant 默认应为空串(落到 env / 内置)');

// ---- 2) 三级覆盖:内置默认 → 环境变量 → settings ----
clearEnv();
let r = D.resolveAssistant({ assistant: {} });
check(r.source === 'default', '空配置应为 default 来源');
check(r.baseUrl === D.ASSISTANT_DEFAULT, '空配置应落到内置默认地址');
check(r.model === D.ASSISTANT_MODEL_DEFAULT, '空配置应落到内置默认模型');

setEnv('http://10.0.0.9:11434/v1', 'qwen-env');
r = D.resolveAssistant({ assistant: {} });
check(r.source === 'env', '有环境变量时应为 env 来源');
check(r.baseUrl === 'http://10.0.0.9:11434/v1', 'env 地址应生效');
check(r.model === 'qwen-env', 'env 模型应生效');

r = D.resolveAssistant({ assistant: { baseUrl: 'http://192.0.2.10:11434/v1', model: 'qwen-set' } });
check(r.source === 'settings', 'settings 应优先于 env');
check(r.baseUrl === 'http://192.0.2.10:11434/v1', 'settings 地址应生效');
check(r.model === 'qwen-set', 'settings 模型应生效');

// 只配模型也算 settings;地址回落 env —— 三级是**逐字段**回落,不是整块替换
r = D.resolveAssistant({ assistant: { model: 'only-model' } });
check(r.source === 'settings' && r.model === 'only-model' && r.baseUrl === 'http://10.0.0.9:11434/v1',
  '只配模型:模型走 settings,地址回落 env');

clearEnv();
r = D.resolveAssistant({ assistant: { baseUrl: '  http://192.0.2.11:11434/v1  ' } });
check(r.baseUrl === 'http://192.0.2.11:11434/v1', 'settings 地址应 trim');

// ---- 3) 入参形态:SettingsFile 实例(有 get())/ 普通对象 / null ----
clearEnv();
r = D.resolveAssistant({ get: () => ({ assistant: { baseUrl: 'http://192.0.2.12:11434/v1', model: 'via-get' } }) });
check(r.baseUrl === 'http://192.0.2.12:11434/v1' && r.model === 'via-get', '应支持 settings.get() 形态');
r = D.resolveAssistant(null);
check(r.source === 'default' && r.baseUrl === D.ASSISTANT_DEFAULT, 'null settings 不应抛错,落内置默认');
check(r.defaults.baseUrl === D.ASSISTANT_DEFAULT && r.env && r.configured, '返回应含 defaults/env/configured 三块(界面要显示来源)');

// ---- 4) 探测失败要如实返回(必然连不上的端口 + 短超时,不依赖外网) ----
const probe = await D.probeAssistant('http://127.0.0.1:9/v1', { timeoutMs: 900 });
check(probe.ok === false, '连不上的地址应 ok:false');
check(typeof probe.reason === 'string' && probe.reason.length > 0, '失败应带 reason(界面用来解释)');

// 还原环境变量,避免影响后续用例
for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }

console.log(ok ? '小助手地址配置 全部通过 ✓' : '小助手地址配置 有失败 ✗');
process.exit(ok ? 0 : 1);
