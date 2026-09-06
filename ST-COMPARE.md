# ST-COMPARE — Iris vs SillyTavern 1.18.0 实机对照

任务 K 产出。这是对 `ROADMAP.md` 差距盘点的**实机复核更新版**：所有 ST 行为先在实机上经
HTTP API 验证，再落到源码行号；Iris 现状以代码为准，不引自述。

- **ST 装置**：`E:/sillyTavern/SillyTavern`，v1.18.0（release 51ad27fb）。
- **实机实例**：独立 dataRoot `D:\st-8871-data`（从未触碰用户真实数据
  `E:/sillyTavern/SillyTavern/data`，后者仅做过只读统计）、端口 8871、
  **PID 28028**（后台存活，任务结束后保留供任务 L/M 复用；停也只用这个 PID）。
- **Iris 基线**：`3cf858d`（dev/iris-exploration）。复核期间主检出从 6b71157 前进到
  3cf858d，diff 仅 ScriptButtons UI（75 行），不影响任何本结论。
- **证据记号**：`server-startup.js:142-187` = 43 组 API 路由挂载点；
  `world-info.js` / `openai.js` / `index.html` 指 ST 的 `public/`；
  `rpc.ts` 指 `packages/iris-protocol/src/rpc.ts`；其余 Iris 路径相对仓库根。
- 用户真实配置（只读统计，用于给差距分级而非猜测）：
  全局正则 **0 条**、作者注释**全空**、人格描述**0 字**、快速回复**禁用**——
  与 ROADMAP 的语料裁决（按真实触碰频率排序）一致。

**差距等级**：**A** 阻断使用（升级/迁移路径上没有它走不通）；**B** 可用但缺细节；
**C** 纯缺失（当前语料零使用，或独立子系统）。

---

## 0. 总览

| 功能域 | 等级 | 一句话 |
| --- | --- | --- |
| 世界书引擎 | **已有** | `activate.ts` 是 `checkWorldInfo` 的完整转写（含 ST 没有的：种子化 RNG、outlet 桶） |
| 世界书面板 | **A** | 引擎/存储/RPC 全活，**没有任何用户界面** |
| 预设装配 | **已有** | `@iris/preset` 吃透 CC 预设格式（含 100001 哨兵） |
| 预设管理 | **A** | 全宿主**只有一枚**预设（config `presetPath`），无存储/切换/编辑/导入 |
| 角色卡 | **已有** | PNG/JSON/.charx 导入、19/19 往返零丢失 |
| 聊天存储 | **已有** | ST JSONL 逐行键序往返 |
| 聊天管理 | **B** | 无导入/导出/搜索/重命名 UI |
| 正则 | **B** | 引擎完整；只有"卡内"一层，无全局层、无管理 UI |
| 宏 | **B** | 31/36 覆盖，MVU 全套在 |
| 连接配置档 | **已有** | connection.* 四方法 + 面板 |
| 设置面 | **B** | ~15 项 vs ST power_user 83 键（SETTINGS.md 有 IA 草案） |
| 生成类型 | **B** | send/regenerate/swipe 有；continue/impersonate 无 |
| 消息级功能 | **B** | 编辑/删除/swipe/分支/reasoning 有；TTS/翻译/图像/嵌入无 |
| Persona | **C** | marker 占位存在，无管理、无注入源 |
| 斜杠命令 | **C** | `/trigger` `/send`（语料 4 调用点全覆盖）vs ST ~290 |
| 快速回复 | **C** | 无（本机实配：禁用+全空） |
| 内置扩展 14 件套 | **C** | 逐件见 §11；多数是独立子系统 |
| 文本补全后端 | **C** | 仅 OpenAI 兼容路由；kobold/novel/textgen/horde 无 |
| 多用户 | **C** | 单 profile by config（存储层已按 profile 成形） |
| 群聊 | **C** | 语料零使用（GROUPS.md） |

---

