# 生成钩子设计:`beforePrompt` / `afterReplyText` / `onSettle`

本文是 `docs/INFRASTRUCTURE-INTERFACES.md` §8「生成钩子」行的设计稿：只设计，不实现。基线 `main` `269a97e`；写作时第二批基建任务（U1–U6，`notes/INFRA-TASKS-2026-09-15.md`）均未合入，文中引用的 U2 交付物（`hook-failed` 状态、激活顺序函数）是**已裁决、未落地**的依赖，关系见 §7.1 与 §10。协调人裁决本稿后才开实现阶段。

## 1. 目标与非目标

**目标**：给系统插件三个确定性的生成期挂点，注册口是 `scope.hooks.<name>(fn)`，返回 `Disposable`；失败不阻塞回复；随 lease 撤销；顺序可计算。§8 那行的完成条件「明确 owner、顺序、取消、错误语义与释放」逐项落在 §3（owner）、§6（顺序）、§5.3（取消）、§5.1/§5.2（错误）、§5.4（释放）。

**非目标**：

- **不设计流式钩子**。一轮生成里的流式段（`onText`/`onReasoning`，`packages/iris-app-service/src/service.ts:4966`、`packages/iris-app-service/src/service.ts:4970`）没有任何挂点，这是**有意的留白**：每个 token 调一次钩子会把 §5.2 的 5 s 预算变成没有意义的数，而「流式改写」要回答的问题（增量提案怎么合并、缓存怎么算）一个都不少，值得独立设计。清单 §2.1 #11 把这条当结论记录。
- **不设计事件总线**。§9.1 否决。
- **不动 Tavern Helper 与 MVU**。它们今天的每个调用点保持原样（§2 清单是行为不变的承诺书）；没有任何一个今天的调用点能被这三个钩子替代，迁移无从谈起（§2.3 结论）。
- **不设计存储**（U3 的 `scope.storage`）、**不设计变量写入 API**（U2 的 `scope.variables`）。钩子内可以调用它们，关系见 §5.2 与 §7.1。
- **不拆 `ScriptContext` 单体**、不给帧侧（浏览器）设计对应钩子、不处理 42 个 TH RPC 方法的剥离（均为别条线的地盘，见 §2.3 尾与 §7.2）。

## 2. 现状调用点清单

本节是把协调人给的施工清单逐行复算后抄录的（复算方法：对 `packages/iris-app-service/src/` 跑四条 grep——`plugins.lease/isEnabled/capability`、四个 capability 名、`ViaStCompat/#settle/arbitrateMessageVariables/runScripts/storeRewritten`、`.emit(/ctx.on(/context.on(`）。复算结果与清单一致，仅一处行号细化：#7 的三个符号占三个行号（5564/5573/5584），清单给的两个行号原本是合写的。第四条 grep 今天是**零命中**——宿主一条事件都不发、不收，这是 §9.1 否决事件总线的实证。

### 2.1 一轮生成（`send` 的时间序）里的 22 个固定点

「映射」列：**落点** = 该处正是某钩子的语义位置；**部分** = 既有参与者占着钩子位置的一半；**不能** = 与三个钩子无映射关系，理由在尾列。

