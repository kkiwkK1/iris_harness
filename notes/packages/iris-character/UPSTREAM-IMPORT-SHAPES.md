# 上游语义：角色卡导入端点对三种边缘形状的实际行为

**只给事实与位置，不裁。**对象是 `ACTION-PLAN.md` §二 第 5 项与任务 E 遗留的三种形状：
① webp 角色卡；② 只有 SD 生成参数、无 `ccv3`/`chara` chunk 的 PNG；③ JPEG 卡。

## 口径

- **正读**：`E:/sillyTavern/SillyTavern`，`package.json` `"version": "1.18.0"`。
  行号是这个装机上的行号。只读，没有启动 ST，没有点导入，`secrets.json` 未读。
- 样本按字节读：`D:/workspace/小项目/iris_分支/测试用卡/` 下的
  `00004-4209168235_1.png`、`00043-409781020.png`、`liwy.jpg`。**未修改。**
  PNG 走本仓 `packages/iris-character/src/png.ts` 的 `parsePngChunks`
  （用产品自己的读法），JPEG 走一次逐段走查。
- **三条任务描述里的前提，正读之后有三条要改**，逐条列在 §四。

---

## 一、上游导入的两道闸，以及它们各自的失败形态

### 闸一：客户端的扩展名白名单（静默）

```html
<!-- [ST] public/index.html:6348 -->
<input multiple type="file" id="character_import_file"
       accept=".json, image/png, .yaml, .yml, .charx, .byaf" name="avatar">
```

```js
// [ST] public/script.js:10470-10479   importCharacter(file, …)
const ext = file.name.match(/\.(\w+)$/);
if (!ext || !(['json', 'png', 'yaml', 'yml', 'charx', 'byaf'].includes(ext[1].toLowerCase()))) {
    return;
}
```

**六个扩展名。不在名单里就 `return`——没有 toast、没有 console、没有请求发出。**
`accept` 属性只是文件选择器的提示，真正的门是这个 `return`。

### 闸二：服务端的格式分派

```js
// [ST] src/endpoints/characters.js:1558-1596   POST /api/characters/import
const format = request.body.file_type;
const formatImportFunctions = {
    'yaml': importFromYaml, 'yml': importFromYaml, 'json': importFromJson,
    'png': importFromPng, 'charx': importFromCharX, 'byaf': importFromByaf,
};
const importFunction = formatImportFunctions[format];
if (!importFunction) { throw new Error(`Unsupported format: ${format}`); }
…
} catch (err) { console.error(err); response.send({ error: true }); }
```

**六个键，四个真函数**（yaml/yml 共用）。**未知格式抛错，被外层 catch 接住，
返回 `{ error: true }` 且 HTTP 200**——与 `chats.js` 的导入同一个约定
（见 `notes/packages/iris-app-service/UPSTREAM-A-TIER.md` §3.3：拒绝在响应体里，不在状态码里）。

### 用户看到什么：一句不点名的 toast

```js
// [ST] public/script.js:10503-10507, 10529-10532
const data = await result.json();
if (data.error) { throw new Error(`Server returned an error: ${data.error}`); }
…
} catch (error) {
    console.error('Error importing character', error);
    toastr.error(t`The file is likely invalid or corrupted.`, t`Could not import character`);
}
```

**标题 `Could not import character`，正文 `The file is likely invalid or corrupted.`**
——**同一句话覆盖所有失败原因**：没有 card chunk、PNG 损坏、JSON 不合法、格式不支持，
用户侧读不出是哪一种。真正的原因只在服务端 `console.error`。

---

## 二、PNG 的读法：card 数据只认两个 tEXt 关键字

```js
// [ST] src/character-card-parser.js:54-84   read(image)
const chunks = extract(new Uint8Array(image));
const textChunks = chunks.filter(c => c.name === 'tEXt').map(c => PNGtext.decode(c.data));

if (textChunks.length === 0) {
    console.error('PNG metadata does not contain any text chunks.');
    throw new Error('No PNG metadata.');
}
const ccv3Index = textChunks.findIndex(c => c.keyword.toLowerCase() === 'ccv3');
if (ccv3Index > -1) { return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8'); }
const charaIndex = textChunks.findIndex(c => c.keyword.toLowerCase() === 'chara');
if (charaIndex > -1) { return Buffer.from(textChunks[charaIndex].text, 'base64').toString('utf8'); }

console.error('PNG metadata does not contain any character data.');
throw new Error('No PNG metadata.');
```

**四条形状：**

