# 功能差距与排期

对照本机 SillyTavern 1.18.0 的**实际装置**盘点，不是凭记忆或文档：`E:/sillyTavern/SillyTavern`。

ST 的功能面规模：14 个内置扩展、43 组 API 端点、约 290 个斜杠命令、7 类互相独立的预设、20 余种每用户数据目录。Iris 当前 ~1400 个测试。

排期不按 ST 的目录顺序，按**什么在挡路**。

> **2026-09-02 重定位**（用户裁定）：Iris 是 ST 的**升级版**，不是替代品——兼容是地板，
> 不是天花板。偏离分两本账：兼容面缺口（修或记档）与**刻意升级**（记档为特性：写明好在
> 哪、代价什么、上游为什么没做）。"已经比 ST 好、要守住的"一节从守势转为产品主张。

## 当前状态（2026-09-02 深夜，本节替代文末旧"建议顺序"与本节自身的上一版）

**已完成**（每项都在真卡/真语料上验收过）：Tier 0 全部——卡片脚本沙箱（共居 realm、
虚拟 parent、按卡授权、自动运行，实际位置 `apps/iris-web/src/sandbox/`）✅；正则脚本
（引擎 + 提示词/显示两向接线）✅；EJS 模板（子进程围栏、差分 195/196）✅。Tier 1——
分支 ✅、连接档 ✅、计费视图 ✅。**消息内渲染管线** ✅（RENDER.md 五步全落，验收卡
战锤群星闪耀端到端；189 个渲染后接口楼是它的真实负载）。MVU 全链 ✅（宏、JSONPatch
方言、折叠、真模型验收）。**楼层变量通路** ✅（FLOOR-VARIABLES.md：快照携带 + 门面派生
data/swipes_data + messageId 全线统一为消息下标 + 用户行快照投影）。**卡对聊天的写** ✅
（CHAT-WRITES.md：Proxy 账本 + 按序重放 + 批末一次存；append/批删宿主 arm）。世界书
三来源 ✅（择一 + globalSelect + InitVar 反序；characters 携带当前角色内嵌书）。
TavernHelper 面出口克隆 ✅（两面相反规则钉成测试）；SillyTavern 面清理 ✅（挂错面成员
搬家 + 按名钉面）。getPreset ✅（camelCase id 表钉死，上游注释是错的）。script.generate
（受控口子一期）✅；script.evalTemplate（围栏路由）✅。宿主代取缓存 ✅；CI ✅；
message-preset 字体去重 ✅（2.29→1.89 MB，双牙守卫）。

**在建**：受控口子一期**浏览器验收**（清单已备，SPA 到标题屏，阻塞于浏览器窗口可见性）；
预设瘦身 B 件（jQuery UI 结构兜底，undefined+报告已裁）；EjsTemplate frame 门面；
调试页（宿主半设计 DEBUG-SURFACE.md 已定稿）。

**队列**（2026-09-03 重排；"设计 ✅ / 实现待排"分开记，不再把已付的成本算第二遍）：
1. ~~脚本按钮 UI~~ ✅（设计 SCRIPT-BUTTONS.md，实现已落，爱衣 2 按钮端到端）
2. ~~阅读视图窗口化~~ ✅（WINDOWING.md ②③ 层 + CI 不变式；固定开销由构建核对，只在低估时失败）
3. **MVU 聊天级五件活**（2026-09-03，族级：所有 MVU 卡）——两缺席成员 `loadWorldInfo` /
   `getLorebookSettings` 宿主 arm ✅（原始盘面形状；同步成员进快照不做 RPC），frame 门面待接；
   `Mvu` 未发布已收窄到**多实例选举**（UPSTREAM-MVU-INIT-PATH.md §三之四：`#tavern_helper
   div[data-script-id]` 选优先实例，选不到即静默不发布），三环在树上皆备，剩时序，运行探针在跑。
   验收 = 爱衣 `<UpdateVariable>` 真被 `initResponse` 处理，不看 `Mvu` 在不在。
