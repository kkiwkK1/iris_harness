# 上游语义：卡自带的 ESM 依赖是怎么解析的

**给 7b 的「静态 import 代理/预导」方案当上游。**设计输入不是规格。

**一句话结论**：**上游没有为这件事做任何事——它不需要**。上游脚本 frame 与 ST 页面**同源**、
ST **不发任何 CSP**，所以 `import … from 'https://cdn…'` 就是一次普通的同源上下文取数，
第一次冷、之后走浏览器 HTTP 缓存。**我们做隔离，就买下了这整个问题。**

**所以这一族不是「补一个上游有的机制」，是「为一个上游靠环境免费获得的性质造一个替代品」。**
这条区分决定了设计不能靠"抄上游"来验收。

日期 2026-09-03。笔者：上游研究域（3c）。

## 口径

- **[TH]** `data/default-user/extensions/JS-Slash-Runner/`，**4.9.1**（`manifest.json` 与 `package.json` 一致）。
- **[ST]** `E:/sillyTavern/SillyTavern/`，1.18.0。
- **[此处]** 本仓库。
- 全部静态读源码 + 读用户实际配置文件，**没有运行 ST、没有抓包**。
  凡是从代码结构推出的运行时行为，标「推断」。

---

## 一、① 解析路径：同源、无 import map、无任何重写

### 一之一 帧是怎么造的

```ts
// [TH] src/panel/script/iframe.ts:5-23  createSrcContent(content, use_blob_url, use_cleanup_protector)
<!DOCTYPE html><html><head>
${use_blob_url ? `<base href="${window.location.origin}"/>` : ''}
${third_party}                                   // ← Vue + vue-router，CDN
<script src="${parent_jquery_url}"></script>     // ← blob，本地
<script src="${predefine_url}"></script>         // ← blob，本地
${…cleanup_protector…}                           // ← blob，本地（默认不注入）
<script src="https://testingcf.jsdelivr.net/gh/N0VI028/JS-Slash-Runner/src/iframe/node_modules/log.js"></script>
</head><body>
<script type="module">
${content}                                       // ← 卡的脚本正文
</script>
</body></html>
```

引导脚本是**构建期内联**的（`script_url.ts` 用 `?raw` 导入再
`URL.createObjectURL(new Blob([code]))`），**不走网络**。

**`use_blob_url` 在这台机器上是 `false`**（我读的 `data/default-user/settings.json`），
所以走 `srcdoc`，`<base>` 那行不出现。

### 一之二 帧与 ST 页面**同源**——而且这一点在代码里自证

不需要引用规范。上游自己的引导脚本做了只有同源才可能的事：

```js
// [TH] src/iframe/parent_jquery.js —— 全文
window.$ = window.parent.$;
window.jQuery = window.parent.jQuery;
```

```js
// [TH] src/iframe/predefine.js:14-16
let result = _(window);
result = result.merge(_.pick(window.parent, ['EjsTemplate', 'TavernHelper', 'YAML', 'showdown', 'toastr', 'z']));
```

**跨源读 `window.parent.$` 会抛 SecurityError。**这两行能工作，就是同源的证明。
（`srcdoc` 继承父文档的源；`use_blob_url` 那条路走 `blob:` URL，同样继承创建者的源。
**两条路都同源。**）

**推论**：脚本 frame 与 ST 页面**共用同一个 HTTP 缓存分区**。
一个 CDN 依赖第一次取是冷的，**之后跨 frame、跨聊天、跨角色卡全部命中缓存**。

### 一之三 没有 import map，没有 URL 重写，没有代理

- `importmap` / `importMap` 在 `public/index.html`、`public/scripts/`、TH 整个 `src/` 下
  **零命中**。
- `createSrcContent` 对 `content` 只做一件事：**剥掉外层的 markdown 围栏**
  （`content.match(/^\s*```[^\n]*\n(.*)\n```\s*$/is)?.[1] ?? content`）。
  **不解析 import、不改写 URL、不注入任何映射。**
- `predefine.js` 只往 frame 的 `window` 上挂全局（见 §三），**不碰模块解析。**

