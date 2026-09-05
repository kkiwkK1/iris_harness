# 界面字符串盘点 —— 任务 I

日期 2026-09-04，分支 `dev/feat-i18n`，基线 `dev/iris-exploration` @ `c48e910`。

词典在 `strings.ts`（`en` 为键源，`zh` 必须逐键覆盖，类型系统强制）；语言状态在
`language.ts`；React 侧 `use-language.ts`。这份文档回答**数了什么、在哪、什么没翻译**。

## 一、已翻译（进词典）

来源文件 → 字符串组（键名前缀）：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `Sidebar.tsx` | 标签页（阅读/角色库）、两个空态、导入卡片、行菜单（删除对话/移出角色库/更多操作）、meta（作者/N 条消息） | `sidebar* tab* chatsEmpty libraryEmpty importCard delete* remove* moreActions* noCreator* byCreator messageCount` |
| `Sidebar.tsx` 聊天 tab 内容搜索（`chat.search`） | 搜索框 aria 与占位、无结果句（回显查询词）、命中行（楼层号、另有 N 楼命中） | `chatSearchAria chatSearchPlaceholder chatSearchEmpty chatSearchFloor chatSearchMore` |
| `format.ts` `since` | 相对时间（刚刚/N 分钟前/N 小时前/N 天前） | `justNow minutesAgo hoursAgo daysAgo` |
| `Masthead.tsx` | 设置钮、导航 aria、重命名 tooltip/aria、回合数（尚未开始/1 回合/N 回合）、writing…、种子数据横幅 | `showConversations settings rename* conversationTitle notStarted oneTurn turns writingNow seeded*` |
| `App.tsx` | 未连接横幅、通知关闭 aria、拖放提示 | `notConnected dismiss dropCard` |
| `ChatPane.tsx` | 两个空态、加载更早按钮（含 hidden 计数）、空白页空态 | `openingLastChat nothingOpen pickCharacterHint showEarlier hiddenAbove pageBlank writeFirstLine` |
| `Composer.tsx` | 占位（两个）、aria、提示词钮、快捷键提示、发送/停止 | `irisWriting writeYourPart yourMessage promptButton composerHint send stop` |
| `Message.tsx` | 保存/取消/复制/编辑/提示词/重新生成/删除、Copied.、生成中 aria | `save cancel copy edit regenerate delete copied generatingAria` |
| `VariantRail.tsx` | 全部 aria 标签（读法计数/记录态/上一下一） | `rail*` |
| `Reasoning.tsx` | 思考中 / 推理 · N 词 | `thinking reasoningWords` |
| `MessageInterfaces.tsx` + `message-frames.ts` `describeInterface` | “渲染这一个”钮、五种槽位状态句 | `renderThisOne iface*` |
| `ScriptButtons.tsx` | 按钮栏 aria | `cardButtonsAria` |
| `useCardScripts.tsx` | 卡片界面收起/显示钮及其 tooltip | `showCardUi hideCardUi *Title` |
| `StatePanel.tsx` | 面板头、aria、空态、布尔值（是/否） | `state* booleanYes booleanNo` |
| `SettingsDrawer.tsx` | 抽屉 aria/标题（两种）/关闭/未加载；路由与采样全部标签与注释；主题选项；正文字号/每行长度；语言项 | `drawer* defaults* thisConversation close settingsNotLoaded section* provider model temperature* … langEn langZh` |
| `fields.tsx` | host default / use host default | `hostDefault useHostDefault` |
| `ConnectionPanel.tsx` | 宿主行、种子注记、空态、删除 aria、启用连接两句话、命名输入、保存连接 | `host seededNotReal noSavedConnections deleteNamed activate* nameThisConnection connectionName saveConnection` |
| `ScriptPanel.tsx` | 面板头、读取中、无脚本、已拒绝摘要、允许脚本、撤回/更早运行注记、页面访问权全部文案、授权风险对话框四条、随卡运行/你已关闭、卡内关闭、运行它们/不运行 | `sectionCardScripts readingCard cardNoScripts declined* allowScripts runThem dontRunThem withdrawn fromEarlierRun pageAccess* grantDialog* runsWithCard youTurnedThisOff cardOffNote` |
| `ConsentAsk.tsx` | 区域 aria（复用 `sectionCardScripts`） | — |
| `consent.ts` `describeConsentAsk` | 授权问句全部变体（全运行/部分运行/覆盖关闭/沙箱句） | `consent*` |
| `script-run-state.ts` `describeRun` / `summariseRuns` | 九种运行相位句 + 汇总句五种变体 + another script | `run* runs*` |
| `HostReports.tsx` | 面板头、读取按钮三态、三空态、堆栈 summary、丢弃计数 | `hostReports reports* stackSummary` |
| `NoticeLog.tsx` | 面板头、空态、丢弃计数 | `noticesHead noticesEmpty noticesDropped*` |
| `PromptPanel.tsx` | 模态标题两种、关闭、统计中、过期/不符两条警示、estimated/provider counted/占可用、占比 aria、行排序、丢弃、超预算、空 | `prompt* counting orderLargest orderAssembly droppedToFit overBudget tokenEmpty rowOrderAria` |
| `CleanupOffer.tsx` | 标题/正文/三个按钮（对应上游 zh-CN 原文语义）/计数句/关闭不算拒绝 | `cleanup*` |
| `errors.ts` COPY + `store.ts` 通知 | 各错误码文案、Iris 自身错误前缀、清理结果、备份去向、报告不可读、页面访问权授予/撤销 | `err* irisOwnFault cleanedMessages backedUpTo reportsUnreadable pageAccessGranted pageAccessRevoked` |

