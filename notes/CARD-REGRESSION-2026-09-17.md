# 语料卡逐族回归 — 验收记录

> 状态：验收记录，验收于 2026-09-17，对象 main（开工时 `e668785`，见下），宿主 8787（`apps/iris/bin.ts`，`dataDir=./data`，`profile=default-user`）。
> 仪器（已入库，`qa/`，与表外仪器同例）：`qa/review2-drive.mjs`（逐卡一遍，产出 `qa/results/review2/*.json` 与截图）、
> `qa/review2-batch.mjs`（成批跑）、`qa/review2-u2-probe.mjs` 与 `qa/review2-u2-sentinel.mjs`（候选级变量）、
> `qa/review2-fold-scan.mjs`（全 chat 的折走扫描）。
> 截图与原始 JSON 落在 `qa/results/review2/`（`qa/results/` 已 gitignore，不入库——正文含成人内容）。

> **修订漂移，照实记**（不是套话）：开工时 main = `e668785`、8787 由 PID 33660 在跑；测量到一半
> main 推到 `b6eac97`（2026-09-17 01:57，M1 step 3 + W7 台账重编号），8787 被重启到新 main（PID 36448）。
> 影响已逐条核过：**本记录指向的四个判定文件**——`apps/iris-web/src/app/body-tag.ts`、
> `apps/iris-web/src/app/MessageInterfaces.tsx`、`apps/iris-web/src/sandbox/frontend-blocks.ts`、
> `apps/iris-web/src/app/stray-fences.ts`——**在 `e668785` 与 `b6eac97` 之间逐字节相同**（`git diff --name-only` 为空）；
> 异常 A 的最小复现与 `iris.bodyTag` 因果开关在**新 main 上重跑过，同样成立**。
> `prompt.ts` 变了（M1 step 3 加了宏头 trace），但 **M1 的 0 行原因语义未动**
> （`zeroReason` 判据仍为 `text.trim()==='' && authored.trim()!==''` → `macros-only`，marker 槽位仍 `marker-unfilled`），
> §4.5 的读数在 `e668785` 上取得、`b6eac97` 未推翻。逐卡读数均标注取得时的宿主版本。
> **下一位若要复核异常 A，`b6eac97` 是能复现的最新点。**

## 0. 这一轮实际做了什么（以及没做什么）

- **逐卡**：13 张本机卡各开一个**新对话**，跑 1 个真回合（deepseek provider，每回合 6–39 s，全部 `completed`），
  截图存 `qa/results/review2/<卡>-{greeting,reply}.jpeg`，读数存 `<卡>.json`。
- **尺子按族**（`notes/TEST-CARDS.md` §一之二 的七个族），每张卡记录形状（有没有 frame / 片段 / 纯文本、高度与滚动、
  按钮有没有反应），**不抄正文**。
- **五个特别点**逐个实测：候选级变量（U2）、插件页两行、脚本同意门、ESM 依赖冷取与具名报错、M1 的 0 行原因。
- **没做**：没有改任何产品代码、没有改设置、没有导入新卡。ST（8871）未监听，对照答案取自 `notes/TEST-CARDS.md`
  与 `notes/apps/iris-web/*.md`、`notes/packages/iris-app-service/DEVIATIONS.md` 台账节。

> **一处必须先说的口径**：本机 14 张卡里 12 张在本轮 chat 的回复楼层都**没有渲染出界面**。
> 这不是 12 个独立现象，是**一个根因**（异常 A）。逐卡表的「回复形状」栏因此大多写
> 「0 frame（异常 A）」，结论栏也大多指向同一条。

---

## 1. 环境事实（开工前读，不是推论）

