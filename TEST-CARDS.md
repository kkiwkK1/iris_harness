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
| `GREETING-DOC` 卡自己的 `first_mes` 已带文档 | **0** | 3 张卡 / **2 份不同 greeting** | 2.1.0 ≡ 灭仇(逐字节相同)、干物吸血鬼少女 |
| `SCRIPT-DOM` 无产界面正则,脚本自建 DOM | **0** | **1 个组件**(挂 2 个卡名) | V1.5.4_ ≡ 不要被神隐挑战-V1.5 |
| `FRAME-BARE` 完整文档、不在任何 `<pre>` 内 | 1 | — | **没有正当代表**,见下 |

**那两个 0 是定义造成的,不是缺口**:

- `GREETING-DOC` 渲染后**塌进 `FRAME-FENCED`** ——文档来自哪里是**来源**的区别,渲染后
  的形状一样。它的 0 说明"见"这一栏量不了来源,不说明没有卡。
- `SCRIPT-DOM` **按定义不经过消息文本**,所以"渲染后的消息文本"这把尺子对它**必然量到
  0**。V1.5.4 的楼渲染前 1 字符、渲染后 1 字符,那是**这条路的性质,不是失败**。

> **`SCRIPT-DOM` 那个「能力 2」原先是错的,已改成「1 个组件」。** 那两张卡的
> `论坛覆盖层` 脚本**逐字节相同**(928,722 B,同一 sha256),是**一个组件挂在两个卡名下**,
> 不是两个样本。按卡数会把 n=1 读成 n=2,而这一族恰好只有它一个成员——**去重要按内容,
> 不按卡名**。详见 §七之三。

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

> **实证(2026-09-03,f351937 读数):那份「会自己过期」的名单当天就过期了一条。**
> `创世回廊1.3 / 小手机脚本` 报
> `Failed to fetch dynamically imported module … testingcf.jsdelivr.net/gh/tangquanghuy/dnf@main/小手机脚本.js`
> **answered 404**。
>
> 这正是上面「版本自由」那条的实例:`@main` **是个会移动的分支引用**,不是钉死的版本
> —— 卡没改、名单没改,**地址自己失效了**。上游同样会死,所以这条**记 ESM 族账,不是我们的缺口**。
> 11 个地址里 6 个不写版本、这一个写的是移动分支,**「可枚举」与「枚举后保持有效」是两件事**
> 从推论变成了实测。

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

#### 补列:哨兵 `<link>` 能短路几张(`scratchpad/fa-injection-guards.mjs`)

**分界线完全就是注入方式,与卡的意图无关:**

| 卡 | 注入方式 | 守卫 | 哨兵能短路? |
|---|---|---|---|
| **银麒赎世 / 手机UI** | 脚本 `createElement('link')` | `link[href*="font-awesome"]` \|\| `link[href*="fontawesome"]` | **能** |
| **魔法少女的扣扣审判1.0 / 外置状态栏** | 脚本 `createElement('link')` | 同上(同源分叉) | **能** |
| 创世回廊1.3 | **字面 `<link rel=stylesheet>`** ×1 | 无 | **不能** |
| 希尔 | **字面 `<link>`** ×1 | 无 | **不能** |
| 魔法少女是不会败北恶堕的吧! | **字面 `<link>`** ×4 | 无 | **不能** |
| 魔法禁书目录 | **字面 `<link>`** ×2 | 无 | **不能** |

> **哨兵 link 能短路 2/6;剩 4 张真的会打 cdnjs。**
> 那 4 张不是"忘了写守卫" —— **字面 `<link>` 是声明式的,浏览器解析到就取,卡没有任何
> 代码可以拦它**。**这条不可能靠改哨兵解决**,是注入方式本身的性质。

**但 M=4 不等于要改白名单,因为那 4 张不会因此少图标:**
它们的 `<link>` 全在**界面正文**里 → 渲染进**消息 frame** → **那里已经预置了 FA 6.5.2**。
所以那条 cdnjs 请求**被 CSP 拒掉之后,图标照样有**。**它们损失的不是功能,是产生一条拒绝记录。**
→ 要处理的是**报告**(别让 4 张卡的装饰性 CSP 拒绝被读成坏了),不是白名单。

#### 一处会让哨兵方案当场失效的细节

那两张**能**短路的卡,守卫测的是 **`link[href*=…]`** —— **必须是一个 `<link>` 元素**。
而今天的预置是**内联 `<style>`**,不是 link(`message-preset-styles.ts:44`):

```ts
function addStyle(css: string, label: string): void {
  const style = document.createElement('style')
  style.setAttribute('data-iris-style', label)   // ← <style>,不是 <link>
  style.textContent = css
  document.head.append(style)
}
addStyle(faBase, 'fontawesome')
```

> **所以「预置了 FA」并不能让那两张卡的守卫短路 —— 它找的是 `<link>`,现场只有 `<style>`。**
> 要让哨兵成立,预置必须**额外放一个 `<link>` 元素、且其 `href` 含子串 `fontawesome`**
> (指向哪儿不重要,同源桩或 `data:` 都行,守卫只做子串匹配)。
> **不补这一个元素,那两张卡仍会各发一次 cdnjs 请求** —— 短路数就从 2 变 0。

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

> **本表已按 2026-09-03 实测修正一次**(`scratchpad/storage-family-v2.mjs`)。v1 的「启动路径」
> 判据太窄:只认模块顶层与顶层 IIFE,而**在别处声明、被顶层调用的函数一样在启动时跑**。
> 修正后 银麒赎世 的裸启动点 **1 → 6**、魔法少女 **1 → 7**;结论没变,**风险面比原先报的大**。

**v3(`scratchpad/storage-family-v3.mjs`)加了一个中间档。** 括号内是**不在 try 里**的点数,
预测取最靠前的那一档。

| 卡 / 脚本 | 点 | 启动(裸) | **载入期**(裸) | 交互(裸) | **预测** | 实测 |
|---|---|---|---|---|---|---|
| **银麒赎世 / 手机UI** | 81 | 1(**1**) | 43(5) | 37(10) | **启动即死** | 未测 |
| 魔法少女的扣扣审判1.0 / 外置状态栏 | 50 | 1(**1**) | 24(5) | 25(21) | **启动即死** | 未测 |
| 状态栏(2 ≡ 绿茵好莱坞) | 2 | 1(**1**) | 0 | 1(1) | **启动即死** | **✅ 逐字命中**;**门面后(f351937):活** |
| **可攻略女主拒绝被攻略 / 正文美化** | 4 | 0 | **4(4)** | 0 | **界面永不初始化** | 未测 |
| 创世回廊1.3 / 外置状态栏 | 12 | 12(**0**) | 0 | 0 | 静默降级 | 未测 |
| OVERLORD不死者之王 / ERA阵营管理系统 | 2 | 0 | 0 | 2(1) | 交互期抛 | 未测 |
| OVERLORD不死者之王 / ERA好感度系统 | 2 | 0 | 0 | 2(1) | 交互期抛 | 未测 |
| 气泡面板(2.1.0 ≡ 灭仇家…) | 2 | 0 | 0 | 2(**0**) | 静默降级 | 未测 |
| 论坛覆盖层(V1.5.4_ ≡ 不要被神隐挑战-V1.5) | 1 | 0 | 0 | 1(**0**) | 静默降级 | **见下**;**门面后(f351937):活** |

### 门面落地后的复读(f351937)—— 两行都活了,阻塞转移到覆盖层宿主

| 组件 | 门面前 | 门面后 |
|---|---|---|
| 状态栏(绿茵好莱坞) | 启动即死(面板 `1 of 3 failed`) | **3 of 3 loaded and listening**,脚本跑完并建了 **3 个元素** |
| 论坛覆盖层(V1.5.4_) | devtools-kit 的 `typeof localStorage` 抛 | **4 of 4 loaded**,建了 **2 个元素**(`div`、`iframe`) |

**两行都不是"预测失效",是预测里那个致因被拿掉了:**

- 状态栏的预测是「**1 个模块顶层裸调用**杀掉整个模块」。门面让属性访问不抛,**恰好就是那一个
  致因**,于是模块跑完 —— **拿掉预测的因、预测的果就消失**,这是比命中更强的一种确证。
- 论坛覆盖层的判定是「**卡正文抛不出它,抛点在远程依赖 `@vue/devtools-kit`**」。门面覆盖了
  devtools-kit 那次访问,卡就活了 —— **归因得到独立确认**。

**新的阻塞不在这一族**:论坛覆盖层现在报 `TypeError: null.querySelector`,
**卡在找一个不存在的 DOM 节点** —— 那是 §七之三 覆盖层宿主/锚点那件事。
状态栏建的 3 个元素也**落在隐藏的脚本 frame 里**,同样等覆盖层宿主。

> **所以存储族这两个组件的结论是:门面后活,阻塞转移至覆盖层宿主。**
> 存储不再是它们的失败原因;下一次读它们要按 §七之三 的判据读,不是按本节。

### 第二批读数(f351937 + b6d8aee)—— 四个组件全部复读完,预测全中

| 组件 | 预测 | 读数 | 判定 |
|---|---|---|---|
| 手机UI(银麒赎世) | 启动即死 | **活**,建 3 元素,**零存储失败** | 致因被门面拿掉 ✓ |
| 外置状态栏(魔法少女的扣扣审判1.0) | 启动即死 | **4 of 4 loaded**,活,建 3 元素 | 同上 ✓ |
| 外置状态栏(创世回廊1.3) | **静默降级** | **活**,建 3 元素 | **直接命中 ✓**(12 点全在 try 内,本就不该死) |
| **正文美化(可攻略女主)** | **载入期** | **无模块级异常、无 ready 回调异常**,`getItem` 返 null 不抛 | **三档判据首次受检,成立 ✓** |

**三卡的启动档与载入期档都没有存储异常。** 各卡剩下的那一条失败**都不属于存储族**:

| 卡 | 失败的脚本 | 原因 | 归属 |
|---|---|---|---|
| 银麒赎世 | 银麒系统面板 | ~~`refused document.readyState`~~ → **已解(6dd2965),复读 4 of 4 loaded** | 非存储 |
| 创世回廊1.3 | 小手机脚本 | 远程模块 **404** | ESM 族,见 §一之二 |
| 可攻略女主 | 插入状态栏 | **解析期 SyntaxError**(卡原文正则跨行) | 卡自身缺陷,见 §七之七 |

### 空 profile 首次路径:**已验(读侧)**(8788)

无任何 per-character store、无 `card-storage.json`。**银麒赎世** 与 **可攻略女主** 的读数与满
profile **逐行一致**;`getItem` 返 `null` 不抛,**只缺值、不异常**。

> **判据成立,但只验到读侧。** 跑完后 profile 里出现了 `script-policy.json` /
> `extension-settings.json` / `script-bundles/`,**没有 `card-storage.json`** ——
> 说明这两张卡的启动路径**没有写穿**。写穿与 `clear()` 的配额报告**仍未验**。

#### 这条读数纠正了我的分档实现(v4)

「首次运行没建 store 文件」与 v3 的分档**对不上**:v3 把 **43 次写**记在启动+载入期,
那样第一次跑就该落盘。差在哪:**v3 把「注册处理器」当成了「调用处理器」** ——
`on('change', h)` 时它把 `h` 加进注册点的调用闭包,于是**在 ready 回调里注册的处理器继承了
载入期**,而它其实在用户动作时才跑。

v4 保留可达性、但把**按引用注册的处理器一律归为交互档**:

| 档 | v3(读/写) | **v4(读/写)** |
|---|---|---|
| 启动 | 8 / **7** | 3 / **0** |
| 载入期 | 35 / 36 | 33 / 26 |
| 交互 | 27 / 37 | 34 / 54 |

**启动档现在是只读的(3/0),与"首次运行不落盘"一致。** `正文美化` 也从
「载入期 2 读 2 写」变成 **「载入期 2 读 + 交互 2 写」** —— 正是
`getSavedFont`/`getSavedSize` 载入期读、`handleFontChange`/`handleSizeChange` 交互时写。

**没有任何一行预测因此改变**(预测取决于各档的**裸**点数,而 try 归属没变);
变的是读/写在档之间的归属。**`手机UI` 仍有 14 处载入期写**,而首次运行没落盘 ——
要么它们是条件写、要么那 1.3 MB 脚本的载入期闭包仍偏宽,**静态分不出来,留待写穿探针**。

#### 「屏幕不作为归类依据」这次保住了一条正确预测

**正文美化在屏幕上看不到工具栏**,照屏幕读会被记成「载入期预测错了」。
实际上 console 里**一条异常都没有** —— 工具栏建出来了,只是建在**隐藏的脚本 frame** 里,
属覆盖层宿主那件事。

> **同一个屏幕现象(界面不出现)在这一批里对应了四种不同原因**:存储启动即死(第一批的状态栏)、
> 解析期 SyntaxError(插入状态栏)、远程 404(小手机脚本)、宿主锚点缺失(正文美化)。
> **只有 console 分得开。** 这也是 §九 那条判据的实证。

