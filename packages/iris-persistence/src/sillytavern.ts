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
      /**
       * Index into `iris/st-key-order`'s table, giving the line's original key
       * sequence.
       *
       * **This is the whole of what the duplicated `variables` value used to
       * buy.** An assistant line's `variables` are reconstructed from the log,
       * so carrying the value here as well cost 25.81 MiB across the corpus —
       * 93.6% of everything this event holds — to preserve one thing: *where in
       * the line the key sat*. Recorded directly instead, at 4452 B for the
       * whole corpus.
       */
      order?: number
    }
    /**
     * The distinct key sequences seen in one file, deduplicated.
     *
     * A table rather than a per-line array because the corpus holds **14
     * distinct orders across 2454 lines**: storing the sequence on each line
     * would be 0.35 MiB of the same fourteen strings. It degrades gracefully —
     * a new card contributes one more row, not one more array per line.
     */
    'iris/st-key-order': { orders: string[][] }
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

/**
 * Message keys Iris models itself; everything else is carried in `fields`.
 *
 * **`name` is deliberately not here.** It looks modelled — the projection
 * writes one from the header — but the real files on this machine say
 * otherwise: measured over the 31 chats, most carry header names that are
 * literally `"unused"` while the *lines* carry the real speaker names (and
 * some user rows are spoken by a character of the user's own). Deriving the
 * name from the header would rewrite every speaker on an export, so the
 * line's own `name` rides in `fields` and overrides the derived one — the
 * same treatment `extra` and `send_date` get. A header name is only a
 * fallback for lines this log created itself.
 */
const MODELLED_KEYS = new Set(['is_user', 'mes', 'swipes', 'swipe_id'])

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

/**
 * Keys carried by value for user lines but only by position for assistant ones.
 *
 * An assistant line's `variables` are rebuilt from the log — `hydrateVariables`
 * puts them back on import and the snapshot writes them on export — so storing
 * the value here too was a second copy of the same table. A **user** line's
 * `variables` have no other source and are still carried in full.
 */
const REBUILT_KEYS = new Set(['variables'])

/**
 * Stash the fields Iris does not model, so an export can put them back.
 *
 * The line's key sequence is recorded whether or not any field is carried,
 * because the sequence is what an export needs in order to put a rebuilt key
 * back where it was rather than at the end.
 * @param session - the log being built.
 * @param seq - the message event these fields belong to.
 * @param line - the original file line.
 * @param orders - the file's key-order table, appended to as new orders appear.
 */
function rememberFields(
  session: Session,
  seq: number,
  line: SillyTavernMessage,
  orders: string[][],
): void {
  const fields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(line)) {
    if (MODELLED_KEYS.has(key)) continue
    if (!line.is_user && REBUILT_KEYS.has(key)) continue
    fields[key] = value
  }

  const sequence = Object.keys(line)
  // Escaped, never the character itself: a literal NUL in source is invisible
  // in review, survives every copy, and makes the whole file read as binary to
  // git and grep. The separator only has to be a character no key contains.
  const encoded = sequence.join('\u0000')
  let index = orders.findIndex(known => known.join('\u0000') === encoded)
  if (index === -1) index = orders.push(sequence) - 1

  if (Object.keys(fields).length > 0 || index >= 0) {
    session.append('iris/st-meta', { seq, fields, order: index })
  }
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
  // Filled as lines are read and appended once at the end: the table is small
  // and shared, and every `iris/st-meta` above refers into it by index.
  const orders: string[][] = []
  let turn = 0
  /**
   * Whether this turn has had its `turn/start` yet.
   *
   * **A SillyTavern chat file usually opens with the character's greeting — an
   * assistant line —** and a greeting-only file is exactly what an imported
   * conversation starts as. Restoring that first turn without a `turn/start`
   * left the session reporting `lastTurn === -1`, so the first message a user
   * sent afterwards opened "turn 0" a second time and its reply was appended
   * to the *greeting's* swipe list: on export, one floor had become a
   * three-entry swipe list and the exchange that produced it had vanished.
   * Every turn gets its opening event, whichever kind of line opens it.
   */
  let started = false
  const startTurn = (): void => {
    if (started) return
    session.append('turn/start', { turn })
    started = true
  }

  for (const line of chat.messages) {
    startTurn()
    if (line.is_user) {
      session.append('step/start', { turn, step: 0 })
      const event = session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: line.mes }], source: { kind: 'user' } }),
        { surfaceOp: 'append' },
      )
      rememberFields(session, event.seq, line, orders)
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
    if (firstSeq !== undefined) rememberFields(session, firstSeq, line, orders)

    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    turn += 1
    started = false
  }

  if (orders.length > 0) session.append('iris/st-key-order', { orders })
  return session
}

