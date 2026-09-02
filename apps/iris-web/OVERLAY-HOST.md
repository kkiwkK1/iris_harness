# 覆盖层宿主 —— 设计输入

**设计输入,不是实现。** 派单的问法是「覆盖层表面归谁、界面 frame 与脚本 realm 怎么共居」。
本文并排算三个方案的账,并把**「覆盖层能跑」与「`parent.Mvu` 能读」拆成两件事**——这是
本文最主要的结论,因为用户看得见的阻塞只是第一件。

## 口径

- 上游事实来自 3c(`OVERLAY-CARDS.md`、`UPSTREAM-*`),语料计数来自 44(`TEST-CARDS.md`),
  两者我逐条引用并注明,**没有自己复现**。
- 我自己量的只有两处,都标了 **[实测]**:不透明源 frame 里的 `localStorage`/`sessionStorage`/
  `indexedDB` 行为,和 `structuredClone` 的两种形状代价。
- 现状代码的引用是我读的,给了文件行号。
- **未验证**:三个方案里没有任何一个跑过。本文是账,不是读数。

---

## 一、要解的是什么

### 现场

两张卡现在「不渲染为空白」,而它们的脚本是活的:

```
绿茵好莱坞  3 of 3 loaded and listening   built 3 element(s) in a script frame (div, div, div)
不要被神隐  4 of 4 loaded and listening   built 2 element(s) (div, iframe)
                                          viewport is 0x150
```

`describeOverlayAttempt` 报的就是这件事:卡把界面建好了,建在一个**没人能看见的 frame** 里。

### 两条挂靶路线,判据不同 [44]

| 路线 | 卡 | 机制 | 全文有 `parent` 字样? |
| --- | --- | --- | --- |
| ① realm 绑定 | V1.5.4、创世回廊、状态栏 | `$('body')` / `.appendTo('body')` | **无** |
| ② 显式 parent | 银麒赎世 | 700 处字串选择器 + 18 处 `parent.document` | 有 |

> 44 的判据必须原样保留:**「只处理 parent 的实现在银麒上也会绿,但绿的原因不同」**。
> 所以验收双样本各判其路线。

### 卡真正依赖的 body 层挂靶,只有六个 [3c]

`body`(V1.5.4 appendTo,1 处)、`#chat`(MutationObserver 信号源)、
`#send_textarea` / `#send_but`(读写 value/disabled/click)、`#mes_stop`(`:visible`)。
**`#send_form` / `#sheld` 零命中。**

`.mes` 节点上卡碰的是 **HTML 属性**而非 `data-*`:`mesid ch_name is_user is_system
bookmark_link`,子结构碰 `.mes_text`(界面 frame 挂在里面)。**`mesid` 是位置性的,删楼/
交换时被上游重写**(`script.js:9411, 8319-8320`)——我们的楼层节点若带 `mesid` 也要照这条,
与 `@scope` 用候选序号同理。

### 三条上游事实,各自决定一件 [3c]

1. **`clearChat()` 只清 `#chat` 子节点与 `.zoomed_avatar`,body 层一个不碰**
   (`script.js:1584-1603`)。所以上游切聊天时覆盖层 DOM **残留且无人负责**。
   → 我们归零是**升级侧偏离**(不是「窄一级」),DEVIATIONS 记「上游残留、Iris 归零、
   理由:卡不清理而用户不该看到上一局的面板」。
2. **`adjust_iframe_height.js` 在界面 frame 内直接写 `frameElement.style.height`**(`:21`,
   整段空 catch 静默)。`frameElement` 跨文档访问自己的宿主元素**要求同源**。
3. **`adjust_viewport.js` 把 `--TH-viewport-height` 设为 `window.parent.innerHeight`**,
   并监听 `TH_UPDATE_VIEWPORT_HEIGHT` postMessage(`Iframe.vue:35`)。已有 host→frame
   推送协议,**不发明新的**,只决定谁发。

### 而「把变量指对」不够 [3c]

V1.5.4 论坛覆盖层**零处**用 `--TH-viewport-height`,它用经典阶梯:
`min-height:100vh` → `100svh` → `100dvh`(dvh 22 处、svh 17、vh 23),外加
`calc(100dvh - 40px - env(safe-area-inset-*))`。

