# 上游语义：MVU 的初始化路径，与它路上那两个成员

**给 49（宿主 arm）+ 7b（门面）。**上游语义测量，不是我们的契约。

**起因**：按钮级联修好后，MVU 在爱衣上仍报两条具名缺席——
`getLorebookSettings` 与 `SillyTavern.loadWorldInfo`。**它们是同一条路径上相邻的两站。**

**先答最要紧的一问**：**这次的失败不阻断 `initGlobals` → Mvu 发布。**
和按钮那次不同，机制在 §三。**但它的失败形态在一个方面更坏**，也在 §三。

日期 2026-09-03。笔者：上游研究域（3c）。

## 口径

- **[TH]** 酒馆助手 **4.9.1**，`data/default-user/extensions/JS-Slash-Runner/src/`。
- **[ST]** SillyTavern 1.18.0，`E:/sillyTavern/SillyTavern/public/`。
- **[MVU]** 本地签出 `.reference/MagVarUpdate/src/`。**版本未核**——见 §六。
- **[卡]** 22 张（19 语料 + 3 新增），产品解码器，**渲染前**，子串计数。
- 全部静态读。

---

## 一、`getLorebookSettings()` —— 同步、快照、16 个字段

```ts
// [TH] function/lorebook.ts:185-187
export function getLorebookSettings(): LorebookSettings {
  return klona(toLorebookSettings(getWorldInfoSettings()));
}
```

**三条形状要点：**

1. **同步。**不是 `async`。（MVU 一处写了 `await getLorebookSettings()`、一处没写——
   两种都能工作，因为 `await` 一个非 Promise 是无害的。**我们若做成异步就打破了后者。**）
2. **`klona` 深拷贝 → 返回快照，不是活对象。**改返回值不影响上游设置。
   这一点上游自己就是快照语义，**所以我们照做不构成 `live-object vs snapshot` 那类偏离**。
3. **16 个字段**，全部由 ST 的 `getWorldInfoSettings()`（[ST] `world-info.js:795-812`，**14 个键**）映射而来。

### 字段映射表（[TH] `lorebook.ts:86-108`）

| `LorebookSettings` | 源（ST `world_info_*`） |
| --- | --- |
| `selected_global_lorebooks: string[]` | `world_info.globalSelect` |
| `scan_depth: number` | `world_info_depth` |
| `context_percentage: number` | `world_info_budget` |
| `budget_cap: number`（0 = 禁用） | `world_info_budget_cap` |
| `min_activations: number` | `world_info_min_activations` |
| `max_depth: number`（0 = 无限制） | `world_info_min_activations_depth_max` |
| `max_recursion_steps: number` | `world_info_max_recursion_steps` |
| `insertion_strategy: 'evenly'\|'character_first'\|'global_first'` | `world_info_character_strategy`，**数字 0/1/2 映射成字符串** |
| `include_names` `recursive` `case_sensitive` `match_whole_words` `use_group_scoring` `overflow_alert`（均 boolean） | 同名 `world_info_*` |

**两处命名陷阱**（照抄字段名会踩）：

- **`max_depth` 的源是 `world_info_min_activations_depth_max`**，不是任何叫 `depth` 的东西。
  它是「最小激活」的深度上限，**不是扫描深度**——扫描深度是 `scan_depth`。
- **`context_percentage` 的源是 `world_info_budget`**。上游那个字段名叫 budget，
  值是**百分比**；真正的字节上限叫 `budget_cap`。**两个 budget，一个是比例一个是绝对值。**

### MVU 在哪调、拿它决定什么

```
.reference/MagVarUpdate/src/function/initvar/variable_init.ts:231   const lorebook_settings = await getLorebookSettings();
.reference/MagVarUpdate/src/function/initvar/variable_init.ts:402   const settings = getLorebookSettings();
```

**只有 initvar 一个消费者，两处。**它属于**聊天级**初始化（§三）。
*（这两处各自用了哪几个字段我没有逐行读——见 §六。
但「谁调它」这个问题已经答完：只有 initvar。）*

---

## 二、`SillyTavern.loadWorldInfo(name)` —— 异步、带缓存、返回**原始盘面格式**

