# U5 施工文档 · 插件自带文案：i18n 命名空间合并

> 状态：已归档（2026-09-17）。工作已全部落地：#101。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

面向施工者。任务单 `notes/INFRA-TASKS-2026-09-15.md` 的 U5 一节是**要求**，本文是**做法**：读完这份就能开工，不必再回去猜任务单每句话落在哪个文件的哪一行。所有行号都是 `269a97e` 的证据，定位以符号名为准。

---

## 1. 任务身份

| 项 | 值 |
| --- | --- |
| 分支 | `dev/plugin-i18n-bundles`（从 `origin/main` `269a97e` 开） |
| PR | 到 `main`，协调人验收合入 |
| Ledger | `notes/apps/iris-web/DEVIATIONS.md` §101（web 侧：覆盖层、UI、`i18n.test.ts` 改接线）、`notes/packages/iris-app-service/DEVIATIONS.md` §84（宿主侧：清单字段、预览期审计、资产面） |
| 基线 | `main` `269a97e`（PR-1/2/3 安装路径全部落地；web ledger 现到 §99，app-service ledger 现到 §80，编号本单已预留） |
| 规模 | 三个包 + 一个 app：`@iris/text`（新纯模块）、`@iris/app-service`（清单、预览、资产面）、`@iris/plugin-web-api`（聚合清单行的形状与两个解析器）、`apps/iris-web`（覆盖层、PluginCenter、`i18n.test.ts` 改接线）。协议包 `@iris/protocol` 只加一个可选字段 |
| 并行邻居 | U3 也改 `packages/iris-app-service/src/plugins/manifest.ts`，但区域不同（U3 动权限词表 `PLUGIN_PERMISSIONS`，本任务动 `parsePluginManifestValue` 的字段解析与 `parsePluginManifest` 的文件校验）。任务单约定：`manifest.ts` 的新字段 `i18n` 放在 `client` **之后**（`manifest.ts:263`–`:268` 那个分支之后） |

---

## 2. 前提纠正与现状

### 2.1 前提纠正（代码赢）

任务单 U5 有四处与 `269a97e` 的代码不符，开工前先记下，PR 说明第一段照抄：

**纠正 1 · 「`parsePluginManifest` 之后、`hashed` 之前」这个窗口在 preview 里不存在。**
`SystemPluginInstallService.preview`（`packages/iris-app-service/src/plugins/install.ts:276`）先调 `installer.stage`，而 `stage` 内部的顺序是：物化 → 删 `.git` → **artifact contract 校验**（`packages/iris-extension-installer/src/installer.ts:199`，对系统插件就是 `SYSTEM_PLUGIN_ARTIFACT_CONTRACT`，它自己调 `parsePluginManifest`，`packages/iris-app-service/src/plugins/manifest.ts:522`）→ `auditContainment` → `hashTree` → 事务转到 `hashed`（`installer.ts:205`–`:206`）。等 `stage` 返回，树**已经**哈希过了；`preview` 在 `install.ts:314` 又调了一次 `parsePluginManifest`，那一次在 `hashed` **之后**。所以「`hashed` 之前」只有一个落点：契约里。做法见 §4.3——**审计放进契约**，`preview` 第二次解析时复用已解析结果做展示，两处都不重复读文件的策略也在那里说。

**纠正 2 · 聚合清单的类型不在 `@iris/protocol`，在 `@iris/plugin-web-api`。**
`PluginAssetEntry` / `PluginAssetManifest` 定义在 `packages/iris-plugin-web-api/src/index.ts:195` 与 `:225`，`PLUGIN_ASSET_PREFIX` 在 `:189`。`packages/iris-protocol/src/system-plugins.ts` 里只有 `SystemPluginInstallPreview`（`:121`）和 `SystemPluginView`。任务单说「聚合清单（`plugin-assets.ts` 的 `plugins[id]`）多一个 `i18n?`」——`plugin-assets.ts:174` 只是**构造**那一行，形状的事实源是 plugin-web-api。

**纠正 3 · 聚合清单今天只收「已启用且磁盘上有 client bundle」的插件。**
`PluginAssetStore.manifest`（`packages/iris-app-service/src/plugin-assets.ts:168`）对每个已启用 id 求 `#rev(id)`，`undefined` 就 `continue`（`:172`–`:173`），而 `#rev` 读的是 `<id>/client/client.js`（`:133`）。因此**一个只带文案、不带 `client.js` 的插件今天在清单里没有行**，它的 i18n 也就没有 URL。任务单默认「加一个可选字段就行」，实际要动的是**成行条件**与 `PluginAssetEntry.client` 的必填性，连带两个解析器（见 §3 决策 D3）。

**纠正 4 · 两个清单解析器会把不认识的字段**悄悄丢掉**，不是报错。**
`parsePluginAssetManifest`（`plugin-web-api/src/index.ts:242`）逐行重建 `plugins[id] = { rev, client }`（`:272`），`parsePluginRows`（`:152`）同样重建（`:169`）。所以只在 `plugin-assets.ts` 里把 `i18n` 写进 JSON 而不改解析器，浏览器侧读到的永远是 `undefined`，而且没有任何一处报错——宿主测试和 web 测试会**各自绿着**，中间那道手抄把字段丢了。这正是「两侧测试隔着接缝对望」的形状，所以 §6 要求一条端到端断言。

### 2.2 现状：文案今天怎么上屏

