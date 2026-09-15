# U2 施工文档 · 插件可写变量：把写死的 pluginId 换成注册表

## 1. 任务身份

| 项 | 值 |
| --- | --- |
| 分支 | `dev/plugin-variable-writers`（从 `origin/main` 开） |
| 基线 | `main` `269a97e`（任务单写的是 `e03adbb`，本文所有行号取自 `269a97e`；这两个提交对本任务涉及的文件无差异，行号可直接用） |
| ledger | `notes/packages/iris-app-service/DEVIATIONS.md` §82（§80 是现存最后一节，§81 由 U1 占用） |
| 任务单 | `notes/INFRA-TASKS-2026-09-15.md` §0、§1、U2 节 |
| 预计规模 | 产品代码 5 个包：`iris-protocol`（+1 个状态）、`iris-plugin-api`（+1 个 scope 成员与 3 个类型）、`iris-app-service`（注册表 + 结算重写 + MVU writer）、`iris-web`（2 张 failure 文案表 + 4 个 i18n 键）；新测试 1 个文件 + 1 个夹具插件；改既有测试 2 个文件（都是"加一行使其更严"，不含任何变量结算测试） |

预期 diff 量级：`packages/iris-app-service/src/service.ts` 约 −45/+30 行；`system-plugins.ts` 约 +70；`plugins/mvu.ts` 约 +55；其余各包十几行。

---

## 2. 前提纠正与现状

### 2.1 前提纠正（代码赢）

任务单 U2 节的「现状」一段有四处与 `269a97e` 的代码不符。**这四条都不是措辞问题，其中两条直接改变施工范围**，PR 说明第一段要照抄。

**纠正 1：任务单点的两个锚点不是要删的那两处。**
任务单说「回复结算处按名点 Tavern Helper 和 MVU（搜 `plugins.lease('tavern-helper')`、`plugins.lease('mvu')`，约 `:5006`/`:5014`）」。实际：

- `service.ts:5006-5008` 的 `plugins.isEnabled('tavern-helper')` / `plugins.lease('tavern-helper')` **与变量写入无关**。Tavern Helper 的能力是 `TAVERN_HELPER_CAPABILITY = 'macro-expander'`（`packages/iris-app-service/src/plugins/capabilities.ts:15`），唯一消费点是 `packages/iris-app-service/src/entry.ts:761-763` 的 `tavernHelperCapability(...).expandMacros(...)`，即提示词装配时的宏展开。这个 lease 是**整轮生成期间的存活凭据**，删掉它宏展开会在生成中途被停用打断。**它必须原样保留。**
- `docs/INFRASTRUCTURE-INTERFACES.md:342` 的 §8 行点的才是对的两处：`service.ts:5119`、`:5142`（在 `269a97e` 上分别是 `:5174` 和 `:5197`），即两个 `VariableProposal` 字面量 id。`docs/PLUGIN-AUTHORING-RUNBOOK.md:208` 同样点这两个位置。

**纠正 2：写变量的两方不是 TH 和 MVU，是「ST-compat 桥」和 MVU。**
第一条提案的 `pluginId` 是硬编码字符串 `'prompt-template'`（`service.ts:5174`），数据来自 `#processReplyViaStCompat`（`service.ts:6470`），走的是 `this.#options.stCompat`（`StCompatOptions`，`service.ts:477-489`）这条**与插件 runtime 无关**的通道——浏览器里的 ST 扩展平面。它和 `tavern-helper` 这个内置插件没有任何调用关系。任务单说「TH 与 MVU 两个内置插件改走同一个注册表（在 `plugins/tavern-helper.ts`、`plugins/mvu.ts` 的 `activate` 里注册）」：**`tavern-helper.ts` 不该动**，`TavernHelperCapability` 只有 `revision` 和 `expandMacros` 两个成员（`plugins/tavern-helper.ts:15-20`），没有变量可写。要接进注册表的是 ST-compat 那一侧，它的注册者是宿主（`service.ts`），不是某个 `activate`。

**纠正 3：`'prompt-template'` 这个字面量在生产里多半是错的。**
ST-compat 试点扩展的真实 id 是 `st.extensionId()`（`service.ts:482`），实现在 `packages/iris-app-service/src/index.ts:864-866`：取快照里第一个 `installed` 且 id 不是 `tavern-helper`/`mvu` 的行——也就是**用户装的那个 ST 扩展目录名**（`index.ts:847-852`，`adoptDefinition(buildStExtensionDefinition({ id: entry, ... }))`，`entry` 是 `extensions/installed/` 下的目录名）。只有当目录恰好叫 `prompt-template` 时 `:5174` 的字面量才等于真 id。测试夹具用的正是 `'prompt-template'`（`packages/iris-app-service/tests/variable-arbitration.test.ts:213` 的 `stCompat.plane.detach({ extensionId: 'prompt-template' })`），所以这个错误今天不会被任何断言抓到。冲突上报里的 `earlierPluginId` 因此可能指向一个目录里根本不存在的 id。**本任务顺手修掉：ST-compat writer 注册时用 `st.extensionId()`。** 既有变量测试仍绿（夹具 id 就是 `prompt-template`）。

**纠正 4：`markFailure` 不能用来记 `hook-failed`。**
`SystemPluginRuntime.markFailure`（`system-plugins.ts:423-429`）会同时做 `plugin.enabled = false; plugin.status = 'error'`。裁决要求 writer 抛错「结算继续，不阻塞回复」，插件当然也不该被停用。所以 `hook-failed` 需要一条**不改 `enabled`/`status`** 的新路径（见 §4.5）。连带地，`packages/iris-protocol/src/system-plugins.ts:72-75` 的注释「`failure` 是 `status: 'error'` 的一个 refinement」在加入 `hook-failed` 后不再成立，必须改。

### 2.2 现状：结算处每一个点名插件的位置

`#run` 的租约段（`service.ts:5003-5031`）与 `#settle`（`service.ts:5122-…`）：

