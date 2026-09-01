# 脚本按钮 —— 设计输入

上游把脚本按钮渲染在哪、点击怎么变成脚本收到的事件、`visible` 是什么语义、增删的时序
如何。这份文档是按钮 UI 实现的规格上游。

**这是设计输入不是规格**：给出上游行为的逐字证据与建议，实现形状由实现者定。

测量日期 2026-09-02。上游对照 JS-Slash-Runner 4.9.1 本机检出。

## 口径

- 标 **[上游]** 的行号在 `data/default-user/extensions/JS-Slash-Runner/src/` 下，可复核。
- 标 **[语料]** 的来自 19 张真实角色卡的实测。
- **只记形状不记内容**：不列具体按钮名。

---

## 一、四个答案

| 问 | 答 |
| --- | --- |
| 渲染在哪 | **快速回复栏**（`#send_form` 里的 `#qr--bar`），不在消息内；QR 栏不存在时上游自己建一个并 **prepend 到发送表单** |
| 点击怎么接线 | `eventSource.emit(button_id)`，而 **`button_id` 就是事件名**：`${script_id}_${getStringHash(button_name)}` |
| `visible: false` | **不渲染**，但仍出现在 `getScriptButtons()` 的返回里。另有一层脚本级 `button.enabled` 总开关 |
| 增删时序 | 响应式，写 `script.button.buttons` 即刻重渲染；**但 `pagehide` 时查不到脚本**，上游有四处 TODO 承认 |

---

## 二、渲染位置

[上游] `panel/script/use_button_destination_element.ts:5-27`：

```ts
function recalculateElement($send_form) {
  // $('#qr--bar') 要求 id 唯一, 因此此处不使用      ← 上游原注释
  let $possible_qr_bar = $send_form.find('div').filter(function () {
    return $(this).attr('id') === 'qr--bar';
  });
  if ($possible_qr_bar.length > 1) {
    $possible_qr_bar.filter('.TH--qr--bar').remove();   // 自己建的那个让位给 QR 的
    ...
  }
  const $qr_bar = $possible_qr_bar.length > 0
    ? $possible_qr_bar.first()
    : $('<div id="qr--bar" class="TH--qr--bar flex-container flexGap5">').prependTo($send_form);
  if (_.get(extension_settings, 'quickReplyV2.isCombined')) {
    // 合并模式时再下一层
    return ($qr_bar.children('.qr--buttons').first()
            ?? $('<div class="qr--buttons">').appendTo($qr_bar))[0];
  }
  return $qr_bar[0];
}
```

四条要点：

1. **寄居在快速回复的 DOM 里。**有 QR 栏就用它，没有就自己建一个同 id 的，**prepend 到
   `#send_form`**——即输入框上方。
2. **冲突时让位**：出现多个 `#qr--bar` 时，删掉带 `.TH--qr--bar` 类的（自己建的那个），
   重新查询。**QuickReply 的栏优先。**
3. **QR 的合并模式要多下一层**（`quickReplyV2.isCombined` 时进 `.qr--buttons`）。
4. **必须观察 QR 的 DOM 变动才能活下来**（`:50-78`）：一个 `MutationObserver` 盯
   `#send_form` 的 `childList`+`subtree`，只要有 `#qr--bar` / `.qr--button` /
   `.qr--buttons` 的增删就重算挂载点。另外在 `APP_READY_EVENTS`
   （`[APP_READY, 'chatLoaded', SETTINGS_UPDATED]`，[上游] `util/tavern.ts:27`）
   和 `#qr--isCombined` 的 change 上也重算。

### 对我们的意义

用户实测 **快速回复是关的**（新旧两套 `isEnabled` 均为 false），所以我们**没有一个
现成的 QR 栏可以寄居**。

但上游在 QR 栏不存在时的行为已经回答了位置问题：**输入框上方的一条横栏**。
我们不需要复刻「寄居/让位/观察 QR 变动」这套——那三条的存在理由是与另一个扩展共用
DOM，而我们没有那个扩展。**这是可以干净分歧的一处：位置照抄，寄居机制不抄。**

---

## 三、事件接线：事件名就是按钮 id

[上游] `panel/Script.vue:40-57`：

