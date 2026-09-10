# AUDIT-SYSTEM-ARCHITECTURE — 架构与结构域系统审计

- **审计基准**：`dev/audit-system-report` 工作树（未 commit 的 HEAD 状态），2026-09-10。
- **审计范围**：Cordis 插件树、service.ts 体量复查、包依赖方向、重复实现与死代码、`build:web` 构建管线、根脚本面。
- **方法**：只读产品代码 + 可复跑量具（`scripts/audit-arch.mjs`，本审计随附，`node scripts/audit-arch.mjs [--json]`）+ 受控构建实验（日志在 `notes/audit-tmp/`）。未改任何产品代码，未动 git 状态。
- **前案对照**：`notes/AUDIT-CORDIS.md`（82 handler / 3279 行的原始出处，§2）。

---

## 0. 总览

**发现 13 项：高 4、中 6、低 3。**

三句话结论：

1. **Cordis 纪律本身是健康的**：组合根 9 行、无插件外单例，AUDIT-CORDIS 记录的唯一生命周期违规（运行时适配器 disposer 无人回收）**已经修复**；但两份结构台账（`docs/ARCHITECTURE.md` 层表、`notes/CORDIS-TREE.md` 数字）都对不上现实。
2. **单体拆分的触发条件已满足**：`service.ts` 从审计基线的 3279 行 / 82 handler 涨到 **6031 行 / 110 handler**（+84% / +34%），且新增了三个域（scriptLibrary/backup/usage）——上一轮"下一批功能落地前应当拆"的条件已兑现，拆分线见 §2。
3. **`build:web` "间歇性陈旧 dist"不是 npm --prefix 的锅**：交替构建实验证明两种调用方式行为完全一致；根因在文件系统层——本机对 `dist/` 内的删除是**异步延后的（delete-pending）**，`rmSync` 返回成功而旧文件在秒级到分钟级窗口内仍在，vite 的 `emptyOutDir` 事实上退化为"合并"，任何在这个窗口里做的内容级验证都会读到上一代产物。最小复现与完整证据链见 §5。

---

## 1. Cordis 插件树现状

### 1.1 组合根与 boot 链（现状即正确）

`apps/iris/cordis.yml` 共 **9 行插件**：logger(:10)、timer(:22)、system-prompt(:28)、llm(:36)、llm-openai-compat(:42)、webserver(:56)、rpc(:64)、app(:73)、frontend(:154)。与 `notes/CORDIS-TREE.md:28` 声称的"要装 9 个插件"一致，**无行数漂移**。

boot 链：`apps/iris/bin.ts:23` 读 `.env` → `bin.ts:32-35` 把 `IRIS_WEB_DIST` 解析为 `apps/iris-web/dist/index.html`（存在才设，否则 frontend 行经 `cordis.yml:158` 的 `disabled` 表达式自动停用）→ `bin.ts:37` `boot('iris', cordis.yml)` → `bin.ts:51` 打印的是**实际绑定端口**而非配置端口。启动顺序由 `inject` 声明推导，`cordis.yml:7-8` 与 CORDIS-TREE.md §二 的说法一致。

注册面：`packages/iris-app-service/src/index.ts` 中 `irisRpc.register` 共 **110 处**，全部收在 `ctx.effect` 的可逆注册表里（`index.ts:812,940,951,967,983` 等）；运行时适配器安装已改为 `installed.set(route, ctx.effect(...))`（`index.ts:677-699`，注释自证"unloading the app plugin takes its runtime adapters with it"）。**AUDIT-CORDIS.md §3 缺口 1（生命周期违规）确认已修复。**

### 1.2 发现一【中】结构台账数字漂移：CORDIS-TREE.md 落后两个数量级

- **位置/证据**：`notes/CORDIS-TREE.md:74`"约 70 个方法"、`:138`"service.ts 约 2300 行"；实测 **110 个方法 / 6031 行**（§2）。§四.2 的域表缺 scriptLibrary.\*、backup.\*、usage.\* 三个 4 月后新增的域。
- **影响**：CORDIS-TREE.md 是"什么注册了"的台账（AUDIT-CORDIS 缺口 3 的教训原话："把在途分支写成存量会让下一次审计以错误基线出发"）。数字失真让"大脑有点胖了"这笔债看起来还停在临界点之前，而实际早已越线。
- **建议**：数字行改为"以 `node scripts/audit-arch.mjs` 输出为准"并刷一次当前值；给域表补三个新域。`audit-arch.mjs` 已实现 composition 一节的自动对照（compositionCensus）。
- **工作量**：S。

