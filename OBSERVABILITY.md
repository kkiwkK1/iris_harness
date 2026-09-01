# 失败可观测性

卡片坏掉的时候，谁看得见？

这份文档是「卡作者调试页」项目的宪章。它先量上游，再定位我们的领先点，最后给出功能
清单。**每条领先都对着一个可复核的上游行号**——因为「我们有他们没有」是营销话术，
「这里有一个缺口，行号在此」才是工程主张。

调研日期 2026-09-02。对照的是本机检出：SillyTavern 1.18.0 与 JS-Slash-Runner 4.9.1。

## 口径

- 标 **[源码]** 的来自本机检出，行号可复核。
- 标 **[网络]** 的来自扩展的公开文档，附链接。
- 没有标记的没有。文末「未查」一节列出这份文档**没有**支撑的部分。

---

## 一、先更正我们自己的措辞

**酒馆助手已经有日志查看器，而且不弱。**任何以「ST 用户什么都看不到」开头的主张都是
错的，说出去会被卡作者一句话反驳。

链路是完整的三段 [源码]：

```js
// src/iframe/node_modules/log.js —— 注入进每一个 frame
function override(level) {
  const original = console[level];
  console[level] = (...args) => {
    _th_impl._log(iframe_name, level, ...args);
    original(...args);
  };
}
override('log'); override('debug'); override('info'); override('warn'); override('error');
```

- 宿主侧存储：`src/store/iframe_logs.ts:9-28`，`Map<iframe_id, Log[]>`
- UI：`src/panel/toolbox/Logger.vue:3-68`——分 frame 下拉（或「所有日志」）、文本搜索
  带高亮、四级过滤（详细/信息/警告/错误）、清除、虚拟滚动列表

**所以「卡片脚本的 console 输出对用户可见」是基线，不是我们的领先点。**这是 4.3.0
加入的功能，本机装的是 4.9.1。

我们的领先必须建立在**可指名的缺口**上，见第三节。

---

## 二、对照表：上游的失败面

逐路径实测，不是按目录复述。

| 路径 | 用户可见 | 控制台 | 出处 |
| --- | --- | --- | --- |
| **正则引擎** | **无**（0 toastr、0 throw） | 跳过原因 `console.debug` ×3；未知枚举 `console.warn` ×1 | `public/scripts/extensions/regex/engine.js`，全 465 行，命中仅 `:130 :156 :337 :357 :364 :369 :406` |
| **世界书激活** | **无** | 73 处 `console.debug` | `public/scripts/world-info.js`，6289 行 |
| 世界书**编辑** | 39 个 toast | — | 同上 |
| **渲染判定** | **无** | **无** | `src/util/is_frontend.ts:1-3` |
| **卡片脚本 console** | ✅ Logger 面板 | 同时进真实 console | `log.js` + `Logger.vue` |
| **TavernHelper API 抛错** | ✅ toastr，4.7.3 起点名来源 | 同时进 Logger | `src/function/util.ts:17-72` |

### 两条关键路径是全黑的

**世界书那 39 个 toast 逐条读过原文**（按 METHODS「包含不是调用」，命中要读原文）：

```
Valid World Info file name is required
World Info file has no entries
Valid UID is required
Please select a target lorebook
A number lower than the entry count has been chosen...
```

**全部是编辑期的表单校验，没有一条关于激活。**所以「我的世界书条目为什么没触发」在
上游是**零可见输出**。

**正则引擎同理**：`getRegexedString` 跳过一条脚本时确实会说明理由——

```js
// engine.js:357/:364/:369
console.debug(`getRegexedString: Skipping script ${script.scriptName} because it does not run on edit`);
console.debug(`... because depth ${depth} is less than minDepth ${script.minDepth}`);
console.debug(`... because depth ${depth} is greater than maxDepth ${script.maxDepth}`);
```

——说给 `console.debug`，浏览器默认级别看不到。**理由存在，但没有人会读到。**

---

## 三、上游 Logger 的六个可指名缺口

这才是我们的领先点。每条都可被第三方复核。

### 1. 对象被吃掉

```js
// src/store/iframe_logs.ts:18-23
// TODO: 尽量模拟 console.info 的字符串结果
iframe_logs.value.get(iframe_id)?.push({
  level: level === 'log' ? 'info' : level,
  message: args.map(String).join(''),
  timestamp: Date.now(),
});
```

`String(obj)` 得到 `[object Object]`，而且是 **`join('')` 无分隔符**——多参数会粘成一坨。
源码自带 TODO 承认这件事。

