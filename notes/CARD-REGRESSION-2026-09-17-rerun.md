# 语料卡回归复跑 — 验收记录（#128 之后）

> 状态：验收记录，验收于 2026-09-17，对象 main `64d18ab`（产品代码等于 `0aa3ede`，#128 落地之后
> 只有文档提交），宿主 8788（`apps/iris/bin.ts`，`dataDir=$TEMP/data-8788` 复制自
> `iris_cordis_traven/apps/iris/data`，`profile=default-user`）。
> 这是 `notes/tasks/REVIEW-5-CARD-REGRESSION-RERUN.md` 的执行结果，同时是 **#128 的实地验收**。
> 上一份同类记录是 `notes/CARD-REGRESSION-2026-09-17.md`（REVIEW-2，对象 `b6eac97`），
> **本文落地后那份 §7 的结论计数作废**，以本文为准。

> **开工前的两件事，照实记**：
> 1. `apps/iris-web/dist` 是 9-16 的构建，**不含 #128**（`grep layOutMessageBody dist/assets/index-*.js` 零命中）。
>    验收开始前先 `npm run build` 重建到「分块哈希 `index-B4Aa7cjN.js`」，否则复跑量到的仍是旧行为。
>    这是这一轮唯一一次产品源码之外的准备动作（构建不是源码改动）。
> 2. 工作树的数据目录里那 14 张语料卡在 `iris_cordis_traven` 的 `apps/iris/data`，
>    本文按手册 §2 复制一份到 `$TEMP/data-8788`；`host.lock` 已删，8788 起前确认端口空着。

## 0. 这一轮实际做了什么（以及没做什么）

- **逐卡**：11 张卡各开一个**新对话**，跑 1 个真回合（deepseek provider，每回合 5–27 s，全部 `completed`），
  截图存 `qa/results/review2/<卡>-{greeting,reply}.jpeg`，读数存 `<卡>.json`。
  11 = REVIEW-5 §1 的 10 张 + 手册允许加上的 `Sgw又看一集`（最好的多 frame 楼层样本）。
- **每张卡读四个数**（§3.3）：回复楼层 frame 数、`stable`、`.iris-bodyleak` 折叠件数、控制台 `EXC`。
  再加上手册 §4 要求的 **claim 数**，逐层比对。
- **一条手工对照**（§3.5）：浏览器实读 `iris.bodyTag` 因果开关，两张卡各一次。
- **没做**：没有改任何产品代码、没有改设置、没有导入新卡。`qa/review2-drive.mjs` 只加了三行
  **只读**读数（折叠件、回复楼层 slot、控制台异常计数），不改变驱动行为。
- **不跑**的三张（手册 §1 点名）：`Assistant`（TEXT-ONLY，上次如 ST）、
  `不要被神隐挑战-V1.5`（SCRIPT-DOM，与 A 无关）、`创世回廊1`（异常 B 另有手册，REVIEW-6）。

---

## 1. 结论计数（先行）

| 判定 | 张数 | 卡 |
| --- | --- | --- |
| **如 ST** | **10** | 战锤群星闪耀、OVERLORD-沙盒、爱衣、银麒赎世、可攻略女主拒绝被攻略、OVERLORD不死者之王、绿茵好莱坞、灭仇家满门之后我收养了想对我复仇的孤女、魔法少女的扣扣审判1、存储探针（异常 C 的文案已换，**app-service 台账 §95**——按手册 §4 的判据它是如 ST） |
| **偏离但台账有记** | **0** | —— |
| **异常** | **1** | Sgw又看一集（新异常 **E**：开场白 13 个裸 HTML 块 → 13 frame，回复楼层只有 1 块，**不是 A**，见 §5） |

