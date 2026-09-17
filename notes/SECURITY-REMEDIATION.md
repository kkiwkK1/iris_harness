# Security remediation — the two 2026-09 audits, finding by finding

> 状态：记录。测量于 2026-09-11，对象 两份外部审计（对象仓库 `624c4ce`，复核 `d970cb8`）逐条的处置状态。记录不随代码更新；Iris 侧的现状以 `docs/` 为准（索引见 `notes/README.md`）。

Dated 2026-09-11.

Two audits were run against this repository at `624c4ce` and re-checked at
`d970cb8`. Neither lives in the tree, because neither is this project's
document; both are read-only inputs:

- **Network security engineering** — `D:/workspace/小项目/审计报告/审计报告-网络安全工程.md`
  — 17 findings, numbered `H-1`…`H-3`, `M-1`…`M-4`, `L-1`…`L-10`.
- **System security and data** — `D:/workspace/小项目/审计报告/AUDIT-SYSTEM-SECURITY-DATA.md`
  — 17 findings, numbered `F1`…`F17` (its own count: 高 1, 中 7, 低 9).

This file exists because the work was done across ten pull requests and eight
ledger sections, and after the last one merged there was no single place that
answered "is finding X dealt with, and where". That question gets asked by the
next auditor, by whoever runs the next `npm audit`, and by the engineer who
finds one of these gaps independently and needs to know whether they have found
a bug or a decision. A list of merged PR titles does not answer it; neither does
a ledger, because a ledger is organised by the code it changed rather than by
the finding it answers.

Three statuses, and they mean different things:

- **Landed** — the behaviour changed, there is a merged PR and a ledger section
  with the measurement behind it. Some of these deliberately changed a
  *description* rather than a mechanism; those say so.
- **Accepted** — read, reproduced, and left open on purpose. Every one has a
  written price for closing it and a written trigger for reopening the decision,
  in `apps/iris-web/DEVIATIONS.md` §95 and in `../docs/SANDBOX.md`'s
  "Accepted gaps — 已接受的缺口 (2026-09-11)" section.
- **Pending** — still open with an owner. One remains, and it is a request this
  repository cannot fulfil from inside itself.

