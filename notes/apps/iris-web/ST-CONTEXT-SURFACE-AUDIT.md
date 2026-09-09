# ST getContext 面与宿主全局面逐成员审计 —— `st-context.js` 的 145 键、虚拟 parent 的桥接名、裸全局三件套

日期 2026-09-08。审计分支 `dev/audit-st-context-surface`。
**[ST]** SillyTavern 1.18.0，取自操作机安装 `E:\sillyTavern\SillyTavern`（只读，`51ad27fb8`）。
**[Iris]** 本仓库 main `624c4ce`。
量具：`scripts/st-context-audit.mjs`（本次新写，只读；`--verbose` 出证据行，`--surface` 单测 145 键提取）。
姊妹篇：`notes/apps/iris-web/TH-SURFACE-AUDIT.md`（并行的酒馆助手 171 成员面，同一台机器同一周做）。
本审计管三个面：**ST `getContext()` 对象**、**宿主页面全局（`window.parent.X` / `top.X`）**、
**裸库全局（`$` `_` `toastr` …）**——即用户既有四层覆盖表的第 2/3/4 行。TH 面不在此重复。

---

## 一、总览

### 1.1 三面账目（对齐既有那张表的 2/3/4 行，数字全部重测）

| 面 | 旧账 | 本审计 | 差异原因 |
| --- | --- | --- | --- |
| ST `getContext()` 上游成员 | 145 | **145**（逐键钉到 `st-context.js` 行号，量具 `--surface` 可复演） | 不变 |
| └ Iris 已应答 | 22（15%） | **25 / 145（17%）**；facade 可达名 36 = 25 属 145 + 9 个 Iris 自有（`setVariables` `swipeTo` `charWorldbooks` `worldbookNames` `scriptButtons` `lorebookSettings` `storage` `floor` `variableLayers`）+ `getContext`/`saveSettings` 两个自有派生名 | 旧账漏数了 pin 测试里钉死的 24 名（`tests/sandbox-frame.test.ts:2662`）与快照字段的直通分支（`frame.ts:944-945`） |
| └ 语料用到 | 约 14 | **17**（14 有 + 3 缺） | 语料群扩了「卡自带正则界面源文本」一群（§2.1），魔法少女的扣扣审判、命定之诗的界面代码此前不在任何群里 |
| └ 用到但缺 | 约 6 | **3**：`reloadCurrentChat`（1 卡）、`addOneMessage`（2 卡）、`printMessages`（1 卡） | 旧账 6 个里：`chat` 实际**有**（快照第一字段）；`sendMessageAsUser`/`stopAllGeneration`/`substituteParams` 是 `top.X` 宿主全局读，归 parent 面，且上游页面同样没有它们（§3.2） |
| parent 桥接（`window.parent.X`） | Iris 18 名 | **22 名 + `Mvu`（运行期发布）** | 旧账点数没算 6 个调度器与 `postMessage`（`frame.ts:64-71`、`:1167`） |
| └ 上游 | 「整个页面」 | 精确化为**三来源清单**（§3.2 开头）：index.html 经典脚本、`lib.js:34-88` 的 `initLibraryShims`、TH 的 `predefine.js:1-12`；页面自己的 `SillyTavern` 全局只有 `{libs, getContext}`（`script.js:292-295`） | 「整个页面 145 成员 + 24 库」是高估：`script.js` 以 `type="module"` 载入（`index.html:8204`），**模块导出不落 window**——卡从页面上摸到的 `SillyTavern` 只有 2 个成员 |
| └ 语料读到 | 21 名 | **53 名**（其中 2 个已知局部变量假阳性、1 个打包体噪声，真读 50 名） | 群体扩了正则界面源文本；别名（`_pw`/`_pd`/`hostWindow`）单独跟进 |
| └ 用到但真缺 | 约 9 | **5 名**：`alert`/`confirm`/`prompt`（1 卡，前两处**硬崩**、prompt 有守卫）、`toastr`（3 卡静默降级）、`localStorage`（2 卡有兜底）；`showdown` 经查**上游分支也不命中**（§4.2.4），降为记录 | 旧账 9 个里其余是「上游页面也没有」的防御性探测（§4.2.3），补了反而偏离上游 |
| 裸全局 | Iris 供 6 件；缺 Split 2 卡、moment 1 卡、d3 1 卡 | **全供**：`$` `jQuery` `_` `z` `YAML` `showdown` `toastr`(适配) `Vue` `VueRouter` `EjsTemplate`(frame 建) + 运行期 `Mvu`；**Split/moment/d3 用量 = 0 卡** | 旧账三笔是注释、CSS 类名与变量名的字面碰撞（§4.3 逐条验尸）；且旧账没算后来已合入的 `showdown`/`VueRouter`（`preset-entry.ts:200`、`:230`） |

净结论：**三个面里只有一处会让卡当场死掉（银麒赎世的 `_pw.alert` / `_pw.confirm`，P0）**；
ST 面三缺里 `reloadCurrentChat` 是**无守卫的 await 硬抛**，但发生在数据已落盘的收尾步骤
（交互坏、数据不坏），`addOneMessage`/`printMessages` 走 `typeof` 守卫是静默降级；裸全局面**没有真缺**。

### 1.2 ST 面逐域统计（145 = 应答 25 + 未应答 120；括号内 = 语料用过）

