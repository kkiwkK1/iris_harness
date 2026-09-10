# AUDIT-SYSTEM-QUALITY-RELIABILITY — 质量与可靠性域系统审计

- **日期**：2026-09-10；**分支**：`dev/audit-system-report`（未提交任何变更，未动产品代码）。
- **范围**：测试面健康度、性能热点复测、可靠性（错误三通道 / 取消路径 / 磁盘降级）、文档账本、已知未完项盘点。
- **方法**：全量测试两轮（spec 报告器 + 自定义 JSONL 事件报告器各一轮）、`test:no-corpus` 彩排一轮计时、真进程启动探针（端口 8799，PID-only 清理）、导入闭包扫描、只读代码与账本核对。环境变量只解除（`env -u IRIS_CORPUS`，会话里它是空串会让语料测试全跳），**未设** `IRIS_LIVE`，未发任何真实 LLM 请求，未触 key.txt 与 `E:\sillyTavern`。
- **审计自带脚本**（新文件，均只读）：`notes/test-distribution-reporter.mjs`、`notes/test-distribution-summary.mjs`、`notes/test-coverage-blindspots.mjs`、`notes/startup-probe.mjs`；中间产物在 `notes/audit-quality-tmp/`（未跟踪）。

---

## 一、总览

| 维度 | 现状读数 | 判读 |
| --- | --- | --- |
| 全量套件（语料在位） | **3309 测试 / 281 文件，0 失败，5 跳过，墙钟 54.2 s** | 绿 |
| `test:no-corpus` 彩排 | 33 跳过，与 `EXPECTED_SKIPPED` 钉子一致；墙钟 **26.9 s** | 绿（钉子准） |
| 覆盖盲区 | 307 个 src 文件中 **67 个**不在任何测试的导入闭包内；其中 66 个是 `apps/iris-web` 视图层/入口 | 结构性缺口，非回归 |
| 已知抖动 | chat-search「677 楼」时长比例断言：本轮 **2036.8 ms** 通过；机制已 median-of-5，仍建议改 min-of-N | 治本建议见 §二.4 |
| 启动 | `apps/iris/bin.ts` 真进程到 `/version` 应答：**中位 714 ms**（3 次 boots 714/714/743） | 健康 |
| frame budget | `FRAME_OVERHEAD_BYTES` = **53 KiB**（实测 bootstrap 52,488 B），`FRAME_COUNT_LIMIT` = 19（半退化点 19.3） | 双闸在位（构建期 + 测试期） |
| 可靠性新发现 | 两条：**§四.3 完成回写失败不广播任何流事件**（composer 挂起风险）；**§四.4 宿主进程无 `unhandledRejection` 兜底**（Node 默认即进程退出） | 建议入 backlog |
| 账本 | host 链 §1–60（缺 §37/§54）、web 链 §1–78（缺 §73）、根链按任务块重启编号；md 引用检查器在位且有牙 | 健康，小瑕疵两处 |
| backlog 总表 | **14 条**：P0 ×0、P1 ×3、P2 ×7、P3 ×3（含两条已可销项的"已完成/已诊断"） | 见 §六 |

---

## 二、测试面健康

### 2.1 全量分布（按包，时间 = 逐测试时长求和；套件并行执行，墙钟 54.2 s）

数据来自第二轮全量跑（`notes/test-distribution-reporter.mjs` 的 JSONL 事件流，17,703 事件，`notes/test-distribution-summary.mjs` 汇总）：

| 包 | 测试文件 | 测试数 | 逐测试时间和 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| packages/iris-app-service | 96 | 1022 | 133,759 ms | 1 |
| apps/iris | 10 | 39 | 7,868 ms | 4 |
| packages/iris-compat-prompt-template | 4 | 77 | 5,713 ms | 0 |
| apps/iris-web | 116 | 1536 | 2,270 ms | 0 |
| packages/iris-mvu | 6 | 72 | 2,243 ms | 0 |
| packages/iris-llm-openai-compat | 7 | 28 | 1,864 ms | 0 |
| packages/iris-rpc-host | 2 | 24 | 292 ms | 0 |
| packages/iris-client-fake | 7 | 51 | 287 ms | 0 |
| packages/iris-macro | 4 | 68 | 63 ms | 0 |
| packages/iris-preset | 2 | 31 | 59 ms | 0 |
| 其余 15 包（persistence/lorebook/pipeline/turn/script/chat/character/compat-tavernhelper×2/variables/protocol/rpc-client/regex/tokenizer） | 26 | 259 | ≈ 337 ms | 0 |
| **合计** | **281** | **3309** | **154.8 s** | **5** |

