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

### 附：这 13 个 `world_info_*` 的上游默认值（正读，2026-09-06）

**证据等级升级。**上面那张表原先只映射字段**名**，没有值；`match_whole_words` 的默认
此前只以**转述**形式存在（另一支的文档声称 `world-info.js:69-82` 为 `false`）。下面是
我们自己在 `E:/sillyTavern/SillyTavern`（`package.json` `"version": "1.18.0"`）上
**正读**的结果，行号是这个装机上的行号。

模块初值全在一个连续块里，`[ST] world-info.js:69-82`，逐条打出来（METHODS §十九
「凡是『某类有 N 个』，把那 N 个逐条打出来看一眼」）：

| 行 | 变量 | 出厂初值 | 本机 `settings.json` |
| --- | --- | --- | --- |
| 69 | `world_info_depth` | 2 | 2 |
| 70 | `world_info_min_activations` | 0 | 0 |
| 71 | `world_info_min_activations_depth_max` | 0 | 0 |
| 73 | `world_info_budget` | **25** | **100** ⚠ |
| 74 | `world_info_include_names` | **true** | **false** ⚠ |
| 75 | `world_info_recursive` | **false** | **true** ⚠ |
| 76 | `world_info_overflow_alert` | false | false |
| 77 | `world_info_case_sensitive` | false | false |
| 78 | **`world_info_match_whole_words`** | **false** | false |
| 79 | `world_info_use_group_scoring` | false | false |
| 80 | `world_info_character_strategy` | `insertion_strategy.character_first` = **1** | 1 |
| 81 | `world_info_budget_cap` | 0 | 0 |
| 82 | `world_info_max_recursion_steps` | 0 | 0 |

策略枚举在 `[ST] world-info.js:27-31`：`evenly: 0`、`character_first: 1`、`global_first: 2`。

**三条要点：**

1. **「默认」在这里有两层，而这个文件里它们恰好一致。**模块初值（`:69-82`）与「设置里
   没有这个键时的结果」是同一个值，因为 loader 逐字段写成
   `if (settings.X !== undefined) X = Boolean(settings.X)`（`match_whole_words` 在
   `:934-935`，同族逐条排在 `:920-940` 区间），**键缺失就保留模块初值，没有第二套默认表**。
   所以这一次 `key-missing` 与 `false` 同解——**但这是读出来的，不是从省略推出来的**。
2. **这台机器改过三个**：`budget` 25→**100**（四倍）、`include_names` true→false、
   `recursive` false→**true**。**「schema 默认值答不了这台机器改没改」（METHODS §十九
   的清单）在这里一次命中三条**，其中 budget 那条会让任何按 25% 做的预算估算差四倍。
3. **逐条覆盖用 `??`，不是 `||`**：`entry.matchWholeWords ?? world_info_match_whole_words`
   （`:347`）、`entry.caseSensitive ?? world_info_case_sensitive`（`:269`）。
   **条目上显式写 `false` 会被尊重，只有 `null`/`undefined` 才落到全局值。**

4. **⚠ 顺带查出一条与本仓注释相反的事实：`world_info_include_names` 不是死的。**
   `packages/iris-app-service/src/worldbook-settings.ts:14-17` 的注释写着它
   「verified dead in ST 1.18.0's Chat Completion path (exported, set, never read
   while building the prompt)」。**正读结果是它有且只有一个功能性读点**——
   `[ST] script.js:4565`：

   ```js
   const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
   ```

   下一步 `:4576` 就把 `chatForWI` 交给 `getWorldInfoPrompt(chatForWI, …)`。这一段在
   `Generate()` 函数体的顶层（四空格缩进，`:4400`–`:4580` 之间没有 `main_api == 'openai'`
   的分支把它罩住），**CC 路径照走**。全仓其余命中都是声明/映射/loader/UI 绑定
   （`world-info.js:74, 802, 828, 926-927, 979, 6143-6144`），没有第二个消费点。

   **它决定的是扫描缓冲里带不带 `名字: ` 前缀**，也就是「键里含说话人名字的条目会不会
   命中」——不进最终提示词的文本，但改变哪些条目进。而**本机把它改成了 `false`**（出厂
   `true`），所以在这台机器上按名字写键的条目不会命中，在出厂设置的机器上会。
   *（只报事实与位置：那条注释在 `iris-app-service` 域，我不改。）*

**我们这一侧（main @ `b50c354`）的对账**：`packages/iris-lorebook/src/activate.ts:284` 的
`defaultActivationSettings.matchWholeWords` 现在是 `false`；`:610` 的回退写法
`entry.matchWholeWords ?? settings.matchWholeWords` 与上游 `:347` 同构；`:266-275` 的注释
记着它曾被翻成 `true` 当作本仓的 house default，而卡面 `getLorebookSettings()` 一直报
上游的 `false`。`packages/iris-lorebook/src/matching.ts:84` 直呼时的独立缺省也是 `?? false`。
**三处与上游一致，本条无待改项。**

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

### 三之六 那段 DOM 由谁建、什么时候建：**不是竞态**

#### 建在哪

```
[TH] src/index.ts:46-47              const $app = $('<div id="tavern_helper">').appendTo('#extensions_settings');
                                     app.mount($app[0]);
[TH] src/panel/script/ScriptItem.vue:3-11   <div data-type="script" :data-script-id="script.id" v-show="is_visible">
[TH] src/panel/script/Container.vue:31-33   <div v-for="(script,index) in script_trees"><ScriptItem v-if="isScript(...)">
[TH] src/panel/Script.vue:13/17/26          <Container global /> <Container character v-if 有角色 /> <Container preset />
[TH] src/panel/Script.vue:28-38             <Teleport to="body"><Iframe v-for="script in runtimes" …/></Teleport>
```

**`#tavern_helper` 是 TH 的整个扩展面板**，扩展初始化时挂进 ST 的 `#extensions_settings`。
**它不是为选举建的**——选举搭了这个面板的便车。

#### 一个不对称，比时序更要紧

| | 渲染源 | 覆盖谁 |
| --- | --- | --- |
| **`div[data-script-id]`** | `Container` → `ScriptItem` | **全部脚本**，启用与否都有；`v-show` 过滤搜索（**留在 DOM 里**） |
| **`<iframe>`** | `Teleport to="body"` → `Iframe` | **仅启用的脚本**（`runtimes` ← `enabled_scripts_with_source`） |

**列表项 ⊇ iframe。**一个禁用的脚本**有 div、没有 frame**，所以它从不
`registerAsUniqueScript`，于是被 `.filter(el => registered.has(el))` 滤掉——
**两边靠那个 Set 对齐，不靠 DOM 本身。**

