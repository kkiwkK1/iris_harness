# U1 · `plugin.update` 更新事务 · 施工文档

> 状态：已归档（2026-09-17）。工作已全部落地：#106。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

本文是 `notes/INFRA-TASKS-2026-09-15.md` 里 U1 那一节的施工版：任务单说**要什么**，本文说**在哪儿改、按什么顺序改、每条断言用哪个变异证明它有牙齿**。任务单里已经裁决过的事在 §3 原样抄下来，不再重新讨论；任务单没说而代码逼出来的事，在 §1 和 §3.2 里点名，并给出推荐选项和理由。

所有行号都是 `269a97e`（`origin/main`）这棵树的证据，定位以符号名为准。

---

## 0. 任务身份

| | |
| --- | --- |
| 分支 | `dev/plugin-update-transaction`（从 `origin/main` `269a97e` 开出） |
| ledger | `notes/packages/iris-app-service/DEVIATIONS.md` §81、`notes/apps/iris-web/DEVIATIONS.md` §100 |
| 基线 | `269a97e`（两个 ledger 现在的最后一节分别是 §80 和 §99，编号连得上） |
| 任务单 | `notes/INFRA-TASKS-2026-09-15.md` §0 共同流程、§1 并行性、U1 节 |
| 设计文档 | `docs/SYSTEM-PLUGIN-INSTALL.md` §5 / §6 / §12 裁决 2 与裁决 5 |

**预计规模**（按下面的设计估，不含 ledger 正文）：

| 文件 | 性质 | 量级 |
| --- | --- | --- |
| `packages/iris-protocol/src/system-plugins.ts` | 加 `SystemPluginUpdateOf` 与 `SystemPluginInstallPreview.updateOf` | +30 |
| `packages/iris-protocol/src/rpc.ts` | 改 `plugin.update` 的响应类型与两处注释 | ±25 |
| `packages/iris-app-service/src/plugins/install.ts` | 新 `update()`、`confirm()` 的更新分支、原子替换与回滚 | +220 |
| `packages/iris-app-service/src/system-plugins.ts` | 新 `replaceInstalled()`，`#remember` 的第二个调用者 | +70 |
| `packages/iris-app-service/src/service.ts` | `'plugin.update'` handler 换实现 | ±15 |
| `packages/iris-client-fake/src/plugins.ts` | `update()` 换实现，`confirmInstall()` 的更新分支 | +90 |
| `apps/iris-web/src/client/store.ts` | `updateSystemPlugin` action + 类型 | +40 |
| `apps/iris-web/src/app/PluginCenter.tsx` | 行上的更新入口、同意页的 `updateOf` 行 | +120 |
| `apps/iris-web/src/app/i18n/strings.ts` | 两本字典各约 14 条 | +30 |
| `apps/iris-web/src/app/plugin-center.css` | 更新入口的一小段 | +25 |
| 测试（4 个文件扩，0 个新建，见 §6） | | +450 |
| 文档与 ledger | | +250 |

产品代码约 650 行，测试约 450 行。**不新增 RPC 方法名**——`plugin.update` 已经在静态表里，`packages/iris-protocol/tests/method-names.test.ts` 也不钉总数（它在文件头写明「总数刻意不断言」），所以没有数字要改。

---

## 1. 前提纠正（代码赢）

按 §0 第 2 条，下面五条要写进 PR 说明的第一段。

**1.1 install.ts 里的类叫 `SystemPluginInstallService`，不是 `PluginInstaller`。**
任务单 U1「现状」写的是「`packages/iris-app-service/src/plugins/install.ts` 的 `PluginInstaller`」。树里没有这个名字：类是 `SystemPluginInstallService`（`packages/iris-app-service/src/plugins/install.ts:246`）。`pluginInstaller` 是 `service.ts` 里那个**局部变量与选项名**（`packages/iris-app-service/src/service.ts:1783`，取自 `AppServiceOptions.pluginInstaller`，`packages/iris-app-service/src/service.ts:510`），`requirePluginInstaller()` 在 `packages/iris-app-service/src/service.ts:1784`。改代码时按类名找。

**1.2 `plugin.update` 今天声明的返回类型是 `SystemPluginSnapshot`，而本任务要求它返回 preview。**
`RpcResponseMap['plugin.update']` 现在是 `SystemPluginSnapshot`（`packages/iris-protocol/src/rpc.ts:2411`），注释里写明「更新只改一行目录，所以答和其它生命周期方法一样的快照」。但任务单 U1 要求的语义是：`plugin.update` **走同一条 preview**，确认仍然是 `plugin.confirmInstall`。那么 `plugin.update` 的自然返回就是 `SystemPluginInstallPreview`，答快照是错的——答快照意味着它自己就把树换了，那就绕过了同意页，与 §4 的信任模型和裁决 3「没有一键接受当前字节」的精神相反。

**这是一个协议形状改动，任务单没有点名。** 施工时把 `RpcResponseMap['plugin.update']` 改成 `SystemPluginInstallPreview`，并把那段注释换成「为什么它返回 preview 而不是快照」。请求 schema（`packages/iris-protocol/src/rpc.ts:324`，`{ id, commit }`）**不动**。

**1.3 「旧树改名让开后删除」的顺序，比任务单那句话更严：改名必须在 `promote` 之前。**
任务单写的是「新树促进到同一 `installed/<id>/`，旧树改名让开后删除」，读起来像是先促进、再处理旧树。代码不允许：

- `Installer.promote()` 在取 claim 之前先 `readLock(extensionId)`，非空就抛 `already-installed`（`packages/iris-extension-installer/src/installer.ts:246`）。旧树里有 `lock.json`，所以不让开就一定拒。
- 促进本身是 `fsp.rename(staged.contentPath, target)`（`packages/iris-extension-installer/src/installer.ts:262`），目标目录已存在且非空时这个 rename 会失败。

所以顺序是**先把旧树改名让开，再 `promote`，最后删掉让开的那份**。这也正好给了回滚的落脚点：新代启用失败时把让开的那份改名回来即可（§4.4）。