| 域 | 上游 | Iris 应答 | 语料用 | 域 | 上游 | Iris 应答 | 语料用 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 聊天与消息 | 24 | 6（`chat`4卡 `chatMetadata`1 `saveChat`2卡 `saveMetadata`1卡） | 5 | 事件 | 3 | 2（`eventSource`2卡 `event_types`2卡） | 2 |
| 角色与群组 | 15 | 2（`characters`2卡 `characterId`2卡） | 2 | 弹窗与界面 | 11 | 5（`Popup` `POPUP_TYPE` `POPUP_RESULT` `callGenericPopup` `callPopup`） | 0 |
| 生成控制 | 26 | 2（`generate` `generateRaw`） | 0 | 扩展与设置 | 11 | 1（`extensionSettings`2卡） | 1 |
| 预设与注入 | 3 | 1（`setExtensionPrompt`1卡） | 1 | 分词 | 5 | 0 | 0 |
| 斜杠与宏 | 15 | 0 | 0 | 世界书 | 7 | 1（`loadWorldInfo`） | 0 |
| 变量 | 1 | 1（`variables`） | 0 | 杂项 | 24 | 4（`name1`2卡 `name2`3卡 `getCurrentChatId`1卡 `updateChatMetadata`1卡） | 4 |

缺口的**形状**与 TH 面同一逻辑（TH-SURFACE-AUDIT §1.2）：已应答的 25 个集中在语料当年测过的
读路径（chat/名字/事件/存档）；`saveSettingsDebounced` 是唯一一个**按上游拼写补的行动成员**
（`frame.ts:647-648`，MVU 每帧一次的实测崩溃换来的），弹窗五件套来自 MagVarUpdate 的实测崩溃
（`frame.ts:650-668` 的注释与 DEVIATIONS web §58）。

### 1.3 语料用量 top 名单（ST 面，按卡数；全表量具输出）

| 成员 | 卡数 | 站点 | Iris | 代表证据（首处） |
| --- | ---: | ---: | --- | --- |
| `chat` | 4 | 8 | **有** | 灭仇家满门 L197 `const chat = (ctx && ctx.chat) || [];` |
| `name2` | 3 | 4 | **有** | 魔法少女的扣扣审判 L9382 `characterName = context.name2 \|\| '角色';` |
| `name1` | 2 | 6 | **有** | 灭仇家满门 L107 `ctx && (ctx.name1 \|\| ctx.playerName)` |
| `extensionSettings` | 2 | 3 | **有**（卡分区语义） | 命定之诗 L1002 `context.extensionSettings.EjsTemplate` |
| `eventSource`/`event_types` | 2 | 3+3 | **有** | 魔法少女审判 L11379 成对守卫 |
| `saveChat` | 2 | 2 | **有** | 银麒赎世 L19180 `if (typeof context.saveChat === "function")` |
| `addOneMessage` | 2 | 2 | **缺** | 银麒赎世 L19181 `if (typeof context.addOneMessage === "function")` |
| `characters`/`characterId` | 各2 | 2 | **有** | 人贩子物语 L469 `ctx.characters[ctx.characterId]` |
| `reloadCurrentChat` | 1 | 1 | **缺** | 命定之诗 L891 `await SillyTavern.reloadCurrentChat();`（**无守卫**） |
| `printMessages` | 1 | 1 | **缺** | 银麒赎世 L19183 `else if (typeof context.printMessages === "function")` |
| `chatMetadata`/`setExtensionPrompt`/`getCurrentChatId`/`updateChatMetadata`/`saveMetadata` | 各1 | — | **有** | 银麒赎世 L16733/L26557/L27240 等 |

裸全局面 top：`$` 20 卡/102 站点、`_` 17 卡/73、`z` 17 卡/19、`Mvu` 16 卡/68（全部经 parent 兜底链或
`waitGlobalInitialized`）、`toastr` 7 卡/44（**Iris 是报告适配器，不是真库**——7 张卡的 toast 只进运行面板，
不弹通知，见 `toastr-report.ts`）、`EjsTemplate` 1 卡/1。parent 面 top：`parent.document` 11 卡/38、
`parent.SillyTavern` 6 卡/27、`parent.Mvu` 4 卡/16、`parent.TavernHelper` 4 卡/7。

---

## 二、口径与量具

### 2.1 语料群体（五群，327 段代码、23 张卡）

1. **E: 安装库卡脚本体**（19 张 PNG，`decodeCardPng` + `extractScripts`）；
2. **Iris 数据目录卡**（`apps/iris/data/default-user/characters`，9 张可解码 PNG——另 2 张 PNG 与 1 张
   jpg 无 `chara` 块，不是卡）；
3. **卡自带正则的 `replaceString` 源文本**（每一张卡的界面代码，无论语料聊天有没有渲染过它）——
   **这一群是本审计与 `th-member-census.mjs`（只扫"渲染过的界面"）的关键差异**：魔法少女的扣扣审判的
   `top.*` 家族、命定之诗的 `SillyTavern.reloadCurrentChat()` 全部住在从未在本地聊天里渲染过的 display
   正则里；只扫渲染群会把它们报成"不存在"。ST 面三缺正是这一群带出来的；
4. **E: 聊天渲染界面**（73 个去重 `<script>` 块）；
5. **测试用卡目录**（6 个样本）。

卡身份 = 解码后的 `data.name`，相同内容按哈希去重。三个旧账数字（14/21/22 卡）出自只扫 1+4+5 的
口径，本审计的 17/53 名是在 3 加入后的新账。

### 2.2 探针与它的下界性质

