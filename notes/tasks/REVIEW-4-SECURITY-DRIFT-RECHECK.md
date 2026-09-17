# 审查手册 4 · 安全修复的漂移复查

> 状态：有效。写于 2026-09-17，基线 `main` `09944b8`。给 owner 亲自做；产出是 `notes/SECURITY-REMEDIATION.md` 末尾一段带日期的复查记录，加一个很小的测试 PR。发现的漂移进清单交给我派任务，不顺手修。

## 0. 先修正一个前提

任务单说 `host-allowlist.test.ts` 那条「每个注册的路由都拒陌生 Host」是**动态枚举**的。不是。读 `apps/iris/tests/host-allowlist.test.ts:194–251`：两条测试（Host 拒绝、nosniff）各自**手写**了同一张四条路由的表——

```
const routes = ['/version', '/iris/avatar/aria.png', '/iris/script-bundle/nothing.js', '/sandbox/preset.js']
```

而 9 月 11 日之后新挂的两条前缀不在表里：

| 路由 | 常量 | 挂载处 | 用途 |
| --- | --- | --- | --- |
| `/plugins/*` | `PLUGIN_ASSET_PREFIX`（`packages/iris-plugin-web-api/src/index.ts:204`） | `packages/iris-app-service/src/index.ts:1493` | 插件的浏览器包、清单、i18n 表 |
| `/iris-st-ext/*` | `ST_EXT_PREFIX`（`packages/iris-app-service/src/st-ext-assets.ts:31`） | `index.ts:1523` | ST 扩展的静态资产 |

它们**大概率**是安全的：`packages/iris-rpc-host/src/index.ts:344–372` 的 `guard()` 说「Iris 拥有的每条路由都经过这一个函数」，先 `setHeader nosniff` 再 `checkHost`；`plugin-assets.ts:24` 的注释也说走 `index.ts` 的挂载「买到了 Host 白名单和 nosniff」。但**没有测试证明**这两条路由真的经过了 `guard`，而这正是那条测试存在的意义（「四个处理器可能忘记的事」）。所以本次复查带一个小代码产出：把表补齐，并让表和挂载数互相校验（§3.1）。

## 1. 对象与尺子

`notes/SECURITY-REMEDIATION.md`：34 条（网络审计 H/M/L 17 条，系统与数据审计 F 17 条），2026-09-11 的读数是 **29 落地 / 4 接受 / 1 待办**。每条「落地」行都指向一个台账节，台账节里有测试表。复查的问题只有两个：

1. **钉它的测试还在、还绿吗？** —— `git ls-files` 找到文件，`node --test <文件>` 跑一次。
2. **它守的面有没有长大？** —— 9 月 11 日之后新增的面：`/plugins/*`、`/iris-st-ext/*` 两条路由；`plugin.install`/`plugin.preview`/`plugin.update`/`plugin.uninstall` 一组 RPC（#97–#99、#106）；`scope.storage` 私有存储（#104）；插件 i18n 表落盘（#101）；安装器的 git 取包（#105 U6）；MVU/TH 变量写者改线（#103）。每一条落地行都要问：这个修复的**同类问题**在新面上有没有再长出来。

## 2. 逐行怎么判

每行三个格子，只写事实：

- **测试**：文件名 + 测试名；`存在且绿` / `不存在` / `存在但只覆盖旧面`。
- **新面**：新增面里有没有同类；`无` / `有，已覆盖（哪条测试）` / `有，未覆盖（哪一处，path:line）`。
- **结论**：`成立` / `漂移`（写清哪一层）/ `判不了`（缺哪一步测量）。

以代码为准；台账里的 `path:line` 是当时的行号，只当线索。

## 3. 重点行（先做这些，其余按表走）

### 3.1 H-2 / H-3 / F5 / L-1（Host 白名单与 nosniff）——带代码产出

