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
import type { ChatView, MessageView } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'

import { runScripts } from './regex.ts'

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
  options: { keys: readonly string[], pending?: PendingTurn | undefined, scripts?: readonly RegexScript[] },
): MessageView[] {
  const pending = options.pending
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
    views.push({
      id: views.length,
      key: keyAt(views.length),
      role: 'assistant',
      name: names.character,
      text: textOf(current.message),
      ...reasoning.length > 0 ? { reasoning } : {},
      swipes: { count: candidates.length, index: current.index },
      turn: messageTurn,
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
      views[views.length - 1] = { ...last, text: pending.text, streaming: true }
    }
  }

  const scripts = options.scripts ?? []
  if (scripts.length === 0) return views

  // Display scripts run here, in the host, so every page shows the same text
  // and the regex engine exists once. Depth counts back from the end of the
  // conversation, which is what a script's minDepth/maxDepth is measured in.
  return views.map((view, index) => ({
    ...view,
    text: runScripts(view.text, view.role, scripts, { isMarkdown: true, depth: views.length - 1 - index }),
  }))
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
  variables?: Record<string, unknown> | undefined
}): ChatView {
  return {
    chatId: input.chatId,
    title: input.title,
    ...input.characterId === undefined ? {} : { characterId: input.characterId },
    messages: projectMessages(input.session, input.names, {
      keys: input.keys,
      pending: input.pending,
      ...input.scripts === undefined ? {} : { scripts: input.scripts },
    }),
    ...input.variables === undefined ? {} : { variables: input.variables },
  }
}