- **ST 面**四条路由：链式 `SillyTavern.getContext().X`；别名声明（零参 `getContext()` 才算——canvas 的
  `getContext('2d')` 不入册）后的 `alias.X`；直接全局读 `SillyTavern.X`；`_tw.SillyTavern.getContext()` 一类
  窗口链前缀全部接受。**解构赋值（`const { chat } = getContext()`）不在探针内**——本语料零命中，
  但这是一个已知盲区，与 `th-member-census.mjs` 的 word-boundary 盲区（TH-SURFACE-AUDIT §2.2 的
  `tw = window.parent || window` 案例）同类。
- **parent 面**：`(window.)?(parent|top).X`，外加六个已知别名（`_pw`/`_pd`/`pw`/`hostWindow`/…）的声明与
  一跳成员。两个测得的局部变量假阳性（TEST-CARDS §J 记录在案）按名排除出缺口：`parent.replaceChild`
  （【Sgw】又看一集，DOM 节点）、`parent.__list`（萧谴写卡助手，普通对象）。
- **裸全局**：词边界 + 「调用或成员读」形状检查统一适用（`Split` 在注释里、`moment` 在 `momentsU` 里、
  `d3` 在 `{{roll: d3}}` 宏与 CSS 类里——三个旧账数字全部死于形状检查缺失）。

### 2.3 脆弱引用（同一纪律，两个方向）

145 键由量具从 `st-context.js` 的返回字面量括号匹配提取——上游重排该字面量则量具失效；
Iris 侧 `CARD_METHODS`/`OFF_ST_SURFACE` 按 `card-api.ts` 声明文本提取，代理自答名与快照字段
手工列出并钉了 file:line（量具常量 `IRIS_PROXY_NAMES`/`IRIS_SNAPSHOT_FIELDS`）。结论不会过期，
但**新数字在量具修复重跑前不得引用**——与其他两个卡尺同一规矩。facade 可达集由
`tests/sandbox-frame.test.ts:2662` 按名钉住：快照加字段、`CARD_METHODS` 加动作而不过
`OFF_ST_SURFACE`，这个测试先红。

---

## 三、逐面明细

### 3.1 ST `getContext()` 面：145 键全表（按域；「Iris」列 = 有 / 部分 / 无）

**聊天与消息（24 / 应答 6 / 语料 5）**

| 成员 | 上游 | Iris | 语料 |
| --- | --- | --- | --- |
| `chat` | st-context.js:117 | **有**（快照直通，活引用可推——CHAT-WRITES.md 的日志代理） | 4卡 |
| `chatMetadata` | :134 | **有** | 1卡 |
| `chatId` | :124-126 | **部分**：Iris 给不透明句柄（`views.ts:764`），上游给文件名（`script.js` 的 `characters[this_chid].chat`）；`frame.ts:691-705` 记录了分歧与理由 | 0 |
| `updateChatMetadata` | :153 | **有**（上游浅扩散语义逐行转写，`frame.ts:737-775`） | 1卡 |
| `saveChat` | :154（= `saveChatConditional`） | **有**（`frame.ts:793` → `script.saveChat`） | 2卡 |
| `saveMetadata` | :157 | **有**（`frame.ts:787-792`） | 1卡 |
| `saveMetadataDebounced` | :135 | 有 | 0 |
| `addOneMessage` | :139 | **无** → §4.1.2 | **2卡** |
| `printMessages` | :288 | **无** → §4.1.3 | **1卡** |
| `deleteLastMessage` :140、`deleteMessage` :141、`updateMessageBlock` :237、`clearChat` :289、`saveReply` :161、`extractMessageFromData` :285、`ensureMessageMediaIsArray` :239、`getMediaDisplay` :240、`getMediaIndex` :241、`appendMediaToMessage` :238、`scrollChatToBottom` :242、`scrollOnMediaLoad` :243、`streamingProcessor` :136、`sendSystemMessage` :158、`swipe` 族 :246-255 | — | 无 | 0 |

**角色与群组（15 / 2 / 2）**：`characters` :118 **有**（摘要形，`views.ts:768-774` 论证过比上游全量
description 更省且更少）；`characterId` :122 **部分**（上游 `String(characters.indexOf(...))`，Iris 做了
索引翻译 `frame.ts:707-730`，人贩子物语 L469 的数组下标读因此成立）；`getCharacters` :229、
`getOneCharacter` :230、`getCharacterCardFields` :231、`getCharacterSource` :232、`selectCharacterById` :209、
`openCharacterChat` :155、`createCharacterData` :220、`unshallowCharacter` :296、`getThumbnailUrl` :208、
`groups` :119、`groupId` :123、`openGroupChat` :156、`unshallowGroupMembers` :297 —— 无，语料 0。

**生成控制（26 / 2 / 0）**：`generate` :142（= `Generate`）与 `generateRaw` :204 **有**
（`frame.ts:906-927`，字符串或 `{prompt|user_input}` 形状，其余按名拒绝——未测过的实参形状不猜）；
`generateRawData` :205、`generateQuietPrompt` :203、`sendGenerationRequest` :144、`sendStreamingRequest` :143、
`stopGeneration` :145、`ChatCompletionService` :290、`TextCompletionService` :291、
`ConnectionManagerRequestService` :292、`getRequestHeaders` :128、`CONNECT_API_MAP` :283、
`getTextGenServer` :284、`getChatCompletionModel` :287、`chatCompletionSettings` :226、
`textCompletionSettings` :227、`mainApi` :199、`onlineStatus` :132、`maxContext` :133、
`shouldSendOnEnter` :211、`isMobile` :212、`ToolManager` :186 及工具注册四件 :182-185 —— 无，语料 0。