**所以卡里写的 `https://…` 就是浏览器直接去取的地址，一个字符都不变。**

### 一之四 ST 不发 CSP

```js
// [ST] src/server-main.js:104-105
app.use(helmet({
    contentSecurityPolicy: false,
```

**helmet 装了，CSP 明确关掉。**所以上游的 frame 对取哪个源没有任何策略限制。

### 一之五 和我们的差在哪（三处，只有第一处是根）

| | 上游 | [此处] |
| --- | --- | --- |
| **frame 的源** | **与 ST 页面同源** | **每聊天一个全新不透明源** |
| HTTP 缓存 | 与主页面共享分区 → **冷一次，之后全热** | 按源分区 → **每次开聊天都是冷取** |
| CSP | **无** | 有白名单 |

**第一行是根，第二三行是它的后果。**`sandbox/libraries.ts` 已经量到过这个后果的代价：
**9–12 秒、六次开局里四次超时**——那次的对象是 Vue，机制和现在这件完全一样。

---

## 二、② CDN 失败时上游什么都不做——静默有三层

**三层，逐层都静默：**

### 第一层：三个 CDN `<script src>` 是经典脚本，失败即静默

每个脚本 frame 在卡代码之前要取三个 CDN 资源：

```
https://testingcf.jsdelivr.net/npm/vue/dist/vue.runtime.global.prod.min.js         [TH] third_party_script.html:1
https://testingcf.jsdelivr.net/npm/vue-router/dist/vue-router.global.prod.min.js   [TH] third_party_script.html:2
https://testingcf.jsdelivr.net/gh/N0VI028/JS-Slash-Runner/…/log.js                 [TH] panel/script/iframe.ts:14
```

**三个都没有版本号**（`npm/vue` 而不是 `npm/vue@3.x.y`），**都是经典 `<script src>`**。
经典脚本取失败**不抛异常、不中断后续脚本**，全局就是不出现。
（这正是 `libraries.ts` 记的那件事：「**一个失败的经典 `<script src>` 是静默失败的**」，
它当时咬的是 MVU 等 `Vue` 等到天荒地老。）

### 第二层：TH 没有装任何错误监听

- 在 `iframe/*.js`、`panel/script/*`、`store/iframe_runtimes/*` 里搜
  `onerror` / `addEventListener('error')` / `unhandledrejection` / `window.onerror`
  ——**零命中**。
- 唯一的诊断层是 `iframe/node_modules/log.js`，它**只包 `console` 的五个方法**
  （log/debug/info/warn/error）转给面板：

```js
function override(level) { const original = console[level];
  console[level] = (...args) => { _th_impl._log(iframe_name, level, ...args); original(...args); }; }
```

**它只能看见卡自己调 `console.*` 打的东西。**浏览器因为取不到模块而报的那条错，
**不经过页面的 `console.error` 函数**，所以面板看不到。
**而且 `log.js` 自己就是那三个 CDN 资源之一**——它失败时，连这一层也没了，同样静默。

### 第三层：静态 ESM import 失败 = 模块永不求值

卡的正文跑在 `<script type="module">` 里。**静态 `import` 失败时整个模块不求值**——
不是"跑了一半"，是**一行都没跑**。所以卡的任何自我诊断（包括它自己的 try/catch、
它自己的 toastr）**都不会执行**，因为它们也在这个模块里。

**这一层对我们尤其要紧**：7b 现场看到的「15s 未求值完成」正是这个状态，
**「未求值」这个措辞是准的**——不是卡卡在某个 await，是模块还没开始。

### 小结

**上游对 CDN 失败的"表现"就是：什么也不显示，卡就是不工作。**
它能这样是因为**热取几乎不失败**（同源缓存 + 用户机器上 CDN 通）。
**我们把冷取变成常态，就把一个罕见静默变成了常见静默**——
这属于 `OBSERVABILITY.md` 的「缄默」族，**而且是我们自己制造的那一类，不是继承的**。

---

## 三、③ `predefine.js` 那条 pinia 注释：它设的是 Vue 的三个特性开关

