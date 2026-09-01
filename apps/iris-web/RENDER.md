# Message-frame rendering — design

For the card interfaces that live inside a message: a code block whose contents
look like a front end becomes a live, sandboxed frame. Written before the code,
per the same discipline as `AUTORUN.md` and `COHABITATION.md`.

Measurements here come from three sources and are attributed, because the design
leans on them and a reader has to be able to check the right one:

- **[upstream]** — line numbers into the installed JS-Slash-Runner, measured by
  `iris-cordis-traven-d7`, paths relative to
  `data/default-user/extensions/JS-Slash-Runner/`.
- **[corpus]** — the local 31 chats / 19 cards / 18 world books, measured by
  `iris-cordis-traven-3e`, reproducible as `npm run census:frontend-blocks`.
- **[here]** — read in this repository while writing this.

The upstream readings were taken **twice, independently**, before either party saw
the other's: the trigger rule, the settings, the depth semantics, the naming
grammar, the height mechanism, the library lists and the `parent_jquery` detail
agreed in every particular. Three facts below are marked **[+]** where the second
reading added something the first had not reached.

## What the feature actually is

Upstream scans each rendered message for a `<pre>` that looks like a front end and
replaces it with an iframe running that markup. It is how a card ships a status
panel, an inventory screen, a settings dialog — the thing a reader sees *instead
of* a wall of HTML source.

It is also where `getCurrentMessageId()` finally has an answer. Today Iris throws
for it, correctly: a script frame is not a message frame, and upstream throws too.
A message frame knows its own floor, and that single fact is what makes
floor-anchored variables possible.

## Measured: what upstream actually triggers on

**Not a fenced `html` block. Three substrings, by containment.** [upstream]
`src/util/is_frontend.ts:1-3`:

    export function isFrontend(content: string): boolean {
      return ['html>', '<head>', '<body'].some(tag => content.includes(tag));
    }

None of the three is a complete tag: `'html>'` matches `</html>` as well as
`<html>`, and `'<body'` has no closing bracket, so `<body class=…>` hits. This is
containment, not parsing.

Applied only to `<pre>` elements, and to their **text**, not their source
[upstream] `src/store/iframe_runtimes/message.ts:13-14`:

    $(div).find('pre').filter((_index, pre) => isFrontend($(pre).text()))

Three consequences the implementation has to carry:

1. **The fence's info string is never read.** A block labelled `text` renders
   exactly like one labelled `html`. Routing by language is not available — and
   the single corpus hit is labelled `text`, so this is not hypothetical.
2. **Indented code blocks also become `<pre>`.** A caliper that counts only fences
   under-counts. [corpus] measured both; the indented population is 0 here, which
   is luck rather than licence.
3. **`.text()` is entity-decoded.** Source that reads `&lt;body` presents as
   `<body` and therefore hits. [corpus] measured this too: 0 here.

**Switches: three, all global.** [upstream] `src/panel/Render.vue:118-120`,
`message.ts:41-55, 77-90`.

| setting | effect | source |
| --- | --- | --- |
| `render.enabled` | master switch; off clears every runtime | `message.ts:83-90` |
| `render.depth` | render only the last N floors; `0` = every displayed floor | `message.ts:41-55` |
| `render.depth_ignore_hidden` | skip `is_system` floors when counting depth | `message.ts:51-54` |
| `render.allow_streaming` | hands the work to a separate streaming pipeline | `message.ts:16-19` |

**There is no per-card and no per-message switch.** [upstream] searched
`settings.render`, card `extensions` and message `extra`. The only per-message
granularity is the `depth` window.

In the user's own install [upstream, disk] `settings.json` →
`extension_settings.tavern_helper.render`: `allow_streaming: false`,
`use_blob_url: false`, `use_cleanup_protector: false`, `depth: 0`. So the
streaming pipeline's quirks are dormant for this user, and `depth: 0` means
upstream's own escape valve is switched off.

