# 上游语义：A 级三格的真值（世界书编辑器保存路径 / 预设八族 / 聊天导入导出）

**给 6d 与 9d 当对账底稿。只给事实与位置，不评价任何实现，不给建议。**

## 口径

- **正读**。源是用户本机装机 `E:/sillyTavern/SillyTavern`，`package.json` `"version": "1.18.0"`。
  行号是这个装机上的行号；前端指 `public/`，后端指 `src/endpoints/`。
- 只读：没有启动 ST、没有点任何界面、没有改任何文件；`secrets.json` 未读。
- 语料侧的计数取自 `data/default-user/worlds`（18 本书），**只读**。
- **静态读，不是观测**：以下没有一条经过运行确认。凡是「会发生 X」的句子都是从代码读出的，
  能廉价证伪的方式写在 §四。
- 另一支分支的 `ST-COMPARE.md` / `IMPLEMENTATION-CHECKLIST.md` 对这三格各有一句转述，
  **本文件逐条复核，差异列在 §四**。

---

## 一、世界书编辑器：一次编辑怎么落到盘上

### 1.1 链路一句话

> 每个字段的 `input` 处理器**双写**（写 `data.entries[uid].X`，再写
> `originalData` 里对应的盘面路径），然后 `await saveWorldInfo(name, data)`；
> `saveWorldInfo` 更新内存缓存并**防抖 1000 ms**，`_save` 把**整个 data 对象**
> POST 给 `/api/worldinfo/edit`，后端 `JSON.stringify(data, null, 4)` 原子写盘。

**没有「脏字段」概念，也没有增量补丁**：任何一个字段变了，整本书重写一遍。

### 1.2 逐段代码

**字段处理器（每个字段一份，形状一致）**，以 `automationId` 为例：

```js
// [ST] world-info.js:3737-3745
automationIdInput.on('input', async function (_, { noSave = false } = {}) {
    const uid = $(this).data('uid');
    const value = $(this).val();
    data.entries[uid].automationId = value;
    setWIOriginalDataValue(data, uid, 'extensions.automation_id', data.entries[uid].automationId);
    !noSave && await saveWorldInfo(name, data);
});
automationIdInput.val(entry.automationId ?? '').trigger('input', { noSave: true });
```

**`{ noSave: true }` 的那次初始化 trigger 是必须的形状**：渲染时用同一个处理器把值填进
控件，但**不落盘**。照抄时漏掉这个参数，会变成「打开编辑器就把整本书写一遍」。

**保存与防抖：**

```js
// [ST] world-info.js:4097-4110
export async function saveWorldInfo(name, data, immediately = false) {
    if (!name || !data) { return; }
    worldInfoCache.set(name, data);          // 先更新缓存，后续读走缓存
    if (immediately) { return await _save(name, data); }
    saveWorldDebounced(name, data);
}

// [ST] world-info.js:83
const saveWorldDebounced = debounce(async (name, data) => await _save(name, data), debounce_timeout.relaxed);
// [ST] public/scripts/constants.js:14   relaxed: 1000
```

```js
// [ST] world-info.js:4071-4081
async function _save(name, data) {
    cancelDebounce(saveWorldDebounced);      // 防止立即保存与防抖保存双发
    await fetch('/api/worldinfo/edit', {
        method: 'POST', headers: getRequestHeaders(),
        body: JSON.stringify({ name: name, data: data }),
    });
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}
```

**后端只做两件校验，然后整份落盘：**

```js
// [ST] src/endpoints/worldinfo.js:134-157   POST /api/worldinfo/edit
if (!request.body.name) return response.status(400).send('World file must have a name');
if (!('entries' in request.body.data)) return response.status(400).send('Is not a valid world info file');
const filename = sanitize(`${request.body.name}.json`);
writeFileAtomicSync(path.join(request.user.directories.worlds, filename), JSON.stringify(request.body.data, null, 4));
return response.send({ ok: true });
```

**校验只有「有 name」「有 entries 键」两条**——不看 entries 的内容、不看字段类型、
不看 uid 是否合法。**四空格缩进**（与预设端点一致，见 §二）。

