# ST 扩展兼容：设计与施工手册

日期：2026-09-13。性质：新增基础设施主线的设计和施工合同，**不是已实现 API 文档**。

> **文档身份与唯一所有者**
>
> - 文档编号：`DOC-ST-COMPAT-PROGRAM`；它是整个 ST 兼容主线的调度合同，**不是一个可以交给开发者直接“实现本文”或与另一份手册并行施工的编码任务**。
> - 唯一维护者：集成人。正文变更使用从当前 `dev/system-plugins` HEAD 创建的短期 `dev/plugin-doc-*` 分支和独立 worktree，审阅后合回 `dev/system-plugins`。
> - 编码任务只来自 §9 的一个具体批次及 §9.2 的完整派工单。一个批次一个分支；没有基线 SHA、分支、worktree、文件所有权和合并顺序时不得开工。
> - 与本计划并列的另两项任务是 [系统插件实施交接](../notes/SYSTEM-PLUGINS-HANDOFF.md) 和 [基础设施接口清单](INFRASTRUCTURE-INTERFACES.md) 的核验；插件作者手册不在这组三任务中。

适用现场：main `2079dbe`；插件内核基线 `2ac0f06`；当前集成基线 `dev/system-plugins @ 934ae1c`。现场继续变化，派工时必须用实际 HEAD 替换本文示例基线。不要从旧 `dev/feat-extension-system` 开工。

配套：[基础设施接口清单](INFRASTRUCTURE-INTERFACES.md)、[插件制作与执行手册](PLUGIN-AUTHORING-RUNBOOK.md)、[系统插件架构](SYSTEM-PLUGINS.md)、[契约施工落点](../notes/PLUGIN-CONTRACT-LANDING-SITES.md)。本文件覆盖此前口头建议中“立即停止 TH/MVU 实现、直接换成上游”的部分：先做可行性试点，通过后才替换。

### 2026-09-13 并行施工收口记录

最初派发时没有先给三份文档分配唯一身份和分支，且任务二的链接误写成本文件，导致 ST 兼容方案、系统插件实施交接、接口盘点和产品施工在同一个集成 worktree 并行。这是调度错误；从本段起按上面的文档身份和 §9.2 派工单执行。

已产生的提交不重写历史：动态 RPC 与契约基线是 `2ac0f06`；P0 是 `30b522c`；P2 分析器是 `a3d1d9c`，并在 `5aedccc` 合入；落点 2 资产面已经直接以 `ab3da4d`、`e2b8230` 合入集成分支，lockfile 收口是 `934ae1c`。本轮将这些视为既成集成历史，不再把同一改动复制到新分支。

本地 `dev/plugin-assets-plane` 仍停在 `5aedccc`，早于真正的资产面提交，属于过期占位分支，**不得继续开发或作为落点 2 已完成的证据**。`dev/st-compat-baseline` 和 `dev/st-compat-installer` 是已完成批次的历史分支，后续只读。下一个产品编码任务是落点 3，必须从验收后的当前 `dev/system-plugins` HEAD 新建 `dev/plugin-client-runtime` 及独立 worktree。

三项上层任务从现在起按下面的所有权收口：

| 任务 | 权威文档 | 分支与 worktree | 允许范围 | 交界规则 |
| --- | --- | --- | --- | --- |
| 一：ST 扩展兼容 | 本文件 | 每个 §9 批次使用自己的 `dev/st-compat-*` 或指定分支与独立 worktree；本文件本身由 `dev/plugin-doc-*` 维护 | 安装分析、ST 兼容环境、试点与适配器 | 不能直接修改系统插件中央文件；通过明确接线任务合入 |
| 二：系统插件控制面 | [SYSTEM-PLUGINS-HANDOFF](../notes/SYSTEM-PLUGINS-HANDOFF.md) | `dev/system-plugins`，`D:/workspace/小项目/iris-system-plugins` | 控制面、生命周期、中央接线和集成验收 | 它是集成目标；不再同时承接独立批次的工作区修改 |
| 三：基础设施接口核验 | [INFRASTRUCTURE-INTERFACES](INFRASTRUCTURE-INTERFACES.md) | `dev/plugin-infrastructure-audit`，`D:/workspace/小项目/iris-plugin-infrastructure-audit`，从待核验的 `dev/system-plugins` SHA 创建 | 只读盘点、接口清单、核验测试与缺口报告 | 发现产品缺口时另开带所有权的实现分支，不能在核验分支顺手补代码 |