任务 R（设置面扩容，`dev/feat-settings`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `fields.tsx` / `SettingsDrawer.tsx` / 各面板 | 折叠卡九区标题与卡头摘要（连接/预设/路由/采样/回复/阅读/世界书/脚本/通用与关于） | `sectionReplies sectionAbout noActiveConnection presetNoneActive worldbookSummary scriptSummary samplingDefault samplingSet repliesTrim repliesSquash repliesContinue aboutSummary` |
| `SettingsDrawer.tsx` 回复卡 | 三个回复形态键：裁剪未完成句、续写分隔符（四选）、合并相邻注入 | `trimSentences* continuePostfix* postfix* squashSystemMessages*` |
| `SettingsDrawer.tsx` 阅读卡 | 楼层号开关（`mesIDDisplay_enabled` 的等价物，每设备） | `showFloorNumbers*` |
| `AboutCard.tsx` | 启动自动打开开关、设置导出/导入全部文案、凭据安全声明两句 | `autoOpenChat* exportSettings importSettings settingsExported settingsImport* settingsTransferNote credentialHead credentialBody credentialBodyTransport` |

任务 P（角色管理操作，`dev/feat-character-mgmt`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `Sidebar.tsx` 角色库 | 标签过滤行与排序切换（aria + 选项）、过滤空态、行菜单六项（收藏/取消、复制、重命名、编辑标签、导出 PNG/JSON）、★ 开关 aria、行内编辑器 aria 与保存/取消 | `filterByTag allTags sortByAria sortByName sortByUpdated sortByFavorite libraryFilteredEmpty favorite unfavorite duplicateCharacter renameCharacterMenu editTags exportCardPng exportCardJson characterNameAria tagsInputAria` |
| `store.ts` 通知 | 复制完成、改名完成、导出完成三句 | `characterDuplicated characterRenamed characterExported` |

任务 A1（世界书条目编辑器，`dev/feat-wi-editor`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `WorldbookPanel.tsx` 条目编辑器 | 编辑器头与选书、未保存具名提醒与三键确认（保存并继续/放弃/继续编辑）、工具栏（过滤/排序/计数/保存/还原/下载备份/关闭）、条目行（标题/提示/徽标/启停）、键标签输入（aria/占位/删除） | `wiEditorTitle wiPickBook wiUnsaved* wiFilterPlaceholder wiFilterEmpty wiSort wiShownCount wiSave wiDiscard wiBackup wiClose wiExpand wiUntitled wiBadge* wiEnabledShort wiKey* wiKeysPrimary wiKeysSecondary` |
| `WorldbookPanel.tsx` 条目表单 | 四逻辑、三状态（常驻/普通/向量化）、8 位置、角色、深度/顺序/概率、内容与标题、启用/批注/忽略预算、递归三件、计时三件、分组三件、逐条覆盖（扫描深度/自动化ID/输出口/大小写/整词/分组计分 + 三态选项）、生成类型六项、角色过滤、六匹配来源 | `wiLogic* wiStrategy* wiPos* wiRole* wiDepth wiOrder wiProbability wiUseProbability wiContent* wiTitle* wiEnabled wiAddMemo wiIgnoreBudget wiExcludeRecursion* wiPreventRecursion* wiDelayUntilRecursion* wiTimedEffects wiSticky* wiCooldown* wiDelay* wiGroup* wiOverrides wiScanDepthOverride wiAutomationId* wiOutletName* wiCaseSensitiveOverride wiWholeWordsOverride wiGroupScoringOverride wiOverride* wiNumUnset wiTriggers* wiTrigger_* wiFilter* wiMatchSources wiMatch_*` |
| `WorldbookPanel.tsx` 排序下拉 | 上游 `#world_info_sort_order` 的 15 个选项逐项（14 可见 + 搜索相关度） | `wiSort_priority wiSort_custom wiSort_title_* wiSort_tokens_* wiSort_depth_* wiSort_order_* wiSort_uid_* wiSort_probability_* wiSort_search` |
| `store.ts` 通知 | 保存完成、备份导出两句 | `wiSaved wiBackupExported` |

