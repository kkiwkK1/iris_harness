/**
 * The protocol methods, implemented over the domain packages.
 *
 * Nothing here re-implements roleplay: turns come from `@iris/turn`, swipes
 * from `@iris/chat`, assembly from `@iris/pipeline`, state from
 * `@iris/variables` and `@iris/mvu`, storage from `@iris/persistence`. What
 * this module owns is the orchestration those packages deliberately leave to a
 * caller — which chat is generating, what a turn's variable baseline is, and
 * when the browser is told.
 *
 * The one rule that shapes all of it: **generation is not a response**.
 * `chat.send` resolves as soon as the turn is open, and the reply arrives as
 * `stream.*` events. A method that resolved with the finished text could not be
 * streamed and could not be interrupted.
 *
 * @module @iris/app-service/service
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate, SwipeError } from '@iris/chat'
import type { Contribution, HistoryEntry } from '@iris/pipeline'
import type { ChatCompletionPreset } from '@iris/preset'
import type { GenerationSettings, IrisEvent, RpcMethod, RpcRequest, RpcResponse } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'
import { checkScriptFetch } from '@iris/script'
import { createCalibratingCounter, type CalibratingCounter } from '@iris/tokenizer'
import { historyFromSession, TurnDriver, type GenerateEvents, type StreamFn } from '@iris/turn'

import type { ChatStore } from './chats.ts'
import type { ChatEntry } from './entry.ts'
import { AppError, invalid, notFound } from './errors.ts'
import type { CharacterLibrary } from './library.ts'
import { assertStorable, buildCardContext, commitChatMetadata, type ExtensionSettingsStore } from './context.ts'
import { buildPrompt, DEFAULT_PRESET } from './prompt.ts'
import { runScripts } from './regex.ts'
import type { ScriptPolicyStore } from './scripts.ts'
import type { SettingsStore } from './settings.ts'
import { textOf } from './views.ts'

/** Provenance stamped on a partial reply the user stopped. */
const INTERRUPTED_SOURCE = { provider: 'iris', model: 'interrupted' } as const

/**
 * Share of the context window world info may spend.
 *
 * SillyTavern's own default. Worth keeping: an unbudgeted book quietly eats the
 * conversation, and the symptom — the model forgetting the last ten messages —
 * looks nothing like its cause.
 */
const WORLD_INFO_BUDGET_SHARE = 0.25

/** Every method, keyed by name. */
export type Handlers = {
  [M in RpcMethod]: (params: RpcRequest<M>) => Promise<RpcResponse<M>>
}

/** What the service needs that it does not own. */
export interface AppServiceOptions {
  /** Normally `ctx.llm.stream` bound to the registry. */
  stream: StreamFn
  library: CharacterLibrary
  chats: ChatStore
  settings: SettingsStore
  /**
   * The user's decisions about card scripts.
   *
   * Optional so that a host with no page attached — a test, a headless run —
   * need not carry one. Absent means every script list is empty and no card
   * holds a document grant, which is the safe reading of "not configured".
   */
  scripts?: ScriptPolicyStore
  /**
   * Per-card `extension_settings`.
   *
   * Optional for the same reason as `scripts`: absent means every card sees an
   * empty partition, which is what "not configured" should look like.
   */
  extensionSettings?: ExtensionSettingsStore
  /**
   * Fetches a remote script dependency. Defaults to global `fetch`.
   *
   * Injectable so the whitelist can be tested without a network, and so a
   * deployment can route these through its own proxy.
   */
  fetchRemote?: (url: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, headers: { get: (name: string) => string | null } }>
  /** Pushes one frame to every attached page. */
  broadcast: (event: IrisEvent) => void
  /** The preset every chat is assembled with. */
  preset?: ChatCompletionPreset
  /** Name recorded for the user in new chats. */
  userName?: string
  /** Context window in tokens. */
  contextWindow?: number
  /** Tokens held back for the reply. */
  reserveTokens?: number
  /**
   * Fixed per-request cost of the provider's chat template, in tokens.
   *
   * Folded into the calibrated estimate so the correction factor converges on
   * the text model rather than absorbing a constant.
   */
  templateOverhead?: number
  /** Reports a failure the service survived. */
  onError?: (error: Error) => void
}

