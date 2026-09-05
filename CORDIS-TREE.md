# CORDIS-TREE — 当前运行时的 Cordis 组合树（快照：d31f0a3 + 宽屏修正）

来源：`apps/iris/cordis.yml` + 各插件 `export const inject` / `static inject` + `index.ts` 装配实际代码。
`【提供】`= 该插件发布到 ctx 的服务；`[inject]`= 声明依赖的服务。

## 1. 组合根（cordis.yml，9 个根插件，并发启动、靠 inject 定序）

```
boot (IRIS_PORT, IRIS_ST_DIR, IRIS_WEB_DIST…)
│
├─ logger              cordis-plugin-logger-console        [levels.default=2，防 warn 被吞]
├─ timer               cordis-plugin-timer
├─ system-prompt       dsh-system-prompt                   [关闭 harness 身份，persona 留空——Iris 自装]
├─ llm                 dsh-llm                             【提供 ctx.llm——模型注册表与 stream】
│
├─ llm-openai-compat   @iris/llm-openai-compat   [inject: llm]
│    config: baseURL ← IRIS_BASE_URL ?? 127.0.0.1:11434/v1
│            apiKeyEnv ← IRIS_API_KEY_ENV, model ← IRIS_MODEL
│    mount:  ctx.llm.registerAdapter([config.provider], OpenAiCompatAdapter)
│            （运行时还会被 app-service 的 connection.activate 重装——见 §2）
│
├─ webserver           dsh-host-webserver                  【提供 ctx.webServer】[仅 loopback，无 TLS/鉴权]
│
├─ rpc                 @iris/rpc-host            [inject: webServer]
│    mount:  ctx.webServer.register → POST /iris/rpc（请求帧路由）
│                                   + WS  /iris/events（事件广播）
│    提供:   ctx.irisRpc（.register / .broadcast）
│
├─ app                 @iris/app-service        [inject: irisRpc, llm, webServer]   ← 最大的插件，见 §2
│
└─ frontend            dsh-host-frontend-static            [IRIS_WEB_DIST 缺构建时 disabled]
     serve:  dist/index.html + /sandbox/*（bootstrap/members/preset 产物，供卡帧跨源加载）
```

## 2. app（@iris/app-service）内部——协议与领域装配

inject: `['irisRpc', 'llm', 'webServer']`；config 走 schema（dataDir/profile/sillyTavernDir/…）。

```
app (@iris/app-service)
│
├─ 组合根装配的 store 家族（随 ctx 生命周期）
│   ├─ SettingsStore            settings.json
│   │     ├─ preset 节（任务 M：激活预设/持久化）
│   │     ├─ worldbooks 节（任务 L：globalSelect + 11 个扫描旋钮）
│   │     └─ load() 修复：两节均透传（曾丢 worldbooks——已修）
│   ├─ PresetStore              default-user/presets/*.json（任务 M 库 + importFile）
│   ├─ persona store            personas.json（任务 S：多人格 + activeId 三态）
│   ├─ connections store        connections.json（任务 N：密钥随档，永不回显）
│   ├─ ExtensionSettingsStore   extension-settings.json（B3：.regex 全局正则层；.variables）
│   ├─ ChatStore                chats/*.jsonl（ST 投影；search/import/export；分支谱系 main_chat→parentChatId）
│   └─ WorldbookStore           worldbooks/*.json（卡内嵌副本播种 + 聊天级书 getOrCreateChatWorldbook）
│
├─ ctx.irisRpc.register —— handler 表（按域，约 70 方法）
│   ├─ chat.*        list/create/open/send(kind: send|continue|impersonate)/regenerate/swipe/
│   │                editMessage/deleteMessage/branch/search(B1)/import/export(A3)
│   ├─ character.*   list/import/delete + duplicate/rename/export(P)/tags(P)
│   ├─ preset.*      list/read/select/save/delete/importFile(M续)/promptManager(M)
│   ├─ persona.*     list/get/set/delete(S)
│   ├─ worldbook.*   names/load/get/charNames/globalSelect/setGlobalSelect/replace
│   │                + create/bindChat/settings/setSettings(L)
│   ├─ regex.*       list/set(B3，整表替换原语)
│   ├─ connection.*  list/save/delete/activate + test(N：GET /models 探针)
│   ├─ script.*      TH 兼容面（generateRaw(N 补)/getPreset/getVariables/…）
│   ├─ storage/debug/prompt.itemize/connection.profiles …
│
├─ ctx.llm.registerAdapter —— 运行时适配器
│   ├─ 组合默认：llm-openai-compat（.env/config 路由）
│   └─ connection.activate：按 profile 重装（baseURL/key/model 三件套，dispose+重装，不驱逐组合默认注册）
│
├─ ctx.webServer.register —— 非协议路由：/iris/avatar/*、CORS 头、（sandbox 资产走 frontend）
│
├─ ctx.effect —— 清理钩子（每次热重载/卸载回收）
│
└─ 每个 chat 一台 TurnDriver
     #contributions（世界书扫描[L]→persona 扫描[S]→宏上下文[B4: outletSink/tokenBudget]→预设装配[M]→历史）
     → iris-turn driver：send / continue(seed+拼接) / impersonate(user 行) / regenerate
     → ctx.llm.stream → stream.* 事件广播
```

## 3. frontend（dsh web shell 内的 ui-plugin @iris web）

```
ui-plugin（inject-wait: uiRenderer——Iris 自己 provide，不加载 dsh-client-runtime）
│
├─ ctx.provide('uiRenderer', renderer)          [ctx.effect 注册，卸载可逆]
├─ ctx.effect(slots.dispose)                    [slot 账本]
├─ ctx.effect(store.dispose)                    [IrisHttpClient：rpc POST + events WS + 重连]
│
├─ createClient onError → store.notify           [socket 断连 → 通知去重(O)]
│
├─ slots
│   ├─ iris.sidebar.panels   → WorldbookPanel(L) / PresetPanel(M) / RegexPanel(B3) / PersonaPanel(S)
│   └─ iris.message.actions  → demo provider(Q 接缝；未来 TTS/翻译/图像)
│
└─ 沙箱帧（每帧一个 opaque origin iframe，CSP 收紧）
     ├─ members.js + zod-compat（K3：prefault 链穿透）+ seed（K2：快照先于 bootstrap）
     ├─ TH facade（getWorldbookNames(J)/getVariables/getAllVariables/generateRaw(N 前身)…）
     └─ window 阴影（J：window.top → 虚拟 parent；parent 事件三件套 → 事件总线）
```

## 4. 已知的结构债（审计与实测记录）

1. app 的 handler 表约 70 方法、service.ts ~2300 行——到了按域拆分子插件的临界点（世界书/预设/连接各可成独立插件，协议表分域）。Cordis 支持，但会动 rpc-host 的路由面，建议在 B 档收口后做。
2. `llm-openai-compat`（组合声明）与 `connection.activate`（运行时重装）是同一适配器槽的两个写入者——N 已用"不驱逐组合默认注册"的规则调和，但两者并存的事实值得在 ARCHITECTURE.md 记一笔。
3. 前端沙箱帧内的 zod/members 供给是"每 origin 一次"的微组合（preset-entry），它不是 Cordis 树的一部分，但受 `--iris-drawer-w` 同款预算闸（frame-budget）约束。
