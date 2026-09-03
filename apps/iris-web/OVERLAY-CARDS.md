# 覆盖层卡：一类新的界面宿主 —— 设计输入

**对象**：`测试用卡/新增-20260902/V1.5.4_.png`，卡名 **「不要被神隐挑战 V1.5.4 测试版」**。
19 卡语料里没有这一族。

**结论先说**：这张卡**不是「虚拟 parent 能兜住」，也不只是「要 page-access 授权」**。
它要的是一块**覆盖整个应用视口的、由宿主拥有的表面**，而它取得这块表面的途径
**根本不经过 `parent`**——所以虚拟 parent 拦不到它，document 授权也不对准它。
**这是第三类：新的界面宿主。**理由在 §二和 §五。

这是设计输入不是规格。日期 2026-09-02。笔者：上游研究域（3c）。

## 口径

- **[卡]** 经**产品自己的解码器**读出：`decodeCardPng` + `extractScripts`
  （`packages/iris-character`、`packages/iris-script`）。不是手搓的 PNG/JSON 解析。
- **[上游]** 行号在 `data/default-user/extensions/JS-Slash-Runner/`（酒馆助手 4.9.1）。
- **[此处]** 行号在本仓库。
- **只记形状**：下面引的都是代码结构与 API 调用形状，**卡的叙事内容一个字不引**。
- **未跑**：全部是**静态读**。我没有运行这张卡。
  只读纪律的判据是**「凡有确认/保存/发送/改状态语义的交互都不碰」**——
  **不是**「不触发生成就可以」（那是我一度用错的放宽版，见 §七 第 1 条）。
  §七 标出哪几条因此只是**预测**而非观测。

---

## 一、卡的结构

扩展键：`talkativeness, fav, world, depth_prompt, regex_scripts, tavern_helper, xiaobaix-tasks`

**`xiaobaix-tasks` 不在我们的脚本承载键名单里。**名单是 [此处]
`packages/iris-script/src/extract.ts:28`：

```ts
const KEYS = ['tavern_helper', 'TavernHelper_scripts'] as const
```

**两个键。**（初版我写成三个、且把第二个的名字写成 `TavernHelper`、还把 `regex_scripts`
算了进去——都错。`regex_scripts` 走的是另一条路，`iris-app-service/src/regex.ts:52`，
不经 `extractScripts`。44 指出，我复核后确认。）

本卡四个脚本都在 `tavern_helper` 下。`xiaobaix-tasks` 里是什么见 §五之三。

### 正则：确认「零产界面」

`regex_scripts` **共 1 条**，`[不发送]去除变量更新`，
`promptOnly=true`、`markdownOnly=false`、`replaceString` **长度 0**。

**它是个删除器，不是生成器。**总指挥说的「零产界面正则」用产品的读取器复核成立：
**这张卡的界面完全不经过 display 正则。**

### 四个脚本

| 脚本 | 字节 | 职责 | `pagehide` 自清 |
| --- | --- | --- | --- |
| `mvu` | 89 | 远程 import 一行 | 否 |
| `变量结构` | 4,785 | 变量模式 | 否 |
| **`游戏引擎`** | **561,835** | 纯逻辑：提示词、世界书、事件 | 否 |
| **`论坛覆盖层`** | **990,319** | 纯界面：Vue + Tailwind | **是** |

合计 **1,557,028 B**。

**分工是干净的**，这点比字节数重要：

```
游戏引擎    document.* = 0   window.parent = 0   'iframe' = 0   postMessage = 0
论坛覆盖层  injectPrompts = 0  createWorldbookEntries = 0  generate = 0
```

**引擎完全不碰 DOM，覆盖层完全不碰提示词装配。**两边各自 200 上下次事件总线调用。

---

## 二、① 它把 DOM 建在哪：**建在宿主页面的 `<body>` 上，而且不经过 `parent`**

这是整份文档的枢纽，所以把推断链完整写出来。

### 挂载点只有一处

覆盖层脚本里 **`.appendTo('body')` 恰好 1 次**，
**`$('选择器字符串')` 形式 0 次**，`createElement('iframe')` 0 次。挂载代码的形状是：

```js
$('<iframe>').attr({ frameborder: '0', srcdoc: '<!DOCTYPE html>…viewport-fit=cover…' })
  .css({ position:'fixed', top:'0', left:'0', width:'100%', height:'100%', 'z-index':'9999', border:'none' })
  .on('load', function () { app.mount(this.contentDocument.querySelector('#app')) })
  .appendTo('body')
```

随后还用 `style.setProperty(..., 'important')` 把
`display/position/top/left/width:100vw/height:100vh/z-index:9999` **各钉一遍**。

### `'body'` 解析到谁的 document —— 决定性的一步

[上游] `src/iframe/parent_jquery.js` **全文两行**：

```js
window.$ = window.parent.$;
window.jQuery = window.parent.jQuery;
```

脚本 frame 里的 `$` **就是宿主页面那个 jQuery 函数对象**。jQuery 的默认查找上下文是
它自己求值时闭包捕获的 `document`——**宿主页面的 document**。
所以 `.appendTo('body')` 里的 `'body'` 是 **ST 页面的 body**。

**而同一个脚本里的裸 `document` 不是。**[上游] `src/panel/script/iframe.ts` 的
`createSrcContent` 把脚本正文放进 `<script type="module">`，跑在 frame 自己的文档里；
`parent_jquery.js` 与 `predefine.js` 都**没有重定义 `document`**。

于是这张卡里同时存在两种语义：

| 写法 | 落在哪 | 卡里的用例 |
| --- | --- | --- |
| `$('选择器')` / `.appendTo('body')` | **宿主页面** | 挂 overlay iframe（1 处） |
| 裸 `document.body` / `document.querySelectorAll` | **脚本 frame 自己** | 9 处 / 11 处 |
| `$(window)` / `$(document)`（**对象**参数） | **脚本 frame 自己** | message/keydown/resize 监听 |

**同一份代码里两个 realm，靠的是「参数是字符串还是对象」区分。**
这不是这张卡的怪癖，是 `window.$ = window.parent.$` 这一行的必然结果。

### 为什么它必须挂在页面上

[上游] `src/panel/script/Iframe.vue:2`：

```html
<iframe v-show="false" :id="`TH-script--${name}--${id}`" … />
```

**脚本 frame 是隐藏的**（`v-show="false"` → `display:none`）。挂在自己 body 上不可见。
所以「挂到宿主页面」不是这张卡越权，**是上游给脚本 frame 的唯一可见途径**。

### 它没有碰 `parent.document`

`parent.document` 命中 **0**。`window.parent` 命中 2 次，**两次都是 postMessage**。
`frameElement` 命中 1 次，**在一段注释里**——作者写明早期版本在 iframe 内直接改
`frameElement.style.display`，与样式守护 observer 冲突，已改掉。

**含义很硬**：这张卡的页面访问，**没有一个可以被虚拟 parent 拦截的名字**。
它不是 `parent.document.body.appendChild`，而是**一个库的 realm 绑定**。

---

## 三、② postMessage 的收发双方与协议形状

### 真正的双脚本协议是事件总线，不是 postMessage

```
游戏引擎    eventOn/eventEmit  205 次，61 个不同的首参
论坛覆盖层  eventOn/eventEmit  164 次，60 个不同的首参
```

命名空间是 `forum:*`、`debug:*`、`performance:*`
（如 `forum:refresh`、`forum:save-bookmark`、`debug:format-selftest`）。
**这是上游 TavernHelper 的事件总线**，注册表在宿主侧、按 frame 名分区。

**两条脚本之间从不用 postMessage。**

### postMessage 只承担一件事，单向、一个字符串

```js
// 覆盖层 iframe 内的 Vue 组件
window.parent.postMessage('toggle-forum-overlay', '*')
```

接收侧在脚本里：

```js
$(window).on('message', e => 'toggle-forum-overlay' === e.originalEvent.data && GA())
```

