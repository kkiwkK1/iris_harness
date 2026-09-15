# IMPLEMENTATION-CHECKLIST — Iris 对照 SillyTavern 1.18.0 的当前实现清单

> 状态：有效。2026-09-15 以 Iris `269a97e`（`main`）重新基线，是当前的「还差什么」清单之一（另一份是 `ST-COMPARE.md`）。它描述某个基线上的事实，不随后续提交自动更新；界面与契约的现状以 `docs/` 为准（索引见 `notes/README.md`）。

> **重新基线：2026-09-15，Iris `269a97e`（`main`）。**
>
> 本清单只列当前事实。旧版基于 `3cf858d`，其中“任务 L/M 进行中”及多个“缺失”结论已被主线实现推翻。已关闭项保留在下表防止重复立项；剩余项才是可选的新工作。

证据与功能解释见 `ST-COMPARE.md`。状态只有四种：**已关闭**、**部分完成**、**未做**、**非目标**。本文件不根据分支名猜测“进行中”。

## A. 已关闭：不得按缺失能力重复立项

| 原编号 | 能力 | 状态 | 关闭证据 / 验收锚点 |
| --- | --- | --- | --- |
| A1 | 世界书用户面板 | **已关闭** | `WorldbookPanel.tsx`；`worldbook.*`；`worldbook-panel.test.ts`；条目编辑器任务验收 |
| A2 | Chat Completion 预设存储与切换 | **已关闭** | `PresetStore`；`preset.*`；`PresetPanel.tsx`；预设管理与连接档测试 |
| A3 | 聊天导入/导出 | **已关闭** | `chat.import/export`；`chat-transfer.test.ts`；正式 UI 入口 |
| B1 | 聊天内容搜索 | **已关闭** | `chat.search`；`chat-search.test.ts`；侧栏过滤 |
| B2 | continue / impersonate | **已关闭** | `chat.send.kind`；`generation-kinds.test.ts`；`@iris/turn` |
| B3 | 全局正则层 | **已关闭** | `regex.list/set`；`RegexPanel.tsx`；global → preset → scoped 三层测试 |
| B4 | 宏差集 | **已关闭** | `iris-macro/src/builtins.ts`；`builtins.test.ts`；`floor-macros.test.ts` |
| B5 | Persona 主链 | **已关闭** | `persona.list/get/set/delete`；`PersonaPanel.tsx`；`persona.test.ts` |
| B6 | 设置面扩容 | **已关闭（Iris IA）** | 折叠卡、设置导入导出、真实消费者与任务 R 逐键验收；不以复制无消费者键为验收 |
| B7 | 主题与外观 | **已关闭（Iris 方案）** | 三内置主题、主题包、user.css、即时切换及主题测试；movingUI 为非目标 |
| B8 | 角色多书绑定 | **已关闭** | `worldbook.setCharBooks`；`worldbook-charlore.test.ts`；世界书面板 |
| B9 | WI 方言导入 | **已关闭** | Agnai/Risu/NovelAI 转换器与 `parse.test.ts` |
| B10-1 | 楼层动作接缝 | **已关闭** | `iris.message.actions`；`MessageActions.tsx`；可卸载 demo provider |
| B11 | 数据与凭据安全面 | **已关闭（Iris 方案）** | RPC 不回显；设置导出无密钥；平台安全存储与边界测试 |
| C4-基础 | 长聊天摘要 | **已关闭（Iris 方案）** | `chat.compact`、`/compact`、80% 自动压缩；`compaction.test.ts` |
| C15 | 角色标签/收藏/排序 | **已关闭** | 角色页与角色管理测试 |
| C16 | 角色复制/重命名/导出 | **已关闭** | `character.duplicate/rename/export`；`character-ops.test.ts` |
| C17 | 聊天备份视图 | **已关闭** | `backup.list/preview/restore/delete`；`BackupPanel.tsx`；`backups.test.ts` |

关闭规则：以上能力若坏了，按回归处理；不得重新创建“实现 A1/A2/B3……”一类项目。只有表中明确排除的后续范围可以新立项。