| 位置 | 符号 | 今天做什么 | 变成什么 |
| --- | --- | --- | --- |
| `service.ts:5003` | `const impersonating = request.kind === 'impersonate'` | 本地布尔，喂给下面两处 | 保留；另把 `request.kind` 原样传进 `#settle`（`options.kind`），writer 自己看 `view.kind` |
| `service.ts:5006-5008` | `plugins.isEnabled('tavern-helper')` / `lease('tavern-helper')` | 生成期间锁住宏展开能力 | **不动**（纠正 1） |
| `service.ts:5013` | `let mvuExecution: MvuExecution \| null \| undefined` | 三态：无 runtime = `undefined`（走 `COMPAT_MVU`）、runtime 里 MVU 停用 = `null`、启用 = 捕获的 incarnation | 删除。三态由「快照到的 writer 列表 + 每个 writer 一把 lease」表达：无 runtime → 宿主自己登记一个 legacy MVU writer；停用 → 列表里没有它；启用 → 列表里有且持 lease |
| `service.ts:5014` | `if (!impersonating && plugins?.isEnabled('mvu') === true)` | 扮演时整条 MVU 路关掉 | 删除。扮演的判断搬进 MVU writer 的 `propose`（`view.kind === 'impersonate'` 即 `return undefined`） |
| `service.ts:5015-5016` | `plugins.lease('mvu')` / `plugins.capability<…>('mvu', MVU_CAPABILITY)` | 取能力并检查 | 删除。writer 在 `activate` 里就闭包住了本次激活的 `MvuCapability`，取不到能力的窗口不存在 |
| `service.ts:5018-5022` | 取不到能力就 `throw new AppError('internal', 'MVU is enabled without its runtime capability')` | 启用却无能力视为宿主自身故障 | 删除（同上，该状态不可达）。此行为变化要写进 ledger |
| `service.ts:5026-5031` | `releasePluginLeases()` | 逆序释放 | 保留，扩成「释放 TH 的 lease + 每个 writer 的 lease」 |
| `service.ts:5077` | `recordVariables: !impersonating` | 同时关掉：trim、ST-compat 提案、MVU 提案、提交 | 语义收窄成**只管 trim**（`:5144`），变量侧由 writer 自己判断 |
| `service.ts:5166` | `const variableBaseline = entry.variables.getVariables(messageOption)` | 本轮消息层表，既作仲裁基线，也作 ST 提案的 `before` | 保留；进 `view.baseline` |
| `service.ts:5167` | `const proposals: VariableProposal[] = []` | 提案数组 | 保留；由 writer 循环填充 |
| `service.ts:5168-5180` | `#processReplyViaStCompat` + `pluginId: 'prompt-template'` | 跑桥，拿回 `{ text, floorVariables }`，`text` 覆盖 `settledText`，`floorVariables` 入提案 | 拆两半：**桥调用留在原地**（它改写 `settledText`，writer 契约不承载文本改写），结果停在一个本轮局部槽里；提案由宿主登记的 ST-compat writer 从槽里取 |
| `service.ts:5181-5206` | `entry.computeVariables(...)` + `pluginId: 'mvu'` + `arbitrateMessageVariables` | MVU 提案 + 一次仲裁 + 一次 `replaceVariables` + 冲突上报 | MVU 那段删掉；仲裁、提交、上报三段**逐字不动** |

### 2.3 仲裁的顺序与冲突语义（不改）

`packages/iris-app-service/src/variable-arbitration.ts`：

- `arbitrateMessageVariables(baseline, proposals)`（`:100`）按 `proposals` 的**数组顺序**逐个应用 `changes(proposal.before, proposal.after)` 的增量。参与合并的只有增量，不是完整表——所以互不相干的键不会被后手的完整快照抹掉（模块头注释，`:1-10`）。
- 冲突判定（`:107-116`）：一条变更的路径与**任何**已应用路径前缀重叠（`overlaps`，`:88`）且属主不同，就记一条 `{ key, earlierPluginId, laterPluginId, winnerPluginId }`，`winnerPluginId` 恒为后手。
- 顺序的事实来源是 ledger §76（`notes/packages/iris-app-service/DEVIATIONS.md:7149`，2026-09-14 在一次性 ST 副本上实测）：ST-Prompt-Template 用 `eventSource.makeFirst(CHARACTER_MESSAGE_RENDERED, …)` 注册，卡脚本运行时与 MVU 随后收到同一事件。

**算法一行不改，只换输入来源。**这是任务单的原话，也是"既有变量结算测试一条不改仍绿"的技术前提。

### 2.4 既有变量结算测试（零改动区）

| 文件 | 测试 | 为什么会被本任务碰到 |
| --- | --- | --- |
| `packages/iris-app-service/tests/variable-arbitration.test.ts` | `:170` 互不相干提案一次提交；`:182` 同键冲突按 ST 顺序、MVU 胜（断言报文里含 `prompt-template`、`mvu`、`mvu won`）；`:198` 停用任一方另一方仍是唯一提交者；`:217` 纯仲裁器单测 | 整条结算链路的主证；`:198` 的 `plugins.disable('mvu')` 与 `stCompat.plane.detach` 正是「lease 撤销 ⇒ 提案消失」的既有证据 |
| `packages/iris-app-service/tests/st-compat-floor-variables.test.ts:138/:165` | 桥上下文的楼层变量水合 | 桥调用点被移动就会红 |
| `packages/iris-app-service/tests/system-plugin-extraction.test.ts:109/:142/:175/:213` | MVU 启停保状态、停用不播种、能力被换掉时丢弃计算结果、无 runtime 时走 `COMPAT_MVU` | `:175`/`:213` 直接调 `entry.computeVariables(…, execution)`，本任务**不改 `entry.computeVariables` 的签名与语义** |
| `packages/iris-app-service/tests/generation-kinds.test.ts:251` | 「an impersonate leaves the MVU pathway alone」 | 扮演语义从 `!impersonating` 分支搬进 writer 后，这条既有断言就是新实现的验收 |
| `packages/iris-app-service/tests/mvu-dropped-commands.test.ts` | 丢弃命令的上报 | 上报回调从 `#settle` 移进 writer，报文必须逐字相同 |

**验收：这五个文件 `git diff` 为空。**

---

## 3. 裁决与待定决定

### 3.1 协调人裁决（不重开）

1. 经激活作用域注册，不加分支：`scope.variables.registerWriter({ baselineFor, propose })`，返回撤销句柄；`SystemPluginActivationScope` 新增只读成员 `variables`。
2. 顺序 = 激活顺序（依赖先于依赖者，同层按 id 字典序），等价于今天 ST 在前、MVU 在后；后者胜、冲突上报语义不变。
3. 一个 writer 抛错或超时（5 s）：该 writer 的提案作废，行上记 `failure: { state: 'hook-failed', … }`，结算继续，不阻塞回复。`hook-failed` 在这里定义，U4 引用。
4. `PLUGIN_PERMISSIONS` 加 `write-variables`，同意页自动显示；读不需要权限。
5. ST-compat 与 MVU 改走同一个注册表，`service.ts` 结算段删掉按名分支，行为逐字不变。

### 3.2 施工者需要定的事（本文给出推荐，照做即可）

**D1 · `VariableWriter` 的确切类型。** 推荐（放 `packages/iris-plugin-api/src/index.ts`）：

