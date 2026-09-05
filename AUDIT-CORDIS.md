# AUDIT-CORDIS — 最近合入功能的 Cordis 插件逻辑审计

- **审计基准**：`dev/iris-exploration` @ `c9dfa37`（代码与审计时读到的 `fbcddde` 完全一致，两者之间只有 CORDIS-TREE.md 的改动）。
- **审计问题**：所有功能必须遵循 Cordis 插件开发逻辑、作为插件注册——本文件逐功能判定最近合入的 A–J 十项。
- **判定口径**（与仓库既有架构语言对齐，见 `ARCHITECTURE.md`、`PLAN.md` §目标架构）：
  - 在 `@iris/app-service`（或前端 `ui-plugin`）**插件内部**实现协议方法、领域逻辑放进独立包，是**既有架构，不判违规**；
  - 判违规的是：**绕过生命周期**（副作用不走 `ctx.effect`、卸载不回收）、**绕过组合根**（插件外手搓全局单例/越过 cordis.yml 装配）、**不可卸载**（移除功能后残留 handler/监听/定时器/注册）。
- **纯审计，未改任何产品代码。**

---

## 0. 总判定

**纪律遵循度：高（10 项中 7 项完全合规 ✓，2 项有缺口 △，1 项不在 HEAD ✗）。**

这批功能没有出现"绕过插件体系手搓全局状态"的违规：所有新 store 都在 `apply()` 组合根内构造、所有新 RPC handler 都在同一个 `ctx.effect` 的可逆注册表里、所有领域逻辑都落在分层正确的独立包（`@iris/macro` L0、`@iris/turn` L1）、前端资源全部走 `ctx.effect`。真正的问题集中在**两处**：

1. **唯一的生命周期违规（任务 N）**：`connection.activate` 运行时装装的 LLM 适配器，其 disposer 被存进一个**插件卸载时无人回收的普通 Map**，而注册实际落在 `llm` 插件的 fiber 上——app-service 热重载后旧路由残留，重挂载会撞 `DUPLICATE_ADAPTER`，直接违背 ARCHITECTURE.md "Everything is reversible" 与 index.ts 自己写下的"重启承诺"。
2. **配置完整性缺口（存量问题，随本批暴露）**：`pruneVariables` 的 schema 默认值 `true` 与同文件 docstring `@default false`、service 层"删数据的开关绝不能靠沉默打开"的成文立场三者在打架——这是一个**删除用户数据**的功能被 schema 默认值打开。

另有一项**文档失真**：CORDIS-TREE.md（已在 HEAD）把未合入的 B3（regex.*）与任务 P（character 复制/重命名/导出）写成已存在。

---

## 1. 逐功能判定表

图例：✓ 合规　△ 有缺口（附证据）　✗ 不在 HEAD　— 不适用

### A. 任务 M 预设库（PresetStore + preset.* 12 handler + 库目录）— **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 插件边界 | ✓ | `packages/iris-app-service/src/presets.ts:121-336`：纯文件夹 store；在组合根构造（`index.ts:523`），路径由 `profilePaths` 派生（`paths.ts:202,248` 邻位），没有插件外单例 |
| 生命周期 | ✓ | 无定时器/无监听/无防抖——所有写都是当场 `await`（`presets.ts:198`），服务实例内的 `#activePreset` 状态随实例消亡（`service.ts:372-374,436-455`） |
| 配置 | ✓ | 不需要新配置项：库目录由 profile 派生；`sillyTavernDir` 已在 schema（`index.ts:231,142`）；"未配置 ST 目录则 import 拒绝"是正确形态（`presets.ts:228-231`） |
| 可卸载性 | ✓ | 12 个 `preset.*` 全部在 handlers effect 的 disposers 数组里，逆序回收（`index.ts:628-639`，dispose 在 `672-681`） |
| 前端纪律 | ✓ | PresetPanel 是 shell 自有 React 组件（`SettingsDrawer.tsx:104`），随 `uiRenderer.mount` 的 disposer 生死（`ui-plugin.tsx:71-87`） |
| monolith | ▹ | 给 handler 表加了 12 个方法（见表 2），是拆分压力的一部分，非本项独有 |

