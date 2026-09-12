# PLUGIN-CONTRACT-LANDING-SITES —— 第二批施工落点底稿

- 日期:2026-09-12。工作目录 `D:/workspace/小项目/iris-system-plugins`(独立 worktree),分支 `dev/system-plugins`,现场保存点 `ae55920`。**只读勘察,未改任何产品代码。**
- 性质:为四件 Claude 侧施工(运行期 RPC schema 注册 + Partial Handlers、`/plugins/<id>/client.js` 资产面、dsh.client 清单扫描 + 成员表合并、可变资产清单)写落点底稿。每个落点:现状(`file:line`)→ 切面设计草案 → 风险(语义交界,标出 Codex 的行)→ 工作量。
- 行号以 `ae55920` 工作区为准。`packages/iris-plugin-api` / `iris-plugin-web-api` 由并行代理孵化,本稿只引用其**未来**的接口名;所有现存类型引自 `packages/iris-app-service/src/system-plugins.ts`。
- 边界与语义交界见 `notes/SYSTEM-PLUGINS-HANDOFF.md:14-22`:`rpc.ts`、fake client、frame 启动/成员装配是双方合并交界;动态贡献机制不得绕过 admission、lease、dispose。

## 0. 总览

| 落点 | 核心结论 | 量级 |
| --- | --- | --- |
| 1 运行期 RPC 注册 | 运输层(`IrisRpcHost.handlers`)本来就是 `Map<string,…>`,运行期注册的阻力**只在类型层**:`requestSchemas` 字面量、`RpcMethod = keyof typeof requestSchemas`、`parseRequest` 只查字面量、`Handlers` 全量 map、fake 的 `never` 守卫。切面是**协议内加一个运行期注册表**,`parseRequest` 查完字面量再查它 | M |
| 2 /plugins 资产面 | **`/plugins/<id>/client.js` 路由、`dsh.client` 清单扫描、`__DSH_BOOT__` 注入在 `@deepseek-ai/dsh-client-modules` 的 node 半边已整建制存在**,Iris 没接线(cordis.yml 无此行,main.tsx 在页内自造 boot 图)。切面是组合行 + 一个 Iris 自己的注册服务;真正的缺口是 **CORS 头**(帧加载需要)与 **guard 包裹** | M |
| 3 成员表合并 | 帧侧能力快照 `SandboxPluginRuntime` 是硬编码双布尔;成员表是构建期单文件赋值 + `MEMBERS_MARKER` 尾哨兵。切面:快照加 per-plugin 维度、成员表加插件命名空间、**拒跑语义从"表缺席全拒"改为"core 缺席全拒、插件缺席点名"**。全部走 Codex 已建的 revision→销毁重建机制,不另起第二套 | L |
| 4 可变资产清单 | 构建期闸(check-bootstrap/check-preset/prune/architecture allowlist)各有明确的保护对象,**大部分原样保留**;要新加的是运行期闸:插件资产走"serve 时读 manifest、缺了就 no-cache"的既有性质、插件方法注册随 Cordis fiber 可逆、shell 侧资产 fetch 失败可见 | S–M |

---

## 1. 落点一:运行期 RPC schema 注册 + Partial Handlers + fake 开放分发

### 1.1 现状

**协议(`packages/iris-protocol/src/rpc.ts`)**

- `requestSchemas` 是 `as const` 字面量(`rpc.ts:243-2225`);`export type RpcMethod = keyof typeof requestSchemas`(`rpc.ts:2228`)。
- `PluginRevisionRequest`(`rpc.ts:2231-2233`)是附加接口;`RpcRequest<M>` = `z.infer<schema> & PluginRevisionRequest`(`rpc.ts:2236`)。
- `parseRequest`(`rpc.ts:2955-2989`)是"宿主被允许信任浏览器载荷的唯一一处":先查 `requestSchemas[method]`,查不到答 `unsupported`(`rpc.ts:2963-2966`);schema `safeParse` 之后,**另行手工保留 `pluginRevision`**(`rpc.ts:2971-2987`),校验"非负安全整数"后拼回结果——因为 zod 对未知键一律 strip,而这字段不进 schema。HANDOFF 明确点名:与动态 schema 注册合并时要测试该字段仍被保留(`notes/SYSTEM-PLUGINS-HANDOFF.md:76`)。

**运输层(`packages/iris-rpc-host/src/index.ts`)**

- 运行期容器已是字符串键:`private readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>`(`index.ts:188`)。
- `register`(`index.ts:256-267`)重复注册**抛错不遮蔽**("哪个插件答一个方法是组合层事实"),返回身份检查过的撤销函数(`index.ts:262-266`)。
- 无 handler 答 `unsupported`(`index.ts:488-495`);`parseRequest` 调用点 `index.ts:482`。泛型约束 `M extends RpcMethod` 只在类型上(`index.ts:91,256`)。

**应用层(`packages/iris-app-service`)**

