/**
 * Projecting the durable log onto what the browser is allowed to know.
 *
 * The wire shapes are narrower than the log on purpose (see `@iris/protocol`'s
 * `views` module), so this is where the narrowing happens. One rule matters
 * more than the rest: a `MessageView.id` is the message's index in the
 * SillyTavern projection of the chat, which is the same index a card script
 * sees and the same index `chat.editMessage` addresses. Everything that edits
 * by id therefore agrees with everything that renders by id.
 *
 * @module @iris/app-service/views
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { listCandidates, selectedCandidate } from '@iris/chat'
import type { ChatView, MessageView, TurnUsage } from '@iris/protocol'
import type { MacroSubstitute, RegexScript } from '@iris/regex'

import type { PromptFingerprint } from './fingerprint.ts'
import { runScripts } from './regex.ts'
import { conversationUsage, usageBySeq } from './usage.ts'

/** Speaker names, as the surface shows them. */
export interface Names {
  user: string
  character: string
}

/** A turn being generated right now, which has no candidate in the log yet. */
export interface PendingTurn {
  turn: number
  /** Visible text accumulated so far. */
  text: string
  /** Reasoning accumulated so far. */
  reasoning: string
  /**
   * What the provider said this generation cost, once it has said it.
   *
   * Parked here for the rest of the turn because the `usage` chunk arrives
   * before the candidate it belongs to exists — see `ChatEntry.noteUsage`. It
   * is deliberately **not** projected onto the streaming row: a number that
   * appears mid-reply and then moves to the settled row reads as two different
   * facts, and the whole point of this figure is that it is the exact one.
   */
  usage?: TurnUsage
  /**
   * Which request this generation sent (`./fingerprint.ts`), parked here for
   * the same reason `usage` is: it is known before the candidate it belongs to
   * exists.
   *
   * **Never projected onto a message.** `MessageView` carries no hashes — the
   * protocol is unchanged by this record — and a reader meets them on the
   * report line each generation emits, or in the chat file beside the cost.
   */
  fingerprint?: PromptFingerprint
  /**
   * Which route this generation went out on, and when.
   *
   * Parked here for the third time for the same reason `usage` and
   * `fingerprint` are: it is known at the moment the request is composed and
   * the candidate it belongs to does not exist until the turn settles. Noted at
   * the same site as the fingerprint — the one place where the request body is
   * in hand — so the model, the provider and the moment are one reading of one
   * request rather than three guesses taken at three times.
   *
   * **Never projected onto a message either.** It lands on the stored
   * `TurnUsage` when the turn settles, which is where a statistics surface
   * reads it from; a route shown on a streaming row would be a fourth place for
   * the same fact to disagree with itself.
   */
  route?: UsageRoute
}

/**
 * The route a generation went out on, stamped once.
 *
 * `at` is when the **request** went out, not when the reply settled. One site
 * rather than two, and for a figure bucketed by hour or by day the difference
 * is not observable — while a second `Date.now()` taken at settle time would
 * make a turn that streamed across midnight land in a different bucket from the
 * fingerprint recorded beside it.
 */
export interface UsageRoute {
  model?: string
  provider?: string
  /** Unix epoch milliseconds. */
  at: number
}