### 三档,不是两档(v3 的修正)

v2 只有「启动 / 回调」两档,于是**语料里最常见的启动写法整个落在了裂缝里**:
`$(() => { init() })`、`$(document).ready(fn)`、`addEventListener('DOMContentLoaded', fn)`
—— 函数是**按引用**交出去的,而 v2 的闭包只跟 **call 表达式**,所以这些函数一律被判成
「顶层到不了」。同样漏掉的还有 `on('change', handler)` 这种**按引用注册**。

| 档 | 判据 | 抛出时的形态 |
|---|---|---|
| **启动** | 模块顶层 / 顶层 IIFE / 从顶层语句可传递调用到 | 模块没跑完,**卡里什么都不存在** |
| **载入期** | ready / `DOMContentLoaded` 回调内,及其可达闭包;含按引用注册的处理器 | 模块跑完了,但**界面永远不初始化** |
| **交互** | 用户动作触发的处理器 | **一次交互坏**,界面还在 |

**「启动」与「载入期」在屏幕上不可区分**(都是界面不出现),**在 console 里可区分**
(前者模块级报错,后者 ready 回调内报错)。验收时要按后者认,否则两种缺陷会被记成同一种。

**v3 对预测的净影响:一行从「未定」变成有预测,其余预测不变。**
但 银麒赎世 的 6 个裸启动点在 v3 里拆成 **1 个真·模块顶层 + 5 个载入期** ——
**结论没变,机制变了**;v2 把两档并在一起,属于「结论对、理由粗」。

### 可攻略女主 / 正文美化:不再是「未定」

链条逐段读出来了:

```
$(() => { initMvuGlobalContentToolbar(); });          // 顶层,jQuery ready
  └─ initMvuGlobalContentToolbar()
       └─ applyMvuGlobalContentStyleToAll()
            └─ getSavedFont() / getSavedSize()  →  localStorage.getItem(…)   ← 4 个点,全裸
```

另有 `handleFontChange` / `handleSizeChange` 是
`document.addEventListener('change', handleFontChange, true)` **按引用注册**的,属交互档。

> **预测:模块跑完,但工具栏永不出现**(ready 回调在第一次 `getSavedFont()` 就抛)。
> 屏幕上和「启动即死」一样,console 里不一样。

### 「启动路径」的判据(v1 太窄,这是修正后的)

一个调用点算**启动路径**,当它落在下列任一处:

1. **模块顶层** —— 不在任何函数体内。
2. **顶层 IIFE** —— 最外层函数被立即调用。
3. **顶层可达**(v1 漏的就是这条)—— 所在函数名落在「顶层语句所调用的函数名」的**传递闭包**
   内(深度 6)。**在哪声明不重要,被谁调用才重要。**
4. **Vue 同步钩子** —— 顶层同步 `createApp(...).mount()` 时,`setup`/`data`/`created`/
   `beforeCreate`/`render` 内的访问同样在启动时跑。

**这是启动可达性的下界**:看不见动态派发(`obj[name]()`、事件表驱动),所以**只会漏报启动即死,
不会凭空造一个**——安全的方向。

检测面也补齐了 v1 的洞:除裸标识符外,现在认 `window`/`globalThis`/**`self`**/`top`/`parent`
成员式、解构(`const {localStorage} = window`)、别名(`const ls = localStorage`)。
**本批语料这三种写法命中 0** —— 也就是说 v1 漏的是**归类**,不是**检测**。

### 论坛覆盖层实测 failed,但它的正文里没有能抛的点

实测报 `Failed to read the 'localStorage' property from 'Window': The document is sandboxed
and lacks the 'allow-same-origin' flag.`,复核结论是**这份正文抛不出它**:

- 全文 `localStorage` 字面出现 **4 次**,但脚本是**一整行压缩代码**;前 3 次(偏移 7697 /
  7772 / 7962)都在**注释或字符串文本**内(内容是给测试人员的 console 用法说明)。
- **AST 只认出 1 个真实访问**(偏移 913169):
  `(0,r.computed)(()=>{try{return'on'===localStorage.getItem('forum_debug_ui')}catch{…}})`
  —— 在 `computed` 里且**包了 try/catch**,`SecurityError` 会被吃掉。
- `sessionStorage` / `indexedDB` / `self.localStorage` / `window['localStorage']` /
  `'localStorage' in window` / `for..in window` / 解构 / 别名 —— **全部 0**。

**所以抛点在这份正文之外。** 首要嫌疑是它第 1 行就有的远程依赖:
`import{createPinia as e,defineStore as n}from'https://testingcf.jsdelivr.net/npm/pinia/+esm'`
—— **远程 bundle 内部看不见**,这正是每份普查都写着的「所有数字是下界」在此兑现。

**定案(7b 实测栈顶):`@vue/devtools-kit@8.2.1/+esm:7`** —— pinia 的**传递依赖**,不是卡的正文。
AST 分析成立。抛点是 devtools-kit 自己的 `typeof localStorage` 守卫,**在不透明源上照抛**
(`typeof` 保护的是「引用解析不了」,不是「getter 抛」——见 §七之二 门面那条)。

**这条链条是上游自己接上的,不是意外**:`JS-Slash-Runner/src/iframe/predefine.js:20` 有
`_.set(window, '__VUE_PROD_DEVTOOLS__', true)`,注释写明「pinia 4.0.0+ 必须设置这个」。
所以**只要卡用 pinia,devtools-kit 就会进来并摸 `localStorage`** —— 这不是 V1.5.4 一张卡的事。

> **本行结论:正文 1 处受 try 保护;抛点在远程依赖 `@vue/devtools-kit`,由存储门面覆盖。**
> 预测与实测**不矛盾**——它们说的是两个对象(卡的正文 / 卡的传递依赖)。

### 补表甲:写进去的值有多大 —— 上限由一张卡定,而且是图片级

`scratchpad/storage-size-and-iface.mjs` + `wallpaper-trace.mjs`。先给能静态定死的:

- **绝大多数键存的是 `JSON.stringify(小对象)`**:`阵营系统_last_data`、`好感度_last_data`、
  `mobile-trigger-btn-position`、`moshen-forum-settings`、`unlocked_cg`、`rpg_diff_override`…
- **字面量级**:`mobile-trigger-btn-user-dragged`(4 B)、`rpg_diff_choice`(6 B)、
  `mobile-phone-width/height`(数字)、`forum_api_*`(设置字符串)。
- **9 个脚本里 6 个完全没有 data-URL 产生器**(`readAsDataURL`/`toDataURL`/
  `createObjectURL`/`btoa`/`data:` 字面)——**它们不可能在存内联图片**,这一半是确定的。

**剩下的两个是同一组件的两个分叉,而且结论相反:**

| 卡 / 脚本 | `moshen-phone-wallpaper` 存什么 | 依据 |
|---|---|---|
| **银麒赎世 / 手机UI** | **可以是 data URL(图片级)** | 恢复路径注释原文:「验证保存的壁纸URL是否有效(**支持http URL和data: base64**)」;脚本含 `readAsDataURL`×2、`toDataURL`、`createObjectURL`、`btoa`、`data:` 字面;写入值 `curUrl = $("#image-viewer img.viewer-main-img").attr("src") \|\| imageUrl` |
| 魔法少女的扣扣审判1.0 / 外置状态栏 | **只会是 http URL** | 恢复路径**校验并覆盖**:`if (!savedWallpaper \|\| … \|\| !savedWallpaper.startsWith('http')) { savedWallpaper = defaultWallpaper; localStorage.setItem(…, defaultWallpaper) }`;`imageUrl` 来自 `gitgud.io/...webp` 模板 |

> **所以门面的上限不能按 8 KB 设:银麒赎世 这一张就能把用户上传的壁纸以 base64 存进去。**
> 具体多大**静态估不出来**——它等于用户选的那张图,实际天花板是浏览器给该 origin 的配额
> (通常 5–10 MB),不是卡里的任何常数。
>
> **单键最大 / 单卡合计都无法静态给出**,原因是同一个:值来自运行时用户输入。
> 能给的是**分类上界**:除 银麒赎世 的壁纸键外,其余全部是设置/坐标/开关级的小值。

### 补表甲之二:配额报告是唯一通道,而且它得去反驳卡自己的「成功」提示

`scratchpad/quota-handling.mjs`。全部 `setItem`(脚本侧 + 界面侧,19 份不同正文):

| | 数 |
|---|---|
| `setItem` 调用点 | **89** |
| 在 try 内 | 50 |
| **不在任何 try 内**(配额满即抛) | **39** |
| **catch 是空的**(静默) | **32** |
| catch 里给用户看东西(toast/alert) | **2** |
| **catch 里检查了 error** | **0** |
| 文件里有 `QuotaExceededError` / `code === 22` 检查 | **0** |

> **全语料没有一张卡把「配额满」和「其它存储失败」区分开** —— 0 处检查 error、0 处认
> `QuotaExceededError`。**所以配额报告是唯一的可见通道。**

**而写壁纸那条路径比"静默"更糟:它会报成功。** 银麒赎世 / 手机UI 的 3 个壁纸
`setItem` 形状完全一致:

```js
try { localStorage.setItem("moshen-phone-wallpaper", curUrl); } catch (ex) {}
if (typeof toastr !== "undefined") toastr.success("已设为壁纸");   // ← 在 try 外,无条件
```

三处的提示分别是「已设为壁纸」/「壁纸已更换」/「已恢复默认壁纸」,**全部在 try 之外**,
所以**写失败时照样弹**。而背景色已经先用 `style.setProperty(..., 'important')` 打到 DOM 上了,
**本次会话看起来完全正常**。**没有任何一处回读该键确认写入**(3 个 `getItem` 都是读取路径:
初始化、`restoreWallpaper()`、全屏查看器)。

> **净效果:配额满时用户被告知"已设为壁纸",画面也确实变了,而磁盘上什么都没存;
> 直到下次载入 `restoreWallpaper()` 读不到,壁纸才无声地退回。**
> 所以配额报告**不只是唯一通道,它还必须与卡的假成功提示并存并且盖过它** ——
> 与第三节「拒绝必须盖过 fallback」同一条。
>
> 顺带:这张卡**恰好就是唯一能把 data URL 存进去、也就是唯一会撞配额的那张**(见补表甲)。
> **能撞上限的卡,正是把失败咽下去的那张。**

另外那 **39 个不在 try 里的 `setItem`**,配额满时会**抛**,按 §七之二 三档落到各自的档位;
其中界面侧的都在交互档(界面侧顶层为 0),脚本侧的分布见上表。

### 补表乙:界面侧也在用存储 —— 不是近零,失败壳不够

原先 §七之二 的 9 个脚本全在 **script** population。界面正文里另有:

| 卡 | 块 | 访问点 | 顶层 | 在 try |
|---|---|---|---|---|
| 创世回廊1.3 | 3 个块 | 7 + 7 + 19 = **33** | 0 | 6 + 7 + 7 = 20 |
| 爱衣 | 1 | **7** | 0 | **0** |
| 可攻略女主拒绝被攻略 | 1 | **4** | 0 | **0** |
| 萧谴写卡助手版_V4.5.1 | 2 | 3 + 3 = **6** | 0 | **0** |

**5 张卡、7 个块、50 个访问点,其中 17 个不在 try 里。**

> **两条结论:**
> ① **界面侧不是近零**,所以界面 frame 的门面**不能只做"存在但失败"的壳** ——
> 那 17 个裸点会抛。
> ② **但界面侧顶层访问是 0**,所以它**不会"启动即死"**;失败形态是
> **交互时抛**(点击处理器里),界面本身出得来。**与 script 侧那 4 个启动即死不同档。**

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

## 七之三、覆盖层族 —— 第二样本有,而且 V1.5.4 是其中最轻的一张

**结论先行:问「有没有第二张脚本自建 DOM 到宿主页的卡」,答案是有,一共 5 个组件;
但问「有没有第二张纯 SCRIPT-DOM 卡」,答案仍然是没有。这两个问题选出的卡不一样,
而验收风险在样本多的那一边。**

### 谓词与它依据的 realm 规则

取自 `apps/iris-web/OVERLAY-CARDS.md` §二:上游 `parent_jquery.js` 全文两行
(`window.$ = window.parent.$`),所以脚本 frame 里的 `$` **就是宿主页面的 jQuery**,
其默认查找上下文是宿主 document。于是:

| 写法 | 落在哪 |
|---|---|
| `$('选择器')`、`.appendTo('body')` —— **字符串**参数 | **宿主页** |
| `$(document.body)`、`$(window)` —— **对象**参数 | 脚本 frame 自己 |
| 裸 `document.createElement` / `document.body.appendChild` | 脚本 frame 自己 |
| `parent.document.*` | **宿主页**,而且是显式的 |

**「字符串还是对象」就是全部谓词**,所以这一节走 TypeScript parser 而不是 grep:
`$("body")` 和 `$(document.body)` 差的是**参数类型**,在压缩过的代码里肉眼几乎一样。

