# U4 施工文档 · 生成钩子：先设计，不写代码

> 状态：已归档（2026-09-17）。工作已全部落地：#102（五条裁决，设计已定）。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

本文件是 `notes/INFRA-TASKS-2026-09-15.md` 里 **U4** 那一节的施工文档。U4 的交付物本身是一份设计稿（`docs/GENERATION-HOOKS.md`），所以本文件是**写那份设计稿的任务书**：它把现状清单先替设计者做完（第 2 节），把协调人已经定死的约束抄成不可再议的形式（第 3 节），把设计稿必须明确回答的问题编号列出（第 4 节），并写清协调人会怎么判这份稿子（第 6 节）。

本文件里每一条关于代码的陈述都带 `path:line`，行号是 `269a97e` 的证据；定位以符号名为准。设计者动笔前请先按第 2 节末尾的「怎么复算这张表」把清单重跑一遍——如果复算的结果和本文件不一致，**代码赢**，并把差异写进设计稿的第一段。

---

## 1. 任务身份

| 项 | 值 |
| --- | --- |
| 分支 | `dev/generation-hooks-design` |
| 产物 | `docs/GENERATION-HOOKS.md`（新建，中文） |
| ledger | **无**。U4 不改产品代码，没有偏离要记 |
| 基线 | `main` `269a97e`（任务单自己写的基线是 `e03adbb`，本批六张单发布时 main 已前进到 `269a97e`，只多了任务单和 §8 那一行文档改动，代码同一份） |
| 预计篇幅 | 任务单要求 250–400 行；本文件第 2 节的清单比任务单预估的大（24 个固定点而不是任务单点名的 3 处），设计稿把它抄进去后落在 **300–420 行**是正常的，超出 400 行不算超标，但要靠清单撑着，不靠散文 |
| 不许碰的东西 | 任何 `.ts`、任何 `package.json`、任何测试。U4 只加一个 `.md` 文件 |
| 门禁 | `node --test apps/iris/tests/md-references.test.ts`。注意该测试会检查 `.md` 里的 `path:line` 引用指向的文件**存在**（`apps/iris/tests/md-references.test.ts:113` 起的那条测试，且它**不剥反引号**），所以设计稿里**不要**给 `docs/GENERATION-HOOKS.md` 自己配带行号的引用——那个文件在跑测试时还不在 `git ls-files` 的结果里，一写就红。本文件自己在这条上踩过一次 |

### 1.1 动笔前必读

按这个顺序读，读完再写。括号里是「为什么要读它」，不是摘要——摘要在第 2 节，读原文是为了在摘要错的时候能发现。

1. `notes/INFRA-TASKS-2026-09-15.md` 的 §0、§1 与 U4 节（本文件的上游；§1 的并行性表格说明 U4 与谁重叠：无）。
2. `packages/iris-app-service/src/service.ts` 的 `#generate` 尾段（`packages/iris-app-service/src/service.ts:4940`–`:5095`）与 `#settle`（`packages/iris-app-service/src/service.ts:5122`–`:5290`）——两段合起来就是「一轮生成」。
3. `packages/iris-app-service/src/service.ts:6364`–`:6511`：ST 平面的三个调用（`#stCompatContext`/`#expandContributionsViaStCompat`/`#processReplyViaStCompat`），今天唯一一处「宿主在生成中途去问一个外部参与者」的既有实现，含 deadline 与失败处理。
4. `packages/iris-app-service/src/entry.ts` 的 `substitute` getter（`packages/iris-app-service/src/entry.ts:694`–`:788`）与 `computeVariables`（`packages/iris-app-service/src/entry.ts:1084`–`:1107`）。
5. `packages/iris-app-service/src/system-plugins.ts` 的 `lease`（`packages/iris-app-service/src/system-plugins.ts:637`）、`markFailure`（`packages/iris-app-service/src/system-plugins.ts:423`）、`#enableOrder`（`packages/iris-app-service/src/system-plugins.ts:1018`）、`#drain`（`packages/iris-app-service/src/system-plugins.ts:1064`）、`#commit`（`packages/iris-app-service/src/system-plugins.ts:1072`）。
6. `packages/iris-plugin-api/src/index.ts` 全文（159 行，`scope` 与 `lease` 的契约）。
7. `packages/iris-protocol/src/system-plugins.ts:20`–`:44`（六个失败态及其分组注释）。
8. `packages/iris-app-service/src/variable-arbitration.ts`（模块头 + `arbitrateMessageVariables`）与 `notes/packages/iris-app-service/DEVIATIONS.md` §76（为什么是「提案 + 一次提交」而不是「两次写」）。
9. `docs/SYSTEM-PLUGINS.md` 的「Compatibility boundaries」与「Not yet built」两节，`docs/INFRASTRUCTURE-INTERFACES.md` §6 与 §8。
10. `notes/PLUGIN-FEASIBILITY.md` §3 与 §6——**带着怀疑读**，它的行号已经漂了（前提纠正 E）。

---

## 2. 前提纠正与现状清单

### 2.1 前提纠正

任务单 U4 节写「`service.ts` 的 `#processReplyViaStCompat` 约 `:6470`、结算段约 `:5006`–`:5069`」。逐条核对：