| 环节 | 事实 |
| --- | --- |
| 字典 | `apps/iris-web/src/app/i18n/strings.ts`：`Language`（`'en'`/`'zh'`，`:25`）、`en`（`:31`，键的**源**）、`StringKey = keyof typeof en`（`:1744`）、`zh: Record<StringKey, string>`（`:1753`）、`DICTIONARIES`（`:3109`） |
| 取词 | `interpolate(template, params)` 只替换 `{name}` 槽位（`:3121`）；`translate(lang, key, params)` 取 `DICTIONARIES[lang][key] ?? en[key]`，无参数就不插值（`:3134`） |
| React 侧 | `useLanguage()` 用 `useSyncExternalStore` 订阅（`apps/iris-web/src/app/i18n/use-language.ts:29`）；`t(key, params)` 读当前语言但**不订阅**（`:41`） |
| 语言状态 | 模块级外部 store：`getLanguage`（`apps/iris-web/src/app/i18n/language.ts:58`）、`setLanguage`（`:70`）、`subscribeLanguage`、`detectLanguage`（`:50`），持久化在 `localStorage` 的 `iris.language`（`:34`）。**这就是覆盖层要照抄的形状** |
| 插件行文案 | PluginCenter 行显示 `plugin.name` / `plugin.description`（`apps/iris-web/src/app/PluginCenter.tsx:693`–`:697`），只有两个内置 id 用壳里的键覆盖描述：`DESCRIPTION_KEYS`（`:59`–`:62`），`:669`–`:670` 是那个二选一 |
| 插件今天带不了文案 | PR-3 的 85 个键全在 `strings.ts` 里写死；宿主侧没有任何登记翻译的接口。`docs/INFRASTRUCTURE-INTERFACES.md:344` 的 §8 行说的就是这件事 |

同名不同物，先撇清：`apps/iris-web/src/st-extensions/projection-i18n.ts` 是 **ST 设置面板的 DOM 就地翻译**（记录原值、按 `data-i18n` 槽位回写），和「键→字符串的字典覆盖层」是两回事，不复用、不合并。

### 2.3 现状：`i18n.test.ts` 的三条审计怎么实现的

`apps/iris-web/tests/i18n.test.ts`，本任务要把这三条的**规则**搬进 `@iris/text`：

1. **两列键集合相等**（`:19`–`:23`）：`Object.keys(en).sort()` 与 `Object.keys(DICTIONARIES.zh).sort()` 做 `deepEqual`。
2. **zh 值含中文**（`:25`–`:55`）：CJK 正则 `/[㐀-鿿]/`（`:30`），外加一张 14 个键的 `neutral` 白名单（`:45`–`:50`，`topP`、`tokensThousand`、`usageRate`、`commandRow` 这类纯数字/单位格式行），命中白名单就 `continue`。
3. **占位符两列一致**（`:57`–`:66`）：`slots(value)` 把 `{name}` 抽成**去重排序后的集合**（`:61`–`:62`），逐键 `deepEqual`，失败信息是 `placeholder drift on "<key>"`。注释写明了为什么比集合不比重数。

另有两条与本任务相关但**不搬**的：`:196` 的「源码里每个 `t('key')` 都真实存在」——它的扫描正则是 `/(?<![A-Za-z0-9_$.])t\('([A-Za-z0-9]+)'/g`（`:202`），**字符类里没有冒号**，所以 `plugin:<id>:<key>` 这种键天然不会被它扫到，插件键不会污染这条审计（已核对，不需要改它，也不许为了「保险」去放宽它）；`:209` 的 `used.size > 100` 是下界，不是计数。

### 2.4 现状：资产面怎么发一个文件、怎么撤一个文件

| 项 | 事实 |
| --- | --- |
| 路由 | `PluginAssetStore.serve`（`packages/iris-app-service/src/plugin-assets.ts:186`）：非 GET/HEAD → 405；不在 `/plugins/` 前缀下 → 404（`:203`）；`manifest.json` 分支 → `no-cache` 的 JSON（`:218`–`:231`） |
| 落盘位置 | `<dataDir>/system-plugins/<id>/client/client.js`（`#clientDir`，`:123`；挂载点 `packages/iris-app-service/src/index.ts:1456`）。安装树在别处：`<profile>/system-plugins/installed/<id>/`。两者由 `#publishClientBundle` 复制连接（`packages/iris-app-service/src/plugins/install.ts:727`–`:731`），启用/开机各走一次（`:461`、`:633`） |
| rev | `#rev(id)`（`:132`）：`stat` 取 `(mtimeMs, size)` 当记忆键（`#revs`，`:115`，**键只有 id，一个插件一个条目**），未命中就读全文算 sha1 前 12 位（`:153`） |
| 停用即 404 | `serve` 每次请求现读状态，`!state.enabled.has(id)` → 404（`:255`），与清单不给行是同一个判断的两半 |
| 缓存方向 | `?rev=` 等于当前 rev 才发 `immutable`，否则 `no-cache`（`:294`–`:299`） |
| 卸载 | `uninstall` 直接 `rm -rf <clientAssetRoot>/<id>`（`install.ts:500`），**整目录**——i18n 文件放同一目录下就随之消失，不需要新的清理代码 |
| 已有测试 | `packages/iris-app-service/tests/plugin-assets.test.ts`（7 条，`:80` 清单即启用态、`:180` 停用即 404）、`apps/iris-web/tests/plugin-browser-assets.test.ts`（分类与成员扫描，无网络） |

### 2.5 现状：同意页展示什么

`PluginConsent`（`apps/iris-web/src/app/PluginCenter.tsx:534`）是**导出的纯组件**，把 `SystemPluginInstallPreview` 除 `previewToken` 外的每个键渲染成一行 `data-consent-field=<协议键>`（`:558`–`:600`，`ConsentField` 在 `:623`）。`apps/iris-web/tests/plugin-center.test.ts:299`–`:301` 拿 `Object.keys(preview)` 与页面上抓到的 `data-consent-field` **做集合比较**：**协议里加一个字段而同意页不渲染，测试就红**。这是本任务自带的一副牙齿，不需要新造。

⚠️ 那条抓取正则是 `/data-consent-field="([a-zA-Z]+)"/g`（`:298`，dev 版 `:328`），**字符类里没有数字**：字段名叫 `i18n` 时它一个都抓不到，于是 `shown` 缺 `i18n`、`expected` 有 `i18n`，断言以「同意页从不渲染的字段」变红——**信息是对的，原因是错的**。必须把两处正则放宽成 `[a-zA-Z0-9]+`。这不是弱化：放宽扫描器让它**多**比较一个此前看不见的字段，比较集合变大，是收紧。改动与理由写进 ledger §101。