---

## 2. service.ts 体量复查（旧裁定的现状核对）

### 2.1 数字

| 指标 | AUDIT-CORDIS 基线（§2，c9dfa37） | 现在（audit-arch.mjs 实测） | 斜率 |
|---|---|---|---|
| service.ts 行数 | 3279（AUDIT-CORDIS.md:128） | **6031**（`wc -l`；`handlers()` 起于 `service.ts:1409`，下一类成员 `#backups()` 在 `:3522`，即 handlers() 单方法跨约 2112 行） | **+84%** |
| 注册 handler 数 | 82（AUDIT-CORDIS.md:118） | **110** | **+34%** |
| 协议声明 vs 注册 | — | 110 = 110，无 unregistered/undeclared | 对齐 |

域分布（audit-arch.mjs，按注册数降序）：script 24、chat 17、worldbook 13、preset 12、character 8、regex 8、connection 6、**scriptLibrary 5**、**backup 4**、persona 4、storage 3、prompt 2、settings 2、**debug 1**、**usage 1**（加粗为基线后新增/翻倍的域）。

### 2.2 发现二【高】拆分触发条件已满足，拆分线画在哪

- **证据**：AUDIT-CORDIS.md:130 的判定是"△ 已到临界点，尚未越界……下一批功能落地前应当拆"，其 §4 建议的触发条件是"script.\* 面再扩、或下一个新域落地时执行"。现在：script 面 24→**29**（scriptLibrary.\* 是 script 域的直接延伸）、新域 backup/usage 已落地、regex 翻倍、character 3→8。触发条件**全部兑现**。
- **另一根独立证据**：handlers() 不是按域分段的——script.\* 的 24 个 handler 在表内散布于 **6 段不相邻的区间**（`script.setChatMessages` 起于 `service.ts:1731`，紧跟 chat 段 `chat.abort` `:1706`；`prompt.*` 卡在两段 script 之间 `:2044`；末段 `script.generate` `:3483`、`script.fetch` `:3495`），说明 TH 兼容面和生成交响已经在一个 2000 行的方法体里长在一起了。
- **拆分方案更新**（取代 AUDIT-CORDIS §4 的"到了该做的那一刀"一节）：
  - **阶段一（包内分文件，不动 Cordis，每域 S）**：把 handlers() 表按域切成 `handlers/chat.ts`、`handlers/worldbook.ts`、`handlers/script.ts`…，各自导出 `xxxHandlers(service)` 返回部分 `Handlers`，由 `handlers()` 合并。协议面、注册 effect、cordis.yml 全部不动；收益是 handlers() 方法体和 6031 行立刻解体为按域文件。
  - **阶段二（兄弟插件，仅 script-compat 先走）**：`@iris/app-service` 保留 chat 17 + character 8 + storage 3 + prompt 2 + settings 2 + debug 1（≈33 个核心生成交互面）；拆出 **script-compat**（script 24 + scriptLibrary 5 = 29 个，26%，`inject: ['irisRpc']` 自带注册）、**worldbook+regex**（21）、**preset+persona**（16）、**connection+backup+usage**（11）。rpc-host 按方法路由，与插件数无关（AUDIT-CORDIS.md:165 原话仍成立）。
  - **不再建议**的路线：为拆而拆地一次性五连拆。阶段一先落地，阶段二按域逐个走，每拆一个域跑一次 `pnpm verify`。
- **工作量**：阶段一合计 M；阶段二每域 M（script-compat 因与 chat 在表内交错，提取时需重排，L）。

---

## 3. 包依赖方向

### 3.1 图的形状（现状即正确）

audit-arch.mjs 按 manifest dependencies + 源码 import 双向计算：**23 个 workspace 包（apps/iris-web 除外）、零环、零反向依赖**——没有任何包依赖 `@iris/app-service`、`@iris/rpc-host` 或 `@iris/app`（L4/L5），唯一指向组合根的边是 `app → app-service`（应当的）。协议边界干净：`@iris/protocol` 零依赖（L0），`rpc-client` 只依赖 protocol，浏览器侧（apps/iris-web）经 Vite alias 只见 `protocol / rpc-client / client-fake / compat-tavernhelper-core` 四个名字（`apps/iris-web/vite.config.ts:39-45`），audit-arch.mjs 的 webForbidden 检查零违规。

