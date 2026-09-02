# 验收语料地图

这份文件回答一个问题:**手上每张卡能测到什么,测不到什么。**

它只记**形状**——脚本条数、正则位置、成员用法、体积、外链域名。不记卡的内容。卡名与作者
是卡文件里的公开元数据,保留,因为验收时要靠它们指认对象。

**全部数字都是卡内静态形状,不是渲染后的形状。** 这道缝付过学费:爱衣那张卡渲染前是 3837
字符纯文本、渲染后是 13359 字符完整文档,同一楼、只差一个 `isMarkdown` 开关。所以
**「渲染前」和「渲染后」是两个对象**,这份文件只覆盖前者;三张新卡进 dev 数据目录之后
需要另量一次。

口径:全部经 `decodeCardPng` / `normalizeCard` / `extractScripts` 读,不手搓 PNG(语料在
多种形状下存储,手写遍历在这件事上错过三次:222、22、真值 47)。成员命中用**任意收者**
边界,含局部别名(`th.generate`)与窗口跳(`window.parent.TavernHelper.x`);已建集合取自
`apps/iris-web/src/sandbox/identity.ts` 的 `MEMBER_KINDS` 中标 `identity`/`shared` 的条目,
与 `scripts/th-member-census.mjs` **同源**。

---

## 一、既有 19 卡

在 `E:/sillyTavern/SillyTavern/data/default-user/characters/`。已有的普查不在这里重复:

- 成员用法:`npm run census:th-members`(`scripts/th-member-census.mjs`)
- 前端块 / frame 楼:`npm run census:frontend-blocks`
- 世界书来源与重复:`scripts/worldbook-source-census.mjs`
- 脚本按钮:`npm run census:card-scripts`
- 渲染后的 frame / 片段分布、`<pre>` 归属:见 `apps/iris-web/RENDER.md` 与
  `apps/iris-web/INLINE-HTML.md`

一句总结这批的形状:**所有 frame 楼都来自 display 正则展开**,界面由正则生成、由文档标记
识别。下面那张 `V1.5.4_` 是第一张不属于这一族的卡。

---

## 一之二、族图

用户的纪律(2026-09-03 原话):

> 我们并不是针对某一张卡优化,而是要追求做到每一种卡都可以像放在 ST 里面一样正常可以跑。

所以这份地图按**族**排,不按卡排。一个族 = **界面到达屏幕的一条路径**,因为那才决定我们
哪段代码会跑;卡讲什么无关。**一张卡可以同时属于几个族,那正是重点**——要回答的是
"每个族有没有代表",不是"这张卡是什么"。

### 主轴:界面从哪来

两栏是刻意分开的:**「见」= 它的真实聊天里确实产出过这个形状;「能」= 卡的静态形状说它
可以产出**。合并这两栏是第一版的错——**验收需要一张真的产出该形状的卡,不是一张有可能
产出的卡**。实测:好几张卡带着产界面的正则却从未产出 frame 楼,因为模型从没吐出那些正则
要匹配的文本。

