# ST-COMPARE — Iris vs SillyTavern 1.18.0 当前基线

> 状态：有效。2026-09-15 以 Iris `269a97e`（`main`）重新基线，对照 SillyTavern 1.18.0，是当前的「还差什么」清单之一（另一份是 `IMPLEMENTATION-CHECKLIST.md`）。它描述某个基线上的事实，不随后续提交自动更新；界面与契约的现状以 `docs/` 为准（索引见 `notes/README.md`）。

> **重新基线：2026-09-15，Iris `269a97e`（`main`）。**
>
> 旧版定格在 `3cf858d`（2026-09-05），且明确说“不随后续提交更新”。那份快照已经被后续实现大面积推翻，不能再用来判断当前完成度、关键路径或新任务。本版以当前主线的已注册 RPC、宿主实现、正式界面和回归测试为准；SillyTavern 一侧仍以 1.18.0 的既有实机与源码证据为参照。

本文件回答“现在还差什么”。历史实现方案和取舍记录仍在 `DEVIATIONS.md`、各包的 `DEVIATIONS.md` 与测试中，不在这里重复。

## 0. 判定口径

- **已完成**：能力已经接入正式路径；若需要用户操作，则有正式 UI；有对应测试或验收记录。
- **已完成（Iris 方案）**：用户目标已经可达，但形态有意不照抄 ST。
- **部分完成**：核心链路可用，只剩明确列出的细节或独立消费者。
- **未做**：当前主线没有该能力。
- **非目标**：有成文裁定不按 ST 的形态实现，不能作为待补缺口重复立项。

“有类型/有占位/有引擎”不单独算完成；“有实现但没注册”也不算。反过来，已经存在于协议、宿主、界面和测试中的能力，不再因为旧快照写过“缺失”而降级。

## 1. 重新基线结论

### 1.1 旧清单中的误报已经关闭

| 旧条目 | 当前判定 | 当前证据锚点 | 仍需另行区分的范围 |
| --- | --- | --- | --- |
| 世界书用户面板 / 条目编辑器 | **已完成** | `WorldbookPanel.tsx`；`worldbook.*`；`worldbook-panel.test.ts`；`worldbook-write.test.ts` | `automationId` 与 `vectorized` 的消费者仍分别归快速回复、向量检索 |
| 预设存储与切换 | **已完成** | `PresetStore`；`preset.*` 12 方法；`PresetPanel.tsx`；预设测试 | 当前完成的是 Chat Completion 预设；Text Completion 的 context/instruct 等族随文本补全后端立项 |
| 聊天导入 / 导出 | **已完成** | `chat.import` / `chat.export`；`chat-transfer.test.ts`；侧栏入口 | 不等于群聊导入能力 |
| 聊天内容搜索 | **已完成** | `chat.search`；`chat-search.test.ts`；侧栏过滤 | 无需再建 B1 |
| continue / impersonate | **已完成** | `chat.send.kind`；`generation-kinds.test.ts`；`@iris/turn` | narrate 等其他消息动作仍是另一项 |
| 全局正则层 | **已完成** | `regex.list/set`；`RegexPanel.tsx`；`regex-store.test.ts` | 当前还包含 preset、scoped 两层及其授权/启停面，不再是“只有卡内层” |
| 宏差集 | **已完成** | `iris-macro/src/builtins.ts`；`builtins.test.ts`；`floor-macros.test.ts` | 新消费者自己的宏不自动视为内建宏缺口 |
| Persona 主链 | **已完成** | `persona.list/get/set/delete`；`PersonaPanel.tsx`；`persona.test.ts` | 头像、角色锁、persona 专属世界书绑定尚未补齐 |
| 角色多书绑定 | **已完成** | `worldbook.setCharBooks`；`worldbook-charlore.test.ts`；世界书面板 | 无需再依赖“待完成的 A1” |
| WI 方言导入 | **已完成** | `convertAgnaiMemoryBook` / `convertRisuLorebook` / `convertNovelLorebook`；`parse.test.ts` | — |
| 角色标签 / 收藏 / 排序 | **已完成** | `CharacterPage.tsx`；角色管理测试 | — |
| 角色复制 / 重命名 / 导出 | **已完成** | `character.duplicate/rename/export`；`character-ops.test.ts` | 头像编辑、任意属性编辑仍未等价 |
| 设置面扩容 | **已完成（Iris 方案）** | 折叠式设置卡、逐键消费者、设置导入导出；任务 R 记录 | 不以复制 ST 的 83/102 个键为目标 |
| 主题与 user.css | **已完成（Iris 方案）** | light/dark/parchment；主题包导入导出；user.css 挂载；主题测试 | movingUI 明确不做 |
| 楼层动作接缝 | **已完成** | `iris.message.actions`；`MessageActions.tsx`；demo provider | TTS、翻译、图像、caption 等 provider 仍各自未做 |
| 聊天备份视图 | **已完成** | `backup.list/preview/restore/delete`；`BackupPanel.tsx`；`backups.test.ts` | 世界书备份仍是下载式备份，不走该聊天快照库 |