**1.4 验收里那个「本地 bare 仓库」不是 bare 仓库，而且夹具不在 `plugin-install.test.ts` 里。**
`buildGitFixture`（`packages/iris-extension-installer/tests/fixtures/helpers.ts:151`）建的是一个**带工作区的普通仓库**，只是目录名叫 `fixture-repo.git`；`plugin-install.test.ts` 是它的**使用者**（`packages/iris-app-service/tests/plugin-install.test.ts:30` 导入，`:226` 的 `gitSource()` 调用）。它确实有两个 commit：`olderCommit` 是包内容那棵树，`head` 在它之后多改了一个 `dist/index.js`，返回 `{ repoUrl, head, olderCommit }`。U1 的验收正好用得上这一对——装 `olderCommit`、更新到 `head`，`treeHash` 必变。夹具**不需要改**。

**1.5 `plugin-center.test.ts` 里那条 `doesNotMatch(/plugin\.update|check for updates/i)` 会变红，而删它是被预先授权的。**
`apps/iris-web/tests/plugin-center.test.ts:224` 钉的是「裁决 2 把这个方法预留了，页面不得提供它」。U1 一加更新入口它就红。§0 第 3 条说「不许弱化或删除既有断言」，但 `notes/apps/iris-web/DEVIATIONS.md:6962` 的「什么会推翻这一节」里，PR-3 的作者已经**点名**了这一条：「裁决 2 被改口（`plugin.update` 真的实现了）：那时行上会多一个更新按钮，而 …… 那条 `doesNotMatch` …… 会成为一条必须删掉的断言，删它的人应当在这里读到它当初为什么在」。

所以这是**裁决被改口带来的断言退役**，不是弱化。做法（§6.3）：删掉这一条的同时补上两条更严的——更新入口只出现在 `git` 行、不出现在 `dev`/`builtin` 行；「接受当前字节」的否定断言（`apps/iris-web/tests/plugin-center.test.ts:223`）**保持不动**。在 web ledger §100 里引用 `notes/apps/iris-web/DEVIATIONS.md` §99 的这段话，说明退役是它自己安排的。

---

## 2. 现状

### 2.1 `plugin.update` 今天做什么

三处都在，三处都拒：

- schema：`'plugin.update': z.object({ id: PLUGIN_PACKAGE_ID, commit: PLUGIN_GIT_COMMIT })`（`packages/iris-protocol/src/rpc.ts:324`）。`PLUGIN_PACKAGE_ID` 是 `^[a-z0-9][a-z0-9._-]{0,63}$`（`packages/iris-protocol/src/rpc.ts:259`），`PLUGIN_GIT_COMMIT` 是完整 40 hex（`:261`）。
- handler：`packages/iris-app-service/src/service.ts:1997`，无条件抛 `AppError('unsupported', …)`，消息里点名裁决 2 与「卸载后重装」。注册在 `packages/iris-app-service/src/index.ts:1168`。
- fake：`FakeSystemPlugins.update(id)`（`packages/iris-client-fake/src/plugins.ts:290`）返回 `never`，同样的码同样的话；分发在 `packages/iris-client-fake/src/client.ts:464`。

钉住这三处的测试：`packages/iris-app-service/tests/plugin-install-rpc.test.ts:126`（宿主）、`packages/iris-client-fake/tests/plugin-install.test.ts:122`（fake）、`apps/iris/tests/rpc-transport.test.ts:284`（传输可达性探针）。

### 2.2 preview / confirm / uninstall 今天做什么

- `preview(source)`（`packages/iris-app-service/src/plugins/install.ts:276`）：`Installer.stage()` 停在 `hashed` 阶段 → 体量与 `node_modules` 检查 → `parsePluginManifest` → 组 `SystemPluginInstallPreview` → 存进 `#pending`（`:253`，`PendingPreview` 的形状在 `:196`）。**id 已被占用只进 `warnings`，不拒**（`:329`）。
- `confirm(params)`（`:384`）：从 `#pending` 取记录（取不到即 `install-failed`），逐条比对 `id`/`treeHash`/`commit`**与记录**而不是与重新拉取的结果，然后 `this.#runtime.ids().includes(params.id)` 撞车即拒（`:421`，裁决 5），最后 `git` 走 `installer.promote()`、`dev` 走 `installer.discard()` 加记用户目录，`#publishClientBundle` 发浏览器包（`:727`），`runtime.adoptInstalled()` 落目录行。
- `uninstall(id)`（`:486`）：`git` 行先把 `installed/<id>/` 改名成 `<dir>.removing-<8hex>` 再尽力删（`:492`–`:495`，两次 `fsp.rm`），删资产目录，最后 `runtime.uninstall(id)`。
- 目录侧：`adoptInstalled`（`packages/iris-app-service/src/system-plugins.ts:384`）**在 id 已存在时直接抛** `invalid-request`（`:388`）；`adoptDefinition`（`:305`）对已知 id 返回 `false` 静默跳过；`uninstall`（`:775`）对 `removable` 行连目录行一起删。`#remember(id, patch)`（`:1109`）是唯一一个「只改若干键、不碰其余」的持久化入口，`#commit`（`:1072`）靠 `{ ...before, installed, enabled }` 让 provenance 键穿过每次生命周期迁移。
- 每次写盘都走 `#write(revision)`（`:1143`），整类操作串行在 `#serialize`（`:1181`）里。

### 2.3 UI 今天做什么

`PluginCenter`（`apps/iris-web/src/app/PluginCenter.tsx:164`）：安装表单（`PluginInstallForm`，`:421`）→ `stage()` → `PluginConsent`（导出的纯组件，`:534`）→ `confirm()`（`:316`，回带的四个值全部读自 preview 对象）。行上的 `tampered` 重装按钮走 `reinstall()`（`:285`），它是 `uninstall` → `previewInstall(recorded)` → 同一张同意页。store 侧是 `previewSystemPluginInstall` / `confirmSystemPluginInstall` / `cancelSystemPluginInstall`（`apps/iris-web/src/client/store.ts:1799`、`:1814`、`:1832`），失败文案走 `pluginInstallFailure`（`:1639`，用 `asRpcError().message` 而不是 `describeError`）。

同意页有一条**结构性断言**必须知道：`apps/iris-web/tests/plugin-center.test.ts:298` 把页面上所有 `data-consent-field` 收成集合，和 `Object.keys(preview)` 去掉 `previewToken` 之后比较。**preview 多一个字段，同意页不渲染它，这条就红**。这正是 §4.2 让 `updateOf` 自动获得牙齿的原因。

