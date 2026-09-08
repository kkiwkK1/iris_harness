# 前缀缓存：一次测量，以及能做与不能做的事

> **2026-09-08 起，§3 的提案不再是待裁决状态。** 「缓存友好装配」已经实现
> （默认开，`IRIS_CACHE_FRIENDLY=0` 全局可关），账本在
> `DEVIATIONS.md` §38，开/关对照数字在 `scripts/cache-friendly-probe.mjs`。
> 与本文两处不同，都是后来测出来的：
> **(1)** 提案 A 的「深度插入一律不动」只对 depth 0 成立——depth ≥ 1 落在历史
> *里面*，也就是落在两轮本会一致的那段里，所以它们也被搬；
> **(2)** 本文的数字是 2026-09-07 的，语料是活的，爱衣此后大约翻了一倍
> （body 54 855 → 111 549 B），所以两份表**不能直接对照**，只能各自读各自的时刻。
>
> 2026-09-07。工具：`scripts/cache-prefix-probe.mjs`。
> 输入：用户自己的 profile（`apps/iris/data/default-user`，**只读拷贝**到临时目录后运行）。
> 全程不发网络请求：注入的 `stream` 抓下 `GenerateOptions` 后直接抛错，因此连
> 候选都不会落盘，"同一状态装配两次"才是可问的问题。

DeepSeek 的上下文缓存按**请求前缀**命中，块大小 64 token
（`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`）。
前缀里改一个字节，其后全部 miss。所以"命中 15%"不是"两轮共享 15% 的文本"，
而是"两轮在 15% 处就开始不一样了"。

## 0. 先纠三条前提

任务书带来的三条前提，实测都不成立，先说清楚，否则后面的结论会被读成别的意思。

1. **三条对话里只有一条量得出"相邻两轮"**。`爱衣` 有 25 条消息（12 轮生成，本轮测量期间从 23 条长到 25 条），
   `【Sgw】又看一集` 只有 3 条（1 轮），`灭仇家满门之后…` 只有 1 条（0 轮，
   就是开场问候）。后两个文件很大（244 KB / 38 KB）是因为单条消息很长和 swipe 很多，
   不是因为轮数多。所以下面的相邻轮测量全部来自 `爱衣`，用它的 9 对相邻轮
   （从 6→8 条消息一直到 22→24 条）作样本，而不是只用最后一对——
   9 对里有 4 对的第一处差异落在 depth 0 那块本身（它内容也变了），
   5 对落在新增楼层，单看一对会挑到其中一种形状并得出偏窄的结论。
2. **Iris 自己不拥有任何"运行期注入"**。`iris/*` 是 session 日志的事件类型
   （`entry.ts:1033`、`prune.ts:121` 的 `iris/rows-pruned` 等），永远不进提示词。
   进提示词的 depth/system 贡献只有四类来源：预设（`@iris/preset`）、世界书扫描、
   persona、卡的 `depth_prompt`，加上卡脚本自己注册的 `script.inject`。
   所以任务 4 ① 的"把 Iris 自己的注入统一移到历史之后"没有对象可移。
3. **Iris 没有"作者注释"这个用户功能**。上游的作者注释是深度插入的
   （`script.js:3160`，`setExtensionPrompt(NOTE_MODULE_NAME, …, chat_metadata['note_position'],
   chat_metadata['note_depth'], …)`）；Iris 只把世界书的 ANTop/ANBottom 桶收成
   **一个 system 段**（`prompt.ts:550-557`，`order: 900`），不是深度插入。
   已经写在 `persona.ts:38-39`。

## 1. 测得的数

### 1.1 用户看到的 15% 是哪来的

`爱衣` 的 chat 文件里有 `iris_usage`（真实生成，浏览器开着、卡脚本在跑）。
**这个语料是活的——用户在本轮测量期间又打了一轮**，所以两次读数都记下来，
各自属于各自的时刻：

第一次读（本轮开始时，5 条生成）：