- `Handlers` 是全量映射类型:`{ [M in RpcMethod]: (params: RpcRequest<M>) => Promise<RpcResponse<M>> }`(`service.ts:249-252`);`handlers()`(`service.ts:1696`)构造字面量(`service.ts:1875`起),`plugin.*` 六行在 `service.ts:1876-1881`——**Codex 的行**。
- 122 个注册逐一列在 `index.ts:1000-1150`(`plugin.*` 在 `index.ts:1002-1007`,**Codex 的行**);注释明说不用循环是为了保住逐方法泛型检查(`index.ts:997-999`)。

**fake(`packages/iris-client-fake`)**

- `call` 先跑与宿主相同的 `parseRequest`(`client.ts:335-343`)→ 未注册方法在这里就被拒。
- `#dispatch` 是逐 case switch(`client.ts:347`起),`plugin.*` 六个 case 在 `client.ts:349-365`(**Codex 的行**,委托 `FakeSystemPlugins`,`plugins.ts:42`起;目录只含内置两个,`plugins.ts:10-34`,其注释明确说"接受任意 id 会让插件中心以为有包而无实现")。
- 穷尽守卫:`default: { const unreachable: never = method; … }`(`client.ts:1860-1865`)。
- `IrisClient` 接口(浏览器唯一依赖面)在 `packages/iris-protocol/src/index.ts:154-190`;事件 `plugins.changed` 在 `packages/iris-protocol/src/events.ts:142`。

### 1.2 切面设计草案

**注册表放 `@iris/protocol`,不放 `@iris/plugin-api`。** 理由:宿主(rpc-host)与 fake 都要查同一张表,而两者已依赖 `@iris/protocol`;fake 依赖 plugin-api 会多一条边,且 `architecture.test.ts:109`(`apps/iris/tests/architecture.test.ts`)要求协议包零 `@iris` 依赖,plugin-api 只能单向依赖 protocol。协议新增一个模块(如 `rpc-registry.ts`):

```
registerRequestSchema(method: string, schema: ZodType<unknown>): () => void
```

- 内部 `Map<string, ZodType>`,返回撤销函数(与 `IrisRpcHost.register` 同形,配合 Cordis effect)。
- `parseRequest`(`rpc.ts:2963`)改为:`requestSchemas[method] ?? registry.get(method)`;**`rpc.ts:2971-2987` 的 pluginRevision 保留段一行不动**——它对方法不可知,运行期方法自动获得同一保留行为。补一条注册方法带 `pluginRevision` 的测试即兑现 HANDOFF 要求。
- `RpcMethod` 类型**不扩**:运行期方法的调用方类型是 `string & {}`。`IrisClient.call`(`protocol/src/index.ts:162`)与 `RpcHandler`(`rpc-host/index.ts:91`)的泛型签名放宽为 `M extends RpcMethod | (string & {})`,静态方法仍走全量检查,动态方法在注册处失去检查——这是刻意的:注册处的 schema 就是它的检查。

**`Handlers` 改 Partial。** `service.ts:249-252` 改为 `Partial<{ [M in RpcMethod]: … }>`,字面量(`service.ts:1875`)与注册块(`index.ts:1000-1150`)不变;"方法没实现"的行为已由 rpc-host 的 `unsupported`(`index.ts:488-495`)兜住,TH 剥离后 40 个方法答 `unsupported` 正是 FEASIBILITY §8.5 说的正确可卸载结果。

**插件侧接线。** `SystemPluginActivationScope`(`packages/iris-app-service/src/system-plugins.ts:55-64`)加一个便捷方法 `registerRpc(method, schema, handler)`,实现为 `scope.context.irisRpc.register(...) + 协议 registerRequestSchema(...)` 的组合,两者都在插件的 Cordis child fiber(`system-plugins.ts:559-604` 的 `#activate`)内注册,fiber dispose 时撤销——**这正是"不绕过 admission/lease/dispose"的形态**:注册的生命周期天然等于 activation 的生命周期,`lease`(`system-plugins.ts:350-383`)与 `assertCurrent`(`system-plugins.ts:336-348`)的语义不用改。类型定义从即将诞生的 `@iris/plugin-api` import(过渡期 `system-plugins.ts:44-64` 仍是类型现居地,HANDOFF:22 说 Claude 发布契约后通过 import 对接,不再造第二套注册表)。

**fake 开放分发。** `client.ts` 的 `#dispatch` 改两段:

1. **先查插件表**:`#pluginHandlers: Map<string, (params) => unknown>`,新增公开方法 `registerPluginMethod(method, handler)`(测试/演示夹具用它贡献实现)。运行期方法不在 `RpcMethod` 里,switch 看不见它们,不会被穷尽守卫拦截——`call`(`client.ts:335`)的入参类型放宽后直接透传。
2. **switch 与 `never` 守卫原样保留**(`client.ts:348-1865`):它保护的是**内置 122 个方法**"加了没答"这一静态性质,和开放分发不冲突;守卫注释(`client.ts:1861-1862`)照旧成立。
3. 语义决定项:fake 的插件方法是否随 `FakeSystemPlugins` 的启停失效。建议**是**——启停查 `FakeSystemPlugins`(可注入查询单),让 UI 测试能演练"停用后调用被拒",与宿主行为合同一致(HANDOFF:41"停用成功返回后旧工作不得再提交")。