| # | 任务单/文档的说法 | 代码今天 | 性质 |
| --- | --- | --- | --- |
| A | `#processReplyViaStCompat` 约 `:6470` | **成立**。定义在 `packages/iris-app-service/src/service.ts:6470`，调用点在 `packages/iris-app-service/src/service.ts:5169` | 前提正确，补一个调用点 |
| B | 「结算段约 `:5006`–`:5069`」 | **把两个不同的地方合成了一段**。`packages/iris-app-service/src/service.ts:5006`–`:5024` 是**一轮生成开场**取 lease 的地方（`isEnabled` + `lease` + `capability`），发生在 driver 被调用**之前**；`:5069` 是 `#settle` 的**调用**；真正的结算体是 `#settle`，定义在 `packages/iris-app-service/src/service.ts:5122`，仲裁在 `packages/iris-app-service/src/service.ts:5203`。设计稿要把「开场取 lease」和「结算」当两个阶段写 | 前提需拆分 |
| C | U2 节写 `plugins.lease('tavern-helper')` 约 `:5006`/`:5014` | `:5006` 与 `:5014` 是两条 `isEnabled` 判断，`lease` 在 `packages/iris-app-service/src/service.ts:5007` 与 `packages/iris-app-service/src/service.ts:5015` | 差一行 |
| D | `docs/INFRASTRUCTURE-INTERFACES.md` §6 写「结算只有一处：`service.ts:5148` 的 `arbitrateMessageVariables`，两个提案分别标 `:5119` 与 `:5142`」，§8「插件可写变量」行同样引 `:5119`/`:5142` | 今天是 `packages/iris-app-service/src/service.ts:5203`（仲裁）、`packages/iris-app-service/src/service.ts:5174`（`prompt-template` 提案）、`packages/iris-app-service/src/service.ts:5197`（`mvu` 提案）、`packages/iris-app-service/src/service.ts:5207`（冲突上报） | 文档行号已漂移 55–60 行；**U4 不修它**（改文档是 U2 的 §8 行），但设计稿引用时要引今天的行号 |
| E | `notes/PLUGIN-FEASIBILITY.md:116` 写调用点是「`entry.ts:747`（宏遍）、`service.ts:4877`（`#settle`）」 | 今天是 `packages/iris-app-service/src/entry.ts:761`（TH capability 取用）与 `packages/iris-app-service/src/service.ts:5122`（`#settle` 定义） | 同上，行号漂移，设计稿不要照抄 |
| F | `docs/INFRASTRUCTURE-INTERFACES.md:340` 的缺口行标题是「生成钩子（`AppServiceOptions`）」 | 协调人的约束把注册口定在 `scope.hooks.<name>(fn)`，即 `packages/iris-plugin-api/src/index.ts:95` 的 `SystemPluginActivationScope`，**不是** `packages/iris-app-service/src/service.ts:491` 的 `AppServiceOptions`。`AppServiceOptions` 是宿主组合根注入依赖的地方，插件够不着 | §8 行的括号点错了面；设计稿要在「与 §8 的关系」里说明，U4 合入后由协调人改那一行 |
| G | `notes/PLUGIN-FEASIBILITY.md:116` 说生成钩子「Cordis 已给 `ctx.on` / `ctx.emit`」 | `grep -rn "\.emit(\|ctx.on(\|context.on(" packages/iris-app-service/src/` **零命中**。Cordis 有事件总线是 Cordis 的事实，宿主今天一条事件都不发、一条都不收 | 「已给」是框架能力不是本仓现状；这是第 8 节否决「钩子做成 Cordis 事件」的实证之一 |
| H | U2 的裁决说「复用 PR-2 的 `failure` 字段加一个新状态 `hook-failed`」，且「结算继续，不阻塞回复」 | 写 `failure` 的唯一入口 `markFailure`（`packages/iris-app-service/src/system-plugins.ts:423`）会同时 `plugin.enabled = false`、`plugin.status = 'error'`（`packages/iris-app-service/src/system-plugins.ts:426`–`:427`），它的 docblock 第一句就是「Put a named failure on a row **and stop it running**」（`packages/iris-app-service/src/system-plugins.ts:416`）。一个「不阻塞、下一轮还要继续调用」的 `hook-failed` **不能原样走这个方法** | **代码与裁决的字面读法冲突**，是设计稿必须回答的问题（Q5） |
| I | U2/U4 都写「顺序 = 激活顺序（依赖先于依赖者，同层按 id 字典序）」 | 「激活顺序」今天**不是一个可读出来的量**。`#enableOrder`（`packages/iris-app-service/src/system-plugins.ts:1018`）是每次 enable 现算的 DFS，同层顺序取的是定义里 `dependencies` 数组的声明序，**没有字典序**；启动时的外层循环按 `#plugins` Map 的插入序遍历（`packages/iris-app-service/src/system-plugins.ts:511`–`:521`）；`Activation`（`packages/iris-app-service/src/system-plugins.ts:136`）只有 `fiber`/`incarnation`/`revision`，**没有全局激活序号** | 「同层按 id 字典序」是**要造的规则**，不是要观察的现状；这是最大的一个设计问题（Q12），且与 U2 共用 |
| J | —— | `#failures` 不持久化（`packages/iris-app-service/src/system-plugins.ts:252`–`:257`），且任何一次 committed transition 都会把它删掉（`packages/iris-app-service/src/system-plugins.ts:1104`） | 一条 `hook-failed` 会在下一次 enable/disable 时消失。是有意还是要改，设计稿要表态（Q5） |
| K | U2 说 impersonate 时 MVU 不写「现在是 `!impersonating` 分支」 | 成立，但分支在**开场**（`packages/iris-app-service/src/service.ts:5014`），不在结算里：impersonate 时 `mvuExecution` 保持 `null`，`#settle` 收到 `mvu: null`，`computeVariables` 在 `packages/iris-app-service/src/entry.ts:1091` 直接返回 `undefined` | 钩子若也要按 kind 过滤，过滤点在**开场**还是在**钩子自己看 view**，要定（Q6） |

### 2.2 一轮生成里每一个固定调用点

阶段按一轮 `send` 的时间顺序排。「谁被点名」一列里「—」表示这一步今天不点名任何插件，列进来是因为它是钩子的**上下游边界**，设计稿必须说明钩子落在它之前还是之后。所有路径前缀省略时均为 `packages/iris-app-service/src/`。

