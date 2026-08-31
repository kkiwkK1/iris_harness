# Deviations from ST-Prompt-Template

Where this package deliberately differs from the extension it is compatible
with, what each difference was measured to cost, and how to re-check it.

Snapshot of upstream **v1.17.4.1** (`zonde306/ST-Prompt-Template`), read from
`public/scripts/extensions/third-party/ST-Prompt-Template/src/`. The extension
has `auto_update: true`, so this document has a shelf life — see
[Re-checking after an upstream release](#re-checking-after-an-upstream-release).

Measurements are over the 19 cards in the user's local library plus the 18 world
books beside them. Where a row says "0 sites", that is a count, not a guess.

## The one that is the point

Upstream evaluates templates **in the SillyTavern page's own realm**. Templates
are arbitrary JavaScript — 1749 `if`, 205 `function`, 139 `try`/`catch`, 118
`for` across the corpus — so upstream is running card authors' code with the
application in scope: `execute()` runs slash commands, `SillyTavern.getContext()`
hands over the whole context, `$` is jQuery bound to the real document.

Iris evaluates in a child process with no environment, no filesystem writes, no
ability to spawn, inside a `vm` realm with no `process`, no `require`, and no
working dynamic import. A template sees the members the corpus actually uses and
nothing else.

**What the corpus reaches for**, counted over both the cards and the disk world
books: `getvar` 537, `getwi` 62, `SillyTavern` 32 (only `.chatMetadata` and
`.saveMetadata`), `setvar` 9, `getMessageVar` 5, `charName` 2, `setLocalVar` 1,
`matchChatMessages` 1, `YAML` 1.

The per-scope shorthands in that list — `getMessageVar`, `setLocalVar` — were
missed by the first census, which counted only the base names, and were found by
the differential script when five fields failed with a `ReferenceError`. They are
implemented now. The two still absent are `matchChatMessages` (needs the chat,
which is not pushed) and `YAML` (deviation 9).

**Cost of everything else being absent: 0 sites.** Nothing in the corpus touches
`execute`, `injectPrompt`, `jsonPatch`, `define`, `getchr`, `getprp`, `faker`,
`activateRegex`, jQuery, zod or toastr.

Everything below is a cost of that decision or an artefact of the engine.

## Deviations

### 1. `define()` does not persist across batches

Upstream keeps `SharedDefines` in module scope, so a `define()` in one generation
is visible in the next. This package runs one child per batch and kills it, so
each batch starts clean.

Bought: no cross-batch state to pollute, no respawn policy, no cache to
invalidate. Measured cost of the fork is 42 ms.

**0 corpus sites** — `define` is never called.

### 2. EJS's template cache is absent

Upstream can cache compiled templates per page session. One child per batch means
no cache survives.

**0 sites in effect**: the user's live setting is `cache_enabled: 0`, so upstream
is not caching either. Measured compile+instantiate+run for 200 templates in one
realm: 71 ms.

### 3. `incvar` / `decvar` resolve against the batch snapshot

Upstream reads, modifies and writes live application state. Here they resolve
against the snapshot and emit a plain `setvar` with the computed value.

Safe because nothing else writes during a batch. It would stop being safe if the
host ever applied a change set mid-batch, which it does not — the host applies
ops after the batch, through its own storage entry points.

**0 corpus sites** — neither is called. `setvar` is (9 sites: 8 two-argument, 1
with `{ scope: 'local' }`).

### 4. Macros inside a `getwi` target are substituted once per batch

Upstream calls `substituteParams` at the moment `getwi` fetches an entry. Here
world-info content arrives already macro-substituted and regexed, because both
are host functions and doing them host-side is what makes the batch one round
trip.

Observable only if a `getwi`-reachable entry contains a non-deterministic macro
(`{{roll}}`, `{{random}}`, `{{pick}}`, `{{time}}`, …) **and** is fetched twice in
one batch.

Measured: all **58** literal `getwi` targets resolve to a real entry — zero
dangling, which incidentally confirms the name-resolution model matches
upstream's — and **0** of them contain a non-deterministic macro.

### 5. `with_context_disabled` is not implemented

Upstream can compile with `_with: false` and `destructuredLocals`. This package
always compiles with `with`.

The user's live setting is `with_context_disabled: false`. Two of upstream's
engine patches are only reachable through that path and are therefore **not
installed**, recorded in `DEFERRED_PATCHES` in `src/upstream.ts` so that whoever
implements the setting brings them along:

- `_JS_IDENTIFIER` widened to `/^[\p{ID_Start}$_][\p{ID_Continue}$_]*$/u`,
  making non-ASCII locals legal.
- The `destructuredLocals` / `_with: false` block restructuring: upstream emits a
  block and a `const __locals` where stock emits a bare `var` and, with `with`
  off, no block at all.

### 6. Most of upstream's environment is absent, and reaching for it is loud

Upstream exposes about ninety names plus every global on the page. This package
implements what the corpus uses: `getvar`/`getVariable`, `setvar`/`setVariable`,
the six per-scope shorthands, `getwi`/`getWorldInfo`, `variables`, the two
bridged `SillyTavern` members, and the scalars.

Reaching for anything else is loud in one of two ways: a bridged object refuses
by name with an `UnsupportedTemplateApiError` (`SillyTavern.getContext` does),
and an absent global is a `ReferenceError` that names the identifier
(`matchChatMessages is not defined`). Both are traceable; neither is
`undefined`.

Throwing rather than returning `undefined` is `SANDBOX.md`'s rule: `undefined`
from a lookup is indistinguishable from "not found", so a card would take a
policy decision for a missing value and fail somewhere later with no trace of
why. The same applies to variable *options* — `withMsg` needs the chat, which is
not pushed, and says so.

### 7. Residual risk: a `vm` escape could still reach the network

Stated rather than papered over. Node's permission model does not gate the
network — there is no `--allow-net` in 24.x, and `process.permission.has('net')`
returning `false` is the absence of a scope, not a refusal. The realm is what
closes that door, by refusing dynamic import.

So the chain "`vm` escape → child realm → dynamic import → network" remains open
*given a `vm` escape bug*, which is a known class and never a boundary on its
own. What could leave that way is the snapshot: chat variables and world-info
text, i.e. data the card can already see. No credentials — the child is forked
with `env: {}`, which is what makes that true rather than hopeful.

Same category as "the browser frame could have a Chromium bug". Recorded, not
pretended to zero.

On Windows, `env: {}` still yields 11 OS-injected variables: `HOMEDRIVE`,
`HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`,
`USERDOMAIN`, `USERNAME`, `USERPROFILE`, `WINDIR`. Down from 85 inherited. No
secrets, but the OS user name and home path do cross, so "empty environment" is
the intent and not literally the state.

### 8. Writing the `initial` scope is refused, though upstream allows it

Upstream's `setVariable` has a `case 'initial'` that writes
`STATE.initialVariables` — an in-memory store that evaporates with the page.

Iris has no equivalent: `initial` is a *projection* of what the card file ships
(`CardScriptBundle.variables` and `@@initial_variables` entries), not a store. So
the write would either vanish silently, which is misleading, or edit the card,
which is a much larger operation than the template asked for — it changes what a
reset restores, permanently, in a file the user may share.

Refused by name instead (`UnsupportedTemplateApiError`), so it never becomes an
op and the host needs no branch for it. Reads of `initial` are unaffected.

**0 corpus sites.**

### 9. A template can reach another extension's page globals; here it cannot

Found by `scripts/template-differential.mjs`, not by reading upstream's source —
which is why the script exists.

Upstream's templates run in the SillyTavern page's realm, so `with (locals)`
falls through to **every global on the page**, not just the ~90 names
`prepareContext` binds. That includes globals installed by *other extensions*.
Measured, TavernHelper (`JS-Slash-Runner`) installs exactly two:

```ts
globalThis.YAML = YAML_object   // the `yaml` package
globalThis.z    = z_object      // zod
```

One corpus field (`命定之诗与黄昏之歌v3.0.4` entry 8) uses `YAML`. It renders in
the operator's SillyTavern and fails here — and the thing supplying it is not the
template engine at all.

Not implemented, because it is a scope decision rather than a bug: supporting it
means a third runtime dependency for one field, and, more importantly, it means
deciding whether this package chases another extension's global surface at all.
`ROADMAP.md` already records that the corpus depends on more extensions than
TavernHelper; this is that problem arriving at the template layer.

Consequence if left: **1 of 196 comparable fields.** The differential script
reports it by name on every run, so it cannot quietly become five.

### 10. The world-info entry sort order is not reproduced

Upstream sorts a loaded book with `worldInfoSorter` (position, depth, order)
before scanning it, so the sort decides which entry wins when more than one
matches. This package scans in the order the host pushed.

Measured unobservable: across the corpus's 58 literal `getwi` targets, **every one
is an exact `comment` hit, none needs upstream's regex fallback, and none matches
more than one entry**. With no ambiguity there is nothing for the sort to decide.

If a future card writes a `getwi` whose target matches two entries, this becomes
observable and the sorter has to be ported.

### 11. No recursion guard on `getwi`

Upstream has none either. A cycle of entries fetching each other overflows the
stack, which lands as one failed item rather than a lost batch. An *async* cycle
that never returns is caught by the deadline instead.

## Engine patches that **are** installed

The extension does not run stock EJS. It vendors 3.1.9 and patches it: six hunks,
92 lines. Three change behaviour in ways reachable from a template, and all three
are reproduced in `src/upstream.ts`:

| Patch | Stock | Upstream | Corpus sites |
|---|---|---|---|
| `__append` arity | appends the first argument | appends all of them, filtering null/undefined | 0 (`print` unused) |
| `outputFunctionName` binding | `var print` | `const print` — a template redeclaring `print` throws | 0 |
| scanner | a delimiter inside a tag's code is "Could not find matching close tag" | nesting-aware pairing, so `<% var re = /<%.*?%>/g %>` compiles | 0 |
| EJS-Lint hint in compile errors | suggests running EJS-Lint | commented out | n/a |

The scanner patch is the one worth caring about: it is a **language extension**,
and a card written against the user's installed engine can rely on it. Its
observable effect is narrower than "nested delimiters" suggests — sequential tags
and upstream's own `@@private` wrapper compile under stock EJS too, so those do
not discriminate it. `tests/upstream.test.ts` keeps both as a negative control,
because the first version of that test asserted the non-discriminating cases and
passed.

Verified once against the vendored engine directly: for ordinary templates the
patched engine emits byte-identical source, and the only textual difference
anywhere is one cosmetic space in the generated `with (locals || {})  {` line,
which comes from upstream's restructured emission and carries no semantics while
`with` is on.

Two patches are hardening or plumbing rather than dialect and are not reproduced:
`utils.hasOwnOnlyObject` on the options object (this package owns the options) and
`e.src` on compile errors (the origin is reported instead).

## Re-checking after an upstream release

`auto_update: true` means the extension moves without asking. To re-diff:

1. Take `src/3rdparty/ejs.js` from the extension. The ejs module is browserify
   module 1: everything from line 2 to the line containing
   `"../package.json":6`.
2. Dedent it by the minimum indentation of its non-blank lines.
3. Diff against `node_modules/ejs/lib/ejs.js` with `diff -u -w -B`, which drops
   the bundle's own reindentation and leaves the real hunks.
4. Check the version in the bundle's embedded `package.json` module (module 6)
   against this package's pin.

If a patch here can no longer be applied, `applySourcePatches` throws
`UpstreamPatchError` rather than silently leaving stock behaviour in place. That
is the intended failure: a quietly skipped patch would leave the package claiming
a dialect it is not running.
