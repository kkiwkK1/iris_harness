# 上游语义：运行时提示词注入 与 chat 世界书

**这是上游语义测量，不是我们的契约。**给 49 建宿主 arm 当规格上游。
`UPSTREAM-` 前缀按 49 的建议，标明这份描述的是 SillyTavern + 酒馆助手**现在**的行为。

**我不改 `WORLDBOOKS.md` 和 `DEVIATIONS.md`**（49 的账本，走清单纪律）。
需要落进那两份的 delta 单列在 §四。

日期 2026-09-03。笔者：上游研究域（3c）。

## 口径

- **[ST]** 行号在 `E:/sillyTavern/SillyTavern/public/`，SillyTavern 1.18.0。
- **[TH]** 行号在 `data/default-user/extensions/JS-Slash-Runner/src/`，酒馆助手 4.9.1。
- **[卡]** 经 `decodeCardPng` + `extractScripts` 读出，**渲染前**，计匹配次数不去重。
- **全部静态读**，没有运行 ST。凡是推断而非读出的，逐条标注。

---

## 〇、给 49 的三句话

1. **你的「不持久化」决定不用改。**上游的注入也是纯内存、切聊天即清、重启即失。
   §一之三给出证据链。**但有一个不对称你可能要接**：ST 清了，卡不知道。
2. **你的「chat 书是叠加不是择一」先验是对的**，但**「来源不决定顺序」这半句上游不成立**——
   chat 书**无条件排在候选表最前**。§二之三。
3. **上游不是四来源，是五来源。**你没算 persona 书（`power_user.persona_description_lorebook`）。

---

## 一、`injectPrompts` 是 `setExtensionPrompt` 的**薄封装加一个句柄**，不是超集

### 一之一 底层：ST 的 `setExtensionPrompt`

```js
// [ST] script.js:8866
export function setExtensionPrompt(key, value, position, depth, scan = false,
                                   role = extension_prompt_roles.SYSTEM, filter = null) {
    extension_prompts[key] = {
        value: String(value), position: Number(position), depth: Number(depth),
        scan: !!scan, role: Number(role ?? 0), filter: filter,
    };
}
```

**按 key 整体赋值。**同 key 再调是**替换整条记录**，不是合并、不是累加。
（和你 `entry.ts` 的 `extensionPrompts` 幂等语义**一致**。）

枚举（[ST] `script.js:483-499`）：

```js
extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 }
extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 }
MAX_INJECTION_DEPTH = 10000
```

### 一之二 TH 的封装

```ts
// [TH] function/inject.ts:5-21
type InjectionPrompt = { id; position: 'in_chat'|'none'; depth; role; content; filter?; should_scan? }
function injectPrompts(prompts: InjectionPrompt[], { once = false } = {}): { uninject: () => void }
```

逐字段落到 `setExtensionPrompt`：

| TH 字段 | 落成 |
| --- | --- |
| `id` | **ST 的 key**（`prompt.id ?? uuidv4()`）——**没有 scriptId 前缀** |
| `position: 'none'` | `-1`；其余一律 `1`（`IN_CHAT`）。**`0`/`2` TH 根本不暴露** |
| `role` | `{system:0, user:1, assistant:2}` |
| `should_scan` | `scan`，默认 `false` |
| `filter` | 原样传，`null` 兜底 |

**所以「句柄」不是新机制**：`uninject()` 就是
`_.unset(extension_prompts, id)`（`inject.ts:57-61`）。**key 就是句柄。**

**两处对你的实现是好消息：**

- **同名 key 互相覆盖，上游也是**——TH 不按 script 分区，你按 entry(chat) 持有、
  scriptId 不进 key，**和上游一致，不是偏离**。
- **`uninject` 等价于用同 key 写空**——你的猜测，而且**语料里已经有卡这么做**：
  银麒赎世写 `ctx.setExtensionPrompt("yinqi-npc-messages", "", 1, 0)` 来清（§三）。

**一处 TH 独有、ST 没有的：**

