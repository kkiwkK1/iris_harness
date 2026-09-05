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
  type ChatSearchHit,
  type ChatSearchMatch,
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
import {
  activateConnection,
  deleteConnection,
  listConnections,
  saveConnection,
} from './connections.ts'
import { mergeSettings } from './settings.ts'
import { DEFAULT_SETTINGS, seedCharacters, seedChats } from './seed.ts'
import { selected, toChatSummary, toChatView, type FakeChat, type FakeMessage } from './state.ts'

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

  /**
   * Whether the user has answered the run-scripts question, per card.
   *
   * A `Map`, not a `Set`, and the difference is the feature. `documentGranted`
   * deliberately stores "revoked" and "never granted" as the same state — those
   * two should be indistinguishable. `scriptsAllowed` is the opposite: absent
   * means nobody has been asked, `false` means they were asked and said no, and
   * telling those apart is the entire point. Collapsing them would re-ask a user
   * who already declined, every time they open a chat.
   */
  readonly #scriptsAllowed = new Map<string, boolean>()
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

      case 'chat.search': {
        // The host's scan over the fake's log: the selected candidate's text is
        // what a reader sees, so it is what a search answers from.
        const { query, caseSensitive, limit } = params as RpcRequest<'chat.search'>
        const needle = query.trim()
        if (needle.length === 0) throw new FakeRpcError('invalid-request', 'the search query is empty')
        const foldedNeedle = caseSensitive === true ? needle : needle.toLowerCase()
        const cap = limit ?? 5
        const hits = this.#chats
          .map((chat): ChatSearchHit | undefined => {
            const matches: ChatSearchMatch[] = []
            for (const [id, message] of chat.messages.entries()) {
              if (matches.length >= cap) break
              const text = selected(message).text
              const at = caseSensitive === true
                ? text.indexOf(needle)
                : text.toLowerCase().indexOf(foldedNeedle)
              if (at < 0) continue
              matches.push({
                messageId: id,
                name: message.name,
                isUser: message.role === 'user',
                snippet: text.slice(Math.max(0, at - 48), Math.min(text.length, at + 96)),
              })
            }
            if (matches.length === 0) return undefined
            return { ...toChatSummary(chat), matches }
          })
          .filter((hit): hit is ChatSearchHit => hit !== undefined)
          .sort((left, right) => right.updatedAt - left.updatedAt)
        return { hits }
      }

      case 'chat.send': {
        const { chatId, kind, text } = params as RpcRequest<'chat.send'>
        const chat = this.#require(chatId)
        if (this.#streams.has(chatId)) throw new FakeRpcError('busy', 'this chat is already generating')

        // A continue grows the newest reply by one more reading that opens with
        // the current one, so the reader's floor count does not move; an
        // impersonation writes the user's next line and no reply at all.
        if (kind === 'continue') {
          const at = this.#lastAssistantIndex(chat)
          if (at === -1) throw new FakeRpcError('not-found', 'this chat has no reply to continue')
          const message = chat.messages[at] as FakeMessage
          const seed = selected(message).text
          message.candidates.push({ text: seed })
          message.index = message.candidates.length - 1
          chat.updatedAt = Date.now()
          this.#beginTurn(chat, message.turn, at, message.index, seed)
          return { turn: message.turn }
        }

        if (kind === 'impersonate') {
          const turn = this.#nextTurn(chat)
          chat.messages.push({ role: 'user', name: 'You', candidates: [{ text: '' }], index: 0, turn })
          chat.updatedAt = Date.now()
          const at = chat.messages.length - 1
          this.#beginTurn(chat, turn, at, 0, '', 'user', 'You')
          return { turn }
        }

        const turn = this.#nextTurn(chat)
        chat.messages.push({ role: 'user', name: 'You', candidates: [{ text: text as string }], index: 0, turn })
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

      case 'script.setChatMessages': {
        /*
         * Modelled rather than refused, unlike its neighbours in the script
         * group, and the line between them is whether the fake would have to
         * invent host domain logic. It would not here: the protocol says this
         * takes **the same write path as `chat.editMessage`**, the arm directly
         * above already implements that path, and a batch of edits is chat
         * shape rather than SillyTavern assembly. Refusing it would also stall
         * MVU's generation-time chain, which is the only reason the method
         * exists.
         */
        const { chatId, messages } = params as RpcRequest<'script.setChatMessages'>
        const chat = this.#require(chatId)

        /*
         * Resolved in full before a single character is written. A card
         * appending a status panel to several floors must not be able to leave
         * half of them rewritten: a partly applied batch is worse than a
         * refused one, because the card is told it succeeded and its next read
         * disagrees with its own model of the chat.
         */
        const targets = messages.map(({ messageId, message }) => {
          const floor = chat.messages[messageId]
          if (floor === undefined) throw new FakeRpcError(
            'not-found',
            `no message ${String(messageId)}`,
          )
          // The visible reading only, for the reason `chat.editMessage` gives:
          // the other candidates are still the model’s words.
          const candidate = floor.candidates[floor.index]
          if (candidate === undefined) throw new FakeRpcError(
            'internal',
            `message ${String(messageId)} has no reading`,
          )
          return { candidate, text: message }
        })

        for (const target of targets) target.candidate.text = target.text
        chat.updatedAt = Date.now()

        /*
         * `refresh` is read off the wire and deliberately not consulted — it is
         * upstream's hint about repainting its own DOM, and this client tells
         * every attached page what changed regardless. Accepting and ignoring
         * it is what lets a card written against upstream call this unchanged.
         */
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

      case 'script.slash': {
        // Refused rather than modelled, unlike the profiles and the itemization.
        // The value of this method is upstream's escape rule (a `|` preceded by an
        // odd number of backslashes is literal), which lives in
        // `@iris/compat-tavernhelper` and is the whole reason the string crosses
        // the wire unparsed. A second, simpler implementation here would answer
        // plausibly for the inputs a developer thinks to try and diverge on the
        // first message containing a pipe — which is exactly the divergence the
        // contract was shaped to prevent.
        throw new FakeRpcError('unsupported', 'the fake client does not run slash commands')
      }

      case 'connection.list':
        return listConnections()

      case 'connection.save':
        return saveConnection(params as RpcRequest<'connection.save'>)

      case 'connection.delete': {
        const { id } = params as RpcRequest<'connection.delete'>
        const result = deleteConnection(id)
        if (result === undefined) throw new FakeRpcError('not-found', `no connection "${id}"`)
        return result
      }

      case 'connection.activate': {
        const { id, chatId } = params as RpcRequest<'connection.activate'>
        const result = activateConnection(id)
        if (result === undefined) throw new FakeRpcError('not-found', `no connection "${id}"`)
        // Activating writes through to whichever settings scope was named, so the
        // interface sees the same effect the real host would produce rather than a
        // list that changed and a chat that did not.
        if (chatId === undefined) this.#globalSettings = { ...result.settings }
        else this.#require(chatId).settings = { ...result.settings }
        return result
      }

      case 'connection.test':
        // Refused, not modelled: the one thing this method exists to do is put
        // a request on a real network, and faking a latency or an error code
        // would let a connection form teach the interface a verdict no
        // endpoint ever gave. An interface developed against the fake sees
        // this refusal in dev, where its absence of a real probe is visible —
        // not against a host, where it would be a lie.
        throw new FakeRpcError('unsupported', 'the fake client cannot reach a real endpoint; run against a host to test a connection')

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
          /*
           * Derived from the name and made unique against the cards that exist
           * now, which is what the host does — and it matters here for a reason
           * beyond tidiness.
           *
           * A counter never repeats, so a fake that minted `char-7` could not
           * reproduce id *reuse*: deleting a card frees its id, and the next card
           * of that name is handed it. That is the mechanism behind a defect
           * found in both halves of this project, where a new card inherited
           * permissions granted to its deleted namesake. An interface developed
           * against a client that cannot express that will never show it.
           *
           * It also made the fake inconsistent with itself: seeded cards already
           * carry slugs (`aria-vance`), and only imports carried counters.
           */
          characterId: this.#mintCharacterId(card.name),
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
        /*
         * Forget what was decided *about* this card, and keep what belongs to
         * the conversations.
         *
         * Content rebinds by name — chats survive, because reimporting a card to
         * carry on playing is what a user means to do. Permissions never: the
         * page grant and the run-scripts answer were given about a card that no
         * longer exists, and the id is about to be handed to a different one.
         *
         * The host does this; a fake that did not would let an interface be
         * built against inheritance the real thing does not have.
         */
        this.#grants.delete(characterId)
        this.#scriptsAllowed.delete(characterId)
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
        const answered = this.#scriptsAllowed.get(characterId)
        return {
          scripts: this.#scriptViews(characterId),
          documentGranted: this.#grants.has(characterId),
          // Omitted when unanswered rather than sent as `false`, because the
          // reader is expected to test presence. A `false` here would mean "was
          // asked and declined" and would suppress the first-run question
          // permanently, with nothing reporting that it had.
          ...(answered === undefined ? {} : { scriptsAllowed: answered }),
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

      case 'script.setScriptsAllowed': {
        /*
         * Answered rather than refused, on the line drawn for `getVariables`:
         * this carries no merge rule. It records one boolean against one card,
         * which the fake can do truthfully — and a UI built against a client that
         * refused it could never exercise the three-state behaviour that makes
         * the consent gate work.
         */
        const { characterId, allowed } = params as RpcRequest<'script.setScriptsAllowed'>
        this.#requireCharacter(characterId)
        // Written, never deleted. Deleting a `false` would read back as "never
        // asked" and the question would return on the next chat open.
        this.#scriptsAllowed.set(characterId, allowed)
        return { scriptsAllowed: allowed }
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
      case 'script.generateRaw':
      /*
       * `script.generate` refuses for the same reason as `generateRaw`, only more
       * so: it is the one that **assembles** the preset, the world info and the
       * history. Faking that would be this package inventing SillyTavern's
       * assembly, and a card built against the invention would pass here and
       * produce a differently-shaped prompt against a real host.
       *
       * Refusing both also keeps a real mistake legible. Upstream has two
       * generates with different semantics, and Iris's façade was wired to the
       * wrong one — a card asking for the assembled generate was served the raw
       * one, which returns text with no persona and no history and **succeeds**.
       * Because the refusal names the method that was actually called, a
       * developer whose card called `generate()` and sees
       * "does not implement script.generateRaw" is being told about the
       * mis-mapping rather than about a missing feature.
       */
      case 'script.generate':
      case 'script.setVariables':
      case 'script.swipeTo': {
        /*
         * Refused, not faked. A context assembled here would be the fake's
         * invention of SillyTavern's shape, and a runner built against it would
         * pass in development and break on the first real card.
         *
         * The two write methods belong here for the same reason, stated twice
         * over. `setVariables` carries an *operation* — `insertOrAssign` lets the
         * incoming value win and replaces arrays wholesale, `insert` lets the
         * existing one win — and faking it means writing that subtle rule a
         * second time, in the half that is not authoritative. `swipeTo` needs the
         * `messageId`-to-turn mapping, which is domain logic the host owns. A
         * card that appeared to persist state here and lost it against a real
         * host is precisely the failure the fake exists to prevent.
         */
        throw new FakeRpcError('unsupported', `the fake client does not implement ${method}`)
      }

      case 'script.getVariables': {
        /*
         * Answered, unlike its sibling `script.setVariables`, and the line
         * between them is what each one carries.
         *
         * A write carries a *rule* — `insertOrAssign` lets the incoming value
         * win and replaces arrays wholesale, `insert` lets the existing one win
         * — and implementing that here would be a second copy of it in the half
         * that is not authoritative. A read carries no rule. It is a lookup, and
         * the fake has a real per-chat variable table to look in.
         *
         * The `chat` scope is answered from that table. The other three are
         * answered empty, which is a true statement about this client rather
         * than an invented one: it models per-chat variables and nothing else,
         * and since writes are refused, nothing can ever appear in them. Empty
         * also means "not initialised yet" to a card, which is exactly what the
         * fake is.
         */
        const { chatId, scope } = params as RpcRequest<'script.getVariables'>
        const chat = this.#require(chatId)
        return { variables: scope === 'chat' ? { ...chat.variables } : {} }
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

      /*
       * World books, answered as a host that genuinely has none.
       *
       * The distinction this arm rests on: an empty book list is a **real host
       * state**, not a stand-in for one. The fake has no world book data — no
       * fixture, no parsed `character_book` — so "none" is the true answer here
       * rather than an invented one, and that is what separates these from the
       * refused group above. `script.generate` is refused because faking it
       * means inventing SillyTavern’s assembly; there is nothing to invent in
       * reporting an absence.
       *
       * It also keeps the empty state reachable in development, which a refusal
       * would not. A card bound to no books, and an interface that has to render
       * that, are both things somebody has to be able to see.
       *
       * When the fake grows real book fixtures these become real reads. Until
       * then a developer who needs books runs against a host that has them.
       */
      case 'worldbook.names': {
        return { names: [] }
      }

      case 'worldbook.charNames': {
        const { characterId } = params as RpcRequest<'worldbook.charNames'>
        /*
         * The card still has to exist. A binding query for a character that is
         * not there is a caller mistake and should read as one, rather than as
         * a card that happens to be bound to nothing.
         */
        if (!this.#characters.some(row => row.characterId === characterId)) {
          throw new FakeRpcError('not-found', `no character "${characterId}"`)
        }
        return { primary: null, additional: [] }
      }

      case 'script.evalTemplate': {
        /*
         * Refused, and the softness of the caller's error handling is the reason
         * to be careful rather than a reason to relax.
         *
         * The measured card wraps this in `console.warn` plus a fall back to the
         * unrendered text, so a refusal degrades gracefully there — which is
         * exactly why a *fabricated* answer would be worse than usual: it would
         * take the graceful path away and substitute a confidently wrong one. An
         * EJS template reads macros, variables and chat state; anything this
         * client rendered would be its own invention of what those hold, and the
         * card would embed the invention in a prompt.
         */
        throw new FakeRpcError(
          'unsupported',
          'the fake client does not evaluate templates; it has no macro or variable state to render against',
        )
      }

      case 'script.getPreset': {
        const { name } = params as RpcRequest<'script.getPreset'>
        /*
         * Refused, and this one is the clearest case in the file.
         *
         * A preset is the assembled prompt configuration — orders, macros, the
         * lot. Anything this client returned would be its own invention of
         * SillyTavern's shape, which is exactly the line the `generate` family is
         * refused along. Worse here: a card reads a preset in order to *reason
         * about what the model will be sent*, so a fabricated one does not fail,
         * it produces confident wrong conclusions about prompts that do not exist.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client has no presets to read (asked for ${name})`,
        )
      }

      case 'script.createChatMessages': {
        const { messages } = params as RpcRequest<'script.createChatMessages'>
        /*
         * Refused, and the ambiguity is the reason rather than the absence.
         *
         * This client *could* append to its in-memory chat and answer with a
         * plausible view. What it cannot do is make that answer distinguishable
         * from the one a real host gives — the append arm deliberately does not
         * persist, so a caller checking "did it land" reads the view either way,
         * and a fake that models half of a two-step operation teaches a card the
         * wrong half. The same shape as `worldbook.setGlobalSelect`: the
         * successful response and the did-nothing response are byte-identical.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client does not implement chat insertion (${String(messages.length)} message(s) refused)`,
        )
      }

      case 'script.deleteChatMessages': {
        const { messageIds } = params as RpcRequest<'script.deleteChatMessages'>
        /*
         * Refused rather than modelled, despite `chat.deleteMessage` being
         * implemented above — and the difference is exactly the one worth not
         * papering over. That arm removes **one** floor by id. This one removes a
         * set by their **original** indices in a single pass, and the whole
         * reason it exists is that applying them one at a time shifts the indices
         * between calls and deletes the wrong floors, silently. Implementing it
         * here as a loop over the single-floor path would reproduce that bug in
         * the one place built to demonstrate its absence.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client does not implement batch deletion (${String(messageIds.length)} id(s) refused)`,
        )
      }

      case 'worldbook.globalSelect': {
        /*
         * An empty selection, which is a true answer here for the same reason
         * `worldbook.names` returns nothing: this client holds no world books, so
         * none of them can be globally selected. Reporting an absence invents
         * nothing.
         */
        return { names: [] }
      }

      case 'worldbook.setGlobalSelect': {
        const { names } = params as RpcRequest<'worldbook.setGlobalSelect'>
        /*
         * Refused, on the same line the reads and writes were split along: a
         * selection is a **write**, and "this host has no books" is not a true
         * answer to one. The contract says a name with no file behind it is
         * skipped, so accepting an arbitrary list against an empty store would
         * skip every entry and answer `{names: []}` — a success that looks
         * exactly like the caller having selected nothing, when in fact nothing
         * could ever have been selected.
         */
        throw new FakeRpcError(
          'not-found',
          `the fake client has no world books, so none of [${names.join(', ')}] can be selected`,
        )
      }

      case 'worldbook.replace': {
        const { name } = params as RpcRequest<'worldbook.replace'>
        /*
         * Refused, and for the opposite reason to the reads above.
         *
         * "This host has no world books" is a true answer to *names* and to
         * *bindings*: nothing is being invented by reporting an absence. It is
         * not a true answer to a write. Upstream's `replaceWorldbook` rebuilds
         * the stored book entirely from the array it is handed — entries absent
         * from it are gone — and it also renumbers: missing uids are assigned at
         * random and `displayIndex` is reassigned from array position, so a
         * round trip reorders the file. Accepting the call and doing nothing
         * would tell a card its rewrite landed when no book exists to have
         * received it, which is the "passes here, breaks on a real host" failure
         * this whole package exists to prevent.
         */
        throw new FakeRpcError('not-found', `no world book named ${name}`)
      }

      case 'worldbook.load': {
        const { name } = params as RpcRequest<'worldbook.load'>
        // Placeholder in this client's own idiom (7b owns the sandbox half).
        // `null` rather than a refusal, because this client holds no books and
        // upstream's answer for a name that resolves to nothing is `null` —
        // and an empty name is upstream's absent answer, which is also this
        // client's honest one.
        return name === '' ? {} : { book: null }
      }

      case 'worldbook.get': {
        const { name } = params as RpcRequest<'worldbook.get'>
        /*
         * Not-found rather than an empty entry list, and the difference is the
         * one a caller acts on: "this book has no entries" and "there is no such
         * book" lead to different repairs, and `worldbook.names` above has
         * already promised that no name exists.
         */
        throw new FakeRpcError('not-found', `no world book named ${name}`)
      }

      case 'worldbook.settings': {
        /*
         * Answered, not refused: the effective settings of a host that has never
         * stored any ARE these defaults — SillyTavern's shipped values
         * (`world-info.js:69-82`), which is what the real host merges over an
         * empty section. Inventing nothing: a fresh install genuinely scans with
         * these numbers. Pinned to `worldbook-settings.ts` by
         * `fake-worldbook-settings.test.ts`, so the two tables cannot drift.
         */
        return {
          settings: {
            scanDepth: 2,
            budgetPercent: 25,
            budgetCap: 0,
            minActivations: 0,
            minActivationsDepthMax: 0,
            maxRecursionSteps: 0,
            insertionStrategy: 'character_first',
            recursive: false,
            caseSensitive: false,
            matchWholeWords: false,
            useGroupScoring: false,
          },
        }
      }

      case 'worldbook.setSettings': {
        /*
         * Refused, on the writes-have-nowhere-to-land line: this client keeps no
         * settings file, so accepting a patch would answer `{settings}` with the
         * unchanged defaults — a success that is byte-identical to having done
         * nothing, the exact shape `worldbook.setGlobalSelect` is refused for.
         */
        throw new FakeRpcError(
          'unsupported',
          'the fake client has no world-info settings store, so a settings patch cannot land',
        )
      }

      case 'worldbook.create': {
        const { name } = params as RpcRequest<'worldbook.create'>
        /*
         * Refused like `worldbook.replace`: a creation this client accepted
         * would answer `{created: true}` with no file behind it, and a card's
         * next `getWorldbook` — honestly refused here — would fail on a book it
         * was told exists.
         */
        throw new FakeRpcError('not-found', `no world book store, so "${name}" cannot be created`)
      }

      case 'worldbook.bindChat': {
        const { name } = params as RpcRequest<'worldbook.bindChat'>
        /*
         * Refused. The binding's whole effect is on the next prompt assembly,
         * and this client assembles no prompts — accepting it would report a
         * chat whose world info changed when nothing downstream could reflect
         * that, the apparent-persist failure this package refuses along.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client models no chat world book binding (asked to bind ${name === null ? 'null' : `'${name}'`})`,
        )
      }

      case 'script.replaceScriptButtons': {
        /*
         * Refused, and the reason is specific rather than "not built yet".
         *
         * The whole observable effect of this write is that the **next**
         * `script.context` snapshot carries the new table — that is how a card
         * reads its own buttons back, and how the button bar learns what to
         * draw. This fake refuses `script.context`, so there is no snapshot here
         * for the write to show up in.
         *
         * Accepting it would therefore report success for a change nothing in
         * this package can ever reflect: the card's `getScriptButtons` would
         * keep answering whatever it answered before, and the mismatch would
         * look like a bug in the card. That is the exact failure the fake exists
         * to prevent, stated in its own header — an apparent persist that a real
         * host would not have lost.
         *
         * The arm to write is the one after `script.context` is modelled, and it
         * belongs on the same store the snapshot is built from, not beside it.
         */
        throw new FakeRpcError(
          'unsupported',
          'the fake client cannot persist script buttons: their only readable effect is'
            + ' the next script.context snapshot, which this client refuses',
        )
      }

      case 'debug.reports': {
        // Placeholder in this client's existing refusal pattern, so the tree
        // compiles; the sandbox half is 7b's to design. Refused rather than
        // answered with an empty page for the same reason the host refuses when
        // it holds no buffer: declaring the kinds with no records reads as
        // "collected, nothing happened", and a fake that has collected nothing
        // would be asserting all-clear about a host that is not there.
        throw new FakeRpcError(
          'unsupported',
          'the fake client retains no diagnostic reports: it has no host bus to collect them from,'
            + ' and an empty page would read as "nothing went wrong" rather than "nothing was watching"',
        )
      }

      case 'debug.reports': {
        /*
         * Answered, and the answer is **empty** rather than invented.
         *
         * This fake seeds a lot on purpose — three script rows in three
         * different states, a connection profile whose stored name contradicts
         * its route — because a page cannot be built against states that never
         * appear. Diagnostics are the one place where that reasoning inverts: a
         * report says *something went wrong in the host*, and this client has no
         * host. Seeding three plausible failures would let a page be developed
         * against shapes that no real host ever produces, and the page would
         * then be pinned to this file's imagination instead of to the reporter.
         *
         * So the three counters carry the true reading for a client that has
         * retained nothing: nothing held, nothing dropped, no kinds seen. An
         * empty bundle is a fact here, not a gap — the same call `worldbook.names`
         * makes when a profile genuinely has no books.
         *
         * If the debug page needs developable fixtures, they belong behind an
         * explicit option on this client rather than in its default answer, so
         * that "the page shows nothing" and "the page was given invented data"
         * stay distinguishable.
         */
        void params
        return { reports: [], dropped: 0, oldest: 0, kinds: [] }
      }

      /*
       * Card storage: refused, and the reason is attribution rather than
       * difficulty.
       *
       * The values themselves would be trivial to fake — `localStorage` is a
       * flat `Record<string, string>` and this package already holds seeded
       * state. What it cannot fake is the half the replies are *about*. Every
       * one of these three carries the host's record of **who wrote a key
       * last**: `storage.clear` answers `{ removed, foreign }`, where `foreign`
       * counts the keys this card wiped that another card had written, and that
       * number exists precisely so a reader can be told what a `clear()` cost
       * them. A fake that returned `foreign: 0` would be inventing the answer
       * to the only question the field was added for, and inventing it in the
       * reassuring direction.
       *
       * The store is also **profile-wide shared**, which is the compatibility
       * behaviour rather than an accident — two cards choosing one key see each
       * other's values, as they do on one origin upstream. Sharing across a
       * fake profile that has no other cards in it would make every
       * cross-card effect invisible in development and visible only in front of
       * a user, which is the failure this package exists to prevent.
       *
       * So a card developing against the fake sees its writes refused and
       * reported, takes its own empty-storage path, and finds out here rather
       * than later that this host does not keep anything.
       *
       * 49's placeholder for these three put it in one line that is worth
       * keeping: refused for the reason `setVariables` is refused, which applies
       * here word for word — modelling the sharing, plus the last-writer
       * attribution a removal reports, would put a second copy of the rule in
       * the half that is not authoritative.
       */
      // The one-time cleanup offer is answered against a real chat file; a fake
      // client has none to sweep, and pretending otherwise would let a caller
      // believe a deletion happened.
      // A run only exists inside a real frame, so a fake client has none to end.
      // The preset library is host-side files (`OpenAI Settings`-shaped, one
      // preset per file); a fake has no filesystem to keep them in, so a seeded
      // page refuses rather than answering from an imaginary library — the same
      // honesty `storage.*` is refused with.
      case 'script.runEnded':
      // Chat files are host-side; a fake has no store to copy them into or
      // out of, so the migration arms refuse rather than pretend.
      case 'chat.import':
      case 'chat.export':
      case 'chat.answerCleanup':
      case 'storage.set':
      case 'storage.remove':
      case 'storage.clear':
      case 'preset.list':
      case 'preset.select':
      case 'preset.view':
      case 'preset.setEnabled':
      case 'preset.move':
      case 'preset.upsertPrompt':
      case 'preset.removePrompt':
      case 'preset.save':
      case 'preset.delete':
      case 'preset.read':
      case 'preset.import':
      case 'preset.importFile': {
        throw new FakeRpcError('unsupported', `the fake client does not implement ${method}`)
      }

      case 'persona.list':
      case 'persona.get':
      case 'persona.set':
      case 'persona.delete': {
        /*
         * Refused as a group, and the refusal is the honest answer rather than a
         * stand-in for one. A persona's whole effect is on prompt assembly — the
         * `personaDescription` slot, the depth injection, the `{{persona}}`
         * macro and the world-info scan data — and this client assembles no
         * prompts. Answering `persona.list` with an empty list would read as
         * "configured, none yet" and invite building a panel whose every write
         * lands nowhere; answering `persona.get` with an invented description
         * would be worse. A host that has one shows the real state.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client keeps no persona store, so ${method} has nothing true to answer with`,
        )
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

  /**
   * A character id from a card's name, unique against the cards that exist.
   *
   * Mirrors the host's `uniqueId(toId(name), existing)`, including that a freed
   * id is handed out again.
   * @param name - the card's name.
   * @returns the id to store it under.
   */
  #mintCharacterId(name: string): string {
    const base =
      name
        .normalize('NFC')
        .replace(/[\s]+/gu, '-')
        .replace(/[^\p{L}\p{N}._-]/gu, '')
        .replace(/^[.\-]+|[.\-]+$/g, '')
        .slice(0, 100) || 'unnamed'
    const taken = (candidate: string): boolean =>
      this.#characters.some(row => row.characterId === candidate)
    if (!taken(base)) return base
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${String(suffix)}`
      if (!taken(candidate)) return candidate
    }
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
    this.#emit({
      type: 'stream.end', chatId, turn: stream.turn,
      view: toChatView(this.#require(chatId)), reason: 'aborted',
    })
  }

  /**
   * Schedule one generation.
   *
   * Timer-driven rather than an async loop, for two reasons: `chat.abort` gets
   * something concrete to cancel, and a test can run the whole thing at zero
   * delay without the ordering shifting under it.
   *
   * `seed` opens the buffer with existing text (a continue), and `role`/`name`
   * say who the arriving text belongs to (an impersonation) — both forwarded
   * exactly the way the host forwards its own.
   */
  #beginTurn(
    chat: FakeChat,
    turn: number,
    messageIndex: number,
    candidate: number,
    seed = '',
    role?: 'user',
    name?: string,
  ): void {
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
      this.#emit({
        type: 'stream.start', chatId, turn, key: `a${String(turn)}`,
        ...seed === '' ? {} : { seed },
        ...role === undefined ? {} : { role, name: name ?? '' },
      })
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
      this.#emit({ type: 'stream.end', chatId, turn, view: toChatView(chat), reason: 'completed' })
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
