# MD-INVENTORY —— 全仓 `.md` 盘点

> **落地记录(2026-09-06,`dev/post-merge-followups`,执行时 HEAD 61dae19)。** 本文件是蓝屏前
> 写成的计划;执行时与树核对,差异如下,正文不改:
>
> - population 实测 **61**(不是 60):多出 `AUDIT-CORDIS.md`(合并 origin/main 带进来,
>   工作笔记,→ `notes/`)。`apps/iris-web/OVERLAY-CARDS.md` **在树上**,分工单说它「少了」不成立。
>   `README.md` 在合并后被清空(0 字节),已按草稿重写。
> - `notes/` **保留完整原层级**:`apps/iris-web/X.md` → `notes/apps/iris-web/X.md`,
>   `packages/<pkg>/X.md` → `notes/packages/<pkg>/X.md`,`spike/RESULTS.md` → `notes/spike/RESULTS.md`。
>   第 §九 节「相对位置不变」的免费午餐正是这样买到的;`md-table.md` 里 `iris-web__X.md` 的
>   扁平命名**未采用**。
> - §十 只找到一个运行时读者。**还有第二个**:`apps/iris-web/tests/allowlist-drift.test.ts:35,41`
>   用 `readFileSync(join(root, 'SANDBOX.md'))` 读同一份文档——它没有 `catch`,搬走会直接红,
>   所以比 `remote.test.ts` 那种静默更好发现,但同样不在「谁提到」那两层里。两处都已改到 `docs/`。
> - §九「必改 7 处」是链接口径。实际改动:源码/脚本/配置**注释**里的裸名与路径 **120 处**
>   (脚本 118 + 两处 JSX 注释手改),两个运行时读者的路径 **5 行**(`remote.test.ts` 3、
>   `allowlist-drift.test.ts` 2),md 里的路径形引用 **21 处**(其中留在原地的三份 README/STRINGS 8 处),
>   ST 的 `scripts/*.js:N` 补 `public/` 前缀 **10 处**(它们与本仓 `scripts/` 同形,链接测试分不开);
>   moved 文档内部的裸名(`见 SANDBOX.md`)**不改**,由 basename 解析;代码**字符串**里的裸名
>   (`console.log('… SANDBOX.md …')`、断言消息)**不改**,共 4 处,仍是正确的 basename。
> - 链接测试落在 `apps/iris/tests/md-references.test.ts`(根 `package.json` 的 test glob 只收
>   `packages/*/tests` 与 `apps/*/tests`,根目录放不进去)。

**口径先写**(每个数字都受它约束):

- population = `git ls-files '*.md'` 在 HEAD 上,**60 个**。(分工单说 61 —— 差 1,可能是那之后的提交动过,或把待建的 `notes/MD-INVENTORY.md` 算进去了;以本次实测的 60 为准,数字随时可复算。)
- **引用数分三处**,不合并:**doc**=其它 `.md` 里命中的文件数;**src**=`apps/**` `packages/**` 的 `.ts/.tsx` 里命中的文件数;**build**=`package.json` / `*.yml` / `scripts/*` / `qa/*` / `.github/**` 里命中的文件数。**文档互链断了要人去修,构建依赖断了是红的**,迁移代价差一个量级。
- 命中按 **basename** 数。**这对 `DEVIATIONS.md`(4 份)与 `README.md`(5 份)不成立** —— 那两栏描述的是**这个名字**,不是**这个文件**。见下「同名不同对象」一节的路径限定复算。
- **「过期」只标能证明的**:内容被后续提交推翻**且**零引用。证不到写「未判定」,不写「过期」。
- **整个仓库只有 6 天**(首次提交 2026-08-31,最新 2026-09-06)。所以**没有一份文件是「旧」的**;这里的「过期」只可能指*内容被后来的提交推翻*,不可能指年久失修。
- 本文件自己是**工作笔记**,也在表内。

---

## 一、四类汇总

| 类 | 数 | 说明 |
|---|---|---|
| **用户文档** | 1 | `README.md` |
| **贡献者文档** | 11 | 各包 README、架构/沙箱/可观测/调试面/自动运行/设置、i18n 字符串表、`qa/README.md` |
| **工作笔记** | 48 | 调查记录、上游对照、偏离账、验收单、方法论、计划与清单 |
| **过期** | **0(可证的)** | 见下「唯一一份内容已被推翻的」 |

---

## 二、用户文档(1)

