# NOTES-handoff — 任务 B（渲染生命周期）留给任务 A 的交接

写给正在改 `frame.ts` document shim / fetch 面与 `srcdoc.ts` CSP 的开发。
本文件只写**我测到、但按纪律没有动你那两段**的事实，每条都带可复现的观测方法。
工作分支 `dev/fix-render`（worktree `wt-render`），以下发现全部在 8792 独立宿主 + 真卡上验证过。

---

## 1.（fetch/注入面）脚本帧里 MagVarUpdate bundle 长时间不发布 `Mvu`

**现象**（2026-09-03，8792 宿主，`1_5.png` 哈人冰恋世界）：
- 卡脚本 4 条全部 enabled，`setScriptsAllowed(true)` 后开聊天；
- 脚本帧（overlay surface，`data-iris-interface` 为否的那只 iframe）启动正常：`DIV#tavern_helper` 建好、成员表面在（`typeof getAllVariables === 'function'` 为真）；
- 但开帧 **25 秒后** 脚本帧里 `typeof Mvu` 仍是 `undefined`；
- 宿主日志里**没有** bundle 代理取数记录（grep `jsdelivr`/proxy 零命中）；
- 卡的 MVU 脚本全文只有一行：`import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'`（90 B，在 allowlist 内）。

**推断**：import 没有走到代理（没有取数记录），也没有报 import 超时（面板应有 `import timed out` 行，我没进到报告抽屉确认）。两个候选：① `rewriteBundleImports` 的改写没命中这个 URL（多行单 import、无分号结尾等形态）；② 脚本帧的模块求值在更早的地方停了。**这决定了 stat_data 何时才有真值**——B 任务只修了消息帧"有变量就能画"，变量初始化仍依赖 bundle 在脚本帧跑起来。

**复现**：导入 `测试用卡/1_5.png` → 开新聊天 → CDP 附到 `about:srcdoc` iframe target，对脚本帧上下文求值 `typeof window.Mvu`；同时看宿主日志有无代理取数。

## 2.（CSP 面）Lights ON 问候卡的字与图都被默认策略拒掉，字体迟换加重了高度抖动

`Lights_ON.png` 的 WIKI 问候文档引用：
- `https://fontsapi.zeoseven.com/925/main/result.css`（`<link rel="preload" as="style" onload="this.rel='stylesheet'">`）
- 图片在 `img.remit.ee`。

两者都在 allowlist 外：样式被 `style-src` 拒、图被 `img-src` 拒（`securitypolicyviolation` 有报，行为符合设计）。**要交接的不是放行**，而是一个副作用：`onload` 换 rel 的手法在 CSS 被拒时永远不触发，页面先用回退字体排版、卡片自己的 8px 像素字体永远不来——行高在加载后突变，正好落在 B 任务修掉的高度回路里当扰动源。若将来评估字体默认放行（像 googleapis 那样的第三类默认），这个域是语料里第一个真用到的。

## 3.（无关你那两段、但需要你知道的边界变化）

- `frame.ts` 的 interface-frame 安装块新增了 `Mvu` 表面（发布进 window globals 与 virtual parent 两个袋），`waitGlobalInitialized('Mvu')` 由此在接口帧即时决议。它**只**在 `env.interfaceFrame === true` 分支，脚本帧路径零改动（`sandbox-frame.test.ts` 有两条测试钉住两端）。你改 document shim 时如果重排安装块，注意别把这段挪进 run 路径。
- bootstrap 因此长了约 100 B，`FRAME_OVERHEAD_BYTES` 已按 `tools/check-bootstrap.mjs` 的指示 43→44 KiB（`frame-budget.ts`，gate 20 的不变量重算过仍成立，表格已补一行）。
- `srcdoc.ts` 的 CSP 本任务一字未动。

## 4. 观测工具留下（scratchpad/，未入库）

- `scratchpad/cdp-attach.mjs` — CDP 附着 `about:srcdoc` iframe target 直接读帧内部（`--site-per-process` 才有 iframe target）；shell 侧同时采样 `.iris-interfaces__slot iframe` 盒高序列。
- `scratchpad/measure-loop.mjs` — 用真 `heightSignal` 闭环模拟，输出高度写回时间序列（修复前后对照）。
- headless 注意：rAF 在 headless 里会被节流到近乎停摆，消息帧的高度报告在强制出帧（`Page.startScreencast`）前几乎不动——**live 闪烁复现要在有头浏览器做**，headless 只能看到回路的中间停留态。
