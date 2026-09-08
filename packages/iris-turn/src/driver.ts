/**
 * The roleplay turn driver.
 *
 * Iris drives its own turns rather than reusing the harness agent loop, for one
 * concrete reason: that loop builds `GenerateOptions.messages` internally and
 * hands listeners a frozen request, so there is nowhere to splice content at a
 * depth. Roleplay lives on depth injection — author's notes, world-info entries
 * anchored N turns from the end — so message assembly has to belong to us.
 *
 * What a turn is here is deliberately small: one model call, no tools, no
 * sub-agents. Regeneration produces another candidate for the same turn rather
 * than a new turn, which is what makes swipes work.
 *
 * @module @iris/turn/driver
 */

import {
  BlockAssembler,
  createAssistantMessage,
  createMessage,
  createUserMessage,
  type AssistantMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate, listCandidates, selectCandidate, selectedCandidate, type Candidate } from '@iris/chat'
import {
  assemble,
  type Budget,
  type Contribution,
  type HistoryEntry,
  type PipelineMessage,
  type SystemSegment,
} from '@iris/pipeline'

import type { HistoryProjection } from './history.ts'
// This module also augments `GenerateOptions` with `layout`; the field set
// below does not exist without it in the program.
import type { LayoutPart, LayoutSlot, PromptLayout } from './layout.ts'

/** Streams one model call. Normally `ctx.llm.stream` bound to the registry. */
export type StreamFn = (options: GenerateOptions) => AsyncIterable<StreamChunk>

/** Everything the driver needs that it does not own. */
export interface TurnDriverOptions {
  stream: StreamFn
  provider: string
  model: string
  /**
   * Build this turn's prompt contributions. Called fresh for every generation,
   * so world-info activation and variable state reflect the turn being written
   * rather than the one before it.
   *
   * May be async: the chat-bound world book is read from disk per generation,
   * because it is the one body of world info a card writes during play, and a
   * caller that awaited it once at construction would serve a book frozen at
   * chat-open time.
   */
  contributions: (session: Session) => readonly Contribution[] | Promise<readonly Contribution[]>
  /**
   * Turn the durable log into the conversation the model should see.
   *
   * The **projection** says what this particular generation must not be shown —
   * today only "the reply you are replacing" (see {@link HistoryProjection}).
   * A callback that honours it lets its own per-entry work see the sent
   * conversation, which is what a regex script's `depth` has to be computed
   * over; a callback that ignores the argument (`session => historyFromSession(session)`,
   * which is the obvious thing to write) is repaired by the driver, because
   * parity on a reroll cannot depend on how a caller happened to spell its
   * projection.
   */
  history: (session: Session, projection: HistoryProjection) => readonly HistoryEntry[]
  budget: Budget
  /** Sampling beyond the harness's own fields; the Iris adapter reads it. */
  sampling?: GenerateOptions['sampling']
  temperature?: number
  maxTokens?: number
  stop?: string[]
  /**
   * Merge consecutive system-role messages of the assembled request into one,
   * joining their text with a blank line — upstream's `squash_system_messages`.
   *
   * Depth injections and card scripts can sit beside each other with the same
   * role; a provider that takes a mid-conversation system message badly gets
   * one merged message instead. Off by default: the request rides exactly as
   * it was assembled.
   */
  squashSystemMessages?: boolean
  /**
   * Maximise the stable prefix — `AssembleInput.cacheFriendly`, passed straight
   * through.
   *
   * The driver has no opinion about which contributions are volatile (the
   * caller marks them) nor about where they go (`assemble` decides). What it
   * does own is the squash, which is the one pass here that could undo the
   * reorder by merging a moved message into a message in front of it — see
   * {@link squashSystemRuns}.
   */
  cacheFriendly?: boolean
}

/** Progress reported while a candidate is being generated. */
export interface GenerateEvents {
  /** Visible text as it arrives. */
  onText?: (delta: string) => void
  /** Reasoning as it arrives, kept separate so a UI can collapse it. */
  onReasoning?: (delta: string) => void
  signal?: AbortSignal
}