```js
// [ST] world-info.js:2036-2059
export async function loadWorldInfo(name) {
    if (!name) return;                              // ← undefined
    if (worldInfoCache.has(name)) return worldInfoCache.get(name);
    const response = await fetch('/api/worldinfo/get', { method:'POST', headers:getRequestHeaders(),
        body: JSON.stringify({ name }), cache:'no-cache' });
    if (response.ok) { const data = await response.json(); worldInfoCache.set(name, data); return data; }
    return null;                                    // ← null
}
```

**四条要点：**

1. **异步**，返回整本书。
2. **返回的是原始盘面格式**：`{ entries: { [uid]: entry } }` —— **一个以 uid 为键的对象**，
   不是数组。（对照 TH 的 `getWorldbook()` 返回的是**规范化后的数组** `WorldbookEntry[]`。
   **同一本书，两种形状，取决于走哪条 API。**）
3. **三种"没有"要分开**：名字为空 → `undefined`；HTTP 不 ok → `null`；书不存在但 API 返回 ok → 由服务端决定。
   **`undefined` 和 `null` 语义不同，调用方要区分。**
4. **有进程内缓存**（`worldInfoCache`），**没有失效逻辑在这个函数里**。

### MVU 用它读什么

```ts
// [MVU] function/character_override/index.ts:61-68
async function loadRawWorldbook(worldbook_name: string): Promise<RawWorldbookData> {
  const loaded = (await SillyTavern.loadWorldInfo(worldbook_name)) as unknown;
  if (!_.isPlainObject(loaded) || !_.isPlainObject(_.get(loaded, 'entries'))) {
    throw new Error(tr('runtime.characterOverride.worldbookReadFailed', { worldbook: worldbook_name }));
  }
  return klona(loaded) as RawWorldbookData;
}
```

**这就是「Failed to read character-card configuration」那条的抛出点。**
判据是**双重的**：返回值必须是 plain object，**且** `.entries` 也必须是 plain object。

**MVU 用它做的事**：读「角色卡配置覆盖」条目——它把配置写成一条
**`disable === true` 的世界书条目**（注释写明「配置条目必须关闭，避免其中的 JSON
被当作普通世界书内容注入提示词」），然后按名字筛出来解析。

**顺带一个和 TH 不一致的细节**：MVU 分配新 uid 用
`(_.max(used_uids) ?? -1) + 1`（`character_override/index.ts:80-84`，注释说「沿用
SillyTavern 新建条目的编号方式，不复用空洞」），而 **TH 的 `createWorldbookEntries`
用的是 `_.random(0, 1e6)` + 二次探测**（我在 `UPSTREAM-INJECT-AND-CHAT-BOOK.md` §二之四 记过）。
**同一个栈里两套 uid 策略。**谁写的条目由谁决定编号，我们两边都要容得下。

---

## 三、爆炸半径：这次**不**掐掉 Mvu 发布，但有一个方面更坏

### 三之一 MVU 的两层初始化

```ts
// [MVU] src/main.ts:37-39  —— 顶层，只跑一次
stop_list.push(initPanel());
stop_list.push(initButtons());     // ← 按钮那次炸在这，无 try
stop_list.push(initGlobals());     // ← 发布 window.parent.Mvu + emit global_Mvu_initialized
```

```ts
// [MVU] src/main.ts:122-153  —— initChatLevel()，每次切聊天跑一次，整段包在 try/catch 里
const stop_character_settings = await initCharacterSettingsOverride();   // ← ② loadWorldInfo 炸在这
...
const stop_initvar = await initInitvar();                                // ← ① getLorebookSettings 炸在这
...
stop_list.push(initRequest());
stop_list.push(initResponse());      // ← 处理 <UpdateVariable> 的就是它
stop_list.push(initCleanup());       // ← 快照/清理
stop_list.push(initExportedEvents());
```

`initChatLevel` 自己 `catch → stopAll → throw`，再被 `transitionToChat` 的 `.catch` 接住，
打出 **`chatReinitializeFailedLog` + toastr `reinitializeFailedTitle`**——
**这正是现场那条 `Reinitialization failed` 的来源。**