| 消息 | 计费 input（= miss + hit） | 命中 | 单轮命中率 |
|---|---|---|---|
| 14 | 10 734 | 0 | 0.0% |
| 16 | 11 019 | 3 456 | 31.4% |
| 18 | 13 367 | 0 | 0.0% |
| 20 | 13 601 | 6 144 | 45.2% |
| 22 | 15 164 | 0 | 0.0% |
| **合计** | **63 885** | **9 600** | **15.03%** |

界面那一行是**会话累计**（`token-format.ts:244-245`，
`cacheReadTokens / billedInputTokens`），**15.03% 就是用户看到的那个 15%**。

第二次读（约两小时后，多了消息 24）：

| 消息 | 计费 input | 命中 | 单轮命中率 |
|---|---|---|---|
| 24 | 12 343 | 9 216 | **74.7%** |
| **合计** | **76 228** | **18 816** | **24.7%** |

单轮不是"稳定的 15%"，是 **0 / 31.4 / 0 / 45.2 / 0 / 74.7 交替**。
最新那一轮 74.7% 已经贴到 §1.2 测出的天花板（~86%）了——
这条很重要：**天花板不是 15%，miss 是间歇性的**，
所以"提到 95% 以上"要解决的是"为什么有些轮整轮全 miss"，
而不是"为什么每轮只共享 15%"。

### 1.2 宿主自己装配的天花板（无卡脚本）

同一条对话，用宿主真实路径（`#start` → `TurnDriver` → `assemble` → 模板 →
`serializeRequest`）装出相邻两轮，比 JSON body 的公共前缀：

| 相邻轮（消息数） | body 前后（字节） | 公共前缀 | 上界命中率 | 第一处差异落在 | 不可命中字节 = 新文本 + 前缀后逐字重复 |
|---|---|---|---|---|---|
| 6 → 8 | 33 905 → 34 563 | 28 209 | **81.6%** | depth 0 世界书块（内容也变了） | 6 354 = 5 982 + 0 |
| 8 → 10 | 34 563 → 37 129 | 28 867 | **77.7%** | 同上 | 8 262 = 7 850 + 0 |
| 10 → 12 | 37 129 → 41 941 | 31 433 | **74.9%** | 新增的 assistant 楼层 | 10 508 = 4 688 + **5 393** |
| 12 → 14 | 41 941 → 47 229 | 36 245 | **76.7%** | depth 0 世界书块（内容也变了） | 10 984 = 10 541 + 0 |
| 14 → 16 | 47 229 → 48 594 | 41 560 | **85.5%** | 新增的 assistant 楼层 | 7 034 = 1 284 + **5 366** |
| 16 → 18 | 48 594 → 50 424 | 42 925 | **85.1%** | 新增的 assistant 楼层 | 7 499 = 1 747 + **5 366** |
| 18 → 20 | 50 424 → 51 579 | 44 755 | **86.8%** | depth 0 世界书块（内容也变了） | 6 824 = 6 442 + 0 |
| 20 → 22 | 51 579 → 52 940 | 45 909 | **86.7%** | 新增的 assistant 楼层 | 7 031 = 1 282 + **5 367** |
| 22 → 24 | 52 940 → 54 855 | 47 270 | **86.2%** | 新增的 assistant 楼层 | 7 585 = 1 838 + **5 367** |

9 对的上界命中率：74.9% – 86.8%，均值 **82.3%**；后 5 对（14 条消息以上）
稳定在 85% – 87%。会话越长这个上界越高，因为 depth 0 那块的大小基本不变
而分母在长。

token 估算（宿主自己的 `estimateTokens`）在最后一对上是 ~12 537 / ~14 679。

`爱衣` 最后一轮的构成（宿主自己的 itemization，非重算）：

| 段 | token |
|---|---|
| system：`main` | 35 |
| system：`worldInfoAfter` | 5 601 |
| depth 0：`worldInfo.depth.0.0` | 1 647 |
| 历史（聚合一行） | 7 410 |
| **合计** | **14 693** |