| 族 | 见 | 能 | 代表 |
|---|---|---|---|
| `FRAME-FENCED` 正则产完整文档、在 ``` 围栏内 | **18** | — | OVERLORD、创世回廊、可攻略女主、命定之诗、爱衣… |
| `FRAGMENT` 正则产块级 HTML、无 `html/head/body` | **5** | — | 命定之诗(887 楼)、银麒赎世、暗渊、爱衣、希尔 |
| `TEXT-ONLY` 全程无界面 | **5** | — | Assistant、缄默之秋、战锤群星闪耀 |
| `GREETING-DOC` 卡自己的 `first_mes` 已带文档 | **0** | 3 | 灭仇、干物吸血鬼少女、2.1.0 |
| `SCRIPT-DOM` 无产界面正则,脚本自建 DOM | **0** | 2 | V1.5.4_ |
| `FRAME-BARE` 完整文档、不在任何 `<pre>` 内 | 1 | — | **没有正当代表**,见下 |

**那两个 0 是定义造成的,不是缺口**:

- `GREETING-DOC` 渲染后**塌进 `FRAME-FENCED`** ——文档来自哪里是**来源**的区别,渲染后
  的形状一样。它的 0 说明"见"这一栏量不了来源,不说明没有卡。
- `SCRIPT-DOM` **按定义不经过消息文本**,所以"渲染后的消息文本"这把尺子对它**必然量到
  0**。V1.5.4 的楼渲染前 1 字符、渲染后 1 字符,那是**这条路的性质,不是失败**。

**这两族的验收需要另一把尺子**(前者比对 `first_mes` 与存盘首楼,后者读脚本注入与 DOM),
消息文本那把量不到它们。

**`FRAME-BARE` 没有正当代表。** 它唯一的"成员"是 `希尔` 的 5 个楼层位置,而逐条读过原文:
那是**模型把自己的输出格式要求背进了正文**,里面的文档是模板,而且那个 ` ````html ` 在行
中间(CommonMark 的围栏必须在行首),所以上游也不框它们——**跳对了**。全语料**零个真正
无围栏的完整文档**。所以这一族目前是空的,而这是好消息:判据可以按"在 `<pre>` 内"定,
不必为无围栏文档留后门。

### 副轴:卡自带的 ESM 依赖

阻塞性不同,所以分列。**取不到时:`BINDING` 让整个脚本模块一行都不执行,`SIDEEFFECT` 只
让那个库不可用。**

| 卡数 | 来源 | 类型 | 我们的 preset 有吗 |
|---|---|---|---|
| **15** | `gh:MagicalAstrogy/MagVarUpdate` | `SIDEEFFECT` | 无 → 冷取 |
| **13** | `gh:StageDog/tavern_resource` | **`BINDING`** | 无 → 冷取 |
| 1 | `pinia`(`/npm/pinia/+esm`) | `BINDING` | 无 → 冷取 |
| 1 | `gh:tangquanghuy/dnf` | `SIDEEFFECT` | 无 |
| 1 | `gh:The-poem-of-destiny/…` | `SIDEEFFECT` | 无 |
| 1 | `gh:vincentrong2005/Fatria` | `SIDEEFFECT` | 无 |
| 1 | `http://localhost:5500/dist/…` | `SIDEEFFECT` | **白名单外,且永远取不到** |

preset 现有(读自 `apps/iris-web/src/sandbox/preset-entry.ts`):`jquery` `vue` `lodash-es`
`yaml` `zod`。**上表七个来源里只有 `pinia` 是"库"**,其余全是卡生态的 GitHub 资源——
所以"把库预置进 preset"这条路只解 1 张卡,15 卡和 13 卡那两条要的是卡生态 URL。

**13 张卡的启动路径上有一个阻塞的跨域 ESM 取数**(`变量结构` 脚本里的
`import{registerMvuSchema as e}from'…'`)。V1.5.4 那 9–12 秒的形状有 13 张同类。

`性斗学园超级重制版` 那个 `localhost:5500` 是**出厂卡里打进了开发服务器地址**:在任何用户
机器上都失败,而且失败形状和冷取超时一样。**验收要能把这两种分开报**,否则会去修一个修
不了的东西。

唯一做了 CDN 冗余的卡是 `2.1.0`:两处 `import()` 动态导入同一个 bundle 的 `testingcf` 与
`cdn` 两个域名,互为兜底。全语料只有它这么写。

#### 按地址而不是按包数一遍(`scratchpad/distinct-cdn.mjs`)

上表按**包**聚合成 7 行。按**地址**去重是另一把尺子,因为任何"列一张名单"的修法都是
按地址列的,不是按包列的:

- **去重后 11 个互不相同的完整 URL**,归约成 **9 条 path**、**3 个 host**。
- **22 张卡里 16 张至少有一个 CDN import**,6 张一个都没有。

两个自由维度决定这份名单能撑多久,它们比 11 这个数本身更要紧:

- **host 自由**:两条 path 各自挂在 `testingcf` 和 `cdn` 两个域名下
  (`mvu_zod.js`、`MagVarUpdate/artifact/bundle.js`),同一个东西两个地址。
- **版本自由**:同一个 repo 同时以 `@beta` 和无 tag 两种形式出现;**11 个 URL 里 6 个
  完全不写版本**,jsdelivr 直接发 HEAD。也就是说**没有任何一张卡改动,一份枚举出来的
  名单也会自己过期**。"可枚举"和"枚举后保持有效"是两件事。

**这 11 个是下界,不是全集。** 本表只读卡内脚本正文(`extractScripts`),而 **11 个地址
11 个都指向远程模块**,它们各自 import 什么这里看不见。缺口有边界:**内联 bundle 是可见的**
(V1.5.4 的 `pinia` 就是从卡内 990 KB 内联 bundle 正文里抓到的),看不见的只有**远程**
artifact 的内部依赖。

