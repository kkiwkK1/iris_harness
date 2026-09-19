<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">系统插件安装</h1>

<p align="center">查看来源与声明，确认安装，再决定是否启用。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

## 1. 支持范围

支持从本地开发目录或固定提交的 HTTPS Git 仓库安装 Node 系统插件。安装、启停、更新、卸载使用同一控制面。

不支持 npm 包名、任意 tarball URL 或自动更新。ST 扩展有单独入口，见[插件开发指南](PLUGIN-AUTHORING-RUNBOOK.md#st-扩展入口)。

> [!WARNING]
> 系统插件与宿主同权，能访问本机文件和网络。权限声明不是安全沙箱，只安装可信来源的代码。

## 2. 最短操作流程

1. 打开 **设置 → 插件**，选择本地 dev 目录或 Git 来源。
2. Git 来源填写 HTTPS 地址与完整 40 位提交。
3. 核对预览中的名称、id、版本、来源、入口、依赖、权限、能力和警告。
4. 确认安装。新插件默认停用，预览与确认均不执行插件。
5. 单独启用，查看运行状态与失败详情。

发现 `tampered` 时，按记录来源重新安装并重新确认，不用“接受当前字节”替换哈希。

## 3. 包格式与清单

包根目录包含 `package.json`，在 `iris.plugin` 中声明：

| 字段 | 含义 |
| --- | --- |
| `id` | 最多 64 字符，小写字母/数字开头，后续可含点、下划线、连字符 |
| `apiVersion` | 当前接受 `1` 或 `"1.0"` |
| `host` | 包内入口，默认导出 definition 对象，不是工厂 |
| `displayName`、`description` | 用户可见说明 |
| `client` | 可选浏览器成员 bundle |
| `i18n` | 可选，须同时含 `en` 和 `zh` 文件 |
| `dependencies` | 依赖插件 id |
| `capabilities` | 提供的能力，自由文本声明 |
| `permissions` | 使用的权限名，闭合词表 |

身份与版本需满足清单和 definition 的一致性要求。示例见[开发指南](PLUGIN-AUTHORING-RUNBOOK.md#包清单)，校验见 [`manifest.ts`](../packages/iris-app-service/src/plugins/manifest.ts)。

入口路径必须落在包内；拒绝越界、符号链接、junction、`node_modules`。安装树最多 256 MiB / 20,000 个文件，不能依赖安装脚本或运行时在线补包。

权限名为 `get-dependency`、`host-context`、`plugin-storage`、`provide-capability`、`register-rpc`、`write-variables`。存储接口实际检查 `plugin-storage`；其他声明不是完整的权限强制机制。

## 4. 安装源与信任

| 来源 | 行为 | 注意 |
| --- | --- | --- |
| `builtin` | 随 Iris 提供 | 同一生命周期管理 |
| `dev` | 就地读取目录 | 不复制、不做开机哈希复核，始终标 dev |
| `git` | 获取固定提交 | 记录来源、commit、树哈希，开机复核 |
| ST 扩展 | 兼容入口接纳 | facade iframe，不等同于 Node 宿主插件 |

Git 地址拒绝凭据、空白和引号；分支、标签、短 SHA 不能替代完整提交。安装固定参数调用 Git，不执行包管理器、安装脚本、Git hooks，也不拉取子模块。

系统插件 Git 来源不使用卡片脚本白名单，但固定提交和完整确认不可省略。

## 5. 安装与更新

### 5.1 预览

`plugin.previewInstall` 接受 dev 路径或 Git 来源，校验清单与安装树，返回 `SystemPluginInstallPreview`。只读取和检查字节，不 import `host.js`。

界面展示身份、版本、来源、入口、声明、依赖、警告，以及用于确认的令牌和哈希，不只显示名称。

### 5.2 确认与取消

`plugin.confirmInstall` 原样回传预览的 `previewToken`、`id`、`commit`、`treeHash`；dev 的 `commit` 为 `null`，不由浏览器猜测。

确认再次核对安装树。过期令牌、字段不匹配、树变化、id 被占用都会拒绝；预览成功不是最终校验。取消用 `plugin.cancelInstall({ previewToken })` 丢弃暂存事务。

### 5.3 同意页

同意页分别解释 `capabilities`（提供什么）、`permissions`（声明使用什么）和同权执行风险；dev 额外说明不做开机字节复核。未展示的新字节不能继承旧确认。

### 5.4 更新

已装 Git 插件调用 `plugin.update({ id, commit })`，沿用记录远端，返回带 `updateOf` 的预览，再走同一同意页和 `plugin.confirmInstall`。

成功保留启用偏好，失败回滚旧版本。dev 和内置插件没有这条 Git 更新入口。**更新已实现**，旧裁决中的“只预留方法”已被后续更正取代。

## 6. 存储与卸载

profile 的 `system-plugins.json` v2 保存目录、偏好和来源。Git 安装树在 `system-plugins/installed/<id>/`，开机先复核再加载，哈希不符标 `tampered`，不执行。

用户数据另存 `plugin-data/<id>/`：

| 操作 | 代码 | 用户数据 |
| --- | --- | --- |
| 禁用 | 保留 | 保留 |
| Git 更新 | 替换，失败回滚 | 保留 |
| Node 包卸载 | 删除受管理安装树和目录行，不删除 dev 原目录 | 默认保留 |
| 显式删除数据 | 按卸载流程处理 | `plugin.uninstall` 的 `removeData: true` 请求删除，失败报告残留 |
| ST 卸载 | 保留安装树 | 保留设置 |

有启用中的依赖者时先停用依赖者。不能直接删文件绕过任务排空与资源释放。

## 7. 加载与失败状态

| 状态 | 含义与处理 |
| --- | --- |
| `install-failed` | 来源、事务或 id 冲突，修正后重新预览 |
| `manifest-invalid` | 清单或结构不合法 |
| `incompatible` | API 等契约不兼容 |
| `tampered` | 树哈希不符，按记录来源重新安装 |
| `load-failed` | 入口加载失败，修正后可重试启用 |
| `activate-failed` | 激活失败，部分资源回收后可重试 |
| `hook-failed` | writer 抛错或超时；仍启用，下次成功提案清除 |

前四类不能反复点“启用”绕过校验；`hook-failed` 不表示安装失败或已停用。

## 8. 界面与浏览器资产

插件中心显示来源、状态、声明、依赖和失败详情；安装错误保留具体原因，不用笼统“请求无效”覆盖。

浏览器资产只对已启用插件提供；成员冲突或坏 bundle 只拒绝该插件，不拖垮整个帧。见[接口参考第 5 节](INFRASTRUCTURE-INTERFACES.md#5-浏览器契约资产面成员合并与-ui-插槽)。

## 9. 安全不变量与测试

修改安装器至少验证：

- 非 HTTPS、可变 ref、带凭据 URL、hooks、子模块；
- 越界、链接、`node_modules`、超限安装树；
- 篡改哈希、过期预览、确认字段被改、id 冲突；
- 确认后默认停用，更新失败保留旧代；
- 开机发现篡改后入口从未 import；
- 默认保留用户数据，显式删除失败不伪报成功。

哈希排除 Git 元数据和安装锁。子模块行为由“不运行 `submodule update`”保证，`--no-recurse-submodules` 的文本断言不能冒充独立行为证据。

测试：[安装服务](../packages/iris-app-service/tests/plugin-install.test.ts) · [RPC](../packages/iris-app-service/tests/plugin-install-rpc.test.ts) · [子模块](../packages/iris-extension-installer/tests/git-submodule.test.ts) · [界面](../apps/iris-web/tests/plugin-center-install.test.ts)。

## 10. 实现与验收出处

清单、安装事务和插件中心已交付。更新、存储、文案等能力现状统一维护在[接口参考](INFRASTRUCTURE-INTERFACES.md)。

[2026-09-15 验收记录](../notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md)区分实际走过的 dev 流程和未在浏览器走过的 Git 流程，不扩大其结论。

## 11. 不提供的安装方式

| 方式 | 原因 |
| --- | --- |
| npm registry | 尚无对应信任、依赖解析与可复现方案 |
| 任意 tarball URL | 缺少当前流程依赖的固定提交身份 |
| 自动更新 | 新字节需要重新确认 |
| 接受篡改字节 | 绕过哈希锁定 |
| 附带 node_modules | 避免重复框架实例和不可控依赖 |
| 单独 fork 安装器 | 复用事务、恢复与路径检查，通过 artifact 契约扩展 |

## 12. 历史决策

保留原始裁决与后续更正用于追溯。**今天的操作以第 5、6 节为准**；旧文中的“更新未实现”等说法已被后续更正取代。

<details>
<summary>展开原始裁决记录（2026-09-15）</summary>
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

</details>
