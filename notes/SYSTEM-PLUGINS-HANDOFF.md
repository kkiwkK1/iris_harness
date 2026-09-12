# 系统插件控制面：实施交接

2026-09-12。用户接手编码，Codex 后续负责审查、测试和验收。本文件优先于旧任务表中的实施人员分工。

> **任务二的身份、分支与所有权（2026-09-13 收口）**
>
> - 任务编号：`TASK-SYSTEM-PLUGIN-CONTROL-PLANE`。本文件才是三项上层任务中的任务二；此前把任务二链接到 ST 扩展手册是调度错误。
> - 集成分支：`dev/system-plugins`；worktree：`D:/workspace/小项目/iris-system-plugins`。它拥有系统插件控制面、生命周期、中央接线和最终验收。
> - 独立落点不得直接在该 worktree 并行施工。每项工作从明确的 `dev/system-plugins` SHA 创建独立分支/worktree，声明允许修改和禁止并行文件，验收后由集成人顺序合入。
> - 任务一是 [ST 扩展兼容计划](../docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md)，任务三是 [基础设施接口核验](../docs/INFRASTRUCTURE-INTERFACES.md)。任务三只盘点和报告；发现缺口后另开实现任务。
> - 当前收口点：插件内核 `2ac0f06`，P0/P2 合并 `5aedccc`，资产面 `ab3da4d`/`e2b8230`，lockfile 集成 `934ae1c`。已有历史不重写，不把相同改动复制到占位分支。

## 现场与保存

- 工作目录：`D:/workspace/小项目/iris-system-plugins`
- 分支：`dev/system-plugins`；最初基线 `2079dbe`，当前收口提交 `934ae1c`。
- 最初未提交现场已保存并逐批提交；截至本次收口，集成 worktree 为干净状态。每次接手仍先读取 `git status`，不得把后来出现的修改假定为自己的。
- 不从远程旧提交或占位分支重新施工；新落点按上面的独立分支规则创建。
- `stash@{0}` 的说明为 `system-plugins-integration-before-pr84`，是 rebase 前的备份，已经 pop 应用过并保留；不要再次 apply。安全提交并核对后再处理。
- 不操作主工作区的实时数据、key.txt、ST secrets 或其他人的分支。测试使用临时 profile 与 mock provider。

## 与 Claude 的边界

| Claude | 本分支 |
| --- | --- |
| 运行期 RPC schema 注册、Partial Handlers、fake 开放分发 | plugin.list/install/uninstall/enable/disable/reload 控制 RPC 与调用方 |
| `/plugins/<id>/client.js`、dsh.client 清单扫描、成员表合并、可变资产清单 | 能力启停、旧 iframe 回收、revision 防过期调用、PluginCenter |
| `@iris/plugin-api`、`@iris/plugin-web-api`、插件仓库拆分 | 宿主目录、依赖、Cordis 生命周期、MVU/TH capability、聊天接线 |

`rpc.ts`、fake client、frame 启动/成员装配是语义交界，合并时保留双方功能。当前 `SystemPluginDefinition`/activation scope 和 capability 接口在 app-service 内，属于过渡落点；Claude 发布契约后通过 import 对接，不能再造第二套注册表。动态贡献机制不应绕过本分支的 admission、lease、dispose。

## 已实现的结构

1. `packages/iris-app-service/src/system-plugins.ts`：通用目录、依赖排序、串行状态变更、profile 内 `system-plugins.json` 原子持久化、Cordis child fiber、capability 提供与回收、lease 与 drain、版本快照和错误状态。
2. `src/plugins/{builtins,capabilities,tavern-helper,mvu}.ts`：两个内置定义；TH 宏扩展；MVU initialState/update/replay。聊天数据归 ChatEntry 持有，插件只计算行为。
3. `entry.ts`/`chats.ts`/`service.ts`/`index.ts`：构造与恢复 runtime，plugin 控制 RPC，脚本调用入口保护，聊天通过当前 capability 调用算法，生成期间租约延续到落盘结束。
4. protocol 的 `system-plugins.ts`、rpc/events/index：快照、状态、控制方法、plugins.changed、请求上的可选 pluginRevision。
5. `PluginCenter.tsx`/CSS、SettingsDrawer/Navigation、store、fake plugins：设置 Advanced 下第 15 个目的地，展示真实状态、依赖阻塞、错误、操作等待；store 以连接会话及 revision 排除旧响应。
6. sandbox 的 `system-plugin-runtime.ts`/runner/srcdoc/frame-entry/frame 与 `useCardScripts.tsx`/`MessageInterfaces.tsx`：把能力快照固定到 iframe 生命周期，变更时销毁重建；旧请求带旧 revision；按 TH/MVU 状态装配兼容 API。

## 必须保持的行为合同

- 新增偏好文件前的老 profile 默认安装并启用 TH/MVU；原有卡片授权继续生效。
- MVU 依赖 TH；启用 MVU 可按序启用依赖。TH 有运行中的 MVU 依赖时，停用/重载/卸载 TH 必须说明“先停用 MVU”。
- 停用先关闭新工作入口，再等待已接纳任务结束并回收注册；停用成功返回后旧工作不得再提交。不能仅改一个 enabled 布尔值。
- reload 必须实际 dispose 后重新 activate；循环重载不能累积监听器、注入或任务。
- 卸载保留聊天、变量与偏好；本轮目录只含随 Iris 分发的插件，重新安装不下载。外部包分发归 Claude 后续工作。
- MVU 停用期间不初始化、不应用命令、不重放历史；重启后不得偷偷补执行停用期间的命令。旧变量数据仍可读取。
- TH 停用后普通对话、原生宏、世界书、净化的静态消息仍可用；卡脚本不能继续调用被撤销的能力。
- 系统插件启用不等于授予卡脚本或页面权限；卡代码仍在浏览器沙盒。
- 不靠脚本文件名识别 MVU。授权通用脚本直接调用 TH 写变量的能力是独立能力，不能把“禁用宿主 MVU”宣称为能阻止任意脚本自行实现变量更新。