| 路径 | 行 | doc | src | build | 去向 |
|---|---|---|---|---|---|
| `README.md` | 97 | 1 | 0 | 9 | **留根**。build=9 是 `README.md` 这个**名字**在各 `package.json` 里的命中,不是对根文件的引用。 |

## 三、贡献者文档(11)

| 路径 | 行 | doc | src | build | 去向建议 |
|---|---|---|---|---|---|
| `ARCHITECTURE.md` | 124 | 3 | 2 | 0 | `docs/` |
| `SANDBOX.md` | 723 | 10 | **15** | 2 | `docs/`;**src=15,移动前要改 15 个文件的注释** |
| `OBSERVABILITY.md` | 443 | 11 | 3 | 0 | `docs/` |
| `DEBUG-SURFACE.md` | 210 | 2 | 0 | 0 | `docs/` |
| `AUTORUN.md` | 81 | 3 | 5 | 0 | `docs/` |
| `SETTINGS.md` | 191 | 5 | 0 | 1 | `docs/` |
| `apps/iris-web/README.md` | 445 | 1 | 0 | 9 | 留原地(包内 README 是惯例) |
| `packages/iris-compat-prompt-template/README.md` | 95 | 1 | 0 | 9 | 留原地 |
| `packages/iris-rpc-host/README.md` | 124 | 1 | 0 | 9 | 留原地 |
| `qa/README.md` | 129 | 1 | 0 | 9 | 留原地;**真实引用是 9–10 处**(`qa/*.mjs` 的注释指向它),见下 |
| `apps/iris-web/src/app/i18n/STRINGS.md` | 126 | 1 | 1 | 0 | 留原地(紧贴它描述的表) |

## 四、工作笔记(48)

**根目录(16)**

| 路径 | 行 | doc | src | build | 备注 |
|---|---|---|---|---|---|
| `METHODS.md` | 1636 | 12 | 5 | 0 | 方法论,被引最多的笔记之一 |
| `TEST-CARDS.md` | 3013 | 1 | **7** | 0 | 验收单;src=7 是源码注释引它的判据 |
| `DEVIATIONS.md` | 960 | 14* | 17* | 1* | *同名 4 份,见第五节 |
| `PLAN.md` | 455 | 8 | 0 | 0 | |
| `ROADMAP.md` | 476 | 7 | 0 | 0 | |
| `GROUPS.md` | 215 | 4 | 0 | 0 | |
| `ACTION-PLAN.md` | 75 | 4 | 0 | 0 | 2026-09-04 建,09-06 仍在改 |
| `ST-COMPARE.md` | 255 | 4 | 0 | 0 | **内容已被推翻,但有 4 处引用** —— 见第六节 |
| `IMPLEMENTATION-CHECKLIST.md` | 232 | 3 | 0 | 0 | |
| `CORDIS-TREE.md` | 155 | **0** | 0 | 0 | 2026-09-06 建,零引用是**新**不是**死** |
| `QA-REPORT.md` | 68 | 2 | 0 | 0 | 一次跑的记录,历史性质 |
| `NOTES-handoff.md` | 40 | 2 | 0 | 0 | |
| `SETTINGS-IA.md` | 214 | 2 | 2 | 0 | |

**`apps/iris-web/`(14)**:`DEVIATIONS.md`(1602)、`OVERLAY-CARDS.md`(1162)、`RENDER.md`(733)、`WINDOWING.md`(705)、`UPSTREAM-ESM-DEPS.md`(544)、`INLINE-HTML.md`(503)、`PRESET-WEIGHT.md`(432)、`OVERLAY-HOST.md`(379)、`SCRIPT-BUTTONS.md`(370)、`UPSTREAM-FRAME-ORIGIN.md`(271)、`COHABITATION.md`(168)、`UPSTREAM-SLASH.md`(169)、`GRANTS.md`(154)、`CHAT-WRITES.md`(138)

**`packages/iris-app-service/`(17)**:`DEVIATIONS.md`(1607)、`UPSTREAM-MVU-INIT-PATH.md`(1367)、`UPSTREAM-INJECT-AND-CHAT-BOOK.md`(547)、`BRIDGE.md`(453)、`FLOOR-VARIABLES.md`(399)、`LONG-CHAT-VARIABLES.md`(369)、`UPSTREAM-A-TIER.md`(364)、`UPSTREAM-PERSONA.md`(321)、`WORLDBOOKS.md`(313)、`MVU-ACCEPTANCE.md`(225)、`UPSTREAM-VARIABLE-ADDRESSING.md`(202)、`IMPORT-DUPLICATION.md`(202)、`FLOOR-ADDRESSED-VARIABLES.md`(168)、`EMBEDDED-BOOK-MATERIALISATION.md`(157)、`ST-BOOK-FETCH.md`(129)、`SNAPSHOT-TRANSPORT.md`(108)、`FIRST-RUN.md`(55)