**协议就这一条消息、无载荷、无回复、无握手、`targetOrigin` 是 `'*'`。**

作者的注释写明了为什么走这条路：早期版本在 iframe 内直接改 `frameElement.style.display`，
和外层的样式守护 observer 打架，所以改成**由外层统一处理显隐**。

### 一处我读出来的不一致，**未经运行确认**

按 §二 的两种 realm：overlay iframe 挂在**宿主页面**，所以它内部的 `window.parent`
是**宿主页面的 window**；而 `$(window).on('message', …)` 里的 `window` 是**脚本 frame 的 window**。
**两者不是同一个对象，这条消息看起来到不了监听器。**

同源的三处一起看，它们都指向脚本 frame 自己那个（隐藏、不改变大小的）文档：

- `document.body.contains(n)` —— 检查一个在**宿主页面**里的节点，恒为 false
- `new MutationObserver(...).observe(document.body, {childList:true})` —— 观察的是空的隐藏文档，
  「iframe 被外部从 DOM 移除，重新挂载」这条恢复路径不会触发
- `$(window).on('resize.forum-overlay …')` —— 隐藏 frame 不会 resize

**而挂在 overlay 自己 contentDocument 上的 `Escape` 键监听是正常的**，
`window.__toggleForumOverlay` 也照常暴露。所以即使上面成立，**也只是"面板内那个按钮不灵、
Esc 灵"**，不是整卡不工作。

**这条是从压缩后的源码读出来的预测，不是观测**（§七）。
**但设计决定不依赖它**：无论那条消息现在通不通，我们都得回答
「overlay 用什么通道通知宿主切换显隐」，而 §六 的答案对两种情况都一样。

---

## 四、③ `injectPrompts` 与世界书的写形状

### 上游签名

[上游] `src/function/inject.ts:5-21`：

```ts
type InjectionPrompt = {
  id: string; position: 'in_chat' | 'none'; depth: number;
  role: 'system' | 'assistant' | 'user'; content: string;
  filter?: (() => boolean) | (() => Promise<boolean>); should_scan?: boolean;
}
function injectPrompts(prompts: InjectionPrompt[], { once = false }: { once?: boolean } = {})
  : { uninject: () => void }
```

实现落到 ST 的 `setExtensionPrompt`，`position === 'none' ? -1 : 1`，
`role` 经 `{system:0, user:1, assistant:2}` 映射。`once` 时挂
`GENERATION_ENDED`/`GENERATION_STOPPED` 自动撤销；**另外总是**挂
`$(window).on('pagehide', uninject)`。

### 卡的用法

```js
{ position:'in_chat', depth:0, role:'user', content: …, should_scan:false }
…
o?.skipInject || (S = injectPrompts(u))
```

三条要点：

1. **只传一个参数 → `once` 是 `false`**：注入**不随一次生成结束而消失**，
   它一直在，直到卡自己调 `uninject()` 或 frame 卸载。
2. **卡自己管生命周期**：句柄存进模块级变量 `S`，在若干处显式
   `S.uninject(); S = null`——包括一个叫 `withIsolatedRawGeneration` 的包装，
   **先撤掉注入再跑一次隔离生成**。这是「同一局里存在两种提示词装配态」的用法。
3. **`should_scan:false`** —— 注入内容不参与世界书扫描。

**这是一个全新的提示词装配面成员**：既不是预设、不是世界书、不是消息，
而是**一段由卡持有句柄、可随时撤销与重装的运行时注入**，深度 0、角色 user。

### 世界书写形状

```js
x || typeof N.getOrCreateChatWorldbook !== 'function' || (x = await N.getOrCreateChatWorldbook('current'))
x && typeof N.createWorldbookEntries === 'function'
  ? await N.createWorldbookEntries(x, [{ name:`[…@${e}]`, enabled:true,
      strategy:{ type:'selective', keys:[`@${e}`] }, content:… }])
  : console.warn(…)
```

- 目标是 **chat 世界书**（`'current'`），不是卡的、不是全局的。
- **每个 API 调用前都 `typeof … === 'function'` 探测，缺了就 `console.warn` 继续**——
  这张卡**自带降级路径**。对我们是好消息：**未实现的成员会得到警告而不是崩溃**，
  前提是我们的缺失表现为「不是函数」而不是「读取时抛异常」。
  **我们的具名拒绝是抛异常的**（`errors.ts`），所以这条降级在我们这**不会生效**。
  见 §六 第 4 条。
- `updateWorldbookWith` 0 次，`uninjectPrompts`（顶层函数）0 次。

---

## 五、④ 它依赖上游的哪些假设，在我们这成立与否

| # | 上游假设 | 上游依据 | 共居 realm + 虚拟 parent 下 |
| --- | --- | --- | --- |
| 1 | **`$` 是宿主页面的 jQuery**，字符串选择器落在页面上 | `parent_jquery.js` 全文两行 | **不成立**。[此处] `sandbox/preset-entry.ts:100` `host['$'] = jquery`，是**绑在 frame 自己 document 上的真 jQuery**（3.5.1，对齐 ST 服务的那版）。所以 `$('body')` 落在 **frame 自己的 body**。 |
| 2 | 脚本 frame 隐藏，可见界面必须挂到页面 | `Iframe.vue:2` `v-show="false"` | **同样成立**，机制不同——见 §五之二。 |
| 3 | `position:fixed; 100vw/100vh; z-index:9999` 能覆盖整个应用 | 挂在页面 body 上时成立 | **不成立**。frame 内的 `fixed` 相对 **frame 的视口**。卡里 `position:fixed` 49 处、`100vh` 23 处、`100vw` 6 处。 |
| 4 | `document`（裸）= frame 自己 | `createSrcContent` 用 `<script type="module">`，无人重定义 | **成立**，且我们相同。 |
| 5 | overlay iframe 的 `window.parent` = 挂载它的那个 window | 浏览器语义 | **成立**，但**指向谁**随假设 1 变。 |
| 6 | 事件总线跨脚本可达、按 frame 分区 | TavernHelper 注册表 | **`COHABITATION.md` 已处理**：`eventEmit` 是共居下的既定例外，卡内广播正是本意。 |
| 7 | `TavernHelper` 成员缺失时是「不是函数」 | 卡自带 `typeof` 探测 | **不成立**：我们的缺失是**具名抛出**。 |
| 8 | 自带 `pagehide` 清理 | 覆盖层脚本含 `pagehide` | **顺带一条上游事实**：`iframe.ts:13` 的注入条件是 `use_cleanup_protector && !content.includes('pagehide')`，**这张卡因为自己写了 pagehide 而永远拿不到保护器**。而这台机器上 `use_cleanup_protector: false`（我读的 `settings.json`），**本来也没开**。 |

**假设 1 是根，2/3/5 都挂在它下面。**

## 五之二、一处更正：我们的脚本 frame 也是隐藏的，但隐藏法不一样

**初版这张表的第 2 行我写错了**——写成「我们的 frame 本身就是可见表面」。
那句对**消息/前端 frame** 成立，对**卡脚本 frame 不成立**。实测：

```jsx
// [此处] apps/iris-web/src/app/useCardScripts.tsx:384-390
<div ref={mount} aria-hidden="true"
  style={{ position:'absolute', width:0, height:0, overflow:'hidden', left:'-9999px' }} />
```

**卡脚本 frame 挂在一个 0×0、`overflow:hidden`、移到 −9999px、`aria-hidden` 的容器里。**
和上游一样是隐藏的。改这一行，是因为原话会让读者以为这类卡在我们这能显示出界面——**正好反了。**

### 两种隐藏法不等价，验收要按我们这种写

| | 上游 | 我们 |
| --- | --- | --- |
| 机制 | `v-show="false"` → `display:none` | 0×0 + `overflow:hidden` + 移出视口 |
| frame 有没有布局 | **没有** | **有，只是尺寸为 0** |
| 里面的代码 | 部分观测器/测量可能根本不跑 | **照跑，量到一排 0，然后若无其事继续** |

