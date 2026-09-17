# 异常 B 定层 · 创世回廊1 开场白 frame 高度振荡 —— 记录

> 状态：**记录，只记录不修**。写于 2026-09-17（文件名按仓库惯例取 ASCII 拼写，正文用卡名 `创世回廊1`），对象 main `535fc32`（产品代码等于 `0aa3ede`，`535fc32` 之后只有文档与 `qa/` 提交）。宿主 8791（复制数据目录 `data-r6`），headless Chrome `--window-size=1500,950`。
> 这是 `notes/tasks/REVIEW-6-GREETING-FRAME-OSCILLATION.md` 要的那段测量，补在 REVIEW-5 记录之外单独成篇（手册 §3 允许两种落法）。
> **没有改任何产品代码、没有改台账、没有改设置。** 唯一入库的新东西是两个一次性仪器（`qa/`，与表外仪器同例，见 §6）。

---

## 0. 一句话结论

**层：壳（阅读列布局），不是帧。** 帧报的是**一个数**（`1104 → 1105 px`，20 s 内），壳给的高度跟着**钳制带**走（`503 / 515 / 552`），而钳制带走的原因**与这张卡、这个帧、这条消息都无关**——是**壳顶部的临时通知条**（`.iris-notice`，`App.tsx` 里一个会 3.2 / 8 s 自清的横幅）在出现和消失。**`带高 + 横幅高 = 552` 在三个 run 的每一次采样上都成立**（§3.2）。把横幅按住不动，24 s 内带高只变一次（`503 → 552`，t = 13 ms）就再也不动（§3.3）。

幅度 **37 / 49 px**（单行 info 横幅 / 两行 error 横幅），不是帧那一侧报的 `1104 → 1105`。REVIEW-2 的读数 `874×513 / 874×515 / 874×503` 是这套钳制的三个取值，**不是振荡**——见 §4.2 与 §5。

---

## 1. 仪器与窗口

`qa/review6-frame-oscillation.mjs`（新，一次一条曲线对，可重跑；`qa/review6-three-runs.mjs` 是三个 run 的包装，任一 run 失败即停）。两条曲线**在同一个 `performance.now()` 时基上**，不再各拿 5 个点：

| 曲线 | 怎么取 | 记录字段 |
| --- | --- | --- |
| 帧 → 壳 | 壳的页面里 `window.addEventListener('message')`，按 `event.source === iframe.contentWindow` 与 `data.iris` 认协议消息，分 `height` / `sizing` / `note` / `ready` | `t`、`kind`、`pixels`（或 `message`） |
| 壳 | 该 iframe 的 `ResizeObserver`（**外加阅读列滚动容器的 `ResizeObserver`**，因为带高会动而帧的**已用**高未必动） | `t`、`used h/w`、`inline style.height`、`data-iris-sizing`、**当场** `computed max-height`（= 钳制带）、发布在滚动容器上的 `--iris-app-frame-height` |
| 带高的邻居 | 每次 `shell` 采样顺带读一次（`layout`） | `.iris-scroll` 的 `clientHeight` / `scrollHeight`、`.iris-masthead` / `.iris-composer` / `.iris-notice`（**带文本**）高度、`.iris-notice` 个数、`iris-scroll` 往上的 **6 层盒子链**（class=clientHeight/rect height） |

手动窗口 24 s（手册要 20 s；多出的 4 s 是留白）。**录完 24 s 后**才落盘。

帧内 `scrollHeight` 读不到（`sandbox="allow-scripts"` 无 `allow-same-origin`，跨 origin 是设计如此，手册 §2.3 与 §4 都写明不要改这个属性），所以帧那一侧只有两条可得曲线：**帧自己报的高度**，以及它 `note` 里那行 `height sources: …`（`frame-entry.ts` `describeHeightSources`，自带 `fired resize N mutation M` 计数）。

