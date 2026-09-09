# TH 接口面逐成员审计 —— 酒馆助手 4.9.1 声明给卡脚本的 171 个成员

日期 2026-09-08。审计分支 `dev/audit-th-surface`。
**[TH]** 酒馆助手（JS-Slash-Runner）4.9.1，取自操作机安装
`E:\sillyTavern\SillyTavern\data\default-user\extensions\JS-Slash-Runner`（只读）。
**[Iris]** 本仓库 `e31dca4`。
量具：`scripts/th-surface-audit.mjs`（本次新写，只读）；既有卡尺 `scripts/th-member-census.mjs`
照跑对账。171 成员清单的权威来源是
`apps/iris-web/src/sandbox/upstream-surface.ts:30-202`（`UPSTREAM_MEMBERS`，由 @types 提取、
测试钉住），本审计不另立清单，只把账做全。

---

## 一、总览

### 1.1 四层账目（对齐既有那张 171/54/31/4 的表，数字全部重测）

| 层 | 旧账 | 本审计 | 差异原因 |
| --- | --- | --- | --- |
| TH 声明给卡脚本的成员 | 171 | **171** | 不变；上游 @types 里逐一找到了声明位置（`--locations` 无「未定位」） |
| Iris 已建 | 54（32%） | **已实现 54 + 部分 3** | 54 的口径与 `MEMBER_KINDS` ∩ 171 完全对上（identity.ts 有 57 条，其中 `getSwipes`/`swipeTo`/`mvu_events` 不在 171 内）；「部分 3」= `Mvu`、`SillyTavern`、`EjsTemplate`，它们的供面不在 `MEMBER_KINDS` 里，旧账把它们算进「用到但缺」的泛名 |
| 语料用到 | 31 | **33** | 语料从 ST 安装库扩到四个群体（§2.1），Iris 数据目录的 12 张卡带来了新命中 |
| 用到但缺 | 4（两个泛名） | **5 席：真缺 3 + 部分 2** | 真缺：`getPreset`（1 卡）、`getCharData`（1 卡，**新发现**，人贩子物语）、`registerMacroLike`（1 卡）；部分：`Mvu`（16 卡）、`SillyTavern`（5 卡）——后两个 Iris **有面**（见 §4.1.4、§4.1.5），旧账按 `MEMBER_KINDS` 口径把它们记成「缺」 |

净结论：**真正「卡在伸手而 Iris 一无名可应」的成员只有 3 个**，且三个调用点全部自带
`typeof`/try-catch 守卫，今天都走退化路径活着。**没有任何一个语料调用点硬坏在缺成员上。**

### 1.2 逐域统计（28 域，声明 171 = 已实现 54 + 部分 3 + 未提供 114；表中库全局 4 域并作一行）

| 域 | 声明 | 已建 | 语料用过 | 域 | 声明 | 已建 | 语料用过 |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 世界书 | 16 | 12 | 3 | 扩展管理 | 8 | 0 | 0 |
| 预设 | 15 | 0 | 1 | 世界书条目（旧族） | 6 | 0 | 0 |
| 事件 | 13 | 11 | 5 | 聊天消息 | 5 | 4 | 3 |
| 脚本 | 12 | 5 | 2 | 正则 | 5 | 0 | 0 |
| 世界书（旧 lorebook 族） | 11 | 1 | 0 | 原始导入 | 5 | 0 | 0 |
| 个人名片 | 11 | 0 | 0 | 角色原始数据 | 4 | 0 | 1 |
| 角色卡 | 10 | 0 | 0 | 楼层消息 | 3 | 0 | 0 |
| 音频 | 8 | 0 | 0 | 版本 | 3 | 1 | 0 |
| 生成 | 8 | 2 | 2 | 跨 iframe 全局 | 2 | 2 | 1 |
| 变量 | 8 | 7 | 4 | 提示词注入 | 2 | 2 | 1 |
| 工具 | 8 | 5 | 5 | 宏 | 2 | 0 | 1 |
| 库全局（EJS/MVU/ST/TH） | 4 | 4 | 3 | 内置 | 1 | 0 | 0 |
| 斜杠命令 | 1 | 1 | 1 | | | | |

缺口的**形状**很偏科：已建的 54 个集中在变量（7/8）、事件（11/13）、聊天消息（4/5）、
世界书（12/16）、工具（5/8）、生成（2/8）——正是 `notes/PLAN.md:234` 当初裁定的 MVP 五组
「变量、聊天消息、生成、事件、世界书读取」。整域为零的八个域（预设、个人名片、角色卡、
音频、扩展管理、正则、原始导入、楼层消息）里，只有预设域有语料命中（`getPreset`，1 卡）。

### 1.3 语料用量 top 名单（按卡数；全表见 `--locations`/`--evidence` 输出）

| 成员 | 卡数 | 静态调用 | 字符串命中 | Iris 现状 | 群体 |
| --- | ---: | ---: | ---: | --- | --- |
| `eventOn` | 16 | 251 | 2 | 已实现 | 全部四个 |
| `Mvu` | 16 | 103 | 27 | **部分** | 全部四个 |
| `waitGlobalInitialized('Mvu')` | 14 | 26 | 0 | 已实现 | 全部四个 |
| `tavern_events` | 9 | 26 | 0 | 已实现 | iris/测试/st |
| `setChatMessages` | 8 | 14 | 1 | 已实现 | 全部四个 |
| `triggerSlash` | 7 | 11 | 0 | 已实现 | iris/界面/测试 |
| `eventEmit` | 6 | 515 | 1 | 已实现 | 全部四个 |
| `getVariables` | 6 | 44 | 1 | 已实现 | iris/测试/st |
| `getChatMessages` | 6 | 13 | 0 | 已实现 | 全部四个 |
| `errorCatched` | 6 | 7 | 0 | 已实现 | 界面/测试/st |
| `SillyTavern` | 5 | 44 | 0 | **部分** | iris/测试/st |
| `getAllVariables` | 5 | 9 | 0 | 已实现 | 界面/测试 |
| `generate` | 5 | 7 | 5 | 已实现 | iris/测试/st |
| `replaceVariables` | 4 | 27 | 1 | 已实现 | iris/测试/st |
| `getCurrentMessageId` | 4 | 5 | 0 | 已实现 | iris/界面/测试 |
| `getLastMessageId` | 3 | 111 | 0 | 已实现 | iris/测试 |
| ……（33 个用过成员的完整表由量具输出） | | | | | |

