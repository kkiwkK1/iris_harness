# U3 施工文档 · `scope.storage`：插件私有存储

> 状态：已归档（2026-09-17）。工作已全部落地：#104。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

本文是 [INFRA-TASKS-2026-09-15](../../INFRA-TASKS-2026-09-15.md) 第 U3 项的施工文档。任务单是裁决和验收口径，本文是开工时真正打开的那一份：现状按代码核过，任务单与代码不符的地方已在第 2 节改正，未裁决的实现选择在第 3 节给出推荐与理由。

---

## 1. 任务身份

| 项 | 值 |
| --- | --- |
| 分支 | `dev/plugin-scope-storage` |
| 基线 | `origin/main` `269a97e`（任务单本身写的是 `e03adbb`，行号证据也取自那次提交；`269a97e` 只多出任务单与 §8 的一行文字，无产品代码改动） |
| ledger | `notes/packages/iris-app-service/DEVIATIONS.md` §83（预留；当前尾节是 §80） |
| PR | 到 `main`，协调人验收 |
| 规模估计 | 产品代码 ~380 行（新增 `plugins/storage.ts` 约 260 行，其余五个文件合计约 120 行追加），测试 ~400 行，文档与 ledger ~150 行 |
| 与谁重叠 | U2（plugin-api 接口同一处、`system-plugins.ts` scope 字面量同一处，追加式；按任务单 §1 的约定 `storage` 排在 `variables` **前**）、U5（`plugins/manifest.ts` 不同区域）。`PLUGIN_PERMISSIONS` 词表按字母序插入：`plugin-storage` 落在 `host-context` 与 `provide-capability` 之间 |

---

## 2. 前提纠正与现状

### 2.1 前提纠正（代码赢）

任务单 U3 有五处与 `269a97e` 的代码不符，PR 说明第一段要照抄这一小节。

**纠正 1 · 没有 `forbiddenKeys` 这个实现可以「找出来复用」。**
任务单写「禁止键 …… 按现有 9 处写面的同一规则拒绝（找 `forbiddenKeys` 的实现复用）」。树里没有叫 `forbiddenKeys` 的东西。真正的实现是两层：底层谓词在 `packages/iris-variables/src/keys.ts:33` 的 `FORBIDDEN`（`__proto__`/`constructor`/`prototype`）与 `isForbiddenKey`、`findForbiddenKey`、`assertNoForbiddenKeys`；app-service 侧的写面守卫是 `packages/iris-app-service/src/context.ts:57` 的 `assertStorable`，它在 `:83` 调 `isForbiddenKey`，并且**同时**拒绝非 JSON 值（class 实例 `:73`、非有限数 `:64`、`undefined`/函数/symbol 走 `:90` 的 default），抛的正是 `invalid-request`（`errors.ts:53` 的 `invalid()`）。
写面数量实测是 **10 处**（不是 9）：`context.ts:524`、`:623`、`:671`、`:699`，`script-library.ts:309`，`script-variables.ts:191`，`service.ts:2608`、`:3924`，`template.ts:257`、`:292`；`grep` 出的 12 条里另外两条（`context.ts:69`、`:86`）是函数自己的递归。
结论：U3 **直接调 `assertStorable(value, 'plugin storage value')`**，一行，不新写谓词。`@iris/variables` 与 `@iris/extension-installer` 都已是 app-service 的 dependency（`packages/iris-app-service/package.json`），不需要动依赖。

顺带：`packages/iris-app-service/src/atomic.ts:280` 的 `wireKeyedTable` **不是拒绝**，它是把外来键拷到无原型表上中和掉。U3 的值是整份 JSON 树、不是键表，所以用 `assertStorable` 拒绝而不是 `wireKeyedTable` 中和——两者别混。

**纠正 2 · `storage-error` 不是一个可以用来上报隔离的事件。**
`storage-error` 是 `stream.error` 帧上的一个 `code`，定义在 `packages/iris-protocol/src/events.ts:88`，唯一发送处是 `packages/iris-app-service/src/service.ts:5293`，语义是「回复已生成但写不进磁盘」，帧上带 `chatId` 和 `turn`。插件存储的坏文件隔离既没有 chat 也没有 turn，借这个码会把一条插件的诊断伪装成某轮对话的终结帧。
正确通道是**每个 store 的坏文件已经在走的那条**：`packages/iris-app-service/src/index.ts` 里的 `reportStoreProblem`（构造于 `:667` 一带，`diagnostics.record({ kind:'host', grade:'fault' }, message)` + `ctx.logger.warn`），`SettingsStore`、`ScriptVariableStore`、`CardStorageStore` 的 `onProblem` 都接在它上面（`index.ts:685`、`:687`、`:1033`），`SystemPluginRuntime` 的 `onError` 也接在它上面（`index.ts:786`）。U3 用同一个：`quarantineUnparsable` 的 `onProblem` 参数直接收 `reportStoreProblem`，一句话进 `debug.reports`，不发任何流帧。

**纠正 3 · 键语法本身已经挡住了任务单列的三个牙齿用例。**
`isValidExtensionId` 是 `packages/iris-extension-installer/src/lock.ts:30`，正则在 `:28`：`/^[a-z0-9][a-z0-9._-]{0,63}$/`。`../x` 有 `/`、`C:\x` 有大写和反斜杠、`.` 首字符不在 `[a-z0-9]` ——三个都被正则单独拒掉。所以「路径包含性检查」这一层在**单故障假设**下红不起来，这与 PR-1 记录的 `auditContainment` 逃逸分支是同一类情况（`notes/packages/iris-app-service/DEVIATIONS.md` §79 里已有先例写法）。做法照抄那个先例：两层都写，牙齿表里**如实记下「删掉包含性检查单独不红」**，并把两个方向都量一遍（只删正则 → 仍被 `resolve` 前缀检查拒；两个都删 → 逃得出去）。不许因为红不起来就不写那一层，也不许假装它红了。