## 1. 产品目标与第一版边界

用户在插件中心粘贴上游发布地址或 Git 仓库地址，查看已解析的插件与版本，安装后启用。更新、停用、卸载继续使用同一个插件中心和生命周期控制面。

保留两种来源：Iris 原生插件、ST 兼容扩展；另保留酒馆助手脚本导入格式。**MVU 的脚本发布物不能仅因名字相同就按 ST manifest 扩展处理**。对每一个选定版本先识别其真实发布格式、入口和依赖。

第一版接受明确的 HTTPS Git 仓库和本地发布包；普通官网页只用于识别发布链接，无法识别时要求提供仓库或发布包，不把网页当 JavaScript 执行。不会把任意网址自动解释为可安装插件。

第一版交付指标：一个不修改上游代码的简单扩展完成安装、真实功能、停用和恢复；一个复杂扩展完成明确的缺口报告。TavernHelper/MVU 的全功能兼容是后续独立验收目标。

当前 TH/MVU 实现作为回归基线保留。同一 profile/聊天中，一个功能只能有一个活动实现，不能同时运行旧 MVU 和上游 MVU、双写变量或重复处理事件。

## 2. 已知事实、待验证事项

本机 ST 事实源为 `E:/sillyTavern/SillyTavern`，只读。开工时记录其 commit、package 版本和目标扩展 commit，避免引用移动分支。

| 事项 | 本次观察 / 施工含义 |
| --- | --- |
| ST 扩展入口 | `public/scripts/extensions.js` 读取 manifest、加载 JS/CSS；不能只处理单个 bundle |
| manifest.requires | 本机实现指向 Extras 模块，不等于插件 dependencies；不得混用 |
| manifest.dependencies | 扩展依赖及启用条件；loading_order 是排序提示，不能代替依赖图 |
| minimum_client_version | 对 ST 版本的要求，不可与 Iris 版本直接比较；由兼容档案声明支持的 ST 行为基线 |
| ST 内部模块 | 真实扩展导入 script.js、extensions.js、world-info.js 等，并使用可变对象和事件 |
| 页面依赖 | ST-Prompt-Template 源码直接访问 `.mes[mesid]`；导入成功不等于页面功能正确 |
| Iris 动态 RPC | 工作区已有 rpc-registry.ts、scope.registerRpc 和相关测试文件；视为施工中，未凭文件存在宣布通过 |
| Iris 浏览器契约 | 当前读到的 SandboxPluginRuntime 仍是 TH/MVU 双布尔，需要通用化 |
| 热停用 | 上游不一定提供完整释放逻辑；兼容扩展可能需要重建整个兼容环境 |

静态分析只能列出确定依赖和未知点，不能给出“完全兼容”证明。不得用伪造 ST 版本、空函数或吞异常通过插件的能力检查。

## 3. 总体结构与代码所有权

```text
PluginCenter → 安装服务 → 原始发布物 + 锁定记录 + 分析报告
                              ↓
                        兼容计划 / 适配档案
                              ↓
                   现有 SystemPluginRuntime
                              ↓
           ST 浏览器运行环境 ↔ 宿主能力桥 ↔ Iris 业务服务
                              ↓
                   原始扩展 / 脚本 + 自己的 UI
```

一个插件目录、一个依赖图、一个状态来源。安装服务管理磁盘发布物；SystemPluginRuntime 管理激活，两者不是第二套并列启停系统。用户数据按 profile 隔离，下载的不可变文件可以共享，授权和状态不能共享。

建议新增目录（均为设计名称，施工者可在首个 PR 中结合现有包结构调整并同步本稿）：

