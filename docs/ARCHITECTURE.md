# Architecture

> 状态：现状文档。描述 `main` `e356771` 的现状，核对于 2026-09-16。数字与路径以该提交为证据；行号会漂移，符号名不会。
>
> 上一版描述的是 23 包、无 CI、`apps/iris-web` 不出现在任何依赖图里的树。系统插件
> 平台（#88）、CI 工作流与浏览器侧的 `file:` 依赖此后落地，本版按 `e356771` 重记。

What is allowed to depend on what, and why. This file exists so that the rules
are checkable instead of remembered — `apps/iris/tests/architecture.test.ts`
enforces every invariant stated here, and a change to one belongs in both places.

## The shape

27 packages in five layers, no cycles. Layer numbers are the longest path to a
leaf, computed rather than declared:

```
L0  character  chat  compat-prompt-template  compat-st-extension
    compat-tavernhelper-core  extension-installer  llm-openai-compat
    pipeline  plugin-api  protocol  regex  script  text  tokenizer
                                                          ← no @iris deps
L1  client-fake  lorebook  macro  persistence  plugin-web-api  preset
    rpc-client  rpc-host  turn  variables
L2  compat-tavernhelper  mvu  web  (apps/iris-web)
L3  app-service
L4  app  (apps/iris — the composition root)
```

Measured, not recited: `ls packages | wc -l` = 27, and the layering is the
longest-path-to-a-leaf over every `packages/*` and `apps/*` manifest's `@iris/*`
dependencies — the same `manifestGraph` the architecture test builds.

`lorebook` and `macro` sit at L1 rather than L0 since 2026-09-12: they used to
reach into `@iris/compat-tavernhelper-core` for `stringHash` and
`parseRegexFromString` and now depend on the zero-dependency `@iris/text`
instead. The three removed edges are pinned by name in the architecture test,
because each was cheap and locally sensible when it was written and would come
back the same way.

`apps/iris-web` is still deliberately outside the **pnpm** workspace —
`pnpm-workspace.yaml` excludes it by name — and is npm-managed. What changed is
that its own `package.json` now declares its five workspace packages as `file:`
dependencies, so it appears in the manifest graph above instead of as an
invisible leaf. Vite still resolves them to source by alias; see rule 2.

## The three rules that matter

### 1. `@iris/protocol` depends on nothing

It is the contract, and both trust domains depend on it. If it depended on a
domain package, changing storage would change the wire — and `ScriptChatMessage`
is the live example: it duplicates `@iris/persistence`'s `SillyTavernMessage`
structurally rather than importing it, so the two stay assignable without a cast
and neither drags the other.

### 2. The browser may only see the contract

`apps/iris-web` imports `@iris/protocol`, `@iris/rpc-client` (the real
transport, which itself depends only on the contract) and `@iris/client-fake`,
plus three packages admitted on the strength that they drag **nothing else in
behind them**: `@iris/compat-tavernhelper-core`, for the event-name tables a
card subscribes to by literal string, and `@iris/text`, for `stringHash`,
`parseRegexFromString`, and the bilingual-copy audit (`copy.ts`) — two answers
the frame and the host must compute identically, where a second copy drifts
into a listener that never fires or a key one side matches as a pattern and the
other as text, and a rule of the same shape whose two execution points are the
host's install gate and the shell's own dictionary test rather than the frame:
one implementation is what keeps the copy audit from quietly diverging into
"the install gate admits what the dictionary gate would refuse" (or never
refuses, for a plugin installed between test runs) — and
`@iris/plugin-web-api`, for the system-plugin capability snapshot a frame is
born with and the codec both the shell and the bootstrap read, whose only Iris
import is the contract itself, as types (`import type` is erased before any
bundler sees it, so the browser gains the package's bytes and nothing behind
them). Each has a purity test of its own, because the ground they are admitted
on is a claim about every future edit. Nothing else.

This is the rule most worth enforcing and the one least visible, and the reason
has narrowed rather than gone away. The browser app's **bundler** reaches
workspace code through Vite aliases to source (`apps/iris-web/vite.config.ts`),
not through resolution of its manifest; the manifest's five `file:` entries are
what npm installs and what a dependency graph can see, and nothing keeps the two
lists equal. So a sixth alias, or a subpath import, is a dependency the manifest
never hears about. The check therefore reads the browser's **source imports**
rather than either list — and a companion test hands the scanner a file it wrote
on purpose, because a scanner that has stopped recognising a specifier and a tree
that is clean produce the same empty set.

