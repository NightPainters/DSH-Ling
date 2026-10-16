import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_LIBRARY_LIMITS } from './library-store.js';
import { normalizeLibraryConfig } from './library-runtime.js';

const libraryFields = Schema.object({
  enabled: Schema.boolean().default(true).description('启用独立图书馆;不迁移记忆、不参与开场注入。'),
  codeRoots: Schema.array(Schema.string()).default([]).description('管理员登记的绝对代码根目录。'),
  officialUrls: Schema.array(Schema.string()).default([]).description('管理员登记的精确 HTTPS 文档 URL。'),
  limits: Schema.object(Object.fromEntries(Object.entries(DEFAULT_LIBRARY_LIMITS)
    .map(([key, value]) => [key, Schema.number().default(value)]))),
  // F10(1.7 修复批次):图书馆配置校验失败的原因。非空 ⇒ **图书馆整块**不可用,记忆/人格/工具照常。
  // 它是"响亮"的载体:理由词给上层,出错的键名给用户。
  configError: Schema.string().default('').description('图书馆配置校验失败的原因(非空 ⇒ 图书馆整块不可用,其余功能照常)'),
});
const fields = Schema.object({ library: libraryFields });

// Validate raw keys before Schemastery fills defaults or adapts values. Its
// object resolver otherwise preserves unknown keys, including library hooks.
// Existing non-library settings keep their established configuration semantics.
export const Config = Schema.transform(Schema.any().default({}), (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-ling 配置必须是对象');
  }
  // F10(1.7 修复批次):以前 `normalizeLibraryConfig` 抛在这里 ⇒ 异常一路冒到 `apply()` ⇒
  //   **记忆 / 人格 / 全部 11 件工具一起不加载**,而且没有任何可指认面;而 `lib/index.js` 对
  //   "库打不开"却是有界重试 + 降级 + 排查指引 ⇒ 两种口径自相矛盾。
  //   修法:**不吞、不静默** —— 原因带进 config(含出错的键名,可执行),图书馆进不可用态,
  //   插件其余部分照常加载。**绝不**拿半套配置去开库(那会把"配置写错"变成看不懂的运行期怪象)。
  let library = null;
  let libraryConfigError = '';
  try {
    library = normalizeLibraryConfig(raw.library);
  } catch (error) {
    libraryConfigError = String(error?.message ?? error).slice(0, 300);
    library = normalizeLibraryConfig({});   // 结构仍是合法形状(默认:enabled=true、空白名单)
  }
  return fields({ ...raw, library: { ...library, configError: libraryConfigError } });
}, true).default({});
