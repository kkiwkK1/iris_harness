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

## Contract notes for the host half

- `IrisClient` has no connection-change notification, so `connected` is
  re-read on every pushed frame. A `connection` event would let the offline
  banner appear without waiting for unrelated traffic.
- `MessageView.id` is a positional index, so it is not a stable React key across
  a delete. Local per-message UI state (an open editor) can attach to the wrong
  row after `chat.deleteMessage`.
- The protocol says `call` rejects with an `RpcError` *shape* but not whether the
  value is an `Error`. `errors.ts` accepts both.
