# U6 施工文档 · 加固与清账（四件小事，一支分支）

任务单：`notes/INFRA-TASKS-2026-09-15.md` 的 U6 一节。本文把那四行拆成四个各自独立的小任务——各有证据、设计、施工步骤、牙齿与验收——最后一节是它们合成一支分支时的落地顺序与共同门禁。

## 0. 任务身份

| | |
| --- | --- |
| 分支 | `dev/infra-hardening-batch-2`（一支分支，四件事，四个提交） |
| 基线 | `main` `269a97e`（任务单所在提交；任务单自称基线 `e03adbb`，本文所有行号是 `269a97e` 的证据） |
| ledger（件 1、件 2） | `notes/packages/iris-app-service/DEVIATIONS.md` §85 |
| ledger（件 3） | `notes/apps/iris-web/DEVIATIONS.md` §102 |
| ledger（件 4） | 两条测试都在 `packages/iris-app-service/tests/`，所以也落 app-service ledger；任务单只预留了 §85，本文**追加申请 §86**，与 U1 §81、U2 §82、U3 §83、U5 §84 不冲突 |
| 无 ledger 的包 | `packages/iris-extension-installer` 在 `notes/packages/` 下**没有** ledger 目录（`notes/packages/` 只有 iris-app-service、iris-character、iris-compat-prompt-template、iris-preset、iris-rpc-host、iris-variables 六个），这是 PR-1 已经记过的事实；件 1、件 2 的安装器改动照旧记进 app-service §85 |
| 规模估计 | 件 1 约 60 行产品代码 + 2 条测试；件 2 约 0 行产品代码 + 1 个夹具 + 1 个测试文件；件 3 约 40 行 web 代码 + 2 个文案键 + 2 条测试；件 4 约 30 行测试改动 + 1 处可选的产品 seam。四件加起来是一个中等 PR，**不是**四个 PR 的量 |
| 与谁重叠 | 只与 U1 在 `apps/iris-web/src/app/PluginCenter.tsx` 重叠，且区域不同：U1 动的是行上的更新入口，件 3 动的是 `AssetStatus` 的 `<dl>`（`apps/iris-web/src/app/PluginCenter.tsx:805` 起）。冲突按任务单 §1 的规矩按节序两边保留 |

---

# 件 1 · ST 安装器拒带凭据的远端

## 1.1 前提纠正

任务单说「`validateExtensionSource`（`packages/iris-extension-installer/src/source.ts:49`）今天只查 scheme 与空白/引号，`https://user:token@host/repo` 放行，PR-2 只在系统插件路径上拒了」。**这三句都对**，但有两处要纠正，其中第二处会改变这件事的风险叙述：

1. **行号指向。** `validateExtensionSource` 确实在 `packages/iris-extension-installer/src/source.ts:49`。但 PR-2 写的注释（`packages/iris-app-service/src/plugins/install.ts:206`）和 ledger §80 决策 8（`notes/packages/iris-app-service/DEVIATIONS.md:7576` 起）都把它记成 `source.ts:60`——`:60` 是空白/引号那条分支所在的行，不是函数。改动落地时顺手把这两处引用改成 `:49`，否则件 1 之后它们既过时又指错。

2. **「两条路」里的 ST 那条，今天根本没有 git 源。** 全树里生产代码构造 `{ kind: 'git' }` 的地方只有一处：`packages/iris-app-service/src/plugins/install.ts:736`，系统插件路径，而它上一行 `:735` 就是 PR-2 的 `refuseEmbeddedCredentials`。ST 扩展那条路的入口是 `stExtension.install`（`packages/iris-app-service/src/service.ts:2045`），参数是 `path`，转给 `installFromDirectory`；宿主自己的试点安装在 `packages/iris-app-service/src/index.ts:895`，用的是 `{ kind: 'local-directory' }`。**因此今天没有任何可达的 ST 行为会被这次收紧改掉**——`kind: 'git'` 在 ST 那条路上只出现在测试里（`packages/iris-extension-installer/tests/source.test.ts:17` 起）。

   这不取消这件事，但改变它的理由：收紧的对象是**安装器这个包的契约**（它是 `pack:contracts` 会打出去的包，公开 API 就是 `validateExtensionSource`），不是「修一个正在漏密码的路径」。ledger 里必须这么写，否则下一位读者会以为我们补了一个在线的洞。

## 1.2 现状与证据

- 校验函数：`packages/iris-extension-installer/src/source.ts:49`。git 分支依次查：repository 非空字符串（`:61`，`bad-repository`）、不含空白或引号（`:64`，`bad-repository`）、`assertPinnedCommit`（`:77`，`unpinned-commit`）、然后 scheme——`https://` 放行，`file://` 仅在 `options.allowLocalGit` 下放行（`SourceOptions` 在 `:26`），其余一律 `bad-repository`。userinfo 全程没被看过。
- 两个调用点都在安装器内部：`packages/iris-extension-installer/src/installer.ts:123`（`installAs`）与 `:154`（`stage`）。两处都是进函数第一句，所以在 `validateExtensionSource` 里加检查，两条事务路径同时生效，不需要改调用点。
- 系统插件那侧的重复检查：`packages/iris-app-service/src/plugins/install.ts:216` 的 `refuseEmbeddedCredentials`，`new URL(remote)` 解析失败时**故意返回**（`:222` 起的注释说得很清楚：解析不了的交给安装器的 scheme 检查去拒，那条消息更好），`url.username`/`url.password` 非空则抛 `installFailed`（`:227`）。调用点 `:735`，在构造 `ExtensionSource` 的前一行。
- 记账现状：ledger §80 决策 8（`notes/packages/iris-app-service/DEVIATIONS.md:7576`）把这条明写成「**Open, and deliberately left open**」，并在「What would reopen this」里列出 `(b) The installer refusing userinfo itself, which retires decision 8's asymmetry`。`docs/INFRASTRUCTURE-INTERFACES.md:348` 的 §8 行里，这是「仍然开着的三件事」的第 (2) 条。
- ST 行为参照：`packages/iris-compat-st-extension/` 整个包不碰源校验（它的测试是 `analyze` / `bridge` / `expansion` / `kernel-state` / `manifest` / `pilot-host`，没有一条走 `ExtensionSource`）。所以「不改 ST 行为」这句在代码层面等价于「不改 `local-directory` 分支」。