4. **消息内联 HTML 消毒渲染**——设计 INLINE-HTML.md；CSS 作用域器 ✅、区域切分 ✅（真语料：
   命定之诗 677 楼 334 有区域）、消毒 seam 在建。爱衣 6/8 楼即此。
5. **覆盖层界面宿主**（OVERLAY-CARDS.md）——**用户已亲眼撞上**：V1.5.4 开场白字面只一个「·」，
   整张卡的界面由 990 KB 脚本建在全视口宿主表面上；今天空白。裁点待 7b 列（表面归属、z 层、
   `pagehide` 自清映射、page-access 是否需要）。前置：预置 showdown + VueRouter（上游两种 frame
   都预置，UPSTREAM-ESM-DEPS.md §三；`libraries.ts` 当年按语料零未搬，被此卡推翻）。
6. ~~世界书单通道 + 内嵌书物化~~ ✅（957eaca：装配层只读绑定名；`bookFor` 挂导入与打开两路，
   已有 profile 首开就地迁移；两哈希四格表；撞名不覆盖比上游严；"书没跟过来"种子化+报告；
   DEVIATIONS §12）。**遗留待办**：从 ST 安装取绑定书（dev 里 3 张卡的书在 ST 有、这里没有）。
7. **存储族**（2026-09-03 新增）——语料 8 卡 9 脚本用 `localStorage`（银麒赎世 109 次 + 唯一
   indexedDB，族代表），ST frame 同源可用、我们不透明源不可用。要受管 `localStorage` 门面：同步
   API → 加载时快照 + 写穿宿主；作用域按上游机制 profile 级共享不按卡分区（UPSTREAM-FRAME-ORIGIN.md：
   上游 iframe 无 sandbox、同源共用一个键空间）。AST 普查：165 引用里 4 个裸启动点承担全部"启动即死"，
   6 个组件按组件验收。**indexedDB**：1 卡、blob 级图片库，本轮报告+降级，容量与清理另议；枚举源内
   数据库读邻居扩展（智绘姬）结构上不适用。
8. **卡自带 ESM 依赖的代理**（族级基建）——13 卡 binding 导入 + 15 卡 MVU bundle；去重 11 个地址、
   6 个无版本（TEST-CARDS 副轴：名单会自己过期）；`script-bundles/` 是实际加载的卡尺。待测冷取。
9. ~~导入体积 C~~ ✅（st-meta 记每文件键序表不记值：27.58 → 11.74 MiB，2454/2454 行键序保持；不变式
   措辞改为「逐行键序 + 逐消息内容」，"逐字节往返"从未是树上在跑的那条）
10. **报告分级**——被调用方 catch 住的良性拒绝与卡死脚本的拒绝面板上同形（存储两条 + "1 still
    starting" 并排即读成假因果）；通道须跟句子（"不是失败"不得走 error）。