**预设与注入（3 / 1 / 1）**：`setExtensionPrompt` :152 **部分**（key/value/position/depth 四参，position 数字
翻译成具名档位，`scan`/`role`/`filter` 未建且显式报告，`frame.ts:817-851`）；`extensionPrompts` :151、
`getPresetManager` :286 —— 无。

**斜杠与宏（15 / 0 / 0）**：`substituteParams` :162、`substituteParamsExtended` :163、`SlashCommandParser` :164、
`SlashCommand` :165、`SlashCommandArgument` :166、`SlashCommandNamedArgument` :167、`SlashCommandEnumValue` :168、
`ARGUMENT_TYPE` :169、`executeSlashCommandsWithOptions` :170、`registerSlashCommand` :172（deprecated）、
`executeSlashCommands` :174（deprecated）、`macros` :244、`registerMacro` :179、`unregisterMacro` :180、
`registerHelper` :177（no-op）—— 全无，语料 0。**注意**：`triggerSlash` 的语料需求由 TH 面
`TavernHelper.triggerSlash` 承接（TH-SURFACE-AUDIT §3.23），ST 面这组是另一套拼写，无人用。

**世界书（7 / 1 / 0）**：`loadWorldInfo` :276 **有**（三值语义 object/null/undefined 逐条转写，
`frame.ts:877-887`）；`saveWorldInfo` :277、`reloadWorldInfoEditor` :278、`updateWorldInfoList` :279、
`convertCharacterBook` :280、`getWorldInfoPrompt` :281、`getWorldInfoNames` :282 —— 无。

**事件（3 / 2 / 2）**：`eventSource` :137、`event_types` :222（deprecated 旧拼）与 `eventTypes` :138 ——
前两个**有**且与 parent 桥同物（`frame.ts:679-685`，双路由必须同一总线）；语料 2 卡成对守卫
（`if (ctx && ctx.eventSource && ctx.event_types)` 的形状——这也是为什么两个要一起建）。

**弹窗与界面（11 / 5 / 0）**：`Popup` :223、`POPUP_TYPE` :224、`POPUP_RESULT` :225、`callGenericPopup` :194、
`callPopup` :193 **有**（shell 画的上游返回值契约，commit `9de4d12`，DEVIATIONS web §58）；本语料 0 用——
**保留**，它们是为 MagVarUpdate（旧语料）建的，量具没有"零使用即拆除"的建议权；`messageFormatting` :210、
`activateSendButtons` :159、`deactivateSendButtons` :160、`showLoader` :196、`hideLoader` :197、`loader` :245 —— 无。

**扩展与设置（11 / 1 / 1）**：`extensionSettings` :200 **部分**（卡分区而非全装共享，`views.ts:781-806`
的三形状测量与论证；写侧的 Proxy 上报在 `frame.ts:561-573`）；`saveSettingsDebounced` :131 **有**
（`frame.ts:647-648`）；`saveSettings`（非 145 成员，Iris 自答）有；`ModuleWorkerWrapper` :201、
`writeExtensionField` :206、`writeExtensionFieldBulk` :207、`renderExtensionTemplate` :189、
`renderExtensionTemplateAsync` :190、`registerDataBankScraper` :191、`getExtensionManifest` :298、
`openThirdPartyExtensionMenu` :299、`powerUserSettings` :228、`accountStorage` :116 —— 无。

**分词（5 / 0 / 0）**：`tokenizers` :146、`getTextTokens` :147、`getTokenCount` :149（deprecated）、
`getTokenCountAsync` :150、`getTokenizerModel` :202 —— 无。

**杂项（24 / 4 / 4）**：`name1` :120、`name2` :121、`getCurrentChatId` :127、`updateChatMetadata` :153 ——
见上；`renameChat` :130、`reloadCurrentChat` :129（**缺，§4.1.1**）、`timestampToMoment` :175、
`registerDebugFunction` :187、`t` :213、`translate` :214、`getCurrentLocale` :215、`addLocaleData` :216、
`tags` :217、`tagMap` :218、`menuType` :219、`importFromExternalUrl` :233、`importTags` :234、`uuidv4` :235、
`humanizedDateTime` :236、`updateReasoningUI` :293、`parseReasoningFromString` :294、
`getReasoningTemplateByName` :295、`symbols` :300、`constants` :303 —— 无。

**上游有、Iris 也答、但不属于 145**：`getContext`（`frame.ts:620`——它是产生这个对象的函数）与
`saveSettings`（`frame.ts:647`，上游卡面无此名；MVU 的 watch 每帧调用是建它的实测理由）。

### 3.2 parent 面：上游「整页」到底有什么，Iris 桥了什么，卡摸了什么

**上游页面全局的三个来源**（这就是"上游=整个页面"的精确化）：

1. **index.html 经典脚本**（`index.html:8187-8199`）：jQuery 3.5.1、jQuery UI 全家（transit/cookie/
   touch-punch/cropper/izoomify）、**toastr**、select2、pagination、toolcool-color-picker、cropper。
2. **`lib.js:34-88` `initLibraryShims`**（"old extensions" 兼容垫）：`Fuse` `DOMPurify` `hljs` `localforage`
   `Handlebars` `diff_match_patch` `SVGInject` **`showdown`** `moment` `Popper` `droll`。
