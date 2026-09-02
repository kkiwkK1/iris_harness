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
- **未跑**：全部是**静态读**。我没有运行这张卡（只读纪律：不触发生成）。
  §七 标出哪几条因此只是**预测**而非观测。

---

## 一、卡的结构

扩展键：`talkativeness, fav, world, depth_prompt, regex_scripts, tavern_helper, xiaobaix-tasks`

**`xiaobaix-tasks` 是我们已知集合外的第三个脚本承载键**（我们认的是 `tavern_helper` /
`TavernHelper` / `regex_scripts`）。本卡的四个脚本都在 `tavern_helper` 下，
`xiaobaix-tasks` 里是什么我没展开（§七）。

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
| 1 | **`$` 是宿主页面的 jQuery**，字符串选择器落在页面上 | `parent_jquery.js` 全文两行 | **不成立**。我们在 frame 内装自己那份 jQuery（预设里的 3.5.1），`$('body')` 落在 **frame 自己的 body**。 |
| 2 | 脚本 frame 隐藏，可见界面必须挂到页面 | `Iframe.vue:2` `v-show="false"` | **前提不同**：我们的 frame 本身就是可见表面。 |
| 3 | `position:fixed; 100vw/100vh; z-index:9999` 能覆盖整个应用 | 挂在页面 body 上时成立 | **不成立**。frame 内的 `fixed` 相对 **frame 的视口**。卡里 `position:fixed` 49 处、`100vh` 23 处、`100vw` 6 处。 |
| 4 | `document`（裸）= frame 自己 | `createSrcContent` 用 `<script type="module">`，无人重定义 | **成立**，且我们相同。 |
| 5 | overlay iframe 的 `window.parent` = 挂载它的那个 window | 浏览器语义 | **成立**，但**指向谁**随假设 1 变。 |
| 6 | 事件总线跨脚本可达、按 frame 分区 | TavernHelper 注册表 | **`COHABITATION.md` 已处理**：`eventEmit` 是共居下的既定例外，卡内广播正是本意。 |
| 7 | `TavernHelper` 成员缺失时是「不是函数」 | 卡自带 `typeof` 探测 | **不成立**：我们的缺失是**具名抛出**。 |
| 8 | 自带 `pagehide` 清理 | 覆盖层脚本含 `pagehide` | **顺带一条上游事实**：`iframe.ts:13` 的注入条件是 `use_cleanup_protector && !content.includes('pagehide')`，**这张卡因为自己写了 pagehide 而永远拿不到保护器**。而这台机器上 `use_cleanup_protector: false`（我读的 `settings.json`），**本来也没开**。 |

**假设 1 是根，2/3/5 都挂在它下面。**

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

## 七、未查 / 只是预测

1. **§三那条 realm 不一致是静态读出来的预测，不是观测。**
   我没有运行这张卡（只读纪律）。**能廉价证伪它的观测**：在上游装这张卡、打开覆盖层，
   点面板内那个切换按钮——**如果它能关掉覆盖层，我这条就是错的**，
   那说明我对 `$` 默认上下文或对 `$(window)` 绑定 realm 的判断有误。
   **注意这个观测不需要触发生成**，所以不违反只读纪律；但它要用户的 ST，不是我该做的。
2. **`xiaobaix-tasks` 扩展键里是什么，我没展开。**它是我们已知三个脚本承载键之外的第四个。
3. **`变量结构`（4,785 B）我只量了形状没读逻辑**，它和 MVU 的关系没查。
4. **事件总线那 61/60 个事件名我只取了首参的字面量**，
   其中有非字面量（变量）的注册点我没有解析，所以 **61/60 是下界不是全集**。
5. **我没有和 44 的静态普查对拍**——总指挥说他会发我，到时并进来。
   在此之前，**上面所有数字都是单路径的，没有佐证**。