- `once: true` 时挂 `GENERATION_ENDED` / `GENERATION_STOPPED` 自动撤销；
- **无论 once 与否，总是挂 `$(window).on('pagehide', uninject)`**（`inject.ts:50`）。

  > **⚠ 一处更正（2026-09-03）。**初版这里写的是「那是**脚本 frame 的** window，
  > 所以**脚本 frame 一销毁，它的注入就撤**」。**那句是错的。**
  >
  > `injectPrompts` 在 `function/index.ts:333` **位于 `TavernHelper` 的外层对象**
  > （`_bind` 是 `:219-265`，缩进 6 空格；`:333` 缩进 4 空格），
  > 所以 `predefine.js:13` 的 `_.omit(TavernHelper, '_bind')` 把它**原样合并**进 frame 的
  > window，**没有 `.bind(window)`**——只有 `_bind` 那一组才在 `predefine.js:15-18` 被绑定。
  >
  > 函数体里的 `window` 是**它定义所在模块**的 window，也就是 **ST 页面**。
  > **所以 `pagehide` 挂在 ST 页面上，frame 销毁不会触发它，注入不会被撤。**
  >
  > **正确说法**：这个 `pagehide` 是**整页卸载**时的兜底，**不是 frame 级的生命周期**。

### 一之三 生命周期：三个问题的答案

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| 存在哪 | **模块级内存对象**，`export let extension_prompts = {}` | [ST] `script.js:625` |
| 持久化吗 | **否。全仓没有任何序列化点。**除 `script.js` 外只有两个宏文件 import 它，且只读 | 我在 `public/` 全文搜过 |
| 换聊天还在吗 | **不在。**`clearChat()` 里 `extension_prompts = {}`，14 个调用点覆盖开/切/删聊天 | [ST] `script.js:1584-1588` |
| 重载还在吗 | **不在**（内存对象） | 同上 |

**所以 49 的「不持久化，因为注入属于正在运行的脚本」和上游一致。不用推翻。**

### 一之四 但有一个不对称，我建议你接

**ST 在切聊天时清空 `extension_prompts`；而 TH 的脚本 frame 不一定重建。**

TH 的角色卡脚本来自 `useCharacterSettingsStore().settings`，它只在**角色变**时刷新——
守卫写得很明确：

```ts
// [TH] store/settings/character.ts:55-60
eventSource.makeFirst(event_types.CHAT_CHANGED, () => {
  const new_name = characters?.[this_chid]?.name;
  if (name.value !== new_name) { id.value = this_chid; name.value = new_name; }
});
```

**同一角色下换聊天，`name` 不变 → 脚本列表不变 → frame 不重建 → 脚本继续跑。**

于是出现这个状态：

```
卡持有的句柄 S      仍在，S.deleted === false      ← 卡认为自己注入着
ST 的 extension_prompts   已被 clearChat 清空       ← 实际没有
通知                无                              ← pagehide 挂在 ST 页面上，整页不卸载就不触发
```

**卡相信自己注入着，而它没有。**

V1.5.4 在实践上会自愈：它每轮走 `o?.skipInject || (S = injectPrompts(u))` 重新注入，
所以**窗口是「切聊天 → 下一个注入点」**。但这依赖卡每轮重注，**不是机制保证**。

**建议**：我们这边要么在切 chat 时**也清**（跟上游），要么**不清但明示**。
两者都可以，**不可以的是清了不说**——那正是上游现在的形状，而我们有 Logger 可以说。
（这条属于 `OBSERVABILITY.md` 的「缄默」族。）

### 一之五 装配：落在哪一段，以及一条会咬人的排序规则

```js
// [ST] script.js:3242-3268  getExtensionPrompt(position, depth, separator, role, wrap)
Object.keys(extension_prompts)
  .sort()                                   // ← 键名字典序
  .map(x => extension_prompts[x])
  .filter(x => x.position == position && x.value)
  .filter(x => depth === undefined || x.depth === undefined || x.depth === depth)
  .filter(x => role === undefined || x.role === undefined || x.role === role)
  .filter(filterByFunction)                 // ← 逐条 await prompt.filter()
```

