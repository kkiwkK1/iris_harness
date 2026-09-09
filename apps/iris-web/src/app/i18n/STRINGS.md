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
| `Composer.tsx` | 占位（两个）、aria、提示词（2026-09-10 起是「+」菜单里的一行，不再是胶囊）、快捷键提示、发送/停止（这两个如今是 32px 圆钮的 `aria-label`，钮里没有字） | `irisWriting writeYourPart yourMessage promptButton composerHint send stop` |
| `Message.tsx` | 保存/取消/复制/编辑/提示词/重新生成/删除、Copied.、生成中 aria | `save cancel copy edit regenerate delete copied generatingAria` |
| `VariantRail.tsx` | 全部 aria 标签（读法计数/记录态/上一下一） | `rail*` |
| `Reasoning.tsx` | 思考中 / 推理 · N 词 | `thinking reasoningWords` |
| `MessageInterfaces.tsx` + `message-frames.ts` `describeInterface` | “渲染这一个”钮、五种槽位状态句 | `renderThisOne iface*` |
| `ScriptButtons.tsx` | 按钮栏 aria | `cardButtonsAria` |
| `useCardScripts.tsx` | 卡片界面收起/显示钮及其 tooltip | `showCardUi hideCardUi *Title` |
| `StatePanel.tsx` | 面板头、aria、空态、布尔值（是/否） | `state* booleanYes booleanNo` |
| `SettingsDrawer.tsx` | 抽屉 aria/标题（两种）/关闭/未加载；路由与采样全部标签与注释；主题选项；正文字号/每行长度；语言项 | `drawer* defaults* thisConversation close settingsNotLoaded section* provider model temperature* … langEn langZh` |
| `fields.tsx` | host default / use host default | `hostDefault useHostDefault` |
| `ConnectionPanel.tsx` | 宿主行、种子注记、空态、删除 aria、立即生效那一句 | `host seededNotReal noSavedConnections deleteNamed activationImmediate`（这一行 2026-09-09 按 CC Switch 重做，其余键见文末「连接面重做」一节） |
| `ConnectionPanel.tsx` 测试连接判定句 | 每个失败码一句（缺密钥/401/超时/网络/地址不是 URL/密钥含请求头无法携带的字符/HTTP 错误/不是模型列表/无端点）；宿主自己的原因句（英文技术细节:尝试的地址、状态码、`ENOTFOUND` 之类）不翻译,原样显示在判定句下方 | `testErr*` |
| `ScriptPanel.tsx` | 面板头、读取中、无脚本、已拒绝摘要、允许脚本、撤回/更早运行注记、页面访问权全部文案、授权风险对话框四条、随卡运行/你已关闭、卡内关闭、运行它们/不运行 | `sectionCardScripts readingCard cardNoScripts declined* allowScripts runThem dontRunThem withdrawn fromEarlierRun pageAccess* grantDialog* runsWithCard youTurnedThisOff cardOffNote` |
| `ConsentAsk.tsx` | 区域 aria（复用 `sectionCardScripts`） | — |
| `consent.ts` `describeConsentAsk` | 授权问句全部变体（全运行/部分运行/覆盖关闭/沙箱句） | `consent*` |
| `script-run-state.ts` `describeRun` / `summariseRuns` | 九种运行相位句 + 汇总句五种变体 + another script | `run* runs*` |
| `HostReports.tsx` | 面板头、读取按钮三态、三空态、堆栈 summary、丢弃计数 | `hostReports reports* stackSummary` |
| `NoticeLog.tsx` | 面板头、空态、丢弃计数 | `noticesHead noticesEmpty noticesDropped*` |
| `PromptPanel.tsx` | 模态标题两种、关闭、统计中、过期/不符两条警示、estimated/provider counted/占可用、占比 aria、行排序、丢弃、超预算、空 | `prompt* counting orderLargest orderAssembly droppedToFit overBudget tokenEmpty rowOrderAria` |
| `CleanupOffer.tsx` | 标题/正文/三个按钮（对应上游 zh-CN 原文语义）/计数句/关闭不算拒绝 | `cleanup*` |
| `CardPopup.tsx` | 「卡片正在询问」归属句、上游六个默认按钮文案、格式被拒注记 | `popupCardAsks popupOk popupYes popupNo popupCancel popupSave popupCrop popupMarkupRefused` |
| `errors.ts` COPY + `store.ts` 通知 | 各错误码文案、Iris 自身错误前缀、清理结果、备份去向、报告不可读、页面访问权授予/撤销 | `err* irisOwnFault cleanedMessages backedUpTo reportsUnreadable pageAccessGranted pageAccessRevoked` |

任务 R（设置面扩容，`dev/feat-settings`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `fields.tsx` / `SettingsDrawer.tsx` / 各面板 | 折叠卡各区标题与卡头摘要（连接/预设/采样/回复/阅读/世界书/脚本/通用与关于——「路由」那一区 2026-09-09 删掉了，见文末） | `sectionReplies sectionAbout noActiveConnection presetNoneActive worldbookSummary scriptSummary samplingDefault samplingSet repliesTrim repliesSquash repliesContinue aboutSummary` |
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
| description（卡的 `data.description`） | 简介（角色页栏头用「简介」，不用「描述」——设计稿如此，且「描述」在世界书条目里另有所指） |
| embedded book | 内嵌（世界）书——与「按名字绑定的书」区分，后者不在角色页上 |
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

任务（前端方案「梅花」，`dev/post-merge-followups`）追加与改写：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `Masthead.tsx` | 副行的「N 个脚本在运行」，取自 run states 而非脚本清单 | `scriptsRunning` |
| `Sidebar.tsx` 角色库 | 搜索框（名字＋标签）与三枚排序胶囊、搜索空态。**取代**原来的标签 `<select>`：`filterByTag` `allTags` `libraryFilteredEmpty` 三键已删除，搜索框覆盖了标签过滤 | `librarySearchAria librarySearchPlaceholder librarySearchEmpty sortByAria sortByName sortByUpdated sortByFavorite` |
| `CharacterPage.tsx` | 角色页：aria、「开始新对话」、三栏事实（对话/标签/卡片文件）的标题与取值句、未选角色时的提示 | `characterPageAria startNewChat faceConversations faceNoConversations faceOneConversation faceOpenCount faceLatest faceTags faceNoTags faceTagCount faceCardFile faceUpdated faceUpdatedUnknown faceCreator facePickHint` |
| `StatePanel.tsx` | 变量栏收起/展开的按钮标题。`stateHead` 由「状态 / State」改写为「变量 / Variables」——canvas.json 把这一栏定为宿主自己的变量管理器 | `stateCollapse stateExpand`（`stateHead` 改写） |
| `AppearanceCard.tsx` | 三套主题改名「雪 / 墨 / 宣」（en: Snow / Ink / Xuan paper）。**id 不动**：`light` / `dark` / `parchment` 是存量用户 `localStorage` 里的值 | `themeLight themeDark themeParchment`（改写） |

任务（角色页三栏事实落到协议上，`dev/plum-theme`）追加与删除：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `CharacterPage.tsx` 简介带 | `CharacterSummary.description`（宿主截到 200 个码位）的栏头。有则整带出现，无则连栏头都不出现——19 张真卡里 15 张没有简介 | `faceDescription` |
| `CharacterPage.tsx` 世界书栏 | 内嵌书条目数。`0` 另给一句：卡带了一本空书与卡没带书是两件事，协议分开送，界面不能合 | `faceWorldbook faceBookEntries faceBookEmpty` |
| `CharacterPage.tsx` 脚本栏 | 卡内可运行脚本单元数（`extractScripts` 口径，含作者关掉的）＋授权注记。授权只在 `scriptsFor` 正是这张卡、且答案是 allowed/declined 时才写——「还没问」不是一种状态 | `faceScripts faceScriptCount faceScriptsAllowed faceScriptsDeclined` |
| `CharacterPage.tsx` | **删除**六键：`faceTags` `faceNoTags` `faceTagCount` `faceCardFile` `faceUpdated` `faceUpdatedUnknown`。标签与卡片文件时间是协议还没有三栏事实时的顶替；标签本来就在名字下面以胶囊呈现，重复一遍没有信息。对话栏留着——它是唯一对任何卡都答得出的一栏，纯 V1 卡（无简介/无书/无脚本）靠它才不至于渲染出一排空事实 | （无新增） |