11. **调试页页面半**——宿主半 ✅（DEBUG-SURFACE.md）。
12. MVU 长局变量清理（Tier 1.3；chat[i].variables 是楼层读通路，裁剪不得静默答空）
13. 受控口子二期（/api/backends/*）已归档 BRIDGE.md，等真实消费者
14. **CI 推远端**——用户决定，仍开放

**升级方向自研**（用户令：自己查资料找改进方向,不等确认）——**失败可观测性已从候选
转为在建**（章程扩至 11 缺口 + 调试页两半）；长局性能三件套中窗口化已有定稿设计、
变量清理在队、message-preset 瘦身 A 件已落（PRESET-WEIGHT.md）；设置组织
（SETTINGS.md：负用量发现 + 10 项 IA 草案）待排；多扩展生态兼容仍为候选。

**账本与文档地图**：偏离两本账落在**三份 DEVIATIONS.md**（`apps/iris-web/`、
`packages/iris-app-service/`、`packages/iris-compat-prompt-template/`）。设计与测量文档
按域归位：界面侧 `apps/iris-web/`（RENDER / COHABITATION / CHAT-WRITES / WINDOWING /
SCRIPT-BUTTONS / PRESET-WEIGHT / GRANTS）；宿主侧 `packages/iris-app-service/`
（FLOOR-VARIABLES / WORLDBOOKS / BRIDGE）；仓库根（SANDBOX / OBSERVABILITY /
DEBUG-SURFACE / SETTINGS / GROUPS / METHODS / ARCHITECTURE）。ROADMAP 不复述它们的
内容，立项时从对应文档接。

---

## Tier 0：挡住你当前用法的

这一层不是"缺功能"，是**你现在用的 MVU 卡在 Iris 上根本跑不起来**。

MVU 官方安装说明的原话是「与这个工具相关的有**一个脚本、两个正则和一个世界书条目**」。世界书和变量我们有了，另两样没有：

### 0.1 卡片脚本沙箱

MVU 本体是一个挂在角色卡上的局部脚本，内容就一行：

```js
import 'https://gcore.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js'
```

所以沙箱必须支持**ES module 语法**与**远程 import**。这不是可选项——`window.Mvu` 就是这个 bundle 装上去的，`@iris/compat-tavernhelper` 提供的 API 面没有它就没有消费者。

上游的 iframe **没有沙箱**（同源 `srcdoc`，直接访问 `window.parent`，API 被平铺成裸全局变量）。我们做了真隔离，同步 API 靠预推快照实现——~~设计已写在 `PLAN.md`，包名 `iris-script-host` / `iris-script-sandbox`，尚未开始~~（2026-09-02 划掉：**已建成并被真卡验证**，实际形态与立项设想不同——不是两个包，是 `apps/iris-web/src/sandbox/` 里的共居 realm + 虚拟 parent + 按卡授权，策略与实测见 `SANDBOX.md`）。

远程 import 还带一个必须现在就决定的安全问题：**卡片能从任意 URL 拉代码执行**。ST 是默认放行的。Iris 应当至少做到域名白名单 + 首次加载时告知用户，否则我们的"隔离"只是把门锁上、钥匙插在外面。

**已决定的策略**：远程代码加载走**域名白名单**，白名单之外的 URL 拒绝加载并告知用户，而不是默默放行。

**白名单范围经实测修正**：本机 19 张真实角色卡里共 15 处远程 import，**14 处来自 `testingcf.jsdelivr.net`**，仅 1 处来自 `cdn.jsdelivr.net`。酒馆助手自己注入 jQuery/Vue 时用的也是 `testingcf`。所以白名单必须覆盖 **`*.jsdelivr.net` 全部主机名**——只放行 `cdn.` 和 `gcore.` 会让 15 处里的 14 处失败。GitHub raw 一并放行。

### 0.2 正则脚本 —— 已完成

MVU 需要的那两条正则：

| 名称 | 内容 | 作用范围 | 选项 |
| --- | --- | --- | --- |
| 去除变量更新 | `/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gm` | AI 输出 | 仅格式显示 + 仅格式提示词 |
| 对 AI 隐藏状态栏 | `<StatusPlaceHolderImpl/>` | AI 输出 | 仅格式提示词 |

没有它们，两件事都会坏：用户在聊天里看到裸命令块，**并且模型会读到自己上一轮的命令块**，从而污染后续生成。

要复刻的语义（`public/scripts/extensions/regex/engine.js` 实测）：

```js
regex_placement = { MD_DISPLAY: 0 /*已废弃*/, USER_INPUT: 1, AI_OUTPUT: 2,
                    SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 }
