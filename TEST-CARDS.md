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

## 八、未量

- **渲染后的一切。** 三张卡还没有 chat,没有进 dev 数据目录,所以 frame 楼数、片段带、
  `<pre>` 归属、`<style>` 作用域、实际外链请求,**一条都没量**。等 49 导入后另量。
- **`www.w3.org` 是不是真加载。** 它多半是 SVG 的 `xmlns` 字面量;要确认得看它在什么
  位置出现,我只数了域名。
- **`@beta` 分支与主线的 API 差异。** 只记了它用的是 `@beta`,没有对比两个 bundle 的导出面。
- **1.55 MB 脚本的注入行为。** 体积记了,注入是否成功、解析期是否整块失败,要在浏览器里读。