- 8787 = `iris_cordis_traven` 的 main `e668785`（`Get-CimInstance Win32_Process 33660` → `node apps/iris/bin.ts`）。
- provider 活的：`connection.test` → `ok:true, latencyMs 1161`（deepseek，两模型）。
- `dataDir=./data`、`profile=default-user`、`system-plugins.json` 里 `tavern-helper` / `mvu` 两行 `enabled:true`。
- `script-policy.json`：13 张卡 `scriptsAllowed:true`，`Assistant`/`OVERLORD-沙盒` 无脚本（`absent`）。
  **所以「同意门」的首次询问路径用存量卡测不到**——用一张临时导入卡另测（§4.3），测完删卡。
- **CDP 可用**：headless Chrome + `Runtime.evaluate`；外壳起在 `zh-CN`，定位走 `qa/locators.mjs` 的属性句柄
  （`data-tab` / `data-control`），不按可见文本。

---

## 2. 逐卡表

族缩写：FF=`FRAME-FENCED`、FR=``FRAGMENT``、TO=`TEXT-ONLY`、GD=`GREETING-DOC`、SD=`SCRIPT-DOM`、ST=存储族、ESM=ESM 依赖族。

| 卡 | 族 | 开场白形状 | 同意前无脚本效果 | 回复形状 | 界面交互 | 变量随回合 | swipe 回退状态 | 诊断面上报 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Assistant | TO | 纯文本（43 B，无 frame） | ✅ 无脚本，无门 | **纯文本楼层**；模型自吐的围栏文档被 preset 显示正则隐藏 | n/a（无界面） | ✅ 空（无 MVU） | ✅ 空 | 1 条 prompt 报告 | **如 ST**（§3） |
| 战锤群星闪耀 | FF | **frame**，311 KB，1 iframe，稳 | ✅（`allowed:true`） | 0 frame（异常 A）；probe 到 1 个卡片 overlay iframe | 开场白 frame 内按钮可点（§4.5） | ✅ `stat_data` 10 键 | n/a | 6 条（含 jQuery UI 缺件具名） | **异常**（A） |
| OVERLORD-沙盒 | FF（无脚本卡） | 纯文本 603 B | n/a | 0 frame（异常 A） | n/a | ✅ 空 | n/a | 6 条 | **异常**（A） |
| Sgw又看一集 | FF | **14 个 frame**，全稳 | ✅ | **15 个 frame**，稳；但 2 个围栏块在正文标签外被折走 | frame 内可交互 | ✅ 空 | n/a | 50 条；ESM 冷取有上报（§4.4） | **偏离但台账有记**（§4.4 / body-tag 折叠面） |
| 爱衣 | FF + FR + ST + ESM | **frame**，1 iframe，稳 | ✅ | 0 frame（异常 A）；`head`/`tail` 里的卡片状态栏/变量美化块被折走 | 开场白 frame 是活状态栏（截图 A 上方） | ✅ `stat_data`（世界/爱衣/统计） | ✅ 3 步逐字节一致 | 4 条 | **异常**（A） |
| 创世回廊1 | FF + ST + ESM | **frame**，1 iframe，**不稳**（874×513→515→503，见截图） | ✅ | **2 frame** 稳；`外置状态栏`(525 KB) 渲染；`小手机脚本` 502 | frame 内按钮可点（§4.5） | ✅ `stat_data` 10 键 | n/a（--swipe 未触发，因该轮 `regenerate` 未成对开候选） | 1 条 + `小手机脚本` **具名 404/502**（§4.4） | **偏离但台账有记**（§一之二 ESM @main 404）+ 开场白高度振荡待盯 |
| 银麒赎世 | FF + FR + ST + ESM + SD | 纯文本 2.8 KB | ✅ | 0 frame（异常 A）；`手机UI` 建出 `#mobile-trigger-btn` / `#mobile-phone-overlay`（脚本自建 DOM 到覆盖层，§4.1） | 覆盖层 toggle 可交互（§4.1） | ✅ `stat_data` 9 键；**regen → 1329 B、swipe 回 0 → 1604 B**（候选级差异） | ✅ | 5 条（含存储 `remove` 归属上报） | **异常**（A）+ 候选级正常（§4.1） |
| 可攻略女主拒绝被攻略 | FF + ST + ESM | 纯文本 1996 B | ✅ | 0 frame（异常 A）；`插入状态栏` 自身 SyntaxError | n/a | regen 得 `stat_data` 160 B，swipe 回 0 得空（该候选写 0 表，见 §4.1） | ✅ | 13 条（含 MVU zod 初始化失败 ×3、存储、父成员） | **异常**（A）+ 卡自身正则缺陷（已记 §七之二） |
| 不要被神隐挑战-V1.5 | SD + ST + ESM | 纯文本 1 B（**按定义**，§一之二） | ✅ | 0 frame（**这条路的性质**）；`论坛覆盖层` 把宿主 `.iris-overlay-surface` 建出、iframe 载入（§4.1） | **「进入论坛」按钮存在、toggle `visibility` 可切换（可交互）** | ✅ `stat_data` 546 B | ✅ 3 步一致 | 7 条（含 injection-still-live 归属上报） | **如 ST**（§4.1，SCRIPT-DOM 族） |
| OVERLORD不死者之王 | FF + ST + ESM | **frame**，48 KB，1 iframe「角色创建器」，稳 | ✅ | 0 frame（异常 A）；回复尾 `<details>` 脚手架被折走 | 开场白 frame 有「开始旅程」按钮 | ✅ `stat_data` 7 键 | 未测（驱动 bug，见 §5） | 5 条 | **异常**（A） |
| 绿茵好莱坞 | FF + ST + ESM | **frame**，9.7 KB，1 iframe，稳 | ✅ | 0 frame（异常 A） | n/a | ✅ `stat_data` 9 键；**regen → 608 B、swipe 回 0 → 1038 B** | ✅ | 3 条；`blocked d1j1y3gb82cpmr.cloudfront.net (media-src)` 具名 | **异常**（A） |
| 灭仇家满门之后我收养了想对我复仇的孤女（≡ 测试用卡 2.1.0） | GD + FF + ST + ESM | **frame**（`first_mes` 自带文档），16 KB，1 iframe，稳 | ✅ | 0 frame（异常 A）；`StatusPlaceHolderImpl` / `JSONPatch` 全在 `tail` 被折走 | n/a | ✅ `stat_data`（时间/黎安/user/场景） | ✅ 339 B → 349 B → 339 B（per-candidate） | 3 条 | **异常**（A）；GREETING-DOC 族开场白 ✅ |
| 魔法少女的扣扣审判1 | FF + ST + ESM | **frame**，41 KB，1 iframe，稳 | ✅ | 0 frame（异常 A） | n/a | ✅ 5 张表（`display_data`/`stat_data`/`delta_data`/`schema`/`initialized_lorebooks`） | ✅ 3 步一致 | 3 条；该卡是 FA 干净样本（§一之二），图标预期 | **异常**（A） |
| 存储探针 | ST | 纯文本 26 B | ✅（另测 revoke→grant，§4.3） | 0 frame（异常 A）；卡片 toast 走报告行（`toastr.info: storage probe…`） | n/a | ✅ 空（探针不写 MVU） | n/a | 14 条（`storage` 归属上报） | **异常**（A）+ 存储族探针形状 ✅ |