任务（窄窗口让位，`dev/plum-theme`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `StatePanel.tsx` 让位注记 | 抽屉占轨且窗口付不起「侧栏＋变量栏＋抽屉＋可读正文」时，变量栏临时收成 36px 窄条；这一句是那时收起键的 title。措辞是承诺而不是报错：读者自己的选择没有被改写，关掉抽屉就回来（`state-panel.ts` 的 `asideShowing`） | `stateYielded` |

任务（提供方回报的 token 用量，`dev/plum-theme`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `token-format.ts` 数字格式 | 三个**不含中文**的格式行：紧凑档的 K / M 后缀、千分位分隔符。两栏今天都是 `,`：`i18n.test.ts` 的 `neutral` 名单按键放行「zh 必须有中文」那条，`token-format.test.ts` 再把两栏各钉一次，改哪一栏都会红（不是要求两栏必须不同） | `tokensThousand tokensMillion thousandsSeparator` |
| `Composer.tsx` 输入框下的用量行 | 会话累计（`ChatView.usage`）：`缓存命中 N%` 与 `输入 X tok · 输出 Y tok` 两组，组间 `\|`、组内 `·`。整组没数据就整组消失，两个数都是 0 或宿主没报就整行不渲染。行和它悬浮卡里的行是同一组构造（`usageSummaryRows`），行上的「输入」因此拿到了自己的键 `usageSummaryInput`——不是给三桶之和另起一个词；卡标题 `usageSummaryTitle` 与每轮的「本轮用量」相对。原 `usageTokens`（整句两组的键）随纯文本装配一并删除 | `usageCacheHit usageSummaryTitle usageSummaryInput` |
| `Message.tsx` 每轮用量 | 助手消息动作行末尾的安静读数，与其他 `iris-act` 同字号；悬停与键盘聚焦展开明细悬浮卡（`UsagePopover`，触屏轻点切换、Esc 或移出关闭），行序照 harness 那张对话框——原 `title` 纯文本版（`usageDetailText`）已随弹层落地删除 | `usageTurn usageTurnTitle usageDetailCacheHit usageDetailInput usageDetailCacheRead usageDetailCacheWrite usageDetailOutput usageDetailReasoning usageCount` |

措辞两条约定，别混称：**「用量」只指提供方回报的实际计费**，`PromptPanel` 那套「估算 /
provider counted」是另一件事（上游 ST 每条消息显示的 `token_count` 属于前者的估算口径，见
`notes/apps/iris-web/DEVIATIONS.md` 47）；**「未缓存输入」不是「输入」**——三个 prompt 侧
桶是互斥的，`inputTokens` 不含缓存服务掉的部分，用量行上的「输入」是三桶之和。
任务（世界书面板按卡分组，`dev/worldbook-panel-per-card`）追加与改写：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `WorldbookPanel.tsx`「本卡的世界书」 | 面板第一节：这张卡在用哪本书、多少条、来源是磁盘上的文件还是卡里还没落盘的内嵌书、以及都没有。三种来源分开成句，因为它们指向不同的下一步（就地编辑 / 打开一次对话 / 无事可做） | `worldbookThisCard worldbookEntryCount worldbookCardSourceNamed worldbookCardSourceEmbedded worldbookCardEmbeddedUnnamed worldbookCardNone` |
| `WorldbookPanel.tsx` 改名注记 | 只在「屏幕上的书名」不是「卡要的书名」时出现——宿主物化时撞名，只好另起一个。实测这台开发档 `origin: 'minted'` 为 0 本，所以这句是给撞名那一种情况留的，不是常态 | `worldbookCardMinted` |
| `WorldbookPanel.tsx` 机制句 | 用户原话的后半段：「世界书设置应该是每个对话自动优先绑定自己的世界书，而不是被其他的世界书污染」。宿主本来就是这样做的（`worldbooks.ts` 的 choose, never combine ＋ 全局书另加），面板从来没说出来。这一句不是承诺，是把既有规则写在读者正在看的地方 | `worldbookCardRule` |
| `WorldbookPanel.tsx` 两种非答案 | 「没打开对话」与「这台宿主不存世界书」都不是 `none`。把它们说成「这张卡没有世界书」，是拿处境的话去回答关于卡的问题 | `worldbookNoChat worldbookCardNotLoaded` |
| `WorldbookPanel.tsx`「全局启用」 | 默认折叠，已选的常在视野内，其余磁盘上的书折在 `Show all N books` 后面。折叠标签带总数——折起来的清单不带数就跟丢了一样。每行带条目数与「来自 ×× 卡」 | `worldbookGlobalHead worldbookGlobalCount worldbookGlobalNone worldbookGlobalExpand worldbookGlobalCollapse worldbookFromCard` |
| `WorldbookPanel.tsx` | **改写** `worldbookCharBind`：「绑定到当前角色」→「本卡的附加绑定」。这一节写的一直只是 `charLore` 的附加书；卡自带的那本挪到了第一节，标题再说「绑定到当前角色」就把两件事混成一件。`worldbookCharPrimary` / `worldbookCharPrimaryNone` 两键留用——宿主不存世界书时，卡文件自己绑了什么是唯一还答得出的事实，正是这两句 | （改写一键） |
| `WorldbookPanel.tsx` 附加绑定计数 | 附加绑定那一节也从横向一排改成一行一本（带条目数与来自哪张卡），因为它原本同样把安装里全部的书铺成一排——18 本时正是「互相挤压」那件事。这一句是它的计数。整节不折叠：绑一本附加书是在短清单上的一次刻意操作，不是要滚动的选择器 | `worldbookCharBindCount` |

任务（模型菜单读宿主默认连接，`dev/model-menu-host-default`）追加与改写：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `Composer.tsx` 模型菜单标题 | 列表来自宿主启动时那条连接（env 配置、还没存过 profile 时的常态）。两句分开是因为宿主可能不持凭据：持有时把**变量名**说出来，那是读者唯一能去改的地方；不持有时就不提。变量的名字，永远不是它的值 | `modelMenuFromHost modelMenuFromHostEnv` |
| `Composer.tsx` 列表状态那一行 | 点开菜单时列表缺席就当场探一次，所以多了两种状态：在读、以及读失败。失败那句原样转述宿主命名过的拒绝（`unauthorized` / `network` / `no-endpoint` …），不改写成一句「获取失败」——那三种指向的下一步不同 | `modelMenuReading modelMenuReadFailed` |
| `Composer.tsx` | **改写** `modelMenuNoList`：原文写「可在连接面板里探测一次」。现在点开菜单自己就会探，那句话把读者指向一条不再需要走的路；剩下的只说事实 | （改写一键） |