> **异常 A 已关闭，10 张卡无一复现。** 上一轮那 10 张「异常 A」卡这一轮全部判「如 ST」；
> 判定依据不是「看起来正常」，是 §3 的逐层 claim↔frame 等式，33 个楼层 33 个相等。
>
> 但「如 ST」是**分层**结论，不是「这张卡一点问题没有」：这 10 张里仍有 ESM 冷取 404、
> `存储探针` 的共享存储归属文案（§4.2）、`可攻略女主` 的卡自身 SyntaxError（异常 D 的同类），
> 它们各自在 §4/§5 单列，且**都不属于异常 A 这一根因**。手册 §4 的判据是「frame 数对不上
> claim 数才是异常」，按那条判据这 10 张干净。

---

## 2. 逐卡表（列同 REVIEW-2 §2，加「上次结论」）

族缩写：FF=`FRAME-FENCED`、FR=`FRAGMENT`、TO=`TEXT-ONLY`、GD=`GREETING-DOC`、SD=`SCRIPT-DOM`、
ST=存储族、ESM=ESM 依赖族。
「reply claims」= 对回复 `text` 调 `claimMessageSurfaces(repairStrayFences(text))` 的 `blocks.length`（手册 §4）。
「reply frames」= **回复楼层本身**的 `.iris-interfaces__slot` 数（不是整页 iframe 数；整页数=开场白+回复，见 §3）。

| 卡 | 上次结论 | 开场白形状 | 回复 claims | 回复 frames | 折叠件 | swipe 候选 | 诊断面上报 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 战锤群星闪耀 | 异常 A | **frame**，1，稳 | 1（fenced） | **1** | 0 | 未给 | 2 条（含 jQuery UI 缺件） | **如 ST** |
| OVERLORD-沙盒 | 异常 A | 纯文本 603 B | 2（fenced×2） | **2** | 1（tail，`<combat_driver>`） | 未给 | 3 条 | **如 ST** |
| 爱衣 | 异常 A | **frame**，1，稳 | 3（fenced+bare-html+fenced） | **3** | 0 | 2（108 B 恒定） | 12 条（含 `files.catbox.moe` img-src 具名） | **如 ST** |
| 银麒赎世 | 异常 A（+候选级正常） | 纯文本 2851 B | 2（fenced×2） | **2** | 0 | 2（151 B 恒定） | 21 条（含覆盖层 `#mobile-trigger-btn` 探针） | **如 ST** |
| 可攻略女主拒绝被攻略 | 异常 A + 卡自身 SyntaxError | 纯文本 1996 B | 3（fenced+bare-html+fenced） | **3** | 0 | 2（51 B ↔ 空，见 §4.3） | 42 条（`插入状态栏: 失败…` 仍具名） | **如 ST**；卡缺陷仍在（§4.3） |
| OVERLORD不死者之王 | 异常 A（swipe 未测） | **frame**，1，稳 | 1（fenced） | **1** | 0 | 2（142 B 恒定） | 14 条（含 MVU 负楼层具名拒绝，§4.4） | **如 ST**；swipe 这次补测 ✅ |
| 绿茵好莱坞 | 异常 A | **frame**，1，稳 | 2（fenced×2） | **2** | 0 | 2（153 B 恒定） | 15 条（`blocked d1j1y3gb82cpmr.cloudfront.net (media-src)` 具名 ✅） | **如 ST** |
| 灭仇家满门之后我收养了想对我复仇的孤女 | 异常 A | **frame**，1，稳 | 3（fenced+bare-html+fenced） | **3** | 1（tail，`<StatusPlaceHolderImpl/>`） | 2（127 B 恒定） | 16 条 | **如 ST** |
| 魔法少女的扣扣审判1 | 异常 A | **frame**，1，稳 | 3（fenced×3） | **3** | 0 | 2（422 B 恒定） | 295 条（`blocked gitgud.io (img-src)` 具名 ✅） | **如 ST** |
| 存储探针 | 异常 A + 探针形状 ✅ | 纯文本 26 B | 2（fenced×2） | **2** | 0 | 未给 | 26 条（storage 归属新句式，§4.2） | **如 ST**（异常 C 文案已换，app-service §95） |
| Sgw又看一集 | 偏离但台账有记 | **14 frame**，稳 | 1（fenced） | **1** | 0 | 未给 | 60 条；ESM 冷取有上报 | **异常 E**（§5） |