**必须先说的口径（这是 REVIEW-2 读错的直接原因）**：`.iris-interfaces__slot iframe` 的**已用高度不是帧报的高度**。`reading.css` 给槽位写 `max-height: var(--iris-app-frame-height)`，`runner.ts` 把帧报的 `pixels` 写成**内联 `style.height`**，CSS 里 `max-height` 压过内联 `height`，于是渲染出来的是 `min(内容, 带高)`。实测同一时刻：内联 `1105px`、`max-height 503px`、`getBoundingClientRect().height 503`。**REVIEW-2 量的是这三个数里的第三个。**（`reading.css` 的注释自己写了这条，`frame-fit.ts` 也写了「clamp wins over the inline height」，但两处都没有把它和这台仪器量到的量联系起来。）

---

## 2. 环境

- 宿主：**8791**（`apps/iris/bin.ts`，`IRIS_DATA_DIR=/tmp/data-r6`，是 `iris_分支/iris_harness/apps/iris/data` 的副本，复制后删 `host.lock`）。**不在 8787 / 8788 上做**（手册 §2.1）。
- 数据目录里**有**创世回廊1（`创世回廊1.png`，7.08 MB，卡内 `first_mes` 是 4 B 的 `【封面】`，开场白 frame 来自**卡自己的正则**「封面」的替换串，18112 B 的 `text` 围栏文档，`<title>创世大回廊 — 泰拉深渊`）。卡自带 9 条正则，含「状态栏」297289 B、「开局」524550 B。
- `script-policy.json`：该卡 `scriptsAllowed: true`——所以打开对话时**没有同意门**（`consent: {asked:false}`），手册 §2.2 里那一步在这份 profile 上是空操作，不是仪器漏点。
- provider 活的（deepseek），但**这一轮不生成任何东西**：只开新对话、等开场白。
- 窗口 1500×950，`documentElement.clientHeight 855`。

---

## 3. 曲线

三个 run，每个都**通过壳自己的「开始新对话」**建新会话（手册 §2.2 的路径，也是 REVIEW-2 看到异常的那条）。**不驱动任何既有会话**：这张卡在本 profile 上已经有很多会话，**标题全是 `创世回廊1.3`**，而会话行**不带会话 id**（`Sidebar.tsx` 的 `ChatRow` 只有 `aria-current`，说的是「是不是当前打开的那个」，不是「是哪一个」）。按标题点行落到哪一个是不确定的，于是仪器**拒绝**在标题不唯一时按标题落点（`openExisting`），`--new-conversation` 因此是默认路径。

**「量的是刚建的那个会话」是读数，不是假设**（每个 run 的 `identity`）：该会话 id 是宿主 `chat.list` 报出的**新** id、也是列表里**最新**的一条；壳里 `aria-current="true"` 的行在**第 0 行**（宿主按最新在前排列）；页面上 `.iris-msg` 楼层数 **= 该会话的 `messageCount`**。三者不一致时仪器不落读数、直接具名报错。

| run | 会话 id | 落定确认 |
| --- | --- | --- |
| 1 as-is | `创世回廊1-20260917-161804` | `currentRowIsNewest: true`，`floorsMatch: true`（1 楼） |
| 2 录前清一次横幅 | `创世回廊1-20260917-162044` | 同上 |
| 3 窗口内按住横幅 | `创世回廊1-20260917-162324` | 同上 |

### 3.1 两条曲线（run 1 · `创世回廊1-20260917-161804`）