任务（角色页三栏由计数升级成清单，`dev/character-page-details`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `CharacterPage.tsx` 对话栏 | 每个会话一行：标题＋「N 分钟前 · N 条消息」，点进去就是库里那条既有的打开路径（`openChat`）。行的 aria 回显标题，因为一列里全是同形状的行，只念「打开」的按钮在读屏里是十个一样的按钮 | `faceOpenConversation`（`messageCount` 复用） |
| `CharacterPage.tsx` 世界书栏 | 每本书一行摘要，展开才列条目（`<details>`）。摘要是三个数：条目数 / 启用数 / 常驻数——实测本机 841 条里 622 启用、309 常驻，只报总数会把一本书说得比实际在跑的大三成 | `faceBookFigures faceBookNoEntries` |
| `CharacterPage.tsx` 书来源注记 | 只在需要解释时出现：卡里还没落盘的内嵌书、宿主物化时撞名改过的名字、绑了名字但本机没有这本书（实测 18 条绑定里 2 条如此）、以及你自己加绑的附加书。寻常那本（卡自己的、在磁盘上、名字没变）不加注——每行都注等于没注 | `faceBookEmbedded faceBookMinted faceBookMissing faceBookExtra` |
| `CharacterPage.tsx` 条目行 | 一行名字（`comment`）＋一行 meta：常驻 / 触发键 / 位置（八种 ST 位置，只有 `at_depth` 带深度）/ 副键计数 / 已停用。「没有触发键——永远不会触发」是给非常驻却无键的条目的：本机 841 条里 307 条无键，页面上没有别的东西说得出这件事 | `faceEntryConstant faceEntryKeys faceEntryNoKeys faceEntrySecondary faceEntryOff facePlaceBeforeChar facePlaceAfterChar facePlaceBeforeExamples facePlaceAfterExamples facePlaceBeforeNote facePlaceAfterNote facePlaceAtDepth facePlaceOutlet` |
| `CharacterPage.tsx` 脚本行 | 一行名字＋一行 meta：来源（当时 `script.list` 只答卡内嵌，所以这一格是常量 `faceScriptInCard`——脚本库任务已把它改成读 `script.source`，见下节）/ 两个开关分开成句 / 体积 / 按钮数与其中可见数（89 个按钮里 58 个作者设为不可见）。末尾一句说开关在哪——这一页只报告，`script.setEnabled` 的作用域是**正在对话的那张卡** | `faceScriptInCard faceScriptOn faceScriptOffByCard faceScriptOffByYou faceScriptOnByYou faceScriptButtons faceScriptSwitchNote` |
| `CharacterPage.tsx` 在读一句 | 两份清单按需拉取（`worldbook.charDigest` ＋ `script.list`），在途时栏里说「正在读取卡片…」；落地后仍然缺就什么都不说——宿主不存世界书是处境，空清单会被读成「这张卡没有书」。这一键与 `ScriptPanel.tsx` 共用 | （`readingCard` 复用） |

任务（用量统计页，`dev/usage-stats`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `UsageSection.tsx` 抽屉入口卡 | 折叠卡的标题、折起时那句摘要、以及打开页的按钮。卡而不是页本身：抽屉宽 392px，而图表每个时间桶保留一列可读宽度，30 天要约 1.7 个抽屉宽才不用横滚——所以页是对话框 | `usageEntry usageEntrySummary usageOpen` |
| `UsagePanel.tsx` 页标题与两种非结果 | 标题、正在合计、以及「这段时间没有计费」。空态第二句报出扫了多少个对话：不报的话，「没有」读起来像没去看，而不是看过了 | `usagePageTitle usageCounting usageEmpty usageScanned` |
| `UsagePanel.tsx` 时间范围切换 | 今天 / 7 天 / 30 天 / 全部。「今天」是读者自己的午夜起算而不是滚动 24 小时（桶按本地边界切，滚动窗口画在日历桶里会把昨天的一部分算进昨天那一列却把整张读数叫「今天」）；粒度不是独立控件，由范围推出来 | `usageRangeAria usageRangeToday usageRangeWeek usageRangeMonth usageRangeAll` |
| `UsagePanel.tsx` 指标切换 | 折线画哪个数：总量 / 缓存命中 / 未缓存 / 输出。四个都是同一批桶的不同读法，切换不重新取数 | `usageMetricAria usageMetricTotal usageMetricCacheRead usageMetricCacheMiss usageMetricOutput` |
| `UsagePanel.tsx` 顶部合计卡 | 七张卡。**「计费输入」与「未缓存输入」是两件事**：前者是三个 prompt 侧桶之和，后者只是 `inputTokens`（DeepSeek 路由上就是 `prompt_cache_miss_tokens`）。命中率没有可报的口径时印破折号，不印 `0%` | `usageCardTotal usageCardPrompt usageCardCacheRead usageCardCacheMiss usageCardOutput usageCardHitRate usageCardTurns` |
| `UsagePanel.tsx` 图表与图例 | 图的 `aria-label`（画的哪个指标、几条线），以及不具名记录那条线的名字。「未知模型」指**没记下模型名**，不是某个叫 unknown 的模型——真实语料里 12 条记录全是这一种 | `usageChartAria usageUnknownModel` |
| `UsagePanel.tsx` 每对话小计 | 小节标题与每行的生成次数。行可点，进那个对话（同时关掉抽屉） | `usageByChat usageTurnCount` |
| `UsagePanel.tsx` 两句告白 | 不是标签，是对数据本身的说明：有多少次生成的时间是从对话头部重建的（没有 `at` 的记录全落在该对话最后活动那一个桶里，老对话因此读成一根尖峰而不是它真正的那些次会话），以及有多少个对话文件读不出来所以没计入。用 `--iris-warn` 而不是 `--iris-danger`：没有东西坏了，只是上面那些数字没有看起来那么完整 | `usageUndated usageSkipped` |

口径沿用上面「提供方回报的 token 用量」那条的两句约定，不重说；这一页只多一条：**命中率的分母是
`cachePrompt` 而不是「计费输入」那张卡**——它只覆盖回报过缓存桶的那些次生成，所以一台混用
路由的档上两个分母差得很远（两次生成的样例里 75% 对 19%）。不这样分，一条从不提缓存的路由就会
把一条真的有缓存的路由稀释掉，而稀释出来的百分比看上去完全正常。

任务（上下文容量表 + 命令体系，`dev/context-meter`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `ContextMeter.tsx` 容量胶囊 | 输入框下第三枚胶囊。**按过之前只说容量**（`上下文 7.2K`），按过之后才带读数（`上下文 2.1K/7.2K · 29%`）——读数要一次装配预览，按下才付得起。分母是 `context - reserve`，和 `PromptPanel` 那句「占可用 N」同一个数，两处不能各除一个分母 | `contextPill contextPillCapacity contextPillTitle` |
| `ContextMeter.tsx` 容量卡 | 标题、`用了/可用 · 百分比` 的数字行、读数还在算与算失败两句。失败那句原样转述宿主命名过的拒绝，不改写成「读取失败」 | `contextCardTitle contextCardFigures contextCardLoading contextCardFailed` |
| `ContextMeter.tsx` 六个类别 | 按装配来源分，六行永远都在（空的那行读 `0%`，「我的世界书没进提示词」正是这么答出来的）。名字照 `PromptPanel` 已有的词汇：世界书、主提示词与预设段、角色与人设、脚本注入 | `contextCategoryMessages contextCategoryWorldbook contextCategoryPreset contextCategoryCharacter contextCategoryScript contextCategoryOther` |
| `ContextMeter.tsx` 卡底三句 | 还剩多少、为回复留了多少、这份读数是第几回的实测还是下一条的预览。预留额单独说，因为它是分母里被扣掉的那部分，不说会显得窗口凭空少了一块 | `contextRemaining contextReserve contextFromRecord contextFromPreview` |
| `commands.ts` 命令体系 | 补全菜单一行、未命中时的拒绝、生成中拒绝、`/help` 的表头与结尾。**结尾那句是必需的**：只列出 Iris 自己那几条命令，读者会据此断定 `/trigger` 在这里不能用，而它能用——未命中的一律原样交给宿主（写这一行时是两条，第二批之后是八条；条数越多这句越必要，长列表更像完整列表） | `commandRow commandUnknown commandBusy commandHelpHeading commandHelpUpstream commandHelpSummary` |
| `commands.ts` `/compact` | 三种结果各一句：压了多少、没有可压的、没执行。「没有可压的」不是失败，措辞上也不能像失败 | `commandCompactSummary commandCompactDone commandCompactNothing commandCompactFailed` |