### 1.2 当前功能域总览

| 功能域 | 当前状态 | 与 ST 1.18.0 的真实剩余差异 |
| --- | --- | --- |
| 世界书引擎 | **已完成 / Iris 有增强** | 激活、递归、预算、计时、分组、outlet、全局/聊天/角色书、多书绑定均已接通；向量与 automation 消费者未做 |
| 世界书管理 | **已完成** | 建、读、改、删、导入、导出、全局选择、扫描设置、30+ 字段编辑、过滤与 15 种排序均有正式面 |
| Chat Completion 预设 | **已完成** | 库、切换、保存、删除、导入、提示词管理器与连接档绑定均可用；restore 出厂库及非 CC 预设族不在此完成范围 |
| 角色卡与角色管理 | **部分完成** | PNG/JSON/.charx、标签/收藏/排序、复制/重命名/导出已完成；头像编辑与通用属性编辑仍缺 |
| 聊天管理 | **已完成（单人聊天）** | 列表、新建、打开、删、重命名、搜索、导入导出、分支和备份已完成；群聊另列 |
| 正则 | **已完成** | 全局 → preset → scoped 三层、编辑器、启停与授权均已接线 |
| 宏 | **已完成（既定 ST 差集）** | date/weekday/timeDiff/reverse/outlet/noop、楼层寻址、预算等旧差集已补齐；保持不二次扫描 |
| Persona | **部分完成** | 多 persona 管理、激活、注入、宏和 WI 扫描已完成；头像、角色锁、persona 书绑定未完成 |
| 生成类型 | **已完成（既定范围）** | send/regenerate/swipe/continue/impersonate 已完成并参与 preset trigger；narrate 未做 |
| 设置与外观 | **已完成（Iris IA）** | 设置按意图组织、三主题、主题包、user.css 与即时切换已落地；不复刻 movingUI 和无消费者键 |
| 连接与凭据 | **已完成 / Iris 有增强** | 多连接档、测试、激活、模型选择、预设绑定均有；凭据不通过 RPC 回显，并按平台安全存储 |
| 摘要 | **已完成（Iris 方案）** | 手动 `/compact` 与 80% 自动压缩可把旧历史折成持久摘要；不是 ST memory 扩展的同款定时器/`{{summary}}` 接口 |
| 楼层动作 | **接缝已完成，provider 未做** | provider 可注册/卸载且零残渣；TTS、翻译、图像、caption 仍是独立项目 |
| 扩展体系 | **部分完成 / 路线不同** | 已有系统插件平台、安装与一个 ST 扩展兼容入口；不提供 ST 的同源任意 JS 通用加载器，按语义兼容和受约束插件路线推进 |
| 多用户 | **未做 / 当前非目标** | 仍是单 profile 启动配置，无登录与运行时账户切换 |
| 群聊 | **未做** | 真实语料仍是零使用，保持独立项目 |
| 文本补全后端 | **未做** | 仍以 OpenAI 兼容 Chat Completion 路线为主；kobold/novel/textgen/horde 与 context/instruct 族应同一项目实现 |

