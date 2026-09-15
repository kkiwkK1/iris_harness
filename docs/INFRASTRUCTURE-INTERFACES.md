# Iris 基础设施接口清单

核对日期：2026-09-15。适用基线：`main` 的 `2eccf30`（PR #88「Add the system plugin platform and ST extension pilot」）。

上一版写于 2026-09-13，基线是尚未合入的 `dev/system-plugins`，因此把资产面、成员合并、设置面占位与 ST 扩展面都列为「待实现，不可按草案调用」。这些在 #88 一并落地，本版按 main 的代码重记：**已在 main 的**是插件控制面、运行期 RPC 注册、`/plugins` 资产面与聚合清单、帧侧成员表合并、设置槽占位渲染、ST 扩展安装与兼容面、插件中心页面；**仍不在 main 的**是插件可用的通用存储/设置/生成钩子、可发布的契约包、i18n 命名空间合并（完整清单见 §8）。**系统插件的 Git/dev 安装路径此后闭合**（2026-09-15，[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §10 的三个 PR 全部落地，含插件中心的安装表单与同意页）；npm 名与任意 tarball 是 §11 明确否决的，不在缺口里。

本清单只记录读取到的实现，设计草案不算可调用 API。行号是本提交的证据，定位以符号名为准。

配套：[插件制作与执行手册](PLUGIN-AUTHORING-RUNBOOK.md)、[系统插件架构](SYSTEM-PLUGINS.md)、[ST 扩展设计与执行手册](ST-EXTENSION-DESIGN-AND-RUNBOOK.md)。验收记录：[插件平台联合验收](../notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md)、[ST 试点验收报告](../notes/st-compat/PILOT-REPORT.md)。落点草案与交接：[PLUGIN-CONTRACT-LANDING-SITES](../notes/PLUGIN-CONTRACT-LANDING-SITES.md)、[SYSTEM-PLUGINS-HANDOFF](../notes/SYSTEM-PLUGINS-HANDOFF.md)。可行性分析：[PLUGIN-FEASIBILITY](../notes/PLUGIN-FEASIBILITY.md)。

## 1. 分层、所有权与可用状态

| 层 | 入口 | 职责 | 当前状态（main 2eccf30） |
| --- | --- | --- | --- |
| 组合与依赖 | `apps/iris/cordis.yml` | Cordis 服务组合；按 inject 依赖启动，文件排列不保证顺序 | 已落地 |
| 宿主插件契约 | `@iris/plugin-api` | definition、activation scope、lease、runtime options | 已在 main；仍是 `private`、`0.0.0`、导出 TS 源码，不是可发布 SDK（[package.json](../packages/iris-plugin-api/package.json)） |
| 宿主控制面 | `packages/iris-app-service/src/system-plugins.ts` | 目录、依赖、持久化、状态、Cordis 子 fiber、排空与释放、运行后接纳 definition | 已落地，由 [system-plugins.test.ts](../packages/iris-app-service/tests/system-plugins.test.ts) 与 [system-plugin-extraction.test.ts](../packages/iris-app-service/tests/system-plugin-extraction.test.ts) 钉住 |
| 线协议 | `@iris/protocol` | requestSchemas、请求/响应类型、IrisEvent、运行期 schema 注册表 | 已落地 |
| HTTP/WS | `@iris/rpc-host`、`@iris/rpc-client` | 请求路由、验证、错误、事件、重连 | 已落地；运输与客户端签名放宽至 `AnyRpcMethod`（动态方法 params/响应为 `unknown`） |
| 动态 RPC 贡献 | `scope.registerRpc` + `registerRequestSchema` | 插件自带方法，不改协议核心 | 已落地，**但 main 上没有生产使用者**：随包发布的插件方法全部是静态 schema，唯一调用点是 [system-plugin-rpc.test.ts](../packages/iris-app-service/tests/system-plugin-rpc.test.ts) |
| 聊天业务 | app-service 的 entry/chats/service | 聊天持久化与生成；通过 capability 调用 TH/MVU | 已落地；TH/MVU 经 `plugins/capabilities.ts` 热查 |
| `/plugins` 资产面 | `packages/iris-app-service/src/plugin-assets.ts` | 聚合清单、按 id 下发 `client.js`、内容 rev 与缓存 | 已落地；**刻意不走 `@deepseek-ai/dsh-client-modules`**，理由写在模块头（`packages/iris-app-service/src/plugin-assets.ts:16`：dsh 自注册路由不过 `irisRpc.guard`，且它扫描组合层装载项而非安装目录）。测试：[plugin-assets.test.ts](../packages/iris-app-service/tests/plugin-assets.test.ts)、[plugin-assets-plane.test.ts](../apps/iris/tests/plugin-assets-plane.test.ts) |
| 浏览器契约 | `@iris/plugin-web-api` | 帧能力快照（含第三方 `plugins` 行）、meta 标识与编解码、revision 附加、清单形状与解析 | 已落地；`private`、`0.0.0`、TS 源码导出 |
| 帧侧成员合并 | `apps/iris-web/src/sandbox/members-entry.ts`、`plugin-members.ts` | 插件把成员登记进核心成员表，按插件名拒绝冲突与半登记 | 已落地，由 [plugin-member-merge.test.ts](../apps/iris-web/tests/plugin-member-merge.test.ts)、[sandbox-srcdoc.test.ts](../apps/iris-web/tests/sandbox-srcdoc.test.ts) 钉住 |
| UI 插槽 | `apps/iris-web/src/slots/` | 五个页面扩展点、可撤销注册和渲染、占位查询 | 已落地；`useSlotOccupied` 让空槽连标题都不渲染。仍**不是**外部插件加载器 |
| 设置面贡献 | `iris.settings.sections` + `PluginSettings` | 插件自己的设置区块，挂在插件页 | 已落地；当前唯一注册者是 shell 内的 ST 扩展面（`apps/iris-web/src/st-extensions/plane.tsx`），宿主侧插件无法贡献（见 §8） |
| ST 扩展兼容面 | `@iris/compat-st-extension`、`@iris/extension-installer` | 安装、静态分析、facade、隐藏 iframe 内运行未改动的 ST 扩展 | 已落地；试点只服务一个扩展（§7） |
| 插件中心 | `apps/iris-web/src/app/PluginCenter.tsx` | 目录、依赖、启停/重载/卸载、状态、资产与成员诊断，**以及包安装路径的整个 UI**：安装表单（`git` 远端 + 40 位 commit / `dev` 目录）、同意页 `PluginConsent`、`source` 徽标、`provenance`、六个失败状态、`tampered` 的重装按钮、按 `source` 分叉的卸载文案 | 已落地，挂在设置抽屉的 `plugins` 路由（`apps/iris-web/src/app/SettingsDrawer.tsx`），并从那里收 `active={open && route === 'plugins'}`——设置页从不卸载、只被 `hidden` 藏起来，而一张挂起的同意页必须在读者离开时被取消。测试：[plugin-center.test.ts](../apps/iris-web/tests/plugin-center.test.ts)（投影与双语文案）、[plugin-center-install.test.ts](../apps/iris-web/tests/plugin-center-install.test.ts)（jsdom 里真点，断言落在记录下来的 RPC 参数上） |

