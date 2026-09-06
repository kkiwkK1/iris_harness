# 消息正文的内联 HTML —— 设计输入

**给 a8，和 `RENDER.md` 并排。**这是设计输入不是规格：给出上游地板的实测、我们该收紧到哪、
以及 `<style>` 的作用域方案与其代价。实现形状由实现者定。

日期 2026-09-02。笔者：上游研究域（3c）。

## 口径

- **[上游]** 行号在 `E:/sillyTavern/SillyTavern/public/` 下，ST 1.18.0。
- **[DP]** 行号在 `E:/sillyTavern/SillyTavern/node_modules/dompurify/dist/purify.cjs.js`，
  **DOMPurify 3.4.2**（`package.json:48` 声明 `^3.4.2`，装的是 3.4.2）。
- **[语料]** 来自 44 的普查，**渲染后**（经卡自己的 `regex_scripts`，`isMarkdown: true`），
  31 个 chat JSONL。他的原话我保留在 §五。
- 所有「零」都是**当前语料的零，不是机制保证**。这条是 44 提的，我原样接受并贯穿全文。

---

## 〇、这份文档治的正是用户看到的爱衣（一处更正，链条保留）

**结论先说：内联消毒渲染就是修用户屏幕上那个爱衣的东西**，外加命定之诗那 887 楼。
按这条排优先级。

下面保留完整的更正链，因为**中间那一版是我写的、而且它反着说**，
只改结论不留链条的话，读到旧版转述的人无从判断哪一版新。

### 第一版（委托时的诊断）

「爱衣的状态栏显示成文本」→ 诊断为「片段没被消毒渲染」。

### 第二版（我写的，**错的就是这一版**）

我拿 44 的语料读数推翻了第一版：语料里的爱衣**只有 1 楼**，渲染后 `is_frontend = YES`，
含 `html`/`head`/`body`/`script`/`style`，是**完整文档**。于是我写下
「爱衣是完整文档被 frame 路径漏接」「**这份文档不治爱衣**」「修好内联消毒不会让爱衣显示出来」。

### 第三版（7b 逐楼跑真管线，推翻第二版）

**用户屏幕上的爱衣，是 dev 数据目录里模型生成的一个 9 楼聊天**，不是语料里那个文件：

| 楼 | 内容 | 判据 | 归属 |
| --- | --- | --- | --- |
| 0（开场白） | 有围栏 | `claim = 1` | frame 路径能框，**没问题** |
| **6、8** | `<details>` + `<style>` **片段**，无 `html`/`head`/`body`、**无围栏** | 两条都不命中 | **正是本文 936 楼片段带的成员** |

**所以修内联消毒 = 让 6/8 楼渲染成可折叠的 `<details>` 控件**，也就是用户想看到的那个状态栏。

### 三份读数不矛盾——是三个对象

| 读数 | 对象 | 结论 | 对不对 |
| --- | --- | --- | --- |
| 44 的语料普查 | `E:\sillyTavern` 语料里的爱衣文件（1 楼） | 完整文档 | **对** |
| 我的第二版 | 同上 | 完整文档被 frame 漏接 | **对语料文件成立** |
| 7b 的逐楼管线 | **dev 数据目录里、用户屏幕上那个 9 楼聊天** | 6/8 楼是片段 | **对** |

**没有人量错。我把三份读数当成了同一个对象。**

### 我的错法，值得单记

「爱衣」是一张**卡**的名字，我把它当成了一个**文件**的名字。
三个来源说「爱衣」时指的是三份不同的数据，而我一次都没问「你读的是哪个文件」。
**一个正确的测量，套在错的对象上，能通过每一项自查**——它内部完全自洽，
只有和另一个对象的读数并排时才露馅。

更该记的是**这个错的方向**：我在这一节的旧版里亲手写下

> 一份在错前提下委托的文档，如果不说，读者会默认它治的是委托时那个病。

然后犯了它的镜像——**明确告诉读者这份文档"不治"一个它其实正好治的病。**
写下一条纪律不构成执行它；这一条我是写完之后立刻违反的。

---

## 一、上游地板：消息正文这条链的确切形状