**我们的对策**：拒绝与诊断携带**结构化字段**（主机名、成员名、命令名），不是拼进字符串。

### 2. frame 卸载即销毁日志

```js
// log.js 尾部
$(window).on('pagehide', () => { _th_impl._clearLog(iframe_name); });
// iframe_logs.ts:25-27
const clear = (iframe_id) => { iframe_logs.value.delete(iframe_id); };
```

结合本仓库已经量清的 frame 生死表（见 `RENDER.md`）：

- **取消编辑 → 非流式管线重建 frame → 编辑前的日志全部消失**
- **加载期就失败的卡随后被重建 → 它自己的失败记录自灭**

第二条尤其毒：**卡坏得越早，证据活得越短。**

**我们的对策**：诊断记录的生命周期绑在**卡的身份**上，不是 frame 实例上。
报告要活得比它描述的那个 frame 长。

### 3. 只捕 `console.*`，不捕未处理异常

`log.js` 全文只覆盖五个 console 方法，**没有 `window.onerror`、没有 `unhandledrejection`
监听**。卡自己代码里未捕获的异常与未处理的 Promise 拒绝**进不了那个面板**——除非恰好
穿过 `errorCatched` 包住的 API 调用（`src/function/util.ts:17-72`）。

这正是 METHODS「解析期失败只能从外面看」指的那一处。

**注意区分两类失败**：`unhandledrejection` 只报没被接住的拒绝，抓不到被 `try` 吞掉的。
一个监听覆盖不了两类。

### 4. 诊断默认是关的

> **3.2.6** ⏫功能
> 默认禁用大多数非报错日志, 从而优化高频性能; 可通过开启 "调试模式" 来启用所有日志

与 METHODS「用户看不见的警告等于没有警告」同形。**默认关的诊断等于没有诊断。**

**我们的对策**：做成结构化事件 + 采样/上限，从而可以默认开着。「默认开」本身是一条
产品主张，不是实现细节。

### 5. 无堆栈

`Log` 类型是 `{ level, message, timestamp }`（`iframe_logs.ts:3-7`）。栈在字符串化时丢了。

### 6. 不跨刷新持久化

内存 `Map`，刷新即空。而作者要的恰恰是**能粘贴回去的东西**。

---

## 四、生态模型：用户当仪器

日志查看器为什么会存在，作者写在自己的 changelog 里 [源码]：

> ## 4.3.0
> ### 🔍日志查看器
> - 新增了日志查看器功能, 前端界面、脚本中的所有通过 `console` (`console.info` 等) 所
>   记录下的日志都可以在日志查看器中直接查看, **方便手机玩家向前端界面、脚本作者
>   汇报错误.**

**这一句就是整个生态的调试模型**：作者部署卡片之后失去一切可见性，靠玩家手动把日志
抄出来发回去。手机玩家连开发者工具都没有——日志查看器解决的是「让用户有东西可抄」，
不是「让作者看得见」。

四条佐证：

**(a) 官方对「渲染异常」的排查建议是一个开关对赌。** [网络] 渲染器文档原话：

> 部分浏览器不支持 Blob URL，当渲染异常时请关闭此选项

没有诊断，只有试。

**(b) 调试便利是靠换渲染方式换来的。**`CHANGELOG.md:1342`（3.4.17）：在代码任意处写入
注释 `<!--enable-blob-url-render-->` 就改用 blob URL 渲染，理由是 `srcdoc` 会「在控制台中
重复显示大段代码」。到 3.4.x 才拆成独立设置（`:1278`）。**作者为了能读日志，要改渲染
方式。**

**(c) 文档写的判定规则与源码不符，而且方向危险。**

[网络] 渲染器文档：

> 被扩展识别并渲染需要同时满足以下条件：代码放置在代码块标识中；代码中**同时存在**
> `<body>` 和 `</body>` 标签

[源码] `src/util/is_frontend.ts:1-3`：

```ts
export function isFrontend(content: string): boolean {
  return ['html>', '<head>', '<body'].some(tag => content.includes(tag));
}
```

| | 文档 | 源码 |
| --- | --- | --- |
| 逻辑 | 三条**全部**满足 | 三个子串**任意一个** |
| `<body` | 要求完整 `<body>` 与 `</body>` | 子串 `'<body'`，**没有闭合尖括号** |
| `</body>` | 必需 | **不检查** |
| `html>` | 未提及 | 命中，且 `</html>` 也命中 |
| 代码块 | 必需 | 判据本身不检查，由调用方限定在 `<pre>` 上 |