**纠正 4 · `SystemPluginRuntime` 今天不知道任何目录，`ProfilePaths` 也没有这一项。**
runtime 的构造参数是 `SystemPluginRuntimeOptions`（`packages/iris-plugin-api/src/index.ts:150`），只有 `context/file/definitions/defaultEnabled/onError/writePreferences`，`file` 是 `system-plugins.json` 的绝对路径（`index.ts:785`），没有 profile 根。而 profile 下每一个存储位置都出自 `profilePaths` 这**一个**派生函数（`packages/iris-app-service/src/paths.ts:270`），它的注释在 `:256`–`:260` 明说这条规则存在就是为了「后长出来的 store 不可能是忘了做 profile 隔离的那一个」。
所以 U3 必须动两处任务单没提的地方：`ProfilePaths` 加成员 `pluginData`，`profilePaths` 加 `pluginData: join(root, 'plugin-data')`；`SystemPluginRuntimeOptions` 加可选 `pluginDataRoot?: string`。见第 4 节。

**纠正 5 · 「lease 撤销后的 set 拒绝，同 ScriptVariableStore 语义（`invalid-request`）」把两件事压成了一句。**
树上是两个不同的拒绝，错误码本来就不同，不能合并：
- **插件被停用 / incarnation 过期**：`runtime.lease()` → `assertCurrent()` → `AppError('unsupported', …)`（`packages/iris-app-service/src/system-plugins.ts:637`、`:665`–`:75` 区段的 `assertCurrent`，以及 `:656` 的 stale incarnation）。这是 runtime 自己的词汇，`registerRpc` 走的也是它（`:939`）；改它会改 RPC 的行为。
- **宿主卸载后写入**：`ScriptVariableStore` 在 `flush()` 里先置 `#closed` 再排空（`packages/iris-app-service/src/script-variables.ts:247`–`:252`），之后的写抛 `invalid()` → `invalid-request`（`:163`–`:166` 区段的 `backendFor.write`），理由写在 `flush` 的 docblock 里，ledger 是 §78。
U3 两条都实现，各自命名，PR 说明里写清这是把任务单一句话拆成两句，不是新增语义。

### 2.2 现状：插件相邻的数据今天落在哪里

| 东西 | 位置 | 谁写 | 卸载时 |
| --- | --- | --- | --- |
| 插件代码树（`git` 源） | `<profile>/system-plugins/installed/<id>/`（`paths.ts:317` 的 `systemPluginPackages` + 安装器布局） | 安装事务 | **删**（`packages/iris-app-service/src/plugins/install.ts:486`–`:496`：改名让开 → `rm` 两次尽力） |
| 插件代码树（`dev` 源） | 用户自己的目录 | 用户 | 不碰（同上 `:488` 的 `source === 'git'` 判断） |
| 帧侧 bundle | `<dataDir>/system-plugins/<id>/client/client.js`（dataDir 级，不是 profile 级，`paths.ts:310`–`:315` 的同名警告） | 安装/激活 | 删（`install.ts:500`） |
| 目录与开关 | `<profile>/system-plugins.json` v2（`index.ts:785`） | runtime 独占 | `removable` 行连行删（`system-plugins.ts:775` 起） |
| ST 扩展设置 | `<profile>/st-extension-settings/<key>.json` | `StExtensionSettingsStore`（`packages/iris-compat-st-extension/src/host/settings-store.ts:13`） | 保留 |
| 卡片脚本存储 | `<profile>/card-storage.json` 单文件 | `CardStorageStore` | 与插件无关 |

**第三方插件今天能持久化什么**：什么都不能，合法地。`SystemPluginActivationScope`（`packages/iris-plugin-api/src/index.ts:95`）上只有 `context`、`pluginId`、`revision`、`provide`、`getDependency`、`registerRpc` 六个成员，没有任何落盘面。ST 设置那条路是 `StCompatOptions` 闭包（`packages/iris-app-service/src/service.ts:477`–`:489` 的 `settingsFor`/`persistSettings`，接线在 `index.ts:858` 的 `stCompat` 字面量），只服务试点的那一个 ST 扩展，按 `extensionId()` 取（`index.ts:863`），不是通用接口。
于是插件只剩 `scope.context` 可以乱写——而它是宿主的 Cordis `Context`，在上面挂东西既不是存储也没有 profile 隔离。`docs/INFRASTRUCTURE-INTERFACES.md:341` 那一行「`scope.storage` / `scope.settings` ── 未做」说的就是这件事，完成条件是「路径包含性、原子写、损坏保留、profile lock 全部约束成立后再开放」。profile lock 这一条**已经成立**：`host-lock.ts` 的 `acquireHostLock` 保证一份数据目录只跑一个宿主、无绕过开关（§6 表，`docs/INFRASTRUCTURE-INTERFACES.md:291`），所以 U3 只需要补前三条。

---

## 3. 裁决与实现决策

### 3.1 协调人裁决（不重开）

1. **位置** `<profile>/plugin-data/<id>/`，与安装树分开：一个是代码一个是数据。卸载删代码**不删数据**，与 ST 保留 extension settings 一致。
2. **API** `SystemPluginActivationScope.storage`：`get(key): Promise<unknown | undefined>`、`set(key, value): Promise<void>`、`delete(key): Promise<void>`、`keys(): Promise<string[]>`。
3. **键语法**沿用 `isValidExtensionId`，不造第二个正则；一键一文件 `<key>.json`。
4. **写入**走 `atomicWriteFile`；读到坏 JSON 走 `.corrupt-<ts>` 隔离并返回 `undefined`。
5. **值**里的禁止键按既有规则拒（见纠正 1：即 `assertStorable`）。
6. **上限**单值 1 MiB、单插件 64 MiB，超限 `set` 拒绝，常量带 docblock 说明依据。
7. **权限** `plugin-storage` 进词表；没声明就调用 → 抛命名错误。这是词表第一次带后果。
8. **lease 撤销后的写拒绝**（拆法见纠正 5）。
9. **不迁移 TH/MVU 的现有存储。**