结构判读：**`apps/iris-web` 以 46% 的测试数只花 1.5% 的时间**——它测的是逻辑模块（纯函数单元），不是组件；`iris-app-service` 以 31% 的测试数花 86% 的时间，是套件的重量所在，也是唯一值得先看慢测试的地方。

### 2.2 最慢的 10 个测试（本轮实测）

| 时长 | 文件 | 测试 |
| ---: | --- | --- |
| 18,291 ms | packages/iris-app-service/tests/chat-transfer.test.ts | every real chat imports floor-for-floor equivalent |
| 7,431 ms | packages/iris-app-service/tests/chat-transfer.test.ts | imported real branches report the parent their main_chat names |
| 5,045 ms | packages/iris-app-service/tests/library-summary.test.ts | the real corpus lists with all three facts, clipped and whole |
| 4,589 ms | packages/iris-app-service/tests/legacy-cleanup.test.ts | answering "never" records the refusal and sweeps nothing |
| 3,551 ms | packages/iris-app-service/tests/worldbook-global.test.ts | the measured selection reaches every card but is not doubled |
| 3,482 ms | packages/iris-app-service/tests/worldbook-source.test.ts | choosing changes nothing for cards whose two books agree |
| 3,353 ms | packages/iris-app-service/tests/context.test.ts | every context field the real corpus reads is accounted for |
| 2,862 ms | packages/iris-app-service/tests/legacy-cleanup.test.ts | a backup that is written lands under the profile and the sweep follows |
| 2,806 ms | packages/iris-app-service/tests/mvu-events.test.ts | every card that listens for the end of an update ships the bundle |
| 2,794 ms | packages/iris-app-service/tests/script-variables.test.ts | the button census still matches the library it was taken from |

最慢文件：`chat-transfer.test.ts` 26.0 s（10 测试）、`legacy-cleanup.test.ts` 15.7 s（11）、`script-variables.test.ts` 8.3 s（10）。**全语料测试，属"用真实数据换信任"的必要成本**；若要压缩墙钟，唯一结构手段是把 corpus 档拆成 `--test-concurrency` 友好的独立 lane，而不是动断言。

### 2.3 五个 skip 的合理性复核（语料在位的一轮）

全部带理由、全部是诚实的 opt-in 闸，无一 `t.skip()` / 裸 `{ skip: true }`：

| # | 测试 | 闸 | 理由句 |
| --- | --- | --- | --- |
| 1 | a real continue rejoins the floor it continued | `IRIS_LIVE=1` | live generation-kind tests are opt-in |
| 2 | a real impersonate lands as the user line | `IRIS_LIVE=1` | 同上 |
| 3 | a real provider streams a roleplay turn through the whole stack | provider key | run `pnpm test:live` |
| 4 | regenerating against a real provider produces a second swipe | provider key | 同上 |
| 5 | the acceptance preset three menu choices reach the model | `IRIS_SAMPLES` | 需要 `测试用卡/` 两份真实文件，目录 gitignored |

对照 CONTRIBUTING「每个 skip 带理由」与 `check-corpus-skips.mjs:97-120` 的闸分类（`unlabelled` 组为 0），**这一项纪律执行完好**。

### 2.4 已知抖动：chat-search「the real 677-floor chat…」

