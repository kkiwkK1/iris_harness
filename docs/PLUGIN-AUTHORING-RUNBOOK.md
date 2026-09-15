# Iris 插件制作与执行手册

2026-09-15，针对 `main` 的 `2eccf30`（PR #88「Add the system plugin platform and ST extension pilot」）。配套 [基础设施接口清单](INFRASTRUCTURE-INTERFACES.md)。

上一版写于 2026-09-12，基线是尚未合入的 `dev/system-plugins`，因此把「外部 client.js 扫描」「成员合并」列为未完成。这些已随 #88 落地：帧侧成员贡献、`/plugins` 下发、设置面贡献与 ST 扩展安装都有可执行路径，本版把它们写进制作步骤。仍未实现的接口（通用存储/设置、生成钩子、系统插件的 npm/Git 安装）照旧不可照草案调用，完整清单见接口清单 §8。

## 1. 先决定插件运行在哪里

| 需求 | 位置 | 今天的接入方式 |
| --- | --- | --- |
| 宿主算法、共享业务能力、自动处理 | Node 系统插件 | 实现 `SystemPluginDefinition`，加入内置目录，宿主通过 capability 使用 |
| 卡片脚本能调用的新成员 | 插件自带 `client.js`，跑在卡片 iframe | 写一个经典脚本 bundle，放进安装目录，帧按快照装载并做成员合并（§4「帧侧成员贡献」） |
| 未经修改的 SillyTavern 扩展 | shell 内的隐藏 facade iframe | 从目录或钉死 commit 的 Git 安装；ST 扩展**就是**一个系统插件，走同一套启停（§「安装一个 ST 扩展」） |
| 插件中心的管理操作 | shell UI | 使用现有 `plugin.*`，以返回快照和事件更新 |
| 页面按钮/面板 | shell UI 插槽 | 仓库内 UI 接线；设置区块可经 `iris.settings.sections` 贡献，但今天只有 shell 内代码能注册 |
| 卡片自带交互/脚本 | 卡片 iframe 沙盒 | 既有卡片脚本授权和 TH 兼容面；不能提升为 Node 插件 |

一个 Node 系统插件要么出现在 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`（`packages/iris-app-service/src/plugins/builtins.ts`）里，要么以 ST 扩展身份经 `adoptDefinition` 被接纳。**没有**「输入 npm 名称/Git URL 就装一个系统插件」的能力，也没有通用热更新源码加载器。ST 扩展那条路是给 ST 扩展的，不是给任意 Node 代码的后门。

`reload` 会释放并重新激活当前**已载入**的 definition；编辑磁盘 TypeScript 后通常需要重启开发宿主。

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

契约来自 `@iris/plugin-api`（[plugin-api/src/index.ts](../packages/iris-plugin-api/src/index.ts)）。app-service 只做 re-export，不要深导入它的 runtime 实现文件。

把它导入 `plugins/builtins.ts` 并加到 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`。这只是登记可安装实现，不要因此扩大默认启用集。当前默认启用 TH 与 MVU，新 demo 应由使用者主动安装/启用。

id 建议固定为短的小写 ASCII/kebab-case；显示名可以修改，id 改名等于新的持久化身份。runtime 只校验长度（1–200）、唯一性、apiVersion 与自依赖，不要把它当安全路径片段直接拼到资产或存储路径——资产路由自己另有 `safePluginId` 与包含性检查。

如果能力没有消费者，插件状态即使显示 enabled，也不会产生产品功能。编写者须列出「谁调用 capability、何时调用、输入输出、错误处理」，再把消费者接入既有业务路径。不要为调用一个 demo 另建通用绕过验证的 RPC。

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

宿主自有方法仍走中央路径：requestSchemas、响应类型、handler/注册处一起添加，并更新 fake/transport 测试。插件自有方法可走运行期登记，不需要改协议核心——**但 main 上还没有生产使用者**：随包发布的插件方法全部是静态 schema，这条路径目前只由 [system-plugin-rpc.test.ts](../packages/iris-app-service/tests/system-plugin-rpc.test.ts) 与 [rpc-registry.test.ts](../packages/iris-protocol/tests/rpc-registry.test.ts) 钉住。用它之前先确认你的方法确实「随插件启停而存在」。

```ts
import { z } from 'zod' // 或任何 safeParse 形状兼容的 schema 库
import type { SystemPluginDefinition } from '@iris/plugin-api'

const askSchema = z.object({ floor: z.number().int().min(0) })

activate(scope) {
  // 两半（协议注册表的 schema、运输层的 handler）成对登记；
  // 撤销随 activation 的 fiber dispose 自动执行，返回的句柄只是提前撤。
  scope.registerRpc('myplugin.ask', askSchema, async params => {
    if (params.floor > 100) {
      // 主动拒绝：抛带协议错误码的 Error，不要返回错误形状的结果。
      const refusal = new Error('floor beyond this profile\'s reach')
      ;(refusal as { code?: string }).code = 'invalid-request'
      throw refusal
    }
    return { echo: params.floor }
  })
}
```

语义（全部有行为测试钉住，见接口清单 §8 毕业记录）：

