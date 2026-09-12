# Iris 插件制作与执行手册

2026-09-12，针对 `dev/system-plugins` 当前实现及契约包迁移工作区。配套 [基础设施接口清单](INFRASTRUCTURE-INTERFACES.md)。本手册包含今天能执行的制作路径与后续发布要求；尚未实现的接口不可照草案调用。

## 1. 先决定插件运行在哪里

| 需求 | 位置 | 今天的接入方式 |
| --- | --- | --- |
| 宿主算法、共享业务能力、自动处理 | Node 系统插件 | 实现 SystemPluginDefinition，加入内置目录，宿主通过 capability 使用 |
| 插件中心的管理操作 | shell UI | 使用现有 plugin.*，以返回快照和事件更新 |
| 页面按钮/面板 | shell UI 插槽 | 仓库内 UI 接线；外部 client.js 扫描尚未完成 |
| 卡片自带交互/脚本 | iframe 沙盒 | 既有卡片脚本授权和 TH 兼容面；不能提升为 Node 插件 |

当前插件中心只能安装 runtime 构造时给出的目录条目。没有“输入 npm 名称/Git URL 就安装”的能力，也没有通用热更新源码加载器。reload 会释放并重新激活当前已载入的 definition；编辑磁盘 TypeScript 后通常需要重启开发宿主。

## 2. 最小宿主插件

在受协调的开发分支创建 `packages/iris-app-service/src/plugins/demo-counter.ts`。下面是基于当前契约的最小实现，示例不自动接入产品：

```ts
import type { SystemPluginDefinition } from '@iris/plugin-api'

export interface CounterCapability {
  next(): number
}

export const demoCounter: SystemPluginDefinition = {
  id: 'demo-counter',
  name: 'Demo counter',
  description: 'Counts calls within one activation.',
  version: '0.1.0',
  apiVersion: 1,
  activate(scope) {
    let count = 0
    return scope.provide<CounterCapability>('counter', {
      next: () => ++count,
    })
  },
}
```

