# 可自行施工的任务单（2026-09-16）

> 状态：已归档（2026-09-17）。工作已全部落地：#113–#120。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

| # | 任务 | 分支 | 规模 | 碰的文件 |
| --- | --- | --- | --- | --- |
| W1 | 内置插件的「浏览器资产」栏说人话 | `dev/plugin-center-builtin-asset-copy` | 小 | `PluginCenter.tsx`、`strings.ts`、`plugin-center.test.ts` |
| W2 | i18n 实机脚本别把夹具计数写死 | `dev/live-i18n-check-fixture-count` | 小 | `apps/iris-web/tools/live-plugin-i18n-check.mjs` |
| W3 | qa 脚本的 CDP 端口偏移 | `dev/qa-cdp-port-offset` | 小 | `qa/z1-e2e.mjs`、`qa/README.md` |
| W4 | 契约包不再带悬空的 `.d.ts.map` | `dev/pack-contracts-no-declaration-map` | 小 | 三个 `tsconfig.pack.json`、`docs/PLUGIN-CONTRACT-PACKAGING.md`、`apps/iris/tests/contract-pack.test.ts` |
| W5 | 卸载插件时可选「连数据一起删」 | `dev/plugin-uninstall-remove-data` | 中 | 协议 `rpc.ts`、`plugins/install.ts`、`system-plugins.ts`、fake、`PluginCenter.tsx`、`strings.ts` |
| W6 | 两条还会偶发红的测试，从根因修 | `dev/flaky-tests-batch-3` | 中 | `scoped-regex.test.ts`、`variable-writers.test.ts`（必要时对应源码的观察口） |
| W7 | 卡脚本的 `console.*` 进诊断面 | `dev/sandbox-console-capture` | 中大 | `apps/iris-web/src/sandbox/`（帧侧）、`service.ts` 的 `#report` 通道、`DebugSurface`/诊断页、`docs/OBSERVABILITY.md` |

---

## W1 · 内置插件的「浏览器资产」栏说人话

**现状**：内置插件（Tavern Helper、MVU）不带 `client.js`，它们的帧侧成员打在核心成员包里。插件页的「浏览器资产」块因此显示「未声明 / 无 / 从未」，读起来像故障（`apps/iris-web/src/app/PluginCenter.tsx` 约 `:814`–`:820` 的 `<dl>`；键 `pluginCenterLastLoaded` / `pluginCenterLastLoadedNever`，`strings.ts:3029`–`:3030`）。实测 8787 的聚合清单是 `{"revision":4,"plugins":{}}`——正确，只是表达差。

**做法**：当行的 `source === 'builtin'` 且资产状态 `phase === 'undeclared'` 时，整个「浏览器资产」块换成一句话（两语）：「内置插件的帧侧成员随核心成员包加载，没有独立的浏览器包」，不再显示三格「无 / 从未」。第三方行与有 `client.js` 的行原样。

**牙齿**：`plugin-center.test.ts` 加断言：内置两行不出现「从未」且出现那句话；一个 `source: 'git'` 且 `undeclared` 的行仍显示原来的三格（防止把第三方的真缺失也糊掉）。变异：删掉 `source === 'builtin'` 条件 → 第三方行也变句子 → 红。

**ledger**：web 下一个空号。

## W2 · i18n 实机脚本别把夹具计数写死

**现状**：`apps/iris-web/tools/live-plugin-i18n-check.mjs:168` 断言同意页文案句匹配 `/4 条 · en\/zh|4 strings · en\/zh/`——假定夹具恰好 2 键 × 2 语言。协调人用 3 键夹具跑时这一步 FAIL，产品是对的（页面显示「6 strings」）。

**做法**：脚本启动时读夹具目录的 `i18n/en.json`、`zh.json`，算出 `Object.keys(en).length + Object.keys(zh).length`，断言页面数字等于它；顺带断言两份键集合相等（否则宿主本来就会拒，脚本应先报出来）。

**牙齿**：这是量具不是测试，牙齿用「故意给夹具加一个键再跑」验证断言跟着变；写进脚本头注释。

**ledger**：web，一行追加到 §101（U5 的那一节）末尾的「后记」即可，不新开节。

## W3 · qa 脚本的 CDP 端口偏移

**现状**：`qa/z1-e2e.mjs:17` 写死 `CDP_PORT ?? '9343'`，而同目录的其他脚本用 `9343 + pid % 100` 错开（`qa/notice-center-baseline.mjs:29`）。两个脚本同时跑，后者报「chrome never came up」，`qa/README.md` 正好警告过这种失败会被误读成环境问题。

**做法**：`z1-e2e.mjs` 改成同一个偏移公式（建议抽成 `qa/cdp-port.mjs` 一个 3 行的导出函数，两处都 import）；`qa/README.md` 的「表外的脚本」段落删掉那条警告、改成一句「统一走 `cdpPort()`」。

**牙齿**：qa 脚本没有测试；用两个脚本并行跑一次证明不再撞，把两次的端口号写进 PR。

## W4 · 契约包不再带悬空的 `.d.ts.map`

**现状**：三个 `packages/*/tsconfig.pack.json` 开着 `declarationMap: true` 与 `sourceMap: true`（如 `packages/iris-plugin-api/tsconfig.pack.json:10`–`:11`），而 tarball 不带源码，map 指向不存在的文件（`docs/PLUGIN-CONTRACT-PACKAGING.md` 已如实记为已知事实）。

**做法**：两项都关掉；`apps/iris/tests/contract-pack.test.ts` 加断言「tarball 里没有 `.map` 文件」；文档那句「已知事实」改成「已修」。跑 `npm run pack:contracts -- --version 1.0.0-alpha.0` 看三个 tarball 体积变化写进 PR。

**牙齿**：把任一 `declarationMap` 改回 true → 新断言红。