substitute_find_regex = { NONE: 0, RAW: 1, ESCAPED: 2 }
```

关键是那对**易失性标志**，它们决定了这个功能的全部价值：

- `markdownOnly`（仅格式显示）：只改显示，不改存储
- `promptOnly`（仅格式提示词）：只改发出去的提示词，不改存储
- **两个都不设**：改动被永久写进聊天记录

还有 `minDepth` / `maxDepth`（按楼层深度限定）、`trimStrings`、`runOnEdit`、`disabled`。角色卡自带的正则在 `data.extensions.regex_scripts`——原样保留并由引擎执行。

`packages/iris-regex` 已实现，31 个测试，头三条就是拿 MVU 官方那两条正则跑真实回复，分别验证「读者看不到命令块」「模型读不到自己上一轮的命令块」「存储原文不变」。~~剩下的是接线~~（2026-09-02 划掉：两向接线均已完成——提示词方向在管线里，显示方向在渲染管线里跑真语料，189 个渲染后接口楼就是它的产出）。

### 0.3 ST-Prompt-Template（EJS 模板）✅（子进程围栏+差分验收;frame 侧细路由 script.evalTemplate 已落宿主 arm,门面在 f7 队尾）

你的 ST 装了这个。MVU 教程里的状态栏逻辑就靠它：

```
<% if (_.has(getvar("stat_data"), '理.好感度.[0]')) { %>
```

这是提示词层的模板求值，和 `@iris/macro` 的 `{{}}` 宏是两套东西。归属 `packages/iris-compat-prompt-template`。

---

## Tier 1：日常使用的硬缺口

### 1.1 分支与检查点 ✅（2026-09-01，宿主侧完成，UI 待接）

~~`dsh-session` 的 `fork()` 正好就是这个功能,只差接线~~——**这个前提是错的,实现前查证 API 时被推翻**（教训记档）:`fork()` 挂在 `SessionStore` 上而我们用 detached 的 `Session.create()`,会被 `SESSION_NOT_LIVE` 拒绝;而且它的血缘记在从不持久化的 `SessionHeader` 里,存盘即蒸发。

实际做法照上游 `bookmarks.js` 复刻:聊天文件级切割(`structuredClone` + 包含式 slice)、可选 swipe 同步、`chat_metadata.main_chat` 记父名、父消息 `extra.branches` 记子。额外记 `iris.parentChatId`——上游用**名字**做链接,父一改名链接就断,断链比没链接更糟。

~~「切分支像呼吸一样频繁」是从社区行为推的~~（2026-09-02 已核完并已据此裁决）:31 个
聊天文件里 7 个是派生的,集中在 2/18 个角色、全部发生在 1 月的四天内,此后七个月 5 个
上百楼长局一次没分过支;7 个派生里 6 个切点在父聊天末楼——是「存个档再继续」,不是
「从中间岔出平行剧情」。`extra.branches` 全库零命中,父→子唯一可靠链接是 `bookmark_link`;
`Branch #N` 的 N 是被切楼层号不是序号。**裁决:宿主侧保持完成,UI 侧降为「存档点+跳回」,
分支树无限期后置。**

### 1.2 连接配置档（connectionManager）【2026-09-01 按实测新增】

一个 profile 打包「端点 + 模型 + 预设」三件事，一键切换。本机 settings.json 里有 2 个
profile 且当前顶层值与两者都不一致——**用户确实在手动切换加载**。这是每次换模型都要碰的
东西，按真实触碰频率排在原 1.2/1.3 之前。注意上游的坑照抄前先想清楚：profile 显示名是
创建时的快照，改了模型名字不跟着变（实测一个叫 deepseek 的 profile 实际指向 gemini）。

### 1.3 MVU 长局变量清理【2026-09-01 按实测新增】

上游 MVU 有「自动清理旧变量」：每 50 楼留快照、只保留最近 20 楼变量，**本机用户开着它**，
而他有 677 楼和 143 楼的长局。我们把「变量按候选存储」列为比 ST 好的地方——方向对，但
**没有对应的清理/快照策略,长局下我们的存储只会更大**。另外 MVU 还有「用第二个模型做
额外解析」的路径（本机配置指向本地 1234 端口，自动请求 + 重试 3），我们的兼容层只实现了
「解析模型自身输出」这一条。

### 1.4 作者注释【2026-09-01 降级：本机零使用】

机制上仍然便宜（`iris-pipeline` 已有 depth 注入，卡的 `extensions.depth_prompt` 已在解析）。
但实测本机 `extension_settings.note` 的内容字段**全部为空**——用户从没写过全局或角色注释。
分支有 7 处真实痕迹，这个是 0 处，不该同级。降到 Tier 1 末位，等有痕迹的用户再提。

### 1.5 Instruct / Context 模板【2026-09-01 二次更正：整体后置，Tier 1 就此收尾】

上一版说"context 用户动过手、先做"——**又错了，被第二轮核对推翻**：那个"改过"的
`story_string` 逐字节等于另一份出厂文件（`simple-proxy-for-tavern.json`），和 `Default.json`
的差异是出厂版本差异不是用户编辑。**"git diff 式的比对只告诉你'不同'，不告诉你'和什么相同'。"**
且 `story_string` 在 Chat Completion 路径上一次都没被引用——对本机用户它和 instruct 一样零效果。

**两者在"谁会用"上是一体的**（都只对文本补全用户生效，没有用户只要其中一个），将来若立项，
依据是"TC 用户"这个社区构成，且前置是 Iris 先有裸 `/completions` 管线——那是独立立项，
context+instruct 作为一体跟着它走。在那之前不做：一个没人能验证的功能不该进树。

字段清单在 `PLAN.md` 的数据契约一节。

另一条实测降级：**采样参数封装**。本机用户一个采样参数都没调（temp=1、top_p=1、罚项全 0），
「ST 暴露 76 个采样键」的对齐工作按真实触碰频率排不进 Tier 1。

### 1.6 提示词逐条计费视图 ✅（2026-09-01 落地）

ST 的 prompt itemization：点开一条消息，看到这次请求里每个部分各占多少 token。调试提示词时不可替代。

我们刚有了 `@iris/tokenizer`，而 `iris-pipeline` 的 `Contribution` 本身就带 `id`——**这个视图几乎是免费的**，把每个 contribution 的 token 数一起返回即可。ST 用户会立刻认出这个功能。

---

## Tier 2：期待有，但不挡路

- **群聊**：~~ST 有两种模式~~（2026-09-02 实测更正：**三种**——SWAP/APPEND/APPEND_DISABLED，
  且 swipe/continue 根本不走四种发言策略，走"上一条是谁说的"）。**语料裁决:零使用、
  零兼容义务**——八个来源全零（含 235 个备份的文件名与 31 个聊天的群聊标记），两张
  "命中"卡里的 group 名字全是卡自己的内部函数，不在任何 API 面。**所以做群聊是开拓
  新用户,不是留住现有用户——与本表其他条目不在同一本账上**。上游机制速写（存储契约、
  三模式、策略绕过路径、swipe 与成员身份的耦合）见 GROUPS.md，立项时从那里接。
- **快速回复 + 斜杠命令**：ST 有约 290 个命令。~~`/send /sys /gen /setvar /if /inject /regex`
  这一小撮是社区卡实际会调的~~（2026-09-02 语料实测推翻：全语料 triggerSlash 仅 4 个调用点,
  **只有 `/trigger`(3卡) 和 `/send`(2卡)**;原列七个里六个零命中,而排第一的 `/trigger`
  根本不在原名单上。斜杠优先级是 **2 个命令**,不是 7 个)。