**13 张本机卡覆盖的族**：`FRAME-FENCED`（战锤/OVERLORD-沙盒/创世回廊1/OVERLORD不死者之王/爱衣/银麒赎世/…）、
`FRAGMENT`（爱衣、银麒赎世的 `<details>` 块）、`TEXT-ONLY`（Assistant）、`GREETING-DOC`（灭仇）、
`SCRIPT-DOM`（不要被神隐挑战-V1.5）、存储族（存储探针 + 上面各 MVU 卡）、ESM 族（除 Assistant/OVERLORD-沙盒 外几乎全部）。
**七个族都有代表跑到**；`FRAME-BARE` 按 §一之二 无正当代表，本轮没有样本，符合台账。

---

## 3. TEXT-ONLY 的那条「纯文本楼层里有 68 KB HTML」不是缺陷

**现象**：Assistant 回复存盘 67 997 B、以 ` ``` ` + `<!DOCTYPE html>` 开头，但屏幕上只有 139 字散文，
DOM 里既无 `pre`、无 iframe、无 `.iris-bodyleak`。

**为什么这是对的**：那 68 KB 是**模型对 preset 的思维链美化指令的服从**（preset 里
`【思维链美化 · 表裏】` 等启用的显示正则把 `</think_fox~>` 之前整段替换成围栏文档）。这些正则在
**卡片**身上不存在（Assistant 的 `regex.scopedList` 为 0 条），所以拿这张卡「TEXT-ONLY 应该全程无界面」
是正确的期望；而**回复里出现 HTML 这件事是 preset 的产物，不是卡的行为**。
ST 里该 preset 的效果一样：思维链美化正是要在**有思维链的模型**身上才长出界面。
**结论：如 ST。** 但这也说明：**用这张 preset 跑任何卡，回复顺带都会带一个围栏文档**，这正是异常 A 的燃料。

---

## 4. 五个特别点

### 4.1 候选级变量（U2）—— 通过，且用哨兵钉死

- **决定性读数**（`qa/results/u2-sentinel.mjs`，OVERLORD不死者之王，同一 turn 两个候选）：
  1. 选候选 0 → `script.setVariables {scope:'message', messageId:<floor>}` 写入 `__u2sentinel`；
  2. **swipe 到候选 1** → 读 `message` scope：`__u2sentinel` **消失**，只剩候选 1 自己的
     `initialized_lorebooks`/`stat_data`；
  3. **swipe 回候选 0** → `__u2sentinel` **原样回来**。
  → **消息作用域的读跟随被选候选，不是「最后一次生成」**，U2 改线成立。
- **旁证**（各卡 `--swipe`，见 §2 表）：银麒赎世 1604→1329→1604 B、绿茵好莱坞 1038→608→1038 B、
  灭仇 339→349→339 B，三张都**回退到候选自己的值**。
- **一个看似矛盾其实是正确的格**：可攻略女主的候选 1 读回空表——
  磁盘上该 floor 的 `variables` 数组是 `[4237 B 的表, {}]`，候选 1 **自己写了空表**，
  所以它读回空是「这个候选没有写」，不是「读丢了」。脚本作用域语义（写在候选上）与磁盘 array 一致。
- 落地代码：`packages/iris-variables/src/message-scope.ts`（按 `selectedCandidate` 解析 turn 的 seq）、
  `service.ts` `turnForMessage`/`variableOptionFor`。

### 4.2 插件页两行 —— 已启用，且如实说明内置资产

浏览器实读（设置抽屉 →「系统插件」）：
- `Tavern Helper 已启用 版本0.0.0 插件API v1 依赖 无 宿主运行时 已启用`
- `MVU 已启用 版本0.0.0 插件API v1 依赖 Tavern Helper 宿主运行时 已启用`
- 「浏览器资产」那格：**「内置插件的帧侧成员随核心成员包加载，没有独立的浏览器包」**，
  不是「未声明/从未」。→ **两行 `已启用` ✅**；W1 那格在 8787 上的措辞已经是新文案，不是待修的旧形状。

### 4.3 脚本同意门 —— 首次询问、同意前零效果、revoke 后零效果、按卡记忆，四条都成立

- **revoke → 零效果**（存量卡 存储探针）：`script.setScriptsAllowed false` 后开新对话 →
  面板写「未在运行。你已拒绝这张卡的脚本」，`拒绝` 后**0 个 interface frame、0 条新运行报告**；
  没有界面、没有报错。
- **首次询问**（临时导入 `v0.5NSFW` 卡，测完已删）：开新对话 +1 s 出现 `ConsentAsk`
  （浮层非模态）：「这张卡运行 2 个脚本（10 kB）…运行它们 / 不运行」。
  **+7 s 仍未回答时 `iframes:0`、脚本报告 1 条**（同意前零脚本效果 ✅）。
  点「运行它们」后 7 s：门消失、`iframes:1`、报告涨到 34 条、面板「2 个全部加载并开始监听」，
  `script.list.scriptsAllowed` 由 `undefined` → `true`。
- **按卡记忆**：另开一次该卡的已有对话，**不再弹门**，脚本照跑。
- 三态实现：`apps/iris-web/src/sandbox/consent.ts`（`unasked`/`declined`/`allowed`，缺席≠false），
  契约 `script.list.scriptsAllowed?`。

### 4.4 ESM 依赖冷取 —— 有上报、且**取不到时报的是具名的**

- **冷取有账**：每张有界面 frame 的卡，面板都有
  `this frame's libraries cost: message-preset-60298034b5a90876.js downloaded 1.58 MB in 5ms`
  （首次冷、二次命中，读数在 4–161 ms 之间摆动）。