### 五个组件,按宿主页足迹排

| 组件(卡) | `$('串')` | `parent.document` | 宿主页路线 | 全视口 | 显隐 API | `pagehide` 自清 |
|---|---|---|---|---|---|---|
| **银麒赎世 / 手机UI** | **700** | **18** | 显式 `window.parent` | 是 | `openAppPanel` `closeAppPanel` | **无** |
| 魔法少女的扣扣审判1.0 / 外置状态栏 | 241 | 18 | 显式 `window.parent` | 是 | 同上(分叉) | **无** |
| 状态栏(`2` ≡ `绿茵好莱坞`) | 12 | 0 | realm 绑定(`head`/`body`) | 是 | 无 | **无** |
| 创世回廊1.3 / 外置状态栏 | 6 | 0 | realm 绑定(`head`/`body`) | 是 | `showPanelConfirm` | **无** |
| **V1.5.4_ / 论坛覆盖层**(≡ 不要被神隐挑战-V1.5) | 0 | 0 | realm 绑定(`.appendTo('body')` ×1) | 是 | `toggleOverlay` | **无** |

### 补列:每个组件依赖哪个预置库(对 A9 的 realm 裁定)

方案 C 下这些组件跑在**脚本 frame**(只有 script preset,**无 FA / 无 Tailwind**),
而 A9 裁的是表面 realm 用 **message preset**。所以「谁需要哪个库」直接决定谁必须落在哪。
逐**组件**量(不是逐卡 —— 其中两个是同源分叉,分居不同卡),
`scratchpad/overlay-preset-deps.mjs`:

| 组件 / 卡 | FA class token | TW class token | 自带样式 | 自带 FA 加载器 | **需要** |
|---|---|---|---|---|---|
| **手机UI / 银麒赎世** | **65** | 0 | 108 | 是 | **Font Awesome** |
| **外置状态栏 / 魔法少女的扣扣审判1.0** | **40** | 0 | 59 | 是 | **Font Awesome** |
| 银麒系统面板 / 银麒赎世 | 2 | 0 | 3 | — | FA(仅 2 个,边缘) |
| **论坛覆盖层 / V1.5.4_** | 0 | 0 | 64 | — | **Tailwind**(字面 CDN 脚本) |
| 外置状态栏 / 创世回廊1.3 | 0 | 0 | 13 | — | **无** |
| 状态栏(`2` ≡ 绿茵好莱坞) | 0 | 0 | 4 | — | **无** |
| 气泡面板(`2.1.0` ≡ 灭仇家) | 0 | 0 | 0 | — | **无** |
| 正文美化 / 可攻略女主 | 0 | 0 | 6 | — | **无** |

> **三个组件需要 script preset 没有的库**(两个要 FA、一个要 Tailwind);**其余五个什么都不需要**,
> 自带 `<style>` 就够。所以「表面 realm 用 message preset」这条**对这三个是必需的,对另外五个是免费的**。

**FA 那两个还有一层**:它们**自带 `loadFontAwesome()`**(注入 cdnjs `<link>`),
但 **cdnjs 不在 `REMOTE_ALLOWLIST` 里且 `font-src` 不随授网放宽**(§一之二 副轴之二),
所以**自带那条取不到** —— 它们的图标只能来自预置。

### 那个"看不见的浮动按钮":它不需要任何库,它需要一个能看见的 frame

`银麒赎世 / 手机UI` 的 `#mobile-trigger-btn`,源码逐字:

```js
$("head").append(phoneStyles);                       // 卡自己的 <style>
const triggerBtn = $("<button>", {
  id: "mobile-trigger-btn",
  html: '📱<span id="phone-float-badge" style="display:none;…">…'   // ← 内容是 emoji
});
```

```css
#mobile-trigger-btn {
  position: fixed; top: 50%; right: 33.33%; transform: translateY(-50%);
  width: 60px; height: 60px; border-radius: 50%;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border: none;
}
```

| 问 | 答 |
|---|---|
| 元素 | `<button>` |
| 内容 | **emoji `📱`**(外加一个默认 `display:none` 的角标 `<span>`) |
| FA 类 | **无** |
| Tailwind 类 | **无** |
| 内联 `background` / data URL | **无背景图**;背景是**卡自己 CSS 里的 `linear-gradient`** |
| 样式由谁给 | **卡自己**(`$("head").append(phoneStyles)`) |

> **regions 报 61×61 本身就证明那份 CSS 生效了** —— 一个无样式的空 `<button>` 不会是 60×60 圆形。
> **所以它不是没画出来,是画在了看不见的地方**:`position:fixed` 相对的是**脚本 frame 的视口**,
> 而那个 frame 今天是 `left:-9999px` 的 0×0 挂点。
>
> **这一条的修法就是方案 C 本身(给脚本 frame 一个全视口表面),与预置库无关。**
> 反过来说:**方案 C 落地后它应当立刻可见,不需要等 FA/Tailwind** —— 这给了 C 一个
> **不受库缺失干扰的干净判据**。

目标容器:`银麒赎世`/`魔法少女` 挂在宿主 `body` 上并操作自建的 `#phone-app-*`;
`状态栏` 建 `#fm-phone-container` 并往 `head` 注 `#fm-phone-css`;`创世回廊1.3` 往 `head`
注字体 `link` 与 `#rpg-remixicon`;`V1.5.4_` 是 `$('<iframe>')…appendTo('body')`。
**五个组件全部是全视口,且全部没有 `pagehide`/`beforeunload` 自清。**

### 两条不同的宿主页路线 —— 这才是第二样本的价值

| | realm 绑定路线 | 显式 parent 路线 |
|---|---|---|
| 卡 | V1.5.4_、创世回廊1.3、状态栏 | 银麒赎世、魔法少女的扣扣审判1.0 |
| 形状 | `$('body')` / `.appendTo('body')`,**全文没有 `parent` 这个名字** | `window.parent !== window ? $(window.parent.document.body) : $('body')` |
| **能不能被虚拟 parent 拦住** | **不能**——没有任何可拦截的名字,靠的是一个库的 realm 绑定 | **能**——走 `window.parent`,是个可拦截的名字 |

> **所以只测 V1.5.4 不只是「样本少」,是只测到了两条路线中的一条**,而且是**不可拦截的
> 那一条**。一个只处理 `parent` 的实现在 V1.5.4 上会绿,在银麒赎世上也会绿(它有
> `window.parent !== window` 分支会走 fallback),**但两者绿的原因完全不同**。

### 一个原来没人列的兼容面:卡直接操作宿主 App 自己的元素

银麒赎世那 18 个 `parent.document` 里,大部分是读视口尺寸
(`documentElement.clientWidth/clientHeight`),**但有一处不是**:

```
14174: let targetDocument = document;
14175: if (window.parent && window.parent !== window) {
14177:   targetDocument = window.parent.document;
14180: const originalInput = targetDocument.getElementById("send_textarea");
14181: const sendButton   = targetDocument.getElementById("send_but");
```

`send_textarea` 和 `send_but` **是 SillyTavern 自己的输入框和发送按钮**,不是这张卡建的。
逐卡核过(把选择器里的 id 与 ST `public/index.html` 的 1348 个 id 求交,并排除卡自己创建的):

> **⚠ 更正:下表只扫了脚本,漏了界面代码。** 重扫两个 population 后消费者多得多
> (`scratchpad/st-anchors-both-pops.mjs`):
>
> | 锚点 | 卡数 | 消费者 |
> |---|---|---|
> | **`#send_textarea`** | **9** | 【Sgw】又看一集、创世回廊1.3、尸变纪元、萧谴写卡助手版、银麒赎世、魔法少女是不会败北恶堕的吧!、魔法少女的扣扣审判1.0、2.1.0、2 |
> | **`#send_but`** | **5** | 创世回廊1.3、尸变纪元、银麒赎世、魔法少女是不会败北恶堕的吧!、魔法少女的扣扣审判1.0 |
> | `#chat` | 3 | 萧谴写卡助手版、银麒赎世、2.1.0 |
>
> **锚点的_集合_没变(仍是 3 个),错的是_消费者数_:`#send_textarea` 从 2 张变 9 张。**
> 也就是说「要建什么」我报对了,「有多急」我少报了 4.5 倍 —— 这一格是拿来排优先级的,
> 所以错的正是它被用来做的那件事(第二节第 5 条)。
>
> **这是本轮第三次同型 population 漏**(前两次:`parent` 写方、`__X_loaded__` 读方)。
> 三次都是**只扫了 `extractScripts` 而没扫界面正文**。已在本文件所有按 population 分的普查
> 里核对过口径。

~~下表只有 2 个组件、3 个 id。~~(原表保留作对照)

| 组件 | 期待宿主提供的元素 |
|---|---|
| 银麒赎世 / 手机UI(与其分叉 魔法少女的扣扣审判1.0 / 外置状态栏) | `send_textarea`、`send_but` |
| 银麒赎世 / 银麒系统面板 | `chat` | 但这是一类和「挂覆盖层」不同的能力:覆盖层要的是**一个 body
可以挂**,这个要的是 **SillyTavern 的特定元素存在**。我们不是 SillyTavern,这三个 id 不存在,
卡会静默地找不到——**不抛,只是功能没了**,所以它不会出现在任何报错里。

### 「第二样本」这个问题要分两问

- **纯 SCRIPT-DOM(零产界面正则、界面完全来自脚本 DOM):仍然 n=1。** 而且原来族图里写的
  「能力 2」是错的——那 2 张(`V1.5.4_` 与 `不要被神隐挑战-V1.5`)的 `论坛覆盖层` 脚本
  **逐字节相同(928,722 B,同一 sha256)**,是**一个组件挂在两个卡名下**,不是两个样本。
  已在 §一之二 族图更正。
- **「建 DOM 到宿主页」这个能力:5 个组件。** 覆盖层宿主验收测的是后者,所以**验收样本不缺,
  之前缺的是把这两问分开。**

### 谓词区分不了什么

- **最小化代码里「往 parent.document 建」与「往自己 frame 建」怎么分** —— 靠参数类型,
  不靠名字。`$('body')` 是宿主、`$(document.body)` 是自己,**压缩后仅差一对引号**。
  本节用 AST 判参数类型,所以这一对能分开;**但 `$(sel)` 里 `sel` 是变量时判不了**,
  已单独计数(银麒赎世 6、魔法少女 5、创世回廊 9、状态栏 3、V1.5.4_ 2),**没有并进任何一栏**。
- **「自己 frame 里建 DOM」是否可见,不是卡的属性。** 上游脚本 frame 是 `v-show="false"`
  隐藏的,所以往自己 body 上建等于看不见——同一份卡代码在一个不隐藏脚本 frame 的宿主里
  行为不同。**这条谓词量的是卡写了什么,不是用户会看到什么。**
- **完全绕过名字的路线量不到**:卡若通过 frame 被注入的 API(`triggerSlash` 之类)影响宿主,
  全文可以没有 `parent`、没有字符串选择器。**这类卡对任何基于名字的谓词都是隐形的。**
- **远程 bundle 看不见**照旧;内联可见(`论坛覆盖层` 928 KB 即内联)。所有数是下界。

## 七之四、`parent.X` 通道 —— 语料里没有「脚本发布、界面读」这一族

**结论先行:全语料 0 张卡的脚本往 `parent`/`top` 上写过任何名字。** 界面代码确实读
`parent.X`,但读到的 4 个名字**全部是宿主提供的**,不是脚本发布的。所以这条通道要接的
**不是「脚本 frame → 界面 frame」,是「宿主 → 界面 frame」**。
命令 `node scratchpad/parent-globals.mjs`。口径:105 个**去重后**的 `<script>` 块,来源为
界面正则 `replaceString`、greeting、内嵌世界书、以及存盘楼层里的围栏文档(同一份界面会在
上百楼重复出现,按内容哈希去重)。

> **口径更正(2026-09-03,总指挥 + 3c):「写方向 0」的范围是_卡自写脚本_。**
> `parent.Mvu` 的**写方是远程 MVU bundle** —— 3c 在实际加载的那份里核到
> `_.set(window.parent, 'Mvu', e)`(`UPSTREAM-MVU-INIT-PATH` §三之四)。**所以这一族是存在的**,
> 只是**写方在我看不见的那层、读方在我看得见的这层**。下面的 0 仍然成立,但它说的是
> 「卡自己不写」,不是「没人写」——这正是「远程 bundle 看不见 → 所有数字是下界」在此兑现。
>
> 由此还有一条前提差异:**在上游,「宿主全局」与「脚本 frame 发布的全局」是同一件事**
> (都落在 ST 页面的 window 上);**在我们这是两件**。要补的就是这个前提。

