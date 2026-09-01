# Iris — 基于 Cordis 架构的 SillyTavern 替代品

## Context

SillyTavern 是 AI 角色扮演前端事实上的标准，但它的地基是 Express + jQuery 的单体应用。这不是外部揣测——维护者自己在 issue #2633 里写道："技术债非常高，封装几乎完全瓦解"、"UI 与功能在整个项目中纠缠不清"；核心的 `Generate()` 是"一个巨大的单体函数，塞满了依赖所选 `main_api` 的临时变通"，本该由接口抽象的各家 LLM API 变成了满地的类型判断。同一 issue 里反对重构的理由也很实在：改造"耗时、易错，且会让大量待合并的 PR 无法合并"。

更要命的是安全模型。ST 官方文档明说用户密码"提供的是基本隐私，不是安全特性"，包括 API key 在内的数据"以明文存储在服务器上"，并警告"不要在公网服务器上或与不受信任的用户一起使用"。扩展**完全没有沙箱**——第三方扩展就是跑在应用同源里的任意 JS，能拿到 `getContext()`、密钥端点和整个 DOM。近期还有实际 CVE：corsProxy 反射型 XSS（CVE-2026-44651）、可删除整个扩展目录的未认证路径穿越（CVE-2026-44650，可与 DNS rebinding 组合远程利用）。

本项目（工作目录 `D:\workspace\小项目\iris_cordis_traven`，当前为空）要做的是：**保留 SillyTavern 的领域能力与生态兼容性，换掉它的地基**——改用 DeepSeek Harness 所用的 Cordis 插件框架。

选 Cordis 的理由不是它时髦，而是形态吻合：它是通用元框架，核心是**可逆插件系统**——组件可在运行时挂载/卸载/热重载，副作用在卸载时按注册逆序完整回滚，依赖通过 `inject` 声明并被反应式管理（依赖服务消失时，依赖它的插件自动卸载，服务回来时自动重载）。它自 2019 年起就是 Koishi 聊天机器人框架的内核，社区在其上建了 4000+ 插件——"聊天应用 + 海量社区扩展"正是它被设计来承载的形态。DSH 则证明了它能承载一个带完整浏览器 UI 的 LLM 产品。

预期结果：一个每个组件都是可替换插件的角色扮演前端，扩展彼此隔离、可热插拔、卸载无残留，同时能直接读写 SillyTavern 的角色卡、世界书、预设与聊天记录。Cordis 的可逆生命周期加上 DSH 的宿主/浏览器双 Loader 结构，天然给出了 ST 缺失的那条隔离边界。

## 已确定的决策

| 维度 | 决策 |
| --- | --- |
| 复用策略 | 复用 DSH 通用底座，自写领域插件 |
| MVP 范围 | 核心链路打通：角色卡导入 → 人格 → 提示词组装 → 多 provider 流式对话 → 聊天持久化 → 可用 Web UI |
| 生态兼容 | 全部四项：角色卡 PNG (V2/V3)、世界书 JSON、预设 JSON、聊天记录 JSONL |
| 部署形态 | 本地优先，但数据与存储层按多用户/多 profile 设计 |

## 已核实的环境与依赖事实

- 本机 Node v24.13.0、npm 11.18.0、corepack 0.34.5（DSH 要求 `^22.19.0 || >=24.0.0`，用 pnpm）。
- 本机已全局装有 `@deepseek-ai/dsh@0.1.0-rc.6`，其 `node_modules` 内含**全部 194 个 DSH 包**（编译后 ESM + 带完整文档注释的 `.d.ts`）。这是比线上文档更权威的参考，本计划的结论均据此逐包核实。
- 全部包 MIT 许可，`publishConfig.access: public`。
- **依赖风险（重要）**：`dsh-*` 包的 npm `latest` tag 指向占位版本 `0.0.1-rc.1`，真实发布在 `next`（`0.1.1-rc.2`）与 `alpha` tag 下。安装必须**锁定精确版本**，绝不能用 `^` 或 `latest`。整体 pre-1.0，API 有变动风险。
- **文档缺口**：README 质量极高，但大量链接指向 `.agents/notes/**` 与 `docs/**`，这些**不随 npm 包发布**。而这套契约异常严格（要求 yield 精确的 disposer、作用域载体、无损 JSON 校验、请求深冻结）。**动工前先克隆 `github.com/deepseek-ai/deepseek-harness` 拿到 notes 与 `apps/web` 源码，值一天时间。**
- 用 `@deepseek-ai/cordis`（4.0.2）而非上游 `cordis`：所有 `dsh-*` 包以前者为 peer dep，且全部类型声明合并都指向 `declare module '@deepseek-ai/cordis'`。

## 复用边界

判据是依赖闭包与运行时约束，逐包核实。

### 绿灯——直接复用

| 包 | 作用 |
| --- | --- |
| `@deepseek-ai/cordis` + `cordis-plugin-{loader,include,group,hmr,timer}` | 插件内核、YAML 组合装载与 patch 分层、热重载 |
| `dsh-app-boot` | `boot(binName, configPath, patches?, prepare?)`；README 明确它服务于**多个应用 bin** |
| `dsh-invariants` `dsh-brand` `dsh-timeout` `dsh-home-paths` `dsh-atomic-write` | 基础设施 |
| `dsh-storage` + `-json` + `-domain` | zod 校验、版本化、`domain/changed` 事件的 KV 域存储，后端可换 |
| `dsh-settings` / `dsh-credentials(-local)` / `dsh-attachment(-local)` | 设置、密钥引用解析、内容寻址附件（头像与聊天图片） |
| `dsh-scope` | 作用域链：注册视图**向下继承**（近者遮蔽远者），事件准入**向上扩散** |
| `dsh-llm` (+ `dsh-llm-retry`) | 适配器接缝、provider 目录、模型发现、流式协议、`BlockAssembler` |
| `dsh-system-prompt` | 有序 section 注册表 |
| **`dsh-session`（内核）** | append-only 事件日志 + surface 机制 + `fork()`。**无 `static inject`、不依赖持久化**，可独立使用 |
| `dsh-session-projection` | 由日志派生只读视图（每聊天状态、变量、关系值） |
| `dsh-host-webserver` / `dsh-host-frontend-static` | HTTP 与静态资源（无 TLS/无鉴权，公网需自行前置反代） |
| `dsh-client-ui-slots` / `dsh-client-web-react` / `dsh-client-modules` / `dsh-client-web` | 浏览器插件内核：Slot 系统 + React 绑定 + 模块系统 + 外壳（外壳"不 value-import 任何插件包"） |
| `dsh-client-ui-primitives` | 零 cordis 的纯 React 组件库，含**增量流式 Markdown 渲染器**（GFM + KaTeX、已消毒、只解析尾部两块）、shiki 代码块、JsonTree。聊天 UI 的大头 |
| `dsh-client-ui-theme` / `dsh-client-schema-form` | 主题令牌；schemastery 驱动的自动表单（设置面板的大头） |