规模：词典 `en` 约 **320 条**（含复数/变体拆分），`zh` 与其逐键对应。

## 二、刻意不翻译（及理由）

- **卡片内容、模型输出**——那是卡作者/模型的文字，不是外壳的。
- **宿主诊断报告的 message 正文**（`debug.reports` 的 `message`、`describeRefusal`
  的拒绝句、`blocked-report.ts`、帧错误 `detail`）——诊断原文保留英文便于对照源码；
  报告面板自己的栏位标题/按钮/空态全部翻译。
- **卡脚本注入的通知正文**（`toastr`、卡自己的 report 行、ChatPane 的
  `button … was pressed while no card scripts are running` 落入报告列表，同属诊断）。
- **人名/专名**：`Iris`、`MVU`、参数名（Top-p / Top-k / Min-p）、代码与路径
  （`?transport=rpc`、`local/qwen3-8b`）。
- **语言选项自身**：`English` / `中文` 各以本语言显示，永不翻译（词典键
  `langEn` / `langZh` 两边同值）。
- **世界书的状态记号与方向箭头**：条目状态的 🔵🟢🔗（上游选择器原样）与排序的
  ↑↓↗↘ 保留记号不译；四逻辑枚举 zh 侧用社区惯例译名（与任意/与全部/非全部/
  非任意），en 侧保留 `AND ANY` 等原文——注释句（`wiLogicNote`）里两者都出现，
  对照上游下拉不致失联。

## 三、术语表（全库一致）

| 英文 | 中文 |
| --- | --- |
| reading（一个回合的一刷） | 读法 |
| turn | 回合 |
| character / character card / library | 角色 / 角色卡 / 角色库 |
| import | 导入 |
| settings / connection / provider / model | 设置 / 连接 / 提供方 / 模型 |
| sampling: temperature / reply length cap / repetition penalty… | 温度 / 回复长度上限 / 重复惩罚…（Top-p、Top-k、Min-p、Seed 保留原文/种子） |
| host default | 宿主默认 |
| card scripts / page access / grant | 卡片脚本 / 页面访问权 / 授予 |
| sandbox | 沙箱（隔离子沙箱） |
| host reports / notices / state | 宿主报告 / 通知 / 状态 |
| prompt / regenerate / swipe | 提示词 / 重新生成 / （读法切换） |
| frame budget / markup | 帧预算 / 标记 |
| overlay / card UI | 卡片界面（收起/显示） |
| world book / entry | 世界书 / 条目 |
| key / secondary key | 关键词 / 次要关键词（ST 中文社区惯例；「键」易与按键混淆） |
| comment（entry title） | 批注（条目标题） |
| constant / normal / vectorized | 常驻 / 普通 / 向量化 |
| position: before/after char defs, before/after EM, before/after AN, at depth, outlet | 角色定义前/后、示例消息前/后、作者注释前/后、按深度注入、输出口 |
| order / depth | 顺序 / 深度 |
| probability（Trigger %） | 触发概率 |
| sticky / cooldown / delay / delay until recursion | 黏滞 / 冷却 / 延迟 / 延迟至递归 |
| exclude recursion / prevent recursion | 不可被递归激活 / 阻止继续递归 |
| inclusion group / group weight / prioritize | 包含分组 / 分组权重 / 优先 |
| automation ID / outlet name | 自动化 ID / 输出口名称 |
| per-entry override | 逐条覆盖 |
| scan depth / case-sensitive / whole words / group scoring | 扫描深度 / 区分大小写 / 整词匹配 / 分组计分 |
| generation triggers（normal/continue/impersonate/swipe/regenerate/quiet） | 生成类型过滤（普通/续写/代写/切换/重新生成/后台） |
| character filter / exclude | 限定角色 / 排除 |
| additional matching sources | 额外匹配来源（角色描述/角色性格/情景/用户人格描述/角色小贴士/创作者注释） |
| unsaved changes | 未保存的修改 |

## 四、持久化决策（同 `language.ts` 文档）

`localStorage` 键 `iris.language`，与 `iris.theme` / `iris.reading` 同一处、同一套
safeRead/safeWrite 容错。理由：`SETTINGS-IA.md` 把「屏幕上有什么」类偏好（主题/字号/
行长）标为 界面本地 🟢，语言属于同一意图；宿主 `settings.*` 是生成路由，且按对话生效，
放语言会把 per-device 的选择做歪。默认跟随 `navigator.language`（`zh*` → 中文），
仅当用户手动切换才落盘——不选不存，换设备仍可各自作答。
