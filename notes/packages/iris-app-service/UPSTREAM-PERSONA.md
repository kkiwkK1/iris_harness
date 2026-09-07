# 上游语义：Persona（用户人格）——存在哪、几个出口、哪些出口改了文本

**只给事实与位置，不评价任何实现。**本文件回答的是「上游把 persona 放在哪、谁读它、
读到的是不是同一份文本」，不回答我们该怎么做。

## 口径

- **正读**，不是转述。源是**用户本机的 ST 装机**：`E:/sillyTavern/SillyTavern`，
  `package.json` `"version": "1.18.0"`。行号是这个装机上的行号。
- 只读。没有启动 ST，没有点任何界面，没有改任何文件；`secrets.json` 未读。
- `settings.json` 的取值是只读统计（`data/default-user/settings.json`），用来回答
  「这台机器改过没有」——**这条路径答不了「别的机器长什么样」**（METHODS §十九）。
- **证据等级说明**：本文件的前身是另一支分支文档里的**转述**（四条，引
  `personas.js:1963`、`script.js:3352`、`openai.js:1424`、`world-info.js:2601-2639`）。
  逐条复核后：**结论方向全部成立，四个行号有三个要修**，且**出口数比转述的多**。
  差异在文末「与转述的差」一节逐条列出。

---

## 一、存储：`power_user` 下的五个字段

```js
// [ST] public/scripts/power-user.js:288-294   export const power_user = { … }
persona_descriptions: {},                                          // :288  按头像文件名索引的人格库
persona_description: '',                                           // :290  **当前激活的那一份描述正文**
persona_description_position: persona_description_positions.IN_PROMPT,  // :291
persona_description_role: 0,                                       // :292
persona_description_lorebook: '',                                  // :294  绑定的世界书名
```

**都在 `power_user` 里，随 `settings.json` 一起走**，没有独立文件。
`persona_description_depth: 2` 在 `:293`。

**本机实配（只读统计）**：`persona_description = ""`（0 字）、`position = 0`、`depth = 2`、
`role = 0`、`lorebook = ""`。**五个字段一个都没改过，人格描述是空的。**

> 空描述是有语义的：`script.js:3148` 的第一道守卫就是
> `if (!power_user.persona_description || position === NONE) return;`——
> **描述为空与「位置设为 NONE」走同一条 return。**

## 二、位置枚举：**六个值，五个词**

```js
// [ST] public/scripts/personas.js:88-98
export const persona_description_positions = {
    IN_PROMPT: 0,
    /** @deprecated Use persona_description_positions.IN_PROMPT instead. */
    AFTER_CHAR: 1,
    TOP_AN: 2,
    BOTTOM_AN: 3,
    AT_DEPTH: 4,
    NONE: 9,
};
```

名字表只有**五个**（`AFTER_CHAR` 没有对应的词）：

```js
// [ST] public/scripts/personas.js:1966-1972
const POSITION_NAME_MAP = Object.freeze({
    'inprompt': IN_PROMPT, 'topan': TOP_AN, 'bottoman': BOTTOM_AN,
    'atdepth': AT_DEPTH,   'none': NONE,
});
```

```js
// [ST] public/scripts/personas.js:1989-1996
function parsePersonaPosition(value) {
    if (value === undefined || value === null) return null;
    const strValue = String(value).toLowerCase();
    if (strValue in POSITION_NAME_MAP) return POSITION_NAME_MAP[strValue];
    const numValue = Number(value);
    if (!isNaN(numValue) && Object.values(persona_description_positions).includes(numValue)) return numValue;
    return null;
}
```

> **「五个词全收」是对的，但那不是全集。**第二条分支用
> `Object.values(persona_description_positions).includes(numValue)` 收**数字**，
> 而那个数组含 `AFTER_CHAR = 1`。所以 **`parsePersonaPosition(1)` 返回 `1`，
> 而 `parsePersonaPosition('afterchar')` 返回 `null`**——
> **同一个已废弃的位置，走数字进得来，走名字进不来。**
> 照抄只做名字表会拒掉一个上游接受的输入；照抄只做数字会多收一个没有名字的值。

`parsePersonaRole`（`:2003-2010`）是同构的第二个函数，数字分支的判据是 `0 <= n <= 2`。

`5` 到 `8` 不在枚举里：数字分支按 `Object.values(...).includes()` 判，**不是范围判**，
所以 `parsePersonaPosition(5)` 是 `null`。

## 三、四个写出口，两种文本处理

**这是本文件的承重结论。**同一份 `power_user.persona_description`，
**有的出口发的是原文，有的发的是被 `trim()` + 宏替换过的版本**。分界线**不是**
「宏 vs 其它」，而是**「经不经过 `getCharacterCardFieldsLazy()`」**。

