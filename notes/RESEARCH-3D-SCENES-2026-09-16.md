# 调研 · 文字生成 3D 场景：应用与行业经验（2026-09-16）

> 状态：记录。检索于 2026-09-16，对象是公开网络资料（论文、产品页、社区仓库）；不描述 Iris 的现状。这份记录服务于「卡片可经文字构建 3D 场景」这一目标的构思阶段，设计稿另起。

## 0. 为什么现在看这件事

项目 owner 于 2026-09-16 提出：GPT-6 一代模型已能按提示词在网页里搭 Blender 场景，此能力会普及到更多模型，未来的角色卡会带「以文字构建 3D 场景」的能力，应列为 Iris 的核心目标之一。本记录收集应用与行业经验，供构思深化；不做设计裁决。

对着树量过的基线（`main` `b983111`）：语料 20 张卡里 **0 张**用到 three.js / WebGL / `<canvas>`；卡帧 CSP 的 `script-src` 已允许 `*.jsdelivr.net`，`connect-src` 仅同源；树里没有任何 WebGL 相关代码或文档。

## 1. 模型侧：今天「文字→3D 场景」是怎么做出来的

### 1.1 通用模型直接产出代码（GPT-6 Astra 一线）

- 早期测试者用 GPT-6 Astra 从短提示生成可玩的浏览器 3D 环境、建筑模型和整游戏；主路径是**生成 Blender Python（bpy）脚本**在 Blender 里跑，或直接产出 **HTML + JavaScript 的浏览器可玩产物**；Blender 有 WebGPU 的浏览器版可配合（[Kingy 指南](https://kingy.ai/blog/blender-openai-astra-complete-guide/)、[Puter 博客](https://developer.puter.com/blog/using-blender-with-chatgpt/)）。
- 迭代方式是「描述 → 生成脚本 → 运行 → 渲染 → 把结果给回模型 → 再改」；被点名的 demo 有 SimCity 式城市模拟器、五天连续生成的城市、Fall Guys 克隆、Palace of Fine Arts 建筑复刻、梵高画作可探索场景等（[MindStudio demo 盘点](https://www.mindstudio.ai/blog/gpt6-astra-3d-generation-demos)、[Computing Life](https://yage.ai/gpt-6-astra-3d-modeling-en.html)）。
- 报告的局限：明显的「AI 设计味」（扁平界面、偏绿的相似配色）、几何穿模小毛病、生成文本 AI 腔，需要更具体的提示词才能摆脱默认风格。**没有文档记录到自动的渲染反馈闭环**——迭代靠人。

**对 Iris 的含义**：模型直接写代码上限最高，但产物不可校验、不可回放、不可跨渲染器，安全面等同任意脚本。这正是我们沙盒已经在处理的那一类东西（卡脚本），不是新面。

### 1.2 Agent 工具化：Blender MCP

- 社区 [blender-mcp](https://github.com/ahujasid/blender-mcp) 及其变体把 bpy 整个 API 暴露成 MCP 工具，模型可以**查询活场景、推理、执行定向修改**，而不是只吐一段脚本（[MindStudio 实测](https://www.mindstudio.ai/blog/claude-blender-mcp-real-world-performance)、[Eigent 指南](https://www.eigent.ai/blog/claude-blender-mcp)）。
- 实测边界：「一张四条腿的木桌放中间、45° 平行光、中景相机」能做且可辨认；带权重绘制、骨骼约束、IK 的角色绑定做不到；被定位为**快速原型工具，不替代 3D 美术**。

**含义**：「模型操作一个有状态的场景」比「模型一次吐全场景」更接近对话式产品——每一轮是对既有场景的一次编辑。

### 1.3 学术路线：LLM 出布局，几何靠检索或生成

- **SceneCraft**（[arXiv 2403.01248](https://arxiv.org/pdf/2403.01248)）：先让 LLM 建**场景图**（资产间空间关系），再据图写 Blender 脚本，把关系翻成数值约束做布局，配迭代精修。
- **Holodeck / Holodeck 2.0**（[arXiv 2508.05899](https://arxiv.org/pdf/2508.05899)）：LLM 给出场景里应出现的对象描述与对象间空间约束，用于具身 AI 环境；2.0 加视觉语言引导与编辑。
- **LayoutGPT**、**I-Design**、**GraphDreamer**、**Cube**：都是「LLM 产出布局/场景图 → 节点当对象 → 检索或生成几何」的组合式生成（综述：[3D Scene Generation: A Survey](https://arxiv.org/pdf/2505.05474)、[Recent Advances…](https://arxiv.org/pdf/2504.11734)）。
- **IL3D**（[arXiv 2510.12095](https://arxiv.org/pdf/2510.12095)）：面向 LLM 驱动场景生成的大规模室内布局数据集——训练数据这条线也在补。
- **SceneAssistant**（[arXiv 2603.12238](https://arxiv.org/pdf/2603.12238)）：给开放词汇场景生成加视觉反馈 agent——自动化 1.1 里靠人的那一步。

### 1.4 两条直接回答「模型输出什么」的研究

- **声明式 vs 命令式 DSL**（[arXiv 2504.05482](https://arxiv.org/pdf/2504.05482)）：对开放宇宙场景布局，两种 Python 内嵌 DSL 对比，**命令式（逐步放置）整体表现更好**；声明式（约束 + 求解器）在多约束冲突时脆弱，命令式的错误是「后放的违背先放的」，但更容易恢复。给实践者的建议：偏命令式、给模型显式的空间感知、提供中间状态反馈、约束表达力与可求解性要平衡。
- **HDSL**（[arXiv 2606.09738](https://arxiv.org/html/2606.09738)）：XML/CSS 风格的**层级 DSL**（房间 → 区域 → 对象 → 支撑面，局部坐标树），配「层级检索增强」——编辑时只取相关子树让模型重写、再做确定性三方合并；报告编辑任务 token 降 5.22×、耗时降 6.19×，八组配对编辑全部产出合法 DSL 且更好地保住无关对象。它点名的前人问题正是：场景图/约束表**紧凑但欠定局部几何、局部编辑难定位**。

**含义**：如果 Iris 要一个场景描述契约，研究给出的方向是——**层级、局部坐标、可局部重写、命令式增量**，而不是「一大张全局约束表」。这与我们「一回合一个场景增量、经变量结算」的直觉吻合。

## 2. 资产侧：几何从哪来

- 托管服务与开源模型都已成熟：Meshy v6、Tripo H3.1、Hunyuan3D Pro/3.0、Hyper3D Rodin、微软 TRELLIS.2（MIT，可自托管）；输出普遍是 **GLB / OBJ**，带拓扑、面数、对称、重网格等控制（[RunDiffusion 对比](https://learn.rundiffusion.com/ai-3d-model-generators/)、[3DAI Studio API 对比](https://www.3daistudio.com/blog/best-3d-model-generation-apis-2026)、[Hunyuan3D 2.0 论文](https://arxiv.org/pdf/2501.12202)）。
- **Roblox Cube**（[arXiv 2503.15475](https://arxiv.org/abs/2503.15475)）：把 3D 形状当核心数据类型做**形状 token 化**，支撑文生形、形生文、文生场景，并与 LLM 协作做场景分析；产品端已开放 beta 的「4D」对象——按**预定义 schema** 拆部件并自动挂行为，玩家用文字生成能在游戏里直接动起来的车、飞行器、生物；官方路线图写了「完整场景生成」（[WN Hub](https://wnhub.io/news/Generative_AI/item-50036)、[Massively OP](https://massivelyop.com/2026/02/05/roblox-introduces-a-system-for-using-ai-to-generate-3-d-assets-from-text-prompts/)）。
- **世界模型路线**：Google Project Genie / Genie 3 从文字或图片生成可探索的实时环境（720p、24 fps、数分钟连贯），走的是视频式生成而非资产（[The Register](https://www.theregister.com/2026/01/29/googles_project_genie_ai)）。综述把它列为四大范式之一（程序化 / 神经 3D / 图像式 / 视频式）。

**含义**：Iris 不必自己生成几何。「场景描述 + 可插拔资产来源（本地资产包、用户接的生成服务）」是与行业一致的分工；世界模型那条线暂时不适合嵌进聊天帧（实时视频推理不在浏览器里）。

## 3. 浏览器侧：怎么渲染、用什么格式

- **glTF/GLB** 是 Web 3D 的事实标准（Khronos，「3D 的 JPEG」，three.js 官方推荐格式）；Khronos 在把 **Gaussian Splatting 并入 glTF**，格式格局可能再变（[nisshi-dev 格式指南](https://nisshi.dev/en/blog/web3d-data-formats-2026)、[glTF 维基](https://en.wikipedia.org/wiki/GlTF)）。
- 渲染器：three.js / Babylon.js 是两大通用引擎；**声明式**一层有 A-Frame（HTML 标签描述场景）、Google `<model-viewer>`（单模型预览 + AR）、PlayCanvas Viewer（glTF + 3DGS）；3DGS 有 gsplat.js 等可嵌进 three/Babylon 的库（[Babylon Viewer](https://www.babylonjs.com/viewer/)、[PlayCanvas Viewer](https://playcanvas.com/products/viewer)、[Polyvia 3DGS 指南](https://www.polyvia3d.com/guides/gaussian-splatting-web-viewer)）。
- three.js 的核心抽象就是**场景图**：用对象树表示世界，渲染一帧，帧间改属性做动画（[three.js 手册](https://threejs.org/manual/en/scenegraph.html)）。A-Frame 证明了「HTML 标签级的声明式场景」在 Web 上可用——这是最接近「模型写一段结构化文本就能出场景」的现成范式。

**含义**：渲染层选 three.js 几乎没有争议（jsdelivr 上有、生态最大、可换）；资产格式对齐 glTF 是与 Blender 互通的接口；描述层可以借 A-Frame 的「标签即对象」思路而不必依赖 A-Frame 本身。

## 4. 聊天与角色扮演产品：现有的 3D 面

- **SillyTavern 已有两条 3D/2D 形象扩展**：VRM 扩展在聊天上方叠一个 3D 动画角色，模型放 `/data/<user>/assets/vrm/model`、动画放 `…/vrm/animation`，对 TTS 口型、`/vrmexpression` 表情命令、情绪分类、点击命中区做反应，设置按模型持久化（[docs.ST.app VRM](https://docs.sillytavern.app/extensions/vrm/)、[Extension-VRM](https://github.com/SillyTavern/Extension-VRM)）；Live2D 扩展同理（[docs.ST.app Live2D](https://docs.sillytavern.app/extensions/live2d/)）；Extras 的 talkinghead 用生成模型做参数化 2D 头像（[README](https://github.com/SillyTavern/SillyTavern-Extras/blob/main/talkinghead/README.md)）。**这些都是「形象」，不是「场景」**——没有一条把对话内容变成环境。
- 商业侧 Inworld、Convai 卖的是 NPC/角色基础设施（人格、语音、多模型），Convai 的 3D 角色跑在既有虚拟世界里；面向消费者的角色扮演 app（Kindroid 等）聚焦记忆、语音与情感一致性。**检索没有找到把聊天文本生成为 3D 环境的主流角色扮演产品**（[Inworld](https://inworld.ai/resources/ai-infrastructure-for-companion-apps)、[Convai](https://convai.com/)、[aiga 盘点](https://www.aiga.io/blog/best-ai-roleplay-apps-2026)）。

**含义**：兼容层面，ST 的 VRM 扩展是我们迟早要跑起来的「形象」面（它走 ST 扩展路径，Iris 的 ST 扩展兼容面正是为此）；「场景」面在角色扮演产品里是空白，是 Iris 的有意改进空间，不是兼容义务。

## 5. 跨行业可借的经验（提炼）

1. **结构化输出优先于自由代码**：约束解码/JSON Schema 能保证形状合法（[结构化输出综述](https://arxiv.org/html/2501.10868v1)），但形状合法不等于场景合理——布局质量要靠 DSL 设计与反馈闭环。
2. **命令式增量比全局约束好写、好修**（§1.4）；**层级 + 局部坐标 + 子树重写**让编辑可定位（HDSL）。
3. **有状态的场景 + 每轮编辑**（Blender MCP 的工作方式）与对话天然同构：一回合 = 一次编辑，这正好落在 Iris 的变量结算模型上。
4. **几何外包、描述自持**：Roblox 与学术路线都把「布局/语义」和「几何生成」分开；描述层是产品的护城河，几何层随服务演进。
5. **反馈闭环是当前的短板**：Astra 靠人看渲染再提示；SceneAssistant 一类在补自动视觉反馈。Iris 的诊断面（`debug.reports`、失败态命名）可以先把「描述不合法/资产缺失」这类可判定的失败反馈给模型，视觉质量反馈是后话。
6. **风格塌缩是真实成本**：Astra 的「AI 设计味」提醒：默认调色板、默认布局要能被卡作者覆盖——卡片本来就是风格载体。

## 6. 这份记录没回答的

- 浏览器沙盒帧里 three.js + WebGL 的资源账（内存、首帧、多帧并存）——要 P0 探针实测，不是文献能答的。
- 场景描述的具体语法与版本策略、资产来源策略、场景归属（每条消息 vs 整个聊天）——设计裁决，见构思稿。
- Khronos glTF 的 3DGS 扩展何时定稿——外部时间线。
