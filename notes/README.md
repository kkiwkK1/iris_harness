# notes/ —— 索引

`docs/` 是**活的描述**：它描述 `main` 上现在的样子，代码变了就改它。`notes/` 是**带日期的记录**：某天对着上游 SillyTavern 或某个 Iris 提交量出来的事实、按时间追加的偏离账本、以及某一轮的计划与交接。

因此两者的失效方式不同：`docs/` 里的过期句子是 bug，`notes/` 里的过期句子是历史。**记录永远不为了追上代码而被改写**——发现记录与现状不符时，写一份新的记录，或者往对应的 `DEVIATIONS.md` 追加一条，而不是回去修那份旧的。

每份文件的标题下都有一行 `> 状态：…`，写明它是记录、有效、已被取代还是已归档，以及它测量的日期与对象。下表是同一批信息的目录。

「现在还差什么」这个问题：接口与插件面看 [`docs/INFRASTRUCTURE-INTERFACES.md`](../docs/INFRASTRUCTURE-INTERFACES.md) §8，对照 SillyTavern 的功能面看 [ST-COMPARE.md](ST-COMPARE.md) 与 [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md)。

---

## 一、偏离账本（6）

追加式记录，一条一节，写明上游做法、我们的选择与代价。**不改旧条目**，新事实是新的一节。本索引不为它们加状态行——账本的状态就是它自己最后一条。

| 文件 | 内容 | 最后追加 |
| --- | --- | --- |
| [DEVIATIONS.md](DEVIATIONS.md) | 标题写的是「任务 M：预设功能补全（对照 ST 1.18.0）」，但后来的条目早已越出预设范围，是宿主/预设侧的通用账本。标题未改，因为它是这份账本当初立账的名字 | 2026-09-15 |
| [apps/iris-web/DEVIATIONS.md](apps/iris-web/DEVIATIONS.md) | 界面与卡片沙箱侧的偏离账（最长的一本） | 2026-09-16 |
| [packages/iris-app-service/DEVIATIONS.md](packages/iris-app-service/DEVIATIONS.md) | 宿主侧的偏离账 | 2026-09-16 |
| [packages/iris-compat-prompt-template/DEVIATIONS.md](packages/iris-compat-prompt-template/DEVIATIONS.md) | 对 ST-Prompt-Template v1.17.4.1 的偏离账 | 2026-09-11 |
| [packages/iris-rpc-host/DEVIATIONS.md](packages/iris-rpc-host/DEVIATIONS.md) | 传输层（含 Host 头与绑定策略）的偏离账 | 2026-09-11 |
| [packages/iris-variables/DEVIATIONS.md](packages/iris-variables/DEVIATIONS.md) | 变量系统的偏离账 | 2026-09-11 |

## 二、研究与测量记录（52）

某天对着某个对象量出来的事实。状态一律是**记录**：它描述那一天，不描述今天。

### 2.1 根目录（11）

