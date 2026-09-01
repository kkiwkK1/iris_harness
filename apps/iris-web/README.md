# `@iris/web` — the browser half

The Iris interface: a reading surface for long AI-roleplay conversations, built on
the DSH web shell.

```
npm run dev            # vite dev server
npm run typecheck      # tsc --noEmit, same strictness as the repo root
npm run check:render   # server-render the tree and assert it produced a page
npm run build          # the app, then the sandbox bootstrap
npm run build:sandbox  # the bootstrap alone (dist-sandbox/bootstrap.js)
```

## Which data you are looking at

The transport is chosen by `src/client/transport.ts`: **a production build talks
to a host, a dev build uses the fake.** `?transport=rpc` or `?transport=fake`
overrides either way — the first works in `npm run dev` because `vite.config.ts`
proxies `/iris/rpc` and `/iris/events` to `127.0.0.1:8787`.

**The page says so when its data is invented.** A seeded-data line sits on the
masthead whenever the fake is in use, and there is deliberately no equivalent for
the real transport: the reason is a failure that already happened here. A
host-served build ran on the fake for two days while an observer checked that the
assets were reachable and that RPC answered — both true, neither of them the
question of whether the *page* was using RPC. Two green checks composed into a
false conclusion, and the seeded character names were on screen the whole time.
That is why the disclosure is permanent and one-directional, and why
`chooseTransport` is a pure function with tests rather than an inline ternary.

**The build has two outputs and they are not interchangeable.** `dist/` is the
app; `dist-sandbox/bootstrap.js` is the card-sandbox bootstrap, built by a second
config as a *classic IIFE* because a card's frame has an opaque origin where a
module script would be CORS-checked. The host reads that file's text and inlines
it into each frame's `srcdoc`. A `dist/` without it looks complete and cannot run
a single card, which is why the bootstrap has its own directory: the app build
runs with `emptyOutDir` and would otherwise wipe it.

`node --test "apps/iris-web/tests/**/*.test.ts"` from the repo root runs the unit
tests (they are also picked up by the root `pnpm test`).

## Why this app is npm-managed

pnpm cannot extract esbuild in this environment (see `spike/RESULTS.md`), so this
app sits outside the pnpm workspace — `pnpm-workspace.yaml` excludes it — and
reaches workspace code through Vite aliases rather than `workspace:*`. The Node
test files rely on the same thing indirectly: they only import modules whose
runtime imports resolve without an alias.

## Boot protocol — do not "simplify"

Three details in `index.html`, `src/main.tsx` and `vite.config.ts` were
established by trial in phase 0 and are load-bearing:

1. **The shell's only service dependency is `uiRenderer`.** Whoever provides it
   owns the whole application surface. That is the seam Iris hangs from
   (`src/ui-plugin.tsx`); nothing from `dsh-client-runtime` or
   `dsh-client-ui-conversation` is loaded.
2. **`@deepseek-ai/dsh-client-modules/client` is not an ordinary module** — its
   body IS a bundle registration, so the registration facade in `index.html`
   must exist before it executes. `main.tsx` therefore imports it *dynamically*.
   A static import hoists above the facade and the app never boots.
3. **`vite.config.ts`'s three `process.*` defines and the `node:module` alias**
   are required, or the vendored Cordis Loader will not run in a browser.

## Layout of the source

| path | what |
| --- | --- |
| `src/ui-plugin.tsx` | the Cordis plugin: builds the client, store and slot registry, provides `uiRenderer`. Everything is created through `ctx.effect`, so an unmount rolls all of it back |
| `src/client/` | `IrisClient` → React. `store.ts` holds the streaming rules; `errors.ts` normalizes refusals into reader-facing copy |
| `src/theme/` | `tokens.css` is the source of truth for colour and type; `bridge.css` maps those onto the `--dsw-*` names the borrowed primitives read; `theme.ts` owns the per-device preferences |
| `src/slots/` | Iris's extension points, declared on `SlotCore` and rendered by our own `<Slot>` |
| `src/app/` | the surface: shell, sidebar, reading column, message, variant rail, composer, settings |
| `tools/render-check.tsx` | asserts the tree renders and that a disposed slot contribution leaves nothing behind |

## The design, in one paragraph