/** Raised when a turn cannot be driven. */
export class TurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnError'
  }
}

/** The highest turn number the log has opened, or `-1` when it has none. */
function lastTurn(session: Session): number {
  let turn = -1
  for (const event of session.events) {
    if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
  }
  return turn
}

/** Drives roleplay turns over one chat log. */
export class TurnDriver {
  readonly #options: TurnDriverOptions

  /**
   * @param options - model route, prompt builders and budget.
   */
  constructor(options: TurnDriverOptions) {
    this.#options = options
  }

  /**
   * Run one model call and record the result as a candidate of `turn`.
   * @param session - the chat log.
   * @param turn - the turn to attach the candidate to.
   * @param events - streaming callbacks and cancellation.
   * @param extend - what makes this call a continue rather than a reroll: the
   *   text the candidate opens with, and a message pinned after the assembled
   *   conversation (upstream's continue nudge).
   * @param projection - what this generation must not be shown.
   * @returns the recorded candidate.
   * @throws {TurnError} when the provider ends the stream with a failure.
   */
  async #generate(
    session: Session,
    turn: number,
    events: GenerateEvents = {},
    extend: { seed?: string, tail?: PipelineMessage, postfix?: string } = {},
    projection: HistoryProjection = {},
  ): Promise<Candidate> {
    const run = await this.#run(session, turn, events, extend.tail, extend.postfix, projection)
    const seed = extend.seed
    // A continue's candidate is the joined text, not the continuation alone:
    // the swipe list of this turn is what the file exports, and SillyTavern's
    // continue edits the message in place — here the same outcome is a new
    // candidate that opens with what was already showing, which keeps every
    // earlier reading swipable.
    const content = seed === undefined
      ? run.blocks
      : joinedWithSeed(run.blocks, seed)
    return appendCandidate(session, {
      turn,
      step: 0,
      message: createAssistantMessage({ content, source: run.source }),
    })
  }  /**
   * One model call, streamed and recorded chunk by chunk, without writing a
   * candidate.
   * @param session - the chat log the chunks are journalled to.
   * @param turn - the turn the chunks belong to, for the journal.
   * @param events - streaming callbacks and cancellation.
   * @param tail - a message appended after the assembled conversation, its
   *   role preserved ({@link toTailMessage}): a continue's nudge rides user,
   *   an impersonation's instruction rides system, upstream's own roles.
   * @param postfix - the separator a continue rides on the text being continued
   *   (upstream appends `continue_postfix` to `cyclePrompt`, script.js:4917).
   *   Absent leaves the request alone — only a continue has one.
   * @param projection - what this generation must not be shown.
   * @returns the content blocks, the message source they imply, and the visible
   *   text.
   * @throws {TurnError} when the provider ends the stream with a failure.
   */
  async #run(
    session: Session,
    turn: number,
    events: GenerateEvents,
    tail?: PipelineMessage,
    postfix?: string,
    projection: HistoryProjection = {},
  ): Promise<{
    blocks: AssistantMessage['content']
    source: Parameters<typeof createAssistantMessage>[0]['source']
    text: string
  }> {
    const options = this.#options
    const request = assemble({
      contributions: await options.contributions(session),
      history: projectedHistory(session, options.history, projection),
      budget: options.budget,
      ...options.cacheFriendly === undefined ? {} : { cacheFriendly: options.cacheFriendly },
    })
    // The tail rides outside `assemble` because it has to be the request's LAST
    // message whatever depth injections the contributions carry — depth 0 lands
    // after the newest history entry, and a nudge that sat behind an injection
    // would not be the thing the model reads last.
    // The squash runs at the assembled level, where roles still exist, and the
    // tail is exempt: it is pinned as the request's LAST message, and a nudge
    // merged into a neighbouring system message would no longer be the thing
    // the model reads before it writes.
    const assembled = slotsOf(request.messages)
    const base = options.squashSystemMessages === true ? squashSystemRuns(assembled) : assembled
    // The continue's separator rides on the request too, not only on the
    // recorded composite, because the model needs the same boundary it is
    // expected to write from. Same guard as upstream: text already ending in a
    // space is left alone (`script.js:4918`, `!cyclePrompt.endsWith(' ')`), so
    // a space separator cannot stack. The continued floor is the last assistant
    // message — a nudge, when one rides, sits after it and is not touched.
    //
    // **This is a deliberate departure, read against the source.** Upstream
    // appends `continue_postfix` to `cyclePrompt` and to `continue_mag`
    // (`script.js:4916-4921`), and both of those are output-side: `continue_mag`
    // is prepended to the reply it records (`:5346`, `:5452`) — which is what
    // Iris's composite candidate does too — while `cyclePrompt` reaches the
    // request only through the nudge's `{{lastChatMessage}}` macro, where
    // `String(cyclePrompt).trim()` strips the separator straight back off
    // (`openai.js:902`). The request's own copy of the continued text comes from
    // `coreChat[…].mes` and carries no postfix. So upstream's model is asked to
    // continue text whose boundary it cannot see, and Iris shows it. Recorded in
    // `notes/packages/iris-app-service/DEVIATIONS.md` §42; the cache cost is one
    // separator's worth of bytes at the newest floor, which is past the prefix
    // either way.
    if (postfix !== undefined && postfix.length > 0) {
      for (let index = base.length - 1; index >= 0; index -= 1) {
        const slot = base[index] as AssembledSlot
        if (slot.message.role !== 'assistant') continue
        if (!slot.message.text.endsWith(' ')) {
          slot.message.text += postfix
          // The part's recorded text moves with the message's, so the layout
          // still describes the bytes that go out. A separator appended after
          // the provenance was taken is the exact shape that makes a trace's
          // parts stop laying back down onto their slot — harmless here, since
          // the slot has one part, and not harmless in the one-part system slot
          // the trace checks strictly.
          const only = slot.parts[0]
          if (only !== undefined && slot.parts.length === 1) only.text = slot.message.text
        }
        break
      }
    }
    const messages = tail === undefined
      ? base.map(slot => toMessage(slot.message))
      : [...base.map(slot => toMessage(slot.message)), toTailMessage(tail)]

    const assembler = new BlockAssembler()
    for await (const chunk of options.stream({
      provider: options.provider,
      model: options.model,
      system: request.system,
      messages,
      // Which item produced each slot, for cache attribution. Built **here**,
      // after the squash, the postfix and the tail, because those three are the
      // difference between what `assemble` returned and what the provider is
      // about to be sent — a map taken before them would name the wrong slot
      // for every message after the first merged run. `PromptLayout` says why
      // this cannot reach a provider.
      layout: layoutOf(request.systemSegments, base, tail),
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.stop === undefined ? {} : { stop: options.stop },
      ...options.sampling === undefined ? {} : { sampling: options.sampling },
      ...events.signal === undefined ? {} : { signal: events.signal },
    })) {
      assembler.push(chunk)
      // The raw chunks are logged too: the assembled message is a projection,
      // and keeping the stream lets a session be replayed token by token.
      session.append('assistant/chunk', { turn, step: 0, chunk })
      if (chunk.type === 'text-delta') events.onText?.(chunk.text)
      else if (chunk.type === 'reasoning-delta') events.onReasoning?.(chunk.text)
    }

    // The stream API never throws; every outcome arrives as a terminal finish.
    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new TurnError(finish.failure?.message ?? 'the provider ended the stream with an error')
    }

    // Built from the assembled blocks rather than `assembler.message()`, which
    // is typed as a bare Message: a candidate is specifically model-produced,
    // and carrying the adapter's replay state keeps the turn re-playable.
    const replayState = assembler.replayState
    const blocks = assembler.blocks()
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    return {
      blocks,
      source: {
        provider: options.provider,
        model: options.model,
        ...replayState === undefined ? {} : { replayState },
      },
      text,
    }
  }

  /**
   * Open a turn with the user's message and generate the first reply.
   * @param session - the chat log.
   * @param text - what the user wrote.
   * @param events - streaming callbacks and cancellation.
   * @returns the first candidate of the new turn.
   */
  async send(session: Session, text: string, events: GenerateEvents = {}): Promise<Candidate> {
    const turn = lastTurn(session) + 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 0 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )

    try {
      const candidate = await this.#generate(session, turn, events)
      session.append('step/end', { turn, step: 0 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      return candidate
    } catch (error: unknown) {
      // The turn stays open and the user's message stays in the log: a failed
      // generation is worth retrying, and losing what they typed is not.
      session.append('step/end', { turn, step: 0 })
      throw error
    }
  }

  /**
   * Produce another candidate for the most recent turn.
   *
   * **The reply being replaced is not part of the request.** This is upstream's
   * rule on both of its paths (`public/script.js:4344-4352` for a regenerate,
   * `:4438-4440` for a swipe) and it is a behaviour question before it is a
   * cost one: a model shown its own previous answer and asked for another one
   * either repeats it or argues with it. It is also the whole difference
   * between "a swipe is a fresh attempt at this turn" and "a swipe is a reply
   * to my last reply". A **swipe** in Iris is this method — `swipe()` only
   * chooses among candidates that already exist — so the two upstream paths
   * meet here in one.
   * @param session - the chat log.
   * @param events - streaming callbacks and cancellation.
   * @returns the new candidate, now the selected one.
   * @throws {TurnError} when the log has no turn to regenerate.
   */
  async regenerate(session: Session, events: GenerateEvents = {}): Promise<Candidate> {
    const turn = lastTurn(session)
    if (turn < 0) throw new TurnError('there is no turn to regenerate')
    return this.#generate(session, turn, events, {}, { dropTrailingReply: true })
  }

  /**
   * Write on from the newest reply, as its own author.
   *
   * The result is a new candidate on the SAME turn whose text opens with the
   * reading being continued, so the conversation keeps one floor and every
   * earlier reading stays swipable — SillyTavern's continue edits the message
   * in place, and the candidate it would have overwritten survives here as an
   * alternate.
   * @param session - the chat log.
   * @param events - streaming callbacks and cancellation.
   * @param nudge - the instruction that closes the request, after the whole
   *   conversation (upstream's continue nudge). Absent sends the request
   *   without one.
   * @param postfix - the separator between the reading and the continuation,
   *   as `continue_postfix` spells it (upstream applies it on every OpenAI
   *   route, `script.js:4917-4921`). Absent keeps the seed bare — the caller
   *   resolving the setting's default is the one that knows it.
   * @returns the recorded candidate, carrying seed plus continuation.
   * @throws {TurnError} when the newest turn has no reply to continue.
   */
  async continueTurn(
    session: Session,
    events: GenerateEvents = {},
    nudge?: string,
    postfix?: string,
  ): Promise<Candidate> {
    const turn = lastTurn(session)
    if (turn < 0) throw new TurnError('there is no turn to continue')
    const seed = selectedCandidate(session, turn)
    if (seed === undefined) {
      throw new TurnError('the newest turn has no reply to continue')
    }
    const seedText = seed.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return this.#generate(session, turn, events, {
      seed: postfix === undefined || postfix.length === 0 || seedText.endsWith(' ')
        ? seedText
        : seedText + postfix,
      ...postfix === undefined || postfix.length === 0 ? {} : { postfix },
      // System, as upstream builds it: the `continueNudge` promptObject
      // declares `role: 'system'` and `system_prompt: true`
      // (`openai.js:899-903`). It rode as `user` here, cited to those same
      // lines — see {@link toTailMessage} for why the role is the instruction's
      // authority rather than a formatting choice.
      ...nudge === undefined ? {} : { tail: { role: 'system' as const, text: nudge } },
    })
  }

  /**
   * Write the user's next line instead of the character's.
   *
   * Upstream's impersonate: one generation from `{{user}}`'s perspective that
   * becomes a user message — never an assistant candidate, and never the start
   * of a fresh exchange. The generation runs against the conversation as it
   * stands, because the line being written cannot be part of its own context;
   * the turn only opens once there is text to put in it, so a failed
   * impersonation opens nothing.
   * @param session - the chat log.
   * @param events - streaming callbacks and cancellation.
   * @param instruction - the instruction that closes the request (upstream's
   *   impersonation prompt, with `{{user}}`/`{{char}}` already expanded). It
   *   rides as a **system** message, upstream's own delivery: role system there
   *   (`openai.js:1373`), appended after the whole chat history as the last
   *   thing the model reads (`:1213-1216`).
   * @returns the text the user line was written with.
   * @throws {TurnError} when the provider ends the stream with a failure.
   */
  async impersonate(session: Session, events: GenerateEvents = {}, instruction?: string): Promise<string> {
    // The chunk journal needs a turn number, but the turn must not exist before
    // there is a line to own it — journalled under `lastTurn + 1` they are
    // `assistant/chunk` records only, which no projection reads as a message.
    const turn = lastTurn(session) + 1
    const run = await this.#run(session, turn, events,
      instruction === undefined ? undefined : { role: 'system' as const, text: instruction })
    this.recordImpersonation(session, run.text)
    return run.text
  }

  /**
   * Record an impersonated line as a user message opening a new turn.
   *
   * Split from {@link impersonate} so the abort path can land a partial line
   * with exactly the same shape a completed one has.
   * @param session - the chat log.
   * @param text - the line to record.
   * @returns the turn the line opened.
   */
  recordImpersonation(session: Session, text: string): number {
    const turn = lastTurn(session) + 1
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 0 })
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
    session.append('step/end', { turn, step: 0 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    return turn
  }

  /**
   * Continue an interrupted turn — generate a candidate without a new user
   * message, for a turn whose first attempt failed.
   * @param session - the chat log.
   * @param events - streaming callbacks and cancellation.
   * @returns the new candidate.
   * @throws {TurnError} when the log has no turn to retry.
   */
  retry(session: Session, events: GenerateEvents = {}): Promise<Candidate> {
    return this.regenerate(session, events)
  }

  /**
   * Choose among a turn's candidates.
   * @param session - the chat log.
   * @param turn - the turn.
   * @param index - position in the candidate list.
   * @returns the now-selected candidate.
   */
  swipe(session: Session, turn: number, index: number): Candidate {
    return selectCandidate(session, turn, index)
  }

  /**
   * The swipe list of a turn and which one is showing.
   * @param session - the chat log.
   * @param turn - the turn.
   * @returns candidates and the selected index.
   */
  swipes(session: Session, turn: number): { candidates: Candidate[], selected: number } {
    const candidates = listCandidates(session, turn)
    return { candidates, selected: selectedCandidate(session, turn)?.index ?? 0 }
  }
}