```
messageFormatting(mes, ...)                                    [上游] script.js:1753
  ├─ getRegexedString(...)                                     script.js:1809   ← 正则在 HTML 存在之前跑
  ├─ converter.makeHtml(...)   showdown                        script.js:521-531
  ├─ encodeStyleTags(mes)                                      script.js:1907
  ├─ DOMPurify.sanitize(mes, config)                           script.js:1908
  └─ decodeStyleTags(mes, { prefix: '.mes_text ' })            script.js:1909
```

### 1.1 消息正文的 DOMPurify 配置就这么多

```js
// [上游] script.js:1898-1906
/** @type {DOMPurify.Config} */
const config = {
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
    RETURN_TRUSTED_TYPE: false,
    MESSAGE_SANITIZE: true,          // 自定义旗标，只被 ST 自己的钩子读
    ADD_TAGS: ['custom-style'],      // 唯一的标签定制
    ...sanitizerOverrides,
};
```

**消息路径上没有任何 `FORBID_TAGS` / `FORBID_ATTR` / `ALLOWED_TAGS` / `ALLOWED_ATTR` /
`ALLOW_UNKNOWN_PROTOCOLS` 定制。**在 `public/`（排除 `node_modules/` 和 `lib/`）全文搜过，
唯一命中在 `public/scripts/slash-commands.js:4579-4580`（`FORBID_TAGS: ['style']`），**那是另一条路**。

**所以「上游允许什么」= DOMPurify 3.4.2 的出厂默认 + 三个钩子。**

### 1.2 出厂默认到底是什么（这才是地板的真身）

| 默认项 | 值 | [DP] |
| --- | --- | --- |
| `ALLOWED_TAGS` | 内置 HTML 集，**121 个**；含 `details` `summary` `style` `form` `input` `button` `img` `video` `audio` `template` | `:257` |
| | **不含 `script`，不含 `iframe`** | `:257` |
| `ALLOWED_ATTR` | 内置 HTML 属性集，含 `class` `style` `href` `src` `srcset` `id` `type` | `:271` |
| | **不含任何 `on*`**（事件属性靠不在名单里被剥，不是靠黑名单） | `:271` |
| `ALLOW_DATA_ATTR` | **`true`** —— 所有 `data-*` 默认放行 | `:499, :628` |
| `ALLOW_ARIA_ATTR` | `true` | `:497, :627` |
| `ALLOW_UNKNOWN_PROTOCOLS` | **`false`** —— `javascript:` 被 URI 正则挡掉 | `:501, :629` |
| `IS_ALLOWED_URI` | `^(?:(?:(?:f\|ht)tps?\|mailto\|tel\|callto\|sms\|cid\|xmpp\|matrix):\|…)` | `:282` |
| `SAFE_FOR_XML` | `true` | `:512, :632` |

值得单记一条：**`<style>` 在默认 `ALLOWED_TAGS` 里**（`:257`）。DOMPurify 只在一种情况下删它——
`SAFE_FOR_XML && tagName === 'style' && 有元素子节点`（`:1014`）。**纯 CSS 文本的 `<style>` 原样通过。**
这条在 §二 会变成一个真问题。

### 1.3 三个钩子（[上游] `chats.js:1901-1970`，`addDOMPurifyHooks`）

| 钩子 | 门控 | 做什么 |
| --- | --- | --- |
| `afterSanitizeAttributes` | **无门控** | 任何带 `target` 的节点 → `target="_blank"` `rel="noopener"` |
| `uponSanitizeAttribute` | `MESSAGE_SANITIZE` | **class 名字空间化**：非 `fa-*` / `note-*` / 非 `monospace` 的类名一律改写成 `custom-<原名>`；例外是 `MESSAGE_ALLOW_SYSTEM_UI && classList 含 menu_button && 节点是 BUTTON/DIV` |
| `uponSanitizeElement` | `MESSAGE_SANITIZE` | ① `HTMLUnknownElement` 里换行 → `<br>`（`<pre>` 内文本跳过）② 若 `!isExternalMediaAllowed()`，拦 `AUDIO/VIDEO/SOURCE/TRACK/EMBED/OBJECT/IMG` 的外链 `src`/`data`/`srcset` |

class 名字空间化那条是**防碰撞**，不是防脚本：卡片写 `class="menu_button"` 不能借此改宿主 UI 的样式。

`isExternalMediaAllowed()`（[上游] `chats.js:852-866`）是全局
`power_user.forbid_external_media` **加每卡覆盖**（`external_media_allowed_overrides` /
`external_media_forbidden_overrides`）。**这台机器上 `forbid_external_media: false`——
也就是外链媒体是放行的**，所以钩子②在这个用户身上是空转的。