**ledger**：根 `notes/DEVIATIONS.md` 「契约包的发布形」那节末尾追加一段。

## W5 · 卸载插件时可选「连数据一起删」

**现状**：U3 落地时裁决「卸载保留 `plugin-data`」，并留了一句「将来 UI 再给『连数据一起删』」。`plugin.uninstall` 的请求形状只有 `{ id }`（`packages/iris-protocol/src/rpc.ts:269`）；`plugins/install.ts` 的卸载只删 `installed/<id>/` 与资产根。

**做法**：
- 协议：`plugin.uninstall` 增可选 `removeData?: boolean`（默认 false，旧客户端零变化）。
- 宿主：为真时在卸载事务里删除 `<profile>/plugin-data/<id>/`——**改名让开再尽力删**（本机 Node 在仓库目录内递归删除会静默无效，见 `scripts/pack-contracts.mjs` 的 clear 段与 U1 的 `superseded/` 做法），删不掉时按名上报 `reportStoreProblem`，行不进失败态。内置插件忽略该参数（它们没有 `plugin-data`？——先查：内置也可能用 `scope.storage`；有则同样处理，并在 PR 里写出实测）。
- fake 镜像参数。
- UI：卸载按钮旁一个复选框「同时删除它存的数据（N 个文件，M KB）」，数字由新的只读 RPC 或 `plugin.list` 行上的可选 `dataFootprint?: { files, bytes }` 提供（后者更省一个方法名；`method-names.test.ts` 只钉形状，加字段无碍）。默认不勾。

**牙齿**：不带参数卸载 → 数据在（T7 已有，别删）；带 `removeData: true` → 目录消失；删不掉（用测试夹具把目录改成只读或注入 `rm` 失败）→ 行仍卸载成功、诊断面有一条命名上报；UI 默认不勾且勾了才传参（fake 记录的参数断言）。

**ledger**：app-service、web 各一节。文档：`docs/PLUGIN-AUTHORING-RUNBOOK.md` 「插件私有存储」段加一句；`docs/SYSTEM-PLUGIN-INSTALL.md` §6 卸载语义补一句。

## W6 · 两条还会偶发红的测试，从根因修

**现状**：U6 根治了两条之后，还剩两条在并行负载下偶发：
- `packages/iris-app-service/tests/scoped-regex.test.ts` 「an open conversation is re-announced when the tier is refused」（三支门禁并行时红一次，单跑 5/5 绿；U1 的报告也提到同文件在 Windows 临时目录上遇到过 EBUSY 瞬态）。
- `packages/iris-app-service/tests/variable-writers.test.ts` 「a disable issued mid-propose does not tear the turn it lands in」（CI 红一次，重跑绿；U2 新写的，带 5 s 超时与 `Promise.race`）。

**做法**（照 U6 §86 的方法）：先用确定性手段复现——给可疑的异步点包一层 deferred，或在报告缓冲/事件广播处记调用栈——找出第二条路径或竞态的来源；然后修**夹具屏障或代码的观察口**，不放宽任何数字。每条在 ledger 里写清「竞态的两方是谁、谁先谁后、修的是哪一方」。

**牙齿**：修好后把旧屏障 + deferred 压入的组合当变异跑一次，应确定性地红（证明修的是原因不是运气）。

**ledger**：app-service 一节。

## W7 · 卡脚本的 `console.*` 进诊断面

**现状**：`docs/OBSERVABILITY.md` 2026-09-16 核对后的十二项状态表里，**唯一上游领先的一项**是「卡脚本 console」：酒馆助手的 Logger 面板能看到卡脚本的 `console.log/warn/error`，Iris 的沙盒帧里这些输出只进浏览器控制台，作者在 Iris 里看不见（表见 `docs/OBSERVABILITY.md` §五之二；上游对照在 §三第 3 条「只捕 `console.*`，不捕未处理异常」）。

**做法**（三层，每层一 PR 也行）：
1. 帧侧：在沙盒 bootstrap 里包一层 `console`，把 `log/info/warn/error` 的参数**序列化为字符串摘要**（长度上限、深度上限、循环引用安全）经现有的帧→壳消息通道上送，带卡 id、脚本 id、级别、时间；同时仍调用原 `console`（不吞浏览器控制台）。**不要**捕未处理异常——那是另一项，且上游也没做。
2. 壳→宿主：走现有的 `#report` 通道（`service.ts` 的 `Service.#report`，`kind` 新增 `card-console`，`grade` 为 note），进 `DiagnosticBuffer`，受它的 2000 条 / 1 MiB 上限；每张卡每秒上限 N 条，超出计数丢弃并记一条「丢弃了 K 条」。
3. 诊断页：现有的宿主报告列表能按 `kind` 过滤即可显示；文案两语。

**边界**：默认开（这是可观测性，不是执行权限）；卡脚本能 `console.log` 出敏感内容——它本来就能，诊断面只显示本地、不进日志文件（确认 `DiagnosticBuffer` 不落盘）。

**牙齿**：帧里 `console.log({a:1})` → 宿主报告缓冲出现 `card-console` 一条且正文是摘要；循环引用对象不炸；超限丢弃计数正确；`grade` 缺失被类型拒（既有规则）。变异：删掉序列化上限 → 「一个 10 MB 字符串被截到上限」的断言红。

**文档**：`docs/OBSERVABILITY.md` §五之二第 1 项改「已做」并写实现位置；`docs/SANDBOX.md` 能力面加一行。**ledger**：web 与 app-service 各一节。

---

## 验收

每项完成后发协调人：分支、最终 commit、门禁输出、牙齿表、与本单的偏离。协调人按老流程 rebase、门禁、实机（W1/W5/W7 会在复制数据目录上起宿主看页面）、合入。
