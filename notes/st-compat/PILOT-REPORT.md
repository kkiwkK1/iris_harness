# 任务 C-final 验收报告 —— ST 扩展兼容试点联合验收

日期：2026-09-14。验收分支 `dev/st-compat-pilot-acceptance`（worktree `D:/workspace/小项目/iris-st-compat-pilot-acceptance`），基线 `dev/st-compat-pilot@065cc027e9d81c3a7b0df53415e6bb61fddb7c12`。试点对象：ST-Prompt-Template @ `f9a07da`（manifest 1.17.4.1），上游字节零修改（安装树 `dist/index.js` sha256 `61a87e9295dbcb2dc8335f90e95dbb67517457958d855bfb8f31798a042f71fd`，与锁定值一致）。验收环境：真实 Chrome（CDP 驱动）+ mock provider（脚本化回复，逐请求落盘取证），宿主与对照实例跑在**隔离端口**上（8811）。

## 结论

**全部检查通过。** UC-1（10/10）、UC-2（9/9）、UC-3（9/9）、旧 revision 隔离（6/6）、故障隔离（5/5）、卸载与数据规则（4/4）、ST 1.18.0 同输入对照（核心项：生成前消息字节级一致）全部成立。过程中发现并修复 3 个产品缺陷（见 §缺陷），全部按流程以独立分支修复、合回 `dev/st-compat-pilot`、验收分支更新到新头后复测。

## 1. UC-1：生成前模板处理（run-uc1.mjs，证据 `evidence/uc1.json`）

| 检查 | 判定 | 证据 |
| --- | --- | --- |
| 原版产物不修改运行 | ✅ | 安装树 dist/index.js sha256 = 锁定值；lock.artifactSha256 前 12 位 = 资产路由 rev `fcd1a80ae3b4` |
| 相同输入展开稳定 | ✅ | 两轮同输入，WI 段逐字节一致（`\n你是我信赖的朋友。\n`） |
| 停用后原文直通、桥接为零 | ✅ | 停用轮 provider 收到完整 EJS 原文（含 `<%`），桥接轮数 = 0，页面 plane iframe 消失 |
| 重新启用只处理一次 | ✅ | 恢复后桥轮次 2（generate+reply 各一），帧重建后 kernelInstances = 1 |
| 恢复原设置逐字节一致 | ✅ | 复位 `好感度=70` 后 WI 段与第 1 轮逐字节一致 |

补充：桥的语义为「未武装 = 立即原文直通」（`bridge.begin` 未武装返回 null，deadline 1500ms），无浏览器连接时请求 262ms 内原文出站（实测）。

## 2. UC-2：回复后变量更新（run-uc2.mjs，证据 `evidence/uc2.json`）

| 检查 | 判定 | 证据 |
| --- | --- | --- |
| setvar 写入正确的消息变量层 | ✅ | 回复轮后 message 层 = 10，chat 层保持 0；楼层文本模板被剥离（`新的好感度：10`） |
| 刷新、切换会话后仍可读取 | ✅ | 页面刷新一轮后 10→30；RPC 切换会话再切回一轮后 30→40（依赖缺陷修复 #1） |
| 停用、重启用不重放 | ✅ | 停用期变量冻结在 40、原文楼层保留 `<%`；重启用后 40→50 继续，停用期楼层未被补处理 |
| 与 MVU 互斥、不双写 | ✅ | 双开一轮：MVU 的 `recordVariables` 在桥合并之后**整表替换**消息层，最终表为 MVU 形（stat_data），ST 模板写入被取代而非叠加；MVU 对不存在路径给出具名拒绝（`MVU: path "好感度" does not exist`）。两实现变量表不相交，每轮恰好一个写者 |

互斥前置：种子脚本停用 mvu（`plugin.disable mvu`），与 RUNBOOK「一个功能一个活动实现」一致。

## 3. UC-3：设置面板（run-uc3.mjs，证据 `evidence/uc3.json` + 截图 uc3-01..09）

