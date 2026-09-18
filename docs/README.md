# 文档地图

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。

本目录的使用与开发文档，加上仓库根的 [README](../README.md) 与
[CONTRIBUTING](../CONTRIBUTING.md)，是一个新读者需要的全部入口。这一页只回答两件事：
**每份文档是干什么的**，以及**按什么顺序读**。它不复述任何一份的内容。

## `docs/` 与 `notes/` 的区别

**`docs/` 是活文档，描述 `main` 上现在的样子。** 一份文档里出现的每句话，都应当在当前
提交上为真；读到一句像计划的话，那是这份文档的缺陷，不是一条待办。源码注释引用它们当作
「为什么有这条规则」的出处，所以行为改了，同一个 PR 里就要改它。

**`notes/` 是有日期的记录**：调查、上游对照、验收单、计划、账本。一条记录写的是**某个时刻**
的事实，它标的提交和日期就是它的有效范围——一个新鲜的数字和一个烂掉的数字排版完全一样，
所以记录**永远不改成和代码一致**：错了就划掉并写清怎么发现的。目录索引见
[notes/README.md](../notes/README.md)。

例外都写在文档自己的开头：本目录里 `GENERATION-HOOKS.md`、
`ST-EXTENSION-DESIGN-AND-RUNBOOK.md` 与 `SANDBOX-PLUGINS.md` 是**设计稿**而不是现状，
各自第一段就说了这件事。

## 读的顺序

1. [项目首页](../README.md) —— Iris 是什么、如何安装和开始使用。
   模型连接、迁移、环境变量与数据目录见[使用手册](USER-GUIDE.md)。
2. [ARCHITECTURE.md](ARCHITECTURE.md) —— 谁可以依赖谁，以及由测试强制的那些不变量。
3. [SANDBOX.md](SANDBOX.md) —— 卡脚本跑在哪里。这是理解界面那一半的前提。
4. [INFRASTRUCTURE-INTERFACES.md](INFRASTRUCTURE-INTERFACES.md) —— 今天可调用的接口面，
   以及 §8 那张**权威缺口表**：任何「这个能用吗」的问题先查它。
5. [SYSTEM-PLUGINS.md](SYSTEM-PLUGINS.md) → [PLUGIN-AUTHORING-RUNBOOK.md](PLUGIN-AUTHORING-RUNBOOK.md)
   —— 插件是什么，然后怎么做一个。

## 文档索引

| 文档 | 它回答什么 |
| --- | --- |
| [USER-GUIDE.md](USER-GUIDE.md) | 模型连接、兼容范围、数据迁移、运行配置与常见问题 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 包的分层与依赖方向，以及 `apps/iris/tests/architecture.test.ts` 强制的每一条不变量 |
| [SANDBOX.md](SANDBOX.md) | 卡脚本沙箱的冻结策略：不透明源 iframe、CSP、能力面、已接受的缺口 |
| [AUTORUN.md](AUTORUN.md) | 卡脚本自动运行的条款：按卡记忆的同意门，以及接线前必须成立的前提 |
| [OBSERVABILITY.md](OBSERVABILITY.md) | 「卡坏掉时谁看得见」的宪章。每条领先对着一个可复核的上游行号 |
| [DEBUG-SURFACE.md](DEBUG-SURFACE.md) | 调试页的宿主半边：宿主已经握着什么，以及够用的最小读取面 |
| [SETTINGS.md](SETTINGS.md) | 设置项的测量与信息架构——包括「改了却静默不生效」的那些 |
| [INFRASTRUCTURE-INTERFACES.md](INFRASTRUCTURE-INTERFACES.md) | 基础设施接口清单：分层、所有权、每个接口的可用状态。§8 是缺口的权威表 |
| [SYSTEM-PLUGINS.md](SYSTEM-PLUGINS.md) | 系统插件的架构裁决：插件是什么、契约包、信任模型、尚未建成的部分 |
| [SYSTEM-PLUGIN-INSTALL.md](SYSTEM-PLUGIN-INSTALL.md) | 包外系统插件的安装路径：安装源约束、钉死的 commit、哈希锁定、具名失败态 |
| [PLUGIN-AUTHORING-RUNBOOK.md](PLUGIN-AUTHORING-RUNBOOK.md) | 做一个插件的执行手册：先决定它跑在哪里，然后逐步交付 |
| [PLUGIN-CONTRACT-PACKAGING.md](PLUGIN-CONTRACT-PACKAGING.md) | 三个契约包怎么变成仓库外能装的 npm 包（`npm run pack:contracts`） |
| [ST-EXTENSION-DESIGN-AND-RUNBOOK.md](ST-EXTENSION-DESIGN-AND-RUNBOOK.md) | **设计稿**：SillyTavern 扩展兼容的设计与施工合同，不是已实现 API 文档 |
| [GENERATION-HOOKS.md](GENERATION-HOOKS.md) | **设计稿**：`beforePrompt` / `afterReplyText` / `onSettle` 三个生成钩子，只设计不实现 |
| [SANDBOX-PLUGINS.md](SANDBOX-PLUGINS.md) | **设计稿**：沙箱插件——玩家一句话、模型写一个插件、热挂进这张卡自己的沙箱帧、按对话持久。与同权的**系统插件**是两回事 |