| # | 阶段 | 符号（证据） | 谁被点名 | 干什么 / 失败时 | 映射 |
| --- | --- | --- | --- | --- | --- |
| 1 | prompt build | `ChatEntry.substitute` → `tavernHelperCapability`（`packages/iris-app-service/src/entry.ts:761`；宏树读自 `entry.ts:703`） | TH（`macro-expander`） | 每段文本、每条历史行各调一次的宏展开；capability 缺席原样返回（`entry.ts:762`），`expandMacros` 抛错无捕获沿 `substitute` 冒 | **不能**：粒度是「一段文本」不是「一份 prompt」，且比 `beforePrompt` 早 |
| 2 | prompt build | `#rawHistory` → `runScripts(…, isPrompt)`（`packages/iris-app-service/src/service.ts:6286`） | —（regex 层） | 历史行改写；`runScripts` 吞单条脚本错误 | **不能**：TH 卡片 regex 的宿主实现，不是插件调用 |
| 3 | prompt build | `#contributions` → `buildPrompt`（调用 `packages/iris-app-service/src/service.ts:5500`） | — | 卡、世界书、preset、window、persona、`tokenBudget` 产出 `Contribution[]` | **不能**：`beforePrompt` 的上游，钩子拿到的是它之后的形态 |
| 4 | prompt build | `injectedContributions`（`packages/iris-app-service/src/service.ts:5552`） | — | 宿主自己的 outlet/extension prompt 追加注入 | **不能**：但 `beforePrompt` 的「追加段」提案必须与它落在同一表示上（§3.2） |
| 5 | prompt build（真实轮） | `#expandContributionsViaStCompat`（调用 `packages/iris-app-service/src/service.ts:5556`，定义 `service.ts:6434`） | ST 扩展平面 | 就地改写 `contributions`（`service.ts:6458`）**并且**写 chat/global 变量（`service.ts:6463`）；无 ticket 静默返回（`service.ts:6453`），结果非法报 `prompt/fault` 后返回（`service.ts:6460`），deadline 1.5 s（`service.ts:6364`） | **部分**：位置正是 `beforePrompt`，但它就地改写、顺手写变量，两条都与「只读视图 + 提案」相反；本设计保留其特权（§7.2） |
| 6 | prompt build（预览） | 同 #5，`prompt.itemize` 路径（`packages/iris-app-service/src/service.ts:5805`） | ST 扩展平面 | 同上；注释原文「The preview bridges too: the panel must show what would actually be sent」 | **部分**：`beforePrompt` 在预览路径也跑（§4.2） |
| 7 | prompt build | `classifyVolatility` / `markCachePhase` / `assemble`（`packages/iris-app-service/src/service.ts:5564` / `:5573` / `:5584`） | — | 缓存易变性判定与最终组装 | **不能**：`beforePrompt` 的下游——提案必须在 5564 之前落地，否则缓存判定看不见它（§3.2） |
| 8 | 开场 | `plugins.isEnabled('tavern-helper')` → `plugins.lease(...)`（`packages/iris-app-service/src/service.ts:5006`–`:5007`） | TH | 取一个整轮持有的 lease；停用时 `lease` 抛（`packages/iris-app-service/src/system-plugins.ts:638`，经 `assertCurrent`） | **不能**：它就是钩子释放机制要复用的那段（§5.4） |
| 9 | 开场 | `!impersonating && plugins.isEnabled('mvu')` → lease + capability（`packages/iris-app-service/src/service.ts:5014`–`:5024`） | MVU（`mvu-engine`） | `mvuExecution` 带进结算；启用但 capability 缺 → 释放全部 lease 抛 `internal`（`service.ts:5017`–`:5021`） | **不能**：`!impersonating` 这个 kind 过滤发生在开场，先于任何钩子（§3.1） |
| 10 | 开场 | `releasePluginLeases`（定义 `packages/iris-app-service/src/service.ts:5026`，调用 `:5048`/`:5082`/`:5089`） | TH+MVU | 倒序释放，幂等 | **不能**：钩子的释放语义要落在同一个 `finally` 里 |
| 11 | 流式 | `events.onText` / `onReasoning`（`packages/iris-app-service/src/service.ts:4966`、`:4970`） | — | 增量累加进 `entry.pending`，广播 `stream.text`/`stream.reasoning` | **不能**：三个钩子里没有流式挂点，**有意留白**（§1） |
| 12 | 流式 | `driver.send(…, runScripts(request.text, 'user', …))`（`packages/iris-app-service/src/service.ts:5039`） | —（regex 层） | 用户输入入库前唯一一次改写 | **不能**：钩子够不着首次落库 |
| 13 | 结算入口 | `#settle`（定义 `packages/iris-app-service/src/service.ts:5122`；调用 `:5069` 完成、`:5340` impersonate 中止、`:5375` 中止保留残句） | — | 整个结算在一个 `try` 里，`catch` 走「存不下就是终态事件」 | **不能**：三个入口意味着两个钩子必须说清 `aborted` 时跑不跑（§5.3） |
| 14 | 回复文本 | `trimSentences` → `trimToEndSentence`（`packages/iris-app-service/src/service.ts:5146`） | — | 仅 completed 且记变量时截断 | **不能**：但它是 `afterReplyText` 的上游（§4） |
| 15 | 回复文本 | `#processReplyViaStCompat`（调用 `packages/iris-app-service/src/service.ts:5169`，定义 `:6470`） | ST 扩展平面 | ①替换文本（`service.ts:5171`）②floorVariables 变 `prompt-template` 提案（`:5174`）③自己已写过 chat/global 变量（`:6501`）；无 ticket/非法 → 保留原文，1.5 s deadline | **部分**：文本半边正是 `afterReplyText` 的位置，变量半边是 U2 的 `propose`；今天两件事在同一次调用里 |
| 16 | 回复文本 | `entry.computeVariables`（MVU）（调用 `packages/iris-app-service/src/service.ts:5182`，定义 `packages/iris-app-service/src/entry.ts:1084`） | MVU | 从 `settledText` 解析命令 → `mvu` 提案（`service.ts:5197`）；引擎缺席/`isCurrent()` 假 → `undefined`（`entry.ts:1093`、`:1102`–`:1105`），`engine.update` 抛错不捕获 | **不能**：它整个就是 U2 的 `propose`（§7.1） |
| 17 | 结算 | `arbitrateMessageVariables`（调用 `packages/iris-app-service/src/service.ts:5203`，定义 `packages/iris-app-service/src/variable-arbitration.ts:99`） | —（宿主提交边） | 提案数组 + 基线 → 一次 `replaceVariables`（`service.ts:5204`） | **不能**：U2 的落点；Q3 的冲突规则与它同构（§3.3） |
| 18 | 结算 | 冲突上报（`packages/iris-app-service/src/service.ts:5207`） | — | `settled.conflicts` → `{ kind: 'variables', grade: 'note' }` | **不能**：`hook-failed` 的上报走同一条 `#report` 通道（§5.1） |
| 19 | 结算 | `entry.recordUsage` / `entry.recordTiming`（`packages/iris-app-service/src/service.ts:5224`、`:5233`） | — | 两份刻意分开的记账（理由在 `:5225`–`:5232` 注释） | **不能**：是遥测取舍的对照物——钩子耗时**不**成为第三份（§5.6） |
| 20 | 结算 | `#storeRewritten` → `runScripts(…, 'assistant', …)`（调用 `packages/iris-app-service/src/service.ts:5234`，定义 `:6309`，改写 `:6312`） | —（chat regex tier） | 对最终文本跑 assistant 方向 regex，可能 `entry.rebuild` 整条 log（`:6323`） | **部分**：它坐在 `afterReplyText` 想要的位置；钩子在其**之前**跑（§4），输出的文本会再过一遍 regex |
| 21 | 结算 | prune / `chats.save` / `stream.end` / `#announceChats`（`packages/iris-app-service/src/service.ts:5258`、`:5263`、`:5267`、`:5270`） | — | 落盘与广播；`save` 失败走 `storage-error` 终态 | **落点**：`onSettle` 落在 `stream.end` 之后、`#announceChats` 之前（§4） |
| 22 | 中止路径 | `#fail` 把 `mvuExecution` 带进 `#settle`（`packages/iris-app-service/src/service.ts:5325`、`:5380`） | MVU | `signal.aborted && partial.length > 0` 时仍结算，`reason: 'aborted'` | **不能**：与 #13 同——`aborted` 下的钩子行为单列（§5.3） |

### 2.2 生成之外仍点名 TH/MVU 的 4 个固定点

不在一轮生成里，但同属「按名点内置插件」的耦合面。列出并声明**不在本设计范围内**——否则读者会以为三个钩子把耦合清干净了。

