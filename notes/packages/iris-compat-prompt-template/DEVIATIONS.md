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

> **2026-09-11.** This entry was right about the residual risk and wrong about
> where the risk was. It assumed the only way into the child's main realm was a
> `vm` **bug**. There was a way in by construction — `escapeFn.constructor`,
> deviation 12 below — and it needed no bug at all, so "remains open *given a
> `vm` escape bug*" was an understatement for as long as the entry has existed.
> The paragraph above is true again now. What it was missing is that a realm
> boundary is a property to be built and tested, not one a `vm.createContext`
> call confers.

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

### 12. Nothing of the child's own realm reaches a template — 2026-09-11

Upstream hands a template the whole SillyTavern page and there is no boundary to
speak of, so this is not a deviation *from* upstream in the usual sense. It is a
correction to a boundary this package had claimed and did not have.

**What was open.** EJS compiled with `client: true` emits a function of four
parameters, and the extension's dialect names three of them in the template's own
scope: `escapeFn`, `include`, `rethrow`. Until this date `child.ts` passed the
child main realm's own functions for all three:

```ts
return await instantiated.call(locals, locals, identityEscape, stubInclude, rethrow)
```

A function carries its realm. So `escapeFn.constructor` was the **child main
realm's** `Function`, and the code it builds runs there rather than in the `vm`
context. Measured against the code as it stood, on this machine:

| probe | what it answered |
| --- | --- |
| `escapeFn.constructor === (function(){}).constructor` | `false` — a foreign `Function` |
| `escapeFn.constructor('return process.pid')()` | `11904` — the child's real pid |
| `escapeFn.constructor('return typeof fetch')()` | `function` |
| `include.constructor` / `rethrow.constructor` | same reach |
| `getvar.constructor` / `setvar.constructor` | same reach — every `locals` member was a closure of this realm |
| `getvar('obj').constructor.constructor` | same reach — a **value** carries its realm too |
| `this.constructor.constructor` | same reach — so did the `locals` receiver |
| `SillyTavern.chatMetadata.constructor.constructor` | same reach |

From the child's main realm, `globalThis.fetch` is a function, `process` is an
object, and `process.send` is the IPC channel this package's protocol rides — so
a template could also have forged an `item` or `done` frame back to the host.
`import('node:https')` happened to fail from a `Function`-constructed body (no
referrer), but `fetch` needs no import. The `vm` context's refusal of dynamic
import, which deviation 7 calls "the thing that closes that door", was irrelevant:
the escape was not in the context.