**差别是可观测的**：`display:none` 下「什么都没发生」，0×0 下「一切都发生了，只是全是零」。
V1.5.4 会走到底——建 iframe、mount Vue、钉 `!important` 样式、装监听——
**`100vh`/`100vw` 全解析成 0，`aria-hidden` 连辅助技术也看不到，且不抛任何错。**

**所以验收断言该写「量到 0」，不该写「没有布局」。**

### 这个坑代码里已经写着了，且预告了它什么时候会咬

同一文件那个 `<div>` 上方的注释（`useCardScripts.tsx:377-383`）原文大意：
卡自我测量会得到零，bootstrap 发布的 `--TH-viewport-height` 会不再描述任何真实的东西；
**「这些脚本今天什么都不渲染，所以还咬不到——但『现在还不要紧』正是一个 frame
最后表现得和消息管线不一致的路径。」**

**V1.5.4 就是让它开始咬的那张卡。**

同理，§五第 1 行那条也不是我的发现：`preset-entry.ts:81-95` 早把它写成
**「Iris 刻意偏离上游的唯一一处」**，并且写明了理由（frame 跨源、够到真页面正是每卡
document 授权要管的事）和一个我没量到的细节（版本对齐 ST **服务**的 3.5.1，
而不是 MVU manifest 里声明的 `^4.0.0`）。**我做的是把它和这张卡接上，不是发现它。**

---

## 五之三、和 44 的独立普查对拍（2026-09-03）

**这次两条路径确实分叉**：我读 `parent_jquery.js` 的 `$` 绑定 + 上游源码，
他换判据数「解析到哪个 document」。所以一致是有鉴别力的——
**但它证的是「两个静态读法同意」，不是「跑起来是这样」。**

### ① 承重的那个数：确认，而且理由比我给的强

我的结论压在 `appendTo('body')` = 1 上。他确认，并且回答了我只报了「0」的那一半：

```
$( … ) 调用   10 次，其中传字符串的只有 1 次，参数是 '<iframe>'
```

**`'<iframe>'` 是建元素不是查文档。**其余 9 次传的是对象/元素。
所以「宿主页面写入只有一处」不是「碰巧没写第二处」，
**是这个脚本从不用 `$` 去查宿主 document**。§六 不用重算。

### ② 一处他自己发现并撤回的假阳性 —— 值得记

他放宽判据加了 `\.(?:prependTo|insertBefore)\s*\(`，数出 1 处，
差点报「你漏了一处宿主写入」。读原文后是：

```js
i.length ? e.insertBefore(r, i[n]) : e.appendChild(r)   // style-loader 的辅助函数
```

**那是 DOM 的 `Node.insertBefore`，不是 jQuery 的 `.insertBefore()`**，
操作对象是传进来的 style 元素的子节点，与宿主页面无关。

他的原话值得原样留着：

> 我是在**为你复核而放宽判据的过程中**制造的假阳性——
> **放宽召回本身会引入新的假阳性，两个方向的错可以由同一个动作同时产生。**

### ③ `xiaobaix-tasks`：机理成立，后果为零

```
V1.5.4 的 xiaobaix-tasks:  12 B，1 个条目，字符串 0 个   ← 空数组
```

他顺手扫了 22 张卡（19 语料 + 3 新）的**全部** extensions 键，按「有没有像代码的长字符串」排：

```
tavern_helper          18 卡  5,675,840 B   代码串 38
regex_scripts          18 卡  3,002,180 B   代码串 74
TavernHelper_scripts    3 卡    485,724 B   代码串  9
—— 以上在名单内 ————————————————————————
world / talkativeness / fav / depth_prompt   22 卡  0 B  代码串 0
xiaobaix-tasks          3 卡         36 B   代码串 0
ST-Amily2-Chat-Optimisation / xiaobaix-template / juqingtuijin   共 480 B  代码串 0
```

**结论是两层的，两层都要说：**

1. 名单确实不全——名单外还有 5 个键；
2. **但当前语料里，名单不全没有造成任何漏读**：名单外 8 个键合计不到 2.2 KB，零个代码串。

只说第一句是虚惊，**只说第二句是把运气当设计**。

### ④ realm 不一致：第二条静态路径支持它，但仍不是观测

他的链条（读 append 目标与 listener 绑定对象，不读 `$` 的绑定）得到同一结论，
并补了两个我没量的数：

- **全卡只有 1 个 `message` 监听器，`addEventListener('message')` 0 个**——**没有中继**。
- 发送处的注释表明 **postMessage 是后改的、有意的设计**，替掉了会和样式守护 observer
  冲突的 `frameElement.style.display` 旧做法。

**所以如果这条链断着，是这张卡出厂就断的，不是我们的环境造成的。**
这条对我们有用：**它把「这张卡在 Iris 上表现异常」和「这张卡本来就有个断的按钮」分开了**，
否则验收时会把上游的既有缺陷记到我们账上。

### ⑤ 事件名 61/60：维持下界

`eventOn(n, …)` 里 `n` 的取值要跟到运行时。他明确不补：**补了也是另一个下界。**

### 谁复核了谁

- **他量的、我未独立复核**：①③④ 三节的数。
- **我量的、他未独立复核**：键名清单、事件名计数、Vue/Tailwind 计数、字节数。
- **我复核过的**：`extract.ts:28` 的 `KEYS`（他用来纠正我的那条），我自己读了文件确认。

**所以这一节不是「两个域全面对上」，是三个点对上、其余各自单路径。**

---

## 六、决定与设计

### 决定：**新的一类界面宿主**

三个选项逐个否掉：

- **「虚拟 parent 能兜住」——否。**虚拟 parent 拦的是 `parent.*` 上的名字。
  这张卡**一次都没走 parent 取页面访问**（`parent.document` = 0），
  它走的是 `$` 的 realm 绑定。**拦不到一个从没被提及的名字。**
- **「要 page-access 授权」——不对准。**`virtual-document.ts` 把
  `parent.document.body` 解析成**卡自己的容器**，所有查找都限定在容器内。
  就算把它开成可写，卡拿到的仍是**容器内的一块**，
  而它要的是**盖住整个应用**。**授权改的是"能不能写"，这里差的是"写到哪"。**
- **「新的界面宿主」——是。**它要的是一块**全视口、可显隐、由宿主定位**的表面。

### 设计要点

1. **宿主拥有表面，卡申请它。**
   卡声明「我要一块覆盖层」，宿主创建容器、负责 `position`/`z-index`/尺寸与显隐，
   卡只往里 `mount`。**定位权在宿主，不在卡的 `!important`。**
   这直接消掉假设 3：卡不需要 `100vh` 生效，因为不是它在定尺寸。

2. **显隐要有一个具名通道，别指望 postMessage 猜。**
   上游这张卡的切换是「overlay → `window.parent` → 一个字符串」。
   我们给一个具名的宿主 API（显示/隐藏/切换当前卡的覆盖层）即可，
   **而且这条设计对 §三那个不一致成不成立都一样**——所以不必等运行时确认再定。

3. **别把 `$` 悄悄改指向。**
   把我们 frame 内的 `$` 变成"页面的 jQuery"会一次性打开 §二 那条不具名的通道，
   和 `GRANTS.md` 四个教训的方向相反。**保持 `$` 是 frame 自己的**，
   代价是这类卡的 `.appendTo('body')` 会落在 frame 内——**这正是我们要的落点**，
   只要那个 frame 就是宿主给它的覆盖层表面。

