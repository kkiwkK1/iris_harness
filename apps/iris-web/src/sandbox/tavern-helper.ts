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
  type Listener,
} from '@iris/compat-tavernhelper-core'
// `parseRegexFromString` is the *same* function the host's activation engine
// matches with; it moved to `@iris/text` on 2026-09-12 so two generic engines
// would stop depending on the Tavern Helper compat layer to reach it (root
// `notes/DEVIATIONS.md`, stage 0). Both packages are dependency-free and both are on
// the browser's import allowlist, so nothing about what this frame can reach
// changed.
import { parseRegexFromString } from '@iris/text'
// —— family③: preset —— the same module the host writes presets back through,
// so the three prompt-class guards cannot disagree across the two sides.
import {
  PLACEHOLDER_PROMPT_DEFAULT_ORDER,
  TH_DEFAULT_PRESET,
  isPresetNormalPrompt,
  isPresetPlaceholderPrompt,
  isPresetSystemPrompt,
  mergePresetDefaults,
  type TavernHelperPreset,
} from '@iris/compat-tavernhelper-core'
// —— family③ end ——
import type {
  LorebookSettings,
  ScriptChatMessage,
  ScriptContext,
  WorldbookEntry,
  // —— family②: regex ——
  TavernRegexSource,
  TavernRegexTier,
  TavernRegexView,
  // —— family①: identity & messages ——
  CharacterSummary,
} from '@iris/protocol'

import { buttonEventName } from './button-event.ts'
import { UnsupportedApiError } from './errors.ts'
// —— family④: lorebook / worldbook ——
import {
  assignLorebookUids,
  fromLorebookEntry,
  lorebookSettingsPatch,
  matchesLorebookFilter,
  mergeLorebookEntry,
  toLorebookEntry,
  type CardLorebookEntry,
} from './lorebook-aliases.ts'

// —— family②: regex ——
/** Which tier a card's option names, as the wire spells it. */
type TavernRegexTierName = TavernRegexTier

/**
 * One rule as a card receives it.
 *
 * The wire's shape plus upstream's deprecated `scope` tag, which only the
 * `{scope, enable_state}` read attaches (`@types/function/tavern_regex.d.ts:34`
 * marks it `@deprecated` and says it is returned *only* on that path). It is a
 * frame-side tag rather than a wire field for exactly that reason: the host
 * answers one tier per call and has nothing to say about it.
 */
type TavernRegexRow = TavernRegexView & { scope?: 'global' | 'character' }

/**
 * Upstream's five sources, in the order its own table declares them.
 *
 * Checked in the frame rather than left to the host's schema, so a card that
 * mistypes one gets a message naming the member and the five spellings instead
 * of a transport-shaped refusal.
 */
const TAVERN_REGEX_SOURCES: readonly TavernRegexSource[] = [
  'user_input',
  'ai_output',
  'slash_command',
  'world_info',
  'reasoning',
]

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
  /**
   * The floor this frame renders, when it is a message frame.
   *
   * Undefined in a script frame, where `getCurrentMessageId` must keep
   * upstream's throw. Answered from the shell's own `currentMessageId`.
   */
  currentMessageId?: () => number | undefined
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

// —— family①: identity & messages ——
/**
 * A message interface frame's name, as `getIframeName` spells it.
 *
 * Upstream's own pattern, verbatim from `function/util.ts:110` — including the
 * optional `_n` suffix, which its second render path appends and which its own
 * reader tolerates without reading. Declared once because two members share
 * it: the name is built to match this, and `getMessageId` parses it.
 */
const MESSAGE_FRAME_NAME = /^TH-message--(\d+)--\d+(_\d+)?$/u

/**
 * SillyTavern's `persona_description_positions`, as a card reads them.
 *
 * Numbers, not names: upstream's `Persona.position` is a `number` and its own
 * enum is `{IN_PROMPT: 0, AFTER_CHAR: 1, TOP_AN: 2, BOTTOM_AN: 3, AT_DEPTH: 4,
 * NONE: 9}` (`public/scripts/personas.js:88-98`). Iris stores three of those
 * five states under its own names, so this is the translation back — a card
 * comparing `position === 0` has to be right.
 */
const PERSONA_POSITIONS: Readonly<Record<'inprompt' | 'atdepth' | 'none', number>> = {
  inprompt: 0,
  atdepth: 4,
  none: 9,
}

/** SillyTavern's `extension_prompt_roles` (`public/script.js:493-497`). */
const PERSONA_ROLES: Readonly<Record<'system' | 'user' | 'assistant', number>> = {
  system: 0,
  user: 1,
  assistant: 2,
}

/** Upstream's `DEFAULT_DEPTH` for a persona description (`function/persona.ts:47`). */
const UPSTREAM_PERSONA_DEPTH = 2

/** Upstream's `DEFAULT_ROLE`, which is `SYSTEM` (`function/persona.ts:48`). */
const UPSTREAM_PERSONA_ROLE = 0

/**
 * How many conversations one `getChatHistoryDetail` call may read.
 *
 * The host's own cap, restated here so the frame can say what happened to the
 * fifty-first file rather than let a card compare two array lengths and guess.
 * Upstream caps nothing; the protocol's schema says why this does.
 */
const HISTORY_DETAIL_LIMIT = 50

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
 * conflating them is `notes/apps/iris-web/DEVIATIONS.md` §6.
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
  /**
   * The swipe triple, on **every** shape.
   *
   * Upstream returns these under its `// for compatibility` comment in both
   * shapes (`chat_message.ts:139-143` plain, `:148` swiped) — the option named
   * `include_swipes` swaps `message`/`data`/`extra` for `swipes_info`, it does
   * not gate these. They are required here because a card reads them without
   * asking: 人贩子物语's embedded phone guards on `msg.swipes[swipeId]` after a
   * call whose option it misspelled, so "present only when asked" was, for the
   * one caller that mattered, "present never".
   */
  swipe_id: number
  swipes: string[]
  swipes_data: Record<string, unknown>[]
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
 * The key upstream writes at `chat[1].variables[0]` when its one-time variable
 * cleanup has been answered ([MVU] `cleanup/legacy_chat.ts:27-33`).
 *
 * Copied rather than invented, for the same reason the host copies it
 * (`packages/iris-app-service/src/prune.ts`): a chat carried between the two
 * applications has to keep its answer.
 */
export const IGNORE_CLEANUP_KEY = 'ignore_cleanup'

/**
 * Tell a card's MagVarUpdate that this chat's legacy cleanup is already
 * answered, so it never raises its own offer.
 *
 * **This exists because Iris already ports that whole path natively, and the
 * two were running in parallel.** The host raises the same offer on
 * `chat.open` — the same four gates, the same three buttons, upstream's own
 * labels and order (`app/CleanupOffer.tsx`, `notes/apps/iris-web/DEVIATIONS.md`
 * 17) — and it is the copy with an implementation behind it: it sweeps the chat
 * file, it exports a real backup, and it persists the refusal. MVU's in-frame
 * copy can do none of those three here, and each failure is measured rather
 * than assumed:
 *
 * - its sweep writes `chat[i].variables` on the **snapshot**, and `saveChat()`
 *   carries no rows (`frame.ts`: `callAction('saveChat', {})`), so the deletion
 *   is discarded at the next context push;
 * - its "back up and clean" POSTs to `/api/chats/export`, which Iris refuses
 *   (DEVIATIONS 19) — so the branch toasts an export failure and returns
 *   without cleaning;
 * - its "do not remind me again" writes `_.set(SillyTavern.chat, [1,
 *   'variables', 0, 'ignore_cleanup'], true)` on that same snapshot, so it does
 *   not even achieve upstream's permanent refusal.
 *
 * Two dialogs asking one question, one of which cannot carry out any of its
 * three answers, is worse than either alone — so this closes upstream's own
 * fourth gate instead. It is upstream's vocabulary, and in Iris it is **true**:
 * the question has an answer path, and it is not the card's.
 *
 * **Non-enumerable, and that is the load-bearing detail.** A card that reads
 * floor 1's table and writes it back through `replaceVariables({type:
 * 'message', message_id: 1})` would otherwise persist this fabricated key into
 * the real chat file and silently disable the host's offer forever — and MVU's
 * restore path does write floors from `snapshot + 1` upward, which can be
 * floor 1. `JSON.stringify`, object spread, `Object.keys` and structured clone
 * all skip a non-enumerable property, while `_.has`, `hasOwnProperty` and `in`
 * — which is what the gate uses — all see it. So the mark is visible exactly
 * where it is read and invisible everywhere it could escape.
 *
 * **The cost.** Floor 1's tables are parsed eagerly, once per snapshot, which
 * is the one row `restoreFloorTables` would otherwise have left lazy. Measured
 * at 0.01 ms per floor against the 7.75 ms the laziness exists to avoid for a
 * 677-row chat.
 * @param chat - the snapshot's chat array, mutated in place.
 */
export function sealLegacyCleanup(chat: readonly ScriptChatMessage[]): void {
  const floor = chat[1]
  if (floor === undefined) return
  const tables = floor['variables']
  if (!Array.isArray(tables)) return
  const first: unknown = tables[0]
  if (typeof first !== 'object' || first === null) return
  /*
   * Already there is left alone: the chat may genuinely carry upstream's key
   * because someone answered "do not remind me again" in SillyTavern, and
   * redefining it would be a write over the user's real answer.
   */
  if (Object.prototype.hasOwnProperty.call(first, IGNORE_CLEANUP_KEY)) return
  Object.defineProperty(first, IGNORE_CLEANUP_KEY, {
    value: true,
    enumerable: false,
    writable: true,
    configurable: true,
  })
}

/**
 * Normalise a floor's per-swipe variables to one table per swipe.
 *
 * The data is already in the snapshot — the same position upstream keeps it — so
 * this is derivation with no new transport, per `notes/packages/iris-app-service/FLOOR-VARIABLES.md`. Holes are
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

  // The fields both shapes carry; the caller below adds the triple and the
  // `data` half of upstream's asymmetry.
  const base: Omit<CardChatMessage, 'data' | 'swipe_id' | 'swipes' | 'swipes_data'> = {
    message_id: index,
    name: message.name,
    role: narrator
      ? (message.is_user ? 'unknown' : 'system')
      : (message.is_user ? 'user' : 'assistant'),
    is_hidden: message.is_system === true,
    message: message.mes ?? '',
    extra: message.extra ?? {},
  }

  /*
   * The plain shape carries the swipe triple **too**, not only `data`. Upstream's
   * plain return has `swipe_id`, `swipes` and `swipes_data` under its own
   * `// for compatibility` comment (`chat_message.ts:139-143`) — every floor
   * carries them, asked or not, and `include_swipes` changes only whether
   * `message`/`data`/`extra` ride along. The plain read used to return `data`
   * alone, on a reading of the option's name as a gate; what that cost was
   * measured: 人贩子物语's embedded phone calls
   * `getChatMessages('0', { include_swipe: true })` — misspelled, which upstream
   * ignores exactly as this did — and reads `msg.swipes[swipeId]` from the plain
   * shape's compatibility fields, so every greeting but the first reported
   * "开场白 N 不存在" on a floor that held all four.
   */
  if (!withSwipes) {
    return {
      ...base,
      data: swipesData[swipeId] ?? {},
      swipe_id: swipeId,
      swipes: [...swipes],
      swipes_data: swipesData,
    }
  }

  // No `data` here, deliberately — see the field's note.
  return { ...base, swipe_id: swipeId, swipes: [...swipes], swipes_data: swipesData }
}