/** The application half of Iris. */
export class IrisAppService {
  // `scripts` stays optional through the defaulting: it is the one option with
  // no safe default value, only a safe absent behaviour — an empty script list
  // and no grants. Inventing a store here would put a policy file somewhere the
  // caller did not choose.
  readonly #options: Required<Omit<AppServiceOptions, 'onError' | 'scripts' | 'extensionSettings'>>
    & { onError: (error: Error) => void, scripts?: ScriptPolicyStore, extensionSettings?: ExtensionSettingsStore }
  readonly #counter: CalibratingCounter = createCalibratingCounter()

  /**
   * @param options - domain stores, the model stream, and the event sink.
   */
  constructor(options: AppServiceOptions) {
    this.#options = {
      stream: options.stream,
      library: options.library,
      chats: options.chats,
      settings: options.settings,
      broadcast: options.broadcast,
      preset: options.preset ?? DEFAULT_PRESET,
      userName: options.userName ?? 'User',
      contextWindow: options.contextWindow ?? 32_768,
      reserveTokens: options.reserveTokens ?? 1024,
      templateOverhead: options.templateOverhead ?? 0,
      onError: options.onError ?? (() => {}),
      fetchRemote: options.fetchRemote ?? ((url: string) => fetch(url)),
      ...options.scripts === undefined ? {} : { scripts: options.scripts },
      ...options.extensionSettings === undefined ? {} : { extensionSettings: options.extensionSettings },
    }
  }

  /** How well the token estimate currently tracks the provider, for diagnostics. */
  get calibration(): { scale: number, samples: number } {
    return { scale: this.#counter.scale, samples: this.#counter.samples }
  }

  /**
   * Every protocol method, ready to register on a transport.
   * @returns the handler table.
   */
  handlers(): Handlers {
    const { chats, library, settings } = this.#options
    const scripts = this.#options.scripts

    return {
      'chat.list': async () => ({ chats: await chats.list() }),

      'chat.create': async ({ characterId }) => {
        const entry = await chats.create(characterId, this.#options.userName)
        await this.#announceChats()
        return { view: entry.toView() }
      },

      'chat.open': async ({ chatId }) => ({ view: (await chats.open(chatId)).toView() }),

      'chat.delete': async ({ chatId }) => {
        chats.cached(chatId)?.abort()
        await chats.delete(chatId)
        await settings.forget(chatId)
        await this.#announceChats()
        return {}
      },

      'chat.rename': async ({ chatId, title }) => {
        const entry = await chats.open(chatId)
        entry.touch({ title })
        await chats.save(entry)
        this.#options.broadcast({ type: 'chat.updated', chatId, view: entry.toView() })
        return { chats: await chats.list() }
      },

      'chat.send': async ({ chatId, text }) => ({ turn: await this.#start(chatId, { kind: 'send', text }) }),

      'chat.regenerate': async ({ chatId }) => ({ turn: await this.#start(chatId, { kind: 'regenerate' }) }),

      'chat.abort': ({ chatId }) => {
        // Deliberately tolerant of an unknown chat: stopping something that is
        // not running is the outcome the caller asked for either way.
        chats.cached(chatId)?.abort()
        return Promise.resolve({})
      },

      'chat.swipe': async ({ chatId, turn, index }) => {
        const entry = await this.#idle(chatId, 'swiped')
        try {
          selectCandidate(entry.session, turn, index)
        } catch (cause: unknown) {
          if (cause instanceof SwipeError) throw invalid(cause.message)
          throw cause
        }
        entry.touch()
        await chats.save(entry)
        return { view: this.#announceChat(entry) }
      },

      'chat.editMessage': async ({ chatId, id, text }) => {
        const entry = await this.#idle(chatId, 'edited')
        const { messages } = entry.toFile()
        const line = messages[id]
        if (line === undefined) throw notFound(`this chat has no message ${String(id)}`)

        line.mes = text
        // A reply's text lives in its swipe list; `mes` only points at one of
        // them. Editing without updating the list would be undone by the next
        // swipe back and forth.
        if (line.swipes !== undefined) line.swipes[line.swipe_id ?? 0] = text

        entry.rebuild(messages, index => index)
        entry.touch()
        await chats.save(entry)
        return { view: this.#announceChat(entry) }
      },

      'chat.deleteMessage': async ({ chatId, id }) => {
        const entry = await this.#idle(chatId, 'edited')
        const { messages } = entry.toFile()
        if (messages[id] === undefined) throw notFound(`this chat has no message ${String(id)}`)

        messages.splice(id, 1)
        // Everything after the hole shifts down by one; everything before keeps
        // its place. The mapping is what lets each reply keep its own variables.
        entry.rebuild(messages, index => index < id ? index : index + 1)
        entry.touch()
        await chats.save(entry)
        const view = this.#announceChat(entry)
        await this.#announceChats()
        return { view }
      },

      'character.list': async () => ({ characters: await library.list() }),

      'character.import': async ({ filename, content }) => ({
        character: await library.import(filename, content),
      }),

      'character.delete': async ({ characterId }) => {
        await library.delete(characterId)
        return {}
      },

      'settings.get': ({ chatId }) => Promise.resolve({ settings: settings.get(chatId) }),

      'settings.set': async ({ chatId, settings: patch }) => ({
        settings: await settings.set(chatId, patch),
      }),

      'script.list': async ({ characterId }) => {
        if (scripts === undefined) return { scripts: [], documentGranted: false }
        const card = await library.load(characterId)
        return {
          scripts: await scripts.view(characterId, card),
          documentGranted: await scripts.documentGranted(characterId),
        }
      },

      'script.setEnabled': async ({ characterId, scriptId, enabled }) => {
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        const card = await library.load(characterId)
        // Refused for a script the card does not have, rather than stored: a
        // policy file that accumulates ids from typos and stale cards is a
        // policy file nobody can audit.
        const known = await scripts.view(characterId, card)
        if (!known.some(row => row.id === scriptId)) {
          throw notFound(`${characterId} has no script "${scriptId}"`)
        }
        await scripts.setEnabled(characterId, scriptId, enabled)
        return { scripts: await scripts.view(characterId, card) }
      },

      'script.setDocumentGrant': async ({ characterId, granted }) => {
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        // Loaded first so a grant cannot be stored against a card that is not
        // there — a grant outliving its card is a permission with no subject.
        await library.load(characterId)
        return { documentGranted: await scripts.setDocumentGrant(characterId, granted) }
      },

      // The bridge surface. The wire shape is frozen so the browser runner and
      // the host provider can be built against it at once; these throw until
      // the host-side context provider is wired, and throwing is deliberate —
      // a stub that answered plausibly could ship unnoticed, and a card reading
      // an empty context misbehaves silently instead of failing loudly.
      'script.context': async ({ chatId, characterId }) => {
        const entry = await chats.open(chatId)
        return {
          context: buildCardContext(entry, {
            // The asking card's partition, never the whole store: one card
            // reading another's settings would defeat the per-card grant.
            extensionSettings: await this.#options.extensionSettings?.get(characterId) ?? {},
            characters: await library.list(),
          }),
        }
      },

      'script.saveMetadata': async ({ chatId, metadata }) => {
        const entry = await chats.open(chatId)
        commitChatMetadata(entry, metadata)
        entry.touch()
        await chats.save(entry)
        // Echoed back as stored, so a card can see what survived rather than
        // assuming its object round-tripped intact.
        return { metadata: entry.header.chat_metadata }
      },

      'script.setExtensionSettings': async ({ characterId, settings }) => {
        const store = this.#options.extensionSettings
        if (store === undefined) throw new AppError('unsupported', 'extension settings are not configured on this host')
        // The card must exist. A partition written for a card that is not there
        // is storage nobody can find to clear.
        await library.load(characterId)
        assertStorable(settings, 'extensionSettings')
        await store.set(characterId, settings)
        return { settings: await store.get(characterId) }
      },

      'script.saveChat': async ({ chatId }) => {
        const entry = await chats.open(chatId)
        entry.touch()
        await chats.save(entry)
        return {}
      },

      'script.setExtensionPrompt': async ({ chatId, key, value, position, depth }) => {
        const entry = await chats.open(chatId)
        entry.setExtensionPrompt(key, { value, position, depth })
        return {}
      },

      'script.generateRaw': async ({ chatId, prompt, systemPrompt }) => {
        const entry = await chats.open(chatId)
        return { text: await this.#generateRaw(entry, prompt, systemPrompt) }
      },

      'script.fetch': async ({ url }) => {
        const verdict = checkScriptFetch(url)
        // `unsupported` and not `invalid-request`: the URL is well-formed and
        // the request is understood, it is the source that is not allowed, and
        // the message names the host so the person holding the card can see why.
        if (!verdict.allowed) throw new AppError('unsupported', verdict.reason)

        const fetcher = this.#options.fetchRemote
        let response: Awaited<ReturnType<NonNullable<AppServiceOptions['fetchRemote']>>>
        try {
          response = await fetcher(verdict.url)
        } catch (cause: unknown) {
          throw new AppError('provider-error', `could not reach ${new URL(verdict.url).hostname}: ${String(cause)}`)
        }
        if (!response.ok) {
          throw new AppError('provider-error', `${new URL(verdict.url).hostname} answered ${String(response.status)}`)
        }
        const contentType = response.headers.get('content-type')
        return {
          content: await response.text(),
          ...contentType === null ? {} : { contentType },
        }
      },
    }
  }

  /**
   * Open a chat and refuse if a turn is in flight.
   * @param chatId - the conversation.
   * @param verb - what the caller was trying to do, for the message.
   * @returns the idle entry.
   * @throws {AppError} `busy` while the chat is generating.
   */
  async #idle(chatId: string, verb: string): Promise<ChatEntry> {
    const entry = await this.#options.chats.open(chatId)
    if (entry.generating) throw new AppError('busy', `that chat cannot be ${verb} while it is generating`)
    return entry
  }

  /** Push a chat's settled view and return it. */
  #announceChat(entry: ChatEntry): ReturnType<ChatEntry['toView']> {
    const view = entry.toView()
    this.#options.broadcast({ type: 'chat.updated', chatId: entry.chatId, view })
    return view
  }

  /** Push the conversation list. */
  async #announceChats(): Promise<void> {
    this.#options.broadcast({ type: 'chats.updated', chats: await this.#options.chats.list() })
  }

  /**
   * Open a turn and start generating into the event stream.
   *
   * Returns the turn number rather than the reply: the driver's first
   * statements are synchronous, so by the time this resolves the turn is on the
   * log and the client can start correlating `stream.*` frames to it.
   * @param chatId - the conversation.
   * @param request - a new user message, or a reroll of the last turn.
   * @returns the turn now generating.
   * @throws {AppError} `busy` when one already is, `invalid-request` when there
   *   is no turn to reroll.
   */
  async #start(chatId: string, request: { kind: 'send', text: string } | { kind: 'regenerate' }): Promise<number> {
    const entry = await this.#options.chats.open(chatId)
    const turn = request.kind === 'send' ? entry.lastTurn + 1 : entry.lastTurn
    if (turn < 0) throw invalid('this chat has no turn to regenerate')

    const signal = entry.begin(turn)
    const driver = this.#driver(entry)
    const events: GenerateEvents = {
      onText: (delta) => {
        if (entry.pending !== undefined) entry.pending.text += delta
        this.#options.broadcast({ type: 'stream.text', chatId, turn, delta })
      },
      onReasoning: (delta) => {
        if (entry.pending !== undefined) entry.pending.reasoning += delta
        this.#options.broadcast({ type: 'stream.reasoning', chatId, turn, delta })
      },
      signal,
    }

    const running = request.kind === 'send'
      // The storage direction runs on what the user typed, before it enters the
      // log — the one point where a message is written for the first time.
      ? driver.send(
        entry.session,
        runScripts(request.text, 'user', entry.scripts, { substitute: entry.substitute }),
        events,
      )
      : driver.regenerate(entry.session, events)

    // Announced after the call, not before: `send` appends the user's line
    // synchronously at the top of the driver, and until it has, the spare key
    // slot belongs to that line rather than to the reply. Nothing can have been
    // emitted yet — the first delta waits on the network — and the ordering is
    // pinned by test rather than argued.
    this.#options.broadcast({ type: 'stream.start', chatId, turn, key: entry.streamingKeyFor(turn) })

    void running.then(
      candidate => this.#settle(entry, turn, textOf(candidate.message)),
      error => this.#fail(entry, turn, signal, error),
    )

    return turn
  }

  /** Record a finished candidate and tell every page. */
  async #settle(entry: ChatEntry, turn: number, text: string): Promise<void> {
    try {
      // Variables first: a permanent script may be there precisely to strip the
      // command block, and the commands have to be read before it does.
      entry.recordVariables(turn, text)
      this.#storeRewritten(entry, entry.scripts, text)
      entry.touch()
      entry.finish()
      await this.#options.chats.save(entry)
      this.#options.broadcast({ type: 'stream.end', chatId: entry.chatId, turn, view: entry.toView() })
      await this.#announceChats()
    } catch (cause: unknown) {
      entry.finish()
      this.#report(cause)
    }
  }

  /**
   * Report a turn that did not finish.
   *
   * A stop is not a failure: SillyTavern keeps whatever the model produced
   * before the user pressed stop, and throwing away half a reply the user
   * decided was good enough is worse than the abort itself. So a stopped turn
   * with text becomes a real candidate and settles normally.
   */
  async #fail(entry: ChatEntry, turn: number, signal: AbortSignal, error: unknown): Promise<void> {
    const partial = entry.pending?.text ?? ''

    if (signal.aborted && partial.length > 0) {
      try {
        appendCandidate(entry.session, {
          turn,
          step: 0,
          message: createAssistantMessage({
            content: [{ type: 'text', text: partial }],
            source: INTERRUPTED_SOURCE,
          }),
        })
        await this.#settle(entry, turn, partial)
        return
      } catch (cause: unknown) {
        this.#report(cause)
      }
    }

    entry.finish()
    try {
      // The user's message stays on the log, so retrying is meaningful.
      await this.#options.chats.save(entry)
    } catch (cause: unknown) {
      this.#report(cause)
    }

    this.#options.broadcast({
      type: 'stream.error',
      chatId: entry.chatId,
      turn,
      code: signal.aborted ? 'aborted' : 'provider-error',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /** Build the driver for one chat, with its current settings. */
  #driver(entry: ChatEntry): TurnDriver {
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const count = (text: string): number => this.#counter.count(text)
    const names = entry.names

    return new TurnDriver({
      stream: options => this.#stream(options),
      provider: settings.provider,
      model: settings.model,
      contributions: session => this.#contributions(entry, session, count),
      history: session => this.#history(entry, session),
      budget: {
        context: this.#options.contextWindow,
        reserve: this.#options.reserveTokens,
        count,
      },
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...settings.stop === undefined ? {} : { stop: settings.stop },
      sampling: samplingOf(settings),
    })
  }

  /**
   * One generation's prompt policy, plus whatever a card script has injected.
   * @param entry - the conversation.
   * @param session - the log to assemble from.
   * @param count - the token counter the budget uses.
   * @returns the contributions for this generation.
   */
  #contributions(entry: ChatEntry, session: Session, count: (text: string) => number): Contribution[] {
    const names = entry.names
    const built = buildPrompt({
      card: entry.card,
      preset: this.#options.preset,
      userName: names.user,
      characterName: names.character,
      // The same projection the model gets, so a world-info scan cannot match a
      // keyword inside a block the prompt scripts are about to strip.
      history: this.#history(entry, session),
      count,
      worldInfoBudget: Math.floor(this.#options.contextWindow * WORLD_INFO_BUDGET_SHARE),
      ...entry.timedEffects === undefined ? {} : { timedEffects: entry.timedEffects },
    })
    // Carried forward, or a sticky entry would re-open its window every turn and
    // a cooldown would never elapse — the state exists precisely to span turns.
    entry.timedEffects = built.timedEffects

    return [...built.contributions, ...injectedContributions(entry)]
  }

  /**
   * Run one completion that never touches the log.
   *
   * A card asks for this to compute something on the side — a summary, a
   * classification — so it is not a turn: nothing is appended, nothing streams,
   * and no candidate is produced.
   * @param entry - the conversation whose model route to use.
   * @param prompt - what to ask.
   * @param systemPrompt - an optional system slot.
   * @returns the finished text.
   * @throws {AppError} `provider-error` when the stream ends in failure.
   */
  async #generateRaw(entry: ChatEntry, prompt: string, systemPrompt?: string): Promise<string> {
    const settings = this.#options.settings.get(entry.chatId)
    const sampling = samplingOf(settings)
    const assembler = new BlockAssembler()

    for await (const chunk of this.#stream({
      provider: settings.provider,
      model: settings.model,
      ...systemPrompt === undefined ? {} : { system: systemPrompt },
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...sampling === undefined ? {} : { sampling },
    })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new AppError('provider-error', finish.failure?.message ?? 'the provider ended the stream with an error')
    }
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }

  /**
   * The conversation as the model should see it.
   *
   * The prompt direction of the chat's regex scripts runs here, which is what
   * keeps a card's own command blocks out of the next request. Leaving them in
   * is not cosmetic: the model reads back its own `<UpdateVariable>` output from
   * every earlier turn and starts imitating it.
   * @param entry - the conversation.
   * @param session - the log to project.
   * @returns history entries, oldest first.
   */
  #history(entry: ChatEntry, session: Session): HistoryEntry[] {
    const names = entry.names
    const entries = historyFromSession(session, { characterName: names.character, userName: names.user })
    const scripts = entry.scripts
    if (scripts.length === 0) return entries
    return entries.map((item, index) => ({
      ...item,
      text: runScripts(item.text, item.role, scripts, {
        isPrompt: true,
        depth: entries.length - 1 - index,
        substitute: entry.substitute,
      }),
    }))
  }

  /**
   * Rewrite a settled reply the way a permanent script says it should be stored.
   *
   * Only the scripts marked neither display-only nor prompt-only reach this:
   * they change the message itself, which is why the render and send directions
   * then leave the stored form alone. It goes through the chat-file projection
   * because an append-only log cannot rewrite a message in place — the same
   * route `chat.editMessage` takes, and for the same reason.
   * @param entry - the conversation.
   * @param scripts - the chat's ordered scripts.
   * @param text - the reply as generated.
   */
  #storeRewritten(entry: ChatEntry, scripts: readonly RegexScript[], text: string): void {
    if (scripts.length === 0) return
    const stored = runScripts(text, 'assistant', scripts, { substitute: entry.substitute })
    if (stored === text) return

    const { messages } = entry.toFile()
    const index = messages.length - 1
    const line = messages[index]
    if (line === undefined || line.is_user) return
    line.mes = stored
    if (line.swipes !== undefined) line.swipes[line.swipe_id ?? 0] = stored
    entry.rebuild(messages, position => position)
  }

  /**
   * Stream one call, folding the provider's own token count back into the estimate.
   *
   * Every response reports what the prompt actually cost — the ground truth for
   * the number just estimated, free of charge. Feeding it back is the only way
   * a character-class estimator converges, because the residual is vocabulary
   * dependent and no static table fixes it.
   */
  async *#stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = [
      ...options.system === undefined ? [] : [{ text: options.system }],
      ...options.messages.map(message => ({ text: textOf(message) })),
    ]
    // The corrected number, which is what `observe` must be given: passing the
    // raw estimate would make the correction compound on itself.
    const estimated = this.#counter.countRequest(messages, { templateOverhead: this.#options.templateOverhead })

    for await (const chunk of this.#options.stream(options)) {
      if (chunk.type === 'usage') this.#counter.observe(estimated, chunk.usage.inputTokens)
      yield chunk
    }
  }

  /** Hand a survived failure to the composition's logger. */
  #report(error: unknown): void {
    this.#options.onError(error instanceof Error ? error : new Error(String(error)))
  }
}