4. **卡的降级探测在我们这不生效，要正视。**
   它对每个 TavernHelper 成员都 `typeof === 'function'` 探测，缺了就 `console.warn` 走降级。
   **我们的具名拒绝是抛异常，所以探测本身就会炸。**
   两条路，二选一，我不替实现者定：
   - **在成员存在性检查上不抛**（`typeof` / `in` 走"答 false 不抛"，
     取值才抛）——`COHABITATION.md` 对虚拟 parent 已经采了这个形状
     （「`has` / `in` 在任何名字上都作答，从不抛」），**这里是同一条规律换了个面**；
   - 或者接受这类卡在缺成员时崩溃，靠具名错误定位。
   **我倾向前者**，理由是它和已定的虚拟 parent 形状一致，而不是新开一条例外。

5. **`xiaobaix-tasks` 这个第三方键要有个决定**（§七）。

### 这张卡值得当靶子的理由

它把三件我们分开处理过的事**同时**用上了：**运行时提示词注入**（可撤销、非 once）、
**chat 世界书写入**、**自建全视口界面**，而且**一行 display 正则都不用**。
19 卡语料里没有这一族——**它不是现有分类的极端样本，是分类外的样本。**

---

## 六之二、ST 锚点面：覆盖层卡对宿主 DOM 的实际要求

**这一节的对象不是 V1.5.4**，是**手机UI 那一族**（银麒赎世 / 魔法少女的扣扣审判1.0，
44 测得是同一份代码的两个分叉）。它们通过 `window.parent.document` 拿 ST 的三个元素。

**结论**：**三个锚点没有一个是只读的。**`send_textarea` + `send_but` 是完整的
**「写值 + 派发事件 + 点发送」**——通过 DOM 驱动 ST 的**真实发送管线**。
**给一个只读镜像不够。**

行号是卡内脚本正文行号（`decodeCardPng` + `extractScripts` 解出，渲染前）。

### `#send_textarea`

三处：银麒赎世/手机UI `:14180`、银麒赎世/银麒系统面板 `:278`、魔法少女/外置状态栏 `:5456`。

**DOM 变体**（手机UI `:14180-14191`；外置状态栏 `:5456-5478` 逐句同构）：

```js
const originalInput = targetDocument.getElementById("send_textarea");
const sendButton    = targetDocument.getElementById("send_but");
if (!originalInput || !sendButton) return false;
if (originalInput.disabled || sendButton.classList.contains("disabled")) return false;
originalInput.value = originalInput.value ? originalInput.value + "\n" + message : message;
originalInput.dispatchEvent(new Event("input",  { bubbles: true }));
originalInput.dispatchEvent(new Event("change", { bubbles: true }));
await new Promise(r => setTimeout(r, 300));
sendButton.click();
```

操作集：**读 `.disabled`｜读 `.value`｜写 `.value`（非空则换行追加）｜派发 `input`｜派发 `change`**。

**jQuery 变体**（银麒系统面板 `:276-286`）：

```js
var $input = $p("#send_textarea");
if ($input.length) { $input.val(text); $p("#send_but").trigger("click"); }
```

**两个变体不等价**：`$.val()` **不派发 `input`/`change`**。
**同一张卡里两条发送路径，一条让宿主的输入处理器看到变更，一条不会。**
只支持其中一种语义，另一条会**静默失效**。

> **这是"读 DOM 值"而非"听事件"的理由**：发送键必须在按下时**去读输入框当前的值**，
> 才能容纳那条不派发事件的路径。

### `#send_but`

三处，与上一一对应：`:14181`、`:281`、`:5457`。

操作集：**读 `.classList.contains("disabled")`｜`.click()`**（DOM 变体，**写值后延迟 300 ms**）；
jQuery 变体是 **`.trigger("click")`**。

**那 300 ms 是卡对宿主输入处理器的时序假设**，写死在卡里，**我们改不了**。

### `#chat`

**只有一处**：银麒赎世/银麒系统面板 `:9562`。**不读值、不量尺寸、不读 scroll。**

```js
var observer = new MutationObserver(function (mutations) {
  if (_streamFreeze && _streamFreezeEnabled) { _needsRefreshAfterStream = true; return; }
  for (var m of mutations) for (var n of m.addedNodes)
    if (n.classList && n.classList.contains("mes")) { setTimeout(injectPanel, 100); return; }
});
var chatEl = _pd.getElementById("chat");
if (chatEl) observer.observe(chatEl, { childList: true, subtree: true });
```

**它把 `#chat` 当"有新楼层了"的信号源，不是数据源。**

> **⚠ 一处补正（2026-09-03）。**上面这句**只说了这个 observer**，而我当时**没读它的回调
> 最终调用的 `injectPanel()` 做什么**。补读之后：
>
> ```js
> // [银麒赎世/银麒系统面板] injectPanel()
> var $messages = $p("#chat .mes");
> if ($messages.length === 0) return;
> var $lastMsg = $messages.last();
> if (!$p("#yinqi-panel-css").length) { $p(_pd.head).append(PANEL_CSS); }   // ← 往主页面 <head> 注 CSS
> var $dicePanel = $lastMsg.find('[id*="dice"], [class*="dice"]');
> if ($dicePanel.length) { $dicePanel.first().before(buildPanel()); }
> else { $lastMsg.find(".mes_text").append(buildPanel()); }                 // ← 面板挂进 .mes_text
> ```
>
> **所以 `#chat` 对这张卡不只是信号源，也是挂载点。**它需要
> **最后一条 `.mes` 里有 `.mes_text`**——空存根没有，`.find(".mes_text")` 得空集，
> **`.append()` 在空集上是静默 no-op，面板永不出现**；还需要**主页面 `<head>` 可写**。
>
> **这条被引用过**：`OVERLAY-HOST.md` 方案 B 据「实际消费只有 childList」推出
> 「一个空 `.mes` 存根真的满足它」。**前半句是我量的，后半句是我没验的一步。**
>
> *（`[id*="dice"]` 那个分支在本语料里**永不命中**：全语料没有任何脚本创建 id/class 含
> `dice` 的节点——创世回廊与手机UI 里的 `dice` 全是伤害骰计算的变量名/函数名。
> **所以 `.mes_text` 那条是唯一活着的路径。**）*

**这条是对我们 DOM 结构的具体约束**，不只是"给个元素"：

- 新楼层必须是 **`#chat` 子树里的新增节点**（`childList` + `subtree`）；
- 那个节点必须**带 class `mes`**。

**否则观察者永不触发、面板不重注入——而且这个失败是静默的**：观察者装上了，只是不响。

### 两条同族的腿（不在原任务单上，就在旁边）

| 锚点 | 行号 | 操作 |
| --- | --- | --- |
| **`#mes_stop`** | 银麒系统面板 `:9525-9526` | `$p("#mes_stop").is(":visible")` → 当作"正在生成" |
| **宿主全局 `is_send_press`** | 同 `:9521` | `isSending = !!_pw.is_send_press`（`_pw` = `window.parent`） |

**这两条和 `#chat` 的观察者是同一套机制的三条腿**：
`is_send_press` / `#mes_stop` 可见性判断**生成中 → 冻结面板刷新**；
`#chat` 的 childList 变化判断**生成完 → 重注入面板**。

**缺一条，另两条的行为会变**——例如没有冻结信号，面板会在流式输出期间**反复重注入**。

### 口径

第一版探针把 `#chat` 数成 20+ 处：它匹配了卡**自己的** `#chat-back-btn` / `#chat-send-btn`
等元素，以及 `channelKey === "chat"` 这类字符串。**收紧成精确 id 形式后是 1 处。**
上面所有数是收紧后的。

---

## 六之三、宿主 DOM 与尺寸：覆盖层宿主（父子化）要对齐的那几个数

**给 `OVERLAY-HOST.md` 当上游对照。**§六之二 讲卡对三个锚点**做什么**，
这一节讲它们**长什么样、什么时候消失、以及尺寸是谁定的**。

### 一 · body 层的挂靶（只列卡真用到的）