## 1. 角色管理（characters）

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 1.1 | 43 组路由中 `characters` 组 13 端点：create/rename/edit/edit-avatar/edit-attribute/merge-attributes/delete/all/get/chats/import/duplicate/export（`src/endpoints/characters.js:1024-1644`） | `character.list/import/delete`（rpc.ts:236-242）。PNG/JSON/.charx 导入，解码往返零键丢失（ROADMAP 实测 19/19） | B：缺 duplicate/rename/导出、头像编辑、属性编辑 |
| 1.2 | 卡上标签 `tags`+`tag_map`，角色列表按标签过滤/收藏/排序（`power_user.sort_field/sort_order/sort_rule`） | `CharacterSummary.tags` 携带（views.ts）；无标签管理 UI、无收藏 | C（本机标签仅 1 条默认） |
| 1.3 | 卡内嵌世界书导入询问（`world-info.js:5618` convertCharacterBook→存文件→绑名） | 刻意升级：`resolveCardWorldbook` 择一回退、永不双拼（WORLDBOOKS.md §2） | **Iris 优** |
| 1.4 | 备份目录 + `/api/backups/*`（chat get/delete/download） | profile 目录自带聊天文件；无备份视图 | C |

## 2. 世界书（重点，专节见 §13）

引擎等价已验收；缺口集中在**用户面板**与**角色多书**。等 A 的只有面板。

## 3. 预设（重点，专节见 §14）

装配等价（CC 路径）；缺口集中在**多预设管理**。等 A 的只有存储/切换/编辑。

## 4. 提示词装配（Chat Completion 路径）

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 4.1 | 装配序：`prompt_order`（角色 id，100001=全局生效哨兵/100000=类默认遗留）→ marker 槽（worldInfoBefore/After、charDescription、charPersonality、scenario、personaDescription、dialogueExamples、chatHistory、jailbreak）→ 相对项按表序、绝对项按 depth 注入（`openai.js:1358-1520, 1187-1330`） | `@iris/preset/chat-completion.ts` 同序转写；`GLOBAL_ORDER_ID=100001` 的实测订正写死并有测试；post-history→depth-0 注入 | **已有** |
| 4.2 | 每条 prompt 的 role/position(relative/absolute)/depth/order/forbid_overrides/triggers（生成类型过滤：normal/continue/impersonate/swipe/quiet/regenerate）（index.html 7262+） | PromptItem 字段全收（chat-completion.ts:75-89）；**triggers 过滤无**（无多生成类型可过滤） | B |
| 4.3 | utility prompts：impersonation/new_chat/new_group_chat/continue_nudge/group_nudge + `squash_system_messages` + `custom_prompt_post_processing`（merge/semi/strict/tools/single）（openai.js:203-215） | 无 continue/impersonate 故无对应 utility；squash/后处理无 | B（随生成类型补） |
| 4.4 | 扩展注入点 `extensionPrompts`（`1_memory`/`2_floating_prompt`/`3_vectors`/`4_vectors_data_bank`/`chromadb` + 任意键），BEFORE/IN 两档位+role+depth（openai.js:1398-1450） | `script.setExtensionPrompt` RPC（rpc.ts:574）+ 卡作者注释深度注入（prompt.ts:285-296）；`injectPrompts` frame 门面缺（ROADMAP 在案） | B |
| 4.5 | 逐条 token 计费（Prompt Manager inspect + itemization） | `prompt.itemize` + PromptPanel（比例条先行，实测 1920/2929 世界书一条的形状决定设计） | **已有（形态升级）** |
| 4.6 | WI 格式模板 `wi_format` / story_string（context 模板） | CC 路径零引用（ROADMAP 1.5 实测）；未做 | C |