| # | 阶段 | 符号 | `path:line` | 谁被点名 | 输入（读什么） | 输出（写/返回什么） | 失败时今天怎样 | 能否映射到三个钩子 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | prompt build | `ChatEntry.substitute` → `tavernHelperCapability(...)` | `packages/iris-app-service/src/entry.ts:761` | **TH**（`macro-expander`） | 已经过 ST 原生宏展开的文本 + 三个变量域：message（`baselineFor`，`packages/iris-app-service/src/entry.ts:776`）、chat、global | 返回展开后的文本；副作用只有 `unsupportedScopes.add`（`packages/iris-app-service/src/entry.ts:783`） | capability 取不到 → 原样返回（`packages/iris-app-service/src/entry.ts:762`）；`expandMacros` 抛错**无捕获**，沿 `substitute` 冒到调用者 | **不能**。它在每个 contribution、每条历史行上各调一次，粒度是「一段文本」，不是「一份 prompt」；`beforePrompt` 的位置比它晚 |
| 2 | prompt build | `#rawHistory` → `runScripts(..., isPrompt: true)` | `packages/iris-app-service/src/service.ts:6286` | —（regex 层） | 每条历史行的文本、role、depth | 返回改写后的历史行 | `runScripts` 自身吞掉单条脚本错误 | 不映射。是 TH 卡片侧 regex 的宿主实现，不是插件调用 |
| 3 | prompt build | `#contributions` → `buildPrompt` | `packages/iris-app-service/src/service.ts:5500` | — | 卡、世界书、preset、window、persona、`entry.tokenBudget` | `built.contributions: Contribution[]` | —— | 不映射。是 `beforePrompt` 的上游：**钩子拿到的就是这个数组之后的形态** |
| 4 | prompt build | `injectedContributions` | `packages/iris-app-service/src/service.ts:5552` | — | `entry` 的 outlet/extension prompt 桶 | 追加 `Contribution[]` | —— | 不映射。但它是**宿主自己的追加式注入**，`beforePrompt` 的「追加段」提案要和它落在同一表示上 |
| 5 | prompt build | `#expandContributionsViaStCompat`（真实轮） | 调用 `packages/iris-app-service/src/service.ts:5556`，定义 `packages/iris-app-service/src/service.ts:6434` | **ST 扩展平面**（被接纳成系统插件的那个 ST 扩展） | `Contribution[]` 经 `bridgeMessagesFromContributions` + `#stCompatContext` + floors | **就地改写** `contributions`（`packages/iris-app-service/src/service.ts:6458`）**并且**写 chat/global 变量（`packages/iris-app-service/src/service.ts:6463`） | 无 ticket → 静默返回（`packages/iris-app-service/src/service.ts:6453`）；结果非法 → 一条 `prompt/fault` 报告后返回（`packages/iris-app-service/src/service.ts:6460`）；超时靠 `deadlineMs`，常量 `#ST_COMPAT_DEADLINE_MS = 1500`（`packages/iris-app-service/src/service.ts:6364`） | **partly**。位置正是 `beforePrompt`，但今天它 ①就地改写而不是返回提案 ②顺手写变量。两条都和约束相反，设计稿要说明这是「ST 平面保留特权」还是「将来也要收敛」 |
| 6 | prompt build（预览） | `#expandContributionsViaStCompat`（`prompt.itemize` 路径） | `packages/iris-app-service/src/service.ts:5805` | 同上 | 同上 | 同上 | 同上 | **必须表态**：`beforePrompt` 在**只读预览**路径上跑不跑（Q13） |
| 7 | prompt build | `classifyVolatility` / `markCachePhase` / `assemble` | `packages/iris-app-service/src/service.ts:5573`、`packages/iris-app-service/src/service.ts:5584` | — | `Contribution[]` | `AssembleResult` | —— | 不映射。是 `beforePrompt` 的**下游**：提案必须在 `classifyVolatility` 之前落地，否则缓存判定看的是没有提案的那份 |
| 8 | 开场 | `plugins.isEnabled('tavern-helper')` → `plugins.lease(...)` | `packages/iris-app-service/src/service.ts:5006`–`:5007` | **TH** | 只读运行时状态 | 一个 `SystemPluginLease`，整轮持有 | `isEnabled` 假就不取；`lease` 会在插件停用时抛（`packages/iris-app-service/src/system-plugins.ts:638`） | 不映射，**它是钩子的释放机制本身**：钩子的「随 lease 撤销」要复用这一段 |
| 9 | 开场 | `!impersonating && plugins.isEnabled('mvu')` → `lease` + `capability` | `packages/iris-app-service/src/service.ts:5014`–`:5024` | **MVU**（`mvu-engine`） | 运行时状态；`request.kind` | `mvuExecution = { capability, isCurrent }`，带进 `#settle` | 启用但取不到 capability → 释放全部 lease 并抛 `internal`（`packages/iris-app-service/src/service.ts:5017`–`:5021`） | 不映射。但 `!impersonating` 这个 kind 过滤**发生在这里**，先于任何钩子 |
| 10 | 开场 | `releasePluginLeases` | 定义 `packages/iris-app-service/src/service.ts:5026`，调用 `packages/iris-app-service/src/service.ts:5048`/`:5082`/`:5089` | TH+MVU | —— | 倒序释放 | 幂等（`leasesReleased` 闸） | 不映射。钩子的释放语义要落在同一个 `finally` 里 |
| 11 | 流式 | `events.onText` / `onReasoning` | `packages/iris-app-service/src/service.ts:4966`、`packages/iris-app-service/src/service.ts:4970` | — | provider 的增量 | 累加到 `entry.pending.text`，广播 `stream.text` | —— | **不能**。三个钩子里**没有流式挂点**。设计稿要写明这是有意留白（每个 token 调一次钩子会把 5 s 预算变成没有意义的数）还是缺口 |
| 12 | 流式 | `driver.send(..., runScripts(request.text, 'user', ...))` | `packages/iris-app-service/src/service.ts:5039` | —（regex 层） | 用户输入原文 | 入库前改写 | —— | 不映射。是唯一一次「用户消息第一次落库」的改写点，钩子够不着 |
| 13 | 结算入口 | `#settle` | 定义 `packages/iris-app-service/src/service.ts:5122`；调用 `packages/iris-app-service/src/service.ts:5069`（完成）、`packages/iris-app-service/src/service.ts:5340`（impersonate 中止保留）、`packages/iris-app-service/src/service.ts:5375`（中止保留残句） | — | `text`、`reason: 'completed' \| 'aborted'`、`options.mvu` | 整个结算 | 整段在一个 `try` 里，`catch` 走「存不下就是终态事件」路径 | 不映射。**三个入口**意味着 `afterReplyText`/`onSettle` 各要说清在 `aborted` 时跑不跑 |
| 14 | 回复文本 | `trimSentences` → `trimToEndSentence` | `packages/iris-app-service/src/service.ts:5146` | — | `settledText` | 截断后的文本 | —— | 不映射。但它是 `afterReplyText` 的**上游或下游**，必须定（Q1 的一部分） |
| 15 | 回复文本 | `#processReplyViaStCompat` | 调用 `packages/iris-app-service/src/service.ts:5169`，定义 `packages/iris-app-service/src/service.ts:6470` | **ST 扩展平面** | `settledText` + turn + floors + context | ①替换文本（`packages/iris-app-service/src/service.ts:5171`）②`floorVariables` 变成 `pluginId: 'prompt-template'` 的提案（`packages/iris-app-service/src/service.ts:5174`）③它自己**已经**写过 chat/global 变量（`packages/iris-app-service/src/service.ts:6501`） | 同 #5：无 ticket/结果非法 → `undefined`，保留原文；1500 ms deadline | **partly**。文本那一半正是 `afterReplyText`；变量那一半是 U2 的 `propose`；**今天两件事在同一次调用里**，这是 Q4 的核心证据 |
| 16 | 回复文本 | `entry.computeVariables`（MVU） | 调用 `packages/iris-app-service/src/service.ts:5182`，定义 `packages/iris-app-service/src/entry.ts:1084` | **MVU** | turn、`settledText`、`baselineFor(turn)`（`packages/iris-app-service/src/entry.ts:1090`） | `MvuUpdate`；变成 `pluginId: 'mvu'` 的提案（`packages/iris-app-service/src/service.ts:5197`） | 引擎缺席 → `undefined`（`packages/iris-app-service/src/entry.ts:1093`）；`isCurrent()` 假 → 丢弃（`packages/iris-app-service/src/entry.ts:1102`–`:1105`）；`engine.update` **抛错不捕获**，冒到 `#settle` 的 try | **不能**映射到三个钩子里的任何一个——它整个就是 U2 的 `propose`。这是 Q4 的另一半证据 |
| 17 | 结算 | `arbitrateMessageVariables` | 调用 `packages/iris-app-service/src/service.ts:5203`，定义 `packages/iris-app-service/src/variable-arbitration.ts:99` | —（宿主提交边） | `variableBaseline`（`packages/iris-app-service/src/service.ts:5166`）+ 提案数组 | 一次 `replaceVariables`（`packages/iris-app-service/src/service.ts:5204`） | 纯函数 | 不映射。是 U2 的落点 |
| 18 | 结算 | 冲突上报 | `packages/iris-app-service/src/service.ts:5207` | — | `settled.conflicts` | `{ kind: 'variables', grade: 'note' }` | —— | 不映射。但 `hook-failed` 的上报要不要走同一条 `#report` 通道，设计稿要说 |
| 19 | 结算 | `entry.recordUsage` / `entry.recordTiming` | `packages/iris-app-service/src/service.ts:5224`、`packages/iris-app-service/src/service.ts:5233` | — | pending 上的 usage/计时 | 挂到 candidate | —— | 不映射。是 Q11（遥测）的对照物：**每轮已经有两份记账**，钩子耗时要不要成为第三份 |
| 20 | 结算 | `#storeRewritten` → `runScripts(..., 'assistant', ...)` | 调用 `packages/iris-app-service/src/service.ts:5234`，定义 `packages/iris-app-service/src/service.ts:6309`，改写在 `packages/iris-app-service/src/service.ts:6312` | —（chat 的 regex tier） | `generated` 与 `stored` 两份文本 | 可能 `entry.rebuild` 整条 log（`packages/iris-app-service/src/service.ts:6323`） | —— | **partly**。它就坐在 `afterReplyText` 想要的位置上，但它是 regex 层。钩子在它**之前**还是**之后**必须定：之后意味着钩子改的文本不会再过一遍 regex |
| 21 | 结算 | prune / `chats.save` / `stream.end` / `#announceChats` | `packages/iris-app-service/src/service.ts:5258`、`:5263`、`:5267`、`:5270` | — | —— | 落盘与广播 | `save` 失败走 `storage-error` 终态 | `onSettle` 的候选位置。**在 `save` 之前还是之后**决定了钩子看到的是不是已经落盘的事实 |
| 22 | 中止路径 | `#fail` 把 `mvuExecution` 带进 `#settle` | `packages/iris-app-service/src/service.ts:5325`、`packages/iris-app-service/src/service.ts:5380` | MVU | 部分文本 | 同 `#settle` | —— | 与 #13 同：钩子在 `aborted` 下的行为要单列一节 |