1. **只看 `tEXt`**——`iTXt` / `zTXt` 不参与（`filter(c => c.name === 'tEXt')`）。
2. **关键字比较是 `toLowerCase()` 后的**，`ccv3` **优先于** `chara`。
3. **两个不同的失败走同一个 throw**：「没有任何 tEXt」与「有 tEXt 但没有卡」
   抛的都是 **`No PNG metadata.`**，只有 `console.error` 那一行不同。
   **按抛出的消息区分不了这两种。**
4. `parse(cardUrl, format)`（`:86-96`）的 `switch` **只有 `case 'png'`**，
   其余一律 `throw new Error('Unsupported format')`。

**这个 throw 一路穿到路由**：`readCharacterData`（`characters.js:181-207`）**不 catch**，
`await parse(...)` 直接向上抛；`importFromPng`（`:968-970`）那句
`if (imgData === undefined) throw new Error('Failed to read character data')` **走不到**。
所以 `POST /api/characters/import` 的响应是 `{ error: true }`。

---

## 三、逐形状

### ② 只有 SD 生成参数的 PNG：**上游拒绝**，走的是第二条错误路径

样本按字节读（`parsePngChunks`）：

| 文件 | 大小 | chunk 构成 | 带文本的 chunk | `ccv3` | `chara` |
| --- | --- | --- | --- | --- | --- |
| `00004-4209168235_1.png` | 4 031 365 B | `IHDR×1 tEXt×1 IDAT×62 IEND×1` | **1**，keyword `parameters`，1 436 B | 无 | 无 |
| `00043-409781020.png` | 4 157 448 B | `IHDR×1 tEXt×1 IDAT×64 IEND×1` | **1**，keyword `parameters`，2 027 B | 无 | 无 |

`parameters` 的内容是 Stable Diffusion 的生成参数原文（开头是
`<lora:…>` 与逗号分隔的 tag 串）。

**所以在 `read()` 里走的是**：`textChunks.length === 0` **为假**（有 1 个），
落到末尾 → `console.error('PNG metadata does not contain any character data.')`
→ `throw new Error('No PNG metadata.')` → 路由 catch → `{ error: true }` + HTTP 200
→ 客户端 toast `Could not import character` / `The file is likely invalid or corrupted.`。

> **上游不会把它收成空白角色。**它进不了 `writeCharacterData`，
> `characters/` 下不会出现文件，角色列表不变。

### ③ `liwy.jpg`：**在客户端就被静默丢弃**，而且它里面没有卡数据

**上游行为**：扩展名 `jpg` 不在闸一那六个里 → `importCharacter` 直接 `return`
（`script.js:10476-10479`）。**没有 toast、没有请求。**即便绕过客户端直接 POST
`file_type=jpg`，服务端也在闸二 `Unsupported format: jpg` 抛错 → `{ error: true }`。
`parse()` 的 `switch` 同样只认 png。

**样本形状（逐段走查，98 321 B）**：

| 段 | 偏移 | 长度 | 内容 |
| --- | --- | --- | --- |
| `APP0` | 2 | 16 | `JFIF` |
| `DQT` (0xdb) | 20 | 132 | 量化表 |
| `SOF2` (0xc2) | 154 | 17 | 渐进式帧头 |
| `DHT` (0xc4) | 173 | 28 | 霍夫曼表 |
| `SOS` (0xda) | 203 | — | 扫描数据到文件尾 |

**没有 `COM` 段，没有 `APP1`，APP0 之外没有任何 APPn。**
最后一个 `EOI`（`FF D9`）在偏移 98 319，**EOI 之后 0 字节**，没有附加数据。
全文件按 latin1 搜：`chara` / `Chara` / `CHARA` / `ccv3` / `chara_card` / `spec` /
`first_mes` / `{"name"` / `eyJ`（base64 的 `{"`）**全部不命中**，
且没有任何长度 ≥200 的 base64 连续串。

> **这个文件不是「数据藏在 COM/APP 段里的 JPEG 卡」，它是一张不带卡数据的普通 JPEG。**
> 所以「对齐上游对 JPEG 卡的读法」这个问题在这个样本上不成立——没有东西可读。
> *（这不排除「JPEG 卡」这种东西存在于别处；只是这个样本不是。）*

### ① webp：**上游的角色导入路径不支持它**，也没有写回路径