1. 读 `host-allowlist.test.ts:194–251`，把两张路由表补上 `/plugins/nothing/nothing.js` 与 `/iris-st-ext/nothing.js`（两条测试的注释都说「拒绝与 miss 也在内」，所以 miss 路径就够，不必先装插件）。**先不改代码，跑一次**：如果新增两条已经绿，说明 `guard` 的「每条路由」为真；如果红，就是漂移，记下来交给我，测试保留红的那条别删。
2. 让表不再靠手写：`index.ts:1496`/`:1526` 每次挂载都打一行 `irisApp: GET <prefix>` 日志。最省事的校验是在测试里数挂载：要么让 `irisApp` 暴露一个只读的「已挂载前缀」列表（一个 getter，不改行为），要么在测试里抓启动日志里 `irisApp: GET` 的条数，断言 `routes.length >= 挂载数`——**把比较过的数量当地板**（一条 `continue` 让只比 4 条还全绿，我们吃过这亏）。选前者，改动更小。
3. 顺手确认 `guard` 不达的两处仍然只有两处：WebSocket 升级、carrier 的 `index.html`/静态资产兜底（rpc-host §1、app-service §74 记的缺口）。看 `index.ts` 有没有新的**不经 `guard`** 的注册。

4. 两条新路由如果**一次就绿**，顺手把 `packages/iris-rpc-host/src/index.ts:340` 附近 `guard()` 注释里「Iris 拥有的每条路由都经过这一个函数」那句改成有出处的写法——「每条路由都经过这一个函数；`apps/iris/tests/host-allowlist.test.ts` 的两条路由表钉着这一点，新挂路由要同时加进那张表」。注释比文档更容易过期，这一句现在是靠人记着，改完就靠测试记着。

### 3.2 F1 / F6 / F12 / F14（原子写与坏文件）

`packages/iris-app-service/src/atomic.ts` 是唯一的原子写入口（`atomicWriteFile` / `readJsonStore` / `quarantine*`），今天 24 个文件引用它。新面里要点名查的：

- `packages/iris-app-service/src/plugins/install.ts:1182`：i18n 表落盘用的是裸 `fsp.writeFile`，不是 `atomicWriteFile`。这是 F12 的同类。它是**派生物**（启动时 `scanInstalled` 会重发），撕裂后自愈；但「读到半个 JSON 时读方怎么办」要看 `plugin-assets.ts` 怎么读——如果读方抛，就是 F14 的同类。判「漂移」还是「接受」由我定，你记事实。
- `plugins/` 目录下其余 `writeFile(`：`grep -rn "writeFile(" packages/iris-app-service/src/plugins/` 逐条看是记录（`installed` 记录、`plugin-storage`）还是派生物。
- U3 的 `scope.storage`（#104，§83）：存储文件的写是不是走 `atomicWriteFile`；坏文件是隔离（`quarantine*`）还是覆盖。

### 3.3 F2（一目录一宿主）

`host.lock` 是否也盖住了 `system-plugins/` 目录：两台宿主指同一 `IRIS_DATA_DIR` 时，第二台应在 `host.lock` 就拒绝，插件目录自然安全；只需确认安装路径没有在 `host.lock` 之外另开一个可写目录（比如临时的 staging 目录在 `os.tmpdir()`）。

### 3.4 F3 / U6（远程取物的重定向与大小上限）

`script.fetch` 的三条规则（每跳重查、大小上限、协议）是 #66。安装器（#97 `iris-extension-installer`，#105 U6 硬化）是**另一条取物路径**：读 U6 的台账节（host §85）里「决策 8 关闭：拒绝带凭据的 URL」那一段，把 U6 已经做的（远端白名单、凭据拒绝、大小/文件数上限）和 F3 的三条对齐列一张表，缺哪条写哪条。不要求它们一样，要求**缺的那条是有意的**（台账里有理由）。

### 3.5 M-2 / L-6 / L-7（原型污染与无界整数）

