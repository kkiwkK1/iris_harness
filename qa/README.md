# qa/ — 一次性验收仪器

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。

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

> **脚本一律走 `cdpPort()`**(`qa/cdp-port.mjs`,三行导出),不要再把偏移公式抄进去。
> 之前七个脚本各抄一份、两种写法,`z1-e2e.mjs` 那份还漏了偏移、写死了与
> `notice-center-baseline.mjs` 相同的 9343——两个同时跑就撞,而失败长得像环境故障。
> 需要旧名 `CHROME_DEBUG_PORT` 的两个脚本把它当第二个参数传给 `cdpPort(base, 'CHROME_DEBUG_PORT')`。

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

## 临时目录:一律走 `qa/chrome-profile.mjs`

headless Chrome 要一个 `--user-data-dir`,验收宿主要一份数据目录。这两样都是**临时**的:
脚本跑完就该没了。**任何脚本都不再自己拼临时路径**,而是问这一个模块要:

```js
import { chromeProfile } from './chrome-profile.mjs'

const profile = chromeProfile('iris-r2-')            // 建目录 + 登记清理 + 扫同前缀的陈旧兄弟
const chrome = profile.adopt(spawn(CHROME, [         // 把浏览器交给它:先杀进程,再删目录
  `--user-data-dir=${profile.dir}`, /* … */
], { stdio: 'ignore' }))
```

拿回来的东西会自己清掉:正常返回、抛异常、`process.exit()`、Ctrl-C,四条路都清。
`qa/` 里绝大多数脚本是平铺的顶层程序,末尾一句 `process.exit()`,`try/finally` 根本看不见
那次退出,所以模块里同时挂了一个**同步**的 `'exit'` / 信号处理器 —— 这是它必须写两遍的原因。
需要包一层函数的地方用 `withChromeProfile(prefix, async handle => …)`;数据目录用
`dataCopy(prefix)`,它带 `connections.json`,所以**必须删掉,不能改名留着**。

目录建在系统临时目录(Windows 上就是 `%TEMP%`,即 `os.tmpdir()`),名字是「前缀 + 六位随机」。
**每次建目录也会顺手扫一遍同前缀、一小时以上没动过的兄弟目录并删掉**,所以以前漏下的那些
会自己愈合,不需要这个模块当年就存在。那一小时是为了不误删另一份正在跑的同名脚本的
profile —— 活着的 profile 一直在被写。想看它扫掉了多少,`IRIS_TEMP_VERBOSE=1`。

要手工清干净:

```powershell
Get-ChildItem $env:TEMP -Directory -Filter 'iris-*' | Remove-Item -Recurse -Force
```

### 2026-09-19:这条规矩是 11.5 GB 换来的

当天在这台机器上量:`%TEMP%` 里躺着 **321 个带 `Default/` 的 Chrome profile,合计 11.53 GB**
(单个平均 37 MB,被驱动过的能到 120 MB),分布在 **90 个不同前缀**下,其中大多数前缀在树里
已经找不到对应脚本 —— 都是一次性仪器留下的。没有任何一处代码删过它们。

同一次普查还纠正了一个前提:`%TEMP%` 里 `iris-*` 目录的**条数**(当时 45 673 条,且在被系统
清理持续搬走)几乎全部来自 `packages/*/tests` 与 `apps/*/tests` 的单元测试 `mkdtemp`
(`iris-wb-write-` 10 457 条、`iris-src-` 8 553 条、`iris-persona-` 6 499 条……),
平均 0.2–1.1 KB,合起来约 30 MB。**条数在单元测试那边,字节在 Chrome profile 这边。**
这条规矩治的是后者;前者是另一笔账,还没动。

这是工装决定,不是产品行为,所以不进 `notes/apps/iris-web/DEVIATIONS.md` —— 那份账本里
一条 `qa/` 都没有,不该由这件事开头。守规矩的门禁是
`apps/iris/tests/temp-dir-discipline.test.ts`:它按源码文本扫 `qa/`、`apps/iris-web/tools/`、
`scripts/`,凡是提到 `--user-data-dir` 或 `mkdtemp` 的文件都必须 import 这个模块;
放行名单逐条写清理由,并且会检查「这条放行是不是已经过期」。