- **取不到是具名的**（创世回廊1 / 小手机脚本）：
  `小手机脚本: 失败：Failed to fetch dynamically imported module: blob:null/… — https://testingcf.jsdelivr.net/gh/tangquanghuy/dnf@main/小手机脚本.js answered 404`，
  同时浏览器网络面出现 `502 /iris/script-bundle?url=…dnf@main…`。
  这正是 §一之二 记的那条「`@main` 是移动分支引用、卡没改地址自己失效」——**台账已记，属 ESM 族账**。
- 白名单外资源也是点名拒绝：绿茵好莱坞 `blocked d1j1y3gb82cpmr.cloudfront.net (media-src)`、
  创世回廊1 `blocked cdn.jsdelivr.net (style-src-elem)` / `blocked cdn.tailwindcss.com (script-src-elem)` /
  `blocked gitgud.io (img-src)`——`notes/TEST-CARDS.md` §五 的预期报告逐条对上。

### 4.5 M1 的 0 行原因 + 消息视图 —— 0 行 100% 带原因

- 13 张卡 + 对照组（脚本侧复读）一起 15 次 itemize：**每一个 `tokens===0` 的行都带
  `explanation.zeroReason`**，实测 22–25 个 0 行/卡，`explained == zero`（`unexplained: 0`）。
  两种原因：`macros-only`（预设里那几十条 `{{setvar}}` 规则，定稿后确实展开成 0）与
  `marker-unfilled`（`Chat Examples`/`Char Description`/`Scenario`/`World Info (before|after)`/
  `搜索内容注入` 这些 marker 槽位本轮没人填，`source` 如实写 `preset`/`card`/`host`/`worldbook`）。