### 3.2 需要施工者决定的（推荐 + 理由）

**D1 · JSON 序列化：用不用 stable stringify？**
推荐 **不用**，`JSON.stringify(value, null, 2) + '\n'`，与 `CardStorageStore`（`card-storage.ts:353`）和 `ScriptVariableStore`（`script-variables.ts:182` 一带）逐字一致。排序键会让同一个值因为写入者构造顺序不同而产生不同字节，买不到任何东西——树里没有任何东西对 plugin-data 取哈希。**什么会推翻它**：哪天 plugin-data 也进 `hashTree` 式的完整性记录，那时排序才有意义，届时在 ledger 里改。
**尺寸按序列化后的字节数量**：`Buffer.byteLength(text, 'utf8')`，不是 `JSON.stringify(value).length`。后者是 UTF-16 码元数，一份中文值的真实字节数约是它的三倍，用它当尺子会让 1 MiB 的闸门在中文值上开到 3 MiB。`CardStorageStore.size()` 用的就是 `Buffer.byteLength`（`card-storage.ts:205`）。

**D2 · 单插件总量怎么算？**
两条路各有坑：
- *每次 `set` 走一遍目录*：O(n) 次 `stat`，一个有 200 个键的插件每写一次就是 200 次系统调用；而且两个并发 `set` 会读到同一个总量、各自通过闸门，两个都写进去。
- *维护一个计数器*：快，但会漂——写完文件与更新计数之间崩溃、或者上一代宿主留下的文件，都会让计数与磁盘不符。
推荐 **计数器 + 每个宿主世代首次使用时一次目录扫描播种**（懒加载，和每个 store 的 `#load` 同形）。漂移因此被限制在一个宿主生命周期内，重启即自愈；两个并发 `set` 由 D3 的串行链排掉。扫描只 `stat` 匹配键语法的 `*.json`，跳过隔离文件与 `.tmp`。

**D3 · 并发。**
推荐**每个插件 id 一条串行 Promise 链**，形状照抄 `ScriptVariableStore` 的 `#queue`（`script-variables.ts:102`、`:201`–`:207`）。差别要写进注释：那边一条链是因为只有一个文件；这边每个键一个文件，链的作用是让**计数器的读-改-写**成为临界区——没有它，闸门可以被两个并发写同时通过。
链挂在 **store 上、按 plugin id**，不挂在 activation 上。这样一次 reload 的旧世代残留写入仍然排在新世代的写入之前，跨 incarnation 的顺序不会翻转。

**D4 · `flush()`。**
推荐镜像 §78：`flush()` 先置 `#closed` 再 `await` 链；之后的 `set`/`delete` 抛 `invalid-request`，消息与 `script-variables.ts:164`–`:165` 同形（「这个宿主已卸载，写入没有保留」）。调用点在 `index.ts:1306` 那个 `irisApp.handlers` effect 的 teardown 里，紧挨 `cardStorage.flush()`（`:1312`）和 `scriptVariables.flush()`（`:1322`）。
读（`get`/`keys`）在关闭后**不拒**：读不会让插件相信自己保存了什么，而拒读只会把关机路径上的诊断变成异常。

**D5 · `keys()` 与隔离文件。**
`keys()` = 读目录 → 只留文件名形如 `<k>.json` 且 `isValidExtensionId(k)` 为真的项 → 返回 `k`，排序后返回（确定性）。隔离文件叫 `<k>.json.corrupt-2026-09-15T10-00-00-000Z`（`atomic.ts:175` 的 `quarantineNameFor`），结尾不是 `.json`，天然不入选；`atomicWriteFile` 的临时文件叫 `<k>.json.<pid>.<hex>.tmp`（`atomic.ts:140`–`:143`），同理。**这个「天然」要有断言**，不能只靠注释——见第 6 节 T9。

**D6 · `get` 的三种无值情况。**
`get` 对「键不存在」和「文件坏掉被隔离了」都返回 `undefined`，插件区分不出来，**这是设计**：与 `readJsonStore`（`atomic.ts:307`）的契约一致，坏文件的事实上报给宿主的诊断面而不是给插件——插件没有能力处理它，能处理的人是用户。第三种「文件在但读不动（权限/IO）」也返回 `undefined`，并同样上报一句，`readJsonStore:321` 已经把这三种分开了，U3 直接用它。
**什么会推翻它**：如果以后插件需要「我确实存过但它坏了」来决定是否重建状态，那就要加一个 `getStatus(key)`，而不是让 `get` 抛。

**D7 · store 绑在 lease 上还是绑在 activation 上？（最容易踩的一处）**
每次写都 `runtime.lease(id)` 是最直白的做法（`registerRpc` 就是这么干的，`system-plugins.ts:939`），但它有一个后果：`lease()` → `assertCurrent()` 要求 `isEnabled()` 为真（`:603` 一带的 `isEnabled`：`enabled && status==='enabled' && activation!==undefined`），而停用流程是 `#invalidate`（status 置 `disabling`）→ `#drain` → `#disposeActivation`（`system-plugins.ts:851`–`:861`）。也就是说**插件自己 `activate` 返回的 dispose 函数里写不了存储**——那正是一个插件最想落盘的时刻。
推荐：storage 闭包持有本次 activation 对象，判定用与 `lease.isCurrent()` 相同的语义（「`plugins.get(id)?.activation` 还是我这一个」，`system-plugins.ts:648` 一带），它在排空与 dispose 期间仍为真；不为真时抛 `unsupported`。顺序安全由 D3 的 store 级链承担，不需要 lease 来排空。
牙齿在第 6 节 T10：**插件 dispose 里的一次 `set` 必须落盘**。这条断言是这个决定的全部价值，没有它就别改。