把它导入 `plugins/builtins.ts` 并加到 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`。这只是登记可安装实现，不要因此扩大默认启用集。当前默认启用 TH 与 MVU，新 demo 应由使用者主动安装/启用。

id 建议固定为短的小写 ASCII/kebab-case；显示名可以修改，id 改名等于新的持久化身份。当前 runtime 仅有部分 id 校验，不要把它当安全路径片段直接拼到资产或存储路径。

如果能力没有消费者，插件状态即使显示 enabled，也不会产生产品功能。编写者须列出“谁调用 capability、何时调用、输入输出、错误处理”，再把消费者接入既有业务路径。不要为调用一个 demo 另建通用绕过验证的 RPC。

### 声明和使用依赖

在 definition 加 `dependencies: ['demo-counter']`，然后于 activate 中调用：

```ts
const counter = scope.getDependency<CounterCapability>('demo-counter', 'counter')
if (counter === undefined) throw new Error('demo-consumer requires demo-counter/counter')
```

未声明就读取依赖会被拒绝；声明依赖只约束插件 id，目前没有 semver 范围求解。依赖的 capability 类型由双方显式约定，泛型断言不是运行时 schema 验证。移入独立包时，应从发布的契约导入共享类型，不能深导入 app-service 私有文件。

## 3. 工作与副作用的生命周期

同步纯算法优先。为每个事件订阅、定时器、RPC 注册、UI 注册和外部资源记录对应的撤销路径。启动过程中任一步失败，已取得的资源也必须释放；不能只在 activate 最后一行返回 cleanup，因为失败可能先发生。

由宿主调用异步能力时，使用现有 runtime 入口取得 lease，跨越计算与最终提交：

```ts
// 宿主接线示意：runtime、expectedRevision 和 commit 由调用路径提供。
const lease = runtime.lease('demo-worker', expectedRevision)
try {
  const worker = runtime.capability<WorkerCapability>('demo-worker', 'worker')
  if (worker === undefined) throw new Error('demo-worker/worker is unavailable')
  const result = await worker.compute(input)
  lease.assertCurrent()
  await commit(result)
} finally {
  lease.release()
}
```

这是宿主内部接线样板，不是插件 scope 中存在 `lease()` 的声明。WorkerCapability、input、commit 属于具体业务，需自行定义。

停用过程为：关闭新工作 → 等待旧 lease 释放 → dispose → 返回最终快照。旧 lease 在排空期间允许完成提交，因此不要在中途用 `runtime.assertCurrent()` 的新工作规则去否认已经接纳的任务。持有 lease 的任务不要 await 停用自己，否则形成循环等待。业务异步操作需要自己的取消/超时策略；当前 runtime 没有为任意插件提供统一 drain 超时。

reload 后任何旧 capability 引用都不应再进入调用路径。与 iframe 交互的 RPC 必须携带其出生时的 revision，不得用最新 store revision 替换旧请求的 revision。

## 4. 浏览器、RPC 与持久化接入规则

### 管理 RPC 的现有使用方式

在已经拿到 IrisClient 的 shell/测试环境中：

```ts
const stop = client.subscribe(event => {
  if (event.type === 'plugins.changed') renderSnapshot(event.snapshot)
})
try {
  renderSnapshot(await client.call('plugin.list', {}))
  renderSnapshot(await client.call('plugin.install', { id: 'demo-counter' }))
  renderSnapshot(await client.call('plugin.enable', { id: 'demo-counter' }))
} catch (error) {
  showError(error)
}
// 组件/插件销毁时调用 stop()。
```

renderSnapshot/showError 是使用者的 UI 回调。不要将该示例直接放进卡片脚本；卡片不能自行管理宿主系统插件。现有 PluginCenter/store 已负责重连与 revision 排序，优先复用，避免每个页面重做状态源。

### 新增业务 RPC

目前必须在中央 requestSchemas、响应类型和宿主 handler/注册处一起添加，并更新 fake/transport 测试。Claude 的动态注册机制完成后才能把 schema 放进插件包。不要通过 `as any`、全局 string 索引签名或绕过 parseRequest 把“能发送”当作完成接口支持。

未来动态注册要求：schema 与 handler 成对登记；同名拒绝；失败撤销；处理函数在入口取 lease；dispose 撤销两者；fake 有相同启停语义。单靠 fiber 最终撤销不能阻止 draining 期间的新请求。

### UI 和帧侧贡献

五个现有槽位见接口清单；楼层动作现成例子是 `apps/iris-web/src/app/DemoActionsSection.tsx`。注册必须收回，不能污染全局 window。

目前 `@iris/plugin-web-api` 只提供 TH/MVU 快照及编解码，不提供通用 registerPluginMembers。动态脚本加载完成前，不能靠增加一个 dsh.client 字段就让插件自动出现在页面。shell 与卡 iframe 的加载目标、权限和清理是两套执行边界，未来资产 manifest 必须区分它们。

### 持久化

插件开关由 runtime 写 `system-plugins.json`，不要在插件中手改。聊天/变量继续由既有 store 写，算法返回结果即可。卸载默认保留业务数据；删除数据应是另一个明确动作。

通用插件 storage/settings namespace 尚未实现。确需持久化的新插件，先定义宿主提供的窄存储接口，经过路径包含性、原子写、损坏保留、profile lock 等约束后再用，不能把 profile 路径暴露给卡片脚本。密钥不得进入普通插件 JSON、日志或快照。

## 5. 安装依赖、构建与执行

不要在其他人正在构建/服务的同一 worktree 执行 install。根 workspace 用 pnpm；`apps/iris-web` 用 npm。从新的、无人共写的工作区运行，先读取仓库说明和 lockfile，再使用对应安装命令：

```powershell
# 仓库根
pnpm install --frozen-lockfile --offline

# apps/iris-web
npm ci --offline
```

离线 metadata 缺失或 package.json/lockfile 不一致时，先报告真实原因，由该变更的 owner 修复依赖声明/锁文件；不要用临时手建 junction 作为最终交付，也不要提交不明 license/锁文件噪声。Vite/tsc 的路径 alias 通过并不保证 Node 运行期能找到 workspace 包。

```powershell
# 仓库根
npx tsc -p . --noEmit

# apps/iris-web
npx tsc --noEmit
npm run build
npm run check:render