**Counts: 29 landed, 4 accepted, 1 pending, across 34 findings** (F4 moved from
pending to landed on 2026-09-11 with #77).

---

## Network security audit — `审计报告-网络安全工程.md`

| # | Severity | One line | Status | Where |
| --- | --- | --- | --- | --- |
| H-1 | 高 | EJS template sandbox escapes across realms; the child process then has the network | **Landed** — #67 | [compat-prompt-template §12](packages/iris-compat-prompt-template/DEVIATIONS.md) |
| H-2 | 高 | WebSocket `Origin` check passes for `127.0.0.1.nip.io` (CSWSH, live conversation leak) | **Landed** — #68 | [rpc-host §1](packages/iris-rpc-host/DEVIATIONS.md) |
| H-3 | 中→高 | No `Host` check anywhere; DNS rebinding reaches every RPC method | **Landed** — #68 | [rpc-host §1](packages/iris-rpc-host/DEVIATIONS.md), [app-service §70](packages/iris-app-service/DEVIATIONS.md) |
| M-1 | 中 | The shell page carried no CSP at all | **Landed** — #75 | [web §93](apps/iris-web/DEVIATIONS.md), [app-service §74](packages/iris-app-service/DEVIATIONS.md) |
| M-2 | 中 | Prototype-pollution safety rested on a lockfile; `assertStorable` never looked at key names | **Landed** — #73 | [variables §1](packages/iris-variables/DEVIATIONS.md), [app-service §73](packages/iris-app-service/DEVIATIONS.md) |
| M-3 | 中 | The page-access grant's real cost was not in the copy (an API key being typed, among four things) | **Landed** — #74 (copy, not mechanism) | [web §94.1](apps/iris-web/DEVIATIONS.md) |
| M-4 | 低-中 | `ejs` 3.1.9 < 3.1.10 (GHSA-ghr5-ch3p-vcr6) | **Landed** — #67 | [compat-prompt-template, "Engine patches that **are** installed"](packages/iris-compat-prompt-template/DEVIATIONS.md) |
| L-1 | 低 | No `nosniff`, no `frame-ancestors`/XFO on an unauthenticated local UI | **Landed** — #75 (with the index-route gap named, not hidden) | [web §93](apps/iris-web/DEVIATIONS.md), [app-service §74](packages/iris-app-service/DEVIATIONS.md) |
| L-2 | 低 | `0.0.0.0` is a legal bind with no runtime warning, on a zero-auth service | **Landed** — #68, deliberately stronger: it refuses to start rather than warning | [rpc-host §1](packages/iris-rpc-host/DEVIATIONS.md) |
| L-3 | 低 | The same-origin fetch bridge promised "any same-origin GET" to future routes | **Landed** — #74 | [web §94.3](apps/iris-web/DEVIATIONS.md) |
| L-4 | 低 | One child process per template batch, no concurrency, memory or size cap | **Landed** — #67 | [compat-prompt-template §12](packages/iris-compat-prompt-template/DEVIATIONS.md) |
| L-5 | 低 | `showdown` 2.1.0 ReDoS + two XSS, no fixed release, frame-only | **Accepted** | [web §95.2](apps/iris-web/DEVIATIONS.md) |
| L-6 | 低 | `writePath` / `_.set` accepted a `__proto__` segment; wire strings became plain object keys | **Landed** — #73 | [variables §1](packages/iris-variables/DEVIATIONS.md), [app-service §73](packages/iris-app-service/DEVIATIONS.md) |
| L-7 | 低 | World-book `depth`/`order`/`scan_depth`/timers were unbounded integers | **Landed** — #73 | [app-service §73](packages/iris-app-service/DEVIATIONS.md) |
| L-8 | 低 | No explicit server timeouts; a slow-drip body holds a connection ~5 min | **Pending** — upstream request, no code | [rpc-host §2](packages/iris-rpc-host/DEVIATIONS.md) |
| L-9 | 低 | `key.txt` read by tooling while `CONTRIBUTING.md` said it never was | **Landed** — this change | [`../CONTRIBUTING.md`](../CONTRIBUTING.md), `apps/iris/tests/key-file.test.ts` |
| L-10 | 信息 | CI actions referenced by floating `@v4` tag rather than commit SHA | **Landed** — this change | `.github/workflows/ci.yml`, `apps/iris/tests/workflow-pins.test.ts` |

### L-9's two phantom scripts

The finding named three things in the branch root: `key.txt` being read by
`demo/mvu-roleplay.ts`, a `test-cards.mjs:47-52` auto-granting script consent to
a test host, and a `wi-editor-verify.mjs` writing and deleting fixed-name files
inside the live SillyTavern install on `E:`.

**The first is real and is fixed here** — and was worse than reported, since two
test files read the same file as well as the demo. **The other two do not exist
on `main`.** `git ls-files --cached --others --exclude-standard` over the whole
tree matches neither name at any path; the only hit for either string is
`notes/TEST-CARDS.md`, a document. The audit read a different checkout — a
working tree with scratch scripts in it, of the kind this repository's
`.gitignore` and its "stage by path" rule exist to keep out of commits. Recorded
here rather than acted on, because inventing a fix for a file that is not there
would make the next reader look for it.

---

## System security and data audit — `AUDIT-SYSTEM-SECURITY-DATA.md`

| # | Severity | One line | Status | Where |
| --- | --- | --- | --- | --- |
| F1 | 高 | Chat `jsonl` rewritten whole, non-atomically; a corrupted chat vanished silently | **Landed** — #70 | [app-service §68](packages/iris-app-service/DEVIATIONS.md) |
| F2 | 中 | Two hosts on one data directory, no protection; whole-file writes lost each other's data | **Landed** — #72 | [app-service §71](packages/iris-app-service/DEVIATIONS.md) |
| F3 | 中 | `script.fetch` re-checked no redirect hop and had no size cap | **Landed** — #66 | [app-service §69](packages/iris-app-service/DEVIATIONS.md) |
| F4 | 中 | API keys stored in plaintext in `connections.json` | **Landed** — #77 (AES-256-GCM per key under a data key wrapped by DPAPI on Windows, a 0600 key file elsewhere; plaintext migrates on first boot) | [app-service §75](packages/iris-app-service/DEVIATIONS.md) |
| F5 | 中 | No `Host` check on HTTP or WS; DNS rebinding defeats "loopback is trusted" | **Landed** — #68 | [rpc-host §1](packages/iris-rpc-host/DEVIATIONS.md), [app-service §70](packages/iris-app-service/DEVIATIONS.md) |
| F6 | 中 | A corrupt JSON store degraded silently and the next write overwrote the original | **Landed** — #70 | [app-service §68](packages/iris-app-service/DEVIATIONS.md) |
| F7 | 中 | The backup timestamp fix did not cover two processes; `-2` suffixes sorted wrong at the retention edge | **Landed** — #72 | [app-service §71](packages/iris-app-service/DEVIATIONS.md) |
| F8 | 中 | `script-src` is open without a grant; a dynamic `import()` URL path is an exfiltration channel | **Accepted** | [web §95.1](apps/iris-web/DEVIATIONS.md) |
| F9 | 低 | A zero-script card's greeting runs inline `<script>` without the consent question | **Landed** — #74 (the count is shown; the behaviour is upstream parity and unchanged on purpose) | [web §94.2](apps/iris-web/DEVIATIONS.md) |
| F10 | 低 | No `base-uri`; the CSP and the host allow-list drifted by one character on the bare apex | **Landed** — #75 | [web §93](apps/iris-web/DEVIATIONS.md) |
| F11 | 低 | The same-origin bridge relayed any same-origin GET, another card's avatar included | **Landed** — #74 | [web §94.3](apps/iris-web/DEVIATIONS.md) |
| F12 | 低 | Snapshots and other small files were written non-atomically | **Landed** — #70 | [app-service §68](packages/iris-app-service/DEVIATIONS.md) |
| F13 | 低 | A save failure inside `settle` sent neither `stream.end` nor `stream.error` | **Landed** — #71 | [app-service §72, "F13"](packages/iris-app-service/DEVIATIONS.md) |
| F14 | 低 | Opening a corrupt chat threw a raw `SyntaxError` while `list` skipped it silently | **Landed** — #70 | [app-service §68](packages/iris-app-service/DEVIATIONS.md) |
| F15 | 低 | The bundle proxy GET is drivable by any local page — bounded disk fill, already documented | **Accepted** | [web §95.3](apps/iris-web/DEVIATIONS.md) |
| F16 | 低 | A provider's echoed error body reached `stream.error` and the cache trace verbatim | **Landed** — #71 | [app-service §72, "F16"](packages/iris-app-service/DEVIATIONS.md) |
| F17 | 低 | `rewriteStylesheetLinks` truncates on a `>` inside an attribute value | **Accepted** (fails in the safe direction) | [web §95.4](apps/iris-web/DEVIATIONS.md) |

---

## The one that is still open

**F4 — API keys at rest** landed as #77 (app-service §75) after this file was
first written. It was the one finding of either audit whose fix was a design
question rather than a patch: a key encrypted with a secret stored beside it is
theatre, so the data key is wrapped by the operating system's own user-bound
store (DPAPI, `CurrentUser`) on Windows, and the non-Windows fallback — a
`0o600` key file — is named as weaker at boot rather than passed off as the same
thing. Measured on the machine that ran it: one PowerShell spawn per boot,
~200 ms; the first boot after the upgrade rewrote the real profile file and
reported `1 connection key(s) were encrypted at rest`.

**L-8 — server timeouts.** Not a patch this repository can write.
`@deepseek-ai/dsh-host-webserver` creates the `node:http` server in its own
constructor and declares the field `private` with no accessor and no config key,
so `headersTimeout` and `requestTimeout` cannot be set without a cast past a
`private` that an `-rc` version may rename in a patch release — a security
setting that can silently revert, which is worse than a documented gap.
[rpc-host §2](packages/iris-rpc-host/DEVIATIONS.md) records the exposure
(loopback-only slow drip, Node's 300 s `requestTimeout` default measured on
v24.13.0), the reason nothing changed, and the exact request to make upstream:
optional `headersTimeout` / `requestTimeout` / `keepAliveTimeout` keys in
`Config`, or a one-shot server-configuration hook.

---

## Three premises the work overturned

Each of these arrived inside a finding, welded to it — and in each case the
finding was real while the premise was not. They are here because a premise that
travels with a fix gets inherited by the next reader, and a correction that
lives only in the ledger section of the PR that found it is a correction nobody
looks for.

1. **"The strict shell CSP is the fix; it just has to be written."** Measured in
   headless Chrome 2026-09-11: it cannot ship. A card interface is an
   `<iframe srcdoc>`, `about:srcdoc` is a local scheme, and such a document
   **inherits its embedder's policy**, which the browser enforces alongside the
   frame's own. A shell policy of `script-src 'self' 'nonce-…'` intersects with
   the permissive policy card code needs and leaves nothing that runs — the same
   frame ran byte for byte with no parent policy and never ran under the strict
   one, with `new Function` refused *citing the shell's directive*, a string that
   appears nowhere in the frame's own policy. What shipped is the three
   directives measured to cost a card frame nothing. [web §93](apps/iris-web/DEVIATIONS.md).

2. **"A second host on a taken port starts somewhere else, so the banner should
   say the configured port was taken."** Measured 2026-09-11: with a squatter on
   the configured port the carrier's `listen` rejects, `boot` rejects with
   `EADDRINUSE`, and the binary never reaches its banner. The host does not start
   on another port; it does not start at all. The only way configured and bound
   differ today is `port: 0`, which is a request being honoured rather than
   drift — so the drift line is a standing net that is dead code until the
   carrier gains a fall-back behaviour, and the half that fires today turns the
   boot failure into one sentence naming the address.
   [app-service §71](packages/iris-app-service/DEVIATIONS.md).

3. **"`script.fetch`'s remote branch is how cards load dependencies."** Measured
   on this tree: cards load dependencies through the bundle route, and the
   frame's `fetch` bridge posts a message **only for same-origin targets**, so
   the remote branch is unreachable from a card as the app is wired today. That
   did not make the defect theoretical and did not change the fix — the handler
   is a registered RPC method reachable by anything that can reach the endpoint,
   and the moment a frame is network-granted the promise written beside it starts
   being kept — but it did change what the finding was *about*: an enforcement
   point that is currently unvisited, fixed at the cheapest moment there will
   ever be. [app-service §69](packages/iris-app-service/DEVIATIONS.md).

---

## Keeping this file honest

It is a hand-maintained map, which is the kind of document that goes stale
quietly. Two things reduce that: every row points at a ledger section rather than
restating the reasoning, so a row can be wrong about *status* but not about
*content*; and the pending row names what would move it, so the next person to
touch it has an obvious place to come back to. When the carrier grows a timeout
hook, L-8 becomes a landed row and `rpc-host` §2 becomes a closed entry with a
test.

---

## 复查（2026-09-17，main `7011d6f`，基线 `09944b8`）

依据 `notes/tasks/REVIEW-4-SECURITY-DRIFT-RECHECK.md`。上面每一个字未改——这份文件
自己说了「记录不随代码更新」，所以这里是追加的一节，不是改 29/4/1 那行。

**问题只有两个**，对 34 条发现逐条问：钉它的测试还在、还绿吗；9 月 11 日之后新增的
面（`/plugins/*`、`/iris-st-ext/*` 两条路由；`plugin.install`/`previewInstall`/
`update`/`uninstall` 一组 RPC；`scope.storage`；插件 i18n 表；安装器的 git 取包；
MVU/TH 变量写者改线）里，同一类问题有没有再长出来。

三个格子只写事实：**测试**（文件 · 名；`存在且绿` / `不存在` / `存在但只覆盖旧面`）、
**新面**（`无` / `有，已覆盖（哪条测试）` / `有，未覆盖（path:line）`）、
**结论**（`成立` / `漂移` / `判不了`）。以代码为准；台账里的 `path:line` 只当线索。

### §3.1 的结果：两条路由**一次就绿**

按手册 §3.1，先把 `/plugins/nothing/nothing.js` 与 `/iris-st-ext/nothing.js` 加进
`apps/iris/tests/host-allowlist.test.ts` 的两张表（Host 拒绝 + nosniff），**不改产品
代码**，跑一次：

```
node --test apps/iris/tests/host-allowlist.test.ts → 9 tests, 9 pass, 0 fail
```

两条路由都**一次就绿**，说明 `packages/iris-rpc-host/src/index.ts` 的 `guard()` 里
「Iris 拥有的每条路由都经过这一个函数」为真——`packages/iris-app-service/src/index.ts`
的六处 `ctx.webServer.register` 全部包在 `ctx.irisRpc.guard(...)` 里，
`/plugins`（`:1363` 起的同一条注释所辖，注册在 `:1491`）与 `/iris-st-ext`（`:1521`）
不例外。**没有漂移，测试保留。**

表不再靠手写：新增 `mountedRoutePrefixes()`（测试文件内），从活着的 effect 树里读
`irisApp: GET <prefix>` 标签——也就是每处 `ctx.webServer.register` 旁边那个字符串——
再断言**每个挂载都被表里某一行覆盖**，且 `routes.length >= mounts.length`。选这个
形状而不是给 `irisApp` 加 getter，因为后者为测试往产品里加一只只读的手，而标签本来
就是加路由时人会去 grep 的东西。**数量当地板**：先断言 `mounts.length >= 6`，
再逐条比对。

牙**两条都验过**（各自单独施加、随后还原）：

| 变异 | 结果 |
| --- | --- |
| 从第一张表里删掉 `/plugins/nothing/nothing.js` 一行 | **红**：`/plugins is mounted but no route in this table covers it — add one` |
| 让标签读取看不到任何东西（`match = null`） | **红**：`the composition mounts at least six guarded routes, found 0:` |

第二条正是手册点名的那个坑：一条 `continue` 让只比 4 条还全绿。地板与逐条比对两件事
都写进断言，读数空掉时红的是地板。

**`guard` 不达的两处仍然只有两处**（第 3 步）：`packages/iris-rpc-host/src/index.ts`
只有两处注册不经 `guard`——`registerUpgrade`（`:422`，WebSocket 升级，无 body 可嗅）
与载体 `@deepseek-ai/dsh-host-frontend-static` 的兜底席位（`index.html` 与构建资产，
外包装没有 header 钩子，rpc-host §1 / app-service §74 记的缺口）。`index.ts` 没有新的
不经 `guard` 的注册。这一条**成立**。

### 逐行

| # | 测试（文件 · 名） | 状态 | 新面 | 结论 |
| --- | --- | --- | --- | --- |
| H-1 | `iris-compat-prompt-template/tests/realm.test.ts`(35)、`tests/upstream.test.ts` · 24 constructor probes | 存在且绿 | `无`——新面里没有第二个跨 realm 传函数的入口 | 成立 |
| H-2 | `host-allowlist.test.ts` · `the exploit: the event socket refuses the rebound origin it used to accept` | 存在且绿 | `无` | 成立 |
| H-3 | `host-allowlist.test.ts` · `every route the application registers refuses a foreign Host…` | 存在，**只覆盖四条旧路由** | `有，本次补入`——`/plugins`、`/iris-st-ext` 未覆盖，§3.1 补入后一次就绿；挂载数校验一并落地 | 成立（补测后） |
| M-1 | `apps/iris/tests/shell-index.test.ts`、`app-service/tests/shell-csp.test.ts`(8)、`apps/iris-web/tests/shell-page.test.ts` | 存在且绿 | `无`（策略仍写在 index 出口处；新路由不经过它，但也从不答 HTML） | 成立 |
| M-2 | `iris-variables/tests/keys.test.ts`、`app-service/tests/forbidden-keys.test.ts` | 存在且绿 | **`有，已覆盖`**——见 §E 之 `scope.storage` 与清单 | 成立 |
| M-3 | web §94.1（文案，无测试） | 不存在（本条落地的就是文案，不是机制） | `无` | 成立 |
| M-4 | `iris-compat-prompt-template/tests/upstream.test.ts` · engine patches | 存在且绿 | `无` | 成立 |
| L-1 | `host-allowlist.test.ts` · `every route Iris owns answers nosniff, refusals and misses included` | 存在，**只覆盖四条旧路由** | `有，本次补入`——同 H-3 | 成立（补测后） |
| L-2 | `iris-rpc-host/tests/host-guard.test.ts`、`host-allowlist.test.ts` · `a network bind with no allowedHosts refuses to start` | 存在且绿 | `无` | 成立 |
| L-3 | `apps/iris-web/tests/bridge-paths.test.ts`（web §94.3） | 存在且绿 | `无` | 成立 |
| L-4 | `iris-compat-prompt-template/tests/realm.test.ts` · 子进程上限 | 存在且绿 | `无` | 成立 |
| L-5 | 无（接受项；web §95.2 定价） | 不存在（接受项本就无测试） | `无`——`showdown` 仍是 2.1.0，无修复版 | 成立（仍接受） |
| L-6 | `iris-variables/tests/keys.test.ts` · 每写脸都拒、每面 fuzz 不触原型 | 存在且绿 | **`有，已覆盖`**——`scope.storage` 的键名走 `isValidExtensionId`，值走 `assertStorable` | 成立 |
| L-7 | `iris-protocol/tests/worldbook-bounds.test.ts` | 存在且绿 | `无`（新面没有无界整数） | 成立 |
| L-8 | 无（上游请求） | 不存在（本仓库写不了的补丁） | — | **仍待办，载体 0.1.1-rc.2 无钩子**（见下） |
| L-9 | `apps/iris/tests/key-file.test.ts` | 存在且绿 | `无` | 成立 |
| L-10 | `apps/iris/tests/workflow-pins.test.ts` | 存在且绿 | `无`——`.github/workflows/` 下仍只有 `ci.yml`，9 月 11 日后无新增 workflow 文件 | 成立 |
| F1 | `app-service/tests/atomic.test.ts`(14)、`chat-integrity.test.ts`(3) | 存在且绿 | `无` | 成立 |
| F2 | `app-service/tests/host-lock.test.ts`(10)、`apps/iris/tests/host-lock.test.ts`(3) | 存在且绿 | **`有，已覆盖`**——插件目录全在锁住的 profile 根下，无 `tmpdir()`/`mkdtemp` 旁路（见 §C） | 成立 |
| F3 | `app-service/tests/script-fetch.test.ts` · 每跳重查 / 上限 / `credentials: 'omit'`、`redirect: 'manual'` | 存在且绿 | **`有，已覆盖`**——见 §D 的安装器对齐表 | 成立 |
| F4 | `app-service/tests/key-at-rest.test.ts`(17)、`connections.test.ts`、`apps/iris/tests/rpc-transport.test.ts` | 存在且绿 | **`有，已覆盖`**——安装路径拒带 userinfo 的 remote（`source.test.ts`、`plugin-install.test.ts:639`）；protocol 里 `apiKey` 无新增字段（见 §F） | 成立 |
| F5 | 同 H-3 | 存在，只覆盖旧面 | 同 H-3 | 成立（补测后） |
| F6 | `app-service/tests/store-quarantine.test.ts`(15)、`chat-integrity.test.ts` | 存在且绿 | `有，未覆盖`——`install.ts:1182` 的 i18n 裸写（见 §B）；读方不抛，是派生物却未走唯一原子入口 | **漂移** |
| F7 | `app-service/tests/backups.test.ts`、`host-lock.test.ts` | 存在且绿 | `无` | 成立 |
| F8 | 无（接受项；web §95.1 定价） | 不存在 | `无`——`script-src` 仍不在授权内 | 成立（仍接受） |
| F9 | web §94.2（文案，无测试） | 不存在（本条落地的是计数显示，不是机制） | `无` | 成立 |
| F10 | `app-service/tests/shell-csp.test.ts`、`apps/iris-web/tests/allowlist-drift.test.ts` | 存在且绿 | `无` | 成立 |
| F11 | `apps/iris-web/tests/bridge-paths.test.ts` | 存在且绿 | `无` | 成立 |
| F12 | `app-service/tests/atomic.test.ts`、`store-quarantine.test.ts` | 存在且绿 | `有，未覆盖`——`install.ts:1182`（i18n 落盘用裸 `fsp.writeFile`）。**单列一行，见下** | **漂移** |
| F13 | `app-service/tests/settle-storage.test.ts`(6) | 存在且绿 | `无` | 成立 |
| F14 | `app-service/tests/atomic.test.ts`、`chat-integrity.test.ts` | 存在且绿 | `有，已覆盖`——`plugin-assets.ts` 的读方**不 parse**（只 hash 字节），浏览器读方 `plugin-copy.ts` 的 `fetchCopyTable` **对截断 JSON 是 catch 住的**（见 §B），故 `install.ts:1182` 不构成 F14 的同类 | 成立 |
| F15 | 无（接受项；web §95.3 定价） | 不存在 | `无`——bundle 代理的预算策略仍是「拒绝写而非驱逐」 | 成立（仍接受） |
| F16 | `app-service/tests/settle-storage.test.ts`、`iris-llm-openai-compat/tests/redact.test.ts`(10) | 存在且绿 | `无` | 成立 |
| F17 | 无（接受项；web §95.4 定价） | 不存在 | `无` | 成立（仍接受） |

**表尾三个数：成立 32 条 / 漂移 2 条（F6、F12，同一处：`install.ts:1182`）/ 判不了 0 条。**

手册给每条行的是「文件在不在、测试绿不绿、面有没有长大」，这三件都在本机测了，所以
没有「判不了」。

### §A 路由与 `guard`（H-3 / F5 / L-1 的骨架）

`packages/iris-rpc-host/src/index.ts` 的 `IrisRpcHost.guard()`（`:344`–`:372`）先
`setHeader('x-content-type-options','nosniff')` 再 `checkHost`。`index.ts` 里六处
`ctx.webServer.register`，**六处全部**包在 `guard` 里：

| 路由 | 挂载处 | 经过 `guard` |
| --- | --- | --- |
| `/iris/avatar` | `index.ts:1363` | 是 |
| `/version` | `index.ts:1375` | 是 |
| `/iris/script-bundle` | `index.ts:1394` | 是 |
| `/sandbox` | `index.ts:1410` | 是 |
| `/plugins`（`PLUGIN_ASSET_PREFIX`） | `index.ts:1491` | 是 |
| `/iris-st-ext`（`ST_EXT_PREFIX`） | `index.ts:1521` | 是 |

rpc-host 自身：`/iris/rpc`（`:412`）经 `guard`；`/iris/events`（`:422`）走
`registerUpgrade`，是 `guard` **不达**的两处之一（另一处是载体的兜底席位）。
**没有第三处新的不经 `guard` 的注册。**

### §B 原子写与坏文件（F1 / F6 / F12 / F14）——含单列一行

`packages/iris-app-service/src/atomic.ts` 是唯一入口：`atomicWriteFile`、
`readJsonStore`、`quarantineCorruptFile` / `quarantineUnparsable`、`wireKeyedTable`。

`grep -rn "writeFile(" packages/iris-app-service/src/plugins/` 只有一处：

```
packages/iris-app-service/src/plugins/install.ts:1182  await fsp.writeFile(path.join(dir, `${lang}.json`), bytes)
```

**单列一行（手册 §6 要求，无论判成什么）——读方的行为：**

- 这是 **F12 的同类**：i18n 表落盘没走 `atomicWriteFile`。
- 它是**派生物**：`#publishCopyBundles` 从 `contentDir` 拷贝，启动时 `scanInstalled`
  （`install.ts:913`）会重发，撕裂后自愈。
- **读方不抛。** 这条是要紧的：host 侧 `packages/iris-app-service/src/plugin-assets.ts`
  的 `#rev`（`:144`）只 `readFile` 后 `createHash`，**从不 `JSON.parse`**；它把
  rev 盖在 URL 上，浏览器再去取。浏览器侧
  `apps/iris-web/src/app/i18n/plugin-copy.ts` 的 `fetchCopyTable` 对
  `JSON.parse` 有 try/catch，且**按插件、全有全无**地降级——`console.warn` 一次，
  丢掉这一个 id 的 copy，其余 overlay 不受影响；下一次 manifest 快照会重试。
  **实测**（复制一份目录，把 `zh.json` 截断成 `{"hello": "你`，跑
  `PluginAssetStore.manifest` 与浏览器的 parse 路径）：manifest 照出 `?rev=` URL；
  浏览器 `JSON.parse` 抛 `SyntaxError`，被 `fetchCopyTable` 的 catch 收住，
  降级为丢 copy，不冒泡出 `syncPluginCopy`。
- 结论：**不是 F14 的同类**（读方不抛）。F6/F12 那两行的「漂移」判的是 F12 同类这一层：
  一次崩在 `writeFile` 中间会留下半个 JSON，虽然自愈，但它没有走那个唯一的原子入口。
  按手册 §5「发现的漂移进清单交给我派任务，不顺手修」，此处只记事实，**不修**。

`plugins/` 下其余 `writeFile(` 计数为 0——`installed` 记录、`plugin-storage` 的键文件
都已走 `atomicWriteFile`（`plugins/storage.ts:36` import 自 `atomic.ts`；写经
`atomicWriteFile`、读经 `readJsonStore`，损坏文件按 `readJsonStore` 规则隔离为
`.corrupt-<ts>` 并经 `onProblem` 上报）。

### §C 一目录一宿主（F2）

`host.lock` 在 `packages/iris-app-service/src/host-lock.ts`，锁的是**整个
`dataDir`**（`<dataDir>/host.lock`，`open(path,'wx')`）。`packages/iris-app-service/src/paths.ts`
的 `profilePaths(dataDir, profile)` 把 `root` 派生为 `dataDir/<profile>`，而
`systemPluginPackages`、`pluginData`（`<profile>/plugin-data/<id>/`）、`extensions`
**全部**在 `profilePaths` 之下。安装器布局（`staging/`、`claims/`、`installed/`，
见 `packages/iris-extension-installer/src/staging.ts:31-33`）根在
`paths.systemPluginPackages`，也就是 `<profile>/system-plugins`，
`index.ts:806` 把它交给 `SystemPluginInstallService`。

`grep -rn "tmpdir()\|mkdtemp\|os.tmpdir" packages/iris-app-service/src
packages/iris-extension-installer/src` → **0 处**。安装路径**没有**在 `host.lock`
之外另开可写目录。两台宿主指同一 `IRIS_DATA_DIR` 时，第二台在 `host.lock` 就拒绝
（`apps/iris/tests/host-lock.test.ts`，3 例，绿）。**成立。**

### §D 远程取物的重定向与大小上限（F3 / U6）

F3 的三条规则在 `packages/iris-app-service/src/remote-fetch.ts`：`MAX_HOPS = 5`
（`:110`）、`DEFAULT_MAX_BYTES = 8_388_608`（`:125`）、`redirect: 'manual'` 由本代码
逐跳走（`:52-53`）并对每一跳复用同一个 `checkScriptFetch`。安装器（U6 硬化）在
`packages/iris-extension-installer/src/`：

| 规则 | `script.fetch`（#66） | 安装器 git 路径（U6 / #105） | 缺口是有意的？ |
| --- | --- | --- | --- |
| 协议限制 | allowlist 每跳重查（`checkScriptFetch`） | 只收 `https://`，其余（`git://`、`ssh:`、裸路径）以 `git repository must be an https:// URL` 拒（`source.ts:126`） | — |
| 凭据拒绝 | `credentials: 'omit'` + `redirect: 'manual'`（`script-fetch.test.ts:194`） | `refuseCredentialedRemote`（`source.ts:61`）对两条安装路径共用；userinfo 即使带 pin 也先按凭据拒（`:117-122`）。**这是对 ST 的有意分歧**，理由记在 app-service §85 | 是，台账有记 |
| 大小上限 | `DEFAULT_MAX_BYTES` 8 MiB | 拷贝字节上限（`source.ts:192` `archive is N bytes, over the M-byte limit`）+ 解压几何：`maxEntries 50_000`、`maxTotalUncompressed 1 GiB`、`maxFileUncompressed 256 MiB`（`archive.ts:49-51`） | — |
| 重定向 | 每跳重查，`redirect: 'manual'` | 无重定向概念（git 自己走 argv：`core.hooksPath` 清空、`--no-recurse-submodules`、固定 argv、无 shell） | 是——取物是 git 不是 HTTP，台账 host §85 记 |
| 跳数上限 | `MAX_HOPS = 5` | 不适用 | 是（同上） |

**缺的那条（安装器没有「每跳重查」，因为它不做 HTTP 重定向）在台账里有理由**，符合
手册「不要求它们一样，要求缺的那条是有意的」。**成立。**

### §E 原型污染与无界整数（M-2 / L-6 / L-7）

新面逐条查：

| 新面 | 键名/值校验 | 证据 |
| --- | --- | --- |
| `scope.storage` 键名 | `isValidExtensionId(key)`，非法即 `invalid("... is not a valid plugin storage key")`；另有 resolved-prefix containment | `plugins/storage.ts:298`（`#fileFor`）、`:283`（`#dirFor` 的语法检查） |
| `scope.storage` 值 | `assertStorable(value, 'plugin storage value')`——形状 + `isForbiddenKey` 逐键递归 | `plugins/storage.ts:355`；`context.ts` 的 `assertStorable` |
| 清单 `permissions` 条目 | 闭词表 `PERMISSION_SET.has(entry)`，未知名 `manifest-invalid` 具名拒绝；重复声明也拒 | `plugins/manifest.ts:328-334` |
| 清单 `i18n` 键 | 要求 `en`/`zh` 两者齐备（缺一具名拒绝），并经 `checkTreePathShape` 路径形状检查 | `plugins/manifest.ts:294-314` |
| `plugin.update` 的 `updateOf` | **不是入参**——它由 host 从行自身的 provenance 生成（`install.ts:469`），是 `previewInstall` 的**出参**。入参只有 `id` + `commit`（`commit` 由 `PLUGIN_GIT_COMMIT` 正则钉死），无 `z.record`、无外部键名 | `rpc.ts:340`；`install.ts:469/472` |

`wireKeyedTable`（`atomic.ts:280`）用在 `card-storage.ts` 与 `context.ts` 的「带
文件名键」表上；`scope.storage` 不用它，因为它**一文件一键**
（`<pluginData>/<id>/<key>.json`），键名先过 `isValidExtensionId` 再拼进路径，从不
把它当普通对象的键。这是比 `wireKeyedTable` 更强的一层，不是漏掉。
协议里没有收外部键名的新 `z.record` 面。**成立。**

### §F 密钥落盘（F4）

`git grep -n "apiKey\|api_key\|token" packages/iris-protocol/src/rpc.ts` 的命中：

| 行 | 字段 | 是不是要落的密文 |
| --- | --- | --- |
| 347 | `token: z.string()`（`plugin.confirmInstall`） | 不是——是 preview token，一次性的预览句柄 |
| 664 / 752 | `apiKey: z.string().max(2000).optional()` | **是**——但这就是 §75 已加密的那条 provider key，无新增字段 |
| 666 / 753 | `apiKeyHeader` | 不是——是 header 的名字 |
| 702 | `tokens: z.number()` | 不是——token 计数 |
| 538 | 注释里的 `secrets.json` | 不是字段 |

**provider 之外没有新的 `apiKey` 字段。** 安装路径记 remote 时拒带 userinfo 的 URL
（`source.ts:61`，测试 `packages/iris-extension-installer/tests/source.test.ts:38`、
`packages/iris-app-service/tests/plugin-install.test.ts:639`）。**成立。**

### §G 台账点名的测试与「还在、还绿」

逐行引用的测试文件全部存在；29 个文件一次跑：

```
node --test <29 files> → 400 tests, 395 pass, 0 fail, 5 skipped
```

另跑门禁：`apps/iris/tests/host-allowlist.test.ts`（9/9，含本次补入的两条路由与挂载
校验）、`apps/iris/tests/key-file.test.ts` + `workflow-pins.test.ts` +
`md-references.test.ts`（7/7）、根目录 `npm test`（**4308 tests, 4298 pass, 0 fail,
10 skipped**）。

### §3.7 L-9 / L-10

`key-file.test.ts` 与 `workflow-pins.test.ts` 都绿。`.github/workflows/` 下**只有
`ci.yml`**，`git log -- .github/workflows/` 在 9 月 11 日之后没有新增 workflow 文件
（那条 CI 钉 SHA 的提交是既有的 `53586ec`）。「新文件里的 action 也要钉 SHA」这条
**没有新对象**。**成立。**

### §3.8 四条「接受」

web §95.1–95.4 的重开条件，REVIEW-1 已扫过一遍，四条都在
`notes/LEDGER-REOPEN-SWEEP-2026-09-17.md` 的清单里：

| § | 清单第几行 | REVIEW-1 结论 |
| --- | --- | --- |
| §95.1（F8） | 82 | 判不了——需要一次语料扫描找非字面 `import()` 说明符 |
| §95.2（L-5） | 81 | 未成立——无修复版 |
| §95.3（F15） | 80 | 未成立——白名单未放宽、预算策略未改 |
| §95.4（F17） | 79 | 判不了——需要语料扫描找 link 标签属性值内含 `>` 的卡 |

**四条都在，结论照抄，不重判。** 手册说「没有就补判」——这里没有缺的。

### §3.9 L-8（唯一的待办）

**仍待办。** 载体 `@deepseek-ai/dsh-host-webserver` 装的是 `0.1.1-rc.2`，整包
`grep -rl "headersTimeout\|requestTimeout\|keepAliveTimeout"` 为 **0 处**——上游没有
长出钩子。**没有**去 cast 过 `private` 拿 server（rpc-host §2 解释了为什么那比缺口更
糟）。顺手量的现状（Node **v24.13.0**，本机）：

| 设置 | 默认值 |
| --- | --- |
| `headersTimeout` | 60 000 ms |
| `requestTimeout` | 300 000 ms |
| `keepAliveTimeout` | 5 000 ms |
| `timeout`（socket inactivity） | 0（禁用） |

下次比对有基数。**读数：仍待办，载体 0.1.1-rc.2 无钩子。**

### 结论与交付

- **成立 32 条 / 漂移 2 条（F6、F12，同一处 `install.ts:1182`）/ 判不了 0 条。**
- §3.1：补入的两条路由（`/plugins/nothing/nothing.js`、`/iris-st-ext/nothing.js`）
  **一次就绿**——`guard` 的「每条路由」为真。**没有红灯，没有漂移。** 表补齐 +
  挂载数校验（含地板与逐条覆盖比对，两条变异各自验红）落在这一个 PR。
- 漂移的两条（F6/F12）进清单，交派任务，**不顺手修**（手册 §5）。
- `install.ts:1182` 单列一行，读方行为见 §B：host 侧不 parse，浏览器侧 catch 住并
  按插件降级，不抛。
- 唯一允许的代码改动就是 §3.1；台账原文与上面每一字未改。
