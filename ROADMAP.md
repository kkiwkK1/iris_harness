# 功能差距与排期

对照本机 SillyTavern 1.18.0 的**实际装置**盘点，不是凭记忆或文档：`E:/sillyTavern/SillyTavern`。

ST 的功能面规模：14 个内置扩展、43 组 API 端点、约 290 个斜杠命令、7 类互相独立的预设、20 余种每用户数据目录。Iris 当前 18 个包、347 个测试。

排期不按 ST 的目录顺序，按**什么在挡路**。

---

## Tier 0：挡住你当前用法的

这一层不是"缺功能"，是**你现在用的 MVU 卡在 Iris 上根本跑不起来**。

MVU 官方安装说明的原话是「与这个工具相关的有**一个脚本、两个正则和一个世界书条目**」。世界书和变量我们有了，另两样没有：

### 0.1 卡片脚本沙箱

MVU 本体是一个挂在角色卡上的局部脚本，内容就一行：

```js
import 'https://gcore.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js'
```

所以沙箱必须支持**ES module 语法**与**远程 import**。这不是可选项——`window.Mvu` 就是这个 bundle 装上去的，`@iris/compat-tavernhelper` 提供的 API 面没有它就没有消费者。

上游的 iframe **没有沙箱**（同源 `srcdoc`，直接访问 `window.parent`，API 被平铺成裸全局变量）。我们要做真隔离，代价是同步 API 得靠预推快照实现——设计已写在 `PLAN.md`，包名 `iris-script-host` / `iris-script-sandbox`，尚未开始。

远程 import 还带一个必须现在就决定的安全问题：**卡片能从任意 URL 拉代码执行**。ST 是默认放行的。Iris 应当至少做到域名白名单 + 首次加载时告知用户，否则我们的"隔离"只是把门锁上、钥匙插在外面。

**已决定的策略**：远程代码加载走**域名白名单**，白名单之外的 URL 拒绝加载并告知用户，而不是默默放行。

**白名单范围经实测修正**：本机 19 张真实角色卡里共 15 处远程 import，**14 处来自 `testingcf.jsdelivr.net`**，仅 1 处来自 `cdn.jsdelivr.net`。酒馆助手自己注入 jQuery/Vue 时用的也是 `testingcf`。所以白名单必须覆盖 **`*.jsdelivr.net` 全部主机名**——只放行 `cdn.` 和 `gcore.` 会让 15 处里的 14 处失败。GitHub raw 一并放行。

### 0.2 正则脚本 —— 已完成

MVU 需要的那两条正则：

| 名称 | 内容 | 作用范围 | 选项 |
| --- | --- | --- | --- |
| 去除变量更新 | `/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gm` | AI 输出 | 仅格式显示 + 仅格式提示词 |
| 对 AI 隐藏状态栏 | `<StatusPlaceHolderImpl/>` | AI 输出 | 仅格式提示词 |

没有它们，两件事都会坏：用户在聊天里看到裸命令块，**并且模型会读到自己上一轮的命令块**，从而污染后续生成。

要复刻的语义（`public/scripts/extensions/regex/engine.js` 实测）：

```js
regex_placement = { MD_DISPLAY: 0 /*已废弃*/, USER_INPUT: 1, AI_OUTPUT: 2,
                    SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 }
substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 }
```

关键是那对**易失性标志**，它们决定了这个功能的全部价值：

- `markdownOnly`（仅格式显示）：只改显示，不改存储
- `promptOnly`（仅格式提示词）：只改发出去的提示词，不改存储
- **两个都不设**：改动被永久写进聊天记录

还有 `minDepth` / `maxDepth`（按楼层深度限定）、`trimStrings`、`runOnEdit`、`disabled`。角色卡自带的正则在 `data.extensions.regex_scripts`——我们已经原样保留了这个字段，只是还没有引擎去执行。

`packages/iris-regex` 已实现，31 个测试，头三条就是拿 MVU 官方那两条正则跑真实回复，分别验证「读者看不到命令块」「模型读不到自己上一轮的命令块」「存储原文不变」。

剩下的是**接线**：提示词方向接进 `iris-pipeline`，显示方向接进视图投影，并把角色卡 `data.extensions.regex_scripts` 里的脚本按 `SCRIPT_TYPE` 排序喂进去。这部分依赖传输层和界面就位。

### 0.3 ST-Prompt-Template（EJS 模板）

你的 ST 装了这个。MVU 教程里的状态栏逻辑就靠它：

```
<% if (_.has(getvar("stat_data"), '理.好感度.[0]')) { %>
```

这是提示词层的模板求值，和 `@iris/macro` 的 `{{}}` 宏是两套东西。归属 `packages/iris-compat-prompt-template`。

---

## Tier 1：日常使用的硬缺口

### 1.1 分支与检查点

ST 用户切分支像呼吸一样频繁。`dsh-session` 的 `fork(source, boundary, childSessionId)` **正好就是这个功能**——包含式 seq 边界、拒绝在未闭合回合中间分叉、子 header 记 `parentSession`——我们只是还没接。协议里加两个方法、UI 加两个按钮就完事。

