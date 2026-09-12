# Iris 基础设施接口清单

核对日期：2026-09-12。适用基线：`dev/system-plugins` 的 `ae55920` 加当前契约包迁移工作区；**不代表 main 已有这些插件接口，也不代表整体验收通过**。本清单只记录读取到的实现，设计草案不算可调用 API。

配套：[插件制作与执行手册](PLUGIN-AUTHORING-RUNBOOK.md)、[系统插件架构](SYSTEM-PLUGINS.md)。实施落点草案另见 [PLUGIN-CONTRACT-LANDING-SITES](../notes/PLUGIN-CONTRACT-LANDING-SITES.md)。

## 1. 分层、所有权与可用状态

| 层 | 入口 | 职责 | 当前状态 |
| --- | --- | --- | --- |
| 组合与依赖 | `apps/iris/cordis.yml` | Cordis 服务组合；按 inject 依赖启动，文件排列不保证顺序 | main 已有 |
| 宿主插件契约 | `@iris/plugin-api` | definition、activation scope、lease、runtime options | 工作区已接入；0.0.0、private，未发布 |
| 宿主控制面 | `packages/iris-app-service/src/system-plugins.ts` | 目录、依赖、持久化、状态、Cordis 子 fiber、排空与释放 | 分支实现，待整体验收 |
| 线协议 | `@iris/protocol` | requestSchemas、请求/响应类型、IrisEvent | main 已有；分支增加 plugin.* |
| HTTP/WS | `@iris/rpc-host`、`@iris/rpc-client` | 请求路由、验证、错误、事件、重连 | 已有；动态 schema 尚未接入 |
| 聊天业务 | app-service 的 entry/chats/service | 聊天持久化与生成；通过 capability 调用 TH/MVU | 分支正在抽离 |
| 浏览器契约 | `@iris/plugin-web-api` | 帧能力快照、meta 标识与编解码、revision 附加 | 工作区已接入；仍固定 TH/MVU 两个能力 |
| UI 插槽 | `apps/iris-web/src/slots/` | 五个页面扩展点、可撤销注册和渲染 | main 已有；非外部插件加载器 |
| 插件中心 | `apps/iris-web/src/app/PluginCenter.tsx` | 目录、依赖、启停/重载/卸载、状态与错误展示 | 分支实现，待浏览器验收 |
| 动态贡献 | RPC schema、/plugins 资产、成员合并、dsh.client 扫描 | 让插件无需改核心即可贡献功能 | 待实现，不可按草案调用 |

系统插件、卡脚本、shell UI 是三种执行位置。宿主系统插件运行在 Node 进程内，具有宿主权限；卡片 JavaScript 运行在既有 iframe 沙盒。不能把卡片脚本直接当系统插件加载。

## 2. 宿主插件公开契约

事实源：[plugin-api/src/index.ts](../packages/iris-plugin-api/src/index.ts)。外部实现应依赖这里的类型；runtime 类和 TH/MVU 私有实现不是公共 SDK。

| 接口/字段 | 类型或签名 | 语义 |
| --- | --- | --- |
| `SystemPluginDefinition` | `{ id, name, description, version, apiVersion: 1, dependencies?, activate }` | id 为目录主键；version 为实现版本；apiVersion 为契约版本 |
| `activate(scope)` | `void \| Disposable \| Promise<void \| Disposable>` | 完成激活；返回释放函数，允许异步释放；异常进入失败处理 |
| `scope.context` | Cordis `Context` | 本次激活的 child context；不是新的 root context |
| `scope.pluginId` | `string` | 当前插件 id |
| `scope.revision` | `number` | 此次激活对应的快照版本；不是插件版本号 |
| `scope.provide<T>(name, value)` | `() => void` | 发布当前插件拥有的 capability；返回撤销函数 |
| `scope.getDependency<T>(id, name)` | `T \| undefined` | 只读已声明依赖的 capability；未声明依赖会抛错，能力缺失返回 undefined |
| `SystemPluginLease` | `{ pluginId, revision, incarnation, isCurrent, assertCurrent, release }` | 已接纳工作持有的生命周期凭据；release 幂等 |
| `SystemPluginRuntimeOptions` | `{ context, file, definitions, defaultEnabled?, onError?, writePreferences? }` | runtime 构造参数；writePreferences 是测试替换点 |

