# ST 兼容施工报告 —— 2026-09-13 追记（收口记录对照 + 首次全量门证据 + 新 profile boot 修复）

对 `iris-plugin-doc-task-boundaries` 下修订版任务书（`DOC-ST-COMPAT-PROGRAM`）的对照结论与本轮后续工作记录。

## 对照检查（修订版任务书 vs 已做工作）

| 修订版要求 | 已做工作 | 结论 |
| --- | --- | --- |
| `PLUGIN_KERNEL_BASE`、P0、P2、落点 2、lockfile 收口为既成历史，不重写 | `2ac0f06` / `30b522c` / `a3d1d9c`（`5aedccc` 合入）/ `ab3da4d`+`e2b8230` / `934ae1c` 均在 `dev/system-plugins` 上 | 一致，无偏差 |
| `dev/st-compat-baseline`、`dev/st-compat-installer` 转只读历史分支 | 两 worktree 保留未再提交（本轮仅在其一跑过只读对照测试） | 一致 |
| `dev/plugin-assets-plane` 为过期占位分支，不得开发 | 本会话从未创建或使用该分支 | 一致 |
| 三任务所有权收口；任务二（`dev/system-plugins`）是集成目标 | 本会话以集成人身份在其上做接线（lockfile、本次 boot 修复），符合 §10「中央文件由集成人修改」 | 一致 |
| 派工须按 §9.2 完整派工单（含完整基线 SHA） | P0 派工单在 `notes/st-compat/README.md`；落点 3 派工单随 `dev/plugin-client-runtime` 首提交落盘 | 本轮起执行 |

## 首次全量门证据（修订版 HEAD，含本轮修复）

- 根 `tsc -p . --noEmit`：通过（exit 0）
- packages 半边：2115 tests，2113 pass，**0 fail**，2 skipped
- apps/iris-web 半边：1736 tests，1735 pass，**0 fail**，1 skipped
- apps/iris 半边：77 tests，69 pass，**0 fail**，8 skipped（skip 均为 IRIS_LIVE/浏览器 opt-in），exit 0
- `npm run test:no-corpus`：40 skipped，0 failed（无 corpus，符合预期），exit 0

## 本轮修复（集成人接线，均在 §10 集成人独占面或本人独占路径）

1. **新 profile 首次 boot 崩溃（阻塞验收的真缺陷，内核基线期即存在）**：`apps/iris/tests/end-to-end.test.ts` 三用例在干净临时数据目录上稳定失败——`SystemPluginRuntime.initialize()` 的 boot 增量写盘（`system-plugins.json`）经 `atomicWriteFile` 落进尚不存在的 profile 根目录；所有 store 的 mkdir 都是「首次写才建」，没有任何人先建 profile 根。修复：`index.ts` 在 `profilePaths` 派生后 `await mkdir(paths.root, { recursive: true })`（boot 先于一切 store 写盘建目录）。已验证 e2e 3/3 通过且干净退出；**此前「apps/iris 成组运行挂死 25 分钟+」与此同根因**（失败 boot 留下未释放句柄拖住 runner），修复后整组 30 秒级跑完。
2. **md 引用卫生**：本会话两个源文件注释里的 `docs/…RUNBOOK.md` 简写被 `md-references.test.ts` 逮住，补全为 `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md`，3/3 通过。

## 剩余事项（更新）

- 下一产品编码任务：**落点 3**，从本轮修复后的 HEAD 新建 `dev/plugin-client-runtime` + 独立 worktree，按 §9.2 派工单开工（快照泛化 / 成员表合并 / 拒跑语义重定 / 宿主扫描接线）。
- 基础设施核验（任务三）与控制面（任务二）归各自所有者；本会话不再在 `dev/system-plugins` 承接独立批次工作区修改，仅保留集成人接线与验收动作。

## 追记二：落点 3 落地（dev/plugin-client-runtime @ 4fab477，已合入）

按修订版任务书 §9.2 派工单（`notes/DISPATCH-plugin-client-runtime.md`，基线 `1e63711`）施工，三个切片一次交付：

- **切片 A（契约）**：`SandboxPluginRuntime` 增 `plugins` 记录（复用落点 2 的 `PluginAssetEntry`）；内建布尔保留为兼容面字段，`plugins` 表达存在性——两者不互相泛化。权威划分：快照决定**是否**收录，清单只回答**字节在哪**；`parsePluginAssetManifest` 对 fetch 响应施加与快照行相同的行规则。
- **切片 B（合并协议）**：核心表 `registerPluginMembers`——准入（bootstrap 在任一插件标签前发布的 `__iris_plugins_admitted__` 记录）、形状、同名冲突（核心名不可遮蔽；跨插件同名点名拒绝，镜像 `IrisRpcHost.register`）；存储按插件命名空间且冻结。收集器为纯模块 `plugin-members.ts`（标签顺序迫使惰性收集）；拒跑语义重定为**每插件**而非整帧：核心表缺席仍全拒，单插件 ready 标记缺席只拒该插件成员并点名原因。
- **切片 C（接线）**：`buildSrcdoc` 按准入行发阻塞标签（bootstrap guard 之后、卡库之前，位置断言进测试）；shell 按快照 revision 取 `/plugins/manifest.json`（`usePluginAssetManifest`，失败为空+具名 console 警告，非致命），清单到达即作为重建依赖拆帧重建；`system-plugins.ts` **零触碰**（清单由落点 2 路由供数，无内核碰撞面）。

集成树全量门（`4fab477`）：web build ✓、check:render ✓、根 tsc ✓、web tsc ✓、packages 半边 2122/2120 pass/0 fail/2 skip、iris-web 半边 1745/1744/0/1、apps/iris 半边 77/69/0/8、no-corpus 40 skip/0 failed、`git diff --check` 净。

剩余事项（更新）：①插件成员的卡面暴露（frame.ts 消费通道）与首个真实插件浏览器面随 P3 试点落地；②插件清单 fetch 失败的用户可见状态归插件中心 UI；③TH/MVU 共享依赖组环境按 RUNBOOK §7 待实测需求裁决；④`dev/plugins-member-merge`（@934ae1c，树净）已被本派工单取代，可由其所有者清理。