---

## 3. 裁决

### 3.1 已裁决的（照抄，不重开）

来自 `notes/INFRA-TASKS-2026-09-15.md` 的 U1 节与 `docs/SYSTEM-PLUGIN-INSTALL.md` §12：

1. **更新走同一条 preview。** `plugin.update({ id, commit })` 用行里记录的 `remote` 加新 `commit` 调 `preview()`，返回的 preview 多带 `updateOf: { id, fromCommit, fromTreeHash }`。
2. **确认仍然是 `plugin.confirmInstall`。** echo 里 `id` 等于已装行 id 时视为更新而不是撞车——裁决 5 只拒**新安装**撞已有 id。
3. **原子替换。** 新树促进到同一 `installed/<id>/`，旧树改名让开后删除；目录行更新 `commit`/`treeHash`/`installedAt`，**保留 `enabled`**。
4. **原来 `enabled` 的行**：先 disable 旧代、促进、再 enable 新代；任一步失败回到旧代（旧树还在，因为删除在最后）。
5. **`dev` 与 `builtin` 的 update 是 `unsupported`**，消息说明 dev 就地加载不需要更新。
6. **同意页复用 `PluginConsent`**，多显示「从 `abcd1234…` 更新到 `ef567890…`」与两个 treeHash；行上多一个「更新到…」入口（输入新 commit）。
7. **fake 镜像同样的状态转换。**
8. 裁决 3（`tampered` 的重装按钮）与裁决 5（新安装撞 id 即拒）**保持原样**，U1 不改它们。

### 3.2 留给施工者的决定（每条给推荐与理由）

**D1 · `plugin.update` 的返回类型。** 推荐 `SystemPluginInstallPreview`（见 §1.2）。理由：确认权必须留在 `plugin.confirmInstall` 上，否则更新就是一条绕过同意页的促进路径。

**D2 · 「这是一次更新」这件事记在哪。** 推荐**记在服务端的 `PendingPreview` 上**，`updateOf` 同时进 preview 供页面显示，但 `confirm` 判断更新与否**只读记录、不读 echo**。理由：这条路上的既有教条是「confirm 逐条与事务记录比对，绝不与重新拉取的结果比对」（`packages/iris-app-service/src/plugins/install.ts:13`–`:21` 的模块注释）。如果「是不是更新」由 echo 决定，那么一次普通 `previewInstall`（它对已占用的 id 只给 warning，不拒）再配一个声称自己是更新的 confirm，就把裁决 5 绕过去了。

**D3 · 预览与确认之间目标行消失了怎么办。** 推荐 `install-failed`，消息为「更新的目标行已经不在目录里」，并丢弃整个事务。理由：用户同意的是「把这一行从 A 换到 B」，不是「装一个新的 B」。

**D4 · 新 commit 与当前已装 commit 相同。** 推荐**允许**，并在 preview 的 `warnings` 里加一句「与当前安装的是同一个 commit」。理由：对 `tampered` 行来说，「按记录的 commit 再拉一次」正是裁决 3 要的修复语义；拒绝它会把一个有用的路堵死，而 warning 已经足够让人停下来。

**D5 · `tampered` / `incompatible` 行能不能被 update。** 推荐**能**。理由：`ENABLE_BLOCKING_FAILURES`（`packages/iris-app-service/src/system-plugins.ts:105`）挡的是「拿现有字节去启用」，而 update 是**整棵树按 (remote, commit) 重新取**，取完还要重新哈希——它不是「接受当前字节」，所以裁决 3 拒绝的那件事没有发生。`incompatible` 行更新到一个兼容的 commit，是这条路最有用的一个用例。**后果**：`tampered` 行上从此有两个出口（裁决 3 的重装按钮、U1 的更新入口），两者都走完整同意。**不要删裁决 3 的按钮**——那是在重开一条已落地的裁决；在 web ledger §100 里把这个重叠记下来，留给协调人。

**D6 · 旧树让开到哪个目录。** 推荐 `<installRoot>/superseded/<id>.<8hex>/`，**不要**留在 `installed/` 里。理由：`recoverTargets`（`packages/iris-extension-installer/src/recovery.ts:146`）会 `readdir(installed/)`，把每个条目当作一个 extensionId 看，没有合法 lock 的就删；让开的那份**带着 lock 一起改名**，于是它既不会被这个扫描清掉，又长得像一个装好的插件。放到兄弟目录 `superseded/` 里，这两件事都不会发生，人看目录时也一眼知道那是什么。同卷，`rename` 仍然是原子的。`uninstall` 里既有的 `<dir>.removing-<8hex>`（`packages/iris-app-service/src/plugins/install.ts:492`）**不动**——改它不属于本任务。

**D7 · ESM 模块缓存。这一条是本任务最容易漏掉的失败。**
`#lazyDefinition` 的 `activate` 里是 `await import(pathToFileURL(hostPath).href)`（`packages/iris-app-service/src/plugins/install.ts:676`）。更新后 `hostPath` **字符串不变**（同一个 `installed/<id>/` 加同一个 `manifest.host`）。如果旧代曾经被 enable 过，那个 URL 已经在 Node 的 ESM 模块注册表里；新代 enable 时的 `import()` 很可能拿回**旧模块**——于是一次「成功」的更新，跑的是旧字节，而且**没有任何症状**。

推荐做法：**先证明，再实现**。第一步写一个十几行的探针（写一个 `.mjs`，`import()` 它，改写文件内容，再 `import()` 同一个 URL 与带 `?x=2` 的 URL，打印两次拿到的值），把结果贴进 PR 说明。

- 如果证实缓存会命中：给 `#lazyDefinition` 传一个**代际串**（推荐用该次安装的 `treeHash`），import 的是 `` `${pathToFileURL(hostPath).href}?gen=${generation}` ``。旧模块留在内存里（有界：每个 id 每次更新一份），换来的是新字节真的被执行。
- 如果证实不会命中：把这段结论写进 ledger，代码保持原样，并留一条断言把这个前提钉住（§6.1 的 T7 无论哪种结果都要有，它断言的是「更新后跑的是新字节」，与实现手段无关）。