## 1.3 裁决（来自任务单，不再讨论）

两条路都拒。URL 会进 lock（`packages/iris-extension-installer/src/lock.ts:17` 的 `source: ExtensionSource`，git 分支在 `:57` 起校验 `repository`）、进 `system-plugins.json`、进同意页、进每一次 `plugin.list` 广播。一个写进记录的秘密不是 ST 兼容问题。在 app-service ledger 里记为**有意偏离**：ST 本身接受这种 URL，我们不接受。系统插件路径上那处重复检查改为复用安装器的。

## 1.4 设计

1. `source.ts` 里新增一个私有函数 `refuseCredentialedRemote(repository: string): void`，放在 `validateExtensionSource` 之前。语义与 PR-2 那份**逐字相同**（这是「复用」的实际含义）：`new URL` 解析失败就返回，把拒绝让给 scheme 分支；`username` 或 `password` 非空则抛 `SourceError(…, 'bad-repository')`。
2. 调用位置：`validateExtensionSource` 的 git 分支里，**放在空白/引号检查之后、`assertPinnedCommit` 之前**。理由是错误的优先级要稳定：一个既带凭据又没钉 commit 的 URL 必须报凭据（那是要立刻改掉的东西），而不是报 pin。
3. 错误码用既有的 `bad-repository`，**不新增码**。`SourceError['code']` 没有封闭联合，但每个新码都是 app-service `install.ts:744` 那张码表的一个新行；这里没有需要区分处理的消费者。
4. 消息沿用 PR-2 的那句（`install.ts:227`），因为它已经在同意页、在 ledger、在验收记录里被引用过。
5. app-service 侧：删掉 `refuseEmbeddedCredentials`（`install.ts:216`）及其调用（`:735`），让安装器的拒绝自然抛出。**但要确认它到达用户时仍是 `install-failed`**：`SourceError` 在这条路上如何被翻译成 `SystemPluginFailure`，是施工第一步要读的东西（`install.ts:744` 起的码表注释就是讲这个的）。如果翻译后的 `state` 变了，那是行为回归，必须改翻译而不是留着重复检查。

## 1.5 施工步骤

1. 读 `install.ts:740`–`:760` 那张码表，确认 `bad-repository` 落在哪个 `state`。
2. 在 `source.ts` 加函数与调用；`packages/iris-extension-installer/src/index.ts:33` 已导出 `validateExtensionSource`，无需改导出面。
3. 在 `packages/iris-extension-installer/tests/source.test.ts` 的第一条测试（`:17`）里**追加**——不改既有断言——四个拒绝样本：`https://user@host/repo`、`https://user:token@host/repo`、`https://:token@host/repo`、`file://user@host/repo`（后者带 `allowLocalGit: true`，证明这条检查不是 scheme 的副产品）；以及一个不得被误伤的放行样本：路径里含 `@` 的 `https://host/~user@org/repo`。
4. 删 app-service 的重复检查，改 `install.ts` 与 ledger §80 决策 8 里的 `:60` 引用为 `:49`。
5. 跑 `node --test packages/iris-extension-installer/tests/*.test.ts packages/iris-app-service/tests/plugin-install*.test.ts`。

## 1.6 测试与牙齿

| 断言 | 变红的改动 |
| --- | --- |
| `https://user:token@host/repo` 抛 `SourceError`，`code === 'bad-repository'` | 删掉 `refuseCredentialedRemote` 的调用 |
| `https://host/~user@org/repo` 仍放行 | 把检查写成 `repository.includes('@')` 这种字符串判断，而不是 `new URL` 的 userinfo |
| 带凭据的 remote 走 `plugin.previewInstall` 仍答 `install-failed`（既有测试，`packages/iris-app-service/tests/plugin-install.test.ts` 里 PR-2 留的那条） | 删 app-service 的重复检查而**没有**在安装器里补上——这条是这次改动唯一的回归口，它必须先红后绿 |
| 带凭据 + 未钉 commit 报的是凭据 | 把新检查放到 `assertPinnedCommit` 之后 |

## 1.7 文档与 ledger 更新点

- `notes/packages/iris-app-service/DEVIATIONS.md` §85：写清「ST 本身接受带凭据的 URL，Iris 不接受」是有意偏离；写清 1.1 第 2 点（今天没有可达的 ST git 路径，所以这是契约收紧而不是补洞）；§80 决策 8 的「Open」改成「由 §85 关闭」，「What would reopen this」的 (b) 划掉。
- `docs/INFRASTRUCTURE-INTERFACES.md:348`：三件开着的事去掉第 (2) 条。
- `docs/SYSTEM-PLUGIN-INSTALL.md:63` 那行「源校验」表格项补一句 userinfo。

---

# 件 2 · 「不拉 submodule」补测试

## 2.1 前提纠正（这一件的前提被实测推翻了一半）

任务单要求：造带 `.gitmodules` 与 gitlink 的本地夹具，安装后断言「安装树里该路径为空目录或不存在、`hashTree` 不含子模块任何文件、且 argv 断言仍在」。

我在本机（`git version 2.33.0.windows.2`）按 `materializeGit`（`packages/iris-extension-installer/src/source.ts:162`）的**完全相同的 argv** 跑了一遍，结论有三条，第三条推翻了这件事的默认牙齿假设：

