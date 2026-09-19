<p align="center">
  <img src="../assets/brand/iris-story-seal-variant-c-transparent-v1.png" width="72" alt="Iris">
</p>

<h1 align="center">项目架构</h1>

<p align="center">宿主掌管状态，浏览器负责呈现，扩展沿契约接入。</p>

<p align="center">
  <a href="../README.md">项目首页</a> ·
  <a href="README.md">文档目录</a> ·
  <a href="USER-GUIDE.md">使用手册</a>
</p>

---

## 运行方式

Iris 是本地优先的 AI 角色扮演应用。Node.js 宿主管理角色、聊天、生成、文件与插件；浏览器通过 RPC 发起操作，通过事件接收更新。

```text
浏览器界面
   │ RPC / 事件
   ▼
RPC 宿主 → 应用服务 → 领域模块
                  ├─ 模型连接
                  ├─ 本地存储
                  └─ 系统插件
```

卡片脚本运行在浏览器的隔离 iframe 中，系统插件运行在宿主中。两者不是同一套权限模型，详见[脚本沙箱](SANDBOX.md)和[系统插件](SYSTEM-PLUGINS.md)。

## 目录与职责

| 位置 | 职责 |
| --- | --- |
| `apps/iris/` | 宿主入口、配置与服务组装 |
| `apps/iris-web/` | 浏览器界面、主题、卡片运行环境 |
| `packages/iris-app-service/` | 串联聊天、生成、存储与插件生命周期 |
| `packages/iris-rpc-host/`、`iris-rpc-client/` | 请求校验、方法分发与浏览器传输 |
| `packages/iris-protocol/` | 请求、响应与事件的共享格式 |
| `packages/iris-character/`、`iris-chat/`、`iris-lorebook/` 等 | 角色、聊天、世界书等领域能力 |
| `packages/iris-compat-*/` | SillyTavern、酒馆助手和提示词模板兼容层 |
| `packages/iris-plugin-api/`、`iris-plugin-web-api/` | 插件作者使用的宿主与浏览器契约 |

## 依赖方向

依赖从入口流向应用服务，再流向领域模块。领域模块不反向引用 `app-service`、`rpc-host` 或应用入口，也不通过间接引用绕过分层。

| 边界 | 约束 |
| --- | --- |
| `@iris/protocol` | 不依赖 Iris 领域包；与持久化结构相似的类型可以独立声明 |
| `@iris/text` | 不依赖其他 Iris 包 |
| `@iris/plugin-api` | 无 Iris 运行时依赖；Cordis 仅作类型引用 |
| `@iris/plugin-web-api` | 通过类型引用使用 protocol，不把宿主代码带入浏览器 |
| Web 源码 | Iris 依赖限于 `protocol`、`rpc-client`、`client-fake`、`compat-tavernhelper-core`、`text`、`plugin-web-api` |
| 世界书与宏 | 不引用 `compat-tavernhelper-core` |
| 酒馆助手兼容层 | 不引用 `mvu`；通过能力接口协作 |
| 生产宿主 | 不依赖 `client-fake` |

依赖检查应包含源码：前端使用 Vite 别名，仅检查 `package.json` 不能发现所有越界引用。

## 状态与生命周期

- **宿主是最终状态来源。** 浏览器可以展示流式增量，但 `stream.end` 到达后应使用宿主投影替换临时状态。
- **渲染身份与地址分开。** 稳定的 `key` 用于界面复用；`id` 用于请求和定位，不能互相替代。
- **注册必须可撤销。** Cordis 插件的监听、能力与资源随生命周期释放；禁用和重载不能留下上一轮注册。
- **失败必须可见。** 拒绝操作使用明确的错误，不用 `undefined` 或假成功掩盖未实现能力。

配置按 profile 隔离；这不等于已有浏览器内的 profile 切换器。同一数据目录只允许一个宿主进程，详见[使用手册](USER-GUIDE.md)。

## 兼容的含义

Iris 以真实角色卡和上游格式为依据，不以“能解析”代替“能运行”。兼容层会保留必要的拼写、字段位置和行为差异；修复看似不合理的行为前，先确认是否会改变现有卡片的结果。

真实卡片语料不入库。CI 使用公开夹具，本地兼容性验收需要另外记录卡片、步骤和结果；夹具通过不代表所有卡片可用。兼容范围见[使用手册](USER-GUIDE.md#兼容范围)。

## 构建与扩展

根工作区使用 pnpm，`apps/iris-web` 使用 npm 与独立锁文件。保持这一分工，避免改变前端构建依赖的解析方式。

静态业务 RPC 集中声明和注册；系统插件可通过受生命周期管理的接口注册动态 RPC。插件能力、浏览器成员和安装状态仍归同一控制面管理，不另建平行注册表。

- 开始开发：[参与贡献](../CONTRIBUTING.md) · [前端开发](../apps/iris-web/README.md)
- 编写插件：[插件开发指南](PLUGIN-AUTHORING-RUNBOOK.md)
- 查找接口与限制：[接口参考](INFRASTRUCTURE-INTERFACES.md)，尤其是第 8 节的能力缺口