> ## ⚠ 更正(2026-09-03,由实测反例推翻):**「写方向 0」是错的,真值是 2**
>
> 面板读数报出卡在读 `parent.__辅助计算脚本_loaded__` / `__小手机脚本_loaded__` /
> `__状态栏_loaded__`,即**读方存在**。复核后写方也存在:
>
> ```
> 创世回廊1.3/辅助计算脚本  L1332   (window.parent || window).__辅助计算脚本_loaded__ = true   (in try)
> 创世回廊1.3/外置状态栏    L10882  (window.parent || window).__状态栏_loaded__     = true   (in try)
> ```
>
> **2 处写,1 张卡,两处接收者都是 `(window.parent || window)`,都在 try 里。**
> 这是卡内多个脚本之间**经父窗口做加载握手**的旗标,跨 iframe 可见。
>
> **我的谓词为什么漏:不是"计算属性名"(那一条我本来就覆盖了),是_接收者的形状_。**
> 四种写法全是**文本**模式且要求 `parent`/`top` **紧邻** `.` 或 `[`;这里 `parent` 与属性之间
> 隔着 `|| window)`,四条一条都不匹配 —— **旧谓词对这 2 处的召回率是 0/2**。
>
> **能防住的谓词是结构的,不是文本的**:「赋值语句,左侧是属性/下标访问,**且其对象子树里出现
> `parent` 或 `top`**」。这条不会被括号、`||`、`??`、类型断言或就地别名绕开
> (`scratchpad/parent-writes-ast.mjs`)。
>
> **一致性旁证**:面板读到 **3** 个旗标、语料里只有 **2** 个写方 —— 缺的那个
> `__小手机脚本_loaded__` 正属于那个**远程依赖 404 的脚本**(见 §一之二),它的写发生在
> 我看不见的远程模块里。**读方报「nothing has published」报得准确。**
>
> **下面这一节的 0 保留原样**,因为它仍然是真的、只是范围更窄:**字面直写
> `parent.X = …` 确实 0 处**。改的是那句总结,不是那张表。

### 这套握手的两端:拼法相同,realm 不同

读方找到了 —— **在界面代码里**(我上一轮只扫了 `extractScripts`,又一次population 漏),
`创世回廊1.3` 的界面文档里有一段依赖自检:

```js
function getWin() { try { return window.parent || window; } catch (e) { return window; } }
…
const win = getWin();
allOk &= checkDep('calc',      () => { try { return !!(win.__辅助计算脚本_loaded__); } catch (e) { return false; } });
allOk &= checkDep('phone',     () => { try { return !!(win.__小手机脚本_loaded__);   } catch (e) { return false; } });
allOk &= checkDep('statusbar', () => { try { return !!(win.__状态栏_loaded__);      } catch (e) { return false; } });
```

**两端的拼法完全一致,都是 `window.parent || window`,两端都没有用裸 `parent`。**
所以「`window.parent` 与裸 `parent` 落到不同对象」这条假设**在这张卡上不成立**——拼法不是断口。

**断口在拓扑:写方在_脚本 frame_,读方在_界面 frame_。** 两边各自求值 `window.parent`:
上游两种 frame 都是 ST 页面的子帧,**两个 `window.parent` 指向同一个对象**(ST 页面),握手成立;
我们这边若每种 frame 各自拿到自己的 parent,**同一个拼法在两个 frame 里指的是两个对象**。
这与本节开头那条是同一件事的另一面:**上游「宿主全局」与「脚本发布的全局」本来就是一回事。**

#### 两条互不相关的静默路径,合起来使这次失败无声

| 端 | 兜底 | 后果 |
|---|---|---|
| 写方 | `catch(e) { window.__X_loaded__ = true }` | 父窗口写被拒时**静默改写到脚本 frame 自己的 window** —— 旗标去了读方永远不看的地方 |
| 读方 | `catch (e) { return false; }` | 读被拒时**静默当作"未加载"** |

> **所以这条握手可以在_任何地方都不报错_的情况下失败**,而卡自己的界面会显示「依赖未加载」——
> 一条**卡级的错误诊断**,指向的原因是错的。验收时看到那面板上的红点,
> **不能据此判断被点名的脚本真的没加载**。

**这也是那 3 读 / 2 写不对称的解释**:`__小手机脚本_loaded__` 没有写方,因为
`小手机脚本` 的远程模块 404(§一之二),它根本没跑到写旗标那一步 —— **那个红点是真的**,
另外两个红点才是可疑的。

### 写方向:字面直写 0(但复合接收者 2,见上)

| 写法 | 命中 |
|---|---|
| `parent.X = …` / `top.X = …` | **0** |
| `parent['X'] = …` | **0** |
| `Object.defineProperty(parent, …)` | **0** |
| `Object.assign(parent, …)` | **0** |
| **(已知正例针)`window.X = …`(写自己的 window)** | **201** |

**201 那行是探针针**:自己 window 上的发布很常见,所以上面四个 0 是**真零,不是探针死了**。
脚本发布的 138 个名字(`phoneOpenForumSettings`、`handlePhoneLiveButtonClick` 等)**全部落在
脚本 frame 自己的 window 上**。

### 读方向:6 个候选,2 个是假阳性

**假阳性两个,都是局部变量名叫 `parent`,不是 `window.parent`:**

- 【Sgw】又看一集 `parent.replaceChild` ×24 —— `const parent = …` 是个 **DOM 节点**。
- 萧谴写卡助手版_V4.5.1 `parent.__list` ×6 —— `const parent = stack[stack.length-1].obj` 是个**普通对象**。

**`parent` 是个合法的普通标识符**,这是这个谓词最大的盲区:光看 `parent.X` 分不出
「跨 realm 全局」和「叫 parent 的局部变量」,**必须查同作用域内有没有声明**。

**真正的 4 个,全部是宿主提供的名字,且全部写成有兜底的探测链:**

| 名字 | 卡 | 形状 | 同步? |
|---|---|---|---|
| `Mvu` | 魔法少女是不会败北恶堕的吧! | `window.Mvu \|\| (window.parent && window.parent.Mvu) \|\| (window.top && window.top.Mvu)` | **同步** |
| `top.context` | 魔法少女的扣扣审判1.0 | `if (top.context && Array.isArray(top.context.chat))`,前一行先试 `top.SillyTavern.getContext()` | **同步** |
| `top.sendMessageAsUser` | 魔法少女的扣扣审判1.0 | `if (typeof top.sendMessageAsUser === 'function')` 后调用 | 2 同步 / 2 await |
| `top.stopAllGeneration` | 魔法少女的扣扣审判1.0 | 同上 | 1 同步 / 1 await |

`Mvu` 若在上游存在,来自**作为 ST 扩展安装的 MagVarUpdate**(跑在 ST 页面里),不是卡脚本
发布的 —— 这与「写方向 0」一致。

### 能不能用「按名 RPC 代理(异步)」——不能,而且比不做更糟

决定性的一处是 `Mvu` 拿到之后怎么用:

```js
const Mvu = window.Mvu || (window.parent && window.parent.Mvu) || (window.top && window.top.Mvu);
if (Mvu) {
  if (Mvu.events) document.addEventListener(Mvu.events.VARIABLE_UPDATE_ENDED, e => render(e.detail.stat_data));
  …
}
```

`Mvu.events.VARIABLE_UPDATE_ENDED` 是**同步读出来、当作事件名字符串**直接交给
`addEventListener` 的。异步代理返回的是 Promise:

> `addEventListener(Promise, …)` 会把监听器注册到事件名 `"[object Promise]"` 上 ——
> **永远不触发,而且不报错。** 静默、永久、不可见。

而**这些读全都带兜底链**:`parent.Mvu` **不存在**时 `Mvu` 是 `undefined`,`if (Mvu)` 为假,
整段干净跳过。

> **所以:让名字「存在但形状不对」,比名字「不存在」更糟。** 不存在被兜底链接住了;
> 返回 Promise 没有任何一层接得住。**这与存储族门面那条是同一个形状**(见 §七之二:
> 壳返回 `null` 等于首次运行,是卡本来就支持的状态;返回别的就不是)。

**可操作的判据**:凡是**属性值本身被同步当作数据用**(事件名、常量、枚举)的成员,
按名异步代理**不能**服务;只有**返回值被 `await` 或 `.then` 消费**的调用才可以。

### 把这条判据逐成员量一遍(`scratchpad/mvu-members.mjs`)

10 张卡的界面代码提到 `Mvu`。按成员分:

| 成员 | 用了几次 | 同步用的卡 | 被 await 的卡 | **异步代理能服务吗** |
|---|---|---|---|---|
| `getMvuData` | 21 | **4 张** | 1 张 | **不能** |
| `events`(`Mvu.events.VARIABLE_UPDATE_ENDED`) | 10 | **3 张** | — | **不能**(属性值当事件名) |
| `getMvuVariable` | 4 | **1 张** | — | **不能** |
| `replaceMvuData` | 10 | — | **4 张,全部 await** | **能** |

> **4 个成员里只有 1 个能被按名异步代理服务。** 这就是「按名代理不够」的量化形态。

### 但「晚到」是被容忍的 —— 这决定了补前提该怎么补

| 卡怎么应对 Mvu 缺席/晚到 | 张数 |
|---|---|
| `waitGlobalInitialized('Mvu')` | **7** |
| `typeof Mvu !== 'undefined'` 守卫 | 2 |
| `if (Mvu)` + 兜底链 | 1 |
| **完全无守卫** | **1** |

**10 张里 9 张显式处理了「Mvu 还没到」,其中 7 张就是等它。** 所以:

> **卡容忍 Mvu 晚到,不容忍它形状不对。** 补前提只需保证「最终出现的是真对象」,
> 不需要保证「第一帧就在」。

### 更要紧的一处:该把 Mvu 放在哪个 frame

按访问形状分,需求根本不在 `parent` 上:

| 需要什么 | 张数 |
|---|---|
| **跨 realm 桥**(`parent.Mvu` / `top.Mvu`) | **1**(魔法少女是不会败北恶堕的吧!) |
| **Mvu 就在界面 frame 自己身上**(裸 `Mvu` / `window.Mvu`,且**没有本地声明**) | **8** |
| 读 `stat_data`(任意途径,多数根本不碰 `Mvu`) | 22 |

而那唯一需要跨 realm 的一张,它的兜底链是
`window.Mvu || (window.parent && window.parent.Mvu) || (window.top && window.top.Mvu)`
—— **第一个就试 `window.Mvu`**。

**上面那句我写错过一版,更正在此(总指挥指出):** 我原先写成「放进界面 frame **而不是**搭桥」,
**把两者当成了互斥的两条路**。它们不是——`Mvu` 对象**活在脚本 frame**(远程 bundle 执行
`_.set(window.parent,'Mvu',e)`),要让界面 frame 的 `window.Mvu` 上出现它,**本身就得跨这道边界**。
上游的做法就是一个转发 getter,`JS-Slash-Runner/src/iframe/predefine.js:36`:

```js
// 其实应该用 waitGlobalInitialized 来等待 Mvu 初始化完毕, 这里设置 window.Mvu 只是为了兼容性
if (_.has(window.parent, 'Mvu')) {
  Object.defineProperty(window, 'Mvu', {
    get: () => _.get(window.parent, 'Mvu'),
    set: () => {},            // Mvu 脚本自己还会 _.set() 自己的变量
    configurable: true,
  });
}
```

**所以本地名字是桥的一个视图,不是桥的替代品。** 我的数没错(8 张裸 `Mvu` / 1 张 `parent.Mvu`),
错的是从数跳到机制的那一步——**又是「两步推理只查实第一步」**(§十九):
查实了「卡怎么读」,没查「上游怎么让它读到」。

**留下来的、仍然成立的结论**:一个转发 getter **同时**服务 8 张裸 `Mvu` 和 1 张 `parent.Mvu`,
所以要补的是**这一个前提**,不是两套机制。

**而两处时序细节对实现有直接约束:**

- 上面那个 `defineProperty` 包在 `if (_.has(window.parent,'Mvu'))` 里 —— **是安装时的一次性判断**,
  不是惰性转发。predefine 跑的时候 `parent.Mvu` 还没到,这个 frame 的 `window.Mvu` 就**永远不会有**。
- 兜底的是事件:`waitGlobalInitialized(global)` 先看 `_.has(window, global)`,没有就
  `eventSource.once('global_' + global + '_initialized')` 等着
  (`src/function/global.ts:17`)。**这就是「晚到被容忍」在上游的机制**,也是那 7 张卡等的东西。

> 所以门面要补的是**两件**:转发 getter **和** `global_Mvu_initialized` 这个事件。
> 只补前者,晚到的那 7 张卡等不到;只补后者,8 张裸 `Mvu` 读不到。

### 谓词区分不了什么

- **`parent` 是普通标识符** —— 见上,2/6 是局部变量。必须配合作用域声明检查。
- **本节只看界面正文里的 `<script>` 块**;界面通过内联事件属性(`onclick="parent.X()"`)
  访问的路径**没有覆盖** —— **未量**。
