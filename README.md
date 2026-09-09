# Iris


```
pnpm install
pnpm build:web
pnpm start        # 启动时打印界面地址,浏览器打开即可
```

---

# 一、使用指南

## 1. 安装

需要 **Node ≥ 24**(源码由 Node 原生的类型剥离直接运行,不经打包器)、**pnpm**,以及 **npm**(界面这一半由 npm 管理,原因见 [apps/iris-web/README.md](apps/iris-web/README.md))。

```
git clone <仓库地址>
cd iris
pnpm install
cd apps/iris-web && npm ci && cd ../..
```

## 2. 启动

```
pnpm build:web    # 构建界面。只在界面代码变动后需要重跑
pnpm start        # 起宿主
```

宿主启动时会打印界面地址(默认 `http://127.0.0.1:8787`),浏览器打开即可。界面与传输层同源,不涉及 CORS。**没有构建界面时宿主照样启动**,只是不提供页面。

宿主的一切配置都是环境变量,启动命令的形状是:

```sh
# POSIX shell
IRIS_API_KEY_ENV=DEEPSEEK_API_KEY \
IRIS_BASE_URL=https://api.deepseek.com/v1 \
IRIS_MODEL=deepseek-chat \
IRIS_PORT=8787 \
IRIS_DATA_DIR=./data \
pnpm start
```

```powershell
# PowerShell
$env:IRIS_API_KEY_ENV = 'DEEPSEEK_API_KEY'
$env:IRIS_BASE_URL   = 'https://api.deepseek.com/v1'
$env:IRIS_MODEL      = 'deepseek-chat'
$env:IRIS_PORT       = '8787'
$env:IRIS_DATA_DIR   = './data'
pnpm start
```