目前 scope **没有** `registerRpc`、`storage`、`settings`、`hooks`、`registerPluginMembers` 或事件订阅快捷接口。不要从草案复制这些名字后直接调用。

### 宿主内部控制接口

事实源：[system-plugins.ts](../packages/iris-app-service/src/system-plugins.ts)。这些供宿主接线和测试使用，插件包不要深导入 runtime 实现。

| 方法 | 返回 | 用途 |
| --- | --- | --- |
| `initialize()` | `Promise<SystemPluginSnapshot>` | 读偏好、提升启动 revision、恢复启用集与依赖 |
| `snapshot()` | `SystemPluginSnapshot` | 当前目录和状态投影 |
| `isEnabled(id)` | `boolean` | 是否已完成激活且可接纳新工作 |
| `onChange(listener)` | 撤销函数 | 订阅提交后的快照；监听器异常单独报告 |
| `capability<T>(id, name)` | `T \| undefined` | 只在所有者接纳新工作时返回能力 |
| `assertCurrent(id, expectedRevision?)` | `void` | 检查当前启用状态及请求 revision |
| `lease(id, expectedRevision?)` | `SystemPluginLease` | 接纳工作并计入 drain |
| `install/enable/disable/reload/uninstall(id)` | `Promise<SystemPluginSnapshot>` | 串行控制操作 |
| `dispose()` | `Promise<void>` | 宿主关闭时排空和释放 |

注意两个“当前”的区别：`runtime.assertCurrent()` 控制新工作；已经持有的 `lease.isCurrent()` 在 disabling 排空期间仍可为真，使已接纳任务完成提交。停用返回成功后，旧 activation 的工作必须全部结束。不要在任务中途重新取 capability 来代替已经持有的对象。

capability 在实现中使用 `iris.system-plugin:<id>:<name>` 服务名。插件通过 scope 访问，不要依赖这个私有字符串格式。

## 3. 管理 RPC、事件与错误

事实源：[rpc.ts](../packages/iris-protocol/src/rpc.ts)、[system-plugins.ts](../packages/iris-protocol/src/system-plugins.ts)、[events.ts](../packages/iris-protocol/src/events.ts)。

| 方法 | 参数 | 行为 |
| --- | --- | --- |
| `plugin.list` | `{}` | 读取完整目录 |
| `plugin.install` | `{ id }` | 安装目录内实现；安装后停用 |
| `plugin.enable` | `{ id }` | 按依赖顺序安装/启用所需项 |
| `plugin.disable` | `{ id }` | 关闭入口、排空、释放；存在启用的依赖方则拒绝 |
| `plugin.reload` | `{ id }` | 实际释放并重新激活；存在启用的依赖方则拒绝 |
| `plugin.uninstall` | `{ id }` | 移除本 profile 的安装状态；保留业务数据 |

六个方法均返回 `SystemPluginSnapshot = { revision, plugins }`。每项含 `id/name/description/version/apiVersion/dependencies/installed/enabled/status/error?`；status 为 `not-installed | disabled | enabling | enabled | disabling | error`。

事件：`{ type: 'plugins.changed', snapshot }`。前端以宿主快照为准，不在按钮点击时直接写 enabled。快照是整个 runtime 的 revision，任何插件变更都可能使旧帧请求过期；它不是安全认证令牌。

`pluginRevision?: number` 附在帧请求上，由 `parseRequest` 单独校验、保留（非负安全整数），不能被 zod 未知字段裁剪吞掉。它不替代脚本授权、角色范围检查或 HTTP 防护。

传输入口为 `POST /iris/rpc`、`WS /iris/events`。可关联的业务拒绝仍可能是 HTTP 200，必须读响应帧 `ok/error`；优先使用 `IrisHttpClient`，其 `call()` 会抛 `IrisRpcError`。协议细节见 [rpc-host README](../packages/iris-rpc-host/README.md)。