export function createFrameTavernHelper(host: TavernHelperFrameHost): Record<string, unknown> {
  /**
   * The in-use preset, parsed, and the text it was parsed from.
   *
   * — family③: preset. The snapshot carries the preset as JSON text (see
   * `ScriptContext.preset.inUse` for why), and `getPreset` parses it. Keeping
   * the text beside the value is what makes the cache safe without an
   * invalidation rule: a new snapshot brings a different string, so `!==` is
   * the whole check. A frame whose card never calls `getPreset` never parses at
   * all, which is the point — the text arrives in every frame and the parse is
   * the expensive half.
   */
  let parsedPreset: { text: string, value: TavernHelperPreset } | undefined

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
       * (`script.ts:76-78`, the four TODOs) — which `notes/apps/iris-web/SCRIPT-BUTTONS.md` records
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
   * One named book's entries, **as the host sent them** — keys still text.
   *
   * The fetch itself, so that "how a book is fetched" is decided once and
   * revival is the only thing its two readers differ by. The old `Lorebook`
   * vocabulary reads this half: its getter hands a card the stored strings and
   * declares `keys: string[]`, so going through revival would be a conversion
   * performed twice to arrive back where it started.
   * @param name - the book's name, exactly as spelled.
   * @returns its entries in the wire shape.
   */
  const readWorldbookRows = async (name: string): Promise<WorldbookEntry[]> => {
    const answer = await host.call('getWorldbook', { name })
    return (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
  }

  /**
   * The same book with its regex keys revived.
   *
   * Shared by `getWorldbook` and `updateWorldbookWith` so that what state a
   * book's keys are in is decided once. The alternative was for the update path
   * to fetch its own copy, which is how the two would come to disagree about
   * revival — and the updater's input disagreeing with `getWorldbook`'s output
   * is precisely the kind of difference a card author cannot see.
   * @param name - the book's name, exactly as spelled.
   * @returns its entries, with both key lists revived.
   */
  const readWorldbook = async (name: string): Promise<CardWorldbookEntry[]> =>
    (await readWorldbookRows(name)).map(entry => reviveWorldbookKeys(entry))

  /**
   * The create and rebind arms, as locals.
   *
   * Both the members below and `getOrCreateChatWorldbook` — which composes the
   * two — go through these, so "how a book is created" and "how a chat is bound"
   * are decided once. A member that reached a sibling through `this` would break
   * the first time the object was destructured or spread, which is how cards
   * routinely import these APIs.
   */
  const createBook = async (name: string, entries: readonly unknown[] = []): Promise<boolean> => {
    const answer = await host.call('createWorldbook', {
      name,
      entries: entries.map(entry => flattenWorldbookEntry(entry)),
    })
    return (answer as { created?: boolean } | undefined)?.created === true
  }

  const bindChatBook = async (name: string | null): Promise<void> => {
    await host.call('rebindChatWorldbook', { name })
  }

  // —— family④: lorebook / worldbook ——
  /*
   * The readings and writes the two vocabularies share.
   *
   * Every one of these was the body of a `Worldbook` member and is now a local
   * both it and its `Lorebook` alias go through. That is the point: upstream
   * renamed this family and kept the old names, so the two spellings are one
   * behaviour by definition — a second implementation of "which book is the
   * chat's" would be free to answer differently for `getChatLorebook` than for
   * `getChatWorldbookName`, and nothing would catch it, because each half
   * would be self-consistent.
   *
   * `member` travels into each one so a refusal names the member the *card*
   * called rather than the local it reached.
   */
  const charBookNames = (
    member: string,
    characterName?: string,
  ): { primary: string | null, additional: string[] } => {
    if (characterName !== 'current') {
      throw new UnsupportedApiError(
        member,
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
    const bound = snapshot(member).charWorldbooks
    return { primary: bound?.primary ?? null, additional: [...(bound?.additional ?? [])] }
  }

  /** The chat's own book, with upstream's existence guard applied. */
  const chatBookName = (member: string): string | null => {
    const context = snapshot(member)
    const bound = context.chatMetadata['world_info']
    if (typeof bound !== 'string' || bound === '') return null
    return (context.worldbookNames ?? []).includes(bound) ? bound : null
  }

  /** Upstream's `getOrCreateChatLorebook`, which the new name also composes. */
  const getOrCreateChatBook = async (member: string, worldbookName?: string): Promise<string> => {
    const bound = chatBookName(member)
    if (bound !== null) return bound

    const minted = worldbookName === undefined
    const name = worldbookName
      ?? `Chat Book ${snapshot(member).chatId}`
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g, '_')
        .substring(0, 64)

    const created = await createBook(name)
    if (!created) {
      // Upstream throws this case for a caller-supplied name
      // (`lorebook.ts:348`). A minted name colliding is possible too — two
      // chats can sanitize to the same 64 characters — and upstream's
      // `createNewWorldInfo` refuses it no less; the message is the same
      // either way, with the name in it so the card can pick another.
      throw new Error(
        `${member}: the world book '${name}' already exists`
        + (minted ? ' (name minted from the chat id; pass an explicit worldbook_name to choose your own)' : ''),
      )
    }
    await bindChatBook(name)
    return name
  }

  /** Delete a book by name; `false` is "there was none", as upstream's is. */
  const deleteBook = async (name: string): Promise<boolean> => {
    const answer = await host.call('deleteWorldbook', { name })
    return (answer as { deleted?: boolean } | undefined)?.deleted === true
  }

  /**
   * Rebind a character's books, for both spellings of that write.
   *
   * **`primary` is refused rather than dropped, and that is the one place this
   * family cannot do what upstream does.** Upstream's `setCurrentCharLorebooks`
   * writes the primary binding into the **card file** — it drives
   * `#character_world` and posts `/api/characters/edit` (`lorebook.ts:263-284`)
   * — and this host has no arm for that at all: `worldbook.setCharBooks` is
   * `world_info.charLore`, the additional list, and its contract says the
   * primary "lives on the card, and the card file is shared between
   * installations". A card asking for one gets a named refusal; silently
   * writing only `additional` would report success for half a request.
   *
   * An unchanged `primary` is **not** a request: the round trip a card writes is
   * `setCurrentCharLorebooks({...getCharLorebooks(), additional: […]})`, and
   * refusing that would refuse the ordinary call for naming a value it is not
   * changing.
   *
   * Both lists are checked for existence **before** anything is written, which
   * is upstream's order (`lorebook.ts:255-261`, one throw naming every missing
   * book) rather than the host's per-write not-found. A half-applied rebind is
   * the failure that order exists to prevent.
   */
  const rebindCharBooks = async (
    member: string,
    characterName: string | undefined,
    books: { primary?: string | null, additional?: readonly string[] },
  ): Promise<void> => {
    const current = charBookNames(member, characterName)

    if (books.primary !== undefined && (books.primary ?? null) !== current.primary) {
      throw new UnsupportedApiError(
        member,
        'Iris cannot change a character\'s primary world book: that binding lives inside the'
        + ' card file, which is shared between installations, and this host has no arm that'
        + ' writes one. The additional books are writable, and nothing was written.',
      )
    }

    if (books.additional === undefined) return

    /*
     * **The additional list only**, where upstream checks the primary too
     * (`lorebook.ts:255` concatenates both before its one throw).
     *
     * Deliberate, and the reason is a state Iris supports on purpose: a
     * primary binding whose file is gone is normal here — `getCharWorldbookNames`
     * reports the binding rather than the book in use, and the host falls back
     * to the card's embedded copy (2 of the corpus's 18 bindings dangle). A
     * card doing the ordinary round trip,
     * `setCurrentCharLorebooks({...getCharLorebooks(), additional: […]})`,
     * would then be refused over a name it is not changing and this host
     * cannot write anyway.
     */
    const known = snapshot(member).worldbookNames ?? []
    const missing = books.additional.filter(name => !known.includes(name))
    if (missing.length > 0) {
      throw new Error(
        `${member}: cannot bind world books that do not exist: ${JSON.stringify(missing)}`,
      )
    }

    await host.call('rebindCharWorldbooks', { names: [...books.additional] })
  }

  /**
   * Write a whole book from entries in the **old** vocabulary, and read it back.
   *
   * The one write leg of the five old entry members. Upstream builds each of
   * them on `replaceLorebookEntries` plus a re-read
   * (`lorebook_entry.ts:365`), and this keeps that shape: the array is
   * translated, sent whole, and what comes back is what the **host** stored —
   * which is the only thing worth returning, because the host mints uids and
   * renumbers `displayIndex` from array position.
   * @param name - the book's name.
   * @param entries - the new contents, in the old vocabulary.
   * @returns the book as stored, in the old vocabulary.
   */
  const replaceLorebook = async (
    name: string,
    entries: readonly Partial<CardLorebookEntry>[],
  ): Promise<CardLorebookEntry[]> => {
    const answer = await host.call('replaceWorldbook', {
      name,
      entries: assignLorebookUids(entries).map(entry => fromLorebookEntry(entry)),
    })
    const stored = (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
    return stored.map((entry, index) => toLorebookEntry(entry, index))
  }

  /** One book in the old vocabulary, `display_index` from array position. */
  const readLorebook = async (name: string): Promise<CardLorebookEntry[]> =>
    (await readWorldbookRows(name)).map((entry, index) => toLorebookEntry(entry, index))

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
     * longest chat [49, `notes/packages/iris-app-service/FLOOR-ADDRESSED-VARIABLES.md` §一]. The data was in
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

  // —— family②: regex ——
  /**
   * Which tier a card's `option.type` names, and a refusal for the `name` this
   * host cannot honour.
   *
   * Upstream's option carries `name?: string | 'current'` for a character and
   * `name?: string | 'in_use'` for a preset, and resolves it through
   * `RawCharacter.findIndex` / `getCompletionPresetByName` — so a card there
   * reads and writes *any* installed card's tier and any saved preset's. Here
   * the tier is whatever the open conversation is playing, which is what makes
   * "a card cannot edit another card's rules" structural rather than a check.
   *
   * A `name` naming something else is therefore **refused, not ignored**:
   * ignoring it would answer with this card's rules under another card's name,
   * a wrong answer that looks like a right one — and a card that then wrote the
   * list back would overwrite the wrong document. The two self-referential
   * spellings pass through, since they name what this host would have answered
   * anyway.
   * @param member - the member being called, for the message.
   * @param type - the caller's `option.type`.
   * @param name - the caller's `option.name`, if any.
   * @returns the tier.
   */
  const tavernTier = (member: string, type: unknown, name: unknown): TavernRegexTierName => {
    if (type !== 'global' && type !== 'character' && type !== 'preset') {
      throw new UnsupportedApiError(
        `${member}({type: ${String(type)}})`,
        "the type must be 'global', 'character' or 'preset'",
      )
    }
    const own = type === 'preset' ? 'in_use' : 'current'
    if (name !== undefined && name !== own) {
      throw new UnsupportedApiError(
        `${member}({type: '${type}', name: '${String(name)}'})`,
        `this host answers only for the conversation you are in, so the ${type} tier is`
          + ` addressed as '${own}' or by leaving the name out. Naming another one would`
          + ' have been answered with this one.',
      )
    }
    return type
  }

  /**
   * One tier's rules, or — in upstream's older spelling — global and card
   * concatenated.
   *
   * Shared by all three members so that "which tier a call names" is decided
   * once: `updateTavernRegexesWith` reading its own way is precisely how its
   * input would come to disagree with `getTavernRegexes`' output, which is a
   * difference a card author cannot see.
   * @param option - upstream's tier option, or its deprecated scope form.
   * @returns the rules, tagged with `scope` on the deprecated path.
   */
  const readTavernRegexes = async (
    option?: Record<string, unknown>,
  ): Promise<TavernRegexRow[]> => {
    const tier = async (name: TavernRegexTierName): Promise<TavernRegexRow[]> => {
      const answer = await host.call('getTavernRegexes', { tier: name })
      return (answer as { regexes?: TavernRegexRow[] } | undefined)?.regexes ?? []
    }
    const type = option?.['type']
    if (type !== undefined) return tier(tavernTier('getTavernRegexes', type, option?.['name']))

    const scope = option?.['scope'] ?? 'all'
    const enableState = option?.['enable_state'] ?? 'all'
    // Validated before anything is read, and in upstream's order —
    // `enable_state` first — so a call that is wrong twice is refused with the
    // message upstream would have given it. Plain `Error`, not
    // `UnsupportedApiError`: these are upstream's own strings, and a card that
    // catches one and reads its text is reading that text.
    if (!['all', 'enabled', 'disabled'].includes(String(enableState))) {
      throw Error(
        `提供的 enable_state 无效, 请提供 'all', 'enabled' 或 'disabled', 你提供的是: ${String(enableState)}`,
      )
    }
    if (!['all', 'global', 'character'].includes(String(scope))) {
      throw Error(`提供的 scope 无效, 请提供 'all', 'global' 或 'character', 你提供的是: ${String(scope)}`)
    }
    let rows: TavernRegexRow[] = []
    if (scope === 'all' || scope === 'global') {
      rows = [...rows, ...(await tier('global')).map(row => ({ ...row, scope: 'global' as const }))]
    }
    if (scope === 'all' || scope === 'character') {
      rows = [...rows, ...(await tier('character')).map(row => ({ ...row, scope: 'character' as const }))]
    }
    if (enableState !== 'all') rows = rows.filter(row => row.enabled === (enableState === 'enabled'))
    return rows
  }

  // —— family①: identity & messages ——
  /**
   * Say a thing once per frame, however many times a card asks.
   *
   * Every report in this family sits on a member a status panel may call in a
   * redraw loop, and the panel of one corpus card redraws on every variable
   * update. One line per distinct fact is a diagnosis; four hundred identical
   * lines is a flood that hides the other findings — the same reasoning
   * `parent-messages.ts` counts by shape for, minus its tenfold reprises,
   * because none of these is a thing whose *rate* means anything.
   */
  const reported = new Set<string>()
  const reportOnce = (key: string, message: string): void => {
    if (reported.has(key)) return
    reported.add(key)
    host.reportGap(message)
  }

  /**
   * Notes written by `replaceScriptInfo`, by script id.
   *
   * In the frame, because nothing stores them — see that member. Keyed by script
   * id rather than kept as one value, because a card's scripts share this realm
   * and the identity-bound copies of the surface share this closure: two scripts
   * each writing their own note must not read each other's.
   */
  const scriptInfoWrites = new Map<string, string>()

  /**
   * The library summary a card's name argument means.
   *
   * Upstream's `RawCharacter.findIndex` (`function/raw_character.ts:89-98`)
   * takes `'current'`, or matches a lower-cased name against both the card's
   * name and its avatar id. The same three spellings, folded the same way —
   * this host's ids are filename-shaped, so two spellings of one id can differ
   * only in case.
   *
   * An empty or absent name is `'current'`, which is upstream's own backward
   * compatibility (`name = !name ? 'current' : name`, `raw_character.ts:184`).
   * @param context - the snapshot to look in.
   * @param name - what the card asked for.
   * @returns the summary, or undefined when nothing matches.
   */
  const characterFor = (
    context: ScriptContext,
    name?: string,
  ): CharacterSummary | undefined => {
    const asked = name === undefined || name === '' ? 'current' : String(name)
    if (asked.toLowerCase() === 'current') {
      const current = context.characterId
      return current === undefined
        ? undefined
        : context.characters.find(summary => summary.characterId === current)
    }
    const wanted = asked.toLowerCase()
    return context.characters.find(
      summary => summary.characterId.toLowerCase() === wanted || summary.name.toLowerCase() === wanted,
    )
  }

  /**
   * The persona list, or the empty answer plus a report when there is no store.
   *
   * The distinction the snapshot's field keeps — key absent means no store, `[]`
   * means a store with nothing in it — is spent here and nowhere else, so the
   * four list members do not each have to remember it.
   * @param member - who is asking, for the report.
   * @returns the rows, possibly empty.
   */
  const personaRows = (member: string): readonly { id: string, name: string }[] => {
    const rows = snapshot(member).personas
    if (rows === undefined) {
      reportOnce(
        'personas-absent',
        `a card read ${member} and this host keeps no persona store, so the answer is empty —`
          + ' which is not a report that the profile has no personas',
      )
      return []
    }
    return rows
  }

  /**
   * Replace one tier — or, on the deprecated path, both of them, partitioned by
   * each row's own `scope`.
   *
   * Upstream's `_.partition(regexes, r => r.scope === 'global')`
   * (`src/function/tavern_regex.ts:276`), so a row with no `scope` lands in the
   * card's tier: that is which bucket `_.partition`'s falsy half is, and it is
   * what a card holding the legacy read's output relies on.
   * @param regexes - the rules to store.
   * @param option - upstream's tier option, or its deprecated scope form.
   */
  const writeTavernRegexes = async (
    regexes: readonly Record<string, unknown>[],
    option?: Record<string, unknown>,
  ): Promise<void> => {
    const rows = [...regexes]
    const write = async (
      name: TavernRegexTierName,
      list: readonly Record<string, unknown>[],
    ): Promise<void> => {
      // `scope` is stripped: it is the deprecated read's tag, not a stored
      // field, and the host's schema is strict — a card that round-trips the
      // legacy shape would otherwise be refused for echoing what it was given.
      await host.call('replaceTavernRegexes', {
        tier: name,
        regexes: list.map(({ scope: _tag, ...rest }) => rest),
      })
    }
    const type = option?.['type']
    if (type !== undefined) {
      await write(tavernTier('replaceTavernRegexes', type, option?.['name']), rows)
      return
    }
    const scope = option?.['scope'] ?? 'all'
    if (!['all', 'global', 'character'].includes(String(scope))) {
      throw Error(`提供的 scope 无效, 请提供 'all', 'global' 或 'character', 你提供的是: ${String(scope)}`)
    }
    if (scope === 'all' || scope === 'global') {
      await write('global', rows.filter(row => row['scope'] === 'global'))
    }
    if (scope === 'all' || scope === 'character') {
      await write('character', rows.filter(row => row['scope'] !== 'global'))
    }
  }

  /**
   * One script's row out of the snapshot.
   *
   * A missing `scripts` field is reported once, because the members that read it
   * answer `''` — upstream's own answer for a script its store does not know —
   * and an empty string is exactly the kind of plausible value that hides a
   * missing field.
   * @param member - who is asking, for the report.
   * @param scriptId - the calling script.
   * @returns the row, or undefined.
   */
  const scriptRow = (
    member: string,
    scriptId: string,
  ): { name: string, info?: string } | undefined => {
    const rows = snapshot(member).scripts
    if (rows === undefined) {
      reportOnce(
        'scripts-absent',
        `a card read ${member} and this snapshot carries no script names, so the answer is the`
          + ' empty string — which upstream also answers for a script its own store has lost,'
          + ' so the two are indistinguishable from the call',
      )
      return undefined
    }
    return rows[scriptId]
  }

  /**
   * Upstream's `message_id` option, resolved against this chat.
   *
   * A transcription of `formatAsDisplayedMessage`'s own preamble
   * (`function/displayed_message.ts:28-63`): the three `'last*'` spellings, the
   * negative-index normalisation, and the range check whose message names the
   * span upstream names.
   * @param messageId - upstream's option value.
   * @returns the floor index.
   * @throws {UnsupportedApiError} for a value that is not a floor of this chat.
   */
  const displayFloorOf = (messageId: 'last' | 'last_user' | 'last_char' | number): number => {
    const chat = chatOf('formatAsDisplayedMessage')
    const last = chat.length - 1
    if (last < 0) {
      throw new UnsupportedApiError('formatAsDisplayedMessage', 'this conversation has no floors.')
    }
    const lastWhere = (wanted: 'user' | 'char'): number => {
      for (let index = last; index >= 0; index -= 1) {
        const line = chat[index]
        if (line === undefined || line.is_system === true) continue
        if (wanted === 'user' ? line.is_user : !line.is_user) return index
      }
      return -1
    }
    let resolved: number
    switch (messageId) {
      case 'last': resolved = last; break
      case 'last_user': resolved = lastWhere('user'); break
      case 'last_char': resolved = lastWhere('char'); break
      default: {
        if (typeof messageId !== 'number' || !Number.isInteger(messageId)) {
          throw new UnsupportedApiError(
            'formatAsDisplayedMessage',
            `message_id must be 'last', 'last_user', 'last_char' or a floor number, and it was`
              + ` ${String(messageId)}.`,
          )
        }
        resolved = messageId < 0 ? chat.length + messageId : messageId
      }
    }
    if (resolved < 0 || resolved > last) {
      throw new UnsupportedApiError(
        'formatAsDisplayedMessage',
        `message_id is not in [${String(-last - 1)}, ${String(last)}]: ${String(messageId)}.`,
      )
    }
    return resolved
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
     * **One deliberate difference, worth its line in `notes/apps/iris-web/DEVIATIONS.md`:** upstream
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
     * `@iris/text` rather than written here — it was already
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
     * Which message this frame belongs to — the floor in a message frame, a
     * refusal in a script frame.
     *
     * Upstream is explicit: *"只能对楼层消息 iframe 使用 … 如果不在楼层消息
     * iframe 内使用, 将会抛出错误"*. A script frame is not a message frame, so
     * throwing there is not a limitation — it is the contract.
     *
     * This used to throw **everywhere**, on the reasoning that "the real answer
     * arrives with the message-render pipeline". The pipeline arrived and the
     * throw stayed, and the cost was measured: 建国控制台's initialisation opens
     * with `typeof getCurrentMessageId === 'function'` — true, it is a function —
     * then calls it, catches the throw, and reports "MVU 未连接" while `mvuReady`
     * has already been set, so the whole 暗线 write is skipped without a word
     * anywhere a reader looks. A placeholder that answers a probe is worse than
     * one that is absent: it passes the guard and fails the call. The shell now
     * tells every message frame its floor (`currentMessageId`), and the member
     * answers with it.
     */
    getCurrentMessageId: (): number => {
      const floor = host.currentMessageId?.()
      if (floor === undefined) {
        throw new UnsupportedApiError(
          'getCurrentMessageId',
          'Upstream throws outside a message iframe; this frame is not one.',
        )
      }
      return floor
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
     * `notes/apps/iris-web/DEVIATIONS.md` §6.
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
         * repaired. Noted in `notes/apps/iris-web/DEVIATIONS.md` so it is not read as ours.
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
    } => charBookNames('getCharWorldbookNames', characterName),
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
     * removal of that key [`notes/apps/iris-web/DEVIATIONS.md` §11]. So nothing new goes on the
     * wire; what goes here is the composition, the lifetime, and three things a
     * frame cannot do that the composition has to say something about.
     *
     * **A fourth assembly surface.** This is neither preset, worldbook nor
     * message: it is a run of text the card can revoke and re-add at will,
     * depth 0, role `user` in the one measured use — and the card revokes it
     * around a wrapped `withIsolatedRawGeneration`, so two prompt-assembly
     * states exist within one chat on purpose [`notes/apps/iris-web/OVERLAY-CARDS.md` §四].
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
     * direction and belongs in `notes/apps/iris-web/DEVIATIONS.md`; the clearing is host-side, on
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
         * every direction a card can observe — noted in `notes/apps/iris-web/DEVIATIONS.md` as a bug
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
    /*
     * The chat-book and creation family below answers one measured fact:
     * 神隐挑战 V1.5.4 mints a chat world book at runtime and appends entries to
     * it (`getOrCreateChatWorldbook` then `createWorldbookEntries`), and 2.png
     * calls `getWorldbookNames` — answered beside `getCharWorldbookNames`
     * above. Before this family existed those calls hit nothing, and a card
     * whose game engine writes its own lore played with a world that could
     * never grow.
     */

    /**
     * The globally selected books.
     *
     * Synchronous upstream, so it reads the snapshot's `lorebookSettings` — the
     * same table `getLorebookSettings()` hands out, whose
     * `selected_global_lorebooks` is this answer. Absent settings mean a host
     * that shipped no table, and `[]` is that installation's truth rather than
     * an invented empty selection.
     */
    getGlobalWorldbookNames: (): string[] => {
      const settings = snapshot('getGlobalWorldbookNames').lorebookSettings
      return [...(settings?.selected_global_lorebooks ?? [])]
    },

    /**
     * The name of the chat's own book, or null.
     *
     * Reads `chat_metadata.world_info` from the snapshot and applies the same
     * existence guard upstream's getter does (`lorebook.ts:317`): the key is
     * honoured only while the named file exists, and a dangling key reads as
     * unbound rather than as an error. Upstream also unsets the dangling key it
     * finds; that write needs a round trip, so this member only refuses to
     * report it — the next `getOrCreateChatWorldbook` minting a book will not
     * collide, because the host's create refuses existing names.
     * @param chatName - upstream's parameter; only `'current'` is served.
     */
    getChatWorldbookName: (chatName?: string): string | null => {
      if (chatName !== 'current') {
        throw new UnsupportedApiError(
          'getChatWorldbookName',
          'Iris only supports \'current\'; a named-chat query needs a synchronous'
          + ' host read that is not available in a frame.',
        )
      }
      return chatBookName('getChatWorldbookName')
    },

    /**
     * Bind — or, with null, unbind — the chat's own book.
     *
     * The host refuses a name with no file behind it, which is upstream's
     * `setChatLorebook` behaviour (`lorebook.ts:331`): a dangling binding would
     * make every later scan silently skip the chat book.
     */
    rebindChatWorldbook: async (chatName: 'current', worldbookName: string | null): Promise<void> => {
      if (chatName !== 'current') {
        throw new UnsupportedApiError(
          'rebindChatWorldbook',
          'Iris only supports \'current\'; the chat that is open is the one this frame can name.',
        )
      }
      await bindChatBook(worldbookName)
    },

    /**
     * Choose the books injected into every chat.
     *
     * Upstream writes `world_info.globalSelect` through the settings and saves
     * debounced; this crosses to the host arm of the same name. Chats already
     * open keep the selection they resolved with — the host's ruling, which this
     * member inherits rather than softens.
     */
    rebindGlobalWorldbooks: async (worldbookNames: string[]): Promise<void> => {
      await host.call('rebindGlobalWorldbooks', { names: [...worldbookNames] })
    },

    /**
     * Create a book that does not exist yet, reporting rather than throwing.
     *
     * Upstream's `createWorldbook` answers `false` for "already there" — the
     * get-or-create idiom treats that as a normal outcome. The `entries` may be
     * omitted, which is what the chat-book path wants: a file to bind before
     * any entry exists to put in it.
     */
    createWorldbook: async (name: string, entries: readonly unknown[] = []): Promise<boolean> =>
      createBook(name, entries),

    /**
     * The chat's own book, minted when there is none.
     *
     * Upstream's `getOrCreateChatLorebook` (`lorebook.ts:339`), step for step:
     * an existing binding returns as-is; a caller-supplied name must be free;
     * otherwise the name is minted as `Chat Book <chatId>` with every
     * non-alphanumeric run collapsed to one underscore and the whole thing cut
     * at 64 characters — upstream's exact recipe, because the name is stored in
     * chat metadata and a differently-minted name would simply never match the
     * one a card went looking for.
     * @param chatName - upstream's parameter; only `'current'` is served.
     * @param worldbookName - the name to create when none is bound.
     * @returns the bound book's name.
     */
    getOrCreateChatWorldbook: async (chatName: 'current', worldbookName?: string): Promise<string> => {
      if (chatName !== 'current') {
        throw new UnsupportedApiError(
          'getOrCreateChatWorldbook',
          'Iris only supports \'current\'; the chat that is open is the one this frame can name.',
        )
      }
      return getOrCreateChatBook('getOrCreateChatWorldbook', worldbookName)
    },

    /**
     * Append entries to a book, and say which ones landed.
     *
     * Upstream's `createWorldbookEntries` is `updateWorldbookWith` plus a slice:
     * read, remember the length, append, write whole, and return the re-read
     * tail. The tail comes from the **re-read**, not from the caller's array —
     * the host fills in uids and renumbers `displayIndex`, so the entries as
     * stored are the only ones worth reporting.
     * @param name - the book's name; it must already exist, as upstream requires.
     * @param newEntries - the entries to append; only `uid` is required on each.
     * @param _options - upstream's `{ render }`, accepted and ignored.
     * @returns the whole book as stored, and the newly added tail.
     */
    createWorldbookEntries: async (
      name: string,
      newEntries: readonly unknown[],
      _options?: { render?: 'debounced' | 'immediate' },
    ): Promise<{ worldbook: CardWorldbookEntry[], new_entries: CardWorldbookEntry[] }> => {
      const current = await readWorldbook(name)
      const sliceStart = current.length
      const answer = await host.call('replaceWorldbook', {
        name,
        entries: [...current, ...newEntries].map(entry => flattenWorldbookEntry(entry)),
      })
      const stored = (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
      const worldbook = stored.map(entry => reviveWorldbookKeys(entry))
      return { worldbook, new_entries: worldbook.slice(sliceStart) }
    },

    swipeTo: async (messageId: number, swipeId: number) =>
      // `swipeIndex` on the wire; upstream's parameter is `swipeId`. Renamed at
      // the boundary rather than in either half's own vocabulary.
      host.call('swipeTo', { messageId, swipeIndex: swipeId }),

    /**
     * Upstream's chat-patch member, and the one a message frame's own button
     * most often calls — the measured card starts its whole game through
     * `setChatMessages([{ message_id: 0, swipe_id: 1 }])`.
     *
     * Two of upstream's patch fields are carried, each to the arm that owns it:
     * `swipe_id` moves a floor to another of its swipes, and `message` rewrites
     * a floor's text through the same wire call the journal replay uses.
     * Anything else a patch may carry (`data`, `variables`, `role`, …) is
     * **named once per call and not silently dropped**: a patch that
     * half-applied must not be readable as one that applied.
     *
     * Accepted and ignored: upstream's second argument (the `group_id` /
     * `chat_id` chat selector and the `refresh` repaint hint). This frame
     * answers for its own chat, and the host repaints every attached page
     * itself.
     * @param messages - upstream's patch list; `message_id` required per item.
     * @param _options - upstream's chat selector and refresh hint.
     * @returns nothing.
     */
    setChatMessages: async (
      messages: readonly Record<string, unknown>[],
      _options?: Record<string, unknown>,
    ): Promise<void> => {
      let unsupported: string[] | undefined
      for (const patch of messages) {
        const messageId = patch['message_id']
        if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) {
          throw new UnsupportedApiError(
            'setChatMessages([...])',
            'every patch needs a numeric `message_id`, and one item had none Iris could read',
          )
        }
        const swipe = patch['swipe_id']
        const message = patch['message']
        // Collected whichever arm runs: a patch that carries a carried field
        // *and* an uncarrried one must not use the carried arm to slip the
        // other past the report.
        const carried = Object.keys(patch).filter(
          name => name !== 'message_id' && name !== 'swipe_id' && name !== 'message',
        )
        unsupported = [...unsupported ?? [], ...carried]
        if (typeof message === 'string') {
          // The text arm. A patch carrying both a text and a `swipe_id` would,
          // upstream, rewrite the floor as shown in *that* swipe; this host
          // addresses text by floor alone, so the pair is refused rather than
          // applied to whichever swipe happens to be showing.
          if (typeof swipe === 'number') {
            throw new UnsupportedApiError(
              'setChatMessages([{ message_id, message, swipe_id }])',
              'a patch carrying both a text and a `swipe_id` is not answerable here —'
                + ' swipe first, then send the text as a second patch',
            )
          }
          await host.call('setChatMessages', { messages: [{ messageId, message }] })
          continue
        }
        if (typeof swipe === 'number') {
          await host.call('swipeTo', { messageId, swipeIndex: swipe })
          continue
        }
      }
      if (unsupported !== undefined && unsupported.length > 0) {
        host.reportGap(
          `a card patched setChatMessages with fields Iris does not carry`
            + ` (${[...new Set(unsupported)].join(', ')}); every such field was skipped, not applied`,
        )
      }
    },

    /**
     * Upstream's chat-append member — and until now a name the surface
     * declared but never answered, which is the one shape this surface cannot
     * carry: a card guards with `typeof createChatMessages === 'undefined'`,
     * so the gap never threw; the card silently took its "not in a Tavern"
     * branch, and the console button that should have written variables and
     * sent an initialization message did nothing at all (measured: 新·架空
     * 政治经济模拟器's 建国控制台). A missing member that a `typeof` probe
     * cannot see is worse than a throwing one — it is the swallowed failure
     * the panel exists for.
     *
     * Upstream appends floors to the chat file, one per `{role, message}`:
     * `user` becomes the reader's line, `assistant` the character's, and
     * `system` a narrator line (`is_system`). Upstream then repaints; this
     * host announces the changed chat itself (`script.createChatMessages`
     * answers with the view and every attached page hears it). What it does
     * NOT do is generate — upstream leaves the turn for the caller to trigger,
     * and the measured card follows the append with `triggerSlash('/trigger')`.
     * Accepted and ignored: `refresh` (the host repaints every page) and
     * `type` (`'one_off'` only ever accompanied chat-history edits this host
     * answers through the same arm).
     * @param messages - `{role, message}` rows, in order.
     * @param options - upstream's `insert_at` position (absent appends).
     * @returns the ids the floors landed at, upstream's own answer shape.
     */
    createChatMessages: async (
      messages: readonly Record<string, unknown>[],
      options?: Record<string, unknown>,
    ): Promise<number[]> => {
      const names = snapshot('createChatMessages')
      if (messages.length === 0) return []
      const before = chatOf('createChatMessages').length
      const insertAt = options?.['insert_at']
      const wire = messages.map(row => {
        const role = row['role']
        const message = row['message']
        if (typeof message !== 'string') {
          throw new UnsupportedApiError(
            'createChatMessages([{ role, message }])',
            'every row needs a string `message`, and one had none Iris could write',
          )
        }
        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
          throw new UnsupportedApiError(
            'createChatMessages([{ role, message }])',
            `the role ${String(role)} is not one upstream defines (user, assistant, system)`,
          )
        }
        return {
          // `name` rides the chat's own speaker table, which is exactly how
          // upstream defaults it (`name1`/`name2`).
          name: role === 'user' ? names.name1 : names.name2,
          is_user: role === 'user',
          mes: message,
          ...role === 'system' ? { is_system: true } : {},
        }
      })
      const answer = await host.call('createChatMessages', {
        messages: wire,
        ...typeof insertAt === 'number' ? { insertAt } : {},
      })
      // The host answers with the whole view, so the ids come from where the
      // floors actually landed rather than from what the caller guessed.
      const view = (answer as { view?: { messages?: { id: number }[] } } | undefined)?.view
      const total = view?.messages?.length ?? before + wire.length
      const at = typeof insertAt === 'number'
        ? Math.min(Math.max(insertAt < 0 ? total + insertAt : insertAt, 0), total)
        : total - wire.length
      return Array.from({ length: wire.length }, (_unused, index) => at + index)
    },

    /**
     * Upstream's chat-delete member, over the same arm the journal replay
     * uses. Takes one id or a list; upstream removes in one pass against the
     * caller's snapshot, and so does the host arm (`script.deleteChatMessages`
     * resolves the batch against one array — the two orderings agree for a
     * caller holding the whole set).
     * @param messageIds - an id or a list of ids, as upstream takes them.
     * @returns the ids that were removed.
     */
    deleteChatMessages: async (messageIds: number | readonly number[]): Promise<number[]> => {
      const ids = Array.isArray(messageIds) ? [...messageIds] : [messageIds]
      for (const id of ids) {
        if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
          throw new UnsupportedApiError(
            'deleteChatMessages(ids)',
            'every id must be a non-negative integer message id',
          )
        }
      }
      await host.call('deleteChatMessages', { messageIds: ids })
      return ids
    },

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

    // —— family②: regex ——
    /**
     * One tier of regex rules, or — in upstream's older spelling — global and
     * card concatenated.
     *
     * **Both call shapes, because upstream still answers both.** Its
     * `getTavernRegexes(option?)` branches on `option?.type === undefined`
     * (`src/function/tavern_regex.ts:209-242`): a `type` names one tier, and
     * anything else is the deprecated `{scope, enable_state}` form, which reads
     * global then card, tags each row with `scope`, and filters by
     * enabled-state. The two error strings are upstream's own, character for
     * character, because a card that catches one and reads its text is reading
     * that text.
     *
     * The legacy form is where the **tier order** is visible in one answer:
     * global rows first, then the card's. Note that it omits the preset tier
     * entirely — which upstream's own legacy branch does too, even though the
     * preset's rules run *between* those two.
     *
     * **A promise, where upstream returns an array.** This is the family's one
     * departure and it is measured, not chosen for convenience: see
     * `CARD_METHODS`. A card that awaits — which every card in this family's
     * own examples does, since the write half is async upstream too — is
     * unaffected; one that treats the answer as an array immediately gets a
     * `TypeError` on the frame's own answer rather than silence.
     * @param option - upstream's tier option, or its deprecated scope form.
     * @returns the rules, in the tier's stored order.
     */
    getTavernRegexes: async (option?: Record<string, unknown>): Promise<TavernRegexRow[]> => {
      return readTavernRegexes(option)
    },

    /**
     * Replace one tier wholesale.
     *
     * Upstream's `replaceTavernRegexes(regexes, option)`, and wholesale is the
     * word: a rule absent from the array is deleted. The **deprecated** form is
     * answered too — with no `type`, upstream partitions the array by each
     * row's own `scope` field and writes global and card separately
     * (`src/function/tavern_regex.ts:267-291`), which is what a card holding
     * the legacy read's output does next, so the two halves have to agree.
     *
     * Accepted and ignored where upstream would repaint: it reloads every
     * message to re-run the rules (`render_tavern_regexes_debounced`), and the
     * host announces the changed chat itself.
     * @param regexes - the tier's new contents.
     * @param option - upstream's tier option, or its deprecated scope form.
     * @returns nothing, matching upstream's `Promise<void>`.
     */
    replaceTavernRegexes: async (
      regexes: readonly Record<string, unknown>[],
      option?: Record<string, unknown>,
    ): Promise<void> => {
      await writeTavernRegexes(regexes, option)
    },

    /**
     * Read a tier, let the card rewrite it, and store the result.
     *
     * Built in the frame rather than sent over the wire, for the reason
     * `updateWorldbookWith` is: it takes a **function**, and a function cannot
     * cross the boundary. So it is composed from the two members above, which
     * is also how upstream composes it
     * (`src/function/tavern_regex.ts:335-343`: get, updater, replace, return).
     *
     * The updater may be synchronous or async — upstream's `TavernRegexUpdater`
     * is a union of both — and what it returns is passed through whole. Upstream
     * returns the array the updater produced; this returns **what the host
     * stored**, which differs wherever a blank name was filled in or an unnamed
     * field was carried across, and those are exactly the changes a card cannot
     * otherwise see. Web ledger §88.
     * @param updater - given the tier's rules, returns the new ones.
     * @param option - upstream's tier option, or its deprecated scope form.
     * @returns the tier as it stands after the write.
     */
    updateTavernRegexesWith: async (
      updater: (
        regexes: TavernRegexRow[],
      ) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>,
      option?: Record<string, unknown>,
    ): Promise<TavernRegexRow[]> => {
      // Composed from the same two locals the members above delegate to, not
      // from the published surface: reaching a sibling through the returned
      // object would break the first time a card destructured this API, which
      // is how cards routinely import it.
      const next = await updater(await readTavernRegexes(option))
      await writeTavernRegexes(next, option)
      return await readTavernRegexes(option)
    },

    /**
     * Whether the character being played may run its own regex tier.
     *
     * Upstream's `isCharacterTavernRegexesEnabled()` is synchronous and reads
     * `extension_settings.character_allowed_regex.includes(characters[this_chid].avatar)`
     * (`src/function/tavern_regex.ts:196-200`) — so this reads the snapshot,
     * the same way `getCharWorldbookNames` and `getLorebookSettings` do, and it
     * is one boolean rather than a tier's worth of bodies.
     *
     * **Absent reads as allowed**, which is this host's own default for the
     * card tier and a deliberate divergence from upstream's (§30): there a card
     * must be added to the allow-list, here it is allowed until refused. So a
     * card asking this on a fresh install gets `true` here and `false` there.
     * @returns whether the tier may run.
     */
    isCharacterTavernRegexesEnabled: (): boolean =>
      snapshot('isCharacterTavernRegexesEnabled').characterRegexAllowed !== false,

    /**
     * Apply this chat's regex chain to a string.
     *
     * Upstream's `formatAsTavernRegexedString(text, source, destination, {depth,
     * character_name})`, answered by the host because that is where the rules
     * are — and the by-product is worth more than the round trip costs: the
     * chain is `entry.scripts`, the very list that produced the text on the
     * page and the text in the last request, so the three cannot disagree.
     *
     * **A promise, where upstream returns a string** — the family's one
     * departure, measured in `CARD_METHODS`.
     *
     * Upstream's third step, the `registerMacroLike` macros, has nothing to run
     * here: this host has no such member, so a card that registered one
     * upstream gets its text back with that one macro unexpanded. Reported once
     * per frame rather than silently, because text handed back unchanged and
     * text a step never touched are indistinguishable — the same rule
     * `substitudeMacros` above keeps.
     * @param text - the string to rewrite.
     * @param source - which of upstream's five sources this text is.
     * @param destination - `'display'` or `'prompt'`.
     * @param option - upstream's `{depth, character_name}`.
     * @returns the rewritten string.
     */
    formatAsTavernRegexedString: async (
      text: string,
      source: string,
      destination: string,
      option?: { depth?: number, character_name?: string },
    ): Promise<string> => {
      if (!TAVERN_REGEX_SOURCES.includes(source as TavernRegexSource)) {
        throw new UnsupportedApiError(
          `formatAsTavernRegexedString(…, '${String(source)}', …)`,
          `the source must be one of ${TAVERN_REGEX_SOURCES.join(', ')}`,
        )
      }
      if (destination !== 'display' && destination !== 'prompt') {
        throw new UnsupportedApiError(
          `formatAsTavernRegexedString(…, '${String(destination)}')`,
          "the destination must be 'display' or 'prompt'",
        )
      }
      const answer = await host.call('formatAsTavernRegexedString', {
        text,
        source,
        destination,
        ...typeof option?.depth === 'number' ? { depth: option.depth } : {},
        ...typeof option?.character_name === 'string' ? { characterName: option.character_name } : {},
      })
      return (answer as { text?: string } | undefined)?.text ?? text
    },

    // —— family④: lorebook / worldbook ——
    /*
     * The four `Worldbook` writes the family was missing, and then the whole
     * `Lorebook` vocabulary they were renamed from.
     *
     * **Why the old names are built at all**, since every one of them is
     * `@deprecated` upstream and the surface audit measured zero calls in
     * either corpus: the corpus is 19 cards and one sample, the names were
     * upstream's *only* spelling until 4.x, and a card that predates the rename
     * reaches them as `undefined` — which for `getCharLorebooks().primary` is a
     * `TypeError` in the card's own first statement. `@deprecated` is upstream
     * telling authors what to write next, not a statement that the member has
     * stopped working; it still works there, so it has to work here. The audit's
     * "don't build" is recorded as overturned in DEVIATIONS §90 rather than
     * quietly ignored.
     */

    /**
     * Create the book, or replace it if it is already there.
     *
     * Upstream's `createOrReplaceWorldbook` (`worldbook.ts:377`) and the answer
     * is the same one: `true` when it created, `false` when it replaced.
     *
     * Composed from the two host arms rather than a third: `worldbook.create`
     * already takes the entries, so an absent book is one call, and an existing
     * one is that call answering `created: false` followed by the replace.
     * Upstream skips the save for a *new* book with no entries, which this gets
     * for free — creating with an empty array writes an empty book either way.
     *
     * One deliberate difference: a creation that fails for a reason other than
     * "already there" **rejects** here, where upstream returns `false`. The two
     * outcomes upstream folds together — "I replaced it" and "I could not make
     * it" — are the ones a card most needs apart.
     * @param name - the book's name.
     * @param worldbook - the whole contents; absent means an empty book.
     * @param _options - upstream's `{ render }`, accepted and ignored.
     * @returns whether the book was created rather than replaced.
     */
    createOrReplaceWorldbook: async (
      name: string,
      worldbook: readonly unknown[] = [],
      _options?: { render?: 'debounced' | 'immediate' | 'none' },
    ): Promise<boolean> => {
      if (await createBook(name, worldbook)) return true
      await host.call('replaceWorldbook', {
        name,
        entries: worldbook.map(entry => flattenWorldbookEntry(entry)),
      })
      return false
    },

    /**
     * Delete a book, file and all.
     *
     * `false` means there was no such book, which is upstream's answer rather
     * than an error (`deleteWorldInfo` returns `false` for a name not in
     * `world_names`). The host drops the name from the global selection and
     * leaves every other binding dangling, as upstream does — and pushes a
     * report saying which, because the file is gone and nothing else will
     * remember.
     * @param name - the book's name.
     * @returns whether a book was there to delete.
     */
    deleteWorldbook: async (name: string): Promise<boolean> => deleteBook(name),

    /**
     * Delete the entries a predicate picks out.
     *
     * Built in the frame for the reason `updateWorldbookWith` is: the predicate
     * is a **function**, and a function cannot cross the boundary. The entries
     * it is shown are the revived ones `getWorldbook` returns, so a predicate
     * testing `entry.strategy.keys[0] instanceof RegExp` sees what it would see
     * upstream.
     *
     * `deleted_entries` are the entries **as read**, not as re-read — they no
     * longer exist to be read. `worldbook` is the re-read, because the host
     * renumbers what it kept.
     * @param name - the book's name.
     * @param predicate - true for an entry to delete.
     * @param options - upstream's `{ render }`, passed to the write.
     * @returns the book as stored, and what was removed.
     */
    deleteWorldbookEntries: async (
      name: string,
      predicate: (entry: CardWorldbookEntry) => boolean,
      options?: { render?: 'debounced' | 'immediate' },
    ): Promise<{ worldbook: CardWorldbookEntry[], deleted_entries: CardWorldbookEntry[] }> => {
      const current = await readWorldbook(name)
      const deletedEntries: CardWorldbookEntry[] = []
      const kept = current.filter((entry) => {
        if (!predicate(entry)) return true
        deletedEntries.push(entry)
        return false
      })
      const answer = await host.call('replaceWorldbook', {
        name,
        entries: kept.map(entry => flattenWorldbookEntry(entry)),
        ...(options?.render === undefined ? {} : { render: options.render }),
      })
      const stored = (answer as { entries?: WorldbookEntry[] } | undefined)?.entries ?? []
      return { worldbook: stored.map(entry => reviveWorldbookKeys(entry)), deleted_entries: deletedEntries }
    },

    /**
     * Rebind a character's world books.
     *
     * Upstream refuses a character other than `'current'` by name
     * (`worldbook.ts:54`) and so does this. The **primary** binding is refused
     * as well when it would change: it lives inside the card file, and this host
     * has no arm that writes one — see `rebindCharBooks`, which both spellings
     * of this write go through.
     * @param characterName - upstream's parameter; only `'current'` is served.
     * @param charWorldbooks - the bindings to install.
     */
    rebindCharWorldbooks: async (
      characterName: 'current',
      charWorldbooks: { primary?: string | null, additional?: readonly string[] },
    ): Promise<void> => rebindCharBooks('rebindCharWorldbooks', characterName, charWorldbooks),

    /** Upstream's old name for `getWorldbookNames`, and the same list. */
    getLorebooks: (): string[] => [...(snapshot('getLorebooks').worldbookNames ?? [])],

    /** Upstream's old name for `createWorldbook`, which took no entries. */
    createLorebook: async (lorebook: string): Promise<boolean> => createBook(lorebook),

    /** Upstream's old name for `deleteWorldbook`. */
    deleteLorebook: async (lorebook: string): Promise<boolean> => deleteBook(lorebook),

    /**
     * Upstream's old name for `getCharWorldbookNames`, with its option bag.
     *
     * **`type` is accepted and ignored, because upstream ignores it too.** The
     * declaration offers `{name, type: 'all' | 'primary' | 'additional'}`
     * (`lorebook.d.ts:40`) and the implementation destructures `{name}` alone
     * (`lorebook.ts:219`) — so a card asking for `type: 'primary'` gets both
     * lists there as well. Filtering here would be an improvement that makes a
     * card behave differently on the two hosts, which is the one kind of
     * improvement this surface may not make.
     * @param option - upstream's bag; `name` defaults to `'current'`.
     * @returns the primary binding and any additional ones.
     */
    getCharLorebooks: (option?: { name?: string, type?: string }): {
      primary: string | null
      additional: string[]
    } => charBookNames('getCharLorebooks', option?.name ?? 'current'),

    /** Upstream's `getCharLorebooks().primary`, spelled as its own member. */
    getCurrentCharPrimaryLorebook: (): string | null =>
      charBookNames('getCurrentCharPrimaryLorebook', 'current').primary,

    /** Upstream's old name for `rebindCharWorldbooks`, over the same local. */
    setCurrentCharLorebooks: async (
      lorebooks: { primary?: string | null, additional?: readonly string[] },
    ): Promise<void> => rebindCharBooks('setCurrentCharLorebooks', 'current', lorebooks),

    /**
     * Upstream's old name for `getChatWorldbookName`.
     *
     * Upstream throws here when no chat is open (`lorebook.ts:313`). That
     * branch has no equivalent: a frame exists inside an open chat, so the
     * refusal it would raise could only fire on a snapshot that has not
     * arrived — which every member already answers with its own named
     * refusal, through `snapshot`.
     */
    getChatLorebook: (): string | null => chatBookName('getChatLorebook'),

    /** Upstream's old name for `rebindChatWorldbook`; `null` unbinds. */
    setChatLorebook: async (lorebook: string | null): Promise<void> => bindChatBook(lorebook),

    /** Upstream's old name for `getOrCreateChatWorldbook`, minus the chat name. */
    getOrCreateChatLorebook: async (lorebook?: string): Promise<string> =>
      getOrCreateChatBook('getOrCreateChatLorebook', lorebook),

    /**
     * Write the world-info settings a card can read with `getLorebookSettings`.
     *
     * **Synchronous and `void`, because upstream's is** — one of MVU's two call
     * sites does not await it, and a `Promise` returned here would be a value
     * that site never looks at. So the validation happens synchronously, before
     * anything is sent, and the writes are fired with their failures reported
     * rather than thrown: an asynchronous throw from a member declared `void`
     * arrives as an unhandled rejection with no card frame in the stack, which
     * is the precedent `writeButtons` set for exactly this shape.
     *
     * Upstream's two acts, in its order: refuse the whole call when the global
     * selection names a book that does not exist (`lorebook.ts:191`, one throw
     * carrying every missing name), then apply only the fields that differ from
     * what is already set (`:198`).
     *
     * `overflow_alert` has nowhere to land on this host and is reported as a gap
     * instead of being accepted — see `lorebookSettingsPatch`.
     * @param settings - any subset of the sixteen fields.
     */
    setLorebookSettings: (settings: Partial<LorebookSettings>): void => {
      const member = 'setLorebookSettings'
      const context = snapshot(member)

      if (settings.selected_global_lorebooks !== undefined) {
        const known = context.worldbookNames ?? []
        const missing = settings.selected_global_lorebooks.filter(name => !known.includes(name))
        if (missing.length > 0) {
          // Upstream's own shape: the whole call fails, and the message carries
          // every missing name rather than the first — a card fixing them one
          // rejection at a time is a card in a loop.
          throw new Error(
            `${member}: tried to set the globally enabled world books, but these do not exist:`
            + ` ${JSON.stringify(missing)}`,
          )
        }
      }

      const { patch, globalSelect, unstored } = lorebookSettingsPatch(settings, context.lorebookSettings)
      for (const field of unstored) {
        host.reportGap(
          `a card set ${field} through setLorebookSettings and this host stores no such knob —`
          + ' the value was not kept, which is not a statement that it was applied',
        )
      }

      const failed = (error: unknown): void => {
        host.reportFault(
          `card called ${member} and the write was refused: `
          + (error instanceof Error ? error.message : String(error)),
        )
      }
      if (Object.keys(patch).length > 0) void host.call('setLorebookSettings', patch).then(undefined, failed)
      if (globalSelect !== undefined) {
        void host.call('rebindGlobalWorldbooks', { names: globalSelect }).then(undefined, failed)
      }
    },

    /**
     * One book's entries in the old vocabulary, with upstream's `filter` option.
     *
     * The whole book is read and filtered **in the frame**, as upstream does:
     * the filter is a set of field expectations rather than a query the host
     * could serve, and its three rules (subset for arrays, *substring* for
     * strings, equality otherwise) are the kind of thing a second
     * implementation would get subtly wrong.
     * @param lorebook - the book's name; a missing book rejects, as upstream's does.
     * @param option - upstream's bag; `filter` defaults to `'none'`.
     * @returns its entries, in the book's own order.
     */
    getLorebookEntries: async (
      lorebook: string,
      option?: { filter?: 'none' | Partial<CardLorebookEntry> },
    ): Promise<CardLorebookEntry[]> => {
      const entries = await readLorebook(lorebook)
      const filter = option?.filter ?? 'none'
      if (filter === 'none') return entries
      return entries.filter(entry => matchesLorebookFilter(entry, filter))
    },

    /**
     * Replace a book's contents with entries in the old vocabulary.
     *
     * Wholesale, and with the **old** defaults for absent fields — an entry
     * given as `{uid: 0}` becomes a `selective` entry here and a `constant`
     * (always-on) one through `replaceWorldbook`. That difference is upstream's
     * and is the reason this vocabulary has its own write leg rather than
     * forwarding to the new one.
     * @param lorebook - the book's name.
     * @param entries - the new contents; every field may be absent.
     */
    replaceLorebookEntries: async (
      lorebook: string,
      entries: readonly Partial<CardLorebookEntry>[],
    ): Promise<void> => {
      await replaceLorebook(lorebook, entries)
    },

    /**
     * Read a book, let the card rewrite it, and store the result.
     *
     * Upstream's `updateLorebookEntriesWith` — the member every other old write
     * is built on (`lorebook_entry.ts:361`), which is why it is here even
     * though it was not on this branch's list of names: leaving it out would
     * make the old vocabulary five sixths complete, with the missing sixth the
     * one whose siblings are all compositions of it.
     * @param lorebook - the book's name.
     * @param updater - given the current entries, returns the new ones.
     * @returns the book as stored afterwards.
     */
    updateLorebookEntriesWith: async (
      lorebook: string,
      updater: (
        entries: CardLorebookEntry[],
      ) => readonly Partial<CardLorebookEntry>[] | Promise<readonly Partial<CardLorebookEntry>[]>,
    ): Promise<CardLorebookEntry[]> =>
      replaceLorebook(lorebook, await updater(await readLorebook(lorebook))),

    /**
     * Patch entries by uid, leaving the rest of the book alone.
     *
     * Upstream merges each patch into the entry with that uid and **ignores a
     * uid the book does not have** (`lorebook_entry.ts:375`, a `find` with no
     * else). The merge is lodash's, which for this shape means index-wise for
     * the two key lists — see `mergeLorebookEntry`, where the rule and the
     * reason a spread is wrong are written down.
     * @param lorebook - the book's name.
     * @param entries - each carrying the `uid` it patches.
     * @returns the whole book as stored afterwards.
     */
    setLorebookEntries: async (
      lorebook: string,
      entries: readonly (Partial<CardLorebookEntry> & { uid: number })[],
    ): Promise<CardLorebookEntry[]> => {
      const current = await readLorebook(lorebook)
      const next = current.map((entry) => {
        const patch = entries.find(row => row.uid === entry.uid)
        return patch === undefined ? entry : mergeLorebookEntry(entry, patch)
      })
      return replaceLorebook(lorebook, next)
    },

    /**
     * Append entries, and say which uids they were given.
     *
     * Upstream assigns the **lowest free** uid to each new entry
     * (`lorebook_entry.ts:391`) — not the random one its replace path uses —
     * and `new_uids` is what a card holds on to in order to find its own
     * entries again, so the numbers have to be the ones that were stored.
     *
     * One deliberate difference: upstream writes the uid onto the caller's own
     * objects (`entries.forEach(entry => (entry.uid = …))`). Copies are made
     * here instead. Mutating a card's argument is not behaviour worth copying,
     * and this surface already hands back copies everywhere else.
     * @param lorebook - the book's name.
     * @param entries - the entries to append.
     * @returns the whole book as stored, and the new uids in append order.
     */
    createLorebookEntries: async (
      lorebook: string,
      entries: readonly Partial<CardLorebookEntry>[],
    ): Promise<{ entries: CardLorebookEntry[], new_uids: number[] }> => {
      const current = await readLorebook(lorebook)
      const taken = new Set(current.map(entry => entry.uid))
      const newUids: number[] = []
      const appended = entries.map((entry) => {
        let uid = 0
        while (taken.has(uid)) uid += 1
        taken.add(uid)
        newUids.push(uid)
        return { ...entry, uid }
      })
      return { entries: await replaceLorebook(lorebook, [...current, ...appended]), new_uids: newUids }
    },

    /**
     * Delete entries by uid.
     *
     * `delete_occurred` answers whether any of the uids was there, which is the
     * only way a card learns that it asked about entries the book does not
     * hold — the book comes back either way.
     *
     * **The write happens even when nothing matched**, which is upstream's
     * behaviour rather than an oversight: it routes through
     * `updateLorebookEntriesWith` unconditionally. It is not free — a write
     * through this vocabulary rebuilds every entry from the old defaults, so
     * the four fields the old shape has no name for (`outletName`, `triggers`,
     * `characterFilter`, `ignoreBudget`) are reset across the whole book.
     * Upstream loses exactly the same four, for the same reason, on any write
     * through the old API.
     * @param lorebook - the book's name.
     * @param uids - the uids to remove.
     * @returns the whole book as stored, and whether anything was removed.
     */
    deleteLorebookEntries: async (
      lorebook: string,
      uids: readonly number[],
    ): Promise<{ entries: CardLorebookEntry[], delete_occurred: boolean }> => {
      const current = await readLorebook(lorebook)
      const kept = current.filter(entry => !uids.includes(entry.uid))
      return {
        entries: await replaceLorebook(lorebook, kept),
        delete_occurred: kept.length !== current.length,
      }
    },

    // —— family①: identity & messages ——
    /**
     * Every card in the library, by name.
     *
     * Synchronous, because upstream is: `characters.map(c => c.name)` off the
     * page (`JS-Slash-Runner/src/function/character.ts:52`). The snapshot
     * already carries the whole library as summaries — a card that offers to
     * reference another one reads them — so this is a projection of data the
     * frame has, not a new exposure.
     * @returns the names, in the host's order.
     */
    getCharacterNames: (): string[] =>
      snapshot('getCharacterNames').characters.map(summary => summary.name),
    /**
     * Every card in the library, by id.
     *
     * **Upstream's ids are avatar file names** (`character.avatar`, a
     * `foo.png`), because on SillyTavern the picture is the identity. Here they
     * are the host's `characterId`, which is what every other Iris surface
     * names a card by and what `getCharacter`, `getCharData` and
     * `getCharAvatarPath` accept. Index-parallel to `getCharacterNames()`, as
     * upstream's two are.
     *
     * A card that appends one of these to `/characters/` — upstream's own path
     * — gets nothing, and could not have got anything: this host serves avatars
     * from its own endpoint, which `getCharAvatarPath` answers with.
     * @returns the ids, in the host's order.
     */
    getCharacterIds: (): string[] =>
      snapshot('getCharacterIds').characters.map(summary => summary.characterId),
    /**
     * The played character's name, or `null`.
     *
     * Upstream reads `name2` and turns the empty string into `null`
     * (`character.ts:63`), which is the distinction a card checks — so the
     * empty string is not passed through.
     * @returns the name, or null when no card is being played.
     */
    getCurrentCharacterName: (): string | null => {
      const name = snapshot('getCurrentCharacterName').name2
      return name === '' ? null : name
    },
    /**
     * The played character's id, or `null`.
     *
     * Upstream answers `RawCharacter.find({name:'current'})?.avatar ?? null`
     * (`character.ts:70`) — the avatar file name again. This answers the host's
     * `characterId`, for the reason `getCharacterIds` gives.
     * @returns the id, or null when no card is being played.
     */
    getCurrentCharacterId: (): string | null =>
      snapshot('getCurrentCharacterId').characterId ?? null,
    /**
     * Where a card's picture is served from, or `null`.
     *
     * Upstream returns `'/characters/' + <thumbnail file>`
     * (`function/raw_character.ts:197-214`) — a path on SillyTavern's own
     * server. **This answers Iris's own avatar endpoint** (`/iris/avatar/<id>`,
     * as `CharacterSummary.avatarUrl` carries it) and never a filesystem path:
     * the host's card files live outside the browser's reach, and handing a
     * card an absolute path would leak the shape of the machine to no purpose.
     * A card that puts the answer in `url(...)` — which is what upstream's own
     * interface frames do with this member, injecting
     * `.char_avatar{background-image:url(...)}` into every message frame — gets
     * a picture either way.
     *
     * `null` for a card that has no picture at all (a `.json` card), which is a
     * different fact from a card that is not there; both are `null` upstream
     * too, so the report says which one happened.
     * @param name - `'current'`, or a card by id or name.
     * @returns the URL, or null.
     */
    getCharAvatarPath: (name?: string): string | null => {
      const summary = characterFor(snapshot('getCharAvatarPath'), name)
      if (summary === undefined) return null
      if (summary.avatarUrl === undefined) {
        reportOnce(
          'avatar-missing',
          `a card asked for ${summary.name}'s avatar path and that card carries no picture`
            + ' — null here means "no image", not "no such card"',
        )
        return null
      }
      return summary.avatarUrl
    },
    /**
     * The played card's raw data, as much of it as the snapshot carries.
     *
     * **Synchronous upstream** (`raw_character.ts:181`, returning
     * `characters[index]` — SillyTavern's own storage object), so it can only be
     * answered from the pushed snapshot, and the snapshot deliberately carries
     * one card's `data.character_book` plus every card's summary rather than
     * whole cards: a card costs a median of 494 KiB and up to 2.8 MiB, times
     * every live frame, every turn. `CharacterSummary.data` records that
     * measurement and the one corpus call site it was made for —
     * `charData.data && charData.data.character_book && ...entries`, which this
     * answers.
     *
     * **What it does not carry, and why that is said out loud rather than
     * filled in.** `description`, `first_mes`, `personality`, `scenario` and
     * `mes_example` are absent. The summary's `description` is *clipped to 200
     * code points*, and serving a clip under the field's own name would be the
     * quietest possible wrong answer — a card would put two hundred characters
     * of a two-thousand-character description into a prompt and nothing would
     * say so. The whole card is one `await getCharacter('current')` away, and
     * the report says that.
     *
     * `null` for any other card, which is upstream's own answer for a card it
     * cannot find. Here it means the snapshot carries only this conversation's
     * card, and the report says so rather than letting a card conclude the
     * library is empty.
     * @param name - `'current'`, or the played card by id or name.
     * @returns the card data, or null.
     */
    getCharData: (name?: string): Record<string, unknown> | null => {
      const context = snapshot('getCharData')
      const current = context.characterId
      const summary = characterFor(context, name)
      if (summary === undefined || current === undefined || summary.characterId !== current) {
        if (summary !== undefined) {
          reportOnce(
            'chardata-foreign',
            `a card asked for ${summary.name}'s card data and got null: the snapshot carries card`
              + ' data for this conversation\'s own card only, so null here is a limit in Iris'
              + ' rather than a claim that the card does not exist',
          )
        }
        return null
      }
      reportOnce(
        'chardata-partial',
        'a card read getCharData and this frame answered from the pushed snapshot, which carries'
          + ' name, id, tags, creator, the embedded character_book and the bound book name —'
          + ' description, first_mes, personality, scenario and mes_example are absent, not empty;'
          + ' await getCharacter(\'current\') for the whole card',
      )
      const book = summary.data?.character_book
      return {
        name: summary.name,
        // Upstream's `avatar` is the picture's file name; here it is the id, as
        // `getCharacterIds` explains.
        avatar: summary.characterId,
        tags: [...summary.tags],
        data: {
          name: summary.name,
          tags: [...summary.tags],
          creator: summary.creator ?? '',
          ...book === undefined ? {} : { character_book: book },
          // Upstream's `RawCharacter.getWorldName()` reads exactly this key.
          extensions: { world: context.charWorldbooks?.primary ?? '' },
        },
      }
    },
    /**
     * One whole card, projected as upstream projects it.
     *
     * Asynchronous upstream too (`character.ts:240`, which awaits
     * `unshallowCharacter` before reading), so the round trip costs no
     * compatibility. It carries the card's `extensions` — its regexes and its
     * script bodies — which is why it is a call a card makes once rather than a
     * snapshot field every frame pays for every turn.
     *
     * **Only this conversation's own card.** Upstream takes any name in the
     * library; the host refuses a fourth spelling, because a card script is
     * consented to per card and this member would otherwise let one card's
     * grant read a neighbour's code. The rejection names the narrowing, and
     * upstream throws for an unknown name too, so the shape a card handles is
     * the same one.
     * @param name - `'current'`, or this conversation's card by id or name.
     * @returns the card, projected.
     * @throws when the name is not this conversation's card.
     */
    getCharacter: async (name?: string): Promise<Record<string, unknown>> => {
      const answer = await host.call('getCharacter', { name: name === undefined ? 'current' : name })
      return (answer as { character?: Record<string, unknown> } | undefined)?.character ?? {}
    },

    /**
     * Every persona this profile has, by name.
     *
     * Synchronous upstream (`function/persona.ts:53`, mapping
     * `power_user.personas`), so it answers from the snapshot's `personas`
     * field. **A missing field and an empty list are different answers**: no
     * persona store on this host reports a gap and answers `[]`; a store with
     * nothing in it answers `[]` in silence, which is upstream's answer for the
     * same state.
     * @returns the names, in the host's order.
     */
    getPersonaNames: (): string[] => personaRows('getPersonaNames').map(row => row.name),
    /**
     * Every persona this profile has, by id.
     *
     * Upstream's ids are avatar file names (`persona.ts:60`, the keys of
     * `power_user.personas`); Iris's are the persona store's own opaque ids,
     * because this host keeps no persona avatar files at all — see
     * `getPersonaAvatarPath`. Index-parallel to `getPersonaNames()`.
     * @returns the ids, in the host's order.
     */
    getPersonaIds: (): string[] => personaRows('getPersonaIds').map(row => row.id),
    /**
     * The selected persona's name, or `null`.
     *
     * The **selection**, not the prompt: this host's persona store treats an
     * empty description as no persona for assembly purposes
     * (`persona.ts:263`), and applying that rule here would answer `null` for a
     * persona the user can see selected in the panel. Upstream reads
     * `power_user.personas[user_avatar]`, which is the selection.
     *
     * Not `name1`. That field is the user name the **chat file** records, which
     * is what upstream's `name1` is too — a persona rename does not rewrite old
     * chat files, so the two can honestly disagree, and this member is about
     * the persona.
     * @returns the name, or null when no persona is selected.
     */
    getCurrentPersonaName: (): string | null =>
      snapshot('getCurrentPersonaName').persona?.name ?? null,
    /**
     * The selected persona's id, or `null`.
     * @returns the id, or null when no persona is selected.
     */
    getCurrentPersonaId: (): string | null =>
      snapshot('getCurrentPersonaId').persona?.id ?? null,
    /**
     * Where a persona's picture is served from — always `null` here.
     *
     * Upstream answers `./User Avatars/<avatar id>` (`persona.ts:302`), because
     * on SillyTavern a persona *is* an avatar file: the file name is the
     * identity. **This host has no persona avatars at all** — the store's own
     * note says so, and the persona a card can see has an id, a name and a
     * description and no picture anywhere.
     *
     * So the answer is `null`, which is a value upstream also returns (for a
     * persona it cannot resolve), reported once so that "Iris has no persona
     * pictures" does not read as "that persona does not exist". Inventing a URL
     * would be worse in the exact way a plausible answer always is: the card
     * would put it in an `<img src>` and show a broken image with nothing
     * anywhere saying why.
     * @param _personaId - accepted and unused; there is no file to name.
     * @returns null, always.
     */
    getPersonaAvatarPath: (_personaId?: string): null => {
      reportOnce(
        'persona-avatar',
        'a card asked for a persona avatar path and this host keeps no persona pictures —'
          + ' null here means Iris has no such file to name, not that the persona is missing',
      )
      return null
    },
    /**
     * One persona in full — the selected one.
     *
     * Synchronous upstream (`persona.ts:310`) and it **throws** when the id is
     * unknown or the name is not unique, so throwing is a shape the caller
     * already handles. Two things throw here: an id nothing matches (upstream's
     * own case) and an id that names a persona the snapshot carries no content
     * for, which is every persona except the selected one. The second is Iris's
     * narrowing and the message says so: carrying every persona's description
     * would hand a card the user's other alter egos' prompt text, for which no
     * corpus card has ever asked.
     *
     * The shape is upstream's `Persona`, and four of its fields are honest
     * placeholders rather than data: `title`, `lorebook` and `connections` are
     * concepts this host does not have, and `is_default` is `false` because
     * Iris has one selected persona and no separate default — so `false` means
     * "there is no such notion here", not "this persona is not the default".
     * `avatar` is **absent**, for the reason `getPersonaAvatarPath` returns
     * null. `position` and `role` are translated back into SillyTavern's own
     * numbers, because a card reads them as numbers.
     * @param personaId - `'current'`, or the selected persona by id or name.
     * @returns the persona.
     * @throws {UnsupportedApiError} when it is not the selected persona.
     */
    getPersona: (personaId?: string): Record<string, unknown> => {
      const context = snapshot('getPersona')
      const active = context.persona
      const asked = personaId === undefined || personaId === '' ? 'current' : personaId
      const wanted = asked.toLowerCase()
      if (active === undefined) {
        throw new UnsupportedApiError(
          'getPersona',
          `no persona is selected in this conversation, so there is none to answer with for "${asked}".`,
        )
      }
      if (wanted !== 'current' && wanted !== active.id.toLowerCase() && wanted !== active.name.toLowerCase()) {
        const known = personaRows('getPersona').some(
          row => row.id.toLowerCase() === wanted || row.name.toLowerCase() === wanted,
        )
        throw new UnsupportedApiError(
          'getPersona',
          known
            ? `persona "${asked}" exists but its content does not travel to this frame: the snapshot`
              + ' carries the selected persona only.' + LIMIT_NOT_YOUR_FAULT
            : `persona "${asked}" does not exist or its name is not unique.`,
        )
      }
      return {
        avatar_id: active.id,
        name: active.name,
        title: '',
        description: active.description,
        position: PERSONA_POSITIONS[active.position],
        depth: active.depth ?? UPSTREAM_PERSONA_DEPTH,
        role: active.role === undefined ? UPSTREAM_PERSONA_ROLE : PERSONA_ROLES[active.role],
        lorebook: '',
        connections: [],
        is_default: false,
      }
    },

    /**
     * This frame's own name, in upstream's spelling.
     *
     * Upstream builds it from the iframe element's id — `TH-message--<floor>--<n>`
     * for an interface, `TH-script--<name>--<id>` for a script
     * (`iframe/util.d.ts:35`, `function/util.ts:74`) — and it exists to be an
     * event-registration key and to be handed to `getMessageId`. Here each frame
     * has its own bus, so nothing keys off it; what a card does with it is parse
     * the floor out, or print it.
     *
     * **The trailing number of a message frame's name is `0`, and that is a
     * placeholder.** Upstream's own number means different things on its two
     * render paths and upstream never parses it — `getMessageId`'s regex takes
     * only the floor — while Iris's frames carry an opaque instance identity
     * the member table cannot see. So it is reported once rather than
     * fabricated out of something that looks like an index.
     * @returns the name.
     * @throws {UnsupportedApiError} in a frame that is neither.
     */
    getIframeName: (): string => {
      const script = host.scriptId()
      if (script !== undefined) {
        return `TH-script--${scriptRow('getIframeName', script)?.name ?? ''}--${script}`
      }
      const floor = host.currentMessageId?.()
      if (floor !== undefined) {
        reportOnce(
          'iframe-name-instance',
          `a card read getIframeName in a message frame and got TH-message--${String(floor)}--0:`
            + ' the trailing number is a placeholder, since this frame carries no index of its own,'
            + ' and upstream\'s readers of this name parse only the floor',
        )
        return `TH-message--${String(floor)}--0`
      }
      throw new UnsupportedApiError(
        'getIframeName',
        'this frame is neither a card script nor a message interface, so it has no Tavern Helper name.',
      )
    },
    /**
     * The floor an interface frame's name belongs to.
     *
     * A pure function upstream (`function/util.ts:109-115`) and a pure function
     * here — the same pattern, including the optional `_n` suffix upstream's
     * second render path appends, and the same throw for a script frame's name,
     * which upstream words as "do not call getMessageId on a global script
     * iframe".
     * @param iframeName - a name from `getIframeName()`.
     * @returns the floor.
     * @throws {UnsupportedApiError} when the name is not an interface frame's.
     */
    getMessageId: (iframeName: string): number => {
      const match = MESSAGE_FRAME_NAME.exec(String(iframeName))
      const floor = match?.[1]
      if (floor === undefined) {
        throw new UnsupportedApiError(
          'getMessageId',
          `"${String(iframeName)}" is not a message interface's frame name, so it belongs to no`
            + ' floor — upstream throws here too, and says not to call this on a script frame.',
        )
      }
      return Number.parseInt(floor, 10)
    },
    /**
     * The calling script's name.
     *
     * Synchronous upstream, off the runtime store (`function/script.ts:125`),
     * and `''` when the store has no such script — a real upstream answer,
     * which is why an absent name here answers the same way rather than
     * throwing. It reads the snapshot's `scripts` table, which the host builds
     * out of the one listing the panel and the runner share, so the name a card
     * prints is the name the user sees.
     * @returns the name, or `''`.
     */
    getScriptName: (): string => {
      const script = host.scriptId()
      return script === undefined ? '' : scriptRow('getScriptName', script)?.name ?? ''
    },
    /**
     * The calling script's author note.
     *
     * Upstream's `script.info` (`function/script.ts:134`), `''` when unknown for
     * the reason `getScriptName` answers `''`. A `replaceScriptInfo` in this
     * frame's lifetime is read back here, so a script that writes and then reads
     * sees its own write even though nothing was stored — see that member for
     * why nothing was.
     * @returns the note, or `''`.
     */
    getScriptInfo: (): string => {
      const script = host.scriptId()
      if (script === undefined) return ''
      return scriptInfoWrites.get(script) ?? scriptRow('getScriptInfo', script)?.info ?? ''
    },
    /**
     * Replace the calling script's author note — **not stored**.
     *
     * Upstream writes `script.info` into the repository the script came out of
     * and the panel persists it (`function/script.ts:143`). Here a card script's
     * name and note are the **card file's** (`@iris/script`'s extractor reads
     * them out of `tavern_helper.scripts`), so storing this would mean writing
     * the user's character file on a card's own initiative — a
     * character-library write, which this host's grant model has no slot for
     * (`notes/apps/iris-web/GRANTS.md`) and which belongs with the second wave
     * of this family.
     *
     * So: the value is kept for this frame's life, so `getScriptInfo()` agrees
     * with the write that just happened, and a fault is reported saying nothing
     * was persisted. Upstream's return is `void`, so a caller cannot tell the
     * difference from the call — which is exactly why it has to be said on the
     * record instead.
     *
     * **The mechanism, named rather than guessed at**: a `script.setInfo` arm
     * taking `{ characterId, scriptId, info }`, writing through the card's
     * script policy store for a card script (which needs a card-file write and
     * a grant) and through `scriptLibrary.save` for one of the user's own
     * (which already carries `info`). The frame would then await it the way
     * `replaceScriptButtons` does and report a fault only on rejection.
     * @param info - the new note.
     * @throws {UnsupportedApiError} outside a script frame, as upstream's
     *   declaration requires.
     */
    replaceScriptInfo: (info: string): void => {
      const script = host.scriptId()
      if (script === undefined) {
        throw new UnsupportedApiError(
          'replaceScriptInfo',
          'upstream allows this only inside a script; this frame is not one.',
        )
      }
      scriptInfoWrites.set(script, String(info))
      host.reportFault(
        'a script replaced its own author note and nothing was stored: the note lives in the card'
          + ' file here, and writing a card file needs a grant Iris has not built — the value is'
          + ' remembered for this frame\'s life only, so a later getScriptInfo() agrees with it',
      )
    },

    /**
     * This character's past conversations, in brief.
     *
     * Asynchronous upstream too (`raw_character.ts:216`), which asks
     * SillyTavern for the character's chat files and attaches `ch_name` and
     * `avatar_url` to each row. The host answers about **this conversation's
     * character only** — the same narrowing `getCharacter` makes — and `null`
     * for any other name, which is upstream's own answer for a character it
     * cannot find, reported so that it does not read as "that card has no
     * conversations".
     *
     * The rows carry upstream's four usable keys (`file_name`, `chat_items`,
     * `ch_name`, `avatar_url`) and Iris's own `chatId`, `title` and `updatedAt`
     * beside them; `ChatHistoryBriefRow` says what each one is worth. Hand them
     * straight to `getChatHistoryDetail`, as upstream's own example does.
     * @param name - `'current'`, or this conversation's card by id or name.
     * @returns the rows, or null.
     */
    getChatHistoryBrief: async (name?: string): Promise<unknown[] | null> => {
      const context = snapshot('getChatHistoryBrief')
      const summary = characterFor(context, name)
      if (summary === undefined || summary.characterId !== context.characterId) {
        reportOnce(
          'history-foreign',
          'a card asked for another character\'s chat history and got null: this host answers the'
            + ' history members about the open conversation\'s own character only',
        )
        return null
      }
      const answer = await host.call('getChatHistoryBrief', {})
      return (answer as { chats?: unknown[] } | undefined)?.chats ?? []
    },
    /**
     * The floors of named past conversations.
     *
     * Upstream takes the brief rows back and fetches each file
     * (`raw_character.ts:235`, `RawCharacter.getChatsFromFiles`), keys the
     * answer by `file_name`, and drops the first line of every non-group file —
     * which is the metadata header, and this host drops it too.
     *
     * Three departures, each named where it is made: only files belonging to the
     * open conversation's character are answered (the host checks, because the
     * frame is the untrusted side), at most fifty per call, and the floors
     * arrive without their per-swipe variable tables. A file that is not
     * answered is **absent from the map** rather than present and empty, which
     * is upstream's own behaviour for a file its fetch could not read.
     * @param data - the brief rows, or anything carrying `file_name`s.
     * @param isGroupChat - upstream's flag; this host has no group chats.
     * @returns floors by `file_name`.
     */
    getChatHistoryDetail: async (
      data: unknown,
      isGroupChat?: boolean,
    ): Promise<Record<string, unknown>> => {
      if (isGroupChat === true) {
        reportOnce(
          'history-group',
          'a card asked for group-chat history detail and this host has no group conversations —'
            + ' the flag was ignored and the named files were read as ordinary conversations',
        )
      }
      const files = (Array.isArray(data) ? data : [])
        .map(row => (row as { file_name?: unknown } | null)?.file_name)
        .filter((file): file is string => typeof file === 'string' && file.length > 0)
      // Upstream's own reader filters the same way and answers `{}` for a list
      // with no usable file names, without asking the server anything.
      if (files.length === 0) return {}
      if (files.length > HISTORY_DETAIL_LIMIT) {
        host.reportFault(
          `a card asked for ${String(files.length)} conversations' floors in one call and this host`
            + ` answers at most ${String(HISTORY_DETAIL_LIMIT)} — the first`
            + ` ${String(HISTORY_DETAIL_LIMIT)} were read and the rest were not`,
        )
      }
      const answer = await host.call('getChatHistoryDetail', {
        files: files.slice(0, HISTORY_DETAIL_LIMIT),
      })
      return (answer as { chats?: Record<string, unknown> } | undefined)?.chats ?? {}
    },
    /**
     * Text as the reading view would display it — **unchanged, and it says so**.
     *
     * Upstream does three things (`function/displayed_message.ts:24`): expands
     * SillyTavern's macros, applies the display-tier regexes for that floor, and
     * renders the markdown to HTML. In this frame it can do none of them, and
     * the reason is structural rather than unfinished: the macro engine and the
     * regex engine are the host's (the host runs the display tier as it builds
     * a message view, so a floor's text arrives already regexed) and the
     * markdown step is a React component in the shell, while **this member is
     * synchronous** and cannot cross to either.
     *
     * So it returns the text it was given and reports that nothing was applied —
     * the same answer and the same sentence as `substidudeMacros` above,
     * because text handed back unchanged is otherwise indistinguishable from
     * text that had nothing to change.
     *
     * What it *does* keep is the argument checking, because that is a fact about
     * the chat rather than about rendering: `'last'`, `'last_user'` and
     * `'last_char'` resolve against the snapshot's own floors, a negative index
     * counts from the end, and an out-of-range floor throws with upstream's
     * range in the message.
     * @param text - the text to format.
     * @param option - upstream's `{ message_id }`.
     * @returns the text, unformatted.
     * @throws {UnsupportedApiError} when `message_id` is not a floor.
     */
    formatAsDisplayedMessage: (
      text: string,
      option?: { message_id?: 'last' | 'last_user' | 'last_char' | number },
    ): string => {
      // Resolved for its own sake: upstream throws before formatting, so a card
      // whose floor is wrong has to hear about it here rather than get its text
      // back and carry on.
      displayFloorOf(option?.message_id ?? 'last')
      reportOnce(
        'display-format',
        'a card asked for text formatted as a displayed message and this frame applied none of the'
          + ' three passes — no macros, no display regexes, no markdown; the text came back'
          + ' unchanged, which is not a statement that it needed nothing',
      )
      return text
    },
    /**
     * The floor's rendered body as a jQuery handle — **always an empty one**.
     *
     * Upstream reaches into the host page: `$('#chat > .mes[mesid=...]',
     * window.parent.document).find('div.mes_text')`
     * (`displayed_message.ts:88`), and its own declaration says the answer is an
     * empty jQuery when the floor is not displayed. Here the parent document is
     * across an opaque origin — `sandbox="allow-scripts"` without
     * `allow-same-origin`, so the browser refuses before any Iris code is
     * consulted — and `parent.document` is a virtual document scoped to the
     * card's own container, which has no `#chat` in it and deliberately never
     * will (`st-anchors.ts` says why `#chat` is not among the three ids that are
     * served).
     *
     * So this answers the empty jQuery upstream's own contract already allows,
     * and reports once that it is always empty. A card's `.text(...)` and
     * `.append(...)` on it are no-ops, which is what they would be upstream for
     * an undisplayed floor — the difference is that here every floor is
     * undisplayed to a card.
     * @param _messageId - accepted, and there is nothing to find it in.
     * @returns an empty jQuery, or `undefined` in a realm with no jQuery.
     */
    retrieveDisplayedMessage: (_messageId?: number): unknown => {
      reportOnce(
        'retrieve-displayed',
        'a card asked for a floor\'s rendered HTML and got an empty jQuery: the reading view is'
          + ' across an opaque origin, so no card frame can reach a message element — upstream'
          + ' answers an empty jQuery for an undisplayed floor, and here every floor is one',
      )
      // The realm's own jQuery, read at call time rather than captured: the
      // preset seeds it into this frame, and the member table is loaded before
      // it. `$()` with no argument is jQuery's own empty set.
      const realm = globalThis as unknown as Record<string, unknown>
      const jquery = realm['jQuery'] ?? realm['$']
      return typeof jquery === 'function' ? (jquery as () => unknown)() : undefined
    },
    /**
     * Redraw one floor — **the data is already right, and the draw is the
     * shell's**.
     *
     * Upstream rewrites the floor's DOM from `chat[message_id]` and ends by
     * emitting `USER_MESSAGE_RENDERED` / `CHARACTER_MESSAGE_RENDERED`
     * (`displayed_message.ts:92-161`). Its own fork detection takes the shape
     * this host is in: on a *managed* chat surface it touches no DOM at all and
     * calls `refreshManagedChatSurface()` instead
     * (`displayed_message.ts:97-100`).
     *
     * Iris is that case. Every host write arm broadcasts `chat.updated` and the
     * reading view re-renders on it, so after a card's `setChatMessages` the
     * floor already shows the new text: what upstream's member adds here is a
     * card's own control over *when*, which needs a shell arm ("re-push this
     * floor and wait for the render"). That is a decision about the reading
     * column rather than about this surface, so it is left named — the ruling
     * `reloadCurrentChat` already has.
     *
     * It keeps upstream's early return for an empty handle, refuses a floor
     * that is not in the chat (upstream throws a `TypeError` reading
     * `undefined.swipe_id` there), and **does not emit the rendered events**:
     * announcing a render that did not happen would put a lie on the one bus a
     * card can hear.
     * @param messageId - the floor.
     * @param $mes - upstream's optional handle; an empty one returns early.
     */
    refreshOneMessage: async (messageId: number, $mes?: { length?: number }): Promise<void> => {
      if ($mes !== undefined && $mes !== null && $mes.length === 0) return
      const chat = chatOf('refreshOneMessage')
      const floor = typeof messageId === 'number' && messageId < 0 ? chat.length + messageId : messageId
      if (!Number.isInteger(floor) || floor < 0 || floor >= chat.length) {
        host.reportFault(
          `a card asked to refresh floor ${String(messageId)}, which this conversation does not have`
            + ` (it has ${String(chat.length)})`,
        )
        return
      }
      reportOnce(
        'refresh-one',
        'a card asked to redraw a floor and this frame did not: the reading view re-renders on the'
          + ' host\'s own chat.updated, so the floor already shows what the chat file holds — what'
          + ' is missing is a card\'s control over when, which needs a shell arm nobody has built',
      )
    },
    /**
     * Move a span of floors, upstream's three-index rotation.
     *
     * `[begin, middle, end)`: the floors from `middle` up to `end` move in front
     * of `begin`. Asynchronous upstream too (`function/chat_message.ts:468`),
     * and the whole operation happens on the host — the chat file is its, and a
     * rotation composed out of `setChatMessages` would move the words while
     * leaving every name, role, swipe list and per-floor variable table where it
     * was. The indices are clamped there, as upstream clamps them, so an
     * impossible span is upstream's no-op.
     *
     * `refresh` travels and is not acted on: this host's write broadcasts and
     * the view follows, so `'none'` cannot be honoured. Said once, on the call
     * that asked for it.
     * @param begin - first floor of the span; negative counts from the end.
     * @param middle - the floor that becomes first.
     * @param end - one past the last floor of the span.
     * @param option - upstream's `{ refresh }`.
     */
    rotateChatMessages: async (
      begin: number,
      middle: number,
      end: number,
      option?: { refresh?: 'none' | 'affected' | 'all' },
    ): Promise<void> => {
      for (const [label, value] of [['begin', begin], ['middle', middle], ['end', end]] as const) {
        if (!Number.isInteger(value)) {
          throw new UnsupportedApiError(
            'rotateChatMessages',
            `${label} must be a whole number, and it was ${String(value)}.`,
          )
        }
      }
      if (option?.refresh === 'none') {
        reportOnce(
          'rotate-refresh',
          'a card rotated floors with refresh:"none" and the reading view redrew anyway: this host'
            + ' broadcasts every chat write and the view follows it, so there is no way to change'
            + ' the file and hold the display',
        )
      }
      await host.call('rotateChatMessages', {
        begin,
        middle,
        end,
        ...option?.refresh === undefined ? {} : { refresh: option.refresh },
      })
    },
    // —— family③: preset ——

    /**
     * The preset a card is being played with, or another one from the library.
     *
     * **Synchronous, and the whole family turns on that.** Upstream returns a
     * `Preset`, not a promise (`@types/function/preset.d.ts:180`), and the
     * corpus's one real consumer — 魔法少女的扣扣审判1.0's `外置状态栏`, the only
     * card of 19 that reaches for this — reads
     * `TavernHelper.getPreset('in_use')` with no `await` anywhere on the path
     * and then walks `preset.prompts`, filtering on `p.enabled`, branching on
     * `prompt.id === 'worldInfoBefore'` and pushing `{ role: prompt.role,
     * content: prompt.content }` into its own message list. An `async` version
     * of this member hands that site a promise: `preset && preset.prompts` is
     * `undefined`, the `if` is false, the block does nothing and its own
     * `try`/`catch` never fires — the same silence the card gets today from its
     * `typeof` guard, except that the guard now passes and the surface reads as
     * built. A metadata-only reply is worse still: `else if (prompt.content)`
     * goes false for every normal prompt, so the card assembles a message list
     * with its world-info blocks and none of the preset's text, and calls it
     * done.
     *
     * So it reads the pushed snapshot. `'in_use'` is answered from
     * `context.preset.inUse`, the whole `Preset` as JSON text — `JSON.parse`
     * per distinct text, which a frame that never calls this never pays.
     *
     * **A name other than `'in_use'` throws**, and that is the one thing this
     * cannot do upstream's way. Upstream reads the library synchronously; a
     * frame cannot, so a named preset is reachable only through the
     * asynchronous members below. A throw is the right shape for saying so: it
     * is what upstream does for a name it cannot resolve, so a card's `catch`
     * already handles it, and the sentence says which of the two reasons it
     * was. Measured: the corpus passes the literal `'in_use'` and nothing else
     * (`notes/TEST-CARDS.md:297` recorded the same on 2026-09-02).
     * @param name - `'in_use'`, or a library name this frame cannot reach.
     * @returns the preset as upstream shapes it.
     */
    getPreset: (name: string): TavernHelperPreset => {
      const preset = snapshot('getPreset').preset
      if (preset === undefined) {
        throw new Error(
          'getPreset: this host keeps no preset library, so it has no preset to answer with'
          + ' — not even the one in use',
        )
      }
      if (name !== 'in_use') {
        throw new Error(
          `getPreset('${name}'): only the preset in use can be read synchronously in a card frame.`
          + ' Upstream reads the library synchronously and a frame cannot; reach a named preset with'
          + ' await updatePresetWith / setPreset, or make it the one in use with loadPreset first.',
        )
      }
      if (preset.inUse === undefined) {
        throw new Error(`getPreset('in_use'): ${preset.refusal ?? 'the host offered no preset body'}`)
      }
      /*
       * Parsed once per distinct text, not once per call.
       *
       * The invalidation rule is the text's own identity — a new snapshot
       * brings a new string and `!==` is the whole of it — so this is a cache
       * with no second place to be wrong about what changes a preset. Per-call
       * freshness is still real: the one copy every member's return goes
       * through (`detachReturns`, below) is upstream's `klona`, so a card that
       * mutates what it got and hands it to `replacePreset` was never editing
       * this copy.
       */
      if (parsedPreset === undefined || parsedPreset.text !== preset.inUse) {
        parsedPreset = { text: preset.inUse, value: JSON.parse(preset.inUse) as TavernHelperPreset }
      }
      return parsedPreset.value
    },

    /**
     * Every preset name, `'in_use'` first — upstream's `getPresetNames`
     * (`preset.ts:571`).
     *
     * Synchronous like upstream's, from the snapshot, and it includes
     * `'in_use'` because upstream includes it: a card checking
     * `getPresetNames().includes(x)` before `loadPreset(x)` must get the same
     * membership answer here.
     * @returns the names, copied so one card's sort cannot reach the next reader.
     */
    getPresetNames: (): string[] => {
      const preset = snapshot('getPresetNames').preset
      if (preset === undefined) {
        host.reportGap(
          'a card called getPresetNames and this host keeps no preset library — it returned an empty'
          + ' list, which is not a statement that the library is empty',
        )
        return []
      }
      return [...preset.names]
    },

    /**
     * Which library preset the running body was loaded from — upstream's
     * `getLoadedPresetName` (`preset.ts:575`).
     *
     * Upstream's own doc comment is worth repeating because it is the trap: the
     * `'in_use'` preset was *loaded from* this one and its contents may since
     * differ, because an edit takes effect immediately and is only written back
     * on save (`preset.d.ts:152-160`). Iris's prompt manager has the same two
     * layers, so the same sentence holds.
     *
     * `''` when the running body has no library name — a state upstream cannot
     * reach and this host can, because `preset.delete` of the active preset
     * deliberately leaves the body live and nameless. Reported once, because a
     * fabricated name would be a name `getPreset` then throws on.
     * @returns the name, or `''`.
     */
    getLoadedPresetName: (): string => {
      const preset = snapshot('getLoadedPresetName').preset
      if (preset === undefined) {
        host.reportGap(
          'a card called getLoadedPresetName and this host keeps no preset library — it returned an'
          + ' empty string',
        )
        return ''
      }
      if (preset.loaded === undefined) {
        host.reportGap(
          'a card called getLoadedPresetName and the preset in use has no library name (it was'
          + ' deleted, or this host was composed with a preset and no name) — it returned an empty'
          + ' string rather than a name getPreset would then refuse',
        )
        return ''
      }
      return preset.loaded
    },

    /**
     * Switch the running preset — upstream's `loadPreset` (`preset.ts:579`).
     *
     * **Returns a boolean, not a promise**, because upstream's does: its
     * `preset_manager.selectPreset` starts the switch and the member answers
     * whether the *name existed*. So the decision is taken here against the
     * snapshot's name list and the switch is fired without being awaited —
     * upstream's shape exactly, including its consequence that `true` means
     * "this name exists and a switch has begun" rather than "the next
     * generation will use it".
     *
     * The host arm goes through `#applyPreset`, so the switch does everything a
     * switch does: the body becomes the assembler's input, the scalar fields it
     * acts on land in the settings layer, and every open conversation's regex
     * tier is refreshed. A preset carries its own regex rules, and a switch
     * that skipped that refresh would leave the previous preset's rules
     * rewriting the page with nothing to show it.
     * @param name - the preset to load.
     * @returns whether a preset of that name exists.
     */
    loadPreset: (name: string): boolean => {
      const preset = snapshot('loadPreset').preset
      if (preset === undefined || name === 'in_use' || !preset.names.includes(name)) return false
      void host.call('loadPreset', { name }).then(
        answer => {
          /*
           * The host's own verdict, reported only when it disagrees with the
           * one already handed back. The two can differ honestly — the
           * snapshot's name list is as fresh as the last snapshot, and a preset
           * deleted since is a `true` this frame has already returned. Saying
           * so is the only way that becomes visible; upstream, where both
           * readings come from one synchronous list, has nothing to report.
           */
          if ((answer as { loaded?: boolean } | undefined)?.loaded === false) {
            host.reportFault(
              `loadPreset('${name}') answered true from this frame's snapshot, but the host no longer`
              + ' has a preset of that name — nothing was switched',
            )
          }
        },
        (error: unknown) => {
          host.reportFault(`loadPreset('${name}') could not be carried out: ${String(error)}`)
        },
      )
      return true
    },

    /**
     * The three prompt-class guards — upstream's `isPresetNormalPrompt`,
     * `isPresetSystemPrompt` and `isPresetPlaceholderPrompt`
     * (`preset.ts:107-123`).
     *
     * Served from `@iris/compat-tavernhelper-core`, which is also where the
     * host reads them when it writes a card's edited preset back into a file.
     * One copy on purpose: the guards decide a prompt's class from its `id`,
     * and the file's `system_prompt` and `marker` flags are written from the
     * *same* classification — so two copies disagreeing by one identifier would
     * give a card a prompt the guard calls normal and the file records as a
     * marker, consistent on both sides, wrong as a pair, and silent.
     */
    isPresetNormalPrompt: (prompt: { id: string }): boolean => isPresetNormalPrompt(prompt),
    isPresetSystemPrompt: (prompt: { id: string }): boolean => isPresetSystemPrompt(prompt),
    isPresetPlaceholderPrompt: (prompt: { id: string }): boolean => isPresetPlaceholderPrompt(prompt),

    /**
     * The preset a new one starts from — upstream's `default_preset`
     * (`preset.ts:126`).
     *
     * A value, not a function, exactly as upstream declares it. The copy every
     * member's *return* goes through does not apply to a property, so this
     * hands out the frozen object — a card that writes into it gets a
     * `TypeError` in strict mode rather than quietly changing what the next
     * `createPreset` writes, which upstream's `as const` is only a type-level
     * claim about.
     */
    default_preset: TH_DEFAULT_PRESET,

    /**
     * The order the built-in prompts go in by default
     * (`src/function/generate/types.ts:172`).
     *
     * Two names for one array, and both are published deliberately.
     * `builtin_prompt_default_order` is the spelling upstream actually puts on
     * the `TavernHelper` object (`src/function/index.ts:337`, and the only one
     * in `@types/function/index.d.ts`) even though its own JSDoc marks it
     * `@deprecated`. `placeholder_prompt_default_order` is declared as a global
     * in `@types/function/generate.d.ts:326`, is the one upstream's prose tells
     * authors to use instead, and is **not published at all**: it is not a key
     * of `TavernHelper`, `predefine.js` seeds a card's bare globals by merging
     * that object's keys, and the string occurs 0 times in the shipped
     * `dist/index.js` against 1 for the deprecated spelling.
     *
     * So a card written against the type declarations dies on real
     * SillyTavern. Publishing it here is a deliberate addition rather than
     * parity — a name upstream declares, documents as preferred, and forgot to
     * export — recorded in DEVIATIONS web §89. It is the **same array object**,
     * pinned by identity, so the two spellings cannot drift.
     */
    builtin_prompt_default_order: PLACEHOLDER_PROMPT_DEFAULT_ORDER,
    placeholder_prompt_default_order: PLACEHOLDER_PROMPT_DEFAULT_ORDER,

    /**
     * The reverse-proxy configurations a generation can be routed through —
     * upstream's `getProxyPresetNames` (`function/generate.d.ts:6`).
     *
     * **Empty because there are none, not as a stand-in for an answer.** An ST
     * proxy preset is a named `{ url, password }` override for the API
     * endpoint, kept in `oai_settings.proxies`; upstream answers `[]` on any
     * install where nobody has added one, which is the majority state. Iris has
     * no such concept at all — a route here is a connection profile (web §77),
     * a different object with a different lifecycle — so `[]` is the true
     * answer rather than a placeholder, and it stays true.
     *
     * Deliberately **not** answered with the saved provider names, which is the
     * tempting mapping and wrong twice over: a profile is not a proxy override,
     * and a card offering to switch "proxy preset" would be offering to change
     * which endpoint generates, which is not what it asked about.
     * @returns an empty list.
     */
    getProxyPresetNames: (): string[] => [],

    /**
     * Create a preset — upstream's `createPreset` (`preset.ts:596`).
     *
     * `false` when the name is taken, and the **host** decides that, not this
     * frame: upstream reads its own synchronous name list, and the list here is
     * as fresh as the last snapshot, so deciding here would leave a window in
     * which this silently *replaced* a preset created since. The `ifAbsent`
     * flag moves the decision beside the file.
     * @param name - the new preset's name.
     * @param preset - its contents; upstream defaults to `default_preset`.
     * @returns whether it was created.
     */
    createPreset: async (name: string, preset?: TavernHelperPreset): Promise<boolean> => {
      const answer = await host.call('createOrReplacePreset', {
        name,
        preset: (preset ?? TH_DEFAULT_PRESET) as unknown as Record<string, unknown>,
        ifAbsent: true,
      })
      return (answer as { created?: boolean }).created === true
    },

    /**
     * Create a preset, or replace one that is there — upstream's
     * `createOrReplacePreset` (`preset.ts:657`).
     *
     * The `render` option upstream's third argument carries is accepted and
     * ignored, which is not the same as dropping it: it chooses between a
     * debounced and an immediate re-render of SillyTavern's own prompt-manager
     * DOM, which this host does not have. The refresh a write to `'in_use'`
     * *does* need — every open conversation's regex tier — is unconditional in
     * the host, because a preset carries its own rules and getting that
     * conditional wrong leaves the old ones running. Accepting the argument
     * keeps a card's call signature working; honouring it would mean inventing
     * a UI to debounce.
     * @param name - the preset's name, or `'in_use'`.
     * @param preset - its contents; upstream defaults to `default_preset`.
     * @returns true when it was created, false when it was replaced.
     */
    createOrReplacePreset: async (name: string, preset?: TavernHelperPreset): Promise<boolean> => {
      const answer = await host.call('createOrReplacePreset', {
        name,
        preset: (preset ?? TH_DEFAULT_PRESET) as unknown as Record<string, unknown>,
      })
      return (answer as { created?: boolean }).created === true
    },

    /**
     * Remove a preset — upstream's `deletePreset` (`preset.ts:692`).
     * @param name - the preset's name.
     * @returns whether one was removed.
     */
    deletePreset: async (name: string): Promise<boolean> => {
      const answer = await host.call('deletePreset', { name })
      return (answer as { deleted?: boolean }).deleted === true
    },

    /**
     * Rename a preset — upstream's `renamePreset` (`preset.ts:696`).
     *
     * `false` for a target name already taken, where upstream returns `true`
     * having **deleted the source**: its `renamePreset` calls `createPreset`
     * (which writes nothing when the name exists) and then deletes the old
     * preset unconditionally. That is a data loss, so this host refuses instead
     * and both presets stay — a deliberate divergence recorded in DEVIATIONS
     * web §89 and host §65, and reported by the host so the `false` is not
     * mute.
     * @param name - the preset to rename.
     * @param newName - the name to give it.
     * @returns whether it was renamed.
     */
    renamePreset: async (name: string, newName: string): Promise<boolean> => {
      const answer = await host.call('renamePreset', { name, newName })
      return (answer as { renamed?: boolean }).renamed === true
    },

    /**
     * Replace a preset's whole contents — upstream's `replacePreset`
     * (`preset.ts:705`).
     *
     * Upstream throws for a name nothing has, and so does this: the host arm's
     * own `not-found` carries the name, and a rejection is what a card's
     * `catch` sees either way. No existence check is made here first — a check
     * against a snapshot-stale name list would refuse a preset that exists and
     * pass one that does not, and the host has to make the decision anyway.
     * @param name - the preset to replace, or `'in_use'`.
     * @param preset - the contents to write.
     */
    replacePreset: async (name: string, preset: TavernHelperPreset): Promise<void> => {
      await host.call('createOrReplacePreset', { name, preset: preset as unknown as Record<string, unknown> })
    },

    /**
     * Update a preset through a function — upstream's `updatePresetWith`
     * (`preset.ts:718`).
     *
     * Composed in the frame because the argument is a **function**, which
     * cannot cross the frame boundary — the same shape `updateVariablesWith`
     * and `updateWorldbookWith` take. So this is a read, the card's own
     * updater, and a write; the read is the asynchronous round trip, which is
     * what lets it name a library preset the synchronous `getPreset` cannot
     * reach.
     * @param name - the preset to update, or `'in_use'`.
     * @param updater - given the preset, returns the preset to write.
     * @returns the preset as written.
     */
    updatePresetWith: async (
      name: string,
      updater: (preset: TavernHelperPreset) => TavernHelperPreset | Promise<TavernHelperPreset>,
    ): Promise<TavernHelperPreset> => {
      const read = await host.call('getPreset', { name })
      const next = await updater((read as { preset: TavernHelperPreset }).preset)
      await host.call('createOrReplacePreset', { name, preset: next as unknown as Record<string, unknown> })
      return next
    },

    /**
     * Write part of a preset back — upstream's `setPreset` (`preset.ts:731`).
     *
     * A read-modify-write over the whole preset, which is what upstream's is
     * too (`setPreset` → `updatePresetWith` → `getPreset` + `replacePreset`) —
     * and the reason the round-trip read had to start answering the whole
     * `Preset` rather than the four prompt fields the corpus reads. The merge
     * is upstream's own three rules and lives in the shared module beside the
     * mapping: `settings` and `extensions` are filled in from the stored
     * preset, while `prompts` and `prompts_unused` are replaced wholesale by
     * whichever the partial names.
     * @param name - the preset to write into, or `'in_use'`.
     * @param preset - the fields to change.
     * @returns the preset as written.
     */
    setPreset: async (
      name: string,
      preset: Parameters<typeof mergePresetDefaults>[0],
    ): Promise<TavernHelperPreset> => {
      const read = await host.call('getPreset', { name })
      const merged = mergePresetDefaults(preset, (read as { preset: TavernHelperPreset }).preset)
      await host.call('createOrReplacePreset', { name, preset: merged as unknown as Record<string, unknown> })
      return merged
    },

    // —— family③ end ——
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
  // —— family①: identity & messages ——
  /*
   * A jQuery object is not structured-cloneable — it holds a `length`, a
   * `prototype` chain of methods and, for a non-empty set, DOM nodes. Cloning
   * one fails, and `detach`'s fallback is to hand back the original **with a
   * report**, so leaving this out would put a gap line on the panel for every
   * call of a member whose whole answer is already reported once. It is listed
   * for the reason `injectPrompts` is: the return is a live handle, and a card
   * calls methods on it.
   */
  'retrieveDisplayedMessage',
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