**Regex runs before the trigger, and not in the same layer.** SillyTavern applies
display-placement regex inside `messageFormatting` (`public/script.js:1809`), and
the extension scans the *resulting* DOM. So a display regex that removes `<body`
changes whether a block becomes an interface at all. A pipeline that put its
trigger before the regex would behave the opposite way round.

## Measured: what the local corpus contains

[corpus], caliper: a renderable text (swipe-expanded) containing a fenced **or
indented** block whose body, **after entity decoding**, contains one of the three
substrings.

| population | hits |
| --- | --- |
| 31 chat files, 2522 renderable texts | 1 |
| 19 cards, 1482 text fields | 1 |
| 18 disk world books, 1478 entries | 0 |
| **distinct blocks** | **1** |

The columns overlap and must not be summed: the hit is a card's `first_mes`, which
is also message 0 of that chat. The census prints the distinct count for exactly
this reason.

**The one hit is a loader, not an interface.** `干物吸血鬼少女与夜间工作`'s
`first_mes`, 675 bytes, fence labelled `text`. Its visible content is fallback
diagnostics — *"if you can see this for a long time, something has gone wrong…
did you install Tavern Helper? or turn rendering off?"* — and the real interface
is fetched at render time, with `$('body').load(...)` pointing at
`files.yuzuki-rii.xyz`.

That host is **not** on the remote allowlist (`SANDBOX.md`: `*.jsdelivr.net`,
`raw.githubusercontent.com`), so under current policy the fetch is refused and the
user sees the author's own red fallback text.

**This is why there is no local acceptance sample, and the reason is structural
rather than bad luck.** Card authors keep the interface at a URL and ship a stub,
so the payload is not on disk, is unbounded, and can change after distribution. A
corpus of chat logs cannot contain it.

Two things that are *not* interfaces, checked because both had been assumed to be:

- OVERLORD's 11208-byte greeting is `<VariableInsert>{…JSON…}</VariableInsert>` —
  zero backticks, no `html`/`head`/`body`. Upstream would not frame it. It is a
  variable-initialisation block.
- The 40 texts containing real HTML tags use `div`, `p`, `ul`, `li`, `details`,
  `span`, `b`, `h4`, `hr` — and none of the three substrings. No `<style>`, no
  `<script>`, no `<table>`, no `<img>`.

## The structural difference that changes the implementation

Upstream's trigger runs on **rendered DOM**: it can `$mes.find('pre')` because
SillyTavern has already turned the message into HTML.

**Iris never has that tree.** [here] Message text goes through `MarkdownText` from
`@deepseek-ai/dsh-client-ui-primitives` (`src/app/Message.tsx:15`, `:122`), which
emits React elements directly, and whose contract states that *raw HTML, relative
links and unsafe protocols are disabled*. That is a security property, not an
oversight: assistant output must not become live DOM.

Two things follow, and they are the spine of this design:

1. **Our trigger is source-level**, at the fence layer, before `MarkdownText`. The
   pipeline's whole job is to **carve one exception** out of the raw-HTML-disabled
   policy — a card's block becomes live DOM *inside the sandbox frame* — and never
   by loosening the renderer.
2. **Entity decoding is a required step on our side, not a fidelity nicety.**
   Upstream sees decoded text because `.text()` decodes; a source-level trigger
   sees `&lt;body` literally. Without an explicit decode, the same message frames
   upstream and does not frame here.

## Naming and identity

[upstream] Three sources agree on the grammar — the producer
(`src/panel/Render.vue:96-98` with `src/panel/render/Iframe.vue:57`), the consumer
(`src/function/util.ts:110`), and upstream's own docs
(`@types/iframe/util.d.ts:35`):

    TH-message--<floor>--<instance>[_<nested>]
    TH-script--<script name>--<script id>

**`<instance>` is opaque and must stay opaque.** [upstream] In the non-streaming
path it indexes the floor's frontend blocks; in the streaming path it indexes
*chunks*, which include ordinary text and `<details>` reasoning blocks
(`StreamingOne.vue:34-63`). The same interface can therefore carry a different
number depending on which path built it. Upstream itself only ever parses the
floor (`util.ts:114`) and merely regex-validates the rest. We copy that: the floor
is meaningful, the instance is an identity, and nothing derives "which interface
is this" from it — regardless of what the upstream doc comment says.

