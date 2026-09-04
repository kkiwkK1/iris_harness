# IMPLEMENTATION-CHECKLIST — Iris 追平 SillyTavern 1.18.0 的功能实现清单

任务 K 产出之二。证据与分级见 `ST-COMPARE.md`；本清单把差距翻成**可立项的条目**。

- **排序**：阻断（A）→ 可用但缺细节（B）→ 纯缺失（C）。
- **每项**：ST 行为证据（实机 API / 源码行号）→ Iris 实现方案（落到具体包/文件，能复用的写明复用什么）→ 依赖顺序 → 工作量档位（**S** ≤1 天 / **M** 2–4 天 / **L** 1–2 周 / **XL** >2 周）→ 验收标准。
- **进行中标注**：**世界书 = 任务 L 进行中**（worktree `wt-worldbook`，分支 `dev/feat-worldbook`）；**预设 = 任务 M 进行中**（`wt-preset`，`dev/feat-preset`）。这两项本清单只给对齐验收点，不重复出方案。
- Iris 基线 `3cf858d`；ST 证据一律出自实机 8871（dataRoot `D:\st-8871-data`，PID 28028）。

---

## A. 阻断级

### A1. 世界书用户面板 【任务 L 进行中——对齐验收用】

- **ST 证据**：WI 抽屉（index.html:4659-4830）：世界列表建/导入/导出/重命名/复制/删除；
  `WIMultiSelector` 全局多选（持久 `settings.world_info.world_info.globalSelect`）；
  激活设置 7 滑杆 6 复选（world-info.js:73-82, 938-993）；条目编辑器 30+ 字段
  （index.html:6802-7200：主/副键+四逻辑、逐条覆盖、8 种位置、分组、概率、计时效果、
  automationId、状态灯）；条目列表过滤 + 10 种排序（:4838 起）。
- **Iris 现状**：引擎（`packages/iris-lorebook/src/activate.ts`）、存储与绑定
  （`packages/iris-app-service/src/worldbooks.ts`）、RPC 七方法
  （`worldbook.names/load/get/charNames/globalSelect/setGlobalSelect/replace`，rpc.ts:752-829）
  全部就绪——**只缺壳**。
- **方案**：`apps/iris-web` 新面板走 `iris.sidebar.panels` 插槽（Sidebar 头注明的扩展点），
  全部经现有 RPC，不新增宿主方法（`replace` 已是整书替换原语，编辑器本地草稿批末一次提交）。
- **依赖**：无（RPC 已备）；`worldbook.replace` 的写路径测试先补一道并发编辑护栏。
- **工作量**：**L**（编辑器字段多，但无引擎活）。
- **验收标准**（对齐任务 L）：
  1. 导入 `测试用卡/` 任一书的书 → 面板可见逐条 `comment`/`order`/`position`，与 ST 实机同书逐字段一致；
  2. 改一条 `order` 后重开聊天，激活顺序随 `order` 变化（引擎测试已证，UI 只需证写盘）；
  3. 全局多选勾两本书 → 下一次生成的 `prompt.itemize` 出现两本书的条目，勾掉即消失；
  4. 条目启停（`disable`）立即影响下一次生成；
  5. 与 ST 实机对同一本书做同一次编辑，双方落盘 JSON 除键序外等价。

### A2. 预设存储与切换 【任务 M 进行中——对齐验收用】

- **ST 证据**：8+3 族预设文件按 apiId 读写（`src/endpoints/presets.js:12-45,48-117`：
  save/delete/restore=出厂重置）；settings/get 一次带出全部 `*_setting_names`；
  CC 预设含 `prompts[]+prompt_order[]`；connection-manager 把端点+模型+预设打包
  （本机实配 2 个 profile 在用）。
- **Iris 现状**：解析/装配/计费全备（`packages/iris-preset`、`packages/iris-app-service/src/prompt.ts`、
  `prompt.itemize`）；connection.* 已把 `preset` 作为 profile 字段携带
  （rpc.ts:209-224）但无预设可指——全宿主一枚 `presetPath`。
- **方案**：宿主加"预设库"（profile 级目录，ST 兼容 JSON 原样落盘以保导入导出零损）；
  `settings.get/set` 增预设名与列表；`script.getPreset` 按 name 命中库内预设（现按名拒绝的
  分支改为查库，`'in_use'` 语义不变）；连接档激活时按名取预设重装管线。