**覆盖的族**：`FRAME-FENCED`（战锤/OVERLORD-沙盒/OVERLORD不死者之王/爱衣/银麒赎世/绿茵/魔法少女/Sgw）、
`FRAGMENT`（爱衣/银麒赎世/灭仇的 `<details>` 块）、`GREETING-DOC`（灭仇）、`TEXT-ONLY`（无，本轮不含 Assistant）、
`SCRIPT-DOM`（无，本轮不含 神隐）、存储族（存储探针 + 各 MVU 卡）、ESM 族（除 OVERLORD-沙盒 外全部）。
`FRAME-BARE` 无正当代表，符合 TEST-CARDS §一之二。

---

## 3. 异常 A 的逐层验尸：claim ↔ frame 等式

判据（手册 §4）：**frame 数对不上 claim 数才是异常**。这一轮对 33 个楼层逐个算了这个等式，
用的是新入库的仪器 `qa/review5-claims.mjs`（读**已有**对话，不生成任何东西、不花 token）：

```
IRIS_BASE=http://127.0.0.1:8788 node qa/review5-claims.mjs qa/results/rerun-a.txt
→ summary: floors=33 ok=33 MISMATCH=0
```

上面那个数只是汇总。11 张卡的每一个楼层，`slots === claims`，没有一个例外。原始读数在
`qa/results/review5/claims.json`（gitignore）。

### 3.1 为什么不能直接引用驱动脚本的 `frames`

`qa/review2-drive.mjs` 的 `frameStability.frames` 数的是**整页** `.iris-interfaces__slot iframe`，
开场白与回复一起算。所以它的「reply frames」是**整页**数：爱衣报 4 = 开场白 1 + 回复 3；
Sgw又看一集报 14 = 开场白 13 + 回复 1。**手册要看的是回复楼层那一个数**，
所以这一轮把逐层数字单独量了（`qa/review5-claims.mjs`），没有从整页数倒推。
两张表都在，差别是可见的而不是被抹平的。

### 3.2 #128 的因果开关（手册 §3.5）—— 两张卡实读

`qa/review5-causal-switch.mjs`：同一张卡，三次读同一楼——baseline（`iris.bodyTag` 未设）、
switched（设成不匹配的 `zzznotatag`）、restored（删除该键）。

| 卡 | baseline | switched | restored | 因果开关读数 |
| --- | --- | --- | --- | --- |
| 可攻略女主拒绝被攻略 | slots=3 markers=0 | slots=3 **markers=4** | slots=3 markers=0 | **frame 数不变**，标签标记以文本露出 ✅ |
| 战锤群星闪耀 | slots=2 markers=0 | slots=2 **markers=2** | slots=2 markers=0 | 同上 ✅ |

**这就是 #128 的因果开关**：把正文标签换成不匹配的名字，frame 数**一个不少**，只是
`<content>`/`</content>` 两段标记不再被当标签吞掉、以文本露出（markers 0 → 4 → 0）。
上一轮同一开关的读数方向正好相反：REVIEW-2 异常 A 记的是「标签一换，0 frame 变 3 frame」
（baseline 0 / switched 3 / restored 0），也就是那时标签**决定** frame 数。现在它不决定。
手册 §3.5 要求的「frame 数应不变」成立。

### 3.3 抽样看块在标签的哪一侧（不是抽样，是全部）

`#128` 的机制是「claim 读整条消息，标签只管散文区间」。把几个楼层里 claim 到的块与
`locateBodyTag` 的 `bodyStart..bodyEnd` 区间按偏移摆在一起（用节点一行命令即可复现；
`locateBodyTag` 从 `apps/iris-web/src/app/body-tag.ts` 引，claim 从
`apps/iris-web/src/sandbox/frontend-blocks.ts` 引，文本来自 `chat.open` 的回复楼层）：