```ts
/** 消息层变量表。@iris/variables 的 `Variables` 在契约包里的同形重述——
 *  契约包按 tests/contract.test.ts 不得 import 任何 @iris 包，同 ScopedRequestSchema。*/
export type PluginVariableTable = Record<string, unknown>

/** 一轮生成的种类，与协议的 `chat.send` kind 同名同值。 */
export type VariableWriteKind = 'send' | 'regenerate' | 'continue' | 'impersonate'

/** writer 在一次结算里看到的全部事实。只读，宿主构造，不跨结算复用。 */
export interface VariableWriteView {
  readonly chatId: string
  readonly turn: number
  readonly kind: VariableWriteKind
  /** 跑完还是被叫停。被叫停的轮次仍会结算它已有的文本。 */
  readonly reason: 'completed' | 'aborted'
  /** 结算文本，已过 trim 与 ST-compat 改写，即将落盘的那一份。 */
  readonly text: string
  /** 本轮消息层表，任何 writer 提案之前的样子。 */
  readonly baseline: PluginVariableTable
  /** 更早某轮存下的表；那一轮没有候选就是 undefined。 */
  variablesAt(turn: number): PluginVariableTable | undefined
  /** 卡与世界书声明的初始表，任何一轮之前的样子。 */
  readonly declared: PluginVariableTable
  /** 5 s 预算耗尽时 abort。忽略它不会让 writer 免于被裁掉（见 §4.6）。 */
  readonly signal: AbortSignal
}

export interface VariableWriter {
  /** 本 writer 的提案是相对哪张表的增量。 */
  baselineFor(view: VariableWriteView): PluginVariableTable
  /** 提案：完整表，或 undefined 表示这一轮不写。 */
  propose(view: VariableWriteView): PluginVariableTable | undefined
    | Promise<PluginVariableTable | undefined>
}

export interface PluginVariableFace {
  /** 登记一个变量 writer；返回撤销函数，幂等，随本次 activation 的 fiber 自动执行。 */
  registerWriter(writer: VariableWriter): () => void
}
```

三点理由，每一点都是代码逼出来的：

- **`baselineFor` 必须存在，因为两个写者的 `before` 今天就不是同一张表。** ST 提案的 `before` 是 `variableBaseline`（`service.ts:5173`，即消息层原表）；MVU 提案的 `before` 是 `entry.baselineFor(turn)`（`service.ts:5199`，`entry.ts:1019-1031` 里那个「向前找最近一张 `isMvuData` 的表，找不到就用 `initVars()`」的走法）。两者不可互换，所以 `before` 只能由 writer 自己说。
- **签名取 `view` 而不是任务单写的 `baselineFor(turn)`。** MVU 的走法要读更早轮次的表和卡的声明表，光给一个 `turn` 数字算不出来。改签名是代码赢的结果，写进 PR 说明。
- **返回撤销函数 `() => void`，不是 cordis 的 `Disposable`。** `scope.provide` 与 `scope.registerRpc` 都返回 `() => void`（`plugin-api/src/index.ts:101`、`:132-136`）；任务单写「返回 `Disposable`」，但 scope 上没有第二种撤销形状，加一种就是给同一个包两套约定。注：`SystemPluginDefinition.activate` 的 `Disposable` 在 runtime 里也只按函数用（`system-plugins.ts:960` 的 `typeof dispose !== 'function'`），所以这不是偏离，是对齐。

`declared` 与 `variablesAt` 是唯一两个"为 MVU 开的口"。可以不开——备选是把 MVU 的基线走法留在 `entry.ts`，由 `service.ts` 在注册时把一个 `baselineFor` 闭包注入给 MVU 的 writer。**否决它**：那等于把 `'mvu'` 这个名字从结算段挪到注册段，本任务就白做了。两个成员都是类型上通用的（一个按轮次读表，一个读声明表），今天只有 MVU 用，写在 docblock 里说清楚。

**D2 · 顺序怎么算、放在哪。** runtime 已经有依赖图：`#enableOrder(id)`（`system-plugins.ts:1018-1048`）是对依赖的 DFS 后序，依赖先出；`NormalizedDefinition.dependencies` 是去重后的数组（`:280-283`）。但**今天没有任何字典序并列规则**——同层顺序落在 `#plugins` 这个 Map 的插入顺序（即 `definitions` 数组顺序）上。裁决要求"同层按 id 字典序"，这是要新加的。

推荐：**不动 `#enableOrder`**（它管的是激活与回滚，动它会牵连 enable/disable 的一大片测试），在注册表里另算一个稳定排序键：

```
rank(pluginId) = [depth(pluginId), pluginId]      // 字典序比较，depth 先
depth(id) = 0                                     // 无依赖
depth(id) = 1 + max(depth(d) for d in deps(id))   // 否则
```

`depth` 从 `#plugins` 里的 `definition.dependencies` 算，环由 `#enableOrder` 在更早的路上已经拒掉（`:1023-1029`），这里再加一个访问集兜底即可。

对今天的三行验算：`tavern-helper` 无依赖 → 0；MVU `dependencies: ['tavern-helper']`（`plugins/builtins.ts:53`）→ 1；被接纳的 ST 扩展行无依赖 → 0。排序结果 `[0,'prompt-template'] < [1,'mvu']`，**ST 在前、MVU 在后**，与 §76 实测一致。注意这个结论**不靠 id 的字母顺序**（`'mvu' < 'prompt-template'`，光按字典序会反过来）——靠的是 MVU 声明了依赖所以 depth 更大。这一点要在代码注释里写死，否则下一个人会把它简化成一次 `sort()` 然后把顺序换掉。风险见 §9.1。

放置：排序在 `SystemPluginRuntime` 里（它是唯一知道依赖图的对象），暴露一个 `orderedVariableWriters(): readonly RegisteredVariableWriter[]`。

**D3 · 注册表怎么持有。** 推荐：`SystemPluginRuntime` 私有 `#variableWriters = new Map<string, Set<VariableWriter>>()`（按 pluginId 分组，一个插件可以登记多个 writer，排序键相同则按登记先后）。

- 登记：scope 的 `variables.registerWriter` 闭包住 `definition.id` 调 runtime 的私有登记；用 `context.effect(...)` 包一层，与 `registerRpc` 同一套（`system-plugins.ts:925-963`），这样 fiber dispose 自动撤销，插件忽略撤销函数也活不过自己的 fiber。
- 宿主侧（ST-compat）：runtime 另开一个**同实现**的内部入口 `registerVariableWriter(pluginId, writer)`，`service.ts` 在构造时用 `st.extensionId()` 作 id 调它。一套实现两个调用者——和 `ScopedRequestSchema`/`RuntimeRequestSchema` 那对同形声明的处理原则一致。
- 撤销：`orderedVariableWriters()` 只返回 `isEnabled(pluginId)` 为真的行的 writer。停用后行不 `isEnabled`，下一次快照就没有它——这正是"禁用一个 writer 它的提案立刻消失"。

**D4 · 无 runtime 的兼容路。** `plugins === undefined` 时今天仍跑 `COMPAT_MVU`（`entry.ts:1092`、`system-plugin-extraction.test.ts:213`）。推荐：`service.ts` 在没有 `plugins` 时，把 legacy MVU writer登记进一个**本地的**、同形的小注册表，id 取 `MVU_PLUGIN_ID`（从 `plugins/builtins.ts:22` import，不写字面量——ledger §77「内置名在 `builtins.ts` 锚一次」）。这是结算路径上唯一剩下的插件身份引用，且它是一个 import 而非引号字符串；§8 的 grep 断言按"引号字面量"写，正好放行。

**D5 · `hook-failed` 怎么置、怎么清。** 见 §4.5。

**D6 · 权限是否成为闸门。** 见 §4.4。推荐：**U2 不设闸**。

---

## 4. 设计

### 4.1 契约（`packages/iris-plugin-api/src/index.ts`）

`SystemPluginActivationScope` 追加一个只读成员，按 §1 并行性约定排在 U3 的 `storage` **之后**（并行冲突时 `storage` 在 `variables` 前）：

