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
import type { ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { createFakeClient } from '@iris/client-fake'

import { App } from '../src/app/App.tsx'
import { CharacterPage } from '../src/app/CharacterPage.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore, type IrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'
import { registerMessageAction } from '../src/slots/message-actions.ts'
import { RAIL_MAX_TICKS, railMode } from '../src/app/rail.ts'
import { bookFigures } from '../src/app/character-facts.ts'
import { modelMenu } from '../src/app/model-menu.ts'
import { DEFAULT_WINDOW } from '../src/app/reading-window.ts'
import type { MessageView } from '@iris/protocol'
import { contributing, discrepancy, rowsFor } from '../src/app/itemization.ts'
import {
  billedInputTokens, cacheHitPercent, formatTokens, totalTokens, usageDetailText,
} from '../src/app/token-format.ts'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the whole tree to HTML.
 *
 * zustand's server snapshot is the store's INITIAL state, so without the
 * override below a server render would only ever show the pre-boot empty shell.
 * That is a harness concession — nothing in the app depends on it.
 *
 * `tree` exists because **which sidebar tab is open is not store state**. It is
 * `useState` in `App` (`tab`, `face`), and deliberately so — the tab governs the
 * main area, and nothing outside the shell needs to know about it — which means
 * a server render, which cannot click, has no way to reach the library tab
 * through the store at all. There is no action to call: `store.ts` carries
 * `createChat`, `deleteCharacter`, `favoriteCharacter` and the rest, and nothing
 * that selects a face. So the character page is mounted directly, in the same
 * providers, and the concession is named rather than worked around by inventing
 * a store action for a test's benefit.
 *
 * What that costs: the page is rendered outside `iris-stage`, so this proves
 * what the page puts on screen for a given card, not that the tab switch
 * reaches it. `App.tsx`'s `tab === 'characters' ? <CharacterPage …/> : null` is
 * the one line neither this nor `character-page.test.ts` covers.
 * @param store - the booted store.
 * @param core - the slot registry.
 * @param tree - what to mount; the whole shell unless a caller says otherwise.
 * @returns the rendered markup.
 */
function render(store: IrisStore, core: SlotCore, tree: ReactElement = <App />): string {
  const api = store as unknown as { getInitialState: () => unknown }
  api.getInitialState = () => store.getState()
  return renderToString(
    <SlotProvider core={core}>
      <StoreProvider store={store}>
        {tree}
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

  // Disabled until there is something to send. The seal is drawn saturated in
  // both states (the design's call, 2026-09-07); what stays pinned is that it
  // cannot fire on an empty field - the idle class and the disabled attribute
  // travel together.
  assert.match(settled, /iris-composer__send--idle[^"]*"[^>]*disabled/, 'Send is not disabled while the composer is empty')

  // ---------------------------------------------------- model capsule
  /*
   * The model capsule is a **control**, and switching it moves only this
   * conversation.
   *
   * The reported failure was that the model name under the field could not be
   * pressed at all, so the first assertion is the crudest one that would have
   * caught it: the capsule is a `<button>` with a menu behind it, not a `<span>`
   * readout. What a server render cannot do is open that menu — the open state
   * is `useState` inside the component and there is no click here — so the
   * menu's *contents* are pinned in `tests/model-menu.test.ts`, against these
   * same seeded profiles, and what is pinned here is the wiring on either side
   * of it: the capsule offers a press, and a choice from the seeded list lands
   * on this chat and shows on the capsule.
   */
  const connections = wired.store.getState().connections
  const activeProfile = connections.find(row => row.id === wired.store.getState().activeConnectionId)
  const offered = activeProfile?.models ?? []
  // A floor on the fixture before anything is concluded from it: with no
  // recorded list the switch below would be testing a model nobody offered,
  // and every assertion after it would still pass.
  assert.ok(offered.length >= 2, 'the seeded active connection carries no model list to pick from')

  assert.match(
    settled,
    /<button[^>]*iris-composer__pill--action[^>]*aria-haspopup="menu"/,
    'the model capsule is not a button with a menu',
  )
  assert.match(settled, /local\/qwen3-8b<\/button>|local\/qwen3-8b<span/, 'the capsule does not name the model in force')
  assert.doesNotMatch(settled, /iris-composer__pill-dot/, 'the seeded chat is marked as overriding the model')

  // The switch. `offered[1]` rather than a literal, so this cannot pass by
  // agreeing with a hard-coded name the fixture has stopped carrying.
  const picked = offered[1]!
  await wired.store.getState().setChatModel(picked)
  const switched = render(wired.store, slots.core)
  assert.match(switched, new RegExp(`${picked.replace('/', '\\/')}<`), 'the capsule did not follow the switch')
  assert.match(switched, /iris-composer__pill-dot/, 'the per-conversation override is not marked')
  assert.equal(
    wired.store.getState().settingsOverrides?.model,
    picked,
    'the switch did not land on the chat’s own layer',
  )

  // And the undo puts it back, which is what makes the override safe to make.
  await wired.store.getState().setChatModel(null)
  const restored = render(wired.store, slots.core)
  assert.doesNotMatch(restored, /iris-composer__pill-dot/, 'clearing the override left the marker behind')
  assert.equal(wired.store.getState().settingsOverrides?.model, undefined)

  // ------------------------------------------- the capsule with no profile
  /*
   * The reported bug's own state: a host configured from its environment, with
   * no profile ever saved. The menu used to answer 「没有活动连接，因此没有可选
   * 的模型列表」 about a host that was generating replies at the time.
   *
   * What a server render can and cannot show here has to be said plainly. The
   * menu's open state is `useState` inside `Composer` and there is no click in
   * this harness, so the *rows* are not in the markup — `tests/model-menu.test.ts`
   * pins those. What this adds, and what a unit test cannot, is the **seam**:
   * the host row survives `connection.list` → the fake's projection → the
   * store, and the decision run over that live store state offers the host's
   * models rather than the empty sentence. The capsule itself is rendered in
   * the same state to prove the tree does not fall over without a profile.
   */
  wired.store.setState({ activeConnectionId: undefined })
  const state = wired.store.getState()
  const hostRow = state.hostConnection
  assert.ok(hostRow !== undefined, 'the fake host row did not reach the store')
  // A floor on the fixture before concluding anything from it: with no seeded
  // host list, "the menu offers the host's models" would pass by offering none.
  assert.ok((hostRow.models ?? []).length >= 2, 'the seeded host row carries no model list')

  const hostMenu = modelMenu({
    model: state.settings?.model ?? '',
    overrides: state.settingsOverrides,
    connections: state.connections,
    activeId: state.activeConnectionId,
    host: hostRow,
  })
  assert.equal(hostMenu.empty, undefined, 'the reported bug: a configured host read as no connection')
  assert.equal(hostMenu.source, 'host')
  for (const id of hostRow.models ?? []) {
    assert.ok(hostMenu.models.includes(id), `the host row's ${id} is not offered`)
  }
  // The model in force leads, whatever the endpoint lists — the seeded chat
  // runs a local model this endpoint has never heard of.
  assert.equal(hostMenu.models[0], state.settings?.model)
  assert.equal(hostMenu.hostKeyEnv, hostRow.keyEnv, 'the heading cannot name the variable to change')

  const profileless = render(wired.store, slots.core)
  assert.match(
    profileless,
    /<button[^>]*iris-composer__pill--action[^>]*aria-haspopup="menu"/,
    'the capsule stopped being a control once no profile was active',
  )
  // Put the seed back: everything below reads the store as booted.
  await wired.store.getState().loadConnections()
  assert.ok(wired.store.getState().activeConnectionId !== undefined, 'the seeded active profile did not come back')

  // --------------------------------------------------------- character page
  /*
   * Both ends of the facts row, on the two fixtures that were seeded to be the
   * two ends of it.
   *
   * The page drops a column when the fact behind it is absent (`没有的数据不编`),
   * and absence is the *common* case in the corpus: of the 19 local cards 15
   * carry no description, 2 embed no world book and 5 carry no scripts. So the
   * interesting render is the sparse one, and a check that only looked at 络络 —
   * the card the dev server opens on — would never see it.
   *
   * `character-page.test.ts` pins that each column's guard is still in the
   * source; this is the other half, and the only place the guards are actually
   * executed.
   */
  const library = wired.store.getState().characters
  const dense = library.find(row => row.characterId === 'luoluo')
  const plain = library.find(row => row.characterId === 'the-archivist')
  assert.ok(dense !== undefined && plain !== undefined, 'the fake no longer seeds the two fixture cards')
  // The fixture's premise, asserted rather than assumed: if the seed ever gives
  // the plain card a description or a count, every `doesNotMatch` below would
  // start passing for the wrong reason — the column would be *correctly* drawn
  // and the check would be reporting it as correctly absent.
  assert.ok(
    dense.description !== undefined && dense.bookEntryCount !== undefined && dense.scriptCount !== undefined,
    'the dense fixture lost one of its three facts, so the full row is no longer rendered here',
  )
  assert.ok(
    plain.description === undefined && plain.bookEntryCount === undefined && plain.scriptCount === undefined,
    'the plain fixture gained a fact, so the absent branches below are no longer being taken',
  )

  /*
   * The page's own fetch, run by hand.
   *
   * A server render never runs effects, so `loadCharacterDetail` — which the
   * page calls from `useEffect` — would never fire here and the three lists
   * could only ever be missing. Awaiting it first is the same concession the
   * store snapshot above is, and it buys the one thing this file can prove
   * about the lists: that the page renders what the client answered.
   */
  await wired.store.getState().loadCharacterDetail(dense.characterId)
  const detailHeld = wired.store.getState().characterDetail
  assert.ok(
    detailHeld !== undefined && detailHeld.characterId === dense.characterId && !detailHeld.loading,
    'the detail fetch did not settle against the dense card',
  )
  /*
   * The fixture's premise for the lists, asserted before anything is read off
   * the markup. The fake answers `worldbook.charDigest` only for a card whose
   * book it seeds and refuses the imported-card shape outright, so a seed change
   * that dropped 络络's book would leave every list assertion below passing on an
   * empty page — the failure mode this whole block exists to catch.
   */
  const detailHeldBooks = detailHeld.books
  const detailHeldScripts = detailHeld.scripts
  assert.ok(detailHeldBooks !== undefined && detailHeldBooks.length > 0, 'the fake no longer lists the dense card\'s books')
  assert.ok(detailHeldScripts !== undefined && detailHeldScripts.length > 0, 'the fake no longer lists the dense card\'s scripts')
  const entryCount = detailHeldBooks.reduce((sum, book) => sum + book.entries.length, 0)
  assert.ok(entryCount > 0, 'the seeded book has no entries, so no entry row can render')

  const densePage = render(wired.store, slots.core, <CharacterPage characterId={dense.characterId} onEnterReading={() => undefined} />)
  assert.ok(densePage.includes(dense.name), 'the dense card page does not name its character')
  // The 简介 band. Its own modifier class, because the heading word is shared
  // with nothing but the band is: a bare paragraph would sit outside the grid.
  assert.ok(densePage.includes('iris-fact--prose'), 'the description band is missing on a card that has one')
  assert.ok(densePage.includes(dense.description), 'the description band is drawn but empty')
  // The script count as the page words it (`{n} in this card`), read off the
  // summary rather than hardcoded: the fake takes the count from its own script
  // list, so a fourth fixture script must not fail this.
  assert.ok(
    densePage.includes(`${String(dense.scriptCount)} in this card`),
    'the script column does not report the count the summary carries',
  )
  assert.ok(densePage.includes('>World book<'), 'the world book column is missing on a card that embeds one')
  assert.ok(densePage.includes('>Conversations<'), 'the always-knowable column is missing')

  /*
   * ------------------------------------------------- the three columns' lists
   *
   * The upgrade this file is the only executable check on: each column carries
   * a *list* under its count now, and a count over an empty column is exactly
   * the state the page was in before. So each of the three is asserted by
   * something only its own data can produce — a chat's title, the book's
   * minted name and its ownFigures, a script's name and its two switches — rather
   * than by the presence of a class name, which would survive all three lists
   * rendering nothing.
   */
  const seededChat = wired.store.getState().chats.find(row => row.characterId === dense.characterId)
  assert.ok(seededChat !== undefined, 'the dense card has no seeded conversation to list')
  assert.ok(
    densePage.includes(`Open “${seededChat.title}”`),
    'the conversation list is missing: no row offers to open the seeded chat',
  )
  assert.ok(
    densePage.includes(`${String(seededChat.messageCount)} messages`),
    'a conversation row does not report how many floors it holds',
  )
  // The book row, by the name the *host* minted rather than the one the card
  // binds — which is the whole reason a reader cannot find their book in a flat
  // list, and the fake seeds the collision deliberately.
  const ownBook = detailHeldBooks[0]
  assert.ok(ownBook !== undefined)
  assert.ok(densePage.includes(ownBook.name), 'the world book list does not name the card\'s book')
  assert.ok(
    densePage.includes('renamed by this host'),
    'the minted-name note is gone, so a reader cannot tell why the name differs from the card\'s',
  )
  const ownFigures = bookFigures(ownBook)
  assert.ok(
    densePage.includes(`${String(ownFigures.entries)} entries · ${String(ownFigures.enabled)} on`),
    'a book row does not carry the ownFigures counted from the entries it was sent',
  )
  // The entries themselves, and enough of them: one row per entry in the book,
  // plus one per script, all sharing the row class. A page that rendered the
  // book's *summary* and dropped its entries would pass every assertion above.
  const rows = densePage.match(/class="iris-fact__entry"/g)?.length ?? 0
  assert.ok(
    rows >= entryCount + detailHeldScripts.length,
    `expected at least ${String(entryCount + detailHeldScripts.length)} entry rows, rendered ${String(rows)}`,
  )
  // Named, not indexed with a fallback: a nullish default would let this
  // assertion pass against any page at all the day the fixture had no entry
  // there, or an entry with no title.
  const firstEntry = ownBook.entries[0]
  assert.ok(
    firstEntry !== undefined && firstEntry.name !== "",
    "the seeded book’s first entry has no name to look for",
  )
  assert.ok(densePage.includes(firstEntry.name), "the first world book entry is not on the page")
  // The script list: a name, and both switches said as the reason rather than
  // the result. The fixture's third script is one its author shipped off, which
  // is the sentence a combined "off" could not produce.
  const authorOff = detailHeldScripts.find(script => !script.enabledByCard)
  assert.ok(authorOff !== undefined, 'the script fixture no longer carries an author-disabled script')
  assert.ok(densePage.includes(authorOff.name), 'the script list does not name the card\'s scripts')
  assert.ok(
    densePage.includes('the author shipped it off'),
    'the author\'s own switch is no longer distinguishable from the reader\'s',
  )
  /*
   * The source, asserted as part of the row's own composed meta line rather
   * than as the phrase alone: 「in the card」 also occurs in this column's
   * closing note about where the switch lives, so the bare substring passed
   * with the label deleted. Joined to the switch sentence it can only come from
   * a rendered script row.
   */
  assert.ok(
    densePage.includes('in the card · enabled'),
    'a script row does not say where the script came from',
  )

  /*
   * The plain card, fetched too — and this is the sharper half of the pair.
   *
   * The fake answers `{books: []}` for a card with no world info at all, so the
   * plain page is the case where the page *has* an answer and it is empty. An
   * empty list must still not draw a column: 「没有的数据不编」 is about the fact,
   * not about whether a call was made.
   */
  await wired.store.getState().loadCharacterDetail(plain.characterId)
  const plainDetail = wired.store.getState().characterDetail
  assert.ok(
    plainDetail?.books !== undefined && plainDetail.books.length === 0,
    'the plain fixture no longer answers with an empty book list, so the empty branch is untested',
  )

  const plainPage = render(wired.store, slots.core, <CharacterPage characterId={plain.characterId} onEnterReading={() => undefined} />)
  assert.ok(plainPage.includes(plain.name), 'the plain card page does not name its character')
  assert.equal(plainPage.includes('iris-fact--prose'), false, 'a card with no description drew the 简介 band')
  assert.equal(plainPage.includes('>World book<'), false, 'a card embedding no book drew the world book column')
  assert.equal(plainPage.includes('>Scripts<'), false, 'a card with no scripts drew the script column')
  // …and the one column that is always answerable stays, or the row would be
  // empty for a plain V1 card, which is a real shape and not a broken one.
  assert.ok(plainPage.includes('>Conversations<'), 'the plain card lost the column that is always knowable')

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

  // ------------------------------------------------------------ world books
  /*
   * The panel's grouping, rendered — and this is the only place it is.
   *
   * `worldbook-panel.test.ts` pins that the branches are still in the source
   * and that the store holds what the host answers; neither of those executes
   * a single one of them. The property under test here is the one the user's
   * report was about: with several books on disk, is the open card's own book
   * findable, named, and counted, and is the rest of the disk out of the way.
   *
   * The panel's effects do not run in a server render, so the two loads are
   * driven here, the same way the script panel's are above.
   */
  await wired.store.getState().loadWorldbooks()
  await wired.store.getState().loadCharBooks()

  const held = wired.store.getState().worldbooks
  const bound = wired.store.getState().charBooks
  assert.ok(held !== undefined, 'the world book panel never loaded')
  // The fixture's premise, asserted rather than assumed: with no books seeded
  // every assertion below would be checking an empty state while reading like a
  // check on a full one.
  assert.ok(held.names.length > 1, 'the fake seeds too few books for a grouping to be visible')
  assert.ok(held.books.length === held.names.length, 'the seeded books did not all report a count')
  assert.ok(bound?.card !== undefined, 'the host answered no book for the open card')
  assert.equal(bound.card.source, 'named', 'the open card’s book should be a file the panel can point at')

  const withBooks = render(wired.store, slots.core)

  // The card's own book, by name and by size. The name is the whole point: it
  // is neither the card's name nor the card's own binding, which is exactly why
  // a flat list of book names was unreadable.
  const cardBook = bound.card.name
  assert.ok(cardBook !== null, 'a named book with no name')
  assert.ok(withBooks.includes(cardBook), 'the card’s own book is not named in the panel')
  assert.ok(
    withBooks.includes(`${String(bound.card.entryCount)} entries`),
    'the card’s book is named without saying how big it is',
  )
  // …and that size is the same number the character page reports for the card's
  // embedded book, because the file was written out of it. Two screens, one
  // fact; a mismatch here means the seed has drifted apart from itself.
  assert.equal(
    bound.card.entryCount,
    dense.bookEntryCount,
    'the panel’s count and the character page’s count are no longer the same book',
  )
  /*
   * The sentence that answers "why is this called something else".
   *
   * The fixture's premise first: the card asks for one name, the file carries
   * another. Without that the note is correctly absent and the two assertions
   * below would pass for the wrong reason.
   */
  assert.ok(bound.card.materialised, 'the fixture no longer has the host minting a name')
  assert.ok(bound.primary !== null && bound.primary !== cardBook, 'the fixture’s two names agree, so nothing is explained')
  assert.ok(withBooks.includes(bound.primary), 'the name the card asked for is not on screen')
  assert.ok(
    withBooks.includes('under a name of its own'),
    'the panel shows a book under a name the card never asked for and does not say why',
  )

  // The mechanism, in words. The report was not only that the book was hard to
  // find — it was that nothing said a conversation plays its own card's book.
  assert.ok(
    withBooks.includes('plus whatever is switched on globally below'),
    'the panel no longer states how a conversation’s books are chosen',
  )

  // Ownership labels: a book this host materialised out of a card says so, so a
  // list of unfamiliar names becomes a list of names with owners.
  assert.ok(withBooks.includes(`from ${dense.name}`), 'no book reports which card it came from')

  // The disk, folded. The fold's own label is the assertion — an open fold
  // renders the collapse wording instead — and it carries the total, which is
  // what makes a folded list honest rather than a hidden one.
  const offDisk = held.names.filter(name => !held.globalSelect.includes(name)).length
  assert.ok(offDisk > 0, 'every seeded book is globally selected, so nothing is folded away')
  assert.ok(
    withBooks.includes(`Show all ${String(held.names.length)} books`),
    'the global book list is not folded, or does not say how many it is hiding',
  )
  assert.equal(
    withBooks.includes('Hide the full list'),
    false,
    'the global book list rendered open',
  )

  /*
   * The other two states of the top section, reached by writing the store.
   *
   * A harness concession of the same kind as the 677-floor chat below: the fake
   * seeds three cards and only one of them embeds a book, so `embedded` — a
   * card whose entries have never been written to a file — has no fixture to
   * reach it, and manufacturing a fourth seeded card to render one branch would
   * change what the dev server's library looks like for everybody. Nothing in
   * the app depends on this being possible.
   */
  for (const [source, sentence] of [
    ['embedded', 'embedded in the card, not written out yet'],
    ['none', 'This card has no world book.'],
  ] as const) {
    wired.store.setState({
      charBooks: { ...bound, card: { ...bound.card, source, entryCount: source === 'none' ? 0 : 140 } },
    })
    const state = render(wired.store, slots.core)
    assert.ok(state.includes(sentence), `the ${source} state of the card’s book does not render`)
    // The rule sentence stays whatever the answer is: "this card has no book"
    // is exactly when a reader most needs to be told what would reach it.
    assert.ok(
      state.includes('plus whatever is switched on globally below'),
      `the ${source} state dropped the mechanism sentence`,
    )
  }
  wired.store.setState({ charBooks: bound })

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

  // ------------------------------------------------------------------ usage
  /*
   * The two usage surfaces: the conversation's line under the composer, and
   * each reply's own reading in its actions row.
   *
   * Everything below reads the fake's **seeded** costs rather than a fixture
   * written here, and the numbers are computed from the seed rather than
   * spelled out, so a change to the seed moves the expectation with it instead
   * of turning this into a wrong-answer check. What the seed is shaped to
   * contain (`@iris/client-fake`'s `seed.ts`): one reply on a cache-reporting
   * provider, one on a cold prompt that reports `0`, one swipe that reported
   * nothing at all, and a greeting nobody was ever billed for.
   */
  const costed = wired.store.getState().view
  assert.ok(costed?.usage !== undefined, 'the fake no longer seeds a conversation total')
  const chatUsage = costed.usage
  const billed = billedInputTokens(chatUsage)
  const share = cacheHitPercent(chatUsage)
  assert.ok(share !== null, 'the seeded total should report a cache bucket, or the line loses a group')
  // The fixture's premise, asserted rather than assumed: a share that happened
  // to be 0% or 100% would let a hand-rolled or echoed figure pass here.
  assert.ok(
    Number(share) > 0 && Number(share) < 100,
    `the seeded cache share is ${share}%, which no longer exercises the computation`,
  )

  const priced = render(wired.store, slots.core)
  // English, because `getLanguage()` under node is `en` and nothing here
  // switches it; `tests/token-format.test.ts` holds both columns' wording.
  assert.match(priced, /class="iris-composer__stats"/, 'the composer usage line is missing')
  assert.ok(
    priced.includes(`Cache hit ${share}%`),
    'the usage line does not report the cache share',
  )
  assert.ok(
    priced.includes(`Input ${formatTokens(billed)} tok · Output ${formatTokens(chatUsage.outputTokens)} tok`),
    'the usage line does not report the billed input and the output',
  )
  /*
   * The assertion above is what discriminates the one wrong implementation
   * that would otherwise look right here: `ChatView.usage.totalTokens` is a
   * sum over only the generations that *reported* a total, so on a
   * conversation of mixed providers it is smaller than the buckets beside it,
   * and a line reading it would print a different number. It only
   * discriminates while the seed keeps a generation that reported buckets and
   * no total, so that premise is asserted rather than assumed — the message
   * says the check went blind, not that the interface broke.
   * `tests/token-format.test.ts` pins the rule unconditionally.
   */
  // The ruling behind the line's arithmetic: a conversation's summed usage
  // never carries totalTokens (a total summed only over the generations that
  // reported one is smaller than the buckets beside it once providers mix), so
  // the line has nothing to read but the buckets. Pinned here because a host
  // that started filling it would make the shortcut available again.
  assert.equal(chatUsage.totalTokens, undefined, 'the conversation total must stay absent; the usage line adds buckets')

  // Per-reply readings: exactly the replies whose generation reported a cost.
  const pricedFloors = costed.messages.flatMap(row =>
    row.usage === undefined ? [] : [{ id: row.id, usage: row.usage }])
  assert.ok(pricedFloors.length >= 2, 'the seed should price more than one reply')
  assert.equal(
    priced.match(/iris-act--reading/g)?.length,
    pricedFloors.length,
    'the per-turn reading appeared on a different number of floors than the host priced',
  )
  // …and not on the greeting, which was copied from the card rather than
  // generated. This is the absent branch, and it is a *seeded* absence: no
  // arithmetic can produce a figure for a reply nobody was billed for.
  assert.ok(
    costed.messages.some(row => row.role === 'assistant' && row.usage === undefined),
    'the seed no longer carries an unpriced reply, so the absent branch is not taken here',
  )
  for (const floor of pricedFloors) {
    assert.ok(
      priced.includes(`>Usage ${formatTokens(totalTokens(floor.usage))}<`),
      `floor ${String(floor.id)} does not carry its own usage reading`,
    )
  }
  // The hover table reaches the page as the `title`, rows and all — this is the
  // only place the plain-text assembly is actually rendered into the DOM. Read
  // off the reply that reported reasoning, because the reasoning note is a row
  // inside another row rather than one of its own.
  const reasoned = pricedFloors.find(row => row.usage.reasoningTokens !== undefined)
  assert.ok(reasoned !== undefined, 'the seed should price one reply with reasoning')
  for (const row of usageDetailText(reasoned.usage).split('\n')) {
    assert.ok(priced.includes(row), `the breakdown row "${row}" did not reach the page`)
  }

  /*
   * The empty state, from the fake's second conversation.
   *
   * `usage` is optional everywhere, so a row that rendered unconditionally
   * would put a line of blank height under the composer for the whole life of
   * an imported chat. The fake seeds one with no costs anywhere for exactly
   * this check, and it is opened through the real action rather than written
   * into the store — the point is that a conversation switch takes the row
   * away again.
   */
  const other = wired.store.getState().chats.find(row => row.chatId !== costed.chatId)
  assert.ok(other !== undefined, 'the fake no longer seeds a second conversation')
  await wired.store.getState().openChat(other.chatId)
  assert.equal(
    wired.store.getState().view?.usage,
    undefined,
    'the second seeded conversation is meant to carry no costs at all',
  )
  const unpriced = render(wired.store, slots.core)
  assert.doesNotMatch(
    unpriced,
    /iris-composer__stats/,
    'the usage line was drawn for a conversation the host reported no usage for',
  )
  assert.doesNotMatch(
    unpriced,
    /iris-act--reading/,
    'a reply with no reported usage still got a usage reading',
  )

  wired.dispose()
  slots.dispose()
  console.log('render check: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