`worldInfoBefore` 连一行都没有，因为 `resolvePreset` 对空文本的 marker
直接 `continue`（`chat-completion.ts:247`），所以它压根没成为 contribution。
**实测**（探针的 `IRIS_PROBE_NEEDLES`，在装配好的请求里搜字面量）：
`worldview_final`、`角色总览`、`scene_生活地图` 三个串**都不在请求里**，
而 depth 0 变量表里的 `当前时间` 在。也就是说三条 `position: 0` 的常量条目
（`世界观` 93 / `角色速览` 445 / `生活地图` 1089 字符）从未进过提示词。

算术对得上世界书预算：`computeBudget(32768, 25, 0) = 8192` token
（`activate.ts:332-335`），已入选的是 `worldInfoAfter` 5 601 + depth 0 1 647
= 7 248 token，再加最小的那条也会越过 8 192。这三条的 `insertion_order`
是 1/2/4，是全书最低（depth 0 那批 200，`position: 1` 那批 99），
而上游按 order 降序分配预算——所以这大概是忠实行为，不是缺陷。
记在这里是因为它解释了为什么 system 段只有两行。

> **标签的读法**：探针给每段贴的名字是"最长字面片段"匹配（`labeller`），
> 不是权威来源。`爱衣` 的 depth 0 块会被贴成
> `world "[SG]可攻略女主拒绝被攻略" #13`——那是因为 MVU 的那套样板
> （变量更新规则 / 输出格式）被好几张卡抄了同一份，字面片段先在别的书里命中。
> 权威名字来自宿主自己的 itemization 行：`worldInfo.depth.0.0`。

### 1.3 对照：同一状态装配两次

**任务要求的对照是"必须 100%"。`爱衣` 是 100%（54 855 → 54 855 字节，逐字节相同），
序列化两次也逐字节相同。** 但把对照扩到全部 15 条对话，**4 条会抖**：

| 对话 | body | 公共前缀 | 天花板 | 抖的是什么 |
|---|---|---|---|---|
| `OVERLORD不死者之王-…-141249` | 25 023 / 25 021 | 5 480 | **21.9%** | `system[8]`：世界书条目里的掷骰结果（"我方点数池：11,14,1,16,20,5" → "1,6,15,14,5,9"） |
| `OVERLORD…-122900` | 25 020 / 25 020 | 5 480 | **21.9%** | 同上 |
| `OVERLORD…-093950` | 25 025 / 25 022 | 5 479 | **21.9%** | 同上 |
| `Sgw又看一集` | 33 206 / 33 206 | 32 452 | **97.7%** | `msg[3]`：`Avatar_Map` 里 `{{random::ing8z5::50wh85::…}}.png`，每轮换一张头像 |

两处都是**卡作者故意写的随机宏**（`{{roll}}` / `{{random}}`），不是我们在抖：
`@iris/macro` 的 `registry.ts:197-199` 把随机源接到 `Math.random`，而上游同样
`entropy: true`（`scripts/macro-differential.mjs` 里已经记了这条）。
差别只在**它落在哪里**：OVERLORD 那条掷骰段在 system 段的第 8 块、
文本第 5 239 字节（约全长 21%），所以**每一轮都只能命中 21%**——
这正是"15% 量级"的形状。

### 1.4 32K 窗口截掉了几条对话

15 条全部：`droppedHistory = 0`，`overBudget = false`。
**没有任何一条对话的历史被 32 768 的窗口截掉过**（最大的 `爱衣` 装到
~15.2 K token，离窗口还有一半）。所以 `service.ts:461` 的
`contextWindow 32768` / `reserveTokens 1024` 目前不是命中率的因素。

### 1.5 `max_tokens` 不发时的输出上限

`serialize.ts:91`：只有 `options.maxTokens !== undefined` 才发 `max_tokens`。
往上一层：harness 会在 `info.defaultMaxTokens` 存在时替我们补一个
（`dsh-llm/lib/index.js:1462-1466`），但 `OpenAiCompatAdapter` 从不报这个字段
（`index.ts:187-200` 只报 `contextWindow`），`apps/iris/cordis.yml` 的 model 行
也只写了 `contextWindow: 32768`。所以**不设就是真的不发**。

DeepSeek 在不发 `max_tokens` 时的默认输出上限：**本仓库没有任何记录**
（`notes/`、`docs/` 全文搜过 `max_tokens` 与输出上限，只有上游 ST 的
`openai_max_tokens` 300→30000 那一类记载）。**未知，需查文档**——不猜。