3. **酒馆助手**：`predefine.js:1` `window._ = window.parent._`、`:12` 从父窗 `_.pick` 进卡帧
   `['EjsTemplate','TavernHelper','YAML','showdown','toastr','z']`、`:26-31` 把卡帧里的 `SillyTavern`
   定义成 getter：`{...getContext(), getContext, writeExtensionField}` —— **上游卡脚本看见的 SillyTavern
   全局是 145 + getContext + writeExtensionField，与 getContext() 同一物**；`:37-43` 有 `Mvu` 就镜像。
   而 **ST 页面自己的 `SillyTavern` 全局只有 `{libs, getContext}`**（`script.js:292-295`）——这是本审计
   对「上游=145 成员 + 24 库」这条旧账最重要的一处修正：模块导出不落 window，
   `top.sendMessageAsUser` 这类读在上游页面同样是 `undefined`。

**Iris 的虚拟 parent**（`frame.ts:1098-1330` get 陷阱逐分支）应答 22 个名：
`document`（→虚拟文档）、`innerWidth`/`innerHeight`、`SillyTavern`、`extension_settings`、`TavernHelper`、
`eventSource`、`event_types`、`addEventListener`/`removeEventListener`/`dispatchEvent`、六个调度器
（`frame.ts:64-71`）、`EjsTemplate`、`is_send_press`、`$`/`jQuery`、`postMessage`（DEVIATIONS §76），
外加运行期发布名（`Mvu`，`frame.ts:2766`；卡自己的发布走 `published` bag）。`parent.document` 二跳
另有虚拟文档的 24 名（`virtual-document.ts:284-389`：查找/创建/事件三件/`readyState`/可见性/
`title`/`URL`/字符集常数）。**宽于上游的一处**：`parent.SillyTavern` 上游只有 `{libs, getContext}`，
Iris 给整个 facade——`SillyTavern.saveChat` 经 parent 拼写在 Iris 可用、在上游不可用；语料 6 卡 27 站
`parent.SillyTavern` 里真正摸成员的拼法都走 `getContext()`，未见依赖此宽面者，记录不动。

**语料在 parent 面读到的 50 个真名**（去掉 2 假阳性 1 打包噪声），按裁定分三桶：

- **桥接且工作**（21 名）：`document`(11卡38) `SillyTavern`(6卡27) `Mvu`(4卡16) `TavernHelper`(4卡7)
  `innerWidth`(3卡) `innerHeight`(3卡) `$`(3卡) `jQuery`(2卡) `eventSource`(2卡) `event_types`(2卡)
  `extension_settings`(1卡) `is_send_press`(1卡) `setTimeout`/`clearTimeout`/`requestAnimationFrame`/
  `cancelAnimationFrame`/`addEventListener`/`dispatchEvent`（各1卡）`postMessage`(2卡)；经 `parent.document`
  二跳的 `body`/`head`/`getElementById`/`querySelectorAll`/`createElement`/`readyState`（银麒赎世 `_pd.*`，
  虚拟文档全接）。
- **未桥且上游页面也没有**（§4.2.3，不补）：`eventOn`(3卡) `context` `sendMessageAsUser` `stopAllGeneration`
  `saveChat`/`reloadCurrentChat`/`printMessages`/`substituteParams` 的 `top.X` 拼写 `markdown`
  `markdown_parser` `showdown`(见下) `getVariables` `replaceVariables` `tavern_events` `getModelList`
  `getLastMessageId` `getCurrentMessageId` `getWorldbookNames` `__kaidanMvuSchema` `mvuCurrentFloatingBg`。
- **未桥且上游页面真有**（§4.2 真缺）：`toastr`、`localStorage`、`alert`、`confirm`、`prompt`。

### 3.3 裸全局面：Iris 全供，零真缺

上游把七个全局借给每个脚本帧（`predefine.js:1,12` + `parent_jquery.js` 的 `window.$ = window.parent.$`，
外加 CDN 标签的 Vue/VueRouter——清单与出处见 `preset-globals.ts:16-35` 的表）。Iris 的对应实现
**全部已落地、全部从代码核实**（不是从注释——`preset-globals.ts:65-69` 的散文还写着
"showdown、VueRouter absent and reported"，那句话已过时，供面以代码为准）：

| 全局 | Iris 实现 | 出处 |
| --- | --- | --- |
| `$` / `jQuery` | 真库，绑帧内 document | preset-entry.ts:145-146 |
| `_` | lodash-es | preset-entry.ts:100 |
| `z` | zod，经 `zod-global.ts` 的访问器（人贩子物语的 `.z` 自引用重建） | preset-entry.ts:52 |
| `YAML` | yaml 包 | preset-entry.ts:123 |
| `showdown` | showdown 包（UMD 形状） | preset-entry.ts:200 |
| `Vue` / `VueRouter` | bundle（不再 CDN 标签） | preset-entry.ts:177, :230 |
| `toastr` | **报告适配器**（调用进运行面板，不弹通知） | toastr-report.ts + frame.ts `provideToastr` |
| `EjsTemplate` | frame 建，仅 `evalTemplate` | frame.ts:2147 + resolveValues |
| `Mvu` | 运行期由 MVU bundle 发布进共享 bag | frame.ts:2766 |
| `fetch`/`alert`/`confirm`/`prompt`/`getScriptId`/`triggerSlash` | 桥接/拒绝按各自章节 | frame.ts core 表 `:2139-2184` |