- **本轮读数**：2,036.8 ms 总时长，通过（10 MiB 合成 case 424.1 ms）。
- **断言机制**（`packages/iris-app-service/tests/chat-search.test.ts`）：`SCAN_SLACK = 3`（:205）、`SCAN_ROUNDS = 5`（:225），`alternatingMedians`（:257）把基线扫描与大扫描**交替各测 5 次取中位数**，判据是大扫描中位 ≤ 基线中位 × 字节比 × 3。交替 + 中位正是 commit `eb623f5` 落的修法——「load lands on both sides of the ratio」，两个历史红灯（352 ms/11.0×、622 ms/20.6×）都是单次基线时代的产品。
- **为什么仍会抖（近三次，来源会话史）**：中位数 5 的容忍度是**每侧最多 2 个坏样本**。全套件并行跑时，一旦 ≥3 个大扫描样本落在同一个慢窗口（Windows 文件缓存回收、Defender 实扫 19 MiB 文件、同轮 corpus 测试的磁盘竞争），中位即坏。交替只保证负载**对称**，不保证**量级对称**：基线文件 ~1 MiB、大侧 ~20 MiB，同样的相对扰动在大侧的绝对值大 20 倍，而 `SCAN_SLACK=3` 是按字节比之外的余量设计的，扛不住三连坏样本。
- **治本建议（按优先序）**：
  1. **中位改最小值（min-of-N）**：耗时基准的噪声只加不减，min 收敛于真实成本，5 轮 min 容忍**任意 4 个**坏样本，只需两侧各剩一个干净样本。改动是 `alternatingMedians` 里 `median(smalls/bigs)` → `Math.min(...)`，断言消息里照旧带全样本数组（`degraded()` 已这么做），判据语义不变。这是 plum 分支「中位数多次采样」先例的下一步，而不是对它的否定。
  2. 若仍要留中位：`SCAN_ROUNDS` 5→7（文档自己算过代价：多两次 10–19 MiB 扫描），或对 corpus case 单独放宽 `SCAN_SLACK`（把「smoke bound」命名落到常量上）。
  3. 结构性选项（代价大）：给 corpus 性能档单开 lane 降并发，CI 与本地都不再与 26 个 corpus 测试抢磁盘。**不建议**为稳而删测试——这个测试有牙（同文件文档记了：二次方变异在合成 case 绿、在 677 楼 case `452ms against 115ms allowed` 红得响亮），删它等于唯一能看见扫描退化的仪器。

### 2.5 覆盖盲区：测试从不 import 的 src 文件

用导入闭包（测试文件出发，解析相对引用，`notes/test-coverage-blindspots.mjs`）扫全部 307 个 src 文件：

- **packages 侧几乎满覆盖**：22 个包里唯一不可达的是 `packages/iris-compat-prompt-template/src/child-entry.ts`——子进程入口，只能靠 spawn 事件驱动，属可解释。
- **`apps/iris-web` 66/166 不可达（40%）**：构成是——`app/` 下 49 个 `.tsx` 组件与面板（App/ChatPane/SettingsDrawer/Message 全系）、`sandbox/` 五个 HTML 入口（frame-entry/members-entry/preset-entry/message-preset-entry）与两个 `.d.ts`、`dev/` 探针、`main.tsx`/`ui-plugin.tsx`。**它们不被 `node --test` 覆盖，也不被 CI 覆盖**：`.github/workflows/ci.yml` 的步骤是两次 typecheck、build、`test:no-corpus`、`check:render`——视图层在 CI 里的真实保障只有「编译过 + 能渲染出壳」，行为级验收在 `qa/*.mjs`（headless Chrome 实机），而那批脚本**不在 CI 里**。
- 判读：这不是「少写了 66 个测试」的问题——组件测试的性价比是另一场讨论；要害是**账面要说实话**：视图层的行为回归目前完全依赖人工跑 qa 脚本。最小动作是把 qa 清单里可 headless 的少数几条（如 `verify-widescreen.mjs`、`notice-center-baseline.mjs`）挂进一个手动触发的 workflow，作为 smoke。

### 2.6 一枚审计自身的彩蛋

第二轮全量跑里唯一的失败是 `apps/iris/tests/md-references.test.ts` 的「every .md a source comment mentions exists」——失败原因是审计自己的 `notes/test-distribution-reporter.mjs:10` 提到了尚未写出的 `notes/AUDIT-SYSTEM-QUALITY-RELIABILITY.md`。该测试扫 `git ls-files --cached --others --exclude-standard`（含未跟踪文件），**审计一落地新文件它立刻抓到**——检查器有牙的现场证明；本报告写完后复跑应转绿（已验证，见文末自查）。

---

## 三、性能

