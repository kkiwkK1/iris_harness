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
3. ~~**`.text()` is entity-decoded.** Source that reads `&lt;body` presents as
   `<body` and therefore hits.~~ **Retracted 2026-09-01, before implementation —
   see "Entity decoding" below. `.text()` returns the block's source characters
   unchanged, and decoding would make Iris claim blocks upstream does not.**
   [corpus] measured 0 either way, so nothing observable turns on it.

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

~~**This is why there is no local acceptance sample, and the reason is structural
rather than bad luck.** Card authors keep the interface at a URL and ship a stub,
so the payload is not on disk, is unbounded, and can change after distribution. A
corpus of chat logs cannot contain it.~~

**Struck 2026-09-02. The measurement above is of the wrong population, and this
document says so three sections earlier.**

Counting what is *on disk* answers a question this pipeline never asks. The
predicate runs on the text a message renders, and display regex runs first — a
fact stated under "Regex runs before the trigger" and then not applied to the
corpus figure. Re-measured through the render [corpus]:

| | on disk | **after display regex** |
| --- | --- | --- |
| floors carrying a frame block | 1 | **179** |
| cards involved | 1 | **11** |
| total frame content | 0.66 KiB | **~10.6 MiB** |
| of those, already a frame in storage | 1 | **0** |

**Not one of the 179 is a frame on disk.** Every one is a short token in storage
that a display-only regex expands at render time — `状态栏`, `封面`, `开局`,
`角色查看器`. The warhammer sample card is not an outlier; it is the **paradigm**,
distinguished only by size (360 KiB against a median of 0.5 KiB and a p99 of
129.6 KiB).

Kept rather than deleted because the error is the more useful artifact. Two people
reached it independently on the same day — the census measured files where the
pipeline needed the render, and this document stated the rule that would have
caught it and then did not apply it to itself. **A rule written down is not a rule
applied**, and the gap between them is invisible precisely because the document
looks like it already knows.

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
2. **The block's source characters are the thing to test — with no decoding
   step.** See below; this is the one place where the first draft of this design
   was wrong, and it was wrong in the direction of claiming *more* than upstream.

### Entity decoding: retracted, and why the retraction matters

The first draft of this design required decoding HTML entities in a block's body
before testing the predicate, on the reasoning that upstream reads `.text()` —
which decodes — while a source-level trigger sees `&lt;body` literally.

**That reasoning is wrong, and the error ran in the expensive direction.** It was
caught by asking what the markdown renderer does *before* `.text()` is ever
called.

SillyTavern renders messages with showdown [here], and showdown's `encodeCode`
subparser escapes a code block's body on the way in
(`node_modules/showdown/dist/showdown.js:3324-3330`):

    text = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

So the two steps compose to the identity:

| source in the card | HTML showdown emits | what `.text()` returns |
| --- | --- | --- |
| `<body` | `&lt;body` | `<body` — **hits** |
| `&lt;body` | `&amp;lt;body` | `&lt;body` — **does not hit** |

`.text()` does not decode the author's entities; it undoes showdown's escaping and
hands back exactly what the author wrote. **Testing the raw source is therefore
already faithful, and adding a decode would claim blocks upstream leaves alone.**

This has to be the case for any correct markdown renderer, or a `<script>` inside
a fenced block would execute rather than display — which is the same property
`MarkdownText` states as *raw HTML disabled*.

Kept rather than deleted for two reasons. It is the shape of mistake this project
keeps paying for — a plausible chain about two layers, where nobody had asked what
the layer in between does — and both measurements found zero affected blocks, so
**no test on the local corpus could have caught it**. It would have shipped as a
silent divergence that only a card in the wild would expose.

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

### Cancel-edit: the asymmetry, and why keying on text sidesteps it

Upstream has **two** edit events and they do not mean the same thing:

| event | when | DOM state |
| --- | --- | --- |
| `MESSAGE_EDITED` | storage has been written | **not yet rebuilt** |
| `MESSAGE_UPDATED` | after the rebuild | final |

