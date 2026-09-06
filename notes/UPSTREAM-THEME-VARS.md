# 上游语义：主题 CSS 变量，以及卡的前端能不能看见它们

**坐标**：SillyTavern **1.18.0**（`E:/sillyTavern/SillyTavern/package.json` `"version": "1.18.0"`）；
TavernHelper（JS-Slash-Runner）**4.9.1**（`data/default-user/extensions/JS-Slash-Runner/manifest.json:12`、
`package.json:3`）。§一–§五 与 §六–§八 读的是同一份拷贝，全部静态读，未启动 ST，未开浏览器。
本文件 2026-09-06 落库，仓库 HEAD `61dae19`（分支 `dev/post-merge-followups`）。

**给「卡自带前端如何与外壳主题协调」当上游对照。只给事实与位置，不裁。**

## 口径

- **正读**：SillyTavern `1.18.0`（`E:/sillyTavern/SillyTavern`）与已装
  TavernHelper `4.9.1`（`data/default-user/extensions/JS-Slash-Runner`，`src/` 完整）。
  行号是这两份拷贝上的行号（`style.css` 那份：`public/style.css`）。
- 只读，没有启动 ST，没有打开面板，`secrets.json` 未读。**静态读，无运行确认。**
- 三节分别答任务的 ①②③；第四节把三者合起来的**事实**说一句，**不含建议**。

---

## 一、ST 页面 `:root` 上的主题变量

全部定义在 **`public/style.css:20-132`** 的单个 `:root` 块里。分四类，只有第二类是
「主题」意义上的可变量。

### 1. 静态调色板与常量（**不由设置驱动，永不随主题变**）

`:25-60` 一段：`--black30a/50a/60a/70a/90a/100`、`--white20a/30a/50a/60a/70a/100`、
`--grey10/30/50/70/75`、`--grey5020a` `--grey5050a` `--grey30a` `--grey7070a`、
`--fullred` `--crimson70a` `--crimson-hover` `--okGreen70a` `--cobalt30a`
`--greyCAIbg` `--ivory` `--golden` `--warning` `--active` `--preferred`、
`--transparent`、`--doc-height`（`:22`）、
`--interactable-outline-color` / `-faint`。

**这些是写死的字面值**，主题切换不碰它们。

### 2. `--SmartTheme*` —— 由 `power_user` 驱动的那一组

`style.css` 里的注释就写着 `/*Default Theme, will be changed by ToolCool Color Picker*/`
（`:70`）。逐条：

| 变量 | `style.css` 行 | 出厂默认 | 驱动的 `power_user` 键 | 写入处 |
| --- | --- | --- | --- | --- |
| `--SmartThemeBodyColor` | **71** | `rgb(220, 220, 210)` | `main_text_color` | `power-user.js:1106` |
| `--SmartThemeEmColor` | **72** | `rgb(145, 145, 145)` | `italics_text_color` | `:1114` |
| `--SmartThemeUnderlineColor` | **73** | `rgb(188, 231, 207)` | `underline_text_color` | `:1117` |
| `--SmartThemeQuoteColor` | **74** | `rgb(225, 138, 36)` | `quote_text_color` | `:1120` |
| `--SmartThemeFastUIBGColor` | **75（注释掉）** | 无 `:root` 默认 | `fastui_bg_color` | `:1123`（在一个条件里） |
| `--SmartThemeBlurTintColor` | **76** | `rgba(23, 23, 23, 1)` | `blur_tint_color` | `:1127` |
| `--SmartThemeChatTintColor` | **77** | `rgba(23, 23, 23, 1)` | `chat_tint_color` | `:1131` |
| `--SmartThemeUserMesBlurTintColor` | **78** | `rgba(0, 0, 0, 0.3)` | `user_mes_blur_tint_color` | `:1134` |
| `--SmartThemeBotMesBlurTintColor` | **79** | `rgba(60, 60, 60, 0.3)` | `bot_mes_blur_tint_color` | `:1137` |
| `--SmartThemeBlurStrength` | **80** | `calc(var(--blurStrength) * 1px)` | 间接：`blur_strength` → `--blurStrength` | `:1161` |
| `--SmartThemeShadowColor` | **81** | `rgba(0, 0, 0, 0.5)` | `shadow_color` | `:1140` |
| `--SmartThemeBorderColor` | **82** | `rgba(0, 0, 0, 0.5)` | `border_color` | `:1143` |
| `--SmartThemeCheckboxBgColorR/G/B` | **83/84/85** | `220 / 220 / 210` | 从 `main_text_color` 拆出的 RGB | `:1108-1110`（另有 `…ColorA`，`:1111`，**`:root` 里没有它的默认**） |
| `--SmartThemeCheckboxTickColorValue` | **86** | 由上三个算出的亮度反转式 | — | 纯 CSS `calc`，无 JS |
| `--SmartThemeCheckboxTickColor` | **87-89** | `rgb(var(…TickColorValue) ×3)` | — | 同上 |

**写入函数是 `applyThemeColor(type)`（`power-user.js:1104-1145`）**，
一个 `switch`-式的分支表，每支 `document.documentElement.style.setProperty(...)`。