/**
 * Ask the caller's projection for this generation's conversation, and enforce
 * what the generation asked for.
 *
 * The enforcement is the point. `TurnDriverOptions.history` is a callback, and
 * the obvious way to write one — `session => historyFromSession(session)` —
 * takes no projection at all and cannot honour it; three call sites in this
 * repository are spelled exactly that way. A parity rule that a caller opts
 * out of by writing the natural thing is not a parity rule, so the driver
 * checks the answer rather than trusting it.
 *
 * The check is *not* "pop the tail if it is an assistant entry", which would
 * pop a second entry off a projection that had already honoured the request.
 * It compares against what the log itself derives: a projection that dropped
 * the reply comes back one entry shorter, and only a projection that returned
 * every derived message is repaired here. The pop rule is then upstream's own
 * — a trailing **assistant** entry, so a turn whose reply never landed (a
 * retry) loses nothing.
 * @param session - the chat log.
 * @param history - the caller's projection.
 * @param projection - what this generation must not be shown.
 * @returns the conversation to assemble.
 */
function projectedHistory(
  session: Session,
  history: TurnDriverOptions['history'],
  projection: HistoryProjection,
): readonly HistoryEntry[] {
  const projected = history(session, projection)
  if (projection.dropTrailingReply !== true) return projected
  if (projected.length !== session.deriveMessages().length) return projected
  if (projected[projected.length - 1]?.role !== 'assistant') return projected
  return projected.slice(0, -1)
}

