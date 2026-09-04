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
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate, listCandidates, selectCandidate, selectedCandidate, type Candidate } from '@iris/chat'
import { assemble, type Budget, type Contribution, type HistoryEntry, type PipelineMessage } from '@iris/pipeline'

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
  /** Turn the durable log into the conversation the model should see. */
  history: (session: Session) => readonly HistoryEntry[]
  budget: Budget
  /** Sampling beyond the harness's own fields; the Iris adapter reads it. */
  sampling?: GenerateOptions['sampling']
  temperature?: number
  maxTokens?: number
  stop?: string[]
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
   * @returns the recorded candidate.
   * @throws {TurnError} when the provider ends the stream with a failure.
   */
  async #generate(session: Session, turn: number, events: GenerateEvents = {}): Promise<Candidate> {
    const options = this.#options
    const request = assemble({
      contributions: await options.contributions(session),
      history: options.history(session),
      budget: options.budget,
    })

    const assembler = new BlockAssembler()
    for await (const chunk of options.stream({
      provider: options.provider,
      model: options.model,
      system: request.system,
      messages: request.messages.map(toMessage),
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
    return appendCandidate(session, {
      turn,
      step: 0,
      message: createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: options.provider,
          model: options.model,
          ...replayState === undefined ? {} : { replayState },
        },
      }),
    })
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
   * @param session - the chat log.
   * @param events - streaming callbacks and cancellation.
   * @returns the new candidate, now the selected one.
   * @throws {TurnError} when the log has no turn to regenerate.
   */
  async regenerate(session: Session, events: GenerateEvents = {}): Promise<Candidate> {
    const turn = lastTurn(session)
    if (turn < 0) throw new TurnError('there is no turn to regenerate')
    return this.#generate(session, turn, events)
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