## 2. 重点域的当前事实

### 2.1 世界书

旧版“引擎/存储/RPC 全活，全部无 UI”的结论已失效。当前主线具有：

- 世界书列表、创建、导入、导出、删除与全局选择；
- 聊天级绑定、角色主书与附加书绑定；
- 扫描深度、预算、递归、匹配等设置；
- 条目 30+ 字段编辑、启停、过滤及与 ST 1.18.0 对齐的 15 种排序；
- Agnai、Risu、NovelAI 方言转换；
- 对应 RPC、存储测试、面板测试和真实书往返验收。

当前剩余的是消费者，不是编辑器缺口：`vectorized` 要等向量检索，`automationId` 要等快速回复/自动化；persona 专属书绑定也属于 Persona 的剩余细节。

### 2.2 预设

旧版“全宿主只有一枚 `presetPath`，任务 M 进行中”的结论已失效。当前主线有 profile 级预设库、选择/查看/编辑/保存/删除/读取/导入、提示词排序与启停，以及连接档按预设名切换。`script.getPreset` 也不再只能回答一枚 `in_use`。

仍未覆盖的是另一条产品路线：Text Completion 后端及其 context/instruct/sysprompt/reasoning 文件族，以及 ST 出厂预设 restore。它们不能再被描述成“CC 预设库缺失”。

### 2.3 聊天、生成和备份

单人聊天的迁移和管理链已经闭合：JSONL 导入前整文件校验，导出走实际持久化投影，搜索命中楼层文本，分支关系可恢复；continue 与 impersonate 进入生成类型并驱动 preset triggers；危险写入前的聊天快照可列表、预览、具名确认恢复和删除。

群聊、narrate、附件、TTS、翻译与图像仍未因此自动完成。

### 2.4 正则、宏与 Persona

正则不再是“只有卡内一层”：当前执行顺序为 global → preset → scoped，三层均有相应读取、授权/启停或编辑入口。旧宏差集已经补齐，并保留“不二次扫描替换结果”的安全语义。Persona 已进入存储、面板、提示词槽、深度注入、`{{persona}}` 和世界书扫描；未完成项只剩头像、角色锁和 persona 书绑定。

## 3. 仍可立项的差距

下列项目在当前主线仍是真缺口；具体依赖与验收见 `IMPLEMENTATION-CHECKLIST.md`：

1. Text Completion 后端 + context/instruct 等预设族；
2. RAG / vectors，并消费世界书 `vectorized`；
3. TTS、翻译、图像生成、caption、attachments、expressions 等独立 provider/子系统；
4. Persona 头像、角色锁和 persona 世界书绑定；
5. 角色头像编辑与通用属性编辑；
6. 快速回复/自动化，并消费世界书 `automationId`；
7. 群聊；
8. 多用户/鉴权（若产品目标改变）；
9. 移动端专属紧凑档与 PWA 元数据（当前只有响应式基础）；
10. ST 更多斜杠命令的真实语义，而不是仅有名字或转发入口。

## 4. 基线使用规则

- 立项前先查本文件的“当前状态”和 `IMPLEMENTATION-CHECKLIST.md` 的“已关闭”表。
- 已关闭条目若发现回归，应建“回归修复”，不得重新以“从零实现”立项。
- `automationId`、`vectorized`、楼层动作接缝等必须区分“基础接缝已完成”和“消费者未完成”。
- 本文件不再引用临时 worktree、后台 PID 或“任务 L/M 进行中”；那些不是当前产品状态。
- 每次功能合入若关闭清单项，应在同一变更中回填这两份文档，避免再次形成历史快照陷阱。