---

## 二、`<style>`：上游确实做了作用域化，但机制是字符串的

总指挥问「上游怎么处理 `<style>`，有没有作用域化还是放任漏出」。**答案是有，做法是选择器前缀。**

### 2.1 机制

```js
// [上游] chats.js:536-541
export function encodeStyleTags(text) {
    const styleRegex = /<style>(.+?)<\/style>/gims;
    return text.replaceAll(styleRegex, (_, match) =>
        `<custom-style>${encodeURIComponent(match)}</custom-style>`);
}
```

`<style>` **从来不到 DOMPurify 面前**——它先被百分号编码成 `<custom-style>`（这就是 `ADD_TAGS`
里那一项的用途），消毒完再解回来。解的时候（`decodeStyleTags`，`chats.js:551-626`，
注明 `@copyright https://github.com/kwaroran/risuAI`）用真正的 CSS 解析器逐条改写：

| 动作 | 行号 |
| --- | --- |
| 每个 selector 前面加 `.mes_text ` | `chats.js:560` |
| selector 里的 `.foo` → `.custom-foo`（和 DOMPurify 钩子的 class 改写**成对**） | `chats.js:594` |
| `:has()` `:not()` `:where()` `:is()` `:matches()` `:any()` 内部递归改写（防止用嵌套伪类绕过前缀） | `chats.js:571-584` |
| **`@import` 无条件过滤掉** | `chats.js:605` |
| 外链媒体不允许时，丢弃任何值含 `://` 的声明 | `chats.js:565` |
| 出错时整块变成 `CSS ERROR: <message>` 文本 | `chats.js:623` |

`:594` 那条值得单说：**CSS 侧的 `.foo → .custom-foo` 和 HTML 侧钩子的 class 改写是同一个改写，
分两处实现。**它们必须一致，否则卡片的 CSS 会找不到自己的元素。这是一个**跨文件的耦合不变式**，
上游没有测试固定它——我们如果照抄，要把这条不变式做成一个断言，不是两处巧合。

### 2.2 上游这套的实际精度：挡住了宿主 UI，挡不住跨消息

`.mes_text` 是**每条消息**都有的类（`index.html:7447` 的 `#message_template` 里
`<div class="mes_text"></div>`，`script.js:1978` / `:2637` 每条消息各填一份）。

所以 44 抽出的那 4 个裸元素选择器，上游改写后是：

```
details summary::marker          →   .mes_text details summary::marker
details[open] .we-arrow          →   .mes_text details[open] .custom-we-arrow
```

**结果：暗渊那 23 楼的样式不会碰 ST 自己的 UI，但会碰每一条其它消息里的 `<details>`。**
上游的作用域粒度是**容器类级**，不是**消息级**。

这不是吹毛求疵：命定之诗单局 677 楼、`<details>` 917 个，**跨消息漏出在这个语料上是必然发生的**，
只是所有 `<details>` 恰好来自同几张卡、样式互相兼容，所以看不出来。**「没出问题」和「挡住了」是两回事。**

### 2.3 上游有个真洞：作用域机制挂在一个字面正则上

`encodeStyleTags` 的正则是 `/<style>(.+?)<\/style>/gims`——**`<style>` 是字面量，不容属性。**

于是：`<style type="text/css">…</style>` **匹配不上** → 不被编码 → 直接进 DOMPurify →
`style` 在默认 `ALLOWED_TAGS` 里（[DP] `:257`）、`type` 在默认 `ALLOWED_ATTR` 里（`:271`）、
纯 CSS 文本没有元素子节点所以 `:1014` 那条删除分支不触发 →
**它作为一个真正的、未加任何前缀的 `<style>` 元素活着进入页面。**

也就是说，**上游的 `<style>` 作用域化，可以被加一个属性绕过。**

### 2.3.1 这个洞**当前语料没有踩到**（44 补查，2026-09-02）

```
渲染后全部 235 个 <style> 开标签      全部是裸的 <style>，一个属性都没有
  BAND  (936 楼片段)     24×   暗渊、银麒赎世
  FRAME (189 楼全文档)  211×   12 张卡
带属性的 <style …>                    0×
```

**所以上游此刻没在漏这一关**——那条字面量正则对这 235 个全部命中，全部会被加前缀。