## 5. 正则脚本

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 5.1 | 三层：全局（extension_settings.regex）/角色 scoped/预设 scoped；引擎 `regex_placement`(6)+`substitute_find_regex`(3)+markdownOnly/promptOnly/minDepth/maxDepth/trimStrings/runOnEdit/disabled（`extensions/regex/engine.js`） | `@iris/regex` 引擎 31 测试+两向接线（提示词/显示）；`SCRIPT_TYPE`/`orderScripts` 为三层预留（app-service/regex.ts:50"Only the character's own tier exists so far"） | **B：卡内层齐；全局层无存储无 UI** |
| 5.2 | 管理 UI：脚本列表/拖序/启停/导入导出 json | 无任何正则 UI（卡自带正则自动跑，本机语料 173 条全在卡内） | C（配合全局层） |

## 6. 宏

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 6.1 | `macros.js` 36 个内建（date/time/weekday/timeDiff/reverse/isotime/isodate/outlet/noop/lastSwipeId/currentSwipeId/firstIncludedMessageId/firstDisplayedMessageId/allChatRange/maxPrompt/maxResponse/key/banned/…） | `@iris/macro` builtins 31 个：MVU 依赖的 getvar/setvar/addvar/incvar/original 全在；**{{date}}/{{weekday}}/{{timeDiff}}/{{reverse}}/{{outlet}}/{{noop}}/楼层寻址族缺** | B（差集小，工作量 S） |
| 6.2 | 不二次扫描替换结果 | 同规则（ROADMAP 优势区） | **Iris 优** |

## 7. 聊天管理

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 7.1 | chats 组 10 端点：save/get/rename/delete/export/import/group_*/search/recent（`src/endpoints/chats.js:470-979`） | chat.list/create/open/delete/rename/send/regenerate/abort/swipe/editMessage/deleteMessage/branch（rpc.ts:22-67,230） | B |
| 7.2 | 聊天导出 jsonl/json、导入 jsonl（含群聊） | 持久层即 ST JSONL（persistence/sillytavern.ts，逐行键序+未知字段保真），**但无导入/导出 RPC**——迁移要手工拷文件 | **A（迁移路径）** |
| 7.3 | 聊天内容搜索 `/api/chats/search` + 最近聊天 | 无搜索；Sidebar 双 tab（chats/characters）仅删 | B |
| 7.4 | 分支=书签文件切割 + checkpoint（bookmarks.js）；`chat_metadata.main_chat` 记父 | `chat.branch`（宿主侧完成；UI=存档点+跳回，ROADMAP 1.1 裁决）；`parentChatId` 用 id 不用名（升级） | **已有（刻意收窄）** |
| 7.5 | 每聊天元数据（timedWorldInfo、note、randomizer 等） | JSONL 头 `chat_metadata` 保真往返；MVU 五件活 | 已有 |

## 8. 消息级功能

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 8.1 | 编辑/删除/swipe/隐藏(exclude from prompts)/继续 continue/impersonate/narrate/嵌入文件/生成图像/翻译/TTS（index.html Message Actions 区） | 编辑/删除/swipe（VariantRail）/分支；reasoning 流式显示（service.ts:1209） | B |
| 8.2 | 楼层内渲染（代码块、引用、卡 CSS） | 消息内渲染管线五步全落 + 内联 HTML 消毒在建（ROADMAP 4） | **已有/在建** |
| 8.3 | 楼层变量（swipe_data/variables） | FLOOR-VARIABLES.md 全线统一 | 已有 |

## 9. 卡片脚本执行环境

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 9.1 | iframe 同源 srcdoc、无沙箱、API 平铺裸全局、可 `window.parent` | 共居 realm + 虚拟 parent + 按卡授权（SANDBOX.md）；真卡验收 | **Iris 优（刻意不照抄）** |
| 9.2 | TavernHelper（JS-Slash-Runner）28 成员面 | `@iris/compat-tavernhelper(-core)` 兼容面，真卡 4/4 活（ROADMAP） | 已有 |
| 9.3 | 第三方扩展全局安装（`extensions/third-party/`，本机装有 ST-Prompt-Template） | ST-Prompt-Template 语义由 `@iris/compat-prompt-template` 子进程围栏实现（EJS）；**通用扩展加载器不做**（ROADMAP"明确不照抄"） | C（生态桥另立项） |

