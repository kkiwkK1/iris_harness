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
import { createFakeClient, fakeItemization } from '@iris/client-fake'

import { App } from '../src/app/App.tsx'
import { CharacterPage } from '../src/app/CharacterPage.tsx'
import { Sidebar } from '../src/app/Sidebar.tsx'
import { ConnectionPanel } from '../src/app/ConnectionPanel.tsx'
import { PluginCenter } from '../src/app/PluginCenter.tsx'
import { StoreProvider } from '../src/client/provider.tsx'
import { createIrisStore, type IrisStore } from '../src/client/store.ts'
import { SlotProvider } from '../src/slots/Slot.tsx'
import { createIrisSlots } from '../src/slots/slots.ts'
import { registerMessageAction } from '../src/slots/message-actions.ts'
import { pushCardPopup, resetCardPopups } from '../src/app/card-popups.ts'
import { planPopup } from '../src/sandbox/popup.ts'
import { RAIL_MAX_TICKS, railMode } from '../src/app/rail.ts'
import { bookFigures } from '../src/app/character-facts.ts'
import { modelMenu } from '../src/app/model-menu.ts'
import { DEFAULT_WINDOW } from '../src/app/reading-window.ts'
import type { MessageView } from '@iris/protocol'
import { contributing, discrepancy, rowsFor } from '../src/app/itemization.ts'
import { pressureLevel } from '../src/app/context-occupancy.ts'
import { ringDash } from '../src/app/composer-bar.ts'
import { ContextCard } from '../src/app/ContextMeter.tsx'
import { cacheCeiling, providerExcuse, providerFellShort } from '../src/app/divergence.ts'
import {
  billedInputTokens, cacheHitPercent, formatExactTokens, formatTokens, totalTokens, usageChipText,
  usageDetailRows, usageSideShareSentences, usageSummaryRows,
} from '../src/app/token-format.ts'
import { UsageDetailCard } from '../src/app/UsagePopover.tsx'
import { UsageReport } from '../src/app/UsagePanel.tsx'
import { searchSettings } from '../src/app/SettingsNavigation.tsx'
import { setLanguage } from '../src/app/i18n/language.ts'
// Aliased: `totalTokens` above is the one-generation reader, and this is the
// aggregate one. Two functions of the same name over different types is exactly
// the confusion the protocol drops `totalTokens` from every aggregate to avoid.
import { hitRate, totalTokens as usageTotal, USAGE_METRICS, USAGE_RANGES } from '../src/app/usage-stats.ts'
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
  /*
   * The drawer's fields are populated from the store.
   *
   * This used to read `value="openai-compat"` — the 「路由」 card's `provider`
   * text field. That card is gone (web §77): `provider` and `model` there were
   * the one route in the product a reader could type, and a typed route is the
   * failure the connection panel is built around. The check keeps its job by
   * moving to a field that still exists, and reads the expected value off the
   * store rather than repeating a literal, so a fixture that stops seeding a
   * temperature fails here rather than passing vacuously.
   */
  const seededTemperature = wired.store.getState().settings?.temperature
  assert.ok(seededTemperature !== undefined, 'the fixture must seed a temperature for this check')
  assert.match(
    settled,
    new RegExp(`value="${String(seededTemperature)}"`),
    'settings fields did not populate',
  )
  // And the card that held the typed route has not come back.
  assert.doesNotMatch(settled, /id="iris-card-route"/, 'the route card is back — the route is typable again')
  assert.equal(settled.match(/data-settings-destination=/g)?.length, 15, 'the settings directory should expose fifteen destinations')
  assert.equal(settled.match(/data-settings-route=/g)?.length, 15, 'every settings destination needs one drawer-local page')
  assert.match(settled, /aria-label="Search settings categories"/, 'the category search is missing')
  assert.match(settled, /role="tablist" aria-label="Regex scope"/, 'the regex scopes are not an accessible segmented control')
  assert.deepEqual(searchSettings('上下文').map(row => row.route), ['memory/context'], 'Chinese category search did not reach context')
  assert.deepEqual(searchSettings('reading').map(row => row.route), ['appearance'], 'English category search did not reach reading')
  assert.deepEqual(searchSettings('mvu').map(row => row.route), ['plugins'], 'plugin search did not reach the system plugin center')

  // ------------------------------------------------------ system plugins
  // Mounted directly so its own lifecycle states can be rendered without a
  // click-only trip through the settings directory.
  const pluginClient = createFakeClient({ chunkDelayMs: 0 })
  const pluginWired = createIrisStore(pluginClient, { transport: 'fake', origin: 'plugin render check' })
  await pluginWired.store.getState().boot()
  const pluginCenter = render(pluginWired.store, slots.core, <PluginCenter />)
  assert.match(pluginCenter, /data-plugin-center="true"/, 'the plugin center did not render')
  assert.equal(pluginCenter.match(/data-plugin-id=/g)?.length, 2, 'the bundled catalog should render two plugins')
  assert.match(pluginCenter, /TavernHelper/, 'TavernHelper is missing from the bundled catalog')
  assert.match(pluginCenter, /MVU/, 'MVU is missing from the bundled catalog')
  assert.match(pluginCenter, /Disable MVU first/, 'TavernHelper actions do not explain the enabled dependent')
  assert.match(pluginCenter, /Uninstalling keeps card and chat data/, 'the plugin center does not state what uninstall retains')
  assert.doesNotMatch(pluginCenter, /marketplace|download package/i, 'the bundled catalog is pretending to be a network installer')

  const currentPlugins = pluginWired.store.getState().systemPlugins
  assert.ok(currentPlugins !== undefined, 'plugin state did not load for transition rendering')
  pluginWired.store.setState({
    systemPlugins: {
      revision: currentPlugins.revision + 1,
      plugins: currentPlugins.plugins.map(plugin => plugin.id === 'mvu'
        ? { ...plugin, enabled: false, status: 'enabling' as const }
        : plugin),
    },
  })
  const enabling = render(pluginWired.store, slots.core, <PluginCenter />)
  const mvuAt = enabling.indexOf('data-plugin-id="mvu"')
  const mvuRow = enabling.slice(mvuAt, enabling.indexOf('</article>', mvuAt))
  assert.match(mvuRow, /data-plugin-status="enabling"/, 'the pending runtime state is not exposed')
  assert.match(mvuRow, />Enabling…<\/button>/, 'the active action label does not stay in its pending tense')
  assert.doesNotMatch(mvuRow, />Enable<\/button>/, 'an enabling plugin is misleadingly offered as disabled')

  await pluginWired.store.getState().refreshSystemPlugins()
  await pluginWired.store.getState().uninstallSystemPlugin('mvu')
  assert.match(render(pluginWired.store, slots.core, <PluginCenter />), />Reinstall<\/button>/, 'a removed bundled plugin cannot be reinstalled')

  setLanguage('zh')
  const chinesePlugins = render(pluginWired.store, slots.core, <PluginCenter />)
  assert.match(chinesePlugins, /系统插件为卡片提供可选的运行能力/, 'the plugin center has no Chinese lead')
  assert.match(chinesePlugins, /重新安装/, 'the bundled reinstall action has no Chinese label')
  setLanguage('en')
  pluginWired.dispose()
  pluginClient.dispose()
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

  // Disabled until there is something to send, and quiet while it is: the disc
  // is desaturated on an empty draft (the design's call, 2026-09-10, overturning
  // the 2026-09-07 "saturated in both states" ruling — web §80). What stays
  // pinned is what was pinned before: it cannot fire on an empty field, and the
  // idle class and the disabled attribute travel together.
  assert.match(settled, /iris-composer__send--idle[^"]*"[^>]*disabled/, 'Send is not disabled while the composer is empty')
  // The word is the disc's name, because the disc is 32px across and the word
  // does not fit inside it.
  assert.match(settled, /aria-label="Send"/, 'the send disc has no accessible name')

  // ------------------------------------------------------------- sidebar
  /*
   * The panel's head, its rows, and both of its forms.
   *
   * Every assertion here was a specific decision in `dev/sidebar-redesign`, and
   * each is the kind a server render can actually judge: which elements exist,
   * which are nested inside which, and what a control advertises about itself.
   * Nothing about the fold's timing or the drag's motion is checkable here, and
   * none of it is asserted — `shell.css` and the browser own those.
   */
  // The identity: the aperture, open, and the wordmark beside it. The plum
  // blossom used to be here and is now only the composer's seal — a decoration
  // doing an identity's job meant the product's mark changed with the theme.
  assert.match(settled, /class="iris-brand"/, 'the sidebar has no head')
  const brandHead = settled.slice(settled.indexOf('iris-brand'), settled.indexOf('iris-tabs'))
  assert.match(brandHead, /iris-aperture/, 'the aperture mark is missing from the head')
  assert.doesNotMatch(brandHead, /iris-aperture--shut/, 'the expanded head shows the aperture shut')
  assert.match(brandHead, /class="iris-brand__word">Iris</, 'the wordmark is missing')
  // The blossom is still in the product, and still exactly where it belongs.
  assert.match(settled, /iris-composer__seal/, 'the composer lost the plum seal')

  /*
   * One row, and what it is made of.
   *
   * The four-column grid is a stylesheet fact, so what is pinned here is the
   * DOM that grid needs: the handle cell, the title, the stamp and the reserved
   * well, in that order, inside one `<button>` — plus the stamp's short
   * spelling, which is the copy change the single line paid for.
   */
  const rowAt = settled.indexOf('class="iris-row-shell"')
  assert.ok(rowAt > 0, 'no conversation row rendered')
  const oneRow = settled.slice(rowAt, settled.indexOf('</div>', rowAt))
  assert.match(oneRow, /class="iris-row iris-row--chat"/, 'the row is not the single-line chat row')
  const cells = ['iris-row__grip', 'iris-row__title', 'iris-row__meta', 'iris-row__well']
  for (const cell of cells) {
    assert.ok(oneRow.includes(cell), `the row is missing ${cell}, so its four columns cannot line up`)
  }
  const cellsAt = cells.map(cell => oneRow.indexOf(cell))
  assert.deepEqual(
    [...cellsAt].sort((left, right) => left - right),
    cellsAt,
    'the row cells are out of document order, so the grid would put them in the wrong columns',
  )
  // The stamp is the short spelling: `2d ago · 3 msg`, not `3 messages`.
  assert.match(oneRow, /[0-9]+ msg</, 'the row stamp does not use the short message count')
  assert.doesNotMatch(oneRow, /[0-9]+ messages</, 'the row stamp still spends a whole word on the noun')

  /*
   * The overflow trigger is in the row and is **not** inside the row's button.
   *
   * This is the redesign's one structural rule, and the one that would fail
   * silently: a `<button>` inside a `<button>` renders and looks right, and the
   * parser repairs it by hoisting the inner one out of the outer — so the
   * control the reader sees inside the row sits somewhere else in the DOM, with
   * a different tab position and a different event target. So: the trigger
   * exists, it is inside the shell, and it is *after* the row button closes.
   */
  assert.match(oneRow, /class="iris-row__acts"/, 'the row has no inline actions cell')
  const rowButtonEnds = oneRow.indexOf('</button>')
  assert.ok(rowButtonEnds > 0, 'the row is not a button any more')
  assert.ok(
    oneRow.indexOf('iris-row__acts') > rowButtonEnds,
    'the actions cell is inside the row button: that is a button inside a button',
  )
  assert.match(oneRow, /iris-row__more/, 'the overflow trigger is missing from the row')
  // And the handle is drawn, which is what says the row can be moved at all.
  assert.match(oneRow, /iris-row__grip"><svg/, 'the drag handle is not drawn on a root row')

  /*
   * The collapsed form.
   *
   * Mounted directly, and the concession is the one the character page's mount
   * records above: whether the panel is folded is `useState` in `App` seeded
   * from `localStorage`, and a server render cannot click. The three
   * destinations, the expand control and what it says about the region it
   * controls are what a rail has to have — an icon column that reported nothing
   * about its own state would be four glyphs a screen reader cannot explain.
   */
  const railed = render(
    wired.store,
    slots.core,
    <Sidebar
      collapsed
      onCollapsed={() => undefined}
      tab="chats"
      onTab={() => undefined}
      face={undefined}
      onFace={() => undefined}
    />,
  )
  assert.match(railed, /class="iris-sidebar iris-sidebar--rail"/, 'the collapsed panel is not the rail')
  assert.match(railed, /iris-aperture--shut/, 'the rail does not show the aperture closed')
  for (const rail of ['chats', 'characters', 'search', 'import']) {
    assert.match(
      railed,
      new RegExp(`data-rail="${rail}"`),
      `the rail has no ${rail} icon, so that destination is unreachable while folded`,
    )
  }
  /*
   * Scoped to the control being asked about, in both directions.
   *
   * Both fold controls are in the tree at once — one in the head, one in the
   * rail — so an unscoped search for `aria-expanded="true"` finds whichever of
   * the two happens to be saying it. The first version of this pair did exactly
   * that and stayed green when the head control's own value was inverted,
   * because the rail's was still there to satisfy it. Each half now reads only
   * its own control's region.
   */
  const railHead = railed.slice(railed.indexOf('class="iris-sidebar__rail"'))
  assert.ok(railHead.length > 0, 'the collapsed panel has no rail to read')
  assert.match(
    railHead,
    /aria-expanded="false"[^>]*aria-controls="iris-sidebar-body"/,
    "the rail's expand control does not say the region it controls is collapsed",
  )
  // Expanded, the head's own control reports the other state — from one switch,
  // so the two can never disagree.
  assert.match(
    brandHead,
    /aria-expanded="true"[^>]*aria-controls="iris-sidebar-body"/,
    'the expanded head does not report the sidebar as expanded',
  )
  // Both forms are in the tree, and the one that is away is hidden rather than
  // merely faded: `Sidebar.tsx` argues why they are both mounted, and this is
  // the half of that argument a render can check.
  assert.match(
    railed,
    /class="iris-sidebar__full" id="iris-sidebar-body" aria-hidden="true"/,
    'the folded panel still offers its list to the accessibility tree',
  )
  assert.match(
    settled,
    /class="iris-sidebar__rail" aria-hidden="true"/,
    'the expanded panel still offers the rail to the accessibility tree',
  )

  // ---------------------------------------------------- model capsule

  // ------------------------------------------------------- the composer bar
  /*
   * The card and the one row along its bottom edge (web §80).
   *
   * What a server render can hold here is the **structure**: the card exists,
   * the bar exists, each of the three controls that open a list says so, the
   * readings moved out of the card, and no menu is in the markup while they are
   * all closed. The rows inside those menus cannot be reached — the open state
   * is `useState` in the component and there is no click in this harness — so
   * they are pinned in `tests/composer-bar.test.ts` and
   * `tests/model-menu.test.ts`, which is the division the capsules had before.
   */
  assert.match(settled, /class="iris-composer__card"/, 'the composer card is missing')
  assert.match(settled, /class="iris-composer__bar"/, 'the bar along the card’s bottom edge is missing')
  assert.match(
    settled,
    /<button[^>]*iris-composer__disc--quiet[^>]*aria-haspopup="menu"/,
    'the 「+」 key is not a button with a menu behind it',
  )
  assert.match(settled, /aria-label="Prompt and commands"/, 'the 「+」 key has no accessible name')
  assert.match(
    settled,
    /<button[^>]*iris-composer__choice[^>]*aria-haspopup="menu"/,
    'the preset control is not a button with a menu behind it',
  )
  /*
   * And it says which preset is in force — which here is none, honestly.
   *
   * **The fake refuses the whole `preset.*` family on purpose** (`client.ts`:
   * they write host-side files, and a fake that answered would teach the
   * interface a library that does not exist), so `activePreset` is `undefined`
   * against this transport and the control prints the absence. That is the
   * assertion worth making here: the branch a seeded page actually takes, with
   * the fixture's premise stated rather than assumed. The *populated* branch is
   * one `activePreset` away and is what a host build shows; nothing in this
   * harness can reach it, because the composer's own `loadPresets` is an effect
   * and `renderToString` runs no effects.
   */
  assert.equal(
    wired.store.getState().activePreset,
    undefined,
    'the fake now serves a preset library, so this check is testing the wrong branch',
  )
  assert.ok(
    settled.includes('<span class="iris-composer__choice-name">no preset active</span>'),
    'the preset control does not say that no preset is in force',
  )
  // Nothing is open, so nothing is portalled: each menu is mounted only while it
  // is showing, which is what keeps its document listeners and its layout effect
  // off every keystroke of an ordinary message.
  assert.doesNotMatch(settled, /iris-composer-menu/, 'a bar menu is in the markup while it is closed')
  // The two readings sit outside the paper, on one line under the card.
  assert.match(settled, /class="iris-composer__under"/, 'the line under the card is missing')
  // The slot keeps its wrapper with nothing in it, because 「the slot contributed
  // nothing」 is `:empty` in the stylesheet and `:empty` needs an element to be
  // empty of. A slot rendered bare would take the divider rule with it.
  assert.match(
    settled,
    /<span class="iris-composer__slot"><\/span>/,
    'the actions slot lost the wrapper the divider rule reads',
  )

  // ---------------------------------------------------- model control
  /*
   * The model control is a **control**, and switching it moves only this
   * conversation.
   *
   * The reported failure was that the model name under the field could not be
   * pressed at all, so the first assertion is the crudest one that would have
   * caught it: it is a `<button>` with a menu behind it, not a `<span>` readout.
   * What a server render cannot do is open that menu — the open state is
   * `useState` inside the component and there is no click here — so the menu's
   * *contents* are pinned in `tests/model-menu.test.ts`, against these same
   * seeded profiles, and what is pinned here is the wiring on either side of it:
   * the control offers a press, and a choice from the seeded list lands on this
   * chat and shows on the control.
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
    /<button[^>]*iris-composer__model[^>]*aria-haspopup="menu"/,
    'the model control is not a button with a menu',
  )
  assert.match(
    settled,
    /iris-composer__model-name">local\/qwen3-8b</,
    'the control does not name the model in force',
  )
  assert.doesNotMatch(settled, /iris-composer__model-dot/, 'the seeded chat is marked as overriding the model')

  // The switch. `offered[1]` rather than a literal, so this cannot pass by
  // agreeing with a hard-coded name the fixture has stopped carrying.
  const picked = offered[1]!
  await wired.store.getState().setChatModel(picked)
  const switched = render(wired.store, slots.core)
  assert.match(switched, new RegExp(`${picked.replace('/', '\\/')}<`), 'the control did not follow the switch')
  assert.match(switched, /iris-composer__model-dot/, 'the per-conversation override is not marked')
  assert.equal(
    wired.store.getState().settingsOverrides?.model,
    picked,
    'the switch did not land on the chat’s own layer',
  )

  // And the undo puts it back, which is what makes the override safe to make.
  await wired.store.getState().setChatModel(null)
  const restored = render(wired.store, slots.core)
  assert.doesNotMatch(restored, /iris-composer__model-dot/, 'clearing the override left the marker behind')
  assert.equal(wired.store.getState().settingsOverrides?.model, undefined)

  // ------------------------------------------------------- reasoning effort
  /*
   * The other half of the model control, and the layer it writes to.
   *
   * The effort ladder is a section of the same menu, so its rows are as
   * unreachable here as the model rows are — but the **write** is reachable, and
   * it is the half worth holding on a live store: the bar goes through
   * `patchSettings`, whose scope rule is "the open conversation when there is
   * one", and the plausible wrong implementation writes the global layer, which
   * looks identical on the control and silently changes every other
   * conversation. `tests/composer-bar.test.ts` pins that the composer reaches
   * for that action; this pins where that action's write lands and that the word
   * reaches the control.
   *
   * Written through the store's own action rather than by pressing a row, for
   * the same reason `setChatModel` is above.
   */
  assert.equal(
    wired.store.getState().settings?.reasoningEffort,
    undefined,
    'the fixture already carries an effort, so the control below cannot show a change',
  )
  const unset = render(wired.store, slots.core)
  assert.doesNotMatch(unset, /iris-composer__model-effort/, 'a word is printed for an effort nobody chose')
  await wired.store.getState().patchSettings({ reasoningEffort: 'high' })
  const effortful = render(wired.store, slots.core)
  assert.equal(
    wired.store.getState().settingsOverrides?.reasoningEffort,
    'high',
    'the effort did not land on the open conversation’s own layer',
  )
  assert.match(
    effortful,
    /<span class="iris-composer__model-effort">high<\/span>/,
    'the control does not print the effort in force beside the model',
  )
  // And `auto` clears rather than storing a word, so the layer goes back to
  // having no opinion — the row's own rule (`effortPatch`), end to end.
  await wired.store.getState().patchSettings({ reasoningEffort: null })
  assert.equal(
    wired.store.getState().settingsOverrides?.reasoningEffort,
    undefined,
    'choosing auto left an override behind',
  )
  assert.doesNotMatch(
    render(wired.store, slots.core),
    /iris-composer__model-effort/,
    'the word stayed on the control after the effort was cleared',
  )

  // ------------------------------------- the model control with no profile
  /*
   * With no provider in use, the capsule has **nothing to offer and says so**.
   *
   * This check used to assert the opposite, and was right to: the host's own
   * launch connection was a second model source, and ignoring it was a reported
   * bug (a configured host reading as "no connection is active" while it
   * answered messages). The user's ruling of 2026-09-10 removes that source —
   * the environment is not a connection (web §79) — and host §61 makes the same
   * state honest from the other end: nothing generates either, so `no-connection`
   * is a report rather than the mistake it used to be.
   *
   * What a server render can and cannot show here has to be said plainly. The
   * menu's open state is `useState` inside `Composer` and there is no click in
   * this harness, so the *rows* are not in the markup —
   * `tests/model-menu.test.ts` pins those. What this adds, and what a unit test
   * cannot, is the **seam**: the decision is run over the live store state that
   * `connection.list` → the fake → the store produced, and the capsule is
   * rendered in the same state to prove the tree does not fall over with no
   * provider in use.
   */
  wired.store.setState({ activeConnectionId: undefined })
  const state = wired.store.getState()
  // A floor on the fixture: the seeded profiles are still there, so this is
  // "nothing in use" and not "nothing saved" — the two are different states
  // and only one of them is what this check means.
  assert.ok(state.connections.length >= 2, 'the fixture lost its saved providers')

  const noneInUse = modelMenu({
    model: state.settings?.model ?? '',
    overrides: state.settingsOverrides,
    connections: state.connections,
    activeId: state.activeConnectionId,
  })
  assert.equal(noneInUse.empty, 'no-connection', 'the capsule found a model source with no provider in use')
  assert.equal(noneInUse.source, undefined, 'a source was named with no provider in use')
  assert.equal(noneInUse.probe, undefined, 'the capsule would fire a probe at nothing')
  assert.equal(noneInUse.connectionModel, undefined, 'the restore row names a model no connection supplies')
  // The model in force is still offered — it is what this conversation is set
  // to, whether or not anything will generate with it.
  assert.deepEqual(noneInUse.models, [state.settings?.model])

  const profileless = render(wired.store, slots.core)
  assert.match(
    profileless,
    /<button[^>]*iris-composer__model[^>]*aria-haspopup="menu"/,
    'the model control stopped being a control once no profile was active',
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
  /*
   * The composer's third state, and the only one of the three a server render
   * can reach besides the empty one: a reply is arriving.
   *
   * The disc becomes Stop in the disc's own place — not a fourth control beside
   * it — and the ring turns. Both are on the *same* render, which is the point:
   * a bar that showed Stop while the ring still looked idle, or a ring that
   * spun with Send still under it, would each be half of this state. The
   * with-a-draft state is unreachable here (the draft is `useState` and there is
   * no keyboard in a server render), so `tests/composer-bar.test.ts` holds the
   * ready branch against the source instead.
   */
  assert.match(streaming, /iris-composer__send--stop/, 'the send disc did not become Stop mid-turn')
  assert.match(streaming, /aria-label="Stop"/, 'the stop disc has no accessible name')
  assert.doesNotMatch(streaming, /iris-composer__send--(idle|ready)/, 'Send is still on the page mid-turn')
  assert.match(streaming, /iris-composer__ring--busy/, 'the capacity ring does not show a reply in flight')
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

  /*
   * What page access actually costs, named concretely — the network audit's
   * M-3. The grant makes the card's frame same-origin with the shell, and the
   * copy said only "your other conversations": the same-origin frame can also
   * read this page's stored preferences, call every host action in the user's
   * name, and read `input[type=password].value` in the connection panel while
   * an API key is being typed or pasted. A dialog that named one of four is a
   * dialog collecting consent under a description of its own choosing.
   *
   * Asserted here rather than only in the dictionary test because the dialog is
   * a *component's* copy: `RiskConfirmation` takes four separate strings, and a
   * key that stopped being passed would still be in the dictionary.
   */
  assert.match(withScripts, /API key/, 'the off copy does not name the key the grant would expose')
  assert.match(withScripts, /connection panel/, 'the off copy does not say where the key is typed')
  assert.match(withScripts, /stored preferences/, 'the off copy does not name the stored preferences')

  /*
   * And the granted state's own sentence, which is the one a reader checks
   * *after* turning it on — reached by actually granting, because the dialog
   * that says the same thing is a modal a server render cannot open. Revoked
   * again below so every later render in this file sees the default state.
   */
  await wired.store.getState().setDocumentGrant(true)
  const whenGranted = render(wired.store, slots.core)
  assert.match(whenGranted, /part of this page/, 'the granted state does not say the sandbox is gone')
  assert.match(
    whenGranted,
    /every conversation here/,
    'the granted copy does not say it reads every conversation',
  )
  assert.match(whenGranted, /stored preferences/, 'the granted copy does not name the preferences')
  assert.match(
    whenGranted,
    /any host action in your name/,
    'the granted copy does not say the card acts as the user',
  )
  assert.match(whenGranted, /spends your tokens/, 'the granted copy does not say generation is billed')
  assert.match(whenGranted, /API key while you type or paste it/, 'the granted copy does not name the key')
  await wired.store.getState().setDocumentGrant(false)

  /*
   * And the scripts the script list does not know about — the system audit's
   * F9. The seeded greeting carries a card interface with one inline
   * `<script>`; `interfacesMayBuild` runs it whatever the consent answer is,
   * and before this line nothing on screen said so.
   *
   * Checked against a count rather than a phrase alone: a sentence that said
   * "embedded scripts" while counting zero would pass a phrase match and be
   * exactly the reassuring lie this is here to stop.
   */
  assert.match(
    withScripts,
    /carries 1 embedded script/,
    'the panel does not report the scripts embedded in the interface markup',
  )
  assert.match(
    withScripts,
    /the scripts question does not cover it/,
    'the panel does not say the question leaves the markup scripts out',
  )
  /*
   * Counted, not merely matched, and the count is two.
   *
   * The question is put in **two** places — `ConsentAsk` above the conversation
   * and `ConsentGate` inside the settings panel — and a match against the page
   * is satisfied by either. That is exactly the shape of check that passes
   * while half the surface has gone quiet, so the number is asserted: a card's
   * reader who never opens the drawer, and one who only opens the drawer, must
   * both be told.
   */
  assert.equal(
    withScripts.match(/carries 1 embedded script/g)?.length,
    2,
    'both the banner and the settings panel must state the embedded count',
  )

  /*
   * And it has to survive the question being answered.
   *
   * The markup scripts run whatever the answer was — declining the card's
   * script list does not stop them — so a panel that said this only while the
   * question was on screen would fall silent at exactly the moment the reader
   * believed they had switched something off. Driven through the real action,
   * because the state the sentence has to survive is a state the host stores.
   */
  await wired.store.getState().answerScriptsAllowed(false)
  const afterAnswer = render(wired.store, slots.core)
  assert.doesNotMatch(afterAnswer, /Run them/, 'the question is answered and should be gone')
  assert.match(
    afterAnswer,
    /carries 1 embedded script/,
    'the count disappeared once the question was answered',
  )

  // ------------------------------------------------- regex, both tiers
  /*
   * The two regex sections and the editor, rendered.
   *
   * Both panels return `null` until their data is in, and their effects do not
   * run in a server render — so the loads are driven here. That is also what
   * makes the check meaningful: the failure this pins is a section that renders
   * *nothing*, which for a panel whose absent state is also `null` is
   * indistinguishable from a host that has no store.
   *
   * The fake answers `regex.list` and `regex.scopedList` from memory for
   * exactly this reason. It refused both until this round, so the whole regex
   * panel had never been rendered by anything in the repository, and the
   * editor added here would have had nowhere to be checked.
   */
  await wired.store.getState().loadRegex()
  await wired.store.getState().loadScopedRegex(character)
  const regexHeld = wired.store.getState()
  assert.ok(
    (regexHeld.regexScripts ?? []).length > 0,
    'the fake no longer seeds a global regex tier, so the panel cannot render',
  )
  assert.ok(
    (regexHeld.scopedRegex ?? []).length > 0,
    'the fake no longer seeds a scoped regex tier for the open chat’s card',
  )

  const withRegex = render(wired.store, slots.core)
  assert.match(withRegex, /Global regex/, 'the global regex section is missing')
  // Same hazard as the library names below, and the same handle: the global
  // list renders a per-row delete label, the scoped list does not (its rules
  // belong to the card and cannot be deleted here), so the two are told apart
  // by which control appears beside the name.
  assert.match(withRegex, /Delete the script 隐藏思考块/, 'the seeded global rule has no row')
  assert.match(withRegex, /This character’s regex/, 'the card’s own regex section is missing')
  assert.match(withRegex, /状态栏隐藏/, 'the seeded scoped rule is not listed')
  assert.doesNotMatch(
    withRegex,
    /Delete the script 状态栏隐藏/,
    'the card’s own rule is offered a delete, which would rewrite the card',
  )
  // The two switches, reported separately — the whole reason the scoped view
  // carries `enabledByCard` beside `enabled`.
  assert.match(withRegex, /off by the card/, 'a card-disabled rule is not distinguished')
  // The permission that did not exist before this round. Its absence was the
  // compatibility gap: upstream gates this tier on `character_allowed_regex`
  // and this host ran it unconditionally.
  assert.match(withRegex, /Stop them running/, 'the card’s regex tier has no allow switch')
  assert.match(withRegex, /Write a rule/, 'there is no way to author a rule')
  // And the editor is not open until it is asked for: a form that rendered
  // unconditionally would put a dozen fields in the drawer for every reader.
  assert.doesNotMatch(withRegex, /Trim out/, 'the rule editor is open before anyone opened it')

  // ------------------------------------------- regex, the preset tier
  /*
   * The third tier, in **both** of its states.
   *
   * Rendered twice on purpose. The refused render is the one a fresh profile
   * actually sees — this tier arrives off — and the assertions there are about
   * a section that has to explain itself while running nothing: the preset's
   * name, the rules it ships, the count that is *not* running, the reason, and
   * the rows the reader dropped. The allowed render then pins that the same
   * section reports a running count once the switch is on, which is the half a
   * default-off feature can ship broken with every other check green.
   */
  await wired.store.getState().loadPresetRegex()
  const presetHeld = wired.store.getState()
  assert.ok(
    (presetHeld.presetRegex ?? []).length > 0,
    'the fake no longer seeds a preset regex tier, so the panel cannot render',
  )
  assert.equal(
    presetHeld.presetRegexAllowed,
    false,
    'the fake seeds the preset tier as allowed, so the default-off state is never rendered',
  )
  assert.ok(
    presetHeld.presetRegexMalformed > 0,
    'the fake no longer seeds an unrunnable preset row, so the skipped-rows line cannot render',
  )

  const withPresetRegex = render(wired.store, slots.core)
  assert.match(withPresetRegex, /This preset’s regex/, 'the preset regex section is missing')
  assert.match(withPresetRegex, /狐神抚/, 'the section does not say which preset the rules came from')
  assert.match(withPresetRegex, /去除思维链/, 'the seeded preset rule is not listed')
  // The default, stated as a count rather than as an absence: "3 rules, not
  // enabled" is the sentence that tells a reader the preset they imported
  // carries rules at all.
  assert.match(withPresetRegex, /3 rules, not enabled/, 'the refused summary does not report the rules')
  // And the reason, naming what SillyTavern asks for too — the sentence that
  // stops the default reading as breakage.
  assert.match(withPresetRegex, /preset_allowed_regex/, 'the default-off state is not explained')
  // The rows the reader refused, said out loud. Two of the 40 rules in the
  // measured preset are separators with an empty pattern.
  assert.match(withPresetRegex, /not rules/, 'the skipped unrunnable rows are not reported')
  // Both switches, and the third state this panel has that the scoped one does
  // not: a rule that is on while the tier is off.
  assert.match(withPresetRegex, /off by the preset/, 'a preset-disabled rule is not distinguished')
  assert.match(withPresetRegex, /waiting on the switch above/, 'a rule held back by the tier says nothing')
  assert.doesNotMatch(
    withPresetRegex,
    /Delete the script 去除思维链（发送前）/,
    'a preset’s own rule is offered a delete, which would rewrite the preset file',
  )

  await wired.store.getState().setPresetRegexAllowed(true)
  const withPresetRegexOn = render(wired.store, slots.core)
  assert.match(withPresetRegexOn, /2 of 3 running/, 'an allowed preset tier does not report what runs')
  assert.doesNotMatch(
    withPresetRegexOn,
    /waiting on the switch above/,
    'a rule still says it is held back after the tier was allowed',
  )
  // Put back, so the sections below are checked against the state a fresh
  // profile has rather than one this block left behind.
  await wired.store.getState().setPresetRegexAllowed(false)

  // ------------------------------------------------------- the script library
  /*
   * The library section, both repositories.
   *
   * Loaded with the open chat's character, so the per-character repository has
   * something in it — with no character the panel renders the global half and
   * says where the other one is, which is a different assertion and belongs to
   * `script-library.test.ts` rather than here.
   */
  await wired.store.getState().loadLibrary(character)
  const libraryHeld = wired.store.getState().library ?? []
  assert.ok(
    libraryHeld.some(row => row.scope === 'global'),
    'the fake no longer seeds a global library script',
  )
  assert.ok(
    libraryHeld.some(row => row.scope === 'character'),
    'the fake no longer seeds a per-character library script',
  )

  const withLibrary = render(wired.store, slots.core)
  assert.match(withLibrary, /Your scripts/, 'the script library section is missing')
  /*
   * Matched on the row's **own** control, not on the script's name.
   *
   * A library script's name is on this page twice: once in this section and
   * once in the card-script panel, because `script.list` merges the
   * repositories and that merge is the point. So `/快捷骰子/` passed with the
   * library's global list emptied — one match describing two lists. The
   * per-row delete label is rendered only by a library row, so it is the
   * handle that discriminates.
   */
  assert.match(
    withLibrary,
    /Delete the script 快捷骰子/,
    'the seeded global library script has no row in the library section',
  )
  assert.match(
    withLibrary,
    /Delete the script 络络的天气面板/,
    'the seeded per-character library script has no row in the library section',
  )
  assert.match(withLibrary, /Every conversation/, 'the global repository has no heading')
  assert.match(withLibrary, /This character only/, 'the per-character repository has no heading')
  // Both button figures, because 58 of the corpus's 89 buttons are hidden and
  // "2 buttons" over a bar showing one is the ordinary case.
  assert.match(withLibrary, /2 buttons, 1 shown/, 'the button figures are not both reported')
  assert.match(withLibrary, /Write a script/, 'there is no way to author a script')

  /*
   * And the same rows reach the card-script panel, labelled by source.
   *
   * This is the assertion that the two features are one run path rather than
   * two: `script.list` answers with the user's scripts beside the card's, so
   * the panel that governs consent, the document grant and the run states
   * governs all of them. A separate list for the library would have been
   * easier to build and would have left the user's own scripts outside every
   * one of those.
   */
  await wired.store.getState().loadScripts(character)
  const merged = wired.store.getState().scripts
  assert.ok(
    merged.some(row => row.source === 'global'),
    'a global library script does not reach the runnable script list',
  )
  assert.ok(
    merged.some(row => row.source === 'card'),
    'the card’s own scripts fell out of the runnable script list',
  )
  // Run order, not listing order: the user's global scripts run before the
  // card's, as upstream merges its own three repositories.
  assert.equal(merged[0]?.source, 'global', 'the merged list does not open with the global repository')
  assert.equal(
    merged.at(-1)?.source,
    'character',
    'the merged list does not close with this character’s repository',
  )

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

  /*
   * ------------------------------------------- the panel's shape (web §77)
   *
   * The user's ruling, 2026-09-09: the connection card is a provider list plus
   * add / select / test, and 「连接折叠卡中就不需要有提供方/端点地址/模型这三个
   * 选项常驻了」. Three properties carry that, and all three are *absences or
   * counts* — which is why they are pinned on a real render rather than on the
   * source: a resident field creeping back is a line somebody adds, and no
   * source pattern excludes the shape they will use.
   *
   * Mounted alone rather than read out of the whole shell's markup: slicing the
   * card's body out of `<App/>`'s HTML by its id means matching a closing tag by
   * hand, and a wrong slice would make every count below describe some other
   * panel. `CollapsibleSection` renders its body whether or not the card is
   * open (hidden, never unmounted), so a server render sees all of it.
   */
  const connPanel = render(wired.store, slots.core, <ConnectionPanel />)

  // 1. No resident field. The editor is a `Modal`, which renders `null` while
  //    closed, so "no field in the panel" is structural — and this is the
  //    assertion that goes red the day somebody puts one back in the body.
  for (const tag of ['<input', '<select', '<textarea']) {
    assert.equal(
      (connPanel.match(new RegExp(tag, 'g')) ?? []).length,
      0,
      `the connection panel body carries a ${tag}> — the editor is the only place a provider is edited`,
    )
  }

  // 2. Three blocks, named. The count alone would pass on three of anything, so
  //    each one's `data-block` is checked by name and the total by count.
  assert.equal(
    (connPanel.match(/iris-conn-panel__block/g) ?? []).length,
    3,
    'the panel body should be exactly three blocks: the list, add, and test',
  )
  for (const block of ['providers', 'add', 'test']) {
    assert.match(connPanel, new RegExp(`data-block="${block}"`), `the "${block}" block is missing`)
  }

  // 3. Exactly one row is current — the provider in use. Two marked rows and
  //    none marked are both reports nobody can act on, and both are what a
  //    `find` returning the wrong thing produces.
  assert.equal(
    (connPanel.match(/aria-current="true"/g) ?? []).length,
    1,
    'exactly one provider row should be marked current',
  )
  const inUse = wired.store.getState().connections
    .find(row => row.id === wired.store.getState().activeConnectionId)
  assert.ok(inUse?.label !== undefined, 'the fixture must keep a named active profile for this check')
  // The marked row is the active one, not merely *a* row. Read off the markup
  // rather than the store: the store is what the panel was given, and this is
  // about what it did with it.
  const markedAt = connPanel.indexOf('aria-current="true"')
  const marked = connPanel.slice(markedAt, markedAt + 600)
  assert.ok(marked.includes(inUse.label), 'the marked row is not the provider in use')
  assert.match(marked, /iris-conn__badge">/, 'the current row carries no 「current」 badge')

  /*
   * 4. **The environment is not a row** (web §79).
   *
   * Nine assertions stood here about that row: read-only, testable, adoptable,
   * never editable or deletable, carrying 使用 while a profile was in use and
   * the 「current」 badge when none was. The user's ruling of 2026-09-10 retires
   * it, so what is pinned is its absence — the class it rendered under, the
   * verbs only it had, and the string that named it. An absence is exactly what
   * a render check is for: a row creeping back is markup, and no source pattern
   * excludes the shape somebody would use.
   */
  assert.doesNotMatch(connPanel, /iris-conn--host/, 'the 「宿主环境」 row is back in the provider list')
  assert.doesNotMatch(connPanel, /Host environment/, 'something still names the environment as a connection')
  assert.doesNotMatch(connPanel, /Save as a provider/, 'the adopt button is back')
  assert.doesNotMatch(connPanel, /read-only/, 'a read-only row is back in the list')
  // Every row in the list is a profile, so every row offers all four verbs.
  // Counted rather than sampled: the host row was the one exception, and a
  // count is what notices a new one.
  const connRows = (connPanel.match(/class="iris-conn"/g) ?? []).length
  assert.equal(connRows, wired.store.getState().connections.length, 'the list does not hold one row per provider')
  for (const [verb, label] of [['Edit', /aria-label="Edit /g], ['Delete', /aria-label="Delete /g]] as const) {
    assert.equal(
      (connPanel.match(label) ?? []).length,
      connRows,
      `${verb} is not offered on every row, so some row is not an ordinary provider`,
    )
  }

  /*
   * 5. **The empty state**, which is now the whole of what a fresh install
   * sees — and, since host §61, the one thing between the reader and a reply:
   * with no provider in use the host refuses to generate. So it is a sentence
   * that says what to do and the button that does it, not a note about an
   * absent list.
   *
   * Written into the store and put straight back, the same concession the
   * capsule check above makes: the fake seeds three providers, and "none saved"
   * is a state the seed cannot be in while the checks around it want the seeded
   * one.
   */
  const seededProviders = wired.store.getState().connections
  const seededActive = wired.store.getState().activeConnectionId
  assert.ok(seededProviders.length > 0 && seededActive !== undefined, 'the fixture seeds nothing to put back')
  wired.store.setState({ connections: [], activeConnectionId: undefined })
  const empty = render(wired.store, slots.core, <ConnectionPanel />)
  wired.store.setState({ connections: seededProviders, activeConnectionId: seededActive })
  assert.match(empty, /No providers yet — add one to generate\./, 'the empty state does not say what to do')
  assert.match(empty, /iris-conn-panel__empty/, 'the empty state has no block of its own')
  // The button is *inside* the empty state, not only in the add block below it:
  // the reader should not have to find a second place to start.
  const emptyAt = empty.indexOf('iris-conn-panel__empty')
  assert.match(
    empty.slice(emptyAt, emptyAt + 600),
    /<button[^>]*>Add a provider</,
    'the empty state offers no way to add a provider',
  )
  assert.equal((empty.match(/aria-current="true"/g) ?? []).length, 0, 'a row is marked current with no rows')

  // 6. The collapsed head is a reading, not a control: name · model, and no
  //    field or nested press inside the summary.
  const headAt = connPanel.indexOf('iris-card__summary')
  assert.ok(headAt > 0, 'the connection card has no summary line')
  const head = connPanel.slice(headAt, connPanel.indexOf('</span>', headAt))
  assert.ok(
    head.includes(inUse.label) && head.includes(inUse.model),
    `the collapsed head should read "name · model"; it reads ${head}`,
  )
  assert.doesNotMatch(head, /<button|<input|<select/, 'the collapsed head summary holds a control')

  /*
   * ...and with no provider in use it names no connection at all. It used to
   * read 「宿主环境 · <model>」 there, which was true while the environment was a
   * route; naming it now would point the reader at the one thing that is not an
   * answer (web §79).
   */
  const headEmptyAt = empty.indexOf('iris-card__summary')
  assert.ok(headEmptyAt > 0)
  const headEmpty = empty.slice(headEmptyAt, empty.indexOf('</span>', headEmptyAt))
  assert.match(headEmpty, /no provider selected/, 'the collapsed head does not say nothing is selected')
  assert.doesNotMatch(headEmpty, /Host environment/, 'the collapsed head still names the environment')

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
    row.usage === undefined ? [] : [{ id: row.id, usage: row.usage, generation: row.generation }])
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
      priced.includes(`>${usageChipText(floor.usage, floor.generation)}<`),
      `floor ${String(floor.id)} does not carry its own usage reading`,
    )
  }
  /*
   * The speed half of the same reading (`DEVIATIONS.md` §92).
   *
   * Both branches, from the seed rather than from a constructed row: the
   * reading the seeded turn is showing was clocked and prints
   * `· {rate} tok/s`, and a reading whose timer is not in the file prints the
   * bare total. The second is not an edge case — the host stores the timer in
   * SillyTavern's one-per-line `gen_started` pair, so every reloaded turn but
   * one reading is in that state — and a chip that appended a separator with
   * nothing after it would be visible here as a stray `·`.
   */
  const clocked = pricedFloors.find(floor => floor.generation !== undefined)
  assert.ok(clocked !== undefined, 'the seed no longer clocks any reply, so the rate branch is not taken here')
  assert.match(usageChipText(clocked.usage, clocked.generation), / · [\d.]+ tok\/s$/)
  assert.ok(priced.includes(`>${usageChipText(clocked.usage, clocked.generation)}<`))
  const unclocked = pricedFloors.find(floor => floor.generation === undefined)
  assert.ok(unclocked !== undefined, 'the seed no longer carries a priced reply with no timer')
  assert.doesNotMatch(usageChipText(unclocked.usage, undefined), /·|tok\/s/)
  // The breakdown is a hover card now (`UsagePopover`), and a server render
  // cannot hover: closed, so the rows appear in the page only through the
  // card, which is asserted by rendering the card itself — the same component
  // the popover portals — for the reply that reported reasoning, because the
  // reasoning note is a row inside another row rather than one of its own.
  // That the triggers carry no native `title` any more is pinned against the
  // sources in `tests/usage-popover.test.ts`; here the rendered page is held
  // to the old title's first words going away.
  const reasoned = pricedFloors.find(row => row.usage.reasoningTokens !== undefined)
  assert.ok(reasoned !== undefined, 'the seed should price one reply with reasoning')
  assert.ok(
    !priced.includes('Turn usage'),
    'the per-turn breakdown reached the page outside the hover card',
  )
  const turnBreakdown = renderToString(
    <UsageDetailCard heading="Turn usage" rows={usageDetailRows(reasoned.usage)} />,
  )
  assert.match(turnBreakdown, /<dl/, 'the breakdown did not render as a definition list')
  for (const row of usageDetailRows(reasoned.usage)) {
    assert.ok(turnBreakdown.includes(row.label), `the breakdown row "${row.label}" did not reach the card`)
    assert.ok(turnBreakdown.includes(row.value), `the breakdown figure "${row.value}" did not reach the card`)
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

  /*
   * The composer line on a conversation whose card scripts have generated.
   *
   * **The visible line counts them and the strip's hover card separates
   * them**, which is the dsh reading of this row: it is 「本对话累计计费」, and a
   * card's request was billed to this conversation, so a line that excluded it
   * would disagree with the bill. What that costs a reader is the ability to
   * explain a total larger than the replies they can count, and the card pays
   * it back — the share is a note under the card's rows rather than a fourth
   * group in the strip, which is the group that would get cut on a narrow
   * composer.
   *
   * The premise is asserted first: without a seeded card share this block would
   * be checking that a conversation with no card generations does not mention
   * them, which is true of every wrong implementation too.
   */
  const scripted = wired.store.getState().chats.find(row => row.chatId === 'chat-ledger')
  assert.ok(scripted !== undefined, 'the fake no longer seeds the conversation that carries a card share')
  await wired.store.getState().openChat(scripted.chatId)
  const scriptedView = wired.store.getState().view
  assert.ok(
    scriptedView?.scriptUsage !== undefined,
    'the seeded card-share conversation reports no scriptUsage, so the hover split is not rendered here',
  )
  /*
   * And the host's own compaction share, on the same conversation — the seed
   * puts both there on purpose (`seed.ts`'s `COMPACTION_SUMMARY`), because a
   * conversation carrying only one of the two cannot tell a correct split from
   * an implementation that merged both into "not a turn".
   */
  assert.ok(
    scriptedView.compactionUsage !== undefined,
    'the seeded conversation reports no compactionUsage, so the second share is not rendered here',
  )
  assert.equal(
    scriptedView.scriptUsage.turns, 2,
    'the card share is not the seeded two requests, so the counts below cannot tell the shares apart',
  )
  assert.equal(
    scriptedView.compactionUsage.turns, 1,
    'the compaction share is not the seeded one request; a merged reading would report 3',
  )
  assert.ok(scriptedView.usage !== undefined, 'a conversation with a card share must still report a total')
  const scriptedTotal = totalTokens(scriptedView.scriptUsage.usage)
  const compactedTotal = totalTokens(scriptedView.compactionUsage.usage)
  const scriptedPage = render(wired.store, slots.core)
  assert.match(scriptedPage, /class="iris-composer__stats"/, 'the usage line is missing on the card-share chat')
  // The card is portaled and closed unless a reader has opened it, so the
  // server render must not leak the notes anywhere — the native `title` that
  // used to carry this text is gone (pinned against the sources in
  // `tests/usage-popover.test.ts`), and the strip's own content is only the
  // visible groups.
  const expectedShares = usageSideShareSentences(scriptedView.scriptUsage, scriptedView.compactionUsage)
  assert.deepEqual(
    expectedShares,
    [
      `of which ${String(scriptedView.scriptUsage.turns)} card-script requests · ${formatExactTokens(scriptedTotal)} tok`,
      `of which ${String(scriptedView.compactionUsage.turns)} compaction summaries · ${formatExactTokens(compactedTotal)} tok`,
    ],
    'the side-share sentences are not the rendered share strings, in card-then-compaction order',
  )
  assert.ok(
    !scriptedPage.includes('of which'),
    'a side share reached the page outside the closed hover card',
  )
  // What *does* reach markup is proven the same way the per-turn card is, by
  // rendering the card itself — the component the popover portals — with the
  // rows and notes the composer builds from the very reading on screen.
  const summaryCard = renderToString(
    <UsageDetailCard
      heading="Session usage"
      rows={usageSummaryRows(scriptedView.usage)}
      notes={expectedShares}
    />,
  )
  assert.match(summaryCard, /iris-usage-card__note/, 'the share notes did not render under the card rows')
  // Both, separately: one paragraph per share, so a card that rendered only the
  // first — the shape the single-`note` prop had — fails here rather than
  // looking complete.
  assert.equal(
    summaryCard.split('iris-usage-card__note').length - 1,
    2,
    'the card does not draw one note paragraph per reported share',
  )
  for (const sentence of expectedShares) {
    assert.ok(
      summaryCard.includes(sentence),
      `the composer card’s notes do not carry "${sentence}"`,
    )
  }
  for (const row of usageSummaryRows(scriptedView.usage)) {
    assert.ok(summaryCard.includes(row.label), `the summary row "${row.label}" did not reach the card`)
    assert.ok(summaryCard.includes(row.value), `the summary figure "${row.value}" did not reach the card`)
  }

  /*
   * And the visible line reports the **whole** figure, card requests included.
   * This is the assertion that discriminates the plausible wrong implementation:
   * a total that subtracted the card's share to keep "what I generated" clean
   * renders a smaller number and looks entirely reasonable.
   *
   * **The expectation is built from the other two fields, not from `usage`.**
   * The first version of this block asserted `page.includes(billedInput(
   * view.usage))` — which is the page's own number compared against itself, so
   * it passed unchanged when the fake was made to leave the share out. Teeth
   * check found that. The independent reading is the per-message figures plus
   * the reported share, which must add to the conversation's total.
   */
  const messageInput = scriptedView.messages.flatMap(row =>
    row.usage === undefined ? [] : [billedInputTokens(row.usage)])
  assert.equal(
    messageInput.length,
    1,
    `this conversation carries ${String(messageInput.length)} per-message readings; the sum below is only`
    + ' the whole conversation when every billed candidate is a selected one, which holds at exactly one',
  )
  const expectedInput = (messageInput[0] ?? 0)
    + billedInputTokens(scriptedView.scriptUsage.usage)
    + billedInputTokens(scriptedView.compactionUsage.usage)
  assert.ok(expectedInput > (messageInput[0] ?? 0), 'the side shares are zero, so the sum proves nothing')
  assert.equal(
    billedInputTokens(scriptedView.usage),
    expectedInput,
    'the conversation total is not its turns plus its card generations plus its compaction summaries',
  )
  assert.ok(
    scriptedPage.includes(`Input ${formatTokens(expectedInput)} tok`),
    'the visible usage line does not report the total with the card share inside it',
  )
  // Put the store back where the block above left it. Everything downstream
  // reads "the open conversation", so a check that opens a third one and walks
  // away moves the subject of every assertion after it — which is how this
  // block first failed a divergence check twelve sections later.
  await wired.store.getState().openChat(other.chatId)

  /*
   * A card's popup, drawn by the shell.
   *
   * Server-rendered, so this proves what the tree puts on the page and nothing
   * about pressing a button. What it does prove is the one thing a reader
   * cannot check by looking: **upstream's button order**. ST prepends custom
   * buttons before the ok button (`popup.js:312-315`), so MagVarUpdate's
   * cleanup dialog reads "back up and clean" / "clean only" / "do not remind me
   * again" — and an implementation that appended instead would look perfectly
   * reasonable while putting the destructive option last.
   *
   * The plan comes from `planPopup`, not from a literal: a hand-written plan
   * would be this check agreeing with itself about the order.
   */
  pushCardPopup({
    key: 'render-check:p1',
    source: 'render-check',
    plan: planPopup('检测到可以清理本聊天文件中的旧变量，是否清理？', 2, '', {
      okButton: '仅清理',
      cancelButton: '不再提醒',
      customButtons: ['备份并清理'],
    }),
    answer: () => undefined,
  })
  const asked = render(wired.store, slots.core)
  assert.match(asked, /class="iris-popup"/, 'a card popup on the queue did not render')
  assert.match(asked, /A card is asking/, 'the dialog does not say a card is asking')
  const captions = ['备份并清理', '仅清理', '不再提醒'].map(caption => asked.indexOf(caption))
  for (const [at, index] of captions.entries()) {
    assert.ok(index >= 0, `button ${String(at)} is missing from the dialog`)
  }
  assert.deepEqual(
    [...captions].sort((a, b) => a - b),
    captions,
    'the buttons are not in upstream’s order: its custom button is prepended before ok',
  )
  /*
   * The content is the card's own markup, and it reaches the page through the
   * sanitizer. In a server render DOMPurify cannot run at all, so that module
   * escapes rather than passing the string through — asserted here because
   * "sanitized" must never quietly come to mean "unchanged".
   */
  assert.match(asked, /检测到可以清理本聊天文件中的旧变量/, 'the card’s words never reached the panel')
  resetCardPopups()
  assert.doesNotMatch(
    render(wired.store, slots.core),
    /class="iris-popup"/,
    'the dialog outlived its queue entry',
  )

  // ------------------------------------------------------- usage page
  /*
   * The profile-wide usage page: the chart, its legend, and the caveat that
   * says how much of the reading is a reconstruction.
   *
   * Rendered from `UsageReport` rather than from `UsagePanel`, and not for
   * convenience: the panel's shell is the borrowed `Modal`, which is a
   * `createPortal`, and `react-dom/server` refuses to render one. The report is
   * the half that draws, so it is the half that has to be checked here.
   *
   * The summary comes through the **real store action and the fake's own
   * aggregation** — not a hand-written fixture — so what is checked is the path
   * a browser takes. `since` is left off so the seeded records nine days back
   * are in range.
   */
  const usageResult = await wired.store.getState().usageSummary({ granularity: 'day' })
  assert.ok(usageResult.ok, 'the fake no longer answers usage.summary')
  const usage = usageResult.summary

  /*
   * The fixture's premises, asserted before anything is concluded from it. Each
   * of these is a branch of the page, and a seed that stopped exercising one
   * would leave the check quietly reporting on a simpler page than the one that
   * ships.
   */
  assert.ok(usage.models.length >= 2, `the seed reports ${String(usage.models.length)} models; the chart needs more than one line`)
  assert.ok(
    usage.buckets.some(one => one.model === undefined),
    'the seed no longer carries a cost that names no model, so the unknown line is not drawn here',
  )
  assert.ok(
    new Set(usage.buckets.map(one => one.bucket)).size >= 2,
    'every seeded cost is in one time bucket, so the time axis is not exercised',
  )
  assert.ok(usage.totals.cacheTurns > 0 && usage.totals.cacheTurns < usage.totals.turns,
    'the seed should mix a cache-reporting route with a silent one, or the hit-rate population is untested')
  const usageShare = hitRate(usage.totals)
  assert.ok(usageShare !== null, 'the seeded range should report a cache share')
  assert.ok(
    Number(usageShare) > 0 && Number(usageShare) < 100,
    `the seeded cache share is ${usageShare}%, which no longer exercises the computation`,
  )

  /*
   * `range` and `onRange` are the report's now, and that is why they are handed
   * over here: the page's control row carries the range switch and the metric
   * switch side by side, so the row lives in the half that draws — which also
   * means this check reaches the range control for the first time. It used to
   * sit in `UsagePanel`, inside the portal `react-dom/server` refuses, so
   * nothing rendered it anywhere.
   */
  const usagePage = render(
    wired.store,
    slots.core,
    <UsageReport
      summary={usage}
      range="all"
      onRange={() => { /* not clicked here */ }}
      onOpenChat={() => { /* not clicked here */ }}
    />,
  )

  /*
   * The control row: both switches, and the one option each that is pressed.
   * `aria-pressed` is the whole state of a segmented control here — there is no
   * selected *class* to look for — so a row that rendered every option unpressed
   * would look identical in a screenshot and be a control with no reading.
   */
  assert.match(usagePage, /class="iris-usage__toolbar"/, 'the control row did not render')
  const switches = usagePage.match(/class="iris-choice"/g)?.length ?? 0
  assert.equal(switches, 2, `the row holds ${String(switches)} segmented controls, not the range and the metric`)
  // Read as "this button is pressed", not as a count of pressed buttons: the
  // legend's entries are `aria-pressed` too, so a total would be pinned to how
  // many models the seed happens to carry.
  assert.match(
    usagePage,
    /<button[^>]*aria-pressed="true"[^>]*>All<\/button>/,
    'the range switch does not show the range it was handed as the one in force',
  )
  assert.match(
    usagePage,
    /<button[^>]*aria-pressed="true"[^>]*>Total<\/button>/,
    'the metric switch does not show its own default as the one in force',
  )

  // The chart itself. A `<path>` per showing line, and the axis it is scaled
  // against — the elements, not a screenshot, because this renderer has no
  // layout and the geometry is unit-tested in `tests/usage-stats.test.ts`.
  assert.match(usagePage, /class="iris-usage__svg"/, 'the chart did not render')
  const drawn = usagePage.match(/<path /g)?.length ?? 0
  assert.ok(
    drawn >= usage.models.length + 1,
    `the chart drew ${String(drawn)} lines for ${String(usage.models.length)} models plus the unattributed one`,
  )
  // Every stroke is a token. A literal colour here would silently opt out of
  // the three-theme contrast floor `tests/contrast.test.ts` computes.
  assert.doesNotMatch(usagePage, /stroke="#/, 'a chart line was drawn with a literal colour')
  assert.match(usagePage, /stroke="var\(--iris-/, 'the chart lines are not token-coloured')

  // The legend, one entry per line, each one a control that can hide it.
  assert.match(usagePage, /class="iris-usage__legend"/, 'the legend did not render')
  for (const model of usage.models) {
    assert.ok(usagePage.includes(model), `the legend does not name ${model}`)
  }
  // English, because `getLanguage()` under node is `en` and nothing here
  // switches it; `tests/i18n.test.ts` holds both columns.
  assert.ok(
    usagePage.includes('Unknown model'),
    'the records that name no model are not labelled on the page',
  )
  const swatches = usagePage.match(/class="iris-usage__swatch"/g)?.length ?? 0
  assert.equal(swatches, usage.models.length + 1, 'a line has no legend swatch, or a swatch has no line')

  // The headline cards, and the figures they are supposed to carry. Computed
  // here from the same summary rather than pasted, so the check follows the
  // seed instead of pinning a number that a seed change would make a lie.
  assert.match(usagePage, /class="iris-usage__cards"/, 'the headline cards did not render')
  assert.ok(
    usagePage.includes(formatExactTokens(usageTotal(usage.totals))),
    'the total-tokens card does not carry the total',
  )
  assert.ok(usagePage.includes(`${usageShare}%`), 'the hit-rate card does not carry the share')

  /*
   * The card-script share, on the total card.
   *
   * **The premise is asserted, not used as a guard**, for the reason the
   * undated note below records: an `if (usage.totals.script !== undefined)`
   * around this block would go quiet the moment the seed stopped carrying one,
   * and a check that skips itself is indistinguishable from a check that
   * passes.
   *
   * Three figures are pinned because three separate wrong readings each look
   * right on a page: the **count** must be the card's generations and not the
   * range's, the **tokens** must be the card's share and not the whole total,
   * and the share must come out strictly smaller than the total printed above
   * it — a page handed `totals` where it meant `totals.script` prints the same
   * figure twice, which reads as confirmation.
   */
  const scriptShare = usage.totals.script
  assert.ok(
    scriptShare !== undefined,
    'the seed no longer carries a card-script generation, so the share line is not rendered here',
  )
  assert.ok(
    scriptShare.turns > 0 && scriptShare.turns < usage.totals.turns,
    `the seed's card share is ${String(scriptShare.turns)} of ${String(usage.totals.turns)} generations,`
    + ' which no longer distinguishes the card figure from the whole range',
  )
  const scriptSpend = usageTotal(scriptShare)
  assert.ok(
    scriptSpend > 0 && scriptSpend < usageTotal(usage.totals),
    `the card share is ${String(scriptSpend)} of ${String(usageTotal(usage.totals))} tokens,`
    + ' so a page printing the whole total in its place would pass this check',
  )
  assert.match(
    usagePage,
    /class="iris-usage__hero-note"/,
    'the total card does not report the card-script share',
  )
  assert.ok(
    usagePage.includes(
      `of which ${String(scriptShare.turns)} card-script requests · ${formatExactTokens(scriptSpend)} tok`,
    ),
    'the card-script line does not carry both the count and the tokens',
  )
  /*
   * And the chart's fifth metric, which is the same figure over time. Pinned
   * here rather than only in `tests/usage-stats.test.ts` because the switch is
   * what makes it reachable: a metric present in the type and missing from the
   * control is a line nobody can draw.
   */
  assert.ok(usagePage.includes('>Card scripts<'), 'the metric switch does not offer the card-script line')

  /*
   * The **compaction** share, the second sentence in the same note.
   *
   * Premise asserted the same way, and one more assertion the card share does
   * not need: the two shares must be *different numbers*. The plausible wrong
   * implementation folds both side populations into one bucket and prints it
   * twice, which on a page reads as two facts agreeing.
   */
  const compactionShare = usage.totals.compaction
  assert.ok(
    compactionShare !== undefined,
    'the seed no longer carries a compaction summary, so its share line is not rendered here',
  )
  assert.ok(
    compactionShare.turns > 0 && compactionShare.turns < usage.totals.turns,
    `the seed's compaction share is ${String(compactionShare.turns)} of ${String(usage.totals.turns)}`
    + ' generations, which no longer distinguishes it from the whole range',
  )
  assert.notEqual(
    compactionShare.turns,
    scriptShare.turns,
    'the two side shares report the same count, so a merged "not a turn" figure would pass this check',
  )
  const compactionSpend = usageTotal(compactionShare)
  assert.notEqual(
    compactionSpend,
    scriptSpend,
    'the two side shares report the same tokens, so a merged figure printed twice would pass this check',
  )
  assert.ok(
    compactionSpend > 0 && scriptSpend + compactionSpend < usageTotal(usage.totals),
    `the side shares are ${String(scriptSpend + compactionSpend)} of ${String(usageTotal(usage.totals))}`
    + ' tokens; they have to be a strict part of the total or the page cannot be shown to subset it',
  )
  assert.ok(
    usagePage.includes(
      `of which ${String(compactionShare.turns)} compaction summaries · ${formatExactTokens(compactionSpend)} tok`,
    ),
    'the compaction line does not carry both the count and the tokens',
  )
  /*
   * And **no sixth metric**, which is a decision rather than an omission
   * (`usage-stats.ts`'s `compactionTokens`, `notes/apps/iris-web/DEVIATIONS.md`
   * §74): one request per compaction draws a line that is flat at zero with an
   * occasional spike, and the figure a reader wants is the sentence above. The
   * count is pinned rather than the absence of a caption, because a switch that
   * grew a sixth option for any reason should come back through that decision.
   */
  const metricOptions = usagePage.match(/class="iris-choice__option"/g)?.length ?? 0
  assert.equal(
    metricOptions,
    USAGE_RANGES.length + USAGE_METRICS.length,
    'the two segmented controls do not offer exactly their own options; a metric was added or dropped',
  )
  assert.equal(USAGE_METRICS.length, 5, 'the metric switch gained a sixth reading without a ledger entry')

  /*
   * The per-conversation card column, in **both** of its states.
   *
   * One seeded conversation has a card share and the others do not, and the
   * blank cell is a branch rather than a degenerate case: a column of `0`s
   * reads as the feature failing to load, so the cell is empty — and the count
   * below is what stops a well-meaning `?? 0` from turning up there.
   */
  const withScript = usage.chats.filter(row => row.script !== undefined)
  assert.equal(
    withScript.length,
    1,
    `${String(withScript.length)} seeded conversations carry a card share; the check wants exactly one, so`
    + ' the figure and the blank cell are both on the page',
  )
  const scriptRow = withScript[0]?.script
  assert.ok(scriptRow !== undefined, 'the card-share row lost its share between two reads of one summary')
  assert.ok(
    usagePage.includes(`${String(scriptRow.turns)} card · ${formatTokens(usageTotal(scriptRow))} tok`),
    'the subtotal row does not carry its card-script column',
  )
  // The compaction figure shares that cell, stacked under the card one.
  const compactionRow = withScript[0]?.compaction
  assert.ok(
    compactionRow !== undefined,
    'the seeded side-share conversation carries no compaction share, so the stacked cell is not exercised',
  )
  assert.ok(
    usagePage.includes(
      `${String(compactionRow.turns)} compaction · ${formatTokens(usageTotal(compactionRow))} tok`,
    ),
    'the subtotal row does not carry its compaction column',
  )
  const blankCells = usagePage.match(/class="iris-usage__chat-script iris-meta"><\/span>/g)?.length ?? 0
  assert.equal(
    blankCells,
    usage.chats.length - 1,
    'a conversation with no side generations should render an empty cell rather than a zero',
  )

  /*
   * The caveat. Every usage record in the real corpus is undated, so this note
   * is not an edge case — it is what anyone's existing history renders as, and
   * a page that omitted it would present a reconstructed time axis as a
   * measured one.
   *
   * **The premise is asserted, not used as a guard.** This block first read
   * `if (usage.totals.undatedTurns > 0)`, and the seed had no undated record —
   * so the assertion never ran and stayed green while the note was deleted. A
   * teeth check found it. The seed now carries one, and if it stops the failure
   * says the check went blind rather than that the page broke.
   */
  assert.ok(
    usage.totals.undatedTurns > 0,
    'the seed no longer carries an undated cost, so the reconstruction note is not rendered here',
  )
  assert.match(usagePage, /class="iris-usage__note"/, 'undated generations were counted without saying so')
  assert.ok(
    usagePage.includes(String(usage.totals.undatedTurns)),
    'the note does not say how many generations had their moment reconstructed',
  )

  // Per-conversation subtotals, one clickable row each.
  assert.match(usagePage, /class="iris-usage__chats"/, 'the per-conversation subtotals did not render')
  const chatRows = usagePage.match(/class="iris-usage__chat"/g)?.length ?? 0
  assert.equal(chatRows, usage.chats.length, 'a conversation subtotal is missing a row')

  /*
   * The empty state, which is a different page rather than a chart of zeros.
   * Driven by asking for a range nothing falls in — the same request the "today"
   * control sends on a day with no generations.
   */
  const quiet = await wired.store.getState().usageSummary({ granularity: 'hour', since: Date.now() + 60_000 })
  assert.ok(quiet.ok, 'usage.summary refused a forward range')
  assert.equal(quiet.summary.totals.turns, 0, 'the forward range should contain nothing')
  const quietPage = render(
    wired.store,
    slots.core,
    <UsageReport
      summary={quiet.summary}
      range="today"
      onRange={() => { /* not clicked here */ }}
      onOpenChat={() => { /* not clicked here */ }}
    />,
  )
  assert.doesNotMatch(quietPage, /class="iris-usage__svg"/, 'an empty range still drew a chart')
  assert.ok(quietPage.includes('Nothing has been billed'), 'the empty range does not say so')
  /*
   * The way out is still on the page. An empty reading is the one state where
   * the range switch is the only control that can do anything, and it used to be
   * the panel's — outside this render — so nothing established that a reader
   * looking at "nothing has been billed" is not looking at a dead end.
   */
  assert.match(quietPage, /class="iris-usage__toolbar"/, 'the empty reading has no range switch to leave by')
  assert.match(
    quietPage,
    /<button[^>]*aria-pressed="true"[^>]*>Today<\/button>/,
    'the empty reading does not say which range it is empty for',
  )
  // And nothing else: a metric switch over a chart that was not drawn is a
  // control with nothing to control.
  const quietSwitches = quietPage.match(/class="iris-choice"/g)?.length ?? 0
  assert.equal(quietSwitches, 1, 'the empty reading offers a switch for a chart it did not draw')
  // The denominator is still reported: "nothing" has to read as a reading of
  // the corpus rather than as a failure to look at it.
  assert.ok(
    quietPage.includes(String(quiet.summary.scannedChats)),
    'the empty state does not say how many conversations were scanned',
  )

  // ------------------------------------------------------- context capacity
  /*
   * The capacity capsule, and the marker a compaction leaves.
   *
   * A server render cannot press anything, so the card's own contents are
   * pinned in `tests/context-meter.test.ts` and what is checked here is the
   * wiring on either side of it: the ring is on the page, it is a button that
   * opens a dialog, and it *names itself* with the reading — which is what the
   * mark carries before it has been pressed, because the figures no longer have
   * a line of their own (web §80). Same division as the model menu two sections
   * up.
   */
  const capacity = wired.store.getState().view
  assert.ok(capacity?.budget !== undefined, 'the fake no longer reports a budget on the open chat')
  const available = capacity.budget.context - capacity.budget.reserve
  assert.ok(available > 0, `the seeded budget leaves ${String(available)} for the prompt`)
  const metered = render(wired.store, slots.core)
  assert.match(metered, /data-control="context-meter"/, 'the capacity ring is missing')
  assert.match(
    metered,
    /aria-haspopup="dialog"[^>]*data-control="context-meter"/,
    'the ring does not announce the card it opens',
  )
  // Computed from the seeded budget, not spelled out, so a change to the fake
  // moves the expectation instead of turning this into a wrong-answer check.
  /*
   * The ring names the reading, and draws it.
   *
   * It used to state the capacity alone until pressed, because the only account
   * of the prompt cost a round trip. The host now projects the itemization it
   * already recorded for the newest real turn, so an unpressed mark has a
   * measured occupancy — which is what the arc is drawn from.
   *
   * Both halves of this task are pinned here rather than only in the unit
   * suite, because both depend on wiring a server render can see: the arc needs
   * `ChatView.measured` to have survived the store, and the provenance needs
   * `ChatView.budget.source` to have.
   *
   * **The reading is now the `aria-label`**, and that is the one thing the
   * redesign changed about this check: the mark carries no words, so the
   * sentence the capsule used to print is the button's name. A ring with a
   * generic name would pass every other assertion here and leave a screen
   * reader with 「button」.
   */
  const measured = capacity.measured
  assert.ok(measured !== undefined, 'the fake no longer reports a measured turn on the open chat')
  assert.ok(
    metered.includes(`aria-label="Context ${formatTokens(measured.tokens)}/${formatTokens(available)}`),
    `the ring is not named by the measured reading (${formatTokens(measured.tokens)}/${formatTokens(available)})`,
  )
  assert.match(metered, /data-control="context-gauge"/, 'the ring draws no arc')
  // Computed from the fake rather than spelled out, the same rule the figures
  // above follow — a change to the seed moves the expectation instead of
  // turning this into a wrong-answer check.
  const gaugePercent = Math.min(100, Math.round(measured.tokens / available * 100))
  assert.ok(
    gaugePercent > 0 && gaugePercent < 100,
    `the seeded reading is ${String(gaugePercent)}%, which draws no distinguishable arc`,
  )
  assert.match(
    metered,
    new RegExp(`iris-composer__ring-arc--${pressureLevel(gaugePercent)}`),
    `the arc is not in the ${pressureLevel(gaugePercent)} band at ${String(gaugePercent)}%`,
  )
  /*
   * And it is drawn at that percentage.
   *
   * The dash is `ringDash`'s, called here rather than restated, which keeps
   * this an assertion about the *wiring* — the reading reached the mark — rather
   * than a second copy of the arithmetic `tests/composer-bar.test.ts` already
   * holds against the ring's own length.
   */
  assert.ok(
    metered.includes(`stroke-dasharray:${ringDash(gaugePercent)}`),
    `the arc is not drawn at ${String(gaugePercent)}% (${ringDash(gaugePercent)})`,
  )
  // And the hover says which window it divides by, and who chose it. The fake's
  // route is a model nothing knows a window for, so the settings' own value is
  // what is in force — the one of the four wordings this fixture can be true of.
  assert.ok(
    metered.includes(`Window ${formatTokens(capacity.budget.context)}, from the settings or a preset`),
    'the ring’s hover does not name the window it divides by',
  )
  /*
   * The card's own copy of that line, rendered directly.
   *
   * A server render cannot press the capsule, which is why the card's contents
   * are otherwise pinned in `tests/context-meter.test.ts` — but that suite has
   * no renderer, so between the two of them the window line on the *card* was
   * covered by nothing. Rendered here the way `UsageReport` above is: one
   * component, real props, off the fake's own budget.
   */
  const opened = renderToString(
    <ContextCard
      budget={capacity.budget}
      itemization={fakeItemization(measured.turn, false)}
      state="ready"
      usage={capacity.usage}
      // No comparison and nowhere to go: this render is about the window line,
      // and the divergence line is pinned on its own further down. Passing a
      // fixture here would put a second thing in the assertion's way.
      divergence={undefined}
      onOpenPanel={() => {}}
      anchor={{ current: null }}
      onClose={() => {}}
    />,
  )
  assert.match(opened, /data-control="context-window-source"/, 'the card does not say where its window came from')
  assert.ok(
    opened.includes(`Window ${formatTokens(capacity.budget.context)}, from the settings or a preset`),
    'the card names no window source',
  )
  // Before any compaction there is no marker at all — the control for the
  // assertion below, which would otherwise pass for a marker that is always on.
  assert.doesNotMatch(metered, /data-control="compaction-note"/)

  /*
   * The divergence line the card's bottom row prints.
   *
   * Asserted on the store's answer rather than on the rendered card, for the
   * reason the section header gives: the card exists only once the capsule is
   * pressed, and a server render cannot press it. What is pinned here is that
   * the fetch is wired, that the fixture carries the shape the line is designed
   * for, and that the two figures the line puts side by side actually disagree —
   * a fixture where the ceiling and the provider's share happened to match would
   * render the same words for the opposite finding.
   */
  const diverged = await wired.store.getState().divergence()
  assert.ok(diverged.ok, 'the fake should model a comparison, not refuse one')
  const comparison = diverged.divergence
  assert.ok(comparison !== undefined, 'the seeded conversation has two replies, so there is a pair')
  assert.equal(
    comparison.addedBytes + comparison.changedBytes + comparison.repeatedBytes + comparison.structureBytes,
    comparison.uncacheableBytes,
    'the four terms must add up, or the panel prints an account that does not',
  )
  const ceiling = cacheCeiling(comparison)
  assert.ok(ceiling > 0.5 && ceiling < 1, `the fixture's ceiling should be high and not perfect (${String(ceiling)})`)
  assert.equal(
    providerFellShort(comparison),
    true,
    'the fixture must keep the measured shape: a high ceiling and a provider that served far less',
  )
  assert.equal(providerExcuse(comparison), null, 'and no ordinary reason for it, or the finding is suppressed')
  // The part that did not change and was re-sent in full: the largest single
  // recoverable cost in the real corpus, and the row the panel is designed
  // around. A fixture without one leaves that design untested.
  assert.ok(
    comparison.items.some(item => item.state === 'same' && item.uncachedBytes === item.bytes && item.bytes > 0),
    'the fixture should carry an unchanged part that is re-billed in full',
  )
  assert.ok(
    comparison.items.some(item => item.state === 'gone'),
    'and one that fell out of the request, since that is what a budget change looks like',
  )

  const compacted = await wired.store.getState().compactChat()
  assert.ok(compacted.ok, 'the fake refused to compact')
  assert.ok(compacted.compacted !== null, 'the seeded conversation had nothing to compact')
  const folded = wired.store.getState().view?.compaction
  assert.ok(folded !== undefined, 'the compaction record did not reach the store')
  const withNote = render(wired.store, slots.core)
  assert.match(withNote, /data-control="compaction-note"/, 'the compacted-history marker is missing')
  assert.ok(
    withNote.includes(`${String(folded.count)} earlier floor(s) are sent as a summary`),
    'the marker does not say how many floors it stands for',
  )
  // The property the whole feature rests on, checked where a reader would see
  // it: nothing was removed from the conversation.
  assert.equal(
    wired.store.getState().view?.messages.length,
    capacity.messages.length,
    'a compaction deleted a message from the conversation',
  )

  wired.dispose()
  slots.dispose()
  console.log('render check: ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
