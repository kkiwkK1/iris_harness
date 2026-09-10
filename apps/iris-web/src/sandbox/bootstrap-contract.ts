/**
 * The names the frame's markup and the fetched bootstrap agree on, and the
 * guard that runs when they do not meet.
 *
 * Its own module for the reason `members-contract.ts` is: the markup writes
 * these names and the bootstrap sets them, and a rename touching only one side
 * would produce a frame that reports "the bootstrap did not install" while the
 * bootstrap sits in the document having installed. That failure is
 * indistinguishable from a genuine fetch failure, which is the one thing the
 * marker exists to tell apart.
 *
 * **Why there is a guard at all.** The bootstrap used to be inlined into every
 * frame, so "did it run" was not a question anyone could ask — a `<script>` with
 * the source in it either parses or the whole document is broken. It is now a
 * blocking classic `<script src>` from Iris's own origin (2026-09-10, see
 * `notes/apps/iris-web/DEVIATIONS.md` §91), and that introduces exactly one new
 * failure the inline version could not have: **the tag is in the document and
 * the code never ran.** Three ways in — the request failed, this frame's CSP
 * refused it, or the file arrived and would not parse — and all three look the
 * same from outside: a frame whose card markup runs against no bridge at all,
 * throwing a `ReferenceError` per member and attributing every one of them to
 * the card.
 *
 * So the ordering premise the whole move rests on — *a blocking script finishes
 * before the body parses* — is checked in the frame rather than trusted, and the
 * check is placed where a wrong answer can still be acted on: after the tag,
 * before the card's markup.
 *
 * @module iris-web/sandbox/bootstrap-contract
 */

/**
 * What the bootstrap sets as its **last** statement, once install has finished.
 *
 * Modelled on `MEMBERS_MARKER`, and the reasoning carries over unchanged: a
 * frame can see that the bridge is missing but not why, and "the script never
 * ran" and "the script ran and threw" need opposite responses — one is a
 * request to go and look at the fetch, the other is a bug in code that has
 * already reported itself.
 */
export const BOOTSTRAP_MARKER = '__iris_bootstrap_ready__'

/**
 * What the bootstrap sets when it has reported its own failure.
 *
 * The three-state reading is what keeps the guard from speaking over the
 * bootstrap. A bootstrap that throws inside `installSandbox` posts a
 * `bootstrap-error` carrying the **real** error — a name, a message, sometimes a
 * line — and then rethrows; the marker above is never reached. Without this
 * second name the guard would see "not ready", conclude "the script never ran",
 * and put a worse sentence on top of a better one.
 *
 * It also decides what the guard *does*, not only what it says: the guard
 * stops the parse, and a bootstrap that ran and threw has already published
 * whatever it published before throwing. Halting there would blank a card's
 * interface for a failure that is today survivable, which is a behaviour change
 * this move has no business making.
 */
export const BOOTSTRAP_SPOKE = '__iris_bootstrap_spoke__'

/**
 * The attribute marking the tag that loads the bootstrap.
 *
 * Read by the guard so the URL in its report comes off the document rather than
 * being written into the guard a second time. One spelling: a guard naming a URL
 * the tag does not carry would send a reader to check the wrong address.
 */
export const BOOTSTRAP_TAG_MARK = 'data-iris-bootstrap'

/** The attribute on the named error panel the guard draws. */
export const BOOTSTRAP_MISSING_MARK = 'data-iris-bootstrap-missing'

/**
 * The attribute on the `<template>` the guard opens to swallow the rest.
 *
 * Present so a reader looking at a stopped frame's DOM can see *why* the card's
 * markup is not there, rather than concluding the shell sent an empty body.
 */
export const BOOTSTRAP_SWALLOW_MARK = 'data-iris-bootstrap-swallowed'