### 1.3 风险(语义交界)

- **Codex 的行,动前协调**:`rpc.ts:2971-2987`(pluginRevision 保留)、`client.ts:349-365`(plugin.* 六 case)、`service.ts:1876-1881`、`index.ts:1002-1007`。HANDOFF:22 点名 `rpc.ts` 与 fake client 为合并交界;改 `parseRequest` 时不要重排函数整体,只动 schema 查找那一行。
- `RpcResponseMap`(`rpc.ts:2276`起)对内置方法是全量的,**不要**加索引签名 `[m: string]: unknown` 换取运行期可写——那会一次性杀掉全部穷尽检查。运行期方法的响应类型走 `unknown`/调用方断言,或 plugin-api 提供 `declare module` 合并的样板。
- `IrisRpcHost.register` 的重复注册抛错(`index.ts:256-259`)对插件是对的:插件 A 与插件 B 抢同名方法应当在 activate 时炸出来(failed fiber,PluginCenter 可见),而不是按加载顺序静默遮蔽。
- `architecture.test.ts:114`(协议零依赖)——注册表只能用 zod(协议已有依赖,`rpc.ts:16`),不能从 plugin-api 带类型实现进来。
- 协议测试现状:`packages/iris-protocol/tests/rpc.test.ts` 已覆盖 unknown method(:23 `chat.teleport` as never)——动态注册后该用例要分成"内置未知"与"未注册的动态名"两读。

### 1.4 工作量:**M**

协议注册表 + parseRequest 一行 + 类型放宽半天;fake 两段式分发 + 夹具注册面一天;scope 便捷方法 + 生命周期测试一天。测试(含 pluginRevision 保留回归)是主体。

---

## 2. 落点二:`/plugins/<id>/client.js` 资产面

### 2.1 现状

**dsh 侧的内核已经存在**(`node_modules/.pnpm/@deepseek-ai+dsh-host-front_*/…/dsh-host-frontend-static` 之外的 `@deepseek-ai/dsh-client-modules`,0.1.1-rc.2,node 半边 `lib/index.js`):

- `ClientModuleRegistry`(service 名 `clientModules`,`static inject = ["webServer", "loader"]`,`lib/index.js:258-259`)做四件事:对 loader 的每个 entry **增量扫描** `dsh.client` 声明(监听 `internal/plugin` 事件,`lib/index.js:277-287`);组合 `window.__DSH_BOOT__` 条目图(`graphRow`,URL 形如 `/plugins/<id>/client.js?rev=<sha1前12>`,`lib/index.js:155`);注册 `/plugins` 前缀路由(`lib/index.js:294-298`);把 boot 清单 + 解析阻塞预载推进 `webserver/index-inject`(`lib/index.js:300-302`,webserver 侧汇聚点在 `dsh-host-webserver/lib/index.js:292-299`)。
- `serveBundle`(`lib/index.js:461-496`):只答 `/plugins/<id>/client.js(.map)`,`content-type: text/javascript; charset=utf-8`、`cache-control: no-cache`(rev 查询参数是缓存戳),未知 id 404。**没有 CORS 头,没有 nosniff,没过 `irisRpc.guard`。**
- `dsh.client` 声明形状(`parseDshClient`,`lib/index.js:125-148`):`platform`(必填 string)+ `inject` / `external`(string 数组)+ `immediately`(boolean);bundle 路径由 `exports["./client"]` 解析(`lib/index.js:150-161`)。这正对应 `notes/PLAN.md:112-130`(§浏览器插件平面)的原始设计,且 dsh 已把它实现完。
- `ClientModuleRegistry`、`bootInjections`、`orderByModuleGraph`、`stripClientSuffix` 都在该包入口**具名导出**——Iris 可以复用图形组合与注入行,不必 fork。

**Iris 现状:没接线。**