```ts
  /** 该 activation 拥有的变量写入面。见 docs/INFRASTRUCTURE-INTERFACES.md §2。 */
  readonly variables: PluginVariableFace
```

`packages/iris-app-service/tests/plugin-manifest.test.ts:322-353` 会读这个接口的源码统计成员。加成员后：

- `members.size >= 6` 的下限断言（`:337`）自动仍过（变 7 或 8）。
- `unmapped` 断言（`:352`）**会红**，因为 `variables` 既不在 `mapping` 里也不在 `identityOnly` 里。
- `assert.deepEqual([...PLUGIN_PERMISSIONS].sort(), Object.keys(mapping).sort())`（`:348`）强制词表与映射同时改。

所以同一步里：`PLUGIN_PERMISSIONS`（`plugins/manifest.ts:88-93`）追加 `'write-variables'`，`mapping` 追加 `'write-variables': 'variables'`，`manifest.ts:70-84` 那张「permission → scope member」表加一行。**这个文件不是变量结算测试，改它是允许的，且只加不减、只变严。** 并行提醒：U3 会在同两处加 `'plugin-storage'` / `storage`；按 §1 约定新名字之间按字母序，`plugin-storage` 在 `write-variables` 前，两者都追加在 `host-context` 之后。

### 4.2 注册表（`packages/iris-app-service/src/system-plugins.ts`）

```ts
interface RegisteredVariableWriter { pluginId: string, writer: VariableWriter }

readonly #variableWriters = new Map<string, VariableWriter[]>()

/** 登记一个 writer。scope 与宿主（ST-compat）共用这一处。撤销幂等。 */
registerVariableWriter(pluginId: string, writer: VariableWriter): () => void
/** 当前 isEnabled 的行的 writer，按 (depth, id) 排序。 */
orderedVariableWriters(): readonly RegisteredVariableWriter[]
/** 这一轮某个 writer 失败了。只写 #failures，不碰 enabled/status/error。 */
noteHookFailure(pluginId: string, reason: string): void
/** 这一轮某个 writer 成功了；行上若是 hook-failed 就清掉，别的 state 不动。 */
clearHookFailure(pluginId: string): void
```

scope 字面量（`system-plugins.ts:896-964`）里追加：

```ts
          variables: {
            registerWriter: (writer) => {
              let teardown: () => void = () => {}
              context.effect(() => {
                teardown = this.registerVariableWriter(definition.id, writer)
                return teardown
              }, `iris-system-plugin:${definition.id}: variable writer`)
              return () => { teardown() }
            },
          },
```

与 `registerRpc`（`:911-962`）同构：`context.effect` 立即执行，撤销挂在本次 activation 的 fiber 上。

### 4.3 结算重写

**今天（`service.ts:5003-5031` + `:5166-5206`，删繁就简）：**

```
#run:
  impersonating = kind === 'impersonate'
  if isEnabled('tavern-helper'): leases.push(lease('tavern-helper'))
  mvuExecution = plugins === undefined ? undefined : null
  if !impersonating && isEnabled('mvu'):
      lease = lease('mvu'); cap = capability('mvu', MVU_CAPABILITY)
      if cap === undefined: release all; throw internal
      leases.push(lease); mvuExecution = { capability: cap, isCurrent: lease.isCurrent }
  … settle(entry, turn, text, 'completed', { recordVariables: !impersonating, mvu: mvuExecution })

#settle:
  baseline = entry.variables.getVariables(messageOption)
  proposals = []
  if completed && recordVariables && turn !== undefined:
      processed = await #processReplyViaStCompat(entry, turn, settledText)
      settledText = processed.text
      if processed.floorVariables: proposals.push({ pluginId: 'prompt-template', before: baseline, after: processed.floorVariables })
  if recordVariables:
      mvu = entry.computeVariables(turn, settledText, report, options.mvu)
      if mvu: proposals.push({ pluginId: 'mvu', before: entry.baselineFor(turn), after: mvu.data })
      if proposals.length: settled = arbitrate(baseline, proposals); replaceVariables(...); report conflicts
```

**之后：**

```
#run:
  impersonating = kind === 'impersonate'                      // 只剩 trim 用
  if isEnabled('tavern-helper'): leases.push(lease('tavern-helper'))   // 不动
  // 一次快照 + 每个 writer 一把 lease，锁住整轮生成的参与者集合
  writers = []
  for w of (plugins?.orderedVariableWriters() ?? legacyWriters):
      try { leases.push(plugins.lease(w.pluginId)) } catch { continue }   // 竞态：刚被停用
      writers.push(w)
  … settle(entry, turn, text, 'completed', { recordVariables: !impersonating, kind: request.kind, writers })

#settle:
  baseline = entry.variables.getVariables(messageOption)
  proposals = []
  stFloor = undefined
  if completed && recordVariables && turn !== undefined:
      processed = await #processReplyViaStCompat(entry, turn, settledText)   // 原位不动
      settledText = processed.text
      stFloor = processed.floorVariables            // 只入槽，不再自己造提案
  view = { chatId, turn, kind, reason, text: settledText, baseline,
           variablesAt, declared: entry.initVars(), signal }
  for w of options.writers:
      if !w.lease.isCurrent(): continue             // 生成期间被换掉的 incarnation
      try {
        after = await #runWriter(w, view)           // 5 s 预算，见 §4.6
      } catch (e) { this.#noteHookFailure(w.pluginId, e); continue }
      if after === undefined: continue
      proposals.push({ pluginId: w.pluginId, before: w.writer.baselineFor(view), after })
      plugins?.clearHookFailure(w.pluginId)
  if proposals.length: settled = arbitrate(baseline, proposals); replaceVariables(...); report conflicts
    // ↑ 这三行与今天逐字相同
```

ST-compat writer（`service.ts` 构造期登记一次）：

```ts
plugins?.registerVariableWriter(st.extensionId(), {
  baselineFor: view => view.baseline,               // 今天的 variableBaseline
  propose: view => this.#stFloorSlot.get(view.chatId + '/' + view.turn),
})
```

槽在 `#settle` 内进出、`finally` 里删，不跨结算存活。**为什么桥调用不搬进 writer**：`#processReplyViaStCompat` 同时返回 `text`（改写 `settledText`）与 `floorVariables`，而 writer 契约只承载变量；把文本改写塞进变量接口就是给 U4 的生成钩子提前挖坑。这条要写进 ledger。

MVU writer（`plugins/mvu.ts` 新增，`plugins/builtins.ts` 的 `activate` 里登记）：

```ts
export function createMvuVariableWriter(
  capability: MvuCapability,
  report: (message: string) => void,
): VariableWriter {
  const baselineOf = (view: VariableWriteView): MvuData => {
    for (let earlier = view.turn - 1; earlier >= 0; earlier -= 1) {
      const stored = view.variablesAt(earlier)
      if (stored !== undefined && isMvuData(stored)) return stored
    }
    return view.declared as MvuData
  }
  return {
    baselineFor: view => baselineOf(view) as unknown as PluginVariableTable,
    propose: view => {
      if (view.kind === 'impersonate') return undefined   // ← 从 service.ts:5014 搬来的那半句
      const result = capability.update(view.text, baselineOf(view))
      for (const line of result.reports) report(line)
      return result.data as unknown as PluginVariableTable
    },
  }
}
```