原文（[TH] `src/iframe/predefine.js:23-26`）：

```js
// pinia 4.0.0+ 必须设置这个, 考虑到影响了非常多脚本/前端, 直接在这里统一设置
_.set(window, '__VUE_PROD_DEVTOOLS__', true);   // 不使用 vue devtools 时不会有性能开销, 默认启用即可
_.set(window, '__VUE_OPTIONS_API__', true);
_.set(window, '__VUE_PROD_HYDRATION_MISMATCH_DETAILS__', false);
```

**「必须设置这个」指的是这三个 Vue 编译期特性标志**，不是某个全局对象。
pinia 4.0.0+ 在运行时读它们；缺了会在控制台告警或走错分支。

**注意这条注释本身是一份证词**：「**考虑到影响了非常多脚本/前端**」——
**上游作者知道 pinia 是常见依赖**，并且选择了**统一在引导层设标志**，
而不是让每张卡自己设。

### 上游为卡准备的东西，完整清单

这就是总指挥要的「族名单」。分三类：

**A. 注入 frame 全局的库**（`predefine.js` + `third_party_script.html`）

| 名字 | 来源 | 形式 |
| --- | --- | --- |
| `$` / `jQuery` | **父页面的实例** | `parent_jquery.js` 两行赋值 |
| `_` (lodash) | **父页面的实例** | `predefine.js:1` `window._ = window.parent._` |
| `Vue` | **CDN**（无版本号） | `<script src>` 全局 |
| `VueRouter` | **CDN**（无版本号） | `<script src>` 全局 |
| `EjsTemplate` `TavernHelper` `YAML` `showdown` `toastr` `z` | **父页面** | `predefine.js:15` `_.pick(window.parent, […])` |
| `SillyTavern` | **父页面**，getter | `predefine.js:29-36` |
| `Mvu` | **父页面**，getter，**存在才挂** | `predefine.js:38-45` |

**B. 特性开关**：上面那三个 `__VUE_*__`。**唯一一个为具体第三方库（pinia）做的特殊处理。**

**C. 什么都没做的**：**pinia 本身、以及任何其它 ESM 依赖。**
上游**不提供 pinia**，只提供它需要的标志。卡要 pinia 就自己去 CDN 取。

**所以"预置名单"若照抄上游，pinia 不在里面。**
上游的做法是「**让卡自己取，我只保证它取到之后能正常工作**」——
在同源无 CSP 的环境里这是合理的分工；**在我们的环境里这个分工不成立**，
因为"取"这一步在我们这里是贵的、且可能被策略挡住。

---

## 四、④ ST 确实有一个代理端点，但它不为这件事而设，且默认关

```js
// [ST] src/server-main.js:257-258
if (cliArgs.enableCorsProxy) {
    app.use('/proxy/:url(*)', corsProxyMiddleware);
}
```

- **默认 `false`**（`src/command-line.js:72`），**用户的 `config.yaml` 里也是
  `enableCorsProxy: false`**（我读的）。
- 中间件（`src/middleware/corsProxy.js`）是**通用透传**：
  剥掉 13 个头（`x-csrf-token` `host` `referer` `origin` `cookie` `x-forwarded-*`
  `sec-fetch-*` 等），`node-fetch` 取回，`forwardFetchResponse` 原样转发。
  **拒绝指向自身的循环请求**（`url.startsWith(serverUrl)` → 400）。
- **没有任何白名单、没有缓存、没有大小限制。**
- **上游没有任何代码把卡内容重写到这个端点。**它是给用户手动用的（比如某些 API 端点跨域）。

**结论**：**上游没有"扩展资源代理"这个东西可参照。**这个端点可以作为**形状**上的参考
（路径形如 `/proxy/<完整URL>`，透传），但它的策略面（无白名单、无缓存）**不能照抄**——
我们要做的是有白名单、有缓存、可离线的预导层，那是另一件东西。

---

## 五、给 7b 的设计输入

### 五之一 三条硬约束（前两条我已先发过，这里给出处）