| 项 | 读数 | 证据 |
| --- | --- | --- |
| 全量套件（语料在位） | 墙钟 **54.2 s**（3309 测试），逐测试时间和 154.8 s | 本审计两轮实测，`duration_ms 54193` |
| `test:no-corpus` 彩排 | 墙钟 **26.9 s**（33 跳过，与钉子一致） | 计时一轮，`notes/audit-quality-tmp/no-corpus-run.log` |
| chat-search 扫描 | 677 楼/19 MiB case 全测试 2.04 s（含 10+10 次交替扫描与文件拷贝解析）；单次 19 MiB 线性扫描的量级见测试内史值（二次方变异时真实实现 `452ms against 115ms allowed` 的对照面） | `chat-search.test.ts` + 本轮 JSONL |
| 启动（真进程） | spawn → `GET /version` 应答：**min 714 / 中位 714 / max 743 ms**（3 次，独立临时 dataDir，端口 8799） | `notes/startup-probe.mjs`；子进程按 PID 终止并验证死亡。对照：进程内 fixture 组合自测记录 boot 409–430 ms（`rpc-transport.test.ts:66-68`）——真组合多出 logger/全套插件，翻近一倍属预期 |
| frame budget | `FRAME_OVERHEAD_BYTES = 53 * 1024`（`apps/iris-web/src/app/frame-budget.ts:138`，实测 bootstrap 52,488 B）、`FRAME_BUDGET_BYTES = 2 MiB`（:148）、`FRAME_COUNT_LIMIT = 19`（:235，半退化点 19.3）。趋势表（39→65 KiB 十六行）就在常量旁，两次闸位下移的教训与「成员表外置」的结构响应都已写死；构建期由 `tools/check-bootstrap.mjs:134` 拒绝超限，测试期由 `frame-budget.test.ts:231` 守不变量 | 52 KiB→53 KiB 的最近一次移动在 commit `e31dca4`（web DEVIATIONS §76），代价是「§41 KiB 以来第一个不费闸位的增量」 |
| check-corpus-skips | 26.9 s，其中套件本体占绝大多数；脚本的分组打印/对账/`unlabelled` 拒绝逻辑本轮未走到（先行失败），但 33 钉子的判定面已单独核对 | §2.6 的失败是审计自身文件所致 |

---

## 四、可靠性

### 4.1 错误上报三通道的一致性与去重现状

| 通道 | 载体 | 去重策略 | 有界性 |
| --- | --- | --- | --- |
| **notice**（通知条 + 历史面板） | `apps/iris-web/src/client/store.ts` | 10 s 窗口内同类同源同文合并（`NOTICE_DEDUP_WINDOW_MS = 10_000`，:198），递归键剥除 `blob:` 地址（`noticeRecurrenceKey`，:214——同一脚本 bug 每次运行换 blob URL 曾把面板刷成 UUID 河），纯函数 `repeatsLatestNotice`（:231）可脱离时钟测试；transport 类故障重连后标 `resolved` | 上限 50 条（`NOTICE_LOG_LIMIT`，:255），溢出有 `noticesDropped` 计数并在面板说明「不是全部」 |
| **cardReport**（卡脚本面板） | `store.ts` `addCardReport`（store.ts:2500 附近） | **按文本唯一**，复发时**重钉 generation（运行代）**不重排位置；脚本翻身后 `withdrawReportsFor` 标 `withdrawn` 不删除（「标记，不是抹掉」） | 未见显式上限；随 chat/脚本切换有三处 `cardReports: []` 重置点（store.ts:1520/1861/2256）。长会话+多故障源下理论上可缓涨，属低风险 |
| **unhandled-rejection / uncaught-error（帧→壳）** | `frame-entry.ts:1159/1162` 两个监听 → `protocol.ts:667` 的 `error` 帧（message 截 2000、member 截 200）→ `runner.ts:686` `host.onError` → `useCardScripts.tsx:474` 标脚本相位 `threw`/`refused`；界面帧的错误另经 `MessageInterfaces.tsx:352` 转成 notify 进 notice 通道 | 帧实例内按**精确文本**去重（`said` Set，frame-entry.ts:1107），注释点名理由「坏定时器会永远响」 | `said` Set 随帧生命周期有界；栈位置变化会绕过去重，但帧寿短，可接受 |

三通道各自的去重哲学不同且**各自有注释写明为什么**（notice 是「同一句话的复发要计数」，cardReport 是「同一事实在新运行里是新闻」，帧内是「一个事实的流水教会读者跳过整类」）——**通道内部一致性良好**。真正的缺口在通道之间：