`entry.baselineFor` / `entry.computeVariables`（`entry.ts:1019`、`:1084`）**保持原样不删**：`system-plugin-extraction.test.ts:175/:213` 直接调它们，且 `entry.recordVariables`（`:1063`）是既有的兼容包装。两份基线走法暂时并存，ledger 记为已知重复，附「谁先掉下来」的判据（`entry.computeVariables` 在结算路径上没有调用者之后可删，届时那两条测试要一起迁）。

**上报回调：一个必须一起定的细节。** MVU 的报文今天在 `service.ts:5185-5192` 上报，元数据是 `{ kind: 'mvu', grade: 'fault', chatId, characterId }`。`activate(scope)` 里既没有 chat 也没有 character，所以这些字段只能由宿主填。三条路：

| 解法 | 评价 |
| --- | --- |
| 注册时给 writer 传一个 `report` 闭包 | 闭包里没有 chatId，报告会丢掉 chat 归属 → **否决** |
| `view` 上加一个 `report(message)` 直通宿主诊断面 | 那是 U4 生成钩子该定的面，U2 抢先定会绑住它 → **否决** |
| `propose` 返回 `{ variables, reports?, reportKind? } \| undefined`，宿主拆开后补齐元数据 | **推荐** |

选第三条时有一个坑：`ReportKind`（`packages/iris-app-service/src/diagnostics.ts:23-31`）是闭合联合，没有 `'plugin'` 这一支；而 `service.ts:5187` 是**整棵树里 `kind: 'mvu'` 的唯一上报点**（`grep -rn "kind: 'mvu'" packages/ apps/` 只出这一条 + 三条 `diagnostics.test.ts` 的自造记录）。若把 writer 的报文一律改挂 `'variables'`，`WIRED_KINDS.mvu`（`diagnostics.ts:49`）就还写着 `true` 而没有任何报告点——`diagnostics.ts:34-42` 的注释把这条契约说得很死："absent means nobody is looking"，反过来 present 而无人写就是一句假话。所以 `reportKind` 由 writer 给一个**普通字符串**（契约包不能 import `ReportKind`），宿主对着联合校验，不认识就退回 `'variables'`；MVU writer 给 `'mvu'`，`WIRED_KINDS` 保持诚实。

报文本身不变：`MVU:` 前缀由 `plugins/mvu.ts:104-121` 自己加；`mvu-dropped-commands.test.ts:75` 走的是 `entry().recordVariables(...)` 的直调路径，根本不经过 `#settle`，因此本任务对它零影响——这也是 §2.4 把它列进零改动区的理由。

### 4.4 权限闸门：不设，并写明前提

裁决 4 只说词表加名字、同意页显示。是否让 `registerWriter` 在未声明 `write-variables` 时抛错，是施工者的决定。**推荐不设闸**，三条理由：

1. **现有四个名字明文不是边界。** `plugins/manifest.ts:60-68` 的 docblock 写死了："a system plugin is same-privilege code and this list is a declaration the host displays and spell-checks, not a boundary it enforces"；`docs/SYSTEM-PLUGIN-INSTALL.md:568-579` 的裁决 4 同义。U2 单方面让第五个名字变成闸门，会让同一张表里一半是声明一半是边界，而同意页上那句话对两半都在说。
2. **runtime 今天拿不到 manifest。** `SystemPluginDefinition`（`plugin-api/src/index.ts:55-63`）没有 `permissions` 字段，`RuntimePlugin`（`system-plugins.ts:112-140`）也没有。manifest 只在安装路径上被 `parsePluginManifest` 读过一次。要设闸就得先把 `permissions` 从安装路径接到 `RuntimePlugin` 上——那是 U1/U3 面上的一条新接线，不是 U2 的范围。而且内置的 TH/MVU 与被接纳的 ST 扩展行**根本没有 manifest**，闸门一开这三类全部被拒。
3. **风险不对称在另一边。** U3 的 `plugin-storage` 通向用户磁盘上一块插件私有目录；变量 writer 通向的是一个宿主仲裁后才落盘的**提案**，每一次覆盖都按 id 上报冲突（`service.ts:5205-5209`），用户在报告视图里看得见是谁写的。

**写进 ledger 的形式**：记为「U2 的推荐，前提是 U3 没有把 manifest 接到 runtime 上」。如果 U3 先落地并引入了 `RuntimePlugin.permissions`，U2 在 `registerVariableWriter` 顶上加一句同样的检查即可（一行 + 一条测试），届时由协调人裁决是否同时给另外四个名字设闸。

### 4.5 `hook-failed`

协议侧（`packages/iris-protocol/src/system-plugins.ts:27-33`）：

```ts
export type SystemPluginFailureState =
  | 'install-failed' | 'manifest-invalid' | 'incompatible'
  | 'tampered' | 'load-failed' | 'activate-failed'
  | 'hook-failed'
```

连带必改的三处（都是 `tsc` 会逼出来的，不必靠记性）：

1. `:70-76` 的 docblock 说 "`failure` 是 `status:'error'` 的一个 refinement"。**改**：`hook-failed` 是唯一一个骑在 `enabled: true, status: 'enabled'` 行上的状态——它说的是「这个插件上一次没能参与结算」，不是「它跑不起来」。
2. `system-plugins.ts:105-110` 的 `ENABLE_BLOCKING_FAILURES` 注释说「六个状态里四个挡 enable」。`hook-failed` **不进** 这个集合；注释里的"六"改成"七"，并说明第七个为什么连 `load-failed`/`activate-failed` 那一档都不算。
3. `system-plugins.ts:416-421` `markFailure` 的 docblock 说「六个状态就是全部词表」。同上改数字，并点明 `hook-failed` 走的是 `noteHookFailure` 不是 `markFailure`。

runtime 侧新增（**不复用 `markFailure`**，理由见纠正 4）：

```ts
noteHookFailure(pluginId: string, reason: string): void {
  const plugin = this.#plugins.get(pluginId)
  if (plugin === undefined) return
  // enabled / status / error 一律不碰：writer 失败不是插件跑不起来。
  this.#failures.set(pluginId, { state: 'hook-failed', reason })
  this.#notify()
}
clearHookFailure(pluginId: string): void {
  if (this.#failures.get(pluginId)?.state !== 'hook-failed') return   // 不碰别人写的失败
  this.#failures.delete(pluginId)
  this.#notify()
}
```

**清除规则**：(a) 同一个 writer 的下一次成功提案清掉（上面的 `clearHookFailure`）；(b) 任何一次提交过的状态迁移也清掉——`#commit`（`system-plugins.ts:1101-1104`）和 `#activateAtStartup`（`:877`）本来就 `#failures.delete(...)`，白拿。备选是"粘住直到下次启停"，**否决**：一次 5 s 抖动会在一个正常工作的插件行上留一条永久告警。注意 `clearHookFailure` 必须先看 `state === 'hook-failed'`，否则一个 `tampered` 行上的 writer（不可能，但类型上可达）会把安装期的失败洗掉。