- `apps/iris/cordis.yml` 没有 `client-modules` 行;前端行 `frontend`(`cordis.yml:180-186`,`distIndex: IRIS_WEB_DIST`,`IRIS_WEB_DIST === undefined` 时整行 disabled)只挂 `dsh-host-frontend-static` 的 **fallback seat**(`dsh-host-frontend-static/lib/index.js:77-91`):按路径直读 dist 根、越界 403、未命中 404、无任何 header 钩子(gap 已记录于 `notes/packages/iris-rpc-host/DEVIATIONS.md` §1)。
- `apps/iris-web/src/main.tsx:8-11`:"宿主平面存在之前,`__DSH_BOOT__` 与 `__ModuleLoader__` 都在页内自供";`index.html:129-150` 装加载器门面。页面里唯一的 Cordis 插件是 `iris-client-shell`(`main.tsx:27`)。
- **Iris 自己挂"前缀路由压过 fallback"的现成先例**:沙盒资产路由(`packages/iris-app-service/src/index.ts:1214-1223`,条件同样是 `webDistIndex` 非空)带着 CORS 共享头(`sandbox-assets.ts:41-47`:`access-control-allow-origin: *` + `timing-allow-origin: *` + `vary`)与按 manifest 决定的 immutable 缓存(`sandbox-assets.ts:54,72-86`:`immutableNames` 读 `manifest.json`,读不到就**一切 no-cache**——失败方向正确)。全部经 `ctx.irisRpc.guard` 包裹(`index.ts:1221`)。
- **CSP 两侧都不是障碍**:壳页的 CSP 刻意只有 `object-src 'none'; base-uri 'none'; form-action 'none'`(`shell-csp.ts:104-110`,经 `tapIndex` 盖进索引,`index.ts:1245`),没有 script-src,壳里加载同源 `/plugins/*.js` 不受限;帧 CSP 的 `script-src`(`srcdoc.ts:184`)本来就含 `${selfOrigin}`(帧策略在 `srcdoc.ts:104-190`),同源插件脚本进帧也不需要动 CSP——只有**远程**来源才要动 `REMOTE_ALLOWLIST`(`policy.ts:59`)。
- 沙盒资产的清单机制(可对照的"四键"现状):`manifest.json` 是唯一固定路径(`apps/iris-web/src/sandbox/asset-manifest.ts:26`),固定四键 bootstrap/members/preset/message-preset(`asset-manifest.ts:86`,类型 `asset-manifest.ts:29-53`),由 `tools/hash-sandbox-assets.mjs` 生成(产物表 `:46`,写了"被列进 manifest 才有 immutable"的依赖说明);服务目录的剪除 `tools/prune-sandbox-assets.mjs` 只删 `<manifest键>-<hash>` 名。

### 2.2 切面设计草案

**路由落点:Iris 自己的 guarded 路由,而不是 dsh 行。** 推荐:在 `packages/iris-app-service` 新增一个 plugin-asset 服务(与 `sandbox-assets.ts` 同形),挂 `kind: 'prefix', path: '/plugins'`,handler 过 `irisRpc.guard`;图形组合与 index 注入复用 dsh 导出的 `bootInjections` / `orderByModuleGraph`。理由:

- dsh 的 `ClientModuleRegistry` 构造函数自注册路由且**不过 guard**——没有 nosniff 与 Host 允许表,Iris 侧"每条路由都过 guard"的成文规则(`rpc-host/index.ts:348-354`,`index.ts:1152-1169`)会被它破掉;而 fallback seat 的同类缺口已被记录为欠账,不该再添一笔。
- 它扫的是 **cordis loader 的 entry**,即进程内组合行;第三方插件(用户 profile 目录里的包)不是 loader 行,Host 平面要的是"对已安装插件目录做 `dsh.client` 扫描"——扫描对象不同,Iris 自己写这层(~80 行:读包、`parseDshClient` 同形校验、`clientPath`、`shortHash` 即可从 dsh 复制/导入)。

**manifest 聚合。** 壳取资产走 `SANDBOX_MANIFEST_PATH`(`useCardScripts.tsx:60-64`)。插件资产**不要**并进 `manifest.json` 四键——那会动 `asset-manifest.ts:86` 的固定键校验、`hash-sandbox-assets.mjs:46` 的产物表和 prune 的前缀推导,把构建期闸搅进运行期数据。开第二张聚合清单:`/plugins/manifest.json`,由 host 在插件 install/enable/disable/uninstall 提交快照时(`SystemPluginRuntime` 的 `#commit`→`#notify`,`system-plugins.ts:668-693,743-752`)从各插件目录的资产声明拼出;键为插件 id,值为 `{ client: string, assets: Record<string, string> }`。类型放 `@iris/plugin-web-api`。

**CORS 与缓存头(真正的缺口)。** 帧是不透明 origin,加载同源插件脚本需要 `crossorigin` 属性(`srcdoc.ts:706,756,795` 的既有标签都带)+ 响应侧 `access-control-allow-origin`(`sandbox-assets.ts:9-27` 的整段论证原样适用)。所以 Iris 的 `/plugins` 路由必须带 `SHARED_HEADERS`(`sandbox-assets.ts:41-47`);缓存策略沿用"名字在 manifest 里才 immutable"(`sandbox-assets.ts:72-86` 的失败方向)——插件 bundle 的 rev 查询参数形态与 dsh 一致,可以同拿 immutable。

