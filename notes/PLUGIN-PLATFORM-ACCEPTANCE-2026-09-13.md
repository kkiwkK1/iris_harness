# 插件平台联合验收（2026-09-13）

## 验收身份

- **集成基线**：`dev/system-plugins` 的
  `4ade2b21d82b0c1ad7a5c6fae6223d58f31d0626`
- **验收分支**：`dev/plugin-platform-acceptance`
- **工作树**：`D:/workspace/小项目/iris-plugin-platform-acceptance`
- **允许改动**：测试、验收报告、测试夹具
- **产品代码、package manifest、lockfile**：未修改

验收从完整 SHA 建枝，而不是从远端分支名建枝。验收开始时
`origin/dev/system-plugins` 仍在 `934ae1c`，落后于三项任务全部合入后的本地集成头；
用远端名字会把落点 3 和 fresh-profile 修复一并漏掉。

## 结论

**通过。** 清单中的七组行为均有可执行证据；全仓测试、两个 TypeScript 门、
web build、render check 与真实浏览器预览全部通过。本轮没有发现需要产品修复的缺陷，
因此没有建立 `dev/plugin-fix-*` 分支。

## 验收矩阵

| 检查项 | 证据 | 结果 |
| --- | --- | --- |
| 插件启停、依赖、重载、卸载 | `system-plugins.test.ts` 验证依赖阻塞、停用先关入口再排空、reload 先释放再激活；fake 的 `system-plugins.test.ts` 验证 MVU 自动恢复 TH、卸载/重装保留会话数据。真实浏览器再走了一次 MVU 停用 → TH 停用 → 启用 MVU 自动恢复两者 → MVU reload | 通过 |
| 动态 RPC 注册和释放 | `system-plugin-rpc.test.ts` 的 8 条生命周期用例：注册可调、停用撤销、旧 revision 拒绝、在途排空、reload 单注册、动态/内置重名拒绝、忽略 disposer 仍被 fiber 回收、撤销幂等 | 通过 |
| `client.js` 加载 | `plugin-assets.test.ts` 验证 manifest、CORS、内容 rev、缓存与禁用后 404；`sandbox-srcdoc.test.ts` 验证标签位于 bootstrap guard 后、卡片库前。真实浏览器夹具使用生产 `buildSrcdoc`、生产 bootstrap/members bundle，得到 `client.js: loaded; member: client-loaded` | 通过 |
| 成员表冲突 | `plugin-member-merge.test.ts` 验证插件撞 core、插件互撞、重复登记、坏形状、未获准插件与半登记状态均按插件名拒绝 | 通过 |
| 旧 revision 与旧 iframe | `system-plugin-rpc.test.ts` 拒绝旧 revision；`system-plugin-sandbox-lifecycle.test.ts` 验证重建后旧请求仍携带旧 fence，旧 frame dispose 后的 ready 消息无效；store 测试验证旧 push/旧 mutation response 不能倒退新会话 | 通过 |
| reload 后旧 iframe 不能继续提交 | runner 联合用例在 revision 10 与 12 的两个 incarnation 间分别发送写请求，确认旧请求只以 revision 10 到达，旧 frame dispose 后再发 ready 不会复活，也不会提交到新 incarnation | 通过 |
| 插件资产缺失时普通卡仍运行 | `sandboxPluginRuntime(snapshot, undefined)` 的失败方向为空插件成员而非拒绝 frame；现有 capability-free srcdoc 用例保留卡片 HTML。真实浏览器夹具的第二张生产 srcdoc iframe 不带任何插件行，显示 `ordinary card alive without plugin assets` | 通过 |
| TH/MVU 禁用后的真实行为 | `system-plugin-extraction.test.ts` 验证 MVU 停用期间不初始化、不更新、不补放历史，重新启用不追补停用期间文本；TH 宏展开跟随实时 capability。浏览器 sandbox 用例验证 TH/MVU 全局面独立消失，MVU 专属 context 处理停止，静态 frame 仍安装 | 通过 |

## 专项测试

以下专项集合在同一基线工作树运行：

```text
宿主、资产、RPC、fake：43 tests, 43 pass, 0 fail, 0 skipped
web 控制面、快照、成员合并：17 tests, 17 pass, 0 fail, 0 skipped
合计：60 pass, 0 fail
```