**三条要点：**

1. **同一 (position, depth, role) 组内的拼接顺序是 key 的字典序。**
   ST 自己的键因此叫 `1_memory` / `2_floating_prompt` / `3_vectors` /
   `4_vectors_data_bank`（[ST] `script.js:5287-5291`）——**数字前缀是排序手段，不是命名习惯。**
   **一张卡用 uuid 当 id，就是把自己扔进这个字典序里的随机位置。**
2. **`NONE: -1` 是「存而不装配」**：`getExtensionPrompt` 的三个调用点只用
   `BEFORE_PROMPT(2)`、`IN_PROMPT(0)`、`IN_CHAT(1)`（[ST] `script.js:4641/4642/5588`，
   `openai.js:847`）。**`-1` 永远不被查询**，所以 `position:'none'` 的注入
   登记在册、可被同 key 覆盖或删除，但**不进提示词**。
3. **`filter` 是每次装配时 await 的**，不是登记时求值一次。

---

## 二、chat 世界书

### 二之一 存哪、名字怎么铸

```js
// [ST] public/scripts/world-info.js:94
export const METADATA_KEY = 'world_info';
```

**`chat_metadata['world_info']` 存的是一个世界书的名字（字符串），不是对象、不是内容。**

铸名（[ST] `world-info.js:1176`）：

```js
const name = await createWorldWithName(
  args.name,
  `Chat Book ${getCurrentChatId()}`
    .replace(/[^a-z0-9 -]/gi, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 64));
chat_metadata[METADATA_KEY] = name;
await saveMetadata();
```

**注意三点**：非字母数字空格连字符**全替成下划线**、连续下划线**折叠**、**截断到 64 字符**。
中文聊天名会被整段替成下划线——**这个铸名规则不是可逆的，也不保证唯一**
（两个不同 chatId 折叠后可能同名；`createWorldWithName` 里对显式传名会
`throw new Error('This World Info file name is already in use')`，对铸出的名字这条路我没读完，见 §五）。

**存在性守卫**（[ST] `world-info.js:1168`）：

```js
if (chat_metadata[METADATA_KEY] && world_names.includes(chat_metadata[METADATA_KEY]))
    return chat_metadata[METADATA_KEY];
```

**书文件被删掉时，这个键被忽略并走新建**——键存在不代表书存在。

### 二之二 五个来源，不是四个

```js
// [ST] world-info.js:4478-4490  getSortedEntries()
const [globalLore, characterLore, chatLore, personaLore] = await Promise.all([
  getGlobalLore(), getCharacterLore(), getChatLore(), getPersonaLore(),
]);
```

`getPersonaLore()`（`:4452`）读 `power_user.persona_description_lorebook`。
**`WORLDBOOKS.md` 的三来源加上 chat 书是四，加上 persona 书是五。**

**每一路都有自己的去重守卫**（这是我没预料到的设计密度）：

| 来源 | 守卫 | 行 |
| --- | --- | --- |
| chat | 若该书已在 `selected_world_info`（全局选中），**返回空** | `:4439` |
| persona | 若 persona 书 == chat 书，**返回空**；若已在全局选中，**返回空** | `:4462/4467` |

**去重是按「书」而不是按「条目」做的，而且方向固定**：全局选中优先，chat 让位；
chat 优先，persona 让位。

### 二之三 顺序：来源**确实**决定顺序

49 的先验是「注入位置由每条 entry 自己的 `position` 决定，来源不决定顺序」。
**前半句对，后半句上游不成立。**

```js
// [ST] world-info.js:4496-4512
switch (Number(world_info_character_strategy)) {
  case evenly:          entries = [...globalLore, ...characterLore].sort(sortFn); break;
  case character_first: entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)]; break;
  case global_first:    entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)]; break;
}
// Chat lore always goes first, then persona lore, then the rest
entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];
```

**那句注释是上游自己写的：`Chat lore always goes first`。**