顺带一条关于鉴别力:这个数在**顶层卡内 import** 那一层上成立,而"名单"与"按 URL 模式
拦截"两类修法**在这一层的行为相同**——它们分叉在**传递依赖**那一层,恰好是这里测不到的
那层。所以 11 这个数**排除了**"几十上百个各不相同",但**不构成**"名单够用"的证据。

### 副轴之二:上游界面 frame 预置、我们没有的那几样,各砸到谁

3c 查出上游界面 frame 比我们多预置 Tailwind、Font Awesome CSS、jQuery UI + touch-punch、
VueRouter、showdown。下表量的是**语料里谁会因此坏掉**,给 7b 定补的顺序。
命令 `node scratchpad/deps-census.mjs` / `deps-selfhosted.mjs`。

**先把口径钉住:覆盖是按 frame 种类算的,不是按卡算的。**
`message-preset-entry.ts:70` 里 `import './preset-entry.ts'` —— **message preset 是 script
preset 的超集,反过来不成立**,而且那份文件的头注释写明这是刻意的:「a script frame has no
interface to draw」。所以下表的「需要我们补」= **该卡画界面的那个 frame 里没有**。

| 差集 | 命中卡 | 我们已预置 | **仍需要补** | 观察到的族 |
|---|---|---|---|---|
| **Font Awesome** | **6 / 22** | message frame(6.5.2,base+solid+brands+regular+**v4**) | **0**,待 7b 实测确认 | FRAME-FENCED ×4、FRAGMENT ×2、FRAME-BARE ×1(+1 无观察族) |
| **Tailwind** | 2(字面)/ 1(utility) | message frame(4.1.12) | **1 —— V1.5.4_,恰好是 SCRIPT-DOM** | FRAME-FENCED ×1 + SCRIPT-DOM ×1 |
| **showdown** | 2 / 22 | 无 | **2** | FRAME-FENCED ×1(+1 无观察族) |
| jQuery UI | **0** | 无(但 `jquery-plugin-gap.ts` 会报缺) | — | — |
| VueRouter | **0** | 无 | — | — |

命中明细(记 population,因为坏的时机不同:`regex`/`script` 是建界面时就坏,`floors` 只影响
已存在的对话):

- **Font Awesome**:创世回廊1.3(regex)、魔法禁书目录(regex)、魔法少女的扣扣审判1.0
  (regex+script)、魔法少女是不会败北恶堕的吧!(regex)、希尔(regex)、银麒赎世(script)
- **Tailwind**:创世回廊1.3(regex,字面 + utility)、V1.5.4_(script,字面)
- **showdown**:魔法少女的扣扣审判1.0(regex)、萧谴写卡助手版_V4.5.1(regex)

**类名前缀全部兼容**,已逐卡核过:卡用到的是 `fa-solid` `fa-regular` `fa-brands` `fas`,
我们 ship 的 `fontawesome+solid+brands+regular+v4-font-face` 全覆盖(v4 那份让裸 `fa` 前缀
也能解析)。**没有任何一张用 Pro 专有前缀**(`fal`/`fad`/`fa-light`/`fa-thin`/`fa-duotone`)。

#### 「自带」不等于「自足」——但这次结论是反的,记下来是因为形状值得记

6 张 FA 卡**全部自己注入 `<link>`** 到 `cdnjs.cloudflare.com/…/font-awesome/6.x/css/all.min.css`,
而 `REMOTE_ALLOWLIST` 只有 `*.jsdelivr.net` 和 `raw.githubusercontent.com`,**cdnjs 不在里面**;
`font-src data: https://fonts.gstatic.com` 且**不随授网放宽**。照这条读,卡自带的那份两种模式
都拿不到 —— 我据此写过「授网也救不回来」。

**那句是错的,因为对象错了:拿不到的是卡自带的那份,而不是图标。** 我们自己在 message
frame 里预置了 FA 6.5.2,图标由预置供给,卡那条 `<link>` 挂掉是无害的。**不扩 allowlist,
机制上由预置覆盖。**

> 留下来的教训是那个前提:**「卡自带」只在宿主放行时才等于「自足」,而「宿主没放行」也只有
> 在宿主自己没有预置时才等于「坏」。** 两步推理,我把第一步查实了就当第二步也成立。

**待定稿**:卡自带的 `<link>` 被 CSP 拒是**要报 note** 的(用户会看到一条被拒记录,而界面
其实是好的),报法待 7b 在创世回廊上实测图标是否有字形后定。两张会先探测
`$('link[href*="font-awesome"]').length` 的卡(魔法少女的扣扣审判1.0、银麒赎世)**预置之后
它们的加载器自动变成空操作**——它们本来就照「宿主可能已提供」写的,所以验收时「卡自己的
loader 没跑」是正常现象。