**但这个发现要留在文档里，理由变强了不是变弱了：**

1. **绕行形状在这个用户的数据里确实存在。**（我量的，口径是**渲染前**的磁盘文本）
   `<style type="text/tailwindcss">` 在 3 个世界书文件里出现 **4 次**
   （`worlds/命定之诗与黄昏之歌v3.0.4.json`、`worlds/板板鸭 v2.0.json`、`worlds/萧谴写卡助手版_V4.5.1.json`）。
   它们渲染后没出现在带里，是因为那几处走完整文档、内容没经过消息正则展开。
   **换一张卡把带属性的 `<style>` 放进 display 正则，上游立刻就漏。**
2. **它是「字面量匹配」这个实现选择的必然后果，不是偶然。**
   `<style id=…>`、`<style media=…>`、乃至 **`<style >`（多一个空格）**都绕过去。
   不是「会不会发生」的问题，是「什么时候」。

**给我们的教训不是「补这个正则」，是：作用域机制不能挂在字符串匹配上。**
我们必须在**解析后的 DOM 上**处理每一个 `<style>` 元素——那时候有没有属性已经无关紧要了。

换个说法，这条不是「我们比上游严」：
**上游的作用域化是文本级的，所以它的覆盖面取决于正则的字面形状；DOM 级处理没有这个耦合。**
**我们要的是不继承一个能被一个空格绕开的边界。**

### 2.3.2 两个洞在同一条链上，状态不一样——别把它们当一件事

| | 洞 | 此刻 | 我们的堵法 |
| --- | --- | --- | --- |
| **编码这一关**（§2.3） | 字面量正则可被属性/空格绕过 | **未被触发**（235/235 全裸） | 在解析后的 DOM 上处理 `<style>` 元素 |
| **粒度这一关**（§2.2） | 前缀是容器类级，挡 UI 不挡跨消息 | **必然正在发生**（917 个 `<details>` 全被暗渊那 4 个裸元素选择器命中） | `@scope` 到候选序号 |

**「上游此刻正在漏」是真的，但漏的是第二关不是第一关。**
两个洞的证据强度、紧迫性、以及"改了会不会打到现存卡"都不同，
合起来说会让一个已在发生的问题借另一个假想问题的名义排期，或者反过来。

### 2.4 上游确实有一条「卡片样式作用于全页」的路，但不在消息正文上

总指挥问「有没有卡靠 `<style>` 注入影响全页」。**有，恰好一条，而且不是消息正文：**

```js
// [上游] chats.js:684-700  formatCreatorNotes —— 作者注释的渲染
const preference = new StylesPreference(avatarId);
const sanitizeStyles = !preference.get();
const decodeStyleParam = { prefix: sanitizeStyles ? '#creator_notes_spoiler ' : '' };
//                                                   ↑ 前缀为空串 = 真·全页
```

`StylesPreference`（`chats.js:631-676`）把开关存在 `accountStorage` 的
`AllowGlobalStyles-<avatarId>` 下，**每张卡一个，默认 `false`**，
由 `openGlobalStylesPreferenceDialog()`（`chats.js:705`）弹一个二选一对话框显式征求同意。

对照消息正文（`script.js:1909`）：**前缀是写死的 `.mes_text `，没有开关、没有每卡覆盖、不可关闭。**

**这个对照本身就是上游的一条设计意见，我认为是对的**：
「让卡片的 CSS 作用于整个应用」是一个存在的需求，上游的处理是——
**把它挪出消息流，限制在作者注释这一处，默认关，并且要求用户对具体那张卡显式点头。**
不是"不给"，是"给在一个有边界、有同意、有归属的地方"。这条建议我们照搬。

---

## 三、上游对「片段 vs 全页」根本没有分流

这条总指挥问了，答案可能和预期不一样：**上游没有这个判断。**

- **普通消息 HTML 不走任何特殊路由。**它在 showdown 里原样穿过（`script.js:521-531`
  的 converter 配置没有关掉原始 HTML 透传），然后被 §一那条链**就地消毒渲染**。
  一条路，所有消息都走它。
- **`is_frontend` 那条 iframe 化是扩展加在已渲染 DOM 上的第二个机制**，
  只挑 `<pre>` 元素（`store/iframe_runtimes/message.ts:13-14`），
  判据是 `['html>', '<head>', '<body'].some(tag => content.includes(tag))`
  （`util/is_frontend.ts:1-3`）——**三个子串任取其一**，且 `'<body'` 没有右尖括号。
  （文档声称三个全要 + `</body>`，代码比文档松。这条我在别处报过，这里只作引用。）