**读回路径不做任何重建：**

```js
// [ST] world-info.js:2036-2059   loadWorldInfo(name)
if (worldInfoCache.has(name)) return worldInfoCache.get(name);   // 进程内缓存优先
const response = await fetch('/api/worldinfo/get', …);           // 后端 readWorldInfoFile 原样 JSON.parse
```

```js
// [ST] src/endpoints/worldinfo.js:17-35   readWorldInfoFile
const worldInfo = JSON.parse(fs.readFileSync(pathToWorldInfo, 'utf8'));
return worldInfo;                                   // 文件不存在时 allowDummy 给 { entries: {} }
```

**其余三个端点**：`/list :39`、`/delete :81`（文件不存在时 **throw**，不是 404）、
`/import :99`。前端删书在 `world-info.js:4239`，建书 `createNewWorldInfo :4336`，
改名 `renameWorldInfo :4112`（**实现是「新名存一份 + 删旧名」**，不是重命名文件）。

### 1.3 条目的字段表：**42 个定义，39 个进模板**

权威表是 `newWorldInfoEntryDefinition`（`[ST] world-info.js:4002-4045`），每项
`{ default, type }`，逐条数出来 **42 个字段**。其中 **3 个带 `excludeFromTemplate: true`**
（`characterFilterNames`、`characterFilterTags`、`characterFilterExclude`），所以

```js
// [ST] world-info.js:4047-4049
export const newWorldInfoEntryTemplate = Object.fromEntries(
    Object.entries(newWorldInfoEntryDefinition).filter(([_, v]) => !v.excludeFromTemplate).map(([k, v]) => [k, v.default]),
);
```

**模板 39 个键**；`createWorldInfoEntry`（`:4057-4069`）再加一个 `uid`，
所以一个新建条目对象是 **40 个键**。

几个默认值值得单记（照抄要照抄值）：`selective: true`、`order: 100`、`position: 0`、
`probability: 100`、`useProbability: true`、`depth: DEFAULT_DEPTH`（`= 4`，`:96`）、
`groupWeight: DEFAULT_WEIGHT`（`= 100`，`:97`）、`role: 0`、
以及**五个 `null` 默认的可空覆盖位**：`scanDepth`、`caseSensitive`、`matchWholeWords`、
`useGroupScoring`（类型写作 `'number?'`/`'boolean?'`），加上 `sticky`/`cooldown`/`delay`。
`null` 在这里不是「未设置的占位」，是**「落到全局设置」的显式表达**——
消费点是 `entry.matchWholeWords ?? world_info_match_whole_words`（`:347`），
见 `UPSTREAM-MVU-INIT-PATH.md` 的默认值附录。

### 1.4 `originalData`：**写入盘、但全仓没有读者**

盘面键名映射表 `originalWIDataKeyMap`（`[ST] world-info.js:2607-2644`），**36 个字段**。

两张表**对不齐，而且两个方向都有缺口**（用脚本对的，不是眼看的）：

- **在定义里、不在映射里的 8 个**：`addMemo`、`disable`、`useProbability`、
  `outletName`、`group`、`characterFilterNames`、`characterFilterTags`、
  `characterFilterExclude`。
- **在映射里、不在定义里的 2 个**：`displayIndex`（列表显示序）、
  **`enabled`**——它是 `disable` 的**反义**盘面字段，写在 `:3253`
  （`setWIOriginalDataValue(data, uid, 'enabled', isActive)`）。
  **同一件事在运行时叫 `disable`、在盘上叫 `enabled`，值相反。**

**这 8 个缺口今天不产生后果，原因要说清**：`data.originalData` 在
**整个 `public/`（排除 `third-party` 与 `lib/`）里只出现在 `world-info.js` 一个文件**，
而该文件里的每一处都是**写**：创建于 `:5499`
（`convertCharacterBook` 的 `const result = { entries: {}, originalData: characterBook }`），
由 `setWIOriginalDataValue :2676-2686` / `deleteWIOriginalDataValue :2694-2704` 改，
`:5938` 处删。**没有任何一处读它来产生输出**——运行时一律走 `data.entries`。

