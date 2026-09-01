# 楼层变量 —— 设计输入

卡在沙箱里拿每条消息的变量，两条路都不通：`getVariables({type:'message', message_id})`
被具名拒绝，`getChatMessages()[i].data` 字段缺失。这份文档是那个缺口的设计输入，
派生 72 的宿主活与 f7 的门面活。

**这是设计输入不是规格**：给出建议方案与上游的逐字证据，实现形状由实现者定。

测量日期 2026-09-02。上游对照 JS-Slash-Runner 4.9.1 与 SillyTavern 1.18.0 本机检出。

## 口径

- 标 **[上游]** 的行号在 `data/default-user/extensions/JS-Slash-Runner/src/` 或
  `public/` 下，可复核。
- 标 **[本仓库]** 的行号是写作时的状态。
- **只记形状，不记内容。**MVU 的 `stat_data` 里是卡的叙事状态，本文档一个值都不引。

---

## 一、结论：数据已经在 frame 里了

**两半缺口都可以在不新增任何传输的前提下关掉。**

[本仓库] `context.ts:96` 已经把整份聊天发进快照：

```ts
chat: entry.toFile().messages,
```

而 [本仓库] `entry.ts:675-686` 的 `toFile()` 会把每楼的候选变量数组挂在消息行上，
挂在**上游放它的同一个位置**：

```ts
// 注释原文：Per-candidate variables are attached where SillyTavern keeps them —
// `chat[i].variables[swipe_id]`, an array parallel to `swipes`
line['variables'] = saved.map(variables => variables ?? {})
```

`SillyTavernMessage` 有 `[key: string]: unknown` 索引签名
（[本仓库] `packages/iris-persistence/src/sillytavern.ts:53`），所以 `variables`
作为未建模字段原样通过，且 `swipes` / `swipe_id` 都在（`:51-52`）。

**所以 `snapshot.chat[i].variables[snapshot.chat[i].swipe_id ?? 0]` 就是上游
`getVariables({type:'message', message_id: i})` 与 `getChatMessages()[i].data`
共同的那一份。**同步可读，不需要往返。

---

## 二、上游行为：逐字证据

### 2.1 存在哪（问题 1）

**唯一真相是 `chat[i].variables`——一个与 `chat[i].swipes` 平行、按 `swipe_id` 索引的
数组。**没有第二处存储。

`getChatMessages` 的两个字段都从它派生，[上游] `function/chat_message.ts:120-131`：

```ts
const swipe_id = message?.swipe_id ?? 0;
let swipes: string[] = message?.swipes ?? [message.mes];
let swipes_data: Record<string, any>[] = message?.variables ?? [{}];   // ← 就是它
const swipe_length = swipes.length;
swipes_data = _.range(0, swipe_length).map(i => swipes_data[i] ?? {}); // 补洞到 swipes 长度
const data = swipes_data[swipe_id];                                    // ← 当前候选那一格
```

- **`swipes_data` === `message.variables`**，长度被归一到 `swipes.length`，空洞填 `{}`
- **`data` === `swipes_data[swipe_id]`**
- **切 swipe 时什么都不复制**：`swipe_id` 变了，`data` 就解析到数组的另一格

一个容易踩的不对称，[上游] `:133-157`：

| 调用 | 返回里有 `data` 吗 | 有 `swipes_data` 吗 |
| --- | --- | --- |
| `include_swipes: false`（默认） | ✅ | ✅（注释标 `// for compatibility`） |
| `include_swipes: true` | **❌ 没有这个字段** | ✅ |

### 2.2 读路径（问题 2）

[上游] `function/variables.ts:58-71`：