- **角色表情立绘**：sprite 目录 + 情绪分类。ST 靠本地 transformers.js 或让 LLM 判断。
- **主题与 CSS 自定义**：ST 有 `themes/`、`movingUI/`、每用户 `user.css`。Iris 的 slot 系统在这方面本来就更强，但需要真的开出扩展点。
- **更多导入格式**：`.charx`（V3 zip）、`.byaf`（Backyard AI）、Agnai / RisuAI / NovelAI 的世界书方言。PNG 覆盖了绝大多数流通中的卡。
- **mathjs 表达式求值**：MVU 的值目前保守求值，`math.pow(2,3)` 这类会原样透传而不是瞎猜。
- **JSON Patch 方言**与 `_.move`。

## Tier 3：独立子系统，各自是一个项目

- **RAG / 数据银行 / 向量检索**：ST 有 `vectors` 扩展 + `vectra` 本地索引 + 分块策略 + 多种嵌入后端。
- **摘要**：`memory` 扩展，定期自动摘要并按深度注入，暴露为 `{{summary}}`。
- **TTS / 图像生成 / 翻译**：各自是一组 provider 集成。
- **多用户、鉴权、备份**：`dsh-host-webserver` 没有 TLS 也没有鉴权（它自己文档写明），公网部署必须前置反代。
- **酒馆助手以外的扩展生态**：量卡的时候顺手发现，本机 19 张卡的 `extensions` 里还有
  `xiaobaix-tasks`（1）、`xiaobaix-template`（1）、`ST-Amily2-Chat-Optimisation`（1）、
  `juqingtuijin`（1）。~~用户的卡不只依赖酒馆助手一个扩展~~（2026-09-02 更正:**卡里带
  某扩展的键 ≠ 用户装了那个扩展**——实测本机装的扩展只有 JS-Slash-Runner 和
  ST-Prompt-Template 两个;这四个键只说明**卡作者**用过那些扩展,是四张卡携带的残留
  配置,不是「兼容面还差四个扩展」）。真要做的时候同样先量：这些键里装的是配置还是
  代码，决定它是一天的活还是一个子系统。