### 2.3 生成之外仍然点名 TH/MVU 的固定点

这四条不在一轮生成里，但同属「按名点内置插件」的耦合面。设计稿不必替它们设计钩子，但**必须列出来并说明它们不在本设计范围内**——否则读者会以为三个钩子把耦合清干净了。

| # | 符号 | `path:line` | 谁 | 说明 |
| --- | --- | --- | --- | --- |
| 23 | `ChatEntry.initVars` → `mvuCapability` | `packages/iris-app-service/src/entry.ts:1041`–`:1042` | MVU | 卡片 `[InitVar]` 初始树，按 capability revision 缓存（`packages/iris-app-service/src/entry.ts:1044`） |
| 24 | `#replayFrom` → `engine.replay` | `packages/iris-app-service/src/entry.ts:1958`，引擎取自 `packages/iris-app-service/src/entry.ts:1899` | MVU | 变量表重放，发生在读路径上 |
| 25 | `ChatEntry.recordVariables` | `packages/iris-app-service/src/entry.ts:1062` | MVU | `computeVariables` 的单写者兼容包装（`notes/packages/iris-app-service/DEVIATIONS.md` §76 末段解释了为什么两个都留着） |
| 26 | `guardTavernHelper` | 定义 `packages/iris-app-service/src/service.ts:4513`，lease 在 `packages/iris-app-service/src/service.ts:4519`；**33** 个方法在 `packages/iris-app-service/src/service.ts:4533`–`:4544`，**9** 个 worldbook 方法（带 fence 才守）在 `packages/iris-app-service/src/service.ts:4549`–`:4553` | TH | **42 个 RPC 方法**整个包在一个 TH lease 里。其中 `script.generate` 与 `script.generateRaw` 本身就是生成——也就是说**卡片发起的生成今天整轮握着 TH 的 lease**，而它不走第 2.2 节的开场取 lease 那段代码。设计稿要说明钩子在 `script.generate` 路径上跑不跑（`#stream` 的 `#generateRaw` 分支没有 `entry`，见 `packages/iris-app-service/src/service.ts:5556` 上方的注释） |

### 2.4 怎么复算这张表

设计者应当自己跑一遍，两处不一致就以自己的结果为准并在设计稿里记下来：

```
grep -n "plugins\.lease(\|plugins?\.isEnabled(\|plugins\.capability(" packages/iris-app-service/src/service.ts
grep -rn "MVU_CAPABILITY\|TAVERN_HELPER_CAPABILITY\|mvuCapability\|tavernHelperCapability" packages/iris-app-service/src/
grep -n "ViaStCompat\|#settle\|arbitrateMessageVariables\|runScripts\|storeRewritten" packages/iris-app-service/src/service.ts
grep -rn "\.emit(\|ctx\.on(\|context\.on(" packages/iris-app-service/src/
```

第四条今天是**零命中**，它是第 8 节否决「Cordis 事件」的实证，复算时要把零命中本身当成一条结果记下来，而不是当成 grep 写错了。

### 2.5 一轮 `send` 的现状时序（文字版，设计稿时序图的原料）

下面这条线是设计稿那张「时序图（文字）」的骨架。三个钩子的位置必须能在这条线上**指出确切的插入点**——指不出来就说明设计还没做完。方括号里是候选插入点，问号表示尚未决定（正是第 4 节的问题）。

```
 1  chat.send 进来，校验、autoCompact                service.ts:4949
 2  entry.begin(turn) → AbortSignal                  entry.ts:981
 3  continue 的 seed / nudge、impersonate 的 instruction
                                                     service.ts:4958, :4992, :4998
 4  取 TH lease                                      service.ts:5006-:5007
 5  取 MVU lease + capability（impersonate 跳过）     service.ts:5014-:5024
 6    ┌ #contributions
 7    │  buildPrompt                                 service.ts:5500
 8    │  injectedContributions                       service.ts:5552
 9    │  ST 平面就地展开（1.5 s deadline）            service.ts:5556
10    │  [beforePrompt ?  ——  在 9 之后、11 之前]
11    │  classifyVolatility / markCachePhase          service.ts:5573
12    │  assemble + 记 itemization                    service.ts:5584
13    └ 返回 Contribution[]
14  driver.send/regenerate/continueTurn/impersonate  service.ts:5034-:5046
15    其中 send 先跑一次 user 方向 regex              service.ts:5039
16  broadcast stream.start                           service.ts:5057
17  流式：onText / onReasoning 累加并广播             service.ts:4966, :4970
18  running 落定 → #settle                           service.ts:5069
19    ┌ trimSentences（仅 completed 且记变量时）       service.ts:5146
20    │  [afterReplyText ?  —— 19 之后、21 之前？还是 21 之后、26 之前？]
21    │  ST 平面处理回复：换文本 + 交 floorVariables    service.ts:5169, :5171, :5174
22    │  MVU computeVariables → mvu 提案               service.ts:5182, :5197
23    │  arbitrateMessageVariables + 一次 replaceVariables
                                                     service.ts:5203, :5204
24    │  冲突上报                                     service.ts:5207
25    │  recordUsage / recordTiming                   service.ts:5224, :5233
26    │  #storeRewritten：assistant 方向 regex，可能 rebuild
                                                     service.ts:5234, :6312
27    │  prune / chats.save                           service.ts:5258, :5263
28    │  [onSettle ?  —— 27 之后、29 之前？还是 29 之后？]
29    │  broadcast stream.end                         service.ts:5267
30    └ #announceChats                                service.ts:5270
31  finally: releasePluginLeases                     service.ts:5082
```