| # | 符号（证据） | 谁 | 说明 / 不在范围的理由 |
| --- | --- | --- | --- |
| 23 | `ChatEntry.initVars` → `mvuCapability`（`packages/iris-app-service/src/entry.ts:1041`–`:1042`，按 revision 缓存 `:1044`） | MVU | 卡片 `[InitVar]` 初始树，读路径。三个钩子都是生成期挂点，覆盖不了它 |
| 24 | `#replayFrom` → `engine.replay`（定义 `packages/iris-app-service/src/entry.ts:1958`，引擎取自 `:1899`） | MVU | 变量表重放，读路径。同上 |
| 25 | `ChatEntry.recordVariables`（`packages/iris-app-service/src/entry.ts:1062`） | MVU | `computeVariables` 的单写者兼容包装（为什么两个都留着：app-service 偏差账 §76）。U2 的地盘 |
| 26 | `guardTavernHelper`（定义 `packages/iris-app-service/src/service.ts:4513`，lease 在 `:4519`；33 个方法 `:4533`–`:4544`，9 个带 fence 的 worldbook 方法 `:4549`–`:4553`） | TH | **42 个 RPC 方法**整个包在 TH lease 里。其中 `script.generate`/`script.generateRaw` 本身就是生成——卡片发起的生成今天整轮握着 TH 的 lease，且不走 #8/#9 的开场取 lease 段。钩子在这条路径上**不跑**（§4.3） |

**清单结论**：26 个固定点里，**没有一个能被三个钩子替代**。5 个是部分/落点关系（#5、#6、#15、#20 是 ST 平面或 regex 层占着钩子位置的一半，#21 是 `onSettle` 的插入点），21 个不能映射。这正是 §8「TH 只从实现剥离、不从契约剥离」那句话的实证：三个钩子是**新开的面**，不是对既有调用点的换皮；TH/MVU 今天的行为在这份设计里一个字节都不动（约束 7）。

## 3. 三个钩子的类型草图

### 3.1 注册口与签名（Q1、Q6）

可直接贴进 `packages/iris-plugin-api/src/index.ts` 的草稿。契约包不 import 任何 `@iris` 包（其 contract 测试钉住），所以视图与提案形状按 `ScopedRequestSchema` 的先例**就地结构化声明**，不 import `Contribution`。

```ts
/** 本轮生成的共同元数据；`signal` 既是宿主的跳过判据（§5.3），也交给钩子协作取消。 */
export interface GenerationHookView {
  readonly chatId: string
  readonly turn: number
  /** 四种生成；钩子自己判（与 U2 对 writer 的裁决一致），宿主不按 kind 过滤。 */
  readonly kind: 'send' | 'regenerate' | 'continue' | 'impersonate'
  readonly signal: AbortSignal
}

export interface BeforePromptView extends GenerationHookView {
  /** 即将发送的 prompt 的只读投影：buildPrompt + injectedContributions 之后、
   *  classifyVolatility 之前的 `resolved` 数组（service.ts:5552 与 :5564 之间）。 */
  readonly contributions: readonly PromptSegmentView[]
}

export interface AfterReplyTextView extends GenerationHookView {
  /** 回复文本的只读投影：trimSentences 与 ST 平面处理之后、变量提案之前的定形文本。 */
  readonly text: string
  readonly reason: 'completed' | 'aborted'
}

export interface SettleView extends GenerationHookView {
  /** 结算完成时的回复文本（已过 regex 与落库定形）。 */
  readonly text: string
  readonly reason: 'completed' | 'aborted'
}

export interface GenerationHooks {
  /** 返回对 prompt 的提案（追加/替换段）；返回 undefined 表示无提案。不直接改。 */
  beforePrompt(fn: (view: BeforePromptView) => PromptProposal | undefined
    | Promise<PromptProposal | undefined>): () => void
  /** 返回替换文本，或 undefined 表示不改。 */
  afterReplyText(fn: (view: AfterReplyTextView) => string | undefined
    | Promise<string | undefined>): () => void
  /** 只通知；返回值（含 rejection 之外的一切）被忽略。 */
  onSettle(fn: (view: SettleView) => void | Promise<void>): () => void
}

export interface SystemPluginActivationScope {
  // …既有成员照旧…
  /** 生成期钩子；注册随本 activation 的 fiber 撤销（§5.4）。 */
  readonly hooks: GenerationHooks
}
```

`PromptSegmentView` 与 `Contribution`（`packages/iris-pipeline/src/types.ts:141`）字段一致（`id`/`label?`/`placement`/`text`/`volatile?`/`settled?`），全部 `readonly`。`kind` 与 `reason` 分列：`kind` 是「这是哪种生成」，`reason` 是「这轮怎么收的场」，钩子判 `aborted` 用后者。

**Q6 的答案**：视图带 `kind` 字段由钩子自己判，宿主不按 kind 过滤钩子——与 U2 对 writer 的裁决（「writer 自己看 `view.kind` 判断」）一致。今天 `!impersonating` 对 MVU 的过滤（#9）发生在开场取 lease，迁移后由 writer 自判；钩子一律全 kind 调用。continue 的 seed/nudge、regenerate 的 `dropTrailingReply`（`packages/iris-app-service/src/service.ts:5480`）已经反映在 contributions 的最终形态里，不需要额外字段。

### 3.2 `beforePrompt` 的提案表示（Q2）

**提案作用在 `Contribution` 表示上**（`resolved` 数组，#4 之后、#7 `classifyVolatility` 之前），不在 assemble 之后的消息数组上。决定性的理由只有一个：提案必须落在 `classifyVolatility`（`packages/iris-app-service/src/service.ts:5564`）**之前**，否则缓存判定看不见它——提案的文本会以「陌生人」身份出现在每轮请求里，而波动性记录与 itemization 账目（#7、#6 两处的注释都写着「recorded account and the sent request are the same bytes」）描述的是没有提案的那份。选消息数组的代价直接撞碎这条不变量；选 `Contribution` 的代价（插件要懂 `placement`）用下面两条缓解：