| t (ms) | 来源 | 值 |
| --- | --- | --- |
| 0 | shell | 已用 **503**，**无内联高**，带 **503**（横幅 49 px） |
| 173 | shell | 已用 **515**，无内联高，带 **515**（横幅 37 px） ← 带动了，帧**还没出生** |
| 501 | frame→shell | `ready` |
| 504 前后 | frame→shell | `height` **1104**（此后 719 / 1001 / 1061 又报 1104 三次，值没变） |
| 1970 | shell | 已用 **503**，内联 1104px，带 **503**（横幅 49 px） ← 带又动了，帧什么都没说 |
| 1984 | shell | 已用 **515**，内联 1104px，带 **515**（横幅 37 px） |
| 2010 | frame→shell | `height` **1105**（帧的**全部**变化幅度：1 px） |
| 5200 | shell | 已用 **552**，内联 1105px，带 **552**（横幅 0） ← 带回去了 |
| 24004 | shell | 已用 552，内联 1105px，带 552（窗口结束） |

- 外壳的 `ResizeObserver` 一共 **4 次**变化：`503→515`（t=173）、`515→503`（t=1970）、`503→515`（t=1984）、`515→552`（t=5200）。**后三次都在帧报出它的第一个高度之后**，而帧在此期间只把 `1104` 改成 `1105`。
- 帧那一侧整个 24 s 报了 **7 次 `height`，值只有 `1104` 和 `1105`**；`note` 里那行 `height sources` 的 `body.scrollHeight` 同样只在 `1104 → 1105` 之间走。**帧内内容没有重排成 503 或 515。**
- **首帧那个 `503` 不是帧报的**：`observe:start` 时槽位里的 iframe `inline` 为空（没有帧报的高度），已用高 = 带高（此时恰好相等）。另一次 run 里首帧读到 `513`，那是 `515 - 2`——`overflow-y: auto` 的滚动条宽度（`frame-height.ts` 的 `OVERFLOW_SLACK_PX` 语义相同）。

### 3.2 `带高 + 横幅高 = 552`（三个 run，每一次采样）

run 1（as-is）逐次采样，`band+banner` 恒为 **552**：

```
t=0     503px + 49px = 552   iris-notice--error  "小手机脚本: 失败：Failed to fetch dynamically imported module…"
t=1     503px + 49px = 552   (同上)
t=173   515px + 37px = 552   iris-notice--info   "blocked gitgud.io (img-src)"
t=174   515px + 37px = 552
t=1970  503px + 49px = 552   iris-notice--error  小手机脚本 …
t=1971  503px + 49px = 552
t=1984  515px + 37px = 552   iris-notice--info   "blocked cdn.jsdelivr.net (style-src-elem)"
t=1984  515px + 37px = 552
t=5200  552px +  0px = 552   (无横幅)
t=5200  552px +  0px = 552
t=24004 552px +  0px = 552
```

run 2（录前清空一次通知区）同一条算术，八次采样 `552+0` / `515+37` / `503+49` / `552+0`，恒为 552。

**37 / 49 是同一件事的两个高度**：单行 info 横幅 37 px、两行 error 横幅 49 px；`552 - 37 = 515`、`552 - 49 = 503`。REVIEW-2 量到的 `513`、`515`、`503` 全在这条算术里，**一个也没剩下**。

`.iris-notice` 是 `App.tsx` 里 `.iris-stage` 的**兄弟**，`stage` 是 `flex: 1`，`App.tsx` 的 `useEffect` 给横幅挂了 `setTimeout(dismissNotice, error ? 8000 : 3200)`——它**自己会消失**，每次消失都还给 stage 一整个横幅的高度，而 stage 的高度就是阅读列滚动容器的高度，**就是带高**。

### 3.3 反事实：把横幅按住（run 3 · `创世回廊1-20260917-162324`）

同一个新建会话，录之前先清一次，并在**整个 24 s 窗口内**用 `MutationObserver` 见一条清一条（仪器把每次清除记成一行 `control:dismissed`，带被清掉的原文，所以这不是「没看见」，是「按住了」）：

| t (ms) | 带高 | 已用高 | 横幅 | `band+banner` |
| --- | --- | --- | --- | --- |
| 0 | 503 | 503 | 49 | 552 |
| 13 | **552** | 552 | 0 | 552 |
| 173 | 552 | 552 | 0 | 552 |
| 24016 | **552** | 552 | 0 | 552 |

