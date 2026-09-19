<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">接口参考</h1>

<p align="center">公开契约、运行边界，以及尚未开放的能力。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

本文用于查接口；入门见[插件开发指南](PLUGIN-AUTHORING-RUNBOOK.md)，安装见[系统插件安装](SYSTEM-PLUGIN-INSTALL.md)。公共类型和 schema 是精确参数的依据，第 8 节统一维护能力缺口。

## 1. 分层、所有权与可用状态

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 宿主契约 | `@iris/plugin-api` | definition、scope、存储与变量提案类型 |
| 线协议 | `@iris/protocol` | RPC、事件和目录快照 |
| 浏览器契约 | `@iris/plugin-web-api` | 成员与资产清单 |
| 运行时 | `@iris/app-service` | 目录、依赖、激活、持久化与排空 |
| 页面 | `apps/iris-web` | 展示快照、加载资产、协调帧 |

`plugin-api` 无 Iris 运行时依赖，Cordis 仅用于类型；`plugin-web-api` 对 protocol 也只作类型引用。插件不要深层导入宿主 runtime。

## 2. 宿主插件公开契约

定义见 [`SystemPluginDefinition` 与 `SystemPluginActivationScope`](../packages/iris-plugin-api/src/index.ts)。

definition 包含 `id`、`name`、`description`、`version`、`apiVersion: 1`、可选 `dependencies` 和 `activate(scope)`。激活可返回 `void`、清理函数或对应 Promise。

| scope 成员 | 行为 |
| --- | --- |
| `context`、`pluginId`、`revision` | 当前 Cordis 上下文、插件 id、激活代次 |
| `provide(name, value)` | 发布能力并返回撤销函数 |
| `getDependency(id, name)` | 读取已声明依赖的能力，缺失为 `undefined` |
| `registerRpc(name, schema, handler)` | 成对登记校验与处理器 |
| `variables.registerWriter(writer)` | 注册消息变量提案 |
| `storage` | 插件私有 JSON 存储 |

### 动态 RPC

schema 提供 `safeParse`，返回带 `success` 的结果。与静态或已有动态方法同名时拒绝；部分登记失败必须回滚。

每次调用受 revision 与 lease 管理。停用时 schema、handler 一起撤销；旧注册不能撤销新实例的同名注册。动态方法边界为 `unknown`，不自动获得静态 `RpcResponseMap` 的类型推导。

实现：[协议注册表](../packages/iris-protocol/src/rpc-registry.ts) · [运行时测试](../packages/iris-app-service/tests/system-plugin-rpc.test.ts)。

### 变量 writer

`baselineFor` 选择基线，`propose` 返回完整变量表或 `undefined`。宿主在统一结算处按依赖深度、id 收集提案；无关修改合并，重叠路径后者优先并记录冲突。

每个 writer 上限 5 秒；抛错或超时作废本次提案，插件记为 `hook-failed` 但仍启用。回复继续落盘，下次成功提案清除失败。每次结算每插件只调用一次，使用已取得的参与者快照；模拟用户发言不进入这条提案路径。

`write-variables` 是清单声明，不是隔离同权 Node 代码的闸门。

### 私有存储

| 项目 | 规则 |
| --- | --- |
| 方法 | 异步 `get`、`set`、`delete`、`keys` |
| 路径 | `<profile>/plugin-data/<id>/<key>.json` |
| 键 | `[a-z0-9][a-z0-9._-]{0,63}`，并检查路径包含性 |
| 值 | JSON；拒绝危险键、函数、类实例等 |
| 配额 | 单值 1 MiB，每插件 64 MiB |
| 缺失 | `get` 返回 `undefined` |
| 写入 | 原子写，受 profile 锁保护 |
| 损坏 | 隔离文件并报告，不影响其他键 |
| 声明 | 包清单需含 `plugin-storage`，否则四个方法均拒绝 |
| 生命周期 | 停用后写入不可用；卸载后旧 scope 失效 |

卸载默认保留数据，`removeData: true` 才请求删除。精确错误语义见 [runtime](../packages/iris-app-service/src/system-plugins.ts) 与[存储实现](../packages/iris-app-service/src/plugins/storage.ts)。

### 宿主内部控制接口

`adoptDefinition`、`replaceInstalled`、`assertCurrent`、`lease`、`orderedVariableWriters` 属于宿主内部。新请求检查当前代次，已接纳的 lease 可以在停用期间排空。

依赖按拓扑顺序激活；未知依赖、环或失败明确报告并回滚。仍有启用中的依赖者时，停用、重载、卸载返回 `busy`。没有通用强制排空超时，插件不能等待停用自身。

### 默认启用集与持久化

内置酒馆助手与 MVU 默认启用，MVU 依赖酒馆助手；新装第三方插件不默认启用。偏好先持久化再推进状态，失败不伪报成功；启动偏好损坏时保留证据并报告。新宿主会话 revision 可以低于旧进程，浏览器只在同一会话内禁止倒退。