1. **checkout 之后 gitlink 路径是一个存在但为空的目录。** 不是「不存在」。`.gitmodules` 是普通文件，**留在树里，也进 `hashTree`**。所以断言必须写成「该目录存在且为空 / 或不存在」二选一都接受，且**不能**顺带断言 `.gitmodules` 不在——它在。
2. **子模块内容确实没有下来。** 内层仓库里的 `secret.txt` 在安装树里没有任何痕迹。
3. **把 `--no-recurse-submodules` 从 argv 里删掉，甚至换成 `--recurse-submodules`，工作树逐字节相同**——仍然是一个空的 `sub/`。原因是这条路径是 `fetch` + `checkout --detach`，不是 `clone --recursive`，也从不调 `git submodule update`；那个 flag 管的是**要不要连子模块的对象一起 fetch**，而对象不经过 `submodule update` 根本到不了工作树。真正让内容出现的改动只有一个，我也实测了：在 `checkout` 之后加一句 `git submodule update --init --recursive`，`sub/secret.txt` 立刻出现。

   结论：**「安装树里没有子模块内容」这条不变量，是由 argv 里*没有* `submodule update` 守住的，不是由 `--no-recurse-submodules` 守住的。** 树内容断言的牙齿对应的是「有人加了 `submodule update`」，不是「有人删了那个 flag」。这必须写进 ledger 和 `docs/SYSTEM-PLUGIN-INSTALL.md:486`，否则这条新测试会给出一个它没有的保证——正是那一行今天在诚实记录的那种状况。

   （`--no-recurse-submodules` 仍然该留着：它省一次网络往返，并且是声明意图的地方。但它需要**自己的**断言，见 2.5。）

## 2.2 现状与证据

- 固定 argv：`packages/iris-extension-installer/src/source.ts:184`——`fetch --depth 1 --no-recurse-submodules --no-tags origin <commit>`；`:182` 是 `init`，`:183` 是 `remote add`，`:186` 是 `checkout -q --detach FETCH_HEAD`；每次调用都带 `-c core.hooksPath= -c protocol.version=2`（`:168`）。
- `hashTree`（`packages/iris-extension-installer/src/hash.ts:30`）：递归目录，`isSymbolicLink()` 直接抛（`:39`），`isDirectory()` 递归（`:41`），只有 `isFile()` 才产生一行。**空目录贡献零行**——这就是为什么「`hashTree` 不含子模块任何文件」是个天然成立的断言，它单独没有鉴别力，必须和一个「内容出现时会红」的对照放在一起。
- `.git` 在 hash 之前就被删掉（`packages/iris-extension-installer/src/installer.ts:197`），理由在 `:191` 的注释里。
- 夹具工具：`packages/iris-extension-installer/tests/fixtures/helpers.ts:151` 的 `buildGitFixture`——`spawnSync('git', …)`、不过 shell、两个提交、返回 `file://` URL。`packages/iris-app-service/tests/plugin-install.test.ts` 直接用它（`:792` 的钩子测试、`:869` 的「夹具本身是真的」自检）。
- argv 的既有断言：`packages/iris-app-service/tests/plugin-install.test.ts:836`，读 `source.ts` 的**源文本**，断言 `spawnSync('git'` 在、`shell: true` 不在。它没有断言任何一个 flag。
- 现状记录：`docs/SYSTEM-PLUGIN-INSTALL.md:454`（§9 不变量 #5 的应有测法）与 `:486`（「**没有测试**」）。

## 2.3 裁决

做一个真的 gitlink 夹具，加进 `packages/iris-extension-installer/tests/`。

## 2.4 设计

- 新文件 `packages/iris-extension-installer/tests/git-submodule.test.ts`，夹具函数就地写在文件里（不改 `helpers.ts`，避免与别的分支在同一文件追加）。
- **不用 `git submodule add`**。它在 git ≥ 2.38.1 上对 `file://` 子模块默认拒绝（需要 `protocol.file.allow=always`），会让这条测试的绿/红取决于 CI 的 git 版本。改用记录索引项的写法，这是我实测通过的那条：
  - 内层仓库：`git init -q -b main .`，写一个 `secret.txt`，`add -A`，`commit`，`rev-parse HEAD` 取 sha。
  - 外层仓库：`git init -q -b main .`，写正常的插件/扩展文件树 + 一个 `.gitmodules`（`[submodule "sub"]` / `path = sub` / `url = <内层的 file:// 或相对路径>`），`add -A`，然后 `git update-index --add --cacheinfo 160000,<内层 sha>,sub`，再 `commit`。
  - 自检（守夹具的夹具，照 `plugin-install.test.ts:869` 的先例）：`git -C outer ls-files -s` 的输出里必须有一行以 `160000 ` 开头且以 `sub` 结尾。**没有这条自检，整个测试会在夹具退化成「普通目录」时静静变绿。**
- 走真实安装：`Installer.create` + `installAs(id, { kind:'git', repository: fixtureUrl, commit }, { allowLocalGit: true, artifactContract: … })`。外层树需要满足默认的 ST 契约（有 `manifest.json` 且 `js` 指向存在的文件），直接复用 `demoFileMap()`（`helpers.ts:102`）再补 `.gitmodules` 与 gitlink 即可。
- 断言（对应 2.1 的实测）：
  1. 安装树里 `sub` 要么不存在，要么是空目录（`readdir` 长度 0）。两种都接受，并在断言消息里说明为什么接受两种。
  2. 安装树里找不到 `secret.txt`——**全树递归**找，不是只看 `sub/`。这是 (1) 的独立第二道网：一个把子模块内容摊平到别处的实现能过 (1) 而过不了 (2)。
  3. `hashTree(targetPath)` 的 `files` 计数等于「外层自己的文件数」（`demoFileMap()` 的 4 个 + `.gitmodules` + lock）。写成等式而不是「不含某某」，因为不等式对空目录天然成立、没有鉴别力。
  4. `.gitmodules` **在**安装树里且进了 hash——把 2.1 第 1 点钉成断言，这样下次有人「顺手」把它过滤掉时会红，并读到断言消息里的解释。

## 2.5 施工步骤

