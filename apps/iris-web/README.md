<p align="center">
  <img src="../../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">前端开发</h1>

<p align="center">Iris 的浏览器界面、主题与卡片运行环境。</p>

<p align="center">
  <a href="../../README.md">项目首页</a> ·
  <a href="../../docs/README.md">文档目录</a> ·
  <a href="../../docs/USER-GUIDE.md">使用手册</a>
</p>

---

## 启动开发环境

先在仓库根目录安装依赖，并启动需要连接的宿主：

```sh
pnpm install --frozen-lockfile
npm --prefix apps/iris-web ci
pnpm build:web
pnpm start
```

另开终端，进入 `apps/iris-web`：

```sh
npm run dev
```

Vite 将 `/iris/rpc` 和 `/iris/events` 代理到 `127.0.0.1:8787`。开发环境默认使用模拟传输；访问 `?transport=rpc` 连接真实宿主，`?transport=fake` 切回模拟数据。模拟模式会显示提示，不应被当成真实宿主验收。

## 常用命令

以下命令在 `apps/iris-web` 中执行：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动开发页面 |
| `npm run typecheck` | 类型检查 |
| `npm run check:render` | 界面渲染检查 |
| `npm run build:sandbox` | 构建卡片运行环境 |
| `npm run build:st-ext` | 构建 ST 扩展兼容资源 |
| `npm run build` | 构建完整前端并整理产物 |

浏览器相关单元测试从仓库根目录运行：

```sh
node --test "apps/iris-web/tests/**/*.test.ts"
```

Web 使用 npm 和独立锁文件，根工作区使用 pnpm。包解析包含本地 `file:` 依赖和 Vite 别名，修改依赖时不要只检查其中一处。

## 代码地图

| 目录 | 内容 |
| --- | --- |
| `src/client/` | 传输、客户端状态与宿主事件 |
| `src/app/` | 聊天、角色库、设置和插件中心 |
| `src/theme/` | 主题变量与共享视觉样式 |
| `src/slots/` | 界面插槽 |
| `src/sandbox/` | 卡片 iframe、桥接成员、运行策略与诊断 |
| `src/st-extensions/` | ST 扩展兼容环境 |

Iris 通过 `uiRenderer` 提供自己的界面，不依赖 DSH 的完整聊天页面。`index.html` 先准备启动门面，再动态加载 `dsh-client-modules/client`；Vite 的 `process` 定义与 `node:module` 别名也是启动链的一部分，不能当作无用配置删除。

允许的 Iris 包依赖见[项目架构](../../docs/ARCHITECTURE.md#依赖方向)。浏览器代码不得直接引入宿主领域服务。

## 视觉与交互

默认主题「雪墨宣」使用温纸底色、梅色重点和柔和墨色。新增页面优先复用主题变量、现有按钮和面板，不另建一套颜色、阴影或间距。

- 使用现有的中英文字典，避免把用户文案写进组件。
- 状态要可见：加载、空列表、拒绝和失败都有明确反馈。
- 列表用稳定 `key` 维持渲染身份，RPC 仍用 `id` 寻址。
- 底部选项轨道沿用 `src/app/rail.ts`：最多 8 项显示刻度，更多时用步进选择。
- 设置补丁中 `null` 表示重置，省略表示不改；未知设置键会被丢弃。
- 重新生成针对最后一条回复，不隐式改写任意历史消息。

## 构建产物

```text
public/sandbox/   卡片预置库、成员表与启动脚本
public/st-ext/    ST 扩展兼容资源
dist/            Vite 构建后可由宿主提供的完整前端
```

沙箱构建包含 `bootstrap`、`members`、`preset`、`message-preset` 四类经典 IIFE 脚本。完整构建先生成这些资源，再由 Vite 复制并整理；只生成页面脚本不等于完成可运行的生产构建。

修改沙箱源码后，先运行 `npm run build:sandbox`。普通页面的热更新不会自动替换已经构建的沙箱资源。

## 插件与卡片环境

`character.import` 接受 `.png`、`.jpg`、`.jpeg` 和 `.json`。PNG / JSON 可携带角色卡数据；普通 PNG、JPG / JPEG 作为空白角色导入。暂不支持 `.charx`。文件选择器、拖放提示与模拟客户端的格式列表应始终与宿主保持一致。

插件中心以宿主快照为准。浏览器按插件 revision 加载资产，一个插件的成员冲突或加载失败只影响该插件，不应让整个页面失效。

插件翻译使用 `plugin:<id>:<key>` 命名空间，按当前语言 → 英文 → 键名回退；禁用后移除。资产与成员注册方式见[插件开发指南](../../docs/PLUGIN-AUTHORING-RUNBOOK.md)。

卡片默认运行在带 `allow-scripts allow-forms`、默认不含 `allow-same-origin` 的 iframe 中。虚拟 `window`、`parent` 和 `document` 是兼容层，浏览器的不透明来源才是隔离边界；真实页面授权会改变这个边界。详见[脚本沙箱](../../docs/SANDBOX.md)。

创建运行环境时，调用方负责把 `card.element` 挂入页面，先提供视口上下文，再执行脚本。真实卡片走模块执行路径；开发探针的经典脚本模式不能替代它的验收。

## 调试与验收

开发设置中的沙箱探针用于检查全局成员、导入、页面视图和运行状态。它只在开发环境可用；探针支持的策略开关不一定是正式产品能力。

- `ran` 表示顶层代码完成，不代表全部异步逻辑成功。
- 启动超时、缺失成员、远程资源拒绝与脚本异常应分别显示，不统一归成“脚本错误”。
- 启动前诊断只能用于报告错误，不能绕过正式消息的来源与令牌检查。
- 检查成功路径，也检查切换角色、销毁 iframe、禁用插件后的资源清理。
- 用真实宿主和卡片验证端到端行为；模拟传输与渲染检查无法证明完整兼容性。

已知差异、调查和验收证据保存在[前端记录](../../notes/apps/iris-web/DEVIATIONS.md)。提交前的完整检查见[参与贡献](../../CONTRIBUTING.md)。
