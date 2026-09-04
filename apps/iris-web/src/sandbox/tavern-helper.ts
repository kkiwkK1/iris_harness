/**
 * The Tavern Helper API as a card sees it, implemented over a snapshot.
 *
 * The host's `createTavernHelper` cannot run here. Its `TavernHelperHost` wants
 * a live `Session` and `VariableStore`, and neither crosses an opaque origin —
 * so this is a second implementation of the same surface, not a re-export of
 * the first. What the two share is the *vocabulary*: the event tables and the
 * bus come from `@iris/compat-tavernhelper-core`, because a card compares
 * against `tavern_events.MESSAGE_RECEIVED` by value and a table that drifted by
 * one character would make its listener silently never fire.
 *
 * The split between what is answered here and what travels is not a preference.
 * Measured against MVU's own source, the read family is called synchronously —
 * `deleteVariable(getLastMessageId(), ...)` passes the result straight in as an
 * argument, so it has to be a number and not a promise — while every write is
 * `await`ed. Reads therefore have to come from the pushed snapshot, and writes
 * are free to be what they already are: asynchronous calls to the host.
 *
 * @module iris-web/sandbox/tavern-helper
 */
import {
  EventBus,
  IFRAME_EVENTS,
  MVU_EVENTS,
  TAVERN_EVENTS,
  parseRegexFromString,
  type Listener,
} from '@iris/compat-tavernhelper-core'
import type {
  LorebookSettings,
  ScriptChatMessage,
  ScriptContext,
  WorldbookEntry,
} from '@iris/protocol'

import { buttonEventName } from './button-event.ts'
import { UnsupportedApiError } from './errors.ts'

/**
 * The events a **started** generation is announced under.
 *
 * Upstream's pair, for the same reason the settled ones are upstream's: cards
 * subscribe to these by name, and a card that hears a start and never a matching
 * end (or the reverse) is left in a state no card author wrote.
 *
 * They also drive the frame's own `generating` flag, which is what
 * `#send_but.disabled`, `#mes_stop`'s visibility and `parent.is_send_press` all
 * answer from — three spellings of one fact, so it has to have exactly one
 * source.
 */
/**
 * The event names a settled generation is announced under.
 *
 * **Upstream's own, and briefly they were not.** Upstream revokes a `once`
 * injection on Tavern Helper's `js_generation_ended`, SillyTavern's
 * `generation_ended`, and `generation_stopped` so an abort revokes too — and for
 * one round this frame subscribed to all three while **nothing in this app
 * emitted any of them**. A `once` injection would never have been revoked: no
 * error, no report, the text quietly appearing in every later prompt.
 *
 * The fix at the time was a single Iris-only name, because `stream.end` carried
 * `{ chatId, turn, view }` and no reason — so "completed" and "aborted" were
 * indistinguishable, and emitting upstream's names off one undifferentiated
 * event would have been wrong in both directions: `generation_ended` alone and a
 * card watching for aborts never hears one; both, and every completion looks
 * aborted.
 *
 * `stream.end` now carries `reason`, so the discriminator exists and the
 * Iris-only name is gone with it. **Not synthesising was right only while the
 * answer was unknown; keeping it afterwards would have been knowing the answer
 * and not saying it** — and these names serve every card that subscribes to
 * them, not only `injectPrompts`.
 * @param reason - how the generation ended.
 * @returns the bus events to emit, in order.
 */
export const STARTED_EVENTS: readonly string[] = ['js_generation_started', 'generation_started']

/**
 * The one MVU event the shell speaks into **message** frames.
 *
 * An interface is a status panel that redraws when the variables it draws
 * change, and every measured status bar subscribes to this name
 * (`eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, …)`). Upstream the name arrives
 * because the MVU bundle emits it on the page's shared event source and every
 * iframe's subscription is bridged to that source. Here the bundle runs in the
 * script frame and each message frame has its own bus, so the shell emits the
 * name itself on the same host events that refresh the frames' snapshots.
 *
 * Only into message frames. A script frame runs the bundle, which emits the
 * event itself — a shell copy there would deliver every update twice, which is
 * the same ground DEVIATIONS §3 already covers for the host side.
 */
export const MVU_UPDATE_ENDED_EVENT: string = MVU_EVENTS.VARIABLE_UPDATE_ENDED

/**
 * Every name a settled generation can arrive under.
 *
 * The union of both `settledEvents` branches, kept beside it so the two cannot
 * drift: a name emitted by one and not watched by the other would leave the
 * frame's `generating` flag stuck on after an abort — and stuck-on is the
 * direction that freezes a card's panel indefinitely.
 */
export const SETTLED_EVENT_NAMES: readonly string[] = [
  ...settledEvents('completed'),
  ...settledEvents('aborted'),
]

/**
 * The events a settled generation is announced under.
 * @param reason - how the generation ended.
 * @returns the bus events to emit, in order.
 */
export function settledEvents(reason: 'completed' | 'aborted'): readonly string[] {
  /*
   * An abort emits `generation_stopped` **only**. Upstream's abort path does not
   * also fire `GENERATION_ENDED`, and a card that revoked on the first and
   * re-armed on the second would be left in the wrong state if both arrived.
   */
  return reason === 'aborted'
    ? ['generation_stopped']
    : ['js_generation_ended', 'generation_ended']
}
/** A scope selector, in the shape upstream's cards pass it. */
export interface VariableOption {
  type?: string
  message_id?: number | string | null
  script_id?: string
}

/** What the frame's Tavern Helper needs from the frame around it. */
export interface TavernHelperFrameHost {
  /**
   * The snapshot, read per call rather than captured.
   *
   * A later `context` message replaces it, and a member that closed over the
   * first one would keep answering from a chat the user has already left.
   */
  context: () => ScriptContext | undefined
  /** Which entry of `script.list` is running. */
  scriptId: () => string | undefined
  /** Ask the host to do something the frame cannot. */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Run a slash command through the host's parser. */
  triggerSlash: (command: string) => Promise<string>
  /**
   * Adopt the variable table the host returned after a write.
   *
   * Only ever called with a table the host has already stored, which is what
   * separates this from the optimistic local write it replaced: that one would
   * have answered the next read with a value nobody had agreed to.
   */
  adoptVariables: (variables: Record<string, unknown>) => void
  /** The bus shared with the shell's forwarding. */
  events: EventBus
  /**
   * Report a capability this frame does not have, once it has actually been
   * reached for.
   *
   * Not an error: the card carries on, and upstream would too. It exists because
   * the alternative is a gap that looks like an ordinary answer.
   *
   * This paragraph was true and the wiring did not obey it — every message went
   * out on the `error` channel, so the panel filed each one under "failed"
   * beside the scripts that genuinely had not started. Use `reportFault` when
   * that is what happened, and this one when the card carried on.
   */
  reportGap: (message: string) => void
  /**
   * Report something the card asked for that did not happen.
   *
   * The line between the two is not severity: it is whether the call was
   * served. `replaceScriptButtons` handed a malformed row rejects the **whole**
   * table and stores nothing, so it belongs here even though nothing threw —
   * while a read that answers `undefined` for an unbuilt member belongs above
   * even though a card may die of it three steps later.
   */
  reportFault: (message: string) => void
}

/**
 * Resolve upstream's message range against a chat length.
 *
 * Deliberately mirrors the host's `resolveRange`, including the clamping: a
 * card asking for message 500 of a 12-message chat gets the last one rather
 * than an error, because that is what it gets upstream.
 * @param range - an index, a `'start-end'` span, or `'all'`.
 * @param length - how many messages there are.
 * @returns the indices to return, in ascending order.
 */
export function resolveRange(range: string | number, length: number): number[] {
  const clamp = (value: number): number =>
    Math.min(Math.max(value < 0 ? length + value : value, 0), length - 1)

  if (typeof range === 'number') return length === 0 ? [] : [clamp(range)]
  if (range === 'all') return Array.from({ length }, (_unused, index) => index)

  // Scanned rather than matched with a pattern. The separator and the sign are
  // the same character, so the only interesting position is the first dash that
  // is not a leading sign — which an index finds directly.
  //
  // `isIndex` is what keeps this identical to the host's `-?\d+`. Testing with
  // `Number.isFinite` instead would quietly widen the grammar: `1.5-2` and
  // `1e2-3` both parse as finite numbers, and the host rejects both.
  const isIndex = (part: string): boolean => {
    const digits = part.startsWith('-') ? part.slice(1) : part
    return digits.length > 0 && [...digits].every(character => character >= '0' && character <= '9')
  }

  const text = range.trim()
  const dash = text.indexOf('-', text.startsWith('-') ? 1 : 0)
  if (dash > 0) {
    const lowText = text.slice(0, dash).trim()
    const highText = text.slice(dash + 1).trim()
    if (isIndex(lowText) && isIndex(highText)) {
      const low = Number(lowText)
      const high = Number(highText)
      if (length === 0) return []
      const from = clamp(low)
      const to = clamp(high)
      const [first, last] = from <= to ? [from, to] : [to, from]
      return Array.from({ length: last - first + 1 }, (_unused, index) => first + index)
    }
  }

  const single = Number(text)
  if (!Number.isFinite(single)) throw new Error(`getChatMessages: unrecognized range "${range}"`)
  return length === 0 ? [] : [clamp(single)]
}

/**
 * SillyTavern's own `eventSource`, over the same bus.
 *
 * Upstream, Tavern Helper's `eventOn` family is a wrapper around SillyTavern's
 * `eventSource` — one emitter reached by two names. Reproducing that means the
 * two routes must share listeners here too: a card that subscribes with
 * `parent.eventSource.on(...)` and one that subscribes with `eventOn(...)` are
 * subscribing to the same thing, and a card doing one and emitting through the
 * other has to work.
 * @param events - the frame's bus.
 * @returns an object with the emitter shape SillyTavern exposes.
 */
export function createEventSource(events: EventBus): Record<string, unknown> {
  return {
    on: (event: string, listener: Listener) => events.eventOn(event, listener),
    once: (event: string, listener: Listener) => events.eventOnce(event, listener),
    emit: async (event: string, ...args: unknown[]) => events.eventEmit(event, ...args),
    removeListener: (event: string, listener: Listener) =>
      events.eventRemoveListener(event, listener),
  }
}

/**
 * Said in every refusal that stays a throw, because the card author reads it.
 *
 * [ruling ②] These refusals are Iris's limits rather than the card's mistakes,
 * and the reason they throw instead of returning something harmless is that
 * **nothing harmless is available**: the only value they could produce is
 * another floor's data, and MVU's flow is read → merge → store. An approximate
 * answer would not be a wrong read, it would be a wrong **write** over the
 * reader's saved state.
 *
 * A card author seeing an exception from their own call will look for their own
 * bug first. This sentence is what stops that search.
 */
const LIMIT_NOT_YOUR_FAULT = ' This is a limit in Iris, not a mistake in the card:'
  + ' returning an approximate answer here would be written back over your saved state.'

/**
 * Build the flattened Tavern Helper surface for one frame.
 * @param host - what the frame can offer.
 * @returns every name a card expects, ready to publish.
 */
/**
 * The Tavern Helper release this surface was transcribed from.
 *
 * Not a version Iris invents and not one it aspires to: the card API in
 * `identity.ts`, the 171 declared members in `upstream-surface.ts` and the seeded
 * globals in `preset-globals.ts` were all read off one installed copy of
 * JS-Slash-Runner, and this is that copy's `manifest.json` version.
 *
 * Pinned by a test against that manifest wherever the corpus is present, so
 * transcribing from a newer release cannot leave this claiming the old number.
 * A version string that drifts from its source is worse than none, because a
 * card's compatibility check would be answered with a fact about nothing.
 */
export const TAVERN_HELPER_VERSION = '4.9.1'

/**
 * A worldbook entry as a **card** sees it.
 *
 * Identical to the wire shape but for `strategy.keys`, whose elements upstream
 * hands over as `RegExp | string`. A `RegExp` cannot cross a `postMessage`
 * boundary — it arrives as `{}` — so the host sends the strings it read and the
 * revival happens here, on the last hop before a card touches them.
 */
export interface CardWorldbookEntry extends Omit<WorldbookEntry, 'strategy'> {
  strategy: Omit<WorldbookEntry['strategy'], 'keys' | 'keys_secondary'> & {
    keys: (RegExp | string)[]
    keys_secondary: Omit<WorldbookEntry['strategy']['keys_secondary'], 'keys'> & {
      keys: (RegExp | string)[]
    }
  }
}

