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
import type { ScriptChatMessage, ScriptContext, WorldbookEntry } from '@iris/protocol'

import { UnsupportedApiError } from './errors.ts'

/** A scope selector, in the shape upstream's cards pass it. */
export interface VariableOption {
  type?: string
  message_id?: number | string
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
   */
  reportGap: (message: string) => void
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

export function createFrameTavernHelper(host: TavernHelperFrameHost): Record<string, unknown> {
  /** Names already reported, so a card in a loop does not fill the panel. */
  const buttonGapsReported = new Set<string>()

  /**
   * Say once that a script-button call did nothing.
   *
   * Per name rather than per call: a card may poll its buttons, and a stream of
   * one fact teaches a reader to skip the whole class. Per name rather than
   * once overall, because which member a card reached for is the useful part —
   * it says what the missing UI would have had to do.
   * @param member - the member that was called.
   */
  const reportButtonGap = (member: string): void => {
    if (buttonGapsReported.has(member)) return
    buttonGapsReported.add(member)
    host.reportGap(
      `card called ${member} — script buttons are scope Iris has not built, so the call did` +
        ' nothing and no button will appear or fire',
    )
  }

  /** The snapshot, or a refusal naming the member that needed it. */
  const snapshot = (member: string): ScriptContext => {
    const context = host.context()
    if (context === undefined) {
      throw new UnsupportedApiError(member, 'The host snapshot has not arrived yet.')
    }
    return context
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
          'A script scope needs a script_id, and this body has no identity of its own.',
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
  const readVariables = (member: string, option?: VariableOption): Record<string, unknown> => {
    const type = option?.type ?? 'message'

    if (type !== 'message') return layerOf(member, type)

    /*
     * A floor-addressed read is **refused by name**, not answered from a
     * snapshot that cannot tell floors apart.
     *
     * `ScriptContext.variables` is one flat record — "current variable state" —
     * with no record of which floor it belongs to, and `variableLayers`
     * deliberately carries no per-floor data: floor tables are folded in only
     * for a *message* frame. So `message_id: 5` cannot be answered correctly here,
     * and its wrongness **cannot even be detected**: there is no floor label to
     * compare the request against.
     *
     * Refusing rather than answering, because the alternative is the worst thing
     * this file can do. MagVarUpdate's update flow is
     * `getVariables({type:'message', message_id: i})` followed by a merge into
     * `stat_data` and a write — so answering the wrong floor does not merely
     * return a wrong value, it **persists a merge built on one**.
     */
    const addressed = option?.message_id
    if (addressed !== undefined && addressed !== 'latest') {
      throw new UnsupportedApiError(
        `${member}({message_id:${String(addressed)}})`,
        'This frame answers from one snapshot that does not record which floor it holds, so a' +
          ' floor-addressed read cannot be answered correctly here. Floor-addressed reads arrive' +
          ' with the message-frame project.',
      )
    }

    return snapshot(member).variables
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
          'A script scope needs a script_id, and this body has no identity of its own.',
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
     * The buttons this script has published — none, because none can be.
     * @returns an empty list.
     */
    getScriptButtons: (): { name: string, visible: boolean }[] => {
      reportButtonGap('getScriptButtons')
      // An empty array rather than undefined: MVU passes the result straight
      // into `_.intersectionBy`, and the shape a card destructures matters more
      // than the emptiness it finds.
      return []
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
    getButtonEvent: (buttonName: unknown): string => {
      reportButtonGap('getButtonEvent')
      const scriptId = host.scriptId() ?? 'script'
      return `iris_button_${scriptId}_${String(buttonName)}`
    },

    /**
     * Replace this script's button list — accepted, not performed.
     * @param buttons - what the card wanted shown.
     */
    replaceScriptButtons: (buttons: unknown): void => {
      void buttons
      reportButtonGap('replaceScriptButtons')
    },

    /**
     * Add buttons that do not exist yet — accepted, not performed.
     * @param buttons - what the card wanted added.
     */
    appendInexistentScriptButtons: (buttons: unknown): void => {
      void buttons
      reportButtonGap('appendInexistentScriptButtons')
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
    getChatMessages: (
      range: string | number,
      options?: { include_swipes?: boolean },
    ): ScriptChatMessage[] => {
      const chat = chatOf('getChatMessages')
      return resolveRange(range, chat.length).flatMap(index => {
        const message = chat[index]
        if (message === undefined) return []
        if (options?.include_swipes !== true) return [message]
        // One entry per swipe when asked, not one entry carrying an array:
        // cards index the result directly.
        const swipes = message.swipes
        if (swipes === undefined) return [message]
        return swipes.map(text => ({ ...message, mes: text }))
      })
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

  // Upstream exposes the same members twice: bare, and under `TavernHelper`.
  // Both spellings appear in real cards, so both have to resolve.
  api['TavernHelper'] = { ...api }
  return api
}
