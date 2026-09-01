/**
 * The browser's copy of what the host knows.
 *
 * One rule shapes this file: **the host authors chat state, and this store only
 * ever holds a projection of it.** So `stream.end` replaces the view wholesale
 * instead of being reconciled into it, and optimistic state lives in one
 * narrow, clearly-named place (`stream`) that is thrown away the moment the
 * settled view arrives. The protocol asks for exactly this, and the reason is
 * that a delta can be missed — a reconnect, a second page on the same chat —
 * while a settled view cannot be wrong.
 *
 * @module iris-web/client/store
 */

import { createStore, type StoreApi } from 'zustand/vanilla'

import type {
  CharacterSummary,
  ChatSummary,
  ChatView,
  ConnectionProfile,
  GenerationSettings,
  IrisClient,
  IrisEvent,
  ScriptContext,
  ScriptView,
} from '@iris/protocol'

import { asRpcError, describeError, isHostError } from './errors.ts'
import { wireMethodFor } from '../sandbox/card-api.ts'
import { consentState, type ConsentState } from '../sandbox/consent.ts'
import type { ScriptRunState } from '../sandbox/script-run-state.ts'

/** A prompt breakdown, or why there is not one. */
export type ItemizationResult =
  | { ok: true, itemization: import('@iris/protocol').PromptItemization }
  | { ok: false, error: import('@iris/protocol').RpcError }

/** A script body, or why there is not one. */
export type ScriptBodyResult =
  | { ok: true, content: string }
  | { ok: false, error: import('@iris/protocol').RpcError }

/** Text arriving for a turn that has not settled yet. */
export interface StreamBuffer {
  turn: number
  text: string
  reasoning: string
  /**
   * Identity the host gave the row this text belongs to.
   *
   * Absent only when deltas arrived without their opening frame — a reconnect
   * mid-generation — where the settled view fetched by the reopen already
   * carries the row, and its own key is used instead.
   */
  key?: string
}

/** A transient message shown to the reader. */
export interface Notice {
  kind: 'error' | 'info'
  text: string
  /** Bumped per notice, so a repeat of the same text still re-announces. */
  seq: number
}

/** Everything the interface renders from. */
/**
 * One line the panel keeps about a card, and the run it came from.
 *
 * The generation is what stops three runs' worth of findings from reading as
 * one present-tense list.
 */
export interface CardReport {
  text: string
  generation: number
  /** Which script it was about, so a corrected verdict can be found again. */
  scriptId?: string
  /**
   * Set when later evidence refuted this report.
   *
   * Marked rather than deleted. The frame really did say it, and the fact that
   * a module took long enough to be declared dead is worth keeping even once it
   * arrives — but left unmarked it makes the panel mourn a card that works.
   */
  withdrawn?: boolean
}

export interface IrisState {
  connected: boolean
  chats: ChatSummary[]
  characters: CharacterSummary[]
  /** The open conversation, or undefined on the empty surface. */
  chatId: string | undefined
  view: ChatView | undefined
  /** Present exactly while the open chat is generating. */
  stream: StreamBuffer | undefined
  /** Sampling in force for the open chat, or the global defaults. */
  settings: GenerationSettings | undefined
  notice: Notice | undefined
  /** True during the first load, so the shell can hold its layout still. */
  booting: boolean
  /**
   * Which transport the page is actually running on, and where its data comes
   * from.
   *
   * In the store because the interface has to be able to say it. A page that
   * cannot report whether its data is real is a page whose observers will
   * eventually check two true things and conclude a false one — which is exactly
   * what happened before this field existed.
   */
  transport: 'rpc' | 'fake'
  dataOrigin: string