## 2. 归因

按任务书的四类，用 1.2 / 1.3 的数：

| 类 | 是什么 | 在这批数据里的量 |
|---|---|---|
| (a) 历史自然增长（尾部，正常） | 每轮新增的 user + assistant 两条 | 1 282 – 10 541 字节／轮，占不可命中量的 23% – 100% |
| (b) 按深度插入的内容 | `爱衣` 只有一个 depth 0 桶（5 条 `position: 4, depth: 0` 的世界书条目，含 `变量列表` → `{{format_message_variable::stat_data}}`），5 367 字节 / 1 647 token | 9 对相邻轮里有 5 对它逐字未变却整块落在前缀之后，**占该轮损失的 51% – 76%**；另 4 对它内容也变了（5 393 → 5 366 → 5 367 字节） |
| (c) 前部易变内容 | 卡的 `{{roll}}` / `{{random}}` 宏 | OVERLORD ×3：落在 21% 处 → 天花板 21.9%。Sgw：落在 97.7% 处 → 天花板 97.7%。`爱衣`：无 |
| (d) 我们自己引入的易变项 | run id、键顺序不稳、`stream_options`、`seed`、`name`、`Date.now()` | **测得为 0。** 对照 100%；序列化两次逐字节相同；`serializeRequest` 用字面量列字段所以键顺序固定；`injectedContributions` 已按 key 排序（`service.ts:3325`）；`renderSystem` / `injectAtDepth` 都用 (order, sequence) 稳定排序；`samplingOf` 只是设置的投影，没有随机 seed；`serializeMessages` 根本不发 `name` 字段 |

**(d) 里唯一一个还站着的隐患**（没改，因为改了就是偏离上游）：
模板批次号 `#traceId`（`service.ts` 的 `this.#traceId += 1` → `buildSnapshot`
→ `environment.ts:445` 的 `{ _trace_id: snapshot.traceId, _modify_id: 0 }`）。
它每次生成都加一，且**暴露给卡的 EJS**。读了它的模板每轮输出都不同，
落在哪就从哪开始 miss。但 `_trace_id` 是上游自己的量（`types.ts:94-95` 已注明），
去掉它是行为偏离，不是修 bug。默认 `IRIS_TEMPLATES` 不为 `1` 时整条路径不跑。

### 2.1 三个 0% 轮落在哪：测到的与推的

`爱衣` 无卡脚本时相邻轮天花板 74.9% – 86.8%（9 对均值 82.3%），
真实测得 0 / 31.4 / 0 / 45.2 / 0 / 74.7。最后那一轮基本达到了天花板，
所以要解释的不是"为什么只有 82%"，而是"为什么有三轮是 0"。
分成"测到的"和"推的"两层说：

**测到的**：探针看不到 `ChatEntry.extensionPrompts`。它是每个 `ChatEntry`
自己 new 的 `Map`（`entry.ts:329`），从不落盘；卡脚本通过 `script.inject`
注册的东西只活在浏览器开着的那个进程里。无头跑没有浏览器，所以这一路的流量
**一条都没进探针**。`爱衣` 的卡确实跑 MVU（`extensions.tavern_helper.scripts`
两条：`import 'https://…/MagVarUpdate/artifact/bundle.js'` 和一份 zod schema），
而缓存下来的 bundle（`script-bundles/d2245aa5….js`）里能看到它自己发
`generate({… injects: [{position:'in_chat', depth:0}, {depth:2, content:'<past_observe>'},
{depth:1, content:'</past_observe>'}]})`。