- **依赖**：先落存储，再接 connection.activate，最后壳下拉。
- **工作量**：**M**（存储+两处 RPC 扩展；壳件一个下拉）。
- **验收标准**（对齐任务 M）：
  1. 从 ST 安装拷 6 个真实 CC 预设进库 → 逐一切换后 `prompt.itemize` 的行集与 ST 实机同预设同输入逐行对齐（id、label、序）；
  2. 无 `prompt_order` 的预设按文件序、100000-only 的预设走 legacy 回退（现有测试语义不变）；
  3. 连接档 A（预设 X）→ 档 B（预设 Y）一键切，聊天视图无需重开即生效；
  4. `script.getPreset('某名字')` 命中库，拼错仍按名拒绝（不静默换 `in_use`）。

### A3. 聊天导入/导出（ST 迁移路径）

- **ST 证据**：`/api/chats/import|export`（src/endpoints/chats.js:604,696）；聊天=JSONL，首行
  `user_name/character_name/create_date/chat_metadata`；分支以文件名+`main_chat` 记亲。
- **Iris 现状**：持久层就是 ST JSONL 且往返保真（`packages/iris-persistence/src/sillytavern.ts`，
  2454 行键序不变式有测试）——**没有搬运的 RPC**；`ChatSummary.parentChatId`（views.ts）已备承接分支谱系。
- **方案**：新 RPC `chat.import`（base64 JSONL + 所属角色），复用持久层解析；分支聊天按
  `chat_metadata.main_chat` 映射成 `parentChatId`；`chat.export` 反向输出原文 JSONL。
  壳侧 Sidebar 加导入/导出入口。
- **依赖**：无（解析/序列化已存在）；`st-install.ts`（从 ST 安装取绑定书）已示范"指向 ST 目录只读"的模式可抄。
- **工作量**：**M**。
- **验收标准**：
  1. 把本机 ST 的 31 个聊天（含 7 个分支）导入 Iris → 楼数、楼层文本、`swipes`、`extra` 逐楼等价（复用现有往返测试的比对器）；
  2. 分支聊天导入后 Sidebar 归于父聊天之下，跳回父聊天可用；
  3. 导出的 JSONL 被 ST 实机导入后可继续对话（round-trip 双向）；
  4. 非 ST 来源的野 JSONL 拒绝时给出具名错误而非半导入。

---

## B. 可用但缺细节

### B1. 聊天内容搜索

- **ST 证据**：`POST /api/chats/search`（chats.js:874）+ UI"Previous Chats"过滤。
- **Iris 方案**：宿主 `chat.search`（线性扫 profile 聊天文件的楼文本即可起步，无需索引）；
  Sidebar 聊天 tab 顶部一个过滤框。
- **依赖**：无。**工作量**：**S**。
- **验收**：在 677 楼长局中按消息片段命中并定位；无结果时不伪命中；10 MiB 级文件 <1 s。

### B2. continue / impersonate 生成类型

- **ST 证据**：生成类型是装配的一等公民（prompt triggers 过滤，index.html:7262+；
  utility prompts：`continue_nudge_prompt`/`impersonation_prompt`，openai.js:1358-1370）。
- **Iris 方案**：`chat.send` 增 `kind: 'continue'|'impersonate'`（rpc.ts 的 `chat.send` 入参扩枚举）；
  装配侧 continue=取末楼续写（禁 `post_history_instructions` 之后的收尾）、
  impersonate=以 `{{user}}` 视角生成并写 user 行；预设 triggers 过滤此时才有消费者。
- **依赖**：A2（triggers 过滤需要多预设才有意义，但功能可先于 A2 落）。
- **工作量**：**M**。
- **验收**：continue 的结果拼回原楼且 swipe 历史保留；impersonate 产 user 行、MVU 变量通路不串；
  带 `impersonate` trigger 的预设条目只在该类型出现。

### B3. 全局正则层

- **ST 证据**：`extension_settings.regex` 全局层 + 角色 scoped + 预设 scoped 三层
  （`extensions/regex/index.js:11` 的 SCRIPT_TYPES/	getScriptsByType）。
