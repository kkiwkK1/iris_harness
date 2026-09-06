# qa/ — 一次性验收仪器

这些脚本**不是回归网**(METHODS §二十七):它们驱动一个活宿主、按需重跑,不进 CI,也不该
进。所以它们**失败要硬失败**——一个 `console.error` 之后继续跑,在报告里和「这一格没问题」
完全同形。

读这份表之前,先记两条通用口径(TEST-CARDS §九):

- **否定结果要带观察窗口。** 「没看到 X」必须配「什么时候看的、看了多久」,否则对下一个人
  不可复核。表里的「观察窗口」一栏就是每个脚本当前的读法。
- **持久通道要写增量,瞬时通道要写窗口。** 报告缓冲、Notices、卡报告列表都是持久通道:
  行会一直待到被清掉,所以**有无不是判据**,先取基线再判新增才是。
- **读增量时,基线与终读_不是包含关系_。** 卡报告列表在**换角色**时会被清空
  (`store.ts` `loadScripts` 首行),所以点开另一张卡的聊天之后,`rowsNow` 可能**比基线还少**。
  差集(现在有、基线没有)仍然是对的判据;**但读者若默认「终读 ⊇ 基线」,会把一次正常的读数
  当成仪器坏了**。实测:`settledBaselineRows 35 → rowsNow 28`,判据正确。

---

## 环境变量(所有脚本共用同一批名字)

