// dsh-ling host — settings persistence v2.
// Persists ONLY user patches (decoupled from code defaults so future default
// changes propagate); one-time migration from the v0 full-snapshot file keeps
// only the user-meaningful { mode.lastMode }.
import { join } from 'node:path';
import { copyFile } from 'node:fs/promises';
import { ensureDir, mergeDeep, readJsonStrict, writeJsonAtomic } from './util.js';
import { DEFAULT_SETTINGS } from './persona.js';

const SETTINGS_VERSION = 2;

export class SettingsFile {
  constructor(dataDir) {
    this.dir = ensureDir(dataDir);
    this.file = join(dataDir, 'settings.json');
    // ── F3(1.7.3 双模型盲审,2026-10-27):**读坏了不等于没设置过** ─────────────────────
    // 旧写法 `readJsonSafe(this.file, {})` 把「文件不存在 / 读失败 / JSON 损坏」并成同一个 `{}`:
    //   损坏文件会被当成"用户什么都没设置" ⇒ 全部回落代码默认值 ⇒ `inject.memoryEnabled` 默认
    //   true ⇒ **记忆注入静默重开**(用户关过的意图被吃掉,且没有任何具名错误)。
    // 判据:只有"文件不存在"(首启的正常形态)才当空设置;读失败/损坏一律
    //   (a) 记 `loadError` + warnings,**当场说破**;
    //   (b) 保守按"记忆注入已关闭"启动(见下面 loadError 分支),因为开关的语义是"少给她看",
    //       失败时宁少不多;
    //   (c) 保留损坏原文件(见 `preserveCorruptOnce()`),免得第一次保存就把证据抹掉。
    const loaded = readJsonStrict(this.file);
    this.loadError = null;
    let stored = {};
    if (loaded.ok) {
      stored = loaded.value;
    } else if (loaded.reason !== 'missing') {
      this.loadError = { reason: loaded.reason, error: loaded.error || '', file: this.file };
    }
    let user;
    if (stored && stored.__v === SETTINGS_VERSION && stored.user) {
      user = mergeDeep({}, stored.user);
    } else if (stored && stored.__v === SETTINGS_VERSION) {
      user = mergeDeep({}, stored);
    } else {
      // v0/v1 迁移:旧文件是"默认值全量快照",只保留用户关心的 lastMode
      user = {};
      const lm = stored?.mode?.lastMode;
      if (lm === 'work' || lm === 'life') user = { mode: { lastMode: lm } };
    }
    this.user = user || {};
    // ── 1.7.3(2026-10-27)一次性迁移:保住老用户"关掉器灵"的意图 ──────────────────────
    // 1.7.2 的真实判据是 `personaEnabled && l1Enabled`:关掉「人格与记忆注入」那个勾 ⇒
    //   **人格段 L0 与记忆段 L1 一起消失**,等于整个器灵离场。1.7.3 换成状态键 `inject.away`
    //   (默认 false = 在场)⇒ 若不迁移,当年为隐私关掉她的人升级后**她会自己回来**。
    //   这不是"改进",是静默改用户意图,所以这里补一条:老用户明确关过人格、且**从未写过**
    //   `inject.away` / `inject.memoryEnabled` ⇒ 在内存态里补 `away:true`(旧行为逐字保持)。
    //   ⚠️ 补的是 `away` 而**不是** `memoryEnabled:false`:后者只压记忆段、留着人格段,
    //      那正是"失忆的她"——本版明令消灭的那个坏状态。
    //   · 只改内存态、**不落盘**:构造函数不该有写副作用;用户下次拨开关时自然写显式值。
    //   · 一旦他写过那两个键之一(哪怕写成 true),这条迁移就永远不再生效。
    this.migratedFrom = [];
    this.warnings = [];
    // ── F3:读坏了的保守方向 = 按"记忆注入关闭"启动 ───────────────────────────────────
    // 为什么是失败关而不是失败开:这个开关的语义是"少给她看"(内存态/注入面),坏了还照常开
    // 等于一次磁盘事故把用户明确关掉的意图静默翻面。方向只能选一边,就选"不泄露"。
    // 同时把恢复路径写进 warnings(面板 /inject 的 GET 会带出去),不只留在终端日志里。
    if (this.loadError) {
      const msg = 'settings.json 读不了(' + this.loadError.reason
        + (this.loadError.error ? ': ' + this.loadError.error : '')
        + ') —— 已按「器灵暂离」的保守口径启动(人格/记忆/工具/后台一起停);原文件会在下次保存前另存为 settings.json.corrupt-*,'
        + '你确认内容无误后可在面板里重新拨开开关';
      this.warnings.push(msg);
      console.warn('[dsh-ling] ' + msg);
      // 2026-10-27 夜:保守方向改写成**离场**(`away:true`)而不是 `memoryEnabled:false` ——
      //   后者只压记忆段、留着人格段,恰好是主人当晚明令消灭的「人格开 + 记忆关 = 失忆的她」。
      //   读坏了就当她暂离:四处(人格/记忆/工具/后台)一起停,方向仍然是"不泄露"。
      this.user = mergeDeep(this.user, { inject: { away: true } });
    }
    // ── 1.7.3(A 路审计 2026-10-27 补):`inject` 本身被手改成**非纯对象**时先说破 ──────────
    // 症状(审计实测):盘上 `"inject": "disabled"` + `persona.enabled:false` ⇒ 迁移会把它
    //   **静默覆盖**成 `{memoryEnabled:false}`,而下面那条布尔告警看不见(它只查 `.memoryEnabled`)。
    //   "非法值被悄悄换成一个看着合理的值"正属于本版要消灭的那类静默失效 ⇒ 先记一条警告。
    try {
      const rawInject = this.user && typeof this.user === 'object' ? this.user.inject : undefined;
      if (rawInject !== undefined && (typeof rawInject !== 'object' || rawInject === null || Array.isArray(rawInject))) {
        const msg = 'settings.inject 不是对象(' + JSON.stringify(rawInject) + '),已按"未设置"处理' +
          (this.user?.persona?.enabled === false ? ';下面的升级迁移会把它改写成 {away:true}' : '');
        this.warnings.push(msg);
        console.warn('[dsh-ling] ' + msg);
      }
    } catch { /* 只是提示,失败不影响启动 */ }
    try {
      const injected = this.user && typeof this.user === 'object' ? this.user.inject : undefined;
      // 2026-10-27 夜:迁移目标从 `memoryEnabled:false` 改成 `away:true` ——
      //   老用户当年关的其实是"整个器灵"(人格+记忆一起没了),而不是"只关记忆"。
      //   写成 memoryEnabled:false 会留下人格段,变成"失忆的她";`away` 才是旧行为的逐字等价。
      const legacyKeys = injected && typeof injected === 'object' && !Array.isArray(injected)
        ? Object.keys(injected).filter((k) => k === 'memoryEnabled' || k === 'away')
        : [];
      // ── 1.7.3 夜 F 类盲审(2026-10-27):迁移判据放宽到**两个旧键任一为 false** ───────────
      // 旧条件只认 `persona.enabled=false && 没有 memoryEnabled/away 键`,于是这种盘上状态漏网:
      //   `{persona:{enabled:false}, inject:{memoryEnabled:true}}` —— 有 memoryEnabled ⇒ 迁移不跑
      //   ⇒ away 仍是 false ⇒ 走 snapshot 就是"人格不出、记忆照出"(别人在读她的档案)。
      // 现在:只要**还没有显式的 away 键**、且旧键存在"关"的取值,就把它迁成整个暂离。
      const hasAwayKey = legacyKeys.includes('away');
      const legacyOff = this.user?.persona?.enabled === false
        || (legacyKeys.includes('memoryEnabled') && injected.memoryEnabled === false);
      if (legacyOff && !hasAwayKey) {
        // ⚠️ `mergeDeep(base, over)` **只吃两个参数**(util.js:111)—— 写成三参会被静默忽略,
        //    迁移就"看代码有、实际没发生"。这里嵌套一次,一步只做一件事。
        const rawBefore = this.user?.inject;
        this.user = mergeDeep(mergeDeep({}, this.user), { inject: { away: true } });
        this.migratedFrom.push((this.user?.persona?.enabled === false ? 'persona.enabled=false' : 'inject.memoryEnabled=false')
          + '(1.7.2 旧口径 ⇒ 整个器灵暂离)');
        // 1.7.3(审计 B 路 2026-10-27 收尾):上面那条"会把它改写"是**预告**,这里补**完成回执** ——
        //   只预告不交代,读日志的人永远不知道有没有真的执行。两种情况各说一句。
        if (rawBefore !== undefined && (typeof rawBefore !== 'object' || rawBefore === null || Array.isArray(rawBefore))) {
          const done = 'settings.inject(' + JSON.stringify(rawBefore) + ') 已按"未设置"处理,老口径迁移为 away:true'
            + '(仅内存态生效,未落盘;下次在面板拨开关即写入显式值)';
          this.warnings.push(done);
          console.warn('[dsh-ling] ' + done);
        }
      }
    } catch { /* 迁移失败就按默认值走;绝不让它拦住启动 */ }
    // 同一口径的**说破**:手改 settings.json 把 `inject.memoryEnabled` 写成字符串/数字时,
    // 判据是 `!== false` ⇒ 结果等于"开"。这跟"写了 false 却没关"是同一种静默失效,
    // 所以至少要在日志里喊一声(面板另有 `warnings`,见 /inject 的 GET)。
    try {
      const v = this.user?.inject?.memoryEnabled;
      if (v !== undefined && typeof v !== 'boolean') {
        const msg = 'settings.inject.memoryEnabled 不是布尔值(' + JSON.stringify(v) + '),已按"未设置"处理 ⇒ 视为开;请在面板里拨一下开关以写入真布尔';
        this.warnings.push(msg);
        console.warn('[dsh-ling] ' + msg);
      }
    } catch { /* 只是提示,失败不影响启动 */ }
    // 1.7.3 夜 F 类第三轮(盲审 F7):`inject.away` 被手改成非布尔串时也要说破。
    // 判据是 `=== true`,所以盘上写 `"true"`(字符串)会被当成"在场" —— 用户以为关掉了,
    // 实际她还在。HTTP 面写不进这种值(guard 只收真布尔),但手改文件可以 ⇒ 至少喊一声。
    try {
      const v = this.user?.inject?.away;
      if (v !== undefined && typeof v !== 'boolean') {
        const msg = 'settings.inject.away 不是布尔值(' + JSON.stringify(v) + '),已按"未设置"处理 ⇒ 视为在场;'
          + '若你想让她暂离,请在面板里拨一下开关(会写入真布尔)';
        this.warnings.push(msg);
        console.warn('[dsh-ling] ' + msg);
      }
    } catch { /* 只是提示,失败不影响启动 */ }
    this.current = mergeDeep(structuredClone(DEFAULT_SETTINGS), this.user);
  }