A proof sheet under a desk lamp at one in the morning: a cool grey-blue ground,
warm off-white ink, and one accent — verdigris, the colour aged iron-gall ink
oxidizes to — spent only on the variant rail and on focus. The model's prose is
typeset in a serif at a book measure; the reader's own lines are set in the UI
sans and subordinated, which is what replaces bubbles and avatars. Alternate
generations are treated as **variant readings** of the same beat and notated the
way a critical edition notates them: a quiet ladder of ticks in the margin, one
per reading, the current one filled. Reasoning is a footnote, collapsed by
default. Fonts are system stacks with CJK fallbacks, because a local-first app
must render identically with the network down.

## The variant rail's two forms

The rail is a ladder of ticks, one per reading — but only while the ticks are
countable. `src/app/rail.ts` holds the threshold (8) and the reasoning; the short
version is that two constraints agree on roughly the same number. The rail must
never be taller than the message it annotates, and a one-line reply is about
80px against 7px per tick; and a ladder earns its place by being countable at a
glance, which thirteen ticks are not.

Past the threshold it becomes a fixed-height stepper — `▲ 7/14 ▼` stacked
vertically, so earlier readings stay up and later ones stay down and the ladder's
axis survives the change of form. This is not a defensive case: the nineteen
cards on the development machine carry `0,0,0,0,0,0,0,0,0,0,0,1,1,2,4,6,10,10,13`
alternate greetings, so one already needs fourteen cells, and regenerations stack
on top with no ceiling.

## The card-script sandbox, browser side

Policy is `SANDBOX.md`. What lives here is its implementation, plus one
architectural decision that document leaves open.

**The frame is cross-origin.** `sandbox="allow-scripts"` with no
`allow-same-origin` puts a card in an opaque origin, so the browser itself
refuses its reach into the host page. That decision is what makes the rest
legible: shadowing `window`, `parent`, `self`, `globalThis` and `top` as
function parameters (`sandbox/frame.ts`) is the **compatibility** layer, not the
boundary. It exists so a card reaching for `parent.document.body` gets something
useful. A card that evades it — `Function('return this')()`, `frameElement` —
reaches the real, cross-origin parent and is stopped by the browser. The sandbox
fails closed.

A same-origin frame with only shadowed identifiers is the opposite: one
`Function('return this')()` and the card is in the host page. That is what
upstream ships, and it is the reason for the divergence.

A grant therefore means the frame runs with `allow-scripts allow-same-origin` —
the one combination that is knowingly not a sandbox. `frameSandbox()` is the
single place that string is assembled.

| file | what |
| --- | --- |
| `sandbox/errors.ts` | `UnsupportedApiError` / `ReadOnlyApiError`. A refusal throws and names the member, because `undefined` from a DOM lookup is indistinguishable from "not found" |
| `sandbox/virtual-document.ts` | `parent.document`: the real viewport size, the card's own container as `body`, three scoped lookups, three node factories, and a wall |
| `sandbox/policy.ts` | frame origin per grant, the remote allowlist, and the globals that are planned-but-unbridged |
| `sandbox/protocol.ts` | the host↔frame messages, validated in both directions against a per-run token |
| `sandbox/frame.ts` | the frame-side installer, dependency-injected so the decisions it makes are testable under `node --test` |
| `sandbox/frame-entry.ts` | the second build entry: adapts the real frame realm to `FrameEnv` and holds no policy of its own |
| `sandbox/srcdoc.ts` | the frame's markup, including its own CSP and the inlined bootstrap |
| `sandbox/runner.ts` | host side: create, feed, size, dispose. The thinnest module here, because it is the only one a browser is required to exercise |

**CSP does work here, just not the work it was ruled out for.** It cannot forbid
`eval` — the card blobs are webpack output that evals per module — but pinning
where code may come *from* is a separate capability, and the frame's policy
allows eval while restricting script origins to the measured allowlist. It is a
second line: a page cannot police its own fetches, so the host's `script.fetch`
stays the enforcement that counts.

**One sequencing rule is load-bearing.** The context snapshot must reach the
frame before the card body does. Cards call `SillyTavern.getContext()`
synchronously and a cross-origin frame can only be addressed asynchronously, so a
card that ran first would see no host at all. `runner.ts` posts context, then
viewport, then `run`.

## Two ways a card body runs