两条容易被忽略的支线，设计稿要各给一句话：

- **中止**：`#fail`（`packages/iris-app-service/src/service.ts:5319`）在 `signal.aborted && partial.length > 0` 时**仍然结算**（`packages/iris-app-service/src/service.ts:5375`），走的是同一个 `#settle`，`reason: 'aborted'`。也就是说第 19–30 步在 abort 之后照跑，而约束 5 说 abort 之后不再调用后续钩子——这两句话相撞（Q9）。
- **卡片发起的生成**：`script.generate` / `script.generateRaw` 不走第 4–5 步，它们整轮握着 `guardTavernHelper` 取的那个 TH lease（`packages/iris-app-service/src/service.ts:4519`），而 `#generateRaw` 那条路径**没有 `entry`**。钩子在这条路径上跑不跑，要表态。

---

## 3. 固定约束（协调人已定，设计在这些之内）

以下八条来自任务单 U4 节，**不重开**。设计稿可以细化、可以补充边界，但不能推翻；真要推翻必须写进「待裁决问题」等协调人答复，不能直接按新方案写。

1. **注册口**：`scope.hooks.<name>(fn)`，返回 `Disposable`。`scope` 就是 `SystemPluginActivationScope`（`packages/iris-plugin-api/src/index.ts:95`），`hooks` 是它的一个新只读成员——**不是** `AppServiceOptions`（见前提纠正 F）。
2. **三个名字**，先只有这三个：
   - `beforePrompt`：拿到即将发送的 prompt 的**只读视图**，返回**提案**（追加/替换的段），不直接改。
   - `afterReplyText`：拿到回复文本的只读视图，返回替换文本或 `undefined`。
   - `onSettle`：只通知，**返回值忽略**。
3. **顺序 = 激活顺序**，与 U2 的 writer 顺序同一规则（依赖先于依赖者，同层按 id 字典序）。见前提纠正 I：这条今天还不是一个可读出来的量，设计稿要给出可计算的定义。
4. **失败与超时**：一个钩子 5 s 超时或抛错 → 在行上记 `hook-failed`，**本轮生成继续**，绝不阻塞、绝不撕掉回复。
5. **取消**：AbortSignal 传给每个钩子；用户 abort 之后不再调用后续钩子。
6. **释放**：随 lease 撤销；`isCurrent()` 为假的钩子不再被调用。
7. **不改变 TH/MVU 今天的行为**：设计稿里要有第 2.2/2.3 节那张表（符号 + `path:line`），标出哪些能映射、哪些不能；不能的要说明为什么——那就是 `docs/INFRASTRUCTURE-INTERFACES.md:338` 「TH 只从实现剥离、不从契约剥离」那句话的实证。
8. **`hook-failed` 这个名字由 U2 定义、U4 引用**（任务单 U2 裁决第三条写死了）。U4 不得改名，也不得在设计稿里假设 U2 会按 U4 的想法实现——只能记下依赖关系并在第 5 节说清。

### 3.1 这些约束**没有**说的事

同样重要，因为设计者很容易把没说的当成已定，然后在稿子里悄悄替协调人做了决定。以下每一条都**是设计者的活**：

- 没说 `beforePrompt` 的提案作用在哪个数据结构上（Q2）。
- 没说三个钩子在 `aborted` 结算路径上跑不跑（Q9）。
- 没说钩子在只读的 `prompt.itemize` 路径上跑不跑（Q13）。
- 没说 5 s 是每个钩子各 5 s 还是全部钩子合计 5 s；也没说这个预算与既有的 ST 桥 1.5 s（`packages/iris-app-service/src/service.ts:6364`）是什么关系（Q8）。
- 没说 `hook-failed` 记在哪一行——出错的那个插件的行，这在单钩子时显然，但**一个插件注册了三个钩子**时，行上只有一个 `failure` 字段（`packages/iris-protocol/src/system-plugins.ts:36`），它说的是哪个钩子（Q5）。
- 没说钩子要不要一个权限名。`PLUGIN_PERMISSIONS` 今天是按「作用域里给出触达的成员」命名的（`provide`/`getDependency`/`registerRpc`/`context` 四个），`hooks` 成为第五个成员就意味着词表要长一个名字——但 U3 已经确立了「有的权限带后果、有的只是声明」的区分，钩子属于哪一类，是设计要答的。
- 没说 TH/MVU 要不要**改走**钩子。约束 7 说的是「不改变它们今天的行为」，这与「把它们重新接到钩子上、行为逐字不变」并不矛盾（U2 对变量 writer 就是这么裁的）。设计稿要明确表态：本设计**不**动 TH/MVU，还是把它们的迁移排进分阶段落地。

---

## 4. 设计稿必须明确回答的问题

按编号逐条回答，**不许含糊过去**。回答是「暂不决定」的，就挪到「待裁决问题（≤5）」那一节去，并说明不决定的代价。

**Q1 三个钩子的确切 TypeScript 形状。** 三个签名、三个视图类型、三个返回类型，写成可以直接贴进 `packages/iris-plugin-api/src/index.ts` 的代码块。视图必须是只读的（`readonly` / `Readonly<>`），返回类型必须能表达「什么都不提」。同时回答：`afterReplyText` 拿到的文本是 `trimSentences`（`packages/iris-app-service/src/service.ts:5146`）**之前**还是之后的？是 `#processReplyViaStCompat` 改写（`packages/iris-app-service/src/service.ts:5171`）之前还是之后的？是 `#storeRewritten` 的 regex（`packages/iris-app-service/src/service.ts:6312`）之前还是之后的？三个都要答。

**Q2 `beforePrompt` 的提案作用在哪个表示上。** 候选只有两个，都要点名类型：`Contribution`（`packages/iris-pipeline/src/types.ts:141`，带 `id`/`label`/`placement`/`text`/`volatile`/`settled`），或 `assemble` 之后的消息数组（`packages/iris-app-service/src/service.ts:5584`）。选 `Contribution` 的代价是插件要懂 `placement` 和缓存标记；选消息数组的代价是提案落在 `classifyVolatility`（`packages/iris-app-service/src/service.ts:5573`）之后，缓存判定看不见它。**答案要连带说明提案里 `volatile`/`settled` 由谁填**——插件填还是宿主一律当 `volatile`。

**Q3 两个钩子提案到同一段时怎么办。** 「追加」可以叠加；「替换」同一个 `id` 不能。给出规则（后者胜？先者胜？报冲突？）并说明它和 `arbitrateMessageVariables`（`packages/iris-app-service/src/variable-arbitration.ts:99`）的「后者胜 + 冲突上报」是同一套还是两套。两套要说为什么值得。

