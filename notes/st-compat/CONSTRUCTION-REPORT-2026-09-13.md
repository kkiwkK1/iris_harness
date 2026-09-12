# ST 兼容施工报告 —— 2026-09-13 首轮（PLUGIN_KERNEL_BASE + P0 + P2 分析器首片 + P1 盘点）

按 `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §12 模板记录。本报告是施工记录，不是验收声明；未列出的项即为未做。

```text
基线：
  Iris   dev/system-plugins @ ae55920（开工现场）→ PLUGIN_KERNEL_BASE 2ac0f064eb939dcc2b5a963b4d7fbacb53c871d1 → 集成头 30b522c（P0）→ 合并 P2 后见 git log
  main   2079dbe1ef1ad6b2ae975c8c53ffe93706199bc3（未动）
  ST     51ad27fb86d39a3daca3adaa970375c9670c12df（1.18.0，AGPL-3.0，只读，工作树干净）
  TH     N0VI028/JS-Slash-Runner @ cd9f523d08d147057043b9939397de8a61be91e4（main，无 release，按 commit 锁；许可 AFPL v9——非 OSI、限商用，四对象中唯一对分发方案构成硬约束者）
  MVU    MagicalAstrogy/MagVarUpdate @ 61010dab47bc3a08a1b626320bf7fc8c9573eca4（默认分支 beta，MIT；jsdelivr @master 浮动引用明确不作为锁定源）
  简单扩展试点  zonde306/ST-Prompt-Template @ f9a07da0fbe25cd310eee746c2f5af24ed61f62b（manifest 1.17.4.1，AGPL-3.0；manifest sha256 1169b354…49cd7d，入口 dist/index.js 5,083,741 B sha256 61a87e92…f71fd）

实现：
  PLUGIN_KERNEL_BASE（集成人动作，§9.1）：ae55920 之上的未提交契约/动态 RPC 工作收口为单个过类型检查的提交。收口修了两处门上缺口：FakeClient 接口补 registerPluginMethod 声明（实现与测试已在树、接口未在）；RpcRequest 条件类型改为分配交集（unknown & PluginRevisionRequest 坍缩成后者，动态方法的真实参数会被多余属性检查拒绝，静默取消通用化）。stash system-plugins-integration-before-pr84 未动。
  P0（dev/st-compat-baseline @ 30b522c，已合入）：notes/st-compat/ 四件——README（派工单）、pilot-lock.md（四对象版本/commit/sha256/许可证/获取边界 + ST 1.18.0 manifest 读取语义行号表）、pilot-use-cases.md（UC-1 无 UI 模板展开、UC-2 无 UI 回复更新变量、UC-3 UI 设置面板，各带反例与 ST 同输入对照要求）、survey/（只读勘察脚本 + ST-Prompt-Template 报告）。零产品代码。
  P1（盘点，非收口完成）：已在位且测试通过——契约包 @iris/plugin-api / @iris/plugin-web-api；动态 RPC 全链（协议 rpc-registry + parseRequest 双表查找 + pluginRevision 保留、rpc-host 放宽至 AnyRpcMethod、scope.registerRpc 挂在激活 fiber 上 8/8 生命周期测试、fake registerPluginMethod 门在目录行上）；Handlers 保持全量是有记录的刻意设计（全量表=编译期 tripwire，能力迁出时静态词表同步收缩）。未做——落点 2（/plugins/<id>/client.js 资产面：guarded 路由、CORS、/plugins/manifest.json 聚合）、落点 3（SandboxPluginRuntime 快照泛化 + 成员表合并 + 拒跑语义重定）。
  P2（dev/st-compat-installer @ a3d1d9c，已合入）：分析器首片 @iris/compat-st-extension——manifest 规范化（拒绝非相对/越界/反斜杠/URL 路径；容忍 ST 自己容忍的：空 js=css-only、非数字 loading_order 丢弃不造值）、17 条精确宿主路径注册表（P0 实测导入集）、TypeScript 编译器 API 解析（静态 import/export-from/字面量 dynamic import/css url()/@import/import.meta/new Worker 字面量），虚拟路径解析 + 三值裁决（mapped 仅精确命中；打包烘焙深度致未命中且尾名唯一命中注册表者为 unknown 并点名候选；bare 为 unknown；missing 仅限确证缺席）。

运行环境：本轮全部为分析与文档，无扩展在任何环境运行。

发布物：无（P3 未开始；ST-Prompt-Template 仅被只读解析两次：P0 regex 首过、P2 AST 过）。

行为证据：
  root tsc（iris-system-plugins，PLUGIN_KERNEL_BASE 前）fail→修复后 0；apps/iris-web tsc 0
  node --test 协议 rpc+rpc-registry、fake plugin-methods：21 pass 0 fail
  node --test packages/iris-app-service/tests/system-plugin-rpc.test.ts：8 pass 0 fail
  P2 worktree（junction 依赖，未提交）：root tsc 0；分析器包 10 pass 0 fail；git diff --check 干净
  集成树（合并 P2 后）：root tsc 0；分析器包 fail 0；全量 npm test 见本文件末尾补记
  真实试点只读运行：17 mapped（16 宿主模块 + lib.js，全部精确命中）/ 3 unknown（import.meta ×2、烘焙绝对路径的 ejs.workers.js Worker）/ 0 missing，证据 packages/iris-compat-st-extension/reports/st-prompt-template@f9a07da.report.json。P0 勘察记录的两个尾名歧义（openai.js、faker.mjs）由虚拟路径精确解析正式裁决。

停用与更新：本轮无运行期组件，无停用/更新/回滚可测；安装器（staging/事务/恢复）属 P2 后续片，未开始。

剩余事项：
  1【集成人】root pnpm-lock.yaml 补 packages/iris-compat-st-extension importer 条目（包声明 typescript@5.9.3，根已锁同版本；本机 pnpm 11.24 离线校验器无法完成安装——2079dbe 已记录同因；P2 门以 junction 跑通，junction 不入库）。
  2【下一派工】P1 落点 2（/plugins 资产面）与落点 3（成员通用化）：按 notes/PLUGIN-CONTRACT-LANDING-SITES.md §2/§3 施工，量级 M/L；落点 3 依赖落点 2。
  3【P2 后续】安装器半边：下载 staging、解包拒越界（../、绝对路径、symlink、junction/reparse）、artifactSha256、lock 记录、原子提升、宕机恢复（§5）。
  4【P4 前置】TH/MVU 无本机副本；开工时按锁定 commit 取历史发布物，许可 AFPL v9 对 TH 分发方式的约束需在 P4 派工单中先裁决。
  5 可并行：P3 试点的浏览器隔离环境骨架可在 P1 落点 2/3 合入后开工（§9.1 门条件）。
```

## 合并拓扑现状

```text
main 2079dbe ── ae55920 ── PLUGIN_KERNEL_BASE 2ac0f06 ──┬── P0 30b522c（dev/st-compat-baseline，已合入）
                                                        └── P2 a3d1d9c（dev/st-compat-installer，已合入）
dev/system-plugins = 2ac0f06 + P0 + P2（fast-forward 顺序合并，无冲突）
```

worktree：`iris-st-compat-baseline`（P0，保留）、`iris-st-compat-installer`（P2，保留；node_modules 为指向集成树的 junction，仅本地跑门用，未提交）、`iris-system-plugins`（集成分支）。