| 卡 | `<content>` 区间 | 块 | 落在 | 建了 frame |
| --- | --- | --- | --- | --- |
| 爱衣 | 26077..26151 | fenced @0-26067 | **HEAD** | ✅ |
| 爱衣 | 同上 | bare-html @26165-27548 | **TAIL** | ✅ |
| 爱衣 | 同上 | fenced @28555-70386 | **TAIL** | ✅ |
| 灭仇 | 25825..25900 | fenced @0-25815 | **HEAD** | ✅ |
| 灭仇 | 同上 | bare-html @25912-27137 | **TAIL** | ✅ |
| 灭仇 | 同上 | fenced @27470-69301 | **TAIL** | ✅ |
| OVERLORD-沙盒 | 26100..26246 | fenced @0-26090 / @26292-68123 | HEAD / TAIL | ✅ / ✅ |
| 战锤群星闪耀 | 9..250 | fenced @262-42093 | TAIL | ✅ |

**三个块全部在标签外、三个 frame**——这正是上一轮造出 0 frame 的形状（M7 变体），
现在每个都落地。这一列比汇总数更能说明 #128 修的是什么。

### 3.4 折叠件：是脚手架，不是「本该建 frame 的东西」

手册 §3.3 要求「折叠件展开后是不是脚手架（`<details>`、状态占位符），而不是本该建 frame 的东西」。
这一轮只有两个楼层有折叠件，两个都是**真脚手架**：

| 卡 | edge | 内容 | 判定 |
| --- | --- | --- | --- |
| OVERLORD-沙盒 | tail | `<combat_driver> \| 无 \| </combat_driver>`（36 B） | ✅ 模型自己吐的元数据标签，不是界面 |
| 灭仇 | tail | `<StatusPlaceHolderImpl/>`（28 B） | ✅ 状态占位符，不是界面（它的界面在别的块里，已建 frame） |

其余 9 张卡折叠件 = 0。按手册 §4「折叠件为 0 不是异常」：一条按 preset 写的回复，
`<content>` 外恰好只有界面块和空白，就没有脚手架可折——**这 11 张里 9 张是这样**，
说明模型这一轮**没有**在标签外写散文脚手架，不是折叠件坏了。

### 3.5 `stable` 与振荡

11 张卡的开场白与回复楼层 `stable=true`（每帧末 3 个采样尺寸一致）。
**创世回廊1 不在本轮**（异常 B 另有 REVIEW-6 手册）；其余卡里没有再出现高度振荡，
所以异常 B 没有新的对照样本。

---

## 4. 四个特别点复测

### 4.1 候选级变量（U2）—— 仍成立，且这次是「候选 1 与候选 0 都读得出来」

`qa/review5-swipe-vars.mjs`（本轮新增并入库）对 7 张有 ≥2 候选的卡逐个走
候选 0 → 候选 1 → 回 0，读 `message` 作用域的**原始 JSON 字节数**：

| 卡 | 候选数 | 候选 0 bytes | 候选 1 bytes | 回 0 |
| --- | --- | --- | --- | --- |
| 爱衣 | 2 | 2369 | 434 | **identical** |
| 银麒赎世 | 2 | 7671 | 1388 | **identical** |
| 可攻略女主拒绝被攻略 | 2 | 1488 | 166 | **identical** |
| OVERLORD不死者之王 | 2 | 5896 | 4237 | **identical** |
| 绿茵好莱坞 | 2 | 4358 | 1369 | **identical** |
| 灭仇 | 2 | 1980 | 405 | **identical** |
| 魔法少女的扣扣审判1 | 2 | 4538 | 4538 | **identical** |

**候选 1 与候选 0 不同**（唯一例外：魔法少女两候选写同样的表，是卡的行为不是读丢），
**swipe 回 0 逐字节回到候选 0 自己的表**。U2 的候选级语义在这 7 张卡上无回归。
（注：`qa/review2-drive.mjs` 的 `--swipe` 走的 `variablesAfterRegenerate`/`variablesAfterSwipeBack`
是宿主**汇总后的视图**（顶层键与每键字节），对两候选只差在 `stat_data` 内部的卡可能读成同一个值；
上面这张表读的是**原始序列化字节数**，是更锐的那一把尺。两把都在，读数不冲突，
且 `qa/review5-swipe-vars.mjs` 复跑得到与本节逐字相同的数。）

