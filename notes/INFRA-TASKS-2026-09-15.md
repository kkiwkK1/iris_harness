# 基建任务单 · 第二批（2026-09-15）

> 状态：已完成（2026-09-16 记）。本单六项（U1–U6）全部落地，对应 PR #101–#106；`docs/INFRASTRUCTURE-INTERFACES.md` §8 已按落地结果重记（U1 更新事务、U2 `scope.variables.registerWriter`、U3 `scope.storage`、U5 插件自带文案、U6 加固清账各自闭合，U4 的产物是 `docs/GENERATION-HOOKS.md`）。**各项的施工文档留在分支 `dev/infra-task-docs-batch-2`，按决定未合入 `main`。** 本文件是任务单，不随代码更新；现状以 `docs/` 为准（索引见 `notes/README.md`）。

基线 `main` `e03adbb`（PR-1/2/3 安装路径已全部落地）。本批六项，都是 `docs/INFRASTRUCTURE-INTERFACES.md` §8 里「未做」的行或 PR-2/3 记下的未闭合项。每项一个 `dev/<topic>` 分支、一个 PR 到 `main`，由协调人验收合入。行号只作 `e03adbb` 的证据，定位以符号名为准。

## 0. 共同施工流程

1. `git worktree add ../iris-<topic> -b dev/<topic> origin/main`，进入后 `pnpm install --frozen-lockfile --offline`，`apps/iris-web` 里 `npm install --offline && npm run build`。分支**立刻推到远端**（空提交也行），协调人要能看见。
2. 先读任务单指的文档和代码，**再**动手；任务单里的前提如果与代码不符，代码赢，把纠正写进 PR 说明的第一段。
3. 每条新断言要有「牙齿」：至少一次故意破坏让它变红，把「哪个改动让哪条断言红」列成表放进 ledger。不许弱化或删除既有断言；改既有测试只允许更严。
4. 门禁（全部跑、原样引用输出）：根 `npx tsc -p . --noEmit`；`apps/iris-web` 里 `npx tsc --noEmit`、`npm run build`（bootstrap check 那行）、`npm run check:render`；根 `npm test`（`ℹ fail 0`）；`FORCE_COLOR=0 npm run test:no-corpus`（现为 `40 skipped, 0 failed`；加了语料门测试要说明数字为何变）；`node --test apps/iris/tests/md-references.test.ts`。
5. Ledger 条目编号本单已预留（见各项）；两支同时追加同一 ledger 会冲突，解决方式是**按节序两边保留**，不改内容。
6. PR 说明：问题、做法、与任务单的偏离（实测推翻的前提）、牙齿表、门禁输出。提交署名行按仓库惯例。
7. 已知偶发红：`chat-search.test.ts` 的比例断言、`chat-integrity.test.ts` 的「只报告一次」，并行负载下会红，单跑绿。若全量只红这两条之一，重跑一次并把两次输出都贴出来（U6 负责根治）。

## 1. 并行性

| | U1 更新事务 | U2 变量写入 API | U3 `scope.storage` | U4 生成钩子（设计） | U5 插件自带文案 | U6 加固与清账 |
| --- | --- | --- | --- | --- | --- | --- |
| 主要文件 | `plugins/install.ts`、`system-plugins.ts`（更新段）、协议 `rpc.ts`、fake、`PluginCenter.tsx` | `service.ts` 结算段、`plugins/capabilities.ts`、`variable-arbitration.ts`、plugin-api `index.ts`（新成员）、`plugins/mvu.ts`/`tavern-helper.ts` | plugin-api `index.ts`（新成员）、`system-plugins.ts`（scope 构造）、`plugins/manifest.ts`（权限词表）、新 `plugins/storage.ts` | 只有 `docs/GENERATION-HOOKS.md` | `plugins/manifest.ts`（新字段）、`plugin-assets.ts`、web `i18n/strings.ts` 的运行期覆盖层、`use-plugin-manifest.ts` | `iris-extension-installer/src/source.ts` 与其测试、`PluginCenter.tsx` 资产列、两条偶发测试 |
| 与谁有小面积重叠 | U6（PluginCenter 两处不同区域） | U3（plugin-api 接口同一处追加成员；`system-plugins.ts:896` 的 scope 字面量同一处追加） | U2、U5（`manifest.ts` 不同区域） | 无 | U3 | U1 |

