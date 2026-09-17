# 审查手册 5 · 语料卡回归复跑（#128 之后）

> 状态：有效。写于 2026-09-17，基线 `main` `7011d6f`（产品代码等于 `0aa3ede`，之后只有文档提交）。给 owner 亲自做；产出是一份新的带日期验收记录，同时是 #128 的实地验收。不改产品代码。

## 0. 为什么复跑

`notes/CARD-REGRESSION-2026-09-17.md`（REVIEW-2，对象 `b6eac97`）的 13 张卡里 11 张判「异常」，其中 **10 张共用一个根因**——异常 A：正文标签把 `<content>` 外的界面折成脚手架，回复楼层永不建 frame。#128 修了它（web 台账 §110）：claim、控制器、拼接都读整条消息，标签只管散文布局和折叠脚手架。我在 8788 上用 REVIEW-2 留下的 M7 变体和 73 857 B 真实回复各测了一次：0 → 3/3 frame。**但那只是两条消息，不是十张卡。** 上一份记录里「回复形状」「界面交互」两列对这 10 张卡都是空的或写着「0 frame（异常 A）」，要用真实回合把它们填成实测值，这份基线才可信。

## 1. 对象：这 10 张，其余 3 张不跑

| 卡 | 上次结论 | 上次被折走的东西（复跑时要看见它们） |
| --- | --- | --- |
| 战锤群星闪耀 | 异常 A | 回复应建 frame；probe 到过 1 个卡片 overlay iframe |
| OVERLORD-沙盒 | 异常 A | 无脚本卡，回复里的围栏文档应建 frame |
| 爱衣 | 异常 A | `head`/`tail` 里的状态栏、变量美化块 |
| 银麒赎世 | 异常 A | `手机UI` 的 `#mobile-trigger-btn` / `#mobile-phone-overlay` 仍应在覆盖层（这是脚本自建 DOM，与 A 无关，作对照） |
| 可攻略女主拒绝被攻略 | 异常 A + 卡自身 SyntaxError | 三块（围栏 + 裸 HTML + 围栏）应成 3 frame；`插入状态栏` 的 SyntaxError 是卡的（异常 D），仍应具名报出 |
| OVERLORD不死者之王 | 异常 A | 回复尾 `<details>` 脚手架——现在应**折叠可展开**，不是消失 |
| 绿茵好莱坞 | 异常 A | 回复 frame；`media-src` 拦截仍应具名 |
| 灭仇家满门之后我收养了想对我复仇的孤女 | 异常 A | `StatusPlaceHolderImpl` / `JSONPatch` 在 `tail`，应折叠可展开 |
| 魔法少女的扣扣审判1 | 异常 A | 回复 frame；FA 干净样本，图标预期 |
| 存储探针 | 异常 A + 探针形状 ✅ | 回复 frame；存储归属上报现在是 #127 的新句式（先说谁做的） |

不跑：Assistant（TEXT-ONLY，上次如 ST）、Sgw又看一集（上次「偏离但台账有记」，其 2 个被折的围栏块现在也该建 frame——**如果时间够就加上它**，它是最好的「多 frame 楼层」样本）、不要被神隐挑战-V1.5（SCRIPT-DOM，与 A 无关）、创世回廊1（异常 B 另有手册）。

## 2. 环境

- **在你自己的树里**（`iris_分支/iris_harness`），`git checkout main && git pull --ff-only`，确认 `git log -1` 在 `7011d6f` 或之后。
- **不用 8787**。复制一份数据目录起 8788：

```
cp -r apps/iris/data "$TEMP/data-8788" && rm -f "$TEMP/data-8788/host.lock"
IRIS_PORT=8788 IRIS_DATA_DIR="$TEMP/data-8788" node apps/iris/bin.ts
```

  起之前 `Get-NetTCPConnection -LocalPort 8788` 确认端口空着（占了会 EADDRINUSE 起不来，不会「起到别处」）。
- 驱动脚本读 `IRIS_BASE`：`IRIS_BASE=http://127.0.0.1:8788 node qa/review2-batch.mjs <cardsFile>`。
- 模型仍是已存的 provider（deepseek）；10 张卡 × 1–2 回合，费用可控。
- 卡里有成人内容：记形状不抄正文；截图留本地（`qa/results/**` 已 gitignore）。

## 3. 步骤

1. **写卡单**：`qa/results/rerun-a.txt`，一行一张 `id|displayName|flags`。`--swipe` 只给上次 swipe 列有读数的（爱衣、可攻略女主、绿茵、灭仇家、魔法少女、银麒赎世）；OVERLORD不死者之王上次是「驱动 bug 未测」，这次给 `--swipe` 补上。
2. **跑批**：`IRIS_BASE=http://127.0.0.1:8788 node qa/review2-batch.mjs qa/results/rerun-a.txt`。每张卡完整日志在 `qa/results/review2/<id>.log`，JSON 在 `<id>.json`，截图 `-greeting.jpeg` / `-reply.jpeg`。一张约 3–5 分钟。
3. **每张卡读四个数**（都在 JSON 里）：回复楼层 `frames`（`frameStability.frames`）、`stable`、`.iris-bodyleak` 折叠件数、控制台是否有 `EXC`。再开截图看一眼：frame 内容是不是那张卡的界面（不是空白）；折叠件展开后是不是脚手架（`<details>`、状态占位符），而不是本该建 frame 的东西。
4. **异常 D 对照**：可攻略女主的 `插入状态栏` SyntaxError 还应在诊断面具名出现——它是卡的正则跨行，不该被 #128 掩盖也不该消失。
5. **一条手工对照**（10 分钟）：任选一张回复有 frame 的卡，浏览器控制台 `localStorage.setItem('iris.bodyTag','zzznotatag')` 后刷新，frame 数应**不变**（#128 的因果开关：标签不再决定 frame 数），只是 `<content>` 标记会以文本形式露出。再 `removeItem` 复原。
6. **记录**：新文件 `notes/CARD-REGRESSION-2026-09-xx-rerun.md`，状态头「验收记录，验收于 <日期>，对象 main `<sha>`，宿主 8788（复制数据目录）」。表照 REVIEW-2 §4 的列，多加一列「上次结论」。结论仍只三种：如 ST / 偏离但台账有记（写节号）/ 异常（编号从 E 起，A–D 已用）。

## 4. 判读要点

- **frame 数对不上 claim 数**才是异常。claim 数怎么算：`node --input-type=module -e` 引 `apps/iris-web/src/sandbox/frontend-blocks.ts` 的 `claimMessageSurfaces(text)`，对 `chat.open` 拿到的回复 `text` 数 `blocks.length`——REVIEW-2 的 `qa/results/tmp/claim*.mjs` 就是这么做的，可以照抄。
- **折叠件为 0 不是异常**：一条按 preset 写的回复，`<content>` 外恰好只有界面块和空白，就没有脚手架可折（M7 与 E 变体都是这样）。
- **高度振荡**（末 3 个采样不一致）单独记，不算 A 类；创世回廊1 之外若再出现，写进异常 B 的对照。
- 模型这次没按格式输出（比如没吐围栏）→ 该格写「模型输出无界面块，n/a」，**不要重试到出现为止**；换 `--turn` 再跑一次可以，但两次都记。

## 5. 交付

分支 `dev/card-regression-rerun-2026-09`，PR 到 main：一份记录。完成报告给我三个数：10 张里几张「如 ST」、几张「偏离但台账有记」、几条新异常（E 起编号），加 §3.5 那条因果开关的读数。这份记录落地后，REVIEW-2 那份的 §7 结论计数就作废，我会在它头部加一行指向这份。