> 所以 1.18.0 里 `originalData` 是**只写状态**：它的作用是把导入时那份原始
> `character_book` 原样留在盘上，但这一版没有任何消费者。
> **8 个字段没有镜像，代价要等到有人开始读它的那一天才出现。**

**语料对账（18 本书，只读）**：**12 本带 `originalData`，6 本不带**——
带的是由卡内嵌书物化来的（`:5499` 那条路径），不带的是原生/手建的。
把 12 本逐本对 `Object.keys(entries).length` 与 `originalData.entries.length`：
**12/12 相等**（80/80、36/36、46/46、140/140、26/26、51/51、168/168、22/22、
12/12、19/19、129/129、74/74）。

> 代码上是可能漂的：`createWorldInfoEntry` 只往 `entries` 里加，
> 而 `setWIOriginalDataValue` 在 `originalData` 里找不到该 uid 时**直接 return**
> （`:2680-2682`），于是新条目在镜像里没有对应项。
> **但这台机器上一例都没有发生**——所以这是「机制存在、语料零实例」，
> 不是「已观测到的漂移」。

---

## 二、预设：**八个目录、三个端点、103 行**

`[ST] src/endpoints/presets.js`，**全文 103 行**，只有三条路由。

### 2.1 apiId → 目录

```js
// [ST] src/endpoints/presets.js:16-38   getPresetSettingsByAPI(apiId, directories)
case 'kobold': case 'koboldhorde':  → directories.koboldAI_Settings, '.json'
case 'novel':                       → directories.novelAI_Settings,  '.json'
case 'textgenerationwebui':         → directories.textGen_Settings,  '.json'
case 'openai':                      → directories.openAI_Settings,   '.json'
case 'instruct':                    → directories.instruct,          '.json'
case 'context':                     → directories.context,           '.json'
case 'sysprompt':                   → directories.sysprompt,         '.json'
case 'reasoning':                   → directories.reasoning,         '.json'
default:                            → { folder: null, extension: null }
```

**九个 case 标签、八个目录**（`kobold` 与 `koboldhorde` 共用一个）。扩展名全是 `.json`。

盘面目录名（`[ST] src/constants.js:16-48` 的 `USER_DIRECTORY_TEMPLATE`，
经 `src/users.js:683-697` 拼成 `<DATA_ROOT>/<handle>/<模板值>`）：

| apiId | 目录键 | 盘上的目录名 |
| --- | --- | --- |
| `kobold` / `koboldhorde` | `koboldAI_Settings` | `KoboldAI Settings` |
| `novel` | `novelAI_Settings` | `NovelAI Settings` |
| `textgenerationwebui` | `textGen_Settings` | `TextGen Settings` |
| `openai` | `openAI_Settings` | **`OpenAI Settings`** |
| `instruct` | `instruct` | `instruct` |
| `context` | `context` | `context` |
| `sysprompt` | `sysprompt` | `sysprompt` |
| `reasoning` | `reasoning` | `reasoning` |

**四个带空格与大小写的老目录名，四个全小写的新目录名。**
（UI 三族 `themes` / `movingUI` / `QuickReplies` 也在同一张模板表里，
但**不经过 `presets.js`**——它们不是这三条路由的 apiId。）

### 2.2 三条路由

```js
// [ST] presets.js:41-57   POST /save
const name = sanitize(request.body.name);
if (!request.body.preset || !name) return response.sendStatus(400);
const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
if (!settings.folder) return response.sendStatus(400);          // ← 未知 apiId 在这里被拒
writeFileAtomicSync(path.join(settings.folder, name + settings.extension),
                    JSON.stringify(request.body.preset, null, 4), 'utf-8');
return response.send({ name });
```

**三条形状**：① 文件名 = `sanitize(name) + '.json'`，**没有 id，文件名就是身份**；
② **四空格缩进**（与世界书一致）；③ 未知 apiId 的拒绝发生在 `!settings.folder`，
返回 **400 无消息体**。

```js
// [ST] presets.js:59-79   POST /delete
// 同样先 sanitize + 查目录；存在则 unlinkSync → 200，不存在 → 404
```

