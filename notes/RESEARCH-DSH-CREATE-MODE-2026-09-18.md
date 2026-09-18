# RESEARCH — deepseek-harness 「创造模式」：一句话长出一个插件，是怎么做到的

> 状态：记录。测量于 2026-09-18，对象是本机 `.reference/deepseek-harness/` 这份只读参照检出（该目录被 `.gitignore` 排除，不在本仓库树上，所以本文引用它一律写全前缀、不带行号——`apps/iris/tests/md-references.test.ts` 的 `路径:行号` 扫描按顶层目录名判定归属，`.reference` 不是本树的顶层目录，写行号会让那条检查失去意义而不是变严）。
>
> 记录描述那一天的 dsh，不描述今天的 Iris。Iris 侧的设计结论在 [docs/SANDBOX-PLUGINS.md](../docs/SANDBOX-PLUGINS.md)，本文只承担它的**输入**：dsh 到底做了什么、哪些部件的思路可以搬、哪些部件的前提在 Iris 里不成立。
>
> **许可与抄写边界**：deepseek-harness 是 MIT。本文引用的是**做法与理由**，不是可以复制进本仓库的代码；下面每一处路径都写成「这个想法住在哪」，不是「从这里拷过来」。LoomStudio 的代码在任何情况下都不得抄写（既有裁决，见 [LICENSE-INVENTORY.md](LICENSE-INVENTORY.md)）。

---

## 一、一句话说清 dsh 的创造模式

用户在对话里切到一个叫 **创造模式** 的 agent preset，用自然语言说「给我加个 X」；模型调一组工具把一个 **Cordis 插件**定义出来、跑起来、必要时改掉或删掉。插件不是文件，是进程内存里的一条记录；它挂载走的是**静态插件走的同一套装载机**，所以「动态」的只是来源，不是机制。

这正是 Iris 想要的那种 **成就感**：一边玩一边让作品长出功能，而且长出来的东西和本来就有的东西同构。

---

## 二、模式本身：一个 preset 加一个工具包

| 部件 | 住在哪（`.reference/deepseek-harness/` 下） | 是什么 |
| --- | --- | --- |
| 模式定义 | `packages/preset/agent-presets/presets/cordis/preset.yml` | agent preset「创造模式」 |
| 组合 | `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` | 在基础 agent 上加载 `tool-cordis` |
| 机器 | `packages/extensions/` 下四个包 | `tool-cordis`（模型工具）、`cordis-host-runner`（宿主半）、`cordis-client-runner`（浏览器半）、`ui-cordis`（界面） |

`packages/extensions/README.md` 把整件事写成一句话：模型可以**查看当前 DSH 进程里装着哪些插件和服务，定义一个动态 Cordis 包（宿主半、浏览器半，或两者都有），运行它、停掉它、删掉它**。`tool-cordis` 一共给模型七个工具。

**对 Iris 的第一条读数**：模式不是一个新的运行时，而是「一个 preset ＋ 一组工具 ＋ 一个能热装的装载机」。三样里 Iris 已经有第三样的雏形（帧侧成员表与库装载），缺的是前两样，而前两样在 Iris 里不该是 preset——见 §十二。

---

## 三、模型被教了什么

两份文档，一份短一份长：

- `packages/extensions/tool-cordis/src/prompt.ts` —— 注入给模型的工具说明，也是**确认语义**的出处（见 §八）。
- `packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md` —— 420 行的技能文档，教模型怎么写一个 Cordis 插件。

SKILL.md 里最值得抄的一句是**克制**的那句：

> Do not propose a Client/browser UI when the task does not need visible page behavior.

也就是说，能力面越宽，越要在**提示词**里把默认值收窄。这是一条比任何运行时闸门都便宜的控制，而且它是唯一能约束「模型多写了一堆没人要的东西」的控制——运行时拦不住「合法但多余」。

---

## 四、产物不是文件

`cordis_define` 记录的是一个对象，不是往磁盘写一个包（形状见 `.reference/deepseek-harness/docs/tool-catalog.md`）：