## 3. 管理 RPC、事件与错误

| 类别 | 方法 |
| --- | --- |
| 目录与生命周期 | `plugin.list`、`install`、`enable`、`disable`、`reload`、`uninstall` |
| 包安装 | `plugin.previewInstall`、`confirmInstall`、`cancelInstall` |
| Git 更新 | `plugin.update({ id, commit })`，返回预览后再确认 |

目录快照带 revision 和插件投影。状态包括 `not-installed`、`disabled`、`enabling`、`enabled`、`disabling`、`error`；页面协调列表、事件和 mutation 回包，不让旧结果覆盖新快照。

失败类型与处理方式见[安装说明](SYSTEM-PLUGIN-INSTALL.md#7-加载与失败状态)。`hook-failed` 不表示插件停用。未知或当前不可用的方法答 `unsupported`，不返回假成功。

请求以 [`requestSchemas`](../packages/iris-protocol/src/rpc.ts) 为准，响应以 `RpcResponseMap` 为准。

## 4. 业务 RPC 目录（完整方法名索引）

下表保留 2026-09-16 的静态接口盘点，共 138 项；不是实时统计，也不是 ST API 覆盖率。运行期插件方法不计入此表，卡片不能据此调用全部宿主方法。

表中省略重复域前缀；`stCompat.plane.attach` 等三段名称仍是一个完整方法。

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
| prompt | 2 | itemize（响应带解释，见下）, divergence |
| regex | 11 | list, set, scopedList, setScopedAllowed, setScopedEnabled, presetList, setPresetAllowed, setPresetEnabled, tavernList, tavernReplace, tavernFormat |
| script | 33 | getVariables, setVariables, swipeTo, slash, list, setEnabled, setDocumentGrant, setScriptsAllowed, fetch, context, saveMetadata, createChatMessages, deleteChatMessages, getPreset, evalTemplate, replaceScriptButtons, saveChat, setExtensionPrompt, runEnded, report, body, setExtensionSettings, generateRaw, setChatMessages, generate, getCharacter, chatHistoryBrief, chatHistoryDetail, rotateChatMessages, createOrReplacePreset, deletePreset, renamePreset, loadPreset |
| scriptLibrary | 5 | list, read, save, delete, setEnabled |
| settings | 2 | get, set |
| stCompat | 4 | plane.attach, plane.detach, submit, settings |
| stExtension | 1 | install |
| storage | 3 | set, remove, clear |
| usage | 1 | summary |
| worldbook | 14 | names, load, get, charNames, charDigest, globalSelect, setGlobalSelect, replace, create, bindChat, setCharBooks, settings, setSettings, delete |

`guardTavernHelper` 管理脚本方法所有权；与原生 UI 共用的写口区分是否带帧约束，授权管理和 `script.runEnded` 清理入口保持可达。迁移方法时同时迁移此语义。

`Handlers` 保持全量映射：静态词表声称支持的方法缺少 handler，应是编译错误；运行期方法才走动态注册和明确拒绝。

### 提示词解释

`prompt.itemize` 的条目可带 `explanation`：

| 字段 | 含义 |
| --- | --- |
| `source` | kind 与 id：preset、card、worldbook、history、script、host |
| `zeroReason` | token 为 0 时的原因，已产出 `macros-only`、`marker-unfilled` |
| `placement`、`stable` | 最终消息位置，以及是否位于首个易变片段前 |
| `macros` | 宏头、解析次数、展开前后 UTF-16 字符数 |
| `regex` | 实际改写规则名；历史聚合行记录命中规则并集 |

`messages` 提供消息到 `partIds` 的反向索引，`overflow` 记录裁掉的楼层、token 和可选 `history.N` id；均来自同一次装配，不由前端重算。

`blank`、`trimmed`、`dropped-by-budget` 是预留原因；留白预设不产生解释行。新增字段可选，报告带来源和数字，不携带正文。

## 5. 浏览器契约、资产面、成员合并与 UI 插槽

资产清单只列已启用且实际提供资产的插件，包含内容 revision 与可选 `client`、`i18n`。它与构建期固定键的沙箱清单不同，不合并。

| 项目 | 行为 |
| --- | --- |
| 聚合清单 | `no-cache` |
| revision 资产 | 内容 SHA-1 前 12 位匹配 `?rev=` 才可 immutable，否则 `no-cache` |
| 禁用 | 移出清单，资产返回 404 |
| 路径与响应 | 路径包含性、Host 防护、CORS、nosniff |
| 文案 | en/zh 扁平表；键一致、中文含汉字、占位符一致；每份 256 KiB / 2,000 条 |
| 文案命名空间 | `plugin:<id>:<key>`，当前语言 → en → 键名；禁用后移除 |

`registerPluginMembers` 使用字面量 id 与成员键。核心成员缺失时整帧拒跑；插件缺失、重复登记、冲突、未获准 id 或坏形状时，只拒绝对应插件，不接受半登记状态。

`iris.settings.sections` 已有页面消费者，空槽不显示标题；这不等于外部插件已有通用设置贡献 API。

测试：[资产面](../packages/iris-app-service/tests/plugin-assets.test.ts) · [浏览器装载](../apps/iris-web/tests/plugin-browser-assets-mount.test.ts) · [成员合并](../apps/iris-web/tests/plugin-member-merge.test.ts)。

## 6. 存储、生成与内置能力

角色、聊天与设置属于宿主存储，不是插件安装树。profile 隔离不等于插件能任意切换 profile；一个数据目录只允许一个宿主。

禁用 MVU 后不初始化、更新或补放命令，重新启用不重放停用期间文本。停用 TH 后，原生聊天、宏、世界书与静态消息仍应可用；依赖它的脚本明确不可用。

ST 兼容变量桥、MVU 和第三方 writer 进入同一仲裁注册表，不按插件名另开结算分支。通用生成钩子是另一项能力，不能由变量 writer 推断它已实现。

契约包可用 `npm run pack:contracts -- --version <semver>` 生成独立 tarball；工作区仍为私有源码包。见[契约打包说明](PLUGIN-CONTRACT-PACKAGING.md)。

## 7. ST 扩展兼容面

`stExtension.install({ path })` 从本地 `manifest.json` 规范化并接纳 definition，后续走同一 `plugin.*` 生命周期。安装分析不执行扩展。

运行依赖隐藏的 facade iframe 和已映射接口，当前试点只服务一个非内置扩展，不保证任意 SillyTavern 扩展可用。

未映射 API 抛 `UnsupportedStCompatApiError`。已知差异包括 `messageFormatting` 转义、`saveChatConditional` 空操作、token 估算与部分事件覆盖，同名门面不等于完整上游实现。

卸载保留 ST 安装树与设置，和 Node 包不同。见 [ST 试点报告](../notes/st-compat/PILOT-REPORT.md)与[扩展设计](ST-EXTENSION-DESIGN-AND-RUNBOOK.md)。

## 8. 下一批基础设施缺口与交付标准

这里集中维护未提供的能力与有意保留的边界。历史来源为 2026-09-16 接口盘点；实现变化时同步更新公共类型、测试和本表。

### 8.1 仍开着的缺口

| 项目 | 现状与完成条件 |
| --- | --- |
| `Handlers` 改 Partial | 有意不做，保留静态方法编译期完整性 |
| `script.*` 与 TH 类型移出协议 | 仍在静态契约，需先解决插件形状合并 |
| 移除浏览器 th-core 依赖 | 仍在允许列表，需替代两侧事件名和正则共享机制 |
| 通用生成钩子 | `scope.hooks` 尚未提供，按[设计稿](GENERATION-HOOKS.md)分步实现 |
| 通用事件订阅与 `scope.settings` | 尚未提供；ST 闭包和宿主槽不是外部通用接口 |
| `contributeContext` / 开放 `ScriptContext` | 尚未提供，不按草案调用 |
| `expandHelperMacros` 合并宏扫描 | 需接入 `registerMacroLike`，避免第二轮扫描 |
| ST 普查输入 | 仍依赖扩展与 ST public 目录，需与文件位置解耦 |
| 旧记录中的凭据 | 新来源拒绝 userinfo，但未清洗旧 profile；旧锁和偏好可能含凭据 |
| 子模块参数验证 | 行为由“不运行 submodule update”保证；flag 文本检查不冒充行为验证 |
| 每插件独立帧 CSP | 同源 bundle 无需额外远端策略，出现跨源来源再评估 |

### 8.2 已提供的能力与证据

| 能力 | 证据 |
| --- | --- |
| 动态 RPC 与撤销 | [协议注册测试](../packages/iris-protocol/tests/rpc-registry.test.ts)、[运行时测试](../packages/iris-app-service/tests/system-plugin-rpc.test.ts) |
| 模拟客户端动态分发 | [plugin-methods.test.ts](../packages/iris-client-fake/tests/plugin-methods.test.ts) |
| 包安装与更新 | [安装测试](../packages/iris-app-service/tests/plugin-install.test.ts) |
| 私有存储 | [存储实现](../packages/iris-app-service/src/plugins/storage.ts) |
| 变量 writer | [仲裁测试](../packages/iris-app-service/tests/variable-arbitration.test.ts) |
| 浏览器资产与成员 | [资产测试](../packages/iris-app-service/tests/plugin-assets.test.ts)、[成员测试](../apps/iris-web/tests/plugin-member-merge.test.ts) |
| 独立契约包 | [打包说明](PLUGIN-CONTRACT-PACKAGING.md)、[仓库外消费测试](../apps/iris/tests/contract-pack.test.ts) |

实现存在不等于全部浏览器路径已经验收。“已验收”应附命令、范围和结果；原始调查见[记录目录](../notes/README.md)。