### 三之二 所以答案是

**`initGlobals()` 在顶层、在任何聊天级过渡之前跑完。**
**这两个成员的缺席不影响 `Mvu` 的发布。**

> **⚠ 一处更正（2026-09-03，同日）。**初版这里我写的是「`Mvu` **正常发布**」。
> **那句是错的**——它只成立于「`initGlobals()` 跑到了」这个前提，
> 而**发布本身还有第二个条件，我当时没读**。见 §三之四。
> **本节其余部分（顺序、catch、爆炸半径）不受影响**，改的只是这一句的强度：
> 正确说法是「**这两个成员的缺席不阻断发布路径**」，不是「发布一定发生」。

对照按钮那次：

| | 按钮那次 | 这次 |
| --- | --- | --- |
| 出事位置 | `initButtons()`，**顶层**，`initGlobals()` **之前** | `initChatLevel()`，**聊天级**，`initGlobals()` **之后** |
| 有没有被捕获 | **没有**（函数第一句，无 try） | **有**（两层 catch + toastr） |
| `Mvu` 发布 | **不发布** | **发布路径不受阻**（是否真发布另有条件，§三之四） |
| `waitGlobalInitialized('Mvu')` | **永久挂起** | **正常返回** |
| 死掉的 | 整个 MVU | 聊天级五件：角色覆盖、initvar、request、**response**、cleanup、exported events |

### 三之三 但这个"更好"的失败在一个方面更坏

**`Mvu` 发布了，聊天级却是死的。**于是：

- 卡的 `await waitGlobalInitialized('Mvu')` **正常返回**；
- 卡拿到一个**存在的 `Mvu` 对象**；
- 而 `initResponse()` 从没挂上——**`<UpdateVariable>` 不会被处理**，变量不会更新。

**卡会继续往下跑，相信 MVU 在工作。**

按钮那次是**响亮的死**（所有等待方永久挂起，一眼看得出坏了）；
这次是**安静的半死**（对象在、管线不在）。**这一条要进 `OBSERVABILITY.md` 的缄默族**：
上游有 toastr 报出来，**但那条 toastr 说的是「重初始化失败」，没说「变量管线没挂上」**——
**报的是原因所在的层，不是后果所在的层。**

### 三之四 发布还有第二个条件：MVU 会**自己关掉自己**，而且完全静默

**这是第三种失败机制，和前两种都不同：不抛异常，也不报告。**

```ts
// [MVU] src/function/global/index.ts:167-176
const stop = watch(() => store.should_enable, should_enabled => {
    if (should_enabled) {                                  // ← 条件在这
        _.set(window.parent, 'Mvu', mvu);                  // ← 发布目标是 window.parent
        eventEmit('global_Mvu_initialized');
    }
}, { immediate: true });
```

```ts
// [MVU] src/store.ts:381-391
const should_enable = ref<boolean>(false);                 // ← 初值 false
// 当存在多个 MVU 脚本实例时，仅优先实例应启用运行逻辑。
registerAsUniqueScript('MVU变量框架').listenPreferenceState(preferred_script_id => {
    should_enable.value = preferred_script_id === getScriptId();
});
```

```ts
// [MVU] util/script.ts:40-48
const getPreferredScriptId = () => {
    const registered_scripts = _.get(window.parent, path, new Set<string>());
    return _($('#tavern_helper').find('div[data-script-id]').toArray())     // ← 查宿主页面 DOM
        .map(element => String($(element).attr('data-script-id')))
        .filter(element => registered_scripts.has(element))
        .last();
};
```

**这条链的每一环都值得单独看：**

1. **发布目标是 `window.parent`，不是 `window`、不是 `globalThis`。**（`global/index.ts:172`）
2. **发布是有条件的**：`should_enable` 初值 `false`，只有 `listenPreferenceState`
   回调把它设真才会发布。