- **方法名是组合层事实**：撞内置名或撞已占用名在 activate 内抛错，只失败当事插件，先到者继续服务；不按加载顺序遮蔽。
- **每次调用经当事插件的 lease**：停用后新调用立即答 `unsupported`；请求携带的 `pluginRevision` 过期即拒；停用会排空在途调用后再释放注册。
- **两半同生同灭**：撤销/dispose 同时移除 schema 与 handler——方法要么完整存在，要么完整消失，调用侧读到的是同一状态的 `unsupported`。
- **类型层**：动态方法的 params/响应在客户端类型里是 `unknown`，注册处的 schema 就是它的类型；不要用 `as any` 或全局索引签名换取假的类型化。
- **fake 对应面**：测试/演示夹具用 `fakeClient.registerPluginMethod(method, schema, handler, { pluginId })`；命名 `pluginId` 的方法随该目录行启停失效，与宿主行为合同一致。

静态表仍是宿主方法的正确归属：能为所有构建实现的方法不要塞进插件。不要通过 `as any`、全局 string 索引签名或绕过 `parseRequest` 把「能发送」当作完成接口支持。

### 帧侧成员贡献（client.js）

这是插件让**卡片脚本**看见新成员的唯一路径。

**放在哪。** 宿主级安装目录：`<dataDir>/system-plugins/<id>/client/client.js`（`.map` 同目录，可选）。插件激活时自己写出来是可行做法——ST 兼容面就是这么做的（参考 `buildStExtensionDefinition` 的 activation 与 [member-bundle.ts](../packages/iris-compat-st-extension/src/host/member-bundle.ts)）。

**长什么样。** **经典脚本**，不是 ES 模块，不导出任何东西，运行到最后调用核心成员表：

```js
(function () {
  'use strict';
  var members = globalThis['__iris_members__'];
  members.registerPluginMembers('demo-counter', { demoCounter: Object.freeze({ next: next }) });
})();
```

**字面量 id 与字面量键名是承重的**：插件中心的 `scanPluginMemberNames`（`apps/iris-web/src/app/use-plugin-manifest.ts:208`）读源文本来报告这个 bundle 注册了哪些成员，拼接出来的 id 或计算出来的键名会让它对你失明——插件照跑，诊断列变瞎。

**怎么被送到帧里。** 宿主 `/plugins` 路由（[plugin-assets.ts](../packages/iris-app-service/src/plugin-assets.ts)）：

- `/plugins/manifest.json` 是聚合清单 `{ revision, plugins: { <id>: { rev, client } } }`，**只收已启用且磁盘上确有 bundle 的插件**，键排序，永远 `no-cache`。
- `/plugins/<id>/client.js?rev=<12 位十六进制>` 是 bundle。rev 是字节的 sha1 前 12 位。**`?rev=` 与当前内容 rev 相等才发 `immutable`**，其余情况一律 `no-cache`；插件一停用，清单里没有行，这个 URL 也 404。
- 路由挂在 `irisRpc.guard` 之后，与其他 Iris 路由同一道防护。**刻意没有**走 `@deepseek-ai/dsh-client-modules`，理由在模块头（`packages/iris-app-service/src/plugin-assets.ts:16`）。

**帧怎么接纳它。** shell 把清单行并进帧快照（`sandboxPluginRuntime(snapshot, manifest)`），srcdoc 按行写 `<script src="…" crossorigin="anonymous" data-iris-plugin="<id>">`。标签顺序是**成员表 → bootstrap → 插件 → 卡片**：bootstrap 先把「本帧准入了哪些插件」公布到 `__iris_plugins_admitted__`，插件脚本才跑。

登记闸门 `registerPluginMembers`（`apps/iris-web/src/sandbox/members-entry.ts:90`）依次检查：**准入**（id 不在准入记录里就拒——被停用插件的缓存 bundle 即使执行了也登记不进任何东西）→ **形状** → **撞核心表** → **撞别的插件** → **重复登记**。任一条都是抛错并点名插件与成员，不是静默覆盖。通过后成员被**冻结**。

**拒绝是按插件的，不是按帧的**（`apps/iris-web/src/sandbox/plugin-members.ts`）：核心表缺席才整帧拒跑；你的 bundle 被拦、解析失败或在 ready 标记之前抛了，只废掉你自己的成员，报告点名你和原因，别的卡片照常运行；卡片探测被拒命名空间时拿到的是那条报告，而不是一个裸 `undefined`。插件中心的资产状态列读的就是这些判定。

**revision 绑定。** 帧在 `runCard` 时捕获 revision 并一直带着它。插件启停会推高 revision，shell 比对 `ready.systemPlugins.revision === pluginRevision` 销毁旧帧，宿主 `assertCurrent` 拒绝过期栅栏的请求，资产面 404 掉旧 bundle URL——三处一致，旧帧不会带着旧能力提交。

核心成员名单 `MEMBER_KINDS` 与 `CARD_METHODS`（37 项）仍归 shell 所有，插件不能往里加；你只能在自己的命名空间下贡献。

### 设置面贡献

设置抽屉的插件页有一个 `iris.settings.sections` 槽。注册：

