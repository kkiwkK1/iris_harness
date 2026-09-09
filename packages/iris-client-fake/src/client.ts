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
  toEntryDigest,
  type CharacterSummary,
  type ChatSearchHit,
  type ChatSearchMatch,
  type ChatSummary,
  type GenerationSettings,
  type HostDefaultConnection,
  type IrisClient,
  type IrisEvent,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RegexScriptView,
  type RpcResponse,
  type ScopedRegexView,
  type ScriptView,
  type UserScript,
  type UserScriptView,
} from '@iris/protocol'

import { chunk, replyFor, reasoningFor } from './corpus.ts'
import { cardFileExtension, readCard } from './card.ts'
import { fakeDivergence, fakeItemization } from './prompt.ts'
import {
  activateConnection,
  deleteConnection,
  hostDefault,
  listConnections,
  saveConnection,
} from './connections.ts'
import { mergeOverrides, mergeSettings } from './settings.ts'
import {
  DEFAULT_SETTINGS,
  FAKE_GLOBAL_REGEX,
  FAKE_LIBRARY,
  FAKE_SCOPED_REGEX,
  FAKE_SCRIPTS,
  FAKE_SUMMARY,
  seedCharacters,
  seedChats,
} from './seed.ts'
import {
  fakeBookEntries,
  fakeCardWorldbook,
  FAKE_CARD_BINDINGS,
  FAKE_GLOBAL_SELECT,
  FAKE_WORLDBOOKS,
  type FakeWorldbook,
} from './worldbooks.ts'
import {
  selected, summariseFakeUsage, toChatSummary, toChatView,
  type FakeChat, type FakeMessage,
} from './state.ts'

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

/**
 * One library script as a listing row.
 *
 * `bytes` is `Buffer.byteLength`'s answer where the host computes it; in the
 * browser there is no `Buffer`, so this uses `TextEncoder`, which measures the
 * same UTF-8 bytes. Not `String.length`: a JS string's length is UTF-16 code
 * units, so a Chinese body reports about a third of its real size, and this
 * number is shown to someone deciding whether to run that code.
 * @param script - the stored script.
 * @param scope - which repository it lives in.
 * @returns the row.
 */
function libraryView(script: UserScript, scope: 'global' | 'character'): UserScriptView {
  return {
    id: script.id,
    name: script.name,
    ...script.info === undefined || script.info === '' ? {} : { info: script.info },
    enabled: script.enabled,
    scope,
    ...script.button === undefined ? {} : {
      buttons: script.button.buttons.map(button => ({ ...button })),
      buttonsEnabled: script.button.enabled,
    },
    bytes: new TextEncoder().encode(script.content).length,
  }
}

/**
 * One library row as the runnable script list carries it.
 *
 * `enabledByCard: true` is a statement rather than a filler: there is no card
 * author to disagree with about a script the user wrote, so the pair collapses.
 * A `false` here would make the script panel hide the toggle on the user's own
 * script and blame a card for it.
 * @param row - the listing row.
 * @returns the runnable-list row.
 */