What it keeps out: `persistence` (the storage format), `app-service` (the host's
own logic), `rpc-host`, `llm-openai-compat` (credentials), `character`,
`lorebook`. A browser that could construct a chat file could bypass every check
the host performs on the way in.

### 3. Nothing depends upward

A domain package may not import `app-service`, `rpc-host`, or `app`. Dependencies
point toward the leaves; the composition root is the only place that knows the
whole tree exists.

### What else the same test now holds

The three rules above are the ones worth arguing about; the test file has since
grown four more assertions, listed here so the enforced set and the documented
set stay the same set:

- `@iris/text` has no `@iris` dependencies at all — the rule `@iris/protocol`
  holds, for the opposite reason. It is on the browser's allowlist *because* it
  can drag nothing in behind it, so an edge here widens what the frame can reach
  with nothing in `apps/iris-web` changing.
- The two system-plugin contract packages hold the layer their names claim:
  `@iris/plugin-api` depends on nothing of ours, `@iris/plugin-web-api` on
  `@iris/protocol` alone, and `@iris/app-service` consumes `plugin-api` rather
  than carrying a copy — there is exactly one `SystemPluginDefinition`.
- Three named edges stay removed: `lorebook → compat-tavernhelper-core`,
  `macro → compat-tavernhelper-core`, `compat-tavernhelper → mvu`. Named pairs
  rather than a general rule, because a general rule needs a list of which
  packages are engines and that list is the thing that goes stale.
- The host never depends on the fake client.

## Plugin platform packages

Five packages on the list above are the system-plugin platform, and they are
described **once**, elsewhere: `@iris/plugin-api` (what a plugin is and how it
activates), `@iris/plugin-web-api` (the capability snapshot a sandbox frame is
born with, plus its codec), `@iris/extension-installer` and
`@iris/compat-st-extension` (installing and running an unmodified SillyTavern
extension), and `@iris/text` (the two functions the host and the frame must
compute identically, plus the bilingual-copy audit).

The architecture facts about them are the dependency edges above. Everything
else — the lifecycle, the catalog, the `/plugins` asset face, the install
handshake — lives in [SYSTEM-PLUGINS.md](SYSTEM-PLUGINS.md),
[SYSTEM-PLUGIN-INSTALL.md](SYSTEM-PLUGIN-INSTALL.md) and, for the authoritative
per-change table of what exists and what does not,
[INFRASTRUCTURE-INTERFACES.md](INFRASTRUCTURE-INTERFACES.md) §8. One source of
truth per fact: where this file and that table disagree, that table wins.

## Why the browser app is outside the workspace

Not a preference. pnpm cannot extract esbuild on this machine — a deterministic
`ERR_PNPM_EPERM` on rename at every linker setting, reproduced in a clean temp
directory. `apps/iris-web` is npm-managed with its own lockfile and reaches
workspace source through Vite aliases.

The cost is that rule 2 is decided by an alias list a dependency tool never
reads, which is why it is tested against the sources instead. CI installs each
half with its own tool for the same reason — `pnpm install --frozen-lockfile` at
the root, `npm ci` in `apps/iris-web` — because anything else installs something
this repository has never run.

## Invariants beyond dependencies

- **Everything is reversible.** Cordis is the kernel; every registration returns
  a disposer. A feature that cannot be unloaded is a bug, not a shortcut.
- **The host authors state; the browser holds a projection.** `stream.end`
  replaces a view wholesale rather than being reconciled, because a delta can be
  missed and a settled view cannot be wrong.
- **Identity is minted, never derived.** Row keys encode nothing. This cost us a
  live bug once: the browser rebuilt a key from the turn number, matched the fake
  client's scheme, never matched the host's, and every reply remounted the
  instant it finished while every test passed.
- **Upstream's spelling is preserved in compat layers**, misspellings included
  (`substitudeMacros`, `updatelorebookEntriesWith`). A compat layer that corrects
  its source is not a compat layer.
- **The corpus is the oracle for compatibility work.** Fixtures are built from
  the same belief as the code, so they confirm rather than test. Every
  compatibility claim in this repo is a measurement over the 19 local cards.

## Where the framework is still thin

Stated here rather than discovered later.

- **Multi-profile is built in the storage layer; there is no switcher.** Every
  path comes from `profilePaths(dataDir, profile)` in `@iris/app-service`, so a
  store added later gets its path from the same derivation and cannot be the one
  that forgot to be scoped. The profile name is validated exactly as a chat id
  is, because it arrives from configuration and becomes a directory. The default
  is `default-user`, matching SillyTavern's own `data/<user>/` layout, so
  pointing `dataDir` at an existing install finds its characters in place.

  What is *not* built is choosing a profile at runtime: this build selects one
  by configuration, and there is no contract method to list or switch. That is a
  product decision nobody has asked for yet, not a missing piece of the layer —
  the founding decision was that the storage layer be shaped for profiles, while
  multi-user authentication is an explicit non-goal
  ([notes/PLAN.md](../notes/PLAN.md)).
