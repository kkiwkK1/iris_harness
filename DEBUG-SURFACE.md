# Debug page — the host half

Design input for the debug page. `OBSERVABILITY.md` is the charter and names the
gaps; this answers three questions about the host: **what it already holds, which
of the charter's items are wiring rather than new instrumentation, and the
smallest read surface that serves the page.**

The charter's ruling stands throughout: this is a **debug page, not an
observability platform.** Every proposal below is sized to that and says what it
deliberately does not do.

## 口径

Measured 2026-09-02 against `packages/iris-app-service/src` on this checkout.
Counts are of call sites, not of runtime volume. The frame's own instruments
(the generation report, the last-words channel) live in `apps/iris-web` and are
f7's; they appear here only where the seam needs naming.

---

## 一、存量：宿主此刻持有什么

The finding that shapes everything else: **the host already has exactly one
diagnostic bus, and nothing behind it.** Thirteen call sites funnel into
`#report(error)` → the `onError` option → `ctx.logger.warn` in the composition.
That is a line on the server's stdout and then it is gone.

| 可观测物 | 存在哪 | 现在谁能看到 | 活多久 |
| --- | --- | --- | --- |
| **诊断报告流**(13 处 `#report`):MVU 拒绝的命令、`<JSONPatch>` 空操作、模板失败、模板写回被拒、残留宏、无存储的变量作用域、`script.context` 增长告警、prune 决定 | `onError` → `ctx.logger.warn` | 读服务器日志的人 | **不留存**,一行,然后没了 |
| `entry.unsupportedScopes` | `ChatEntry` 上的 Set | 每次装配时被**排空**成一条报告后 `clear()` | 到下一次装配 |
| `entry.itemizations` | `ChatEntry` 上的 Map | `prompt.itemize` RPC | entry 在缓存里多久 |
| `iris/variables-pruned` 事件 | 会话事件日志 | **只有测试在读** | 永久(append-only,随聊天文件走) |
| 具名拒绝(`AppError` 的 code + message) | RPC 边界抛出 | **只有那次调用的调用方** | 一次调用 |
| 插件启动警告(pre-profile 布局等) | `ctx.logger.warn` | 服务器日志 | 不留存 |

三条结论:

1. **报告流是全部工作的落点。** 十三处已经在报告了,内容也够具体——缺的不是采集,
   是**留存**和**取用**。
2. **归属信息在字符串里,不在字段里。** 报告靠 `MVU: ` / `template: ` /
   `script.context: ` 这样的文本前缀区分来源;哪张卡、哪段对话、哪个脚本**没有一个
   是结构化字段**。层一第 2 条(错误点名来源)要的正是这个,而它不是"再加一条报告",
   是给现有十三条加上下文。
3. **`iris/variables-pruned` 是唯一已经持久化的诊断**,而且**除了测试没有任何读者**。
   它是"宿主有但没有面"的最纯粹例子。

---

## 二、差集:接线级 vs 真缺采集

对着 `OBSERVABILITY.md` 第五节的十二条。

### 接线级(宿主已产出,缺留存/缺面)

| # | 条目 | 缺什么 |
| --- | --- | --- |
| 1 | 分 frame 的日志视图 | 留存 + 读 RPC。内容已有 |
| 2 | 错误点名来源 | **给现有十三处报告加结构化字段**,不是新采集 |
| 3 | 具名拒绝进面板 | 拒绝已经具名,但只交给调用方;需要在抛出处**同时**记一条报告 |
| 5 | 判决可撤回且留痕 | 需要报告有身份(seq)才能被后续标记 `withdrawn` |
| 7 | 开销画像 | 部分已有(`ScriptView.bytes`、`script.context` 增长告警);其余是新采集 |

### 真缺采集