我们的 `viewport-units.ts:66` 只重写 `vh`(**正确地**不匹配 dvh/svh)——但在支持 dvh 的
浏览器里后两行**盖掉**被重写的第一行,层叠最后一条赢,而它解析的是 **frame 自己的视口**;
`env()` 安全区同样是 frame 的。

> **结论:承载覆盖层的 frame 的实际几何必须就是全视口。** 这一条对下面三个方案都是硬约束,
> 也是它们之间唯一不能靠工程量弥补的差别。

---

## 二、三个方案

### 方案 C:**脚本 frame 自己就是覆盖层表面**(推荐,先做这个)

把 `useCardScripts.tsx:413` 那个挂点从

```jsx
<div aria-hidden="true" style={{ position:'absolute', width:0, height:0,
                                 overflow:'hidden', left:'-9999px' }} />
```

改成全视口固定层,frame 本身 `position:fixed; inset:0; pointer-events:none;
background:transparent`,`z-index: var(--iris-overlay-z, 40)`。

**为什么它便宜到值得先做**:

- 路线 ① **自动成立**:脚本 frame 的 `$` 本来就绑在它自己的 document 上,`$('body')` 落在
  那个 body——而那个 body 现在就是全视口表面。**零新管线。**
- 路线 ② **也自动成立**:虚拟 `parent.document` 已经指向这个 frame 的 body
  (`srcdoc.ts:210`),不用改指。
- **全视口几何真的成立**,所以 §一末那条(dvh/svh/env 阶梯)满足,不是靠重写变量。
- `--TH-viewport-height` = `parent.innerHeight` 也对(parent 是 shell,shell 就是全视口)。
- 三个 ST id 锚点、生成状态三条腿、`#chat` 信号:**与方案无关**,在任一方案下都是同一份活。

**代价,逐条**:

- **脚本 frame 从此可见。** 今天它是隐藏的,而 `describeOverlayAttempt` 这套仪器正是建立在
  「这里画的东西没人看见」之上。可见之后,卡误建的东西会真的出现在屏幕上。
  → 那条报告要改口径(从「你画在看不见的地方」改成「你画了什么」),不能留着说反话。
- **一卡一个全视口层**,而上游是一个共享 body。两张卡各一层 → 跨卡节点互不可见,而上游可见。
  → 记账。`pointer-events:none` + 透明底可以让它们叠着不互相挡,但**上下顺序是加载顺序**,
  上游是 DOM 顺序,细微差别,记账。
- **不解决 `parent.Mvu`。** 界面 frame 仍是脚本 frame 的兄弟,`published` 仍是 per-frame。
  8 张在界面代码里读 `Mvu`/`window.Mvu` 的卡 [44] 的界面仍然读不到——而其中 7 张走
  `waitGlobalInitialized`,**会一直等**。它们带一条具名 note 活着。

### 方案 A:realm = 承载覆盖层表面 + 阅读区的常驻全视口 frame(最终答案,不是现在)

脚本 frame 与界面 frame 都是它的子;子 frame 继承同一个不透明源 → 与 realm 同源 →
`parent.Mvu` 原生同步可读,`predefine.js` 那个
`Object.defineProperty(window,'Mvu',{get:()=>_.get(window.parent,'Mvu')})` 直接照抄成立。

**它对的地方**:

- 唯一真正解 `parent.Mvu` 的方案。按名异步代理**已被判出局**:界面代码读到 `parent.Mvu` 后
  **同步**把 `Mvu.events.VARIABLE_UPDATE_ENDED` 交给 `addEventListener`,Promise 会把监听器
  注册到 `"[object Promise]"` 上,**永不触发且不报错** [44]。
- 界面 frame 与文字**同一个 document**,所以内联面板不需要投影:原生裁剪、原生层叠、
  高度回报直接触发同文档回流。
