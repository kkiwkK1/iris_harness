# 上游语义：三条 slash 命令与管道

**短文档。**给 7b 的门面当上游：**三条命令 + 管道 + 其他按名拒绝**。

**语料面**（44 测）：界面侧 `triggerSlash` **22 个真实调用只用 3 条命令**——
`/trigger`（5 卡 15 次）、`/send`（4 卡 12 次）、`/echo`（1 卡 5 次），
**其中 12 次是同一形状 `/send <正文> | /trigger`**。

日期 2026-09-03。笔者：上游研究域（3c）。
**[TH]** 酒馆助手 4.9.1。**[ST]** SillyTavern 1.18.0，`public/scripts/`。

---

## 一、TH 侧入口

```ts
// [TH] function/slash.ts:3-9
export async function triggerSlash(command: string): Promise<string> {
  const result = await executeSlashCommandsWithOptions(command);
  if (result.isError) throw Error(`运行 Slash 命令 '${command}' 时出错: ${result.errorMessage}`);
  return result.pipe;
}
```

- **返回 `result.pipe`，一个字符串**，不是对象。
- **失败抛普通 `Error`**，消息里带原命令与 `errorMessage`。
- **`triggerSlashWithResult` 是同一个函数的别名**（`function/index.ts:420-421`）——
  **名字暗示两种返回形状，实际只有一种。**

---

## 二、三条命令

### `/send` —— 追加一条**用户身份**的消息，**不触发生成**

`[ST] slash-commands.js:1731-1780`，回调 `:5022-5045`。

| 参数 | 类型 | 默认 | 备注 |
| --- | --- | --- | --- |
| `compact` | bool | `false` | |
| `at` | number | 末尾 | **接受负数（含 `-0`）**，转成 `chat.length + at`（`:5030-5033`） |
| `name` | string | **`{{user}}`** | 走 `findPersona({name})?.avatar \|\| user_avatar`（`:5038`） |
| `return` | enum | **`none`** | |
| `raw` | bool | `true` | |
| **unnamed `text`** | string | —— | **必填** |

落到 `sendMessageAsUser(text, bias, insertAt, compact, name?, avatar?)`。**不调用 `Generate`。**

**返回**：`doReturn(args.return ?? 'none', message, { objectToStringFunc: x => x.mes })`；
**`'none'` → `''`**（`SlashCommandReturnHelper.js:75-76`）。

### `/trigger` —— `Generate('normal')`

`:1805-1832`，回调 `:4986-5020`。

- named 只有 **`await`**（bool，默认 `false`）；unnamed 是**可选**的群成员 index/name。
- **先等 `!is_send_press && !is_group_generating`**，`waitUntilCondition(…, 10000, 100)`；
  **超时 → toastr warning「Cannot run /trigger command while the reply is being generated.」，返回 `''`**（`:4990-4996`）。
- **清空 `#send_textarea` 防递归**（`:4999`）。
- 两层 `setTimeout`（1ms → 100ms）后才 `Generate('normal', { force_chid })`（`:5011`）。
- `await=true` 时等内层 promise。**但无论如何 `return ''`**（`:5019`）——
  **`/trigger` 永远往管道里放空串。**

### `/echo` —— toastr

`:2108-2145`。

| 参数 | 默认 |
| --- | --- |
| `title` | —— |
| **`severity`** | **`info`**；枚举 `info` / `warning` / `error` / `success` |
| `timeout` | `toastr.options.timeOut` |
| `extendedTimeout` | `toastr.options.extendedTimeOut` |

`returns: t\`the text\`` → **把文本放回管道**。

---

## 三、管道：`|` 传值，`||` 不传