界面侧独有重心的结论与 `notes/TEST-CARDS.md:1244` 一致并延伸到 Iris 语料：
`triggerSlash` 7 卡全部是界面/正则界面调用（脚本体只有人贩子物语 1 处）；
`getAllVariables` 5 卡全部在界面里（哈人冰恋世界、新架空政治经济模拟器等）。

---

## 二、口径与量具

### 2.1 语料群体（四群，114 段代码）

| 群体 | 出处 | 段数 | 说明 |
| --- | --- | ---: | --- |
| iris-卡 | `apps/iris/data/default-user/characters`（12 文件） | 26 | `extractScripts` 取的 tavern_helper.scripts 脚本体 |
| iris-界面 | `apps/iris/data/default-user/chats`（Iris 导出的 ST JSONL） | 9 | 卡的正则脚本在聊天楼层上渲染后的 `<script>` 块，按卡去重 |
| 测试用卡 | `D:\workspace\小项目\iris_分支\测试用卡`（9 文件） | 32 | 脚本体 + 正则 `replaceString` 里的界面块 |
| st-卡 + st-界面 | `E:\sillyTavern\...\data\default-user`（19 卡 + chats） | 47 | 既有 census 的口径，保留以对账 |

注意测试用卡目录与 iris-卡有重叠家族，按**脚本内容 sha256** 对出的同名组件
（`1_5` ≡ 哈人冰恋世界、`2.1.0` ≡ 灭仇家满门、`2` ≡ 绿茵好莱坞、`v0.5NSFW` ≡ 尸变纪元-v0、
`V1.5.4_` ≡ 不要被神隐挑战-V1.5；`Lights_ON` 与 人偶演出Lights-ON 按名对应但脚本体无共哈希），
这是 `notes/TEST-CARDS.md:71` 记录过的现象；按卡文件的计数把它们当不同卡，
**所以「卡数」是卡文件数口径的上界**，家族归并在 §四的逐条证据里注明。

### 2.2 探针与它的下界性质

静态探针与 census 同型：标识符在词边界处被调用或取用，允许
`window.parent.TavernHelper.x` 一类的窗口链与可选链；另计**字符串命中**
（成员名以字符串字面量出现，`TavernHelper['x']`、表驱动、拼名的形状）。

**探针是下界，本轮抓到一个实例**：银麒赎世的 手机UI 脚本先
`var tw = window.parent || window` 再 `tw.EjsTemplate.evalTemplate(...)` ——
经局部别名翻墙，静态探针看不见，是拿 `notes/TEST-CARDS.md:3012` 的旧记录对出来的
（该卡确实真调用，且带 `typeof ... === "function"` 守卫）。所以：
**凡「未提供且 0 命中」的成员，结论是「语料未见静态使用」，不是「无人使用」。**

### 2.3 「现状」的判定来源

- **已实现**：机械提取——`tavern-helper.ts:1495` 起 `const api` 字面量的 54 键 +
  `detached['TavernHelper']`（`tavern-helper.ts:2965`）+ frame 侧 `core` 名单
  （`frame.ts:2139`：`SillyTavern`/`EjsTemplate`/`triggerSlash`/`getScriptId`）+
  `coordination` 对（`frame.ts:2019,2024`：`initializeGlobal`/`waitGlobalInitialized`）。
- **部分**：三个全局对象有面但语义覆盖不完，逐条裁定见 §4.1.4-§4.1.6。
- **未提供**：不在此三面上的 114 个。卡脚本够到它们时，`script-run-state.ts:283`
  的分支会把 `ReferenceError` 翻译成「upstream declares this … missing scope here,
  not a fault in the card」——这就是 `upstream-surface.ts` 存在的意义，账目没有白建。

---

## 三、逐域明细（171 成员全表）

格式：成员 · 上游声明 `[TH] 文件:行` · 语义一句话 · Iris 现状 · 语料（卡数/静态调用次）。
「deprecated」= 上游声明前 6 行内带 `@deprecated`。**加粗**成员有跨域备注。

### 3.1 世界书（16 声明 / 12 已建 / 语料 3）

Iris 的新世界书族几乎是完整体；缺的是删除与 orReplace 两个写动作和角色级绑定写。

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `getWorldbookNames` | function/worldbook.d.ts:6 | 全部世界书名列表 | 已实现 | 0 |
| `rebindGlobalWorldbooks` | function/worldbook.d.ts:19 | 重绑全局书选择 | 已实现 | 0 |
| `getCharWorldbookNames` | function/worldbook.d.ts:32 | 角色主/附加书名 | 已实现 | 1/3 |
| `rebindCharWorldbooks` | function/worldbook.d.ts:39 | 重绑角色书（写） | 未提供 | 0 |
| `rebindChatWorldbook` | function/worldbook.d.ts:55 | 重绑聊天书 | 已实现 | 0 |
| `getOrCreateChatWorldbook` | function/worldbook.d.ts:62 | 取或建聊天书 | 已实现 | 0 |
| `getWorldbook` | function/worldbook.d.ts:155 | 读整本书（条目数组） | 已实现 | 1/1 |
| `createWorldbook` | function/worldbook.d.ts:165 | 建书 | 已实现 | 0 |
| `createOrReplaceWorldbook` | function/worldbook.d.ts:177 | 建或整替 | 未提供 | 0 |
| `deleteWorldbook` | function/worldbook.d.ts:190 | 删书 | 未提供 | 0 |
| `replaceWorldbook` | function/worldbook.d.ts:226 | 整替整本书 | 已实现 | 1/9（旧账界面侧 2 卡 9 次的主体） |
| `updateWorldbookWith` | function/worldbook.d.ts:263 | 更新器改书 | 已实现 | 1/2 |
| `createWorldbookEntries` | function/worldbook.d.ts:285 | 批量建条目 | 已实现 | 0 |
| `deleteWorldbookEntries` | function/worldbook.d.ts:307 | 批量删条目 | 未提供 | 0 |

