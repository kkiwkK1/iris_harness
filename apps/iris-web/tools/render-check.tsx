/**
 * Proof that the interface actually renders.
 *
 * `tsc` proves the types and `vite build` proves the imports resolve; neither
 * proves that mounting the tree does not throw, or that a streaming turn puts
 * text on the page. Node cannot run `.tsx` (its type stripping erases types, it
 * does not transform JSX), so this is bundled by `tools/render-check.mjs` and
 * rendered with `react-dom/server`.
 *
 * What it is NOT: a substitute for looking at the page. Layout, colour and
 * motion are invisible to a server render. It catches the class of failure that
 * makes the page blank.
 *
 * @module iris-web/tools/render-check
 */

import assert from 'node:assert/strict'
import { renderToString } from 'react-dom/server'
import { createFakeClient } from '@iris/client-fake'

import { App } from '../src/app/App.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore, type IrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'
import { registerMessageAction } from '../src/slots/message-actions.ts'
import { RAIL_MAX_TICKS, railMode } from '../src/app/rail.ts'
import { DEFAULT_WINDOW } from '../src/app/reading-window.ts'
import type { MessageView } from '@iris/protocol'
import { contributing, discrepancy, rowsFor } from '../src/app/itemization.ts'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the whole tree to HTML.
 *
 * zustand's server snapshot is the store's INITIAL state, so without the
 * override below a server render would only ever show the pre-boot empty shell.
 * That is a harness concession — nothing in the app depends on it.
 * @param store - the booted store.
 * @param core - the slot registry.
 * @returns the rendered markup.
 */
function render(store: IrisStore, core: SlotCore): string {
  const api = store as unknown as { getInitialState: () => unknown }
  api.getInitialState = () => store.getState()
  return renderToString(
    <SlotProvider core={core}>
      <StoreProvider store={store}>
        <App />
      </StoreProvider>
    </SlotProvider>,
  )
}

/**
 * Wait until the store satisfies a predicate.
 *
 * Deadlined rather than open-ended: a check that hangs is worse than one that
 * fails, because it stalls whatever runs it with no message.
 * @param store - the store to watch.
 * @param predicate - the condition to wait for.
 * @param what - named in the timeout message.
 * @returns a promise that resolves once the condition holds.
 */