六项可以同时开工。重叠都是**追加式**，冲突时按下面的约定排序：plugin-api 接口与 scope 字面量里，`storage`（U3）排在 `variables`（U2）前；`PLUGIN_PERMISSIONS` 词表里新名字按字母序插入；`manifest.ts` 的新字段 `i18n`（U5）放在 `client` 之后。

---

## U1 · `plugin.update` 更新事务（裁决 2 预留位的兑现）

**分支** `dev/plugin-update-transaction` · **ledger** app-service §81、web §100

**现状**：`plugin.update({ id, commit })` 的 schema、handler 与 fake 都在，handler 固定抛 `unsupported`（`packages/iris-app-service/src/service.ts`，搜 `'plugin.update'`；`packages/iris-app-service/src/plugins/install.ts` 的 `PluginInstaller`）。更新今天只能「卸载后重装」：卸载删树、重装重新走完同意、`enabled` 偏好丢失。

**要做的**：
- `plugin.update` 变成一个真实事务：对一个 `source: 'git'` 的已装行，按新 `commit` 走 **同一条** preview（复用 `preview()`，`source` 取行里记录的 `remote`），返回的 preview 多带 `updateOf: { id, fromCommit, fromTreeHash }`；确认仍是 `plugin.confirmInstall`，echo 里 `id` 等于已装行的 id 时视为更新而不是撞车（裁决 5 只拒**新安装**撞已有 id）。
- 确认时的原子替换：新树促进到同一 `installed/<id>/`，旧树改名让开后删除（本机 `rmSync` 在仓库目录内静默无效这一课见 `scripts/pack-contracts.mjs` 的 clear 段，同样的「改名让开、尽力删、删不掉按名提示」）；目录行更新 `commit`/`treeHash`/`installedAt`，**保留 `enabled`**；若原来 `enabled`，先 disable 旧代、促进、再 enable 新代，任一步失败回到旧代（旧树还在，因为删除在最后）。
- `dev` 行的 `update` 是 `unsupported`，消息说明 dev 就地加载不需要更新；`builtin` 同理。
- 同意页复用 PR-3 的 `PluginConsent`，多显示「从 `abcd1234…` 更新到 `ef567890…`」与两个 treeHash；行上多一个「更新到…」入口（输入新 commit）。
- fake 镜像同样的状态转换。

**牙齿必须覆盖**：更新保留 `enabled`；旧代已 disable 而新代 enable 失败时行回到旧代且 `failure` 命名；确认 echo 的 `treeHash` 与新预览不一致被拒且旧树不动；`dev`/`builtin` 的 update 明确拒绝；`method-names.test.ts` 的形状规则不变（不新增方法名，`plugin.update` 只是从占位变成实现，`INFRASTRUCTURE-INTERFACES.md` §3 的那一行从「预留」改成「实现」）。

**验收**：一个本地 bare 仓库两个 commit（`packages/iris-app-service/tests/plugin-install.test.ts` 已有夹具），装第一个、启用、更新到第二个，`plugin.list` 里 `enabled` 不变、`commit` 变、`provenance.treeHash` 变；`apps/iris-web/tools/live-plugin-install-check.mjs` 加一段 update 路径（可选，做了就把证据追加到 `notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` 的新小节）。

---

## U2 · 插件可写变量：把两处写死的 pluginId 换成注册表

**分支** `dev/plugin-variable-writers` · **ledger** app-service §82

**现状**：回复结算处按名点 Tavern Helper 和 MVU（`packages/iris-app-service/src/service.ts` 搜 `plugins.lease('tavern-helper')`、`plugins.lease('mvu')`，约 `:5006`/`:5014`；MVU 的能力经 `plugins.capability('mvu', MVU_CAPABILITY)` 取，`packages/iris-app-service/src/plugins/capabilities.ts`），提案经 `arbitrateMessageVariables`（`packages/iris-app-service/src/variable-arbitration.ts`）按 ST 顺序、后者胜、冲突上报结算。第三个写变量的插件**接不进来**——§8「插件可写变量」行。