### 3.2 预设（15 声明 / 0 已建 / 语料 1）——有语料命名的整域空缺

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| **`getPreset`** | function/preset.d.ts:180 | 取预设（`'in_use'` = 当前；返回 `Preset{prompts,prompt_order,…}`） | **未提供（P1，§4.1.1）** | 1/2 |
| `isPresetNormalPrompt` | function/preset.d.ts:139 | 判提示词是否 normal 类 | 未提供 | 0 |
| `isPresetSystemPrompt` | function/preset.d.ts:140 | 判系统类 | 未提供 | 0 |
| `isPresetPlaceholderPrompt` | function/preset.d.ts:141 | 判占位类 | 未提供 | 0 |
| `default_preset` | function/preset.d.ts:143 | 出厂预设内容 | 未提供 | 0 |
| `getPresetNames` | function/preset.d.ts:150 | 预设名列表 | 未提供 | 0 |
| `getLoadedPresetName` | function/preset.d.ts:161 | 当前预设名 | 未提供 | 0 |
| `loadPreset` | function/preset.d.ts:169 | 按名装载（返回 bool） | 未提供 | 0 |
| `createPreset` | function/preset.d.ts:192 | 建预设 | 未提供 | 0 |
| `createOrReplacePreset` | function/preset.d.ts:204 | 建或整替 | 未提供 | 0 |
| `deletePreset` | function/preset.d.ts:217 | 删预设 | 未提供 | 0 |
| `renamePreset` | function/preset.d.ts:227 | 改名 | 未提供 | 0 |
| `replacePreset` | function/preset.d.ts:276 | 整替预设 | 未提供 | 0 |
| `updatePresetWith` | function/preset.d.ts:332 | 更新器改预设 | 未提供 | 0 |
| `setPreset` | function/preset.d.ts:361 | 局部写预设 | 未提供 | 0 |

为什么整域没建：Iris 是**单预设宿主**——宿主侧 `preset.get` 对 `'in_use'` 以外的名字按名拒绝
（`packages/iris-app-service/src/service.ts:1634`「this host only carries the one in use」），
裁定记录在 `notes/ST-COMPARE.md:233-235` 与 `notes/IMPLEMENTATION-CHECKLIST.md:46-54`
（任务 M：预设库 + `script.getPreset` 查库）。卡面的 `getPreset` 是这个域唯一被语料点名的成员。

### 3.3 事件（13 / 11 / 5）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `eventOn` | iframe/event.d.ts:42 | 订阅（返回 `{stop}` 句柄） | 已实现 | 16/251（用量第一） |
| `eventOnce` | iframe/event.d.ts:96 | 一次性订阅 | 已实现 | 2/26 |
| `eventMakeFirst` / `eventMakeLast` | iframe/event.d.ts:79/62 | 调监听器顺序 | 已实现 | 0 |
| `eventOnButton` | iframe/event.d.ts:45 | 按钮点击订阅 | **未提供，deprecated** | 0 |
| `eventEmit` | iframe/event.d.ts:118 | 发射 | 已实现 | 6/515（V1.5.4_ 论坛 SPA 一卡 248 次） |
| `eventEmitAndWait` | iframe/event.d.ts:126 | 发射并等全部监听器 | 未提供 | 0 |
| `eventRemoveListener` | iframe/event.d.ts:139 | 按函数引用退订 | 已实现 | 2/2 |
| `eventClearEvent` / `eventClearListener` / `eventClearAll` | iframe/event.d.ts:148/157/164 | 按事件/监听器/整帧清 | 已实现 | 0 |
| `iframe_events` | iframe/event.d.ts:172 | iframe 事件名表 | 已实现 | 0 |
| `tavern_events` | iframe/event.d.ts:188 | ST 事件名表 | 已实现 | 9/26 |

### 3.4 脚本（12 / 5 / 2）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `getButtonEvent` | iframe/script.d.ts:13 | 按钮名→事件类型 | 已实现 | 3/9 |
| `getScriptButtons` | iframe/script.d.ts:24 | 本脚本按钮表 | 已实现 | 0 |
| `replaceScriptButtons` | iframe/script.d.ts:41 | 整替按钮表 | 已实现 | 1/1 |
| `updateScriptButtonsWith` | iframe/script.d.ts:54 | 更新器改按钮表 | 已实现 | 0 |
| `appendInexistentScriptButtons` | iframe/script.d.ts:76 | 末尾补不重名按钮 | 已实现 | 0 |
| `getAllEnabledScriptButtons` | function/script.d.ts:4 | 全脚本启用按钮（按脚本 id 键） | 未提供 | 0 |
| `getScriptName` | iframe/script.d.ts:79 | 本脚本名 | 未提供 | 0 |
| `getScriptInfo` | iframe/script.d.ts:82 | 本脚本作者注释 | 未提供 | 0 |
| `replaceScriptInfo` | iframe/script.d.ts:89 | 替作者注释 | 未提供 | 0 |
| `getScriptTrees` / `replaceScriptTrees` / `updateScriptTreesWith` | function/script.d.ts:51/59/69 | 脚本库树（TH 面板的脚本库）读写 | 未提供 | 0 |

### 3.5 世界书（旧 lorebook 族，11 / 1 / 0）——上游整族 @deprecated

上游 4.9.1 已把全族标注弃用、逐条指向世界书新名
（如 `getLorebooks`→`getWorldbookNames`，function/lorebook.d.ts:25；`LorebookSettings`
弃用注记在 function/lorebook.d.ts:1-2）。Iris 建的恰是唯一有独立语义的
`getLorebookSettings`（function/lorebook.d.ts:20，已实现，映射到全局书选择设置）。
`setLorebookSettings`(22)、`getLorebooks`(25)、`deleteLorebook`(28)、`createLorebook`(31)、
`getCharLorebooks`(46)、`getCurrentCharPrimaryLorebook`(49)、`setCurrentCharLorebooks`(52)、
`getChatLorebook`(55)、`setChatLorebook`(58)、`getOrCreateChatLorebook`(61)
——10 个未提供，语料 0。**裁定：不补（上游已废弃），保持按名报缺即可。**

### 3.6 世界书条目（旧族，6 / 0 / 0）——同样整族 deprecated

`getLorebookEntries`(47)、`replaceLorebookEntries`(50)、`setLorebookEntries`(61)、
`createLorebookEntries`(67)、`deleteLorebookEntries`(73)、
`updateLorebookEntriesWith`(58)——全未提供、全弃用、语料 0。**不补。**

### 3.7 个人名片（11 / 0 / 0）

