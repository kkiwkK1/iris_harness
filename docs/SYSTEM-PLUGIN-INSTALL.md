# 系统插件安装路径（裁决已下，分阶段落地中）

状态：**设计已裁决**（2026-09-15，见 §12 裁决记录），§10 的 PR-1（安装器泛化 + 清单解析）已落地，PR-2/PR-3 未开工；本文其余各节仍是设计而非现状描述，代码以 `docs/INFRASTRUCTURE-INTERFACES.md` 为准。原状态说明保留如下——状态：**提案**。本文不描述 `main` 上存在的代码，除了第 2 节——那一节的每一条都按 `8552c4b` 重新读过源码，行号只作为该提交的证据，事实以符号名定位。其余各节是**待裁决的设计**，落地前不得被引用为现状。

它回答的是 [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)「Trust model (信任模型)」留下的那个公开问题——**同权宿主代码的安装源受什么约束**——以及 [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §8 里「系统插件的包外安装路径」那一行。两者在文档里就是同一件事的两面。

裁决人：项目 owner。裁决前不写产品代码。

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
- 同 id 换 commit 的**更新**事务（`Installer` 现在对已装 id 直接答 `already-installed`，`packages/iris-extension-installer/src/installer.ts:82`）。本轮的路径是「卸载后重装」。
- 给系统插件加运行时沙盒。裁决 1 已经排除。
- 给插件任何新的宿主能力接口（`scope.storage`、`scope.settings`、生成钩子都仍然不存在，见 §2）。

---

## 2. 现状

按 `8552c4b` 重读。**先记三处代码与文档不一致的地方**，按「代码赢」处理：

1. 安装器**不在** `packages/iris-compat-st-extension/src/host/`，而是独立包 `packages/iris-extension-installer/`（`archive` / `hash` / `installer` / `lock` / `recovery` / `source` / `staging` / `transaction` 八个模块）。ST 兼容包只是它的使用方之一；[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §7「安装源」一行指的就是这个包。
2. [PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5 提到「`docs/SYSTEM-PLUGINS.md` 给第三方扩展清单 `iris.apiVersion` 的规矩」——**该规矩不存在**。`iris.apiVersion` 这个字符串在整棵树里只出现在那一句话里。本文的 §3 是第一次真正定义它，所以那句话是**预告**而不是引用。
3. **没有一个统一的 `plugin.*` id 文法**，树上同时有四条，且互不相等：
   - 协议线上：`z.string().min(1).max(200)`（`packages/iris-protocol/src/rpc.ts:247`），任意字符；
   - 运行时目录：1 到 200 个字符（`adoptDefinition`，`packages/iris-app-service/src/system-plugins.ts:179`）；
   - 资产路由：`safePluginId` 再加「无路径分隔符、无控制字符」（`packages/iris-app-service/src/plugin-assets.ts:86`）；
   - 安装器：`EXTENSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/`（`packages/iris-extension-installer/src/lock.ts:28`），理由写在拒绝消息里——**id 会变成目录名**。

   四条里只有最后一条对「id 是目录名」这件事负责，所以 §3 选它。

### 系统插件今天有什么

| 项 | 事实 |
| --- | --- |
| 契约 | `SystemPluginDefinition`（`packages/iris-plugin-api/src/index.ts:55`）与 `SystemPluginActivationScope`（`:95`）。scope 上只有 `context`/`pluginId`/`revision`/`provide`/`getDependency`/`registerRpc` |
| 两条入口 | `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`（`packages/iris-app-service/src/plugins/builtins.ts:15`，只有 `tavern-helper` 与 `mvu`）与 `SystemPluginRuntime.adoptDefinition`（`packages/iris-app-service/src/system-plugins.ts:177`） |
| `plugin.install` 不装东西 | 它只把目录里已有的一行翻成 `installed: true`（`packages/iris-app-service/src/system-plugins.ts:408` 的 `install`），不下载、不写树 |
| 持久化 | profile 根下 `system-plugins.json`（`packages/iris-app-service/src/index.ts:779`），形状 `{ version: 1, revision, plugins: { <id>: { installed, enabled } } }` |
| 投影 | `SystemPluginView`（`packages/iris-protocol/src/system-plugins.ts:5`），`status` 是六值闭合集（`:14`），错误只有一个自由文本 `error?: string` |
| 浏览器面 | `PluginAssetStore`（`packages/iris-app-service/src/plugin-assets.ts:113`）从 `<dataDir>/system-plugins/<id>/client/` 供 `client.js`，`?rev=` 命中才 immutable，停用即 404 |
| 帧侧成员 | `scanPluginMemberNames`（`apps/iris-web/src/app/use-plugin-manifest.ts:208`）只收 `registerPluginMembers` 调用里**字面量** id 与**字面量**对象键；重名由 `findMemberConflicts`（`:345`）报 `conflict` |
| 拒跑粒度 | **按插件，不按帧**：核心表缺席才整帧拒跑，单个插件没跑完只拒该插件并点名（`apps/iris-web/src/sandbox/plugin-members.ts:13`） |

**没有的东西**：没有 npm 名、没有 Git URL 能装一个 Node 系统插件；没有 `scope.storage` / `scope.settings` / 生成钩子；插件不能注册设置槽；契约包仍是 `private`/`0.0.0`（发布形由 `npm run pack:contracts` 生成，版本政策 `1.0.0-alpha.N`，见 [PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5）。

### ST 扩展这条路已经有什么（本提案要复用的全部资产）

| 能力 | 符号与位置 |
| --- | --- |
| 源校验 | `validateExtensionSource` / `assertPinnedCommit`（`packages/iris-extension-installer/src/source.ts:49`、`:77`）：https 限定、40 位十六进制 commit、URL 含空白或引号直接拒 |
| git 执行 | `materializeGit`（`packages/iris-extension-installer/src/source.ts:162`）：固定 argv、不过 shell、每次 `-c core.hooksPath=`、`--depth 1 --no-recurse-submodules --no-tags`、checkout 后 `rev-parse HEAD` 必须等于钉住的 commit |
| 事务状态机 | `InstallPhase`：`downloading → staged → validated → hashed → promoting → installed`，失败是唯一旁路（`packages/iris-extension-installer/src/transaction.ts:18`） |
| 树哈希 | `hashTree`（`packages/iris-extension-installer/src/hash.ts:30`）：逐文件 sha256，再对**按正斜杠相对路径字节序排序**的 `相对路径\0文件哈希\n` 行求 sha256；遇 symlink/junction 直接抛 |
| 安全审计 | `guardEntryName` / `copyTreeGuarded` / `auditContainment`（`packages/iris-extension-installer/src/archive.ts:59`、`:262`、`:303`）与 `DEFAULT_EXTRACT_LIMITS`（`:48`） |
| 原子落地 | staging 里做完一切，只有一次 `rename` 碰目标目录，然后写 lock；无 lock 的目标目录不是安装（`packages/iris-extension-installer/src/installer.ts:148`、`recoverInstallations` 在 `packages/iris-extension-installer/src/recovery.ts:46`） |
| 锁记录 | `InstalledExtensionLock`（`packages/iris-extension-installer/src/lock.ts:15`）：`extensionId`/`source`/`resolvedCommit`/`artifactSha256`/`installedAt`/`enabled`，且 `enabled` 必须**恰好是 `false`**（`:71`）——安装器从不启用 |
| 安装位置 | `<profile>/st-extensions/`（`packages/iris-app-service/src/paths.ts:293`），布局是 `staging/ claims/ installed/<id>/` |
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
      "displayName": "Demo",               // 必填
      "description": "…",                  // 必填
      "capabilities": ["demo.state"],       // 可选，仅声明（插件提供什么）
      "permissions": ["provide-capability", "register-rpc"],  // 可选，闭合词表（插件声明用什么）
      "dependencies": ["tavern-helper"]     // 可选，其他插件 id
    }
  }
}
```

- **`id`** 用安装器那条文法：`/^[a-z0-9][a-z0-9._-]{0,63}$/`（`packages/iris-extension-installer/src/lock.ts:28`）。理由不是「已经有人这么写」，而是 id 在这条路上同时是**目录名**（`<profile>/system-plugins/<id>/`）、**URL 段**（`/plugins/<id>/client.js`）和**目录主键**。协议那条 `min(1).max(200)` 不对目录名负责，不能当文法用；`safePluginId` 是路由的下界而不是安装的上界。四条文法里选最严的一条，其余三条自动被满足，这是**收紧而不是放宽**，不需要改协议。
- **`apiVersion`** 与 `SystemPluginDefinition.apiVersion` 是同一个数字，也与契约包的 npm major 对齐（[PLUGIN-CONTRACT-PACKAGING](PLUGIN-CONTRACT-PACKAGING.md) §5：`apiVersion: 1` ↔ major `1`，预发布用 `1.0.0-alpha.N`）。宿主声明自己支持的区间（当前只有 `[1, 1]`）；不在区间内**不是崩溃**，是命名状态 `incompatible`，行留在目录里、不激活、PluginCenter 说明「此插件需要 apiVersion N，本机支持 1」。
- **`host`** 是一个普通 ESM 模块，**默认导出一个 `SystemPluginDefinition` 对象**，不是工厂。理由：目录里另外两条入口拿的都是 definition——`BUILTIN_SYSTEM_PLUGIN_DEFINITIONS` 是 definition 数组，`adoptDefinition(raw, …)` 收 definition。选工厂就要定义「工厂在哪个上下文里跑、能不能异步、抛错算 `load-failed` 还是 `activate-failed`」，凭空多出一个生命周期阶段，而它能做的事 `activate` 都能做，且 `activate` 已经有 lease、fiber 和失败回滚。用 `import(pathToFileURL(...))` 加载；模块顶层抛错是 `load-failed`，默认导出形状不对是 `manifest-invalid`（字段 `host`）。
- **`client`** 走已有的资产面：激活时把它复制/链接到 `<dataDir>/system-plugins/<id>/client/client.js`（ST 那条路现在就是往这个位置写代理 bundle，`packages/iris-app-service/src/index.ts:826`），于是聚合清单自动长出一行。对它的要求就是 `scanPluginMemberNames` 的要求：`registerPluginMembers('<字面量 id>', { 字面量键: … })`——**id 必须是字符串字面量、成员键必须是字面量**，计算键和间接注册一律扫不出来（`apps/iris-web/src/app/use-plugin-manifest.ts:208`）。扫不出来不是报错，是「这个插件不声明成员」；真正的拒绝发生在重名（`conflict`）与帧内没跑完，且**都是按插件拒的，不是按帧**（`apps/iris-web/src/sandbox/plugin-members.ts:13`）。
- **`capabilities`** 本轮**只用于同意步骤的展示**，不做运行时校验——宿主没有能力注册表可以校验它（`scope.provide` 的名字是运行时字符串）。这一点必须写在 UI 上，否则它读起来像一个权限系统。
- **`dependencies`** 直接喂给 definition 的 `dependencies`，由已有的 DFS 拓扑序、成环拒绝、被依赖拒删接管。

包里**不允许**有 `node_modules`（见 §9 的尺寸与符号链接不变量），也不会被执行任何安装脚本——安装器从不跑 artifact 里的东西，这是它的既有不变量（`packages/iris-extension-installer/src/installer.ts:11` 的模块注释）。

---

## 4. 安装源与信任模型

裁决 1：**系统插件是与宿主同权的 Node 代码**，`activate` 在宿主进程里拿到宿主的全部触达能力。没有沙盒。限制风险的是**代码从哪来**和**用户是否明确同意**。

本轮三种源，按优先级：

| 源 | 状态 | 约束 |
| --- | --- | --- |
| `builtin` | 已存在 | 本仓库源码，随 Iris 发行 |
| `git` | 本提案新增 | **仅 https，必须钉完整 40 位 commit**，无主机白名单 |
| `dev` | 本提案新增 | 本地目录，在 `system-plugins.json` 和 PluginCenter 行上都**显式标 `dev`** |

**为什么 git 不设主机白名单**：卡片代码有一份两主机白名单（`REMOTE_ALLOWLIST = ['*.jsdelivr.net', 'raw.githubusercontent.com']`，`apps/iris-web/src/sandbox/policy.ts:77`，宿主侧每跳由 `checkScriptFetch` 复核），因为卡片是**内容**——用户打开一张卡时并没有在选择运行谁的代码。系统插件相反：用户是在**主动选择运行同权代码**，这与他敲 `npm install` 是同一类动作，而白名单在这里只会制造安全错觉（GitHub 上任何人都能放任何东西，白名单里恰好就有 `raw.githubusercontent.com`）。所以补偿控制不是白名单，而是**同意步骤**（§5）：在 `activate` 跑之前，把远端 URL、commit、清单声明的 capabilities 与 dependencies、以及**是否带 `client.js`** 摆到用户面前。

**为什么记录字节而不只是 URL**：[PLUGIN-FEASIBILITY](../notes/PLUGIN-FEASIBILITY.md) §8 问题 1 里的「哈希锁定」在今天的树上是**提案而不是描述**——卡片那条路哈希的是 **URL**，作为缓存文件名（`cacheKey`，`packages/iris-app-service/src/script-cache.ts:217`），不是字节。本提案让它在系统插件这条路上成为事实，并且**不改卡片那条路**：卡片仍然按 URL 缓存，这个差异保留并在此写明。

**规范遍历**就是 `hashTree` 已经实现的那一个（`packages/iris-extension-installer/src/hash.ts:30`），本文只是把它提升为契约：按正斜杠相对路径**字节序排序**，逐行 `相对路径\0sha256(文件字节)\n`，对拼接结果取 sha256；目录不入行、空目录不影响结果；遇到 symlink/junction 直接抛（哈希过的树就是审计过的树）；`.git/` 不参与——因为它在哈希之前就被删掉了（`packages/iris-extension-installer/src/installer.ts:125`，理由：clone 本地数据会让同一 commit 在两台机器上算出不同的 sha256）。`dev` 源额外跳过 `node_modules/`？**不跳**：dev 树本来就不允许有 `node_modules`，跳过等于默许它存在。

---

## 5. 安装流程

两段式握手。preview 把树**装进 staging 并停下**，confirm 才促进（promote）。这样同意页上显示的哈希就是即将安装的那棵树的哈希，而不是一次「再拉一遍、希望还一样」。

### 5.1 `plugin.previewInstall`

```ts
'plugin.previewInstall': z.object({
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('git'),
      repository: z.string().min(1).max(2000),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
    }),
    z.object({ kind: z.literal('dev'), directory: z.string().min(1).max(1000) }),
  ]),
})
```

返回：

```ts
interface SystemPluginInstallPreview {
  transactionId: string            // 已有事务 id，阶段停在 'hashed'
  id: string                       // 清单里的 iris.plugin.id
  displayName: string
  description: string
  version: string                  // package.json 的 version
  apiVersion: number
  compatible: boolean              // apiVersion 是否在宿主区间内
  source: 'git' | 'dev'
  remote?: string                  // git 的 repository
  commit?: string                  // git 的 resolvedCommit（== 请求里的 commit）
  treeHash: string                 // 64-hex，规范遍历的结果
  files: number
  bytes: number
  capabilities: string[]
  permissions: string[]            // 闭合词表，见 §12 裁决 4：展示与拼写校验，不是边界
  dependencies: string[]
  hasClient: boolean               // 是否带 client.js
  clientMembers: string[]          // scanPluginMemberNames 扫出的成员名，供重名预警
  warnings: string[]               // 例如「声明的 dependency 不在本机目录里」
}
```

宿主侧顺序，全部复用既有阶段：`materializeSource` → （git）删 `.git` → 读 `package.json` 与 `iris.plugin`（形状不对即 `manifest-invalid`，带字段名）→ `auditContainment` → 尺寸与文件数上限 → `hashTree` → 事务停在 `hashed`。**preview 不加载 `host.js`，不执行任何 artifact 内代码。**

### 5.2 `plugin.confirmInstall`

```ts
'plugin.confirmInstall': z.object({
  transactionId: z.string().min(1).max(200),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  treeHash: z.string().regex(/^[0-9a-f]{64}$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),   // git 源必填
})
```

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

第三个 RPC `plugin.cancelInstall({ transactionId })` 是必要的：没有它，一次被放弃的预览会把 staging 和 claim 留到下次 `recoverInstallations` 才清（`packages/iris-extension-installer/src/recovery.ts:46`），而那是**崩溃恢复**机制，不该被当成正常退出路径用。

---

## 6. 存储与状态机

**位置**：`<profile>/system-plugins/`，布局与 ST 那份一致（`staging/ claims/ installed/<id>/`）。

与 ST 的 `<profile>/st-extensions/`（`packages/iris-app-service/src/paths.ts:293`）**分开**，理由有两条且都不是洁癖：一是两者的 artifact 契约不同（ST 树要有 `manifest.json` 且 `js` 必须存在——`requireManifest`，`packages/iris-extension-installer/src/installer.ts:218`；插件树要有 `package.json` 的 `iris.plugin`），混在一个 `installed/` 下就要在扫描时靠试探区分；二是 id 命名空间不同，ST 的 id 是 `display_name` 的 slug，插件的 id 是作者写的，撞名时不该是先到先得。

注意 `<dataDir>/system-plugins/` 这个名字**已经被占用**了：它是资产面的 client bundle 根（`packages/iris-app-service/src/index.ts:1412`、`packages/iris-app-service/src/plugin-assets.ts:117`），而且是 dataDir 级不是 profile 级。本提案的安装树在 **profile** 下。同名不同层是一个真实的踩坑点，实现时两个常量都要带注释指向对方。

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

版本**升到 2**，而不是「加可选键、保持 1」。后者读起来更平滑（现有的 `validPreference` 本来就容忍多余键），但方向是错的：旧版 Iris 读到一个 v1 的文件会照常激活，包括那些它根本不会复核 `treeHash` 的行。升到 2 之后，旧版读不懂，走的是既有的「读不动即全体停摆、保留原文件、全部置 `error`」路径——对一个安全特性来说，**拒绝一切**是安全的那个方向。新版读 v1 文件就地升级：所有行补 `source: "builtin"`。

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

---

## 7. 加载与激活

1. **开机扫描**：遍历 `<profile>/system-plugins/installed/`，对每个有 lock 的目录读 `package.json`。这一步只读清单，不 import。
2. **复核**：`hashTree` 重算，与 `system-plugins.json` 里的 `treeHash` 比。不符 ⇒ 该行 `tampered`，**不激活**，其余插件照常。`dev` 源跳过复核（它的树本来就在被编辑），但 PluginCenter 行上永远标 `dev`。
3. **兼容**：`apiVersion` 不在宿主区间 ⇒ `incompatible`，不激活。
4. **接纳**：`adoptDefinition(definition, { installed: true })`。注意它对已知 id **返回 `false` 且静默跳过**（`packages/iris-app-service/src/system-plugins.ts:178`），所以内置 id 与安装 id 撞车时目前的行为是「安装的那个被忽略」——见 §12 问题 5。
5. **加载**：只有在**启用**时才 `import(pathToFileURL(join(installedDir, iris.plugin.host)))`。路径在拼之前必须过包含性检查（§9）。顶层抛错 ⇒ `load-failed`；默认导出不是合法 definition ⇒ `manifest-invalid`（字段 `host`）。
6. **激活**：definition 交给既有的 `enable` 路径——DFS 拓扑序、失败回滚、lease、fiber。`activate` 抛错 ⇒ `activate-failed`，走既有的「失败激活不得留下半注册能力」不变量。
7. **client**：若清单有 `client`，在接纳时把它放到 `<dataDir>/system-plugins/<id>/client/client.js`，其余由资产面接管（rev、404、清单行）。

**契约包**：`host.js` 只 `import type` `@iris/plugin-api`，运行时被类型擦除，装出来的树里不需要也不应该有 `@iris/*` 的副本。若插件要 `cordis`，它是 **peer**，由宿主提供那唯一一份——这与 `pack:contracts` 把 `@deepseek-ai/cordis` 从 `dependencies` 移到 `peerDependencies` 是同一个理由，且失败时**没有症状**：第二份实例会让宿主的 `Context` 与插件的 `Context` 变成无关类型，插件的服务落进一个宿主永远不读的注册表。因此 §9 的尺寸不变量里顺带禁掉 `node_modules`。

---

## 8. PluginCenter 变更

**行形状的最小增量**（`SystemPluginView`，`packages/iris-protocol/src/system-plugins.ts:5`）。现有字段一个不动，`status` 的六值闭合集不动，`error?: string` 不动：

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

**UI 增量**

- 目录头下新增「安装插件」入口 → 一个表单（Git URL + commit，或 dev 目录路径）→ 调 `plugin.previewInstall`。
- **同意页**（新组件）：远端、commit、treeHash、体量（文件数/字节）、apiVersion 与是否兼容、capabilities 列表（旁注「仅为作者声明，宿主不校验」）、dependencies（标出本机没有的）、是否带 `client.js` 及扫出的成员名（与已启用插件重名时预警）。两个按钮：确认安装 / 取消。**同意页必须说明这是与宿主同权的代码**，用与 `COPY` 表同样的中英双份文案（`apps/iris-web/src/app/PluginCenter.tsx:13`）。
- 行上：`source` 徽标（`builtin` / `git` / **`dev`**），git 行显示短 commit 并可展开完整 provenance。
- `failure.state` 六个值各有专属文案与处置建议：`tampered` → 「磁盘上的文件与安装时记录的不符」；`incompatible` → 「需要 apiVersion N，本机支持 1」；`load-failed`/`activate-failed` → 沿用现有的「修好后重试启用或卸载」。
- 卸载确认文案要**改**：系统插件的卸载删树，而现有的 `retained` 文案说的是「保留」（那句话对内置和 ST 是对的）。按 `source` 分文案。

---

## 9. 安全不变量与测试清单

每条不变量配一个**会变红**的测试。括号里是已经存在、只需扩展目标的测试文件。

| # | 不变量 | 变红的测试 |
| --- | --- | --- |
| 1 | 从不过 shell，git 只有固定 argv | 以带 `;`/`&&`/`$(…)` 的 repository 调 preview，断言被 `bad-repository` 拒；并断言 `spawnSync` 的 argv 数组逐项相等（`packages/iris-extension-installer/tests/source.test.ts`） |
| 2 | 仅 https | `git://`、`ssh://`、`http://`、裸路径、`file://`（未开 `allowLocalGit`）各一例，全部 `bad-repository` |
| 3 | 必须完整 40 位 commit | `main`、短 sha、41 位、含大写十六进制各一例，全部 `unpinned-commit` |
| 4 | 钩子禁用 | 造一个带 `hooks/post-checkout` 的本地仓库，install 后断言钩子的副作用文件**不存在** |
| 5 | 不递归子模块 | 带 submodule 的仓库，断言安装树里子模块目录为空 |
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
| 16 | 不新增任何能读密钥的 API | 断言 `SystemPluginActivationScope` 的键集合未变（`packages/iris-plugin-api/src/index.ts:95` 的六个成员）。`key.txt` 与连接密钥本来就不在 scope 上，本提案也不放上去——**唯一的保证是「没有新接口」，不是「插件够不到」**：同权代码本来就能读文件系统，这一点必须在同意页上说清楚，不能假装 scope 是边界 |
| 17 | `client.js` 不合格只拒该插件 | 一个成员重名的 client 与一个正常 client 同时启用，断言正常那个的成员在帧内可用、重名那个报 `conflict`，且帧仍然跑（`apps/iris-web/tests/plugin-member-merge.test.ts`） |

---

## 10. 分阶段交付

三步，每步可单独合入、单独验收。

**PR-1：安装器泛化 + 清单**
把 `iris-extension-installer` 里与「ST 扩展」有关的**唯一一处**耦合——`requireManifest`（`packages/iris-extension-installer/src/installer.ts:218`，硬编码 `manifest.json` 与 `js` 字段）——提成注入的 artifact 契约：`installAs(id, source, { artifactContract })`，ST 传现有的那份，插件传 `package.json` + `iris.plugin` 那份。其余七个模块（`source`/`hash`/`archive`/`lock`/`staging`/`transaction`/`recovery`）**一行不动**，这就是「泛化而不是 fork」的具体含义。新增 `parsePluginManifest` 与 `SystemPluginManifest` 类型（放 `@iris/plugin-api`，因为它是契约的一部分）。
验收：现有 installer 测试全绿；新增清单解析测试覆盖 §9 的 #7、#10 与全部 `manifest-invalid` 字段；ST 安装路径行为逐字不变（`packages/iris-compat-st-extension/tests/pilot-host.test.ts` 不改一行仍绿）。

**PR-2：安装路径与持久化**
三个 RPC（preview/confirm/cancel）、`<profile>/system-plugins/` 布局、`system-plugins.json` v2 与 v1 升级、开机复核、六个命名失败状态、`SystemPluginView` 的三个可选字段。**不含 UI**，用测试驱动。
验收：§9 的 #1–#14 全绿；v1 profile 升级后 `revision` 不倒退；一个真实的最小插件包（fixture，含 `host.js` 与 `client.js`）走完 preview → confirm → enable → disable → uninstall，且卸载后树不存在；`tampered` 路径下 host.js 从未被 import。

**PR-3：PluginCenter**
安装入口、同意页、`source` 徽标、六个失败状态的中英文案、按 `source` 分叉的卸载文案。
验收：同意页显示 §5.1 返回的每一个字段；英中双语齐全、键盘可达（沿用现有 PluginCenter 的验收条目）；`dev` 徽标在行上和同意页上都出现；浏览器验收脚本与证据落进 `notes/`。

---

## 11. 被否决的方案

- **npm registry 安装**。需要三样本轮没有的东西：一个 registry 信任故事（作用域、2FA、撤回）、一个运行时 npm（宿主不带，`scripts/pack-contracts.mjs` 是从 Node 安装里找 npm 的，那是构建期不是运行期）、以及依赖解析——而依赖解析会把「一棵可哈希的树」变成「一张可变的图」，`treeHash` 当场失效。
- **任意 tarball URL**。没有 commit 这样的天然不可变标识；要补一个「用户自己填 sha256」的步骤，而用户手里的 sha256 与他即将下载的字节之间没有任何独立来源，这是安全剧场。git 的 commit 是**仓库自己**保证的内容标识，这是本质区别。
- **自动更新**。与 commit 钉死直接对立：`assertPinnedCommit` 的拒绝消息里写的就是「会动的 ref 会让锁记录说谎」。自动更新等于让一个**未经同意的新字节集**继承上一次同意的授权。
- **给 git 源加主机白名单**。§4 已说明：白名单对卡片是对的（内容），对同权代码是错的（用户的主动选择），且 `raw.githubusercontent.com` 本来就在卡片白名单里，白名单在这里挡不住任何人。
- **fork 安装器**。八个模块里七个与 artifact 形状无关，fork 会让 §9 的 17 条不变量各有两份实现，其中一份必然先腐烂。PR-1 用一个注入点解决了全部差异。
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
   而那正是问题 4 指出的风险。`capabilities`（插件**提供**什么）仍是另一张自由文本表，两
   者不合并：一个说「我会用到什么」，一个说「我会给出什么」。
5. **安装 id 与内置 id 撞车，在 confirm 阶段以 `install-failed`（id 已被占用）拒绝。** 暂
   不做 `shadowed` 状态：一个装得进去、占着磁盘、却永远不会被激活的行，是 §1 目标 4「失败
   状态全部有名字、能被看见并被处置」的反面。

**PR-1 的落地情况**：裁决 4 已实现——`PLUGIN_PERMISSIONS` 与 `parsePluginManifest`
（`packages/iris-app-service/src/plugins/manifest.ts`）是闭合词表与清单契约，未知权限名以
`manifest-invalid` 拒绝且字段为 `permissions[i]`。裁决 1、2、3、5 都落在 PR-2/PR-3 的面
上，本轮没有写对应代码。

1. **`dev` 源是否进发行版？** 它是唯一一个跳过 `treeHash` 复核的源。选项：(a) 永远可用并永远标 `dev`；(b) 只在开发构建里编译进去，发行版根本没有这条路。本文按 (a) 写，因为 (b) 会让「按发行版调试插件」变成不可能，但 (a) 的代价是发行版里存在一条无字节校验的同权装载路径。
2. **更新事务现在留不留位？** 本轮的更新路径是「卸载后重装」，而卸载删树、重装要重新走完同意。这对一个常更新的插件是明显的摩擦。是否现在就把 `plugin.update({ id, commit })` 的位子留出来（preview 复用、confirm 时把新树促进到同一 id 并保留偏好行），还是等有真实使用者再说？
3. **`tampered` 之后给用户什么出路？** 选项：(a) 只读提示，用户自己卸载重装；(b) 给一个「按记录的 (remote, commit) 重新安装」按钮，它会走完整的同意步骤；(c) 给一个「接受当前字节」按钮，把新 `treeHash` 写进记录——(c) 会让整个机制可被一键绕过，但没有它，一个手动打过补丁的插件就永远卡住。
4. **`capabilities` 本轮只展示不校验，可接受吗？** 宿主没有能力注册表可以校验它（`scope.provide` 的名字是运行时字符串）。同意页会把「仅为作者声明」写在旁边，但一个看起来像权限列表的东西不是权限列表，这本身是个风险。另一个选项是本轮**根本不收**这个字段，等有了注册表再加。
5. **安装 id 与内置 id 撞车怎么办？** `adoptDefinition` 现在对已知 id **返回 `false` 并静默跳过**（`packages/iris-app-service/src/system-plugins.ts:178`），也就是「先到先得，内置赢，且没有任何报告」。本提案需要一个明确答案：在 confirm 阶段就以 `install-failed` 拒绝（id 已被占用），还是允许安装但在目录里标成 `shadowed` 并说明它不会被激活？