任务（第二批命令，`dev/commands-dsh`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `commands.ts` 补全菜单 | `commandRow` 的槽从 `{name}` 换成 `{command}`，填的是 `commandLabel()` 的输出——**带参数占位**（`/rename <标题>`），因为 `/rename` 单看不出后面要跟什么。`commandArgHeading` 给值列表一个表头，理由和模型菜单有表头一样：一列裸模型 id 不说自己是谁的 | `commandRow commandArgHeading` |
| `commands.ts` `/help` 分组 | 三个表头，对应读者扫这张表时问的三件事：能对这个对话做什么、下一条请求里装了什么、设置在哪。空的分组**不出表头** | `commandHelpHeading commandGroupChat commandGroupContext commandGroupApp` |
| `commands.ts` 参数缺失 | `/rename` 不带标题时的拒绝，句尾带上用法——只说「后面得跟点东西」而不说跟什么，读者只能猜语法 | `commandNeedsArgument` |
| `commands.ts` `/new` `/rename` `/export` | 对话三条。`/new` 说不出角色时那句是真会发生的：`view.characterId` 缺失时没有卡可据。`/export` 自己不报——`exportChat` 已经用 `chatExported` 带文件名报过了 | `commandNewSummary commandNewDone commandNewNoCharacter commandRenameSummary commandRenameUsage commandRenameDone commandExportSummary` |
| `commands.ts` `/chat-model` | 六句：读数、设好了、清掉了、本来就是默认、不在列表里、用法。**「其他对话不受影响」这半句是必需的**——读者以为自己改的是全局，下一场戏就会被自己的覆盖绊一下（同 `modelOverriddenHere` 那颗点的理由） | `commandModelSummary commandModelUsage commandModelCurrent commandModelSet commandModelCleared commandModelAlreadyDefault commandModelUnknown` |
| `commands.ts` `/capacity` `/config` | 各一句说明；`/capacity` 另有「宿主还没报窗口」一句——卡片是靠 `view.budget` 渲染的，没有 budget 时命令看着像被忽略了 | `commandCapacitySummary commandCapacityNoBudget commandConfigSummary` |

`commandModelUsage`（`<模型名>|default`）与 `commandRenameUsage`（`<标题>`）是**参数占位**，
不是句子，但两栏都翻——尖括号里的词是给读者看的，`<title>` 对中文读者不说明任何东西。
`default` 那个关键字不翻：它是命令行上要原样打出来的字。

`commandRow` 仍**不含中文**（`/compact —— …`），仍在 `i18n.test.ts` 的 `neutral` 名单里；
换槽名不改这一点，它还是只有排版没有词。
| `CompactionNote.tsx` 已压缩标记 | 对话顶端一行，展开看摘要原文。展开里那句「什么都没删」是这个功能最容易被误读的地方——改的只有发给模型的内容，文件里每一条都还在 | `compactedTitle compactedFigures compactedKept` |

**这一族属于「估算」口径，不是「用量」口径。**卡上除了「缓存命中」那一行之外，每个数都是
宿主对一次装配的估算；`usage*` 那一族只指提供方回报的实际计费（上一条任务的约定，
`notes/apps/iris-web/DEVIATIONS.md` 47）。容量卡是全库唯一让两种数并列的界面，所以措辞上
靠 `PromptPanel` 的「占可用 / 估算」，缓存命中那一行仍用 `usageCacheHit` 原键——它本来就是
回报值，换个说法反而把两种口径搅在一起。

三个键**不含中文**，按 `i18n.test.ts` 的 `neutral` 名单放行：`contextCardFigures`
（`2,048 / 7,168 · 28%`）、`compactedFigures`（`4.1K → 780`）、`commandRow`
（`/compact —— …`）。三个都只是数字与名字的排版，两栏都没有自己的词。

## 四、持久化决策（同 `language.ts` 文档）

`localStorage` 键 `iris.language`，与 `iris.theme` / `iris.reading` 同一处、同一套
safeRead/safeWrite 容错。理由：`notes/SETTINGS-IA.md` 把「屏幕上有什么」类偏好（主题/字号/
行长）标为 界面本地 🟢，语言属于同一意图；宿主 `settings.*` 是生成路由，且按对话生效，
放语言会把 per-device 的选择做歪。默认跟随 `navigator.language`（`zh*` → 中文），
仅当用户手动切换才落盘——不选不存，换设备仍可各自作答。
任务（单独导入正则与酒馆助手脚本库，`dev/regex-scripts-library`）追加与改写：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `RegexPanel.tsx` 新建按钮 | 这一节此前只能导入、开关、排序、导出、删除，**不能写**。一条正则的拼写错误要回 SillyTavern 装机去改 | `regexNew` |
| `RegexEditor.tsx` 字段 | 对着 ST `editor.html` 逐项：名称 / 查找 / 替换为 / 剔除。占位符里写的是 `{{match}}`、`$1`、`$<名字>` 和「一行一条」，因为这两个框的语法是这个编辑器里唯一没法从界面猜出来的部分 | `regexFieldName regexFieldFind regexFieldFindNote regexFieldReplace regexFieldReplacePlaceholder regexFieldTrim regexFieldTrimPlaceholder` |
| `RegexEditor.tsx`「作用于」 | ST 的五个复选框，值 1/2/3/5/6。措辞按**读者的动作**而不是按枚举名：`USER_INPUT` → 「你发出的消息」。0（已弃用的 MD_DISPLAY）与 4（退役的 sendAs）没有控件，和 ST 一致 | `regexFieldAffects regexPlaceUser regexPlaceAi regexPlaceSlash regexPlaceWorldInfo regexPlaceReasoning` |
| `RegexEditor.tsx`「改动的是」 | ST 叫 Ephemerality，可见文案是 Alter Chat Display / Alter Outgoing Prompt，i18n 键却是字段名 Only Format Display / Only Format Prompt。三种说法都没说出读者在选的那件事：**存盘的对话会不会变**。所以这里是两句「你读到的文本 / 模型读到的文本」，底下的注按状态换句——勾任一个就不动存盘，两个都不勾就直接改写且不可撤销 | `regexFieldWhere regexAlterDisplay regexAlterPrompt regexEphemeralNote regexPermanentNote` |
| `RegexEditor.tsx` 其余字段 | 运行时机、关闭、宏处理三档、深度上下限。深度那一句把「从结尾往前数、0 是最后一条」写出来，因为 0 与留空是两个不同的答案，而界面上看不出来 | `regexFieldOther regexRunOnEdit regexDisabledField regexFieldMacros regexMacroNone regexMacroRaw regexMacroEscaped regexFieldMinDepth regexFieldMaxDepth regexDepthUnlimited regexDepthNote regexNameRequired` |
| `RegexEditor.tsx` 四句「这条规则不会生效」 | 全都是引擎那一个门（`getRegexedString`，`engine.js:348-355`）与各调用点传的标志推出来的，不是猜的。ST 对前两种在**保存之后**弹 toast，第三种只写在 checkbox 的 title 里，第四种一个字都没有——而第四种恰好被 ST 自己的新建默认值预先做错了（默认勾「仅显示」，而斜杠命令的四个调用点都不传标志）。只报告、不拒绝：半成品正则是正常要存的东西，ST 也存 | `regexProblemNoPlacement regexProblemNoPattern regexProblemWorldInfo regexProblemSlash` |
| `ScopedRegexPanel.tsx` | 卡自带的正则那一档。实测本机 19 张卡里 **15 张带 173 条**，而同一台装机的全局档是 0 条——此前 Iris 只看得见全局档。摘要分两句（在跑几条 / 已拒绝），因为被拒绝的一档仍然列出来（ST 自己也列），空清单会被读成「这张卡没有正则」 | `sectionScopedRegex scopedRegexSummary scopedRegexRefusedSummary scopedRegexNote` |
| `ScopedRegexPanel.tsx` 允许开关 | ST 的 `character_allowed_regex`，此前 Iris 完全没有这个闸门。拒绝那一句把代价说出来：有些卡靠自带正则藏掉自己写的记账块，关掉之后那些块会直接显示——这是四张 MVU 卡的实际情形，不是假设 | `scopedRegexAllowLabel scopedRegexAllowedNote scopedRegexRefusedNote scopedRegexAllow scopedRegexRefuse` |
| `ScopedRegexPanel.tsx` 两个开关的标注 | 卡作者关掉的 / 无标识不能开关。后者不是理论情形：ST 是懒分配 id 的，虽然本机 173 条全都带 id | `scopedRegexOffByCard scopedRegexUnaddressable` |
| `ScriptLibraryPanel.tsx` | 酒馆助手脚本库。总注一句把三件事一起说清：同一个沙箱、同一个对话级授权、同样那两个远程域名——因为这三件事是读者会问的，也是这个功能唯一可能被误解成「我自己的脚本更受信任」的地方 | `sectionScriptLibrary librarySummary libraryNote` |
| `ScriptLibraryPanel.tsx` 两个仓 | 「所有对话」与「只在这个角色」，按运行顺序排（ST 自己的合并顺序）。没开对话时后一个仓缺席而不是空着——仓属于一张卡，这时候没有卡可指名，所以那一句指向角色页 | `libraryGlobalHeading libraryGlobalNote libraryCharacterHeading libraryCharacterNote libraryCharacterNeedsChat libraryNoScripts` |
| `ScriptLibraryPanel.tsx` 新建/导入/导出 | 导入注把两件事说出来：默认关闭、标识全新（所以同一文件导入两次是两份）。失败那句额外提一句文件夹导出不能在这里导入——那是另一种形状，把外层当脚本导进来会把里面的脚本全丢掉 | `libraryNew libraryImport libraryImportNote libraryImportFailed libraryImported libraryReadFailed libraryDeleteNamed` |
| `ScriptLibraryPanel.tsx` 按钮计数 | 两个数都报。语料里 89 个按钮有 58 个作者设为不可见，所以「2 个按钮，显示 1 个」是常态而不是异常 | `libraryButtonCount` |
| `ScriptEditor.tsx` | 名称 / 备注 / 内容 / 按钮表。体积那一行是实时的，跟同意问句和清单引用的是同一个数——正在打字的人就是将来会被问「要不要跑这么多代码」的人。「新建的脚本保存后默认是关闭的」写在保存按钮旁边，因为那是 ST 的默认值，也是安全的方向，而它会让人以为保存没生效 | `libraryFieldName libraryFieldInfo libraryFieldInfoPlaceholder libraryFieldContent libraryFieldContentPlaceholder libraryBodyBytes libraryNameRequired libraryArrivesOff` |
| `ScriptEditor.tsx` 按钮表 | 一行一个按钮：名字、是否显示、删除。注里说清隐藏的按钮**仍然会发事件**——脚本常把它们当成自己调用的命令，这是 58/89 那个比例的来由 | `libraryFieldButtons libraryButtonsEnabled libraryButtonName libraryButtonVisible libraryButtonRemove libraryAddButton libraryButtonsNote` |
| `CharacterPage.tsx` 脚本来源 | **改写**：来源那一格原本是常量 `faceScriptInCard`，旁边还有一条注释说「`script.list` 只答卡内嵌，没有第二档」。那句话写的时候是真的，脚本库一出现就不再是真的，而常量在错误前提下照样渲染得很好——没有任何东西会发现。现在读 `script.source`，多出两句 | `faceScriptGlobal faceScriptCharacter` |
| `CharacterPage.tsx` 脚本栏新增 | 「其中 N 个是你自己的」只在有非卡内嵌行时出现：上面那个计数是 `character.scriptCount`，一张卡的事实，三个仓合起来之后「3」压在五行上面会被读成数错了。加脚本的按钮在这一页——这一页**拒绝**改卡内嵌脚本的开关（§57），区别在于写到哪个库：`script.setEnabled` 的作用域是正在对话的那张卡，而脚本库的写入自己指名角色 | `faceScriptsOfYours faceAddScript` |