- **远程 bundle 内部照旧看不见**,数字是下界。
- 宿主提供的名字(`TavernHelper`/`SillyTavern`/`jQuery`/`$`/`toastr` 等)按定义排除了,
  排除清单在脚本输出里逐条打印,可反向审计。

## 七之五、界面 frame 的 TH 面 —— 三栏差集

界面代码调的宿主/TH 成员,与脚本侧成员集做差。口径:22 张卡的界面正文
(界面正则 `replaceString` / greeting / 内嵌世界书)里的 `<script>` 块**与内联 `on*=` 处理器**,
按内容去重解析、**按卡记归属**;脚本侧用 `extractScripts`。命令
`node scratchpad/th-surface-split.mjs`。

### A. 只在界面侧用 —— 现在真正咬人的那一栏

| 成员 | 卡数 | 用次 | 同步/await | 形式 |
|---|---|---|---|---|
| **`triggerSlash`** | **7** | 40 | 2 张 await,其余同步 | `TavernHelper.triggerSlash` |
| `replaceWorldbook` | 2 | 9 | 2 张 await | 裸 |
| `createChatMessages` | 2 | 3 | 2 张 await | `TavernHelper.*` |
| `getCurrentMessageId` | 2 | 4 | 1 张 await | 裸 |

**`triggerSlash` 是这一栏的重心:7 张卡、40 次,而脚本侧一次都不用。** 它是界面**独有**的能力面。

### B. 两侧都用 —— 门面必须在两种 frame 里都有

| 成员 | 界面侧卡数 | 脚本侧卡数 | 界面侧是否 await |
|---|---|---|---|
| `waitGlobalInitialized` | 6 | 6 | 有 |
| `getChatMessages` | 5 | 4 | 有 |
| **`errorCatched`** | **5** | **1** | **从不 await** |
| `toastr` | 4 | 6 | 从不 await |
| `getWorldbook` | 4 | 2 | 有 |
| `eventOn` | 4 | 10 | 从不 await |
| `getVariables` | 2 | 4 | 有 |
| `setChatMessages` | 2 | 4 | 有 |
| `eventEmit` | 1 | 3 | 从不 await |
| `getOrCreateChatWorldbook` | 1 | 1 | 有 |
| `createWorldbookEntries` | 1 | 1 | 有 |
| `getLastMessageId` | 1 | 1 | 从不 await |

**`errorCatched` 界面侧 5 张、脚本侧只有 1 张 —— 界面侧用得比脚本侧多。** 爱衣不是特例,
同形状还有 可攻略女主拒绝被攻略、尸变纪元、魔法禁书目录、`2`。而且**界面侧从不 await 它**。

### C. 只在脚本侧用 —— 不含界面工作量

`EjsTemplate`、`eventOnce`、`eventRemoveListener`、`generate`、`generateRaw`、`getPreset`、
`injectPrompts`、`replaceScriptButtons`、`replaceVariables`、`substitudeMacros`

### 面板报的两个 Absent global,一个真咬一个不咬

- **`toastr`:真的。** 界面侧 **4 张卡、63 次**(OVERLORD ×24、魔法禁书目录 ×28、
  魔法少女的扣扣审判1.0 ×7、创世回廊1.3 ×4),而且**从不 await**。补。
- **`EjsTemplate`:不咬任何界面代码。** 直接数出界面正文里有 2 处提到它,但逐处看过,
  **两处都是 `context.extensionSettings.EjsTemplate`** —— 读的是 ST 的**设置键**,
  经 `SillyTavern.getContext()` 拿到,**不是那个同名全局对象**:

  ```js
  // 创世回廊1.3
  && ctx.extensionSettings) { const ejs = ctx.extensionSettings.EjsTemplate; return !!(ejs && ejs.enabled)
  // 命定之诗与黄昏之歌v3.0.4
  const ejsTemplateSettings = context.extensionSettings.EjsTemplate; if (ejsTemplateSettings) { …
  ```

  **两处都有守卫**,拿不到就降级成「EJS 未启用」。所以面板把 `EjsTemplate` 列进
  Absent globals 是**同名不同物**(第十三节),按全局对象补它不解决任何一张卡。

> **优先级:`triggerSlash`(7 张,界面独有)> `errorCatched`(5 张,界面多于脚本)>
> `toastr`(4 张,63 次)> 其余。`EjsTemplate` 全局不在这条线上。**

### `triggerSlash` 子表 —— 命令面只有 3 个

**先纠一个我自己的数:上面写的「40 次」是_标识符_计数,不是调用数。** 同一批文本三种口径:
**子串 42 / 标识符 40 / 真实调用点 22**。差额几乎全是
`if (typeof triggerSlash === 'function') { triggerSlash(…) }` —— **一次守卫 + 一次调用,
每个调用点贡献 2 个标识符**。**要给实现定工作量,用调用点 22。**

| 命令 | 卡数 | 次数 | 在管道里 | 用返回值 | 参数是模板 |
|---|---|---|---|---|---|
| **`/trigger`** | **5** | 15 | 12 | 2 | 12 |
| **`/send`** | **4** | 12 | 12 | 2 | 12 |
| `/echo` | 1 | 5 | 0 | 0 | 0 |

> **全语料界面侧只用到 3 个 slash 命令。** 不是一个宿主子系统,是三条命令 + 管道串联。

**管道:22 个调用里 12 个用 `|` 串联,而且形状高度单一** —— 全部是
`/send <正文> | /trigger`(【Sgw】又看一集 8 次、OVERLORD 1 次、萧谴 2 次、`2` 1 次)。
也就是说管道语义只需支持「前一条产出的消息交给后一条触发生成」这一种。

**参数**:模板 12 / 字面串 8 / 整个参数是变量 2。**命令名本身在 20/22 里是字面的**,
变的是正文。

**返回值**:`await` 4 次,**真正把返回值用掉的只有 2 次**(都在 萧谴写卡助手版_V4.5.1)。
其余 20 次是「发出去就不管」。

**静态拼不出命令名的:3 个调用** —— 2 个参数整体是变量(`triggerSlash(command)`,
【Sgw】又看一集 与 魔法少女的扣扣审判1.0 各一),1 个是管道中段被 `${…}` 占据
(`/send …|${…}|/trigger`)。**这 3 个是这份名单的下界来源。**

#### 守卫:一半的卡自己接住了缺席

| 卡 | 调用 | `typeof` 守卫 | else 分支 | 其他 |
|---|---|---|---|---|
| 【Sgw】又看一集 | 9 | **9** | 2 | — |
| 尸变纪元 v0.5(NSFW) | 5 | **5** | 1 | try/catch |
| 魔法少女的扣扣审判1.0 | 1 | **1** | 1 | try/catch |
| 2 | 1 | **1** | 1 | try/catch |
| **OVERLORD不死者之王** | 2 | **0** | 0 | — |
| **萧谴写卡助手版_V4.5.1** | 2 | **0** | 0 | — |
| **魔法禁书目录** | 2 | **0** | 0 | — |

**4 张卡(16 个调用)全部自守**,`triggerSlash` 缺席时它们走 else、打日志、界面不崩;
**3 张卡(6 个调用)一个守卫都没有**,缺席即抛。

> **所以真正会硬坏的是那 6 个调用、3 张卡。** 而且注意:这里的 `typeof` 守卫**是有效的**
> —— `triggerSlash` 是普通全局函数,不是抛异常的 getter,与 §七之二 `localStorage` 那种
> `typeof` 照抛的情形**不是一回事**。同一个写法在两处结论相反,别互相套用。

### 谓词区分不了什么

- **本节的界面侧只覆盖 `<script>` 块与内联 `on*=`。** 这个洞在本轮**当场发作过**:
  AST 把 `EjsTemplate` 判成「只在脚本侧」,而直接子串计数在界面正文里数到 2 处
  —— 那 2 处**确实在 `<script>` 里**,漏的原因是它们是 `ctx.extensionSettings.EjsTemplate`
  这种**成员位置**而非独立标识符。结论没变(它仍不是那个全局),但**聚合census 与直接计数
  不一致时,以逐条看过的为准**。
- **`toastr` 的脚本侧 871 次(银麒赎世)是子串计数**,含字符串与注释,不是调用数;
  界面侧那 63 次同理。**要排优先级用卡数,不要用次数。**
- 远程 bundle 内部照旧看不见,所有数是下界。

## 七之六、脚本执行模式 —— classic 卡脚本是 0,但那是构造出来的 0

**这一格的答案不是语料统计,是一条代码事实:**

```
apps/iris-web/src/sandbox/script-source.ts:49   modeFor(kind: 'card-script' | 'probe')
apps/iris-web/src/sandbox/script-source.ts:50   return kind === 'card-script' ? 'module' : 'classic'
```

**只有两种 kind,卡脚本恒为 `module`;`classic` 那条路只走 `probe`(Iris 自己的探针)。**
上游同样是构造性的:`JS-Slash-Runner/src/panel/script/iframe.ts` 无条件输出
`<script type="module">`,没有分支。

| | 数 |
|---|---|
| 卡脚本总数 | 58(**49 份不同内容**) |
| `module` | **49 / 49** |
| `classic` | **0** |

> **所以「classic 脚本里引用那对全局的有几张」在今天是 0,而且是_结构性_的 0
> ——不是语料里恰好没有。** 那对按下标配对的表,**没有任何一张卡在等它**。

### 但反事实那一栏很大,值得记下来

| | 数 |
|---|---|
| 引用 `waitGlobalInitialized` 的不同脚本 | **10**(6 张卡) |
| 引用 `initializeGlobal` 的 | **0** |
| 上述 10 份里**没有任何 ESM 语法**的 | **9** |
| 全部 49 份里没有 ESM 语法的 | **24**(几乎一半) |

| 脚本 | ESM? | `waitGlobalInitialized` | `typeof` 守卫 | 卡 |
|---|---|---|---|---|
| 论坛覆盖层 | **yes** | 6 | 2 | V1.5.4_ |
| 手机UI | NO | 4 | 1 | 银麒赎世 |
| 章节管理器 | NO | 4 | 2 | 魔法少女的扣扣审判1.0 |
| 外置状态栏 | NO | 4 | 1 | 魔法少女的扣扣审判1.0 |
| MVU | NO | 3 | 1 | 2.1.0 |
| MVU好感度管理系统 | NO | 1 | **0** | OVERLORD不死者之王 |
| MVU升级系统 | NO | 1 | **0** | OVERLORD不死者之王 |
| MVU阵营系统 | NO | 1 | **0** | OVERLORD不死者之王 |
| 辅助计算脚本 | NO | 1 | **0** | 创世回廊1.3 |
| 游戏引擎 | NO | 1 | **0** | V1.5.4_ |

**10 份里 5 份没有守卫**,缺席即抛;另 5 份有 `typeof` 守卫(这里的守卫**有效**,
`waitGlobalInitialized` 是普通函数,不是抛异常的 getter —— 与 §七之二 的 `localStorage` 相反)。

> **可操作的结论:今天不用修那对表;但如果谁给执行模式加一个"看源码猜"的嗅探器,
> 这 9 份就会被判成 classic 而失去那对全局,其中 5 份连守卫都没有。**
> `modeFor` 现在按 **kind** 决定而不是按源码决定,**这正是它对的地方**
> ——`script-source.ts` 的注释已经写明「不发明嗅探器,否则卡的行为会因卡作者无法预测的
> 理由而不同」。这一节给那条注释配上了数字:**嗅探器会误判 49 份里的 24 份。**

### 一条与 §七之四 相互印证的旁证

**`initializeGlobal` 全语料引用 0 次,而 `waitGlobalInitialized` 有 10 处。**
卡只**等**全局,从不**发布**全局 —— 这与 §七之四 用完全不同的量法得到的
「卡脚本往 `parent`/`top` 写 0 次」是同一个事实的两次独立观测。

## 七之七、出厂即坏的卡:解析期 SyntaxError

**`可攻略女主拒绝被攻略 / 插入状态栏`(874 B,27 行)在任何 JS 引擎里都解析不了。**
判定用的是 `extractScripts` 取出的**存储原文**,未经我们任何处理
(`scratchpad/parse-check-statusbar.mjs`):

```
TypeScript parser : line 22 col 23  Unterminated regular expression literal.  (+6 条后续)
V8 (new vm.Script): SyntaxError: Invalid regular expression: missing /
```

**V8 的报错逐字等于面板报的那条。** 形状(CJK 已按长度打码):

```
22 |     msg = msg.replace(/
23 | <Status…21\/>|$/s, '
24 | <Status…21/>');
```

**正则字面量在 22 行行尾开启、模式体续到 23 行 —— JS 的正则字面量不能跨行**,
所以那个 `/` 永远收不了尾;23–24 行那个单引号字符串同样跨行。

### 三条推论

1. **上游同死。** 这不是我们的源变换问题(7b 据此停止了变换侧排查),module 或 classic 都一样。
   **这个脚本在任何地方都没有跑过。**