顺带记一句、但**不在本任务里修**：`SystemPluginRuntime.reload()`（`packages/iris-app-service/src/system-plugins.ts:746`）今天也是重跑 `definition.activate`，对一个装好的包来说它同样受这个缓存影响；`dev` 行改文件后 reload 也是。把它写进 ledger 的「本轮没做什么」。

**D8 · 新代 enable 失败、回滚成功之后，行上还要不要带 `failure`。** 推荐**不带**，命名放在抛出的错误里。理由：`markFailure`（`packages/iris-app-service/src/system-plugins.ts:423`）会把行设成 `enabled = false, status = 'error'`，这与任务单要的「回到旧代」（旧代本来是**开着的**）直接冲突；而 `#commit`（`:1113`）在每次成功迁移时又会清掉 `#failures`，所以「先回滚再打标记」也留不住。做法：回滚成功后 RPC 抛 `SystemPluginInstallError`，`state` 取实际发生的 `load-failed` / `activate-failed`，`reason` 里写明「已回到旧代 `<fromCommit>`」；页面通过 `pluginInstallFailure`（`apps/iris-web/src/client/store.ts:1639`）原样显示这句话。**回滚本身也失败**时是另一回事：那时行确实坏了，走既有的 `#setFailure` 路径，行是 `error`，消息里说明旧树让开到了哪个目录。任务单那句「行回到旧代且 `failure` 命名」按这个读法实现，并在 PR 说明里点出这个读法。

**D9 · 新清单不再声明 `client`。** 旧的 `<dataDir>/system-plugins/<id>/client/client.js` 必须删掉。理由：资产面的 `rev` 是对**文件字节**取 sha1 前 12 位（`packages/iris-app-service/src/plugin-assets.ts:153`），文件还在就还会被列进清单、还会被浏览器加载——更新之后浏览器里跑的是上一个版本的成员。新清单**有** `client` 时不必特别处理：`#publishClientBundle` 覆盖写，`rev` 因字节变化而变化，缓存自然失效。

---

## 4. 设计

### 4.1 形状

```ts
// packages/iris-protocol/src/system-plugins.ts
/** 当一次 preview 是对某个已装行的更新时，它替换的是什么。 */
export interface SystemPluginUpdateOf {
  /** 被更新的目录行 id。等于本 preview 的 `id`。 */
  id: string
  /** 行上现在记着的 commit。 */
  fromCommit: string
  /** 行上现在记着的 treeHash。 */
  fromTreeHash: string
}

export interface SystemPluginInstallPreview {
  // …既有字段一个不动…
  /** 仅由 `plugin.update` 铸造的预览带这个字段；普通安装没有它。 */
  updateOf?: SystemPluginUpdateOf
}
```

`plugin.update` 的请求 schema 不动；响应类型 `SystemPluginSnapshot` → `SystemPluginInstallPreview`（`packages/iris-protocol/src/rpc.ts:2411`）。`plugin.confirmInstall` 的请求形状**一个字节都不加**——更新与否由服务端记录判定（D2），确认方回带的仍然是那四个值。

### 4.2 服务端：`SystemPluginInstallService.update()`

```
update({ id, commit })
  ├ record = runtime.record(id)                     // 没有 → not-found
  ├ record.source !== 'git'                          → unsupported（dev/builtin 各一句话）
  ├ record.remote === undefined                      → install-failed（行上没有 remote，无从更新）
  ├ preview({ kind:'git', remote: record.remote, commit })   ← 同一条路，同样的契约/审计/哈希
  ├ 把 #pending 里那条记录补上 updateOf = { id, fromCommit: record.commit, fromTreeHash: record.treeHash }
  ├ 若 preview.id !== id → 丢弃 staging，install-failed（新 commit 改了包 id，那不是同一个插件）
  ├ 若 commit === record.commit → warnings 追加「与当前安装的是同一个 commit」(D4)
  └ 返回 preview（多带 updateOf）
```

`preview()` 里那句「id 已被占用」的 warning（`packages/iris-app-service/src/plugins/install.ts:329`）对更新是噪音，`update()` 把它从 `warnings` 里去掉，换成 `updateOf` 这条正经信息。

### 4.3 服务端：`confirm()` 的更新分支

`confirm()` 现有的比对**全部保留**（token、`id`、`treeHash`、`commit` 三条 echo 比对，`:399`–`:415`）。改的只有裁决 5 那一处（`:421`）：

```ts
const updateOf = pending.updateOf
if (updateOf === undefined) {
  if (this.#runtime.ids().includes(params.id)) throw installFailed('id 已被占用 …')   // 原样
} else {
  // 更新：目标行必须还在，还是 git，还是同一个 (commit, treeHash)
  const live = this.#runtime.record(params.id)
  if (live === undefined || live.source !== 'git') throw installFailed('更新的目标行已经不在目录里 …')  // D3
  if (live.commit !== updateOf.fromCommit || live.treeHash !== updateOf.fromTreeHash) {
    throw installFailed('这一行在你看到预览之后被换过了 …')
  }
}
```

然后是替换事务（只对 `updateOf !== undefined` 走）：

```
 1. wasEnabled = runtime.isEnabled(id)
 2. wasEnabled → runtime.disable(id)                      // 走既有的 drain / dispose / commit
 3. rename  installed/<id>/  →  superseded/<id>.<8hex>/   // D6；失败即拒，什么都没变
 4. installer.promote(pending.staged, id)                 // 此刻 readLock 为空，已满足其前置条件
 5. 有 client → #publishClientBundle；无 client → 删 <clientAssetRoot>/<id>/  // D9
 6. runtime.replaceInstalled(lazyDefinition(新清单, hostPath), 新 record)     // 保留 enabled 偏好
 7. wasEnabled → runtime.enable(id)
 8. rm -rf superseded/<id>.<8hex>/                        // 只有到这一步才删
```

第 3 步之后的任何一步失败都走 §4.4 的回滚。第 8 步失败**不是失败**：按 `scripts/pack-contracts.mjs:261`–`:277` 的那一课（在本仓库目录里 `rmSync(dir, { recursive: true })` 可能静默无效），删不掉就 `#log` 一行点名那个目录，让人手工清；树已经让开了，不影响正确性。

