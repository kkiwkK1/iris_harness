# QA-REPORT — 合并版六卡回归验收（dev/qa-6cards）

- 基线：`dev/iris-exploration` @ `d5d0418`（含渲染/沙箱两项合并修复）
- 日期：2026-09-04；执行：任务 D 验收代理
- 宿主：worktree 内独立进程，`IRIS_PORT=8792`，数据目录 `wt-qa/apps/iris/data`（与主检出隔离）；
  LLM `https://api.deepseek.com/v1` / `deepseek-v4-flash`。进程 PID 手工记录（7792 → 修复后重启为 43273），全程未按名/端口杀进程。
- 浏览器：headless Chrome + 原始 CDP，每卡独立 profile，`chrome.kill()` 只杀自己 spawn 的句柄。
- 真对话：每卡一轮（另有一轮用于验证下述修复①，共 7 轮）。
- 工具与原始读数：`qa/*.mjs`（本分支），逐卡 JSON 在 `qa/results/`（未提交，工作区留档）。

## 每卡一行结论

| 卡 | 文件 | 结论 |
|---|---|---|
| 灭仇家满门之后，我收养了想对我复仇的孤女 | 2.1.0.png | **通过**。开场白 16013 字完整入库；状态栏帧 710×489 稳定；一轮对话 4s 完成、回复贴卡；MVU `initialized_lorebooks`+`stat_data` 初始化；零新增 fault、零横幅 |
| 哈人冰恋世界 | 1_5.png | **通过（带已记录项）**。开场白 40573 字；状态栏帧稳且有数据（见基线核对）；MVU 初始化；对话 2s 完成回复贴卡。残留三条已记录项（投影仪跨帧 / npoint.io 预期拒绝 / 重开时开场白脚本世界书断言失败） |
| 绿茵好莱坞 | 2.png | **通过**。开场白 9741 字；「新秀注册档案」帧 710×1458 稳定、79 个可见盒子有数据；对话 3s 完成回复贴卡；`stat_data` 9 个分支合理；cloudfront 拒绝为设计内具名拒绝 |
| 不要被神隐挑战 V1.5.4 测试版 | V1.5.4_.png | **通过（带已修复项）**。SCRIPT-DOM 族：零槽位帧属设计，论坛覆盖层在脚本帧内渲染（48 个可见盒子、584 字文本，全屏表面）；`stat_data` 12 个分支；回复为论坛体贴卡文本。首轮发现 `{{user}}` 未展开直达 provider 的 prompt fault——**已修（修复①）**，复跑零 fault |
| 尸变纪元 v0.5（NSFW） | v0.5NSFW.png | **通过**。开场白 11529 字；帧 710×1847 稳定；回复 2767 字贴卡（含卡自己的状态栏 HTML 与 MVU patch，形状正确）；MVU 初始化 |
| 人偶演出Lights ON！⭐ | Lights_ON.png | **对话/MVU/诊断通过；问候帧回归为已知问题，修复中**（wt-lights，另行提交）。本场复现：开场白 30188 字含完整 HTML 文档，槽位存在但 0 个 iframe、无错误横幅。本轮不重复修 |

## 基线核对

- **哈人冰恋状态栏帧**：稳（5 次采样 × 1.5s 尺寸不变）且有数据（状态栏文本、48 个可见盒子）。任务书的 804×776 是**窗口尺寸**的函数：帧宽随阅读栏宽（1400 窗口→710px，1680 窗口→898px），帧高为内容回声（两种宽度下均 482px 稳定）。不是闪烁、不是回归。
- **不要被神隐挑战全屏论坛开场页**：覆盖层在脚本帧内出现（模态设计，点「进入论坛」进入）。本轮未点击进入（基线已裁为设计），覆盖层挂载与渲染本身正常。
- **非卡文件具名拒绝**：`00004-*.png`、`00043-*.png` → `invalid-request: …no "ccv3" or "chara" tEXt chunk`；`liwy.jpg` → `"liwy.jpg" is not a .png or .json character card`。全部具名、全部拒绝。✅
  - 口径说明：语料目录在会话开始后少了 `00043-409781020.webp`（01:33 在、01:47 起 ENOENT，非本代理所为），故非卡样本实测 3 个。
- **Lights ON 问候帧**：复现为「槽位在、0 iframe、无错误提示」的静默回归，与 wt-lights 正在修的内容一致，本轮记录不修。

## 已修复（本分支，带测试）

1. **脚本注入的提示词宏未展开**（`packages/iris-app-service/src/service.ts`）
   - 现象：神隐卡的引擎 `injectPrompts` 注入的提示词带 `{{user}}`，原样送达 provider；宿主自己的残留宏判卷给出 fault 级报告（"Iris implements these, so the expansion did not reach that text"）。
   - 根因：`injectedContributions()` 用 `injection.value` 原文装配，绕过了 `buildPrompt` 那条路上每份贡献都过的 `entry.substitute`。
   - 修法：装配时以该聊天的展开器展开注入文本；存储值保持原文（改名/变量写入下轮即生效）。
   - 测试：`tests/injection.test.ts`「an injection's macros are expanded at assembly, not sent as braces」；端到端：重启宿主复跑同卡同引擎，整回合零 prompt fault。