### 4.2 存储归属上报 —— 异常 C 的文案已换（app-service 台账 §95）

存储探针这一轮的 `storage` 上报是 **#127 的新句式，先说「谁做的」再说「谁写的」**：

```
存储探针 cleared card storage, removing 13 keys; 10 of them held values written by other cards —
战锤群星闪耀 (6 keys: "whss_uiVersion", …), 魔法少女的扣扣审判1 (4 keys: …); card storage is
shared across the profile, as it is in SillyTavern
```

上一轮的句式是 `remove removed "…", last written by 魔法少女…`，读起来像「那张卡删了我的键」
（异常 C：把「清空」的账记到上一个写者头上）。现在动词的主语是**动手的那张卡**
（`存储探针 cleared …`），被点名的卡是「它的键被清了」而不是「它删了键」。
→ **异常 C 按 app-service 台账 §95 关闭**；这一列从「异常」改判为「如 ST」
（文案已换，且按手册 §4 的 claim↔frame 判据它本就干净）。

### 4.3 异常 D 对照：`插入状态栏` 的 SyntaxError 仍具名

手册 §3.4 要求「不该被 #128 掩盖也不该消失」。可攻略女主的卡报告里仍有：

```
插入状态栏: 失败：Invalid regular expression: missing /
```

这条是卡原文正则跨行（TEST-CARDS §七之二已记），这一轮**原样具名报出**，
既没被 #128 的改动吃掉，也没变成静默。同族的新成员：银麒赎世这一轮出现
`[MVU] Failed to reinitialize after switching chats`（§4.4），也具名。

### 4.4 一个新具名的拒绝（不是异常，是报告质量）

OVERLORD不死者之王这一轮首次报出：

```
[MVU] Failed to reinitialize after switching chats
UnsupportedApiError: Iris sandbox: getVariables({message_id:-3}) is not available to card
scripts. 超出了范围: floor -3 of a 1-message chat. Answering with a different floor's table
would be merged and written back by the caller.
```

MVU 在换对话时按 `message_id:-3`（从末尾数）找我方的楼层，而那时对话只有 1 条消息，
`-3` 越界。**这是拒绝而不是错答**（拒绝理由是「换一个楼层的表会被调用方合并写回」），
且具名到成员与参数。上一轮这条没有出现（该轮 swipe 未测），这一轮补测 swipe 才暴露。
**记为新观察，不判异常**：它是一条设计好的具名拒绝，符合「拒绝要点名」的先例；
是否值得向卡/MVU 侧上报是产品决定，不在本验收范围。

### 4.5 M1 的 0 行原因 —— 11 张卡 100% 带原因（无回归）

11 次 `prompt.itemize`：`zeroEntries` 22–24/卡，`zeroExplained == zeroEntries`，
`zeroUnexplained: 0`，原因集合仍是 `{macros-only, marker-unfilled}`，
`messages` 12–27 条，`stablePrefixTokens` 有值。与 REVIEW-2 §4.5 一致，无回归。

---

## 5. 异常清单（编号从 E 起，A–D 已用）

### 异常 A —— **已关闭**（#128，web 台账 §110）

11 张卡、33 个楼层的 claim↔frame 等式全部成立（§3），因果开关方向已反转（§3.2），
标签外的块全部落地（§3.3）。**本轮唯一要立即派任务的 P0 已关闭。**

### 异常 B —— **不在本轮**（创世回廊1，REVIEW-6 手册）

创世回廊1 按手册 §1 不跑。其余 10 张卡无新的高度振荡（§3.5），所以异常 B 没有新对照样本。

### 异常 C —— **已按台账关闭**（存储归属文案，app-service 台账 §95）

新句式的动词主语是动手的卡（§4.2）。