/**
 * The carried-through fields for one message line.
 *
 * **The newest record wins.** Import appends one of these per line, and for a
 * long time that was the only writer, so first-or-last never came up. It does
 * now: a field that has to change after import — `ignore_cleanup` on a user
 * row, which upstream keeps at `chat[1].variables[0]` — is recorded by
 * appending a fresh set rather than editing history, and an append that the
 * reader ignores is not a record of anything.
 * @param session - the chat log.
 * @param seq - the message event whose line to read.
 * @returns the fields, empty for a line this log never imported.
 */
export function rowFields(session: Session, seq: number): Record<string, unknown> {
  let found: Record<string, unknown> = {}
  for (const event of session.events) {
    if (event.type === 'iris/st-meta' && event.data.seq === seq) found = event.data.fields
  }
  return found
}

/**
 * The original key sequence of the line one event came from.
 * @param session - the chat log.
 * @param seq - the message event.
 * @returns the sequence, or undefined for a line this log never imported.
 */
function keyOrderFor(session: Session, seq: number): string[] | undefined {
  let index: number | undefined
  for (const event of session.events) {
    if (event.type === 'iris/st-meta' && event.data.seq === seq) index = event.data.order
  }
  if (index === undefined) return undefined
  for (const event of session.events) {
    if (event.type === 'iris/st-key-order') return event.data.orders[index]
  }
  return undefined
}

/**
 * Every exported line's original key sequence, for callers that add keys later.
 *
 * A `WeakMap` rather than a field on the line: the sequence must not reach the
 * file, and anything stored on the object itself would have to be deleted again
 * before serialising — a step whose omission would be invisible until someone
 * diffed an export.
 */
const ORDERS = new WeakMap<SillyTavernMessage, string[]>()

/**
 * Note the key sequence an exported line should end up with.
 * @param session - the chat log.
 * @param seq - the message event the line came from.
 * @param line - the line just built.
 * @returns the same line, for use in an expression.
 */
function remember(session: Session, seq: number, line: SillyTavernMessage): SillyTavernMessage {
  const order = keyOrderFor(session, seq)
  if (order !== undefined) ORDERS.set(line, order)
  return line
}

/**
 * Put a line's keys back in the order the original file had them.
 *
 * Tolerant in both directions, because neither case is an error: a key the
 * recorded order does not mention is **appended** (Iris grew a field the file
 * did not have), and a key the order mentions but the line lacks is **skipped**
 * (the field was dropped). Only the keys present in both are positioned.
 * @param line - a line from {@link exportMessages}, possibly with keys added.
 * @returns the same content with the original key sequence, or the line
 * unchanged when nothing recorded an order for it.
 */
export function withOriginalKeyOrder(line: SillyTavernMessage): SillyTavernMessage {
  const order = ORDERS.get(line)
  if (order === undefined) return line

  const ordered: Record<string, unknown> = {}
  for (const key of order) {
    if (Object.hasOwn(line, key)) ordered[key] = (line as Record<string, unknown>)[key]
  }
  for (const [key, value] of Object.entries(line)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  return ordered as SillyTavernMessage
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
      lines.push(remember(session, event.seq, {
        name: header.user_name,
        is_user: true,
        mes: textOf(event.data),
        ...rowFields(session, event.seq),
      }))
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

    lines.push(first === undefined
      ? {
          name: header.character_name,
          is_user: false,
          mes: swipes[swipeId] ?? '',
          swipes,
          swipe_id: swipeId,
        }
      : remember(session, first.seq, {
          name: header.character_name,
          is_user: false,
          mes: swipes[swipeId] ?? '',
          swipes,
          swipe_id: swipeId,
          ...rowFields(session, first.seq),
        }))
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
