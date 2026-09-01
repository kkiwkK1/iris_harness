# Iris

一个 SillyTavern 替代品，地基换成 DeepSeek Harness 所用的 **Cordis** 插件框架——每个组件（模型适配器、提示词装配、世界书、持久化、UI 区块）都是可挂载/可卸载/可热重载的插件，卸载时副作用完整回滚。

目标是保留 SillyTavern 的领域能力与生态资产（角色卡、世界书、预设、聊天记录、酒馆助手脚本、MVU 变量），换掉它的单体架构与零隔离的扩展模型。

设计与取舍见 [PLAN.md](PLAN.md)；阶段 0 技术验证的结论与踩坑见 [spike/RESULTS.md](spike/RESULTS.md)。

## 环境

需要 Node ≥ 24（源码直接由 Node 的原生类型剥离运行，不经打包器）与 pnpm。

```
pnpm install
pnpm test        # node --test，离线、不依赖 esbuild
pnpm typecheck
```

`pnpm test` 是**离线**的：唯一需要网络的两个测试默认跳过。要对真实 provider 跑，用 `pnpm test:live`——它需要 `DEEPSEEK_API_KEY` 或仓库根目录的 `key.txt`（两者都已 gitignore）。之所以额外加开关而不是"有密钥就跑"，是因为工作区里躺着一个密钥不该让 `pnpm test` 悄悄变成花钱且断网即失败的东西。

想看整条链路在真模型上工作：

```
pnpm demo:mvu
```

这个 demo 用世界书 `[InitVar]` 声明变量树，跑三轮真实对话，把模型吐出的 `<UpdateVariable>` 命令解析套用，打印每轮的状态变化，最后重新生成并切回旧候选，验证状态各自归属。

### 跑起来

先配置端点——把 `apps/iris/.env.example` 复制成 `apps/iris/.env` 并改成你自己的（该文件已被 gitignore）。任何讲 OpenAI `/chat/completions` + SSE 的端点都行：Ollama、llama.cpp、TextGen WebUI、OpenAI、OpenRouter、DeepSeek。本地端点通常不需要密钥。

```
pnpm build:web    # 构建界面，只在界面代码变动后需要重跑
pnpm start        # 起宿主；启动时会打印界面地址
```

浏览器打开它打印的那个地址即可。界面和传输层同源，所以不涉及 CORS。没有构建界面时宿主照样启动，只是不提供页面——无头的传输测试正是这样跑的。

之所以走配置文件而不是环境变量前缀，是因为 **PowerShell 没有 `VAR=value cmd` 这种写法**——那是 bash 的语法。真要临时覆盖，两种 shell 各自的写法是：

```
# PowerShell
$env:IRIS_MODEL='qwen3:8b'; pnpm start

# bash / zsh
IRIS_MODEL=qwen3:8b pnpm start
```

继承的环境变量优先于 `.env`，所以临时覆盖总是生效。

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/iris-chat` | 会话日志与 swipe 模型：候选回复靠 surface 遮蔽切换，全部候选留在日志里 |
| `packages/iris-turn` | 回合驱动：装配 → 流式生成 → 记为候选。无工具、无子代理 |
| `packages/iris-pipeline` | 提示词装配：有序 system section、**按深度注入**、token 预算截断 |
| `packages/iris-macro` | 宏引擎。替换后的值不再被重新扫描，避免存储文本变成可执行代码 |
| `packages/iris-variables` | 七作用域变量系统。`message` 作用域按候选存储，这是 swipe 一致性的来源 |
| `packages/iris-mvu` | MVU 命令方言的解析与套用、`[InitVar]` 世界书加载 |
| `packages/iris-compat-tavernhelper` | 酒馆助手 API 面与事件总线（含上游的拼写错误，它们是兼容性的一部分） |
| `packages/iris-character` | 角色卡 V1/V2/V3 与 PNG tEXt 编解码。未知扩展键原样保留 |
| `packages/iris-lorebook` | 世界书解析与激活引擎（关键词、递归、时序、包含组、预算） |
| `packages/iris-preset` | SillyTavern 预设 → 装配贡献项 |
| `packages/iris-persistence` | SillyTavern 聊天 JSONL 的无损往返 |
| `packages/iris-llm-openai-compat` | 一个适配器覆盖 OpenAI/OpenRouter/Ollama/llama.cpp/TextGen/DeepSeek… |
| `packages/iris-regex` | 正则脚本引擎。三态易失性（仅显示 / 仅提示词 / 永久），MVU 的硬依赖 |
| `packages/iris-tokenizer` | token 估算，权重由实测拟合；可用 provider 报告的用量在线校准 |
| `packages/iris-script` | 卡片脚本提取（三种在野存储形状归一）与远程来源白名单 |
| `packages/iris-compat-tavernhelper-core` | 酒馆助手的词汇表：两个信任域必须逐字共享的事件名。零依赖，有测试钉住 |
| `packages/iris-compat-prompt-template` | ST-Prompt-Template（EJS）兼容：围栏子进程求值，原版引擎+具名补丁，差分验收 |
| `packages/iris-protocol` | 宿主与浏览器之间的契约。请求方向带 zod 校验 |
| `packages/iris-rpc-host` / `-client` | HTTP + WebSocket 传输，带重连 |
| `packages/iris-app-service` | 宿主应用层：用领域包实现协议方法 |
| `packages/iris-client-fake` | 内存版 `IrisClient`，界面可脱离宿主开发与测试 |
| `apps/iris` | 宿主进程：`cordis.yml` 组合 + 端到端测试 |
| `apps/iris-web` | 浏览器界面。npm 管理（原因见 `pnpm-workspace.yaml` 注释） |
| `spike/` | 阶段 0 的一次性验证工程，不属于产品树（已排除出 workspace） |
| `.reference/` | deepseek-harness 与 MagVarUpdate 的只读检出，供对照实现 |

## 现状

领域内核、生态兼容层、宿主传输层、浏览器界面、卡片脚本沙箱与 EJS 模板层均已落地，
**850 个测试（848 通过 / 2 联网跳过）**，类型检查干净。架构不变量（依赖分层、浏览器
import 白名单等）由测试强制（[ARCHITECTURE.md](ARCHITECTURE.md)）。

端到端在真实数据上验证过：真页面 → 真传输 → 真宿主 → 真卡;**真实卡片的 MVU 生产
bundle 在隔离沙箱内从白名单 CDN 加载并完整执行**（沙箱策略与实测见
[SANDBOX.md](SANDBOX.md)）;导入/导出对用户真实的 SillyTavern 数据（含 677 楼长局）
逐行无损。**视觉设计仍未经人眼在浏览器里审阅**——这是当前"已验证"边界的准确位置。

~~最大的剩余缺口是卡片脚本沙箱~~（2026-09-01 划掉：已建成并被真卡验证）。当前在做的
收尾与排期见 [ROADMAP.md](ROADMAP.md)，工作方法的付费教训见 [METHODS.md](METHODS.md)。
