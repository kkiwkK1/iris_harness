# DEVIATIONS — 任务 M：预设功能补全（对照 ST 1.18.0，机制层实现）

分支 `dev/feat-preset`。对照装置：`E:/sillyTavern/SillyTavern`（1.18.0，
`public/scripts/PromptManager.js`、`public/scripts/openai.js`、
`src/endpoints/presets.js`）。每一条偏离都写明上游的做法与本侧的选择。

## 储存与命名

1. **库目录名 `presets/`，不是上游的 `OpenAI Settings/`。**
   上游把 Chat Completion 预设存进 `data/<user>/OpenAI Settings/`——这个名字在
   本侧会与 `settings.json` 在读者心里相撞，且它是误称（里面是提示词预设）。
   文件**名**逐字保留（含中文、空格、括号——实测安装 18 个名字里 13 个会在
   `toId` 下变形，故不做任何归一化），`sanitizePresetName` 对齐上游
   `sanitize-filename` 的字符类，导入回上游目录不需要重命名。

2. **导入对库内同名预设是覆盖，不是跳过。**
   上游导入 UI 的语义相同（同 ID 提示词被覆盖）。一个已经存在的旧副本若让
   "导入"变成"有时导入"，来源就不会再是事实源。只读方向不变：导入读装置，
   从不写装置。

## 切换与设置层

3. **切换应用的标量只有本宿主会行动的那几个键**（temperature、
   `openai_max_tokens`、`openai_max_context`、top_p/top_k/min_p、三惩罚、
   seed、`reasoning_effort`），不是上游 `settingsToUpdate` 的 102 键覆盖表。
   其余键本宿主没有行为可施加，写进设置层只会制造看起来存在、实际不存在的
   开关。垃圾值跳过不拒绝——上游同样能带着 `"temperature": "high"` 完成切换。

4. **标量落在 global 层，chat 层的显式覆盖在切换后存活。**
   上游是单一平面设置空间，切换覆盖一切；本侧有分层，一个对话单独调过的
   temperature 是显式决定，不应被一次切换抹掉。

5. **`openai_max_context` 成为 `GenerationSettings.contextWindow`（预设域）。**
   装配预算随切换走（实测真预设：4095 / 655 350 / 1 000 000 / 2 000 000）。
   上游单一空间里这自然发生；本侧不把窗口写死在组合里，否则为 4 095 调的
   预设会安静地裁掉对话的另一头。

6. **`reasoning_effort: 'auto'` 不上线。** 上游把它发给提供方
   （openai.js 直传）；各家对这个词分歧不一，"不发送字段"是唯一所有
   OpenAI 兼容端都接受的拼写。`auto` 只存在于客户端语义里。

## 提示词管理器

7. **开关/删除规则照抄上游（PromptManager.js）：** 强制开关清单
   （`isPromptToggleAllowed`）与 `system_prompt` 不可删（`isPromptDeletionAllowed`）
   逐字镜像；清单外的 marker 无开关，拒绝而不是静默无效。

8. **新加提示词落在队尾且启用**（上游追加为禁用，靠渲染层再对齐——可见结果
   一致，本侧省掉那层折算）。**新建**撞上内置槽位标识符按名拒绝；对**已在**
   预设中的提示词就地编辑不拒（上游的编辑表单也允许改 main 的内容）。

9. **视图排序：有位次的按 `prompt_order`，无位次的按文件序排在后面。**
   装配器对"不在序中"的读取是关闭，视图如实显示为关；`preset.move` 对序中
   缺员的提示词做修复性补挂（落到队尾、关闭态），不拒绝。

10. **交互控件是勾选框加 ↑/↓ 按钮，不是上游 Sortable 的拖拽。**
    顺序、开关、增删的机制语义全部一致，只有拖动手势换成了按钮。

## 界面

11. **库是行列表，不是上游的下拉框。** 每行：名称 / 使用 / 导出 / 删除；
    行内不弹确认对话框（与连接面板同例——真预设可随时从装置重新导入）。
    另有"存为预设"命名行。所有新文案走 i18n（`strings.ts` en/zh 双份，
    `i18n.test.ts` 的键齐性守卫自动覆盖）；跳过原因句子来自宿主，按
    STRINGS.md 的既定方针保留英文原文。

12. **导入行只在宿主配置了 `sillyTavernDir` 时存在**（`install === undefined`
    即"没有装置"，不给一个永远回答"无"的按钮）；提供"全部导入"加逐条跳过
    原因的行内清单，不做逐名勾选。**导出**是 `preset.read` 加浏览器端下载，
    文件按上游的四空进缩进序列化——导出的文件放回上游不显示为整文件 diff。

13. **宿主没有预设库时整节不渲染**（种子页的假客户端对 `preset.*` 一律按
    `unsupported` 拒绝——假客户端没有文件系统，拒绝比假装有库诚实）。面板把
    拒绝读作"此宿主无此功能"而不是"没有预设"。

14. **设置抽屉在"更多参数"里补了上下文窗口与推理力度两个读数**，因为预设
    切换会一次改写它们——切换改变的东西若不可见，等于安静地改。

## 组合与接线

15. **`cordis.yml` 新增 `sillyTavernDir: IRIS_ST_DIR` 透传。** 插件选项早已
    存在（worldbook 物化在用），但组合行从未读过环境变量，不改 yml 就无法
    打开导入。默认仍不设置、不猜测。

16. **启动顺序：存储的选择优先于组合的 `presetPath`。** 用户换过或编辑过
    预设后，状态在 settings 店里持久（`preset: { name?, body }` 段），重启
    读回——重启后弹回配置文件会让选择器变成一个宿主会遗忘的偏好。从未切换
    过的宿主该段不存在，配置驱动的宿主保持配置驱动。删除活动预设后状态
    仍在内存与盘中但**无名**——它不再是一个库预设，这是如实状态。

## 继承自上一会话的修复（接手时未提交、不可编译）

17. 接手时的工作树带 5 个类型错与 2 个逻辑缺陷，均已修复：
    `#installPresets()` 未 await（Promise 恒真值，响应永远声称有装置且序列化
    为空表）；`settings.#validatedPreset` 误标 async（preset 段落进 Promise）；
    `exactOptionalPropertyTypes` 下的四处形状错误；构造函数合并残行。

## 剩余队列

- 连接面板尚未暴露 profile 的 `preset` 绑定字段（后端 `connection.save`/
  `connection.activate` 已按上游 `bind_preset_to_connection` 生效）。
- 提示词管理器无内容编辑表单（`preset.upsertPrompt` 已在协议层支持全部字段）。
- 装置侧逐名导入的勾选界面；`Antennae` 等真实预设的更多字段映射（sampler
  order 等本宿主暂无行为可施加的键）。
- 六卡 QA 覆盖"切换预设后装配"尚在 wt-qa 队列之外。

---

# DEVIATIONS — A3：聊天导入/导出（ST 迁移路径）

分支 `dev/feat-chat-transfer`。对照上游 `/api/chats/import|export`
（`src/endpoints/chats.js:604,696`）。RPC 为 `chat.import`/`chat.export`，
壳侧入口在 Sidebar（角色行菜单导入、聊天行菜单导出、分支行缩进归父）。

## 范围

