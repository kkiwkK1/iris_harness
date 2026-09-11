# FEATURE-PROMPT-TEMPLATE — Iris 原生提示词模板

> 状态:v1 核心已落地(本文档与实现同一分支)。上游快照:ST-Prompt-Template
> **v1.17.4.1**(zonde306),读自本机安装
> `E:\sillyTavern\SillyTavern\public\scripts\extensions\third-party\ST-Prompt-Template\`
> (该扩展 `auto_update: true`,本文件对上游行为的描述有保质期,复核方法见
> `notes/packages/iris-compat-prompt-template/DEVIATIONS.md` 开头)。

## 一、这是什么

「提示词模板」= 在卡字段、世界书条目、预设提示词、聊天楼层里写 EJS(`<% %>`),
宿主在装配提示词时执行并把结果替换进去,模板内可以读变量、写变量、读世界书。
ST 生态里这是第三方扩展(ST-Prompt-Template)提供的能力;Iris 把它作为**第一方
能力**提供:机制层服务所有卡(不按卡分支),开关是 Iris 自己的设置面,执行内核
与兼容层共用一份 EJS。

## 二、上游功能面盘点(调查结论)

上游 7300 余行源码,功能面可以归为五类:

1. **执行时机**(`src/modules/handler.ts`,12 个事件挂钩):
   - `CHAT_CHANGED` → 预载世界书(preparation 阶段,含角色定义)
   - `WORLDINFO_ENTRIES_LOADED` → 世界书条目装饰器过滤/预处理/强激活
   - `GENERATION_AFTER_COMMANDS` → `[GENERATE:BEFORE]` 收集 + 给聊天装一条
     过滤 `<% %>` 的正则
   - `GENERATE_AFTER_DATA`(文本补全)/ `CHAT_COMPLETION_SETTINGS_READY`(chat
     completion)→ **对装配后的消息数组逐条执行 EJS**——这是上游的主执行点
   - 消息渲染事件 → 楼层 HTML 内执行(渲染路径,`<%=` 走 `messageFormatting`)
   - `js_generation_before_end`(JS-Slash-Runner 兼容点)→ 模型输出中的模板
2. **变量面**(`src/function/variables.ts`,892 行):四作用域
   global(扩展设置)/ local(chat metadata)/ message(每楼每 swipe)/
   initial(WI 条目声明),合并顺序 message > initial > local > global;
   get/set/inc/dec/del/ins 全家族,带 `flags`(nx/xx/n/nxs/xxs)、`results`、
   `withMsg`、`merge`、`dryRun`;`findVariables` 回溯历史楼层。
3. **模板环境**(`src/function/ejs.ts` `prepareContext`,约 90 个名字):
   lodash/jQuery/zod/toastr/faker、变量全家族、`getwi`/`getchar`/`getpreset`/
   `getqr`/`define`/`execute`(斜杠命令)/`injectPrompt`/`jsonPatch`/
   `matchChatMessages`、标量面(userName/charName/chatId/lastUserMessage/…)、
   `SillyTavern.getContext()`,外加 `prompt_template_prepare` 事件钩子。
4. **扩展语法**(EJS 之外):
   - 世界书标题前缀:`[GENERATE:BEFORE/AFTER]`、`[RENDER:BEFORE/AFTER]`、
     `[GENERATE:{idx}:BEFORE/AFTER]`、`[GENERATE:REGEX:pattern]`、
     `[InitialVariables]`
   - 条目装饰器(`@@generate_before` 等,`src/function/worldinfo.ts` 889 行):
     条件过滤、预处理条目、私有条目、`@@always_enabled`、`@@only_preload`、
     `@@dont_preload`、`@@message_formatting`、`@@iframe`
   - `@INJECT pos=/target=/regex=` 提示词注入(`src/features/inject-prompt.ts`)
   - 斜杠命令 `/ejs`、`/ejs-refresh`(`src/modules/command.ts`)
5. **设置面**(`src/modules/ui.ts`,21 项):总开关、生成/渲染/加载器分开关、
   with 上下文、调试、自动保存、预载、代码块、原文本求值、聊天过滤、缓存
   (0/1/2 + 容量 + 哈希器)、注入加载器、深度上限、compile workers、沙箱、
   代码编辑器。存 `extension_settings.EjsTemplate`。

导出面:`globalThis.EjsTemplate` 14 个成员(`evalTemplate`、`prepareContext`、
`getSyntaxErrorInfo`、`setFeatures`、`allVariables`、`saveVariables`、
`resetFeatures`、`defines`、`refreshWorldInfo`、`initialVariables`、`parseJSON`、
`jsonPatch`、`getFeatures`、`compileTemplate`)。

## 三、Iris 已有资产与对照

| 上游能力 | Iris 现状 | 所在 |
| --- | --- | --- |
| 生成期对装配后数组逐条执行 EJS | **已有**,同一位置(装配后、provider 前) | `packages/iris-app-service/src/templates.ts`(`evaluatePrompt`)、`service.ts` `#applyTemplates` |
| EJS 引擎本身 | **已有**,vendored EJS + 补丁,子进程 vm 沙箱 | `packages/iris-compat-prompt-template`(`evaluateBatch`/`hasTemplate`/`upstream.ts`) |
| 四作用域变量 + get/set 家族 + `getwi` | **已有**(语料触及的 6+ 名逐字实现,其余按名拒绝) | 同上 `environment.ts`、快照契约 `notes/.../SNAPSHOT.md` |
| 变量写回宿主存储 | **已有**,描述式写经宿主守卫重放 | `packages/iris-app-service/src/template.ts`(`applyOps`) |
| 卡脚本 `evalTemplate` | **已有** RPC,卡面 `EjsTemplate.evalTemplate` | `script.evalTemplate`(`iris-protocol`),`apps/iris-web/src/sandbox/card-api.ts` |
| 宏先展开再执行(ST 宏 + TH 变量宏) | **已有** | `@iris/macro`、`@iris/compat-tavernhelper/macros` |
| 开关 | 只有组合行/env(`IRIS_TEMPLATES=1`),**无用户可达的设置面** | `cordis.yml` app 行、`Config.templates` |
| 功能文档(Iris 自己的) | 无(只有兼容层 DEVIATIONS) | 本文件补上 |
| 渲染路径 / 接收路径 / 世界书方言 / @INJECT / 斜杠命令 | 无 | 见「五、边界」 |