1. 先在临时目录手工跑一遍 2.4 的夹具序列，确认本机 git 产出 `160000` 索引项（我已跑过，此步是给施工者复核用的）。
2. 写测试，跑绿。
3. 跑牙齿（见 2.6），逐个还原。
4. 给 argv 自己补一条断言：在新测试文件里读 `source.ts` 源文本，断言 `'--no-recurse-submodules'` 出现在 `fetch` 那条 argv 数组里。这是一条**源文本**断言，和 `plugin-install.test.ts:836` 同一形状，作用是「这个 flag 是被有意保留的」，而**不是**冒充行为覆盖。断言消息里要写明 2.1 第 3 点。

## 2.6 测试与牙齿

| 断言 | 变红的改动 | 实测 |
| --- | --- | --- |
| `sub` 为空 / `secret.txt` 不在树里 / `hashTree.files` 等于预期 | 在 `materializeGit` 的 `checkout` 之后加 `run(['-C', dest, 'submodule', 'update', '--init', '--recursive'])` | 已实测：`sub/secret.txt` 出现 |
| 夹具自检（`ls-files -s` 有 `160000` 行） | 把 `update-index --cacheinfo` 那句删掉 | 夹具退化，自检红，主断言仍绿——这正是要它存在的理由 |
| `.gitmodules` 在树里且进 hash | 在安装器里加一条 `.gitmodules` 过滤 | —— |
| argv 源文本断言 | 删掉 `--no-recurse-submodules` | **主断言不会红**（实测：工作树逐字节相同），只有这条源文本断言会红 |

最后一行是这件事最重要的一行，ledger 的牙齿表必须原样带上它。

## 2.7 文档与 ledger 更新点

- `docs/SYSTEM-PLUGIN-INSTALL.md:486`：从「**没有测试**」改成指向新文件，**并**加一句 2.1 第 3 点——这条不变量由「argv 里没有 `submodule update`」守住，flag 本身由源文本断言守住。`:454` 的应有测法一行改成实测出来的形状（空目录，`.gitmodules` 仍在）。
- `docs/INFRASTRUCTURE-INTERFACES.md:348`：三件开着的事去掉第 (3) 条。
- ledger §85：记 2.1 的三条实测（含 git 版本号），记牙齿表。

---

# 件 3 · PluginCenter「浏览器资产」列的量纲

## 3.1 前提纠正

任务单说「前者是目录 `revision` 计数，后者是资产 `rev` 哈希」——对。但「这一列想比的是什么」这个问题，代码给的答案比任务单的措辞更干净：**代码从来没有比过这两个值**。它们只是被并排渲染在两个会让人以为它们该相等的标签底下。真正做判断的那次比较是 `manifest.revision !== revision`（`apps/iris-web/src/app/use-plugin-manifest.ts:541`），两个 number，量纲一致——而这两个 number **一个都没显示在行上**。

所以这不是「比错了」，是「显示的两个数不是判断用的那两个数」。修法随之确定。

## 3.2 现状与证据

- 渲染：`apps/iris-web/src/app/PluginCenter.tsx:819`（`pluginCenterExpectedRevision` → `String(asset.expectedRevision)`）与 `:820`（`pluginCenterActualRevision` → `asset.actualRevision`）。
- 类型：`apps/iris-web/src/app/use-plugin-manifest.ts:130` `expectedRevision: number | undefined`（注释：「The snapshot revision the browser assets should answer for」）、`:132` `actualRevision: string | undefined`（注释：「The content rev actually served for the plugin」）。
- 两个值的来源，逐个追到底：
  - `expectedRevision` 在归约的**每一个分支**里都被赋成同一个东西：`snapshot.revision`（`use-plugin-manifest.ts:529`、`:533`、`:537`、`:541`、`:551`、`:553`、`:559`、`:564`、`:567`）。它是宿主目录的 revision 计数器，`plugin.list` 带来的那个。
  - `actualRevision` 有两个来源，都是**内容哈希**，不是计数：`probe.rev`，即 `manifest.plugins[id].rev`（`:564`、`:567`）；以及删除证据路径上的 `seen.rev`（`:551`）。`rev` 的格式由 `packages/iris-plugin-web-api/src/index.ts:266` 校验：十二位十六进制，bundle 字节的 sha1 前缀。验收记录里看到的 `124631e8264a` 正是这个形状。
- 唯一真正的 revision 比较：`use-plugin-manifest.ts:541`，`manifest.revision !== revision` → `stale`，理由写进 error message，**不进任何一行**。`manifest.revision` 在 `PluginBrowserAssetStatus` 里没有字段。
- 文案：`apps/iris-web/src/app/i18n/strings.ts:1622`/`:1623`（en）与 `:3001`/`:3002`（zh）。
- 既有断言：`apps/iris-web/tests/plugin-center.test.ts:106` 只匹配 `浏览器资产`；`apps/iris-web/tools/render-check.tsx:206`、`:241` 只断言 phase 属性与标签。**没有任何测试读这两行的值**——所以改动的回归风险低，但也意味着改完必须**新增**断言，否则这一列继续没有网。
- 观察记录：`notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md:47`。

## 3.3 裁决

比同一个量，或者拆成两行各自标清。文案键改名要同步两列字典。验收记录末尾加一行状态，不改正文。

## 3.4 设计（拆成两行，各自标清）

两行的选择而不是「让两边同量」，因为代码里**两个量都是真信息**：目录 revision 说「这一页看到的是哪一代目录」，内容 rev 说「这个插件的 bundle 是哪一份字节」。合成一行必然丢掉一个。

