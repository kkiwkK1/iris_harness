# P3 兼容试点设计 —— ST-Prompt-Template @ f9a07da 原版产物在 Iris 中的运行

> 状态：有效（施工契约）。写于 2026-09-13，对象 C_BASE = `f8830f71a1b4f12b78e5630403e3ab0375f1b8ba` 与 ST-Prompt-Template `f9a07da`。产品源码（`packages/iris-compat-st-extension/src/runtime/`）至今按 §2 / §4 引用本文件作映射面的规格，验收对账见 `PILOT-REPORT.md`。契约不随代码更新；现状以 `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` 为准（索引见 `notes/README.md`）。

日期：2026-09-13。基线：C_BASE = `f8830f71a1b4f12b78e5630403e3ab0375f1b8ba`（A 最终交付 `f5b7250` 与 B 最终交付 `1463557` 汇入权威 `dev/system-plugins`，并通过联合类型、构建、渲染、全仓及无语料门；包含两笔仅修复联合类型门的集成提交）。本文是施工契约；验收报告（PILOT-REPORT.md）逐项对账。

## 0. 上游机制事实（普查来源：源码成员级普查 + 本文件 §4 表）

- 自启动：`$(async () => { await init() })` —— 依赖 iframe 内全局 `$`（jQuery）、`_`（lodash）、`toastr`。
- 提示词改写：`CHAT_COMPLETION_SETTINGS_READY`（`data.messages` 就地改写，逐条 `processGenerateAfter`）；`main_api==='openai'` 时跳过 `GENERATE_AFTER_DATA`。
- 变量：直接对象读写，不走 slash command——global→`extension_settings.variables.global`、local→`chat_metadata.variables`、message→`chat[id].variables[swipe]`。
- 楼层处理：`CHARACTER_MESSAGE_RENDERED` → `raw_message_evaluation_enabled`（默认 true）回写 `chat[i].mes`；`is_ejs_processed` 防重。
- 设置：`extension_settings.EjsTemplate`（21 键，`enabled` 默认 true）+ `saveSettingsDebounced()`；settings.html + `data-i18n` 属性由宿主套 `locales/zh-cn.json` 译文。
- dist 为 ESM，相对 import 17 个宿主模块 + `../libs/faker.mjs`；自持 Worker（compile_workers 默认 false，不构造）；`import.meta.url` 仅 webpack publicPath 探测。

## 1. 总体形状

原版 `dist/index.js`（一个字节不改）作为 ES Module 载入一个**专用隔离 iframe**（扩展运行面，srcdoc，与卡片帧同族但独立构建）。Iris 以"**ST URL 布局镜像 + 最小门面**"满足它的 17 个相对 import：宿主路由 `/iris-st-ext/<extensionId>/<rev>/` 同时服务两类文件——

1. **真件**：安装树里的 `scripts/extensions/third-party/ST-Prompt-Template/...`（dist、libs、settings.html、locales）——原版字节，rev 取 lock `artifactSha256` 前 12 hex，禁用即 404（与 /plugins 同一闸法）；
2. **门面**：`<rev>/script.js`、`<rev>/scripts/events.js` 等 17 个路径 —— 由 iris-web 构建产物（`vite.st-ext.config.ts` 多入口，路径即 URL 契约）经宿主路由映射。相对解析：`dist/index.js` 的 `../../../../../script.js` → `<rev>/script.js`，与 ST 根布局逐一同构。

iframe 与壳的通道：postMessage + token（复用 sandbox runner 的形态）。**快照进入（hydrate）→ 上游就地改写 → 写回（submit）** 三段式跨越 iframe 边界；上游代码看到的是普通 JS 对象，边界由兼容层搬运。

## 2. 最小事件映射（桥接序列）

| Iris 时机 | 向 iframe 发射 | 上游处理器 | 写回 |
| --- | --- | --- | --- |
| 打开聊天 | `CHAT_CHANGED(filename)` → `APP_READY` | 预载 WI+初始变量；干跑渲染（虚拟 DOM 无楼层 div → 全部跳过） | WI/初始变量状态留存 |
| 生成前（#contributions 内、分类与 itemize 之前） | `GENERATION_AFTER_COMMANDS(type, options, false)` → `CHAT_COMPLETION_SETTINGS_READY{messages}` | `handleFilterInstall`/`handleGenerateBefore`；`processGenerateAfter` 逐条展开 | `messages[i].content` 写回 contribution.text；chat/global 变量写回宿主 |
| 回复落层前（#settle 内、recordVariables 之前） | 追加楼层 div + `MESSAGE_RECEIVED(turn)` → `CHARACTER_MESSAGE_RENDERED(turn)`（makeFirst） | `handleMessageCreated` 克隆变量；`handleMessageRender` 永久求值回写 `mes` | `chat[turn].mes` + chat/global 变量写回；楼层存改写后正文 |
| 设置载入 | `SETTINGS_LOADED` | 同步设置到 DOM | — |
| saveSettingsDebounced | `SETTINGS_UPDATED` → 宿主持久化 | changeHandler | `extension_settings.EjsTemplate` 落 profile 存储 |

不映射（报告中逐项说明）：`GENERATE_AFTER_DATA`（main_api='openai' 分支天然跳过）、`WORLDINFO_ENTRIES_LOADED`（@@ 装饰器需在组装前改写条目，Iris 的 WI 组装在宿主侧；试点卡不含装饰器）、`MESSAGE_SENT/MESSAGE_SWIPED/MESSAGE_UPDATED/…`（楼层编辑/滑动面不在 UC 内；`js_generation_before_end` 为第三方扩展事件）、`WORLDINFO_UPDATED`。