### 出口表

| # | 出口 | 位置 | **写出去时**的文本形态 | **到模型手里时** | 门 |
| --- | --- | --- | --- | --- | --- |
| 1 | **`{{persona}}` 宏 / story-string / WI 扫描缓冲** | `[ST] script.js:3353`（解析器）→ `:4404` 解构 → `:4647`、`:4568` | **`baseChatReplace(persona_description?.trim())`** | 同左——**展开发生在写入时** | `:4647` 与 `:5308` 另加 `position === IN_PROMPT` 门；`:4568` **无门** |
| 2 | **Chat Completion 的 `personaDescription` 槽** | `[ST] openai.js:1424-1425` | **原文** | **已展开、未 trim**：`openai.js:1479` 对每个 `systemPrompts` 条目调 `promptManager.preparePrompt(prompt)`，其中 `PromptManager.js:1277-1287` 走 `substituteParams(prompt.content)` | `persona_description && position === IN_PROMPT` |
| 3 | **深度注入（`AT_DEPTH`）** | `[ST] script.js:3164` | **原文** | **已 trim、已展开**：`getExtensionPrompt` 先 `x.value.trim()`（`script.js:3259`）再 `substituteParams(values)`（`:3266-3268`） | `position === AT_DEPTH` |
| 4 | **拼进作者注释（`TOP_AN` / `BOTTOM_AN`）** | `[ST] script.js:3154-3160` | **原文** | 同 3——它也是一条 `extension_prompt`（写进 `NOTE_MODULE_NAME`），出口同为 `getExtensionPrompt` | 位置命中 **且 `shouldWIAddPrompt`** |

### 出口 1 的链路（三个消费者共用一份文本）

```js
// [ST] script.js:3343  export function getCharacterCardFieldsLazy({ chid } = {}) { … }
// [ST] script.js:3353  解析器
persona: () => baseChatReplace(power_user.persona_description?.trim()),
```

```js
// [ST] script.js:3282-3293
export function baseChatReplace(value, name1Override = null, name2Override = null) {
    if (typeof value === 'string' && value.length > 0) {
        value = substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false });
        if (power_user.collapse_newlines) { value = collapseNewlines(value); }
        value = value.replace(/\r/g, '');
    }
    return value;
}
```

**所以出口 1 的文本比存储值多了三层处理**：`trim()`、`substituteParams`（宏展开，
`replaceCharacterCard: false`）、去 `\r`，以及 `collapse_newlines` 开时的折行合并。

`Generate()` 在 `:4400-4404` 把它解构成局部 `persona`，然后：

```js
// [ST] script.js:4647   story-string 参数
persona: power_user.persona_description_position == persona_description_positions.IN_PROMPT ? persona : '',
// [ST] script.js:5308   itemization 的 userPersona，同门
// [ST] script.js:4568   世界书扫描数据 —— **没有位置门**
personaDescription: persona,
```

> **`:4568` 那一处值得单记**：它是 `globalScanData.personaDescription`，
> 交给 `getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData)`（`:4576`）。
> **它不看 `persona_description_position`**——所以即使位置是 `NONE`，
> 人格描述**仍然进世界书的扫描面**（前提是条目自己开了 `matchPersonaDescription`，见 §五）。

### 出口 2、3、4 读的是存储原文

```js
// [ST] openai.js:1424-1425
if (power_user.persona_description && power_user.persona_description_position === persona_description_positions.IN_PROMPT) {
    systemPrompts.push({ role: 'system', content: power_user.persona_description, identifier: 'personaDescription' });
}
```

```js
// [ST] script.js:3144-3167   addPersonaDescriptionExtensionPrompt()
const INJECT_TAG = 'PERSONA_DESCRIPTION';
setExtensionPrompt(INJECT_TAG, '', extension_prompt_types.IN_PROMPT, 0);           // :3146 每次先清空

if (!power_user.persona_description || power_user.persona_description_position === persona_description_positions.NONE) {
    return;                                                                        // :3148-3150
}

const promptPositions = [BOTTOM_AN, TOP_AN];
if (promptPositions.includes(power_user.persona_description_position) && shouldWIAddPrompt) {
    const originalAN = extension_prompts[NOTE_MODULE_NAME].value;                   // :3155
    const ANWithDesc = position === TOP_AN
        ? `${power_user.persona_description}\n${originalAN}`
        : `${originalAN}\n${power_user.persona_description}`;                       // :3156-3159
    setExtensionPrompt(NOTE_MODULE_NAME, ANWithDesc, chat_metadata[metadata_keys.position],
        chat_metadata[metadata_keys.depth], extension_settings.note.allowWIScan, chat_metadata[metadata_keys.role]);
}

if (power_user.persona_description_position === persona_description_positions.AT_DEPTH) {
    setExtensionPrompt(INJECT_TAG, power_user.persona_description, extension_prompt_types.IN_CHAT,
        power_user.persona_description_depth, true, power_user.persona_description_role);   // :3164
}
```