Card scripts run as **modules**; Iris's own probe runs **classic**. That is not a
heuristic — `panel/script/iframe.ts` in the installed Tavern Helper builds every
script iframe with `<script type="module">`, unconditionally, and sniffing the
source instead would make cards behave differently for reasons their authors
could not predict. `mode` therefore travels on the `run` message and is required:
defaulting it would mean a frame silently choosing semantics, and the resulting
`Cannot use import statement outside a module` points at the card rather than at
the choice.

A module cannot be handed shadowed parameters, so its bridge is **real properties
on the frame's own window** — which is again how upstream does it, via a classic
`predefine` script that flattens its API onto the child before the module runs.
The body reaches the module system as a `blob:` URL, needing no new CSP
allowance because `blob:` is already in `script-src` for the injected layer.

Whether `parent` and `top` can be redefined at all is a browser fact this project
cannot settle from outside a browser, so the frame **attempts it and reports what
it achieved** (`globals` message) rather than assuming either answer. The classic
path stays for the probe, which exercises the shadowed globals a module cannot
receive, and it is what keeps `unsafe-eval` covered.

## Why the sandbox reports so much about itself

A card frame is cross-origin, and **a cross-origin frame's uncaught errors never
reach the parent's console**. That single fact shapes the diagnostics: from
outside, a bootstrap that threw before its first message is indistinguishable
from one that was never asked to run — clean console, no frames, a status stuck
on "running". Someone lost a verification run to exactly that ambiguity.

So three things report rather than assume:

| signal | what it settles |
| --- | --- |
| `bootstrap-error` | the frame died before it could speak. Sent **without** a run token, because what it reports may be "the token never arrived"; accepted on `event.source` alone and believed only as a diagnostic — it can neither run code nor change state. Three tests pin that this bypass is exactly one message wide |
| `globals` | which of the published names — `parent`, `top`, `SillyTavern`, `extension_settings`, and the 27 Tavern Helper members — the frame could actually define on its own window. Whether `parent` is redefinable is a browser fact this project cannot settle from outside a browser, so the frame attempts it and says what it achieved |
| the 8-second silence timeout | "stuck at running" was the one state that could not explain itself. Readiness now splits it in two: stalled before `frame ready` means the frame never started; stalled after means the body never finished |

### What the instrumentation actually bought

Eleven runs took a real card from "the renderer froze" to "ran to completion".
The point of writing them down is not the destination — it is that **every
failure was deeper than the one before it, and every one had a name**. That
monotonicity is what the reporting is for. Without it a run says "stuck at
running" and the next run says "stuck at running", and there is no way to tell
progress from repetition.

| # | what failed | what it cost to find |
| --- | --- | --- |
| 1 | a wedged Chrome renderer | a browser restart; `useIrisActions()` returned a value whose identity changed on every write |
| 2 | infinite render loop | the same root cause, now visible instead of fatal |
| 3 | Vite rewrote the bootstrap into a module | a parse-time error a runtime reporter can never catch — moved to `public/`, and `checkBootstrap` now refuses it before injection |
| 4 | the frame severed its own voice | `publishGlobals` redefined `window.parent`, and `post()` read the channel late. Now captured at boot, pinned by a build assertion |
| 5 | module vs classic semantics | upstream runs every card as a module; the mode is carried, never sniffed |
| 6 | six library globals missing | one crash per round became one report naming all six |
| 7–8 | the 28-member facade, then `getScriptId` | the facade seam turned out to be a package boundary, not a missing function |
| 9 | `YAML is not defined` | zero diagnosis cost: the banner had named it three runs earlier |
| 10 | `$ is not defined` | not a missing library — a missing *injection source*. See below |
| 11 | — | ran to completion |

Run 10 is the one worth keeping. The error looked like runs 6 and 9, and the fix
that pattern suggests — bundle the library — would have been right by accident
and wrong in method. `$` is not seeded by `predefine.js` at all; upstream injects
`parent_jquery.js` as a separate script, and our model of the injected layer had
two entries where it should have had five. Reading the consumer's own build
config (MVU declares its externals as `$`, `_`, `showdown`, `toastr`, `Vue`,
`VueRouter`, `YAML`, `z`) is a better source for "what does a card expect to
exist" than reading the injector, because it is the side that has to be right.

### Why a refusal beats a plausible default

The rule this half keeps returning to: **when the honest answer is unavailable,
refuse by name rather than substitute something reasonable-looking.** It reads
as pedantry until you follow one case through.

