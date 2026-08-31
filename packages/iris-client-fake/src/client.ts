/**
 * An in-memory `IrisClient`.
 *
 * This exists so the browser half is not blocked on the transport half. It is
 * held to one rule: **behave like the host, not like a convenience**. So it
 * validates params through the protocol's own schemas, it returns from
 * `chat.send` the moment a turn opens rather than when the reply is done, and
 * it settles a stream by pushing the whole `ChatView` — the three places where
 * a shortcut would teach the UI a habit the real host would then break.
 *
 * @module @iris/client-fake/client
 */

import {
  parseRequest,
  type CharacterSummary,
  type ChatSummary,
  type GenerationSettings,
  type IrisClient,
  type IrisEvent,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type ScriptView,
} from '@iris/protocol'

import { chunk, replyFor, reasoningFor } from './corpus.ts'
import { readCard } from './card.ts'
import { fakeItemization } from './prompt.ts'
import { mergeSettings } from './settings.ts'
import { DEFAULT_SETTINGS, seedCharacters, seedChats } from './seed.ts'
import { toChatSummary, toChatView, type FakeChat, type FakeMessage } from './state.ts'

/**
 * Scripts the fake reports for every character.
 *
 * Shaped after what the real corpus holds — one large webpack bundle, one small
 * hand-written script, one the card's own author disabled — so a list built
 * against this meets the cases that exist rather than three identical rows. The
 * byte sizes are real orders of magnitude: card scripts run to megabytes.
 */
const FAKE_SCRIPTS: { id: string, name: string, info?: string, enabledByCard: boolean, bytes: number }[] = [
  { id: 'f0f993f6', name: 'ERA 核心', info: '状态栏与变量写入', enabledByCard: true, bytes: 1_792_316 },
  { id: 'acf69655', name: 'ERA 经验值系统', enabledByCard: true, bytes: 4_820 },
  { id: '3fc1e259', name: 'ERA 以上待修改', info: '', enabledByCard: false, bytes: 0 },
]

/** How the fake is tuned for a given consumer. */
export interface FakeClientOptions {
  /**
   * Milliseconds between stream deltas. Tests pass 0; the dev server wants
   * something human, because streaming layout can only be judged in motion.
   */
  chunkDelayMs?: number
  /** How many deltas one reply is cut into. */
  chunkCount?: number
  /** Start with an empty library and no chats, to exercise the empty states. */
  empty?: boolean
}

/**
 * A rejection that satisfies `RpcError` and is also an `Error`.
 *
 * The contract says `call` rejects with an `RpcError` shape; it does not say
 * whether that value is an `Error`. Being both means no consumer is surprised —
 * a `catch` that reads `.code` works, and so does one that logs `.stack`.
 */
export class FakeRpcError extends Error implements RpcError {
  code: RpcError['code']

  /**
   * @param code - the machine-readable reason.
   * @param message - human-readable detail, safe to show.
   */
  constructor(code: RpcError['code'], message: string) {
    super(message)
    this.name = 'FakeRpcError'
    this.code = code
  }
}

/** The fake, plus handles a dev harness needs that a real client has no business exposing. */
export interface FakeClient extends IrisClient {
  /** Flip the reported connection state, to exercise the offline banner. */
  setConnected(value: boolean): void
  /** Drop every timer in flight. Call from a test's teardown. */
  dispose(): void
}

/** An in-flight generation. */
interface Streaming {
  turn: number
  /** Index of the assistant message being filled. */
  messageIndex: number
  timers: ReturnType<typeof setTimeout>[]
  aborted: boolean
}

/**
 * Build an in-memory client.
 * @param options - streaming pace and seeding.
 * @returns a client the interface can be developed and tested against.
 */
export function createFakeClient(options?: FakeClientOptions): FakeClient {
  return new InMemoryClient(options ?? {})
}

class InMemoryClient implements FakeClient {
  #chats: FakeChat[]
  #characters: CharacterSummary[]
  /** Cards the user granted the real document, in this fake's memory only. */
  readonly #grants = new Set<string>()
  /** User overrides of a script's on/off, keyed `characterId/scriptId`. */
  readonly #scriptOverrides = new Map<string, boolean>()
  #globalSettings: GenerationSettings
  #listeners = new Set<(event: IrisEvent) => void>()
  #connectionListeners = new Set<(connected: boolean) => void>()
  #streams = new Map<string, Streaming>()
  #connected = true
  #chunkDelayMs: number
  #chunkCount: number
  #nextId = 1

