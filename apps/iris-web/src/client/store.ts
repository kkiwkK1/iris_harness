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
  GenerationSettings,
  IrisClient,
  IrisEvent,
} from '@iris/protocol'

import { describeError } from './errors.ts'

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
export function createIrisStore(client: IrisClient): { store: IrisStore, dispose: () => void } {
  let noticeSeq = 0

  const store: IrisStore = createStore<IrisState & IrisActions>((set, get) => {
    /** Run a host call, turning a refusal into a notice rather than a crash. */
    const guard = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error: unknown) {
        noticeSeq += 1
        set({ notice: { kind: 'error', text: describeError(error), seq: noticeSeq } })
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
          set({ characters })
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