另一处：角色脚本的 `Container` 在 `v-if="character_name !== undefined"` 后面。
**没选角色卡时角色脚本没有列表项**——但那时也没有它们的 frame，所以自洽。

#### 顺序图

```
扩展初始化
  │
  ├─ index.ts:46   建 <div id="tavern_helper"> 并 appendTo('#extensions_settings')
  ├─ index.ts:47   app.mount(...)                        ← 同一次同步渲染
  │                  ├─ Container × 3 → ScriptItem × N   ⇒ div[data-script-id] 全部进 DOM
  │                  └─ Teleport to="body" → Iframe × M  ⇒ <iframe srcdoc> 元素进 DOM（M ≤ N）
  │  ── 同步 patch 到此结束，div 与 iframe 元素都已就位 ──
  ▼
浏览器异步解析每个 iframe 的 srcdoc
  ├─ parent_jquery.js → predefine.js → 卡的 <script type="module">
  ▼
MVU bundle 求值 → store 构造 → registerAsUniqueScript('MVU变量框架')
  │   util/script.ts:51   _.update(window.parent, 'th_unique_check.MVU变量框架', add 自己的 scriptId)
  │   util/script.ts:61   eventEmit(path, getPreferredScriptId())      ← 注册即广播一次
  ▼
每个监听方（含自己）跑 should_enable = (广播值 === getScriptId())
```

**div 在 DOM 里早于任何卡代码执行，这是结构保证不是巧合**：两者在**同一次同步渲染**里落地，
而 iframe 的内容是浏览器**之后**才异步解析的。`Teleport to="body"` 只把 iframe 挪出面板，
**不影响这个先后**。

#### 谁赢：DOM 顺序最后一个，且会自我纠正

`.last()` 取匹配元素里 **DOM 顺序最后一个**，DOM 顺序即 `Script.vue` 的模板顺序：

```
全局脚本 → 角色脚本 → 预设脚本      （容器内按 script_trees 树序）
```

**预设 > 角色 > 全局；同容器内靠后的赢。**

两个实例会经历一个瞬态：

```
A 先注册 → set={A} → 广播 preferred=A                → A: should_enable=true
B 后注册 → set={A,B} → 广播 preferred=(DOM 靠后者)
         → A、B 都收到（eventOn 挂在共享路径上）
         → 若 B 靠后：A 自己翻回 false，B 变 true
```

**每次注册都重播**，所以最终态是 (DOM 顺序, 已注册集合) 的纯函数，**与注册先后无关**。

**但瞬态里"错的那个"确实短暂 enable 过**——它会 `_.set(window.parent,'Mvu',…)` 并 emit，
而**上游不清理那次发布**：`initGlobals` 的 stop 只在 `should_enable && Mvu === 自己` 时才 unset
（`function/global/index.ts:180-182`）。**一个翻回 false 的实例，它写下的 `Mvu` 留在原地。**

#### 三条落到实现上

1. **「等 DOM」是先决条件。**没有 `div[data-script-id]` 列表，`.last()` 返回 `undefined`，
   **谁都选不上，事件再多也没用**。
2. **「等事件」是为多实例收敛。**单实例只靠 DOM 就能起来。
3. **列表要建全部脚本的 div，不能只建启用的。**上游的对齐点是那个 Set 不是 DOM——
   只给启用脚本建 div，单实例仍工作，**但选举结果会在"禁用脚本"这一维上和上游分叉**。
   影响面很小，但它是 §三之五 那条通则的具体一例。

---

### 三之七 请求期：MVU **只做减法**，一个字都不往提示词里加

`initRequest()` 注册五个回调（`.reference/MagVarUpdate/src/function/request/index.ts:7-31`）：

```ts
registerFunction()                                                            // :9
controlledStoppableEventOn('worldinfo_entries_loaded', filterEntries)         // :11
controlledStoppableEventOn(CHAT_COMPLETION_SETTINGS_READY, applyExtraModelRequestOverrides)  // :12-17
controlledStoppableEventOn(CHAT_COMPLETION_SETTINGS_READY, overrideToolRequest)              // :18-23
controlledStoppableEventOn(CHAT_COMPLETION_SETTINGS_READY, filterPrompts)                    // :24-26
```

**名字全是 filter / override，没有一个是 inject。**
**没有 `injectPrompts`、没有 `setExtensionPrompt`、不写世界书、不拦 `generate`。**

两个减法的内容：

- **`filterEntries`**（`filter_entries.ts:43-45`）——**移除 `[mvu_update]` 世界书条目**，
  除非 `更新方式 === '随AI输出'`（默认值）时在 `:44` 提前返回。
- **`filterPrompts`**（`filter_prompts.ts:11-30`）——`'额外模型解析'` 模式下从**历史消息**里
  剥掉 `<UpdateVariable>` 块；**总是**剥掉 `\n<StatusPlaceHolderImpl/>`。

**变量快照也不是 MVU 送的**：MVU 全仓唯一的 `registerMacro` 是
`invoke_extra_model.ts:501` 的 `lastUserMessage`，只在额外模型路径上；
而 TH 的宏只有两个头像路径（`macro.ts:4-7`）。
**「变量当前值」与「更新格式指令」都来自卡自己的世界书条目**，模板求值走
**第三个扩展 ST-Prompt-Template（EjsTemplate）**。

> **责任面因此是划清的**：模型没输出 `<UpdateVariable>` 时，
> **MVU 只可能是"减料的那个"，不可能是"供料的那个"。**

> **⚠ 一处撤回（2026-09-03）。**我据此提过一个机制假设：
> 「设置未加载 → `effective_settings.更新方式` 是 `undefined` →
> `undefined !== '随AI输出'` → `filterEntries` 走移除路径」。**那条不成立。**
>
> ```ts
> // [MVU] src/store.ts:249
> const Settings = z.union([OldSettings, NewSettings]).catch(() => NewSettings.parse({}));
> // :306  Settings.parse(_.get(SillyTavern.extensionSettings, 'mvu_settings', {}))
> ```
>
> **三层兜底**：`_.get` 取不到键给 `{}`；`NewSettings`（`:134`）给
> `更新方式` 带 `.default('随AI输出')`；外面还有 `.catch` 再 parse 一次空对象。
> **它永远不会是 `undefined`。**
>
> **我漏的是两层默认**——`_.get` 的第三参和 zod 的 `.default()`，
> 两者都在我读过的那几行里，我只读了消费点没读构造点。
>
> **所以移除路径的唯一触发条件是有人显式设成 `'额外模型解析'`**，
> 而实测：22 卡零命中、两个 profile 的世界书里零个 `[config_override]` 条目、
> ST 的 `mvu_settings.更新方式` 显式是 `"随AI输出"`。
> **这条从"待观察的风险"降成"待支持的功能"。**