| 运输接口 | 位置 | 合同 |
| --- | --- | --- |
| `irisRpc.register(method, handler)` | rpc-host | 当前只接受静态 RpcMethod；重名抛错；返回带身份检查的撤销函数 |
| `irisRpc.broadcast(event)` | rpc-host | 发布已定义的 IrisEvent |
| `irisRpc.guard(handler)` | rpc-host | 自建 HTTP 路由必须经过的 Host 等请求防护 |
| `client.call(method, params)` | IrisClient | 类型化请求/响应；不会等待生成结束才返回 chat.send |
| `client.subscribe(listener)` | IrisClient | 事件订阅，返回撤销函数 |
| `client.onConnectionChange(listener)` | IrisClient | 重连信号，返回撤销函数；需要重新读取权威快照 |

## 4. 业务 RPC 目录（完整方法名索引）

本次从 requestSchemas 提取 **128 个方法**（main 原有 122 + plugin 6）。这是宿主线协议数量，不是 ST API 覆盖率，也不表示卡片可以调用全部方法。参数权威为 rpc.ts 的 requestSchemas，响应权威为 RpcResponseMap；不在文档维护第二份容易漂移的 schema。

下列均为 `域.方法`；表内省略重复域前缀。

| 域 | 数量 | 方法 |
| --- | ---: | --- |
| backup | 4 | list, preview, restore, delete |
| character | 8 | list, import, delete, duplicate, rename, export, setTags, favorite |
| chat | 18 | list, create, open, delete, rename, reorder, search, answerCleanup, send, regenerate, compact, abort, swipe, editMessage, deleteMessage, branch, import, export |
| connection | 5 | list, save, delete, activate, test |
| debug | 1 | reports |
| persona | 4 | list, get, set, delete |
| plugin | 6 | list, install, uninstall, enable, disable, reload |
| preset | 12 | list, select, view, setEnabled, move, upsertPrompt, removePrompt, save, delete, read, import, importFile |
| prompt | 2 | itemize, divergence |
| regex | 11 | list, set, scopedList, setScopedAllowed, setScopedEnabled, presetList, setPresetAllowed, setPresetEnabled, tavernList, tavernReplace, tavernFormat |
| script | 32 | getVariables, setVariables, swipeTo, slash, list, setEnabled, setDocumentGrant, setScriptsAllowed, fetch, context, saveMetadata, createChatMessages, deleteChatMessages, getPreset, evalTemplate, replaceScriptButtons, saveChat, setExtensionPrompt, runEnded, body, setExtensionSettings, generateRaw, setChatMessages, generate, getCharacter, chatHistoryBrief, chatHistoryDetail, rotateChatMessages, createOrReplacePreset, deletePreset, renamePreset, loadPreset |
| scriptLibrary | 5 | list, read, save, delete, setEnabled |
| settings | 2 | get, set |
| storage | 3 | set, remove, clear |
| usage | 1 | summary |
| worldbook | 14 | names, load, get, charNames, charDigest, globalSelect, setGlobalSelect, replace, create, bindChat, setCharBooks, settings, setSettings, delete |

`service.ts` 的 `guardTavernHelper` 是当前脚本方法所有权清单：脚本执行入口总是检查 TH；与原生 UI 共用的 worldbook 写口仅对带帧 fence 的调用做 TH 检查。授权管理和 `script.runEnded` 清理入口保持可达。未来拆 schema/handler 时必须一起迁移这层语义。

## 5. 浏览器契约、UI 插槽与沙盒

事实源：[plugin-web-api](../packages/iris-plugin-web-api/src/index.ts)。

| 名称 | 参数/返回 | 语义 |
| --- | --- | --- |
| `SandboxPluginRuntime` | `{ revision, tavernHelper, mvu }` | 一次 iframe 生命周期固定的能力快照；当前不是通用第三方插件图 |
| `sandboxPluginRuntime(snapshot)` | 快照或 undefined | 仅 installed/enabled/status 三者一致才开放；MVU 要求 TH 启用 |
| `SYSTEM_PLUGIN_RUNTIME_META` | `iris-system-plugins` | srcdoc writer 与 bootstrap reader 共用的 meta 名 |
| `encodeSandboxPluginRuntime(runtime)` | JSON 字符串 | 调用方放入 HTML 属性前仍须做属性转义 |
| `parseSandboxPluginRuntime(text)` | runtime 或抛错 | 拒绝缺失、坏 JSON、非法 revision、MVU 单独启用 |
| `fenceFrameParams(params, revision)` | payload | 为对象参数附加/覆盖 pluginRevision；非对象原样返回 |
| `DEFAULT_SANDBOX_PLUGIN_RUNTIME` | revision 0、两者启用 | 仅旧直接构造路径兼容默认；实时 UI 不得用它代替加载失败的权威快照 |