`getPersonaNames`(30)、`getPersonaIds`(37)、`getCurrentPersonaName`(44)、
`getCurrentPersonaId`(51)、`getPersonaAvatarPath`(60)、`getPersona`(71)、
`createPersona`(85)、`createOrReplacePersona`(104)、`deletePersona`(119)、
`replacePersona`(137)、`updatePersonaWith`(164)——全未提供、语料 0。
persona 语义在 Iris 宿主侧存在（`notes/packages/iris-app-service/UPSTREAM-PERSONA.md`），
但没有任何卡面向接口。**P2 观望**（读族 6 个是快照上的廉价读，写族 5 个涉及宿主库写授权）。

### 3.8 角色卡（10 / 0 / 0）

`getCharacterNames`(26)、`getCharacterIds`(33)、`getCurrentCharacterName`(40)、
`getCurrentCharacterId`(47)、`createCharacter`(59)、`createOrReplaceCharacter`(76)、
`deleteCharacter`(91)、`getCharacter`(105)、`replaceCharacter`(141)、
`updateCharacterWith`(183)——全未提供、语料 0。
注意与「角色原始数据」域的分工：这一族走**角色库**（列表与增删改），
卡要的「当前卡数据」在 §3.17 的 `getCharData`。角色库写在 Iris 要过授权面
（脚本按卡授权，`notes/apps/iris-web/GRANTS.md`），而语料 0 命中。**P2 观望（读族）/不补（增删族）。**

### 3.9 音频（8 / 0 / 0）

`playAudio`(29)、`pauseAudio`(36)、`getAudioList`(44)、`appendAudioList`(60)、
`replaceAudioList`(52)、`getAudioSettings`(85)、`setAudioSettings`(105)、
`getCurrentAudio`(128)——全未提供、语料 0。上游语义是驱动 ST 前端的 `#audio` 播放器
（穿 WAV/OGG 列表与循环设置）；Iris 阅读视图没有那个播放器可驱动。
**裁定：观望，出现第一张音频卡再设计；不为零命中预先造一个播放器面。**

### 3.10 生成（8 / 2 / 2）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `generate` | function/generate.d.ts:146 | 组装配 preset+世界书+历史的生成 | 已实现 | 5/7 |
| `generateRaw` | function/generate.d.ts:199 | 调用者排订单生成 | 已实现 | 2/26 |
| `getModelList` | function/generate.d.ts:208 | 模型名列表 | 未提供 | 0 |
| `getProxyPresetNames` | function/generate.d.ts:6 | 代理扩展的预设名 | 未提供 | 0 |
| `stopGenerationById` | function/generate.d.ts:216 | 按任务 id 停生成 | 未提供 | 0 |
| `stopAllGeneration` | function/generate.d.ts:223 | 停全部 | 未提供 | 0 |
| `placeholder_prompt_default_order` | function/generate.d.ts:326 | 占位提示词默认序 | 未提供 | 0 |
| `builtin_prompt_default_order` | function/generate.d.ts:525 | 内置提示词默认序 | **未提供，deprecated** | 0 |

### 3.11 变量（8 / 7 / 4）——覆盖最全的域

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `getVariables` | function/variables.d.ts:65 | 按作用域读变量 | 已实现 | 6/44 |
| `replaceVariables` | function/variables.d.ts:91 | 整替 | 已实现 | 4/27 |
| `updateVariablesWith` | function/variables.d.ts:112 | 更新器改 | 已实现 | 1/3 |
| `insertOrAssignVariables` | function/variables.d.ts:148 | 按路径插/改 | 已实现 | 1/1 |
| `insertVariables` | function/variables.d.ts:165 | 插入 | 已实现 | 0 |
| `deleteVariable` | function/variables.d.ts:182 | 按路径删 | 已实现 | 0 |
| `getAllVariables` | iframe/variables.d.ts:9 | 全作用域合读 | 已实现 | 5/9（全部界面侧） |
| **`registerVariableSchema`** | function/variables.d.ts:203 | 注册 zod 变量 schema（校验 MVU 变量） | 未提供 | 0 |

### 3.12 工具（8 / 5 / 5）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `substitudeMacros` | function/util.d.ts:11 | 按宏表替换文本 | 已实现 | 2/22 |
| `getLastMessageId` | function/util.d.ts:18 | 最后一楼下标 | 已实现 | 3/111 |
| `errorCatched` | function/util.d.ts:33 | 包一层 try-catch 返回 null | 已实现 | 6/7 |
| `getCurrentMessageId` | iframe/util.d.ts:46 | 当前楼下标 | 已实现 | 4/5 |
| `getIframeName` | iframe/util.d.ts:37 | 本 iframe 名（TH 的事件注册键） | 未提供 | 0 |
| `getMessageId` | function/util.d.ts:43 | depth→消息下标换算 | 未提供 | 0 |
| `getScriptId` | iframe/util.d.ts:55 | 本脚本 id | 已实现 | 1/1 |
| `reloadIframe` | iframe/util.d.ts:30 | 重载本 iframe | 未提供 | 0 |

### 3.13 扩展管理（8 / 0 / 0）——与宿主架构冲突的整域

`isAdmin`(2)、`getExtensionType`(15)、`getExtensionInstallationInfo`(29)、
`isInstalledExtension`(40)、`installExtension`(59)、`uninstallExtension`(74)、
`reinstallExtension`(89)、`updateExtension`(104)——全未提供、语料 0。
上游语义是装/卸/更 ST 用户脚本扩展。**裁定：不补**——Iris 的扩展面由宿主自己管理，
把「卡可以装扩展」引入会同时穿透授权面与 CSP 面（`notes/apps/iris-web/DEVIATIONS.md:1646`
记录的 CSP 对比是同一论证方向）。

### 3.14 聊天消息（5 / 4 / 3）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| `getChatMessages` | function/chat_message.d.ts:56 | 按范围读楼层（plain/swiped 双形状） | 已实现 | 6/13 |
| `setChatMessages` | function/chat_message.d.ts:150 | 按下标改楼层 | 已实现 | 8/14 |
| `createChatMessages` | function/chat_message.d.ts:188 | 追加楼层 | 已实现 | 1/1（新架空政治经济模拟器的界面） |
| `deleteChatMessages` | function/chat_message.d.ts:208 | 按下标批删 | 已实现 | 0 |
| `rotateChatMessages` | function/chat_message.d.ts:229 | 楼层轮换 | 未提供 | 0 |

### 3.15 正则（5 / 0 / 0）

