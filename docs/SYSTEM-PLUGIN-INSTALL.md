# 系统插件安装路径：设计与落地记录

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。数字与路径以该提交为证据；行号会漂移，符号名不会。

## 本文与其他文档的关系

本文是**一条路径的两份东西**，合订在一起：

- **设计（§1–§11，2026-09-15 裁决）**——为什么这条路长这样：包格式、信任模型、两段式握手、
  存储布局与状态机、加载与激活、UI、安全不变量、分阶段交付、被否决的方案。这部分是**决策记录**，
  即使某段文字后来被代码推翻，它记着当初的理由，不删。
- **落地记录**——哪些 PR 落地、落地时代码在哪里推翻了设计。推翻之处就地标成「**PR-2 落地更正**」
  「**PR-3 落地更正**」或「U1/U5/U6」，而不是把原句改掉，因为「设计说 A、代码做了 B、理由是 C」
  三件事都要读得到。
- **§12 的五条裁决**原样保留，附每个 PR 的落地情况；裁决 2 后来被 U1 改口，改口连同它原本的理由
  一起留在那里。

| 要找什么 | 去哪 |
| --- | --- |
| 接口最终长什么样（权威形状） | [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §3 / §6 |
| 还有什么没做 | [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §8（唯一的缺口清单） |
| 生命周期与信任模型的裁决 | [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md) |
| 作者视角怎么用这条路 | [PLUGIN-AUTHORING-RUNBOOK](PLUGIN-AUTHORING-RUNBOOK.md)「安装一个系统插件包」 |

### 落地记录（哪些 PR，什么被推翻）

| 批次 | 内容 | 落地情况 |
| --- | --- | --- |
| PR-1 | 安装器泛化（`artifactContract` 注入点）+ `parsePluginManifest` / `PLUGIN_PERMISSIONS` | 已落地。§12 裁决 4 的权限词表在此实现 |
| PR-2 | 三个 RPC（preview/confirm/cancel）+ 预留的 `plugin.update`、`<profile>/system-plugins/` 布局、`system-plugins.json` v2、开机复核、命名失败状态、`SystemPluginView` 的三个可选字段。不含 UI | 已落地。推翻设计四处字段改名 + 一处删除（§5.1）、`commit` 改 `nullable`（§5.2）、`dev` 源不复制（§6）、v1 升级只给内置行补 `source`（§6）、卸载先删树后删行（§6） |
| PR-3 | PluginCenter：安装表单、同意页、`source` 徽标、失败状态文案、按 `source` 分叉的卸载文案 | 已落地。推翻设计五处（§8 开头逐条） |
| U1 | `plugin.update` 更新事务（`superseded/` 让位、`?gen=<treeHash>` 代际串、保留 `enabled`、失败回滚） | 已落地。**改口了 §12 裁决 2**（原裁决是「留位子不实现」） |
| U5 | 插件自带 en/zh 界面文案（清单 `iris.plugin.i18n`、`auditPluginCopy`、资产面下发） | 已落地。§3 的 `i18n` 字段与 §5.1 preview 的 `i18n?` 由它补上 |
| U6 | 安装器 userinfo 拒绝（§2 与 §9 #1–#3 一线）、子模块夹具测试（§9 #5）、插件中心资产状态列 | 已落地。§9 #5 的**保证边界**由它写明：flag 只有源文本断言 |

**两件仍开着的事**，记在 [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §8.1，不在这里重复：
已经写进现有 profile 的凭据 URL 记录没有清洗；`--no-recurse-submodules` 只有源文本断言守着。

它回答的是 [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)「Trust model (信任模型)」曾经留下的那个公开问题——**同权宿主代码的安装源受什么约束**——那个问题现在是答完的，答案就是本文 §4 与 §12。

裁决人：项目 owner，2026-09-15。

---

## 1. 目标与非目标

**目标**

1. 让一个仓库外的 Node 系统插件能被装进某个 profile，并走 §2 已经存在的那一套目录、依赖、启停、卸载——不是第二套生命周期。
2. 把信任控制放在**安装源**和**用户的明确动作**上，而不是放在一个不存在的运行时沙盒上。
3. 把「哈希锁定」从提案变成这条路径上的事实：记录**字节**，每次开机复核，不符就不激活。
4. 失败状态全部有名字，能在 PluginCenter 里被看见并被处置。

**非目标（本轮明确不做，理由见 §11）**

- npm registry 安装、任意 tarball URL 安装。
- 任何形式的自动更新或后台升级检查。
- ~~同 id 换 commit 的**更新**事务~~（`Installer` 对已装 id 答 `already-installed`）。本轮的路径是「卸载后重装」。
  **——U1 改口并实现**：更新事务现在存在，见 §5.4 与 §12 裁决 2 的改口段。删除线保留，因为 §5.4 的
  设计（让位目录、代际串、保留 `enabled`）只有对着这条原始非目标才读得懂。
- 给系统插件加运行时沙盒。裁决 1 已经排除。
- 给插件任何新的宿主能力接口。**——这条也被后来的批次超过了**：`scope.storage`（U3）与
  `scope.variables.registerWriter`（U2）已经存在，`scope.settings` 与生成钩子仍然不存在
  （[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §8）。本轮**自己**没有加任何能力接口，
  这一点没变。

---

## 2. 设计写作时的现状（基线 `8552c4b`，2026-09-15）

**本节是历史断面，不是 `e356771` 的现状。** 它记录设计是站在什么地基上写的；下面每个表格后
都标了它在 `e356771` 上变成了什么。要读现状去
[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md)。

**先记三处当时代码与文档不一致的地方**，按「代码赢」处理：

1. 安装器**不在** `packages/iris-compat-st-extension/src/host/`，而是独立包 `packages/iris-extension-installer/`（当时是 `archive` / `hash` / `installer` / `lock` / `recovery` / `source` / `staging` / `transaction` 八个模块；PR-1 之后多一个 `artifact-contract.ts`，加上 `index.ts` 共十个文件）。ST 兼容包只是它的使用方之一；[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §7「安装源」一行指的就是这个包。
2. [PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5 提到「`docs/SYSTEM-PLUGINS.md` 给第三方扩展清单 `iris.apiVersion` 的规矩」——**该规矩不存在**。`iris.apiVersion` 这个字符串在整棵树里只出现在那一句话里。本文的 §3 是第一次真正定义它（以 `iris.plugin.apiVersion` 的名字），所以那句话是**预告**而不是引用。
   **`e356771` 上**：§3 已经是代码，`PLUGIN-CONTRACT-PACKAGING` §5 的那句交叉引用也已改指本文 §3。这条不一致关闭。
3. **没有一个统一的 `plugin.*` id 文法**，树上同时有四条，且互不相等：
   - 协议线上：`z.string().min(1).max(200)`，任意字符；
   - 运行时目录：1 到 200 个字符（`adoptDefinition`）；
   - 资产路由：`safePluginId` 再加「无路径分隔符、无控制字符」；
   - 安装器：`EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/`（`packages/iris-extension-installer/src/lock.ts:28`），理由写在拒绝消息里——**id 会变成目录名**。

   四条里只有最后一条对「id 是目录名」这件事负责，所以 §3 选它。
   **`e356771` 上**：四条仍然并存，本文没有收紧协议那条——§3 选最严的一条是**在安装路径上**收紧，
   其余三条自动被满足，协议不动。这不是遗留缺口，是当时的选择。

### 系统插件今天有什么

| 项 | 当时（`8552c4b`）的事实 | `e356771` 上变成了什么 |
| --- | --- | --- |
| 契约 | `SystemPluginDefinition` 与 `SystemPluginActivationScope`。scope 上只有 `context`/`pluginId`/`revision`/`provide`/`getDependency`/`registerRpc`——**六个成员** | scope 有**八个**成员：多了 `variables`（U2）与 `storage`（U3）。§9 #16 的那条不变量随之改口，见该节 |
| 入口 | 两条：`BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`（只有 `tavern-helper` 与 `mvu`）与 `SystemPluginRuntime.adoptDefinition` | 三条：本文这条包安装路径是第三条 |
| `plugin.install` 不装东西 | 它只把目录里已有的一行翻成 `installed: true`，不下载、不写树 | 未变。真正装东西的是 `plugin.previewInstall` / `plugin.confirmInstall` |
| 持久化 | profile 根下 `system-plugins.json`（`packages/iris-app-service/src/index.ts:788`），形状 `{ version: 1, revision, plugins: { <id>: { installed, enabled } } }` | v2，见 §6 |
| 投影 | `SystemPluginView`，`status` 是六值闭合集，错误只有一个自由文本 `error?: string` | `status` 仍是六值；另加 `source?`/`provenance?`/`failure?` 三个可选字段，`failure.state` 是**七值**（U2 的 `hook-failed` 是第七个） |
| 浏览器面 | `PluginAssetStore` 从 `<dataDir>/system-plugins/<id>/client/` 供 `client.js`，`?rev=` 命中才 immutable，停用即 404 | 同一套规则另服务 `<id>/i18n/<lang>.json`（U5） |
| 帧侧成员 | `scanPluginMemberNames`（`apps/iris-web/src/app/use-plugin-manifest.ts:217`）只收 `registerPluginMembers` 调用里**字面量** id 与**字面量**对象键；重名由 `findMemberConflicts`（`:360`）报 `conflict` | 未变 |
| 拒跑粒度 | **按插件，不按帧**：核心表缺席才整帧拒跑，单个插件没跑完只拒该插件并点名（`apps/iris-web/src/sandbox/plugin-members.ts:13`） | 未变 |

**当时没有的东西**：没有 npm 名、没有 Git URL 能装一个 Node 系统插件；没有 `scope.storage` / `scope.settings` / 生成钩子；插件不能注册设置槽；契约包仍是 `private`/`0.0.0`。
**`e356771` 上**：git 与 dev 两条源有了（本文），`scope.storage` 有了（U3），`scope.settings`、生成钩子与设置槽贡献仍然没有；契约包的工作区形**仍是** `private`/`0.0.0`，发布形由 `npm run pack:contracts` 另外生成（[PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5）。

### ST 扩展这条路已经有什么（本提案要复用的全部资产）

| 能力 | 符号与位置 |
| --- | --- |
| 源校验 | `validateExtensionSource` / `assertPinnedCommit`（`packages/iris-extension-installer/src/source.ts:100`、`:133`）：https 限定、40 位十六进制 commit、URL 含空白或引号直接拒、URL 的 userinfo 里带凭据直接拒（检查在 pin 之前，`file://` 权威段里的 userinfo 同样拒；两条安装路径共用，是对 ST 的有意偏离，见 app-service ledger §85） |
| git 执行 | `materializeGit`（`packages/iris-extension-installer/src/source.ts:218`）：固定 argv、不过 shell、每次 `-c core.hooksPath=`、`--depth 1 --no-recurse-submodules --no-tags`、checkout 后 `rev-parse HEAD` 必须等于钉住的 commit |
| 事务状态机 | `InstallPhase`：`downloading → staged → validated → hashed → promoting → installed`，失败是唯一旁路（`packages/iris-extension-installer/src/transaction.ts:18`） |
| 树哈希 | `hashTree`（`packages/iris-extension-installer/src/hash.ts:30`）：逐文件 sha256，再对**按正斜杠相对路径字节序排序**的 `相对路径\0文件哈希\n` 行求 sha256；遇 symlink/junction 直接抛 |
| 安全审计 | `guardEntryName` / `copyTreeGuarded` / `auditContainment`（`packages/iris-extension-installer/src/archive.ts:59`、`:262`、`:303`）与 `DEFAULT_EXTRACT_LIMITS`（`:48`） |
| 原子落地 | staging 里做完一切，只有一次 `rename` 碰目标目录，然后写 lock；无 lock 的目标目录不是安装（`packages/iris-extension-installer/src/installer.ts` 的 `promote`、`recoverInstallations` 在 `packages/iris-extension-installer/src/recovery.ts:46`） |
| 锁记录 | `InstalledExtensionLock`（`packages/iris-extension-installer/src/lock.ts:15`）：`extensionId`/`source`/`resolvedCommit`/`artifactSha256`/`installedAt`/`enabled`，且 `enabled` 必须**恰好是 `false`**（`:71`）——安装器从不启用 |
| 安装位置 | `<profile>/st-extensions/`（`packages/iris-app-service/src/paths.ts:307`），布局是 `staging/ claims/ installed/<id>/` |
| 卸载语义 | **保留安装树与设置文件**；同 id 再装是「重装 = 重新接纳」，由 `installedTreePresent` 判定（`packages/iris-app-service/src/st-reinstall.ts:18`） |

也就是说：**本提案 90% 的机械部分已经写好并有测试**。缺的是「装的是一个 Node 插件而不是一个 ST 扩展」这件事本身，加上开机复核与同意步骤。

---

## 3. 包格式与清单

一个系统插件包是**一个目录**，根部有 `package.json`，其中带一个 `iris.plugin` 块：

```jsonc
{
  "name": "iris-plugin-demo",
  "version": "0.3.1",
  "iris": {
    "plugin": {
      "id": "demo",                        // 必填，见下
      "apiVersion": 1,                     // 必填，整数
      "host": "host.js",                   // 必填，相对树内路径
      "client": "client.js",               // 可选
      "i18n": { "en": "i18n/en.json", "zh": "i18n/zh.json" },  // 可选，两份都必须在
      "displayName": "Demo",               // 必填
      "description": "…",                  // 必填
      "capabilities": ["demo.state"],       // 可选，仅声明（插件提供什么）
      "permissions": ["provide-capability", "register-rpc", "write-variables"],  // 可选，闭合词表（插件声明用什么；闭合词表见 §12 裁决 4；`e356771` 上是六个名字）
      "dependencies": ["tavern-helper"]     // 可选，其他插件 id
    }
  }
}
```

- **`id`** 用安装器那条文法：`/^[a-z0-9][a-z0-9._-]{0,63}$/`（`packages/iris-extension-installer/src/lock.ts:28`）。理由不是「已经有人这么写」，而是 id 在这条路上同时是**目录名**（`<profile>/system-plugins/<id>/`）、**URL 段**（`/plugins/<id>/client.js`）和**目录主键**。协议那条 `min(1).max(200)` 不对目录名负责，不能当文法用；`safePluginId` 是路由的下界而不是安装的上界。四条文法里选最严的一条，其余三条自动被满足，这是**收紧而不是放宽**，不需要改协议。
- **`apiVersion`** 与 `SystemPluginDefinition.apiVersion` 是同一个数字，也与契约包的 npm major 对齐（[PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5：`apiVersion: 1` ↔ major `1`，预发布用 `1.0.0-alpha.N`）。宿主声明自己支持的区间（当前只有 `[1, 1]`）；不在区间内**不是崩溃**，是命名状态 `incompatible`，行留在目录里、不激活、PluginCenter 说明「此插件需要 apiVersion N，本机支持 1」。
- **`host`** 是一个普通 ESM 模块，**默认导出一个 `SystemPluginDefinition` 对象**，不是工厂。理由：目录里另外两条入口拿的都是 definition——`BUILTIN_SYSTEM_PLUGIN_DEFINITIONS` 是 definition 数组，`adoptDefinition(raw, …)` 收 definition。选工厂就要定义「工厂在哪个上下文里跑、能不能异步、抛错算 `load-failed` 还是 `activate-failed`」，凭空多出一个生命周期阶段，而它能做的事 `activate` 都能做，且 `activate` 已经有 lease、fiber 和失败回滚。用 `import(pathToFileURL(...))` 加载；模块顶层抛错是 `load-failed`，默认导出形状不对是 `manifest-invalid`（字段 `host`）。
- **`client`** 走已有的资产面：激活时把它复制/链接到 `<dataDir>/system-plugins/<id>/client/client.js`（ST 那条路现在就是往这个位置写代理 bundle，`packages/iris-app-service/src/index.ts:910`），于是聚合清单自动长出一行。对它的要求就是 `scanPluginMemberNames` 的要求：`registerPluginMembers('<字面量 id>', { 字面量键: … })`——**id 必须是字符串字面量、成员键必须是字面量**，计算键和间接注册一律扫不出来（`apps/iris-web/src/app/use-plugin-manifest.ts:217`）。扫不出来不是报错，是「这个插件不声明成员」；真正的拒绝发生在重名（`conflict`）与帧内没跑完，且**都是按插件拒的，不是按帧**（`apps/iris-web/src/sandbox/plugin-members.ts:13`）。
- **`i18n`** 是插件**自带的界面文案**：两个相对树内路径（en、zh 各一份平坦的 `键 → 字符串` 表）。一旦出现，两个键都**必须**在，缺哪个拒绝的 `field` 就点哪个（`i18n.en` / `i18n.zh`）。路径走与 `host`/`client` 同一条文法与 `resolveTreePath`；**内容**在 artifact contract 里审计（`auditPluginCopy`）——可读、单份 ≤ 256 KiB / 2,000 条（`PLUGIN_COPY_LIMITS`）、JSON 对象、键语法 `[a-zA-Z][a-zA-Z0-9]*`，然后是与壳的 `i18n.test.ts` 同源的三条双语规则（键集合相等、zh 含中文、`{槽位}` 集合一致，规则实现只有一份，在 `@iris/text`）。文件随 `client.js` 一起发布到 `<dataDir>/system-plugins/<id>/i18n/<lang>.json`，走同一条资产面；开机重发布时若 `JSON.parse` 失败则只点名该语言并继续发布其余部分——文案坏不该让能跑的插件下线。
- **`capabilities`** 本轮**只用于同意步骤的展示**，不做运行时校验——宿主没有能力注册表可以校验它（`scope.provide` 的名字是运行时字符串）。这一点必须写在 UI 上，否则它读起来像一个权限系统。
- **`dependencies`** 直接喂给 definition 的 `dependencies`，由已有的 DFS 拓扑序、成环拒绝、被依赖拒删接管。

包里**不允许**有 `node_modules`（见 §9 的尺寸与符号链接不变量），也不会被执行任何安装脚本——安装器从不跑 artifact 里的东西，这是它的既有不变量（`packages/iris-extension-installer/src/installer.ts:11` 的模块注释）。

---

## 4. 安装源与信任模型

裁决 1：**系统插件是与宿主同权的 Node 代码**，`activate` 在宿主进程里拿到宿主的全部触达能力。没有沙盒。限制风险的是**代码从哪来**和**用户是否明确同意**。

由此，`permissions` 的默认读法是**声明而非边界**（§12 裁决 4）：宿主校验拼写、在同意页展示，不据此收回任何触达。`plugin-storage` 是这条规则的**第一个例外**（U3）：插件私有存储是宿主**提供的服务**而不是插件本来就有的触达，宿主能真的不给——清单没声明 `plugin-storage` 的插件，`scope.storage` 四个方法各抛点名 `invalid-request`。它挡的只有这一件事：挡不住同权插件用自己的 `fs.writeFileSync` 写同一个目录，那不是它的对手盘。为什么先给存储开口而不是别的：存储是插件最普遍的落盘需求，宿主侧的边界（键语法 + resolve 前缀、原子写、坏文件隔离、双上限）已经成立，见 `packages/iris-app-service/src/plugins/storage.ts` 与 [PLUGIN-AUTHORING-RUNBOOK](PLUGIN-AUTHORING-RUNBOOK.md) 的「插件私有存储」一节。

本轮三种源，按优先级：

| 源 | 状态 | 约束 |
| --- | --- | --- |
| `builtin` | 已存在 | 本仓库源码，随 Iris 发行 |
| `git` | 本提案新增 | **仅 https，必须钉完整 40 位 commit**，无主机白名单 |
| `dev` | 本提案新增 | 本地目录，在 `system-plugins.json` 和 PluginCenter 行上都**显式标 `dev`** |

**为什么 git 不设主机白名单**：卡片代码有一份两主机白名单（`REMOTE_ALLOWLIST = ['*.jsdelivr.net', 'raw.githubusercontent.com']`，`apps/iris-web/src/sandbox/policy.ts:77`，宿主侧每跳由 `checkScriptFetch` 复核），因为卡片是**内容**——用户打开一张卡时并没有在选择运行谁的代码。系统插件相反：用户是在**主动选择运行同权代码**，这与他敲 `npm install` 是同一类动作，而白名单在这里只会制造安全错觉（GitHub 上任何人都能放任何东西，白名单里恰好就有 `raw.githubusercontent.com`）。所以补偿控制不是白名单，而是**同意步骤**（§5）：在 `activate` 跑之前，把远端 URL、commit、清单声明的 capabilities 与 dependencies、以及**是否带 `client.js`** 摆到用户面前。

**为什么记录字节而不只是 URL**：[PLUGIN-FEASIBILITY](../notes/PLUGIN-FEASIBILITY.md) §8 问题 1 里的「哈希锁定」在今天的树上是**提案而不是描述**——卡片那条路哈希的是 **URL**，作为缓存文件名（`cacheKey`，`packages/iris-app-service/src/script-cache.ts:217`），不是字节。本提案让它在系统插件这条路上成为事实，并且**不改卡片那条路**：卡片仍然按 URL 缓存，这个差异保留并在此写明。

**规范遍历**就是 `hashTree` 已经实现的那一个（`packages/iris-extension-installer/src/hash.ts:30`），本文只是把它提升为契约：按正斜杠相对路径**字节序排序**，逐行 `相对路径\0sha256(文件字节)\n`，对拼接结果取 sha256；目录不入行、空目录不影响结果；遇到 symlink/junction 直接抛（哈希过的树就是审计过的树）；`.git/` 不参与——因为它在哈希之前就被删掉了（`packages/iris-extension-installer/src/installer.ts:197`，理由：clone 本地数据会让同一 commit 在两台机器上算出不同的 sha256）。`dev` 源额外跳过 `node_modules/`？**不跳**：dev 树本来就不允许有 `node_modules`，跳过等于默许它存在。

---

## 5. 安装流程

两段式握手。preview 把树**装进 staging 并停下**，confirm 才促进（promote）。这样同意页上显示的哈希就是即将安装的那棵树的哈希，而不是一次「再拉一遍、希望还一样」。

### 5.1 `plugin.previewInstall`

**PR-2 落地更正（四处字段改名，一处字段删除）**。落地形状以
`packages/iris-protocol/src/rpc.ts` 的 `requestSchemas` 与
`packages/iris-protocol/src/system-plugins.ts` 的 `SystemPluginInstallPreview`
为准；本节改写成落地形状，被改掉的地方逐条记在这里，理由见
`notes/packages/iris-app-service/DEVIATIONS.md` §80：

- 请求里 `repository` → `remote`，`directory` → `path`：目录行、`provenance`
  与 `system-plugins.json` 的 v2 键（§6）用的都是 `remote`/`path`，请求用第二套
  名字只会让 UI 在两组名字之间来回翻译。
- 返回里 `transactionId` → `previewToken`，`files`/`bytes` →
  `fileCount`/`sizeBytes`：前者是因为这个值对调用方只是**一张同意票据**，叫
  `transactionId` 会诱导调用方以为它可以拿去查事务；后者只是说清单位。
- 返回里 `apiVersion` 从 `number` 改成**归一化后的 `major.minor` 字符串**
  （整数写法 `1` 读作 `'1.0'`），与 PR-1 的 `SystemPluginManifest.apiVersion`
  一致；另加 `supportedApiVersions`，这样「需要 N，本机支持 1.0–1.0」这句话
  不用 UI 自己拼。
- **`clientMembers` 删除。** 扫成员的是 `scanPluginMemberNames`
  （`apps/iris-web/src/app/use-plugin-manifest.ts:217`），它是浏览器侧模块，
  app-service 不能 import 它而不把整个 web 应用拖进来。成员扫描与重名拒绝本来
  就发生在帧里、而且**按插件不按帧**
  （`apps/iris-web/src/sandbox/plugin-members.ts:13`），所以宿主只报
  `hasClient`，成员名留给读它的那一侧。

```ts
'plugin.previewInstall': z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('git'),
      remote: z.string().min(1).max(2000),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
    }),
    z.object({ kind: z.literal('dev'), path: z.string().min(1).max(1000) }),
  ]),
})
```

返回：

```ts
interface SystemPluginInstallPreview {
  previewToken: string             // 已有事务 id，阶段停在 'hashed'
  id: string                       // 清单里的 iris.plugin.id
  displayName: string
  description: string
  version: string                  // package.json 的 version
  apiVersion: string               // 归一化的 major.minor
  compatible: boolean              // apiVersion 是否在宿主区间内
  supportedApiVersions: string     // 本机区间，形如 "1.0–1.0"
  source: 'git' | 'dev'
  remote?: string                  // git 的远端
  commit?: string                  // git 的 resolvedCommit（== 请求里的 commit）
  path?: string                    // dev 的绝对目录
  treeHash: string                 // 64-hex，规范遍历的结果
  fileCount: number
  sizeBytes: number
  capabilities: string[]
  permissions: string[]            // 闭合词表，见 §12 裁决 4：展示与拼写校验，不是边界
  dependencies: string[]
  hasClient: boolean               // 是否带 client.js
  i18n?: { keys: number, languages: string[] }  // 自带文案：两列合计条数与语言（缺省 = 没带）
  warnings: string[]               // 「声明的 dependency 不在本机目录里」「id 已被占用」
}
```

宿主侧顺序，全部复用既有阶段：`materializeSource` → （git）删 `.git` → 读 `package.json` 与 `iris.plugin`（形状不对即 `manifest-invalid`，带字段名）→ **自带文案的内容审计也在 artifact contract 里跑**（`auditPluginCopy`，发生 在 `hashTree` 之前——contract 是 `hashed` 之前唯一的内容检查点）→ `auditContainment` → 尺寸与文件数上限 → `hashTree` → 事务停在 `hashed`。**preview 不加载 `host.js`，不执行任何 artifact 内代码。**

### 5.2 `plugin.confirmInstall`

```ts
'plugin.confirmInstall': z.object({
  previewToken: z.string().min(1).max(200),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  treeHash: z.string().regex(/^[0-9a-f]{64}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),   // dev 源写 null
})
```

**PR-2 落地更正**：`commit` 是 `nullable` 而不是 `optional`。`optional` 会让
「忘了回带 commit」和「这是 dev 源，本来就没有 commit」在线上长成同一个请求，
而这两件事在促进前的比对里必须是两个答案。

返回 `SystemPluginSnapshot`，与其余 `plugin.*` 一致。

促进前逐条比对：事务存在且阶段恰为 `hashed`；`id`、`treeHash` 与事务记录一致；git 源的 `commit` 与 `resolvedCommit` 一致。**任何一条不符就整体拒绝并丢弃事务**——这正是「树变了就不能被一张过期的预览批准」这句话在代码里的样子。比对通过后：取 claim → `rename` 到 `<profile>/system-plugins/installed/<id>/` → 写 lock → 事务转 `installed` → 写 `system-plugins.json` 的新行（`installed: true, enabled: false`）→ `adoptDefinition`。

**注意 `enabled` 仍然是 `false`**：安装不是启用，这是 lock 记录用「`enabled` 必须恰好是 `false`」钉住的既有不变量（`packages/iris-extension-installer/src/lock.ts:71`）。用户在 PluginCenter 里另点一次「启用」，那才是 `host.js` 第一次被 `import` 的时刻。

### 5.3 同意时序

```
用户填 URL + commit
      │
      ▼
plugin.previewInstall ──► staging 里落树、算哈希、读清单 ──► 停在 hashed
      │
      ▼
PluginCenter 同意页：远端 / commit / treeHash / capabilities / dependencies
                     / 是否带 client.js / 成员名 / 体量 / apiVersion 是否兼容
      │  （用户取消 ⇒ plugin.cancelInstall(transactionId)，删 staging）
      ▼
plugin.confirmInstall（回带 id + treeHash + commit）
      │
      ▼
促进 → 写 lock → 目录多一行（installed, 未启用）
      │
      ▼
用户另点「启用」 ⇒ 复核 treeHash ⇒ import host.js ⇒ activate
```

第三个 RPC `plugin.cancelInstall({ previewToken })` 是必要的：没有它，一次被放弃的预览会把 staging 和 claim 留到下次 `recoverInstallations` 才清（`packages/iris-extension-installer/src/recovery.ts:46`），而那是**崩溃恢复**机制，不该被当成正常退出路径用。

**更新分支（U1，2026-09-15 第二批）**：时序同一条路，入口换成 `plugin.update({ id, commit })`——remote 从行上的 provenance 读，不作为参数。preview 多带 `updateOf`（被替换的行、行上现记的 commit 与 treeHash），同意页多一行「从哪个 commit 更新到哪个」。confirm 仍是 `plugin.confirmInstall`，回带的四个值一个不加。

### 5.4 更新事务（U1）

`plugin.update({ id, commit })` 把一条已安装的 `git` 行更新到一个新 commit，走**同一条 preview 路**（staging、artifact 契约、包含性审计、哈希、清单），返回带 `updateOf` 的 `SystemPluginInstallPreview`。`dev` 行与 `builtin` 行答 `unsupported`（dev 就地加载，改文件即生效；builtin 随 Iris 本体发布）；不存在的 id 答 `not-found`；行上没有完整 git provenance（remote/commit/treeHash 任一缺失）答 `install-failed`。新 commit 改了包 id 的，丢弃整个 staging 并拒绝——更新替换一行，不给它改名的权力。

**「这是一次更新」由服务端的事务记录判定，与回带无关**（`PendingPreview.updateOf`，`packages/iris-app-service/src/plugins/install.ts`）。普通安装的 preview 对已占用 id 只给 warning 不拒绝，所以若更新与否由 echo 决定，一次普通 `previewInstall` 配一个声称自己是更新的 confirm 就把裁决 5 绕过去了。confirm 的更新分支先核目标行：它必须还在、还是 `git`、还记着 preview 铸造时的那个 `(commit, treeHash)`——用户同意的是「把这一行从 A 换到 B」，不是「装一个新的 B」；预览之后行被卸载或被换过，整体拒绝并丢弃事务。

替换事务本身（全部成功才提交，旧树的删除在最后一步）：

1. 记下 `wasEnabled`；开着就先 `disable`（drain + dispose，Windows 上被 `import()` 过的目录可能改不了名，旧代的 fiber 也还持着 lease）；
2. 旧树改名让位到 `<installRoot>/superseded/<id>.<8hex>/`——**必须在 promote 之前**：安装器的 `already-installed` 检查读的就是 `installed/<id>/` 里的 lock，rename 的目标非空也会失败；改名是同卷原子操作，lock 随树一起走，`superseded/` 是 `installed/` 的**兄弟目录**而不是它下面的一个名字，否则崩溃恢复扫描会把让位的树当成一个插件看；
3. `promote` 到同一个 `installed/<id>/`；
4. 浏览器包跟着新清单走：新清单有 `client` 就覆盖发布（`rev` 是文件字节的哈希，缓存自然失效），没有就把旧包的删掉——文件留着就还会被列进清单、被浏览器加载；
5. `replaceInstalled` 换目录行的定义与 provenance：`installed`/`enabled`/`status` 不动，「更新保留 `enabled`」就是在这一步实现的；行上钉着的旧字节裁决（如 `tampered`）随定义一起退役——新树刚被重新哈希过，旧裁决针对的字节已经不在了；
6. `wasEnabled` 就重新 `enable` 新代。新代的 `import()` 带 `?gen=<treeHash>` 代际串：Node 的 ESM 注册表按 URL 字符串缓存（2026-09-15 探针实测，见 ledger §81），同一个 `host.js` 路径换了字节，不带代际串就会无声地跑旧模块——这是整条路上**唯一没有症状的失败**；
7. 最后才删 `superseded/` 下的旧树，尽力删、删不掉按名记日志（本仓库目录里递归 rm 可能静默无效——`scripts/pack-contracts.mjs` 的教训），删不掉不影响正确性。

第 2 步之后任何一步失败走回滚：新树让位（`.failed` 后缀，尽力删）、旧树改名回位、目录行与浏览器包复原（旧清单可读时连定义一起恢复）、`wasEnabled` 就回到旧代。回滚成功时**行上不留 `failure`**——行回到了它原来的样子（原来开着的行必须读作开着），失败的名字在抛出的错误里（`state` 取实际发生的 `load-failed`/`activate-failed`，reason 带「已回到旧代 `<fromCommit>`」）。回滚自己再失败才是另一回事：那时行确实坏了，走既有的 `#setFailure`，消息里说明旧树现在在哪个目录。第 2 步与第 3 步之间断电，行会被下次开机的扫描标成 `install-failed`（既有行为），`superseded/` 下躺着一棵完好的旧树，可以按目录名手工放回 `installed/<id>/`。

新 commit 与行上现记的 commit 相同是**允许**的（preview 的 `warnings` 会写明），对 `tampered` 行来说「按记录再取一遍」正是裁决 3 要的修复语义；`tampered`/`incompatible` 行可以被更新——整棵树按 (remote, commit) 重新取、取完重新哈希，不是「接受当前字节」。因此裁决 3 的重装按钮与 U1 的更新入口在 `tampered` 行上并存，两条路都走完整同意。

---

## 6. 存储与状态机

**位置**：`<profile>/system-plugins/`，布局与 ST 那份一致（`staging/ claims/ installed/<id>/`）。落地常量是
`ProfilePaths.systemPluginPackages`（`packages/iris-app-service/src/paths.ts:329`，构造在 `profilePaths()`），安装树在
`<profile>/system-plugins/installed/<id>/`——**注意是 `installed/<id>/` 而不是 `<id>/`**：布局是安装器的，
不是本文新发明的。

**U1 增补（`superseded/`）**：更新事务把被替换的旧代改名让位到
`<profile>/system-plugins/superseded/<id>.<8hex>/`，新代启用成功后删除。它是 `installed/` 的**兄弟**目录，
理由有二：崩溃恢复的扫描把 `installed/` 下每个条目当作一个 extensionId 看（`packages/iris-extension-installer/src/recovery.ts:146`），
没有合法 lock 的就清掉——让位的树带着 lock 一起改名，放进 `installed/` 里它既不会被清、还会被当成一个装好的插件；
放进兄弟目录，这两件事都不会发生，人看目录时也一眼知道那是什么。同卷 rename，仍然是原子的。

**PR-2 落地更正（`dev` 源不复制）**：只有 `git` 源会被促进进 `installed/<id>/`。`dev` 源**进 staging 只为
过一遍同样的 artifact 契约、包含性审计与哈希**，confirm 时把 staging 丢掉，目录行记下用户自己的绝对路径，
`host.js` 直接从那里 import。理由就是 §7 第 2 条自己写的那句「dev 源跳过复核（它的树本来就在被编辑）」——
一棵被复制进安装根的树不是「正在被编辑的那棵树」，复制之后这条源就不再是「按发行版调试插件」的路，
而只是一条更麻烦的本地安装。代价就是裁决 1 已经接受的那一条：发行版里存在一条无字节校验的同权装载路径。

与 ST 的 `<profile>/st-extensions/`（`packages/iris-app-service/src/paths.ts:307`）**分开**，理由有两条且都不是洁癖：一是两者的 artifact 契约不同（ST 树要有 `manifest.json` 且 `js` 必须存在——当时的 `requireManifest`，现为注入的 artifact 契约；插件树要有 `package.json` 的 `iris.plugin`），混在一个 `installed/` 下就要在扫描时靠试探区分；二是 id 命名空间不同，ST 的 id 是 `display_name` 的 slug，插件的 id 是作者写的，撞名时不该是先到先得。

注意 `<dataDir>/system-plugins/` 这个名字**已经被占用**了：它是资产面的 client bundle 根（`packages/iris-app-service/src/index.ts:1451` 的注释、`packages/iris-app-service/src/plugin-assets.ts:113` 起的 rev 备忘录注释），而且是 dataDir 级不是 profile 级。本提案的安装树在 **profile** 下。同名不同层是一个真实的踩坑点，实现时两个常量都要带注释指向对方。

**`system-plugins.json` 形状**

之前：

```jsonc
{ "version": 1, "revision": 7, "plugins": { "mvu": { "installed": true, "enabled": true } } }
```

之后：

```jsonc
{
  "version": 2,
  "revision": 7,
  "plugins": {
    "mvu":  { "installed": true, "enabled": true, "source": "builtin" },
    "demo": {
      "installed": true, "enabled": false, "source": "git",
      "remote": "https://example.invalid/acme/iris-plugin-demo.git",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "treeHash": "…64 hex…",
      "installedAt": "2026-09-15T02:11:04.912Z"
    }
  }
}
```

版本**升到 2**，而不是「加可选键、保持 1」。后者读起来更平滑（现有的 `validPreference` 本来就容忍多余键），但方向是错的：旧版 Iris 读到一个 v1 的文件会照常激活，包括那些它根本不会复核 `treeHash` 的行。升到 2 之后，旧版读不懂，走的是既有的「读不动即全体停摆、保留原文件、全部置 `error`」路径——对一个安全特性来说，**拒绝一切**是安全的那个方向。新版读 v1 文件就地升级。

**PR-2 落地更正（升级只给内置行补 `source`）**：上一句原本写的是「所有行补
`source: "builtin"`」，落地时改成**只给本次构建自己注册的内置定义补**。一个 v1 文件里也可能有被
`adoptDefinition` 接纳进来的 ST 扩展行，而那不是内置的；把它标成 `builtin` 就是在「这些字节从哪来」
这个唯一负责回答该问题的字段里写一句假话。其余行升级后**不带 `source`**——这个字段是可选的，
正是为了让「本机对这一行没有来源记录」说得出口，开机扫描找到树时再补上。落地行为由
`packages/iris-app-service/tests/system-plugins.test.ts`「startup repairs and persists an enabled dependency
closure at the boot revision」钉住（它的两条 `deepEqual` 一条有 `source`、一条没有）。

**另一条落地事实**：`parseStored` 接受的版本是**闭合集 `{1, 2}`**，别的一律走「读不动」那条路。
旧读者拿到 v2 会走同一条路，这一点在本树里已经不能直接执行了（v1 读者的代码没了），能执行的是它的
另一半：给一个 version 9 的文件，全体 `error`、原文件保留、`enable` 被拒。

**状态机**（目录行的视角）

```
                  ┌──────────────────────────────────────────┐
  (preview)       │                                          │
      ├─► 拒绝: install-failed / manifest-invalid            │
      └─► hashed ──confirm──► not-installed?  否 ──► installed(disabled)
                                                        │
                        enable ─── treeHash 复核 ────────┤
                                    │ 不符              │ 相符
                                    ▼                   ▼
                                 tampered          import host.js
                                                        │ 失败 ─► load-failed
                                                        ▼
                                                    activate()
                                                    │ 失败 ─► activate-failed
                                                    ▼
                                                  enabled
                                                        │ disable
                                                        ▼
                                                  installed(disabled)

  boot: 对每个 installed 行先复核 treeHash，不符 ⇒ tampered 且不激活
  apiVersion 不在区间 ⇒ incompatible（任何时刻都不进入 enabling）
  uninstall ⇒ 目录行移除 + 安装树删除（见下）
```

**卸载删树**。这一条**与 ST 现行行为不同**，是有意的。ST 那边保留安装树与设置文件，理由写在 `packages/iris-app-service/src/st-reinstall.ts:1` 起的注释里：artifact 和设置是用户数据，同 id 再装是「重装」。对系统插件不成立——插件树里没有用户数据，它是**从一个可复现的 (remote, commit) 拉下来的只读产物**，随时能原样再拉一次；而留着它意味着一棵同权代码树在用户以为自己已经删掉之后继续躺在磁盘上，并且下次同 id 安装时会碰上 `already-installed`。所以：卸载删树，**但保留偏好行以外的业务数据**（变量、聊天）不变，这一点与现有卸载语义一致。`dev` 源例外：`dev` 的「树」是用户自己的工作目录，卸载**绝不**碰它，只删目录行。

**PR-2 落地补充（删除顺序与目录行）**：先删树、后删目录行。中间崩溃会留下一条树已不在的目录行，
下次开机把它命名为 `install-failed`，用户看得见也能再卸一次；反过来（先删行）中间崩溃会留下一棵没有
目录行的树，而开机扫描会把它重新接纳——用户刚删掉的插件自己回来了，且无声。此外，本轮安装进来的行在
卸载时**整行移除**（不是 `installed: false`），因为树已经没了、id 也必须腾出来给重装；内置行与
ST 接纳进来的行的卸载语义**一个字没改**（`SystemPluginRuntime` 里以 `removable` 区分）。

**W5 补充（可选「连数据一起删」）**：卸载默认**保留** `<profile>/plugin-data/<id>/`（§12 裁决 1）。
`plugin.uninstall` 新增可选 `removeData?: boolean`，默认 `false`，旧客户端发 `{ id }` 行为零变化；
为 `true` 时宿主在卸载事务里删除该插件的私有数据目录，用的是与安装树同一套**改名让开再尽力删**
（本机 Node 在仓库目录内递归删除会静默无效，见 `scripts/pack-contracts.mjs` 的 clear 段与 §5.4 的
`superseded/`），删不掉时按名上报 `reportStoreProblem`，**行仍卸载成功**。内置插件**不做特例**——它们没
有 `source` 记录，但同样声明全部权限、同样能拿到 `scope.storage`（`#permissionsOf` 对内置行返回
`ALL_PLUGIN_PERMISSIONS`），所以 `removeData` 直接删 `plugin-data/<id>/`，不看 `record`。实测（2026-09-16）：
两个内置插件今天都没有调用 `scope.storage`，所以 8787 上它们的 `plugin-data` 目录不存在，这句话目前
是空操作；带 `removeData` 卸载一个从未写过数据的插件只是确认目录不存在。UI 侧的复选框数量来自行的
可选字段 `dataFootprint?: { files, bytes }`（`plugin.list` 每次测量），无数据的行不显示复选框。

---

## 7. 加载与激活

1. **开机扫描**：遍历 `<profile>/system-plugins/installed/`，对每个有 lock 的目录读 `package.json`。这一步只读清单，不 import。
2. **复核**：`hashTree` 重算，与 `system-plugins.json` 里的 `treeHash` 比。不符 ⇒ 该行 `tampered`，**不激活**，其余插件照常。`dev` 源跳过复核（它的树本来就在被编辑），但 PluginCenter 行上永远标 `dev`。
3. **兼容**：`apiVersion` 不在宿主区间 ⇒ `incompatible`，不激活。
4. **接纳**：`adoptDefinition(definition, { installed: true })`。注意它对已知 id **返回 `false` 且静默跳过**（`packages/iris-app-service/src/system-plugins.ts:394`），所以内置 id 与安装 id 撞车时目前的行为是「安装的那个被忽略」——见 §12 问题 5。
5. **加载**：只有在**启用**时才 `import(pathToFileURL(join(installedDir, iris.plugin.host)))`。路径在拼之前必须过包含性检查（§9）。顶层抛错 ⇒ `load-failed`；默认导出不是合法 definition ⇒ `manifest-invalid`（字段 `host`）。
6. **激活**：definition 交给既有的 `enable` 路径——DFS 拓扑序、失败回滚、lease、fiber。`activate` 抛错 ⇒ `activate-failed`，走既有的「失败激活不得留下半注册能力」不变量。
7. **client**：若清单有 `client`，在接纳时把它放到 `<dataDir>/system-plugins/<id>/client/client.js`，其余由资产面接管（rev、404、清单行）。

**PR-2 落地更正（第 4 条与第 5 条的实现形状）**：目录行拿到的是一个**延迟 definition**——
id / name / description / version / dependencies 全部来自清单（读清单不执行任何东西），而
`activate` 里才 `import(pathToFileURL(host.js))`。于是「只有启用时才加载」不是一条纪律而是结构：
`adoptDefinition` 之后、`enable` 之前，`host.js` 从未被 import（测试用一个在模块顶层写标记文件的
`host.js` 断言标记不存在）。默认导出的运行期校验是三条——`id` 必须等于清单的 id、`apiVersion`
必须等于清单的 major、`activate` 必须是函数——任何一条不符是 `load-failed` 并点名字段；插件自己的
`activate` 抛错是 `activate-failed`。

**第 4 条的 id 撞车**：`adoptDefinition` 对已知 id 返回 `false` 并静默跳过这件事**没有变**，
变的是它够不到了——裁决 5 在 confirm 阶段就以 `install-failed`（id 已被占用）拒绝，所以不存在
「装进来但被忽略」的行。

**`tampered` / `incompatible` / `manifest-invalid` / `install-failed` 四个状态下的 `enable`**是拒绝
（`unsupported`，消息点名状态），不是「试一次再失败」：一个重新 import 树的重试，就是一次可能在
被篡改的字节上成功的启用。`load-failed` 与 `activate-failed` 不在此列——作者改完文件重试是 §8
给它们写的出路。

**契约包**：`host.js` 只 `import type` `@iris/plugin-api`，运行时被类型擦除，装出来的树里不需要也不应该有 `@iris/*` 的副本。若插件要 `cordis`，它是 **peer**，由宿主提供那唯一一份——这与 `pack:contracts` 把 `@deepseek-ai/cordis` 从 `dependencies` 移到 `peerDependencies` 是同一个理由，且失败时**没有症状**：第二份实例会让宿主的 `Context` 与插件的 `Context` 变成无关类型，插件的服务落进一个宿主永远不读的注册表。因此 §9 的尺寸不变量里顺带禁掉 `node_modules`。

---

## 8. PluginCenter 变更

**PR-3 落地更正（五处，代码赢）**。本节原本是设计，现在描述的是
`apps/iris-web/src/app/PluginCenter.tsx` 上的代码。被代码推翻的五条逐条记在这里，
理由见 `notes/apps/iris-web/DEVIATIONS.md` §99：

1. **`failure.detail` 实际叫 `reason`。** 下面那段 `interface` 草稿写的是 `detail: string`；
   PR-2 落地的 `SystemPluginFailure`（`packages/iris-protocol/src/system-plugins.ts`）是
   `{ state, field?, step?, reason }`。UI 读的是 `reason`。
2. **同意页不显示扫出的成员名，也不做重名预警。** 草稿里的「及扫出的成员名（与已启用插件重名时预警）」
   靠的是 `clientMembers`，而 PR-2 已经把它从 preview 里删掉了（理由见 §5.1 的落地更正：扫描器是浏览器
   侧模块，宿主 import 不了）。同意页显示的是 `hasClient` 一句话；重名仍然由帧侧 `findMemberConflicts`
   **按插件**拒绝，并落在行上的浏览器资产列里。
3. **「同意页必须说明这是与宿主同权的代码」不再引 `COPY` 表。** 那张内联表在 #95 已经并进
   `apps/iris-web/src/app/i18n/strings.ts` 的 `pluginCenter*` 键族（见本仓 ledger §98），
   本轮新增的 85 个键也在那里，两列都受 `i18n.test.ts` 的三项审计管。
4. **卸载文案按 `source` 分叉是在行上加一句，不是改那句 `retained`。** `pluginCenterRetained`
   （「卸载会保留卡片与聊天数据…」）对内置行仍然是对的，所以它留在页脚的 `<aside>` 里没动；
   `git` 与 `dev` 的行各自多一句 `data-uninstall-copy` 的注记。
5. **「离开页面即取消」需要一个新的入参。** 设置页**从不卸载**——`SettingsPage`
   （`apps/iris-web/src/app/SettingsNavigation.tsx:122`）把每条路由都渲染出来、只用 `hidden`
   藏起来——所以路由切换不会触发任何 cleanup。`PluginCenter` 因此收一个 `active` 属性
   （`SettingsDrawer.tsx` 传 `open && route === 'plugins'`），组件内部没有别的东西能把
   「用户正在看这一页」和「这一页被另一页盖住了」分开。

**行形状的最小增量**（`SystemPluginView`，`packages/iris-protocol/src/system-plugins.ts:90`）。现有字段一个不动，`status` 的六值闭合集不动，`error?: string` 不动：

```ts
interface SystemPluginView {
  /* …现有 9 个字段原样… */
  source?: 'builtin' | 'git' | 'dev'
  provenance?: { remote?: string, commit?: string, treeHash?: string, installedAt?: string }
  failure?: {
    state: 'install-failed' | 'manifest-invalid' | 'incompatible'
         | 'tampered' | 'load-failed' | 'activate-failed'
    detail: string
    step?: string    // install-failed：git 的哪一步（init/remote/fetch/checkout/rev-parse）
    field?: string   // manifest-invalid：哪个字段
  }
}
```

三个字段全部可选，老宿主的快照照常解析，老浏览器忽略它们照常渲染——这是能做到「可加可不加」的最小改动。`failure` 是对 `status: 'error'` 的**细化**而不是替代；`tampered` 与 `incompatible` 这两个状态下 `installed: true, enabled: false, status: 'error'`，UI 靠 `failure.state` 分文案。

**上面那段草稿在 `e356771` 上有两处不同**（权威形状见 `packages/iris-protocol/src/system-plugins.ts` 与
[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §3）：字段叫 `reason` 不叫 `detail`（PR-3
落地更正 #1）；`SystemPluginFailureState` 是**七值**，U2 加了 `hook-failed`。第七个状态**不是**本条路径
的产物，它是唯一骑在 `enabled: true, status: 'enabled'` 健康行上的失败——所以「`failure` 是对
`status: 'error'` 的细化」这句话对这六个成立、对第七个不成立。

**UI 增量**

- 目录头下新增「安装插件」入口 → 一个表单（Git URL + commit，或 dev 目录路径）→ 调 `plugin.previewInstall`。
- **同意页**（新组件）：远端、commit、treeHash、体量（文件数/字节）、apiVersion 与是否兼容、capabilities 列表（旁注「仅为作者声明，宿主不校验」）、dependencies（标出本机没有的）、是否带 `client.js` 及扫出的成员名（与已启用插件重名时预警）。两个按钮：确认安装 / 取消。**同意页必须说明这是与宿主同权的代码**，用与 `COPY` 表同样的中英双份文案（当时 `PluginCenter.tsx` 顶部的内联 `COPY` 表）。
- 行上：`source` 徽标（`builtin` / `git` / **`dev`**），git 行显示短 commit 并可展开完整 provenance。
- `failure.state` 六个值各有专属文案与处置建议：`tampered` → 「磁盘上的文件与安装时记录的不符」；`incompatible` → 「需要 apiVersion N，本机支持 1」；`load-failed`/`activate-failed` → 沿用现有的「修好后重试启用或卸载」。
- 卸载确认文案要**改**：系统插件的卸载删树，而现有的 `retained` 文案说的是「保留」（那句话对内置和 ST 是对的）。按 `source` 分文案。

**PR-3 落地形状**（`apps/iris-web/src/app/PluginCenter.tsx`，测试
[plugin-center.test.ts](../apps/iris-web/tests/plugin-center.test.ts) 与
[plugin-center-install.test.ts](../apps/iris-web/tests/plugin-center-install.test.ts)）：

| 面 | 落地 |
| --- | --- |
| 安装入口 | 目录头下的 `data-plugin-install` 表单，两个单选源（`git` 远端 + 40 位 commit / `dev` 目录）。客户端先做形状检查——commit 必须匹配 `/^[0-9a-f]{40}$/`，与协议的 `PLUGIN_GIT_COMMIT`（`packages/iris-protocol/src/rpc.ts:261`）**是一份手抄**，抄它是为了让打错一个字符只花一次按键而不是一次 clone；宿主的拒绝仍然原样显示 |
| 同意页 | `PluginConsent`，**导出的纯组件**。`SystemPluginInstallPreview` 除 `previewToken` 外的每个字段各占一行，行上带 `data-consent-field="<协议键名>"`，所以协议加了字段而页面忘了显示是一条变红的断言而不是一页安静变短的清单。`permissions` 渲染成列表，旁边就是裁决 4 那句话；`sizeBytes` 过 `describeBytes`；`incompatible` 的预览**照样显示整页**，只是确认按钮 `disabled` 并多一句为什么 |
| 回带 | 确认按钮回带的四个值全部读自 `preview` 对象，**不读表单**；`commit ?? null` 是 §5.2 的那条区分。断言落在 fake 记下的调用参数上，不落在 DOM 上——一个把 id 接到错误变量上的页面看起来一模一样 |
| 取消 | 取消按钮、路由切走、组件卸载三条路都走同一个 `discard(token)`，已确认或已取消的 token 记在一个 `Set` 里不会被重复取消 |
| 行 | `source` 徽标（`builtin`/`git`/**`dev`**，`dev` 最醒目并带 title 披露）；`provenance` 是一个 `<details>`，摘要给短 commit、短 treeHash 与安装时间，展开给全值；`failure` 六个状态各有「这是什么」与「你能做什么」两句，`manifest-invalid`/`load-failed` 点名字段，`install-failed` 点名 git 步骤 |
| 裁决 3 | `tampered` 行多一个按钮，它**先卸载再 preview**（裁决 5 在 id 还占着时会拒绝 confirm），然后走同一张同意页。整棵树里没有「接受当前字节」。U1 之后行上还有第二个出口（`plugin.update` 的更新入口，见 §5.4），同样是整棵树按 (remote, commit) 重新取并重新哈希，不是接受当前字节；两个按钮并存，不互相替代 |
| 裁决 1 | `dev` 在三处都标：`system-plugins.json`（PR-2）、行上的徽标、同意页上的徽标与那段披露 |

---

## 9. 安全不变量与测试清单

每条不变量配一个**会变红**的测试。括号里是已经存在、只需扩展目标的测试文件。

| # | 不变量 | 变红的测试 |
| --- | --- | --- |
| 1 | 从不过 shell，git 只有固定 argv | 以带 `;`/`&&`/`$(…)` 的 repository 调 preview，断言被 `bad-repository` 拒；并断言 `spawnSync` 的 argv 数组逐项相等（`packages/iris-extension-installer/tests/source.test.ts`） |
| 2 | 仅 https | `git://`、`ssh://`、`http://`、裸路径、`file://`（未开 `allowLocalGit`）各一例，全部 `bad-repository` |
| 3 | 必须完整 40 位 commit | `main`、短 sha、41 位、含大写十六进制各一例，全部 `unpinned-commit` |
| 4 | 钩子禁用 | 造一个带 `hooks/post-checkout` 的本地仓库，install 后断言钩子的副作用文件**不存在** |
| 5 | 不递归子模块 | 带真 gitlink（`update-index --cacheinfo`，不走 `submodule add` 的 `file://` 传输）的仓库，断言安装树里子模块路径为**空目录或不存在**（实测 git 2.33.0.windows.2 留下的是存在的空目录，两种都接受）、子模块内容全树无痕、`.gitmodules` 留在树里且进 hash（`packages/iris-extension-installer/tests/git-submodule.test.ts`） |
| 6 | HEAD 必须等于钉住的 commit | 让远端在 fetch 后移动，断言 `head-mismatch` |
| 7 | 路径包含性 | 清单 `host` 为 `../x.js`、`/etc/x.js`、`C:\x.js`、含 `\` 各一例，全部 `manifest-invalid` 且字段为 `host`；并断言**没有**在树外发生任何读 |
| 8 | 安装树内不得有符号链接 | 在 dev 源目录里放一个 junction，断言 `auditContainment` 拒绝，且 `hashTree` 独立地也拒绝（两道网，各自测）（`packages/iris-extension-installer/tests/archive-security.test.ts`） |
| 9 | 尺寸上限 | 上限取 **256 MiB / 20,000 文件**，超出即 `install-failed`。数字的依据是实测：ST 试点那棵树是 **415 文件 / 102,374,704 字节**（[pilot-lock](../notes/st-compat/pilot-lock.md) §2），一个 16 MiB 的「合理」上限会当场拒掉这条路上唯一真实存在的样本。256 MiB 仍远低于 `DEFAULT_EXTRACT_LIMITS` 的 1 GiB（`packages/iris-extension-installer/src/archive.ts:48`），保留了「明显是炸弹」的拒绝能力 |
| 10 | 禁止 `node_modules` | 树里有 `node_modules/` ⇒ `install-failed`，消息说明理由是第二份 cordis 实例无症状 |
| 11 | treeHash 跨机稳定 | 同一棵树在不同 mtime、不同读取顺序、不同盘符下哈希相同；`.git/` 存在与否不影响（因为促进前已删）（`packages/iris-extension-installer/tests/transaction.test.ts`） |
| 12 | 篡改必须挡住激活 | 安装后改一个字节 → 开机扫描后该行 `tampered` 且 `enabled` 为 false，且 `host.js` **从未被 import**（用一个会写标记文件的 host.js 断言标记不存在） |
| 13 | 过期预览不能批准 | preview 之后改远端/改 staging 树，再用旧 `treeHash` confirm ⇒ 拒绝，且目标目录不存在 |
| 14 | 安装不等于启用 | confirm 之后断言 `enabled: false`、lock 的 `enabled === false`、host.js 未被 import |
| 15 | `Host` 允许集与回环绑定不变 | 断言本提案不新增任何路由、不改 `LOOPBACK_HOSTNAMES`（`packages/iris-rpc-host/src/host-guard.ts:46`）；新增的三个 RPC 走既有 POST 面 |
| 16 | 不新增任何能读密钥的 API | 断言 `SystemPluginActivationScope` 的键集合**不被本条路径改动**（`packages/iris-plugin-api/src/index.ts:237`）。`key.txt` 与连接密钥本来就不在 scope 上，本提案也不放上去——**唯一的保证是「没有新接口」，不是「插件够不到」**：同权代码本来就能读文件系统，这一点必须在同意页上说清楚，不能假装 scope 是边界。**措辞更正（2026-09-16）**：原文写的是「键集合**未变**」，那是把本路径的不变量误写成了全局的。scope 从六个成员长到八个（U2 的 `variables`、U3 的 `storage`），各由自己那批的裁决与约束清单负责；本条不变量约束的始终只是**这条安装路径不加成员**，而它成立 |
| 17 | `client.js` 不合格只拒该插件 | 一个成员重名的 client 与一个正常 client 同时启用，断言正常那个的成员在帧内可用、重名那个报 `conflict`，且帧仍然跑（`apps/iris-web/tests/plugin-member-merge.test.ts`） |

**PR-3 落地：#15–#17。** #15（不新增路由、不改 `LOOPBACK_HOSTNAMES`）在 PR-3 里是**空集**：本轮
只动了 `apps/iris-web/`，三个安装 RPC 走的仍是 PR-2 注册的既有 POST 面，浏览器侧没有新增任何 fetch
目标。#16（不新增能读密钥的 API）同样是空集，而它要求的另一半——**同权这件事必须在同意页上说清楚，
不能假装 scope 是边界**——落成了 `pluginCenterConsentPrivilege`（「这是宿主代码……Iris 不给系统插件
沙箱，本页上的任何一项都不是对它能做什么的限制」）与 `pluginCenterConsentPermissionsNote`（裁决 4），
两条都由 `plugin-center.test.ts`、`plugin-center-install.test.ts` 与 `check:render` 三处断言，中英各一。
#17（`client.js` 不合格只拒该插件）**本轮一行未动**：它由既有的
[plugin-member-merge.test.ts](../apps/iris-web/tests/plugin-member-merge.test.ts) 覆盖，PR-3 只是把它的
结论——`conflict`——继续显示在行上的浏览器资产列里。

**PR-2 落地：#1–#14 各自落在哪个测试上**：

| # | 落地测试 |
| --- | --- |
| 1 | 既有 `packages/iris-extension-installer/tests/source.test.ts`（含 `;` 的 URL 被拒、argv 固定）；本轮另加 `plugin-install.test.ts`「the install path never spawns anything but git」——断言新模块里根本没有 `node:child_process` |
| 2 | 既有 source.test.ts 的 https 限定；本轮 `plugin-install.test.ts`「install-failed: a non-https remote…」把同一条拒绝走到了 preview 面上 |
| 3 | 既有 source.test.ts 的 `assertPinnedCommit`；本轮 `plugin-install-rpc.test.ts`「the wire schemas refuse…」在协议层再钉一次（`main`、短 sha 都不过 schema） |
| 4 | 本轮 `plugin-install.test.ts`「git hooks in the fixture repository never run during an install」——真装一个带 `post-checkout` 的本地仓库，断言副作用文件不存在 |
| 5 | `packages/iris-extension-installer/tests/git-submodule.test.ts`（U6 件 2 补上）：真 gitlink 夹具走真实安装，断言安装树里子模块路径为空/不存在、内容全树无痕、`hashTree` 文件数恰等于外层自己的文件、`.gitmodules` 在树里且进 hash。**要诚实记下保证的边界**：这条不变量是由 argv 里*没有* `submodule update` 守住的（测试对「有人加了 `submodule update`」变红），不是由 `--no-recurse-submodules` 守住的——实测（git 2.33.0.windows.2）删掉、甚至反转为 `--recurse-submodules`，工作树逐字节相同；flag 本身由同文件里一条**源文本**断言守住，那条断言不冒充行为覆盖 |
| 6 | 既有 source.test.ts「git materialization fetches the pinned commit and proves HEAD equals the pin」；本轮 `plugin-install.test.ts`「the installed tree is the pinned commit, not the branch head」 |
| 7 | 既有 `packages/iris-app-service/tests/plugin-manifest.test.ts`（PR-1，四种写法逐条）；本轮把 `host: '../outside.js'` 走到 preview 面上 |
| 8 | 既有 source.test.ts（junction）与 archive-security.test.ts；`hashTree` 与 `auditContainment` 两道网各自测 |
| 9 | 本轮 `plugin-install.test.ts` 两条：常量本身（256 MiB / 20,000，且都大于试点树的实测值）与「a package over the file or byte ceiling is refused」（用可注入的小上限把拒绝走通） |
| 10 | 本轮「a package that ships node_modules is refused」 |
| 11 | 既有 transaction.test.ts / source.test.ts「different clone metadata, identical working tree」；本轮「the boot hash is taken over the tree without its lock」补上了**锁文件不入哈希**这半条 |
| 12 | 本轮「a tampered git tree is listed as tampered, is never imported, and cannot be enabled」——标记文件断言 `host.js` 从未被 import |
| 13 | 本轮三条：改 treeHash 回带被拒、改 id / 改 commit 回带被拒、以及「a stale preview cannot approve a tree that moved」 |
| 14 | 本轮「a dev package: …」与「a git package: …」都断言 confirm 之后 `enabled: false` 且 lock 的 `enabled === false` 且标记文件不存在 |

---

## 10. 分阶段交付

三步，每步可单独合入、单独验收。

**PR-1：安装器泛化 + 清单**（**已落地**）
把 `iris-extension-installer` 里与「ST 扩展」有关的**唯一一处**耦合——当时那个硬编码 `manifest.json` 与 `js` 字段的 `requireManifest`——提成注入的 artifact 契约：`installAs(id, source, { artifactContract })`，ST 传现有的那份，插件传 `package.json` + `iris.plugin` 那份。其余七个模块（`source`/`hash`/`archive`/`lock`/`staging`/`transaction`/`recovery`）**一行不动**，这就是「泛化而不是 fork」的具体含义。新增 `parsePluginManifest` 与 `PLUGIN_PERMISSIONS`（落在 `packages/iris-app-service/src/plugins/manifest.ts`，不是 `@iris/plugin-api`——设计原句写的是后者，落地时代码赢）。`e356771` 上 `requireManifest` 这个名字已经不在树里，取代它的就是 artifact 契约。
验收：现有 installer 测试全绿；新增清单解析测试覆盖 §9 的 #7、#10 与全部 `manifest-invalid` 字段；ST 安装路径行为逐字不变（`packages/iris-compat-st-extension/tests/pilot-host.test.ts` 不改一行仍绿）。

**PR-2：安装路径与持久化**（**已落地**）
三个 RPC（preview/confirm/cancel）加预留的 `plugin.update`、`<profile>/system-plugins/` 布局、`system-plugins.json` v2 与 v1 升级、开机复核、六个命名失败状态、`SystemPluginView` 的三个可选字段。**不含 UI**，用测试驱动。
验收：§9 的 #1–#14 全绿（逐条落点见 §9 末尾的表）；v1 profile 升级后 `revision` 不倒退；一个真实的最小插件包（fixture，含 `host.js` 与 `client.js`）走完 preview → confirm → enable → disable → uninstall，且卸载后树不存在；`tampered` 路径下 host.js 从未被 import。
落地代码：`packages/iris-app-service/src/plugins/install.ts`（安装服务与开机扫描）、
`packages/iris-app-service/src/system-plugins.ts`（v2 目录、`provenance`/`failure` 投影、`removable` 卸载）、
`packages/iris-extension-installer/src/installer.ts` 的 `stage`/`promote`/`discard` 拆分。
落地测试：`packages/iris-app-service/tests/plugin-install.test.ts`（31）、
`packages/iris-app-service/tests/plugin-install-rpc.test.ts`（5）、
`packages/iris-client-fake/tests/plugin-install.test.ts`（6）、
`packages/iris-extension-installer/tests/staged-install.test.ts`（6）。

**PR-3：PluginCenter**（**已落地**）
安装入口、同意页、`source` 徽标、六个失败状态的中英文案、按 `source` 分叉的卸载文案。
验收：同意页显示 §5.1 返回的每一个字段；英中双语齐全、键盘可达（沿用现有 PluginCenter 的验收条目）；`dev` 徽标在行上和同意页上都出现；浏览器验收脚本与证据落进 `notes/`。
落地代码：`apps/iris-web/src/app/PluginCenter.tsx`（`PluginInstallForm` / `PluginConsent` /
`Provenance` / `SourceBadge` 与行上的失败块）、`apps/iris-web/src/app/plugin-center.css`、
`apps/iris-web/src/app/i18n/strings.ts`（85 个 `pluginCenter*` 新键，两列）、
`apps/iris-web/src/client/store.ts`（三个 action，以及**为什么它们不走 `describeError`**）、
`apps/iris-web/src/app/SettingsDrawer.tsx`（`active` 入参）。
落地测试：[plugin-center-install.test.ts](../apps/iris-web/tests/plugin-center-install.test.ts)（jsdom
里真点，断言落在 fake 记下的调用参数上）、[plugin-center.test.ts](../apps/iris-web/tests/plugin-center.test.ts)
新增的一条（六个失败状态 × 两种语言、三种 `source`、provenance、卸载文案分叉、同意页字段下限）、
`npm run check:render` 新增的四个用例。
**浏览器验收**：施工时记为未做（理由：`check:render` 与 jsdom 点击测试是可重跑的门，一次手工会话不是），
合入前由协调人补上——脚本是 `apps/iris-web/tools/live-plugin-install-check.mjs`（headless Chrome 经 CDP 对着真宿主、真包走完
安装 → 同意 → 确认 → 启用 → 卸载），证据在 [PLUGIN-INSTALL-ACCEPTANCE-2026-09-15](../notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md)：
17 个同意页字段、dev 徽标、权限句、行状态与卸载后目录原样，全部为真；截图因验收宿主画着真实对话正文而不入库。
git 源在页面上的同一条路径未在浏览器里走，那份记录里说明了为什么。

---

## 11. 被否决的方案

- **npm registry 安装**。需要三样本轮没有的东西：一个 registry 信任故事（作用域、2FA、撤回）、一个运行时 npm（宿主不带，`scripts/pack-contracts.mjs` 是从 Node 安装里找 npm 的，那是构建期不是运行期）、以及依赖解析——而依赖解析会把「一棵可哈希的树」变成「一张可变的图」，`treeHash` 当场失效。
- **任意 tarball URL**。没有 commit 这样的天然不可变标识；要补一个「用户自己填 sha256」的步骤，而用户手里的 sha256 与他即将下载的字节之间没有任何独立来源，这是安全剧场。git 的 commit 是**仓库自己**保证的内容标识，这是本质区别。
- **自动更新**。与 commit 钉死直接对立：`assertPinnedCommit` 的拒绝消息里写的就是「会动的 ref 会让锁记录说谎」。自动更新等于让一个**未经同意的新字节集**继承上一次同意的授权。
- **给 git 源加主机白名单**。§4 已说明：白名单对卡片是对的（内容），对同权代码是错的（用户的主动选择），且 `raw.githubusercontent.com` 本来就在卡片白名单里，白名单在这里挡不住任何人。
- **fork 安装器**。八个模块里七个与 artifact 形状无关，fork 会让 §9 的 17 条不变量各有两份实现，其中一份必然先腐烂。PR-1 用一个注入点解决了全部差异——落地形就是新增的 `packages/iris-extension-installer/src/artifact-contract.ts`，其余七个模块一行未动。
- **`host.js` 用工厂导出**。见 §3：凭空多一个生命周期阶段，而目录里另外两条入口拿的都是 definition。
- **在插件树里允许 `node_modules`**。第二份 cordis 实例的症状是**没有症状**（类型无关、服务落进宿主不读的注册表），这类失败不该用文档去防。
- **卸载保留安装树**（ST 的做法）。见 §6：插件树里没有用户数据，留着就是一棵用户以为已删的同权代码树。

---

## 12. 待裁决问题

### 裁决记录（2026-09-15）

owner 已就下面五问裁决。五个问题按原样保留在后面，作为每条裁决所回答的东西——裁决只在
读得到它回答了什么的时候才是裁决。

1. **`dev` 源永远可用、永远标 `dev`。** 即问题 1 的选项 (a)：发行版里保留这条路。代价
   （发行版内存在一条无字节校验的同权装载路径）由「永远显式标 `dev`」承担——
   `system-plugins.json` 里标、PluginCenter 行上标、同意页上标，三处都标。
2. **预留 `plugin.update({ id, commit })` 的 RPC 位子，本轮不实现。** 位子按问题 2 里写
   的那条语义留（preview 复用、confirm 把新树促进到同一 id 并保留偏好行），但本轮的更新
   路径仍然是「卸载后重装」，走完整同意。
3. **`tampered` 给「按记录的 remote + commit 重新安装」按钮，走完整同意步骤。** 即问题 3
   的选项 (b)。不做选项 (c) 的「接受当前字节」：把新 `treeHash` 一键写进记录会让整个哈希
   锁定机制可被一键绕过，而 (b) 对「手动打过补丁的插件」给的出路是重新拉一次可复现的
   (remote, commit)，这正是 §6 说插件树没有用户数据的那条理由的推论。
4. **清单加 `permissions` 权限列表。** 闭合词表，宿主校验**拼写**并在同意页**展示**。它是
   **声明，不是宿主强制的边界**——系统插件是同权代码（§4 裁决 1），宿主不靠这张表挡任何
   东西；这句话必须同时出现在实现的文档注释里和同意页上，否则它读起来就是一个权限系统，
   而那正是问题 4 指出的风险。U2 把 `write-variables` 加进词表时沿用了同一前提、**没有设
   闸**：runtime 在激活路径上拿不到 manifest（`SystemPluginDefinition` 无 `permissions`
   字段），而且内置插件与被接纳的 ST 扩展行根本没有 manifest，设闸会让它们全部被拒；变
   量 writer 的每一次覆盖经宿主仲裁并按 id 上报冲突，用户在报告视图里看得见是谁写的。前
   提与将来一行闸门的改法记在 DEVIATIONS §82。`capabilities`（插件**提供**什么）仍是另一张自由文本表，两
   者不合并：一个说「我会用到什么」，一个说「我会给出什么」。
5. **安装 id 与内置 id 撞车，在 confirm 阶段以 `install-failed`（id 已被占用）拒绝。** 暂
   不做 `shadowed` 状态：一个装得进去、占着磁盘、却永远不会被激活的行，是 §1 目标 4「失败
   状态全部有名字、能被看见并被处置」的反面。

**PR-1 的落地情况**：裁决 4 已实现——`PLUGIN_PERMISSIONS` 与 `parsePluginManifest`
（`packages/iris-app-service/src/plugins/manifest.ts`）是闭合词表与清单契约，未知权限名以
`manifest-invalid` 拒绝且字段为 `permissions[i]`。裁决 1、2、3、5 都落在 PR-2/PR-3 的面
上，本轮没有写对应代码。

**PR-2 的落地情况**：

- **裁决 1** 已实现：`dev` 是三种 `source` 之一，进 `system-plugins.json`、进
  `SystemPluginView.source`、进 preview 的 `source` 字段；开机扫描对它跳过哈希复核，
  所以它永远不会是 `tampered`（测试「a dev row skips the hash check」）。
- **裁决 2** 已实现为**拒绝**：`plugin.update({ id, commit })` 有静态 schema、有 handler、
  fake 也有，三者都答 `unsupported` 并在消息里点名裁决 2 与「卸载后重装」这条替代路径。
  这里用 `unsupported` 而不是新造一个 `not-implemented` 码：`RpcError['code']` 里没有这个
  成员，而「这个方法名存在、这次构建没实现它」在本树里本来就是 `unsupported`
  （`parseRequest` 对未知方法答的就是它，`requirePlugins()` 对未配置控制面答的也是它）。
  **已改口并实现（2026-09-15 第二批 U1，`docs/SYSTEM-PLUGIN-INSTALL.md` §5.4）**：保留上面这段，
  因为它是当初这样做的理由；`plugin.update` 现在走同一条 preview 路并回答带 `updateOf` 的
  `SystemPluginInstallPreview`，同意步骤是既有的 `plugin.confirmInstall`。请求形状没有变。
- **裁决 3** 的前提已具备：`tampered` 行保留 `provenance.remote` 与 `provenance.commit`，
  测试「ruling 3: tamper, boot, then reinstall…」把整条路走了一遍。**要注意顺序**：这条路
  是「卸载 → preview → confirm」，中间那一步卸载不是可选的，因为裁决 5 在 id 还被占着的
  时候会拒绝 confirm，而本轮的更新路径本来就是 §1 非目标里写的「卸载后重装」。按钮是 PR-3 的事。
- **裁决 5** 已实现：confirm 阶段比对目录里全部 id（内置与已装都算），撞车即
  `install-failed`，消息含「id 已被占用」。preview 额外把这件事放进 `warnings`，这样同意页
  不必等到用户点下去才告诉他——但**拒绝仍然在 confirm**，位置没挪。没有 `shadowed` 状态。

**PR-3 的落地情况**（UI，全部在 `apps/iris-web/src/app/PluginCenter.tsx`）：

- **裁决 1** 的第二、三处标记落地：行上的 `source` 徽标（`dev` 用 danger 色，并在 `title` 里写明
  「从本机的一个目录就地加载，它的字节永远不会被复核」）与同意页上的徽标加一整段披露。第一处
  （`system-plugins.json`）是 PR-2 的。
- **裁决 2** 落地为**没有按钮**：整个 UI 里没有任何 `plugin.update` 的入口，`plugin-center.test.ts`
  用一条 `doesNotMatch(/plugin\.update|check for updates/i)` 把它钉住。
  **已改口并实现（2026-09-15 第二批 U1）**：git 行上多了「更新到…」入口，走同一张同意页、同意页多一行
  `updateOf`（§5.4）。上面那条 `doesNotMatch` 断言随之退役——这不是弱化：`notes/apps/iris-web/DEVIATIONS.md`
  §99 在写下它时就点名了「裁决 2 被改口的那天，删它的人应当在这里读到它当初为什么在」。替代它的是两条更严的
  断言：更新入口只出现在已安装的 `git` 行上（按按钮自己的 `data-plugin-update` 属性数数量），`dev`/`builtin`
  行没有；「接受当前字节」的否定断言原样保留、一个字没动。
- **裁决 3** 落地：`tampered` 行上的「按记录的 remote + commit 重新安装」，它先 `plugin.uninstall`
  再 `plugin.previewInstall(recorded)`，然后走**同一张**同意页。顺序是被断言的，不是被注释的
  （`plugin-center-install.test.ts` 比较那两次调用的方法名序列与参数）。没有「接受当前字节」。
- **裁决 4** 落地：`permissions` 在同意页上是一张列表，旁边就是那句「这是作者写下的声明，Iris 只做
  拼写校验并展示。它不是 Iris 强制的边界：系统插件是宿主代码，这张表上的事它能做，不在这张表上的事
  它也能做」，中英各一份、两处测试断言。
- **裁决 5** 在 UI 上是**不做什么**：撞车的拒绝仍然只在 confirm，页面把宿主的那句
  「install-failed: id 已被占用 …」**原样**显示。这句话能到达读者，靠的是 store 里的
  `pluginInstallFailure` 用 `asRpcError().message` 而不是 `describeError()`——后者会把
  `invalid-request` 的详情换成「Iris 不会发送这个请求。」，那对六个生命周期方法是对的、对这条路是错的
  （理由写在该函数的注释里，并由一条变红的断言钉住）。

1. **`dev` 源是否进发行版？** 它是唯一一个跳过 `treeHash` 复核的源。选项：(a) 永远可用并永远标 `dev`；(b) 只在开发构建里编译进去，发行版根本没有这条路。本文按 (a) 写，因为 (b) 会让「按发行版调试插件」变成不可能，但 (a) 的代价是发行版里存在一条无字节校验的同权装载路径。
2. **更新事务现在留不留位？** 本轮的更新路径是「卸载后重装」，而卸载删树、重装要重新走完同意。这对一个常更新的插件是明显的摩擦。是否现在就把 `plugin.update({ id, commit })` 的位子留出来（preview 复用、confirm 时把新树促进到同一 id 并保留偏好行），还是等有真实使用者再说？
3. **`tampered` 之后给用户什么出路？** 选项：(a) 只读提示，用户自己卸载重装；(b) 给一个「按记录的 (remote, commit) 重新安装」按钮，它会走完整的同意步骤；(c) 给一个「接受当前字节」按钮，把新 `treeHash` 写进记录——(c) 会让整个机制可被一键绕过，但没有它，一个手动打过补丁的插件就永远卡住。
4. **`capabilities` 本轮只展示不校验，可接受吗？** 宿主没有能力注册表可以校验它（`scope.provide` 的名字是运行时字符串）。同意页会把「仅为作者声明」写在旁边，但一个看起来像权限列表的东西不是权限列表，这本身是个风险。另一个选项是本轮**根本不收**这个字段，等有了注册表再加。
5. **安装 id 与内置 id 撞车怎么办？** `adoptDefinition` 现在对已知 id **返回 `false` 并静默跳过**（`packages/iris-app-service/src/system-plugins.ts:394`），也就是「先到先得，内置赢，且没有任何报告」。本提案需要一个明确答案：在 confirm 阶段就以 `install-failed` 拒绝（id 已被占用），还是允许安装但在目录里标成 `shadowed` 并说明它不会被激活？
