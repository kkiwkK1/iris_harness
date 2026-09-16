# 基建任务单 · 上游兼容面跟踪（2026-09-16）

> 状态：有效。写于 2026-09-16，基线 `main` `11de7ff`。两项任务 V1、V2，可同时施工，文件不相交。落地后本状态行改为「已落地（#PR）」。

## 0. 背景与裁决

Iris 内置的 Tavern Helper 与 MVU **不是上游代码**，是按上游 API 面重新实现的兼容层（`packages/iris-compat-tavernhelper*`、`packages/iris-mvu`）。上游更新到我们这里的含义不是「拉新版本」，而是「上游 API 面变了，我们的实现要跟上」。今天两处都不诚实：

- 插件页把两个内置插件的版本显示为 `0.0.0`（`packages/iris-app-service/src/plugins/builtins.ts:31`、`:44` 的 `version` 字面量，经 `SystemPluginView.version` 原样到页面 `apps/iris-web/src/app/PluginCenter.tsx:814`）。真实状态是「兼容到 JS-Slash-Runner **4.9.1** 的 API 面，读数于 2026-09-02」（`docs/OBSERVABILITY.md:17`、`docs/SANDBOX.md:365`）。
- 我们对上游成员表的唯一记录是**手抄**的 `UPSTREAM_MEMBERS`（`apps/iris-web/src/sandbox/upstream-surface.ts:241`），普查脚本 `scripts/th-member-census.mjs` 只拿它数**我们自己**的卡在用什么；上游发新版本时没有任何东西会告诉我们「面变了」。

协调人裁决（2026-09-16，不重开）：
1. 内置插件的「版本」表达为**兼容目标**而非自身版本；仍是 `SystemPluginView.version: string`，不加协议字段。
2. 上游跟踪是**只报告、不阻断**的量具：进 CI 作为独立 job，红了只出报告，不让 `check` 失败；上游抓取按**钉死的 commit** 进行（与安装器一样：https、40 位 commit），不追 `main`。
3. 第三条路（让上游 TH 经 ST 扩展兼容面直接跑）**不在本单**，先记想法。

施工流程沿用 `notes/INFRA-TASKS-2026-09-15.md` §0（一 worktree 一分支、离线安装、门禁清单、牙齿表、ledger 编号、PR 说明格式）。

## 1. 并行性

| | V1 兼容目标显示 | V2 上游面差分 |
| --- | --- | --- |
| 主要文件 | `plugins/builtins.ts`、`plugins/tavern-helper.ts` / `plugins/mvu.ts`（若常量放那里）、`PluginCenter.tsx`、`i18n/strings.ts`、`plugin-center.test.ts`、`render-check.tsx` | 新 `scripts/upstream-surface-diff.mjs`、新 `scripts/upstream-pins.json`、`.github/workflows/ci.yml`（新 job）、`apps/iris/tests/`（一条对差分脚本纯函数的测试）、`docs/` 与 `notes/apps/iris-web/CARD-SURFACE.md` 附记 |
| 重叠 | 无（V2 读 `upstream-surface.ts` 不改它；V1 不碰 scripts） | |

## V1 · 内置插件显示兼容目标，而不是 `0.0.0`

**分支** `dev/builtin-compat-version` · **ledger** app-service §87、web §103

**要做的**
- 在 `packages/iris-app-service/src/plugins/` 里放一处常量（建议新文件 `compat-targets.ts`，两个内置各一条）：
  ```ts
  export const TAVERN_HELPER_COMPAT_TARGET = { upstream: 'JS-Slash-Runner', version: '4.9.1', measuredOn: '2026-09-02', source: 'https://github.com/N0VI028/JS-Slash-Runner' } as const
  export const MVU_COMPAT_TARGET = { upstream: 'MagVarUpdate', version: '<从 bundle 或其 package.json 读出的版本>', measuredOn: '<读数日期>', source: 'https://github.com/MagicalAstrogy/MagVarUpdate' } as const
  ```
  MVU 的版本号与日期**必须实测**：卡从 `cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate` 拉 bundle，先查 `packages/iris-mvu` 与 `notes/packages/iris-app-service/UPSTREAM-MVU-INIT-PATH.md` 记录的是哪一版；没有记录就写「未记录」并在 PR 里说明，不许编。
- `builtins.ts` 的 `version` 字面量改为由常量生成的字符串，形状 **`compat:JS-Slash-Runner@4.9.1`**（前缀 `compat:` 是页面区分「自身版本」与「兼容目标」的判据；协议不变）。
- `PluginCenter.tsx:814` 那一格：`version` 以 `compat:` 开头时显示为「兼容 JS-Slash-Runner 4.9.1」并带一行小字「读数 2026-09-02，内置重实现，随 Iris 构建更新」；否则原样。新 i18n 键进 `pluginCenter*` 族，两列齐全（`i18n.test.ts` 会审计）。
- 同意页（`PluginConsent`）不涉及：内置插件不走安装。

**牙齿**
- `plugin-center.test.ts`：内置两行渲染「兼容 …」且不出现 `0.0.0`；一个第三方行（`version: '1.0.0'`）仍原样显示——两向都断。
- 常量测试：`compat:` 字符串由常量拼出（改常量红），`measuredOn` 是 ISO 日期。
- `check:render` 加内置行一例。
- 变异：删 `compat:` 分支 → 页面显示 `compat:JS-Slash-Runner@4.9.1` 原文 → 红。

**文档**：`docs/SYSTEM-PLUGINS.md` 内置插件段加一句「版本格显示兼容目标」；`docs/PLUGIN-AUTHORING-RUNBOOK.md` 不变（第三方插件仍写自身版本）。

