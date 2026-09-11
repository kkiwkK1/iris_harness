# FEATURE-PROSE-BEAUTIFY —— Iris 原生正文美化

日期 2026-09-11，分支 `dev/feat-prose-beautify`，基线 `origin/main` @ `2d80c7f`。

用户指令：参考 ST 的正文美化插件，做「我们版本的正文美化插件」。这份文档先回答
**参照是什么**（装机证据），再回答机制定位、功能清单、叠加顺序与默认值，最后记
录第一版交付了什么、什么明确列为后续。

## 一、参照考证：装机里没有叫「正文美化」的扩展（只读取证）

对用户 ST 安装（`E:\sillyTavern\SillyTavern`，全程只读）的调查结果：

| 位置 | 内容 | 结论 |
| --- | --- | --- |
| `E:\sillyTavern\SillyTavern\data\default-user\extensions\` | 只有 `JS-Slash-Runner`（酒馆助手 4.9.1，`manifest.json` 的 display_name） | 卡片脚本运行器，不是美化插件；它的卡片面是 Iris 已有的 TH 兼容面 |
| `E:\sillyTavern\SillyTavern\public\scripts\extensions\third-party\` | 只有 `ST-Prompt-Template`（提示词模板 1.17.4.1） | 提示词侧，不碰显示；核心扩展目录（`caption`、`regex`、`translate` 等）全是 ST 自带件，无美化件 |
| `data\default-user\settings.json` → `extension_settings.regex` | `[]`（0 条脚本） | 没有装任何全局美化正则 |
| 同上 → `regex_presets` | `[]` | 没有可借鉴的本地美化正则预设 |
| `settings.json` 全文搜「美化 / beautify」 | 0 处 | 装机里不存在以「正文美化」为名的东西 |

社区的「正文美化」实践也印证这不是一个单一扩展，而是一类做法：靠内置 Regex 扩展
导入美化正则（display regex 包 `<div>` 上样式），或随前端卡附带，或用酒馆助手脚本
渲染。参见 ST 官方文档对 Regex 扩展的说明
（https://docs.sillytavern.app/extensions/regex/ 、中文镜像
https://sillytavern.wiki/extensions/regex/ ）与酒馆助手文档的正则一节
（https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/功能详情/酒馆正则/获取正则.html ）。

**因此本功能按最通用的「消息正文显示增强」定义 scope**：机制层的显示增强，不是给
某张卡做定制样式。卡想做的定制，Iris 已有三层正则（含卡自带 display regex）与
frontend-blocks；这里补的是「卡什么都没带时，阅读面自己也该有的排版」。

## 二、机制定位

回答任务书点名的四个设计问题：

1. **与卡自带 display regex 的叠加顺序**：display regex 是文本改写，发生在消息到
   达阅读面之前（`MessageInterfaces` 拿到的 `text` 已经过三层正则；见
   `apps/iris-web/src/app/body-tag.ts` 对 `splitBodyTag` 入参「already
   display-regex'd」的注释）。正文美化在其后、且**从不改写文本**：它只做两件事——
   在根元素写一个 `data-iris-prose-beautify` 属性驱动 CSS，以及（对话行检测）给
   已渲染段落的 DOM 写 `data-iris-dialogue` 属性。管线上是最后一层：
   card display regex → `repairStrayFences` → `splitBodyTag` → claim/splice →
   markdown 渲染 → **正文美化（纯显示）**。claim 偏移量读的是 `bodyText` 字符串，
   美化不碰任何 claim 读的东西，所以不存在顺序冲突。
2. **与主题/token 的关系**：只用 token。新增两个排版 token（`--iris-prose-indent`
   `--iris-prose-para`）放在 `tokens.css` 第一个裸 `:root` 排版块——排版是
   theme-independent 结构，不进 `THEME_TOKENS`（`theme/presets.ts` 的注释明确该表
   只收调色板）。颜色一律用既有调色板 token；美化 CSS 段内不出现任何 hex（测试钉住）。
3. **开关放在哪（读者面）**：设置抽屉「阅读」卡（`SettingsDrawer.tsx` 的 reading
   `CollapsibleSection`），与楼层号开关并排——这是读书人对自己眼睛做决定的地方。
   状态是一个模块级 store（`prose-beautify.ts`，get/subscribe/set + 根属性即时落
   document），形状与 `iris.theme`/`iris.bodyTag` 相同；持久化在
   `localStorage` 键 `iris.proseBeautify`（`'on'/'off'`），safeRead/safeWrite——
   存储被禁时页面照常工作，只是不记忆。设备本地，不进设置导出文件（见「后续」）。
4. **默认开还是关**：**默认开**。理由：这套规则是 Iris 自己的排版语言（token、
   hairline、缩进与节律），不是外来皮肤——它延续 `--iris-prose-size`/`--iris-prose-leading`
   已经在做的事；ST 侧先例同向（upstream 的 measured profile 主动打开
   `mesIDDisplay_enabled`）。开关存在的意义是「不想要的人一句话关掉」，而不是
   「没人见过的默认」。关掉后美化 CSS 段整体失活（所有规则都门在根属性之下），
   页面回到美化之前逐字节相同的渲染。

## 三、功能清单与边界（v1 核心）

### 交付的规则（全部门在 `[data-iris-prose-beautify='on']` 之下、只作用于 assistant 行的 markdown 正文）

| 规则 | 实现 | 依据 |
| --- | --- | --- |
| 段首缩进 | `.iris-msg__text p`（li 下的段落除外）`text-indent: var(--iris-prose-indent)`（2em） | 中文美化预设最普遍的规则；CJK 正文无缩进读起来像 HTML 而不像书 |
| 段落节律 | 段间距 `margin-block: var(--iris-prose-para)`（0.9em），随读者字号成比例 | primitives 的 `.markdown p` 是固定 16px（`MarkdownText.module.css`），字号调大后节律变紧；em 化即随 `--iris-prose-size` 缩放。走 token 重调，与 `bridge.css` 同一手法，不 fork 渲染器 |
| 对话行 | 纯函数 `isDialogueParagraph` 判定段落是否以直接引语开头（段首引号，或 ≤16 字的说话人引导 + 全/半角冒号 + 引号），命中者 DOM 写 `data-iris-dialogue='on'`：取消缩进、加 1px `--iris-accent-quiet` hairline | 「引号/对话行样式」是美化类的核心诉求；CSS 无法匹配内容，检测只能在做机制层——放在行级（`Message.tsx`）、只写属性不改文本 |
| 排版细节 | `text-wrap: pretty`（避免孤行尾行） | 渐进增强，不支持时静默忽略 |

对话行只在**已落定**（非 streaming）的 assistant 行标注——与 claim 管线自己的
裁决同构（`MessageInterfaces.tsx`：`streaming ? 空表 : claimMessageSurfaces(...)`）；
流式中的每一帧都重走 DOM 标注不是一个 feature。关闭开关时属性一并摘除。

### 明确不做（边界）与后续清单

- **长文折叠**：Iris 已有阅读窗口挂载预算（`notes/apps/iris-web/WINDOWING.md`）、
  楼层内 over-budget 折叠与 bodyleak `<details>` 先例；「按楼层折叠长回复」需要
  自己的行内交互面（展开钮、行高记忆），与窗口化的层间关系要单独裁决——列为后续。
- **引用块 / 分隔线 / 代码块的重排**：渲染器经 `bridge.css` 的 `--dsw-*` 桥已经
  用 Iris token 排过这三样（blockquote 的 2px 左线、hr 的 hairline、代码块底色
  `--iris-code-bg`）；美化再排一遍是第二意见，不是增强。若读者反馈需要，应动桥，
  不应动美化——这是边界而非遗漏。
- **标点挤压 / 中西文自动间距**（`text-autospace`/`text-spacing-trim`）：CSS 规范
  与 Chromium 实现仍在变动，不进 v1。
- **首字下沉**：装饰。「梅花」的裁决是装饰只在两处（`marks.tsx` 头注），阅读列
  不加第三处。
- **随设置文件导出**（`settings-transfer.ts` 的 `reading` 段）：v1 的开关是设备
  本地键（`iris.proseBeautify`），与 `iris.bodyTag`/`iris.language` 同类。要随文件
  旅行需要动 settings-transfer 的 clamp/往返及其测试，列为后续。
- **多说话人对话段**（一段两人对白、无引导冒号）：启发式检测的已知漏报，写进
  测试钉住现状，列为后续。

## 四、实现面（本分支落地的文件）

| 文件 | 内容 |
| --- | --- |
| `apps/iris-web/src/app/prose-beautify.ts` | store（get/subscribe/set + `loadProseBeautify` 纯读）、根属性应用、`isDialogueParagraph` 纯函数、`tag/untagDialogueParagraphs`（只 `setAttribute`/`removeAttribute`，契约面最小到 `querySelectorAll('p')`）。不 import `../sandbox/` 任何东西（测试钉住这条解耦） |
| `apps/iris-web/src/theme/tokens.css` | `--iris-prose-indent: 2em`、`--iris-prose-para: 0.9em` 两个排版 token（theme-independent `:root` 块） |
| `apps/iris-web/src/app/reading.css` | 美化段：全部规则门在根属性下、只选 assistant 行、无 hex（测试钉住） |
| `apps/iris-web/src/app/Message.tsx` | 行级接线：`.iris-msg__text` 的 ref + effect，在 `beautify && !streaming && role==='assistant'` 时标注、否则摘除；deps 带上 swipe index（换读重挂载后属性重打） |
| `apps/iris-web/src/app/SettingsDrawer.tsx` | 阅读卡的「正文美化」开关（`ToggleField`，store 经 `useSyncExternalStore` 订阅，主题 store 同形） |
| `apps/iris-web/src/app/i18n/strings.ts` | `proseBeautify` / `proseBeautifyNote`（en + zh）；`STRINGS.md` 阅读卡行同步 |
| `apps/iris-web/tests/prose-beautify.test.ts` | 纯函数单测（默认值、持久化、容错、对话判定）、最小桩 DOM 的标注/摘除、以及源码级断言（解耦、门控、token 纪律） |

`check:render` 照常跑（模块顶层的 document 访问带 `typeof document !== 'undefined'`
守卫，与 `theme.ts` 同款）。