```ts
export interface PromptProposal {
  /** 追加段；全部叠加，顺序 = 激活序（§6）。 */
  readonly append?: readonly {
    readonly placement: PluginPromptPlacement
    readonly text: string
    readonly label?: string
  }[]
  /** 按既有段的 id 整段替换文本；id 不存在 → 本条作废并上报（§5.1），不静默。 */
  readonly replace?: readonly { readonly id: string, readonly text: string }[]
}

/** `Placement`（iris-pipeline types.ts:87）的结构化只读重声明，同理不 import。 */
export type PluginPromptPlacement =
  | { readonly kind: 'system', readonly order: number }
  | { readonly kind: 'depth', readonly depth: number,
      readonly role: 'system' | 'user' | 'assistant', readonly order?: number }
```

- **追加段的 `id` 由宿主铸造**，形如 `hook:<pluginId>:<n>`——插件不得自造 id，保证可归因、可去重。
- **`volatile`/`settled` 由宿主填，一律 `volatile: true`、无 `settled`**，插件没有发言权。理由：`volatile` 在 pipeline 里是「a verdict handed in, not a property the assembler can see」（`packages/iris-pipeline/src/types.ts:141` 附近的原文），判定者必须拿着上一轮的内容或知道文本的习性，而插件两样都没有；一律 volatile 是唯一诚实的默认（钩子注入的文本永不进稳定前缀，最坏是多付易变层的 token，绝不会把动层错标成稳层炸掉后续缓存）。放开插件自声明是带证据的将来优化，第一阶段不做。

### 3.3 两个钩子提案相撞（Q3）

- 追加对追加：叠加，顺序 = 激活序，不报冲突。
- 替换对替换（同一个 `id`）：**后者胜**（激活序在后者），并走 `#report` 上报一条 `{ kind: 'hooks', grade: 'note' }`，点名两个插件、被替换的 id 与胜者。
- 这与 `arbitrateMessageVariables` 的「后者胜 + 冲突上报」是**同一套规则、两套实现**。规则同构是刻意的：插件作者从变量仲裁（§6 文档与 U2）学到的秩序感——后跑的赢、被覆盖会上报、绝不静默——在 prompt 提案上原样成立。实现不共用：变量仲裁按 JSON 路径前缀重叠判定（`packages/iris-app-service/src/variable-arbitration.ts:90`–`:96` 的 `overlaps`），段替换按 id 精确相等判定，输入形状一个是整表、一个是段列表；强行统一要造出第二个抽象层去抹平两类判交，不值得。共享的是规则文本，不是代码。

## 4. 时序（文字）

### 4.1 一轮 `send` 的插入点

方括号是**确定的**插入点（数字 = §2.1 的行号）：

```
 1  chat.send 进来，校验、autoCompact                service.ts:4949
 2  entry.begin(turn) → AbortSignal                 entry.ts:981
 3  continue 的 seed/nudge、impersonate 的 instruction  service.ts:4958, :4992, :4998
 4  取 TH lease                                     service.ts:5006-:5007
 5  取 MVU lease + capability（impersonate 跳过）    service.ts:5014-:5024
 6    ┌ #contributions：buildPrompt                  service.ts:5500
 7    │  injectedContributions                       service.ts:5552
 8    │  ST 平面就地展开（1.5 s deadline）            service.ts:5556
 9    │  【beforePrompt：#8 之后、#10 之前】
10    │  classifyVolatility                           service.ts:5564
11    │  markCachePhase / assemble + 记 itemization   service.ts:5573, :5584
12    └ 返回 Contribution[]
13  driver.send/regenerate/continueTurn/impersonate  service.ts:5034-:5046
14    其中 send 先跑一次 user 方向 regex              service.ts:5039
15  broadcast stream.start                           service.ts:5057
16  流式：onText / onReasoning（无钩子，有意留白）     service.ts:4966, :4970
17  running 落定 → #settle                            service.ts:5069
18    ┌ trimSentences（仅 completed 且记变量时）       service.ts:5146
19    │  ST 平面处理回复：换文本 + 交 floorVariables   service.ts:5169, :5171, :5174
20    │  【afterReplyText：#19 之后、#21 之前】
21    │  MVU computeVariables → mvu 提案              service.ts:5182, :5197
22    │  arbitrateMessageVariables + 一次 replaceVariables  service.ts:5203, :5204
23    │  冲突上报                                     service.ts:5207
24    │  recordUsage / recordTiming                   service.ts:5224, :5233
25    │  #storeRewritten：assistant 方向 regex（钩子的输出会再过这一遍）  service.ts:5234, :6312
26    │  prune / chats.save                           service.ts:5258, :5263
27    │  broadcast stream.end                         service.ts:5267
28    │  【onSettle：#27 之后、#30 之前，自带完整 try/catch】
29    └ #announceChats                                service.ts:5270
30  finally: releasePluginLeases                      service.ts:5082
```

**三个钩子的确切位置，一句话版**：`beforePrompt` 在 ST 平面展开之后、`classifyVolatility` 之前（ST 的结果在钩子视图里可见）；`afterReplyText` 在 ST 平面换文本之后、MVU 解析之前——它看到的文本 = `trimSentences` 之后、ST 处理之后、`#storeRewritten` 的 regex **之前**；它的输出 = 新的 `settledText`，变量提案、regex、落库、广播全部看到它定形后的文本。`onSettle` 在 `stream.end` 广播之后、`#announceChats` 之前。

三个「之前还是之后」（Q1）的完整答案：`trimSentences`（`service.ts:5146`）**之后**——trim 是「下游看见的一切」的一部分；`#processReplyViaStCompat` 改写（`service.ts:5171`）**之后**——ST 平面是既有参与者且先到，钩子排在它后面才不会与它的输出互踩；`#storeRewritten` 的 regex（`service.ts:6312`）**之前**——钩子注入的文本必须与模型输出受同一批卡片 regex 约束，否则卡片作者的脚本对钩子注入的内容是盲的，且 `#storeRewritten` 之后的改动要再走一次 `entry.rebuild`（`service.ts:6323`）才落得进 log。