**D8 · `delete` 一个不存在的键算不算错？**
推荐**不算**，返回即可（`unlink` 的 `ENOENT` 吞掉）。先例是 `CardStorageStore.remove` 对缺席键返回 `undefined` 而不是抛（`card-storage.ts:271`），以及 `clear` 那条「文件存在 = 有人存过东西」的规则（`card-storage.ts:309`–`:313`：空 store 的 clear 不写文件，因为文件存在这件事本身是信息）。同样地：**`plugin-data/<id>/` 目录只在第一次成功 `set` 时创建**，一个从没存过东西的插件不留目录。

**D9 · 1 MiB 单值上限与 card-storage 的先例冲突，要在 docblock 里正面回答。**
`card-storage.ts:33`–`:38` 明写「**故意没有单值上限**」，理由是浏览器没有，一张 2 MB 壁纸在 ST 里存得下就必须在这里存得下。U3 加单值上限并不矛盾，但必须说清差别：卡片存储是在**复刻一个卡片已经活在其中的浏览器 API**，插件存储**没有上游可对齐**，它是宿主新给的服务，闸门是这项服务自己的定价。两个常量的 docblock 互相指一下，理由写在 U3 这边。
64 MiB 的依据写法：与 `PLUGIN_TREE_LIMITS`（PR-2 定的 256 MiB / 20,000 文件，依据是试点树 415 文件 / 102,374,704 字节）同一体例——数据上限比代码树上限低一档是刻意的，代码树是一次性的、数据是持续增长的。

### 3.3 被否决的方案（写在这里，免得施工中途重开）

- **一个插件一份大 JSON（照 `CardStorageStore` 的单文件做法）。** 否决：单文件的每次写都要重新序列化整份 store，`card-storage.ts:46`–`:58` 自己量过是 4 MiB 的 store 每写 2.53 ms；上限又是 64 MiB。一键一文件让写的代价与这一个值的大小成正比，也让一个坏掉的值只损失一个键而不是整个插件的状态——后者正是 `atomic.ts:180`–`:189` 记录的那次事故的形状。
- **复用 `StExtensionSettingsStore`。** 否决：它是 ST 试点那条路专用的（`packages/iris-compat-st-extension/src/host/settings-store.ts:13`），一扩展一个 blob，没有键的概念；而且它自己手写了第三份原子写（`:36`–`:39`：`writeFile` + `rename`，不走 `atomicWriteFile`、不重试、不隔离）。把插件存储接到它上面等于把这三个缺口也继承过来。**顺带**：它的状态是本任务观察到但**不修**的——改它会动 ST 兼容面的行为，不在 U3 范围内，记进 §83 的「看到但没处理」。
- **把 profile 路径直接交给插件，让它自己写。** 否决：`docs/INFRASTRUCTURE-INTERFACES.md:341` 的完成条件第一条就是路径包含性。同权代码当然**能**自己 `fs.writeFileSync`（裁决 1），但宿主提供的那一面必须是有边界的，否则「宿主给了一块地方」和「宿主没给」在文档上就说不清了。
- **给 `get` 一个 `defaultValue` 参数。** 否决：它会把「没存过」和「存过 `undefined`」折叠成一个答案，而 `assertStorable` 根本不让 `undefined` 存进去（`context.ts:90` 的 default 分支）。插件自己写 `?? fallback` 一样短，且语义是它自己的。

---

## 4. 设计

### 4.1 契约侧（`packages/iris-plugin-api/src/index.ts`，只有类型）

```ts
/** A JSON value, as `JSON.parse` can produce and `JSON.stringify` can write. */
export type PluginJsonValue =
  | string | number | boolean | null
  | PluginJsonValue[] | { [key: string]: PluginJsonValue }

/** One plugin's private key–value store under the profile. */
export interface PluginStorage {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: PluginJsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}
```

`SystemPluginActivationScope` 新增 `readonly storage: PluginStorage`，**排在 `registerRpc` 之后、U2 的 `variables` 之前**（任务单 §1 的排序约定）。`SystemPluginRuntimeOptions` 新增 `pluginDataRoot?: string`（缺省表示这台 runtime 不提供存储，现有测试全都这样构造）。
`packages/iris-plugin-api/tests/contract.test.ts` 的规则不受影响：全是类型，零运行时 import。

`get` 的返回是 `unknown` 而不是 `PluginJsonValue`：磁盘上的东西是上一个版本的插件写的，类型是承诺不了的，`unknown` 逼作者自己收窄。写入端收紧、读取端放宽，这是刻意的不对称。

### 4.2 实现模块 `packages/iris-app-service/src/plugins/storage.ts`（新增）

一个 `PluginDataStore` 类，构造参数 `{ root, onProblem, onError }`；对外 `storageFor(pluginId, isCurrent): PluginStorage`、`flush(): Promise<void>`。公开面：