语料用量：`$` 20卡/102、`_` 17卡/73、`z` 17卡/19、`Mvu` 16卡/68、`toastr` 7卡/44、`EjsTemplate` 1卡/1；
`YAML`/`Vue`/`VueRouter`/`Fuse`/`DOMPurify`/`hljs`/`moment`/`Handlebars`/`Popper`/`droll`/`localforage`/
`diff_match_patch`/`SVGInject`/`Split`/`d3`/`dayjs`/`Chart` 等 **全部 0 卡**。

---

## 四、缺口建议清单（五元组）

### 4.1 ST `getContext()` 面（3 席）

#### 4.1.1 `reloadCurrentChat` —— P1，排期补

- **谁在用**：命定之诗与黄昏之歌 v3.0.4，界面正则「首页」L891
  `await SillyTavern.saveChat(); await SillyTavern.reloadCurrentChat();`——**无守卫**。这是"切换场景
  （swipe）"按钮的收尾：先写 `SillyTavern.chat[0].swipe_id/mes`（该写入被 CHAT-WRITES 的日志代理
  接住、随 L890 的 saveChat 落盘 ✓），再请求重绘。Iris 现状：读 `SillyTavern.reloadCurrentChat` 得
  `undefined`，await 抛 `TypeError`，`Successfully switched` 永不打印——**数据已存、界面没换、脚本
  在收尾处死**。
- **上游语义**：`script.js:1676` `export const reloadCurrentChat = reloadChatMutex.update.bind(reloadChatMutex)`
  ——从磁盘重读当前聊天、重置聊天 DOM、重渲染；`st-context.js:129` 原样暴露。
- **Iris 现状与原因**：无。快照 19 成员是「语料的 47 个脚本实际摸到的交集」（`views.ts:751-756`），
  而当年语料群没有正则源文本（§2.1 的差异），命定之诗的这段界面不在册——**漏因是语料覆盖，
  不是有人裁定不做**。
- **建议**：P1。一行进 facade，委派到已有臂。
- **机制草案**：`frame.ts` SillyTavern 代理加 `reloadCurrentChat` 分支 → `callAction('reloadChat', {})`；
  shell 侧重推 `script.context` 快照并触发阅读列重渲染（saveChat 落盘后 Iris 本就响应式刷新视图，
  该臂的主体是「等重渲染完成再 resolve」，语义上等价于上游的"重读后重绘"）。挂 ST 面
  （合法 145 成员，`isOnSillyTavernSurface` 自然为真）。风险：上游带 mutex（防并发重入），Iris 的
  等价物是重渲染门的幂等性；工作量 **M**。

#### 4.1.2 `addOneMessage` —— P1，排期补（随 4.1.3 同一批）

- **谁在用**：银麒赎世 L19181、魔法少女的扣扣审判 L12221，均为
  `if (typeof context.addOneMessage === "function")` 守卫——Iris 上守卫失败，**静默跳过**。
- **上游语义**：`script.js` 的 `addOneMessage(mes, opts)`（st-context.js:139 暴露）：把一条消息追加进
  `chat` 数组并画进聊天 DOM。**关键裁定已有**：CHAT-WRITES.md:54 记录了卡片序
  `push`（数据）→ `addOneMessage`（画）→ `saveChat`（存），且 :132 量过——"没有站点只靠
  addOneMessage 完成插入"。即**数据不丢**（push 已被日志代理记录、saveChat 已落盘），缺的只是
  "画"这一步的即时性。
- **Iris 现状与原因**：无；同 4.1.1，语料覆盖缺口。
- **建议**：P1。
- **机制草案**：facade 分支把 `addOneMessage(mes, opts)` 翻译到既有 `script.createChatMessages` 臂
  （TH 拼写的聊天写入族已在 `CARD_METHODS`，chat-journal.ts 已会重放）——或按 CHAT-WRITES.md:136
  的裁定（"addOneMessage/printMessages 是布线层"）翻译成一次有报告的重绘请求。两案共享
  4.1.3 的臂。风险：`insertAt`/`type` 参数语义；本语料两处调用都不带第二参。工作量 **S–M**。

#### 4.1.3 `printMessages` —— P1，同批

- **谁在用**：银麒赎世 L19183 `else if (typeof context.printMessages === "function")`（同一守卫链的
  降级分支）；魔法少女审判的 `top.printMessages`（parent 面，§4.2.3）。
- **上游语义**：`script.js:1475` `export async function printMessages()`：全量重绘聊天 DOM（st-context.js:288）。
- **Iris 现状与原因**：无；同上。
- **建议**：P1。
- **机制草案**：与 4.1.1 共用一个"重渲染"wire 臂（`script.refreshChatView` 或复用 reloadChat 的
  渲染半边）。S。

### 4.2 parent 面

#### 4.2.1 `parent.alert` / `parent.confirm` / `parent.prompt` —— **P0，现在补**

- **谁在用**：银麒赎世 L52 `_pw.alert("未找到API通道…")` 与 L4349 `if (!_pw.confirm("确定导入存档？…")) return;`
  ——**两处都无守卫**。`_pw` 是它 `var _pw = window.parent` 的宿主窗别名；Iris 上读出 `undefined`，
  调用即 `TypeError: _pw.alert is not a function`——找不到 API 通道时**报错的那行自己把脚本打死**，
  导入存档的确认框把脚本打死。L4403 的 `_pw.prompt &&` 有守卫，静默。
