# 任务 C 交接文档 —— ST-Prompt-Template P3 兼容试点

日期：2026-09-13。分支：`dev/st-compat-pilot`（worktree `D:/workspace/小项目/iris-st-compat-pilot`），基线 C_BASE = `f8830f71a`（A+B 最终联合门；本分支已于 2026-09-13 重放到该基线）。**主链路已在真实浏览器中打通：UC-1 全部 4 步、UC-2 全链路验证通过；UC-3 有一个已知缺口**。本文写给接手人：现状、已踩平的坑、剩余工作与操作手册。

## 1. 当前状态总览

| 项 | 状态 |
| --- | --- |
| UC-1 生成前模板展开 | ✅ 步骤1（70→朋友）/ 步骤2（10→警惕）/ 步骤3（停用=零桥接轮、原文落层、聊天不中断）/ 步骤4（重启用逐字节一致）全部浏览器实证 |
| UC-2 回复驱动变量 | ✅ setvar 执行、楼层文本剥离模板、floorVars 持久化到宿主楼层变量表（10→20→80），停用期冻结、重启用不重放 |
| UC-3 设置面板 | ⚠️ 槽位注册成功（`data-iris-st-ext-section` 出现在设置面），但投影 iframe 内容为空（竞态），中英文/键盘/停用清理未验 |
| ST 1.18.0 对照 | ❌ 未做 |
| 验收报告 | ❌ 未写（材料齐全，见 §5） |
| 测试门 | ✅ 根 tsc 0 错；34 包测试 + 14 web 测试全过；全仓 4015 pass（接线提交时点） |

## 2. 架构一句话

原版 `dist/index.js`（零字节修改）作为 ES module 载入专用沙箱 iframe；宿主路由 `/iris-st-ext/<id>/<rev>/` 同树服务**真件**（安装树）+ **门面**（17 个构建产物，路径=URL 契约）；内核（共享 chunk）经 postMessage 与壳 plane 中继；宿主在 `#contributions`/`#previewItemization`/`#settle` 三点调桥（arm/submit，未武装=零开销直通）。

## 3. 已踩平的坑（重要！回归时先查这里）

1. **CSP connect-src**：沙箱 null-origin 帧里 `'self'` 永不匹配 → 帧内所有 fetch 死亡 → 上游 init 饿死。扩展帧 CSP 必须把 connect-src 拼成显式 origin（`srcdoc.ts` 的 `policy.replace`）。症状：ready 发了但 `EjsTemplate` 永不发布。
2. **rollup `preserveEntrySignatures: 'strict'`**：缺省时门面入口被 tree-shake 成 `import "./events.js"` 空壳，上游拿到 undefined（症状：`reading 'before' of undefined`，来自 DEPTH_MAPPING 顶层求值）。
3. **门面输出布局=URL 布局**：入口必须在 outDir 根（`entryFileNames: '[name].js'`），否则 chunk 相对引用越过 rev 段 → 路由 404。
4. **缓存**：门面/vendor 必须 no-cache（内容随应用构建变，rev 只锁上游真件）；manifest 带 `build` 戳，模块 URL 追加 `?build=`，防旧 immutable 缓存投毒。**改了门面必须全量重建**（`npm run build`，含 rm -rf dist/st-ext），只跑 build:st-ext 或只跑 vite build 都会出现 dist 半新半旧。
5. **`getGroupMembers` 必须同步**：上游 `for…of` 直接遍历返回值，async 返回 Promise 不可迭代 → 每个生成轮在 handler 内抛 `not iterable`（被总线吞掉 → 无展开的静默失败）。同类风险：所有上游同步迭代的门面。
6. **seed 必须停用 mvu**：MVU 的 init/replay 会覆盖楼层变量表（违反“一个功能一个活动实现”前置）。seed.mjs 已加 `plugin.disable mvu`。
7. **extensionId 选择**：`plugins.find(installed)` 会命中 tavern-helper；必须排除内置（index.ts 已修）。
8. **调试可视性**：内核已具备 probe 信封（`{irisStExt, type:'probe'}` → 返回 kernelInstances/ejsPublished/settingsDom）、uncaught error/rejection 上报、bus.onHandlerError 钩子。查帧内问题先打 probe。

## 4. 剩余工作（按序）