**三条形状**：

1. **`:3146` 每次先把 `PERSONA_DESCRIPTION` 设成空串**再决定要不要填——
   位置从 `AT_DEPTH` 改成别的之后，旧注入不会残留。
2. **出口 4 是「劫持作者注释」，不是自己一个槽**：它把描述拼进 `NOTE_MODULE_NAME` 的
   现有值里，用的是**作者注释自己的** position/depth/role（`chat_metadata`），
   **不是 persona 的**。所以 `persona_description_depth` / `_role` 只对出口 3 有效。
3. **出口 4 多一道门 `shouldWIAddPrompt`**——它是世界书那侧的状态。
   位置选了 TOP_AN/BOTTOM_AN 而这道门是假时，**描述哪儿都不去，静默**。

### 一句话形式

**⚠ 这一段初版写错了方向，2026-09-06 更正（消费点由 6d 读出，行号我复核过）。**
初版写的是「另外三支发存储原文……**原样送到 provider**」。**括号里那句
「除非下游另有展开」正是实际情况**，而它被写成了旁注——所以整句读起来像
「宏到不了模型」，方向反了。正确的形式是两句：

> **① 到模型手里时，四支全都宏展开过。**分界不在「展开与否」，在**展开的时机**：
> 出口 1 在**写入时**展开（`baseChatReplace` → `substituteParams`），
> 出口 2/3/4 在**读出时**展开（`preparePrompt` / `getExtensionPrompt`）。
>
> **② 真正的差别是 `trim()`：出口 1、3、4 有，出口 2 没有。**
> 一个以空白开头/结尾的人格描述，只有走 **CC 的 `personaDescription` 槽**那一支
> 会把空白带到模型；另外三支都被裁掉。

**所以「经不经过 `getCharacterCardFieldsLazy()`」仍然是一条真实的分界线**——
它决定文本**在哪一步**被处理、以及 `collapse_newlines` 与去 `\r` 走不走
（那两样只有 `baseChatReplace` 做，见 `script.js:3282-3293`）——
**但它不是「宏展没展开」的分界线。**

*（教训归档：这条一句话形式把「事实」和「未查的旁注」焊在同一句里，
读者拿不到那半句的置信度。见 `METHODS.md` §八「理由句和结论句」与
`separate-the-fact-from-the-recommendation`。）*

## 四、persona 绑定的世界书

`power_user.persona_description_lorebook`（默认 `''`，`power-user.js:294`）。

- 读取点：`personas.js:641, 1272, 1298, 1302-1305, 1343, 2236`；
  `world-info.js:1093`（斜杠命令回调 `getPersonaBookCallback`：有绑定就返回，
  带 `create` 才新建并写回 `:1100`）。
- **删书时会解绑**：`world-info.js:4270-4276`——被删的书名等于绑定名就清空并熄灭
  `#persona_lore_button` 的 `world_set`。