任务 C（缓存友好装配，`dev/cache-aware-assembly`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `SettingsDrawer.tsx` 回复卡 | 「缓存友好装配」开关与注。**这是这张卡上唯一默认开的开关**，所以注里把两件事都写出来：搬的是「每回都变的部分」（而不是随便重排），以及关掉之后逐字节回到 SillyTavern 的顺序。摘要那一行只在**关掉时**才出现，和另外两个开关正好相反——默认开的控件，值得在卡头上说的状态是「被关掉了」 | `cacheFriendly cacheFriendlyNote repliesCacheOff` |
| `PromptPanel.tsx` 被搬动的行 | 徽标 + 原位置两句必须同时出现。只给徽标等于告诉读者「你的提示词被搬走了」却不告诉他去哪里改；原位置报的是宿主那张表里的序号（第 N / M 条），因为标识是 UUID、`order` 是内部数字，「五条里的第三条」是读者唯一能照着动手的说法。**前移与后移必须是两个徽标**：两者含义相反（发在对话之前 / 之后），一句「已移动」恰好把读者唯一需要知道的那件事省掉了 | `promptDeferred promptPromoted promptDeferredWhere promptDeferredAria promptPromotedAria` |
| `ContextMeter.tsx` 稳定前缀 | 单独一行，紧贴 `usageCacheHit` 但**不能合成一句**：那一行是提供方回报的实测计费，这一行是宿主对「这份装配留下多少可复用」的估算。措辞照 §三 的约定走「估算」那一套（「约 X%」），两种数并列的地方只有这张卡 | `contextStablePrefix` |

任务（前缀缓存分叉仪器，`dev/cache-diff-instrument`）追加：

**这一族的单位是「字节」，既不是「估算」也不是「用量」。** `STRINGS.md` §三 定的那条
「用量只指提供方回报的实际计费、`PromptPanel` 那套是估算」在这里出现了第三种数：
**两条请求之间逐字节的比较**。提供方的前缀缓存是按字节判命中的（DeepSeek 64 token
一块，前缀里改一个字节其后全 miss），而字节也是两条请求唯一能精确比较的单位——
token 都是估算或提供方的口径。所以这一族的词里**不出现「token」**，容量卡上它单独
一行、排在缓存命中那一行下面：上面那句是全会话计费 token 的比例，这句是单条请求
字节的比例，两句是同一件失望的两种量法，读者必须能看出它们不是一个数。容量卡上
三种数的顺序因此是：缓存命中（用量）→ 稳定前缀（估算，任务 C）→ 分叉（字节）。
稳定前缀那一行讲的是「这一条请求本身留下多少可复用」，分叉这一行讲的是「这一条和
上一条实际在哪里分开」——一个是这次装配的形状，一个是两次装配的差，所以估算那一行
在上、字节这一行在下。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `ContextMeter.tsx` 容量卡底部新增一行 | 「与上一条请求在 X% 处分叉 · 落在〈条目〉」。它是个按钮（点开进提示词面板看逐条目的标记），但**不做成按钮的样子**——一句点线下划线的话。逐字节相同时换一句说清楚（这在实测里罕见，但重生成本该是这个结果，说出来才看得出它没发生）。没有可比的上一条请求时**整行不出现**：第一轮、以及留痕关掉时都是这个状态，写一句「无可比对象」是在讲仪器，而读者在看的是自己的提示词 | `divergenceLine divergenceIdentical divergenceNone divergenceOpen` |
| `PromptPanel.tsx` 分叉块 | 与上一条请求相比：上界（这些字节里有多少本可以由缓存供出）与提供方实际给了多少，**并排一行**。两者都在同一句里，因为它们的差额才是判据——「我们抖了」和「提供方没给」是相反的两种毛病，单看任一个数都分不出来。这一句用中性色而不是警告色：这里没有出错，这是一次测量 | `divergenceHeading divergenceCeiling divergenceServed divergenceUnreported divergenceShortfall` |
| `PromptPanel.tsx` 三条「不算毛病」的免责 | DeepSeek 的三个文档事实各自都足以解释一次未命中：前缀要被看到两次才落盘（所以本会话前两条请求必然不中）、条目寿命几小时到几天、缓存只属于一个模型。把它们**先说出来**，否则报告开头就是三条假警报，读者的注意力在真正那一条之前就用完了 | `divergenceColdStart divergenceStale divergenceRoute` |
| `PromptPanel.tsx` 四项拆分 | 「N 字节命不中：新增 / 改写 / 逐字未变却落在前缀之后 / 框架」。四项**加起来正好等于总数**——`CACHE-PREFIX.md` §1.2 当初只拆两项，余下几百字节没有交代，读者会以为那是四舍五入，而这里没有四舍五入 | `divergenceSplit` |
| `PromptPanel.tsx` 逐条目标记 | 未变 / 改写 / 新增 / 消失，贴在条目名字旁边（不是新开一列：它修饰的是名字，而不是那一列估算 token）。「逐字未变，仍整段重发」是**另一种标记**，虽然状态同为「未变」——实测这一种占爱衣九对相邻轮里五对损失的 51%–76%，是全产品最大的一笔可挽回开销，而只问「什么变了」的账把这一段判成无辜 | `divergenceStateSame divergenceStateChanged divergenceStateAdded divergenceStateGone divergenceStranded divergenceBytes divergenceFloor` |
| `PromptPanel.tsx` 归因不确定 | 偏移是准的、落在哪一段不准。卡的 EJS 模板在装配记下段落之后改写了系统段，边界就真的不知道了——这时候说出来，是「只怀疑这一行」和「怀疑整台仪器」的区别 | `divergenceUnattributed` |