| 文件 | 内容 | 测量于 | 被谁取代 |
| --- | --- | --- | --- |
| [AUDIT-CORDIS.md](AUDIT-CORDIS.md) | 对最近合入的 A–J 十项功能做 Cordis 插件纪律审计（是否绕过生命周期/组合根/可卸载） | 2026-09-07（对象 `c9dfa37`） | — |
| [CORDIS-TREE.md](CORDIS-TREE.md) | Cordis 组合树导览，写给第一次接触 Cordis 的人，附术语表 | 2026-09-11 | — |
| [GROUPS.md](GROUPS.md) | 上游群聊机制速写；结论是语料对群聊的兼容义务为零，维持 deferred | 2026-09-02 | — |
| [METHODS.md](METHODS.md) | 工作方法：每条规则都由本仓库的一个真实 bug 付过学费（语料定理、计数课、静默失败纪律） | 2026-09-07 | — |
| [PLUGIN-FEASIBILITY.md](PLUGIN-FEASIBILITY.md) | 把酒馆助手与 MVU 剥离为插件的可行性与难度，逐文件盘点 | 2026-09-12（对象 `2d80c7f`） | — |
| [SECURITY-REMEDIATION.md](SECURITY-REMEDIATION.md) | 两份外部审计 34 条发现逐条的处置状态与证据 | 2026-09-11 | — |
| [SETTINGS-IA.md](SETTINGS-IA.md) | 设置面的信息架构设计输入：每一项接哪个 RPC、建不建、不建的理由 | 2026-09-02（2026-09-11 补落地说明） | — |
| [SYSTEM-PLUGINS-ACCEPTANCE.md](SYSTEM-PLUGINS-ACCEPTANCE.md) | 系统插件抽取的交付归属记录；结果不在这里，在两份验收记录里 | 2026-09-15（对象 `2eccf30`） | — |
| [TEST-CARDS.md](TEST-CARDS.md) | 验收语料地图：每张卡能测到什么、测不到什么（只记形状不记内容） | 2026-09-07 | — |
| [UPSTREAM-THEME-VARS.md](UPSTREAM-THEME-VARS.md) | 上游主题 CSS 变量，以及卡的前端能不能看见它们 | 2026-09-06 | — |
| [RESEARCH-3D-SCENES-2026-09-16.md](RESEARCH-3D-SCENES-2026-09-16.md) | 「文字生成 3D 场景」的应用与行业经验调研：模型侧（Astra 代码生成、Blender MCP、布局 DSL 研究）、资产侧（文生 3D 服务、Roblox Cube、世界模型）、浏览器侧（glTF、three.js、A-Frame、3DGS）、聊天产品现有 3D 面（ST VRM/Live2D），供构思阶段用 | 2026-09-16 | —— |

### 2.2 界面与沙箱（`apps/iris-web/`，15）

| 文件 | 内容 | 测量于 |
| --- | --- | --- |
| [apps/iris-web/BODY-TAG.md](apps/iris-web/BODY-TAG.md) | 正文标签：预设教给模型的纯提示词约定，Iris 把它变成显示层机制（折叠不删除） | 2026-09-07 |
| [apps/iris-web/CARD-SURFACE.md](apps/iris-web/CARD-SURFACE.md) | 卡能够到的四个面的现状与口径，含两个此前没人扫过的语料群 | 2026-09-11 |
| [apps/iris-web/CHAT-WRITES.md](apps/iris-web/CHAT-WRITES.md) | 卡对 `getContext().chat` 的写：语料里的 8 处写点与宿主 arm 设计 | 2026-09-07 |
| [apps/iris-web/COHABITATION.md](apps/iris-web/COHABITATION.md) | 卡脚本共居 realm：`initializeGlobal` / `waitGlobalInitialized` 的上游形状 | 2026-09-07 |
| [apps/iris-web/GRANTS.md](apps/iris-web/GRANTS.md) | 通往自动运行路上的权限陷阱，每个都在本仓库真实发生过 | 2026-09-07 |
| [apps/iris-web/INLINE-HTML.md](apps/iris-web/INLINE-HTML.md) | 消息正文的内联 HTML：上游地板实测、该收紧到哪、`<style>` 作用域方案 | 2026-09-02 |
| [apps/iris-web/OVERLAY-CARDS.md](apps/iris-web/OVERLAY-CARDS.md) | 覆盖层卡（V1.5.4 测试版）：19 卡语料里没有的一族界面宿主 | 2026-09-02 |
| [apps/iris-web/OVERLAY-HOST.md](apps/iris-web/OVERLAY-HOST.md) | 覆盖层宿主三方案并排；把「覆盖层能跑」与「`parent.Mvu` 能读」拆成两件事 | 2026-09-07 |
| [apps/iris-web/PRESET-WEIGHT.md](apps/iris-web/PRESET-WEIGHT.md) | `message-preset.js` 2.29 MB 的瘦身设计输入 | 2026-09-02 |
| [apps/iris-web/RENDER.md](apps/iris-web/RENDER.md) | 消息帧渲染设计（上游逐行测量 + 我们的五步），写在代码之前 | 2026-09-07 |
| [apps/iris-web/SCRIPT-BUTTONS.md](apps/iris-web/SCRIPT-BUTTONS.md) | 脚本按钮：上游渲染位置、点击如何变成事件、`visible` 语义与增删时序 | 2026-09-02 |
| [apps/iris-web/UPSTREAM-ESM-DEPS.md](apps/iris-web/UPSTREAM-ESM-DEPS.md) | 上游怎么解析卡自带的 ESM 依赖（答案：它不需要做任何事） | 2026-09-03 |
| [apps/iris-web/UPSTREAM-FRAME-ORIGIN.md](apps/iris-web/UPSTREAM-FRAME-ORIGIN.md) | 卡 frame 里的 `localStorage` 是谁的存储（答案：ST 页面的，全体共用） | 2026-09-03 |
| [apps/iris-web/UPSTREAM-SLASH.md](apps/iris-web/UPSTREAM-SLASH.md) | 三条 slash 命令与管道；语料 22 个真实调用只用 3 条 | 2026-09-03 |
| [apps/iris-web/WINDOWING.md](apps/iris-web/WINDOWING.md) | 阅读视图窗口化设计：N 取多少、预算超了怎么办、窗口滑动时 frame 的生死 | 2026-09-02 |