系统插件、ST 扩展、卡脚本、shell UI 是四种执行位置。宿主系统插件运行在 Node 进程内，具有宿主权限；ST 扩展的代码运行在 shell 里的沙盒 iframe；卡片 JavaScript 运行在既有卡片 iframe 沙盒。不能把卡片脚本直接当系统插件加载。

## 2. 宿主插件公开契约

事实源：[plugin-api/src/index.ts](../packages/iris-plugin-api/src/index.ts)。外部实现应依赖这里的类型；runtime 类和 TH/MVU 私有实现不是公共 SDK。app-service 侧只做 re-export（`packages/iris-app-service/src/system-plugins.ts:24`），仓库里只有一份 `SystemPluginDefinition`。

| 接口/字段 | 类型或签名 | 语义 |
| --- | --- | --- |
| `SystemPluginDefinition` | `{ id, name, description, version, apiVersion: 1, dependencies?, activate }` | id 为目录主键；version 为实现版本；apiVersion 为契约版本，非 1 直接抛错 |
| `activate(scope)` | `void \| Disposable \| Promise<void \| Disposable>` | 完成激活；返回释放函数，允许异步释放；异常进入失败处理 |
| `scope.context` | Cordis `Context` | 本次激活的 child context；不是新的 root context |
| `scope.pluginId` | `string` | 当前插件 id |
| `scope.revision` | `number` | 此次激活对应的快照版本；不是插件版本号 |
| `scope.provide<T>(name, value)` | `() => void` | 发布当前插件拥有的 capability；返回撤销函数 |
| `scope.getDependency<T>(id, name)` | `T \| undefined` | 只读已声明依赖的 capability；未声明依赖会抛错，能力缺失返回 undefined |
| `scope.registerRpc<T>(method, schema, handler)` | `() => void` | 成对登记运行期方法（schema 进协议注册表、handler 上运输层），两半同生同灭；重名/撞内置名在 activate 内抛错；每次调用经本插件 lease 收容并校验 pluginRevision；撤销幂等，且随 activation 的 fiber dispose 自动执行 |
| `ScopedRequestSchema<T>` | 只读 `safeParse` 的结构化类型 | zod 或任何同形 schema 库都可直接传入 |
| `ScopedPluginRevision` | `{ pluginRevision?: number }` | 帧栅栏字段在契约侧的重述，线上孪生是 `@iris/protocol` 的 `PluginRevisionRequest` |
| `SystemPluginLease` | `{ pluginId, revision, incarnation, isCurrent, assertCurrent, release }` | 已接纳工作持有的生命周期凭据；release 幂等 |
| `SystemPluginRuntimeOptions` | `{ context, file, definitions, defaultEnabled?, onError?, writePreferences? }` | runtime 构造参数；writePreferences 是测试替换点 |

scope 上**仍然没有** `storage`、`settings`、`hooks`、`registerPluginMembers` 或事件订阅快捷接口。帧侧成员是插件自带的 `client.js` 在帧内登记的（§5），不经过 scope；设置区块目前只有 shell 内代码能注册（§8）。不要从草案复制其余名字后直接调用。

`ScopedRequestSchema` 在 `@iris/protocol` 侧的同形孪生是 `RuntimeRequestSchema`（[rpc-registry.ts](../packages/iris-protocol/src/rpc-registry.ts)），两边是同一契约在两个互不依赖的包里的两份声明——契约包按其自身宪法不 import 任何 `@iris` 包与运行时依赖，由 [contract.test.ts](../packages/iris-plugin-api/tests/contract.test.ts) 与 `apps/iris/tests/architecture.test.ts` 钉住。handler 内的主动拒绝：抛携带协议固定错误码之一的 `Error`（`not-found`/`invalid-request`/`busy`/`unsupported` 等），其余一律按 `internal` 上报。

### 宿主内部控制接口

事实源：[system-plugins.ts](../packages/iris-app-service/src/system-plugins.ts)。这些供宿主接线和测试使用，插件包不要深导入 runtime 实现。

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `adoptDefinition(raw, { installed })` | `boolean` | 构造之后接纳一个 definition（ST 扩展的入口）；重跑构造期的全部校验；id 已知则返回 `false`，幂等，允许开机扫描与运行期安装相撞（`packages/iris-app-service/src/system-plugins.ts:177`） |
| `initialize()` | `Promise<SystemPluginSnapshot>` | 读偏好、提升启动 revision、恢复启用集与依赖（`:201`） |
| `snapshot()` | `SystemPluginSnapshot` | 当前目录和状态投影 |
| `isEnabled(id)` | `boolean` | 是否已完成激活且可接纳新工作 |
| `onChange(listener)` | 撤销函数 | 订阅提交后的快照；监听器异常单独报告 |
| `capability<T>(id, name)` | `T \| undefined` | 只在所有者接纳新工作时返回能力 |
| `assertCurrent(id, expectedRevision?)` | `void` | 检查当前启用状态及请求 revision；停用或过期答 `unsupported` |
| `lease(id, expectedRevision?)` | `SystemPluginLease` | 接纳工作并计入 drain |
| `install/enable/disable/reload/uninstall(id)` | `Promise<SystemPluginSnapshot>` | 串行控制操作，全部经私有 `#serialize` |
| `dispose()` | `Promise<void>` | 宿主关闭时排空和释放 |

几条实现语义，是行为合同而非实现细节：

- **偏好文件读不动即全体停摆**：`initialize()` 读不到或解析不了偏好文件时，**保留原文件**、把全部插件置为 `status:'error'` 并把原因写进 `error`，不新建、不覆盖、不静默回到默认值。
- **启动先提升 revision 再激活**：开机把 `revision+1` **先落盘**，然后才激活启用集，使存活的旧帧不可能和新进程共享一个 revision。
- **先持久化再改内存**：`#commit` 先写偏好文件，写失败就把持久化行回滚到写之前的值并抛 `internal`，因此不会出现「界面显示已启用、重启后消失」。
- **依赖顺序与回滚**：enable 走 DFS 拓扑序；成环答 `invalid-request` 并给出路径；未知 id 答 `not-found`；中途失败回滚本次新启用的依赖。
- **被依赖方拒绝**：仍有已启用依赖方时，disable/reload/uninstall 答 `busy` 并点名依赖者。
- **卸载保留偏好行与业务数据**：`uninstall` 先停用，未安装答 `not-installed`，偏好行保留。
- 错误码取自协议固定集合：`not-found`、`invalid-request`、`busy`、`unsupported`、`internal`。

注意两个「当前」的区别：`runtime.assertCurrent()` 控制新工作；已经持有的 `lease.isCurrent()` 在 disabling 排空期间仍可为真，使已接纳任务完成提交。停用返回成功后，旧 activation 的工作必须全部结束。不要在任务中途重新取 capability 来代替已经持有的对象。

capability 在实现中使用 `iris.system-plugin:<id>:<name>` 服务名。插件通过 scope 访问，不要依赖这个私有字符串格式。

### 默认启用集与持久化