1. `PluginBrowserAssetStatus` 加一个字段 `manifestRevision: number | undefined`——聚合清单自称答的那一代。在归约的每个分支里填：`manifest === undefined` 时 `undefined`，其余填 `manifest.revision`（`stale` 分支尤其要填，那一行的整个意义就是这两个数不等）。
2. 行改成三格：
   - 「目录 revision」＝ `expectedRevision`（保留旧键 `pluginCenterExpectedRevision`，**改文案**：en `Catalog revision` / zh `目录 revision`）。
   - 「清单 revision」＝ `manifestRevision`（**新键** `pluginCenterManifestRevision`，en `Manifest revision` / zh `清单 revision`）。这两个并排，量纲相同，`stale` 时肉眼可见地不等。
   - 「资产内容 rev」＝ `actualRevision`（保留旧键 `pluginCenterActualRevision`，**改文案**：en `Asset content rev` / zh `资产内容 rev`），并在 `<dd>` 上加 `data-asset-rev` 属性，让测试能精确取到它而不是靠文本匹配。
3. **键名不改，只改值。** 键名改动要动两列字典 + 所有引用点，而 `i18n.test.ts` 会把缺口报出来；这里没有收益能抵消那次改名的面积。新增的是唯一一个新键。任务单说的「文案键改名要同步两列字典」在这个设计下变成「新增键要同步两列字典」，同样由 `i18n.test.ts` 把关。
4. **不能做的事**：不要拿 `actualRevision` 去和 `expectedRevision` 做比较再渲染一个「一致/不一致」的判断——那会把一个字符串和一个数字的比较写成产品逻辑，正是这件事要消掉的东西。

## 3.5 施工步骤

1. 改 `use-plugin-manifest.ts` 的 interface（`:128`–`:135`）与九个赋值点（`:529`–`:567`）。TypeScript 会把漏掉的分支全部点名，这是这一步的安全网。
2. 改 `PluginCenter.tsx:819`–`:820` 为三格。
3. 加两条字典项、改两对文案（en `:1622`/`:1623`，zh `:3001`/`:3002`）。
4. 加断言（见 3.6）。
5. `npm run check:render`、`npx tsc --noEmit`、`npm run build`。

## 3.6 测试与牙齿

| 断言 | 变红的改动 |
| --- | --- |
| 在 `apps/iris-web/tests/plugin-browser-assets.test.ts` 加一条纯归约测试：`stale` 状态下 `expectedRevision !== manifestRevision` 且两者都是 number | 把 `manifestRevision` 填成 `revision`（即「两边同量」的错误实现） |
| `loaded` 状态下 `actualRevision` 匹配 `/^[0-9a-f]{12}$/` 而 `manifestRevision` 是 number | 把 `actualRevision` 改回渲染 revision |
| `render-check.tsx` 里断言三格都在，且「资产内容 rev」那格的 `data-asset-rev` 值不等于目录 revision 的字符串形式 | 只改文案不加第三格 |
| `plugin-center.test.ts` 的中英两语渲染里各出现一次新文案 | 只加了一列字典 |

`apps/iris-web/tests/plugin-browser-assets-mount.test.ts:92` 那个 `revision: 7` 的夹具是现成的 stale 场景来源，优先在那里造 stale 而不是新写一个。

## 3.7 文档与 ledger 更新点

- `notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` **末尾加一行状态**（不改 `:47` 的正文）：这条观察由 U6 件 3 关闭，指向 web ledger §102。
- `notes/apps/iris-web/DEVIATIONS.md` §102：记 3.1 的纠正（代码从未比较过这两个值）、三格的设计、牙齿表。§97（插件中心的浏览器状态面）加一句指向 §102。
- `docs/INFRASTRUCTURE-INTERFACES.md` §7 的资产面表格若写了这两行的含义，同步。

---

# 件 4 · 两条偶发红的测试

## 4.1 前提纠正

任务单对「只报告一次」的猜测是「两个读者同时扫到同一个坏文件？」。**方向对，但来源不是并发的两个扫描者，而是上一轮回合自己拖在后面的那一次广播**，见 4.3。这个区别决定了修法：不是去重，是测试的观察窗口。

任务单还把这条写成「CI 上报告两次」，读起来像产品缺陷。代码里它不是：`ChatStore.list` 的契约就是「每次列举报告一次」（`packages/iris-app-service/src/chats.ts:301` 的 docblock 明写 `once per listing`），而 `DiagnosticBuffer.record`（`packages/iris-app-service/src/diagnostics.ts:205`）**没有任何去重**，也不该有。两次列举产生两条报告是正确行为。

## 4.2 件 4a · 比例测试改用与负载无关的量

### 现状与证据

- `SCAN_SLACK = 3` 定义在 `packages/iris-app-service/tests/chat-search.test.ts:205`；`SCAN_ROUNDS = 5` 在 `:225`；`timed()` 用 `performance.now()`（`:237`）；两处断言在 `:391`（10 MiB 合成）与 `:500`（677 层语料）。
- 被测实现：`ChatStore.search`（`packages/iris-app-service/src/chats.ts:343`）逐个 chat 读全文，交给 `searchChatText`（`:1146`）；后者 `text.split('\n')`（`:1152`），对每行折一次大小写（`:1168`），只有命中的行才 `JSON.parse`（`:1173`）。这就是被守的不变量：**每字节一次 fold，`JSON.parse` 只落在命中行上**。
- 两条测试的自述已经很诚实：`:341`–`:348` 记着 10 MiB 那条**今天并不能鉴别**二次方退化（实测 `small=19.6ms big=311.1ms allowed=645.7ms`，绿），有牙齿的是语料那条（`452ms against 115ms allowed`）；而语料那条在没有语料的机器上直接 skip（`:423`）。

### 设计：把「工作量」变成可数的量

墙钟是这两条测试唯一的观测量，而墙钟是负载的函数。可数的等价物有两个，都在 `searchChatText` 内部：**折叠过的字符总数**与 **`JSON.parse` 的调用次数**。

- 线性实现：折叠字符数 ≈ 文件字节数；`parse` 次数 = 1（头）+ 命中行数。
- 任务单和 docblock 都点名的那个退化（「每步重折之前所有行」）：折叠字符数 ≈ 字节数 × 行数 / 2，**在 40 行对 400 行的合成夹具上就差两个数量级**——也就是说，改成计数之后，10 MiB 那条测试拿到了它今天没有的牙齿，而且不再需要语料。