**存放位置**（给实现者）：

| | 在哪 |
| --- | --- |
| 每卡覆盖 | **世界书里 `comment` 含 `[config_override]` 且 `disable === true` 的条目**（`character_override/schema.ts:7`，筛选在 `character_override/index.ts:57`）——**不在卡的 extensions 里** |
| 全局设置 | `SillyTavern.extensionSettings['mvu_settings']`（`store.ts:306` 读 / `:310` 写 / `:316` 重载） |

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

---

## 附录二：`Mvu` 对象的成员清单

**用途**：裁「按名 RPC 代理」还是「共居 realm」。
判据是**同步且返回响应式/函数的成员只能共居**——**实测这一支是空集。**

**口径**：签出 `.reference/MagVarUpdate/src/function/global/index.ts:7-160`（`createMvu()`）；
**11 个成员在实际加载的 bundle 里逐个核过，全部存在**
（`apps/iris/data/default-user/script-bundles/d2245aa5….js`）。

| 成员 | 签名 | 同/异 | 返回什么 | 碰宿主状态 | `this` |
| --- | --- | --- | --- | --- | --- |
| `events` | **属性，非函数** | — | **纯数据**：字符串常量对象（`variable_def.ts:175+`） | 否 | 否 |
| `getMvuData(options)` | `(VariableOption) => MvuData` | **同步** | **纯数据**——`getVariables` 返回 `klona(...)` 深拷贝（[TH] `variables.ts:96-98`） | 读 | 否 |
| `getCurrentMvuData()` | `() => MvuData` | **同步** | **纯数据**，同上 | 读（含 `getCurrentMessageId()`） | 否 |
| `getMvuVariable(data, path, opts)` | `(MvuData, string, {category,default_value}) => any` | **同步** | 传入数据里的一个值（VWD 取 `[0]`） | **否——纯函数** | 否 |
| `getRecordFromMvuData(data, category)` | `(MvuData, 'stat'\|'display'\|'delta') => Record` | **同步** | **传入对象的子引用** | **否——纯函数** | 否 |
| `isDuringExtraAnalysis()` | `() => boolean` | **同步** | boolean，**但是活值**（读 Pinia `useDataStore().runtimes`） | **读** | 否 |
| `replaceMvuData(data, options)` | `=> Promise` | **异步** | void | 写 | 否 |
| `replaceCurrentMvuData(data)` | `async => Promise<void>` | **异步** | void | 写 | 否 |
| `parseMessage(message, old_data)` | `async => Promise<MvuData\|undefined>` | **异步** | 纯数据（`klona` 后就地改） | **读 + 发事件**（走 `substitudeMacros` → ST 宏） | 否 |
| `reloadInitVar(data)` | `async => Promise<boolean>` | **异步** | boolean | 读初始化配置 | 否 |
| `setMvuVariable(data, path, value, opts)` | `async => Promise<boolean>` | **异步** | boolean | **改的是传入的 `mvu_data.stat_data`** | 否 |

### 两条读法

**① 零个成员依赖 `this`。**全是 `createMvu()` 闭包里的普通函数，没有一处 `.call(this)`。
**对代理是好消息**：可以自由重绑定，不像 TavernHelper 那些 `_` 前缀成员靠 `this` 认脚本。

**② 「按名 RPC」不能无差别套到 6 个同步成员上**——**代理会把它们变成异步，而卡是按同步写的**
（`const d = Mvu.getMvuData(...)` 直接用返回值）。

### 三档

| 档 | 成员 | 做法 |
| --- | --- | --- |
| **根本不用跨 frame** | `getMvuVariable`、`getRecordFromMvuData` | **纯函数，对传入数据操作**。任一 frame 本地实现即可，不需要任何通道 |
| **快照 + 失效推送** | `events`（常量，一次即可）、`getMvuData`、`getCurrentMvuData`、`isDuringExtraAnalysis` | 返回纯数据，可复制。**`isDuringExtraAnalysis` 是活值，快照必然过期，只能靠推送** |
| **按名 RPC（异步）** | `replaceMvuData`、`replaceCurrentMvuData`、`parseMessage`、`reloadInitVar`、`setMvuVariable` | 本来就返回 Promise，**跨 frame 不改变契约** |

### 一条代理层不能"顺手优化"的

**`getRecordFromMvuData` 返回的是传入对象的子引用，不是拷贝**：

```ts
// [MVU] global/index.ts:135-152
case 'stat': data = mvu_data.stat_data; break;
…
return data;                          // ← 直接给出去，没有 klona
```

**调用方改它就改了自己那份 `mvu_data`。**这在共居下和跨 frame 下都成立，因为那个对象**本来就是调用方的**。

**但如果我们在代理层"顺手"深拷贝返回值，就破坏了这个语义**——
卡改了返回的 record，以为改到了自己的 `mvu_data`，实际改在一份副本上。
**症状是变量改了但没生效，而且没有任何错误。**

### 单例是靠共享 parent 达成的，不是靠中继

```js
// [TH] iframe/predefine.js:38-45  —— 两种 frame 都注入
if (_.has(window.parent, 'Mvu')) {
  Object.defineProperty(window, 'Mvu', {
    get: () => _.get(window.parent, 'Mvu'),
    set: () => {},            // ← 空 set，卡写不进去
    configurable: true,
  });
}
```

`predefine.js` 在**脚本 frame**（`panel/script/iframe.ts:12`）与
**界面 frame**（`panel/render/iframe.ts:94`）**都注入**。
两种 frame 的 `window.parent` 是**同一个 ST 页面**，所以它们读到的是**同一个对象**。

**「两个 Map、无中继」的根源在这里**：我们的两种 frame 挂在**两个不同的虚拟 parent** 上。
**这不是缺一条中继，是上游那个单例的成立条件在我们这里不存在。**

*（「加中继」和「让两种 frame 共享同一个 parent 命名空间」是两种修法：
前者补通道，后者补上游依赖的那个前提。）*

---

## 附录三：自动清理的计数单位

**结论：三个参数的名字全叫「楼层」，算术全在消息下标上。**

### 单位的确证，两层

```js
// [ST] script.js:6631-6632 与 :6656-6657
const chat_id = (chat.length - 1);
!fromStreaming && await eventSource.emit(event_types.MESSAGE_RECEIVED, chat_id, type);
```