| 检查 | 判定 | 证据 |
| --- | --- | --- |
| 面板只出现在「系统插件 → 插件设置」 | ✅ | `data-iris-st-ext-section` 仅在 plugins 路由可见；diagnostics 路由 section/标题均不可见（抽屉页面常驻挂载仅 `hidden`，判定用可见性） |
| 中英文双向切换 | ✅ | zh：标题「插件设置」、面板「提示词模板/是否启用扩展/处理生成内容…」（locales/zh-cn.json 译文）；en：`Plugin settings` + 原文 |
| 键盘可达 | ✅ | 真实键击：点击进入投影 → Tab 遍历面板真实复选框 → Space 翻转；翻转发 `irisStProject` change 事件回放至真实面板（relayed=7） |
| 修改持久化 | ✅ | 翻转后 `st-extension-settings/st-compat/prompt-template.json` 落盘并跨刷新保持；投影重建自存储状态 |
| 停用后标题/面板/帧一起消失 | ✅ | 停用后标题、section、plane iframe 全部消失，探针 `no plane iframe` |
| 重启用建新面板不复用旧 frame | ✅ | 新 token（旧 `st-frame-1v0l…` → 新 `st-frame-knru…`），kernelInstances=1 |
| 停用状态刷新仍不出现 | ✅ | 停用+刷新后无 section/标题/iframe |

## 4. 卸载与数据规则（run-uninstall.mjs，证据 `evidence/uninstall.json` + 截图 uninstall-01/02）

- ✅ 卸载后：plane iframe、设置 section、插件快照行（not-installed）、`/iris-st-ext` 顶层 manifest（extensions: []）、rev 资产路由（上游 dist/index.js 与门面 script.js 均 404）全部消失。
- ✅ 插件设置按平台规则保留：卸载后 `st-compat/prompt-template.json`（726 字节）原样保留。
- ✅ 重装同 id 后恢复此前设置：`stExtension.install` 幂等重adopt（依赖缺陷修复 #3），设置字节级一致，面板重建健康。
- ✅ 卡片、聊天、变量、角色数据逐项快照对比：卸载前后零变化（楼层数、chat 变量、角色列表、世界书条目与内容头部）。

## 5. 旧 revision 隔离（run-revision.mjs，证据 `evidence/revision.json` + 截图 revision-01/02）

- ✅ 保留旧 iframe 引用：`plugin.reload` 前捕获旧帧元素与 token（旧 rev 5 → 新 rev 8）。
- ✅ 旧帧 submit 被拒：重载**销毁旧浏览上下文**（`contentWindow === null`）——比拒绝更强；僵尸帧（声称旧 token）的 bridge-result 被页面 token+source 栅栏丢弃；宿主侧旧 revision 提交具名拒绝（`no pending request carries this token`；活跃轮次下为 `submit carries revision X, the round was opened at Y — a stale frame`）。
- ✅ 旧帧保存设置被拒：`the extension plane is stale or absent; reload the page before saving settings`。
- ✅ 旧帧调用成员被拒：旧上下文已销毁，无从发起；成员路由仅按当前帧+扩展 id。
- ✅ 新 revision 操作正常：设置保存成功；注入卡帧经成员代理调用 `EjsTemplate.evalTemplate('<%= 6 * 7 %>')` 返回 **42**（依赖缺陷修复 #2）。

## 6. 故障隔离（run-fault.mjs，证据 `evidence/fault.json` + 截图 fault-01/02）

| 变体 | 判定 | 行为 |
| --- | --- | --- |
| 删除 settings.html | ✅ | 投影无内容（0 字节）而聊天继续工作；上游对该文件的依赖程度使其 init 可能失败（记录到观测值），无论哪种结果降级都干净；其他插件行不变 |
| 删除门面 scripts/events.js | ✅ | 扩展帧无法启动（探针超时）、试点聊天原文直通；**普通卡片照常打开、发送、生成、保存**（对照组 Plain卡 回复正常）；恢复文件后内核重启健康 |
| 删除 client.js（成员 bundle） | ✅ | 卡面成员路由具名 404（卡片拿不到成员）而扩展帧自身继续展开；其余无变化 |

一个插件的失败未移除其他插件的成员或面板：全程 `tavern-helper:enabled`、`mvu:disabled` 行不变，其 bundle 完好。

## 7. ST 1.18.0 同输入对照（run-st-compare.mjs，证据 `evidence/st-compare.json`、`st-capture.jsonl`、`provider-capture.jsonl`）

装置：`E:/sillyTavern/SillyTavern`（只读）+ 独立 dataRoot `D:/st-compare-data`；扩展锁定 `f9a07da`（ST 的第三方自动更新曾把安装拉到 d6f520d，已 `git reset --hard` 恢复，并在对照驱动中拦截 `/api/extensions/update` 后重跑）；同一脚本化 provider；同一卡（含绑定世界书与模板条目）；同一输入（好感度=70、同消息结构、英文界面）。