`updateVariablesWith` reads a variable scope, hands it to the card's updater, and
stores the result. When the frame could not read a scope, the tempting fallback
was to pass the updater an empty object. That does not merely lose data — the
updater returns a tree built from nothing, the write succeeds, and the call
**returns normally**. The card is told its update was applied. State is destroyed
and success is announced in the same breath, so the caller has no reason to retry
and no signal that anything went wrong. A thrown refusal at least leaves a handle.

The same shape appears in `getVariables` answering `{}` for a scope it cannot
see: a card reads that as "not initialised yet" and writes its defaults over
whatever was really there. Both are cases where being helpful costs more than
being unhelpful, because the failure is silent and the damage is upstream of
where anyone would look. (The host settled the honest version of this: an empty
scope the host *reports* as empty is a legitimate starting point. Empty because
you could not look is the one that lies.)

The same run produced a false positive from `check-preset.mjs` — `$ (present but
not usable)` against a bundle that was fine, because jQuery's UMD picks its
export shape from `window.document` at load and the checker deliberately supplies
none. An instrument asserting about a branch production never takes is worse than
no instrument. It now asks only what that environment can answer.

### The harness record lives on `globalThis`

Not tidiness — three rounds of the same lesson. It started in component state and a
remount erased it. Moving it out of React was not enough: I could not determine
what was unmounting, and guessed wrong twice. Moving it out of the module was the
third step, because Vite replaces a module on edit and takes any module-scoped
record with it — so "the record survives" was false in development, which is the
only place this harness runs. A global slot is immune to all three, and for a tool
whose entire job is to still be holding what it saw, that is the right amount of
ugly.

The same reasoning changed the frame's lifetime here: in the harness it lives
until Stop, not until the panel unmounts. "A frame must not outlive its owner" is
right for the product and wrong for an observation tool, where losing the window
destroys the observation.

## Contract notes for the host half

Requests against `@iris/protocol`, in rough order of how much they cost to work
around from here. All are additions; nothing existing needs to change shape.

1. **`IrisClient` has no connection-change notification.** `connected` is
   therefore re-read on every pushed frame, which means the offline banner waits
   for unrelated traffic before it appears. Either a
   `{ type: 'connection', connected: boolean }` event or an
   `onConnectionChange(listener): () => void` on the interface would fix it.
2. **`MessageView.id` is a positional index, so it is not a stable React key.**
   After `chat.deleteMessage` every later id shifts, and React reuses component
   instances across what are now different messages — an open inline editor can
   end up attached to the wrong row. A `key: string` that is merely stable for
   the lifetime of one open chat would be enough; it need not be durable.
3. **Is `RpcError` an `Error`?** The contract says `call` rejects with an
   `RpcError` *shape* and does not say whether that value is an `Error` instance.
   `src/client/errors.ts` accepts both rather than guessing, but the two halves
   should agree rather than each covering for the other.
4. **`settings.set` and the meaning of `null`.** This half sends `null` for "drop
   this optional field and use the host's default", because an omitted key
   already means "leave it alone" in a partial patch and so cannot express it.
   Unknown keys are dropped rather than stored, so a typo cannot look supported.
   The host must read `null` the same way or the panel's "use host default"
   control fails silently.
5. **`chat.regenerate` addresses only the last reply**, which is what this UI
   offers. Regenerating an earlier turn would mean discarding everything after
   it; that is a different operation and the protocol does not have one.

## Running something in a real frame

`npm run build:sandbox`, then `npm run dev`, then Settings → **Sandbox probe
(dev)**. The panel is gated on `import.meta.env.DEV`, so the branch is statically
dead in a production build and the harness and runner drop out of the bundle
entirely (verified by grepping the built chunks).

It runs a purpose-written probe body rather than a real card, and that is the
point: OVERLORD's nine scripts would fail in nine unrelated ways, none of which
would say whether the *frame* works. The probe answers only what a browser is
required for —

| question | why only a browser can answer it |
| --- | --- |
| does `new Function` / `eval` run in an opaque-origin frame under `unsafe-eval`? | if not, no real card runs at all, and CSP was ruled out as the *isolation* mechanism precisely because these blobs need eval |
| does the `ResizeObserver` height report size the frame? | the whole card-UI surface depends on it |
| does `parent.document.documentElement.clientWidth` return the host viewport? | ten of the fourteen measured `parent.document` sites read exactly this; zero would mean the push never landed |

It also checks that a refusal arrives as a throw naming the member rather than as
`undefined`, and that an extension-settings write reaches the shell.

