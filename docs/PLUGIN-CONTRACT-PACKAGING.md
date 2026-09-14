# 契约包的发布形（Plugin contract packaging）

本文讲的是一件很窄的事：把三个契约包 `@iris/plugin-api`、`@iris/plugin-web-api`、
`@iris/protocol` 变成**仓库外面**的一个插件仓库能安装、能类型解析、能 `import()`
的 npm 包。它不讲插件怎么被宿主接纳、不讲插件市场、也不讲安装 UI——那些是后面的
步骤，本文最后一节明确写了哪些**刻意没做**。

契约本身的定义在 [SYSTEM-PLUGINS.md](./SYSTEM-PLUGINS.md)「The contract packages」，
交付清单在 [PLUGIN-AUTHORING-RUNBOOK.md](./PLUGIN-AUTHORING-RUNBOOK.md) §8。

## 1. 工作区不变，发布是另一件事

这是整套设计的前提，值得先写清楚。

本仓库**没有构建步骤**：Node 24 直接跑 TypeScript 源码（type stripping），每个包的
`exports` 指向 `./src/index.ts`，源码里的相对 import 带着真实的 `.ts` 后缀，全部三个
包都是 `"private": true` / `"version": "0.0.0"`。这不是遗漏，是让开发回路里没有
「改完要先编译」这一格的代价换来的收益。

所以发布**不是**把 `private` 改成 `false`。那条路要求工作区同时相信两件互斥的事
（`exports` 既指向 `src/index.ts` 又指向 `lib/index.js`），而且会产生一个「半发布」
的中间态：清单说自己是 npm 包，磁盘上却没有 `lib/`。

这里走的是另一条：发布是一次**显式的、独立的动作**，只读工作区，只往
`dist-pack/`（已 gitignore）写。没有任何工作区清单被修改，因此也就没有半发布态。
脚本是 [`scripts/pack-contracts.mjs`](../scripts/pack-contracts.mjs)。

## 2. 命令

```
npm run pack:contracts -- --version 1.0.0-alpha.0
```

- `--version` **必填**，且必须是合法 semver。没有默认值：这个数字是一次关于兼容
  承诺的决定（见 §5），一个会替你猜的脚本每次重跑都在悄悄替你做这个决定。
- `--out <dir>` 可选，默认 `dist-pack`。消费者测试用它把一整轮输出引到临时目录。
- 幂等：每次运行先删掉自己上一轮的输出，再重建。上一轮残留的 `lib/` 里可能有一个
  源文件已被删除的产物，覆盖式写入会把它一起发出去。

## 3. 产物

```
dist-pack/
├── iris-plugin-api-1.0.0-alpha.0.tgz
├── iris-plugin-web-api-1.0.0-alpha.0.tgz
├── iris-protocol-1.0.0-alpha.0.tgz
├── plugin-api/          ← staging 树，npm pack 的输入
│   ├── LICENSE
│   ├── package.json     ← 生成的，不是拷贝改的
│   └── lib/             ← tsc 的输出：.js / .d.ts / .js.map / .d.ts.map
├── plugin-web-api/
└── protocol/
```

每个包三步：

1. `tsc -p packages/<pkg>/tsconfig.pack.json`，输出到 `<out>/<stage>/lib`。
   pack 配置 `extends` 仓库根的 `tsconfig.base.json`，所以 `target`、`lib`、严格性
   开关都是工作区那一份，不是一份会各自漂移的拷贝。只有 emit 相关的项在 pack
   配置里：`declaration`、`declarationMap`、`sourceMap`、`inlineSources`、
   `module`/`moduleResolution` 为 `nodenext`，以及 **`rewriteRelativeImportExtensions`**。
   最后这项是承重的：源码写的是 `./views.ts`，没有它这个 specifier 会原样留在
   `lib/index.js` 里，而那里没有任何 `.ts` 文件。
2. 生成 `package.json`（见 §4）。**生成**而不是拷贝后打补丁：发布形与工作区形同时
   在五处不同（`private` 消失、真版本号、`files`、面向 `lib` 的 `exports`、
   `workspace:*` 解析），少改一处就会得到一个看起来对、其实不能用的 tarball。
3. `npm pack`。

## 4. 三个包的发布形 package.json

以 `--version 1.0.0-alpha.0` 为例，逐字如下。

`@iris/plugin-api`：

```json
{
  "name": "@iris/plugin-api",
  "version": "1.0.0-alpha.0",
  "description": "The system-plugin contract: what a plugin is, how the host activates it, and the lease a unit of its work holds. No @iris dependencies; Cordis types only, by contract.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "files": ["lib"],
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "4.0.2" }
}
```

