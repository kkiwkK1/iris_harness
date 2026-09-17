# M1 · 可解释 Prompt：技术与施工手册

> 状态：已归档（2026-09-17）。工作已全部落地：#110、#112、#121、#123（四步）。原在分支上、未曾合入；归档为派工记录，不再指导任何工作。

## 0. 一句话

**M1 不换拼装器，只给现有的拼装结果加一层「为什么」。** 今天 `prompt.itemize` 已经能列出每一段进了多少 token；缺的是每一段**为什么**是这个数：内容来自哪里、经过了哪些变换、为什么是 0、进了第几条消息、在稳定前缀还是易变尾部。做完以后，装配面板上每一行都能展开，看到这些答案。

## 1. 先回答那个问题：装配里的「空」正常吗

**正常，而且和 SillyTavern 一致。** 2026-09-16 对 8787 上打开的对话 `爱衣-20260909-001924` 调 `prompt.itemize`：38 行里 23 行 0 token。三类原因，全部实测：

| 类别 | 例子 | 原因 | 证据 |
| --- | --- | --- | --- |
| **预设条目只含宏，宏展开后没有正文** | 初始化(不要关)、狐策~(行动选项)、各「选一」、思维链（多角色内心OS）、自定义1–4 | 这套预设（`[主预设] V19.5 狐神抚 · 毓忻`）是**变量驱动**的：开关条目里全是 `{{setvar::…}}`，只设变量、不出字；正文由后面的条目用 `{{getvar}}` 读出来。「初始化」1250 字符里是 61 个 `setvar`，宏之外的正文为空字符串；「思维链」3288 字符是 1 个巨大的 `setvar`。它们设的变量在 `--开始--`（36 个 `getvar`，1174 token）和 `(别关)注入强调要求`（19 个 `getvar`，3249 token）里变成了正文 | 预设文件 `apps/iris/data/default-user/presets/[主预设] V19.5 狐神抚 · 毓忻.json` 的 `prompts[].content`；ST 也是先 `substituteParams` 再计数（`public/scripts/PromptManager.js:1283`，只读检出），所以 ST 里这些条目同样显示 0 |
| **宿主要填的槽位，这一轮没有东西可填** | Chat Examples、Char Description、Persona Description、Scenario | 这张卡 `爱衣.png` 的 `description`、`personality`、`scenario`、`mes_example` 全部为空（角色内容都在 `first_mes` 与世界书里），也没有人设描述。宿主故意为「本轮没填上的 marker」输出一条 0 行，而不是不显示——因为看面板的人问的正是「我的 X 为什么没进去」 | `packages/iris-app-service/src/prompt.ts` 的 `emptyMarkerRows`（约 `:568`–`:640`，docblock 把理由写全了） |
| **预设自带的自定义 marker 与只含宏的短条目** | 搜索内容注入（marker，宿主没有填充器）、搜索结束（8 字符全是宏） | 同上两条的组合 | 同上 |

两条同样重要的对照事实：**被关掉的条目不列**（严格破限 19617 字符是 `enabled: false`，38 行里没有它），与 ST 一致；**预设里 215 个条目只有 38 行**，也是因为只列启用的。

**所以问题不在数字，在文案。** 面板把 `tokens === 0` 渲染成「空」（`apps/iris-web/src/app/PromptPanel.tsx:310`–`:320`，注释解释了为什么不显示 `0`），但没法说出上面三种「空」的哪一种。让每一行能说出原因，正是 M1 的第一个可交付物（§4 第一步）。

## 2. 现状：已有的东西（不要重造）