  /**
   * Card scripts of the open chat's character.
   *
   * Held against the character rather than the chat, because that is what the
   * grant is stored against — two chats with the same card share one decision,
   * and showing it per chat would imply otherwise.
   */
  scripts: ScriptView[]
  /** Which character `scripts` describes, so a stale list is never shown. */
  scriptsFor: string | undefined
  /** Whether that character's scripts may touch the real page. */
  documentGranted: boolean
  /**
   * Whether the user has answered the run-scripts question for this card.
   *
   * Three states, and the absent one is not a decline — see `sandbox/consent.ts`
   * for why that distinction is the feature rather than a nicety.
   */
  scriptsAllowed: ConsentState
  /**
   * Frame-level reports for this card, kept until the card changes.
   *
   * The notice bar cannot hold these. It is one slot that clears itself after
   * eight seconds, so a burst of startup reports overwrites itself and the
   * survivor is gone before anyone looks — which is how a verification round
   * concluded the warnings were never emitted when in fact they had all arrived
   * and been destroyed by the channel carrying them.
   *
   * Deduplicated and durable: a diagnostic that cannot be read when someone
   * finally looks is a diagnostic that does not exist.
   */
  cardReports: CardReport[]
  /**
   * Which run the panel is currently showing.
   *
   * Reports outlive the run that produced them on purpose — a diagnostic nobody
   * can read when they finally look is a diagnostic that does not exist — but
   * durability without a generation made the panel unreadable in a different
   * way: relics of three different runs hung side by side, all of them phrased
   * in the present tense, and telling them apart meant remembering what had
   * been tried when. One reading showed "the provider import timed out" beside
   * an error that could only have come from a run where that same import
   * *succeeded*.
   *
   * Clearing on card change was not enough, because re-running the same card is
   * the common case during verification.
   */
  cardRunGeneration: number
  /** What each of this card's scripts is doing, once they start on their own. */
  runStates: ScriptRunState[]

  /** Saved connection profiles, and which one was last activated. */
  connections: ConnectionProfile[]
  activeConnectionId: string | undefined
}

/** What the interface calls. Every one of these is a host round trip. */
export interface IrisActions {
  boot(): Promise<void>
  openChat(chatId: string): Promise<void>
  closeChat(): void
  createChat(characterId: string): Promise<void>
  deleteChat(chatId: string): Promise<void>
  renameChat(chatId: string, title: string): Promise<void>
  send(text: string): Promise<void>
  regenerate(): Promise<void>
  abort(): Promise<void>
  swipe(turn: number, index: number): Promise<void>
  editMessage(id: number, text: string): Promise<void>
  deleteMessage(id: number): Promise<void>
  importCard(filename: string, base64: string): Promise<void>
  deleteCharacter(characterId: string): Promise<void>
  patchSettings(patch: Record<string, unknown>): Promise<void>
  loadScripts(characterId: string): Promise<void>
  setScriptEnabled(scriptId: string, enabled: boolean): Promise<void>
  /**
   * Record the user's answer to the run-scripts question.
   *
   * A decline is stored, never cleared: clearing it would read back as "never
   * asked" and put the question again on the next chat they open, which is how a
   * permission prompt becomes something people dismiss without reading.
   */
  answerScriptsAllowed(allowed: boolean): Promise<void>
  /** Record a frame-level report for this card, once. */
  beginCardRun(): void
  addCardReport(text: string, scriptId?: string): void
  withdrawReportsFor(scriptId: string): void
  /** Replace what the running scripts are reported to be doing. */
  setRunStates(states: readonly ScriptRunState[]): void
  /**
   * The card's scripts and grants, straight from the host.
   *
   * Separate from `loadScripts` and deliberately uncached: that one fills the
   * panel and returns early when it already holds the character, which is right
   * for a panel and wrong for starting code. Character ids are reused when a card
   * is deleted, so a cached answer can belong to a card that no longer exists —
   * and the auto-run path has nobody watching to notice.
   */
  resolveScripts(characterId: string): Promise<{ scripts: ScriptView[], documentGranted: boolean }>
  /** Fetch a card's remote dependency through the host, which owns the allowlist. */
  fetchScriptDependency(url: string): Promise<string>
  setDocumentGrant(granted: boolean): Promise<void>
  /**
   * The host's snapshot for one chat, or undefined when the host will not give
   * one.
   *
   * Returned rather than stored: it is a per-run payload for a frame, not shell
   * state, and keeping it in the store would mean holding a whole conversation's
   * worth of card-visible data long after the run that needed it.
   */
  scriptContext(chatId: string, characterId: string): Promise<ScriptContext | undefined>
  /**
   * One script's body, or undefined when the host will not give one.
   *
   * Returned rather than stored for the same reason as the context, and more
   * so: a body can be megabytes of webpack output, and the shell has no use for
   * it once the frame has it.
   */
  scriptBody(characterId: string, scriptId: string): Promise<ScriptBodyResult>
  /**
   * How a request assembles: a record of one already sent, or a preview of the
   * next.
   *
   * Returned rather than stored, like the other two per-request payloads. A
   * breakdown is a few dozen rows about one moment; keeping it in shell state
   * would mean holding a stale answer that looks current.
   */
  itemize(turn?: number): Promise<ItemizationResult>
  /**
   * Run a slash command a card invoked.
   *
   * The string is passed through untouched. Splitting it needs upstream's escape
   * rule, which lives host-side; a second copy in the browser would agree in
   * every test and disagree the first time a user types a `|`.
   */
  runSlash(command: string): Promise<string>
  /**
   * Perform one card action.
   *
   * The allowlist is checked here, on the trusted side. The frame shapes its
   * facade from the same list, but that is convenience — a card reaching the
   * shell with a name that is not on it is refused regardless of what the frame
   * thought it was offering.
   */
  runCardAction(method: string, params: unknown): Promise<unknown>
  loadConnections(): Promise<void>
  activateConnection(id: string): Promise<void>
  saveConnection(patch: {
    id?: string
    label?: string
    provider: string
    model: string
    preset?: string
    sampling?: Record<string, unknown>
  }): Promise<void>
  deleteConnection(id: string): Promise<void>
  notify(kind: Notice['kind'], text: string): void
  dismissNotice(): void
}