3. **那个回调的判据依赖两样我们都没有的东西**：
   - **`$('#tavern_helper')`** —— 用**宿主页面的 jQuery** 查 **TavernHelper 面板的 DOM**。
     我们没有这个面板，**选择集为空 → `.last()` 返回 `undefined`**。
   - **`getScriptId()`** —— `COHABITATION.md` 已经写明它在共居 realm 里会丢答案。
4. 于是 `should_enable.value = (undefined === getScriptId())`。

**结果取决于我们的 `getScriptId()` 返回什么，而且是反直觉的：**

| 我们的 `getScriptId()` | 比较结果 | 后果 |
| --- | --- | --- |
| 返回一个真实 id | `undefined === "abc"` → **false** | **不发布**，静默 |
| 返回 `undefined` | `undefined === undefined` → **true** | **发布**（歪打正着） |

**这解释了面板实测的 `mvuUnpublished: 1`**，而且它**不是缺席、不是拒绝、不是异常**——
是 MVU 按自己的多实例去重逻辑**判定自己不该运行**。

**为什么它完全不出声**：对上游而言「我不是优先实例」是**正常状态**，
一个页面上装了两份 MVU 时本来就该有一份闭嘴。**上游没有理由为此报警。**

### 三之五 三种失败机制，形状各不相同

| | 触发 | 抛吗 | 报吗 | `Mvu` |
| --- | --- | --- | --- | --- |
| **按钮** | 顶层未实现成员 | **抛，无 try** | 无 | **不发布** |
| **本文①②** | 聊天级未实现成员 | 抛，**被 catch** | toastr（**报因不报果**） | **发布**，但管线死 |
| **本节** | DOM 查询查不到宿主面板 | **不抛** | **无** | **不发布**，且这是"正常"状态 |

**第三种最难查**：前两种至少有一条错误信息可以顺藤摸瓜；
这一种在上游语义里根本不是错误，**所以任何"找错误"的排查方法都找不到它**。

**给我们的通则**：**兼容层不只要实现成员，还要实现成员所在的那个环境的形状。**
`getPreferredScriptId` 要的不是一个 API，是**一段 DOM**。
我们把成员都建齐了，它仍然会因为「页面上没有那个面板」而自我关闭。

---

## 四、一个更大的发现：上游的角色书「择一」不在装配层，在**导入期**

这条不在任务单里，是查 ② 时撞见的，**但它直接影响 49 的 `resolveCardWorldbook`。**

### 四之一 MVU 要的是「primary」

```ts
// [MVU] character_override/index.ts:173-175
this.worldbook_name = getCharWorldbookNames('current').primary;
// 拿不到就 this.worldbook_name = null
```

```ts
// [TH] function/worldbook.ts:46-52
type CharWorldbooks = { primary: string | null; additional: string[] };
export function getCharWorldbookNames(character_name) { return getCharLorebooks({ name: character_name }); }
```

```ts
// [TH] function/lorebook.ts:219-243
if (character.data?.extensions?.world) { books.primary = character.data.extensions.world || null; }
const extra = world_info.charLore?.find(e => e.name === filename);
if (extra && Array.isArray(extra.extraBooks)) { books.additional = extra.extraBooks; }
```

**`primary` 只取 `extensions.world`，也就是「绑定的书名」。内嵌的 `character_book` 完全不参与。**

### 四之二 ST 的装配层也不读内嵌书

```js
// [ST] world-info.js:4363-4379  getCharacterLore()
const baseWorldName = character?.data?.extensions?.world;
if (baseWorldName) worldsToSearch.add(baseWorldName);
const extraCharLore = world_info.charLore?.find(e => e.name === fileName);
if (extraCharLore) worldsToSearch = new Set([...worldsToSearch, ...extraCharLore.extraBooks]);
```

**`character_book` 一个字都没出现。**

### 四之三 内嵌书是**导入期**被物化成具名书的，而且要用户点头