| 层 | 符号 | 位置 | 它已经给了什么 |
| --- | --- | --- | --- |
| 拼装结果 | `PromptLayout { system: SystemSegment[], messages: LayoutSlot[] }`，`LayoutSlot { parts: LayoutPart[], role, tail? }`，`LayoutPart { id, label?, text }` | `packages/iris-turn/src/layout.ts:48`、`:106` | 每条最终消息由哪些 part 组成，每个 part 的 id / 标签 / 文本 |
| 贡献项 | `Contribution { id, label?, placement, text }`、`ContributionMember` | `packages/iris-pipeline/src/types.ts:127`、`:141` | 拼装的输入：一段文本和它的落点 |
| 逐项计数 | `itemize(contributions, kept, count, cacheFriendly)` → `AssembledItem[]` | `packages/iris-pipeline/src/assemble.ts:921` | 每个贡献项的 token、成员拆分、deferred / promoted |
| 线上形状 | `PromptItemization { turn, entries: PromptItemEntry[], tokens, actualTokens?, stablePrefixTokens? }`，`PromptItemEntry { id, label, kind, tokens, depth?, role?, deferred?, promoted?, members? }` | `packages/iris-protocol/src/views.ts:1276`、约 `:1210` | **没有文本、没有来源、没有原因**——这就是缺口 |
| RPC | `prompt.itemize({ chatId, turn? })`（有记录用记录，否则现拼一份预览）、`prompt.divergence({ chatId, seq })`（两次请求之间的差异） | `packages/iris-app-service/src/service.ts:2622`、`:2630`；预览在 `#previewItemization`（`:6034`） | 已经区分「记录」与「预览」，已经能比较两轮 |
| 未填 marker 的 0 行 | `emptyMarkerRows` | `packages/iris-app-service/src/prompt.ts:568` | 空槽位会出现，但不带原因 |
| 宏 | `MacroRegistry.expand(text): string` | `packages/iris-macro/src/registry.ts:348` | 只返回结果字符串，**不返回展开记录**——「宏阶段」要有解释就得先给它加一个可选的观察口 |
| 前端 | `PromptPanel.tsx`（500 行）、`itemization.ts`（202 行，行的归约）、`ContextMeter.tsx`（541 行，上下文计量）；store 的 `itemize(turn?)` 与 divergence 动作 | `apps/iris-web/src/app/`、`apps/iris-web/src/client/store.ts:1118` | 面板、计量、差异标记都有；行是不可展开的一行 |
| 测试 | `packages/iris-app-service/tests/itemize.test.ts`（6 条：预览自述、分项求和、记录即拼装、无记录则预览、标签必有、真实数据）及 `assembly-determinism`、`cache-friendly-assembly`、`depth-bucket-entries`、`preset-macros` 等 | | 确定性、求和、稠密度都有断言可扩 |

## 3. 设计：一个投影，不是第二个编译器

### 3.1 铁律

1. **报告从 `PromptLayout` 与现有贡献项派生。** 不允许出现第二条「按自己的理解重新拼一次」的路径——LoomStudio 就死在双轨上。
2. **关掉报告时，发给模型的字节一个都不变。** 用黄金测试钉住：同一输入下，开/关报告采集，`assemble` 的输出逐字节相等。
3. **报告默认不存正文。** 存哈希、token、来源、位置、原因；明文只在本地会话按需从 `LayoutPart.text` 读。日志与 `debug.reports` 里不得出现正文与任何密钥。
4. **确定性。** 同一状态重复生成，去掉时间字段后深度相等（`assembly-determinism.test.ts` 已有同类断言，扩它）。

### 3.2 数据合同（新增到 `@iris/protocol`，向后兼容：全部可选字段）

```ts
/** 一段为什么长成这样：挂在 PromptItemEntry 与 PromptItemMember 上，可选。 */
export interface PromptItemExplanation {
  /** 内容来源。preset 条目 / 卡字段 / 世界书条目 / 历史 / 脚本注入 / 宿主自生成。 */
  source: { kind: 'preset' | 'card' | 'worldbook' | 'history' | 'script' | 'host', id: string, label?: string }
  /** 0 token 时的原因；非 0 时省略。 */
  zeroReason?: 'macros-only' | 'marker-unfilled' | 'blank' | 'trimmed' | 'dropped-by-budget'
  /** 宏阶段：展开了哪些宏头（去重、计数），展开前后的字符数。没有宏则省略。 */
  macros?: { heads: Record<string, number>, charsBefore: number, charsAfter: number }
  /** regex 阶段：命中的规则数与规则名（预设 regex 与脚本 regex）。 */
  regex?: { applied: string[] }
  /** 落点：最终第几条消息、什么角色、深度。 */
  placement: { messageIndex: number, role: string, depth?: number }
  /** 是否在缓存友好拼装的稳定前缀里。 */
  stable?: boolean
  /** 文本内容哈希（sha256 前 12 位），供比较两轮；不是正文。 */
  textHash: string
}
```