| 变量 | 作用 | 缺省 |
|---|---|---|
| `IRIS_BASE` | 要连的宿主 URL(**脚本自己不起宿主时**) | 见下表,每脚本不同 |
| `IRIS_PORT` | 要监听的端口(**脚本自己起宿主时**) | 见下表 |
| `IRIS_CORPUS` | 卡文件目录 | `D:/workspace/小项目/iris_分支/测试用卡` |
| `IRIS_ST` | 操作者的 SillyTavern 检出根 | `E:/sillyTavern/SillyTavern` |
| `IRIS_CHROME` | Chrome 可执行文件 | `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| `CDP_PORT` | 远程调试端口 | 见下表,**每脚本不同**,且默认值会**加上 `pid % 100` 偏移** |

`verify-click-shift` 与 `verify-widescreen` 另外仍认旧名 `CHROME_DEBUG_PORT`,`CDP_PORT` 优先。

**约定(今后)**:宿主端口从 **8791** 起、每脚本一个;CDP 端口从 **9333** 起、每脚本一个。
两个都必须互不相同 —— 曾经有三个脚本都默认 CDP `9341`,任意两个同时跑就互相抢调试端口。
dev 分支上那批散落的端口不追溯,按下表为准。

**CDP 默认端口还会加上 `pid % 100`。** 不是为了并发,是因为**连着跑两趟同一个脚本**也会撞:
前一个 Chrome 还没释放端口,后一趟就死在

```
Error: chrome never came up
```

—— **它长得像环境故障,不像端口冲突**,而这一句正是它当时骗过我的地方(实测:`A3` 那趟第二个
render 就这么挂了 exit 1,换端口重跑即正常)。偏移让"再跑一趟"这个最常见的动作默认安全。
**显式传 `CDP_PORT` 时按原值用,不加偏移** —— 你指定了端口,就是你在负责它。

> **8790 不用。** 那上面常驻着操作者自己从 `iris_分支` 检出跑的 dev 宿主。

### 起宿主前的两条,都是被真事故换来的(2026-09-06)

一次 QA 想在 8790 起宿主,端口已被占用,宿主 **`EADDRINUSE` 直接退出**;随后那一串 RPC
**照常成功**,只是打到了**别人的宿主**上,给它的 11 张卡各建了一个空聊天。

> **端口冲突不会让你的请求失败,它让你的请求成功地打到别人身上。** 起进程失败和请求打错
> 目标是两件事,而中间没有任何一层会把它们联系起来:进程死在一个终端里,请求在另一个终端
> 里返回 `ok`。

所以:

1. **起宿主前**确认端口是空的(`netstat -ano | findstr :<port>`)。**起宿主后不要再用 netstat
   确认** —— 那次就是这么栽的:启动后看到端口 LISTENING,而那个 listener 是别人的。
   **「端口在监听」不是「我的进程在监听」**,`netstat` 分不开,`RPC 有回应`更分不开
   (任何宿主都会照常应答)。起来没起来,**只能读那次启动自己的输出**,看有没有 `EADDRINUSE`;
2. **发出任何会改状态的 RPC 之前,先读一次 `character.list` 对卡集** —— 它应当**只**含你刚
   导入的那几张。多出别的卡,说明你连到的不是自己那个宿主,**此时任何写操作都落在别人的
   profile 里**。这一条对 `chat.create` / `character.import` / `character.delete` 尤其要紧。

产出一律落在 `qa/results/` 下(脚本旁边)。曾经有一个脚本把截图与报告写到某个只在一台机器
上存在的 worktree 路径,于是在别处第一张截图就死,而前面十分钟的测量什么都没留下。

---

## 定位:两类,不要合并成一条「不按文本」

- **界面外壳**(页签、设置按钮、同意门的两个按钮)——**绝不按可见文本定位**。那些文字会被翻译,
  而 headless Chrome 跟随 `navigator.language`,在这台机器上界面起在中文,于是所有写着英文词的
  定位器全部落空。`qa/qa-card.mjs` 就是这么每张卡都死在 `no Characters tab: 阅读|角色库` 的。
- **用户数据**(聊天名、角色名)——**文本就是正确的 handle**,那不是外壳,而且没有别的把手。
  `measure-frame-fit` 按 `.iris-row__title` 找行是对的,不要顺手一起改掉。

外壳定位集中在 **`qa/locators.mjs`**,三个:切页签、开抽屉、答同意门。**每个都返回它做了什么,
并把落到的那段可见文本作为_证据_记下来** —— 文本是读数,不是判据。

> **今天没有属性可以键。** `Sidebar.tsx` 的两个页签是同样的 `role="tab"` + 同样的 class、没有 id,
> 只差 `aria-selected`(**状态,不是身份**)与被翻译的标签;`Masthead.tsx` 的设置按钮没有
> `aria-label` 也没有 id。所以这三个定位器用的是**次序 + 点击后按结构确认生效**
> (`aria-selected` 变 true / 出现 `.iris-drawer--open`)。等 `data-tab="chats|characters"` 落地,
> **只改 `locators.mjs` 一处**,五个脚本一起跟上 —— 这就是它是一个模块而不是五份复制的理由。

---

## 脚本表

「判据层」= 这个脚本**用什么下判断**,不是它顺手打印了什么。

| 脚本 | 量什么 | 判据层 | 观察窗口 | 宿主 | CDP | 需要的 profile |
|---|---|---|---|---|---|---|
| `rpc.mjs` | 共享件:RPC、事件收集器、`debug.reports` | —(无判据) | `waitUntil(pred, timeoutMs)`,200 ms 轮询,**超时返回 `undefined`** | `IRIS_BASE` **8792** | — | — |
| `import-cards.mjs` | 六张真卡 + 四个非卡文件的导入结局 | RPC(错误码与**具名**错误文本) | 无否定判据 | 同 `rpc.mjs` | — | 空 profile 即可 |
| `qa-card.mjs` | 逐卡全程:脚本授权、一轮真对话、两侧帧稳定性、MVU 变量域、诊断报告增量 | **三层齐用**:RPC + console(含 HTTP≥400)+ 屏幕几何 | 帧稳定 5 采样 × 1.5 s(**只用后 3 个判稳**);对话 240 s(超时写成 `reason`);导航 7 s / 帧起 10 s / 流末 12 s;硬闸 420 s | 同 `rpc.mjs` | 9333 | 目标卡已导入 |
| `render-only.mjs` | 不花对话轮,复读既有聊天的帧几何 | 屏幕几何 | 5 采样 × 1.5 s;导航 7 s + 帧起 12 s | 同 `rpc.mjs` | 9334 | 目标聊天已存在 |
| `bare-html-check.mjs` | `setup`:塞裸 HTML 夹具楼层(不调 LLM)。`render`:裸 HTML 是否成帧、**源码有没有漏进正文**、未闭合块**有没有被报告** | 屏幕(帧属性 + `.iris-msg__text` 文本)+ **卡报告行的增量** | 每条读数带 `observedAtMs`;`WINDOW = {boot 7 s, framesBoot 12 s, drawerSettle 1.2 s}` | 同 `rpc.mjs` | 9437 | `setup` 会自己建四个夹具聊天 |
| `measure-frame-fit.mjs` | 消息帧尺寸 vs 可见阅读带、遮挡(矩形相交)、高度振荡 | 屏幕几何 | 振荡 12 采样 × 250 ms;等帧 45 s + 4 s 落定 | `IRIS_BASE` **8821** | 9342 | **五张卡各建一局**(`CARDS` 按角色名前缀解析) |
| `multibook-acceptance.mjs` | 绑第二本世界书 → 提示词长大 → 解绑 → **逐 token 回到基线** | RPC/装配产物(`prompt.itemize`) | 等宿主 120 × 500 ms;判据是等式,不需要窗口 | 同 `rpc.mjs`(任务书用 8817) | — | 自带卡与书,跑完自己解绑 |
| `persona-acceptance.mjs` | 人格描述是否进到 **provider 真收到的请求体**、`{{persona}}` 展开、人格触发世界书次要键、删除后的零变化红线 | **线上请求体**(mock provider 抓包)+ `prompt.itemize` | 等宿主 15 s;关键处等**请求体对象身份变化**,不等文本 | 自起,`IRIS_PORT` **8815** | — | 自建一次性 dataDir;要 `IRIS_ST` 下的 `啊不吃.json` |
| `character-ops-acceptance.mjs` | 改名不断绑定、副本共享书、导出逐字段等于存盘卡、标签写回、收藏是 profile 级 | **磁盘 + RPC**,全程无浏览器 | 等宿主 20 s;判据全是状态等式 | 自起,`IRIS_PORT` **8812** | — | 自建一次性 dataDir |
| `notice-probe.mjs` | 布景:导入三张探针卡并建聊天 | —(无判据) | — | `IRIS_BASE` **8824** | — | 会先删同名旧卡 |
| `notice-center-baseline.mjs` | 通知面板:冷启动干净 / 一次打开的行 / **同一故障三次合成一行 ×3** / 三视口的中线 | 屏幕,读的是**抽屉里的 Notices 列表**(持久),不是 toast | 每次开聊天后 4 s / 2.5 s / 1.2 s;开抽屉 20 × 100 ms | `IRIS_BASE` **8824** | 9343 | 先跑 `notice-probe.mjs` |
| `i18n-check.mjs` | 双语:跟随 `navigator.language`、**探测本身不落盘**、抽屉切换免刷新、过刷新、清掉恢复探测 | 屏幕(`textContent` + `lang`/placeholder 属性) | 抽屉文案 10 × 300 ms 轮询;其余固定 400/1500 ms 单读 | `IRIS_BASE` **8797** | 9336 | 空 profile 即可;开聊天那一趟要 `IRIS_CORPUS`,**缺则具名 SKIP** |
| `r-cards-check.mjs` | 设置抽屉八张折叠卡:默认开两张、`aria-expanded` 与 `hidden` 一致、开合过刷新、trim 开关**穿到宿主**、凭据文案、中文半边 | 屏幕 DOM + 属性,一处穿到宿主 `settings.get` | 点击后固定 600 ms | `IRIS_BASE` **8814** | 9341 | **不开聊天**(八张卡是"没有聊天"时的数目) |
| `verify-click-shift.mjs` | 在问候楼**之后**追加楼层,在卡自己的帧里点它自己的按钮,验楼 0 切到 swipe 1;外加抽屉纯覆盖 | **持久投影**(轮询 `chat.export`)+ 屏幕几何 | 切楼 40 × 500 ms;滚动停在离底 ≥128 px,把 64 px 吸底排除在外 | `IRIS_BASE` **8825** | 9338 | 会自己导入 `v0.5NSFW.png` |
| `verify-widescreen.mjs` | 三视口 sheet 几何;抽屉开合前后 scrollTop 与 sheet 矩形不动;窄屏零回归 | 屏幕几何 | 开合各 20 × 100 ms;中线按**记录基线**判增量(`BASELINE_MIDLINE_DEV = 23`) | `IRIS_BASE` **8825** | 9335 | 没有卡时自己导入一张 |
| `list-my-chromes.ps1` | 列 Chrome 可执行路径 | — | — | — | — | — |

---

## 哪些脚本会硬失败(退出码非零)

| 脚本 | 退出码 |
|---|---|
| `measure-frame-fit.mjs` | **1** = 解析到的卡数低于下界,或某张卡一格都没量到;**2** = 宿主没答(与「量得不够」分开,不必读日志就能分辨);3 = 硬超时 |
| `multibook-acceptance.mjs` / `persona-acceptance.mjs` / `character-ops-acceptance.mjs` / `i18n-check.mjs` / `r-cards-check.mjs` / `verify-click-shift.mjs` / `verify-widescreen.mjs` | 1 = 有检查未过 |
| `qa-card.mjs` / `render-only.mjs` / `bare-html-check.mjs` / `notice-center-baseline.mjs` / `import-cards.mjs` | **不判 PASS/FAIL** —— 它们产读数,判读由人做 |

`measure-frame-fit` 的下界断言有**两条**,缺一条都能被绕过:第一条问「解析到几张卡」
(**0 也是一个完全瞎掉的解析器会给的答案**,所以要有阳性对照),第二条问「解析到的每张是不是
真被量了」(单独用是**空集上的全称量词,恒真**)。**帧数不进门禁**——一格里有没有帧是读数,
不是门禁。