**所以这不是一个决策的两个分支，是不同层的两套东西**：上游层「消毒后就地渲染」是无条件的，
扩展层「够像一个网页就装进 iframe」是**追加**的。一段 HTML 可以两条都不沾（不在 `<pre>` 里、
也没有文档标记），那它就只是被消毒渲染的内联 HTML——**那 936 楼全部属于这一类。**

**给我们的含义**：我们现在只有 frame 一条路，等于只实现了追加的那一层，
没实现无条件的那一层。补齐的方向是**加一条内联路**，不是**给 frame 路加一个片段模式**。

---

## 四、我们该允许什么：地板、收紧、和收紧的代价

**原则**：**上游是地板**（兼容性下限），**升级侧只往严处走，且每一处收紧都要说出它打到谁。**

### 4.1 允许集

| 类别 | 上游 | 我们 | 理由 |
| --- | --- | --- | --- |
| 结构与文本标签 | DOMPurify 默认 121 个 | **同上，减去下面几行** | 兼容性下限，不自己另发明一张表 |
| `<script>` | 已被默认剥（不在名单里） | **同（并且显式 `FORBID_TAGS`）** | 显式化，不依赖上游名单不变 |
| `<iframe>` `<object>` `<embed>` | 默认剥 `iframe`；**`object`/`embed` 不在默认名单**，靠钩子②按外链拦 | **显式 `FORBID_TAGS` 全拒** | 内嵌浏览上下文只能由 frame 路径按我们的策略建，不能由正文自己开 |
| `<form>` `<input>` `<button>` `<select>` `<textarea>` | **默认允许** | **允许标签，但见 §4.2 的事件与提交约束** | 44 量到语料里一个都没有；砍掉是零收益的不兼容 |
| `on*` 事件属性 | 默认剥（不在 `ALLOWED_ATTR` 里） | **同（并且显式 `FORBID_ATTR: [/^on/i]`）** | **升级侧的硬线：片段不给脚本，脚本只能在 frame 里** |
| `javascript:` / 未知协议 | `ALLOW_UNKNOWN_PROTOCOLS: false` 挡 | **同，且额外白名单协议** | 只留 `http` `https` `mailto`，砍掉 `tel/callto/sms/cid/xmpp/matrix` |
| `data-*` | **全放行**（`ALLOW_DATA_ATTR: true`） | **保持放行** | 语料里有 `data-close`/`data-open` 各 23 次，是暗渊折叠块的状态位；砍掉直接打到现存卡 |
| `class` | 放行 + 名字空间化 | **放行 + 名字空间化（照抄，含 CSS 侧配套）** | 979 次，3 张卡。见 §2.1 的耦合不变式 |
| `style` 行内属性 | **放行，且不解析** | **放行，但过滤含外部 URL 的声明**（`url()` / `image-set()` / `://`） | 236 次，2 张卡。**属性本身不能砍**；能砍的是它里面的外部加载 |
| 外部资源加载（`src`/`href`/`srcset`/CSS `url()`/`@import`/`@font-face`） | **取决于 `forbid_external_media`；这台机器上是放行** | **一律拒，无开关** | 见 §4.3 |

### 4.2 「片段不给脚本」这条的确切边界

不只是剥 `<script>` 和 `on*`。同一个意图下还要挡住：

- `javascript:` URL（默认已挡，但要显式）
- `<form action=...>` 的提交、`<button formaction>`、`<input formaction>`
- `<a target>` —— 上游那个**无门控**的钩子把任何带 `target` 的节点改成
  `target="_blank" rel="noopener"`。**这条我们要抄，而且要抄成无条件的**：
  它同时防了 `target="_top"` 打穿我们自己的框架。
- `<template>` / `<slot>` / `<shadow>` —— 在默认名单里。它们不执行脚本，但会让 §4.4 的
  作用域方案的边界变得难推理。**建议直接 `FORBID_TAGS`**，语料零使用。

### 4.3 「外部资源加载一律拒」比上游严，代价是零

上游把这条做成了一个**用户可关的开关**（`forbid_external_media`），
而且**这台机器上是关着的**（也就是允许外链）。我们要做成**无开关的硬拒**。

