# CORDIS-TREE — Cordis 组合树导览（详细版）

> 阅读对象：第一次接触 Cordis 的人。先讲清楚"这是什么"，再给完整的树。
> 术语表在最底部，看不懂的词随时翻它。

---

## 一、先用一个比喻说清楚 Cordis 是什么

把 Iris 宿主想成一块**插线板**：

- **Cordis 框架** = 插线板本身（带总开关、热插拔保护）
- **插件（plugin）** = 插上去的每一台电器
- **`cordis.yml`** = 写着"要插哪几台电器、每台的旋钮怎么调"的清单
- **ctx（上下文）** = 插线板给每台电器分发的**插座**。电器 A 可以往插座上"提供"一种能力（比如 llm 插件提供 `ctx.llm`——跟 AI 模型说话的能力），电器 B 在自己的清单里写 `inject: ['llm']` 声明"我需要这个能力"，Cordis 就会**等 A 就绪后才启动 B**，再把插座递给它。
- **启动顺序不是靠清单里的先后**，是靠谁声明了依赖谁，Cordis 自动算出来的。

这就是这个项目最核心的设计：**没有任何功能是焊死在程序里的**——都是插件，都能拔掉、替换、热重载，拔掉时它留下的一切（监听的端口、注册的菜单、定时器）会被 Cordis 自动回收。

---

## 二、按下启动键之后，发生了什么（时间线）

你在 `iris_harness` 目录里跑 `node apps/iris/bin.ts` 后：

```
1. bin.ts 读取环境变量（IRIS_PORT=8790、IRIS_ST_DIR=你的ST位置…）
2. 打开 apps/iris/cordis.yml，看到要装 9 个插件
3. Cordis 并发地加载它们——但每个插件会先说"我需要谁"（inject）：
     rpc 说"我需要 webserver"（我要在它的端口上挂接口）
     app 说"我需要 irisRpc、llm、webserver"（我要注册菜单、跟模型说话、挂头像路由）
   → Cordis 自动排出：webserver 先就绪 → rpc 就绪 → llm-openai-compat 和 app 就绪
4. 全部就绪后打印 "listening: http://127.0.0.1:8790"
5. 你打开浏览器 → frontend 插件把界面递给你 → 界面通过 rpc 插件和宿主说话
```

---

## 三、九个插件，各自是干什么的（按你的使用视角）

| 插件 | 干什么 | 你什么时候感受到它 |
| --- | --- | --- |
| `logger` | 日志器 | 终端里那些 `[W]` 开头的警告就是它写的 |
| `timer` | 定时器服务 | 后台各种"多久之后做某事"都找它 |
| `system-prompt` | 系统提示词注册表 | Iris 把角色人设装进去（harness 自带的那套被关掉了） |
| `llm` | **模型注册表**：谁想跟 AI 说话都从这里拿适配器 | 你每发一条消息，最终都是它发出去的 |
| `llm-openai-compat` | 一个适配器通吃所有 OpenAI 兼容端点（DeepSeek/Ollama/…） | `.env` 里配的地址和模型就是给它的 |
| `webserver` | **开门接客**：监听 8790 端口 | 你浏览器能打开 127.0.0.1:8790 就是它 |
| `rpc` | **快递系统**：把浏览器发来的请求送到该处理的插件，再把事件广播回去 | 你看到的每条回复、每个变量更新，都是它送的 |
| `app` | **大脑**：所有角色扮演的实际逻辑（后面细讲） | 你用到的几乎所有功能 |
| `frontend` | 把构建好的界面（dist 目录）发给浏览器 | 没构建界面时它会自动停用 |

---

## 四、大脑（`app` 插件）内部——你用到的功能都住在这里

`app` 插件声明 `inject: ['irisRpc', 'llm', 'webServer']`，拿到三个插座后干三件事：

### 4.1 开了一柜子"记事本"（store——每个都是独立文件，存在 `apps/iris/data/` 下）