```ts
export const MAX_PLUGIN_VALUE_BYTES = 1_048_576        // D9 的 docblock 在这里
export const MAX_PLUGIN_STORE_BYTES = 64 * 1_048_576

export interface PluginDataStoreOptions {
  /** `<profile>/plugin-data`，来自 `profilePaths`。 */
  root: string
  /** 坏文件/读不动时的一句话；接 index.ts 的 reportStoreProblem。 */
  onProblem?: (message: string) => void
  /** 排队写失败；调用方已经拿到 resolve 了，不能靠抛。 */
  onError?: (error: Error) => void
  /** 两条上限的测试专用覆盖，生产调用点一个都不传。 */
  limits?: { valueBytes?: number, storeBytes?: number }
  /** 隔离名里的时刻，测试用来钉文件名。 */
  now?: () => Date
}

export class PluginDataStore {
  constructor(options: PluginDataStoreOptions)
  /** 一个插件的面；`isCurrent` 是 D7 的身份判定，由 runtime 闭包提供。 */
  storageFor(pluginId: string, isCurrent: () => boolean): PluginStorage
  /** 排空并关闭；之后的写被拒（D4）。 */
  flush(): Promise<void>
}
```

`isCurrent` 由 runtime 传进来而不是把 runtime 传进 store：store 不需要知道插件生命周期是什么，只需要知道「现在还算不算数」。这也让 store 在测试里可以脱离 runtime 单独驱动——第 5 步第 3 小步之所以能在没有调用者的情况下先测完，靠的就是这个。

- `#dirFor(id)` = `join(root, id)`，`#fileFor(id, key)` = `join(#dirFor(id), key + '.json')`；两层守卫：先 `isValidExtensionId`，再 `resolve` 后前缀比对（写法照 `paths.ts:114`–`:123` 的 `fileFor`，那里 `:118`–`:119` 的注释「带子带 braces」就是这一层的存在理由）。`pluginId` 同样两层过一遍——它来自目录行，不是凭空信任的。
- `set`：`assertStorable(value, 'plugin storage value')` → 序列化 → `Buffer.byteLength` 过单值闸门 → 进串行链 → 链里过总量闸门 → `mkdir(recursive)` → `atomicWriteFile` → 更新计数。
- `get`：`readJsonStore(file, onProblem)`（隔离与三种无值都在里面）。
- `delete`：`unlink`，`ENOENT` 吞掉，更新计数。
- `keys`：`readdir` + D5 的过滤 + 排序。
- 常量 `MAX_PLUGIN_VALUE_BYTES = 1_048_576`、`MAX_PLUGIN_STORE_BYTES = 64 * 1_048_576`，各带 D9 的 docblock。

### 4.3 接进 scope（`packages/iris-app-service/src/system-plugins.ts`）

scope 字面量在 `:896`–`:963`。在 `registerRpc` 之后追加 `storage`，取值由一个私有方法算：

- runtime 没有 `pluginDataRoot` → 每个方法抛 `AppError('internal', 'system plugin "<id>" cannot use storage: this host has no plugin data root')`。码选 `internal`，与 `registerRpc` 在 RPC 宿主缺席时的写法一致（`system-plugins.ts:917`–`:920`）：这是宿主接线不全，不是插件的错。
- 插件清单没声明 `plugin-storage` → 每个方法抛 `AppError('invalid-request', 'system plugin "<id>" did not declare the "plugin-storage" permission; add it to iris.plugin.permissions')`。码选 `invalid-request`，与未声明依赖时 `getDependency` 的拒绝同形（`system-plugins.ts:901`–`:907`）。
- 声明了 → 真 store，写入前按 D7 判定 activation 身份，不是当前的抛 `unsupported`。

**成员省略还是抛错的 store？** 推荐**抛错的 store**，不省略。接口成员是非可选的 `readonly storage: PluginStorage`；要允许省略就得写成 `storage?: PluginStorage`，于是每个插件都要写 `scope.storage?.get(…)`，把防御写法变成常态，而且插件分不清「我没声明权限」和「宿主太老没有这个成员」。抛错的 store 把原因说出来，且类型保持非可选。

**清单在哪读？** 目录行的 `permissions` 来自安装时 `parsePluginManifest` 的结果；内置定义没有清单。推荐：runtime 上新增一个私有映射 `id → 已声明权限集`，由 `adoptDefinition` 的调用方（`plugins/install.ts` 的 `#adoptRecorded`）填；**内置插件视为已声明全部**（它们是本仓库源码，同权且随 Iris 发行，让内置去声明一份自己的清单只是仪式）。这条要写进 docblock，因为它是「词表第一次带后果」这句话的一个例外。

### 4.4 词表与那句话的改写（`packages/iris-app-service/src/plugins/manifest.ts`）

- `PLUGIN_PERMISSIONS`（`:88`）按字母序插入 `plugin-storage`。
- docblock（`:51`–`:87`）现在开头就写「**This is a declaration, not a boundary.**」。这句话对其余四个仍然成立，对 `plugin-storage` 不成立。改法：保留原句作为**默认规则**，紧跟一段说明例外——存储是宿主提供的服务，宿主可以真的不给，所以这一条是有后果的；并说清后果的边界：它挡的是 `scope.storage`，挡不住插件自己 `fs.writeFileSync`（同权代码，`docs/SYSTEM-PLUGIN-INSTALL.md:114` 裁决 1）。`:70`–`:77` 的映射表加一行 `| \`plugin-storage\` | \`storage\` |`。
- `packages/iris-app-service/tests/plugin-manifest.test.ts` 里那个从 scope 源码扫成员的测试有一个**硬编码的 `mapping` 字面量**，不加 `'plugin-storage': 'storage'` 就会红在 `unmapped` 那条断言上（消息是「a scope member gained without a permission name…」）。这不是要放宽的断言，是要一起改的映射；同文件的 `members.size >= 6` 下限与 `PLUGIN_PERMISSIONS.length >= 4` 下限都不用动。

### 4.5 路径与接线