### 2.3 宿主与各包（18 + 4）

| 文件 | 内容 | 测量于 | 被谁取代 |
| --- | --- | --- | --- |
| [packages/iris-app-service/BRIDGE.md](packages/iris-app-service/BRIDGE.md) | 卡自己的生成调用如何桥回宿主；归档规格，正文明说尚未实现 | 2026-09-07 | — |
| [packages/iris-app-service/CACHE-CENSUS.md](packages/iris-app-service/CACHE-CENSUS.md) | 前缀缓存全语料归因普查：哪些原因、各损失多少 token | 2026-09-08 | — |
| [packages/iris-app-service/CACHE-PREFIX.md](packages/iris-app-service/CACHE-PREFIX.md) | 前缀缓存的一次测量，以及能做与不能做的事 | 2026-09-08 | §3 的提案已实现（默认开），账本见 `packages/iris-app-service/DEVIATIONS.md` §38；文首已自述 |
| [packages/iris-app-service/CACHE-TARGET.md](packages/iris-app-service/CACHE-TARGET.md) | ≥95% 命中率怎么算达标的测量协议 | 2026-09-08 | — |
| [packages/iris-app-service/EMBEDDED-BOOK-MATERIALISATION.md](packages/iris-app-service/EMBEDDED-BOOK-MATERIALISATION.md) | 内嵌世界书物化方案：怎么做、卡更新了怎么办、已导入的怎么办 | 2026-09-03 | — |
| [packages/iris-app-service/FIRST-RUN.md](packages/iris-app-service/FIRST-RUN.md) | 从未用过的 profile 会发生什么，对着专门造的空 profile 量 | 2026-09-07 | — |
| [packages/iris-app-service/FLOOR-ADDRESSED-VARIABLES.md](packages/iris-app-service/FLOOR-ADDRESSED-VARIABLES.md) | 脚本 frame 的楼层寻址变量读写；量完发现派单的问题不成立 | 2026-09-07 | — |
| [packages/iris-app-service/FLOOR-VARIABLES.md](packages/iris-app-service/FLOOR-VARIABLES.md) | 楼层变量通路的设计输入（两条路都不通的那个缺口） | 2026-09-02 | — |
| [packages/iris-app-service/IMPORT-DUPLICATION.md](packages/iris-app-service/IMPORT-DUPLICATION.md) | 导入侧一份表存两遍，第二份到底买到了什么 | 2026-09-07 | — |
| [packages/iris-app-service/LONG-CHAT-VARIABLES.md](packages/iris-app-service/LONG-CHAT-VARIABLES.md) | 长局变量：上游的清理、我们的开销，以及两者不是同一个问题 | 2026-09-02 | — |
| [packages/iris-app-service/SNAPSHOT-TRANSPORT.md](packages/iris-app-service/SNAPSHOT-TRANSPORT.md) | 快照怎么过边界，三个候选并排（克隆代价跟对象个数走，不跟字节走） | 2026-09-07 | — |
| [packages/iris-app-service/ST-BOOK-FETCH.md](packages/iris-app-service/ST-BOOK-FETCH.md) | 从用户的 SillyTavern 装机取一本卡指名的绑定书 | 2026-09-03 | — |
| [packages/iris-app-service/UPSTREAM-A-TIER.md](packages/iris-app-service/UPSTREAM-A-TIER.md) | A 级三格的上游真值：世界书编辑器保存路径 / 预设八族 / 聊天导入导出 | 2026-09-07 | — |
| [packages/iris-app-service/UPSTREAM-INJECT-AND-CHAT-BOOK.md](packages/iris-app-service/UPSTREAM-INJECT-AND-CHAT-BOOK.md) | 上游的运行时提示词注入与 chat 世界书 | 2026-09-03 | — |
| [packages/iris-app-service/UPSTREAM-MVU-INIT-PATH.md](packages/iris-app-service/UPSTREAM-MVU-INIT-PATH.md) | MVU 的初始化路径与路上那两个具名缺席的成员 | 2026-09-03 | — |
| [packages/iris-app-service/UPSTREAM-PERSONA.md](packages/iris-app-service/UPSTREAM-PERSONA.md) | Persona 存在哪、几个出口、哪些出口改了文本 | 2026-09-07 | — |
| [packages/iris-app-service/UPSTREAM-VARIABLE-ADDRESSING.md](packages/iris-app-service/UPSTREAM-VARIABLE-ADDRESSING.md) | 楼层变量寻址：`message_id` 的取值域，以及读写两路对 `'latest'` 的不同解释 | 2026-09-03 | — |
| [packages/iris-app-service/WORLDBOOKS.md](packages/iris-app-service/WORLDBOOKS.md) | 角色世界书从哪来、两个来源谁赢、卡脚本能对书做什么 | 2026-09-02 | — |
| [packages/iris-character/UPSTREAM-IMPORT-SHAPES.md](packages/iris-character/UPSTREAM-IMPORT-SHAPES.md) | 角色卡导入端点对三种边缘形状（webp / 无 chunk 的 PNG / JPEG）的实际行为 | 2026-09-07 | — |
| [packages/iris-compat-prompt-template/SNAPSHOT.md](packages/iris-compat-prompt-template/SNAPSHOT.md) | 填一个 `Snapshot`：宿主侧接缝的契约，以及文本在到达之前必须发生过什么 | 2026-09-07 | — |
| [packages/iris-preset/PARITY-HOWTO.md](packages/iris-preset/PARITY-HOWTO.md) | 怎么证明「预设在 Iris 里不如在 ST 里有效」：抓两边请求逐字节对齐 | 2026-09-09 | — |
| [spike/RESULTS.md](spike/RESULTS.md) | 阶段 0 技术验证结果：五道关全部通过，方案不需要回退 | 2026-09-07 | — |

