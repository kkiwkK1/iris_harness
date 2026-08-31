# `@iris/web` — the browser half

The Iris interface: a reading surface for long AI-roleplay conversations, built on
the DSH web shell.

```
npm run dev            # vite dev server
npm run typecheck      # tsc --noEmit, same strictness as the repo root
npm run check:render   # server-render the tree and assert it produced a page
npm run build          # production bundle
```

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
