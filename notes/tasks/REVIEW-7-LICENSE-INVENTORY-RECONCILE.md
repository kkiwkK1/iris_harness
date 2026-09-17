# 审查手册 7 · 依赖与许可证清单对账

> 状态：有效。写于 2026-09-17，基线 `main` `5601082`。给 owner 亲自做；产出是 `THIRD-PARTY-NOTICES.md` 与 `notes/LICENSE-INVENTORY.md` 的**追加**，不做法律判断，不改上游许可证结论。约半天——但 §0 把范围扩了一圈，看完再估。

## 0. 先修正两个前提

任务单说「lockfile 之后动了四次，把新增的补进去、删掉的划掉」。对着 `5601082` 量过：

1. **pnpm 工作区那一半，总数一个没变。** `pnpm licenses list` 今天读到 **54 包 / 4 种许可证（MIT 47、Apache-2.0 4、ISC 2、Python-2.0 1）**，与 `THIRD-PARTY-NOTICES.md` §npm dependencies 记的 54 / 47 / 4 / 2 / 1 逐个相等；只有「生产 46 / 开发 8」这一行今天读到 `--prod` 是 47。所以这一半的对账是**逐名对成分**（谁进了、谁出了、总数碰巧抵消），不是补总数。9 月 11 日后改过 `package.json` 的提交只有三个：`2079dbe1`（09-12，两个引擎不再依赖 TH 兼容层）、`2eccf30f`（09-14，插件平台与 ST 扩展试点）、`dd1cc24d`（09-16，U5 i18n，`js-yaml` 类）。
2. **`apps/iris-web` 的 npm 树从来不在清单里。** 它是 npm 管的（不在 pnpm 工作区），`pnpm licenses` 看不见它。今天走一遍它的 `node_modules`：**256 个包、14 种许可证表达式**——MIT 226、ISC 8、AGPL-3.0-only 5（就是我们自己的五个 `@iris/*` junction，不是第三方）、Apache-2.0 3、BSD-2-Clause 3、BSD-3-Clause 2、MIT-0 2、CC-BY-4.0 1、`(CC-BY-4.0 AND OFL-1.1 AND MIT)` 1、`(MPL-2.0 OR Apache-2.0)` 1、BlueOak-1.0.0 1、CC0-1.0 1、Python-2.0 1、以及一个非 SPDX 的自由文本「Dual licensed under the MIT or GPL Version 2 licenses.」。`THIRD-PARTY-NOTICES.md` 里 `react`、`react-dom`、`vite`、`zod` 一次都没出现。**这才是这次对账的主体**；工作区那 54 个是顺手。

第三件顺手的：`LICENSE-INVENTORY.md` 开头写「本仓库目前没有任何 LICENSE 文件」，而今天 `git ls-files LICENSE` 有了（README 徽章也链到它）。那句话是 9 月 7 日的事实，**不改原文**，在文末复查节里记一行「已于 … 补入 LICENSE，见 …」。

## 1. 量尺

- **工作区**：`pnpm licenses list`（表格）与 `pnpm licenses list --prod`；`--json` 在 Windows 路径上会吐非法转义，别用它喂解析器，用表格读名字与许可证两列就够。
- **web 树**：没有现成命令。用下面这段（仓库根目录）：

```
node -e "
const fs=require('fs'),p=require('path');const root='apps/iris-web/node_modules';const rows=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(!e.isDirectory()&&!e.isSymbolicLink())continue;const f=p.join(d,e.name);if(e.name.startsWith('@')){walk(f);continue}if(e.name==='.bin')continue;const pj=p.join(f,'package.json');if(fs.existsSync(pj)){try{const j=JSON.parse(fs.readFileSync(pj,'utf8'));const l=typeof j.license==='string'?j.license:(j.license&&j.license.type)||(Array.isArray(j.licenses)?j.licenses.map(x=>x.type).join('/'):'UNKNOWN');rows.push([j.name,j.version,l,f].join('\t'))}catch{}}const nm=p.join(f,'node_modules');if(fs.existsSync(nm))walk(nm)}}
walk(root);console.log(rows.join('\n'))" > "$TEMP/web-licenses.tsv"
```

  四列：名 · 版本 · 许可证 · 路径。**先把 `@iris/*` 五行剔掉**（路径是 junction 指回 `packages/`，不是第三方）。再分「直接依赖」（`apps/iris-web/package.json` 的 29 + 8 个）与「传递依赖」（其余）——通知义务主要落在前者，后者按许可证族汇总即可。