Upstream rebuilds frames on `MESSAGE_UPDATED`, which is the correct one to pick:
a frame built on `MESSAGE_EDITED` would read a DOM that is about to be replaced.

The asymmetry is at the other end. **Cancelling an edit emits only
`MESSAGE_UPDATED`** — there was no write, so there is no `MESSAGE_EDITED` — and
upstream cannot tell that event apart from a real one. So opening an edit box and
pressing escape destroys and rebuilds every frame on that floor, discarding
whatever the panel had drawn, for a change that did not happen.

Iris does not inherit this, and not by handling the case: the rebuild is keyed on
`input.text` in `useMessageInterfaces`, not on an event. A cancelled edit yields
the same text, the dependency is unchanged, and the effect does not re-run. The
no-op is a no-op because nothing observed it as a change.

That is the general shape of the difference and it is worth stating once: **an
event says something happened; a value says what is true now.** Upstream's frames
are rebuilt by a stream of notifications and therefore have to be right about
which notifications matter. Ours are a function of the message's text, so the
question never comes up — and the same property is why a swipe *does* rebuild
without a rule saying so, since a different swipe is a different text.

Ledger: **deliberate improvement.** What it costs is that a message edited to
*identical* text does not rebuild, where upstream would. That is the same event as
cancelling, and neither should rebuild, so the cost is theoretical.

## An interface leaves the measure, because it is not reading

The reading column is bounded at `68ch` — a book measure, and the right one for
prose. Applied to a card it was measured doing the wrong thing well: the frame
sat at **477px inside a 1038px window**, and the remaining 560px was dead.

The part worth stating is *why* that was worse than it looks. These cards lay
themselves out against whatever viewport they are handed, so 477px was not a
frame clipping a card — it was the shell **telling the card the window was
small**, and the card correctly drawing a narrow column for it. The symptom
reads as "the interface doesn't fill its frame"; the cause is one layer up.

So an interface breaks out of the measure while prose keeps it: symmetric
negative margins sized from `100cqi` against the column's own bound, clamped at
zero so a narrow window reclaims nothing that is not there. Measured after:
**900px, 69px of slack on each side, no horizontal scrollbar.**

One asymmetry in it is deliberate. Equal margins centre the card on the *text
block*, which sits one gutter right of the page's centre — measured at 97px of
slack left against 51px right, which reads as a misaligned panel rather than as a
margin. The start side therefore reclaims the gutter too: prose is indented by
the gutter because the gutter holds its marginalia, and an interface has no
marginalia.

Two guards, because both halves are silent alone: `100cqi` in a page with no
container silently falls back to the small viewport and computes a plausible
wrong number, so the slot rule and `container-type: inline-size` are asserted
against each other; and the column bound had been copied into five places, which
was survivable while it only had to agree with itself and stopped being so the
moment a breakout began subtracting it.

## Live snapshot: an interface is a status panel, so it goes stale

A card's `getChatMessages` answers from the snapshot its frame holds, and that
snapshot used to arrive once, at `ready`. Upstream needs no equivalent because
its `chat` array **is** the live one; ours crossed an origin, so liveness has to
be pushed.

Two different things break without it, and they are worth separating:

- **Script frames.** MVU's generation-time chain reads the floor that just
  arrived and writes a rewritten version back (`on_message_received.ts:54-56`).
  Against a frozen snapshot it reads the *previous* floor and rewrites the wrong
  text.
- **Message frames.** An interface **is** a status panel — it draws the
  variables — so a write from a later floor leaves it displaying a number that
  was true a turn ago, while looking perfectly healthy. That is worse than a card
  that visibly fails.

**Two events, not one.** The obvious answer is `chat.updated`, and it alone
misses the case the whole change exists for: a reply that just finished
generating settles through `stream.end`, which carries its own view.
`chat.updated` covers edits, swipes and a script's own writes. The rule is not
the pair of names — it is *every event that assigns `view`*, and those two are
currently what that means. Streaming deltas are deliberately excluded: they move
`stream`, not `view`, and refreshing per token would put a host round trip
between every pair of characters.