## 10. 连接与后端

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 10.1 | 26 个 chat-completion 源（openai.js:175-202）+ 文本补全 4 族后端 + horde | OpenAI 兼容单路由（`@iris/llm-openai-compat`，任意 baseURL+model）；连接配置档三件套一键切（1.2 ✅） | B（源数量；本机用户走自定义端点，实际够用） |
| 10.2 | connection-manager 扩展（profile=端点+模型+预设） | connection.* RPC + ConnectionPanel | 已有 |
| 10.3 | secrets 明文 secrets.json + view/read/write/find/delete | config 注入凭据，不落明文（rpc.ts:105 注释） | **Iris 优** |

## 11. ST 内置扩展 14 件 vs Iris

实测 `GET /api/extensions/discover`（8871 实机）：
assets, attachments, caption, connection-manager, expressions, gallery, memory, quick-reply,
regex, stable-diffusion, token-counter, translate, tts, vectors（+ global third-party/ST-Prompt-Template）。

| 扩展 | Iris 对应 | 等级 |
| --- | --- | --- |
| connection-manager | connection.* ✅ | 已有 |
| regex | 引擎 ✅ / 全局层+UI ✗ | B |
| token-counter | @iris/tokenizer（实测校准）✅ | **Iris 优** |
| quick-reply | ✗（本机禁用） | C |
| memory（摘要） | ✗ | C |
| vectors（RAG） | ✗ | C |
| tts / speech | ✗ | C |
| stable-diffusion / gallery | ✗ | C |
| translate / caption | ✗ | C |
| expressions（表情分类） | ✗ | C |
| attachments（数据银行） | ✗ | C |
| assets（扩展资产分发） | 沙箱资产管线等价物已建（sandbox-assets.ts） | 已有 |

## 12. 用户/多用户/移动端/外观

| # | ST 行为（证据） | Iris 现状 | 等级 |
| --- | --- | --- | --- |
| 12.1 | 多账户（users-public/private/admin：login/list/me/change-password/backup/reset…；实机 `/api/users/list` 返回 default-user） | 单 profile by config；存储层 profilePaths 成形，**无运行时切换契约**（ARCHITECTURE.md 明示，非目标） | C |
| 12.2 | 主题 8+ 套、movingUI、user.css、blur/配色 83 键 | theme 暗/亮/随系统 + slot 系统（架构上更强的扩展点，ROADMAP 优势区） | B |
| 12.3 | 移动端：mobile-styles.css、Compact Input Area、apple-mobile-web-app 元数据（index.html:9-44,5127） | 响应式 shell（Sidebar 折叠）；无专门移动档 | C |
| 12.4 | 中英文 i18n（data-i18n 全量） | 字典 + 每设备语言切换免刷新（f5cd2c6 ✅） | **已有** |

## 13. 世界书专节（用户点名）

**ST 侧五来源**（`getSortedEntries`, world-info.js:4484-4530）：global（多选 `world_info.globalSelect`）
→ character（`data.extensions.world` 绑定 + `world_info.charLore[].extraBooks` 追加多本，
world-info.js:4363-4417）→ chat（`chat_metadata.world_info`）→ persona（`persona_description_lorebook`）。
去重规则：已在上游来源激活的书跳过。插入策略三选（evenly/character_first/global_first）+ 
chat→persona 恒排最前。**内嵌 character_book 不是运行时来源**，只是导入期的料（§1.3）。

**激活**（`checkWorldInfo`, :4597 起，Iris `activate.ts` 逐条对应）：

