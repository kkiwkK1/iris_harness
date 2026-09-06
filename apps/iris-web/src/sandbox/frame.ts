/**
 * The code that runs inside a card's frame.
 *
 * Its whole job is to build the globals a card reaches for and then evaluate the
 * card's body against them. Every dependency arrives through `FrameEnv` rather
 * than being read off the real `window`, for one reason: this is the piece that
 * decides what a card can touch, and a piece that can only be exercised by
 * opening a browser is a piece whose decisions are never checked. With the
 * injection it runs under `node --test` against stubs.
 *
 * Shadowing is the compatibility layer, not the boundary — see `policy.ts`. A
 * card that evades these parameters reaches the real, cross-origin `parent` and
 * is stopped by the browser.
 *
 * @module iris-web/sandbox/frame
 */

import { UnsupportedApiError } from './errors.ts'
import { topFrame } from './failure-attribution.ts'
import { UNBRIDGED_GLOBALS } from './policy.ts'
import type { FromFrame, ToFrame } from './protocol.ts'
import { sameOriginTarget } from './same-origin.ts'
import { createVirtualDocument, type NodeFactory, type ScopedRoot } from './virtual-document.ts'
import { EXPECTED_GLOBALS } from './preset-globals.ts'
import { isOnSillyTavernSurface } from './card-api.ts'
import type { MemberTable } from './members-contract.ts'
import { MEMBER_KINDS, SHARED_ORIGINAL, identityMembers } from './identity.ts'
import { scopedEvents } from './scoped-events.ts'
import { SCRIPT_REGISTRY, WINDOW_GLOBAL, withPreamble } from './preamble.ts'
import { EventBus, MVU_EVENTS, TAVERN_EVENTS } from '@iris/compat-tavernhelper-core'
import type { Listener } from '@iris/compat-tavernhelper-core'
import type { ScriptContext } from '@iris/protocol'

/** What the frame-side code needs from its realm. */
export interface FrameEnv {
  /** The run token every message carries. */
  token: string
  /** The frame's own body — which is the card's container, and what `parent.document.body` yields. */
  container: ScopedRoot
  /**
   * The frame's own `<head>` — what `parent.document.head` answers.
   *
   * A real element, like `body` is a real element: this is the card's own
   * document, and appending a `<style>` or a `<link>` to its head is the same
   * class of write appending markup to the container is. Optional because every
   * realm here is injected; a frame without one simply refuses the member by
   * name, as it does for every other member it does not carry.
   */
  head?: unknown
  /** The frame's own document, for node construction. */
  factory: NodeFactory
  /** The real window of this frame, proxied through for everything not overridden. */
  realWindow: object
  /** Send a message to the shell. */
  post: (message: FromFrame) => void
  /** Receive messages from the shell; already token-checked by the caller. */
  onMessage: (listener: (message: ToFrame) => void) => void
  /**
   * Evaluate a card body with the given globals shadowed.
   *
   * Injected rather than calling `new Function` here so a test can observe the
   * exact names and values a card would see, which is the thing worth asserting.
   */
  evaluate: (
    source: string,
    mode: 'classic' | 'module',
    names: readonly string[],
    values: readonly unknown[],
    /**
     * Whose body this is, so a module that finishes after the frame gave up on
     * it can correct the record under the right name.
     */
    scriptId?: string,
  ) => void | Promise<void>
  /**
   * Put the bridged globals on the frame's own window.
   *
   * Module code cannot be handed shadowed parameters, so in module mode this is
   * the only bridge there is — which is also how upstream does it: a classic
   * script runs before the module and flattens its API onto the child window.
   *
   * Called in both modes. Publishing is harmless for classic code, which finds
   * the same objects through its parameters, and having one path fewer is worth
   * more than saving two property definitions.
   */
  publishGlobals?: (entries: readonly [string, unknown][]) => void
  /**
   * Whether this frame carries a card's markup instead of running its scripts.
   *
   * Injected rather than sniffed, like everything else here: the attribute lives
   * on the document and this module deliberately knows nothing about the
   * document it is installed into.
   *
   * It exists because the two frame kinds reach their card code by different
   * routes and only one of them was served. A script frame receives a `run`
   * message, and everything a card can touch — the bare Tavern Helper globals,
   * the `toastr` substitute, the missing-libraries report — was published on
   * that message. An interface frame never receives one: its markup, `<script>`
   * elements included, executes while the document parses. So it reached its
   * card code with an **empty** surface, and a real card produced
   * `ReferenceError: errorCatched is not defined` from markup that upstream
   * serves without trouble.
   *
   * Upstream has no such split. `predefine.js` is injected into both frame kinds
   * with the same member set [3c, §三之二], and the corpus reads that way: 44
   * measured `triggerSlash` in 7 interface-side cards and **zero** script-side,
   * `errorCatched` in 5 interface-side, `waitGlobalInitialized` in 6 of each.
   * The interface side is not a reduced surface upstream — in places it is the
   * only side a member is used from.
   */
  interfaceFrame?: boolean
  /**
   * Install the card storage as this frame's `localStorage`.
   *
   * Handed over rather than installed here for the usual reason — this module
   * touches no document — and it has to be *installed*, not merely offered: the
   * failure it addresses is the **property access**, so the value must be an own
   * property of `window` before any card code reads it.
   * @param storage - the object to shadow `localStorage` with.
   */
  provideStorage?: (storage: unknown) => void
  /**
   * The card-facing member table.
   *
   * **Injected rather than imported, and that is the split.** Everything this
   * module reaches through here — the Tavern Helper surface, the storage façade,
   * the anchors, the overlay geometry — used to be `import`ed, which put it in
   * the bootstrap and therefore inside every frame's `srcdoc`, paid per frame
   * with no cache. At twelve live frames that was the larger part of a 2 MiB
   * budget and had forced the count gate down twice in one day.
   *
   * What stays in this module is **policy**: the proxies that refuse, the
   * unbridged list, the evaluator, and the order things are installed in. The
   * distinction is not size, it is substitutability — nothing that decides what
   * a card *may* reach should be answerable by a path.
   */
  members: MemberTable
  /**
   * Put a node the sandbox built into the card's container.
   *
   * Exists for exactly one node: the element that stands for **this frame** in
   * the parent document's frame list. Injected rather than done through the
   * container type because `ScopedRoot` is deliberately query-only — the
   * container is a card's to write to, and this is the one thing the sandbox
   * puts there itself.
   *
   * Optional so a host without a DOM still installs; the element is then simply
   * absent, and a card looking for frames finds none rather than finding a
   * broken one.
   */
  appendToContainer?: (node: unknown) => void
  /**
   * The realm's own page state, read on each access.
   *
   * Injected because this module touches no document, and read live rather than
   * captured for the same reason `viewport` is: a card polling
   * `document.hidden` on an interval is asking a question whose answer changes,
   * and a captured value answers the first one forever.
   */
  pageState?: () => { visibilityState: string, hidden: boolean, url: string }
  /**
   * Define a name on the frame's own window that reads through to a live source.
   *
   * Separate from `publishGlobals` because the difference is a getter. Publishing
   * copies a value; this forwards, so a provider retracting its interface is seen
   * by every consumer instead of leaving them holding a withdrawn object. It is
   * what upstream does for a global a script waited on.
   */
  defineForwarding?: (name: string, read: () => unknown) => void
  /**
   * Define a name the way upstream's `predefine.js` does, not the way a wait does.
   *
   * A second door rather than an option on `defineForwarding`, because the two
   * upstream sites genuinely differ and an option would hide that difference
   * inside a parameter. `predefine.js:36-44` writes an accessor with an **empty
   * setter**, so a card assigning the name is silently ignored;
   * `waitGlobalInitialized` writes a getter only, so the same assignment throws
   * in a module's strict mode. Each door matches its own upstream.
   */
  definePredefined?: (name: string, read: () => unknown) => void
  /**
   * Record a running script in the frame's own script list.
   *
   * Upstream keeps one `div[data-script-id]` per running script inside
   * `#tavern_helper` on the host page, and cards read that list to decide which
   * instance of themselves should be the active one. With a card's scripts
   * sharing one frame, the frame *is* that page for them.
   */
  listScript?: (scriptId: string | undefined) => void
  /**
   * Say which of a list of globals are not present in this frame.
   *
   * Enumerating beats discovering. Upstream seeds six library globals from its
   * host page; a cross-origin frame cannot borrow any of them, so each one Iris
   * does not provide is a card crash waiting to happen — and the crash says
   * `X is not defined`, which names the symptom and not the list it came from.
   */
  /**
   * The snapshot inlined into this frame's document, if there was one.
   *
   * A function rather than a value because the frame runtime is built before the
   * document is read, and because reading a global belongs to the entry that has
   * one — this module deliberately knows nothing about the realm it installs
   * into.
   * @returns the seeded snapshot, or undefined when the shell inlined none.
   */
  seededContext?: () => ScriptContext | undefined
    reportMissingGlobals?: (expected: readonly string[]) => void
  /**
   * Seed `toastr`, which is an adapter rather than a library.
   *
   * The other seeded globals are real libraries and live in the preset bundle,
   * which is static and shared by every frame. This one cannot: what it does
   * with a call is *report it*, so it needs the frame's own channel, and a
   * frame is the smallest thing that has one.
   * @param report - the gap channel this frame's toasts are forwarded to.
   */
  provideToastr?: (report: (message: string, channel: 'note' | 'error') => void) => void
  /**
   * Publish the viewport into the frame's own realm.
   *
   * Card CSS reads `--TH-viewport-height`, which upstream sets on the child's
   * `<html>` from `window.parent.innerHeight` — a same-origin read Iris cannot
   * make. Carrying the number in the message and setting the variable here is
   * the equivalent, and cleaner: the value is pushed rather than reached for.
   *
   * Optional so a test can install without a DOM.
   */
  applyViewport?: (size: { width: number, height: number }) => void
  /**
   * The URL relative paths in this frame resolve against: `document.baseURI`.
   *
   * For a srcdoc frame that is the shell page's URL — the same base the browser
   * resolves a card's `fetch('/x')` against, which is why the fetch bridge
   * resolves with it rather than with an origin alone: a root-relative path and
   * a page-relative one both land where the card meant them to. Its origin is
   * what counts as "ours".
   *
   * Optional so a test can install without one; the bridge then treats every
   * request as not-ours and passes it through untouched, which is the safe
   * direction for a bridge that is missing its premise.
   */
  baseUrl?: string
}

/** A running frame's handle. */
export interface FrameSandbox {
  /** Names shadowed for card code, in order. */
  readonly shadowed: readonly string[]
  /** Last viewport the shell reported. */
  viewport: () => { width: number, height: number }
}

/** Bind a function so calling it off the proxy does not trip an illegal invocation. */
function passthrough(realWindow: object, property: string): unknown {
  const value = (realWindow as Record<string, unknown>)[property]
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(realWindow) : value
}

/**
 * Install the sandbox and start listening for the card body.
 *
 * @param env - the frame's realm, injected.
 * @returns the handle, mostly for tests and diagnostics.
 */
