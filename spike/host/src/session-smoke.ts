/**
 * Phase-0 spike, step 4.
 *
 * Proves three things the Iris plan depends on:
 *
 * 1. `dsh-session` runs standalone — no `dsh-session-persistence`, no Cordis
 *    context, no agent. If this holds, we can reuse the log core and write our
 *    own SillyTavern-JSONL-compatible persistence backend.
 * 2. A downstream plugin can extend `SessionEventMap` and append its own event
 *    types. (The read-path guard that refuses unknown types lives in
 *    `dsh-session-persistence`, not here — which is exactly why we replace it.)
 * 3. `surfaceOp: { op: 'replace' }` can shadow a prior `assistant/message`,
 *    so alternate generations ("swipes") are expressible as surface
 *    replacements while every candidate stays in the durable log.
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

// (2) Downstream vocabulary extension: our own event type, declared from outside
// the harness repository.
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Which candidate of a completed turn the reader should surface. */
    'iris/swipe-select': { turn: number; selectedSeq: number }
  }
}

/** Assert a condition, or exit non-zero with the reason. */
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  console.error(`  FAIL ${label}`, detail ?? '')
  process.exitCode = 1
}

/** Text of every message currently on the surface, in model order. */
function surfaceTexts(session: Session): string[] {
  return session.deriveMessages().map(message =>
    message.content.map(block => (block.type === 'text' ? block.text : `<${block.type}>`)).join(''))
}

const PROVENANCE = { provider: 'spike', model: 'spike-model' } as const

console.log('session-smoke: dsh-session standalone, custom events, swipe-as-replace\n')

// (1) No Cordis context, no persistence plugin, no agent.
const session = Session.create(SessionId('iris-spike-session'))
check('Session.create() works with no context and no persistence', session.seq === 0)

session.append('turn/start', { turn: 0 })
session.append('step/start', { turn: 0, step: 0 })

const userSeq = session.append(
  'user/message',
  createUserMessage({ content: [{ type: 'text', text: 'Hello there.' }], source: { kind: 'user' } }),
  { surfaceOp: 'append' },
).seq

// First candidate.
const candidateA = session.append(
  'assistant/message',
  {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Candidate A.' }],
      source: PROVENANCE,
    }),
  },
  { surfaceOp: 'append', sourceEventSeqs: [] },
).seq

check('surface holds the user message and candidate A', surfaceTexts(session).join(' | ') === 'Hello there. | Candidate A.', surfaceTexts(session))

// (3) A swipe: regenerate produces a second candidate that SHADOWS the first.
const candidateB = session.append(
  'assistant/message',
  {
    turn: 0,
    step: 0,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Candidate B.' }],
      source: PROVENANCE,
    }),
  },
  { surfaceOp: { op: 'replace', start: candidateA, end: candidateA }, sourceEventSeqs: [candidateA] },
).seq

check(
  'surface now shows candidate B in place of A',
  surfaceTexts(session).join(' | ') === 'Hello there. | Candidate B.',
  surfaceTexts(session),
)
check('surface node order is [user, candidateB]', String(session.surface.nodes) === String([userSeq, candidateB]), session.surface.nodes)
check('one positional replacement was committed', session.surface.replaceGeneration === 1, session.surface.replaceGeneration)

// The whole point: the shadowed candidate is still in the durable log, so the
// UI can offer it as a swipe and the exporter can emit SillyTavern `swipes[]`.
const loggedCandidates = session.events.filter(event => event.type === 'assistant/message')
check('both candidates remain in the log (swipe history survives)', loggedCandidates.length === 2, loggedCandidates.length)

// (2) Append our own event type.
session.append('iris/swipe-select', { turn: 0, selectedSeq: candidateB })
const ours = session.events.filter(event => event.type === 'iris/swipe-select')
check('a downstream-declared event type appends and reads back', ours.length === 1 && ours[0]?.data.selectedSeq === candidateB, ours)

session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

console.log(`\nlog length: ${session.seq} events, surface: ${session.surface.nodes.length} nodes`)
console.log(process.exitCode === 1 ? '\nSESSION SMOKE FAILED' : '\nsession smoke passed')