**推的（假设，不是测量）**：`placementFor`（`service.ts:3294-3303`）把
`position: 'before'` 映射到 `{kind:'system', order: 850}`、`'after'` → 950，
而预设的 system 段 order 是 10、20、30…（`chat-completion.ts:249`，`order += 10`，
41 条预设最多到 410）。**所以卡脚本注入的 system 内容落在 system 段的最末尾。**
按 1.2 的构成算：system 共 5 636 token / 总 14 693 token，
一个每轮都变的 `'before'` / `'after'` 注入把天花板压到 **5 636/14 693 = 38.4%**。
实测那两个非零轮是 31.4% 和 45.2%——**恰好夹住 38.4%**。这是巧合还是机制，
本轮没有能区分二者的仪器（见本节末）；写在这里是为了让下一次测量知道
该去证伪什么。
三个 0% 轮要求差异出现在**前 64 token 之内**，而 `main` 段只有 35 token，
宿主自己的装配（对照 100%）做不出这种差异；剩下的可能是浏览器侧注入排到了
更前面，或者是 DeepSeek 端的非确定性（文档明说命中不保证）。

**这条要定案只需要一个仪器，而且是耐久的那种**：把每次真实发出的 body 的
`sha256` 和"前 64 token 的 sha256"记在诊断缓冲里。现在这两轮请求发出去以后
不留任何痕迹，事后无法区分"我们抖了"和"provider 没给"——和
`transient UI` 一样，3 秒的提示与从未发生长得一模一样。

## 3. 提案（不在这一轮实施，等总指挥裁决）

### 提案 A — Iris 自己的注入统一移到历史之后

**无对象。** 见 §0.2。唯一由 Iris 追加在最后的东西已经在最后了：continue 的
nudge 和 impersonate 的指令，`driver.ts:192-194` 明确把 `tail` 放在
`assemble` 之外、整段对话之后，注释写的理由就是"深度 0 落在最新楼层之后，
被注入挡住的 nudge 就不是模型最后读到的东西"。

不需要做的事记一句：**不要**把 depth 0 的内容改成"追加在 tail 之后"。
它们已经在新历史之后了；再往后挪一格不改变"落在前缀之外"这件事，只会打乱
`injectAtDepth` 里 order 的语义。

### 提案 B — 深度插入能不能在保持模型可见相对位置的前提下换写法

**不能。如实说。**

上游的深度插入是"距对话末尾 k 条"（`world-info.js:855-864`
`world_info_position.atDepth = 4`；`script.js:4612`
`setExtensionPrompt(CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joined, IN_CHAT, e.depth, false, e.role)`；
`script.js:483-488` 的 `extension_prompt_types.IN_CHAT = 1`）。
Iris 一比一保留（`assemble.ts:111-142` 的 `injectAtDepth`，注释里点明
"depth 0 落在最后一条之后，depth 1 落在它之前"）。

历史的增长点在**末尾**。任何锚在末尾的东西，其绝对位置每轮都会前移，
于是必然落在前缀分界之后。这是几何，不是实现选择：

- 把它挪到 system 段 → 它进了稳定前缀，但**它自己每轮变**（`爱衣` 那块
  含实时变量表），于是从它开始整条历史全 miss，天花板从 86.2% 掉到 38.4%。
  更差。
- 把 depth 0 桶拆成"静态部分 + 易变部分" → 两部分都还在新历史之后，
  一个字节也救不回来。
- 只把**静态**部分移到 system 段（`爱衣` 那 5 条里有 4 条是静态的
  `二次解释` 993 / `变量更新规则` 1487 / `变量输出格式` 1700 / `强调` 149
  字符，只有 `变量列表` 98 字符展开成实时表）→ 每轮重发从 5 367 字节降到
  只剩变量表。**这个确实有效**，但它改的是模型看到的相对位置
  （指令从"紧贴回复前"变成"贴在角色卡后"），对遵循度的影响是真的，
  而且这是**卡作者的选择**（条目上写着 `position: 4, depth: 0`）。
  Iris 单方面改写卡的 `position` 会让同一张卡在 ST 和 Iris 里表现不同。
  → 只能作为**用户旋钮**列出（§提案 C），不能作为默认变换。

**结论**：(b) 类没有等价变换。能做的只有把"每轮重发的量"缩到最小，
而这一步的决定权在卡/用户那边。

### 提案 C — 用户可以自己调的旋钮（Iris 已经有的）

DeepSeek 的建议是"稳定内容放前面、易变内容放后面"。下面每一条都是
**用户在 Iris 里已经能改**的，代码不用动；写清楚它改了什么、代价是什么。