---

## 3. 裁决与待定决策

### 3.1 协调人裁决（不再讨论，照做）

| # | 裁决 |
| --- | --- |
| R1 | 清单 `iris.plugin` 新增**可选**字段 `i18n: { en, zh }`；**一旦出现，两种语言都必须有**，缺 `zh` 是 `manifest-invalid` 且 `field` 为 `i18n.zh`（缺 `en` 同理为 `i18n.en`） |
| R2 | 文件内容是平坦 `Record<string, string>`；键语法 `/^[a-zA-Z][a-zA-Z0-9]*$/` |
| R3 | **预览期审计**：跑与 `i18n.test.ts` 相同的三条规则；违规 → `manifest-invalid`，`field` 形如 `i18n.zh.someKey` |
| R4 | 三条规则的**实现只有一份**，放 `@iris/text`（零依赖包，成员规则见 `docs/ARCHITECTURE.md:34` 与 `packages/iris-text/src/index.ts:1` 的模块注释），`i18n.test.ts` 改为调用它 |
| R5 | 下发走现有资产面：`/plugins/<id>/i18n/<lang>.json?rev=`；聚合清单行多一个 `i18n?: Record<Language, string>`；停用即 404 的既有规则自然覆盖 |
| R6 | 壳侧运行期**覆盖层**，键名前缀 `plugin:<id>:`；静态 `StringKey` 类型**不动**；缺失回退 `zh → en → 键名本身`（可见的失败，不是空白） |
| R7 | 同意页多一行「文案：N 条 · en/zh」；PluginCenter 行的 `displayName`/`description` 若插件文案里有同名键则按当前语言显示 |

### 3.2 施工者要做的决策（含建议）

**D1 · 一份 bundle 的体积上限。**
今天只有整包上限 `PLUGIN_TREE_LIMITS = { maxBytes: 256 MiB, maxFiles: 20_000 }`（`packages/iris-app-service/src/plugins/install.ts:111`），但覆盖层是**常驻内存**的，和树上的死重不是一回事。
**建议**：在 `@iris/text` 的规则模块里定两个常数，`PLUGIN_COPY_LIMITS = { maxBytes: 256 * 1024, maxKeys: 2_000 }`，**单份文件**计（不是两份之和），超出 → `manifest-invalid`，`field` 为 `i18n.zh`，理由句里带实测值与上限。理由：256 KiB 大约是 `strings.ts` 两列的量级（整个壳的 en+zh 合计 ~3141 行源码），一个插件的文案不该比整个壳还大；2000 键是 UI 侧「N 条」这句话仍然有意义的上界。和 `PLUGIN_TREE_LIMITS` 一样提供 test-only override，否则拒绝分支没法被跑到。

**D2 · 两个文件的 `rev` 怎么算。**
`#revs` 今天是 `Map<string, {mtimeMs, size, rev}>`，**键就是 id**（`plugin-assets.ts:115`），`#rev(id)` 写死读 `client/client.js`（`:133`）。
**建议**：**一文件一 rev**，把记忆键换成相对资产路径（`<id>/client/client.js`、`<id>/i18n/en.json`），`#rev` 改签名为 `#rev(id, relative)`。理由：记忆键是**那一个文件**的 `(mtimeMs, size)`，一个插件一个合并 rev 就必须 stat 全部文件才能判命中，既贵又把「en 变了」和「client 变了」混成一个失效事件，白刷缓存。代价是清单里一行携带三个 rev（bundle 的在 `rev`，两份文案的 URL 各自带 `?rev=`），可以接受——URL 里已经有 rev，行上不必再列。
**不建议**的做法：给整个插件算一个 rev 再让三个 URL 共用。`immutable` 的正确性依赖「地址由内容决定」（`:288`–`:294` 的注释就是讲这个），共用 rev 会让改 en 之后 zh 的地址也变、旧地址仍 `immutable`——缓存正确但白失效；更糟的是反过来（漏失效）在实现里只差一个 `continue`。

**D3 · 没有 `client.js` 的插件怎么进清单（纠正 3 的落点）。**
**建议**：`PluginAssetEntry.client` 改为**可选**，成行条件从「有 bundle」放宽为「有 bundle **或** 有文案」，两个解析器（`parsePluginAssetManifest` `plugin-web-api/src/index.ts:242`、`parsePluginRows` `:152`）同步：`client` 存在则仍校验前缀与 rev，不存在则跳过；`i18n` 存在则校验每个值都在 `/plugins/` 前缀下。理由：宿主插件完全可以只带 `displayName`/`description` 两个键而不带浏览器代码，R7 明确要求这种插件的名字能翻译；让它为了一行文案硬塞一个空 `client.js` 是把格式的缺陷转嫁给作者。
**代价与守则**：`sandboxPluginRuntime`（`plugin-web-api/src/index.ts:88`–`:102`）把清单行原样抄进帧的 meta，`client` 变可选之后**帧侧必须容忍没有 `client` 的行**（今天 `parsePluginRows:166` 无条件要求它）。帧不需要 i18n（卡片不读壳的文案），所以更省事的第二选择是：**帧的 meta 只抄 `{ rev, client }` 两个键**，i18n 只活在壳读的那份聚合清单里。**建议取第二选择**——meta 是承重面，能不变就不变；在 `sandboxPluginRuntime` 里显式投影出 `{ rev, client }` 并写明理由，同时 `parsePluginRows` 仍要接受「没有 client 的行」，因为它解析的是**同一份 JSON**。这一条要在 ledger §84 里写清两份消费者的差别。