### 4.4 回滚

```
catch (error) {
  if (已 promote) { rename installed/<id>/ → superseded/<id>.<8hex>.failed/  并尽力删 }
  rename superseded/<id>.<8hex>/ → installed/<id>/          // 旧树回位
  runtime.replaceInstalled(旧 lazyDefinition, 旧 record)      // 目录行回到旧 commit/treeHash/installedAt
  旧清单有 client → 重新 #publishClientBundle（新代可能覆盖过它）
  wasEnabled → runtime.enable(id)                            // 回到旧代
  throw new SystemPluginInstallError({ state, reason: `…已回到旧代 ${fromCommit}` })   // D8
}
```

回滚里的 `enable` 再失败，就让既有的 `#setFailure` 把行记成 `error`（`packages/iris-app-service/src/system-plugins.ts:1115`），抛出的消息里要说明旧树现在在哪个目录。

### 4.5 目录侧：`SystemPluginRuntime.replaceInstalled()`

`adoptInstalled` 对已存在的 id 直接抛（`packages/iris-app-service/src/system-plugins.ts:388`），所以需要第二个入口。它和 `adoptInstalled` 的差别只有三处，其余（`#serialize`、`#assertWritable`、写盘失败时整体回退、`#notify`）逐字一样：

- 允许 id 已存在，**要求**它已存在且 `removable`（不能拿它替换一个 builtin 行）；
- 替换 `#plugins` 里那条 `RuntimePlugin` 的 `definition`，`installed` / `enabled` / `status` / `incarnation` **保持不动**；
- `#persisted` 用 `#remember(id, record)`（`:1109`）**只改 provenance 键**，`installed` / `enabled` 不碰——这就是「保留 `enabled`」的实现处，也是 `#remember` 那句文档注释「(or a provenance key)」第一次有第二个调用者。

调用前 `runtime.isEnabled(id)` 必须为 false（第 2 步已 disable），在方法里断言而不是靠调用约定。

### 4.6 fake 镜像

`FakeSystemPlugins.update(id, commit)`（`packages/iris-client-fake/src/plugins.ts:290`）从 `never` 变成返回 preview：

- id 不在目录 → `not-found`（沿用 `#require`）；
- 行的 `source !== 'git'` → `unsupported`，两句话和宿主一致；
- 否则铸一个 preview，`id` 取**行的 id**（不是 `previewInstall` 那个由源摘要推导的 `demo-<8hex>`，`:199`），`treeHash` 取 `fakeDigest(`${remote} | ${commit}`)`，`updateOf` 取行上 `provenance` 的 `commit` / `treeHash`，存进 `#previews`。

`confirmInstall`（`:238`）的撞车拒绝（`:252`）改成：preview 带 `updateOf` 时不拒，而是**替换**那一行——`version` / `dependencies` / `provenance` 取新 preview，`installed` / `enabled` / `status` **原样保留**。分发处 `packages/iris-client-fake/src/client.ts:464` 把 `commit` 也传进去。

fake 不新增任何 seam（`bundled` 仍是它唯一的注入点，理由见 `notes/apps/iris-web/DEVIATIONS.md` §99）。

### 4.7 UI

**行上的入口。** `PluginRow`（`apps/iris-web/src/app/PluginCenter.tsx:648`）在 `plugin.source === 'git'` 且 `plugin.installed` 时多一个「更新到…」按钮，展开一个只有一个 commit 输入框的内联表单。客户端形状检查复用 `installFormProblem` 的 `COMMIT_SHAPE` 那条分支（`:138`），拒绝分支、tag 与短 sha——和安装表单一个规则、一句文案。`dev` 行改为显示一句「就地加载，改了文件即生效，不需要更新事务」，`builtin` 行什么都不显示。

**同意页。** `PluginConsent`（`:534`）在 `preview.updateOf !== undefined` 时多渲染一个 `data-consent-field="updateOf"` 的 `ConsentField`，内容是「从 `abcd1234…` 更新到 `ef567890…`」加两个 treeHash（旧的取 `updateOf.fromTreeHash`，新的就是 `preview.treeHash`；短写复用 `abbreviate`，`:147`），note 里写「确认后旧树被替换，`enabled` 保留；旧树在新代启用成功前不会被删」。确认按钮仍然读 preview 对象的四个值，一个字不改。

**store。** 新 action `updateSystemPlugin(id, commit): Promise<SystemPluginPreviewResult>`，实现与 `previewSystemPluginInstall`（`apps/iris-web/src/client/store.ts:1799`）同构，失败走 `pluginInstallFailure`。确认仍然走既有的 `confirmSystemPluginInstall`。

**文案键**（两本字典各一份，`apps/iris-web/src/app/i18n/strings.ts`；`apps/iris-web/tests/i18n.test.ts` 不许改）：

`pluginCenterUpdate`、`pluginCenterUpdateOpen`、`pluginCenterUpdateCommit`、`pluginCenterUpdateCommitHint`、`pluginCenterUpdateSubmit`、`pluginCenterUpdateStaging`、`pluginCenterUpdateCancel`、`pluginCenterUpdateRefused`（带 `{detail}` 槽）、`pluginCenterUpdateDevNote`、`pluginCenterUpdateSameCommit`、`pluginCenterConsentUpdateOf`、`pluginCenterConsentUpdateOfValue`（带 `{from}` `{to}` 槽）、`pluginCenterConsentUpdateOfHashes`（带 `{fromHash}` `{toHash}` 槽）、`pluginCenterConsentUpdateOfNote`。

---

## 5. 施工步骤

每一步都能单独编译、单独跑测试。括号里是这一步之后应当变绿的东西。