2. **这是 METHODS 第三节「解析期失败只能从外面看」的实例**:frame 内的 try/catch
   来不及存在,所以**卡作者自己也看不到它坏了**——它只以「少了一个状态栏」这种沉默形态存在。
   **我们的面板把它显式报出来,是比上游多做的事,不是缺陷。**
3. **单脚本级失败**:同卡另外 3 个脚本(`变量结构`/`MVUbeta`/`正文美化`)正常。
   **不要记进存储族或任何门面的账上。**

> **验收含义:这张卡的正确表现就是"报一条解析错误、其余三个脚本照跑"。**
> 若某次实现让它"看起来好了",那说明我们吞掉了一条真实的语法错误。

## 七之八、嵌套 iframe 族 —— 五张卡,四种需求,只有一种是坏的

口径:**两个 population**(`extractScripts` + 界面正文),按卡记归属,内容去重。
命令 `node scratchpad/nested-iframes.mjs` / `iframe-read-targets.mjs`。
**全语料没有一张卡给自己的 iframe 加 `sandbox` 属性(0 处)。**

### A. 自建 iframe

| 卡 | population | 形式 | src / srcdoc | 父侧读什么 | 需要什么 |
|---|---|---|---|---|---|
| 【Sgw】又看一集 | iface | `<iframe>` 字面 **×28** | `src='//music.163.com/outchain/player?…'` | **无** | **什么都不需要**(纯嵌入播放器) |
| 创世回廊1.3 | iface | `<iframe>` 字面 ×1 | `src='https://tangquanghuy.github.io/dnf/map.html?v=10'` | `contentWindow.postMessage` ×1 | **已经可用** —— `postMessage` **跨源本来就通** |
| **V1.5.4_** | **script** | `$('<iframe>')` + `<iframe>` 字面 | **`srcdoc`** ×1 | **`contentDocument` ×2** | **同源可达** ← 现在坏的就是这条 |

> **28 个里 27 个不需要我们做任何事。** 把"卡自建 iframe"当成一个需求会把面放大 28 倍;
> **决定需求的是父侧读什么,不是它建了几个。**

### B. 不自建、但读别人的 frame(**帧发现**,和 A 是两件事)

| 卡 | 怎么找 | 读什么 | 守卫 |
|---|---|---|---|
| 萧谴写卡助手版_V4.5.1(iface) | **不是全页扫描**:`$(parent.document).find('#chat')` → `.children('.mes')` → 每条消息内 `find('iframe')` | `iframe.contentDocument \|\| iframe.contentWindow.document`,找 `fixedUuidInput` | 有 try |
| **银麒赎世 / 银麒系统面板**(script) | `_pd = _pw.document` → `_pd.querySelectorAll("iframe")` | `contentWindow.phoneAPI`、`contentWindow.postMessage` | `if (fw && fw.phoneA…)` |

#### 银麒赎世 这条对「虚拟 parent」提了一个没人列过的要求

- **`手机UI` 把接口发布在 `window.phoneAPI`**(84 处直接引用、1 处赋值)。
- **`银麒系统面板` 从不读 `window.phoneAPI`(0 处)** —— 它只用**帧发现**:
  取 `_pw.document`(父文档)→ 枚举 iframe → 逐个试 `contentWindow.phoneAPI`。

一卡一 frame 下两个脚本共享同一个 `window`,所以 `phoneAPI` 其实**就在手边**,
但这张卡不往那儿看。它能成立的唯一路径是:**在父文档的 iframe 列表里找到_自己那个 frame_,
再读它的 `contentWindow`。**

> **所以虚拟 parent 要满足两条,缺一条这张卡的面板就哑:**
> ① `parent.document.querySelectorAll('iframe')` **要能枚举到卡自己的 frame**;
> ② 那个 iframe 元素的 **`contentWindow` 要可读**(同源)。
>
> 而它的守卫是 `if (fw && fw.phoneAPI)` —— **两条都不满足时它静默跳过**,
> 与 §七之四 `__X_loaded__` 那套一样:**没有报错,只是面板永远不亮。**

### C. 这一族要支持的访问,按"必须同源"分

| 访问 | 谁用 | 跨源能用吗 |
|---|---|---|
| `contentWindow.postMessage` | 创世回廊1.3、银麒赎世 | **能** —— 不需要我们做事 |
| `contentDocument` | V1.5.4_、萧谴写卡助手版 | 不能 |
| `contentWindow.document` | 萧谴写卡助手版 | 不能 |
| `contentWindow.<自定义名>` | 银麒赎世(`phoneAPI`) | 不能 |

> **更正:上面那行原写作「遍历页面上全部 iframe」,不准确,而这处不准确会指错修法。**
> 它遍历的是 **`#chat` 下每条 `.mes` 里的 iframe** —— 也就是**消息 frame**(我们渲染的
> 每层界面),不是它自己建的、也不是任意页面 frame。**它的需求因此是:
> ① `#chat` / `.mes` 的 DOM 结构存在(它已在 §七之五 的 `#chat` 三张卡里);
> ② _消息 frame_ 的 `contentDocument` 从界面 frame 可读。**
> 与 V1.5.4 那条(自建 srcdoc frame)**是两个不同的表面**,不要合并成一件事。

**净结论:需要"同源可达嵌套/兄弟 frame"的是 3 张卡** —— V1.5.4_(自建 srcdoc)、
萧谴写卡助手版(遍历)、银麒赎世(遍历 + 自定义名)。**创世回廊只用 postMessage、
【Sgw】只嵌入不读,这两张不在需求面内。**

### D. 补表:div 替身会被什么认出来(对裁定 (A))

裁定 (A) 用**带 shadow root 的 div 替身**替换 `createElement('iframe')`。替身的弱点是**身份**。
逐条扫两个 population(`scratchpad/iframe-identity-checks.mjs`):

| 探针 | 命中 | 替身覆盖? |
|---|---|---|
| `tagName === 'IFRAME'` | **0** | — |
| `nodeName === 'IFRAME'` | **0** | — |
| `matches('iframe')` / `closest('iframe')` | **0** | — |
| `querySelector('iframe')`(单个) | **0** | — |
| `getElementsByTagName('iframe')` | **0** | — |
| `instanceof HTMLIFrameElement` | **1**(V1.5.4_,打包进来的 style-loader) | **不覆盖** —— 但见下,**这处是死代码** |
| **`querySelectorAll('iframe')`** | **3 张卡 / 12 处** | **不覆盖 —— 返回空数组,静默** |
| jQuery `.find('iframe')` | 1(萧谴,消息 frame) | **不覆盖** |
| `contentDocument` / `contentWindow` | 2 / 3 张卡 | **覆盖**(替身正为此存在) |
| `srcdoc` **读**(用于认帧) | 1(V1.5.4_ 复用扫描) | 覆盖,但要能被 `querySelectorAll` 找到才用得上 |
| `allow` / `sandbox` / `referrerPolicy` | **全 0** | **不用支持** |
| `frameborder` | 29(纯装饰) | 无所谓 |
| `loading="lazy"` | 2 —— **都在 `<img>` 上,与 iframe 无关**(假阳性,已排除) | — |

> **好消息是这一列几乎全零:卡不检查 iframe 的_类型_,只检查它_找得到_。**
> 真正的风险面只有一个动作:**`querySelectorAll('iframe')` 找不到替身**。

#### 两处会改变工作量的更正

**① V1.5.4 里那处 `instanceof HTMLIFrameElement` 是死代码,不用管。**
style-loader 的插入目标是 `IA.insert = wA().bind(null,'head')` —— `document.querySelector('head')`,
**永远不是 iframe**,所以那个 `instanceof` 分支在这张卡上**本来就不会进**。3c 点出它是对的,
但**它不在这条路径上**。

**② 真正把样式送进覆盖层的是另一个类,它要的是 `ownerDocument`:**

```js
class RA {
  targetHead                                   // = 覆盖层 iframe 的 contentDocument.head
  sync () {
    const e = []
    for (const n of document.styleSheets)      // ← 读脚本 frame 自己的样式表
      try { for (const t of n.cssRules) e.push(t.cssText) } catch {}
    const n = this.targetHead.ownerDocument    // ← 用它 createElement
    this.targetHead.querySelectorAll('style[data-style-sync]').forEach(e => e.remove())
    …
  }
}
```

**所以「只给 `contentDocument` 替身、不给 `ownerDocument.createElement`」这条也会绿是精确的**
(§九.4之二),现在有源码支撑。**而且它有第二条独立失效路径**:`sync()` 读的是
`document.styleSheets` 的 `cssRules` —— **若样式改放进 shadow root 而不进 `document.styleSheets`,
这里收集到的就是空的**,同样"挂上了但没样式",且 `catch {}` 吞掉一切。

#### `querySelectorAll('iframe')` 的 12 处,按后果分

| 卡 | 处数 | 找不到时会怎样 |
|---|---|---|
| **银麒赎世 / 银麒系统面板** | **10** | `if (fw && fw.phoneAPI)` **静默跳过** → 系统面板永不亮(§七之八 B) |
| 创世回廊1.3(iface) | 1 | 向所有 iframe 广播 `postMessage`,**广播给空集** → 地图不更新,无报错 |
| V1.5.4_ / 论坛覆盖层 | 1 | **复用扫描**(靠 `t.srcdoc.includes('viewport-fit=cover')` 认旧帧)找不到 → 复用分支失效。**但 `window.__forumOverlayMounted` 仍然拦着**,所以结果是"第二次什么都不做"而不是"叠一层新的" —— 除非那个标志所在的 window 被换掉 |

**口径边界**:`<iframe>` 字面计数含**界面正文里的静态 HTML**,那些在渲染前不是活的 frame;
计入是因为它们渲染后会成为真 frame,但它们**没有父侧读**,所以不影响需求面。
运行时拼接 `src` 的站点这里看不到 —— 与全文其它普查同一条**下界**说明。

## 八、未量

- **渲染后的一切。** 三张卡还没有 chat,没有进 dev 数据目录,所以 frame 楼数、片段带、
  `<pre>` 归属、`<style>` 作用域、实际外链请求,**一条都没量**。等 49 导入后另量。
- **`www.w3.org` 是不是真加载。** 它多半是 SVG 的 `xmlns` 字面量;要确认得看它在什么
  位置出现,我只数了域名。
- **`@beta` 分支与主线的 API 差异。** 只记了它用的是 `@beta`,没有对比两个 bundle 的导出面。
- **1.55 MB 脚本的注入行为。** 体积记了,注入是否成功、解析期是否整块失败,要在浏览器里读。

---

## 九、验收单(浏览器验收时照着走)

> 操作表,不是论证。**只写已量到的事实**,没量到的写「未量」。
> 每族四行:代表卡(**按组件去重后**)/ 必测变体 / **打开后该看到什么** / **最近的错误实现会怎样也绿**。
> 「最近错误实现」那行按 §十九:**一个所有候选实现都满足的观察,不构成验收。**

### 两条通则(每一格都适用)

**① 屏幕现象不作为归类依据,console 才是。** 实测过四种不同原因产出同一幅「界面不出现」:
存储启动即死、解析期 SyntaxError、远程 404、宿主锚点缺失。**按屏幕归类会把四类缺陷记成一类。**

**② 成功与失败在屏幕上完全一样的卡,不能进「看一眼」的格子。**
不是"难验",是**这一格问错了问题**:观察在两个假设下取同一个值,鉴别力为零(§十九)。
这类卡要降为脚注,并写明**替代仪器**——一个与卡无关、能独立回答的二值事实。
**判断方法:把它的失败路径逐条读出来,若每条都是 `return`/静默兜底且不改 DOM,就是这一类。**

### 1. FRAME-FENCED(见 18)
- **代表**:创世回廊1.3。**变体**:OVERLORD(4 界面正则 + 内嵌书 EJS)、爱衣(与 FRAGMENT 混合)。
- **该看到**:消息体内是**渲染后的面板**,看不到反引号、看不到 HTML 源码。语料里 179 个楼层的
  `<pre>` 文本满足 `is_frontend`(含 `html>`/`<head>`/`<body` 之一)。
- **也会绿**:把围栏当**普通代码块**渲染 —— 屏幕上同样"有内容"。**要认的是面板,不是"非空"。**
- **状态**:未过(浏览器验收未做)。

### 2. FRAGMENT / 内联(见 5)
- **代表**:爱衣。**变体**:命定之诗 v3.0.4(887 楼,最大)、希尔(同时属 FRAME-BARE)。
- **该看到**:块级 HTML **内联在消息流里**,没有独立文档边界。爱衣的判据是字符数:
  **渲染前 3,837 / 渲染后 13,359**。
- **也会绿**:markdown-placement 正则**没跑**的实现同样"有内容"(3,837 那份就是内容)。
  **必须读渲染后字符数**,不是看有没有东西。
- **状态**:未过。

### 3. GREETING-DOC(见 0 / 能 **2 份不同的 greeting**)
- **代表**:2.1.0。**变体**:干物吸血鬼少女(445 B)。**灭仇家满门… 不是第三个样本**——
  它和 2.1.0 的 `first_mes` **逐字节相同**(16,013 B,sha `d10275034aff`)。
