# notes/st-compat —— ST 兼容施工的 P0 基线与试点清单

派工单（`docs/ST-EXTENSION-DESIGN-AND-RUNBOOK.md` §9.2 模板，原样补全）：

```text
任务：P0 基线与试点清单（RUNBOOK §9 批次 P0）
基线：dev/system-plugins @ 2ac0f064eb939dcc2b5a963b4d7fbacb53c871d1（PLUGIN_KERNEL_BASE）
工作分支：dev/st-compat-baseline
worktree：D:/workspace/小项目/iris-st-compat-baseline
负责人：集成人（本会话施工代理承担；后续派工在此登记）
允许修改：notes/st-compat/**（锁定记录、勘察脚本、报告、用例）
禁止并行修改：P1 独占面（protocol、rpc-host/client、契约包、system-plugins.ts）及一切产品代码——P0 零产品代码修改
依赖任务/必须先合入：无（P0 无前置）
合并目标与顺序：先合入 dev/system-plugins；产出试点锁定 commit 后 P1/P2 方可并行开工
验证命令：node notes/st-compat/survey/survey-st-extension.mjs <ext-dir>（只读；报告为唯一写出物）；合入时由集成人跑仓库门（§11）
交付物与验收场景：pilot-lock.md（四对象版本/commit/hash/许可证）、survey/（脚本+ST-Prompt-Template 报告）、pilot-use-cases.md（无 UI ×2、UI ×1）
```

## 文件索引

| 文件 | 内容 |
| --- | --- |
| [pilot-lock.md](pilot-lock.md) | ST / TH / MVU / ST-Prompt-Template 的版本、commit、sha256、许可证与本机状态；manifest 读取语义对齐表；获取边界 |
| [pilot-use-cases.md](pilot-use-cases.md) | P3 试点的无 UI / UI 验收剧本（UC-1 展开模板、UC-2 回复更新变量、UC-3 设置面板） |
| [survey/survey-st-extension.mjs](survey/survey-st-extension.mjs) | 只读勘察脚本：manifest 字段核对、入口哈希、树清点、静态 import 分类（regex 首过，P2 换解析器）、Worker 站点 |
| [survey/st-prompt-template.report.json](survey/st-prompt-template.report.json) | 上述脚本对锁定试点的输出（证据，非结论） |

## 勘察口径

- 本机事实源只读：`E:/sillyTavern/SillyTavern`（ST `51ad27fb8`）与其下 `third-party/ST-Prompt-Template`（`f9a07da`）；不读 `secrets.json`，key 不打印。
- 上游 TH/MVU 的 commit 取自 GitHub API 快照（2026-09-13），无本机副本；P4/P5 按锁定 commit 取历史版本，jsdelivr 浮动引用不作锁定源。
- 静态 import 是 regex 首过：specifiers 经字符集过滤、歧义尾名保留不裁决；“完全兼容”的结论只能出自 P2 的解析器与依赖图，本目录不提供。