/** Turn one assembled message into the harness message type. */
function toMessage(message: PipelineMessage) {
  if (message.role === 'assistant') {
    return createAssistantMessage({
      content: [{ type: 'text', text: message.text }],
      source: { provider: 'iris', model: 'history' },
    })
  }
  // System-placed depth injections ride as user-role content: the system slot
  // is already spoken for, and providers vary on mid-conversation system turns.
  return createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } })
}

/**
 * Turn the tail message into the harness message type, its role intact.
 *
 * The tail is a utility prompt that closes the request — a continue's nudge
 * (system, upstream's `continueNudge` promptObject at `openai.js:899-903`,
 * which declares `role: 'system'` and `system_prompt: true`) or an
 * impersonation's instruction (system, upstream's `impersonate` control prompt,
 * `openai.js:1373` built role system and `:1213-1216` appended after the whole
 * chat history).
 * The role IS the instruction's authority: upstream delivers the impersonation
 * prompt as a system message, and flattening it to the user's voice makes it
 * one more user turn the model talks past — for a strong preset that reads as
 * license to continue the character's last floor instead of writing the user's
 * next line. Unlike {@link toMessage}, which coerces history into the two
 * roles a transcript may carry, this one is the wire speaking.
 * @param tail - the message appended after the assembled conversation.
 * @returns the harness message carrying the tail's own role.
 */