### 黄灯——可用但要动手

- **`dsh-llm` 的采样面太窄**。`GenerateOptions` 只有 `temperature` / `maxTokens` / `stop` / `reasoningEffort`，README 自认"没有 `tool_choice`、`top_p` 或惩罚项字段"。而 ST 暴露约 76 个采样键。这两个是普通 TS interface，可用声明合并加字段，但 `callConfigEquals`、`prepareCall`、`request/header` 事件、设置 UI 全部按六字段形状写死。**按包一层薄封装服务来规划，而不是指望干净扩展。**
- **`dsh-session-persistence` 不能用**。它的读路径在 `assertEventsSupported` 里对不在 `KNOWN_SESSION_EVENT_TYPES`（由 DSH 仓库脚本生成）且未标 `ignorable` 的事件类型**直接抛错**。我们的 swipe 等事件影响重建、不能标 ignorable。但这不是问题：持久化本就是独立接缝（`ctx.sessionPersistence`），我们自写后端——为兼容 ST JSONL 本来就要写。
- **`dsh-host-apiproxy` 契约封闭**。`session.create/list/history/prompt/fork/rename/search` 形状正合适，但 workspaces/subagents/approvals 是编码 agent 专属，且正经扩展要走仓库内的 Typert 代码生成。倾向在 `ctx.webServer` 上自写网关服务。
- **`dsh-commands` 不是 STscript**。它是斜杠命令派发器，没有变量、控制流、类型化参数。MVP 够用，长期要自建脚本层。

### 红灯——必须自建

- **`dsh-agent` / `dsh-agent-loop`**：不是因为它绑编码 agent（它不绑，空工具注册表即可跑单次补全），而是因为**它封死了消息装配**。角色扮演的命门是按任意深度注入（作者注释在倒数第 N 条、世界书 `atDepth` 条目），而循环内部构建 `GenerateOptions.messages`，`llm/stream` 的 waterfall 里 `next()` 不接受参数（`next = () => cb(...args)`，args 固定），请求还被 `deepFreeze`。所以无法在外部改写消息序列。我们写自己的驱动——好在它比 ReAct 循环简单得多：无工具、无并行调用、无子代理。
- 深度注入的提示词流水线、token 预算截断策略。
- 世界书激活引擎（关键词扫描、递归、时序、包含组、预算）。
- 角色卡 / 世界书 / 预设 / 人格的领域模型与 ST 导入导出。
- 全部模型适配器（现存只有 `dsh-llm-deepseek` 与 `dsh-llm-pi-ai`）。
- 前端状态库与全部领域 UI（`dsh-client-runtime` 的 `SessionRuntime`/`WorkspaceRuntime` 写死了编码 agent 领域；`dsh-client-ui-conversation`/`-sidebar` 就是那个产品本身）。
- 鉴权、TLS、多用户。

## 关键接缝与 SillyTavern 概念的对应

### `ctx.systemPrompt` — 天然就是 prompt manager

```ts
section({ name, order, text: string | (ctx) => string, complete? }): () => void
variable(name, provider): () => void
assemble(context?): Promise<PromptAssembly>   // 触发 'system-prompt/assemble' waterfall
renderPrompt(assembly): string                // 严格 {{var}} 插值
```

- `order` 升序拼接 = ST 提示词条目顺序（约定：`-100` 身份、`0` 人格、`100–199` 工具指引）。
- **作用域内同名 section 遮蔽全局的**——配合 `dsh-scope` 的作用域链，直接实现 ST 的「全局预设 → 角色覆盖 → 单聊覆盖」三层覆盖。
- `variable()` = 宏系统，`renderPrompt` 对未知/未定义引用**抛错而非静默留空**，比 ST 安全。注意：替换后的值**不会被再次扫描**（无递归宏展开），且**没有字面花括号的转义语法**——这两点与 ST 行为有差异，需在宏引擎层自行补齐。
- `complete: true` 让某个 section 成为**唯一**系统提示词（其余照常求值后被丢弃）——这正是"角色卡接管整个系统提示词"的开关，且已作为 `dsh-persona` 的配置项存在。
- `'system-prompt/assemble'` 是 waterfall，`PromptAssembly` 与 `AssembleContext` 都显式**可合并扩展**——世界书引擎挂在这里，还能往上加 `chatId` / `characterId` 字段。

局限（README 自陈）：提示词文本是"组合/配置层"的，**没有面向终端用户的编辑 API**；没有深度注入；没有 token 预算。前两项我们自建，第三项本就是我们的。

### `dsh-session` 的 surface 机制 — swipes 的天然载体

会话不是"日志过滤"，而是日志之上一层显式有序的 **surface**：

```ts
SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }
```