| 项 | 事实 |
| --- | --- |
| 默认启用 | 偏好文件不存在时为 `['tavern-helper', 'mvu']`（`packages/iris-app-service/src/system-plugins.ts:143`），可由 `defaultEnabled` 覆盖 |
| 持久化文件 | profile 根下 `system-plugins.json`（`packages/iris-app-service/src/index.ts:779`） |
| 文件形状 | `{ version: 1, revision, plugins: { <id>: { installed, enabled } } }`，两空格 JSON，原子写 |
| 内置目录 | `packages/iris-app-service/src/plugins/builtins.ts` 的 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`：`tavern-helper`（无依赖）与 `mvu`（`dependencies: ['tavern-helper']`），两者 `version: '0.0.0'` |

`SystemPluginId`（`packages/iris-protocol/src/system-plugins.ts:2`）仍是闭合联合 `'tavern-helper' | 'mvu'`，只用于内置名的字面量校验；投影里的 `SystemPluginView.id` 是 `string`，ST 扩展这类运行期接纳的行走的是后者。把 `SystemPluginId` 当成「所有插件 id 的类型」会漏掉被接纳的行。

## 3. 管理 RPC、事件与错误

事实源：[rpc.ts](../packages/iris-protocol/src/rpc.ts)、[system-plugins.ts](../packages/iris-protocol/src/system-plugins.ts)、[events.ts](../packages/iris-protocol/src/events.ts)。宿主 handler 在 [service.ts](../packages/iris-app-service/src/service.ts) 的 `handlers` 字面量，注册在 `packages/iris-app-service/src/index.ts:1129` 起。

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| `plugin.list` | `{}` | 读取完整目录 |
| `plugin.install` | `{ id }` | 安装目录内实现；安装后停用 |
| `plugin.enable` | `{ id }` | 按依赖顺序安装/启用所需项 |
| `plugin.disable` | `{ id }` | 关闭入口、排空、释放；存在启用的依赖方则拒绝 |
| `plugin.reload` | `{ id }` | 实际释放并重新激活；存在启用的依赖方则拒绝 |
| `plugin.uninstall` | `{ id }` | 移除本 profile 的安装状态；内置行与 ST 接纳行保留业务数据与安装树，本轮装进来的插件包行**整行移除并删树**（见下） |

六个方法均返回 `SystemPluginSnapshot = { revision, plugins }`。每项含 `id/name/description/version/apiVersion/dependencies/installed/enabled/status/error?`；status 为 `not-installed | disabled | enabling | enabled | disabling | error`。

**安装路径另有四个方法**（PR-2，[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §5）。形状权威在
`packages/iris-protocol/src/rpc.ts` 的 `requestSchemas` 与
`packages/iris-protocol/src/system-plugins.ts` 的 `SystemPluginInstallPreview`：

| 方法 | 参数 | 返回 / 行为 |
| --- | --- | --- |
| `plugin.previewInstall` | `{ source: { kind:'git', remote, commit } \| { kind:'dev', path } }` | `SystemPluginInstallPreview`：把树装进 staging、审计、算哈希、读清单，**停在安装器既有的 `hashed` 阶段**；不 import 包里任何东西 |
| `plugin.confirmInstall` | `{ previewToken, id, commit \| null, treeHash }` | `SystemPluginSnapshot`；每个字段都是 preview 的回带，逐条与**事务记录**比对（绝不重新拉取），任何一条不符即 `install-failed` 并丢弃整个事务 |
| `plugin.cancelInstall` | `{ previewToken }` | `{ ok: true }`；删 staging。未知 token 不是错误 |
| `plugin.update` | `{ id, commit }` | **预留未实现**（该文 §12 裁决 2）：宿主与 fake 都答 `unsupported`，消息点名裁决与「卸载后重装」这条替代路径 |

`SystemPluginView` 因此多了三个**可选**字段，既有九个字段、六值 `status` 与 `error?: string` 一个没动：
`source?: 'builtin'|'git'|'dev'`、`provenance?: { remote?, commit?, path?, treeHash?, installedAt? }`、
`failure?: { state, field?, step?, reason }`，其中 `state` 是六值闭合集
`install-failed | manifest-invalid | incompatible | tampered | load-failed | activate-failed`；
`failure` 是对 `status: 'error'` 的**细化**而不是替代。

宿主未配置安装路径（`AppServiceOptions.pluginInstaller` 缺席）时，前三个方法经 `requirePluginInstaller()`
答 `unsupported`，`plugin.update` 照样答 `unsupported`（它与配置无关），而 `plugin.uninstall` 保持本轮
之前的行为一字不变。

ST 兼容面另有五个方法，形状见 `packages/iris-protocol/src/rpc.ts:252` 起：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `stCompat.plane.attach` | `{ extensionId, pluginRevision, chatId? }` | `{ ok: true }`；给桥「武装」，带 chatId 时顺带补一轮 chat-open |
| `stCompat.plane.detach` | `{ extensionId }` | `{ ok: true }` |
| `stCompat.submit` | `{ token, kind, pluginRevision, result }` | `{ accepted, why? }`；宿主重校验 revision，过期帧不能应答新一轮 |
| `stCompat.settings` | `{ extensionId, pluginRevision, settings }` | `{ ok: true }`；revision 过期或缺失答 `unsupported` |
| `stExtension.install` | `{ path }` | `SystemPluginSnapshot` |

宿主未配置控制面时，`plugin.*` 经 `requirePlugins()` 答 `unsupported`（`packages/iris-app-service/src/service.ts:1761`）；ST 面未配置时经 `requireStCompat()` 同样答 `unsupported`（`:1768`）。

事件：

| 事件 | 形状 |
| --- | --- |
| `plugins.changed` | `{ snapshot }`，由 runtime 的 `onChange` 广播（`packages/iris-app-service/src/index.ts:888`） |
| `st-compat.request` | `{ token, extensionId, kind: 'chat-open' \| 'generate' \| 'reply', revision, payload }`（`packages/iris-protocol/src/events.ts:143`）；plane 是纯中继，判定全在宿主 |

前端以宿主快照为准，不在按钮点击时直接写 enabled。浏览器侧的对账时钟是 `SystemPluginProjectionClock { session, revision }`（`apps/iris-web/src/client/store.ts:1397`）：重连使 session 自增并清空快照（`beginSystemPluginSession`，`:1416`），只有**同 session 且严格更大**的 revision 才被采纳（`adoptSystemPluginSnapshot`，`:1431`），重连后重新读一次 `plugin.list`（`:3533`）。新进程 revision 可以比旧会话低，同会话内不许倒退。

`pluginRevision?: number` 附在帧请求上，由 `parseRequest` 单独校验、保留（非负安全整数），不能被 zod 未知字段裁剪吞掉；该段代码方法无关，运行期注册的方法自动获得同一保留行为（有测试钉住）。它是栅栏，不是安全认证令牌，也不替代脚本授权、角色范围检查或 HTTP 防护。

传输入口为 `POST /iris/rpc`、`WS /iris/events`。可关联的业务拒绝仍可能是 HTTP 200，必须读响应帧 `ok/error`；优先使用 `IrisHttpClient`，其 `call()` 会抛 `IrisRpcError`。协议细节见 [rpc-host README](../packages/iris-rpc-host/README.md)。

| 运输接口 | 位置 | 合同 |
| --- | --- | --- |
| `irisRpc.register(method, handler)` | rpc-host | 接受静态 RpcMethod 与运行期方法名（`AnyRpcMethod`）；重名抛错；返回带身份检查的撤销函数 |
| `registerRequestSchema(method, schema)` | protocol rpc-registry | 运行期 schema 登记：拒内置名/重名（当场抛错），返回身份检查的撤销函数；`lookupRequestSchema` 是读侧 |
| `parseRequest(method, params)` | protocol rpc | 先查静态 `requestSchemas`、再查注册表，两处皆空答 `unsupported`「unknown method」 |
| `irisRpc.broadcast(event)` | rpc-host | 发布已定义的 IrisEvent |
| `irisRpc.guard(handler)` | rpc-host | 自建 HTTP 路由必须经过的 Host 等请求防护；`/plugins` 与 `/iris-st-ext` 都在其后 |
| `client.call(method, params)` | IrisClient | 类型化请求/响应（动态方法两侧为 `unknown`）；不会等待生成结束才返回 chat.send |
| `client.subscribe(listener)` | IrisClient | 事件订阅，返回撤销函数 |
| `client.onConnectionChange(listener)` | IrisClient | 重连信号，返回撤销函数；需要重新读取权威快照 |
| `fake.registerPluginMethod(method, schema, handler, { pluginId? })` | client-fake | 测试/演示夹具的动态方法登记；命名 `pluginId` 时随该目录行启停失效（停用答 `unsupported`），schema 进同一注册表，撤销两半同拆 |

类型层：`AnyRpcMethod = RpcMethod | (string & {})`；`RpcMethod` 本身不扩，`RpcResponseMap` 与穷尽守卫不动；动态方法的 params/响应类型为 `unknown`（注册处的 schema 即其类型）。fake 的 `FakeSystemPlugins`（`packages/iris-client-fake/src/plugins.ts`）复刻目录、依赖、成环与被依赖拒绝规则并广播 `plugins.changed`；静态 switch 末尾的 `never` 穷尽守卫原样保留（`packages/iris-client-fake/src/client.ts:1960`）。

行为测试：[rpc-registry.test.ts](../packages/iris-protocol/tests/rpc-registry.test.ts)、[system-plugin-rpc.test.ts](../packages/iris-app-service/tests/system-plugin-rpc.test.ts)、[rpc-transport.test.ts](../apps/iris/tests/rpc-transport.test.ts)、[plugin-methods.test.ts](../packages/iris-client-fake/tests/plugin-methods.test.ts)、[system-plugins.test.ts](../packages/iris-client-fake/tests/system-plugins.test.ts)。安装路径另有：[plugin-install.test.ts](../packages/iris-app-service/tests/plugin-install.test.ts)（真实包、真实本地 git 仓库，走完 preview → confirm → enable → disable → uninstall，含篡改、过期同意、六个失败状态与 v1→v2 升级）、[plugin-install-rpc.test.ts](../packages/iris-app-service/tests/plugin-install-rpc.test.ts)（schema 在前、handler 在后的那一对）、[plugin-install.test.ts](../packages/iris-client-fake/tests/plugin-install.test.ts)（fake 侧同一套握手）、[staged-install.test.ts](../packages/iris-extension-installer/tests/staged-install.test.ts)（安装器的 `stage`/`promote`/`discard` 两段式）。

## 4. 业务 RPC 目录（完整方法名索引）

本次从 `requestSchemas` 提取 **137 个方法**（main 原有 122 + plugin 10 + stCompat 4 + stExtension 1）。
plugin 域从 6 涨到 10 是 PR-2 的四个安装方法（`previewInstall` / `confirmInstall` / `cancelInstall` /
预留未实现的 `update`）。这是宿主**静态**线协议数量，不是 ST API 覆盖率，也不表示卡片可以调用全部方法；系统插件经 `scope.registerRpc` 登记的运行期方法不在此表（数量随启停变化，权威在协议注册表与运输层 handler 表，都不在文档）。参数权威为 rpc.ts 的 `requestSchemas`，响应权威为 `RpcResponseMap`；不在文档维护第二份容易漂移的 schema。

计数口径：`requestSchemas` 对象字面量里的全部顶层键。注意 `stCompat.plane.attach` / `stCompat.plane.detach` 是**三段**方法名，只按「域.方法」两段 grep 会漏掉这两个、得到 131。

下列均为 `域.方法`；表内省略重复域前缀。

| 域 | 数量 | 方法 |
| --- | ---: | --- |
| backup | 4 | list, preview, restore, delete |
| character | 8 | list, import, delete, duplicate, rename, export, setTags, favorite |
| chat | 18 | list, create, open, delete, rename, reorder, search, answerCleanup, send, regenerate, compact, abort, swipe, editMessage, deleteMessage, branch, import, export |
| connection | 5 | list, save, delete, activate, test |
| debug | 1 | reports |
| persona | 4 | list, get, set, delete |
| plugin | 10 | list, install, uninstall, enable, disable, reload, previewInstall, confirmInstall, cancelInstall, update |
| preset | 12 | list, select, view, setEnabled, move, upsertPrompt, removePrompt, save, delete, read, import, importFile |
| prompt | 2 | itemize, divergence |
| regex | 11 | list, set, scopedList, setScopedAllowed, setScopedEnabled, presetList, setPresetAllowed, setPresetEnabled, tavernList, tavernReplace, tavernFormat |
| script | 32 | getVariables, setVariables, swipeTo, slash, list, setEnabled, setDocumentGrant, setScriptsAllowed, fetch, context, saveMetadata, createChatMessages, deleteChatMessages, getPreset, evalTemplate, replaceScriptButtons, saveChat, setExtensionPrompt, runEnded, body, setExtensionSettings, generateRaw, setChatMessages, generate, getCharacter, chatHistoryBrief, chatHistoryDetail, rotateChatMessages, createOrReplacePreset, deletePreset, renamePreset, loadPreset |
| scriptLibrary | 5 | list, read, save, delete, setEnabled |
| settings | 2 | get, set |
| stCompat | 4 | plane.attach, plane.detach, submit, settings |
| stExtension | 1 | install |
| storage | 3 | set, remove, clear |
| usage | 1 | summary |
| worldbook | 14 | names, load, get, charNames, charDigest, globalSelect, setGlobalSelect, replace, create, bindChat, setCharBooks, settings, setSettings, delete |

`service.ts` 的 `guardTavernHelper` 是当前脚本方法所有权清单：脚本执行入口总是检查 TH；与原生 UI 共用的 worldbook 写口仅对带帧 fence 的调用做 TH 检查。授权管理和 `script.runEnded` 清理入口保持可达。未来拆 schema/handler 时必须一起迁移这层语义。

`Handlers` 仍是**全量**映射（`packages/iris-app-service/src/service.ts:264`），不是 `Partial`：注释写明这是刻意保留——线上可以缺方法（插件方法走注册表，未注册者答 `unsupported`），但「本次构建自己声称实现的方法」必须全量，静态词表里少一个 handler 是编译错误而不是静默拒绝；能力搬进插件时，方法名从静态词表移入注册表，`RpcMethod` 与这张表同步收缩。

## 5. 浏览器契约、资产面、成员合并与 UI 插槽

事实源：[plugin-web-api](../packages/iris-plugin-web-api/src/index.ts)。旧的 `apps/iris-web/src/sandbox/system-plugin-runtime.ts` 已不存在，整体迁入该包。

| 名称 | 参数/返回 | 语义 |
| --- | --- | --- |
| `SandboxPluginRuntime` | `{ revision, tavernHelper, mvu, plugins }` | 一次 iframe 生命周期固定的能力快照。`plugins` 是第三方的一半：`Record<id, { rev, client }>`，空记录是常态；两个布尔仍单列，它们是兼容**面**（TH 表面是否装配），`plugins` 是**在场**（这一帧里还有谁） |
| `sandboxPluginRuntime(snapshot, assets?)` | 快照或 undefined | 仅 installed/enabled/status 三者一致才开放；MVU 要求 TH 启用；快照决定**是否**在场，清单只提供**字节在哪**——快照不跑的行被丢弃，跑着但清单无行的插件照样在场但不带 URL |
| `SYSTEM_PLUGIN_RUNTIME_META` | `iris-system-plugins` | srcdoc writer 与 bootstrap reader 共用的 meta 名 |
| `encodeSandboxPluginRuntime(runtime)` | JSON 字符串 | 调用方放入 HTML 属性前仍须做属性转义 |
| `parseSandboxPluginRuntime(text)` | runtime 或抛错 | 拒绝缺失、坏 JSON、非法 revision、MVU 单独启用；`plugins` **缺失**按空记录容忍（旧 shell），**存在**则逐行严格校验（rev 须 12 位十六进制，client 须在 `/plugins/` 前缀下） |
| `fenceFrameParams(params, revision)` | payload | 为对象参数附加/覆盖 pluginRevision；非对象原样返回 |
| `DEFAULT_SANDBOX_PLUGIN_RUNTIME` | revision 0、两内置启用、`plugins` 为空 | 仅旧直接构造路径兼容默认；实时 UI 不得用它代替加载失败的权威快照 |
| `PLUGIN_ASSET_PREFIX` / `PLUGIN_ASSET_MANIFEST_PATH` | `/plugins`、`/plugins/manifest.json` | 固定不可配置：两侧必须拼一样的字面量 |
| `PluginAssetEntry` / `PluginAssetManifest` | `{ rev, client }` / `{ revision, plugins }` | 聚合清单的形状 |
| `parsePluginAssetManifest(text)` | 清单或**原因字符串** | 不抛错，返回可直接写进错误句子的原因 |

### `/plugins` 资产面

| 项 | 事实 |
| --- | --- |
| 路由 | 前缀路由挂在 `irisRpc.guard` 之后，**无条件注册**（`packages/iris-app-service/src/index.ts:1429`），每次请求现读控制面状态 |
| 安装目录 | `<dataDir>/system-plugins/<id>/client/client.js`（`.map` 同目录） |
| 内容 rev | bundle 字节的 sha1 前 12 位十六进制（`packages/iris-app-service/src/plugin-assets.ts:153`），按 `(mtimeMs, size)` 记忆 |
| 清单 | `{ revision, plugins: { <id>: { rev, client } } }`；**只收已启用且磁盘上确有 bundle 的插件**，键排序输出，同一状态序列化成同样的字节（`plugin-assets.ts:168`） |
| 清单缓存 | 永远 `no-cache`（`plugin-assets.ts:227`）——它是唯一路径固定而字节随启停变化的资源 |
| bundle 缓存 | `?rev=` 与当前内容 rev **相等**才发 `immutable`，否则 `no-cache`（`plugin-assets.ts:299`）；失败方向恒为「证据可能过期就不许长缓存」 |
| 停用即 404 | 停用的插件在清单里没有行，它的 bundle URL 也随之 404（`plugin-assets.ts:255`），这是资产面自己那一半的过期帧拒绝，另一半是 RPC 的 `assertCurrent` |
| 不走 dsh | `@deepseek-ai/dsh-client-modules` 刻意不挂载（`plugin-assets.ts:16`）：它自注册路由、不过 `irisRpc.guard`，且扫描组合层装载项而不是安装目录。rev 形状（sha1 前 12 位 + `?rev=`）是唯一照抄它的东西，使两边合成的 bundle/清单可互通 |

浏览器侧由 `usePluginAssetManifest` 拉清单、`usePluginBrowserAssets` 做探测与分类（`apps/iris-web/src/app/use-plugin-manifest.ts`，10 秒轮询，区分 stale/degraded/undeclared），结果进插件中心的资产状态列。

### 帧侧成员合并（client.js）

bundle 合同：**经典脚本**（不是模块），不导出任何东西，运行到最后调用

```js
globalThis.__iris_members__.registerPluginMembers('<literal id>', { /* literal keys */ })
```

参考实现是 ST 兼容面生成的成员代理（[member-bundle.ts](../packages/iris-compat-st-extension/src/host/member-bundle.ts) 的 `buildMemberBundle`）。**字面量 id 与字面量键名是承重的**：插件中心的扫描器 `scanPluginMemberNames`（`apps/iris-web/src/app/use-plugin-manifest.ts:208`）读 bundle 源文本来报告成员状态，拼接出来的 id 会让它对这个 bundle 失明。

| 项 | 事实 |
| --- | --- |
| 标签顺序 | 成员表 → bootstrap → 插件 → 卡片（`apps/iris-web/src/sandbox/plugin-members.ts:4`）；srcdoc 按快照的 `plugins` 逐行写 `<script src="…" crossorigin="anonymous" data-iris-plugin="<id>">`（`apps/iris-web/src/sandbox/srcdoc.ts:790`），落在 bootstrap 之后、卡片库之前 |
| 约定的全局名 | `__iris_members__`（核心表）、`__iris_members_ready__`（核心表完成标记）、`__iris_plugin_members__<id>`、`__iris_plugin_ready__<id>`、`__iris_plugins_admitted__`（bootstrap 公布的准入行），全部出自 [members-contract.ts](../apps/iris-web/src/sandbox/members-contract.ts) |
| 登记闸门 | `registerPluginMembers`（`apps/iris-web/src/sandbox/members-entry.ts:90`）依次检查：**准入**（id 必须在 bootstrap 公布的准入记录里，没有记录读作「什么都没准入」）→ **形状**（必须是普通对象）→ **撞核心表** → **撞别的插件** → **重复登记**；任一条都是**抛错**并点名插件与成员。通过后冻结存入该插件自己的全局，并加入核心表的对外面 |
| 收集与拒绝粒度 | `collectPluginMembers`（`apps/iris-web/src/sandbox/plugin-members.ts`）逐插件判定：`ready && members` 才算准入，否则给一条点名的报告（「没跑完」与「半登记」分开措辞）。**拒绝是按插件的，不是按帧的**：核心表缺席才整帧拒跑，某个插件的 bundle 被拦/解析失败只废掉它自己的成员，别的卡照常运行 |
| 帧与 revision 绑定 | 帧在 `runCard` 时捕获 revision，之后所有 fetch/settings/call/slash 都带它（`apps/iris-web/src/sandbox/runner.ts`）；shell 比对 `ready.systemPlugins.revision === pluginRevision` 决定旧帧去留（`apps/iris-web/src/app/MessageInterfaces.tsx`），宿主 `assertCurrent` 拒绝过期栅栏，资产面 404 掉旧 URL——三处一致 |
| 核心成员名单 | `MEMBER_KINDS`（`apps/iris-web/src/sandbox/identity.ts:69`）与 `CARD_METHODS`（`apps/iris-web/src/sandbox/card-api.ts:31`，37 项）**仍归 shell 所有**，插件不能往里加；插件只能在自己的命名空间下贡献成员 |

所有权链：store 收到快照 → CardScriptFrames/MessageInterfaces →（并入清单）→ runCard → buildSrcdoc → frame-entry → installSandbox。变更时旧 run/iframe 需要销毁；延迟 ready/fetch/RPC 回包不得复活旧 run。

### UI 插槽与设置面贡献

事实源：[slots.ts](../apps/iris-web/src/slots/slots.ts)、[Slot.tsx](../apps/iris-web/src/slots/Slot.tsx)、[message-actions.ts](../apps/iris-web/src/slots/message-actions.ts)。

| 插槽 | owner | 宿主用途 |
| --- | --- | --- |
| `iris.message.actions` | MessageActionOwner | 楼层动作菜单；按 registerMessageAction 的实际签名接入 |
| `iris.message.footer` | MessageSlotOwner | 消息下方附加内容 |
| `iris.sidebar.panels` | `{ chats, characters }` | 侧边栏附加面板 |
| `iris.settings.sections` | `Record<string, never>` | 插件自己的设置区块 |
| `iris.composer.actions` | `{ chatId, generating }` | 输入区附加操作 |

五个都是 root 作用域的 `list` 槽。注册方式是 `slots.core.register({ name, registrant, id, label }, () => element)`，返回撤销函数。

`iris.settings.sections` 在 #88 里真正有了消费者：设置抽屉的 `PluginSettings` 用 `useSlotOccupied('iris.settings.sections')` 查占位，**空的时候连标题和引导语都不渲染**（`apps/iris-web/src/app/SettingsDrawer.tsx:191`），因为贡献的生命周期就是插件的启用期，停用后不能留下一个声称「这里有设置」的标题。位置在插件中心下方、`plugins` 路由内（`SettingsDrawer.tsx:153`），理由写在该函数的文档注释里：设置面属于「管理插件的地方」，而不是诊断页。

当前唯一的注册者是 shell 内的 ST 扩展面（`apps/iris-web/src/st-extensions/plane.tsx`）。`main.tsx` 仍在页内构建单一 shell boot 图——**有 SlotCore 不等于外部代码能自动出现在页面上**：插件能自动进的是卡片帧（通过上面的 `client.js`），不是 shell。

## 6. 存储、生成与内置能力

| 能力 | 当前入口 | 边界 |
| --- | --- | --- |
| TH 宏 | `plugins/tavern-helper.ts` 的 `expandMacros(text, sources)` | capability 名 `macro-expander`（`packages/iris-app-service/src/plugins/capabilities.ts:16`）；通过调用时 lookup 热切换 |
| MVU | `plugins/mvu.ts` 的 `initialState`/`update`/`replay` | capability 名 `mvu-engine`（`capabilities.ts:19`）；返回计算结果，ChatEntry 拥有落盘 |
| ST 扩展浏览器面 | `buildStExtensionDefinition` 的 activation | capability 名 `st-extension-browser-plane`（`packages/iris-compat-st-extension/src/host/definition.ts:29`），是个诊断句柄；真正的运行时在浏览器 |
| 能力回退规则 | `tavernHelperCapability` / `mvuCapability`（`capabilities.ts`） | **没有 runtime** 时回退到插件化之前的实现（旧构造路径保持原行为）；**有 runtime 但插件停用**时返回 `undefined`，业务据此退化 |
| 变量仲裁 | `arbitrateMessageVariables`（[variable-arbitration.ts](../packages/iris-app-service/src/variable-arbitration.ts)） | 见下 |
| ST 扩展设置 | `StExtensionSettingsStore` | 每扩展一份原子 JSON，落在 `<profile>/st-extension-settings/<key>.json`（`packages/iris-app-service/src/index.ts:791`）；写口是 `stCompat.settings`，revision 过期或缺失就拒绝 |
| 原子写 | `atomic.ts`: atomicWriteFile、readJsonStore、quarantine* | app-service 内部基础设施；**不是**已发布插件存储 API |
| profile 互斥 | `host-lock.ts`: acquireHostLock | 每份数据目录只运行一个宿主，无绕过开关 |
| 插件偏好 | profile 内 `system-plugins.json` | runtime 独占写入；管理操作保持原子持久化。**v2**（PR-2）：每行除 `installed`/`enabled` 外可带 `source`（`builtin`/`git`/`dev`）、`remote`、`commit`、`path`、`treeHash`、`installedAt`；读 v1 就地升级（只给本次构建自己的内置定义补 `source: 'builtin'`），读到别的版本号走既有的「全体停摆、保留原文件、全部置 `error`」路径 |
| 系统插件包安装树 | profile 内 `system-plugins/`（`paths.ts` 的 `systemPluginPackages`） | 安装器布局 `staging/ claims/ installed/<id>/`，与 ST 的 `st-extensions/` **分开**（artifact 契约不同、id 命名空间不同）。只有 `git` 源的树在这里；`dev` 源就地加载用户自己的目录，卸载绝不碰它。**与 `<dataDir>/system-plugins/` 同名不同层**——后者是浏览器资产根（`plugin-assets.ts:117`），只放 `<id>/client/client.js`，两个常量的注释互相指向 |
| 生成与记账 | `service.ts` 既有生成路径 | 必须保留预算、取消、用量、错误及落盘链；**未提供**通用插件生成 hook |
| 用户脚本存储 | `storage.*` RPC | 卡脚本现有存储，不是系统插件通用 namespace |

### 消息变量仲裁

多个处理者（当前是 ST-Prompt-Template 与 MVU）可能在同一轮回复后都想写消息变量。规则写在 [variable-arbitration.ts](../packages/iris-app-service/src/variable-arbitration.ts) 的模块头：

- **每个处理者返回完整变量表**，但只有它相对**共同基线**的**增量**参与合并——这既保住互不相干的写入，也阻止后手的完整快照抹掉前手的无关键。
- **顺序照抄上游**：ST 里 Prompt-Template 以 `makeFirst` 注册在 `CHARACTER_MESSAGE_RENDERED` 上，MVU 这类卡脚本在其后，Iris 按同序应用。
- **后者胜**，且每一次覆盖都被记成一条 `VariableConflict { key, earlierPluginId, laterPluginId, winnerPluginId }`；路径按前缀重叠判定，深层写入不会被误判成无冲突。
- 结算只有**一处**：`packages/iris-app-service/src/service.ts:5148` 的 `arbitrateMessageVariables`，两个提案分别标 `pluginId: 'prompt-template'`（`:5119`）与 `pluginId: 'mvu'`（`:5142`），随后一次 `replaceVariables` 落盘，冲突以 `{ kind: 'variables', grade: 'note' }` 报告（`:5153`）。

注意这**不是**插件可用的 API：`variable-arbitration.ts` 是宿主内部模块，结算处**写死了这两个 pluginId**。新的写变量插件今天还接不进来（§8）。测试：[variable-arbitration.test.ts](../packages/iris-app-service/tests/variable-arbitration.test.ts)、[st-compat-floor-variables.test.ts](../packages/iris-app-service/tests/st-compat-floor-variables.test.ts)。

`beforeAssembly/afterAssembly/afterSerialize/afterReply`、`irisExtensions`、`extensions/<id>/` namespace 和声明式插件设置仍属于扩展设计。未读到对应实现前，不能写进「可用接口」列。

## 7. ST 扩展兼容面

一个未经修改的 SillyTavern 扩展，可以安装进 Iris 并在 shell 里的隐藏 iframe 中运行。这不是另一套插件系统：**一个 ST 扩展就是一个系统插件**，由 `buildStExtensionDefinition`（[definition.ts](../packages/iris-compat-st-extension/src/host/definition.ts)）做成 `SystemPluginDefinition` 形状的行，经 `adoptDefinition` 接纳，之后走的是 §2/§3 那一套目录、依赖、启停、卸载。该包**不 import `@iris/app-service`**，definition 的形状是结构化对齐的。

| 项 | 事实 |
| --- | --- |
| facade | 17 个 ST 模块路径的替身，源码在 `apps/iris-web/src/st-extensions/facade/`（17 个文件），由 `apps/iris-web/src/st-extensions/vite.st-ext.config.ts` 单独构建 |
| 映射表 | `ST_HOST_MODULE_PATHS`（`packages/iris-compat-st-extension/src/host-modules.ts:23`）列出这 17 条精确路径；精确匹配未命中时 `uniqueSuffixMatch` 把唯一后缀候选报成 `unknown` 并点名候选，绝不静默算 `mapped`，也不在有合理读法时报 `missing` |
| 够不着的东西 | 未映射的模块路径抛 `UnsupportedStCompatApiError`（`packages/iris-compat-st-extension/src/runtime/kernel-core.ts:18`）。已记录的偏差：`messageFormatting` 只做 HTML 转义、`saveChatConditional` 是 no-op、token 计数是估算、事件映射不完整——逐条见 [PILOT-REPORT](../notes/st-compat/PILOT-REPORT.md) |
| 安装 | RPC `stExtension.install({ path })` → `installFromDirectory`（`packages/iris-app-service/src/index.ts:846`）：读目录里的 `manifest.json`，把 `display_name` slugify 成 id，校验 id 合法，**安装树仍在则直接重新接纳**（`st-reinstall.ts`）、否则走 `Installer.installAs`，再 `normalizeManifest` → `adoptDefinition` |
| 安装源 | `ExtensionSource` 三种（[source.ts](../packages/iris-extension-installer/src/source.ts)）：`local-archive`、`local-directory`、`git`。git 必须是 `https://`（`file://` 只在 `allowLocalGit` 下给测试用），必须钉**完整 40 位十六进制 commit**（`assertPinnedCommit`，理由写在错误消息里：会动的 ref 会让锁记录说谎）；URL 含空白或引号直接拒 |
| git 执行方式 | 固定 argv、不过 shell；每次调用都用 `-c core.hooksPath=` 清空钩子路径，fetch 带 `--depth 1 --no-recurse-submodules --no-tags`——拉下来的树在 fetch/checkout 期间不能执行任何东西 |
| 静态分析 | [analyze.ts](../packages/iris-compat-st-extension/src/analyze.ts)（TypeScript AST，**不执行、不联网**）+ `manifest.ts` + `report.ts`；试点对象的锁定报告是 `packages/iris-compat-st-extension/reports/st-prompt-template@f9a07da.report.json`，普查脚本在 `notes/st-compat/survey/` |
| 资产路由 | `/iris-st-ext/<id>/<rev>/…` 加 `/iris-st-ext/<id>/manifest.json`（[st-ext-assets.ts](../packages/iris-app-service/src/st-ext-assets.ts)）：上游真实文件按原布局、facade 摆在其相对导入解析到的位置、vendor（jQuery/lodash）同一处挂载。停用或不存在的扩展**每条路径都 404**，manifest 也不例外。只有配置了 `webDistIndex` 才注册（`packages/iris-app-service/src/index.ts:1459`） |
| 卡片侧成员 | 激活时把成员代理 bundle 写到 `<dataDir>/system-plugins/<id>/client/client.js`，于是聚合清单长出一行、卡片帧按 §5 的机制装载它。代理只注册一个成员（`EjsTemplate`），每次调用经 tokened 通道转发进扩展帧——**卡片帧里不跑上游代码，扩展帧里不跑卡片代码** |
| 启停/卸载 | 就是 `plugin.enable/disable/uninstall`，没有第二套生命周期。**卸载保留安装树与设置文件**（artifact 和设置是用户数据）；同一目录再装是「重装」，不是静默覆盖 |
| 试点范围 | 只服务**一个**扩展：快照里第一个非内置的已安装行（`packages/iris-app-service/src/index.ts:838`、`apps/iris-web/src/st-extensions/plane.tsx`） |
| 信任模型 | 扩展代码跑在 shell 的沙盒 iframe（`sandbox="allow-scripts allow-downloads"`）里，卡片侧只能透过 tokened 成员代理够到它；这与「系统插件是与宿主同权的 Node 代码」是两条不同的线，见 §8 最后一行 |