任务（胶囊进度条 + 窗口来源，`dev/context-pill-bar`）追加：

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `ContextMeter.tsx` 窗口来源四句 | 这一任务的全部要点。实测本机：`settings.json` 的 `/global/contextWindow` 是 2 000 000，而 `/global/model` 是 `deepseek-v4-flash`——DeepSeek 官方文档写它 1M。窗口一直印在容量卡上，**是谁定的** 从来没有印过。四句而不是一句，因为对读者来说是四个不同的下一步：换模型或解锁（按模型夹住）、改数字（来自设置或预设）、重新考虑一个已经做过的决定（未夹）、根本没人设过（宿主默认）。每句都把数字带上，所以在 hover 里单独出现也读得通 | `contextWindowFromModel contextWindowFromSettings contextWindowUnlocked contextWindowFromHost` |
| `SettingsDrawer.tsx` 解锁开关 | ST 的 `max_context_unlocked`（`openai.js:308`）。放在窗口滑杆**旁边**而不是别处，因为它是同一个决定的另一半：不开时上面那个数字会被夹到「模型已知能接受的长度」。注里点名 ST 的那句原话（「解锁上下文长度」），因为用这个功能的人是从 ST 过来的，认那个词 | `contextUnlocked contextUnlockedNote` |

复用而没有新增：胶囊的 hover 把两条已有的键（`contextCardFigures`，加 `contextFromRecord`/`contextFromPreview` 之一）与本任务新增的窗口来源句接起来，各用 ` · ` 分隔。**没有** 为 hover 造一条模板键——那会是同一批数字的第二套排版，而排版差异正是两个面互相对不上的来由。`contextPillTitle`（「看上下文窗口被什么占满了」）现在只在「一次都没测过」时出现，那时它是唯一还成立的说法。

**容量卡上的行序补一句（接上面「分叉仪器」那一节定的三种数）：** 窗口来源这一行排在
**分叉之后**，是四行里的最后一行。上面三行讲的都是「这一条请求」——提供方缓存给了多少
（用量）、这份装配留下多少可复用（估算）、这一条和上一条在哪里分开（字节）；窗口来源
讲的是**这个会话**，读者再发一轮它也不会变，所以它和「为回复留出」同属一类，排在会随
每轮变动的三行之下。「第 N 回实测 / 下一条请求的预览」仍在最末，因为那句讲的是**这份
读数**本身，既不属于请求也不属于会话。

任务（卡脚本生成进用量记录，`dev/side-generation-usage`）追加：

卡自己的脚本能发起一次生成（`TavernHelper.generate` / `generateRaw`）。它和一次回合
一样被提供方计费、走同一条路由，却不产生任何回复——MVU 每轮都会发一次，所以在那类卡上
它大约是账单的一半。口径定在一句话上：**这些请求算进每个合计里，份额单独报出来。**
算进去，因为不算就不是账单；单独报，因为读者看到的数字比他能数到的回复大一倍时得能解释它。
措辞在两本词典里都用「其中」/「of which」，正是为了让人不去把两个数相加。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `UsagePanel.tsx` 指标切换新增第五项 | 「卡脚本」。不是把每条折线按来源拆成两条：那样每个模型会画出两条线，而以模型名为键的图例分不开它们，配色还要多一根轴，只想看总量的读者要在两倍的线里找。作为一个指标它复用整套机械（同一批桶、同一批系列、同一个图例），切换本身就说明了屏幕上是哪个读数。排在**最后**，因为它是「总量」的子集，不是第五种切法 | `usageMetricScript` |
| `UsagePanel.tsx` 合计卡下的一行 | 「其中卡脚本请求 N 次 · X token」。一行而不是第八张胶囊：它不是把总量再分一次，而是关于紧贴在它上面那个数字的一句话。悬停那句解释这些请求是什么、以及本页每个数字都已把它们算在内。宿主没报这一份时**整行不出现**——在不跑卡脚本的 profile 上写「其中卡脚本 0 次」，是一行读者学会跳过的字 | `usageScriptShare usageScriptBasis` |
| `UsagePanel.tsx` 每对话小计新增一列 | 「卡脚本 N 次 · X tok」。`tok` 这个单位不能省，和上一行同一个理由：一个跟在「次数」后面的裸数字会被读成第二个次数。没有卡脚本生成的对话这一格**留空，不写 0**：一列里的一个空格说「不是这条」，一整列 0 说这个功能没加载出来。自己一列而不是塞进总量那一格，因为一格里两个数会被读成一次减法，而方向要读者猜 | `usageScriptCell` |
| `Composer.tsx` 用量行的悬浮卡 | 可见那一行仍是**本对话累计计费**、把卡脚本请求算在内（不算就和账单不符）；拆分不写进 `title`——`title` 已随悬浮卡落地删除（`UsagePopover`）——而是作为那张卡行下的一句**注脚**：那一行是单行截断的，第四组正是会被截掉的一组，注脚因此不是第四组。宿主没报这一份时注脚整句不渲染 | （`usageScriptShare` 复用） |

任务（compaction 摘要请求进用量记录，`dev/host-accounting-gaps`）追加：

会话太大时，Iris 自己会请模型把较早的历史折成一段摘要（`/compact`，或可用预算 80%
的自动触发）。这一条请求同样被计费、同样走这条对话的路由、同样不产生任何回复——
每次 compaction 一条，所以它不像卡脚本那样按回合翻倍，量不大。它值得一个数字的理由
不是量，而是**它是 Iris 自己发的**：一个从不跑卡脚本的 profile 上也有它，而在
`DEVIATIONS.md`（host）§55 之前，一个压缩过的 profile 每次 compaction 少算一条，
页面上也没有任何数字说少了什么。