**协调人裁决（不重开）**：
- 通过激活作用域注册，不加分支：`scope.variables.registerWriter({ baselineFor(turn), propose(turn, view): Promise<VariableProposal | undefined> })`，返回 `Disposable`；`SystemPluginActivationScope` 新增只读成员 `variables`。
- 顺序 = **激活顺序**（依赖先于依赖者，同层按 id 字典序），等价于今天 TH 先于 MVU；后者胜、冲突上报的语义不变（`arbitrateMessageVariables` 不改算法，只改输入来源）。
- 一个 writer 抛错或超时（5 s）：该 writer 的提案作废、`failure: { state: 'activate-failed' … }` 不合适——用行上新的 `lastError`? **不**：复用 PR-2 的 `failure` 字段加一个新状态 `hook-failed`（U4 也会用到这个名字，先在这里定义，U4 引用），结算继续，不阻塞回复。
- 权限词表加 `write-variables`（`PLUGIN_PERMISSIONS`，`packages/iris-app-service/src/plugins/manifest.ts`），同意页自动显示；读不需要权限。
- TH 与 MVU 两个内置插件**改走同一个注册表**（在 `plugins/tavern-helper.ts`、`plugins/mvu.ts` 的 `activate` 里注册），`service.ts` 结算段删掉按名分支。行为逐字不变：`packages/iris-app-service/tests/` 里现有的变量结算测试一条不改仍绿。

**牙齿**：第三个 writer（测试夹具插件）能接入并在两者之后生效；禁用一个 writer 它的提案立刻消失（lease 撤销）；writer 抛错回复照常结算且行上 `hook-failed`；顺序断言（改成 id 逆序应红）；`impersonating` 时 MVU 不写的既有行为保留（现在是 `!impersonating` 分支——要变成 writer 自己看 `view.kind` 判断，测试要证明这一点）。

**验收**：`npm test` 全绿且变量相关测试文件零改动；`git diff --stat service.ts` 只减不增或接近。

---

## U3 · `scope.storage`：插件私有存储

**分支** `dev/plugin-scope-storage` · **ledger** app-service §83

**现状**：§8「`scope.storage` / `scope.settings`」行——ST 设置走 `StCompatOptions` 闭包（`packages/iris-app-service/src/service.ts:477`、`index.ts:858`），通用接口没有。第三方插件今天没有任何合法落盘处，只能拿 `scope.context` 乱写。

**协调人裁决**：
- 位置 `<profile>/plugin-data/<id>/`，与安装树（`system-plugins/installed/<id>/`）分开：一个是代码一个是数据，卸载删代码**不删数据**（与 ST 保留 extension settings 一致；将来 UI 再给「连数据一起删」）。
- API（`SystemPluginActivationScope.storage`）：`get(key): Promise<unknown | undefined>`、`set(key, value: JsonValue): Promise<void>`、`delete(key)`、`keys()`。`key` 语法沿用 id 语法 `/^[a-z0-9][a-z0-9._-]{0,63}$/`（`isValidExtensionId`，不再造第二个正则），一个 key 一个文件 `<key>.json`。
- 写入用 `atomicWriteFile`（`packages/iris-app-service/src/atomic.ts`），读到坏 JSON 走 `.corrupt-<ts>` 隔离并返回 `undefined`（与 JSON store 的做法一致，`storage-error` 事件上报），禁止键 `__proto__`/`constructor`/`prototype` 在**值**里按现有 9 处写面的同一规则拒绝（找 `forbiddenKeys` 的实现复用）。
- 上限：单值 1 MiB、单插件 64 MiB（超限 `set` 拒绝，命名错误），数字写进常量并在 docblock 里说明依据。
- 权限词表加 `plugin-storage`；没声明就调用 → 抛命名错误（这是**词表第一次带上后果**，因为存储是宿主给的服务，可以真拒；`host-context` 之类仍是声明——把这个区别写进 `PLUGIN_PERMISSIONS` 的 docblock 和 `docs/SYSTEM-PLUGIN-INSTALL.md` §4）。
- lease 撤销（disable/重载）后的 `set` 拒绝，同 PR-2 的 ScriptVariableStore 语义（`invalid-request`）。
- 不迁移 TH/MVU 的现有存储。