| 选择器 | 谁用、做什么 | 出处 |
| --- | --- | --- |
| **`body`** | 覆盖层 iframe 的挂载点（`.appendTo('body')`） | V1.5.4 `论坛覆盖层`，**全卡仅此 1 处**（§二） |
| **`#chat`** | `MutationObserver.observe(el, { childList:true, subtree:true })`，当"有新楼层"的信号源 | 银麒系统面板 `:9562` |
| **`#send_textarea`** | 读 `.disabled`／读写 `.value`／派发 `input`+`change` | 手机UI `:14180`、系统面板 `:278`、外置状态栏 `:5456` |
| **`#send_but`** | 读 `.classList.contains('disabled')`／`.click()` | 同上三处 |
| **`#mes_stop`** | `.is(':visible')` 当"正在生成" | 系统面板 `:9525-9526` |

**`#send_form` / `#sheld` 语料里零命中。**（`#tavern_helper` 是 MVU 的选举用，不是卡挂靶，见
`packages/iris-app-service/UPSTREAM-MVU-INIT-PATH.md` §三之六。）

### 二 · `.mes` 的结构（`[ST] index.html:7377-7378`）

```html
<div id="message_template" class="template_element">
  <div class="mes" mesid="" ch_name="" is_user="" is_system="" bookmark_link="">
```

**是 HTML 属性，不是 `data-*`**：`mesid` `ch_name` `is_user` `is_system` `bookmark_link`。
子结构里卡会碰到的：**`.mes_text`**（正文，界面 frame 就挂在它里面）、
`.mes_reasoning` `.mes_media_wrapper` `.mes_file_wrapper` `.mes_bias`
`.swipe_right` `.swipes-counter` `.mesAvatarWrapper > .avatar > img`。

`chatElement = $('#chat')`（`[ST] script.js:448`）。

> **⚠ `mesid` 是位置性的、会被重写。**删除/交换时
> `$(element).attr('mesid', minId + index)`（`script.js:9411`）、
> `:8319-8320` 直接对调两个节点的 `mesid`。
> **任何"按 mesid 记住某一楼"的做法在删楼后会指到别人**——
> 和 §四之四 给 `@scope` 选候选序号而非楼号是同一条理由。

### 三 · 切聊天时 body 上的卡节点：**残留**

```js
// [ST] script.js:1584-1603   clearChat()
extension_prompts = {};
//This will also remove non '.mes' elements, e.g. '<div id="show_more_messages">Show more messages</div>'.
chatElement.children().remove();                                    // ← 只清 #chat 的子节点
if ($('.zoomed_avatar[forChar]').length) { $('.zoomed_avatar[forChar]').remove(); }   // ← 一个具名 class
```

**全函数只碰两处 DOM：`#chat` 的子节点、`.zoomed_avatar[forChar]`。body 层一个都不碰。**

所以覆盖层 iframe **跨聊天存活**，直到卡自己 `pagehide` 清、整页刷新、
或卡的 MutationObserver 发现它被移除后重新挂（§六之二）。

**账本措辞**：上游是**「残留且无人负责」**，不是"上游会清"。
我们若在切聊天时清，写成**「我们多一个清理点」**——对账动作是"确认我们多做了一步"，
写成"和上游不同"会让人去逐条比对两边的清理规则，而规则并不冲突。

### 四 · 界面 frame 的尺寸：**它自己写 `frameElement.style.height`**

```js
// [TH] iframe/adjust_iframe_height.js  全文 57 行
height = body.scrollHeight;                     // :15   量自己的 body
frameElement.style.height = `${height}px`;      // :21   ← 直接写自己那个 iframe 元素
const resize_observer = new ResizeObserver(() => postIframeHeight());   // :47
resize_observer.observe(body);                                          // :50
$(() => { postIframeHeight(); observeHeightChange(); });                // :53-56
```

- rAF 调度，无 rAF 时退到 `_.throttle(…, 500)`（`:26`/`:34-38`）。
- **整个 `measureAndPost` 包在 `try/catch {}` 里，catch 体是空的**（`:22-24`）——**失败完全静默**。
- **只注入界面/消息 frame**（`panel/render/iframe.ts:96`），**脚本 frame 没有**。

**`frameElement` 是跨文档访问自己的宿主元素，要求同源。**
父子化后它指向 realm frame 文档里的那个 iframe 元素——**机制仍成立，前提是两者同源。**

*（这正是 V1.5.4 注释里"早期版本在 iframe 内直接改 `frameElement.style.display`，
跟 style 守护 observer 冲突"说的那个写法——**同一个模式，一个改 height 一个改 display**。）*

### 五 · 已有一条 host→frame 的 postMessage 协议

```js
// [TH] iframe/adjust_viewport.js  全文 6 行
$('html').css('--TH-viewport-height', `${window.parent.innerHeight}px`);        // :1
window.addEventListener('message', function (event) {
  if (event.data?.type === 'TH_UPDATE_VIEWPORT_HEIGHT') {                       // :3
    $('html').css('--TH-viewport-height', `${window.parent.innerHeight}px`);
  }
});
```

发送方两处：`panel/render/Iframe.vue:35`、`panel/render/StreamingIframe.vue:28`——
`iframe_ref.value?.contentWindow?.postMessage({ type: 'TH_UPDATE_VIEWPORT_HEIGHT' }, '*')`。

**两条对父子化直接相关：**

1. **`--TH-viewport-height` 取的是 `window.parent.innerHeight`。**父子化后 message frame 的
   `parent` 变成 realm frame——**realm frame 若不是全视口，这个数就变了**，
   而它正是 `sandbox/viewport-units.ts` 重写 `min-height:100vh` 时指向的属性。
   **要对齐的定位关系就是这一个数。**
2. **通道不用发明**（`postMessage` + 一个 type 常量已存在），
   **但要决定父子化后"host"是 realm frame 还是外壳。**

### 六 · ⚠ 但 V1.5.4 根本不用那个变量——它用 `dvh`/`svh`

```
论坛覆盖层：  --TH-viewport-height = 0     TH_UPDATE_VIEWPORT_HEIGHT = 0
             100vh = 23   100vw = 6   dvh = 22   svh = 17
             window.innerHeight = 6（都是 window 自己的，不是 parent）
```

用法是**经典的三行降级阶梯**：

```css
.conn-page { min-height: 100vh; min-height: 100svh; min-height: 100dvh; }
```

**我们的重写在这条阶梯前是无效的，而且不是因为正则写错了：**

`viewport-units.ts:66` 的 `/min-height\s*:\s*(\d+(?:\.\d+)?)vh/gi` 要求数字后**紧跟** `vh`，
所以 `100dvh` / `100svh` **正确地不被匹配**（`100` 后面是 `d`/`s`）。
**但支持这两个单位的浏览器里，后两行会盖掉被我们重写过的第一行**——
**层叠的最后一条赢，而那一条解析的是 frame 自己的视口。**

*（`mentionsViewportHeight` 的 `/vh\b/i` 会被 `dvh` 命中，于是三次替换空跑一遍——
那正是该函数注释里预期的"假阳性只花三次找不到的替换"，无害。）*

**所以这一节的结论是两句，别只记住第一句：**

1. 上游有一个 `--TH-viewport-height` 通道，父子化后要重新对齐它指向的那个数；
2. **而现存最复杂的覆盖层卡根本不走那个通道**——它用 `dvh`/`svh` 直接向浏览器要视口。
   **对那类卡，"把变量指对"不够，得让 frame 自己的视口就是对的。**

*（另有 `calc(100dvh - 40px - env(safe-area-inset-…))` 的写法，
`env()` 的安全区在 frame 里同样是 frame 的，不是页面的。这一条我没有单独展开。）*

---

## 六之四、嵌套 iframe 里面是什么：**一个没有代码的文档**

**给「嵌套 iframe 虚拟化」当上游对照。**结论一句：
**那个 srcdoc 里没有 `<script>`，所以嵌套 frame 里不执行任何代码——它是纯 DOM。**
**没有 realm 要模拟，只有一个 document 要替身。**

### ① srcdoc 原文（全文，V1.5.4 论坛覆盖层）