```ts
const dispose = slots.core.register(
  { name: 'iris.settings.sections', registrant: 'demo-counter', id: 'demo-counter-settings', label: 'Demo counter' },
  () => <DemoCounterSettings />,
)
```

`SettingsDrawer` 里的 `PluginSettings` 用 `useSlotOccupied('iris.settings.sections')` 查占位，**没有任何贡献时连标题和引导语都不渲染**——贡献的生命周期就是插件的启用期，停用后不能留下一个声称「这里有设置」的空标题。撤销必须收回，不能污染全局 window。

**今天只有 shell 内驻留的代码能注册**：`SystemPluginActivationScope` 上没有 settings 接口，宿主侧的 Node 插件贡献不了设置区块。唯一的真实注册者是 shell 里的 ST 扩展面（`apps/iris-web/src/st-extensions/plane.tsx`）。这是接口清单 §8 里记着的缺口，不是可以绕过的实现细节。

### 变量写入规则

想在一轮回复落盘时写消息层变量，在 `activate` 里登记一个 **writer**，不要自己往变量库里写：

```ts
export function activate(scope) {
  return scope.variables.registerWriter({
    // 本 writer 的提案是相对哪张表的增量。
    baselineFor: view => view.baseline,
    // 提案：完整表；undefined 表示这一轮不写。
    propose: view => {
      if (view.kind === 'impersonate') return undefined
      return { variables: compute(view.text, view.baseline) }
    },
  })
}
```

`baselineFor` 与 `propose` 各答一个独立的问题。`propose` 给出**你想要的完整表**；`baselineFor` 声明**它是相对谁的增量**——参与合并的只有增量，宿主据此算出你实际改了什么。宿主自带的两个写方就选了不同的基线：ST-compat 桥的楼层表相对本轮消息层原表（`view.baseline`），MVU 相对「向前找最近一张带 `stat_data` 的表、找不到退回卡声明」走出来的状态树（`view.variablesAt` 逐轮回看，`view.declared` 兜底）。选错的后果是仲裁把你的整张表当成改动，或把你真正的改动漏算。

`view` 携带结算的全部事实：`chatId`、`turn`、`kind`（`send`/`regenerate`/`continue`/`impersonate`——**扮演轮写出的是用户行，不携带变量后果，writer 自己判断并不写**，宿主不再代劳）、`reason`（`completed`/`aborted`——被叫停的轮次仍会结算它已有的文本）、`text`（已过 trim 与桥改写、即将落盘的那份）、`baseline`、`variablesAt(turn)`、`declared`、`signal`。**`propose` 应当是同步或毫秒级的**：每个 writer 的预算是 5 s（`WRITER_TIMEOUT_MS`），超时或抛错的提案本轮作废、行上记一条 `hook-failed`、回复照常落盘——writer 失败不是插件失败，插件不会被停用；下一轮成功提案自动清除该提示。串行结算，k 个慢 writer 最坏把回复拖住 k×5 s。

- **顺序 = 激活顺序**，按 (依赖深度, id) 排序。你排在谁后面由**依赖声明**决定，不是由 id 拼写决定：`mvu` 排在无依赖插件之后，是因为它声明了 `dependencies: ['tavern-helper']` 而不是 `'mvu'` 的字母序靠后。**后者胜**，每一次覆盖记成一条冲突（`key` / `earlierPluginId` / `laterPluginId` / `winnerPluginId`），以 `{ kind: 'variables', grade: 'note' }` 报出来。
- 一个插件一轮最多一条提案：同一插件在同一结算里出现第二条提案按故障处理（行上记 `hook-failed`），不会被静默合并。
- 停用即摘除：writer 随 activation 的 fiber dispose 注销，停用的插件立刻从结算参与者集合里消失（下一次结算就看不见它）；进行中的那一轮以快照为准，不受中途停用影响。
- 结算只有一处（`#settle` 的 writer 循环 + 一次 `arbitrateMessageVariables` + 一次 `replaceVariables`）。`propose` 里**永远不要**碰 `entry.variables`——那会绕过仲裁与冲突上报。

算法在 [variable-arbitration.ts](../packages/iris-app-service/src/variable-arbitration.ts)，注册表在 `SystemPluginRuntime`（`registerVariableWriter` / `orderedVariableWriters`）。`.setVariables` 那类脚本面是宿主自己的写入口，与本接口无关；manifest 里声明 `write-variables`（同意页会显示，它是声明不是闸门）。

### 持久化

插件开关由 runtime 写 `system-plugins.json`（profile 根，`packages/iris-app-service/src/index.ts:779`），不要在插件中手改。**先落盘再改内存**：写失败会把持久化行回滚并抛 `internal`，所以不会出现「界面已启用、重启后消失」。偏好文件读不动时全部插件置 `error` 且**保留原文件**——不要写「修复」逻辑去覆盖它。

聊天/变量继续由既有 store 写，算法返回结果即可。卸载默认保留业务数据；删除数据应是另一个明确动作。

通用插件 storage/settings namespace 尚未实现（ST 扩展的设置走的是专门的闭包，不是通用接口）。确需持久化的新插件，先定义宿主提供的窄存储接口，经过路径包含性、原子写、损坏保留、profile lock 等约束后再用，不能把 profile 路径暴露给卡片脚本。密钥不得进入普通插件 JSON、日志或快照。