`PromptItemization` 增加两个可选字段：`explained?: true`（这份带解释）与 `messages?: Array<{ index, role, tokens, stable?, partIds: string[] }>`（最终消息序列，反向索引）。`PromptItemEntry`、`PromptItemMember` 各加 `explanation?: PromptItemExplanation`。

**为什么全是可选**：旧宿主的记录仍能被新前端解析，新宿主的记录也能被旧前端忽略——这是 `views.ts` 里其他视图已经在用的兼容做法。

### 3.3 采集点（每个都是在**现有**函数里多带一份元数据，不新开路径）

| 阶段 | 采集点 | 加什么 |
| --- | --- | --- |
| 来源 | 贡献项生成处（`packages/iris-app-service/src/prompt.ts` 里 preset 条目 → `Contribution`，卡字段填 marker，世界书桶，脚本注入 `service.ts:7378`/`:7393`） | `Contribution` 增可选 `source`；`emptyMarkerRows` 的 0 行带 `zeroReason: 'marker-unfilled'`；preset 条目展开后为空而原文非空 → `'macros-only'`；原文就空 → `'blank'` |
| 宏 | `MacroRegistry.expand` 增可选第二参 `observer?: (head: string) => void`（或返回 `{ text, heads }` 的新方法 `expandTraced`，旧 `expand` 不动） | 每个 `Contribution` 记录 `macros.heads` 与前后字符数 |
| regex | 预设 regex 与脚本 regex 的应用处（grep `applyRegex` / `preset regex`，`service.ts` 记录 `unrunnable rule(s)` 的那段附近） | 命中的规则名 |
| 落点与稳定性 | `assemble` / `itemize`（`assemble.ts:844`、`:921`）已经知道每个 part 进了哪条消息、是否 promote/defer；缓存友好拼装知道稳定前缀边界 | 填 `placement`、`stable` |
| 预算 | 历史裁剪与预算溢出处（`compaction.test.ts` 覆盖的那条路） | 被裁掉的历史楼层数与 token 数进 `PromptItemization.overflow?`（可选） |

### 3.4 面板（`PromptPanel.tsx`）

- 每一行可展开。展开后按顺序显示：来源（点得开的名字）、0 的原因（一句人话，三种各一句，两语）、宏（「展开了 61 个 setvar，1250 → 0 字符」）、regex 命中、落点（「第 3 条 system 消息 · 稳定前缀」）。
- 顶部加一个「消息视图」切换：按最终 provider 消息列出，每条展开显示它由哪些 part 组成——这是 `messages[]` 反向索引的用处。
- 与 `prompt.divergence` 的差异标记共存：现有 `ItemMark` 不动。
- 明文预览：一个按钮，按需从本地 store 读 `LayoutPart.text`（预览拼装本地就有），**不经过报告**。

## 4. 施工步骤（每步一 PR，能单独合）