1. **预置 ≠ 映射。**把 pinia 打进 `preset.js` 不会消掉冷取，
   因为**卡写死的是一个 URL 字符串**（`import … from 'https://testingcf.jsdelivr.net/npm/pinia/+esm'`）。
   Vue 那次两件事同时成立，是因为 TH 用 `<script src>` 注入**全局变量**，
   卡读的是 `Vue` 这个名字；**ESM 这族卡读的是地址。**
   **要么改地址（映射/import map），要么把那个地址变成可用的（代理）。**
2. **去重是优化，合并是行为改变。**V1.5.4 里有**两份 pinia**——
   MVU 的 artifact 里打包了一份（`from 'pinia'`），覆盖层从 CDN 取另一份。
   **上游就是两份，卡在两份下工作。**把它们合成一份是改变运行时结构，不是修 bug。
3. **上游没有这个机制可抄。**§〇。所以验收标准不能是"和上游一致"，
   只能是"卡能跑起来，且失败时说话"。

### 五之二 三个候选形状，各自的代价

我不替 7b 定，但把三条路的分界说清：

| 方案 | 改的是什么 | 卡不用改吗 | 主要代价 |
| --- | --- | --- | --- |
| **import map** | 让 frame 把那个 URL 解析到本地 | 是 | 需要**逐个 URL 登记**；卡用了没登记的地址就仍然走网 |
| **代理端点** | 让那个 URL 可达且走我们的源 | 是 | 得允许任意外链（白名单否则等于没解决）；**首次仍是网络** |
| **构建期改写** | 落盘时改写卡的 import 地址 | **否——改了卡的内容** | 违反"卡是只读输入"；且卡内容会被我们的改写污染 |

**我的倾向是 import map + 预置的组合**，理由是它**不改卡、不需要网络、且失败面是"名单不全"这种可枚举的东西**——
但这是 7b 的域，我只把代价摆出来。

**无论哪条，都要补第四件事**：**失败要说话。**上游三层静默（§二）里，
**第三层（模块不求值）是我们没法靠 Logger 拿到的**——卡的代码一行没跑，
它自己的报告通道也没建起来。**所以诊断必须在 frame 之外**：
宿主侧观测"这个 frame 的模块是否完成求值"，超时就具名报出来。
**这条是 `OBSERVABILITY.md` 缄默族的新成员，而且是我们自己制造的那个。**

### 五之三 一条容易搞反的

**上游的 `<script src>` CDN 依赖（Vue / vue-router / log.js）和卡的 ESM import 是两回事。**

- 前者上游注入，**我们已经用 `preset.js` 把 Vue 解决了**（`libraries.ts` 记着为什么）；
- 后者是**卡自己写的地址**，`preset.js` 帮不上。

**这两件事都叫"CDN 依赖"，但一个改注入、一个改解析。**

---

## 六、未查 / 限定

1. **全部是静态读**。同源、缓存共享、失败静默这三条的**运行时验证我没做**
   （只读纪律；且要在用户的 ST 上开 DevTools 观察网络，那是他的机器）。
   §一之二的同源结论有代码自证（`window.parent.$` 能工作），**这一条比另两条硬**。
2. **`use_blob_url: true` 那条路我没细看**。它加 `<base href="${window.location.origin}"/>`，
   我没有验证 base 对**裸模块说明符**（`from 'pinia'`）有没有影响——
   裸说明符在浏览器里无论如何都要 import map 才能解析，所以**大概率无影响**，但我没证。
3. **TH 4.9.1 单版本口径。**这张卡可能按更新版写；`appendInexistentScriptButtons`
   那次的限定已经能撤（MVU 自声明 ≥3.4.17），**但这一份里 §三 的清单没有类似的下界声明可依**。
4. **44 在量语料面**（有多少卡、多少个不同的 CDN 地址）。
   **本文没有语料统计**，§五 的方案代价里"名单不全"的实际规模要等他的数。
5. **jsdelivr 那三个地址全部无版本号**，意味着上游的行为**会随 CDN 上游发版而改变**。
   我没查 TH 是否在别处锁版本。这对"预置哪个版本"是个悬着的问题。
