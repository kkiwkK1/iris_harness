# 系统插件安装路径浏览器验收（2026-09-15）

## 验收身份

- **被验收的树**：`dev/plugin-install-center`，基线 `main` `1066381`（PR-2 已合入）加上 PR-3 的工作树改动，尚未提交时运行；即本文随之合入的那一个 PR 的内容。
- **宿主**：从上述工作树以 `node apps/iris/bin.ts` 启动，`IRIS_PORT=8788`，`IRIS_DATA_DIR` 指向 `apps/iris/data` 的一份**复制**（一个数据目录只能有一个宿主，#72 起；复制件跑完即删）。
- **浏览器**：本机 Chrome（`--headless=new`），由 `apps/iris-web/tools/live-plugin-install-check.mjs` 通过 CDP 驱动。
- **被安装的包**：一个三文件的 `dev` 包（`package.json` 含 `iris.plugin`、`host.js` 默认导出一个 `provide('livedemo.state', …)` 的定义、`client.js` 一行 `registerPluginMembers('livedemo', …)`），id `livedemo`，在仓库外的临时目录里。
- **产品代码、manifest、lockfile**：本次验收未改动。

## 为什么还要这一步

`docs/SYSTEM-PLUGIN-INSTALL.md` §10 的 PR-3 验收项里有一条「浏览器验收脚本与证据落进 `notes/`」。PR-3 的施工把它记为**未做**，理由是 `check:render` 与 jsdom 点击测试都是可重跑的门，一次手工会话不是。这个理由对了一半：门证明的是「组件按投影渲染、点击发出正确的 RPC 参数」，没有证明的是「一个真浏览器对着一个真宿主、一个真包，页面上确实画出了这些东西」——源码与部署产物、夹具与真实输入之间的两道缝，jsdom 跨不过去。所以把脚本写成仓库里的量具，跑一次，把结果记在这里。

## 走过的路径与看到的东西

`steps.json` 逐条（值原样抄录；`ok` 一列全部为真，脚本以 exit 0 结束）：

| 步 | 观察 |
| --- | --- |
| `list.builtins` | `["tavern-helper:builtin:enabled","mvu:builtin:enabled"]` —— 两个内置行，来源徽标 `builtin` |
| `form.devModeShowsOnePathInput` | `1` —— 选 dev 后表单只剩一个「目录路径」输入 |
| `consent.fields` | 17 个 `data-consent-field`：`id, displayName, description, version, apiVersion, supportedApiVersions, compatible, source, path, treeHash, fileCount, sizeBytes, capabilities, permissions, dependencies, hasClient, warnings` —— 即 `SystemPluginInstallPreview` 除 `previewToken` 的全部键（dev 源没有 `remote`/`commit`，多 `path`） |
| `consent.permissionsListsDeclared` | `true` —— 权限列表里有 `provide-capability` |
| `consent.permissionsSaysNotABoundary` | `true` —— 旁边的句子含「不是 Iris 强制的边界」 |
| `consent.sourceMarkedDev` | `"来源dev 本地"` —— 裁决 1：dev 在同意页上显式标出 |
| `consent.confirmEnabledForCompatible` | `false`（即未禁用）—— 兼容的预览可以确认 |
| `consent.cancelPresent` | `true` |
| `row.afterConfirm` | `{"source":"dev","status":"disabled","badge":"dev 本地"}` —— 安装不等于启用 |
| `row.enabled` | `"enabled"` —— 行内「启用」按钮之后 |
| `row.showsProvenance` | `true` —— 行上有树哈希与目录 |
| `list.afterUninstall` | `["tavern-helper","mvu"]` —— 行已消失 |
| `dev.directoryUntouched` | `["client.js","host.js","package.json"]` —— 与安装前逐字相同 |
| `page.exceptions` | `[]` —— 全程页面无未捕获异常 |

宿主侧：`plugin.previewInstall` → `plugin.confirmInstall` → `plugin.enable` → `plugin.disable` → `plugin.uninstall` 五个调用全部由页面自己发出，宿主 stderr 中 `[E]` 行数为 0。

同一份 `dev` 包在 PR-2 落地前已经用 RPC 直连在同一端口走过一遍（见 `notes/packages/iris-app-service/DEVIATIONS.md` §80 的实机验收段），本次的区别只在**发起方是页面**。

## 截图为什么不在仓库里

脚本产出了 7 张截图（壳、插件列表、安装表单、同意页、安装后的行、启用后的行、卸载后的列表）。它们**没有提交**：验收宿主跑在一份真实数据目录的复制件上，抽屉后面的壳画着那个目录里的对话正文。证据以 `steps.json` 的文字形式留在本文；要重新拿到截图，按 §「验收身份」的配置重跑脚本即可。

## 顺手看到、没有处理

- 同意页把「这是宿主代码」的「码」画成了一个替代字形。字典里的字串是对的（`pluginCenterConsentPrivilege`），是 headless Chrome 的字体回退，不是文案问题。
- 已启用行的「浏览器资产」列显示「期望 revision 5 · 实际加载 revision 124631e8264a」：前者是目录的 `revision`，后者是资产清单的 `rev` 哈希。两个数不是一个量纲，这一列在 #95 之前就是这样（`pluginCenterExpectedRevision` / `pluginCenterActualRevision` 都是搬过来的旧键），不属于本次范围；记在这里等下一位读者判断该列想比的是什么。

## 本文不做的事

不替代 `check:render` 与 `tests/plugin-center-install.test.ts`；不按发行版更新。它只记录 2026-09-15 这一次、这一棵树、这一条 dev 路径。git 源在页面上的同一条路径没有在浏览器里走（需要一个 https 远端；host 侧的 git 路径由 `packages/iris-app-service/tests/plugin-install.test.ts` 用本地 bare 仓库覆盖），是本文明确没做的一项。