- **`IRIS_API_KEY_ENV` 是另一个环境变量的_名字_,不是密钥本身。** 程序拿这个名字去 `process.env[...]` 取值。上例中密钥放在 `DEEPSEEK_API_KEY` 里。未设表示端点不需要鉴权(本地模型正是如此)。
- **`IRIS_BASE_URL`** 是 OpenAI 兼容端点的根,`/chat/completions` 由程序追加;**`IRIS_MODEL`** 是新聊天默认用的模型 id。**首次启动时,这两个值(连同 `IRIS_API_KEY_ENV` 指向的密钥)会被导入成供应商列表里的第一个供应商并直接启用**——之后由列表说话,环境变量不再是一条可选的路由,见 [§3](#3-连接模型)。
- **`IRIS_PORT`** 是 loopback 端口;**`IRIS_DATA_DIR`** 是存放 profile 的目录(默认 `./data`,已被 gitignore)。
- **密钥永不进仓库。** `key.txt`、`*.key`、`secrets.json`、`.env*`、`data/` 都在 `.gitignore` 里;CI 不引用任何 secret。密钥要么走 `IRIS_API_KEY_ENV` 指向的环境变量,要么由界面的连接面板保存到 `<IRIS_DATA_DIR>/<profile>/connections.json`——那个目录属于跑它的人,**不要提交或分享**。

全表(数据目录、ST 安装目录、模板开关、超时、开发源白名单)、`cordis.yml` 的组合方式与故障排查,见 **[§12 宿主参考](#12-宿主参考)**。

## 3. 连接模型

打开界面右上角的**设置**,第一张卡就是**连接**。它是一份**供应商列表**:添加一个、选一个在用、编辑或删除、测试连接。

> **回复只从列表里的供应商来。** 没有任何供应商在用时,宿主会**拒绝生成**,并给出一句指向这张卡的话——而不是悄悄用启动时的环境变量顶上。所以升级时,`IRIS_BASE_URL` 那套配置会在首次启动时被导入成一个名叫「启动环境」的供应商并直接启用(密钥由宿主自己复制,不经浏览器);已经存过供应商的机器不会被动过。

点**添加供应商**打开编辑器,选一个 **provider 预置**,`baseURL` 会自动填好:

| provider | 默认 baseURL | 密钥 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | 需要 |
| OpenAI | `https://api.openai.com/v1` | 需要 |
| OpenRouter | `https://openrouter.ai/api/v1` | 需要 |
| Anthropic | `https://api.anthropic.com/v1` | 需要 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | 需要 |
| Ollama | `http://127.0.0.1:11434/v1` | 不需要 |
| llama.cpp | `http://127.0.0.1:8080/v1` | 不需要 |
| LM Studio | `http://127.0.0.1:1234/v1` | 不需要 |
| 自定义 | 自己填 | 看端点 |

**密钥只写不回读。** 保存后它**再也不经过网络回到界面**:读取一个 profile 只回答「有没有密钥」和最后几位做掩码。留空表示保持原样,显式清空要传空字符串。

**但它在磁盘上是明文的**:连同端点、模型一起存在 `<IRIS_DATA_DIR>/<profile>/connections.json`,保护只有机器上的文件权限。想让密钥完全不进 profile,用 `IRIS_API_KEY_ENV`(见 [§2](#2-启动));界面里填过的密钥优先于环境变量,因为更具体的那个是这个人刚刚选的。

填好之后点**测试连接**。它探 `GET /models`,回答带具名判词,而不是一句「失败了」:

- `missing-key` —— 在任何请求发出**之前**就判定,不会把空密钥送上网;
- `unauthorized`(401/403)、`timeout`、`network`、`http-error`、`bad-response`、`no-endpoint`。

测试成功后模型列表会喂给一个下拉框,**末尾固定有一项「自定义…」**:选它就变回输入框,可以手填列表里没有的模型名——内测中的模型往往不在 `/models` 里,列表是捷径而不是关卡。**切换端点或密钥不需要重启宿主**:启用一个供应商会在运行时重新装配适配器,重启后仍然记得上次启用的那个。

## 4. 导入角色卡

角色卡从**角色库**页签导入;世界书、预设、聊天记录从设置抽屉里各自的面板导入。也可以直接把 `.png` / `.json` 复制进 `<IRIS_DATA_DIR>/<profile>/characters/`。

### 支持哪些格式,以及我们与上游哪里不同

| 你给的文件 | Iris 怎么处理 | SillyTavern 怎么处理 |
| --- | --- | --- |
| **`.png` 带卡数据**(`ccv3` 或 `chara` tEXt 块) | 正常导入,V1/V2/V3 都认,**未知扩展键原样保留** | 相同 |
| **`.json` 卡** | 正常导入 | 相同 |
| **`.png` 但里面没有卡**(例如只带 SD 生成参数的图) | **收作一张空白角色**:图就是这张卡,字段留空,名字取自文件名 | **拒绝**。`No PNG metadata.`,返回 `{error:true}`(HTTP 200),toast 是不点名的「文件可能无效或损坏」,磁盘上不留文件 |
| **`.jpg` / `.jpeg`** | **收作一张空白角色**(只校验它确实是 JPEG) | **在客户端就被静默丢弃**:扩展名白名单里没有 jpg,连请求都不发 |
| **`.webp`** | 不支持 | **也不支持**。导入白名单与服务端分派表都没有 webp,解析器只认 png,写回一律产 PNG |
| **`.charx`** | 尚未支持,但会得到**点名的**拒绝:「`.charx` cards are not supported yet」(它是个 zip,这个构建还没有打包 zip 解析器) | 支持 |
| **`.yaml` / `.yml` / `.byaf`** | 尚未支持,得到的是通用的「不是角色卡」 | 支持 |

前两行的「收作空白角色」是**有意的偏离**:语料里确实有用户当角色打开的无卡图片和 JPEG。依据与边界见 [notes/apps/iris-web/DEVIATIONS.md](notes/apps/iris-web/DEVIATIONS.md) 与 [notes/packages/iris-character/UPSTREAM-IMPORT-SHAPES.md](notes/packages/iris-character/UPSTREAM-IMPORT-SHAPES.md)(后者是对 ST 1.18.0 的正读,带行号)。

**聊天记录**按 SillyTavern 自己的文件形状进出:导入前先校验整个文件,拒绝时点名原因;导出走每次保存都用的同一条投影。

## 5. 从 SillyTavern 迁过来

Iris 读 SillyTavern 的文件,聊天记录用的就是 SillyTavern 自己的 JSONL 格式,两边可以来回开。但**迁移不是把目录一指就完事**。

### 先说最要紧的一句

> **Iris 不会写你的 SillyTavern 安装。**

这是一条被强制执行的纪律,不是一句承诺:`IRIS_ST_DIR` 那条路径**只读**,只打开 `worlds/*.json` 与 `settings.json`;而且它与 `IRIS_DATA_DIR` 落在同一棵树上时,**宿主启动就拒绝运行**,不是等到第一次写入才出事——那个重叠正是「我们从不写你的安装」停止为真的方式。

**但这句话有一个边界,必须自己知道**:如果你把 **`IRIS_DATA_DIR` 本身**指向 SillyTavern 的 `data/<用户>`,那就是把它交给 Iris 当数据目录了,Iris 会往那里写自己的 `connections.json`、`personas.json` 等等。**只读的是 `IRIS_ST_DIR`,不是「任何指向 ST 的路径」。**

所以推荐的做法是:**角色卡与聊天用复制,书和预设用 `IRIS_ST_DIR` 只读引用。**

### 两条路,各管一段

| 你想要 | 用什么 | 性质 |
| --- | --- | --- |
| 角色卡 | 把 `.png` / `.json` 复制进 `<IRIS_DATA_DIR>/<profile>/characters/` | 复制,读写归 Iris |
| 聊天记录 | 界面里的**导入聊天**(一次一个文件) | 复制,读写归 Iris |
| 世界书 | 设 `IRIS_ST_DIR` 指向 ST 的 `data/<用户>` | **只读引用**,原文件不动 |
| 预设 | 同上,在界面里从安装导入 | 只读引用,导入时才复制一份 |

### 聊天记录必须导入,不能靠「指过去」

**SillyTavern 按角色分目录存聊天**,Iris 存成一层平铺:

```
SillyTavern:  data/<用户>/chats/<角色名>/<角色名> - 2026-01-18@05h53m41s311ms.jsonl
Iris:         <IRIS_DATA_DIR>/<profile>/chats/<聊天 id>.jsonl
```

Iris 列聊天时只读 `chats/` 这一层里的 `*.jsonl`,**不往子目录里走**。所以就算把 `IRIS_DATA_DIR` 指向 ST 的 profile,**角色卡会被找到,聊天记录一条都不会出现**——它们在下一层。

用界面的导入把文件带过来:**一次一个,全有或全无**,并且**要你指定这段对话属于哪张卡**(不猜:文件头里的名字和它实际该挂在哪张卡下面,在 SillyTavern 那边也可能对不上)。不是 SillyTavern 自己那种 JSONL 的文件会**在写任何东西之前**被具名拒绝。上游的导入还收**五种**别家格式并改名——Kobold Lite、CAI Tools、oobabooga、Agnai、RisuAI——**我们只收 SillyTavern 这一种**,这是有意的:迁移路径要的是「要么完整进来、要么说清为什么不行」,而不是一个尽量猜的转换器。

导出是同一条路的反向:导出的就是 SillyTavern 能读的 JSONL。

### 带什么 / 不带什么

| 带过来 | 不带过来 |
| --- | --- |
| 角色卡(复制) | **聊天记录**——必须逐个导入,见上 |
| 聊天记录(逐个导入) | **世界书的扫描设置**——见下,这一条最容易让人以为书坏了 |
| 世界书(只读引用 / 按需取) | 角色卡里的**运行时状态**:脚本变量、脚本按钮的改动 |
| 预设(从安装导入) | 扩展及其设置 |
| **全局选书**(`globalSelect`) | 你在 ST 里装的其它扩展的数据 |

### 世界书的命中会和你习惯的不一样

迁移**只带全局选书**,**不带扫描设置**:扫描深度、预算、递归、整词匹配等等,全部回到 SillyTavern 的出厂默认。在 ST 里调过这些的话,**同一本书在这里会多触发或少触发一些条目**——书在、条目也在,只是触发的那一组变了。设置抽屉的「世界书」面板里可以按同样的名字调回去。

**有一个例外:是否给扫描缓冲加说话人前缀(`include_names`)在界面上没有开关**,它固定按上游默认 `true` 走。ST 里把它关掉过的话,这边的命中集会比你习惯的宽一点。

### 卡片带过来之后

- **卡里的脚本默认不运行**,要你逐张点头。见 [§6](#6-脚本授权门)。
- **卡自带的世界书**会在导入时物化成一本具名书;那个名字若已被别的书占了,Iris **让名给先来的**,把这一本存成 `原名 (2)`(再撞就 `(3)`,依次往后),并报告为什么——**不覆盖**。SillyTavern 在这条路上会静默覆盖,所以这里比上游严。
- **早期楼层的变量可能读起来是空的。** 那不是丢了:SillyTavern 自己的变量清理默认开着,一局够长的聊天在你导出它之前就已经被剪过了。Iris 会告诉你哪一层被剪过、最近一层完整的是哪一层,而不是回一张空表。

### 一件不会发生的事

Iris 不会把你在这里玩出来的东西写回卡文件。脚本变量、脚本改过的按钮、你给某张卡的收藏与授权,全都存在 profile 里。**一张卡从 Iris 导出去,带的是它作者发布的那些东西**——这也意味着把它带回 SillyTavern 时,面板是作者当初的样子,不是你玩到一半的样子。

## 6. 脚本授权门

一张卡第一次要跑它自带的脚本时,界面会问一次:**「运行它们 / 不运行」**。

- **按卡问一次**,答案记住。卡片脚本是卡作者写的真实代码,它能读你的对话——所以这是你的决定,不是默认。
- 脚本跑在**真隔离沙箱**里(不透明源的 iframe,带 CSP),不是页面全权。策略见 [docs/SANDBOX.md](docs/SANDBOX.md),授权规则见 [docs/AUTORUN.md](docs/AUTORUN.md)。
- **拒绝之后**,卡的界面与脚本不会运行;卡本身照常可以对话。
- 想改主意:设置抽屉里的**脚本**面板。

## 7. 卡的界面空白 / 没出来时

**第一步永远是看报告,不是猜 CSS。**

打开**设置**抽屉,向下滚到最后几节:

- **「宿主报告」** —— 点一下 **「读取」**(它不会自动读)。宿主做过什么、拒绝过什么,按等级着色。
- **「通知」** —— 本次会话发过的所有通知,最近 50 条带时刻。**屏幕上那条横幅只活几秒,这里的记录不会消失。**

常见的四类成因,在报告里长得不一样:

| 报告里看到 | 多半是 |
| --- | --- |
| `localStorage` / `indexedDB` 不可用 | 卡在用浏览器存储,而沙箱是不透明源,没有存储 |
| `blocked <某个域> (script-src / connect-src / style-src)` | 卡要的远程资源被策略拒了。若那是它的字体或图,界面会「能用但不好看」 |
| 某个脚本报语法错误 | 卡自己出厂就坏,整块脚本没跑起来 |
| `still waiting for <某个全局>` | 卡在等另一个脚本发布的接口,那个接口没来 |

**没有任何一条报告、屏幕也空**,是另一类问题,请连同「你在什么时候看的、看了多久」一起反馈——很多现象只活几秒。诊断面的全貌见 [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) 与 [docs/DEBUG-SURFACE.md](docs/DEBUG-SURFACE.md)。

---

# 二、开发指南

## 8. 工作区布局

| 路径 | 内容 |
| --- | --- |
| `apps/iris` | 宿主进程:`cordis.yml` 组合 + 端到端测试 + 全树级测试(架构不变量、文档引用) |
| `apps/iris-web` | 浏览器界面与卡片沙箱。**npm 管理,不在 pnpm 工作区里**(见其 README) |
| `packages/iris-chat` | 会话日志与 swipe 模型:候选靠 surface 遮蔽切换,全部候选留在日志里 |
| `packages/iris-turn` | 回合驱动:装配 → 流式生成 → 记为候选 |
| `packages/iris-pipeline` | 提示词装配:有序 system section、按深度注入、token 预算截断 |
| `packages/iris-macro` | 宏引擎。替换后的值不再被重新扫描 |
| `packages/iris-variables` | 七作用域变量系统。`message` 作用域按候选存储 |
| `packages/iris-mvu` | MVU 命令方言的解析与套用、`[InitVar]` 世界书加载 |
| `packages/iris-lorebook` | 世界书解析与激活引擎(关键词、递归、时序、包含组、预算) |
| `packages/iris-preset` | SillyTavern 预设 → 装配贡献项 |
| `packages/iris-regex` | 正则脚本引擎,三态易失性 |
| `packages/iris-character` | 角色卡 V1/V2/V3 与 PNG tEXt 编解码 |
| `packages/iris-persistence` | SillyTavern 聊天 JSONL 的无损往返 |
| `packages/iris-tokenizer` | token 估算,可用 provider 报告的用量在线校准 |
| `packages/iris-script` | 卡片脚本提取(三种在野存储形状归一)与远程来源白名单 |
| `packages/iris-compat-tavernhelper`(`-core`) | 酒馆助手 API 面与事件总线 |
| `packages/iris-compat-prompt-template` | ST-Prompt-Template(EJS)兼容,围栏子进程求值 |
| `packages/iris-llm-openai-compat` | 一个适配器覆盖 OpenAI 兼容的各家端点 |
| `packages/iris-protocol` | 宿主与浏览器之间的契约,请求方向带 zod 校验 |
| `packages/iris-rpc-host` / `-client` | HTTP + WebSocket 传输,带重连 |
| `packages/iris-app-service` | 宿主应用层:用领域包实现协议方法 |
| `packages/iris-client-fake` | 内存版 `IrisClient`,界面可脱离宿主开发 |
| `docs/` | 契约文档:架构、沙箱、可观测、调试面、自动运行、设置(见 [§11](#11-设计文档)) |
| `notes/` | 工作笔记:调查记录、上游对照、偏离账本、验收单、方法论。保留原有层级(`notes/apps/iris-web/…`、`notes/packages/<pkg>/…`) |
| `qa/` | 一次性验收仪器,要浏览器与跑着的宿主,不进 CI |
| `scripts/` | 语料普查与差分脚本、`test:live`、`test:no-corpus` |

## 9. 运行与测试

```
pnpm test                                 # node --test。离线,不依赖打包器
pnpm typecheck                            # tsc --noEmit —— 宿主、各包、scripts/
npm --prefix apps/iris-web run typecheck  # tsc --noEmit —— 界面(自己的 tsconfig)
pnpm build:web                            # 构建界面产物
```

**两种 tsc,两个都要跑。** 根 `tsconfig.json` 只收 `packages/*`、`apps/iris`、`scripts/`;界面在 `apps/iris-web` 里有自己的 `tsconfig.json`,由 `npm run typecheck` 检查。而 `node --test` 用类型剥离运行,它**不做类型检查**——一个带真实类型错误的测试文件照样通过,只有 `tsc --noEmit` 看得见。

`pnpm test` 是离线的:唯一需要网络的测试默认跳过。要对真实 provider 跑用 `pnpm test:live`,它需要 `DEEPSEEK_API_KEY` 或仓库根的 `key.txt`(都已 gitignore)。加这个开关而不是「有密钥就跑」,是因为工作区里躺着一个密钥不该让 `pnpm test` 悄悄变成花钱且断网即失败的东西。

**宿主从源码跑,界面是构建产物。** 所以改了 `apps/iris-web` 之后必须重跑 `pnpm build:web`,否则宿主服出去的还是上一份。

想看整条链路在真模型上工作:`pnpm demo:mvu`。

## 10. CI 是门

`.github/workflows/ci.yml` 一个 job,按序:pnpm 安装 → npm 安装界面 → 两种 typecheck → 构建界面 → `pnpm run test:no-corpus` → 渲染检查。**它不引用任何 secret**,套件按构造就是离线的。

`test:no-corpus` 不是 `pnpm test`:它把 SillyTavern 语料强制置为不存在,再检查结果的**形状**——一个用 `return` 代替 `skip` 的语料测试会报「通过」而什么都没断言,CI 恰恰是没有语料的那台机器。同族的守卫还有 `apps/iris/tests/architecture.test.ts`(依赖分层)与 `apps/iris/tests/md-references.test.ts`(文档里的链接、`路径:行号` 引用、源码注释里提到的 `.md`,都必须指向树上存在的文件)。

CI 红了不合并。分支命名、提交粒度、PR 里该写什么、我们怎么读一个修复,见 [CONTRIBUTING.md](CONTRIBUTING.md)。

`qa/` 下是**一次性验收工具**,不是回归网:它们要浏览器、要跑着的宿主、要手工搭,进不了 CI。回归由 `pnpm test` 守着。用法见 [qa/README.md](qa/README.md)。

## 11. 设计文档

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 依赖分层与由测试强制的架构不变量 |
| [docs/SANDBOX.md](docs/SANDBOX.md) | 卡片脚本沙箱的策略、CSP、能力面 |
| [docs/AUTORUN.md](docs/AUTORUN.md) | 卡片脚本的授权规则 |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) / [docs/DEBUG-SURFACE.md](docs/DEBUG-SURFACE.md) | 宿主报告、通知中心、调试面 |
| [docs/SETTINGS.md](docs/SETTINGS.md) / [notes/SETTINGS-IA.md](notes/SETTINGS-IA.md) | 设置面的组织 |
| [notes/ROADMAP.md](notes/ROADMAP.md) | 在做什么、排期、已收口的东西 |
| [notes/METHODS.md](notes/METHODS.md) | 工作方法:语料是判官、计数课、静默失败纪律 |
| [notes/apps/iris-web/DEVIATIONS.md](notes/apps/iris-web/DEVIATIONS.md) | 界面与沙箱侧的偏离账本 |
| [notes/packages/iris-app-service/DEVIATIONS.md](notes/packages/iris-app-service/DEVIATIONS.md) | 宿主侧的偏离账本 |
| [notes/packages/iris-compat-prompt-template/DEVIATIONS.md](notes/packages/iris-compat-prompt-template/DEVIATIONS.md) | EJS 兼容层的偏离账本 |

**偏离账本分两类条目**,区别比清单本身重要:**兼容缺口**是我们不如上游、并打算补上的地方,带着「补上要做什么」;**有意改进**是我们故意不同的地方,带着代价——没写代价的改进通常只是没被审视过的偏好。

## 12. 宿主参考

*(每一行都读自 `apps/iris/cordis.yml` 与 `apps/iris/bin.ts`,并注明读取点。)*

### 绑定与暴露

Iris **只绑 loopback**,默认 `127.0.0.1:8787`。这是有意的:这个 web 服务**不带 TLS、不带鉴权**,它信任自己所在的这台机器。要让别人访问,**在前面加一个反向代理,而不是改绑定地址**。

没有构建界面时宿主照样启动、照样应答协议,只是不服页面。新检出就是这个状态。

### 环境变量

Iris 自己不读任何配置文件。一切都是 `apps/iris/cordis.yml` 里的一行,下面这些变量是那个文件会查的。

| 变量 | 默认 | 作用 | 读取点 |
| --- | --- | --- | --- |
| `IRIS_PORT` | `8787` | loopback 端口 | `cordis.yml` webserver 行 |
| `IRIS_BASE_URL` | `http://127.0.0.1:11434/v1` | 端点根;`/chat/completions` 由程序追加 | `cordis.yml` `llm-openai-compat` 行 |
| `IRIS_MODEL` | `local-model` | 新聊天默认用的模型 id | `cordis.yml`,两处 |
| `IRIS_API_KEY_ENV` | 未设 | **另一个环境变量的名字**——不是密钥本身。程序拿这个名字去 `process.env[...]` 取值。未设表示端点不需要鉴权,本地模型正是如此 | `cordis.yml` → `@iris/llm-openai-compat` 的 `credentialOf` |
| `IRIS_DATA_DIR` | `./data` | 存放 profile 的目录。**指向一个 SillyTavern 的 `data/`,它就能就地找到那些角色卡**(但会往里写,见 §5) | `cordis.yml` app 行 |
| `IRIS_PROFILE` | `default-user` | 打开 `IRIS_DATA_DIR` 里的哪个 profile | `cordis.yml` app 行 |
| `IRIS_USER_NAME` | `User` | 新聊天里记下的你的名字 | `cordis.yml` app 行 |
| `IRIS_CONTEXT_WINDOW` | `32768` | 预设没带上下文窗口时用这个 | `cordis.yml` app 行 |
| `IRIS_PRESET` | 未设 | 要装配的 SillyTavern Chat Completion 预设文件路径。未设时用一个很薄的内置预设 | `cordis.yml` app 行 |
| `IRIS_ST_DIR` | 未设 | 一个 SillyTavern **profile 目录**(`…/data/<user>`,**不是安装根目录**),只读地从中取世界书与预设。与 `IRIS_DATA_DIR` 重叠时启动即拒绝。从不猜 | `cordis.yml` app 行 |
| `IRIS_TEMPLATES` | 关 | `1` 打开卡片的 EJS 提示词模板(ST-Prompt-Template)。默认关,因为求值一次就是在跑卡作者的 JavaScript | `cordis.yml` app 行 |
| `IRIS_BACKUP_KEEP` | `50` | 每个聊天保留多少份快照。与上游默认相同 | `cordis.yml` app 行 |
| `IRIS_DEV_ORIGIN` | 未设 | 逗号分隔的来源白名单,给跑在另一个源上的前端开发服务器用。**更推荐**反代 `/iris/rpc` 与 `/iris/events`,那样页面仍是同源 | `cordis.yml` rpc 行 |
| `IRIS_WEB_DIST` | 自动 | 界面产物的 `index.html`。**一般不要设**——有构建时 `bin.ts` 会自己填 | `apps/iris/bin.ts` |

另有两个只服务于 live demo、与跑宿主无关:`DEEPSEEK_API_KEY` 与 `IRIS_LIVE_MODEL`(`apps/iris/demo/`)。

### 不是环境变量的那几项

有些选项是 `cordis.yml` 里的行,没有对应的 `IRIS_*`,要改就在那里改。

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `pruneVariables` | **关** | 像 SillyTavern 自己的清理那样,把五个 MVU 变量键从旧楼层上剪掉。**默认关,因为它删状态而这里没有东西能恢复**——上游能从快照把一层往前重放,本宿主不能。开着可以让长局的变量存储不随长度增长。一次性的「清理这局旧聊天?」询问无论开关都会问 |
| `connectTimeoutMs` | `30000` | 等 provider 响应头多久。`0` = 关闭 |
| `firstByteTimeoutMs` | `120000` | 等流的第一个 token 多久。故意给得宽:推理模型在长上下文上思考几分钟是正当的。`0` = 关闭 |
| `idleTimeoutMs` | `120000` | 回复中途 provider 可以静默多久,超过就以**具名失败**放弃这一回合。`0` = 关闭 |

**SillyTavern 没有这三个超时**——它的生成 fetch 没有截止时间。那在它那里行得通,因为一个挂住的请求另一头总有一个人和一个 Stop 按钮。Iris 要服务多个页面,而且可能正在为一个已经关掉的页面生成,所以静默必须是宿主自己能了结的东西。超时以具名 `timeout` 报出,并**释放那个聊天**,所以下一条消息不会被当成「忙」而拒绝。

### 一个 profile 里有什么

`<IRIS_DATA_DIR>/<profile>/`:

| 路径 | 内容 |
| --- | --- |
| `characters/` | 角色卡(`.png`、`.json`) |
| `chats/` | 对话,每局一个 SillyTavern JSONL 文件 |
| `worlds/` | 世界书 |
| `presets/` | Chat Completion 预设 |
| `settings.json` | 采样、世界书扫描参数、全局书选择 |
| `connections.json` | 保存的端点**及其密钥** |
| `personas.json` | `{{user}}` 是谁 |
| `favorites.json` | 收藏的角色 |
| `script-policy.json` | 你允许过哪些卡跑脚本 |
| `script-variables.json` | 每个脚本存的变量 |
| `script-buttons.json` | 卡重排过的脚本面板按钮 |
| `extension-settings.json` | 每个安装的扩展设置 |
| `worldbook-bindings.json` | 哪本书属于哪张卡 |
| `card-storage.json` | 卡片之间共享的键值存储 |
| `script-bundles/` | 缓存下来的远程卡片包体 |

聊天文件就是 SillyTavern 自己的格式,所以在这里开的一局可以拿回那边打开,再拿回来。

### 出问题时

**页面打不开,但 API 有应答。** 没有界面构建。跑 `pnpm build:web`;构建放在不寻常的位置时设 `IRIS_WEB_DIST`。

**`missing API key: set <名字>`。** `IRIS_API_KEY_ENV` 指的那个变量是空的或没设。这里选择**点名拒绝**而不是发一个不带鉴权的请求,因为端点对后者的回答是 401,而 401 的成因没人看得见。

**宿主拒绝启动,说两个目录重叠。** `IRIS_ST_DIR` 指到了 `IRIS_DATA_DIR` 里面。两者必须是分开的树——那种重叠正是「Iris 从不写你的安装」不再成立的方式。

**生成停在 `no first byte … after 120000 ms` 或 `no data … for 120000 ms`。** 端点收下了请求然后安静了。消息会点名是哪一段超时、等了多久。如果你的端点确实那么慢,去 `cordis.yml` 调大或关掉,不要干等;无论哪种情况聊天都会被释放。

**卡的模板不起作用。** `IRIS_TEMPLATES` 是关的。打开它就是在一个子进程里跑卡作者的 JavaScript——没有环境变量、不能写文件系统、够不到宿主对象,是受限的,但仍然是他们的代码,所以默认要你自己开。

**某条世界书条目不再触发。** SillyTavern 默认只扫最近两条消息(`scan_depth`),这个默认在这里被原样复现了。它是一个设置,不是 bug。

**早期楼层的变量读出来是空的。** SillyTavern 自己的变量清理是**默认开启**的,所以从一个安装里导入的长局,到手时就已经被裁过了。Iris 会报出哪一层被裁、哪一层更早的还完好,而不是回一张空表了事。

**端口被占用。** 设 `IRIS_PORT`。**不要按端口或进程名杀进程**——那可能是别人起的宿主。

---

# 三、致谢

Iris 站在这些项目的工作上。兼容它们不是顺带,是这个项目的地板。

- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)** —— 角色卡、世界书、预设、聊天记录的形状,以及社区围绕它长出来的一切。我们读它的源码来确定「正确」是什么样子;这个仓库里每一条偏离,都是拿它当参照量出来的。
- **[ST-Prompt-Template](https://github.com/zonde306/ST-Prompt-Template)** —— EJS 提示词模板。我们跑它原版的引擎,只在必要处打具名补丁,并用差分验收盯住两边的差异。
- **[MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)** —— MVU 变量框架。它的命令方言、清理规则与初始化路径,是我们变量系统的对照实现。
- **[TavernHelper(JS-Slash-Runner)](https://github.com/N0VI028/JS-Slash-Runner)** —— 卡片脚本的 API 面、事件总线与注入层。我们照抄了它的词汇表,**包括它的拼写错误**——那些也是兼容性的一部分。
- **`@deepseek-ai/*` 与 Cordis** —— 插件框架(`@deepseek-ai/cordis`,Shigma 及其贡献者)与宿主骨架(`dsh-*`):每个组件可挂载、可卸载、可热重载,卸载时副作用完整回滚。`apps/iris/cordis.yml` 里的每一行都是它的一个插件。

## 感谢每一位贡献者

感谢每一位贡献者——提交过代码、补过账本、报过一张卡在哪一层坏掉的人。这个项目欢迎 PR。提交之前值得知道我们会怎么读它:

- **一个修复要说清它服务的是哪一类情况**,不是哪一张卡。按卡名或卡片特征值写的分支不会被合。
- **测量与决定分开写。** 决定可以写在散文里;被行为依赖的测量前提,要配一个会自己失败的东西——文档讲道理,测试押前提。
- **改了行为就改注释。** 陈旧的注释比陈旧的文档更贵,因为读者更信它。

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

# 四、许可与第三方声明

**Iris 以 [GNU AGPL-3.0](LICENSE) 发布**(`SPDX: AGPL-3.0-only`)。裁定的理由记录在 [notes/LICENSE-INVENTORY.md](notes/LICENSE-INVENTORY.md):仓库带着对 SillyTavern / ST-Prompt-Template(均为 AGPL-3.0)的逐字移植与算法转写,AGPL §5(c) 的整仓义务由此成立——这也是本项目自愿的选择:对一个以网络服务形态运行的宿主,网络 copyleft 本来就是想要的那条。若你通过网络运行修改版,按 AGPL §13 向交互用户提供源码的义务由公开仓库本身满足:`https://github.com/kkiwkK1/iris_harness`。

版权:`Copyright (C) 2026 kkiwkK1 and Iris contributors`。

我们用到的第三方项目、各自的许可证、以及**具体怎么用的**(依赖 / 接口兼容 / 算法转写 / 逐字移植),逐条列在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