web 侧（`apps/iris-web/src/app/PluginCenter.tsx:72-79`、`:82-89`）两张 `Record<SystemPluginFailureState, StringKey>` 是全映射，加状态后**不加键就编译不过**——这就是这一步的牙齿。新增 4 个 i18n 键（`pluginCenterFailureHookFailed` / `pluginCenterFailureFixHookFailed`，各中英一条）进 `apps/iris-web/src/app/i18n/strings.ts`，`i18n.test.ts` 不改。文案要点：含义句说「插件的变量写入这一轮失败或超时了，本轮回复已正常结算」；处置句说「插件仍在运行；下一轮成功写入会自动清除这条提示」。

### 4.6 超时与失败路径

```ts
async #runWriter(entry: RegisteredVariableWriter, view: VariableWriteView): Promise<…> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error('…5000ms…')) }, WRITER_TIMEOUT_MS)
  timer.unref?.()
  try {
    return await Promise.race([
      Promise.resolve(entry.writer.propose({ ...view, signal: controller.signal })),
      new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(…)) }),
    ])
  } finally { clearTimeout(timer) }
}
```

四个坑，逐条：

- **只给 `AbortSignal` 不做 `race` 等于没有超时。** 一个不看 signal 的 `propose` 会把结算挂住到它自己结束。`race` 是执行力，signal 是礼貌。
- **定时器不清会把测试拖慢 5 s/次**，而且 `node --test` 的进程可能因为活跃 handle 不退出。`clearTimeout` 放 `finally`，外加 `unref()`。
- **race 输掉的那条不会停。** 它晚到的返回值宿主必须丢弃（上面的写法天然丢弃），而且要在注释里说清楚：writer 不是被杀死的，它只是不再被听。一个仍在跑的 `propose` 若有副作用（它不该有），那是插件自己的问题。
- **预算是每 writer 5 s，不是每次结算 5 s。** k 个 writer 串行最坏 k×5 s 挡在回复落盘前。串行是刻意的（今天就是串行，且仲裁按顺序吃增量），但这条要写进 §9 风险与 ledger。并行化会改变"后者胜"的判定时机，是另一次裁决。

`WRITER_TIMEOUT_MS = 5000` 作导出常量，测试用一个 `options` 上的可选覆盖（与 `PLUGIN_TREE_LIMITS` 的 test-only 覆盖同一套做法），否则没人会在测试里等 5 s。

---

## 5. 施工步骤

每一步单独可编译、单独 `npx tsc -p . --noEmit` 通过、单独 `npm test` 全绿。

**步骤 1 · 协议 + web 文案（一步，跨包）。** `SystemPluginFailureState` 加 `'hook-failed'`；改 §4.5 列的三处注释；`PluginCenter.tsx` 两张表各加一行；`strings.ts` 加 4 个键；`apps/iris-web/tests/plugin-center.test.ts` 的 `STATES`（`:143`）与三张 `Record<SystemPluginFailureState, RegExp>`（`:194`/`:202`/`:253`）各加一项。
→ 跨包是因为协议一改，web 的全映射立刻编不过；两包必须同提交。此步没有任何行为变化。

**步骤 2 · 契约 + 权限词表（一步）。** `plugin-api/src/index.ts` 加 `PluginVariableTable`、`VariableWriteKind`、`VariableWriteView`、`VariableWriter`、`PluginVariableFace`，`SystemPluginActivationScope` 加 `readonly variables`（排在 `storage` 之后、`registerRpc` 之前）；`plugins/manifest.ts` 的 `PLUGIN_PERMISSIONS` 追加 `'write-variables'` 并更新那张映射表注释；`packages/iris-app-service/tests/plugin-manifest.test.ts:344` 的 `mapping` 加 `'write-variables': 'variables'`。
→ 不加 `mapping` 这一行，`:352` 的 `unmapped` 断言就红——这一步自带牙齿。`contract.test.ts` 仍绿（新类型不 import 任何东西）。

**步骤 3 · runtime 注册表。** `system-plugins.ts`：`#variableWriters`、`registerVariableWriter`、`orderedVariableWriters`、`depth` 排序、`noteHookFailure`/`clearHookFailure`；scope 字面量加 `variables`。
→ 还没有任何消费者，全量测试不变。此步要把 `depth` 的那条注释（"MVU 排在后面靠的是依赖不是字母序"）写足。

**步骤 4 · MVU writer 的纯函数半边。** `plugins/mvu.ts` 加 `createMvuVariableWriter`，**先不在 `builtins.ts` 里登记**；为它写单元测试（假 view，四种 kind，基线走法与 `entry.baselineFor` 逐点对齐）。
→ 登记与删分支必须同一步，见下。

**步骤 5 · 结算重写（原子，本任务唯一不可拆的一步）。** `service.ts` 的 `#run` 换成 writer 快照 + 逐 writer lease；`#settle` 换成 writer 循环；删 `:5013-5024` 与两个 `pluginId` 字面量；`#runWriter` 超时；构造期登记 ST-compat writer；`builtins.ts` 的 MVU `activate` 登记 writer；无 runtime 时登记 legacy writer。
→ **不能按任务简报说的"注册表先、内置次之、最后删分支"拆开**：MVU 一旦登记而分支还在，同一轮会有两条 `pluginId: 'mvu'` 的提案。那不会变红——`arbitrateMessageVariables:108` 的冲突判定要求 `earlier.pluginId !== proposal.pluginId`，同 id 不报冲突，第二次 `setAt` 写入同值也看不出来。**一次静默的绿**比一次红更贵，所以合成一步。这条偏离写进 PR 说明和 ledger。

**步骤 6 · 清理。** `MvuExecution` 若在 `#fail`（`service.ts:5375`）之外再无调用者，判断是否删（`plugins/mvu.ts:56-59` 导出它，`system-plugin-extraction.test.ts:213` 用它）——推荐**保留**，只把 `service.ts` 里的构造点删掉，避免碰那两条既有测试。

**步骤 7 · 测试与夹具。** 见 §6。

**步骤 8 · 文档与 ledger。** 见 §7。

---

## 6. 测试与牙齿

新文件：`packages/iris-app-service/tests/variable-writers.test.ts`。夹具插件 `third-writer`（定义在测试文件里，`definitions` 里塞给一个测试用 runtime，`dependencies: ['mvu']` 使它 depth 2，稳定排在最后）。