- **该看到**:建号后**第一楼正文 = `first_mes` 展开宏之后的文本**(`chats.ts:455` 跑 `expandMacros`)。
- **也会绿**:**原样存**看起来完全一样。
- **语料里没有能分开这两者的样本 —— 实测 0,这一格只能靠合成夹具。** 见下。
- **状态**:未过。「见 0」是定义造成的:得用 `first_mes` 对存盘首楼,不能用渲染后文本。

#### 找过了:带宏的文档 greeting,全语料 0(`scratchpad/greeting-macros.mjs`)

扫了 22 张卡的 **81 条 greeting**(`first_mes` + 全部 `alternate_greetings`):

| | 条数 |
|---|---|
| 含任意 HTML 标签 | 55 |
| **是整篇文档**(`is_frontend`:含 `html>` / `<head>` / `<body`,围栏或裸) | **3 条,2 份不同** |
| **既是文档、又含宏** | **0** |
| 其中宏在 `<script>` 内(最锋利那格) | **0** |

**三条文档 greeting 各自都有 1 个 `<script>` 块,但块里一个宏都没有。**
这逐字证实了原先那句判断:先前那三张卡 byte-for-byte 相同**是样本性质,不是路径性质**。

**整个 greeting 面上的宏只有两种写法,合计 53 处:`{{user}}` × 51、`{{User}}` × 2。**
`{{char}}`、`{{random:…}}`、`{{roll…}}`、`{{getvar…}}` 在 81 条 greeting 里**一次都没出现**。

带宏的 greeting 确实有,但都不是文档,而且**宏全部落在文本节点**——属性值 0、`<script>` 内 0、
`<style>` 内 0:

- HTML 片段 + 宏:8 条(OVERLORD alt[0]、【Sgw】又看一集 alt[7]/alt[8]、可攻略女主 `first_mes`、
  终焉之刻NG alt[4]/alt[6]…),全部 `{{user}}`,全部文本节点。
- 纯文本 + 宏:3 条(银麒赎世 `first_mes` × 13 最多)。

#### 合成夹具的规格(从真卡上改一处,不要凭空写)