- `world_info_character_strategy` **只排 global 与 character 两路**；
- **chat 与 persona 不参与那个策略**，无条件前置，且 **chat 在 persona 之前**。

**这不是装配槽的顺序，是候选表的顺序**——每条 entry 最终插到哪仍由它自己的 `position` 决定。
但候选表顺序**不是无害的**：它是扫描与激活的遍历顺序（`world-info.js:4632`
`const sortedEntries = await getSortedEntries()`），**预算耗尽时先到先得**。

**所以：chat 书的条目在预算竞争中排在所有其它来源之前。**
一张卡往 chat 书里写条目，等于把它们放在世界书预算队列的队首。

*（这条的下游后果——预算耗尽点具体怎么算——我没有跟到底，见 §五。
但「候选表顺序 = 遍历顺序」这一步是读出来的，不是推的。）*

### 二之四 `createWorldbookEntries` 的返回形状与 uid

```ts
// [TH] function/worldbook.ts:441-457
export async function createWorldbookEntries(worldbook_name, new_entries, options?)
  : Promise<{ worldbook: WorldbookEntry[]; new_entries: WorldbookEntry[] }> {
  let slice_start;
  const worldbook = await updateWorldbookWith(worldbook_name, data => {
    slice_start = data.length;
    return [...data, ...new_entries];
  }, options);
  return { worldbook, new_entries: worldbook.slice(slice_start) };
}
```

- **追加到末尾**，然后**按下标切片**认领新条目。
  这依赖「写入不重排」——若底层重排，认领的就是别人。
- **返回整本 + 新条目两份**。
- **整本重写**：`updateWorldbookWith` → `replaceWorldbook` → `createOrReplaceWorldbook`
  → `saveWorldInfo(name, { entries: … })`（`:390-395`）。**没有增量写。**

**uid 分配**（`worldbook.ts:326-352`）：

```ts
const MAX_UID = 1_000_000;
if (index === undefined) index = _.random(0, MAX_UID - 1);   // 随机，不是自增
while (uid_set.has(index)) { index = (index + i * i) % MAX_UID; ++i; }  // 二次探测
```

**缺 uid 时随机取 [0, 1e6)，冲突用二次探测。**唯一性只在**这一次写入的集合内**保证——
因为整本重写，那个集合就是整本，所以事实上是全书唯一。**但不是稳定的、不是自增的、跨写入不可预测。**

### 二之五 分支继承（49 提的问题）

49 指出 `chat_metadata` 在分支时被 `structuredClone` 整体继承。
**含义**：`chat_metadata.world_info` 是个字符串，clone 后**父子聊天指向同一本书**。

**不是各自一份，是共享一本。**所以分支之后：

- 子聊天里卡写进 chat 书的条目，**母聊天也会看到**；
- 谁先写谁后写没有仲裁，**整本重写**（§二之四）意味着**后写者覆盖前写者的整本**。

**我的建议是显式裁断而不是继承 clone 的副作用**，但**这是我们的产品决定，不是上游语义**，
所以我只把机制摆在这里，选择权在 49 和总指挥。三个选项：
①跟上游（共享）；②分支时清掉这个键（各自新建）；③分支时复制一份书（真正独立）。
**②和③的差别是「分支后母书的既有条目还在不在」**，这对叙事型卡不是小事。

---

### 二之六 名字怎么变成文件：写路径、读侧、以及一个会把人带偏的端点

§二之一 讲的是**铸什么名**，这一节讲**那个名怎么落成文件、又怎么被读回来**。
它不只管 chat 书——**所有世界书都走这一条**。

#### 写路径：`sanitize(name + '.json')`

```js
// [ST] src/endpoints/worldinfo.js:151   POST /api/worldinfo/edit
const filename = sanitize(`${request.body.name}.json`);
const pathToFile = path.join(request.user.directories.worlds, filename);
writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));
```

读单本（`readWorldInfoFile`，被 `/get` 用）与删除是同一形状：
`worldinfo.js:24`、`worldinfo.js:87`。**三处都是 `sanitize(name + '.json')`。**
包是 `sanitize-filename` **1.6.3**（`worldinfo.js:5` 导入）。

