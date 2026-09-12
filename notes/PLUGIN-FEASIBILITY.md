# PLUGIN-FEASIBILITY —— 把酒馆助手与 MVU 剥离为插件的可行性与难度

- 日期:2026-09-12。基准提交 `main` 2d80c7f(#66–#78 安全批次之后)。
- 性质:只读分析,未改任何产品代码。数字来自两名只读分析员对宿主侧与前端/沙盒侧的逐文件盘点,以及协调者对架构文档与组合文件的复核;每个论断附 `文件:行号`,行号以基准提交为准。
- 参考安装:`E:/sillyTavern/SillyTavern`(ST 1.18.0,只读)。

## 0. 结论与裁决

**结论**:可行,但两者不在一个量级。

- **MVU 剥离**是中等偏易的工程活:宿主侧耦合约 800 行、集中在两个调用点,钩子形状清晰;帧侧约 500 行是一个可整体搬走的垫片。
- **酒馆助手剥离**本质上是「把 Iris 的卡片 API 层正式化为一个插件」:它在 Iris 里不是一个扩展,而是卡片面本身——协议的三分之一、沙盒的近三成、fake client、四个普查脚本都以它为骨架。
- **插件管理系统**的两层内核都已经在(宿主 Cordis 组合、前端 dsh 浏览器插件内核 + 5 个 UI slot);缺的是**贡献机制**——协议表、`Handlers` 映射、fake 穷尽守卫、成员表、资产清单、帧 CSP 全部是封闭的。

**用户裁决(2026-09-12)**:

1. 插件框架**沿用 dsh 的 Cordis 架构**(宿主 `@deepseek-ai/cordis` 组合 + 前端 `dsh-client-web` / `dsh-client-ui-slots`),不另起一套。
2. 酒馆助手作为**默认启用、可卸载**的插件。按「兼容是地板」(`notes/ROADMAP.md`),它不能是可选安装项:TH 缺席时 122 个 RPC 中 40 个答 `unsupported`,卡片面 37 个方法全部失去落点(§3)。剥离的收益是可替换与可逆,不是让用户去装它。

**协调者建议(未裁决)**:MVU 先做,用它验证整套插件契约;酒馆助手放最后,等契约被小件验证过再动。

## 1. 先纠正两个前提

1. **在 ST 里 MVU 不是扩展。** 本机 ST 的两个扩展目录里只有 `JS-Slash-Runner`(酒馆助手,用户级 `data/default-user/extensions/`)和 `ST-Prompt-Template`(全局 `public/scripts/extensions/third-party/`)。MVU 是卡片从 jsdelivr 拉的脚本 bundle(`MagVarUpdate/artifact/bundle.js`;`apps/iris-web/src/sandbox/tavern-helper.ts:963`,`notes/TEST-CARDS.md:124`)。Iris 内建的 MVU 是它的**宿主半边**——解析回复里的 `[InitVar]` / 变量更新命令、prune、cleanup——这在 ST 里由卡片自带的 bundle 在页面上完成。所以「把 MVU 做成插件」是 Iris 独有的概念,ST 没有可照抄的形态。
2. **酒馆助手与 MVU 之间的绑定不是清单声明的。** JS-Slash-Runner 的 `manifest.json` 没有 `dependencies` 键;绑定是 TH 源码里硬编码的字符串 `'Mvu'`:`src/function/global.ts:34-38`、`:49-53`(`waitGlobalInitialized` 特判 `'Mvu'` 并等楼层 0 出现 `stat_data`),`predefine.js:36-44` 把 `window.Mvu` 装成指向 `parent.Mvu` 的活 getter。ST 的清单依赖系统与这两者无关。
3. **Iris 宿主侧没有任何领域功能以插件形态存在。** 先前以为 `@iris/compat-prompt-template` 是可选 Cordis 插件先例,不成立:它不导出 `name`/`inject`/`apply`,`apps/iris/cordis.yml` 没有它的行,只是 `@iris/app-service` 的普通依赖(`packages/iris-app-service/package.json:19`)加一个布尔开关(`cordis.yml:151` `templates`,`index.ts:918-922` 以键是否存在为开关)。关掉只是跳过求值,代码、依赖、`script.evalTemplate` RPC 都还在。

## 2. 现状:框架三层各有什么、缺什么

| 层 | 已有 | 缺 |
|---|---|---|
| 宿主插件框架 | `apps/iris/cordis.yml` 9 行组合;`@iris/rpc-host` 是无领域路由,`IrisRpcHost.register<M extends RpcMethod>(method, handler)` 返回撤销函数、重复注册抛错、未注册答 `unsupported`(`packages/iris-rpc-host/src/index.ts:256-265`,`:488-495`);Cordis 给了服务、注入、可逆 effect、事件 | 类型参数要求方法**已在** `@iris/protocol` 的封闭 `requestSchemas` 里;`@iris/app-service` 的 `Handlers` 是**全量**映射类型(`service.ts:247-249`),被类型强制实现协议声明的每一个方法;`AppServiceOptions` 约 36 个字段全是具体 store 或标量,唯五个函数字段(`stream` `:442`、`installConnection` `:508`、`fetchRemote` `:575`、`broadcast` `:577`、`onError` `:715`),**没有通用钩子**;122 个注册全在 `index.ts:969-1090`,`service.ts` 7,059 行 |
| 前端插件框架 | `apps/iris-web/src/main.tsx` 用 `dsh-client-web` 的 `AppWebEntry` 启动;`src/ui-plugin.tsx` 是一个 Cordis 插件(`iris-client-shell`);`src/slots/slots.ts` 声明并渲染 5 个格位:`iris.message.actions`、`iris.message.footer`、`iris.sidebar.panels`、`iris.settings.sections`、`iris.composer.actions`(`slots.ts:47-66`;渲染点 `Composer.tsx:1060`、`Message.tsx:165`、`SettingsDrawer.tsx:593`、`Sidebar.tsx:853`);webserver 的 `webserver/index-inject` 行(ST `addExtensionScript`/`addExtensionStyle` 的等价物)已声明 | 只有 shell 一个**页内**插件,`main.tsx:5-10` 明说「宿主平面还不存在」——从宿主下发插件 bundle 的 `/plugins` 通道和 `dsh.client` 清单扫描(`notes/PLAN.md` §浏览器插件平面 的原始设计)未建;`index-inject` 在本仓零使用;`ScriptPanel` / `ScriptLibraryPanel` / `PresetRegexPanel` / `StatePanel` 是 `SettingsDrawer.tsx:173,494,504` 的硬编码 JSX,不是 slot 注册;i18n 是 EN/ZH 两个封闭平面记录,无命名空间合并 |
| 沙盒帧 | bootstrap 与成员表都已按内容哈希取回(web §91),`srcdoc` 只剩 2,448–3,006 B——插件的帧侧脚本只是多一个缓存的 `<script src>`,不再吃帧预算 | 成员表是构建期一次性赋值(`members-entry.ts:61-86`,单个 `vite.members.config.ts` IIFE 产物),无合并;`sandbox/manifest.json` 固定 4 键(`asset-manifest.ts:86`,`hash-sandbox-assets.mjs:46`);帧 CSP `framePolicy` 的 `script-src` 是固定远端表(`srcdoc.ts:98,178-179`),无 per-plugin 条目;成员表缺席 = 帧拒跑全部卡代码(`members-entry.ts:88-98`),合并协议要连这条一起设计 |

## 3. 耦合清单

分类:**A** 已在功能自己的包边界后(删 import + 空对象即可);**B** 在共享模块里但可经具名钩子分离;**C** 结构性——住在没有贡献机制的注册表里。

### 3.1 酒馆助手

| 位置 | 类 | 说明 |
|---|---|---|
| `packages/iris-app-service/src/entry.ts:23,747-767` `expandHelperMacros` | B | `expandMacros` 之后的第二遍宏扫描。钩子已有:`MacroRegistry.registerMacroLike`(`packages/iris-macro/src/registry.ts:453`,带撤销)——TH 没有用它 |
| `service.ts:6074`、`cache-friendly.ts:206-210` `isHelperMacroName` | B | 宏名归属谓词,喂给残余宏归因。钩子形状:`residualMacroOwners: ((name) => boolean)[]` |
| `service.ts:2452` `script.slash`;`presets.ts:22-27`、`service.ts:4195` 预设转换 | A | 转换函数在包里,调用点在宿主 |
| `regex.ts:411-610`(约 200 行)`toTavernRegex` / `fromTavernRegex` / `formatAsTavernRegexed` | C | TH 的 `tavern_regex` 投影住在宿主共享的 regex 模块 |
| `service.ts:3865,3879,3933` `regex.tavern*` 三个 handler(95 行)+ `#tavernCharacter:4336`、`#tavernTier:4355`;协议 `rpc.ts:1905,1926,1972`(115 行) | C | |
| `packages/iris-protocol/src/rpc.ts` `script.*` **32 个方法 / 122**,703 行 schema;`scriptLibrary.*` 5 个,72 行 | C | 其中 TH 专属 23 个(`slash generate generateRaw getCharacter chatHistoryBrief chatHistoryDetail rotateChatMessages getPreset createOrReplacePreset deletePreset renamePreset loadPreset replaceScriptButtons list setEnabled body setDocumentGrant setScriptsAllowed setExtensionSettings runEnded context fetch saveChat`),通用卡沙盒/ST 上下文 9 个(`getVariables setVariables swipeTo saveMetadata setExtensionPrompt setChatMessages createChatMessages deleteChatMessages evalTemplate`) |
| `views.ts:689-1183`(494 行 `ScriptSource` `ScriptView` `ScriptChatMessage` `ScriptContext` …)、`:2017-2070` `UserScriptView`、`:2070-2211` `WorldbookEntry`、`:2245-2280` `LorebookSettings`、`:2813-2960` `TavernRegex*` `CardCharacter` `ChatHistoryBriefRow` | C | TH 的线上形状就是协议自己的类型;`views.ts:2037` 原话「TavernHelper's `Script` … field for field」 |
| `context.ts`(848 行)`script.context` 快照构建;`:166-167` 省略表、`:234` `tavern_helper` 旧数组修复、`:197` `getCharacter` 形状 | C | 单体构建器,无按功能贡献点;`ScriptContext` 是 `views.ts:826` 起 354 行的封闭接口 |
| `script-library.ts`(451 行)三处仓库:`extension_settings.tavern_helper.script.scripts` / `preset.extensions.tavern_helper.scripts` / `character.data.extensions.tavern_helper.scripts` | C | 持久化字段名是 TH 的 |
| `lorebook-settings.ts`(119 行)、`worldbooks.ts:250,455`(`toWorldbookEntry` 返回 TH 的 `WorldbookEntry`) | C | |
| `side-usage.ts:9-10,135-152`、`usage.ts`、`usage-summary.ts`(`source: 'script'` = `TavernHelper.generate` 计费);fake 种子 `seed.ts:84-100` | C | |
| `packages/iris-character/src/types.ts:75,77` `tavern_helper?` `TavernHelper_scripts?` | C | 共享卡类型里的字段名 |
| `packages/iris-lorebook/package.json:13` → `activate.ts:333`、`matching.ts:24`;`packages/iris-macro/package.json:13` → `registry.ts:172` | **反向** | 两个通用包依赖 `@iris/compat-tavernhelper-core` 拿 `stringHash` / `parseRegexFromString`。剥离前必须先把这两个工具迁到中性包 |
| `packages/iris-compat-tavernhelper/package.json:17`、`macros.ts:33` → `@iris/mvu` | **反向** | TH 依赖 MVU(`formatYamlBlock`),「关 MVU 留 TH」今天表达不出来 |
| `packages/iris-client-fake/src/client.ts` 各 case + `:1838` `const unreachable: never = method` | C | fake 必须回答每一个 `RpcMethod` |
| `apps/iris-web/src/sandbox/card-api.ts:31` `CARD_METHODS` 37 项(22 `script.*`、9 `worldbook.*`、3 `regex.tavern*`、3 `storage.*`) | C | 帧侧白名单;`frame.ts:1034` 已记「加了白名单没有宿主 handler」是失败形态 |
| 沙盒整文件(28.7%,7,353 行):`tavern-helper.ts` 5,266(`createFrameTavernHelper` 自 `:920` 起 4,347 行)、`lorebook-aliases.ts` 598、`card-api.ts` 418、`upstream-surface.ts` 414、`identity.ts` 394(`MEMBER_KINDS` 124 条)、`scoped-events.ts` 134、`host-events.ts` 92、`button-event.ts` 37 | C | 另 `frame.ts` 约 500 行 TH/MVU 具名区域;`frame-entry.ts` 只消费 `MemberTable`,几乎不点名 TH |
| 普查脚本 `scripts/th-member-census.mjs`(382)、`card-surface-census.mjs`(1,095)、`script-context-probe.mjs`(279)、`card-script-census.mjs`(205) | C | 以声明文本定位 `UPSTREAM_MEMBERS` / `MEMBER_KINDS`(`th-member-census.mjs:11-19`);常量一搬就静默失效 |
| `apps/iris-web/src/app/i18n/strings.ts:871,883,1371,2313,2685` | C | 点名酒馆助手 / `TavernHelper.generate` 的字串 |
| 前端 shell:`ScriptLibraryPanel.tsx` + `script-library.ts`(472 行,B)、`ScriptButtons.tsx` + `script-buttons.ts`(163 行,B);`ScriptPanel` / `ScriptEditor` / `useCardScripts` / `ConsentAsk` / `consent.ts`(约 1,920 行)是**通用卡脚本机制**(A),文案按后果不按 API 措辞;`client/store.ts` 有 15 个调用点走 11 个 `script.*` 方法 | B/A | 正则面板家族(`RegexPanel` 等约 1,320 行)是 ST 核心的三层正则,**不是** TH 的(`PresetRegexPanel.tsx:4-10`) |

**体量**:app-service 内 TH 约 **4,296 行 / 31,129(13.8%)**(整文件 2,814 + handler 1,257 + 投影与散点);协议约 **1,900 行**;沙盒约 **7,850 行**;自己的两个包只有 **1,973 行**(core 1,139 + compat 834)。「插件」的主体今天都在别人家里。

### 3.2 MVU

| 位置 | 类 | 说明 |
|---|---|---|
| `entry.ts:25` import;`:110-111` `EMPTY_MVU`;`:138` `isMvuData`;`baselineFor:1003`(21 行)、`initVars:1024`(75)、`recordVariables:1099`(50)、`#replayFrom:1972`(38) | B | 四个纯「解析回复 → 折进变量库」函数。钩子形状:`onReplySettled(text, { turn, store, report })` + `variableBaseline(turn)`。`formatYamlBlock` 在 `:25` 被导入但**未使用**(死导入;真正的使用在 `compat-tavernhelper/src/macros.ts:179`) |
| `service.ts:4877-4885`(`#settle`)+ 门 `:4805,4843,4860,4876,5012` | B | 约 20 行;`options.recordVariables` 已是事实上的开关 |
| `prune.ts` **整文件 532 行**;`:15` 「Upstream's rule, from `MagVarUpdate/src/function/cleanup/cleanup_variables.ts`」;`PRUNED_KEYS:140-151` | C | 五个键名是 MVU 的;配置 `pruneVariables` |
| `service.ts:1933` `chat.answerCleanup`(32 行)+ `rpc.ts:318,2306`;事件 `events.ts:128` `cleanup.offer`;`views.ts:2542` `BackupReason: 'cleanup'` | C | MVU 专属的 RPC + 事件 + 持久化枚举 |
| `chats.ts:987-1011` `seedGreeting` 在第 0 条消息写 `stat_data`,因为 `waitGlobalInitialized('Mvu')` 恰好等它 | C | 开场白播种是 MVU 形状的 |
| `diagnostics.ts:24,49` `kind: 'mvu'`;`views.ts:2220` 文档枚举 | C(弱) | `kind` 是 `string`,插件可加;枚举注释是宿主写的 |
| 帧侧(约 500 行):`tavern-helper.ts:137-151` `MVU_UPDATE_ENDED_EVENT`、`:700-742` `restoreFloorTables`(读 `chat[i].variables[swipe].stat_data`)、`:744-918` `IGNORE_CLEANUP_KEY` + `sealLegacyCleanup`(假扮 MVU 的 `cleanup/legacy_chat.ts:27-33` 让它停手);`frame.ts:1140-1200` `publishName('Mvu', …)`、`:2942-3025` **`Mvu` 垫片对象** `{events, getMvuData, replaceMvuData}`、`:2616-2664` 顺序约束、`:1899-1990` 按 MVU 事件量定尺的桥 | C | 可整体搬进 MVU 的帧侧脚本 |
| 前端 shell:`CleanupOffer.tsx`(221 行,标题字面 `'[MVU] Automatic cleanup'`,`strings.ts:1164/2574`)、7 个 `cleanup*` i18n 键 ×2、`store.ts:614-631,3506`;`MessageInterfaces.tsx:33,459` 发 `MVU_UPDATE_ENDED_EVENT` | C | `StatePanel.tsx` + `state-panel.ts`(1,331 行)按成文规则是 **MVU 无关**的通用变量面板(`StatePanel.tsx:47-52`),数据源是协议通用字段 `view.variables` |
| `packages/iris-variables`、`iris-pipeline`、`iris-turn` | 无 | `@iris/variables` 零 `@iris` 导入;后两者零 TH/MVU 标识符 |

**体量**:app-service 内 MVU 约 **807 行(2.6%)**;协议约 **45 行**;帧侧约 **500 行**;shell 约 **250 行**;自己的包 **1,500 行**。i18n 点名 TH 或 MVU 的键 11 个 / 语言(约 1,030 键的 1%)。

## 4. ST 的扩展模型(参考,只读)

| 步骤 | 位置 |
|---|---|
| 清单字段(JS-Slash-Runner):`display_name` `loading_order:100` `requires:[]` `optional:[]` `js` `css` `hooks.activate` `author` `version` `homePage` `auto_update` `minimum_client_version` `i18n` | `data/default-user/extensions/JS-Slash-Runner/manifest.json` |
| 发现三类目录(系统 / 用户 / 全局,冲突用户优先) | `public/scripts/extensions.js:298`;`src/endpoints/extensions.js:480-515` |
| 取清单 → 按 `loading_order` 再 `display_name` 排序 | `extensions.js:537-561`,`:49-50`,`:570` |
| 四道门:`minimum_client_version`、`requires`(Extras 模块)、`dependencies`(其他扩展,含「是否被禁用」)、`extension_settings.disabledExtensions` | `:570-626` |
| 激活:locale → `<script type="module" async>` + `<link rel=stylesheet>` → `hooks.activate`(5 s 超时) | `:628-637`,`addExtensionScript:813-840`,`addExtensionStyle:781-805`,`callExtensionHook:406-466` |
| 启停 = 改 `disabledExtensions`、`saveSettings()`、`location.reload()` | `:473-501` |
| 管理器 UI:从 git URL 安装 / 更新 / 删除;服务端浅克隆进用户扩展目录 | `installExtension:1698` → `POST /api/extensions/install`;`src/endpoints/extensions.js:92-140,169,442` |

对 Iris 的启示:清单字段与 `loading_order`/启停语义可直接借用;**git clone 到扩展目录、扩展与页面同权**这两条与 Iris 的安全立场冲突(`ROADMAP.md`「零沙箱的扩展模型是要修的」;远程卡代码只允许 `*.jsdelivr.net` 与 `raw.githubusercontent.com`)。

## 5. 语料侧依赖(全部为下界:远程 bundle 对普查不可见)

| 依赖 | 卡数 / 计数 | 出处 |
|---|---|---|
| TH 声明成员 171 个,语料用到 32 个,Iris 建了 121 个 | | `notes/apps/iris-web/CARD-SURFACE.md:36-40`,§82 普查 |
| 打包 MVU 的卡 | **13** | `notes/TEST-CARDS.md:103-104` |
| 界面代码读 `Mvu` 的卡 | **10**,其中 7 张 `waitGlobalInitialized`、2 张 `typeof` 守卫、1 张 `if (Mvu)` 兜底、**1 张无守卫会抛** | `TEST-CARDS.md:1146,1155-1160` |
| `Mvu` 成员用法:`getMvuData` 21 次(4 卡同步)、`events` 10、`getMvuVariable` 4、`replaceMvuData` 10(全 await) | 四成员里只有 1 个能撑过异步代理 | `TEST-CARDS.md:1148-1152` |
| **非 MVU 卡读楼层变量** | **0** | `TEST-CARDS.md:299` |
| 单样本 TH 家族(n=1) | `injectPrompts`、`createWorldbookEntries` / `getOrCreateChatWorldbook`、`getPreset`、`evalTemplate` | `TEST-CARDS.md:294-298` |

「TH 禁用」在语料里的含义:13 张打包 MVU 的卡全挂(MVU 的 bundle 通过 TH 成员读写变量),10 张读 `Mvu` 的卡里 8 张退化成空面板、1 张抛错;没有任何卡在无 MVU 时还需要变量面板。「MVU 缺席」不会 404,但第 0 条消息不再播种 `stat_data`,TH 的 `waitGlobalInitialized('Mvu')` 会卡住;回复里的 `_.set()` / `<JSONPatch>` 块不再解析,`{{get_message_variable::stat_data}}` 永远是初始树。

## 6. 插件契约的最小需求

| 需求 | Cordis 已给 | Iris 要造 |
|---|---|---|
| RPC 方法贡献 | `ctx.irisRpc.register` | 协议 schema 的运行期合并点,且 `parseRequest`(`rpc.ts:2937`)要查它;`Handlers` 改 Partial |
| fake client 回答 | — | `client.ts:1838` 的 `never` 穷尽守卫改成插件测试夹具可贡献的开放分发表 |
| 生成钩子 | `ctx.on` / `ctx.emit` | 调用点:`entry.ts:747`(宏遍)、`service.ts:4877`(`#settle`)。需要 `beforePrompt(messages)`、`afterReplyText(text, turn)`、`onSettle(entry, turn, text, reason)` |
| 变量库访问 | — | `VariableStore` 在 `ChatEntry` 内部构造,无对外访问器;需要带 scope 的读写 + `baselineFor` 提供者 |
| 卡文件字段 | — | `CardExtensions`(`iris-character/src/types.ts:65`)有索引签名,往返安全;类型化访问要 per-plugin 命名空间 |
| 快照/上下文贡献 | — | `context.ts` 单体;需要 `contributeContext(part)` + 开放的 `ScriptContext` |
| 设置 / 存储命名空间 | `Config` zod(`index.ts:387`) | 子 schema 合并;`paths.ts` 拥有文件布局 |
| i18n | — | 平面记录改命名空间合并 |
| 宏贡献 | `MacroRegistry.register` / `registerMacroLike`(可逆) | 只差接线 |
| 前端 UI | 5 个 slot 已渲染 | 硬编码面板迁到 slot;宿主平面(`/plugins` + 清单扫描);成员表合并;可变长资产清单;per-plugin 帧 CSP;`check-bootstrap.mjs` 按插件产物扩展 |
| 服务 / DI / 可逆 | Cordis `Service`、`ctx.provide`、`inject`、effect | — |

**协议集中是硬约束**:`@iris/protocol` 不得导入任何 `@iris` 包(`apps/iris/tests/architecture.test.ts:114`)。插件不能自带 zod 让协议引用;要么形状留在协议里(TH 不从契约剥离),要么协议获得运行期合并机制。同一测试 `:135` 规定浏览器只能导入 `@iris/protocol`、`@iris/client-fake`、`@iris/rpc-client`、`@iris/compat-tavernhelper-core`——th-core 已被允许进浏览器,帧与宿主共用它;剥离时事件名与正则解析的两侧对齐要另想办法。

## 7. 难度与路线

| 阶段 | 内容 | 量级 |
|---|---|---|
| 0 顺手活(无论做不做插件都该做) | `stringHash` / `parseRegexFromString` 迁中性包,解掉 `iris-lorebook`、`iris-macro` 两个反向依赖;`expandHelperMacros` 走 `MacroRegistry.registerMacroLike` 而不是第二遍扫描;删 `entry.ts:25` 的死导入。目标:包图无环 | 1–2 支 PR |
| 0 **状态(2026-09-12)** | **大部分已落地**,分支 `dev/plugin-graph-hygiene`,账本见根 `notes/DEVIATIONS.md`「阶段 0:包图去环」。已做:两个工具迁入新包 `@iris/text`(零依赖,上浏览器白名单),th-core **不再 re-export**;§3 表里另一条反向边 `compat-tavernhelper` → `mvu` 也一并解掉——`formatYamlBlock` 迁入 `@iris/compat-tavernhelper`(它唯一的调用方),`js-yaml` 随之;`entry.ts:25` 的死导入已删。三条边由 `architecture.test.ts` 的新图断言钉住,不能无声回来。**未做**:`expandHelperMacros` 走 `registerMacroLike`——`dev/system-plugins` 正在重写 `entry.ts`,为两行去抢一个冲突不划算,留给那条分支或其后续 | 已合 1 支 |
| 1 宿主插件契约 | 协议表运行期合并;`Handlers` Partial;fake 开放分发表;`AppServiceOptions` 四个钩子;设置与存储命名空间。**以 MVU 为第一个插件**验证:`prune.ts`、`entry.ts` 四函数、`#settle` 20 行、`chat.answerCleanup` / `cleanup.offer` 随 MVU 搬走 | 约一周 |
| 2 前端宿主平面 | `/plugins` 下发 + `dsh.client` 清单扫描(`PLAN.md` 原始设计);成员表合并协议(含「表缺席即拒跑」的重新定义);资产清单可变长;硬编码面板迁到 slot;MVU 的帧侧垫片与 `CleanupOffer` 迁入 | 一到两周 |
| 3 酒馆助手按域拆 | 照 `notes/AUDIT-CORDIS.md` §4「按域拆子插件」:worldbook / preset / script-compat 成 `@iris/app-service` 的兄弟插件,各自 `inject: ['irisRpc', …]` 自带 handler;先拆宿主 handler,再拆沙盒文件;协议形状暂留中央 | 数周;四个普查脚本要同步改口径 |
| 4 管理 UI 与信任模型 | 安装 / 启用 / 禁用 / 更新。先答:插件是与 Iris 同权的受信代码(ST 形态),还是也进沙盒?TH 的活恰恰需要全权 | 设计决定先于工程量 |

## 8. 开放问题

1. **信任模型**(阶段 4 的前提):同权还是沙盒。ST 是同权;Iris 的路线图说要修。若同权,安装源必须与卡代码同样受限(两个 CDN、哈希锁定),而不是 git clone 任意仓库。
2. **协议形状归属**:TH 的 `views.ts` 约 1,000 行类型是留在 `@iris/protocol`(TH 不从契约剥离,只从实现剥离),还是协议获得插件形状合并。前者便宜且不违反 `architecture.test.ts:114`。
3. **普查口径**:`th-member-census.mjs:11-19` 按声明文本定位常量,其头注释自述「抽取修好前不得引用新数字」。阶段 3 之前要给普查一个不依赖文件位置的输入。
4. **MVU 先做**的建议是否采纳:它够小、边界干净,失败代价低;若先动 TH,是拿最重的东西试新机制。
5. **可卸载的验收标准**:Cordis 的卖点是「卸载即回收全部副作用」(`ROADMAP.md` 「插件可逆」)。对 TH 而言,卸载后 40 个 RPC 答 `unsupported`、37 个卡片方法失落点、13+ 张卡失效——这是**正确**的可卸载结果,验收要按「回收干净」而不是「卡还能跑」来写。

## 9. 方法与证据

- 宿主侧盘点:逐文件读 `packages/iris-app-service`、`iris-protocol`、`iris-client-fake`、`iris-pipeline`、`iris-turn`、`iris-variables`、`iris-lorebook`、`iris-macro`、`iris-character`、`apps/iris`;行数按「模块头声明主题的整文件」+「`handlers` 字面量里相邻 handler 键之间的距离」+「具名函数跨度」三种口径,后者会高估各块末尾的空行、低估私有辅助函数。
- 前端侧盘点:整文件口径(模块头声明唯一主题为 TH/MVU)+ 60 词词表逐行 grep(下界:一个 40 行的 TH 逻辑块只要一行点名就只算 1)。
- ST 参考:`E:/sillyTavern/SillyTavern` 只读;`data/` 下只读取清单与设置的键,未打开任何卡片正文;所有语料计数来自 `CARD-SURFACE.md`、`TEST-CARDS.md` 已记录的数字。
- 本文件不提议代码;第 7 节的量级是协调者的估计,不是承诺。