### 3.2 发现三【中】compat-tavernhelper-core 名实倒挂：一个 L0 工具包挂着 compat 的名字

- **位置/证据**：`packages/iris-compat-tavernhelper-core`（L0，零依赖）实际 contents 是通用工具：`stringHash`、`parseRegexFromString`、`TAVERN_EVENTS`、`EventBus`。它被**域包**当基础设施用：`packages/iris-lorebook/src/activate.ts:333`、`packages/iris-lorebook/src/matching.ts:24`、`packages/iris-macro/src/registry.ts:172`；同时被宿主 compat 面和前端沙箱用（`apps/iris-web/src/sandbox/frame.ts:33` 等）。
- **影响**：compat 语义上应坐在域之上（compat-tavernhelper 依赖 chat/mvu/variables，L3），但它的"core"被域包倒过来依赖，导致 lorebook/macro 的计算层级从 L0 变 L1——这是 ARCHITECTURE.md 层表漂移的成因之一（§3.3）。名字在说谎：读图的人会以为域包依赖了兼容层。
- **建议**：二选一——(a) 承认现实：在 ARCHITECTURE.md 层表把它列进 L0 并加一行"名字里的 compat 是历史，它是事件名与纯函数的叶子工具包"（S）；(b) 改名为中性叶子包（如 `@iris/events-core`），包名变更波及 5 个 manifest + 若干 import（M）。建议先 (a)。
- **工作量**：S（方案 a）/ M（方案 b）。

### 3.3 发现四【高】docs/ARCHITECTURE.md 层表漂移

- **位置/证据**：`docs/ARCHITECTURE.md:9` 声称"22 packages in five layers"；实际 23 个（`@iris/compat-prompt-template` 与 `@iris/compat-tavernhelper-core` 两包**不在表中**）。层级错四处：app-service 表载 L3 实算 L4；compat-tavernhelper 表载 L2 实算 L3（因 mvu 是 L2）；lorebook、macro 表载 L0 实算 L1（因 §3.2 的 core 依赖）。
- **影响**：层表是"新包该放哪"的裁决依据；漂移的表会把这个裁决变成看谁的声音大。AUDIT-CORDIS 缺口 3 的同型问题，只是从组合树台账换到了架构文档。
- **建议**：把 audit-arch.mjs 的 layerDrift 段落接进 CI 或 `pnpm verify`（脚本已有，退出码对 error 类敏感、drift 类只报告——可加 `--strict` 让 doc-drift 也非零）；先人工刷一次表。
- **工作量**：S（刷表）+ S（strict 开关）。

### 3.4 发现五【中】测试支撑的越界共享（唯一的反向 import，藏在 tests 里）

- **位置/证据**：`packages/iris-llm-openai-compat/tests/{adapter-key,baseurl-parity,interrupted,timeouts}.test.ts` 与 `packages/iris-rpc-host/tests/transport.test.ts` 都按相对路径 import `../../iris-app-service/tests/support/fetchable-port.ts`（向上的包边界，仅测试代码）；`apps/iris/tests/live-generation-kinds.test.ts` 深入 import app-service 的 src 与 tests/support。audit-arch.mjs 以 manifest-drift warn 报告。
- **影响**：产品依赖图干净，但"support 文件属于谁"没有答案——改 app-service 的测试支撑会莫名打断 llm-openai-compat 的测试。这是 workspace 边界纪律唯一被磨损的位置。
- **建议**：把 `fetchable-port.ts`、`materialising-store.ts` 提为 `@iris/test-support` 叶子包（或最便宜的：挪进 protocol 包的 tests/support，两者都依赖 protocol）。
- **工作量**：S。

---

## 4. 重复实现与死代码

### 4.1 发现六【中】量具泛滥：42 个脚本文件 / ~13,000 行，机制彼此重叠