- ~~**No CI.** Every green claim in this repo is a local run.~~ **There is CI**
  (`.github/workflows/ci.yml`): one job on `ubuntu-latest`, Node 24, both
  installs, both typechecks, the browser build, then `pnpm run test:no-corpus`
  and the render check. It references **no secrets**, deliberately — the
  live-provider tests gate on `IRIS_LIVE=1` and the corpus-gated ones on a
  SillyTavern install a runner does not have, so a workflow that took a key
  would make every fork's pull request either fail or leak. What is still true
  is the narrower sentence: **the corpus-backed claims in this repository are
  local runs**, because CI is the one environment with no corpus. That is also
  why the test step is `test:no-corpus` rather than `test` — it forces the
  corpus absent and then checks the *shape* of the result, since a corpus-gated
  test that guards by returning early instead of skipping reports as a pass
  while asserting nothing (`scripts/check-corpus-skips.mjs`).
- **A real card's production bundle has run to completion in the sandbox**
  (2026-09-01, eleventh live run): a real card's MVU import fetched the actual
  bundle from the whitelisted CDN into an opaque-origin frame, through module
  semantics, the preset libraries, the Tavern Helper surface as it stood that
  day (28 members) and the audited event vocabulary, and finished without error.
  The member count is part of the record of that run, not a current figure — the
  surface has grown since, and `apps/iris-web/tests/identity.test.ts` is what
  holds it against the upstream inventory. "Ran to completion" is
  the load path's verdict, not the feature's: MVU installs listeners and
  returns, so its work starts at generation time. ~~The write path stops by
  design at a named refusal until `script.setVariables` lands.~~ It has landed —
  `script.setVariables` is in `requestSchemas` and registered by the host — so
  that clause describes a state the tree has left. The remaining absences still
  announce themselves (the missing-library banner, refusals by name).
- ~~The sandbox mechanism is verified in a real frame; real cards are not yet.~~
  (superseded by the line above; kept for the record)
  On 2026-09-01 a probe body ran in an actual opaque-origin srcdoc frame in
  Chrome: `new Function` and indirect eval both run under the frame's CSP,
  `ResizeObserver` height reports size the frame (559px observed), viewport
  reads through the virtual document return the host's real numbers (2498px,
  not 0), the `SillyTavern` probe is truthy both bare and via `parent`,
  `document.cookie` refuses loudly naming the member, and an
  `extension_settings` write crossed back to the shell. What has NOT run yet is
  a real card's webpack bundle — the probe verifies the mechanism, not the
  ecosystem.
- **Registration is hand-maintained.** `register` is generic per method, so the
  call list cannot be looped without a cast that discards the type check. That
  decision stands, and its cost is now **137 static methods** long
  (`Object.keys(requestSchemas).length` over
  `packages/iris-protocol/src/rpc.ts`, the same reading
  `packages/iris-protocol/tests/method-names.test.ts` takes — never a grep of
  the source literal). Two tests cover it, both in
  `packages/iris-app-service/tests/registration.test.ts`: one reads the
  registration site, one asks the running host.

  A plugin may also contribute methods at runtime (`scope.registerRpc` plus
  `registerRequestSchema`), which are deliberately **not** in that 137 — the
  static table is the contract, the dynamic registry is a plugin's own. There is
  no production user of the dynamic path on `main`; see
  [INFRASTRUCTURE-INTERFACES.md](INFRASTRUCTURE-INTERFACES.md) §1.

## How the numbers here were taken

Recorded so a re-measurement is a command rather than a reconstruction.

| number | command |
| --- | --- |
| 27 packages | `ls packages \| wc -l` |
| the layer table | the manifest walk in `apps/iris/tests/architecture.test.ts` (`manifestGraph`), longest path to a leaf over `packages/*` + `apps/*` |
| 137 RPC methods | `node --input-type=module -e "import {requestSchemas} from './packages/iris-protocol/src/index.ts'; console.log(Object.keys(requestSchemas).length)"` |
| 137 registration calls | `grep -c "ctx.irisRpc.register(" packages/iris-app-service/src/index.ts` — the hand-maintained call list, one per method, which is the point |
| CI shape | `.github/workflows/ci.yml`, read end to end |