seam 的两个选择，按推荐顺序：

1. **给 `searchChatText` 加一个可选的计量出参**，形如 `options.meter?: { foldedChars: number, parsedLines: number, scannedFiles: number }`，由调用方传入一个对象、函数内累加；`ChatStore.search` 把它透传（`chats.ts:362`）。这是这个仓库里已经有的形状——`list(onReport)`（`chats.ts:301`）、`save(entry, onReport)`（`:882`）都是同一手法：产品代码多一个可选出参，测试因此能看见它做了多少事。产品行为零变化，类型上是纯追加。
2. 退路（如果评审不接受产品改动）：测试里临时替换 `JSON.parse` 与 `String.prototype.toLowerCase` 计数，`t.after` 还原。可行（node 的测试文件默认各自进程），但全局补丁的风险不值得省那七行产品代码。**推荐 1。**

### 改法

- 两条测试的**比例断言**从「大扫描的墙钟 ≤ 小扫描墙钟 × 字节比 × SCAN_SLACK」改成「大扫描的 `foldedChars` ≤ 小扫描的 `foldedChars` × 字节比 × 1.1」。宽容度从 3 降到 1.1——**这是收紧，不是放松**：计数没有噪声，1.1 只是留给「行数 vs 字节数」的边角差。
- `parsedLines` 加一条上界：`≤ 命中数 + 文件数`。这条独立地钉住「`JSON.parse` 只落在命中行上」，而墙钟从来钉不住它。
- `SCAN_ROUNDS`、`alternatingMedians`（`:257`）、`timed`（`:237`）、`degraded`（`:275`）**全部删掉**，连同它们那几段解释墙钟为什么难用的注释——留着一个没人调用的中位数机器比留着注释更容易误导。删掉的理由写进 ledger 和替代它的那条断言的消息里。
- 两条测试的**功能半边**（找到、定位、`messageCount === 677`、snippet 含 fragment、gibberish 不造假命中）**一行不动**。语料那条仍然 skip-on-missing-corpus，因为它的功能半边确实需要真文件。
- `SCAN_SLACK` 这个常量本身不再有消费者，一并删。**注意这不是「把 1 改成 >= 1」那类弱化**：被删掉的是一个测不准的量，取代它的断言在同一个夹具上对同一个退化更敏感。

### 测试与牙齿

| 断言 | 变红的改动 |
| --- | --- |
| 10 MiB 合成案的 `foldedChars` 比例 ≤ 1.1 | 把 `searchChatText` 的循环改成每步重折之前所有行（docblock `:344` 点名的那个二次方退化）——**这条今天在墙钟版本下是绿的**，改完必须红 |
| `parsedLines ≤ 命中数 + 文件数` | 把 `:1168` 的「先 `includes` 再 parse」改成无条件 parse 每一行 |
| 语料案同上两条 | 同上（有语料时） |
| `meter` 真的被写过（`foldedChars > 0`） | 忘了透传 `meter`（`chats.ts:362`）——没有这条，上面三条在 `meter` 恒为 0 时全绿 |

最后一行是这组里唯一能自伤的断言，别省。

## 4.3 件 4b · 「只报告一次」：第二次报告的来源

### 我的诊断

**第二次报告来自上一轮回合 `#settle` 末尾那次还没落地的 `#announceChats()`。**

链条，逐环有引用：

1. 测试的夹具用 `handlers['chat.send']` 跑两轮，然后等 `stream.end` 计数（`packages/iris-app-service/tests/chat-integrity.test.ts:91` 记数，`:99` 等待）。
2. `chat.send`（`packages/iris-app-service/src/service.ts:2210`）只返回 `#start` 给出的回合号，生成在后台跑；测试等的是广播，不是 `#settle` 的完成。
3. `#settle` 在 `packages/iris-app-service/src/service.ts:5268` 广播 `stream.end`——夹具的计数器就在这里加一、测试的等待循环就在这里退出——然后**下一句** `:5270` 才是 `await this.#announceChats()`。
4. `#announceChats`（`:4864`）调 `#chatList()`（`:4879`），后者调 `chats.list(message => this.#report(…))`（`:4885`），报告直接进的就是 `debug.reports` 那个缓冲区。
5. `ChatStore.list`（`packages/iris-app-service/src/chats.ts:301`）逐个 `#summarize`（`:953`），头行解析失败就 `onReport`（`:977`）——**每次列举，每个坏文件一条**。
6. 于是：测试在 `:177` 记下 `before`，在 `:178` 写坏文件 `wrecked.jsonl`，在 `:179` 调 `chat.list`（走 `service.ts:2047` → `#chatList()`）。如果第 (3) 步那次悬着的 `#announceChats()` 的目录读**落在 `before` 之后**，它也会扫到 `wrecked.jsonl`，缓冲区里就有两条，`:189`–`:190` 的 `=== 1` 红。本机单跑时那次 announce 早就跑完了；并行负载把它推到窗口里，就红。

这解释了任务单记下的全部现象：CI 上两次、本地单跑绿、而产品侧谁都没错。它**不是**两个读者并发扫同一个文件——`#chatList()` 是「唯一读取列表的地方」（`service.ts:4871` 的注释明写），只是被调用了两次，一次是测试自己叫的，一次是上一个回合欠下的。

### 施工者怎么确认（不要只信我这段推理）

按代价从低到高，做前两条就够：

