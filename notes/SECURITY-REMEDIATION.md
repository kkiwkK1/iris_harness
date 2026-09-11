# Security remediation — the two 2026-09 audits, finding by finding

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
- **Pending** — still open with an owner. Two of them, and they are different
  kinds of pending: one is in flight on a branch, the other is a request this
  repository cannot fulfil from inside itself.

**Counts: 28 landed, 4 accepted, 2 pending, across 34 findings.**

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
| F4 | 中 | API keys stored in plaintext in `connections.json` | **Pending** — `dev/sec-key-at-rest` | app-service §75 (that branch) |
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

## The two that are still open

**F4 — API keys at rest.** In flight on `dev/sec-key-at-rest`, landing as
app-service §75. It is the one finding of either audit whose fix is a design
question rather than a patch: a key encrypted with a secret stored beside it is
theatre, and the answers that are not theatre (an OS keychain, a passphrase at
launch) each cost the user something at every start. This file will carry the PR
number once it merges.

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
*content*; and the two pending rows name what would move them, so the next person
to touch either one has an obvious place to come back to. When `dev/sec-key-at-rest`
merges, F4 gets a PR number. When the carrier grows a timeout hook, L-8 becomes a
landed row and `rpc-host` §2 becomes a closed entry with a test.