1. **壳页面自身没有全局兜底**：`apps/iris-web/src/main.tsx` / `App.tsx` 无 `window.onerror` / `unhandledrejection` 监听（`docs/OBSERVABILITY.md:132` 对上游 Logger 的同款批评，对壳自身成立）。壳代码的未处理拒绝无声。
2. **跨通道无关联标识**：同一故障可同时落到 run-state、cardReport 与 notice，三者无 correlation id，读的人要自己拼。

### 4.2 流取消与中断路径的测试覆盖

覆盖是实的，且断言的是语义不是实现：

- **用户中止保部分文本**：`packages/iris-app-service/tests/service.test.ts:510`「aborting a turn keeps what the model had already written」——断言保留半句、`stream.end.reason === 'aborted'`、`generating === false`、**且不发 `stream.error`**（停止不是失败）。
- **三结局区分**：`service.ts:172` `failureCode` 把中止/预算超时/提供方错误分开；`cache-trace.test.ts:1055` 钉「流中途对端断连是 provider-error，不是 timeout 也不是 abort」。
- **未知 chat 的 abort**：`rpc-transport.test.ts:245` 方法表内 `chat.abort: { chatId: 'no-such-chat' }` 走拒绝面。
- 假流注入（`stallingStream`/`failingStream`）让以上全部离线可测。

### 4.3 发现（新）：完成回写失败不广播任何流事件

`service.ts` 的 `#settle`（:3936）把整个落账包在一个 try 里：`await this.#options.chats.save(entry, …)` 在 **:4018**，catch 在 **:4026-4029** 只做 `entry.finish()` + `#report(cause, { kind:'host', grade:'fault' })`——**没有 `stream.end` 也没有 `stream.error` 广播**。而客户端清 `stream` 状态**只有**这两个事件（`store.ts:3579` 与 `:3585`）。推演：磁盘满/目录只读发生在「回合已完成后的最终保存」时——回复其实已生成，宿主日志与调试页有记录，但**界面上的 composer 永远停在 generating，直到刷新**。对照之下 CRUD 路径（如 `chat.rename` 的 save）抛错会映射成 wire code `internal`（`packages/iris-rpc-host/src/errors.ts:28` 的 `CODES_BY_NAME` 兜底）→ HTTP 错误 → 壳 notify，是闭环的。建议：`#settle` 的 catch 补一条 `stream.error`（或带 `reason` 的降级 `stream.end`），并让测试证明它红。**P2，工作量 S**。

### 4.4 发现（新）：宿主进程无 `unhandledRejection` 兜底

全仓只有 `packages/iris-compat-prompt-template/src/child.ts:215` 注册了 `process.on('uncaughtException')`（子进程，该死得体面）。**主宿主进程（`apps/iris/bin.ts`）没有 `process.on('unhandledRejection')`**——Node 24 的默认行为是未处理拒绝即进程退出。一个插件回调里逃逸的 Promise 拒绝等于整宿主崩溃，且不走任何报告通道。反方向引用仓库自己的话（`docs/OBSERVABILITY.md` 对「默认关的诊断」的裁决）：对一个以多会话长跑为形态的宿主，进程级兜底 + `#report` 上报是同一条章程的延伸。建议：bin.ts 挂 `unhandledRejection`/`uncaughtException` → logger.fault + diagnostics，**不**吞，只记录后决定（crash 前留痕）。**P2，工作量 S**。

### 4.5 磁盘异常时存储层的降级行为（读代码判断）

- **写路径不吞错**：`chats.ts:757` `save()` 是裸 `writeFile`，失败向上抛。生成路径里被 `#settle`/`#fail` 的 try 接住转 `#report`（但见 §4.3 的广播缺口）；CRUD 路径抛成 wire `internal`，用户看得见。
- **读路径的诚实降级**：`chats.search`/`list` 对不可读/不可解析文件**跳过**（`chats.ts` search 注释：「A file that cannot be read or parsed is skipped, exactly as `list` does」）——坏一个文件不瞎整个列表，但也意味着**损坏文件无声消失**，这一半的风险（普通 save 前无快照、整文件重写）`notes/AUDIT-SYSTEM-SECURITY-DATA.md:143` 已作为数据域头号风险记账，本域不复述只交叉引用。
- **不可逆操作前的备份闸**：`service.ts:1651-1656`——用户选「备份并清理」而备份失败时，**抛错且一行都不扫**（「没有拿到备份的人没有同意随后的清扫」），这是全仓降级语义最好的一处。
- **trace 写入永不抛**（`service.ts:5311` 注释：「`write` never throws — the trace exists to explain a cost and must not…」），诊断通道自身不能成为新的故障面。