#### `sanitize` 的确切规则

ST 只传一个参数 → **`replacement` 是空串 → 一律删除，不替换**。

```js
illegalRe         = /[\/\?<>\\:\*\|"]/g              // 删除 / ? < > \ : * | "
controlRe         = /[\x00-\x1f\x80-\x9f]/g          // 删除 C0 与 C1 控制字符
reservedRe        = /^\.+$/                           // 整串只有点 → 整体删除
windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i   // 整体删除
windowsTrailingRe = /[\. ]+$/                         // 删除结尾的点和空格
return truncate(sanitized, 255)                       // truncate-utf8-bytes：255 字节
```

一句话：**删掉 9 个非法字符与控制字符、去掉尾部点空格、截到 255 字节；
Unicode 保留、大小写保留。**中文书名原样落盘。

#### 读侧：`world_names` **纯从文件名来**

```js
// [ST] src/endpoints/settings.js:253-257   POST /api/settings/get
const worldFiles = fs.readdirSync(request.user.directories.worlds)
    .filter(file => path.extname(file).toLowerCase() === '.json')
    .sort((a, b) => a.localeCompare(b));
const world_names = worldFiles.map(item => path.parse(item).name);
```

客户端 `updateWorldInfoList()`（`public/scripts/world-info.js:2061-2071`）直接
`world_names = data.world_names`。**文件内的 `name` 字段一个字都没读。**

#### ⚠ 陷阱：有两个 list 端点，语义相反

```js
// [ST] src/endpoints/worldinfo.js:52-58   POST /api/worldinfo/list   ← 不是 world_names 的来源
file_id: fileNameWithoutExt,
name: fileContentsParsed?.name || fileNameWithoutExt,   // ← 这个才读文件内 name
```

**`/worldinfo/list` 确实读文件内 `name`（回退文件名），但它填的不是 `world_names`。**
先看到这个端点会得出相反的结论。**判存在、判匹配用的是 `world_names`，也就是文件名。**

#### 三条边界，按严重性排

**① 写与读的名字不对称——上游用了两套判据。**

写时 sanitize，`world_names` 里是 sanitize **之后**的 basename；
而卡里存的 `extensions.world` 是**原始名**。名字含非法字符时：

- `world_names.includes(原始名)` → **false**（判存在失败，即使文件在）
- `/worldinfo/get` 带原始名 → 服务端**再 sanitize 一次** → **读得到**

`getCharacterLore()` 与 `getOrCreateChatLorebook` 都先用 `world_names.includes(...)`
判存在再决定走哪条路（§二之一 记过那个守卫），**所以这条不是假想。**

> **已裁：这一处不照抄**（总指挥，2026-09-03）。我们取书**只用
> `sanitize(name + '.json')` 一套**——**我们没有 `world_names` 那一层，
> 照抄不一致没有对象。**

**② `.json` 参与 sanitize，能把整个名字吃空。**

传进去的是 `name + '.json'`，而 `windowsReservedRe` 带 `(\..*)?`——
**一本叫 `con` 的世界书 → `sanitize('con.json')` 整串命中 → 返回空串 →
`path.join(worlds, '')` 就是 worlds 目录本身。**
`prn` `aux` `nul` `com1`–`com9` `lpt1`–`lpt9` 同理。**上游没有任何一层挡这件事。**

**③ 255 是字节不是字符**（`truncate-utf8-bytes`）。
中文名约 **83 字**，还要扣掉 `.json` 的 5 字节。

#### 给实现的一句

**按 ST 的规则实现：`sanitize(name + '.json')` 得文件名。
不要用我们的 `toId`**——它的规则和这个不同，**而卡里存的名字是按 ST 的规则往返过的**。

---

## 三、语料使用面：**不是只有 V1.5.4**

判据：22 张卡（19 语料 + 3 新增），经产品解码器取脚本正文，**子串计数**。