**代码比文档宽松。**作者按严格规则写卡没问题，但**任何正文里出现 `<body` 的普通消息
都会被变成 iframe**，而用户得不到任何提示——因为判定成功时不说话，判定就是全部逻辑。

「我的消息怎么变成一个空白框了」和「我的界面怎么不渲染」，在上游是同一个哑判据的两面。
**连它自己的文档都写错了自己的判定规则**——这说明「判定成功时说出为什么」不是锦上添花。

**(d) 结构化校验 + 人话报错已经是被认可的方向。**`CHANGELOG.md:698`（4.3.7）：
`registerVariableSchema` 注册 zod 结构后，变量不满足要求时**变量管理器会提示错误信息**。
`:1635` 内置 zod 的理由是让作者对 AI 的坏输出给**中文报错**。

我们不是在推销一个没人要的东西。

---

## 五、功能清单

三层。**每条对着上面一个可指名的缺口**，不是凭空设计。

### 层一 · 基线（不做就比上游差）

1. **分 frame 的日志视图**，含级别过滤、文本搜索、清除 —— 对齐 `Logger.vue`
2. **错误提示点名来源**（哪张卡、哪个脚本/界面）—— 对齐 4.7.3 的 `errorCatched`

### 层二 · 已有仪器的产品化

这些在本仓库里已经作为调试仪器长出来了，散在脚本面板中，需要收敛成产品面。

3. **具名拒绝进面板**：主机名/成员名/命令名作为结构化字段 → 对缺口 1
4. **常驻分代报告**：一张卡「这一代加载做了什么」的常驻视图 → 对缺口 2
5. **判决可撤回且留痕**：`withdrawn` 标记而非删除 → 对应「迟到成功要补发，但那段死寂
   不能从记录里抹掉」
6. **遗言通道**：frame 死前交出未刷出的诊断 → 对缺口 2 与 3 的交集
7. **library cost / 存储探针 / body 摘要** → 从调试仪器升格为「这张卡的开销画像」

### 层三 · 需要新建

8. **捕获未处理异常与 Promise 拒绝** → 缺口 3。**这一条就能抓到上游整类看不见的失败**，
   投入极小
9. **保留堆栈** → 缺口 5
10. **诊断默认开、代价可控** → 缺口 4
11. **跨刷新持久化 + 一键导出诊断包**（卡 id、版本、失败链、环境）→ 缺口 6，且直接对着
    第四节的生态模型
12. **渲染判定的可解释性**：判定成功或失败时说出**命中的是哪条判据** → 对应 (c)。
    上游一行都没有，而它是两个最常见问题的共同答案

## 产品主张

上游的调试模型是**用户当仪器**：作者部署后失明，靠玩家转述。

层三的 8、11、12 三条合起来改变的是这个模型本身——**让卡在用户的机器上自己说清楚它
是怎么坏的，并且让这句话可以被一键交回作者。**

这不是「多一个面板」，是把生态里一条口口相传的链路变成产品功能。

---

## 未查

这份文档的可信度有一半来自这一节。

- **卡作者社区里「我的卡在用户那坏了」的实际讨论串**：中文搜索命中的全部是通用故障
  排查（导入失败、Invalid JSON、编码问题），**没有找到**作者视角的工作流讨论。第四节
  的四条生态证据**全部来自扩展自己的文档与 changelog，不是来自社区讨论**。

  含义：如果结论要靠「卡作者们普遍怎么做」，这份支撑**不够**；如果靠「生态里唯一的
  工具是怎么设计的、为什么这么设计」，支撑是够的。第四节的措辞按后者写。

- **SillyTavern 有没有全局日志级别机制**：数过 console 调用规模（core 里 `console.debug`
  462 处），但**没有查**它自己是否有日志级别开关。如果有，第二节「说给 console.debug，
  没有人会读到」这句需要按那个机制重新表述。

## 参考

- [渲染器 | 酒馆助手](https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/%E5%9F%BA%E6%9C%AC%E7%94%A8%E6%B3%95/%E6%B8%B2%E6%9F%93%E5%99%A8.html)
- [TavernHelper 文档站](https://n0vi028.github.io/JS-Slash-Runner-Doc/)
- [JS-Slash-Runner CHANGELOG](https://github.com/N0VI028/JS-Slash-Runner/blob/main/CHANGELOG.md)
  （文中行号来自本机 4.9.1 检出）