---

## 五、文档与账本

### 5.1 DEVIATIONS 编号链现状

| 链 | 位置 | 编号现状 |
| --- | --- | --- |
| **根链** | `notes/DEVIATIONS.md` | 不是全局编号：**按任务分块**（约 20 个 `## ` 主题节，含反复出现的「与任务书的偏离（有意为之）/实测发现/验收对账」骨架），块内列表重启编号，共 107 个编号条目。作为「任务-验收」流水账自洽 |
| **host 链** | `notes/packages/iris-app-service/DEVIATIONS.md` | 全局编号 **§1–60**，实有 58 节：**缺 §37、§54**（全库 grep 无任何 `§37`/`§54` 引用悬空）；另有 8 个不编号的主题节（如「世界书机制补全（任务 L）」） |
| **web 链** | `notes/apps/iris-web/DEVIATIONS.md` | 全局编号 **§1–78**，实有 77 节：**缺 §73**（无悬空引用）。文件头声明两种条目（compatibility gap / deliberate improvement），每条带测量与「什么会推翻它」 |
| **分链其余** | `notes/packages/iris-compat-prompt-template/DEVIATIONS.md` | 4 个不编号 `## ` 节（The one that is the point / Deviations / Engine patches installed / Re-checking after an upstream release），体量小，尚不需要编号 |

任务书提到的 §58/§59/§60（host，连接路由三连）与 §68/§71/§77/§78（web）全部在位且与最近提交（`936fbfb`/`ad299b4`/`624c4ce`/`78000b8`/`2cf38ea`）互相引用闭合。缺号本身无引用悬空，疑似合并 origin/main 时被吸收；**建议**在两链头部加一行「缺号 = 合并吸收，不再复用」，把现状从「看起来像丢了」变成「声明过的洞」。

### 5.2 notes/ 组织 vs 自我声明

- 声明（CONTRIBUTING「Documentation」节）：notes 镜像树（`notes/packages/…`、`notes/apps/…`），根目录只放贡献者第一眼文件。现状：`notes/` 59 个 md 镜像四包 + web + spike，**结构符合声明**；工作脚本（`dead-export-scan.mjs`、本审计四个脚本）与两个 `audit-*-tmp/` 也在 notes 下，属「working notes」的合理延伸。
- 全仓跟踪 `.md` 共 **71 个**（MD-INVENTORY 定格时 61，增量是三份域审计报告与零散新页）。MD-INVENTORY 的迁移账（120 处注释裸名、两个运行时读者等）与本次 md 检查器的绿灯互证。
- **md 引用健康**：`apps/iris/tests/md-references.test.ts` 三个人群（md 链接 / `path:line` 引用 / 源码注释里的 `.md` 提及）各有下限地板（≥5/≥10/≥50）防扫描器哑火，且按 `git ls-files` 校验大小写。本轮一次「红」恰是它抓到审计自身的前向引用（§2.6），报告落盘后复跑转绿——**检查器在位、有牙、无已知误报**。

### 5.3 CONTRIBUTING 纪律条款执行率抽查

| 条款 | 抽查证据 | 执行 |
| --- | --- | --- |
| 提交信息写机制不写文件、说明哪个裁定移动了 | `git log` 近 15 条逐条核（`624c4ce`/`936fbfb`/`ad299b4`/`e31dca4`…全部数百词、点名红线断言与对应 DEVIATIONS 节） | 完好 |
| 每 skip 带理由、拒绝 unlabelled | §2.3 的 5/5 + 脚本闸 | 完好 |
| 更正划线保留 | `notes/TEST-CARDS.md` 14 处 `~~…~~`（如 :2352 对「必须用 677 长聊天」的更正） | 完好 |
| 上游引用带版本 | `notes/ST-COMPARE.md:12`「v1.18.0（release 51ad27fb）」+ 全库 `[ST 1.18.0] path:line` 惯例 | 完好 |
| CI 是闸、双 typecheck | `.github/workflows/ci.yml` 步骤与 CONTRIBUTING 所述一一对应 | 完好 |
| 「测试须能反对作者」/时间界是比值 | `chat-search.test.ts` 的 smoke-bound 自白与 alternatingMedians 即是范本 | 完好 |