Reachable whenever the prompt-template feature is on — originally spelled
`IRIS_TEMPLATES=1`, which is now only the boot default: the user-facing switch
(`template.setSettings`, persisted in the profile's `settings.json`) decides at
call time, `notes/FEATURE-PROMPT-TEMPLATE.md` §4.1. `script.evalTemplate` is in
`CARD_METHODS` — so any card with script consent, not only a card whose fields
are evaluated during a generation.

**The mechanism, in `src/realm.ts`.** Structural rather than a list of patched
names, because a list is exactly what missed `getvar('obj').constructor` the
first time:

- **Every callable crosses as a trampoline built inside the context.** A factory
  compiled with `vm.runInContext` in strict mode returns `function (...args) {
  return body(this, args) }`, frozen. `trampoline.constructor` is the context's
  `Function`; the host closure `body` lives only in a closure variable; `caller`
  and `arguments` are poisoned accessors on a strict function and
  `arguments.callee` throws.
- **Every value crosses re-created**, through the context's own `JSON.parse` on a
  serialisation, so its prototype chain is the context's. Primitives cross
  unchanged, because a number carries no realm.
- **Errors and promises are values.** A host refusal reaches template code as a
  context `Error` with the same `name` and `message` (and a stack trimmed to
  those two, so this package's file paths do not travel); a host promise is
  adopted into a context `Promise`. Otherwise `catch (e) { e.constructor }` and
  `getwi(…).constructor` are the same escape in different clothes.
- **Libraries are instantiated in the context.** lodash already was. That also
  fixed a quieter bug: lodash's `isPlainObject` compares against *its own*
  realm's `Object.prototype`, so a host lodash asked about a template's object
  literal answers `false` — which is `getwi`'s overload test and `setvar`'s merge
  test.
- **`instanceof RegExp` is gone** from `matchesEntry` for the same reason. The
  corpus's one computed `getwi` target is ``new RegExp(`^${charName}$`)``, built
  in the template's realm, so the branch never fired for the regexes that
  actually arrive — and where it did fire it took `RegExp.test` while upstream
  takes `String.match`. One predicate now, upstream's, for every realm.

**Where the state lives, and what it cost.** The obvious reading of "re-create
every value that crosses" is to convert on each `getvar` return. That is both
slower and *wrong*: upstream's `getvar('stat_data')` hands back a live reference,
so a card writing `getvar('stat_data').hp = 5` writes the cache, and a per-call
copy drops that silently. So the variable state is built **inside** the realm
once per batch — `createState` parses the pushed JSON with the context's
`JSON.parse` and mutates it with the context's lodash — and `getvar` keeps
handing out live references.

Measured 2026-09-11 on this install's heaviest chat, a **708,022-character**
variable blob:

| | round 1 | round 2 | round 3 |
| --- | --- | --- | --- |
| `createState` **inside the realm** | 9.6 ms | 10.9 ms | 10.2 ms |
| the host-realm `_.cloneDeep` it replaced | 9.7 ms | 9.9 ms | — |

So the realm re-creation is free to within the noise of the deep clone that was
already there, and is **0.5% of the 2000 ms deadline**. The heaviest batch this
install can produce at all — that blob, all 1,478 world-info entries (6.79 MiB of
snapshot) and all 203 templated entries as items — runs end to end through a real
forked child in **257–276 ms**, 201 of 203 items rendering. World info is *not*
converted wholesale: only the entry a `getwi` actually matched crosses, and
`entry.content` is a string.

**The three limits.** Each is a measurement, not a round number:

| limit | value | basis |
| --- | --- | --- |
| child heap | `--max-old-space-size=128` | peak `heapUsed` on the heaviest batch above was **46.3 MiB** (22.4 MiB old space), two rounds agreeing to 0.2 MiB. 2× is 93; the 128 MiB floor wins, kept as a floor so the flag is never tighter than Node needs to boot. |
| children at once | 1 | a fork plus a multi-megabyte snapshot plus a heap ceiling, N times over, for work that is not latency-critical. A second batch waits; the queue survives a rejected batch. |
| item text | 1,048,576 characters | largest single templated field in the corpus **19,399** (`命定之诗与黄昏之歌v3.0.4`, entry «双子星的咏叹调-本体»); heaviest book's templated entries **356,328** in total; every templated field in all 19 cards **560,233**. An item is an assembled *message*, so the sum is the number to clear: the cap is 1.87× all of it, and ~260k tokens of prompt. |

The cap refuses by name — `template text is N characters, over the 1048576
character limit for one item` — rather than leaving it to the deadline, because a
huge template compiles for seconds and then dies by `SIGKILL`, which reaches the
caller as "timed out" and names no item. The other items in the batch are
unaffected.

**What would overturn this.** Any of:

- A measurement showing `createState` inside the realm costing a meaningful share
  of the deadline on a real snapshot — the alternative would be to re-create per
  crossing and accept the loss of the live reference, which is a compatibility
  cost and would need its own entry.
- A corpus template that depends on holding a host object — there is no such
  thing today, and by construction there cannot be one that is also compatible
  with upstream, since upstream's "host objects" are page objects.
- A real prompt item over 1 MiB, or a real batch peaking over 64 MiB of heap.
  Both are measurements this entry can be re-run against.
- Node gaining an `--allow-net` (or a `vm` API that refuses network by
  construction), which would make the realm boundary the second line rather than
  the only one.

Pinned by `tests/realm.test.ts` (35 tests): 24 constructor probes, a promise probe, a
rejection probe, the `arguments.callee.caller` walk, the freeze, the guarded
object's refusal, an `import('node:https')` route through a bridged function's
constructor, and a sweep that walks the whole scope asserting every reachable
object belongs to the context with a floor on how many it visited. The **control**
is `probes the harness itself`: the same probe run against `identityEscape`
installed on the scope unbridged — it must come back `foreign` and must actually
reach `process`, or every `context` above would be a claim about a blind probe.
Twelve mutations, each reddening a named test, are recorded in the commit.

## Engine patches that **are** installed

The extension does not run stock EJS. It vendors 3.1.9 and patches it: six hunks,
92 lines. Three change behaviour in ways reachable from a template, and all three
are reproduced in `src/upstream.ts`.

**The pin is `ejs` 3.1.10, moved 2026-09-11** — one release ahead of what the
extension vendors. 3.1.10 is 3.1.9 plus CVE-2024-33883: `utils.hasOwnOnlyObject`
and `utils.createNullProtoObjWherePossible` applied to the options and data
objects, so nothing reaches an option through `Object.prototype`. Re-checked
against the table below and nothing in it moved:

| what | 3.1.9 | 3.1.10 |
| --- | --- | --- |
| `applySourcePatches` anchors (`function __append(s) …`, `var print = __append;`) | match | **match** — both preamble patches apply byte for byte, asserted by `tests/upstream.test.ts` |
| `installNestedDelimiters` (`Template.prototype` shape, `opts.delimiter` reads) | applies | **applies** — `this.opts` is now a null-prototype object, which the patch reads the same way |
| `stripLintHint` (the EJS-Lint message) | strips | **strips** |
| `utils.hasOwnOnlyObject` on options | extension-only | **stock has it** — the row below moves |

That last row is the only diff with a consequence, and it is a *narrowing*:
`hasOwnOnlyObject` was one of the two hunks listed below as "hardening rather
than dialect and therefore not reproduced". Stock now carries it, so the distance
between the pinned engine and the extension's is one hunk smaller than the
paragraph below describes.

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

**2026-09-11:** the first of those two is no longer a difference at all. Stock
3.1.10 — the pinned version — applies `hasOwnOnlyObject` itself, as part of
CVE-2024-33883, so the pinned engine and the extension's now agree on it. One
unreproduced hunk remains, `e.src`.

## Re-checking after an upstream release

`auto_update: true` means the extension moves without asking. To re-diff:

1. Take `src/3rdparty/ejs.js` from the extension. The ejs module is browserify
   module 1: everything from line 2 to the line containing
   `"../package.json":6`.
2. Dedent it by the minimum indentation of its non-blank lines.
3. Diff against `node_modules/ejs/lib/ejs.js` with `diff -u -w -B`, which drops
   the bundle's own reindentation and leaves the real hunks.
4. Check the version in the bundle's embedded `package.json` module (module 6)
   against this package's pin. They are **not** expected to be equal: the pin is
   deliberately 3.1.10 against the extension's 3.1.9, so the question is whether
   the extension has moved past 3.1.10, not whether the two match.

If a patch here can no longer be applied, `applySourcePatches` throws
`UpstreamPatchError` rather than silently leaving stock behaviour in place. That
is the intended failure: a quietly skipped patch would leave the package claiming
a dialect it is not running.