- `paths.ts`：`ProfilePaths` 加 `pluginData: string`，带 docblock 说明它与 `systemPluginPackages`（`:317`）的分工——**代码与数据分开，卸载删前者不删后者**——并互相指向，和那里 `<dataDir>/system-plugins/` 的同名警告（`:310`–`:315`）同一体例。`profilePaths` 返回里加 `pluginData: join(root, 'plugin-data')`。
- `index.ts`：`new SystemPluginRuntime({…})`（`:786`）加 `pluginDataRoot: paths.pluginData`；`onProblem` 接 `reportStoreProblem`；teardown（`:1306`）加 `void systemPlugins.flushPluginData().catch(…)`，写法与相邻两句一致。
- **卸载路径不用改**：`install.ts:486`–`:503` 只删 `installedDir(id)` 与 `<clientAssetRoot>/<id>`，`system-plugins.ts:775` 起的 `uninstall` 只动目录行。`plugin-data` 本来就不在这两者之下。**但必须有测试钉住**（T7），否则将来有人往卸载里加一句 rm，没有任何东西会红。

### 4.6 顺带要改的一句注释

`packages/iris-plugin-api/src/index.ts:37`–`:42` 的模块 docblock 现在写着「a storage namespace under the profile … **none of them exists yet**」。这句话在本 PR 之后为假。改它，并按仓库惯例记下它是从哪一版起为真的。文档会过时，注释更会——而注释就在读者手上。

---

## 5. 施工步骤

每一步结束时 `npx tsc -p . --noEmit` 必须是 0。

1. **契约**：`packages/iris-plugin-api/src/index.ts` 加 `PluginJsonValue`、`PluginStorage`、scope 的 `storage` 成员、`SystemPluginRuntimeOptions.pluginDataRoot`，并改 4.6 那句注释。此时 `system-plugins.ts` 的 scope 字面量缺成员 → 编译红，这是预期的。
2. **路径**：`paths.ts` 加 `pluginData`。
3. **实现**：新建 `packages/iris-app-service/src/plugins/storage.ts`，两个常量、`PluginDataStore`、`storageFor`、`flush`。此时它还没有调用者，单独可测。
4. **词表**：`plugins/manifest.ts` 加 `plugin-storage`、改 docblock、加映射表行；同步改 `tests/plugin-manifest.test.ts` 的 `mapping` 字面量。跑 `node --test packages/iris-app-service/tests/plugin-manifest.test.ts` 应绿。
5. **接进 scope**：`system-plugins.ts` 加权限映射、`#storageFor`、scope 字面量的 `storage`、`flushPluginData()`。编译恢复 0。
6. **接线**：`index.ts` 三处（构造参数、onProblem、teardown flush）。
7. **测试**：新建 `packages/iris-app-service/tests/plugin-storage.test.ts`，按第 6 节逐条写；每写一条就跑一次它的牙齿变异。
8. **文档与 ledger**：第 7 节。
9. **门禁与验收**：第 8 节。

---

## 6. 测试与牙齿

文件 `packages/iris-app-service/tests/plugin-storage.test.ts`（命名随 `plugin-manifest.test.ts` / `plugin-install.test.ts` 的既有体例）。每条都要有一次「故意破坏 → 变红 → 还原」的记录进 ledger 牙齿表。

| # | 断言 | 让它变红的改动 |
| --- | --- | --- |
| T1 | 键 `../x`、`C:\x`、`.` 三个都被 `set`/`get`/`delete`/`keys` 拒为 `invalid-request` | 删掉 `isValidExtensionId` 调用（三条都红）；**再单独**删掉 `resolve` 前缀检查（按纠正 3，这一次**不红**，如实记录）；两个都删 → 文件落在目录外，红 |
| T2 | 坏 JSON：手写一个非 JSON 的 `<key>.json` → `get` 返回 `undefined`、目录里出现 `.corrupt-` 文件、原文件不在了、`onProblem` 收到一句；随后一次 `set` 成功且能读回 | 把 `readJsonStore` 换成 `JSON.parse(await readFile(...))` 的 try/catch（隔离消失，红在「`.corrupt-` 文件存在」上） |
| T3 | 单值上限：1 MiB + 1 字节的值被拒，错误消息带两个数字；1 MiB 整的值通过 | 把闸门从 `>` 改成 `>=` 之外的任何放宽；或把尺子换成 `.length`（用一份中文值当夹具，此时红——夹具必须是中文，否则这条变异不红） |
| T4 | 单插件上限：写到 64 MiB 后下一次 `set` 被拒（用测试专用的常量注入缩小尺寸，照 PR-2 `PLUGIN_TREE_LIMITS` 的 test-only override 体例，不要真写 64 MiB） | 去掉总量闸门 |
| T5 | 未声明 `plugin-storage` 的插件调四个方法都被拒，消息点名权限 | 让 scope 无条件给真 store |
| T6 | 两个插件用同名键互不可见：各自目录、各自文件、`keys()` 只见自己的 | 把 `#dirFor` 里的 `id` 去掉（都落进 root） |
| T7 | `uninstall` 之后 `<profile>/plugin-data/<id>/` 仍逐字节存在 | 在 `install.ts` 的 uninstall 里加一句删 `plugin-data/<id>` → 红 |
| T8 | 值里带 `__proto__` / `constructor` / `prototype` 被拒（三个各一次，含嵌套一层） | 删掉 `assertStorable` 调用 |
| T9 | `keys()` 在一次隔离之后不返回隔离文件、不返回残留 `.tmp` 文件（手工放一个 `<k>.json.<pid>.deadbeef.tmp`） | 把过滤从「文件名匹配 `<k>.json` 且 `k` 合法」放宽成「去掉第一个 `.` 之后的部分」 |
| T10 | 插件 `activate` 返回的 dispose 里 `await scope.storage.set(...)` 能落盘（D7 的那一条） | 把身份判定换成 `runtime.lease(id)` → 红（`disabling` 状态下 `isEnabled` 为假） |
| T11 | `flush()` 之后 `set` 被拒为 `invalid-request`，`get` 仍可用；flush 之前排队的写全部落盘 | 去掉 `#closed`；或把 `#closed = true` 挪到 `await this.#queue` 之后（第二个变异是 §78 docblock 点名的那一个，必须也红） |
| T12 | 停用（disable）之后 `set` 被拒为 `unsupported`，且**不是** `invalid-request`（按纠正 5，钉的是拒绝的**种类**） | 把两个拒绝合并成一个码 |