`replace` 让新节点**遮蔽一段旧节点**（DSH 用它做上下文压缩）。这恰好就是 swipes：每次重新生成都 append 一条新的 `assistant/message` 并 `replace` 掉上一个候选——**全部候选都留在日志里**，surface 只呈现当前选中的那个。再加一个 `iris/swipe-select` 事件即可切换。导出时把日志里同一轮的候选收集成 ST 的 `swipes[]` + `swipe_id`，语义严丝合缝。

`fork(source, boundary, childSessionId)` 则直接就是 ST 的 checkpoint / 分支：包含式 seq 边界，拒绝在未闭合回合中间分叉，子 header 记 `parentSession`。

`SessionEventMap` 通过声明合并扩展；`append()` 会做一遍递归的无损 JSON 读-校验-拷贝（防止有状态 getter 给校验和存储返回不同值）并深冻结。

### `ctx.llm` — 接缝好，生态要自己建

`LlmAdapter` 是抽象类，**只有 `stream(options)` 一个必须实现的方法**；`registerAdapter(providers, adapter)` 返回的句柄还带 `.replace(providers)` 支持原子换路由。流式协议是 provider 无关的 `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`，且**所有失败都归一为一个终态 `finish` chunk，跨流 API 不抛异常**。密钥由 `ctx.credentials.resolve(ref)` 每次操作现取，配置里只存引用。

先写一个 OpenAI 兼容适配器即可一口气覆盖 OpenAI、OpenRouter、Ollama、llama.cpp、TextGen WebUI、DeepSeek、Together 等绝大多数端点，再单独写 Anthropic 与 KoboldCPP。参考实现 `dsh-llm-deepseek` 约 780 行。

### 浏览器插件平面

宿主扫描启用的 loader 行里带 `dsh.client` 清单段的包，解析其 `exports["./client"]`，把构建产物哈希进 boot 图，从 `/plugins` 提供；浏览器里**再跑一个 Cordis Loader**。所以浏览器插件就是真正的 Cordis 插件——同样有 `inject`、`ctx.effect`、可逆卸载。声明方式就是 package.json：

```json
"exports": { "./client": { "default": "./lib/client.js" } },
"dsh": { "client": { "inject": ["…包名…"], "platform": "web", "immediately": true } }
```

Slot 注册协议有 `single` / `list` / `keyed` / `chain` 四种；同一格位靠 `priority` 升序共存（**低者渲染**），同优先级重复注册会抛错并指名占位者。关键结构：`sidebar` 和 `conversation` 是 **`single` 槽**，由 ui-sidebar / ui-conversation 占据并在内部声明全部子槽——**注册进 `conversation` 就整体替换会话界面并带走所有子槽**。这正是我们要用的接缝：换掉领域 UI，保留外壳、布局、主题、设置与原语。

构建用 tsdown（React 走 externals）+ Vite。有个坑：插件包内**必须用 `/client` 子路径做值导入**，用裸包名会内联出第二份模块实例，其私有 Symbol 永远匹配不上。

## 必须精确复刻的 SillyTavern 数据契约

字段名与枚举值不能自创——这些是"替代品"三个字的兑现点。

### 角色卡

- V2 (`spec: "chara_card_v2"`)，内容在 `data` 下：`name` `description` `personality` `scenario` `first_mes` `mes_example` `creator_notes`（**禁止进提示词**）`system_prompt` `post_history_instructions` `alternate_greetings[]` `character_book` `tags[]` `creator` `character_version` `extensions{}`。
- V3 (`spec: "chara_card_v3"`) 增加 `nickname`（置换 `{{char}}`）、`creator_notes_multilingual`、`source[]`、`group_only_greetings[]`、`creation_date`/`modification_date`、`assets[]`（`uri` 支持 `embeded://`、`ccdefault:`、http(s)、data URI），世界书条目增加 `use_regex` 与内嵌 `content` 的装饰器（`@@depth` `@@role` `@@position` `@@activate` 等）。
- PNG 编解码：读取扫 `tEXt` 块，**优先 `ccv3`、回退 `chara`**，base64→UTF-8→JSON；导出先剥离旧块，再**同时写入 `chara` 与 `ccv3` 两块**，插在 `IEND` 前。
- **`data.extensions.*` 的未知键必须原样往返保留**。ST 生态的关键状态都在这里：`talkativeness`、`fav`、`world`、`depth_prompt`（`{depth, prompt, role}`）、`regex_scripts`，以及 chub / risuai / pygmalion 来源信息。丢弃未知键是最容易激怒卡作者的行为。
- 还要能吃 `.json`（V1/V2/V3）与 `.charx`（V3 zip）。

### 世界书

位置枚举逐值照搬：`before: 0` `after: 1` `ANTop: 2` `ANBottom: 3` `atDepth: 4` `EMTop: 5` `EMBottom: 6` `outlet: 7`。逻辑枚举：`AND_ANY: 0` `NOT_ALL: 1` `NOT_ANY: 2` `AND_ALL: 3`。

条目字段：`uid` `key[]` `keysecondary[]` `comment` `content` `constant` `vectorized` `selective` `selectiveLogic` `order` `position` `disable` `excludeRecursion` `preventRecursion` `delayUntilRecursion` `probability` `useProbability` `depth` `group` `groupOverride` `groupWeight` `scanDepth` `caseSensitive` `matchWholeWords` `useGroupScoring` `automationId` `role` `sticky` `cooldown` `delay` `displayIndex` `characterFilter`。

**存储形状是 `{ entries: { "0": {...} } }`——以 uid 为键的对象，不是数组。** 还要能读规范 V2 的 `character_book` 形状（`insertion_order`、`secondary_keys`、`position: "before_char"|"after_char"`）并映射；社区流通的是 ST 格式而非规范格式。

激活算法：按扫描深度从最近 N 条构建扫描缓冲 → 匹配关键词（默认全词、不分大小写，支持 `/re/flags`）→ 应用 `selectiveLogic` → 时序效果（sticky/cooldown/delay）→ `probability` → 按 weight/order/uid 排序 → 计入 token 预算（上下文百分比 + 绝对上限）→ 对已激活内容递归直到无新匹配或到上限。另有最小激活数与包含组（同组只留一个赢家）。