- `frameElement.style.height`(§一 事实 2)成立:realm 与消息 frame 同源。
- `parent === top` 的账是**零风险轴** [3c]:22 卡脚本正文里 `parent === top` /
  `parent.parent` / `top.document` **全 0**,`window.top` 仅 2 处且都在带 catch 的找-Mvu
  兜底链里——父子化后 `parent` 那一环先命中,`top` 不会被求值。

**代价,逐条(这是本项目最大的一次结构改动)**:

- 阅读区(React 渲染、窗口化、高度仪器、内联 HTML 消毒、DOMPurify、`@scope` 卡 CSS)
  **全部搬进一个不透明源 frame**。
- shell 与阅读区之间**一切交互变成 postMessage**:选中、编辑、swipe、滚动定位、主题令牌。
- 安全边界要重画(见 §四)。
- 迁移不可能一步(见 §六)。

### 方案 B(对照):独立覆盖 realm + 阅读区留在 shell + 投影定位

覆盖 realm 是全视口 fixed frame,只承载覆盖层表面并作为脚本/界面 frame 的父;阅读区留在
shell;realm 内 `#chat` 只做信号(每新楼层追加一个空 `.mes` 节点,带位置性 `mesid`);
内联界面 frame 由 realm 按 shell 上报的槽位矩形投影定位。

**它对的地方,而且比我先前一句话打发的要多**:

- **`#chat` 只做信号是站得住的**:3c 核过它的**实际消费只有 MutationObserver childList**
  (§六之二),判据是「新增节点带 class `mes`」。一个空 `.mes` 存根真的满足它。
- **覆盖层卡不需要投影**:它们挂 realm 的 body,不挂槽位 frame。所以 §一末那条全视口约束
  在 B 下**也满足**——这一点 3c 明确指出,我先前的表述漏了它。
- 阅读区不动 → 迁移小,shell 的安全边界不变,React/DOMPurify/窗口化原地不动。
- `parent.Mvu` 也解了(界面 frame 是 realm 的子)。

**代价,写成具体失败形状而不是一句话**:

1. **滚动期的错位。** 内联界面 frame 的位置是 shell 量的矩形经 postMessage 到 realm 再
   绝对定位。数量级:数量闸 16 个活 frame,滚动按 rAF 批处理也是**每帧一条消息带 16 个矩形**;
   realm 的定位比 shell 的绘制**至少晚一帧**。失败形状不是「慢」,是**面板相对文字滑动**——
   经典的覆盖层拖影。这是 B 唯一无法用工程量消除的代价,因为它是两个文档各自绘制的必然。
2. **裁剪要复制一份真相。** 消息 frame 必须被阅读区滚动容器裁掉。realm 里那是另一个文档,
   要复制滚动视口矩形并对每个 frame 施加 `clip-path`。可做,但**每个矩形都是第二个真相源**,
   而这个项目已经付过「两份真相各自正确、合起来错」的学费。
3. **高度回报多两跳。** 今天:frame 报高度 → shell 回流。B 下:frame → realm → shell →
   新矩形 → realm。而高度变化很频繁(字体加载、图片解码)。
4. **层叠只有一个方向。** 投影的 frame 永远在 shell 文字之上(另一个文档、fixed 层),
   文字无法压在面板上。今天也是如此(frame 就在文字之上),**所以这条不算回归**。

---

## 三、对照表

| | C 脚本 frame 即表面 | A realm 含阅读区 | B 独立 realm + 投影 |
| --- | --- | --- | --- |
| 路线 ① realm 绑定 | **自动** | 自动 | 自动 |
| 路线 ② `parent.document` | **自动**(已指对) | 改指 | 改指 |
| 全视口几何(dvh/svh/env) | **成立** | 成立 | 成立 |
| `parent.Mvu` | **不解** | 解 | 解 |
| `frameElement.style.height` | 不涉及 | 成立(同源) | 成立(同源) |
| 内联界面 frame 定位 | 不涉及 | **原生** | **投影(拖影)** |
| 阅读区搬迁 | 无 | **全部** | 无 |
| shell↔阅读区通信 | 不变 | **全部 postMessage** | 不变 |
| 新的真相源 | 0 | 0 | **每帧 16 个矩形** |
| 改动规模 | 一个 style + 一条报告口径 | 最大 | 中 |