**D4 · 覆盖层的 API 形状。**
`translate(lang, key: StringKey, params?)`（`strings.ts:3134`）。两条路：
(a) 新函数 `translatePlugin(pluginId, key, params?, lang?)`；(b) 给 `translate` 加一条 `plugin:` 分支，参数类型放宽成 `StringKey | PluginCopyKey`（`PluginCopyKey = \`plugin:${string}:${string}\``）。
**建议 (b)，用 (a) 做实现**：`translatePlugin(lang, pluginId, key, params?)` 是实现，`translate` 在 `key` 以 `plugin:` 开头时委托过去——裁决 R6 的字面要求（「`translate` 只对 `plugin:` 前缀查覆盖层」）就此满足，调用方只有一扇门，实现只有一份。类型上是**加宽参数**，对现有调用点是源码兼容的；`StringKey` 本身一个字符都不动，插件键仍然进不了静态类型（拼错的静态键照旧是类型错误，因为 `'sendd'` 不属于并集里的任何一支）。`t()`（`use-language.ts:41`）保持 `StringKey` 窄签名，另出一个 `tPlugin(pluginId, key, params?)`，**它必须订阅覆盖层**（见 D5）。

**D5 · 覆盖层什么时候重载、谁持有它。**
**建议**：模块级外部 store `apps/iris-web/src/app/i18n/plugin-copy.ts`，形状照抄 `language.ts`（`getPluginCopy` / `setPluginCopy` / `dropPluginCopy` / `subscribePluginCopy`，React 侧 `usePluginCopy()` 走 `useSyncExternalStore`）。装载由**一个**新 hook 负责，挂在 `App.tsx` 这一层（`apps/iris-web/src/app/App.tsx` 已经 `useLanguage()`），输入是聚合清单：
- 触发时机跟着清单，不跟着 `plugins.changed` 本身：`usePluginAssetManifest(revision)`（`use-plugin-manifest.ts:43`）已经是「每个快照 revision 拉一次」，而 `plugins.changed` 正是推 revision 的那条事件（`apps/iris-web/src/client/store.ts:3735`–`:3738` → `adoptSystemPluginSnapshot` `:1461`）。
- **按 `(id, lang, rev)` 三元组去重**：清单行里 i18n 的 URL 带 `?rev=`，rev 没变就不重拉（这就是 R5 那条 `immutable` 的用处）。
- **清单里没有的 id 一律从覆盖层里删**——停用的插件在清单里没有行（`plugin-assets.ts:171` 只遍历 `state.enabled`），于是它的文案在下一次清单到达时消失，不需要第二套失效逻辑。这同时回答了「停用后文案怎么消失」。
**不建议**把装载放进 `PluginCenter`：那个组件因为 `SettingsPage` 渲染所有路由、只隐藏非激活页而**从不卸载**（PR-3 因此给它加了 `active` prop，`PluginCenter.tsx:164`），用它做生命周期的锚点会把「页面是否可见」和「文案是否在场」绑在一起。

**D6 · `check:render` 怎么覆盖插件文案。**
`apps/iris-web/tools/render-check.tsx` 是 SSR，没有 effect、没有 fetch（`:205` 的注释明说 SSR 下 asset 状态只会是 `loading`）。
**建议**：两处，都不引入 seam。①同意页：`PluginConsent` 是纯组件，直接用一个带 `i18n` 的 preview 渲染，断言「文案：2 条 · en/zh」的两语言句子各出现一次。②行文案：在渲染 PluginCenter **之前**调 `setPluginCopy('demo', { en: {...}, zh: {...} })` 把覆盖层喂上（模块级 store 的好处就在这里），断言行上显示的是 bundle 里的 `displayName` 而不是快照里的 `name`，再 `setLanguage('zh')` 渲染一次断言换了语言。渲染完 `dropPluginCopy('demo')` 复原，别把状态漏给后面的用例。

---

## 4. 设计

### 4.1 `@iris/text` 新模块 `copy.ts`

新增 `packages/iris-text/src/copy.ts`，由 `src/index.ts` 再导出（今天那里只有两行，`:39`–`:40`）。**零导入**——`purity.test.ts:25` 扫源码里所有 `from '...'`，非相对路径即失败（`:31`–`:34`）；因此**读文件的事一律不在这里做**，本模块只接收两个已经解析好的对象。

```ts
export const PLUGIN_COPY_LANGUAGES = ['en', 'zh'] as const
export type CopyLanguage = typeof PLUGIN_COPY_LANGUAGES[number]

export const PLUGIN_COPY_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/   // 裁决 R2
export const PLUGIN_COPY_LIMITS = { maxBytes: 262_144, maxKeys: 2_000 }  // 决策 D1

export interface CopyAuditFailure { readonly field: string; readonly reason: string }

/** 槽位集合：去重 + 排序，与 i18n.test.ts:61 同义。 */
export function copySlots(value: string): readonly string[]

/** 一列文案自身的合法性：键语法、值是字符串、条数上限。 */
export function auditCopyTable(table: Record<string, string>, field: string): CopyAuditFailure | null

/** 三条规则：键集合相等、zh 含中文、占位符集合一致。field 形如 `i18n.zh.someKey`。 */
export function auditBilingualCopy(
  en: Record<string, string>,
  zh: Record<string, string>,
  options?: { readonly neutralKeys?: ReadonlySet<string>, readonly field?: string },
): CopyAuditFailure | null
```

设计要点，逐条对齐既有实现：