### 2.4 ST 兼容施工（`st-compat/`，4）

| 文件 | 内容 | 测量于 |
| --- | --- | --- |
| [st-compat/CONSTRUCTION-REPORT-2026-09-13.md](st-compat/CONSTRUCTION-REPORT-2026-09-13.md) | 收口记录对照、首次全量门证据、新 profile boot 修复，以及落点 3 落地的追记 | 2026-09-13 |
| [st-compat/CONSTRUCTION-REPORT-INSTALLER-RUNTIME.md](st-compat/CONSTRUCTION-REPORT-INSTALLER-RUNTIME.md) | P2 安装器运行时闭环：默认不执行扩展代码的完整安装系统 | 2026-09-13 |
| [st-compat/pilot-lock.md](st-compat/pilot-lock.md) | P0 锁定：ST / TH / MVU / ST-Prompt-Template 的版本、commit、sha256 与许可证 | 2026-09-13 |
| [st-compat/pilot-use-cases.md](st-compat/pilot-use-cases.md) | P3 试点的验收剧本（UC-1/2/3 的可观察判定，不预设实现） | 2026-09-13 |

## 三、计划 / 状态 / 交接（8）

| 文件 | 内容 | 写于 | 状态 | 被谁取代 |
| --- | --- | --- | --- | --- |
| [ST-COMPARE.md](ST-COMPARE.md) | Iris 对照 SillyTavern 1.18.0 的当前基线：现在还差什么 | 2026-09-15（`269a97e`） | **有效** | — |
| [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md) | 同一次重新基线的清单侧：已关闭 / 部分完成 / 未做 / 非目标 | 2026-09-15（`269a97e`） | **有效** | — |
| [st-compat/README.md](st-compat/README.md) | `notes/st-compat/` 的 P0 派工单与文件索引 | 2026-09-14 | **有效**（目录索引） | — |
| [st-compat/PILOT-DESIGN.md](st-compat/PILOT-DESIGN.md) | P3 兼容试点的施工契约；产品源码至今引用它作映射面的规格 | 2026-09-13 | **有效**（契约） | — |
| [ROADMAP.md](ROADMAP.md) | 功能差距与排期，以及一串产品裁决 | 2026-09-09 | 部分被取代 | 「当前状态」与队列各节 → [ST-COMPARE.md](ST-COMPARE.md) / [IMPLEMENTATION-CHECKLIST.md](IMPLEMENTATION-CHECKLIST.md)（2026-09-15 重新基线，明确推翻本文引用的 `3cf858d` 快照）；产品定位与各条裁决仍有效 |
| [PLAN.md](PLAN.md) | 立项设计：为什么换掉 ST 的地基、为什么选 Cordis、MVP 范围 | 建仓初期 | 部分被取代 | 文末「未完成」一节 → 同上两份；架构现状 → [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)。因 `scripts/pack-contracts.mjs` 引用其路径而留在原地 |
| [PLUGIN-CONTRACT-LANDING-SITES.md](PLUGIN-CONTRACT-LANDING-SITES.md) | 第二批四个施工落点的底稿（切面设计草案、风险、工作量） | 2026-09-12 | 已被取代 | PR #88（`2eccf30`）的实现与 [`docs/INFRASTRUCTURE-INTERFACES.md`](../docs/INFRASTRUCTURE-INTERFACES.md) §8。因源码注释引用其路径而留在原地 |
| [SYSTEM-PLUGINS-HANDOFF.md](SYSTEM-PLUGINS-HANDOFF.md) | 系统插件控制面的实施交接：分工、检查单、必须保持的行为合同 | 2026-09-12 | 已被取代（「行为合同」一节除外） | 同上。因源码注释引用其路径而留在原地 |