测试：`packages/iris-compat-st-extension/tests/` 的 analyze/bridge/expansion/kernel-state/manifest/pilot-host，`packages/iris-extension-installer/tests/` 的 archive-security/recovery/source/transaction，`apps/iris-web/tests/` 的 st-ext-frame / st-ext-member-scan / st-ext-plane-core / st-ext-plane-extension / st-ext-projection-i18n，以及 [st-reinstall.test.ts](../packages/iris-app-service/tests/st-reinstall.test.ts)。浏览器验收脚本与证据在 `notes/st-compat/acceptance/`。

## 8. 下一批基础设施缺口与交付标准

按 main 2eccf30 重记。「未做」就是未做，不是「按草案调用」。

| 缺口 | 现状 | 完成条件 |
| --- | --- | --- |
| `Handlers` 改 Partial | **刻意不做**：全量映射是本次构建自己的声明，静态词表里缺 handler 要是编译错误（`packages/iris-app-service/src/service.ts:254` 的注释写明理由） | 无——除非这条理由被推翻 |
| `script.*` 与 TH 形状留在协议 | 未动：133 个静态键里 32 个是 `script.*`，`views.ts` 的 TH 类型原样 | 要么协议获得插件形状合并机制，要么承认 TH 只从实现剥离、不从契约剥离 |
| th-core 仍在浏览器 import 白名单 | 未动（`apps/iris/tests/architecture.test.ts` 的 `allowed` 集合，现另含 `@iris/plugin-web-api` 与 `@iris/text`） | 帧与宿主两侧的事件名/正则解析对齐要有别的办法 |
| 生成钩子（`AppServiceOptions`） | 未做：TH/MVU 经 `capabilities.ts` 在固定调用点被取用，没有 `beforePrompt`/`afterReplyText`/`onSettle` 之类的挂点 | 明确 owner、顺序、取消、错误语义与释放，再开放 |
| `scope.storage` / `scope.settings` | 未做：ST 设置走的是专门的 `StCompatOptions` 闭包，不是通用接口 | 路径包含性、原子写、损坏保留、profile lock 全部约束成立后再开放 |
| 插件可写变量 | 未做为 API：仲裁模块是宿主内部的，结算处写死两个 pluginId（`service.ts:5119`、`:5142`） | 带 scope 的读写 + `baselineFor` 提供者 + 提案注册，而不是继续加分支 |
| `contributeContext` / 开放 `ScriptContext` | 未做：`context.ts` 仍是单体 | —— |
| i18n 命名空间合并 | 未做，但**原因已经不是那张内联表了**：插件中心的 `COPY` 表在 #95 已并进 `apps/iris-web/src/app/i18n/strings.ts` 的 `pluginCenter*` 键族（ledger §98），安装路径的 85 个新键也在那里。缺的是**插件自己带文案**的那条路——ST 面板仍有独立的 `projection-i18n.ts`，宿主侧插件没有任何登记翻译的接口 | 平面记录改命名空间合并 |
| `expandHelperMacros` 走 `registerMacroLike` | 未做：`packages/iris-app-service/src/entry.ts` 里仍是第二遍宏扫描（[PLUGIN-FEASIBILITY](../notes/PLUGIN-FEASIBILITY.md) §7 阶段 0 的遗留项） | 接线即可，等 `entry.ts` 不再被重写 |
| 普查脚本改口径 | 未做 | 给普查一个不依赖文件位置的输入 |
| 可发布契约包 | **已闭合（#91）**：`npm run pack:contracts -- --version <semver>` 把 `@iris/plugin-api`、`@iris/plugin-web-api`、`@iris/protocol` 打成 tarball（`scripts/pack-contracts.mjs`，`docs/PLUGIN-CONTRACT-PACKAGING.md`），仓库外消费者测试 `apps/iris/tests/contract-pack.test.ts`；版本策略 `1.0.0-alpha.N`，cordis 作 peer | —— |
| 系统插件的包外安装路径 | **已闭合（PR-1/2/3 全部落地）**：一个 Node 系统插件包可以从插件中心的安装表单，经 `plugin.previewInstall` / `plugin.confirmInstall`，从 https git 远端（钉完整 commit）或本地 `dev` 目录装进某个 profile，走 §3 那四个方法与 §6 的 `system-plugins.json` v2；同意页显示 preview 的每一个字段并说明这是同权代码，确认回带的四个值全部读自 preview 对象；开机对 `git` 行重算 `hashTree`，不符即 `tampered` 且不激活，行上给「按记录的 remote + commit 重新安装」；六个失败状态在行上各有中英两句。**仍然开着的三件事**：(1) `plugin.update` 预留未实现（§12 裁决 2），更新路径是卸载后重装；(2) 安装器自己的 `validateExtensionSource` **不拒 URL 里的 userinfo**——系统插件这条路在 preview 前另做了一道拒绝，但 ST 扩展那条路没收紧，因为那会改 ST 行为（PR-2 记录）；(3) §9 不变量 #5（不递归子模块）**整棵树里没有测试**，`grep -rn submodule packages/*/tests` 为空（PR-2 记录）。没有 npm 名/任意 tarball 的路，这是 §11 明确否决的 | —— |
| per-plugin 帧 CSP | **不需要**：bundle 与帧同源（`selfOrigin` 已在 `script-src` 里），没有第二个远端要开 | —— |
| 信任模型的文档 | **已由实践确定、但未成文**：系统插件是与宿主同权的 Node 代码；ST 扩展代码跑在沙盒 iframe，卡片侧只经 tokened 成员代理触达。两条不同的线共用一个控制面 | 写进 [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)：同权插件的安装源约束（对照 [PLUGIN-FEASIBILITY](../notes/PLUGIN-FEASIBILITY.md) §8 问题 1 的「哈希锁定 vs 任意 git clone」） |