18. **导入只收 SillyTavern JSONL 一种方言，且写入前整体校验、按名拒绝。**
    上游同一端点还转换 Kobold Lite / CAI / oobabooga / Agnai / Risu 五种 JSON
    方言，并把导入文件改名为 `<角色> - <时间> imported.jsonl`。本侧只走迁移
    主路径：文件名词干保留为 chatId（分支的 `chat_metadata.main_chat` 正是按
    文件名词干指向父聊天，改名即断链），五种方言与坏文件在写盘**之前**按名
    拒绝（"缺少 `chat_metadata` 对象"这类具名错误），绝不半导入。聊天方言
    转换与清单 B9（世界书方言）同构，量语料后再立项。

19. **导出保留头行里的 `iris` 块。** 上游对头行未知键原样忽略；剥掉它只会
    让 Iris 自己的导出变有损。`chat_metadata`（含 `integrity`、`main_chat`）
    逐字保留——实测 ST 重导入后继续对话并保存，完整性校验（`force: false`）
    原本就过，因为校验比对的正是这块的逐字保真。

## 与上游不同但有意为之

20. **重新导入 Iris 导出的文件时，标题与最后活跃时间从 `iris` 块继承，不再
    重置为文件词干与到达时刻；`parentChatId` 则刻意丢弃**——谱系一律从
    `chat_metadata.main_chat` 重新解析（`list()` 已有此机制，与导入顺序无
    关），别的店里带过来的陈旧 id 不许错 link 到它并不指名的对话。

21. **导出对坏行的两处规范化，均为持久层既有行为、有报告、不新增：** 某些
    真实行带越界 `swipe_id`（如 `swipes` 仅 1 条却写 `swipe_id: 1`），导出按
    实存 swipe 归位为 0；每楼变量表多于实存 swipe 时多余表丢弃并报告
    （`hydrateVariables` 文档早已实测此形）。除此之外逐字段等价，包括
    逐楼 `name`、`extra`、`send_date`。

## 随 A3 修复的持久层缺陷（不改则验收不成立）

22. **`importChat` 对"以角色开场白开头的文件"漏发 `turn/start`。** 真实
    ST 聊天通常第一楼就是开场白（assistant 行），旧代码只给 user 行发
    `turn/start`，恢复出的会话 `lastTurn === -1`——用户导入后发出的第一句话
    会再次打开"回合 0"，回复被追加进开场白的 swipe 列表（实测：导出后一个
    楼变成三词条 swipe 列表、产生它的那轮对话消失）。现在每个回合必有一次
    `turn/start`，无论该回合以哪种行开头。

23. **逐楼 `name` 改为携带字段（移出 `MODELLED_KEYS`）。** 实测本机 31 个
    真实聊天，大量文件头行的 `user_name`/`character_name` 是字面 `"unused"`，
    真实说话人名在每楼的 `name` 里（部分 user 行甚至是用户自扮的角色名）。
    旧投影每楼 name 都从头行重导出，一次会话往返就把全楼说话人改写掉。现在
    `name` 与 `extra`/`send_date` 同等对待：楼里带的逐字携带，头行名只作
    本宿主新建行的回退。

---

# DEVIATIONS — 任务 N：API 连接面（密钥、测试连接、模型列表、提供方预置）

分支 `dev/feat-connection-ui`。用户点名需求：连接设置区要有 ①填 key 的地方
②测试连接按钮 ③拉取 /models 的模型列表，且提供方不允许手填裸字符串。
本节第 24 条**推翻既有裁定**，其余为该推翻落地时的边界决定。

## 密钥存储（推翻旧裁定）

24. **连接密钥随配置档明文落盘（`connections.json`，data 目录内、gitignored），
推翻 IMPLEMENTATION-CHECKLIST §"如需 UI 化，走宿主内存 + 不落盘（不提供 ST
的 secrets 端点）"与 ST-COMPARE 10.3 "config 注入凭据，不落明文" 的立场。**
    旧立场的场景是"配置由谁完成"——`.env`/cordis.yml 由装机器写，普通用户
    无法自助，这正是本任务要打开的面。用户在表单里填 key，就必须有地方放，
    否则每次重启都要重新填，"重启宿主密钥仍生效"无从谈起。上游 ST 的
    `secrets.json`（明文、全套 view/read/write 端点）仍是反例：本侧**不提供
    任何读取密钥的端点**，差异在传输边界而非磁盘：
    - `connection.save` 的 `apiKey` 是 write-only——任何 RPC 永不回显，读取只答
      `hasKey: true` + 尾四位（不足 8 字符的 key 连尾四位都不给，四字符足以
      暴露短 key 全文）；
    - 缺省 = 保留（编辑表单没有 key 可回填，把缺省当清除会静默缴械），
      空串 = 显式清除；
    - 日志与报告只写端点 origin，从不写 key（`#installConnectionFor`、
      `#probeEndpoint` 的错误消息均不携带凭据）；
    - rpc-transport 有实测断言：真实 HTTP 帧上 `connection.list` 的响应体不含
      密钥明文或其片段。
    这不是"secrets 端点"的重开：ST 泄漏在**接口**（view/secrets 全套），本侧
    把密钥当作 store 的私有字段，接口只描述不携带。

## 提供方预置

25. **提供方是预置档案（DeepSeek/OpenAI/OpenRouter/Anthropic/Gemini/Ollama/
    llama.cpp/LM Studio + 自定义），不是自由文本。** 一个提供方是端点、凭据
    惯例与默认 header 的组合，裸字符串正是"名为 deepseek 实指 Gemini"漂移的
    起点。选中即填 baseURL；Ollama/llama.cpp/LM Studio 三个本地端点标注
    "无需密钥"，表单对它们不渲染 key 输入框。预置表定义在协议包
    （`providers.ts`），宿主与界面共用一份，`connection.test` 以它判断
    "此端点必须有 key"从而在出网之前报 `missing-key`。

26. **Anthropic 预置的凭据走 `x-api-key` 裸值头。** `apiKeyHeader` 缺省即
    OpenAI 兼容惯例 `Authorization: Bearer`；换名头时值不再加 Bearer 前缀。
    同一条规则在 LLM 适配器（`credentialOf`）与探针（`#probeEndpoint`）各实现
    一次、行为一致，测试连接通过的端点就是对話能过认证的端点。

## 连接档与路由

27. **带自有端点的 profile 激活时在运行时安装适配器，路由取 profile 的
    provider 名；`provider: 'default'` 例外地派生为 `conn/<id>`。** `default`
    路由属于组合里 `llm-openai-compat` 行自己的注册，激活不拥有也不许驱逐它。
    同 provider 的两个 profile 交替启用 = 替换注册（dispose 后重装），在途
    流持有旧适配器对象自然跑完。开机时按 activeId 恢复安装，重启宿主后
    settings.json 里持久化的路由名在第一个回合就能兑现。

28. **`connection.test` 对"失败"以结果而非错误作答**（`{ok:false, error:{code,
    message}}`），具名错误各有其义：`missing-key`（出网前拦截）、`unauthorized`
    （401/403）、`timeout`、`network`、`http-error`、`bad-response`、
    `no-endpoint`（无自有端点的旧档诚实自报）。探针优先 `GET /models`，OpenAI
    形状之外顺带接受 Ollama 原生 `{models:[{name}]}`；模型列表也可手填，因为
    自建端点未必实现 /models。