结论:**执行内核与生成期管线钩子已经在位**,缺的是把它作为第一方能力交出去的
那部分——用户可达的开关、对能力边界的书面定义、以及证明两条门(管线、卡 API)
走的是同一内核的测试。v1 核心就是这一部分;方言类能力按规模列为后续。

## 四、v1 核心实现(本分支落地)

### 4.1 开关:从部署旗子到原生设置

- 持久化位置:profile 的 `settings.json`,新节 `template: { enabled?: boolean }`
  (三态:未设 = 跟随开机默认)。`SettingsStore` 与 `worldbooks` 节同一待遇:
  `load()` 原样带过,读写走内存副本。
- 生效规则:**一旦落过盘,用户的决定赢;没落过盘,组合行赢**。
  `enabled = 持久值 ?? (Config.templates === true)`。
  组合行(`IRIS_TEMPLATES=1`)从「唯一的开关」降为「开机默认 + 求值时限
  (`templateDeadlineMs`)的携带者」——这正是上游的模型:装上扩展(能力在场,
  Iris 里内核在宿主内)+ 用户开/关设置。安全默认没有变:出厂仍是关。
- 线上面:新 RPC 对,`worldbook.settings`/`worldbook.setSettings` 的先例
  (装机级、语义与采样补丁不同类,所以独立成对而不是塞进 `settings.set`):
  - `template.settings` → `{ settings: { enabled, persisted, defaultEnabled } }`
  - `template.setSettings { enabled: boolean | null }` → 同视图;`null` = 清除
    持久值、回到组合默认