## 四、验收记录（5）

一次验收跑出来的读数与判定。与第二类同理：它记录那一次，不记录今天。

| 文件 | 内容 | 验收于 | 对象 |
| --- | --- | --- | --- |
| [QA-REPORT.md](QA-REPORT.md) | 合并版六卡回归验收：每卡一行结论、三处已修、四项已记录不修 | 2026-09-04 | `dev/iris-exploration` @ `d5d0418` |
| [packages/iris-app-service/MVU-ACCEPTANCE.md](packages/iris-app-service/MVU-ACCEPTANCE.md) | 用一次真实生成验收 chat 级 MVU 折叠（判据预先写死，所以这一跑能失败） | 2026-09-07 | Iris 的 MVU 通路（爱衣卡） |
| [PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md](PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md) | 插件平台联合验收：宿主运行时、动态 RPC、`/plugins` 资产面、成员合并、旧 revision 隔离 | 2026-09-13 | `dev/system-plugins` @ `4ade2b2` |
| [st-compat/PILOT-REPORT.md](st-compat/PILOT-REPORT.md) | ST 扩展兼容试点联合验收：UC-1/2/3、故障与 revision 隔离、卸载、ST 1.18.0 同输入对照 | 2026-09-14 | `dev/st-compat-pilot` @ `065cc02`，ST-Prompt-Template `f9a07da` |
| [PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md](PLUGIN-INSTALL-ACCEPTANCE-2026-09-15.md) | 系统插件安装路径的浏览器验收（真 Chrome + CDP，装—同意—启用—卸载走完） | 2026-09-15 | `dev/plugin-install-center`（`main` `1066381` + PR-3 工作树） |

## 五、任务单（1）