### B. 任务 N API 连接面（connections.ts 密钥落盘 + connection.test/activate 运行时重装适配器）— **△ 一处生命周期违规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 插件边界 | ✓ | `connections.ts:139-288` 文件态 store，组合根构造（`index.ts:455`）；密钥只在宿主进程内流动、永不回传 wire（`connections.ts:120-136` 的 `toWire`、commit d382fbf 的线级测试） |
| **生命周期** | **✗** | **`index.ts:468-479`：`installConnection` 把 `ctx.llm.registerAdapter` 返回的 disposer 存进普通 `Map installed`，该 Map 只在"同路由重装"时被读（470），插件卸载时无人遍历回收。而 `registerAdapter` 的注册落在 `llm` 插件自己的 fiber（dsh-llm `lib/index.js:1177` `this.ctx.effect(...)`，`this.ctx` 是 `Service` 构造时绑定的提供方上下文），因此 app-service 卸载后适配器仍然存活。后果：热重载 app-service → 旧 `conn/<id>`（或 provider）路由残留 → 重挂载时 boot 恢复（`index.ts:484-501`）再次 `registerAdapter` 同名路由 → dsh-llm `lib/index.js:1204` 全有或全无地抛 `DUPLICATE_ADAPTER` → 插件重挂载失败。这同时违背 `ARCHITECTURE.md:67-68`（"A feature that cannot be unloaded is a bug"）和 `index.ts:480-484` 注释自许的"持久化路由是注册表必须兑现的承诺"。对照：`@iris/llm-openai-compat` 用的是正确写法——把 disposer 包进自己的 `ctx.effect`（`packages/iris-llm-openai-compat/src/index.ts:182-185`） |
| 配置 | △ | `probeTimeoutMs`（`service.ts:226-229`）只存在于 options，未浮上 Config schema——有默认值，不算绕过，属未暴露 |
| 可卸载性 | ✓/✗ | 5 个 `connection.*` handler 可逆（`index.ts:614-618`）；但运行时适配器注册不可逆（上条） |
| 前端纪律 | ✓ | ConnectionPanel 为 shell 自有组件 |

### C. 任务 L 世界书补全（worldbook-settings.ts + worldbook.create/bindChat/settings + timedWorldInfo 持久化 + 装配异步化）— **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 插件边界 | ✓ | `worldbook-settings.ts` 全是纯函数（校验/合并/翻译，107-177）；handler 在 service 表内（`service.ts:1577-1604`）；设置存进 `SettingsStore` 的 `worldbooks` 节（`settings.ts:57-61,244-268`），并与曾在 `load()` 里被整节丢掉的缺陷一起修掉（`settings.ts:127-132` 注释自证） |
| 生命周期 | ✓ | sticky/cooldown 窗口走 chat header 元数据持久化——读 `entry.ts:168-188`、写 `entry.ts:201-203`、恢复 `entry.ts:462`、每真实回合落盘 `service.ts:2355-2361`；无任何宿主侧常驻资源 |
| 配置 | ✓ | 11 个扫描旋钮是**用户运行时偏好**，放 settings.json 而非 cordis.yml——正确：部署配置与用户状态分属两个所有者；默认值取 ST 实测（`worldbook-settings.ts:60-78`） |
| 可卸载性 | ✓ | `worldbook.create/bindChat/settings/setSettings` 均在 disposers（`index.ts:665,668-670`） |
| 装配异步化 | ✓ | `#contributions` 变 async 吸收 persona/chatLore 的 await（`service.ts:2289-2345`），仍在 service（app 插件）内部，未泄漏到包层 |

### D. 任务 J 页面全局（getWorldbookNames + parent 事件通道 + module window 阴影）— **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 契约先行 | ✓ | `worldbookNames` 加在协议快照上（`packages/iris-protocol/src/views.ts:342-354`），浏览器只看契约——恰好是 ARCHITECTURE.md 规则 2 的正面示范 |
| 前端注册纪律 | ✓ | `ui-plugin.tsx:47-88`：slots（59）、store（69）、`provide('uiRenderer')`（87）三条 `ctx.effect`，卸载逆序回收；slot 声明由 shell 独占、`slots.dispose` 塌掉全部点位（`slots.ts:90-106`） |
| 事件通道可逆 | ✓ | `window-events.ts:22-36`：模块级 `Set` + 每注册返回精确 disposer；两个消费 hook 都在 cleanup 里反注册（`useMessageInterfaces.tsx:175-183`、`useCardScripts.tsx:649,677-682`），`ResizeObserver` 也 disconnect |
| window 阴影 | ✓ | `preamble.ts:37-47`：模块脚本用词法 `const window` 接 `__iris_window__`（`top`/`document` 是 LegacyUnforgeable，无法 publish——注释带实测），资源随帧销毁，无宿主残留 |
| 同步语义 | ✓ | `getWorldbookNames` 读快照而非走异步 RPC，与上游同步签名一致（`tavern-helper.ts:1754-1774`） |