/** The store the whole interface reads. */
export type IrisStore = StoreApi<IrisState & IrisActions>

/**
 * Build the store and wire it to a client.
 *
 * @param client - the transport, real or fake. The interface never sees which.
 * @returns the store and a disposer that drops the event subscription. The
 * disposer matters because the store is created inside a Cordis plugin, and a
 * plugin that leaves a listener behind is precisely the failure Iris exists to
 * avoid.
 */
export function createIrisStore(
  client: IrisClient,
  /**
   * Which transport this store is fed by, and where its data comes from.
   *
   * Required, with no default. A default here would be a hidden decision, and the
   * failure it hides is worse than the one the disclosure was built to prevent: a
   * caller that forgot the argument would get a page announcing "seeded data"
   * while talking to a real host, or the reverse. Either way the reader is told a
   * confident falsehood about the one thing they cannot otherwise check, and the
   * blame lands on the disclosure rather than on the missing argument.
   */
  source: { transport: 'rpc' | 'fake', origin: string },
): { store: IrisStore, dispose: () => void } {
  let noticeSeq = 0

  const store: IrisStore = createStore<IrisState & IrisActions>((set, get) => {
    /**
     * Run a host call, turning a refusal into a notice rather than a crash.
     *
     * The sentence above describes one of the two things this catches. The other
     * is a bug in the guarded callback itself, which arrives as a plain `Error`,
     * gets relabelled `internal` — a code the host also uses — and then reads to
     * the user as the host having answered. Same notice, opposite origin, and
     * the reader is sent to the wrong side.
     *
     * The distinction is available right here and was being discarded, so it is
     * kept: a fault of ours says it is ours.
     */
    const guard = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error: unknown) {
        noticeSeq += 1
        const text = isHostError(error)
          ? describeError(error)
          : `Iris hit a problem of its own: ${describeError(error)}`
        set({ notice: { kind: 'error', text, seq: noticeSeq } })
      }
    }

    return {
      connected: client.connected,
      chats: [],
      characters: [],
      chatId: undefined,
      view: undefined,
      stream: undefined,
      settings: undefined,
      notice: undefined,
      booting: true,
      transport: source.transport,
      dataOrigin: source.origin,
      scripts: [],
      scriptsFor: undefined,
      scriptsAllowed: 'unknown',
      cardReports: [],
      cardRunGeneration: 0,
      runStates: [],
      documentGranted: false,
      connections: [],
      activeConnectionId: undefined,

      async boot(): Promise<void> {
        await guard(async () => {
          const [chats, characters, settings] = await Promise.all([
            client.call('chat.list', {}),
            client.call('character.list', {}),
            client.call('settings.get', {}),
          ])
          set({
            chats: chats.chats,
            characters: characters.characters,
            settings: settings.settings,
            connected: client.connected,
          })
          // Open the most recent conversation rather than an empty surface. This
          // is a reading app: the reader almost always wants to continue.
          const first = chats.chats[0]
          if (first !== undefined) await get().openChat(first.chatId)
        })
        set({ booting: false })
      },

      async openChat(chatId: string): Promise<void> {
        // Clear the previous chat's stream buffer before awaiting: leaving it in
        // place would paint one chat's in-flight text under another's title.
        set({ chatId, view: undefined, stream: undefined })
        await guard(async () => {
          const [opened, settings] = await Promise.all([
            client.call('chat.open', { chatId }),
            client.call('settings.get', { chatId }),
          ])
          // A second open may have started while this one was in flight.
          if (get().chatId !== chatId) return
          set({ view: opened.view, settings: settings.settings })
        })
      },

      closeChat(): void {
        set({ chatId: undefined, view: undefined, stream: undefined })
      },

      async createChat(characterId: string): Promise<void> {
        await guard(async () => {
          const { view } = await client.call('chat.create', { characterId })
          set({ chatId: view.chatId, view, stream: undefined })
        })
      },

      async deleteChat(chatId: string): Promise<void> {
        await guard(async () => {
          await client.call('chat.delete', { chatId })
          if (get().chatId !== chatId) return
          const next = get().chats.find(row => row.chatId !== chatId)
          if (next === undefined) get().closeChat()
          else await get().openChat(next.chatId)
        })
      },

      async renameChat(chatId: string, title: string): Promise<void> {
        await guard(async () => {
          const { chats } = await client.call('chat.rename', { chatId, title })
          set({ chats })
          const view = get().view
          if (view !== undefined && view.chatId === chatId) set({ view: { ...view, title } })
        })
      },

      async send(text: string): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.send', { chatId, text })
        })
      },

      async regenerate(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.regenerate', { chatId })
        })
      },

      async abort(): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          await client.call('chat.abort', { chatId })
        })
      },

      async swipe(turn: number, index: number): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.swipe', { chatId, turn, index })
          if (get().chatId === chatId) set({ view })
        })
      },

      async editMessage(id: number, text: string): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.editMessage', { chatId, id, text })
          if (get().chatId === chatId) set({ view })
        })
      },

      async deleteMessage(id: number): Promise<void> {
        const chatId = get().chatId
        if (chatId === undefined) return
        await guard(async () => {
          const { view } = await client.call('chat.deleteMessage', { chatId, id })
          if (get().chatId === chatId) set({ view })
        })
      },

      async importCard(filename: string, base64: string): Promise<void> {
        await guard(async () => {
          const { character } = await client.call('character.import', { filename, content: base64 })
          const { characters } = await client.call('character.list', {})
          noticeSeq += 1
          set({
            characters,
            notice: { kind: 'info', text: `Imported ${character.name}.`, seq: noticeSeq },
          })
        })
      },

      async deleteCharacter(characterId: string): Promise<void> {
        await guard(async () => {
          await client.call('character.delete', { characterId })
          const { characters } = await client.call('character.list', {})
          /*
           * Drop the cached script list if it belonged to the card just deleted.
           *
           * Deletion is the one moment a character *id* can change owner — but it
           * is not the only moment a permission loses its subject. The panel
           * moving to a different card does the same thing and does it dozens of
           * times a day; the probe's network grant had exactly that bug. The rule
           * is about the subject, not about deletion: re-anchor a permission
           * whenever what it was granted to stops being what is in front of you.
           *
           * The host
           * mints ids with `uniqueId(toId(name), existing)` against the cards that
           * currently exist, so deleting "Aria" frees `aria` and the next card of
           * that name is handed the same id. `loadScripts` returns early when
           * `scriptsFor` already matches — so without this, opening the *new*
           * Aria would skip the round trip and show the old one's scripts and,
           * worse, its `documentGranted`.
           *
           * That would also defeat the host's own fix: it now forgets a deleted
           * card's grant, and this cache would answer `true` without ever asking.
           * Two green halves that leak when composed — the host is right and stays
           * right, because the question never reaches it.
           *
           * The two fields go for different reasons, and the difference is the
           * rule worth carrying: **content rebinds by name, permissions never.**
           * `scripts` is content — the new card has its own, so this is ordinary
           * cache invalidation, and the chats deliberately survive for the same
           * reason (reimporting a card to carry on playing is what a user means
           * to do). `documentGranted` is a permission, and the user granted it to
           * a card that no longer exists. Any per-character state added here has
           * to answer which of the two it is before it is cached.
           */
          const stale = get().scriptsFor === characterId
          set({
            characters,
            ...(stale
              ? {
                  scripts: [],
                  scriptsFor: undefined,
                  documentGranted: false,
                  // `unasked`, not `declined`. Inheriting a decline is the worst
                  // of the three: the new card is never offered its scripts and
                  // nothing reports why.
                  scriptsAllowed: 'unknown' as ConsentState,
                  runStates: [],
                  cardReports: [],
                }
              : {}),
          })
        })
      },

      async patchSettings(patch: Record<string, unknown>): Promise<void> {
        const chatId = get().chatId
        await guard(async () => {
          // Scoped to the open chat when there is one: a reader adjusting
          // temperature mid-scene means "for this scene", not "for everything".
          const { settings } = await client.call('settings.set', {
            ...(chatId === undefined ? {} : { chatId }),
            settings: patch,
          })
          set({ settings })
        })
      },

      async loadScripts(characterId: string): Promise<void> {
        if (get().scriptsFor === characterId) return
        // Cleared first: the previous card's scripts must not sit under the new
        // card's name for the length of a round trip, because the one thing this
        // panel exists to answer is "what does THIS card run".
        set({
          scripts: [],
          scriptsFor: characterId,
          documentGranted: false,
          // `unknown` until the host answers. `unasked` here would put the
          // question during the round trip — including to a user whose answer is
          // already stored and about to arrive.
          scriptsAllowed: 'unknown',
          runStates: [],
          cardReports: [],
        })
        await guard(async () => {
          const listed = await client.call('script.list', { characterId })
          if (get().scriptsFor !== characterId) return
          set({
            scripts: listed.scripts,
            documentGranted: listed.documentGranted,
            // Read through `consentState`, never `?? false`: the field is absent
            // when nobody has been asked, and folding that into a decline means
            // the question is never put and scripts never start, silently.
            scriptsAllowed: consentState(listed),
          })
        })
      },

      async answerScriptsAllowed(allowed: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const { scriptsAllowed } = await client.call('script.setScriptsAllowed', {
            characterId,
            allowed,
          })
          // Guarded on the card still being the one in front of the user: the
          // answer belongs to the card it was given about, and an await is long
          // enough to change cards.
          if (get().scriptsFor === characterId) {
            set({ scriptsAllowed: scriptsAllowed ? 'allowed' : 'declined' })
          }
        })
      },

      beginCardRun(): void {
        // Monotonic rather than reset per card: two runs must never share a
        // number, and a card's reports are cleared on switch anyway. A counter
        // that restarted could make a stale entry look current again.
        set({ cardRunGeneration: get().cardRunGeneration + 1 })
      },

      addCardReport(text: string, scriptId?: string): void {
        const generation = get().cardRunGeneration
        const seen = get().cardReports

        /*
         * One entry per fact, re-dated when the fact recurs.
         *
         * Two things had to be true at once. A card polling a missing slot must
         * not fill the panel with one fact — that is the notice bar again. But
         * the same fact arising in a *new* run is news: it means the thing was
         * not fixed, and suppressing it as a duplicate would leave the panel
         * showing it stamped with a run that has long since ended.
         *
         * So the text stays unique and its generation moves forward. Position
         * is deliberately not moved: a list that reorders itself while someone
         * is reading it is harder to follow than one that does not.
         */
        const at = seen.findIndex(report => report.text === text)
        if (at === -1) {
          set({ cardReports: [...seen, { text, generation, ...(scriptId === undefined ? {} : { scriptId }) }] })
          return
        }
        if (seen[at]?.generation === generation) return
        const updated = [...seen]
        updated[at] = { text, generation, ...(scriptId === undefined ? {} : { scriptId }) }
        set({ cardReports: updated })
      },

      withdrawReportsFor(scriptId: string): void {
        /*
         * Called when a script that was reported failed turns out to have
         * succeeded — a module that finished after the frame's deadline had
         * already given up on it.
         *
         * Marked, not removed. Deleting would leave no trace that anything took
         * long enough to be declared dead, and that delay is the actual defect
         * even when it resolves. Leaving it unmarked is the other error: three
         * consumers ran happily while the panel still said their provider had
         * failed.
         */
        const seen = get().cardReports
        if (!seen.some(report => report.scriptId === scriptId && report.withdrawn !== true)) return
        set({
          cardReports: seen.map(report =>
            report.scriptId === scriptId ? { ...report, withdrawn: true } : report,
          ),
        })
      },

      setRunStates(states: readonly ScriptRunState[]): void {
        set({ runStates: [...states] })
      },

      async resolveScripts(
        characterId: string,
      ): Promise<{ scripts: ScriptView[], documentGranted: boolean }> {
        // Not wrapped in `guard`: the caller is about to decide whether to run
        // code, and a refusal turned into a notice would resolve as though the
        // host had answered.
        const listed = await client.call('script.list', { characterId })
        return { scripts: listed.scripts, documentGranted: listed.documentGranted }
      },

      async fetchScriptDependency(url: string): Promise<string> {
        // The allowlist is the host's; a page cannot police its own fetches. The
        // refusal names the host it declined rather than being softened here.
        const { content } = await client.call('script.fetch', { url })
        return content
      },

      async setScriptEnabled(scriptId: string, enabled: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const { scripts } = await client.call('script.setEnabled', { characterId, scriptId, enabled })
          if (get().scriptsFor === characterId) set({ scripts })
        })
      },

      async setDocumentGrant(granted: boolean): Promise<void> {
        const characterId = get().scriptsFor
        if (characterId === undefined) return
        await guard(async () => {
          const result = await client.call('script.setDocumentGrant', { characterId, granted })
          if (get().scriptsFor !== characterId) return
          set({ documentGranted: result.documentGranted })
          // Said plainly, because the policy is that a grant takes effect on the
          // next run and a user who expects it to apply now would draw the wrong
          // conclusion from a card that keeps failing.
          get().notify(
            'info',
            granted
              ? 'Page access granted. It takes effect the next time the card runs.'
              : 'Page access revoked. It stops at the next run.',
          )
        })
      },

      async scriptContext(chatId: string, characterId: string): Promise<ScriptContext | undefined> {
        try {
          const { context } = await client.call('script.context', { chatId, characterId })
          return context
        } catch {
          // Swallowed on purpose, and the only place in this store that does. A
          // refused context is an expected answer — the fake client refuses
          // rather than inventing one — and the caller decides what to do about
          // it, so raising a notice here would put a message in front of the user
          // about something the caller may be handling fine.
          return undefined
        }
      },

      async scriptBody(characterId: string, scriptId: string): Promise<ScriptBodyResult> {
        try {
          const { content } = await client.call('script.body', { characterId, scriptId })
          return { ok: true, content }
        } catch (error: unknown) {
          // The reason travels. The first version returned a bare `undefined` and
          // its one caller printed a fixed sentence blaming the fake client —
          // which was then shown for a refusal from a real host, sending someone
          // to debug the transport they had already got working. An explanation
          // that does not depend on the failure is a guess with a confident
          // voice.
          return { ok: false, error: asRpcError(error) }
        }
      },

      async loadConnections(): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.list', {})
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async activateConnection(id: string): Promise<void> {
        const chatId = get().chatId
        await guard(async () => {
          // Scoped like every other settings write: activating while a chat is
          // open means "for this scene". Otherwise the reader would change a
          // conversation's route by touching what looks like a global list.
          const result = await client.call('connection.activate', {
            id,
            ...(chatId === undefined ? {} : { chatId }),
          })
          set({ settings: result.settings, activeConnectionId: result.activeId })
        })
      },

      async saveConnection(patch): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.save', patch)
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async deleteConnection(id: string): Promise<void> {
        await guard(async () => {
          const listed = await client.call('connection.delete', { id })
          // `activeId` is taken from the response rather than kept: deleting the
          // active profile clears it host-side, and holding the old value would
          // leave the interface reporting a current connection nobody can open.
          set({ connections: listed.profiles, activeConnectionId: listed.activeId })
        })
      },

      async runSlash(command: string): Promise<string> {
        const chatId = get().chatId
        if (chatId === undefined) throw new Error('no chat is open')
        // Deliberately not wrapped in `guard`: the caller is a card waiting on a
        // promise, and it needs the rejection. Turning this into a notice would
        // resolve the card's `await` as though the command had worked.
        const { result } = await client.call('script.slash', { chatId, command })
        return result
      },

      async runCardAction(method: string, params: unknown): Promise<unknown> {
        const chatId = get().chatId
        if (chatId === undefined) throw new Error('no chat is open')

        const wire = wireMethodFor(method)
        if (wire === undefined) {
          // Named, so a card author reading their console learns which member was
          // refused rather than that "something" failed.
          /*
           * States the fact, not a motive.
           *
           * "Iris does not let card scripts call X" reads as a decision, and the
           * commonest reason a method is missing from this table is that nobody
           * has built it yet — `setVariables` sat outside it for exactly that
           * reason. Announcing a gap as a prohibition tells the reader the
           * question is settled, so nobody asks for it.
           */
          throw new Error(
            `${method} is not one of the actions a card can ask Iris for` +
              ' — either it is deliberately withheld or it has not been built; the list is CARD_METHODS',
          )
        }

        // Not wrapped in `guard`: a card is awaiting this, and turning a refusal
        // into a notice would resolve its promise as though the action had run.
        const params_ = (typeof params === 'object' && params !== null ? params : {}) as Record<string, unknown>
        // The method is typed now; only the params still need the cast, because
        // their shape depends on which method this turned out to be.
        return client.call(wire, { chatId, ...params_ } as never)
      },

      async itemize(turn?: number): Promise<ItemizationResult> {
        const chatId = get().chatId
        if (chatId === undefined) {
          return { ok: false, error: { code: 'not-found', message: 'no chat is open' } }
        }
        try {
          const { itemization } = await client.call('prompt.itemize', {
            chatId,
            ...(turn === undefined ? {} : { turn }),
          })
          return { ok: true, itemization }
        } catch (error: unknown) {
          return { ok: false, error: asRpcError(error) }
        }
      },

      notify(kind: Notice['kind'], text: string): void {
        noticeSeq += 1
        set({ notice: { kind, text, seq: noticeSeq } })
      },

      dismissNotice(): void {
        set({ notice: undefined })
      },
    }
  })

  const offEvents = client.subscribe(event => {
    applyEvent(store, event)
    // After the projection, not before: a tap that ran first would see the store
    // in its pre-event state, and a card asking what changed would be told the
    // old answer.
    for (const listener of [...(TAPS.get(store) ?? [])]) listener(event)
  })
  // The connection has its own channel because the host cannot report its own
  // silence. Inferring it from arriving frames means the banner only appears
  // once some unrelated traffic happens to show up.
  const offConnection = client.onConnectionChange(connected => {
    store.setState({ connected })
  })

  return {
    store,
    dispose: () => {
      offConnection()
      offEvents()
    },
  }
}