1. **协议形状**。`packages/iris-protocol/src/system-plugins.ts` 加 `SystemPluginUpdateOf` 与可选的 `updateOf`；`packages/iris-protocol/src/rpc.ts:2411` 改响应类型并重写那段注释；`:324` 上方那段「预留未实现」的注释改写成实现说明。（根 `npx tsc -p . --noEmit` 过；`packages/iris-protocol/tests/method-names.test.ts` 仍绿且无数字可改。）
2. **目录侧**。`SystemPluginRuntime.replaceInstalled()`（§4.5）。此时还没有调用者。（`packages/iris-app-service/tests/system-plugins.test.ts` 扩两条：替换保留 `enabled` 与 `installed`；替换一个 builtin 行被拒。**这是第一条变绿的新测试。**）
3. **D7 探针**。按 §3.2 D7 跑一次 ESM 缓存探针，把结论写进 PR 说明草稿；若需要代际串，这一步把 `#lazyDefinition` 的签名改掉（多一个 `generation` 入参，安装路径传 `treeHash`），既有调用点两处（`packages/iris-app-service/src/plugins/install.ts:463`、`:637`）跟着改。（既有 `plugin-install.test.ts` 全绿——这一步不改行为。）
4. **服务端 update()**。`SystemPluginInstallService.update()`（§4.2）加上 `PendingPreview.updateOf`。（`plugin-install.test.ts` 扩：update 一个 dev 行 / builtin 行被拒；update 一个不存在的 id 被拒；update 返回的 preview 带 `updateOf`。）
5. **confirm 的更新分支与替换事务**（§4.3），不含回滚。（扩：装 `olderCommit` → update 到 `head` → confirm → 行的 `commit`/`treeHash` 变、`enabled` 不变、旧树没了。）
6. **回滚**（§4.4）。（扩：让新代 enable 失败，断言行回到旧代且仍 enabled、错误消息命名状态。）
7. **service.ts handler**。`packages/iris-app-service/src/service.ts:1997` 换成 `await requirePluginInstaller().update(params)`。（`packages/iris-app-service/tests/plugin-install-rpc.test.ts:126` 那条「reserved and refuses」改写成实现版；`apps/iris/tests/rpc-transport.test.ts:284` 的探针不改——它给的是 `no-such-plugin`，现在答 `not-found`，仍然证明 handler 跑到了，它的守卫比的是传输层「没有注册」那句话而不是错误码。）
8. **fake**（§4.6）+ `packages/iris-client-fake/src/client.ts:464`。（`packages/iris-client-fake/tests/plugin-install.test.ts:122` 那条改写成实现版，并加更新成功保留 `enabled` 一条。）
9. **store action**（`apps/iris-web/src/client/store.ts`）。（web `npx tsc --noEmit` 过。）
10. **同意页的 `updateOf` 行**。（`apps/iris-web/tests/plugin-center.test.ts` 的同意页字段集合断言：给它加一个带 `updateOf` 的 preview 并断言该字段渲染。）
11. **行上的更新入口 + 文案键 + CSS**。（`apps/iris-web/tests/plugin-center-install.test.ts` 扩点击流；`npm run check:render` 加更新态同意页与一个 git 行。）
12. **live 脚本的 update 段**（`apps/iris-web/tools/live-plugin-install-check.mjs`，可选，见 §8）。
13. **文档与 ledger**（§7），最后跑门禁（§8）。

---

## 6. 测试与牙齿

「牙齿」= 把这一行改坏，指定的断言必须变红。每条都要真的施加一次再还原，结果列成表进 ledger（§0 第 3 条）。

### 6.1 `packages/iris-app-service/tests/plugin-install.test.ts`（扩，不新建文件）

夹具已经够用：`gitSource()` 给 `olderCommit`，`buildGitFixture` 的 `head` 是第二个 commit。加一个 `gitFixture()` 小工具把 `{ repoUrl, olderCommit, head }` 一起带出来。

| 编号 | 断言 | 让它变红的变异 |
| --- | --- | --- |
| T1 | update 一个 `dev` 行 → `unsupported`，消息说明 dev 就地加载 | 把 `record.source !== 'git'` 的判断去掉 |
| T2 | update 一个 builtin 行 → `unsupported`；update 一个不存在的 id → `not-found` | 同上；把 `record === undefined` 的分支去掉 |
| T3 | `update()` 返回的 preview 带 `updateOf`，三个字段等于行上现有的 id/commit/treeHash | 把 `updateOf` 不写进返回值 |
| T4 | **保留 `enabled`**：装 older、enable、update 到 head、confirm → 行仍 `enabled`，`commit` 与 `provenance.treeHash` 都变了 | 在 `replaceInstalled` 里用 `#persisted.set(id, { ...record, installed: true, enabled: false })` 取代 `#remember` |
| T5 | 旧树真的没了：`superseded/` 下无残留，`installed/<id>/` 的 `lock.json` 记的是新 commit | 把第 8 步的删除去掉（`superseded/` 残留 → 红） |
| T6 | 促进前旧树先让开：在 `promote` 失败的情况下 `installed/<id>/` 仍是旧树 | 把第 3 步的 rename 挪到 `promote` 之后（`already-installed` → 红，且旧树被破坏） |
| T7 | **新代跑的是新字节**：让第二个 commit 的 `host.js` 提供一个不同的 capability 值，更新并 enable 后读到的是新值 | 去掉 D7 的代际串（若探针证实缓存命中，这条立刻红——它是 D7 唯一的证据） |
| T8 | 新代 enable 失败 → 行回到旧代且仍 `enabled`，`commit`/`treeHash` 是旧的，抛出的错误 `state` 是 `activate-failed`、消息含旧 commit | 在回滚里不做 rename-back（旧树不回位 → 红） |
| T9 | echo 的 `treeHash` 与新预览不一致 → 拒，**且旧树不动**（`installed/<id>/` 的 lock 还是旧 commit，`superseded/` 为空） | 把 `treeHash` 比对挪到 rename 之后 |
| T10 | 预览之后目标行被卸载 → confirm 拒（D3） | 去掉 `live === undefined` 分支 |
| T11 | 预览之后目标行被换过（commit 不等于 `updateOf.fromCommit`）→ confirm 拒（D2） | 去掉那条 `live.commit !== …` 比对 |
| T12 | 裁决 5 没被削弱：一次普通 `previewInstall` 装到已占用 id 上，confirm 仍然 `install-failed` | 把更新判定改成读 `params.id` 在目录里就算更新（**这就是 D2 要挡的那个洞**） |
| T13 | 新清单不再声明 `client` → 资产目录下的旧 `client.js` 没了（D9） | 去掉删除那一句 |

### 6.2 其它宿主侧