29. **假客户端对 `connection.test` 诚实拒绝**（unsupported："fake client cannot
    reach a real endpoint"）：该方法存在的意义就是把请求放到真网络上，伪造
    延迟或错误码会让连接表单在开发期学到一个没有任何端点给过的结论。

# DEVIATIONS — 任务 T：宽屏整体布局修正（重心、留白与抽屉几何）

分支 `dev/fix-widescreen`（基于 dev/iris-exploration d31f0a3）。验证装置：
headless Chrome/CDP，1920×1080 与 2400×1200 两档 + 1280×800 窄档，
测量脚本 `apps/../qa/verify-widescreen.mjs`（宿主端口 8816）。

1. **抽屉打开时 aside（STATE）整体让位，而非挤压随行。** 任务书裁定"抽屉打开时
   布局重新居中"，但未规定此刻 aside 的去留。若让 aside 留在书页与抽屉左缘的
   余量里，1920 窗口下该轨道只剩 108px（内容 52px），状态列等于报废。故
   `iris-shell--drawer-open` 期间 `display:none`，关抽屉即恢复——抽屉占据的
   本来就是 margin 的地盘。若后续想让 aside 在超宽窗口（如 2400，轨道 348px）
   抽屉开时仍然可见，需要一条按宽度分档的规则，本任务不做。

2. **阅读列中线与输入框中线存在 42px 系统偏差——实测为既有几何，非本任务回归。**
   同一脚本对未修改基线（stash 后重建 dist）测量：抽屉开居中偏差 196.5px（即
   用户报告的 bug）、中线偏差 42px；修复后居中偏差 0.5px、中线偏差仍为 42px，
   两档宽视口数字逐位相同。来源是 composer 内层的非对称 `padding-left:46px`
   （右无对应内边距，把输入框推右 23px）加 scrollbar-gutter 预留的一半宽度
   （~8.5px），属任务书范围外，未动。

3. **验证侧细节：** headless 环境里 Escape 关不掉抽屉（drawer 的 Escape 处理
   挂在元素 keydown 上，无焦点不触发），脚本改点抽屉头部的关闭按钮；测量读
   `getBoundingClientRect`，居中判据为"书页中线 vs（侧栏右缘+可视右缘）/2"，
   修复后 1920/2400 两档关、开四态偏差 0 / 0.5px（红线 <8px）。
---

# DEVIATIONS — 任务 Q：楼层动作接缝（B10 第一期）

分支 `dev/feat-action-seam`。只做接缝不做 provider；demo provider 是接缝的
活样例与测试夹具，不是功能。

30. **demo provider 的开关放在正式设置抽屉里（`DemoActionsSection`），不是
    dev-only 探针。** 接缝的验收红线（无 provider 零残渣；注册后按钮出现、
    点击回调到达、卸载即消失）要求在 production build 里可观察，而
    `import.meta.env.DEV` 门控的探针在 production 构建中被静态替换成 false、
    整段死亡——等于验收只在 dev 模式下成立。该 section 因此做成可见、明确
    标注"演示"的一节；它不是 feature：除 `registerMessageAction` 外不触碰
    任何 surface，卸载即还空（宿主实测 06 号截图可证）。


---

# DEVIATIONS — 任务 S：Persona 用户人格（B5）

分支 `dev/feat-persona`。对照装置：`E:/sillyTavern/SillyTavern`
（`public/scripts/personas.js`、`public/script.js`、`public/scripts/openai.js`、
`public/scripts/world-info.js`）。前任代理中断后的未提交工作由本任接手核实、
补齐并提交；以下条目含两任的决定，均已按上游真值核实。

1. **RPC 组是 `persona.list/get/set/delete` 四键，不是任务书的三个。**
   任务书写 `persona.get/set/list`；列表管理面板必然要删（上游 persona 面板
   同样有删除），少一个 delete 键等于 UI 只能增不能删。多出的键不引入新语义：
   删除激活中的人格即清空激活（上游删 avatar 同样落空选中）。

2. **位置词只收 `inprompt` / `atdepth` / `none`，拒绝 `topan` / `bottoman`。**
   上游 `parsePersonaPosition`（personas.js:1963）五个词全收；后两个把描述
   并进作者注释，而本宿主不装配作者注释（AN 桶只装世界书条目），收下就是
   存一个无人能执行的位置。边界按名拒绝，不静默忽略。

3. **`{{persona}}` 宏吃 trim，槽位与深度注入吃原文——两处读法分开（接手修正）。**
   上游宏环境是 `persona_description?.trim()`（script.js:3352），而 Chat
   Completion 槽位（openai.js:1424）和深度注入（script.js:3164）取存储原文。
   接手前的实现对宏也不 trim；已改为一致并由测试钉住
   （persona.test.ts 的 "the macro trims the description…"）。

4. **世界书条目扫描字段加 `extensions.<snake_case>` 兜底读取。**
   上游装载转换表（world-info.js:2601-2639）从 `extensions` 读这批字段，ST
   自己写书时也嵌在 extensions 里；实测装置的书全部只带嵌套形式。顶层
   camelCase 仍在时优先——只有"仅嵌套"的书（即全部真书）原先会被静默读成
   默认值。这是 persona 之外的行为修正，全套测试绿可证无殃及。

5. **persona 存储独立成 `personas.json`，不进 `settings.json`。**
   与 connections 同理：settings 是对话正在用什么，persona 是用户说自己是谁，
   重置其一不得清空另一。上游把等价物放在 `power_user` 里随其 settings.json
   走；拆分是本侧的，语义是上游的（激活描述为空视为无人格——上游每个读取点
   都有 `if (!power_user.persona_description …)` 守卫，这是默认零变化红线的
   一半；另一半是 store 缺席时装配器收不到 persona 入参）。

6. **激活是显式的：`active: true` 是唯一开关。** 编辑人格不带 `active`
   不会顺带激活它（"存在即激活"会让每次改名都抢走当前人格）；面板里列表行
   的点按才发 `active: true`，与上游把切换放在 persona 列表行是同一个决定。

7. **假客户端对 persona 组按组诚实拒绝。** fake 客户端不装配提示词，persona
   的全部效果都在装配层；答一个空列表会被读成"已配置、还没有"，邀请出一个
   写了也白写的面板。按组抛 `unsupported`，指名无真话可答。

8. **reads-do-not-write 夹具落了真人格（接手补齐）。** `persona.list/get`
   加入 READS 时夹具原无 persona store——拒绝路径也能过对比，但那是绕过而非
   检查。夹具现 seed 一条激活人格，两个读做真读，personas.json 进磁盘快照。

9. **验收脚本落在 `qa/persona-acceptance.mjs`（接手改形）。** 起初是
   apps/iris 下的进程内 boot 草稿；按 qa/ 目录惯例改为 spawn
   `apps/iris/bin.ts` 独立宿主进程（记录 PID、只按 PID 停止），走产品自己的
   cordis.yml，对 mock 提供方断言真实请求体：IN_PROMPT 槽位、`{{persona}}`
   展开、啊不吃世界书 uid 4 践踏条的副键（身体）由人格描述触发、清空后请求
   逐字回原。四项全过。

---

# DEVIATIONS — 任务 R：设置面扩容 + 凭据安全声明（B6 + B11）