`formatAsTavernRegexedString`(23)、`isCharacterTavernRegexesEnabled`(62)、
`getTavernRegexes`(87)、`replaceTavernRegexes`(103)、`updateTavernRegexesWith`(131)
——全未提供、语料 0。Iris 的正则引擎与 profile 级正则列表已经存在
（Iris 侧有自己的 regex 面板与往返导入），缺的是把这套以 TH 成员形状暴露给卡。
**P2 观望**：形状映射是现成的（`packages/iris-regex`），零命中暂不动。

### 3.16 原始导入（5 / 0 / 0）

`importRawCharacter`(12)、`importRawChat`(27)、`importRawPreset`(40)、
`importRawWorldbook`(53)、`importRawTavernRegex`(66)——全未提供、语料 0。
Iris 有自己的导入路径（角色导入进库、正则面板导入），「卡触发宿主导入」未出现。
**P2 观望**；真要做，`importRawCharacter` 可委托现有导入，工作量 M。

### 3.17 角色原始数据（4 / 0 / 1）——有人用的整域空缺

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| **`getCharData`** | function/raw_character.d.ts:105 | `getCharData('current')` → 当前角色的 `SillyTavern.v1CharData` | **未提供（P1，§4.1.2）** | 1/1 |
| `getCharAvatarPath` | function/raw_character.d.ts:113 | 头像路径 | 未提供 | 0 |
| `getChatHistoryBrief` | function/raw_character.d.ts:121 | 聊天历史摘要（楼层文本数组） | 未提供 | 0 |
| `getChatHistoryDetail` | function/raw_character.d.ts:132 | 聊天历史全量 | 未提供 | 0 |

### 3.18 楼层消息（3 / 0 / 0）

`retrieveDisplayedMessage`(21)、`formatAsDisplayedMessage`(46)、`refreshOneMessage`(70)
——全未提供、语料 0。上游语义都挂在「显示层消息」（正则/宏渲染后的楼层文本）上；
Iris 的渲染管线在消息帧里，成员面未暴露。**P2 观望。**

### 3.19 版本（3 / 1 / 0）

`getTavernHelperVersion`(function/version.d.ts:4，已实现，Iris 固定答 `'4.9.1'`——
`tavern-helper.ts:293` `TAVERN_HELPER_VERSION`)、`getTavernVersion`(9，未提供，
上游答 ST 版本)、`getTavernHelperExtensionId`(5，未提供，TH 扩展在 ST 里的 id)。

### 3.20 跨 iframe 全局（2 / 2 / 1）

`initializeGlobal`(function/global.d.ts:14)、`waitGlobalInitialized`(function/global.d.ts:27)
——都已实现（`frame.ts:2019,2024` coordination，identity 绑定；接口帧也发布，
`frame.ts:2745` 附近的 wait 语义含「并使之在当前 iframe 可用」的 getter 前移）。
语料 14 卡 26 次 `waitGlobalInitialized('Mvu')` ——它是 MVU 卡的标准起步姿势。

### 3.21 提示词注入（2 / 2 / 1）

`injectPrompts`(function/inject.d.ts:39，已实现，返回 `{uninject}` 活句柄)、
`uninjectPrompts`(function/inject.d.ts:46，已实现)。语料 2 卡 2 次。

### 3.22 宏（2 / 0 / 1）

| 成员 | 上游 | 语义 | Iris | 语料 |
| --- | --- | --- | --- | --- |
| **`registerMacroLike`** | function/macro_like.d.ts:27 | 注册自定义宏（正则+替换函数，返回 `{unregister}`） | **未提供（P2，§4.1.3）** | 1/1 |
| `unregisterMacroLike` | function/macro_like.d.ts:37 | 按正则注销 | 未提供（随上者） | 0 |

### 3.23 库全局（4 / 4 / 3）与内置（1 / 0 / 0）、斜杠命令（1 / 1 / 1）

| 成员 | 上游 | Iris | 语料 |
| --- | --- | --- | --- |
| `TavernHelper` | exported.tavernhelper.d.ts:5 | 已实现（自命名空间，`tavern-helper.ts:2965`） | 3/13 |
| `SillyTavern` | exported.sillytavern.d.ts:393 | **部分**（§4.1.5） | 5/44 |
| `Mvu` | exported.mvu.d.ts:54 | **部分**（§4.1.4） | 16/103 |
| `EjsTemplate` | exported.ejstemplate.d.ts:54 | **部分**（§4.1.6；语料经 `tw` 别名 1 卡，探针不可见） | 0 静态 / 1 别名 |
| `builtin` | function/builtin.d.ts:1（`addOneMessage`/`copyText`/`duringGenerating`/`getImageTokenCost`/`parseRegexFromString`/`promptManager`/`reload*`/`renderMarkdown`/`saveSettings` 的 ST 内部件袋子） | 未提供 | 0 |
| `triggerSlash` | function/slash.d.ts:29 | 已实现（委托 `script.slash`） | 7/11 |

---

## 四、缺口建议清单（五元组）

每条：**谁在用 → 上游语义 → Iris 现状与差距 → 建议（P0/P1/P2）→ 实现机制草案**。

### 4.1 用到但缺/部分（5 席，按优先级）

#### 4.1.1 `getPreset` —— P1，排期补（随任务 M 或先行）

- **谁在用**：魔法少女的扣扣审判1.0（st 群体），脚本 `外置状态栏`：
  `if (usePreset && TavernHelper && typeof TavernHelper.getPreset === 'function')` →
  `TavernHelper.getPreset('in_use')` → 遍历 `preset.prompts` 里 `enabled` 的提示词，
  按 `worldInfoBefore` 等占位符拼自己的消息序列（证据行见量具 `--evidence --member getPreset`）。
  `notes/TEST-CARDS.md:297` 早已记录「只有这张卡、且只传字面量 `'in_use'`」。
- **上游语义**：`[TH] function/preset.d.ts:180` `getPreset(preset_name): Preset`；
  `'in_use'` 特指当前装载的预设，返回含 `prompts` 与 `prompt_order` 的完整预设对象。
- **Iris 现状与差距**：卡面无名（不在 api 字面量里）。但宿主侧 `preset.get` 臂已存在，
  对 `'in_use'` 有语义、对其他名字按名拒绝（`packages/iris-app-service/src/service.ts:1634`）；
  卡的 `typeof` 守卫让这条分支今天静默跳过——状态栏退化成没有预设提示词参与的消息拼装。
  当初没建的原因就是单预设宿主（`notes/ST-COMPARE.md:233-235`），不是疏漏。