已从本表毕业的缺口（留档，附落地证据）：

- **动态 RPC schema/handler（2026-09-13 落地，#88 合入 main）**：协议注册表 [rpc-registry.ts](../packages/iris-protocol/src/rpc-registry.ts)（注册/验证/同名拒绝/身份检查撤销），`parseRequest` 两段查找且 pluginRevision 保留段未动；`AnyRpcMethod` 类型方案（`RpcMethod` 不扩、动态方法两侧 `unknown`）；`scope.registerRpc` 成对登记、失败回滚、fiber dispose 自动撤销、每次调用经 lease 收容。行为测试：[rpc-registry.test.ts](../packages/iris-protocol/tests/rpc-registry.test.ts)、[system-plugin-rpc.test.ts](../packages/iris-app-service/tests/system-plugin-rpc.test.ts)。**注意 main 上没有生产使用者**：随包发布的插件方法全是静态 schema。
- **fake 动态分发（2026-09-13 落地）**：`registerPluginMethod` 两半同拆、可按 `pluginId` 随目录行启停失效、未知动态名明确拒绝；静态 switch 与 `never` 穷尽守卫原样保留。行为测试：[plugin-methods.test.ts](../packages/iris-client-fake/tests/plugin-methods.test.ts)。
- **插件资产下发与聚合清单（#88）**：guarded 前缀路由、路径包含性、CORS/nosniff、内容 rev、`?rev=` 命中才 immutable、停用即 404、清单解析返回原因而不抛。行为测试：[plugin-assets.test.ts](../packages/iris-app-service/tests/plugin-assets.test.ts)、[plugin-assets-plane.test.ts](../apps/iris/tests/plugin-assets-plane.test.ts)、[plugin-browser-assets.test.ts](../apps/iris-web/tests/plugin-browser-assets.test.ts)、[plugin-browser-assets-mount.test.ts](../apps/iris-web/tests/plugin-browser-assets-mount.test.ts)。
- **可变长资产清单（#88）**：作为**第二份**清单落地，构建期 `manifest.json` 的四个固定键原样不动——理由写在 `PluginAssetManifest` 的文档注释里（三个构建工具按名消费那份清单，不能让运行期状态混进去）。
- **成员表合并（#88）**：核心表缺席整帧拒跑，单个插件缺席只拒该插件且报告点名，重名明确拒绝，销毁重建与 revision 一致。行为测试：[plugin-member-merge.test.ts](../apps/iris-web/tests/plugin-member-merge.test.ts)、[sandbox-srcdoc.test.ts](../apps/iris-web/tests/sandbox-srcdoc.test.ts)、[system-plugin-sandbox-lifecycle.test.ts](../apps/iris-web/tests/system-plugin-sandbox-lifecycle.test.ts)。
- **设置槽真正有了消费者（#88）**：`useSlotOccupied` 让空槽不渲染标题，位置在插件页而非诊断页。
- **契约包成形（#88）**：`@iris/plugin-api` 零 `@iris` 依赖、仅类型级 Cordis；`@iris/plugin-web-api` 仅类型级依赖 `@iris/protocol`。由 [contract.test.ts](../packages/iris-plugin-api/tests/contract.test.ts)、[purity.test.ts](../packages/iris-plugin-web-api/tests/purity.test.ts)、[architecture.test.ts](../apps/iris/tests/architecture.test.ts) 钉住。**成形不等于可发布**，见上表。

维护规则：新增/删除接口同一 PR 更新本表、公共类型和行为测试。以符号名定位代码，行号只作为某个提交的证据。声明「已实现」要有代码，声明「已验收」要有完整检查记录。