`assertStorable` 与 `writePath` 的 `__proto__` 段拒绝（#73，variables §1）。新面：`scope.storage` 的键名、插件清单里的 `permissions`/`i18n` 键、`plugin.update` 传入的 `updateOf`。看 zod 模式是不是 `z.record` 加了键名校验，或者存进去之前过了 `wireKeyedTable`（`atomic.ts:280`，就是为这事写的）。

### 3.6 F4（密钥落盘）

#77 之后**有没有新的带密钥的存储**：安装路径会不会记下带 `userinfo` 的 remote（U6 应已拒绝，找那条测试）；provider 之外有没有新的 `apiKey` 字段（`git grep -n "apiKey\|api_key\|token" packages/iris-protocol/src/rpc.ts`）。

### 3.7 L-9 / L-10（key.txt 与 CI 钉版）

`apps/iris/tests/key-file.test.ts` 与 `workflow-pins.test.ts` 跑一遍即可；`.github/workflows/` 下有没有 9 月 11 日后新增的 workflow 文件（新文件里的 action 也要钉 SHA）。

### 3.8 四条「接受」

web §95.1–95.4 每条末尾都有「重开条件」。REVIEW-1 已经扫过一遍（`notes/LEDGER-REOPEN-SWEEP-2026-09-17.md`），照抄它的结论，只核对 §95 那四行在清单里有没有；没有就补判。

### 3.9 L-8（唯一的待办）

**现在做不了，读数如下**：载体 `@deepseek-ai/dsh-host-webserver` 装的是 `0.1.1-rc.2`（`node_modules/.pnpm/@deepseek-ai+dsh-host-webse_*/`），整包 `grep -rl "headersTimeout\|requestTimeout\|keepAliveTimeout"` 为 0 处——上游没有长出钩子。复查行写「仍待办，载体 0.1.1-rc.2 无钩子」；**不要**去 cast 过 `private` 拿 server，rpc-host §2 已经解释过为什么那比缺口更糟。顺手量一下现状（Node 24.13 默认 `requestTimeout` 300 s、`headersTimeout` 60 s）写进去，下次比对有基数。

## 4. 记录格式

在 `notes/SECURITY-REMEDIATION.md` 末尾（「Keeping this file honest」之后）追加一节：

```
## 复查（2026-09-xx，main <sha>）

| # | 测试（文件 · 名） | 状态 | 新面 | 结论 |
| --- | --- | --- | --- | --- |
| H-1 | … | 存在且绿 | 无 | 成立 |
| L-1 | host-allowlist.test.ts · every route … nosniff | 存在，只覆盖四条旧路由 | /plugins、/iris-st-ext 未覆盖 → 本次补入（PR #…） | 成立（补测后） |
…
```

表尾三个数：成立几条 / 漂移几条 / 判不了几条；再一行「L-8：仍待办，载体 0.1.1-rc.2 无钩子」。**原文一个字不改**（它自己说了「记录不随代码更新」，所以是追加复查节，不是改 29/4/1 那行）。`notes/README.md` 里这份文件的「测量于」列改成两个日期。

## 5. 边界

- 只追加，不改写原节；不改台账。
- 唯一允许的代码改动是 §3.1 的测试表补齐与挂载数校验（一个 PR，分支 `dev/security-drift-recheck-2026-09`，可以和复查节同一 PR）。其余漂移进表，交我派。
- 测试起宿主用的是 `port: 0`，不会撞 8787；但别在 8787 上做 §3.2 的坏文件实验——要试就复制一份 `apps/iris/data` 起 8788。
- 门禁：`node --test apps/iris/tests/host-allowlist.test.ts`、根目录 `npm test`（`ℹ fail 0`）、`node --test apps/iris/tests/md-references.test.ts`。

## 6. 交付

PR 到 main。完成报告给我三个数（成立 / 漂移 / 判不了）加 §3.1 的结果（补入的两条路由是一次就绿，还是红了）。漂移那几条我逐条派任务；`install.ts:1182` 那条不管你判成什么，都单列一行，我要看读方的行为。