口径沿用上面那一句（算进合计、份额单独报），新增的只有一条**不合并**的决定：
卡的花费是卡作者的决定，compaction 的是 Iris 自己的策略——想少花前者的人去改卡，
想少花后者的人去改阈值。一个盖住两者的数字两个问题都答不了。所以两句话并列，
措辞同样是「其中」/「of which」。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `UsagePanel.tsx` 合计卡下那一行的**第二句** | 「其中压缩摘要 N 次 · X token」。同一行里的第二句，不是第二行：注脚是合计卡下的一条细线块，再画一条细线会把同一级别的两个事实分出高下。行内每句各自一个 `<span>`、各自一句悬停解释（两者的解释不同，而 `title` 只属于一个元素），`.iris-usage__hero-note` 因此改成纵向 flex——**这也是为什么没有分隔符字符串**：行内排会连成一句，而一个标点连接词既要按语言翻译，又会落在两个自己内部已经用 `·` 的短句之间。宿主没报这一份时这一句不出现 | `usageCompactionShare usageCompactionBasis` |
| `UsagePanel.tsx` 每对话小计**共用卡脚本那一格** | 「压缩摘要 N 次 · X tok」，叠在卡脚本那行下面，右对齐到总量列。不是第六列：一列只在压缩过的那几行有值，却要在每一行都从标题那里拿走宽度去说「无」，而这两个事实回答的是同一个问题——这一行里有多少不是回复。两份都没有的对话这一格**仍然留空，不写 0** | `usageCompactionCell` |
| `Composer.tsx` 用量行悬浮卡的注脚 | 第二段。`UsagePopover` 的 `note?: string` 改成 `notes?: readonly string[]`，一段一句，理由和上面拒绝分隔符相同：两份份额是**各自独立缺席**的——一个 profile 可以跑卡脚本却从不压缩，也可以压缩却不跑卡脚本，所以一个字符串就得带一个按语言拼的分隔符。四种组合都在 `token-format.test.ts` 里 | （`usageCompactionShare` 复用） |

**没有第六个图表指标，这是决定而不是遗漏。** §70 给卡脚本加了第五个指标，
因为那一份随时间有形状可读（在 MVU 上它跟着回合数走）。compaction 这一份没有：
每次 compaction 一条，画出来是一条贴着零、偶尔一根尖的线，而读者真想要的那个数
（「这个总量里有多少是宿主在折我的历史」）就是合计卡上那一句，不用切模式。
所以指标切换仍是五项，`check:render` 钉的是**选项个数**而不是某个标题不存在——
第六个指标无论为什么出现，都该重新走一遍这一段。

任务（接上 ST 正则的第三档：预设内嵌正则，`dev/preset-regex-tier`）追加：

ST 三档按声明顺序跑 global → **preset** → scoped（`extensions/regex/engine.js:11-16`，
`:99`），预设那一档读活跃预设文件自己的 `extensions.regex_scripts`（`:126`），
并且**有闸门**：预设名必须在 `extension_settings.preset_allowed_regex[api]` 里（`:126-128`）。
Iris 此前只有两档，而切进来的预设 body 一直是整份存着的——输入一直在盘上，没人读。
实测那一份预设（§47）**40 条，18 条启用：6 条改请求、12 条只改显示**，还有 2 条是空
`findRegex` 的分隔条。所以这一节的文案有一件别的正则面板没有的任务：**它在什么都不跑的
状态下也要把自己解释清楚**——默认关就是这一档的常态，不是异常。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `PresetRegexPanel.tsx` | 预设自带的正则那一档，位置在全局档与卡自带档**之间**——因为那是它运行的位置（ST 的 `SCRIPT_TYPES` 迭代顺序），而三节连读时读者比较的正是「谁的改写压过谁」这条轴。摘要分两句：允许时报「N 条，M 条在跑」，未允许时报「N 条，未启用」——**被拒绝的一档仍然整份列出来**（ST 自己也列，`getRegexScripts` 默认 `allowedOnly: false`），空清单会被读成「这份预设没带正则」，而这一档默认就是关的，那句话会是绝大多数读者看到的第一句 | `sectionPresetRegex presetRegexSummary presetRegexRefusedSummary presetRegexNote` |
| `PresetRegexPanel.tsx` 允许开关 | ST 的 `preset_allowed_regex`。拒绝那一句把代价与**上游的同一要求**一起说出来：预设是一份被到处传的设置文件，而这里有些规则改的是送给模型的文本、不只是你读到的——所以要等你点头；ST 也是同样的要求，预设名进了白名单它自带的正则才会跑。把 ST 的要求写进去是因为「默认关」很容易被读成功能坏了，而读者一旦这样读就会一路点过去 | `presetRegexAllowLabel presetRegexAllowedNote presetRegexRefusedNote presetRegexAllow presetRegexRefuse` |
| `PresetRegexPanel.tsx` 三个行内标注 | 预设作者关掉的 / 没有标识不能开关（复用 `scopedRegexUnaddressable`）/ **等上面那个开关**。第三个是卡那一节没有的状态：整档被拒绝时单条仍然可以先设好，那一行报的是「如果允许就会跑」而不是「正在跑」，所以要标出来，否则那个勾选框在说谎 | `presetRegexOffByPreset presetRegexHeldBack` |
| `PresetRegexPanel.tsx` 跳过的行 | 「还有 N 条不是规则——没有查找式，或者查找式是空的」。空查找式不是无害的空转：`new RegExp('')` 在每一个位置都匹配，跑一条就会把替换文本插进每条消息的每个字符之间。这一句是「这份预设有 38 条」与真相之间的差别，所以数目上报到面板（持久渠道），宿主日志再按预设名与数目去重报一次 | `presetRegexMalformed` |
| `PresetRegexPanel.tsx` 没有库内名称时 | 白名单按预设名登记，而本机可以处在上游表示不出来的状态：跑的是 composition 配置里的那份预设文件，它没有库内名称。这时**整个允许开关不渲染**，只留这一句并给出出路（先另存进预设库）——一个禁用的开关会被读成功能坏了，而这里那句话本身就是控件 | `presetRegexUnnamed` |

任务（连接面按 CC Switch 重做，`dev/connection-providers`）追加：