### 异常 D —— **卡缺陷，宿主已具名**（建议不派任务）

`插入状态栏` 的 SyntaxError（§4.3）与经共享面的成员调用仍有具名上报，按 REVIEW-2 的判定
维持「卡缺陷 + 宿主已具名」。

### 异常 E（新，低）—— `Sgw又看一集` 的 14 个 frame 全在**开场白**，回复楼层只有 1 个

**现象**：开场白 `text` 长 5238 B，`claimMessageSurfaces` 判出 **13 个 `bare-html` 块**
（`first_mes` 里 13 个并列的 `<details><summary>…</summary>`），浏览器建出
**13 个 frame**（`#0` 楼 13 slot / 13 iframe，13 块 ↔ 13 frame，等式成立）；
同一张卡的**回复楼层**只有 1 个 `fenced` 块，建 1 个 frame，**等式同样成立**。
整页 `frames=14` 是「开场白 13 + 回复 1」的和，不是哪一层的缺失。所以这**不是**异常 A
的形状（那是 frame 少于 claim），两层的 claim↔frame 等式都成立。

**为什么仍记一条（是一个预期修正，不是缺陷）**：
1. 上一轮这张卡的判定是「偏离但台账有记」，原因是「回复楼层有 2 个围栏块在正文标签外
   被折走」。**那个原因这一轮消失了**：回复楼层只有 1 个块、建 1 个 frame、折叠件 0。
   所以「偏离」的旧理由不再成立。
2. 手册 §1 把这张卡称作「最好的『多 frame 楼层』样本」，预期多 frame 在**回复**。
   实测多 frame 在**开场白**（13 个），回复只有 1 个——**多 frame 楼层 = 开场白楼层**。
   这不是缺陷，但手册与 REVIEW-2 对它的用法要按这个事实修正。
3. 开场白 13 个 frame 的**高度**（末采样 13 个 24 px + 1 个 552 px）值得下一轮用
   REVIEW-6 的两条曲线量一次：13 个折叠态 24 px 的 frame 是不是卡的编辑器本意
   （13 个 `<details>` 都是**收起**的），本轮没有判据——那需要 REVIEW-6 的曲线而不是计数。

**复现**：`qa/review5-claims.mjs`（开场白与回复逐层列 slot/claim）+ `Sgw又看一集.json` 的
`greeting.frames.detail`。**怀疑的层**：帧层（开场白的裸 HTML 分块策略）或卡自身写法。
**优先级低**：等式成立，无静默丢失。**建议**：交给 REVIEW-6 的两条曲线仪器顺带量一次，
不单独派任务。

---

## 6. 已知但本轮不算异常的（增量，接 REVIEW-2 §6）