涉及的测试文件：

- `packages/iris-app-service/tests/system-plugins.test.ts`
- `packages/iris-app-service/tests/system-plugin-rpc.test.ts`
- `packages/iris-app-service/tests/system-plugin-extraction.test.ts`
- `packages/iris-app-service/tests/plugin-assets.test.ts`
- `packages/iris-client-fake/tests/system-plugins.test.ts`
- `packages/iris-client-fake/tests/plugin-methods.test.ts`
- `apps/iris/tests/plugin-assets-plane.test.ts`
- `apps/iris-web/tests/plugin-center.test.ts`
- `apps/iris-web/tests/system-plugins-store.test.ts`
- `apps/iris-web/tests/system-plugin-sandbox-lifecycle.test.ts`
- `apps/iris-web/tests/plugin-member-merge.test.ts`

## 全仓门禁

| 门 | 结果 |
| --- | --- |
| 根目录 `npx tsc -p . --noEmit` | 通过，无诊断 |
| `apps/iris-web` 的 `npx tsc --noEmit` | 通过，无诊断 |
| `apps/iris-web` 的 `npm run build` | 通过；四个 sandbox 资产生成并通过 bootstrap/preset 检查，主应用 build 完成，172 个声明资产保留、0 个过期资产 |
| `apps/iris-web` 的 `npm run check:render` | `render check: ok` |
| 根目录 `npm test` | `3944 tests / 3933 pass / 0 fail / 11 skipped`，69.86 秒；本机真实 ST 语料差分也运行完成 |
| 根目录 `npm run test:no-corpus` | 通过；CI 无语料条件符合预期 |
| `git diff --check` | 通过 |

## 真实浏览器预览

### Iris 控制面

隔离数据目录 `.acceptance-data`，宿主绑定 `127.0.0.1:8791`，没有读取用户数据或密钥。
在真实浏览器中观察到：

1. 设置目录显示“系统插件”，摘要为“2 个运行中”。
2. Plugin Center 正确显示 TH 与 MVU 的版本、API 版本、依赖和数据保留说明。
3. MVU 运行时，TH 的停用、reload、卸载按钮被禁用，并明确提示“请先停用 MVU”。
4. 停用 MVU 后 TH 的操作解除；继续停用 TH 后摘要变为“0 个运行中”。
5. 在两者均停用时启用 MVU，TH 先作为依赖恢复，最后回到“2 个运行中”。
6. MVU reload 后状态仍为已启用，浏览器 console 没有 warning/error。

### `client.js` 与缺失资产夹具

夹具：`qa/plugin-platform/browser-fixture.mjs`，绑定 `127.0.0.1:8792`。它不模拟
成员协议：它直接使用 Iris 的 `buildSrcdoc`、本次 web build 产生的真实
bootstrap/members 资产，以及一个最小测试插件浏览器包。

浏览器中的两张 opaque-origin iframe 同时显示：

```text
client.js: loaded; member: client-loaded
ordinary card alive without plugin assets
```

第一行证明浏览器实际取回并执行 `client.js`，且插件成员在卡片 markup 解析前已经可读；
第二行证明没有插件资产的普通卡片没有被 manifest/client 平面连坐。两张 frame 的
console 均无 warning/error。

运行夹具：

```powershell
$env:IRIS_ACCEPTANCE_PORT='8792'
node qa/plugin-platform/browser-fixture.mjs
```

先运行 `apps/iris-web` 的 `npm run build`，再打开 `http://127.0.0.1:8792`。

## 非阻断边界

- 当前产品目录只有 TH/MVU 两个内置插件，二者没有浏览器 `client.js`；因此通用浏览器面
  使用验收夹具证明，不能拿内置目录的空 manifest 冒充执行证据。
- 本轮验收的是已经合入的系统插件控制面、运行期 RPC、资产和成员合并基础设施；
  第三方插件发现、下载和安装器不在此基线的产品能力声明中。
- `origin/dev/system-plugins` 的滞后是分支发布状态，不是产品缺陷；验收分支保留完整基线
  SHA，避免后续把 `934ae1c` 误当作联合验收基线。