- 这与 M1 两步（`95eb974`/`e668785`）的承诺一致：**「这个 0 行为什么是 0」有来源**。
- **消息视图有内容**：每卡 `messages` 11–23 条，结构为
  `system → assistant(开场白) → user → assistant(回复) → system…→ assistant(尾段)`，
  历史在中、系统尾段在后，**稳定/易变分界看起来合理**（`stablePrefixTokens` 有值，`preview:true`）。
- 一处观察（非异常）：`可攻略女主` 的 itemize 里出现的 `<content>` **是 preset 里那条同名正文标签
  规则**（38 条 preset 正则之一），不是卡片正文标签机制——同形不同源，读面板时容易误指认。

---

## 5. 异常（四段展开）

### 异常 A（高）· 正文标签把卡片界面全部折成脚手架，回复楼层永不建 frame

**现象**
用带 `{{setvar}}` 的 主预设（`[主预设] V19.5 狐神抚 · 毓忻`）跑出的回复，
只要模型按 preset 指令用 `<content>…</content>` 包住散文，**回复楼层里所有围栏 HTML 文档、
所有裸 HTML 区域都不再建 frame**：
- 12/14 张卡的回复楼层 `frame=0`、`iframe=0`（见 §2）；屏幕上只剩 500 来个字的散文；
- 打开卡片自己的显示正则（如创世回廊1「状态栏」/银麒赎世「手机UI」）产出的整段 HTML 被放进
  `head`（`<content>` 之前）或 `tail`（`</content>` 之后）——即「模型脚手架」——既不建 frame，
  也**不进 `.iris-bodyleak` 折叠区**，因此屏幕上完全不可见（§0 口径、§4.5）。

