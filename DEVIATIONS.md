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