**20 s 以上零变化**（`changes 1`，`settled true`，`lastChangeAt 173 ms`）。同期被按住的横幅 **5 条**（t = 1 / 182 / 1926 / 1939 / 1955 ms，原文分别是 `小手机脚本: 失败…` ×3、`blocked gitgud.io (img-src)`、`blocked cdn.jsdelivr.net (style-src-elem)`）——**卡照样在报错，帧照样只报 `1104 → 1105`，带高一动不动。**

### 3.4 对照（手册 §2.5）：为什么换成「按住横幅」

手册要的对照是「同一张卡的回复侧 frame 用同一段脚本再录 20 s」，用意是排除「仪器本身让所有 frame 都看着在动」。**在这份 profile 上它取不到**，原因值得写下来：

- 该卡会话说多，**标题都相同**，会话行又**不带 id**（§3 开头），落点不确定；
- 更要紧的是：**只要有横幅在动，换哪一个会话都会动**——横幅是壳的，不是卡的。这一轮在另一个既有会话（3 楼 `…010155`，2 个 frame）上按同一条脚本录时，带高同样走 `503 / 515 / 552`、`band+banner` 同样恒为 552（49 px 那种 error 横幅在那里出现过）。「回复侧稳」这条基线**在这台仪器上不成立**。

替代对照是 **run 3**，它比换一个会话更强：**同一张卡、同一个帧、同一份文档、同一段窗口，只把通知区按住**。run 1 与 run 2 都动了，run 3 是平的——「仪器让 frame 看着在动」被这一对排除。顺带，那个 `identity` 与 `aria-current` 的读数也说明：REVIEW-2 的「同卡回复侧 2 个 frame 稳」落到的是哪一个会话，本文无法复核（记录里没有会话 id），而**在带高会动的前提下，「稳」与「不稳」取决于采样窗口落在哪一段横幅寿命里**（§5）。

### 3.5 帧侧的两份旁证

- **帧画出来了**：外壳自身 rAF 30 帧 / 172–183 ms 连续（`minGap 1–7 ms`，`maxGap 7–18 ms`）——§54 那条（rAF 在零面积 clip 里不触发）在这张卡上不适用。
- **帧的计数在涨而测量值不涨**：`height sources: viewport … | body.scrollHeight 1104 | doc.scrollHeight 1106 | body rect 1106 | range 1105 | child bottom 1105 | fired resize N mutation M`，窗口内 `fired resize 2 → 3`、`mutation 5 → 9`，而 `body.scrollHeight` 只从 1104 到 1105。**观测器在醒着，量出来的东西没变**——这正是 §23 想区分的那两种情形里的第二种（「醒了但读到的数被钉住」），只不过这里钉住它的是壳的钳制，不是卡自己的后代。

## 4. 判到的层与依据

### 4.1 层：壳（阅读带），不是帧

三条判据，都在同一次采样里：

1. **帧侧只有一个数。** `height sources` 行：`body.scrollHeight` 24 s 内只 `1104 → 1105`，`range` / `child bottom` 只 `1105 → 1106`。**帧内内容没有重排成 503 或 515。** 手册 §1 第一行（「帧内自己在变 → 帧层」）不成立。
2. **带高在动，而帧什么都没说。** run 1 的四次带高变化里，后三次（t = 1970 / 1984 / 5200）都发生在帧报出第一个高度之后，而帧同期的全部发言是 `1104 → 1105`（7 次 `height`，两个值）。手册 §1 第二行（「帧不变、壳在变 → 壳层」）成立。
3. **带高与横幅是互补量。** §3.2：三个 run 的每一次采样都满足 `带高 + 横幅高 = 552`。

