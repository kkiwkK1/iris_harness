# 卡脚本自动运行 — 策略

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。数字与路径以该提交为证据；行号会漂移，符号名不会。
>
> 上一版写在接线之前，全文是「接线前必须成立的条款」。**这些条款已经接线**：
> 同意门、按卡记忆、运行时刻重解析、运行态面板都在 `main` 上。本版改成现状描述，
> 每一条后面记它今天落在哪个符号上；仍未做的单独标出。

把卡片脚本从 dev 面板的按钮挪进"开聊天"的路径,曾是这个项目最后一个大件。
它的全部危险浓缩在 [notes/apps/iris-web/GRANTS.md](../notes/apps/iris-web/GRANTS.md) 开头那句:

> 今天卡片会跑,是因为有人打开面板按了按钮——关于权限的错误答案,是当着它
> 涉及的那个人的面给出的。自动运行把这个决定挪到没人在看的时刻。
> **每一条陷阱在脚本自己启动的那天都变得更安静,而不是更响。**

本页是这条路径今天成立的条款。GRANTS.md 是它的证据层;两份文件一起改。

## 一、同意门:按卡记忆的首次询问

**自动运行不是无条件的。** 一张带脚本的卡第一次被打开聊天时,Iris 询问一次:

> 这张卡带 N 个脚本(合计 X KB)。在隔离沙箱中运行它们吗?
> [查看清单] [运行] [不运行]

- 决定**按卡记忆**在 `ScriptPolicyStore`(`scriptsAllowed?: boolean`,
  `packages/iris-app-service/src/scripts.ts`),与文档/网络授权同一张权限表、
  同一套生命周期——**删卡即遗忘,id 复用不继承**(GRANTS §1/§2)。契约侧是
  `script.list` 带出的 `scriptsAllowed?` 与 `script.setScriptsAllowed`。
- **没有"总是允许所有卡"的全局开关。** 那会把按卡模型整个短路,而按卡询问正是
  上游用户已有的心智模型(实测:用户在 ST 里逐张批准了 15 张卡的正则)。
  今天仍然如此:全树没有任何 `allowAllCards` / `alwaysAllow` 形状的开关。
- **三态,不是布尔。** `scriptsAllowed` 缺席 = 没问过,`false` = 问过且拒绝,
  `true` = 允许;`consentState` / `shouldAsk`(`apps/iris-web/src/sandbox/consent.ts`)
  只在"没问过"时发问。把缺席折叠成 `false` 会把"还没问"读成"已拒绝",
  而那正是这个门唯一不能犯的错。
- 询问界面按后果措辞,沿用文档授权的先例;**卡不能触发、加速或预填这个询问**。
- **问句放在读者面前,不在抽屉里。** 它是 `ConsentAsk`
  (`apps/iris-web/src/app/ConsentAsk.tsx`),浮在对话之上、非模态、无计时器。
  第一版只活在设置面板里,而那个面板默认关闭并在关闭时 `aria-hidden`——
  于是"问过了"与"没人看得见"长得一模一样。
- 回答"不运行"后,脚本面板仍列出全部脚本(可见性不随允许而变),入口文案指向
  重新开启的位置。

为什么不是"默认就跑"(上游行为):沙箱默认没收了文档与网络,**但运行本身消耗
资源、执行作者代码、并可经既有授权组合放大**。EJS 的先例已立:"跑卡片作者的
JavaScript"的默认答案必须来自部署方或用户,不来自卡的存在。为什么不是"默认
永不跑":那是把功能做成摆设,拒绝了 14/19 真实卡片的正常工作方式。首次询问 +
按卡记忆是两者之间唯一诚实的点。

## 二、授权在运行时刻从宿主重新解析(GRANTS §1)

frame 创建的那一刻,授权**从宿主现问**,不读任何以 characterId 为键的浏览器
缓存。开聊天就是一次主体变更(GRANTS §2):切聊天、切卡、删卡后重开,都触发
重新解析。