#### 实测前必须知道的两个混淆源

**① 5 / 6 张卡引用了 FA Free 里根本不存在的图标名**,与预置无关,与 allowlist 无关,
**空框是它们本来就有的缺陷**——但在截图里和「预置没生效」长得一模一样:

| 卡 | 用到图标 | Free 6.5.2 没有的 |
|---|---|---|
| 创世回廊1.3 | 28 | `fa-sparkles` |
| 希尔 | 75 | `fa-sparkles` `fa-blanket` |
| 魔法少女是不会败北恶堕的吧! | 58 | `fa-radar` |
| 魔法禁书目录 | 59 | `fa-user-hair` |
| 银麒赎世 | 63 | `fa-chevron-`(疑似模板拼接 `fa-chevron-${…}`,非真名) |
| 魔法少女的扣扣审判1.0 | 40 | —— |

(口径:图标名读自 `node_modules/@fortawesome/fontawesome-free/css/*.css` 里实际定义的
2491 个 `.fa-*::before`,不是凭记忆。)**所以「创世回廊上有个空框」不能推出「预置没生效」,
得指名是哪个图标。** 反过来,`魔法少女的扣扣审判1.0` 是唯一一张图标全部存在的卡,
**它才是判断预置是否生效的干净样本**。

**② 银麒赎世的 FA 用在 `script` population,不是 `regex`。** 由于预置只进 message frame,
「这张卡的图标由哪个 frame 画」决定它是否被覆盖,而 population 只是代理、不是答案。
它的族是 FRAGMENT(界面在消息正文),所以大概率覆盖得到,但这条要实测才算数。

#### 谓词与鉴别力(每条差集单独说,弱的分开报)

- **Font Awesome**:只在 `class` 属性值里、且**按整个 token 相等**匹配。两道都必要,
  各挡住一类假阳性:
  - 限定在 `class` 属性内 —— 语料里 `fa-` 的字面命中**全部**落在 `chat_metadata` 的 UUID
    (`1316a7fa-ce03-…`),裸 `/fa-/` 会误报。
  - 整 token 相等 —— **第一版没这么做,`\bfab\b` 匹配到了 `recovery-fab` 里的 `fab`
    (`-` 是词边界),于是 V1.5.4_ 被误算成 FA 卡,数字一度是 7。** 它 1076 个 class 值里
    真正的 FA token 是零。**正确的数是 6**,而且因此**没有任何 SCRIPT-DOM 卡用 FA**——
    这恰好是「预置只进 message frame」下最要紧的那一格。
- **Tailwind**:分两栏报,因为强度差很多。`tailwind`/`@apply` 字面是硬证据(2 张);
  utility 名单是启发式,且加了一道过滤——**只有卡自己的 CSS 里没有定义该类名时才算命中**,
  否则那是卡自己写的同名类。过滤后只剩创世回廊1.3 一张,命中 token 如
  `rounded-lg text-xs items-center justify-between grid gap-4`。**utility 那栏不要单独当证据用。**
- **jQuery UI**:`.draggable(`/`.sortable(`/`.resizable(`/`.dialog(`/`.accordion(`/`.tabs(`。
  零。注意这个谓词只认 jQuery 插件式调用,**卡自己实现的拖拽不会命中,也不该命中**。
- **showdown** / **VueRouter**:`showdown` 字面;`VueRouter`/`createRouter`/
  `createWebHashHistory`/`<router-view`。
- **两个零按族纪律读:`jQuery UI` 和 `VueRouter` 是「还没遇到」,不是「不需要」。**

范围:22 张卡的 greeting / card-text / 内嵌世界书 / 界面正则 / 卡内脚本 / 语料楼层正文
(共 13.9 M 字符楼层、4.5 M 字符脚本;各 population 的规模与已点亮的探针见
`scratchpad/deps-pops.mjs`)。**远程 bundle 看不见**——内联 bundle 可见(V1.5.4 的命中就来自
卡内内联正文),所以每个数都是下界,和 §一之二 ESM 那栏同一个边界。

两个语料 chat 目录(`【Sgw】又看一集1`、`缄默之秋2.5 MVU`)没匹配到卡,它们的楼层不在任何
一栏里,合计 10.3 万字符。

### 还没有代表的族