```js
// [ST] presets.js:81-102  POST /restore   —— 「出厂重置」
const defaultPresets = getDefaultPresets(request.user.directories);
const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);
const result = { isDefault: false, preset: {} };
if (defaultPreset) { result.isDefault = true; result.preset = getDefaultPresetFile(defaultPreset.filename) || {}; }
return response.send(result);
```

**`/restore` 不写盘、不删文件**：它**只返回**出厂内容与一个 `isDefault` 标志，
由前端决定怎么用。名字不在出厂清单里时返回 `{ isDefault: false, preset: {} }`，
**HTTP 200**，不是 404。出厂内容来自 `./content-manager.js` 的
`getDefaultPresets` / `getDefaultPresetFile`。

**这三条路由里没有 list**：预设清单不从这里来——`settings/get` 一次带出
`*_setting_names` 与全部内容（`ST-COMPARE.md` §14 的转述，我没有复核那一段）。

---

## 三、聊天导入 / 导出

`[ST] src/endpoints/chats.js`，全文 **1077 行**，`router.post` 共 **13 条**：
`/save :470`、`/get :517`、`/rename :546`、`/delete :579`、**`/export :604`**、
`/group/import :676`、**`/import :696`**、`/group/get :797`、`/group/info :808`、
`/group/delete :825`、`/group/save :847`、`/search :874`、`/recent :979`。
（非群 8 条 + 群 5 条。）

### 3.1 `POST /api/chats/export`（`:604-672`）

**入参**：`file`、`avatar_url`、`is_group`、`exportfilename`、`format`。

- 目录：`is_group ? directories.groupChats : path.join(directories.chats, avatar_url.replace('.png',''))`；
  非群路径过 `isPathUnderParent` 越界检查（`:612-614`），群**不过**。
- 文件不存在 → **404 + JSON `{ message }`**（`:617-624`）。
- **`format === 'jsonl'` 是短路径**：`fs.readFileSync` 后**原样**放进
  `{ message, result: rawFile }` 返回（`:624-643`）。**逐字节等于盘上的文件。**
- **其它 format 走纯文本转写**（`:644-668`）：逐行 `JSON.parse`，
  **`data.is_system` 的行整条跳过**，其余拼成

  ```js
  const message = (data?.extra?.display_text || data?.mes || '').replace(/\r?\n/g, '\n');
  buffer += `${name}: ${message}\n\n`;
  ```

  **注意取值顺序是 `extra.display_text` 优先于 `mes`**——导出的是**显示文本**，
  不是存储原文；两者不同的场合（正则改写过的楼层）导出的与盘上的不是同一份字。

### 3.2 `POST /api/chats/import`（`:696-793`）

**入参**：`file_type`（`'json'` / `'jsonl'`）、`avatar_url`、`character_name`、
`user_name`，加 multipart 的 `request.file`。目录同样过 `isPathUnderParent`（`:710-712`）。

**json 分支**（`if (format === 'json')`，`:718`）**按文件特征分派五种外来格式**
（`:722-737`），顺序即优先级：

| 判据 | 格式 | 转换函数 |
| --- | --- | --- |
| `jsonData.savedsettings !== undefined` | Kobold Lite | `importKoboldLiteChat :215` |
| `jsonData.histories !== undefined` | CAI Tools | `importCAIChat :180` |
| `Array.isArray(jsonData.data_visible)` | oobabooga | `importOobaChat :110` |
| `Array.isArray(jsonData.messages)` | Agnai | `importAgnaiChat :151` |
| `jsonData.type === 'risuChat'` | RisuAI | `importRisuChat :288` |
| 都不中 | —— | `console.error` + `response.send({ error: true })` |

**转换函数可以返回数组**（`:747-752`）：一个文件可以变成**多个** jsonl 文件，
逐个走 `handleChat`。

**jsonl 分支**（`if (format === 'jsonl')`，`:758`）：

