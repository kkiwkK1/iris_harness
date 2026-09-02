# 上游语义：frame 的源，与它带来的共享存储

**短文档。**回答一个问题：卡 frame 里的 `localStorage` 是谁的存储。

**答案**：**是 ST 页面那个 origin 的存储，所有卡与宿主共用一份，没有任何隔离或前缀约定。**
上游不是"决定共享"，是**从来没有把它们分开过**——frame 无 `sandbox`，同源是默认结果。

日期 2026-09-03。笔者：上游研究域（3c）。

## 口径

- **[TH]** 酒馆助手 4.9.1，`data/default-user/extensions/JS-Slash-Runner/src/`。
- **[ST]** SillyTavern 1.18.0，`E:/sillyTavern/SillyTavern/public/`。
- 静态读源码 + 读用户实际配置。**没有在浏览器里验证过同源**——§二 给的是代码自证，见 §五。

---

## 一、三个 iframe 组件的完整属性集：**没有 `sandbox`、没有 `allow`、没有 `csp`**

```html
<!-- [TH] panel/script/Iframe.vue:2  —— 脚本 frame -->
<iframe v-show="false" :id="`TH-script--${name}--${id}`" :name="`TH-script--${name}--${id}`" v-bind="src_prop" />

<!-- [TH] panel/render/Iframe.vue:2-11 与 panel/render/StreamingIframe.vue:2-11 —— 界面 frame（两者逐字相同） -->
<iframe :id="prefixed_id" ref="iframe_ref" :name="prefixed_id"
        loading="lazy" v-bind="src_prop" class="w-full" frameborder="0" @load="onLoad" />
```

`v-bind="src_prop"` 只展开 `{ srcdoc }` 或 `{ src }`（blob），不带别的属性。

**全仓搜索**：

```
grep -rn "sandbox" JS-Slash-Runner/src/                              → 零命中
grep -rn "sandbox" ST/public/{script.js,index.html,scripts/}         → 零命中
```

**上游从未给任何 frame 加过 sandbox。**

---

## 二、同源：不是推论，是代码自证

无 `sandbox` 的 `srcdoc` iframe 继承父文档的源；`blob:` 那条路同样继承创建者的源。
**但不必引用规范**——上游自己的引导脚本做了只有同源才可能的事：

```js
// [TH] iframe/parent_jquery.js —— 全文两行
window.$ = window.parent.$;
window.jQuery = window.parent.jQuery;
```

```js
// [TH] iframe/predefine.js:14-16
let result = _(window);
result = result.merge(_.pick(window.parent, ['EjsTemplate','TavernHelper','YAML','showdown','toastr','z']));
```

**跨源读 `window.parent.$` 会抛 SecurityError。这两行能工作，就是同源的证明。**

**推论**：`localStorage` / `sessionStorage` / `indexedDB` 在卡 frame 里
**就是 ST 页面 origin 的那一份**。所有卡、所有 frame、宿主自己，**共用一个键空间**。

---

## 三、ST 自己在这个键空间里占多少：**两个键**

上游没有前缀约定（TH 全仓零存储调用），但 **ST 做过一次反方向的动作**：

```js
// [ST] scripts/util/AccountStorage.js:50-61   #migrateLocalStorage()
if (MIGRATABLE_KEYS.some(k => k.test(key))) {
    this.#state[key] = globalThis.localStorage.getItem(key);
    globalThis.localStorage.removeItem(key);          // ← 从 localStorage 删掉
}
// :96-111  setItem → this.#state[key] = …; saveSettingsDebounced();   ← 落服务端账户设置
```

**`MIGRATABLE_KEYS` 共 30 条**（`AccountStorage.js:4-34`：`AlertRegex_` `AlertWI_`
`Assets_SkipConfirm_` `NavOpened` `WI_PerPage` `world_info_sort_order` …），
一次性迁移，用 `__migrated` 标记（`:2`）。**ST 的 UI 状态现在在服务端 per-account 设置里。**

**ST 仍直接用 `localStorage` 的只剩三处：**