- **`FRAME-BARE`(真正无围栏的完整文档)** —— 零。判据可以据此收紧。
- **提示词装配面**:`injectPrompts` 只有 V1.5.4 一张。
- **世界书写**:`createWorldbookEntries` / `getOrCreateChatWorldbook` 只有 V1.5.4 一张。
- **`getPreset`**:只有 `魔法少女的扣扣审判1.0` 一张,且只传字面量 `'in_use'`。
- **`EjsTemplate.evalTemplate` 真调用**:只有 `银麒赎世` 一张(`创世回廊1.3` 只探测存在)。
- **非 MVU 且读楼层变量的卡** —— 零(3 张非 MVU 卡一个变量 API 都不用)。

"只有一张"的那几条不是缺口,是**族内只有一个变体**:任何针对它的实现都缺少第二个样本来
检验一般性,所以那些结论的作用域要写明"n=1"。

---

## 二、`测试用卡/新增-20260902/V1.5.4_.png` —— 第一个新族

> **零产界面正则 + `postMessage` + 1.55 MB 脚本 = 界面由脚本自建 DOM。**

**这张卡是三张里唯一能测这条路的。** 我们围绕 frame / claim 建的全部判据——`is_frontend`
的文档标记、围栏 info 串、`<pre>` 归属——**对它一条都不适用**,因为它的界面根本不经过
消息文本。

| | |
|---|---|
| 名 / 作者 | 不要被神隐挑战 V1.5.4 测试版 / 妖祀(char_version 1.5.4) |
| spec | `chara_card_v3` 3.0 |
| 盘上 | 4.6 MB |
| description | **0 B** |
| first_mes | **2 B** |

**脚本 4 条,合计约 1.55 MB:**

```
[mvu]            89 B   import testingcf.jsdelivr → MagVarUpdate/artifact/bundle.js
[变量结构]      4785 B   zod
[游戏引擎]    561835 B
[论坛覆盖层]  990319 B   域名: testingcf.jsdelivr, tailwindcss.com
```

成员用法(两条大脚本合并):`Mvu` `createWorldbookEntries` `eventEmit` `eventOn` `eventOnce`
`generate` `generateRaw` `getChatMessages` `getLastMessageId` `getOrCreateChatWorldbook`
`getVariables` `injectPrompts` `replaceVariables` `setChatMessages` `substitudeMacros`
`waitGlobalInitialized`

**正则 1 条,产界面 0**——唯一那条是 `[不发送]去除变量更新`,替换体 0 B、`promptOnly`。

**内嵌世界书** 9 条,含 `<%` 的 **0**,`entries` 是**数组**。

**前端重量**:替换体合计 0 B;库 jQuery + Vue + Tailwind + zod + lodash(**第一张 Vue 卡**);
特征位有 `<style>` 块、localStorage、**`postMessage`**(三张里只有它有)。

### 它撞哪条缺口

| 缺口 | 说明 |
|---|---|
| **frame / claim 判据整体不适用** | 界面不来自消息文本,现有判据无从施加。这是新族,不是新样本。 |
| `injectPrompts` **未建** | 提示词装配面,与已建的 `setExtensionPrompt` 不同族 |
| `createWorldbookEntries` **未建** | 世界书**写** |
| `getOrCreateChatWorldbook` **未建** | 世界书**写**(且带"不存在就建") |
| `tailwindcss.com` 白名单外 | 预期硬拒,见第五节 |
| 1.55 MB 注入体积 | 撞注入体积与解析期完整性(语法错会整块杀掉,frame 内 try/catch 来不及存在) |

---

## 三、`测试用卡/新增-20260902/2.png`

| | |
|---|---|
| 名 / 作者 | 绿茵好莱坞 / (作者字段为空) |
| spec | `chara_card_v3` 3.0 |
| 盘上 | 1.0 MB |
| description | **0 B** |
| first_mes | **20 B** |

**脚本 3 条:**

```
[变量结构]      5159 B   zod
[MVUbeta]        94 B   import MagVarUpdate@beta ← 分支,不是 artifact 主线
[状态栏]       31565 B   成员: Mvu eventOn tavern_events
                        域名: d1j1y3gb82cpmr.cloudfront.net, lu/er/lv-sycdn.kuwo.cn,
                              fonts.googleapis.com
```

**正则 5 条,产界面 2**:`状态栏`(28313 B)与 **`开场白`**(11142 B)。开场白本身是界面——
和爱衣同族,**第 0 楼就是 frame**。