- **对照物**：`THIRD-PARTY-NOTICES.md`（面向外部、按「怎么用」写义务）和 `notes/LICENSE-INVENTORY.md`（内部盘点，§三 依赖许可证）。两份都是 9 月 11–16 日的读数。

## 2. 怎么判

对每一条差异，只写事实，三种结论：

- **新增**：今天有、清单没有。写名、版本、许可证、直接还是传递、被谁引入（`pnpm why <name>` / `cd apps/iris-web && npm ls <name>`）。
- **移除**：清单有、今天没有。划掉不删（`~~name~~`，后面注「移除于 <commit>」）。
- **变了**：同名但许可证或用途变了（少见，但 `js-yaml` 类换版本可能换表达式）。

**不裁的**：某个许可证表达式对我们意味着什么。碰到非 SPDX 自由文本（那条「MIT or GPL Version 2」）、`CC-BY-4.0`（多半是 `caniuse-lite` 那类数据包，看它是不是纯开发依赖）、`OFL-1.1`（字体）、`MPL-2.0`——**记下名字与路径，标「待裁」**，交给我。`LICENSE-INVENTORY.md` 的口径就是「只给事实与位置，不裁」。

## 3. 步骤

1. **工作区逐名对**（半小时）：`pnpm licenses list` 的 54 行与 `THIRD-PARTY-NOTICES.md` §npm 下各小节点名的包逐一勾；`@deepseek-ai/*` 那 23 个清单只写了总数，今天数一下还是不是 23，多了少了列名。「生产 46 / 开发 8」改成今天的读数并注日期。
2. **web 树建表**（两小时）：按 §1 的脚本出 TSV；剔 `@iris/*`；按直接/传递分；按许可证族汇总一张表；直接依赖 37 个每个一行（名 · 版本 · 许可证 · 用途一句话——「用途」是这份文件的立身之本，看 §EJS、§jQuery 两节怎么写的照写）。
3. **追加**，不改原文：
   - `THIRD-PARTY-NOTICES.md`：在 §npm dependencies 后加 `## apps/iris-web npm dependencies (2026-09-xx)`，放 §3.2 的表；§npm dependencies 末尾加一行「工作区计数于 2026-09-xx 复核：54/47/4/2/1 不变；成分变化见下」+ 成分差异列表。
   - `notes/LICENSE-INVENTORY.md`：文末加 `## 六、复查（2026-09-xx，main <sha>）`：工作区成分差异、web 树的存在与汇总、LICENSE 文件已补、待裁清单。
   - `notes/README.md` 这两份文件的「测量于/最后追加」列加日期。
4. **门禁**：`node --test apps/iris/tests/md-references.test.ts`（表里若写路径会被查）。没有别的测试钉这两份文件——这本身值得在复查节里记一句：清单靶子没有牙齿，漂移只能靠人。要不要加一条「`pnpm licenses list` 的总数与 NOTICES 里写的数相等」的测试，由我决定，你只记。

## 4. 边界

- 不改依赖、不升不降版本、不动 lockfile。
- 不改两份文件已有的任何一行（划掉除外，划掉也是追加标记）。
- 不写「可以/不可以用」；待裁的列名交我。
- `.reference/` 下的检出不是依赖，不计（原文已说）。

## 5. 交付

分支 `dev/license-reconcile-2026-09`，PR 到 main。完成报告给我四个数：工作区新增/移除几条、web 直接依赖几个、web 树许可证族几种、待裁几条（附名）。