- **去重是双向的，不是一个顺位表。**两侧各自跳过「已经在别处激活过」的书，
  `console.debug` 的原文是唯一可靠的锚：

  | 谁在跳 | 跳掉的理由 | 行 |
  | --- | --- | --- |
  | 角色书 | 已在 **global** 激活 | `world-info.js:4388` |
  | 角色书 | 已在 **chat** 激活 | `:4393` |
  | 角色书 | 已在 **persona** 激活 | `:4398` |
  | chat 书 | 已在 **global** 激活 | `:4440` |
  | persona 书 | 已在 **chat** 激活 | `:4461` |
  | persona 书 | 已在 **global** 激活 | `:4466` |

  ```js
  // [ST] world-info.js:4397-4400
  if (power_user.persona_description_lorebook === worldName) {
      console.debug(`[WI] Character ${name}'s world ${worldName} is already activated in persona lore! Skipping...`);
      continue;
  }
  ```

  **所以同一本书被两处绑定时，谁被丢掉是有向的**：角色书让位于 persona；
  persona 书让位于 chat 与 global。**没有一条规则让 persona 赢过 chat 或 global。**

- 有斜杠命令读它：`world-info.js:1696-1697`，别名 `getpersonalore` / `getpersonawi`，
  「没设则返回空字符串」。

## 五、persona 描述进世界书扫描面

条目级开关 `matchPersonaDescription`，**默认 `false`**：

```js
// [ST] world-info.js:4018
matchPersonaDescription: { default: false, type: 'boolean' },
```

盘面键名映射（`originalWIDataKeyMap`，`world-info.js:2607-2644`，共 **36 个字段**——
数过，不是估的）：

```js
'matchPersonaDescription': 'extensions.match_persona_description',
```

同族的另外五个是 `matchCharacterDescription` / `matchCharacterPersonality` /
`matchCharacterDepthPrompt` / `matchScenario` / `matchCreatorNotes`（`:2629-2633`）。
读盘时的兜底在 `:5542`：`entry.extensions?.match_persona_description ?? false`。

消费点只有一个：

```js
// [ST] world-info.js:299-300
if (entry.matchPersonaDescription && this.#globalScanData.personaDescription) {
    result += JOINER + this.#globalScanData.personaDescription;
}
```

**两个条件都要真**：条目开了这个开关，**且**这一轮的 `globalScanData.personaDescription`
非空——而后者就是 §三 出口 1 的那份 trim 过的文本（`script.js:4568`），**无位置门**。

`WIGlobalScanData` 的字段声明在 `world-info.js:106`，默认值 `personaDescription: ''`（`:188`）。

## 六、与转述的差（逐条）

| 转述说的 | 正读结果 | 性质 |
| --- | --- | --- |
| `personas.js:1963` = `parsePersonaPosition` | 实际在 **`:1989-1996`**（`POSITION_NAME_MAP` 在 `:1966-1972`） | 行号差 26，函数与内容对 |
| `script.js:3352` = 宏取 `trim()` | 实际在 **`:3353`** | 差 1 行 |
| `openai.js:1424` = CC 槽取原文 | **精确**（`:1424-1425`） | 对 |
| `script.js:3164` = 深度注入取原文 | **精确** | 对 |
| `world-info.js:2601-2639` = 装载转换表 | 实际 **`:2607-2644`**；它是 `originalWIDataKeyMap`，**全条目字段的通用映射表**，persona 只占其中一行 | 行号与范围都要修；「从 `extensions` 读」的方向对 |
| **「三读取点两处理」** | **四个出口**（多一个 TOP_AN/BOTTOM_AN 劫持作者注释），而且分界不是「宏 vs 其它」，是**「过不过 `getCharacterCardFieldsLazy()`」**；同一支里还有第三、第四个消费者（story-string `:4647`、WI 扫描 `:4568`），其中 WI 扫描那个**没有位置门** | 方向对，粒度不够 |

**没有一条方向相反。**修的都是位置与粒度。

## 七、未查 / 限定

**已结（2026-09-06）：四个出口的消费点已读。**初版只跟到「谁把文本写出去」，
没跟到「谁把它读回来送给模型」，于是 §三 的一句话形式方向写反了（更正见该节）。
读出来的三条消费点，行号我逐条复核过：

- **出口 2**：`[ST] openai.js:1479` 对 `systemPrompts` 的**每个**条目
  （含 `:1425` push 的 `personaDescription`）调 `promptManager.preparePrompt(prompt)`；
  `[ST] PromptManager.js:1277-1287` 里是 `substituteParams(prompt.content)`。
  **展开，不 trim。**
- **出口 3 与出口 4**：都是 `extension_prompt`，同一个出口
  `getExtensionPrompt`——`[ST] script.js:3259` 的
  `prompts.map(x => x.value.trim()).join(separator)`，随后 `:3266-3268` 的
  `if (values.length) { values = substituteParams(values); }`。**先 trim 后展开。**
- **出口 1** 的展开在写入侧（`baseChatReplace`，`script.js:3282-3293`），
  消费点不再处理。

*（这一格是 6d 顺着三支往下读出来的；本文件只复核并记录。）*

1. **`persona_descriptions`（人格库，`power-user.js:288`）的写入与切换路径没读。**
   本文件只跟了「当前激活的那一份」`persona_description`。
   `script.js:7835-7837` 有一处按 `avatarId` 建库条目、位置固定写 `IN_PROMPT`，未展开。
2. **`shouldWIAddPrompt` 何时为真没查**——它是出口 4 唯一的额外门，
   而门关着时的失败是静默的。
3. **文本补全路径（`main_api !== 'openai'`）的 story-string 装配没读。**
   出口 1 的 `:4647` 是 story-string 参数，本文件只确认了它取哪份文本、带哪道门。
4. **本机 persona 是空的**，所以以上全部是静态读，**没有一条经过运行观测**。
   要证伪任何一条，需要在**我们自己的实例**上设一份带首尾空白与 `{{user}}` 的人格描述，
   看四个出口各自收到什么——不在用户的 ST 上做。