用户的裁定（2026-09-09，原话）：「这个部分不必效仿 ST 做，ST 那个就做的很抽象了，
我们可以按照 CC Switch 的逻辑：我们保存供应商是一回事，从列表中用哪个连接是一回事；
连接折叠卡中就不需要有提供方/端点地址/模型这三个选项常驻了」。词典层因此有一条总原则：
**「保存」和「使用」是两个动词，两套句子，不共用一个词。** 旧词典里 `saveConnection`
（把当前设置存为一个连接）与 `activateForDefaults` / `activateForThisChat`（启用）
并排放着，读者要从两句里推出它们改的是不同的东西；现在一句话直接说出来
（`connSaveVsUse`），两个动词各有自己的按钮键。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `ConnectionPanel.tsx` 三块的骨架 | 唯一的分区标题（供应商）与「添加供应商」按钮。第二、三块各自只是一个按钮，所以没有标题键——一个标题下面只有一个同名按钮，是同一句话印两遍 | `connBlockProviders connAddProvider` |
| `ConnectionPanel.tsx` 行上的标记 | 「当前」与「只读」。**词而不是圆点或颜色**：哪一行在生成是这一面最要紧的一个事实，一个要先学会的颜色不算报告 | `connCurrent connReadOnly` |
| `ConnectionPanel.tsx` 行上的四个动作 | 「使用」的可见文案，加使用/编辑/测试三条带名字的 aria（删除沿用已有的 `deleteNamed`）。aria 带名字，因为一列里四个「测试」对读屏软件是四个同名按钮 | `connUse connUseNamed connEditNamed connTestNamed` |
| `ConnectionPanel.tsx` 行上的密钥状态 | 四种：已保存＋末四位／已保存但太短不给尾号／由宿主环境提供（同源，所以不填也能跑）／无密钥。第三种是必须说的：只看文件会写成「无密钥」，而那一行其实测得通 | `connKeySaved connKeySavedNoTail connKeyFromHost connKeyNone` |
| `ConnectionPanel.tsx` 行上的展示信息 | 窗口大小、上次探测（N 个模型 · 探测于…）。**只用已有数据**：`modelContexts` 与 `modelsProbedAt` 是宿主已经记下的，没人记过的那一格整个不出现，不写「未知」 | `connModelWindow connProbedAt` |
| `ConnectionPanel.tsx` 两个动词的说明 | 「保存 ≠ 使用」那一句，以及「使用是全局切换、要只改一个对话请点输入框下方的模型名」。第二句是这次改动的必要配文：`connection.activate` 从此不再带 `chatId`，而对话级切换一直在别处 | `connSaveVsUse connUseNote` |
| `ConnectionPanel.tsx` 测试块 | 「测试当前供应商」按钮、行上测试报回来时的前缀「测试的是「X」」、没有端点可探时的那一句。判定句只有一处：屏幕上同时两个判定，是对同一个问题的两个答案 | `connTestCurrent connTestedRow connTestNeedsEndpoint` |
| `ConnectionPanel.tsx` 保存与删除之后 | 已保存（在上方列表里，点「使用」才生效）／已保存并重新应用（改的就是当前那一行）／已删除／已删除且它原是当前（当前回到宿主环境）。**删除那句只说列表**，不说路由：设置层里还留着什么是宿主那侧的事（`dev/route-resolution`），这里不替它宣布 | `connSavedNote connSavedCurrent connDeleted connDeletedWasCurrent` |
| `ConnectionPanel.tsx` 编辑器 | 标题（编辑供应商；新增时复用 `connAddProvider`）、名字与它的占位、绑定预设三句（选项「不绑定预设」、说明、预设库还没读到时退回手填）。绑定预设照模型字段的三态办：能读到库就是 `<select>`，读不到就手填并说明——一个不存在的预设名是一次悄悄没发生的切换 | `connEditorEditTitle connProviderName connProviderNamePlaceholder connBoundPreset connBoundPresetNone connBoundPresetNote connPresetsUnknown` |
| `ConnectionPanel.tsx` 模型不在列表里 | 编辑器里当场标一句。已有的 `modelNotInList`（保存之后那句「已照常保存」）留着——两句讲的是同一处不一致的两个时刻，一个还能改，一个已经落盘 | `modelOffListNote` |
| `ConnectionPanel.tsx` 宿主环境那一行 | 标题从「宿主默认（只读）」改成「宿主环境」（「只读」移进徽标）；「存为连接」改成「存为供应商」。说明句现在说的是「启动时配置的路由与模型，点使用即可把全局路由放回它」——这一行如今有「使用」，复用行上的 `connUse` / `connUseNamed`，所以原先那句解释「为什么没有使用按钮」的 `connHostUseGap` 一并删掉（web §78） | `hostDefaultTitle hostDefaultNote adoptHostConnection hostAdopted` |

**删掉的键（12 个）。** 连接面这 8 个：`activateForDefaults` `activateForThisChat`
（启用的两句话——启用从此只有全局一种，两句合成 `connUseNote` 一句）、
`nameThisConnection` `connectionName` `saveConnection`（「把当前设置存为一个连接」
整块拿掉：面板只剩三块，命名输入进了编辑器的名字字段）、`savedTakesEffect`（原文写
「在下方点选该连接即可启用」，而列表已经在上方，改叫 `connSavedNote`）、
`modelsListLabel` `testKeyNone`（这两个在这次改动之前就已经没有调用者，顺手清掉）。
「路由」卡这 4 个：`sectionRoute` `provider` `model` `modelPlaceholder`——那张卡是
`provider` 与 `model` 两个自由文本框，是设置全局层上的**第三个**改路由的地方，也是三者
里唯一一个接受手打字符串而无从校验的。**`i18n.test.ts` 查的是「源码里用到的键必须在词典里」
这一个方向**，不查反向，所以未用键从来不会被它发现——这也是 `modelsListLabel` 与
`testKeyNone` 能一直留着的原因，删键这件事得靠人做。

**再删掉一个键（`connHostUseGap`，web §78）。** 它整句话都是在解释宿主环境那一行为什么
不能被选回——而那个限制在宿主侧（启动路由的快照 + `ConnectionStore.clearActive`，host §60）
补上之后就不存在了。一句解释某个缺口的文案，在缺口填掉之后就是一句错话，比没有更糟；
同一个方向上 `hostDefaultNote` 也从「在没有选中任何供应商时由它生成」改成了正面的说明。

**没有为「名字 · 模型」造模板键。** 折叠卡头是两段各自已经存在的数据用 ` · ` 接起来，
和容量胶囊的 hover 同一个理由：一条只有分隔符的模板键会在两本词典里各存一份排版，
而排版差异正是两个面互相对不上的来由。

任务（输入区按参考图重做，`dev/composer-redesign`）追加：

用户的要求（2026-09-10，原话）：「按照图片重新设计对话框并在配色上和本系统保持一致」。
图里的输入框是一张大圆角卡片：上半留白只放占位文字，底边一行——左边一个圆形「+」和一个
下拉，右边模型名＋灰色的努力度＋箭头、一个细圆环、一个实心圆形发送键。词典层因此有两条
原则：

**一、只有两个控件带字，其余是记号。** 底栏原先是三个胶囊（提示词 · 预设名 / 模型 /
上下文 30.1K/128K · 24%），三条都在印字。现在带字的只有预设与模型，容量成了圆环、发送
成了圆盘、「+」是一个十字——所以这三个的**名字全在 `aria-label` 里**，键还是原来的
`send` / `stop`，另加 `composerMore`。一个 32px 的圆里塞不进「发送」两个字，塞进去要么
溢出要么小到没人认得；而一个没有名字的图形按钮，读屏软件念出来就是「按钮」。

**二、作用范围要写出来，因为并排的两个控件不一样。** 模型只改这一段对话（`setChatModel`，
一直如此），预设是宿主自己的活动预设（`preset.select`），一切换所有对话都跟着变。读者
从左边那个控件学到的范围，套到右边就是错的，所以预设菜单底下有一句 `presetGlobalNote`。

| 来源 | 内容 | 键 |
| --- | --- | --- |
| `Composer.tsx` 底栏「+」 | 圆钮的 `aria-label`（也是菜单自己的名字）与菜单里的第二行「斜杠命令」。第一行复用 `promptButton`——它开的还是原来那张提示词逐项面板 | `composerMore composerSlash` |
| `Composer.tsx` 底栏预设控件 | 菜单标题、控件的 hover（切换预设＋当前是谁）、两种「没有」（宿主拒绝 `preset.list`＝根本没有预设库／有库但一个都没存过）、作用范围那一句。没有预设时控件本身印 `presetNoneActive`（沿用设置面已有的键，同一句话不造第二份） | `presetMenuHead presetMenuOpen presetLibraryAbsent presetLibraryEmpty presetGlobalNote` |
| `Composer.tsx` 模型控件里的努力度 | 没有新键：菜单里那一节的标题复用设置抽屉的 `reasoningEffort`，六个选项是 `auto min low medium high max` 六个**不翻译的原词**（上游 `reasoning_effort_types`，它们是请求字段的值，见第二节「刻意不翻译」）。`auto` 只在菜单里出现，胶囊上不印——它不增加任何事实，请求里两种情况都不带 `reasoning_effort` | — |

**没有删键。** 这一次没有任何键失去调用者：提示词钮从胶囊搬进「+」菜单，`promptButton`
照旧；`composerHint` 照旧（搬到卡片外那一行，窄屏 880px 以下整行 CSS 隐藏，键还在）；
容量胶囊的 `contextPill` / `contextPillCapacity` 也照旧——圆环把它们从可见文字变成了
`aria-label`，这是同一句话换了个位置，不是换了句话。这一点是手工核对的：`i18n.test.ts`
只查「源码用到的键必须在词典里」这一个方向，未用键它从来不会发现。

**没有为「模型名＋努力度」造模板键。** 两段各自已有的数据在一行里并排，和折叠卡头
「名字 · 模型」同一个理由：一条只有排版的模板键会在两本词典里各存一份，而排版差异正是
两个面互相对不上的来由。这里连分隔符都没有——中间是控件自己 5px 的 flex gap。
