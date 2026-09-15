# Debug page — the host half

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。数字与路径以该提交为证据；行号会漂移，符号名不会。
>
> 上一版是 2026-09-02 的**设计输入**：第三节整节写成「契约提议」，前提是宿主的
> 报告「不留存、一行、然后没了」，call site 是 13 处。**第三节提的东西已经全部
> 落地**（`DiagnosticBuffer`、`debug.reports`、结构化字段、`kinds` 声明），报告点
> 长到了 65 处，而且多出一个提议里没有的字段 `grade`。本版把第一、三节改成现状，
> 提议原文中仍成立的裁决留在原位并标注。

Design input that became the built thing. [OBSERVABILITY.md](OBSERVABILITY.md)
is the charter and names the gaps; this answers three questions about the host:
**what it holds, which of the charter's items were wiring rather than new
instrumentation, and the read surface that serves the page.**

The charter's ruling stands throughout: this is a **debug page, not an
observability platform.** Everything below is sized to that and says what it
deliberately does not do.

## 口径

Two readings, kept apart. The **upstream-shaped analysis** (§二's split into
wiring vs missing collection) is from 2026-09-02 and is the reasoning that
produced the design. The **counts** are re-measured on `e356771`:

```
grep -c "this\.#report(" packages/iris-app-service/src/service.ts        → 50
grep -c "this\.#report(" packages/iris-app-service/src/system-plugins.ts → 15
grep -o "grade: '[a-z]*'" packages/iris-app-service/src/service.ts | sort | uniq -c
                                                     → 25 fault, 25 note
```

Counts are of call sites, not of runtime volume. The frame's own instruments
live in `apps/iris-web`; they appear here only where the seam needs naming.

环境变量按 `grep -rhoE "IRIS_[A-Z0-9_]+" apps packages scripts` 核过,**包括
`.yml`**——第一节表里的 `IRIS_CACHE_TRACE` / `IRIS_CACHE_TRACE_KEEP` 只出现在
`apps/iris/cordis.yml`(组合层的 `cacheTraceKeep` 行),一次只扫 `.ts` 的 grep
会报它们不存在,而那是关于扫描范围的结论,不是关于这棵树的。

---

## 一、存量：宿主此刻持有什么

The finding that shaped everything else, and what happened to it: **the host had
exactly one diagnostic bus and nothing behind it.** Thirteen call sites funnelled
into `#report(error)` → the `onError` option → `ctx.logger.warn`. That was a line
on the server's stdout and then it was gone.

**Both halves of that sentence have changed.** There are now **65 call sites**,
and there is something behind the bus: `DiagnosticBuffer`
(`packages/iris-app-service/src/diagnostics.ts`) keeps the records and
`debug.reports` serves them. The log line survives beside the record — a logger
has no fields to carry a kind in, so it keeps a uniform `kind: message` prefix.

The 65 are two reporters, not one, and the difference is worth keeping:

- **`Service.#report(what, context)` — 50 sites.** Takes the caught error *or*
  the sentence the site wrote, plus a `ReportContext`. **A string argument means
  the sentence was written here; an `Error` means one was caught**, and only the
  caught form carries `stack`. That is the §3.1 stack rule made structural
  rather than left to discipline: a site cannot get it wrong without changing
  what it passes.
- **`SystemPluginRuntime.#report(error)` — 15 sites.** The plugin transition
  path's own reporter, which hands the error to `onError` and swallows an
  observer's own throw, because a diagnostic observer is not part of the
  transition transaction.