- **建议**：**P1 排期补**。只补 `'in_use'` 一个名字就覆盖语料；其余名字维持按名拒绝，
  等任务 M 的预设库落地后再放开按名查库（`notes/IMPLEMENTATION-CHECKLIST.md:46-54`
  已有验收标准）。
- **机制草案**：frame facade 成员（挂 `tavern-helper.ts` api 字面量），委托现有
  `preset.get` host 臂；工作量是把宿主预设结构映射成上游 `Preset` 形状
  （`prompts[]` + `prompt_order[]`，Iris 的 `prompt.itemize` 已有逐行装配）。**工作量 S-M**。
  风险：形状映射错会让卡读到 undefined 字段——用这张卡的真实断言做验收
  （遍历 `enabled` 提示词的行集）。

#### 4.1.2 `getCharData` —— P1，排期补

- **谁在用**：人贩子物语（iris 群体），脚本 `黑市手机（抽屉式状态栏）`，`currentCard()`：
  三级退化链——①`typeof getCharData === 'function'` → `getCharData('current')`；
  ②`getTavernHelper().getCharData('current')`；③`hostWindow.SillyTavern.getContext()` →
  `ctx.characters[ctx.characterId]`。三级全 try/catch，全空返回 null。
  **这条是新语料带来的新发现**，旧账（ST 安装库口径）里没有。
- **上游语义**：`[TH] function/raw_character.d.ts:105`
  `getCharData(name: 'current'|string, allowAvatar?): SillyTavern.v1CharData | null`。
- **Iris 现状与差距**：卡今天走 ③ 活着——`SillyTavern.getContext()` 与
  `characterId` 的数组下标翻译都是已建面（`frame.ts:630` 起的代理 + `currentCharacterIndex`，
  `frame.ts:1465` 附近）。①②无名。差距=纯增量：给卡回到上游主路径的能力，
  减少对 `SillyTavern` 代理的依赖。顺带注意：退化链 ② 里的 `getTavernHelper()` 不在
  171 清单内（TH 页面注入的函数，非卡声明面成员），Iris 让它 undefined、卡 try/catch 落 ③。
- **建议**：**P1 排期补**（主力卡的顺手补强，非救火）。
- **机制草案**：frame facade 成员；`'current'` 从快照 `characters[currentCharacterIndex()]`
  映射出 `v1CharData` 形状（name/description/first_mes/mes_alternate…）。
  **工作量 M**：风险不在代码量而在形状保真——`v1CharData` 字段多，部分映射会让卡下一步
  读字段 undefined 且无异常；要么按快照已有字段尽力全形状，要么不建。验收用这张卡
  `currentCard()` 的消费字段逐个对。

#### 4.1.3 `registerMacroLike` —— P2，观望（带升级条件）

- **谁在用**：OVERLORD不死者之王（st 群体），脚本 `ERA`（MagVarUpdate 的 webpack bundle 模块）：
  `$(() => { registerMacroLike(/{{\s*ERA(-withmeta)?\s*:\s*([^}]+?)\s*}}/gi, …) })`——
  注册 `{{ERA:path}}` 宏用于在发给 AI 的消息里查询 MVU `stat_data`。
- **上游语义**：`[TH] function/macro_like.d.ts:27`
  `registerMacroLike(regex, replace(context, substring, ...)): {unregister}`；
  注册的宏参与 TH 的宏替换（`substitudeMacros` 与消息格式化）。
- **Iris 现状与差距**：无名可应 → jQuery ready 回调里抛 `ReferenceError`，宏注册不发生，
  `{{ERA:…}}` 在消息里保持字面。`substitudeMacros` 已建（api 字面量内），但卡注册的宏
  需要进**同一张替换表**才有意义；全保真（AI 提示词里的替换）还要动宿主 prompt 装配。
- **建议**：**P2 观望**。单卡、bundle 内、注册点在 jQuery ready（时序上晚于卡初始化），
  而它的功能损失是「ERA 查询宏不可用」不是崩溃。**升级条件**：再有第二张卡带
  `registerMacroLike`/`{{ERA}}`，或 MVU 验收发现 ERA 宏在语料消息里实际出现，升 P1。
- **机制草案**（若补）：frame 内宏注册表 + `substitudeMacros` 先跑卡宏再跑内置宏；
  宿主 prompt 路径的替换需要把注册的**函数**留在帧内、宿主把原文送回来替换——
  一条往返，安全性可接受（函数不出帧）。**工作量 L**（跨三处：帧表、`substitudeMacros`、prompt 路径）。
  `unregisterMacroLike` 随之而来，同批。

#### 4.1.4 `Mvu` —— P2，维持现状（部分面是有意裁定）

- **谁在用**：16 卡 103 次静态调用（全部四个群体）——语料里**最大的单一缺口面**。
  用法集中在三件事：`Mvu.getMvuData({type:'message',…})`（读楼层变量）、
  `Mvu.replaceMvuData(next,…)`（写回）、`Mvu.events.VARIABLE_UPDATE_ENDED`（订阅更新）。
  代表证据：哈人冰恋世界界面
  `Mvu.getMvuData({ type: 'message', message_id: currentMsgId }) || {}`；
  人贩子物语脚本 `&&Mvu.getMvuData){var d=Mvu.getMvuData({type:'message',message_id:'latest'})…}`。
- **上游语义**：`[TH] exported.mvu.d.ts:54` 起——`Mvu` **不是 TH 自己的成员**，声明注释原文：
  「mvu 变量框架脚本提供的额外功能，必须额外安装 mvu 变量框架脚本」，经
  `waitGlobalInitialized('Mvu')` 等待、由 MVU bundle 自己 `_.set(window.parent,'Mvu',mvu)` 发布。
- **Iris 现状与差距**：接口帧发布显示面 `Mvu = { events, getMvuData, replaceMvuData }`
  （`frame.ts:2690-2699`，`getMvuData`/`replaceMvuData` 是对 `getVariables`/`replaceVariables`
  的薄改名——与量过的 MVU bundle 自身实现一致），并挂到虚拟父供 wait
  （`frame.ts:2766,2773`）。脚本帧里 Mvu 由卡的 MVU bundle 自己发布（bundle 在帧内跑，
  虚拟父承接它的 `_.set`）。**差距**：bundle 的 schema 驱动更新机制（模式机、
  `Mvu.registerFunction` 等完整面）只在 bundle 所在的脚本帧有；接口帧的 Mvu 是显示面。
  裁定记录在 frame.ts:2700-2772 的长注里（有意为之，非遗漏）。