```html
<Teleport v-if="!!button_element" defer :to="button_element">
  <div v-for="(buttons, script_id) in button_map" :key="script_id"
       class="qr--buttons flex gap-[5px]">
    <div v-for="button in buttons" :key="button.button_id"
         class="qr--button menu_button interactable"
         @click.stop.prevent="eventSource.emit(button.button_id)">
      {{ button.button_name }}
    </div>
  </div>
</Teleport>
```

- **每个脚本一个 `.qr--buttons` 容器**，按钮在里面
- 类名全部借用 QuickReply 的（`qr--button` `menu_button` `interactable`）——**外观继承
  QR 的样式**
- 点击 → `eventSource.emit(button_id)`，`@click.stop.prevent`

而 id 的生成，[上游] `store/iframe_runtimes/script.ts:6-8`：

```ts
export function getButtonId(script_id: string, button_name: string): string {
  return `${script_id}_${getStringHash(button_name)}`;
}
```

脚本侧拿到的是同一个字符串，[上游] `function/script.ts:54-56`：

```ts
export function _getButtonEvent(this: Window, button_name: string): string {
  return getButtonId(String(_getScriptId.call(this)), button_name);
}
```

**所以整条链是：**

```
卡:    eventOn(getButtonEvent('按钮名'), handler)
              ↓ 两边算出同一个 `${script_id}_${hash(name)}`
用户点击 → eventSource.emit(那个字符串) → handler 被调用
```

没有独立的事件类型，**按钮 id 直接当事件名用**。

⚠️ **按钮名参与 id 计算**，所以**改名 = 换事件**。已注册的监听器会失联，且不会报错。

> 有一个语法糖 `eventOnButton(name, fn)`，但它**已废弃**——`@types/iframe/event.d.ts:44`
> 写着「请使用 `eventOn(getButtonEvent('按钮名称'), 函数)` 代替」，实现就是那两句的组合
> （`function/event.ts:84-86`）。**规范形式是 `eventOn(getButtonEvent(...))`**，
> 上游更新日志里的旧例子用的是废弃写法。

### `getStringHash` 的算法（逐字兼容的判据）

事件名要对得上，哈希必须逐位相同。[上游] `public/scripts/utils.js:522-539`，是 **cyrb53**：

```js
function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') return 0;
    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
```

重写时四个必须照做的点：

1. **必须用 `Math.imul`**。普通 `*` 会溢出成浮点，结果不同——这是最容易写错且不报错的一处。
2. **`charCodeAt` 是 UTF-16 码元**，不是码点。**带 emoji 或其它星平面字符的按钮名，
   一个字符算两个码元**。用按码点遍历的写法（`for...of` / `codePointAt`）会得到不同的哈希。
3. **返回 Number 不是字符串**，上限 2^53-1；拼进 id 时按 JS 默认的 `String(number)` 转换。
4. `seed` 默认 `0`，上游调用只传一个参数。

**建议钉一组测试向量**（含一个纯 ASCII、一个中文、一个带 emoji 的按钮名），
判据是与上游同名函数逐字相等。

---

## 四、`visible` 与 `enabled`：两层过滤

[上游] `store/iframe_runtimes/script.ts:47-61`：

```ts
const button_map = computed(() => _(enabled_scripts_with_source.value)
  .filter(item => item.script.button.enabled && item.script.button.buttons.some(b => b.visible))
  .map(item => [item.script.id,
    item.script.button.buttons.filter(button => button.visible).map(button => ({...}))])
  .fromPairs().value());
```

三层，逐层正交：

| 层 | 字段 | 语义 |
| --- | --- | --- |
| 脚本 | `script.enabled` | 脚本本身跑不跑（`enabled_scripts` 的来源） |
| 按钮组 | `script.button.enabled`（默认 `true`） | 这个脚本的按钮**整组**显不显示 |
| 单个按钮 | `button.visible`（**无默认值，必填**） | 这一个显不显示 |

**关键：`visible: false` 只影响渲染，不影响存在。**`getScriptButtons()` 返回的是
`script.button.buttons` **未过滤**的完整数组（[上游] `function/script.ts:64`）。
所以脚本可以读到自己所有按钮（含隐藏的），把某个 `visible` 翻成 `true` 就出现。

## 数据形状

[上游] `type/scripts.ts:4-33`：