| 可观测物 | 存在哪 | 现在谁能看到 | 活多久 |
| --- | --- | --- | --- |
| **诊断报告流**(65 处 `#report`):MVU 拒绝的命令、`<JSONPatch>` 空操作、模板失败、模板写回被拒、残留宏、无存储的变量作用域、`script.context` 增长告警、prune 决定、卡存储的 `clear()`、插件激活失败 | `DiagnosticBuffer` 环形缓冲 **+** `onError` → `ctx.logger.warn` | `debug.reports` RPC → `apps/iris-web/src/app/HostReports.tsx`;不可逆的那一类另经事件推送并弹通知 | 缓冲内(2000 条 / 1 MiB 封顶),**进程内,重启即空** |
| `entry.unsupportedScopes` | `ChatEntry` 上的 Set | 每次装配时被**排空**成一条报告后 `clear()` | 到下一次装配 |
| `entry.itemizations` | `ChatEntry` 上的 Map | `prompt.itemize` RPC | entry 在缓存里多久 |
| **请求留痕**:每次真实生成的 canonical body、逐条目的字节偏移区间、提供方回报的 `cacheReadTokens` | `<profile>/cache-trace/<chatId>/<seq>.json` | `prompt.divergence` RPC、容量卡底部那一行、提示词面板、`scripts/cache-divergence-report.mjs` | **每对话最近 8 份**(`IRIS_CACHE_TRACE_KEEP` 改数量,`IRIS_CACHE_TRACE=0` 关闭) |
| `iris/variables-pruned` 事件 | 会话事件日志 | **只有测试在读** | 永久(append-only,随聊天文件走) |
| 具名拒绝(`AppError` 的 code + message) | RPC 边界抛出 | **只有那次调用的调用方** | 一次调用 |
| 插件启动警告(pre-profile 布局等) | `ctx.logger.warn` | 服务器日志 | 不留存 |

三条结论,以及它们各自的下场:

1. ~~**报告流是全部工作的落点。** 十三处已经在报告了,内容也够具体——缺的不是采集,
   是**留存**和**取用**。~~ **判断成立,已兑现。** 留存是 `DiagnosticBuffer`,
   取用是 `debug.reports` + `HostReports`。报告点从 13 涨到 65,但那是**采集顺带
   变多**,不是设计变了——所有新点都落进同一条总线。
2. ~~**归属信息在字符串里,不在字段里。**~~ **已改。** `MVU: ` / `template: ` /
   `script.context: ` 这类文本前缀被**删掉**而不是保留:`kind` 成了枚举字段,
   `chatId` / `characterId` / `scriptId` 成了三个可选字段,日志行统一由
   `#report` 自己拼 `kind: message`。**同一信息不再有两份来源**,这一点比字段
   本身重要。
3. ~~**`iris/variables-pruned` 是唯一已经持久化的诊断**,而且**除了测试没有任何
   读者**。它是"宿主有但没有面"的最纯粹例子。~~ **后半句已经错了,而且错得有
   意思。** 它今天有一个生产读者:`prunedKeysOf`(`prune.ts`)被 `entry.ts` 在
   五处调用,用来重建某一层楼的变量表**读起来是什么样**。所以这条事件已经**不是
   诊断了,是承重状态**——它从"有记录没读者"变成了"有读者但那个读者不是人"。
   这正好把 §3.4「不给它做专用面」的裁决从"懒"变成"对":复制一份进诊断流,
   会让一条参与计算的事实有两个来源。它仍然没有面向用户的面,而那依然是刻意的。

---

## 二、差集:接线级 vs 真缺采集

对着 `OBSERVABILITY.md` 第五节的十二条。

### 接线级(宿主已产出,缺留存/缺面)

| # | 条目 | 缺什么 |
| --- | --- | --- |
| 1 | 分 frame 的日志视图 | 留存 + 读 RPC。内容已有 |
| 2 | 错误点名来源 | **给现有报告加结构化字段**,不是新采集 |
| 3 | 具名拒绝进面板 | 拒绝已经具名,但只交给调用方;需要在抛出处**同时**记一条报告 |
| 5 | 判决可撤回且留痕 | 需要报告有身份(seq)才能被后续标记 `withdrawn` |
| 7 | 开销画像 | 部分已有(`ScriptView.bytes`、`script.context` 增长告警);其余是新采集 |

### 真缺采集