**[+]** Three details from the second reading, all defensive:

- The iframe carries `loading="lazy"` (`render/Iframe.vue:6`). A real second
  escape valve, independent of `depth`.
- It emits `message_iframe_render_started` on mount and
  `message_iframe_render_ended` on load (`Iframe.vue:59`, `:62`), so cards can observe
  render timing.
- `onBeforeMount` runs `$div.find('iframe').remove()` (`Iframe.vue:30`) with a comment saying that
  on some devices the first entry into a card renders twice, cause unknown. A
  defence whose author could not explain it, kept anyway.

## Height sync is existence, not layout

[upstream] The frame's injected CSS (`src/panel/render/iframe.ts:88-89`) includes
`html,body{…overflow:hidden!important;…}` — **the frame cannot scroll itself**. The
height mechanism (`src/iframe/adjust_iframe_height.js`) is a `ResizeObserver` on
`body` (`:47-51`), coalesced to the next frame by a `scheduled` flag plus
`requestAnimationFrame` (`:29-38`), writing `frameElement.style.height` **directly**
(`:21`); the `_.throttle(…, 500)` at `:26` is only the fallback where
`requestAnimationFrame` is absent.

Read together: if the height does not follow, the card's overflow **does not
exist** — no scrollbar, no indication. `SANDBOX.md` already records that Iris
cannot write `frameElement` across origins and posts the height out instead, one
frame later. That entry records the *cost*; this one records the *stakes*.

Viewport height is a separate mechanism: the child sets `--TH-viewport-height`
from `window.parent.innerHeight` (`src/iframe/adjust_viewport.js:1`) and the parent
re-posts `TH_UPDATE_VIEWPORT_HEIGHT` on its own resize (`Iframe.vue:34-36`). Iris
already has the equivalent for script frames; a message frame needs it because
card CSS uses `vh`, which upstream rewrites to that variable
(`render/iframe.ts:1-75`).

(Upstream's function is named `measureAndPost` and does not post. Not a name to
copy.)

## Lifecycle: anchored to "this message is displayed"

The ruling, in its concrete shape:

- A message frame's set exists **while its message is mounted in the reading
  view**, exactly as a card's script frames exist while its chat is in the
  foreground. Unmounting the message tears the frame down.
- **This depends on the reading view being windowed, and it is not.** [here]
  `src/app/ChatPane.tsx:150` renders `group.messages.map(...)` — every message, no
  windowing, no `IntersectionObserver`. So on the 677-floor chat the lifecycle
  anchor currently protects nothing: every floor is mounted, so every floor's
  frames would be built.
- Therefore **view windowing is a separate project and a prerequisite**, not part
  of this pipeline's first cut. Until it lands, upstream's `depth` window is
  implemented (shape copied from `calcToRender`, `message.ts:41-55`) as interim
  protection — and it is interim protection, not the design's answer. Upstream's
  own default for that setting is `0`, i.e. off, so it cannot be relied on either.