- `packages/iris-app-service/tests/system-plugins.test.ts`：`replaceInstalled` 保留 `installed`/`enabled`；替换 builtin 行被拒；替换不改 `incarnation` 之外的生命周期字段。变异：把 `#remember` 换成整行覆盖。
- `packages/iris-app-service/tests/plugin-install-rpc.test.ts`：`:126` 那条「reserved and refuses」**改写**成「`plugin.update` 对一个 git 行返回 preview、对 dev 行 `unsupported`」。`INSTALL_METHODS`（`:31`）不动，注册与 schema 探测继续覆盖它。
- `packages/iris-client-fake/tests/plugin-install.test.ts`：`:122` 那条改写成实现版；加一条 fake 的更新保留 `enabled`。变异：让 fake 的 confirm 在更新时把 `enabled` 置 false。
- `apps/iris/tests/rpc-transport.test.ts`：**不改**。确认它仍绿（现在答 `not-found` 而不是 `unsupported`，守卫比的是「没有注册」那句话）。

### 6.3 web 侧

- `apps/iris-web/tests/plugin-center.test.ts`：
  - 删 `:224` 那条 `doesNotMatch(/plugin\.update|check for updates/i)`（§1.5，预先授权），**同时**补两条更严的：更新入口出现在 `git` 行、不出现在 `dev`/`builtin` 行（按按钮自己的 `data-plugin-update` 属性匹配，不要匹配 `<article>` 也带的 `data-plugin-source`——`notes/apps/iris-web/DEVIATIONS.md` §99 的变异 3 就栽在这个上面）。
  - `:223` 的「没有接受当前字节」**保持不动**。
  - 同意页字段集合（`:298`）：加一个带 `updateOf` 的 preview，断言 `data-consent-field="updateOf"` 出现。变异：在 `PluginConsent` 里不渲染该字段 → 集合比较变红。
- `apps/iris-web/tests/plugin-center-install.test.ts`：点击流——git 行点「更新到…」→ 输入 commit → 提交 → 同意页显示 `updateOf` → 确认。**断言落在记录下来的 RPC 参数上**（先 `plugin.update` 再 `plugin.confirmInstall`，后者回带的 `treeHash` 等于 preview 的），不是落在 DOM 上；这是该文件既有的规矩。变异：把确认的 `treeHash` 接到 `updateOf.fromTreeHash` 上 → 红。
- `apps/iris-web/tests/i18n.test.ts`：**不改**。新键两本字典各一份、槽一致，它自己会红。
- `npm run check:render`：加一张带 `updateOf` 的同意页和一个带更新入口的 git 行。

---

## 7. 文档与 ledger

| 文件 | 改什么 |
| --- | --- |
| `docs/SYSTEM-PLUGIN-INSTALL.md` §12 | 裁决 2 的「PR-2 的落地情况」与「PR-3 的落地情况」两条从「已实现为拒绝」「落地为没有按钮」改成「**已改口并实现**」，注明是 2026-09-15 第二批 U1，并保留原文说明它当初为什么是拒绝 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` §5 | 新增 5.4「更新事务」：`plugin.update` → preview（带 `updateOf`）→ `confirmInstall` → 替换与回滚，并把 §5.3 的时序图补一条更新分支 |
| `docs/SYSTEM-PLUGIN-INSTALL.md` §6 | `superseded/` 这个新目录名与它为什么不在 `installed/` 下（D6） |
| `docs/INFRASTRUCTURE-INTERFACES.md` §3 | 第 121 行 `plugin.update` 那一行：「**预留未实现**」→ 实现说明（参数、返回 `SystemPluginInstallPreview`、dev/builtin 答 `unsupported`）。**静态方法数不变**（没有新方法名），不要动任何被钉住的数字 |
| `docs/INFRASTRUCTURE-INTERFACES.md` §8 | 「系统插件的包外安装路径」那一行（第 348 行）里「仍然开着的三件事」的第 (1) 条闭合；(2)(3) 是 U6 的，不要碰 |
| `docs/PLUGIN-AUTHORING-RUNBOOK.md` | 「**更新**」那一段（第 312 行附近）整段改写：作者发新 commit 之后用户怎么更新、同意页上多看到什么、`enabled` 会保留 |
| `notes/packages/iris-app-service/DEVIATIONS.md` §81 | 新节。必须写到：§1 的五条前提纠正；D2（为什么更新性由记录决定而不是 echo）；D6；**D7 的探针结果**；D8（为什么行上不留 `failure`）；牙齿表；以及「本轮没做什么」——`reload` 的同一个缓存问题、裁决 3 按钮与更新入口的重叠（D5） |
| `notes/apps/iris-web/DEVIATIONS.md` §100 | 新节。必须写到：`doesNotMatch` 那条断言的退役，并引用 `notes/apps/iris-web/DEVIATIONS.md` §99 自己安排了这次退役；同意页 `updateOf` 行；牙齿表 |
| `notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` | 只有跑了 §8 的 live 验收才加一个新小节，正文不改 |

`docs/SYSTEM-PLUGIN-INSTALL.md` 第 439 行那句「整棵树里没有任何 `plugin.update` 的入口（裁决 2）」也要跟着改，否则它在合入当天就是假的。

---

## 8. 门禁与验收

### 8.1 门禁（§0 第 4 条，全部跑，原样引用输出）

```
npx tsc -p . --noEmit                       # 根，exit 0
cd apps/iris-web && npx tsc --noEmit        # exit 0
cd apps/iris-web && npm run build           # 引用 bootstrap check 那行
cd apps/iris-web && npm run check:render    # ok
npm test                                    # 根，ℹ fail 0
FORCE_COLOR=0 npm run test:no-corpus        # 现为 40 skipped, 0 failed
node --test apps/iris/tests/md-references.test.ts
```

已知偶发红：`chat-search.test.ts` 的比例断言、`chat-integrity.test.ts` 的「只报告一次」。若全量只红这两条之一，重跑一次并把两次输出都贴出来（§0 第 7 条；根治是 U6 的事）。

### 8.2 U1 专属验收

**一、两个 commit 的本地仓库，走完整条路。** 用 `buildGitFixture`（`packages/iris-extension-installer/tests/fixtures/helpers.ts:151`，注意它建的是带工作区的普通仓库，不是 bare，见 §1.4）：装 `olderCommit` → `enable` → `plugin.update({ id, commit: head })` → `confirmInstall` → `plugin.list` 里 **`enabled` 不变、`commit` 变、`provenance.treeHash` 变**。这条已经作为 T4 进了 `plugin-install.test.ts`，是可重跑的门禁，不是一次性证据。

**二、宿主实测**（协调人会做，自己先做一遍更好）：在**复制**的数据目录上起宿主（`apps/iris/data` 的副本，端口 8788+；一个数据目录一个宿主，`host.lock` 没有旁路），RPC 直连走一遍 update 路径。**起之前先确认端口是空的**——端口被占的表现是 EADDRINUSE 起不来，不是「换个端口起」。

**三、live 脚本的 update 段**（可选）。`apps/iris-web/tools/live-plugin-install-check.mjs` 现在只走 `dev` 包（它的用法在文件头，`<appPort> <devPackageDir> <outDir>`），要加 update 段就得先给它一个 `git` 包：多一个可选参数 `<gitRemote> <commitA> <commitB>`，按 `step()` 的格式记 `update.consentShowsUpdateOf`、`update.rowKeptEnabled`、`update.commitChanged` 三步。做了就把证据追加成 `notes/PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md` 的一个新小节（截图不提交，理由那份文件里已经写了）。

---

## 9. 风险与回滚

**R1 · 半路断电。** 第 3 步（旧树让开）与第 4 步（促进）之间崩溃：`installed/<id>/` 不存在，目录行还指着它。下次开机 `scanInstalled()`（`packages/iris-app-service/src/plugins/install.ts:515`）走 `#adoptRecorded`，`stat` 失败，行被标成 `install-failed`「the installed tree for … is missing」（`:581`）——行还在、看得见、能卸载，这是既有行为，不是新失败。**但 `superseded/` 下还躺着一棵完好的旧树**，人可以手工改回去。在 §7 的文档里写清这个手工步骤。