`scripts/` 下的 cache / context 探针是**具名放行**的:它们的 `mkdtemp` 建在操作者自己命名的
`IRIS_PROBE_SCRATCH` 根下,已经在 `finally` 里删,而 `--keep` 留住一次 run 供检查是**故意的
功能**。当天普查里它们留下 0 个目录,所以不动。

`notes/st-compat/acceptance/pilot-host.mjs` 与 `seed.mjs` 也还没动:它们把数据目录的路径
**打到 stdout 给驱动用**,退出即删会改掉那个约定,要连验收脚本一起改才算数。

**另一笔账当天就结了。** 上面那句「前者是另一笔账,还没动」说的单元测试,来源被逐点数清:
`packages/*/tests`、`apps/*/tests`、`tests/` 里一共 **203 处 `mkdtemp` 调用**,其中 **179 处
本来就写了 `t.after` 的删除,只有 24 处没写**。漏掉的不是一条错的行,是一条**不存在的行**,
评审看不见 —— 所以修法不是补那 24 处,而是让第一行自己带上第二行:新的
`packages/iris-app-service/tests/support/temp-dir.ts` 导出 `tempDir(t, prefix)`,建目录的同时
就把删除挂到 `t.after` 上;203 处全部改走它,这三棵测试树里 `mkdtemp` 一处不剩。它**镜像**
`qa/chrome-profile.mjs` 的删除语义(同一份 30 × 200 ms 重试预算、同一套 rename-aside 兜底)
而不是 import 它:`qa/` 不在根 `tsconfig.json` 的 `include` 里且是 JSDoc 标注的 JS,而那边的
`tempDir` 返回的是一个装了 `process.on('exit')` / `SIGINT` 处理器、还要认领子进程的 handle ——
那是给 `process.exit()` 收尾的扁平脚本用的契约,`node:test` 既不需要也用不上。

少数目录活得比一个测试长(文件级 `before()` 里建的,或者被 booted host / headless Chrome
占着的),走 `tempDirOwned` + `removeTempDir`,由调用方在**停掉那个东西之后**自己删 ——
因为 `t.after` 按注册顺序跑,建目录时挂上的删除会跑在 dispose **前面**。这 14 个文件每个都要
写明为什么不是 `tempDir`,门禁会数它们。

第 14 个是这次改动**量出来的**,不是设计出来的:`card-storage.test.ts` 改成 `tempDir` 之后,
整套跑完 18 个 fixture 里有 **8 个目录又回来了**,里面只有一个 `card-storage.json`、没有
`characters/` —— 因为 `CardStorageStore` 的写是 debounce 的,定时器在删除**之后**才响,
`#save` 里的 `mkdir(…, {recursive:true})` 把父目录又建了回去。单跑这个文件一次都不漏,因为
那个定时器 `unref` 过,单文件的进程在它响之前就退了。所以它现在先 `flush()` 再删。
**这不是这次改动引入的**:main 上那一版 `t.after` + `rm` 有同一个竞态,只是没人对着 `%TEMP%`
数过。

同一次测量还纠正了一个方法学前提:`%TEMP%` 是**跨会话共享**的,并发的 peer 会话会往里写
(量的时候就抓到过 `iris-qa-cdp-*` 和 `iris-sandbox-plugins-b-qa-*`)。所以「增量为 0」这个
判据要在**隔离的 TEMP** 下复现才算数 —— `TEMP=<临时根> TMP=<临时根> npm test`,`os.tmpdir()`
在 Windows 上就认这两个变量。上面那 8 个目录正是这样才认定是自己的而不是别人的。

门禁还是 `apps/iris/tests/temp-dir-discipline.test.ts`,尾部多了一块只管测试树的断言:扫到的
文件数有下界(写这条时 391 个),**import 了这个 helper 的文件数也有下界**(122 个 —— 空集
同样满足「没有违规者」,所以要有阳性对照),`tempDirOwned` 的用量有上界。验证方式是在一个
测试里塞回一行裸 `mkdtempSync` 看它变红,再撤掉看它变绿。

**数字**:origin/main 上跑一趟 `npm test`(`fail 0`,4344 个测试),`%TEMP%` 里 `iris-*` 目录
1969 → 2345,**+376**;改完之后连跑两趟(`fail 0`,4352 个测试),3108 → 3107 → 3107,
**两趟新增的 `iris-*` 目录都是 0 个**(那 −1 是别的会话的目录被清掉了,不是这边的)。隔离
TEMP 下的对照也是 0。