/**
 * Fold one pushed frame into the store.
 *
 * Kept out of the store closure so the streaming rules are legible in one
 * place, and so they can be tested without a client.
 * @param store - the store to update.
 * @param event - the frame.
 *
 * Narrowed on `event.type` directly rather than through the protocol's `isEvent`
 * helper. The union's own discriminant reads no worse, and it leaves this module
 * with no value imports from the protocol — which is what lets the streaming
 * state machine be tested under plain `node --test`, with no bundler.
 */
/**
 * Extra listeners on the host's event stream, per store.
 *
 * A `WeakMap` rather than a module-level set, for the same reason `actionsOf`
 * uses one: two stores exist during a hot reload, and a shared registry would
 * feed the new store's events to the old store's listeners.
 */
const TAPS = new WeakMap<IrisStore, Set<(event: IrisEvent) => void>>()

/**
 * Watch the host's events as they arrive, alongside the projection.
 *
 * For consumers that need the events themselves rather than the state they
 * produce — a running card script is the only one so far, because upstream
 * gives cards an event stream and no equivalent of the store.
 * @param store - the store whose stream to watch.
 * @param listener - called after each event has been applied.
 * @returns a function that stops the subscription.
 */
export function tapHostEvents(store: IrisStore, listener: (event: IrisEvent) => void): () => void {
  const existing = TAPS.get(store) ?? new Set<(event: IrisEvent) => void>()
  existing.add(listener)
  TAPS.set(store, existing)
  return () => {
    existing.delete(listener)
  }
}