`afterReplyText` 排在 MVU 提案（#21）之前的含义：**文本先定形、变量后解析**——变量提案器解析的是钩子定形后的文本，与上游 ST 的顺序同构（文本处理器先跑，MVU 类脚本解析处理后的楼层）。这与「MVU 必须看到模型原文」是两个都自洽的选择，涉及 U2 的输入面，列入待裁决 2。

`onSettle` 落在 `stream.end` 之后的理由：帧在 `stream.end` 解除等待，钩子慢（最坏 5 s）不应推迟终态到达；且 `terminal` 已置真（`service.ts:5266`），`onSettle` 的调用点**自带完整 try/catch**——钩子的任何抛错只上报，绝不落入 `#settle` 自己的 `catch`（否则一个已成功落盘的回合会被误报成 `storage-error`）。

### 4.2 只读路径：`prompt.itemize`（Q13）

**跑。** `beforePrompt` 在 `#previewItemization`（`packages/iris-app-service/src/service.ts:5778`–`:5816`，ST 展开在 `:5805`）里与真实轮同样调用，提案合并进预览显示——预览本就不发送，提案在那里没有持久效果可谈。代价的两面：跑，预览会触发插件的副作用（它自己的计数、它自己的存储写入——宿主管不了，§5.5）；不跑，预览显示的 prompt 与真正发出的不是同一份，而「预览 = 将发送」正是这条 seam 存在的理由（ST 平面在预览路径同跑，#6 的注释原文）。两害相权，显示保真优先。列入待裁决 5 供协调人否决。

### 4.3 两条支线

- **中止**：`#fail`（`packages/iris-app-service/src/service.ts:5319`）在 `signal.aborted && partial.length > 0` 时仍结算（`:5375`），走同一个 `#settle`，`reason: 'aborted'`。此时第 18–29 步照跑，但 `afterReplyText` 的调用点查 `signal.aborted` 为真而跳过（§5.3）——残句按用户停止时的原样定形落库，钩子不在用户按下停止后再改用户已认可的文本；`onSettle` 照跑，视图 `reason` 为 `'aborted'`。
- **卡片发起的生成**：`script.generate`/`script.generateRaw`（handler `service.ts:3990`，`#generateRaw` 定义 `:5844`）**不经过** prompt 构建（直接对 `#stream` 发一个裸 messages 数组，`:5857` 起的注释写明 no `entry` 的理由），也不经过结算。三个钩子在这条路径上**一个都不跑**；这条路径整轮握着 `guardTavernHelper` 的 TH lease（`:4519`）。要给旁路生成挂钩子，是另一个设计。

## 5. 失败、超时、取消、释放

### 5.1 失败：`hook-failed`（Q5）

`hook-failed` 这个名字由 U2 定义（任务单 U2 裁决第三条）、本设计只引用，不改名、不假设其实现。它与既有六个失败态（`packages/iris-protocol/src/system-plugins.ts:27`–`:33`）的共处规则：

- **不走 `markFailure`**（`packages/iris-app-service/src/system-plugins.ts:423`）。该方法的第一句话就是「Put a named failure on a row **and stop it running**」，且会同时 `enabled = false`、`status = 'error'`（`:426`–`:427`）——与「本轮继续、下一轮还要继续调用」（约束 4）直接冲突。走一个并行的记录入口（实现侧暂名 `noteHookFailure(id, failure)`，最终名归 U2）：只写 `#failures` 与 `plugin.error`，**不动 `enabled`、不动 `status`**。
- **不进 `ENABLE_BLOCKING_FAILURES`**（`packages/iris-app-service/src/system-plugins.ts:105`）。四个进集合的状态都是「对安装的事实、重试无法改变」；`hook-failed` 是运行期瞬态，按约束 4 永不阻塞 enable。
- **一个插件只有一个 `failure` 字段**（`packages/iris-protocol/src/system-plugins.ts:36`），连续 N 轮超时/抛错 → **一条，每轮覆盖**。它回答「这个插件现在坏吗」，不是历史；历史由 `#report` 承担——每条 hook-failed 同时是一条 `#report`（`kind: 'hooks'`；超时 `grade: 'note'`、抛错 `grade: 'fault'`，消息带钩子名、耗时与错误摘要）。`field` 填钩子名（`beforePrompt`/`afterReplyText`/`onSettle`），一个插件三个钩子才分得清是哪个。
- **清除时机**：①任何 committed transition——`#commit` 已有此行为（`packages/iris-app-service/src/system-plugins.ts:1104`）；②重启——`#failures` 本就不持久化（`:252`–`:257`，六态全是开机重推导的）；③（新增，待裁决 4）同一钩子下一次完整成功也清除——行上不该长期挂着一个已恢复的失败。
- 隔离粒度：一个钩子失败只作废**那一次调用**的产出；同插件的其他两个钩子、其他插件的钩子照跑（Q14 的后半）。
- 被停用导致的 `isCurrent()` 为假**不是** hook-failed（§5.4）——插件没做错任何事。

### 5.2 超时（Q8）

**每钩子各 5 s**，不是全部合计。合计会让第二个钩子拿到残余预算，实际耗时变成注册顺序的函数，比各 5 s 更不可预测。约束 4 保证的是「绝不阻塞、绝不撕回复」，**不保证「不慢」**：钩子在结算路径上被 await，耗时直接加在回合尾延迟上，一个三个钩子全注册的插件最坏贡献 15 s——写在这里，是诚实的代价声明。

已经在跑的 Promise 杀不掉，所以「5 s 后继续」拆成三句：

1. 宿主 `Promise.race([fn(view), deadline(5_000)])`——超时后宿主不再等，管线继续；
2. 后来 resolve 的值**丢弃**：超时后本轮不再有该钩子的消费者，晚到的提案/替换文本结构上到不了任何落地写面，不可能污染下一轮（每轮的钩子结果只被本轮的合并点读取）；
3. 后来 reject 必须**接住**：宿主保留被抛弃的 promise 引用并挂 `.catch`，记一条 §5.1 的上报——否则是未捕获拒绝，宿主进程的 unhandledRejection 面多了一条与业务无关的噪声。