| 记事本 | 记什么 | 对应你的操作 |
| --- | --- | --- |
| `SettingsStore`（settings.json） | 全局设置：当前激活的预设、世界书全局勾选、11 个扫描旋钮… | 设置抽屉里改的东西 |
| `PresetStore`（presets/*.json） | **预设库**：你导入/保存的每个预设一个文件 | 预设面板的列表 |
| persona store（personas.json） | **用户人格**：多个人设、当前激活的是谁 | 设置里的 Persona 区 |
| favorites store（favorites.json） | **角色收藏星标**：档案级，不写进卡 | 角色库行的 ★ |
| connections store（connections.json） | **连接配置档**：端点、模型、API key | 连接面板填的 key 和"保存这个连接" |
| `ExtensionSettingsStore`（extension-settings.json） | 扩展设置：全局正则、变量 | 正则面板 |
| `ChatStore`（chats/*.jsonl） | **所有对话**——格式和你 ST 的一模一样 | 侧栏的每个会话 |
| `WorldbookStore`（worldbooks/*.json） | **世界书**：从卡里自动播种 + 聊天级书 | 世界书面板 |

### 4.2 挂了一张"菜单"（handler 表——浏览器能点的一切）

浏览器每点一下，就发一个请求给宿主，请求长这样：`{method: 'chat.send', params: {…}}`。`app` 插件注册了约 70 个"菜名"，按域分组（本表只登记当前 HEAD 上已注册的面；在途分支的功能不列）：

| 域 | 菜名举例 | 谁实现的 |
| --- | --- | --- |
| chat.* | 发消息、继续、代我发言、重新生成、搜索、导入/导出 | `app` 插件 + `@iris/turn` + `@iris/chat` |
| character.* | 列表、导入、删除、复制、重命名、导出（PNG/JSON）、标签、收藏 | `app` + `@iris/character` |
| preset.* | 列表、切换、保存、导入文件、提示词管理器 | `app` + `@iris/preset` |
| persona.* | 人格的增删改查 | `app` 的 persona store |
| worldbook.* | 世界书七件套 + 聊天级书 + 扫描设置 | `app` + `@iris/lorebook` |
| regex.* | 全局正则的列表和整表替换 | `app` + `@iris/regex` |
| connection.* | 连接档管理、测试连接、切换（重装适配器） | `app` 的 connections store |
| script.* | 给卡脚本用的几十个酒馆助手兼容接口 | `app` 的 TH 兼容面 |

### 4.3 每个会话一台"主持人"（TurnDriver）

你点发送后发生的事，全部在树上有迹可循：

```
浏览器输入框回车
  → rpc 快递：{method:'chat.send', params:{text, kind}}
  → app 的 chat.send 处理器
      → #contributions（收集这道菜的全部配料）：
           世界书扫描（哪本书？哪些条目命中？预算内塞得下吗？）
           + persona 描述（你的人格）
           + 预设装配（你选的预设的 41 条提示词，按顺序）
           + 宏展开（{{char}}/{{user}}/{{persona}}/{{time}}…）
      → buildPrompt 组装成最终提示词
      → iris-turn 的 driver 开一个"回合"，记为候选（可以 swipe）
      → ctx.llm.stream 发给 DeepSeek
  → 模型吐字 → stream.text 事件 → rpc 快递 → 浏览器打字机效果
  → 完成 → stream.end → MVU 变量更新 → STATE 面板亮起「新/改」标记
```

---

## 五、浏览器那半边（frontend + 沙箱）也讲两句

界面本身（`ui-plugin`）也遵守同一套纪律：它向 shell 注册自己的界面渲染器（`ctx.provide('uiRenderer')`）、注册自己的清理钩子（`ctx.effect`），拔掉时一切可回收。

界面里的**侧栏面板**（世界书面板/预设面板/正则面板/Persona 面板）走的是同一个"插槽"机制：面板向 `iris.sidebar.panels` 这个插槽注册自己，壳层负责渲染。**楼层动作**（B10 接缝）同理——未来的朗读/翻译扩展也走插槽注册，没有注册就没有按钮。

**卡片的 HTML 界面**（比如政经博弈状态栏）是另一回事：它运行在一个**沙箱 iframe** 里，完全隔离。宿主把变量快照"烘焙"进它的启动文档（K2 修的就是这个时序）、供给它一套酒馆助手兼容接口（变量读写、世界书查询、zod 兼容…）。它碰不到你的页面——安全设计。

---

## 六、最近 12 项功能各自住在树的哪里

| 你见过的功能 | 住在树上哪里 |
| --- | --- |
| 预设库 + 上传导入 + 提示词管理器 | `app` 的 PresetStore + preset.* 菜单 + frontend 的 PresetPanel |
| API 连接面（key/测试连接/模型列表/9 家提供方） | `app` 的 connections store + connection.* 菜单 + `llm` 的运行时适配器重装 + ConnectionPanel |
| 世界书面板 + 聊天级书 + 扫描旋钮 | `app` 的 WorldbookStore + worldbook.* 菜单 + frontend 的 WorldbookPanel |
| 全局正则 | ExtensionSettingsStore 的 .regex 区 + regex.* 菜单 + RegexPanel |
| persona | persona store + persona.* 菜单 + 装配线的槽位与宏 |
| 聊天搜索 / 导入导出 | ChatStore 的 search/importFile/exportFile + 侧栏过滤框与菜单 |
| 宏差集（{{date}}/{{outlet}}…） | `@iris/macro` 的注册表 + 装配线的宏上下文 |
| continue/代我发言 | `chat.send` 的 kind 参数 + iris-turn driver 的新玩法 |
| 快照时序（getAllVariables 报错修复） | 沙箱帧的启动文档组装顺序（seed 提前） |
| 状态面板重设计 / 通知去重 / 细滚动条 | frontend 的 StatePanel/store/主题 token |

---

## 七、已知的结构债（诚实的部分）

1. **大脑有点胖了**：`app` 插件的菜单已约 70 个方法、service.ts 约 2300 行。Cordis 完全支持把世界书/预设/连接各自拆成独立插件——这正是你说的"各项功能作为插件注册"的彻底形态。是否拆、何时拆，等审计报告出来一起定。
2. **适配器槽有两个写入者**：`llm-openai-compat`（启动时）和连接切换（运行时）都往 `llm` 注册适配器。规则已调和（运行时的不挤掉启动的），但该在架构文档里记一笔。
3. **卡帧内部的 zod/工具供给**是帧自己的"微型插线板"，不在这棵树上，但受帧体积预算约束。

---

## 八、术语小词典

| 词 | 意思 |
| --- | --- |
| 插件（plugin） | 一段带完整生命周期的功能：有配置、能启动、能卸载、卸载时自己打扫干净 |
| ctx | Cordis 递给每个插件的"上下文"对象——上面挂着别的插件提供的服务（ctx.llm、ctx.webServer…）和自己注册清理用的工具（ctx.effect） |
| inject | 插件开头的声明："我需要这些服务才能启动"。Cordis 据此决定启动顺序 |
| handler | 一个 RPC 方法名对应的处理函数。浏览器说 `chat.send`，宿主就查表调它 |
| store | 一个只在内存和磁盘之间搬运数据的"记事本"类——不含业务判断 |
| slot（插槽） | 前端的"挂载点"：扩展可以向它注册内容，壳层负责渲染，卸载即消失 |
| srcdoc | 沙箱 iframe 的整页 HTML 内容——宿主拼好后一次性写入帧里 |
| TurnDriver | 每个会话一台的"回合主持人"：管候选（swipe）、流式、变量基线 |