历史堆积的那几万条不在这次清理范围内 —— helper **不扫**兄弟目录:`qa/chrome-profile.mjs` 敢扫
是因为它的前缀属于单个脚本,而测试的前缀在并发的会话之间是共用的,按前缀扫会删掉别人正在
跑的 fixture。那批存量由操作者按前缀手工删。

---

## 定位:两类,不要合并成一条「不按文本」

- **界面外壳**(页签、设置按钮、同意门的两个按钮)——**绝不按可见文本定位**。那些文字会被翻译,
  而 headless Chrome 跟随 `navigator.language`,在这台机器上界面起在中文,于是所有写着英文词的
  定位器全部落空。`qa/qa-card.mjs` 就是这么每张卡都死在 `no Characters tab: 阅读|角色库` 的。
- **用户数据**(聊天名、角色名)——**文本就是正确的 handle**,那不是外壳,而且没有别的把手。
  `measure-frame-fit` 按 `.iris-row__title` 找行是对的,不要顺手一起改掉。

外壳定位集中在 **`qa/locators.mjs`**,三个:切页签、开抽屉、答同意门。**每个都返回它做了什么,
并把落到的那段可见文本作为_证据_记下来** —— 文本是读数,不是判据。

> **身份属性已经落地了。** 早先这一节写的是「今天没有属性可以键」,于是三个定位器用**次序 +
> 点击后按结构确认生效**。现在 `Sidebar.tsx` 的两个页签各带 `data-tab="chats"` / `"characters"`
> (`sidebar-tabs.test.ts` 把每个值钉在对应的 `setTab('…')` 上),`Masthead.tsx` 的设置按钮带
> `data-control="settings"`,`locators.mjs` 已经改成按这两个属性找。`aria-selected` 仍然只当
> **生效确认**用 —— 它是状态,不是身份。改一处、五个脚本一起跟上,这就是它是一个模块而不是
> 五份复制的理由。

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

### 表外的脚本(一次性,只留档)

下面这些是某个任务做完之后留下的仪器,判据层与观察窗口写在各自文件头,这里只记它量什么,
免得一个新读者以为 `qa/` 就是上面那张表:

| 脚本 | 量什么 |
|---|---|
| `z1-e2e.mjs` | Z1:政经博弈卡的建国链路走真 UI(RPC 授权建聊天 → CDP 进卡自己的界面帧填两个字段点「确认建国」)。CDP 默认 **9343 + `pid % 100`**(与 `notice-center-baseline.mjs` 同默认端口,但两份都走 `cdpPort()`,偏移错开) |
| `z1-regression.mjs` | Z1:状态栏 MVU 卡上跑一轮真对话,盯 user→reply 窗口里 STATE 面板的变量。CDP 默认 **9353 + `pid % 100`** |
| `z1-repro.mjs` | Z1:同一条建国链路按卡的原始调用顺序走线,不开浏览器 |
| `measure-z2-scroll.mjs` | Z2:在 `measure-frame-fit` 的几何之外,量**帧内部**能不能滚到底 |
| `measure-z3-occlusion.mjs` | Z3:三张重卡的帧几何 + 帧内滚动 + 边注遮挡。`IRIS_BASE` 默认 `8823` |
| `z3-rpc-probe.mjs` | Z3 前置:任何操作之前先给重卡的聊天各拍一次 C17 快照。`IRIS_BASE` 默认 `8823` |
| `z3-scroll-proof.mjs` | Z3 视觉佐证:把 1847px 的界面在 546px 带里滚到底并截图 |
| `plugin-platform/browser-fixture.mjs` | 系统插件客户端面的真浏览器夹具:服生产沙箱包体 + 一个合成插件的 `client.js` + 两个 Iris 自己拼的 srcdoc 帧。端口取 `IRIS_ACCEPTANCE_PORT`,默认 **8792** |
| `review2-drive.mjs` / `review2-batch.mjs` / `review5-claims.mjs` / `review5-causal-switch.mjs` / `review5-swipe-vars.mjs` | REVIEW-2 / REVIEW-5 的仪器:逐卡跑一轮真回合、成批跑、按**已存在**的对话逐层数 claim↔frame 等式(不花 token)、`iris.bodyTag` 因果开关、swipe 候选级变量。判据层与观察窗口见 `notes/CARD-REGRESSION-2026-09-17*.md` |
| `review6-frame-oscillation.mjs` / `review6-three-runs.mjs` | REVIEW-6 的仪器:同一时基上录**两条曲线**(帧上报的 `height`/`sizing`/`note` vs 壳里 iframe 的已用高与内联高),外加带高的**邻居**(`.iris-notice` 横幅的高度与原文、`iris-scroll` 往上的盒子链),并逐采样验算 `带高 + 横幅高` 是否恒定。`review6-three-runs.mjs` 是三个 run 的包装(原样 / 录前清横幅 / 窗口内按住横幅),任一 run 非零退出即停。判据与读数见 `notes/FRAME-OSCILLATION-chuangshi-2026-09-17.md` |
| `sandbox-plugins-pr-a.mjs` | 沙箱插件 PR-A 的验收（[SANDBOX-PLUGINS](../docs/SANDBOX-PLUGINS.md) §15 第 1–5 条）：自起宿主 **8791**、CDP **9345**、拷一份 `apps/iris/data` 到临时目录并删掉 `host.lock`。PR-A 的插件源是 dev 面板（生产包里没有），所以它从帧自己的 `<meta name="iris-token">` 取令牌、直接 post 一条与壳逐字节相同的 `plugin:mount`。**不花钱**。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `sandbox-plugins-pr-b.mjs` | 沙箱插件 PR-B 的验收（§15 PR-B 第 1–7 条）：自起宿主 **8793**、CDP **9346**、同样的数据目录拷贝口径。**花真钱**——第 1、4、6 条各一次「创造」请求，上限由脚本里的 `SPEND_CAP = 8` 强制执行而不是写在注释里；供应商只按 id 与 label 打印，写插件用的连接**只经产品自己的 `connection.authoring` RPC** 设置，不碰任何密钥文件。第 3 条会停掉并重起**它自己起的那个**宿主。第 4 条的预期结果是「消息帧里的状态栏**没有**变深」——记成**已知边界并指向 PR-C**，不是记成通过；第 5 条的删除走面板控件而不是一句话（契约里没有那条路），第 7 条靠「同一秒内删掉再建同名对话」逼 chatId 回收，回收不到就记成边界并指向那条确定性的单元测试。硬失败同上 |
| `sandbox-plugins-pr-c.mjs` | 沙箱插件 PR-C 的验收（§15 PR-C）：自起宿主 **8794**、CDP **9347**、同样的数据目录拷贝口径。**不花钱**——插件源用 PR-A 那个仪器（读帧自己的 `<meta name="iris-token">`，post 一条与壳逐字节相同的 `plugin:mount`），因为 PR-B 那条路每次都要花一次 completion。量的是一张样式表**越过帧边界**：消息帧上 `[data-iris-plugin-style]` 0→N→0、状态栏计算背景的三次读数、消息帧 srcdoc 实际内联的字符数（基线/折进/终读）、以及**壳自己的文档上全程 0**（§16.3 的牙齿）。卡默认 `爱衣`（`IRIS_CARD` 可改）——它的问候楼是一个**围栏**界面，而那正是第一次跑量出缺陷的地方。每格读两次（4 s 与 9 s），因为重建会把旧帧 park 在屏幕上。**「帧预算面板」不存在**（`FramePlan.spent` 没有 UI 读者），脚本把这一句连同替代读数一起印出来。硬失败同上 |
| `sandbox-plugins-pr-d.mjs` | 沙箱插件 PR-D 的验收（§15 PR-D）：自起宿主 **8795**、CDP **9348**、同样的数据目录拷贝口径。**不花钱**——但插件源不走 PR-A 那个仪器（面板要看的是**记录**，不是帧里的树），而是**自己把 sidecar 写进那份拷贝**：`<profile>/sandbox-plugins/<chatId>.json`，§10.1 的形状，**两个版本、字节不同、已授权**。宿主每次 `sandboxPlugin.list` 都从这个文件读，所以它下游全是产品。量的是：`sandboxPlugin.source` 按版本答字节与哈希、三种具名拒绝（没有的版本 / 没有的插件 / **别的对话的插件**）、`list` 的行里一个字节的源码都没有；面板上那一行、「看代码」里的 `<pre>` 与挂载的字节**逐字符相同**、面板里 `textarea/input/[contenteditable]` **计数为 0**；空对话的空态两句在两栏各读一次（改 `localStorage['iris.language']` 后重载）；用量页那一行——**这一格要往一个没被打开过的对话的头部塞一条 `iris_side_usage`**（`source:'plugin'`），因为写它的唯一产品路径是一次花钱的「创造」；塞不进去就**具名记成未驱动**并指向那两个确定性单测，不算通过。面板与源码块都**轮询到期限**再判，因为两者都在一次往返之后才到。硬失败同上 |
| `quote-colour-acceptance.mjs` | 引号内对白上色的验收（web 账本 §121）：自起宿主 **8797**、CDP **9351**、同样的数据目录拷贝口径。**不花钱**——两张卡都只读**开场白**：一张本脚本自己写进拷贝的 `QuoteProbe`（六种引号 + 一段横跨 `<em>` 的引号 + 一段代码里的引号），和语料里的 `2.1.0.png`（灭仇家满门，FRAME-FENCED，`first_mes` 自带围栏文档）。判据层是**屏幕的计算样式**：每个 `.iris-msg__text q` 的 `color` 与**它自己父元素的** `color` ——「对白是另一种颜色」是个比较，不是一个值，所以单读引号色会在颜色等于正文时照样报绿；另读 `::before`/`::after` 的 `content`（浏览器默认样式表会自己再加一对引号）。换主题走产品自己的重载路径（写 `localStorage['iris.theme']` 再 `Page.navigate`，`loadThemeChoice` 那条），并**先确认 `data-iris-theme` 真的动了**再读第二遍。`QUOTE_FRAMES_ONLY=1` 只读围栏卡的 `slots`/`iframes`——「改动前」那一半必须走它，因为改动前一个 `<q>` 都没有，第一条颜色断言就会硬失败、根本走不到帧那格。硬失败 1 = 有检查未过 |
| `quote-stability.mjs` | 引号色**会不会掉**的一次稳定性读数（web 账本 §122）：自起宿主 **8798**、CDP **9352**、同样的数据目录拷贝口径。**不花钱、也不写任何东西**——开的是数据目录里**本来就有**的两段对话：**黑兽**（带脚本的卡，主体）与 **Assistant**（无卡无脚本，对照）。读数是 `document.querySelectorAll('.iris-msg__text q').length`，在开启后 **2 s / 10 s / 30 s** 各一次，再在三次「不动消息依赖」的重渲染后各一次：收起并展开状态栏、改视口宽度再改回来、打开并关闭提示词面板。**三次里只有提示词面板那次能被证明发生过**——它是 `ChatPane` 的 `explaining` state，`Message` 既没 memo 也没换 key，面板出现在 DOM 里就是提交发生过的证据；另外两次 React 在输出相同时什么都不写，「重渲染了而颜色还在」与「根本没重渲染」同形。判据是趟内的比较（30 s 那次是基线，重渲染后低于它就是缺陷），**不是跨趟比较**：黑兽这张卡的界面 claim 异步落定，实测三趟的绝对数是 33 / 19 / 19。硬失败 1 = 有检查未过 |
| `authoring-row-acceptance.mjs` | 连接页 「写插件用」 一行的验收（web 账本 §120）：自起宿主 **8796**、CDP **9349**、同样的数据目录拷贝口径。**不花钱**——只设置 `connection.authoring`，并把 composer 的 「创造」 切进模式再切回来，一次 completion 都不发。判据层：屏幕（按钮的 `disabled`、模型控件显示的值、行里那句话）+ RPC（`connection.list` 的 `authoring`）。**「选完供应商立刻读按钮」是全部意义所在**——改值、派发 `change`、等 React 落定、读 `disabled` 写在同一段 `Runtime.evaluate` 里，中间再插一次交互就会把缺陷治好而不是量到。「创造」 那一格按 note 在不在与**模式有没有变**判（它没有 `disabled`，而模式只显示在 placeholder 与发送键的 `aria-label` 上，两者都会被翻译，所以判「变了」不判文案）。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `sandbox-plugin-scope-acceptance.mjs` | 沙箱插件 scope 一轮的验收（owner id、OwnerScope 拆卸、forget/branch 规则）：自起宿主 **8796**（启动前断言空闲；与 `authoring-row-acceptance.mjs` 同默认端口，不要同时跑）、CDP **9359** + `pid % 100`、数据目录拷贝口径。**不花钱**——两段同卡对话的 sidecar 由脚本直接写进拷贝（一个已授权的 `01-probe`，会 `initializeGlobal`、写 `script` 域变量、挂面板格）。判据层：帧内（CDP 附到卡脚本帧，读面板格与 `'QA_SCOPE' in window.parent`）+ 拷贝里的 `script-variables.json`（owner 键）+ 产品自己的面板停用/启用按钮与 `sandboxPlugin.decide` / `chat.delete`。帧读数都轮询到期限（15–20 s）。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `card-collapse-plugin-acceptance.mjs` | 「收起卡片界面」只收卡、不收沙箱插件的验收：自起宿主 **8803**（启动前断言空闲）、CDP **9363** + `pid % 100`、数据目录拷贝口径，默认卡 `银麒赎世`（`IRIS_CARD` 可换；要一张在卡脚本帧里画界面的卡）。**不花钱**——sidecar 直接写一个已授权的 `01-collapse-probe`（一张 `styles.insert` 定位的面板格）。判据层：帧内（卡自己的元素有几个在画、面板格是否在画、插件样式表几张）+ 页面（覆盖层 `visibility`、帧 clip、`elementFromPoint` 落在面板格与原卡界面处各是谁）+ 三张截图（展开 / 收起 / 停用插件后收起的对照）进 `qa/results/card-collapse-plugin/`。对照：停用插件后收起仍由壳把覆盖层整体藏掉。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `doctor-acceptance.mjs` | 输入框 `/doctor` 的验收（web 账本 §123、host §100）：自起宿主，端口**从 8791 往上取第一个没人监听的**（启动前断言，`IRIS_PORT` 可钉死），CDP **9356**，同样的数据目录拷贝口径，外加一份**构建产物的拷贝**（`IRIS_WEB_DIST` 指向它）。**不花钱**——不发消息；唯一出网的是「提供方测试」那一行，即连接面板测试键的 `GET /models`。判据层是**屏幕**：在对话里打 `/doctor` 回车，读通知条的文字节点（保留换行，不含 ✕），按两栏的 `doctorLabel*` 把每行对回检查名，所以与 Chrome 的语言无关。然后制造三个坏状态读行翻转：`connection.authoring {}`（「写插件」→ ⚠；拷贝原本没设就先设一次，量的是翻转）、`script.setScriptsAllowed false`（「卡片脚本」→ ⚠）、**页面不动、把拷贝里的入口改名并改写 `index.html`**（「页面构建」→ ⚠ 且两个文件名都在），再刷新读回 ✓ 作对照。另读：4 s 后报告还在（lasting）、`white-space: pre-line`、通知日志里有它、对话条数没变。硬失败 1 = 有检查未过、2 = 端口/数据目录/构建问题、3 = 硬超时 |
| `ejs-builtin-acceptance.mjs` | 裁定 7 的验收（host §105）：Iris 的 EJS 引擎成为插件中心内置行 `iris-templates`。默认端口 **8797**（启动前断言空闲，拒绝 8787），CDP **9361**，数据目录拷贝口径同上，并**删除拷贝里的 `connections.json` / `connections.key`**，让宿主首启把指向本地 mock 的启动环境导入为唯一供应商——**不花钱**，每次发送都落到 127.0.0.1，并核对发送数与 mock 收到数。判据层是**提供方收到的请求体**：提示词面板只有标签与 token 数，且 Iris 的引擎在流接缝跑，面板上没有求值后的文字。步骤：行出厂已安装未启用；逐张卡发一句，找出请求体含 `<%` 的卡；在真 Chrome 里设置 → 系统插件 → 该行「启用」，读确认框出现、未勾选时确认不可用、确认前宿主未启用；勾选确认后行变启用（不重启），同一对话下一次请求的 `<%` 变少，并读出同一锚点处的展开文字，目录文件已持久化。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `branch-tree-acceptance.mjs` | 分支树的验收（web 账本 §128、host §103）：自起宿主，端口 **8794**（启动前断言空闲，`IRIS_PORT` 可改），CDP **9357**，数据目录用拷贝（`dataCopy`，退出时和 Chrome 配置一起删掉）。**不花钱**，分支和切换都不请求模型。分支全部用界面自己的按钮建：同一对话两楼按「分支」，在分支上再按「分支」（分支的分支），在读法条旁按「转成分支」。然后依次做这些事：读 `chat.tree`；截边栏（变量在上、树图在下）；点树图节点（切换，并滚到那一楼）；点「⑂N」徽标；在窄窗口里用页眉的「分支」浮层点节点。最后逐行比对父对话文件，只允许表头和分叉楼那几行有变化（只多出 `iris_id` 和 `extra.branches`）。截图写到 `qa/results/branch-tree/`。父对话按侧栏标题查找（行上没有 id 属性），所以只从标题唯一的对话里选。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `branch-manage-acceptance.mjs` | 分支管理的验收（web 账本 §129、host §106）：自起宿主，端口 **8804**（启动前断言空闲，`IRIS_PORT` 可改），CDP **9367**，数据目录用拷贝（`dataCopy`，退出时和 Chrome 配置一起删掉）。**不花钱**：只用界面的「分支」按钮（抄楼层）建出 P→A(2)→{C(1), B(2)→D(2)}、P→E(n-3)，并读页面发出的 RPC 证明没有生成。依次验：六列、根是主干、五种分支色、边栏「↳」与列同色、提示里写着线宽定义（雪、墨各截一张）；「⋯ → 重命名」就地改名，页眉、边栏、树图、`chat.list` 同时变；删中间的 A（框里写层数与改挂去处），C/B 改挂到 P、D 仍属 B、无孤列；读着 B 删 B，转到父亲；读着根删根，第一个孩子被提升、读者跟过去、线宽随之重算（雪、墨各截一张）。标题重复的对话会先在拷贝里改一个唯一的名字再用。截图写到 `qa/results/branch-manage/`。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `segment-summary-acceptance.mjs` | 分支段总结的验收（web 账本 §133、host §108）：自起宿主，端口 **8806**（启动前断言空闲，拒绝 8787），CDP **9371**，数据目录用拷贝并**删掉拷贝里的 `connections.json` / `connections.key`**，宿主首启把指向脚本自带的本地 mock 的启动环境导入为唯一供应商——**不花钱**；mock 对总结请求答一句由所发楼层（条数、首尾几个字）拼成的话，所以卡片显示错段会一眼看出。在黑兽上用界面「分支」从第 20 层建一条分支并写两层；真实鼠标悬停折叠行与列上的段；「总结这一段」、「总结所有分支段」（确认框段数、逐段、之后禁用）；三段对话读同一份列表、共同前缀只一条；编辑一层看过期、「重新总结」；读用量份额、请求体与页面发出的 RPC 次数。截图写到 `qa/results/segment-summary/`（雪、墨）。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `stream-resync-acceptance.mjs` | 回复卡在半句、光标一直闪的验收（web 账本 §124、host §101、rpc-host §3）：自起宿主，端口从 **8791** 往上取第一个空的（启动前断言），CDP **9357**，同样的数据目录拷贝口径。**不花钱**——自带一个**假的 OpenAI 兼容流式端点**（Node http，SSE `data:` 分块、可配块数与间隔、`[DONE]` 收尾），经产品自己的 `connection.save` / `connection.activate` 指过去，不碰 `connections.json`。流的内容是拷贝里 黑兽 对话末楼那条真回复（不打印），在 `<UpdateVariable>` 前插一个结尾标记。页面侧用 init 脚本包住 `/iris/events` 的 `WebSocket`：在页面**自己处理完第 N 个 delta 时**断开 / 静音（按事件顺序，不受主线程忙不忙影响），并能拒绝重连；另挂一个 100 ms 计时器记主线程停顿。判据层：屏幕（`.iris-caret`、`.iris-composer__send--stop`、末楼文本里有没有标记）+ 一条独立观察套接字读宿主自己的 `stream.*` + `debug.reports` 增量 + 宿主日志里的 `event socket: dropped…`。场景 a 对照 / b 断档跨过结尾 / c 套接字静默不关 / d 断档在流中间合上；`EXPECT=stuck` 把 b、c 翻成「窗口末仍卡住」，是修前的红；`ONLY=e E_REPEAT=N` 是**不做人为断档**的连续 N 轮（`DECLINE_SCRIPTS=1` 先拒绝卡脚本），用来量停顿。观察窗口：宿主落定后 b 15 s、c 26 s（看门狗 20 s + 余量）、a/d 8 s、e 120 s；每条读数带 `observedAtMs`，时刻相对发送。硬失败 1 = 有检查未过、2 = 端口/数据目录问题、3 = 硬超时 |
| `stream-perf-acceptance.mjs` | 流式每个 delta 花多少、回复会不会卡住（web 账本 §131）：自起宿主，端口默认 **8801**（启动前断言空闲），CDP **9371**，数据目录拷贝口径同上；自带假的 OpenAI 兼容流式端点（默认每 50 ms 一块），内容是 黑兽 末楼真回复重复到块数。页面侧三件仪器在任何页面脚本之前装好：`__REACT_DEVTOOLS_GLOBAL_HOOK__` 桩数每次 React 提交里真正执行的组件，按所在行归到流式行 / 非流式行 / 输入框 / 其他，并记重渲的起点组件；CDP 采样剖析；iframe 增删与每个帧发来的消息（按楼、按类型、拒绝的主机与指令）。`MODE=perf`（默认 3 轮 × 120 块）先量一段不流的对照（`IDLE_MS`，默认 8 s；`IDLE_MS=1` 复现「打开对话后几秒内就开始流」）；`MODE=stall`（默认 6 轮 × 400 块、`TABS=3`；`DROP=1` 每轮在标签页 0 处理到三分之一时从页面侧断开并立即放行重连）按标签页记宿主 `stream.end` 之后多久落定、主线程最长空档、套接字日志，`SETTLE_BOUND_MS` 内没落定判失败。组件名要不压缩的构建（`npx vite build --minify false`），压缩构建下按行的归类仍成立。读数写 `qa/results/stream-perf/<LABEL>-<MODE>.json` 与每轮 `.cpuprofile` |