- **`the library preset never executed (the preset script)` —— 确认是误报（本轮新发现，建议派任务）。**
  这条诊断在 **10/11 张卡**上出现（唯一没有的是 `OVERLORD-沙盒`——**无脚本卡**，
  `script.list` 为 `absent(unasked)`，没有 Tavern Helper 就没有 `reportMissingGlobals`，
  正是这一列的阴性对照）。它按**楼层**累积：**开场白有 frame 的 7 张各 1 条**
  （战锤、爱衣、OVERLORD不死者之王、绿茵、灭仇、魔法少女、Sgw），**回复楼层 10 张各 1 条**；
  开场白没有 frame 的 4 张（`OVERLORD-沙盒`、`银麒赎世`、`可攻略女主`、`存储探针`）
  那一层自然没有。
  `fault=false`，全文是：

  ```
  the library preset never executed (the preset script) — it did not run far enough to record a
  reason, so the request itself is what to check: blocked, missing, or unparseable. Every library
  below is a consequence of that one failure, not a separate gap:
  $, jQuery, _, z, YAML, showdown, Vue, VueRoute
  ```

  **实测反证（CDP，爱衣的 5 个 frame 逐个查；面板从可观察的第一刻（t=0）就带着这条，
  不是它迟到，是 preset 的完成比这一条晚）**：

  | 读数 | 值 |
  | --- | --- |
  | `window.__iris_preset_loaded__ === true` | **5/5 frame 为真**（`preset-entry.ts:257` 的最终语句） |
  | `window.__iris_message_preset_loaded__ === true` | **5/5 frame 为真** |
  | `window.__iris_preset_error__` | **5/5 frame 为 `null`**（没有抛错记录） |
  | `typeof` 十个 `EXPECTED_GLOBALS` | `$, jQuery, _, z, YAML, showdown, toastr, EjsTemplate, Vue, VueRouter` **全部有定义** |
  | `script[data-iris-lib]` | 每 frame 恰好 1 个，`message-preset-<hash>.js` |

  **决定性线索**：那句话点名「缺」的八个库——`$, jQuery, _, z, YAML, showdown, Vue, VueRoute`
  ——**正好就是 preset bundle 自己提供的那批**（`preset-globals.ts:76` 的 `EXPECTED_GLOBALS`）。
  也就是说：报这句话的那一瞬，**preset 还没跑**，八个库自然都不在，`PRESET_MARKER` 也还没写；
  等到任何人（或任何 CDP 探针）能观察到时，preset 已经跑完，八个库全在、标记为真。
  **诊断报的是一个已经过时的瞬间。**

  **机制：探针按文档顺序早于 preset 执行，这是确定性的，不是竞态。**
  `reportMissingGlobals` 的调用点 `frame.ts:3103` 在 `installSandbox`（`:404` 起，
  到 `:3124` 结束）内部；`installSandbox` 由 bootstrap 的入口 `frame-entry.ts:1890`
  在**脚本顶层同步调用**。而 `srcdoc.ts` 的标签顺序是
  **先 bootstrap（blocking、classic、无 async/defer，`:756`）→ 再 preset
  （`data-iris-lib`，`:823`）→ 最后卡体**，那个顺序的注释自己写着理由
  （`:672`「The bootstrap first, then the card's libraries… the bootstrap has to capture its
  channel and install its error handling before anything else runs」）。

  所以那一刻 **`PRESET_MARKER` 必然还没写、`EXPECTED_GLOBALS` 八个必然都不在**——
  读数就是「标记缺失 + 恰好那八个缺失」，与实测句子**逐字吻合**，并且**每张带脚本的卡
  每次都这样**（这正是观测到的：10/11，缺的那张是无脚本卡）。这不是「有时报错」，
  是**每次都报错**，只是这条错报没人对着标记复核过。

  另一个调用点 `frame.ts:2950`（`message.type === 'context'` 快照处理器内，`:2639` 起）
  同理活在 preset 之前——它由 shell 的消息驱动，而 bootstrap 装完到 preset 执行完之间
  任何一条 `context` 都会走到它。

  **本轮能下的判断**：这条在**十个库都在场、标记为真**的卡上说出「preset 完全没跑」，
  是**措辞与事实不符**。REVIEW-2 没有把它判成异常（它的 §4.4 只记了冷取耗时与具名 404，
  §6 也没列这条），所以这不是「推翻一条旧判定」，是**新点到的一条**。
  它**不是**卡的行为，也**不是**异常 A 的形态（33 个楼层的 claim↔frame 等式全成立，§3）。
  **本轮不判异常**（它是一条报错文案，不改卡的行为），**但建议派一条任务**：
  让「preset 没跑」这句只在**标记确实为假**时出现，并把它与「preset 跑了但某几个名字缺席」
  分成两句；顺带查清 `reportMissingGlobals` 是在 preset 之前还是之后被调用。
  复现：`qa/review5-claims.mjs` 打开任一带脚本的卡（`OVERLORD-沙盒` 除外），面板必有此句；
  再把 CDP 接进任一 iframe 读上表那四行。相关的现有断言是
  `apps/iris-web/tests/library-state.test.ts`（钉 `describeLibraryState` 的**纯函数**行为，
  本身没错）与 `apps/iris-web/tests/frame-libraries.test.ts`（钉 `provideToastr` 先于
  `reportMissingGlobals`）；**没有**一条钉「`reportMissingGlobals` 在 preset 之后」，
  这正是缺口。