- **Iris 方案**：`scriptsByType` 已为三层排序预留（app-service/regex.ts:50 原文注释）；
  加 profile 级全局正则存储 + `regex.list/set` RPC + 壳管理面板。
  本机实配全局 0 条——存储格式照 ST 原样以零损迁移。
- **依赖**：无（引擎 `@iris/regex` 完整）。**工作量**：**M**。
- **验收**：ST 导出的 `regex-*.json` 导入即生效；三层排序与 ST 引擎一致（先全局后卡内，
  以 orderScripts 现测试为准）；display/prompt 两向接线复用现有管线测试。

### B4. 宏差集补齐

- **ST 证据**：`macros.js` 36 内建；实抓清单含 `{{date}}/{{weekday}}/{{timeDiff}}/{{reverse}}/
  {{isotime}}/{{isodate}}/{{outlet}}/{{noop}}/{{key}}/{{lastSwipeId}}/{{currentSwipeId}}/
  {{firstIncludedMessageId}}/{{firstDisplayedMessageId}}/{{allChatRange}}/{{maxContext}}/{{maxResponse}}`。
- **Iris 方案**：`packages/iris-macro/src/builtins.ts` 现有 31 个，逐个补差集；
  楼层寻址族接 `@iris/chat` 的楼层视图（FLOOR-VARIABLES 已统一 messageId 语义）；
  `{{outlet}}` 接 lorebook 的 outlet 桶（activate.ts 已产桶，只差宏侧出口）。
- **依赖**：无。**工作量**：**S**。
- **验收**：对 ST 实机做同输入宏对照表（36 项逐行 diff 全绿）；`{{noop}}` 恒空、
  `{{reverse}}` 不触发二次宏扫描（守住优势区不变式）。

### B5. Persona（用户人格）

- **ST 证据**：`power_user.personas`（多人格+头像）、`persona_description`+
  `persona_description_position`、`persona_description_lorebook`（人格书）、`{{persona}}` 宏、
  人格描述参与 WI 扫描（GlobalScanData.personaDescription，Iris 已有形参）。
- **Iris 方案**：profile 级 persona 存储 + `persona.get/set`；装配侧把 personaDescription
  marker 的空槽填上（ST 的 IN_PROMPT 档位；EARLY 档位映射 depth 注入）；
  `GlobalScanData.personaDescription` 已是 activate.ts 入参——通了宏与扫描两处消费者。
- **依赖**：B4（{{persona}} 宏）。**工作量**：**M**。
- **验收**：写人格描述后 itemize 出现 personaDescription 行、宏展开正确、WI 副键能被人格描述触发；
  本机用户实配空描述 → 行为零变化（不改默认行为）。

### B6. 设置面扩容

- **ST 证据**：`power_user` 83 键（实机 settings/get 枚举）；ST 设置被抱怨的点是组织而非数量
  （ROADMAP"明确不照抄"）。
- **Iris 方案**：按 `SETTINGS.md` 的"负用量发现 + 10 项 IA 草案"执行，映射进
  `GenerationSettings`/profile 配置；每暴露一键都要有真实消费者（章程：不做"看起来做了"的键）。
- **依赖**：无。**工作量**：**M**（逐键）。
- **验收**：IA 草案的 10 组各有至少一键落地且 `settings.get/set` 往返；未暴露的键不出现在任何文档里。

### B7. 主题与外观（slot 上的等价物）

- **ST 证据**：`themes/` 8 套出厂、movingUI 拖拽、`user.css`、blur/配色 10+ 键。
- **Iris 方案**：不搬 movingUI；把"主题=token 表 + user.css=slot 内容"落在现有 slot 系统
  （apps/iris-web/src/slots/）与 theme/ 目录上；主题包格式自定但支持导出。
- **依赖**：B6。**工作量**：**M**。
- **验收**：暗/亮之外可加第三套主题且切换免刷新（与 i18n 切换同机制）；slot 注入的 CSS 不溢出阅读区（overlay 约束既有测试兜底）。

### B8. 角色多书绑定（charLore.extraBooks）

- **ST 证据**：`world_info.charLore[]` 按角色文件名追加多本书，参与 getCharacterLore
  （world-info.js:4363-4417）；`world_button` 长按弹"Link to World Info"。
