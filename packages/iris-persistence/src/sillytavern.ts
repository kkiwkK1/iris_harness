/**
 * The SillyTavern chat file: JSONL, one object per line.
 *
 * Line 0 is metadata; every later line is a message. The format is the main
 * migration path into and out of Iris, so the rule here is that a file must
 * survive `import → export` byte-for-byte in content, including fields Iris has
 * no opinion about. Per-message extras hold other extensions' payloads (images,
 * TTS clips, reasoning, token counts); losing them silently would break the
 * user's history for tools Iris has never heard of.
 *
 * @module @iris/persistence/sillytavern
 */

import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { appendCandidate, listCandidates, selectCandidate, selectedCandidate } from '@iris/chat'

/** Fields Iris does not model, carried through so a round trip loses nothing. */
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /**
     * Verbatim SillyTavern message fields, keyed to the log event they came
     * with. Log-only: the model never sees it, but an export must reproduce it.
     */
    'iris/st-meta': {
      /** Seq of the `user/message` or `assistant/message` event this describes. */
      seq: number
      /** Every key from the original line that Iris does not itself model. */
      fields: Record<string, unknown>
    }
  }
}

/** The first line of a SillyTavern chat file. */
export interface SillyTavernChatHeader {
  user_name: string
  character_name: string
  create_date: string
  chat_metadata: Record<string, unknown>
  [key: string]: unknown
}

/** One message line. */
export interface SillyTavernMessage {
  name: string
  is_user: boolean
  is_system?: boolean
  send_date?: string
  mes: string
  extra?: Record<string, unknown>
  swipes?: string[]
  swipe_id?: number
  [key: string]: unknown
}

/** A parsed chat file. */
export interface SillyTavernChat {
  header: SillyTavernChatHeader
  messages: SillyTavernMessage[]
}

/** Message keys Iris models itself; everything else is carried in `fields`. */
const MODELLED_KEYS = new Set(['name', 'is_user', 'mes', 'swipes', 'swipe_id'])

/** Provenance stamped on messages restored from a file. */
const IMPORTED = { provider: 'sillytavern', model: 'imported' } as const

/**
 * Parse a SillyTavern chat file.
 * @param text - the file's contents.
 * @returns the header and messages.
 * @throws {Error} when the file is empty or its first line is not an object.
 */
export function parseChatFile(text: string): SillyTavernChat {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  const first = lines[0]
  if (first === undefined) throw new Error('SillyTavern chat file is empty')

  const header = JSON.parse(first) as SillyTavernChatHeader
  if (typeof header !== 'object' || header === null) {
    throw new Error('SillyTavern chat file does not begin with a metadata object')
  }

  return {
    header,
    messages: lines.slice(1).map(line => JSON.parse(line) as SillyTavernMessage),
  }
}

/**
 * Serialize a chat back to the file format.
 * @param chat - header and messages.
 * @returns JSONL text, newline-terminated.
 */
export function formatChatFile(chat: SillyTavernChat): string {
  return [chat.header, ...chat.messages].map(line => JSON.stringify(line)).join('\n') + '\n'
}

/** Plain text of a message's content blocks. */
function textOf(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Stash the fields Iris does not model, so an export can put them back. */
function rememberFields(session: Session, seq: number, line: SillyTavernMessage): void {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(line)) {
    if (!MODELLED_KEYS.has(key)) fields[key] = value
  }
  if (Object.keys(fields).length > 0) session.append('iris/st-meta', { seq, fields })
}

/**
 * Rebuild an Iris chat log from a SillyTavern file.
 *
 * Swipes come back as real candidates rather than a flattened current reply, so
 * an imported conversation keeps every alternate generation the user had.
 * @param chat - the parsed file.
 * @param id - identity for the restored session.
 * @returns the reconstructed log.
 */
export function importChat(chat: SillyTavernChat, id: string): Session {
  const session = Session.create(SessionId(id))
  let turn = 0

  for (const line of chat.messages) {
    if (line.is_user) {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 0 })
      const event = session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: line.mes }], source: { kind: 'user' } }),
        { surfaceOp: 'append' },
      )
      rememberFields(session, event.seq, line)
      continue
    }

    // An assistant line carries its whole swipe set; `mes` is whichever one is
    // selected, so the list is the source of truth and `mes` only picks from it.
    const texts = line.swipes !== undefined && line.swipes.length > 0 ? line.swipes : [line.mes]
    let firstSeq: number | undefined
    for (const text of texts) {
      const candidate = appendCandidate(session, {
        turn,
        step: 0,
        message: createAssistantMessage({ content: [{ type: 'text', text }], source: IMPORTED }),
      })
      firstSeq ??= candidate.seq
    }

    const chosen = line.swipe_id ?? 0
    if (chosen < texts.length - 1) selectCandidate(session, turn, chosen)
    if (firstSeq !== undefined) rememberFields(session, firstSeq, line)

    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
  }

  return session
}

/** Look up the carried-through fields for one event. */
function fieldsFor(session: Session, seq: number): Record<string, unknown> {
  for (const event of session.events) {
    if (event.type === 'iris/st-meta' && event.data.seq === seq) return event.data.fields
  }
  return {}
}

/**
 * Render an Iris chat log back into SillyTavern's message list.
 * @param session - the chat log.
 * @param header - the file header, which supplies the speaker names.
 * @returns message lines in conversation order.
 */
export function exportMessages(session: Session, header: SillyTavernChatHeader): SillyTavernMessage[] {
  const lines: SillyTavernMessage[] = []
  const seenTurns = new Set<number>()

  for (const event of session.events as readonly SessionEvent[]) {
    if (event.type === 'user/message') {
      lines.push({
        name: header.user_name,
        is_user: true,
        mes: textOf(event.data),
        ...fieldsFor(session, event.seq),
      })
      continue
    }

    if (event.type !== 'assistant/message') continue

    // One line per turn, not per candidate: the candidates ARE the swipe list.
    const turn = event.data.turn
    if (seenTurns.has(turn)) continue
    seenTurns.add(turn)

    const candidates = listCandidates(session, turn)
    const current = selectedCandidate(session, turn)
    const swipes = candidates.map(candidate => textOf(candidate.message))
    const swipeId = current === undefined ? 0 : current.index
    const first = candidates[0]

    lines.push({
      name: header.character_name,
      is_user: false,
      mes: swipes[swipeId] ?? '',
      swipes,
      swipe_id: swipeId,
      ...(first === undefined ? {} : fieldsFor(session, first.seq)),
    })
  }

  return lines
}

/**
 * Export a whole chat file.
 * @param session - the chat log.
 * @param header - the file header to write.
 * @returns JSONL text.
 */
export function exportChatFile(session: Session, header: SillyTavernChatHeader): string {
  return formatChatFile({ header, messages: exportMessages(session, header) })
}