1. **等对的那个事件。** 夹具的 `broadcast`（`chat-integrity.test.ts:91`）已经拿到每一个事件。把屏障从「数 `stream.end`」改成「数 `chats.updated`」——`chats.updated` 是 `#announceChats` 在 `#chatList()` **返回之后**才发的（`service.ts:4865`），所以等到它，就等到了那次目录读的结束。如果这一改之后并行负载下也不再红，诊断成立。这也正是修法本身。
2. **给第二条报告拍一张调用栈。** 临时在夹具里用一个 `DiagnosticBuffer` 的子类，`record` 里额外存 `new Error().stack`，在负载下跑到红为止，读第二条的栈——应当出现 `#announceChats` ← `#settle`。这一步只用来确认，不进最终代码。
3. **确定性复现（可选，做牙齿用）**：包一层 `ChatStore`，让 `list` 在一个可控的 deferred 上等待，从而把第 (3) 步的 announce 精确地压进测试窗口。用旧屏障跑 → 两条、红；用新屏障跑 → 一条、绿。这是件 4b 唯一能不靠负载就演示的牙齿。

### 改法

- 夹具屏障改成等 `chats.updated`（`chat-integrity.test.ts:91`、`:99` 两行）。**这是变严，不是变松**：新屏障蕴含旧屏障（`chats.updated` 必在 `stream.end` 之后）。
- `=== 1` 那条断言（`:189`–`:190`）**一个字不改**。
- 不加去重。`chats.ts:301` 的契约是「每次列举一次」，`DiagnosticBuffer.record`（`diagnostics.ts:205`）不去重是有意的；在缓冲区里加去重会让两次真实列举的第二次变得不可见，那是把一个测试的时序问题修成一个产品的观测缺陷。
- 同一文件里其它用同一夹具的测试一并受益（屏障是夹具级的）。

### 测试与牙齿

| 断言 | 变红的改动 |
| --- | --- |
| 坏文件在报告缓冲区里恰好一次（`:189`，原样保留） | 把屏障改回 `stream.end` **并且**用 4.3 的 deferred 把 announce 压进窗口 → 两条，红 |
| 夹具真的等到了 announce（新增：屏障退出时 `chats.updated` 计数 ≥ 回合数） | 把屏障写成等任意一个事件 |
| 「一个坏文件没有把别的会话挤出侧栏」（`:181`–`:183`，原样保留） | —— |

## 4.4 文档与 ledger 更新点

- app-service ledger **§86**：两条各写一节。件 4a 写清「删掉的是什么、为什么这不是弱化、新断言在同一夹具上对同一退化更敏感」；件 4b **必须按任务单要求点名第二次报告的来源**，就是 `service.ts:5270` 那次 `#announceChats`，连同 `:5268`/`:5270` 的前后关系和夹具 `:99` 的屏障。
- `notes/INFRA-TASKS-2026-09-15.md` 的 §0 第 7 条（「已知偶发红」）在本 PR 之后失效——但任务单是别人的文件，**不改它**，在 ledger 与 PR 说明里声明它已被本 PR 关闭。
- 若 `notes/DEVIATIONS.md` 有关于「断言不该编码墙钟」的既有条目，§86 引用它而不是重写。

---

# 5. 共同落地

## 5.1 落地顺序（任一前缀停下都是绿的）

1. **件 2**（纯新增测试 + 夹具，零产品改动）。先落，因为它给件 1 之前的安装器建了一道新网，而且它自己不依赖任何别的件。
2. **件 4b**（只改一个测试夹具的屏障）。第二落，因为在后面每一次跑全量时都会少一种噪声红。
3. **件 4a**（`searchChatText` 的 `meter` 出参 + 两条测试改断言）。
4. **件 1**（安装器收紧 + 删 app-service 重复检查）。放在测试类改动之后，因为它是四件里唯一会动生产拒绝行为的一件，要在一个已经安静的全量上跑。
5. **件 3**（web）。最后落：它是唯一需要 `npm run build` 与 `check:render` 的一件，放在最后可以只跑一次 web 那三道门。

每一步单独提交，提交信息里带自己那件的牙齿表。

## 5.2 门禁（任务单 §0 第 4 条，逐条原样跑、原样引用输出）

```
# 仓库根
npx tsc -p . --noEmit
npm test                                   # 要 ℹ fail 0
FORCE_COLOR=0 npm run test:no-corpus       # 现为 40 skipped, 0 failed
node --test apps/iris/tests/md-references.test.ts

# apps/iris-web 目录内
npx tsc --noEmit
npm run build                              # 引用 bootstrap check 那一行
npm run check:render
```

`test:no-corpus` 的 `40 skipped` **必须不变**：件 4a 不新增语料门测试，语料那条 677 层测试的 skip 条件（`packages/iris-app-service/tests/chat-search.test.ts:423`）一字不动。如果这个数变了，说明施工时不小心把语料依赖挪了位置，回去查，不要改数字去迁就。

件 1、件 2 落地后另跑一次窄门禁并引用：

```
node --test packages/iris-extension-installer/tests/*.test.ts packages/iris-app-service/tests/plugin-install.test.ts packages/iris-app-service/tests/plugin-install-rpc.test.ts
```

## 5.3 验收记录的状态行

`notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` **在文件末尾追加一行**，正文（含 `:47` 那条观察）不动：

> 2026-09-1x 状态：「顺手看到」第二条（浏览器资产列的量纲）由 `dev/infra-hardening-batch-2` 件 3 关闭，改为「目录 revision / 清单 revision / 资产内容 rev」三格，记在 web ledger §102。第一条（headless 字体回退）仍然开着。

第一条别顺手关掉——它是字体回退，不在本分支范围内。

## 5.4 文档行

| 文档 | 行 | 改什么 |
| --- | --- | --- |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | `:486` | §9 #5 从「没有测试」改成指向新测试，并加 2.1 第 3 点的限定 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | `:454` | 应有测法改成实测形状（空目录、`.gitmodules` 仍在） |
| `docs/SYSTEM-PLUGIN-INSTALL.md` | `:63` | 源校验一行补 userinfo |
| `docs/INFRASTRUCTURE-INTERFACES.md` | `:348` | 「仍然开着的三件事」删掉 (2) 与 (3)，只剩 `plugin.update`（那是 U1 的事，本分支**不要**碰它） |
| `notes/packages/iris-app-service/DEVIATIONS.md` | §80 决策 8（`:7576`）与「What would reopen this」 | 标记为由 §85 关闭；同处的 `source.ts:60` 引用改 `:49` |

