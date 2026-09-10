# 卡能够到的四个面：现状、口径、以及两个此前没人扫过的语料群

**这份文件不是逐成员账本。** 逐成员的账在两处，它们是权威：

- `notes/apps/iris-web/TH-SURFACE-AUDIT.md` —— 酒馆助手 `@types` 声明的 171 个成员，
  逐个带上游声明位置与 Iris 现状（量具 `scripts/th-surface-audit.mjs`，分支
  `dev/audit-th-surface`）；
- `notes/apps/iris-web/ST-CONTEXT-SURFACE-AUDIT.md` —— `getContext()` 的 145 键、
  宿主页面全局、裸库全局，逐个带缺口分级 P0/P1/P2（量具
  `scripts/st-context-audit.mjs`，分支 `dev/audit-st-context-surface`）。

这份文件只管**可重跑的度量**：`scripts/card-surface-census.mjs`
（`npm run census:card-surface`）每次跑出的四面表，两列（脚本 / 界面文本），
单位是**来源**（卡 / 预设 / 世界书）而不是调用次数。

日期 2026-09-10。Iris `549d919` + 本分支 `dev/card-surface-census`。
**[ST]** 1.18.0、**[TH]** 4.9.1，取自操作机安装 `E:\sillyTavern\SillyTavern`（只读）。

---

## 一、三层表面现状（本次运行）

语料：ST 安装的 15 张可解码卡（含脚本体与卡自带正则源文本）+ 73 份渲染界面
+ 3 份预设正则 + 18 本磁盘世界书，按内容哈希去重后 1694 段代码（脚本 39 / 界面 1655），
丢弃 169 段重复体。Iris 自己的 data 目录在 worktree 里不存在（`.gitignore`），
所以本次运行**不含**该群 —— 与两份审计的差异有一部分出自这里，见 §三。

| 面 | 声明 | Iris 建 | 语料用到 | 用到但没建 |
| --- | ---: | ---: | ---: | ---: |
| ① 酒馆助手 `@types` | 171 | 54（32%） | 32 | **5** |
| ② `SillyTavern.getContext()` | 145 | 25（17%） | 16 | **3** |
| ③ `window.parent.X` 宿主全局 | 桥接 22 ∪ 语料读到 = 34 | 22 | 27 | **12** |
| ④ 裸全局（upstream 每帧种的库） | 10 | 10 | 5 | **0** |

「用到但没建」逐项，**两列**（脚本来源数 / 界面来源数）：

| 面 | 成员 | 脚本 | 界面 | 调用 | 备注 |
| --- | --- | ---: | ---: | ---: | --- |
| ① | `Mvu` | 5 | 7 | 122 | 泛名；TH 审计 §4.1.4 判「部分」（运行期发布） |
| ① | `SillyTavern` | 3 | 6 | 97 | 泛名；TH 审计 §4.1.5 判「部分」 |
| ① | `getPreset` | 1 | 0 | 2 | TH 审计已记 |
| ① | `stopAllGeneration` | 0 | 1 | 2 | **本次新增**，见 §二 |
| ① | `registerMacroLike` | 1 | 0 | 1 | TH 审计已记 |
| ② | `addOneMessage` | 2 | 0 | 14 | ST 审计 §4.1.2 |
| ② | `printMessages` | 1 | 0 | 12 | ST 审计 §4.1.3 |
| ② | `reloadCurrentChat` | 0 | 1 | 1 | ST 审计 §4.1.1（无守卫硬抛） |
| ③ | `toastr` | 2 | 0 | 105 | ST 审计 §4.2.2 |
| ③ | `alert` / `confirm` / `prompt` | 1 | 0 | 10 / 1 / 6 | ST 审计 §4.2.1，**P0** |
| ③ | `Mvu` | 2 | 2 | 44 | 运行期发布名 |
| ③ | `triggerSlash` | 0 | 1 | 2 | **只在预设正则里**，见 §二 |
| ③ | `AutoCardUpdaterAPI`、`rpg_status_bar_*`、`phoneForumManager`、`messageSender` | — | — | — | 卡自己往宿主窗发布的名字（ST 审计的 `__kaidanMvuSchema` 同类，卡内可见、跨卡不可见） |

「建了但这份语料没用到」：① 27 个、② 12 个、③ 7 个（六个调度器 + `dispatchEvent`）、④ 5 个
（`jQuery`、`showdown`、`EjsTemplate`、`Vue`、`VueRouter` —— 都是**有面无用量**，
量具没有「零使用即拆除」的建议权）。

---

## 二、这一次的两个新语料群带来了什么

`scripts/card-surface-census.mjs` 扫两个此前没有任何普查读过的群：

1. **预设正则** —— `OpenAI Settings/*.json` 的 `extensions.regex_scripts[].replaceString`；
2. **磁盘世界书条目** —— `worlds/*.json` 的 `entries[].content`。

**只有这两群才够到的名字**（其他任何普查都看不见）：

| 面 | 成员 | 建了 | 来源 |
| --- | --- | --- | --- |
| ③ | `postMessage` | 是 | 预设正则（DEVIATIONS web §76 的那条上报路径，语料里只有预设在用） |
| ③ | `triggerSlash` | **否** | 预设正则（`parent.triggerSlash`，宿主拼写） |
| ④ | `YAML` | 是 | 世界书条目 |