分支 `dev/feat-settings`（基于主线 e233eaf，已并入）。验证装置：8814 独立宿主
（数据目录隔离、按记录 PID 管理）+ headless Chrome/CDP（`qa/r-cards-check.mjs`，
23 项断言）+ 8814 上的逐键 RPC 往返断言（15 项）+ `node --test` 全绿。

1. **接手即修正：`continue_postfix` 此前只落在拼回文本，未进请求。** 前任代理的
   WIP（632700e）把分隔符加在被续写文本之后拼出候选，但发给模型的请求里最后一条
   assistant 消息不带分隔符——上游在构建提示前把它追加到 `cyclePrompt`
   （`script.js:4917-4921`，含「已以空格结尾则不加」守卫）。已在 `TurnDriver`
   补上请求侧：postfix 加到最后一条 assistant 消息（nudge 豁免），守卫同上游，
   并以 driver + service 两层测试钉住（请求文本含分隔符、candidate 拼回含分隔符、
   尾随空格不叠加）。

2. **IA 十组中，#8（我是谁）与 #10（文本补全格式化）不在本任务落键。** #8 的宿主
   侧人格面由 wt-persona 任务承建，此处不重复造键（纪律：不碰其他 worktree）；
   #10 按 SETTINGS.md §十项 #10 的裁定**主动不建**——Chat Completion 路线上那
   6 次改动全部无效，建一个零效果的面板比不建更糟。其余八组各有键落地，其中三组
   是本任务新落：回复形态三键（trim/postfix/squash，消费者分别是入库前裁剪、
   continue 请求+拼回+流式显示、装配层相邻系统注入合并）、楼层号
   （`mesIDDisplay_enabled` 的每设备等价物，消费点是消息行页边的 CSS 门控显示，
   宪章量到该用户手动开启过）、启动自动打开（消费点是 store.boot 的重开最近对话，
   原先无条件，现受键控）。

3. **诊断面板（HostReports / NoticeLog）不折叠。** 任务书第 0 条说「各分区改为
   折叠卡」，但抽屉自己的设计注释写明：诊断在「出错时更值得读」，把诊断折叠进卡
   恰恰是「出事时藏起诊断」的形状。故 HostReports / NoticeLog / DemoActions 保持
   常开原样，折叠卡只覆盖设置类分区（连接/预设/路由/采样/回复/阅读/世界书/脚本/
   通用与关于，九卡；脚本卡仅在有打开对话时存在，面板本身无对话时返回 null）。

4. **导出文件永不携带凭据，导入的连接配置档无键。** `connection.list` 本就不回显
   密钥（只有 hasKey + 末四位），导出的 connections 是无凭据字段的投影（结构上
   无处可藏，而非逐个 delete）；导入按上游同款语义恢复为**无键**配置档并在界面上
   明说「请逐个重新输入」。格式（`iris.settings/1`：scope/device/generation/
   worldbook/connections）记录在 `settings-transfer.ts` 头注，逐键往返有测试。
   凭据声明落在设置抽屉「通用与关于」卡（两句：宿主持有、RPC 不回显、页面不滞留；
   传输由宿主发起，边界由 rpc-transport 测试钉住），此处即 B11 的界面落点。

5. **折叠卡状态曾按「挂载时快照」保存，会互相覆盖——改为保存时重读合并。** 验收
   中发现：同一次开抽屉里先后折叠两张卡，先折叠的记录被后折叠的覆盖（各卡各存各
   的挂载快照）。`CollapsibleSection` 的 toggle 现在保存前重读 `localStorage`
   合并，跨卡与跨刷新记忆均有 CDP 断言（`qa/r-cards-check.mjs` 已入库，截图在
   `qa/results/r-cards/`）。

6. **取舍清单（没上的键及理由）**：发送/生成延迟类（任务书明说不需要）；字体缩放
   （阅读偏好已有字号，跳过）；消息气泡样式（本产品的阅读面刻意无气泡，见
   `Message.tsx` 头注，加气泡是美术语言决定不是设置键）；ST 的
   `auto_connect`（对齐为「启动自动打开最近对话」，见第 2 条）；世界书扫描参数、
   预设管理、提示词装配只读面等已在上个任务落地（WorldbookPanel / PresetPanel），
   本任务只把它们的分区改挂折叠卡。新暴露的宿主设置键共三个（trimSentences /
   continuePostfix / squashSystemMessages），全部有真实消费者与往返测试；文档
   （STRINGS.md）只登记了实际暴露的键。

# DEVIATIONS — 任务 P：角色管理操作（C15 + C16）

分支 `dev/feat-character-mgmt`。对照装置：`E:/sillyTavern/SillyTavern`
（`src/endpoints/characters.js` 的 `/rename`、`/duplicate`、`/export` 三个端点，
逐行读过才动手）。机制层照上游真值，形状差异逐条记录如下。

## 重命名（character.rename）

1. **改名不动 id，也不动文件名。** 上游 `/rename` 把新名字写进卡片的**同时**
   重命名头像文件、迁移 chats 目录——因为上游的 id 就是文件名，聊天按角色分
   目录存。Iris 的 id 承重远超文件名：世界书物化绑定表（`worldbook-bindings.json`
   按 characterId 键控）、每个聊天头、脚本策略、卡存储归属（新的收藏也是）都
   挂在它上面，挪 id 意味着一次性重写这五处且没有一处是原子的。故本侧只改
   `data.name` 与 V1 镜像 `name`（照抄上游 `_.set` 双写），id 与文件名原地不动。
   验收「重命名不断绑定」因此在结构上成立而非靠迁移补丁。
2. **绑定名（`extensions.world`）一字不动。** `worldbooks.ts` 的既裁定：绑定是
   **书名**，verbatim 使用（13/18 在 `toId` 下会变形），从不从角色名派生——上游
   改名同样不碰它。实测卡（哈人冰恋世界，绑定 `哈人冰恋世界v2.0`，107 条内嵌书）
   改名后 `worldbook.charNames` 仍返回原绑定、书文件仍是那一个、107 条目不变。
3. **写入是外科手术式的，不是重新编码。** 上游导出走 `mutateJsonString` 只改
   tEXt 里的 JSON；重命名/标签沿用同一机制（新增 `@iris/character` 的
   `mutateCardPng`：chara 与 ccv3 两个卡块都改，图的像素与其他块逐字节保留）。
   重新编码虽然能过测，但会让一次改名顺手重排卡里它不认识的字段——那是带观点
   的改名。`.json` 卡同理：原地改 JSON、其余键逐键保留（`create_date`、
   `x_custom` 等有测试钉住），紧缩写出与上游写卡的格式一致。
4. **纯图片（JPEG/无卡 PNG）改名拒绝** `unsupported`，而不是静默成功——名字无处
   可写，谎报成功会让列表继续显示旧名。

## 复制（character.duplicate）

5. **逐字节复制（`copyFileSync` 语义），不重编码、不改任何字段。** 上游
   `/duplicate` 就是这一行。聊天不复制（任务书明说）。新 id 从**源 id** 经
   `toId` 归一（顺带限长）后按既有 `-2` 约定递进，而不是从显示名派生——文件
   才是身份，改名后副本 id 不漂移。
