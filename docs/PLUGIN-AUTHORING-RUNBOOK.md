<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">插件开发指南</h1>

<p align="center">从一个可撤销的能力开始，再接入浏览器与持久化。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

## 1. 先决定插件运行在哪里

| 类型 | 运行位置 | 适合的工作 |
| --- | --- | --- |
| Node 系统插件 | 宿主进程，与宿主同权 | 服务、RPC、变量提案、私有存储 |
| 浏览器成员包 | 卡片运行环境 | 为卡片提供受管理的成员 |
| ST 扩展兼容 | 隐藏的 facade iframe | 在兼容范围内运行上游扩展 |

`scope` 管理协作和生命周期，不限制 Node 代码能访问什么。先查[接口参考](INFRASTRUCTURE-INTERFACES.md)，确认所需能力已提供，不把第 8 节的设计项当成可调用接口。

## 2. 最小宿主插件

```ts
import type { SystemPluginDefinition } from '@iris/plugin-api'

const counter: SystemPluginDefinition = {
  id: 'demo-counter',
  name: '计数器',
  description: '提供随插件生命周期重置的计数器。',
  version: '0.1.0',
  apiVersion: 1,
  activate(scope) {
    let count = 0
    return scope.provide('counter', { next: () => ++count })
  },
}

export default counter
```

包入口默认导出 definition 对象，不是工厂。`activate` 可同步或异步返回清理函数；停用、重载和激活失败时，已登记资源都应回收。

仓库内实验可把 definition 加入内置目录，但不要顺带加入默认启用列表。独立插件走包安装路径，不必修改宿主源码。

需要其他插件时，在 `dependencies` 声明 id，再通过 `scope.getDependency` 读取能力；不要缓存已失效的对象或深层导入 runtime。

## 3. 工作与副作用的生命周期

按依赖顺序激活；依赖者仍启用时，宿主拒绝停用、重载或卸载被依赖插件。例如先停 MVU，再停酒馆助手；启用 MVU 会恢复所需依赖。

停用先拒绝新工作，再等待已接纳任务排空，最后释放资源。现有任务的 lease 与新请求的 revision 检查不是同一件事。

- 监听器、计时器、能力和 RPC 随生命周期释放，重载不累积。
- 异步任务有明确完成条件；没有通用强制排空超时兜底。
- 不在自己的未完成任务里等待停用自身。
- 旧帧和迟到回包不得借用新实例 revision。
- `reload` 重新激活已载入的 definition；修改源码后重启开发宿主，不能假定它重新 import 文件。

## 4. 浏览器、RPC 与持久化接入规则

| 接口 | 用途 | 约束 |
| --- | --- | --- |
| `scope.provide` | 发布能力 | 使用清理函数，避免重复登记 |
| `scope.getDependency` | 读取依赖 | 先声明依赖 |
| `scope.registerRpc` | schema 与 handler | 重名拒绝，撤销时两者一起移除 |
| `scope.variables.registerWriter` | 变量提案 | 宿主统一仲裁，不自行改写结算结果 |
| `scope.storage` | JSON 私有存储 | 清单需声明 `plugin-storage` |

writer 的 `baselineFor` 提供基线，`propose` 返回完整变量表或 `undefined`。按依赖深度和 id 仲裁，重叠路径后者优先并报告。每个 writer 限时 5 秒；失败记 `hook-failed`，回复继续，下次成功提案清除。