```html
<!DOCTYPE html><html style="height:100%">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <style>html,body{margin:0;height:100%;background:#0e1028;color:#e8e2d6;font-family:sans-serif}
         html,body,#app{width:100%}body{overflow-y:auto}#app{min-height:100%}</style>
</head>
<body><div id="app"></div></body>
</html>
```

| | |
| --- | --- |
| `<script>` | **无** |
| `<link>` | **无** |
| `<style>` | **有一个**，**4 条规则**（155 字符），全是布局与配色 |
| `<meta viewport>` | **有**，`viewport-fit=cover` ——**这正是恢复扫描用的标记**（§二） |
| 挂载点 | `<div id="app">` |

### ② 谁往里挂东西，代码在哪个 realm

```js
.on('load', function () {
  const e = this.contentDocument;
  t.mount(e.querySelector('#app') || e.body);          // ← Vue 应用挂进嵌套文档
  nextTick(() => { a = new RA(e.head); a.start(); });  // ← 样式同步器写进嵌套 <head>
  $(e).on('keydown', e => { 'Escape' === e.key && GA() });   // ← keydown 挂在嵌套 document 上
})
```

**但 Vue 应用是在卡 frame 里创建的**（`createApp(xA).use(e())`，`xA` 是卡 bundle 里的模块级组件）。
**srcdoc 无 `<script>` ⇒ 嵌套 frame 里没有任何代码执行 ⇒
组件闭包里的 `window` / `document` 全是卡 frame 的，不是嵌套文档的。**

**`RA` 样式同步器**（`class RA`）：

```js
sync() {
  const e = [];
  for (const n of document.styleSheets) try { for (const t of n.cssRules) e.push(t.cssText) } catch {}
  const n = this.targetHead.ownerDocument;
  this.targetHead.querySelectorAll('style[data-style-sync]').forEach(x => x.remove());
  const t = n.createElement('style');                 // ← 用嵌套文档的 createElement
  t.setAttribute('data-style-sync', 'true'); t.textContent = e.join('\n');
  this.targetHead.appendChild(t);
}
start() { this.sync(); this.observer = new MutationObserver(…); this.observer.observe(document.head, { childList: true }) }
```

**读的是卡 frame 的 `document.styleSheets`，写的是嵌套文档的 `head`，观察的是卡 frame 的 `document.head`。**
**一个跨文档的单向镜像。**它用 `targetHead.ownerDocument.createElement` —— **虚拟化时
替身文档必须提供可用的 `createElement` 与 `ownerDocument`。**

### ③ 事件监听挂在哪

| 监听 | 挂在 | 出处 |
| --- | --- | --- |
| `keydown`（Escape 关闭） | **嵌套 document**（`$(e).on('keydown', …)`） | 上面那段 `load` 回调 |
| `resize` | **卡 frame 的 window**（组件 `onMounted` 里 `window.addEventListener('resize', …)`） | 组件闭包 |
| `message` / `pagehide` / `resize.forum-overlay` | **卡 frame 的 window**（`$(window).on(…)`） | 脚本主体 |

**全部四类里只有 `keydown` 挂在嵌套文档上，其余都在卡 frame 的 window 上。**

### ④ `contentWindow`：**零次**

`contentDocument` 出现 2 次（一次是上面的 `load` 回调，一次在 webpack **style-loader 的通用
helper** 里——那条分支因为卡把 `insert` 配成了 `'head'` 而不走）。
**`contentWindow` 全脚本 0 次，没有任何 postMessage 打进嵌套 frame。**

**所以虚拟化只需要替身一个 `document`，不需要替身 `window`。**

### ⚠ 一处更正：§三 那条 realm 不一致的**机制**是错的，结论不变

§三 我写的是：「overlay iframe 挂在宿主页面 → 它内部的 `window.parent` 是宿主 window；
而监听在脚本 frame 的 window 上，**两端不在同一个 window**。」

**「它内部」这个说法不成立——嵌套 frame 里没有"内部代码"。**
`window.parent.postMessage('toggle-forum-overlay','*')` 位于**组件的 setup 闭包**里，
而组件是卡 frame 的代码，**所以那个 `window` 是卡 frame 的 window**。

**正确的形状是**：**发送方与监听方在同一个 realm（卡 frame），
但一个 post 给 `parent`、另一个听 `self`。**

**结论（消息到不了）不变，机制换了一个。**

> **这条值得单记的是它怎么躲过复核的。**44 独立核过这一条并确认，
> 但他走的路径是「读 append 目标与 listener 的绑定对象」——
> **和我共享了同一个前提：「overlay iframe 里有代码在跑」。**
> **两条静态路径在那个前提上没有分叉，所以一致没有鉴别力**
> （`METHODS.md` §十九）。**拆穿它的不是第三次复核，是问了一个别的问题：
> "那个 srcdoc 里到底有什么"。**

---

### 六之四之二 虚拟化（替身 div + shadow root）要对齐的两件

**裁定**：卡 frame 内 `createElement('iframe')` 返回**带 shadow root 的 div 替身**。
下面两张表是它的上游对照。

#### 上游不感知：**替身 div 打断不了任何上游行为**

**ST 侧零命中**——`querySelectorAll('iframe')` / `getElementsByTagName('iframe')` /
`$('iframe')` / `HTMLIFrameElement` 在 `public/script.js` 与 `public/scripts/`
（排除 third-party 与 `lib/`）**全无**。

**TH 侧全仓只有两个观察者跑在卡 frame 内部，都不针对 iframe 元素：**

| 出处 | 观察什么 | 会不会碰到替身 div |
| --- | --- | --- |
| `iframe/adjust_iframe_height.js:47-50` | `ResizeObserver` 观察 **`document.body`** | **不会**——量 `body.scrollHeight` 写 `frameElement.style.height`，全程不看子 iframe。**且只注入界面/消息 frame，脚本 frame 没有** |
| `iframe/cleanup_protector.js:207-222` | `MutationObserver` 观察 **`window.document`**（`childList`+`subtree`），给新增元素打 `data-th-iframe-id` | **会打到，但只是加个属性**；且 **`use_cleanup_protector` 默认 `false`、用户实配也是 `false`**，这段根本不注入 |

其余七处观察者（`Dialog.vue:621`、`StreamingOne.vue:68/78`、
`use_collapse_code_block.ts:101`、`use_button_destination_element.ts:50`、
`PromptViewer.vue:196`、`MessageItem.vue:92`）**全在面板侧（ST 页面）**，够不到卡 frame 内部。

**上游对「卡 frame 内部有没有 iframe」这件事完全不感知。**

#### 四条规则的 host 映射

```css
html,body{margin:0;height:100%;background:#0e1028;color:#e8e2d6;font-family:sans-serif}
html,body,#app{width:100%}
body{overflow-y:auto}
#app{min-height:100%}
```

| # | Shadow DOM 里 host 指谁 | 注意 |
| --- | --- | --- |
| 1 | **`:host`**——`background` 画宿主盒；**`color`/`font-family` 会正常继承进影子树**；`margin:0` 挂 `:host` 有效（宿主外边距在外层文档） | **`height:100%` 不能只挂 `:host`**，见下 |
| 2 | `#app` **原样有效**（影子树内作用域）；`html,body` → **`:host`** | 无坑 |
| 3 | **没有对应物**——要给合成的 body 级包装，或 `:host{overflow-y:auto}` | **静默失效的那条**：缺了它覆盖层不能滚动，**无任何报错** |
| 4 | `#app` 原样有效 | **`min-height:100%` 要父元素有确定高度**；包装若是 `height:auto`，百分比按 `auto` 处理 ⇒ **没有最小高度** |

#### 四条压在同一条高度链上

真 iframe 里是 **`html(100%) → body(100%) → #app(min-height:100%)`——三级，每级都有确定高度**。
**Shadow DOM 默认没有这条链**：`:host` 之下直接就是影子树内容。