/**
 * Revive regex-shaped keys the way upstream does before a card sees them.
 *
 * `parseRegexFromString` returns `null` for a key that is not regex-shaped, and
 * **that is not a failure** — upstream's semantics are to fall back to plaintext
 * matching, so `null` means "this key is literal text" and the original string is
 * kept. Treating it as an error would drop every ordinary keyword in the book.
 *
 * The function is imported rather than reimplemented, and it is the **same
 * function object** the activation engine uses. A hand-copied rule that drifted
 * would give a card a `RegExp` for a key the engine matches as plaintext, or the
 * reverse: two halves each self-consistent, wrong together, and silent.
 *
 * **Both key lists, treated identically**, because both halves were measured:
 * upstream applies the same expression to each (`worldbook.ts:214` for `key`,
 * `:218` for `keysecondary`), and this project's activation engine sends both
 * through `matchKey` (`activate.ts:967`, `matching.ts:121`), whose first act is
 * `parseRegexFromString`.
 *
 * That agreement is the requirement, not a coincidence worth copying. Reviving
 * only the primary keys would hand a card plain strings for the secondary ones
 * while the engine matched those same strings as patterns — each half internally
 * consistent, wrong together, and silent. This member was written that narrower
 * way first, from a contract that documented revival for `keys` and said nothing
 * about `keys_secondary`; **silence about a sibling field reads as a statement
 * about it**, which is how the narrow reading looked correct.
 * @param entry - one entry as the host sent it.
 * @returns the same entry with both key lists revived.
 */
function reviveWorldbookKeys(entry: WorldbookEntry): CardWorldbookEntry {
  /** `null` means "not regex-shaped", so the author's own text is kept. */
  const revive = (keys: readonly string[]): (RegExp | string)[] =>
    keys.map(key => parseRegexFromString(key) ?? key)

  return {
    ...entry,
    strategy: {
      ...entry.strategy,
      keys: revive(entry.strategy.keys),
      keys_secondary: {
        ...entry.strategy.keys_secondary,
        keys: revive(entry.strategy.keys_secondary.keys),
      },
    },
  }
}

/**
 * Turn a key back into the text the host stores.
 *
 * The exact inverse of revival, and it exists because the round trip is the
 * ordinary way cards use these members: `updateWorldbookWith` hands the updater
 * **revived** entries, so a card that returns them with one field changed —
 * which is what the corpus does — is handing back live `RegExp` objects in the
 * key lists.
 *
 * Without this they would not merely degrade, they would not arrive: `RegExp` is
 * not structured-cloneable into a plain shape and the contract types these as
 * strings, so the write would be rejected at validation. Loud, but for a card
 * that did nothing wrong.
 *
 * `String(/a/i)` yields `/a/i`, which is what `parseRegexFromString` reads, so a
 * key that made the trip out and back is byte-identical — including the escaped
 * slash case, where `source` re-escapes exactly the character the parser
 * unescaped.
 * @param keys - a key list from a card, which may hold patterns or text.
 * @returns the same list with any pattern written back as `/pattern/flags`.
 */
function flattenKeys(keys: unknown): unknown {
  if (!Array.isArray(keys)) return keys
  return keys.map(key => (key instanceof RegExp ? String(key) : key))
}

/**
 * Prepare one card-supplied entry for the wire.
 *
 * Written defensively against `unknown` rather than against `WorldbookEntry`,
 * because what arrives here is whatever a card's updater returned: upstream types
 * it `PartialDeep`, every field but `uid` may be missing, and nothing has
 * validated it yet. Copied rather than mutated so a card that keeps a reference
 * to what it returned does not watch its own objects change underneath it.
 * @param entry - one entry as a card produced it.
 * @returns the same entry with its key lists flattened.
 */
function flattenWorldbookEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return entry
  const copy = { ...(entry as Record<string, unknown>) }

  const strategy = copy['strategy']
  if (strategy === null || typeof strategy !== 'object') return copy
  const strategyCopy = { ...(strategy as Record<string, unknown>) }

  if ('keys' in strategyCopy) strategyCopy['keys'] = flattenKeys(strategyCopy['keys'])

  const secondary = strategyCopy['keys_secondary']
  if (secondary !== null && typeof secondary === 'object') {
    const secondaryCopy = { ...(secondary as Record<string, unknown>) }
    if ('keys' in secondaryCopy) secondaryCopy['keys'] = flattenKeys(secondaryCopy['keys'])
    strategyCopy['keys_secondary'] = secondaryCopy
  }

  copy['strategy'] = strategyCopy
  return copy
}

/**
 * One message in **Tavern Helper's** shape, which a card receives.
 *
 * Distinct from `ScriptChatMessage`, which is SillyTavern's storage shape and is
 * what `context.chat` correctly still carries. Two surfaces, two vocabularies;
 * conflating them is `DEVIATIONS.md` §6.
 */
export interface CardChatMessage {
  message_id: number
  name: string
  /**
   * Four values, not three.
   *
   * Upstream declares this as a three-value union and then assigns to it through
   * an `as` assertion (`chat_message.ts:137`, `:148`), which checks nothing — so
   * the declaration is wrong about its own function's output. A narrator message
   * on a user row produces `'unknown'` at runtime.
   *
   * Typed here from the **runtime behaviour**, not the declaration. A contract
   * that repeats a lie is worse than no contract: it makes the fourth value
   * unrepresentable in every consumer downstream, and the value still arrives.
   */
  role: 'user' | 'assistant' | 'system' | 'unknown'
  is_hidden: boolean
  message: string
  extra: Record<string, unknown>
  /**
   * This floor's variables — where MVU keeps `stat_data`.
   *
   * **Absent entirely when swipes were requested.** That is upstream's own
   * asymmetry, copied rather than smoothed: a caller asking for every swipe gets
   * `swipes_data` and no `data`, so a card written against upstream that reads
   * `data` after asking for swipes finds nothing here too.
   */
  data?: Record<string, unknown>
  swipe_id?: number
  swipes?: string[]
  swipes_data?: Record<string, unknown>[]
}

/**
 * Parsed floor tables, keyed by the row they came from.
 *
 * A `WeakMap` on the row object, which is what makes the cache's lifetime right
 * without anyone managing it: a new snapshot brings new row objects, so the old
 * parses become unreachable the moment the snapshot they belong to does. A cache
 * keyed by floor number would have needed explicit invalidation, and in the
 * window before someone wrote that, it would have answered from the previous
 * turn's data.
 */
const parsedFloors = new WeakMap<ScriptChatMessage, readonly unknown[]>()

/**
 * The tables one floor's JSON text encodes.
 *
 * Takes the **text**, not the row, and that signature is load-bearing: the lazy
 * getter installed by `restoreFloorTables` replaces the `variables` property, so
 * anything that parses by re-reading that property calls the getter that called
 * it. The first version did exactly that and every direct read of a floor blew
 * the stack — one of the two shapes where a cache and a lazy accessor over the
 * same name go wrong (the other is answering from a stale parse).
 * @param text - the row's `variables`, as JSON.
 * @param report - where to say it could not be read.
 * @returns the tables, indexed by swipe; empty when the text cannot be trusted.
 */
function parseTables(
  text: string,
  report?: (message: string, failed: boolean) => void,
): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(text)
    // The contract says an array indexed by swipe. A different shape is the
    // host's fault, not the card's, and it is worth saying which.
    if (Array.isArray(parsed)) return parsed
    report?.(
      'a floor\u2019s variable tables are not the array the contract describes'
      + ` (${typeof parsed}) \u2014 it was read as empty rather than guessed at`,
      false,
    )
    return []
  } catch (error: unknown) {
    /*
     * Reported and read as empty. A truncated or corrupt table is a transport
     * fault, and letting the parse throw out of a synchronous read no card
     * guards would turn one bad floor into a dead card.
     */
    report?.(
      'a floor\u2019s variable tables could not be parsed: '
      + (error instanceof Error ? error.message : String(error))
      + ' \u2014 it was read as empty',
      true,
    )
    return []
  }
}

/**
 * One floor's per-swipe variable tables, parsed once.
 *
 * **`variables` arrives as JSON text**, not as a tree, and that is a transport
 * decision with a measurement behind it: structured clone charges per object
 * rather than per byte. Measured in a real frame, 4 MiB of nested tables clone
 * in 24.21 ms and the same content as one string in 1.77 ms — 16.5× — while
 * parsing the **one floor** a card asked for costs 0.01 ms. So the snapshot
 * arrives cheap and a reader pays only for what it reads.
 *
 * Here at module scope rather than inside the surface's closure because there
 * are **two** readers — `swipes_data` on every message this file hands back, and
 * `getVariables({message_id})` — and two parses of the same text would double
 * the one cost this design exists to control, while two caches would disagree
 * about which floor had been read.
 * @param message - the floor, as the snapshot holds it.
 * @param report - where to say that a floor's text could not be read; omitted by
 *   callers with no channel, since a missing report is better than a throw out
 *   of a synchronous read a card does not guard.
 * @returns the tables, indexed by swipe. Empty when there are none to read.
 */
function floorTables(
  message: ScriptChatMessage,
  report?: (message: string, failed: boolean) => void,
): readonly unknown[] {
  const cached = parsedFloors.get(message)
  if (cached !== undefined) return cached

  const raw = message['variables']
  /*
   * Already an array: either the host sent one (older snapshots did) or the
   * lazy getter below has resolved this row. Both are the same fact — the
   * tables are in hand — and accepting both is what lets the getter be lazy
   * without every reader knowing about it.
   */
  if (Array.isArray(raw)) return raw

  const text = raw
  if (typeof text !== 'string' || text === '') {
    parsedFloors.set(message, [])
    return []
  }

  const tables = parseTables(text, report)
  parsedFloors.set(message, tables)
  return tables
}

/**
 * Make every floor's `variables` read as the tables, without parsing them all.
 *
 * **The case this exists for is a card reading the field directly.** MVU's
 * restore guard is `_.has(chat[i].variables[swipe_id], 'stat_data')`, and on the
 * JSON *text* `variables[swipe_id]` yields a single **character** — so `_.has`
 * of a one-character string is false, forever, silently. The card then decides
 * there is nothing to restore. No error, no report, and a save that looks empty.
 *
 * So the encoding cannot leak past this boundary. Restoring it eagerly would
 * throw away what the encoding bought — parsing all 677 rows of the longest
 * corpus chat costs the 7.75 ms the text transport exists to avoid — so each row
 * gets a **getter** that parses that row on first read and remembers. A card
 * touching one floor pays for one floor; a card iterating the chat and reading
 * only `mes` pays for none.
 *
 * `configurable` so the definition can be replaced when a later snapshot brings
 * the same row object, and enumerable/writable like the plain property it
 * replaces, so `{...row}` and `JSON.stringify(row)` behave as they did.
 * @param chat - the snapshot's chat array, mutated in place.
 * @param report - where to say a floor could not be read.
 */
export function restoreFloorTables(
  chat: readonly ScriptChatMessage[],
  report?: (message: string, failed: boolean) => void,
): void {
  for (const row of chat) {
    if (typeof row['variables'] !== 'string') continue
    /*
     * In place, so object identity survives. Upstream hands cards the live chat
     * objects, and a card that writes `chat[i].something = x` expects the write
     * to be seen by the next reader — copying the rows here would silently break
     * that for every field, not just this one.
     */
    const text = row['variables']
    Object.defineProperty(row, 'variables', {
      get: () => {
        /*
         * Replaces itself with the value on first read, which is the cache and
         * also the end of the laziness for this row: every later read is a plain
         * property, so nothing pays for the getter twice and no other reader has
         * to know one was ever there.
         */
        const tables = parseTables(text, report)
        Object.defineProperty(row, 'variables', {
          value: tables,
          writable: true,
          configurable: true,
          enumerable: true,
        })
        return tables
      },
      configurable: true,
      enumerable: true,
    })
  }
}

/**
 * Normalise a floor's per-swipe variables to one table per swipe.
 *
 * The data is already in the snapshot — the same position upstream keeps it — so
 * this is derivation with no new transport, per `FLOOR-VARIABLES.md`. Holes are
 * filled with `{}` rather than left sparse: a swipe nobody has written variables
 * for has an empty table, and `undefined` would make "no variables yet"
 * indistinguishable from "out of range".
 *
 * Length follows the **swipes**, not the variables. A floor can have more swipes
 * than recorded tables (the usual case — only swipes that ran a variable update
 * have one), and indexing `swipes_data` by `swipe_id` has to be safe for every
 * swipe that exists.
 * @param message - the floor, as the snapshot holds it.
 * @param swipes - that floor's swipe texts.
 * @returns one table per swipe.
 */
function swipeVariables(
  message: ScriptChatMessage,
  swipes: readonly string[],
): Record<string, unknown>[] {
  /*
   * No report channel here on purpose. This runs for **every** message this file
   * hands a card, so a corrupt floor would report once per read of the chat
   * rather than once per floor — and the same text is parsed through
   * `floorTables`, which does report when a card asks for that floor by number.
   * One cache means the corrupt floor is diagnosed exactly once, by the reader
   * that was actually asking about it.
   */
  const recorded = floorTables(message)
  return swipes.map((_unused, at) => {
    const table = recorded[at]
    return typeof table === 'object' && table !== null ? (table as Record<string, unknown>) : {}
  })
}

/**
 * Convert one stored message into the shape Tavern Helper hands a card.
 *
 * Every field here is now upstream's own line rather than a reading of it.
 * `is_hidden` is `is_system`, `message` is `mes ?? ''`, and `role` is
 * (`chat_message.ts:91-103`):
 *
 * ```
 * extra.type === 'narrator' ? (is_user ? 'unknown' : 'system')
 *                           : (is_user ? 'user'    : 'assistant')
 * ```
 *
 * The narrator marker's literal is `'narrator'` (`system-messages.js:23`).
 *
 * This began as an assumption — the compat package's two-value derivation, the
 * best in-repo source available — and was labelled as one rather than presented
 * as a copy. The assumption was directionally right and missed a whole branch,
 * which is the usual outcome and the reason the label mattered.
 * @param message - the stored message.
 * @param index - its floor number, which is upstream's `message_id`.
 * @param withSwipes - whether the caller asked for every swipe.
 * @returns the card-facing message.
 */