export function installSandbox(env: FrameEnv): FrameSandbox {
  // Until the shell reports, fall back to the frame's own size. A card measuring
  // the viewport before the first message gets a real number rather than zero.
  let viewport = { width: 0, height: 0 }

  /*
   * The floor this frame renders, as the shell told it. Undefined is the
   * legitimate state of a script frame — there, `getCurrentMessageId` must
   * throw, exactly as upstream does outside a message iframe — so the flag is
   * the value, and the member reads it through the closure below.
   */
  let currentFloor: number | undefined = undefined
  const readViewport = (): { width: number, height: number } => viewport

  /*
   * What a card wrote into the composer, kept **here** rather than read back
   * from the shell.
   *
   * The value getter is synchronous and the shell is across a message boundary,
   * so a live read is not available. Answering from the card's own last write
   * serves both measured variants — each writes, then either reads back or
   * clicks — and it is deliberately **narrower than upstream**: a card cannot
   * read what the *reader* has typed. Upstream's `#send_textarea.value` would
   * hand it over. That divergence is in the safe direction and belongs in the
   * ledger; the alternative is streaming every keystroke into every card frame,
   * which costs more and exposes more.
   */
  let composerShadow = ''

  /*
   * Whether a generation is running, tracked from the events the shell forwards.
   *
   * **Not from the context snapshot**, which does not carry it — and adding a
   * field to the protocol for something the event stream already says would put
   * the same fact in two places, which is how they come to disagree. Upstream
   * has the same arrangement: its `is_send_press` is set by the generation
   * events, not carried on the context.
   *
   * Three card-visible things answer from this one variable —
   * `#send_but.disabled`, `#mes_stop`'s visibility, and `parent.is_send_press` —
   * because they are three spellings of one fact and a card may read any of
   * them.
   */
  let generating = false

  const anchors = env.members.createStAnchors({
    draft: () => composerShadow,
    setDraft: text => {
      composerShadow = text
      void callAction('composerDraft', { text }).then(undefined, (error: unknown) => {
        reportFault(
          'a card wrote to the composer and the shell did not take it: '
          + (error instanceof Error ? error.message : String(error)),
        )
      })
    },
    send: () => {
      void callAction('composerSend', {}).then(
        () => {
          // The composer clears on send, and the card's shadow has to follow or
          // its next read would return text that is no longer anywhere.
          composerShadow = ''
        },
        (error: unknown) => {
          reportFault(
            'a card asked to send a message and nothing was sent: '
            + (error instanceof Error ? error.message : String(error)),
          )
        },
      )
    },
    generating: () => generating,
    report: (message, failed) => {
      if (failed) reportFault(message)
      else reportGap(message)
    },
  })

  /*
   * An element standing for **this frame**, real and in the card's container.
   *
   * Upstream's cards find each other through the page: 銀麒赎世's system panel
   * does `parent.document.querySelectorAll('iframe')` and checks each one's
   * `contentWindow.phoneAPI`, where the phone UI published its interface. It
   * **never reads `window.phoneAPI` directly** [44], so frame discovery is its
   * only path, and its guard is `if (fw && fw.phoneAPI)`: either half missing is
   * silent.
   *
   * **A real node rather than one synthesised into `parent.document`'s answers**,
   * and the reason is a path no synthesis could reach: a card's bare
   * `$('iframe')` searches the *frame's own* document. Upstream's `$` is the
   * page's, so upstream's bare query finds the card's frame — a stand-in
   * visible only through `parent.document` would have left that difference in
   * place, and the standing discipline is to close a mechanism difference rather
   * than to match the corpus's current hit count.
   *
   * `contentWindow` is the **real** window, not the shadow: a card publishes
   * with `window.phoneAPI = …` from a module body, and a module cannot be handed
   * a shadowed `window` (the name is not redefinable), so the write lands on the
   * real one. Handing back the shadow would find nothing.
   *
   * The cost, recorded rather than hidden: one empty nested browsing context per
   * card, and the element appears in the card's own DOM walks. The second half
   * is **more** faithful, not less — upstream's page contains the card's frame
   * too.
   */
  const installSelfFrame = (): void => {
    if (env.appendToContainer === undefined) return
    const node = env.factory.createElement('iframe')
    if (node === null || typeof node !== 'object') return
    try {
      // Hidden and inert: it exists to be *found*, never to render. Zero-sized
      // so the overlay-region walk drops it rather than clipping to it.
      const styled = node as { style?: Record<string, string>, setAttribute?: (n: string, v: string) => void }
      styled.setAttribute?.('aria-hidden', 'true')
      styled.setAttribute?.('title', 'this card\u2019s own frame')
      if (styled.style !== undefined) {
        styled.style['display'] = 'none'
      }
      /*
       * Instance properties shadowing the prototype's accessors. The native
       * `contentWindow` of this empty element would be its own blank nested
       * frame — correct for what the element is, and useless for what a card is
       * asking, which is "the frame the API was published in".
       */
      Object.defineProperty(node, 'contentWindow', {
        /*
         * A stored reference, not a getter, and a mutation test is what settled
         * it: replacing the getter with `value:` changed **nothing** any test
         * could see, because `env.realWindow` is one stable object and a later
         * `window.phoneAPI = …` mutates that object rather than replacing it.
         * A getter would have looked more careful while buying nothing.
         */
        value: env.realWindow,
        configurable: true,
      })
      Object.defineProperty(node, 'contentDocument', {
        // The virtual document: the same object the card gets as
        // `parent.document`. Not `null` — null is the answer for a frame we
        // cannot reach into, and this is the one frame we are inside of.
        get: () => virtualDocument,
        configurable: true,
      })
      env.appendToContainer(node)
    } catch {
      /*
       * A realm where the accessors cannot be shadowed. Reported by absence
       * rather than by a throw: a frame that failed to install this is a frame
       * where one card's panel will not find its phone, which is worse than a
       * frame that did not come up at all only if it pretends otherwise.
       */
    }
  }

  const virtualDocument = createVirtualDocument({
    container: env.container,
    ...(env.head === undefined ? {} : { head: env.head }),
    viewport: readViewport,
    factory: env.factory,
    anchors,
    knownIds: env.members.KNOWN_ST_IDS,
    report: (message, failed) => {
      if (failed) reportFault(message)
      else reportGap(message)
    },
    /*
     * Read-only page state, so a status read answers instead of killing a
     * script. `title` is the one value this module has rather than the realm:
     * a card asking for the document title in a chat is asking whose chat it
     * is, and upstream's title carries the character's name.
     */
    state: {
      get visibilityState(): string {
        return env.pageState?.().visibilityState ?? 'visible'
      },
      get hidden(): boolean {
        return env.pageState?.().hidden ?? false
      },
      get title(): string {
        return context?.name2 ?? ''
      },
      get url(): string {
        return env.pageState?.().url ?? 'about:srcdoc'
      },
    },
  })

  /*
   * After the virtual document exists, because the element's `contentDocument`
   * answers with it — and before any card code runs, so a card that enumerates
   * frames on its first line finds it.
   */
  installSelfFrame()

  const unbridged = new Map(UNBRIDGED_GLOBALS.map(row => [row.name, row]))

  /**
   * The host snapshot.
   *
   * Seeded from the document when the shell inlined one, and pushed updates
   * replace it afterwards. A **message frame** needs the seed: its card markup
   * runs at parse time and reads variables immediately, which is earlier than
   * any `postMessage` can arrive — the shell sends `context` only after `ready`.
   * Without the seed, correctness would rest on the parse pause of a library
   * fetch happening to outlast a message round trip.
   *
   * A **script frame** inlines nothing and this stays undefined until the push,
   * which is correct there: a script body is handed over the channel, so it
   * cannot run before the channel has been used.
   */
  let context: ScriptContext | undefined = env.seededContext?.()

  /**
   * `extension_settings`, watched for top-level assignment.
   *
   * The corpus contains `if (!SillyTavern.extensionSettings.x) { … }` followed by
   * `SillyTavern.extensionSettings.x = computed`. Without reporting that write
   * the card recomputes the same value every run and stores it into a snapshot
   * that is thrown away — silently, which is the expensive kind of wrong.
   *
   * Shallow: a top-level assignment is the shape that was measured. A mutation
   * deeper inside an existing object is NOT caught here, and that is a known
   * limit rather than an oversight — see the README.
   */
  const settingsProxy = (own: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(own, {
      set(target, property, value): boolean {
        const applied = Reflect.set(target, property, value)
        if (applied) env.post({ iris: env.token, type: 'settings', settings: { ...target } })
        return applied
      },
      deleteProperty(target, property): boolean {
        const applied = Reflect.deleteProperty(target, property)
        if (applied) env.post({ iris: env.token, type: 'settings', settings: { ...target } })
        return applied
      },
    })

  let extensionSettings: Record<string, unknown> | undefined

  /*
   * The save side of the settings report, one channel with the proxied write.
   *
   * Built once per frame so a card holding the function across reads — and
   * MVU's store does exactly that, capturing it in a Vue watch — always holds
   * the same object. The debounce length is upstream's
   * `debounce_timeout.relaxed` (`public/scripts/constants.js:14`), which is
   * the constant `DEFAULT_SAVE_EDIT_TIMEOUT` is defined from.
   */
  const postSettingsForSave = (): void => {
    env.post({ iris: env.token, type: 'settings', settings: { ...(extensionSettings ?? {}) } })
  }
  const saveSettingsNow = (): void => {
    postSettingsForSave()
  }
  const SAVE_SETTINGS_DEBOUNCE_MS = 1_000
  let saveSettingsTimer: ReturnType<typeof setTimeout> | undefined
  const saveSettingsDebouncedFn = (): void => {
    if (saveSettingsTimer !== undefined) clearTimeout(saveSettingsTimer)
    saveSettingsTimer = setTimeout(() => {
      saveSettingsTimer = undefined
      postSettingsForSave()
    }, SAVE_SETTINGS_DEBOUNCE_MS)
  }

  /**
   * `SillyTavern`, as a card sees it.
   *
   * Both shapes the corpus uses: `getContext()` and direct member reads off the
   * global. Truthy the moment a snapshot exists, because 12 of its 15 measured
   * sites are `if (window.parent.SillyTavern)` probes deciding which window to
   * talk to — a falsy answer sends the card down its own-window branch, where it
   * does nothing and says nothing.
   */
  const sillyTavern = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      if (typeof property === 'symbol') return undefined
      if (context === undefined) {
        throw new UnsupportedApiError(
          `SillyTavern.${property}`,
          'The host context has not reached this frame yet.',
        )
      }
      if (property === 'getContext') return () => sillyTavern
      if (property === 'extensionSettings') return extensionSettings

      /*
       * The settings saves, upstream's own pair (`public/script.js:469`):
       *
       *   saveSettingsDebounced = debounce(saveSettings, debounce_timeout.relaxed)
       *
       * What they must answer is "the settings this card just wrote will be
       * persisted", and the persisted thing a frame owns here is its
       * **extension settings partition** — the object `extensionSettings`
       * hands out, whose proxied writes already report themselves. So a save
       * rides that same report: the shell hears it exactly as it hears a
       * proxied write, and one store action carries both to the host. Nothing
       * else this frame could reach is upstream's `settings.json`, and
       * inventing a wider save would claim a persistence Iris cannot do.
       *
       * Measured in every MVU-bearing card of the corpus: the bundle's
       * settings store calls `SillyTavern.saveSettingsDebounced()` on each
       * mutation, and an absent member threw `TypeError` inside its watch
       * callback once per frame boot. `saveSettings` is carried for the same
       * class of caller — upstream declares both, and a bundle that wants its
       * write on disk *now* calls the immediate one.
       *
       * Both ignore their arguments: upstream's `loopCounter` is recursion
       * bookkeeping for its own retry, not a caller's option.
       */
      if (property === 'saveSettings') return saveSettingsNow
      if (property === 'saveSettingsDebounced') return saveSettingsDebouncedFn

      /*
       * The bus, reachable through `getContext()` as well as through `parent`.
       *
       * Measured: two cards read `ctx.eventSource` and `ctx.event_types` across
       * nine sites each, always as the pair and always behind
       * `if (ctx && ctx.eventSource && ctx.event_types)`. Until now this surface
       * carried neither, so that guard was simply false and nine sites per card
       * quietly took their fallback path.
       *
       * **The same objects the parent proxy hands out**, not equivalents.
       * Upstream's `eventOn` is a wrapper around `eventSource`, so a card that
       * subscribes through one route and emits through the other is talking to
       * itself — two buses would make that stop working with nothing to see.
       */
      if (property === 'eventSource') return eventSource
      if (property === 'event_types') return TAVERN_EVENTS

      /*
       * Which chat this is, which a card uses as a key.
       *
       * Upstream returns the chat **file** identifier — `characters[this_chid].chat`,
       * or the group's `chat_id` — and `undefined` when nothing is selected
       * (`SillyTavern/public/script.js:540-546`). Iris answers with the snapshot's
       * chat id, which is a different string for the same role: an opaque handle
       * that changes when the conversation does.
       *
       * The difference matters only to a card that treats the value as a
       * filename rather than as a key. None measured does, and the alternative —
       * leaving it absent — is worse in a way that was observed rather than
       * argued: the sample card's interface calls this during startup, so its
       * absence stopped the whole bridge at its title screen with a
       * `ReferenceError` and no further initialisation.
       *
       * `undefined` when there is no chat, matching upstream: a card checking for
       * one must be able to find none.
       */
      /*
       * **A stringified array index, not Iris's character id.**
       *
       * Upstream's `this_chid` is literally `String(characters.indexOf(value))`
       * (`script.js:7073`), and the one corpus script that reaches into the array
       * does `ctx.characters[ctx.characterId]`. Iris's own ids are opaque
       * strings, and `array["银麒赎世"]` is `undefined` — so handing over the real
       * id breaks the lookup while every guard around it passes: `characters`
       * exists, `characterId` is truthy, and the indexed read is simply absent.
       *
       * The chain that fails then is worth naming, because its failure is
       * invisible: `charData` undefined → `entries` stays `[]` → the render loop
       * runs zero times → `evalTemplate` is never called. **Nothing throws and
       * an acceptance run goes green**, because green here means "never
       * executed" rather than "behaved correctly".
       *
       * A key equal to the id is not enough either. Array indexing with a
       * non-numeric string finds nothing whatever the ids are, so matching the
       * field would have looked like a fix and changed no behaviour.
       *
       * **The translation lives here and stops here.** The index is the *facade's*
       * contract, not the system's; every member inside this file that needs a
       * real character id keeps reading it off the snapshot.
       */
      if (property === 'characterId') return currentCharacterIndex()

      if (property === 'getCurrentChatId') return () => context?.chatId

      /*
       * Upstream's, transcribed rather than designed (`public/script.js:8918`):
       *
       *   chat_metadata = reset ? { ...newValues } : { ...chat_metadata, ...newValues }
       *
       * Three properties of that line matter, and all three are easy to improve
       * by accident:
       *
       * - **It is one level deep.** `updateChatMetadata({a: {b: 1}})` replaces
       *   the whole of `a`; anything else under `a` is gone. A deep merge would
       *   be friendlier and would silently keep keys upstream drops.
       * - **It rebinds rather than mutating.** The card's own reference to the
       *   old object keeps pointing at the old object. The corpus's one caller
       *   relies on the consequence: a shallow spread copies the *reference* to
       *   each nested value, so the nested object it just wrote into is shared
       *   with the new metadata. Mutating in place here would also work for that
       *   card and would diverge from upstream for one that held a reference.
       * - **It does not save.** Persistence is `saveMetadata`, separately, and
       *   the corpus's caller debounces that by 2000ms with an explicit
       *   `skipSave` path — so folding a write into this call would both defeat
       *   the debounce the card author chose and remove a capability they use.
       *
       * Synchronous and returning nothing, per the declaration
       * (`exported.sillytavern.d.ts:478`). `reset` is typed as required upstream
       * but read for truthiness, so omitting it means `false`.
       */
      if (property === 'updateChatMetadata') {
        return (newValues: unknown, reset?: unknown): void => {
          if (context === undefined) return
          // Spread as upstream spreads, including its treatment of a non-object:
          // `{...null}` and `{...5}` contribute nothing, and this copies that
          // rather than validating, because a card passing one is already
          // relying on whatever upstream does with it.
          const incoming = { ...(newValues as Record<string, unknown>) }
          context = {
            ...context,
            chatMetadata: reset === true || Boolean(reset)
              ? incoming
              : { ...context.chatMetadata, ...incoming },
          }
        }
      }

      /*
       * Actions, reachable here AND through `getContext()` — because `getContext`
       * returns this same object. One surface, two entry points, which is what
       * upstream has: `SillyTavern.saveMetadata` and `context.saveChat` are both
       * measured in real cards, and MVU calls `SillyTavern.saveChat` directly.
       *
       * The earlier facade offered the data members both ways and the actions
       * neither, which is the gap a real card found.
       */
      if (isOnSillyTavernSurface(property)) {
        if (property === 'saveMetadata') {
          // No argument upstream: a card mutates `chatMetadata` in place and then
          // asks for it to be saved. So the current snapshot is what travels,
          // rather than whatever the card happened to pass.
          return () => callAction('saveMetadata', { metadata: context?.chatMetadata ?? {} })
        }
        if (property === 'saveChat') return () => callAction('saveChat', {})

        /*
         * Upstream numbers its positions; this contract names them. The map is
         * read off upstream's own use of the enum, not off the names:
         * `script.js:4641-4642` fetches `BEFORE_PROMPT` as the anchor's before
         * and `IN_PROMPT` as its after, and `:5588` is where `IN_CHAT` is
         * inserted by depth.
         *
         *   2  BEFORE_PROMPT  → 'before'
         *   0  IN_PROMPT      → 'after'
         *   1  IN_CHAT        → 'at-depth'
         *  -1  NONE           → no counterpart; refused by name
         *
         * The corpus passes a bare `1` twice and nothing else, which happens to
         * be this contract's default — so leaving the argument untranslated would
         * work today by luck and fail the moment a card passes `0` or `2`.
         * Translating is cheaper than remembering that.
         *
         * `NONE` is refused rather than defaulted. It means "registered but not
         * positionally injected", which this vocabulary cannot express at all,
         * and the alternative is putting the card's text somewhere it explicitly
         * asked for it not to go.
         */
        if (property === 'setExtensionPrompt') {
          const POSITIONS = new Map<number, string>([[2, 'before'], [0, 'after'], [1, 'at-depth']])
          return (key: unknown, value: unknown, position?: unknown, depth?: unknown, ...rest: unknown[]) => {
            /*
             * `scan`, `role` and `filter` exist upstream and this contract carries
             * none of them. No measured card passes any, so they are not built —
             * but a card that does must be told, because silently dropping an
             * argument that changes where and how a prompt is scanned is the kind
             * of difference that surfaces as a bad reply rather than as an error.
             */
            if (rest.length > 0) {
              reportGap(
                `a card called SillyTavern.setExtensionPrompt with ${String(rest.length + 4)} arguments;` +
                  ' Iris carries key, value, position and depth, and ignored the rest',
              )
            }

            const named = position === undefined ? undefined : POSITIONS.get(Number(position))
            if (position !== undefined && named === undefined) {
              throw new UnsupportedApiError(
                'SillyTavern.setExtensionPrompt',
                `Iris has no counterpart for extension prompt position ${String(position)}`
                  + ' — it carries before (2), after (0) and at-depth (1).',
              )
            }

            return callAction('setExtensionPrompt', {
              key: String(key),
              value: String(value),
              // Omitted rather than guessed, so the contract's own default applies
              // and there is one place that decides it.
              ...(named === undefined ? {} : { position: named }),
              ...(depth === undefined ? {} : { depth: Number(depth) }),
            })
          }
        }
        /*
         * One book, in the shape it is saved in.
         *
         * **The uid-keyed raw object, not our normalised entry array.** MVU
         * guards its result with `isPlainObject(loaded.entries)` and then indexes
         * it by uid, so handing back the array `getWorldbook` returns would pass
         * a `typeof` check and fail at the first index — the failure mode this
         * project keeps paying for, where the shape is wrong and only the use
         * site can tell.
         *
         * Three answers, kept apart because upstream keeps them apart:
         *
         * - **an object** — the book was found and loaded;
         * - **`null`** — a name was asked for and there is no such book. The
         *   contract's reply is `{ book?: unknown }`, so an absent key means
         *   asked-and-missing, and `null` is what upstream's own
         *   `loadWorldInfo` returns for it;
         * - **`undefined`** — nothing was asked. Upstream opens with
         *   `if (!name) return`, returning undefined without touching storage,
         *   and a card that tests `if (loaded === undefined)` is testing for its
         *   own missing argument rather than for a missing book. Collapsing the
         *   two would answer "there is no such book" to a card that never named
         *   one.
         */
        if (property === 'loadWorldInfo') {
          return async (name?: unknown): Promise<unknown> => {
            // Upstream's falsy test, not a typeof: it takes `''`, `0` and `null`
            // through the same early return.
            if (name === undefined || name === null || name === '' || name === false) {
              return undefined
            }
            const reply = await callAction('loadWorldInfo', { name: String(name) })
            const book = (reply as { book?: unknown } | undefined)?.book
            return book === undefined ? null : book
          }
        }

        /*
         * `generate` and `generateRaw` are two wire methods, and this used to be
         * one.
         *
         * Every surface member without its own branch above fell into a body
         * that called `generateRaw` regardless of the name read — so
         * `SillyTavern.generate('hi')` ran `script.generateRaw`, which takes
         * `prompt` and carries no chat history, in place of `script.generate`,
         * which takes `userInput` and does. It reached no card only because the
         * surrounding shape check throws by name for a non-string argument, so
         * `setVariables` and `swipeTo` were refused rather than misrouted; a
         * string argument to either would have been sent as a generation.
         *
         * The pin beside this asserts the surface's *names*, which is exactly
         * the assertion a misroute passes.
         */
        if (property === 'generate' || property === 'generateRaw') {
          const field = property === 'generate' ? 'userInput' : 'prompt'
          return (...args: unknown[]) => {
            // Upstream's signature varies by caller, and guessing wrong would
            // send a malformed request that fails as a host error rather than as
            // a shape problem. A string is the contract's shape; an object with
            // a prompt-ish field is the other common one; anything else is
            // refused by name so the next real card tells us what it actually
            // passes instead of us inferring it.
            const first = args[0]
            if (typeof first === 'string') return callAction(property, { [field]: first })
            if (typeof first === 'object' && first !== null) {
              const bag = first as Record<string, unknown>
              const text = bag['prompt'] ?? bag['user_input'] ?? bag['userInput']
              if (typeof text === 'string') return callAction(property, { [field]: text })
            }
            throw new UnsupportedApiError(
              `SillyTavern.${property}`,
              `Iris does not recognise this call's arguments (${typeof first}); the shape a card passes has not been measured yet.`,
            )
          }
        }

        /*
         * Routable, on the surface, and with no branch that knows its arguments.
         *
         * Refused by name rather than handed to whichever branch happens to be
         * last. A member reaches here by being added to `CARD_METHODS` without a
         * translation, which is a gap in this file — and saying so is the
         * difference between one round trip and a card that appears to work
         * while calling something else entirely.
         */
        throw new UnsupportedApiError(
          `SillyTavern.${property}`,
          'Iris can route this action but has not built the translation from a card\u2019s'
          + ' arguments to it, so it is refused rather than sent as some other call.',
        )
      }
      const fields = context as unknown as Record<string, unknown>
      if (Object.hasOwn(fields, property)) return fields[property]

      /*
       * An unbuilt member yields `undefined` and is reported once — **the same
       * policy as the virtual parent, and deliberately not a second copy of the
       * reasoning.** See the long note on the parent proxy's unpublished-name
       * branch above: it explains why throwing was right about the danger and
       * wrong about the mechanism, and it was paid for. The two surfaces answer
       * one question, so they change together or not at all.
       *
       * This surface kept throwing after that lesson landed next door, which was
       * not a decision anyone recorded — the refusal here carried no note saying
       * why it should differ. Two symptoms of the gap:
       *
       * - The hazard is the same one, not an analogous one. Every measured
       *   `SillyTavern` access in the corpus is behind a truthiness guard, so
       *   `if (ctx.setVariable)` — a card degrading gracefully — threw at the
       *   read. The guard triggered the thing it existed to prevent, which is
       *   exactly how the parent case failed.
       * - `has` already returned `false` for these names while `get` threw, so
       *   `'x' in SillyTavern` and `SillyTavern.x` disagreed. Yielding
       *   `undefined` makes the two traps consistent as a side effect rather
       *   than as a second fix.
       *
       * "Absence must be named" is unchanged; the naming moves from an exception
       * to a report, and the report channel is durable and generation-stamped.
       */
      reportGap(
        `a card read SillyTavern.${property}, which Iris has not built` +
          ' — it returned undefined, which is not a statement that the host has no such member',
      )
      return undefined
    },
    set(_target, property): boolean {
      throw new UnsupportedApiError(
        `SillyTavern.${String(property)}`,
        'Assign into extensionSettings, or call the save methods.',
      )
    },
    has(_target, property): boolean {
      if (context === undefined) return false
      const fields = context as unknown as Record<string, unknown>
      return (
        property === 'getContext' ||
        property === 'extensionSettings' ||
        property === 'eventSource' ||
        property === 'event_types' ||
        // The save pair answers `get` above; `in` has to agree with it, which is
        // the same get/has consistency the rest of this trap exists to keep.
        property === 'saveSettings' ||
        property === 'saveSettingsDebounced' ||
        // Built here rather than routed to the host, so `isCardMethod` does not
        // know about it and a card feature-testing with `in` would be told no.
        property === 'updateChatMetadata' ||
        (typeof property === 'string' && isOnSillyTavernSurface(property)) ||
        Object.hasOwn(fields, property)
      )
    },
  })

  /** `parent` and `top`, as a card sees them. */
  /**
   * Names this card's scripts have published to each other.
   *
   * One bag per frame, and after cohabitation a frame is one card — so this is
   * the card-scoped shared namespace that upstream gets for free by having all
   * its script frames share a same-origin parent. `window.parent` is where a
   * provider publishes: MVU writes `_.set(window.parent, 'Mvu', mvu)` and
   * removes it again with `_.unset` on teardown.
   *
   * Reads and writes are deliberately asymmetric. A name that has been written
   * reads back; a name nobody wrote still refuses by name, exactly as before.
   * Turning every unknown parent member into `undefined` would trade the
   * refusal discipline — the thing eleven sandbox runs bought — for the
   * convenience of a shared slot, and a card reaching for a host API we do not
   * have would fail somewhere else entirely.
   */
  const published = new Map<string, unknown>()

  /**
   * Names already given a `predefine`-shaped accessor in this frame.
   *
   * Only to avoid redefining on every subsequent script. Deliberately **not**
   * covered by an assertion: the property is `configurable`, so redefining it
   * is harmless, and a mutation removing this set would turn no test red. A
   * guard whose absence nothing can observe should say so rather than carry a
   * test that cannot fail (METHODS §十七).
   */
  const predefined = new Set<string>()

  /**
   * Upstream's `predefine.js` check, at the moment this frame's analogue of a
   * frame bootstrap happens: just before a script's body is evaluated.
   *
   * `predefine.js:36-44` asks `_.has(window.parent, 'Mvu')` **once**, when a
   * script's iframe boots, and on a hit defines a live accessor on that frame's
   * own window reading back through the parent. A miss installs nothing and is
   * never revisited. One name, not a list — the other members ride the
   * `_.pick` allow-list at `predefine.js:11-19`.
   *
   * **Why it hangs off each script rather than off frame startup.** Upstream
   * gives every script its own iframe, so "when the frame boots" *is* "when the
   * script starts". Iris runs all of a card's scripts in one frame, so frame
   * startup happens once and would always miss: the thing that publishes `Mvu`
   * is the card's own MVU script, which is a body evaluated after the frame is
   * up. Per script is the placement that carries upstream's meaning across the
   * structural difference.
   *
   * **What it deliberately does not do**: it does not backfill. A script that
   * starts before the publisher sees no `Mvu` and keeps seeing none, which is
   * upstream's outcome for a frame that booted early, and is the half a test
   * pins so nobody quietly upgrades this to "always available".
   */
  const predefineShared = (): void => {
    const name = 'Mvu'
    if (predefined.has(name) || !published.has(name)) return
    predefined.add(name)
    env.definePredefined?.(name, () => published.get(name))
  }

  /** Members the frame bridges itself, which a card may never overwrite. */
  const isBridged = (property: string): boolean =>
    property === 'document' ||
    /*
     * Read-only like `document`: within one card the scripts share this frame,
     * so a script assigning `parent.$` would replace every sibling's selector
     * engine. Upstream cannot be written to either — its `parent.$` is the host
     * page's global, and a card that overwrote it would be breaking
     * SillyTavern's own UI rather than its neighbour's.
     */
    property === '$' ||
    property === 'jQuery' ||
    property === 'innerWidth' ||
    property === 'innerHeight' ||
    property === 'SillyTavern' ||
    property === 'extension_settings' ||
    property === 'TavernHelper' ||
    property === 'eventSource' ||
    property === 'event_types' ||
    // The window event-target surface: on a real parent these are native and
    // unwritable, so the stand-in keeps the same read-only shape.
    property === 'addEventListener' ||
    property === 'removeEventListener' ||
    property === 'dispatchEvent'

  const virtualParent = new Proxy(Object.create(null) as object, {
    get(_target, property): unknown {
      if (typeof property === 'symbol') return undefined
      if (property === 'document') return virtualDocument
      if (property === 'innerWidth') return viewport.width
      if (property === 'innerHeight') return viewport.height
      // A window size is not a secret, and the frame can already read one off
      // its own `window.screen`; refusing it would break ten measured sites to
      // protect nothing.
      if (property === 'SillyTavern') return context === undefined ? undefined : sillyTavern
      if (property === 'extension_settings') return extensionSettings
      /*
       * The three that used to be `UNBRIDGED_GLOBALS`, measured at 15 sites
       * between them. All reach the same objects a card gets as bare globals:
       * upstream's `eventOn` is a wrapper around `eventSource`, so a card that
       * subscribes through one name and emits through the other must still be
       * talking to itself.
       */
      if (property === 'TavernHelper') return tavernHelper['TavernHelper']
      if (property === 'eventSource') return eventSource
      if (property === 'event_types') return TAVERN_EVENTS
      /*
       * The window event-target surface, on the same bus as `eventSource`. A
       * `getTopWindow()` helper that returned the real top used to answer these
       * reads with a cross-origin SecurityError; falling through to the
       * unpublished-name path would answer `undefined` and move the same failure
       * into a `TypeError` one line later. Both are worse than routing.
       */
      if (property === 'addEventListener') return parentEventTarget.addEventListener
      if (property === 'removeEventListener') return parentEventTarget.removeEventListener
      if (property === 'dispatchEvent') return parentEventTarget.dispatchEvent

      // Published by one of this card's scripts. Checked after the bridged
      /*
       * The EJS template renderer, on the parent because that is where cards
       * reach it: `var tw = window.parent || window; tw.EjsTemplate.…`, sixteen
       * times in the one card that uses it. It is the extension's own global,
       * not part of the Tavern Helper surface, so putting it there would have
       * been a member upstream does not have on a surface it does have.
       *
       * A **real function**, not the report-on-read path the rest of this proxy
       * uses for absent names. The measured caller feature-tests with
       * `typeof tw.EjsTemplate.evalTemplate === 'function'`, and a getter that
       * answered `undefined` would fail that test — correctly, if we had nothing
       * to offer, and wrongly now that we do.
       */
      if (property === 'EjsTemplate') return ejsTemplate

      /*
       * `parent.$` and `parent.jQuery`, answered with **this frame's** jQuery.
       *
       * Upstream's `parent_jquery.js` is two lines — `window.$ = window.parent.$`
       * — so a card's `$` upstream is the host page's instance and its selectors
       * run against the document that carries the overlay. This frame's own
       * jQuery is bound to this frame's document, and that document *is* the
       * surface a card mounts into, so the equivalence holds where it matters.
       *
       * **Not a convenience.** 3c counted 银麒赎世's system panel calling
       * `$p(sel){ var jq = _pw.$ || _pw.jQuery; if (!jq) return $(); … }`
       * **258 times** (`_pw.` 127, `_pd.` 37). With `$` absent from this proxy
       * every one of those calls took the guard, returned an empty jQuery set,
       * and did nothing — **no error, no report, no render**. A guard that
       * degrades silently turns a missing member into 258 no-ops, and the panel
       * would have shown a card that loaded and listened while drawing nothing.
       *
       * Read live off the frame's window rather than captured, because the
       * preset that seeds it loads as a script and may not have run when this
       * proxy is built. Absent means absent: the card's own guard is then
       * correct, and this returns undefined rather than a broken stand-in.
       */
      /*
       * `parent.is_send_press`, upstream's own name for "a generation is
       * running". A card polls it to avoid re-entering while the model writes.
       */
      if (property === 'is_send_press') return generating

      if (property === '$' || property === 'jQuery') {
        return (env.realWindow as unknown as Record<string, unknown>)[property]
      }

      // members so a card cannot shadow `document` by writing to it.
      if (published.has(property)) return published.get(property)

      /*
       * An unpublished name yields `undefined` and is reported once.
       *
       * It used to throw. That was right about the danger and wrong about the
       * mechanism, and it cost a verification round: upstream's cross-script
       * coordination begins with `_.get(window.parent, 'th_unique_check.…',
       * new Set())` — read with a default, then write — so throwing on the first
       * read of a slot nobody has published yet threw *inside* an init that
       * swallows exceptions. MVU never reached its `_.set(window.parent, 'Mvu',
       * …)`, and every consumer waited forever on a publish that had already
       * been abandoned.
       *
       * Returning `undefined` is also what upstream does — an absent property on
       * a real parent window is not an error. What upstream does *not* do is say
       * anything, and silence is what turns a missing host capability into a
       * failure three steps away. So the frame yields like upstream and speaks
       * unlike it: the policy asked for a named refusal *or an audible warning*,
       * and only the warning leaves a working namespace behind.
       *
       * Deduplicated, because a card polling a slot in a loop would otherwise
       * turn one gap into a stream.
       */
      const planned = unbridged.get(property)
      reportedAbsent.add(property)
      reportGap(
        planned === undefined
          ? `a card read parent.${property}, which nothing has published in this frame` +
            ' — it returned undefined, which is not a statement that the host has no such member'
          : `a card read parent.${property}, which Iris has measured but not built yet` +
            ` (planned as ${planned.plan}); it returned undefined`,
      )
      return undefined
    },

    set(_target, property, value): boolean {
      if (typeof property === 'symbol') {
        throw new UnsupportedApiError('parent[symbol]', 'The sandbox is not writable.')
      }
      // The bridged members stay read-only. A card overwriting `document` or
      // `SillyTavern` would be redefining the frame's own view of the host.
      if (isBridged(property)) {
        throw new UnsupportedApiError(`parent.${property}`, 'The sandbox is not writable.')
      }
      publishName(property, value)
      return true
    },
    /**
     * Removing a published name.
     *
     * MVU does this on teardown (`_.unset(window.parent, 'Mvu')`), and a
     * provider that cannot retract its interface would leave consumers waiting
     * on something already gone.
     */
    deleteProperty(_target, property): boolean {
      if (typeof property === 'symbol' || isBridged(property)) {
        throw new UnsupportedApiError(`parent.${String(property)}`, 'The sandbox is not writable.')
      }
      published.delete(property)
      return true
    },
    has(_target, property): boolean {
      if (typeof property === 'symbol') return false
      return (
        published.has(property) ||
        property === 'document' ||
        /*
         * Agreeing with the `get` trap, which is the only reason this line
         * exists: a card's guard is `_pw.$ || _pw.jQuery` (a read), but
         * `_.has(parent, '$')` is a different question asked by the same cards
         * about other members, and a proxy whose `has` disagrees with its `get`
         * is the shape that made `waitGlobalInitialized` poll false forever
         * while `in` said true.
         */
        ((property === '$' || property === 'jQuery')
          && (env.realWindow as unknown as Record<string, unknown>)[property] !== undefined) ||
        property === 'innerWidth' ||
        property === 'innerHeight' ||
        property === 'TavernHelper' ||
        property === 'eventSource' ||
        property === 'event_types' ||
        property === 'addEventListener' ||
        property === 'removeEventListener' ||
        property === 'dispatchEvent' ||
        ((property === 'SillyTavern' || property === 'extension_settings') && context !== undefined)
      )
    },
    /**
     * The trap `_.has` actually reaches.
     *
     * `hasOwnProperty` does **not** go through `has` — it goes through here — and
     * lodash's `_.has` is built on `hasOwnProperty`. Since
     * `waitGlobalInitialized` polls with `_.has(window, 'Mvu')`, omitting this
     * trap would leave the poll answering false forever while `in` said true:
     * the feature would fail with both halves apparently correct.
     */
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      if (typeof property !== 'string') return undefined
      if (!published.has(property)) return undefined
      return { value: published.get(property), writable: true, enumerable: true, configurable: true }
    },
    /** So `Object.keys(parent)` sees what this card published, and nothing else. */
    ownKeys(): ArrayLike<string | symbol> {
      return [...published.keys()]
    },
  })

  /**
   * `window`, `self` and `globalThis`, as a card sees them.
   *
   * Proxied through to the real frame window rather than replaced: a card
   * legitimately uses `window.addEventListener`, `window.setTimeout` and its own
   * `document`, and all of that is the card's own realm. Only the three names
   * that reach outward are overridden.
   */
  const windowShadow = new Proxy(env.realWindow, {
    get(target, property): unknown {
      if (property === 'parent' || property === 'top') return virtualParent
      if (property === 'self' || property === 'window' || property === 'globalThis') {
        return windowShadow
      }
      if (typeof property === 'symbol') return Reflect.get(target, property)
      return passthrough(target, property)
    },
    set(target, property, value): boolean {
      // Writes land on the real frame window: a card assigning `window.foo` is
      // using its own realm as a namespace, which is its business.
      if (property === 'parent' || property === 'top') {
        throw new UnsupportedApiError(`window.${String(property)}`, 'The sandbox is not writable.')
      }
      return Reflect.set(target, property, value)
    },
  })

  /*
   * The bare globals are shadowed too, not only `parent.*`.
   *
   * Upstream flattens its whole API onto the child window as plain globals, so
   * cards are written against both shapes — the corpus has the compatibility
   * form that tries the bare global first and falls back to
   * `window.parent.extension_settings`. Bridging only the `parent` path would
   * miss every card that takes the first branch.
   *
   * `eventSource`, `event_types` and `TavernHelper` are deliberately NOT here:
   * they are unbridged, and a bare name left undefined at least makes a direct
   * use throw. (A `typeof x !== 'undefined'` probe still fails quietly, which is
   * a blind spot no shadowing can close — noted in the README.)
   */
  /**
   * `triggerSlash`, as a card sees it.
   *
   * Defined even though nothing executes the command yet, and that is the point:
   * the measured call site is
   * `if (typeof triggerSlash === 'function') triggerSlash(...)`, so an undefined
   * global makes the card skip the branch **silently**. A definition that hands
   * the string onward is a card that visibly does something; an absence is a card
   * that quietly does nothing, which is the failure mode this sandbox keeps
   * choosing against.
   *
   * The raw string travels unparsed — upstream's pipe escaping lives host-side
   * and a second copy here would be two ideas of one convention.
   *
   * The promise resolves when the **host has run the command**, which is where
   * upstream's resolves too: upstream waits for the command, not for generation,
   * and `/send|/trigger` finishing means the turn is open. Resolving on dispatch
   * would have been a deviation worth documenting; waiting for the answer is
   * simply the same contract.
   */
  let nextSlash = 0
  const pendingSlash = new Map<string, { resolve: (result: string) => void, reject: (why: Error) => void }>()

  let nextCall = 0
  const pendingCall = new Map<string, { resolve: (result: unknown) => void, reject: (why: Error) => void }>()

  /**
   * One action on the card's facade.
   *
   * The shell is what decides whether the action may run; this only carries the
   * request. A refusal comes back as a rejection so a card's `catch` sees it,
   * which is what upstream's would do.
   */
  /**
   * The ST-Prompt-Template extension's renderer, as a card reaches it.
   *
   * One member, because one is what the corpus uses. `evalTemplate(content)`
   * renders an EJS template against the host's macros, variables and chat state
   * — none of which exist in the frame, so it is a round trip and cannot be
   * anything else.
   *
   * **Failures are not caught here.** The measured caller wraps its call in
   * `console.warn` plus a fall back to the unrendered text, and that path is
   * only reachable if the rejection arrives. Two kinds do:
   *
   * - The evaluator refusing — a timeout, an evaluation error, or the fence's
   *   own named refusals for the `initial`/`cache` scopes and for `insvar` with
   *   an `index`. Those carry a specific reason, and **wrapping them into
   *   `undefined` would be the wrong direction for this surface**: on `$.fn` an
   *   `undefined` is honest because the plugin genuinely is not there, whereas
   *   here the capability exists and is deliberately withheld. Erasing a
   *   decision into an absence sends the card down a different path than the one
   *   the refusal was written for.
   * - Extra arguments. Upstream's signature carries `data` and `options`; the
   *   corpus passes neither, so they are not modelled — and they are **forwarded
   *   rather than dropped**, which the contract's strict shape turns into a
   *   named rejection. Silently ignoring an argument that changes what a
   *   template can see would surface as a wrongly-rendered prompt.
   */
  /**
   * Where the played character sits in the snapshot's `characters` array.
   *
   * Returns `undefined` rather than `'-1'` when there is no match. `'-1'` would
   * index to `undefined` anyway, so both stop the card's inner guard — but a
   * falsy `characterId` also stops the *outer* one, which is closer to what
   * upstream does with nothing selected and keeps a card out of a branch it
   * would enter believing a character was chosen.
   * @returns the index as a string, or undefined.
   */
  const currentCharacterIndex = (): string | undefined => {
    const snapshot = context
    if (snapshot === undefined || snapshot.characterId === undefined) return undefined
    const at = snapshot.characters.findIndex(row => row.characterId === snapshot.characterId)
    return at === -1 ? undefined : String(at)
  }

  const ejsTemplate = {
    evalTemplate: async (content: unknown, data?: unknown, options?: unknown): Promise<unknown> =>
      callAction('evalTemplate', {
        content: String(content),
        /*
         * Forwarded under upstream's own parameter names, so the contract's
         * strict shape rejects them by the name the card used. An invented field
         * would produce a refusal too, and it would name nothing the card could
         * find in its own source.
         */
        ...(data === undefined ? {} : { data }),
        ...(options === undefined ? {} : { options }),
      }),
  }

  const callAction = (method: string, params: unknown): Promise<unknown> => {
    const id = `c${(nextCall += 1)}`
    return new Promise<unknown>((resolve, reject) => {
      pendingCall.set(id, { resolve, reject })
      env.post({ iris: env.token, type: 'call', id, method, params })
    })
  }

  /*
   * The card-dialog bridge.
   *
   * This frame's sandbox never carries `allow-modals`, so the browser turns
   * `alert`, `confirm` and `prompt` into **silent no-ops** — a card that
   * reports its own failure through `alert("发送失败: …")` reports nothing,
   * and the reader sees a button that "does nothing". That is exactly the
   * swallowed failure the notice panel exists for, so the three names are
   * shadowed with bridges: the text travels to the shell on its own message
   * and lands in the panel, visible.
   *
   * The two that upstream answers *synchronously* cannot keep that contract
   * across a message boundary, and pretending otherwise would write the
   * reader's answers for them: `confirm` answers `false` and `prompt` answers
   * `null` — the same values a no-modal sandbox answers — while the panel
   * records what the card asked, so "the card needed an answer Iris cannot
   * give" is on the record instead of being indistinguishable from a bug.
   */
  const cardDialog = (kind: 'alert' | 'confirm' | 'prompt', text: string): void => {
    env.post({ iris: env.token, type: 'dialog', kind, text })
  }
  const bridgedDialogs: Record<string, unknown> = {
    alert: (text: unknown): undefined => {
      cardDialog('alert', String(text ?? ''))
      return undefined
    },
    confirm: (text: unknown): boolean => {
      cardDialog('confirm', String(text ?? ''))
      return false
    },
    prompt: (text: unknown): null => {
      cardDialog('prompt', String(text ?? ''))
      return null
    },
  }

  const triggerSlash = (command: unknown): Promise<string> => {
    const id = `s${(nextSlash += 1)}`
    return new Promise<string>((resolve, reject) => {
      pendingSlash.set(id, { resolve, reject })
      env.post({ iris: env.token, type: 'slash', id, command: String(command) })
    })
  }

  /*
   * The frame-side half of the same-origin fetch bridge.
   *
   * Upstream's card scripts run same-origin with SillyTavern, so a bundle's
   * `fetch('/version')` is an ordinary request to the page's own server. Here
   * the same path resolves to Iris's origin and `connect-src` refuses it — the
   * refusal is what produced the standing banner on every MVU card. The bridge
   * carries such a request to the shell on the `fetch` message that already
   * exists for remote dependencies, and the shell fetches it with its own
   * credentials. CSP is untouched: the bridged request never leaves from here,
   * and anything not same-origin goes to the native fetch below, where CSP
   * refuses exactly what it refused before.
   *
   * Only retrieval is bridged. GET and HEAD without a body or request headers
   * ride the message; a POST — which on Iris's own origin could be a state-
   * changing call to Iris itself, with the user's credentials attached — goes
   * native and is refused and reported like any other closed-directive request.
   */
  let nextFetch = 0
  const pendingFetch = new Map<string, { resolve: (response: Response) => void, reject: (why: Error) => void }>()

  /*
   * The native fetch, captured at install.
   *
   * `fetch` is among the published globals, so after publishing a read off the
   * window finds the bridge — and a bridge that reached its own published name
   * for the passthrough path would recurse into itself for every request it
   * declines. Capturing before any publish is the only way the non-same-origin
   * path stays native.
   */
  const nativeFetchValue = (env.realWindow as unknown as Record<string, unknown>)['fetch']
  const nativeFetch = typeof nativeFetchValue === 'function'
    ? (nativeFetchValue as (input: unknown, init?: unknown) => Promise<Response>).bind(env.realWindow)
    : undefined

  /**
   * The `Response` a card sees for a bridged request.
   *
   * A real `Response`, so `res.ok`, `res.status`, `res.json()` and
   * `res.headers.get('content-type')` all answer as the native object would —
   * a bundle's `.then(e => e.json())` must not learn the bridge's shape instead
   * of the fetch shape it was written against.
   * @param message - the shell's answer.
   * @returns the response.
   */
  const bridgedResponse = (message: Extract<ToFrame, { type: 'fetch:ok' }>): Response => {
    const status = message.status ?? 200
    // A body on these statuses makes the Response constructor throw; the shell
    // cannot have carried content for one anyway.
    const body = status === 204 || status === 205 || status === 304 ? null : message.content
    return new Response(body, {
      status,
      ...(message.contentType === undefined
        ? {}
        : { headers: { 'content-type': message.contentType } }),
    })
  }

  /**
   * Bridge a request when it is a same-origin retrieval, else leave it native.
   * @param input - what the card passed as the fetch input.
   * @param init - what the card passed as the fetch init.
   * @returns the bridged promise, or undefined when this request is not the
   *   bridge's business and the caller must go native.
   */
  const rideFor = (input: unknown, init: unknown): Promise<Response> | undefined => {
    const specifier = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : // A `Request` carries its own method, headers and body; unwrapping
          // all of that duplicates the object it wraps, so it stays native.
          undefined
    if (specifier === undefined || env.baseUrl === undefined) return undefined
    const options = (init ?? {}) as Record<string, unknown>
    if (options['body'] !== undefined || options['headers'] !== undefined) return undefined
    const method = (typeof options['method'] === 'string' ? options['method'] : 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return undefined
    const origin = new URL(env.baseUrl).origin
    const target = sameOriginTarget(specifier, env.baseUrl, origin)
    if (target === undefined) return undefined
    const id = `f${(nextFetch += 1)}`
    return new Promise<Response>((resolve, reject) => {
      pendingFetch.set(id, { resolve, reject })
      // The resolved absolute URL travels, not the specifier: the shell
      // re-checks origin before honouring, and resolving twice against two
      // bases could disagree about a page-relative path.
      env.post({ iris: env.token, type: 'fetch', id, url: target })
    })
  }

  /** The `fetch` a card sees: bridge where it applies, native everywhere else. */
  const fetchBridge = (input: unknown, init?: unknown): Promise<Response> => {
    const bridged = rideFor(input, init)
    if (bridged !== undefined) return bridged
    if (nativeFetch === undefined) {
      return Promise.reject(new Error(`fetch(${String(input)}): this frame has no native fetch`))
    }
    return nativeFetch(input, init)
  }

  /**
   * Which entry of `script.list` is running, carried in on the `run` message.
   *
   * The frame cannot derive this: the body it is handed is just source, and two
   * enabled scripts on one card are indistinguishable by their text. The runner
   * is the only party that knows which one it dispatched.
   */
  /**
   * The identity the *shared* global answers with, fixed at the first run.
   *
   * Card bodies get their true identity from the per-script preamble. Code they
   * **import** does not: a bundle is its own module and reads the global, so it
   * used to see whichever script ran last — a value that changes underneath it
   * between two of its own calls.
   *
   * That is fatal to the coordination upstream cards rely on. MVU registers with
   * `registerAsUniqueScript` under `getScriptId()` and later enables itself only
   * when `preferred === getScriptId()`; the two reads must agree, and a mutable
   * shared value can make them disagree for no reason the card can see.
   *
   * Fixed rather than cleared, and fixed to the *first* script because that id
   * has an element in the frame's script list — the election matches against
   * those, so an id with no element elects nobody.
   */
  let scriptId: string | undefined
  let scriptIdFixed = false


  /**
   * The bus is the frame's, not the host's.
   *
   * Cards both listen and emit, and MVU emits far more than it listens for — 53
   * `eventEmit` sites against 17 `eventOn`. Most of that traffic is a card
   * talking to itself, so it stays here; the shell forwards in only the host
   * events something is actually waiting on.
   */
  const events = new EventBus()
  const eventSource = env.members.createEventSource(events)

  /**
   * The parent window's native event-target surface.
   *
   * Upstream's `parent` is the ST page — a real window, so
   * `window.top.addEventListener('X', fn)` and `window.top.dispatchEvent(new
   * CustomEvent('X', {detail}))` work because same-origin windows work. A card
   * that reaches for one of those here must not fall through to the **real**
   * cross-origin parent, where the browser answers every read with a
   * SecurityError; the projector card's boot died on exactly that read. These
   * three route onto {@link events} — the same bus `eventSource` wraps — so
   * "subscribe through the parent, emit through `eventEmit`" and its reverse
   * stay one bus, not two.
   *
   * Cross-frame delivery rides the shell: a `dispatchEvent` posts a `winevent`,
   * and the shell rebroadcasts it to every frame of the card as an ordinary
   * `event` message, which the frame emits on this same bus. The listener
   * receives one argument shaped like the event that was dispatched —
   * `{type, detail}` — because that is what the DOM contract hands a
   * `CustomEvent` reader; the projector reads exactly `ev.detail`.
   */
  const parentEventTarget = {
    /**
     * No TH name guard here, on purpose: TH events come from a fixed table, and
     * a DOM event name is whatever the card dispatched — the projector's
     * `MvuFloatingBgRequest` is in no table and must still be heard.
     */
    addEventListener: (event: string, listener: Listener): void => {
      events.eventOn(String(event), listener)
    },
    removeEventListener: (event: string, listener: Listener): void => {
      events.eventRemoveListener(String(event), listener)
    },
    /**
     * `true` unconditionally, unlike the DOM's "was preventDefault called":
     * nothing here can answer that, and the measured callers ignore the answer.
     */
    dispatchEvent: (event: unknown): boolean => {
      const type = (event as { type?: unknown } | null | undefined)?.type
      if (typeof type !== 'string' || type.length === 0) {
        throw new UnsupportedApiError(
          'parent.dispatchEvent',
          'The event needs a string `type`.',
        )
      }
      const detail = (event as { detail?: unknown }).detail
      env.post({
        iris: env.token,
        type: 'winevent',
        event: type,
        ...(detail === undefined ? {} : { detail }),
      })
      return true
    },
  }

  /**
   * How long a wait may run before it is worth *saying* it is still waiting.
   *
   * A report threshold, not a deadline. Upstream's `waitGlobalInitialized` has
   * **no timeout at all** — it resolves when `global_X_initialized` fires and
   * otherwise waits forever. The five seconds this project used to apply here
   * were borrowed from the wrong place: `async-wait-until`'s default belongs to
   * the Mvu-specific `stat_data` poll, which runs *after* the global is already
   * present and whose timeout upstream catches and ignores.
   *
   * Mis-siting it turned a patient wait into a race. Every chat opens a fresh
   * opaque origin, so a card's bundle is always a cold fetch; upstream's frames
   * are same-origin and share the page cache, so its providers are effectively
   * always warm. A cap that upstream never pays cost us the window.
   */
  const WAIT_NOTICE_MS = 5_000

  /**
   * A global's name must be a non-empty string.
   * @param member - the caller, for the refusal.
   * @param name - whatever was passed.
   * @returns the name.
   */
  const requireGlobalName = (member: string, name: unknown): string => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new UnsupportedApiError(`${member}(${String(name)})`, 'A global needs a name.')
    }
    return name
  }

  /**
   * Announce a capability this frame lacks, once it has actually been reached
   * for.
   *
   * Not an error — the card carries on, as it would upstream. It exists because
   * the alternative is a gap wearing the shape of an ordinary answer: text
   * returned unexpanded is indistinguishable from text that had nothing to
   * expand.
   *
   * Deduplicated, because a card calling such a member in a loop would turn one
   * gap into a stream, and a stream teaches a reader to skip the whole class of
   * line rather than read it.
   */
  /**
   * Take on the variable table the host confirmed after a write.
   *
   * One implementation, used by both the shared surface and every per-script
   * view. It existed twice — once with this reasoning attached and once without
   * — and two copies of a rule where only one carries its reason is a copy
   * waiting to be changed alone.
   *
   * The snapshot is replaced wholesale by the next `context` message, so this
   * only has to hold until then. Guarded because a write can land before the
   * first context arrives, and a card's write must not conjure a snapshot that
   * later reads would treat as the host's.
   * @param variables - the table the host stored.
   */
  const adoptVariables = (variables: Record<string, unknown>): void => {
    if (context !== undefined) context = { ...context, variables }
  }

  /**
   * Scripts parked on a named global, and what they are parked on.
   *
   * Two rules here contradicted each other. The wait is unbounded on purpose —
   * upstream never abandons one — while the module deadline calls any module
   * that has not finished in fifteen seconds stalled. A module *knowingly*
   * waiting has not stalled, and letting the deadline speak over it did two
   * kinds of damage: it reported a healthy park as a failure, and it erased the
   * one state that says what the module is waiting for.
   */
  const activeWaits = new Map<string | undefined, { global: string, since: number }>()

  /**
   * Names a card read before anything published them.
   *
   * **A gap report is a statement about a moment, and the panel shows it as a
   * standing one.** Cross-script coordination is written as a poll — 创世回廊's
   * two scripts read `parent.__辅助计算脚本_loaded__` until the other one sets
   * it — so the *first* read is guaranteed to find nothing, and the note it
   * produces stays on screen after the flag arrives. Read months later it says
   * a capability is missing when it is present.
   *
   * That is the same fault as the storage probe whose sentence became false the
   * moment the façade landed, and it is worth naming as its own shape: **a
   * report whose truth depends on when it was made needs a way to stop being
   * true.** So a publish retracts the note for that name.
   */
  const reportedAbsent = new Set<string>()

  const reportedGaps = new Set<string>()

  /**
   * One report, on the channel its own first sentence names.
   *
   * The panel groups by channel, so the channel is read before the words are:
   * `error` puts a line under "failed" beside the scripts that did not start,
   * and a reader who sees three of those reads them as one causal story. That
   * happened twice. `reportGap`'s own contract said "not an error: the card
   * carries on" while the wiring posted `error` for every message it had — the
   * doc was right and the channel was wrong, which is why nothing caught it.
   *
   * Two names rather than a channel argument, because the choice is a claim
   * about what happened and a name states it at the call site. Deduplication is
   * shared: a message is one or the other, never both.
   */
  const say = (message: string, type: 'note' | 'error'): void => {
    if (reportedGaps.has(message)) return
    reportedGaps.add(message)
    env.post({ iris: env.token, type, scriptId: undefined, message })
  }

  /** A capability that is missing or was degraded — the card carried on. */
  const reportGap = (message: string): void => {
    say(message, 'note')
  }

  /**
   * Publish a name on the card's shared namespace, retracting any gap note.
   *
   * One function for the three routes that publish — the parent proxy's `set`,
   * `initializeGlobal`, and the frame's own seeding — so the retraction cannot
   * be attached to two of them and forgotten on the third.
   * @param name - the published name.
   * @param value - what to publish.
   */
  const publishName = (name: string, value: unknown): void => {
    published.set(name, value)
    if (!reportedAbsent.delete(name)) return
    /*
     * Said once per name, and only when a note actually went out for it. The
     * panel keeps both lines, which is the point: "nothing has published X" and
     * "X has since been published" read as a resolved sequence, while the first
     * alone reads as a standing fault.
     */
    reportGap(
      `parent.${name} has since been published by this frame \u2014 the earlier note about it`
      + ' was true when it was made and is not any more, which is what a poll for another'
      + " script's flag looks like from here",
    )
  }

  /**
   * Something the card asked for that did not happen.
   *
   * The discriminator is not severity but whether the caller got what it asked
   * for: "the buttons were not stored" is a fault even when nothing threw, and
   * "it returned undefined, which is not a statement that the host has no such
   * member" is a note even though a card may die of it three steps later.
   */
  const reportFault = (message: string): void => {
    say(message, 'error')
  }

  /*
   * `localStorage`, which this frame does not have.
   *
   * Built here because it needs the context snapshot and the wire, and installed
   * by the entry because it needs the document. The three writes go through
   * `callAction` like any other card action, so the shell's gate sees them.
   *
   * `characterId` is required by the contract and is attribution, not ownership:
   * the store is one profile-wide store, so the id says who wrote a key last —
   * which is what lets a later `clear()` report whose keys it took. A frame with
   * no character open cannot attribute a write and says so rather than inventing
   * an id.
   */
  const cardStorage = env.members.createCardStorage({
    snapshot: () => context?.storage ?? {},
    write: async (key, value) => {
      const characterId = context?.characterId
      if (characterId === undefined) {
        throw new Error('no character is open, so this write could not be attributed to a card')
      }
      await callAction('storageSet', { characterId, key, value })
    },
    remove: async key => {
      const characterId = context?.characterId
      if (characterId === undefined) {
        throw new Error('no character is open, so this removal could not be attributed to a card')
      }
      await callAction('storageRemove', { characterId, key })
    },
    clear: async () => {
      const characterId = context?.characterId
      if (characterId === undefined) {
        throw new Error('no character is open, so this clear could not be attributed to a card')
      }
      const reply = await callAction('storageClear', { characterId })
      const counts = reply as { removed?: unknown, foreign?: unknown } | undefined
      return {
        removed: typeof counts?.removed === 'number' ? counts.removed : 0,
        foreign: typeof counts?.foreign === 'number' ? counts.foreign : 0,
      }
    },
    /*
     * `reportFault` for a refused write, `reportGap` for the rest, which is the
     * same rule as everywhere else on this surface: did the caller get what it
     * asked for? A `clear()` that worked is a note even though it destroyed
     * data, and a refused `setItem` is a fault even though nothing threw for the
     * user to see.
     */
    report: (message, failed) => {
      if (failed) reportFault(message)
      else reportGap(message)
    },
  })

  const tavernHelper = env.members.createFrameTavernHelper({
    context: () => context,
    scriptId: () => scriptId,
    // The shared surface answers `getCurrentMessageId` too — a fact about the
    // frame, not about which script asks — so the floor rides here as well.
    currentMessageId: () => currentFloor,
    reportGap,
    reportFault,
    call: callAction,
    triggerSlash,
    events,
    adoptVariables,
  })

  /**
   * One script's bound view of the identity-bearing members.
   *
   * Built per script rather than shared, because when a card's scripts occupy
   * one frame a single copy would answer for whichever ran last: the wrong
   * variable partition (which reads as empty) and a teardown reaching a
   * sibling's listeners (which reads as an event that never fired).
   *
   * The shared members are not rebuilt — they have the same answer whoever asks,
   * and `identity.ts` is where that judgment is recorded and guarded.
   * @param forScript - the script this view belongs to.
   * @returns the members that must not be shared.
   */
  /**
   * Upstream's cross-script coordination pair, over the card's shared namespace.
   *
   * `initializeGlobal` publishes and announces; `waitGlobalInitialized` resolves
   * once the name is there. Both are per-script only in that they report which
   * script is waiting — the namespace itself is the card's.
   *
   * The publisher that matters does **not** call `initializeGlobal`: MVU writes
   * `_.set(window.parent, 'Mvu', mvu)` and emits the event itself. So this pair
   * is provided for cards that use it, while the write path stays the thing that
   * actually has to work.
   *
   * The deadline is upstream's: `async-wait-until` gives up after five seconds
   * and the caller swallows it, so a consumer whose provider never arrives
   * carries on rather than hanging forever. What upstream does not do is *say*
   * that it waited, and that silence is the whole reason the frame reports it.
   * @param forScript - who is waiting, for the report.
   * @returns the two members.
   */
  const coordination = (forScript: string | undefined): Record<string, unknown> => ({
    initializeGlobal: (name: unknown, value: unknown): void => {
      const global = requireGlobalName('initializeGlobal', name)
      publishName(global, value)
      void events.eventEmit(`global_${global}_initialized`)
    },
    waitGlobalInitialized: async (name: unknown): Promise<void> => {
      const global = requireGlobalName('waitGlobalInitialized', name)
      /*
       * Waiting is only half of it. Upstream's own description is "等待其他
       * iframe 中共享出来的全局接口初始化完毕, **并使之在当前 iframe 中可用**" —
       * it resolves *and* puts the name in the caller's realm, with
       * `Object.defineProperty(this, global, { get: () => _.get(window, global) })`.
       *
       * A getter rather than a copied value, deliberately: a provider can retract
       * its interface (`_.unset(window.parent, 'Mvu')` on teardown), and a
       * snapshot would leave consumers holding an object the provider has
       * withdrawn.
       *
       * Without this the wait resolves and the very next line still throws
       * `Mvu is not defined`, which is exactly what a real card did: the await
       * succeeded and the bare reference after it did not.
       */
      const makeUsable = (): void => {
        env.defineForwarding?.(global, () => published.get(global))
      }

      if (published.has(global)) {
        makeUsable()
        return
      }
      env.post({ iris: env.token, type: 'waiting', scriptId: forScript, global, elapsedMs: 0 })
      activeWaits.set(forScript, { global, since: Date.now() })
      const started = Date.now()
      await new Promise<void>(resolve => {
        const done = (): void => {
          clearTimeout(notice)
          events.eventRemoveListener(`global_${global}_initialized`, announced)
          resolve()
        }
        const announced = (): void => done()
        /*
         * Says so, and keeps waiting. Upstream is silent about a wait and never
         * abandons one; this frame is unwilling to be silent — a hang is the
         * failure with no voice — but abandoning it was never upstream's
         * behaviour and is not something to invent on upstream's behalf.
         */
        const notice = setTimeout(() => {
          env.post({
            iris: env.token,
            type: 'waiting',
            scriptId: forScript,
            global,
            elapsedMs: Date.now() - started,
          })
        }, WAIT_NOTICE_MS)
        events.eventOn(`global_${global}_initialized`, announced)
        // Re-checked after subscribing: a provider that published between the
        // first check and the subscription would otherwise never be noticed.
        if (published.has(global)) done()
      })
      activeWaits.delete(forScript)
      makeUsable()
      env.post({ iris: env.token, type: 'waited', scriptId: forScript, global, arrived: true })
    },
  })

  /**
   * Scripts whose module body has begun executing.
   *
   * Recorded because it is the one fact that splits a stalled import in two, and
   * it costs nothing to collect: ES module imports are **hoisted**, so every
   * static import of a module has been fetched and evaluated before its first
   * statement runs. The preamble's registry call *is* that first statement.
   *
   * So a body that has begun proves the remote fetch succeeded, and a timeout
   * after that point is a stall inside the imported code rather than in getting
   * hold of it. Without this the two are indistinguishable from outside, and the
   * frame reports the same sentence for both.
   */
  const begun = new Set<string | undefined>()

  const viewFor = (forScript: string | undefined): Record<string, unknown> => {
    begun.add(forScript)
    const bound = env.members.createFrameTavernHelper({
      context: () => context,
      scriptId: () => forScript,
      currentMessageId: () => currentFloor,
      reportGap,
      reportFault,
      call: callAction,
      triggerSlash,
      events,
      adoptVariables,
    })
    // Events come from the scoped wrapper rather than the bound surface: the
    // surface talks to the shared bus directly, which is right for emission and
    // wrong for teardown.
    const scoped = scopedEvents(events, (member, event) => {
      if (typeof event !== 'string' || event.length === 0) {
        throw new UnsupportedApiError(
          `${member}(${String(event)})`,
          'An event name must be a non-empty string. A missing table entry reads as undefined here.',
        )
      }
      return event
    }) as unknown as Record<string, unknown>

    const view: Record<string, unknown> = { ...coordination(forScript) }
    for (const name of identityMembers()) {
      // Only from a surface that actually has it. The coordination pair is
      // identity-bearing *and* built here rather than by the helper, so copying
      // blindly would overwrite both with `undefined` — which is how they first
      // shipped: classified correctly, then clobbered by the loop that acts on
      // the classification.
      if (Object.hasOwn(scoped, name)) view[name] = scoped[name]
      else if (Object.hasOwn(bound, name)) view[name] = bound[name]
    }
    return view
  }

  const core = [
    'window',
    'self',
    'globalThis',
    'parent',
    'top',
    'SillyTavern',
    'extension_settings',
    'triggerSlash',
    'getScriptId',
    /*
     * Bare as well as on `parent`, which is what upstream does with all seven of
     * its borrowed globals — its shim copies them onto the child window, so a
     * card may write either `EjsTemplate` or `window.parent.EjsTemplate`.
     *
     * Added because leaving it off made an instrument lie. `EXPECTED_GLOBALS`
     * drives the missing-library banner, which reads the frame's own window — so
     * with this member reachable only through `parent`, the banner announced
     * `EjsTemplate` among "libraries Iris does not carry", which had just stopped
     * being true. Two ways to stop a report being false: make it accurate, or
     * make the thing it reports on true. Here the second is also the more
     * upstream-faithful, so it is not a wider surface so much as the member
     * finished at both the names upstream offers it under.
     */
    'EjsTemplate',
    /*
     * The same-origin fetch bridge, on the same two routes every bridged
     * global takes: a parameter in classic mode and a published property of
     * the window in module mode — the second is the one imported bundles read,
     * since a bundle's bare `fetch` resolves against the window it runs in.
     * Replacing the name is the point: a bridged request is one CSP would
     * refuse, so no card can observe the difference except by seeing a refused
     * request answer instead.
     */
    'fetch',
    /*
     * The dialog trio, bridged for the same reason `fetch` is: the sandbox's
     * own answer is a silent no-op (`allow-modals` is never granted), which
     * turns a card's chosen failure channel into a swallowed one. Shadowing
     * the names makes `alert` visible in the notice panel and makes `confirm`
     * and `prompt` say — in the same panel — that they answered "cancel".
     */
    'alert',
    'confirm',
    'prompt',
  ] as const

  /**
   * The Tavern Helper names, minus the two the core list already binds.
   *
   * A name may only be bound once — it becomes a function parameter in classic
   * mode — and `triggerSlash` and `getScriptId` appear on both lists because
   * upstream exposes them through both surfaces. The core binding wins, and it
   * is resolved out of `tavernHelper` so that winning changes nothing: this
   * comment used to assert the two were equivalent, and they were not — the
   * core route skipped the detach layer that every other member goes through.
   * An assumption stated in a comment is not a property of the code, and this
   * one was wrong for as long as it was written down.
   */
  const helperNames = Object.keys(tavernHelper).filter(
    name => !(core as readonly string[]).includes(name),
  )

  const shadowed = [...core, ...helperNames]

  /**
   * A shared-surface member, with a word said when it is one that has an owner.
   *
   * [ruling ③] The published globals are **one** surface for the whole frame,
   * and Iris runs a card's scripts together in one. So a member classified
   * `identity` — one whose answer depends on *which* script is asking — cannot be
   * attributed here, and the shared copy answers for whichever script ran last.
   *
   * A card reaching it through the preamble binding gets the right answer; a card
   * writing `window.appendInexistentScriptButtons(...)` explicitly gets this one.
   * **The two spellings look identical in a card**, and answering the second
   * silently by last-run is the shape of "the same call gives different results
   * in different frames".
   *
   * Reported on **call**, never on property access: a card probing with
   * `typeof` must not be charged for asking, which is the rule the whole surface
   * already holds (see the existence-check test).
   * @param name - the member's name.
   * @param value - the shared surface's copy of it.
   * @returns the value, wrapped only when attribution is impossible.
   */
  const sharedCopy = (name: string, value: unknown): unknown => {
    if (typeof value !== 'function' || MEMBER_KINDS[name] !== 'identity') return value
    const wrapper = (...args: unknown[]): unknown => {
      reportGap(
        `card called ${name} through the shared surface, where Iris cannot tell which script is`
          + ` asking — this member is answered per script, and it was handled as`
          + ` ${scriptId ?? 'the body with no script id'}.`
          + ' Reaching it through the script binding instead removes the ambiguity.',
      )
      return (value as (...rest: unknown[]) => unknown)(...args)
    }
    // Not enumerable: `Object.keys` on the surface is a card-visible list.
    Object.defineProperty(wrapper, SHARED_ORIGINAL, { value, enumerable: false })
    return wrapper
  }

  /**
   * Values are resolved per evaluation, not at install.
   *
   * `extension_settings` does not exist until the context arrives, and the
   * context arrives after install. Capturing at install would hand every card a
   * permanent `undefined`.
   */
  const resolveValues = (): unknown[] => [
    windowShadow,
    windowShadow,
    windowShadow,
    virtualParent,
    virtualParent,
    context === undefined ? undefined : sillyTavern,
    extensionSettings,
    /*
     * Read out of `tavernHelper` rather than the two bridge functions above,
     * so a card reaching `triggerSlash` bare and one reaching
     * `parent.TavernHelper.triggerSlash` get the same object. They did not:
     * `helperNames` filters out whatever `core` already binds, so these two
     * names alone skipped the detach layer on the bare route and returned live
     * host values where every sibling returned a clone. Upstream has one
     * function per name, and so should this.
     */
    tavernHelper['triggerSlash'],
    tavernHelper['getScriptId'],
    /*
     * Positional, and that is a hazard worth naming: this array is index-matched
     * to `core`, so a name appended to one list and not the other does not fail
     * loudly — it slides every Tavern Helper binding one place along, handing
     * cards a neighbour's function under the name they asked for. Adding
     * `EjsTemplate` above without this line did exactly that.
     */
    ejsTemplate,
    /*
     * The bridge goes last, appended together with its `core` entry, so no
     * index above had to move for it.
     */
    fetchBridge,
    /*
     * The dialog bridges sit at `core`'s tail — immediately after `fetch` — so
     * their values belong here, before the `helperNames` spread: the zip
     * against `shadowed` is positional, and `core`'s last three names are
     * indexes 11–13 of the bound list, ahead of every Tavern Helper name.
     * Placing them after the spread (where "appended last" would put them)
     * hands `alert` the first helper's function and slides every other binding
     * three places along — the same silent shift the hazard note above
     * describes, which is why this ordering is pinned by a test.
     */
    bridgedDialogs['alert'],
    bridgedDialogs['confirm'],
    bridgedDialogs['prompt'],
    ...helperNames.map(name => sharedCopy(name, tavernHelper[name])),
  ]

  env.onMessage(message => {
    if (message.type === 'viewport') {
      viewport = { width: message.width, height: message.height }
      env.applyViewport?.(viewport)
      return
    }
    if (message.type === 'call:ok' || message.type === 'call:error') {
      const waiting = pendingCall.get(message.id)
      if (waiting === undefined) return
      pendingCall.delete(message.id)
      if (message.type === 'call:ok') waiting.resolve(message.result)
      else waiting.reject(new Error(message.message))
      return
    }
    if (message.type === 'slash:ok' || message.type === 'slash:error') {
      const waiting = pendingSlash.get(message.id)
      if (waiting === undefined) return
      pendingSlash.delete(message.id)
      if (message.type === 'slash:ok') waiting.resolve(message.result)
      // Rejected with a real Error so a card's `.catch` sees what upstream's would.
      else waiting.reject(new Error(message.message))
      return
    }
    if (message.type === 'fetch:ok' || message.type === 'fetch:error') {
      const waiting = pendingFetch.get(message.id)
      if (waiting === undefined) return
      pendingFetch.delete(message.id)
      if (message.type === 'fetch:ok') waiting.resolve(bridgedResponse(message))
      else waiting.reject(new Error(message.message))
      return
    }
    if (message.type === 'event') {
      /*
       * The frame's own `generating` flag rides the same events cards subscribe
       * to, rather than a field on the snapshot. One source for a fact three
       * card-visible things answer from — `#send_but.disabled`,
       * `#mes_stop`'s visibility, `parent.is_send_press` — so they cannot
       * disagree, and no protocol field can go stale against the event stream.
       */
      if (env.members.STARTED_EVENTS.includes(message.event)) generating = true
      else if (env.members.SETTLED_EVENT_NAMES.includes(message.event)) generating = false

      // Not awaited and not reported: a listener that throws is the card's
      // problem with its own handler, and upstream does not tell the host either.
      void events.eventEmit(message.event, ...message.args)
      return
    }
    if (message.type === 'context') {
      // The floor this frame renders in, when the shell said one. A message
      // frame carries it from build; a script frame never receives it, and
      // `getCurrentMessageId` keeps upstream's throw there.
      if (message.floor !== undefined) currentFloor = message.floor
      /*
       * The whole snapshot is replaced — **except the metadata**, which the frame
       * keeps for its own lifetime.
       *
       * `chatMetadata` is the one member whose documented idiom is that the card
       * writes it: upstream has the card mutate the object in place and then call
       * `saveMetadata`, which takes no argument. Upstream can do that because its
       * metadata is the live object in the same realm.
       *
       * Ours is a snapshot, and snapshots are now refreshed on every settled
       * reply and every edit. Replacing this one along with the rest would mean
       * that any reply landing anywhere in the chat, between a card writing a key
       * and calling `saveMetadata`, swaps the object out from under it — and the
       * save then proceeds, reports success, and stores the version without the
       * write. A silently discarded write, on a path the card did nothing wrong
       * on.
       *
       * Keeping the object costs a **stale read**: a metadata change made outside
       * this frame will not reach a card that is already running. That is the
       * lesser harm and the reversible one, and no measured card reads metadata
       * it did not itself write. Recorded in the deviations ledger rather than
       * left as an implementation detail.
       */
      const carried = context?.chatMetadata
      context = carried === undefined
        ? message.context
        : { ...message.context, chatMetadata: carried }
      /*
       * Before anything can read the chat, and on **every** snapshot.
       *
       * The floor tables cross the wire as JSON text, and a card reading
       * `chat[i].variables[swipe_id]` directly would get one character of that
       * string — which is what MVU's restore guard reads, and it is false
       * forever without a word said. This installs the per-row getters that
       * hide the encoding; it parses nothing until a row is actually read.
       *
       * Per snapshot rather than once, because each snapshot brings new row
       * objects. The report goes on the note channel through `reportGap`: a
       * floor that cannot be parsed is a transport fault, and this is the only
       * place that would ever notice it.
       */
      env.members.restoreFloorTables(context.chat, (text, failed) => {
        if (failed) reportFault(text)
        else reportGap(text)
      })
      extensionSettings = settingsProxy({ ...message.context.extensionSettings })
      /*
       * An interface frame published its surface at install, when neither of
       * these had an answer — the install-time `resolveValues()` handed
       * `undefined` for both, and `defineProperty` froze that answer onto the
       * window. Every card idiom of the shape
       * `if (window.parent.SillyTavern) …` has a bare-spelling twin, and the
       * bare spelling in interface markup read **absent forever** — the answer
       * "the host is not SillyTavern", which is the plugin-detection failure
       * this frame exists not to cause. So the two names are published again
       * now that they have one, on the same channel and with the same
       * per-snapshot semantics the run path already has: `resolveValues()` is
       * re-read per evaluation there, and this is the interface frame's
       * evaluation. `parent.SillyTavern` answers live (line ~942); from this
       * moment the bare spelling and it agree.
       */
      if (env.interfaceFrame === true) {
        env.publishGlobals?.([
          ['SillyTavern', sillyTavern],
          ['extension_settings', extensionSettings],
          /*
           * The Tavern Helper surface, published **bare**.
           *
           * Upstream injects this same surface into every message iframe as
           * plain globals — a message frame's own inline script reaches
           * `setChatMessages(...)` or `triggerSlash(...)` bare, without the
           * `parent.` prefix a card *script* needs. An interface frame that
           * kept these namespaced-only answered every bare spelling with a
           * ReferenceError inside the card's own try/catch: the measured card's
           * start button clicked, ran, and did nothing, and its guard
           * (`typeof triggerSlash === 'function'`) silently skipped the second
           * half of its work.
           *
           * These are the same objects `parent.TavernHelper.*` already hands
           * out — this publish adds the spellings, not a second surface.
           */
          ...Object.entries(tavernHelper).map(
            ([name, value]) => [name, value] as [string, unknown],
          ),
        ])
      }
      return
    }
    if (message.type !== 'run') return

    // Before `resolveValues`, which closes over it. Set once: see `scriptId`.
    if (!scriptIdFixed) {
      scriptIdFixed = true
      scriptId = message.scriptId
    }
    env.listScript?.(message.scriptId)

    const values = resolveValues()

    const failingScript = message.scriptId
    const failed = (error: unknown): void => {
      // A refusal and a bug in the card both land here, and the shell shows them
      // differently: `member` is what tells them apart.
      const member = error instanceof UnsupportedApiError ? error.member : undefined
      /*
       * The message **and** where it was thrown.
       *
       * `error.stack` used to be dropped here. That is survivable for a message
       * naming its own cause and useless for one that does not — a card whose
       * first line dies on `localStorage` reported "Failed to read the
       * 'localStorage' property from 'Window'" with no location, and a census
       * predicting which cards survive an unavailable `localStorage` had nothing
       * to check itself against.
       *
       * Not appended for a refusal: `UnsupportedApiError` is raised by this
       * frame, so its top stack frame is our own code and naming it would point
       * a reader at the bridge for a decision the bridge made on purpose.
       */
      const text = error instanceof Error
        ? `${error.message}${member === undefined ? topFrame(error) : ''}`
        : String(error)
      /*
       * A stalled import has two very different causes and one sentence, so the
       * sentence is split here by the only evidence that separates them.
       *
       * Imports are hoisted: if the body ran at all, every static import had
       * already been fetched and evaluated. So a timeout with the body begun is
       * the imported module hanging on its own — a top-level await that never
       * settles, say — while a timeout with no body means the fetch itself never
       * came back.
       */
      /*
       * A module that is knowingly waiting is not reported as stalled.
       *
       * The deadline cannot know this: it lives in the entry and sees only that
       * evaluation has not finished. This does. Re-announcing the wait rather
       * than falling silent keeps the panel showing *what* it waits on — the
       * deadline's sentence used to overwrite exactly that, which is why two
       * verification rounds could not tell a woken waiter from one that never ran.
       */
      const parked = activeWaits.get(failingScript)
      const overdue = text.includes('still evaluating after') || text.includes('import timed out')
      if (parked !== undefined && overdue) {
        env.post({
          iris: env.token,
          type: 'waiting',
          scriptId: failingScript,
          global: parked.global,
          elapsedMs: Date.now() - parked.since,
        })
        return
      }

      const stalled = text.includes('import timed out')
      const detail = !stalled
        ? text
        : begun.has(failingScript)
          ? `${text} — the body had begun, so the imported module is stalling on its own, not the fetch`
          : `${text} — the body never began, so this is the fetch itself`
      env.post({
        iris: env.token,
        type: 'error',
        message: detail,
        ...(member === undefined ? {} : { member }),
        // Whose failure this was. One frame runs a card's whole set, so an
        // unattributed outcome would land on whichever script the shell was
        // tracking rather than the one that failed.
        scriptId: failingScript,
      })
    }

    try {
      // Inside the reporting try/catch, and that placement is the point: it used
      // to sit above it, so when publishing the bridge threw, the exception
      // escaped the handler and the frame went silent for the rest of its life —
      // no body, no error, nothing. Anything between receiving `run` and finishing
      // the body has to be able to say that it failed.
      //
      // Published before evaluation in both modes, because a module has no other
      // way to see these and a classic body loses nothing by having both routes.
      env.publishGlobals?.([
        ...shadowed.map((name, at) => [name, values[at]] as [string, unknown]).filter(
          // The window aliases are not ours to redefine and would be circular
          // anyway; `parent`/`top` are attempted because whether they can be
          // redefined is a browser question the frame answers empirically.
          ([name]) => name !== 'window' && name !== 'self' && name !== 'globalThis',
        ),
        /*
         * The registry each co-located script reads its own bindings from.
         *
         * Published here rather than at install for the reason the comment above
         * records: everything between receiving `run` and finishing the body has
         * to be able to report that it failed, and a publish that threw outside
         * this block once silenced a frame for its whole life.
         *
         * Not concealed. Within one card the scripts share a realm and can
         * already reach each other, so hiding it would buy no isolation the realm
         * has not already given away.
         */
        [SCRIPT_REGISTRY, (id: unknown) => viewFor(typeof id === 'string' ? id : undefined)],
        /*
         * The shadowed window, for the preamble's `const window`.
         *
         * A module cannot be handed the shadow as a parameter and `top` cannot
         * be published onto the real window (see the filter above — the browser
         * refuses it), so the shadow rides its own published name and the
         * preamble's one lexical line binds it. Published before evaluation, as
         * everything else here is, so the binding is never `undefined`.
         */
        [WINDOW_GLOBAL, windowShadow],
        /*
         * The coordination pair, published **bare** alongside everything else.
         *
         * A card's scripts reach these through the preamble's per-script
         * bindings, so they were the one member group a script frame's window
         * lacked — and the corpus puts interface markup *inside script frames*:
         * 神隐挑战's overlay renders its own Vue app into this frame's body,
         * and that app's inline code opens with
         * `typeof waitGlobalInitialized === 'undefined'` before it will connect.
         * Upstream has no such hole: `predefine.js` carries the same member set
         * into every iframe, so any `<script>` anywhere in a frame reads the
         * pair as a bare global. Bound to no script, for the same reason the
         * interface install below binds its copy to none — the id only says who
         * is waiting, and inline markup genuinely is nobody; a card script that
         * wants its own id on the report keeps using the preamble binding.
         */
        ...Object.entries(coordination(undefined)),
      ])

      /*
       * Before the check below, not after, and the order is the point: this
       * makes `toastr` present, so the missing-libraries banner must run
       * afterwards or it would name a global the frame is about to have. A
       * banner that lists something we provide sends a reader looking for a gap
       * that is not there — the same class of error as omitting one we do not.
       */
      /*
       * Storage before the libraries, and before the body.
       *
       * pinia pulls in `@vue/devtools-kit`, which decides whether it has storage
       * with `typeof localStorage > 'u'` — and on an opaque origin *that read
       * itself throws*. So the shadow has to be in place before the preset's
       * modules evaluate, not merely before the card's own code.
       */
      env.provideStorage?.(cardStorage)

      // `say`, not `reportGap`: a card's own `toastr.error` is the card’s claim
      // that something failed, and its `toastr.success` is not.
      env.provideToastr?.(say)

      // Which of upstream's seeded globals this frame does NOT have. Reported
      // rather than waited for: without it, each missing library costs a full
      // round trip to discover, one crash at a time, and the crash names the
      // symptom rather than the gap.
      env.reportMissingGlobals?.(EXPECTED_GLOBALS)

      /*
       * Last, so the check sees everything every earlier script published, and
       * before the body, so a script that reads the bare name on its first line
       * finds it. See `predefineShared`.
       */
      predefineShared()

      /*
       * The preamble goes on in module mode only.
       *
       * A classic body is handed its bindings as function parameters, which
       * already gives it a per-run scope; a module has no parameters, so its
       * per-script bindings have to arrive as source. One line, so a card
       * author's reported line numbers are off by a constant they can be told.
       */
      const source =
        message.mode === 'module' ? withPreamble(message.scriptId, message.code) : message.code
      const running = env.evaluate(source, message.mode, shadowed, values, message.scriptId)
      if (running instanceof Promise) {
        // A module loads asynchronously, so `ran` cannot be posted on the next
        // line. The distinction matters for what `ran` means: the body finished
        // evaluating, not the card finished working.
        void running.then(
          () => env.post({ iris: env.token, type: 'ran', scriptId: failingScript }),
          (error: unknown) => failed(error),
        )
      } else {
        env.post({ iris: env.token, type: 'ran', scriptId: failingScript })
      }
    } catch (error: unknown) {
      failed(error)
    }
  })

  /*
   * An interface frame is served at install, because nothing will ask it to run.
   *
   * The same names, from the same `resolveValues()`, so the two kinds cannot
   * drift into different surfaces — which is the failure this replaced, in the
   * strongest possible form: one of them had no surface at all.
   *
   * Three things are deliberately **not** published here:
   *
   * - `SCRIPT_REGISTRY`, because there are no co-located scripts to distinguish.
   *   The identity-bearing members answer through the shared surface and report
   *   the ambiguity, which is the honest answer for a frame that genuinely has
   *   no script identity, rather than a registry that would hand out bindings
   *   for an id nobody holds.
   * - a preamble, for the same reason — there is no per-script binding to
   *   destructure.
   * - `ran`, since no body was evaluated. A frame that announced it had run
   *   would make the panel's script accounting count a frame with no scripts.
   *
   * Ordering: this runs before any `context` message can arrive, so the surface
   * exists before the data does — and that is upstream's order too. Members that
   * read the snapshot report an absent one by name; a card's markup that reaches
   * for data this early gets a named gap instead of a `ReferenceError` about the
   * member.
   */
  if (env.interfaceFrame === true) {
    try {
      const values = resolveValues()
      /*
       * Built once and published twice — see the entry below for why it exists
       * and what it is.
       */
      const mvu = {
        events: MVU_EVENTS,
        getMvuData: tavernHelper['getVariables'],
        replaceMvuData: tavernHelper['replaceVariables'],
      }
      env.publishGlobals?.([
        ...shadowed
          .map((name, at) => [name, values[at]] as [string, unknown])
          .filter(([name]) => name !== 'window' && name !== 'self' && name !== 'globalThis'),
        /*
         * The coordination pair, appended rather than added to `core`.
         *
         * `core` is index-matched to `resolveValues()`, and the comment there
         * says what happens to a name added to one list and not the other: every
         * Tavern Helper binding slides one place along and cards get a
         * neighbour's function under the name they asked for. So these two go on
         * as their own entries, where no index has to agree with anything.
         *
         * They reach a *script* frame's card through the per-script registry,
         * which the module preamble destructures — a route an interface frame
         * has no equivalent of, since there is no script and no preamble. Yet 44
         * measured `waitGlobalInitialized` in 6 interface-side cards, and it is
         * how a card tolerates a provider that is merely **late**: 7 of the 10
         * cards reading `Mvu` wait on it rather than reading it once. Without
         * this pair, those cards do not read the wrong thing — they never get to
         * read at all.
         *
         * Bound to no script, which is honest rather than convenient: the pair
         * uses its script id only to say who is waiting, and an interface frame
         * genuinely is nobody.
         */
        ...Object.entries(coordination(undefined)),
        /*
         * `Mvu`, as an interface frame can actually have it.
         *
         * Upstream, a card's MVU bundle runs in a *script* iframe and publishes
         * itself onto the **shared host page** (`_.set(window.parent, 'Mvu', …)`
         * — and the script iframe's parent is the page). An interface iframe
         * reaches the same object two ways, both measured in upstream's own
         * injection: `predefine.js` defines `window.Mvu` as a live getter to
         * `_.get(window.parent, 'Mvu')` ("只是为了兼容性"), and
         * `waitGlobalInitialized('Mvu')` hears the bundle's
         * `global_Mvu_initialized` through the page's event source. Either way
         * the interface frame ends up holding the bundle's methods and constants.
         *
         * None of that crosses an opaque origin. Each Iris frame has its own
         * virtual parent and its own event bus, so the bundle's publication stays
         * in the script frame and an interface frame's
         * `await waitGlobalInitialized('Mvu')` waited forever — three measured
         * status-bar interfaces (尸变纪元, 绿茵好莱坞, 哈人冰恋世界) draw their
         * panels only after that await, so they rendered their frames and never
         * populated a single number.
         *
         * A live object cannot cross the wall at all, so this is not the bundle —
         * it is the surface the bundle itself delegates to, built on **this
         * frame's own** Tavern Helper. Measured in the published bundle:
         * `getMvuData` is `function(e){return getVariables(e)}` and
         * `replaceMvuData` is `function(e,t){return replaceVariables(e,t)}` —
         * thin renames of the very members this frame already has, with this
         * frame's floor-anchored semantics, which is exactly what an interface
         * reading its own floor wants. `events` is the same constant table
         * (`mag_variable_update_ended` and friends) Iris already carries for the
         * event guard. A status bar that *displays* therefore works fully; the
         * bundle's schema-driven update machinery stays where it runs, in the
         * script frame.
         *
         * Published into **both** bags: `publishGlobals` for the bare name the
         * markup reads, `publishName` for the virtual parent whose
         * `waitGlobalInitialized` polls it — the wait resolves the moment the
         * frame comes up, which is upstream's shape too, since the page-side
         * getter exists whether or not the bundle got there first.
         *
         * A card (or a future Iris change) publishing a real `Mvu` over this
         * simply replaces the bag entry; nothing here is privileged.
         */
        [
          'Mvu',
          mvu,
        ],
      ])
      // The virtual-parent half, so `waitGlobalInitialized('Mvu')` — which polls
      // that bag, not the window — resolves instead of waiting on a publication
      // that, in this frame, has no other route to happen.
      publishName('Mvu', mvu)
      env.provideStorage?.(cardStorage)
      env.provideToastr?.(say)
      env.reportMissingGlobals?.(EXPECTED_GLOBALS)
    } catch (error: unknown) {
      /*
       * Reported, never thrown. There is no `run` message to attribute this to
       * and no card body to fail, so an exception here would escape into the
       * bootstrap and leave the frame silent for the rest of its life — the
       * exact failure the run path's try/catch was moved to cover.
       */
      reportFault(
        'Iris could not publish the Tavern Helper surface into this interface frame: '
        + (error instanceof Error ? error.message : String(error))
        + ' — the card\u2019s markup will see bare names as undefined',
      )
    }
  }

  // Readiness is announced by the entry, not here: it depends on the frame's
  // subresources having settled, and this module deliberately knows nothing about
  // the document it is installed into.

  return { shadowed, viewport: readViewport }
}