**内嵌世界书** 13 条,含 `<%` 的 **0**,`entries` 数组。

**前端重量**:最大替换体 28313 B、合计 39455 B;库 jQuery + zod + lodash;特征位有
`<script>`、`<style>`、localStorage、**`on*` 事件属性**。

### 它撞哪条缺口

| 缺口 | 说明 |
|---|---|
| 4 个白名单外媒体域 | cloudfront + kuwo ×3,预期硬拒,见第五节 |
| `fonts.googleapis.com` | 同上(语料里也有,不是新形状) |
| **MVU `@beta` 分支** | 版本偏斜。语料里其余卡走 `artifact/bundle.js` 主线;`@beta` 的 API 与主线不保证一致 |
| 开场白即界面 | 第 0 楼就要 frame,和爱衣同族 |
| `on*` 事件属性 | **1 处**,在 `开场白` 的替换体里,`placement=[2]`、`markdownOnly`。**但那条替换体本身是完整文档**,所以走 frame 路径,handler 在那里合法——**内联消毒的收紧此刻打不到它**。记在这里是因为形状出现了:936 楼片段带里 `on*` 是 0,这张卡说明同一批作者会写 handler,只是目前放在文档里。 |

---

## 四、`测试用卡/新增-20260902/2.1.0.png`

| | |
|---|---|
| 名 / 作者 | 灭仇家满门之后,我收养了想对我复仇的孤女 / 高松特灯灯(char_version 2.1) |
| spec | `chara_card_v3` 3.0 |
| 盘上 | 5.8 MB |
| description | **0 B** |
| first_mes | 17895 B |

**脚本 4 条:**

```
[MVU]          1199 B   import testingcf.jsdelivr + cdn.jsdelivr(两条,互为兜底)
[状态栏]        9855 B
[气泡面板]    118894 B   成员: getCharWorldbookNames getWorldbook getWorldbookNames
                              updateWorldbookWith    域名: www.w3.org
[Zod]          2001 B
```

**正则 6 条,产界面 1**(`状态栏界面` 10521 B、`markdownOnly`)。
**内嵌世界书** 45 条,含 `<%` 的 **0**,`entries` 数组。
**前端重量**:最大替换体 10521 B、合计 12642 B;库 zod;特征位 `<script>`、`<style>`、localStorage。

### 它撞哪条缺口

| 缺口 | 说明 |
|---|---|
| `getWorldbookNames` **未建** | |
| `updateWorldbookWith` | 已建,世界书**写**路径的回归样本 |
| `www.w3.org` 白名单外 | 语料里也有;多为 SVG 命名空间字面量,未必是真加载 |

**三张里最常规的一张**,形状与既有语料同族,价值以回归为主。

---

## 五、预期报告(按设计会被拒的东西)

这些**不是缺陷**,是升级侧收紧的预期结果。验收时看到对应的拒绝报告即为通过;
**看不到报告才是问题**。

| 卡 | 会被拒的 | 判据 |
|---|---|---|
| 2.png | `d1j1y3gb82cpmr.cloudfront.net` | 外部资源加载一律拒 |
| 2.png | `lu-sycdn.kuwo.cn` / `er-sycdn.kuwo.cn` / `lv-sycdn.kuwo.cn` | 同上(音乐 CDN) |
| 2.png | `fonts.googleapis.com` | 同上 |
| V1.5.4_ | `tailwindcss.com` | 同上 |
| 2.1.0 | `www.w3.org` | 同上 |

白名单内、预期放行:`testingcf.jsdelivr.net`、`cdn.jsdelivr.net`(三张卡都用)。

**拒绝必须点名域名并盖过卡自己的 fallback 文案**——语料里有卡在资源取不到时打印
"你的酒馆坏了",那句会盖住真正的原因。

---

## 六、成员账:新卡带来的

**真正未建的 4 个:**

| 成员 | 卡 | 类 |
|---|---|---|
| `injectPrompts` | V1.5.4_ | 提示词装配 |
| `createWorldbookEntries` | V1.5.4_ | 世界书写 |
| `getOrCreateChatWorldbook` | V1.5.4_ | 世界书写 |
| `getWorldbookNames` | 2.1.0 | 世界书读 |

**语料首次用到、但我们已经建了的 3 个**:`eventOnce`、`getLastMessageId`、`substitudeMacros`。
最后那个值得单记:那个非标准拼写(不是英文 `substitute`)此前只有上游 `@types` 作依据,
**现在有了第一份真卡证据**。