Refreshes are **pushed into the running frame, not a rebuild**. A rebuild is what
an edit or a swipe does, and it costs a full reparse of the block — 360 KiB on
the sample card — plus whatever the panel had drawn. A snapshot is data; it does
not need a new realm.

The snapshot is re-read from the host rather than reconstructed from the event,
so a refresh carries the same authority as the first one — variable layers and
metadata move during generation too, and assembling a partial context here would
be a second, quieter opinion about what a snapshot contains. One fetch is shared
per event, **keyed on the event object's identity**: the same instance is handed
to every listener, so identity already means "these calls are the same occasion"
with nothing to keep in sync. Without that, a conversation showing eight
interfaces makes eight identical round trips per event.

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

### What it cost, measured

The message preset is **2.29 MB** built, and the two questions it raised are both
answered.

**Is the HTTP cache partitioned per frame origin?** Yes. Two chats opened in
sequence each reported a real download of the script preset — the frame reads its
own resource timing, which is the only instrument that can see this: `webRequest`
observes that a request was initiated, not whether bytes crossed the wire, and a
frame's `<script src>` subresources do not appear there at all. So `immutable`
buys nothing across chats, and every message frame pays for its libraries.

**What does that cost here?** 751 KB in 3–5 ms for the script preset; 2.29 MB in
**163–193 ms** for the message preset. Superlinear — roughly 40× the time for 3×
the bytes — and imperceptible against a loopback host.

**Recorded as a fact, not acted on.** Splitting the fonts into shared assets or
chunking the bundle are surgeries for a cost that does not exist in a local
deployment. The per-frame `library cost:` line is permanent, so the day someone
moves the host to a remote machine, the panel makes the number ugly by itself and
the case for that work arrives with its own evidence. The superlinearity is the
part to remember: a remote cost cannot be extrapolated linearly from these bytes.

## Windowing: where this deliberately beats upstream

Iris is an upgrade to SillyTavern rather than a replacement, so a divergence is
only worth having if it is written down as a claim. This one is.

**Upstream has two windows and only mentions one.** SillyTavern renders the last
`chat_truncation` messages — default **100** — and offers an explicit "Show more
messages" button (`script.js:1475-1488`, `:1431-1473`); the Tavern Helper `depth`
window is **nested inside that**, because `calcToRender`'s lower bound is the
first message *in the DOM*, not floor zero. So `depth: 0` never meant "all 677
floors"; it meant "as many as SillyTavern is currently showing". The outer window
is the one carrying the weight.

**Iris has no outer window**, which is why `render-window.ts` protects nothing
today: it is the inner window with nothing to nest inside. So the work is not a
feature for frames, it is the missing outer layer.

Two decisions, and the second is the exhibit:

- **The outer list copies upstream's shape**: a tail of N messages and an
  **explicit button**, not infinite scroll. Upstream's own `loadUntilMesId`
  implements "jump to floor" as repeated loading, which is the evidence that
  button semantics are sufficient — no scroll listener needed.
- **The frame window is a byte budget, not a floor count** — and this is where we
  diverge deliberately. Measured [corpus]: at the same N, rendered bytes differ by
  **three orders of magnitude** between chats. The clearest pair: a **91-floor**
  chat's last 20 floors are **1.28 MiB**, while a **677-floor** chat's last 20 are
  **0.12 MiB** — ten times more from a chat seven times shorter. And the worst
  chat in the corpus falls *entirely inside* a 100-floor window, so a count-based
  limit gives it **no protection at all**.

  A 2 MiB budget covers the same 26 of 31 chats that N=100 does, and unlike N=100
  it has an upper bound.

  **What it costs**: the number of frames is no longer bounded, only their total
  size — 2 MiB may be five 300 KiB interfaces or two hundred 10 KiB ones, and each
  frame carries its own preset fetch, srcdoc and observer. That count needs its own
  measurement before the budget is tuned.

  **Why upstream does not do this**: its unit of cost is a DOM message, which is
  roughly uniform. Ours is a sandboxed frame whose weight is the card's markup, and
  that is what varies by four orders of magnitude. The right unit changed when the
  thing being limited changed.

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