**投入产出比最高的一项**：能力已经在依赖里躺着了。

### 1.2 作者注释

按深度注入的机制 `iris-pipeline` 已经有了（`{kind:'depth', depth, role}`），作者注释就是在它之上加一个"存储 + 界面"的概念：全局 / 角色 / 单聊三层，可设深度与角色。同样很便宜。

顺带把角色卡 `extensions.depth_prompt`（角色注释，`{depth, prompt, role}`）一起接上——这个字段我们已经在解析了。

### 1.3 Instruct / Context 模板（文本补全路径）

我们目前只有 Chat Completion 预设。缺 instruct 模板意味着用户无法精确控制发给本地模型的格式化方式。

**没有我最初估计的那么阻塞**：llama.cpp 和 Ollama 都提供 `/chat/completions`，服务端会套自己的 chat template，所以本地模型是能用的。真正需要 instruct 模板的是走裸 `/completions` 端点、或者想自己掌控每个分隔符的用户——在 ST 社区里这是相当大的一群人，但不是第一天就必须。

字段清单在 `PLAN.md` 的数据契约一节，已经整理好了。

### 1.4 提示词逐条计费视图

ST 的 prompt itemization：点开一条消息，看到这次请求里每个部分各占多少 token。调试提示词时不可替代。

我们刚有了 `@iris/tokenizer`，而 `iris-pipeline` 的 `Contribution` 本身就带 `id`——**这个视图几乎是免费的**，把每个 contribution 的 token 数一起返回即可。ST 用户会立刻认出这个功能。

---

## Tier 2：期待有，但不挡路

- **群聊**：ST 有两种模式（换卡 / 合卡）和四种发言顺序策略（手动 / 自然 / 列表 / 轮询池）。工作量不小，且我们的 swipe 模型要扩展到"哪个角色在说话"。
- **快速回复 + 斜杠命令**：ST 有约 290 个命令。不必全做，但 `/send /sys /gen /setvar /if /inject /regex` 这一小撮是社区卡实际会调的（酒馆助手的 `triggerSlash` 就转发到这里）。
- **角色表情立绘**：sprite 目录 + 情绪分类。ST 靠本地 transformers.js 或让 LLM 判断。
- **主题与 CSS 自定义**：ST 有 `themes/`、`movingUI/`、每用户 `user.css`。Iris 的 slot 系统在这方面本来就更强，但需要真的开出扩展点。
- **更多导入格式**：`.charx`（V3 zip）、`.byaf`（Backyard AI）、Agnai / RisuAI / NovelAI 的世界书方言。PNG 覆盖了绝大多数流通中的卡。
- **mathjs 表达式求值**：MVU 的值目前保守求值，`math.pow(2,3)` 这类会原样透传而不是瞎猜。
- **JSON Patch 方言**与 `_.move`。

## Tier 3：独立子系统，各自是一个项目

- **RAG / 数据银行 / 向量检索**：ST 有 `vectors` 扩展 + `vectra` 本地索引 + 分块策略 + 多种嵌入后端。
- **摘要**：`memory` 扩展，定期自动摘要并按深度注入，暴露为 `{{summary}}`。
- **TTS / 图像生成 / 翻译**：各自是一组 provider 集成。
- **多用户、鉴权、备份**：`dsh-host-webserver` 没有 TLS 也没有鉴权（它自己文档写明），公网部署必须前置反代。
- **酒馆助手以外的扩展生态**：量卡的时候顺手发现，本机 19 张卡的 `extensions` 里还有
  `xiaobaix-tasks`（1）、`xiaobaix-template`（1）、`ST-Amily2-Chat-Optimisation`（1）、
  `juqingtuijin`（1）。**用户的卡不只依赖酒馆助手一个扩展。** 每张只出现一次，所以
  优先级低；但它说明"兼容酒馆助手"不等于"这些卡全都能用"，而我们目前的
  兼容性说法只覆盖了 `tavern_helper` / `TavernHelper_scripts` / `regex_scripts`。
  真要做的时候同样先量：这些键里装的是配置还是代码，决定它是一天的活还是一个子系统。

---

## 明确不照抄的

- **设置项铺天盖地**。ST 被抱怨最多的就是这个：三个各自独立的格式化面板（context / instruct / sysprompt）叠加 Prompt Manager、世界书、正则、扩展，效果互相覆盖，新手无从下手。Iris 的设置应当按"你想改什么"组织，而不是按"这个值存在哪个文件里"。
- **零沙箱的扩展模型**。ST 的扩展就是同源里的任意 JS，能拿到 `getContext()`、密钥端点和整个 DOM。这是我们要修的，不是要复制的。
- **凭据明文与无隔离**。ST 官方文档明说密码"不是安全特性"、数据明文存储、"不要在公网使用"。

## 已经比 ST 好、要守住的

- **插件可逆**。卸载即完整回收副作用。ST 做不到，所以它的扩展升级经常留残渣。
- **变量按候选存储**。swipe 一致性是结构决定的，不是靠额外代码维持。ST 是后来补上 per-swipe 变量的。
- **宏不二次扫描替换结果**。否则卡片存进变量里的文本会变成可执行代码。
- **token 估算经过实测校准**，且能用 provider 报告的真实用量在线收敛。ST 用的是 ~3.35 字节/token 的固定猜测。
- **传输边界有类型且校验请求**。浏览器是独立信任域。