- **Iris 方案**：`WorldbookStore` 加角色→附加书名数组（profile 级，不写卡文件——守住
  "运行时状态不进共享卡文件"裁定）；`resolveCardWorldbook` 扩为 primary+additional 有序合并
  （保持"永不双拼"裁定只对 embedded/named 生效，附加书是用户显式行为）。
- **依赖**：A1（面板承载绑定交互）。**工作量**：**M**。
- **验收**：给角色挂第二本书后扫描候选含其条目（`ScanEntry.world` 区分来源）；解绑不留残键；
  与 ST 实机同操作同结果。

### B9. WI 导入方言（Agnai/Risu/NovelAI）

- **ST 证据**：三个转换器 `convertAgnaiMemoryBook`/`convertRisuLorebook`/`convertNovelLorebook`
  （world-info.js:5358/:5403/:5448），导入时按文件特征分派。
- **Iris 方案**：`packages/iris-lorebook/src/parse.ts` 加三转换器（纯函数，输出统一 Lorebook）。
- **依赖**：无。**工作量**：**S**（各转换器上游都是几十行的字段映射）。
- **验收**：三种方言样本各一，转换后条目数与关键批注一致；归一化走现有 addMissing 语义（超集不变式）。

### B10. 楼层级动作扩展（TTS/翻译/图像/嵌入）

- **ST 证据**：Message Actions 全集（index.html Message Actions 区）；背后是 tts/translate/sd/caption 四扩展。
- **Iris 方案**：先把**接缝**建好（楼层动作菜单走 `iris.message.actions` 类 slot，现有 ScriptButtons 的模式），
  各 provider 独立立项；TTS/翻译的 provider 面可复用 `@iris/llm-openai-compat` 的多端点思路。
- **依赖**：无（接缝）；各 provider 各自立项。**工作量**：接缝 **S**，每 provider **M/L**。
- **验收**：接缝落地后，无任何 provider 时菜单不出现（零残渣）；装一个 demo provider 端到端可见。

### B11. 数据与凭据安全面（ST 明文 vs Iris 已优）

- **ST 证据**：官方文档自认密码非安全特性、`secrets.json` 明文（src/endpoints/secrets.js 全套）。
- **Iris 方案**：保持 config 注入；如需 UI 化，走宿主内存 + 不落盘（记 DEVIATIONS：不提供 ST 的 secrets 端点）。
- **依赖**：无。**工作量**：**S**（主要是把"不做"写清）。
- **验收**：任何 RPC 不回显凭据（传输边界测试加一条断言）。

---

## C. 纯缺失（语料零使用或独立子系统——立项需先量真实需求）