Acceptance has three sources, and the local corpus is now the largest of them.

1. **The real front-end card**, run first and deliberately: 战锤群星闪耀, whose
   360 KiB interface is the **worst case** in the measured population rather than
   a typical one. Starting at the extreme is the right order — a pipeline that
   survives the largest block will survive the median, and the reverse proves
   nothing.
2. **The 179 rendered floors across 11 cards.** These are reachable without a
   browser: the predicate can be run over the corpus as the render produces it,
   which is how the 368,909-byte figure was confirmed against an independent
   census byte for byte. They cover sizes across four orders of magnitude, which
   no fixture would have thought to.
3. **A constructed fixture** for the predicate's edges — a `text`-labelled fence,
   an indented block, an entity-encoded `&lt;body`, a false positive that merely
   mentions `<body`, two interfaces in one floor, and a swipe that changes the
   interface. These are the cases the corpus happens not to contain, and "happens
   not to" is the reason to write them down rather than to trust the absence.

Fixtures confirm; only a real card disproves. Branch 3 without branch 1 would
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
- **A card in one of these frames has no storage at all.** Measured, not inferred:
  in an opaque origin `localStorage` **throws** on access and `indexedDB.open`
  throws too — the throwing variant, not the hang some references describe. This
  is a real behavioural difference, because upstream's message iframes carry no
  `sandbox` attribute and are therefore same-origin, so a card that remembers
  anything between renders remembers it upstream and forgets it here.

  The sample card's own settings pane is the concrete casualty: it writes API
  configuration to `localStorage`, so under Iris that pane starts blank every
  time. Ledger: **compatibility gap**, and one that cannot be closed by adding
  `allow-same-origin` — that flag is the wall. Closing it properly means the
  shell offering a storage channel over the existing bridge and cards opting in,
  which is a separate piece of work, not an oversight in this one.
- **Nothing here is a claim about startup cost.** The frame reports its own first
  animation frame, and on the sample card that read `5293ms` with no long tasks —
  but every one of those numbers was taken in an automation tab that was
  **backgrounded**, and a hidden tab's `requestAnimationFrame` is throttled or
  stopped outright. The figures are therefore an upper bound of unknown
  tightness, and they are recorded here only so nobody re-derives them believing
  them settled. A foreground measurement is owed before any of this is quoted.

  The instrument that produced the surrounding confusion is worth naming, since
  it will be reached for again: CDP's `Page.captureScreenshot` fails on a hidden
  tab with *"the renderer may be frozen or unresponsive"*, which names one cause
  for a symptom with two. The discriminator is two `requestAnimationFrame` turns
  plus `document.hidden`, run in the same tab immediately after the failure.

## When a document must not carry a fact by itself

A recurring argument during this work was that "the documentation contradicts the
code" — usually offered as evidence that upstream is confused. Sometimes it is.
More often the document was right when written and the code moved, which is not
a quirk of upstream's but a property of documents.