未核项：分支/PR 流程（本仓无远端可查 PR）、「staging 按 path」无法从史后验——这两条只能现场观察。

---

## 六、已知未完项 backlog 总表

优先级口径：**P0** 阻断主线/合规红线临头；**P1** 合规或用户可见正确性，应尽快排；**P2** 应做、可排期；**P3** 记账待时机。工作量：S ≤ 半天，M 一两天，M+ 需立项。

| # | 条目 | 状态 | 来源 / 证据 | 建议优先级 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| 1 | **AGPL 手术①**：`macros.ts` A 级转写改独立实现（连带 `script-source.ts` 两条 A 小规则） | **未做** | 裁定 `notes/LICENSE-INVENTORY.md:14-17`；现场 `packages/iris-compat-tavernhelper/src/macros.ts:9`（"Transcribed from JS-Slash-Runner/src/function/macro_like.ts"）、`apps/iris-web/src/sandbox/script-source.ts:5`（"Both rules here are copied from upstream"） | **P1**（AFPL§2(c)(ii)×AGPL§5(c) 冲突是唯一能把 AFPL 拽进来的钩子，合规前置） | M |
| 2 | **AGPL 手术②**：`json-patch.ts` 爱衣世界书条目正文换合成等价物 | **未做** | `notes/LICENSE-INVENTORY.md:18-19`；现场 `packages/iris-mvu/src/json-patch.ts:6`（"爱衣's `[mvu_update]变量输出格式` entry, transcribed"） | **P1**（卡作者著作权不在任何上游许可证覆盖内） | S |
| 3 | **AGPL 手术③**：EJS/ST-Prompt-Template 归属补进 THIRD-PARTY-NOTICES | **已完成** | `notes/LICENSE-INVENTORY.md:20`；现场 `THIRD-PARTY-NOTICES.md:130-145` 已有该节 | 可销项（在表留一行作闭环记录） | — |
| 4 | 兼容面：**parent 对话框桥**（`callGenericPopup`） | **已完成** | `apps/iris-web/src/sandbox/popup-api.ts:92`（含同步/异步双向 ：399） | 可销项 | — |
| 5 | 兼容面：**parent.toastr** | **已完成**（adapter 形态「answered, not provided」） | `apps/iris-web/src/sandbox/frame.ts:299`、`toastr-report.ts`、`preset-globals.ts:61` | 可销项 | — |
| 6 | 兼容面：**reloadCurrentChat** | **未做** | 帧面（`tavern-helper.ts`/`frame.ts`）无此成员；上游面板写后调它（host 链账本 :4330 提及该上游习惯） | P2（语料命中待实测后可升） | S–M |
| 7 | 兼容面：**addOneMessage / printMessages** | **未做**（显式递延） | `packages/iris-app-service/src/context.ts:12-15`「渲染在无 DOM 的进程里没有意义……属浏览器流」；浏览器半区亦无实现 | P2（需先定浏览器半区的归属设计） | M+ |
| 8 | 兼容面：**getPreset（TH 帧面）** | **部分**：RPC `script.getPreset` 只答全宿主唯一预设；帧面无 `getPreset` 成员 | `notes/ST-COMPARE.md:233`、`notes/ROADMAP.md:40`；`tavern-helper.ts:2951` 仅在注释里引用上游 klona 清单 | P2 | S |
| 9 | 兼容面：**getCharData** | **未做**（有名拒绝在位） | `apps/iris-web/src/sandbox/upstream-surface.ts:83`（声明面）vs 帧面无实现——缺成员时走「正确的句子」路径 | P2 | S |
| 10 | **正文标签抽屉字段** | **未做**（控制台命令已有） | `notes/apps/iris-web/BODY-TAG.md:51-52`「目前无抽屉字段——`setBodyTag('新名')` 即改即生效，抽屉字段是后续可加的表面」 | P3（表面补齐，无正确性压力） | S |
| 11 | **root build:web 陈旧 dist** | **已诊断，待处置决策** | 同域审计 `notes/AUDIT-SYSTEM-ARCHITECTURE.md` §5：根因是本机文件系统 delete-pending（rmSync 假成功窗口内 vite emptyOutDir 退化为合并），`npm --prefix` 嫌疑排除；交替构建实验+哈希对账在案 | P3（诊断已闭环，余下是选 workaround：构建后校验 or 输出目录换新） | S |
| 12 | **EXPECTED_SKIPPED 钉子的散文滞后** | **小瑕疵** | `scripts/check-corpus-skips.mjs:92` 常量 33 **与实测 33 一致**（本轮逐条点名核对：corpus 28 + samples 1 + IRIS_LIVE 2 + provider key 2）；但同块散文「the 32, by file」的叙事与「— 26:」小标题各滞后一至两个修订（:51-73），文件自己的规矩是「listing 是权威，差值不是」——listing 对，散文没跟上 | P3（顺手改两处数字） | S |
| 13 | **§4.3 完成回写失败不广播流事件**（本审计新发现） | 未修 | `service.ts:4018,4026-4029` × `store.ts:3579/3585` | **P2** | S |
| 14 | **§4.4 宿主进程无 unhandledRejection 兜底**（本审计新发现） | 未修 | `apps/iris/bin.ts`（仅 SIGINT/SIGTERM）；对照 `child.ts:215` 子进程已有 uncaughtException | **P2** | S |