**`MESSAGE_RECEIVED` 的第一个参数就是 chat 数组下标**（含 user 行）。

```js
// [MVU] src/function/cleanup/index.ts:24-45
controlledStoppableEventOn(tavern_events.MESSAGE_RECEIVED, message_id => {
  if (!store.settings.自动清理变量.启用) return;
  if (SillyTavern.chat.length % 5 !== 0) return;                     // 每 5 条「消息」跑一次
  const old_message_id = message_id - store.settings.自动清理变量.要保留变量的最近楼层数;
  //排除对应楼层为user楼层的场合                                      ← 作者原注释
  if (old_message_id > 0) {
    cleanupMessageVariables(
      Math.max(1, old_message_id - 2 - 要保留变量的最近楼层数 * 2),   // 「考虑到部分情况下消息楼层会是 user，所以需要 * 2，寻找更远范围的」
      old_message_id, 快照保留间隔);
  }
})
```

```js
// [MVU] cleanup/cleanup_variables.ts:10-25
SillyTavern.chat.slice(start_message_id, end_message_id + 1).forEach((chat_message, msg_index) => {
  …
  if ((start_message_id + msg_index) % snap_interval === 0) { … }    // 判据是 chat 数组下标 % 50
```

### 逐条

| 参数 | 单位 | 依据 |
| --- | --- | --- |
| **快照保留间隔 50** | **消息下标**（含 user 行） | `(start_message_id + msg_index) % 50 === 0`，`msg_index` 来自 `chat.slice()` |
| **要保留变量的最近楼层数 20** | **消息下标**，往回数 20 条**消息** | `message_id - 20`，而 `message_id` 是 chat 下标 |
| **「楼层 0 永不清」** | **是一条有名字的规则，用 `start = 1` 表达** | 作者明文注释在 `legacy_chat.ts:94`：**「0 层永不清理，以保证始终有快照能力」**。两条路径各自实现它：周期路径用 `Math.max(1, …)`、legacy 路径直接传 `1`。**另有 `0 % 50 === 0` 也让它算快照，但那是巧合不是理由** |
| **触发频率** | `chat.length % 5` | 也是消息计数 |

> **作者自己知道单位是消息**：两处注释专门说「排除对应楼层为 user 楼层的场合」、
> 「考虑到部分情况下消息楼层会是 user，所以需要 `* 2`」。
> **那个 `* 2` 就是为混入的 user 行留的余量——它本身就是"单位是消息下标"的证据。**

**所以按「楼层」（assistant 回合）计数会让恢复点少一半。
这是同一个语义用错了单位，不是另一种权衡**——恢复点少一半的代价是回溯更长。

### 删法：只删五个具名键，其余全留

```js
return _.omit(chat_message.variables[i],
  'initialized_lorebooks', 'stat_data', 'display_data', 'delta_data', 'schema');
```

**上游同样保留 `event_chain` 等外来键。**

### 两条容易漏的机制

**① 逐 swipe 重建，且会截断。**

```js
chat_message.variables = _.range(0, chat_message.swipes?.length ?? 1).map(i => { … })
```

**整个 `variables` 数组被重建成 `swipes.length` 长**，缺失位填 `{}`。
**条目数多于 swipes 时，多出来的被丢掉，上游静默。**

**② `snapshot: true` 是持久化标记，不是每次现算。**

```js
if (_.get(variables[i], 'snapshot') === true) return variables[i];     // 已标记的一律保留
if ((start + msg_index) % snap_interval === 0) {
  _.set(chat_message, ['variables', i, 'snapshot'], true);             // ← 命中间隔就打标记
  return chat_message.variables[i];
}
```

作者注释写明理由：**「考虑到用户会修改楼层间隔，比如从 50→70，因为最小公倍数的原因，
会导致之前的楼层实质上 350 层一个快照，有较大风险」。**

**若只按 `% 50` 现算而不写标记，用户改过间隔之后快照会被稀释到最小公倍数那么稀——
而这个后果要等到改间隔之后才显现。**

### 清理有**两条**路径，只有一条是有界窗口

#### 路径一 · 周期清理：**有界**

```js
// [MVU] cleanup/index.ts:32-45   挂在 MESSAGE_RECEIVED 上
if (SillyTavern.chat.length % 5 !== 0) return;
const old_message_id = message_id - keep;
if (old_message_id > 0) {
  cleanupMessageVariables(Math.max(1, old_message_id - 2 - keep * 2), old_message_id, interval);
}
```

**窗口宽度 `keep*2 + 2`（默认 42 条），随 `message_id` 前移。
比上界更早的楼层此后不再被这条路径触及。**

#### 路径二 · `checkAndCleanupLegacyChat`：**全量，而且带同意与备份**

在 `initCleanup()` 开头**无条件调用**（`cleanup/index.ts:12-13`，仅 `should_enable` 门控）。

**清理范围是整局：**

```js
// [MVU] cleanup/legacy_chat.ts:93-97
const counter = cleanupMessageVariables(
  1,                                              // 0 层永不清理，以保证始终有快照能力。
  SillyTavern.chat.length - 1 - keep,             // 到 (末尾 − 20)
  interval);
```

**四道门**（`legacy_chat.ts:7-14`）：

```js
if (!启用
 || SillyTavern.chat.length <= keep + 5                                // ≤25 条不管
 || !_.has(SillyTavern.chat, [1, 'variables', 0, 'stat_data'])         // ← 下标 1 还有表 = 这局从没被清过
 || _.has(SillyTavern.chat, [1, 'variables', 0, 'ignore_cleanup'])     // ← 用户说过"不再提醒"
) return;
```

**第三道门就是「追赶态」的判据**：**下标 1 仍带 `stat_data` ⇒ 这局从未被清理过。**

**三按钮弹窗与备份**（`legacy_chat.ts:16-91`）：

```js
const result = await SillyTavern.callGenericPopup(tr('runtime.cleanup.legacyPrompt'),
  POPUP_TYPE.CONFIRM, '', { okButton: 只清理, cancelButton: 不再提醒, customButtons: [备份并清理] });

if (CANCELLED || NEGATIVE) {
  _.set(SillyTavern.chat, [1, 'variables', 0, 'ignore_cleanup'], true);   // ← 持久化的拒绝标记
  return;
}
if (CUSTOM1) {                                                            // 备份并清理
  await fetch('/api/chats/export', { method:'POST', body: JSON.stringify({
    is_group:false, avatar_url:…, file:`${chatId}.jsonl`, exportfilename:`${chatId}.jsonl`, format:'jsonl' })});
  … 下载 blob …
}
```