The distinction that matters for this file: **some sentences here are decisions
and some are measurements, and only the first kind is safe in prose.** A decision
("an interface breaks out of the measure") stays true because it describes an
intent; if the code stops matching it, the code is wrong. A measurement ("the
frame sat at 477px in a 1038px window", "58 of 89 buttons are hidden", "the
user's install has streaming render off") is true of a moment. Prose cannot
notice when it stops being true, and a reader has no way to tell a fresh
measurement from a stale one — they are typeset identically.

So every measured premise this design leans on should be paired with something
that fails on its own. The neighbouring host half has the cleanest example, and
it is worth copying rather than admiring: `DEVIATIONS.md §3` records that Iris
does not emit `VARIABLE_UPDATE_ENDED`, and that conclusion **rests entirely on a
corpus fact** — all four listening cards ship their own MVU bundle, which emits
it, so a second emitter would apply the interception twice. Rather than quote
that count in the document and leave it to rot, it lives as an assertion in
`tests/mvu-events.test.ts` that goes red if the corpus stops supporting it. The
document explains the reasoning; the test holds the premise.

Applied here, the honest reading of this file is:

- The **ledger entries** (compatibility gap vs deliberate improvement) are
  decisions and belong in prose.
- The **counts** — 179 floors, 11 cards, 73 distinct rendered interfaces, 2.29 MB
  of preset, 5 call sites all passing `'current'` — are measurements. Where one
  of them decides behaviour, it is pinned by a test; where it is only context, it
  is dated by the section it sits in and should be re-measured before being
  quoted onward.
- The **startup timings** are measurements taken through an instrument that was
  later found to be misreporting, and are marked as such above rather than
  quietly dropped. A retracted number left visible with its retraction is more
  useful than a gap, because the next person will otherwise measure the same
  thing and wonder why nobody wrote it down.

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

## Added 2026-09-04: the second claimer — bare HTML regions

This document describes the fence path, and the pipeline now claims one more
population: a card's **bare** HTML — line-initial block tags with no fence
anywhere, the 936-floor fragment corpus and 尸变纪元's MVU widget among them —
which upstream renders in place and Iris used to escape into source text.
`splitHtmlRegions` (the split measured to that corpus's specification) is wired
in through `claimMessageSurfaces` (`sandbox/frontend-blocks.ts`), which produces
one claim list — fenced blocks and regions, in source order — that the budget,
the controller and the row all read. Regions go through the frame path this
document already specifies: same `runCard`, same wall, same budget, no second
accounting. The composition rule (fence-first, and why indented blocks are not
excluded) and the cost ledger live in `DEVIATIONS.md` §25; the split itself and
its measured specification live in `app/html-regions.ts`.

## Added 2026-09-06: the fence that never closes — `app/stray-fences.ts`

The fence path's own grammar turned on us on the 政经博弈卡
（新·架空政治经济模拟器）: a 320-line reply whose `<think_fox~>` thinking
carries a lone ` ``` ` at line 10 that nothing closes. CommonMark — and so
`MarkdownText` — runs an unclosed fence to the end of the document, so the
reply parsed as a paragraph plus **one `code` block of 310 lines**, and the
reader scrolled headings, bold, lists and rules as raw source. The claim
pipeline was innocent: the unclosed fence bounds the bare-HTML split, its body
carries no `html>`/`<head>`/`<body>` marker, so nothing was claimed and the
whole text fell to the markdown fallback — where the fence ate it.

The repair is upstream's own answer, restated for a settled message: showdown
only builds a code block when the *closing* fence arrives, so a stray opener
stays literal text and the reply below renders as markdown.
`repairStrayFences` (`app/stray-fences.ts`) copies that outcome — a
never-closing opener has its fence characters backslash-escaped, the line
renders as the literal text it reads as, and everything below renders as
markdown. Real blocks (an opener with a closer anywhere below) are consumed
untouched, which is also why the walk shares `openingFence`/`closesFence` with
the claim pipeline: the repair and the claim must not be two implementations of
what a fence is.

Gated on settled text exactly as the claim is — while a reply streams, an
unclosed fence is a code block in flight and code-to-end-of-stream is its
honest render — and applied at the two seams that read a message's display
text: the row (`MessageInterfaces`, whose controller, splice and fallback all
read the repaired string) and the budget's floors (`ChatPane`), so no two
consumers derive surfaces from different texts. One consequence worth naming:
repairing can *unhide* a bare-HTML region a stray fence used to bury, which the
claim then frames — measured on the corpus floors that fail this way, not
assumed, and the budget repairs for the same reason it claims the combined
list, so what it rations is what the view renders.