function toCardChatMessage(
  message: ScriptChatMessage,
  index: number,
  withSwipes: boolean,
): CardChatMessage {
  const narrator = (message.extra as { type?: unknown } | undefined)?.type === 'narrator'
  const swipes = message.swipes ?? [message.mes]
  const swipesData = swipeVariables(message, swipes)
  const swipeId = message.swipe_id ?? 0

  const base: CardChatMessage = {
    message_id: index,
    name: message.name,
    role: narrator
      ? (message.is_user ? 'unknown' : 'system')
      : (message.is_user ? 'user' : 'assistant'),
    is_hidden: message.is_system === true,
    message: message.mes ?? '',
    extra: message.extra ?? {},
  }

  if (!withSwipes) return { ...base, data: swipesData[swipeId] ?? {} }

  // No `data` here, deliberately — see the field's note.
  return { ...base, swipe_id: swipeId, swipes: [...swipes], swipes_data: swipesData }
}

export function createFrameTavernHelper(host: TavernHelperFrameHost): Record<string, unknown> {
  /** The snapshot, or a refusal naming the member that needed it. */
  const snapshot = (member: string): ScriptContext => {
    const context = host.context()
    if (context === undefined) {
      throw new UnsupportedApiError(
        member,
        'The host snapshot has not arrived yet.' + LIMIT_NOT_YOUR_FAULT,
      )
    }
    return context
  }

  /** One script's stored table, copied, for a writer to compute against. */
  const buttonsOf = (member: string, id: string): { name: string, visible: boolean }[] =>
    (snapshot(member).scriptButtons?.[id] ?? []).map(button => ({
      name: button.name,
      visible: button.visible,
    }))

  /**
   * Which script and which buttons a writer was called about.
   *
   * **Both call shapes are accepted, and that is a correction.** An earlier
   * version required `(script_id, buttons)` and refused a lone array *by name*,
   * citing upstream's 3.2.5 changelog example
   * (`replaceScriptButtons(getScriptId(), [...])`). Then a real card threw an
   * uncaught refusal, and the caller turned out not to be the card at all:
   *
   * ```js
   * // MagVarUpdate@beta/artifact/bundle.js, fetched from jsdelivr
   * appendInexistentScriptButtons(ja.map(e => ({ name: e.name, visible: !1 })))
   * const n = getScriptButtons(); if (n) return void replaceScriptButtons(...)
   * ```
   *
   * **MVU calls both writers with one argument**, and 13 corpus cards bundle
   * MVU — so the refusal broke every one of them, during setup, with a throw
   * that killed the rest of MVU's initialisation. The changelog example and
   * MVU's usage are only both true if upstream accepts either shape, so this
   * does too.
   *
   * The lesson is not "read the changelog harder": the evidence that settled it
   * was **the bytes that actually run**, and they were not in the card. A member
   * whose only measured caller is a fetched bundle cannot be verified from the
   * card corpus at all.
   * @param member - named in any report.
   * @param first - either the script id or the buttons.
   * @param second - the buttons, when the id came first.
   * @returns the pair, or undefined when it could not be worked out.
   */
  const buttonCall = (
    member: string,
    first: unknown,
    second: unknown,
  ): { scriptId: string, buttons: { name: string, visible: boolean }[] } | undefined => {
    const oneArgument = Array.isArray(first)
    const rawButtons = oneArgument ? first : second
    const id = oneArgument ? host.scriptId() : first

    if (typeof id !== 'string' || id === '') {
      /*
       * Reported, not thrown. Upstream's writers return `void` and no card
       * awaits them — MVU calls this while wiring up — so a throw here does not
       * surface as "this call was wrong", it surfaces as everything after it
       * never running. That is exactly what happened.
       */
      host.reportFault(
        `card called ${member} with no usable script id`
          + (oneArgument ? ' — this body has no entry in the host script list' : '')
          + ', so the buttons were not stored',
      )
      return undefined
    }

    const buttons = readButtons(member, rawButtons)
    return buttons === undefined ? undefined : { scriptId: id, buttons }
  }

  /**
   * The table a card handed over, checked before it is stored.
   *
   * Both fields are required, matching upstream's type, which has no default for
   * `visible`. Defaulting it would be the more forgiving choice and the wrong
   * one: `visible: false` is the **common** case in the corpus (58 of 89
   * buttons), so a missing field is at least as likely to have meant hidden as
   * shown, and inventing either answer writes a table the card did not ask for.
   *
   * **Reports and returns undefined; it does not throw.** These writers return
   * `void` upstream and nothing awaits them — MVU calls one while wiring up — so
   * a throw does not read as "that call was malformed", it reads as everything
   * after the call never happening. A real card produced exactly that: an
   * uncaught `UnsupportedApiError` during setup, with the rest of MVU's
   * initialisation silently abandoned behind it.
   * @param member - named in the report.
   * @param buttons - the candidate table.
   * @returns the validated table, or undefined when it was refused.
   */
  const readButtons = (
    member: string,
    buttons: unknown,
  ): { name: string, visible: boolean }[] | undefined => {
    if (!Array.isArray(buttons)) {
      host.reportFault(`card called ${member} without an array of buttons, so nothing was stored`)
      return undefined
    }
    const table: { name: string, visible: boolean }[] = []
    for (const [at, button] of buttons.entries()) {
      const row = button as { name?: unknown, visible?: unknown } | null
      if (row === null || typeof row !== 'object') {
        host.reportFault(`card called ${member} with buttons[${String(at)}] not an object`)
        return undefined
      }
      if (typeof row.name !== 'string' || row.name === '') {
        host.reportFault(`card called ${member} with buttons[${String(at)}] having no name`)
        return undefined
      }
      if (typeof row.visible !== 'boolean') {
        host.reportFault(
          `card called ${member} with buttons[${String(at)}] ("${row.name}") missing a boolean`
            + ' visible — upstream requires it, and guessing would store a table the card did'
            + ' not ask for',
        )
        return undefined
      }
      table.push({ name: row.name, visible: row.visible })
    }
    return table
  }

  /**
   * Store one script's table, unless it is already what is stored.
   *
   * The equality guard is upstream's (`function/script.ts:80`, `!_.isEqual`) and
   * it earns its place here for a reason upstream does not have: every write
   * crosses the boundary and comes back as a new snapshot, which re-plans the
   * frame budget and refreshes every running card. A card that republishes an
   * identical table on every variable change — the pattern the one corpus caller
   * uses — would otherwise pay all of that to change nothing.
   *
   * The failure path reports rather than throws. Upstream's writer returns
   * `void` and cards call it without `await`; throwing asynchronously would
   * surface as an unhandled rejection with no card frame in the stack, which is
   * the kind of report that names nothing.
   * @param member - which member is writing, for the report.
   * @param scriptId - the script whose table this is.
   * @param buttons - the table to store.
   */
  const writeButtons = (
    member: string,
    id: string,
    next: readonly { name: string, visible: boolean }[],
  ): void => {
    const current = buttonsOf(member, id)
    const same =
      current.length === next.length
      && current.every((button, at) => {
        const other = next[at]
        return other !== undefined && button.name === other.name && button.visible === other.visible
      })
    if (same) return

    const characterId = snapshot(member).characterId
    if (characterId === undefined) {
      /*
       * No card, no table to write to. Reported rather than thrown for the same
       * reason the failure path is: this is reachable while a chat is closing,
       * and upstream's own writer returns silently in exactly this window
       * (`script.ts:76-78`, the four TODOs) — which `SCRIPT-BUTTONS.md` records
       * as the thinnest part of upstream's observability. Silent is what we are
       * copying behaviourally; named is what we add.
       */
      host.reportGap(
        `card called ${member} while no character was open — upstream returns silently here`
          + ' too, so the buttons were not stored and nothing failed',
      )
      return
    }

    void host.call('replaceScriptButtons', { characterId, scriptId: id, buttons: next }).then(
      undefined,
      (error: unknown) => {
        host.reportFault(
          // "the write was refused", not "the host refused": this rejection can
          // come from Iris's own routing gate, which the host never sees.
          `card called ${member} and the write was refused: `
            + (error instanceof Error ? error.message : String(error)),
        )
      },
    )
  }

  const chatOf = (member: string): ScriptChatMessage[] => snapshot(member).chat

  /**
   * One named book's entries, revived.
   *
   * Shared by `getWorldbook` and `updateWorldbookWith` so that "how a book is
   * fetched and what state its keys are in" is decided once. The alternative was
   * for the update path to fetch its own copy, which is how the two would come
   * to disagree about revival — and the updater's input disagreeing with
   * `getWorldbook`'s output is precisely the kind of difference a card author
   * cannot see.
   * @param name - the book's name, exactly as spelled.
   * @returns its entries, with both key lists revived.
   */
  const readWorldbook = async (name: string): Promise<CardWorldbookEntry[]> => {
    const answer = await host.call('getWorldbook', { name })
    const entries = (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
    return entries.map(entry => reviveWorldbookKeys(entry))
  }

  /**
   * One layer of the snapshot, by the name a card uses for it.
   *
   * The layers arrive **unmerged and labelled**, which is the shape that makes
   * both directions possible: the façade can assign them together for
   * `getAllVariables`, while a pre-merged tree could never be taken apart again
   * for a card that asks for one scope alone.
   * @param member - the calling member, for refusals.
   * @param scope - which layer.
   * @returns that layer.
   */
  const layerOf = (member: string, scope: string): Record<string, unknown> => {
    const layers = snapshot(member).variableLayers
    if (scope === 'global') return layers.global
    if (scope === 'character') return layers.character
    if (scope === 'chat') return layers.chat
    if (scope === 'script') {
      /*
       * This script's partition, chosen here rather than sent pre-selected.
       *
       * The context is fetched per card while this scope is per script, so the
       * host sends every partition and **the façade picking is the enforcement
       * point** for "one script must not read another's". A frame that has no
       * identity of its own cannot pick, so it is refused rather than handed
       * someone else's.
       */
      const id = host.scriptId()
      if (id === undefined) {
        throw new UnsupportedApiError(
          `${member}({type:'script'})`,
          'A script scope needs a script_id, and this body has no identity of its own.'
            + LIMIT_NOT_YOUR_FAULT,
        )
      }
      return layers.script[id] ?? {}
    }
    throw new UnsupportedApiError(`${member}({type:'${scope}'})`, 'No such variable scope.')
  }

  /**
   * Answer a scoped read from the pushed snapshot.
   *
   * Every wire scope is answerable now. It used to refuse everything but
   * `message` — "the frame snapshot carries the message scope only" — which was
   * true of the snapshot and is no longer.
   *
   * Refusal, never an empty object, remains the rule for what cannot be
   * answered: empty reads as "nothing set yet", and MagVarUpdate responds to
   * that by re-initialising, which would overwrite live state with defaults.
   * @param member - the calling member, for refusals.
   * @param option - whatever the card passed.
   * @returns the variables for that scope.
   */
  const readVariables = (
    member: string,
    option?: VariableOption,
  ): Record<string, unknown> | undefined => {
    const type = option?.type ?? 'message'

    if (type !== 'message') return layerOf(member, type)

    /*
     * A floor-addressed read is answered **from the floor's own table**.
     *
     * This used to be refused by name, on a premise that was true when it was
     * written: "this frame answers from one snapshot that does not record which
     * floor it holds". `ScriptContext.variables` is indeed one flat record with
     * no floor label — but it is not the only thing the snapshot carries.
     * `ScriptContext.chat` is built by `toFile()`, which attaches
     * `chat[i].variables[swipe_id]` to **every** row: 677 of 677 on the corpus's
     * longest chat [49, `FLOOR-ADDRESSED-VARIABLES.md` §一]. The data was in
     * hand the whole time; only this function was looking in the wrong place.
     *
     * That distinction is the lesson worth keeping over the fix. The refusal
     * named a *transport* limit — "floor-addressed reads arrive with the
     * message-frame project" — for what was really a **lookup** limit in this
     * file. A refusal that misnames which layer it belongs to sends everyone to
     * wait for the wrong project; this one sent V1.5.4's author to wait for a
     * frame kind that would never have helped, and cost a reader here the
     * question "is it perhaps already in `chat`?".
     *
     * Still not answered from `context.variables` for an explicit id, and that
     * is the part of the old reasoning that survives: MagVarUpdate reads a floor,
     * merges into `stat_data` and writes it back, so answering the *wrong* floor
     * does not return a wrong value, it persists a merge built on one. Wrong is
     * worse than absent here, which is why an unresolvable id is `undefined`
     * rather than the latest table.
     */
    const addressed = option?.message_id
    if (addressed === undefined || addressed === 'latest') {
      /*
       * `'latest'` is a real sentinel, in use by two cards, and it has always
       * been answered from `context.variables` — the host's computed current
       * state.
       *
       * 3c's reading of upstream says this should be **the last non-system
       * message's table** instead. The two agree except while a reply is
       * in flight, and rewiring the default path — every card that reads
       * variables without an id takes it — on a reading rather than on an
       * observed disagreement is a large blast radius for a small claim.
       *
       * So this reports the disagreement instead of picking a side. When the
       * two differ, the note names both and the next panel reading settles it;
       * until then nothing that works today changes. The instrument is cheaper
       * than the decision it informs, which is the trade this project keeps
       * making on purpose.
       */
      const current = snapshot(member).variables
      const tail = lastNonSystemTable(member)
      if (tail !== undefined && JSON.stringify(tail) !== JSON.stringify(current)) {
        host.reportGap(
          `card called ${member} for the latest variables while this frame\u2019s current table`
          + ' and the last non-system message\u2019s table disagree \u2014 it answered with the'
          + ' current one, which is what Iris has always done; upstream is read as answering'
          + ' with the message\u2019s',
        )
      }
      return current
    }

    return floorVariables(member, addressed)
  }

  /** Whether a row is one upstream's floor addressing counts. */
  const isAddressable = (row: ScriptChatMessage): boolean => row.is_system !== true

  /**
   * The last non-system message's table, for comparison only.
   *
   * Not an answer: it exists so the `'latest'` branch can say when the two
   * candidate readings of "latest" disagree without having to choose between
   * them first.
   * @param member - the calling member, for reports.
   * @returns that row's table, or undefined when there is no such row or table.
   */
  const lastNonSystemTable = (member: string): Record<string, unknown> | undefined => {
    const chat = chatOf(member)
    for (let at = chat.length - 1; at >= 0; at -= 1) {
      const row = chat[at]
      if (row === undefined || !isAddressable(row)) continue
      return tableOf(member, row)
    }
    return undefined
  }

  /**
   * One row's table for the swipe it is showing.
   *
   * **`variables` arrives as JSON text**, not as a tree, and that is a transport
   * decision with a measurement behind it: structured clone charges per object
   * rather than per byte, so the tables as trees were 45% of the snapshot's
   * bytes and about 91% of its clone time. In a real frame a 4 MiB tree clones
   * in 24.21 ms and the same content as one string in 1.77 ms — 16.5× — while
   * parsing the **one floor** a card asked for costs 0.01 ms. So the whole
   * snapshot arrives cheap and the reader pays only for what it reads.
   *
   * Parsed once per row and cached, because a card that reads a floor in a loop
   * would otherwise re-parse it every time; `parsedFloors` above explains why
   * the cache needs no invalidation.
   *
   * **`{}` for a row with no table, not `undefined`**, because upstream answers
   * `{}` and compatibility is the floor. It is not a comfortable answer: an
   * empty object is truthy, so it passes a card's `if (data)` guard and then
   * reads as "nothing set yet" — which is what makes MagVarUpdate re-initialise.
   * A card that breaks on that breaks on real SillyTavern too, and diverging
   * here would hide a card's bug rather than fix it. What Iris adds is the
   * report, not a different value.
   * @param member - the calling member, for reports.
   * @param row - the message row.
   * @returns its table for the showing swipe, or `{}`.
   */
  const tableOf = (member: string, row: ScriptChatMessage): Record<string, unknown> => {
    const tables = floorTables(row, (message, failed) => {
      // The member is prepended here rather than inside `floorTables`, which has
      // two callers and no business knowing which one is asking.
      if (failed) host.reportFault(`${member}: ${message}`)
      else host.reportGap(`${member}: ${message}`)
    })

    // The row's own `swipe_id` says which swipe is showing; absent means 0, the
    // same default the rest of this file uses.
    const table = tables[typeof row.swipe_id === 'number' ? row.swipe_id : 0]
    return typeof table === 'object' && table !== null
      ? (table as Record<string, unknown>)
      : {}
  }

  /**
   * One floor's variable table, addressed the way upstream addresses floors.
   *
   * **The value domain is measured, not inferred** [3c, via the coordinator;
   * 49 is widening the protocol schema to match]. An earlier version of this
   * function accepted whole non-negative numbers and reported everything else
   * as unmeasured — the honest answer while the domain was unread, and the wrong
   * one now that it has been read:
   *
   * - **a negative integer** counts from the end, `Array.at` semantics — the
   *   same convention `resolveRange` already implements for message ranges;
   * - **a numeric string** is converted, because upstream does;
   * - **`null`** is refused by name. Upstream silently resolves it to floor 0,
   *   and floor 0 is a *wrong write target* for a caller that reads, merges and
   *   writes back — the one case where copying upstream's behaviour would help
   *   nobody and corrupt a save. A deliberate divergence, and the only one here;
   * - **`'last'`, `NaN`, anything else non-numeric, and any resolved index with
   *   no row** throw, in upstream's own words about being out of range.
   *
   * Throwing rather than answering `undefined`, and that reverses an earlier
   * choice in this file: absent is safe for a caller that only reads, and this
   * caller merges and writes. A card told nothing about a floor it asked for by
   * number will write its merge somewhere; a card that throws will not.
   * @param member - the calling member, for refusals.
   * @param id - upstream's `message_id`, already known not to be `'latest'`.
   * @returns that floor's table.
   */
  const floorVariables = (
    member: string,
    id: number | string | null,
  ): Record<string, unknown> => {
    const chat = chatOf(member)

    if (id === null) {
      throw new UnsupportedApiError(
        `${member}({message_id:null})`,
        'A null message_id names no floor. Upstream resolves it to floor 0 silently, which is a'
        + ' wrong target for a caller that reads a floor, merges into it and writes it back \u2014'
        + ' so Iris refuses instead of storing a merge against the first message.'
        + LIMIT_NOT_YOUR_FAULT,
      )
    }

    // A numeric string converts; anything else non-numeric becomes NaN and is
    // refused below with the value the card actually passed.
    const index = typeof id === 'number' ? id : Number(id)
    if (!Number.isInteger(index)) {
      throw new UnsupportedApiError(
        `${member}({message_id:${JSON.stringify(id)}})`,
        `\u8d85\u51fa\u4e86\u8303\u56f4: ${JSON.stringify(id)} does not name a floor of this`
        + ` ${String(chat.length)}-message chat. Upstream accepts a floor number, a numeric`
        + ' string, a negative index counted from the end, and \u2018latest\u2019.'
        + LIMIT_NOT_YOUR_FAULT,
      )
    }

    // `at`, so a negative counts from the end.
    const row = chat.at(index)
    if (row === undefined) {
      throw new UnsupportedApiError(
        `${member}({message_id:${String(index)}})`,
        `\u8d85\u51fa\u4e86\u8303\u56f4: floor ${String(index)} of a`
        + ` ${String(chat.length)}-message chat. Answering with a different floor\u2019s table`
        + ' would be merged and written back by the caller.' + LIMIT_NOT_YOUR_FAULT,
      )
    }

    /*
     * Returned as found. The copy that keeps a card's merge out of the snapshot
     * is made **once**, by `detachReturns`, which structured-clones every call
     * result on this surface — and it matters here more than most, because
     * MagVarUpdate's flow is read \u2192 merge into `stat_data` \u2192 write, so a
     * live reference would land the merge in the snapshot before the host had
     * agreed to it.
     *
     * A spread stood here first, and a mutation test is what removed it: making
     * this line hand back the original changed **nothing** any test could see,
     * because the detach layer had already made the copy. A second guard that
     * cannot be observed is worse than none — the next reader takes it for the
     * one that matters and looks no further, which is exactly the wrong place to
     * be looking when this property breaks.
     */
    return tableOf(member, row)
  }

  /**
   * Every scope a script frame can see, merged in upstream's order.
   *
   * Upstream's `_getAllVariables` shallow-assigns `global → character → script →
   * chat` for a script frame, later winning, and folds in per-floor tables **only
   * for a message frame** — which is why there is no floor sweep here and why
   * this is a different answer from `getVariables({type:'message'})`.
   *
   * The two used to be the *same function*, returning the message scope for both.
   * That made `getAllVariables` wrong twice over: it omitted every layer upstream
   * merges, and it included one upstream does not. No measured card calls it
   * (MagVarUpdate: zero), so nothing had reported it.
   *
   * Shallow, like upstream. A deep merge would be a different function with the
   * same name — and a card written against a shallow one would see sibling keys
   * survive where upstream drops them.
   * @param member - the calling member, for refusals.
   * @returns the merged view.
   */
  const readAllVariables = (member: string): Record<string, unknown> => {
    const layers = snapshot(member).variableLayers
    const id = host.scriptId()
    return {
      ...layers.global,
      ...layers.character,
      // A frame with no identity gets no script layer rather than a neighbour's.
      ...(id === undefined ? {} : layers.script[id] ?? {}),
      ...layers.chat,
    }
  }

  /** The scopes `script.setVariables` accepts. */
  /*
   * Only for keys of id-less injections, and deliberately not a UUID.
   *
   * Upstream uses `uuidv4()`, and its own contract comment records what that
   * costs: assembly order within a group is the **lexicographic** order of the
   * keys, so a UUID lands the injection at a random position in the prompt. A
   * counter at least makes the order the card's own call order, which is the
   * order its author was thinking in.
   */
  let nextInjection = 0

  const WIRE_SCOPES = new Set(['message', 'chat', 'global', 'script'])

  /**
   * Turn upstream's `option` into the contract's scope fields.
   *
   * Two translations the host cannot do for itself. `message_id: 'latest'` is
   * upstream syntax and the contract wants an index, so it is resolved here
   * against the snapshot. And a `script` scope with no explicit `script_id`
   * belongs to *the caller*, which is what upstream's `withScript` means and
   * which only the frame knows.
   * @param member - the member being called, for refusals.
   * @param option - whatever the card passed.
   * @returns the scope half of the request.
   */
  const scopeOf = (member: string, option?: VariableOption): Record<string, unknown> => {
    const scope = option?.type ?? 'message'
    if (!WIRE_SCOPES.has(scope)) {
      throw new UnsupportedApiError(
        `${member}({type:'${scope}'})`,
        `The host stores ${[...WIRE_SCOPES].join(', ')}.`,
      )
    }

    const fields: Record<string, unknown> = { scope }

    if (scope === 'message') {
      const raw = option?.message_id
      const resolved = raw === 'latest' || raw === undefined ? chatOf(member).length - 1 : raw
      if (typeof resolved !== 'number' || !Number.isInteger(resolved) || resolved < 0) {
        throw new UnsupportedApiError(
          `${member}({message_id:${String(raw)}})`,
          'A message id must be a whole number, or "latest".',
        )
      }
      fields['messageId'] = resolved
    }

    /*
     * A script scope with no id is refused here, not sent.
     *
     * Upstream throws in both directions rather than inventing an owner —
     * `JS-Slash-Runner/src/function/variables.ts` at the read and the write —
     * and the host now answers `invalid-request` for the same reason: an
     * `anonymous` catch-all would merge two unidentified callers into one
     * partition, and that partition is persisted. Refusing here rather than one
     * round trip later is what makes the message name the member instead of the
     * request.
     *
     * Normal script execution never reaches this: upstream fills the id from the
     * iframe's name, and Iris carries it on the `run` message. What reaches it is
     * a card calling `{type:'script'}` explicitly while the frame has no identity
     * — a body from disk, or the probe.
     *
     * Worth knowing before building on this scope: **the id travels with the
     * card, the values do not.** Upstream keeps a script's `data` on the card
     * (`data.extensions.tavern_helper.scripts[].data`) while enabled-state lives
     * in `extension_settings`, keyed by character name — and all 47 script ids in
     * the local corpus appear zero times in `settings.json` and zero times across
     * 31 chat files. Across that corpus — 19 cards, 14 of them with scripts,
     * 47 scripts — 8 carry a non-empty `data`,
     * and every one of those is a switch or an annotation (`{statusRule}`,
     * `{isEnabled}`, a build timestamp). Nothing in the corpus grows with play,
     * and MVU never writes this scope at all: its settings go to
     * `extension_settings`, its gameplay state to the chat and message scopes.
     */
    if (scope === 'script') {
      const scriptId = option?.script_id ?? host.scriptId()
      if (scriptId === undefined) {
        throw new UnsupportedApiError(
          `${member}({type:'script'})`,
          'A script scope needs a script_id, and this body has no identity of its own.'
            + LIMIT_NOT_YOUR_FAULT,
        )
      }
      fields['scriptId'] = scriptId
    }

    return fields
  }

  /**
   * Every write goes to the host and nowhere else.
   *
   * The *operation* crosses, not a merged tree. `insertOrAssign` lets the
   * incoming value win and replaces arrays wholesale where `insert` lets the
   * existing one win, and folding that here would be a second implementation of
   * a rule subtle enough to diverge quietly.
   *
   * What comes back is the whole table for that scope, already stored — so
   * adopting it is not the optimistic write this used to refuse to do. It is the
   * host's answer, and without it a card that writes then reads is told about a
   * state that no longer exists.
   */
  const write = async (
    member: string,
    op: string,
    option: VariableOption | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const scope = scopeOf(member, option)
    // Card-facing name, not a wire method: the shell owns that mapping and is
    // the side that enforces it.
    const answer = await host.call('setVariables', { ...scope, op, ...payload })
    if (scope['scope'] !== 'message') return
    const variables = (answer as { variables?: Record<string, unknown> } | undefined)?.variables
    if (variables !== undefined) host.adoptVariables(variables)
  }

  const events = host.events

  /**
   * Refuse an event name that is not a string.
   *
   * `eventOn(tavern_events.SOMETHING_MISSING, fn)` passes `undefined` when the
   * table has no such key, and a bus keyed by string would register that under
   * `"undefined"` — a listener that is live, reachable, and can never fire. That
   * is the exact failure the shared vocabulary exists to prevent, so it is worth
   * catching even when the table is right: a card may name an event the table
   * never claimed to carry.
   * @param member - the member being called, for the message.
   * @param event - whatever the card passed as an event name.
   * @returns the event name, once it is known to be one.
   */
  const eventName = (member: string, event: unknown): string => {
    if (typeof event !== 'string' || event.length === 0) {
      throw new UnsupportedApiError(
        `${member}(${String(event)})`,
        'An event name must be a non-empty string. A missing table entry reads as undefined here.',
      )
    }
    return event
  }

  const api: Record<string, unknown> = {
    // ── reads, answered here because their callers do not await ──────────
    getVariables: (option?: VariableOption) => readVariables('getVariables', option),
    getAllVariables: () => readAllVariables('getAllVariables'),
    getLastMessageId: (): number => chatOf('getLastMessageId').length - 1,

    /**
     * The Tavern Helper version this surface was transcribed from.
     *
     * A real answer, not a stub, and the distinction rests on where the number
     * comes from. Iris's card API and its expected-globals list were both
     * transcribed from one specific installed copy of JS-Slash-Runner, so
     * "this surface is modelled on `TAVERN_HELPER_VERSION`" is a sourced fact
     * about this repository rather than a claim to be something it is not.
     *
     * Cards use it as a threshold. MagVarUpdate's entry opens with
     * `getTavernHelperVersion() < '3.4.17'` and shows an error toast when the host
     * is too old — so answering with the blueprint version produces exactly the
     * behaviour the card is asking about, while answering with nothing at all
     * threw a `ReferenceError` on the first line of its initialisation and
     * stopped the publish chain before it started.
     *
     * @returns the version string.
     */
    getTavernHelperVersion: (): string => TAVERN_HELPER_VERSION,

    /**
     * Upstream's error-catching wrapper, seeded because a bare name cannot be
     * absent politely.
     *
     * A real card produced `ReferenceError: errorCatched is not defined`, and
     * this is the one class of gap where "report and return undefined" is not
     * available: the card **calls** it, so `undefined` only trades a
     * `ReferenceError` for a `TypeError` one line later. A bare identifier is
     * either seeded or it throws; there is no third answer.
     *
     * **It re-throws.** [TH `src/function/util.ts:17-41`, via 3c] `onError`'s
     * last statement is `throw error`, so the wrapper's value is in the
     * *reporting*, not in the catching — the caller still sees the exception.
     * A first draft of this swallowed the error, which would have changed the
     * control flow of every card that wrapped a function expecting it to throw.
     *
     * **Async is covered by the same path.** Upstream branches on `isPromise`
     * and attaches `.then(undefined, onError)`, so a rejected promise is
     * reported and then rejects with the same error. A success value is returned
     * **unchanged** — no wrapping — in both branches.
     *
     * **One deliberate difference, worth its line in `DEVIATIONS.md`:** upstream
     * double-writes, a `toastr.error` for the reader and a `_log` for its panel.
     * This reports to the panel only. Upstream's toast passes the message with
     * `escapeHtml: false`, and `error.message` can carry model-authored text —
     * so injecting it as HTML is a choice to make explicitly rather than inherit
     * by copying.
     * @param fn - the function the card wants wrapped.
     * @returns a function of the same shape that reports and re-throws.
     */
    errorCatched: (fn: unknown): unknown => {
      if (typeof fn !== 'function') {
        host.reportGap(
          'card called errorCatched with something that is not a function — it was returned'
            + ' unchanged, because wrapping a non-callable would fail later and further away',
        )
        return fn
      }

      const report = (error: unknown): void => {
        /*
         * `stack` when there is one, and both for a `ZodError` — upstream's own
         * special case, because a Zod stack carries none of the validation
         * detail. That case is live in this corpus: `mvu_zod.js` is the line
         * that produces them.
         */
        const named = error as { name?: unknown, message?: unknown, stack?: unknown }
        const isZod = typeof named.name === 'string' && named.name.includes('ZodError')
        const detail = typeof named.stack === 'string' && named.stack !== ''
          ? (isZod ? `${String(named.message)}\n${named.stack}` : named.stack)
          : String(named.message ?? error)
        host.reportFault(
          `a function a card wrapped in errorCatched threw: ${detail}`
            + ' — reported and re-thrown, which is what upstream does with it, so the caller'
            + ' still sees the exception',
        )
      }

      return (...args: unknown[]): unknown => {
        try {
          const result = (fn as (...rest: unknown[]) => unknown)(...args)
          if (typeof (result as { then?: unknown } | undefined)?.then === 'function') {
            // Duck-typed, for the reason the button writers are: a card's
            // promise may come from its own realm or its own bundled library.
            return (result as Promise<unknown>).then(undefined, (error: unknown) => {
              report(error)
              throw error
            })
          }
          return result
        } catch (error: unknown) {
          report(error)
          throw error
        }
      }
    },

    /*
     * ── script buttons: answered, reported, and not implemented ──────────
     *
     * Upstream lets a script publish buttons into the panel and receive their
     * clicks. Iris has no such UI yet, and these four exist because *absence*
     * is the one answer that is definitely wrong: MagVarUpdate calls three of
     * them while wiring up, so a missing member turns a card's setup into a
     * `ReferenceError` and everything after it never runs.
     *
     * They follow the `toastr` precedent rather than inventing a new one: answer
     * the call, do nothing, and say once that nothing was done. The panel keeps
     * a named gap instead of a silent one, and the card gets to finish starting.
     */

    /**
     * The buttons this script has published.
     *
     * Answered from the pushed snapshot, synchronously, because upstream's is
     * synchronous — `getScriptButtons(): ScriptButton[]`, and MVU feeds the
     * result straight into `_.intersectionBy`. A promise here would hand that
     * call a promise to intersect, which succeeds and produces nothing.
     *
     * **Unfiltered.** `visible: false` hides a button from the bar; it does not
     * remove it from the table. A card reads this list, edits one entry and
     * writes the whole thing back, so answering with only the visible ones would
     * make the read-modify-write silently delete every hidden button — the
     * card's own bug report would say "my buttons disappeared when I toggled
     * one".
     *
     * A copy, matching upstream's `klona`: the array a card gets back is its
     * own, so mutating it changes nothing until it writes the table back.
     * @returns this script's table, or empty when it has published none.
     */
    getScriptButtons: (): { name: string, visible: boolean }[] => {
      const id = host.scriptId()
      /*
       * No id means no table to look up, and this is a real state rather than a
       * defect: a body with no entry in the host's script list has no identity
       * to publish buttons under. Empty rather than a refusal, for the same
       * reason the stub returned empty — the shape a card destructures matters
       * more than the emptiness it finds.
       */
      if (id === undefined) return []

      const published = snapshot('getScriptButtons').scriptButtons?.[id]
      if (published === undefined) return []
      return published.map(button => ({ name: button.name, visible: button.visible }))
    },

    /**
     * The event name a button's clicks would arrive under.
     *
     * Returns a string, because that is what upstream returns — the type
     * declaration is `getButtonEvent(button_name: string): string` and its own
     * example feeds it straight to `eventOn`. That makes the stub honest for
     * free: the card registers a listener on a perfectly valid event name, and
     * nothing ever emits it, because there is no button to click. Nothing here
     * can be read wrongly or explode on property access, which a fabricated
     * subscription object could.
     *
     * Scoped by script id where there is one, matching upstream's per-script
     * button registry, so two scripts naming the same button do not collide if
     * this ever becomes real.
     * @param buttonName - the button's name.
     * @returns the event name.
     */
    /**
     * The event name a button press emits.
     *
     * Upstream's, exactly: `${script_id}_${getStringHash(button_name)}`
     * (`store/iframe_runtimes/script.ts:6-8`). There is no separate event type —
     * the button id **is** the event name, computed independently on both sides
     * and expected to agree.
     *
     * That agreement is the whole mechanism, and it fails silently: a card does
     * `eventOn(getButtonEvent('名前'), handler)`, the bar emits what it computed,
     * and if the two hashes differ by a bit the handler is simply never called.
     * No error, no warning, nothing to see. So the hash is imported from
     * `@iris/compat-tavernhelper-core` rather than written here — it was already
     * present twice in this repo before this member needed it, and a third copy
     * is how two implementations start disagreeing.
     *
     * **Renaming a button changes its event.** The name is an input to the hash,
     * so an author who edits a label silently orphans every listener registered
     * against the old one. That is upstream's design, copied; the bar reports it
     * rather than repairing it.
     * @param buttonName - the label, as the card wrote it.
     * @returns the event name both sides compute.
     */
    getButtonEvent: (buttonName: unknown): string =>
      buttonEventName(host.scriptId(), String(buttonName)),

    /**
     * Replace one script's whole button table.
     *
     * **Whole-table, and that is upstream's semantics, not a shortcut.** A
     * button left out of `buttons` is gone; upstream's writer assigns the array
     * it is handed rather than merging into it. Its own 3.2.5 example is a
     * button that replaces the entire bar with a different set, which is what
     * "second-level buttons" means upstream — a usage, not a data structure.
     *
     * **Two arguments, `(script_id, buttons)`.** This used to take one, back
     * when it was a stub that discarded it: a card writing upstream's real call
     * would have had its script id land in `buttons`, and a no-op cannot tell
     * you it was called wrongly. The one-argument form is refused by name rather
     * than guessed at, because guessing here means writing a table under a
     * script id taken from an array.
     *
     * **Asynchronous, where upstream is synchronous.** Upstream assigns a Vue
     * ref and the bar re-renders; here the table lives on the host and the write
     * crosses the RPC boundary. A card cannot await this — upstream's returns
     * `void` and no card treats it as a promise — so a failure cannot be thrown
     * at the call site and is reported to the panel instead. That is the one
     * divergence a card could notice: it will see its own next
     * `getScriptButtons` still answering the old table for one round trip.
     * @param scriptId - which script's table, as upstream requires.
     * @param buttons - the whole table to store.
     */
    replaceScriptButtons: (first: unknown, second?: unknown): void => {
      const call = buttonCall('replaceScriptButtons', first, second)
      if (call === undefined) return
      writeButtons('replaceScriptButtons', call.scriptId, call.buttons)
    },

    /**
     * Add the buttons this script does not already have.
     *
     * Upstream builds it out of the replace (`script.ts:110` →
     * `_updateScriptButtonsWith` → `_replaceScriptButtons`), deduplicating **by
     * name**, so it is composed here too rather than given its own host arm: a
     * second arm would be a second place that decides what "already have" means.
     *
     * Dedupe is by name because the name is the identity — the button's event is
     * `${script_id}_${hash(name)}`, so two buttons with one name are one button
     * as far as every listener is concerned.
     * @param scriptId - which script's table.
     * @param buttons - candidates; those whose names are present are dropped.
     */
    appendInexistentScriptButtons: (first: unknown, second?: unknown): void => {
      const call = buttonCall('appendInexistentScriptButtons', first, second)
      if (call === undefined) return
      const { scriptId: id, buttons: incoming } = call
      const current = buttonsOf('appendInexistentScriptButtons', id)
      const known = new Set(current.map(button => button.name))
      const added = incoming.filter(button => !known.has(button.name))
      /*
       * Nothing new is not an error and not a write — and it needs no early
       * return here, because `writeButtons` already refuses a table equal to the
       * stored one and `[...current]` is exactly that. There was one; a mutation
       * check found no test could tell whether it existed, which is what a second
       * guard for one decision looks like from the outside.
       */
      writeButtons('appendInexistentScriptButtons', id, [...current, ...added])
    },

    /**
     * Rewrite one script's table with a function of its current value.
     *
     * The same family as `updateVariablesWith`, and it stays in the façade for
     * the same reason: a function cannot cross the frame boundary, so the read,
     * the call and the write have to happen on this side.
     *
     * **Both signatures.** An updater may return the new table or a promise of
     * it; when it returns a promise this returns one too, so a card that wrote
     * an async updater can await the write. A synchronous updater gets
     * `undefined` back, which is what upstream's returns.
     * @param scriptId - which script's table.
     * @param updater - given the current table, returns the new one.
     * @returns a promise when the updater is asynchronous, otherwise undefined.
     */
    updateScriptButtonsWith: (first: unknown, second?: unknown): unknown => {
      const member = 'updateScriptButtonsWith'
      /*
       * Either shape here too, for the same reason as its siblings: the updater
       * may be the only argument. Resolved before the function check, because
       * "which of these is the updater" depends on it.
       */
      const updater = typeof first === 'function' ? first : second
      const rawId = typeof first === 'function' ? host.scriptId() : first
      if (typeof updater !== 'function') {
        host.reportFault(`card called ${member} without an updater function, so nothing was written`)
        return undefined
      }
      if (typeof rawId !== 'string' || rawId === '') {
        host.reportFault(`card called ${member} with no usable script id, so nothing was written`)
        return undefined
      }
      const id = rawId
      const produced = (updater as (current: { name: string, visible: boolean }[]) => unknown)(
        buttonsOf(member, id),
      )

      /*
       * Duck-typed on `then` rather than `instanceof Promise`. A card's updater
       * may be an async function from its own realm, or a thenable from a
       * bundled promise library, and neither is this realm's `Promise` — an
       * `instanceof` check would call `requireButtons` on a promise object and
       * refuse a perfectly good async updater.
       */
      const store = (value: unknown): void => {
        const table = readButtons(member, value)
        if (table !== undefined) writeButtons(member, id, table)
      }
      if (typeof (produced as { then?: unknown } | undefined)?.then === 'function') {
        return (produced as Promise<unknown>).then(store)
      }
      store(produced)
      return undefined
    },
    /**
     * Which message this frame belongs to — refused in a script frame.
     *
     * Upstream is explicit: *"只能对楼层消息 iframe 使用 … 如果不在楼层消息
     * iframe 内使用, 将会抛出错误"*. A script frame is not a message frame, so
     * throwing here is not a limitation — it is the contract.
     *
     * This used to answer "the last message", which looked like a harmless
     * placeholder and was actually an invention **more permissive than
     * upstream**: a card relying on it could not survive in real SillyTavern, so
     * the leniency has no beneficiary and quietly hides a card that is broken
     * everywhere else. The real answer belongs to a message frame and arrives
     * with the message-render pipeline, where it lands on the right frame type
     * without anyone migrating.
     */
    getCurrentMessageId: (): number => {
      throw new UnsupportedApiError(
        'getCurrentMessageId',
        'Upstream throws outside a message iframe; the real answer arrives with the message-render pipeline.',
      )
    },
    getScriptId: (): string | undefined => host.scriptId(),
    /**
     * The conversation, in **Tavern Helper's** shape — which is not SillyTavern's.
     *
     * This returned SillyTavern's storage objects until it was measured: `mes`,
     * `is_user`, `is_system`, and one entry per swipe. Upstream renames on the
     * way out (`chat_message.ts:164`) and returns one entry per *message*
     * carrying a `swipes` array. Four corpus sites read `.message` and
     * immediately call a string method on it, so the old shape did not fail
     * quietly there — it threw.
     *
     * The old shape had a real measurement behind it (194 corpus reads of
     * `context.chat` use `mes`), and that measurement is still correct — about
     * `context.chat`, which **is** SillyTavern's own array and still carries
     * SillyTavern's names. It was applied one surface too far. See
     * `DEVIATIONS.md` §6.
     */
    getChatMessages: (
      range: string | number,
      options?: { include_swipes?: boolean, role?: 'all' | 'user' | 'assistant' | 'system' },
    ): CardChatMessage[] => {
      const chat = chatOf('getChatMessages')
      const withSwipes = options?.include_swipes === true
      const wanted = options?.role ?? 'all'
      return resolveRange(range, chat.length).flatMap(index => {
        const message = chat[index]
        if (message === undefined) return []
        const shaped = toCardChatMessage(message, index, withSwipes)
        /*
         * Filtered on the **derived** role, which is what makes a narrator
         * message on a user row (`role: 'unknown'`) match no passable value and
         * vanish from every filtered read. That silent drop is upstream's — the
         * filter's parameter type cannot express `'unknown'`, so there is no
         * argument that returns those floors — and it is inherited rather than
         * repaired. Noted in `DEVIATIONS.md` so it is not read as ours.
         */
        if (wanted !== 'all' && shaped.role !== wanted) return []
        return [shaped]
      })
    },
    /**
     * Every world book the host knows, by name.
     *
     * **Synchronous, because upstream is.** `getWorldbookNames(): string[]` is
     * `klona(world_names)` upstream (`JS-Slash-Runner/src/function/worldbook.ts:23`)
     * — the page's own list, no promise — and the measured caller calls it
     * bare and tests the result in the same statement:
     * `names.includes('…')`. Behind an RPC that call site would read
     * `undefined.includes`, throw, and report the host's book as missing — the
     * exact misdiagnosis this member exists not to cause. So it answers from the
     * pushed snapshot (`worldbookNames`), the way `getCharWorldbookNames` and
     * `getLorebookSettings` already do.
     *
     * A book the host seeded from a card's embedded copy is a real name here, as
     * it is a real name in upstream's `world_names`: the snapshot is built from
     * the same store `worldbook.names` answers from.
     *
     * Cloned on the way out, for the reason its two sibling members are: this
     * surface is shared between a card's scripts, and an array handed out by
     * reference is one a card can mutate under the next reader.
     * @returns every known book name, in the host's order.
     */
    getWorldbookNames: (): string[] => {
      const names = snapshot('getWorldbookNames').worldbookNames
      return [...(names ?? [])]
    },
    /**
     * Which world books this card is bound to.
     *
     * **Synchronous, and that is the whole design constraint.** Upstream declares
     * `getCharWorldbookNames(character_name): CharWorldbooks` — no promise — and
     * every one of the corpus's five call sites reads a property straight off the
     * result: `getCharWorldbookNames('current').primary`. A façade that returned a
     * promise would hand those cards `undefined`, which then flows into
     * `getWorldbook(undefined)`; two of the three cards have no guard on that
     * path. So this answers from the pushed snapshot, the way the bare
     * `getVariables()` does, and `worldbook.charNames` is not on this route at all.
     *
     * **Only `'current'` is supported**, and that is a measured decision rather
     * than an inferred one: all five call sites pass `'current'`, so the named
     * branch is the one no card travels. Serving it would need the snapshot to
     * carry every character's bindings, which is unbounded. A card that does ask
     * gets a refusal naming the member instead of a silent `undefined`.
     *
     * `primary` is **the binding, not the book in use**. When a binding dangles,
     * the host's selection rule falls back to the card's embedded book, and this
     * member still reports what the card declared — so a `primary` that
     * `getWorldbook` will refuse is a normal state, not an inconsistency to
     * repair here. The card's embedded `character_book` is deliberately absent:
     * upstream's member does not report it either, and embedded and named books
     * are two different bodies of entries.
     * @param characterName - upstream's parameter; only `'current'` is served.
     * @returns the primary binding and any additional ones.
     */
    getCharWorldbookNames: (characterName?: string): {
      primary: string | null
      additional: string[]
    } => {
      if (characterName !== 'current') {
        throw new UnsupportedApiError(
          'getCharWorldbookNames',
          'Iris only supports \'current\'; a named-character query needs a synchronous'
          + ' host read that is not available in a frame.',
        )
      }

      /*
       * Absent means "no bindings", not "not loaded" — the host sends
       * `{primary: null, additional: []}` for an unbound card, and the field is
       * only optional so that a snapshot taken before it existed still parses.
       * Copied on the way out because this surface is shared between a card's
       * scripts, and an array handed out by reference is one a card can mutate
       * under the next reader.
       */
      const bound = snapshot('getCharWorldbookNames').charWorldbooks
      return { primary: bound?.primary ?? null, additional: [...(bound?.additional ?? [])] }
    },
    /**
     * World-info settings, read from the snapshot.
     *
     * **Synchronous, and that is the whole design decision.** Upstream's is, and
     * the MVU bundle has one call site that does not `await` it — as an RPC this
     * would hand that site a `Promise`, every field read off it would be
     * `undefined`, and nothing would throw. A silent read of sixteen undefineds
     * is the worst available failure: the card configures its scan against
     * nothing and produces a subtly wrong prompt, with no report anywhere. So it
     * lives in the pushed snapshot beside `charWorldbooks` rather than on the
     * wire.
     *
     * Absent means the host has not sent it, which is not the same as "there are
     * no settings" — so this reports rather than inventing a default table.
     * Sixteen invented values would each be plausible and the composite would be
     * a configuration nobody chose; `undefined` at least fails where it is read.
     *
     * Cloned on the way out, for the reason `getCharWorldbookNames` is: this
     * surface is shared between a card's scripts, and
     * `selected_global_lorebooks` is an array a card could sort in place under
     * the next reader.
     * @returns the settings, or undefined when the snapshot carries none.
     */
    getLorebookSettings: (): LorebookSettings | undefined => {
      const settings = snapshot('getLorebookSettings').lorebookSettings
      if (settings === undefined) {
        host.reportGap(
          'a card called getLorebookSettings and this frame\u2019s snapshot carries no world-info'
          + ' settings \u2014 it returned undefined, which is not a statement that none are set',
        )
        return undefined
      }
      // Structurally, not by spread: the only nested member is an array, and a
      // spread would hand out the same one.
      return { ...settings, selected_global_lorebooks: [...settings.selected_global_lorebooks] }
    },
    /**
     * A runtime prompt injection the card holds a handle to.
     *
     * The host implements the primitive and this composes the wrapper, which is
     * upstream's own division: `injectPrompts` is a thin layer over
     * `setExtensionPrompt` whose **key is the handle**, and `uninject()` is the
     * removal of that key [`DEVIATIONS.md` §11]. So nothing new goes on the
     * wire; what goes here is the composition, the lifetime, and three things a
     * frame cannot do that the composition has to say something about.
     *
     * **A fourth assembly surface.** This is neither preset, worldbook nor
     * message: it is a run of text the card can revoke and re-add at will,
     * depth 0, role `user` in the one measured use — and the card revokes it
     * around a wrapped `withIsolatedRawGeneration`, so two prompt-assembly
     * states exist within one chat on purpose [`OVERLAY-CARDS.md` §四].
     *
     * **`once` defaults to false and the measured card relies on that.** It
     * passes one argument, so the injection survives the generation that
     * follows and every generation after it, until the card calls `uninject()`
     * or the frame goes. An implementation that cleared after one generation
     * would be silently wrong in the direction nobody checks: the text simply
     * stops appearing.
     *
     * **`filter` cannot cross the frame boundary.** It is a function, upstream
     * evaluates it at assembly time on its own page, and no measured card
     * passes one. Reported by name rather than dropped, because a filter that
     * silently never runs turns "inject this when X" into "inject this always"
     * — a wrong prompt rather than a missing feature.
     *
     * **Teardown is not this frame's business, and a first version had that
     * wrong.** Upstream's `$(window).on('pagehide', uninject)` is on the
     * SillyTavern *page*, not on a frame — so a frame being destroyed uninjects
     * nothing upstream, and an injection outlives every frame rebuild. This
     * frame therefore registers no unload cleanup: doing so would revoke, on
     * every re-render, injections upstream keeps.
     *
     * The lifetime Iris gives them is **one chat session** — narrower than
     * upstream's page, which lets an injection leak across a chat switch until
     * the page itself goes. That is a deliberate divergence in the safer
     * direction and belongs in `DEVIATIONS.md`; the clearing is host-side, on
     * chat teardown, not here.
     * @param prompts - upstream's `InjectionPrompt[]`.
     * @param options - upstream's `{ once }`, default false.
     * @returns the handle, whose `uninject` removes every key this call set.
     */
    injectPrompts: (prompts: unknown, options?: unknown): { uninject: () => void } => {
      const member = 'injectPrompts'
      const rows = Array.isArray(prompts) ? prompts : []
      if (!Array.isArray(prompts)) {
        host.reportFault(
          `card called ${member} without an array of prompts, so nothing was injected`,
        )
        // A handle regardless: the card stores it and calls `uninject()` later,
        // and `undefined.uninject` would fail somewhere else entirely.
        return { uninject: () => {} }
      }

      const keys: string[] = []
      for (const [at, row] of rows.entries()) {
        const prompt = row as Record<string, unknown> | null
        if (prompt === null || typeof prompt !== 'object') {
          host.reportFault(`card called ${member} with prompts[${String(at)}] not an object`)
          continue
        }

        /*
         * `id ?? uuid`, **written back onto the prompt** — and the write-back is
         * where Iris has one fewer bug than upstream.
         *
         * Upstream computes `prompt.id ?? uuidv4()` for the key and never stores
         * it, so its own `uninject` later reads `p.id`, finds `undefined`, and
         * removes nothing: an id-less injection upstream **cannot be revoked**.
         * Storing it makes the handle work. The card never sees the difference
         * except that `uninject()` does what it says, so this is compatible in
         * every direction a card can observe — noted in `DEVIATIONS.md` as a bug
         * not reproduced.
         *
         * Not a UUID, deliberately: upstream's own contract comment records that
         * assembly order within a group is the **lexicographic** order of keys,
         * so a UUID drops the injection at a random position in the prompt. A
         * counter makes the order the card's own call order, which is the order
         * its author was thinking in.
         */
        if (typeof prompt['id'] !== 'string' || prompt['id'] === '') {
          prompt['id'] = `iris-injection-${String(nextInjection += 1)}`
        }
        const key = prompt['id'] as string

        if (typeof prompt['filter'] === 'function') {
          host.reportGap(
            `card called ${member} with a filter on ${key} \u2014 a function cannot cross this`
            + ' frame\u2019s boundary, so the injection is unconditional here; upstream would'
            + ' have asked the filter before assembling it',
          )
        }

        // Deduplicated, because a repeated id **overwrites** the whole row
        // rather than adding a second injection — so it is one key, and
        // `uninject` should issue one removal for it.
        if (!keys.includes(key)) keys.push(key)
        void host.call('setExtensionPrompt', {
          key,
          value: String(prompt['content'] ?? ''),
          /*
           * `'none'` only for the exact literal; **everything else, including an
           * absent or misspelled position, is IN_CHAT**. That is upstream's
           * behaviour rather than a lenient reading of it: its check is
           * `position === 'none' ? NONE : IN_CHAT`, so a typo injects at depth
           * instead of being refused, and a card written against the typo works.
           */
          position: prompt['position'] === 'none' ? 'none' : 'at-depth',
          depth: typeof prompt['depth'] === 'number' ? prompt['depth'] : 0,
          // `'system'` when absent, which is upstream's default — not omitted.
          // The contract's own default would be the host's choice rather than
          // upstream's, and the two need not agree.
          role: typeof prompt['role'] === 'string' ? prompt['role'] : 'system',
          should_scan: prompt['should_scan'] === true,
        }).then(undefined, (error: unknown) => {
          host.reportFault(
            `card called ${member} and the injection ${key} was refused: `
            + (error instanceof Error ? error.message : String(error)),
          )
        })
      }

      let gone = false
      const uninject = (): void => {
        // Idempotent: the measured card calls `S.uninject(); S = null` in
        // several places and a wrapper calls it again around an isolated
        // generation, so a second call must not re-issue every removal.
        if (gone) return
        gone = true
        for (const key of keys) {
          // An empty value **is** the removal — the contract says so, so this is
          // not a trick.
          void host.call('setExtensionPrompt', { key, value: '' }).then(undefined, () => {})
        }
      }

      if (options !== null && typeof options === 'object'
        && (options as Record<string, unknown>)['once'] === true) {
        /*
         * Upstream hangs the auto-removal on ST's own generation events, not on
         * Tavern Helper's `js_*` ones. Both names exist in these tables and mean
         * different moments, and picking the wrong pair would clear the
         * injection at a time no card asked for.
         */
        /*
         * **Three events, not two.** Upstream hangs the auto-removal on Tavern
         * Helper's `js_generation_ended` *and* SillyTavern's own
         * `generation_ended`, plus `generation_stopped` so that an aborted
         * generation also revokes. Both `GENERATION_ENDED` names exist in these
         * tables and mean different moments; subscribing to one is a `once`
         * injection that sometimes stays.
         *
         * `uninject` is idempotent, which is what makes three subscriptions
         * safe — and it has to be anyway, because the measured card calls it
         * itself in several places.
         */
        /*
         * Upstream's three, which the shell now emits — two on a completion and
         * one on an abort. Subscribing to all three is safe because `uninject`
         * is idempotent, and it has to be anyway: the measured card calls it
         * itself in several places.
         *
         * These names were emitted by nothing for one round, and all three
         * subscriptions sat there doing nothing while a `once` injection was
         * never revoked — silently. The lesson kept beside the fix: **a
         * subscription is not evidence that anything emits.**
         */
        for (const event of ['js_generation_ended', 'generation_ended', 'generation_stopped']) {
          events.eventOnce(event, () => {
            uninject()
          })
        }
      }

      return { uninject }
    },

    /**
     * Revoke injections by id, without holding their handle.
     *
     * Upstream's top-level companion to `injectPrompts`, and **synchronous** for
     * the same reason: a card treats the removal as done on the next line. No
     * measured card calls it, and it is built anyway — it is four lines over the
     * same primitive, and leaving it out while `injectPrompts` exists makes the
     * gap unfalsifiable in the one direction that matters, since a card removing
     * by id has no handle to fall back on.
     * @param ids - the injection ids to remove.
     */
    uninjectPrompts: (ids: unknown): void => {
      const list = Array.isArray(ids) ? ids : []
      if (!Array.isArray(ids)) {
        host.reportFault(
          'card called uninjectPrompts without an array of ids, so nothing was removed',
        )
        return
      }
      for (const id of list) {
        if (typeof id !== 'string' || id === '') {
          host.reportFault(
            `card called uninjectPrompts with ${JSON.stringify(id)}, which names no injection`,
          )
          continue
        }
        // An empty value is the removal, per the contract.
        void host.call('setExtensionPrompt', { key: id, value: '' }).then(undefined, () => {})
      }
    },
    getSwipes: (messageId?: number): string[] => {
      const chat = chatOf('getSwipes')
      const at = messageId ?? chat.length - 1
      return chat[at]?.swipes ?? []
    },

    // ── writes, which their callers already await ────────────────────────
    replaceVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('replaceVariables', 'replace', option, { variables }),
    insertOrAssignVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('insertOrAssignVariables', 'insertOrAssign', option, { variables }),
    insertVariables: async (variables: Record<string, unknown>, option?: VariableOption) =>
      write('insertVariables', 'insert', option, { variables }),
    /**
     * Deletion names a path, not a value.
     *
     * Refused here rather than sent as a non-string, because the host rejects a
     * `delete` without a `path` as `invalid-request` — a correct answer that
     * arrives one round trip later and names the request instead of the member.
     */
    deleteVariable: async (path: unknown, option?: VariableOption) => {
      if (typeof path !== 'string' || path.length === 0) {
        throw new UnsupportedApiError(
          `deleteVariable(${String(path)})`,
          'Deletion takes a path, such as "stat.hp".',
        )
      }
      return write('deleteVariable', 'delete', option, { path })
    },
    /**
     * The updater is a function, so it cannot travel. It runs here against the
     * snapshot and the *result* is what the host is asked to store — which is
     * how MVU uses it anyway: every call is awaited, and the value it builds is
     * the whole variable tree rather than a delta.
     */
    updateVariablesWith: async (
      updater: (variables: Record<string, unknown>) => Record<string, unknown>,
      option?: VariableOption,
    ) => {
      /*
       * The one writer that reads first, so it reads from the host rather than
       * from the snapshot — even for the `message` scope the snapshot carries.
       *
       * Two reasons. It works on every scope this way, which is what MVU's
       * `update_variables.ts:1549` needs when the "also update chat variables"
       * setting is on. And a read-modify-write against a snapshot that went
       * stale between pushes would silently discard whatever changed in between;
       * the operation is already asynchronous, so the round trip costs nothing
       * that was not already being paid.
       *
       * An empty table here is an answer, not a failure — a scope nobody has
       * written to yet reads as empty, which is exactly the state the first
       * `updateVariablesWith` on a new chat starts from. A failed *call* rejects
       * instead, and then nothing is written at all.
       */
      const answer = await host.call('getVariables', scopeOf('updateVariablesWith', option))
      const current = (answer as { variables?: Record<string, unknown> } | undefined)?.variables ?? {}
      const next = updater(structuredClone(current))
      return write('updateVariablesWith', 'replace', option, { variables: next })
    },
    /**
     * One named world book's entries, with its regex keys revived.
     *
     * Upstream's signature is `getWorldbook(worldbook_name): Promise<WorldbookEntry[]>`
     * and it **throws when the book does not exist** — documented as `@throws` on
     * the declaration. That is copied rather than softened: the host answers
     * `not-found`, the rejection propagates, and a card written against upstream
     * catches it in the same place. Returning an empty array instead would say
     * "this book has no entries", which leads a card to a different repair than
     * "there is no such book".
     *
     * The corpus reaches this member exactly one way — `getWorldbook` is always
     * handed the result of `getCharWorldbookNames('current').primary`, in all
     * three cards that call it — so the two members are really one idiom in two
     * halves, and the name arriving here is a name the host itself just supplied.
     */
    getWorldbook: async (name: string): Promise<CardWorldbookEntry[]> => readWorldbook(name),

    /**
     * Replace a named book's contents wholesale.
     *
     * **Wholesale is the word.** Upstream rebuilds the stored book entirely from
     * the array it is given: an entry absent from it is deleted, a missing `uid`
     * is assigned at random, and `displayIndex` is reassigned from array
     * position — so a book that goes out and comes back has been reordered. The
     * one rule that catches people is that **an omitted field is not "leave it
     * alone", it is "take the default"**, and one of those defaults is
     * `constant: true`. So `book.map(e => ({ uid: e.uid }))`, which reads like a
     * no-op, turns every entry in the book always-on. That is upstream's
     * behaviour and it is copied rather than repaired, because a card may be
     * relying on it.
     *
     * A book that does not exist is **not created** — the host refuses, as
     * upstream does.
     * @param name - the book's name, exactly as spelled.
     * @param entries - the new contents; only `uid` is required on each.
     * @param _options - upstream's `{ render }`, accepted and ignored (see below).
     * @returns nothing, matching upstream's `Promise<void>`.
     */
    replaceWorldbook: async (
      name: string,
      entries: readonly unknown[],
      /*
       * `render` is read off the signature and never consulted. It tells upstream
       * whether to repaint its own world-book editor, and Iris has no such
       * editor. Accepting and ignoring it — the same treatment `setChatMessages`
       * gives `refresh` — is what lets a card written against upstream call this
       * unchanged; rejecting it would fail on an argument that means nothing here.
       */
      _options?: { render?: 'debounced' | 'immediate' },
    ): Promise<void> => {
      await host.call('replaceWorldbook', {
        name,
        entries: entries.map(entry => flattenWorldbookEntry(entry)),
      })
    },

    /**
     * Read a book, let the card rewrite it, and store the result.
     *
     * Built in the frame rather than sent over the wire, for the reason
     * `updateVariablesWith` is: it takes a **function**, and a function cannot
     * cross the boundary. So it is composed from the two members that can.
     *
     * The updater receives **revived** entries, exactly as `getWorldbook` returns
     * them, and may be synchronous or async — upstream's `WorldbookUpdater` is a
     * union of both. Whatever it returns is passed through whole: no attempt is
     * made to send only the entries that look changed. That optimisation is
     * specifically wrong here, because the host renumbers `displayIndex` from
     * array position, so a partial array would silently reorder the book.
     *
     * A missing book throws on the **first read**, before the updater runs — same
     * as upstream, which also reads before it replaces. The card's function is
     * never called against a book that is not there.
     * @param name - the book's name.
     * @param updater - given the current entries, returns the new ones.
     * @param options - upstream's `{ render }`, accepted and ignored.
     * @returns the book as it stands after the write.
     */
    updateWorldbookWith: async (
      name: string,
      updater: (
        book: CardWorldbookEntry[],
      ) => readonly unknown[] | Promise<readonly unknown[]>,
      options?: { render?: 'debounced' | 'immediate' },
    ): Promise<CardWorldbookEntry[]> => {
      const current = await readWorldbook(name)
      const next = await updater(current)

      /*
       * The host's replace answers with a fresh read of the book, so that is what
       * is returned — and it has to be, rather than what the updater produced: the
       * two differ wherever the host filled in a uid or renumbered. Handing back
       * the updater's own array would hide exactly the changes the card needs to
       * see. Upstream reads a second time to get this; one read is skipped here
       * because the host already performed it.
       */
      const answer = await host.call('replaceWorldbook', {
        name,
        entries: next.map(entry => flattenWorldbookEntry(entry)),
        ...(options?.render === undefined ? {} : { render: options.render }),
      })
      const stored = (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
      return stored.map(entry => reviveWorldbookKeys(entry))
    },
    swipeTo: async (messageId: number, swipeId: number) =>
      // `swipeIndex` on the wire; upstream's parameter is `swipeId`. Renamed at
      // the boundary rather than in either half's own vocabulary.
      host.call('swipeTo', { messageId, swipeIndex: swipeId }),

    // ── host capabilities that were already asynchronous ─────────────────
    /**
     * Upstream has **two** generate functions, and this is the assembling one.
     *
     * | upstream member | what it does | Iris host method |
     * | --- | --- | --- |
     * | `generate({user_input})` | assembles preset, worldbook and chat history, with `user_input` as the last user message | `script.generate` |
     * | `generateRaw(...)` | the **caller** orders the prompt; nothing is assembled | `script.generateRaw` |
     *
     * Written out because getting them the wrong way round is **silent in both
     * directions**, and it was wrong here: this member routed to
     * `script.generateRaw`, so a card asking for the assembled generate received
     * a reply built with no persona, no worldbook and no history — text back,
     * nothing thrown, on a path that costs the user money.
     *
     * Fields are mapped from upstream's `GenerateConfig`
     * (`@types/function/generate.d.ts:225`) rather than passed through, because
     * the two vocabularies differ and a silent pass-through would drop the ones
     * that matter: `user_input` → `userInput`, `max_chat_history` →
     * `maxHistory`. Upstream's `'all'` is spelled as *absent* here, which is the
     * contract's way of saying the same thing.
     *
     * What is **not** carried, and is named rather than dropped quietly:
     * `should_stream` (measured: the stream only drives a character-count
     * progress indicator and the body comes from the awaited return value, so a
     * non-streaming implementation is not wrong — only less animated), and the
     * config fields no card in the corpus passes.
     * @param config - upstream's config object.
     * @returns the generated text.
     */
    generate: async (config: Record<string, unknown>): Promise<unknown> => {
      const chatId = snapshot('generate').chatId
      if (chatId === undefined) {
        throw new UnsupportedApiError(
          'generate()',
          'This frame has no chat to generate into; its snapshot carries no chat id.',
        )
      }

      const userInput = config['user_input']
      if (typeof userInput !== 'string' || userInput === '') {
        throw new UnsupportedApiError(
          'generate({user_input})',
          'The assembling generate needs a user message to put last; Iris does not send an empty one.',
        )
      }

      /*
       * Named differences reported once, not swallowed. A progress bar that
       * never moves is the kind of thing a card author would otherwise chase
       * into their own code.
       */
      if (config['should_stream'] === true) {
        host.reportGap(
          'a card asked generate() to stream — Iris returns the whole reply at once, so a' +
            ' progress indicator driven by the stream will not move; the text itself is unaffected',
        )
      }

      const maxHistory = config['max_chat_history']
      const answer = await host.call('generate', {
        chatId,
        userInput,
        // Upstream's `'all'` and an absent value mean the same thing, and the
        // contract spells it as absent.
        ...(typeof maxHistory === 'number' ? { maxHistory } : {}),
      })
      return (answer as { text?: unknown } | undefined)?.text
    },

    /**
     * Upstream's **caller-ordered** generate — and until now a name that was
     * documented here and never implemented, which is the one failure shape
     * this surface cannot carry: a card's bare `generateRaw(...)` threw
     * `ReferenceError` on the first call, inside a handler that catches and
     * reports "questionnaire failed", and the card told its player the host
     * lacked the plugin. Measured in 神隐挑战's 游戏引擎 at 13 call sites, every
     * one the object form:
     *
     *   generateRaw({ user_input, should_silence, overrides, ordered_prompts })
     *
     * `ordered_prompts` is the member's whole point — the caller, not the
     * preset, decides what the model sees. Upstream resolves each entry in
     * order; entries are environment names or literal `{role, content}`. The
     * same composition, over Iris's two-field raw method (`prompt` +
     * `systemPrompt`):
     *
     * - `user_input` — a string, or a role-message list, placed where the
     *   `user_input` name appears in the order.
     * - `persona_description`, `char_description`, `char_personality`,
     *   `scenario_description` — the override from `overrides` when the caller
     *   supplies one (神隐挑战 overrides the persona on every site); the
     *   snapshot carries no persona text of its own, so without an override the
     *   name is skipped and **said**.
     * - `world_info_before`, `world_info_after` — world-info assembly is the
     *   *assembling* generate's job upstream too; the raw method sends only
     *   what it is handed. Skipped and said, once per call.
     * - `{role, content}` — `system` rides the host's system field; `user` and
     *   `assistant` ride the prompt in order.
     * - any other name — skipped and said. An unknown environment name silently
     *   dropped would read as "the model ignored that part", which is the
     *   quietest kind of wrong.
     *
     * `should_silence` needs no carrying: upstream's flag keeps a raw
     * generation out of the chat log, and Iris's raw method never writes a
     * floor in the first place. `max_response_token` and `header_version` are
     * accepted and unused, as no corpus call passes them.
     * @param config - upstream's `GenerateRawArgs` object.
     * @returns the generated text.
     */
    generateRaw: async (config: Record<string, unknown>): Promise<unknown> => {
      const chatId = snapshot('generateRaw').chatId
      if (chatId === undefined) {
        throw new UnsupportedApiError(
          'generateRaw()',
          'This frame has no chat to generate into; its snapshot carries no chat id.',
        )
      }

      const userInput = config['user_input']
      const overrides =
        typeof config['overrides'] === 'object' && config['overrides'] !== null
          ? (config['overrides'] as Record<string, unknown>)
          : {}
      const ordered = Array.isArray(config['ordered_prompts']) ? config['ordered_prompts'] : undefined

      /** The prompt side, in the order the caller wrote it. */
      const promptParts: string[] = []
      const systemParts: string[] = []
      const skipped: string[] = []
      const contentOf = (entry: unknown): string | undefined =>
        typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>)['content'] === 'string'
          ? ((entry as Record<string, unknown>)['content'] as string)
          : undefined
      const pushUserInput = (value: unknown): void => {
        if (typeof value === 'string') {
          promptParts.push(value)
          return
        }
        // Upstream also accepts role messages here; fold them in order.
        if (Array.isArray(value)) for (const entry of value) promptParts.push(contentOf(entry) ?? '')
      }
      const envOf = (name: string): string | undefined => {
        const override = overrides[name]
        if (typeof override === 'string') return override
        skipped.push(name)
        return undefined
      }

      if (ordered !== undefined) {
        for (const entry of ordered) {
          if (typeof entry === 'string') {
            if (entry === 'user_input') pushUserInput(userInput)
            else {
              const env = envOf(entry)
              if (env !== undefined) promptParts.push(env)
            }
            continue
          }
          const role = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['role'] : undefined
          const content = contentOf(entry)
          if (content === undefined) continue
          if (role === 'system') systemParts.push(content)
          else promptParts.push(content)
        }
      } else {
        // No order given: upstream sends the user input alone.
        pushUserInput(userInput)
      }

      if (skipped.length > 0) {
        host.reportGap(
          'a card ordered generateRaw with environment prompt(s) this frame does not carry '
          + `(${[...new Set(skipped)].join(', ')}), so those parts were left out of what the model saw`,
        )
      }
      if (Array.isArray(config['injects']) && config['injects'].length > 0) {
        host.reportGap(
          'a card passed injects to generateRaw — in-chat injection depth/order is not carried, '
          + 'so those parts were left out of what the model saw',
        )
      }

      const prompt = promptParts.filter(part => part !== '').join('\n\n')
      if (prompt === '') {
        throw new UnsupportedApiError(
          'generateRaw({...})',
          'The composed prompt is empty; there is nothing to send the model.',
        )
      }
      const systemPrompt = systemParts.join('\n\n')
      const answer = await host.call('generateRaw', {
        chatId,
        prompt,
        ...(systemPrompt === '' ? {} : { systemPrompt }),
      })
      return (answer as { text?: unknown } | undefined)?.text
    },

    triggerSlash: async (command: string): Promise<string> => host.triggerSlash(command),
    /**
     * Upstream's spelling, kept wrong on purpose — cards call it.
     *
     * Returns the text unexpanded, and **says so when that mattered**. The macro
     * engine is host-side and this member is synchronous, so there is nothing to
     * expand with; the host's own implementation falls back to the same thing
     * when no engine is wired, and matching it is right.
     *
     * What is not right is doing it silently. Text handed back unchanged is
     * indistinguishable from text that had nothing to expand — a plausible
     * normal value standing in for an unimplemented capability, which is the
     * quietest way a gap can hide. So when the text actually carried macros, the
     * frame reports that none were expanded, and says explicitly that this is
     * not a claim the text had none.
     */
    substitudeMacros: (text: string): string => {
      if (typeof text === 'string' && text.includes('{{') && text.includes('}}')) {
        host.reportGap(
          'a card asked for macro expansion and this frame performed none — the text came back' +
            ' unchanged, which is not a statement that it had no macros',
        )
      }
      return text
    },

    // ── the event family, on the bus the shell forwards into ─────────────
    eventOn: (event: string, listener: Listener) =>
      events.eventOn(eventName('eventOn', event), listener),
    eventOnce: (event: string, listener: Listener) =>
      events.eventOnce(eventName('eventOnce', event), listener),
    eventMakeFirst: (event: string, listener: Listener) =>
      events.eventMakeFirst(eventName('eventMakeFirst', event), listener),
    eventMakeLast: (event: string, listener: Listener) =>
      events.eventMakeLast(eventName('eventMakeLast', event), listener),
    eventEmit: async (event: string, ...args: unknown[]) =>
      events.eventEmit(eventName('eventEmit', event), ...args),
    eventRemoveListener: (event: string, listener: Listener) =>
      events.eventRemoveListener(eventName('eventRemoveListener', event), listener),
    eventClearEvent: (event: string) => events.eventClearEvent(eventName('eventClearEvent', event)),
    eventClearListener: (listener: Listener) => events.eventClearListener(listener),
    eventClearAll: () => events.eventClearAll(),
    iframe_events: IFRAME_EVENTS,
    tavern_events: TAVERN_EVENTS,
    mvu_events: MVU_EVENTS,
  }

  /*
   * Upstream's house rule, applied once at the exit rather than member by member.
   *
   * Tavern Helper clones what it hands back — 21 `klona` calls across 10 modules,
   * `getVariables` / `getChatMessages` / `getPreset` / `getCharacter` among them.
   * Iris was handing out live references into the frame's snapshot, which is
   * **Iris-only behaviour in the worse direction**: a card mutating a return
   * value changes our state and changes nothing on real SillyTavern, so it
   * invites a dependency no other host honours. Corpus mutations of these return
   * values: zero, so this breaks nothing measured.
   *
   * Done here, in one place, because a per-member `klona` makes "the new member
   * forgot to clone" a regression that can happen. There is no list to keep.
   */
  const detached = detachReturns(api, host.reportGap)

  // Upstream exposes the same members twice: bare, and under `TavernHelper`.
  // Both spellings appear in real cards, so both have to resolve.
  detached['TavernHelper'] = { ...detached }
  return detached
}

/**
 * Copy an API surface so that every **call** hands back detached data.
 *
 * Only call results are copied. Properties are passed through untouched, and
 * that distinction is load-bearing rather than an optimisation:
 *
 * - `tavern_events`, `iframe_events` and `mvu_events` are shared constant tables,
 *   and a card comparing `parent.event_types` with the bare `tavern_events`
 *   must find the same object — there is a test asserting exactly that. Cloning
 *   them would break a name-matching that has no error to report when it fails.
 * - `eventSource` carries methods, so it is not structured-cloneable at all, and
 *   an event bus that were copied would deliver to nobody.
 *
 * Neither exclusion needs listing, because neither is a function return.
 *
 * The frame's own members (`initializeGlobal`, `waitGlobalInitialized`) are built
 * elsewhere and deliberately outside this: what they hand back is a value one of
 * the card's own scripts published for its siblings, and copying it would break
 * cohabitation — the shared bag exists precisely so those references are shared.
 * @param api - the surface as built.
 * @param report - where to say that something could not be detached.
 * @returns the same surface, with call results copied.
 */
/**
 * Members whose return value is a **handle**, and so must not be copied.
 *
 * Measured: `eventOn`, `eventOnce`, `eventMakeFirst` and `eventMakeLast` all
 * return `{ stop: () => void }` — a live unsubscribe. A structured copy of one
 * is impossible (it holds a function) and would be **useless if it were
 * possible**: calling `stop` on a copy would unsubscribe nothing.
 *
 * They were not exempt, so every script's first `eventOn` produced
 * "returned a value Iris could not copy, so the card holds a live reference
 * into the frame's snapshot" — a sentence whose premise is false for a handle,
 * reported as an error, and therefore rendered by the panel as the card's
 * scripts having **failed**. Every card with a script hit it: `eventOn` is
 * ordinarily the first thing a script does.
 *
 * The distinction the detach layer actually cares about is a live reference into
 * the frame's **snapshot data**. A handle is not data, and upstream hands the
 * same handle back by reference too — copying it was never the compatible
 * behaviour.
 */
const HANDLE_RETURNS: ReadonlySet<string> = new Set([
  'eventOn',
  'eventOnce',
  'eventMakeFirst',
  'eventMakeLast',
  /*
   * `{ uninject }` is a live revocation, and a structured copy of one is an
   * object whose method is gone. The card stores this handle in a module
   * variable and calls it from several places later, so a clone would fail at
   * the call rather than at the copy — far from the cause.
   */
  'injectPrompts',
])

function detachReturns(
  api: Record<string, unknown>,
  report: (message: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, member] of Object.entries(api)) {
    if (typeof member !== 'function') {
      out[name] = member
      continue
    }
    if (HANDLE_RETURNS.has(name)) {
      // Handed back by reference, with nothing said: this is the contract, not
      // a fallback from a failed copy.
      out[name] = member
      continue
    }
    out[name] = (...args: unknown[]): unknown => {
      const result = (member as (...rest: unknown[]) => unknown)(...args)
      if (result instanceof Promise) return result.then(value => detach(value, name, report))
      return detach(result, name, report)
    }
  }
  return out
}

/**
 * A structured copy, or the original with a report if it cannot be copied.
 *
 * The fallback is reported rather than silent. A member returning something
 * uncloneable is returning a live reference — the exact condition this exists to
 * end — so passing it through quietly would reinstate the problem for whichever
 * member happens to hold a function or a proxy. A card sees no difference; the
 * report is for whoever added that member.
 * @param value - what the member returned.
 * @param member - its name, for the report.
 * @param report - where to say it.
 * @returns a detached copy where one is possible.
 */
function detach(value: unknown, member: string, report: (message: string) => void): unknown {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    report(
      `${member} returned a value Iris could not copy, so the card holds a live reference`
        + ' into the frame’s snapshot — upstream would have handed back a copy',
    )
    return value
  }
}
