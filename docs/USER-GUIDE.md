<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">使用手册</h1>

<p align="center">连接模型，带上角色，让故事从本地开始。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

安装与启动命令见[快速开始](../README.md#开始使用)。这里整理模型连接、数据迁移、运行配置和常见问题。

## 连接模型

在 **设置 → 连接** 中添加供应商，填写端点地址、API Key 和模型，测试后启用。切换连接不需要重启 Iris；至少要启用一个供应商才能生成回复。

Iris 使用 OpenAI 兼容的 Chat Completions 接口。端点地址填写到 `/v1` 等服务根路径，程序会追加 `/chat/completions`。连接本地服务时，是否需要密钥取决于该服务的配置。

连接测试会请求模型列表。列表里没有需要的模型时，可以选择「自定义…」并填写模型 ID。

### 写插件用的模型

在供应商列表下的「写插件用」单独选择供应商和模型，也可手填模型 ID。它用于输入框的「创造」功能，不自动沿用当前聊天模型；未配置时「创造」不可用并显示原因，避免未选择的模型产生费用。

请求费用计入当前对话，在用量页的「其中写插件请求」单独列出；实际计费来自这里选定的供应商。功能说明见[沙箱插件](SANDBOX-PLUGINS.md)。

### 密钥与备份

通过界面保存的密钥会加密写入 `connections.json`，界面读取时只显示掩码。编辑连接时，密钥留空表示保留原值；清空密钥需要明确操作。

Windows 上，数据密钥绑定当前登录账户。把数据目录搬到另一台机器或另一个账户后，可能需要重新填写 API Key。其他平台或 Windows 系统保护不可用时，数据密钥使用文件权限保护，启动日志会提示。

也可通过环境变量提供启动连接，见下方[运行配置](#运行配置)。启动环境中的连接只会在首次初始化供应商列表时导入，后续以界面中保存并启用的供应商为准。

## 兼容范围

| 内容 | 支持情况 |
| --- | --- |
| 角色卡 | PNG / JSON，支持 V1、V2、V3 |
| 普通图片 | 无卡片数据的 PNG，以及 JPG / JPEG，会作为空白角色导入 |
| 其他角色文件 | 暂不支持 WebP、CHARX、YAML、BYAF |
| 消息渲染 | Markdown、卡片界面帧；六类引号 `"…"`、`“…”`、`«…»`、`「…」`、`『…』`、`＂…＂` 中的对白使用主题引号色，代码除外。颜色在回复完成后出现，不随流式文字逐字出现 |
| 聊天记录 | SillyTavern JSONL 导入与导出 |
| 世界书与预设 | 支持世界书及 Chat Completion 预设；迁移时需重新检查扫描设置 |
| 酒馆助手、MVU、EJS | 提供兼容实现；具体接口与差异见[接口清单](INFRASTRUCTURE-INTERFACES.md)与[偏离记录](README.md#偏离账本) |
| SillyTavern 扩展 | 通过兼容层运行，支持程度取决于扩展使用的接口 |

角色卡从角色库导入。世界书、预设和聊天记录在设置中的对应面板导入。导出的角色卡保留作者发布的内容，不包含本地游玩过程中产生的脚本变量、按钮状态等数据。

## 从 SillyTavern 迁移

先备份原有数据，并为 Iris 使用独立的数据目录。

| 内容 | 迁移方法 |
| --- | --- |
| 角色卡 | 在角色库导入 PNG / JSON，或复制到 Iris 的角色目录 |
| 聊天记录 | 导入 SillyTavern JSONL，并选择所属角色 |
| 世界书 | 从界面导入，或通过 `IRIS_ST_DIR` 只读引用 |
| 预设 | 从界面导入；配置 `IRIS_ST_DIR` 后也可从原安装中导入 |

`IRIS_ST_DIR` 应指向 SillyTavern 的 **用户目录**，如 `SillyTavern/data/default-user`，不是安装根目录。Iris 只读这个目录，并要求它与 `IRIS_DATA_DIR` 不重叠。

**不要把 `IRIS_DATA_DIR` 指向 SillyTavern 的数据目录。** Iris 会向自己的数据目录写入设置和状态文件。SillyTavern 的聊天按角色存放在子目录中，也不能靠修改路径直接读取，仍需导入。

迁移后需要留意：

- 世界书扫描深度、预算、递归等参数不会自动迁移，请在 Iris 中重新设置；`include_names` 当前固定为上游默认值 `true`。
- 原有扩展及其数据、卡片运行状态不会自动迁移。
- 角色卡自带的世界书遇到同名文件时会重命名，不会覆盖已有世界书。
- 从原聊天中已经清理掉的旧楼层变量，导入后不会恢复。

## 脚本与插件

**卡片脚本**按角色单独授权，可在设置中的脚本面板修改决定。脚本运行在隔离的卡片沙箱中；拒绝授权后仍可与角色对话，但依赖脚本的卡片界面不可用。详见[脚本授权](AUTORUN.md)与[沙箱说明](SANDBOX.md)。

**EJS 提示词模板**默认关闭。使用依赖 ST-Prompt-Template 的角色卡时，设置 `IRIS_TEMPLATES=1` 后启动。模板会执行卡片作者的 JavaScript，运行在受限子进程中。

**系统插件**在设置的插件中心安装、更新、启用或停用。安装源使用 Git 仓库和完整 commit，安装前会显示预览并要求确认。系统插件与宿主拥有相同权限，请只安装信任的代码。详见[插件安装说明](SYSTEM-PLUGIN-INSTALL.md)。

## 运行配置

日常模型配置可直接在界面完成。以下环境变量用于启动配置，由 [cordis.yml](../apps/iris/cordis.yml) 和 [bin.ts](../apps/iris/bin.ts) 读取。

### 示例

启动第二个实例时，同时使用不同的端口和数据目录。

PowerShell：

```powershell
$env:IRIS_PORT = '8790'
$env:IRIS_DATA_DIR = './data-dev'
pnpm start
```

macOS / Linux：

```sh
IRIS_PORT=8790 IRIS_DATA_DIR=./data-dev pnpm start
```

一个数据目录只能由一个运行中的宿主使用。宿主通过 `host.lock` 检查占用情况；正常退出时释放锁，进程结束后留下的锁会在下次启动时自动接管。

### 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `IRIS_PORT` | `8787` | 本机服务端口 |
| `IRIS_DATA_DIR` | `./data` | Iris 数据根目录 |
| `IRIS_PROFILE` | `default-user` | 使用的数据档案 |
| `IRIS_USER_NAME` | `User` | 新聊天中的用户名 |
| `IRIS_BASE_URL` | `http://127.0.0.1:11434/v1` | 启动模型端点 |
| `IRIS_MODEL` | `local-model` | 启动模型 ID，需改为服务提供的实际模型 |
| `IRIS_API_KEY_ENV` | 未设置 | 保存 API Key 的另一个环境变量的名字，**不是密钥本身** |
| `IRIS_CONTEXT_WINDOW` | `32768` | 预设未指定时的上下文窗口 |
| `IRIS_PRESET` | 未设置 | Chat Completion 预设文件路径 |
| `IRIS_ST_DIR` | 未设置 | 只读引用的 SillyTavern 用户目录 |
| `IRIS_TEMPLATES` | 关闭 | 设为 `1` 启用 EJS 提示词模板 |
| `IRIS_BACKUP_KEEP` | `50` | 每段聊天保留的快照数 |
| `IRIS_TRIM_BLOCK` | 由提示词装配模块决定 | 超出上下文预算时按多少层一组裁剪；`0` 为逐层裁剪 |
| `IRIS_CACHE_TRACE` | 开启 | 设为 `0` 停止保存用于缓存诊断的请求体 |
| `IRIS_CACHE_TRACE_KEEP` | `8` | 每段对话保留的请求体数量；关闭留痕时不生效 |
| `IRIS_DEV_ORIGIN` | 未设置 | 前端开发来源白名单，以逗号分隔 |
| `IRIS_ALLOWED_HOSTS` | 未设置 | 反向代理使用的主机白名单，精确匹配、不支持通配，以逗号分隔 |
| `IRIS_WEB_DIST` | 自动查找 | 界面构建产物的 `index.html` 路径，通常无需设置 |

例如，`IRIS_API_KEY_ENV=DEEPSEEK_API_KEY` 表示从 `DEEPSEEK_API_KEY` 环境变量读取密钥。Iris 不会自动加载 `.env` 文件，请在启动进程的环境中设置。

### 超时与变量清理

以下选项没有对应的环境变量。需要调整时，在 `apps/iris/cordis.yml` 的 `app` 插件 `config` 下添加。

| 选项 | 默认值 | 用途 |
| --- | --- | --- |
| `connectTimeoutMs` | `30000` | 等待模型服务响应头的时限 |
| `firstByteTimeoutMs` | `120000` | 等待首个流式数据的时限 |
| `idleTimeoutMs` | `120000` | 流式回复中途允许的静默时长 |
| `pruneVariables` | `false` | 是否清理旧楼层中的 MVU 变量 |

三个超时以毫秒计，`0` 表示关闭对应超时。开启 `pruneVariables` 会删除旧变量状态，Iris 无法从后续楼层还原这些数据。

### 远程访问

默认监听 `127.0.0.1`，服务不自带 TLS 或登录认证。远程访问需在前面配置带认证和 HTTPS 的反向代理，并将浏览器访问时使用的主机名及端口按实际 `Host` 值加入 `IRIS_ALLOWED_HOSTS`。具体规则见[传输层说明](../packages/iris-rpc-host/README.md)。

## 数据保存在哪里

默认档案目录为 `data/default-user/`，也就是 `<IRIS_DATA_DIR>/<IRIS_PROFILE>/`。

| 路径 | 内容 |
| --- | --- |
| `characters/` | 角色卡 |
| `chats/` | 聊天 JSONL |
| `worlds/`、`presets/` | 世界书与预设 |
| `settings.json`、`personas.json` | 设置与用户人设 |
| `connections.json`、`connections.key` | 模型连接、加密密钥及其保护文件 |
| `favorites.json`、`chat-order.json` | 角色收藏与对话排序 |
| `script-policy.json`、`script-library.json` | 卡片授权与用户脚本 |
| `script-variables.json`、`script-buttons.json` | 脚本变量与按钮状态 |
| `extension-settings.json`、`card-storage.json` | 扩展设置与卡片共享存储 |
| `worldbook-bindings.json` | 角色与世界书的绑定 |
| `script-bundles/` | 远程卡片脚本缓存 |
| `cache-trace/` | 最近的模型请求体，可能包含完整提示词与对话 |
| `st-extensions/`、`system-plugins/` | 已安装的扩展与系统插件包 |
| `plugin-data/` | 插件数据，卸载插件时保留 |

数据根目录还包含 `host.lock`，以及供浏览器使用的 `system-plugins/` 资产目录；后者与档案内存放插件包的同名目录用途不同。

备份前先停止对应宿主，再复制整个数据目录。跨机器恢复时请留意前面的[密钥说明](#密钥与备份)。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 宿主启动了，但页面打不开 | 在仓库根目录运行 `pnpm build:web`，然后重启 |
| 修改界面后没有变化 | 重新构建界面；宿主提供的是构建产物 |
| 提示没有启用的供应商 | 在设置的连接面板添加并启用一个供应商 |
| 提示 `missing API key` | 检查 `IRIS_API_KEY_ENV` 指向的环境变量是否已设置 |
| 迁移机器后连接显示没有密钥 | 重新填写 API Key；原数据可能由另一 Windows 账户保护 |
| 反向代理后请求返回 403 | 检查 `IRIS_ALLOWED_HOSTS` 是否包含实际请求的 `Host` 值 |
| 端口或数据目录已被占用 | 为新实例同时指定独立端口和数据目录，或停止原实例 |
| 提示 SillyTavern 与 Iris 目录重叠 | 将 `IRIS_ST_DIR` 与 `IRIS_DATA_DIR` 设为互不包含的目录 |
| 生成等待过久后超时 | 检查模型服务；慢速服务可调整上面的三个超时 |
| 卡片模板未生效 | 检查是否设置了 `IRIS_TEMPLATES=1` |
| 世界书条目未触发 | 检查关键词、扫描深度、预算及递归设置；默认扫描最近两条消息 |
| 卡片界面空白或脚本报错 | 检查脚本授权，再查看设置中的「宿主报告」与「通知」 |

宿主报告需手动点击「读取」。出现资源被拦截、存储不可用或等待某个脚本全局对象等提示时，可对照[沙箱说明](SANDBOX.md)排查。反馈问题时，请附上操作步骤及相关报错，并移除私人对话和密钥。