- **位置/证据**：`scripts/` **20 个代码文件（19 个顶层 .mjs + lib/cache-host.mjs，7,432 行）**、`qa/` **24 个文件（23 .mjs + 1 .ps1，5,580 行）**，合计 44 个文件约 13,000 行；根 package.json 接线 15 个脚本名（`package.json:16-21` 六个 `census:*`）。任务书里点名的 `th-surface-audit`、`st-context-audit` **已不存在**（全仓 grep 无引用）——量具已在自然生灭，但没有退休机制。重叠实例：
  - dist 一致性检查存在三份：`notes/audit-tmp/verify-dist.mjs`（本次审计的 throwaway）、`apps/iris-web/tools/live-user-html-check.mjs`、`apps/iris-web/tools/check-bootstrap.mjs`——三个都在回答"index.html 引用的资产在不在"。
  - 成员清单两份清单一个读者：上游 TH 成员目录在 `apps/iris-web/src/sandbox/upstream-surface.ts`（202 行，**前端沙箱资产**），宿主侧 TH 兼容面在 `packages/iris-compat-tavernhelper`（5 文件 793 行），而 `scripts/th-member-census.mjs:12,74` 靠**字符串定位源码里的 `UPSTREAM_MEMBERS`** 来拿清单——脆解析。
  - `notes/dead-export-scan.mjs`（32 行 throwaway）与本次新产的 audit-arch.mjs 各自扫源码。
- **影响**：每个量具都带着自己的假设（corpus 路径、解析方式、输出格式），互相不知道对方存在；"跑哪个、信哪个"成为每次排查的第一道成本。这正是三份 dist 检查并存还拦不住陈旧 dist 的原因（§5）。
- **建议（归并方案）**：
  1. `scripts/` 定位为**可复跑量具**、`qa/` 定位为**一次性验收记录**，在 README 各写一行判据；qa/ 里已失去对象的脚本（notice-probe 三张卡的 JSON、z1/z3 系列）移入 `notes/` 存档或删除。
  2. dist 一致性三合一：`apps/iris-web/tools/` 收一个 `check-dist.mjs`（以 verify-dist.mjs 的"引用闭包 + manifest 对账"为核，live-user-html-check 的真实注入为可选参数），build 链尾与人工验证共用。
  3. `th-member-census.mjs` 改为 import（upstream-surface.ts 是 TS，census 可经 `node --experimental-strip-types` 直接读）或让 upstream-surface.ts 导出一个 JSON 旁车文件，停止字符串考古。
  4. 量具准入规则：新增 `census:*` 前必须在脚本头注释里写"回答什么问题、何时可删"——`cache-cause-census.mjs` 等已有此风格，推广即可。
- **工作量**：M（归并）/ S（规则与 README）。

### 4.2 发现七【低】死导出候选 17 处（多为"过度导出"而非死代码）

- **位置/证据**：`notes/dead-export-scan.mjs` 全仓扫描（601 文件）得到 17 个"无其他文件引用"的导出名，抽样核实：`packages/iris-protocol/src/providers.ts:60` 的 `OPENAI` 等 8 个 ProviderPreset 常量实际在本文件 `:122` 的表里被用——是**过度导出**（不导出也成立），不是死代码；真正无任何引用的候选：`packages/iris-app-service/src/template.ts` 的 `lorebooksOf`、`src/version.ts` 的 `VersionInfo`、`src/st-install.ts` 的 `FetchResult`、`packages/iris-preset/src/parity.ts` 的 `MatchedBlock/LoneBlock`、`packages/iris-llm-openai-compat/src/translate.ts` 的 `WireChunk/mapFinishReason`。
- **影响**：低——主要是协议包的公共面比实际需要的大，`providers.ts` 每个 preset 都成了 API。
- **建议**：逐个确认后去 export 关键字；`providers.ts` 若只想暴露合并表，8 个常量去导出。
- **工作量**：S。

---

## 5. `build:web` 陈旧 dist 诊断（本次专项）

### 5.1 实验记录

交替跑根 `npm run build:web` 与 `cd apps/iris-web && npm run build`，每轮后比对 `dist/index.html` 的 sha256/mtime、入口资产哈希、sandbox manifest、引用一致性（采集器：`notes/audit-tmp/dist-state.mjs`；日志：`notes/audit-tmp/exp-*.log` 与前案 `build-*-*.log`）：

| 轮次 | 调用 | 耗时 | exit | index.html 内容 | index.html mtime | 一致性 |
|---|---|---|---|---|---|---|
| 基线 | — | — | — | d586f348… | 01:58:26 | CONSISTENT |
| R1 | 根 `npm run build:web` | 24.1s | 0 | **同哈希**（确定性构建） | **已更新** | CONSISTENT |
| R2 | 本地 `npm run build` | ~24s | 0 | 同哈希 | 已更新 | CONSISTENT |
| R3 | 裸 `./node_modules/.bin/vite build` | — | 0 | 同哈希 | 已更新 | — |
| R4 | `vite build --emptyOutDir`（强制） | — | 0 | 同哈希 | 已更新 | — |
| R5 | fs 探针 + 完整根构建 | — | 0 | 同哈希 | 已更新 | CONSISTENT |
| 前案 race-A/C/D | 并发构建 | — | 0 | — | — | — |
| 前案 race-B | 并发构建 | — | **1** | — | — | 失败点：`hash-sandbox-assets.mjs:70`"bootstrap.js was not emitted" |