比上游严的地方要说清打到谁。44 查了两遍——第一遍漏了 CSS 承载的那半，补查后：

```
标签/属性侧：href 0、src 0、任何 URL 属性  0        （带里根本没有 URL 属性）
CSS 侧：url( ) 0、@import 0、url(http 0、url(data: 0、@font-face 0、image-set( 0
```

**零。所以这条收紧在当前语料上零成本。**

但要按机制而不是按统计来实现——**模型下一次输出不受这个统计约束**。这句是 44 的，
我原样保留，因为它正好是这份文档里最容易被误用的一组数：
**这组零告诉你的是「收紧不会打到现存的任何一张卡」，不是「永远不会打到」。**

顺带：上游对 CSS 承载的外部加载**是漏的**。`@import` 无条件过滤（`chats.js:605`）✓，
但 `@font-face { src: url(https://…) }` 只在 `!mediaAllowed` 时才被 `://` 那条声明过滤器
（`:565`）打掉——**外链允许时它原样通过**。我们没有这个开关，所以不继承这个洞。

### 4.4 `<style>` 的作用域：选哪个

三个候选，我推荐 **`@scope` 为主 + 选择器前缀兜底**，并且**作用域根是单条消息**。

| 方案 | 隔离性 | 我们的主题变量还能进去吗 | 代价 |
| --- | --- | --- | --- |
| **选择器前缀**（上游做法） | 单向：卡的 CSS 出不去；宿主 CSS 仍进得来 | **能** | 要自己解析 CSS 并正确处理嵌套伪类；**粒度取决于前缀选什么**，上游选了容器类所以跨消息漏 |
| **shadow root** | 双向强隔离 | **不能**（要显式把 token 传进去，`::part` / 手动注入） | 隔离过头：卡片继承不到我们的字体与主题，**看起来会像贴了张不属于这个应用的纸**；跨消息选择/复制/查找也变复杂 |
| **`@scope`** | 单向，**粒度可以精确到这一条消息** | **能** | 需要把卡的规则包一层；`@keyframes` 之类不能塞进去（见下） |

**推荐 `@scope`，理由是它是唯一一个「粒度对、继承对、且不需要我们自己改写选择器」的方案。**
写法上就是给每条消息一个稳定标识，然后：

```css
@scope (#msg-<候选序号>) { /* 卡片的规则原样放这里 */ }
```

**这比上游好的地方，正好是 §2.2 那个缺口**：上游的 `.mes_text ` 前缀是容器类级的，
`@scope` 到具体那一条消息，**暗渊的 23 楼样式就再也碰不到别的消息了**。
——注意标识用**候选序号（candidateSeq）**，不是楼层号：楼层号在插入/删除时会移位，
样式会跟着漂到别的消息上。（这条和 `FLOOR-VARIABLES.md` 的身份寻址是同一个理由。）
**这不是假想的**：上游删楼走的是 `context.chat.splice(msgInfo.index, 1)`——
**一次删除之后所有后续楼号全部错位**（44 在量 chat 写入时看到的）。
按楼号挂样式，等于让暗渊的 CSS 在用户删掉一楼之后落到别人身上。

**`@scope` 挡不住的三个全局命名空间**，任何方案都挡不住，必须单独处理：

1. **`@keyframes` 名字是全局的。**两张卡都定义 `@keyframes pulse` 会互相覆盖。
   而且 `@keyframes` **不能**放进 `@scope` 里，得提到外面 → 必须**重命名**（加消息前缀）
   并同步改写引用它的 `animation` / `animation-name` 声明。
   *上游这里是意外做对了一半*：`sanitizeRuleSet`（`chats.js:600-610`）只递归 `.rules`，
   而 `css` 包给 `@keyframes` 的是 `.keyframes` 不是 `.rules`，**所以停点没被加前缀**
   （加了就坏了）——但**名字也没被改**，所以上游是有这个碰撞的。
2. **CSS 自定义属性（`--foo`）会沿继承链往下走**，卡片可以覆盖我们的 token。
   建议：在作用域根上不允许卡片重定义我们保留前缀（如 `--iris-*`）的变量。
3. **`font-family` 别名**同理是全局的。§4.3 已经把 `@font-face` 全拒了，这条随之消失。

**兜底方案**（`@scope` 不可用时）用选择器前缀，但**前缀必须是消息级选择器**，不是容器类。

