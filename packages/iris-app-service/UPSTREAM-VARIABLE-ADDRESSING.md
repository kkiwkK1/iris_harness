# 上游语义：楼层变量的寻址（`message_id` 的取值域）

**短文档。**回答一件事：`getVariables` / `replaceVariables` / `insertOrAssignVariables` 这一族的
`message_id` 接受什么、映射到哪一楼、越界怎样。

**最要紧的一条不在取值域里**：**读路径和写路径对 `'latest'` 的解释不一样**，
而 `updateVariablesWith` 用同一个 option 走完这两条——**读 A 楼、写 B 楼，静默错位。**

日期 2026-09-03。笔者：上游研究域（3c）。
**[TH]** 酒馆助手 4.9.1，`data/default-user/extensions/JS-Slash-Runner/src/function/variables.ts`。

---

## 一、读写两段代码

```ts
// 读 —— get_variables_without_clone  :56-70
const normalized_message_id =
  option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id;
if (!_.inRange(normalized_message_id, -chat.length, chat.length)) {
  throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 [${-chat.length}, ${chat.length})`);
}
let chat_message;
if (option.message_id === undefined || option.message_id === 'latest') {
  chat_message = chat.filter(chat_message => !chat_message.is_system).at(normalized_message_id);  // ← 过滤系统消息
} else {
  chat_message = chat.at(normalized_message_id);
}
return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
```

```ts
// 写 —— replaceVariables  :128-137
option.message_id = option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id;
if (!_.inRange(option.message_id, -chat.length, chat.length)) {
  throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 (${-chat.length}, ${chat.length})`);
}
const chat_message = chat.at(option.message_id) as Record<string, any>;   // ← 不过滤
if (!_.has(chat_message, 'variables')) {
  _.set(chat_message, 'variables', _.times(chat_message.swipes?.length ?? 1, _.constant({})));
}
```

类型声明（`:42-45`）：

```ts
type VariableOptionMessage = { type: 'message'; message_id?: number | 'latest' };
```

---

## 二、读写不一致：`'latest'` 在两边指不同的楼

```ts
// [TH] variables.ts:217-226   updateVariablesWith
const variables = getVariables(option);      // 读
const result = updater(variables);
replaceVariables(result, option);            // 写 —— 同一个 option
```

| | `'latest'` / 省略 解析成 |
| --- | --- |
| **读** | `chat.filter(m => !m.is_system).at(-1)` —— **最后一条非系统消息** |
| **写** | `chat.at(-1)` —— **最后一条消息，系统与否不论** |

**最后一楼是系统消息时**，`insertOrAssignVariables`（`:241`）、`insertVariables`（`:261`）、
`deleteVariable`（`:281`）、以及任何 `updateVariablesWith` 的使用者
**读的是 A 楼、写的是 B 楼**——**没有任何报错。**

### 旁证：这是两段各自写的代码，不是共用的归一化

**两处越界错误信息的括号不一样**：

```
读 :62   `…超出了范围 [${-chat.length}, ${chat.length})`     ← 半开区间，写对了
写 :133  `…超出了范围 (${-chat.length}, ${chat.length})`     ← 开区间，和实际判据不符
```

判据两边都是 `_.inRange(v, -len, len)`（半开）。**写路径的括号是错的**——
**一个抄漏的标点，正好证明这两段没有共用来源。**

---

## 三、取值域

**实测**：`node -e` 跑 lodash 4 的 `_.inRange` 与 `Array.prototype.at`，`chat.length = 10`。

| 传入 | `_.inRange` | `chat.at(...)` | 结果 |
| --- | --- | --- | --- |
| **省略 / `undefined`** | — | — | 归一化成 `-1`，**读写解释不同**（§二） |
| **`'latest'`** | — | — | 同上 |
| **`'last'`** | **false** | — | **抛**「超出了范围」 |
| **`3`** | true | 3 | 第 3 楼 |
| **`'3'`（字符串数字）** | **true** | **3** | **能用**——类型说不行，实际可以 |
| **`-1`** | true | 9 | **从末尾数**，最后一楼 |
| **`-chat.length`** | true | 0 | 第 0 楼（负数下界正好对齐） |
| **`chat.length`、`-chat.length-1`** | false | `undefined` | **抛** |
| **`NaN`** | false | — | **抛** |
| **`null`** | **true** ⚠ | **0** | **静默命中第 0 楼** |
| **`true`** | true ⚠ | 1 | 静默命中第 1 楼 |

**范围判据 `[-len, len)` 恰好等于 `Array.prototype.at` 的有效域**——
所以越界一定抛，不会静默返回 `undefined`。

### ⚠ `null` 是真陷阱

`option.message_id === undefined` 对 `null` 是 **false** → **不会**归一化成 `-1`；
`_.inRange(null, …)` 是 **true**（lodash `toNumber(null) === 0`）→ 过了守卫；
`chat.at(null)` → **索引 0**。

**所以 `message_id: null` 既不报错、也不取最新，而是静默命中第 0 楼（开场白）。**
一张卡若从某个可能返回 `null` 的地方算出 `message_id`，**它会安静地读写开场白。**

*（相邻的一处：`waitGlobalInitialized('Mvu')` 会等 `{type:'message', message_id: 0}` 上出现
`stat_data`——**第 0 楼在这套 API 里本来就是个特殊位置，而它同时是 `null` 的落点。**
见 `UPSTREAM-MVU-INIT-PATH.md` §一。）*

---

## 四、返回形状（读）

```ts
return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
```

- **按 swipe 分片**，取 `chat_message.swipe_id`，缺省 **swipe 0**；
- **楼存在但没有变量时返回 `{}`，不是 `undefined`**；
- `getVariables`（`:96-98`）在此之上再套一层 **`klona` 深拷贝**——**返回的是快照，不是活对象**。

写路径在楼上没有 `variables` 时会**按 swipes 数量建一组空对象**（`:136-137`），
`_.times(swipes?.length ?? 1, _.constant({}))`。

---

## 五、已裁（总指挥，2026-09-03）

1. **接受集收下负数与字符串数字**——它们在上游是现实中能用的，不是意外。
2. **`null` 拒绝并具名报出。**它落在「错误的写目标」那一格，所以这是政策不是兼容：
   **照抄上游是复现一个 bug。**
3. **`'latest'` 两侧统一取「最后一条非系统消息」。**
   **一致比跟谁一致更重要**；选「都过滤」是因为它更接近卡的意图（"最新那条对话"）。

## 未查

1. **`type: 'script'` / `'character'` / `'global'` 三支的寻址我没展开**，本文只覆盖 `'message'`。
2. **`swipe_id` 越界或缺失时的行为**没单独验（读侧有 `?? 0` 兜底，写侧按 `swipes.length` 建）。
3. **语料里有多少卡传非数字的 `message_id`** 没量——**本文是机制，不是用量**。