```ts
case 'message': {
  const normalized_message_id =
    option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id;
  if (!_.inRange(normalized_message_id, -chat.length, chat.length)) {
    throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 [${-chat.length}, ${chat.length})`);
  }
  let chat_message;
  if (option.message_id === undefined || option.message_id === 'latest') {
    chat_message = chat.filter(chat_message => !chat_message.is_system).at(normalized_message_id);
  } else {
    chat_message = chat.at(normalized_message_id);
  }
  return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
}
```

| 问 | 答 |
| --- | --- |
| 缺省时取哪楼 | `-1`，**但先滤掉 `is_system` 再取**（`:66`） |
| 显式数字 | `chat.at(id)`，**不滤**（`:68`）；负数是深度索引 |
| 越界 | **抛错**，消息里带出合法区间 `[-chat.length, chat.length)` |
| 和 `data` 是同一份吗 | **是。**两者都是 `variables[swipe_id] ?? {}` |

⚠️ **`'latest'` 与显式数字的索引基准不同**（滤 vs 不滤 `is_system`）。这是上游的既有
不一致，按兼容层原则照搬，不要「修好」。

### 2.3 写路径（问题 3）

**四个写函数全部漏斗进 `replaceVariables`**，[上游] `function/variables.ts`：

```
updateVariablesWith(:211)      → replaceVariables(:218 / :226)
insertOrAssignVariables(:241)  → updateVariablesWith(:244)
insertVariables(:261)          → updateVariablesWith(:264)
deleteVariable(:281)           → （同族）
```

`replaceVariables({type:'message'})` 的完整动作，[上游] `:130-149`：

```ts
option.message_id = option.message_id === undefined || 'latest' ? -1 : option.message_id;
if (!_.inRange(...)) throw ...
const chat_message = chat.at(option.message_id);              // ← 写侧 'latest' 不滤 is_system
if (!_.has(chat_message, 'variables'))
  _.set(chat_message, 'variables', _.times(chat_message.swipes?.length ?? 1, _.constant({})));
// 与提示词模板的兼容性
if (_.isPlainObject(_.get(chat_message, 'variables')))
  _.set(chat_message, 'variables',
    _.range(0, chat_message.swipes?.length ?? 1).map(i => chat_message.variables[i] ?? {}));
_.set(chat_message, ['variables', _.get(chat_message, 'swipe_id', 0)], variables);
saveChatConditionalDebounced();
```

四条要点：

1. **写到 `chat[id].variables[swipe_id]`**，与读同一处。
2. **保存会触发**：`saveChatConditionalDebounced = _.debounce(saveChatConditional, 1000)`
   （[上游] `util/tavern.ts:68`）——**1 秒防抖**，不是立即落盘。
3. **写前有一次形状归一**：`variables` 是普通对象时转成按 swipe 索引的数组。注释写明
   理由是「与提示词模板的兼容性」——**ST-Prompt-Template 会把它写成对象**。
4. **写侧的 `'latest'` 不滤 `is_system`，读侧滤**。聊天里有系统消息时，读写的
   `'latest'` 指向不同楼层。这是上游的不一致，照搬。

合并规则（[上游] `:244` / `:264`）：

```ts
insertOrAssignVariables: _.mergeWith(old, new, (l, r) => _.isArray(r) ? r : undefined)
                         → 深合并，但数组整体替换
insertVariables:         _.mergeWith({}, new, old, ...)
                         → 注意参数序：old 在后所以 old 赢 = 「不存在才插入」