> **上游知道"第一次开启会是一次大删"，并没有回避它——
> 它把这件事做成了一次带同意与备份的仪式。**
> **只做周期窗口而不做这条，就是把一次上游要征得同意的大删变成静默的。**

**`ignore_cleanup` 的键位是 `chat[1].variables[0].ignore_cleanup`**——
**照抄键名与位置，不要另起**（同 §二之六 那条"照抄键名，类型也照抄"）。

#### `restoreVariables` 不参与清理

```js
// [MVU] cleanup/restore_variables.ts:9 / :15 / :50
const last_message_id = SillyTavern.chat.length - 1;
const last_not_has_variable_message_id = SillyTavern.chat.findLastIndex(…);
for (let i = snapshot_message_id + 1; i <= last_not_has_variable_message_id; i++) { … }
```

**它从快照往前重放，全量 `findLastIndex` 只为定位起点，不做任何删除。**
**那条路径不参与追赶。**

### 两条路径执行后在屏幕上说什么

**只记事实与代码位置。**文案取自 `.reference/MagVarUpdate/src/i18n/messages/runtime.ts:254-300`。

#### 周期清理：**只有 `console.log`，没有 toast**

```js
// [MVU] cleanup/index.ts:43
console.log(tr('runtime.cleanup.cleanedFloorsLog', { count: counter }));
```

| 键 | zh-CN | en |
| --- | --- | --- |
| `runtime.cleanup.cleanedFloorsLog` | `[MVU]已清理 {count} 层的消息` | `[MVU] Cleaned messages on {count} floors` |

**无条件打印**（不看 `counter` 是否为 0），**屏幕上没有任何提示**。

#### legacy 全量清理：**`toastr.info`，且仅在 `counter > 0` 时**

```js
// [MVU] cleanup/legacy_chat.ts:98-106
if (counter > 0) {
  toastr.info(
    tr('runtime.cleanup.cleanedMessages', { count: counter }),
    tr('runtime.cleanup.title'),
    { timeOut: 1000 }                                   // ← 1 秒
  );
}
```

| 键 | zh-CN | en |
| --- | --- | --- |
| `runtime.cleanup.cleanedMessages` | `已清理旧聊天记录中的 {count} 条消息` | `Cleaned {count} messages from the old chat history` |
| `runtime.cleanup.title`（标题） | `[MVU]自动清理` | `[MVU] Automatic cleanup` |

**注意两条路径的计数单位在文案上不一致**：周期那条说「{count} **层**」，
legacy 那条说「{count} **条消息**」，**而两者都来自同一个 `cleanupMessageVariables` 的返回值**
（同一个 `counter`，按 chat 下标计数）。**legacy 的措辞是准的，周期那条的"层"是沿用旧称。**

#### 开始清理前的提示（legacy 路径）

```js
// [MVU] legacy_chat.ts:34-40   —— 无 options，走 toastr 默认时长
toastr.info(
  tr(result === POPUP_RESULT.CUSTOM1 ? 'runtime.cleanup.startingWithBackup'
                                     : 'runtime.cleanup.starting'),
  tr('runtime.cleanup.title'));
```

| 键 | zh-CN |
| --- | --- |
| `runtime.cleanup.starting` | `即将开始清理旧聊天记录中的变量…` |
| `runtime.cleanup.startingWithBackup` | `即将开始清理旧聊天记录中的变量，并自动生成备份…` |

#### 备份的两个结果（legacy + CUSTOM1 路径）

```js
// [MVU] legacy_chat.ts:60-73   —— 两者都无 options
toastr.error(  tr('runtime.cleanup.exportFailed',    { cause:   _.escape(String(data.message)) }), tr('runtime.cleanup.title'));
toastr.success(tr('runtime.cleanup.exportSucceeded', { message: _.escape(String(data.message)) }), tr('runtime.cleanup.title'));
```

| 键 | 级别 | zh-CN |
| --- | --- | --- |
| `runtime.cleanup.exportFailed` | **error** | `聊天记录导出失败，放弃清理：{cause}` |
| `runtime.cleanup.exportSucceeded` | **success** | `聊天记录导出成功：{message}` |

**导出失败即 `return`，不清理。**

#### 三按钮弹窗：原文、返回值、渲染顺序

```js
// [MVU] legacy_chat.ts:16-25
const result = await SillyTavern.callGenericPopup(
  tr('runtime.cleanup.legacyPrompt'),
  SillyTavern.POPUP_TYPE.CONFIRM,
  '',
  {
    okButton:      tr('runtime.cleanup.cleanOnlyButton'),        // 仅清理
    cancelButton:  tr('runtime.cleanup.doNotRemindButton'),      // 不再提醒
    customButtons: [tr('runtime.cleanup.backupAndCleanButton')], // 备份并清理
  });
```

**正文（`runtime.cleanup.legacyPrompt`）**：

> **zh-CN**：`检测到可以清理本聊天文件中的旧变量以减小文件体积，是否清理？（备份会消耗较多内存，手机上建议关闭其他后台应用后进行，或在计算机上备份）`
>
> **en**：`Old variables can be removed from this chat to reduce its file size. Clean them now? (Creating a backup uses considerable memory; on mobile, close other background apps first or create the backup on a computer.)`

| 按钮 | 键 | zh-CN | en | 返回值 |
| --- | --- | --- | --- | --- |
| ok | `cleanOnlyButton` | `仅清理` | `Clean only` | `POPUP_RESULT.AFFIRMATIVE` |
| cancel | `doNotRemindButton` | `不再提醒` | `Do not remind me again` | `POPUP_RESULT.NEGATIVE` |
| custom[0] | `backupAndCleanButton` | `备份并清理` | `Back up and clean` | **`2`（= `CUSTOM1`）** |

**返回值来源**：[ST] `scripts/popup.js:55` 的 JSDoc——
「If only strings are provided, the buttons will be added with default options,
**and their result will be in order from `2` onward**」。
MVU 的判据写成 `result === POPUP_RESULT.CUSTOM1 || result === 2`，**两个是同一个值**。

**渲染顺序**：[ST] `scripts/popup.js:73` 的 JSDoc——
「by default it will be **prepended**」；实现在 `:312-315`：

```js
if (button.appendAtEnd) { this.buttonControls.appendChild(buttonElement); }
else { this.buttonControls.insertBefore(buttonElement, this.okButton); }   // ← 默认插在 ok 之前
```