| # | 断言 | 破坏它的改动（牙齿） |
| --- | --- | --- |
| T1 | 第三个 writer 接进来并在 ST 与 MVU **之后**生效：三方都写同一个键，最终值是 `third-writer` 的，冲突报文出现两条且 `winnerPluginId` 都是 `third-writer` | 把 `orderedVariableWriters` 的排序键从 `(depth, id)` 改成只 `id` → 顺序变 `mvu` < `prompt-template` < `third-writer`，`:182` 那条既有测试与 T1 的冲突报文同时红 |
| T2 | 顺序断言（任务单点名）：把比较器反过来（`id` 降序 / `depth` 降序）必须红 | 直接在测试里对着 `orderedVariableWriters()` 的 `pluginId` 序列断言 `['prompt-template','mvu','third-writer']`；改比较器即红 |
| T3 | 停用一个 writer，它的提案立刻消失：`await plugins.disable('third-writer')` 后再跑一轮，最终值回到 MVU 的 | 让 `orderedVariableWriters` 不过滤 `isEnabled` → 停用后仍参与，T3 红 |
| T4 | 生成中途停用：在 `propose` 里 `await` 一个测试控制的 promise，期间 `disable`，放行后该提案被丢弃 | 删掉循环里的 `if (!w.lease.isCurrent()) continue` → T4 红 |
| T5 | writer 抛错：回复照常落盘、其余 writer 的提案照常生效、该行 `failure.state === 'hook-failed'`、`enabled` 仍为 `true`、`status` 仍为 `'enabled'` | (a) 把 `noteHookFailure` 换成 `markFailure` → `enabled`/`status` 断言红；(b) 把 `catch` 里的 `continue` 改成 `throw` → 回复落盘断言红 |
| T6 | writer 超时：`propose` 返回一个永不 resolve 的 promise，用测试覆盖把预算压到 20 ms，行上 `hook-failed`，回复照常 | 把 `Promise.race` 去掉只留 `signal` → 测试挂死（超时即红） |
| T7 | `hook-failed` 会被下一轮成功提案清掉；且不会清掉别的 state | 把 `clearHookFailure` 里的 `state !== 'hook-failed'` 早返回删掉，再让一个 `tampered` 行成功提案 → 第二条断言红 |
| T8 | 扮演行为搬进 writer：既有 `generation-kinds.test.ts:251` 仍绿；新加一条——`view.kind` 为 `'impersonate'` 时 MVU writer 的 `propose` 返回 `undefined`，为 `'regenerate'`/`'continue'` 时不返回 | 删掉 `createMvuVariableWriter` 里那句 `if (view.kind === 'impersonate') return undefined` → 既有的 `:251` 与新断言同时红 |
| T9 | `aborted` 的部分回复：MVU 仍写、ST-compat **不**写（今天 `:5168` 的 `reason === 'completed'` 门；搬进 writer 后由 ST writer 看 `view.reason`） | 把 ST writer 的 `reason` 判断删掉 → 部分回复上多出一条 `prompt-template` 提案，T9 红 |
| T10 | 无 runtime 的兼容路：`plugins === undefined` 时 legacy MVU writer 仍写，与 `system-plugin-extraction.test.ts:213` 的结论一致 | 删掉 legacy 登记 → T10 红，`:213` 仍绿（它走 `entry.computeVariables`），所以 T10 是必需的第二张网 |
| T11 | 源码断言：`service.ts` 的结算区间（`#run` 的租约段到 `#settle` 的仲裁提交）内**不再出现任何被引号包住的插件 id 字面量**（`'mvu'`、`'prompt-template'`、`'tavern-helper'` 中前两个；`tavern-helper` 因纠正 1 仍在，白名单放行并注明原因） | 把任一字面量加回去 → T11 红。这是任务单「结算段删掉按名分支」这条验收的机械化形式，写法照抄 `plugin-manifest.test.ts:322` 读源码那一条 |

T11 的实现要点：按符号定位区间（`indexOf('const impersonating = request.kind')` 到 `indexOf('arbitrateMessageVariables(')`），不要写死行号——行号会随任何一次无关编辑失效，而一个找不到锚点的切片会安静地变成空字符串然后全绿。加一条下限断言：切片长度 > 2000 字符。

另：**夹具插件必须真的走 runtime 的激活路**（`adoptDefinition` + `enable`），不能手工调 `registerVariableWriter`——否则 T3/T4 测的是注册表而不是 lease 语义。

---

## 7. 文档与 ledger

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `docs/INFRASTRUCTURE-INTERFACES.md` | §2 那张 scope 表（`:37-50` 区域） | 加一行 `scope.variables.registerWriter(writer)` → `() => void`，语义列写清：登记本 activation 的变量 writer；顺序按 (依赖深度, id)；5 s 预算；抛错/超时该轮作废并在行上记 `hook-failed`；随 fiber 自动撤销 |
| 同上 | §2 结尾那句「scope 上**仍然没有** `storage`、`settings`、`hooks`…」 | 把 `variables` 从"没有"里去掉（U3 同时会去掉 `storage`；并行冲突按 §1 约定两边保留、按节序合） |
| 同上 | §8 「插件可写变量」行（`:342`） | 从「未做为 API」改为「**已闭合**」：写明注册面、顺序规则、超时与 `hook-failed`、`write-variables` 是声明不是闸门（并点出前提，见 §4.4）、ST-compat 的 id 从字面量改成 `st.extensionId()` |
| 同上 | §8 「生成钩子」行（`:340`） | 只加一句指路：`hook-failed` 这个状态由 U2 定义，U4 复用；不要在这里展开 |
| `docs/PLUGIN-AUTHORING-RUNBOOK.md` | 「变量写入规则」（`:199-208`） | **整段重写**。现在那段结尾写着「这不是插件可用的 API……第三个写变量的插件今天接不进来」，改完就是反的。新内容：怎么在 `activate` 里 `scope.variables.registerWriter`；`baselineFor` 与 `propose` 各自答什么；`view` 的每个字段；顺序规则与"你排在谁后面由依赖决定，不是由 id 拼写决定"；5 s 预算与 `signal`；抛错的后果（本轮作废 + 行上一条提示，不停用）；`:206` 的结算单点行号更新 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | §3 清单示例（`:94`）与 §5.1 preview 形状（`:194`）旁的权限说明、§12 裁决 4 那段（`:568-579`） | 词表从四个名字变五个；裁决 4 的那句"是声明不是边界"对第五个名字同样成立，并加一句 U2 为什么没设闸（指向 ledger §82） |
| `docs/SYSTEM-PLUGINS.md` | 「Compatibility boundaries」的 MVU 段（`:187-201`） | 「Disabling MVU stops its automatic initialization, update and replay」现在有了更强的机制说法：停用直接把它的 writer 从结算的参与者集合里摘掉。加一句，不动"full MVU hot-unload is not claimed"那一段的结论 |
| `notes/packages/iris-app-service/DEVIATIONS.md` | 新 **§82** | 见下 |

**ledger §82 必须覆盖的条目**（标题建议：「变量提案由注册表收，顺序由依赖图定，写者失败不再是插件失败」）：

1. 四条前提纠正（§2.1），逐条带 `path:line`。
2. 顺序规则 `(depth, id)` 与「MVU 排在后面靠的是 `dependencies`，不是字母序」的验算。
3. `hook-failed` 是第七个状态，且是唯一骑在 `enabled` 行上的——协议 docblock 的 refinement 说法因此被改。
4. `markFailure` 不可复用的理由。
5. 删掉 `'MVU is enabled without its runtime capability'` 这条 `internal` 抛错的理由（该状态在 writer 闭包能力后不可达）。
6. 步骤 5 不可拆的理由 + **双提案不会变红**这条事实（同 id 不报冲突，同值 `setAt` 不可见）。
7. `write-variables` 不设闸的决定与前提；U3 若引入 `RuntimePlugin.permissions` 时的一行改法。
8. 桥调用留在 `#settle` 而不进 writer 的理由（它同时改写文本）。
9. `entry.baselineFor`/`entry.computeVariables` 与 MVU writer 基线走法暂时并存，删除判据。
10. 串行 k×5 s 的最坏延迟预算。
11. 牙齿表（§6 那张，含每条被破坏时红的是哪个断言）。