**Q4 `onSettle` 与 U2 的 `propose` 是不是一回事。** 任务单点名要答案。设计者手上的事实：
- 今天结算时**已经**有两个提案者，各自的输入和输出在第 2.2 节 #15/#16 行里；
- 提案的形状是 `VariableProposal { pluginId, before, after }`（`packages/iris-app-service/src/variable-arbitration.ts:14`），**要求提案者返回一整张变量表**，宿主再算增量；
- 提案发生在 `replaceVariables` 落盘（`packages/iris-app-service/src/service.ts:5204`）**之前**，而 `stream.end` 广播在 `packages/iris-app-service/src/service.ts:5267`；
- `#settle` 有三个入口（#13），其中两个是 `aborted`。

据此回答：`onSettle` 是不是「`propose` 之后、落盘之后的只读通知」（即两者是**同一轮的两个时刻**，不是一回事），还是两者应当合并。答案要能解释：一个插件既想写变量又想在落盘后做别的事，它注册几次。

**Q5 `hook-failed` 与既有六个失败态怎么共处。** 事实：`SystemPluginFailureState` 今天是六个闭集（`packages/iris-protocol/src/system-plugins.ts:27`–`:33`），四个进 `ENABLE_BLOCKING_FAILURES`（`packages/iris-app-service/src/system-plugins.ts:105`），`markFailure` 会把行**停掉**（前提纠正 H），`#commit` 会把 `failure` **删掉**（前提纠正 J）。所以要答：
- `hook-failed` 走不走 `markFailure`？不走的话新入口叫什么、它动不动 `status`？
- 它进不进 `ENABLE_BLOCKING_FAILURES`？（按约束 4 显然不进，但要写出来）
- 它在什么时候被清掉——下一轮成功？下一次 enable/disable？永不自动清？
- 一个插件连续 N 轮超时，行上是一条还是 N 条？

**Q6 impersonate / continue / regenerate 三种 kind 怎么暴露给钩子。** 事实：`request.kind` 有四个值（`packages/iris-app-service/src/service.ts:5324` 的参数类型），`impersonating` 在开场就决定了 MVU 取不取 lease（`packages/iris-app-service/src/service.ts:5014`），continue 有 `seed`/`continuePostfix`/`nudge`（`packages/iris-app-service/src/service.ts:4958`、`:4992`），regenerate 会让世界书扫描丢掉尾条回复（`packages/iris-app-service/src/service.ts:5480` 附近的 `dropTrailingReply`）。要答：视图上是一个 `kind` 字段由钩子自己判，还是宿主按 kind 过滤？（U2 的裁决对 writer 选了前者——「要变成 writer 自己看 `view.kind` 判断」，U4 与之一致是默认答案，不一致要说明。）

**Q7 一个钩子**不**准做什么。** 先把**今天的信任模型**写清：系统插件是与宿主同权的 Node 代码（`docs/SYSTEM-PLUGINS.md` 的「Trust model」小节，2026-09-15 写下），`PLUGIN_PERMISSIONS` 是宿主展示与拼写检查的**声明**、不是边界（`packages/iris-app-service/src/plugins/manifest.ts` 里那条 docblock，以及 U3 裁决里「`plugin-storage` 是词表第一次带上后果」这句话反过来说明其余的都不带后果）。在这个前提下「禁止联网」是写不出来的——所以答案只能是**约定 + 后果**的形式：钩子里做什么会被算成 bug、什么会被超时切掉、什么宿主管不了。别写成宿主能强制执行的样子。

**Q8 超时机制。** 一个已经在跑的 Promise **杀不掉**。所以「5 s 超时后继续」要拆成三句话：①宿主不再等它；②它后来 resolve 的值怎么办（丢弃？还是可能污染下一轮？）；③它后来 reject 会不会变成未捕获拒绝。可参照的既有做法是 ST 桥的 `deadlineMs`（`packages/iris-app-service/src/service.ts:6451`，常量 1500 ms 在 `packages/iris-app-service/src/service.ts:6364`）——注意它是 **1.5 s**，而钩子的约束是 **5 s**，设计稿要说明为什么两个数不同（或者建议统一，作为待裁决问题）。

**Q9 AbortSignal 的传播与「abort 后不再调用后续钩子」的判定点。** 信号来自 `entry.begin(turn)`（`packages/iris-app-service/src/entry.ts:981`），整轮一个。要答：判定在每个钩子调用**之前**查一次 `signal.aborted`，还是把 signal 交给钩子后靠它自觉？两者都要（约束 5 是前者，视图里给 signal 是后者）。另外：`#fail` 的中止保留路径（`packages/iris-app-service/src/service.ts:5375`）**仍然会结算**，那 `afterReplyText`/`onSettle` 在 abort 之后跑不跑？约束 5 说「不再调用后续钩子」，与「aborted 也要结算」直接相撞，必须给答案。

**Q10 释放。** `isCurrent()` 在哪儿查——注册时、每次调用前、还是调用后提交前？既有先例是两处都查：`computeVariables` 算完之后、写之前再查一次（`packages/iris-app-service/src/entry.ts:1102`–`:1105`，注释写明「object identity is the incarnation token」）。钩子的返回值也是「算完之后才提交」，所以默认答案是同样两处查，设计稿要么照抄这个理由，要么说明为什么不需要。

**Q11 遥测。** 每轮已经记两份账（`recordUsage`、`recordTiming`，`packages/iris-app-service/src/service.ts:5224`/`:5233`，且它们**刻意分开**，理由在 `:5225`–`:5232` 的注释里）。要答：钩子耗时要不要成为第三份、挂在哪（candidate 上？还是只进 `#report`？）。倾向性建议：**第一阶段不记账**，只在超时时报一条，把「钩子耗时」留到有第二个消费者时再做——但要写出理由，别默认省略。

**Q12 「激活顺序」的可计算定义。** 这是最大的一个。事实见前提纠正 I。要给出一个函数式定义：输入是当前已启用插件集合与它们的 `dependencies`，输出是一个全序，且满足 ①依赖先于依赖者 ②同层按 id 字典序 ③与用户点击 enable 的先后**无关** ④与 `#plugins` Map 的插入序**无关**。并回答：这个顺序在哪儿算——每轮生成时现算，还是缓存在 runtime 上随 revision 失效？以及：它必须与 U2 的 writer 顺序是**同一个实现**（同一个函数），不是两个各自正确的实现。

**Q13 只读路径。** `prompt.itemize` 会走一遍完整的 prompt 构建（`packages/iris-app-service/src/service.ts:5778`–`:5816`），包括 ST 平面展开（`packages/iris-app-service/src/service.ts:5805`）。`beforePrompt` 在这条路径上跑不跑？跑：预览与真实轮一致，但一次预览会触发插件的副作用；不跑：预览显示的 prompt 与真正发出的不是同一份。两个代价都要写出来再选。

**Q14 一个插件注册多个钩子、或同一个钩子注册两次。** `Disposable` 的返回意味着注册是可多次的。要答：同一个插件对 `afterReplyText` 注册两次，是两个参与者（按注册序）还是后者覆盖前者？以及一个插件的三个钩子里有一个超时，另外两个这一轮还跑不跑？

