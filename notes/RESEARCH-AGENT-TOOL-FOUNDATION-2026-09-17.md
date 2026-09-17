# 技术摘要 · Agent Tool Foundation 的只读工具部分（审计方案二，M2 里程碑）

> 状态：记录。写于 2026-09-17，基线 `main` `7011d6f`。给 owner 判断「要不要开、先开哪一块」用的摘要，**不是任务单，代码层面不做任何修改**。来源是 2026-09-16 的 LoomStudio 审计报告 §5.5 / §9 / §14 / §15（报告本体在仓库外，已按 owner 决定不入库）；LoomStudio 上游无 LICENSE，本文只用公开思想，不引用其源码。

## 1. 一句话

让模型在一轮生成里**调用 Iris 提供的只读工具**（读当前上下文摘要、搜世界书、读变量），结果回灌给模型再继续；Iris 记下每次调用与结果，界面上能看见。**不写任何东西**：不改聊天、不改变量、不碰外部系统。这是审计路线图的阶段 3+4，里程碑 M2「只读 Agent」。

## 2. 我们已经有的，和差的

| 需要的部件 | 现状 | 差什么 |
| --- | --- | --- |
| 解析模型的工具调用 | `packages/iris-llm-openai-compat/src/translate.ts:203` 已解析流式 `delta.tool_calls`，`finish_reason: tool_calls` 映射到 `{ kind: 'tool-calls' }`（`:79`） | 解析到之后**没有人接**：没有执行循环，一轮到 `tool-calls` 就结束 |
| 往请求里放工具定义 | 无 | request 的 `tools[]` 字段（OpenAI 兼容面）和「哪些工具挂给这次生成」 |
| 生成过程的插入点 | U4 生成钩子设计已裁决（`docs/GENERATION-HOOKS.md`：`beforePrompt` / `afterReplyText` / `onSettle`，22 个固定点已清单），**实现未开始** | 工具循环需要的是第四类点：「模型停在 tool-calls 之后、下一次 provider 调用之前」。U4 的三个钩子都不在这个位置，但它的注册口、超时、取消、释放、`hook-failed` 那套失败语义可以直接复用 |
| 工具能读的数据 | RPC 面已有：`worldbook.get / load / charDigest / names`（28 个 worldbook 方法）、`script.getVariables`、`prompt.itemize`（M1 的可解释装配报告）、`chat.open` | 这些是给壳用的宿主 RPC；工具要的是**窄口**（一个 handler 只能读一件事），不能把 RPC 面整个交给模型 |
| 插件声明权限 | `PLUGIN_PERMISSIONS`（`manifest.ts:103`）六个词：`get-dependency` `host-context` `plugin-storage` `provide-capability` `register-rpc` `write-variables`；只有 `plugin-storage` 是有后果的边界 | 若允许插件提供工具，要加一个词（比如 `provide-tool`），并决定它是声明还是边界 |
| 审计与展示 | M1 已有装配报告和消息视图；诊断面有 `debug.reports` | 工具调用的「提案 → 执行 → 结果」事件流，和一个能看的面 |
| ST 兼容 | ST 自己有 `public/scripts/tool-calling.js`（`registerFunctionTool`，卡脚本可注册函数工具）；Iris 的 `getContext()` 面里 `registerFunctionTool` 目前是「未建，具名报缺」（REVIEW-2 §6） | 这是**地板**要求：ST 的卡能注册工具，Iris 迟早要接；只读阶段可以先不接卡的工具，但设计要留位 |

## 3. 审计建议的形状（三分模型），翻成 Iris 的话

- **Tool Definition**（工具是什么）：id、给模型看的名字和描述、输入 schema、副作用等级（`none` / `chat` / `state` / `external`）、审批策略。只读阶段全部 `none` + 免审批。
- **Tool Mount**（这次生成挂哪些）：按 preset 或按对话开关；顺序；投影方式只做 `native`（OpenAI 兼容的 function calling），**不做**文本标记式的 content fallback（审计 §14.4 明确不建议作主协议）。
- **Tool Handler**（谁执行）：Iris 自己的只读 handler，跑在宿主里，拿 `{ signal, chatId, candidateId, actor, idempotencyKey }`；Cordis fiber dispose 时取消未完成调用。

执行循环：provider 停在 `tool-calls` → 记 `tool/proposed` → 执行（30 s 超时、可 abort）→ 记 `tool/result` 或 `tool/failed|timed-out|aborted` → 以 `role: tool` 消息回放 → 再调 provider，最多 N 步（审计用 8）。

## 4. 与 ST JSONL 的边界（这是最要先定的一条）

可见的 assistant/user 文本仍写现在的 ST 兼容 `jsonl`；工具调用、结果、provider 观察写 **Iris 自己的 sidecar**（对话旁边的事件文件）。工具关掉时聊天文件与今天逐字节等价；sidecar 丢了对话仍能读，界面提示「审计信息不完整」。ST 导入导出往返不受影响——这一条要有测试钉住，因为它就是「Iris 是升级不是替代」在这件事上的具体形态。

## 5. 分步（审计 §9.4 / §15）

1. **阶段 3 · 基础**（L，中高风险）：Definition / Mount / Handler 三张表、执行循环、事件流、sidecar、超时/取消/释放。这是主要工作量，也是唯一有架构决定的一步。
2. **阶段 4 · 只读官方工具**（M，低中风险）：三个 handler——当前上下文摘要（可直接由 `prompt.itemize` 的报告派生）、世界书搜索（`worldbook.*` 的窄口）、变量读取（`script.getVariables` 的窄口）。
3. 之后才是写工具、审批、idempotency（M3），本摘要不涉及。

## 6. 风险与我的判断

- **provider 面**：只有 OpenAI 兼容 translator 一条路解析 `tool_calls`；其他 provider 形状（Anthropic `tool_use`、Gemini `functionCall`）现在有没有 translator 要先查，没有的先不支持，报「该 provider 不支持工具」。
- **恶意输出**：模型给的工具名、参数都是不可信输入——schema 校验失败是确定性的失败结果，不是异常；结果回灌前要转义，不能进 system/developer 消息。
- **与 U4 的关系**：U4 的钩子实现还没开始。工具循环和 U4 共用注册口与失败语义最合理，所以**顺序上 U4 实现在前、工具循环在后**，或者两者一起设计再一起实现；单独先做工具循环会造出第二套注册/超时/释放。
- **卡的工具**（ST `registerFunctionTool`）：地板要求，但它带着「卡脚本 = 不可信」的身份，与 Iris 官方只读工具不是一类。只读阶段不接，设计时给 Definition 留一个 `origin: 'iris' | 'plugin' | 'card'` 字段就够。
- **规模**：阶段 3+4 合计约等于 U1–U6 那一批的量级；需要先出一份和 `docs/GENERATION-HOOKS.md` 同规格的设计稿并裁决十几个问题，再派施工。

## 7. 要你决定的

1. 开不开 M2；开的话是「先 U4 实现，再工具循环」还是「合并设计、一起实现」。我倾向合并设计。
2. sidecar 的位置和格式（对话旁的 `.events.jsonl`？还是数据目录下独立目录），这决定备份/导出怎么带它。
3. 第一批只读工具就三个，还是加「读当前角色卡字段」（ST 的 `getCharacterCardFields` 也在缺件名单里，一石二鸟）。

你点头哪一条，我出设计稿；不点头，这份摘要就是记录，放着。