- **建议**：**P2 维持**。16 卡的实际用法恰好全部落在已供的三个成员上；显示状态栏
  （这些卡的主要消费形状）完整工作。**要盯的一件事**：脚本帧里卡自己的脚本在
  bundle 发布前直接调 `Mvu.*`——人贩子物语的 `&&Mvu.getMvuData` 守卫正是这个形状，
  守卫失败即静默落退化分支。若出现无守卫的同形状卡，考虑把脚本帧也发布显示面 Mvu。
- **机制草案**（若补）：脚本帧的 `publishGlobals` 增补同一 mvu 对象（与接口帧同源），
  bundle 后发布照常覆盖（`frame.ts` 注释已声明卡发布优先、此处非特权）。**工作量 S**。

#### 4.1.5 `SillyTavern` —— P2，维持现状（按量供面是有意裁定）

- **谁在用**：5 卡 44 次（iris/测试/st）。典型形状是
  `if (window.parent.SillyTavern)` 探测 + `getContext()` 取上下文
  （银麒赎世 手机UI 的 `tw.SillyTavern.getContext()`；人贩子物语 `currentCard()` 的 ③ 级）。
- **上游语义**：`[TH] exported.sillytavern.d.ts:393`——TH 借用宿主页的 `SillyTavern`
  全局（ST 自己的 context 对象，`st-context.js` 145 键）。
- **Iris 现状与差距**：`frame.ts:630` 起的代理按量供面：`getContext`（答代理自身）、
  `extensionSettings`（写被观察上报）、`saveSettings`/`saveSettingsDebounced`、
  popup 五名（`POPUP_TYPE`/`POPUP_RESULT`/`callGenericPopup`/`callPopup`/`Popup`）、
  `eventSource`/`event_types`、`characterId`（数组下标翻译）、`getCurrentChatId` 等；
  未知成员报 gap 返 undefined（frame.ts:992 附近的按名报告）。145 键全量镜像不是目标
  ——`card-api.ts:156-216`（`OFF_ST_SURFACE`）把「哪些成员挂哪个面」钉成了显式裁定。
- **建议**：**P2 维持**，继续按「量到一个供一个」推进。这条线上真正值得排的是
  §4.1.2 建好 `getCharData` 后，`ctx.characters[ctx.characterId]` 的消费方减少。
- **机制草案**：不适用（维持）。

#### 4.1.6 `EjsTemplate` —— P2，维持现状（部分面 + 探针不可见的真实使用）

- **谁在用**：银麒赎世（st 群体）脚本 `手机UI`：`var tw = window.parent || window;` →
  `tw.EjsTemplate && typeof tw.EjsTemplate.evalTemplate === "function"` →
  `await tw.EjsTemplate.evalTemplate(e.content)` 渲染世界书条目里的 EJS 模板。
  `notes/TEST-CARDS.md:3012` 的旧结论（n=1 真调用）在本轮对账中被证实。
- **上游语义**：`[TH] exported.ejstemplate.d.ts:54`——ST-Prompt-Template 扩展发布的
  EJS 包装对象（`evalTemplate`/`features`/设置项等）。
- **Iris 现状与差距**：`EjsTemplate` 在 `core` 名单供名（`frame.ts:2139`），对象是
  `{ evalTemplate }`（`frame.ts:1471-1484`），经 `script.evalTemplate` 围栏路由
  （`card-api.ts:75`）。差距=对象只有一成员；上游还有 feature 开关读取等。
  语料只用 `evalTemplate`，已够。
- **建议**：**P2 维持**。ROADMAP 里「EjsTemplate frame 门面」仍在在建清单
  （`notes/ROADMAP.md` 在建段），按那里既定方向走即可。
- **机制草案**：不适用（维持）。

### 4.2 上游有但语料未见用（未提供 114 个中未用的 111 个）——按域裁定汇总

111 个逐个给全五元组没有信息量（「谁在用」一栏全是零），按域给共性裁定 + 差异点；
每个成员的上游位置与一句话语义已在 §三全表，缺位就是「不补/观望」的理由本身。