```js
// [ST] world-info.js:5572-5600  checkEmbeddedWorld(chid)
if (characters[chid]?.data?.character_book) { … 弹窗问用户「要现在导入吗?」 … }
// 每张卡只问一次：accountStorage 的 `AlertWI_${avatar}`
// 且仅当 extensions.world 未设、或设了但那本书不在 world_names 里

// [ST] world-info.js:5625-5640  importEmbeddedWorldInfo()
const bookName = character_book?.name || `${name}'s Lorebook`;
const convertedBook = convertCharacterBook(characters[chid].data.character_book);
await saveWorldInfo(bookName, convertedBook, true);
$('#character_world').val(bookName).trigger('change');     // ← 从此它就是 extensions.world
```

### 四之四 所以上游的答案是结构性的，不是运行时择一

**上游在装配时只有一个角色书通道（`extensions.world` + `charLore.extraBooks`）。
内嵌书在被导入之前是惰性的——它不参与任何装配。**

**给 49 的问题（我不下裁断，因为我没读过 `resolveCardWorldbook`）：**

1. 你那条「内嵌 vs 绑定名，**择一**，绝不两者都要」**解决的是重复**
   （你说 2246 条里 1122 条重复）。**上游那边重复根本不会产生**，
   因为内嵌书要么已经物化成具名书（那时它**就是**绑定名，只有一份），要么根本没进来。
2. 所以问题不是「该选哪个」，而是 **「我们要不要复制上游那个物化步骤」**。
   若不复制、而在装配时直接读内嵌书，**我们就是在实现一个上游没有的通道**——
   那属于升级侧，要记 `DEVIATIONS.md`，并且**「择一」这条规则是我们自己造的**，
   上游没有对应物可对齐。
3. **上游的物化是要用户点头的**（每卡一次的确认弹窗）。这一点若我们静默做掉，
   是行为差异；若我们不做，用户从 ST 带过来的卡会表现不同——**两边都要有说法。**

**这条是这次任务的副产品，但我认为它比 ①② 本身重要**，因为它触及的是一条已落的设计规则。

---

## 五、语料使用面：卡内正文里**零**，而这个零有下界性质

```
卡数 22
齿检 pin(eventOn) = 186   （非零，探针活着）

getLorebookSettings         0 次  0 卡
setLorebookSettings         0 次  0 卡
loadWorldInfo               0 次  0 卡
saveWorldInfo               0 次  0 卡
getCharWorldbookNames      11 次  2 卡   语料:魔法少女的扣扣审判1.0 | 新增:灭仇家满门之后…
getCharLorebooks            0 次  0 卡
setCurrentCharLorebooks     0 次  0 卡
getLorebooks / getLorebookEntries / setLorebookEntries / getWorldInfoSettings   全 0
```

**结论要分两层说：**

1. **卡的脚本正文里没有任何一张卡直接调这两个成员。**
2. **但这不等于"只有 MVU 一个消费者"**——**恰恰相反，这个零本身就证明了消费者藏在别处**：
   MVU 是真实消费者，而它对我这个普查**完全不可见**，因为它是远程 bundle。
   44 独立量到：**22 张卡里 16 张至少有一个 CDN import，11 个去重后的地址
   全部指向远程模块，它们各自 import 什么谁也看不见。**

**所以总指挥那句「别只按 MVU 一个消费者建」，语料给不出第二个消费者——
但它同时说明了语料在这个问题上没有发言权。** 判据得从**成员的语义**来，不是从用量来。

**一个可用的旁证**：`getCharWorldbookNames` 有 **2 张卡在正文里直接用**（11 次）。
它和 `getLorebookSettings` 是同一族（读世界书配置），**说明这一族确实有卡内消费者**，
只是这两个具体成员的消费者恰好都在 bundle 里。

---

## 六、未查 / 限定

1. ~~**MVU 签出的版本我没核。**~~ **已核（2026-09-03），限定撤销。**
   卡尺是**实际加载的那份 bundle**，在 `apps/iris/data/default-user/script-bundles/`
   （每个 `.js` 配一份 `.json` 写着 `url` / `fetchedAt` / `bytes`）：

   ```
   be149c7f… 307765 B   MagVarUpdate@beta/artifact/bundle.js
   be149c7f… 307765 B   MagVarUpdate/artifact/bundle.js        ← 和 @beta 字节完全相同
   1376fbd5… 307658 B   .reference/MagVarUpdate/artifact/bundle.js（本地签出，另一个 build）
   ```

   **`@beta` 与无 tag 当前是同一份产物**（同 sha256），核一次覆盖两个。
   **本地签出确实是另一个 build**（差 107 字节）——所以这份文档的源码行号来自一个"近但不同"的版本。
   **但四条承重结构在实际加载的那份里逐条一致**（我对着 minified 正文核过）：
   有条件发布到 `window.parent`、`#tavern_helper` 的 DOM 选举、
   `initButtons` 在 `initGlobals` 之前且第一句无 try、聊天级两层 catch。
   bundle 里那条英文串字面就是 `[MVU] Reinitialization failed`，和现场报的逐字相同。