### 聊天记录 JSONL

第 0 行元数据（`user_name` `character_name` `create_date` `chat_metadata`），其后每行一条消息：`name` `is_user` `is_system` `send_date` `mes` `extra` `swipes[]` `swipe_id` `force_avatar` `gen_started` `gen_finished`。`extra` 承载各扩展的每消息载荷，**当不透明字段原样往返**。

### 预设

ST 有七类互相独立的预设。MVP 吃下三类：

- **Chat Completion 预设**：`prompts[]` + `prompt_order[]`。prompt 对象 `{identifier, name, role, content, system_prompt, marker}`（用户新增的还有 `injection_position` `injection_depth` `injection_order` `injection_trigger` `forbid_overrides`）。12 个内置 identifier：`main` `nsfw` `worldInfoBefore` `personaDescription` `charDescription` `charPersonality` `scenario` `enhanceDefinitions` `worldInfoAfter` `dialogueExamples` `chatHistory` `jailbreak`。`prompt_order` 按 `character_id` 分组。**哨兵语义 2026-09-01 实测更正（原文把两个魔数写反了，正好错在会让导入坏掉的方向）**：`PromptManager.js` 的类默认 `dummyId=100000` 被 `openai.js` 实例化时覆盖成 **`100001`**，Chat Completion 路径 12 处取用走的全是覆盖后的值——**`100001` 才是实际生效的全局哨兵，`100000` 是永远走不到的类默认**（但出厂预设文件里仍带着它）。磁盘实证：本机 6 个预设里，用户当前加载的 `梦境思客V1-0425` 和 `Antennae_v16` **只有 100001 分组**。导入要容忍两者共存、以 100001 为准；按原文实现会把这两个真实在用的预设解析成全量文件序列表（含用户关掉的段落）。
- **Context 模板**：`story_string` 是 **Handlebars**，变量 `{{system}} {{description}} {{personality}} {{scenario}} {{persona}} {{mesExamples}} {{wiBefore}}/{{loreBefore}} {{wiAfter}}/{{loreAfter}} {{anchorBefore}} {{anchorAfter}} {{trim}}`，另有 `example_separator` `chat_start` `story_string_position/depth/role` 等。
- **Instruct 模板**：`input_sequence` `output_sequence` `system_sequence` `stop_sequence` 及各自 `*_suffix`、`first_/last_` 变体、`wrap` `macro` `names_behavior`（`none|force|always`）、`activation_regex`（按模型名自动选模板）、`story_string_prefix/suffix`。

### 注入语义

```js
extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }
extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 }
MAX_INJECTION_DEPTH = 10000
```

Chat Completion 路径下：**深度 0 = 最后一条消息之后，深度 1 = 最后一条之前**。

## 扩展生态兼容：酒馆助手与 MVU

用户的 SillyTavern（1.18.0）实测装了 **JS-Slash-Runner（酒馆助手）4.9.1** 与 **ST-Prompt-Template**，并要求 Iris 也支持。下述契约来自本机磁盘上的扩展源码与类型定义（`data/default-user/extensions/JS-Slash-Runner/@types/`），不是文档转述。

这条需求改变了项目的性质：**角色卡不再只是数据，它会携带可执行的 JavaScript 和自定义 HTML 界面。** 这既是最大的兼容负担，也是相对 SillyTavern 最大的架构优势——ST 的扩展是同源里的裸 JS，而 Iris 的浏览器面本身就是一个 Cordis 上下文，卡片脚本可以关进沙箱 iframe，只通过 postMessage 暴露一套按能力授权的 API。

### 变量系统（`iris-variables`）

七种作用域，每种都要有：`chat`、`global`、`preset`、`character`、`message`（带 `message_id`，支持 `'latest'` 与负数深度索引）、`script`（带 `script_id`）、`extension`（带 `extension_id`）。

API 面：`getVariables(option)`、`replaceVariables(vars, option)`、`updateVariablesWith(updater, option)`（同步与异步两个重载）、`insertOrAssignVariables`、`insertVariables`、`deleteVariable(path, option)`（返回 `{variables, delete_occurred}`）、`registerVariableSchema(zodSchema, option)`。

两点值得注意：变量路径用 lodash 风格（`_.get/_.set/_.has/_.unset`，且 `_` 是注入的全局），而结构校验用 **zod**——与 `dsh-storage-domain` 同一套，可以直接对接。

**`message` 作用域是关键**：变量按楼层存储，这样重新生成/切换 swipe 时状态才不会串。它和我们用 `surfaceOp: replace` 建模 swipe 的方案是同一个问题的两面——每个候选回复必须携带自己那份变量快照。

### MVU 变量框架（`iris-mvu`）

数据形状：`MvuData = { initialized_lorebooks: Record<string, any[]>, stat_data: Record<string, any>, [key: string]: any }`。

模型在回复里发出更新命令，框架解析后套用到 `stat_data`。命令共五种，参数为字面量字符串：

- `set`：`[path, new]` 或 `[path, expected_old, new]`
- `insert`：`[path, value]`（尾部追加）或 `[path, index_or_key, value]`
- `delete`：`[path]` 或 `[path, index_or_key_or_value]`
- `add`：`[path, delta_or_toggle]`
- `move`：`[from, to]`

每条命令都带 `full_match`（原始文本，形如 `_.set('角色.络络.好感度', 30)`）和 `reason`（命令后的注释）。

对外接口：`Mvu.getMvuData(option)`、`Mvu.replaceMvuData(data, option)`、`Mvu.parseMessage(message, oldData)`、`Mvu.isDuringExtraAnalysis()`。

事件名必须逐字复刻（注意 `initiailized` 是上游的拼写错误，不能"修正"）：