按团队规矩夹具从真卡抄。**取 2.1.0 的 `first_mes` 原文**(16,013 B;结构:`<Gui>` 包了一个
` ```html ` 围栏,里面是完整文档;`<script>` 块 4,027 B,是个 IIFE,末尾把
`rvrGo`/`rvrDone`/`rvrCopy`/`rvrPick` 挂到 `window` 上),**只改一处**:在那个 IIFE 里加一行
形如 `var WHO = "{{user}}";` 并把 `WHO` 写进面板 DOM。

这样两种实现的差别是**可见且不同层**的:

- 展开:面板上显示 persona 名。
- 原样存:面板上显示字面量 `{{user}}`。
- **而且这一格比文本节点锋利**:如果实现是「原样存、渲染时再做纯文本替换」,那次替换会
  **一并打进 `<script>` 里**——persona 名里只要有引号或反斜杠就**改变脚本语义甚至语法**。
  文本节点那 8 条 greeting **量不到这条**,因为那里替换坏不了东西。

夹具用 `{{user}}` 而不是 `{{char}}`,因为 `{{user}}` 是语料里**唯一**真实出现的宏(51 处)。

### 4. SCRIPT-DOM / 覆盖层 —— **两条路线各一张**
- **代表**:V1.5.4_ / 论坛覆盖层(**realm 绑定**)+ 银麒赎世 / 手机UI(**显式 parent**)。
- **该看到**:全视口固定层(`fixed` + `100vw/100vh` + `z-index:9999`);
  V1.5.4_ 有 `toggleOverlay`,银麒赎世有 `openAppPanel`/`closeAppPanel`。
  ST 锚点 `send_textarea`/`send_but`(手机UI)、`chat`(银麒系统面板)。
- **切卡/切聊天后要专门看残留**:**五个组件全都没有 `pagehide`/`beforeunload` 自清**。
- **也会绿**:只处理 `parent` 的实现在**银麒赎世上也绿** —— 它有 `window.parent !== window` 分支会走
  fallback;**两张绿的原因不同**,而 realm 绑定那条(V1.5.4_)**没有任何可拦截的名字**。
- **状态**:方案 C 施工中(见下)。

#### 方案 C 验收单(对 `apps/iris-web/OVERLAY-HOST.md` b82ac8f)

方案 C = **脚本 frame 自己就是全视口覆盖层表面**(`position:fixed; inset:0;
pointer-events:none; background:transparent`)。路线 ①(`$('body')` 落自身 body)与
路线 ②(虚拟 `parent.document` 已指向该 body)**自动成立**,所以下面每一格量的是
「表面真的在那儿了吗」,不是「管线通了吗」。

**逐组件:落地后该看到什么**

| 组件 | 该看到 | **最近的错误实现也会绿** |
|---|---|---|
| V1.5.4_ / 论坛覆盖层 | 覆盖层**可见且可点**(有 `toggleOverlay`) | 只给 `pointer-events:none` 的层、卡自己的节点没恢复 `auto` → **可见但点不动**。判据要包含"点一下有反应",不是"看得见" |
| 银麒赎世 / 手机UI | 浮动按钮出现,可拖;`openAppPanel`/`closeAppPanel` 有反应 | 层出现了但 `z-index` 低于阅读区 → 截图里"有",实际被盖住。判据:**点击命中的是按钮不是它下面的东西** |
| 魔法少女的扣扣审判1.0 / 外置状态栏 | 状态栏出现(与手机UI 同源分叉,键名/函数名成套一致) | 与上一行同一组件的两个版本 —— **两张都过不构成两个样本**(§一之二 去重) |
| 创世回廊1.3 / 外置状态栏 + 状态栏 | 两个面板都出现 | 见下「跨脚本节点」那条 |
| 可攻略女主 / 正文美化 | **字体工具栏出现在阅读区** | 工具栏建出来了但仍在不可见 frame → 之前正是这个形态;**要看它是否可见,不是 console 是否干净** |

**三个 ST 锚点,各自的可观察判据**(与方案无关,任一方案下都要做)

| 锚点 | 卡数 | 判据 | **也会绿** |
|---|---|---|---|
| **`#send_textarea`** | **9** | 写值 → 点击 → **消息真的发出**,且出一条 note 说明是卡代发的 | 提供一个**接受写入但不发送**的假节点:卡的代码路径全绿、用户什么也没看到 |
| **`#send_but`** | **5** | 同上(两者成对使用) | 同上 |
| `#chat` | **3** | 新楼层到达时,`银麒系统面板` 的观察者在 **100 ms 内重注入** | **就地改文本而不新增节点**的实现 → `MutationObserver` 的 `childList` 不响;判据必须是"新增了节点",不是"内容变了" |
| `#mes_stop` | — | 生成中**可见**,生成结束**消失** | 常驻但 `display:none` 的桩:`querySelector` 拿得到、卡以为在生成中 |

**卡数取自两个 population 的重扫**(`scratchpad/st-anchors-both-pops.mjs`)。
**`#send_textarea` 的 9 张卡里只有 1 张的用法在脚本里,其余 8 张全在界面代码里** ——
所以这三个锚点的验收**必须在界面 frame 起来之后测**,只测脚本侧会漏掉 8/9。
`#mes_stop` 没有卡数,因为它来自 7b 的生成状态三条腿,不是我从语料数出来的。

**方案 C 特有的记账:切开的是_跨卡_,不是跨脚本**

> ~~方案 C 下每个脚本 frame 一层,所以 `银麒系统面板` 查不到 `手机UI` 建的
> `#phone-app-body`。~~ **这一条是错的,已撤回(总指挥指出,复核确认)。**
>
> 共居粒度写在 `apps/iris-web/src/app/useCardScripts.tsx:164` 的注释里,原文:
>
> > `One frame for the card's whole set. Each script still evaluates as its own`
> > `module, so their top-level bindings stay separate; what they share is`
> > `window, which is what lets a provider hand a live interface to its siblings.`
>
> **一张卡的全部脚本共居一个 frame、共享同一个 `window` 与 document**,只是各自作为独立
> module 求值。所以 **`#phone-app-body` 在方案 C 下查得到**,与上游一致。
>
> 我错在**从方案描述("脚本 frame 就是表面")推拓扑,而没有去读 frame 是怎么分配的** ——
> 与 FA 那次「两步推理只查实第一步」同一形状:读了"表面是什么",没读"有几个表面"。

**真正被切开的是跨卡**:一卡一 frame ⇒ 两张卡各一层,**A 卡的节点对 B 卡不可见**,
而上游是同一个共享 body。

**语料里今天有没有消费者:没有观察到。** 单聊里同时只有一张卡的脚本在跑。
**这条要变成真问题,需要"多张卡的脚本同时活"** —— 即群聊类场景。**未量**(本地语料 31 个
chat 都是单角色)。所以它是**与上游的一处已记账偏离,当前无语料消费者**,不是待修缺陷。

**同卡跨脚本的耦合仍然值得记,因为它说明"共享 window"不是可选项**:
逐卡查过 15 张多脚本卡(`scratchpad/cross-script-dom.mjs`),**命中 1 张** ——
`银麒赎世` 的 `银麒系统面板` 查询 `#phone-app-body`(由 `手机UI` 创建)。
**在共居 frame 下这条正常工作**;若将来有人把粒度改成"一脚本一 frame",**这张卡会立刻断**,
而它是全语料唯一会断的那张 —— **粒度改动的验收样本就是它**。

口径:**下界** —— 运行时拼接的 id 两侧都看不见,1 是"至少 1",零不能读成"没有耦合"。

#### 经 parent 取 jQuery:2 张卡,而且卡自己的兜底就是那份静默

3c 查到 `银麒赎世 / 银麒系统面板` 的 `$p()` 经虚拟 parent 取不到 `$`,258 处空转。
**逐卡核过这个惯用法**(`scratchpad/parent-jquery-helpers.mjs` + `dollar-helper-bodies.mjs`):

```js
// 银麒赎世 / 银麒系统面板
_pw = window.parent || window;
function $p(sel) {
  var jq = _pw.$ || _pw.jQuery;
  if (!jq) return $();        // ← 兜底:返回一个空 jQuery 集合
  if (sel === undefined) return jq;
  return jq(sel);
}
```

> **静默不是我们造成的,是卡的兜底造成的:`return $()` 返回_空集_,而 jQuery 在空集上的
> 每个方法都不做事、也不抛。** 258 次调用全部"成功"。这与 §七之二 壁纸那条同形 ——
> **卡在失败路径上给出了一个看起来正常的返回值**,所以我们的报告是唯一通道。

**命中 2 张卡,不是 1 张:**

| 卡 / 位置 | 形式 | 次数 | 用途 |
|---|---|---|---|
| 银麒赎世 / `银麒系统面板`(脚本) | `$p()` 包装 `_pw.$ \|\| _pw.jQuery` | **258** | 全脚本的 DOM 访问 |
| 魔法少女的扣扣审判1.0 /(界面) | 直接 `top.jQuery(...)` | **6** | **`#send_textarea` / `#send_but` 备用发送路径** |

**第二张的用途正好压在三个 ST 锚点上** —— `top.jQuery('#send_textarea').val(...)` 然后
`top.jQuery('#send_but').trigger('click')`。**所以"虚拟 parent 暴露 jQuery"与"提供 ST 锚点"
这两件事在这张卡上是串联的**:只做一件,它的备用发送路径仍然静默无效。

**排除的假阳性**:`V1.5.4_ / 游戏引擎` 的 `$n×51` / `$e×10` 是**压缩后的局部名**
(`$n` 是 Mvu 包装、`$e` 是正则常量与计分函数),该脚本**全文没有 `parent`** —— 不是这一族。
**`const $ = parent.$` 这种重绑定全语料 0 处**,所以不存在"后续每个 `$(...)` 悄悄改了含义"
的那种最坏形态。

**方案 A/B 落地后才增加的判据**(现在不测):`parent.Mvu` 转发 getter + `global_Mvu_initialized`
事件(§七之四);创世回廊那三个红点**只应剩 `phone` 一个**(§七之四末)。

### 4 之二. 嵌套 iframe 族(3 张卡,三个不同表面;**可观察的只有 2 张**)

对 §七之八 与 3c `§六之四`。**三张卡要的不是同一件事**,分开验收:

**可观察验收的只有两张:**

| 卡 | 它要的表面 | **虚拟化后该看到什么** |
|---|---|---|
| **V1.5.4_ / 论坛覆盖层** | **自建 srcdoc frame** 的 `contentDocument` | 论坛覆盖层出现,**且有样式**(深底 `#0e1028`、浅字),不是白底裸 DOM |
| **银麒赎世 / 银麒系统面板** | **父文档的 iframe 列表** + 自己 frame 的 `contentWindow.phoneAPI` | **系统面板亮起** = 既枚举到了自己的 frame,又读到了 `phoneAPI` |

> **脚注:萧谴写卡助手版_V4.5.1 —— 不可观察验收,待仪器。**
>
> 它要的是**消息 frame** 的 `contentDocument`(经 `#chat` → `.mes` → `iframe`),
> 与上面两张是**第三个表面**,方案 C 下**仍然跨源**。
>
> **它不能进任何"看一眼"的格子**,因为它的失败路径逐条都是静默 `return`:
> `if (!chatElement.length) return` / `if (!mesElements.length) return` /
> 找不到 `fixedUuidInput` 就走完循环 —— **三处都不改 DOM、不写 console**。
> 于是「跨源读不到」与「读到了但这条消息里没有那个 input」**产出同一幅画面**,
> 而后者在多数消息上本来就是常态。**观察在两个假设下取同一个值 = 鉴别力零。**
>
> **替代仪器(二值,与卡无关、不需要它在场)**:
> **界面 frame 能否读到某个消息 frame 的 `document`?** 直接问这一句即可判定。
>
> **不进方案 C 的复读** —— 它的观察不可分辨,所以既不构成 C 的阻塞项,
> 也不会从 C 的读数里得到任何信息。等消息 frame 那件单独有仪器时再判。

#### 也会绿(四条,全部是"看着对但没做对")

- **只给 `contentDocument` 替身、不给 `ownerDocument.createElement`** → Vue **mount 成功**、
  DOM 齐全,**但样式加载器插不进 `<style>`** → 覆盖层出现、**样子不对**。
  **而且不会报错**:那处 style-loader 是 `try { t.contentDocument.head } catch { t=null }`
  (§七之八),**失败即静默**。所以判据必须含**外观**,不能只含"出现了"。
- **替身的 `head` 不接受 `<style>`** → 同上,同样无声。
- **iframe 枚举返回空数组** → 银麒的 `if (fw && fw.phoneAPI)` **静默跳过**,
  面板不亮、**console 干净**。「没报错」在这一格**不是好消息**。
- **srcdoc 内的 `html,body{height:100%}` 在 Shadow DOM 里没有重指 host** →
  **高度塌成 0**,DOM 全在、样式也加载了,**但什么都看不见**。
  语料实据:srcdoc 原文是 `<!DOCTYPE html><html style="height:100%"…`,
  内含 `html,body{margin:0;height:100%;background:#0e1028;…}` ——
  **这条高度链是真的,不是假想的风险**(脚本内另有 `height:100%` ×25、`100vh` ×23)。

#### 一条会造成假红的复测陷阱

`论坛覆盖层` 有**重入守卫**:`window.__forumOverlayMounted` 一旦为真就直接 `return`,
另有一条「DOM 扫描复用旧 iframe」分支(靠 `srcdoc.includes('viewport-fit=cover')` 认旧帧)。

> **所以同一会话里第二次触发会"什么都不做"。** 复测必须**重新加载 frame**,
> 否则会把重入守卫读成"覆盖层没出来"。

- **状态**:未建(等虚拟化落地)。

### 5. 流式状态栏
- **实测:全语料 `STREAM_TOKEN_RECEIVED` / `stream_token` 命中 0**(属性访问与字符串字面量两种写法都查了)。
  **没有一张卡按 token 流驱动状态栏。**
- 实际用的是**消息完成事件**(`MESSAGE_RECEIVED` / `CHARACTER_MESSAGE_RENDERED`),**10 个组件**。
- **代表**:可攻略女主拒绝被攻略 / 插入状态栏。**变体**:2 / 状态栏、魔法少女的扣扣审判1.0 / 外置状态栏。
- **该看到**:状态栏在**消息渲染完成后**更新,不是逐 token 跳动。
- **也会绿**:逐 token 刷新的实现**最终值也对**。要认的是**更新次数**,不是最终值 —— **未量**(需浏览器计数)。
- **状态**:未过。

### 6. ESM:BINDING vs SIDEEFFECT
- **代表**:创世回廊1.3(`BINDING`,`mvu_zod`,13 卡共用)+ OVERLORD(`SIDEEFFECT`,MagVarUpdate bundle,15 卡共用)。
  **变体**:V1.5.4_ 的 `pinia`(唯一非卡生态库)。
- **该看到(取不到时的差别,这才是这一族的全部)**:`BINDING` 失败 → **整个脚本模块一行都不执行**,界面完全没有;
  `SIDEEFFECT` 失败 → **只有那个库不可用**,界面在、变量不动。
- **也会绿**:**网络正常时两者都绿。** 必须挡掉 CDN 才有鉴别力。
- 语料:11 个去重地址、3 个 host、**6 个不写版本(jsdelivr 发 HEAD)**;`localhost:5500` 那条按设计就该报错。
- **状态**:未过。

### 7. MVU 聊天级
- **代表**:OVERLORD(MVU + 2 脚本)。**变体**:长聊天 `22 - 2026-01-20…`(677 消息)。
- **该看到**:`stat_data` 与 `schema` **同时存在**才算 MVU 数据;**楼层 0 永不清理**;
  快照间隔 **50**、保留最近 **20** 楼(三处交叉确认过:磁盘分布 / `settings.json` / zod 默认值一致 → 自动清理默认开)。
- **也会绿**:**短对话(< 20 楼)上任何清理策略都绿。** 必须用那个 677 消息的长聊天。
- **状态**:**写路径已定稿**(真模型两次生成,爱衣;写方=宿主 `recordVariables`,
  方言=`<UpdateVariable>` 内 RFC 6902 JSONPatch);**长聊天清理那半仍未测**。

#### 已验的那半:真模型两次生成(爱衣)

**第一次** —— 回复里**没有** `UpdateVariable` 块:表 = 基线、`debug.reports` 全空。
这落在判读表第一行**「模型没写」**,不是「我们丢了」。**分开这两者的是离线证据**:
49 离线装配确认三条 `[mvu_update]` constant **全长进了 depth 0** —— 指令确实发出去了,
所以「没写」是模型的选择,不是提示没到。

**第二次** —— 硬消息「(一觉睡到第二天早上七点)醒了。」→ msg 12 带 1 个 `UpdateVariable` 块:

| 变量 | 前 | 后 |
|---|---|---|
| `世界.当前时间` | 7月1日 23:00 | **7月2日 07:00** |
| `世界.星期` | 星期一 | **星期二** |

**与 49 _事前写下_ 的预测逐字命中。**

> **「事前写下」是这次验收的全部力量所在**(第二节推论:predict before measuring)。
> 事后看着变化解释为什么合理,和事前把值写下来再去看,**在输出上长得一模一样**,
> 只有前者可以被运气伪造。

**这一格的「也会绿」补两条:**

- **只看「表变了」会绿。** 任何把时间往前推的实现都会让 `当前时间` 变。
  **判据是变成_事前写下的那个值_**(`7月2日 07:00` / `星期二`),不是"变了"。
- **「没有 `variables` 键的行」不是失败。** MVU 只在**发生变化时**才存表
  (49 §message-scope),所以一条没有 `variables` 的 assistant 行是**正常**的 ——
  把它当缺失会造出一整类假阳性。这与 §七之二 那条「4 行没有 `variables`」是同一个事实。

#### 写路径与方言(49 判,本格「写路径」至此定稿)

**写方是宿主 `recordVariables`** —— 依据是基线重放与存表**逐字节相同**。

> **边界照实记:逐字节相同不能排除脚本_也_写。** 两个写方产出同一份字节时,
> **产物本身没有鉴别力** —— 这与 §十九「印证只在分叉层有效」是同一条:
> 要分开它们,得找一处两条路径会给出不同结果的输入,而这次没有。
> 所以结论是**「宿主写了」,不是「只有宿主写」**。

**块方言:`<UpdateVariable>` 里套 RFC 6902 JSONPatch。**

| | 读数 |
|---|---|
| 块内前 6 行 | 散文推理(模型的思考,不是 op) |
| `_.` 老方言 | **0 个** |
| `scanJsonPatch` | **9 op → 9 command,0 失败** |
| `legacyAttempts` 计数器 | **正确地保持为 0** |

**这条闭合了 METHODS 第一节案例 8 那根线**:当时的教训是「mvu-flow 夹具照 `_.verb()`
老方言写、全绿;真卡说的是 JSONPatch」——**现在真模型的一次实际生成把它端到端证实了**,
夹具方言与真实方言的分歧不再是从卡文本推的,是看着模型写出来的。

**而 `legacyAttempts` 保持 0 是有意义的 0,不是空跑**:它存在的理由正是让
「没有老方言」与「我们没在看老方言」可区分(参见 METHODS 第三节:忠实的沉默也要有信号)。
**这次它是在一次真有 9 个 op 通过的生成里保持 0 的**,所以计数器确实在路径上。

**未验**:长聊天上的清理规则(间隔 50 / 保留 20 / 楼层 0 永不清)——
**必须用那个 677 消息的长聊天**,爱衣这两次生成不覆盖。

### 8. 存储族(**按组件,不按卡**)
- **必测三个**:手机UI(银麒赎世;其分叉 魔法少女的扣扣审判1.0 / 外置状态栏 共用同一套键名与函数名)、
  外置状态栏(创世回廊1.3)、状态栏(`2` ≡ `绿茵好莱坞`)。**其余三组件各一遍**:气泡面板、论坛覆盖层、正文美化。
- **该看到(按 §七之二 v3 的三档,逐组件对)**:
  - **启动即死**(模块没跑完,卡里什么都不存在):手机UI、外置状态栏(魔法少女)、状态栏
    —— 各因 **1 个模块顶层裸调用**。
  - **界面永不初始化**(模块跑完了,ready 回调抛):正文美化(可攻略女主),4 个裸点全在载入期。
  - **交互期抛**:OVERLORD 两个脚本。**静默降级**:外置状态栏(创世回廊)、气泡面板、论坛覆盖层。
- **前两档在屏幕上一模一样**(界面都不出现),**只有 console 能分**:模块级报错 vs ready 回调内报错。
  **按 console 归类,不按屏幕归类** —— 否则两种缺陷会被记成同一种。
- **也会绿**:**拦截读写**的实现在启动即死那三个上**来不及** —— 抛点在**属性访问**本身。
  门面必须让 `localStorage` 属性可读且不抛。
- **空 profile 这一档的判据**:空 profile 下 `getItem` 返回 `null` 而**不抛**,所以
  **载入期与交互档都不该出现异常,只该缺值**。若空 profile 也出现「界面不初始化」,
  那是**卡自己对 `null` 的处理有缺陷,与门面无关** —— 这条把两类问题分开,别记到门面账上。
- **注**:壳的 `getItem` 返回 `null` = 首次运行的空存储,是每张卡本来就支持的状态;
  但 银麒赎世 5 处 / 魔法少女 7 处「try 外、读无内联默认」会把 `null` 往下传 ——
  **未量**,正是上面那条空 profile 判据要测的东西。
- **状态**:未建(门面未落)。

### 9. 脚本按钮 —— **两条路,此前只过了一条**
- **实测 n=1**:全语料只有 **魔法禁书目录 / 剧情开启/关闭** 用 `replaceScriptButtons`(×2)。
- **必测变体 ①「卡声明的按钮」** —— 此前过的只可能是这一路。
- **必测变体 ②「运行时写入」(`appendInexistentScriptButtons`)** —— **这一路以前根本走不通
  (`CARD_METHODS` 漏行)**,所以旧的绿**不覆盖它**。**状态:未过。**
- **该看到**:**未量**(没读过它注册的按钮标签与回调)。
- **也会绿**:①②共用同一块按钮区,**只看"按钮出现了"两条路都绿** —— 要认的是**这一颗按钮
  是运行时写进去的**(声明里没有它)。另:n=1,作用域写明 n=1(§十九)。
- **状态**:未过(②从未通过)。

### 10. Font Awesome / 预置
- **干净样本:魔法少女的扣扣审判1.0** —— 它的 40 个图标**全部存在于 Free 6.5.2**。
- **其余 5 张各带 1–2 个 Pro-only 图标**(`fa-sparkles` / `fa-blanket` / `fa-radar` / `fa-user-hair`),
  空框是**卡自身缺陷**,与预置和 allowlist 无关。
- **该看到**:图标有字形;卡自带的 cdnjs `<link>` 被 CSP 拒 → **应有一条 note**。
- **也会绿 / 也会红**:在带 Pro 图标的卡上,「预置没生效」和「图标本来就不存在」**截图完全一样**。
  **必须指名是哪个图标**,或直接用上面那张干净卡。
- **状态**:7b 实测中。

### 未列进本单的
按钮以外的 TavernHelper API 面、`injectPrompts`(n=1,V1.5.4_)、世界书写(n=1,V1.5.4_)、
`getPreset`(n=1,且只传字面量 `'in_use'`)、`EjsTemplate.evalTemplate` 真调用(n=1,银麒赎世)——
**都是 n=1**,验收时按 n=1 记作用域,不作为族代表。