function toTailMessage(tail: PipelineMessage) {
  if (tail.role === 'assistant') {
    return createAssistantMessage({
      content: [{ type: 'text', text: tail.text }],
      source: { provider: 'iris', model: 'history' },
    })
  }
  if (tail.role === 'system') {
    return createMessage({
      role: 'system',
      content: [{ type: 'text', text: tail.text }],
      source: { kind: 'plugin', plugin: 'iris-turn' },
    })
  }
  return createUserMessage({ content: [{ type: 'text', text: tail.text }], source: { kind: 'user' } })
}

/**
 * One outgoing message and the assembly parts inside it.
 *
 * A slot holds more than one part only after a squash. Carrying the pair
 * together is what keeps the merge and its record from drifting: the one loop
 * that joins two texts is the one loop that joins their provenance.
 *
 * Exported for the one caller that assembles a request without this driver —
 * the host's `TavernHelper.generate` — so that path squashes by the same rule
 * and records the same provenance instead of keeping a second copy of both.
 */
export interface AssembledSlot {
  message: PipelineMessage
  parts: LayoutPart[]
}

/**
 * Open each assembled message into a slot of its own.
 *
 * The message is copied, because the postfix pass writes into it and
 * `assemble`'s array is the caller's.
 * @param messages - the assembled conversation, oldest first.
 * @returns one single-part slot per message.
 */