**与既有 19 卡重叠的 14 个**:`Mvu` `eventEmit` `eventOn` `generate` `generateRaw`
`getCharWorldbookNames` `getChatMessages` `getVariables` `getWorldbook` `replaceVariables`
`setChatMessages` `tavern_events` `updateWorldbookWith` `waitGlobalInitialized`
—— 这部分是回归价值,不是新覆盖。

---

## 七、三张卡的共同形状(对验收有直接影响)

1. **description 全是 0 B**,后两张 first_mes 近乎空(20 B / 2 B)。人设与开场都由脚本或
   正则生成。**打开卡看不到内容,不等于卡是空的。**
2. **内嵌世界书的 `entries` 三张都是数组**,不是 ST 磁盘世界书那种按 uid 键控的对象。
   读它的代码若用 `.length` / `[i]` 走(语料里有卡这么写),交回键控对象会得到零次迭代
   **而验收照样绿**。
3. **零 EJS**:三张的内嵌世界书都没有 `<%`,所以 `EjsTemplate` 那条路一张都不撞。
4. 三张都用 zod,三张都有 `<style>` 与 localStorage。

---

## 七之二、存储族 —— 按兜底形状分,不按次数

族代表:**银麒赎世 / 手机UI**(81 个调用点,全语料最多,且是唯一用 indexedDB 的)。

**为什么不按次数分**:次数量的是「这张卡多依赖存储」,不是「存储没了会怎样」。决定后者的是
每个调用点的三件结构事实——**在不在 `try` 块里、读失败有没有默认值、在启动路径还是回调里**。
所以这一节按这三件排,次数只作规模参考。

**建模的失败**:不透明源下 `localStorage` 是**属性访问就抛 `SecurityError`**,不是返回 null。
于是三种结局各自对应一种结构:

| 结构 | 结局 |
|---|---|
| 在 `try` 内 + 读有默认值 | **静默降级**(卡作者想要的形状) |
| 模块顶层 / 顶层 IIFE,且不在 `try` 内 | **启动即死** —— 模块没跑完,这张卡**整个界面都不出现** |
| 回调内,且不在 `try` 内 | **回调期抛** —— 那一次交互坏,卡的其余部分活着 |

### 逐脚本

| 卡 / 脚本 | 调用点 | 在 try | 读/写 | 启动路径(裸) | **预测** |
|---|---|---|---|---|---|
| **银麒赎世 / 手机UI** | 81 | 65 | 39 / 38 读多 | 1(**1 裸**) | **启动即死** |
| 魔法少女的扣扣审判1.0 / 外置状态栏 | 50 | 23 | 20 / 30 写多 | 1(**1 裸**) | **启动即死** |
| 创世回廊1.3 / 外置状态栏 | 12 | **12 / 12** | 5 / 7 写多 | 12(0 裸) | 静默降级 |
| 可攻略女主拒绝被攻略 / 正文美化 | 4 | **0 / 4** | 2 / 2 | 0 | **未定**(见下) |
| OVERLORD不死者之王 / ERA阵营管理系统 | 2 | 1 | 1 / 1 | 0 | 回调期抛(`eventOn`) |
| OVERLORD不死者之王 / ERA好感度系统 | 2 | 1 | 1 / 1 | 0 | 回调期抛(`eventOn`) |
| 气泡面板(2.1.0 ≡ 灭仇家…) | 2 | **2 / 2** | 0 / 0 | 2(0 裸) | 静默降级 |
| 状态栏(2 ≡ 绿茵好莱坞) | 2 | **0 / 2** | 1 / 1 | 1(**1 裸**) | **启动即死** |
| 论坛覆盖层(V1.5.4_ ≡ 不要被神隐挑战-V1.5) | 1 | 1 | 1 / 0 | 0 | 静默降级 |

**四个「启动即死」是这一族的全部风险**,其余六个要么静默降级要么只坏一次交互。而它们的裸点
都极少(各 1 个),**也就是说这一族的严重后果集中在 4 个调用点上,不是 165 个**。

### 族内其实只有 6 个组件,不是 9 个脚本

按内容哈希比对(`scratchpad/storage-family.mjs` + 内容 sha256):**14 个脚本只有 9 份不同内容**,
其中三对**逐字节相同**、只是挂在不同卡上:

- `气泡面板` 106,116 B:`2.1.0` ≡ `灭仇家满门之后我收养了想对我复仇的孤女`
- `状态栏` 30,457 B:`2` ≡ `绿茵好莱坞`
- `论坛覆盖层` 928,722 B:`V1.5.4_` ≡ `不要被神隐挑战-V1.5`