MVU 传的是纯字符串（无 `appendAtEnd`），**所以「备份并清理」被插在「仅清理」之前**。
*（ok 与 cancel 两者的相对顺序来自 popup 模板，我没有读，未在此断言。）*

**`CANCELLED` 与 `NEGATIVE` 走同一分支**（`legacy_chat.ts:27-33`）：
写 `chat[1].variables[0].ignore_cleanup = true` 后 `return`——
**即"按 Esc 关掉"与"点不再提醒"效果相同。**

### 已裁（总指挥，2026-09-03）

1. **周期窗口照做。**
2. **legacy 全量路径本批不自动做**——**只报告 + 照抄 `ignore_cleanup` 键**。
3. **三按钮弹窗与导出备份归后续**（记 ROADMAP）。

---

## 附录四：脚本帧里**不 await** 就同步读 `Mvu`，在上游拿不拿得到

**问题**（2026-09-06，为一条「补齐兼容 vs 我们多给」的裁决）：TavernHelper 4.9.1 的
**脚本帧**里，一段从不 `await waitGlobalInitialized('Mvu')` 的代码同步读 `Mvu` /
`window.Mvu`，能不能拿到对象？

**口径升级**：本附录读的是**已安装的 TH 源码**
（`E:/sillyTavern/SillyTavern/data/default-user/extensions/JS-Slash-Runner`，
`manifest.json` / `package.json` 均为 **4.9.1**，`src/` 目录完整，不只是 `dist/`）。
附录二里那段 `predefine.js:38-45` 的引文来自更早的一次阅读，**行号在 4.9.1 上是
`:37-44`**，内容一致。静态读，没有运行。

### 答案

> **能——但只在 MVU 已经发布之后建起来的帧里，而且靠的是一个在帧启动那一刻
> 只判一次的条件。** 上游的语义不是「总能拿到」，是
> **「帧 bootstrap 时父页已经有 `Mvu`，就装一个活 getter；否则什么都不装」**。

### ① 那个活 getter 装在哪个 window、由谁、什么时机

**装在每个帧自己的 window 上**，由 `predefine.js` 在**帧 bootstrap** 时装，
**条件是父页此刻已经有 `Mvu`**：

```js
// [TH] src/iframe/predefine.js:36-44
// 其实应该用 waitGlobalInitialized 来等待 Mvu 初始化完毕, 这里设置 window.Mvu 只是为了兼容性
if (_.has(window.parent, 'Mvu')) {
  Object.defineProperty(window, 'Mvu', {
    get: () => _.get(window.parent, 'Mvu'),
    // Mvu 脚本自己还会 `_.set()` 自己的变量, 所以这里设置一个空 set
    set: () => {},
    configurable: true,
  });
}
```

三条要点：

- **`window` 是帧自己的**（`predefine.js` 在帧内以经典脚本执行），
  **不是** ST 页面顶层；每个帧各装一份。
- **getter 是活的**：每次读都重新 `_.get(window.parent, 'Mvu')`，
  所以帧拿到的永远是 ST 页面上那一个对象（附录二「单例靠共享 parent」的机制）。
- **`if` 只在 bootstrap 求值一次。**父页当时没有 `Mvu`，
  这个属性**根本不会被定义**——之后 MVU 再发布也不会回填这个帧。
- 上游作者自己在注释里把它定性为**兼容性补丁**，并指明正道是 `waitGlobalInitialized`。

**`Mvu` 是谁放到父页上的**：MVU 自己**也跑在一个脚本帧里**，往 `window.parent` 写：

```js
// [MVU] .reference/MagVarUpdate/src/function/global/index.ts:165-177   initGlobals()
const stop = watch(() => store.should_enable, should_enabled => {
    if (should_enabled) {
        _.set(window.parent, 'Mvu', mvu);      // ← 写在 ST 页面上
        eventEmit('global_Mvu_initialized');
    }
}, { immediate: true });
```

卸载时 `_.unset(window.parent, 'Mvu')`（`:180-183`）。
**所以「父页有没有 `Mvu`」是另一个帧的运行结果**，帧与帧之间的先后决定这件事。

### ② 脚本帧的 srcdoc 头有没有把父页 globals 转发进来

**有，但是按名单逐个转发，而 `Mvu` 不在名单里。**没有 `with(parent)`，没有 Proxy。

```js
// [TH] src/iframe/predefine.js:1              window._ = window.parent._;
// [TH] src/iframe/predefine.js:11-19
let result = _(window);
result = result.merge(_.pick(window.parent, ['EjsTemplate', 'TavernHelper', 'YAML', 'showdown', 'toastr', 'z']));
result = result.merge(_.omit(_.get(window.parent, 'TavernHelper'), '_bind'));
result = result.merge(...Object.entries(_.get(window.parent, 'TavernHelper')._bind)
  .map(([key, value]) => ({ [key.replace('_', '')]: value.bind(window) })));
result.value();
// [TH] src/iframe/predefine.js:26-34          Object.defineProperty(window, 'SillyTavern', { get })
```

**名单是六个**：`EjsTemplate` `TavernHelper` `YAML` `showdown` `toastr` `z`，
外加 `_`（`:1`）、TavernHelper 的成员平铺、`_bind` 成员**绑到帧的 window**、
以及 `SillyTavern` 的自建 getter。**`Mvu` 走的是 `:37-44` 自己那个条件块。**

**装载点是两个，不是一个。**第二个是 `waitGlobalInitialized` 的 `_` 版：

```ts
// [TH] src/function/global.ts:28-42   _waitGlobalInitialized(this: Window, global)
if (_.has(window, global)) {                    // ← 这个 window 是 ST 页面（函数的模块作用域）
  Object.defineProperty(this, global, {         // ← this 是调用方那个帧的 window
    get: () => _.get(window, global),
    configurable: true,
  });
  if (global === 'Mvu') {
    try { await waitUntil(() => _.has(get_variables_without_clone({ type: 'message', message_id: 0 }), 'stat_data')); }
    catch (error) { /** 只是作为保险, 忽略超时时的报错 */ }
  }
  return;
}
return new Promise(resolve => {
  _eventOnce.call(this, `global_${global}_initialized`, async () => { /* 同上，再 resolve */ });
});
```

对照的发布侧：

```ts
// [TH] src/function/global.ts:7-10
export function initializeGlobal(global, value) { _.set(window, global, value); eventSource.emit(`global_${global}_initialized`); }
```

**两个装载点的差别值得记**：predefine 的 getter 读 `window.parent`，
`_waitGlobalInitialized` 的 getter 读 ST 页面的 `window`——上游这两者是同一个对象。
predefine 那个是 `configurable: true`，所以后来的 `defineProperty` 能覆盖它。
**另外 `'Mvu'` 这一支还多等一件事**：0 楼的 message 变量里出现 `stat_data`
（`waitUntil`，超时被吞）。**裸读拿到的对象没有这一层保证。**