---

## 四、① 什么留在 shell(安全边界)

**规则:任何宿主源的数据不进 realm。** 具体:

- **留 shell**:作曲器(它持有草稿与发送权)、设置、连接配置、**API key**、角色库、
  `debug.reports` 面板。
- **进 realm**(A 方案下):阅读区的渲染与其消毒管线、卡 CSS 的 `@scope`、frame 预算。
- **判据**:realm 是不透明源,但它与它的子 frame **同源**——这正是 `parent.Mvu` 能成立的
  原因,也意味着**任何进入 realm 的东西,卡的脚本 frame 都能读**。所以 key 与连接配置进
  realm 等于交给卡。这一条在 A 方案里是**新的**攻击面,今天不存在。
- 三个 ST id 锚点(§一)在 A 下要跨边界:`#send_textarea` 的值与 `#send_but` 的点击必须
  从 realm 走 postMessage 回 shell 的作曲器。**这使 A 的「卡能代替用户发消息」这条路多一跳,
  但性质不变**(仍是上游本有的卡功能 + 一条 note)。

## 五、② 入口与 bundle 预算

A 方案下**两个入口两个 bundle**:`shell.html`(作曲器/设置/侧栏)与 `reading.html`
(阅读区 + 覆盖层表面 + realm 全局)。

- 阅读 bundle 里有 React、DOMPurify、消毒与 `@scope` 管线;shell bundle 里有 store、
  连接、设置。**store 会被两边都要**,所以它要么复制(两份状态)要么单向(shell 权威 +
  postMessage 投影)。**只有第二种可接受**,第一种就是 §二 B 的「两个真相源」搬进 A。
- realm 还要加载 **message preset(1.66 MB,script preset 的超集)** [44],因为 V1.5.4 是
  SCRIPT-DOM 而它的 Tailwind 落不到 script preset。按 URL+hash 缓存,整页付一次。
- `FRAME_OVERHEAD_BYTES` **不变**:子 frame 的 bootstrap 仍逐个内联。realm 多一份。
  **未量**:子 frame 的 srcdoc 内联是否仍不走缓存——可在真 frame 里量,和其余浏览器常数一批。

## 六、③ 迁移分步(每步单独验收、每步树保持绿)

1. **方案 C**:脚本 frame 变全视口表面 + `describeOverlayAttempt` 改口径。
   验收:V1.5.4 覆盖层出现在视口上、能点开;greeting 那个「·」照常渲染。
2. **三个 ST id 锚点 + 生成状态三条腿 + `#chat` 的 `mes` class/`mesid`**。
   验收:银麒赎世系统面板新楼层后 100 ms 重注入、生成中冻结。
3. **切/关聊天归零表面**(A7)。验收:切卡后不残留上一局面板。
4. — 到这里用户看得见的阻塞已经清空,`parent.Mvu` 那 8 张卡的**界面**仍带 note。 —
5. **realm 骨架**:建 `reading.html` 入口,只渲染一个空阅读区,shell 用 postMessage 投影
   store。验收:能开一局、能读、能滚动;作曲器仍在 shell。
6. **搬窗口化与高度仪器**,再搬消毒管线。每步都有既有测试当护栏。
7. **脚本/界面 frame 改挂 realm**,`parent.Mvu` 通。验收:8 张卡的界面读到 `Mvu`。

## 七、④ 新结构下的高度仪器/窗口化/预算

- **高度仪器**:A 下不变——消息 frame 与它的宿主元素同源同文档,`heightSignal` 那套照旧,
  而且 `frameElement.style.height` 这条上游路径也通了。
- **窗口化**:三层不变(传输/挂载/字节)。realm 常驻,界面 frame 随窗口挂卸——**这正是
  「注入与发布随聊天会话存活」想要的生命周期**,与 `injectPrompts` 的作用域同一条。
- **`FRAME_OVERHEAD`**:见 §五。数量闸语义不变。

## 八、⑤ realm window 上必须齐的名字,以及缺名怎么报

`predefine.js` 的 `_(window).merge(_.pick(window.parent,[EjsTemplate, TavernHelper, YAML,
showdown, toastr, z]))` 假定 parent 是 ST 页面。父子化后 parent 是 realm。[3c]