export function slotsOf(messages: readonly PipelineMessage[]): AssembledSlot[] {
  return messages.map(message => ({
    message: { ...message },
    // Absent only for a message the assembler did not place, which within this
    // function is nothing — `injectAtDepth` stamps every one. Written as a
    // conditional anyway so a caller assembling its own messages produces an
    // unattributed slot rather than a slot claiming to be `undefined`.
    parts: message.id === undefined ? [] : [{ id: message.id, text: message.text }],
  }))
}

/**
 * Merge consecutive system-role messages of the assembled conversation.
 *
 * Upstream's `squash_system_messages`, transcribed: only adjacent system
 * messages merge, the first message of the run surviving and the rest folding
 * into it, so the conversation's shape otherwise survives. The system *prompt*
 * is already one string here (`assemble` renders it) — this is for the
 * mid-conversation injections the assembly places as their own messages.
 *
 * **The separator is one newline**, which is upstream's
 * (`ChatCompletion.squashSystemMessages`, `openai.js:3846` —
 * `lastMessage.content += '\n' + message.content`). It was a blank line here
 * until this was read against the source: two adjacent injections then reached
 * the model spaced differently than the same two reach SillyTavern's, which is
 * a difference in the prompt and not only in the whitespace. It is written out
 * rather than taken from `SYSTEM_JOIN`, and the two now differ: this separator
 * and the system prompt's are decided by two independent upstream lines, so one
 * constant standing for both would let a change to either silently change the
 * other.
 *
 * Three of upstream's guards have no object here, so they are absent rather
 * than dropped: it skips empty system messages (`:3836`, and `injectAtDepth`
 * already refuses a contribution whose text is blank), it skips messages
 * carrying a `name` (`:3841`, and no system-placed message in this pipeline
 * has one — `name` reaches only history entries, which are user or assistant),
 * and it exempts three identifiers (`newMainChat`/`newChat`/`groupNudge`,
 * `:3828`) that Iris does not mint.
 *
 * **A volatile message never merges with a stable one, in either direction.**
 * That is the one addition, and it is not a preference. A merge rewrites the
 * message that absorbs the other; if a moved (volatile) message merged into the
 * stable message in front of it, the stable one would change text every turn —
 * which is exactly the miss the reorder was performed to avoid, reintroduced by
 * a formatting pass one layer down. Volatile messages still merge with each
 * other, and stable ones with each other, so the squash still does its job
 * wherever doing it is free.
 * @param slots - the assembled conversation as slots, oldest first.
 * @returns the conversation with adjacent system runs collapsed, provenance
 *   merged with the text.
 */