与 ST 桥的 1.5 s（`packages/iris-app-service/src/service.ts:6364` 的 `#ST_COMPAT_DEADLINE_MS`）**不统一，也不该统一**：桥的预算大头在跨帧旅行（广播 → 沙盒 iframe 执行 → postMessage 回，`service.ts:6454`–`:6455`），钩子是同进程函数调用，预算给的是插件自己的计算。两个常量落地时注释互相指向，说明为什么不同。U3 的 `scope.storage` 在钩子内可用，其耗时**计入本钩子的 5 s**。

### 5.3 取消（Q9）

信号来自 `entry.begin(turn)`（`packages/iris-app-service/src/entry.ts:981`），整轮一个。两个机制都要：

- **宿主检查**（约束 5 的落实）：每个**提案型**钩子（`beforePrompt`/`afterReplyText`）调用前查 `signal.aborted`，为真则跳过该钩子**及其后所有**提案型钩子调用——不是只跳当前。
- **视图携带 signal**（§3.1）：交给钩子自觉，长计算里自查自停。

与「aborted 也要结算」（#22）的相撞，裁决为：**约束 5 的「不再调用后续钩子」适用于提案型钩子；`onSettle` 是终态通知，每个 `#settle` 出口都跑**。理由：`stream.end` 在 aborted 也广播（`service.ts:5267` 不区分 `reason`），`onSettle` 与它同性质——它不修改任何东西（返回值忽略），跳过它只会让插件错过「这轮结束了」的事实；而提案型钩子在用户停止后修改用户已认可的残句，违背「停止 = 保留」的结算语义（`#settle` 对 partial 的注释原文）。本条是对约束 5 字面范围的界定而非推翻，仍列待裁决 1。

### 5.4 释放（Q10）

- **注册随 activation 的 fiber 撤销**：注册表挂在 activation 上，实现照 `registerRpc` 的既有模式（`packages/iris-app-service/src/system-plugins.ts:928`–`:960` 的 `context.effect`）——disable、reload、卸载、更新换代都 dispose fiber，注册随之消失。`Disposable` 是插件提前自撤的口。U1 的更新事务（disable 旧代 → enable 新代）因此**自动**等于「钩子全撤、新代重注册」，本设计不需要为 U1 写任何东西。
- **`isCurrent()` 两处查**：①每次调用前（与 `signal.aborted` 检查同一点）为假 → 不调用；②钩子 resolve 之后、采纳其产出（合并提案/替换文本）**之前**再查一次，为假 → 静默丢弃，不上报 hook-failed。照抄既有先例的理由：`computeVariables` 在算完之后、写之前再查一次，注释写明「object identity is the incarnation token」（`packages/iris-app-service/src/entry.ts:1102`–`:1105`）——运行期转移在类外串行，但 capability（和钩子注册）可以在任意异步间隙被换代，只有提交边的身份复查能挡住旧代写入。
- 返回值非法（`beforePrompt` 替换了不存在的 id、`afterReplyText` 返回非字符串）按失败处理：产出作废 + §5.1 上报，本轮继续。

### 5.5 钩子不准做什么（Q7）

先把信任模型写平：**系统插件是与宿主同权的 Node 代码**（`docs/SYSTEM-PLUGINS.md`「Trust model」，2026-09-15 成文），`PLUGIN_PERMISSIONS` 是宿主展示与拼写检查的**声明**、不是边界——U3 裁决里「`plugin-storage` 是词表第一个带后果的权限」反证了其余成员都不带后果。在这个前提下，「禁止联网」写不出来。诚实的分类是三层：

1. **宿主强制执行的**：超时切断（§5.2）、abort 后跳过（§5.3）、lease 撤销后不再调用与产出作废（§5.4）、视图只读（冻结的浅拷贝投影；改视图的写入要么落在拷贝上无效、要么抛 TypeError）、产出只经提案/替换通道落地（宿主校验后才进 `resolved`/`settledText`）。
2. **算 bug、被上报的**：抛错与非返回（§5.1）→ `hook-failed` + 上报，回复照常。
3. **宿主管不了、只能约定的**：钩子内发起网络请求、故意把 5 s 烧满的同步死循环（Node 杀不掉同步代码，§5.2 第一句的根源）、写别的插件的数据、在钩子里做本该在 `activate` 里做的事。这些写成作者契约（后续进 authoring 文档），**文档不假装宿主能强制它们**——那是在撒谎。

钩子视图里**没有** `ScriptContext`，也没有变量表：前者是 §8 那行的单体，拆它是另一条线（§1 非目标）；后者——插件要读变量走 U2/U3 的面，钩子视图只给生成自身的形状。

### 5.6 遥测（Q11）

**第一阶段不记账**：钩子耗时不成为 `recordUsage`/`recordTiming` 之外的第三份账，不挂 candidate。每轮既有两份记账是刻意分开的，各自的注释（`packages/iris-app-service/src/service.ts:5225`–`:5232`）说明每一份都要有明确的读者；钩子耗时今天的读者只有一个——排查慢回合的人，而 §5.1 的上报（带耗时）已经喂到他。等出现第二个消费者（比如要在插件中心显示钩子开销）再立第三份，理由届时写。超时与抛错的上报见 §5.1，hook-failed 的行上状态就是它的「账」。

## 6. 顺序（Q12）

**「激活顺序」今天是不可读出的量**，这是要造的规则不是要观察的现状：`#enableOrder`（`packages/iris-app-service/src/system-plugins.ts:1018`）是每次 enable 现算的单起点 DFS，同层顺序取 `dependencies` 数组声明序，没有字典序；启动外层循环按 `#plugins` Map 插入序遍历（`:511`–`:521`）；`Activation`（`:136`）只有 `fiber`/`incarnation`/`revision`，没有全局序号。可计算定义：

