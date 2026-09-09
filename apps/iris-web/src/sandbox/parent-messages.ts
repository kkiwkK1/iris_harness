/**
 * What happens to a message a card posts *upward*, to the window it thinks is
 * the SillyTavern page.
 *
 * `window.parent.postMessage(…)` is the one outward call the virtual parent used
 * to answer with a thrown `UnsupportedApiError`, and the throw is the whole
 * reason this module exists. Measured on the live host 2026-09-09, with the
 * preset-embedded regex tier switched on, every message reported:
 *
 * > an uncaught error before the card body message arrived: TypeError:
 * > window.parent.postMessage is not a function at about:srcdoc:922:31
 *
 * That markup runs while the document parses, so the throw took the rest of the
 * card's interface with it — a resize helper nobody upstream even listens to
 * cost the whole block.
 *
 * ## Who calls this, measured
 *
 * Two corpora, deduplicated by content hash, both columns (a card's *scripts*
 * and the *interface text* it ships as markup):
 *
 * | message | sites | owners | distinct bodies | column |
 * | --- | --- | --- | --- | --- |
 * | `{type:'resizeIframe', height}` | 15 | 3 preset files (2 presets) | 5 | interface text |
 * | `'toggle-forum-overlay'` (a bare **string**) | 2 | 1 card, one script | 1 | script |
 * | `{event:'__devtools-kit…'}` | 1 | 1 cached script bundle (Vue devtools) | 1 | script |
 *
 * `iframeResize` — the spelling upstream actually consumes, see below — appears
 * **zero** times in either corpus. The bare string is why nothing here may
 * assume a message is an object.
 *
 * ## Who listens upstream, measured
 *
 * - **SillyTavern core listens for nothing.** No `window`/`document` `message`
 *   listener anywhere in `public/script.js` or `public/scripts/**`; the four
 *   hits are Worker and AudioWorklet ports.
 * - **TavernHelper (JS-Slash-Runner 4.9.1) never receives height at all.** Its
 *   `src/iframe/adjust_iframe_height.js:21` writes `frameElement.style.height`
 *   directly, same-origin, from inside the frame. Iris cannot: the shell is a
 *   different origin, so the height travels as a protocol message instead —
 *   which is the loop `frame-height.ts` and `reportHeight` already are.
 * - **One listener in the whole page consumes an upward message**:
 *   ST-Prompt-Template's `src/utils/iframe.ts:108-120`, and it matches
 *   `event.data.type === 'iframeResize'`, then does
 *   `document.getElementById(event.data.id).style.height = Math.ceil(height)`.
 *
 * So the message the corpus sends (`resizeIframe`, no `id`) matches **no**
 * upstream listener on either count: the type is the transposition of the one
 * that is matched, and the `id` the matched one addresses is absent. Upstream's
 * behaviour for every message in the table above is therefore **silent
 * discard** — no `else`, no warning, no counter in any of the three listeners.
 *
 * ## What this does instead, and why it is not just the silence
 *
 * Behaviour parity is "do not throw, and do not act". Diagnostic parity is a
 * different thing, and copying upstream's silence would leave the next reader
 * of a card that quietly does nothing with nothing to read. So:
 *
 * - a **height request** — either spelling — is answered by measuring this
 *   frame's own content again. The card's own number is `document.body.
 *   scrollHeight` of *this* document, which is exactly the quantity
 *   `reportHeight` reads, so re-measuring costs nothing in fidelity and keeps
 *   the reported height inside `heightSignal`'s echo and `sizing` guards. A
 *   forwarded number would bypass them, and their absence was measured as an
 *   endless flicker on four real cards.
 * - **anything else** is dropped, counted, and named once — then again at each
 *   ten-fold, so a card posting in a loop bounds its own noise.
 * - **nothing reaches the shell↔frame protocol channel.** That channel carries
 *   the run token and can run code; a card's message is not on it, and the only
 *   thing a card's message can move here is this frame's own height.
 *
 * ### Three divergences from the one upstream listener, on purpose
 *
 * 1. **`id` is ignored; the request is always about the sending frame.**
 *    Upstream resolves `getElementById(event.data.id)` against the whole host
 *    page with no `event.source` and no origin check (the origin check is
 *    present as a comment), so any frame can resize any element that has an id.
 *    Reproducing that would be reproducing a hole; a card here can ask about
 *    itself and nothing else. Costless on this corpus: no measured sender sends
 *    an `id` at all.
 * 2. **Both spellings are honoured.** `iframeResize` is what upstream matches;
 *    `resizeIframe` is what all 15 measured sites send. Honouring one would
 *    either serve nobody or diverge from the only listener that exists.
 * 3. **`targetOrigin` is accepted and ignored.** All 15 sites pass `'*'`. A
 *    frame here has an opaque origin and the parent is a stand-in, so there is
 *    no origin to compare against that would mean what the DOM's comparison
 *    means; refusing on a mismatch would invent a rule upstream does not have.
 *
 * Lives in the **fetched member table** rather than the inlined bootstrap for
 * the reason `popup-api.ts` does: the bootstrap is re-parsed per frame and had
 * 47 bytes of headroom against `FRAME_OVERHEAD_BYTES` when this was written.
 * The core keeps only the policy — that `parent.postMessage` is a bridged,
 * read-only name and where its argument goes.
 *
 * @module iris-web/sandbox/parent-messages
 */

/**
 * The two spellings a height request arrives under.
 *
 * The list is the dispatch, like `VIRTUAL_PARENT_SCHEDULER_MEMBERS` is: a
 * spelling on it is a spelling that is answered, and the test pins the two
 * together rather than pinning a copy of the strings.
 */