- **不在闸一的六个扩展名里** → 客户端静默 `return`；`accept` 属性也不含它。
- **不在闸二的六个键里** → 直接 POST 也是 `Unsupported format: webp`。
- **`parse()` 的 `switch` 只有 `case 'png'`**（`character-card-parser.js:86-96`）。
- **写回路径只写 PNG。**`write(image, data)`（`:15-45`，`write` 从 `:15` 起）用 `png-chunks-extract`
  拆块、`png-chunk-text` 编 `chara`（base64），再尝试追加一个 `ccv3`
  （把 `spec` 改成 `chara_card_v3` / `spec_version` `'3.0'`，失败则忽略），
  最后 `encode(chunks)`。**注释明说 `'ccv3' is not supported and removed
  not to create a mismatch`——写的时候先删掉已有的 `chara`/`ccv3` 两种 tEXt。**
- **落盘一律 `.png`**：`writeCharacterData`（`characters.js:220-265`）
  `path.join(directories.characters, `${outputFile}.png`)`。

**一处容易读反的对照**：上游对**图片本身**是宽容的，对**卡数据**不是。
`writeCharacterData` 的 `getInputImage()` 走
`tryReadImage`（`:325-334`）/ `parseImageBuffer`（`:314-317`）→ Jimp，
而 `applyAvatarCropResize` 的收尾是 **`return await image.getBuffer(JimpMime.png)`**
（`:305`）——**任何 Jimp 能打开的格式都会被规范化成 PNG**，读不出来时
`console.warn` 后退到 `DEFAULT_AVATAR_PATH`（`:246-250`）。
Jimp 的格式表里**有 webp**（`src/jimp.js:4`、`:49`）。

> 所以：**webp 可以当"图"进来（作为头像被转成 PNG），不能当"卡"进来。**
> `MEDIA_EXTENSIONS`（`src/constants.js:523-535`）里那个 `webp` 是**媒体上传**的白名单，
> 不是角色导入的。

**还有一条来自 UI 的旁证**：角色保存路径的 catch 里，上游给用户的文案是
**「…Double check that the image is not a webp.」**（`public/script.js:9864`）——
上游自己把 webp 当作已知的失败原因写进了提示。

---

## 四、三条前提的更正

| 任务描述里的说法 | 正读结果 |
| --- | --- |
| 「ST 支持 webp 卡」 | **角色导入路径不支持**：两道闸都没有 webp，`parse()` 只认 png，`write()` 只产 PNG。webp 只能作为**图片**经 Jimp 转成 PNG 当头像；UI 文案还专门点名 webp 是失败原因（`script.js:9864`） |
| 「`00004`/`00043`：ST 收作空白角色」 | **ST 拒绝**。`read()` 走到末尾抛 `No PNG metadata.`，路由返回 `{ error: true }`（HTTP 200），toast 是不点名的 `The file is likely invalid or corrupted.`，`characters/` 下不落文件 |
| 「`liwy.jpg`：JPEG 卡（COM/APP 段藏数据）」 | **样本里没有卡数据**：5 个段（APP0/DQT/SOF2/DHT/SOS），无 COM、无 APP1，EOI 后 0 字节，全文件搜不到任何 card 关键字或长 base64 串。它在客户端闸一就被**静默丢弃**，连请求都不发 |

**本仓当前的实现已经不按第二条走了**，而且它记的上游事实是对的：
`packages/iris-app-service/src/library.ts:490-502` 的注释写着
「Upstream's *import endpoint* refuses both shapes (`No PNG metadata.` / the
client's extension gate drops `.jpg` before a request is even made), so this is a
recorded divergence」，`DEVIATIONS.md` §18 承接。
**本文件补的是那段注释断言而没有给出的行号，以及 webp 那一格。**

## 五、未查 / 限定

1. **`importFromCharX` / `importFromByaf` / `importFromJson` / `importFromYaml`
   没有逐行读**——本文件只走了 png 分支与两道闸。
2. **`importFromURL` / 拖放外部链接那条路没有读**（`public/script.js:10535` 起），
   它是否走同一个扩展名白名单未确认。
3. **没有运行确认**：没有真的导入过这三种文件，以上是源码 + 字节两侧的静态读。
   **能廉价证伪的观测**：在我们自己的实例上把三个文件喂给 ST 的导入按钮，
   看 toast 与 `characters/` 的变化——**不在用户的 ST 上做。**
4. **样本只有三个**，其中 webp 一个都没有（语料里那个 `00043-409781020.webp`
   已删，`ACTION-PLAN.md` §二 第 5 项与 `QA-REPORT.md` 的口径说明都记了这件事）。
   **所以 webp 那一格是纯源码结论，没有样本佐证。**