**其余(3)**:`packages/iris-compat-prompt-template/DEVIATIONS.md`(260)、`.../SNAPSHOT.md`(286)、`packages/iris-character/UPSTREAM-IMPORT-SHAPES.md`(220)、`spike/RESULTS.md`(57)

---

## 五、同名不同对象:`DEVIATIONS.md` ×4、`README.md` ×5

**basename 计数在这九个文件上不成立** —— 表里那几个 14/17/9 描述的是名字。路径限定复算:

| 文件 | 全路径字符串命中 | 本目录内 basename 命中 |
|---|---|---|
| `DEVIATIONS.md`(根) | 47(**上界**,含另外三条路径里的同名子串) | — |
| `apps/iris-web/DEVIATIONS.md` | 0 | **15** |
| `packages/iris-app-service/DEVIATIONS.md` | 1 | **17** |
| `packages/iris-compat-prompt-template/DEVIATIONS.md` | 0 | **7** |
| `README.md`(根) | 10 | — |
| `apps/iris-web/README.md` | 0 | 0 |
| `packages/iris-compat-prompt-template/README.md` | 0 | 0 |
| `packages/iris-rpc-host/README.md` | 0 | 0 |
| **`qa/README.md`** | **10** | 9 |

**读法**:三份包内 `DEVIATIONS.md` 各自被**自己子树里的代码**引用(15/17/7),所以它们是活的、且引用是**局部**的 —— 移动包内文件只会断本包的链接。根 `DEVIATIONS.md` 那个 47 是**名字的上界**,无法从字符串层面干净归因;要精确得逐条读命中行。**`qa/README.md` 的 10 是真的**(九个 `qa/*.mjs` 的注释指向它 + 1)。

## 六、唯一一份**内容**已被推翻的:`ST-COMPARE.md`

- 它的差距表定在 `3cf858d`(2026-09-05 01:09),而 tip 已到 09-06;**至少八行被后续提交关掉**(persona / 宏词表 / 聊天导入导出 / 聊天搜索 / 全局正则层 / 角色管理 / 生成类型 / 世界书条目编辑器 —— 逐个 `git merge-base --is-ancestor` 核过)。
- **但它有 4 处文档引用,所以按本盘点的口径_不算「过期」_**(要求「推翻**且**零引用」)。
- 处置建议:**不删**,在头部写死坐标(TEST-CARDS §九 已加「引用别处的盘点要带提交号 + 日期」这条规则),或按新 tip 重测一次。

## 七、零引用的五份 —— 全是**新**,不是**死**

`CORDIS-TREE.md`(09-06 建)、`UPSTREAM-PERSONA.md`(09-06)、`FIRST-RUN.md`(09-03)、`IMPORT-DUPLICATION.md`(09-03)、`UPSTREAM-VARIABLE-ADDRESSING.md`(09-03)。

> **零引用 ≠ 过期。** 一份刚建的文件引用数同样是 0,而这个仓库只有 6 天大 —— **在这里「没人引用」几乎总是「还没来得及被引用」**。把它们标成过期会删掉当天刚写的调查。

## 八、给「哪些不上传」的依据(**只给依据,去向由总指挥裁**)

| 依据 | 命中的文件 |
|---|---|
| **含机器专属绝对路径**(`D:/workspace/…`、`E:/sillyTavern/…`) | 需逐份 grep 后补;`QA-REPORT.md`、`ST-COMPARE.md`、`TEST-CARDS.md` 已知含 |
| **含语料内容**(卡文本、聊天内容) | `TEST-CARDS.md` 明确写过「卡内容不入档」,但仍含卡名与结构描述 |
| **纯过程记录**(某一次跑的读数、交接便条) | `QA-REPORT.md`、`NOTES-handoff.md`、`spike/RESULTS.md`、`ACTION-PLAN.md`、`IMPLEMENTATION-CHECKLIST.md` |
| **src/build 引用为 0**(移动零成本) | 上表 src=0 且 build=0 的那些 |
| **src 引用 ≥5**(移动要改源码注释) | `SANDBOX.md`(15)、`TEST-CARDS.md`(7)、`AUTORUN.md`(5)、`METHODS.md`(5)、各包 `DEVIATIONS.md`(15/17/7,但都是包内) |