**Q15 钩子与 ST 扩展平面的关系。** ST 平面今天在两个钩子位置上都已经有代码（#5、#15），而它本身就是一个系统插件（`docs/INFRASTRUCTURE-INTERFACES.md:312`：「一个 ST 扩展就是一个系统插件」）。要答：将来 ST 平面要不要改走 `scope.hooks`？不改的理由是什么（它的调用不是 `import` 来的函数，是跨帧的 ticket + 广播 + 等待，形状根本不同）？答案决定了设计稿能不能说「三个钩子统一了 prompt 期的插件介入」——今天说不了。

### 4.1 不属于本设计的问题

这几个会在读代码时自然冒出来，但**不是** U4 要答的。设计稿可以各用一句话点名「已知、不在本设计范围」，然后停下——不要展开，展开就是在替别的任务做决定。

- 第 2.3 节 #26 的 42 个 RPC 方法要不要从 TH 剥离。那是 `docs/INFRASTRUCTURE-INTERFACES.md:338` 的「`script.*` 与 TH 形状留在协议」那一行，完成条件是协议层的事。
- `ScriptContext` 单体怎么拆（`packages/iris-app-service/src/context.ts`，§8 的 `contributeContext` 行）。钩子视图里要不要有 context 是 Q7 的一部分，但**拆 context 不是**。
- MVU 是否该迁出 app-service（`notes/PLUGIN-FEASIBILITY.md` §6.1 记的阶段 1 遗留项）。
- `expandHelperMacros` 改走 `registerMacroLike`（`docs/INFRASTRUCTURE-INTERFACES.md:345`）。它和第 2.2 节 #1 是同一处代码，容易顺手设计——**别顺手**，那一行的完成条件是「接线即可，等 `entry.ts` 不再被重写」，与钩子无关。
- 帧侧（浏览器）要不要有对应的钩子。三个名字全在宿主侧；帧侧成员表是另一条线（`docs/INFRASTRUCTURE-INTERFACES.md` §5）。

---

## 5. 与相邻任务的关系

| 相邻任务 | 关系 | U4 的设计稿**必须**做的 | U4 的设计稿**不许**做的 |
| --- | --- | --- | --- |
| **U2 · 插件可写变量**（`dev/plugin-variable-writers`） | 强耦合。`hook-failed` 这个状态名由 U2 定义（任务单 U2 裁决第三条），U4 引用；顺序规则（Q12）两边必须是同一个实现；`onSettle` 与 `propose` 的关系是 Q4 | 明确写出「`hook-failed` 由 U2 落地、本设计只引用」；把 Q12 的顺序函数写成「U2 会造的那个，U4 复用」；Q4 给出答案 | 不许在设计稿里替 U2 定义 `registerWriter` 的形状；不许假设 U2 已经把 `markFailure` 改成不停插件（那是 U2 要解的，见前提纠正 H） |
| **U3 · `scope.storage`**（`dev/plugin-scope-storage`） | 弱耦合。storage 在钩子里当然可用（同一个 `scope`）；`plugin-storage` 是词表里**第一个带后果**的权限 | 一句话说明「钩子内可用 `scope.storage`，其调用耗时计入本钩子的 5 s 预算」 | 不许设计存储 API；不许为钩子新增权限名（钩子要不要一个 `generation-hooks` 权限，是待裁决问题，不是设计决定） |
| **U1 · `plugin.update`** | 无直接关系，但更新会换代：更新中 disable 旧代再 enable 新代，期间注册的钩子随 lease 撤销 | 在「释放」一节里提一句「更新换代等同于 disable→enable，钩子随之重注册」 | —— |
| **U5 · 插件自带文案** | **无关系** | —— | —— |
| **U6 · 加固与清账** | 无关系 | —— | —— |

并行性：U4 只写一个新 `.md`，与任何人零冲突（任务单 §1 的表格里 U4 那列写的就是「无」）。

---

## 6. 设计稿的验收标准

协调人按下面六条判，任何一条不过就打回：

1. **清单完整**。第 2.2 节的 22 行 + 第 2.3 节的 4 行，一共 **26 个固定点**，设计稿里一个不少，每个带 `path:line`，每个标了能/不能/部分映射。少的要说明为什么不算（比如判定某行不是「固定调用点」），不能无声漏掉。
2. **固定约束全部落实**。第 3 节八条，每条在设计稿里能找到对应的一段文字，且没有被偷偷放宽（尤其第 4 条「绝不阻塞」和第 6 条「随 lease 撤销」）。
3. **Q1–Q15 都有答案**，或者被明确挪进待裁决问题。
4. **待裁决问题 ≤ 5 条**，每条写清「不裁决的后果」。超过 5 条说明设计没收敛，打回。
5. **`node --test apps/iris/tests/md-references.test.ts` 绿**（3 tests, 3 pass, 0 fail）。
6. **零产品代码改动**。`git diff --stat` 只有 `docs/GENERATION-HOOKS.md` 一个文件（外加本文件，如果它和设计稿同支）。

另外两条是「加分但不卡」：设计稿里的时序图（文字版）能让人不看代码就说出钩子在 `trimSentences`、`#processReplyViaStCompat`、`arbitrateMessageVariables`、`#storeRewritten`、`chats.save`、`stream.end` 六个既有动作之间的**确切位置**；以及第 2.2 节 #11（流式无挂点）被当成一个**结论**写出来，而不是被跳过。

### 6.1 `docs/GENERATION-HOOKS.md` 的建议骨架

任务单要求的九个部分（目标/非目标、现状调用点清单、类型草图、时序图、失败与释放语义、与 U2 的关系、分阶段落地、被否决的方案、待裁决问题）排成这样，括号里是预估行数：

1. **头部三行**（5）：这是什么、基线 commit、哪些 PR 已落地哪些没有。写成将来可以原地更新的形式——`docs/SYSTEM-PLUGIN-INSTALL.md` 的头部是可抄的先例。
2. **§1 目标与非目标**（20）。非目标要点名：不设计流式钩子、不设计事件总线、不动 TH/MVU（或动，见 §3.1 最后一条）、不设计存储（U3）、不设计变量写入（U2）。
3. **§2 现状调用点清单**（70–90）。本文件第 2.2 与 2.3 节的表，**逐行核对后**抄进去。这一节是全稿最重的一节，也是协调人第一眼看的地方。
4. **§3 三个钩子的类型草图**（40）。Q1 的答案，写成可以直接贴进 `packages/iris-plugin-api/src/index.ts` 的 TypeScript，含 docblock。
5. **§4 时序（文字）**（35）。本文件第 2.5 节那条线，把方括号换成确定的插入点。
6. **§5 失败、超时、取消、释放**（45）。Q5、Q8、Q9、Q10 的答案，四个小标题。
7. **§6 顺序**（20）。Q12 的答案：一个可计算的全序定义，加一句「与 U2 共用同一实现」。
8. **§7 与 U2 变量 writer 的关系**（20）。Q4 的答案，含「一个插件既写变量又要落盘后通知，它注册几次」。
9. **§8 分阶段落地**（25）。每步一 PR，每步的前置依赖与可独立回滚性。
10. **§9 被否决的方案**（30）。本文件第 8 节五条，每条带否决所依据的约束编号。
11. **§10 待裁决问题（≤5）**（20）。每条写清不裁决的后果。
12. **§11 本文件与 §8 的关系**（10）：`docs/INFRASTRUCTURE-INTERFACES.md:340` 那一行在设计合入后应当从「未做」变成什么状态（建议：「设计已定，实现未开始」，并把括号里的 `AppServiceOptions` 改成 `scope.hooks`）——但**由协调人改**，U4 不动那个文件。