确定性：`cache_enabled=0`（默认）每次新求值；展开是输入的纯函数 → UC-1 步骤 1 与步骤 4 逐字节一致可证。

## 3. 三个 UC 的宿主落点与停用/不补放语义

- **武装（arm）**：扩展 enabled 且浏览器运行面就绪后，壳经新 RPC `stCompat.plane.attach {extensionId, pluginRevision}` 登记；停用/卸载/页卸载 → detach。宿主桥（纯逻辑，`packages/iris-compat-st-extension/src/host/bridge.ts`）按 (extensionId, revision) 校验每次 submit——旧 revision / 未武装 / token 不符一律具名拒绝。**未武装 = 桥不存在 = 原文直通**：UC-1 步骤 3（停用后模板原文进提示词、不报错）与 UC-2 步骤 3（停用期回复不改变量）由此成立，而不是靠超时。
- **UC-1**：`#contributions`/`#previewItemization` 在 buildPrompt 之后、波动分类与 itemize 之前调用桥（contribution.text 就地改写；`<%` 快速门避免无谓往返）。itemize 与实际发送同源 → `prompt.itemize` 判定可见展开结果。
- **UC-2**：`#settle` 在 trim 之后、recordVariables 之前调用桥；submit 回 `{mes, chatVariables, globalVariables}`；chat 作用域整对象替换（与上游对象语义一致），global 落扩展命名空间设置块。重启用后：`CHAT_CHANGED` 预载在无楼层 div 的虚拟 DOM 上全部跳过，停用期原始楼层**不被处理、不补放**；新回复从停用前值继续累加。原生 MVU 在试点 profile 停用（`plugins` 配置缺席 → 关闭），满足"一个功能一个活动实现"。
- **revision/reload**：运行面 iframe 携带快照 revision；`plugins.changed` → revision 变化 → 帧销毁重建（复用卡片帧的重建链），旧帧的 submit 因 revision 不符被拒——reload 后旧帧立即失去提交资格。
- **UC-3**：设置面板本体在运行面 iframe 内（原版 settings.html + `data-i18n` 套译文，由门面 `renderExtensionTemplateAsync` 实现）；`iris.settings.sections` 槽位挂试点 section，把运行面的 `#extensions_settings` 投影成第二个沙箱 iframe（只读投影 + 交互中继：键盘/指针事件按路径回放真实 DOM，真实处理器执行），输入焦点留在投影内。停用 → section 不渲染、帧销毁、无残留；卸载 → 数据按默认保留。

## 4. 门面表面（17 模块 → 最小实现 / 清楚报错）

热路径全实现：script.js（eventSource/event_types/chat/chat_metadata/substituteParams（最小宏集）/messageFormatting（HTML 转义）/updateMessageBlock/appendMediaToMessage(空实现：试点无媒体)/addCopyToCodeBlocks(空实现：投影面无按钮语义)/this_chid/getCurrentChatId/main_api('openai')/characters/name1/name2/saveSettingsDebounced(桥)/saveChatConditional(桥，autosave 门)/user_avatar 等 persona 面）；extensions.js（extension_settings 活对象 + renderExtensionTemplateAsync）；events.js（eventSource/event_types）；world-info.js（loadWorldInfo 桥读宿主书 + 常量表）；slash-commands 族（注册收下、执行具名报错）；tokenizers（桥计数）；regex/engine.js（placement 清洗最小实现）；group-chats/reasoning/utils/power-user/openai/lib.js/popup.js 最小对象，**未在 UC 路径的成员一律调用即抛**（`UnsupportedStCompatApiError: <module>.<member> is not implemented by the Iris ST-compat layer (pilot scope)`，附模块与成员名）。

`SillyTavern.getContext()`：模板上下文 getter，试点抛同型错误（UC 模板不用）。全局注入：`$`（vendor jquery 3.5.1，取自本机只读 ST 安装，MIT）、`_`（vendor lodash，MIT）、`toastr`（自写 20 行 shim：转发到桥，宿主报告面可见）。

## 5. 卡片侧成员消费通道（landing site 3 移交件）

扩展 enabled 时，宿主激活物把**生成的成员包**（`src/host/member-bundle.ts` 的字面量 bundle）写进 plugin-assets 的 `<id>/client/client.js`——聚合 manifest 出行、卡片帧按既有 `data-iris-plugin` 标签载入，`registerPluginMembers('st-prompt-template', { EjsTemplate })` 注册一个**代理成员**：`evalTemplate(code, context)` 经 postMessage → 壳 plane → 运行面 → 结果原路返回。上游零改动；revision 闸与资产路由的 per-request enable 闸沿用 landing site 3 机制。

## 6. 文件与提交序

试点自有：`packages/iris-compat-st-extension/src/{runtime,host}/**`、`apps/iris-web/src/st-extensions/**`（plane、srcdoc、设置投影、成员代理、vendor、vite 配置）、`packages/iris-app-service/src/st-ext-assets.ts`（新文件）、各 tests 的 `st-ext-*.test.ts`、notes 两篇。**中央文件接线集中最后一个提交**：service.ts（三处桥点）、index.ts（组装：安装扫描、运行面 RPC、路由注册、桥实例）、paths.ts（扩展根）、system-plugins.ts（adoptDefinition）、iris-protocol（RPC 方法 + 桥事件）、iris-web（store 挂 plane、SettingsDrawer 槽位、PluginCenter 状态行）、package.json、THIRD-PARTY-NOTICES。