- **`neutralKeys` 是参数，不是内建表。** 壳自己那 14 个键的白名单（`i18n.test.ts:45`–`:50`）是**壳的**事实，不是规则的一部分；插件那一侧传空集。规则模块内建一张壳的白名单就是把消费者写进实现。
- **CJK 正则照抄 `/[㐀-鿿]/`**（`i18n.test.ts:30`），不「顺手改进」。两个消费者必须算出同一个答案，这正是 `@iris/text` 的成员理由；今天壳里的判定是什么，规则就是什么，要改是另一个任务。
- **返回 `null | {field, reason}`，不抛。** `parsePluginManifestValue` 的整套风格就是返回带 `field` 的失败（`manifest.ts:184` 的 `invalid()`），而 `i18n.test.ts` 那侧只需要把 `reason` 放进断言消息。
- **`field` 前缀由调用方给**：宿主传 `'i18n'` 得到 `i18n.zh.someKey`；`i18n.test.ts` 传 `'zh'` 之类，让失败消息读起来仍像今天的 `placeholder drift on "<key>"`（消息可以更好，但**不许更弱**）。
- `purity.test.ts:39` 的 `files.length >= 3` 是「扫到的文件数不能是 0」的下界，加了第四个文件仍然成立，**不要去改那个数字**。

### 4.2 清单解析：`manifest.ts`

1. `SystemPluginManifest`（`:131`）在 `client`（`:143`）**之后**加：
   ```ts
   readonly i18n?: { readonly en: string, readonly zh: string }
   ```
   （并行约定：本字段放 `client` 之后。）
2. `parsePluginManifestValue`（`:227`）在 `client` 分支（`:263`–`:268`）之后插入 `i18n` 分支：块必须是对象（否则 `field: 'i18n'`）；**两个键都必须在**——缺哪个就报哪个（`i18n.en` / `i18n.zh`，裁决 R1）；每个值都过 `checkTreePathShape(value, 'i18n.' + lang)`（`:382`，反斜杠、绝对路径、盘符、空段、`.`、`..`、控制字符），与 `host`/`client` **同一条文法**，不另造。
3. `parsePluginManifest`（`:485`）在 `client` 的 `resolveTreePath` 之后（`:503`–`:506`）对两份文件同样做 `resolveTreePath`（`:419`，逐段 `lstat`、拒符号链接/junction、必须是普通文件）。**到此为止只校验路径**，不读内容。
4. **内容审计放哪**：见 §4.3。

### 4.3 预览期审计的落点

纠正 1 说明「`hashed` 之前」只有契约里一个窗口。**建议实现**：

- 在 `manifest.ts` 里新增 `auditPluginCopy(contentDir, manifest): Promise<PluginManifestInvalid | { ok: true, keys: number } >`：读两份文件（`JSON.parse` 失败 → `field: 'i18n.<lang>'`）、逐列 `auditCopyTable`、再 `auditBilingualCopy`。它需要 `node:fs`，所以留在 app-service，不进 `@iris/text`。
- `SYSTEM_PLUGIN_ARTIFACT_CONTRACT.validate`（`:522`–`:528`）在 `parsePluginManifest` 成功后调它，失败抛 `PluginManifestError`。于是：**安装路径上的审计发生在 `hashed` 之前、任何字节被提升之前**，并且 `#stageFailure`（`install.ts:752`）已经会把 `PluginManifestError` 还原成带 `field` 的 `manifest-invalid`（`:756`–`:757`），**不需要新的错误映射**。
- `preview`（`:276`）里第二次 `parsePluginManifest`（`:314`）之后，为了填 `i18n.keys` 再调一次 `auditPluginCopy` 拿键数。**两次读同一份小文件是可接受的**（契约那次的结果不跨 `stage` 边界传回来；把它塞进 `StagedInstall` 会改动 7 个 artifact-blind 模块之一的类型，代价大得多）。这条权衡写进 ledger §84。
- 开机扫描 `#adoptRecorded`（`install.ts:609`）走的也是 `parsePluginManifest`，**不**走契约。裁决没有要求开机重跑内容审计；`git` 行的树已被哈希复核（`:588`–`:606`），`dev` 行按裁决 1 本来就不复核。**建议**：开机不审计内容，但**发布文案文件时**若 `JSON.parse` 失败则不发布该行的 i18n 并在日志里点名（`this.#log`，`:536` 同款），行仍然可用——文案坏掉不该让一个能跑的插件下线。此判断写进 ledger。

### 4.4 资产面

- `plugin-assets.ts` 加 `const I18N_DIR = 'i18n'`，路径 `<id>/i18n/<lang>.json`；`#revs` 改为按相对路径记忆（决策 D2）。
- `manifest()`（`:168`）：成行条件放宽（决策 D3），行形状变成 `{ rev?, client?, i18n? }`，`i18n` 是 `Record<'en'|'zh', string>`，值形如 `/plugins/<id>/i18n/zh.json?rev=<12hex>`。键仍然排序输出（同一状态同样的字节，`:163`–`:164` 的理由不变）。
- `serve()`（`:186`）：在 `client.js` / `.map` 的后缀判断（`:233`–`:240`）旁边加 i18n 分支——`rest` 形如 `<id>/i18n/en.json`，**语言名必须在 `PLUGIN_COPY_LANGUAGES` 里逐字匹配**（不要用「去掉 `.json` 的任意段」当文件名，那等于把目录列表暴露给 URL）。`safePluginId`（`:86`）、停用即 404（`:255`）、containment（`:273`）、`?rev=` 缓存判断（`:294`–`:299`）**全部复用**，一个字节都不新写。`content-type` 用 `application/json; charset=utf-8`。
- 发布：`#publishClientBundle`（`install.ts:727`）旁边加 `#publishCopyBundles(id, root, manifest)`，复制到 `<clientAssetRoot>/<id>/i18n/<lang>.json`；两个调用点（`:461` 确认安装、`:633` 开机采纳）各加一行。卸载不用动：`:500` 删整个 `<clientAssetRoot>/<id>`。

### 4.5 协议与同意页

- `SystemPluginInstallPreview`（`packages/iris-protocol/src/system-plugins.ts:121`）在 `hasClient`（`:155`）之后加：
  ```ts
  /** 包自带的界面文案，缺省表示没有。languages 恒为两种，见 §12 裁决。 */
  i18n?: { keys: number, languages: string[] }
  ```