6. **副本复制绑定表行，与源共享同一本物化书。** 上游副本逐字节携带同一个
   `extensions.world` 名 → 两张卡绑**同一本**书。Iris 的解析走绑定表（按
   characterId 键控），若不复制行，副本首次开聊会把内嵌书再物化成
   `哈人冰恋世界v2.0 (2)`——上游共享一本书的语义在本侧悄悄变成两本各自漂移的
   书。实测：复制后 worlds 目录仍只有一个文件，副本开新聊天成功。

## 导出（character.export）

7. **PNG 导出逐块外科手术 + 上游 `unsetPrivateFields`（`characters.js:498`）**：
   `fav` 两种拼写清零、顶层 `chat` 指针删除，其余逐字段保留；`.json` 卡四空格
   缩进输出（对齐上游 JSON 臂）。Iris 自己从不写这两个字段，但从 ST 导入的卡
   可能带着——照上游清掉，因为那是运行态，不该跟着卡走到别人的安装里。
8. **JSON 导出不做 getCharaCardV2 升格。** 上游 JSON 臂先把卡转成规范 V2；本侧
   导出**存储形状**——V3 卡出去还是 V3，未知字段原样随行。升格会替用户的卡做
   一次单向迁移，导出没有这个授权。重导入逐字段等价有实测（8812 实宿 +
   character-ops 测试组）。
9. **格式与文件不符的导出拒绝**：`.json` 卡导 PNG `unsupported`（没有像素可写
   块）；纯图片导出 `unsupported`（没有卡可导）。上游对应情形是 500/400，本侧
   给出点名原因的 refusal。

## 收藏（character.favorite）与档案级存储

10. **星标不写卡，与上游 `fav` 刻意分道。** 上游把收藏写进 `data.extensions.fav`
    随卡分发，所以导出端点才需要 `unsetPrivateFields` 把它再剥掉。本侧按「运行
    态不进共享卡文件」的既裁定落在档案级 `favorites.json`（与 personas/
    connections 同一套 owner 分离理由），键控 characterId；删卡即遗忘（id 复用
    不继承，与脚本策略同款）。导出天然干净，不需要本侧的 unset 之外的动作。
    前端星标开关乐观更新 + 宿主回读校验，标签过滤/排序/收藏全部客户端即时生效
    （列表已在 store 里，一次过滤不值得一个往返）。

## 验收与遗留

11. **实测**（`qa/character-ops-acceptance.mjs`，8812 实宿，哈人冰恋 1_5.png）：
    改名后绑定/书/107 条目原样、复制共享书且可开新聊、导出 PNG 块 JSON 与存储
    卡 deepEqual、标签写回卡、收藏落档案不落卡，全部通过；宿主按记录 PID 停止。
    UI（侧栏角色库：行菜单八项、★ 开关、标签过滤行、排序切换、行内改名/改标签
    编辑器）为新增 i18n 双语键十七枚，en/zh 键集与占位符一致性由既有 i18n 测试
    钉住。假客户端五方法诚实拒绝（无文件系统，谎称改名落地比拒绝更糟）；探针
    名单补五条，rpc-transport 可达性测试全绿。
---

# DEVIATIONS — B8：角色多书绑定（charLore.extraBooks）

日期 2026-09-06，分支 `dev/feat-multibook`（基于 `dev/iris-exploration` @ `079bf31`，
该主线已含任务 L 的世界书面板/扫描设置/聊天级书）。

## 范围

存储（`settings.json` 的 `worldbooks.charLore`，行 shape 与上游逐字同名
`{name, extraBooks}`）；`resolveCardWorldbook` 扩为 primary+additional 有序合并
（`ResolvedWorldbook.additional`，逐书 `world` 归属）；`scanEntriesOf` 逐书守卫
（全局选中/聊天书同名即逐书跳过，主书失守不连坐附加书）；`worldbook.setCharBooks`
RPC（整表替换、空表删整行＝解绑不留残键）+ `worldbook.charNames` 携带存量附加书；
假客户端诚实拒绝；世界书面板「绑定到当前角色」交互 + 双语键；探针名单
（`apps/iris/tests/rpc-transport.test.ts` PROBES + `registration.test.ts` 的
register 清单）与验收脚本 `qa/multibook-acceptance.mjs`。MVU 侧 `initVars` 按上游
`[...global, primary, ...additional]` 的硬编码次序把附加书的 `[InitVar]` 一并折入。

## 与任务书的偏离（有意为之）

1. **存储落点：SettingsStore，而不是 WorldbookStore 类本身。** 清单方案写
   「WorldbookStore 加角色→附加书名数组」，实际落在 `SettingsStore` 的
   `worldbooks` 区。理由：ST 自己就把 `charLore` 存在
   `settings.json → world_info_settings.world_info.charLore`（与 `globalSelect`
   同区），Iris 的 `worldbooks` 区正是那个区的对应物；落在这里继承既有的原子落盘、
   加载合并和「运行时状态不进共享卡文件」的裁定，且行 shape 与上游逐字同名，
   两个安装格式互读不隔。任务书的实质要求（profile 级持久化、不写卡文件）原样成立。

2. **宿主端口：8817 被占，改用 8818。** 开工时 8817 已被一个无主宿主监听
   （netstat 只读识别：PID 26832，`node apps/iris/bin.ts`，能应答 RPC）。按硬纪律
   不按端口/进程名杀进程、亦不动其他 worktree 的东西，该进程原样未碰；本任务宿主
   改用 **8818**，PID 记录在 `.b8-data/host.pid`（验收毕按记录 PID 停止，
   数据目录 `.b8-data/` 验收后删除）。

## 实测发现（未改，待裁）

3. **附加书会被扫描预算的累计停止挤出——与上游一致，不是绑定缺陷。** ST 的预算
   循环按 order 降序累计、超限即停（`world-info.js` 同款，Iris `activate.ts`
   原样转写）。哈人冰恋世界（107 条目书，主书自身匹配已把累计推过 25% 预算线）上
   挂 order=100 的附加书时，附加条目排在累计尾部被截；order=100000 的附加书则
   正常入块（实测 6233→6258）。这与「同书同键直呼引擎 2 条即中」同类：行为归上游
   语义，是否给附加书单独预算档属跨任务裁定。QA 探针因此用高 order 附加书做
   确定性增长检查。

## 验收对账

- 扫描候选：单测（`worldbook-charlore.test.ts`，20 例：存储往返/无残键/逐书守卫/
  `ScanEntry.world` 归属/character_first 组内排序）+ 实机（合成卡 16→36 token；
  哈人冰恋 6233→6258、神隐挑战 4760→4785，解绑后逐 token 回到基线）。
- 解绑不留残键：单测断言 settings 文件原文无 `charLore` 键 + 实机解绑后
  `worldbook.charNames` 只余主绑定、原始文件无键。
- 与 ST 同操作同结果：`getCharacterLore`（world-info.js:4363-4417）的
  worldsToSearch 合并、三重守卫（全局选中/聊天书/persona 书——persona 书 Iris 尚无，
  守卫无可守对象）与 `updateAuxBooks`（:6039，空表 splice 整行、normalizeArray
  去重）逐一转写，行号见各处注释。
- 回归：`pnpm test` 2263 例全绿（哈人冰恋/神隐挑战的既有语料用例在内），
  `pnpm typecheck`、`apps/iris-web` typecheck 全绿。
# DEVIATIONS — 任务 T2：聊天备份视图（C17）