# 回到仓库根
npm test
npm run test:no-corpus
```

执行验证宿主前创建全新临时数据目录，并选择空闲端口。以下在仓库根运行；只适合插件管理验证，不发送真实模型请求：

```powershell
$pluginPreviewPort = 8788
if (Get-NetTCPConnection -State Listen -LocalPort $pluginPreviewPort -ErrorAction SilentlyContinue) {
  throw '预览端口已占用，请选择另一个空闲端口，不要终止未知进程'
}
$pluginPreviewData = Join-Path ([IO.Path]::GetTempPath()) ('iris-plugin-preview-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $pluginPreviewData | Out-Null
$env:IRIS_DATA_DIR = $pluginPreviewData
$env:IRIS_PORT = [string]$pluginPreviewPort
$env:IRIS_WEB_DIST = Join-Path (Get-Location).Path 'apps/iris-web/dist/index.html'
node apps/iris/bin.ts
```

前台运行，浏览器打开 `http://127.0.0.1:8788`（若换端口则相应修改），进入设置 → Advanced/高级 → 系统插件。用 Ctrl+C 停止本终端启动的宿主。不要让多个宿主共用正式数据目录；临时 profile 路径留作验收证据，确认不需恢复时再清理。端口 8790 的现有进程不属于本任务。

现有两个内置插件：先停 MVU，才能停 TH；重新启用 MVU 会恢复所需依赖。卸载后可从同一目录重新安装。源码更新后的测试从停止/重启开发宿主开始；reload 测的是副作用释放与重新激活。

## 6. 验收矩阵

| 场景 | 必须观察到的结果 |
| --- | --- |
| 初次启动 | 既有默认 TH/MVU 启用；新 demo 不凭空默认启用 |
| 安装/启用 | 目录状态与真实 capability 对齐，失败有原因 |
| 依赖阻塞 | MVU 启用时拒绝停用/重载/卸载 TH，并说明先停 MVU |
| 异步停用 | 新请求立即拒绝；已接纳任务按合同结束；停用成功后无迟到提交 |
| 重载循环 | 至少连续三轮，一个 capability/一组监听器；旧回调不能操作新实例 |
| 激活失败 | 已注册的部分资源回收；其他插件可继续工作 |
| 存储失败 | 不伪报成功，不覆盖损坏偏好；错误可见 |
| MVU 停用期聊天 | 不初始化/更新/补放命令；重新启用不重放停用期文本 |
| TH 停用 | 原生对话、宏、世界书与静态消息仍能使用；依赖 TH 的脚本明确不可用 |
| 旧 iframe | 延迟 ready、RPC、fetch 返回不能复活旧 run 或带旧能力提交 |
| 重连/重启 | 新会话可接受新进程较低 revision；同会话不倒退 |
| 卸载重装 | 聊天、变量和应保留设置不丢失 |
| UI | 中英文、键盘、窄屏、等待与失败状态均可操作 |

现成测试起点：

```powershell
node --test packages/iris-plugin-api/tests/*.test.ts packages/iris-plugin-web-api/tests/*.test.ts packages/iris-app-service/tests/system-plugins.test.ts packages/iris-app-service/tests/system-plugin-extraction.test.ts packages/iris-client-fake/tests/system-plugins.test.ts apps/iris-web/tests/system-plugins-store.test.ts apps/iris-web/tests/plugin-center.test.ts apps/iris-web/tests/system-plugin-sandbox-lifecycle.test.ts
```

先完成 web build 再读取 no-corpus 结果，避免因缺 dist 多跳过测试。记录实际 fail/skip 和原因，不把“测试文件未能启动”算成测试通过。

## 7. 常见故障

| 现象 | 优先检查 |
| --- | --- |
| `Cannot find package @iris/text` 或契约包 | workspace/file 依赖链接与对应包管理器安装；不是先改业务代码 |
| tsc 通过、Node 测试启动失败 | tsc/Vite alias 与 Node 包解析是不同路径 |
| 插件 enabled 但没效果 | 是否有 capability 消费者；是否缓存旧对象；是否实际接入业务调用 |
| `unsupported` | 未注册方法、插件停用或 revision 过期，读取完整错误 |
| 插件一直 disabling | 未释放 lease、无截止的异步工作、任务内 await 停用自身 |
| 缺失前端成员 | 当前并无通用成员合并；核对实际能力快照与资产加载目标 |
| 重启后面板状态倒退 | 会话边界、list/event 竞态和旧 mutation 回包 |
| 修改文件后 reload 没变化 | 当前 reload 复用已载入 definition，需要重启开发宿主 |

## 8. 独立插件仓库与交付

当前两个契约包 `private: true`，版本 0.0.0，导出 TS 源码。它们是工作区契约，不是可以对外发布并承诺兼容的 npm SDK。

独立发布前完成：构建 JS 与声明文件、约定 apiVersion 兼容、验证安装后的真实 exports、避免带入第二份不兼容 Cordis 实例、提供包外消费者测试；再完成插件发现/资产/贡献注册和版本撤回机制。不能用把 private 改 false 来代替这些步骤。

每份交付至少包含：插件 id 与职责、运行位置、契约/实现版本、声明依赖、贡献接口、数据归属、失败和释放路径、测试结果、浏览器复现步骤、提交号与基线。PR 描述区分“代码实现”“测试通过”“浏览器验收”“已合并”。

多人协作：每个文件只设一个当前 owner；协议注册、runtime、frame 组装的交界按顺序集成。旧扩展设计里的静态卸载方式不再用于本控制面；未实现的设计必须留在待办区，不能写进可执行范例。