  get() {
    return this.current;
  }

  /**
   * Apply a user patch (deep-merged onto current defaults); persist patch only.
   *
   * ── F4(1.7.3 双模型盲审,2026-10-27):**先落盘,成功后才改内存态** ──────────────────
   * 旧顺序是「改 this.user / this.current ⇒ 再 await writeJsonAtomic」:落盘失败时客户端收到
   * 500、面板把勾恢复,而**同进程运行态已经是新值**;重启后又回旧值 ⇒ 回执、运行态、磁盘
   * 三者分叉,而回执说的和实况是反的。现在:算候选值(纯函数 mergeDeep,不改 this) ⇒ 写盘 ⇒
   * 成功才 publish;写失败就把异常抛给调用方,内存态与磁盘**停在同一份旧值**上 ——
   * 于是"500 = 没改成"重新变成真话。
   */
  async update(patch) {
    const nextUser = mergeDeep(this.user, patch || {});
    const nextCurrent = mergeDeep(structuredClone(DEFAULT_SETTINGS), nextUser);
    await this.preserveCorruptOnce();
    await writeJsonAtomic(this.file, { __v: SETTINGS_VERSION, user: nextUser });
    this.user = nextUser;
    this.current = nextCurrent;
    return this.current;
  }

  /**
   * F3 的配套动作:启动时读到损坏文件 ⇒ 第一次保存前先原样留一份 `settings.json.corrupt-*`。
   * 只在"确实读坏过"时做一次;坏文件本身是证据,不能被一次正常保存静默覆盖。
   * 备份失败**不阻断保存**(备份不成不该让用户保存不了),只喊一声并把话写进 warnings。
   * @returns {Promise<string|null>} 备份路径(null = 无需备份 / 未成功)
   */
  async preserveCorruptOnce() {
    if (!this.loadError || this.preservedAs) return this.preservedAs || null;
    if (this.loadError.reason === 'missing') return null;
    // 用**本地时间**命名(不是 toISOString 的 UTC):这个名字是给人在资源管理器里看的,
    // 与用户时钟差 8 小时会让"刚才那次损坏"看起来像凌晨发生的。
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const target = `${this.file}.corrupt-${stamp}`;
    try {
      await copyFile(this.file, target);
      this.preservedAs = target;
      console.warn('[dsh-ling] settings.json 读坏过,已把原文件留一份: ' + target);
    } catch (e) {
      const msg = 'settings.json 读坏过,但备份原文件失败(' + String(e?.message ?? e) + ') —— 即将覆盖它,如需保留请先手动另存';
      this.warnings.push(msg);
      console.warn('[dsh-ling] ' + msg);
    }
    return this.preservedAs || null;
  }

  async reset() {
    // F4 同一口径:落盘成功才清内存态(否则"重置失败"却已清空,界面与实际相反)。
    const payload = { __v: SETTINGS_VERSION, user: {} };
    await this.preserveCorruptOnce();
    await writeJsonAtomic(this.file, payload);
    this.user = {};
    this.current = structuredClone(DEFAULT_SETTINGS);
    return this.current;
  }
}