分支 `dev/feat-backups`（基于主线 dev/iris-exploration 079bf31）。对照上游
`src/endpoints/backups.js` + `src/util.js`（removeOldBackups：按序保留最近
N 份，`backups.common.numberOfBackups` 默认 50）。验收宿主：8818 独立宿主
（按记录的后台任务启停，未按进程名/端口清理）。每一条写明上游/任务书的做法
与本侧的选择。

1. **「导入覆盖」这一触发在本宿主不可达，守卫保留。** 上游
   `/api/chats/import` 允许覆盖同名聊天文件；本侧 `importFile` 用
   `uniqueId` 重铸 id，被占用即换新名——覆盖在今天的 id 算术下不会发生。
   写入前的存在性守卫仍然落在 `importFile` 内（目标存在则先快照
   `import-overwrite`），因为机制承诺的是操作而不是今天的算术：id 铸法
   一旦改变，被覆盖者必须先被复制。实测：同名重复导入产生新 id、不产生快照。
2. **快照布局为 `backups/<角色>/<聊天>/<UTC戳>-f<楼数>-<原因>.jsonl` 两级
   子目录，取代本侧原有的扁平布局。** 原 `chats.backup()`（清理
   对话框的「备份并清理」）写的是 `backups/<chatId>-<ISO戳>.jsonl`，没有
   轮转、没有原因、备份卡看不见。现全部走同一 `BackupStore`：一份布局、
   一份轮转、一个列表。代价：切换前留下的旧扁平文件不被 `backup.list`
   收录（仍在磁盘上，不删除）；清理备份从此受轮转约束（原来永不清理）。
   楼数编进文件名（`f<楼数>`），列表零读取即可显示 时间/楼数/大小。
3. **`script.saveChat` 不触发快照；触发点在改变楼层的两个臂上。**
   saveChat 是持久化，不是决定：删除在 `script.deleteChatMessages`、改写
   在 `script.setChatMessages` 处已经决定，磁盘在那一刻仍是改前状态——
   在那里快照，每个危险操作恰好一份改前副本。若挂在 saveChat 上，MVU 卡
   每回合一次存盘会以每回合一份的速度空转轮转窗（且因 `touch()` 必改
   updatedAt，任何字节级去重都救不了）。两臂共享字节级去重：同一批次
   的后续臂看到磁盘未变即跳过，不再复制。
4. **恢复的具名确认进了契约，宿主强制。** 任务书要求「恢复走具名确认」；
   本侧把 `confirm` 设为请求的必填字段并与快照头部标题（无标题则 chatId）
   逐一比对，大小写敏感、首尾空白宽容。界面里禁用的按钮只是礼节，契约
   才是闸门——能碰到线的调用方都必须自带意图证明。
5. **恢复前快照同样受轮转约束。** 达到上限时，被恢复的那份最旧快照会被
   `pre-restore` 副本挤出窗口。写回不受影响：恢复先把源文件整读进内存再
   落盘（先读后照，逐字等价），8818 实测恢复后的活文件与快照字节一致。
6. **清理对话框的「仅清理」不自动快照。** 该答案的含义是用户拒绝了备份
   选项；自动快照若默默补上，就是用机制推翻显式选择。「备份并清理」照旧
   先备份后清扫（现走共享存储，原因记 `cleanup`），且备份失败仍然中止清扫。
7. **轮转下限为 1。** `backupKeep: 0` 读作 1：把保留设为零会让每次受保护
   的写入变成它本要防止的那场丢失，没有一种诚实的「保留 N」会要这个。

# DEVIATIONS — dev/fix-notice-center：通知面板可见性 + 对话区中线居中

分支 `dev/fix-notice-center`（基于主线 dev/iris-exploration 3cf6fed，见下第 1 条）。
验收宿主：**8824** 独立宿主（本 worktree 后台任务启动，数据目录为本 worktree 的
`data/`，未按进程名/端口清理任何进程）。通知面板 = 设置抽屉底部的「通知」区
（`NoticeLog`），对话区中线 = 消息正文列中线 vs 输入框（composer 输入域）中线。

## 根因（实测）

1. **接口帧错误从不进通知面板。** 消息接口帧宿主（`MessageInterfaces.tsx`）的
   `onError` 只写 `addCardReport`（卡报告列表），从不 `notify` —— 与脚本帧宿主
   （`useCardScripts` 的 `onFailure`：报告 + 通知双通道）不同轨。主流语料的卡片把
   生成期逻辑放在接口帧的 markup 里（FRAME-FENCED 一族 18 卡），接口帧成形之后这
   一整类错误在通知面板上消失——「卡明明报了错、通知区空空如也」的实测根因。
   修复：接口帧错误在保留分级报告的同时补发 `notify('error', …)`。
2. **同文去重被逐次变化的运行地址击穿。** 脚本每次运行从新的 blob URL 求值，帧的
   错误报告引用该地址与栈位，同一故障每次到达都是「新句子」，精确文本去重一次也
   不合并（实测三开同一坏卡得三行）。修复：`noticeRecurrenceKey` 只把 `blob:` 引用
   连同栈位抹平，其余逐字节比较；合并行携带最新一次的原文；首个/唯一错误不受影响。
3. **中线偏差 19px（两档视口实测），构成与任务书 T 的 42px 分解不同。** 实测构成：
   输入域 `width:100%` 按 content-box 解析，文本域连内边距带边框溢出 `__inner`
   28px（中线 +14）+ 阅读列 `scrollbar-gutter: stable` 预留而 composer 无对应预留
   （中线 +5）。任务书点名的非对称 `padding-left:46` 与消息列 46px 边栏在两侧行为
   相同、中线相互抵消，不构成偏差。窄窗（≤880px）另有第三处：媒体查询把 composer
   内边距清零而正文保留 34px 边栏（+17px，此前被 box-sizing 反号偏差掩盖）。
   修复：`box-sizing: border-box` + composer 同车道预留
   （`overflow-y:auto; scrollbar-gutter:stable; min-height:max-content`）+
   删除窄窗清零覆盖。修后 1920×1080 / 1366×768 / 800×700 实测 **0.00px**。

## 与任务书的偏离（有意为之）

4. **去重身份超出「同文」字面。** 任务书要求「去重只合并同文重复」；实现把身份
   放宽到「同文去掉逐次变化的 blob 地址」。理由：语料证明逐字节同文在三开的场景
   下从不出现，字面同文去重对该场景等于不去重；放宽只抹地址，凡对成因说了不同
   的话的仍是两行，首个/唯一错误绝不合并（单测三例钉住这三条边界）。
5. **非对称 `padding-left` 保留，未按任务书建议「对称化」。** 实测证明它与消息列
   边栏镜像、中线本就重合；真正要对称化的是车道与盒模型。若按建议直接删除该
   padding，反而制造 23px 偏差。
6. **composer 成为滚动容器。** 车道对齐要求 `scrollbar-gutter` 生效，而它只对滚动
   容器生效；`min-height: max-content` 归还被没收的自动最小尺寸，短窗下不回归。

## 实测发现（未改/待裁）

