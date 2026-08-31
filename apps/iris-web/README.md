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

## Known gaps in this half

- **The sandbox's host-side frame lifecycle is designed, not built.** Creating
  the iframe, getting the bootstrap into it, sizing it and disposing it is the
  one part that cannot be exercised without a browser, and it has an open
  dependency: the bootstrap has to reach an opaque-origin frame, which means
  either a classic script served from a stable same-origin path or the host
  inlining that text into `srcdoc`. Both need the host half to serve an asset.
- **`UNBRIDGED_GLOBALS` is deliberately stale-able.** It lists globals that are
  planned but unwired so a refusal can say "not yet" rather than "no". Each entry
  must be deleted as its bridge lands — `SillyTavern` and `extension_settings`
  already have. What remains: `eventSource`, `event_types`, `TavernHelper`.
- **A `typeof` probe on an unbridged bare global still fails quietly**, and no
  amount of shadowing closes that. `if (parent.eventSource)` throws and names the
  member; `if (typeof eventSource !== 'undefined')` simply takes the false branch.
  The only fix is to bridge the name.
- **Extension-settings write tracking is shallow.** A top-level assignment
  (`extension_settings.x = computed`, the shape the corpus was measured to use) is
  reported to the shell. A mutation deeper inside an object that already exists is
  not, and would need either a deep proxy or an explicit save call from the card.

- **Nothing here has been looked at in a browser.** `npm run check:render` is a
  substitute, not a replacement: it proves the tree renders and that a disposed
  slot contribution leaves nothing behind, and it is blind to layout, colour,
  motion, scrolling and drag-and-drop. Open `npx vite preview` before trusting
  the visual design. (Note: killing the `npx` wrapper leaves the child `node`
  process holding the port — kill it by PID, or the next build cannot write.)
- The lorebook editor is not built; `PLAN.md` schedules it after the core path.
- Card-script sandboxing is out of this half's scope entirely.
- `character.import` reads PNG and JSON well enough for the library row. `.charx`
  is passed through as base64 and falls back to the filename, because real
  decoding belongs to the host's `@iris/character`.
- `src/client/store.ts` narrows on `event.type` directly instead of the
  protocol's `isEvent`, which leaves it with no value imports from
  `@iris/protocol` — that is what lets the streaming state machine be tested
  under plain `node --test`. Reverting to `isEvent` would cost those tests their
  runner.