再往上一层:**银麒赎世 / 手机UI 与 魔法少女的扣扣审判1.0 / 外置状态栏 是同一份代码的两个分叉**
——哈希不同(465 KB vs 424 KB),但**键名与函数名成套重合**:`moshen-phone-wallpaper`、
`mobile-trigger-btn-position`、`mobile-trigger-btn-user-dragged`、`mobile-last-panel`,以及
`bindPhoneEvents()`、`restoreTriggerBtnPosition()`。**两张「启动即死」里最大的两张是同一个组件的
两个版本**,所以修一处覆盖 131 / 165 个调用点。

> 这条直接支持「按族修不按卡修」:**存储族的验收样本应当按组件选,不按卡选**,否则会把同一份
> 代码验收两遍,而漏掉另外四个组件。

### 键名形状(只记名字不记值)

- `银麒赎世`(17 个):`yinqi-` 前缀为主(`yinqi-known-friends` / `yinqi-npc-groups` /
  `yinqi-forum-unread` / `yinqi-chat-api-settings` …),外加共用的 `moshen-` / `mobile-` 前缀。
- `魔法少女的扣扣审判1.0`(14 个):`forum_*`(`forum_api_url` / `forum_api_key` /
  `forum_api_model` / `forum_auto_generate`)、`moshen-forum-*`、`unlocked_cg`,外加同一套
  `mobile-` 前缀。
- `创世回廊1.3`(3 个):`rpg_player_avatar`、`rpg_diff_choice`、`rpg_diff_override`。
- `OVERLORD` 两个脚本各 1 个:`阵营系统_last_data`、`好感度_last_data`(中文键名)。
- 其余脚本的键是**运行时拼接的**(计算键),名字取不到——这本身是个结论:**按前缀做迁移/隔离的
  方案覆盖不到它们**。

**没有一个前缀是全族共享的。** `mobile-` / `moshen-` 只跨那两个分叉卡。

### 谓词与鉴别力

- **用 TypeScript 5.9.3 的 parser 走 AST,不是 grep。** `try` 嵌套是层次关系,正则读不出来;
  「这个调用在不在 try 的 *try 块* 里(而不是 catch/finally 里)」尤其读不出来。
- **和 3c 的数对不上是口径,不是错。** 3c 的 109 / 59 / 13 是**字符串出现次数**,我逐字复现了
  (`银麒赎世` 原文出现 109 次 localStorage + 5 次 indexedDB);我的 81 / 50 / 12 是 **AST 里真正的
  标识符引用**,不含注释和字符串字面量里的那些。**两个都对,但只有后者能预测行为**——注释里的
  `localStorage` 不会抛。
- **`typeof localStorage !== 'undefined'` 不是防护**(typeof 本身就抛)。全族**守卫尝试 0 次**,
  所以这一族没有"想防但防错了"的卡,只有防了和没防的。
- **未定的那一格要照实说**:`可攻略女主拒绝被攻略` 的 4 个点全在具名函数里
  (`getSavedFont` / `getSavedSize` / `handleFontChange` / `handleSizeChange`),**静态判断不出这些
  函数何时被调用**。读名字像是"初始化读 + 事件写",那样的话结局是"启动即死";但这是猜,不是量。
  同理 `银麒赎世` / `魔法少女的扣扣审判1.0` 各有若干点落在 `named fn` 与 `function (unclassified)`,
  它们不影响预测(那两张已因顶层裸点判为启动即死)。
- **远程 bundle 看不见照旧**:内联 bundle 可见(`论坛覆盖层` 928 KB 就是内联的),远程 artifact
  内部的存储访问不在这些数里,**所有数字都是下界**。

## 八、未量

- **渲染后的一切。** 三张卡还没有 chat,没有进 dev 数据目录,所以 frame 楼数、片段带、
  `<pre>` 归属、`<style>` 作用域、实际外链请求,**一条都没量**。等 49 导入后另量。
- **`www.w3.org` 是不是真加载。** 它多半是 SVG 的 `xmlns` 字面量;要确认得看它在什么
  位置出现,我只数了域名。
- **`@beta` 分支与主线的 API 差异。** 只记了它用的是 `@beta`,没有对比两个 bundle 的导出面。
- **1.55 MB 脚本的注入行为。** 体积记了,注入是否成功、解析期是否整块失败,要在浏览器里读。