7. **主线 HEAD（3cf6fed，T2 合并）本身带未解决冲突标记。** `store.ts`、
   `iris-app-service` 的 `service/chats/index`、`iris-client-fake/client` 五文件
   内含 `<<<<<<< HEAD` 标记，主线工作树原样无法构建/启动（vite build 与
   `node apps/iris/bin.ts` 均当场失败）。本分支按「两侧都是纯新增、keep-both」
   逐处解决并随本分支提交；**主线上的同五文件仍是坏的**，需主线侧以同一解法
   修复（`git checkout dev/fix-notice-center -- <file>` 或等价重放）。
8. **非相邻重复不合并不计数（设计如此，未改）。** 去重只看日志最后一行
   （`repeatsLatestNotice`），交错到达的同一错误（A B A）各占一行，与卡报告列表
   的 `collapseRuns`「仅相邻合并」同一裁定。三开坏卡且中间插有其他通知时面板仍会
   长行；若要按「同一逻辑错误」全局合并属跨任务裁定。
9. **设置抽屉「通知」区位于抽屉底部**（宿主报告之后），需要滚动才见。本次未动
   信息架构；若验收方期望通知更靠前，属 IA 裁定。

## 验收对账

- 单测：`store.test.ts` 新增 3 例（blob 地址变化合并 ×3、超出地址差异不合并、
  带地址的首个错误不被吞）+ 既有 69 例全绿；`notice-channels.test.ts`（新文件）
  4 例源级守卫（接口帧 onError 双通道、composer 车道/盒模型/内边距镜像）。
- 实机（headless CDP，8824，探针卡 `qa/notice-probe*.json`，脚本
  `qa/notice-center-baseline.mjs`）：无错误时面板干净（空态文案）；坏卡一开
  → 三条错误全数入面板且标红（含接口帧 markup 错误「this frame carries the
  card's markup」）；同一故障连续三次 → 一行 ×3；中线偏差 1920×1080=0.00、
  1366×768=0.00、800×700=0.00；滚动条车道 `stable` 恒为 10px，出现与否不影响
  两中线。截图 `qa/shots-notice-center/`（gitignore，不入库）。
- 回归：`pnpm test` 2302 通过 0 失败（5 跳过为 live 用例）；`pnpm typecheck`、
  `apps/iris-web` typecheck 全绿。
- 协同：未动 `wt-frame-fit` 管辖的 frame-height/消息帧几何；composer 量测逻辑
  （`Composer.tsx`）本次无需改动，几何修正全部落在 `panels.css` 的 composer 区。
- 未花真钱：全程未调用模型端点（探针卡不生成、不发消息）。

# DEVIATIONS — 任务 A1：世界书条目编辑器（30+ 字段、过滤与排序）

分支 `dev/feat-wi-editor`，基线 `dev/iris-exploration` @ `d8362ef`（含任务 L 与
B8）。对照装置：`E:/sillyTavern/SillyTavern`（1.18.0，
`index.html:6802` `entry_edit_template`、`index.html:4838` `#world_info_sort_order`、
`world-info.js` `sortWorldInfoEntries` / `addMissingWorldInfoFields`）。

## 与任务书的偏离（有意为之）

1. **`worldbook.replace`/`worldbook.get` 的线格式纯增量扩了 6 个字段，未新增宿主方法。**
   任务书要求编辑器暴露 automationId、逐条覆盖、输出口等全部字段，但线格式
   （TavernHelper 形状）读方向缺 `automationId`/`useGroupScoring`/`ignoreBudget`/
   `useProbability`/`triggers`/`characterFilter`，写方向连 `outletName` 都被 zod
   `z.object` 剥掉——整书保存会在保存的那一刻把这些字段从书里抹掉。全部字段
   可选、默认值与既有写方一致（`useProbability` 缺省仍为 `true`，未动那条
   load-bearing 铁律），未听过这些字段的旧调用方写出的书与从前逐字节相同；
   测试钉死（`worldbook-write.test.ts`）。**没有新增任何 RPC 方法。**

2. **排序是 15 种，不是任务书里的"10 种"。** 枚举逐一对照实机 1.18.0 的
   `#world_info_sort_order`：14 个可见选项（priority/custom、title、tokens、depth、
   order、uid、trigger% 各升降）+ 隐藏的 search 规则（有过滤词时才出现在下拉，
   同上游）。任务书引用的 `world-info.js:4838` 在该实机版本里实际是
   `index.html:4838`（选择器本体）；`world-info.js` 里是配套比较器
   `sortWorldInfoEntries`，其二三级 tie-break（order 降序、uid 升序）一并转写。
   少做一种，就意味着存在一种上游能产出、本壳产不出的条目顺序。

3. **写前快照落在下载目录，不是 profile 的 `backups/`。** C17（备份视图）未合入：
   `dev/feat-backups` 分支尖与主线重合，宿主没有任何世界书备份 RPC。按任务书
   "否则记待办"执行：编辑器工具栏提供「下载备份」（`worldbook.load` 取原始
   存盘形状，时间戳文件名落浏览器下载），`backups/` 目录接入记为待办，等 C17
   合入后把 `exportWiBackup` 换成宿主快照调用。

4. **`iris-web` 声明 `@iris/protocol` 为 `file:` 依赖。** 编辑器测试要拿真实的
   `worldbook.replace` zod schema 验证整书草稿能过宿主的门，而 pnpm workspace
   不含 iris-web（npm 管理），bare specifier 在 `node --test` 下不可解析。与
   `client-fake`、`compat-tavernhelper-core` 同款 `file:` 链接，无新安装面。

5. **`vite.config.ts` 的 dev 代理目标读 `IRIS_HOST_PORT`（默认 8787 不变）。**
   本 worktree 宿主在 8820，开发代理需要一个不改文件的指法；生产构建不经过
   这段配置。

## 验收对账

- 哈人冰恋（107 条）改 order/probability/键 → 保存 → 落盘与重读逐一核过
  （`wi-editor-verify.mjs`，Iris leg 6/6 PASS）；顺序变化驱动激活顺序的引擎
  链路已在 worldbook-source/timing 用例覆盖。
- 与 ST 实机同书同编辑双方落盘等价：**107/107 条逐字段相等**（键序与
  displayIndex 除外）。ST 侧经其自身 `/api/worldinfo` 往返一次性验证，先施加
  上游客户端加载时的 `addMissingWorldInfoFields` 模板补齐——Iris 的写方在同一
  6 字段上补的是同一批默认值（`automationId ''`、`useGroupScoring null`、
  `ignoreBudget false`、`useProbability true`、`triggers []`、
  `characterFilter {isExclude:false,names:[],tags:[]}`），对照
  `newWorldInfoEntryDefinition`（world-info.js:4002）逐一核对。
- 15 种排序逐一可切，纯函数对照上游比较器钉测（tie-break 含）。
- 未保存提醒：具名（书名 + N 条）常驻条 + 离开路径（换书/关编辑器）三键确认，
  状态机纯函数带测。
- 回归：`pnpm test` 2302 例 0 失败、`pnpm typecheck` 与 iris-web typecheck 全绿。

---

# DEVIATIONS — B7：主题系统（主题=token 表 + user.css 插槽）

日期 2026-09-06，分支 `dev/feat-themes`（基于 `dev/iris-exploration` @ `d8362ef`，
该主线已含任务 O 滚动条 token、任务 N 连接面与 B6 折叠卡设置抽屉）。

## 范围