**期望与依据**
- `notes/apps/iris-web/BODY-TAG.md` §「接缝」写明派生链
  `text → repairStrayFences → bodyText = leak.body ?? display → claim/控制器/切片/回退`，
  即 **claim 与建 frame 读的是 `bodyText`**；
- 但同一份 note 的「何时推翻」与 §「有意为之」只把**散文**交给正文标签，**没有把卡片界面
  排除在脚手架之外**；`notes/apps/iris-web/RENDER.md` §「Measured: what upstream actually triggers on」
  说 frame 判据是「`<pre>` 文本里含 `html>`/`<head>`/`<body`」——**上游对正文标签一无所知**，
  所以上游会在围栏文档所在处建 frame，与它是否在 `<content>` 内外**无关**；
- 定量：本轮 15 个可渲染回复里 **13 个** `displayBlocks>0 && bodyBlocks==0`（§2）。

**复现（最小）**
1. 造一条消息文本 = 「一个围栏 HTML 文档 + `<content>` 包住的散文 + 另一个围栏 HTML 文档」，
   中间按卡片实际形状夹一段裸 HTML 区域与一个 `<style>` 块；
2. 在**任何无脚本卡**（`OVERLORD-沙盒`）上经 `script.createChatMessages` 插入为第 1 楼，或直接开真实对话；
3. 浏览器打开 → `.iris-interfaces__slot` = 0、`iframe` = 0；
4. **因果开关**：把 `localStorage['iris.bodyTag']` 设为一个不匹配的名字（如 `zzznotatag`）后重开 →
   同一文本**立刻建出 3 个 frame**；设回默认 `content` → 又变 0。

**定点证据（同一段文本，只有块结构不同）**
| 变体 | 文本 | claim 块数 | 浏览器建 frame |
| --- | --- | --- | --- |
| A | 只留第一个围栏文档（26 263 B） | 1 | **1** ✅ |
| C | 只留最后一个围栏文档（41 833 B） | 1 | **1** ✅ |
| D | 两个围栏文档，无 `<content>` 散文 | 2 | **2** ✅ |
| M6 | 三个块（围栏+裸 HTML+围栏），无 `<content>` 散文 | 3 | **3** ✅ |
| **M7** | 同 M6，**加上 `<content>` 散文区** | 3 | **0** ❌ |
| **E** | 可攻略女主真实回复 73 857 B | 3 | **0** ❌ |

**怀疑的层**：**壳（前端）**，具体是 `apps/iris-web/src/app/MessageInterfaces.tsx` 的
`bodyText = leak.body ?? display` 这一条派生链（`splitBodyTag` 本身按文档实现无误）。
判定「脚手架」用的是**标签内/标签外**，而 frame 需要「围栏文档 / 裸 HTML 区域」——
两个判据在 `bodyText` 上**互相否决**：越服从 preset 的卡（把界面放 `<content>` 外），
界面越会被折掉。**不是帧层、不是宿主层、也不是模型输出本身**——
同一段文本在没有 `<content>` 包裹时（M6）帧层一切正常。

**建议的修法方向（不代修，供派任务）**：claim/建 frame 应读 **`display`**（或 `display` 与
`bodyText` 的并集），而**不是** `bodyText`；正文标签只该决定**散文怎么排、脚手架怎么折**，
不该决定**哪些块有资格成为界面**。同时 `head`/`tail` 的折叠件应至少可见
（现在连 `.iris-bodyleak` 都没有落地，见 §4.5），否则「卡片的界面消失了」在现场没有任何线索。