**第一步 · 0 的原因（最小可见价值，直接回答 §1）**
1. `@iris/protocol`：`PromptItemEntry.explanation?` 只带 `source` 与 `zeroReason`（先不做宏/regex/落点）。
2. `prompt.ts`：贡献项带 `source`；`emptyMarkerRows` 带 `'marker-unfilled'`。**`'macros-only'` 与 `'blank'` 的判定点已经查清**：`resolvePreset` 的丢弃检查（`packages/iris-preset/src/chat-completion.ts` 里 `const text = textFor(item, markers); if (text.trim().length === 0) continue`）看的是**展开前**的原文，宏展开发生在之后（`prompt.ts:673` 的 `input.substitute ?? expandMacros`），所以只含 `setvar` 的条目原文非空、正常进入贡献项，展开后才变成空文本、计 0 token。因此：原文为空 → 在丢弃点就 `continue`，今天不产生行，`'blank'` 这一类**本轮不补行**（预设作者留白的条目，几十个，对本轮没有信息量，和 `emptyMarkerRows` docblock 的取舍一致）；原文非空、展开后为空 → 在展开处标 `'macros-only'`。对 `爱衣` 这份预设，行数因此不会变（仍 38），只是 0 行多了原因。
3. `PromptPanel.tsx`：`tokens === 0` 的行，「空」后面加原因短句；i18n 两列。
4. 测试：`itemize.test.ts` 加「一个只含 setvar 的 preset 条目标为 macros-only」「一个空 marker 标为 marker-unfilled」「一个原文为空的条目仍不产生行」（钉住本轮不补 blank 行的决定，改了会红）；黄金测试：开关采集，`assemble` 输出逐字节相等。
5. 验收：8787 上对 `爱衣` 的对话，23 个 0 行每一行都有原因；`macros-only` 与 `marker-unfilled` 两种都出现（`blank` 按本轮决定不产生行，所以不会出现）。

**第二步 · 来源与落点**
`placement`、`stable`、`messages[]` 反向索引；面板加「消息视图」。测试：每个最终 part 都能反查到来源，每个来源都能正查到落点（双向覆盖率断言，比较数取下限）。

**第三步 · 宏与 regex 阶段**
`expandTraced`；regex 命中记录；面板展开显示。测试：`preset-macros.test.ts` 扩「61 个 setvar 被记录为 heads.setvar = 61」。

**第四步 · 预算与差异**
`overflow`；与 `prompt.divergence` 联动显示「和上一轮比，这一段是新增/消失/变了」。

## 5. 门禁与验收

- 沿用 `notes/INFRA-TASKS-2026-09-15.md` §0 的门禁：根/前端 tsc、`npm run build`、`npm run check:render`、`npm test`、`npm run test:no-corpus`（40/0）、`md-references`。
- M1 专属：**字节级黄金测试**（采集开/关，`assemble` 输出相等）；**确定性**（去时间字段后深度相等）；**无泄露**（报告 JSON 里不含任何 `LayoutPart.text` 原文、不含 `Authorization`/key）；**双向覆盖率**（第二步）。
- 实机：复制数据目录起宿主，对 `爱衣` 调 `prompt.itemize`，把 38 行导出为 JSON 附在 PR 里；浏览器打开装配面板，截图不入库（对话正文）。

## 6. 记账

- ledger：app-service（协议与采集）下一个空号；web（面板）下一个空号。
- 文档：`docs/OBSERVABILITY.md` §五之二对应项从「部分」改到「已做」并指向这里；`docs/INFRASTRUCTURE-INTERFACES.md` §3 的 `prompt.itemize` 行加「带解释」；`docs/SYSTEM-PLUGINS.md` 不动。
- 与 LoomStudio 审计的关系：本手册是那份报告 §8「Prompt Context Workbench」在 Iris 架构上的独立实现方案；不引用其代码（上游无 LICENSE）。

## 7. 你可能会踩的坑（都踩过）

- 改 `views.ts` 的形状后要跑 `packages/iris-protocol/tests/*.test.ts`，方法数不变，但 `method-names.test.ts` 会重新数。
- `apps/iris-web` 的 `npm run typecheck` 比 `npx tsc --noEmit` 严（U1 就栽在这），以 CI 那条为准。
- 台账追加会和别人的分支冲突：按节序两边保留，不改内容。
- 主 checkout 不要直接改；一 worktree 一分支，PR 到 main，合入前 rebase。
- Python 处理含中文的文件要加 `# -*- coding: utf-8 -*-`；长命令别塞一个 heredoc 里。