主题=token 覆盖表（`theme/presets.ts`：light/dark/parchment 三套内置，各 26 个
`--iris-*` 调色键）；主题选择外部 store（`theme/theme.ts`，useSyncExternalStore
同 i18n 机制，切换即写 `data-iris-theme` 属性、CSS 级联即时重绘，免刷新）；
localStorage 持久化（`iris.theme`，默认 `system` 跟随 prefers-color-scheme，
手动选择即持久）；第三套主题「羊皮纸」（正文 12.3:1、次级墨 6.8:1、tick 3.6:1、
accent 5.4:1，数值写进 tokens.css 注释并由测试计算复核）；token 覆盖层
（`iris.theme.overrides`，只收 THEME_TOKENS 名单内、≤64 键，内联写在根元素上，
外观卡可一键清除）；user.css 插槽（`slots/user-css.ts`：`<style
data-iris-slot="user-css">` 挂载点，512 KiB 上限，开关关闭即卸载元素、文本保留）；
设置抽屉新增「外观」卡（三套内置预览缩略块——由各主题 token 表内联上色、跟随系统
开关、覆盖层清除、user.css 编辑器/开关/导入 .css、主题包导出导入 JSON）；主题包
格式 `iris.theme` v1（`theme/theme-transfer.ts`：完整调色表+覆盖差集+user.css，
往返等价有测试）；index.html 预涂色脚本认得 parchment；任务 O 的
`--iris-scrollbar*` 随主题联动（三套互异，由 theme-presets 测试钉住）。

## 与任务书的偏离（有意为之）

1. **movingUI 拖拽明确不做**（清单已裁定，记录在案）。上游该功能以复杂著称，
   Iris 以响应式布局（抽屉宽 token、小屏侧栏、外观卡）替代。

2. **user.css 的「slot 注入」落为专用 `<style>` 挂载模块（`slots/user-css.ts`），
   不走 SlotCore children。** SlotCore 槽位登记的是 React 组件（declarer+renderSlot
   纪律），`<style>` 挂载点不是组件，硬塞进去需要一个渲染 null 的假 declarer。
   该模块遵循 slots/ 目录对 DOM 的同一纪律并在文件头声明：install 挂载、dispose
   拆除、不留残迹（元素带 `data-iris-slot="user-css"` 供外部断言）。任务书的实质
   （「`<style>` 挂载点」注入、可开关、受 overlay 约束兜底）原样成立。

3. **内置主题调色声明两次：tokens.css 的 CSS 块 + presets.ts 的 token 表。**
   CSS 块保证存储的主题在 bundle 之前上墙（index.html 预涂色脚本同款理由，刷新
   不闪底色）；token 表是导出/导入/预览缩略块的数据源。双份一致由
   `theme-presets.test.ts` 逐值比对钉住（解析 tokens.css 与表格 deepEqual），
   重复无检查即是漂移。

4. **主题选择从阅读卡移到新增「外观」卡。** B6 的阅读卡原本带三选一主题菜单；
   主题换成画出来的缩略块后菜单与缩略块并存会变成两处入口，故主题选择整体移入
   外观卡（缩略块三套 + 「跟随系统」开关），阅读卡只留字号/行长/楼层号/语言。
   `ReadingControl` 相应收窄为 reading-only；设置导出/导入的 device.theme 不变。

5. **宿主端口 8819 空闲，按任务书使用。** 宿主 PID 起初记录到
   `.b7-data/host.pid` 失败（Git Bash 对反斜杠路径的转义），改由 netstat 只读
   定位后按命令行核验（`node apps/iris/bin.ts`，PID 28792）再停止；未按端口或
   进程名误杀任何进程。QA 无头 Chrome 各自带一次性 user-data-dir，只杀自己
   spawn 的 PID。`.b7-data/`（QA 脚本与截图证据）留在 worktree 未提交。

## 实测发现（未改，待裁）

6. **tokens.css 原先的浅色 scrollbar token 在结构块里**（第一个 `:root`，与字号
   圆角同区），暗色块却覆盖了它——同一 token 分居两处。本次把浅色的
   `--iris-scrollbar/--iris-scrollbar-strong` 移入浅色调色板块（`--iris-scrollbar-size`
   是结构值，留在原处），三套主题的 scrollbar 现在都随各自的调色板块走，并被
   theme-presets 测试的「三套互异」断言钉住。

## 验收对账

- 切换免刷新/持久化/滚动条联动/user.css 生效与关闭/重挂载：实机 CDP 验收脚本
  （`.b7-data/qa-b7.mjs`，8819 实宿）11/11 通过；同一 JS 上下文内完成三次主题
  切换（window 标记存活）、scrollbar token 三套互异（#cdd4d9 / #2c3540 / #cfc2a4）、
  parchment 跨刷新存活（属性来自存储）、user.css 规则实测上墙（抽屉底色变
  rgb(255,0,102)）、关闭即卸载且文本保留、再刷新自动重挂载。
- 对比度：`theme-presets.test.ts` 对三套内置计算正文≥4.5:1、次级≥4.5:1、
  tick≥3:1、accent>tick×1.3；`contrast.test.ts` 扩到三套同地板。低对比不破：
  各主题 scrollbar 仍低于 rule 对比度（chrome 而非读线），faint 墨阶原样。
- 导出导入往返等价：`theme-transfer.test.ts`（build→stringify→parse 同主题；
  原厂配色导入即零覆盖、不遮蔽后续切换；改色主题导入即精确差集；格式拒绝）。
- 回归：`pnpm test` 2323 例全绿（2310 pass + 13 既有语料 skip，0 fail），
  `pnpm typecheck`、`apps/iris-web` typecheck 全绿。

## 接管复核（同日，另一代理）

首次执行代理中断后由接管代理独立复核，未改产品代码，结论：全部成立。

- 独立重跑 `pnpm test`（2318 pass / 0 fail / 5 skip——skip 数随环境的既有语料
  条件跳过，与上行 13 的差异同源）、`pnpm typecheck`、iris-web typecheck，全绿。
- 实机复测换了更严的驱动（`.b7-data/qa-verify-takeover.mjs`，8819 实宿，宿主
  PID 记录于 `.b7-data/host-8819.pid`、用后按 PID 停止）：19/19 通过。较首轮
  验收新增四项浏览器内证据：跟随系统开关把 `data-iris-theme-source` 还原为
  `system`；导出在页面内截获（object-URL 拦截），`iris.theme` v1 全 26 键调色表
  + user.css 逐字；真文件导入（CDP `DOM.setFileInputFiles`）改色主题包后
  dark + accent 覆盖（`--iris-accent: #ff80aa` 内联上墙、`data-iris-overrides=on`
  恰 1 键）+ user.css 全部生效并跨刷新存活；**真往返**——清空 localStorage 后
  仅凭导出的 JSON 文件原样恢复主题、覆盖层（原厂=零覆盖）与 user.css；
  异格式文件整包拒绝且一行报告，不应用任何键。
- 复测中的两个驱动层发现（非产品缺陷，QA 手法记录）：其一，合成
  `change` 事件在本 Chromium 不能唤醒 React 的文件输入处理器，导入路径须用
  受信的 `DOM.setFileInputFiles` 喂真文件；其二，折叠卡的孩子保持挂载仅是
  隐藏，断言「卡展开」必须看 `offsetParent` 而非元素存在，否则会在折叠态
  点中隐藏元素、功能通过而截图失真。