---

## 五、和 44 的语料普查对拍

44 的数（渲染后，936 楼片段带，命定之诗 887 / 银麒赎世 24 / 暗渊 23 / 希尔 2，全带零用户行）：

```
标签（12 种）  summary 1595  details 917  li 453  span 448  p 381  div 175
              ul 175  b 117  style 24  small 23  hr 6  h4 6
属性（4 个名） class 979(3卡)   style 236(2卡)   data-close 23(1卡)   data-open 23(1卡)
              href / src / id / 任何 on* —— 零
<script>      带里 0 次 / 0 卡      对照 frame 里 211 次 / 14 卡
<style> 块    24 楼 / 2 卡（暗渊 23、银麒 1）
```

**逐条对拍：**

| 44 的观测 | 上游地板怎么说 | 我们的收紧打到它了吗 |
| --- | --- | --- |
| 12 个标签 | **12 个全在 DOMPurify 默认 `ALLOWED_TAGS` 里**（[DP] `:257`） | **没有。**§4.1 砍的是 script/iframe/object/embed/template/slot，与这 12 个不相交 |
| `class` 979 次 | 默认允许，钩子改写成 `custom-*` | 没有（我们照抄改写） |
| `style` 236 次 | 默认 `ALLOWED_ATTR` 含 `style`，**且不解析内容** | **属性保留，内容里的外部加载被拒**；44 量到 CSS 侧外链为零，所以实际零打击 |
| `data-close` / `data-open` | `ALLOW_DATA_ATTR: true`（[DP] `:499`）默认全放 | 没有（保持放行） |
| `<script>` 带里 0 / frame 里 211 | 默认名单不含 `script`——**上游同样不给正文脚本** | **零成本**，而且这条不是我们的发明：上游正文本来就没有脚本 |
| 零 URL 属性、零 CSS 外链 | 上游按开关拦，这台机器开关是开的（允许） | **零成本**，且我们比上游严（无开关） |
| 4 个裸元素选择器会漏出 | 上游加 `.mes_text ` 前缀——**挡住宿主 UI，挡不住跨消息**（§2.2） | `@scope` 到消息级后**两个方向都挡住**，这是升级项 |

**「零 script」这条的对比很干净，值得单独记一句**：正文片段从来没有脚本，
而**脚本恰好正是 frame 路径存在的理由**。这不是巧合，是分工——
我们把「片段不给脚本」写进规格，是在**把一个已经成立的事实变成一条保证**。

---

## 六、给 a8 的落地清单

1. **加一条内联渲染路**，不是给 frame 路加片段模式（§三）。
   **这条是用户可见 bug 的修法**：爱衣 6/8 楼 + 命定之诗 887 楼都落在它上面（§〇）。
   其余各条都是它的约束条件，不是独立工作项。
2. **Markdown 后接消毒器**，不是在 Markdown 里放开原始 HTML——顺序是
   `正则 → Markdown → 消毒 → 作用域化`，和上游一致（§一）。
3. **消毒器配置显式化**：`FORBID_TAGS` / `FORBID_ATTR` 写出来，不依赖上游默认名单不变（§4.1）。
   上游只写 `ADD_TAGS` 是因为它信任默认；**我们收紧，所以要把收紧写在纸上**。
4. **`<style>` 在解析后的 DOM 上处理**，不用正则找它（§2.3 是上游被这个坑到的实例）。
5. **`@scope` 到候选序号，`@keyframes` 提出来并重命名**（§4.4）。
6. **class 的 HTML 侧改写和 CSS 侧改写做成一条不变式 + 一个断言**，不是两处巧合（§2.1）。
7. **「卡片样式作用于全页」如果将来要做**，照上游的形状：挪出消息流、每卡、默认关、
   显式同意（§2.4）。

8. **导入的聊天文件里，消息自带的消毒豁免旗标一律不认。**

   上游用 `message.extra.uses_system_ui` 放宽消毒（豁免 class 名字空间化，
   让消息能用宿主真按钮样式）。上游侧它只由 `system-messages.js` 设，安全——
   **但它落在 `extra` 里，也就是写进 chat JSONL，而 JSONL 是我们从外部导入的。**

   上游那条「只有宿主设得了」的保证**依赖于文件没被别人写过**；
   导入路径上这个前提不成立：一个手工编辑过的、或从别处拿来的聊天文件，
   可以给任意一条 AI 消息挂上这个旗标。

   **语料现状**：`data/default-user/chats/` 下 `uses_system_ui` **0 个文件 0 次出现**
   （我量的，2026-09-02）。**所以不认它是零成本的。**

   做法：**豁免只能由宿主在运行时授予，永远不从消息数据里读。**
   这不只针对这一个旗标——**「消毒策略的输入不能来自被消毒的那份数据」**是条通则。