```
mag_variable_initiailized   (variables, swipe_id)
mag_variable_update_started (variables)
mag_command_parsed          (variables, commands, message_content)
mag_variable_update_ended   (variables, variables_before_update)
mag_before_message_update   ({ variables, message_content })
```

`mag_command_parsed` 尤其重要：社区靠它做模型输出的纠错（修 Gemini 在中文间插入的 `-`、把繁体字映射回简体），必须允许监听器**原地修改命令数组**。

### 酒馆助手 API（`iris-compat-tavernhelper`）

`window.TavernHelper` 有 157 个成员。按域分组，逐域实现：

| 域 | 代表函数 |
| --- | --- |
| 变量 | 见上 |
| 聊天消息 | `getChatMessages` `setChatMessages` `createChatMessages` `deleteChatMessages` `getLastMessageId` `getChatHistoryBrief` |
| 生成 | `generate` `generateRaw` |
| 角色卡 | `getCharData` `getCharacter` `createCharacter` `deleteCharacter` `getCharAvatarPath` `getCharacterNames` |
| 世界书 | `getWorldbook` `createWorldbook` `getLorebookEntries` `createLorebookEntry` `getCharLorebooks` `getChatLorebook` |
| 人格 | `getPersona` `createPersona` `deletePersona` `getCurrentPersonaId` |
| 预设 | `getPreset` `createPreset` `getPresetNames` `getLoadedPresetName` |
| 正则 | `getTavernRegexes` |
| 提示词注入 | `injectPrompts` |
| 斜杠命令 | `triggerSlash` |
| 事件 | `eventOn` `eventOnce` `eventEmit` `eventRemoveListener`，事件表在 `tavern_events` 与 `iframe_events` |
| 脚本库 | `getScriptTrees` |
| 导入 | `importRawCharacter` `importRawChat` `importRawPreset` `importRawWorldbook` |
| 音频 | `audioPlay` `audioImport` `audioSelect` 等 |

MVP 只需覆盖变量、聊天消息、生成、事件、世界书读取这五组——它们是绝大多数卡片实际用到的部分；音频、导入、角色卡增删可以后置。

### 上游的真实机制（读源码确认，与直觉相反）

**酒馆助手的 iframe 没有沙箱。** 它用 `srcdoc`（或 blob URL）创建**同源** iframe，没有 `sandbox` 属性，子页面能同步访问 `window.parent`。注入脚本 `predefine.js` 把 `TavernHelper` 的所有成员**平铺成子窗口的裸全局变量**，另加 `_`（lodash）、`$`、`toastr`、`YAML`、`z`、`showdown`、`EjsTemplate`、`SillyTavern`、`Mvu`。`TavernHelper._bind` 里那些 `_` 前缀的变体会 `.bind(window)` 后去掉下划线暴露——这就是 `getVariables({type:'script'})` 如何知道是哪个脚本在调用、`getCurrentMessageId()` 如何工作的。

触发渲染的判据松得惊人（`is_frontend.ts`）：任何 `<pre>` 的文本里含 `html>`、`<head>` 或 `<body` 就被当作前端界面。自动高度是**子页面直接写父页面的** `frameElement.style.height`——只有同源才做得到。

### 沙箱设计（Iris 的有意分歧，但有一个硬约束）

我们要把脚本关进真正隔离的 iframe，按脚本 id 授予能力（哪些变量作用域可读可写、能否发起生成、能否改世界书）。卡片本身不关心我们怎么实现——它只认那套全局名字。

**硬约束：`getVariables()` 等 API 在上游是同步的，而跨源只能异步。** 解法是利用一个既有事实——`getVariables` 本来就返回 `klona` 深拷贝，卡片拿到的从来不是实时引用：

- **读**：宿主把相关作用域的变量快照预推进 iframe，同步读本地快照。语义与上游一致。
- **写**：本地乐观更新 + 异步回传宿主，宿主确权后广播新快照。

需要两个包：`iris-script-host`（脚本注册表、能力授权、消息路由、快照推送）与 `iris-script-sandbox`（iframe 生命周期、自动高度、`--TH-viewport-height` 的 `vh`→`calc()` 改写、API 代理）。

Cordis 在这里是直接得分项：每个脚本是一个可逆挂载的单元，卸载即完整回收副作用，而 ST 做不到。

### 必须逐字复刻的细节

这些是"能跑现有卡片"与"跑不了"的分界线：

- **上游的拼写错误要保留**：`substitudeMacros`（不是 substitute）、`updatelorebookEntriesWith`（小写 l）。
- 变量存储位置要精确对应：`message` → `chat[i].variables[swipe_id]`（**与 swipes 平行的数组**）、`chat` → `chat_metadata.variables`、`character` → `data.extensions.tavern_helper.variables`、`global` → `extension_settings.variables.global`。
- `getVariables` 返回深拷贝；`insertOrAssignVariables`/`insertVariables` 的合并规则是**数组整体替换而非合并**。
- `getAllVariables()` 的合并顺序：global → character →（脚本 iframe 内才有的 script）→ chat →（消息 iframe 内）当前楼层及之前每层的变量。
  **这条已实测复核为正确**，行号：`src/function/variables.ts:110-124`（global `:111`、character `:112`、script `:115`、chat `:117`、逐楼 `:118-124`）。