export function squashSystemRuns(slots: readonly AssembledSlot[]): AssembledSlot[] {
  const squashed: AssembledSlot[] = []
  for (const slot of slots) {
    const previous = squashed.at(-1)
    const sameSide = (previous?.message.volatile === true) === (slot.message.volatile === true)
    if (slot.message.role === 'system' && previous?.message.role === 'system' && sameSide) {
      previous.message.text = `${previous.message.text}\n${slot.message.text}`
      // The parts follow the text into the surviving slot, in the order they
      // were joined: the one loop that merges two texts is the one loop that
      // merges their provenance, so a merged run can still name each injection
      // inside it.
      previous.parts.push(...slot.parts)
      continue
    }
    squashed.push({ message: { ...slot.message }, parts: [...slot.parts] })
  }
  return squashed
}

/**
 * Record which item produced each text slot of the request being sent.
 *
 * Positional and exhaustive by construction: one entry per outgoing message, in
 * the same order, with the tail appended last so `layout.messages.length` equals
 * `GenerateOptions.messages.length`. A reader that finds those two disagreeing
 * must refuse the offsets rather than shift them by one — a cache report that
 * names the neighbouring item is worse than one that names none.
 * @param segments - the system prompt's seams, as rendered.
 * @param slots - the conversation slots, after the squash and the postfix.
 * @param tail - the message pinned after the conversation, when one rides.
 * @returns the layout to hand along with the request.
 */
function layoutOf(
  segments: readonly SystemSegment[],
  slots: readonly AssembledSlot[],
  tail: PipelineMessage | undefined,
): PromptLayout {
  const messages: LayoutSlot[] = slots.map(slot => ({
    parts: slot.parts.map(part => ({ ...part })),
    role: slot.message.role,
  }))
  // The tail is a slot with no parts: it is this driver's own text, not a
  // contribution, so there is no assembly item to attribute it to. `tail`
  // labels it, which is what lets a trace say "the divergence is in the
  // continue nudge" instead of "in an unattributed slot".
  if (tail !== undefined) messages.push({ parts: [], role: tail.role, tail: true })
  return { system: segments.map(segment => ({ ...segment })), messages }
}

/**
 * Prepend a continue's seed to a generation's content blocks.
 *
 * The seed joins the FIRST text block, so a continuation that carries reasoning
 * keeps that reasoning on its own blocks ahead of the joined text; a generation
 * with no text at all still yields the seed alone, because a continue whose
 * reading came back unchanged is a valid — if disappointing — outcome.
 * @param blocks - the generation's content blocks.
 * @param seed - the text being continued.
 * @returns content blocks opening with the seed.
 */
function joinedWithSeed(blocks: AssistantMessage['content'], seed: string): AssistantMessage['content'] {
  let placed = false
  const joined = blocks.map(block => {
    if (placed || block.type !== 'text') return block
    placed = true
    return { ...block, text: seed + block.text }
  })
  if (placed) return joined
  return [...joined, { type: 'text' as const, text: seed }]
}
