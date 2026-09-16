# 台账「重开条件」巡检（REVIEW-1）

> 状态：记录。写于 2026-09-17，基线 `main` `e668785`。依据 `notes/tasks/REVIEW-1-LEDGER-REOPEN-SWEEP.md`。原文一字未改；条件已成立的节末追加「复查」行。

## 判据

- **成立**：指出证据（PR / 合入 commit / 台账某节 / 语料某张卡）。条件成立 ≠ 决定已改，两者在「证据」列里分开写。
- **未成立**：截至 e668785 未见。
- **判不了**：条件依赖一次没人做过的测量，写明缺哪一步。**不猜。**
- 「已重看」指该节（或同事实的另一节）已有记录决定是否跟着变的段落或追加行。
- 一句 = 一个「What would overturn/reopen」段（含 `###` 标题式与句中式）。基线处共 **160** 句。表按手册 §1 的建议从新往旧（host §88 → §1，web §104 → §1）。第 7 本（根 `notes/DEVIATIONS.md`）**0** 句——它是任务记录集，不含这个格式；手册粗计它 2 句属别的措辞，未计入。

## 手册 §4 五条已知命中的裁决（两条前提有误）

| 手册原话 | 实况 |
| --- | --- |
| host §76 → U2 改结算入口 | **前提有误**。§76 末尾是 `**Held by** …`，**没有**重开句。手册引的「结算处写死两个 pluginId」在 `notes/PLUGIN-FEASIBILITY.md:142`，不在 §76。§76 记录的决定确被 U2（#103，§82）改线，但**无句可追加**。 |
| host §80 决策 8 → U6 关闭 | **成立**。§80 决策 8 正文写了「Closed by §85 (U6)」，重开项 (b) 也早就地划掉「retired by §85」。 |
| web §97 → U6 件 3 改了资产列三格 | **未成立**。§97 的重开条件有两个：「宿主给出 per-plugin status 的路由（第五个 manifest 字段或 `plugin.assetStatus` RPC）」与「真实插件间接注册并冲突」。U6 件 3（§102）加的是浏览器侧第三格，既没有新增宿主路由，也没有间接注册的卡。§97 已就地指向 §102。 |
| web §99 → U1 推翻裁决 2 | **成立**。U1（#106，§100）实现 `plugin.update`，§99 自己安排了那次退役。 |
| host §79/§80 的 `PLUGIN_PERMISSIONS`「只是声明不是边界」 | **§80 无此语**，该句只在 §79（`It is a declaration, not a boundary`）。U3（#104，§83）让 `plugin-storage` 成为第一条有后果的规则，并让 scope 长出 `storage`——§79 重开项 (b) 成立。 |

## 清单