```js
const jsonData = JSON.parse(lines[0]);                       // 只解析首行
if (!(jsonData.user_name !== undefined || jsonData.name !== undefined || jsonData.chat_metadata !== undefined)) {
    console.error('Incorrect chat format .jsonl');
    return response.send({ error: true });
}
```

> **校验只看首行的三个键之一存在**，**其余每一行都不解析**。
> 首行合法、第 500 行是坏 JSON 的文件会被完整收下。

随后**无条件尝试 Chub 扁平化**（`flattenChubChat`，定义在 `:258`，调用在 `:775`），
包在 try/catch 里，失败只 `console.warn`（`:772-778`）。注释写明了理由：扁平化很少坏，
不值得为它拒收正常聊天。**扁平化改变了内容才写新文件，否则 `copyFileSync` 原文件。**

**落名规则（两个分支相同）**：

```js
const fileName = `${characterName} - ${humanizedDateTime()} imported.jsonl`;
```

`characterName` 与 `userName` 都过 `sanitize()`，缺省 `'Character'` / `'User'`（`:701-702`）。

### 3.3 两条形状要点

1. **拒绝在响应体里，不在状态码里。**两个分支的失败都是
   `response.send({ error: true })`，**HTTP 200**。只有缺 body / 缺 file / 路径越界
   才是 `sendStatus(400)`。照抄状态码语义时这一条会被漏掉。
2. **导出的 jsonl 是逐字节原文，导入的 jsonl 只校验首行。**
   这两句合起来就是上游的迁移契约：**出去是保真的，进来是几乎不设防的。**

---

## 四、与转述的差，以及未查

### 4.1 逐条对账（另一支分支的说法 → 正读）

| 转述 | 正读 | 性质 |
| --- | --- | --- |
| `presets.js:12-45,48-117`「8 族预设文件按 apiId 读写」 | **全文只有 103 行**；`getPresetSettingsByAPI` 在 `:16-38`，`/save :41`、`/delete :59`、`/restore :81`。**八个目录、九个 case** 的结论对 | 行号越出文件末尾，结论对 |
| `chats.js:604,696` = import/export | **两个都精确** | 对 |
| 「chats 组 10 端点（`chats.js:470-979`）」 | 实际 **13 条**（非群 8 + 群 5）；`470-979` 这个范围对 | 计数偏小 3（转述把 `group_*` 并成了一项） |
| 「条目编辑器 30+ 字段」 | `newWorldInfoEntryDefinition` **42 个**，模板 **39 个**，新建对象 **40 键** | 「30+」成立但太粗 |
| 「同一端点还转换 Kobold Lite / CAI / oobabooga / Agnai / Risu 五种 JSON」 | **五种精确**，判据与顺序见 §3.2 | 对 |

### 4.2 未查 / 限定

1. **`/import` 的五个转换函数内部没有逐行读**（`:110-315`）。
   本文件只确认了**分派判据与顺序**，没有确认每个转换器产出的 jsonl 形状。
2. **预设清单从哪来没有复核**：转述说走 `settings/get` 的 `*_setting_names`，
   我只确认了 `presets.js` 里**没有** list 路由。
3. **出厂预设的数量没有复核**（转述给的 34 context / 38 instruct / 13 sysprompt /
   5 reasoning / 24 novel / 6 textgen 来自实机首启日志，不是源码）。
   `getDefaultPresets` 在 `./content-manager.js`，我没有打开。
4. **世界书 `/import :99` 与前端 `:5785` 的导入路径没有展开**——
   本节只走了「编辑 → 保存」这一条。
5. **`originalData` 的「只写」结论是静态的**：判据是
   `grep -rln originalData public/scripts public/script.js`（排除 `third-party` 与 `lib/`）
   **只命中 `world-info.js` 一个文件**，且该文件内 15 处命中逐条看过全是写。
   **能廉价证伪它的观测**：在我们自己的实例上导入一张带内嵌书的卡、改一个
   `originalData` 里的字段、再把书导出成卡书，看导出的内容随不随之变——
   若随之变，说明有一条我没找到的读路径。**不在用户的 ST 上做。**
6. 三格全部**没有运行确认**：没有点过保存、没有导入过聊天、没有切过预设。