- **缺名的行为**:`_.pick` 略过 → 名字不存在 → **裸引用 `ReferenceError`,但 `typeof X` 是
  `'undefined'` 不抛**。与 `localStorage` 那条**相反**,别套同一结论。
- **三处无守卫硬依赖**:`predefine.js:1` 的 `parent._`(缺则 `:11` TypeError,整段引导消失)、
  `:15` 的 `parent.TavernHelper._bind`(同样整段消失)、`parent_jquery.js` 的 `parent.$`
  (缺则 `predefine` 末尾 `$(window).on('pagehide')` 抛)。
- **失败形态是静默**:frame 建了、引导跑一行就抛、宿主看不到。
- **裁定,当设计的一部分而不是事后检查**:realm window 上保证 `_`、带 `_bind` 的
  `TavernHelper`、`$`、以及那六个名字齐;**界面 frame 的引导若从 parent 取任何名,缺一个就报
  一条具名 fault**,而不是在 frame 里抛。

## 八之二、验收判据:哪些红点该消失,哪些不该

父子化的收益必须能被**数**出来,而不是「感觉通了」。44 给的判据用创世回廊:

> 父子化后创世回廊只剩 **`phone` 一个**红点(它的远程模块 404,写方真不存在),
> **`calc` / `statusbar` 两个红点消失。**

这条判据好在它**两个方向都有**:一个不该消失的红点留在那里,证明消失的那两个不是因为
诊断被关掉了。

**为什么这两个红点今天在**,值得写清,因为它一度被误诊成别的东西:创世回廊两个脚本写
`(window.parent || window).__X_loaded__ = true`(都在 try 内),而面板对同两个名字报
「nothing has published in this frame」。三个候选查过:

1. ~~读先于写(轮询)~~ —— 部分成立但不是全部。
2. ~~`window.parent` 不是虚拟 parent~~ —— **[实测] 排除**。在不透明源 frame 里
   `window.parent` 的描述符是 `get/set` 且 `configurable: true`,重定义之后**裸 `parent`、
   `window.parent`、`self.parent` 三种拼法全部**指向虚拟对象,**两种拼法的写都落在它上面**。
   (`window` 自己不可重定义 —— `TypeError: Cannot redefine property: window` —— 这正是
   `publishGlobals` 过滤掉三个 window 别名的原因;但 `parent` 是同一个属性,所以不影响。)
3. **拓扑,不是名字** [44]:读方在**界面代码**(`getWin(){return window.parent||window}`),
   写方在**脚本 frame**,两端拼法一致。上游两种 frame 共一个 parent,我们各自一个。

> 所以这两个红点与 `parent.Mvu` 是**同一个前提**,不是新机制。两端各有静默兜底(写失败改写
> 到自己的 window、读失败当未加载),所以卡界面那个「依赖未加载」的红点**指向错因**——
> 这是本文档里第二个「诊断把读者送错方向」的实例。

**一条已经落地的部分缓解,不要误读成修好了**:同一个 frame 内,一个曾被报为「无人发布」
的名字后来被发布时,frame 现在会追发一条「has since been published」把前一条注销。它修的是
**报告的时效**(一个关于某一刻的判断被面板显示成常态判断),**不是拓扑**——跨 frame 的读写
仍然各自看着自己的 parent,`calc`/`statusbar` 两个红点要靠父子化才会消失。

## 九、未定 / 未查

1. **三个方案都没跑过。** 本文是账。
2. **子 frame 的 srcdoc 是否仍不走缓存**未量(§五)。
3. **投影拖影的实际幅度**未量:我给的是机制(晚一帧)而不是像素数。要反驳 B 的这一条,
   量它比论证它便宜。
4. **两张全视口覆盖层叠放的上下顺序**在 C 下是加载顺序,上游是 DOM 顺序。差别未量。
5. **A 方案里 realm 与卡同源带来的新攻击面**只在 §四 点名,没有做威胁建模。
6. `#chat` 的 `mesid` 在删楼/交换时的重写,我们这侧还没有对应机制。