```js
// [ST] scripts/slash-commands/SlashCommandClosure.js:438
this.scope.pipe = await executor.command.callback(args, value ?? '');   // 每条的返回值成为 pipe

// :557-562   substituteUnnamedArgument
if (executor.unnamedArgumentList.length == 0) {      // ← 这条命令「写的时候没给 unnamed 参数」
  if (!isFirst && executor.injectPipe) {
    value = this.scope.pipe;                          // ← 才把 pipe 当作它的 unnamed arg
    args._hasUnnamedArgument = this.scope.pipe != null;
  }
}
```

**注入判据是三个合取项**：**不是第一条** ∧ **这条没写自己的 unnamed 参数** ∧ **`injectPipe`**。

另有 `{{pipe}}` 宏可显式引用（`SlashCommandClosure.js:61` / `:178` / `:185`）。

### `injectPipe`：默认 `true`，**只有 `||` 会关掉它**

```js
// [ST] SlashCommandExecutor.js:8
/**@type {Boolean}*/ injectPipe = true;
```

```js
// [ST] SlashCommandParser.js:792-799
// first pipe marks end of command
if (this.testSymbol('|')) {
    this.take();                    // discard first pipe
    // second pipe indicates no pipe injection for the next command
    if (this.testSymbol('|')) {
        injectPipe = false;
        this.take();                // discard second pipe
    }
}
```

**这是一条语言特性，不是实现细节**：

| 写法 | 语义 |
| --- | --- |
| `A \| B` | 顺序执行，**A 的返回值注入 B**（若 B 没写自己的 unnamed 参数） |
| `A \|\| B` | 顺序执行，**不注入** |

`injectPipe` 在解析器里每条命令后重置为 `true`
（`:787` 在 `parseCommand` 之后、`:774` 在 `parseRunShorthand` 之后），
**所以 `||` 只影响紧随其后的那一条。**

**门面要支持两个管道操作符，不是一个。**

---

## 四、⚠ 那个 12 次的主力形状：**安全，但是靠 falsy 巧合安全**

`/send <正文> | /trigger` 的实际链条：

```
/send  默认 return=none  →  pipe = ''
/trigger 写时没带参数     →  unnamedArgumentList.length == 0  →  收到 '' 作为 unnamed arg
triggerGenerationCallback:  if (selected_group && value)  →  '' 是 falsy  →  不查群成员
```

**它不出错，是因为 `''` 恰好是 falsy，不是因为管道没传东西。**

**反例**：若卡写成 `/send X return=pipe | /trigger`，
`/trigger` 会拿到消息正文当 unnamed arg；**非群聊时 `selected_group` 为假仍然短路，
但群聊里会真的去 `findGroupMemberId(正文)`。**

*（语料里目前没有这种写法——但**「目前没有」和「不会有」是两件事**，
而这条链的安全性完全依赖一个默认值。）*

---

## 五、给门面的五条

1. **`/send` 要支持 `at` 的负数（含 `-0`）与 `name` 的 persona 查找**——都在语义里，不是装饰。
2. **`/trigger` 的返回恒为 `''`**，所以 `/trigger` 之后的管道值一定是空串，**不必为它设计传值**。
3. **管道注入的三个合取项要都实现**，不能简化成"总是注入"或"从不注入"：
   前者让 `/send A | /send B` 的第二条收到错东西，后者让 `/echo` 之后的链断掉。
4. **`||` 要实现**，且它只影响紧随其后的一条。
5. **`/trigger` 的 10 秒等待 + 超时 toastr 是语义的一部分**，不是可省的防抖——
   **卡靠它避免在生成中重入**，而它失败时是有声音的（toastr），这一点要保住。

## 未查

1. **其余 slash 命令的语义**没读——本文只覆盖语料里出现的三条。
   「其他按名拒绝并报告」这条裁定不需要它们的语义，但**将来放开任何一条都要单独量**。
2. **`{{pipe}}` 宏在 unnamed 参数里的展开时机**没读（`:178`/`:185` 只看了正则与替换点）。
3. **`rawQuotes: true`（`/send` 与 `/echo` 都有）对引号字面量的确切影响**没展开。