- `packages/iris-client-fake/src/plugins.ts:199` 的 `previewInstall` 同步给出这个字段（fake 必须是穷尽的），值取固定的 `{ keys: 2, languages: ['en', 'zh'] }`。
- `PluginConsent`（`PluginCenter.tsx:534`）加一行 `ConsentField name="i18n"`，文案键 `pluginCenterConsentCopy` + `pluginCenterConsentCopyNone`，句子形如「文案：12 条 · en/zh」/「Bundled copy: 12 strings · en/zh」。**同意页只陈述事实，不做承诺**——不要写「Iris 会校验这些文案」之类，审计发生在预览期，页面上说的是这个包带了多少条。
- `plugin-center.test.ts:298` 与 `:328` 的抓取正则放宽成 `[a-zA-Z0-9]+`（§2.5），并在测试的 preview 字面量（`:276`）里加上 `i18n`。

### 4.6 壳侧数据流

```
plugins.changed → store.systemPlugins.revision
      → usePluginAssetManifest(revision)            (use-plugin-manifest.ts:43)
      → usePluginCopyLoader(manifest)   [新]  按 (id, lang, rev) 去重拉取
      → setPluginCopy / dropPluginCopy  [新]  模块级外部 store
      → translate(lang, 'plugin:<id>:<key>')  ←  translatePlugin 实现  (strings.ts)
      → PluginCenter 行 / 同意页 / 任何将来的插槽
```

回退链（裁决 R6）：`覆盖层[lang][plugin:id:key]` → `覆盖层.en[...]` → **返回键名本身**（例如 `plugin:demo:panelTitle`）。不返回空串：空白是查不出来的失败。

行文案（裁决 R7）：`PluginCenter.tsx:669`–`:670` 现有的二选一扩成三选一——壳的 `DESCRIPTION_KEYS` 优先（两个内置行的描述是壳自己的句子，这条不能被插件夺走），其次覆盖层里的 `plugin:<id>:description`，最后快照里的 `plugin.description`；`displayName` 同理对 `plugin.name`（`:696`）。**显示插件自带名字的那一行必须订阅覆盖层**，否则文案到货后不会重渲。

---

## 5. 施工步骤

顺序的要点只有一个：**让 `i18n.test.ts` 在它的实现搬家过程中始终是绿的**。做法是「先加新实现、让旧测试改调新实现、再删旧的内联代码」，任何一步都不留下红。

1. **`@iris/text/copy.ts`**（§4.1）+ `packages/iris-text/tests/copy.test.ts`。此时没有任何消费者，`purity.test.ts` 与 `architecture.test.ts:226` 应仍绿（新模块零导入）。跑 `node --test packages/iris-text/tests/*.test.ts`。
2. **`i18n.test.ts` 改接线**：三条审计的**规则部分**换成调用 `auditBilingualCopy`（白名单作为参数传入），断言消息保留原有信息量。这一步**不**改 `strings.ts`。跑 `apps/iris-web` 的 `i18n.test.ts`：仍然全绿，并且在这一步就已经证明「一个实现两个消费者」的第一个消费者接上了。
3. **`manifest.ts`**：类型 + `parsePluginManifestValue` 的 `i18n` 分支 + `parsePluginManifest` 的路径解析 + `auditPluginCopy` + 契约里调用（§4.2、§4.3）。扩 `packages/iris-app-service/tests/plugin-manifest.test.ts`。
4. **`install.ts`**：preview 填 `i18n`、`#publishCopyBundles` 与两个调用点（§4.4）。扩 `plugin-install.test.ts`（带文案的 dev 夹具）。
5. **`@iris/plugin-web-api`**：`PluginAssetEntry` 加 `i18n?`、`client` 转可选、两个解析器与 `sandboxPluginRuntime` 的投影（§4.3 决策 D3）。扩该包自己的测试。
6. **`plugin-assets.ts`**：rev 记忆键、清单成行条件、i18n 路由（§4.4）。扩 `plugin-assets.test.ts`。
7. **协议 + fake + 同意页**（§4.5）。这一步会让 `plugin-center.test.ts` 先红（集合比较），按 §2.5 放宽正则并补 preview 字面量后转绿。
8. **壳侧覆盖层**：`plugin-copy.ts`、`translate` 的 `plugin:` 分支、`tPlugin`、装载 hook、`App.tsx` 挂载、PluginCenter 行的三选一（§4.6）。
9. **`check:render` 两处**（决策 D6）。
10. **文档与 ledger**（§7），最后跑全套门禁（§8）。

第 5 步与第 6 步之间不要停：清单字段加了而解析器没跟上，正是纠正 4 那条接缝。

---

## 6. 测试与牙齿

每条断言都要有一次**故意破坏使其变红**的记录，做成表进 ledger。下表左列是断言，右列是让它变红的那个改动。

### 6.1 任务单点名要求的六条

| # | 断言（文件） | 变红的改动 |
| --- | --- | --- |
| T1 | 清单只写 `i18n.en`、不写 `i18n.zh` → `manifest-invalid`，`field === 'i18n.zh'`（`plugin-manifest.test.ts`） | 把「两个键都必须在」的检查改成「至少一个」 |
| T2 | 两列占位符不一致 → 拒绝，且 `field` **点名那个键**（`i18n.zh.greeting`）（`plugin-manifest.test.ts`） | `auditBilingualCopy` 里把 `field` 退回成 `'i18n'`（丢掉键名） |
| T3 | zh 全英文 → 拒绝（`plugin-manifest.test.ts` + `copy.test.ts` 各一条） | 去掉 CJK 检查 / 把 CJK 正则换成 `/./` |
| T4 | 停用后请求 `/plugins/<id>/i18n/zh.json` → 404，且清单里没有该行（`plugin-assets.test.ts`） | 把 i18n 分支写在 `:255` 那道启用闸门**之前** |
| T5 | 覆盖层不污染静态键：一个插件声明 `pluginCenterTitle`，`translate(lang, 'pluginCenterTitle')` 仍是壳的字符串（`apps/iris-web/tests/plugin-copy.test.ts`，新） | 让覆盖层在 `translate` 里先于静态字典查（或让装载时不加 `plugin:<id>:` 前缀） |
| T6 | 切语言后插件文案跟着换（同上，先 `setPluginCopy` 两列，再 `setLanguage('zh')`） | `translatePlugin` 里把 `lang` 参数忽略、恒读 `en` |