- 消费点(都是调用时读,不是开机读,改完即刻生效):
  - `#applyTemplates`(提示词管线钩子,机制级,服务所有卡)
  - `script.evalTemplate`(卡脚本 API)
- 关闭状态的成本为零:不建快照、不 fork 子进程(既有短路在门后第一行)。

### 4.2 暴露面(v1 全集)

1. **提示词管线钩子**:生成期对装配后的 system + messages 逐槽执行,只挑含
   `<%` 的槽做 item;单项失败保留原文并报诊断;写入经 `applyOps` 宿主守卫落盘。
   (既有路径,本文档将其收编为原生能力的定义。)
2. **卡脚本 API**:`EjsTemplate.evalTemplate(content)`(线面上 `script.evalTemplate`,
   strict 单参)。同一开关、同一内核、同一快照契约。
3. **设置项**:上述 RPC 对。前端面板开关 = 后续项(见 §六)。

### 4.3 与兼容层的关系

- **执行内核 100% 复用** `@iris/compat-prompt-template`:`evaluateBatch`、
  `hasTemplate`、Snapshot/Op 协议、realm 沙箱、vendored EJS 全部只有一份。
  本功能没有引入第二份 EJS,也没有第二条求值路径。
- 分工:「兼容层」这个词在 Iris 里有双重身份,本文件把它拆开说清楚——
  - `@iris/compat-prompt-template` 是**内核**:Iris 自己写的沙箱执行器,不是
    扩展代码的移植;它对上游行为逐项对齐的纪律记录在它的 DEVIATIONS.md。
  - 「原生能力」是 **app-service 的接线与承诺级别**:文档(本文件)、设置面
    (一等公民)、机制级服务所有卡。两边不是两套引擎,是引擎与产品面。
- 命名遗痕:组合行与 env 变量名(`IRIS_TEMPLATES`)保留原名,避免部署脚本
  无声失效;语义变化写进 `cordis.yml` 行注释与 README。

## 五、能力边界

### 照搬上游(已经在位或 v1 保持)

- 执行位置:装配后的完整消息数组,provider 前(上游
  `GENERATE_AFTER_DATA` / `CHAT_COMPLETION_SETTINGS_READY` 的位置)。
- EJS 方言:`<% %>`/`<%=`/`<%-`/`print`/`with` 上下文/async-await;空转短路
  (`hasTemplate`,上游 `evalTemplate` 自己的同一条规则)。
- 失败语义:单项失败保留原文、报错、生成继续;写入照常应用(上游行为,
  `templates.ts` 模块注记)。
- 变量面与作用域合并顺序;`getwi` 单书解析链;宏先展开再执行。
- 卡脚本门:关着时**按名拒绝**,不回答空串(空串会让卡把「没渲染」当
  「渲染成空」注回去)。

### 按 Iris 架构重定义

- **开关**(§4.1):上游 21 项复选框 → Iris 一个布尔 + 求值时限。上游的
  缓存三档、compile workers、FunctionSandbox、代码编辑器等设置项对应的
  机制在 Iris 架构里不存在或不适用(一次一批一子进程),不设无意义的旋钮。
- **执行时机**:上游 12 个事件点 → Iris v1 定义两个入口(生成期 + 卡脚本
  按需)。每个被砍掉的事件点见下方「明确不做」,不是没想,是不做并写明。
- **报告面**:上游 toastr 弹窗 → Iris 诊断报告总线(`#report`,
  `debug.reports` 可读),失败有名有出处(`generate/<chatId>/<slot>`)。
- **导出面**:上游 `globalThis.EjsTemplate` 14 成员 → Iris 卡面只暴露
  `evalTemplate`。其余成员要求的能力(`refreshWorldInfo`、`allVariables`、
  `setFeatures`…)在 Iris 是宿主自己的职责,不交给卡。