`@iris/plugin-web-api`：

```json
{
  "name": "@iris/plugin-web-api",
  "version": "1.0.0-alpha.0",
  "description": "The browser-side system-plugin face: the capability snapshot a sandbox frame is born with, and the codec the shell and the bootstrap must read identically. Type-only dependency on the contract; pulls nothing in behind it.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "files": ["lib"],
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }
  },
  "dependencies": { "@iris/protocol": "1.0.0-alpha.0" }
}
```

`@iris/protocol`：

```json
{
  "name": "@iris/protocol",
  "version": "1.0.0-alpha.0",
  "description": "The host/browser contract. Frozen surface both halves are written against.",
  "license": "AGPL-3.0-only",
  "type": "module",
  "files": ["lib"],
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }
  },
  "dependencies": { "zod": "^4.4.3" }
}
```

四处改写，每一处的理由：

- **`private` 与 `0.0.0` 不被携带，是靠「不写」而不是靠「删掉」。** 发布形是另一件
  产物，由字段的**缺席**构成，`private: true` 就永远不可能因为漏删而活下来。
- **`exports` 是替换，不是调整。** 工作区那份把 `.` 映到 `./src/index.ts`，另有一条
  `"./src/*": "./src/*"` 子路径。两条都不发布。`./src/*` 在一个已发布的包里是一句
  承诺——「每个内部文件都是公开入口」——而正是这条承诺让本仓库自己的
  `apps/iris/tests/architecture.test.ts` 不得不加宽它的 import 扫描：浏览器侧曾经可以
  多写一段路径就绕过白名单拿到任意工作区包。发布形不带它，插件作者能依赖的就只有
  `index`，而 `index` 是能被版本号约束的那一层。
- **`workspace:*` 变成本次发布的版本号。** pnpm 在工作区内解析这个协议，工作区外它
  只是一个 npm 取不到的 specifier。三个包总是一起发布，所以这条边是**精确固定**而
  不是 `^` 范围：`^` 会允许插件仓库装上一个比它所针对的 `plugin-api` 更新的
  `protocol`。
- **`@deepseek-ai/cordis` 变成 `peerDependencies`。** 工作区里它是普通依赖，因为那里
  只有一份。已发布的包里必须是 peer：插件若装上自己的第二份 Cordis，就得到第二个
  模块实例；而本项目所有 Cordis 声明合并都指向 `declare module '@deepseek-ai/cordis'`
  （`notes/PLAN.md` 里选 `@deepseek-ai/cordis` 而非上游 `cordis` 的理由，正是所有
  `dsh-*` 包都把它当 peer 并合并进那一个模块名）。两个实例意味着两种模块身份：宿主的
  `Context` 与插件的 `Context` 是无关的类型，插件 `provide` 出去的能力进了宿主永远
  不会读的注册表，而且**没有任何报错**——插件只是什么也没接上。

## 5. 版本策略

契约用 `apiVersion` 表达兼容承诺，npm 用 major 表达同一件事，两者**对齐而不是各说各话**：

| 契约 | 包版本 | 何时 |
| --- | --- | --- |
| `apiVersion: 1` | major `1`（`1.x.y`） | 当前 |
| `apiVersion: 1`，尚未定稿 | `1.0.0-alpha.N` | 预发布，本阶段用的就是这一档 |
| `apiVersion: 2` | major `2`（`2.x.y`） | 一次破坏性契约变更 |

规则只有两条：

- **破坏性变更是新版本，绝不是就地修改。** 这与 `SystemPluginDefinition.apiVersion`
  的规矩、以及 `docs/SYSTEM-PLUGINS.md` 给第三方扩展清单 `iris.apiVersion` 的规矩，
  是同一条；三个包同时升 major，因为它们是一份契约的三个面。
- **三个包共用一个版本号。** 不是因为它们变化频率相同（不相同），而是因为一个插件
  仓库同时装三个，而「哪三个版本互相配套」这个问题不应该由插件作者去查表。

版本号由协调者决定并作为 `--version` 传入。本文不替任何一次发布定这个数。

## 6. 插件仓库的 package.json 长什么样

```json
{
  "name": "iris-plugin-example",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@iris/plugin-api": "1.0.0-alpha.0",
    "@iris/plugin-web-api": "1.0.0-alpha.0",
    "@iris/protocol": "1.0.0-alpha.0",
    "@deepseek-ai/cordis": "4.0.2"
  }
}
```