/**
 * A card script's keyed injections, as prompt contributions.
 *
 * Ordered around the preset's own sections rather than inside them: a card
 * injecting text has no way to know what the preset numbered its parts, so the
 * only stable promise is "before everything" or "after everything".
 * @param entry - the conversation holding the injections.
 * @returns one contribution per live injection.
 */
export function injectedContributions(entry: ChatEntry): Contribution[] {
  const contributions: Contribution[] = []
  for (const [key, injection] of entry.extensionPrompts) {
    contributions.push({
      id: `script.${key}`,
      placement: injection.position === 'at-depth'
        ? { kind: 'depth', depth: injection.depth, role: 'system', order: 2 }
        : { kind: 'system', order: injection.position === 'before' ? 850 : 950 },
      text: injection.value,
    })
  }
  return contributions
}

/**
 * The sampling fields the harness does not carry itself.
 * @param settings - the chat's generation settings.
 * @returns the extra sampling block, with only the fields that are set.
 */
export function samplingOf(settings: GenerationSettings): GenerateOptions['sampling'] {
  return {
    ...settings.topP === undefined ? {} : { topP: settings.topP },
    ...settings.topK === undefined ? {} : { topK: settings.topK },
    ...settings.minP === undefined ? {} : { minP: settings.minP },
    ...settings.repetitionPenalty === undefined ? {} : { repetitionPenalty: settings.repetitionPenalty },
    ...settings.frequencyPenalty === undefined ? {} : { frequencyPenalty: settings.frequencyPenalty },
    ...settings.presencePenalty === undefined ? {} : { presencePenalty: settings.presencePenalty },
    ...settings.seed === undefined ? {} : { seed: settings.seed },
  }
}
