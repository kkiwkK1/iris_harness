# 审查手册 6 · 创世回廊1 开场白 frame 高度振荡（异常 B）的定层测量

> 状态：有效。写于 2026-09-17，基线 `main` `7011d6f`。给 owner 亲自做；产出是一段追加到验收记录里的测量，**只记录、不修**。目的是回答一个二选一：振荡来自**帧内内容自己在重排**，还是来自**壳的高度上报没静默**。

## 0. 已知事实

REVIEW-2（`notes/CARD-REGRESSION-2026-09-17.md` 异常 B）：开场白 frame 5 次采样 `gone / 874×513 / 874×515 / 874×503`，末 3 个不一致，判 flicker；同卡回复侧 2 个 frame 稳；其余 11 个有 frame 的读数都稳。帧内是 `外置状态栏`（525 KB），面板自报 `fired resize 2 mutation 6→8`。

两条裁定在管这件事：

- web 台账 **§23**「高度上报把自己施加的高度当作静默」——壳把帧报来的高度应用到 iframe 上，这次应用引起的 resize 不算新事件。
- web 台账 **§54**「高度上报的日程要活过一个从未绘制的 frame」——rAF 在零面积 clip 里不会触发，所以旁边放了定时器。

代码在两边：帧侧 `apps/iris-web/src/sandbox/frame-height.ts`（何时让帧自己滚动，`OVERFLOW_SLACK_PX = 2` 就是为「高度晚一帧到」留的 2 px 余量）和 `frame-entry.ts` / `parent-messages.ts`（测量与上报）；壳侧 `apps/iris-web/src/app/MessageInterfaces.tsx` 接收并应用。

## 1. 判据：两条曲线对着看

一次振荡有两条曲线：**帧内文档的 `scrollHeight`**（内容真的多高）和 **壳里 iframe 的 `getBoundingClientRect().height`**（壳给了多高）。

| 帧内 scrollHeight | 壳 iframe 高度 | 结论 |
| --- | --- | --- |
| 自己在变（513→515→503…） | 跟着变 | **帧层**：内容的布局反馈环（状态栏的 resize 监听改自己的尺寸，又触发 resize）。壳只是忠实跟随 |
| 不变 | 在变 | **壳层**：上报/应用的静默窗口有问题（§23 的假设在这张卡上失效） |
| 在变，且每次变化后壳晚一拍跟上，最后停下 | 同 | **不是缺陷**：收敛过程，采样窗口太早。把观察窗口拉长再判 |
| 两条都变且不收敛，但帧内变化总是**紧跟**壳的变化之后 | 同 | **两层互相触发**：壳给高度 → 帧内 resize 监听重排 → 报新高度。这是最要记清时序的一种 |

所以测量必须**同时**拿到两条曲线的**时间戳序列**，不是各拿 5 个点。

## 2. 步骤

### 2.1 环境

在你自己的树里，复制数据目录起 8788（同 REVIEW-5 §2）。不要在 8787 上做。开一个 headless Chrome（`qa/review2-drive.mjs` 的 Phase B 就是现成的起法，`--cdp <port>`），或干脆用桌面 Chrome 开 `http://127.0.0.1:8788` 手动做——这个测量手动做更省事。

### 2.2 打开开场白

创世回廊1 → 开始新对话 → 同意脚本 → 等 10 s。此时开场白 frame 在 `.iris-interfaces__slot iframe`。

### 2.3 同时录两条曲线（浏览器控制台，壳的页面里）

```js
const slot = document.querySelector('.iris-interfaces__slot iframe')
const rows = []
const t0 = performance.now()
const ro = new ResizeObserver(() => rows.push(['shell', Math.round(performance.now() - t0), slot.getBoundingClientRect().height]))
ro.observe(slot)
// 帧是 sandbox srcdoc，跨 origin 读不到 scrollHeight；用壳收到的高度消息代替：
const onMsg = e => { if (e.source === slot.contentWindow && e.data && typeof e.data === 'object') rows.push(['frame→shell', Math.round(performance.now() - t0), JSON.stringify(e.data).slice(0, 120)]) }
window.addEventListener('message', onMsg)
setTimeout(() => { ro.disconnect(); window.removeEventListener('message', onMsg); console.table(rows) }, 20000)
```

跑 20 s。`frame→shell` 行里挑出高度上报那种消息（看 `apps/iris-web/src/sandbox/protocol.ts` 里高度消息的 `type` 名，照它过滤），就得到「帧报了什么、几时报的」；`shell` 行是「壳何时把 iframe 变成了多高」。

如果高度消息不走 `postMessage` 而走 `MessageChannel`（`protocol.ts` 会写明），第二条曲线改为在**帧内**取：在 DevTools 里切到该 iframe 的上下文，`setInterval(() => console.log(performance.now()|0, document.documentElement.scrollHeight), 250)` 跑 20 s，两个控制台的时间戳用墙钟对齐即可（精度到百毫秒够用）。

### 2.4 读曲线

- 20 s 内两条曲线**都停了** → 记「收敛于 t=…ms，末值 …」，结论「不是缺陷，REVIEW-2 的 5×1.5 s 窗口太短」。
- 只有壳在动 → 壳层；把 `shell` 行贴进记录，指向 §23。
- 帧先动壳后动、循环不止 → 帧层；写清一次循环的周期（ms）和幅度（px），指向那张卡的 `外置状态栏` 脚本（不必读它的代码，记「面板自报 resize/mutation 计数在涨」即可，`fired resize N mutation M` 那行在诊断面上）。
- 互相触发 → 记时序（谁先谁后、间隔多少 ms）。这是最有价值的一种，因为它说明 §23 的「自己施加的高度当静默」判定条件在这张卡上没兜住。

### 2.5 一个对照

同一张卡的**回复侧** frame（上次是稳的）用同一段脚本再录 20 s。稳的那条做基线，能排除「脚本本身让所有 frame 都看起来在动」。

## 3. 记录

追加到 REVIEW-5 的记录文件里一节「异常 B 定层」（或单独 `notes/FRAME-OSCILLATION-创世回廊1-2026-09-xx.md`，状态头「记录」），内容：两条曲线的表（时间 · 来源 · 值）、判到的层、一句话的依据、对照 frame 的读数。**不写修法**——修法由那一层的台账节决定，我来派。

## 4. 边界

- 不改代码、不改台账。
- 不在 8787 上做。
- 这张卡有成人内容？开场白是状态栏，记形状；截图留本地。
- 如果 2.3 的脚本因为 CSP 或 sandbox 属性拿不到消息（`sandbox="allow-scripts"` 没有 `allow-same-origin`，跨 origin 是设计如此），退到 2.3 末尾的帧内 `setInterval` 方案，别去改 iframe 的 sandbox 属性。

## 5. 交付

PR 到 main（可以和 REVIEW-5 的记录同一分支）。完成报告一句话：判到哪一层、周期与幅度、收敛还是不收敛。