> **虚拟化要合成两级包装**（`:host` 当 `html`、一个内层元素当 `body`）**并把高度链接上**
> （`:host{height:100%}` + 内层 `{height:100%;overflow-y:auto}`），
> **否则第 1、3、4 条一起静默退化**——高度塌成内容高、不能滚动、`min-height` 失效，
> **而这三样都不报错。**

#### `load` 事件：**替身必须合成它，否则 V1.5.4 一行都不跑**

##### 谁真的建嵌套 srcdoc iframe：**只有一张卡**

22 卡里 `srcdoc` 或 `contentDocument` 命中的**只有三个脚本**，逐个读完之后：

| 脚本 | `srcdoc` | `contentDocument` | 实际在做什么 |
| --- | --- | --- | --- |
| **V1.5.4 / 论坛覆盖层** | 2 | 2 | **真的建嵌套 iframe**（§六之四） |
| 银麒赎世 / 手机UI | 6 | **0** | **全在注释里**——它自己跑在 srcdoc iframe 里，注释在说这件事 |
| 魔法少女 / 外置状态栏 | 5 | **0** | 同上（它是手机UI 的分叉） |

后两张的 `srcdoc` 出现处是这类注释：

```js
/* CSS类控制：移动端右边垂直居中（srcdoc iframe兼容） */
// 获取真实的视口宽度（支持DevTools设备模拟和srcdoc iframe）
// 在srcdoc iframe中，所有window尺寸都是0，必须使用父窗口尺寸
if (window.parent !== window) { … window.parent.innerWidth … }
```

**它们的 `onload` 也与 iframe 无关**——是 `FileReader.onload` / `Image.onload` /
`<img onload="this.style.opacity='1'">`。

> **所以「三张需同源 frame 的卡」这个说法要收窄成一张。**
> 另两张只是**运行在** srcdoc iframe 里，不建嵌套的。
> **（顺带：那条注释「在 srcdoc iframe 中所有 window 尺寸都是 0」是卡作者实测的环境事实，
> 也是它们读 `window.parent.innerWidth` 的理由——和 `--TH-viewport-height` 是同一个问题的两种自救。）**

##### V1.5.4 读 `contentDocument` 的时机：**只在 `load` 回调里**

```js
.on('load', function () {
  const e = this.contentDocument;                        // ← 唯一一次真正的读
  t.mount(e.querySelector('#app') || e.body);            // Vue 挂载
  nextTick(() => { a = new RA(e.head); a.start(); });    // 样式同步器
  $(e).on('keydown', e => { 'Escape' === e.key && GA() });
})
```

**赋 `srcdoc` 之后没有任何同步读。**
另一处 `contentDocument` 在 webpack style-loader 的通用 helper 里，那条分支不走（§六之四 ④）。

##### 所以「合成 `load`」不是可选项

**那一个回调里装着三件事的全部**：Vue 应用挂载、样式同步器启动、Escape 键绑定。

> **替身若不触发 `load`，这三件一件都不发生**——
> **不是"降级"，是覆盖层完全不存在，且没有任何报错**：
> iframe 替身建出来了、`srcdoc` 也设了、卡的代码跑完了，**只是那个回调从没被调用。**

##### ⚠ 关于「`load` 之前 `contentDocument` 是什么」——**我不当测量给出**

那是**浏览器语义，不是仓库行为**，这台机器上的源码里没有任何东西能证实或证伪它。

**能从代码读出的只有一条间接证据**：卡**从不同步读**，只在 `load` 里读。
这与「`load` 之前拿不到 srcdoc 文档」相容，**但它是作者规避出来的写法，不是观测**——
作者也可能只是照着习惯写。

**对替身的实际含义反而不依赖这个答案**：既然唯一的读点在 `load` 回调里，
**替身只要保证"`load` 触发时 `contentDocument` 已经可用"即可**，
**`load` 之前它是什么，没有消费者。**

*（若仍要确认，那是 7b 在我们自己实例上一分钟的事，不必去用户的 ST 上看。）*

#### 两条顺带的好消息，与一处未查

- **`dvh`/`svh`**（卡里 22+17 处，§六之三）：真 iframe 里解析嵌套 frame 的视口；
  虚拟化后没有嵌套视口，解析**卡 frame 的视口**——**方案 C 下那就是全视口，值相同。**
- **`env(safe-area-inset-*)`**（`calc(100dvh - 40px - env(…))`）：
  虚拟化后取的是卡 frame 的安全区，**比嵌套 frame 的更接近真实屏幕**。
- **未查**：srcdoc 的 `<meta name="viewport" … viewport-fit=cover>` 虚拟化后**没有对应物**，
  而 `viewport-fit=cover` 正是让 `env(safe-area-inset-*)` 返回非零的开关。
  **卡 frame 自己的 meta viewport 带不带它，我没验**——不带的话上面那条"更对"要打折。

---

## 六之五、两张卡的挂靶与出生时机（谁 append 到哪、什么时候可见）

§六之三 列的是**宿主要提供什么**。这一节列的是**卡实际怎么伸手去拿**——
因为两张卡拿的方式不一样，虚拟化要挡的东西也就不一样。

### 一 · 银麒赎世 / 手机UI：`$("body")`，落点由 `$` 的 realm 决定

```js
$("head").append(phoneStyles);                    // 样式
const triggerBtn = $("<button>", {
  id: "mobile-trigger-btn",
  html: '📱<span id="phone-float-badge" style="display:none;position:absolute;…">',
});
…
$("body").append(triggerBtn);                     // 浮动按钮
$("body").append(phoneOverlay);                   // 手机面板
setTimeout(() => { bindPhoneEvents(); }, 0);
```

**全脚本计数**：`$("body")` 22、`.append(` 37、`appendTo(` 1、`document.body` 9；
**`_pd.body` / `_pw.document` / `$p('body')` 全为 0**——
它**不**走 银麒系统面板 那套 `var _pw = window.parent || window` 的显式取父路径（§六之二）。
`#send_form` / `#sheld` 在全脚本 **0 命中**，`#chat` 也不是它的挂靶。

> **同一张卡的两个脚本用了两种取父方式**：
> 「银麒系统面板」显式 `_pw = window.parent || window` + `$p()`（§六之二），
> 「手机UI」只写 `$("body")`。
> **上游两者等价**（`parent_jquery.js` 让 `$` 就是父页面那份，见 UPSTREAM-FRAME-ORIGIN.md），
> **我们这里不等价**：frame 用自己那份 jQuery 时 `$("body")` 落到 frame 自己的 body。

### 二 · ⚠ 但同一脚本里有一处**显式**父路径，还带了理由

```js
// body（而不是 iframe 内），这样即使手机关闭弹窗仍可见
const targetBody = window.parent !== window ? $(window.parent.document.body) : $("body");
$confirm.appendTo(targetBody);          // ← 全脚本唯一一处 appendTo
```

这是「自定义确认弹窗」。**作者知道 frame 内和 frame 外是两个地方**，
但**只为这一个元素写了显式路径**，浮动按钮和手机面板留给了 `$` 的 realm 绑定。

**对我们的意思**：虚拟化如果只处理 `window.parent.document`，
会把这个弹窗接住、却漏掉按钮和面板（或者反过来）——
**两条路径要在同一个替身 document 上汇合**，否则同一张卡的三个元素会散在两层。

### 三 · 手机UI 的出生时机：三道门，两道是软的

```js
$(() => {
  (async () => {
    const MAX_WAIT_TIME = 30000, CHECK_INTERVAL = 100;
    while (typeof waitGlobalInitialized !== "function") {         // ① 轮询等函数出现
      if (Date.now() - startTime > MAX_WAIT_TIME) {
        console.error("[手机界面] 等待 waitGlobalInitialized 超时，尝试直接初始化");
        initializeMobilePhone(); return;                          // ← 超时也照建
      }
      await new Promise(r => setTimeout(r, CHECK_INTERVAL));
    }
    await waitGlobalInitialized("Mvu");                           // ② 再等 Mvu
    initializeMobilePhone();
  })().catch(e => { console.error("[手机界面] 初始化失败:", e); /* 即使出错也尝试 */ });
});
```