/**
 * The inline check that runs between the bootstrap tag and the card's markup.
 *
 * Written here rather than in `srcdoc.ts` so it is one string with one set of
 * tests, and returned as source rather than as a template so the names above
 * are interpolated from the constants instead of retyped.
 *
 * **What it does when the bootstrap is not there, and why each step.**
 *
 * 1. **Reports the response, rather than guessing at a cause.** It reads the
 *    resource timing entry for the tag's own `src` and says what is there: no
 *    entry at all, an HTTP status, a body size. The host sends
 *    `timing-allow-origin: *` on the sandbox-asset route, so an opaque-origin
 *    frame can actually read those fields — without that header every field
 *    reads zero and every case would look like every other.
 *
 *    **The first version guessed, and the guess was wrong for the commonest
 *    case.** It asked one question — is there a body — and answered "the file
 *    arrived but set no marker: wrong bytes, a parse error, or a stale build"
 *    whenever there was. A **404 has a body**: the entry exists, `transferSize`
 *    is non-zero, and that sentence sent the reader to the bundler for a
 *    missing file. Found by mutation, not by the test passing: the negative
 *    control asserted the panel said *something* actionable and the branch it
 *    took was never pinned, so the wrong sentence read as green. `responseStatus`
 *    is the field that answers the question actually being asked, and it is
 *    readable here for the same `timing-allow-origin` reason. Now the message
 *    names the status when there is one, and the live test pins that a 404 says
 *    404.
 * 2. **Reports through the channel that already exists for this.** An unstamped
 *    `bootstrap-error`, which is what `frame-entry.ts`'s own `fail()` sends and
 *    what `runner.ts` accepts on the strength of `event.source` alone — the
 *    shell then shows it as the frame's named failure through
 *    `onBootstrapError`. No new message type: a second spelling for "this frame
 *    never started" would need a second place in the panel to be read.
 * 3. **Draws the failure where the frame is.** The shell's report is not visible
 *    to someone looking at the frame, and a frame that is blank for a reason is
 *    worth more than a frame that is blank.
 * 4. **Makes the rest of the document inert, two ways.** `document.write` of an
 *    unclosed `<template>` puts every following byte — the card's libraries and
 *    the card's markup — into template content, which is parsed but neither
 *    rendered nor executed, and `window.stop()` aborts the parse outright.
 *    Either alone is sufficient; both are here because they fail in opposite
 *    directions. `document.open()` is **not** used and cannot be: called from a
 *    parser-inserted script it sets the ignore-destructive-writes counter and
 *    returns, so it is a no-op in exactly the position this guard occupies.
 *
 * Every step is in its own `try`. A guard that throws on the way to reporting a
 * failure would replace one silent frame with another, and the outermost catch
 * is what stops this from being the thing that broke the frame.
 * @returns the guard's JavaScript, with no surrounding element.
 */
export function bootstrapGuard(): string {
  return [
    '(function(){try{',
    'var g=globalThis;',
    `if(g.${BOOTSTRAP_MARKER}===true||g.${BOOTSTRAP_SPOKE}===true)return;`,
    "var src='';",
    `try{var t=document.querySelector('script[${BOOTSTRAP_TAG_MARK}]');if(t)src=t.src||''}catch(e){}`,
    "var said='';",
    'try{var e=performance.getEntriesByName(src)[0];',
    "said=!e?'the browser recorded no response for it: refused by this frame CSP, blocked,"
      + " or the request never completed'",
    ":(e.responseStatus||0)>=400?'the server answered HTTP '+e.responseStatus",
    ":(e.decodedBodySize||0)===0?'the response was empty (HTTP '+(e.responseStatus||'unknown')+')'",
    ":'it arrived (HTTP '+(e.responseStatus||'unknown')+', '+e.decodedBodySize+' bytes) and set no"
      + " marker: wrong bytes, a parse error, or a stale build'}catch(x){}",
    "var why='iris sandbox: the frame bootstrap did not install — '+(src===''",
    "?'this document carries no bootstrap tag at all'",
    ":said)+' ('+(src||'no src')+')';",
    "try{window.parent.postMessage({iris:'',type:'bootstrap-error',message:why},'*')}catch(e){}",
    'try{var n=document.createElement("div");',
    `n.setAttribute('${BOOTSTRAP_MISSING_MARK}','');`,
    "n.setAttribute('style','margin:0;padding:8px 10px;font:12px/1.5 monospace;",
    "color:#7a1f1f;background:#fdeaea;border:1px solid #e3b6b6');",
    'n.textContent=why;',
    '(document.body||document.documentElement).appendChild(n)}catch(e){}',
    `try{document.write('<template ${BOOTSTRAP_SWALLOW_MARK}>')}catch(e){}`,
    'try{window.stop()}catch(e){}',
    '}catch(e){}})()',
  ].join('')
}