**调用方式差异：没有。** 根 `npm --prefix` 与本地 `npm run` 在 cwd（日志中 outDir 均解析为同一个绝对路径）、生命周期钩子（build:sandbox → vite build → prune×2 全部执行）、退出码、产物字节上完全一致。"npm --prefix 在此环境行为异常"的假设被排除。

### 5.2 根因结论【高】

**本机对 `apps/iris-web/dist/` 内的删除是异步延后的（Windows delete-pending），`emptyOutDir` 在此退化成"合并"，任何落在延后窗口内的内容级验证读到的是上一代产物。** 证据链（每条独立成立）：

1. **rmSync 成功 ≠ 文件消失**：`node -e "fs.rmSync('dist/CANARY4.txt',{force:true})"` 返回 ok，紧接着 `existsSync` 为 **true**（立即复测）。
2. **金丝雀穿越完整构建**：放入 `dist/CANARY.txt` 后跑完整 `npm run build`（exit 0），金丝雀**仍在**；连 `vite build --emptyOutDir` 强制清空也杀不死它（R4）。
3. **但 vite 的清空逻辑确实执行了**：fs 探针（`notes/audit-tmp/fs-probe.cjs`，NODE_OPTIONS preload）抓到主构建对 `dist/.vite`、`dist/assets`、`dist/index.html`、`dist/sandbox`、金丝雀**逐一发出 rmSync**，随后 mkdir+copy+write——管线本身是对的，是删除动作没有落地。
4. **延后是真实的、且时长不定**：一只金丝雀在约 1 分钟后自行消失（句柄释放，删除完成）；另几只存活穿过多次构建。
5. **生产事故现场同型**：`dist/sandbox/` 里至今躺着**未哈希**的 `bootstrap.js` 与 `message-preset.js`（`hash-sandbox-assets.mjs:45` 的 ARTIFACTS 早已改为只认哈希名，`public/sandbox/` 里并无这两个文件）——它们是某次删除被延后的旧代产物，穿越了其后**每一次**完整构建的 emptyOutDir，还在被宿主当普通文件服务（不可 immutably 缓存，但固定名可被命中）。
6. **放大器：服务中的宿主**。实验全程有一台常驻 Iris 宿主（PID 24060，`node apps/iris/bin.ts`，LISTEN 127.0.0.1:8787）正服务着这个 dist。宿主无 boot 缓存（`dsh-host-frontend-static/lib/index.js:80` 每请求现读 index.html），所以"陈旧"不是服务端缓存，而是：构建的删除延后窗口 ∩ 验证读取时刻。"三次被内容级验证拦下"与这个窗口的命中率一致。
7. **次要因素**：确定性构建（源码未变时 index.html 字节不变）会让"只比内容"的验证把正常构建误读为"没更新"——**mtime 才是"构建是否发生"的判据，内容哈希只判"产物是否新鲜"**。

### 5.3 最小复现

```
echo canary > apps/iris-web/dist/CANARY.txt
npm run build:web            # exit 0
ls apps/iris-web/dist/CANARY.txt   # 仍在你眼前（本审计复现 3/3）
```

以及并发变体：两个构建同时跑，`hash-sandbox-assets.mjs:70` 报 "bootstrap.js was not emitted"、exit 1（race-B，前案日志）。

### 5.4 建议