所有权链：store 收到快照 → CardScriptFrames/MessageInterfaces → runCard → buildSrcdoc → frame-entry → installSandbox。变更时旧 run/iframe 需要销毁；延迟 ready/fetch/RPC 回包不得复活旧 run。

UI 插槽事实源：[slots.ts](../apps/iris-web/src/slots/slots.ts)、[message-actions.ts](../apps/iris-web/src/slots/message-actions.ts)。

| 插槽 | owner | 宿主用途 |
| --- | --- | --- |
| `iris.message.actions` | MessageActionOwner | 楼层动作菜单；按 registerMessageAction 的实际签名接入 |
| `iris.message.footer` | MessageSlotOwner | 消息下方附加内容 |
| `iris.sidebar.panels` | `{ chats, characters }` | 侧边栏附加面板 |
| `iris.settings.sections` | 空对象 | 设置扩展内容 |
| `iris.composer.actions` | `{ chatId, generating }` | 输入区附加操作 |

这些是已存在的内部 UI 接缝。`main.tsx` 仍在页内构建单一 shell boot 图；不能因为有 SlotCore 就声称外部 client.js 可以自动加载。

## 6. 存储、生成与内置能力

| 能力 | 当前入口 | 边界 |
| --- | --- | --- |
| TH 宏 | `plugins/tavern-helper.ts` 的 expandMacros | capability 名 `macro-expander`；通过调用时 lookup 热切换 |
| MVU | `plugins/mvu.ts` 的 initialState/update/replay | capability 名 `mvu-engine`；返回计算结果，ChatEntry 拥有落盘 |
| 原子写 | `atomic.ts`: atomicWriteFile、readJsonStore、quarantine* | app-service 内部基础设施；不是已发布插件存储 API |
| profile 互斥 | `host-lock.ts`: acquireHostLock | 每份数据目录只运行一个宿主 |
| 插件偏好 | profile 内 `system-plugins.json` | runtime 独占写入；管理操作保持原子持久化 |
| 生成与记账 | `service.ts` 既有生成路径 | 必须保留预算、取消、用量、错误及落盘链；未提供通用插件生成 hook |
| 用户脚本存储 | `storage.*` RPC | 卡脚本现有存储，不是系统插件通用 namespace |

`beforeAssembly/afterAssembly/afterSerialize/afterReply`、`irisExtensions`、`extensions/<id>/` namespace 和声明式插件设置仍属于扩展设计。未读到对应实现前，不能写进“可用接口”列。

## 7. 下一批基础设施缺口与交付标准

| 缺口 | 完成条件 |
| --- | --- |
| 动态 RPC schema/handler | 注册、验证、响应类型方案、同名拒绝、失败回滚、dispose 撤销；保留 pluginRevision；入口仍检查 admission/lease，不能只依赖最终撤销 |
| fake 动态分发 | 随插件启停生效，未知方法明确拒绝；保留静态方法检查 |
| 插件资产与 dsh.client | 实际 guarded 路由、路径包含性、正确 CORS/nosniff、清单验证和加载失败可见 |
| 资产版本与缓存 | rev 必须对应不可变字节；旧 rev 不得返回新代码并标 immutable；未满足时使用 no-cache |
| 成员表合并 | core 缺失拒绝运行；插件缺失可定位；重名明确拒绝；销毁重建与 revision 一致 |
| 可发布契约包 | 移除 private 前准备构建 JS/类型入口、peer 依赖策略、版本兼容和包外消费者测试；当前 TS 源码工作区包不等于可发布 SDK |
| 通用存储/钩子/设置 | 明确 owner、错误语义、顺序、取消、释放与测试，再开放给插件作者 |

维护规则：新增/删除接口同一 PR 更新本表、公共类型和行为测试。以符号名定位代码，行号只作为某个提交的证据。两个工具同时施工时先指定文件 owner；声明“已实现”要有代码，声明“已验收”要有完整检查记录。