- **锚点不对称：两个 API 两种锚法。**（2026-09-01 补记，非更正——上一条一直是对的，这一条是它旁边一直缺的。）

  | API | 楼层锚点 | 出处 |
  | --- | --- | --- |
  | `getVariables({type:'message'})` **不传 `message_id`** | **最新一楼** | `variables.ts:59-60` 归一成 `-1` |
  | `getAllVariables()` 在楼层 iframe 内 | **本楼及之前每一楼** | `variables.ts:121` `chat.slice(0, 本楼 + 1)` |

  即：楼层 iframe 里调 `getVariables({type:'message'})` 读到的**不是自己那一楼**，而是最新一楼。
  要读本楼必须显式传 `{type:'message', message_id: getCurrentMessageId()}`。
  源码里没有任何地方把 frame 自身楼层号作为该 API 的默认值。

  连带两条容易漏的：

  - **`'latest'` 与显式数字的索引基准不同**：`'latest'`/`undefined` 分支**先滤掉 `is_system` 再取 `-1`**（`variables.ts:66`），
    显式数字分支直接 `chat.at(id)`、**不滤**（`:68`）。而写路径 `replaceVariables` 全程不滤（`:135`）。
    所以聊天里有系统消息时，**读的 'latest' 与写的 'latest' 指向不同楼层**。这是上游的不一致，
    按「兼容层不纠正它的源」照搬，不要"修好"。
  - **写前有一次形状归一**：`variables.ts:139-146` 注释写着「与提示词模板的兼容性」——
    ST-Prompt-Template 会把 `variables` 写成**普通对象**而不是按 swipe 索引的数组，
    上游在写入前把对象转回数组。只认数组形状的实现，读被 ST-Prompt-Template 碰过的聊天会出错。

  发现经过：测量楼层渲染管线时顺带读到，不是从文档推出来的。三处行号可复核。
- 脚本存在角色卡的 `data.extensions.tavern_helper` 里（`setting_field = 'tavern_helper'`），有 `Script` / `ScriptFolder` 两种节点的树形结构，还要兼容 `TavernHelper_scripts` 旧字段的迁移。
- 事件名字符串照抄，包括 `'GENERATION_AFTER_COMMANDS'`（值是大写）、`'characterDeleted'`、`'charManagementDropdown'` 这些不规则的。

### MVU 的解析语义（修正）

命令**不以 `<UpdateVariable>` 为界**——`extractCommands` 扫描整条消息。真正的护栏是：括号匹配感知引号（所以 `_.set('path', ['inner);'])` 能正确解析），且**闭括号后必须紧跟 `;`**，否则丢弃重扫。可选的尾随 `//注释` 成为 `reason`。

v2 的动词是 `set` / `assign` / `remove` / `add`，别名折叠：`remove|unset`→`delete`，`assign`→`insert`。`move` 只在 JSON Patch 方言（`<json_patch>` 块，RFC 6902）里可达。值表达式经 mathjs 求值。

两条容易漏掉的语义：`_.set` **拒绝不存在的路径**（不能凭空建键）；对 `[值, 描述]` 二元组，新值写进索引 0 而**保留描述**（除非开了 `strictSet`）。

`[initvar]` 的匹配是对世界书条目 **comment（标题）**做不区分大小写的**子串**匹配，条目本身可以是禁用的；正文用 YAML 解析（因而也吃 JSON/JSON5）。叶子约定是 `[初始值, "描述/更新条件"]`。

状态写回 `{initialized_lorebooks, stat_data, schema, display_data, delta_data}` 到**楼层级、每 swipe 一份**的变量里，并给消息追加 `<StatusPlaceHolderImpl/>`。`display_data` 的字符串格式是 `"{旧值}->{新值} ({原因})"`，虽被标记废弃但现存卡片都在读。

### 已实测定论的两点

**MVU 事件名**：酒馆助手的类型声明写的是 `mag_variable_initiailized`（拼错），MVU 自己的源码写的是 `mag_variable_initialized`。抓取上游实际发布的 bundle 确认——**发出的是拼写正确的 `mag_variable_initialized`**，酒馆助手那份 `.d.ts` 只是声明错了。以 bundle 为准。完整事件集：

```
mag_variable_initialized  mag_variable_update_started  mag_command_parsed
mag_variable_update_ended mag_before_message_update    mag_variable_updated(废弃)
mag_invoke_mvu            mag_update_variable
```

**注入 iframe 的第三方库（2026-09-01 实测更正——原文对脚本 iframe 少记了一个注入源，这个遗漏后来让真 MVU 在沙箱里多跑了一轮才定位）**：消息 iframe 得到 Tailwind（扩展自带本地副本）+ jQuery 全家 + Vue 3 runtime + vue-router。**脚本 iframe 的注入层是五样，按序**：`third_party_script.html`（Vue + vue-router，CDN tag）→ **`parent_jquery.js`（`window.$ = window.parent.$`，借宿主页面的 jQuery——原文漏的就是它）** → `predefine.js`（`_`/`z`/`YAML`/`showdown`/`toastr`/`EjsTemplate` 六个全局 + 三个 Vue 旗标）→ `cleanup_protector.js`（**有条件**：卡源码含 `pagehide` 则不注入）→ `log.js`（jsdelivr gh 路径）。**权威的"卡片期望全局"清单是 MVU 的 webpack externals 表（8 项）**，比枚举注入侧可靠：`$`、`_`、`showdown`、`toastr`、`Vue`、`VueRouter`、`YAML`、`z`。另注意 jQuery 实跑版本跟 **ST 页面服务的 3.5.1**，MVU manifest 里的 `^4.0.0` 是 devDependency（类型/jest 用），照它装会错一个大版本。

### 仍需确认的一点

`{{get_message_variable::…}}` 这个宏由谁提供——不是 MVU 注册的（MVU 源码里没有 `registerMacro`），可能来自 `LenAnderson/SillyTavern-MessageVariables`，但本机没装。等实际遇到依赖它的卡再定。

## 目标架构

