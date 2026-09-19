<p align="center">
  <img src="assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">第三方说明</h1>

<p align="center">记录 Iris 使用了什么、来自哪里，以及尚待核实的事项。</p>

<p align="center">
  <a href="README.md">项目首页</a> ·
  <a href="docs/README.md">文档目录</a> ·
  <a href="docs/USER-GUIDE.md">使用手册</a>
</p>

---

本文整理项目已有的来源与许可证记录，**不是一次新的依赖审计或法律结论**。版本号指实际阅读的副本，不代表上游最新版；版权声明与许可证名称保留原文。

标为“待核实”的内容没有用猜测补齐。转录清单来自源码作者的声明，尚未经过独立相似性审计。

## Iris

Iris 使用 `AGPL-3.0-only`，完整原文见 [LICENSE](LICENSE)。项目的许可选择及原有判断见[许可证盘点](notes/LICENSE-INVENTORY.md)，本次汉化不改变这些记录。

> Copyright (C) 2026 kkiwkK1 and Iris contributors

项目源码：[kkiwkK1/iris_harness](https://github.com/kkiwkK1/iris_harness)。

## 来源一览

| 项目 | 阅读版本 | 原记录中的许可证 | 用途 |
| --- | --- | --- | --- |
| [SillyTavern](https://github.com/SillyTavern/SillyTavern) | 1.18.0 · `51ad27fb` | AGPL-3.0 | 格式兼容、算法转录与直接移植 |
| [酒馆助手 / JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) | 4.9.1 | Aladdin Free Public License, Version 9 | 接口兼容、少量规则与算法转录 |
| [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate) | v0.182.0 · `6a11e2f` | MIT | MVU 接口与 schema 遍历 |
| [ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template) | 1.17.4.1 | AGPL-3.0 | 模板环境与上下文处理 |
| [EJS](https://github.com/mde/ejs) | 3.1.9；补丁来源见下 | Apache-2.0 | 模板依赖与嵌套分隔符补丁 |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 0.1.3-alpha.1 · `d347e70` | MIT | 框架依赖、界面参考与部分算法转录 |
| [jQuery](https://jquery.com) | 3.5.1 | MIT | ST 兼容环境的原样 vendor 文件 |
| [lodash](https://lodash.com) | 以 vendor 文件头为准 | MIT | ST 兼容环境的原样 vendor 文件 |

## SillyTavern

保留的来源关系如下：

| Iris 位置 | 来源与用途 |
| --- | --- |
| `packages/iris-app-service/src/reply-trim.ts` | 直接移植 `trimToEndSentence` 与标点集合，来源 `public/scripts/utils.js` |
| `packages/iris-lorebook/src/activate.ts` | 转录 `checkWorldInfo` 激活算法 |
| `packages/iris-lorebook/src/matching.ts` | 转录 `WorldInfoBuffer.matchKeys` |
| `packages/iris-lorebook/src/parse.ts` | 转录 Agnai、Risu、Novel 世界书转换 |
| `packages/iris-app-service/src/prompt.ts` | 转录 `getSortedEntries` |
| `apps/iris-web/src/app/WorldbookPanel.tsx` | 世界书条目排序规则 |
| `packages/iris-app-service/src/library.ts` | `unsetPrivateFields` 的角色导出清理规则 |
| `packages/iris-compat-tavernhelper/src/slash.ts` | `SlashCommandParser` 的转义计数 |

Chat Completion 预设、聊天 JSONL、世界书字段和设置键属于格式兼容，目的是读取已有文件。

**版权行待核实：** 阅读副本中的 `LICENSE` 是未改动的 AGPLv3 文本，`Copyright (C) 2007 Free Software Foundation, Inc.` 是许可证文本的声明，不是 SillyTavern 项目的版权声明；原记录未在 README、package.json 或页面中找到项目版权行。

## 酒馆助手 / JS-Slash-Runner

作者标识为 `KAKAA`。主要关系是接口名称与行为兼容，包括帧成员、脚本身份、预置全局变量、脚本按钮格式和 `waitGlobalInitialized`。

另外保留两项代码来源：

- `packages/iris-compat-tavernhelper/src/macros.ts`：宏输出格式转录自 `src/function/macro_like.ts`。独立重推导曾被提出，但在完成并记录前，仍按转录列出。
- `apps/iris-web/src/sandbox/script-source.ts`：复制了两条脚本来源规则。

**许可证与版权行待核实：** 阅读副本声明 Aladdin Free Public License, Version 9，无对应 SPDX 标识。其通用文本仍把程序称为 `AFPL Ghostscript`，并列 Artifex Software Inc.、artofcode LLC；以下是许可证文本自带的声明，不能直接当作酒馆助手的版权所有者：

> Copyright (C) 1994, 1995, 1997, 1998, 1999, 2000 Aladdin Enterprises, Menlo Park, California, U.S.A.

## MagVarUpdate（MVU）

> Copyright (c) 2025 MagicalAstrogy & StageDog.

`packages/iris-mvu/src/schema.ts` 转录 schema 遍历：缺少键时终止，不回退到可扩展父级的 `template`。这是有意保留的上游行为。

`Mvu` 成员、事件、变量清理参数及 `chat[1].variables[0].ignore_cleanup` 的位置属于接口兼容。版本依据标签与提交；上游 `package.json` 的 `1.0.0` 在原盘点中记为占位版本。

## ST-Prompt-Template 与 EJS

ST-Prompt-Template 作者标识为 `zonde306`。Iris 在 `packages/iris-compat-prompt-template/src/environment.ts` 转录 `prepareContext` 与 `precacheVariables`，保留处理顺序；EJS 方言与 `extension_settings.EjsTemplate` 用于接口兼容。

ST-Prompt-Template 的项目版权行仍待核实：阅读副本只含未填写项目版权模板的 AGPLv3 原文。

EJS 有两种使用方式：

1. `ejs@3.1.9` 作为依赖，供模板兼容层使用。
2. `packages/iris-compat-prompt-template/src/upstream.ts` 近乎原样转录 `Template.prototype.generateSource` 的嵌套分隔符补丁，来源是 **ST-Prompt-Template 1.17.4.1 的 `src/3rdparty/ejs.js`**，不是直接读取 EJS 发布版。

EJS 的 `package.json` 作者为 `Matthew Eernisse <mde@fleegix.org>`；阅读副本的 Apache-2.0 文本未填写版权行，也无 `NOTICE`。

**补丁归属待核实：** 原盘点机器上的 ST-Prompt-Template 安装包没有 `src/`，无法重查该 vendor 文件。它可能包含 EJS 原码、ST-Prompt-Template 修改或两者混合；这里不重新判断权利归属。

## deepseek-harness

> Copyright (c) 2026 DeepSeek

发布的 `@deepseek-ai/dsh-*` 包作为依赖使用；本节单独记录源码参考和转录，不把两者混为一类。

| Iris 位置 | 保留的来源与主要差异 |
| --- | --- |
| `apps/iris-web/src/app/token-format.ts` | 来自 ui-chat 的同名文件：token 格式、精确计数和缓存命中百分比，保留“不把部分命中舍入为 100%”；改用 Iris 字典并约束非负计数 |
| `apps/iris-web/src/app/context-occupancy.ts` | 来自 ui-conversation 的占用计算和 `ContextMeter` 分段规则；Iris 改为六种装配来源，分母为 `context - reserve` |
| `apps/iris-web/src/app/ContextMeter.tsx` | 参考展开面板、标题/条/图例顺序及外部点击/Escape 关闭；改用胶囊条和本地 CSS 定位 |
| `apps/iris-web/src/app/CompactionNote.tsx` | 来自 `CompactionItem.tsx` 的折叠标记；不替换原消息，位置改到可见列头 |
| `packages/iris-app-service/src/compaction.ts`、`compaction-prompt.ts` | 来自 compaction-basic 与 command-compact 的配置、选区、摘要和触发流程 |

压缩部分保留的来源包括：`0.8` / `0.16` 两个比例与校验、从最新端累积选择、缩小检查、checkpoint 包装、摘要指令置于最后一条用户消息以复用前缀缓存、必须写出全部章节、合并旧摘要、失败后继续当前回合，以及手动 `retainRatio = 0` 的分支。

Iris 将摘要章节改为角色扮演场景，按 `context - reserve` 计算阈值，去掉工具调用配对边界，并以聊天头 `iris_compaction` 持久化，以便 SillyTavern JSONL 往返保留。

用量行分组、逐回合明细与部分文案参考 `StatsLine.tsx`、`TurnUsagePanel.tsx` 和 `locale.ts`，但标记与样式为 Iris 自己实现。跨会话用量页、`usage.summary` 聚合及 SVG 图表是 Iris 自有实现，不列为转录。

原转录副本为 `0.1.3-alpha.1 / d347e70`；本地参考 checkout 为 `0.1.2-alpha.2 / 0a53fb5`。原记录确认 token 格式文件在两者间字节一致，不据此推断整个项目一致。

> [!IMPORTANT]
> 原记录中的 MIT 全文位于被忽略的 `.reference/deepseek-harness/LICENSE`，普通克隆不会携带该文件。本说明没有补入该全文，也不表示已经补齐随转录代码分发所需的许可证材料。待办仍见[许可证盘点](notes/LICENSE-INVENTORY.md)。

## jQuery 与 lodash 的 vendor 文件

`apps/iris-web/public/st-ext/vendor/jquery.min.js` 原样复制自参考 SillyTavern 的 jQuery 3.5.1 文件；`lodash.min.js` 原样复制自其依赖。两者按文件头的 MIT 声明记录，未修改源码。

这些副本在 ST 兼容扩展帧中提供 `$` 和 `_`，供上游扩展启动和 DOM 操作；不是卡片帧使用的那份预置库。

## npm 依赖记录

原盘点运行 `pnpm licenses list --json`，得到 54 个包：47 MIT、4 Apache-2.0、2 ISC、1 Python-2.0，其中生产 46、开发 8。**这是当时锁文件的记录，不是当前依赖数量保证**；`.reference/` 不计入依赖。

### MIT：Cordis 与 DSH

> Copyright (c) 2021-present Shigma

对应 `@deepseek-ai/` 家族中的 `cordis@4.0.2`、`cosmokit@1.8.2/1.8.3`、`schemastery@3.18.1/3.18.2`，以及以下插件：

`cordis-plugin-group@1.0.2`、`cordis-plugin-hmr@1.0.17`、`cordis-plugin-include@1.0.7`、`cordis-plugin-loader@1.0.3`、`cordis-plugin-logger-console@1.0.2`、`cordis-plugin-timer@1.1.4`。

> Copyright (c) 2026 DeepSeek

对应版本均为 `0.1.1-rc.2` 的 `dsh-app-boot`、`dsh-attachment`、`dsh-brand`、`dsh-home-paths`、`dsh-host-frontend-static`、`dsh-host-webserver`、`dsh-invariants`、`dsh-launch-environment`、`dsh-llm`、`dsh-scope`、`dsh-session`、`dsh-system-prompt`、`dsh-timeout`、`dsh-typert-protocol`。

原记录另列同版本、同版权的 `dsh-client-modules`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`、`dsh-client-web`：它们存在于当时的包存储，但未被该次根锁文件盘点列入。该统计不代替 Web 子项目独立锁文件的盘点。

### Apache-2.0

| 包 | 记录版本 | 作者字段 | 原副本中的许可材料 |
| --- | --- | --- | --- |
| `ejs` | 3.1.9 | Matthew Eernisse | LICENSE 通用文本，无填写的版权行；另有上文转录 |
| `filelist` | 1.0.6 | Matthew Eernisse | 发布包无许可证文件，许可来自 package.json |
| `jake` | 10.9.4 | Matthew Eernisse | 发布包无许可证文件，许可来自 package.json |
| `typescript` | 5.9.3 | Microsoft Corp. | LICENSE.txt 通用文本，无填写的版权行 |

前三项作者邮箱为 `mde@fleegix.org`。原记录未在这四个副本中找到 `NOTICE`；未填写的版权行和缺少的材料仍待核实，不由作者字段自动替代。

### ISC

> Copyright (c) 2011-2023 Isaac Z. Schlueter and Contributors

对应 `minimatch@5.1.9`。

> Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov

对应 `picocolors@1.1.1`。

### Python-2.0

`argparse@2.0.1` 是 Python argparse 的 JavaScript 移植，声明 `Python-2.0`，附 PSF License Agreement 和软件历史。其文本中的 `Copyright (c) 2001…2010 Python Software Foundation` 属于 Python；JavaScript 移植本身的版权行在原副本中未找到，仍待核实。


## Web 独立依赖盘点（2026-09-17）

以下保留主线在 `96b1a8e` 的补充盘点，不是本次重新审计。Web 由 npm 独立管理，不在根 pnpm 统计内；脚本与复核过程见[许可对账记录](notes/tasks/REVIEW-7-LICENSE-INVENTORY-RECONCILE.md)。

当时安装树有 **251 个第三方包版本、248 个名称**，包含 12 个 `@deepseek-ai/*`；Iris 自有的 5 个链接包不计入。三个重复版本名为 commander 8.3.0/9.5.0、entities 7.0.1/8.1.0、lru-cache 5.1.1/11.5.2。

根工作区同次复核仍为 54 包，生产/开发修正为 **47/7**：typescript 被 ST 扩展分析器运行时使用。EJS 已在 2026-09-11 的 `9d93280` 从 **3.1.9 升至 3.1.10**，许可证未变；上文 3.1.9 是早期阅读记录。

此前待核实的四个 dsh-client 包已确认都是 Web 直接依赖并出现在安装树中；根 pnpm 统计未列出是因为它们属于另一依赖树。

| 许可表达式（原文） | 包版本数 |
| --- | --- |
| `MIT` | 226 |
| `ISC` | 8 |
| `Apache-2.0` | 3 |
| `BSD-2-Clause` | 3 |
| `MIT-0` | 2 |
| `BSD-3-Clause` | 2 |
| `Python-2.0` | 1 |
| `CC0-1.0` | 1 |
| `BlueOak-1.0.0` | 1 |
| `CC-BY-4.0` | 1 |
| `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | 1 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| `Dual licensed under the MIT or GPL Version 2 licenses.` | 1 |

### 直接依赖与开发依赖

下表保留当时 29 项 dependencies 和 8 项 devDependencies，包含自有链接包；版本是该次安装树的记录。

| 包 | 记录版本 | 许可证 | Iris 用途 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.2 | MIT | 浏览器 Cordis 上下文与插件声明 |
| `@deepseek-ai/cordis-plugin-group` | 1.0.2 | MIT | Cordis 插件分组 |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7 | MIT | Cordis 配置加载 |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | MIT | 浏览器启动用加载器 |
| `@deepseek-ai/dsh-client-modules` | 0.1.1-rc.2 | MIT | 动态导入的浏览器模块系统 |
| `@deepseek-ai/dsh-client-ui-primitives` | 0.1.1-rc.2 | MIT | Button、Menu、Modal、剪贴板等组件，并间接使用 katex |
| `@deepseek-ai/dsh-client-ui-slots` | 0.1.1-rc.2 | MIT | 消息操作插槽 |
| `@deepseek-ai/dsh-client-web` | 0.1.1-rc.2 | MIT | AppWebEntry 启动入口 |
| `@deepseek-ai/dsh-invariants` | 0.1.1-rc.2 | MIT | 运行时不变量注册表 |
| `@fortawesome/fontawesome-free` | 6.5.2 | `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | 消息帧图标样式与内联字体；许可按资产类型区分，见下 |
| `@iris/client-fake` | *workspace* | AGPL-3.0-only | Iris 自有模拟客户端 |
| `@iris/compat-tavernhelper-core` | *workspace* | AGPL-3.0-only | Iris 自有事件总线与名称 |
| `@iris/plugin-web-api` | *workspace* | AGPL-3.0-only | Iris 自有浏览器插件契约 |
| `@iris/protocol` | *workspace* | AGPL-3.0-only | Iris 自有请求响应契约 |
| `@iris/text` | *workspace* | AGPL-3.0-only | Iris 自有文本与双语检查 |
| `@tailwindcss/browser` | 4.1.12 | MIT | 消息帧 Tailwind，固定上游使用版本 |
| `dompurify` | 3.4.14 | `(MPL-2.0 OR Apache-2.0)` | 消息 HTML 清理；许可选择待记录 |
| `jquery` | 3.5.1 | MIT | 帧内 $ 全局变量 |
| `jquery-ui` | 1.13.2 | MIT | 声明并固定版本，但盘点时未打入帧 |
| `jquery-ui-touch-punch` | 0.2.3 | `Dual licensed under the MIT or GPL Version 2 licenses.` | 声明并固定版本，但未打入帧；许可表达式待核实 |
| `lodash-es` | 4.18.1 | MIT | 预置帧 _ 全局变量 |
| `react` | 18.3.1 | MIT | 宿主页面渲染 |
| `react-dom` | 18.3.1 | MIT | 宿主页面 DOM 渲染 |
| `showdown` | 2.1.0 | MIT | 帧内 Markdown 全局库 |
| `vue` | 3.5.42 | MIT | 帧内 Vue 全局库 |
| `vue-router` | 4.6.4 | MIT | Vue 路由配套 |
| `yaml` | 2.9.0 | ISC | 帧内 YAML 全局库 |
| `zod` | 4.5.4 | MIT | 帧内 z 全局库 |
| `zustand` | 4.5.7 | MIT | 浏览器状态存储 |
| `@types/lodash-es` | 4.17.12 | MIT | lodash-es 类型（开发） |
| `@types/node` | 22.20.1 | MIT | 配置与工具的 Node 类型（开发） |
| `@types/react` | 18.3.31 | MIT | React 类型（开发） |
| `@types/react-dom` | 18.3.7 | MIT | React DOM 类型（开发） |
| `@vitejs/plugin-react` | 4.7.0 | MIT | React 构建转换（开发） |
| `jsdom` | 29.1.1 | MIT | 界面测试 DOM（开发） |
| `typescript` | 5.9.3 | Apache-2.0 | 编译器（开发）；附 LICENSE.txt 和 ThirdPartyNoticeText.txt，无名为 NOTICE 的文件 |
| `vite` | 6.4.3 | MIT | 页面和四类帧 bundle 构建（开发） |

jquery-ui 和 jquery-ui-touch-punch 当时虽在清单中，未出现在帧 bundle。缺少 draggable 等能力由 jquery-plugin-gap 报告；是否实际分发应查产物，不只查 package.json。

### 间接依赖与材料

原盘点按 214 项间接包记录；上述许可计数覆盖直接与间接合计 251 个第三方包版本。

- MIT 的主要子树来自 Vite 的 rollup/esbuild、React 插件的 Babel、React DOM。
- Apache-2.0：typescript、baseline-browser-mapping、xml-name-validator，均有 LICENSE.txt；该树没有名为 NOTICE 的文件。typescript 另有 ThirdPartyNoticeText.txt。
- BSD-3-Clause：source-map-js、tough-cookie；BSD-2-Clause：两个 entities 版本、webidl-conversions。
- MIT-0：@csstools/color-helpers、@csstools/css-syntax-patches-for-csstree。
- CC0-1.0：mdn-data；Python-2.0：argparse；ISC 含 yaml。
- CC-BY-4.0 的 caniuse-lite 经 Vite React 插件 → Babel → browserslist 引入，盘点时仅用于构建。
- BlueOak-1.0.0 的 lru-cache 11.5.2 来自开发依赖 jsdom；另一份 5.1.1 为 ISC。

### 待核实与待裁事项

| 包 | 表达式或材料 | 原记录中的未决事项 |
| --- | --- | --- |
| jquery-ui-touch-punch 0.2.3 | Dual licensed under the MIT or GPL Version 2 licenses. | 非 SPDX 表达式，无独立许可证文件；源码头为 `Copyright 2011–2014, Dave Furfero`。声明为直接依赖，但盘点时未进帧产物 |
| dompurify 3.4.14 | (MPL-2.0 OR Apache-2.0) | 同时附 LICENSE 与 LICENSE-MPL；用于 sanitize-html.ts，许可分支选择需记录 |
| @fortawesome/fontawesome-free 6.5.2 | (CC-BY-4.0 AND OFL-1.1 AND MIT) | 图标/字体/代码分别适用；内联样式和字体实际进入消息帧，署名与保留字体名称问题仍需处理 |
| caniuse-lite 1.0.30001810 | CC-BY-4.0 | 仅构建用，原记录不在发布产物中；保留署名见下 |
| lru-cache 11.5.2 | BlueOak-1.0.0 | 位于 jsdom/node_modules，仅开发用，原记录不在发布产物中 |

Font Awesome 字体声明：

> Copyright (c) 2024 Fonticons, Inc.

保留字体名称为 “Font Awesome”。caniuse-lite 声明：

> Copyright (c) 2014-present Alexis Deveria

这五项均位于 `apps/iris-web/node_modules/` 下；lru-cache 的具体位置为 `jsdom/node_modules/lru-cache`。这里保留原盘点问题，不替代许可裁决。

六个包未携带独立许可文件：`@esbuild/win32-x64@0.25.12`、`@rollup/rollup-win32-x64-gnu@4.63.1`、`@rollup/rollup-win32-x64-msvc@4.63.1`、`@vue/devtools-api@6.6.4`、`saxes@6.0.0`、`jquery-ui-touch-punch@0.2.3`。前四项按包字段为 MIT，saxes 为 ISC，最后一项见上；缺文件的事实未在本次整理中解决。

安装树与 package-lock 对账：树中有而锁中无 **0**；锁中有而树中无 **50**，均为 OS/CPU/optional 限制的其他平台包（48 个 esbuild/rollup 平台包，加 lzma Linux 包与 fsevents）。**301 条第三方锁记录 − 50 = 251**，与当时 Windows 安装树一致。

---

本文保留原盘点的来源、用途和不确定性，不判断每项转录是否构成衍生作品，也不声称完成分发合规审查。需要进一步确认时，应回到所列上游副本与[许可证盘点](notes/LICENSE-INVENTORY.md)。