```
computeActivationOrder(enabled: readonly SystemPluginDefinition[]): readonly SystemPluginDefinition[]
  输入：当前已启用（enabled 且 activation 在场）的定义集合
  输出：全序，满足
    ① 依赖先于依赖者（对每个 d ∈ output，d.dependencies 里已启用的都在 d 之前）
    ② 同层按 id 字典序升序（Kahn 算法，ready 集合每次取 id 最小者）
    ③ 与用户 enable 的点击先后无关
    ④ 与 #plugins Map 的插入序无关
  环：enable 路径已拒绝（#enableOrder 的环检查，system-plugins.ts:1024–:1030），
      运行期仍遇环 → internal 上报，本轮该插件列表整体不调（防御，不该到达）
```

- **每轮生成现算一次**，不缓存到 runtime 上。顺序只被钩子轮询（和 U2 的 writer 轮询）消费，一轮一次对已启用集合（今天 2 个）的拓扑排序成本可忽略；缓存则要新增「随 revision 失效」的失效路径，为一个零成本计算买一个新状态，不值。
- **与 U2 是同一个实现**：一个函数、一个模块（建议 `packages/iris-app-service/src/plugin-order.ts`），U2 的 writer 轮询与 U4 的钩子轮询共用。谁先合入谁落地函数，后合入的**删掉自己的临场实现改用同一个**——不是两个各自正确的实现。本稿不替 U2 定 `registerWriter` 的形状。
- **插件内的注册序**（Q14 前半）：同一插件对同一钩子注册两次是**两个参与者**，按注册序（`activate` 里的调用序，确定），不覆盖——后者覆盖前者是「静默丢一个」的形状，与 app-service 偏差账 §76 记的那个 bug（后写吞先写、损失被 last-writer-wins 藏住）同型。参与者全序 =（激活序，注册序）的字典序；`Disposable` 各自可撤。
- **失败不换序**：一个钩子超时/抛错，队列里剩下的钩子按原序继续（失败只作废那一次的产出，§5.1）。

## 7. 与相邻机制的关系

### 7.1 U2 · 插件可写变量（Q4）

**`onSettle` 与 `propose` 不是一回事，是同一轮结算的两个时刻**。事实：今天结算已有两个提案者（#15/#16），提案形状 `VariableProposal { pluginId, before, after }`（`packages/iris-app-service/src/variable-arbitration.ts:14`）要求提案者返回整表、宿主算增量；提案发生在 `replaceVariables` 落盘（`service.ts:5204`）**之前**；`stream.end` 在 `:5267`。于是：U2 的 `propose` 是「仲裁前」的**写入面**，返回值有语义（参与仲裁）；`onSettle` 是「落盘后」的**读取面**，返回值被忽略。合并它们意味着一个调用点两种语义、且两个面在 `aborted` 下的门都不同（writer 受 `recordVariables` 门，`onSettle` 不受）——不做。

**一个插件既想写变量又想在落盘后做别的事：注册两次**——`scope.variables.registerWriter(...)` 一次 + `scope.hooks.onSettle(...)` 一次，靠 `view.turn` 关联两件事。两边顺序共用 §6 的同一个函数；`hook-failed` 名字引用 U2 的定义；本稿不假设 U2 会改 `markFailure`（§5.1 的新入口正是为了让 U2 不必改它）。

### 7.2 ST 扩展平面（Q15）

**ST 平面不改走 `scope.hooks`，本设计保留它在两个钩子位置上的特权。**理由：它的调用形状根本不同——不是同进程函数调用，是 ticket + 广播进沙盒 iframe + 等待 postMessage 回（`service.ts:6441`–`:6455`），带 revision fence、deadline、结果校验（`validateReplyResult`，`:6496`）与「失败降级为原文」的语义；它的执行体是第三方 JS，跑在另一条信任线上（`docs/SYSTEM-PLUGINS.md`：沙盒 iframe vs 同权 Node）——三个钩子的契约（同权代码、5 s、同步等返回值）对它一条都套不上。它今天已经是一个系统插件（一个 ST 扩展就是一个系统插件，`docs/INFRASTRUCTURE-INTERFACES.md:312`），对 prompt 的介入是它自己 capability 的实现细节，宿主调的是 `#options.stCompat` 的注入面，不是注册表。

因此本稿**不能**说「三个钩子统一了 prompt 期的插件介入」。ST 平面在 `beforePrompt` 之前改写 contributions、在 `afterReplyText` 的位置换文本——钩子看到它的结果、排在它后面（§4 的位置决定）；它就地改写（而非提案）与写变量的旧行为是否将来收敛，需要一个跨帧提案协议的独立设计，不在三个同进程钩子的射程内。`#processReplyViaStCompat` 今天「换文本 + 交提案 + 自己写变量」三件事同一次调用（#15）是这个特权最刺眼的样子，记录在案，不在本稿修。

## 8. 分阶段落地

每步一个 PR，独立合入、独立回滚；第一步不碰 prompt 构建。

- **PR-A：只做 `onSettle`**。最小一步：只通知、返回值忽略（约束 2），不用答 Q2/Q3，`hook-failed` 语义在此最容易验证——一个只通知的钩子超时，回复必须原样落地。落点 `stream.end`（`service.ts:5267`）之后（§4）。前置：U2 的 `hook-failed` 入口已落地；若 U2 未合，本 PR 自带 §5.1 的最小版本并在 ledger 写明与 U2 的合并计划。
- **PR-B：`afterReplyText`**。必须先裁决待裁决 1（aborted 下 onSettle 仍跑）与 2（相对 MVU 的顺序），并落定 §4 的三个「之前还是之后」。TH regex 映射（#20）在此步被逼到台前：钩子输出会再过一遍 assistant regex。
- **PR-C：`beforePrompt`**。最难：Q2（表示）、Q3（撞段）、Q13（预览路径）、与 ST 平面共处（#5）全压在这步，放最后。
- **不建议的切法**：按插件切（先 TH 后 MVU）。TH 今天的调用点落在 #1（宏遍，映射不上）与 42 个 RPC 方法（#26），MVU 的落点 #16 属于 U2——按插件切会让第一个 PR 同时动 U2 的地盘和一个映射不上的点。

## 9. 被否决的方案