### ③ 若裸 `Mvu` 在上游能同步解析，是靠哪一层

靠 ① 那个 getter，**而它成立的前提是执行顺序**：

```html
<!-- [TH] src/panel/script/iframe.ts:6-21  脚本帧的 srcdoc -->
<head>
${third_party}
<script src="${parent_jquery_url}"></script>     <!-- :11 -->
<script src="${predefine_url}"></script>          <!-- :12 -->
…
</head>
<body>
<script type="module">                            <!-- :17 -->
${…卡的脚本正文…}
</script>
</body>
```

**`predefine.js` 是 `<head>` 里的经典脚本（同步、阻塞、按序），
卡的正文是 `<body>` 里的 `type="module"`（天然 defer）**——
**所以 predefine 一定先跑完**。界面帧同理（`src/panel/render/iframe.ts:94` 同一个
`predefine_url`）。因此在同一个帧内，「不 await 就读」与「await 之后读」
**看到的是同一个 getter**，不存在竞态。

**竞态在帧之间**：`:37` 那个 `if` 判的是**这个帧建起来的那一刻**父页有没有 `Mvu`，
而那由 MVU 所在的**另一个帧**何时跑到 `_.set(window.parent, 'Mvu', mvu)` 决定。

**没装上时的两种失败形态不一样，照抄时要分清**：属性根本没定义 ⇒
`window.Mvu` 读作 **`undefined`**（静默），而裸标识符 `Mvu` 抛
**`ReferenceError`**（响亮）。同一份卡代码用哪种写法，决定它是静默降级还是当场炸。

### 一句话给裁决用

> 上游的行为是**「bootstrap 时若已存在则装活 getter」**，不是「总是可用」。
> 所以「在帧启动时按父页现状装一次」是**补齐兼容**；
> 而「无条件、任何时候都能同步拿到」**比上游更强**，属于我们多给——
> 上游在 MVU 尚未发布时建起来的帧里，同样拿不到，且没有回填。
> *（我们语料里那三个从不 await 的单元——魔法少女监视器 / 灭仇家气泡面板 /
> 绿茵好莱坞状态栏——在上游能不能跑，取决于它们所在的帧是否晚于 MVU 发布；
> **这一条我没有观测**，只能由运行时序回答。）*
---

## 附录五：上游能不能回看历史楼层的 `stat_data`

**问题**（2026-09-06，为 `ACTION-PLAN.md` §二 第 4 项「状态面板只显示最新 turn 的变量」）：
上游的变量查看面能不能回看历史楼层？入口在哪、按什么寻址、显示的是候选表还是行级表。

**口径**：正读已安装的 TavernHelper **4.9.1**
（`E:/sillyTavern/SillyTavern/data/default-user/extensions/JS-Slash-Runner`，`src/` 完整）
与 `.reference/MagVarUpdate`。只读，没有打开 ST，没有点开任何面板——
**以下全部是静态读，没有一条经过运行确认。**

### 答案

> **能。**上游有一个能按楼号回看的变量面，但它**不在 MVU 里**，在 **TavernHelper 的
> 「变量管理器 → 消息楼层」**。它按 `message_id` 寻址、可以给一个**楼号区间**、
> 显示的是**行级表**（那一楼**当前 swipe** 的那一格），**而且可写**。

### ① 入口：TH 面板 → 工具 → 变量管理器 → 消息楼层

| 层 | 位置 |
| --- | --- |
| TH 面板的「工具」页签 | `[TH] src/Panel.vue:116`　`{ key: 'toolbox', name: t\`工具\`, icon: 'fa-solid fa-toolbox', component: Toolbox }` |
| 「变量管理器」按钮 → 对话框 | `[TH] src/panel/Toolbox.vue:17`（按钮）、`:72-78`（`<Dialog storage-id="variable-manager" :title="t\`变量管理器\`">`） |
| 五个页签 | `[TH] src/panel/toolbox/VariableManager.vue:30-40`：全局 / 预设 /（有角色时）角色 / 聊天 / **消息楼层** |
| 楼层页 | `[TH] src/panel/toolbox/variable_manager/Message.vue`（128 行）+ `MessageItem.vue`（149 行） |

**MVU 自己没有变量查看面。**`.reference/MagVarUpdate/src/panel/` 的七个区块是
Button / CharacterOverride / Cleanup / Compatibility / Notification / Update / Version
（`Panel.vue:21-27`），**`src/panel/` 下没有任何文件提到 `stat_data`**（grep 零命中）。
所以「MVU 的状态视图」这个东西**不存在**；查看变量在上游是 TavernHelper 的职责。

### ② 寻址：楼号区间 + 一个「追踪最新」开关，负数是从末尾数

```js
// [TH] src/panel/toolbox/variable_manager/Message.vue:110-121
const messages = computed(() => {
  if (chat_length.value === 0) return [];
  const range = from.value > to.value ? _.range(to.value, from.value + 1) : _.range(from.value, to.value + 1);
  const result = sync_bottom.value ? range.toReversed() : range;
  return result.map(value => ({
    message_id: sync_bottom.value ? value - chat_length.value : value,   // ← 追踪模式下是负数
  }));
});
```

- **两个数字输入框 `from` / `to`**（`:24-33`），`min=0`、`max=chat_length - 1`，
  中间一个 `~`，右侧常驻显示「最新楼层号: {chat.length - 1}」。
  **初值是最后三楼**：`to = chat_length - 1`，`from = max(0, to - 2)`（`:80-81`）。
- **`sync_bottom`（「追踪最新」/「正序显示」）**（`:19-20`、`:78`）：
  开着时楼号写成**负数**（`value - chat_length`），也就是**相对末尾**寻址，
  新楼到达时窗口自动跟着走（`:82-91` 的 watch 保持区间宽度不变）；
  关掉则是绝对楼号，`to` 输入框被禁用。
- 渲染用 `VirtList`（虚拟列表，`item-key="message_id"`），所以区间开大也不铺满 DOM。
- 每个 `MessageItem` 自己把负数折回绝对楼号：
  `normalized_message_id = messageId < 0 ? chatLength + messageId : messageId`
  （`MessageItem.vue:49-51`），标题写「第 N 楼」，旁边有一个「重新渲染第 N 楼」的按钮
  （`refreshOneMessage`，`:82-85`）。