| # | 条目 | 为什么不是接线 |
| --- | --- | --- |
| 4 | 常驻分代报告 | frame 侧(f7),宿主不产出 |
| 6 | 遗言通道 | frame 侧(f7) |
| 8 | 未处理异常 / Promise 拒绝 | frame 侧;**宿主这边没有对应缺口**——宿主的失败都经过 `#report` |
| 9 | 保留堆栈 | **陷阱**:`#report(new Error(...))` 里的 Error 是**在报告点新建的**,它的堆栈是宿主自己的调用栈,不是失败的来源。要真堆栈得在**抛出处**捕获 `cause` 并一路带过来。今天有 3 处 `#report(..., cause)` 形态,其余 10 处丢了原始错误 |
| 10 | 诊断默认开、代价可控 | 宿主诊断本来就是常开的;代价问题变成"环形缓冲多大" |
| 11 | 跨刷新持久化 + 导出 | 新建。**注意:宿主的报告缓冲活在进程里,重启即失**,而"跨刷新"在 frame 侧指的是页面刷新——两个不同的生命周期,别混 |
| 12 | 渲染判定可解释性 | 新建,且主要在 frame 侧 |

**给协调者的一句**:六个上游缺口里,宿主这半真正要新建的只有**留存**一件;其余不是
frame 的活,就是"给已有报告加字段"。这比章程读起来的工作量小。

---

## 三、契约提议:一个读面,拉取不推送

### 3.1 结构化报告

给 `#report` 一个上下文参数,把今天的文本前缀升成字段:

```ts
interface DebugReport {
  /** 单调递增,用作游标,也是「判决可撤回」要标记的身份。 */
  seq: number
  at: number
  /** 今天的文本前缀,升成枚举:mvu | template | prompt | script | variables | host */
  kind: string
  /** 哪段对话、哪张卡、哪个脚本 —— 层一第 2 条要的就是这三个。 */
  chatId?: string
  characterId?: string
  scriptId?: string
  message: string
  /** 原始错误的堆栈,**仅当报告点拿得到 cause 时**。见下。 */
  stack?: string
}
```

**`stack` 必须诚实地可缺席。** 十三处里只有三处握有原始 `cause`;其余十处报告的是
一段自己写的话,给它配一条宿主自己的调用栈**比没有堆栈更坏**——它看起来像失败的来源
而不是报告的位置。所以:**有 cause 才有 stack,没有就没有这个字段**,不要伪造。

### 3.2 读 RPC

```ts
'debug.reports': { since?: number, limit?: number }
  → { reports: DebugReport[], dropped: number, oldest: number }
```

- **拉取,不活推。** 广播通道已经存在,把诊断流挂上去等于让 debug 页变成日志订阅——
  章程明确裁的是页面不是平台。`since` 游标 + 轮询足够,而且**页面不开时零成本**。
- **`dropped` 是必需字段,不是装饰。** 环形缓冲满了会丢老的,而"我看到的就是全部"
  和"前面还有我没看到的"是读者要做不同事情的两种状态。缺了它,一个被截断的诊断包
  和一个完整的长得一模一样。
- **`oldest`** 让页面知道自己的游标是不是已经落在缓冲之外了。

### 3.3 缓冲

进程内环形缓冲,**同时按条数和字节封顶**。

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

### 3.5 两条时间线,不合流(已裁 2026-09-02)

宿主的报告和 frame 的报告**各自成线**,页面上并排分栏,并且**明标「未对齐」**。

理由是钟:两边各带自己的时间戳,而**跨域钟差没有被量过**。合流会产生一条读起来像
单一真相的时间线,而它在两个来源交错处的排序是不可信的——**一条错序的合并时间线比
两条诚实的分栏更坏**,因为它把「我不知道谁先发生」变成了一个看起来确定的答案。

合流是奢侈品,等钟差被量过再说。在那之前,页面上的「未对齐」标签是这个未知的落点,
不是装饰。

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

第二种正是 `OBSERVABILITY.md` 缺口 10(降级成功)在**页面自己身上**的复发:一个
本该说「我不知道」的组件,说了「一切正常」。我们花了整个项目在别处修这个形状,不能
在诊断页上重犯——**诊断页说谎的代价比别处更高,因为它是人来查别处说谎时用的工具。**

**结论,给实现的硬约束:页面的每个分区要么显示数据,要么显示「此类未接线」,
永远不显示裸的空白。** 裸空白是页面自己的静默失败。

这条对宿主侧的要求是:`debug.reports` 的响应要让页面**分得出这两件事**。最小做法是
让宿主声明它接了哪些 `kind` —— 有声明而无记录 = 情形 1,无声明 = 情形 2。具体字段
形状留给实现,但**页面不能靠「记录数为零」自己猜是哪一种**,那正是它猜不出来的东西。

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
  不合流。** 见 §3.5。