```ts
ScriptButton = { name: string, visible: boolean }        // 两个都必填

Script = {
  type: 'script', enabled: boolean (默认 false),
  name, id (uuidv4), content, info,
  button: { enabled: boolean (默认 true), buttons: ScriptButton[] (默认 []) },
  data: Record<string, any> (默认 {}),
  export_with: { data: boolean (默认 true), button: boolean (默认 true) },
}
```

`export_with` 值得注意：**导出脚本时是否带上按钮与 data 是可配的**。

---

## 五、增删时序

`button_map` 是 Vue `computed`，`_replaceScriptButtons` 写 `script.button.buttons`
即触发重渲染——**响应式，无需刷新**。写入前有 `!_.isEqual` 守卫（[上游]
`function/script.ts:80`），相同则不赋值。

四个写函数的漏斗与变量那套同构：

```
_appendInexistentScriptButtons(:110) → _updateScriptButtonsWith(:119)
_updateScriptButtonsWith(:93)        → _replaceScriptButtons(:101 / :105)
```
`appendInexistent` 的语义是**按 name 去重后追加**（`:120-121`）。

### 「二级按钮」不是数据结构，是用法

上游更新日志 3.2.5 引入 `getScriptButtons` / `replaceScriptButtons` 时给的例子就是它：

```typescript
eventOnButton('前往地点', () => {
  replaceScriptButtons(getScriptId(), [
    { name: '学校', visible: true },
    { name: '商店', visible: true },
  ]);
});
```

**点一个按钮，把整张按钮表换掉。**没有嵌套字段、没有父子关系、没有层级——
`ScriptButton` 就是 `{ name, visible }` 两个字段，`buttons` 就是一个平数组。

**所以数据模型是够的**，不需要为二级按钮加任何结构。要做的只是让
`replaceScriptButtons` 在运行时生效（它已经是响应式的）。

两个连带的注意：

- 这个模式下**按钮 id 会整批换掉**（名字变了，哈希就变了），所以脚本必须为新按钮
  重新 `eventOn(getButtonEvent(...))`。上游没有帮它做，**旧监听器留在 eventSource 上**。
- 例子里用的 `eventOnButton` 现已废弃，规范写法见 §三。

### 多脚本时的按钮顺序

可以从源码答出，不需要实测：

```ts
// store/iframe_runtimes/script.ts:26-32
_([global_scripts, preset_scripts, character_scripts])
  .flatMap(store => store.enabled_scripts.map(...))
// store/scripts.ts:83-91  组内顺序 = script_trees 的声明序，过滤 enabled，文件夹就地展开
```

**组间顺序：全局 → 预设 → 角色。组内顺序：脚本树里的声明序。**
`button_map` 那条链**没有再排序**，用 `_.fromPairs()` 按插入序建对象，Vue 的 `v-for`
按 `Object.keys` 迭代。

> ⚠️ **一处脆弱**：`fromPairs` 的键是 `script.id`（uuidv4），因为不是整数样式的字符串，
> JS 对象的插入序才得以保留。如果哪天 id 变成纯数字串，**顺序会被 JS 悄悄重排**。
> 我们如果用数组而不是对象来承载分组，就没有这个隐患。

### ⚠️ 上游自陈的一个缺陷：`pagehide` 时按钮 API 全部失效

`function/script.ts` 有**四处相同的 TODO**（`:60` `:75` `:126` `:135`）：

> `// TODO: 对于预设脚本、角色脚本, $(window).on('pagehide') 时已经切换了角色卡, get 会失败`

后果分两种，且都是静默的：

- `_getScriptButtons` → 返回 `[]`（`:61-63`）
- `_replaceScriptButtons` → **直接 return，什么都不做**（`:76-78`）

即**脚本在卸载时想改按钮，改不了，且没有任何声音**。这与 `OBSERVABILITY.md` 记的
「frame 卸载即销毁日志」是同一个时刻的两个症状——**卸载窗口是上游可观测性最薄的地方**。

---

## 六、语料实测：89 个按钮的真实构成

[语料] 19 张卡 → 14 张带脚本 → 61 个脚本 → **18 个带按钮，89 个按钮**。

```
visible: true    31
visible: false   58   （65%）
button.enabled === false 的脚本：0    ← 组级开关从没被关过
```

### 一个我差点报错的相关性

粗看：**16 个脚本有可见按钮，但只有 3 个在正文里调 `getButtonEvent`**。
这看起来像「13 个脚本渲染了没人监听的死按钮」。

**是错的。**按脚本正文长度再量一次：

