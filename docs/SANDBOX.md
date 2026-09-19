<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">脚本沙箱</h1>

<p align="center">让已有卡片尽量可用，同时把访问边界说清楚。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

## 两层边界

**隔离来自浏览器 iframe，兼容来自 Iris 桥接。** 默认 iframe 使用 `sandbox="allow-scripts allow-forms"`，没有 `allow-same-origin`，处于不透明来源。即使脚本绕过虚拟变量取得真实 `globalThis` 或 `top`，浏览器仍会阻止读取宿主页面。

虚拟 `window`、`parent`、`document` 是兼容层，不是安全边界。卡片常含 webpack 的 `eval()` 输出，因此 CSP 允许 `unsafe-eval`；禁止它会让这些卡片无法运行，不能以此替代 iframe 隔离。

> [!WARNING]
> 授予真实页面访问后，会加入 `allow-same-origin`。与 `allow-scripts` 组合后，重要的隔离限制被解除，脚本可能读取宿主页面及其他数据。只对可信卡片授权。

授权只能来自用户，按角色保存；撤销在下一次运行恢复隔离，删除角色清除授权，重新导入不得继承。询问与执行状态见[脚本授权与运行](AUTORUN.md)。

## 卡片看到什么

| 访问 | 默认行为 |
| --- | --- |
| `parent.document.body` | 当前卡片自己的容器 |
| `parent.document.head` | 当前运行环境的 head |
| 查询 DOM | 限定在卡片内容范围 |
| 视口尺寸 | 宿主传入的视口，不是 iframe 默认尺寸 |
| 创建节点 | 创建未挂载的真实 DOM 节点 |
| 桥接成员 | 通过明确接口调用宿主 |
| 不支持的成员 | 明确拒绝或报告未桥接，不伪装成可用 |

同一卡片的脚本共享运行环境，可发布自有全局变量。读取未发布名称返回 `undefined`，必要时只提示一次；不能覆盖桥接成员。`has`、`in` 与枚举也应保持可预测。

脚本列表保留 `#tavern_helper`、`data-type` 和 `data-script-id` 标记，支持上游的身份与唯一实例判断。共享环境中的全局 `getScriptId` 与各脚本前置代码绑定的身份不应混用。

## 网络与资源

网络授权默认关闭。脚本面板经风险确认后调用 `script.setNetworkGrant`，`script.list` 返回按角色保存的 `networkGranted`。两条运行路径在执行时向宿主读取；撤销与删卡均清除许可。

切换会重新加载该角色的所有活跃帧，让 CSP 立即生效。可由授权解决的拒绝行也可打开同一确认窗口；不会给 `font-src` 等授权不改变的指令提供无效按钮。授权无法恢复失效的远程 URL。

| 资源 | 默认允许范围 |
| --- | --- |
| 脚本 | 内联、eval、blob、Iris 自身来源与下列远程白名单 |
| 直接 fetch / WebSocket | `connect-src 'none'`；受控桥接另行校验 |
| 图片 | `data:`、`blob:` |
| 样式 | 内联、data、Iris 自身来源、Google Fonts 样式 |
| 字体 | data、Iris 自身来源、`fonts.gstatic.com` |
| 嵌套浏览上下文、表单、修改基准地址 | 禁止 |

脚本来源的规范写法如下；`<selfOrigin>` 在运行时替换成 Iris 的精确来源：

```text
script-src 'unsafe-inline' 'unsafe-eval' blob: <selfOrigin> https://*.jsdelivr.net https://raw.githubusercontent.com
```

`*.jsdelivr.net` 只匹配子域，不含裸域 `jsdelivr.net`（not the bare apex）。`raw.githubusercontent.com` 必须精确匹配。宿主独立校验 HTTPS、来源和每次重定向，最多跟随 5 次；浏览器预检不能代替宿主约束。

网络授权只把图片、连接和样式放宽到 HTTPS，不扩大脚本来源、不允许 HTTP。

> [!NOTE]
> 没有网络授权不等于无法向外发送信息。允许的脚本 URL 仍可能携带数据；此策略不承诺零外传。

### 远程导入与样式

远程模块使用 `GET /iris/script-bundle?url=…`，由宿主获取、缓存，并重写嵌套导入。白名单外来源明确拒绝，不因某张卡片需要它就临时扩大规则。

白名单内的样式表链接也走这一路由，CSS 的 `@font-face` 与 `@import` 继续重写；其他图片 `url()` 保持原地址，由图片策略处理。入口包括消息 HTML 与虚拟文档的 template 解析。

不透明来源加载模块需要 CORS，即使资产来自 Iris 也不能省略。拒绝应在界面中显示来源与指令，不只留给卡片自己的报错。`x-iris-reason` 的读取也受响应头暴露规则约束。

### 请求 Iris 自身