- REVIEW-2 §6 的其余各条（`sessionStorage`/`indexedDB` 不可用、`$.fn.window` 缺件、
  `SillyTavern.getCurrentLocale` 未建、`插入状态栏` SyntaxError、`plugin-center` 版本 `0.0.0`）
  本轮**逐条复现，判定不变**。

---

## 7. 仪器（都已入库）

| 文件 | 作用 | 本轮读数 |
| --- | --- | --- |
| `qa/review2-batch.mjs` / `qa/review2-drive.mjs` | 逐卡一个真回合，存 JSON + 截图 | 11 张卡的 `qa/results/review2/*.json`。drive 本轮加了三行只读读数：`.iris-bodyleak` 列表、回复楼层 slot、控制台 `EXC` 计数 |
| `qa/review5-claims.mjs` | **新**。读已有对话，逐楼层比 `slots` 与 `claimMessageSurfaces` 的块数；**不生成、不花 token** | `floors=33 ok=33 MISMATCH=0`，`qa/results/review5/claims.json` |
| `qa/review5-causal-switch.mjs` | **新**。`iris.bodyTag` 因果开关：baseline / switched / restored 三次读同一楼 | 可攻略女主 3/3/3（markers 0→4→0）；战锤 2/2/2（markers 0→2→0） |
| `qa/review5-swipe-vars.mjs` | **新**。逐候选读 `message` 作用域的原始 JSON 字节，比对「回 0 是否逐字节一致」 | 7 张 ≥2 候选的卡全部 `identical`，见 §4.1（读已有对话，只改 `selectedCandidate` 并放回 0） |
| `qa/review2-fold-scan.mjs` | 全 chat 折走扫描（REVIEW-2 留） | 本轮未用（逐层等式已覆盖） |

截图与原始 JSON 落在 `qa/results/review2/`（`qa/results/` 已 gitignore，不入库——正文含成人内容）。
本记录**不抄正文**，只记形状。

---

## 8. 修订漂移，照实记

- 开工时 `git log -1` = `64d18ab`（= `origin/main`），产品代码 = `0aa3ede`（#128）。
- `apps/iris-web/dist` 开工时是 9-16 的旧构建，**重建后**哈希从 `index-CdJxKWEm.js` 变为
  `index-B4Aa7cjN.js`；`bootstrap-49aeaca23a0e188a.js`。这一事实记在前面「开工前的两件事」。
- 11 张卡各一个真回合全部 `completed`，无超时、无 `stream.error`。
- 一次工具链问题照实记：`packages/iris-app-service/node_modules/@iris/text` 这个 workspace junction
  在 checkout 后缺失，宿主启动即 `ERR_MODULE_NOT_FOUND`。按 pnpm 的 junction 形状补回，
  未改任何 `package.json` 或锁文件。这是**工作树状态**问题，不是产品缺陷。

---

## 9. 给下一位的交接

- **#128 的实地验收结论：通过。** 若有人要复核异常 A，本记录 §3 的四张表就是证据，
  仪器是 `qa/review5-claims.mjs`（不花钱）与 `qa/review5-causal-switch.mjs`（三分钟）。
- **REVIEW-2 那份记录的 §7 计数（2 如 ST / 1 偏离 / 11 异常）作废**，以本文 §1 为准
  （**10 如 ST / 0 偏离 / 1 异常 E**）。
- **两件建议派的事**（不是本轮的验收结论，是它暴露出来的）：
  1. 「`the library preset never executed` 误报」—— §6 第一条，附了实测反证（标记为真），
     需要一条任务把 `PRESET_MARKER` 的读取路径与 `reportMissingGlobals` 的分支对齐。
  2. 异常 E 交给 REVIEW-6 的两条曲线仪器顺带量一次开场白 13 frame 的高度（§5）。
- `创世回廊1` 的异常 B 仍未测（REVIEW-6 手册），**不在本记录覆盖内**。