**帧内加载。** 插件帧侧脚本 `<script src="/plugins/<id>/client.js?rev=…" crossorigin="anonymous" data-iris-plugin="<id>">` 并进 `buildSrcdoc` 的标签序(`srcdoc.ts:706` 成员表标签之后、`:756` 引导标签之前的位置需按"插件成员可被卡面引用"的顺序决定,见落点三)。同源自加载,CSP 免改。

### 2.3 风险(语义交界)

- **guard 包裹决定的一切**:若先挂了 dsh 的 `client-modules` 行,它的 `/plugins` 路由与 Iris 的同前缀路由谁先注册谁压住(fallback seat 之前的匹配顺序)——二选一,不要同时挂。
- `webserver/index-inject` 在本仓**零使用**(FEASIBILITY §2 前端行),第一批启用者会遇到 webserver 的渲染顺序问题:结构化注入行先于 `tapIndex`(`dsh-host-webserver/lib/index.js:5-12`),壳的 CSP 盖章(`index.ts:1245`)在行渲染之后跑,交互要在 `shell-index.test.ts` / `shell-csp-live.test.ts` 下验证。
- `end-to-end.test.ts:48` 显式 `delete process.env.IRIS_WEB_DIST`——宿主平面启用后索引内容变化会影响该测试组。
- 前端 dist 的清单是**构建期**写死的四键 + 一个不可哈希的哨兵(`hash-sandbox-assets.mjs:99-118` 的 `fontawesome.min.css`,卡代码按文件名读它)——运行期聚合清单与它并列,不合并。
- 插件 id 直接进 URL 路径段:必须沿用宿主对 id 的现有约束(`system-plugins.ts:158-159`:1–200 字符)并拒绝路径分隔符;`serveStatic` 的越界 403 逻辑(`dsh-host-frontend-static/lib/index.js:47-52`)是对照实现。

### 2.4 工作量:**M**

Iris 侧路由 + manifest 聚合 + CORS 头 2–3 天;dsh 注入行接线 + main.tsx 撤掉页内 boot 图 1 天;外部插件目录扫描与 `dsh.client` 校验 1–2 天。第三方分发本身的信任模型不在本批(FEASIBILITY §8.1 未裁决)。

---

## 3. 落点三:dsh.client 清单扫描 + 成员表合并

### 3.1 现状

**清单扫描的宿主半边** = 落点二的 dsh 内核(Iris 未接线)+ 插件目录扫描(要新建,`dsh.client` 声明形状见 2.1)。壳半边:`main.tsx` 的 `ClientModuleLoaderTarget` 接线(`main.tsx:23-26`)已就位,页内 boot 图(`main.tsx:5-10`)在宿主平面启用后撤掉。

**能力快照(Codex 已建,必须沿用)**

- 帧内不可变快照:`SandboxPluginRuntime = { revision, tavernHelper, mvu }`(`apps/iris-web/src/sandbox/system-plugin-runtime.ts:20`),缺省值 `:25-30`,归约函数 `sandboxPluginRuntime()`(`system-plugin-runtime.ts:37-54`,只认 `installed && enabled && status === 'enabled'` 的行,MVU 隐含依赖 TH),meta 写入 srcdoc(`srcdoc.ts:591`,`SYSTEM_PLUGIN_RUNTIME_META` 在 `system-plugin-runtime.ts:22`),帧内读取(`frame-entry.ts:232-233`)。
- revision 栅栏:帧发出的每个请求由 `fenceFrameParams` 附加 `pluginRevision`(`system-plugin-runtime.ts:83-90`;使用点 `runner.ts:670-690` 的 settings/call/slash 三臂)。
- 变更→销毁重建:`plugins.changed` 事件 → `adoptSystemPluginSnapshot`(`store.ts:3622-3625`;时钟/会话排除旧响应 `store.ts:1399-1435`)→ `useCardScripts.tsx:79-83` 派生 `pluginRevision/tavernHelperEnabled/mvuEnabled`,作为**重建 effect 的依赖**(`useCardScripts.tsx:792-800`)——任何一项变化,整个 run 拆掉重建;接口帧同样校验 ready 的 revision(`MessageInterfaces.tsx:120-122,275,285`)。
- 帧内按布尔装配 TH/MVU 面:`frame.ts:391-392` 的 `hasTavernHelper/hasMvu`,TH 表 `frame.ts:2228`起,`publishName`(`frame.ts:2129`),Mvu 垫片 `frame.ts:3003-3085`。

**成员表(构建期产物)**

