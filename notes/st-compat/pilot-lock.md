# P0 试点锁定 —— ST 兼容施工的版本基线

日期：2026-09-13。性质：`docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §9 批次 P0 的锁定记录。锁定即施工对象：P2 的安装分析、P3 的兼容试点、P4/P5 的 TH/MVU 验证都以下表的 commit/hash 为准；换版本等于换基线，必须重做本文件并同步派工单。

## 1. 基线总表

| 对象 | 锁定值 | 本机状态 | 许可证 |
| --- | --- | --- | --- |
| Iris 集成分支 | `dev/system-plugins` @ `2ac0f064eb939dcc2b5a963b4d7fbacb53c871d1`（`PLUGIN_KERNEL_BASE`） | worktree `D:/workspace/小项目/iris-system-plugins`，干净 | 仓内各包自有声明 |
| Iris main | `2079dbe1ef1ad6b2ae975c8c53ffe93706199bc3` | worktree `D:/workspace/小项目/iris_cordis_traven` | 同上 |
| SillyTavern | `51ad27fb86d39a3daca3adaa970375c9670c12df`（`package.json` version `1.18.0`） | `E:/sillyTavern/SillyTavern`，**只读**，工作树干净 | AGPL-3.0（`LICENSE`） |
| ST-Prompt-Template（简单扩展试点） | `f9a07da0fbe25cd310eee746c2f5af24ed61f62b`（2026-06-20，manifest version `1.17.4.1`） | `E:/sillyTavern/SillyTavern/public/scripts/extensions/third-party/ST-Prompt-Template`，**只读**，工作树干净，origin `github.com/zonde306/ST-Prompt-Template` | AGPL-3.0（`LICENSE`） |
| TavernHelper 上游（TH） | `cd9f523d08d147057043b9939397de8a61be91e4`（默认分支 `main`，2026-09-12，无 release，锁定 commit） | 无本机副本；P4 施工时按此 commit 获取发布物 | **AFPL v9**（Aladdin Free Public License，`LICENSE`，非 OSI，含商用限制） |
| MagVarUpdate 上游（MVU） | `61010dab47bc3a08a1b626320bf7fc8c9573eca4`（默认分支 `beta`，2026-08-31，无 release，锁定 commit） | 无本机副本；卡内引用形态为 jsdelivr `gh/MagicalAstrogy/MagVarUpdate` 的 `artifact/bundle.js`（`notes/PLUGIN-FEASIBILITY.md` 勘察） | MIT（GitHub API license spdx_id） |

上游 commit 取自 GitHub API（2026-09-13 读取），两仓当日均有推送（TH pushed_at 2026-09-12、MVU 2026-09-12），**锁定值为快照不是跟踪**：P4/P5 开工时若上游已移动，按锁定 commit 取历史版本，不追新。

## 2. ST-Prompt-Template 发布物指纹

勘察命令与完整证据：`survey/st-prompt-template.report.json`（由 `survey/survey-st-extension.mjs` 生成，脚本只读，报告为唯一写出物）。

| 项 | 值 |
| --- | --- |
| manifest sha256 | `1169b3545c2ef5c2717c1e9611fbac4474d94dc411214e5854330bc58b49cd7d` |
| 入口 `dist/index.js` | 5,083,741 字节，sha256 `61a87e9295dbcb2dc8335f90e95dbb67517457958d855bfb8f31798a042f71fd` |
| manifest 字段 | `display_name`、`loading_order: 1`、`requires: []`、`optional: []`、`js: dist/index.js`、`css: ""`、`author: zonde306`、`version: 1.17.4.1`、`homePage`、`auto_update: true`、`i18n: {zh-cn, zh-tw}`；未知字段：无 |
| 目录体量 | 415 文件 / 102,374,704 字节（含 `src/`、`tests/`、webpack 分包与 source map；`dist/` 含 17.7MB 的 `index.js.map`） |
| Worker | `dist/editor.worker.js`（282,983 字节）、`dist/ejs.workers.js`；后者以**构建期烘焙的绝对路径** `new Worker("/scripts/extensions/third-party/ST-Prompt-Template/dist/ejs.workers.js")` 启动，另有 trustedTypes 包装的 Worker 站点 |
| 静态 import | 18 个 specifier 全部分类（未解析 0）：16 个 ST 宿主模块 + 1 个自有文件 + 1 个歧义尾名 |

### 2.1 依赖的 ST 宿主模块（P3 门面最小集的输入）

`script.js`、`lib.js`、`scripts/events.js`、`scripts/extensions.js`、`scripts/world-info.js`、`scripts/popup.js`、`scripts/openai.js`、`scripts/power-user.js`、`scripts/slash-commands.js`、`scripts/slash-commands/SlashCommand.js`、`scripts/slash-commands/SlashCommandArgument.js`、`scripts/slash-commands/SlashCommandParser.js`、`scripts/tokenizers.js`、`scripts/utils.js`、`scripts/group-chats.js`、`scripts/reasoning.js`、`scripts/extensions/regex/engine.js`（内建 regex 扩展引擎）。

歧义保留（不猜测，P2 解析器 pass 裁决）：`../../../../openai.js` 的尾名同时命中 `scripts/openai.js` 与 `scripts/extensions/tts/openai.js`；`../libs/faker.mjs` 同时命中扩展自有文件与 ST 树内同尾路径。按上游语义（`notes/ST-COMPARE.md` 的 TH 勘察同族事实）应为 `scripts/openai.js` 与自有文件，但本报告只记录歧义。

## 3. 本机 ST 1.18.0 的 manifest 读取语义（规范化规范的对齐目标）

`public/scripts/extensions.js` 实际读取：`js`、`css`（入口资产，`:429,782,814`）、`loading_order` + `display_name`（排序，`:49-50`）、`requires`（**Extras 模块**，非插件依赖，`:578`）、`dependencies`（扩展依赖，`:579`）、`minimum_client_version`（对 `CLIENT_VERSION` 比较，`:580,586`）、`optional`（展示用 requirement chips，`:972-986`）、`i18n`（locale 文件映射，`:849-855`）；安装/更新路径另读 `author`/`version`/`homePage`/`auto_update`。与 RUNBOOK §2 的表一致：`requires` 不得混作 `dependencies`，`minimum_client_version` 不可与 Iris 版本比较。

## 4. 锁定物的获取边界（P2 的输入约束）

- ST-Prompt-Template：本机已有完整 git 克隆（含 `dist/`），P2 试点夹具从**本目录复制**并记录来源，不从网络重取；上游仅作更新对照。
- TH/MVU：无本机副本。P4/P5 获取时按 §1 锁定 commit 定取，jsdelivr `@master`/`@main` 浮动引用（现有卡内形态）**不作为锁定源**。
- 本机 ST 目录只读；`data/` 下 `secrets.json` 不读，key 不打印（RUNBOOK §11）。