### E. 任务 K3 zod 兼容（preset-entry 的 zod-compat 安装）— **✓ 合规（正确地在 Cordis 树之外）**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 边界 | ✓ | `zod-compat.ts` / `preset-entry.ts` 是**发给卡帧的静态资产**（sandbox 供给），不是宿主插件——CORDIS-TREE.md §4.3 亦如此定位；对它套 Cordis 生命周期反而是范畴错误 |
| 一次性与幂等 | ✓ | preset bundle 每 origin 求值一次；安装走原型去重（`zod-compat.ts:125-176`），`WeakSet` 防二次包裹（67,75）；在命名空间发布**之前**安装（`preset-entry.ts:101-108`），卡永远看不到破链 |
| 残留 | ✓ | 原型补丁只存在于卡帧 origin 内，帧销毁即消失；不触碰宿主页面 |

### F. 任务 B4 宏差集（iris-macro 包 + service.ts 接线）— **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 插件边界/分层 | ✓ | 宏引擎在 `packages/iris-macro`（L0，无 @iris 依赖，`ARCHITECTURE.md:13-19`）；service 只做**归因上报**（`service.ts:2704-2729`，`defaultRegistry` 仅用于判"这个残留宏是不是我们该展开的"），展开在 `prompt.ts:32` 经 `createMacroContext` |
| 生命周期 | ✓ | 纯函数，无常驻资源；未支持作用域的告警集在 entry 上、随 entry 生灭（`service.ts:2696-2703`） |
| 可卸载性 | — | 不注册任何 handler/监听 |

### G. 任务 B3 全局正则（ExtensionSettingsStore.globalRegex + regex.list/set + 活对话刷新）— **✗ 不在 HEAD（另发现文档失真）**

- `dev/feat-global-regex` **不是** HEAD 的祖先（`git merge-base --is-ancestor` 判定）；工作树中无 `globalRegex`、无 `regex.list/set` handler、无 RegexPanel。
- **但** HEAD 上的 `CORDIS-TREE.md` 把它写成已存在（c9dfa37 版第 82、125 行："regex.* 全局正则…""RegexPanel"）。这不是代码违规，是**文档声称了运行时没有的东西**——对本审计的核心问题（"功能是否以插件方式注册"）恰好是反例：一个还没注册的功能先被登记进了组合树文档。

### H. 任务 B5/S persona（persona.ts 存储 + persona.* RPC + 装配接线 + {{persona}}）— **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 插件边界 | ✓ | `persona.ts:123-293` 文件态 store，组合根构造（`index.ts:458`），路径 profile 派生（`paths.ts:204-212`） |
| 生命周期 | ✓ | 写路径全部当场 await（`persona.ts:153-156`）；`prime()` 把缓存垫在首个宏展开之前（`index.ts:517-519` + `persona.ts:280-282`），消除异步宏需求；`activeSync` 闭包惰性求值，无 TDZ 风险（`index.ts:438-443`） |
| 配置 | ✓ | 无新配置；"无 store 时装配器收不到 persona 参数、行为与从前完全一致"是显式设计（`service.ts:311-318`） |
| 可卸载性 | ✓ | 4 个 handler 在 disposers（`index.ts:624-627`） |
| 接线正确性 | ✓ | persona **每次装配现读**而非开聊时快照——切换在下一回合生效（`service.ts:1926-1938,2303,2341-2343`；`prompt.ts:217-223,339-340` 的空描述守卫复刻上游） |

### I. 任务 K2 快照时序 + B2 生成类型 — **✓ 全项合规**

| 检查项 | 判定 | 证据 |
|---|---|---|
| 快照时序（K2） | ✓ | seed 移到 bootstrap 之前（`apps/iris-web/src/sandbox/srcdoc.ts`，commit 42a6f71），顺序即契约、双侧测试钉死；资产随帧生灭 |
| 生成类型（B2） | ✓ | `chat.send` 的 kind 枚举进协议（`GENERATION_TYPE_OF` 映射 `service.ts:85-90`，分发 719-724）；continue/impersonate/recordImpersonation 全部加在**领域包** `@iris/turn`（L1）的 `TurnDriver` 上（`driver.ts:264,296,316`），generationType 随驱动传递供预设触发过滤（`service.ts:2264-2266`）——分层无一处上指 |
| 可卸载性 | ✓ | 无新 handler 之外的注册面 |