```
卡数 22，有脚本 17，脚本合计 5,263,734 B (5.02 MiB)

injectPrompts              1 次   1 卡   V1.5.4
getOrCreateChatWorldbook   2 次   1 卡   V1.5.4
createWorldbookEntries     2 次   1 卡   V1.5.4
uninjectPrompts            0 次   0 卡
getChatWorldbookName       0 次   0 卡
rebindChatWorldbook        0 次   0 卡
replaceWorldbook           0 次   0 卡
deleteWorldbookEntries     0 次   0 卡

getWorldbook              17 次   2 卡   魔法少女的扣扣审判1.0(语料) | 灭仇家满门之后…(新增)
updateWorldbookWith       12 次   2 卡   同上
setExtensionPrompt         5 次   1 卡   银麒赎世(语料)
chat_metadata              4 次   1 卡   银麒赎世(语料)
```

**三条结论：**

1. **chat 世界书**（`getOrCreateChatWorldbook` / `createWorldbookEntries`）
   **确实只有 V1.5.4** 在用。
2. **但世界书写入不是新面**：`updateWorldbookWith` 有两个消费者，
   **其中一个在原 19 卡语料里**（魔法少女的扣扣审判1.0，做章节开关）。
3. **提示词注入也不是新面**：**银麒赎世（语料卡）直接用 `ctx.setExtensionPrompt`**，
   5 次。**它不走 TavernHelper 的 `injectPrompts`。**

### 三之一 银麒赎世的形状，对 49 的实现最有用

```js
var tw = window.parent || window;
if (tw.SillyTavern && tw.SillyTavern.getContext) {
  var ctx = tw.SillyTavern.getContext();
  if (ctx && typeof ctx.setExtensionPrompt === "function") {
    ctx.setExtensionPrompt("yinqi-npc-messages", "", 1, 0);   // ← 写空 = 撤销
  }
}
```

- **key 是稳定的具名字符串**（`"yinqi-npc-messages"`），不是 uuid；
- **position 1 (`IN_CHAT`)、depth 0**，和 V1.5.4 一样；
- **撤销方式是写空值**——`getExtensionPrompt` 的 `.filter(x => … && x.value)`
  会把空值滤掉，所以写空等价于撤销。**你的猜测被语料证实了。**

### 三之二 一处卡的错误心智模型，值得记

银麒赎世还有这一段：

```js
if (entries.length === 0 && ctx.chat_metadata && ctx.chat_metadata.world_info) {
  var wi = ctx.chat_metadata.world_info;
  if (wi.entries) entries = Object.values(wi.entries);   // ← wi 是字符串
}
```

**它把 `chat_metadata.world_info` 当成一个带 `entries` 的对象。上游存的是书名字符串。**
所以这个 fallback 分支**永远不会执行**——`"名字".entries` 是 `undefined`。

**对我们的意义**：如果我们把这个键做成对象（比如为了省一次查找而内联条目），
**这段死代码会醒过来**，并且是在一张我们没在测的卡里。**照抄上游的键与类型，不要"改进"。**
（这正好是 49 说的「chat 书如果上游有既定键名，照抄键名，别另起」，加上一句：**类型也照抄。**）

### 三之三 三种取用路径，同一个守卫习惯

| 卡 | 怎么拿宿主 API |
| --- | --- |
| 魔法少女 | **裸全局**：`typeof updateWorldbookWith === 'function'` |
| 灭仇家 | **`TavernHelper` 对象**：`th.updateWorldbookWith` |
| 银麒赎世 | **`SillyTavern.getContext()`**：`ctx.setExtensionPrompt` |
| V1.5.4 | **裸全局**，逐成员 `typeof` 探测 |

**四张卡、三条路径，但守卫习惯一致：全部先 `typeof … === 'function'`，缺了就降级。**

**这把 `OVERLAY-CARDS.md` §六第 4 条从一张卡的观察升级成语料级规律**：
我们的具名拒绝若在**存在性检查**上抛异常，**这四张卡的降级路径全部作废**。
建议不变（`typeof`/`in` 作答不抛，取值/调用才抛），但支持它的样本从 1 变成 4。