---

## 七、未查 / 需要别人补的

1. ~~**渲染后 `<style>` 的开标签确切形状**（有没有属性）~~
   **已结**（44，2026-09-02）：235 个全裸，**上游此刻没在漏这一关**。见 §2.3.1。
   结论不变——当初就写了「无论踩没踩到，我们都在 DOM 上处理」，这条读数只改了理由的强弱，没改做法。
2. ~~**爱衣那条完整文档为什么被 frame 路径漏接**~~
   **已结**（7b 逐楼跑真管线，2026-09-02）：**这个问题的前提就不成立**——
   用户屏幕上那份爱衣的 6/8 楼是片段不是完整文档，开场白楼有围栏、框得住。见 §〇。
   语料里那个 1 楼的完整文档文件是**另一个对象**，它没有出现在用户屏幕上，因此不构成待办。
3. **`@scope` 在我们目标浏览器上的可用性**我没测。兜底方案已写（§4.4）。
4. **`<form>`/`<input>` 保留后的提交行为**我只列了要挡的面，**没有查我们现在的框架里
   一个 `<form>` 提交会发生什么**——那是 a8 的域，我不进去。
5. ~~**`sanitizerOverrides`（`script.js:1753` 第 6 形参）有哪些调用点传了非空值**~~
   **已结**（我，2026-09-02）：**穷举了 14 个调用点，恰好 1 个传非空值。**

   ```
   13 个传 {}         script.js:1978 2611 3656 8162 8172 8260 8351
                      power-user.js:1523  reasoning.js:555
                      streaming-display.js:265 281
                      regex/index.js:1253（省略第 6 参，默认 {}）
    1 个传非空        script.js:2469
   ```

   那唯一一处是 `script.js:2467`：

   ```js
   // if mes.extra.uses_system_ui is true, set an override on the sanitizer options
   const sanitizerOverrides = message.extra?.uses_system_ui ? { MESSAGE_ALLOW_SYSTEM_UI: true } : {};
   ```

   作用是让钩子（`chats.js:1917`）**豁免 `menu_button` 类的 class 名字空间化**，
   使那条消息能用 ST 真正的按钮样式。**`uses_system_ui: true` 只在
   `public/scripts/system-messages.js:69, 84, 92` 被设**——**宿主自己的系统消息，卡片和模型输出都设不了。**

   **所以 §一「上游地板」对一切卡片/模型内容成立，例外只是宿主自撰的系统消息。**

   **但发现了一个新的面，见 §六 第 8 条**：这个旗标存在 `message.extra` 里，
   也就是**存进 chat JSONL**——而我们要导入 ST 的聊天文件。

---

## 附：这份文档的数字里，哪些是我量的、哪些是转述

**我量的**：所有 `[上游]` 与 `[DP]` 行号和配置；`.mes_text` 是每条消息的类；
`encodeStyleTags` 正则不容属性因而可被绕过；`<style type="text/tailwindcss">` 在 3 个世界书里 4 次
（渲染前口径）；消息路径无 `FORBID_*`/`ALLOWED_*` 定制。

**44 量的、我转述**：§五整节的语料数字；§2.3.1 那 235 个开标签；
§4.4 的 `context.chat.splice(msgInfo.index, 1)`；§〇 第二版里语料那份爱衣的双渲染对照。

**7b 量的、我转述**：§〇 第三版整段——用户屏幕上那个 9 楼聊天的逐楼判据。
**这份读数推翻了我自己写的 §〇 第二版**，链条按更正惯例保留在原处。
**他自己标注了两处他的错**（`style` 计数 213 是低报、应取 236；第一版漏出选择器报 0 是因为
过滤名单没写 `details`、真值 4），我原样保留这两处标注——
**因为下一个人复算时，会需要知道哪个数被修过。**

**我没有独立复核 44 的任何一个数。**两条路径没有分叉，所以这不是交叉验证。