```
iris（pnpm workspace monorepo）
├─ apps/iris                     bin：dsh-app-boot 的 boot() + 自有 cordis.yml
├─ apps/iris-web                 Vite 入口，构建在 dsh-client-web 外壳之上
├─ config/                       组合层：base / web 的 cordis.patch.yml
└─ packages/
   ├─ 领域内核（宿主）
   │   ├─ iris-turn              回合驱动：自建，因为消息装配必须归我们
   │   ├─ iris-pipeline          消息装配：历史 + 深度注入 + token 预算（注册表 + waterfall 范式）
   │   ├─ iris-macro             宏引擎：{{char}} {{user}} {{roll}} {{setvar}}，含递归展开与转义
   │   ├─ iris-swipe             基于 surfaceOp replace 的候选回复模型
   │   ├─ iris-variables         七作用域变量系统（含 message 作用域，zod 校验）
   │   └─ iris-persistence       会话持久化后端（ST JSONL 兼容），实现 ctx.sessionPersistence 接缝
   ├─ 扩展生态兼容
   │   ├─ iris-script-host       脚本注册表 + 能力授权 + postMessage 路由
   │   ├─ iris-script-sandbox    浏览器侧 iframe 沙箱与 API 代理
   │   ├─ iris-compat-tavernhelper  TavernHelper 全局 API 面
   │   ├─ iris-mvu               MVU 命令解析、套用与事件
   │   └─ iris-compat-prompt-template  ST-Prompt-Template 的模板求值
   ├─ 领域数据（storage.domain + zod）
   │   ├─ iris-character         角色卡域 + PNG tEXt(chara/ccv3) V2/V3 编解码 + charx
   │   ├─ iris-lorebook          世界书域 + 激活引擎
   │   ├─ iris-persona           用户人格域
   │   └─ iris-preset            预设域 + ST 三类预设导入导出
   ├─ 模型适配器
   │   ├─ iris-llm-sampling      采样参数封装层（补齐 dsh-llm 的六字段）
   │   ├─ iris-llm-openai-compat 覆盖 OpenAI/OpenRouter/Ollama/llama.cpp/TextGen/DeepSeek…
   │   ├─ iris-llm-anthropic
   │   └─ iris-llm-kobold
   ├─ 传输层
   │   ├─ iris-rpc-host          基于 dsh-host-webserver 的 HTTP + WebSocket
   │   └─ iris-rpc-client
   └─ 客户端 UI（每个都是浏览器端 Cordis 插件）
       ├─ iris-client-runtime    zustand 状态库
       ├─ iris-client-chat       占据 conversation 单槽：消息流、流式、编辑、swipe、重生成
       ├─ iris-client-library    占据 sidebar 单槽：角色库、导入导出
       ├─ iris-client-lorebook   世界书编辑器
       └─ iris-client-settings   基于 dsh-client-schema-form 的设置与采样面板
```

## 实施步骤

### 阶段 0：技术验证（先做，用来证伪）

在搭 monorepo 之前先跑最小 spike，验证会推翻整个方案的事：

1. 克隆 `deepseek-harness` 仓库，取到不随 npm 发布的 `.agents/notes/**`、`docs/**` 与 `apps/web` 源码。
2. 用**锁定的精确版本**装 `@deepseek-ai/cordis`、`dsh-app-boot`、`dsh-llm`、`dsh-system-prompt`、`dsh-session`、`dsh-storage-*`、`dsh-host-webserver`，确认它们在 DSH 之外的项目里能解析、导入、通过类型检查。
3. 用 `boot()` + 自写 `cordis.yml` 起进程，挂 `dsh-llm` + 自写 OpenAI 兼容适配器，跑通一次**流式对话**。
4. 验证 `dsh-session` 在不挂 `dsh-session-persistence` 时可独立工作，且我们声明合并进 `SessionEventMap` 的自定义事件能 append、能被 `surfaceOp: replace` 遮蔽。
5. 浏览器 spike：Vite + `dsh-client-web` + `dsh-client-ui-slots` + 一个自写 slot 插件，确认外壳在没有 `dsh-client-runtime` 的情况下能启动并渲染。

**任一不通过即触发路线回退**：退到"只依赖 Cordis 内核、其余全部自建"。第 5 步是最大的未知，因为唯一的参考 Web 应用 `dsh-web-frontend` 只发布了 `dist`。

### 阶段 1：领域内核

`iris-turn` 回合驱动 → `iris-pipeline` 消息装配 → `iris-macro` 宏引擎 → `iris-swipe` → `iris-persistence`。脚本与测试驱动，不依赖 UI。

### 阶段 2：领域数据与 ST 生态互通

四个 domain + 四类导入导出。验收标准是拿真实 ST 资产往返转换不失真。

### 阶段 3：传输层与客户端外壳

`iris-rpc-host`/`-client` + `iris-client-runtime`，把阶段 1 的能力接到浏览器。

### 阶段 4：领域 UI

聊天界面（流式、编辑、swipe）、角色库、设置与采样面板。

### 阶段 5：世界书

激活引擎接进 `iris-pipeline`，加世界书编辑器。按 MVP 定义它排在核心链路之后，但它是 ST 用户第二在意的功能。

### 阶段 6：扩展生态兼容

顺序有依赖，不能打乱：

1. `iris-variables` —— 七作用域变量系统。**必须先做**，因为脚本 API 和 MVU 都建在它上面，而它的 `message` 作用域又依赖阶段 1 的 swipe 模型（每个候选一份变量）。
2. `iris-script-host` + `iris-script-sandbox` —— iframe 生命周期与快照同步机制。先跑通一个只会读写变量的最小脚本。
3. `iris-compat-tavernhelper` —— 按域逐步补齐。MVP 只做变量、聊天消息、生成、事件、世界书读取五组。
4. `iris-mvu` —— 命令解析器（含引号感知的括号匹配与强制尾随 `;`）、`[initvar]` 加载、五个事件。
5. `iris-compat-prompt-template` —— EJS 模板求值。

验收就用真实的社区卡：一张带状态栏 UI 的 MVU 卡，能初始化变量、随对话更新、切 swipe 不串状态。

## 验证方式