The probe renders its findings into its own body because the frame is
cross-origin — the shell cannot read the frame's DOM, and card code has no channel
of its own. What the shell *can* observe (that the body ran, the height it
reported, any refusal) is shown beside the frame.

## Known gaps in this half

- **`UNBRIDGED_GLOBALS` is empty, and that is the rule working.** It lists
  globals that are planned but unwired so a refusal can say "not yet" rather than
  "no", and each entry is deleted as its bridge lands. `SillyTavern` and
  `extension_settings` went first; `eventSource`, `event_types` and
  `TavernHelper` followed once the card surface was built. The mechanism stays
  for the next measured-but-unbuilt name.
- **A `typeof` probe on an unbridged bare global still fails quietly**, and no
  amount of shadowing closes that. `if (parent.chat)` throws and names the member;
  `if (typeof chat !== 'undefined')` simply takes the false branch. The only fix
  is to bridge the name — which is why the bridged set is as wide as it is.
- **Extension-settings write tracking is shallow.** A top-level assignment
  (`extension_settings.x = computed`, the shape the corpus was measured to use) is
  reported to the shell. A mutation deeper inside an object that already exists is
  not, and would need either a deep proxy or an explicit save call from the card.

- **The visual design has now been looked at, within a stated range.** A ten-item
  pass ran against the production build on a real host, real card and real model,
  in both themes at 1440-class width: reading-first type, bottom anchoring
  (28px from the last message to the composer on a two-message chat),
  hover-revealed actions, theme parity (body 13.9:1, turn ordinal 8.28:1 in
  dark), the rail's ladder form, paper-and-desk, panel copy, the connection
  route, and streaming. **Two things in that list are still unverified**: the
  rail's *compact* form — reachable now without spending anything, via the
  **Variant rail preview** in the settings drawer under `npm run dev`, which
  hands the real component a count instead of generating nine readings — and the
  *mid-stream* state, which the model outran — a 2.5s
  sampling window caught only the settled result, and "no flicker was seen" is
  not "no flicker occurs". Both are still carried by `check:render` and the unit
  tests alone. Nothing outside that range — narrow widths, motion, drag-and-drop
  — has been seen either. `npm run check:render` remains a substitute, not a
  replacement. (Note: killing the `npx` wrapper leaves the child `node` process
  holding the port — kill it by PID, or the next build cannot write.)
- **The renderer stalls intermittently on chats with very large highlighted code
  blocks.** Observed as repeated screenshot timeouts against a card whose opening
  message is a full-page HTML block; retrying always worked, and nothing else
  misbehaved. Left alone deliberately: when card UI moves into the message frame
  that block stops being syntax-highlighted page content, so the likeliest fix is
  a pipeline that is already planned. Worth re-checking rather than pre-emptively
  optimising.
- The lorebook editor is not built; `PLAN.md` schedules it after the core path.
- **Card scripts now start when a chat opens**, once the user has answered the
  run-scripts question for that card. The frame set's lifetime is "this chat is
  in the foreground"; leaving tears it down completely. Grants are re-resolved
  from the host at the moment of running rather than read from the store, because
  that cache is keyed on a character id and character ids are reused. Failures
  land in the panel and the notice bar, never in the conversation. The policy is
  `AUTORUN.md` and the reasoning behind its permission clauses is `GRANTS.md`.
- **A card's frame does not survive edit mode.** Re-rendering the message a card
  lives in tears the frame down and builds a new one, which restarts the card:
  its listeners, its Vue app and any state it kept in the frame are gone, and a
  card that registered on `mag_variable_initialized` will not see the event
  again. Upstream keeps the element and re-parents it. Fixing this needs the
  card-UI-in-message pipeline first, because the frame has to belong to something
  more durable than the rendered message — the harness already does this the
  right way for its own reasons (the frame lives until Stop, not until the panel
  unmounts) and that is the shape to copy.
- `character.import` reads PNG and JSON well enough for the library row. `.charx`
  is passed through as base64 and falls back to the filename, because real
  decoding belongs to the host's `@iris/character`.
- `src/client/store.ts` narrows on `event.type` directly instead of the
  protocol's `isEvent`, which leaves it with no value imports from
  `@iris/protocol` — that is what lets the streaming state machine be tested
  under plain `node --test`. Reverting to `isEvent` would cost those tests their
  runner.