```
389161 字节   ERA                    ✅订阅
    95 字节   ★仅一行远程 import      （MVU）
    94 字节   ★仅一行远程 import      （MVU）
    …  15 个这样的，85–95 字节
 18883 字节   章节管理器              ✅订阅
  2692 字节   剧情开启/关闭           ✅订阅 ✏️运行时改按钮
```

**18 个带按钮的脚本里，15 个是一行远程 `import` 的桩**（14 个 MVU + 1 个别的），
监听器在远程 bundle 里，卡片存储的 `content` 看不到它。而**能读到正文的 3 个，恰好
就是订阅了事件的那 3 个**——相关性是完美的。

所以真实构成是：**89 个按钮 ≈ MVU 的一套标准按钮 × 14 份复制 + 3 套定制**。
65% 的隐藏率不是卡作者的选择，是**一个框架的默认值被复制了 14 遍**。

### 三条给实现的结论

1. **按钮事件 API 必须对远程导入的模块代码可用**，不只是内联脚本正文——15/18 的
   消费者在 bundle 里。这与沙箱已有的远程 import 要求是同一条。
2. **运行时改按钮是罕见路径**：语料里只有 1 个脚本调 `replaceScriptButtons`，
   0 个调 `updateScriptButtonsWith` / `appendInexistentScriptButtons` /
   `getScriptButtons`。可以晚做，但 API 面要在。
3. **隐藏按钮不能不实现**：它们占 65%，而 `getScriptButtons()` 必须能读到它们
   （未过滤），否则 MVU 那套「翻可见性」的路径断掉。

---

## 七、建议

1. **位置照抄，寄居机制不抄**：输入框上方一条横栏。上游那套「与 QR 争夺 `#qr--bar`
   + MutationObserver 守护」的复杂度来自与另一个扩展共用 DOM，我们没有那个约束。
   **这是一处可以干净分歧的地方，理由要写进分歧账本的升级侧。**
2. **事件名照抄**：`${script_id}_${hash(button_name)}`，且 `getButtonEvent` 必须与渲染侧
   算出同一个字符串。哈希函数要与上游 `getStringHash` 一致，否则卡算出的名字对不上。
   **这条是硬兼容，不能分歧。**
3. **三层过滤照抄**，含 `getScriptButtons()` 返回未过滤数组这一点。
4. **卸载窗口要有声音**：上游在 `pagehide` 时按钮 API 静默失效（§五）。我们如果沿用
   同样的时序，至少要让失败可见——参见 `OBSERVABILITY.md` 的遗言通道。

## 两处可以比上游响（采不采由实现者定）

上游这两处都是**静默**，而具名失效是我们分歧账本里的既有强项。

**1. 改名导致监听器失联时报告出来。**
按钮名参与 id 计算（§三），所以 `replaceScriptButtons` 换掉一批按钮时，
旧 id 上的监听器就永远收不到事件了——上游不清理、不报告。
我们在替换时可以数一数**有多少监听器停在了已消失的按钮 id 上**，把这个数报出来。
零是常态，非零几乎总是 bug，而它现在完全不可见。

**2. 卸载窗口的按钮 API 失效要点名。**
上游四处 TODO 自认在 `pagehide` 时 `get` 会失败，后果是
`getScriptButtons` 返回 `[]`、`replaceScriptButtons` 直接 return——
**两者都不出声**。我们至少要让它抛或报，而不是让脚本以为自己改成功了。

---

## 未查

1. ~~`getStringHash` 的具体算法~~ —— **已补**，见 §三。是 cyrb53，
   `public/scripts/utils.js:522-539`，四个重写要点已列。
2. ~~按钮在 QR 栏里的排序规则~~ —— **已补**，见 §五。可从源码答出：
   组间「全局 → 预设 → 角色」，组内为声明序，`button_map` 不再排序。
   **仍未实测**，只是源码推断。
3. ~~上游按钮有没有二级/下拉形态~~ —— **已补**，见 §五。**没有嵌套数据结构**，
   「二级按钮」是运行时换整张表的用法模式，现有平数组模型够用。
4. **`script.info` 的用途**——有 `getScriptInfo` / `replaceScriptInfo`
   （`function/script.ts:134-149`），与按钮同属脚本元数据，但**未查它渲染在哪**。
   （裁决：可以留，不阻塞按钮实现。）