手册 §2.4 第四种（两层互相触发）**不成立**：它要求「帧内变化总是紧跟壳的变化之后」，而这里壳的每次变化**都不跟随帧的上报**——最紧的一次是壳在 t=5200 变化、帧最后一次上报在 t=2010（差 3190 ms），且那次上报的值（1105）与带高（552）之间还隔着钳制。

**层内定位一句话**：带高 = 可见阅读带（阅读列滚动容器的 `clientHeight`，由 `ChatPane` 的 `ResizeObserver` 发布成 `--iris-app-frame-height`）。它与 `App.tsx` 的临时通知横幅**长在同一个 flex 列里**（横幅是 `.iris-stage` 的兄弟，`stage` 是 `flex: 1`），横幅一出现就吃掉阅读带一整个横幅的高度。**这不是帧那一族的缺陷，是壳把「临时通知」摆在了「阅读带」的正上方。**

### 4.2 两条台账为什么都没兜住：这条不在它们管的范围内

- **§23**（「高度上报把自己施加的高度当静默」）管的是帧**自己**报的数与视口相等时的回声识别（`heightSignal` 的 `applied` 分支）。这一轮帧报的 `1104 / 1105` 与视口 `515 / 552` 差 500+ px，**压根没进那条分支**；`fired resize 2 → 3`、`mutation 5 → 9` 在涨而 `body.scrollHeight` 稳，说明**帧侧的循环没有闭合**——§23 的前提（帧自己施加的高度被读回来）在这张卡上不适用。
- **§54**（「高度上报的日程要活过一个从未绘制的 frame」）管的是 rAF 在零面积 clip 里不触发。这里帧**画出来了**（§3.5），也报了 7 次高度。**不适用。**
- **真正在管这条的是 `reading.css` 的钳制与 `frame-fit.ts` 的带高**：`max-height: var(--iris-app-frame-height)` 让**已用高 = min(内容, 带高)**，而带高是一个会被横幅推动的活量。REVIEW-2 量的是这个被推动的量，并把它读成了帧的行为。

### 4.3 两处必须写明的口径

1. **REVIEW-2 量错了量。** `getBoundingClientRect().height` 在钳制生效时**等于带高**，不等于帧报的高度。同一时刻实测：内联 `style.height 1105px`、`max-height 552px`、`rect.height 552`。`reading.css` 与 `frame-fit.ts` 的注释都写过「clamp 压过内联 height」，但没写过「所以量 rect 就是量阅读带」。这一条是 §5 的全部内容。
2. **`frame→shell` 只吃协议消息。** 仪器认的是 `event.source === iframe.contentWindow` 且 `data.iris` 为字符串的上行消息，分 `height` / `sizing` / `note` / `ready`；帧上报的 `globals` / `ran` / `blocked` / `call` / `fetch` / `settings` / `regions` 等**非高度**消息单独记成 `other-source`（只为确认通道没丢），不进判据。帧内 `document.documentElement.scrollHeight` 读不到（opaque origin，`sandbox="allow-scripts"` 无 `allow-same-origin`，手册 §4 明确不要动这个属性），所以帧内的第二个量只以它自己 `note` 里的 `height sources` 行为准。

---

## 5. REVIEW-2 那 5 个采样为什么读成了「振荡」

把 REVIEW-2 的判据（`frameStability`：5 采样 × 1.5 s，**末 3 次不一致即 flicker**）放在这套钳制上：

1. 它量的是 `getBoundingClientRect().height`，在钳制生效时**就是带高**，不是帧报的高度（§4.3）。
2. 带高被 `App.tsx` 的临时横幅按 **3.2 s（info）/ 8 s（error）** 的自清节奏推来推去；那张卡的开场白一开机就连着吐 4–5 条横幅（§3.3 记了 5 条原文）。
3. 末 3 次采样落在 `515 / 513 / 503`——三个值都在 `552 - 横幅高(0/37/49)` 的算术里，**一个也不剩**。
4. 采样间距 1.5 s、横幅寿命 3.2 / 8 s：**这不是振荡，是四五次一次性的阶跃，被 5 个点抓到了其中 2–3 个稳态。** 手册 §1 的第三行（「在变，且每次变化后壳晚一拍跟上，最后停下 → 不是缺陷，采样窗口太早」）正是这一条，只差最后半句：**它跟的不是帧，是横幅。**