### 6.2 施工者补的

| # | 断言 | 变红的改动 |
| --- | --- | --- |
| T7 | `@iris/text` 仍然零导入（`purity.test.ts:25` 已有，**新模块自动纳入**） | 在 `copy.ts` 里 `import fsp from 'node:fs/promises'` |
| T8 | 键语法：`1abc`、`a-b`、`a.b`、空串、`__proto__` 全被拒（`copy.test.ts`） | 把 `PLUGIN_COPY_KEY_RE` 换成 `/^.+$/` |
| T9 | `i18n.test.ts` 的三条确实在调 `@iris/text`（该文件 import 了它，且内联的 CJK/槽位实现已不在） | 把规则复制回测试里（此条靠**删掉** `@iris/text` 的导出使其编译失败来验证） |
| T10 | 端到端一条（纠正 4 的接缝）：宿主 `PluginAssetStore.manifest()` 产出的 JSON **字符串**喂给 `parsePluginAssetManifest`，回来的对象里 `i18n` 还在（放 `packages/iris-app-service/tests/plugin-assets.test.ts`，它已经 import 了 `@iris/plugin-web-api` 的类型，`:8`） | 在解析器重建行时漏掉 `i18n` 字段（即纠正 4 描述的那个默认行为） |
| T11 | 带文案的 dev 夹具走完 preview → confirm → 行可用，`preview.i18n.keys` 等于夹具真实条数（`plugin-install.test.ts`） | 让 preview 填一个写死的条数 |
| T12 | 超过 `PLUGIN_COPY_LIMITS.maxKeys` 的文案被拒（用 test-only override，否则要造 2000 键的夹具） | 去掉上限检查 |
| T13 | 同意页渲染 `i18n` 行（`plugin-center.test.ts` 的集合比较，已有机制） | 删掉那一行 `ConsentField` |

**夹具注意**：文案 JSON 里若需要反斜杠或控制字符，**不要用 Bash heredoc 写文件**（本仓库已记录：Bash 工具会吞掉单个反斜杠，引号 heredoc 也挡不住），用 `Write`/`Edit` 或在测试里用 `JSON.stringify` 生成。

**不要做的**：不许为了让插件键通过而放宽 `i18n.test.ts:202` 的 `t('key')` 扫描正则（已核对：冒号不在它的字符类里，插件键本来就不会被它扫到）；不许把 `plugin-center.test.ts` 的集合比较改回计数比较（PR-3 的 ledger §99 记过，计数在改名下不变，是钝的）。

---

## 7. 文档与 ledger

| 文件 | 改什么 |
| --- | --- |
| `docs/PLUGIN-AUTHORING-RUNBOOK.md` | 在「安装一个系统插件包」一节（`:218`）下新增「插件自带文案」：清单怎么写、两份文件的格式与键语法、三条审计各自拒什么（附一条真实的拒绝消息）、`displayName`/`description` 这两个**约定键**会被插件中心用、前端怎么取词（`tPlugin`）、体积上限 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | §3 的清单示例（`:81`–`:99`）加 `i18n` 并在下方项目符号里加一条；§5.1 的 `SystemPluginInstallPreview`（`:177`–`:199`）加 `i18n?`；§5.1 末尾那句宿主顺序（`:201`）补上文案审计发生在契约里 |
| `docs/INFRASTRUCTURE-INTERFACES.md` | §5 的 `PluginAssetEntry` 行（`:223`）与 `/plugins` 资产面表（`:226`–`:237`）加 i18n 的路由、rev 与停用行为；§8 那行「i18n 命名空间合并」（`:344`）从「未做」改成落地记录，写清**做了什么**与**仍没做什么**（例如：只有两种语言；插件不能覆盖壳的键；没有插件侧的复数/语法机制） |
| `docs/ARCHITECTURE.md` | 规则 2（`:34`–`:49`）现在逐个点名 `@iris/text` 的两个成员（`stringHash`、`parseRegexFromString`），新增第三类成员后这段话要加一句，说明文案审计规则为什么符合「宿主与帧/壳必须算出同一个答案」——注意这里两个消费者是**宿主与测试**，理由要写成「同一条规则有两个执行点，drift 会让安装期放行而门禁事后才发现」，不要硬套帧 |
| `notes/apps/iris-web/DEVIATIONS.md` §101 | 覆盖层的形状与为什么是模块级 store；`translate` 加宽参数而 `StringKey` 不动；`plugin-center.test.ts` 正则放宽的理由（§2.5）；`i18n.test.ts` 改接线后**仍然覆盖**的三条；牙齿表的 web 半 |
| `notes/packages/iris-app-service/DEVIATIONS.md` §84 | 纠正 1–4 四条；审计放契约的理由与「读两次小文件」的权衡；`client` 转可选、帧 meta 只投影两个键的决定（D3）；rev 一文件一份的理由（D2）；开机不重跑内容审计的判断（§4.3 末）；牙齿表的宿主半 |

md 引用门禁（`apps/iris/tests/md-references.test.ts:114`）会检查每一条 `path:line` 指向的**文件存在**：写**将要新建**的文件时不要带行号，否则那条引用在写文档的时刻是坏的。

---

## 8. 门禁与验收

### 8.1 §0 第 4 条门禁（原样跑，原样引用输出）

```
根：      npx tsc -p . --noEmit
web：     cd apps/iris-web && npx tsc --noEmit
web：     npm run build            # 引用 bootstrap check 那一行
web：     npm run check:render
根：      npm test                 # 要 ℹ fail 0
根：      FORCE_COLOR=0 npm run test:no-corpus     # 现为 40 skipped, 0 failed
根：      node --test apps/iris/tests/md-references.test.ts
```