```

---

## 三、映射表（问题 4）

| 上游 | 本仓库 | 关系 |
| --- | --- | --- |
| `chat[i].variables[swipe_id]` | `iris/variables` 事件，按 `candidateSeq` 键 | **不是一一对应**——见下 |
| `swipes_data`（数组，位置寻址） | 同一楼各候选的事件（身份寻址） | 语义等价，寻址方式不同 |
| `data` | `entry.floorVariables(messageId)` | **语义等价**：都取「当前选中候选」那一份 |
| `getVariables({type:'message'})` 缺省 | `entry.currentVariables()` → `ScriptContext.variables` | 对齐（但见风险 3） |
| `getAllVariables` 的四层 | `ScriptContext.variableLayers` 四层未合并 | **一一对应** |
| 无 | prune 记录（`applyPruned`） | **我们多的一层** |

### 别在映射里丢掉的升级点

上游按 **(楼层, swipe 下标)** 存，我们按 **候选身份（`candidateSeq`）** 存。

这不是实现细节的差异，是 swipe 一致性的来源：**候选身份是铸造的，不是从位置推导的**，
所以「切 swipe 时状态不串」在我们这里是**结构上不可能出错**，而上游是靠两个数组保持
平行来维持的。导出时 `toFile()` 把身份寻址翻译回位置寻址（[本仓库] `entry.ts:684`），
互通性因此不受影响。

`floorVariables` 的两条语义也要守住（[本仓库] `entry.ts:786-804` 与
`packages/iris-protocol/src/views.ts:270-286`）：

- **不向前继承**：没写过变量的楼报空表，不报「它能够到的最新状态」。继承会让锚定
  变成装饰。
- **跟随选中的候选**，不是跟随最新的。

---

## 四、建议方案

### 4.1 快照该带什么：**已经够了，只差一个标签**

`snapshot.chat` 里每个 assistant 行已经带 `variables` 数组和 `swipe_id`。门面可以
**同步**回答任意楼层：

```
snapshot.chat[i].variables?.[snapshot.chat[i].swipe_id ?? 0] ?? {}
```

这正好是上游 `:70` 那一行的形状。

**不建议**给快照新增「全部楼层变量表」——那是第二份真相，且与 `chat` 冗余。
**建议**只补一件事：让门面知道 `'latest'` 该落在哪一楼，即把 `floor.messageId` 的
语义从「message frame 才有」推广为「快照总是知道当前最新楼是哪一楼」，或者由门面
按上游规则自己算（滤 `is_system` 后取 `-1`）。后者不需要改协议。

### 4.2 门面 `data` 从哪读：同一处

`getChatMessages` 已经从 `snapshot.chat` 组装。补 `data` 与 `swipes_data` 只是照
[上游] `chat_message.ts:120-131` 补两行派生，**零新增传输**：

```
swipes_data = message.variables ?? [{}]，长度归一到 swipes.length，空洞填 {}
data        = swipes_data[swipe_id]
include_swipes: true 时不发 data（照抄那个不对称）
```

### 4.3 写路径走哪条 RPC

写必须回宿主（frame 只有快照的副本）。建议**复用已有的变量写通道**，按
`(messageId, 候选)` 定位而不是 `(messageId, swipe 下标)`——因为我们的存储是身份寻址，
而门面拿到的 `swipe_id` 是位置。**位置→身份的翻译归宿主**，理由是身份只有宿主知道，
让门面翻译等于把铸造规则泄漏给不受信的一侧。

上游的四个写函数**全部漏斗进 `replaceVariables`**，所以我们只需要一条「替换某楼某候选
的整张表」的 RPC，其余三个（`updateVariablesWith` / `insertOrAssignVariables` /
`insertVariables`）在门面按上游的合并规则本地算完再调它——**与上游的分层完全一致**。

**保存语义**：上游是 1 秒防抖。我们如果每次写都落盘会比上游更重；如果不落盘会丢。
建议对齐防抖，并把「防抖窗口内 frame 被卸载」列为必须有声音的一类（参见
`OBSERVABILITY.md` 的遗言通道）。

---

## 五、风险与未查

1. **用户行没有 `variables`。**[本仓库] `entry.ts:681-683` 的导出**跳过 `is_user` 行**，
   注释说明理由（一个回合的用户行与回复共享回合号，写两边会把回复的状态写到用户消息上）。
   但 **上游的 `chat[i].variables` 在用户行上是可以有值的**——`METHODS.md` 语料定理
   案例 6 记的正是这件事。导入的文件里那些值由 `iris/st-meta` 原样恢复，所以往返不丢；
   **但卡如果对用户行调 `getVariables({type:'message', message_id: <用户行>})`，
   我们会答空表而上游可能答出内容。**这条我**没有在语料里量过发生频率**。

   > **更正（2026-09-02，72 测量）——这条风险要拆成两半，一半是虚惊，另一半更严重。**
   >
   > **快照那一半：虚惊，已排除。** `toFile()` 确实携带用户行的 `variables`。上面
   > 引的 `entry.ts:683` 那个 `is_user` 跳过**不是剥离，是防覆盖**——它只阻止把候选
   > 的表*写到*用户行上，而 `exportMessages` 已经通过 `iris/st-meta` 把该行自己的表
   > 原样恢复了（那段注释本来就是这么写的）。实测：11 个真实语料聊天、**972 个带表的
   > 用户行，972 个原样往返，0 丢失**；再用真语料走一遍 `ChatStore.open → toFile()`，
   > 目标用户行的 `variables` 与原文件**逐字节相同**。
   >
   > 所以 3e 担心的那条链（MVU 的 `getLastValidMessageId` 用
   > `findLastIndex(isMvuData)` 扫**聊天面**，用户行空表会让它跳到更早的 AI 行、
   > 返回上一轮的 `stat_data`）**不会发生**：聊天面上用户行是有表的。
   >
   > **寻址那一半：成立，而且比这里写的更狠。** 我们不是「答空表」——
   > `script.getVariables` / `script.setVariables` 的 `messageId` 经
   > `variableOptionFor` 直接进 `resolveTurn`，而那里把非负数当成**回合号**，不是
   > 消息下标。实测（7 条消息的聊天，`setVariables({message_id: 2})`）：表落在
   > **消息下标 3/4**，不是 2。而 `script.context` 的 `floor.messageId` 用的是
   > **消息下标**（`floorVariables`）。**同一个契约里同一个参数名，两种含义。**
   >
   > 今天没有卡踩到：门面对 `message_id !== 'latest'` 具名拒绝，语料 5 处显式寻址
   > 全部被挡在外面（37 处 `'latest'` 走的是另一条路）。所以这是一个**等着被触发**
   > 的缺陷——触发它的正是 f7 打开显式寻址的那一刻。修在门面开路之前。

2. **`'latest'` 的 `is_system` 过滤我们这侧没有对齐验证。**上游读侧滤、写侧不滤
   （§2.2 / §2.3）。`entry.currentVariables()` 走的是我们自己的变量服务，我**没有查**
   它是否做同样的过滤。有系统消息的聊天里这会产生差异。

3. **`ScriptContext.variables` 的契约只有一行**（`views.ts:235`
   「Current variable state, for a card reading MVU's store.」），没有写它对上游的哪个
   成员。宿主侧填的是 `entry.currentVariables()`（`context.ts:106`，注释说是「最新回合的
   message 作用域表」），所以**语义是对的**，但契约文字撑不住这个语义。建议把它收紧成
   「上游 `getVariables({type:'message'})` 缺省时的那一份」并注明过滤规则。

4. **快照带整份 `chat` 的体量**已经与阅读视图窗口化面对同一个问题（677 楼语料）。
   本方案不新增体量，但也**没有改善**它；如果将来 `chat` 被窗口化，楼层变量的可达
   范围会跟着变窄，那时才需要「窗口外的楼层寻址读 → 具名拒绝并说出边界」。
   **现在不需要，将来必然需要**，建议实现时把这条写在注释里而不是等它变成 bug。

5. **本文档未量**：`deleteVariable` 的 message 分支细节；`registerVariableSchema`
   与楼层作用域的交互；群聊语境下的楼层变量（群聊本身已裁决 deferred，见 `GROUPS.md`）。

---

## 六、卡实际怎么用（决定优先级）

19 张卡的脚本里，`{type:'message'}` 的调用形状：

| 形状 | 次数 |
| --- | --- |
| `message_id: 'latest'` | **37** |
| 其它显式值（含 `-3`、变量） | **5** |
| `getChatMessages(...).data` | 2 张卡 |

**88% 是 `'latest'`，而门面今天并不拒绝 `'latest'`**（拒绝条件是
`addressed !== undefined && addressed !== 'latest'`，[本仓库]
`apps/iris-web/src/sandbox/tavern-helper.ts:414`）。

所以缺口的实际分布是：

- **响亮的半**：5 处显式楼层寻址被具名拒绝
- **静默的半**：`data` 字段缺失，2 张卡受影响
- **看不见的第三块**：37 处 `'latest'` **正在被回答**，正确性依赖 §五 风险 2 那条
  未验证的过滤对齐

第三块值得先验，因为它的量级是另外两块的七倍，而且**一旦答错，MVU 的流程是
「读 → 合并 → 写」，错的读会被持久化成错的写**。

---

## 附:两个读路径的谓词对照(料由 d7 出,72 落笔)

TH 与 MVU 都在回答「哪一楼」,但问的**不是同一个问题**,谓词也不同。混用两者的谓词
是一个自洽的错误结论——这正是 d7 记下的那句:「我上次的错误不是读错了 TH,是**把一个
API 的谓词当成了另一个消费者的谓词**。同名场景,两条路径,两个谓词。」

| | **TH `getVariables({type:'message'})`** | **MVU `getLastValidMessageId`** |
| --- | --- | --- |
| 出处 | `function/variables.ts:58-71` | `.reference/MagVarUpdate/src/util.ts:12-32` |
| 谓词 | `!chat_message.is_system`,**且只在 `'latest'`/缺省路径生效** | `isMvuData(该楼的表)` |
| 谓词定义 | ST 的消息标志位 | `variable_def.ts:171-173`:`stat_data !== undefined && schema !== undefined` |
| 方向 | **直接取** `chat.at(id)` | **从末尾向前** `findLastIndex` |
| 范围 | 单楼 | `slice(0, end_message_id)`,**不含 end 本身** |
| 未命中 | `{}` | `-1` → `getLastValidVariable` 返回 `undefined` |
| 对用户行 | 不特殊对待(只滤 `is_system`,不滤 `is_user`) | **不特殊对待**,只看数据形状 |

三条要点:

1. **最后一行是要害。** MVU 完全不看 `is_user` / `is_system`,只问「这一楼的表长得
   像不像 MVU 数据」。所以**带完整 MVU 表的用户行对 MVU 是合法目标**;跳过它就落到更早
   的 AI 行,答陈旧的 `stat_data`——形状完整、通过 schema 校验、看起来健康。
   本仓库这条链**已排除**:实测 11 个语料聊天、972 个带表用户行,972 个逐字节往返,
   0 丢失;`ChatStore.open → toFile()` 走真语料同样逐字节相同。守卫见
   `tests/user-row-variables.test.ts`。
2. **`slice(0, end)` 不含 end 本身。** 这是它们把「当前楼」包含进去的写法:
   `button.ts:203` 传的是 `getLastValidVariable(message_id + 1)`。抄这条语义时
   off-by-one **不会报错,只会静默取错楼**。
3. **两个谓词都不是「错」的**,它们服务不同问题:TH 的 `is_system` 是「哪一楼算最新
   的可见消息」,MVU 的 `isMvuData` 是「哪一楼有我认得的状态」。

风险 1 的失败模式据此更正:**不是「答空表」,是「答陈旧数据」**。而陈旧数据会被 MVU
读→合并→写回持久化,所以按 d7 的原话记档:

> **不是失败,是先毁掉数据再成功。**

这是「一切失败必须有声音」在数据完整性上的极端情形:整条链没有任何一步会报错。

---

## 附二:快照给用户行投影的表,比上游新半轮

**为什么要投影。** MVU 的 restore/重演路径用
`_.has(SillyTavern.chat[i].variables[swipe_id], 'stat_data')` 判「第 i 楼有没有
状态」。上游 **79.7% 的用户行有表**,所以向后回放会在用户行停下;我们的快照对无表
用户行恒 false,回放于是**越过它**,把「该轮回复的命令尚未套用」的状态写进并持久化
本回合的表。整条链没有一步报错,结果是**丢掉一轮的状态**。

成因不是「我们一回合存一张表」,是**快照没有让用户行看见表**。所以修在读投影层
(`context.ts` 的 `withUserRowTables`),三条红线:

1. **导出路径一字不动。** 投影进 `toFile` 的输出 = 往用户自己的聊天文件里写
   SillyTavern 从没写过的表,972/972 逐字节往返立刻破——而且是靠**增加**数据破的,
   没有任何东西缺失,读的人不会注意到。
2. **只补缺席,永不覆盖。** 从 SillyTavern 导入的聊天,其用户行的真实表由
   `iris/st-meta` 恢复,那是原件,优先。
3. **投影出的表比上游新半轮。** 上游用户行存的是**该轮开始时**的状态;我们只有这
   一轮**结算后**的状态。这是**读的语义差,不是写的正确性差**——两边对
   「这一楼有状态吗」都答是,对「是哪一刻的状态」答得不同。

d7 推演过 restore 谓词在两种回合下的结果:该轮**有**变量更新 → 整轮跳过(两边同);
**没有**更新 → 后写胜(两边同)。所以这半轮的差在 restore 路径上不产生分歧;它可能
在别的读者那里产生,记在这里而不是假装没有。

守卫见 `tests/user-row-variables.test.ts`,含导出路径不受影响的那条——它在**建过快照
之后**才断言导出结果,因为一个就地修改的实现会污染 `toFile` 返回的正是那些行。