| # | 条目 | 为什么不是接线 |
| --- | --- | --- |
| 4 | 常驻分代报告 | frame 侧(f7),宿主不产出 |
| 6 | 遗言通道 | frame 侧(f7) |
| 8 | 未处理异常 / Promise 拒绝 | frame 侧;**宿主这边没有对应缺口**——宿主的失败都经过 `#report` |
| 9 | 保留堆栈 | **陷阱**:`#report(new Error(...))` 里的 Error 是**在报告点新建的**,它的堆栈是宿主自己的调用栈,不是失败的来源。要真堆栈得在**抛出处**捕获并一路带过来。当年 13 处里只有 3 处握有原始错误。**今天这条由签名解决**:第一个参数是 `unknown`,传 `Error` 走捕获路径并带 `stack`,传字符串不带——见 §3.1 |
| 10 | 诊断默认开、代价可控 | 宿主诊断本来就是常开的;代价问题变成"环形缓冲多大" |
| 11 | 跨刷新持久化 + 导出 | 新建。**注意:宿主的报告缓冲活在进程里,重启即失**,而"跨刷新"在 frame 侧指的是页面刷新——两个不同的生命周期,别混 |
| 12 | 渲染判定可解释性 | 新建,且主要在 frame 侧 |

**给协调者的一句**:六个上游缺口里,宿主这半真正要新建的只有**留存**一件;其余不是
frame 的活,就是"给已有报告加字段"。这比章程读起来的工作量小。

---

## 三、契约(提议 → 已落地):一个读面,拉取不推送

**整节已实现**,事实源是 `packages/iris-app-service/src/diagnostics.ts` 与
`packages/iris-protocol/src/views.ts`。提议与成品有两处差异,都记在下面。

### 3.1 结构化报告

`#report` 收一个上下文参数,当年的文本前缀被删掉而不是保留:

```ts
/** packages/iris-app-service/src/diagnostics.ts — 当前形状 */
interface DebugReport {
  /** 这次调用是没被服务,还是服务了但有话说。提议里没有这个字段。 */
  grade: ReportGrade          // 'fault' | 'note'
  /** 单调递增,用作游标,也是「判决可撤回」要标记的身份。 */
  seq: number
  at: number
  kind: ReportKind            // mvu | template | prompt | script | variables | storage | host
  /** 哪段对话、哪张卡、哪个脚本 —— 层一第 2 条要的就是这三个。 */
  chatId?: string
  characterId?: string
  scriptId?: string
  message: string
  /** 原始错误的堆栈,**仅当报告点确实捕到一个错误时**。见下。 */
  stack?: string
}
```

**与提议的两处差异:**

- **多了 `grade`**,而且**必填、不给默认值**。理由写在 `ReportContext` 的注释里:
  默认值只能由唯一不可能知道答案的那一层来猜——`variables` 同时覆盖"故意裁掉的
  表"和"读不出来的表",一个是 note 一个是 fault。必填是让**每个报告点在编译期
  就被逼着做这个判断**。(面板侧的同名裁决在 `apps/iris-web/src/app/blocked-line.ts`:
  缺省是 note 不是 fault,因为第一版把未分级的报告画成红色,而多数条目根本不是失败。)
- **`kind` 多了 `storage`**,单列而不是折进 `script`:一次把别的卡的键也带走的
  `clear()` 是**数据被删掉**,不是脚本行为不端,而找前者的人不是在找后者。
- 另有一个不进 `DebugReport` 而进 `ReportContext` 的字段 `irreversible?: true`:
  它说的不是报告**关于**什么,而是报告**代价**多大——被标了的记录不等页面来问,
  直接经广播推出去弹通知。

**`stack` 必须诚实地可缺席**,而这条今天是**结构性**保证而不是纪律:`#report`
的第一个参数是 `unknown`,**传字符串 = 这句话是报告点自己写的,传 `Error` =
真的捕到了一个**,只有后者带 `stack`。给自己写的一句话配一条宿主调用栈**比没有
堆栈更坏**——它看起来像失败的来源而不是报告的位置。提议当年只能把这条写成告诫;
现在报告点想写错,得先改它传的东西。

### 3.2 读 RPC

```ts
/** 已在 requestSchemas 里 */
'debug.reports': { since?: number, limit?: number }
  → { reports: DebugReport[], dropped: number, oldest: number,
      kinds: readonly ReportKind[] }
```

- **拉取,不活推。** 广播通道已经存在,把诊断流挂上去等于让 debug 页变成日志订阅——
  章程明确裁的是页面不是平台。`since` 游标 + 按需拉取足够,而且**页面不开时零成本**。
  页面 (`HostReports.tsx`) 按这条实现:按需拉,不轮询。**唯一的例外是不可逆删除**,
  它等不到有人来问,所以走事件推送 + 通知条。