已知偶发红（§0 第 7 条）：`chat-search.test.ts` 的比例断言、`chat-integrity.test.ts` 的「只报告一次」。全量若只红这两条之一，重跑一次并把**两次**输出都贴出来。

### 8.2 U5 的实测（协调人会在复制的数据目录上另跑一遍）

照 `apps/iris-web/tools/live-plugin-install-check.mjs` 的路子，宿主起在 8788+、数据目录是 `apps/iris/data` 的**副本**（`host.lock` 一个数据目录只允许一个宿主，端口被占是 `EADDRINUSE` 直接起不来，不会「换个端口起在别处」）：

1. 造一个 dev 夹具包：`package.json` 带 `iris.plugin.i18n`，两份文案各 2 条（含 `displayName`、`description`，其中一条带 `{name}` 槽位）。
2. `plugin.previewInstall`（dev 源）→ 同意页显示「文案：2 条 · en/zh」，且 `data-consent-field="i18n"` 在页面上。
3. `plugin.confirmInstall` → 行出现、`source: 'dev'`；`plugin.enable`。
4. 界面语言切到 zh：行上显示的是 bundle 里的 zh `displayName`；切到 en：换成 en 的那条。
5. `GET /plugins/<id>/i18n/zh.json?rev=<清单里的 rev>` → 200 + `immutable`；去掉 `?rev=` → 200 + `no-cache`。
6. `plugin.disable` → 同一个 URL → **404**，聚合清单里该行消失，界面上的插件文案退回快照里的名字。
7. `plugin.uninstall` → 行没了、`<dataDir>/system-plugins/<id>/` 整个目录没了、**dev 目录一字节未动**。
8. 宿主日志零 `[E]`、页面零异常。

---

## 9. 风险

| 风险 | 判断与处置 |
| --- | --- |
| 覆盖层内存增长 | 上限是 D1 的 `maxBytes × 2 × 已启用插件数`。按 256 KiB 两列、10 个插件算约 5 MB，可接受；真正的防线是**停用即移除**（D5），别让覆盖层成为只进不出的表。加一条断言：`dropPluginCopy` 之后 `getPluginCopy(id)` 是 `undefined` |
| 插件之间键冲突 | **不存在**：覆盖层的键是 `plugin:<id>:<key>`，id 由目录主键保证唯一（`isValidExtensionId`，`packages/iris-extension-installer/src/lock.ts:28`，且 `plugin.confirmInstall` 拒绝已占用的 id）。这与帧侧成员合并那套「两个插件抢同一个成员名 → `conflict`」（`use-plugin-manifest.ts:351`）是**不同的问题**：那里的命名空间是共享的全局面，这里的不是。ledger 里要写这一句，否则下一个人会来加一套冲突检测 |
| 插件覆盖壳的键 | 同样由前缀阻断——T5 就是这条的牙齿。审阅时特别看：装载路径上**任何**一处忘了加前缀，都会让 `pluginCenterTitle` 这种键直接落进静态命名空间 |
| 几千条键的 bundle | D1 的 `maxKeys` 拒之，且拒绝发生在**安装前**（契约里），用户不会先下载完再被拒 |
| 帧 meta 被牵连 | D3 的第二选择（meta 只投影 `{ rev, client }`）把这条风险按住；但 `parsePluginRows` 仍要接受没有 `client` 的行，**这一条最容易漏**，因为它和帧无关、只和「同一份 JSON 两个读者」有关 |
| 夹具里的反斜杠 | 见 §6.1 末：Bash 工具会吞反斜杠，用 `Write`/`Edit` 写夹具，或在测试里用 `JSON.stringify` 生成 |
| 并行冲突 | 与 U3 在 `manifest.ts` 相遇：本任务的 `i18n` 字段放 `client` 之后，U3 动的是 `PLUGIN_PERMISSIONS`（`manifest.ts:88`），区域不同；两支同时追加 ledger 时**按节序两边保留，不改内容**（§0 第 5 条） |

---

## 10. 完成报告模板

发给协调人时照填，不要省：

```
分支：dev/plugin-i18n-bundles
最终 commit：<sha>
PR：#<n>

与任务单的偏离（实测推翻的前提）
1. 「parsePluginManifest 之后、hashed 之前」——该窗口在 preview 里不存在，审计落在 artifact contract 里。证据：installer.ts:199 / :205、install.ts:314。
2. 聚合清单类型在 @iris/plugin-web-api（:195/:225），不在 @iris/protocol。
3. 只带文案不带 client.js 的插件今天进不了聚合清单（plugin-assets.ts:172）；本 PR 放宽了成行条件，PluginAssetEntry.client 转可选。
4. 两个清单解析器会丢掉不认识的字段（plugin-web-api:272、:169），必须同步改；已加端到端断言 T10。
5. plugin-center.test.ts 的 data-consent-field 抓取正则不含数字，`i18n` 抓不到；放宽为 [a-zA-Z0-9]+（是收紧不是弱化）。
（实际发生的以施工为准，多于五条就都写。）

决策与理由（D1–D6 逐条一句话）

牙齿表
| 断言（文件:行） | 让它变红的改动 | 结果 |
（T1–T13 逐行；任何「改了却没红」的都要写出来并说明为什么，别隐藏。）

门禁输出
（七条命令逐条原样贴，npm test 要有 ℹ fail 0 那一行；test:no-corpus 的数字若变了要解释。）

U5 实测
（§8.2 的八步逐条结论 + 宿主日志无 [E] 的证据。）

Ledger
notes/apps/iris-web/DEVIATIONS.md §101
notes/packages/iris-app-service/DEVIATIONS.md §84
docs/INFRASTRUCTURE-INTERFACES.md §8 的「i18n 命名空间合并」行已在同一个 PR 里更新
```