## 偏离账本

**账本是追加写的记录**，不是文档：一次改动一节，按序号往后加，**旧的节永不重写**。
每一节写清上游怎么做、这里怎么做、以及**代价**——没写代价的「改进」通常只是没被审视过的
偏好。它们条目分两类：**兼容缺口**（我们不如上游，带着「补上要做什么」）与**有意改进**
（我们故意不同，带着代价）。

| 账本 | 管哪一段 |
| --- | --- |
| [notes/apps/iris-web/DEVIATIONS.md](../notes/apps/iris-web/DEVIATIONS.md) | 界面与沙箱侧 |
| [notes/packages/iris-app-service/DEVIATIONS.md](../notes/packages/iris-app-service/DEVIATIONS.md) | 宿主应用层 |
| [notes/packages/iris-rpc-host/DEVIATIONS.md](../notes/packages/iris-rpc-host/DEVIATIONS.md) | 传输层与 `Host` 白名单 |
| [notes/packages/iris-compat-prompt-template/DEVIATIONS.md](../notes/packages/iris-compat-prompt-template/DEVIATIONS.md) | EJS 模板兼容层 |
| [notes/packages/iris-variables/DEVIATIONS.md](../notes/packages/iris-variables/DEVIATIONS.md) | 变量系统的写入面 |
| [notes/DEVIATIONS.md](../notes/DEVIATIONS.md) | 预设功能（任务 M，对照 ST 1.18.0） |

前五本用 `## N. 标题` 编号（`iris-compat-prompt-template` 的十二节在 `## Deviations`
下面一级），第六本按主题分节、节内编号。引用一节写成「host §71」「web §101」这样的短形，
仓库里到处都是这个写法。

## 维护规则

- **改了行为的 PR，同一个 PR 里改掉管这段行为的那份文档，并追加一节账本。** 两件事都做，
  因为它们服务不同的读者：文档回答「现在是什么样」，账本回答「为什么和上游不一样」。
- **记录永不为了迁就代码而被改写。** 一条记录错了就划掉、写清怎么发现的；把它悄悄改对，
  等于把「我们当时是这么想的」这条唯一的证据删掉。
- **被行为依赖的测量前提，配一个会自己失败的测试。** 散文讲道理，测试押前提——一个烂掉的
  数字和一个新鲜的数字在页面上长得一模一样。
- **链接和 `路径:行号` 引用都会被检查。** `apps/iris/tests/md-references.test.ts` 扫三类
  引用（markdown 链接、`路径:行号` 引用、源码注释里提到的 `.md`），指向树上不存在的文件
  就红。