> **CDP 端口已经统一走 `qa/cdp-port.mjs` 的 `cdpPort()`。** 上表那批脚本、`z1-e2e.mjs`、
> `z1-regression.mjs` 以及 `verify-click-shift` / `verify-widescreen` 全部按同一公式算端口,
> `z1-e2e.mjs` 原先写死 9343 不加偏移的陷阱随之关闭(仓库里 grep 不到第二份偏移公式)。

---

## 哪些脚本会硬失败(退出码非零)

| 脚本 | 退出码 |
|---|---|
| `measure-frame-fit.mjs` | **1** = 解析到的卡数低于下界,或某张卡一格都没量到;**2** = 宿主没答(与「量得不够」分开,不必读日志就能分辨);3 = 硬超时 |
| `multibook-acceptance.mjs` / `persona-acceptance.mjs` / `character-ops-acceptance.mjs` / `i18n-check.mjs` / `r-cards-check.mjs` / `verify-click-shift.mjs` / `verify-widescreen.mjs` / `authoring-row-acceptance.mjs` / `quote-colour-acceptance.mjs` / `quote-stability.mjs` / `doctor-acceptance.mjs` / `stream-resync-acceptance.mjs` / `stream-perf-acceptance.mjs` / `ejs-builtin-acceptance.mjs` | 1 = 有检查未过 |
| `qa-card.mjs` / `render-only.mjs` / `bare-html-check.mjs` / `notice-center-baseline.mjs` / `import-cards.mjs` | **不判 PASS/FAIL** —— 它们产读数,判读由人做 |

`measure-frame-fit` 的下界断言有**两条**,缺一条都能被绕过:第一条问「解析到几张卡」
(**0 也是一个完全瞎掉的解析器会给的答案**,所以要有阳性对照),第二条问「解析到的每张是不是
真被量了」(单独用是**空集上的全称量词,恒真**)。**帧数不进门禁**——一格里有没有帧是读数,
不是门禁。