---

## 8. 门禁与验收

§0 第 4 条，全部跑，输出原样贴进 PR：

```
npx tsc -p . --noEmit                                   # 根，exit 0
cd apps/iris-web && npx tsc --noEmit                    # exit 0
cd apps/iris-web && npm run build                       # bootstrap check 那行
cd apps/iris-web && npm run check:render                # ok
npm test                                                # ℹ fail 0
FORCE_COLOR=0 npm run test:no-corpus                    # 40 skipped, 0 failed
node --test apps/iris/tests/md-references.test.ts       # 3 pass
```

§0 第 7 条的两条偶发红（`chat-search.test.ts` 比例断言、`chat-integrity.test.ts` 只报告一次）若在全量里红，重跑一次并把两次输出都贴出来。

U2 专属验收（`P=packages/iris-app-service`）：

```
git diff --stat $P/src/service.ts          # 期望净减
git diff --stat $P/tests/variable-arbitration.test.ts \
                $P/tests/st-compat-floor-variables.test.ts \
                $P/tests/system-plugin-extraction.test.ts \
                $P/tests/generation-kinds.test.ts \
                $P/tests/mvu-dropped-commands.test.ts     # 期望全空
```

净减的来源：`:5013-5024` 的 12 行三态块、`:5168-5180` 与 `:5181-5202` 里的两段提案构造；加回的是一个 writer 循环与 `#runWriter`。若因注释而净增几行，PR 说明里说明增的是什么——任务单写的是「只减不增或接近」。五个变量测试文件零改动，是本任务"行为逐字不变"的唯一硬证据。

改了的既有测试只有两个，且都只加不减：`packages/iris-app-service/tests/plugin-manifest.test.ts`（`mapping` 加一项）、`apps/iris-web/tests/plugin-center.test.ts`（四张表各加一项）。PR 说明要点名这两个并说明为什么它们不算"弱化既有断言"。

U2 不在协调人 U1/U3/U5 的起宿主实测名单里，但建议自测一轮：起宿主、开一个真聊天、`plugin.disable('mvu')` 后发一条、看变量表与 `plugin.list` 行。

---

## 9. 风险

**9.1 顺序回归，而且是静默的。** `(depth, id)` 今天给出 ST → MVU，靠的是 MVU 声明了 `dependencies: ['tavern-helper']` 使 depth = 1。两件事会把它掀翻：(a) 有人把排序简化成一次 `sort((a,b) => a.id < b.id ...)`；(b) 被接纳的 ST 扩展将来声明了依赖。两种情况下 `variable-arbitration.test.ts:182` 都会红（它断言 `mvu won`），T2 也会红——这是唯一挡住它的东西，所以 T2 不能写成"只要包含三个 id"，必须断言完整序列。

**9.2 双提案不会变红。** 已在 §5 步骤 5 说明。除了合成一步，再加一条便宜的保险：`#settle` 的 writer 循环里用一个 `Set<string>` 拒绝同一个 `pluginId` 在同一轮提案两次，第二次直接 `noteHookFailure`。

**9.3 被撤销的 lease 撞上进行中的结算。** 今天靠 `MvuExecution.isCurrent`（`plugins/mvu.ts:58`）在提交边再查一次，`entry.computeVariables:1097-1101` 的注释把理由写得很清楚："object identity is the incarnation token, so a stale activation cannot append state"。新实现必须保住这条：循环里的 `if (!w.lease.isCurrent()) continue` 是它的替身，且**必须在 `propose` 之后、`proposals.push` 之前再查一次**（一次异步的 `propose` 期间 incarnation 可能被换）。T4 测的就是这个窗口。漏掉这一次复查，T4 里的 `disable` 若发生在 `propose` 之前仍会绿——测试要把 `disable` 精确放在 `propose` 的 `await` 里面。

**9.4 `impersonating` 的语义被拆成两半。** `options.recordVariables` 今天同时管 trim（`:5144`）和变量（`:5168`/`:5181`）。改完它只管 trim，变量由 `view.kind` 管。两个开关看起来重复，容易被下一个人合并回去——合并会让扮演轮次的文本被 trim（行为变化，`generation-kinds.test.ts` 未必抓得到）。在 `#settle` 的签名旁写一句注释说明这两个开关为什么不是同一个，并在 ledger 里记一条。

**9.5 延迟预算。** k 个 writer 串行，最坏 k×5 s 挡在 `replaceVariables` 与 `stream.end` 之前。今天 k ≤ 2 且两者都是同步计算，实测影响为零；一个第三方 writer 就能让用户看到"回复停在那里"。缓解：不在本任务做（并行化要改"后者胜"的判定时机，是另一次裁决），但在 ledger §82 里记下预算公式，并在 runbook 的 writer 段写明"`propose` 应当是同步或毫秒级的"。

**9.6 `hook-failed` 的抖动噪音。** 一个偶发超时的 writer 会让插件行上的提示反复出现又消失（成功即清）。这是刻意的（见 §4.5 的备选否决），但若实测发现闪烁扰人，缓解方向是"连续 N 次失败才上行"，不是延长清除时间——那会让一条陈旧的告警留在一个已经恢复的插件上。

---

## 10. 完成报告模板

```
分支：dev/plugin-variable-writers
最终 commit：<sha>
PR：#<n>

与任务单的偏离（前提纠正，四条）：
1. :5006/:5014 不是要删的两处；tavern-helper 的 lease 是宏展开的存活凭据，保留。
   要删的是 :5174 / :5197 两个 VariableProposal 的 pluginId 字面量（§8 行点的就是这两处）。
2. 写变量的两方是 ST-compat 桥与 MVU，不是 TH 与 MVU；tavern-helper.ts 未改动。
3. 'prompt-template' 字面量只在扩展目录恰好同名时才对；已改为 st.extensionId()。
4. hook-failed 不能走 markFailure（它会停用插件）；新增 noteHookFailure。

施工者决定（含理由，详见 ledger §82）：
- VariableWriter / VariableWriteView 的确切形状，baselineFor 取 view 而非 turn
- 顺序 = (依赖深度, id)，不动 #enableOrder
- write-variables 不设闸（前提：runtime today 拿不到 manifest）
- 步骤 5 不可拆（双提案不会变红）

门禁（七条，原样贴输出）：见本文 §8 的命令表，逐条附实际输出。

U2 专属验收：
  git diff --stat service.ts → -<x>/+<y>（净减 <z>）
  五个变量测试文件 git diff → 空
  改动的既有测试：plugin-manifest.test.ts（+1 映射）、plugin-center.test.ts（+4 表项），都只加不减

牙齿表：T1–T11（见 ledger §82），每条附「破坏什么 → 哪条断言红」。
未变红的破坏：<有则列出，连同为什么不该隐瞒>
```