2. **`variable_init.ts:231/402` 各自用了 `LorebookSettings` 的哪几个字段，我没逐行读。**
   「谁调它」答完了，「用它的哪一部分」没有。**若我们要做部分实现，这条必须先补。**
3. **TH 4.9.1 单版本口径**，一如既往。
4. **§四 的「导入期物化」我读的是 ST 的两个函数**（`checkEmbeddedWorld` /
   `importEmbeddedWorldInfo`），**没有读我们自己的 `resolveCardWorldbook`**——
   所以 §四之四 提的是问题不是判决。
5. **`worldInfoCache` 的失效**我没查（`loadWorldInfo` 里只有写没有清）。
   若上游在别处清，我没找；**这影响"卡改了书之后再读能不能读到新的"。**

---

## 附录：`errorCatched` 的语义

**不在本文主线上**，但它是同一批「卡裸调用、我们没播」的成员，放这里免得只活在消息里。
[TH] `src/function/util.ts:17-41`；卡实际拿到的是 `_` 版，`:43-72`，差别在末尾。

```ts
function errorCatched<T extends any[], U>(fn: (...args: T) => U): (...args: T) => U
```

**它是包装器不是执行器**：吃一个函数、返回一个同签名的函数；被包的函数出错时**报告然后原样重抛**。

```ts
return (...args: T): U => {
  try {
    const result = fn(...args);
    if (isPromise(result)) return result.then(undefined, error => { onError(error) }) as U;
    return result;                       // 成功：原样返回，不包装
  } catch (error) { return onError(error as Error); }
};
```

| | 行为 |
| --- | --- |
| 同步成功 | **原样返回 `fn` 的结果** |
| 同步抛出 | `onError` → 报告 → **重抛** |
| 异步 | `isPromise` 分流，挂 `.then(undefined, onError)`；`onError` 重抛 → **返回的 promise 以同一个 error 拒绝**。成功值原样透传 |

`onError` 做三件事（`_` 版三件，非 `_` 版两件）：

```ts
toastr.error(`<pre style="white-space: pre-wrap">${message}</pre>`, error.name, {
  escapeHtml: false, toastClass: 'toastr w-fit! min-w-[300px]' });
this._th_impl._log(iframe_name, 'error', message);     // ← 仅 _ 版：进 TH 面板日志
throw error;
```

`message` 有一个**特例**：

```ts
error.stack ? (error instanceof ZodError ? [error.message, error.stack].join('\n') : error.stack) : error.message
```

**ZodError 时把 message 和 stack 都拼上**，其余只用 stack。理由显然是 Zod 的 stack 不含校验详情——
而 `mvu_zod.js` 那条线正好产 ZodError，**所以这个特例在我们的语料里是活的**。

### 三条实现判断

1. **价值在「报」不在「拦」，必须保持重抛。**吞掉会改变调用方控制流，卡是按"会抛"写的。
2. **`escapeHtml: false`** 让错误信息以 **HTML** 注入 toast。stack 一般是开发者内容，
   但 `error.message` **可以含模型/用户产生的文本**。跟或不跟都行，
   **但这是要显式记的选择，不是可以顺手决定的默认**。
3. **`_` 版是双写**：toast 给用户、`_log` 给面板。我们若只做其一，是行为差异。

*（`toastClass` 里有 Tailwind 类 `w-fit!` / `min-w-[300px]`，依赖 Tailwind 在宿主存在。
不影响正确性，只影响宽度。知道即可，不值得为它做事。）*