- 表本体:构建期一次性赋值 `host[MEMBERS_GLOBAL] = { … 24 个成员 … }`,最后一个语句设 `host[MEMBERS_MARKER] = true`(`members-entry.ts:61-98`);契约名 `MEMBERS_GLOBAL`/`MEMBERS_MARKER` 独立成模块防漂移(`members-contract.ts:22,34`),`MemberTable` 接口用 `typeof import(...)` 全部擦除(`members-contract.ts:43-79`)。
- 消费端:帧入口读全局表 + 验 marker(`frame-entry.ts:1446-1452`);**表缺席 = 拒跑全部卡代码**——抛 bootstrap 错误而非发卡面错误,理由是归因(`frame-entry.ts:1794-1815`)。FEASIBILITY §2 与 HANDOFF:22 都点名这条语义要随合并协议一起重定。
- 面清单:`UPSTREAM_CONTEXT_MEMBERS`(145 键,`upstream-surface.ts:93`)、`MEMBER_KINDS`(`identity.ts:69`)。**普查口径依赖声明文本定位**:`scripts/th-member-census.mjs:11-25` 自述按文本找 `UPSTREAM_MEMBERS`/`MEMBER_KINDS` 常量,重构会静默废掉它(FEASIBILITY §8.3)。

### 3.2 切面设计草案

**原则:全部走 Codex 的 revision→销毁重建通道,不另起第二套。** HANDOFF:78 已写明"前端资产变化与 capability revision 需要一起决定 frame 是否重建"——而资产变化只发生在 install/enable/disable/uninstall,每一次都 `#commit` 推 revision 并广播,所以**资产变化自动获得 revision 变化**,不需要新通道。

**第一步:快照泛化。** `SandboxPluginRuntime`(`system-plugin-runtime.ts:20`)从双布尔扩为:

```
{ revision: number, tavernHelper: boolean, mvu: boolean,
  plugins: Record<string, { rev: string, client: string }> }
```

`plugins` 只含 enabled 且带 `dsh.client` 的插件。编码/解码(`system-plugin-runtime.ts:56-90`)按同一形状校验风格补分支;**meta 体积有闸**:srcdoc 包装层预算 4 KiB(`frame-budget.ts:220`,CSP 是包装层最长的单项,`frame-budget.ts:204-208`),meta 里放 id+rev+URL,上百字节级,可控但要打印实测。布尔门(TH/MVU 装配,`frame.ts:391-392`)**不动**——它们语义是"兼容面在不在",与"插件是否存在"分开。

**第二步:成员表合并协议。** 核心表脚本(`members-entry.ts`)保持"先赋值、末尾 marker"不变;在其导出面加一个注册函数:

```
registerPluginMembers(pluginId: string, members: Record<string, unknown>): void
```

- 帧内顺序:成员表 → bootstrap → 插件 `client.js`(`data-iris-plugin` 标签)→ 卡代码。插件脚本在**自己的**最后一个语句设 `__iris_plugin_ready__<id>`(与 `MEMBERS_MARKER` 同型,契约名进 `members-contract.ts`)。
- **拒跑语义重定**(FEASIBILITY §2 点名的"连这条一起设计"):core 表缺席 → 维持全拒(`frame-entry.ts:1794-1815` 原样);**某个插件**的 ready 标记缺席 → 只拒该插件的成员,报错点名插件 id 与"它的脚本被拦/没跑完",其余卡代码照跑——这正是 HANDOFF:70"避免因 script.context 被拒绝使普通 HTML 也消失"的同族语义在成员面的对应物。
- **冲突策略**:同名成员拒绝注册、点名插件(镜像 `IrisRpcHost.register` 的重复抛错语义,`rpc-host/index.ts:249-252`——"谁是这个名字的答案是组合层事实");TH/MVU 的名字在核心表里,插件永远不能遮蔽它们。
- 装配消费:插件成员通过 `installSandbox` 的 members 通道进入帧面(`frame-entry.ts:1816-1827`),归入 `MemberTable` 的并列命名空间(如 `plugin: Record<string, Record<string, unknown>>`),`identity.ts` 的 `MEMBER_KINDS` 与 `upstream-surface.ts` 不动——普查口径不受影响。

**第三步:宿主目录扫描接线**(即落点二的服务):扫 profile 插件目录的 `package.json`,`dsh.client` 形状校验,`SystemPluginDefinition`(`system-plugins.ts:44-52`)在 install 时固化清单快照,activate 时把 `plugins[id]` 条目(含资产 rev)推入快照。`SystemPluginDefinition` 是过渡类型居所(`system-plugins.ts:44-64`),`@iris/plugin-api` 诞生后 import 对接,**不得**再造第二套定义类型(HANDOFF:22)。

### 3.3 风险(语义交界)

- **Codex 的行,动前协调**:`frame.ts` 的 TH/MVU 具名区域(`frame.ts:391-392,2228-3085` 约 500 行)与 `useCardScripts.tsx`/`MessageInterfaces.tsx` 的重建 effect——HANDOFF:22 点名 frame 启动/成员装配为合并交界。合并机制必须是**可加性**的:不改 TH/MVU 的装配路径,只在它们旁边并联插件成员。
- `members-contract.ts`/`members-entry.ts`/`frame-entry.ts:1446-1815` 是两侧共用的骨架;marker 语义("最后语句"即"全部完成",`members-entry.ts:88-98` 的论证)必须被插件 ready 标记**继承**而不是绕开。
- `sandbox-plugin-runtime` 的解码校验(`system-plugin-runtime.ts:66-90`)是帧启动的硬门,新字段校验失败会拒跑所有卡——校验信息要能区分"旧宿主/新壳"与"数据坏了"。
- `dsh.client` 的 `immediately`(解析阻塞预载,`lib/index.js:198` 的 `PARSER_PRELOAD_IDS` 只装 dsh 自家两个包)只属于 dsh 自家;**第三方插件永远不该进解析阻塞预载**,Iris 的扫描层要显式忽略该字段。
- 普查脚本(`scripts/th-member-census.mjs:11-25` 等)按声明文本定位常量——本落点**不搬** `MEMBER_KINDS`/`UPSTREAM_CONTEXT_MEMBERS` 的声明位置。