function until(store: IrisStore, predicate: () => boolean, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timed out waiting for ${what}`))
    }, 5000)
    const off = store.subscribe(() => {
      if (!predicate()) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

/**
 * Run something that starts a turn, and wait for that turn to finish.
 *
 * Both edges have to be observed. Waiting only for "no stream in flight" returns
 * immediately, before the turn it was supposed to wait for has even opened —
 * which is how the first version of this helper turned a loop into a hang.
 * @param store - the store to watch.
 * @param work - the action that opens a turn.
 */
async function generated(store: IrisStore, work: () => Promise<void>): Promise<void> {
  await work()
  await until(store, () => store.getState().stream !== undefined, 'the turn to open')
  await until(store, () => store.getState().stream === undefined, 'the turn to settle')
}

async function main(): Promise<void> {
  const client = createFakeClient({ chunkDelayMs: 4, chunkCount: 6 })
  const slots = createIrisSlots()
  const wired = createIrisStore(client, { transport: 'fake', origin: 'render check' })
  await wired.store.getState().boot()

  // ---------------------------------------------------------------- settled
  const settled = render(wired.store, slots.core)
  assert.match(settled, /class="iris-shell"/, 'the shell did not render')
  assert.match(settled, /雨夜的第三次点数/, 'the open conversation title is missing')
  assert.match(settled, /MarkdownText_markdown/, 'assistant prose did not go through the Markdown renderer')
  // The seeded chat's alternates sit on an earlier turn, so its rail is a record:
  // ticks and a count, no controls. The interactive form is asserted after the
  // regenerate below, where the alternates are on the turn that can still change.
  assert.match(settled, /iris-rail--record/, 'the variant rail is missing')
  assert.match(
    settled,
    /aria-label="2 readings were generated for this reply; the current one is 1"/,
    'a recorded rail should still report how many readings a passage had',
  )
  assert.match(settled, /iris-composer__field/, 'the composer is missing')
  assert.match(settled, /value="openai-compat"/, 'settings fields did not populate')
  // Only the last reply offers a retry; more than one would mean discarding
  // history the protocol has no operation for.
  assert.equal(settled.match(/>Regenerate</g)?.length, 1, 'exactly one Regenerate expected')

  // ------------------------------------------------------------- hierarchy
  // The layout decisions from the browser review, pinned. Each of these was a
  // specific observation: the reading column sits on a bounded sheet so a wide
  // window reads as a desk rather than as a page that failed to load; the turn
  // number marks the boundary between turns instead of being stamped on
  // whichever rows are the reader's; and the state margin gives the space beside
  // the sheet real content.
  assert.match(settled, /class="iris-stage"/, 'the stage is missing')
  // The head is printed on the paper, not floating above it: the browser review
  // measured the title 1270px from the Settings button it shared a band with,
  // and 293px of empty paper above the first line once short conversations were
  // anchored to the composer.
  assert.match(settled, /class="iris-masthead"/, 'the masthead is missing')
  // The page must admit when its data is invented. A host-served build once ran
  // on seeded names for two days while "assets reachable" and "RPC answers" were
  // both true and neither was the question.
  assert.match(settled, /Seeded data/, 'the fake transport is not disclosed')
  assert.match(settled, /transport=rpc/, 'the disclosure does not say how to use a host')
  assert.doesNotMatch(settled, /iris-topbar/, 'the topbar band should be gone')
  // Real facts, not decoration: which model answers and how far in the scene is.
  assert.match(settled, /iris-masthead__meta/, 'the masthead carries no meta line')
  assert.match(settled, /local\/qwen3-8b/, 'the meta line does not report the model')
  assert.match(settled, /class="iris-sheet"/, 'the sheet is missing')
  assert.match(settled, /class="iris-aside"/, 'the state margin is missing')

  const ordinals = settled.match(/iris-turn__ordinal/g)?.length ?? 0
  const turns = settled.match(/class="iris-turn"/g)?.length ?? 0
  assert.ok(turns >= 2, 'the fixture needs more than one turn')
  assert.equal(ordinals, turns - 1, 'a turn number should mark each boundary, and only a boundary')

  // The state margin reads the chat's own variables, which the protocol already
  // carries and nothing else in the interface was using.
  assert.match(settled, /好感度/, 'the state margin does not show the chat variables')

  // Quiet until there is something to send. A permanently disabled primary
  // button was the first thing on the page and read as broken.
  assert.match(settled, /Button_outline[^"]*"[^>]*disabled/, 'Send is not quiet while the composer is empty')

  // -------------------------------------------------------------- streaming
  await wired.store.getState().send('那你说，我该怎么办。')
  await until(wired.store, () => (wired.store.getState().stream?.text.length ?? 0) > 0, 'the first delta')

  const streaming = render(wired.store, slots.core)
  assert.match(streaming, /iris-caret/, 'the streaming caret is missing')
  assert.match(streaming, /那你说，我该怎么办。/, 'the sent message is not on the page')
  const buffered = wired.store.getState().stream?.text ?? ''
  assert.ok(buffered.length > 0, 'nothing was buffered')
  // The reply being written has to be visible, which is the whole point of
  // synthesizing a message for a turn the settled view does not carry yet.
  assert.ok(
    streaming.includes(buffered.slice(0, 12).replace(/[&<>"]/g, '')) || buffered.length < 12,
    'buffered text did not reach the page',
  )

  await until(wired.store, () => wired.store.getState().stream === undefined, 'the turn to settle')

  // ------------------------------------------------------------- regenerate
  await generated(wired.store, () => wired.store.getState().regenerate())
  const regenerated = render(wired.store, slots.core)
  assert.match(regenerated, /aria-label="Reading 2 of 2"/, 'regenerate did not add a reading')

  // ------------------------------------------------------- rail, crowded
  // A card on the development machine already carries thirteen alternate
  // greetings, and regenerations stack without limit, so the ladder handing over
  // to a fixed-height readout is a real path and worth rendering rather than
  // only unit-testing the threshold.
  while ((wired.store.getState().view?.messages.at(-1)?.swipes?.count ?? 0) <= RAIL_MAX_TICKS) {
    await generated(wired.store, () => wired.store.getState().regenerate())
  }
  const crowded = render(wired.store, slots.core)
  const readings = wired.store.getState().view?.messages.at(-1)?.swipes?.count ?? 0
  assert.equal(railMode(readings), 'compact', 'the fixture did not cross the threshold')
  assert.match(crowded, /iris-rail--compact/, 'the crowded rail did not switch form')
  assert.match(crowded, /aria-label="Earlier reading"/, 'the compact rail has no stepper')
  // Scoped to this message's count: other turns in the fixture have two or three
  // readings and are still entitled to their ladders.
  //
  // A substring rather than a built regex. The regex version of this assertion
  // was dead for its whole life: written inside a template literal, its `\d`
  // collapsed to a literal `d`, so it matched nothing and passed unconditionally.
  // Tick labels read `Reading {n} of {count}`, and the compact rail's own group
  // label reads `{count} readings of this reply`, so this fragment appears only
  // on a tick.
  assert.equal(
    crowded.includes(` of ${readings}"`),
    false,
    'ticks were drawn for a message past the threshold',
  )
  assert.match(crowded, new RegExp(`>${readings}<`), 'the compact rail does not report the count')

  // ---------------------------------------------------------- card scripts
  // The panel's effect does not run in a server render, so the load is driven
  // here. Worth rendering rather than trusting: the fake's three scripts are
  // shaped after the real corpus — a 1.7 MB bundle, a hand-written few kB, and
  // one its author shipped switched off at zero bytes — so all three row states
  // appear at once.
  const character = wired.store.getState().view?.characterId
  assert.ok(character !== undefined, 'the fixture chat has no character')
  await wired.store.getState().loadScripts(character)

  const withScripts = render(wired.store, slots.core)
  assert.match(withScripts, /Card scripts/, 'the script section is missing')
  assert.match(withScripts, /1\.7 MB/, 'the largest script does not report its size')
  assert.match(withScripts, /Off in the card/, 'a card-disabled script is not distinguished')
  assert.match(withScripts, /Runs with this card/, 'an enabled script has no switch')
  // The grant must be worded by consequence, and must say a card cannot ask.
  assert.match(withScripts, /cannot read your other conversations/, 'the default state is not explained')
  assert.match(withScripts, /A card has no way to ask/, 'the panel does not say a card cannot request this')
  assert.doesNotMatch(withScripts, /document access/i, 'the grant is worded as an API, not a consequence')

  // ----------------------------------------------------- rail as a record
  // Only the last turn's readings can still be changed. Swapping an earlier
  // beat's reading would leave every later turn answering words the transcript
  // no longer shows — SillyTavern hardcodes the same restriction in its swipe
  // handlers, for the same reason. The earlier rails stay as a record.
  const recorded = render(wired.store, slots.core)
  const records = recorded.match(/iris-rail--record/g)?.length ?? 0
  assert.ok(records >= 1, 'an earlier turn with alternates should show an inert rail')
  // An inert rail must not offer controls. Asserted on the tick's own labelled
  // button rather than on a character window after the wrapper class: a window
  // is a guess about markup length, and it passes for the wrong reason the moment
  // the markup grows.
  assert.doesNotMatch(
    recorded,
    /<button[^>]*aria-label="Reading /,
    'a recorded rail rendered a tick as a control',
  )

  // ------------------------------------------------------- prompt breakdown
  // Asserted on the projection rather than on the modal, which only renders once
  // opened. The measured shape is the point: one part holds two thirds of the
  // prompt, so the panel's default order has to surface it first.
  const itemized = await wired.store.getState().itemize()
  assert.ok(itemized.ok, 'the fake should model an itemization, not refuse one')
  const breakdown = itemized.itemization
  assert.equal(
    discrepancy(breakdown),
    undefined,
    'a breakdown whose parts do not sum to its total would be drawn against a wrong scale',
  )
  const bySize = rowsFor(breakdown.entries, 'size', breakdown.tokens)
  assert.ok(bySize[0] !== undefined)
  // A fixture property, not a claim about prompts in general: measured across six
  // real presets the largest part held 23%–92%, and this fixture sits at the
  // skewed end deliberately, because that is the end where an equal-width list
  // looks fine and tells the reader nothing.
  assert.ok(bySize[0].share > 0.5, 'the fixture must keep its skew, or the design is untested')
  // Zero-token parts are normal — 14 of one preset's 53 — and must stay in the
  // table while staying out of the proportion bar.
  assert.ok(
    breakdown.entries.some(entry => entry.tokens === 0),
    'the fixture should carry an empty part, since real presets are full of them',
  )
  assert.equal(
    contributing(breakdown.entries).length,
    breakdown.entries.filter(entry => entry.tokens > 0).length,
    'the bar must be drawn from contributing parts only',
  )
  // A UUID id with a human label is the normal case, not the exception.
  assert.ok(
    breakdown.entries.some(entry => /^[0-9a-f]{8}-/.test(entry.id) && !/^[0-9a-f]{8}-/.test(entry.label)),
    'the fixture should carry a UUID-identified prompt, since 29 of 41 real ones are',
  )

  // -------------------------------------------------------- connections
  // The property this panel exists for: a stored display name is a snapshot and
  // goes stale. Measured on a real install, the selected profile was called
  // `deepseek deepseek-chat` and pointed at Gemini. The fake reproduces that trap,
  // so a panel rendering only the label fails here rather than in production.
  await wired.store.getState().loadConnections()
  const withConnections = render(wired.store, slots.core)

  const misnamed = wired.store.getState().connections.find(row => row.id === 'misnamed')
  assert.ok(misnamed !== undefined, 'the fixture should keep its misnamed profile')
  assert.ok(
    misnamed.label !== undefined && !misnamed.label.includes(misnamed.model),
    'the misnamed fixture must contradict its own route, or it tests nothing',
  )
  // Substring checks, not constructed regexes: these values contain dots and
  // slashes, and escaping them in a heredoc-authored file is a layer that has
  // already produced three silently-dead assertions in this project.
  assert.ok(withConnections.includes(misnamed.label), 'the label is not shown')
  // And the derived truth beside it, which is the whole point.
  assert.ok(withConnections.includes(misnamed.summary), 'the derived summary is not shown')
  assert.ok(withConnections.includes(misnamed.model), 'the real route must be on screen')

  // A profile the user never named falls back to the summary rather than to an id.
  const unnamed = wired.store.getState().connections.find(row => row.label === undefined)
  assert.ok(unnamed !== undefined, 'the fixture should keep an unnamed profile')
  assert.equal(withConnections.includes(`>${unnamed.id}<`), false, 'an id reached the interface')
  assert.ok(withConnections.includes(unnamed.summary), 'an unnamed profile should fall back to its summary')

  // ------------------------------------------------------------------ slots
  // `iris.message.actions` is projected as one folded menu per floor
  // (`MessageActions.tsx`): the projection reads each entry's `.action`
  // descriptor, so a bare component registered through `core.register` is not
  // an action and renders nothing — which is what this check used to do, and
  // why it went red the moment the projection folded. Register the way a
  // provider does. The menu is closed under renderToString, so the label itself
  // is not in the markup; what is renderable is the folded button, which exists
  // only while at least one action is registered.
  const registered = registerMessageAction(slots.core, 'render-check', {
    id: 'probe',
    label: () => 'PROBE',
    run: () => undefined,
  })
  const FOLDED = /aria-haspopup="menu"[^>]*>Actions</
  assert.match(render(wired.store, slots.core), FOLDED, 'a registered floor action did not produce the folded menu')
  registered()
  assert.doesNotMatch(
    render(wired.store, slots.core),
    FOLDED,
    'a disposed floor action still produced the folded menu — reversibility is broken',
  )


  // ------------------------------------------------------- reading window
  /*
   * Acceptance 1 of `notes/apps/iris-web/WINDOWING.md` §七, pinned here rather than looked at.
   *
   * The criterion is about the **DOM**: a 677-floor chat opens with 100
   * messages mounted, not 677. `reading-window.ts` is unit-tested, but that
   * tests the arithmetic; whether `ChatPane` actually mounts only the window is
   * a property of the rendered tree, and this is the only harness in the project
   * that renders it.
   *
   * The store is written to directly, which is a harness concession of the same
   * kind as the `getInitialState` override above: the fake's seeded chat is
   * short, and there is no long conversation to open without either a corpus
   * file or a synthetic one. Nothing in the app depends on this being possible.
   */
  const seeded = wired.store.getState().view
  assert.ok(seeded !== undefined, 'the fixture chat should be open')

  const FLOORS = 677
  const long = Array.from({ length: FLOORS }, (_unused, at) => ({
    id: at,
    key: `synthetic-${String(at)}`,
    // Turns of two rows, so the window boundary can fall inside one — which is
    // the case the outward rounding exists for.
    role: (at % 2 === 0 ? 'user' : 'assistant') as MessageView['role'],
    name: at % 2 === 0 ? 'You' : seeded.title,
    text: `floor ${String(at)}`,
    turn: Math.floor(at / 2) + 1,
  }))
  wired.store.setState({ view: { ...seeded, messages: long } })

  const windowed = render(wired.store, slots.core)
  const mounted = windowed.match(/class="iris-msg /g)?.length ?? 0

  /*
   * 100 or 101: the window is a tail of 100 and the boundary rounds outward to
   * a turn, which can reach back by one. Asserted as that range rather than as
   * `<= 101`, because a window that mounted *fewer* than it promised would also
   * satisfy an upper bound while showing the reader less than a screen.
   */
  assert.ok(
    mounted === DEFAULT_WINDOW || mounted === DEFAULT_WINDOW + 1,
    `a ${String(FLOORS)}-floor chat mounted ${String(mounted)} messages, expected ${String(DEFAULT_WINDOW)} or one more`,
  )

  // And the seam says how much is above it, because a window with no way back
  // is a truncation.
  assert.match(windowed, /class="iris-more"/, 'the load-more seam is missing')
  const above = FLOORS - mounted
  assert.ok(
    windowed.includes(`${String(above)} earlier`) || windowed.includes(String(above)),
    `the seam does not report the ${String(above)} messages above the window`,
  )

  // Every mounted floor is from the tail: floor 0 must not be on the page.
  assert.equal(windowed.includes('>floor 0<'), false, 'the oldest floor is mounted')
  assert.ok(windowed.includes(`floor ${String(FLOORS - 1)}`), 'the newest floor is not mounted')

  wired.store.setState({ view: seeded })

  wired.dispose()
  slots.dispose()
  console.log('render check: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