三个名字，其中一个是缺口。另外世界书条目还贡献了 `chatMetadata`/`saveMetadata`/`document`/
`getChatMessages`/`getCurrentMessageId`/`SillyTavern` 的额外来源计数（这些名字卡也在用，
所以不在上表里），量级见量具输出的「来源种类」列。

### `stopAllGeneration`：两份审计各看见半个调用点

魔法少女的扣扣审判 的界面正则 `regex[8]` 写的是

```js
if (typeof stopAllGeneration === 'function') {
    await stopAllGeneration();
} else if (typeof top.stopAllGeneration === 'function') {
    await top.stopAllGeneration();
}
```

- ST 审计看见了后半句（它扫卡自带正则源文本），并**正确地**裁定不补：
  `top.stopAllGeneration` 在上游页面同样是 `undefined`（`script.js` 以 module 载入，
  导出不落 window），补上等于激活上游的死分支（§4.2.3）。
- TH 审计没看见前半句：它对 ST 安装库沿用旧 census 的口径（脚本体 + **渲染过的**界面），
  而这段正则在本机聊天里从未渲染，于是 `stopAllGeneration` 记作「未提供 · 0 命中」（该表第 255 行）。

两半合起来结论变了：**裸拼写 `stopAllGeneration` 在上游卡帧里是有的**
（TH 的 `predefine.js` 把整个成员面作为裸全局注进每个脚本帧），所以第一条守卫在上游成立、
在 Iris 失败。这不是「上游也没有」，是 ①层的真缺口 —— 一个静默降级：卡想停生成，停不了，
没有报错。分级与是否补，按 TH 审计既有的路子办（它已把 `stopAllGeneration` 与
`stopGenerationById` 一起放在 §五 的 P2 观望里，理由是宿主停止臂没建）；
这里只把「语料里有人调用且上游有」这个事实补上。

---

## 三、与两份审计的数字差在哪（口径，不是分歧）

| 项 | 本次 | 审计 | 差因 |
| --- | --- | --- | --- |
| ① 语料用到 | 32 | 33 | 审计含 Iris data 目录 + 测试用卡两群，本 worktree 没有；本次含预设/世界书两群，审计没有 |
| ① 真缺 | `getPreset`、`registerMacroLike`、`stopAllGeneration` | `getPreset`、`registerMacroLike`、`getCharData` | `getCharData` 在人贩子物语（Iris data 目录，本次不在语料里）；`stopAllGeneration` 见 §二 |
| ② 语料用到 | 16 | 17 | 差 `getCurrentChatId`（1 卡，同上，Iris data 目录） |
| ② 真缺 | 3 | 3 | **完全一致**（`addOneMessage`、`printMessages`、`reloadCurrentChat`） |
| ③ 桥接名 | 22 | 22 | 一致 |
| ③ 语料读到 | 27（记为「用到」的） | 50 真名 | 审计把「出现在某条已认路由后」的名字全列出并逐个裁定；本量具只列**声明面 ∪ 桥接面**上的名字加上语料发现的，且丢掉了 41 段自己声明 `parent`/`top` 的体内的裸拼写 |
| ③ 调度器 / `dispatchEvent` | 0 来源 | 各 1 卡 | 同 Iris data / 测试用卡两群 |
| ④ 真缺 | 0 | 0 | 一致（`Split`/`moment`/`d3` 三笔旧账被审计 §4.3 证伪，本量具同样 0） |

**没有分歧，只有群体差。** 唯一实质性的新结论是 §二 的 `stopAllGeneration`，
它来自「两份审计的语料群各缺一半」而不是来自任何一方判断错误。

---

## 四、量具的口径与已知盲区

全部写在 `scripts/card-surface-census.mjs` 的模块头里，这里只列会改变读数的几条：

- **单位是来源**，按内容哈希去重；一段脚本粘进九张卡算一票。
- **两列**：脚本体 vs 界面文本（卡自带正则源文本 + 渲染界面 + 预设正则 + 世界书条目）。
- **③层的裸 `parent.` / `top.` 排除规则**：不是属性访问（`node.parent.replaceChild` 出局）、
  体内没有自己声明的 `parent`/`top`（41 段被此规则剔掉裸拼写）。别名解析只认
  `var x = window.parent` 这种**结束在 parent 表达式上**的声明（`_pd = window.parent.document`
  是文档的别名，不算），单字符别名一律拒绝（minify 过的界面包里一个 `const e = top`
  会把 53 处 `e.replace()` 变成宿主成员）。
- **①④层的裸名**：源自身以 `function` / 箭头 / 对象方法形式定义的同名函数不计
  （创世回廊自己的 `const deletePreset = (id) => {…}` 曾与真缺口并列在同一张表里）。
  **不含**方法简写形状，因为 `updateWorldbookWith(book, cb => {…})` 会被它误判成定义。
- **盲区**：解构 `const { chat } = getContext()`（本语料 0 命中）；
  经函数返回的宿主窗（`getParent()` 一类，量具按别名的多次绑定计但不追函数体）；
  字符串拼名（`TavernHelper['x']`，TH 审计另计）。

## 五、复现

```
npm run census:card-surface              # 四面表 + 两个新群的专属清单
node scripts/card-surface-census.mjs --verbose   # 每个名字逐来源
```

需要 `E:\sillyTavern\SillyTavern` 在位（`IRIS_CORPUS` 可改）；Iris 自己的 data 目录用
`IRIS_DATA_DIR` 指（worktree 里默认不存在）。量具恒 exit 0，是卡尺不是测试；
任何一处提取短于下限就停止出数。