存储提供异步 `get/set/delete/keys`，一键一文件，单值 1 MiB、每插件 64 MiB。数据在 profile 的 `plugin-data/<id>/`，不在安装树；默认卸载保留，显式 `removeData: true` 才删除。键、JSON 和错误约束见[接口参考第 2 节](INFRASTRUCTURE-INTERFACES.md#2-宿主插件公开契约)。

### 包清单

```json
{
  "name": "iris-demo-counter",
  "version": "0.1.0",
  "type": "module",
  "iris": {
    "plugin": {
      "id": "demo-counter",
      "apiVersion": 1,
      "host": "host.js",
      "displayName": "计数器",
      "description": "一个最小的 Iris 插件",
      "capabilities": ["counter"],
      "permissions": ["provide-capability"]
    }
  }
}
```

可选字段有 `client`、`i18n: { "en": "en.json", "zh": "zh.json" }` 和 `dependencies`。入口必须在包内，不允许越界、符号链接、junction 或附带 `node_modules`。格式与上限见[安装说明](SYSTEM-PLUGIN-INSTALL.md#3-包格式与清单)。

`permissions` 是闭合词表：`get-dependency`、`host-context`、`plugin-storage`、`provide-capability`、`register-rpc`、`write-variables`。其中存储接口检查 `plugin-storage`，其余主要用于声明与展示；它们不把同权 Node 代码变成受限代码。

### 浏览器成员与文案

`client.js` 使用经典 IIFE，通过 `registerPluginMembers` 登记字面量 id 与成员键，便于安装扫描。撞核心成员或其他插件时，按插件拒绝并报告。

资产只对已启用插件提供，停用后 URL 返回 404；revision 与缓存规则见[接口参考第 5 节](INFRASTRUCTURE-INTERFACES.md#5-浏览器契约资产面成员合并与-ui-插槽)。

en/zh 两份文案必须是扁平字符串表：键相同、中文含汉字、占位符一致；每份不超过 256 KiB / 2,000 条，键为 `[a-zA-Z][a-zA-Z0-9]*`。运行时命名为 `plugin:<id>:<key>`，按当前语言 → 英文 → 键名回退，不能覆盖宿主文案。

## 5. 安装依赖、构建与执行

开发时从插件中心选择 `dev` 目录，预览、确认后再启用。它直接读取本地目录，不复制、不做开机哈希复核，始终显示 dev 标记。

发布使用 HTTPS Git 仓库和完整 40 位提交。预览不执行代码，确认后默认停用，更新也需重新确认。详见[安装指南](SYSTEM-PLUGIN-INSTALL.md)。

安装与检查遵循[参与贡献](../CONTRIBUTING.md)。使用全新数据目录和空闲端口验证，不占用正式实例：

```powershell
$pluginPreviewPort = 8788
if (Get-NetTCPConnection -State Listen -LocalPort $pluginPreviewPort -ErrorAction SilentlyContinue) {
  throw '端口已占用，请选择另一个端口'
}
$pluginPreviewData = Join-Path ([IO.Path]::GetTempPath()) ('iris-plugin-preview-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $pluginPreviewData | Out-Null
$env:IRIS_DATA_DIR = $pluginPreviewData
$env:IRIS_PORT = [string]$pluginPreviewPort
$env:IRIS_WEB_DIST = Join-Path (Get-Location).Path 'apps/iris-web/dist/index.html'
node apps/iris/bin.ts
```

在仓库根目录执行，先完成 Web 构建；ST 资产路由需要 `IRIS_WEB_DIST`。一个数据目录只允许一个宿主，用 Ctrl+C 停止自己启动的进程，不终止未知进程。

### ST 扩展入口

`stExtension.install({ path })` 接受含 `manifest.json` 的本地目录，随后进入同一控制面。兼容分析不保证整个扩展能运行；当前试点只服务一个非内置扩展。

ST 卸载保留安装树和设置，与 Node 包不同。测试与边界见 [ST 试点报告](../notes/st-compat/PILOT-REPORT.md)。

## 6. 验收矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| 初次启动 | 既有默认 TH/MVU 启用；新 demo 不凭空默认启用 |
| 安装/启用 | 目录状态与真实 capability 对齐，失败有原因 |
| 依赖阻塞 | MVU 启用时拒绝停用/重载/卸载 TH，并说明先停 MVU |
| 异步停用 | 新请求立即拒绝；已接纳任务按合同结束；停用成功后无迟到提交 |
| 重载循环 | 至少连续三轮，一个 capability/一组监听器/一组 RPC 注册；旧回调不能操作新实例 |
| 运行期 RPC 方法 | 启用后可调用且 schema 生效；停用/过期 revision 答 unsupported 且 schema 同撤；reload 不累积注册；重名只失败当事插件 |
| 激活失败 | 已注册的部分资源回收；其他插件可继续工作 |
| 存储失败 | 不伪报成功，不覆盖损坏偏好；错误可见 |
| `client.js` 下发 | 清单只列已启用且有 bundle 的插件；`?rev=` 命中才 immutable；停用后清单无行且 URL 404；CORS/nosniff 齐全 |
| 成员合并 | 撞 core、插件互撞、重复登记、坏形状、未获准插件、半登记状态——六种都按插件名拒绝且报告可读；核心表缺席才整帧拒跑 |
| 变量仲裁 | 互不相干的写入都保住；重叠路径后者胜且冲突被报出；只有一处结算 |
| MVU 停用期聊天 | 不初始化/更新/补放命令；重新启用不重放停用期文本 |
| TH 停用 | 原生对话、宏、世界书与静态消息仍能使用；依赖 TH 的脚本明确不可用 |
| 旧 iframe | 延迟 ready、RPC、fetch 返回不能复活旧 run 或带旧能力提交 |
| 重连/重启 | 新会话可接受新进程较低 revision；同会话不倒退 |
| 卸载重装 | 聊天、变量和应保留设置不丢失 |
| ST 扩展安装 | 上游字节零修改；分析报告与安装锁一致；停用后原文直通、桥接轮数为 0；卸载保留安装树与设置 |
| UI | 中英文、键盘、窄屏、等待与失败状态均可操作 |

先完成 Web 构建再读取测试结果，避免缺少产物造成额外跳过。记录真实的 fail/skip 及原因，不把“测试文件未能启动”算通过。

现成测试位于 `packages/iris-app-service/tests/` 的 `system-plugin*`、`plugin-*`、`variable-arbitration.test.ts`，以及 `apps/iris-web/tests/plugin-*`。浏览器记录见[平台验收](../notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md)。

## 7. 常见故障

| 现象 | 优先检查 |
| --- | --- |
| 找不到 `@iris/*` | 对应包管理器与依赖链接；tsc/Vite 别名不等于 Node 可解析 |
| `ERR_PNPM_NO_OFFLINE_META` | 缓存缺元数据；独立工作区联网安装后核对锁文件差异 |
| 已启用但无效果 | 能力是否有消费者，是否缓存旧对象 |
| `unsupported` | 未注册、已停用、revision 过期，或宿主没配置控制面 |
| 一直 disabling | 未释放 lease、无期限任务，或等待停用自身 |
| 成员列为空 | 登记 id 与键是否为字面量，bundle 是否执行完成 |
| 修改后 reload 无变化 | 重启宿主重新载入源码 |
| `hook-failed` | 提案抛错或超过 5 秒，修复后成功提案即可清除 |
| 端口占用 | 换空闲端口和新数据目录，不终止未知进程 |

## 8. 独立插件仓库与交付

`npm run pack:contracts -- --version <semver>` 生成独立 tarball，工作区仍是 `private: true`、`0.0.0`，不表示已经发布到 npm。版本策略与打包限制见[契约打包说明](PLUGIN-CONTRACT-PACKAGING.md)。

独立插件使用匹配版本的契约包，并提供与宿主一致的 Cordis；不复制宿主实现，不添加源码别名。安装包不能携带另一套 `node_modules`。

交付说明插件 id、职责、运行位置、版本、依赖、接口、数据归属和释放方式，附检查结果及复现步骤。区分“已实现”“测试通过”“浏览器已验收”和“已合并”。