| 域 | 成员数 | 裁定 | 理由（判断，标注出处） | 若补：机制与量级 |
| --- | ---: | --- | --- | --- |
| 旧 lorebook 族 + 旧条目族 | 16 | **不补** | 上游整族 @deprecated 并逐条指向新名（function/lorebook.d.ts:25 等）；Iris 已建新世界书族 12/16 | 无 |
| 扩展管理 | 8 | **不补** | 卡装/卸宿主扩展穿透授权面与 CSP 面（判断，notes/apps/iris-web/DEVIATIONS.md:1646 的 CSP 对比是同方向论证） | 无 |
| `builtin` | 1 | **不补** | ST 内部件的袋子（promptManager/reloadEditor…），Iris 无对应部件；其能力按名逐个评估（`copyText`、`addOneMessage` 若见语料再议） | 无 |
| `getProxyPresetNames`、`getTavernHelperExtensionId`、`getTavernVersion` | 3 | **不补** | 代理预设/扩展 id 是 ST 安装概念；`getTavernVersion` 若要兼容探测可答 Iris 版本号，但语料 0，意义小 | 无 |
| 音频 | 8 | **观望** | 上游驱动 ST 前端 `#audio` 播放器；Iris 无该部件。第一张音频卡出现再设计 | 阅读视图音频桥（新面），L |
| 角色卡（读 5 个：names/ids/currentName/currentId/getCharacter） | 5 | **P2 可早排** | 快照上的廉价读；`getCurrentCharacterName` 等与已建的 `getCharWorldbookNames` 同源 | frame facade 一日量级，S |
| 角色卡（写 5 个） | 5 | **不补/观望** | 写宿主角色库要过脚本授权面（notes/apps/iris-web/GRANTS.md 的 grant 模型没有「写角色库」这一格）；语料 0 | `createCharacter` 等可委托 character.import，M |
| 个人名片（读 6 / 写 5） | 11 | **P2 观望** | persona 宿主语义存在（notes/packages/iris-app-service/UPSTREAM-PERSONA.md）；读族是快照读（S），写族涉授权（M） | 读：facade；写：新 host 臂 |
| 预设（除 getPreset 外 14 个） | 14 | **P2，随任务 M 重估** | 单预设宿主（service.ts:1634）；`loadPreset`/`getPresetNames` 在预设库落地后是自然延伸；写族（create/replace/set/delete/rename）需要新的授权裁定 | 库落地后每个 S-M |
| 正则 5 个 | 5 | **P2 观望** | Iris 有等价引擎（packages/iris-regex）与 profile 级列表，缺 TH 形状映射；零命中 | facade 映射，M |
| 原始导入 5 个 | 5 | **P2 观望** | Iris 导入走自己的路径；卡触发导入未出现 | `importRawCharacter`→导入臂，M |
| 楼层消息 3 个 | 3 | **P2 观望** | 语义挂在显示层文本上，Iris 渲染管线在消息帧，暴露面待设计 | M |
| `registerVariableSchema` | 1 | **P2 观望** | MVU schema 校验；Iris 的 MVU 链已有自己的验收（notes/packages/iris-app-service/MVU-ACCEPTANCE.md）；bundle 在脚本帧自带机制 | facade + zod 已在帧内，S-M |
| `stopGenerationById`/`stopAllGeneration` | 2 | **P2 观望** | 宿主停止臂未建——`#mes_stop` 的 click 现在按名报告「没有建那一条臂」（st-anchors.ts:321-327）；建停止臂时这两个是自然形状 | host 臂 + facade，M |
| `getModelList` | 1 | **P2** | Iris 有连接档模型列表（connection.*），映射即可 | facade→connection，S |
| 事件 `eventEmitAndWait` | 1 | **P2** | 总线已支持「等全部监听器」语义吗？bus 实现待核；无命中 | 帧内 bus 扩展，S |
| 事件 `eventOnButton` | 1 | **不补** | 上游 deprecated；按钮事件已由 `getButtonEvent`+`eventOn` 覆盖（语料 3 卡 9 次用的就是这对） | 无 |
| 脚本 `getScriptName`/`getScriptInfo`/`replaceScriptInfo` | 3 | **P2 可早排** | 帧知道自己的脚本名与作者注释（preamble 有）；写注释要新存储 | 读 S，写 M |
| 脚本 `getAllEnabledScriptButtons` | 1 | **P2** | 按钮表按脚本 id 键的结构已存在（identity.ts:137-141 的裁定注） | facade，S |
| 脚本 `getScriptTrees`/`replaceScriptTrees`/`updateScriptTreesWith` | 3 | **不补** | TH 的「脚本库树」在 Iris 没有对应物（脚本按卡平铺 + 授权）；notes/apps/iris-web/DEVIATIONS.md:2834 记过脚本库兼容裁定 | 无 |
| 工具 `getIframeName`/`getMessageId`/`reloadIframe` | 3 | **P2** | `getIframeName` 的上游职责（事件注册键）在 Iris 由 `getScriptId` 承担；`getMessageId` 是 depth 换算纯函数（S）；`reloadIframe` 与帧生命周期模型冲突，观望 | S / S / 不补倾向 |
| 世界书 `createOrReplaceWorldbook`/`deleteWorldbook`/`deleteWorldbookEntries`/`rebindCharWorldbooks` | 4 | **P2** | 全是已建成员的对偶写动作；`replaceWorldbook`/`deleteChatMessages` 的路线现成 | 各 S-M |

### 4.3 已建但语料未见用（26 个）——保留，不构成建议

`appendInexistentScriptButtons`、`createWorldbook`、`createWorldbookEntries`、
`deleteChatMessages`、`deleteVariable`、`eventClearAll`、`eventClearEvent`、
`eventClearListener`、`eventMakeFirst`、`eventMakeLast`、`getChatWorldbookName`、
`getGlobalWorldbookNames`、`getLorebookSettings`、`getOrCreateChatWorldbook`、
`getScriptButtons`、`getTavernHelperVersion`、`getWorldbookNames`、`iframe_events`、
`initializeGlobal`、`insertOrAssignVariables`、`insertVariables`、`rebindChatWorldbook`、
`rebindGlobalWorldbooks`、`replaceWorldbook`、`uninjectPrompts`、`updateScriptButtonsWith`

保留理由：它们与已用成员成对（写/读、清/订）、或被量过的第三方 bundle 依赖
（MVU 的按钮写入族——`tavern-helper.ts:849` 记录 13 张语料卡捆 MVU，bundle 不在
「卡脚本」语料里但会调用），或已在验收路径上（`createWorldbookEntries` 之于世界书创建）。
「语料未见用」对这一栏不构成回撤依据。

---

## 五、P0/P1/P2 汇总

| 级 | 数 | 名单 | 一句话 |
| --- | ---: | --- | --- |
| **P0（现在补）** | **0** | —— | 三个真缺成员的调用点全部自带守卫、全部走退化路径活着；没有任何语料调用硬坏在缺成员上 |
| **P1（排期补）** | **2** | `getPreset`（魔法少女的扣扣审判1.0）、`getCharData`（人贩子物语） | 都有现成宿主臂/快照可委托，S-M 量级；前者随任务 M（或先补 `'in_use'` 一名），后者让主力卡回到上游主路径 |
| **P2（观望/随势）** | 其余 | `registerMacroLike`（升 P1 条件：第二张卡或 ERA 宏实际出现在语料消息）；`Mvu`/`SillyTavern`/`EjsTemplate` 维持部分面；§4.2 表内标 P2 的各域（角色卡读族、脚本名族、世界书写对偶、正则映射、getModelList 等为其中最廉价的候选） | 零命中不动手；动了的都是「有宿主语义可委托」的 S 量级映射 |

---

## 六、复现

```bash
node scripts/th-surface-audit.mjs                    # 总表（本文所有数字）
node scripts/th-surface-audit.mjs --locations        # 171 成员的上游 file:line + 现状
node scripts/th-surface-audit.mjs --evidence         # 每个命中成员的逐卡证据行
node scripts/th-surface-audit.mjs --member getPreset,Mvu,getCharData,registerMacroLike
node scripts/th-member-census.mjs                    # 既有卡尺（ST 安装库口径，对账用）
```

量具的成员清单与实现面都从本仓库源码按声明文本提取；语料缺席时跳过并打印异常计数。
上游文件只读（`E:\sillyTavern` 未做任何写入）。