**牙齿**：路径包含（key `../x`、`C:\x`、`.`）拒绝；坏文件隔离且下一次 `set` 成功；上限两条各一；未声明权限的调用被拒；lease 撤销后写被拒；两个插件互不可见（同名 key 各自文件）。

**文档**：`docs/PLUGIN-AUTHORING-RUNBOOK.md` 加「插件私有存储」一节；`docs/INFRASTRUCTURE-INTERFACES.md` §2 加成员、§8 行闭合。

---

## U4 · 生成钩子：先设计，不写代码

**分支** `dev/generation-hooks-design` · **产物** `docs/GENERATION-HOOKS.md`（无 ledger）

**现状**：§8「生成钩子」行——TH/MVU 在固定调用点被取用（`service.ts` 的 `#processReplyViaStCompat` 约 `:6470`、结算段约 `:5006`–`:5069`、`plugins/capabilities.ts`），没有 `beforePrompt`/`afterReplyText`/`onSettle` 挂点。§8 的完成条件是「明确 owner、顺序、取消、错误语义与释放，再开放」。

**协调人给定的约束（设计要在这些之内）**：
- 钩子经 `scope.hooks.<name>(fn)` 注册，返回 `Disposable`；三个名字先定 `beforePrompt`（拿到即将发送的 prompt 的只读视图，返回**提案**：追加/替换的段，不直接改）、`afterReplyText`（拿到回复文本只读视图，返回替换文本或 `undefined`）、`onSettle`（只通知，返回值忽略）。
- 顺序 = 激活顺序（同 U2）；一个钩子 5 s 超时或抛错 → 记 `hook-failed` 到行上，**本轮生成继续**，绝不阻塞或撕掉回复。
- 取消：AbortSignal 传给每个钩子；用户 abort 后不再调用后续钩子。
- 释放：随 lease 撤销，`isCurrent()` 为假的钩子不再被调用。
- 不改变 TH/MVU 今天的行为——设计里要有一节把它们**今天的每一个固定调用点**列成表（符号名 + `path:line`），标出哪些能映射到三个钩子、哪些不能（不能的说明为什么，那就是 §8「TH 只从实现剥离」那句的实证）。

**交付**：250–400 行中文设计稿：目标/非目标、现状调用点清单、三个钩子的类型草图、时序图（文字）、失败与释放语义、与 U2 变量 writer 的关系（`onSettle` 与 `propose` 是不是一回事——给出答案）、分阶段落地（每步一 PR）、被否决的方案、待裁决问题（≤5）。`md-references.test.ts` 过。协调人裁决后才开第二阶段。

---

## U5 · 插件自带文案：i18n 命名空间合并

**分支** `dev/plugin-i18n-bundles` · **ledger** web §101（web 侧）、app-service §84（清单与资产面）

**现状**：§8「i18n 命名空间合并」行——字典是 `apps/iris-web/src/app/i18n/strings.ts` 的静态 `en`/`zh`，`StringKey = keyof typeof en`，`translate(lang, key, params)` + `interpolate`；`i18n.test.ts` 审计 zh 含中文、两列占位符一致、用到的键存在。插件今天没法带自己的文案，PR-3 的 85 个键全是壳里写死的。

**协调人裁决**：
- 清单 `iris.plugin` 新增可选字段 `i18n: { en: 'i18n/en.json', zh: 'i18n/zh.json' }`（两种语言**都必须有**，缺一个是 `manifest-invalid`，字段名 `i18n.zh`）；文件是平坦 `Record<string,string>`，键语法 `/^[a-zA-Z][a-zA-Z0-9]*$/`。
- **预览期审计**：`parsePluginManifest` 之后、`hashed` 之前读两份文件，跑与 `i18n.test.ts` 相同的三条规则（两列键集合相等；zh 值含中文；`{placeholder}` 集合两列一致），违规 → `manifest-invalid`，`field` 形如 `i18n.zh.someKey`。规则实现放到一个两侧都能 import 的纯模块（`@iris/text` 已是零依赖包，符合它的成员规则「宿主和帧必须算出同一个答案的纯函数」——放那里，并让 `i18n.test.ts` 改为调用它，一个实现两个消费者）。
- 下发：经现有资产面 `/plugins/<id>/i18n/<lang>.json?rev=`，聚合清单（`plugin-assets.ts` 的 `plugins[id]`）多一个 `i18n?: Record<Language, string>`；停用即 404 的既有规则自然覆盖。
- 帧/壳侧：`use-plugin-manifest.ts` 在 `plugins.changed` 后拉取，合并进一个**运行期覆盖层**，键名加前缀 `plugin:<id>:`；`translate` 只对 `plugin:` 前缀查覆盖层，静态 `StringKey` 类型**不动**（插件键在编译期不存在，不能进类型）。缺失回退到 `en`，再缺显示键名本身（可见的失败，不是空白）。
- 同意页多一行「文案：N 条 · en/zh」；PluginCenter 行的 `displayName`/`description` 若清单 i18n 里有 `displayName`/`description` 键则按当前语言显示。

