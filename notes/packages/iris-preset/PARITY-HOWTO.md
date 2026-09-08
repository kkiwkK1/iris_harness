# 怎么证明「预设在 Iris 里不如在 ST 里有效」

「不那么有效」如果是真的，只可能有一个原因：**Iris 发给模型的请求和 ST 发的不
一样**。同一张卡、同一份预设、同一段对话，两边发出的字节应当相同（除了记在
`notes/packages/iris-app-service/DEVIATIONS.md` 里的分叉）。所以排查不是猜，而是
把两个请求都抓下来、逐字节对齐。

三步。

---

## 第一步：抓 ST 的真实请求

`scripts/capture-endpoint.mjs` 是一个**只监听本机回环**的假端点。它长得像
OpenAI 兼容 API，但不转发任何东西——收到请求就把 body 原样写盘，然后回一段固定的
空流式回复，让 ST 那边不至于卡住或重试。

```
node scripts/capture-endpoint.mjs --out cap/st --port 8899
```

它会打印监听地址。然后在 SillyTavern 里：

1. API 选 **Chat Completion**；
2. Source 选 **Custom (OpenAI-compatible)**；
3. 端点填 `http://127.0.0.1:8899/v1`，API key 随便填一个非空字符串；
4. 点 Connect——模型下拉里会出现 `iris-capture`；
5. **切到你要对照的那张卡、那份预设、那段对话**，发一条消息。

`cap/st/` 下就会多出一个 `20260908-143012-004.json`。那就是 ST 的真实请求：约
一百个设置字段、两轮宏展开、一次世界书扫描、一次预算裁剪、三层正则之后的最终产物。

> 抓包进程不发起任何对外连接，也不写 ST 的任何数据。抓完把 ST 的端点改回去即可。

要抓不同场景就多发几次：`continue` 一次、`swipe` 一次、`impersonate` 一次。文件名
按时间排序，序号递增。

## 第二步：跑对照

`scripts/preset-parity.mjs` 有两种用法。

**A. 两边都已抓到**（推荐，最干净）——把 Iris 的端点也指向一个抓包进程，用另一个
端口和另一个目录：

```
node scripts/capture-endpoint.mjs --out cap/iris --port 8900
node scripts/preset-parity.mjs --st cap/st/2026….json --iris cap/iris/2026….json
```

**B. 只抓了 ST，Iris 这边现场装配**——脚本会把 profile **拷贝**到临时目录再跑，
不动你的真实数据：

```
node scripts/preset-parity.mjs --st cap/st/2026….json --data apps/iris/data --chat <chatId>
```

### ⚠ 缓存友好装配会重排请求

Iris 的缓存友好装配（默认开，`DEVIATIONS.md` §38）会**故意**把每轮都变的段挪到
对话后面。这个重排比保真审计想找的任何差异都大，会把别的发现全压在一堆
「moved」下面。对照时要关掉：

- 用法 B：脚本自己会设 `IRIS_CACHE_FRIENDLY=0`，并在报告头里写出来；
- 用法 A：抓 Iris 那一侧时，启动 Iris 前设 `IRIS_CACHE_FRIENDLY=0`，或者把该
  对话的 `cacheFriendly` 设成 `false`。

关掉之后 Iris 用的就是 ST 的顺序，报告里的「moved」才是真的顺序 bug。

## 第三步：读报告

报告分四节，按「先看哪个」排的。

### 1. body fields

顶层字段逐个对。三种结论要分开看：

| 结论 | 意思 |
| --- | --- |
| `differs` | 两边都发了这个字段，值不同。**最值得先查的一类**——比如 `max_tokens` 不一样，回复长度就会不一样。 |
| `st-only` | ST 发了，Iris 没发。可能是 Iris 没读这个预设字段。 |
| `st-only (server-side)` | ST 发给**它自己的后端**、后端消费掉的字段（`chat_completion_source`、`user_name`、`char_name` 之类）。**不是差异**，Iris 不需要发。 |
| `iris-only` | Iris 发了、ST 没发。 |

`st-only (server-side)` 这一档存在的理由：ST 的 `generate_data`
（`openai.js:2742-2767`）是发给 ST 服务端的，服务端再据此拼真正的模型请求。把这些
列成缺口会让每份报告顶上多十几条假发现。

### 2. message framing

消息条数和角色序列。**这里通常会有一条稳定差异**：ST 把预设里每个 system 段发成
一条独立 system 消息（除非 `squash_system_messages` 开着），Iris 把所有 system 段
用空行拼成**一条** system 消息。

这是「框架」差异不是「内容」差异，所以单独报一节；第 3、4 节会把两边的 system
串先合并再比，免得这一条差异把内容比较全盖住。想看原样就加 `--no-merge-system`。

如果 `messages carrying a "name" field` 两边不一样，那是 ST 的
`names_behavior = COMPLETION` 在给消息加 `name`——Iris 目前不实现（见清单）。

### 3. system blocks

把两边的 system 文本按空行切成块，按**内容**对齐：

- `ST-only` —— ST 发了、Iris 一个字没发的段。**这是「预设没生效」最直接的证据**：
  某个预设段、某条实用提示、某个世界书条目，Iris 根本没放进去。
- `Iris-only` —— Iris 多发的段。
- `moved` —— 两边都发了但顺序不同。报的是**最小移动集**（谁动了），不是「谁现在
  排在谁后面」——后者会把「c 挪到最前面」报成「a 和 b 都动了」，方向正好相反。

### 4. first byte of divergence

整段文本第一处不一致的**字节**位置，两边各给 60 字上下文。第 3 节告诉你哪段丢了，
这一节告诉你同一段里第一个字在哪儿开始不同——宏展开差一个字符、正则多吃一个换行、
名字前缀有没有，都在这里现形。

---

## 已知会出现在报告里的差异

跑之前先知道这些，省得当成新发现：

| 报告里的样子 | 原因 | 记在哪 |
| --- | --- | --- |
| ST 多条 system 消息 vs Iris 一条 | Iris 把 system 段拼成一条 | 本文件第 2 节 |
| 一堆 `moved` | 缓存友好装配没关 | `DEVIATIONS.md` §38 |
| `st-only`：`logit_bias` | Iris 不实现 logit bias（`bias_preset_selected`） | `DEVIATIONS.md` §46 |
| `st-only`：`n`、`include_reasoning`、`enable_web_search`、`verbosity` | Iris 不发这些 | `DEVIATIONS.md` §46 |
| ST 消息带 `name` | `names_behavior = COMPLETION` 未实现 | `DEVIATIONS.md` §46 |
| ST 的 AI 回复里有 `<think>`/`<draft>` 块被删掉、Iris 的没删 | 预设内嵌正则（`extensions.regex_scripts`）未接线 | `DEVIATIONS.md` §47 |
| `squash` 后的分隔符 | 上游是一个换行 | `DEVIATIONS.md` §41 |

## 报告只能说明它测到的那一次

一份报告描述的是**一次装配**，不是「Iris 总是这样」。世界书激活、`{{random}}`、
MVU 变量、深度注入的落位都随对话状态变。想说「这是稳定差异」，就抓两次不同轮次、
两次都跑，两次报告说同一件事才算。