```
{ plugin: { kind: 'new', idPrefix }, name, purpose, code: { host?, client? } }
```

`host` 与 `client` 各自是**一段纯 JavaScript 函数体，返回一个 Cordis Plugin**；文档明说：不是 TypeScript、不是 JSX、不做任何 import 变换。

三条读数：

1. **没有构建步骤**，所以也没有构建失败这种状态——代价是模型不能用 TS/JSX，得在提示词里讲清楚。
2. **`purpose` 是记录的一等字段**，不是注释。确认卡要显示的东西，在产物形状里就有位置。
3. **`idPrefix` 而不是 `id`**：id 由宿主铸造，模型只提供前缀。这一条 Iris 必须照搬——让模型自己起 id，等于让不可信的一方选择命名空间。

存储：**没有**。`packages/extensions/cordis-host-runner/README.md` 写得很直白——定义只活在进程内存里，DSH 一重启就全没了。这是 dsh 与 Iris 的**第一个根本分歧**：Iris 的整个卖点是「这段对话长出来的东西下次打开还在」。

---

## 五、校验：两道，位置不同

- **定义期语法预检**：`cordis_define` 收到代码时，用**和真正运行时同一个包装器**编译一遍（`.reference/deepseek-harness/packages/extensions/cordis-host-runner/src/sandbox.ts`）。「同一个包装器」是这条的全部价值：预检与执行用两套包装，预检过了执行仍可能语法错，那这道检查只是让人安心。
- **注册期 guard**：`.reference/deepseek-harness/packages/extensions/cordis-host-runner/src/guard.ts` 与 `.reference/deepseek-harness/packages/extensions/cordis-client-runner/src/client/guard.ts`，README 的原词是 **a whitelist**——插件能调的 ctx 动词是白名单，不在名单上的动词不给。

**对 Iris 的读数**：两道都保留，但它们在 dsh 里是「给诚实代码的防护栏」，在 Iris 里必须是**真边界**（§十一）。区别不在这两道检查的写法，在它们外面还有没有一层浏览器强制的隔离。

---

## 六、不重启就挂载：配方

`.reference/deepseek-harness/packages/extensions/cordis-client-runner/src/client/runtime.ts` 的挂载顺序：

```
求值闭包
  → sink.load({ id: 'dyn/<pluginId>', factory })   把它塞进模块表
  → loader.create({ name })                        让装载机像装静态包一样装它
  → fiber.await()                                  等它就绪
```

拆卸是三件事一起：`loader.remove(entryId)` ＋ 模块表失效 ＋ `styles.dispose()`。每个插件一条**串行队列**，队列收敛在一个 `pluginRunId` 上——同一个插件的 define/run/stop/remove 不会互相穿插。

README 里那句话是这整个设计的中心：**动态包骑的是静态插件骑的那台机器**（dynamic packages ride the exact machinery static plugins do）。这条决定了热卸载为什么可信：可回收性不是为动态插件新写的，是本来就有的。

---

## 七、求值器

`.reference/deepseek-harness/packages/extensions/cordis-client-runner/src/client/evaluator.ts`：

```js
new Function(...symbolNames, 'return (async () => { … })()')
```

三个细节值得记：

1. **参数遮蔽是教学陷阱，不是安全措施**。`DYNAMIC_CLIENT_REDIRECTS` 把一批环境全局做成函数参数，让模型写出的 `fetch(...)` 落到一个会说话的替身上——它的作用是**告诉模型该走哪条路**，不是拦住绕过去的代码（`Function('return this')()` 照样能拿到真全局）。Iris 的 `docs/SANDBOX.md` 早就把同一件事写下来过，措辞几乎一样：遮蔽是兼容层，不是安全层。
2. **`styles.insert(css)` 按包给样式打 `data-dyn` 标签**，卸载时按标签清。这正是「样式注入必须可撤销」的最小实现。
3. **`host.call(method, args)` 是 Client→Host 的 JSON-only 通道**，每个包一张自己的 handler 表。注意方向：浏览器半边主动喊宿主半边，宿主半边按包隔离地应答。