---

## 明确不照抄的

- **设置项铺天盖地**。ST 被抱怨最多的就是这个：三个各自独立的格式化面板（context / instruct / sysprompt）叠加 Prompt Manager、世界书、正则、扩展，效果互相覆盖，新手无从下手。Iris 的设置应当按"你想改什么"组织，而不是按"这个值存在哪个文件里"。
- **零沙箱的扩展模型**。ST 的扩展就是同源里的任意 JS，能拿到 `getContext()`、密钥端点和整个 DOM。这是我们要修的，不是要复制的。
- **凭据明文与无隔离**。ST 官方文档明说密码"不是安全特性"、数据明文存储、"不要在公网使用"。

## 已经比 ST 好、要守住的

- **插件可逆**。卸载即完整回收副作用。ST 做不到，所以它的扩展升级经常留残渣。
- **变量按候选存储**。swipe 一致性是结构决定的，不是靠额外代码维持。ST 是后来补上 per-swipe 变量的。
- **宏不二次扫描替换结果**。否则卡片存进变量里的文本会变成可执行代码。
- **token 估算经过实测校准**，且能用 provider 报告的真实用量在线收敛。ST 用的是 ~3.35 字节/token 的固定猜测。
- **传输边界有类型且校验请求**。浏览器是独立信任域。
- **toastr 是零字节适配器**（2026-09-02 新增）：上游注入真库、提示只到屏幕；我们供同一个
  面，同样的调用**同时成为一条可上报的诊断**（12/36 卡脚本在用，MVU 产物引用 73 次）。
- **具名失败已收编成章程**（2026-09-02 新增）：OBSERVABILITY.md 11 个缺口（保真度 6 +
  缄默 5），且已产出**否决**——字体子集化优化死于"它的失败没有声音"。
- **编辑重建键在值不在事件**（2026-09-02 新增）：取消编辑不重建 frame，上游会（论证在
  RENDER.md）。
- **楼层预设库自源、内容哈希、可离线、可按卡裁剪**（2026-09-02 新增）：上游是 8 条 CDN
  直连写死在静态 HTML 里，**没有组装这一步**——字体去重与 jQuery UI 裁剪（合计 -32.7%）
  都是这个接缝的产物（PRESET-WEIGHT.md）。

