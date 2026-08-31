/**
 * Alternate generations ("swipes") over the append-only session log.
 *
 * SillyTavern stores swipes as a `swipes[]` array plus a `swipe_id` on the
 * message. The harness log has no such field and only three event types can
 * reach the model at all (`user/message`, `assistant/message`, `tool/result`),
 * so a candidate has to *be* an `assistant/message`. What makes that work is
 * the surface: `surfaceOp: {op:'replace'}` lets a newer node shadow an older
 * one, so the conversation the model sees carries exactly one candidate per
 * turn while every candidate stays in the durable log.
 *
 * The result round-trips to SillyTavern's shape: a turn's candidates are its
 * `swipes[]`, and the selected one is `swipe_id`.
 *
 * @module @iris/chat/swipes
 */

import { createAssistantMessage, type AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './events.ts'

/** One alternate generation of a turn. */
export interface Candidate {
  /** Seq of the `assistant/message` event that first produced this text. */
  readonly seq: number
  /** Position among the turn's candidates, in production order. */
  readonly index: number
  /** The generated message. */
  readonly message: AssistantMessage
}

/** What `appendCandidate` needs to place one generation. */
export interface CandidateInput {
  readonly turn: number
  readonly step: number
  readonly message: AssistantMessage
}

/** Raised when a swipe operation is asked for something the log cannot express. */
export class SwipeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwipeError'
  }
}

/** Every `assistant/message` event belonging to one turn, in log order. */
function assistantEventsOfTurn(session: Session, turn: number): SessionEvent<'assistant/message'>[] {
  return session.events.filter(
    (event): event is SessionEvent<'assistant/message'> =>
      event.type === 'assistant/message' && event.data.turn === turn,
  )
}

/** Seqs appended purely to re-surface an earlier candidate, so they are not candidates themselves. */
function materializedSeqs(session: Session, turn: number): Set<number> {
  const seqs = new Set<number>()
  for (const event of session.events) {
    if (event.type === 'iris/swipe-select' && event.data.turn === turn) {
      seqs.add(event.data.materializedSeq)
    }
  }
  return seqs
}

/**
 * The turn's alternate generations, oldest first.
 * @param session - the chat log.
 * @param turn - turn number.
 * @returns one entry per genuine generation; re-selections of an earlier
 *   candidate are excluded, so the list matches SillyTavern's `swipes[]`.
 */
export function listCandidates(session: Session, turn: number): Candidate[] {
  const materialized = materializedSeqs(session, turn)
  const candidates: Candidate[] = []
  for (const event of assistantEventsOfTurn(session, turn)) {
    if (materialized.has(event.seq)) continue
    candidates.push({ seq: event.seq, index: candidates.length, message: event.data.message })
  }
  return candidates
}

/**
 * The candidate currently in front of the model.
 * @param session - the chat log.
 * @param turn - turn number.
 * @returns the selected candidate, or `undefined` when the turn produced none.
 */
export function selectedCandidate(session: Session, turn: number): Candidate | undefined {
  const candidates = listCandidates(session, turn)
  if (candidates.length === 0) return undefined

  // The last recorded selection wins; with none, the newest generation is current.
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'iris/swipe-select' && event.data.turn === turn) {
      const chosen = candidates.find(candidate => candidate.seq === event.data.candidateSeq)
      if (chosen !== undefined) return chosen
      break
    }
  }
  return candidates[candidates.length - 1]
}

/** The surface node currently holding this turn's assistant message, if any. */
function surfaceSeqOfTurn(session: Session, turn: number): number | undefined {
  const owned = new Set(assistantEventsOfTurn(session, turn).map(event => event.seq))
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index]
    if (seq !== undefined && owned.has(seq)) return seq
  }
  return undefined
}

/**
 * Append one generation for a turn, making it the visible candidate.
 *
 * The first generation of a turn extends the surface; every later one shadows
 * the candidate it supersedes, so the model keeps seeing exactly one reply per
 * turn no matter how many times the user regenerates.
 * @param session - the chat log.
 * @param input - the turn/step coordinates and the generated message.
 * @returns the appended candidate.
 */
export function appendCandidate(session: Session, input: CandidateInput): Candidate {
  const shadowed = surfaceSeqOfTurn(session, input.turn)
  const event = session.append(
    'assistant/message',
    { turn: input.turn, step: input.step, message: input.message },
    shadowed === undefined
      ? { surfaceOp: 'append', sourceEventSeqs: [] }
      : { surfaceOp: { op: 'replace', start: shadowed, end: shadowed }, sourceEventSeqs: [shadowed] },
  )

  const candidates = listCandidates(session, input.turn)
  const appended = candidates[candidates.length - 1]
  if (appended === undefined) throw new SwipeError('appended candidate did not reach the candidate list')
  return appended
}

/**
 * Put an earlier candidate back in front of the model.
 *
 * Surface nodes can only be shadowed by newer events, never revived, so this
 * appends a fresh `assistant/message` carrying the chosen text and records the
 * lineage in `iris/swipe-select`. The new message gets its own id: message
 * identity is per-appearance, while candidate identity is the seq the swipe
 * list is keyed by.
 * @param session - the chat log.
 * @param turn - turn number.
 * @param index - position in {@link listCandidates}.
 * @returns the now-selected candidate.
 * @throws {SwipeError} when the index is out of range, or when a later turn has
 *   already been recorded — the surface is a single thread, so only the last
 *   turn's swipes can still be changed.
 */
export function selectCandidate(session: Session, turn: number, index: number): Candidate {
  const candidates = listCandidates(session, turn)
  const target = candidates[index]
  if (target === undefined) {
    throw new SwipeError(`turn ${turn} has ${candidates.length} candidates; no index ${index}`)
  }

  const laterTurn = session.events.some(
    event => event.type === 'assistant/message' && event.data.turn > turn,
  )
  if (laterTurn) throw new SwipeError(`turn ${turn} is not the last turn; its swipes are settled`)

  const current = selectedCandidate(session, turn)
  if (current?.seq === target.seq) return target

  const shadowed = surfaceSeqOfTurn(session, turn)
  if (shadowed === undefined) throw new SwipeError(`turn ${turn} has no message on the surface`)

  const materialized = session.append(
    'assistant/message',
    {
      turn,
      step: 0,
      // A new identity for a new appearance; the text and provenance are the
      // chosen candidate's.
      message: createAssistantMessage({
        content: [...target.message.content],
        source: { provider: target.message.source.provider, model: target.message.source.model },
      }),
    },
    { surfaceOp: { op: 'replace', start: shadowed, end: shadowed }, sourceEventSeqs: [shadowed] },
  )

  session.append('iris/swipe-select', {
    turn,
    candidateSeq: target.seq,
    materializedSeq: materialized.seq,
  })

  return target
}