**R2 · 删不掉。** 第 8 步删 `superseded/` 在本仓库目录里可能静默无效（`scripts/pack-contracts.mjs:261` 那一课）。设计已经按「改名让开、尽力删、删不掉按名提示」做：删不掉不影响正确性，只是磁盘上多一份，日志点名。**不要**把「删成功」写成断言——那会让一条正确的实现在某些机器上变红。

**R3 · 旧代还开着的时候促进。** 设计要求先 disable 再 rename（第 2、3 步）。反过来做，Windows 上一个被 `import()` 过的文件所在的目录可能改不了名，而且旧代的 fiber 还在跑、还持着 lease。`runtime.disable()` 会走完 drain 与 dispose（`packages/iris-app-service/src/system-plugins.ts:851`），这是等它真的停下来的唯一正当方式。

**R4 · ESM 缓存（D7）。** 最危险的一条，因为它**没有症状**：更新「成功」，行显示新 commit 新 treeHash，跑的是旧代码。唯一的防线是 T7 那条断言（新代必须观察到新字节），而 T7 只有在夹具的两个 commit 的 `host.js` **行为不同**时才有牙齿——`buildGitFixture` 现在的第二个 commit 只改 `dist/index.js`，所以这条测试要自己造一对 host.js 不同的 commit。**夹具选错，测试和牙齿会一起沉默。**

**R5 · 裁决 5 被顺手削弱。** 更新分支就在裁决 5 的拒绝旁边，很容易写成「id 在目录里就算更新」。T12 是专门挡这个的，它必须先于更新分支写好。

**R6 · 并行分支的重叠。** 按 §1 的并行性表，U1 与 U6 在 `PluginCenter.tsx` 的**不同区域**相遇（U6 改的是资产列）。冲突按节序两边保留、不改内容。`docs/INFRASTRUCTURE-INTERFACES.md` §8 那一行 U1 与 U6 都要碰（U1 闭合第 (1) 条，U6 闭合第 (2) 条），先落地的那支写完，后落地的只加自己那半句。

---

## 10. 完成报告模板

发给协调人时照填，缺一项都要说明为什么缺。

```
分支：dev/plugin-update-transaction
最终 commit：<sha>
基线：269a97e

与任务单的偏离（实测推翻的前提）
  1. install.ts 的类是 SystemPluginInstallService，不是 PluginInstaller
  2. plugin.update 的响应类型从 SystemPluginSnapshot 改成 SystemPluginInstallPreview（任务单未点名的协议改动）
  3. 旧树必须在 promote 之前让开（installer 的 already-installed 与 rename 目标非空）
  4. 验收夹具不是 bare 仓库，且在 iris-extension-installer/tests/fixtures/helpers.ts
  5. plugin-center.test.ts 的 doesNotMatch 退役，依据 web ledger §99 自己的安排
  <其余实测发现>

D7 探针结果
  <import() 同一 URL 在文件内容改变后是否返回旧模块；做了什么；T7 用哪个夹具证明>

牙齿表
  | 断言 | 变异 | 结果 |
  | ---- | ---- | ---- |
  | T1…T13、web 侧各条 | | 红/绿 |
  （凡是施加了变异却**没有**变红的，原样记下来，不要藏）

门禁输出
  npx tsc -p . --noEmit                 → exit <n>
  apps/iris-web npx tsc --noEmit        → exit <n>
  apps/iris-web npm run build           → <bootstrap check 那行>
  apps/iris-web npm run check:render    → <ok>
  npm test                              → <tests/pass/fail/skipped，一次干净运行>
  FORCE_COLOR=0 npm run test:no-corpus  → <n skipped, 0 failed>
  node --test apps/iris/tests/md-references.test.ts → <n pass>

验收
  两 commit 仓库：enabled 不变 / commit 变 / treeHash 变  → <实际值>
  宿主实测（端口、数据目录副本）→ <做了/没做，为什么>
  live 脚本 update 段 → <做了/没做>

ledger
  notes/packages/iris-app-service/DEVIATIONS.md §81
  notes/apps/iris-web/DEVIATIONS.md §100
  docs/INFRASTRUCTURE-INTERFACES.md §3 与 §8 是否同一个 PR 改的：<是>
```