---

## 建议顺序

两位子代理当前在做传输层与界面。等那条链路能端到端跑起来之后，按这个顺序推：

1. **正则脚本**（Tier 0.2）—— 纯逻辑、可测、MVU 硬依赖，先做
2. **分支/检查点** + **作者注释**（Tier 1.1 / 1.2）—— 底层能力已具备，接线即可
3. **提示词计费视图**（Tier 1.4）—— 几乎免费，ST 用户立刻认得
4. **脚本沙箱**（Tier 0.1）—— 最大的一块，且要先定远程代码加载的安全策略
5. **ST-Prompt-Template**（Tier 0.3）
6. **Instruct / Context 模板**（Tier 1.3）

前三项加起来的工作量小于第四项，而且能立刻让产品从"能对话"变成"能用真实社区卡对话"。

---

# 架构改动对兼容性的影响（实测）

问题：我们换了地基，卡会不会用不了。

不靠推理，拿本机 `data/default-user/characters` 里 **19 张真实角色卡**量。用我们自己的 `@iris/character` 解码，19 张全部解码成功。

| 项 | 数量 |
| --- | --- |
| 带正则的卡 | **15 / 19**，共 **173 条**正则 |
| 带脚本的卡 | 7 / 19，共 22 个脚本 |
| 远程 import | 15 处 |
| `parent.X` 访问 | 36 处 |

结论：**数据格式层面没有风险，风险全部集中在脚本执行环境这一处。**

## 安全的部分（有实测支撑）

**角色卡**：19/19 解码成功，且 decode→encode→decode 往返零键丢失，包括 `xiaobaix-tasks`、`ST-Amily2-Chat-Optimisation` 这些计划里没预料到的第三方命名空间。

**只追加的日志 vs 永久改写的正则**——这是我原本担心的一处架构冲突。ST 的非易失性正则会**物理改写** `chat[].mes`，而我们的事件日志是深冻结、只追加的，改不了。实测分布：

| 易失性 | 条数 | 占比 |
| --- | --- | --- |
| 仅显示 | 122 | 71% |
| 仅提示词 | 37 | 21% |
| 两者 | 13 | 8% |
| **永久改写存储** | **1** | **0.6%** |

**99.4% 的真实正则都是易失的**，从不改写存储。这个冲突在实践中几乎不存在，剩下那一条也可以用"编辑事件遮蔽原节点"来表达（`surfaceOp: replace`，能力已有）。

**作用范围**：168 条 AI 输出、73 条用户输入，`WORLD_INFO` / `REASONING` / `SLASH_COMMAND` 在这批卡里零使用。我们的引擎覆盖了实际被用到的全部范围。

**聊天记录**：ST JSONL 往返无损，含未知字段与 `extra` 载荷，有测试守着。

## 真正的风险：脚本的宿主访问

36 处 `parent.X` 拆开看：

| 访问对象 | 次数 | 沙箱能否代理 |
| --- | --- | --- |
| `parent.SillyTavern` | 12 | 能（`getContext()` 的桥） |
| **`parent.document`** | **7** | **不能——这就是隔离本身要拒绝的** |
| `parent.extension_settings` | 6 | 能，但需要我们提供等价物 |
| `parent.eventSource` | 4 | 能（ST 原生事件总线） |
| `parent.innerWidth/innerHeight` | 5 | 能（视口尺寸本来就要同步） |
| `parent.event_types` | 3 | 已有（`TAVERN_EVENTS`） |
| `parent.TavernHelper` | 1 | 已有 |

**只有 `parent.document` 那 7 处是真的过不去的**——其余全是数据与 API，桥可以照常提供。另外 7 张带脚本的卡**全部**用 jQuery、若干用 `document.body` / `createElement`，但那些操作的是 iframe 自己的文档，沙箱里照样成立，不是问题。

`parent.extension_settings` 那 6 处也值得留意：那是 ST 的全局设置大对象，卡片用它存自己的配置。我们的兼容面目前没有对应物，需要补一个（`{type:'extension'}` 变量作用域已经是现成的落点）。

## 需要你拍板的一件事

`parent.document` 那 7 处怎么处理，三种选择：

1. **严格沙箱**——那些卡的界面功能降级（脚本仍然跑，DOM 操作静默失败）。最安全，但用户会觉得"卡坏了"。
2. **虚拟 parent**——把 `parent.document` 代理到卡片自己的容器上。`parent.document.getElementById('chat')` 之类多半是想找聊天容器或注入样式，给它一个受限但可用的对象，大部分卡能正常工作而不获得真实权限。
3. **按卡显式授权**——提供"同源模式"开关，用户明确知情后给某张卡完整权限。

推荐 **2 + 3**：默认虚拟代理，个别确实需要真实访问的卡由用户显式开。纯 1 会让"能跑真实社区卡"这个目标打折，纯 3 等于把默认值退回 ST 的水平。