---

### 异常 B（低）· 创世回廊1 开场白 frame 高度振荡

**现象**：开场白 frame 5 采样尺寸 `gone / 874×513 / 874×515 / 874×503`，后 3 个采样不稳定
（判据 `frameStability`：末 3 个采样不一致 = flicker）。同卡回复侧 2 个 frame 稳。

**期望与依据**：`notes/apps/iris-web/DEVIATIONS.md` §23「高度上报把自己施加的高度当静默」与
§54「高度上报的日程要活过一个从未绘制的 frame」是这一族的两条裁定；帧内内容（`外置状态栏` 525 KB）
自身在 `resize`/`mutation` 里有重排（面板自报 `fired resize 2 mutation 6→8`），
验收预期是**落定后不再动**。

**复现**：开 创世回廊1 新对话 → 等开场白 10 s → 连续 5 次 ×1.5 s 量
`.iris-interfaces__slot iframe` 的 `getBoundingClientRect()`，看末 3 次。

**怀疑的层**：**帧**（`外置状态栏` 内容自身的布局反馈环）或**壳**（高度上报的静默窗口）。
单卡出现，其余 11 个有 frame 的读数都稳，所以先记低优先级。

---

### 异常 C（低）· 存储族探针的 `remove`/`clear` 归属上报把「最后一次写入者」写成了别的卡

**现象**：银麒赎世/存储探针跑动时，宿主报告出现
`[storage] remove removed "mobile-trigger-btn-position", last written by 魔法少女的扣扣审判1; card storage is shared across the profile…`
（同类 14 条，`clear` 一次清 10 个键，归属混着 战锤/爱衣/创世回廊1）。

**期望与依据**：`notes/packages/iris-app-service/DEVIATIONS.md` §16「Card storage is shared, quota'd
like a browser, and says who filled it」——**共享 + 归属上报是有意为之**，
所以「有归属」✅；但归属读的是**最后一次写入者**，在共享存储里这会把「清空」的账记到上一个写者头上，
读起来像「那张卡删了我的键」。这是**文案可误读**，不是行为错。

**复现**：连跑 存储探针 / 银麒赎世 / 魔法少女 的对话，观察 `debug.reports` 的 `storage` 行。

**怀疑的层**：**壳/宿主交界**（`packages/iris-app-service/src/card-storage.ts` 的上报文案）。
低优先级：台账已声明共享，本轮只是措辞可能被读成归罪。

---

### 异常 D（低）· `card called … through the shared surface, where Iris cannot tell which script is asking`

**现象**：8/14 张卡的 `eventOn`/`insertOrAssignVariables`/`getScriptButtons`/`updateVariablesWith`
经「共享面」到达，宿主只能猜一个 scriptId 记账
（`…handled as 05032bb9-…`）。`insertOrAssignVariables` 等**按脚本区分**的成员因此把账记到了猜的脚本上。

**期望与依据**：`apps/iris-web/src/sandbox/identity.ts` 区分 identity/shared 成员；卡片按设计应走
**脚本绑定**而非共享面。`notes/apps/iris-web/DEVIATIONS.md` §4「卡片界面完全没有存储」与
§一之二 成员账是同族。

**复现**：任意带「变量结构」脚本的卡开对话，读卡报告。

**怀疑的层**：**卡自身写法**（用了共享面）。宿主上报已经点名并给了改法建议，**符合「拒绝要点名」的先例**，
所以记成「卡缺陷 + 宿主已具名」，不是我们的缺陷。**建议不派任务**，除非后续判定要替卡归因。

---

## 6. 已知但本轮不算异常的（省得下一位重查）