| 对照项 | Iris | ST 1.18.0 @ f9a07da | 分类 |
| --- | --- | --- | --- |
| 生成前消息（WI 条目在请求中的字节，role=system） | `\n你是我信赖的朋友。\n` | `\n你是我信赖的朋友。\n` | **等价**（sha256 均为 `8818c8c21e43084a3a35852bc1b60996926e6da1d277a3709fb90d1aa9631ace`） |
| 停用/无桥时的同位置字节 | 完整 EJS 原文（sha256 `116aba922d245dabafb5c03a01730e3fddccbe16a8d128838ac754cc1b2c2bc9`） | 同规则（未启用即原文） | 等价 |
| 回复后文本 | 模板行剥离、正文保留、内嵌 `<%- %>` 求值回写楼层 | 同（楼层正文无 `<%` 残留，回声数值随各自变量状态） | 等价（机制）；数值随状态历史，非处理分歧 |
| 变量层 | setvar 写消息层（`chat[i].variables` 语义），宿主按层持久化 | 同层语义；`getvar` 缓存合成 global←initial←chat←消息层 | 等价（Iris 补齐楼层变量跨帧水合，见缺陷 #1） |
| 设置持久化 | `extension_settings.EjsTemplate` → profile 内 `st-extension-settings/st-compat/<id>.json`（独立文件，原子写） | 同一 blob 存于 ST 的 `settings.json` 内 | **Iris 有意偏离**（存储位置），blob 形状一致 |
| 事件面 | 仅映射试点所需事件（CHAT_CHANGED/生成前/回复落层等），未映射项具名报错 | 全事件 | **Iris 有意偏离**（试点范围，PILOT-DESIGN §2 在案） |
| 楼层渲染 | 虚拟 DOM + 逐楼层处理；`messageFormatting` 为 HTML 转义、`saveChatConditional` no-op、token 计数为估计值 | 真实 DOM/完整存档/精确计数 | **Iris 有意偏离**（在案偏差，非本阶段缺陷） |
| 手动对照发现 | — | ST 第三方扩展 auto_update 会在页面加载时 pull origin/main | 对 Iris 无影响（Iris 无该机制）；对 ST 装置要求锁定（已恢复并拦截） |

对照期间对 ST 装置的写入仅限 dataRoot（`D:/st-compare-data`）与对被自动更新破坏的扩展仓库的**恢复性** `git reset --hard f9a07da`；`E:` 安装目录其余部分未触碰。

## 8. 发现并修复的产品缺陷（各独立分支，已合回 dev/st-compat-pilot）

1. **`dev/plugin-fix-st-compat-floor-variables`**：桥上下文不携带楼层消息变量（`StFloorSnapshot.variables` 协议早已声明但宿主从未填充）。上游模板缓存按「消息层覆盖 chat 层」合成且新楼层从上一楼层克隆，帧重建（刷新/切会话/停启用）后累加链从空层重启——实测持久值 20 下一轮读成 0 并回写回归。修复后跨刷新/切换/重启用连续（30→40→冻结→50）。
2. **`dev/plugin-fix-st-compat-member-proxy-gate`**：卡面成员代理不可达——plane 挂载的页面级消息门在委托给 plane 之前丢弃了一切「来源 ≠ 扩展帧」的消息，而成员调用恰恰来自卡帧。实测卡帧信封到达页面后无任何应答。修复：门把 `irisStMemberProxy` 信封先行交给 plane（其自有守卫不变），判定抽为纯函数 `isCardMemberProxyCall` 并红绿钉住。
3. **`dev/plugin-fix-st-compat-reinstall`**：卸载规则保留安装树，但同 id 重装撞上安装器 `already-installed` 拒绝，承诺的重装路径不存在。修复：`installFromDirectory` 在锁存在时幂等重adopt（谓词读 lock——安装器最后写入的文件，半开事务不会误判），仅对新 id 走安装事务。

另记录一项**环境发现**（非产品缺陷）：验收初期 ZCode 内嵌预览页面残留连接 8799 端口的宿主，其扩展平面持续替桥应答，造成「无浏览器仍展开」「页面桥计数为 0」的矛盾观测。将验收宿主迁移到隔离端口 8811 后矛盾消失；验收夹具端口随之参数化（`PILOT_PORT`）。