export function applyEvent(store: IrisStore, event: IrisEvent): void {
  const state = store.getState()

  if (event.type === 'chats.updated') {
    store.setState({ chats: event.chats })
    return
  }

  // Every other frame names a chat. Frames for chats this page is not looking at
  // are dropped rather than buffered: the settled view on the next open is
  // authoritative anyway, so a buffer would only add a way to be stale.
  if (event.chatId !== state.chatId) return

  if (event.type === 'stream.start') {
    store.setState({ stream: { turn: event.turn, text: '', reasoning: '', key: event.key } })
    return
  }

  if (event.type === 'stream.text' || event.type === 'stream.reasoning') {
    const current = state.stream
    // A delta for a turn whose opening we never saw (a reconnect mid-generation)
    // starts the buffer rather than being discarded.
    const base: StreamBuffer =
      current !== undefined && current.turn === event.turn
        ? current
        : { turn: event.turn, text: '', reasoning: '' }
    store.setState({
      stream: event.type === 'stream.text'
        ? { ...base, text: base.text + event.delta }
        : { ...base, reasoning: base.reasoning + event.delta },
    })
    return
  }

  if (event.type === 'stream.end') {
    // The whole reason the protocol sends a view here: drop the optimistic
    // buffer and take the host's truth in one step.
    store.setState({ view: event.view, stream: undefined })
    return
  }

  if (event.type === 'stream.error') {
    store.setState({ stream: undefined })
    state.notify('error', event.message)
    return
  }

  if (event.type === 'chat.updated') {
    // Deliberately does NOT clear `stream`: an edit or a swipe landing while a
    // later turn generates must not blank the text arriving for it.
    store.setState({ view: event.view })
  }
}