## V2 · 上游 API 面差分：上游变了我们要知道

**分支** `dev/upstream-surface-diff` · **ledger** 根 `notes/DEVIATIONS.md` 新节（脚本属仓库级）

**现状**：`UPSTREAM_MEMBERS`（`upstream-surface.ts:241`）、`MEMBER_KINDS`（`apps/iris-web/src/sandbox/identity.ts:69`，124 项）、`CARD_METHODS`（`apps/iris-web/src/sandbox/card-api.ts:31`，37 项）是我们对「卡能碰到什么」的三份声明；`scripts/th-member-census.mjs:66`–`:67` 与 `card-surface-census.mjs:132`–`:133` 直接 import 它们（U-T4 已把它们从源码切片改成导入）。没有任何脚本读**上游**。

**要做的**
- `scripts/upstream-pins.json`：`{ "JS-Slash-Runner": { "repo": "https://github.com/N0VI028/JS-Slash-Runner", "commit": "<40 hex>", "surfaceFiles": ["src/function/**/*.ts", …] }, "MagVarUpdate": { "repo": "https://github.com/MagicalAstrogy/MagVarUpdate", "commit": "<40 hex>", "surfaceFiles": [...] } }`。commit 由施工者选定为 4.9.1 对应的 tag/commit（读上游 CHANGELOG 与 tag 确认，PR 里写出证据）；MVU 同理。
- `scripts/upstream-surface-diff.mjs`：
  1. 拉取：`git clone --depth 1 --no-recurse-submodules` 后 `checkout <commit>`（或 jsdelivr 按 commit 取单文件），**固定 argv、不走 shell**（照 `packages/iris-extension-installer/src/source.ts` 的写法，可直接复用其 `materializeGit` 若导出面允许；不允许就说明为什么另写）。缓存到 `os.tmpdir()`（不是仓库目录——本机 Node 递归删除在仓库目录内静默无效，见 `scripts/pack-contracts.mjs` 的 clear 段）。
  2. 提取上游面：对 TH，用 TypeScript 编译器 API（`typescript` 已在仓库依赖里）读 `surfaceFiles`，收集**导出的函数/常量名与其参数签名**；上游把成员挂到全局的方式要先读一遍它的入口确认（`macro_like.ts` 等），把「哪些导出算卡可见成员」的判定写成代码里可读的规则，不是猜。对 MVU，读 bundle 的入口，提取 `Mvu.*` 面。
  3. 差分：三列——**上游有、我们没有**（对 `UPSTREAM_MEMBERS` ∪ `MEMBER_KINDS` 的键）、**我们有、上游已删**、**签名变了**（参数个数/名字变化）。输出 Markdown 表 + JSON，退出码 **0**（量具不是测试）。
  4. `--offline` 模式：只读缓存；缓存缺失时打印原因退出 0（与 census 脚本「缺语料退出 0」一致）。
- 纯函数分离：提取与差分逻辑放在可 import 的模块（`scripts/lib/upstream-surface.mjs`），网络与文件系统只在 `run()` 里；测试对着两份内置夹具（一份「上游多两个成员、删一个、改一个签名」）断三列各自正确，且**比较的成员数下限**（避免循环空跑绿）。
- CI：`.github/workflows/ci.yml` 新增 job `upstream-surface`（与 `check` 并列，**不**加进 ruleset 的必需检查），跑脚本并把 Markdown 报告上传为 artifact；actions 一律钉 SHA（`workflow-pins.test.ts` 会查）。
- 记录：`notes/apps/iris-web/CARD-SURFACE.md` 加一节附记，写第一次差分的结果（上游 4.9.1 的 commit 对我们 `UPSTREAM_MEMBERS` 的三列数字）——这是它今天的实际读数，很可能已经不是零。

**牙齿**
- 夹具差分三列各一条 + 计数下限；`--offline` 无缓存退出 0 且打印原因；提取规则对一个已知的上游文件片段（内置为夹具，不联网）得到预期成员集合。
- 变异：把「上游有我们没有」那一列的集合差方向写反 → 红；删掉签名比较 → 「签名变了」那条红；提取规则改成收集所有标识符 → 计数下限之外的「成员集合相等」断言红。
- CI job 的存在与钉 SHA 由 `workflow-pins.test.ts` 覆盖；另加一条断言：`upstream-surface` job **不在** ruleset 必需检查名单（读 workflow 文件里的 job 名与 `check` 不同即可）。

**文档**：`docs/SYSTEM-PLUGINS.md` 「内置插件」段加「兼容面跟踪」两句并链接脚本；`docs/INFRASTRUCTURE-INTERFACES.md` §8 加一行「上游兼容面跟踪：已有差分量具（V2），自动跟随上游实现仍未做」；`CONTRIBUTING.md` 门禁清单加「`node scripts/upstream-surface-diff.mjs --offline`（报告，不阻断）」。

## 2. 验收

- V1：8787 复制数据目录起宿主，`plugin.list` 两内置 `version` 为 `compat:…`；浏览器插件页两行显示「兼容 JS-Slash-Runner 4.9.1」与读数日期；第三方 dev 夹具行仍显示 `1.0.0`。
- V2：本机联网跑一次真实差分，报告三列数字进 PR 说明与 CARD-SURFACE 附记；`--offline` 在无缓存机器上退出 0；CI 新 job 绿且 artifact 有报告。
- 两项都跑 §0 的完整门禁；完成报告附分支、commit、门禁输出、牙齿表、与本单的偏离。