### 3.4 工作量:**L**

快照泛化 + meta 闸 1 天;ready 标记协议 + 拒跑重定 + 冲突策略 2–3 天;宿主扫描接线与 definition 固化 2 天;生命周期测试(启停循环下旧 ready/旧成员不复活——对齐 HANDOFF:67-71 的检查单)2–3 天。

---

## 4. 落点四:可变资产清单 —— 哪些构建期闸要改成运行期闸

### 4.1 现状闸清单

| 闸 | 位置 | 保护对象 |
| --- | --- | --- |
| bootstrap 体积/形状 | `tools/check-bootstrap.mjs`(跑在 `build:sandbox` 链内,`apps/iris-web/package.json` scripts;经 `parseSandboxManifest` 读 manifest,`check-bootstrap.mjs:59-67`;常量 `FRAME_OVERHEAD_BYTES=4KiB`/`FRAME_BUDGET_BYTES=2MiB`/`FRAME_COUNT_LIMIT=20` 在 `frame-budget.ts:220,230,362`) | **自建 srcdoc 包装层**的字节与三层时序合同(构建/帧内/真浏览器,`check-bootstrap.mjs:14-27` 自述) |
| preset 播种 | `tools/check-preset.mjs`(同一构建链) | 构建产物真的定义了它声称的 global |
| 产物剪除 | `tools/hash-sandbox-assets.mjs:44-91`(生成 manifest)、`tools/prune-sandbox-assets.mjs`(只删 `<manifest键>-<hash>`) | 被替代的名字停止应答 |
| 协议零依赖 | `apps/iris/tests/architecture.test.ts:109-114` | `@iris/protocol` 不拖任何 `@iris` 包 |
| 浏览器允许表 | `architecture.test.ts:117-148`(allowlist `:144`:protocol、client-fake、rpc-client、compat-tavernhelper-core、text) | 浏览器可达面 |
| 无向上依赖 / 指定边 | `architecture.test.ts:190-204,221-256,259-267` | 包图形状 |
| 组合行钉子 | `apps/iris/tests/composition.test.ts:73`(pruneVariables 行) | cordis.yml 与 schema 默认值的关系 |
| 宿主启动条件 | `index.ts:1214-1223,1245`(sandbox 路由与 CSP 盖章仅在 `webDistIndex` 非空时注册) | 无构建时不产生全 404 路由 |
| serve 时缓存判定 | `sandbox-assets.ts:72-86`(`immutableNames`:manifest 缺失/坏 → 全部 no-cache) | **已经是运行期闸**,失败方向正确 |

### 4.2 切面设计草案:哪些改、哪些不改

**保留为构建期闸(不改)**

- `check-bootstrap.mjs` / `check-preset.mjs` 全套:它们度量的是**我们自己构建的** srcdoc 包装层与 preset 产物(三层合同由 `check-bootstrap.mjs:14-41` 自述);插件资产是按 URL 取的(`frame-budget.ts:204-208` 明说取回的东西不在这张账上),不进此闸。TH 成员迁出后这些闸保护的金额只会变小,机制不变。
- prune 脚本:剪除对象是构建产物目录;插件 bundle 在插件自己的目录里,被替代版本的回收属于**安装路径**(uninstall 删目录)——那是契约包代理的分发职责,不并入 prune。
- `composition.test.ts:73`、architecture 的图形状断言。

**必须动的既有闸**

- **浏览器允许表**(`architecture.test.ts:144`):`@iris/plugin-web-api`(若壳/帧 import `@iris/plugin-api` 则连它一起)要加进 allowlist,并按该文件成文风格写理由(参照 `:130-135` 给 th-core/text 的写法)。这是落点三的前置。
- `asset-manifest.ts` 的四键校验**不动**(它是构建产物的闸),运行期聚合清单走 `/plugins/manifest.json`(落点二)——两个清单、两个闸,不互相渗透。

**新增的运行期闸**