**牙齿**：缺一种语言拒；占位符不一致拒且 `field` 点名键；zh 全英文拒；停用后请求 i18n 资产 404；覆盖层键不污染静态键（一个插件声明 `pluginCenterTitle` 不会覆盖壳的）；切换语言后插件文案跟着换。

---

## U6 · 加固与清账（四件小事，一支分支）

**分支** `dev/infra-hardening-batch-2` · **ledger** app-service §85（前两件）、web §102（第三件）；第四件按各测试所在包的 ledger

1. **ST 安装器拒带凭据的远端**。`validateExtensionSource`（`packages/iris-extension-installer/src/source.ts:49`）今天只查 scheme 与空白/引号，`https://user:token@host/repo` 放行，PR-2 只在系统插件路径上拒了。裁决：**两条路都拒**——URL 会进 lock、目录和同意页，一个写进记录的秘密不是 ST 兼容问题；在 `notes/packages/iris-app-service/DEVIATIONS.md` 记为有意偏离（ST 本身接受这种 URL）。系统插件路径上那处重复检查改为复用安装器的。
2. **「不拉 submodule」补测试**。PR-2 记录：`grep -rn submodule packages/*/tests` 为空，不变量只靠固定 argv 里的 `--no-recurse-submodules`。做一个本地 bare 夹具仓库，含 `.gitmodules` 与指向另一个本地仓库的 gitlink，安装后断言：安装树里该路径**为空目录或不存在**、`hashTree` 不含子模块任何文件、且 argv 断言仍在。把它加进 `packages/iris-extension-installer/tests/`。
3. **PluginCenter「浏览器资产」列的量纲**。行上「期望 revision 5 · 实际加载 revision 124631e8264a」（`PluginCenter.tsx:819`–`:820`，数据来自 `use-plugin-manifest.ts`）——前者是目录 `revision` 计数，后者是资产 `rev` 哈希。查清这一列**想比的是什么**（成员表绑定的 revision 与帧实际加载的？还是清单 rev？），改成比同一个量，或者拆成两行各自标清；文案键改名要同步两列字典。`notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md`「顺手看到」一节里的那条随之关掉（在该文件末尾加一行状态，不改正文）。
4. **两条偶发红的测试**：`packages/iris-app-service/tests/chat-search.test.ts`「677-floor … scans in proportion」（`SCAN_SLACK = 3`，并行下 2.4 s 对 0.7 s）与 `chat-integrity.test.ts`「a chat whose header will not parse is left out of the list and named once」（CI 上报告两次，本地单跑绿）。要求：**不弱化**——比例测试改用与负载无关的量（扫描的字节数/行数计数，而不是墙钟），「只报告一次」先找出第二次报告从哪条路径来（两个读者同时扫到同一个坏文件？），修的是去重或时序，不是把 `1` 改成 `>= 1`。每条修法在 ledger 里写清楚第二次报告的来源。

---

## 交付与验收

每个 PR 合入前协调人会：跑一遍完整门禁；对 U1/U3/U5 在复制的数据目录上起宿主实测（RPC 直连 + `live-plugin-install-check.mjs` 类脚本）；核对 ledger 条目与 `docs/INFRASTRUCTURE-INTERFACES.md` §8 对应行是否同一 PR 更新。U4 只审设计稿。完成报告发给协调人时附：分支名、最终 commit、门禁输出、牙齿表、与任务单的偏离。
