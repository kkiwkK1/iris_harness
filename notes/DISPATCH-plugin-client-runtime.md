# 派工单：落点 3 —— 插件客户端运行环境（快照泛化 + 成员表合并 + 拒跑语义重定）

按 `docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md`（`DOC-ST-COMPAT-PROGRAM`，2026-09-13 修订版）§9.2 模板原样补全：

```text
任务：落点 3（notes/PLUGIN-CONTRACT-LANDING-SITES.md §3：SandboxPluginRuntime 快照泛化、dsh.client 清单扫描的壳侧消费、成员表合并协议、拒跑语义重定），承接落点 2 已显式移交的壳侧消费
基线：dev/system-plugins @ 1e63711d9926496d873294fc0612df8fe3d1e9f4（验收后集成基线：全量门首次全绿 + 新 profile boot 修复，证据 notes/st-compat/CONSTRUCTION-REPORT-2026-09-13.md 追记）
工作分支：dev/plugin-client-runtime
worktree：D:/workspace/小项目/iris-plugin-client-runtime
负责人：本会话施工代理（集成人兼本任务浏览器面施工；修订版任务书指定本分支为本任务唯一分支）
允许修改：packages/iris-plugin-web-api/**；apps/iris-web/src/sandbox/**（members-contract/members-entry/frame-entry/srcdoc 等）；apps/iris-web/src/app/useCardScripts.tsx、MessageInterfaces.tsx（重建 effect）；apps/iris-web/tests/**；packages/iris-app-service/src/system-plugins.ts 的激活快照接线段（见下方所有权注记）；tests/fixtures/**
禁止并行修改：dev/plugins-member-merge（D:/workspace/小项目/iris-member-merge，@934ae1c，树净、零提交）与本任务范围重叠且基线落后（缺 1e63711 boot 修复）——按任务书「基线必须是验收后的当前 HEAD」与分支指定，该占位分支由本派工单取代；其所有者请勿在此范围开工。system-plugins.ts 其余区段、protocol/rpc-host/client/契约包（内核负责人独占）未经接线子任务不得触碰
依赖任务/必须先合入：落点 1（rpc-registry，2ac0f06 内）、落点 2（/plugins 资产面，ab3da4d）均已合入；P0 已锁定
合并目标与顺序：完成后合入 dev/system-plugins；与内核负责人的并行工作冲突由集成人在合并窗口处理
验证命令：根 npx tsc -p . --noEmit；node --test packages/iris-plugin-web-api/tests/*.test.ts apps/iris-web/tests/*.test.ts packages/iris-app-service/tests/system-plugins*.test.ts；收口时按 RUNBOOK §11 全套门
交付物与验收场景：快照 plugins 记录 + 编解码校验；registerPluginMembers + 每插件 ready 标记；同名成员拒绝并点名；core 缺席全拒、单插件缺席只拒该插件成员；停用/重载循环下旧成员不复活；对齐 notes/SYSTEM-PLUGINS-HANDOFF.md:67-71 生命周期检查单
```

## 所有权注记（§9.1 接线子任务规则）

`system-plugins.ts` 是内核负责人独占文件。本任务对它的触碰限定为：激活时把已启用插件的资产条目（id → rev/client URL）并进浏览器快照的接线点，改动保持加法式；若内核负责人正在重写该文件，此处停手，改为派独立接线子任务。

## 施工顺序（每步测试绿后再进）

1. **切片 A**：`@iris/plugin-web-api` 快照泛化——`SandboxPluginRuntime` 增 `plugins: Record<string, { rev: string, client: string }>`；编解码按现有校验风格补分支；TH/MVU 布尔门不动；meta 体积实测（frame-budget 4 KiB 包装层预算）。
2. **切片 B**：成员表合并协议——`members-contract.ts` 增每插件 ready 契约名；`registerPluginMembers(pluginId, members)`；同名拒绝并点名插件（镜像 rpc-host 重复注册语义）；`frame-entry.ts` 拒跑语义重定（core 缺席→全拒原样；插件缺席→只拒该插件成员并报可定位错误）。
3. **切片 C**：宿主接线 + srcdoc 标签——快照并入 `plugins` 条目；`buildSrcdoc` 在成员表后、引导前插入 `data-iris-plugin` 标签（crossorigin，复用落点 2 的 rev 键控 URL）；`useCardScripts` 重建 effect 依赖核对；停用→销毁重建循环测试。