1. **发布改为换名+换名**（S）：主构建 outDir 改 `dist-next`，成功后 `rename(dist, dist-old)` → `rename(dist-next, dist)` → 删 dist-old。rename 不经过逐文件 delete-pending，读取方（宿主按路径现读）在新旧目录间原子切换；`IRIS_WEB_DIST` 指向的 index.html 路径不变。这是唯一对 delete-pending 免疫的形态。
2. **验证判据改为 mtime + 引用闭包**（S）：内容哈希只对"比上次构建新增的源"有意义；`verify-dist.mjs` 的 CONSISTENT 判定（引用闭包 + manifest 对账）配上 `index.html mtime >= 构建起始时刻` 才是完整的"构建真的发生了且产物自洽"。把 verify-dist.mjs 收进 `apps/iris-web/tools/check-dist.mjs`（见 §4.1）并挂在 build 链尾。
3. **并发锁**（S）：build 链首加一个简单锁文件（存在即失败并指明持有者），或约定"构建前先停宿主"。race-B 已经证明并发失败是响的，但 A/C/D 的静默合并型交错更危险。
4. **清掉现存的两个杂散**（S，顺手）：宿主重启后（无句柄）手动删 `dist/sandbox/bootstrap.js`、`dist/sandbox/message-preset.js`，或直接换名发布自然甩掉。

---

## 6. 根 package.json 其余脚本面

- **发现八【中】`verify` 不覆盖前端**（`package.json:25`，根 `tsconfig.json` include 无 `apps/iris-web`）：`pnpm verify` = packages+apps/iris 测试与类型检查，前端类型错误只在 `apps/iris-web` 的 npm 侧 `typecheck` 里可见，而没有任何根级入口会调它。建议 verify 追加 `npm --prefix apps/iris-web run typecheck`。工作量 S。
- **发现九【低】`start`/`test` 对环境的隐含要求**（`package.json:11-12`）：`node apps/iris/bin.ts` 依赖 Node ≥24 的类型剥离直跑（`engines: >=24` 只是咨询性字段，不设 `engine-strict` 时 npm 仅警告）；`test` 的 glob 由 node --test 自身展开（cmd 不展开，行为成立但值得在 CONTRIBUTING 注明 node 版本门槛）。工作量 S。
- 其余 `census:*`、`test:*` 脚本均为直接 `node scripts/x.mjs`，无 --prefix、无嵌套 npm、无跨目录相对路径，形态健康；`build:web` 是**唯一**的 --prefix 用法，且 §5 已排除其嫌疑。

---

## 7. 建议的修复顺序

| # | 发现 | 动作 | 严重度 | 工作量 | 依赖 |
|---|---|---|---|---|---|
| 1 | §5 build:web 陈旧 | 换名发布（dist-next→rename）+ 构建锁 | 高 | S | 无 |
| 2 | §5 验证判据 | check-dist.mjs 三合一，挂 build 链尾 | 高 | S | 无 |
| 3 | §2 service.ts | 阶段一：handlers() 按域分文件 | 高 | M | 无 |
| 4 | §3.3 / §1.2 台账漂移 | 刷 ARCHITECTURE.md 层表 + CORDIS-TREE 数字；audit-arch.mjs --strict | 高 | S | 无 |
| 5 | §3.2 core 倒挂 | 层表收录 core 包为 L0 并注记（方案 a） | 中 | S | #4 |
| 6 | §3.4 测试支撑越界 | fetchable-port 等提为共享支撑 | 中 | S | 无 |
| 7 | §4.1 量具泛滥 | qa/scripts 判据 + 死量具退休 + census 准入注释 | 中 | M | 无 |
| 8 | §6 verify 缺口 | verify 追加前端 typecheck | 中 | S | 无 |
| 9 | §2 阶段二 | script-compat 先拆为兄弟插件 | 高 | M-L | #3 |
| 10 | §4.2 过度导出 | 17 处逐个确认去 export | 低 | S | 无 |
| 11 | §5.4 杂散 | 重启宿主后清 dist/sandbox 两个未哈希文件 | 中 | S | #1 |
| 12 | §4.1 脆解析 | th-member-census 停止字符串考古 | 低 | S | 无 |
| 13 | §6 engines | CONTRIBUTING 注明 node ≥24 门槛 | 低 | S | 无 |

---

## 附：本次产出

- 量具：`scripts/audit-arch.mjs`（分层/漂移/handler 普查/组合对照，`--json` 落 `notes/audit-arch-last-run.json`；error 类发现使退出码非零）。
- 实验器材与日志：`notes/audit-tmp/`（`dist-state.mjs`、`fs-probe.cjs`、`exp-root-1.log`、`exp-local-1.log`、`exp-vite-only.log`、`exp-root-probe.log`；前案 `build-race-{A..D}.log`、`verify-dist.mjs`）。
- 死导出扫描：`notes/dead-export-scan.mjs`（throwaway，结论已收进 §4.2，可删）。