**三个里只有两个在契约上,这点要说清楚。** `documentGranted` 与 `scriptsAllowed`
由 `script.list` 带出、由 `script.setDocumentGrant` / `script.setScriptsAllowed`
写入;`networkGranted` **不在契约里**——两条真实运行路径
(`apps/iris-web/src/app/useCardScripts.tsx`、`MessageInterfaces.tsx`)都把它
硬编码为 `false`,唯一能翻它的是 dev 探针面板
(`apps/iris-web/src/dev/SandboxProbe.tsx`,其注释写明"Dev-only until
`networkGranted` reaches the contract")。所以今天卡片的出站 fetch 一律被 CSP
拒绝并点名上报,那是**既定行为而不是缺口**;网络授权的策略见
[SANDBOX.md](SANDBOX.md),但它描述的是机制,不是一个用户今天能按的开关。

**组合需要一个主人**:`删卡 → 重导同名卡 → 开聊天` 这条路径要有一条跨越两个
信任域的端到端检查——两半各自的测试永远绿,漏洞恰好住在缝上。**这条检查已经
存在**:`apps/iris/tests/rpc-transport.test.ts` 走真实磁盘、真实 policy store、
真实线协议,所以让 id 复用发生的那一步是真的发生的。

## 三、失败出现在哪(GRANTS §4)

自动运行的脚本没有探针面板,所以策略指定失败的着陆点:

1. **脚本面板显示真实运行态**,即探针结局行的语义原样搬家。
   "2 of 2 enabled" 和 "2 of 2 running" 之间的差别,就是用户打开面板要问的
   全部问题。词表今天是九个相(`ScriptRunPhase`,
   `apps/iris-web/src/sandbox/script-run-state.ts`),比本页初稿列的五个多四个,
   而多出来的四个各自堵一种"看起来在工作"的沉默:

   | 相 | 含义 |
   |---|---|
   | `dispatched` | 要过了,frame 还不存在——**不是** `running`,叫它 running 就是声称一段代码开始了而它从未被到达 |
   | `running` | frame 答了 `ready`,body 已投出 |
   | `ran` | body 求值完毕。**不是**"卡干完活了":注册监听后返回的卡,真正的活从生成时刻才开始 |
   | `waiting` | 卡在等兄弟脚本发布某个全局。单列一相,因为这是**没有声音的那种失败**——抛错的会说话,等一个永不到来的 provider 的看起来像在工作 |
   | `refused` | 沙箱拒了一个成员(带 `member`) |
   | `threw` | body 抛了(带 `detail`) |
   | `bootstrap-failed` | frame 根本没起来 |
   | `silent` | 起来了,静默到静默本身成为结论 |
   | `killed` | 聊天走了,还没跑完就被拆了 |
2. **拒绝与错误进通知条**,沿用传输失败的先例:点名脚本、点名成员/主机、指向
   能放行它的授权。**拒绝必须盖过卡的 fallback**(既定裁决,机制已建)。
3. **失败的卡不能把对话带走**:frame 崩溃、悬死、被杀,聊天照常可读可写。
   脚本是聊天的增强,不是聊天的前提。
4. **授权提示不在运行路径上**:缺授权的卡得到的是面板里一行"未授权,在此开启",
   不是挡在对话前的模态框。

## 四、运行时机与生命周期

- **时机**:聊天视图就绪之后、异步启动;绝不阻塞消息渲染或首字节。
- **每聊天一个 frame 集合**,`ready → context → run` 沿用已验证的序;脚本按
  卡内顺序启动,一个脚本的失败不阻止下一个(探针语义)。
- **切走/关聊天即完整回收**(Cordis 不变量)。frame 生命周期挂在"这个聊天
  在前台",与消息内渲染 frame 的"这条消息在显示"同构——后者写这页时是未来件,
  今天是 `MessageInterfaces`(`apps/iris-web/src/app/MessageInterfaces.tsx`),
  同构关系成立而不再是预期。
- ~~文案与接线**同一次改动落地**(GRANTS §3):面板那句"Scripts do not run on
  their own yet"在接线提交里改回,不提前不滞后。~~ 已完成——那句话在全树已无
  出现(`grep -rn "do not run on their own" apps/iris-web/src` 为空)。

## 五、明确不在本页范围

- ~~**消息内卡片 UI 管线**(`TH-render` frame、代码块变面板)——独立立项。~~
  已独立落地,见 `apps/iris-web/src/app/MessageInterfaces.tsx` 与
  [notes/apps/iris-web/RENDER.md](../notes/apps/iris-web/RENDER.md);仍不由本页管。
- 模板(`IRIS_TEMPLATES`)的默认值不因本页改变——两个开关正交:模板是宿主侧
  求值(`apps/iris/cordis.yml` 的 `templates: IRIS_TEMPLATES === '1'`,默认关),
  本页管浏览器侧 frame。
- 事件拦截型钩子(`CHAT_COMPLETION_SETTINGS_READY` 一类)仍按"宁可缺,不能错发"
  留空,见 [GENERATION-HOOKS.md](GENERATION-HOOKS.md)。

## 分工(已交付,留作记录)

四块全部落地。留下这张表是因为它记的是**谁出的哪一半**,而接缝上的缺陷正是
两半各自都绿时才出现的那种。

| 块 | 归属 | 今天落在 |
|---|---|---|
| `scriptsAllowed` 进 `ScriptPolicyStore` + 契约(`script.list` 带出;`script.setScriptsAllowed`) | 72 | `packages/iris-app-service/src/scripts.ts`、`packages/iris-protocol/src/rpc.ts` |
| 首次询问 UI、运行态面板、失败着陆(通知条/结局行语义搬家) | f7 | `ConsentAsk.tsx`、`ScriptPanel.tsx`、`sandbox/script-run-state.ts` |
| frame 集合生命周期挂聊天前台、运行时刻重新解析授权 | f7 | `apps/iris-web/src/sandbox/runner.ts`、`frame.ts` |
| 跨信任域端到端检查(删卡→重导→开聊天) | 72 出宿主半,f7 出浏览器半,接缝测试放 `apps/iris` | `apps/iris/tests/rpc-transport.test.ts` |