function libraryRow(row: UserScriptView): ScriptView {
  return {
    id: row.id,
    name: row.name,
    source: row.scope,
    ...row.info === undefined ? {} : { info: row.info },
    enabledByCard: true,
    enabled: row.enabled,
    ...row.buttons === undefined ? {} : { buttons: row.buttons.map(button => ({ ...button })) },
    ...row.buttonsEnabled === undefined ? {} : { buttonsEnabled: row.buttonsEnabled },
    bytes: row.bytes,
  }
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
  /**
   * The profile's global regex tier, in this fake's memory.
   *
   * **This arm used to refuse**, on the argument that a fake has no profile on
   * disk and an imaginary list would let a panel believe an import had landed.
   * The argument was about the wrong thing: an import into this list *does*
   * land, and `regex.list` reports it — which is the same truthfulness the fake
   * already claims for `scriptsAllowed` and the document grants, which are also
   * host-side files it holds in memory. What the refusal actually did was leave
   * the regex panel returning `null` in every render this repo can run without
   * a host, so nothing pinned it and the editor added in this round would have
   * had nowhere to be checked.
   */
  #globalRegex: RegexScriptView[] = FAKE_GLOBAL_REGEX.map(script => ({ ...script }))
  /** Whether the user allows each card's own regex tier. Absent means allowed. */
  readonly #regexAllowed = new Map<string, boolean>()
  /** User overrides of a scoped regex rule, keyed `characterId/scriptId`. */
  readonly #regexOverrides = new Map<string, boolean>()
  /** The user's own script library: one global repository and one per card. */
  readonly #library: { global: UserScript[], characters: Record<string, UserScript[]> } = {
    global: FAKE_LIBRARY.global.map(script => ({ ...script })),
    characters: Object.fromEntries(
      Object.entries(FAKE_LIBRARY.characters).map(([id, rows]) => [id, rows.map(row => ({ ...row }))]),
    ),
  }
  #globalSettings: GenerationSettings
  #listeners = new Set<(event: IrisEvent) => void>()
  #connectionListeners = new Set<(connected: boolean) => void>()
  #streams = new Map<string, Streaming>()
  #connected = true
  #chunkDelayMs: number
  #chunkCount: number
  #nextId = 1
  /**
   * The books selected for every chat.
   *
   * Held rather than refused, unlike the other world-book writes: a selection
   * is a list of names, this client has the books to check them against, and
   * the next `worldbook.globalSelect` read can therefore show what the write
   * did. The writes that stay refused are the ones whose whole effect is
   * downstream of a prompt assembly this client does not perform.
   */
  #globalSelect: string[]
  /**
   * The named books this client holds.
   *
   * Emptied by the same `empty` switch that empties the library, so the
   * no-books state — which the panel has its own rendering for, and which every
   * fresh profile is in — stays reachable without a second option.
   */
  readonly #worldbooks: readonly FakeWorldbook[]
  /**
   * Whether this client's host row carries a recorded model list.
   *
   * Per client rather than per module, unlike the profiles: on a real host the
   * host row's list lives in the service process's memory and is therefore
   * absent on every launch until something probes. Both shapes have a reader —
   * the composer's model menu offers the list when there is one and offers to
   * fetch one when there is not — so both have to be renderable, and the
   * `empty` switch that already means "show me the first-run states" is the
   * honest place to hang it.
   */
  readonly #hostModels: boolean

  constructor(options: FakeClientOptions) {
    this.#chats = options.empty === true ? [] : seedChats()
    this.#characters = options.empty === true ? [] : seedCharacters()
    this.#worldbooks = options.empty === true ? [] : FAKE_WORLDBOOKS
    this.#globalSelect = options.empty === true ? [] : [...FAKE_GLOBAL_SELECT]
    this.#hostModels = options.empty !== true
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

      /*
       * The fake compacts for real, minus the model.
       *
       * It picks the same span the host does with retention zero — everything
       * but the newest floor — and writes a canned summary. That is enough for
       * the surfaces to be exercised (the marker appears, the capacity meter
       * moves, a second compaction folds in what the first left out) and it is
       * honest about the one thing it cannot do: the summary text is a fixture,
       * not a reading of the conversation, and the note below says so on screen.
       */
      case 'chat.compact': {
        const { chatId } = params as RpcRequest<'chat.compact'>
        const chat = this.#require(chatId)
        if (this.#streams.has(chatId)) throw new FakeRpcError('busy', 'this chat is generating')
        const covered = chat.messages.length - 1
        const already = chat.compaction?.count ?? 0
        if (covered <= already) return { view: toChatView(chat), compacted: null }
        // Four characters to a token, the same crude ratio the fake's other
        // token figures use — this is a fixture, not an estimator.
        const spanTokens = Math.max(
          1,
          Math.ceil(chat.messages.slice(already, covered)
            .reduce((sum, row) => sum + selected(row).text.length, 0) / 4),
        )
        const summary = FAKE_SUMMARY
        chat.compaction = {
          count: covered,
          summary,
          spanTokens,
          // Held strictly under the span, because the host refuses a summary
          // that is not smaller and a fixture violating that rule would let a
          // surface render a state the host cannot produce.
          summaryTokens: Math.min(Math.ceil(summary.length / 4), Math.max(1, spanTokens - 1)),
          at: Date.now(),
          model: chat.settings.model,
        }
        /*
         * **The summary request's own bill**, because the host records one:
         * `#summarize` goes through `#stream` with `source: 'compaction'`, and
         * the record lands on the header beside a card's generations. A fake
         * that compacted for free would render a compacted conversation with no
         * compaction share — a state the product can no longer produce, and
         * exactly the one a surface reading that share has to be exercised on.
         *
         * The figures are the fake's own crude ratio and not a reading: the
         * span it just replaced is what went out as the prompt, the summary is
         * what came back. No cache bucket, so the absent-versus-zero rule stays
         * live inside the share as well as outside it.
         */
        chat.sideUsage = [...chat.sideUsage ?? [], {
          inputTokens: spanTokens,
          outputTokens: chat.compaction.summaryTokens,
          model: chat.settings.model,
          provider: chat.settings.provider,
          at: chat.compaction.at,
          source: 'compaction',
        }]
        chat.updatedAt = Date.now()
        return {
          view: toChatView(chat),
          compacted: {
            floors: covered - already,
            spanTokens,
            summaryTokens: chat.compaction.summaryTokens,
          },
        }
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
        return this.#withHostRow(listConnections())

      case 'connection.save':
        return this.#withHostRow(saveConnection(params as RpcRequest<'connection.save'>))

      case 'connection.delete': {
        const { id } = params as RpcRequest<'connection.delete'>
        const result = deleteConnection(id)
        if (result === undefined) throw new FakeRpcError('not-found', `no connection "${id}"`)
        return this.#withHostRow(result)
      }

      case 'connection.activate': {
        const { id, chatId } = params as RpcRequest<'connection.activate'>
        const result = activateConnection(id)
        if (result === undefined) throw new FakeRpcError('not-found', `no connection "${id}"`)
        // Activating writes through to whichever settings scope was named, so the
        // interface sees the same effect the real host would produce rather than a
        // list that changed and a chat that did not.
        if (chatId === undefined) {
          this.#globalSettings = { ...result.settings }
        } else {
          const chat = this.#require(chatId)
          // A chat-scoped activation is a chat-scoped decision, so it lands in
          // that chat's override layer as well as its merged read — otherwise
          // the interface would show the new route with no way to tell it from
          // the global default and no way to put it back.
          chat.settingsOverride = mergeOverrides(chat.settingsOverride ?? {}, { ...result.settings })
          chat.settings = { ...result.settings }
        }
        return result
      }

      case 'connection.test':
        // Refused, not modelled: the one thing this method exists to do is put
        // a request on a real network, and faking a latency or an error code
        // would let a connection form teach the interface a verdict no
        // endpoint ever gave. An interface developed against the fake sees
        // this refusal in dev, where its absence of a real probe is visible —
        // not against a host, where it would be a lie.
        //
        // What the fake *does* serve is the **recorded** list on each profile
        // (`connections.ts`), which is fixture data about a profile rather than
        // a verdict about a network — so the model pickers have something real
        // to render here without anyone inventing a probe result.
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

      case 'prompt.divergence': {
        const { chatId } = params as RpcRequest<'prompt.divergence'>
        const chat = this.#require(chatId)
        // Two recorded requests are needed for there to be a comparison at all.
        // The absence is modelled as carefully as the answer, because a UI that
        // only ever meets the answer draws the empty state wrong — and the empty
        // state is what the first turn of every conversation shows.
        const generations = chat.messages.filter(message => message.role === 'assistant').length
        if (generations < 2) return {}
        return { divergence: fakeDivergence(chatId) }
      }

      case 'character.list':
        return { characters: this.#characters.map(row => ({ ...row, tags: [...row.tags] })) }

      case 'character.import': {
        const { filename, content } = params as RpcRequest<'character.import'>
        // The same refusal, in the same words, as the host's `library.import`:
        // a `.charx` dropped on the fake must fail the way it fails against a
        // host, or the shell's refusal notice can only be seen with one running.
        if (cardFileExtension(filename) === '.charx') {
          throw new FakeRpcError('unsupported', '.charx cards are not supported yet')
        }
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
          // What a host would summarise off the same file, as far as a reader
          // with no card decoder can get — see `readCard` for why `scriptCount`
          // is not among them.
          ...(card.description === undefined ? {} : { description: card.description }),
          ...(card.bookEntryCount === undefined ? {} : { bookEntryCount: card.bookEntryCount }),
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

      // `overrides` rides along **only when a chat was named** — the contract
      // makes presence mean scope, so `{}` says "this chat overrides nothing"
      // and absent says "you read the bottom layer".
      case 'settings.get': {
        const { chatId } = params as RpcRequest<'settings.get'>
        if (chatId === undefined) return { settings: { ...this.#globalSettings } }
        const chat = this.#require(chatId)
        return {
          settings: { ...chat.settings },
          overrides: { ...chat.settingsOverride },
        }
      }

      case 'settings.set': {
        const { chatId, settings } = params as RpcRequest<'settings.set'>
        if (chatId === undefined) {
          this.#globalSettings = mergeSettings(this.#globalSettings, settings)
          return { settings: { ...this.#globalSettings } }
        }
        const chat = this.#require(chatId)
        // Both layers move together, and the merged read is rebuilt from the
        // global one **plus** the new override rather than patched in place:
        // that is the only way clearing an override (`null`) can let the layer
        // below show through, which is what a "back to the default" control
        // asks for.
        const override = mergeOverrides(chat.settingsOverride ?? {}, settings)
        chat.settingsOverride = override
        chat.settings = { ...this.#globalSettings, ...override }
        return { settings: { ...chat.settings }, overrides: { ...override } }
      }

      case 'script.list': {
        const { characterId } = params as RpcRequest<'script.list'>
        this.#requireCharacter(characterId)
        const answered = this.#scriptsAllowed.get(characterId)
        return {
          scripts: this.#runnableScripts(characterId),
          documentGranted: this.#grants.has(characterId),
          // Omitted when unanswered rather than sent as `false`, because the
          // reader is expected to test presence. A `false` here would mean "was
          // asked and declined" and would suppress the first-run question
          // permanently, with nothing reporting that it had.
          ...(answered === undefined ? {} : { scriptsAllowed: answered }),
        }
      }

      case 'script.setEnabled': {
        const { characterId, scriptId, enabled, source } = params as RpcRequest<'script.setEnabled'>
        this.#requireCharacter(characterId)
        if (source !== undefined && source !== 'card') {
          const mine = this.#libraryList(source, source === 'global' ? undefined : characterId)
            .find(row => row.id === scriptId)
          if (mine === undefined) throw new FakeRpcError('not-found', `no ${source} script "${scriptId}"`)
          mine.enabled = enabled
          return { scripts: this.#runnableScripts(characterId) }
        }
        // Against *this card's* list, not the whole pack: a card that ships no
        // scripts has no script to switch, and answering otherwise would let a
        // caller store an override the list it reads back never shows.
        if (!this.#scriptViews(characterId).some(script => script.id === scriptId)) {
          throw new FakeRpcError('not-found', `no script "${scriptId}"`)
        }
        this.#scriptOverrides.set(`${characterId}/${scriptId}`, enabled)
        return { scripts: this.#runnableScripts(characterId) }
      }

      /*
       * The regex tiers and the script library, held in memory.
       *
       * Answered rather than refused, on the line the fake already drew for
       * `script.setScriptsAllowed`: these carry no merge rule and no assembly a
       * fake would have to imitate — a list, two switches per card, and a small
       * store the user writes. What a fake cannot honestly model is a script
       * *body* or a remote fetch, and both of those stay refused below.
       */
      case 'regex.list':
        return { scripts: this.#globalRegex.map(script => ({ ...script })) }

      case 'regex.set': {
        const { scripts } = params as RpcRequest<'regex.set'>
        // Ids minted where an import has none, exactly as the host does: the
        // panel's toggle and reorder are read-modify-writes over what it last
        // read, and a row with no id would come back as a stranger each time.
        this.#globalRegex = scripts.map(script => ({
          ...script,
          ...script.id === undefined ? { id: `fake-regex-${String(this.#nextId++)}` } : {},
        }) as RegexScriptView)
        return { scripts: this.#globalRegex.map(script => ({ ...script })) }
      }

      case 'regex.scopedList': {
        const { characterId } = params as RpcRequest<'regex.scopedList'>
        this.#requireCharacter(characterId)
        return this.#scopedRegexView(characterId)
      }

      case 'regex.setScopedAllowed': {
        const { characterId, allowed } = params as RpcRequest<'regex.setScopedAllowed'>
        this.#requireCharacter(characterId)
        // `true` deletes and `false` is written, because absent already means
        // allowed here — the host's own convention, and two spellings of one
        // state is how a reader eventually treats them differently.
        if (allowed) this.#regexAllowed.delete(characterId)
        else this.#regexAllowed.set(characterId, false)
        return this.#scopedRegexView(characterId)
      }

      case 'regex.setScopedEnabled': {
        const { characterId, scriptId, enabled } = params as RpcRequest<'regex.setScopedEnabled'>
        this.#requireCharacter(characterId)
        if (!(FAKE_SCOPED_REGEX[characterId] ?? []).some(script => script.id === scriptId)) {
          throw new FakeRpcError('not-found', `no regex script "${scriptId}"`)
        }
        this.#regexOverrides.set(`${characterId}/${scriptId}`, enabled)
        return this.#scopedRegexView(characterId)
      }

      case 'scriptLibrary.list': {
        const { characterId } = params as RpcRequest<'scriptLibrary.list'>
        if (characterId !== undefined) this.#requireCharacter(characterId)
        return { scripts: this.#libraryViews(characterId) }
      }

      case 'scriptLibrary.read': {
        const { scope, characterId, id } = params as RpcRequest<'scriptLibrary.read'>
        this.#requireScope(scope, characterId)
        const script = this.#libraryList(scope, characterId).find(row => row.id === id)
        if (script === undefined) throw new FakeRpcError('not-found', `no ${scope} script "${id}"`)
        return { script: { ...script } }
      }

      case 'scriptLibrary.save': {
        const { scope, characterId, script } = params as RpcRequest<'scriptLibrary.save'>
        this.#requireScope(scope, characterId)
        const list = this.#libraryList(scope, characterId)
        const index = script.id === undefined ? -1 : list.findIndex(row => row.id === script.id)
        // Refused rather than turned into a create, the host's rule: an edit
        // whose target has gone would otherwise reappear as a second copy.
        if (script.id !== undefined && index === -1) {
          throw new FakeRpcError('not-found', `no ${scope} script "${script.id}"`)
        }
        const previous = index === -1 ? undefined : list[index]
        const { id: _id, ...fields } = script
        const stored: UserScript = {
          ...previous,
          // Undefined-valued keys dropped, so a stored record has them absent
          // rather than present-and-undefined: the request is a loose zod
          // object, whose optional keys infer as `T | undefined`. The host's
          // `script-library.ts` does the same, in `present`.
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
          type: 'script',
          // Restated after the spread, because the filter above erases the
          // required fields' types on its way through `Record<string, unknown>`.
          name: script.name,
          content: script.content,
          id: previous?.id ?? `fake-script-${String(this.#nextId++)}`,
          // Upstream's default and the safe direction: a script does not begin
          // running because the user pressed Save.
          enabled: script.enabled ?? previous?.enabled ?? false,
        }
        if (index === -1) list.push(stored)
        else list[index] = stored
        return { scripts: this.#libraryViews(characterId), id: stored.id }
      }

      case 'scriptLibrary.delete': {
        const { scope, characterId, id } = params as RpcRequest<'scriptLibrary.delete'>
        this.#requireScope(scope, characterId)
        const list = this.#libraryList(scope, characterId)
        const index = list.findIndex(row => row.id === id)
        if (index === -1) throw new FakeRpcError('not-found', `no ${scope} script "${id}"`)
        list.splice(index, 1)
        return { scripts: this.#libraryViews(characterId) }
      }

      case 'scriptLibrary.setEnabled': {
        const { scope, characterId, id, enabled } = params as RpcRequest<'scriptLibrary.setEnabled'>
        this.#requireScope(scope, characterId)
        const script = this.#libraryList(scope, characterId).find(row => row.id === id)
        if (script === undefined) throw new FakeRpcError('not-found', `no ${scope} script "${id}"`)
        script.enabled = enabled
        return { scripts: this.#libraryViews(characterId) }
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
       * World books, answered from `worldbooks.ts`' seed.
       *
       * **These used to answer as a host with none**, and that was defended as
       * a true answer rather than a stand-in — which it was. What changed is
       * not the honesty argument but which state is worth having reachable. A
       * panel developed against an empty book store gets its empty state
       * polished and its dense state discovered on a user's machine: a reader
       * with nine books and one card could not tell which book was theirs, and
       * no check here could have shown it. The seed's whole design is the
       * *shapes* — a materialised book under a minted name, a hand-bound one,
       * two nobody bound — because those are what the panel groups by.
       *
       * The empty state is still reachable, and by the same switch that empties
       * the library: `createFakeClient({empty: true})` seeds no books either.
       *
       * The **writes** below are unchanged in kind. A selection is held,
       * because this client owns the list it would be held in; the rest stay
       * refused, because their whole effect is on a prompt assembly this client
       * does not perform, and a success it cannot reflect is the failure this
       * package exists to prevent.
       */
      case 'worldbook.names': {
        const { withCounts } = params as RpcRequest<'worldbook.names'>
        const names = this.#worldbooks.map(book => book.name)
        if (withCounts !== true) return { names }
        return {
          names,
          books: this.#worldbooks.map(book => ({
            name: book.name,
            entryCount: book.entryCount,
            ...book.fromCharacterId === undefined ? {} : { fromCharacterId: book.fromCharacterId },
          })),
        }
      }

      case 'worldbook.charNames': {
        const { characterId, withCard } = params as RpcRequest<'worldbook.charNames'>
        /*
         * The card still has to exist. A binding query for a character that is
         * not there is a caller mistake and should read as one, rather than as
         * a card that happens to be bound to nothing.
         */
        const character = this.#characters.find(row => row.characterId === characterId)
        if (character === undefined) {
          throw new FakeRpcError('not-found', `no character "${characterId}"`)
        }
        /*
         * `additional` stays empty, and stays empty for a reason rather than
         * for want of a fixture: `worldbook.setCharBooks` below is refused, so
         * a non-empty list here would be one no write could have produced and
         * no write can change — an interface would show extra bindings that
         * cannot be edited off.
         *
         * `card` is answered only when asked for — the flag is what keeps the
         * names-only member cheap on a real host, and a fake that answered it
         * unasked would let a caller forget to ask. It is omitted with the
         * books, not with the library: a client with no book store has no
         * answer to "which book plays", and `none` there would be a claim
         * rather than an admission.
         */
        const primary = FAKE_CARD_BINDINGS[characterId]?.primary ?? null
        if (withCard !== true || this.#worldbooks.length === 0) return { primary, additional: [] }
        return {
          primary,
          additional: [],
          card: fakeCardWorldbook(characterId, character.bookEntryCount),
        }
      }

      /*
       * The character page's listing, answered for the shapes this client
       * actually models and refused for the one it does not.
       *
       * **Which book is the card's own is `fakeCardWorldbook`'s answer**, not a
       * second resolution — the same transcription of the host's rule that
       * `worldbook.charNames` above hands back, so a page cannot be shown one
       * book here and another there. The entries are `fakeBookEntries`', mapped
       * through the contract's own `toEntryDigest`: the host maps real books
       * with that function, so a page reading this cannot tell the two apart by
       * which fields arrived, which is the drift a hand-copied mapper here would
       * have introduced.
       *
       * `additional` is empty, because `worldbook.setCharBooks` is refused and
       * `charNames` answers `additional: []` unconditionally — an extra book
       * here would be one no write could have produced.
       */
      case 'worldbook.charDigest': {
        const { characterId } = params as RpcRequest<'worldbook.charDigest'>
        const character = this.#characters.find(row => row.characterId === characterId)
        if (character === undefined) {
          throw new FakeRpcError('not-found', `no character "${characterId}"`)
        }
        // The store-less host's refusal, reproduced: `createFakeClient({empty:
        // true})` seeds no books, and an empty list there would say "this card
        // carries no world info" about a card nothing looked at.
        if (this.#worldbooks.length === 0) {
          throw new FakeRpcError('not-found', `world books for "${characterId}"`)
        }
        const view = fakeCardWorldbook(characterId, character.bookEntryCount)
        const seeded = view.name === null
          ? undefined
          : FAKE_WORLDBOOKS.find(book => book.name === view.name)
        if (view.name === null) return { books: [] }
        if (seeded === undefined) {
          /*
           * The card carries a book this client holds no entries for — an
           * *imported* card, whose `character_book` this package deliberately
           * does not decode (`card.ts` reads its length and nothing else).
           * Refused rather than answered `entries: []`, which the page would
           * count and render as 「0 条」 — a book reported empty when what is
           * empty is this client's knowledge of it.
           */
          throw new FakeRpcError(
            'unsupported',
            `the fake client holds no entries for "${view.name}", only the count`,
          )
        }
        return {
          books: [{
            name: seeded.name,
            source: 'named',
            role: 'card',
            ...view.materialised ? { materialised: true } : {},
            entries: fakeBookEntries(seeded).map(toEntryDigest),
          }],
        }
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
        return { names: [...this.#globalSelect] }
      }

      case 'worldbook.setGlobalSelect': {
        const { names } = params as RpcRequest<'worldbook.setGlobalSelect'>
        /*
         * Held, where it used to be refused — and the reason it used to be
         * refused is what makes holding it correct now.
         *
         * The old refusal's argument was that an empty store would skip every
         * name and answer `{names: []}`, a success byte-identical to having
         * selected nothing. That argument was about the **skip**, not about the
         * write: the contract says a name with no file behind it is simply
         * skipped, so a selection over a store that *has* books is a write
         * whose effect this client can both perform and show — the next
         * `worldbook.globalSelect` read answers with it.
         *
         * The skip is reproduced rather than being an error, because that is
         * upstream's behaviour and the host's, and it is why the answer is read
         * back from the stored list instead of echoing the argument.
         */
        this.#globalSelect = names.filter(name => this.#worldbooks.some(book => book.name === name))
        return { names: [...this.#globalSelect] }
      }

      case 'worldbook.replace': {
        const { name } = params as RpcRequest<'worldbook.replace'>
        /*
         * Still refused, and the seed above does not change that — but it does
         * change the reason, so the message says the real one.
         *
         * Upstream's `replaceWorldbook` rebuilds the stored book entirely from
         * the array it is handed — entries absent from it are gone — and it also
         * **renumbers**: missing uids are assigned at random and `displayIndex`
         * is reassigned from array position, so a round trip reorders the file.
         * This client does not model that renumbering. Accepting the write and
         * answering with the entries as sent would teach a caller that a save
         * round-trips unchanged, which on a real host it does not; that is the
         * "passes here, breaks in production" failure this package exists to
         * prevent, and it is worse than an honest refusal.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client does not model upstream's uid and displayIndex renumbering, so a whole-book`
          + ` replace of "${name}" would not round-trip the way a real host's does`,
        )
      }

      case 'worldbook.load': {
        const { name } = params as RpcRequest<'worldbook.load'>
        /*
         * The **raw saved shape**, `entries` keyed by uid — not the normalised
         * array `worldbook.get` answers with. The two upstream APIs for one
         * book return different shapes on purpose, and MVU's guard is literally
         * `isPlainObject(loaded) && isPlainObject(loaded.entries)`, so handing
         * back the array form here is exactly what produces its "Failed to read
         * character-card configuration".
         *
         * An empty name is upstream's absent answer (`if (!name) return;`), and
         * a name with no book is `null` — both kept, because a caller reads the
         * two differently.
         */
        if (name === '') return {}
        if (!this.#worldbooks.some(row => row.name === name)) return { book: null }
        /*
         * A **seeded** name is refused rather than answered, and this is the
         * one arm the seed made worse instead of better.
         *
         * The saved shape is not the shape `fakeBookEntries` produces: on disk
         * an entry carries `key`, `keysecondary`, `comment`, a numeric
         * `position` and a `displayIndex`, and turning the protocol's
         * `WorldbookEntry` back into that is the host's `fromWorldbookEntry` —
         * a mapping with documented asymmetries, in a package this client does
         * not depend on. Transcribing it here would be a second implementation
         * of it, free to drift.
         *
         * Answering with the normalised array instead would be worse than
         * either: it passes MVU's guard (`isPlainObject(loaded.entries)`) and
         * is then read field by field as something it is not. `null` is worse
         * still — the book is right there in `worldbook.names`.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client holds "${name}" in the protocol's entry shape, not the raw saved shape this`
          + ` method answers with, and inventing that shape is what it refuses to do`,
        )
      }

      case 'worldbook.get': {
        const { name } = params as RpcRequest<'worldbook.get'>
        /*
         * Not-found rather than an empty entry list for a name that is not
         * seeded, and the difference is the one a caller acts on: "this book has
         * no entries" and "there is no such book" lead to different repairs.
         */
        const book = this.#worldbooks.find(row => row.name === name)
        if (book === undefined) throw new FakeRpcError('not-found', `no world book named ${name}`)
        return { entries: fakeBookEntries(book) }
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
         * Refused like `worldbook.replace`. The seed is a constant, so a
         * creation this client accepted would answer `{created: true}` with
         * nothing behind it, and the caller's next `worldbook.get` — the
         * get-or-create pattern cards actually write — would then fail on a
         * book it was just told exists.
         *
         * `already-exists` for a seeded name is answered as upstream answers
         * it, with `false` rather than an error: that is a normal outcome of
         * get-or-create and this client can tell the truth about it.
         */
        if (this.#worldbooks.some(book => book.name === name)) return { created: false }
        throw new FakeRpcError(
          'unsupported',
          `the fake client's world books are a fixed seed, so "${name}" cannot be created`,
        )
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

      case 'worldbook.setCharBooks': {
        const { characterId, names } = params as RpcRequest<'worldbook.setCharBooks'>
        /*
         * Refused, for the same reason `worldbook.bindChat` is: the write's
         * whole effect is on what the next scan admits, and this client runs no
         * scan and keeps no `charLore` store. Accepting it would let a card
         * believe a character now plays with an extra book that no read here
         * can ever confirm — `worldbook.charNames` above answers
         * `additional: []` unconditionally, so the apparent persist would be
         * contradicted by the very next read.
         */
        throw new FakeRpcError(
          'unsupported',
          `the fake client models no character world book bindings (asked to bind ${String(names.length)}`
          + ` book(s) to '${characterId}')`,
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
      case 'preset.importFile':
      // The character manager writes host-side files: a rename or a tag edit
      // rewrites a card on disk, a duplicate copies one, an export reads one
      // out, and a star lands in the profile's favorites file. The fake has no
      // filesystem, and the one thing worse than refusing is a panel that
      // believes a rename landed while the list keeps showing the old name —
      // the next `character.list` would contradict it. The seeded summaries
      // above stay read-only, exactly as `preset.*` stays refused.
      case 'character.duplicate':
      case 'character.rename':
      case 'character.export':
      case 'character.setTags':
      case 'character.favorite':
      // Snapshots are files under the host's profile, taken before operations
      // this client does not perform — it never deletes a floor to a file, so
      // it would never have anything to list, preview, restore or delete. An
      // empty list in particular would read as "protected, nothing yet" about
      // a store that does not exist, which is the all-clear-without-a-host
      // lie `debug.reports` is refused for.
      case 'backup.list':
      case 'backup.preview':
      case 'backup.restore':
      case 'backup.delete': {
        throw new FakeRpcError('unsupported', `the fake client does not implement ${method}`)
      }

      case 'usage.summary': {
        // Implemented rather than refused, unlike the backup methods above:
        // those need a file store the fake does not have, while this one is
        // arithmetic over the log the fake already keeps — and the usage page
        // is a chart, which is the one kind of surface that cannot be designed
        // against an `unsupported`.
        const { since, until, granularity } = params as RpcRequest<'usage.summary'>
        return {
          summary: summariseFakeUsage(this.#chats, {
            ...since === undefined ? {} : { since },
            ...until === undefined ? {} : { until },
            ...granularity === undefined ? {} : { granularity },
          }),
        }
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

  /**
   * The script list, with both switches reported as the contract asks.
   *
   * Answered from the card's own summary, so `character.list`'s `scriptCount`
   * and this list are two readings of one fact rather than two facts that can
   * drift. A card carrying no count carries no scripts — which is the state a
   * plain V1 card and every card imported into the fake are in, and the state
   * the panel's "this card ships no scripts" branch exists for.
   */
  #scriptViews(characterId: string): ScriptView[] {
    const summary = this.#characters.find(row => row.characterId === characterId)
    const count = summary?.scriptCount ?? 0
    return FAKE_SCRIPTS.slice(0, count).map(script => ({
      id: script.id,
      name: script.name,
      source: 'card',
      ...script.info === undefined ? {} : { info: script.info },
      enabledByCard: script.enabledByCard,
      enabled: this.#scriptOverrides.get(`${characterId}/${script.id}`) ?? script.enabledByCard,
      bytes: script.bytes,
    }))
  }

  /**
   * Every script that would run in this character's conversations, in run order.
   *
   * The user's global library, then the card's own, then the user's library for
   * this card — upstream's own merge order for its three repositories, with the
   * card's tier standing in for the preset one. The order is data: two scripts
   * writing the same variable settle it by which ran last, so a fake that
   * listed them in a different order would be teaching the shell a sequence the
   * host does not use.
   * @param characterId - whose conversations.
   * @returns the rows, switched-off ones included.
   */
  #runnableScripts(characterId: string): ScriptView[] {
    const mine = this.#libraryViews(characterId)
    return [
      ...mine.filter(row => row.scope === 'global').map(libraryRow),
      ...this.#scriptViews(characterId),
      ...mine.filter(row => row.scope === 'character').map(libraryRow),
    ]
  }

  /**
   * One card's own regex tier, with both switches reported.
   *
   * Listed whether or not the tier is allowed, as upstream's own panel lists it:
   * a refused tier answering with an empty list would read as a card carrying no
   * rules, and the control that changes the user's mind would have nothing to
   * sit beside.
   * @param characterId - whose card.
   * @returns the rows and the allow state.
   */
  #scopedRegexView(characterId: string): { scripts: ScopedRegexView[], allowed: boolean } {
    const scripts = (FAKE_SCOPED_REGEX[characterId] ?? []).map(script => {
      const byCard = script.disabled !== true
      return {
        script: { ...script },
        enabledByCard: byCard,
        enabled: this.#regexOverrides.get(`${characterId}/${String(script.id)}`) ?? byCard,
      }
    })
    // `!== false`: absent means allowed, the host's convention.
    return { scripts, allowed: this.#regexAllowed.get(characterId) !== false }
  }

  /**
   * One library repository, by reference.
   * @param scope - which repository.
   * @param characterId - required for `'character'`.
   * @returns the live array.
   */
  #libraryList(scope: 'global' | 'character', characterId: string | undefined): UserScript[] {
    if (scope === 'global') return this.#library.global
    if (characterId === undefined) {
      throw new FakeRpcError('invalid-request', 'a character script repository needs a character id')
    }
    return this.#library.characters[characterId] ??= []
  }

  /**
   * Check a library request's scope against the id beside it.
   *
   * Refused rather than ignored: a caller sending a character id with a global
   * write believes the write is scoped, and a store that dropped the id would
   * put the script in every conversation while the panel said otherwise.
   * @param scope - which repository the caller named.
   * @param characterId - the id beside it, if any.
   */
  #requireScope(scope: 'global' | 'character', characterId: string | undefined): void {
    if (scope === 'global') {
      if (characterId !== undefined) {
        throw new FakeRpcError('invalid-request', 'the global script repository takes no character id')
      }
      return
    }
    if (characterId === undefined) {
      throw new FakeRpcError('invalid-request', 'a character script repository needs a character id')
    }
    this.#requireCharacter(characterId)
  }

  /**
   * The library as a listing: global first, then this character's.
   * @param characterId - whose repository to include beside the global one.
   * @returns one row per stored script.
   */
  #libraryViews(characterId?: string): UserScriptView[] {
    const rows = this.#library.global.map(script => libraryView(script, 'global'))
    if (characterId !== undefined) {
      for (const script of this.#library.characters[characterId] ?? []) {
        rows.push(libraryView(script, 'character'))
      }
    }
    return rows
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

  /**
   * Put this client's own host row on a connection answer.
   *
   * The profiles are module state — one seeded list every client shares — but
   * whether the *host* row carries a recorded model list is this client's
   * decision, because it is the one thing about that row a launch decides
   * rather than a user. Applied to all three connection answers, not just the
   * list: a save has no business turning a never-probed host into a probed one.
   * @param listed - the answer as the module built it.
   * @returns the same answer with the host row this client projects.
   */
  #withHostRow<T extends { host: HostDefaultConnection }>(listed: T): T {
    if (this.#hostModels) return listed
    return { ...listed, host: hostDefault({ models: false }) }
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
      // Before the view is built, because `stream.end` carries the settled view
      // and the cost is part of what settled — the host attaches it on the same
      // boundary and sends no separate event, so a fake that emitted one would
      // let the interface be built against a frame that does not exist.
      this.#recordUsage(chat, messageIndex, role)
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
   * Invent a plausible cost for a settled generation.
   *
   * Arithmetically self-consistent rather than random: the prompt grows with
   * the conversation, the cache serves more of it the longer the chat gets (a
   * cold first turn, then hits), and `totalTokens` is the sum of the disjoint
   * buckets — so a surface computing a hit rate from these gets a number that
   * moves the way a real one does instead of one that jitters. Every reply the
   * fake generates reports usage, which the real thing does not: the fake's
   * job here is to make the figures *change* while the interface is being
   * built, and the "reports nothing" case is covered by the seeded history,
   * which no generation overwrites.
   *
   * An **impersonation** records nothing: its text is the user's own line, and
   * the host has no candidate to attach a cost to there either.
   */
  #recordUsage(chat: FakeChat, messageIndex: number, role?: 'user'): void {
    if (role === 'user') return
    const message = chat.messages[messageIndex]
    if (message === undefined || message.role !== 'assistant') return
    const candidate = message.candidates[message.index]
    if (candidate === undefined) return

    // The whole conversation so far, at a rough 4 characters per token, plus a
    // fixed allowance for the card and the preset — which is what makes the
    // prompt side grow as the log does.
    const prompt = 1_200 + Math.round(
      chat.messages.reduce((sum, one) => sum + (one.candidates[one.index]?.text.length ?? 0), 0) / 4,
    )
    // Nothing is cached on the first exchange; after that the shared prefix is
    // most of the prompt. Rounded to the 64-token blocks providers report in.
    const cacheRead = message.turn === 0 ? 0 : Math.floor(prompt * 0.75 / 64) * 64
    const output = Math.max(1, Math.round(candidate.text.length / 4))
    const reasoning = candidate.reasoning === undefined
      ? undefined
      : Math.max(1, Math.round(candidate.reasoning.length / 4))
    candidate.usage = {
      inputTokens: prompt - cacheRead,
      outputTokens: output + (reasoning ?? 0),
      cacheReadTokens: cacheRead,
      ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
      totalTokens: prompt + output + (reasoning ?? 0),
      // The route and the moment. The host takes both from the composed
      // request; the fake has no request, so it takes them from the same
      // settings a request would have been built from — which is what makes a
      // generation started in the interface appear on the usage chart under the
      // model the capsule beside the composer is showing. A blank model is
      // dropped rather than carried, for the reason the host drops it: an
      // unlabelled series is the unknown case in a known case's clothes.
      ...chat.settings.model === '' ? {} : { model: chat.settings.model },
      ...chat.settings.provider === '' ? {} : { provider: chat.settings.provider },
      at: Date.now(),
    }
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