- **`dropped` 是必需字段,不是装饰。** 环形缓冲满了会丢老的,而"我看到的就是全部"
  和"前面还有我没看到的"是读者要做不同事情的两种状态。缺了它,一个被截断的诊断包
  和一个完整的长得一模一样。
- **`oldest`** 让页面知道自己的游标是不是已经落在缓冲之外了。
- **`kinds`** 是 §3.6 那条硬约束的落点,见下。

### 3.3 缓冲

进程内环形缓冲,**同时按条数和字节封顶**:
`DEFAULT_LIMITS = { maxRecords: 2000, maxBytes: 1_048_576 }`(1 MiB)。

速率量过了(2026-09-02),不再是猜的:一张 MVU 卡、**故意让一半的回复带无效
`_.set` 路径**,跑 20 和 100 轮:

```
 20 轮 ->  10 条报告  (0.50/轮, 均值 41 B, 合计 0.4 KiB)
100 轮 ->  50 条报告  (0.50/轮, 均值 41 B, 合计 2.0 KiB)
```

线性,无累积。**0.5 条/轮是偏高的一端**——真实的卡不会一半的折叠都失败。按这个速率,
2000 条 ≈ 4000 轮这种卡,所以**条数上限给得很宽松,不是紧约束**。

**字节上限才是真正起作用的那条,而它的必要性我没验到。** 均值 41 B 是 MVU 路径的
数;模板失败带的是 `failure.message`,可能含整段渲染输出,而我**没有跑出一次模板
失败**。所以:字节封顶保留(它防的是尾部不是均值),但"多大"这个数**仍然没有测量
支撑**,等能跑出模板失败的场景再定。**均值小不构成不封字节的理由——封字节防的正是
均值看不见的那条尾巴。**

已裁(2026-09-02):**字节上限保留,数字标未测量支撑,第一次真实模板失败之后回校。**

**核对 2026-09-16:数字落成了 1 MiB,而「未测量支撑」这个标注也照样落进了代码。**
`DEFAULT_LIMITS` 的文档注释原样写着这件事:条数上限刻意宽松、字节上限才是真正
起作用的那条、41 B 均值只描述 MVU 路径、真实模板失败至今没跑出来。**回校条件没有
被满足,所以回校也没有发生**——这是正确的状态,不是遗漏。

### 3.5 两条时间线,不合流(已裁 2026-09-02)

宿主的报告和 frame 的报告**各自成线**,页面上并排分栏,并且**明标「未对齐」**。

理由是钟:两边各带自己的时间戳,而**跨域钟差没有被量过**。合流会产生一条读起来像
单一真相的时间线,而它在两个来源交错处的排序是不可信的——**一条错序的合并时间线比
两条诚实的分栏更坏**,因为它把「我不知道谁先发生」变成了一个看起来确定的答案。

合流是奢侈品,等钟差被量过再说。在那之前,页面上的「未对齐」标签是这个未知的落点,
不是装饰。

**核对 2026-09-16:不合流这一半成立了,标签这一半没有。** 宿主报告在
`HostReports.tsx`,frame 报告在 `ScriptPanel.tsx`,**两条线从未被合并过**——裁决的
实质要求满足了。但全树搜不到「未对齐」/「not aligned」任何拼法,所以那个**标签
不存在**。记在这里而不是默默算通过:读者从两个分区里读不出"这两列时间戳不可
互相排序",而这正是标签要说的那句话。

### 3.6 两半的失败形态不同,所以空状态必须分两种

第二节把十二条分成了「接线级」和「真缺采集」。那不只是排期用的分类——**两半坏掉的
样子不一样,而页面必须把这个差别显示出来。**

- **保真度半**(宿主已经在报告,只是说不清是谁):坏了会给出一条**归属错误但内容
  真实**的记录。它**会误导**——读的人拿到一条真事,挂在错的卡上。
- **缄默半**(根本没有采集):坏了是**一片空白**。它**只是没帮上忙**——没有错误的
  断言,只是没有断言。