---

## 八、确认挂载：dsh 自己的同意门

`.reference/deepseek-harness/packages/extensions/tool-cordis/src/prompt.ts` 里写着：

- `cordis_run` 对**带浏览器半边**的包返回 `awaiting-approval`，等人点；
- **一个勾**只授权当前这一版；
- **两个勾**授权这个包**将来的版本**。

**宿主半边不问**，直接激活。这是 dsh 自己承认的取舍，而不是疏漏——因为它的信任前提是「整个会话等同 shell 访问」（`agent.cordis.yml` 原话：Treat a session on this preset as shell access），宿主半边本来就无所谓。`packages/extensions/tool-cordis/README.md` 把这层意思写成一句可以直接引用的话：

> The sandbox is containment for honest code, not a security boundary.

Iris 抄的是**单勾/双勾这个语义**，不抄「宿主半边免问」这个结论——因为 Iris 根本不给沙箱插件宿主半边（§十二）。

---

## 九、插槽与组合

`.reference/deepseek-harness/.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md` 记的是四种插槽：**single / keyed / list / chain**。

`chain` 是最有意思的一种：**条目自荐，第一个匹配的渲染**，匹配由一个纯函数 `select(owner)` 决定。文档里那句「a new takeover package registers with zero owner edits」是这个机制的全部卖点——接管者不需要改被接管的那一方。

配置层的开关是 `cordis.yml` 的行（`.reference/deepseek-harness/docs/cordis-tutorial/06-composition-and-hmr.md`）：`disabled: true` 卸载但不删除。一个「停用 ≠ 删除」的现成模型。

`.reference/deepseek-harness/packages/extensions/cordis-client-runner/README.md` 另有一句要记下来的限制：**Slot admission has no carrier**——插槽准入没有载体，也就是说「谁被允许往插槽里塞东西」这件事，在 dsh 的插槽系统里没有一个可以检查的凭据。这是 Iris 必须补的那一格。

---

## 十、热重载：三条互不相同的路

| 路 | 机制 | 单位 |
| --- | --- | --- |
| Node 静态 | `.reference/deepseek-harness/vendor/hmr`（chokidar 监视、`loadCache`、`loader.exit()`） | 文件变化 |
| 浏览器静态 | `.reference/deepseek-harness/packages/client/hmr` | 一个 loader entry / 一个 fiber |
| 浏览器动态 | `runtime.ts::teardown`（§六） | 一个动态包 |

浏览器静态那条的口径写得很准：**fresh fiber, fresh components, React state lost, data layer untouched**。「重载会丢什么」被写成产品事实而不是实现细节——沙箱插件的重挂载也该这么写。

---

## 十一、安全姿态：dsh 的前提，逐条

dsh 的插件是**可信的、同进程的**。它的控制清单：

1. `node:vm` ＋ `vmTimeoutMs`（宿主半边）；
2. `CTX_VERBS` 白名单，服务读取还要 inject 门；
3. **确认挂载，只对浏览器半边**；
4. 定义只活在会话里。

四条里有三条在 Iris 不成立或不够用：

- `node:vm` 是 Node 的东西，浏览器里没有；Iris 的沙箱插件**根本不进宿主进程**，这一条不是「换个实现」，是「不需要」。
- 白名单在 dsh 是护栏，在 Iris 必须是**边界外的一层**——真正的边界是那个不透明源 iframe（`docs/SANDBOX.md`），白名单只是它里面的第二道。
- 「会话内」在 Iris 要改成「按对话持久」，这是 owner 的裁决，也是这个功能存在的理由。

---

## 十二、映射到 Iris

### 12.1 能搬的（思路，不是代码）

