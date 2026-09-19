<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">文档目录</h1>

<p align="center">从第一次对话，到为 Iris 添上一项能力。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

## 从这里开始

| 我想…… | 阅读 |
| --- | --- |
| 安装并开始聊天 | [项目首页](../README.md) |
| 配置模型、导入酒馆数据、排查使用问题 | [使用手册](USER-GUIDE.md) |
| 了解卡片脚本什么时候运行 | [脚本授权与运行](AUTORUN.md) |
| 确认脚本能访问什么 | [脚本沙箱](SANDBOX.md) |
| 安装、更新或卸载系统插件 | [系统插件安装](SYSTEM-PLUGIN-INSTALL.md) |

## 开发与扩展

| 文档 | 内容 |
| --- | --- |
| [参与贡献](../CONTRIBUTING.md) | 开发环境、检查命令与提交约定 |
| [项目架构](ARCHITECTURE.md) | 分层、依赖方向与运行原则 |
| [前端开发](../apps/iris-web/README.md) | 浏览器端启动、构建、主题与调试 |
| [插件开发指南](PLUGIN-AUTHORING-RUNBOOK.md) | 最小插件、生命周期、打包与验证 |
| [接口参考](INFRASTRUCTURE-INTERFACES.md) | 已有接口、RPC 索引与尚未提供的能力 |
| [系统插件](SYSTEM-PLUGINS.md) | 控制面、依赖与信任模型 |
| [插件契约打包](PLUGIN-CONTRACT-PACKAGING.md) | 独立仓库使用的契约包 |
| [设置](SETTINGS.md) | 设置的归属、默认值与持久化 |
| [可观测性](OBSERVABILITY.md) · [调试入口](DEBUG-SURFACE.md) | 诊断事件、日志与排错 |

第一次读代码，建议按「架构 → 对应模块 → 接口参考」的顺序；编写插件则直接从插件开发指南开始。

## 沙箱插件

[沙箱插件设计](SANDBOX-PLUGINS.md)记录设计与分阶段实现；[沙箱插件编写契约](SANDBOX-PLUGIN-AUTHORING.md)供模型编写插件时读取，包含门面、限制与示例，受 8 KiB 上限和签名一致性检查约束。沙箱插件在卡片帧内运行，与宿主同权的系统插件不同。

## 设计稿与历史记录

[生成钩子](GENERATION-HOOKS.md)与 [ST 扩展设计](ST-EXTENSION-DESIGN-AND-RUNBOOK.md)包含设计内容，**不代表其中的能力已经可用**。实现范围以接口参考和源码为准。账本章节编号也由文档测试检查唯一性，不要求连续或递增。

`docs/` 维护当前用法；[`notes/`](../notes/README.md)保存带日期的调查、决策和验收记录。行为变化时同步更新使用文档，历史结论用补充记录更正，不改写成今天的状态。

<a id="偏离账本"></a>

<details>
<summary>各模块的差异与验收记录</summary>

- [前端](../notes/apps/iris-web/DEVIATIONS.md)
- [应用服务](../notes/packages/iris-app-service/DEVIATIONS.md)
- [RPC 宿主](../notes/packages/iris-rpc-host/DEVIATIONS.md)
- [提示词模板](../notes/packages/iris-compat-prompt-template/DEVIATIONS.md)
- [变量](../notes/packages/iris-variables/DEVIATIONS.md)
- [仓库总账](../notes/DEVIATIONS.md)

</details>

---

许可与来源见 [第三方说明](../THIRD-PARTY-NOTICES.md)；Iris 的许可证原文见 [LICENSE](../LICENSE)。
