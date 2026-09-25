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
 * Where a reply's reasoning lives in the file: `extra.reasoning`, the key
 * upstream's `ReasoningHandler.updateReasoning({ persist: true })` writes
 * (`public/scripts/reasoning.js:415`), beside `extra.reasoning_type`.
 *
 * **Until 2026-09-26 Iris wrote neither and read neither.** A reply's reasoning
 * lived only as a block on the in-memory candidate, so it vanished on a host
 * restart, on a reload, and on every log rebuild — which an edit, a card's
 * `setChatMessages` and a sentence trim all perform. For a reply whose model put
 * everything in `reasoning_content` and sent no `content` at all (measured in
 * the owner's 黑兽 chats: three generations whose provider-reported
 * `reasoning_tokens` equal their `completion_tokens`, 4086 of 4086 on the
 * newest), that erased the whole reply: the file kept `mes: ""` and nothing
 * else. And a chat imported from SillyTavern showed none of the reasoning its
 * file carried.
 */
export const REASONING_FIELD = 'reasoning'
/** Beside {@link REASONING_FIELD}; upstream's `ReasoningType.Model` is what a provider-sent trace is marked with. */
export const REASONING_TYPE_FIELD = 'reasoning_type'
/** The {@link REASONING_TYPE_FIELD} upstream gives a trace the model sent (`reasoning.js:57`). */
const REASONING_TYPE_MODEL = 'model'

/** A value as a plain object, or undefined when it is anything else. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * The reasoning one swipe of an imported line carries.
 *
 * The line's own `extra` describes the swipe it is showing, and upstream keeps
 * every swipe's copy in `swipe_info[i].extra` (`setFirstSwipe`,
 * `public/script.js:3774`), so the selected swipe reads the line and the others
 * read their `swipe_info` entry. Any non-empty string is taken exactly as it
 * is, whitespace included: the export compares against it to decide whether
 * the line changed, and a trimmed copy would make every imported line look
 * edited.
 * @param line - the file line.
 * @param swipe - which swipe.
 * @param chosen - the line's `swipe_id`.
 * @returns the reasoning, or undefined when that swipe has none.
 */