2. **`document.nodeType` 被拒**（`apps/iris-web/src/sandbox/virtual-document.ts`）
   - 现象：哈人冰恋/绿茵好莱坞共用的开场白2.0.1 组件 duck-type 读 `document.nodeType`，被判 `UnsupportedApiError`，横幅按脚本失败呈现。
   - 根因：本文件已确立「reads answer」政策（readyState 即先例），`nodeType` 是纯读常量（文档恒为 9），落在漏网之列。
   - 修法：读成员补 `nodeType: 9`。测试更新于 `tests/virtual-document.test.ts`；重建后横幅消失（已复检）。
3. **每次加载必打的 `/favicon.ico` 404**（`apps/iris-web/index.html`）
   - 无图标声明 → 每次页面加载一个 404 console error，混在需要被信任的报告旁边。补 `<link rel="icon" href="data:,">`，测试 `tests/shell-page.test.ts`。修复后复检：404 不再出现。

## 已记录（根因假说 + 复现步骤），不修

1. **投影仪脚本跨帧访问失败**（哈人冰恋世界；每开一次聊天必现一条）
   - 读数：`Blocked a frame with origin "null" from accessing a cross-origin frame. at blob:null/…:131:3`。
   - 根因假说：投影仪脚本要够另一帧的 `window.addEventListener`；不透明源帧互相隔离是本沙箱的核心设计，上游同源 ST 页面则天然放行。修它 = 改帧隔离策略，架构级。
   - 复现：导入 → 授脚本 → 打开任意该卡聊天；通知区即现。
2. **重开聊天时开场白2.0.1 断言「世界书不存在：哈人冰恋世界v2.0（本脚本不会自动创建/绑定）」**
   - 读数：仅在**重开已有聊天**时出现；首开新聊天的一轮不触发。状态栏（正则路径）与 MVU 不受影响，卡的可交互开场表单功能降级。
   - 已证事实：宿主侧 `worldbook.load('哈人冰恋世界v2.0')` 正常返回全书；卡脚本走 `window.parent.getWorldbookNames ?? window.getWorldbookNames`，实测**两种帧里 `typeof getWorldbookNames` 都是 undefined**。
   - 根因假说：上游 TavernHelper 把函数发布在 ST 页面 window 上（`window.parent.X` 通道，TEST-CARDS §七之四）；Iris 的 TH 面只活在帧内上下文，不发布到 shell window，该卡的名字解析链两头落空。属结构性差异族，修法是面架构决策。
   - 复现：导入 → 授权 → 开聊天 → 返回列表 → 从 Reading 重新打开同聊天；约 12s 后通知区出现。
3. **`fetch('/version')` 404**（所有 MVU 卡；每聊天 2 条）
   - MagVarUpdate bundle 开场即 `fetch('/version')`；同源桥按设计把请求交给 shell，宿主没有该路由（上游 ST 有）。卡全部容忍（所有 MVU 初始化成功），纯 console 噪声。修法（实现路由或在桥上作答）是产品决策，QA 不代答。
4. **预期内的具名 CSP 拒绝**（不是缺陷，验收判据要求点名）：`api.npoint.io (connect-src)`（哈人冰恋世界配置）、`d1j1y3gb82cpmr.cloudfront.net (media-src)`（绿茵/神隐图片）。与 TEST-CARDS §五 的预期拒绝清单一致。

## Harness 形态读数（防误读）

- `run X ended, but no injection on this chat ever named it` / `N script injections are still live`：note 级，语义见 `store.ts:316`（runId=`chatId:generation`，宿主按 chat+id 对查）。由「浏览器硬切不优雅收尾 / 宿主重启后客户端仍持旧 runId」触发，非卡缺陷、非合并回归。
- 神隐验证轮出现一次 240s 事件超时：该卡引擎会嵌套发起 LLM 生成，单回合延迟 3s～4.7min 波动；回复最终完整落盘（4217 字）。对话轮自身的 `stream.end` reason=completed 在常规轮次均按时到达。

## 测试与提交

- 全仓库 `pnpm test`：1944 项，0 失败、3 跳过（语料依赖项）（含本分支新增/更新的 3 处测试）。
- `qa/` 下的脚本（导入、逐卡验收、render-only、CDP 探针）随本分支提交；`qa/results/`（逐卡 JSON、截图）与提取的卡脚本正文留工作区不入库——后者是卡内容，TEST-CARDS 纪律不入档。
- commit 不 push。