1. **插件清单在 install/activate 时校验**(运行期版的 check-bootstrap):`SystemPluginRuntime` 构造时已对 definition 抛 `TypeError`(`system-plugins.ts:157-174`:id 长度、重复、apiVersion、自依赖);扩展同一处校验 `dsh.client` 声明与 `exports["./client"]` 产物存在性,坏清单 = install 失败、PluginCenter 可见,而不是 serve 时 404。
2. **注册可逆性即闸**:插件 RPC 方法/schema/成员的登记全部走 Cordis fiber 撤销(落点一/三的设计),"禁用后旧方法不可达"不需要独立守卫,由 `#disposeActivation`(`system-plugins.ts:606-612`)保证;测试对齐 HANDOFF:38"reload 循环不能累积监听器、注入或任务"。
3. **serve 时缓存判定**(落点二):插件资产路由沿用 `immutableNames` 的失败方向——清单读不到就 no-cache(`sandbox-assets.ts:72-86` 的性质,不是新代码,是把新路由挂上同一纪律)。
4. **壳侧资产失败可见**:壳取 `/plugins/manifest.json` 失败/坏形状的报错照 `SANDBOX_MANIFEST_PATH` 取回的样式(`useCardScripts.tsx:60-64` 抛带原因的错误),不许静默空表——`asset-manifest.ts:16-21` 的"dev server 用 200 答 index 页"教训直接适用。
5. **每帧重量记账(报告性闸,非拒止闸)**:插件脚本入帧后,其字节数进入 `describeTransferCost` 一类的每帧开销报告(`frame-budget.ts:197-202` 预留的口径:表内成员与 policy 行同价是既成事实,插件脚本同理);不动 `FRAME_COUNT_LIMIT`。

### 4.3 风险

- 别把运行期数据塞进构建期清单:四键 manifest 的每个键都被 `check-bootstrap`/`check-preset`/prune 三方按前缀消费,加动态键等于让三个构建工具消费运行期输入——这是本稿反对合并 `/plugins/manifest.json` 与 `manifest.json` 的全部理由。
- `end-to-end.test.ts:48`、`sandbox-cors.test.ts`(断言 `serveSandboxAsset` 的头,`sandbox-cors.test.ts:9-33`)是宿主侧路由行为的现成测试锚;新 `/plugins` 路由的测试要挂同一层(app-service 路由测试 + 两半静态配对检查)。
- 构建链顺序依赖:`build` 先 `build:sandbox` 再 prune(`apps/iris-web/package.json` scripts)——宿主平面启用后,插件资产的存在不改变该链,但 CI 要防"只跑了 build 没跑 build:sandbox"的旧坑(prune 脚本头注释记录过两轮测量事故)。

### 4.4 工作量:**S–M**(散在落点一/二/三的实施里;独立工作量主要是插件清单校验与测试锚)

---

## 5. 实施顺序建议

```
        ┌── 落点1(协议注册表 + Partial Handlers + fake 开放分发)──┐
并行 ──┤                                                        ├── 落点3(快照泛化 + 成员合并)── 落点4(闸收口)
        └── 落点2(/plugins 路由 + manifest 聚合 + CORS/guard)────┘
```

- **可并行**:落点 1 与落点 2 无共同文件。落点 1 全在 `packages/iris-protocol`、`iris-rpc-host`、`iris-app-service`(service/index/system-plugins)、`iris-client-fake`;落点 2 全在 `packages/iris-app-service`(新 asset 路由)、`apps/iris/cordis.yml`、`apps/iris-web`(壳接线)。
- **互斥(须串行/协调)**:
  - `rpc.ts`、`client.ts`、`service.ts`、`index.ts` 的 Codex 行(§1.3 所列)——落点 1 施工时与 Codex 约定一次合并窗口;
  - 落点 3 **依赖**落点 2(插件脚本得先有地方 serve)与落点 1(插件成员若要回调宿主 RPC,走运行期注册面);其快照泛化会触碰 `frame-entry.ts`/`members-*`,与 Codex 的 frame 装配区相邻——放最后施工、最先对齐;
  - 落点 4 的"新增运行期闸"分散在 1/2/3 的实现里,只有**浏览器允许表扩充**(`architecture.test.ts:144`)是独立前置——它属于落点 2/3 的第一个提交。
- **每步的验收锚**:落点 1 → `packages/iris-protocol/tests/rpc.test.ts` 补动态注册 + pluginRevision 保留用例;落点 2 → `sandbox-cors.test.ts` 同层的路由头断言 + `shell-index.test.ts`;落点 3 → HANDOFF:67-71 的浏览器生命周期检查单逐条成测试;落点 4 → HANDOFF:82-89 的测试命令全绿后跑整树 `npm test` / `no-corpus`。
- 与契约包代理的接口对齐点(提前说定,免得返工):`@iris/plugin-api` 应 re-export 协议的注册表类型(落点 1)与 `SystemPluginDefinition` 的最终形态(现居 `system-plugins.ts:44-64`);`@iris/plugin-web-api` 应携带 `/plugins/manifest.json` 的形状(落点 2)、`SandboxPluginRuntime` 泛化后的形状(落点 3)与帧内 `registerPluginMembers` 契约名(落点 3)。