### 三之四 一个坏探针，先报出来

**这一节的第一版全是零，包括 V1.5.4 自己的 `injectPrompts`——而我知道它在用。**

成因：我把探针写成 `new RegExp('\\b' + m + '\\b')`，脚本经 Bash heredoc 落盘时
`\\b` 塌成 `\b`，JS 里那是**退格符**不是词边界。于是每个模式都在找
「退格符 + 名字 + 退格符」，**全不命中**。

**这个假零如果照发，结论会是「除 V1.5.4 外无人使用」——正好是被问的那个问题的答案，
而且方向讨喜（面小、好做）。**

改法按 METHODS「重复踩同一个坑就换工具」：换 Write 工具落盘、**整个探针不含反斜杠**
（用 `split(needle).length - 1` 数子串），并加一条**齿检**——
「`injectPrompts` 必须至少命中一次，否则下面所有零不可信」，输出里印出来。
**上面那份数据是齿检通过后的。**

---

## 四、给 49 的 delta（我不改你的文件，列在这里）

### `WORLDBOOKS.md`

1. **三来源改五来源**：加 chat 书（`chat_metadata.world_info`）与
   persona 书（`power_user.persona_description_lorebook`）。
2. **chat / persona 不参与「择一」，也不参与 `world_info_character_strategy`**，
   而是**无条件前置**：`[...chatLore, ...personaLore, ...(global 与 character 按策略排)]`。
   **「来源不决定顺序」这句要改。**
3. **三条按书去重的守卫**（§二之二表），方向固定。
4. **chat 书键名与类型照抄**：`chat_metadata['world_info']`，**字符串**（书名）。
5. **分支继承**待裁（§二之五三个选项）。

### `DEVIATIONS.md`

1. **注入的 chat 生命周期**：上游切聊天清空但不通知卡；我们若跟随，要**出声**（§一之四）。
2. **`position` 只暴露两个值**：TH 只给 `'in_chat'`/`'none'`，
   ST 的 `IN_PROMPT(0)` / `BEFORE_PROMPT(2)` **卡够不到**。我们若暴露更多，是升级侧。
3. **装配顺序按 key 字典序**（§一之五）——若我们按注册顺序或按 scriptId 排，是偏离，要记。
4. **uid 随机 + 二次探测，非自增**（§二之四）。若我们自增，卡若依赖"uid 不可预测"不会受伤，
   但**若我们复用 uid**，`createWorldbookEntries` 的切片认领会认错。
5. **书名 → 文件名只用一套判据**（§二之六，**已裁不照抄**）。
   上游是两套：判存在用 `world_names`（sanitize 后的 basename），
   取内容用 `/get`（服务端再 sanitize 一次），**名字含非法字符时两者结论相反**。
   **我们没有 `world_names` 那一层，所以照抄不一致没有对象**——
   取书统一走 `sanitize(name + '.json')`。
   **要写进偏离账本的是"我们少了一个不一致"，不是"我们改了规则"**：
   规则照抄，少的是上游那条多余的判存在路径。

---

## 五、未查

1. **`createWorldWithName` 对「铸出的名字」撞名怎么办**我没读完——
   对显式传名是 throw，铸名那条分支我只读到调用点。
   两个聊天的 id 折叠后同名是可能的（中文名整段变下划线）。
2. **世界书预算耗尽的具体算法**没跟到底。我读出的是「候选表顺序 = 遍历顺序」，
   **「先到先得」是这一步的推论，不是我读到的语句。**
3. **`xiaobaix-tasks` 之外的第三方脚本键**是否也承载注入/世界书调用，没查——
   44 上一轮量过「名单外的键零代码」，我沿用那个结论**没有独立复核**。
4. **群聊**：`group-chats.js` 里有 4 个 `clearChat` 调用点，群聊下的 chat 书语义我没看。
5. **本文所有数字都是我一个人量的**，44 没有复核这一批。
   §三的语料数与 §一/§二的上游行号，都还是单路径。