| 目录 | 职责与禁止的耦合 |
| --- | --- |
| `packages/iris-extension-installer/` | 获取、解包、哈希、锁定、更新事务；不启动扩展 |
| `packages/iris-compat-st-extension/` | manifest 规范化、模块依赖分析、兼容计划；不依赖 app-service 实现 |
| `apps/iris-web/src/st-extensions/` | 隔离环境、ESM 门面、事件、UI、资源释放；不导入 Node 能力 |
| `packages/iris-app-service/src/plugins/st-extension-host.ts` | 将分析后的发布物接入既有运行时和业务能力 |
| `packages/iris-compat-st-extension/adapters/` | 按上游版本匹配的适配档案、补丁摘要、行为测试 |
| `tests/fixtures/st-extensions/` | 小型自有夹具；真实上游样本另锁版本、记录来源与许可证 |

安装器、RPC 注册、client.js 资产面不得各自再造生命周期。Cordis child context 提供资源所有权，浏览器上下文销毁提供无法逐项撤销代码的回收边界。

## 4. 数据合同（拟议，不能直接当现有 SDK 调用）

```ts
type SourceKind = 'iris-native' | 'st-extension' | 'tavern-script';
type CompatVerdict = 'unverified' | 'verified' | 'needs-adapter' | 'unsupported';

interface ExtensionLock {
  id: string;                     // Iris 分配，不能直接信任 manifest 名称作为路径
  kind: SourceKind;
  source: { repository?: string; requestedRef?: string; resolvedCommit?: string };
  artifactSha256: string;          // 本次下载/发布物内容
  manifestSha256: string;
  preparedSha256: string;          // 重写/打包后的内容
  adapter?: { id: string; version: string; sha256: string };
  compatibilityAbi: number;
  dependencyLocks: Record<string, string>;
}

interface CompatibilityFinding {
  category: 'module' | 'member' | 'dom' | 'event' | 'http' | 'dependency' | 'dynamic';
  file: string;
  line?: number;
  name: string;
  result: 'mapped' | 'missing' | 'unknown';
  reason: string;
}

interface CompatibilityReport {
  artifactSha256: string;
  analyzerVersion: string;
  verdict: CompatVerdict;
  findings: CompatibilityFinding[];
  evidence?: { suite: string; irisCommit: string; adapterVersion?: string }[];
}
```

`verified` 仅表示锁定发布物在列出的测试范围内通过，UI 显示“该版本已验证”；不能覆盖未知功能或上游新版本。安装、运行、兼容、更新是独立维度：沿用现有 runtime.status，另加 compatibility、blockers、update 信息。不要把 update_available 和 enabled 放进同一个互斥枚举。

规范化 manifest 时保留原文件；读取 display_name、js、css、loading_order、dependencies、requires、optional、minimum_client_version 等本机验证字段。未知字段列入报告。URL、依赖标识和文件路径各自校验；上游依赖名通过明确映射解析，不能猜测同名来源。

## 5. 安装、更新与磁盘事务

拟议磁盘布局：`<data>/extension-artifacts/<hash>/original`、`prepared`、`lock.json`；profile 下 `extensions/<id>/data` 和活动版本索引。最终位置由安装服务统一生成，插件不得自选路径。

顺序：解析来源 → 下载到 staging → 校验路径/大小 → 识别发布格式 → 分析入口图 → 生成兼容计划 → 用户选择安装 → 原子提升发布物 → 注册目录，保持停用 → 用户启用。

下载安装不得执行仓库 lifecycle scripts、Git hooks、任意构建命令或服务端入口。若只有源码、没有可用发布物，报告需要受支持的构建配方；受控配方与适配器一起审查和锁定。

获取层处理 HTTPS 重定向和每一跳目标、下载超时和体积限额；Git 禁止危险协议和自动子模块递归。归档拒绝绝对路径、`..`、越界 symlink、Windows junction/reparse point。拒绝从浏览器请求读取任意本地路径；本地导入使用明确文件选择/上传流程。远程卡片资源原有域名约束继续适用，安装功能不自动扩大卡脚本网络权限。