/** Plain text of a message's content blocks. */
export function textOf(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Reasoning of a message's content blocks, kept on its own channel. */
export function reasoningOf(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('')
}

/**
 * Project the log onto the message list the UI renders.
 *
 * The walk mirrors `exportMessages` in `@iris/persistence`: one line per user
 * message, one line per *turn* of assistant messages, because a turn's
 * candidates are its swipes rather than separate messages. Keeping the two
 * walks aligned is what makes the view index and the chat-file index the same
 * number.
 * @param session - the chat log.
 * Row identity is supplied rather than derived, because it cannot be derived:
 * every candidate — the log `seq`, the turn number — is reassigned when the log
 * is rebuilt, which is exactly what deleting a message does. Only something the
 * caller carries across that rebuild stays put, and staying put across a delete
 * is the entire reason `key` exists.
 * @param session - the chat log.
 * @param names - speaker names.
 * @param options - row keys, the streaming turn if any, and the chat's regex scripts.
 * @returns messages in conversation order, already rewritten for display.
 */
export function projectMessages(
  session: Session,
  names: Names,
  options: {
    keys: readonly string[]
    pending?: PendingTurn | undefined
    scripts?: readonly RegexScript[]
    substitute?: MacroSubstitute | undefined
  },
): MessageView[] {
  const pending = options.pending
  // One pass over the log for the whole projection rather than one per row: the
  // walk below already visits every turn, and a per-row scan would make the
  // cost of rendering a chat quadratic in its length.
  const usages = usageBySeq(session)
  const keyAt = (index: number): string => options.keys[index] ?? `m-orphan-${String(index)}`
  const views: MessageView[] = []
  const seenTurns = new Set<number>()
  let turn = 0

  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      continue
    }

    if (event.type === 'user/message') {
      views.push({
        id: views.length,
        key: keyAt(views.length),
        role: 'user',
        name: names.user,
        text: textOf(event.data as Message),
        turn,
      })
      continue
    }

    if (event.type !== 'assistant/message') continue
    const messageTurn = event.data.turn
    if (seenTurns.has(messageTurn)) continue
    seenTurns.add(messageTurn)

    const candidates = listCandidates(session, messageTurn)
    const current = selectedCandidate(session, messageTurn)
    if (current === undefined) continue

    const reasoning = reasoningOf(current.message)
    // The **selected** candidate's own bill, so the number under the row belongs
    // to the text in the row: swiping to a reply generated an hour ago shows
    // what that reply cost, not what the newest one did. Absent when this
    // candidate reported nothing — an imported reply, a provider that sends no
    // usage, or a generation that failed before the usage chunk.
    const usage = usages.get(current.seq)
    views.push({
      id: views.length,
      key: keyAt(views.length),
      role: 'assistant',
      name: names.character,
      text: textOf(current.message),
      ...reasoning.length > 0 ? { reasoning } : {},
      swipes: { count: candidates.length, index: current.index },
      turn: messageTurn,
      ...usage === undefined ? {} : { usage },
    })
  }

  if (pending !== undefined && !seenTurns.has(pending.turn)) {
    // A page that opens a chat mid-generation would otherwise see the user's
    // message and nothing after it, with no way to tell a stalled host from a
    // working one. The partial text is real host state, so it is shown.
    views.push({
      id: views.length,
      // The same slot the settled row will occupy, so it inherits this key: the
      // streaming row becomes that row rather than being replaced by it, and
      // nothing remounts mid-reply.
      key: keyAt(views.length),
      role: 'assistant',
      name: names.character,
      text: pending.text,
      ...pending.reasoning.length > 0 ? { reasoning: pending.reasoning } : {},
      turn: pending.turn,
      streaming: true,
    })
  } else if (pending !== undefined) {
    // A regenerate streams over a turn that already has candidates: mark the
    // existing line rather than appending a second one.
    const last = views[views.length - 1]
    if (last !== undefined && last.turn === pending.turn) {
      // The cost goes with the text it paid for. This row is showing the reply
      // being generated now, while `usage` on it was the *previous* selected
      // candidate's bill — leaving it would put a settled number under text
      // that has not been charged yet, and it would even change as the user
      // watched, since the new candidate becomes selected once it lands.
      const { usage: _superseded, ...settled } = last
      views[views.length - 1] = { ...settled, text: pending.text, streaming: true }
    }
  }

  const scripts = options.scripts ?? []
  if (scripts.length === 0) return views

  // Display scripts run here, in the host, so every page shows the same text
  // and the regex engine exists once. Depth counts back from the end of the
  // conversation, which is what a script's minDepth/maxDepth is measured in.
  return views.map((view, index) => ({
    ...view,
    text: runScripts(view.text, view.role, scripts, {
      isMarkdown: true,
      depth: views.length - 1 - index,
      substitute: options.substitute,
    }),
  }))
}

/**
 * Everything this conversation ever paid a provider for, added up.
 *
 * **Every candidate, not every selected candidate.** A regenerated reply was
 * billed; the fact that the user swiped away from it does not refund it, and a
 * running total that only counted the visible readings would understate a
 * conversation the user swiped through by exactly the interesting amount.
 *
 * Carries **no `totalTokens`**: an aggregate total is summed only over the
 * generations that reported one, so it undercounts a conversation that mixed
 * providers and reads as the total anyway. `conversationUsage` is where that
 * ruling lives.
 *
 * Walked by turn and candidate rather than by summing the `iris/usage` events
 * directly: the events are keyed by candidate seq, and reading them through the
 * candidate list is what guarantees the total describes replies this log still
 * holds. (Nothing removes a candidate today — a deletion rebuilds the log
 * instead — so the two agree; the walk is what keeps them agreeing if that
 * changes.)
 * @param session - the chat log.
 * @returns the sum, or `undefined` when no generation here reported anything.
 */
function totalUsage(session: Session): TurnUsage | undefined {
  const usages = usageBySeq(session)
  if (usages.size === 0) return undefined
  const found: TurnUsage[] = []
  const seenTurns = new Set<number>()
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const turn = event.data.turn
    if (seenTurns.has(turn)) continue
    seenTurns.add(turn)
    for (const candidate of listCandidates(session, turn)) {
      const usage = usages.get(candidate.seq)
      if (usage !== undefined) found.push(usage)
    }
  }
  return conversationUsage(found)
}

/**
 * Build the whole open-conversation view.
 * @param input - identity, the log, speaker names and the newest turn's variables.
 * @returns the view to send.
 */
export function toChatView(input: {
  chatId: string
  title: string
  characterId?: string | undefined
  session: Session
  names: Names
  keys: readonly string[]
  pending?: PendingTurn | undefined
  scripts?: readonly RegexScript[] | undefined
  substitute?: MacroSubstitute | undefined
  variables?: Record<string, unknown> | undefined
}): ChatView {
  const usage = totalUsage(input.session)
  return {
    chatId: input.chatId,
    title: input.title,
    ...input.characterId === undefined ? {} : { characterId: input.characterId },
    messages: projectMessages(input.session, input.names, {
      keys: input.keys,
      pending: input.pending,
      ...input.scripts === undefined ? {} : { scripts: input.scripts },
      substitute: input.substitute,
    }),
    ...input.variables === undefined ? {} : { variables: input.variables },
    ...usage === undefined ? {} : { usage },
  }
}