### 明确不做(v1),与理由

| 上游能力 | 不做的理由 | 后续路径 |
| --- | --- | --- |
| 渲染路径(楼层 HTML 内执行、`<%=` 与 `<%-` 的渲染差异、`@@iframe`、`@@message_formatting`) | Iris 楼层渲染在浏览器侧,模板求值在宿主子进程;要在前端求值就得把内核(或一条 RPC 往返)搬进渲染管线,牵动 iframe 沙箱与 CSP,是独立的大块 | 渲染期求值可作为「宿主预渲染」做:提交候选前对**展示文本**跑一遍内核,不动 DOM 管线 |
| 接收路径(模型输出中的模板、`raw_message_evaluation`、JS-Slash-Runner 兼容点) | 触到回合提交路径,与 MVU 变量抽取、正则、指纹、缓存痕迹全部正交性都要重新论证;语料里「输出含 EJS」暂无实测需求 | 与渲染期预渲染同一机制,一次解决 |
| 世界书激活方言(`[GENERATE:*]`、`[RENDER:*]`、`@@` 装饰器、条件过滤/预处理/强激活条目、`[InitialVariables]` 条目) | 上游 889 行 worldinfo 逻辑长在 ST 的事件时序上;Iris 的世界书扫描/预算/插入策略是另一套已验证的机制,叠一层方言要做两套语义的等价性证明 | 按需逐个收编;`[InitialVariables]` 条目最先(它只是数据,不是行为) |
| `@INJECT` 提示词注入 | Iris 已有原生等价物:卡脚本 `injectPrompts`/`setExtensionPrompt`(`ScriptInjection`,装配期注入) | 无;方言化标题解析仅在导入卡依赖它时考虑 |
| `/ejs`、`/ejs-refresh` 斜杠命令 | Iris 没有用户斜杠命令控制台;卡脚本侧已有 `evalTemplate` 覆盖同一需求 | 若未来做命令面再议 |
| 模板环境其余 ~80 名(`execute`、`$`、`toastr`、`faker`、`zod`、`define`、`getchr`、`getprp`、`getqr`、`matchChatMessages`、`YAML`…) | 兼容层按名拒绝的既有纪律(`UnsupportedTemplateApiError`);语料 0 站点,拒绝有名字、有测量 | 有语料需求时逐名进内核,不是本功能的活 |

## 六、后续项(明确不在 v1)

1. **前端设置开关**:设置面板一节,调 `template.settings`/`template.setSettings`
   (线面已就绪,纯 UI 工作)。
2. **渲染期预渲染**(接收路径一并解决):见上表第一、二行。
3. **`[InitialVariables]` 世界书条目 → 卡的初始变量**:数据类方言,风险最低。
4. **模板编辑器 / 语法检查**(`getSyntaxErrorInfo` 的 UI 化)。
5. 世界书方言的逐项收编(需要时按「五」表的顺序与理由推进)。

## 七、测试与验证(本分支)

- `packages/iris-app-service/tests/template-feature.test.ts`:四象限开关矩阵
  (组合开/关 × 持久开/关)、清除持久值回到组合默认、视图字段、关闭时零成本
  (provider 收到原文)、按名拒绝、失败保留原文、写入落宿主存储。
- **互操作证明**:`script.evalTemplate` 写入的变量被同一次生成期的模板读到
  (两条门、一个内核、一份宿主存储),复用真子进程求值,不做内核替身。
- 既有 `templates.test.ts`、`eval-template.test.ts` 全绿:兼容路径行为不变
  (组合行为开机默认后,「组合关 = 拒绝」与「组合开 = 执行」的原断言保持
  成立)。
- 根 + app 双 `tsc` 零错误;`apps/iris-web` 构建与 `check:render` 通过
  (协议新增方法对 web 是纯增量)。