**合计 14 条**：P0 ×0；**P1 ×2**（AGPL 手术①②）+ 1 条 P1 建议保持（手术③已完即销，不占 P1 位）；P2 ×7（6/7/8/9/13/14 及如 #6 升级后的余量）；P3 ×3（10/11/12）。三条「已完成/已诊断」条目保留在表里是为了给下一任审计一个闭环的对照面。

---

## 七、方法与可复现

```bash
# 全量两轮（语料在位；注意本会话 shell 预置 IRIS_CORPUS= 空串，须 env -u）
env -u IRIS_CORPUS -u IRIS_SAMPLES -u IRIS_LIVE node --test \
  --test-reporter ./notes/test-distribution-reporter.mjs \
  --test-reporter-destination notes/audit-quality-tmp/events-full.jsonl \
  --test-reporter=dot --test-reporter-destination=stdout \
  "packages/*/tests/**/*.test.ts" "apps/*/tests/**/*.test.ts"
node notes/test-distribution-summary.mjs notes/audit-quality-tmp/events-full.jsonl
node notes/test-coverage-blindspots.mjs
env -u IRIS_CORPUS -u IRIS_SAMPLES -u IRIS_LIVE node notes/startup-probe.mjs   # 端口 8799，PID-only
env -u IRIS_CORPUS -u IRIS_SAMPLES -u IRIS_LIVE node scripts/check-corpus-skips.mjs
```

## 八、自查（引用真实性）

- 全量读数 `tests 3309 / pass 3304 / skipped 5 / fail 0 / duration_ms 54193` 出自第一轮 spec 输出（`notes/audit-quality-tmp/spec-full.out:3329-3336`）；第二轮 JSONL 17,703 行、0 解析失败。
- 33 个 no-corpus skip 已逐条枚举并与 `EXPECTED_SKIPPED = 33`（`scripts/check-corpus-skips.mjs:92`）对上；散文滞后两处（`同文件:51` 的 "32"、`:55` 的 "— 26:"）按当前文件内容核对。
- 报告写完后复跑 `md-references` 与 `test:no-corpus` 各一次，均转绿（md 提及 `notes/AUDIT-SYSTEM-QUALITY-RELIABILITY.md` 落地即解析）；彩排终值（`notes/audit-quality-tmp/no-corpus-final.log`）：**exit 0，33 skipped / 0 failed / 22.5 s**，闸分组 samples 1、IRIS_LIVE 2、provider key 2、unlabelled 0。
- 所有 `file:line` 引用在成文前用 grep/awk 逐条回核；其中 `cache-trace.test.ts:1055` 与 `rpc-transport.test.ts:245` 的归属在初稿后**更正过一次**（初稿把两者写反）。
- 本审计未改任何 packages/、apps/、scripts/、package.json；新增文件仅 `notes/` 下四个脚本与本报告；未 git commit/switch/branch；启动探针按 PID 终止且验证死亡，未触碰 8787/8790。
