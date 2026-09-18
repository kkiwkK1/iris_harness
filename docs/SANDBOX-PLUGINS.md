# 沙箱插件设计：一句话让这张卡长出一个功能

> 状态：**设计稿**，不是现状文档。owner 于 2026-09-18 立项（第二阶段，代号 **沙箱插件 / sandbox plugins**），本文只设计、不实现。描述 `main` `96b1a8e` 的现状，核对于 2026-09-18；数字与路径以该提交为证据，行号会漂移，符号名不会。
>
> **照本文写的代码今天一行都跑不起来**：`96b1a8e` 上没有任何 `SandboxPlugin` 类型、没有 `plugin` 方向的帧协议消息、`registerPluginMembers`（`apps/iris-web/src/sandbox/members-entry.ts:90`）没有撤销口、`collectPluginMembers`（`apps/iris-web/src/sandbox/plugin-members.ts:52`）一帧只跑一次。本文的每一节都要说清它是在描述已有的东西，还是在提出要造的东西。

## 本文与其他文档的关系

| 要找什么 | 去哪 |
| --- | --- |
| 沙箱的冻结策略、CSP、已接受的缺口 | [SANDBOX](SANDBOX.md)（本文 §2、§7 全部依赖它） |
| 卡脚本自动运行的同意门 | [AUTORUN](AUTORUN.md)（本文 §4.2、Q17 依赖它） |
| **系统插件**（同权 Node 代码，与本文的插件是两回事） | [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)「Trust model」；本文 §3.1 是两者的逐行对照 |
| 系统插件包的安装路径与同意页先例 | [SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §5.3（本文 §4.1 抄它的时序形状） |
| 七个失败状态的词表 | [PLUGIN-AUTHORING-RUNBOOK](PLUGIN-AUTHORING-RUNBOOK.md)「七个失败状态」；本文 §6 说明为什么沙箱插件另起一套名字 |
| 可调用的接口面与**唯一维护的缺口清单** | [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §5（帧侧成员合并）、§8（缺口表；本文不另立第二份） |
| 「卡坏掉时谁看得见」 | [OBSERVABILITY](OBSERVABILITY.md) 与 [DEBUG-SURFACE](DEBUG-SURFACE.md)（本文 §8） |
| 这个点子从哪来（deepseek-harness 创造模式的调研） | [notes/RESEARCH-DSH-CREATE-MODE-2026-09-18.md](../notes/RESEARCH-DSH-CREATE-MODE-2026-09-18.md) |
| 同样要写 sidecar 的那条线（工具循环） | [notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md](../notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md)；本文 §10 与它共用一条边界 |
| 将来要写的作者文档（模型读的那份） | `docs/SANDBOX-PLUGIN-AUTHORING.md`（**尚未存在**，由 PR-B 交付，见 Q15） |

---

## 0. 被现状推翻的前提（三条），与一条同等要命的补充

立项说明里有三条假设在 `96b1a8e` 上不成立，另有一条没人写进假设但同样决定落点。先写在这里，因为下面的每一节都按更正后的事实设计。

**0.1 帧侧没有 `registerMacro` / `registerSlashCommand` / `registerFunctionTool` / `registerVariableSchema`。** 这些名字确实出现在 `apps/iris-web/src/sandbox/upstream-surface.ts` 里，但那是两张**名单**——`UPSTREAM_CONTEXT_MEMBERS`（`apps/iris-web/src/sandbox/upstream-surface.ts:92`，上游 `getContext()` 声明的 145 个键）与 `UPSTREAM_MEMBERS`（`upstream-surface.ts:241`，酒馆助手 `@types` 声明的 171 个名字）——它们存在的目的是让**拒绝的句子点得出名字**，不是实现。该文件开头写得很清楚：「Membership here says nothing about whether Iris implements a member」。Iris 真正提供给卡的成员在 `MEMBER_KINDS`（`apps/iris-web/src/sandbox/identity.ts:69`，124 个），**其中一个 `register*` 都没有**；`registerMacroLike` 在 `apps/iris-web/src/sandbox/tavern-helper.ts` 里只作为一句注释出现，原话是「this host has no such member」。帧侧唯一真实的注册函数是 `registerPluginMembers`（`members-entry.ts:90`），而那是**系统插件**往成员表里塞成员用的，卡够不着。

于是 owner 裁决 4(c) 的「既有 `register*` API」要重述为：**插件拿到的是卡脚本今天拿到的那 124 个成员**（事件总线 `eventOn`/`eventEmit`、脚本按钮 `replaceScriptButtons` 一族、变量、世界书、`triggerSlash` 等），加上 37 个可路由的线方法（`CARD_METHODS`，`apps/iris-web/src/sandbox/card-api.ts:31`）。这不是缩水：那 124 个成员**就是**卡今天能做的全部事，插件与卡同权是设计的目标。宏与 slash 的**注册**面在 Iris 里根本不存在，本文不新造（§14.5）。

**0.2 `apps/iris-web/src/sandbox/shell-csp.ts` 不存在。** 壳层 CSP 在 `packages/iris-app-service/src/shell-csp.ts:104`（`SHELL_CSP_DIRECTIVES`，三条）。位置是承重的：它属于**发 index.html 的那一侧**，不属于浏览器包。

**0.3 `parent-messages.ts` 不是帧→壳的通道。** 它是卡看到的那个 `window.parent.postMessage` 的**替身**，自己的模块头就写着「nothing reaches the shell↔frame protocol channel」。真正的门是 `apps/iris-web/src/sandbox/protocol.ts`：`ToFrame`（`protocol.ts:20`，11 个分支）与 `FromFrame`（`protocol.ts:127`，21 个分支），白名单是两个 `switch` 的 `default: return undefined`（`protocol.ts:447`、`protocol.ts:795`），凭据是 `mintToken()`（`protocol.ts:808`）铸的每次运行一个的令牌。**另外 `installSandbox`（`apps/iris-web/src/sandbox/frame.ts:404`）不创建 iframe，它跑在帧里面**；iframe 由壳侧的 `runCard`（`apps/iris-web/src/sandbox/runner.ts:367`）创建（`runner.ts:382` 建元素、`runner.ts:411` 写 `srcdoc`）。

**0.4（补充，不在假设里但同等要命）一张没有脚本的卡今天没有 frame。** `startCardScripts`（`apps/iris-web/src/sandbox/card-scripts.ts:161`）在 `card-scripts.ts:281` 一行 `if (loaded.length === 0) return` —— 没有可跑的脚本就不建帧。沙箱插件要住进这个帧，这一行必须变成「没有脚本**也没有插件**才不建帧」（§5.1）。

---

## 1. 目标与非目标

**目标**：玩家在玩一张卡的时候，把输入框切到「创造」，打一句话，一个**沙箱插件**被模型写出来、被玩家确认、被热挂进**这张卡自己的沙箱帧**；它按对话持久，下次打开这个聊天还在；再说一句话可以替换它或者删掉它。成就感来自「我说的那句话变成了这张卡的一个功能」，而不是来自「我装了一个插件」。

**非目标**：

- **不给沙箱插件宿主半边。** dsh 的动态包可以有 host half（`.reference/deepseek-harness/packages/extensions/cordis-host-runner`），那是因为它的信任前提是「会话等同 shell 访问」。这里的代码是**模型写的**，跑在**玩家的机器**上，唯一能守住的边界是那个不透明源 iframe。没有宿主半边，也就没有 `node:vm`、没有 `vmTimeoutMs`、没有 `host.call`。
- **不新增 RPC 给插件调。** 插件调不到任何卡今天调不到的东西（§7）。新增的 RPC 只有宿主自己用的三个（§10.2），插件够不着。
- **不加网络。** 帧的 `connect-src` 与 `script-src` 一个字节不动（`framePolicy`，`apps/iris-web/src/sandbox/srcdoc.ts:104`；远端白名单 `REMOTE_ALLOWLIST`，`apps/iris-web/src/sandbox/policy.ts:77`）。插件跑在既有策略里，不为它开任何一条。
- **不进 ST 兼容面。** 插件不写进 PNG，不写进 chat 的 jsonl，`chat.export`（`packages/iris-protocol/src/rpc.ts:825`）的字节与今天逐字节相同。一张没有沙箱插件的卡，行为与今天**完全一样**——这是 [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md) 那条「兼容是地板」在这件事上的具体形态，由 §16 的一个测试钉住。
- **不做插件之间的依赖、插槽链（chain）、接管（takeover）。** dsh 有四种插槽与一条 chain（`.reference/deepseek-harness/.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md`）；第一阶段只要一个 list 槽（§5.5）。
- **不做跨对话复用、不做导出、不做导入。** 一个插件属于一段对话（裁决 2）。「把这个插件搬到另一个聊天」是将来的事，本文不设计（§14.4 说明为什么现在不做）。
- **不重新开放 `ScriptContext`、不动生成钩子。** 生成期的插件介入是 [GENERATION-HOOKS](GENERATION-HOOKS.md) 的地盘，沙箱插件在帧里，够不着（§13.3）。

---

## 2. 现状：这个功能要落在什么上面

本节全部是**已有**的东西。每一行都是证据，不是提案。

### 2.1 四族帧，各自的生命周期

| 族 | 谁建 | 一个什么对应一个帧 | 生命 |
| --- | --- | --- | --- |
| **A 卡脚本帧** | `apps/iris-web/src/app/useCardScripts.tsx:301` 调 `runCard` | **一张卡一个**（该卡全部启用脚本共处一个 realm） | 「这个聊天在前台」（AUTORUN §4） |
| **B 消息界面帧** | `apps/iris-web/src/app/MessageInterfaces.tsx:316` 调 `runCard`，经 `runMessageInterfaces`（`apps/iris-web/src/sandbox/message-frames.ts:265`） | **一层楼的每一个被认领的前端块一个** | 「这条消息在显示」；随阅读窗口滑动生灭 |
| **C dev 探针** | `apps/iris-web/src/dev/SandboxProbe.tsx` | 一次点击一个 | 面板 |
| **D ST 扩展面** | `apps/iris-web/src/st-extensions/plane.tsx`，自己的 srcdoc、自己的令牌 | 一个扩展一个 | 壳的生命 |

B 族受字节预算约束：`FRAME_OVERHEAD_BYTES = 4 * 1024`（`apps/iris-web/src/app/frame-budget.ts:220`）、`FRAME_BUDGET_BYTES = 2 * 1024 * 1024`（`frame-budget.ts:230`）。

**A 族是同意门的唯一消费者**：`useCardScripts.tsx` 的模块头写明「Three rules from `docs/AUTORUN.md` are enforced here rather than downstream」，`mayRun`（`apps/iris-web/src/sandbox/consent.ts:110`）只放行显式的 yes。B 族**刻意不经过它**：`interfacesMayBuild`（`consent.ts:135`）让一张没有脚本的卡的界面在「没问过」状态下照常建帧，理由写在那个函数的注释里（不这样做，一张 30 KB HTML 开场白的卡会被卡死在一个永远不会被提出的问题后面）。

### 2.2 帧里今天能注册什么

只有一个函数：`registerPluginMembers`（`apps/iris-web/src/sandbox/members-entry.ts:90`）。它的闸门依次是：id 是非空字符串 → **准入**（id 必须在 `PLUGIN_ADMITTED_GLOBAL`（`apps/iris-web/src/sandbox/members-contract.ts:67`）公布的记录里，`members-entry.ts:94` 起；没有记录读作「什么都没准入」）→ 形状 → 撞核心表 → 撞别的插件 → **重复登记直接抛**（`members-entry.ts:118`）→ 冻结存进该插件自己的全局（`members-entry.ts:121`）。

两件对本设计致命的事实：

1. **没有撤销口。** 没有 `unregisterPluginMembers`，没有返回 disposer，重复登记是抛错不是替换。
2. **收集只跑一次。** `collectPluginMembers`（`apps/iris-web/src/sandbox/plugin-members.ts:52`）被 `frame-entry.ts:1898` 当作一次性 thunk 调用，模块头的原话是「a verdict, not a poll」。

所以今天的「热挂载」**只有一种实现方式：拆帧重建**（`runner.ts:862` 的 `dispose` 加一次新的 `runCard`）。本文 §5 造的 mini 树是**第二套注册面**，与成员表并列、不改它（§14.1 说明为什么不改）。

### 2.3 唯一的门

见 §0.3。补两条设计要用的细节：

- **帧侧不查 `event.source` 也不查 `event.origin`，令牌是唯一凭据**（`frame-entry.ts` 的 message 监听器）；壳侧两样都查（`runner.ts` 在 `parseFromFrame` 之前先比 `frame.contentWindow`）。
- **每条卡能影响的字符串在 parse 时都有长度上限**（`protocol.ts:572` 起的各分支）。新增消息必须照此办理，§5.2 的两条新消息各自带上限。

### 2.4 样式注入的三处先例

1. `<style data-iris-style="<label>">`——帧内唯一真正造 `<style>` 的地方：`apps/iris-web/src/sandbox/message-preset-styles.ts:45` 造元素、`message-preset-styles.ts:46` 打标签。**按来源打标签的既有约定就是它。**
2. 消息自带的样式表被提到 head：标记 `MESSAGE_CSS_MARK`（`apps/iris-web/src/sandbox/srcdoc.ts:407`）。
3. 卡自己写的 `<style>` 被按实例作用域重写：`repointFrameCss(css, ids, seq)`（`apps/iris-web/src/sandbox/nested-css.ts:249`）。**按 owner 作用域化 CSS 的既有先例就是它。**

另外 `parent.document.head` 是真元素（[SANDBOX](SANDBOX.md)「The virtual document」），卡往里面塞 `<style>` 今天就合法——插件的样式注入不是新权限，是给同一件事一个**可撤销的**入口。

### 2.5 数据目录、原子写、chatId 的形状

- 唯一写路径：`atomicWriteFile`（`packages/iris-app-service/src/atomic.ts:135`）；读 JSON 走 `readJsonStore`（`atomic.ts:307`），坏文件走 `quarantineCorruptFile`（`atomic.ts:206`）隔离而不是丢。**没有 `fsync`，是刻意的**——整机断电只保证「旧文件」而不是「新文件」。
- profile 下的路径全部由 `profilePaths`（`packages/iris-app-service/src/paths.ts:282`）一处派生；`cacheTrace: join(root, 'cache-trace')`（`paths.ts:305`）与 `pluginData: join(root, 'plugin-data')`（`paths.ts:330`）是两个最像的先例。
- 一个 dataDir 一个宿主进程：`HOST_LOCK_FILE`（`packages/iris-app-service/src/host-lock.ts:62`）、`acquireHostLock`（`host-lock.ts:238`）。**进程内**不保证单写者，读-改-写要自己串行（`PluginDataStore`，`packages/iris-app-service/src/plugins/storage.ts:107`，每个 id 一条 promise 链，`storageFor` 在 `plugins/storage.ts:155`）。
- **chatId 是文件名去掉 `.jsonl`**（`ChatStore.ids`，`packages/iris-app-service/src/chats.ts:274`），铸自 `toId(名字)-时间戳` 再过 `uniqueId`（`packages/iris-app-service/src/paths.ts:86`）；安全性由 `isSafeId`（`paths.ts:47`）与 `fileFor`（`paths.ts:114`，resolve 之后再查包含性）保证。**它可以被回收**：删掉一个聊天，同名的下一个聊天可能拿到同一个 id——`chat.delete`（`packages/iris-app-service/src/service.ts:2183`）为此显式调 `settings.forget(chatId)`（`service.ts:2186`，实现在 `packages/iris-app-service/src/settings.ts:633`）。

最像的 sidecar 先例是 `cache-trace/<chatId>/`（`CacheTraceStore`，`packages/iris-app-service/src/cache-trace.ts:558`；`#chatDir` 在 `cache-trace.ts:586` 用同一个 `fileFor` 过白名单；`write` 在 `cache-trace.ts:639` 建目录、原子写、轮转，**从不抛**）。它同时是**反面教材**：没有任何地方在 `chat.delete` 时清理它。

聊天生命周期的既有行为（本文 §10.3 按它设计）：

| 事件 | chatId | 文件 | 文件外的东西 |
| --- | --- | --- | --- |
| `create`（`chats.ts:562`） | 新铸 | 新 `.jsonl` | —— |
| `rename`（`service.ts:2231`） | **不变** | 路径不变，只改 header 的 title（`ChatEntry.touch`，`packages/iris-app-service/src/entry.ts:866`；`IrisChatMeta` 在 `entry.ts:77`） | —— |
| `branch`（`chats.ts:622`） | **新的子 id**（`chats.ts:656`），`parentChatId` 指回父（`chats.ts:672`） | 新子文件 + 父文件被改写 | **什么都不复制** |
| `delete`（`chats.ts:938`） | 消失，**id 可回收** | `unlink` | settings、chat order 被 forget；**cache-trace 不被 forget** |
| `export`（`chats.ts:819`） | —— | 只产文本，磁盘不落 | sidecar 不随行 |
| `import`（`chats.ts:747`） | **重铸**，`parentChatId` 被刻意丢弃 | 新文件 | sidecar 不随行 |

### 2.6 供应商与模型控件

- 一个 profile 一份 `connections.json`；记录形状是 `StoredProfile`（`packages/iris-app-service/src/connections.ts:56`），线上形状是 `ConnectionProfile`（`packages/iris-protocol/src/views.ts:1820`，key 永不过线）；`ConnectionStore` 在 `connections.ts:432`，`save` 在 `connections.ts:720`，路由名由 `routeOf` 算（`connections.ts:894`）。
- **今天全系统只有一个「在用的供应商」**：`GenerationSettings`（`packages/iris-protocol/src/views.ts:2046`）的 `provider`/`model` 是一次生成的唯一路由来源，`#resolveRoute`（`packages/iris-app-service/src/service.ts:1497`）四级兜底，`requireProvider` 在没有 active 时直接拒（`service.ts:1502`）。`connection.activate` 的参数里已经有一个可选的 `chatId`（`packages/iris-protocol/src/rpc.ts:709` 的 schema，`chatId` 在 `rpc.ts:711`）——「把这个档应用到一个对话」这件事已经有存储位（`SettingsFile.chats`，`packages/iris-app-service/src/settings.ts:122` 的接口、`settings.ts:125` 的字段）。
- **宿主自己唯一的非回合生成——压缩摘要——复用聊天自己的设置**：`#summarize`（`service.ts:6425`）在 `service.ts:6430` 读 `settings.get(entry.chatId)`。所以「为某件事单配一个供应商」这个概念**今天不存在**，裁决 1 要造的就是它。
- 非回合生成今天**只在记账上**被区分：`SIDE_SOURCES = ['script', 'compaction']`（`packages/iris-app-service/src/side-usage.ts:102`），落在 chat header 的 `iris_side_usage`（`side-usage.ts:92`）。
- 模型控件「总能手打一个名字」是 owner 2026-09-10 的裁决，已落地为 `modelTyping`（`apps/iris-web/src/app/ConnectionPanel.tsx:171`，注释里引着原话）。
- `tool_calls` 的流式解析已经有了：`translate`（`packages/iris-llm-openai-compat/src/translate.ts:139`），`tool_calls` 分支在 `translate.ts:203`。

### 2.7 诊断面

`debug.reports`（schema `packages/iris-protocol/src/rpc.ts:1216`，结果 `rpc.ts:2868`）；行形状 `DebugReport`（`packages/iris-protocol/src/views.ts:2459`，等级 `ReportGrade` 在 `views.ts:2457`，只有 `fault`/`note`；**没有 `field` 字段**，归因靠 `chatId`/`characterId`/`scriptId` 三个可选 id）。宿主侧 `DebugReport` 在 `packages/iris-app-service/src/diagnostics.ts:106`，上下文 `ReportContext` 在 `diagnostics.ts:134`，缓冲 `DiagnosticBuffer` 在 `diagnostics.ts:218`（`record` 在 `diagnostics.ts:244`，上限 `DEFAULT_LIMITS` 在 `diagnostics.ts:191`），写入口是 `#report`（`packages/iris-app-service/src/service.ts:7396`）。`ReportKind` 是**闭合联合**（`diagnostics.ts:23`，八个），并且必须在 `KIND_WIRED`（`diagnostics.ts:59`）里各占一行才会进 `WIRED_KINDS`（`diagnostics.ts:87`）——**漏一行等于声明「没人在看」**；未知拼写的落点是 `isReportKind`（`diagnostics.ts:101`）。卡侧的入口是 `script.report`（`rpc.ts:1516`）。

---

## 3. 域模型

### 3.1 沙箱插件 vs 系统插件：逐行对照

两个名字必须一眼分得开，所以先把差别写平。

| | **系统插件**（既有） | **沙箱插件**（本文） |
| --- | --- | --- |
| 代码从哪来 | 本仓库源码、ST 扩展树、或钉死 commit 的 git 远端 | **模型现写的**，来自一次「创造」请求 |
| 信任 | **同权 Node 代码**，没有沙箱（[SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)「Trust model」） | **不可信**，与卡脚本同级 |
| 跑在哪 | 宿主进程，Cordis 子 fiber | **卡自己的 srcdoc 帧**，不透明源，帧内一棵 mini 树 |
| 边界是什么 | 「代码从哪来」+ 安装同意 + 树哈希 | **iframe 本身**；门面是边界之内的第二道 |
| 持久化 | profile 级（`system-plugins.json` + 安装树） | **按对话**（chatId），Iris 自己的 sidecar |
| 生命周期 | list / install / enable / disable / reload / uninstall（六个） | define / confirm / mount / replace / disable / remove（六个，名字刻意不同） |
| 安装同意 | 一张同意页，一次决定，装完就在（[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §5.3） | **每个新版本一张确认卡**；单勾只授权这一版，双勾授权这个 id 的将来版本（§4.1） |
| 失败态 | 七个（`SystemPluginFailureState`，`packages/iris-protocol/src/system-plugins.ts:35`） | 七个，**另一套名字**（§6），因为阶段不同 |
| 谁能装 | 用户，在插件中心 | 用户，在对话里，对着**这一个聊天** |
| 卸载留下什么 | 聊天、变量、`plugin-data/<id>/`（用户数据） | **什么都不留**：记录、样式、面板、注册全消失（§5.7） |

一句话：**系统插件回答「这台 Iris 会做什么」，沙箱插件回答「这段对话长成了什么样」。** 两者共用的只有词汇（具名失败态、确认先于执行、停用不等于删除），不共用任何注册表、任何目录、任何 RPC。

### 3.2 记录形状与 id（裁决 Q1、Q2、Q3）

```ts
/** 一个沙箱插件的一个版本。记录活在 sidecar 里，不在 PNG、不在 jsonl。 */
export interface SandboxPluginVersion {
  /** 单调递增，从 1 起。同一个 pluginId 下唯一。 */
  readonly version: number
  /** 模型给的一句话名字，显示用。≤ 64 字符。 */
  readonly name: string
  /** 模型自己写的「它是干什么的」。确认卡的主句。≤ 280 字符。 */
  readonly purpose: string
  /** 模型**声明**它会注册什么。确认卡逐条显示；宿主不据此放行（§7）。 */
  readonly declares: readonly SandboxPluginDeclaration[]
  /** 函数体源码，纯 JavaScript，不带 import / export / JSX。 */
  readonly code: string
  /** `code` 的 UTF-8 字节数与 sha256 前 12 位十六进制。确认卡显示体量，授权按哈希记。 */
  readonly bytes: number
  readonly hash: string
  /** 产生它的那句话，原样。玩家问「我当时说了什么」时唯一的答案。 */
  readonly prompt: string
  /** 写出它的那次请求用了哪个连接档与哪个模型，以及花了多少 token（§11.3）。 */
  readonly authored: { readonly connectionId: string, readonly model: string, readonly at: number }
}

export type SandboxPluginDeclaration =
  | { readonly kind: 'style' }
  | { readonly kind: 'panel' }
  | { readonly kind: 'members', readonly names: readonly string[] }

/** 一个沙箱插件在一段对话里的全部状态。 */
export interface SandboxPluginRecord {
  /** `<对话内序号>-<模型给的 idPrefix 的 slug>`，宿主铸造，见下。 */
  readonly id: string
  /** 版本表，只追加。当前版本是最后一条。 */
  readonly versions: readonly SandboxPluginVersion[]
  /** 玩家有没有把它关掉。关掉 ≠ 删掉。 */
  readonly enabled: boolean
  /** 双勾授权过的话，这里记「这个 id 的将来版本都不用再问」。 */
  readonly trustFutureVersions: boolean
  /** 逐版本的授权记录：被单勾放行过的 hash。 */
  readonly authorizedHashes: readonly string[]
  /** 最近一次失败（§6），成功挂载即清。 */
  readonly failure?: SandboxPluginFailure
}
```

**裁决 Q1**：

- **id 由宿主铸造，模型只能给 `idPrefix`。** 抄 dsh（`.reference/deepseek-harness/docs/tool-catalog.md` 的 `plugin: { kind: 'new', idPrefix }`），理由在这里更硬：让不可信的一方选命名空间，等于让它选择撞谁。铸法是 `uniqueId(`${toId(idPrefix)}`, 已占用)`——**复用 `packages/iris-app-service/src/paths.ts:86` 那一个**，不写第二份，因为 id 要当目录名用（§10.1），它必须过 `isSafeId`（`paths.ts:47`）。
- **版本是整数，只追加，永不改写。** 「替换」是追加一个新版本并把它设为当前（§4.3），不是就地改。理由：确认卡按版本授权（裁决 3），一个可以就地改的版本号会让「玩家勾过的那一版」失去意义。
- **`purpose` 和 `declares` 是一等字段，不是注释。** 确认卡要显示的东西必须在记录形状里有位置，否则它就会变成从代码里 grep 出来的猜测。
- **`hash` 是授权的单位，`version` 是显示的单位。** 两者分开：模型两次写出一模一样的代码，玩家不该被问两次。

**裁决 Q2（版本与体积上限）**：

| 量 | 上限 | 理由 |
| --- | ---: | --- |
| 单个版本的 `code` | **64 KiB** | 帧的字节预算是 2 MiB（`frame-budget.ts:230`），一个插件吃掉 1/32 已经很多；同时这是一个模型一次能写好的量级 |
| 一个插件保留的版本数 | **8** | 与 `DEFAULT_CACHE_TRACE_KEEP` 同量级，够回看「上一版是什么样」，不够变成一份历史档案 |
| 一段对话的插件数 | **16** | 见 Q13 |
| 一段对话全部插件的代码字节 | **256 KiB** | 见 Q13 |
| `name` / `purpose` / `prompt` | 64 / 280 / 2000 字符 | 三个都要进确认卡与列表面板，都是模型写的，都要截 |

超限是**具名拒绝**，在写进 sidecar 之前（`too-large`，§6），不是截断——截断一段代码得到的是一段语法错的代码，而错误会指向语法而不是指向体积。

**裁决 Q3（模型输出怎么变成记录）**：

**两条路，都要，优先级固定。**

1. **供应商支持工具时走 `tool_calls`。** `translate`（`packages/iris-llm-openai-compat/src/translate.ts:139`）已经把流式 `tool_calls` 解析成块（`translate.ts:203`），参数是累积的 JSON 字符串。请求里带一个工具 `iris_define_sandbox_plugin`，参数就是 §3.2 那四个字段（`idPrefix`/`name`/`purpose`/`declares`/`code`）。这条路的好处不是优雅，是**边界清楚**：代码是一个 JSON 字符串字段，不需要从散文里切。
2. **不支持工具时走围栏块。** 约定：一个 ` ```json ` 块（元数据）加一个 ` ```js ` 块（代码），块外的散文全部丢弃。解析器是**独立可测的纯函数**，输入一段完成文本，输出 `SandboxPluginVersion` 的候选或一个具名理由。

**两条路共用同一个校验器和同一个失败状态 `unparseable`**（§6）。差别只在「怎么切出字段」，不在「切出来之后信什么」——两边都要过同一套长度、形状、语法预检。

**为什么不只做围栏块**：模型把代码写进散文里，随手加一句「注意：你需要先……」，围栏解析器要么把它当代码要么丢掉，两种都错。**为什么不只做工具**：Iris 的连接面是「任意 OpenAI 兼容端点」（[USER-GUIDE](USER-GUIDE.md)「连接模型」），不支持工具的端点是常态，只做工具等于给一半用户一条走不通的路。

---

## 4. 时序

### 4.1 写一个插件（含裁决 Q16：确认卡与单/双勾）

方括号是**新造**的步骤，无括号的是既有的。

```
 1  玩家把输入框切到「创造」（§12 的开关），打一句话，按发送
 2  [壳：chat.definePlugin({ chatId, characterId, sentence })]
 3  [宿主：取「写插件用」的连接档（§11），不是这个聊天的 provider/model]
 4  [宿主：组装请求 = 技能文档（§11.2）+ 这段对话现有插件的 name/purpose 清单
 5              + 这张卡的界面结构摘要 + 玩家这句话]
 6  [宿主：#stream(..., side: 'plugin')，记账进 iris_side_usage（§11.3）]
 7  [宿主：解析（Q3）→ 校验（长度、形状）→ 语法预检（§6.1）]
 8  [宿主：铸 id（新插件）或沿用 id（替换）；算 hash；**写进 sidecar，状态 pending-confirm**]
 9  [宿主：广播 sandboxPlugin.pending]
10  [壳：确认卡（§4.1 的内容），渲染在壳层，非模态，无计时器]
       ├ 单勾 → [chat.authorizePlugin({ chatId, pluginId, hash, scope: 'version' })]
       ├ 双勾 → [chat.authorizePlugin({ ..., scope: 'plugin' })]
       └ 拒绝 → [chat.discardPlugin]：记录整条删掉，sidecar 回到之前的样子
11  [宿主：sidecar 落盘（atomicWriteFile），广播 sandboxPlugin.changed]
12  [壳：把这个插件推给这个聊天的卡脚本帧（§5.2 的 plugin:mount 消息）]
13  [帧：mini 树 load → create → await（§5.3）]
14  [帧：plugin:mounted 或 plugin:failed 回壳]
15  [壳/宿主：失败进 debug.reports 与行上的 failure（§6、§8）]
```

**第 8 步在第 10 步之前落盘，是刻意的。** 一个「模型写完了、还没问玩家」的记录如果只活在内存里，刷新页面就没了，而玩家看到的是一次无声的失败。落盘的状态是 `pending-confirm`，**未授权的版本永远不挂载**——落盘与执行是两件事，这一点与系统插件的安装路径同构（preview 落 staging、confirm 才 promote，[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md) §5.3）。

**确认卡的内容（裁决 Q16）**，逐行照 §3.2 的字段：

```
这段对话要长出一个新功能

  名字    <name>
  它做什么 <purpose>
  它说它会注册：
      · 样式（会改这张卡的外观）
      · 一个小面板
      · 成员：<names>
  代码    <bytes> 字节（版本 <version>）
  这句话  「<prompt>」        ← 玩家自己说的那句，原样

  这段代码是**模型写的**，和这张卡的脚本跑在同一个隔离沙箱里，
  碰不到你的页面、碰不到别的对话。

  [ ✓ 这一版 ]  [ ✓✓ 以后这个插件也不用问 ]  [ 不要 ]
```

五条硬规则，全部抄 `ConsentAsk`（`apps/iris-web/src/app/ConsentAsk.tsx:37`）与 [AUTORUN](AUTORUN.md) §1：

1. **壳层渲染，永远不在帧里。** 一个在不可信帧里画出来的确认卡，画它的那段代码就是要被确认的那段代码。
2. **非模态、无计时器。** 通知会过期，问题不会。
3. **卡不能触发、不能加速、不能预填。** 没有任何 API 让帧里的代码召唤这张卡。
4. **措辞按后果，不按 API。** 说「会改这张卡的外观」，不说「注入 CSS」。
5. **`declares` 是模型的自述，不是宿主的保证。** 卡上必须有一句话说清这一点——写着「它说它会注册」，不是「它会注册」。宿主不按 `declares` 放行任何东西（§7），显示它是为了让玩家能对上「它说的」和「它做的」。

**单勾 / 双勾（裁决 Q16 续）**：

- **单勾**：把这一版的 `hash` 加进 `authorizedHashes`。只有这一版能挂。下一版再问。
- **双勾**：`trustFutureVersions = true`。这个 `pluginId` 的将来版本**直接挂，不再问**。
- **授权记录存在 sidecar 的插件行上**（`authorizedHashes` / `trustFutureVersions`，§3.2），**不在 settings、不在 localStorage**。理由与 [SANDBOX](SANDBOX.md)「Escalation」里那条一样：权限跟着它授权的那个对象死，而这个对象是「这段对话里的这个插件」；删掉插件、删掉对话，授权跟着消失，id 回收不继承（§10.3）。
- **双勾不是永久信任一段代码，是永久信任一个位置。** 值得在卡上说一句：「以后这个插件改了也直接生效」。这是 dsh 的语义（`.reference/deepseek-harness/packages/extensions/tool-cordis/src/prompt.ts`），抄的时候要连它的代价一起抄。

### 4.2 重开聊天（裁决 Q17）

```
 1  玩家打开这个聊天
 2  script.list：拿到 scriptsAllowed / documentGranted（既有）
 3  consentState → mayRun（consent.ts:110）（既有）
 4  [宿主：读 sidecar，给出这段对话 enabled 且已授权的插件]
 5  useCardScripts 建卡脚本帧 —— 条件从「有可跑脚本」改成
       「有可跑脚本 **或** 有要挂的插件」（§5.1，对着 card-scripts.ts:281）
 6  frame ready → context → run（既有）
 7  [壳：每个插件一条 plugin:mount]
 8  [帧：按 id 字典序挨个挂（§9）]
```

**裁决 Q17：挂载骑既有的 AUTORUN 同意门，不自带第二道门。** 协调人裁决（2026-09-19），采纳设计稿的推荐值；`scriptsAllowed === false` 时插件也不挂、且面板要说出来，一并成为裁决的一部分。

理由：

- 同意门问的问题是「在隔离沙箱中运行这张卡带的代码吗」。一个模型为这张卡写的插件，**在玩家自己要求下**，落在同一个沙箱、同一张卡、同一段对话里——它不是一个新的信任域，它是玩家刚刚亲手同意过的那一个。
- 第二道门会在最没人看的时刻重复提问。AUTORUN §1 那句「三态，不是布尔」的全部代价就是为了**不要重复问**；每次开聊天再问一遍插件，等于把那个教训丢掉。
- **真正的门已经在前面了**：确认卡（§4.1）。一个插件的第一版永远被问过一次，没被问过的插件根本进不了 sidecar 的已授权状态。开聊天时挂的，全是玩家点过头的东西。

不裁决的后果：按本稿实现（骑 AUTORUN 门）。协调人若要第二道门，代价是每次开聊天多一个问题、且这个问题的唯一可行答案是 yes——[AUTORUN](AUTORUN.md) 已经写过这种问题「训练人对下一个问题也说 yes」。

**一个必须点名的边界情况**：`scriptsAllowed === false`（问过且拒绝）时，**插件也不挂**。理由：拒绝的语义是「不要在这张卡上跑代码」，而插件是代码。UI 上要说出来——脚本面板的那一行要写「N 个插件也不会运行」，否则玩家会以为插件没了。

### 4.3 替换、停用、删除

- **替换**（玩家又说一句「把它改成……」）：走 §4.1 全程，第 8 步沿用同一个 `pluginId`、版本 +1。挂载之前**先拆旧版**（§5.7），不是并存。`trustFutureVersions` 为真就跳过第 10 步。
- **停用**：`enabled = false`，拆掉但**不删记录**。抄 dsh 的 `disabled: true`（`.reference/deepseek-harness/docs/cordis-tutorial/06-composition-and-hmr.md`）与系统插件的 disable 语义。重新启用不再问（授权还在）。
- **删除**：记录整条从 sidecar 移除，授权随之消失；重新写一个同名的要重新确认。
- 三者都以**拆干净**为前提（§5.7）。拆不干净的落点在 §6.6。

---

## 5. 帧里的 mini 树，与三件能力

### 5.1 树住在哪个帧（裁决 Q4）

**住在 A 族——卡脚本帧。一段对话一棵树。**

| 候选 | 判定 |
| --- | --- |
| **A 卡脚本帧** | **选它。** 一张卡一个、生命等于「这个聊天在前台」（§2.1）、已经在同意门后面、已经有一个可见的容器（覆盖层，`overlayViewport`，`apps/iris-web/src/app/overlay-surface.ts:45`） |
| B 消息界面帧 | 否。一层楼一个、随阅读窗口生灭、受 2 MiB 字节预算（`frame-budget.ts:230`）、**不经同意门**（`interfacesMayBuild`，`consent.ts:135`）。插件挂在这里会随滚动反复生死，且「一个显示回合数的小面板」会在每层楼各出现一次 |
| 专门开一个插件帧 | 否。第五族帧要自己的 srcdoc、自己的令牌、自己的生命周期、自己的预算，换来的只是「插件和卡脚本不共享 realm」——而共享 realm 正是我们要的：插件要能用卡脚本发布的东西（[SANDBOX](SANDBOX.md)「`parent` as a card's own shared namespace」） |

**因此 `card-scripts.ts:281` 那一行必须改**（§0.4）：条件变成「没有可跑脚本**且**没有要挂的插件」才 `return`。`runCard` 本来就支持空脚本数组（`MessageInterfaces.tsx:316` 就是这么用的），所以这不是新能力，是把一个已有形状用在第二处。

**样式要越过帧边界怎么办**：验收场景之一是「把状态栏改成深色」，而状态栏通常是 B 族帧里的卡片界面。**插件代码只在 A 族里跑一次**，它调 `styles.insert(css)` 时做两件事：

1. 往**本帧**的 head 塞一个打了标签的 `<style>`（§5.4）；
2. 把这段 CSS 经 `plugin:style` 消息（§5.2）交给壳，壳按 `(chatId, pluginId)` 存住，并把它折进这个聊天**每一个 B 族帧**的 srcdoc——走的是 `withMessageCss` 已经在走的那条路（标记 `MESSAGE_CSS_MARK`，`srcdoc.ts:407`），B 族帧按既有机制重建。

这样：**代码只有一个 realm，样式覆盖全族，移除即重建。** 代价要写明——

- 一个帧因此可以把一段 CSS 推给**同一张卡、同一段对话**的别的帧。这些帧本来就跑同一张卡的代码，所以没有跨越任何信任边界；但壳必须把它当**字符串**处理：走 `escapeClose` 同款的 `</script`/`</style` 切分，长度上限 32 KiB，**绝不当作 markup**。
- 它不能到达壳自己的页面。这一条要有一个牙齿（§16.3）。
- B 族帧重建有可见代价（闪一下）。这是 PR-C 的事，PR-A/B 只做 A 族自己那半。

### 5.2 源怎么进帧（裁决 Q5）

**postMessage，因为 srcdoc 没有地址可取。** dsh 的浏览器动态包是同源 bundle 下发（`dsh-client-modules`），这里不行：帧是 `about:srcdoc`，`sandbox="allow-scripts"`（`frameSandbox`，`apps/iris-web/src/sandbox/policy.ts:36`），不透明源。

协议新增三条 `ToFrame` 与三条 `FromFrame`，各自在 `protocol.ts:20` / `protocol.ts:127` 的联合里加一个分支，并在 `parseToFrame`（`protocol.ts:342`）/ `parseFromFrame`（`protocol.ts:572`）的 `switch` 里加一个 `case`——**两处都加才算存在**，`default: return undefined`（`protocol.ts:447`、`protocol.ts:795`）就是白名单本身。

| 方向 | 类型 | 载荷 | 上限 |
| --- | --- | --- | --- |
| 壳→帧 | `plugin:mount` | `{ pluginId, version, code }` | `pluginId` 120、`code` 64 KiB（Q2） |
| 壳→帧 | `plugin:unmount` | `{ pluginId }` | `pluginId` 120 |
| 壳→帧 | `plugin:panel` | `{ visible: boolean }` | —— |
| 帧→壳 | `plugin:mounted` | `{ pluginId, version, ms }` | —— |
| 帧→壳 | `plugin:failed` | `{ pluginId, version, state, detail }` | `detail` 2000（与 `error` 同） |
| 帧→壳 | `plugin:style` | `{ pluginId, css }` | `css` 32 KiB |

**`code` 走消息而不是走 srcdoc**，理由有三条，第三条是决定性的：①插件在帧建好之后才可能被写出来；②替换一个插件不该重建整个帧（卡脚本的状态会丢）；③**srcdoc 是壳拼出来的一整页 HTML**（`buildSrcdoc`，`apps/iris-web/src/sandbox/srcdoc.ts:475`），把模型写的代码拼进那个字符串，等于让模型的输出参与拼 HTML——那是一条今天不存在的注入面，而消息通道的载荷永远只是一个 JavaScript 字符串。

### 5.3 求值器与门面（裁决 Q6，含 Q9 的卡片成员面）

帧里造一个 `SandboxPluginTree`，与既有的成员表、卡脚本并列。挂载配方抄 dsh 的 `runtime.ts`（§见研究记录 §六），但**去掉 loader/模块表那一层**——Iris 的帧里没有 Cordis loader，为一个插件引进一个装载机不值得：

```
mount(pluginId, version, code):
  0  同一个 pluginId 的操作在一条串行队列上（抄 dsh 的 pluginRunId 收敛）
  1  旧版在场 → 先走 teardown（§5.7），拆干净才继续
  2  factory = new Function('iris', `"use strict";\n${code}\n`)
       —— 一个参数，就是门面。不是 DYNAMIC_CLIENT_REDIRECTS 那种
          「把一批全局做成参数」的教学陷阱：这里的遮蔽拦不住任何东西
          （SANDBOX.md 早就写下了同一句话），真正的墙是 iframe。
  3  plugin = factory(facadeFor(pluginId))     ← 同步，抛错即 apply-failed
  4  Promise.race([plugin.apply?.(), deadline(3_000)])   ← 超时即 apply-timeout
  5  记 mounted，post plugin:mounted
```

`new Function` 而不是 `blob: import()`：卡脚本走的是 blob 模块（`frame-entry.ts:2250` 建 URL、`frame-entry.ts:2329` 动态 import），因为上游把每个卡脚本当 `<script type="module">`；插件没有这个兼容义务，而 `new Function` 是**同步**的——它让第 3 步的失败与第 4 步的失败可以分成两个状态（§6）。CSP 上两条都通：帧的 `script-src` 已经带着 `'unsafe-inline' 'unsafe-eval' blob:`（`framePolicy`，`srcdoc.ts:104`），壳一条 script 指令都不加（`SHELL_CSP_DIRECTIVES`，`packages/iris-app-service/src/shell-csp.ts:104`），所以**挂载不需要动任何 CSP**。

门面（`facadeFor(pluginId)`）就是三件能力，别的什么都没有：

```ts
interface SandboxPluginFacade {
  /** 这个插件自己的 id，只读。 */
  readonly id: string
  /** (a) 样式注入。返回撤销函数；卸载时全部自动撤销。 */
  styles: {
    insert(css: string): () => void
    clear(): void
  }
  /** (b) 帧内面板槽。一个插件一个格子。 */
  panel: {
    mount(node: unknown): () => void
    clear(): void
  }
  /** (c) 卡脚本今天拿到的那个成员面，原样。 */
  readonly card: Readonly<Record<string, unknown>>
}
```

**`card` 是既有的，不是新的。** 它就是 `MEMBER_KINDS`（`apps/iris-web/src/sandbox/identity.ts:69`）那 124 个成员的一份**按插件绑定**的副本：`identity` 类的成员绑到这个 `pluginId`（就像它们对每个 script 各绑一份一样，[SANDBOX](SANDBOX.md)「The frame carries the card's own script list」），`shared` 类的原样共享。这样一个插件注册的事件监听、写的 `script` 域变量、发布的脚本按钮，都记在它自己名下——**这是 §5.7 能拆干净的前提**，不是可选的整洁。

门面**没有**的东西，逐条写明：`fetch`、`window`、`document`、`parent`、`import`。插件当然可以用 `Function('return this')()` 绕过参数拿到真全局——遮蔽不是墙——拿到的是**帧的**全局，也就是卡脚本已经有的那一套，被 iframe 关着。这正是 [SANDBOX](SANDBOX.md) 说的「沙箱 fails closed」。**本文不假装门面是边界**（§7）。

### 5.4 样式注入（裁决 Q7）

```
styles.insert(css) →
   <style data-iris-plugin-style="<pluginId>" data-seq="<n>">…</style>
   append 到 document.head
   记进这个插件的 owned 表，返回一个 remove 函数
```

`data-iris-plugin-style` 是照 `data-iris-style`（`apps/iris-web/src/sandbox/message-preset-styles.ts:46`）造的第二个标签名，不共用一个：那个标签的语义是「message-preset 注的」，混进来会让按标签清理的代码误删。**卸载 = 按 `[data-iris-plugin-style="<id>"]` 全删**，这就是 dsh `styles.dispose()` 的等价物。

**不作用域化，故意的。** `repointFrameCss`（`apps/iris-web/src/sandbox/nested-css.ts:249`）会把卡自己的 CSS 按实例作用域重写，那是因为卡在一个帧里造了多个假 frame、彼此不该互相染色。插件的情形相反：玩家要的就是「把状态栏改成深色」，作用域化会让这句话做不到。代价写明：**两个插件都改同一个选择器，后挂的赢**（CSS 的既有规则，不是我们发明的），挂载顺序见 §9；这一条要写进作者文档（§11.2）。

### 5.5 面板槽（裁决 Q8）

**「面板槽」在帧的 DOM 里是一个具体元素，不是一个抽象概念：**

```html
<div data-iris-plugin-panels>          ← 帧 bootstrap 造的，一帧一个
  <div data-iris-plugin-panel="<pluginId>">…</div>   ← 一个插件一格
  <div data-iris-plugin-panel="<pluginId>">…</div>
</div>
```

- 容器在**卡自己的容器之外、之下**，位置由壳的样式决定，插件改不了容器本身（它只拿到自己那一格）。
- `panel.mount(node)` 接受一个元素或一段 HTML 字符串；字符串走与卡片界面同一条清洗（`rewriteStylesheetLinks`、`unblockFontStylesheets`，`srcdoc.ts` 的两个导出），**不是**一条新的 markup 通路。
- **一个插件一格，list 语义，不是 chain。** dsh 有 single/keyed/list/chain 四种，chain 是「条目自荐、第一个匹配的渲染」（研究记录 §九）——接管语义在第一阶段没有用例，而它带来的第一个问题是「谁允许接管谁」，dsh 自己承认它的插槽准入**没有载体**。这里不引进这个问题。
- 帧高度：面板改变内容会触发既有的 `ResizeObserver` → `height` 消息回路，不需要新东西。
- 一个插件的格子在它卸载时**整个移除**；容器留着（它属于帧，不属于任何插件）。

### 5.6 谁在这棵树上，可见吗

mini 树在帧里的全局名是 `__iris_sandbox_plugins__`，形状与 `MEMBERS_GLOBAL`（`apps/iris-web/src/sandbox/members-contract.ts:22`）一族对齐（`pluginMembersGlobal` 在 `members-contract.ts:49`、`pluginReadyMarker` 在 `members-contract.ts:54`）。它是**帧的**东西，卡脚本能看见它——和卡脚本能看见 `<div id="tavern_helper">` 是同一类可见性（[SANDBOX](SANDBOX.md)「The frame carries the card's own script list」）。这不是新暴露：同一个 realm 里的东西本来就互相可见。

### 5.7 卸载要拆掉什么（裁决 Q10）

拆卸是**一张清单**，不是一次调用。按逆序：

| # | 拆什么 | 怎么拆 |
| --- | --- | --- |
| 1 | 插件自己的 `dispose()` | `Promise.race([plugin.dispose?.(), deadline(1_000)])`，抛错/超时记 `dispose-failed` 但**继续往下拆** |
| 2 | 面板 | `[data-iris-plugin-panel="<id>"]` 整格移除 |
| 3 | 样式（本帧） | `[data-iris-plugin-style="<id>"]` 全删 |
| 4 | 样式（B 族帧） | 壳丢掉 `(chatId, pluginId)` 的那份 CSS，相关 B 族帧重建 |
| 5 | 成员面留下的东西 | 事件监听（`eventClearAll` 的按 owner 版本）、脚本按钮（`replaceScriptButtons` 置空）、注入的提示词（`uninjectPrompts`）——**逐项，按 `pluginId` 绑定的那份** |
| 6 | 树上的行 | 从 `__iris_sandbox_plugins__` 移除；同 id 可以再挂 |

**第 5 项是整个设计里最容易漏的一格，也是 §5.3 坚持「`card` 成员按插件绑定」的唯一理由。** 一个共享的成员面拆不掉它注册过的东西，因为没人知道哪一条是谁注册的——这正是 `registerPluginMembers` 今天没有撤销口的同一个病（§2.2）。

**拆不干净时**：记 `dispose-failed`（§6.6），**不假装拆成功了**。玩家在列表面板（§12）看到这一行，唯一诚实的修法是重建帧（切走再切回这个聊天），而面板要把这句话写出来。

---

## 6. 失败语义（裁决 Q18）

七个具名状态，一个都不静默，每一个都对着一条 `debug.reports` 行（§8）。名字**刻意不与系统插件的七个重合**（`SystemPluginFailureState`，`packages/iris-protocol/src/system-plugins.ts:35`）——阶段完全不同，共用名字会让两张表上的同一个词指两件事。

```ts
export type SandboxPluginFailureState =
  | 'unparseable'      // 模型的输出切不出记录（Q3 的两条路都失败）
  | 'too-large'        // 超 Q2 的任一上限
  | 'syntax-failed'    // 定义期语法预检不过
  | 'mount-failed'     // factory 求值或 apply 抛错
  | 'mount-timeout'    // apply 超过 3 s
  | 'dispose-failed'   // 拆卸时 dispose 抛错/超时，或某一格没拆掉
  | 'orphaned'         // sidecar 有行，帧里挂不上（帧没起来 / 未授权 / 聊天不匹配）
```

### 6.1 `syntax-failed`：预检必须用挂载用的那个包装器

抄 dsh（`.reference/deepseek-harness/packages/extensions/cordis-host-runner/src/sandbox.ts`）的一条，理由在那份研究记录里写过：**预检与执行用两套包装，预检过了执行仍可能语法错，那这道检查只是让人安心**。这里的难处是两边不在一个 realm：预检在宿主（Node），挂载在帧（浏览器）。落法：把包装器的字符串模板做成**一个共享常量**（`@iris/protocol` 或一个新的小契约包），宿主用 `new Function` 试编译同一段拼好的源，帧用同一段拼法求值。共享的是拼法，不是求值器。

失败时**不写 sidecar、不弹确认卡**，直接把理由回给玩家（「模型写的代码有语法错误：第 12 行……」）并记一条 `fault` 报告。这是**唯一一个玩家会想「再试一次」的状态**，所以句子里要带一个重试入口。

### 6.2 `unparseable` / `too-large`

同上：拒在写 sidecar 之前。`unparseable` 的报告里要带**模型实际回了什么的前 500 字**——否则下一个人面对的是一句「解析失败」和零证据。`too-large` 的报告里要带实测字节与上限两个数。

### 6.3 `mount-failed` / `mount-timeout`

两个分开，因为修法不同：前者是代码错，后者是代码慢（或者在等一个永不到来的东西——`waiting` 那一相的教训，`ScriptRunPhase`，`apps/iris-web/src/sandbox/script-run-state.ts:33`）。

**两者都不撕掉对话，也不撕掉别的插件。** 一个插件挂不上，队列里剩下的照挂（§9）；卡脚本完全不受影响。这是 [AUTORUN](AUTORUN.md) §3.3「失败的卡不能把对话带走」的同一条，落在插件上。

超时 3 s 而不是 5 s（生成钩子的预算，[GENERATION-HOOKS](GENERATION-HOOKS.md) §5.2）：钩子在结算路径上，慢一点只是回合尾延迟；插件的 `apply` 在**开聊天**的路径上，一个聊天有 16 个插件就是最坏 48 s 的挂载期。3 s × 16 = 48 s 仍然太长，所以再加一条：**整批挂载的总预算 10 s**，超了的插件记 `mount-timeout` 并跳过，后续的不再启动。两个数都写在一处常量里，注释互相指向。

已经在跑的 Promise 杀不掉，所以 `mount-timeout` 之后：宿主不再等；晚到的 resolve 丢弃（该插件本轮没有消费者）；晚到的 reject **必须接住**（挂 `.catch` 记一条报告），否则是一条与业务无关的 unhandledRejection。这三句抄 [GENERATION-HOOKS](GENERATION-HOOKS.md) §5.2，一字不改。

### 6.4 `orphaned`

sidecar 里有行、帧里没有对应的挂载。四种成因，报告要分得开：①帧根本没起来（`bootstrap-failed` 一族）；②同意门是 `declined`（§4.2 的边界情况）；③授权记录不匹配（单勾授权的是别的 hash）；④聊天切走了。**只有 ①③ 是异常**，②④ 是正常状态，所以 `orphaned` 只在 ①③ 时记 `fault`，②④ 在列表面板上是一句说明而不是一条报告。

### 6.5 帧重载

帧被拆重建（切聊天、卡换了、revision 变了）时，mini 树随帧消失。**重建后按 §4.2 重挂**，这是既有的形状，不需要新机制。要写明的是**丢什么**——抄 dsh 那句写得很准的话（研究记录 §十）：**fresh tree, fresh plugins, 插件的内存状态全丢，sidecar 里的记录不动**。插件想跨重建保存东西，用 `card` 面里的变量成员（那是卡今天就有的持久化），不是别的。

### 6.6 `dispose-failed`

见 §5.7。它是**唯一骑在一个健康行上**的状态（插件还在、还能用，只是上一次拆卸留了东西），语义上对应系统插件的 `hook-failed`（`packages/iris-protocol/src/system-plugins.ts:35` 的第七个）。和它一样：不停用、不阻塞、**下一次成功拆卸即清除**。

### 6.7 id 撞车

不会发生，因为 id 由宿主用 `uniqueId`（`packages/iris-app-service/src/paths.ts:86`）对着**这段对话已有的 id** 铸（Q1）。真撞上（并发两条「创造」请求）是宿主的 bug：整条拒绝，记 `internal`，不写 sidecar。**不给它一个失败状态**——一个永远不该发生的情形有了名字，就会有人去处理它而不是修它。

---

## 7. 插件不准做什么

把话说平，三层，抄 [GENERATION-HOOKS](GENERATION-HOOKS.md) §5.5 的分法，因为那个分法诚实：

**1. 浏览器强制执行的（真边界）：**

- 不透明源 iframe（`frameSandbox`，`apps/iris-web/src/sandbox/policy.ts:36`）：碰不到壳的页面、碰不到别的聊天、碰不到别的卡的帧。`window.parent.document` 在 Iris 的任何代码被咨询之前就抛 SecurityError。
- 帧的 CSP（`framePolicy`，`apps/iris-web/src/sandbox/srcdoc.ts:104`）：`connect-src` 在未授权网络时是 `'none'`，`form-action 'none'`、`base-uri 'none'`、`frame-src 'none'`。
- 代码来源白名单（`REMOTE_ALLOWLIST`，`policy.ts:77`）：插件 `import()` 一个不在名单上的地址，宿主侧的 `checkScriptFetch` 再拒一次。

**2. 宿主强制执行的（我们写的闸门）：**

- 未授权的版本不挂（§4.1 第 8 步）。
- 超 Q2 上限的不写、不挂（§6.2）。
- 语法预检不过的不写、不挂（§6.1）。
- 挂载超时切断、整批预算切断（§6.3）。
- 帧→壳只能发 §5.2 那三条新消息，且各有长度上限；`parseFromFrame` 的 `default`（`protocol.ts:795`）拒掉一切别的。
- `plugin:style` 的 CSS 被当字符串处理、有 32 KiB 上限、绝不当 markup（§5.1）。

**3. 管不了、只能约定的（写进作者文档，不假装宿主能执行）：**

- 插件用 `Function('return this')()` 绕开门面拿到帧的全局。**拿到的是卡脚本已有的那一套**，所以这不是提权，是「门面不是墙」的直白后果。
- 插件写别的插件的样式标签、删别的插件的面板格子。同一个 DOM、同一个 realm，DOM 里没有所有权。
- 插件把 3 s 预算烧成同步死循环（浏览器杀不掉同步代码）。
- 插件通过 `card` 成员面做卡脚本能做的任何坏事（改变量、改世界书、发生成请求）。**这不是插件带来的新面**：它是卡今天就有的面，`declares` 里的 `members` 一项就是为了让玩家在确认卡上看见它。

**最后一句必须写下来，因为它是这个功能的全部风险浓缩**：模型写的代码不可信，而玩家会读着模型写的 `purpose` 去点那个勾。`purpose` 是代码作者自述的用途——**一段代码可以说自己在做 A 而实际在做 B，宿主分不出来**。抵御它的不是门面，是三样东西：确认卡把 `declares` 和字节数摆出来（玩家能看见「它说只改样式却有 40 KB 代码」这种不协调）、沙箱把后果关在这张卡这段对话里、以及列表面板（§12）让玩家随时能删掉它。这三样都不能阻止一个说谎的插件；它们能保证**说谎的代价是有界的、可见的、可撤销的**。这是本设计能诚实承诺的全部。

---

## 8. 可观测性（Q18 的另一半：每一条失败落在哪）

**新增一个 `ReportKind`：`'sandbox-plugin'`。** 要改两处，缺一处等于「没人在看」：`ReportKind` 的联合（`packages/iris-app-service/src/diagnostics.ts:23`）与 `KIND_WIRED`（`diagnostics.ts:59`），后者是 `WIRED_KINDS`（`diagnostics.ts:87`）的唯一来源。

为什么不骑 `script`：`script` 回答「卡的脚本出事了」，沙箱插件的行会被读成「这张卡的作者写的代码坏了」，而它是模型写的。归因错一层，在这里比在别处贵——玩家会去怀疑卡。

每条行的填法（`ReportContext`，`diagnostics.ts:134`）：

| 字段 | 填什么 |
| --- | --- |
| `kind` | `'sandbox-plugin'` |
| `grade` | `unparseable`/`syntax-failed`/`mount-failed`/`orphaned`(①③) → `fault`；`too-large`/`mount-timeout`/`dispose-failed` → `note` |
| `chatId` | 总是有 |
| `characterId` | 总是有 |
| `scriptId` | **不填** —— 它是脚本的 id，不是插件的 |
| `message` | `<pluginId> v<version> <state>: <detail>` —— 状态名进句子，因为行上没有 `field` 字段（§2.7） |

`#report`（`packages/iris-app-service/src/service.ts:7396`）的既有规则照用：字符串参数 = 句子在报告点写的；`Error` = 接住的，只有后者带 `stack`。帧侧的失败经 `plugin:failed` 到壳、再经**既有的** `script.report`（`packages/iris-protocol/src/rpc.ts:1516`）入宿主缓冲——不新开 RPC。

不做的事：**不给插件挂 usage/timing 的第三份账**。写插件那次请求的 token 花在 `iris_side_usage`（§11.3），挂载耗时在 `plugin:mounted` 的 `ms` 里、进报告句子，此外不立第三份账。理由与 [GENERATION-HOOKS](GENERATION-HOOKS.md) §5.6 同：今天只有一个读者。

---

## 9. 顺序

**按 `pluginId` 字典序升序，每次现算，不缓存。**

- 不按「玩家创建的先后」：那要存一个序号，而序号在删除之后会留洞，洞会被复用。
- 不给插件 `priority`：插件是模型写的，把自己设成最高没有代价（[GENERATION-HOOKS](GENERATION-HOOKS.md) §9.4 对 `priority` 的否决在这里更成立）。
- 不按依赖排：第一阶段插件之间没有依赖（§1 非目标）。
- **顺序对两件事可见**：样式（后挂的 CSS 赢，§5.4）、面板（格子的排列顺序）。两件都要写进作者文档。
- **失败不换序**：一个插件挂不上，剩下的按原序继续（§6.3）。

id 以 `<序号>-<slug>` 开头（Q1）意味着字典序大体等于创建序，而不依赖一个会留洞的计数器——序号只是 id 的一部分，不是一个独立的状态。

---

## 10. sidecar（裁决 Q11–Q13）

### 10.1 路径与 schema

```
<profile>/sandbox-plugins/<chatId>.json
```

- **一个 chatId 一个文件**，不是一个目录。`cache-trace/<chatId>/<seq>.json`（`packages/iris-app-service/src/cache-trace.ts:586`）是一个目录，因为它按 seq 轮转；这里一段对话的全部插件是一个原子单位——一次确认要同时改「版本表」和「授权记录」，两者分文件就有中间态。
- **进 `profilePaths`**（`packages/iris-app-service/src/paths.ts:282`）多一个键 `sandboxPlugins: join(root, 'sandbox-plugins')`，不像 `connections.key`（旁路派生）那样临场拼——它是一个独立的目录，`profilePaths` 就是这种东西的表。
- 文件名经 `fileFor(dir, chatId, '.json')`（`packages/iris-app-service/src/paths.ts:114`），与 chat 文件同一套白名单与 resolve 后包含性检查。**照抄 `CacheTraceStore` 的那条注释的做法**，不是自己写一遍。

```jsonc
{
  "version": 1,                 // schema 版本；不等就整份拒读并隔离（§10.4）
  "chatId": "爱衣-20260909-001924",
  "characterId": "爱衣",        // 反查用；与文件名一起构成「这份属于谁」
  "plugins": [ /* SandboxPluginRecord[]，见 §3.2 */ ]
}
```

- 写路径**只有** `atomicWriteFile`（`packages/iris-app-service/src/atomic.ts:135`）；读走 `readJsonStore`（`atomic.ts:307`），坏文件走 `quarantineCorruptFile`（`atomic.ts:206`）隔离到 `.corrupt-<ts>` 并记一条 `storage` 报告——三条全是既有行为，一条都不新写。
- **进程内串行**：一个 chatId 一条 promise 链，抄 `PluginDataStore`（`packages/iris-app-service/src/plugins/storage.ts:107`）的 `#chains` 形状。`host.lock`（`packages/iris-app-service/src/host-lock.ts:238`）保证一个 dataDir 一个进程，**不**保证一个进程内没有并发读-改-写。
- **不承诺持久性**：`atomicWriteFile` 没有 `fsync`（`atomic.ts` 的模块头写明）。整机断电保证「旧文件完整」，不保证「新插件还在」。这句话要写进 §16 的账本条目里，因为「插件下次还在」是这个功能的卖点，而卖点与保证之间的这一格是要说清的。

### 10.2 三个新 RPC

宿主自己用，插件够不着（§1 非目标）。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `sandboxPlugin.list` | `{ chatId }` | `{ plugins: SandboxPluginView[] }` |
| `sandboxPlugin.define` | `{ chatId, characterId, sentence, replaces?: pluginId }` | `{ pending: SandboxPluginView }` |
| `sandboxPlugin.decide` | `{ chatId, pluginId, hash, verdict: 'version' \| 'plugin' \| 'discard' \| 'disable' \| 'enable' \| 'remove' }` | `{ plugins: SandboxPluginView[] }` |

- 三个都是**静态 schema**，进 `packages/iris-protocol/src/rpc.ts`（`chat.*` 那一族旁边），不走 `scope.registerRpc`——那条路 `main` 上至今没有生产使用者（[SYSTEM-PLUGINS](SYSTEM-PLUGINS.md) 末尾），这个功能不该是它的第一个。
- `SandboxPluginView` 是线上投影：**不带 `code`**。列表面板不需要源码，而把模型写的代码放进每次 `list` 的回包是白白给它一条到壳的路。要看代码是一个单独的读（`sandboxPlugin.source`，PR-D，§15）。

### 10.3 聊天生命周期（裁决 Q12）

按 §2.5 那张表逐行：

| 事件 | sidecar 怎么办 | 判定 |
| --- | --- | --- |
| **rename** | **什么都不做。** chatId 不变（`service.ts:2231` 只改 header 的 title，经 `entry.ts:866`） | 裁决 |
| **delete** | **必须 forget。** 在 `chat.delete`（`packages/iris-app-service/src/service.ts:2183`）里加一行，紧挨着既有的 `settings.forget(chatId)`（`service.ts:2186`） | **裁决，且是硬要求** |
| **export** | **不带。** `chat.export`（`packages/iris-app-service/src/chats.ts:819`）的字节与今天逐字节相同 | 裁决（裁决 2 的直接后果） |
| **import** | **空。** chatId 被重铸（`chats.ts:747`），落地就是一段没有插件的新对话 | 裁决 |
| **branch** | 见下：复制，带授权，标 `branchedFrom` | **裁决**（协调人，2026-09-19） |

**delete 这条是硬要求，不是整洁。** `chat.delete` 里那段注释（`service.ts:2186` 附近）已经把理由写完了：chat id 是对着现存文件铸的，所以删掉之后同一个 id 可以被下一个同名对话拿到——一个留下来的 sidecar 会让**新对话开机就挂上陌生人的插件**，而且是已授权状态。`cache-trace/<chatId>/` 今天就有这个洞（没人 forget 它），它在那里的后果只是一份多余的诊断文件；在这里的后果是**执行**。所以这条要有自己的测试（§16.3）。

**branch（裁决：复制，且插件标记来源；协调人 2026-09-19 采纳下列推荐）**：

- **推荐复制。** 玩家在一段对话里长出来的功能，分支之后消失，读起来像功能坏了——而分支在产品里的语义是「从这里换一条路继续玩」，不是「重开一局」。upstream 的 `main_chat` 与 Iris 的 `parentChatId`（`packages/iris-app-service/src/chats.ts:672`）都表示「同一条线的延续」。
- **复制时把 `authorizedHashes` 和 `trustFutureVersions` 一起带过去**，不重新问。玩家已经对这段代码点过头，分支不是一个新的信任决定。
- **但要留痕**：子记录上加 `branchedFrom: <父 chatId>`，列表面板显示「来自分支」。理由：删掉父对话时，子对话的插件仍在（它们是自己的副本），玩家要能看懂为什么。
- **不推荐「按 `parentChatId` 继承而不复制」**：那让子对话的插件跟着父对话的编辑变化，而分支的全部意义是两条线各走各的；且父被删除时子会变成 `orphaned`。
- 不裁决的后果：按「复制」实现。协调人若选「不复制」，代价是分支后插件消失，要在分支的确认句里说出来（「这条分支不会带上这段对话长出来的 N 个功能」）——**无声的消失是不可接受的那一种**，两个选项都必须说话。

### 10.4 配额（裁决 Q13）

| 量 | 上限 | 超了怎么办 |
| --- | ---: | --- |
| 一段对话的插件数 | 16 | `sandboxPlugin.define` 拒，句子说「先删掉一个」 |
| 一段对话全部代码字节 | 256 KiB | 同上 |
| 单版本代码 | 64 KiB（Q2） | `too-large` |
| 保留版本数 | 8（Q2） | 追加时丢最旧的一版（**连同它的 `authorizedHashes` 条目**） |
| sidecar 文件 | 1 MiB | 超过即拒写并记 `storage` 报告；正常情况下前四条先拦住 |
| schema `version` 不等 | —— | **整份拒读并隔离**（`quarantineCorruptFile`），不做迁移。理由：一份读不懂的插件表如果被「尽力解析」，解析出来的东西会被执行 |

数字都是**判断，不是测量**——没有语料可以量，因为这个功能还不存在。每一个都写在一处常量里、注释说明它是判断而不是读数，并在第一批真实使用之后复核。这是 [METHODS](../notes/METHODS.md) 那条「被行为依赖的测量前提配一个会自己失败的测试」的弱化版：这里没有前提可钉，能做的是把「这是猜的」写在代码里。

---

## 11. 专用模型请求（裁决 Q14、Q15）

### 11.1 设置形状（Q14）

owner 裁决 1：「创造」那句话走**专用请求**，自己的连接档与模型，不用这个聊天的 preset/provider。

**最小加法**：`connections.json` 的文件层多一个字段，不是给每个 profile 加字段。

```ts
// packages/iris-app-service/src/connections.ts 的 ConnectionsFile 旁边
interface ConnectionsFile {
  profiles: StoredProfile[]
  activeId?: string
  /** 「写插件用」的连接档与模型。缺席 = 这个功能不可用（不是回落到 activeId）。 */
  authoring?: { id: string, model: string }
}
```

四条裁决：

1. **不进 `GenerationSettings`**（`packages/iris-protocol/src/views.ts:2046`）。那个类型是「一次生成的路由与采样」，按 chat 合并、按数值区间校验（`sanitize`，`packages/iris-app-service/src/settings.ts`）。「写插件用哪个模型」既不按 chat 分、也不是采样参数。可以援引的先例是 `SettingsFile.worldbooks`（`packages/iris-app-service/src/settings.ts:122`）：**类型不对就自己开一节**。
2. **不新建第二份供应商列表。** 它引用一个已经存在的 `StoredProfile`（`packages/iris-app-service/src/connections.ts:56`）的 id。连接面（CC Switch 形态：列表 + 增删改测，owner 2026-09-09）一个控件都不改，只在列表**下面**加一行：

   ```
   写插件用    [ 某个已保存的供应商 ▾ ]  [ 模型 ▾ / 手打 ]   [未设置时：一句「设置后才能用创造模式」]
   ```

3. **模型控件必须提供手打。** owner 2026-09-10 的裁决（`apps/iris-web/src/app/ConnectionPanel.tsx:171` 的 `modelTyping` 及其注释）对这个控件一字不差地成立——写代码的模型常常是内测模型。复用同一个控件，不写第二个。
4. **缺席不回落。** `authoring` 没设时，「创造」模式的入口是**灰的**并说明原因，**不**偷偷用 `activeId`。理由：回落会让玩家用一个他没选的模型花一笔他没预期的钱，而失败的形状（一个写不出插件的对话模型）看起来像功能坏了而不是配置没做。这与 `requireProvider` 在没有 active 时直接拒（`packages/iris-app-service/src/service.ts:1502`）是同一种诚实。

**请求怎么发**：复用 `#stream`（`packages/iris-app-service/src/service.ts:6918`）这一个漏斗，不开第二条。它已经是四个调用方共用的（回合、`script.generateRaw`、`script.generate`、压缩摘要），沙箱插件是第五个。路由不经 `#resolveRoute`（`service.ts:1497`）的四级兜底——`authoring` 直接给出档 id，档的路由由 `routeOf`（`packages/iris-app-service/src/connections.ts:894`）算。

### 11.2 模型读的那份文档（Q15）

**`docs/SANDBOX-PLUGIN-AUTHORING.md`，由 PR-B 交付，本文只定它的目录与两条硬约束。**

目录（抄 dsh 的 `SKILL.md` 的结构，不抄它的内容）：

1. 你在写什么：一个函数体，返回 `{ apply?, dispose? }`，参数只有一个 `iris`。
2. 你**有**的三件东西：`iris.styles`、`iris.panel`、`iris.card`（逐个给签名与一个十行例子）。
3. 你**没有**的东西，以及它们为什么不在：`fetch`、`window`、`document`、`import`、别的插件。
4. 体积与时间：64 KiB、`apply` 3 s。
5. **克制**：抄 dsh 那句写得最好的（`.reference/deepseek-harness/packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md`）——「Do not propose a Client/browser UI when the task does not need visible page behavior」。这里的版本是：**玩家要的是一件事，不要顺手加三件**；不需要面板就不要面板，不需要样式就不要样式。这是成本最低、效果最好的一道控制，因为运行时拦不住「合法但多余」。
6. `purpose` 怎么写：**它会被原样念给玩家听**，所以写你真正要做的事，不写推销。
7. 两个完整例子：一个纯样式（深色状态栏），一个纯面板（回合数）。
8. 失败会怎样：七个状态各一句，与 §6 同名。

**两条硬约束**：①这份文档是**模型的输入**，所以它的长度直接是每次「创造」请求的成本，要有一个字节上限（8 KiB）并在 §16 的测试里钉住；②它与本文 §5.3 的门面签名**必须逐字一致**，由一个测试对着同一个类型声明两边比对——两份文档各自正确、合起来不一致，是这个项目付过学费的那种缝。

### 11.3 token 与花费怎么可见（Q15 续）

- **记账进 `iris_side_usage`**（`packages/iris-app-service/src/side-usage.ts:92`），`SIDE_SOURCES`（`side-usage.ts:102`）加第三个成员 `'plugin'`。这是既有的、追加写的、挂在 chat header 上的记账面，用量面板已经在读它。
- **确认卡上不显示 token 数。** 玩家在那个时刻要判断的是「要不要这个功能」，一个 token 数只会挤掉 `purpose`。花费在用量面板里看，那是它的位置。
- **`SandboxPluginVersion.authored` 记下 `connectionId` 与 `model`**（§3.2），所以「这个插件是哪个模型写的」永远答得出来。这一条在第一次「模型 A 写的插件比模型 B 的好用」发生时就会被需要。

---

## 12. 「这个对话长了什么」（裁决 Q19）

**位置：聊天侧栏的一个面板，经 `iris.sidebar.panels` 槽**（`IRIS_SLOTS`，`apps/iris-web/src/slots/slots.ts:60`）。不进设置抽屉：它是**这段对话**的东西，不是这台 Iris 的配置；设置抽屉里那个位置属于系统插件（[INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §5）。

一行显示：

| 列 | 内容 |
| --- | --- |
| 名字 | `name`，点开看 `purpose` 与那句 `prompt` |
| 状态 | 挂着 / 停用 / **失败（七个状态之一，原样的 `detail`）** |
| 版本 | `v<n>`，点开看版本表（「上一版是什么样」） |
| 来源 | 「来自分支」（§10.3）或空 |
| 操作 | 停用 · 启用 · 删除 · 看代码 |

三条规则：

1. **失败的行不能只是灰掉。** 一句话说明是哪个状态、能做什么（`mount-failed` → 「再说一句话让它重写」；`dispose-failed` → 「切走再切回这个聊天」）。
2. **「看代码」是只读的。** 玩家不编辑模型写的代码——那会造出一个「玩家改过的版本」，而授权是按 hash 记的（§4.1），改一个字就要重新确认，而玩家不会理解为什么改自己写的东西要被问。要改就再说一句话。
3. **空的时候说一句话，不是空白。** 「这段对话还没有长出任何功能。切到「创造」说一句话试试。」——空状态是这个功能唯一的入口说明。

**composer 侧的「创造」开关**：放在 `+` 菜单里（`apps/iris-web/src/app/Composer.tsx` 的 plus 菜单，与「提示词」「斜杠命令」并列），**不**占 bar 上的一个格子。理由写在那个文件的模块头里：bar 上的每个控件「陈述一个事实并改变它」，而「创造」是一个**动作**，`+` 正是「不是关于下一次请求的事实」的那两件事的容身处。切进创造模式之后，输入框的占位符与发送键换词（「说一句话，让这张卡长出一个功能」），这是模式可见的唯一方式——**没有第二个状态指示**，因为一个隐藏的模式是这个交互唯一会静默出错的地方。

`iris.composer.actions` 槽（`apps/iris-web/src/app/Composer.tsx:1060`）**不用**：那是给扩展的挂点，这是 shell 自己的功能。

---

## 13. 与相邻机制的关系

### 13.1 系统插件

见 §3.1 的对照表。补一条：**沙箱插件不是一个系统插件**，它不进 `plugin.list`、不进插件中心、没有 `SystemPluginDefinition`、不经 `adoptDefinition`。[SYSTEM-PLUGINS](SYSTEM-PLUGINS.md)「Authority and scope」说「有一个插件控制面，将来的扩展挂点要接到它上面，不要造第二个注册表」——**这条在这里不适用，理由要说清**：那句话管的是「同权 Node 代码怎么进这台 Iris」。沙箱插件一行代码都不进宿主进程，它连一个注册表都不是，它是**一段对话的内容**，和这段对话的消息、变量、世界书同级。把它塞进系统插件目录，等于把「内容」和「安装」混成一件事——而这两件事的同意语义、信任来源、生命周期、删除后果**没有一条重合**（§3.1 逐行）。

### 13.2 ST 扩展面

不相干。ST 扩展跑在壳的隐藏 iframe 里（`apps/iris-web/src/st-extensions/plane.tsx`，D 族帧），用自己的令牌、自己的 srcdoc、自己的成员代理。沙箱插件够不到它，它也够不到沙箱插件。两者唯一的交集是：**卡帧里的 `EjsTemplate` 成员**（经 `CARD_METHODS`，`apps/iris-web/src/sandbox/card-api.ts:31` 的 `evalTemplate`）在插件的 `card` 面里也在——因为它在卡的成员面里。

### 13.3 生成钩子

不相干，而且必须说清为什么。[GENERATION-HOOKS](GENERATION-HOOKS.md) 的三个钩子是**宿主进程里的同权函数调用**，签名是「只读视图 + 提案」，预算 5 s，注册口是 `scope.hooks`。沙箱插件在浏览器的不透明源帧里，`scope` 这个词对它不存在。**一个想影响 prompt 的沙箱插件只能通过卡今天就有的那条路**：`injectPrompts`（`MEMBER_KINDS`，`apps/iris-web/src/sandbox/identity.ts:69`）。这不是缺口，是边界——让不可信的、模型写的代码直接进 prompt 构建，是另一个功能，要另一份设计。

### 13.4 Agent Tool Foundation（工具循环）

[notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md](../notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md) 已经框过同一条边界，而且框得更早：可见文本进 ST 兼容的 jsonl，别的进 Iris 自己的 sidecar；功能关掉时聊天文件与今天逐字节等价；sidecar 丢了对话仍能读。**本文的 §10 是那条边界的第二个实例**，不是第二条边界。

两者要共用的东西：那份记录的开放问题 2（`notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md:50`）问的是「sidecar 放对话旁边还是数据目录下独立目录」。**本文选了后者**（`<profile>/sandbox-plugins/<chatId>.json`，§10.1），理由是 chat 目录里除了 `.jsonl` 不放别的东西，混进第二种扩展名会让 `ChatStore.ids`（`packages/iris-app-service/src/chats.ts:274`）那个「文件名去掉 `.jsonl`」的读法多一个例外。**如果工具循环立项，两条线应当共用同一个决定**——不共用的话，一次备份要知道两个地方。这一条写在这里是给协调人的一个提醒，不是本文的裁决。

两者**不**共用的：工具循环的 sidecar 是追加写的事件流（`.events.jsonl` 形状），本文的是一份可整体重写的小 JSON。形状不同因为读法不同：事件流要按序追加，插件表要原子替换。

---

## 14. 被否决的方案

1. **把沙箱插件做成 `registerPluginMembers` 的第二个使用者**（复用成员表）。否决。那个函数**重复登记直接抛**（`apps/iris-web/src/sandbox/members-entry.ts:118`）、没有撤销口、收集是一次性判决（`apps/iris-web/src/sandbox/plugin-members.ts:52`，模块头「a verdict, not a poll」）——三条都与热挂载正面冲突。要改它就要同时改它服务的那个东西（系统插件的成员合并），而那条路今天是对的：**系统插件的成员在帧的生命里确实是不变的**，给它加上可变性是为了一个它不需要的功能付一份它要一直背的复杂度。
2. **拆帧重建来实现「热挂载」**（`runner.ts:862` 的 `dispose` + 新的 `runCard`）。否决。这是今天唯一可行的做法，也正是它不行的原因：重建会丢掉卡脚本的全部内存状态、重跑一遍卡的 `apply`、重新走一遍库加载（`PRESET_SETTLE_TIMEOUT_MS = 15_000`，`apps/iris-web/src/sandbox/library-state.ts:101`）。玩家说一句话换来的是整张卡闪一下重来——那不是「长出一个功能」，那是「重启」。
3. **给沙箱插件一个宿主半边**（照 dsh 的 host/client 两半）。否决，§1 非目标。dsh 自己的文档把它的前提写得很清楚（`.reference/deepseek-harness/packages/extensions/tool-cordis/README.md`：「The sandbox is containment for honest code, not a security boundary」），而模型写的代码跑在玩家机器上不满足那个前提。附带后果：dsh 的「宿主半边免确认」那个缺口在这里根本无从产生。
4. **按卡持久化，或者跨对话复用。** 否决（裁决 2，且理由独立成立）。按卡意味着插件要进 PNG 或者进一张按 characterId 的表；前者破坏 ST 兼容（§1），后者撞上 characterId **会被回收**这件事（[SANDBOX](SANDBOX.md)「Escalation」里那条「A grant dies with its card, and id reuse does not inherit it」）——一个按 characterId 存的、已授权的、会自动执行的插件，在删卡重导之后会挂进一张不同的卡。按 chatId 也有 id 回收问题，但 §10.3 的 `forget` 能关掉它，因为 chat 的删除是一个有明确落点的单一动作。
5. **给插件宏/slash/function-tool 的注册面。** 否决。Iris 今天**没有**这三个注册面（§0.1），造它们是另一条线的工作（宏注册表在宿主的 `@iris/macro`，slash 在 `triggerSlash` 的反方向，function tool 是工具循环的地盘）。为沙箱插件造三个新注册面，等于让第一个使用者是最不可信的那一类代码。
6. **确认卡画在帧里。** 否决，而且这是本设计里最不能让步的一条。画确认卡的那段代码就是要被确认的那段代码；它可以画一个假的 `purpose`、假的字节数，或者干脆画一个已经被点过的勾。dsh 的确认是帧全局的面板（`ui-cordis`），它能这样做是因为那个面板是它自己的静态代码——这里对应的位置是**壳**。
7. **让插件自己声明权限，宿主按声明放行。** 否决。`declares`（§3.2）是**显示用的自述**，不是闸门。理由与 [SYSTEM-PLUGINS](SYSTEM-PLUGINS.md) 的 `PLUGIN_PERMISSIONS` 一样（「宿主展示与拼写检查的声明、不是边界」），但在这里更硬：声明它的那一方是模型，一个按模型自述放行的闸门就是没有闸门。三件能力对每个插件**一律全开**，边界是 iframe。

---

## 15. 分阶段落地（裁决 Q21）

四个 PR，每个可独立合入、独立回滚、独立验收。**前两个不碰模型请求**——那是这条路上唯一会花钱的部分，也是唯一不确定的部分，把它放在机制立住之后。

### PR-A · 帧里的树，没有模型

> **落地：PR #142**（2026-09-19）。账本见 [notes/apps/iris-web/DEVIATIONS.md](../notes/apps/iris-web/DEVIATIONS.md) §112。

**做什么**：`SandboxPluginTree`（§5.3）、三件能力的门面（§5.4–5.6）、拆卸清单（§5.7）、协议六条消息（§5.2）、`card-scripts.ts:281` 那一行的条件放宽（§5.1）。插件源从哪来？**从一个 dev 面板手打**（`apps/iris-web/src/dev/` 一族，与 `SandboxProbe` 同处）。

**不做**：sidecar、确认卡、模型请求、B 族帧的样式扇出。

**为什么第一步是它**：整个功能的技术风险全在「挂得上、拆得干净」这一格。一个没有模型的版本可以被一行一行地验，而且它失败的时候没有人在花钱。

**验收宿主检查**（`qa/` 一支脚本，按 `qa/README.md` 的口径：自己起宿主、端口从 8791 起、CDP 从 9333 起、硬失败）：

1. 开一张带脚本的卡的聊天；dev 面板挂一个「把 body 背景改成深色」的插件；截图证明变了。
2. 卸载；截图证明**回到原样**，且 `document.querySelectorAll('[data-iris-plugin-style]').length === 0`。
3. 挂一个 `apply` 里 `throw` 的插件：帧还活着、卡脚本还在跑、`plugin:failed` 带 `mount-failed` 到达壳（读壳侧的状态，不读 console）。
4. 挂一个 `apply` 里 `while(true){}` 的插件：**这一条是设计的诚实性检查**——它会烧满 3 s 预算并且杀不掉，脚本报告要出现 `mount-timeout`，而**帧在同步循环期间是卡死的**。验收要把这个事实记下来（观察窗口写清），不是让它过。
5. 一张**没有脚本**的卡：挂一个插件，证明帧被建出来了（§5.1 的那一行改动）。

### PR-B · sidecar、确认卡、模型请求

**做什么**：§10 的存储（含 delete 的 `forget`）、§4.1 的全程、§11 的 `authoring` 设置与 `docs/SANDBOX-PLUGIN-AUTHORING.md`、Q3 的两条解析路、§6 的七个状态、§8 的 `sandbox-plugin` 报告 kind、§12 的列表面板与 composer 开关。

**前置**：PR-A 合入。**必须先裁决 Q17（挂载骑不骑 AUTORUN 门）与 Q12 的 branch 那一格**——两者都决定这个 PR 的落点。

**验收宿主检查**：

1. 【真实钱】切到「创造」，说「加一个显示回合数的小面板」；确认卡出现，逐字对上 §4.1 的六行；单勾；面板出现。
2. 关掉聊天、切走、切回：面板**还在**（这是「按对话持久」的唯一判据）。
3. 重启宿主、重开聊天：面板还在（这是「不是 session-only」的唯一判据）。
4. 说「把状态栏改成深色」；此时 B 族帧还没有扇出，所以**预期是卡脚本帧里的东西变了、消息里的状态栏没变**——验收要把这个记成已知边界并指向 PR-C，**不是记成通过**。
5. 说「把它删掉」；插件消失、样式消失、sidecar 文件里少一行。
6. **模型写坏代码**：用一个刻意会写出语法错的提示（或者 dev 开关注入一段坏代码），确认得到的是 `syntax-failed` 的具名句子 + 一条 `debug.reports` 行 + 一个重试入口，**而且这张卡还在正常聊天**。
7. 删掉这个聊天，新建一个同名的（逼 chatId 回收），确认新对话**没有**继承插件。这条对着 §10.3 的硬要求。

### PR-C · 样式扇出到消息界面帧

**做什么**：`plugin:style` 到壳、按 `(chatId, pluginId)` 存、折进 B 族帧的 srcdoc、移除即重建（§5.1）。

**验收**：PR-B 第 4 条那个场景现在要**真的变成深色**，且删掉插件之后状态栏**恢复**；字节预算（`frame-budget.ts:230`）没有被这份 CSS 顶爆（读帧预算面板的读数，取基线与终读的差）。

### PR-D · 打磨

版本表的「看代码」只读视图、分支复制（Q12 裁决之后）、`iris_side_usage` 的 `'plugin'` 成员与用量面板的那一行、空状态文案、双语文案审计。

**为什么这样切，而不是按能力切**（先样式、再面板、再成员）：三件能力共用同一棵树、同一份拆卸清单、同一套失败状态。按能力切会让第一个 PR 交付一棵只支持一种能力的树，而树本身（挂载队列、`pluginRunId` 收敛、拆卸清单）是不可分的那部分——切在那里会把唯一的难点切成三份各做三分之一。

---

## 16. 账本、文档、测试与牙齿（裁决 Q20）

### 16.1 账本

**两本各一节，因为这个功能有两半。**

- **界面与沙箱账**（`notes/apps/iris-web/DEVIATIONS.md`，最后一节是 §111）：新的一节记 **帧内 mini 树** ——上游没有任何对应物（SillyTavern 的卡就是卡，不会长东西），所以这一条是**有意改进**而不是兼容缺口，必须带代价：模型写的代码在卡的沙箱里跑、拆卸清单有六格而漏一格就会留东西、同步死循环卡死帧（PR-A 验收第 4 条量到的那个事实）。
- **宿主账**（`notes/packages/iris-app-service/DEVIATIONS.md`，最后一节是 §96）：新的一节记 **按对话的 sidecar 与专用 authoring 连接** ——代价是 `chat.export` 不带它、`chat.import` 拿不到它、`atomicWriteFile` 不 fsync 所以断电可能丢最后一次确认。

两本都按既有规矩：**追加，不改旧节**，每节写清上游怎么做、我们怎么做、代价。

### 16.2 文档

| 文档 | 动什么 |
| --- | --- |
| 本文 | 新增 |
| `docs/SANDBOX-PLUGIN-AUTHORING.md` | 新增（PR-B） |
| [docs/README.md](README.md) | 索引表加两行；「两种例外」那句（`GENERATION-HOOKS.md` 与 `ST-EXTENSION-DESIGN-AND-RUNBOOK.md` 是设计稿）要加上本文 |
| [notes/README.md](../notes/README.md) | §2.1 加一行研究记录，标题的计数 13 → 14、54 → 55 |
| [docs/SANDBOX.md](SANDBOX.md) | PR-A 合入时加一节：帧里现在还跑第三类代码（卡脚本、插件成员 bundle、**沙箱插件**），以及它为什么不改变冻结策略 |
| [docs/AUTORUN.md](AUTORUN.md) | PR-B 合入时（Q17 裁决之后）写清同意门覆盖了什么：`declined` 时插件也不跑 |
| [docs/OBSERVABILITY.md](OBSERVABILITY.md) / [docs/DEBUG-SURFACE.md](DEBUG-SURFACE.md) | 第八个 `ReportKind` 变第九个，两边的枚举列表都要跟着改 |
| [docs/SYSTEM-PLUGINS.md](SYSTEM-PLUGINS.md) | 加一句指向本文的话，明确「沙箱插件不是系统插件」，免得下一个人以为控制面要合并 |
| [docs/INFRASTRUCTURE-INTERFACES.md](INFRASTRUCTURE-INTERFACES.md) §8 | **这个功能不往 8.1 加缺口行**——它不是一条缺口，是一个新功能。落地之后在 §5 的帧侧那一节加一段（帧里有第二套注册面），落地之前什么都不加 |

### 16.3 测试与牙齿

**单元（`node --test`，不需要浏览器）：**

| 测什么 | 钉住的东西 | 牙齿（改坏它必须红） |
| --- | --- | --- |
| Q3 的解析器 | 围栏块与 `tool_calls` 两条路对同一份内容产出同一个记录 | 把围栏路的代码块标记从 `js` 改成 `javascript`：必须红，不能「宽容地也接受」 |
| 长度/形状校验 | 七个上限各一条 | 把 64 KiB 改成 64 KB（1000 vs 1024）：必须红 |
| 语法预检共用包装器 | 宿主试编译的源与帧求值的源**逐字节相同** | 在宿主那半的模板里多加一个空格：必须红。**这是 §6.1 那条「同一个包装器」唯一的执行者** |
| sidecar store | 写-读往返、坏文件隔离、schema version 不等即拒读 | 把 `version` 检查改成 `>=`：必须红 |
| **`chat.delete` 的 forget** | 删掉聊天之后 sidecar 文件不在了 | 注释掉那一行 forget：必须红。**这条是 §10.3 硬要求的唯一执行者，`cache-trace` 今天缺的就是它** |
| 拆卸清单 | 六格逐格断言，**并断言「比较过的格数 = 6」** | 在被测对象里跳过第 5 格：必须红。计数断言是为了挡住「循环里 `continue` 掉五格还绿」那一类 |
| 门面签名 vs 作者文档 | `docs/SANDBOX-PLUGIN-AUTHORING.md` 里的签名与 §5.3 的类型逐字一致 | 改文档里的一个参数名：必须红 |
| 作者文档字节上限 | ≤ 8 KiB（§11.2） | —— |
| **ST 兼容不变** | 一张没有沙箱插件的卡：`chat.export` 的字节与 sidecar 目录**不存在时**逐字节相同 | 让 export 顺手带上 sidecar：必须红 |

**浏览器验收场景**（`qa/` 一次性仪器，不进 CI，硬失败）：见 §15 各 PR 的验收表。四个必跑的场景是立项说明点名的四个：**深色状态栏**（PR-C）、**回合数面板**（PR-B）、**删掉它**（PR-B）、**重开对话还在**（PR-B）、**模型写坏代码 → 具名错误且卡照常运行**（PR-B 第 6 条）。

**两条方法上的要求**（[METHODS](../notes/METHODS.md) 与 `qa/README.md` 的既有口径，这里点名是因为它们对这个功能特别容易踩）：

1. **否定结果要带观察窗口。** 「卸载之后没有残留」必须写清「什么时候看的、看了多久」——一个异步的 `dispose` 在你截图之后才留下东西，和从来没留下东西，事后长得一模一样。
2. **诊断面是持久通道，判据是增量不是有无。** 先取基线报告行，再判新增；而且换角色时卡报告列表会被清空，所以终读可能比基线还少（`qa/README.md` 已经把这个坑写下来了）。

---

## 17. 问题清单

| # | 问题 | 状态 | 在哪 |
| --- | --- | --- | --- |
| Q1 | 记录形状与 id 方案 | 裁决：id 宿主铸造、模型只给 `idPrefix`；版本只追加；hash 是授权单位 | §3.2 |
| Q2 | 版本与体积上限 | 裁决：64 KiB / 8 版 / 16 个 / 256 KiB，全部是判断不是测量 | §3.2 |
| Q3 | 模型输出怎么变成记录 | 裁决：`tool_calls` 优先，围栏块兜底，共用校验器与 `unparseable` | §3.2 |
| Q4 | mini 树住在哪个帧 | 裁决：**卡脚本帧（A 族）**，一段对话一棵 | §5.1 |
| Q5 | 源怎么进帧 | 裁决：postMessage，六条新协议消息，两处 `switch` 各加一个 `case` | §5.2 |
| Q6 | 挂载/拆卸/替换的时序 | 裁决：串行队列、`new Function`、apply 3 s、整批 10 s | §5.3、§4.3 |
| Q7 | 门面之一：样式注入 | 裁决：`data-iris-plugin-style` 标签，不作用域化，后挂的赢 | §5.4 |
| Q8 | 门面之二：面板槽 | 裁决：`[data-iris-plugin-panels]` 容器，一插件一格，list 不是 chain | §5.5 |
| Q9 | 门面之三：卡片成员面 | 裁决：**既有的 124 个成员**，按 `pluginId` 绑定；前提更正见 §0.1 | §5.3、§0.1 |
| Q10 | 卸载要拆掉什么 | 裁决：六格清单，漏一格记 `dispose-failed` 不假装成功 | §5.7 |
| Q11 | sidecar 的路径与 schema | 裁决：`<profile>/sandbox-plugins/<chatId>.json`，进 `profilePaths`，`atomicWriteFile` 唯一写路径 | §10.1 |
| Q12 | 聊天生命周期钩子 | rename/delete/export/import **已裁决**；**branch 已裁决（2026-09-19）：复制并标 `branchedFrom` | §10.3 |
| Q13 | 配额 | 裁决：五条上限，schema 不等即整份拒读 | §10.4 |
| Q14 | 专用模型请求的设置形状 | 裁决：`ConnectionsFile.authoring`，引用已有档，缺席不回落 | §11.1 |
| Q15 | 作者文档与成本可见性 | 裁决：`docs/SANDBOX-PLUGIN-AUTHORING.md`（PR-B），8 KiB 上限，记账进 `iris_side_usage` | §11.2、§11.3 |
| Q16 | 确认卡内容与单/双勾 | 裁决：六行内容、五条硬规则、授权存插件行上 | §4.1 |
| Q17 | 重开聊天的挂载门 | **已裁决（2026-09-19）**：骑既有 AUTORUN 同意门，不自带第二道 | §4.2 |
| Q18 | 失败语义 | 裁决：七个具名状态，各一条 `debug.reports` | §6 |
| Q19 | 「这个对话长了什么」面板 | 裁决：`iris.sidebar.panels` 槽；composer 的开关在 `+` 菜单里 | §12 |
| Q20 | 账本、文档、测试与牙齿 | 裁决：两本账各一节，九项单元 + 五个浏览器场景，逐项给牙齿 | §16 |
| Q21 | 分阶段 PR 与验收宿主检查 | 裁决：PR-A/B/C/D，各带验收表 | §15 |

### 待裁清单（原 2 条，均已于 2026-09-19 裁决；保留原文供追溯）

1. **Q17 · 重开聊天时挂载骑既有的 AUTORUN 同意门。** 不裁决按本稿实现。若要第二道门：每次开聊天多一个唯一可行答案是 yes 的问题，[AUTORUN](AUTORUN.md) 已经写过这种问题的代价。
2. **Q12 的 branch 那一格 · 分支是否复制这段对话的插件。** 不裁决按「复制，并在子记录上标 `branchedFrom`」实现。若选不复制：**必须在分支时说出来**（「这条分支不会带上这段对话长出来的 N 个功能」），无声的消失是两个选项里唯一不可接受的那个。

另外两条不是待裁，是**给协调人的提醒**，因为它们跨线：

- §13.4：如果 [工具循环](../notes/RESEARCH-AGENT-TOOL-FOUNDATION-2026-09-17.md) 立项，两条线的 sidecar 位置应当是同一个决定。本文选了「数据目录下独立目录」，那份记录把这个问题列为它的开放问题 2。
- §16.2：本功能**不往** [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) §8.1 加缺口行。它不是一条缺口。若协调人认为它该在那张表上有一行，那要先回答「它的完成条件是什么」——而一个功能的完成条件是它的验收表，不是一行缺口描述。