- **上游语义**：`alert`/`confirm`/`prompt` 是任何 window 的原生方法，parent 上必然存在。
- **Iris 现状与原因**：裸全局的三个对话框**已经桥了**（frame.ts core 表 `:2181-2183` + `bridgedDialogs`，
  `allow-modals` 从不发放所以浏览器的静默 no-op 被"看得见的拒绝"替换）；虚拟 parent 的 get 陷阱
  **没有同名分支**——没人把"卡会先摸 `parent.alert` 再摸裸 `alert`"当作要测的形状。这不是裁定，
  是漏项。
- **建议**：**P0**（唯一让语料卡当场死的缺口）。
- **机制草案**：虚拟 parent get 陷阱加三分支，返回 `bridgedDialogs['alert'|'confirm'|'prompt']`
  同一物（裸与 parent 两个拼法一个实现——`eventSource` 已示范过这个规矩，`frame.ts:679-685`）；
  `isBridged`（`frame.ts:1070-1096`）加三名为只读；`has` 陷阱同步；测试钉"两个拼法同物 + confirm
  返回 false / prompt 返回 null"。注入零成本：值已在帧内。这正是既有机制路径的又一次套用——
  爬窗卡摸到的宿主面 = 虚拟文档 + 虚拟 parent，新成员一律"分支 + 帧内已有物 + has 同步"
  （事件靶与调度器两轮的同一形状，DEVIATIONS web §71 后记，`notes/apps/iris-web/DEVIATIONS.md:3365-3386`）。
  工作量 **S**。

#### 4.2.2 `parent.toastr` —— P1

- **谁在用**：银麒赎世 L94 `if (_pw.toastr) _pw.toastr.success("API设置已保存")`、哈人冰恋世界 L56
  `window.parent.toastr ? … : window.toastr`、人贩子物语 L866 `var toast = hostWindow.toastr`——三卡全带
  兜底，Iris 上**静默不弹**（银麒赎世的兜底是跳过；哈人冰恋世界落到帧内适配器还能进面板）。
- **上游语义**：页面级 toastr（index.html:8194 经典脚本），`predefine.js:12` 把它 pick 进每个脚本帧。
- **Iris 现状与原因**：帧内 `toastr` 有（报告适配器）；parent 拼写无分支。同 4.2.1 的漏项形状。
- **建议**：P1。
- **机制草案**：parent get 加 `toastr` 分支返回 `provideToastr` 发放的同一对象；`isBridged` 加名。
  **先记一笔分歧**：即使桥了，卡的 toast 在 Iris 也不弹——进面板。这是 toastr-report.ts 的既有裁定，
  本缺口补的是"同一物两个拼法"，不是"真弹 toast"。S。

#### 4.2.3 「上游页面也没有」的防御性探测（19 名）—— 明确不补

| 名 | 卡（证据） | 上游页面上的真值 |
| --- | --- | --- |
| `eventOn` | 人贩子物语 L85、灭仇家 L48、绿茵好莱坞 L744（全 `typeof` 守卫） | undefined——TH 在页面只发布 `globalThis.TavernHelper` 命名空间（dist 反汇编仅一处赋值），裸 `eventOn` 不落页（predefine 只 `_.pick` 六名进卡帧） |
| `getVariables`/`replaceVariables`/`tavern_events`/`getModelList`/`getLastMessageId`/`getCurrentMessageId` | 人贩子物语 L69-569 的 hostWindow 探测族，全部 try/typeof | 同上，全 undefined |
| `getWorldbookNames` | 哈人冰恋世界 L25 `typeof window.parent.getWorldbookNames === 'function' ? window.parent : window` | undefined（TH 成员，只在卡帧内） |
| `sendMessageAsUser` | 魔法少女审判 L1430 `typeof top.sendMessageAsUser` | undefined——`script.js:5815` 是模块导出，`type="module"` 不落 window（index.html:8204） |
| `stopAllGeneration` | 魔法少女审判 L1448 | undefined——上游 public 整树无此名（TH @types 才有） |
| `context` | 魔法少女审判 L1388 `top.context && Array.isArray(top.context.chat)` | undefined |
| `saveChat`/`reloadCurrentChat`/`printMessages`/`substituteParams` 的 **`top.X` 拼写** | 魔法少女审判 L1502-1536 | 全 undefined（同模块导出理由；`substituteParams` 在 `script.js:2922`） |
| `markdown` / `markdown_parser` | 魔法少女审判 L1539-1541 `if (top.showdown && top.markdown)` | 都 undefined——**上游分支同样不命中**（showdown 存在但 markdown 不存在，组合为假），Iris 现状与上游逐位一致 |
| `__kaidanMvuSchema` | 人贩子物语 L602（卡间发布探测） | 取决于发布方；Iris 的 published bag 卡内可接，跨卡不可见（范围分歧，DEVIATIONS web §71 后记的爬窗机制路径，`notes/apps/iris-web/DEVIATIONS.md:3365-3386`） |
| `mvuCurrentFloatingBg` | 哈人冰恋世界 L405 `window.top.mvuCurrentFloatingBg = …`（**写**） | 上游写在页面 window（跨卡可见）；Iris set 陷阱落 published bag（卡内可见）——**已被接住**，范围收窄记录在案 |

不补的理由是本项目已付过学费的那条（DEVIATIONS §12 chat_metadata 案）：这些守卫在**上游同样
失败**，卡作者看到的退化行为就是他们的基准线；把名字补上会让死分支在 Iris 活过来——
**修复它才是分歧**。若未来一张卡的守卫链没有兜底而硬依赖其中某名，届时按 §4.1 的路径单名
补，且必须在 DEVIATIONS 记"我们比上游多激活了一条路径"。