| # | 台账 | 节 | 条件复述 | 结论 | 证据 / 缺哪一步 | 已重看 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | app-service | §88 | (a) A second message list — the driver's `squashSystemRuns` merges messages and `layoutOf` records the wire, both *after | 未成立 | 截至 e668785 未见 | — |
| 2 | app-service | §87 | (a) A second path that assembles a request without `@iris/app-service/prompt.ts` — the ST-compat bridge's expansion muta | 未成立 | 截至 e668785 未见 | — |
| 3 | app-service | §86 | (a) A real constant-factor regression someone wants a witness for — that is a benchmark suite, not this file. (b) A seco | 未成立 | 截至 e668785 未见 | — |
| 4 | app-service | §85 | (a) A second consumer building git sources outside the installer, at which point "userinfo is refused" belongs in the pa | 未成立 | 截至 e668785 未见 | — |
| 5 | app-service | §84 | A third language (the manifest shape, the parsers' `['en','zh']` pairs, and `PLUGIN_COPY_LANGUAGES` all change together, | 成立 | #106 / host §81 建了 `plugin.update`。决定**部分**跟上：`#replaceRow` 不重发 i18n 文案，下次启动的 `scanInstalled` 才补齐，见待办 | 否 |
| 6 | app-service | §83 | D1 No stable stringify. `JSON.stringify(value, null, 2) + '\n'`, matching `CardStorageStore` and `ScriptVariableStore` | 未成立 | 截至 e668785 未见 | — |
| 7 | app-service | §80 | (a) A second consumer of `Installer.stage`/`promote`, at which point the `StagedInstall` handle's in-memory-only lifetim | 成立 | (c) #106 / host §81：U1 把 plugin.update 做成真实事务；(b) 更早已就地划掉（§85） | 是 |
| 8 | app-service | §79 | (a) A third artifact format, at which point `ArtifactContract` should probably gain the describer half it does not have | 成立 | (b) #104 / §83：scope.storage 与 PLUGIN_PERMISSIONS 的 plugin-storage 同批落地；(c) #91：pack:contracts 让契约包可发布 | 是 |
| 9 | app-service | §77 | a need to switch exhaustively over builtin ids or to give one builtin id its own protocol surface — at which point the c | 未成立 | 截至 e668785 未见 | — |
| 10 | app-service | §75 | A DPAPI (or Keychain, or libsecret) binding in Node with no spawn: the protector interface is where it would land, o | 未成立 | 截至 e668785 未见 | — |
| 11 | app-service | §74 | A header hook on the static package closes the first gap and makes the click-jacking guard redundant. A card frame that | 未成立 | 截至 e668785 未见 | — |
| 12 | app-service | §73 | A book whose `order` exceeds 10⁹ or whose `depth` exceeds 10⁵ — both an order of magnitude past anything measured, and b | 未成立 | 截至 e668785 未见 | — |
| 13 | app-service | §72 | a `stream.error` that can carry a view, or a separate non-terminal frame for "the reply is here and unsaved", would let | 未成立 | 截至 e668785 未见 | — |
| 14 | app-service | §71 | The lock. A measurement that two hosts on one data directory are safe — which would mean every store here had stopped | 判不了 | 需要多进程共用一目录/只读镜像的部署实测 | — |
| 15 | app-service | §69 | A card population that fetches allow-listed URLs through `script.fetch` — the `$('body').load` family becoming bridged w | 未成立 | 截至 e668785 未见 | — |
| 16 | app-service | §68 | A measured cost of the retry loop on a loaded host (it holds the save open for up to half a second before failing). A pl | 判不了 | 需要在负载机上测重试循环的代价 | — |
| 17 | app-service | §67 | A ruling that Iris should model `swipe_info`, which would let every reading keep its timer and would make the second dep | 判不了 | 需要一份整窗速率被代理主导的供应商族群实测 | — |
| 18 | app-service | §66 | A measured card that expects a delete to clear its own chat binding — the report would then be the wrong instrument and | 未成立 | 截至 e668785 未见 | — |
| 19 | app-service | §65 | A card that renames onto a taken name and depends on upstream's deletion (nothing in the corpus renames anything); a pre | 判不了 | 需要一份大到让 per-snapshot list() 可见（对 1.75 s）的预设库 | — |
| 20 | app-service | §64 | A measured card reading another character's tier — the narrowed scope would then be a compatibility break rather than a | 未成立 | 截至 e668785 未见 | — |
| 21 | app-service | §63 | A card that legitimately needs a neighbouring card's data or another character's conversations would put the per-card gr | 未成立 | 截至 e668785 未见 | — |
| 22 | app-service | §62 | SillyTavern growing a manual order of its own — the file format and the key would then be an interoperability question r | 未成立 | 截至 e668785 未见 | — |
| 23 | app-service | §61 | A user asking for the environment back as a selectable route (that is the ruling being reversed, and web §78 is the desi | 未成立 | 截至 e668785 未见 | — |
| 24 | app-service | §60 | A composition that hands a `hostConnection` in whose provider or model can change while the process runs — the snapshot | 未成立 | 截至 e668785 未见 | — |
| 25 | app-service | §59 | A generation that reaches `ctx.llm.stream` with a route no registration has answered for; a deletion that leaves a `prov | 未成立 | 截至 e668785 未见 | — |
| 26 | app-service | §58 | A route installed with a key the probe of the same profile would not have sent; a host key reaching an origin other than | 未成立 | 截至 e668785 未见 | — |
| 27 | app-service | §57 | A probe that reaches the endpoint and still answers `bad-url` or `bad-key`; a `bad-key` message that contains any charac | 未成立 | 截至 e668785 未见 | — |
| 28 | app-service | §56 | A SillyTavern release that stops subtracting `openai_max_tokens` from `openai_max_context` — the four citations above wo | 未成立 | 截至 e668785 未见 | — |
| 29 | app-service | §55 | A SillyTavern release whose save path rewrites unknown top-level header keys — the same thing that would overturn §51 an | 未成立 | 截至 e668785 未见 | — |
| 30 | app-service | §53 | A preset observed using its tier the way cards use theirs — to hide its own bookkeeping from the reader rather than to r | 判不了 | 需要跨一个以上预设实测「预设用自己的层向读者隐藏记账」 | — |
| 31 | app-service | §52 | a trace whose `error` disagrees with the `stream.error` the panel showed for the same turn, or an interrupted turn whose | 未成立 | 截至 e668785 未见 | — |
| 32 | app-service | §51 | A SillyTavern release whose swipe or save path rewrites unknown top-level header keys. `formatChatFile` writes the heade | 未成立 | 截至 e668785 未见 | — |
| 33 | app-service | §50 | A conversation whose depth bucket is split and whose ceiling *falls*. The shape that would do it is a bucket whose entri | 判不了 | 需要一个「拆分后上限反而下降」的 depth bucket 实测 | — |
| 34 | app-service | §43 | A `rewritten` row on any conversation. The probe prints the first differing character with 60 characters of context on e | 判不了 | 需要扫描任一会话的 trace 找 rewritten 行 | — |
| 35 | app-service | §39 | A conversation where the block's over-trim costs context the model visibly needed. The answer then is not a smaller bloc | 未成立 | 截至 e668785 未见 | — |
| 36 | app-service | §33 | A global library script observed to need one table: the change is a reserved partition in `script-variables.json` plus a | 未成立 | 截至 e668785 未见 | — |
| 37 | app-service | §32 | A user asking to share a card *with* their scripts, which would be an export decision (a card export that folds the repo | 未成立 | 截至 e668785 未见 | — |
| 38 | app-service | §31 | A decision that Iris should write cards back at all, at which point this becomes one field of a larger question rather t | 未成立 | 截至 e668785 未见 | — |
| 39 | app-service | §30 | A card observed using its own regex tier to hide something from the reader rather than from the model — an instruction r | 未成立 | 截至 e668785 未见 | — |
| 40 | app-service | §29 | A measurement showing the summarization call routinely produces in-character prose rather than a checkpoint, which would | 未成立 | 截至 e668785 未见 | — |
| 41 | app-service | §28 | Recording a per-message timestamp in the chat file would retire the undated fallback and its count. A profile large enou | 成立 | a99c3db / host §67：新回复行写 `gen_started`/`gen_finished`、新用量记录带 `at`。决定**部分**跟上：未带戳的旧历史仍走重建与 `undatedTurns` | 是 |
| 42 | app-service | §27 | A book large enough that ~23 KB stops being the ceiling — the shape would grow a `limit`/`cursor`, not a per-book call. | 未成立 | 截至 e668785 未见 | — |
| 43 | app-service | §26 | For (a): a provider that reports which prefix it matched, which would make the proxy unnecessary. For (b): moving the ze | 未成立 | 截至 e668785 未见 | — |
| 44 | app-service | §25 | A preset whose `main` sits deliberately at the end (a "system prompt last" layout), where "beside main" would put a card | 未成立 | 截至 e668785 未见 | — |
| 45 | app-service | §24 | A generation kind that must see the newest reply *and* replace it (a "rewrite this reply" mode would be one), which woul | 未成立 | 截至 e668785 未见 | — |
| 46 | app-service | §23 | A per-path credential model at one origin, which would make the origin check too coarse. Or an endpoint whose `/models` | 未成立 | 截至 e668785 未见 | — |
| 47 | app-service | §21 | A user who wants the two kept in step — i.e. asks for the sync this deliberately is not. The answer then is an explicit | 未成立 | 截至 e668785 未见 | — |
| 48 | app-service | §20 | Real endpoints tripping the first-byte budget on healthy long thinks — the reports would name it, and the fix is per-con | 未成立 | 截至 e668785 未见 | — |
| 49 | app-service | §19 | A preset file carrying `regex_scripts` that a user expects to fire, or a card whose scripts a user wants runnable only a | 成立 | host §47（狐神抚带 40 条 regex_scripts 的实测）+ §53（预设层与 per-preset allow-list 落地） | 是 |
| 50 | app-service | §18 | an upstream release that accepts these files at the import endpoint with a *different* presentation (say, a name from el | 未成立 | 截至 e668785 未见 | — |
| 51 | app-service | §16 | Cards colliding on keys often enough that the sharing costs more than it buys — which would be an argument for a namespa | 未成立 | 截至 e668785 未见 | — |
| 52 | app-service | §15 | A card that depends on `'latest'` writing to a system row, or on `null` meaning "the beginning" — both would show up as | 未成立 | 截至 e668785 未见 | — |
| 53 | app-service | §14 | A card that visibly depends on the two being different — or a measurement showing upstream's per-message tables actually | 未成立 | 截至 e668785 未见 | — |
| 54 | app-service | §13 | Iris growing an extension ecosystem of its own, at which point "read another extension's data" becomes a capability ques | 判不了 | 需要一次「卡读另一个插件的数据」的用例，或一条跨插件数据访问的裁定；#88 建了平台但无人这么用 | — |
| 55 | app-service | §13 | Two versions of one card in a profile: they mint one id, the second is minted `… (2)`, and from then on the ids mislead | 未成立 | 截至 e668785 未见 | — |
| 56 | app-service | §12 | Upstream moving embedded-book reading into assembly, or a measurement showing users expect a card update to overwrite th | 未成立 | 截至 e668785 未见 | — |
| 57 | app-service | §11 | Upstream partitioning keys by script, or exposing the two positions it currently hides. | 未成立 | 截至 e668785 未见 | — |
| 58 | app-service | §10 | A card that depends on injections *not* surviving a return to the same chat — it would look like text reappearing that t | 未成立 | 截至 e668785 未见 | — |
| 59 | app-service | §9 | Upstream changing the walk to consult `template`, or a card whose arrays are all undeclared and which therefore stops be | 未成立 | 截至 e668785 未见 | — |
| 60 | app-service | §8 | A measurement showing out-of-band writes are rare on some other corpus — in which case replay's fidelity there is much h | 判不了 | 需要在另一份语料上测带外写的稀有度 | — |
| 61 | app-service | §8 | A measurement showing the untrimmed growth is what users actually hit — chats large enough that the storage, not the del | 判不了 | 需要一次「未裁剪增长被用户实际撞上」的报障/语料测量 | — |
| 62 | app-service | §7 | A card that expects its rearranged panel to survive an export — or a user reporting exactly that. The reports would look | 未成立 | 截至 e668785 未见 | — |
| 63 | app-service | §6 | A card using `evalTemplate` to write somewhere it has no business writing — the reports are what would show it, and they | 未成立 | 截至 e668785 未见 | — |
| 64 | app-service | §5 | A card doing arithmetic on `characterId`, or one persisting it across sessions and expecting it to still name the same c | 未成立 | 截至 e668785 未见 | — |
| 65 | app-service | §4 | A card that reads the `message` scope without MVU present. `tests/floor-anchor.test.ts` pins the per-floor anchor, which | 未成立 | 截至 e668785 未见 | — |
| 66 | app-service | §3 | A card that listens to `VARIABLE_UPDATE_ENDED` *without* shipping the bundle — it would consume a `Mvu` some other card | 未成立 | 截至 e668785 未见 | — |
| 67 | app-service | §1 | One real card that writes player progress into `scripts[].data`. `tests/script-variables.test.ts` re-measures the corpus | 判不了 | `script-variables.test.ts` 每次跑都重测语料，但需要一个真实变化（key 出现/消失）才会红；本次无语料读数 | — |
| 68 | app-service | 「Host」 | A card that branches on `agent`'s third segment, or one that treats `pkgVersion` as "which program" rather than "which b | 未成立 | 截至 e668785 未见 | — |
| 69 | app-service | 「An injection with no `id` ca」 | Upstream fixing it, at which point this stops being a divergence and becomes agreement; or a card that depends on an un- | 未成立 | 截至 e668785 未见 | — |
| 70 | web | §104 | (a) 消息视图要显示每层的 token：对话是一条聚合行，楼层只有所属消息的成本——拆开它就 是「把 UI 的假设塞进装配器」，正是聚合行存在的原因。 (b) 宿主驱动器的 `squashSystemRuns` 在 `assemble` | 未成立 | 截至 e668785 未见 | — |
| 71 | web | §103 | (a) 面板长出「消息视图」（手册第二步）：同一块解释要跟着 part 走，届时 `Explanation` 的入参从「行」变成「part」，纯函数不变。 (b) 宏与 regex 阶段（第三步） 给 `PromptItemExplanat | 成立 | web §104（M1 第二步消息视图）。决定**部分**跟上：视图落地，但 `Explanation` 仍收 `entry`，对 part 喂合成对象 | 是 |
| 72 | web | §102 | (a) A caller wanting the manifest generation for logic rather than display — it is on the status object now, so the temp | 未成立 | 截至 e668785 未见 | — |
| 73 | web | §101 | A third interface language (the overlay is two-column by construction, same trigger as §84's); a need for plugin copy in | 未成立 | 截至 e668785 未见 | — |
| 74 | web | §100 | 更新入口长出第二个字段（例如允许换 remote）：内联表单与 `updateSystemPlugin` 的形状都要重新看，行上的「remote 从行上读」那句话也 是。 - `tampered` 的两个出口要合并：重装按钮与更 | 未成立 | 截至 e668785 未见 | — |
| 75 | web | §99 | 裁决 2 被改口（`plugin.update` 真的实现了）：那时行上会多一个更新按钮，而 `plugin-center.test.ts` 里那条 `doesNotMatch(/plugin\.update\|check for up | 成立 | #106 / host §81、web §100：plugin.update 实现，否定断言按本节自己的安排退役 | 是 |
| 76 | web | §98 | a third language, which would make any per- component table untenable anyway — the dictionaries are already the shape th | 未成立 | 截至 e668785 未见 | — |
| 77 | web | §97 | A manifest route that gains per-plugin status from the host (a fifth manifest field, or a `plugin.assetStatus` RPC) woul | 未成立 | 截至 e668785 未见 | — |
| 78 | web | §97 | if a real plugin registers indirectly and collides, the frame still refuses its members and the card sees the named repo | 未成立 | 截至 e668785 未见 | — |
| 79 | web | §95 | A card in the corpus whose link tag carries a `>` inside an attribute value — there is none. Or, more importantly, the r | 判不了 | 需要一次语料扫描找 link 标签属性值内含 > 的卡 | — |
| 80 | web | §95 | The allow-list admitting anything that is not a public CDN, or the budget policy changing from refuse-to-write to evict. | 未成立 | 截至 e668785 未见 | — |
| 81 | web | §95 | A fixed release, at which point this is a version bump rather than a decision. Or — and this is the one to watch — any s | 未成立 | 截至 e668785 未见 | — |
| 82 | web | §95 | A corpus measurement finding a real card with a non-literal `import()` specifier — the shape is a specifier built by con | 判不了 | 需要一次语料扫描找非字面 import() 说明符 | — |
| 83 | web | §94 | A corpus or a report showing a real card that needs a same-origin path this list refuses — the three Fatria GETs become | 未成立 | 截至 e668785 未见 | — |
| 84 | web | §93 | One thing, and it is nameable: a card frame's document ceasing to be `srcdoc` — served from a real same-origin URL, | 未成立 | 截至 e668785 未见 | — |
| 85 | web | §92 | A ruling that the chip should carry the decode rate instead — which is a claim that a reader cares more about the model | 未成立 | 截至 e668785 未见 | — |
| 86 | web | §91 | A measurement showing a card's markup reaching a bridged name before the bootstrap installed. Check ③ is written to se | 未成立 | 截至 e668785 未见 | — |
| 87 | web | §90 | A host arm that can write a card's `extensions.world` — the primary refusal would become a real rebind, and `rebindCharW | 未成立 | 截至 e668785 未见 | — |
| 88 | web | §89 | A corpus card that calls `getPreset` with anything but `'in_use'` (the throw becomes a gap worth closing with a preloade | 未成立 | 截至 e668785 未见 | — |
| 89 | web | §88 | A card measured calling `getTavernRegexes` without awaiting — the promise would then be a real break, and the answer wou | 未成立 | 截至 e668785 未见 | — |
| 90 | web | §87 | A card reaching for any of these five degenerate answers and needing the real behaviour — the first one to appear in a c | 未成立 | 截至 e668785 未见 | — |
| 91 | web | §86 | A bootstrap slimming pass that moves the measured frame back under 53 KiB with room to spare (the table would then get a | 成立 | 2afa1f8 / web §91：bootstrap 改为抓取，FRAME_OVERHEAD_BYTES 4 KiB、FRAME_COUNT_LIMIT 回到 20 | 是 |
| 92 | web | §85 | The preset library landing with a host-side arm and a decision about the synchronous contract (a preset pushed once per | 成立 | web §89（预设家族落地）+ host §65：§89 按自己的数字推翻了本条的拒绝 | 是 |
| 93 | web | §84 | A card that relies on `addOneMessage` alone to make an insert stick — `notes/apps/iris-web/CHAT-WRITES.md` measured zero | 未成立 | 截至 e668785 未见 | — |
| 94 | web | §83 | A card that legitimately needs to replace `parent.toastr` for its own scripts — the read-only rule would then need the s | 未成立 | 截至 e668785 未见 | — |
| 95 | web | §82 | Upstream reorganising `st-context.js`'s returned literal, which stops the extraction and — by the discipline both calipe | 未成立 | 截至 e668785 未见 | — |
| 96 | web | §81 | A report that the rail's four icons are not enough to work from — the fold would then need labels and a wider rail, whic | 未成立 | 截至 e668785 未见 | — |
| 97 | web | §80 | A reference image or a ruling that puts the figures back in the bar (the ring is the one part of this that trades inform | 未成立 | 截至 e668785 未见 | — |
| 98 | web | §80 | the primitives growing a role on `MenuItem`. | 未成立 | 截至 e668785 未见 | — |
| 99 | web | §80 | a report that a reader stopped noticing a filling window. | 未成立 | 截至 e668785 未见 | — |
| 100 | web | §79 | A user asking for the environment back as a row (entry 78 is the design to restore, and host §60 the mechanism); a reade | 未成立 | 截至 e668785 未见 | — |
| 101 | web | §78 | A host whose 「宿主环境」 row is expected to describe what is generating rather than what it was launched with (host §60 recor | 未成立 | 截至 e668785 未见 | — |
| 102 | web | §77 | A host that records the route it was launched with (which would make 「使用」 on the host row honest and this entry's first | 成立 | #624c4ce / host §60：宿主记住启动路由；本节已就地记「it did, hours later」 | 是 |
| 103 | web | §76 | A card that sends an `id` and expects a sibling frame to move (then the choice in divergence 1 is between fidelity and t | 未成立 | 截至 e668785 未见 | — |
| 104 | web | §75 | A host message that carries a credential (the contract is the host's, the exposure would be here); a code whose message | 未成立 | 截至 e668785 未见 | — |
| 105 | web | §74 | A profile where compaction fires often enough for its spend to have a distribution — then the sixth metric earns its pla | 未成立 | 截至 e668785 未见 | — |
| 106 | web | §71 | a zod that puts `.z` on the named export makes the view dead code; the premise is pinned by `zod-global.test.ts`'s first | 未成立 | 截至 e668785 未见 | — |
| 107 | web | §68 | Per-category totals on the open chat, which would let the *card* render without a fetch too and would retire the fetch-o | 未成立 | 截至 e668785 未见 | — |
| 108 | web | §68 | A cheap reading. If the host ever carried the last request's category totals on the open chat, the capsule could state | 未成立 | 截至 e668785 未见 | — |
| 109 | web | §65 | Nothing; this is a gap with a known shape. The next round should add the confirmation and default it from `export_with`. | 未成立 | 截至 e668785 未见 | — |
| 110 | web | §64 | A library big enough to want folders. The shape would be a `folder` discriminator on the stored record plus one level of | 未成立 | 截至 e668785 未见 | — |
| 111 | web | §63 | A card update flow — "this card has a new version, here is what changed" — would give a shadow copy somewhere to be reco | 未成立 | 截至 e668785 未见 | — |
| 112 | web | §62 | A test panel that ran the *real* gate — placement, depth and ephemerality included, against a chosen message of the open | 未成立 | 截至 e668785 未见 | — |
| 113 | web | §61 | A host RPC that reports what the endpoint offers without a connection test would let `/chat-model` refuse honestly on a | 未成立 | 截至 e668785 未见 | — |
| 114 | web | §61 | A host method that enumerates what `script.slash` accepts, which would let the completion menu offer upstream's names be | 未成立 | 截至 e668785 未见 | — |
| 115 | web | §60 | A host that recorded a per-message timestamp in the chat file would retire the reconstruction and its note. A profile la | 成立 | a99c3db / host §67：新记录带时刻。决定**部分**跟上：旧历史仍走重建与计数 | 是 |
| 116 | web | §59 | A cheap reading. If the host ever carried the last request's category totals on the open chat, the capsule could state a | 未成立 | 截至 e668785 未见 | — |
| 117 | web | §58 | For the attribution line: a measurement that readers find it noise, which is a claim about the line and not about the bo | 未成立 | 截至 e668785 未见 | — |
| 118 | web | §57 | A card whose books run to thousands of entries, where 23 KB stops being the ceiling and the digest needs paging (the sha | 未成立 | 截至 e668785 未见 | — |
| 119 | web | §56 | A frame-addressed context — a snapshot that legitimately differs per row, `floor` being carried in it rather than beside | 未成立 | 截至 e668785 未见 | — |
| 120 | web | §55 | A ruling that message interfaces must require the same explicit yes as scripts for *every* card — then the question has | 未成立 | 截至 e668785 未见 | — |
| 121 | web | §51 | A card that needs a message sheet to match across two regions or into the prose (none in the corpus) — which is not a kn | 未成立 | 截至 e668785 未见 | — |
| 122 | web | §50 | A decision to give the capsule the global scope as well — a modifier, or a second row — which would need the drawer's "d | 未成立 | 截至 e668785 未见 | — |
| 123 | web | §49 | A provider whose `/models` requires a scope the generation key does not have, making the dropdown reliably empty where t | 未成立 | 截至 e668785 未见 | — |
| 124 | web | §48 | A ruling that the panel should be upstream-shaped for muscle memory — in which case the card's book belongs on the chara | 未成立 | 截至 e668785 未见 | — |
| 125 | web | §47 | A ruling that Iris should also carry upstream's estimate — which is a *different* entry, not this one: it would mean com | 未成立 | 截至 e668785 未见 | — |
| 126 | web | §46 | A card that relies on an unknown tag being *shown* — none does; the shape's whole purpose is to be a marker for a regex | 未成立 | 截至 e668785 未见 | — |
| 127 | web | §45 | A card that reads `--SmartTheme*` inside a fenced document, or a decision to offer card authors an Iris-specific theme c | 未成立 | 截至 e668785 未见 | — |
| 128 | web | §44 | A ruling that Iris frames should look native under the 墨 theme — that would move this to a deliberate improvement, with | 未成立 | 截至 e668785 未见 | — |
| 129 | web | §43 | Nothing about the aliases themselves; the open question is the frames, which is entry 45. | 未成立 | 截至 e668785 未见 | — |
| 130 | web | §42 | Either half. A reading showing the check does fire for a module-mode card retires the paragraph above. A ruling that Iri | 未成立 | 截至 e668785 未见 | — |
| 131 | web | §41 | The stylesheet proxy landing. At that point a card's remote stylesheet loads with `style-src`/`font-src` still at `self` | 成立 | fe45239 / web §95.4、ROADMAP：远程样式表改走 bundle 路由。决定**部分**跟上：代理只覆盖白名单内主机（`*.jsdelivr.net`、`raw.githubusercontent.com`），本节点名的 `fontsapi.zeoseven.com` 仍在白名单外被具名拒绝 | 是 |
| 132 | web | §28 | A host-side raw-generation contract that accepts resolved world-info text (the assembling `generate` already assembles w | 未成立 | 截至 e668785 未见 | — |
| 133 | web | §27 | Publishing context-dependent members as live getters from install would close the boot-window gap entirely; it needs a s | 未成立 | 截至 e668785 未见 | — |
| 134 | web | §26 | A product decision that cards may own the whole window again, or a measured card that is genuinely unusable at column wi | 未成立 | 截至 e668785 未见 | — |
| 135 | web | §25 | A card whose narrative regularly begins lines with CommonMark type-6 tags as *prose* (none in the corpus — that is the s | 未成立 | 截至 e668785 未见 | — |
| 136 | web | §24 | A surface that puts the question to script-less cards whose messages carry interfaces (then the widening folds back into | 未成立 | 截至 e668785 未见 | — |
| 137 | web | §23 | A discriminator between "content fits what we applied" and "content is now clipped and pinned" that is not gameable by a | 未成立 | 截至 e668785 未见 | — |
| 138 | web | §22 | Evidence that a message frame hosts its own MVU emitter (then the shell copy would double-fire there too), or a frame-si | 未成立 | 截至 e668785 未见 | — |
| 139 | web | §21 | A cross-frame published-global bridge (the shell brokering calls into the script frame's live objects) would make the st | 未成立 | 截至 e668785 未见 | — |
| 140 | web | §20 | A measured card whose interface visibly depends on styling something outside its own frame — that would be a request for | 未成立 | 截至 e668785 未见 | — |
| 141 | web | §19 | A measured card that cannot render without a same-origin POST answering, or that awaits a same-origin response as a stre | 未成立 | 截至 e668785 未见 | — |
| 142 | web | §18 | A reading that the periodic window never removes anything a user would miss — it is bounded by `keep`, so this is arguab | 未成立 | 截至 e668785 未见 | — |
| 143 | web | §17 | A durable path for a card's own chat-file writes — if `saveChat` ever carried rows, MVU's sweep would work and the quest | 未成立 | 截至 e668785 未见 | — |
| 144 | web | §17 | Evidence that upstream's folding is deliberate rather than incidental — a comment, an issue, a changelog line saying a d | 未成立 | 截至 e668785 未见 | — |
| 145 | web | §12 | Upstream adding `chat_metadata` to its context. | 未成立 | 截至 e668785 未见 | — |
| 146 | web | §11 | A corpus card using jQuery UI — the reports would name it. | 未成立 | 截至 e668785 未见 | — |
| 147 | web | §10 | Upstream widening the filter, or a corpus card that depends on those floors being reachable — none does today. | 未成立 | 截至 e668785 未见 | — |
| 148 | web | §9 | Nothing about the naming. The entry closes when the member is folded in. | 未成立 | 截至 e668785 未见 | — |
| 149 | web | §8 | A corpus card reading one of the three off `SillyTavern` rather than off Tavern Helper — none does today; the reports wo | 未成立 | 截至 e668785 未见 | — |
| 150 | web | §7 | Upstream adding members of the same name with different semantics, which the `IRIS_OWN` guard would catch as a failure r | 未成立 | 截至 e668785 未见 | — |
| 151 | web | §6 | Nothing — the shape is settled. What is still being measured is *which* fields the corpus's fourteen call sites read, wh | 未成立 | 截至 e668785 未见 | — |
| 152 | web | §5 | A corpus card mutating a TH return value, which would mean upstream's clone is load-bearing for it and our liveness was | 未成立 | 截至 e668785 未见 | — |
| 153 | web | §4 | Nothing about the measurement; only the work. | 未成立 | 截至 e668785 未见 | — |
| 154 | web | §3 | A card in the corpus passing a character name, or a host-side synchronous read that makes the named branch answerable. | 未成立 | 截至 e668785 未见 | — |
| 155 | web | §2 | A card that reads metadata written elsewhere, or a host-side channel that lets the frame merge remote changes without cl | 未成立 | 截至 e668785 未见 | — |
| 156 | web | §1 | A measurement showing cards that rely on a throw to detect absence — none does today; the corpus's habit is the opposite | 未成立 | 截至 e668785 未见 | — |
| 157 | rpc-host | §2 | The carrier grows either hook. Then this becomes code: three config keys and a test that boots the composition and rea | 未成立 | 截至 e668785 未见 | — |
| 158 | rpc-host | §1 | A carrier that exposes a header hook for the fallback seat, or a frontend package that takes one: cost (1) closes, and t | 未成立 | 截至 e668785 未见 | — |
| 159 | variables | §1 | A card that stores a map keyed by arbitrary strings in its variables — a token table, a frequency count, a user-name | 判不了 | 需要一次语料扫描找卡变量里以任意字符串为键的表（`constructor` 会成为诚实数据）；`keys.test.ts` 只测谓词与各写入面，不扫语料 | — |
| 160 | compat-prompt | 「Deviations」 | Any of: | 未成立 | 截至 e668785 未见 | — |

**扫了 160 句；成立 12 句；其中还没重看 1 句。**

## 待办（交给 owner 的「未重看」）

1. **host §84 重开项 (b)：`plugin.update` 已建（U1 #106），但 `#replaceRow` 只重发 client bundle，不调 `#publishCopyBundles`。** 一次更新改了 i18n 文案时，`<dataDir>/system-plugins/<id>/i18n/` 到下一次启动前仍是旧字节；新清单不再声明 i18n 时也不删该目录。启动扫描 `scanInstalled`/`#adoptRecorded`（`install.ts:1009`）会在下次启动重发文案，所以这是「滞后一个启动周期」而非永旧——而「资产根是记录的投影」这句在两次启动之间不成立。`plugin-install.test.ts` 的更新系列没有一条带 i18n 的夹具，所以现在无测试可发现。开任务让更新当场重发（或补一段「维持原决定」的追加行说明为什么可以等到启动）。
2. 其余「决定部分跟上」的节（host §19、host §28、web §41、web §60、web §103）：条件成立但只覆盖一部分，追加行已写明「部分」，是否把整节收尾由 owner 定。