- Frame death and rebirth follow upstream's table [upstream] `message.ts:120-148`:
  `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `MESSAGE_UPDATED` and
  `MESSAGE_SWIPED` **destroy and rebuild** that floor's frames; `MESSAGE_DELETED`
  and `MORE_MESSAGES_LOADED` only re-audit the window. Edit mode's existing "tear
  down and rebuild" semantics are unchanged.
- **A swipe is a rebuild, not an update.** A floor's swipes are different texts, so
  they are different interfaces; carrying a frame across a swipe would show one
  swipe's panel over another's content.
- Mount and unmount are **instrumented** with the discriminators the script frames
  already use: `attach` is part of the contract rather than a convention,
  `isConnected` is verified after attaching because a no-op `attach` satisfies a
  compiler and reproduces the original silent failure exactly, and a frame that
  never reports `ready` is reported rather than left at `starting…`.

## The wall does not move

A message frame is **another frame of the same card**, not a new trust domain: the
same CSP, the same opaque origin, the same virtual-`parent` semantics, the same
per-card `documentGranted` / `networkGranted`. Nothing here widens what a card can
reach.

One consequence to state plainly, because it changes *who* runs code rather than
what code may do: the trigger is substring containment on message content, and
message content includes **model output**. A generated message containing a fenced
block with `<body` becomes a live frame running model-authored script.

Ruling: **copy the predicate, do not tighten it.** Upstream behaves this way; a
compatibility layer does not correct its source, and tightening would drop real
cards. The safety argument is the wall — opaque origin, CSP, per-card grants — not
the precision of the predicate. Recorded here as an inherited quirk so nobody
later reads the false-positive surface as an oversight and quietly narrows it.

## Variables: the message frame is where the anchor becomes real

[upstream] Two APIs, two anchors, and the asymmetry is upstream's:

- `getVariables({type:'message'})` with no id resolves to `-1`, the **latest**
  floor, not the calling frame's (`src/function/variables.ts:58-71`). Reading the
  own floor requires passing `getCurrentMessageId()` explicitly.
- `getAllVariables()` merges `global → character → [script frames only: script] →
  chat → [message frames only: floors 0..this one]` (`variables.ts:106-126`, the
  slice at `:121`).

The shape for message frames:

- Each message frame's pushed snapshot carries **its own floor's** variable layer.
  [corpus] measured the worst single floor at 282.8 KiB, against 8.29 MiB to carry
  every floor of the 677-floor chat — bounded per frame, unbounded in aggregate,
  which is what killed the alternative.
- `getCurrentMessageId()` returns a real answer here. It keeps throwing in script
  frames, which is upstream's contract.
- An explicit `message_id` equal to the frame's own floor is answered from the
  snapshot. **Anything else is refused by name**, until a real consumer justifies
  an on-demand bridge — under a synchronous façade there is no on-demand path, and
  a refusal beats a pretend-synchronous answer.
- Reads merge in upstream's documented order, with the floor sweep present only
  here and absent in script frames.

Already landed ahead of this project, because it was a live defect rather than a
future one: a script frame now **refuses** a floor-addressed read instead of
silently answering from an unlabelled snapshot. It could not wait because
MagVarUpdate's update flow reads a floor and then **writes a merge built on it**
(`getVariables({type:'message', message_id:i})` → `updateVariablesWith` →
`_.set(…, 'stat_data', …)`), so a wrong answer does not return a bad value, it
persists one.

## Libraries: the message frame's dependency surface is not the script frame's

[upstream] `src/iframe/third_party_message.html` injects **eight** things —
FontAwesome CSS, Tailwind (a local copy under the extension, not a CDN), jQuery,
jQuery UI, its theme CSS, jQuery UI touch-punch, Vue, vue-router — against
`third_party_script.html`'s **two** (Vue, vue-router).

This collides head-on with the preset policy this repository just settled:
same-origin, pinned, and **no network dependency at frame startup**. Adding
Tailwind and jQuery UI to `preset.js` is not a detail — it is a size and policy
question, and a **prerequisite ruling** rather than an implementation choice
inside this pipeline. This design assumes nothing about the answer; it records
only that a message frame cannot be built from the script frame's preset.

Also measured, and a trap for anyone reading only the two manifests: the script
frame's jQuery is **not** in its list. It arrives from
`src/panel/script/iframe.ts:11` injecting `parent_jquery.js`, whose entire body is
`window.$ = window.parent.$`. Upstream's script frames share the host page's
jQuery instance; Iris cannot (cross-origin) and ships its own copy, so a card
relying on a host-installed jQuery plugin being visible inside a script frame
loses that. Unmeasured: how many cards do this.

## Diagnostics and acceptance

The loader card gives us a **third-party-authored acceptance oracle**, better than
anything we would write: its own red text appears precisely when rendering did not
take effect. But it fires for two different reasons, and the panel must tell them
apart:

- **the pipeline did not run** — no frame was built for a block that hits the
  predicate;
- **the frame ran and the network refused it** — the block rendered, and its
  remote fetch was blocked by the allowlist.

A reader who cannot separate those will chase the wrong half. The census's
`remote sources` section supplies the second half's evidence without hardcoding a
URL the author can change after distribution.

Acceptance has two branches, because the local corpus cannot settle it:

1. **A real front-end card, obtained deliberately.** The coordinator is sourcing
   one. This is the branch that matters; the ecosystem plainly has such cards,
   they are simply not in these 31 chats.
2. **A constructed fixture**, exercising the predicate's edges — a `text`-labelled
   fence, an indented block, an entity-encoded `&lt;body`, a false positive that
   merely mentions `<body`, two interfaces in one floor, and a swipe that changes
   the interface.

Fixtures confirm; only a real card disproves. Branch 2 without branch 1 would
reproduce this project's most expensive mistake — 41 assertions that had never
been inside a browser.

Whether the allowlist should admit hosts like this loader's is a **product
decision** and is not pre-empted here. The design guarantees only that both
failures are distinguishable.

## What this does not do

- **No streaming render.** Upstream renders mid-stream, per token, with the
  predicate *relaxed* during streaming (`Streaming.vue:65`, `:124-126`) and — as
  far as [upstream] could find — **no throttling** on that path. The user's own
  install has it off. This pipeline renders on settle, and the streaming path's
  quirks (the chunk-indexed instance number, the `MESSAGE_EDITED` vs
  `MESSAGE_UPDATED` divergence) are recorded rather than implemented.
- **No view windowing.** The prerequisite named above, deliberately a separate
  project so this pipeline's first cut does not smuggle in a rewrite of the
  reading view.
- **No script-button UI.** The data half exists (`ScriptView.buttons`); this design
  leaves a mounting point and nothing more. Two measured facts for whoever takes
  it: `visible: false` is the majority (58 of 89), so rendering everything by
  default exposes controls authors hid; and buttons have no id and no callback
  name, so `(scriptId, index)` is the only handle the format guarantees — while
  `getButtonEvent(button_name)` addresses by *name*, so the position-to-name
  mapping has to happen at dispatch.
- **No `<base href>` handling.** Upstream injects it only under `use_blob_url`,
  which is off in the user's install, so relative URLs inside a card have no base.
  Copied as-is.
- **No `cleanup_protector` equivalent.** Upstream hand-writes 316 lines of
  reversible teardown — proxying `window.parent` to record every write, tagging
  injected elements, restoring on `pagehide` — and injects it only into *script*
  frames, only when enabled, and only when the card has no `pagehide` of its own
  (`script/iframe.ts:13`). It is `false` in the user's install. Iris gets the same
  property from Cordis by construction. Stated precisely: upstream is not
  incapable of this; it costs them 316 lines, same-origin access, and a
  default-off switch.
- **It does not correct upstream's asymmetries.** The `latest`-filters-`is_system`
  versus explicit-does-not read/write inconsistency (`variables.ts:66` and `:68`
  against `:135`) is upstream behaviour, and a compatibility layer reproduces its
  source.

## Order of work

1. **The predicate and its caliper**, source-level, with the entity decode as an
   explicit step and the false-positive surface tested rather than avoided. No
   frames yet — just "which blocks would be claimed", checkable against
   `npm run census:frontend-blocks`.
2. **One frame per claimed block**, reusing the script-frame machinery whole: same
   srcdoc builder, same CSP, same channel, same `attach` / `isConnected` / `ready`
   instrumentation. Height by postMessage, coalesced per frame.
3. **Lifecycle binding** to message mount, plus the `depth` interim window.
4. **The floor-anchored snapshot** and `getCurrentMessageId()`, once the host side
   carries a per-floor layer.
5. **Diagnostics**: the two-way distinction above, and the panel lines that make a
   claimed-but-unrendered block visible.

Steps 1 and 5 come first and last on purpose. The first cut of this pipeline can
be entirely wrong about *which* blocks to claim, and the corpus cannot tell us —
so the thing that has to work before anything else is the instrument that says
what it claimed, and why.