合计约 340–380 行，落在任务单的 250–400 里。

---

## 7. 分阶段落地建议

下面是**建议**，设计者可以推翻，但推翻要给理由并保留一个同样分得开的替代切法。原则是每一步都能独立合入、独立回滚，且第一步不碰 prompt 构建。

**PR-A：只做 `onSettle`。** 最小一步，因为它「只通知、返回值忽略」（约束 2），所以不需要回答 Q2、Q3，`hook-failed` 的语义在这里最容易验证（一个只通知的钩子超时，回复必须原样落地）。落点候选是 `packages/iris-app-service/src/service.ts:5267`（`stream.end`）前后。前置依赖：U2 的 `hook-failed` 已落地，或本 PR 自带一个最小版本并在 ledger 里写明两者的关系。

**PR-B：`afterReplyText`。** 把第 2.2 节 #15 的**文本半边**（不含变量半边）变成钩子能做的事。此时必须先答 Q1 的三个「之前还是之后」和 Q9 的 abort 相撞问题。TH 的 regex 映射（#20）在这一步被逼到台前：钩子在 `#storeRewritten` 之前还是之后，决定了钩子改的文本会不会再过一遍 regex。

**PR-C：`beforePrompt`。** 最难，因为它要答 Q2（作用在哪个表示上）、Q3（两个提案撞同一段）、Q13（预览路径跑不跑），还要和已经就地改写 `Contribution[]` 的 ST 平面（#5）共处。放最后。

**不建议的切法**：按插件切（先给 TH 接上、再给 MVU 接上）。理由：TH 和 MVU 今天的调用点分别落在 #1（宏遍，映射不上）和 #16（变量提案，属于 U2），按插件切会让第一个 PR 同时动 U2 的地盘和一个映射不上的点。

---

## 8. 被否决的方向

写进设计稿，免得读者或下一任设计者重新探一遍。每条都要写「在哪条约束下被否决」，不是凭喜好。

1. **钩子做成 Cordis 事件（`ctx.on` / `ctx.emit`）。** `notes/PLUGIN-FEASIBILITY.md:116` 曾把它列成「Cordis 已给」。否决理由有三条，都硬：①事件的 emit **没有返回值**，而 `beforePrompt` 要收提案、`afterReplyText` 要收替换文本，一个只能广播的通道表达不了；②事件监听器**没有顺序保证**，约束 3 要的是确定的全序；③本仓今天一条事件都没有（第 2.4 节第四条 grep 零命中），引入事件总线等于同时引入一套新的调试面和一套新的失败模式，而收益只是省下一个成员名。
2. **钩子做成 `registerRpc` 方法（让插件注册一个宿主回调它的 RPC）。** `registerRpc` 已经在（`packages/iris-plugin-api/src/index.ts:132`），形状上「宿主调插件」是可以硬凑出来的。否决理由：`registerRpc` 的方向是**外部请求进宿主**，它的 schema 校验、`pluginRevision` fence、`unsupported` refusal 全是为那个方向设计的（那段 docblock 在 `packages/iris-plugin-api/src/index.ts:106`–`:131`）；反过来用会让「一个方法名被占」和「一个钩子被注册」变成同一件事，而钩子可以有多个插件同时注册、RPC 方法名不能重复（`packages/iris-app-service/src/system-plugins.ts:926` 的注释写明重名在 `activate` 里直接抛）。
3. **可变视图（钩子直接改 prompt / 直接改文本）。** 约束 2 已经写死「只读视图 + 提案」。补充理由：#5 的 ST 平面今天正是就地改写（`packages/iris-app-service/src/service.ts:6458`），而那条路径**只有一个**参与者。一旦有两个参与者，就地改写意味着第二个看到的输入取决于第一个做了什么，冲突无法上报也无法复现——这正是 `notes/packages/iris-app-service/DEVIATIONS.md` §76 记下的那个 bug 的形状（两个写者两次提交，后写吞掉先写，损失被 last-writer-wins 藏住）。
4. **每个钩子带优先级（`priority` 数字）。** 否决理由：约束 3 已经给了顺序（激活顺序），再加一个优先级就是**两套顺序**，且优先级是插件**自己声明**的——一个插件把自己设成最高优先级没有任何代价，于是所有插件都会这么干，这个字段一年后就只剩噪音。真正需要「我要在某某之后」的场景，正确的表达是 `dependencies`（已有，且 `#enableOrder` 已经按它排序）。
5. **钩子挂在 `AppServiceOptions` 上**（`docs/INFRASTRUCTURE-INTERFACES.md:340` 那一行的括号里写的那样）。否决理由：`AppServiceOptions`（`packages/iris-app-service/src/service.ts:491`）是**组合根**注入依赖的地方，只有宿主自己能填；插件在 `activate` 里拿到的是 `scope`，够不着它。挂在那里等于「只有宿主能注册钩子」，而这条缺口的全部意义是让**插件**能注册。

---

## 9. 完成报告模板

设计 PR 合入前发给协调人，按这个填：

```
分支：dev/generation-hooks-design
最终 commit：<sha>
产物：docs/GENERATION-HOOKS.md（<N> 行）
ledger：无（U4 不改产品代码）

与任务单/施工文档的偏离：
  - <每条一行：任务单说了什么、代码是什么、我按哪个写的>
  - （至少要复述本文件第 2.1 节 A–K 里自己复算后仍然成立的那几条，
     以及复算推翻的那几条）

清单：固定调用点 <N> 个（本文件给了 26 个；多了少了都要说明）
  - 能映射到三个钩子：<N>
  - 部分映射：<N>
  - 不能映射：<N>，逐条理由见设计稿 §<X>

Q1–Q15 的去向：
  - 已回答：<编号列表>
  - 挪进待裁决：<编号列表>（共 <N> 条，必须 ≤ 5）

待裁决问题（≤5）：
  1. <问题> —— 不裁决的后果：<...>
  ...

分阶段建议：PR-A <...> / PR-B <...> / PR-C <...>
（若推翻了本文件第 7 节的切法，写清替代切法和理由）

门禁：
  node --test apps/iris/tests/md-references.test.ts
  <原样粘贴输出，应为 3 tests / 3 pass / 0 fail>

git diff --stat（应只有 docs/GENERATION-HOOKS.md）：
  <原样粘贴>
```

牙齿表：U4 **没有**。本任务不新增断言，也不改既有断言；报告里写一行「无产品代码改动，无新断言」即可，不要为了凑格式编一条。