**验收条件的修正**（不写修法，只写判据）：REVIEW-2 §7 给异常 B 的验收条件「5 采样末 3 次一致」**不够**——run 1 与 run 3 都会通过一个只在横幅安静时段采样的窗口。可复核的判据应当是：**帧上报的高度序列与壳的已用高度序列分开记，且后者等于 `min(前者, 带高)`；带高在一段安静的窗口里不变。** 本记录 §3.3 那 24 s 就是它的一个样本。

**这也解释了「其余 11 个有 frame 的读数都稳」**：那 11 张的开场白要么不吐横幅，要么横幅吐得早于 5 采样窗口。

---

## 6. 交付物

| 文件 | 是什么 |
| --- | --- |
| `qa/review6-frame-oscillation.mjs` | 本记录用的仪器。`--new-conversation`（默认，走壳自己的「开始新对话」）／`--clear-banners`／`--suppress-banners`／`--chat <id>`／`--chat-reply <id>`／`--seconds`／`--wait-ms`。结果落 `qa/results/review6/`（已 gitignore），每次一条 `.json` + `.jpeg` + 一份 `report-*.json`。 |
| —— | 落点口径：帧→壳的曲线上行只吃协议消息（`event.source` + `data.iris`）；壳的曲线是 iframe **与阅读列滚动容器**两个 `ResizeObserver`；带高的邻居每次采样顺带读一次（含 `.iris-notice` 的**高度与原文**、`iris-scroll` 往上的 6 层盒子链）。`band + banner` 的等式是仪器**算出来**并逐采样打印的，不是事后推的。 |
| `qa/review6-three-runs.mjs` | 三个 run 的包装（as-is / 录前清除 / 窗口内按住），任一 run 非零退出即停并报错。 |
| `qa/results/review6/*.json` | 原始行（三条曲线 + `layout` 邻居 + `bandPlusBanner` + 每次按住的横幅原文）。**不入库**（`qa/results/` 已 gitignore）。 |

**没有改产品代码。** 本轮开工时曾在 `Sidebar.tsx` 的会话行上加过一个 `data-chat` 定位属性（配上 `reorder.test.ts` 的一条断言）以便仪器能精确点到某个会话，**随后把它整段撤掉了**：手册 §4 第一条是「不改代码」，而它不属于这段测量——仪器改为「拒绝在标题不唯一时落点」，并在 `--new-conversation` 路径上确认「量的是刚建的那个会话」（§3）。工作树对 `apps/` 无改动。

复现（8791 上一份数据副本，`Get-NetTCPConnection -LocalPort 8791` 先确认空着）：

```
cp -r apps/iris/data "$TEMP/data-r6" && rm -f "$TEMP/data-r6/host.lock"
IRIS_PORT=8791 IRIS_DATA_DIR="$TEMP/data-r6" node apps/iris/bin.ts
node qa/review6-three-runs.mjs --base http://127.0.0.1:8791 --seconds 24
```

**判据不是 pass/fail**（手册 §4：只记录、不修）：run 3 若也动，本记录 §4.1 的结论就作废，需要重判。

---

## 7. 不写修法

按手册 §3 与 §4：修法由**那一层的台账节**决定，由派单的人定。这里只把两个事实留在桌上，不附方向：`reading.css` 那条钳制（带高 = 阅读带）与 `App.tsx` 那条横幅（`flex: 1` 兄弟，3.2 / 8 s 自清）现在共用同一个 flex 列的高度，而**任何一个横幅都在改阅读带**——REVIEW-2 的 5 采样窗口抓到的是这件事，不是帧。