| 出处 | 键 | 性质 |
| --- | --- | --- |
| `scripts/i18n.js:4-5` | `language` | 语言覆盖 |
| `script.js:10970-10971` | `eventTracing` | 调试开关 |
| `scripts/f-localStorage.js:7/15/39` | —— | `SaveLocal`/`LoadLocal`/**`ClearLocal`** 辅助函数 |

**`ClearLocal()` 是 `localStorage.clear()`**（`f-localStorage.js:39`）——**清空整个源，
会连同每一张卡的数据一起抹掉**。**全仓无调用者**（我搜过），是遗留的调试辅助。
**但它存在，而卡够得到那个 origin。**

---

## 四、共享是真共享：语料里的一个实例

不是假想。44 的 AST 普查里，**两张「启动即死」的卡键名有四个逐字相同**：

```
银麒赎世 / 手机UI            moshen-phone-wallpaper, mobile-trigger-btn-position,
魔法少女的扣扣审判1.0 / 外置状态栏  mobile-trigger-btn-user-dragged, mobile-last-panel
```

它们是**同一份代码的两个分叉**（44 测得：哈希不同，键名与函数名成套重合）。

**所以在上游，这两张卡的手机壁纸和悬浮按钮位置是同一份数据**——先后玩两张卡，设置会串。

**这一条把「上游没出事靠卡作者自觉，不是机制」从论证变成了实例，
并且指出自觉在这里恰好失效**：`moshen-` 这个前缀是有的、也是自觉加的，
**但分叉让两张卡共享了同一个前缀**——**前缀防的是陌生人，防不了自己的副本。**

*（数据是 44 的；这一层含义是我从他的键名表读出来的。）*

---

## 五、裁定与口径注

### 已裁（总指挥，2026-09-03）

1. **卡面 `localStorage` 对齐上游当下机制**：profile 级一份、所有卡共享、无前缀、无隔离。
2. **我们自己的状态一个键都不进那个空间**（本就在宿主侧，这条只是写成规矩）——
   这正对上 §三 里 ST 的迁移方向。**两面各归其位，不冲突。**
3. **升级侧**：卡调用 `clear()` / `removeItem` 抹到别的卡的键时**报告**（上游静默），**不阻止**。

### 一处口径注，防止按错的数排优先级

我先前给出的 `localStorage` 计数 **109 / 59 / 13**（银麒赎世 / 魔法少女 / 创世回廊）是
**字符串出现次数**（raw substring），**包含注释与字符串字面量里的那个词**。

44 用 TypeScript 5.9.3 parser 走 AST 数**真实标识符引用**，同三张卡是 **81 / 50 / 12**。

**两个都对，回答的问题不同**：

| 口径 | 回答 |
| --- | --- |
| 字符串出现次数（我） | **这张卡有多依赖存储** |
| AST 标识符引用（44） | **存储没了会抛几次** —— 注释里的那个不会抛 |

**按行为排优先级要用后者。**而且 44 的分类进一步说明：**严重后果集中在 4 个调用点，
不是 165 个**——只有 4 个脚本有顶层裸调用（模块跑不完 → 整个界面不出现），
每个各只有 1 个。**我先前说「族代表该是银麒赎世」结论对、理由错**：
对的理由是它有一个顶层裸调用，**不是因为它次数最多**。

## 六、`indexedDB`：语料里唯一的消费者，**两种用法，裁定只覆盖了一种**

`localStorage` 的裁定（§五）没有提 `indexedDB`。语料里只有一张卡用它——
**银麒赎世 / 手机UI**，5 处，**但那 5 处属于两个完全不同的用途。**

```
indexedDB 5   createObjectStore 1   transaction( 6   objectStore( 6
onupgradeneeded 1   onsuccess 5   onerror 32   .result 15
```

### 用法一：卡自己的存储（`PhoneImageStore`，`:20749-20770`）

```js
var req = indexedDB.open(self.DB_NAME, self.DB_VERSION);
req.onupgradeneeded = e => { if (!db.objectStoreNames.contains(self.STORE_NAME)) db.createObjectStore(self.STORE_NAME); };
req.onsuccess = e => { self._db = e.target.result; …; self._migrateOldData(); };
req.onerror = () => { console.warn(…) };          // ← 降级
```

**存的是图片**，不是键值字符串。**这是 `localStorage` 裁定覆盖不到的形状**：
容量级别不同（blob 级 vs 字符串级），失败语义不同（**异步的 `onerror`**，
不是同步抛的 getter）。而且它带一条 **`_migrateOldData()`**——**它是从别处搬过来的**，
大概率就是因为 `localStorage` 装不下。

### 用法二：读**另一个扩展**的数据库（`Chatu8ImageReader`，`:20412-20442`）

```js
if (indexedDB.databases) {                                   // ← Chromium-only，Firefox 没有
  indexedDB.databases().then(dbs => {
    for (…) { var name = dbs[i].name || '';
      if (name.indexOf('chatu8') !== -1 || name.indexOf('st-chatu') !== -1) {   // ← 智绘姬
        var req = indexedDB.open(name);
        req.onsuccess = e => { self._storeName = Array.from(e.target.result.objectStoreNames)[0]; … };
```

**它枚举整个源里的所有数据库，按名字找「智绘姬」这个第三方扩展的库，然后打开来读图。**

**这是第三种形状，前面两节都没覆盖到**：不是"我的数据"，也不是"共享键空间里的碰撞"，
而是**读邻居扩展的私有存储**。同源把这件事变成可能——`indexedDB` 没有跨扩展隔离，
**一个源里的所有数据库对这个源里的任何代码都是可枚举、可打开的。**

### 三条对我们的含义

1. **用法二在我们这里必然失败，而且这是对的。**我们没有智绘姬这个扩展，
   名字扫描找不到任何库 → `resolve(false)` → 降级。
   **这是一个"忠实兼容既不可能也不必要"的例子**：它依赖的不是宿主能力，
   **是另一个扩展的存在**。**不该进兼容账本，该进"结构上不适用"那一栏。**
2. **用法一需要一个独立于 `localStorage` 的决定。**存图片、blob 级、异步失败语义、
   带迁移路径。§五 的「真持久化 + profile 级共享」是按键值存储裁的，
   **套到这里要重新想一遍容量和清理**。
3. **两处都有守卫、都能降级**（`try` + `if (indexedDB.databases)` + `onerror`），
   所以**存储不可用不会让这张卡启动即死**——它的"启动即死"点在 `localStorage`
   那一侧（§五之口径注），不在这里。

---

## 七、探测手段：`typeof` 会抛，`in` 不会（44 实测，2026-09-03）

这一节决定我们门面的形状，所以把机制写清。

### 三种探测，两种结果

| 写法 | 触发 getter？ | 不透明源下 |
| --- | --- | --- |
| `typeof 完全未声明的名字` | —— | `'undefined'`，**不抛**（typeof 的经典用途） |
| **`typeof localStorage`** | **是** | **抛 SecurityError** |
| `window.localStorage` | 是 | 抛 SecurityError |
| **`'localStorage' in window`** | **否** | **不抛**，得 `true` |
| **`Object.getOwnPropertyDescriptor(window, 'localStorage')`** | **否** | **不抛**，得描述符 |

**为什么 `typeof` 不管用**：它保护的是**「标识符解析不了」**，不是**「getter 抛」**。
`localStorage` 是 `WindowLocalStorage` 混入 `Window.prototype` 的 **getter**，
标识符**解析得到**，于是 `typeof` 会走 getter → 抛。

*（44 的口径：他在 Node 里造了同形状的 getter 做最小复现，**不透明源本身在 Node 里造不出来**，
所以这是**机制层确认**，不是端到端。）*

### 对设计的两条含义

**① 「必须包 try」是观察事实，不是规范事实。**
`in` 和 `getOwnPropertyDescriptor` 提供了非 try 的探测路径——**只是全族 0 张卡用它**
（44 测得守卫尝试 0 次，含 `in` 形式）。所以它**不构成兼容面约束**，
但写设计输入时这两者要分开：**"卡都没用"和"卡不能用"是两回事。**

**② 「返回一个失败的 storage 壳」比「让访问抛」兼容面大，理由是它不引入新状态。**

44 给的论据我认为是这一节最有力的一条：壳的 `getItem` 返回 `null`、`setItem` 静默成功，
则**卡看到的状态和「首次运行、存储是空的」完全一样**——
**而每张卡都必须已经支持那个状态，因为新用户第一次打开就是它。**

**这条路不是给卡一个新状态去应付，是给它一个它本来就在支持的状态。**

对照另一条路（接受所有访问都得包 try）：语料里是 **4 个顶层裸调用点、守卫 0 次**。
那 4 个点意味着任何"卡自己包 try"的期待都落空——**它们已经写好了、不会改，
包 try 是我们改不了的别人的代码。**

### 但这条论据有边界，44 自己划的

壳返回 `null` 时，**读结果没有内联默认值、又在 try 外**的点会把 `null` 往下传
（`JSON.parse(null)` 还行，`null.split()` 就抛）。语料里：

```
银麒赎世 / 手机UI              5 个这样的点
魔法少女的扣扣审判1.0 / 外置状态栏   7 个
```

按「首次运行」的论据，**它们应该已经能处理 null**——
**但那是推论，前提是"这些卡在全新 profile 上跑得起来"，这个前提没有人验证过。**

**要确认得拿一张空 profile 实跑，那是浏览器验收的事，语料回答不了。**

> **反例在别处**：`typeof` 在这里会抛，但**在另一种缺席上它恰恰是有效防护**——
> 见 `apps/iris-web/UPSTREAM-ESM-DEPS.md` §三之二。
> **判据是「名字存在但读它会抛」还是「名字压根没创建」。**

---

## 未查

1. **同源没有在浏览器里实证过**（只读纪律：那要开 DevTools 看用户的 ST）。
   §二 的代码自证比推论硬，但它证的是"上游代码假定同源"，不是"我观察到同源"。
2. ~~**`sessionStorage` / `indexedDB` 的共享面我没单独量**~~ **`indexedDB` 已查，见 §六。**
   （`sessionStorage` 语料里零使用，同源结论同样适用，未单独展开。）
3. ~~**`typeof localStorage` 在不透明源上会不会抛**~~ **已结**，见 §七。
4. **§六 用法一（卡自己的图片库）需要一条独立于 `localStorage` 的裁定**，
   §五 那条是按键值存储裁的。这条我没有答案，是提出来的问题。