> **⚠ 出厂默认的真正来源是 `style.css`，不是 JS。**`power_user` 的这十个颜色键的默认值
> 是**从 CSS 读回来的**：
> ```js
> // [ST] power-user.js:159-168
> main_text_color: `${getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').trim()}`,
> // …italics/underline/quote/blurTint/chatTint/userMesBlurTint/botMesBlurTint/shadow/border 同款
> ```
> 所以 `:root` 是唯一真值源，`power_user` 是它的镜像；两者不会不一致，
> 因为后者在启动时照抄前者。

### 3. 排版与几何 —— 也由设置驱动，但不叫 SmartTheme

| 变量 | 行 | 出厂默认 | `power_user` 键 | 写入处 |
| --- | --- | --- | --- | --- |
| `--sheldWidth` | **92** | `50vw` | `chat_width`（默认 `50`，`:144`） | `applyChatWidth` `power-user.js:1084-1102`（`:1087`、`:1096`） |
| `--fontScale` | **95** | `1` | `font_scale`（默认 `1`，`:155`） | `applyFontScale` `:1172-1182`（`:1175`、`:1179`） |
| `--mainFontSize` | **96** | `calc(var(--fontScale) * 15px)` | 间接，随 `--fontScale` | 纯 CSS |
| `--mainFontFamily` | **97** | `"Noto Sans", sans-serif` | **无**——写死，无设置项 | — |
| `--monoFontFamily` | **98** | `'Noto Sans Mono', 'Courier New', Consolas, monospace` | **无** | — |
| `--blurStrength` | **101** | `10` | `blur_strength`（默认 `10`，`:156`） | `applyBlurStrength` `:1160-1164` |
| `--shadowWidth` | **104** | `2` | `shadow_width`（默认 `2`，`:157`） | `applyShadowWidth` `:1166-1170` |

**两个字体族没有设置项**：`--mainFontFamily` / `--monoFontFamily` 是 `:root` 里的字面值，
主题切换与设置面板都不改它们。

### 4. 由上面算出来的派生量（无独立设置）

`--bottomFormBlockPadding` `--bottomFormIconSize` `--bottomFormBlockSize`（`:107-109`，
均由 `--mainFontSize` 算出）、`--topBarIconSize` `--topBarBlockSize`
`--topBarBlockPadding`（`:112-114`）、`--mes-right-spacing`（`:120`）、
`--avatar-base-height/width/border-radius/-round/-rounded`
`--inline-avatar-small-factor`（`:122-127`）、
`--animation-duration` 与 `-2x/-3x/-slow`（`:129-132`）、
`--reasoning-body-color` / `--reasoning-em-color` / `--reasoning-saturation`（`:65-67`，
前两者由 `--SmartThemeEmColor` / `--SmartThemeBlurTintColor` 算出）。

### 5. 主题作为一个整体：`applyTheme(name)`

`power-user.js:1227-1260+`。它拿 `themes` 里的一条，按一张
`themeProperties` 表逐项应用——**十个颜色键各带 `selector`（颜色选择器 DOM id）与
`type`（传给 `applyThemeColor` 的分支名）**，随后是 `blur_strength`、`shadow_width`
之类带 `action` 的项，以及 **`custom_css`**（`:1252`）。
`power_user.theme` 的默认值是 `'Default (Dark) 1.7.1'`（`:177`）。

**`custom_css`**（`power_user.custom_css`，默认 `''`，`:170`）由
`applyCustomCSS()`（`:1147-1158`）实现：往 **ST 页面的 `<head>`** 插一个
`id="custom-style"` 的 `<style>`，内容就是用户那段 CSS。
*（`:2459` 另有一处 `parsed.custom_css.includes('@import')` 的检查，我没有展开它的用途。）*

### 6. ⚠ 没有 class 形式的主题开关

**ST 不用 class 或属性表达主题**：`public/style.css` 里
**没有 `body.dark` / `.dark` 这类规则**（grep 零命中），
`power-user.js` / `script.js` / `index.html` 里**没有 `data-theme`、
没有 `classList.add('dark')` 之类**（grep 零命中）。
`index.html:51` 的 `<body class="no-blur">` 是唯一的 body class，
而它是**模糊效果**的开关，不是明暗主题。

> **所以「主题」在上游 = `:root` 上一组 CSS 变量的当前值。**没有可供选择器命中的
> 明暗标记，**连在 ST 自己的页面里都没有**。

---

## 二、TavernHelper 4.9.1 的两种帧：注入了什么，主题**没有**同步进去

### 界面/消息帧（`src/panel/render/iframe.ts` `createSrcContent`，`:78-103`）

生成的文档头是：`<meta charset>`、`<meta viewport>`、
可选 `<base href>`（仅 blob 模式）、**一个 `<style>`**、
`third_party_message.html`、四个 `<script>`。那个 `<style>` 的原文是：

```css
*,*::before,*::after{box-sizing:border-box;}
html,body{margin:0!important;padding:0;overflow:hidden!important;max-width:100%!important;}
.user_avatar,.user-avatar{background-image:url('${getUserAvatarPath()}')}
.char_avatar,.char-avatar{background-image:url('${getCharAvatarPath()}')}
```

**四条规则，全部与主题无关**：一条盒模型、一条边距/溢出重置、两条把头像图片
灌进两个 class（`.user_avatar`/`.user-avatar` 与 `.char_avatar`/`.char-avatar`，
每对两种写法）。**没有一条颜色、字体或阴影。**

### 脚本帧（`src/panel/script/iframe.ts` `createSrcContent`，`:5-22`）

**它一个 `<style>` 都不注入**（`grep -c "<style>"` = **0**）。头里只有
可选 `<base>`、`third_party_script.html`（**两个远程 `<script>`：Vue 与 vue-router，
没有任何 `<link>`**）、`parent_jquery.js`、`predefine.js`、可选
`cleanup_protector.js`、以及一个远程 `log.js`；卡的正文在 `<body>` 的
`<script type="module">` 里。

### 主题同步：**零**

三条判据，都是零命中：

1. **没有把父页 `:root` 变量复制进帧。**`getComputedStyle` 在 TH 源码里只有四处，
   **全在面板侧（ST 页面）**：`panel/component/Dialog.vue:267`、
   `panel/toolbox/variable_manager_deprecated/Card.vue:441`、
   `panel/toolbox/variable_manager_deprecated/TextMode.vue:147`、`util/color.ts:75`。
   **`src/iframe/` 下一处也没有。**
2. **`--SmartTheme*` / `--mainFontSize` 在帧侧零引用。**全仓这些名字的命中**全部**在
   `src/global.css` 与 `src/panel/**`（面板自己要跟 ST 主题走），
   **`src/iframe/**` 与两个帧模板里一次都没有出现。**
3. **帧里没有指向 ST 自己 CSS 的 `<link>`。**两个帧模板加两个 third_party 片段里
   总共只有**两个 `<link rel="stylesheet">`，都是 jsDelivr 的远程包**
   （FontAwesome `all.min.css`、jQuery-UI `theme.min.css`，见
   `src/iframe/third_party_message.html:1`、`:5`），**且都只在消息帧**——
   脚本帧的 `third_party_script.html` 里没有 `<link>`。

**同步时机因此不存在**：既不是「一次」也不是「主题变化时」——**从来没有过**。

### TH 自造的 CSS 变量：全表**两个**，进帧的只有一个

| 变量 | 设在哪 | 什么时候 | 值 |
| --- | --- | --- | --- |
| **`--TH-viewport-height`** | **帧内** `<html>` 上 | `adjust_viewport.js:1` 加载时一次，`:3-5` 再在收到 `TH_UPDATE_VIEWPORT_HEIGHT` 消息时重设 | `` `${window.parent.innerHeight}px` `` |
| `--TH-log--gap` | 面板侧 | — | `panel/toolbox/Logger.vue:51-52`，`calc(var(--mainFontSize) * 0.5)`；**与卡无关** |

`--TH-viewport-height` 的读取方在 `panel/render/iframe.ts:24`
（`const VARIABLE_EXPRESSION = \`var(--TH-viewport-height)\``，用于把卡里的 `vh` 改写成它）。
**它是几何，不是主题。**

---

## 三、卡的 CSS 能不能选到 ST 页面的类名

**不能，而且不是因为 CSS 隔离——是因为帧里没有那些节点，也没有那些 class。**

- **两个帧模板发出的都是裸 `<html>` 与裸 `<body>`**，**不带任何 class 或属性**
  （`render/iframe.ts:82` 的 `<html>`、`script/iframe.ts:7` 的 `<html>`）。
- **`src/iframe/` 下没有任何 `classList` / `className` / `addClass`**（grep 零命中），
  所以父页的 class 一个也没有被复制进来。`predefine.js` 复制的是 **JS 全局**
  （六个名字 + TavernHelper 成员 + `SillyTavern` getter），**不是 DOM 或 class**。
- 卡的 CSS 里写 `.mes_text { … }` 在帧里**能解析、也能匹配**——但只会匹配
  **帧自己文档里**恰好带这个 class 的元素。上游给帧的唯一"外来" class 是那两对头像
  class（`.user_avatar` / `.char_avatar`，见 §二），而它们是 TH **在帧内自己造的**，
  不是从父页继承的。
- **`body.dark` 之类更不可能**：§一之六已经证了 ST 页面自己就没有明暗 class。

---

## 三之二、⚠ 但只有**一部分**卡界面在帧里——另一部分直接落在 ST 页面 DOM 上

**本节是对 §四 初版的更正。**初版写「在上游卡自带前端与宿主主题本来就是不协调的」，
那句话**只对被换成 iframe 的那一半成立**。总指挥点出的这一格是对的：
没被换掉的内联 HTML 在 ST 页面 DOM 里，`var(--SmartTheme*)` **确实解析得到**。

### TH 把什么换成 iframe：**两个条件，缺一不可**

```ts
// [TH] src/tauritavern_chat_surface.ts:69-76
for (const pre of content.querySelectorAll<HTMLPreElement>('pre')) {
  if (!isFrontend(pre.textContent ?? '')) { continue; }
  runtimeContainer(pre);
  claims.claim(pre, context => mountRuntime(context, render_settings.use_blob_url));
}
```

```ts
// [TH] src/util/is_frontend.ts:1-3
export function isFrontend(content: string): boolean {
  return ['html>', '<head>', '<body'].some(tag => content.includes(tag));
}
```

1. **必须是一个 `<pre>` 元素**——也就是 ST 的 markdown 渲染器为**围栏代码块**产出的那个盒子。
   不在围栏里的 HTML **根本不进候选集**（没有 `<pre>`）。
2. **它的文本必须含 `html>` / `<head>` / `<body` 三者之一。**
   一个只有 `<div>`/`<details>` 的围栏片段**不满足**，于是**留在原地当代码块**，不变 iframe。

**三条附带事实：**

- **`isFrontendElement`（`:5-8`）多认一种**：带 `TH-render` class 的元素（那是 TH 自己
  换过之后的容器），或 `<pre>` 且文本过 `isFrontend`。
- **全部渲染路径共用这一个谓词**：`displayed_message.ts:78`、
  `panel/render/optimize_hljs.ts:7`、`Streaming.vue:65`、
  `StreamingNestedIframe.vue:32`、`StreamingOne.vue:44-46`、
  `use_collapse_code_block.ts` —— 没有第二套判据。
- **另有一道楼层深度闸**：`isEligibleMessage(mesid, depth, ignore_hidden)`
  （`tauritavern_chat_surface.ts:77-98`），`depth` 默认 **0 = 不限**
  （`src/type/settings.ts:70`，注释说明它可能被存成 `""` 所以加了 `.catch(0)`）；
  `depth_ignore_hidden` 默认 `false`（`:71`）。`render.enabled` 默认 `true`（`:63`）。

### 没被换掉的那一半：**进 ST 页面 DOM，而且 ST 为它专门做了两层改写**

路径是 `messageFormatting`（`[ST] public/script.js`，DOMPurify 段在 `:1898-1911`）：

```js
const config = { RETURN_DOM: false, RETURN_DOM_FRAGMENT: false, RETURN_TRUSTED_TYPE: false,
                 MESSAGE_SANITIZE: true, ADD_TAGS: ['custom-style'], ...sanitizerOverrides };
mes = encodeStyleTags(mes);
mes = DOMPurify.sanitize(mes, config);
mes = decodeStyleTags(mes, { prefix: '.mes_text ' });
```

**`<style>` 不但没被清掉，还被特殊照顾**：`encodeStyleTags`
（`[ST] public/scripts/chats.js:536-541`）先把 `<style>…</style>` 换成
`<custom-style>` + `encodeURIComponent(内容)`（**避开 DOMPurify**），
`decodeStyleTags`（`:551-…`）再解回来，并做两件事：

- **每个选择器前加 `.mes_text `**（`prefix` 默认值就是它，`sanitizeRule`）；
- **每个 class 名改写成 `.custom-<名>`**（`sanitizeSimpleSelector`，
  已是 `custom-` 前缀的不再动）。

而 HTML 一侧有配对的改写：DOMPurify 的 `uponSanitizeAttribute` 钩子
（`[ST] chats.js:1910-1935`）把 `class` 属性的每个值改写成 `custom-<值>`，
**例外只有三种**：`fa-*`、`note-*`、以及 `monospace`。
（`MESSAGE_ALLOW_SYSTEM_UI` 且节点带 `menu_button` 且是 BUTTON/DIV 时整条跳过。）

*（两个函数的版权注释都写着 `@copyright https://github.com/kwaroran/risuAI`。）*

### 所以对「读 `--SmartTheme*` 的卡在上游生不生效」，答案是分叉的

| 卡界面的形态 | 在哪 | `var(--SmartTheme*)` | 能否用选择器命中 ST 的类 |
| --- | --- | --- | --- |
| 围栏 + 含 `html>`/`<head>`/`<body` | **TH 的 iframe** | **解析不到**（帧里没有那些变量，§二） | 不能（帧里没有那些节点，§三） |
| 围栏但不含那三个标签 | 留在页面里的代码块 | 文本不当 CSS 用，不适用 | — |
| **不在围栏里的内联 HTML** | **ST 页面 DOM，`.mes_text` 里** | **解析得到**——它就在页面里，继承 `:root` | **不能**：它自己选择器里的 class 名会被改写成 `.custom-*`，所以写 `.mes_text{}` 会变成 `.mes_text .custom-mes_text{}`，命中不了 |

> **最锐的一条:变量能用,类选择器不能用,而这两件事出自同一个函数。**
> `decodeStyleTags` 只改**选择器**里的 class 名；**声明**除了「外部媒体未允许时滤掉含
> `://` 的声明」（`sanitizeRule`）之外**不动**。所以
> `background: var(--SmartThemeBlurTintColor)` 原样保留、并且真的解析。
> 反过来，卡也**不能重定义**变量：它写 `:root{--x:…}` 会被前缀成
> `.mes_text :root{…}`，匹配不到任何元素。**只读不写。**

## 四、四节合起来的事实（不含建议）

1. **上游的主题是 `:root` 上一组变量的值**，没有 class/属性形式的开关，
   所以"读主题"只有一条路：读那些变量。
2. **上游从不把它们送进卡的帧。**卡帧拿到的与主题有关的东西是**零**；
   拿到的与外观有关的东西只有：盒模型重置、边距/溢出重置、两对头像图片、
   以及（仅消息帧）两个远程 CSS 包。
3. **所以「卡与宿主主题协调不协调」在上游是按形态分叉的**（§三之二，
   这一条是初版的更正）：
   - **被换成 iframe 的那一族**（围栏 + 完整 HTML 文档标签）：**不协调，且无机制**。
     V1.5.4 那份 srcdoc 写死 `background:#0e1028; color:#e8e2d6; font-family:sans-serif`
     （`OVERLAY-CARDS.md` §六之四）与 ST 主题毫无关系。
   - **内联 HTML 那一族**：**协调是可能的,而且上游确实支持**——
     它在 `.mes_text` 里,`var(--SmartTheme*)` 解析得到,写 `color: var(--SmartThemeBodyColor)`
     的卡在上游**真的会跟着主题走**。
   **所以「读 --SmartTheme 的卡有没有真消费者」这个问题的答案是:有,就在内联 HTML 那一族里。**
4. 唯一被送进帧的 TH 变量是 `--TH-viewport-height`，**它是视口高度**，
   而且它的存在恰好说明：**当 TH 需要让帧知道父页的某个量时，
   它用的办法是"在帧内定义一个自己的变量并在事件上更新"**——
   这是上游对这一类问题唯一的既有先例。

## 五、未查 / 限定

1. **`themes` 出厂主题文件的内容没有读**（`data/<user>/themes/`）——
   本文件只读了 `applyTheme` 的机制与 `themeProperties` 表的形状，
   没有列举任何一套具体主题的取值。
2. **`movingUI` 与 `applyStylePins`（`power-user.js:1443`、`:1497`）没有展开**。
3. **`--SmartThemeFastUIBGColor` 与 `--SmartThemeCheckboxBgColorA` 在 `:root` 里
   没有默认值**（前者被注释掉、后者根本没有），它们只在 JS 写入后才存在。
   **未查**：读它们而未被写入时会拿到空值，这对消费者意味着什么没有展开。
4. **`custom_css` 的 `@import` 检查（`power-user.js:2459`）用途未查。**
5. **界面帧的 `<style>` 里 `getUserAvatarPath()` / `getCharAvatarPath()` 返回什么形状
   没有读**（是否为同源相对路径）。
6. **全部静态读**。能廉价证伪 §二/§三 的观测：在**我们自己的实例**上开一张卡的帧，
   于帧内求 `getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor')`
   与 `document.body.className`，看是否为空。**不在用户的 ST 上做。**

---

## 六、ST 有没有设 `color-scheme`——有，一处，而且设的是 `only light`

### 测量

口径：在 ST `public/` 下对 `*.css` `*.js` `*.html` 全文 `grep -rn 'color-scheme'`，
排除 `public/lib/`（第三方库）；TH 对 `src/`（184 个文件，排除 `node_modules/`）、
`dist/`、`lib/` 分别 grep。每个零都带阳性对照。

| 位置 | `color-scheme` 命中 | 内容 |
| --- | --- | --- |
| `[ST] public/style.css` | **1**（`grep -c` = 1） | **`:167`**，在 `body { … }` 规则里：`color-scheme: only light;` |
| `[ST] public/scripts/power-user.js` | **0** | `applyThemeColor`（`:1104-1145`）与 `applyTheme` 都不碰它 |
| `[ST] public/index.html` | **0** | `<html>` 裸标签（`:2`），`<body class="no-blur">`（`:51`）；只有 `<meta name="theme-color" content="#333">`（`:13`），它是浏览器地址栏着色，不是 `color-scheme` |
| `[ST] public/**` 其余（排除 `lib/`） | **0** | 全 `public/` 唯一命中就是 `style.css:167` |
| `[TH] src/**`（含两个帧模板与 `src/iframe/*.html`） | **0** | 阳性对照：同一棵树 grep `box-sizing` 命中 `src/panel/render/iframe.ts:88`，卡尺没坏 |
| `[TH] dist/index.css`（面板样式，由 `manifest.json:7` 装进 **ST 页面**，不进帧） | 1 | Tailwind 工具类 `.scheme-dark{color-scheme:dark}` `.scheme-light{…}` `.scheme-only-light{…}` 等六条；**只有元素带这些 class 才生效**，TH 面板自己有没有用它们未查 |
| `[TH] lib/tailwindcss.min.js`（**消息帧**经 `third_party_message.html:2` 加载的 Tailwind 运行时） | 1 | 同一组 `scheme-*` 工具类的**定义**，以及 `dark:` 变体 = `@media (prefers-color-scheme: dark)`；同样要卡自己写 class 才有效 |
| 语料 29 张去重卡（§八口径） | **0 / 0** | 没有一张写 `scheme-*` class，没有一张用 Tailwind `dark:` 变体；阳性对照：Tailwind 颜色类（`bg-*-500` 之类）在 1 张卡（`创世回廊1.3`，8 处）出现，正则能读到 Tailwind |

**`body` 那条规则的原文（`style.css:150-168`）**：

```css
body {
    …
    background-color: var(--SmartThemeBlurTintColor);   /* :159 */
    font-family: var(--mainFontFamily);                 /* :163 */
    font-size: var(--mainFontSize);                     /* :164 */
    color: var(--SmartThemeBodyColor);                  /* :165 */
    overflow: hidden;
    color-scheme: only light;                           /* :167 */
}
```

**一个值得单独写下的事实**：ST 出厂主题是**深底**（`--SmartThemeBlurTintColor: rgba(23,23,23,1)`
铺 `body` 背景，正文 `rgb(220,220,210)`），而它对浏览器**声明的却是 `only light`**——
即「本页只按浅色方案渲染，且 `only` 禁止 UA 自动深色化」。表单控件、滚动条、系统颜色关键字
在 ST 里因此始终是浅色方案的，与主题是深是浅无关。

### 推论（按 CSS Color Adjust Level 1 规范推，**未在浏览器验证**）

规范原句：*"In embedded documents (such as an `iframe` …), the embedding element's element color
scheme is used as the embedded document's preferred color scheme … rather than the user's preference."*
（§2.1）；`normal` 的定义：*"The element color scheme is the same as the page color scheme."*（§2.2）。
`color-scheme` 是继承属性。

- **上游帧**：`.mes_text` 里的 `<iframe>` 从 `body` 继承 `only light`；帧文档自己一条 `color-scheme`
  都没有（上表），根元素取初始值 `normal`，于是帧文档的首选方案 = 嵌入元素的方案 = **light**。
  **深色主题下也是 light。**消息帧与脚本帧同样。
- **Iris 消息帧**：`apps/iris-web/src/app/reading.css:566`（在 `.iris-interfaces__slot iframe { … }`
  规则里，规则起于 `:532`）对**帧元素**钉 `color-scheme: normal`。按 §2.2，`normal` = **本页的 page
  color scheme**，而 Iris 的根元素在三套主题里都显式声明了它（`src/theme/tokens.css:252` light、
  `:296` dark、`:350` parchment 为 light）。所以这个 `normal` **不是"永远浅色"，而是"跟主题"**——
  与什么都不写（继承）在现有三套主题下结果相同；两者只在某个中间祖先另设 `color-scheme` 时才分开。
- **Iris 覆盖层帧**：帧元素由 `src/sandbox/runner.ts:303` 创建，挂到 `iris-overlay-surface`
  （`src/app/useCardScripts.tsx:811/822`）下；CSS 里针对 `iframe` 的规则只有 `reading.css:532` 与 `:586`
  两条，都在 `.iris-interfaces__slot` 下，覆盖层帧**没有任何宿主侧 `color-scheme` 规则**，
  继承根的主题方案。帧文档内 `src/sandbox/srcdoc.ts:409/412` 写 `html,body{color-scheme:inherit}`：
  根元素上的 `inherit` 取初始值 `normal`，等价于不写。
- **所以两种 Iris 帧目前都是"跟主题"，上游是"永远 light（且 `only`）"。哪一种都不是上游的样子；**
  但两种 Iris 帧彼此在现有主题下并无差别，"消息帧钉死 / 覆盖层帧继承"这个对立在计算值上不存在。

### 限定

- 以上帧内行为是**规范推导**；本轮禁止开浏览器，没有在帧内读过
  `getComputedStyle(document.documentElement).colorScheme`。廉价证伪法：在**我们自己的实例**上，
  于帧内求该值，并在 ST 深色主题的 TH 帧内求一次作对照。
- 消息帧远程加载的 jQuery-UI `theme.min.css`（`third_party_message.html:5`）本地没有拷贝
  （`find … -name 'theme*.css'` 零命中），**它有没有 `color-scheme` 未查**。

---

## 七、变量表：界面代理照此写别名

口径：默认值 = `public/style.css` `:root` 的字面值（§一已证 `power_user` 启动时照抄它）；
「管什么」= `style.css` `:root` 之外第一处 `var(--X)` 的选择器；「用例数」= `style.css` 主文件
`:root` 之外 `grep -c 'var(--X)'`，**不含** `public/css/*.css`（那 23 个文件另有命中，见表后）。
写入处 = `power-user.js` 里 `setProperty('--X', …)` 的行。

**ST 默认主题是深底**：`body{background-color: var(--SmartThemeBlurTintColor)}`（`:159`）=
`rgba(23, 23, 23, 1)`，`#chat{background-color: var(--SmartThemeChatTintColor)}`（`:869`）同值；
正文 **`--SmartThemeBodyColor` 默认 `rgb(220, 220, 210)`**（象牙白，与 `--ivory` `:55` 同值）。
默认主题名 `'Default (Dark) 1.7.1'`（`power-user.js:177`）。

| 变量 | `style.css` 行 | 默认主题的值 | 在 ST 里管什么（首个消费者 / 主文件用例数） | 写入 |
| --- | --- | --- | --- | --- |
| `--SmartThemeBodyColor` | 71 | `rgb(220, 220, 210)` | **正文颜色**：`body{color}`（`:165`）；35 处 | `power-user.js:1106`（`main_text_color`） |
| `--SmartThemeEmColor` | 72 | `rgb(145, 145, 145)` | 斜体/次要文字：`.mes_text em{color}`（`:528`）；11 处 | `:1114`（`italics_text_color`） |
| `--SmartThemeUnderlineColor` | 73 | `rgb(188, 231, 207)` | 下划线文字：`.mes_text u{color}`（`:547`）；2 处 | `:1117`（`underline_text_color`） |
| `--SmartThemeQuoteColor` | 74 | `rgb(225, 138, 36)` | 引号文字/强调：`.mes_text q`（`:554`）、`.mes_bias{color}`（`:421`）；21 处 | `:1120`（`quote_text_color`） |
| `--SmartThemeFastUIBGColor` | 75（**注释掉**） | **无** | **0 消费者**；写入分支也被注释（`:1122-1124`）。**别名可省，解析不到是上游原样** | — |
| `--SmartThemeBlurTintColor` | 76 | `rgba(23, 23, 23, 1)` | **页面与面板底色**：`body{background-color}`（`:159`）；23 处。同时写入 `<meta name=theme-color>`（`:1128`） | `:1127`（`blur_tint_color`） |
| `--SmartThemeChatTintColor` | 77 | `rgba(23, 23, 23, 1)` | 聊天区底色：`#chat{background-color}`（`:869`）；4 处 | `:1131`（`chat_tint_color`） |
| `--SmartThemeUserMesBlurTintColor` | 78 | `rgba(0, 0, 0, 0.3)` | 用户楼层底色；**主文件 0 处**，消费者在 `public/css/toggle-dependent.css:315` | `:1134`（`user_mes_blur_tint_color`） |
| `--SmartThemeBotMesBlurTintColor` | 79 | `rgba(60, 60, 60, 0.3)` | 角色楼层底色；主文件 0 处，消费者 `toggle-dependent.css:309`、`welcome.css:27`、`character-group-overlay.css:76/80` | `:1137`（`bot_mes_blur_tint_color`） |
| `--SmartThemeBlurStrength` | 80 | `calc(var(--blurStrength) * 1px)` = `10px` | 面板毛玻璃半径：`#top-bar{backdrop-filter:blur()}`（`:763`）、`#chat`（`:868`）；26 处 | 间接，经 `--blurStrength` |
| `--SmartThemeShadowColor` | 81 | `rgba(0, 0, 0, 0.5)` | **全局文字阴影颜色**：`*{text-shadow}`（`:140`）；8 处 | `:1140`（`shadow_color`） |
| `--SmartThemeBorderColor` | 82 | `rgba(0, 0, 0, 0.5)` | 边框/轮廓：`code{border}`（`:705`）、`.tokenGraph`（`:340`）；**46 处，用得最多** | `:1143`（`border_color`） |
| `--SmartThemeCheckboxBgColorR` / `G` / `B` | 83 / 84 / 85 | `220` / `220` / `210` | 只喂 `…TickColorValue`（`:86`）；`:root` 外 0 处 | `:1108-1110`（从 `main_text_color` 拆） |
| `--SmartThemeCheckboxBgColorA` | **无** | **无** | 无消费者 | `:1111` |
| `--SmartThemeCheckboxTickColorValue` | 86 | `calc(…)`（由 R/G/B 算的亮度反转，默认解得 ≈ 深色） | 中间量，0 处 | 纯 CSS |
| `--SmartThemeCheckboxTickColor` | 87-89 | `rgb(值,值,值)` | 复选框勾与滑块拇指：`input[type="checkbox"]::before{box-shadow}`（`:4073`）、`input[type="range"]::-webkit-slider-thumb{background}`（`:4296`）；2 处 | 纯 CSS |
| `--mainFontFamily` | 97 | `"Noto Sans", sans-serif` | 正文字体：`body{font-family}`（`:163`）；8 处 | **无写入，无设置项** |
| `--monoFontFamily` | 98 | `'Noto Sans Mono', 'Courier New', Consolas, monospace` | 等宽：`code`（`:702`）、`kbd`（`:717`）、`samp`（`:731`）；8 处 | **无写入** |
| `--mainFontSize` | 96 | `calc(var(--fontScale) * 15px)` = `15px` | 正文字号：`body{font-size}`（`:164`）；52 处，且是所有派生几何的基 | 间接，经 `--fontScale` |
| `--fontScale` | 95 | `1` | 只喂 `--mainFontSize`（`:96`）；`:root` 外 0 处 | `:1175` / `:1179`（`font_scale`） |
| `--sheldWidth` | 92 | `50vw` | 聊天栏宽度：`#top-bar{width}`（`:754`）、`#sheld{left: calc((100vw - var(--sheldWidth))/2)}`（`:779`）；19 处 | `:1087` / `:1096`（`chat_width`，写成 `${n}vw`） |
| `--blurStrength` | 101 | `10` | 只喂 `--SmartThemeBlurStrength`（`:80`）；`:root` 外 0 处 | `:1161`（`blur_strength`，**无单位数字**） |
| `--shadowWidth` | 104 | `2` | 文字阴影半径：`text-shadow: 0 0 calc(var(--shadowWidth) * 1px)`（`:140`）；6 处 | `:1167`（`shadow_width`，**无单位数字**） |

**计数说明**：`:71-89` 声明了 **16 个** `--SmartTheme*`（外加 1 个注释掉的 `FastUIBG`），
`--SmartThemeCheckboxBgColorA` 只由 JS 写；任务写的「15 个」比这少 1–2，差在是否把三个
`CheckboxBgColorR/G/B` 与两个 `Tick*` 各算一个。**别名表少一行就少一个能解析的名字**，
所以表按声明逐个列，不合并。三个**无单位**的数字变量（`--fontScale` `--blurStrength` `--shadowWidth`）
只在 `calc()` 里当乘数用；别名若给它们带单位，`calc(var(--blurStrength) * 1px)` 会失效。

`public/css/*.css` 里另有命中（`grep -c SmartTheme` 非零的 23 个文件），最多的是
`select2-overrides.css`（35）、`backgrounds.css`（20）、`macros.css`（17）；本表的「用例数」不含它们。

---

## 八、语料补量

### 口径（与同伴上一轮完全一致，可复算）

- 目录集合（四个）：`E:/sillyTavern/SillyTavern/data/default-user/characters`（递归）、
  仓库 `测试用卡/`（递归）、`D:/workspace/小项目/iris_分支/测试用卡`（递归）、
  `E:/sillyTavern/SillyTavern/data/_cache/characters`。
- 读取器：`.png` 走 `decodeCardPng`，`.json` 走 `JSON.parse` + `normalizeCard`
  （`packages/iris-character/src/index.ts`）；脚本走 `extractScripts(card).scripts[].content`
  （`packages/iris-script/src/index.ts`，返回 `{scripts, variables, skipped}`）。
- 去重：`sha256(JSON.stringify(card))`。
- 文本人口：界面文本 = 8 个散文字段 + `alternate_greetings` + `extensions.regex_scripts[].replaceString`；
  脚本 = `extractScripts` 的全部 `content`。§八之一按同伴原样把两者拼在一起量；§八之二只量界面文本。
- 脚本：`scratchpad/agents/upstream/theme-census-3.mjs`，输出存 `census-3.txt`；
  逐文件账本在 `theme-census-2.mjs` / `census-2.txt`。
- 复算结果与同伴一致：**62 个 png/json 文件 → 解开 32（png 30 / json 2）→ 内容哈希去重 29 → 按名去重 27**
  （两对同名不同内容：`战锤群星闪耀` png 与 json、`尸变纪元 v0.5（NSFW）` 两个 png）。
  五桶复现为同一批卡名：深 6 / 浅 5 / 透明 4 / 变量 8 / 无声明 6。

### 八之一、那 10 张「透明 + 无声明」卡的前景 `color`

「最外层第一处 `color`」的取法：先找 `body` / `html` / `html,body` / `:root` 规则块里的 `color:`；
没有就退到全文第一处 `color:`（标注）。`var(--x)` 在同一张卡的文本里解一层。
亮度 = 相对亮度 `(0.2126R+0.7152G+0.0722B)/255`，阈值 0.4。

| 卡 | 同伴的桶 | 底色（同伴读到的第一处 `background`） | 最外层第一处 `color` | 亮度 | 判断 |
| --- | --- | --- | --- | --- | --- |
| `Assistant` | 无声明 | — | **无任何 `color:` 声明** | — | 纯文本卡，没有界面；继承什么都可读 |
| `Seraphina` | 无声明 | — | 无 | — | 同上 |
| `存储探针` | 无声明 | — | 无 | — | 探针卡，没有界面 |
| `终焉之刻NG` | 无声明 | — | 无（11 个围栏，没有一个含 HTML 文档标签，也没有 `color:`） | — | 无界面；围栏在上游留作代码块 |
| `性斗学园超级重制版` | 无声明 | — | 无（**6 个完整 HTML 文档围栏，0 处 `color`/`background` 声明，0 个 Tailwind 颜色类**） | — | **有界面但一处颜色都没写**：文字颜色完全靠帧文档的 UA 默认（黑字），底色靠帧 canvas；上游帧 `only light`→白底黑字；落在深底帧里会是黑字配透明底 |
| `干物吸血鬼少女与夜间工作` | 无声明 | — | `#FF0000`（**全文第一处，不在 body 规则里**，是局部高亮） | 0.21 深 | 1 个完整 HTML 文档围栏，`body` 无 `color`；这一格实际与 `性斗学园` 同类——正文色靠 UA 默认 |
| `【Sgw】又看一集` | 透明 | `transparent` | `#ffffff`（`body` 规则） | **1.00 亮** | **硬编码白字，底透明**：明显是按深底写的，落到浅纸上不可读 |
| `绿茵好莱坞` | 透明 | `transparent` | `var(--fm-text)` → `#e0e0e0`（`body` 规则） | **0.88 亮** | 同上：亮字透明底，按深底写的 |
| `命定之诗与黄昏之歌v3.0.4` | 透明 | 渐变（含 `transparent` 关键字，实为 `var(--panel-bg)` 叠两层光泽） | `var(--text-color)` → `#4a3b31`（`body` 规则） | 0.24 深 | **深字**；底并非真透明，同伴的分类器因值里含 `transparent` 子串把渐变归入透明桶 |
| `灭仇家满门之后，我收养了想对我复仇的孤女` | 透明 | 渐变（`#8a6742…#f8efdc…`，纸色，`transparent` 只是渐变里的过渡色标） | `#3d2f22`（全文第一处） | 0.19 深 | **深字浅纸**，自带底色；同上，是分类器把它归错桶 |

**读数**：10 张里，**真正"透明底、硬编码前景"的是 2 张（`【Sgw】又看一集`、`绿茵好莱坞`），两张都是亮字
（L 1.00 / 0.88）**，即按 ST 深底写的、落到浅纸上会不可读。**2 张（`命定之诗`、`灭仇家`）其实自带浅色底
配深字**，是同伴分类器的 `transparent|inherit|none|unset` 子串匹配把渐变归错了桶——修正后透明桶应为 2，
浅色桶应为 7。**6 张无声明里 4 张根本没有界面**（`Assistant` `Seraphina` `存储探针` `终焉之刻NG`），
**2 张有完整 HTML 文档界面却一处颜色不写**（`性斗学园` 6 个文档、`干物吸血鬼` 1 个）——它们的可读性
由帧的 `color-scheme` 决定（§六）：上游 `only light` 下是白底黑字；帧若跟深色主题走，UA 默认前景变浅、
canvas 变深，仍可读；透明 canvas 配深色宿主底 + 黑字才不可读。

**同伴「变量 8」桶的补读（同一卡文本内解一层 `var()`）**：`OVERLORD不死者之王` `#0a0a0a`、
`尸变纪元 v0.5（NSFW）`×2 `#0a0a0f`、`希尔` `#1a1520`、`魔法禁书目录` `#050505`、
`不要被神隐挑战 V1.5.4 测试版` `#0e1028`、`哈人冰恋世界` `#1a1a1f`——**7 张全是深底（L 0.02–0.10）**；
`魔法少女是不会败北恶堕的吧！` 的 `--bg-color: transparent`。修正后五桶：**深 13 / 浅 7 / 透明 3 / 无声明 6 / 不可读 0**。

### 八之二、按两族分类

判据原文（§三之二）：进 iframe 的必须是**围栏代码块（`<pre>`）且文本含 `html>` / `<head>` / `<body` 之一**
（`[TH] src/util/is_frontend.ts:1-3`）；围栏外的 HTML 落进 ST 的 `.mes_text`。实现：围栏 = `` ``` `` 或 `~~~`
成对；「内联 HTML」= 围栏外文本含 `<style` `<div` `<details` `<section` `<article` `<table` `<iframe` `<svg`
之一（**严格档**；`<b>` `<br>` `<small>` 之类不算界面）。只数**显示侧**正则（`disabled` 或 `promptOnly` 的
`replaceString` 不计）。脚本用 jQuery 往父页塞的 DOM 走第三条路，单列。

| 族 | 卡数 | 卡名 |
| --- | --- | --- |
| **只有围栏内完整文档（上游进 iframe）** | **10** | `OVERLORD不死者之王` `希尔` `干物吸血鬼少女与夜间工作` `性斗学园超级重制版` `萧谴写卡助手版_V4.5.1` `魔法禁书目录` `战锤群星闪耀`（png）`战锤群星闪耀`（json）`绿茵好莱坞` `人偶演出Lights ON！⭐` |
| **只有围栏外内联 HTML（上游进 `.mes_text`）** | **2** | `可攻略女主拒绝被攻略`（正则输出里一个**不在围栏里的完整 `<html>` 文档**——ST 会剥掉 html/head/body 标签，内容落进 `.mes_text`；另有 1 个围栏但不过判据）、`银麒赎世`（`<style>`×2 + `<div>`×10，全在正则输出） |
| **两者都有** | **11** | `【Sgw】又看一集`（35 个文档围栏 + `first_mes`/备选开场白/正则里的 `<details>`×26）`创世回廊1.3` `命定之诗与黄昏之歌v3.0.4` `尸变纪元 v0.5（NSFW）`×2 `暗渊：地下城领主` `爱衣` `魔法少女是不会败北恶堕的吧！` `魔法少女的扣扣审判1.0` `灭仇家满门之后，我收养了想对我复仇的孤女` `哈人冰恋世界` |
| 只有脚本造 DOM（第三条路） | 1 | `不要被神隐挑战 V1.5.4 测试版`（界面全由脚本帧里的 jQuery/`srcdoc` 生成，见 `OVERLAY-CARDS.md`） |
| 无界面 | 5 | `Assistant` `Seraphina` `终焉之刻NG` `圣座之音VoxImperialis`（3 个正则全是 `promptOnly`/`disabled`）`存储探针` |

**三条读数**：
1. 有界面的 24 张里 **21 张有进 iframe 的完整文档**，**13 张有落进 `.mes_text` 的内联 HTML**，交集 11。
   两族都不是少数；「内联那一族」（§四第 3 条说的能读到 `--SmartTheme*` 的那一族）在语料里是 **13/24**。
2. **完整文档几乎全部来自正则 `replaceString`**（21 张里 19 张只在正则里，`干物吸血鬼` 与 `灭仇家` 在 `first_mes`
   里，`Sgw` 两处都有）。所以「卡界面在哪一族」的决定者是正则脚本，不是开场白。
3. 内联 HTML 的形态很集中：`<details>`/`<summary>` 折叠块 + 一段 `<style>`，10 张里 9 张是这个组合。
   围栏内**不过** `isFrontend` 的 HTML 片段（上游留作代码块）：**0 张**。

限定：正则 `placement`（1=用户输入 2=AI 输出）与 `markdownOnly` 未进一步区分；界面文本里的宏
（`{{getvar}}` 等）未展开，宏展开后才出现的 HTML 量不到。

### 八之三、「39 文件 → 26 卡」与「32 文件 → 29 卡」不是同一个数

`TEST-CARDS.md:2044-2051` 的那次口径写在表头：**「corpus + 测试用卡 + dev」**，即三个目录：
ST `characters/`、仓库 `测试用卡/`、以及 **dev = `apps/iris/data/default-user/characters/`**
（开发宿主的数据目录，`TEST-CARDS.md:2241` 提到往那里复制 PNG；在 `.gitignore:18` `data/` 下）。
它**没扫** `D:/workspace/小项目/iris_分支/测试用卡`，也没扫 `_cache`。同伴这次扫的是
**corpus + 测试用卡 + iris_分支/测试用卡 + _cache（空）**，**没扫 dev**。

按本轮账本对账（dev 目录按规则**只列文件名与字节数，未读内容**）：

| 目录 | 文件 | 解开 | png / json | 在哪次里 |
| --- | --- | --- | --- | --- |
| ST `characters/` | 47 | **19** | 17 / 2（`Seraphina/` 下 28 张表情立绘无 `chara`/`ccv3` 块，被读取器拒绝） | 两次都有 |
| 仓库 `测试用卡/` | 8（1 个 `.mjs`） | **7** | 6 / 1 | 两次都有 |
| dev `apps/iris/data/default-user/characters/` | 13 | 13（TEST-CARDS 的读数） | 12 / 1 | **只在 TEST-CARDS 那次** |
| `iris_分支/测试用卡` | 9（1 个 `.jpg`） | **6**（2 张 PNG 无卡块） | 6 / 0 | **只在同伴这次** |
| `_cache/characters` | 61（无扩展名的哈希文件） | 0 | — | 只在同伴这次，贡献 0 |

- **TEST-CARDS**：19 + 7 + 13 = **39**；png 17 + 6 + 12 = **36**，json 2 + 1 = **3**。✓
  去重 26：dev 的 13 个文件**按文件名与字节数逐一对上** corpus/测试用卡里的 13 个文件
  （例：`OVERLORD不死者之王.png` 4 864 329 B、`存储探针.png` 4 443 B、`Assistant.png` 46 628 B =
  `default_Assistant.png`、`战锤群星闪耀.json` 1 041 126 B），即 13 张全是复制件，26 = corpus 19 + 测试用卡 7
  且两者之间**无重复**（本轮哈希账本证实：这 26 个哈希两两不同）。按名 25 = 两张 `战锤群星闪耀`。✓
- **同伴**：26 + 分支 6 = **32**；分支 6 张里 3 张与仓库 `测试用卡/新增-20260902/` 同哈希（`2.1.0.png`
  `2.png` `V1.5.4_.png`），**3 张是新内容**（`哈人冰恋世界` `人偶演出Lights ON！⭐` `尸变纪元 v0.5（NSFW）`
  的另一个版本，2 253 651 B ≠ corpus 的 2 254 043 B），26 + 3 = **29**。按名 27。✓

**所以差在两个目录**：TEST-CARDS 多扫了 dev（+13 文件、+0 张不同卡），少扫了 `iris_分支/测试用卡`
（−6 文件、−3 张不同卡）。两个去重口径相同（都是内容哈希），**26 与 29 的差正是 `iris_分支` 那 3 张**。
后续引用应写清「26（不含 iris_分支）」或「29（含 iris_分支，不含 dev）」，两个数都对，指的不是同一集合。

### 八之四、本轮未查清

1. 帧内 `color-scheme` 的实际计算值（§六）——规范推导，未在浏览器读。
2. jQuery-UI `theme.min.css`（远程）有没有 `color-scheme`。
3. TH 面板自己有没有用 `dist/index.css` 里的 `scheme-*` 工具类（只影响 ST 页面，不影响帧）。
4. §八之二没有展开正则 `placement` / `markdownOnly`，也没有宏展开；`性斗学园` 6 个文档零颜色声明
   是否靠 Tailwind 以外的方式着色（例如 `<font color>` 属性、`bgcolor`）未查。
5. dev 目录 13 个文件只按名字与字节数对上，没有解开对哈希。