- **阶段 0 门禁**：`node apps/iris/bin.js` 能启动并完成一次流式对话；浏览器 spike 能渲染出自注册的 slot。不通过就回退路线，不要硬推。
- **单元测试**：`iris-pipeline` 的装配顺序与 token 预算截断；`iris-macro` 的宏求值（含递归与转义）；世界书关键词扫描、`selectiveLogic`、递归深度、包含组。表驱动。
- **生态互通（关键验收）**：准备一组真实 ST 资产（角色卡 PNG、世界书 JSON、三类预设 JSON、聊天 JSONL），做**导入 → 导出 → 与原文件比对**的往返测试，重点确认 `data.extensions.*` 与消息 `extra` 中的未知键零丢失。
- **端到端**：起进程 → 浏览器打开 → 导入角色卡 → 发消息 → 看到流式回复 → 重新生成产生 swipe 且可左右切换 → 刷新后历史与全部候选仍在。
- **插件可逆性**（Cordis 的核心卖点，必须守住）：运行时卸载任一领域插件，确认其注册的 prompt section、slot UI、domain 表句柄全部干净移除、无残留副作用；HMR 改插件后无需重启进程即生效。这条是我们相对 SillyTavern 的核心差异，要有测试守着，不能只是口号。

## 诊断备忘

Cordis 有两种静默失败，调试时先查：模块**解析**失败（路径或包名拼错）只经 logger 上报、不会 crash——~~启动早期可能在 console exporter 就绪前丢失~~ **2026-09-01 探针实测更正：不是时机问题，是级别阈值**。cordis 的 exporter 解析式 `levels?.[name] ?? levels?.default ?? logger.level ?? 1` 默认阈值 1，而 `WARN=2` —— **整个 warn 通道默认是黑的**（error 打得出、warn 打不出，boot 前后皆然）。组合里必须给 logger 配 `levels.default: 2`，否则所有「出错但撑住了」的上报（onError、socket 失败、逐请求警告）都无痕消失；`inject` 了未提供服务的插件会永远停在 `PENDING` 且不打印任何东西。排查方法是遍历 `ctx.registry.values()` → `runtime.fibers`，找 `fiber.state === FiberState.PENDING`。

另外记住 Cordis 4 的两个事实，网上大量资料是过时的 v3：**没有 `Service.start()`/`stop()`**（构造函数即加载钩子，`ctx.effect()` 的 disposer 即卸载钩子，异步启动用 `[Service.init]()`），**没有 `ctx.scope`**（v4 叫 `ctx.fiber`；`@deepseek-ai/dsh-scope` 是另一回事）。

---

## 执行进度（滚动更新）

### 已完成

阶段 0 的五道验证关全部通过（见 `spike/RESULTS.md`）。阶段 1–2 及阶段 6 的大部分已落地：12 个包 + 宿主应用，**275 个测试全绿，`tsc --noEmit` 干净**。

已实现：会话日志与 swipe 模型、回合驱动、提示词装配（含深度注入与预算）、宏引擎、七作用域变量、MVU（解析/套用/InitVar）、酒馆助手 API 与事件总线、角色卡 PNG 编解码、世界书激活引擎、预设导入、聊天 JSONL 往返、OpenAI 兼容适配器、Cordis 宿主组合。

端到端验证覆盖两条链路：预设 → 装配 → 流式 → swipe → 导出；以及世界书声明变量 → 模型发命令 → 状态归属该候选 → 重新生成不继承 → 切回恢复。

### 计划中被实测纠正的地方

- **世界书激活顺序**写错了。真实顺序是 filter → 关键词 → selectiveLogic → 排序（sticky 优先 + 调用方预排序，**不是** order/uid）→ **包含组** → **概率** → 预算；`order` 只在最后分桶时才重新应用。组筛选发生在概率判定**之前**，所以组内落选者即使赢家随后掷点失败也已出局。
- **全词匹配的「默认」有三档,别混**（2026-09-01 实测更正,此前这条只说对了一半）:
  代码变量初始值 `false`（`world-info.js:78`）;**全新安装实际拿到 `true`**（出厂
  `default/content/settings.json` 会覆盖初始值）;本机用户手动关成 `false`。Iris 若照
  「代码默认 false」设,行为会和新装 ST 不一致。另:条目级 `matchWholeWords` 是**三态**
  （显式开/显式关/`null`=跟随全局,`entry.matchWholeWords ?? 全局`）,引擎只存布尔会丢
  「跟随全局」一态。
- **`[值, 描述]` 的解包只发生在 `set` 和 `add`**，`insert`/`delete` 不解包——这才是 v2 提示词强制路径带 `[0]` 后缀的原因。且 `set` 的解包额外要求首元素非数组。
- **MVU 命令不以 `<UpdateVariable>` 为界**，是全文扫描；真正的护栏是闭括号后必须紧跟 `;`。
- **`mag_variable_initialized`**：抓取上游 bundle 确认拼写正确，酒馆助手的 `.d.ts` 写错了。
- **酒馆助手的 iframe 没有沙箱**，是同源 `srcdoc`，API 被平铺成裸全局变量。Iris 做真隔离是有意分歧，代价是同步 API 需要靠预推快照实现。
- ST 1.18.0 **并未实现 V3 数据模型**，只是把 V2 的 JSON 重新盖上 V3 的戳写进 `ccv3` 块。

### 未完成

- **浏览器一半**：RPC 传输层、客户端状态库、领域 UI（聊天界面、角色库、世界书编辑器、设置与采样面板）。阶段 0 已证明外壳可用，接缝是 `uiRenderer`。
- **卡片脚本沙箱**：`iris-script-host` / `iris-script-sandbox` 尚未开始。
- **酒馆助手 API 的其余域**：角色卡增删、世界书写入、人格、预设、正则、音频、导入。已实现的是 MVP 五组（变量、聊天消息、生成、事件、swipe）。
- **`.charx`（V3 zip）导入**：需要 zip 读取器。
- **mathjs 表达式求值**：MVU 的值目前保守求值，表达式原样透传而非猜测。
- **JSON Patch 方言**与 `_.move`。
- **Context/Instruct 模板**（文本补全路径）：目前只做了 Chat Completion 预设。
- **分词器**：预算与世界书都接受注入的 `countTokens`，但没有内置实现。