## 接手顺序与重点检查

### 1. 先完成最后两处修复的验证

中断前发现的两处问题已经写入修正，但**最新修正没有最终测试结论**：

- `service.ts` 的 `mvuExecution` 现为三态：未传 runtime → undefined（兼容旧构造方式）；传了 runtime 但 MVU 停用 → null；启用 → execution。检查 #settle/#fail/recordVariables 全链路都保持这个区分，并测试旧构造方式仍更新变量。
- `MessageInterfaces.tsx` 原回调错误引用作用域外 `current`，现改为 `currentMvuEnabled`。检查它同时验证 ready 的 revision，停用时不再发 MVU update-ended；跑 web typecheck。
- 最新新增 `tests/system-plugin-sandbox-lifecycle.test.ts`，尚未收到作者完整报告，需阅读并运行。

### 2. 核对宿主生命周期

重点读 `system-plugins.ts` 与 `system-plugin-extraction.test.ts`：

- 启动时自动补依赖必须写回最终偏好；保存失败不能继续显示 enabled。
- 激活半途报错必须回收已经提供的 capability；dispose 报错必须可见。
- lease 覆盖生成到变量落盘，不能只包 provider stream；成功、取消、异常均释放，不能使 disable 永远等待。
- 长任务期间点 disable：UI 显示正在停用，拒绝新工作，原已接纳工作按规定收尾；返回成功之后不得再写。
- entry 的 init 缓存随 capability 变化失效；变量回放不得执行停用期文本。

### 3. 核对浏览器的生命周期

- 旧 ready Promise、旧 mutation/list 响应、旧 iframe 请求不得覆盖或修改新状态。
- 重连到重启后的宿主允许新会话接受较低 revision；同会话 revision 必须单调。
- TH/MVU 的 bare globals、parent facade、nested TavernHelper facade、事件表、Mvu 共享发布均保持同一启停状态。
- 关闭 TH 后仍能渲染静态消息；避免因 script.context 被拒绝使普通 HTML 也消失。
- frame 销毁后异步 fetch/call/slash 结果不得重新激活或投递旧 frame。
- PluginCenter 所有请求错误在页面内可见；不能通过乐观更新假装启停成功。

### 4. 接入 Claude 契约并补文档

当前 `RpcRequest` 的 pluginRevision 是附加字段，parseRequest 另行保留它以防 zod strip。与动态 schema 注册合并时要测试这个字段仍保留且验证为非负安全整数。

保留单个宿主 runtime。外部插件通过契约贡献实现，控制面仍使用同一安装/启停与清理路径。前端资产变化与 capability revision 需要一起决定 frame 是否重建。

更新 `docs/SYSTEM-PLUGINS.md`、`notes/SYSTEM-PLUGINS-ACCEPTANCE.md` 和 host/web DEVIATIONS，记录实际结果与限制。不要把文件拆分完成等同于所有扩展接口已经补齐。

## 测试命令

从 worktree 根运行：

```powershell
npx tsc -p . --noEmit
node --test packages/iris-app-service/tests/system-plugins.test.ts packages/iris-app-service/tests/system-plugin-extraction.test.ts packages/iris-client-fake/tests/system-plugins.test.ts apps/iris-web/tests/system-plugins-store.test.ts apps/iris-web/tests/plugin-center.test.ts apps/iris-web/tests/system-plugin-sandbox-lifecycle.test.ts
```

从 `apps/iris-web` 运行：

```powershell
npx tsc --noEmit
npm run build
npm run check:render
```

构建后回根目录运行：

```powershell
npm test
npm run test:no-corpus
git diff --check
git diff --cached --check
```

完整套件必须核实 fail 0，不能仅凭命令退出码或截断末尾推断。构建前 no-corpus 可能多跳过 web dist 测试，先构建。已有 chat-search 耗时测试可能受并发影响，失败时记录原始失败，单测确认后再判断，不能降低阈值掩盖。

## 已有验证证据的范围

- 较早宿主/抽离/fake 定向测试 17 例通过；之后宿主生成 lease 改过，需重新验证。
- UI/store/fake 最近报告 13 例通过；render-check 通过且 15 个设置目的地。
- UI 报告时整树 web typecheck 仍有上述 MessageInterfaces 错误；之后源码已修，未完成最终验收。
- **没有整树最终 build/full test/no-corpus 通过结论，没有浏览器完整启停验收，没有提交或 PR 完成结论。**

## 交回验收时提供

分支和提交号、相对 main 的 diff、与 Claude 合并的基线、跑过的命令和失败记录。无需粘贴所有代码，也不要传密钥或真实卡片正文。

Codex 将审查上述行为合同、跑必要集成检查，再使用临时 profile 在浏览器验证：启停、依赖阻塞、reload 循环、卸载重装、重连、MVU 停用期聊天、静态消息回退。验收通过再报告可合并状态；发现问题给出文件位置、复现步骤和修复要求。