## 9. 完整门（全部在验收分支最终树上执行）

| 门 | 结果 |
| --- | --- |
| 根 `npx tsc -p . --noEmit` | exit 0 |
| Web `npx tsc --noEmit` | exit 0 |
| `npm run build`（web，含沙箱+st-ext 门面+主构建） | exit 0 |
| `npm run check:render` | `render check: ok`（exit 0） |
| 根 `npm test` | **4042 pass / 0 fail** / 11 skipped（IRIS_BROWSER/IRIS_LIVE opt-in） |
| `npm run test:no-corpus` | 40 skipped / **0 failed** |
| `git diff --check` | 干净 |

## 10. 浏览器证据索引（`notes/st-compat/acceptance/evidence/`）

| 文件 | 内容 |
| --- | --- |
| `uc1.json` / `uc1-01-frame-healthy.png` / `uc1-04-disabled-plane-gone.png` / `uc1-07-final-state.png` | UC-1 十项判定与帧截图 |
| `uc2.json` / `uc2-01-message-layer.png` / `uc2-05-disabled-raw-floor.png` / `uc2-07-mvu-mutex.png` | UC-2 九项判定与截图 |
| `uc3.json` / `uc3-01..09*.png` | UC-3 九项判定（双语面板、键盘、持久化、停用/重启用/停用刷新） |
| `revision.json` / `revision-01-rebuilt.png` / `revision-02-new-frame-works.png` | 旧 revision 隔离 |
| `fault.json` / `fault-01-settings-html-gone.png` / `fault-02-facade-refused.png` | 故障隔离三变体 |
| `uninstall.json` / `uninstall-01-gone.png` / `uninstall-02-reinstalled.png` | 卸载与数据规则 |
| `st-compare.json` / `st-capture.jsonl` / `provider-capture.jsonl` / `st-compare-01-round.png` | ST/Iris 对照的原始捕获与哈希 |
| `evidence.log` | 全部判定的时序流水 |
| 场景脚本（同目录 `run-*.mjs`、`lib.mjs`、`cdp.mjs`） | 可重跑：`PILOT_PORT=8811 node notes/st-compat/acceptance/run-<scenario>.mjs`（先 `seed.mjs`） |

## 11. 已知限制

1. 试点仅映射上游事件面的试点子集；未映射成员调用具名抛 `UnsupportedStCompatApiError`（在案设计）。
2. `messageFormatting` 为 HTML 转义、`saveChatConditional` no-op、token 计数为估计值——在案有意偏离。
3. settings.html 对上游 init 的存活影响存在时序不确定性（变体 A 观测：两次运行一次降级为 raw、一次继续展开）；无论哪种，聊天与其它插件不受影响（已记录）。
4. MVU 双开时的互斥是「最后写者胜 + 具名拒绝」，不是前置禁用；平台前置仍要求单实现（种子停用 mvu）。
5. ST 对照中回复回声数值（Iris 80 vs ST 观测值）随各自此前的消息层历史变化——机制等价，数值不做跨系统断言。
6. E: ST 安装的扩展 auto_update=true 意味着任何 ST 页面加载都可能移动其提交；本验收以 reset 恢复 + 驱动拦截收尾，后续装置使用者需注意。

## 12. 最终完整 SHA

| 对象 | SHA-1 完整值 |
| --- | --- |
| 验收基线（任务下发） | `065cc027e9d81c3a7b0df53415e6bb61fddb7c12` |
| dev/st-compat-pilot（含 3 个缺陷修复合并，验收时点） | `caf479c8b9dcedc06914a15fe78f806e45a6435c` |
| 上游扩展锁定提交 | `f9a07da0fbe25cd310eee746c2f5af24ed61f62b` |
| 上游 dist/index.js（sha256） | `61a87e9295dbcb2dc8335f90e95dbb67517457958d855bfb8f31798a042f71fd` |
| 本报告所在提交（验收分支最终提交） | 见 `git rev-parse HEAD`（dev/st-compat-pilot-acceptance） |
| PLUGIN_PLATFORM_BASE（dev/system-plugins 合入提交） | 合并后由 `git -C D:/workspace/小项目/iris_cordis_traven rev-parse dev/system-plugins` 给出（合并动作紧随本报告提交执行） |