| 机制 | ST | Iris |
| --- | --- | --- |
| 扫描缓冲 | 最近 N 楼 + 可选追加 persona/char 描述/人格/场景/创作注 + extension injects（`scan` 标志） | ScanBuffer 同构（`\x01` 哨兵防跨界匹配——超集） |
| 主/副键逻辑 | AND_ANY/AND_ALL/NOT_ALL/NOT_ANY + 副键可写正则 | 同（evaluateSelectiveLogic） |
| 键匹配 | 大小写/全词按全局+逐条覆盖；正则键 `parseRegexFromString`(:2821) | 同（matchKey） |
| 计时效果 | sticky/cooldown/delay/delayUntilRecursion(level)/`chat_metadata.timedWorldInfo` 持久 | 同构，状态显式进出参（swipe 可重放——刻意升级） |
| 递归 | recursive + exclude/preventRecursion + maxRecursionSteps | 同 |
| min activations | + depth_max 扫描窗口放宽 | 同 |
| 概率 | useProbability/probability，失败不重掷 | 同 + 记录 failedProbability |
| 分组 | inclusion group + groupOverride/groupWeight + group scoring + sticky 优先 | 同（三段序：sticky→剪枝→抽签） |
| 预算 | `round(budget% × maxContext)`，cap 0=off，ignoreBudget 豁免，溢出停递归 | computeBudget 同式 |
| 位置 | before/after/ANTop/ANBottom/EMTop/EMBottom/atDepth(+role)/**outlet**（:855-864） | 同 8 位桶 + outlets |
| 装饰器 | @@activate / @@dont_activate（:103） | parseDecorators 同 |
| characterFilter/triggers | names+tags 过滤 / 生成类型触发 | 同 |
| 排序 | `order` 降序→unshift 成升序（tie 行为敏感）；编辑器另有 10 种显示排序 | 同款双步还原；**编辑器排序 UI 无** |

**全局书选择**：ST = WI 抽屉顶部多选下拉（`WIMultiSelector`，"Active World(s) for all chats"），
持久在 `settings.world_info.world_info.globalSelect`。Iris = `worldbook.globalSelect`/
`setGlobalSelect` RPC **已有**（宿主读写与 ST 兼容的 settings 段，worldbooks.ts:55），但**壳上无一键**——
ST-BOOK-FETCH 的"取选择"交互点记在 SETTINGS 待办。

**UI 面板**（ST 抽屉实测，index.html 4659-4830 + 6802-7200）：
世界列表（建/导/导出/重命名/复制/删除）、激活设置七滑杆六复选（depth/budget/budget_cap/
min_activations/min_activations_depth_max/max_recursion_steps/insertion_strategy +
include_names/recursive/case_sensitive/match_whole_words/use_group_scoring/overflow_alert）、
条目编辑器 30+ 字段（主副键+逻辑、逐条覆盖、位置+depth+role、分组、概率、计时、memo、
automationId、状态灯 constant/normal/vectorized）、条目列表过滤与 10 种排序。
**Iris：全部无 UI**（worldbook.* 七个 RPC 只服务卡脚本）。→ **等级 A，任务 L 进行中**。

**Iris 世界书还差的细节**：vectorized 仅作标志透传（无向量库，ST 本身也只标记）；
automationId 无消费者；Agnai/Risu/NovelAI 方言导入转换器无（ST :5358/:5403/:5448）；
`charLore.extraBooks` 角色多书绑定无存储。

## 14. 预设专节（用户点名）

**格式**。ST 预设 = 每用户目录下的 JSON 文件族（`presets.js:12-45`）：
`OpenAI Settings`（CC 主预设：sampling + `prompts[]` + `prompt_order[]` + utility prompts +
squash/后处理开关）、`TextGen Settings`、`KoboldAI Settings`、`NovelAI Settings`、
`context`（story_string）、`instruct`、`sysprompt`、`reasoning` 八族 + UI 三族
（themes/movingUI/QuickReplies）。出厂即带 34 context/38 instruct/13 sysprompt/5 reasoning/
24 novel/6 textgen/…（实机首次初始化日志）。端点 save/delete/restore（restore=出厂重置）。

**管理**。settings/get 一次带出 `*_setting_names` + 全部预设内容；UI 每族一个下拉 + 
保存/另存/删除/导出/导入；CC 预设还带 Prompt Manager（index.html 7262+）：prompt 列表
增删改、拖拽排序、逐条启停、role/position/depth/order/forbid_overrides/triggers 编辑、
inspect 列表看逐条 token。

**切换**。下拉即换（写回 settings），connection-manager 可把"端点+模型+预设"打包成 profile
一键切（本机 2 个 profile 实证在用）。

**装配顺序**。`preparePromptsForChatCompletion`（openai.js:1358）：
① 系统侧 prompt 造好（WI before/after、卡描述/人格/场景按 `personality_format`/
`scenario_format` 模板化、impersonate/quiet/groupNudge/bias、扩展注入、personaDescription）；
② `promptManager.getPromptCollection`（角色自己的 order，回退 100001 全局哨兵）；
③ 系统槽按 marker 回填表位，覆盖 role/position/depth/order；
④ 角色级 main/jailbreak override（`forbid_overrides` 拒绝）；
⑤ relative 项按表序、absolute 项按 depth 注入、chatHistory 是**位置不是内容**；
⑥ TokenBudget 逐项扣减，超限报错；`squash_system_messages` 可选合并。
Iris：①-③⑤ 逐字对应（preset/chat-completion.ts + app-service/prompt.ts，100001 哨兵实测订正）；
④ 卡级 main/post-history ✅；⑥ 有（prompt.itemize 的 budgetUse）；
**②的多预设来源没有**——全宿主一枚预设（config `presetPath`），`script.getPreset` 只答
`'in_use'`（service.ts:535"this host only carries the one in use"）。→ **等级 A，任务 M 进行中**。

**Iris 预设还差的细节**：triggers 生成类型过滤、utility prompts（continue/impersonate 族）、
squash/后处理、`context`/`instruct`/`sysprompt`/`reasoning` 四族（后两者部分被内置 default 的
main/reasoning 显示吸收）、出厂预设库、restore。

---

## 15. 最重要的十个差距（按等级与用途排序）

1. **世界书面板 UI**（A，任务 L 进行中）——引擎/存储/RPC 全活，用户却开不了书、看不了条目、点不了全局书。
2. **预设存储与切换**（A，任务 M 进行中）——单预设宿主；ST 用户的第一动作"换预设"在 Iris 无从发生。
3. **聊天导入/导出**（A→迁移路径）——持久层就是 ST JSONL，差的只是把用户的 `chats/` 搬进 profile 的 RPC+UI 与导出回流。
4. **聊天内容搜索**（B）——ST `/api/chats/search` + 最近聊天；长局用户高频。
5. **continue / impersonate 生成类型**（B）——RP 高频动作；连带 utility prompts 与 triggers 过滤。
6. **全局正则层**（B）——引擎为三层预留，只差存储+管理 UI（本机实配 0 条全局，故列 B 不列 A）。
7. **宏差集**（B，S 档）——date/weekday/timeDiff/reverse/outlet/noop/楼层寻址族补齐即全量。
8. **设置面扩容**（B）——~15 项 vs 83 键；按 SETTINGS.md 的"你想改什么"组织，不是照抄。
9. **Persona**（C，便宜）——marker 已占位；管理+注入+persona 书绑定一条线。
10. **主题/外观层**（C）——themes/movingUI/user.css 的等价物应落在 Iris 的 slot 系统上（升级点，不是复刻）。

纯缺失独立子系统（vectors/memory/TTS/SD/translate/caption/expressions/attachments/群聊/
文本补全后端/多用户）不进前十：语料零使用或各自是一个项目（ROADMAP Tier 3）。

## 16. 建议实现顺序

已由 `IMPLEMENTATION-CHECKLIST.md` 承接（阻断 → 缺细节 → 纯缺失，逐项带证据/方案/依赖/
工作量档/验收标准）。世界书=任务 L、预设=任务 M 均在进行中，清单只做对齐标注。