| 旋钮 | 在 Iris 哪里 | 上游对应 | 对前缀的影响 | 代价 |
|---|---|---|---|---|
| 世界书条目的 `position` / `depth` | `worldbook.replace`（条目视图带 `position: {type, role, depth, order}`，`views.ts:977-982`） | `world_info_position`（`world-info.js:855`） | 把**静态**的 depth 0 条目改成 `after`（position 1），它进稳定前缀；`爱衣` 可把每轮重发的 5 367 B 降到约 300 B，天花板 86.2% → **约 96%** | 指令位置变了，遵循度可能下降；导回 ST 的卡也变了 |
| 世界书里的 `{{random}}` / `{{roll}}` | 同上（编辑条目内容） | `entropy: true` 的宏 | OVERLORD：把掷骰段从 `system[8]` 移到 depth 0，天花板 **21.9% → 约 98%**（掷骰本来就该在回复前读） | 需要卡作者同意；这是最划算的一条 |
| `insertionStrategy` | `worldbook.setSettings`（`worldbook-settings.ts:229` ↔ `world_info_character_strategy`） | `world-info.js:80` | 只改**角色书与全局书的相对顺序**；一旦定下来两轮之间不变，所以它不改善也不损害命中——**但改动它本身会让下一轮全 miss 一次** | 改一次付一次全 miss |
| `budgetPercent` / `budgetCap` | `worldbook.setSettings`（↔ `world_info_budget` / `world_info_budget_cap`） | — | 预算变动会改变哪些条目入选 → 全 miss 一次。调大能让被挤掉的 `position: 0` 条目回来（见 §1.2） | 同上；且提示词更长 |
| persona 的 `position` / `depth` | `persona.set`（`position: 'atdepth'` + `depth` + `role`） | `script.js:3164`，`persona_description_depth` | 描述从深度插入改成 system 段 → 进稳定前缀（persona 描述通常是静态的，**净收益**） | 相对位置变了 |
| `contextWindow` | `settings.set` | `openai_max_context` | 目前不相关（§1.4，没有一条被截）。**但一旦历史真的开始被截，每轮截掉的那一条都会让整条历史 miss**——这是长对话里最凶的一种 (b) | — |
| `maxTokens` | `settings.set` | `openai_max_tokens` | 不影响前缀；影响 `reserveTokens` 参与的预算，因而间接影响什么时候开始截历史 | — |
| `seed` | `settings.set` | `seed` | 设了就每轮都发同一个值，不影响前缀；**不要**改成每轮随机（会破 `sampling` 之后的字段，虽然 `seed` 在 body 尾部，影响有限） | — |

**给用户的一句话结论**：`爱衣` 那条会话要从 15% 提到 95% 以上，
靠调 Iris 的设置做不到，因为吃掉命中率的是**卡脚本每轮注入的内容落在
system 段末尾**（§2.1，推断）和**卡作者把易变内容放在提示词前部**（§1.3，实测）。
可以确定能拿到的是：把静态的 depth 0 条目移到角色卡之后（天花板 86.7% → ~96%），
以及把 OVERLORD 那类掷骰段从前部移到 depth 0（21.9% → ~98%）。

### 提案 D — 唯一一个纯 Iris 侧、且不改卡语义的改动

给 `placementFor` 的 `'before'` 一个**真的在前面**的 order（例如 5），
让 `position: 'before'` 的注入落在预设第一段之前，而不是最后一段之后。

- 现在：`'before'` → `order: 850`，预设段是 10…410，作者注释是 900。
  所以 `'before'` 实际落在"除作者注释外的所有东西之后"。
- 上游：`extension_prompt_types.BEFORE_PROMPT = 2`（`script.js:483-488`），
  语义就是"整段提示词之前"。
- 对缓存的影响：一个每轮都变的 `'before'` 注入，现在把天花板压到
  system 段占比（`爱衣` 38.4%）；移到最前面会把它压到**接近 0**。
  **所以这个改动会让缓存更差，不是更好。**