| 文件 | 内容 | 写于 | 状态 |
| --- | --- | --- | --- |
| [INFRA-TASKS-2026-09-15.md](INFRA-TASKS-2026-09-15.md) | 基建第二批六项（U1–U6）的派工单：分支、预留 ledger 号、牙齿要求、门禁 | 2026-09-15（基线 `e03adbb`） | 六项全部落地（PR #101–#106）；施工文档按决定留在未合入的分支 `dev/infra-task-docs-batch-2` |

## 六、法务（1）

| 文件 | 内容 | 写于 | 状态 |
| --- | --- | --- | --- |
| [LICENSE-INVENTORY.md](LICENSE-INVENTORY.md) | 上游许可证、我们的移植面、依赖清单；`AGPL-3.0-only` 裁定的输入 | 2026-09-07 | 记录（正文未改动） |

## 七、已归档（`archive/`，5）

工作已经完成或结论已被后来的记录关闭的计划与交接。放在这里是因为它们不再指导任何工作，但仍然解释「当时为什么这么做」。**只有能点名接替者的文件才会被归档。**

| 文件 | 原路径 | 内容 | 被谁取代 |
| --- | --- | --- | --- |
| [archive/ACTION-PLAN.md](archive/ACTION-PLAN.md) | `notes/ACTION-PLAN.md` | `dev/iris-exploration` 的四路并行修改计划（C/F/E/D） | 该分支 2026-09-06 以 `b50c354` 合入；D 路见 [QA-REPORT.md](QA-REPORT.md)，E 路见 [UPSTREAM-IMPORT-SHAPES.md](packages/iris-character/UPSTREAM-IMPORT-SHAPES.md)，C/F 的结论进了 [界面账本](apps/iris-web/DEVIATIONS.md) |
| [archive/NOTES-handoff.md](archive/NOTES-handoff.md) | `notes/NOTES-handoff.md` | 任务 B（渲染生命周期）留给任务 A 的观测交接 | §1 由 MVU 聊天级五件活关闭（[ROADMAP.md](ROADMAP.md) 队列第 3 项）；§2 的 zeoseven 字体由 2026-09-06「远程样式表走宿主代理」裁定关闭（[界面账本](apps/iris-web/DEVIATIONS.md) §41） |
| [archive/MD-INVENTORY.md](archive/MD-INVENTORY.md) | `notes/MD-INVENTORY.md` | 2026-09-06 的全仓 `.md` 盘点与那次搬迁的落地差异 | 本文件（`notes/README.md`）是它的后继 |
| [archive/DISPATCH-plugin-client-runtime.md](archive/DISPATCH-plugin-client-runtime.md) | `notes/DISPATCH-plugin-client-runtime.md` | 落点 3（插件客户端运行环境）的派工单 | 落点 3 已落地（`dev/plugin-client-runtime` @ `4fab477`），记录见 [CONSTRUCTION-REPORT-2026-09-13.md](st-compat/CONSTRUCTION-REPORT-2026-09-13.md) 追记二 |
| [archive/HANDOFF.md](archive/HANDOFF.md) | `notes/st-compat/HANDOFF.md` | 任务 C（ST-Prompt-Template P3 试点）的交接：现状、踩平的坑、剩余工作 | [st-compat/PILOT-REPORT.md](st-compat/PILOT-REPORT.md)：§4 列的四项剩余工作在那份验收里全部有判定 |

---

## 维护规则

1. **新增一份 `notes/` 文件，就在上表加一行**，并在标题下写一行 `> 状态：…`（记录写明测量日期与对象；计划写明有效或被谁取代）。
2. **不要为了让记录符合当前代码而修改它。** 事实变了就写新记录，或往对应的 `DEVIATIONS.md` 追加一节。
3. 归档一份文件要能**点名接替者**（哪个 PR、哪份文档、哪条账本条目）。点不出来就不是「被取代」，只是「旧」，旧不是归档的理由。
4. 移动任何文件之前先查它是否被源码注释按路径引用（`git grep -l "<路径>" -- '*.ts' '*.tsx' '*.mjs'`）；被引用的留在原地，只加状态行。守门的是 `apps/iris/tests/md-references.test.ts`。
