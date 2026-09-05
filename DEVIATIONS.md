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