**写 `C:\x` 这类夹具时的陷阱**：本仓库记录过，经 Bash 工具写进文件的字符串里单个 `\` 会被静默吃掉，带引号的 heredoc 也救不了（问题在 shell 之上）。这类字面量**一律用 Write/Edit 工具写**，不要用 `cat <<'EOF'`。检测器是 `grep` 报 `binary file matches`——被吃掉之后 `C:x` 里如果混进了控制字符就会这样报；树里已有 `no-control-chars.test.ts` 作为常设网。写完 T1 之后手工 `grep -n 'C:' packages/iris-app-service/tests/plugin-storage.test.ts` 确认反斜杠还在。

另外两点：
- **不要在断言里钉隔离文件的完整名字**（含时间戳）。`quarantineCorruptFile` 的 `at` 是可注入的（`atomic.ts:206`），用它钉一个固定时刻，比正则匹配时间戳稳。
- **每个循环断言都要有底数**。T1 的三个键写成循环时，末尾 `assert.equal(refused, 3)`；仓库里有过一个 `continue` 让 26 个样本只比了 4 个还是绿的先例。

---

## 7. 文档与 ledger

| 文件 | 改什么 |
| --- | --- |
| `docs/PLUGIN-AUTHORING-RUNBOOK.md` | 新一节「插件私有存储」，放在 §4 的「持久化」之后（`:210`–`:216`）。内容：四个方法的签名与语义、键语法与一键一文件、两个上限与超限时看到什么、`plugin-storage` 必须写进清单否则调用被拒、`get` 对缺席与损坏都答 `undefined`（以及为什么）、卸载保留数据。**并且把 `:216` 那段「通用插件 storage/settings namespace 尚未实现」改掉**——它现在半句为假（`settings` 仍未实现，`storage` 已实现）。 |
| `docs/INFRASTRUCTURE-INTERFACES.md` | §2 表（`:36`–`:49`）加 `scope.storage` 行与 `PluginStorage` 行，`SystemPluginRuntimeOptions` 行的字段列表加 `pluginDataRoot?`；**`:51` 那句「scope 上仍然没有 `storage`、`settings`、`hooks`…」必须改**，否则同一份文档自相矛盾。§6 表（`:282`–`:295`）加一行「插件私有存储 ── `<profile>/plugin-data/<id>/<key>.json` ── 每键一份原子 JSON，坏文件隔离，双上限，`plugin-storage` 权限门」，并把 `:290` 那句「`atomic.ts` **不是**已发布插件存储 API」留着（仍然对：发布的是 `PluginStorage`，不是 `atomic.ts`）。§8 的 `:341` 行改为「**部分闭合**」：`storage` 已做并列出四条约束各自落在哪，`settings` 仍未做。 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | §4（`:112` 起）加一段：`permissions` 的默认读法仍是「声明而非边界」，`plugin-storage` 是第一个例外，说明它挡什么、挡不住什么。 |
| `notes/packages/iris-app-service/DEVIATIONS.md` | §83，标题一句话说清做了什么（例：插件拿到 profile 下的一块私有磁盘，键语法与安装 id 同一套，坏文件留证据，权限词表第一次真的拒绝）。正文含：五条前提纠正、D1–D9 的决定与理由、牙齿表 T1–T12（含 T1 那条**不红**的如实记录）、与 `card-storage.ts:33` 单值上限先例的正面对照。 |

`md-references.test.ts` 会检查本文与上述文档里的每一个 markdown 链接和每一处 `path:line` 引用（`apps/iris/tests/md-references.test.ts:114` 那条测试）。规则：**引用一个本 PR 才新建的文件时不要带行号**——带了就会红在「citation names a file that is not in the tree」，因为存在性查的是 `git ls-files --cached --others`，而那个文件在写文档的那一刻还没有。两个可以钻但不该钻的空子，记下来免得误以为安全：反引号代码段只在**链接**那条测试里被剥掉，引用那条测试不剥；以仓库顶层目录名之外的前缀开头的路径（`plugins/…`）根本不进总体，所以它既不会红也不会被检查——写全路径、不写行号，是唯一两边都对的写法。

---

## 8. 门禁与验收

### 8.1 共同门禁（任务单 §0 第 4 条，逐条跑、原样引用输出）

- 根 `npx tsc -p . --noEmit`
- `apps/iris-web` 里 `npx tsc --noEmit`、`npm run build`（引用 bootstrap check 那行）、`npm run check:render`
- 根 `npm test`（要 `ℹ fail 0`）
- `FORCE_COLOR=0 npm run test:no-corpus`（现为 `40 skipped, 0 failed`；本任务不加语料门测试，数字应不变，变了要解释）
- `node --test apps/iris/tests/md-references.test.ts`

已知偶发红（任务单 §0 第 7 条）：`chat-search.test.ts` 的比例断言、`chat-integrity.test.ts` 的「只报告一次」。若全量只红这两条之一，重跑一次并把两次输出都贴出来。**注意 Node 的类型剥离不做类型检查**：`npm test` 全绿不代表 `tsc` 过，两个都要贴。

### 8.2 U3 专属实测（协调人会在复制的数据目录上起宿主）

做一个 dev 夹具插件，`activate` 里：

```
const before = await scope.storage.get('counter')
await scope.storage.set('counter', { n: (before?.n ?? 0) + 1, at: Date.now() })
scope.provide('probe-storage', { keys: () => scope.storage.keys() })
```

清单 `iris.plugin.permissions` 里带 `plugin-storage`。步骤：

1. 起一个宿主，端口 8788+，**数据目录必须是 `apps/iris/data` 的一份拷贝**（一份数据目录只有一个宿主，`host.lock` 无绕过；端口被占是 `EADDRINUSE` 直接起不来，不会「换个地方起」）。起之前先确认端口是空的。
2. `plugin.previewInstall`（dev 源）→ 同意页 → `plugin.confirmInstall` → `plugin.enable`。
3. 在复制的数据目录下检查 `<profile>/plugin-data/<夹具id>/counter.json` 存在、内容是 `{"n":1,…}`、两空格缩进、结尾有换行。
4. `plugin.disable` → 再触发一次写（经夹具的 RPC 或重新 enable/disable 的时序）→ 写被拒，行上不变成 `error`，宿主日志无 `[E]`。
5. 把清单里的 `plugin-storage` 去掉、重装 → `activate` 抛权限错误 → 行的 `failure.state` 是 `activate-failed` 且 `reason` 里能看到权限名。
6. `plugin.uninstall` → 安装树没了，`<profile>/plugin-data/<夹具id>/` **逐字节还在**。
7. 全程零页面异常、零宿主 `[E]` 行；证据写进 PR 说明（或追加进 `notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` 的新小节，追加就不要改正文）。

---

## 9. 风险

1. **一个插件把盘写满。** 64 MiB 是单插件的，插件数量没有上限，n 个插件就是 n × 64 MiB。本轮不做全局上限（没有地方展示、也没有 UI 让用户清理），但要在 §83 里把它写成**已知且未关**的一条，而不是留给下一个人重新发现。
2. **隔离文件名与键名相撞。** 分析过：隔离名结尾是时间戳不是 `.json`，而键文件名必然以 `.json` 结尾，两个集合不相交。但这是一个**靠命名规约成立**的结论，规约在 `atomic.ts:175`，不在 U3 手上——所以 T9 是断言而不是注释。仓库有过教训：只靠注释保住的那一行不会变红。
3. **Windows 路径长度。** `<dataDir>/<profile>/plugin-data/<id 最多 64>/<key 最多 64>.json`，加上用户的数据目录前缀，接近但通常不超过 260。真超了的表现是 `ENAMETOOLONG` 或 `ENOENT`，`set` 会把它原样抛出去——可接受，但要在 runbook 的那一节提一句「键名别当成路径来用」。
4. **清理目录时的 `rmSync` 空转。** 本机上 `fs.rmSync(dir, { recursive: true })` 在仓库目录内**静默什么都不删**（在 `os.tmpdir()` 下正常，`unlink`/`rename` 正常，bash `rm -rf` 正常）。`scripts/pack-contracts.mjs:263`–`:274` 已经记录并绕开了它：先 `renameSync` 让开，再尽力删。U3 本身**不删目录**（卸载保留数据是裁决），但**测试的清理代码**很可能删——测试夹具目录要么放 `os.tmpdir()` 下，要么照 `pack-contracts.mjs` 的改名让开写法，并且在项目目录下连跑两遍确认真的删掉了。
5. **与 U2 在同两处相撞。** plugin-api 的 scope 接口、`system-plugins.ts:896` 的 scope 字面量。都是追加式，冲突按任务单 §1 的顺序解（`storage` 在 `variables` 前），**按节序两边保留、不改内容**。合并时注意 git 会把闭合的 `},` 与下一个 `/**` 对齐到两侧，append-only 冲突的「两边都留」容易丢掉或复制那一行——解完之后把两个成员各数一遍。

---

## 10. 完成报告模板

```
分支：dev/plugin-scope-storage
最终 commit：<sha>
基线：origin/main 269a97e

与任务单的偏离（前提纠正，五条）：
  1. 没有 forbiddenKeys；复用的是 context.ts:57 的 assertStorable（写面实测 10 处，不是 9）
  2. storage-error 是 stream.error 的码、绑 chatId+turn，不能用；走 index.ts 的 reportStoreProblem
  3. 键语法本身已拒掉 ../x、C:\x、.；包含性检查在单故障下不红，如实记录（先例 §79）
  4. ProfilePaths 与 SystemPluginRuntimeOptions 都要加成员，任务单没提
  5. 「lease 撤销后拒绝」是两个拒绝：停用→unsupported（runtime 既有），宿主卸载→invalid-request（§78）

牙齿表：T1–T12，逐条「改动 → 哪条断言红」；T1 的包含性检查一行标注「单独删不红，两个都删才红，两个方向各测一次」

门禁输出（原样）：
  npx tsc -p . --noEmit          → exit 0
  apps/iris-web npx tsc --noEmit → exit 0
  apps/iris-web npm run build    → bootstrap check <那一行>
  apps/iris-web npm run check:render → ok
  npm test                       → ℹ pass … / ℹ fail 0 / ℹ skipped …
  FORCE_COLOR=0 npm run test:no-corpus → 40 skipped, 0 failed
  node --test apps/iris/tests/md-references.test.ts → 3 pass

U3 实测（复制数据目录，端口 <n>）：7 步逐条结果 + 零 [E] 行

ledger：notes/packages/iris-app-service/DEVIATIONS.md §83
文档：PLUGIN-AUTHORING-RUNBOOK 新节 + INFRASTRUCTURE-INTERFACES §2/§6/§8 + SYSTEM-PLUGIN-INSTALL §4
```