- **存储族 `clear`/`remove` 逐键上报** —— 台账 §16 有意为之，见异常 C。
- **`sessionStorage`/`indexedDB` 不可用** —— 不透明 origin 的性质，上报如实；台账 §4/§七之二。
- **`$.fn.window`/`$.fn.nodeType` 缺件**（jQuery UI / touch-punch 不在 message preset）—— 台账 §一之二「jQuery UI 命中 0」+ `jquery-plugin-gap.ts` 会报缺；具名，符合预期。
- **`SillyTavern.getCurrentLocale` / `registerFunctionTool` / `getCharacterCardFields` 未建** —— 上游 `getContext()` 面，台账 §八/成员账，报告写「missing scope here, not a fault in the card」。
- **`插入状态栏: 失败：Invalid regular expression: missing /`** —— 卡原文正则跨行，台账 §七之二已记（`可攻略女主` 的解析期 SyntaxError）。
- **`plugin-center` 的版本 `0.0.0`** —— V1 兼容目标（`compat:JS-Slash-Runner@4.9.1`）尚未落这条读数；台账记中。
- **对话里混入 opening 的 `<content>` 同形项** —— 见 §4.5 末。

---

## 7. 结论计数

| 判定 | 张数 | 卡 |
| --- | --- | --- |
| **如 ST** | **2** | Assistant（TEXT-ONLY）、不要被神隐挑战-V1.5（SCRIPT-DOM） |
| **偏离但台账有记** | **1** | Sgw又看一集（正文标签折叠面 §4.4；ESM 冷取上报） |
| **异常** | **11** | 战锤群星闪耀、OVERLORD-沙盒、爱衣、创世回廊1、银麒赎世、可攻略女主拒绝被攻略、OVERLORD不死者之王、绿茵好莱坞、灭仇家满门、魔法少女的扣扣审判1、存储探针 |

> **11 条异常里 10 条是同一个根因（异常 A）**：它们不是 10 个独立缺陷，
> 而是「卡片界面被正文标签折走」这一个前端派生链缺陷在 10 张不同的卡上各露一次脸。
> 另有 3 条独立异常：B（创世回廊1 开场白高度振荡，该卡同时受 A 影响）、
> C（存储归属文案）、D（卡用共享面，属卡缺陷）。**A 是本轮唯一要立即派任务的一条。**

### 异常清单（供派任务）

1. **A** — `MessageInterfaces.tsx` 的 `bodyText` 派生链让正文标签否决了 frame claim。**P0**。
   验收条件建议：对 §5 表里的 M7/E 两个变体，浏览器必须建出与 `display` 上 claim 数相等的 frame；
   且 `head`/`tail` 的折叠件必须落地可见。
2. **B** — 创世回廊1 开场白 frame 高度振荡。**P2**。验收条件：5 采样末 3 次一致。
3. **C** — 存储 `remove`/`clear` 归属文案。**P3**。验收条件：文案不再让读者把共享清空读成单卡删除。
4. **D** — 卡经共享面调用按脚本区分的成员（**卡缺陷，宿主已具名**，建议不派任务）。

### 复现仪器（都已在仓库）

```
node qa/review2-drive.mjs <characterId> "<display name>" [--swipe] [--no-turn] [--cdp <port>]
node qa/review2-batch.mjs <cardsFile>     # 每行 `id|displayName|flags`
node qa/review2-u2-probe.mjs <chatId> [turn]   # 候选级变量，读三态
node qa/review2-u2-sentinel.mjs <chatId>       # 哨兵写入 + swipe，判定候选级
node qa/review2-fold-scan.mjs                  # 全部今日 chat 的 display/bodyText 折叠扫描
```

**每个仪器都带自己的观察窗口与硬失败**（与 `qa/README.md` 同规矩）：
`review2-drive` 逐回合 420 s 硬闸、帧稳定 5 采样×1.5 s（只用后 3 个判稳）、
`--no-turn` 只读开场白；`review2-u2-*` 先读原状、写哨兵、swipe、再 swipe 回，三读缺一不判。
**读到 `--swipe` 未触发控制台报 `swipeError` 时，当作本卡这一格未测，不要当成通过。**