写在这里是因为它是本轮唯一发现的"我们和上游对不上、且直接影响前缀位置"的点，
需要总指挥先裁决**语义**（对齐上游 vs 保持现状），缓存只是其中一个后果。
`service.ts:3279-3292` 的注释已经承认这两个 order 是"只能承诺前面或后面"的
折中，但 850 既不是前面也不是后面。

## 4. 本轮实际改了什么

只有 (d) 类，且 (d) 类实测为 0，所以改动是**把 0 钉住**：

1. `packages/iris-llm-openai-compat/tests/serialize-stability.test.ts`（新）
   —— 同一请求序列化三次逐字节相同；结构相同但键序打乱的请求序列化结果相同；
   body 的字段白名单（新增一个会自己变的字段就红）。两个仪器互补，
   都做过 teeth-check：嵌套的 `nonce: n += 1` 只有前两条能抓，
   顶层的 `request_id: Date.now()` 只有白名单能抓（同一毫秒内三次调用相等）。
2. `packages/iris-app-service/tests/assembly-determinism.test.ts`（新）
   —— 同一对话状态装配三次，经 `serializeRequest` 后逐字节相同。夹具里
   五种落位都实测在场（常量条目进 system、常量条目在 depth 0、
   关键词触发的条目在 depth 2、卡的 note 在 depth 2、post-history 在 depth 0），
   写成逐条断言，因为夹具第一版把世界书选在建 chat 之后，
   结果一条世界书都没进请求而测试照样绿。
3. `packages/iris-llm-openai-compat/src/index.ts` —— 导出 `serializeRequest` /
   `serializeMessages`。不是新能力（`apply` 一直在发
   `JSON.stringify(serializeRequest(options))`），是让装配层能拿到字节。
4. `scripts/cache-prefix-probe.mjs`（新）—— 上面所有数字的来源。

## 5. 发现但没改

1. **`chat.regenerate` 把正在重写的那条回复也喂给模型。**
   实测：夹具里重生成一轮，捕到的请求里含 `A reply about the lake.` ——
   就是这一轮要替换的那条。原因是 `historyFromSession`
   （`packages/iris-turn/src/history.ts:36`）投影 `session.deriveMessages()`
   的全部消息，`driver.regenerate`（`driver.ts:276-280`）不摘掉当轮候选。
   上游两条路径都摘：`script.js:4344-4352`（regenerate 先
   `chat.length = chat.length - 1` 再装配）和 `script.js:4438-4440`
   （swipe 用 `coreChat.pop()`）。
   这是行为偏离，也让每次重生成的提示词无谓变长一整条回复。
   本轮没改，因为它改的是卡可见语义（超出任务 3 的范围）。
   **它也是本轮探针必须先删掉尾部回复才能重建"真实第 N+1 轮"的原因**——
   直接 `chat.regenerate` 量到的不是当初发出去的那个请求。
2. **世界书预算把 `爱衣` 的三条 `position: 0` 常量条目全挤掉了**（§1.2，实测缺席）。
   上游同样按 order 降序分配预算，所以大概是忠实的。但用户能看到的只有
   "世界观 / 角色速览 / 生活地图 三条常量条目从不出现"，
   而 itemization 里连 `worldInfoBefore` 这一行都没有——
   `resolvePreset` 对空文本 marker 直接 `continue`（`chat-completion.ts:247`），
   于是它不是 contribution，`itemize` 也就没有它的行。
   `assemble.ts` 的 `itemize` 文档写着"贡献了 0 的部分也要带着 0 出现，
   因为找不到某段的人看到 0 比看到缺席有用"——这条意图在 marker 这一层被
   上一步吃掉了。零行本身就是答案的场合，这是一个。
3. **真实请求不留任何可回查的痕迹**（§2.1 末）。没有 body 摘要、
   没有前 64 token 摘要，事后无法区分"我们抖了"与"provider 没给"。
   建议：在诊断缓冲里为每次生成记一行 `sha256(body)` +
   `sha256(前 64 token)` + `cacheReadTokens`。
4. **模板 `_trace_id` 每轮加一并暴露给卡的 EJS**（§2 末）。上游同样有，
   所以不是 bug；但它是本轮唯一一个"我们送进模板、且每轮都变"的量。
