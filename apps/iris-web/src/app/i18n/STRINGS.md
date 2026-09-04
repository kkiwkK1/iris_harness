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

规模：词典 `en` 约 **200 条**（含复数/变体拆分），`zh` 与其逐键对应。

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
- **dev-only 探针**（`SandboxProbe.tsx` / `RailPreview.tsx`，`import.meta.env.DEV`
  门控，生产包中被摇树剔除）——开发工具，保持英文。

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

## 四、持久化决策（同 `language.ts` 文档）

`localStorage` 键 `iris.language`，与 `iris.theme` / `iris.reading` 同一处、同一套
safeRead/safeWrite 容错。理由：`SETTINGS-IA.md` 把「屏幕上有什么」类偏好（主题/字号/
行长）标为 界面本地 🟢，语言属于同一意图；宿主 `settings.*` 是生成路由，且按对话生效，
放语言会把 per-device 的选择做歪。默认跟随 `navigator.language`（`zh*` → 中文），
仅当用户手动切换才落盘——不选不存，换设备仍可各自作答。