1. **UC-3 投影修复**（预计小改）：`plane.tsx` 的 `StExtensionSettingsSection` 在 mount 时调 `requestSettingsProjection`，若扩展帧未就绪则竞态落空。改法：mount 时若投影为空则重试（或在 `settings-html` 到达后若 section 已挂载主动推送一次）。然后验证：面板出现、中文（zh-cn 译文 via `data-i18n`）、切英文回落原文、键盘可达、停用后 section 消失、卸载数据保留。
2. **证据固化**：UC-1/2 每步已有浏览器实证（对话记录 + bridge-result 捕获 + 宿主 script.getVariables 读数），按 `notes/st-compat/pilot-use-cases.md` §记录要求整理成结构化证据段。
3. **ST 对照**：同输入在 `E:/sillyTavern/SillyTavern`（51ad27fb8 + 扩展 f9a07da）展开结果对照，记录逐字节一致或差异说明（角色数据只记结构与哈希）。
4. **验收报告** `notes/st-compat/PILOT-REPORT.md`：UC 逐条判定 + 偏差表（至少含：messageFormatting 退化为 HTML 转义、WI 条目不水合（getwi 空）、slash 命令注册惰性、token 计数为估计值、saveChatConditional no-op、tokenizers 估计）+ 门记录。
5. **中央接线说明**：接线已在 `0ea6eb3` 集中提交，报告里逐项列出（service.ts 三桥点、index.ts 组装、paths、adoptDefinition、protocol 5 RPC + 1 事件、store/plane/槽位、rpc-transport probes、NOTICES jQuery/lodash 行）。
6. **末次提交前全门**：`pnpm exec tsc -p .`、`node --test "packages/*/tests/**/*.test.ts" "apps/*/tests/**/*.test.ts"`、`npm --prefix apps/iris-web run build`、浏览器三 UC 复跑。

## 5. 操作手册（验收环境）

```bash
# 终端1：起宿主（先杀 8799 旧进程）
cd D:/workspace/小项目/iris-st-compat-pilot
node notes/st-compat/acceptance/seed.mjs
# 等 "SEED COMPLETE"，记录 CHAT_ID；日志含 provider 端口
# 终端1 保持运行；Dispose：向进程 stdin 写 dispose 或 taskkill

# 浏览器：开 http://127.0.0.1:8799/ → 打开 Pilot 卡对话 → 发消息
# 宿主权威读数（另开终端）：
node notes/st-compat/acceptance/itemize.mjs "<CHAT_ID>"   # itemize 概览
node notes/st-compat/acceptance/check.mjs "<CHAT_ID>"     # 变量+WI tokens
curl -s http://127.0.0.1:8799/iris/rpc -X POST -H 'content-type: application/json' \
  -d '{"id":"x","method":"script.getVariables","params":{"chatId":"<CHAT_ID>","scope":"chat"}}'
```

帧健康探针（浏览器 console 或 playwright.evaluate）：

```js
const f = document.querySelector('iframe[title="Iris ST-compat extension plane"]');
const token = /iris-st-ext-token" content="([^"]+)"/.exec(f.getAttribute('srcdoc'))[1];
f.contentWindow.postMessage({irisStExt: token, type: 'probe'}, '*');
// 监听 message：期望 kernelInstances:1, ejsPublished:true, settingsDom:1
```

## 6. 关键文件地图

- 壳侧：`apps/iris-web/src/st-extensions/{plane,plane-core,plane-bus,srcdoc,kernel-entry}.ts(x)`、`facade/**`（17 门面）、`vite.st-ext.config.ts`
- 包侧：`packages/iris-compat-st-extension/src/{runtime/{protocol,event-bus,event-types,kernel-core}.ts, host/{bridge,definition,expansion,member-bundle,settings,settings-store}.ts}`
- 宿主接线：`service.ts`（StCompatOptions、三桥点、stCompat RPC 群）、`index.ts`（pilot 块、路由、facadeStamp）、`st-ext-assets.ts`（路由）、`system-plugins.ts`（adoptDefinition）、`paths.ts`（extensions 根）
- 协议：`iris-protocol/src/{rpc,events}.ts`（stCompat.* 5 方法 + st-compat.request 事件）
- 验收：`notes/st-compat/acceptance/{seed,mock-provider,check,itemize,pilot-steps}.mjs`、`seed.log`
- 设计/验收标准：`notes/st-compat/{PILOT-DESIGN,pilot-use-cases,pilot-lock}.md`