- **①（函数不存在）软**：30 秒后照建。
- **②（`await waitGlobalInitialized("Mvu")`）硬**：这个 promise 不 resolve，**界面永远不出现**，
  而且**不打日志**——和「卡坏了」在屏幕上长一个样。
  MVU 自禁用的那几条路（UPSTREAM-MVU-INIT-PATH.md §三之四/三之五/三之六）会**从这里**变成一块空白。
- **③（抛异常）软**：catch 里仍尝试。

> 所以「手机按钮没出来」这个现象，**在上游只有一个成因是沉默的**，就是 Mvu 没 ready。
> 验收时要能把这一条和「挂错 body」分开——两者都表现为按钮不在屏幕上。

**⚠ 我先写了「建议给 `waitGlobalInitialized` 加一条可观测」，这条要撤：我们已经有了，而且更强。**

`apps/iris-web/src/sandbox/frame.ts:1496` 与 `:1513-1521` 各 post 一条 `waiting`，
**带 `global` 名字**，第一条 `elapsedMs: 0` 立刻发，第二条在 `WAIT_NOTICE_MS = 5_000`
（`frame.ts:1229`）后补发用时；`script-run-state.ts:152-167` 把它渲成
`still waiting for Mvu (5s)`。`frame.ts:1508-1511` 的注释已经把取舍写清楚了——
**说出来，但不放弃等待**：上游对一次等待既沉默也从不放弃，这个帧不愿意沉默，
但「五秒后放弃」是上游没有的行为，不替上游发明。

**这条信号已经判过一次案**：协调者报，V1.5.4 的面板**没有**出 5 秒 still-waiting note，
**所以那次 Mvu 这道门是过的，零面积发生在「建之后」，不是「没建」**。

> 这正好是本节想要的那把尺：**沉默的成因（没 ready）和不沉默的成因（挂错层/零面积）
> 现在在屏幕上不再长一个样了。** 排障顺序应当反过来——
> **先看有没有 still-waiting note，没有就直接跳过 MVU 那一整支。**
> （教训归档：`grep-our-own-code-before-asking-upstream`——
> 「我们是不是该加 X」在问出口之前先 grep 自己的代码。）

### 四 · V1.5.4 / 论坛覆盖层：**没有 wrapper div**，且**一挂上就可见**

```
$('<div>') / $("<div>")  = 0        $('<iframe>')  = 1        appendTo(  = 1
```

iframe **直接 append 到 body**，中间没有包装元素。创建时的内联样式：

```js
$('<iframe>').attr({ frameborder: '0', srcdoc: '…' })
  .css({ position:'fixed', top:'0', left:'0', width:'100%', height:'100%',
         'z-index':'9999', border:'none' })          // ← 没有 display / visibility
  .on('load', …)
  .appendTo('body');
```

挂上之后**立刻**再钉一遍，七条全部 `!important`：

```js
const i = o[0];
window.__forumOverlayIframe = i;
i.style.setProperty('display','block','important');
i.style.setProperty('position','fixed','important');
i.style.setProperty('top','0','important');
i.style.setProperty('left','0','important');
i.style.setProperty('width','100vw','important');    // ← 不是 .css() 里那个 100%
i.style.setProperty('height','100vh','important');
i.style.setProperty('z-index','9999','important');
```

**结论：它不等任何按钮或事件，`_A()` 一跑完就是全屏可见。**
`GA()` / `WA()` / `jA()` 是**之后**的开关（`jA()` 设 `display:none !important`，
`WA()` 移除 `display`/`visibility` 再由 `OA()` 校正）。

**尺寸被设了两遍、单位不同**：`.css()` 里 `100%`，`setProperty` 里 `100vw`/`100vh` 且 `!important`
——**生效的是后者**。这就是 §六之三 说它对「frame 几何要对」敏感的地方：
`100vw`/`100vh` 量的是**它所在文档的视口**，虚拟化后那是卡 frame 的视口，不是屏幕。

### 五 · 两张卡的差别，一句话

| | 挂靶 | 显式取父？ | 出生门 | 默认可见 |
|---|---|---|---|---|
| 手机UI | `$("body")` / `$("head")` | 否（弹窗除外） | `await waitGlobalInitialized("Mvu")` | 是 |
| 论坛覆盖层 | `'body'`（`appendTo`） | 否 | `await waitGlobalInitialized('Mvu')` | 是，且 `!important` 钉死 |

**两张卡都卡在同一个 `waitGlobalInitialized('Mvu')` 上**，
**都不写 wrapper**，**都默认可见**——
所以「界面没出来」这个报障，第一个要排的永远是 MVU 有没有 ready，不是 CSS。

### 口径

- 语料：`E:/sillyTavern/SillyTavern/data/default-user/characters` 下 `银麒赎世`，
  与 `测试用卡/新增-20260902/V1.5.4_.png`，经 `decodeCardPng` + `extractScripts` 取脚本正文。
- 计数用 `s.split(n).length - 1`（子串计数，不过正则，见 METHODS 的反斜杠条）。
- **只读**：没有打开 ST，没有运行这两张卡，以上全部是静态读出来的。
  §七 那条「静态预测不是观测」同样适用于本节。

---

## 七、未查 / 只是预测

1. **§三那条 realm 不一致是静态读出来的预测，不是观测。**
   我没有运行这张卡（只读纪律）。**能廉价证伪它的观测**：打开覆盖层、
   点面板内那个切换按钮——**如果它能关掉覆盖层，我这条就是错的**，
   那说明我对 `$` 默认上下文或对 `$(window)` 绑定 realm 的判断有误。

   **在哪儿做这个观测**：**等 V1.5.4 进我们自己的浏览器验收时顺带读**，
   点的是我们的实例。**不在用户的 ST 上做。**

   > **一处更正（2026-09-03）。**初版这里写的是「这个观测不需要触发生成，
   > 所以不违反只读纪律」。**那个判据是错的**，是被我放宽了一档的版本。
   > 只读纪律的判据是**「凡有确认/保存/发送/改状态语义的交互都不碰」**——
   > 而**切换覆盖层就是改界面状态**。44 指出，纪律已统一为新判据。
   >
   > 留着这段而不是抹掉，是因为**放宽发生在一句听起来像在自我约束的话里**：
   > 「不违反只读纪律」这半句的语气是收紧的，被换掉的是它前面那个判据。
   > **一条纪律最危险的改写方式，是以援引它的形式做的。**
2. ~~**`xiaobaix-tasks` 扩展键里是什么，我没展开。**~~
   **已结**（44，2026-09-03）：**空数组，12 B**。而且 22 张卡里名单外的键**没有一个携带代码**。
   名单本身我也写错过，更正见 §一；两层结论见 §五之三 ③。
3. **`变量结构`（4,785 B）我只量了形状没读逻辑**，它和 MVU 的关系没查。
4. **事件总线那 61/60 个事件名我只取了首参的字面量**，
   其中有非字面量（变量）的注册点我没有解析，所以 **61/60 是下界不是全集**。
5. ~~**我没有和 44 的静态普查对拍**~~ **已结**，见 §五之三。
   **但对拍只覆盖三个点**（承重的 `appendTo` 计数、`xiaobaix-tasks`、realm 不一致），
   **其余数字仍是单路径**：键名清单、事件名计数、Vue/Tailwind 计数、字节数都没人复算过。
   §五之三末尾列了谁复核了谁。

6. **`document.body.contains` / `observe(document.body)` / `resize` 这三处在上游就是死码**
   ——这是 §三那条 realm 推断的推论，和它同生共死。**若那条被证伪，这三条也一并作废。**
   我把它们写成一组而不是四条独立发现，正是因为它们只有一个共同前提。