### J. 任务 P/Q — **Q ✓ 已合入且合规；P ✗ 不在 HEAD**

- **Q（动作接缝）**：f043bfd 已合入。`iris.message.actions` 以 list-slot 声明进 `SlotMap`（`slots.ts:47`），契约只命名"一类贡献"不命名功能（`message-actions.ts:1-31`）；投影折叠、零注册即零渲染；demo provider 的注册/卸载成对（`DemoActionsSection.tsx:37-56`）。ledger 本体由 `slots.dispose` 兜底（`ui-plugin.tsx:59`）。△ 一处脚注：demo 的 `let installed` 是模块级持有 disposer，shell 热重载后它指向已作废的注册、`installDemoAction` 会因此拒绝重装（`DemoActionsSection.tsx:34,40-41`）——demo 代码、影响极小，但形态上"模块级变量活得比 fiber 久"值得记一笔。
- **P（角色操作）**：**不在 HEAD**。`dev/feat-character-mgmt` 分支存在但相对 HEAD 零独有提交；无 `character.duplicate/rename/export/tags`。`character.*` 仍只有 list/import/delete（`index.ts:619-621`）。

---

## 2. Handler 表分布（monolith 评估的事实基础）

`index.ts` 中 `irisRpc.register` 共 **82 个方法**：

| 域 | 数量 | 域 | 数量 |
|---|---|---|---|
| script.*（TH 兼容面） | 24 | persona.* | 4 |
| chat.* | 16 | storage.* | 3 |
| preset.*（本批 +12 中 11 新 + importFile） | 12 | character.* | 3 |
| worldbook.*（本批 +4） | 11 | settings.* | 2 |
| connection.*（本批 +2） | 5 | prompt.itemize / debug.reports | 1 / 1 |

`service.ts` **3279 行**（本批从约 2300 行继续增长），`IrisAppService` 构造选项 20+ 个（`service.ts:165-329`）。

**判定：△ 已到临界点，尚未越界。** 单插件实现协议方法表是仓库成文架构（`ARCHITECTURE.md:121-124` 还特意保留了逐条注册的手工成本），82 个方法本身不违规；但三个信号叠加意味着下一批功能落地前应当拆：(1) script.* 兼容面独占 24 个方法（29%），它和 chat.* 生成交响在同一个类里；(2) 本批 preset/connection/persona 三家新 store 全部以"可选 options + `#xxx()` 拒绝包装"同构方式接入（`service.ts:1917-1924` 等），说明边界已经画好了，只差把边界变成插件边界；(3) CORDIS-TREE.md §4.1（fbcddde 版）自己也已记了这笔债。

---

## 3. 违规 / 缺口清单（按严重度）

1. **✗【生命周期·违规】运行时适配器安装不可逆**（任务 N）
   `packages/iris-app-service/src/index.ts:468-479`（`installed` Map 无人回收）+ dsh-llm `lib/index.js:1177`（注册在 llm fiber）+ `lib/index.js:1204`（重挂载撞 DUPLICATE_ADAPTER）。违背 `ARCHITECTURE.md:67-68` 与 `index.ts:480-484` 的重启承诺。仓库内已有正确样板：`packages/iris-llm-openai-compat/src/index.ts:182-185`。
2. **△【配置·完整性】pruneVariables 三处自相矛盾，且默认打开"删数据"**
   `index.ts:203` docstring `@default false` vs `index.ts:246` schema `.default(true)`；`service.ts:292-299` 成文立场"删除用户数据的开关必须经决定选入，绝不能经沉默打开"；`apps/iris/cordis.yml` 以 `!== "false"` 使部署默认落在 ON。schema 会验证配置（这一点合规），但 schema 的**默认值**本身越过了自家红线。属存量、非本批引入，但 preset/connection 等本批功能照抄了"settings.json 分节"的谨慎，唯独这里反着写，故列入。
3. **△【文档·失真】CORDIS-TREE.md 声称了 HEAD 上不存在的功能**
   c9dfa37 版第 82、125 行（regex.* / RegexPanel，即未合入的 B3）、第 78 行（character.* 复制/重命名/导出，即未合入的任务 P）。组合树文档的正确性是"什么注册了"的台账；把在途分支写成存量会让下一次审计/回归以错误基线出发。