## B. 部分完成：只补剩余部分

### R1. Persona 附属能力

- **已有基础**：多 Persona CRUD、激活、位置/深度/role、提示词注入、`{{persona}}`、WI 扫描。
- **仍缺**：头像、persona→角色锁、persona 专属世界书绑定。
- **依赖**：无；世界书存储与选择能力已经存在。
- **工作量**：**M**。
- **验收**：切换 persona 后头像/锁定关系与专属书在下一次装配生效；不把其他 persona 的描述或书暴露给当前卡；删除时清理绑定但不删世界书。

### R2. 角色编辑余项

- **已有基础**：导入、删除、标签、收藏、排序、复制、重命名、导出。
- **仍缺**：头像编辑、通用属性编辑；是否需要 ST 的 merge-attributes 需先确认真实需求。
- **依赖**：无。
- **工作量**：**M**。
- **验收**：编辑后卡片重新编码仍保留未知字段；重开宿主后角色 id、聊天和世界书绑定不漂移。

### R3. 非 CC 预设族与出厂恢复

- **已有基础**：Chat Completion 预设库和 Prompt Manager 已完成。
- **仍缺**：Text Completion 所需 context/instruct/sysprompt/reasoning 等族；ST 式出厂 restore。
- **依赖**：R9 文本补全后端。不要在没有消费者时单独造 context/instruct 设置面。
- **工作量**：随 R9 计入 **XL**。
- **验收**：以同一 Text Completion 后端、同一输入与 ST 实机做请求体对照；restore 只恢复对应出厂项，不覆盖用户另存项。

### R4. 摘要兼容余项

- **已有基础**：Iris 有手动和自动聊天压缩，摘要持久并进入后续装配。
- **仍缺**：若确有兼容需求，ST memory 扩展的定时策略、独立 depth 注入和 `{{summary}}` 接口尚未实现。
- **依赖**：宏引擎和装配接缝已完成。
- **工作量**：**S/M**（只做兼容面）或不做。
- **验收**：先定义它与现有 compaction 的单一事实来源；不得让两份摘要同时进入请求或互相覆盖。

### R5. 斜杠命令扩容

- **已有基础**：Iris 自有 `/new`、`/rename`、`/export`、`/chat-model`、`/capacity`、`/compact`、`/config`、`/help`，卡片兼容路径覆盖真实语料所需命令。
- **仍缺**：ST 约 290 个名字背后的完整语义。
- **依赖**：按每个命令的消费者决定。
- **工作量**：**S/批**。
- **验收**：每批必须有真实调用点或明确用户场景，并做上游同输入/同副作用对照；不能以“名字能被解析”冒充实现。

### R6. 移动端专属档

- **已有基础**：viewport 元数据和响应式布局。
- **仍缺**：专门的紧凑输入档、完整 375px 流程验收、PWA/apple web-app 元数据。
- **依赖**：无。
- **工作量**：**M**。
- **验收**：375px 宽完成选卡、新建聊天、生成、切 swipe、开设置、编辑世界书；无横向溢出和不可达控件。

## C. 当前未做：独立项目

### R7. TTS / speech provider

- **基础已备**：`iris.message.actions` 接缝。
- **工作量**：**M/每家**。
- **验收**：逐楼播放、停止、切聊天清理资源；provider 未安装时零 UI 残渣。

### R8. 翻译 / caption / 图像生成

- **基础已备**：楼层动作接缝；聊天存储可保留扩展字段。
- **工作量**：翻译/caption **M**，图像生成与 gallery **L**。
- **验收**：翻译不改原始消息；生成物的引用可持久、导出和重开；卸载 provider 不破坏已有消息。

### R9. Text Completion 后端

- **范围**：kobold/novel/textgen/horde 或统一裸 `/completions` 路线，加 R3 的 context/instruct 等预设族。
- **依赖**：独立于当前 Chat Completion 管线。
- **工作量**：**XL**。
- **验收**：请求形状、停止词、上下文模板和流式结果与选定 ST 后端逐项对照；不得改变现有 CC 请求。

### R10. RAG / vectors