**所以 `swipe` 不是寻址的一维**：面板只传 `message_id`，没有 swipe 参数。

### ③ 显示的是**行级表**——那一楼**当前 swipe** 的那一格

数据来自 `getVariables({ type: 'message', message_id })`（`MessageItem.vue:87`），
刷新时走同一族的 `get_variables_without_clone`（`:127`）：

```ts
// [TH] src/function/variables.ts:56-70   get_variables_without_clone(option)
case 'message': {
  const normalized_message_id =
    option.message_id === undefined || option.message_id === 'latest' ? -1 : option.message_id;
  if (!_.inRange(normalized_message_id, -chat.length, chat.length)) {
    throw Error(`提供的消息楼层号 '${option.message_id}' 超出了范围 [${-chat.length}, ${chat.length})`);
  }
  let chat_message;
  if (option.message_id === undefined || option.message_id === 'latest') {
    chat_message = chat.filter(chat_message => !chat_message.is_system).at(normalized_message_id);
  } else {
    chat_message = chat.at(normalized_message_id);
  }
  return chat_message?.variables?.[chat_message?.swipe_id ?? 0] ?? {};
}
```

**三条要点：**

1. **返回的是 `variables[swipe_id]`，不是 `variables` 整个数组。**
   `variables` 在盘上是**按 swipe 下标的数组**（附录三「逐 swipe 重建」那条），
   而这里只取**当前选中的那一格**，缺省 `0`。
   **所以面板给的是行级表，不是候选表**；同一楼的其它 swipe 的 `stat_data`
   **在这个面板上看不到**，要看只能去聊天里把那一楼切到那个 swipe——
   切完会发 `MESSAGE_SWIPED`，`MessageItem` 监听到就重读（`:52-66`）。
2. **显式楼号与 `'latest'` 走的是两条不同的取法**：显式楼号是
   `chat.at(id)`——**原始下标，包含 `is_system` 行**；`'latest'`/不传才先
   `filter(m => !m.is_system)` 再 `.at(-1)`。**面板传的永远是显式楼号**
   （追踪模式下是负数，仍走 `chat.at`），**所以它看的是含 system 行的原始下标。**
3. **越界抛错而不是返回空**：`_.inRange(id, -chat.length, chat.length)`，
   消息是中文原文（上面那句）。

**`stat_data` 就在这个对象里**：MVU 把它写在
`chat[i].variables[swipe].stat_data`（附录三的删法 `_.omit(chat_message.variables[i],
'initialized_lorebooks', 'stat_data', 'display_data', 'delta_data', 'schema')` 是同一处），
所以这个面板显示的 JSON 里 `stat_data` / `display_data` / `delta_data` 是同级的键。
渲染用 `JsonEditor`（`MessageItem.vue:26`），带 `schemas_store.message` 的 schema。

### ④ 它是**可写的**，而且写回会落盘

```ts
// [TH] src/panel/toolbox/variable_manager/MessageItem.vue:145-147
const { ignoreUpdates } = watchIgnorable(variables, new_variables => {
  replaceVariables(klona(new_variables), { type: 'message', message_id: props.messageId });
});
```

```ts
// [TH] src/function/variables.ts:130-149   replaceVariables 的 message 分支
const chat_message = chat.at(option.message_id);
if (!_.has(chat_message, 'variables')) {
  _.set(chat_message, 'variables', _.times(chat_message.swipes?.length ?? 1, _.constant({})));
}
if (_.isPlainObject(_.get(chat_message, 'variables'))) {          // ← 旧的对象形状就地转成数组
  _.set(chat_message, 'variables', _.range(0, chat_message.swipes?.length ?? 1).map(i => chat_message.variables[i] ?? {}));
}
_.set(chat_message, ['variables', _.get(chat_message, 'swipe_id', 0)], variables);
saveChatConditionalDebounced();
```

**写也只写当前 swipe 那一格**，并 `saveChatConditionalDebounced()` 落盘。
**所以这个面板不是只读视图，是一个历史楼层变量的编辑器。**

### ⑤ 刷新节奏：2 秒轮询 + 按楼号过滤的事件，流式期间暂停

- **外层**：`useIntervalFn(() => refresh_key = Symbol(), 2000)`（`Message.vue:96-98`）；
  收到 `STREAM_TOKEN_RECEIVED` 就 `pause()`，等 `MESSAGE_RECEIVED` 再 `resume()`
  （`:99-104`）；`CHAT_CHANGED` 强制刷一次（`:105-107`）。
- **每个楼层项**：监听 `MESSAGE_UPDATED` / **`MESSAGE_SWIPED`** /
  `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED`，**只在事件带的楼号等于
  自己那一楼时**才重读（`MessageItem.vue:52-66`）。
- 重读时先 `_.isEqual` 比对，不同才写进 ref（`:126-135`），避免编辑器被无谓重建。

### 一句话给裁决用

> **上游没有「只能看最新一楼」这个限制**：TavernHelper 的变量管理器有一个按楼号区间
> 回看的「消息楼层」页，可回看、可编辑、可落盘。**但它的粒度是「楼 × 当前 swipe」，
> 不是「楼 × 全部候选」**——同一楼其它 swipe 的表在上游也看不到，
> 除非把那一楼切过去。
> *（另：这个面在 TavernHelper 里，不在 MVU 里；MVU 的设置面板七个区块没有一个碰
> `stat_data`。所以按「MVU 的状态视图」去找会找不到东西。）*

### 未查 / 限定

1. **没有运行确认**：没有打开过这个面板，以上全部从源码读出。
   能廉价证伪的观测是在**我们自己的实例**上开 TH 面板 → 工具 → 变量管理器 → 消息楼层，
   把区间调到历史楼看有没有 `stat_data`。**不在用户的 ST 上做**（它是可写面板，
   点进去就有改状态的风险）。
2. **`VariableManager_deprecated.vue` / `variable_manager_deprecated/` 我没有读**——
   4.9.1 里两套并存，我只读了现役那套；哪一套在用户界面上真正挂着，没有核。
3. **`JsonEditor` 与 `schemas_store.message` 的 schema 内容没有读**，
   所以「面板会不会对 `stat_data` 做特殊呈现」这一格没有答案；
   从 `MessageItem.vue` 看它就是一个通用 JSON 编辑器。
4. **`getVariables` 的 clone 语义没有在本附录复核**（附录二记过：`getVariables` 返回
   `klona` 深拷贝，而 `get_variables_without_clone` 不拷贝）。面板初值用前者、
   刷新用后者，这个差别对显示无影响，对「编辑器改的是不是活对象」有影响，未展开。