1. **钩子做成 Cordis 事件（`ctx.on`/`ctx.emit`）**。`notes/PLUGIN-FEASIBILITY.md` §6 曾把它列成「Cordis 已给」。否决，违反约束 2 与 3：①`emit` 无返回值，`beforePrompt` 要收提案、`afterReplyText` 要收替换文本，只能广播的通道表达不了；②事件监听器无顺序保证，约束 3 要确定全序；③本仓今天零事件（§2 四条 grep 的第四条零命中），引入事件总线等于同时引入一套新调试面与新失败模式，收益只是省一个成员名。
2. **钩子做成 `registerRpc` 方法（宿主回调插件的 RPC）**。违反约束 2 的注册口。`registerRpc`（`packages/iris-plugin-api/src/index.ts:132`）的方向是外部请求进宿主，schema 校验、`pluginRevision` fence、`unsupported` refusal 全为那个方向设计（`:106`–`:131` 的 docblock）；反向硬凑会让「一个方法名被占」与「一个钩子被注册」变成同一件事，而钩子允许多插件并存、RPC 方法名全组合唯一（`packages/iris-app-service/src/system-plugins.ts:926` 的注释：重名在 `activate` 里直接抛）。
3. **可变视图（钩子直接改 prompt/文本）**。违反约束 2（只读视图 + 提案）。补充：#5 的 ST 平面正是就地改写，而那条路径只有一个参与者；两个参与者时，第二个看到的输入取决于第一个做了什么，冲突无法上报也无法复现——正是 app-service 偏差账 §76 那个 bug 的形状（两个写者两次提交，后写吞先写）。
4. **每钩子带 `priority` 数字**。违反约束 3。激活顺序已给全序，再加优先级是两套顺序；优先级是插件自己声明的，把自己设成最高没有代价，一年后这个字段只剩噪音。「我要在某某之后」的正确表达是 `dependencies`（已有，`#enableOrder` 已按它排序）。
5. **钩子挂在 `AppServiceOptions` 上**（`docs/INFRASTRUCTURE-INTERFACES.md:340` 括号里的写法）。违反约束 1 的注册口。`AppServiceOptions`（`packages/iris-app-service/src/service.ts:491`）是组合根注入依赖的地方，只有宿主能填；插件在 `activate` 里拿到的是 `scope`，够不着它。挂那里等于「只有宿主能注册钩子」，而这条缺口的全部意义是让**插件**注册。

## 10. 待裁决问题（≤5）

1. **`onSettle` 在 aborted 结算仍跑（§5.3）**——对约束 5「abort 后不再调用后续钩子」的范围界定：提案型钩子受它约束，通知型不受。不裁决的后果：按本稿实现；若协调人要字面执行，aborted 轮 `onSettle` 缺席，插件错过「这轮结束了」的事实，且与 `stream.end` 在 aborted 照发不一致。
2. **`afterReplyText` 定形先于变量提案（§4）**——变量提案器解析钩子改后的文本；反过来（钩子排在仲裁后）则钩子改的文本不被任何变量面看到。不裁决的后果：PR-B 无法落点，两个顺序都自洽但必须选一个。
3. **钩子要不要一个声明式权限名（如 `generation-hooks`）**。本稿倾向不加：注册钩子不给插件任何它本来没有的触达（视图只读、产出经校验），加一个无后果的名字违背 U3 确立的「声明 vs 后果」区分；但同意页要不要向用户披露「此插件挂了生成钩子」是产品问题。不裁决的后果：第一阶段同意页不显示钩子面，将来要加是追加式。
4. **`hook-failed` 的清除时机第三条（§5.1：同一钩子下一次完整成功即清除）**。前两条（committed transition 清除、重启即清）是既有行为，引用即可；第三条是新增语义，且 `hook-failed` 名字归 U2——清除规则应与 U2 一并裁定。不裁决的后果：失败标记挂到下次 enable/disable 或重启，行上可能长期展示一个已恢复的失败。
5. **`beforePrompt` 在 `prompt.itemize` 预览路径也跑（§4.2）**。不裁决的后果：按本稿实现，预览触发插件副作用（宿主管不了的那类，§5.5）；协调人若选「预览不跑」，接受「预览与实发不一致」并要求实现侧把差异写进预览面板。

### 裁决记录（2026-09-16，协调人）

1. **`onSettle` 在 aborted 结算仍跑。** 约束 5「abort 后不再调用后续钩子」只约束提案型钩子（`beforePrompt`、`afterReplyText`）；通知型的 `onSettle` 与 `stream.end` 同步——aborted 轮照发。
2. **`afterReplyText` 先于变量提案。** 文本先定形、变量后解析；变量写者（U2）看到的是钩子改后的文本。PR-B 按此落点。
3. **钩子不加声明式权限名。** 注册钩子不给插件任何它本来没有的触达；「此插件挂了生成钩子」的披露作为同意页的产品问题延后，第一阶段不做。
4. **`hook-failed` 的第三条清除规则成立：同一钩子下一次完整成功即清除。** 与 U2 已落地的 `clearHookFailure`（写者下一次成功提案清除）同一语义、同一名字；实现时复用 U2 的 `noteHookFailure`/`clearHookFailure`，不另起一套。
5. **`beforePrompt` 在 `prompt.itemize` 预览路径也跑。** 预览就是「将要发出的」；预览可能触发插件副作用属 §5.5 第三类（只能约定），写进预览面板的说明即可。

设计据此定稿；实现阶段按 §8 分 PR-A/B/C，每步单独立项、单独验收。

## 11. 本文件与 §8 的关系

`docs/INFRASTRUCTURE-INTERFACES.md:340` 的「生成钩子（`AppServiceOptions`）」行，本设计合入后应改为：**「设计已定（`docs/GENERATION-HOOKS.md`），实现未开始」**，并把括号里的 `AppServiceOptions` 更正为 `scope.hooks`——`AppServiceOptions` 是组合根的依赖注入口（§9.5），注册口在 `SystemPluginActivationScope` 的新只读成员 `hooks` 上。该行由协调人改，本设计不触碰那个文件；`docs/INFRASTRUCTURE-INTERFACES.md:342`（插件可写变量）与 `:341`（storage）两行的闭合分别归 U2/U3。