/** Stable action facades, one per store. */
const FACADES = new WeakMap<IrisStore, IrisActions>()

/**
 * The action set, with an identity that does not change.
 *
 * zustand's `getState()` returns a **new object after every write**, so anything
 * using it as a `useEffect` dependency re-fires on every store change — and an
 * effect that calls an action then becomes an infinite loop: action writes,
 * identity changes, effect re-runs, action writes.
 *
 * That loop wedged a browser renderer hard enough to survive a tab close. It had
 * been latent for days in `App`'s boot effect and never fired, purely because
 * `App` selects primitives that happen not to change; the panel that finally
 * triggered it selects an array whose identity changes on every load. "Safe
 * because of what the neighbouring selector returns" is not a property worth
 * relying on, so the fix is here rather than at the call sites.
 *
 * Actions are the function-valued members of the state and are never replaced,
 * so capturing them once is sound. Picked by type rather than listed, because a
 * hand-written list is a second place for the action set to be declared and
 * would drift the first time one is added.
 * @param store - the store to read.
 * @returns the same object on every call for a given store.
 */
export function actionsOf(store: IrisStore): IrisActions {
  const cached = FACADES.get(store)
  if (cached !== undefined) return cached
  const state = store.getState() as unknown as Record<string, unknown>
  const facade = Object.fromEntries(
    Object.entries(state).filter(([, value]) => typeof value === 'function'),
  ) as unknown as IrisActions
  FACADES.set(store, facade)
  return facade
}