## 安装一个系统插件包

第 2 节的最小宿主插件是**随仓库发行**的（进 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`）。同一份
`SystemPluginDefinition` 也可以打成一个**仓库外的包**，从一个 https git 远端或本地开发目录装进某个
profile，走的是同一套目录、依赖、启停、卸载——不是第二套生命周期。裁决与设计在
[SYSTEM-PLUGIN-INSTALL](SYSTEM-PLUGIN-INSTALL.md)；本节是作者视角的操作说明。

**先记住一件事**：系统插件是**与宿主同权的 Node 代码**，`activate` 在宿主进程里拿到宿主的全部触达
能力。没有沙盒。清单里的 `permissions` 是**声明**，宿主只校验拼写并在同意页展示，它不是宿主强制的
边界。挡风险的是「代码从哪来」和「用户是否明确同意」。

### 包长什么样

一个目录，根部 `package.json` 带一个 `iris.plugin` 块：

```jsonc
{
  "name": "iris-plugin-demo",
  "version": "0.3.1",
  "type": "module",
  "iris": {
    "plugin": {
      "id": "demo",                     // [a-z0-9][a-z0-9._-]{0,63}：它会变成目录名和 URL 段
      "apiVersion": 1,                  // 整数，或 "1.0" 这样的 major.minor 字符串
      "host": "host.js",                // 必填，相对树内路径，默认导出一个 SystemPluginDefinition
      "client": "client.js",            // 可选，帧侧成员 bundle
      "i18n": {                         // 可选，插件自带的界面文案（见下节）
        "en": "i18n/en.json",
        "zh": "i18n/zh.json"
      },
      "displayName": "Demo",            // 必填
      "description": "…",               // 必填
      "capabilities": ["demo.state"],   // 可选，自由文本：我**提供**什么
      "permissions": ["provide-capability", "register-rpc"],  // 可选，闭合词表：我**用到**什么
      "dependencies": ["tavern-helper"] // 可选，其他插件 id
    }
  }
}
```

- `host.js` 是普通 ESM，**默认导出一个 definition 对象，不是工厂**。启用时宿主
  `import(pathToFileURL(host.js))`，然后逐条核对：`id` 必须等于清单的 `id`，`apiVersion` 必须等于
  清单的 major，`activate` 必须是函数。任何一条不符是 `load-failed` 并点名字段。
- `permissions` 的四个合法值是 `provide-capability`、`get-dependency`、`register-rpc`、`host-context`，
  一一对应 `SystemPluginActivationScope` 上四个交出触达能力的成员。写错一个名字是
  `manifest-invalid`，字段为 `permissions[i]`。
- `client.js` 的要求就是帧侧扫描器的要求：`registerPluginMembers('<字符串字面量 id>', { 字面量键: … })`。
  计算出来的 id 或成员键**扫不出来**，那不是报错，是「这个插件不声明成员」；真正的拒绝发生在重名
  （`conflict`）与帧内没跑完，且都是**按插件拒，不是按帧**。
- 包里**不允许**有 `node_modules/`：`@iris/*` 是 `import type`、构建期擦除，而带进第二份 cordis
  的失败**没有任何症状**——你的服务会落进宿主永远不读的注册表。带了就是 `install-failed`。
- 上限：**256 MiB / 20,000 文件**（`PLUGIN_TREE_LIMITS`）。树里不能有符号链接或 junction。

### 插件自带文案

插件可以带自己的界面文案（两种语言，en 与 zh）。清单里写**两个**相对树内路径，一旦出现 `i18n`，
两个键都**必须**在——缺哪个，拒绝消息的 `field` 就点哪个（`i18n.en` / `i18n.zh`）：

```jsonc
"iris": { "plugin": {
  "id": "demo",
  // …
  "i18n": { "en": "i18n/en.json", "zh": "i18n/zh.json" }
} }
```

每份文件是一个**平坦**的 `键 → 字符串` 表：

```json
{ "displayName": "Demo Panel", "description": "A {name} panel", "panelTitle": "Panel" }
```

键的语法是 `[a-zA-Z][a-zA-Z0-9]*`（会拼进运行期键 `plugin:<id>:<key>`，所以不许带标点）；值必须是
字符串。**单份文件**的上限是 256 KiB / 2,000 条（`PLUGIN_COPY_LIMITS`），超出在安装前就被拒。

**预览期审计**（与宿主跑的是同一份规则实现，`@iris/text`）拒三种：

1. 两列键集合不一致——多一个少一个键都拒；
2. zh 列里混了没有中文的值（纯数字/单位的行可由壳白名单豁免，插件侧没有白名单）；
3. 两列的 `{槽位}` 集合不一致——zh 有 `{name}` 而 en 没有就是断句。真实的拒绝消息长这样：
   `manifest-invalid: i18n.zh.greeting — placeholder drift on "greeting"`，`field` 永远点到具体键。

**两个约定键**：如果文案里有 `displayName` 和 `description`，插件中心的目录行会用它们替换清单里
的静态名字/描述（按界面当前语言取，zh 缺了回退 en）。同名的壳句子不会被插件夺走。

**前端取词**：壳里任何要读插件文案的地方用运行期键 `plugin:<id>:<key>` 查覆盖层
（`translate(lang, 'plugin:<id>:<key>')`，或订阅式的 `tPlugin(id, key, params)`）。回退链是
当前语言 → en → **键名本身**——查不到会在屏幕上显示 `plugin:demo:panelTitle`，这是故意的可见失败，
不是空白。停用插件即 404，下一次清单到达后它的文案从界面上消失。文件走资产面
`/plugins/<id>/i18n/<lang>.json?rev=<12 位 hex>`，与 client bundle 同一套缓存与停用规则。

### 开发时用 `dev` 源

```ts
const preview = await client.call('plugin.previewInstall', {
  source: { kind: 'dev', path: 'D:/work/iris-plugin-demo' },
})
await client.call('plugin.confirmInstall', {
  previewToken: preview.previewToken, id: preview.id, commit: null, treeHash: preview.treeHash,
})
```

`dev` 源**就地加载你自己的目录**：包不会被复制进 profile，卸载也**绝不**碰你的工作目录。代价是它是
唯一一条不做字节复核的源，所以它在 `system-plugins.json`、在目录行、在同意页上**三处都被标成
`dev`**。改完代码重启宿主（或 `plugin.reload`）即可生效——它永远不会变成 `tampered`。

### 发布时用 `git` 源

```ts
const preview = await client.call('plugin.previewInstall', {
  source: { kind: 'git', remote: 'https://example.invalid/acme/iris-plugin-demo.git', commit: '<完整 40 位 sha>' },
})
```

约束是硬的：**只接受 `https://`**，**必须钉完整 40 位十六进制 commit**（会动的 ref 会让锁记录说谎），
URL 里含空白、引号或**用户名密码**一律拒。git 固定 argv、不过 shell、每次清空 `core.hooksPath`、
`--depth 1 --no-recurse-submodules --no-tags`，`.git/` 在哈希与促进之前被删掉。装进来的树落在
`<profile>/system-plugins/installed/<id>/`，并记下 `(remote, commit, treeHash)`；**每次开机重算
`hashTree` 并比对**，不符即 `tampered` 且不激活。卸载会**删掉这棵树**（插件树里没有用户数据，它是一个
可复现的只读产物），这与 ST 扩展「卸载保留安装树」是**相反**的，故意如此。

### 同意页给用户看什么

`plugin.previewInstall` 把包装进 staging 就停下——**不 import 包里任何东西**——然后返回：id、
displayName、description、version、apiVersion 与是否兼容（以及本机支持的区间）、源与
remote/commit 或 path、`treeHash`、文件数与字节数、`capabilities`、`permissions`、`dependencies`、
是否带 `client.js`，以及 `warnings`（例如「声明的 dependency 不在本机目录里」「id 已被占用」）。

用户确认时 `plugin.confirmInstall` 把 id、`treeHash`、commit **原样回带**，宿主逐条与**事务记录**
比对（不重新拉取），任何一条不符就整体拒绝并丢弃事务。放弃则 `plugin.cancelInstall({ previewToken })`，
staging 当场删掉。**安装不等于启用**：confirm 之后行是 `installed, enabled: false`，用户另点一次
「启用」，那才是 `host.js` 第一次被 import 的时刻。

**id 撞车**：装进来的 id 与目录里已有的任何 id（内置的或已装的）相同，confirm 阶段以
`install-failed`（id 已被占用）拒绝。没有「装得进去但永远不激活」的影子行。

**更新**：本轮没有更新事务。`plugin.update({ id, commit })` 的位子留着，但它答 `unsupported`。
换 commit 的路是**卸载后重装**，走完整同意。UI 里也**没有**这个按钮。

### 用户在界面上实际看到的是什么

上面那些 RPC 是给测试和脚本看的；用户走的是**设置抽屉 → 插件 → 「安装插件包…」**
（`apps/iris-web/src/app/PluginCenter.tsx`）。作为作者，你的包会以下面这个样子被人审视：

**表单。** 两个单选源。`git` 要一个远端 URL 和一个 commit，浏览器先自己检查一遍 commit 的形状
（必须是 40 位小写十六进制），所以打错一个字符当场就说，不用等一次 clone；不合规的远端仍然由宿主
拒绝，**宿主那句话原样显示**，不会被换成一句笼统的「Iris 不会发送这个请求」。`dev` 只要一个目录路径。

**同意页。** preview 除 `previewToken` 外的**每一个字段各占一行**，字段名就是协议键名
（页面上带 `data-consent-field`，测试拿它和 preview 对象的键集对账，所以协议加字段而页面漏显示是一条
变红的断言）。排在最前面的是三段话，不是字段：

1. 「这是宿主代码。一旦启用，它能触及 Iris 能触及的一切：你的对话、你的文件、你的 API 密钥。
   Iris 不给系统插件沙箱，本页上的任何一项都不是对它能做什么的限制。」——§9 不变量 #16 要求的那句。
2. `dev` 源还多一段：它的字节永远不会被复核，所以它在哪都标着 `dev`。
3. 「安装不等于启用。」

然后才是 id、名称、描述、版本、`apiVersion` / 本机支持区间 / 是否兼容（三行）、源徽标、
remote + commit 或 path、`treeHash`（旁注「确认即是同意这一份字节，仅此而已」）、文件数、
体量（人类单位）、`capabilities`（旁注「Iris 没有能力注册表可以校验它」）、`permissions`
（列表 + 裁决 4 那句「不是 Iris 强制的边界」）、`dependencies`、是否带 `client.js`、`warnings`。

**`incompatible` 的预览照样显示整页**，只是确认按钮是灰的，并多一句为什么——你想让作者看见自己的包
被拒在哪一行，而不是一个空白页。

**你的包装好之后，行上会多两样**：`source` 徽标（`dev` 最醒目）与一个可展开的「安装时记录」
（摘要是短 commit / 短 treeHash / 安装时间，展开是全值）。`git` 行的卸载注记写着「卸载会从这个
profile 里删掉安装树」，`dev` 行写着「你的开发目录绝不会被碰」。

### 六个失败状态，对作者分别意味着什么

它们都落在 `plugin.list` 的行上（`failure.state`），不是日志，也不是崩溃。**在界面上**，每个状态在行上
都是同一个形状的红块：一句「这是什么」、点名的字段或 git 步骤、**宿主自己那句 `reason` 原样照抄**、
再一句「你能做什么」。所以下表第三列就是用户会读到的那句话的来源。

| 状态 | 发生在 | 你该改什么 |
| --- | --- | --- |
| `install-failed` | 取源 / 促进 | 远端或 commit 不合规（非 https、未钉满 40 位、URL 带凭据）、远端没有这个 commit、树超上限、树里有 `node_modules/`、或 id 已被占用。消息里带 git 的哪一步，行上写成「git 步骤：fetch」 |
| `manifest-invalid` | 读清单 | `iris.plugin` 缺失或字段不合规。**永远点名字段**：`id`、`apiVersion`、`host`、`client`、`displayName`、`description`、`permissions[i]`、`dependencies[i]`。`host`/`client` 必须是相对、正斜杠、树内路径，不能有 `..`、盘符、反斜杠，也不能穿过符号链接 |
| `incompatible` | 读清单之后 | 你的 `apiVersion` 不在本机支持区间内。装的时候直接拒；已经装着的行留在目录里不激活，行上写明「需要 N，本机支持 1.0–1.0」 |
| `tampered` | 开机复核 | 磁盘上的字节与安装时记录的 `treeHash` 不符——手改过安装树就会这样。行上因此多一个「按记录的 remote + commit 重新安装」按钮，它**先卸载再 preview**（裁决 5 在 id 还占着时会拒绝 confirm），然后走同一张同意页；没有「接受当前字节」这个按钮，那会让整个哈希锁定被一键绕过 |
| `load-failed` | `import(host.js)` | 模块顶层抛错，或默认导出不是一个 definition / id 对不上 / apiVersion 对不上 / 没有 `activate`。行上带字段名 |
| `activate-failed` | `activate()` 抛错 | 你的 `activate` 抛了。走既有的失败回滚，不会留下半注册的能力 |

前四个状态下 `plugin.enable` 是**拒绝**（`unsupported`，消息点名状态）：一次重新 import 树的重试，
就是一次可能在被篡改的字节上成功的启用。`load-failed` 与 `activate-failed` 是仅有的两个可重试状态——
改完文件再点一次启用即可。

## 安装一个 ST 扩展

一个未经修改的 SillyTavern 扩展可以装进 Iris，在 shell 的隐藏 facade iframe 里运行。**它就是一个系统插件**：安装后被 `adoptDefinition` 接纳，之后的启停/卸载走的是同一套 `plugin.*`。

**安装。** RPC `stExtension.install({ path })`，`path` 指向一个含 `manifest.json` 的本地目录。宿主读 `display_name`、slugify 成 id、校验合法，**安装树仍在则直接重新接纳**（这是「重装」，不是静默覆盖），否则真正安装，再 `normalizeManifest` → `adoptDefinition`（`packages/iris-app-service/src/index.ts:846`）。

**安装器接受什么。** 三种源（[source.ts](../packages/iris-extension-installer/src/source.ts)）：`local-archive`、`local-directory`、`git`。git 的约束是硬的：

- 必须 `https://`（`file://` 只在 `allowLocalGit` 下给测试用），URL 含空白或引号直接拒；
- 必须钉**完整 40 位十六进制 commit**——会动的 ref 会让锁记录说谎；
- 固定 argv、不过 shell，每次调用 `-c core.hooksPath=` 清空钩子，fetch 带 `--depth 1 --no-recurse-submodules --no-tags`：拉下来的树在 fetch/checkout 期间执行不了任何东西。

**分析报告说什么。** 静态分析（[analyze.ts](../packages/iris-compat-st-extension/src/analyze.ts)，TypeScript AST，**不执行、不联网**）把扩展导入的每个 ST 模块路径对照 17 条映射表判定：`mapped`（facade 有）、`missing`、或 `unknown`（唯一后缀候选，点名候选而不下断言）。未映射路径在运行期抛 `UnsupportedStCompatApiError`。试点对象的**锁定**报告是 `packages/iris-compat-st-extension/reports/st-prompt-template@f9a07da.report.json`。已记录的行为偏差（`messageFormatting` 只做 HTML 转义、`saveChatConditional` 是 no-op、token 计数是估算、事件映射不完整）见 [PILOT-REPORT](../notes/st-compat/PILOT-REPORT.md)。

**启停与卸载。** 就是 `plugin.enable` / `plugin.disable` / `plugin.uninstall`，没有第二套生命周期。停用后 `/iris-st-ext/<id>/…` 的每条路径都 404（manifest 也不例外），plane iframe 消失，模板原文直通。**卸载保留安装树与设置文件**——artifact 和设置是用户数据；同一目录再装就是重装。

**试点只服务一个扩展**：快照里第一个非内置的已安装行（`packages/iris-app-service/src/index.ts:838`）。

**证据与复跑。** 浏览器验收脚本与逐轮证据在 `notes/st-compat/acceptance/`（`seed.mjs`、`run-uc1.mjs` / `run-uc2.mjs` / `run-uc3.mjs`、`run-revision.mjs`、`run-fault.mjs`、`run-uninstall.mjs`、`run-st-compare.mjs`，夹具 `lib.mjs` / `cdp.mjs` / `mock-provider.mjs` / `pilot-host.mjs`，证据目录 `evidence/`）。复跑用隔离端口：

```powershell
$env:PILOT_PORT = '8811'
node notes/st-compat/acceptance/run-uc1.mjs
```

结论与逐项判定见 [PILOT-REPORT](../notes/st-compat/PILOT-REPORT.md)；平台侧的联合验收见 [PLUGIN-PLATFORM-ACCEPTANCE](../notes/PLUGIN-PLATFORM-ACCEPTANCE-2026-09-13.md)。

## 5. 安装依赖、构建与执行

不要在其他人正在构建/服务的同一 worktree 执行 install。根 workspace 用 pnpm；`apps/iris-web` 用 npm。从新的、无人共写的工作区运行，先读取仓库说明和 lockfile，再使用对应安装命令：

```powershell
# 仓库根
pnpm install --frozen-lockfile --offline

# apps/iris-web
npm ci --offline
```

**实测过的失败**：只要有一条依赖边变化（新增依赖、改版本、新 workspace 包），pnpm 11.24 的供应链校验会去读全部 lockfile 条目的 registry 元数据，离线镜像没有就死在 `ERR_PNPM_NO_OFFLINE_META`——`--config.minimumReleaseAge=0` 绕不过去，而同一次运行还会打印「Lockfile is up to date, resolution step is skipped」，容易误读成安装成功。这种情况下必须在**那个 worktree**里跑一次联网 `pnpm install`，然后确认 lockfile 的 diff 只落在 importer 条目上。不要用临时手建 junction 作为最终交付，也不要提交不明 license/锁文件噪声。Vite/tsc 的路径 alias 通过并不保证 Node 运行期能找到 workspace 包。

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

执行验证宿主前创建全新临时数据目录，并选择空闲端口。**每份数据目录只能跑一个宿主**：`host-lock.ts` 的 `acquireHostLock` 写 `host.lock`，没有绕过开关；端口被占是 `EADDRINUSE` 直接启动失败，绝不会「换个地方起来」。以下在仓库根运行；只适合插件管理验证，不发送真实模型请求：

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

前台运行，浏览器打开 `http://127.0.0.1:8788`（若换端口则相应修改），进入设置 → 插件。用 Ctrl+C 停止本终端启动的宿主。不要让多个宿主共用正式数据目录；临时 profile 路径留作验收证据，确认不需恢复时再清理。端口 8787/8790 的现有进程不属于本任务。

注意 ST 扩展的资产路由只在配置了 `webDistIndex`（即上面的 `IRIS_WEB_DIST`）时才注册；不带它启动的宿主可以管理插件，但装不出可用的 ST 扩展面。

现有两个内置插件：先停 MVU，才能停 TH；重新启用 MVU 会恢复所需依赖。卸载后可从同一目录重新安装。源码更新后的测试从停止/重启开发宿主开始；reload 测的是副作用释放与重新激活。

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

现成测试起点：

```powershell
node --test packages/iris-plugin-api/tests/*.test.ts packages/iris-plugin-web-api/tests/*.test.ts packages/iris-app-service/tests/system-plugins.test.ts packages/iris-app-service/tests/system-plugin-extraction.test.ts packages/iris-app-service/tests/system-plugin-rpc.test.ts packages/iris-app-service/tests/plugin-assets.test.ts packages/iris-app-service/tests/variable-arbitration.test.ts packages/iris-app-service/tests/st-compat-floor-variables.test.ts packages/iris-app-service/tests/st-reinstall.test.ts packages/iris-protocol/tests/rpc.test.ts packages/iris-protocol/tests/rpc-registry.test.ts packages/iris-client-fake/tests/system-plugins.test.ts packages/iris-client-fake/tests/plugin-methods.test.ts apps/iris/tests/plugin-assets-plane.test.ts apps/iris/tests/rpc-transport.test.ts apps/iris/tests/architecture.test.ts apps/iris-web/tests/system-plugins-store.test.ts apps/iris-web/tests/plugin-center.test.ts apps/iris-web/tests/plugin-member-merge.test.ts apps/iris-web/tests/plugin-browser-assets.test.ts apps/iris-web/tests/plugin-browser-assets-mount.test.ts apps/iris-web/tests/sandbox-srcdoc.test.ts apps/iris-web/tests/system-plugin-sandbox-lifecycle.test.ts
```

ST 试点另有 `packages/iris-compat-st-extension/tests/*.test.ts`、`packages/iris-extension-installer/tests/*.test.ts` 与 `apps/iris-web/tests/st-ext-*.test.ts`；浏览器夹具 `qa/plugin-platform/browser-fixture.mjs` 用生产 `buildSrcdoc` 与生产 bootstrap/members bundle 跑一次真实装载。

先完成 web build 再读取 no-corpus 结果，避免因缺 dist 多跳过测试（无语料时的预期是 40 skipped / 0 failed，见 [PILOT-REPORT](../notes/st-compat/PILOT-REPORT.md)）。记录实际 fail/skip 和原因，不把「测试文件未能启动」算成测试通过。

## 7. 常见故障

| 现象 | 优先检查 |
| --- | --- |
| `Cannot find package @iris/text` 或契约包 | workspace/file 依赖链接与对应包管理器安装；不是先改业务代码 |
| `ERR_PNPM_NO_OFFLINE_META` | 有依赖边变化，离线镜像没有该包元数据；在该 worktree 跑一次联网 `pnpm install`，再确认 lockfile diff 只落在 importer 条目 |
| tsc 通过、Node 测试启动失败 | tsc/Vite alias 与 Node 包解析是不同路径 |
| 插件 enabled 但没效果 | 是否有 capability 消费者；是否缓存旧对象；是否实际接入业务调用 |
| `unsupported` | 未注册方法、插件停用、revision 过期，或宿主根本没配置该控制面（`requirePlugins`/`requireStCompat`）；读取完整错误 |
| 插件一直 disabling | 未释放 lease、无截止的异步工作、任务内 await 停用自身 |
| 卡片看不到插件成员 | 按插件的拒绝报告读：bundle 是否在 `<dataDir>/system-plugins/<id>/client/client.js`；插件是否启用（停用即无清单行、URL 404）；`registerPluginMembers` 是否撞了核心表或别的插件；脚本是否跑到最后一句 |
| 插件中心成员列是空的但插件在跑 | `scanPluginMemberNames` 读的是源文本；id 或成员键名不是字面量就扫不到 |
| 旧帧仍在用旧能力 | revision 绑定三处（shell 比对、宿主 `assertCurrent`、资产面 404）是否都走到；不要用最新 store revision 替换旧请求的 |
| 重启后面板状态倒退 | 会话边界、list/event 竞态和旧 mutation 回包 |
| 修改文件后 reload 没变化 | 当前 reload 复用已载入 definition，需要重启开发宿主 |
| 宿主起不来，报端口占用 | 每份数据目录只跑一个宿主（`host.lock`，无绕过）；换空闲端口和新临时数据目录，不要去杀未知进程 |

## 8. 独立插件仓库与交付

当前两个契约包 `@iris/plugin-api` 与 `@iris/plugin-web-api` 都是 `private: true`、版本 `0.0.0`、`exports` 指向 `./src/*.ts`（TS 源码）。它们是工作区契约，不是可以对外发布并承诺兼容的 npm SDK。同样地，**一个 Node 系统插件今天必须在仓库内**：要么进 `BUILTIN_SYSTEM_PLUGIN_DEFINITIONS`，要么以 ST 扩展身份被 `adoptDefinition` 接纳，没有第三条路。

独立发布前需要完成的具体项：

- 构建 JS 产物与 `.d.ts` 声明入口，`exports` 不再指向 `.ts` 源码；
- 去掉 `private: true` 之前先定版本与 `apiVersion` 兼容承诺（破坏性变更出新版本，不原地改）；
- peer 依赖策略：Cordis 必须是 peer，避免装进第二份不兼容的 Cordis 实例；
- 验证安装后的真实 exports（从包外消费，不是从 workspace alias）；
- 包外消费者测试，跑在一个不含本仓库 alias 的目录里；
- 之后才是插件发现、资产下发注册、贡献注册与版本撤回机制。

把 `private` 改成 `false` 不能代替上面任何一步。

每份交付至少包含：插件 id 与职责、运行位置、契约/实现版本、声明依赖、贡献接口（capability / 运行期 RPC / 帧侧成员 / 设置区块，逐项说明）、数据归属、失败和释放路径、测试结果、浏览器复现步骤、提交号与基线。PR 描述区分「代码实现」「测试通过」「浏览器验收」「已合并」。

多人协作：每个文件只设一个当前 owner；协议注册、runtime、frame 组装的交界按顺序集成。旧扩展设计里的静态卸载方式不再用于本控制面；未实现的设计必须留在待办区，不能写进可执行范例。