上游脚本对 `/version` 等路径的请求通过受控 fetch 桥接处理，帧侧与宿主页面侧分别检查目标，而不是把 Iris 整体加入 `connect-src`。

桥接只接受明确列出的路径和请求形状，不是任意宿主 API 的通行证。见 [`bridge-paths.ts`](../apps/iris-web/src/sandbox/bridge-paths.ts) 与 [`same-origin.ts`](../apps/iris-web/src/sandbox/same-origin.ts)。

## 预置库与插件成员

jQuery、lodash、zod、YAML、Vue、Vue Router、Showdown 等预置库固定版本，由 Iris 提供；启动不依赖从 CDN 下载它们。卡片自己声明的远程依赖仍受上述策略约束。

装载顺序是核心成员表 → 启动代码 → 插件成员 → 卡片代码：

- 核心成员表缺失，整帧拒绝执行。
- 单个插件缺失、成员冲突或形状错误，只拒绝该插件并报告名称。
- 只接纳当前宿主快照允许的插件 id，不接受 bundle 自报身份绕过检查。
- 旧 revision 的帧与请求不能借用新一代能力。
- 拆分 bundle 不产生新信任边界，它们仍在同一运行环境执行。

## 沙箱插件与表单

除卡片脚本和系统插件成员外，角色脚本帧还接收 `plugin:mount` / `plugin:unmount` 消息，热挂载或移除沙箱插件。它与宿主同权的系统插件不同，代码在卡片帧的同一 realm 中执行，不扩大 CSP 或 iframe 权限。

门面 `{ id, styles, panel, card }` 不是隔离边界。模型生成的代码只经消息作为字符串传入，不拼接进 srcdoc；同步死循环不能被 Promise 超时中断。单次 apply 3 秒、批次 10 秒的等待期限不等于强制终止代码。

插件不在消息帧执行。`iris.styles.insert(css)` 的样式按 `(chatId, pluginId)` 保存，只在构建该对话后续消息帧时加入：限制长度、拆分结束标签、保持字符串，不执行代码、不注入宿主页面，也不实时注入已有消息帧。角色脚本帧销毁时清除对应样式。详见[沙箱插件设计](SANDBOX-PLUGINS.md)与[编写契约](SANDBOX-PLUGIN-AUTHORING.md)。

iframe 增加 `allow-forms` 以支持卡片自己的 submit 处理器；帧内捕获阶段会 `preventDefault()`，阻止真实提交导航，处理器仍可接收事件。CSP 的表单限制也以 `framePolicy` 为准，不能把 flag 理解成任意表单外发授权。

## 运行诊断

启动成功、顶层求值完成与功能正常是三个不同结论。无回报、缺失成员、资源拒绝和异步异常应分别报告；`ran` 不表示所有异步任务结束。

控制台桥接采集 `log`、`info`、`warn`、`error`，不采集 `debug`；保留原调用，并限制为每秒 50 行。诊断留在本地内存，不自动上传；抛错另行报告。

iframe 高度和视口通过消息同步，可能有一帧延迟。排错时同时检查挂载、尺寸消息和脚本状态。未桥接的裸标识符 `typeof` 等行为可能静默返回结果，“没有异常”不是完整兼容的证据。

## 宿主页面的 CSP

宿主保留 `object-src 'none'; base-uri 'none'; form-action 'none'`。`srcdoc` 会继承宿主策略，加入严格的 `script-src` 或 `default-src` 前，必须验证不会连带禁止卡片运行。

页面内防嵌入逻辑不能替代服务器响应头级别的保护，不应称为完整点击劫持防护。

## 已记录的限制

以下来自 2026-09-11 的安全复核，不是本次整理重新完成的审计。原始证据见[安全整改](../notes/SECURITY-REMEDIATION.md)和[前端记录](../notes/apps/iris-web/DEVIATIONS.md)。

| 编号 | 限制 | 重新评估条件 |
| --- | --- | --- |
| F8 | 允许的脚本 URL 可携带数据，不保证零外传 | 动态导入行为或授权模型变化 |
| L5 | 当时记录 Showdown 2.1.0 的 ReDoS / XSS 风险；仅作帧内预置库，不用于宿主渲染 | 依赖升级或使用位置变化 |
| F15 | GET 代理可能被其他页面驱动填充缓存；单响应 8 MiB、目录 256 MiB，超额拒绝写入而非淘汰 | 扩大来源或引入缓存淘汰 |
| F17 | 样式链接正则可能漏掉引号内含 `>` 的标签，之后仍由 CSP 拒绝 | 真实卡片触发或策略改变 |

---

实现入口：[策略](../apps/iris-web/src/sandbox/policy.ts) · [页面组装](../apps/iris-web/src/sandbox/srcdoc.ts) · [运行器](../apps/iris-web/src/sandbox/runner.ts)