`docs/INFRASTRUCTURE-INTERFACES.md:348` 是 U1 也会碰的那一行：U1 关 (1)，U6 关 (2)(3)。两边都是删子句，冲突时按任务单 §1 的规矩两边保留后手工合成一句。

---

# 6. 风险

1. **用户真实数据里已经记着一个带凭据的 URL。** 从代码回答：开机重校验走 `#adoptRecorded`（`packages/iris-app-service/src/plugins/install.ts:572`），它对 `git` 行做的是**重算 `hashTree` 并和记录比对**（`:594`–`:603`），`record.remote` 只被读来显示 provenance；**没有任何路径在开机时重跑 `validateExtensionSource`**，`packages/iris-extension-installer/src/recovery.ts` 里也没有它的调用。所以收紧之后：已经装好的那一行**照常加载**，秘密照常留在 `system-plugins.json`、lock 与同意页的 provenance 展开里，只有「再装一次」会被拒。这是**预防性收紧，不是清理**。本分支不做迁移（迁移要么删用户的行、要么改写用户的文件，两件都不该由一个加固 PR 顺手做），但 §85 必须写明这个缺口，并给出用户侧的动作：卸载后用不带凭据的 remote 重装。
2. **gitlink 行为随 git 版本变。** 2.1 的三条实测只对 `2.33.0.windows.2` 成立。已知的版本差异至少有两处：（a）git ≥ 2.38.1 默认拒绝 `file://` 子模块（`protocol.file.allow`），这就是 2.4 为什么绕开 `git submodule add` 用 `update-index --cacheinfo`——后者不碰传输层；（b）checkout 留空目录还是不留，理论上是可变的，所以 2.4 的断言 (1) 两种都接受。CI 的 git 版本要记进 ledger，红的时候第一件事是对版本。
3. **件 3 动到既有测试。** 实测过：今天**没有**测试读这两行的值（`plugin-center.test.ts:106` 只匹配标签，`render-check.tsx:206`/`:241` 只看 phase）。风险因此不在回归而在相反方向——改完如果不新增断言，这一列会从「量纲错但没网」变成「量纲对但仍没网」，下一次有人改回去不会红。3.6 的四条是**必须**的，不是可选的。
4. **偶发红的修法可能盖住真缺陷。** 两条都要正面回答：
   - 件 4a：删掉墙钟断言会不会放走一个真的性能退化？会放走「常数因子变慢」（比如每行多一次正则）。代价明说在 ledger 里：换来的是对**阶数**退化的确定性鉴别（今天 10 MiB 那条对它完全无力），并且不再需要语料。如果以后要守常数因子，那需要一个基准库，不是一条 `assert`。
   - 件 4b：把屏障改严会不会掩盖一个真的重复报告？会——如果产品里**另有**一条路径在列举，新屏障也会把它等掉。防这一手的办法在 4.3 的确认步骤 2：拿到第二条报告的调用栈再改，确认栈里只有 `#settle → #announceChats` 这一条来源。**没拿到栈就不要改屏障**，否则修的是症状。
5. **四件合在一支分支上，评审面变宽。** 缓解是 5.1 的提交顺序：四个提交各自可 revert，任一前缀都是绿的。如果评审要求拆 PR，按 (件 2 + 件 4) / (件 1) / (件 3) 拆成三支，ledger 编号照本文分配不变。

---

# 7. 完成报告模板

```
分支：dev/infra-hardening-batch-2
最终 commit：<sha>
基线：main 269a97e

与任务单的偏离（前提纠正，先说）
1. 件 1：ST 那条路今天没有 git 源——生产代码里 kind:'git' 只出现在
   packages/iris-app-service/src/plugins/install.ts:736（系统插件），
   stExtension.install（service.ts:2045）只收目录。收紧的是安装器契约，
   不是在补一个在线的洞。另：任务单与 ledger §80 引的 source.ts:60 应为 :49，已改。
2. 件 2：实测（git <版本>）——删掉 --no-recurse-submodules 后工作树逐字节相同。
   「安装树里没有子模块内容」是由 argv 里没有 submodule update 守住的；
   flag 本身另有一条源文本断言。checkout 留下的是存在的空目录，.gitmodules 留在树里并进 hash。
3. 件 3：代码从未比较过 expectedRevision 与 actualRevision；真正做判断的比较是
   use-plugin-manifest.ts:541 的 manifest.revision !== revision，而那两个数一个都没显示。
   改为三格。
4. 件 4b：第二次报告不是并发的两个扫描者，是 #settle 末尾那次 #announceChats
   （service.ts:5270），测试等的是它前一句 :5268 的 stream.end。修的是夹具屏障，不是去重。

牙齿表
| 件 | 断言 | 让它变红的改动 | 结果 |
| 1  | …    | …              | 红→还原→绿 |
（把 1.6 / 2.6 / 3.6 / 4.2 / 4.3 的五张表合并到这里，逐行标注实际跑过的结果；
 2.6 最后一行「删 flag 主断言不红」要原样带上，它是这次唯一一条主动记下的无牙齿处。）

ledger
app-service §85（件 1、件 2）、§86（件 4）、web §102（件 3）

门禁输出
<逐条原样粘贴 5.2 的七条命令的输出行；test:no-corpus 必须仍是 40 skipped, 0 failed>

文档
docs/SYSTEM-PLUGIN-INSTALL.md :63 :454 :486
docs/INFRASTRUCTURE-INTERFACES.md :348（(2)(3) 关闭，(1) 留给 U1）
notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md 末尾状态行（正文未动）

未做 / 留给下一位
- 已记录在 profile 里的带凭据 remote 不做迁移（风险 1），用户侧动作是卸载后重装。
- 常数因子级的性能退化不再有任何测试守（风险 4），要守需要基准库。
- 任务单 §0 第 7 条的「已知偶发红」在本 PR 之后失效；任务单本身未改。
```