function importedReasoning(line: SillyTavernMessage, swipe: number, chosen: number): string | undefined {
  const extra = swipe === chosen
    ? objectOf(line.extra)
    : objectOf(objectOf(Array.isArray(line['swipe_info']) ? (line['swipe_info'] as unknown[])[swipe] : undefined)?.['extra'])
  const value = extra?.[REASONING_FIELD]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Put the selected candidate's reasoning on an exported line's `extra`.
 *
 * **Only a change is written.** An imported line whose selected swipe still
 * carries the reasoning it came with is left alone, so an untouched file still
 * exports byte for byte. A line whose selected candidate reasons differently
 * gets a *copy* of `extra` with the new value (the carried object is the log's
 * frozen record, see `writeTiming`); one whose selected candidate has none but
 * whose carried `extra` still holds another swipe's trace loses that trace,
 * because the line's `extra` describes the swipe it shows and would otherwise
 * be read back onto the wrong reading.
 *
 * Only the selected candidate's is written, as with the generation timer: the
 * other readings' traces stay in the log until the chat is reloaded, when a
 * swipe Iris generated shows no reasoning. Upstream keeps them in
 * `swipe_info[i].extra`; a line Iris wrote carries no `swipe_info` today.
 * @param line - the line, mutated in place.
 * @param reasoning - the selected candidate's reasoning, `''` for none.
 */
function writeReasoning(line: SillyTavernMessage, reasoning: string): void {
  const carried = objectOf(line.extra)
  const current = carried?.[REASONING_FIELD]
  if (reasoning.length > 0) {
    if (current === reasoning) return
    const extra: Record<string, unknown> = { ...carried, [REASONING_FIELD]: reasoning }
    if (extra[REASONING_TYPE_FIELD] === undefined) extra[REASONING_TYPE_FIELD] = REASONING_TYPE_MODEL
    line.extra = extra
    return
  }
  if (typeof current !== 'string' || current.length === 0 || carried === undefined) return
  const { [REASONING_FIELD]: _dropped, [REASONING_TYPE_FIELD]: _type, ...rest } = carried
  line.extra = rest
}

/** The reasoning blocks of a message, joined. */
function reasoningOf(message: { content: readonly { type: string, text?: string }[] }): string {
  return message.content.filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('')
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
    const chosen = line.swipe_id ?? 0
    let firstSeq: number | undefined
    for (const [swipe, text] of texts.entries()) {
      const reasoning = importedReasoning(line, swipe, chosen)
      const candidate = appendCandidate(session, {
        turn,
        step: 0,
        message: createAssistantMessage({
          content: reasoning === undefined
            ? [{ type: 'text', text }]
            : [{ type: 'reasoning', text: reasoning }, { type: 'text', text }],
          source: IMPORTED,
        }),
      })
      firstSeq ??= candidate.seq
    }

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
 * The top-level key a line Iris wrote carries its durable identity under.
 *
 * **Minted, never derived** (owner ruling 6, 2026-09-25). A floor's index moves
 * whenever a line above it is deleted, and its text changes on every edit and
 * swipe, so neither can say "this is the same line" across a branch or an
 * edit; a random id that rides with the line can. It is a sibling of `mes`,
 * not a key inside `extra`, because `extra` is the part of a line other
 * extensions write into and SillyTavern rewrites wholesale on some paths; a
 * top-level key SillyTavern does not know is carried through its saves as-is.
 *
 * **Only lines Iris itself wrote get one.** A line that came in from a file
 * (it has a recorded key order, which every imported line does) is left
 * exactly as it was, so an imported and untouched chat still exports byte for
 * byte; `tests/line-id.test.ts` pins both halves. A caller that deliberately
 * changes an imported line (a branch point, which gains `extra.branches`
 * anyway) may give it one with {@link mintLineId}.
 */
export const LINE_ID_KEY = 'iris_id'

/**
 * A fresh line id.
 * @returns a random id, unique for every practical purpose.
 */
export function mintLineId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * The durable id a line carries, if it has one.
 * @param line - a message line.
 * @returns the id, or undefined for a line without one.
 */
export function lineIdOf(line: SillyTavernMessage): string | undefined {
  const value = line[LINE_ID_KEY]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Ids minted during export, per log and per message event.
 *
 * Remembered so the same log exports the same id every time it is saved: the
 * id reaches the file on the first save, and from the next load on it is an
 * ordinary carried field in `iris/st-meta`. Keyed weakly on the session so a
 * log that is replaced (a rebuild reimports from the exported lines, which by
 * then carry the id) takes its memo with it.
 */
const MINTED = new WeakMap<Session, Map<number, string>>()

/**
 * The id an exported line gets, when it has none of its own.
 * @param session - the chat log.
 * @param seq - the message event the line is built from.
 * @param fields - the carried-through fields, which win when they hold an id.
 * @returns the fields to spread onto the line: `{}` for an imported line or one
 *   that already carries an id, `{ iris_id }` for a line this log wrote.
 */
function lineIdFields(session: Session, seq: number, fields: Record<string, unknown>): Record<string, string> {
  if (typeof fields[LINE_ID_KEY] === 'string') return {}
  let memo = MINTED.get(session)
  const known = memo?.get(seq)
  if (known !== undefined) return { [LINE_ID_KEY]: known }
  // A line with a recorded key order came from a file. It stays as it was.
  if (keyOrderFor(session, seq) !== undefined) return {}
  if (memo === undefined) {
    memo = new Map()
    MINTED.set(session, memo)
  }
  const minted = mintLineId()
  memo.set(seq, minted)
  return { [LINE_ID_KEY]: minted }
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
      const fields = rowFields(session, event.seq)
      lines.push(remember(session, event.seq, {
        name: header.user_name,
        is_user: true,
        mes: textOf(event.data),
        ...fields,
        ...lineIdFields(session, event.seq, fields),
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
    const fields = first === undefined ? {} : rowFields(session, first.seq)

    const line: SillyTavernMessage = first === undefined
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
          ...fields,
          ...lineIdFields(session, first.seq, fields),
        })
    writeReasoning(line, current === undefined ? '' : reasoningOf(current.message))
    lines.push(line)
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