| # | 项 | ST 证据 | Iris 方案草图 | 依赖 | 档 | 验收锚点 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 快速回复 | QR 扩展 sets/slots/autoExecute/showInOptions（quick-reply/index.js:71-78；本机禁用全空） | 不复刻；卡按钮（ScriptButtons）已是升级形态。若立项：QR=宿主存的消息模板+发送 | B2 | M | 导入 ST QR 集 → 逐条可发 |
| C2 | 斜杠命令扩容 | ~290 命令（ROADMAP 计数）；语料仅 `/trigger`(3 卡)`/send`(2 卡) | `script.slash` 白名单按 UPSTREAM-SLASH 逐步扩；每命令先证语料调用点 | 无 | S/批 | 每命令带上游语义测试 |
| C3 | RAG / vectors | vectors 扩展 + vectra 索引 + 多嵌入后端 | 独立立项：分块→嵌入→注入 `3_vectors` 槽（装配位已留） | B5 | XL | 真语料检索命中率报告 |
| C4 | 摘要（memory） | memory 扩展定期摘要+深度注入+`{{summary}}` | 同上，产出落 depth 注入与宏 | B2/B4 | L | 长局摘要回归（变量不丢） |
| C5 | TTS / speech | tts/speech 扩展、per-楼播放 | provider 独立立项，走 B10 接缝 | B10 | M/家 | 播放不阻塞楼层渲染 |
| C6 | 图像生成（sd/gallery） | sd 扩展 + Comfy workflow 文件（出厂即带两个 workflow） | 同上 | B10 | L | 生成图进 `extra` 保真往返 |
| C7 | 翻译 / caption | translate/caption 扩展 | 同上 | B10 | M | 翻译不改原文存储（易失层） |
| C8 | 表情分类 / 立绘 sprites | expressions（transformers.js/LLM 判定）、sprites 目录 | 独立立项；本地模型跑在宿主侧 | — | XL | 情绪→立绘映射对语料抽查 |
| C9 | 数据银行 attachments | attachments 扩展（网页/YouTube 抓取→附带文件） | 独立立项；沙箱文件授予按卡 | — | L | 抓取物只对授权卡可见 |
| C10 | 群聊 | GROUPS.md：三模式（SWAP/APPEND/APPEND_DISABLED）、swipe 走"上一条是谁说的" | 语料零使用零义务（ROADMAP Tier 2 裁决）；立项从 GROUPS.md 接 | — | XL | 存储契约与三模式测试先行 |
| C11 | 文本补全后端 + instruct/context 族 | textgen/kobold/novel/horde 后端；context(34)/instruct(38) 出厂预设；story_string 仅 TC 路径 | 裸 `/completions` 管线独立立项，context+instruct 一体跟走（ROADMAP 1.5 裁决） | — | XL | 对 ST 实机同输入逐 token 对照 |
| C12 | 多用户/鉴权 | users-public/private/admin 三组端点；实机 list 返回 default-user | 明确非目标（PLAN.md）；存储层 profilePaths 已成形，缺的只是切换契约与登录 | — | M（若立项） | profile 切换不串存储 |
| C13 | 通用扩展加载器 | third-party 扩展同源任意 JS（刻意不照抄） | 不做；生态兼容走"逐扩展语义兼容"路线（ST-Prompt-Template/TavernHelper 模式） | — | — | 每兼容一个扩展 = 一份差分验收 |
| C14 | WI automationId / vectorized 消费 | automationId→QR 钩子；vectorized→vectors 扩展 | 消费者分别是 C1/C3；标志位已在 `WorldbookEntry` 透传 | C1/C3 | S | 消费者落地时接线 |
| C15 | 角色标签管理/收藏/排序 | tags+tag_map、sort_field/sort_order、收藏星标 | CharacterSummary.tags 已携带；补管理 UI+过滤 | 无 | S | 过滤后列表与 ST 一致 |
| C16 | 角色复制/重命名/导出 | characters 组 duplicate/rename/export 端点 | `character.duplicate/rename/export` 三 RPC（`@iris/character` 编码已有） | 无 | S | 重命名不断世界书绑定（名字 verbatim 规则） |
| C17 | 备份视图 | /api/backups/chat/* + backups/ 目录轮转 | profile 级快照 + 壳视图；Iris 聊天文件本身即备份单位 | A3 | M | 恢复演练一次成真 |
| C18 | 移动端专属档 | mobile-styles.css、Compact Input Area、PWA 元数据 | 响应式断点 + 输入区紧凑档（shell 已折叠 Sidebar） | B7 | M | 375px 宽全流程可用 |

---

## 依赖总图（粗粒度）

```
A1 世界书面板(任务L) ─┬─ B8 多书绑定
A2 预设库(任务M) ──────┼─ B2 continue/impersonate（triggers 消费者）
A3 聊天导入导出 ───────┴─ C17 备份视图
B4 宏差集 ── B5 persona ── C4 摘要
B10 楼层动作接缝 ── C5/C6/C7/C8/C9 各 provider
C3 vectors / C10 群聊 / C11 文本补全 —— 各自独立立项
```

## 工作量汇总

- **S**：B1、B4、B9、B11、C2、C14、C15、C16（8 项，合计约两周内可清完）
- **M**：A3、B2、B3、B5、B6、B7、B8、B10 接缝、C12、C17、C18
- **L**：A1（任务 L 进行中）、C4、C6、C9
- **XL**：C3、C8、C10、C11、C13（明确不做）

## 与进行中任务的对齐说明

- **任务 L（wt-worldbook）**：本清单 A1 不出方案，只给 5 条对齐验收点；B8 依赖其面板先行。
- **任务 M（wt-preset）**：本清单 A2 不出方案，只给 4 条对齐验收点；B2 的 triggers 过滤是其自然延伸。
- 两任务收口后应回填本清单的验收状态，而不是另开文档。