  constructor(options: FakeClientOptions) {
    this.#chats = options.empty === true ? [] : seedChats()
    this.#characters = options.empty === true ? [] : seedCharacters()
    this.#globalSettings = { ...DEFAULT_SETTINGS }
    this.#chunkDelayMs = options.chunkDelayMs ?? 24
    this.#chunkCount = options.chunkCount ?? 28
  }

  get connected(): boolean {
    return this.#connected
  }

  setConnected(value: boolean): void {
    if (this.#connected === value) return
    this.#connected = value
    // Notify, because an offline banner that waits for the next unrelated frame
    // is the thing `onConnectionChange` exists to prevent — and a fake that
    // only flips the flag would let the interface pass its tests and still fail
    // against the real transport.
    for (const listener of [...this.#connectionListeners]) listener(value)
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.#connectionListeners.add(listener)
    return () => {
      this.#connectionListeners.delete(listener)
    }
  }

  dispose(): void {
    this.#connectionListeners.clear()
    for (const stream of this.#streams.values()) {
      stream.aborted = true
      for (const timer of stream.timers) clearTimeout(timer)
    }
    this.#streams.clear()
    this.#listeners.clear()
  }

  subscribe(listener: (event: IrisEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async call<M extends RpcMethod>(method: M, params: RpcRequest<M>): Promise<RpcResponse<M>> {
    // Validate exactly where the host would. A UI that sends a malformed
    // payload should find out against the fake, not against the transport.
    const parsed = parseRequest(method, params)
    if (!parsed.ok) throw new FakeRpcError(parsed.error.code, parsed.error.message)
    // The cast mirrors the host dispatcher's: `parsed.params` is the validated
    // body of THIS method, and the switch below is what proves it, arm by arm.
    return this.#dispatch(method, parsed.params) as Promise<RpcResponse<M>>
  }

  // ---------------------------------------------------------------- dispatch

  async #dispatch(method: RpcMethod, params: unknown): Promise<unknown> {
    switch (method) {
      case 'chat.list':
        return { chats: this.#summaries() }

      case 'chat.create': {
        const { characterId } = params as RpcRequest<'chat.create'>
        const character = this.#characters.find(row => row.characterId === characterId)
        if (character === undefined) throw new FakeRpcError('not-found', `no character "${characterId}"`)
        const chat: FakeChat = {
          chatId: `chat-${this.#nextId++}`,
          title: character.name,
          characterId,
          messages: [],
          updatedAt: Date.now(),
          settings: { ...this.#globalSettings },
          variables: {},
        }
        this.#chats.unshift(chat)
        this.#emit({ type: 'chats.updated', chats: this.#summaries() })
        return { view: toChatView(chat) }
      }

      case 'chat.open': {
        const chat = this.#require((params as RpcRequest<'chat.open'>).chatId)
        return { view: toChatView(chat, this.#streams.get(chat.chatId)?.turn) }
      }

      case 'chat.delete': {
        const { chatId } = params as RpcRequest<'chat.delete'>
        this.#require(chatId)
        this.#abort(chatId)
        this.#chats = this.#chats.filter(row => row.chatId !== chatId)
        this.#emit({ type: 'chats.updated', chats: this.#summaries() })
        return {}
      }

      case 'chat.rename': {
        const { chatId, title } = params as RpcRequest<'chat.rename'>
        this.#require(chatId).title = title
        this.#emit({ type: 'chats.updated', chats: this.#summaries() })
        return { chats: this.#summaries() }
      }

      case 'chat.send': {
        const { chatId, text } = params as RpcRequest<'chat.send'>
        const chat = this.#require(chatId)
        if (this.#streams.has(chatId)) throw new FakeRpcError('busy', 'this chat is already generating')

        const turn = this.#nextTurn(chat)
        chat.messages.push({ role: 'user', name: 'You', candidates: [{ text }], index: 0, turn })
        chat.updatedAt = Date.now()
        // Push the user's own message before the stream opens. The composer
        // clears on the response, and a UI that had to wait for `stream.end` to
        // see what it just sent would feel broken on a slow model.
        this.#emit({ type: 'chat.updated', chatId, view: toChatView(chat) })
        this.#emit({ type: 'chats.updated', chats: this.#summaries() })
        this.#beginTurn(chat, turn, this.#appendAssistant(chat, turn), 0)
        return { turn }
      }

      case 'chat.regenerate': {
        const { chatId } = params as RpcRequest<'chat.regenerate'>
        const chat = this.#require(chatId)
        if (this.#streams.has(chatId)) throw new FakeRpcError('busy', 'this chat is already generating')

        const at = this.#lastAssistantIndex(chat)
        if (at === -1) throw new FakeRpcError('not-found', 'this chat has nothing to regenerate')
        const message = chat.messages[at] as FakeMessage
        // A regenerate ADDS a reading. Overwriting is the one shortcut that
        // would make swipes look like they work while losing an alternate the
        // reader wanted back.
        message.candidates.push({ text: '' })
        message.index = message.candidates.length - 1
        this.#beginTurn(chat, message.turn, at, message.index)
        return { turn: message.turn }
      }

      case 'chat.abort': {
        const { chatId } = params as RpcRequest<'chat.abort'>
        this.#require(chatId)
        this.#abort(chatId)
        return {}
      }

      case 'chat.swipe': {
        const { chatId, turn, index } = params as RpcRequest<'chat.swipe'>
        const chat = this.#require(chatId)
        const at = chat.messages.findIndex(row => row.role === 'assistant' && row.turn === turn)
        if (at === -1) throw new FakeRpcError('not-found', `turn ${turn} has no reply`)
        const message = chat.messages[at] as FakeMessage
        if (index >= message.candidates.length) {
          throw new FakeRpcError('invalid-request', `turn ${turn} has ${message.candidates.length} readings`)
        }
        message.index = index
        const view = toChatView(chat, this.#streams.get(chatId)?.turn)
        this.#emit({ type: 'chat.updated', chatId, view })
        return { view }
      }

      case 'chat.editMessage': {
        const { chatId, id, text } = params as RpcRequest<'chat.editMessage'>
        const chat = this.#require(chatId)
        const message = chat.messages[id]
        if (message === undefined) throw new FakeRpcError('not-found', `no message ${id}`)
        // The edit lands on the visible reading only. The others are still the
        // model's words, and rewriting them all would destroy the record the
        // swipe rail exists to show.
        const candidate = message.candidates[message.index]
        if (candidate === undefined) throw new FakeRpcError('internal', `message ${id} has no reading`)
        candidate.text = text
        chat.updatedAt = Date.now()
        const view = toChatView(chat, this.#streams.get(chatId)?.turn)
        this.#emit({ type: 'chat.updated', chatId, view })
        return { view }
      }

      case 'chat.deleteMessage': {
        const { chatId, id } = params as RpcRequest<'chat.deleteMessage'>
        const chat = this.#require(chatId)
        if (chat.messages[id] === undefined) throw new FakeRpcError('not-found', `no message ${id}`)
        chat.messages.splice(id, 1)
        chat.updatedAt = Date.now()
        const view = toChatView(chat, this.#streams.get(chatId)?.turn)
        this.#emit({ type: 'chat.updated', chatId, view })
        this.#emit({ type: 'chats.updated', chats: this.#summaries() })
        return { view }
      }

      case 'prompt.itemize': {
        const { chatId, turn } = params as RpcRequest<'prompt.itemize'>
        const chat = this.#require(chatId)
        // A record exists only while the host holds the chat open, so an old turn
        // legitimately answers with a preview. Modelled rather than refused: the
        // arithmetic is real and a panel built against it will not learn anything
        // that the real host would contradict.
        const newest = chat.messages.reduce((highest, message) => Math.max(highest, message.turn), 0)
        const isRecord = turn !== undefined && turn === newest
        return { itemization: fakeItemization(turn ?? newest + 1, !isRecord) }
      }

      case 'character.list':
        return { characters: this.#characters.map(row => ({ ...row, tags: [...row.tags] })) }

      case 'character.import': {
        const { filename, content } = params as RpcRequest<'character.import'>
        const card = readCard(filename, content)
        const character: CharacterSummary = {
          characterId: `char-${this.#nextId++}`,
          name: card.name,
          tags: card.tags,
          ...(card.creator === undefined ? {} : { creator: card.creator }),
        }
        this.#characters = [character, ...this.#characters]
        return { character }
      }

      case 'character.delete': {
        const { characterId } = params as RpcRequest<'character.delete'>
        if (!this.#characters.some(row => row.characterId === characterId)) {
          throw new FakeRpcError('not-found', `no character "${characterId}"`)
        }
        this.#characters = this.#characters.filter(row => row.characterId !== characterId)
        return {}
      }

      case 'settings.get': {
        const { chatId } = params as RpcRequest<'settings.get'>
        if (chatId === undefined) return { settings: { ...this.#globalSettings } }
        return { settings: { ...this.#require(chatId).settings } }
      }

      case 'settings.set': {
        const { chatId, settings } = params as RpcRequest<'settings.set'>
        if (chatId === undefined) {
          this.#globalSettings = mergeSettings(this.#globalSettings, settings)
          return { settings: { ...this.#globalSettings } }
        }
        const chat = this.#require(chatId)
        chat.settings = mergeSettings(chat.settings, settings)
        return { settings: { ...chat.settings } }
      }

      case 'script.list': {
        const { characterId } = params as RpcRequest<'script.list'>
        this.#requireCharacter(characterId)
        return {
          scripts: this.#scriptViews(characterId),
          documentGranted: this.#grants.has(characterId),
        }
      }

      case 'script.setEnabled': {
        const { characterId, scriptId, enabled } = params as RpcRequest<'script.setEnabled'>
        this.#requireCharacter(characterId)
        if (!FAKE_SCRIPTS.some(script => script.id === scriptId)) {
          throw new FakeRpcError('not-found', `no script "${scriptId}"`)
        }
        this.#scriptOverrides.set(`${characterId}/${scriptId}`, enabled)
        return { scripts: this.#scriptViews(characterId) }
      }

      case 'script.setDocumentGrant': {
        const { characterId, granted } = params as RpcRequest<'script.setDocumentGrant'>
        this.#requireCharacter(characterId)
        if (granted) this.#grants.add(characterId)
        else this.#grants.delete(characterId)
        return { documentGranted: this.#grants.has(characterId) }
      }

      case 'chat.branch': {
        // Refused until the interface grows branch UI, at which point the fake
        // should implement it for real — branching is chat-shape work the fake
        // can model honestly, unlike the script bridge below. Whoever builds
        // that UI upgrades this arm; a refusal today beats a wrong model.
        throw new FakeRpcError('unsupported', 'the fake client does not implement chat.branch yet')
      }

      case 'script.context':
      case 'script.saveMetadata':
      case 'script.saveChat':
      case 'script.setExtensionPrompt':
      case 'script.setExtensionSettings':
      case 'script.generateRaw': {
        // Refused, not faked. A context assembled here would be the fake's
        // invention of SillyTavern's shape, and a runner built against it would
        // pass in development and break on the first real card.
        throw new FakeRpcError('unsupported', `the fake client does not implement ${method}`)
      }

      case 'script.body': {
        // Refused like fetch: handing back an invented body would let a runner
        // pass in development and break on the first real card.
        throw new FakeRpcError('unsupported', 'the fake client does not carry script bodies')
      }

      case 'script.fetch': {
        // Refused rather than answered with invented code. The fake exists so
        // the interface can be built without a host; handing back a plausible
        // script body would let a runner appear to work here and fail against a
        // real host, which is the failure the fake is supposed to prevent.
        throw new FakeRpcError('unsupported', 'the fake client does not fetch remote scripts')
      }

      default: {
        // Exhaustiveness guard: a method added to the protocol without an arm
        // here becomes a type error rather than a runtime surprise.
        const unreachable: never = method
        throw new FakeRpcError('unsupported', `unhandled method ${String(unreachable)}`)
      }
    }
  }

  // ----------------------------------------------------------------- helpers

  /** Refuse a character the fake does not have. */
  #requireCharacter(characterId: string): void {
    if (!this.#characters.some(row => row.characterId === characterId)) {
      throw new FakeRpcError('not-found', `no character "${characterId}"`)
    }
  }

  /** The script list, with both switches reported as the contract asks. */
  #scriptViews(characterId: string): ScriptView[] {
    return FAKE_SCRIPTS.map(script => ({
      id: script.id,
      name: script.name,
      ...script.info === undefined ? {} : { info: script.info },
      enabledByCard: script.enabledByCard,
      enabled: this.#scriptOverrides.get(`${characterId}/${script.id}`) ?? script.enabledByCard,
      bytes: script.bytes,
    }))
  }


  #summaries(): ChatSummary[] {
    return [...this.#chats].sort((left, right) => right.updatedAt - left.updatedAt).map(toChatSummary)
  }

  #require(chatId: string): FakeChat {
    const chat = this.#chats.find(row => row.chatId === chatId)
    if (chat === undefined) throw new FakeRpcError('not-found', `no chat "${chatId}"`)
    return chat
  }

  #nextTurn(chat: FakeChat): number {
    return chat.messages.reduce((highest, message) => Math.max(highest, message.turn + 1), 0)
  }

  #lastAssistantIndex(chat: FakeChat): number {
    for (let at = chat.messages.length - 1; at >= 0; at -= 1) {
      if (chat.messages[at]?.role === 'assistant') return at
    }
    return -1
  }

  /** Append the empty assistant message a generation will fill in. */
  #appendAssistant(chat: FakeChat, turn: number): number {
    const character = this.#characters.find(row => row.characterId === chat.characterId)
    chat.messages.push({
      role: 'assistant',
      name: character?.name ?? chat.title,
      candidates: [{ text: '' }],
      index: 0,
      turn,
    })
    return chat.messages.length - 1
  }

  #emit(event: IrisEvent): void {
    // Snapshot first: a listener that unsubscribes on the frame it is handling
    // is normal (a closing chat view does exactly that), and mutating the set
    // mid-iteration would skip whoever came next.
    for (const listener of [...this.#listeners]) listener(event)
  }

  #abort(chatId: string): void {
    const stream = this.#streams.get(chatId)
    if (stream === undefined) return
    stream.aborted = true
    for (const timer of stream.timers) clearTimeout(timer)
    this.#streams.delete(chatId)
    // Whatever arrived stays. A partial reply the reader can keep, edit or
    // regenerate is more useful than a message that vanishes on cancel.
    this.#emit({ type: 'stream.end', chatId, turn: stream.turn, view: toChatView(this.#require(chatId)) })
  }

  /**
   * Schedule one generation.
   *
   * Timer-driven rather than an async loop, for two reasons: `chat.abort` gets
   * something concrete to cancel, and a test can run the whole thing at zero
   * delay without the ordering shifting under it.
   */
  #beginTurn(chat: FakeChat, turn: number, messageIndex: number, candidate: number): void {
    const chatId = chat.chatId
    const stream: Streaming = { turn, messageIndex, timers: [], aborted: false }
    this.#streams.set(chatId, stream)

    const reasoning = reasoningFor(turn, candidate)
    const text = replyFor(turn, candidate)
    const steps: (() => void)[] = []

    steps.push(() => {
      // The fake's own identity for the row, announced the way the host
      // announces its own. Deliberately not made to resemble the host's: a
      // consumer that works against both can only be relying on the frame.
      this.#emit({ type: 'stream.start', chatId, turn, key: `a${String(turn)}` })
    })

    // Reasoning arrives first and on its own channel, which is the order a real
    // provider uses: the UI must be able to show a thinking block before a
    // single visible word exists.
    if (reasoning !== undefined) {
      for (const delta of chunk(reasoning, Math.max(2, Math.floor(this.#chunkCount / 4)))) {
        steps.push(() => {
          this.#appendTo(chat, messageIndex, { reasoning: delta })
          this.#emit({ type: 'stream.reasoning', chatId, turn, delta })
        })
      }
    }

    for (const delta of chunk(text, this.#chunkCount)) {
      steps.push(() => {
        this.#appendTo(chat, messageIndex, { text: delta })
        this.#emit({ type: 'stream.text', chatId, turn, delta })
      })
    }

    steps.push(() => {
      this.#streams.delete(chatId)
      chat.updatedAt = Date.now()
      this.#bumpVariables(chat)
      this.#emit({ type: 'stream.end', chatId, turn, view: toChatView(chat) })
      this.#emit({ type: 'chats.updated', chats: this.#summaries() })
    })

    steps.forEach((step, at) => {
      stream.timers.push(
        setTimeout(() => {
          if (!stream.aborted) step()
        }, this.#chunkDelayMs * at),
      )
    })
  }

  /** Fold one delta into the reading being generated. */
  #appendTo(chat: FakeChat, messageIndex: number, delta: { text?: string, reasoning?: string }): void {
    const message = chat.messages[messageIndex]
    if (message === undefined) return
    const candidate = message.candidates[message.index]
    if (candidate === undefined) return
    if (delta.text !== undefined) candidate.text += delta.text
    if (delta.reasoning !== undefined) candidate.reasoning = (candidate.reasoning ?? '') + delta.reasoning
  }

  /**
   * Nudge the chat's variables so a status surface has something that moves.
   *
   * The real values come from MVU commands inside the reply; the fake only
   * needs them to change on a settled turn, because a status panel that never
   * updates cannot be told from one that was never wired up.
   */
  #bumpVariables(chat: FakeChat): void {
    for (const [key, value] of Object.entries(chat.variables)) {
      if (typeof value === 'number') chat.variables[key] = value + 1
    }
  }
}