更新以新 staging 重新分析，显示版本、依赖和能力变化，旧版本继续服务。用户选择切换后关闭新 admission、排空旧任务、释放旧环境，再激活新版本；失败恢复旧锁和旧环境并报告。若数据迁移不可逆，必须先建立可恢复副本并标记回退范围，不能只回退 JS 就声称数据也回退。

宕机恢复根据事务日志和活动指针决定旧/新版本；未完成 staging 可清理，不能扫描到一个目录就自动启用。卸载默认保留用户数据，删数据是独立动作。

## 6. ST 模块兼容：路径和语义都必须匹配

为每个发布物建立解析后的模块图。相对 import 先以其上游虚拟路径解析，再区分“扩展自身文件”和“ST 宿主模块”；只映射精确的已登记宿主路径。不用全局字符串替换修改源码。

使用 JS 解析器/打包器处理静态 import、export-from、字面量 dynamic import 和资源引用。表达式 dynamic import、运行期生成脚本、未知 bare specifier 标为 unknown；不得静默允许其逃逸加载。保存 source map，报错关联原始文件位置。CSS url、import.meta.url、Worker 与 fetch 相对路径单独验证。

首批模块按试点真实使用量实施：

| ST 门面 | 必须定义的行为 |
| --- | --- |
| script.js / extensions.js | getContext、chat/metadata、保存、设置；哪些同步、哪些异步、何时可写 |
| events.js | 顺序、await、once、makeFirst/makeLast、移除、异常传播、重入 |
| slash-commands/* | 参数解析、返回值、作用域、取消；不能仅登记同名命令 |
| world-info.js | 实体身份、读写、激活时机、事件、持久化 |
| extensions/regex/engine.js | 真实路径、三层顺序、阶段、深度和作者启停语义 |
| popup.js | 返回值、取消语义和模态生命周期 |
| openai.js / power-user.js | 仅明确支持的字段映射，不发布可任意写的全局设置副本 |

ESM live binding 和可变对象是重点：跨 iframe 的 JSON 快照不能替代同步可变 chat 数组。读操作可用带版本快照；写操作通过明确提交 API；依赖“直接改对象后 save”时，需实现受控本地事务和冲突检测，并验证事件发生前后值。无法保持上游同步语义的成员标记需适配，不能偷偷改为 Promise。

宿主能力桥只调用公开 Iris 服务契约，不把 IrisAppService 或 Cordis Context 暴露给远程浏览器扩展。协议动态注册只是运输能力，不自动授权。每次写入都核对 profile、chat、扩展身份、授权及生命周期。

## 7. 浏览器执行环境和热插拔

ST 兼容扩展默认在独立兼容页面/iframe 中运行。现有 `/plugins/<id>/client.js` 可装载 Iris 维护的 shell 桥；远程 ST 入口不得因同为 client.js 就进入拥有宿主 DOM 的原生 shell 插件路径。

浏览器隔离必须验证 origin、sandbox/CSP 和消息通道；`allow-scripts` 与 `allow-same-origin` 的组合不能仅凭“使用了 iframe”就当作隔离。确定选用 opaque origin 或独立 origin 后，用实际浏览器测试模块加载、资源 CORS 与父页访问边界。

MessagePort 与启动握手绑定真实 frame、pluginId、profile、activation；宿主从已绑定通道识别身份，不信任消息自报的 id。revision 是时效检查，不是授权令牌。资产 URL 使用不变内容 hash，停用后即使缓存中还有脚本也不能提交业务操作。

默认单扩展环境；TH/MVU 若经实测要求共享 window、对象身份或同步事件，可建立显式依赖组环境。组成员共享信任边界，UI 和架构文档必须说明。停用/更新其中一项可能要重建整组，不能承诺所有 ST 扩展独立无刷新热卸载。

状态转换：enabled → 关闭新请求 → drain 已接纳 lease → 释放订阅/计时器/DOM/端口 → 销毁环境 → disabled。遵循现有租约规则，drain 期间已接纳工作可完成；停用成功后旧任务不得写入。超时返回可见的 busy/error 或明确强制撤销策略，不能提前显示停用成功。

插件的 upstream clean/uninstall hook 未必等于普通 dispose，可能删除用户数据；不得在每次 reload 时自动执行清数据 hook。

UI 分三档：插件自己根节点中的 HTML/CSS/jQuery；可映射的标准设置/消息/侧栏插槽；依赖 ST 全页面结构的专用适配。限定 jQuery 根节点不能模拟任意 document 查询，不得把它描述为通用 DOM 兼容。

## 8. 插件中心和管理 API

保留现有 plugin.list/install/enable/disable/reload/uninstall 的目录内语义；新增来源安装前需单独定义合同，不能把 `{id}` 偷换成任意 URL。

建议管理服务命令：`inspectSource`、`prepareInstall`、`commitInstall`、`checkUpdate`、`prepareUpdate`、`switchVersion`、`rollback`。这些是拟议命令名，RPC 命名由协议所有者最终确定。耗时操作返回 jobId；任务有 progress/result/error，可重连查询；commit 使用 planId 和幂等键，绑定 hash 与 profile，防止预览后来源漂移。

列表主信息为名称、来源类型、已装版本、运行状态、兼容结论；详情包含原始来源、锁定 commit、适配器、测试范围和缺口。把缺少依赖、未验证、启动失败区分展示。维护者可打开原文件定位，普通用户先看可采取的动作。

不得未经选择安装未知来源依赖。已安装且来源匹配的依赖可复用；待安装依赖先进入计划。更新检查不自动换活动版本。

## 9. 施工批次与交付门

| 批次 | 工作与交付物 | 前置 | 通过后允许做什么 |
| --- | --- | --- | --- |
| P0 基线与试点清单 | 保存当前施工提交；锁 ST、TH、MVU 和一个简单扩展版本；列真实入口/依赖/许可证；定义无 UI 业务用例和 UI 用例 | 无 | 并行开工；明确负责人 |
| P1 插件内核收口 | 验收契约包、动态 RPC、原生资产面、成员通用化、lease/dispose；复用在建代码 | P0 | 兼容宿主通过统一控制面接线 |
| P2 安装与分析 | 本地夹具、Git 固定 commit、manifest 规范化、模块图、hash/lock/report、事务恢复 | P0，可与 P1 并行 | 只能安装为停用，不能声称可运行 |
| P3 兼容试点 | 隔离环境、精确模块映射、事件/设置最小集、消息桥；简单上游扩展不改源码完成业务 | P1+P2 | 为该版本标记限定范围 verified |
| P4 TH 验证 | 上游入口启动、接口发布、卡脚本交互、生成/变量/世界书、UI 与停用；逐项与旧实现对比 | P3 | 通过的领域可以切换，旧路径保留回退 |
| P5 MVU 验证 | 确认发布格式；TH 依赖、变量初始化/更新/replay、swipe、重载与取消的上游语义对比 | P4 的所需能力通过 | 单 profile 受控切换；避免双引擎 |
| P6 推广与清理 | 更新回滚演练；扩大样本；删除已证明冗余代码；SDK 发布及拆仓库 | P4/P5+完整回归 | 对外承诺明确兼容范围 |

P3 如果同步对象/DOM/模块依赖成本不可接受，交付“已验证的阻塞清单＋专用适配方案”，暂停通用兼容扩展范围。P4/P5 可以选择维护小型上游补丁或继续现有 Iris 实现，不得为完成进度而全面伪造 ST 环境。

### 9.1 分支、worktree 与合并安排（每次派工必填）

在任何一个开发任务开始前，集成人先把当前 `dev/system-plugins` 未提交工作保存为可通过基础类型检查的提交，记录该提交为 `PLUGIN_KERNEL_BASE`。下面的 `PLUGIN_KERNEL_BASE`、`P1_MERGED`、`P2_MERGED` 都是实际 commit SHA，不是分支名；派工单必须写入其值。没有基线 SHA、分支和 worktree 路径的任务不得开始。

| 批次 | 分支 | worktree | 从哪里创建 | 独占文件/目录 | 合并目标与顺序 |
| --- | --- | --- | --- | --- | --- |
| P0 | `dev/st-compat-baseline` | `D:/workspace/小项目/iris-st-compat-baseline` | `PLUGIN_KERNEL_BASE` | `notes/st-compat/`、试点锁定文件、只读勘察脚本 | 先合入 `dev/system-plugins`；产出试点锁定 commit |
| P1 | `dev/system-plugins` | `D:/workspace/小项目/iris-system-plugins` | 已有集成分支 | protocol、rpc-host/client、契约包、`system-plugins.ts`、包清单/lockfile | P0 锁定后由内核负责人提交；这是后续分支的共同基线 |
| P2 | `dev/st-compat-installer` | `D:/workspace/小项目/iris-st-compat-installer` | `PLUGIN_KERNEL_BASE`；若 P1 修改其公开合同则改从 P1 commit 重建 | `iris-extension-installer/`、`iris-compat-st-extension/` 的分析部分、fixtures、lock/report | 可与 P1 并行；在 P1 合入后 rebase，再合入 `dev/system-plugins` |
| P3 | `dev/st-compat-pilot` | `D:/workspace/小项目/iris-st-compat-pilot` | P1、P2 均已合入后的 `dev/system-plugins` commit | `apps/iris-web/src/st-extensions/`、最小模块门面、试点 adapter | 仅在 P1/P2 合入并通过后创建；合入 `dev/system-plugins` |
| P4 | `dev/st-compat-tavern-helper` | `D:/workspace/小项目/iris-st-compat-tavern-helper` | P3 合入后的 commit | TavernHelper adapter、锁定版本夹具、TH 行为测试 | P3 后开始；合入 `dev/system-plugins` 后才允许 MVU 切换 |
| P5 | `dev/st-compat-mvu` | `D:/workspace/小项目/iris-st-compat-mvu` | P4 中 TH 所需能力已合入的 commit | MVU adapter、MVU 夹具、变量/replay 测试 | 依赖 P4，不与 TH 中央接线并行；合入 `dev/system-plugins` |
| P6 | `dev/st-compat-hardening` | `D:/workspace/小项目/iris-st-compat-hardening` | P4/P5 完整集成并验收的 commit | 更新/回滚、兼容目录、清理候选代码、发布材料 | 最后合入；删除旧实现另开明确子任务和 PR |

P2 可以在 P1 施工期间做只读分析和自有安装器代码，但不得修改 P1 独占文件。P3 以后所有分支必须从已合入的上一门槛创建，不从旧任务分支横向合并。若一个任务发现必须修改表中另一任务的独占文件，停止该处修改，在派工单中创建一个由集成人拥有的接线子任务。

合并拓扑固定如下；每次 rebase 后再运行本批次针对性门和相应全仓门：

```text
P0 ──┐
     ├──→ P1 / dev-system-plugins ──┐
P2 ──┘                               ├──→ P3 ──→ P4 ──→ P5 ──→ P6
                                     │
                                     └── P2 rebase 后接入
```

### 9.2 派工单模板

每个开发任务的首段必须原样补全下面字段。负责人完成后只提交自己拥有的路径；集成人负责 rebase、冲突处理、推送、PR 和最终验收。

```text
任务：
基线：<branch> @ <full commit SHA>
工作分支：dev/<name>
worktree：D:/workspace/小项目/iris-<name>
负责人：
允许修改：
禁止并行修改：
依赖任务/必须先合入：
合并目标与顺序：
验证命令：
交付物与验收场景：
```

## 10. 派工与集成规则

| 负责人 | 独占范围 | 交接结果 |
| --- | --- | --- |
| 内核负责人 | protocol、rpc-host/client、契约包、system-plugins.ts | 已提交可测基线、注册与生命周期合同 |
| 安装分析负责人 | installer、manifest、resolver、lock、fixtures | 不执行代码的 install plan 和兼容报告 |
| 浏览器兼容负责人 | st-extensions、frame/srcdoc/启动装配、模块门面 | 固定试点真实浏览器证据和资源释放结果 |
| TH/MVU 负责人 | 对应 adapter 和行为测试 | 上游依赖清单、差异、是否可替换结论 |
| 集成人 | service.ts、entry.ts、index.ts、包清单/lockfile、PluginCenter 交界 | 顺序接线、PR 与全套验收 |

从内核负责人提交的检查点创建短期独立 worktree；不复制整个未提交工作树开工。所有派工必须遵循 §9.1 的分支安排和 §9.2 的任务模板。先确认文件所有权，中央文件由集成人修改，不能两个代理同时写。当前存在其他人的未提交代码，本手册不授权覆盖、重置或纳入不相关提交。

每个批次一个可审查 PR；描述必须说明“真实上游版本、行为前后、测试范围、仍不支持什么”。适配档案至少包含匹配的源 hash、兼容 ABI、映射、补丁 hash、测试列表；不根据文件名含 mvu 自动选择适配器。

## 11. 测试矩阵与执行步骤

| 面 | 必测情形 | 验收证据 |
| --- | --- | --- |
| 安装 | 重定向、错误 ref、哈希变化、越界路径、解包中断、磁盘写失败 | 无越界文件；旧版本可用；任务可恢复 |
| 分析 | 相对/绝对 import、export-from、字面量与表达式 import、CSS/Worker 资源 | 定位精确；未知不被误判为支持 |
| 协议 | 重名注册、失败回滚、卸载后调用、旧 revision、跨 profile 请求 | 无半注册、无越权写入、fake/真实运输一致 |
| 状态与事件 | live binding、直接对象修改、保存冲突、await 顺序、once、重入 | 与固定 ST 基线对比数据和事件轨迹 |
| 生命周期 | 在途生成停用、重复启用、依赖停用、重载、组重建 | 每次事件只处理一次；旧环境不能再提交 |
| 浏览器 | 初始加载、iframe 初始化握手、资源失败、CORS、父页访问、样式隔离 | 实际 Chromium 测试；不能只靠 render-check |
| 更新 | 更新成功、激活失败、迁移失败、宕机、回滚 | 版本与数据一致，错误可定位 |
| TH/MVU | 初始化、正常生成、取消、编辑、swipe、换聊天、变量更新/重放 | ST 与 Iris 同输入比较；不默认旧实现就是上游正确答案 |

测试使用临时 profile 和 mock provider；先离线跑，再在授权的测试配置下验证真实请求。本机 ST 原目录只读，不读 secrets.json；key.txt 不打印、不写报告、不提交。角色数据只记录结构和哈希。

先跑本批次针对性测试，再执行仓库现有门（脚本名开工时核对 package.json）：

```powershell
# worktree 根目录
npx tsc -p . --noEmit
# apps/iris-web 中
npx tsc --noEmit
npm run build
npm run check:render
# 返回 worktree 根目录，先有 web dist 再跑
npm test
npm run test:no-corpus
git diff --check
```

验收读取进程退出码和测试结果，明确 `fail 0`；跳过数按当前构建及 corpus 条件解释，不把旧测试总数当固定指标。只有新增失败或代码变化才重跑相应测试。

预览使用确认空闲的端口和临时数据目录。先核对现有进程身份；8790 曾属于用户启动的实例，不能直接占用或终止。生产 profile 不承担试点安装和迁移实验。

## 12. 每批施工报告模板

```text
基线：Iris commit / ST commit / 上游扩展 commit 与发布物 hash
实现：新增或复用的接口、文件所有权、生命周期接点
运行环境：原生 / 独立兼容 iframe / 共享依赖组
发布物：原样运行 / import 映射 / 明确版本补丁
行为证据：具体用户操作、事件轨迹、数据结果、测试命令和退出码
兼容报告：已测范围、缺失成员、动态未知、DOM/服务端依赖
停用与更新：资源释放、在途工作、回滚和数据迁移结果
剩余事项：阻塞、可并行任务、下一批允许开始的范围
```

首个施工任务应是 P0 和 P1 收口，同时启动 P2 的只读分析器。不要先做一个“安装成功”的按钮再追查运行时依赖；也不要在 P4/P5 通过前删除现有 TH/MVU 实现。