---

## ~~建议顺序~~（2026-09-02 整节废止，由文首「当前状态」替代）

这一节是立项期的排序，**六项全部完成**，保留仅为对照当初的判断：当时认为最大的一块
（脚本沙箱）确实最大，但"前三项工作量小于第四项"低估了第四项裂变出的东西——沙箱
带出了共居、渲染、写回、楼层变量四条线，每条都比原表上的独立项大。**读排序请回到文首。**

---

# 架构改动对兼容性的影响（实测）

问题：我们换了地基，卡会不会用不了。

不靠推理，拿本机 `data/default-user/characters` 里 **19 张真实角色卡**量。用我们自己的 `@iris/character` 解码，19 张全部解码成功。

| 项 | 数量 |
| --- | --- |
| 带正则的卡 | **15 / 19**，共 **173 条**正则 |
| 带脚本的卡 | 7 / 19，共 22 个脚本 |
| 远程 import | 15 处 |
| `parent.X` 访问 | 36 处 |

结论：**数据格式层面没有风险，风险全部集中在脚本执行环境这一处。**

## 安全的部分（有实测支撑）

**角色卡**：19/19 解码成功，且 decode→encode→decode 往返零键丢失，包括 `xiaobaix-tasks`、`ST-Amily2-Chat-Optimisation` 这些计划里没预料到的第三方命名空间。

**只追加的日志 vs 永久改写的正则**——这是我原本担心的一处架构冲突。ST 的非易失性正则会**物理改写** `chat[].mes`，而我们的事件日志是深冻结、只追加的，改不了。实测分布：

| 易失性 | 条数 | 占比 |
| --- | --- | --- |
| 仅显示 | 122 | 71% |
| 仅提示词 | 37 | 21% |
| 两者 | 13 | 8% |
| **永久改写存储** | **1** | **0.6%** |

**99.4% 的真实正则都是易失的**，从不改写存储。这个冲突在实践中几乎不存在，剩下那一条也可以用"编辑事件遮蔽原节点"来表达（`surfaceOp: replace`，能力已有）。

**作用范围**：168 条 AI 输出、73 条用户输入，`WORLD_INFO` / `REASONING` / `SLASH_COMMAND` 在这批卡里零使用。我们的引擎覆盖了实际被用到的全部范围。

**聊天记录**：ST JSONL 往返无损，含未知字段与 `extra` 载荷，有测试守着。

## ~~真正的风险：脚本的宿主访问~~（2026-09-02 整节被 SANDBOX.md 复量取代）

本节原有一张 36 处 `parent.X` 的分解表,**其中的数字已被 `SANDBOX.md` 复量并更正**
(当时的错法记在那份文档里:第一遍只读了含 `script` 的扩展键,只看到三种存储形状之一;
更正后带脚本的卡是 14/19 不是 7,`parent.document` 是 14 处不是 7 处,余同)。结论句
「只有 parent.document 过不去」也被更正后的分解缩小了——14 处里 10 处只是读视口尺寸。
**数字与分解以 `SANDBOX.md` 为唯一来源,这里不再维护第二份**;这一节保留只为记录
「风险全部集中在脚本执行环境」这个当时正确、现在已被沙箱建成所消化的判断。

## ~~需要你拍板的一件事~~（2026-09-02 已裁决并实现，不再待决）

`parent.document` 那 7 处的处理，当时给了三选一，**已裁为推荐案（2 + 3）并建成**：
默认虚拟 parent 代理，个别需要真实访问的卡按卡显式授权（GRANTS.md）。策略、实测与
边界见 `SANDBOX.md` 与 `apps/iris-web/COHABITATION.md`。保留本节骨架是因为三个选项的
利弊分析对将来同类裁决仍有参照价值；**但它已经不是问题,别再答一遍。**