#### 4.2.4 `parent.showdown` —— P2，记录（结论：现状与上游一致）

魔法少女审判 L1539 的组合条件 `top.showdown && top.markdown` 在上游为假（§4.2.3），故 parent 上
补不补 `showdown` 都不改变行为。裸 `showdown` Iris 已供（preset-entry.ts:200）。**不动**；只把
`top.showdown` 单独出现的守卫列入量具的观察名单。

#### 4.2.5 `parent.localStorage` —— P2

- **谁在用**：人贩子物语 L966（try/catch 内 `hostWindow.localStorage.getItem('kdn_opt_direct')`）、
  灭仇家 L1756 `(hostWindow.localStorage || window.localStorage).getItem(...)`——两卡都有兜底，Iris 上
  人贩子物语静默丢一个偏好读，灭仇家落到帧内 card-storage 后行为闭环。
- **上游语义**：window 原生属性（页面全局存储，跨卡共享）。
- **机制草案**（若排期）：parent get 加 `localStorage` getter 返回帧的 card-storage 门面（裸
  `localStorage` 的同一物，card-storage.ts 已建）。**必须记的分歧**：上游 parent 的 localStorage 是
  页面级（跨卡共享），card-storage 是卡面——桥接会把"读别人的键"变成"读自己的空表"，对探测型
  读取（这两卡都是）恰是安全方向。S。

### 4.3 裸全局面：旧账三笔证伪记录

| 旧账 | 语料实况 | 判决 |
| --- | --- | --- |
| 缺 `Split`，2 卡 | OVERLORD不死者之王 `// Split by '·'`（注释）、创世回廊1.3 `/* Side Nav Styles for Split View */`（CSS 注释） | **0 卡真用**，无此库需求 |
| 缺 `moment`，1 卡 | 银麒赎世「手机UI」的 `momentsU` / `"yinqi-moments-unread"`（变量名/存储键含 moment 字串） | **0 卡真用**；上游页面确有 `window.moment`（lib.js:72），但无人摸 |
| 缺 `d3`，1 卡 | 创世回廊 `{{roll: d3}}`（宏）、希尔 `.xr-d3`（CSS 类）、爱衣 `const d3 =`（局部变量） | **0 卡真用** |

另纠正一处**文档腐化**：`preset-globals.ts:65-69` 散文仍称 `showdown`、`VueRouter`、`EjsTemplate`
"absent and reported"，而 `preset-entry.ts:200/:230` 与 frame.ts core 已供后两者——供面以代码为准，
该注释段应在下次触碰该文件时改写（期望清单 `EXPECTED_GLOBALS` 本身没错，错的是那段旧散文）。

---

## 五、P0 / P1 / P2 汇总

| 级 | 项 | 卡 | 一句话 |
| --- | --- | --- | --- |
| **P0**（1 项） | parent `alert`/`confirm`/`prompt` 桥 | 银麒赎世（2 处硬崩点） | 唯一让语料卡当场死的缺口；值已在帧内，三个分支 + has/isBridged 同步，S |
| **P1**（3 项） | `reloadCurrentChat` | 命定之诗（1 卡，无守卫崩在收尾） | 新 wire 臂：重推快照 + 等重渲染，M |
| | `addOneMessage` + `printMessages` | 银麒赎世、魔法少女审判（2 卡 3 处，守卫静默） | 共用一个「重绘」臂，翻译到既有 createChatMessages/重渲染半边，S–M |
| | parent `toastr` | 银麒赎世、人贩子物语、哈人冰恋世界 | 返回 provideToastr 同一物；记"不弹只报"分歧，S |
| **P2**（2 项 + 3 记录） | parent `localStorage` | 人贩子物语、灭仇家（均有兜底） | 返回 card-storage 门面；记页面级→卡面范围分歧，S |
| | `preset-globals.ts:65-69` 旧散文纠偏 | —（文档） | 下次触碰时改写 |
| | 记录：`parent.SillyTavern` 宽面、`mvuCurrentFloatingBg`/`__kaidanMvuSchema` 卡内范围、§4.2.4 `top.showdown` 组合 | — | 不动，分歧在案 |
| **明确不补**（19 名） | §4.2.3 全表 | 3 卡（eventOn 族）+ 魔法少女审判（top.* 族）等 | 上游页面同样 undefined；守卫退化即上游基线；补=激活上游死分支 |

**缺口总账**：用了但缺——ST 面 3 名（3 卡）、parent 面 5 名（4 卡，其中仅 alert/confirm 硬坏）、
bare 面 0；没用也缺——ST 面 117 名（120 未应答中 3 名被用）、parent 面 19 名（裁定不补）、bare 面 0
（上游垫的全套都供了）；部分实现——ST 面 5 名（`characterId` `extensionSettings` `variables` `chatId`
`setExtensionPrompt`，各有已记录的收窄理由）。

---

## 六、复现

```
node scripts/st-context-audit.mjs               # 三面总表 + GAP SUMMARY
node scripts/st-context-audit.mjs --verbose     # 每成员每卡证据行
node scripts/st-context-audit.mjs --surface     # 145 键提取自检
```

需 `E:\sillyTavern\SillyTavern` 在位（或 `IRIS_UPSTREAM` 指向安装）；Iris 语料在仓库内，样本目录
`D:\workspace\小项目\iris_分支\测试用卡` 缺了自动跳过。量具恒 exit 0：卡尺，不是测试。
