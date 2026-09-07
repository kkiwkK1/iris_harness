# 阶段 0 技术验证结果

结论：**五道关全部通过，方案不需要回退**。可以按计划走「复用 DSH 通用底座 + 自写领域插件」的路线。

跑法：

```bash
cd spike/host && node ./src/session-smoke.ts   # 会话内核 / 自定义事件 / swipe
cd spike/host && node ./bin.ts                 # 启动 / 提示词装配 / 流式 / 采样
cd spike/host && pnpm exec tsc --noEmit        # 类型检查
cd spike/web  && npx vite build                # 浏览器外壳构建
```

## 1. 依赖可在 DSH 之外安装（通过）

`@deepseek-ai/cordis@4.0.2` + `dsh-*@0.1.1-rc.2` 一组锁定版本在独立工程里干净安装、导入、通过 `tsc --noEmit` 严格模式（含 `exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`）。

踩到的坑，记下来免得重复：

- `dsh-*` 的 npm `latest` tag 是占位版本 `0.0.1-rc.1`，真实发布在 `next`。**必须锁精确版本。**
- `@deepseek-ai/dsh-brand` 是纯类型包，没有运行时导出。品牌 id 的构造工厂在**拥有它的包**里：`SessionId` 来自 `dsh-session`，`CallId`/`MessageId` 来自 `dsh-llm`。
- Windows 上 pnpm 解压 esbuild 反复 `EPERM`（文件被占用）。宿主 spike 干脆去掉 tsx——**Node 24 原生类型剥离**足够跑 `.ts`；浏览器 spike 需要 esbuild，改用 npm 安装并 `npm install-scripts approve esbuild`。
- 原生类型剥离不支持 TS 参数属性（`constructor(private readonly x: T)`），要写成显式字段。

## 2. `boot()` 能启动非编码-agent 的组合（通过）

`dsh-app-boot` 的 `boot(binName, configPath)` 配一份自写 `cordis.yml` 就能起进程。`!!js` 表达式（`!!js process.env.IRIS_SPIKE_BASE_URL`）按预期惰性求值。

## 3. 提示词装配符合 SillyTavern 的需要（通过）

`ctx.systemPrompt` 的有序 section 注册表按 `order` 升序拼接，`variable()` 提供的 `{{char}}`/`{{user}}` 严格插值。**释放 disposer 后**：我们注册的 section 干净消失，插件自有的 `deployment:persona` 不受影响，且未注册变量时渲染**抛错而非静默留空**——比 ST 的行为安全。

## 4. 会话内核可独立使用，swipe 有天然载体（通过）

三件事都成立：

- `Session.create()` 在**没有 Cordis 上下文、没有 `dsh-session-persistence`、没有 agent** 的情况下工作。`SessionStore` 没有 `static inject`，`dsh-session` 也不依赖持久化包。
- 仓库外插件可以声明合并进 `SessionEventMap` 并 append 自己的事件类型。（拒绝未知类型的 `assertEventsSupported` 在 `dsh-session-persistence` 里，不在内核里——而持久化后端我们本来就要自写以兼容 ST 的 JSONL。）
- `surfaceOp: { op: 'replace', start, end }` 能让新的 `assistant/message` 遮蔽旧的：surface 只呈现当前候选，**全部候选都留在日志里**。这就是 swipes，不需要靠分叉模拟。

## 5. 采样参数扩展可行（通过）

给 `GenerateOptions` 声明合并加上 `sampling?: IrisSampling`（top_p/top_k/min_p/repetition_penalty/seed…），字段原样穿透到我们自己的适配器并出现在 HTTP 请求体里。**前提是适配器也是我们写的**——`dsh-llm` 自带的 `callConfigEquals`/`prepareCall`/`request/header` 仍按六字段形状工作，所以计划里的 `iris-llm-sampling` 薄封装层仍然需要。

## 6. 浏览器外壳可用，且不需要编码 agent 的客户端栈（通过）

`dsh-client-web@0.1.1-rc.2` 的依赖只有 `client-modules`、`client-ui-slots`、`client-ui-primitives`——**`dsh-client-runtime` 不在依赖树里**。

实测：浏览器里第二个 Cordis Loader 起来，加载我们自己的插件，React 渲染成功，`SlotCore` 可独立实例化。

启动协议（实测确认，文档没写清楚的部分）：

1. **外壳唯一的服务依赖是 `uiRenderer`**——`ctx.inject(['uiRenderer'], scope => scope.effect(() => scope.uiRenderer.mount(container)))`。谁提供它，谁就拥有整个应用界面。这就是我们替换领域 UI 的接缝。
2. `@deepseek-ai/dsh-client-modules/client` **不是普通模块**：它的模块体本身就是一次 bundle 注册（`window.__ModuleLoader__.load({id, factory})`）。所以注册门面必须在它执行**之前**装好——真实部署靠宿主往首页注入内联脚本，spike 里放在 `index.html` 的内联 `<script>` 中，`main.tsx` 用**动态** `import()` 让它在门面之后执行。
3. Vite 侧必须照抄参考应用的三件事：`node:module` 别名到一个导出 `createRequire` 的 stub、`react`/`react-dom` dedupe、以及三个 `define`（`process.versions.node = "0.0.0"`、`process.execArgv = []`、`process.env.CORDIS_SHARED = undefined`）——否则 vendored 的 Cordis Loader 在浏览器里跑不起来。

未验证、留给阶段 3 的部分：宿主侧的图组合与 `/plugins` 分发（`dsh-client-modules` 的 node 半边 + `dsh-host-frontend-static`）。spike 用外壳自带的 `loadBundle` 传输接缝绕过了它——那也正是 DSH 自己 jsdom 测试用的钩子。