| dsh 的部件 | 在 Iris 里落到哪 |
| --- | --- |
| 求值器（`new Function(...names, body)` ＋ 参数遮蔽） | 帧内求值器。Iris 的帧已经在 `new Function`／`eval` 上跑卡片代码（`docs/SANDBOX.md`「The code is compiled, and it evals」），多一个受控求值点不新增能力等级 |
| 挂载/拆卸配方（load → create → await；remove ＋ invalidate ＋ styles.dispose） | 帧内 mini 树的挂载顺序；`styles.dispose()` 对应「按插件打标签的 `<style>`，卸载即清」 |
| guard 门面（白名单动词） | 三件能力的受控门面：样式注入、面板槽、既有 `register*` |
| 插槽 register ＋ chain ＋ `styles.insert` | 一个帧内面板槽（Iris 第一阶段只要 list，不要 chain） |
| `cordis_define` 的记录形状（`purpose` 是一等字段、id 由宿主铸造） | 沙箱插件记录的形状与确认卡要显示的字段 |
| 单勾／双勾 | 确认卡的两种授权强度 |
| `disabled: true` 卸载但不删 | 「这个对话长了什么」列表里的启用/停用 |
| 「重载会丢什么」被写成产品事实 | 重挂载语义要写进文档，不是留给实现 |

Cordis 核心与 `@deepseek-ai/cordis-plugin-loader` **本来就能在浏览器里跑**（dsh 的浏览器半边就是证据），所以「帧内一棵 mini 树」不是从零发明。

### 12.2 假设 Node / 假设可信，搬不过来的

| dsh 的部件 | 为什么搬不过来 |
| --- | --- |
| `node:vm` 沙箱 ＋ `vmTimeoutMs` | 浏览器没有；Iris 的沙箱插件没有宿主半边，这一格是空的而不是待补的 |
| `vendor/hmr`（chokidar 文件监视） | 沙箱插件没有文件 |
| `dsh-client-modules` 同源 bundle 下发 | Iris 的卡帧是 `srcdoc`，**没有 URL 可取**：插件源必须经 postMessage 推进去 |
| 「guard 是给诚实代码的护栏」这个姿态 | 在 Iris 里 guard 必须是真边界之内的第二道；真边界是 iframe，唯一的门是帧→壳消息通道 |
| 「宿主半边免确认」 | dsh 自己的缺口（它的信任前提使它无害）。Iris 不能继承它，因为 Iris 的插件代码是模型写的、且要跑在玩家的卡里 |
| 「定义只活在进程内存」 | 与 owner 裁决 2（按对话持久）相反 |
| 全局一个「创造」面板 | dsh 的确认是帧全局的；Iris 要**按卡**、由**壳层**渲染确认卡，永远不在不可信的帧里 |

### 12.3 由此产生的三条设计约束

1. **源经 postMessage 进帧**，不经 URL——`srcdoc` 没有可取的地址，这一条不是偏好。
2. **确认卡是壳层组件**，与 `ConsentAsk`（`apps/iris-web/src/app/ConsentAsk.tsx`）同一族：非模态、无计时器、卡不能触发也不能预填。
3. **插槽准入要有载体**——dsh 明说它没有（§九）。Iris 的帧侧成员表已经有一个现成的模型：`registerPluginMembers` 按「bootstrap 公布的准入记录」判定，没有记录读作「什么都没准入」（`docs/INFRASTRUCTURE-INTERFACES.md` §5「登记闸门」）。沙箱插件的注册面照这个形状做，而不是照 dsh 的插槽做。

---

## 十三、这份记录不回答什么

- 不回答 Iris 该怎么实现——那是 [docs/SANDBOX-PLUGINS.md](../docs/SANDBOX-PLUGINS.md) 的事，本文只是它的输入之一。
- 不给 dsh 的代码行号：这是一份**只读参照检出**，不在本仓库的树上，行号在下次同步时会漂移而没有任何检查会发现。符号名与文件名才是定位手段。
- 不评价 dsh 的选择好坏：它的信任前提（会话等同 shell 访问）与 Iris 的（卡片不可信、模型写的代码不可信）不同，同一个决定在两边的分数不可比。