`@deepseek-ai/cordis` 写在插件仓库自己的 `dependencies` 里，是因为它是
`@iris/plugin-api` 的 peer——由使用方提供那**唯一一份**，正是 peer 的含义。版本必须
与宿主用的那一份一致（当前 `4.0.2`）。

tsconfig 侧不需要任何 `paths` 或别名：解析全部走已发布 `exports` 的 `types` 条件。
这一点由 `apps/iris/tests/contract-pack.test.ts` 实测——它把三个 tarball 解开到一个
临时 `node_modules`（上面没有任何工作区），在里面跑 `tsc --noEmit`，再 `import()`
真正的 `lib/index.js`。

## 7. 「类型能解析」不等于「接线已存在」

这是本阶段最容易被读成好消息的一句话，所以写在这里。

上面所有内容证明的是：一个仓库外的插件可以**写出来并通过类型检查**——
`SystemPluginDefinition` 的形状、`SandboxPluginRuntime` 的形状、`RpcMethod` 的取值
都对得上。它**没有**证明这个插件能跑起来。一个 system plugin 仍然必须被宿主接纳：
目前宿主的插件目录是编译期的一张表，安装、发现、资产装配、贡献注册都还是封闭的
（`notes/PLUGIN-FEASIBILITY.md` 记着这些口子各自在哪）。

换句话说：现在可以拿这三个包**开始写**一个插件，但把它装进 Iris 是后面一个独立的
步骤，本次没有做，也没有任何测试假装做了。

## 8. 刻意没做的

- **不发到任何 registry。** `npm pack` 产出 tarball 就结束；没有 `npm publish`，没有
  registry 配置，没有令牌。哪里发、以什么 scope 发、要不要发，都还没有决定。
- **不动工作区的 `private`。** 见 §1。三个包在工作区里依然是
  `"private": true` / `"version": "0.0.0"` / `exports` 指向 `./src/index.ts`。
- **不发布源码子路径。** 见 §4。
- **`dist-pack/` 不入库。** 它是派生物，且它的内容由产生它的那个 `--version` 决定；
  脚本每次运行先把它删掉。

## 9. 实测记录与已知缺口

测于 2026-09-15，TypeScript 5.9.3 / Node 24.13.0 / npm 11.18.0。

- **`rewriteRelativeImportExtensions` 只改写 `.js`，不改写 `.d.ts`。** 实测
  `lib/index.js` 里是 `from "./bundle-specifiers.js"`，而 `lib/index.d.ts` 里仍是
  `from './bundle-specifiers.ts'`。这**不是**故障：消费侧 `tsc` 把声明文件里的
  `./x.ts` 解析到同目录的 `x.d.ts`，实测消费者类型检查全绿（并且是在
  `skipLibCheck` 关闭的探针里先验证过一次，没有出现任何 "Cannot find module"）。
  记在这里是因为任务书预期的是「JS 与 `.d.ts` 都被改写」，而实测只有前者；若将来
  这条解析规则变了，症状会是插件作者那边的类型全变 `any`。
- **map 文件指向 tarball 里没有的路径。** `sourceMap` 已开 `inlineSources`，所以
  `.js.map` 自带源码、可用；`.d.ts.map` 指向 `../src/*.ts`，而 `files: ["lib"]` 不包含
  `src`，于是从插件仓库对契约类型做「跳转到定义」会落空。没有改，因为修它要么改
  `files`（发布形的决定），要么删 `declarationMap`（任务书明确要求开）。
- **「删掉上一轮的输出」这一步是被检查的，因为它真的静默失败过。** 实测本机的 agent
  沙箱会拦截项目目录下的删除：`rmSync(outDir, { recursive: true, force: true })`
  **不报错也不删**，于是两次不同 `--version` 的运行在 `dist-pack/` 里留下了六个
  tarball，而整轮运行什么都没说。脚本现在在删完之后检查目录确实空了，不空就退出并
  说明原因；`apps/iris/tests/contract-pack.test.ts` 在运行前往输出目录里放两个诱饵
  （一个假的 `.tgz`、一个上一轮才有的 `lib/ghost.js`），运行后断言它们不在了，
  并断言目录里的 `.tgz` 恰好是本轮那三个。
- **`tsc` 的报错位置提前了一格。** 把 `rewriteRelativeImportExtensions` 关掉时，失败
  不是发生在产物上，而是 `tsc` 直接拒绝编译：
  `error TS5096: Option 'allowImportingTsExtensions' can only be used when either 'noEmit' or 'emitDeclarationOnly' is set.`
  也就是说这个开关在本仓库的配置下**删不掉**——这是好事，但要知道守住它的是编译器
  而不是测试里那条扫描。