4. **△【生命周期·不对称】ScriptVariableStore 卸载时无 flush**
   同为防抖/链式写 store，`cardStorage.flush()` 在 dispose 里被调（`index.ts:674-680`），`script-variables.ts` 的 `#flush` 链没有对应回收点。因卸载不杀进程、在飞 write 会完成，实际风险低；不对称本身是债。
5. **△【前端·脚注】demo action 的模块级 `installed` 跨 fiber 存活**
   `DemoActionsSection.tsx:34,40-41`：shell 热重载后拒绝重装。仅 demo 受影响。
6. **【范围核实】两项审计对象不在 HEAD**：B3 全局正则（分支未合）、任务 P（分支空挂）。**任务 N 的密钥面本身合规**：写只读合并（`connections.ts:216-222`）、`hasKey`+尾四字符投影（120-136）、probe 不回显密钥（`service.ts:509-586`）。

---

## 4. 修复建议

### 必须修（下一个合并窗口内）
- **适配器安装收编进 ctx 生命周期**（缺口 1）：`installConnection` 内把每次注册改为
  `ctx.effect(() => ctx.llm.registerAdapter([route], adapter), `irisApp: adapter ${route}`)`
  （fiber 自动回收、逆序、热重载自愈），`installed` Map 只留 `route → disposer` 做替换用；或至少在 handlers effect 的 cleanup 里 `for (const d of installed.values()) d()`。
  配一个热重载测试：activate 一个带 baseURL 的 profile → 卸载/重挂 app fiber → 断言路由仍解析且无 `DUPLICATE_ADAPTER`。这与 ARCHITECTURE.md"app 行可独立卸载重挂而不掉 socket"的既有承诺配平。
- **pruneVariables schema 默认改 `false`**（缺口 2）：一行（`index.ts:246`），让 schema、docstring、service 立场三方对齐；cordis.yml 的 env 开关保留显式选入。

### 应该修（随手）
- **CORDIS-TREE.md 校正基线**（缺口 3）：把 B3/任务 P 条目标注"在途（分支名）"或移除；建议给该文档加一行"只登记 HEAD 上已注册的面"。
- **ScriptVariableStore 补 dispose flush**（缺口 4），与 cardStorage 对称。
- **`probeTimeoutMs` 浮上 Config schema**（B 项配置小缺口），或明记"有意不暴露"。

### 到了该做的那一刀（结构性，不急但别再拖）
- **按域拆子插件**：worldbook / preset / connection(+persona) / script-compat 各自成 `@iris/app-service` 的兄弟行或子插件，各自 `inject: ['irisRpc', ...]` 并自带 handler 注册。本批代码已经把 store 边界画好（每个 store 一个文件、一个 profile 路径、一个 `#xxx()` 拒绝包装），拆分的机械工作主要是把 handler 表按 `service.ts` 里已有的域注释切开。协议面不动（rpc-host 按方法路由，与插件数无关）。**触发条件建议**：script.* 面再扩、或下一个新域落地时执行，而不是现在为拆而拆。
- **CORDIS-TREE.md 作为台账的验证脚本**（可选）：对照 `index.ts` 的 register 列表 diff 文档表格，防缺口 3 复发。

### 现状即正确（不要动）
- preset 库、persona、worldbook settings、timedWorldInfo、生成类型、宏归因：全部"store 在组合根 + 写当场 await + handler 在可逆表 + 领域逻辑在 L0/L1 包"的标准形态。
- 前端：`ui-plugin.tsx` 三条 `ctx.effect`、slot 由 shell 独占声明、模块级 holder（window-events/card-bus/shared-snapshot）配 per-registration disposer——这是成文且被测试钉住的既有纪律。
- zod-compat / srcdoc 快照：卡帧资产，本来就在 Cordis 树之外，一次性安装 + 帧销毁即清。

---

## 5. 结语

对项目所有者核心质疑的直接回答：**这批功能没有绕开 Cordis**——没有插件外的全局单例、没有绕过组合根的装配、没有不可卸载的 handler 面。唯一的真违规是任务 N 的运行时适配器把"可逆"丢了半截：注册走了插件通道，回收没有跟上。它是本批十项里唯一需要"修"而非"记"的代码缺陷；其余两个缺口（schema 默认值、文档台账）是纪律层面的对齐工作。