**注意**:`docs/` 或 `notes/` 的任何移动都会断上表的 doc/src 链接。**先决定去向,再一次性改引用**;两件分开做会留下一批指向旧路径的注释,而**注释不会红**。

---

## 九、迁移代价的真实规模(复算之后,比第八节的估计小两个量级)

第八节按「引用数」估的代价是 500 个 (文件,文档) 对、124 个文件。**那是上界,而且量错了对象。**
把引用按**写法**拆开之后:

| 写法 | 数 | 搬家后会怎样 |
|---|--:|---|
| 写成**路径**(含 `/`) | **1** | **真断** |
| 写成**裸名**(`见 SANDBOX.md`) | 499 | 仍按名找得到;改前缀是**可读性**,不是**断链** |
| ↳ 其中裸名恰好是 `DEVIATIONS.md` / `README.md` | 187 | **今天就已经是歧义的**(4 份 / 5 份同名),搬家不使它更糟 |

另有**保留层级带来的免费午餐**:203 个引用对的**相对位置搬家后不变**(两份都进 `notes/` 的同一层),
一个字都不用改。这正是「`notes/` 保留层级」这条裁定买到的东西。

### 必改清单:**7 处,2 个文件**

| 文件 | 处 | 内容 |
|---|--:|---|
| `README.md` | 6 | 六条 markdown 链接:`PLAN.md` `spike/RESULTS.md` `ARCHITECTURE.md` `SANDBOX.md` `ROADMAP.md` `METHODS.md` —— README 留在根,而这六个目标全都搬走 |
| `packages/iris-script/tests/remote.test.ts` | 1 | `new URL('../../../SANDBOX.md', import.meta.url)` → 要改成 `../../../docs/SANDBOX.md` |

## 十、⚠ 最要紧的一条:搬 `SANDBOX.md` 会**静默解除**一条安全断言

`packages/iris-script/tests/remote.test.ts` 不是在注释里提到 `SANDBOX.md` —— 它**在运行时读这个文件**,
用来把**代码里的 `ALLOWED` 允许表**与**文档里写下的 `script-src` 行**对账(注释原文:「for a *security*
set the divergence is silent in the worst direction」)。

而它读不到文件时:

```js
} catch {
  // Run from somewhere without the repo root. Silence here is honest: the
  // claim is about a document this cannot see.
  return
}
```

> **`return`,不是 `skip`,不是 `fail`。** 所以文件一搬走,这条测试**照常通过、而且什么都不再断言** ——
> 一个守卫悄悄不再守卫,套件仍然全绿。这与 `scripts/check-corpus-skips.mjs` 开头写的那种失败**完全同形**:
> **「用提前 return 代替 skip,报告为通过,证明不了任何东西」**,而这一次守的是 CSP 允许表。

**所以第八节那句「移动文档不可能弄红构建,只能弄断注释与文档互链」是错的**,而且错在**乐观的方向**:
它不弄红任何东西,它让一条已经存在的红失去发红的能力。

**两件事必须一起做,不能只做前一件:**

1. 把那行路径改成 `../../../docs/SANDBOX.md`;
2. **把那个 `catch { return }` 改成会出声的东西**(缺文件时 `skip` 并写明原因,或在仓库内运行时直接
   `fail`)—— 否则下一次任何人再搬它,同样的静默会重演,而这次我们只是**恰好**去读了那段 catch。
   (`packages/iris-script` 不在我的域,这条我只报不改。)

## 十一、「有没有人依赖这份文档」要问**三层**,不是两层

这次的更正值得写成口径,因为漏掉的那一层最贵:

| 层 | 怎么查 | 漏掉的后果 |
|---|---|---|
| **构建依赖** | `package.json` / `*.yml` / `.github/**` 里的路径 | 构建红 —— **会自己喊** |
| **散文引用** | 源码注释与其它 `.md` 里的名字 | 链接悬空 —— **注释不会红**,但读者会发现 |
| **运行时读取** | **代码里 `readFile` / `new URL(... .md ...)` 一类** | **最贵**:测试照常绿,而它已经不再检查任何东西 |

我第一遍只查了前两层,于是得出「移动文档不可能弄红构建」——**方向乐观地错了**。
第三层里恰好躺着 `remote.test.ts` 对 `SANDBOX.md` 的运行时读取(见第十节)。

> **可执行的问法:不要问「谁提到这份文档」,要问「谁_读_这份文档」** ——
> 提到它的会悬空,读它的会**沉默**。
