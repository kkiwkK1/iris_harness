# Architecture

What is allowed to depend on what, and why. This file exists so that the rules
are checkable instead of remembered — `apps/iris/tests/architecture.test.ts`
enforces every invariant stated here, and a change to one belongs in both places.

## The shape

22 packages in five layers, no cycles. Layer numbers are the longest path to a
leaf, computed rather than declared:

```
L0  character  chat  llm-openai-compat  lorebook  macro  pipeline
    protocol  regex  script  tokenizer                        ← no @iris deps
L1  client-fake  persistence  preset  rpc-client  rpc-host  turn  variables
L2  compat-tavernhelper  mvu
L3  app-service
L4  app  (apps/iris — the composition root)
```

Plus `apps/iris-web`, which is deliberately outside the pnpm workspace.

## The three rules that matter

### 1. `@iris/protocol` depends on nothing

It is the contract, and both trust domains depend on it. If it depended on a
domain package, changing storage would change the wire — and `ScriptChatMessage`
is the live example: it duplicates `@iris/persistence`'s `SillyTavernMessage`
structurally rather than importing it, so the two stay assignable without a cast
and neither drags the other.

### 2. The browser may only see the contract

`apps/iris-web` imports `@iris/protocol`, `@iris/rpc-client` (the real
transport, which itself depends only on the contract) and `@iris/client-fake`.
Nothing else.

This is the rule most worth enforcing and the one least visible: the browser app
reaches workspace code through **Vite aliases, not package.json**, so it appears
as a leaf with no dependencies in any dependency graph. The one package that most
needs a boundary — the untrusted side — is the one no tool sees by default. So
the check reads its source imports instead.

What it keeps out: `persistence` (the storage format), `app-service` (the host's
own logic), `rpc-host`, `llm-openai-compat` (credentials), `character`,
`lorebook`. A browser that could construct a chat file could bypass every check
the host performs on the way in.

### 3. Nothing depends upward

A domain package may not import `app-service`, `rpc-host`, or `app`. Dependencies
point toward the leaves; the composition root is the only place that knows the
whole tree exists.

## Why the browser app is outside the workspace

Not a preference. pnpm cannot extract esbuild on this machine — a deterministic
`ERR_PNPM_EPERM` on rename at every linker setting, reproduced in a clean temp
directory. `apps/iris-web` is npm-managed with its own lockfile and reaches
workspace source through Vite aliases.

The cost is rule 2 becoming invisible to tooling, which is why it is tested.

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
  multi-user authentication is an explicit non-goal (`PLAN.md`).
- **No CI.** Every green claim in this repo is a local run.
- **A real card's production bundle has run to completion in the sandbox**
  (2026-09-01, eleventh live run): a real card's MVU import fetched the actual
  bundle from the whitelisted CDN into an opaque-origin frame, through module
  semantics, the preset libraries, the 28-member Tavern Helper surface and the
  audited event vocabulary, and finished without error. "Ran to completion" is
  the load path's verdict, not the feature's: MVU installs listeners and
  returns, so its work starts at generation time, and the write path stops by
  design at a named refusal until `script.setVariables` lands. The remaining
  absences announce themselves (the missing-library banner, refusals by name).
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
  decision stands; two tests cover its cost — one reads the registration site,
  one asks the running host.