export const HEIGHT_REQUEST_TYPES = ['resizeIframe', 'iframeResize'] as const

/** How many distinct message shapes may be named before the reports stop. */
export const REPORT_LIMIT = 8

/** What the frame hands the sink, so this module knows nothing about the realm. */
export interface ParentMessageEnv {
  /**
   * Measure this frame's own content height again, now.
   *
   * The frame's `reportHeight` schedule, injected: this module must not know
   * how a height is measured, reported, or gated, only that asking is the
   * answer to a resize request.
   */
  remeasure: () => void
  /** Say one thing on the note channel, once. */
  note: (message: string) => void
}

/**
 * Name a message shape, for deduplication and for the report.
 *
 * A string message is named by its own value — the one in the corpus is
 * `'toggle-forum-overlay'`, and that string *is* the diagnostic; a label of
 * `(a string)` would have told a reader nothing about which card was talking.
 * Truncated, because the value is a card's and its length is not.
 * @param message - whatever the card posted.
 * @returns a short, stable label for this shape.
 */
export function describeMessage(message: unknown): string {
  if (typeof message === 'string') {
    return message.length <= 64 ? `'${message}'` : `'${message.slice(0, 64)}…'`
  }
  if (typeof message !== 'object' || message === null) return `(a ${typeof message})`
  const type = (message as { type?: unknown }).type
  if (typeof type === 'string' && type.length > 0) return `type '${type}'`
  // The devtools bundle's `{event: '__devtools-kit…'}` lands here: an object
  // with a discriminant under another key. Named by the keys it does carry,
  // because "an object" would collapse every such sender into one row.
  const keys = Object.keys(message as object).slice(0, 4)
  return keys.length === 0 ? '(an object with no keys)' : `(an object with ${keys.join(', ')})`
}

/**
 * Whether this message is a request to resize the sending frame.
 * @param message - whatever the card posted.
 * @returns the claimed height when the message carries a usable one, `true`
 *   when it is a resize request with no usable height, `false` when it is not a
 *   resize request at all.
 */
export function heightRequest(message: unknown): number | boolean {
  if (typeof message !== 'object' || message === null) return false
  const type = (message as { type?: unknown }).type
  if (typeof type !== 'string') return false
  if (!(HEIGHT_REQUEST_TYPES as readonly string[]).includes(type)) return false
  const height = (message as { height?: unknown }).height
  /*
   * A resize request with no usable height is still a resize request, and it is
   * answered the same way: the card is saying "my layout changed", and this
   * frame's answer to that is to measure. Requiring the number would drop the
   * request on exactly the card that had trouble producing one.
   */
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return true
  return height
}

/**
 * The function `parent.postMessage` is.
 *
 * Never throws. A card's outward post is, upstream, a call into a page that
 * either consumes it or drops it — and in both cases the card's next statement
 * runs. That property is the fix; everything else here is what makes the drop
 * legible.
 * @param env - the frame's own height schedule and note channel.
 * @returns the member to bridge onto the virtual parent.
 */
export function createParentMessages(
  env: ParentMessageEnv,
): (message: unknown, targetOrigin?: unknown, transfer?: unknown) => void {
  /** How many of each shape have arrived, and when the next report is due. */
  const seen = new Map<string, { count: number, next: number }>()

  /**
   * Report the first of a shape, then the tenth, the hundredth, and so on.
   *
   * A card that posts on every animation frame would otherwise turn one gap
   * into a log — the same rule the unpublished-name path follows, with a count
   * attached, because "this happened once" and "this has happened 4,000 times"
   * are different findings about the same card and the escalating report is the
   * only way the second one is ever visible.
   * @param label - the shape's label, from {@link describeMessage}.
   * @param say - what to report, given the running count.
   */
  const escalate = (label: string, say: (count: number) => string): void => {
    /*
     * The cap is applied **when a shape is first seen**, and it counts shapes
     * rather than messages: a card inventing a fresh type per post is the case
     * a per-shape budget would not bound. A shape discovered past the cap is
     * still counted and simply never due — which is not the same as checking
     * the cap on every call, and the difference is the bug that reading would
     * have shipped: the ninth shape would have silenced the eight before it.
     */
    const row = seen.get(label) ?? { count: 0, next: seen.size < REPORT_LIMIT ? 1 : Infinity }
    row.count += 1
    seen.set(label, row)
    if (row.count < row.next) return
    row.next = row.count * 10
    env.note(say(row.count))
  }

  return (message: unknown, _targetOrigin?: unknown, _transfer?: unknown): void => {
    const request = heightRequest(message)
    if (request !== false) {
      escalate('height', count => {
        const claim = typeof request === 'number'
          ? `claimed height ${String(Math.round(request))}px`
          : 'no usable height in the message'
        return (
          `a card asked its parent to resize this frame (${claim}${
            count === 1 ? '' : `, ${String(count)} requests so far`
          }); Iris answers by measuring this frame's own content instead, so the`
          + ' height that lands is its own reading — the "height sources" line'
          + ' beside this one says what it read'
        )
      })
      /*
       * Outside the report gate: the measurement is the answer to the request,
       * and it has to happen on the four-thousandth request as much as on the
       * first. A nudge folded into the report would have made a card's resizes
       * work once and then silently stop.
       */
      env.remeasure()
      return
    }
    const label = describeMessage(message)
    escalate(label, count => (
      `a card posted a message to its parent that nothing here consumes (${label}${
        count === 1 ? '' : `, ${String(count)} of them`
      }); it is dropped, as SillyTavern's own page drops it — nothing in`
      + ' SillyTavern core listens for a card message, and the one extension'
      + ' that does matches only type \'iframeResize\' with an element id'
    ))
  }
}