所以页面的空状态不能只有一种。**「这里没有报告」必须能区分两件事:**

1. **采集在线,而且确实无事发生** —— 好消息。
2. **这一类根本没接采集** —— 缄默半的洞,而页面把它**呈现成了好消息**。

第二种正是 [OBSERVABILITY.md](OBSERVABILITY.md) 缺口 10(降级成功)在**页面自己
身上**的复发:一个本该说「我不知道」的组件,说了「一切正常」。我们花了整个项目在
别处修这个形状,不能在诊断页上重犯——**诊断页说谎的代价比别处更高,因为它是人来查
别处说谎时用的工具。**

**结论,给实现的硬约束:页面的每个分区要么显示数据,要么显示「此类未接线」,
永远不显示裸的空白。** 裸空白是页面自己的静默失败。

这条对宿主侧的要求是:`debug.reports` 的响应要让页面**分得出这两件事**。

**已落地,而且比「最小做法」多走了一步。** 宿主声明它接了哪些 `kind`,就是响应里的
`kinds` 字段,来源是 `WIRED_KINDS`——而 `WIRED_KINDS` 是从
`KIND_WIRED: Record<ReportKind, boolean>` 过滤出来的,**不是一张手写的名单**。差别
是要命的那一种:`readonly ReportKind[]` 会逐项类型检查却不要求写全,于是一个新加进
`ReportKind` 却忘了登记的 kind 会**从声明里缺席**——而按本节自己的约定,缺席意味着
「没人在看」。页面于是会在报告正源源不断到达时宣布这一类没接采集,**正是这个字段
存在要防的那个谎**。值取布尔而不是"键在不在",也是同一个理由:"声明了但故意没接"
是一个真实状态,必须写下来成为一个决定,而不是一次看起来一样的遗漏。

### 3.4 明确不做

- **不做级别过滤/搜索的服务端实现**:2000 条以内页面自己过滤,少一个会长歪的 API。
- **不做跨进程持久化**:宿主重启即清空,并且在 `oldest` 上体现。真正的"导出诊断包"
  (章程 11)是另一件事,它要的是**一次快照下载**而不是一个持久化的日志库。
- **不做 `iris/variables-pruned` 的专用面**(已裁):它已经在会话日志里,应该由读日志的那条路
  取,不该复制一份到诊断流里。**同一事实两个来源迟早会不一致。**

---

## 三·附:一条被撤销的要求

「卡递模板与世界书模板两个来源在日志里分开标」这条要求**已撤销(2026-09-02)**,
因为两边都做不到:卡读一条世界书条目再递给 `script.evalTemplate`,到宿主这里和卡
自己写的模板**是同一个字符串**;门面侧同样只看见一个字符串,世界书出身不可追。

宿主标得了的是**调用路径**(`script.evalTemplate/<chatId>` vs `generate/…`),
标不了**材料来源**。要真区分,只能由卡在调用时自报,而那不是我们能强制的。

留在这里是因为**一条撤销了的要求如果只是消失,下一个读章程的人会重新提它**。

## 四、未查

- **速率已量(见 3.3),但只量了 MVU 路径。** 模板失败那条尾巴没跑出来,而它正是
  字节封顶存在的理由。字节上限的具体数字仍**没有测量支撑**。
- **`AppError` 抛出处同时记报告**会不会产生重复(调用方已经收到一次,面板再记一次)
  没有推演完。倾向记,理由是拒绝对调用方是答案、对旁观者是事件,两个读者;但没验证。
- ~~**f7 的 frame 报告与宿主报告要不要合流成一条时间线**没有定。~~ **已裁(2026-09-02):
  不合流。** 见 §3.5。**实现符合裁决,但 §3.5 要的「未对齐」标签至今不存在。**
- **本次核对没有验的:** 报告在真实使用下的**实际**速率与字节分布(3.3 的数字仍是
  2026-09-02 那次的),以及 `HostReports` 在真浏览器里的空状态是否真的按 §3.6 分成
  两种——`kinds` 字段在宿主侧存在是核过的,页面**怎么用**它没有核。这两件都是
  「读代码答不出」的问题。