- **范围**：分块、嵌入、索引、检索、注入，并消费世界书 `vectorized`。
- **依赖**：装配注入点和世界书标志已存在。
- **工作量**：**XL**。
- **验收**：真实语料检索报告；权限边界；索引失效与重建；未启用时请求逐字不变。

### R11. 快速回复 / automation

- **范围**：消息模板、集合/槽位/触发策略，并消费世界书 `automationId`。
- **依赖**：若只做手动快速回复，无；automation 消费者随后接入。
- **工作量**：**M**。
- **验收**：可导入选定 ST QR 集、逐条可发、自动触发可审计且可关闭；未启用时不产生按钮或副作用。

### R12. Attachments / 数据银行

- **范围**：文件或网页内容的摄取、持久化、授权、检索与提示词注入。
- **依赖**：若采用向量检索则依赖 R10；否则可先做纯附件。
- **工作量**：**L**。
- **验收**：内容只对获授权的卡/聊天可见；导出与删除行为明确；远程抓取失败不留下半成品。

### R13. Expressions / sprites

- **范围**：情绪分类与立绘选择。
- **依赖**：provider 决策后确定。
- **工作量**：**L/XL**。
- **验收**：真实语料抽查；分类失败有稳定回退；不阻塞消息渲染。

### R14. 群聊

- **范围**：成员、三种发言策略、生成/再生成/swipe 语义和群聊存储。
- **依赖**：独立项目；从 `GROUPS.md` 的现有裁决开始。
- **工作量**：**XL**。
- **验收**：三模式、成员切换、分支与导入导出均有存储契约测试；单人聊天不回归。

### R15. 多用户 / 鉴权

- **状态**：当前非产品目标；只有目标改变时才立项。
- **范围**：登录、账户管理、运行时 profile 切换、隔离与迁移。
- **工作量**：至少 **L**，部署安全另算。
- **验收**：两账户并发不串角色、聊天、连接密钥、预设、世界书或插件数据；升级和备份恢复路径完整。

## D. 明确非目标或不能按“缺失”表述

| 项 | 当前裁定 |
| --- | --- |
| ST movingUI | 不复刻；使用响应式布局、主题 token 与明确的 shell 插槽 |
| ST 明文 secrets API | 不做；凭据不回显并使用平台安全存储 |
| ST 同源任意 JS 通用扩展加载器 | 不照抄；已有系统插件平台与受约束的 ST 扩展兼容入口，后续按语义和权限模型扩展 |
| 无消费者的 ST 设置键 | 不铺空面板；每个设置必须有真实消费者 |
| 将 Text Completion 模板塞进 CC 管线 | 不做；与 R9 同项目实现 |

## E. 当前依赖图

```text
已完成：世界书面板 ─────────────┬─ R10 vectors → 消费 vectorized
已完成：世界书编辑/绑定 ────────└─ R11 automation → 消费 automationId

已完成：楼层动作接缝 ──────────┬─ R7 TTS
                                └─ R8 翻译 / caption / 图像

R9 Text Completion ────────────── R3 非 CC 预设族
R10 vectors ───────────────────── R12 数据银行（若选向量路线）

已完成：宏 + Persona 主链 ─────── R1 Persona 附属能力
已完成：聊天压缩 ─────────────── R4 memory 兼容余项（可选）
```

旧依赖图中的 `A1 → B8`、`A2 → B2`、`A3 → C17`、`B4 → B5`、`B10 → providers` 前置边均已满足；它们不再是关键路径。

## F. 维护规则

1. 合入关闭某条 R 项的产品变更时，同一变更更新本文件与 `ST-COMPARE.md`。
2. 只完成基础接缝时，写“接缝已完成 / provider 未做”，不得把两者合并成一个模糊百分比。
3. 发现已关闭能力失效时，登记回归及受影响版本，不把状态退回“从零未做”。
4. 临时分支、worktree、PID 和负责人不写进长期基线；这些信息属于任务单或验收记录。
5. 新立项必须引用一个当前 R 编号，或先用代码证据说明为什么需要新增编号。
