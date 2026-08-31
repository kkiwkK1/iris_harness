/**
 * The world-book activation engine.
 *
 * A transcription of SillyTavern's `checkWorldInfo`, with one structural change:
 * everything upstream reaches for through a module-level `let` — the chat, the
 * settings, `chat_metadata.timedWorldInfo`, `Math.random`, the tokenizer —
 * arrives as a parameter, and every state change leaves in the return value.
 *
 * That is not tidiness for its own sake. Timed effects are the reason: sticky
 * and cooldown windows are written back into chat metadata as a side effect of
 * scanning, so in ST a dry run has to be flagged as such to stop it from
 * corrupting the real chat, and a swipe re-scans against metadata the previous
 * swipe already mutated. Passing the state in and handing a new one back makes
 * "score this hypothetical prompt" and "commit this turn" the same call with
 * different plumbing, and makes a swipe reproducible by construction.
 *
 * The scan is a loop, not a pass. Each iteration activates what it can, then
 * decides whether to run again — because a recursion step opened new text to
 * match against, because minimum activations were not met and the window can
 * widen, or because a `delayUntilRecursion` level is still queued. Order within
 * an iteration is fixed and load-bearing: filter, match, group, roll, budget.
 * Group selection happens *before* the probability roll, so a group's loser is
 * gone whether or not the winner then fails its roll.
 *
 * @module @iris/lorebook/activate
 */

import { countMatchingKeys, evaluateSelectiveLogic, findMatchingKey, matchKey } from './matching.ts'
import { parseDecorators } from './parse.ts'
import {
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  MAX_SCAN_DEPTH,
  promptRole,
  worldInfoLogic,
  worldInfoPosition,
  type LorebookEntry,
} from './types.ts'

/**
 * Why the current loop iteration is running.
 *
 * `NONE` is 0 and therefore falsy, which is how the loop terminates: upstream
 * writes `while (scanState)`.
 */
export const scanState = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
} as const

/** A known scan state. */
export type ScanState = (typeof scanState)[keyof typeof scanState]

/**
 * An entry tagged with the book it came from.
 *
 * Identity across a scan is `world` plus `uid`, not `uid` alone — a chat can
 * have a global book, a character book and a chat book open at once, and their
 * uids collide constantly.
 */
export interface ScanEntry extends LorebookEntry {
  /** Name of the book this entry belongs to. */
  world: string
}

/** A scan entry after decorators have been split out and its hash computed. */
export interface PreparedEntry extends ScanEntry {
  /** Recognized `@@` decorators lifted off the front of `content`. */
  decorators: string[]
  /** Content hash. Identifies the entry to timed-effect state across turns. */
  hash: number
}

/**
 * A live sticky or cooldown window.
 *
 * `start` and `end` are chat lengths, not message indices, so the window is
 * evaluated by asking how far the conversation has moved rather than by
 * pointing at a message that a swipe might replace.
 */
export interface TimedEffect {
  /** Hash of the entry the window belongs to. A rewritten entry gets a new hash and a fresh window. */
  hash: number
  /** Chat length when the window opened. */
  start: number
  /** Chat length at which the window closes. */
  end: number
  /**
   * Survive the "chat did not advance" sweep.
   *
   * Set only for a cooldown opened by a sticky window ending in the same scan:
   * without it, the cooldown would be swept away by the very next scan for not
   * having existed before the chat moved, and a sticky entry could never cool
   * down at all.
   */
  protected: boolean
}

/**
 * Sticky and cooldown windows for one chat, keyed by `"<world>.<uid>"`.
 *
 * ST persists the equivalent under `chat_metadata.timedWorldInfo`. Iris keeps
 * it out of the engine: pass the previous turn's state in, store the state that
 * comes back. The hashes are Iris's own and are not comparable with ST's, so an
 * imported chat starts with its timers cleared rather than subtly wrong.
 */
export interface TimedEffectState {
  /** Entries currently held active. */
  sticky: Record<string, TimedEffect>
  /** Entries currently barred from re-activating. */
  cooldown: Record<string, TimedEffect>
}

/** Chat-independent text an entry can opt into scanning. */
export interface GlobalScanData {
  /** The generation type that triggered this scan; matched against an entry's `triggers`. */
  trigger: string
  personaDescription: string
  characterDescription: string
  characterPersonality: string
  characterDepthPrompt: string
  scenario: string
  creatorNotes: string
}

/** The character a `characterFilter` is evaluated against. */
export interface CharacterContext {
  /** Card filename, as `characterFilter.names` lists it. */
  name: string
  /** Tag keys assigned to the card. */
  tags: readonly string[]
}

/** The global knobs an entry's per-entry overrides fall back to. */
export interface ActivationSettings {
  /** How many messages back a scan reads when an entry does not override it. */
  scanDepth: number
  /** Keep widening the window until this many entries have activated. `0` disables. */
  minActivations: number
  /** Ceiling on how far the minimum-activations widening may reach. `0` means "the chat length". */
  minActivationsDepthMax: number
  /** Whether activated content is scanned for further matches. */
  recursive: boolean
  /** Hard cap on loop iterations. `0` disables — and, upstream, disables minimum activations with it. */
  maxRecursionSteps: number
  /** Default case sensitivity. */
  caseSensitive: boolean
  /**
   * Default whole-word matching.
   *
   * ST ships this `false`. Iris defaults it `true`: substring keys are the
   * usual cause of a book firing on fragments of unrelated words, and the
   * per-entry `matchWholeWords` override still takes precedence.
   */
  matchWholeWords: boolean
  /** Default for resolving an inclusion group by key-match score instead of by weight. */
  useGroupScoring: boolean
}

/** Everything one scan needs. Nothing is read from anywhere else. */
export interface ActivateOptions {
  /**
   * Candidate entries, already ordered by the caller's insertion strategy.
   *
   * Order matters twice over: it breaks ties when several entries activate in
   * the same iteration, and it decides which of two equally-scored group
   * members is seen first. Producing it is the caller's job because the
   * strategy depends on which books are open, which is not this engine's
   * business.
   */
  entries: readonly ScanEntry[]
  /** Chat messages, **most recent first** — the order ST passes to `checkWorldInfo`. */
  chat: readonly string[]
  /** Global settings; anything omitted takes {@link defaultActivationSettings}. */
  settings?: Partial<ActivationSettings>
  /** Timed-effect state from the previous turn. Never mutated. */
  timedEffects?: TimedEffectState
  /** Token budget for activated content. Defaults to no limit. */
  budget?: number
  /**
   * Token counter.
   *
   * No tokenizer is bundled: the count has to come from the same tokenizer the
   * target model uses, or the budget is decorative. The default counts
   * characters, which is only honest when no budget is set.
   */
  countTokens?: (text: string) => number
  /**
   * Source of randomness for probability rolls and group draws.
   *
   * Injected so a swipe can be replayed and a test can pin an outcome. See
   * {@link mulberry32}.
   */
  random?: () => number
  /** Macro expansion applied to keys and content. Defaults to identity. */
  substituteMacros?: (text: string) => string
  /** Extra text scanned alongside the chat, e.g. author's note and extension injections. */
  injects?: readonly string[]
  /** Chat-independent scan sources. */
  globalScanData?: Partial<GlobalScanData>
  /** The active character, for `characterFilter`. Omitted means no character filtering. */
  character?: CharacterContext
  /**
   * Evaluate without committing.
   *
   * Suppresses both the reading and the writing of sticky and cooldown windows,
   * matching ST's `isDryRun`. Delay is still applied — it is derived from chat
   * length alone and has no state to corrupt.
   */
  dryRun?: boolean
}

/** Entries sharing one `atDepth` slot. ST merges by depth *and* role, so both are part of the key. */
export interface DepthBucket {
  /** Messages up from the end. */
  depth: number
  /** One of {@link promptRole}. */
  role: number
  /** Entries in emission order. */
  entries: PreparedEntry[]
}

/**
 * Activated entries grouped by where they belong in the prompt.
 *
 * Within every bucket the order is ascending `order`, which is what the prompt
 * pipeline wants: upstream sorts descending and then `unshift`s each entry, and
 * the two operations cancel. Reproduced by the same two steps rather than by
 * one ascending sort, because they do not cancel for ties.
 */
export interface PositionBuckets {
  /** `position: before` — above the character definition. */
  before: PreparedEntry[]
  /** `position: after` — below the character definition. */
  after: PreparedEntry[]
  /** `position: ANTop` — above the author's note. */
  anTop: PreparedEntry[]
  /** `position: ANBottom` — below the author's note. */
  anBottom: PreparedEntry[]
  /** `position: EMTop` — above the example messages. */
  emTop: PreparedEntry[]
  /** `position: EMBottom` — below the example messages. */
  emBottom: PreparedEntry[]
  /** `position: atDepth` — injected N messages up from the end, merged by depth and role. */
  atDepth: DepthBucket[]
  /** `position: outlet` — keyed by `outletName`. */
  outlets: Record<string, PreparedEntry[]>
}

/** What a scan produced. */
export interface ActivationResult {
  /** Every entry that made it into the prompt, in activation order. */
  activated: PreparedEntry[]
  /** The same entries, grouped by position. */
  buckets: PositionBuckets
  /** Timed-effect state to carry into the next turn. The input is unchanged. */
  timedEffects: TimedEffectState
  /** Whether the budget was exhausted, which also stops recursion. */
  budgetOverflowed: boolean
  /** Loop iterations run. Diagnostic. */
  loops: number
}

/** ST's shipped defaults, except `matchWholeWords`; see {@link ActivationSettings}. */
export const defaultActivationSettings: ActivationSettings = {
  scanDepth: 2,
  minActivations: 0,
  minActivationsDepthMax: 0,
  recursive: false,
  maxRecursionSteps: 0,
  caseSensitive: false,
  matchWholeWords: true,
  useGroupScoring: false,
}

/**
 * A seedable PRNG for probability rolls and group draws.
 *
 * mulberry32: thirty-two bits of state, no dependencies, and the same sequence
 * on every platform — which is the entire point. A swipe that re-rolls its
 * probability checks differently from the first attempt is a bug users
 * experience as an entry flickering in and out, so the caller is expected to
 * derive a seed from something stable about the turn.
 * @param seed - any integer.
 * @returns a function yielding values in `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * ST's `getStringHash` (cyrb53), reproduced.
 *
 * Only the shape of the guarantee matters — that editing an entry changes its
 * hash and therefore drops its timed windows — but reproducing the exact
 * function costs nothing and keeps the two implementations comparable when
 * debugging a book against ST side by side.
 * @param text - the string to hash.
 * @returns a 53-bit hash.
 */
export function stringHash(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * Turn ST's percentage-of-context budget into an absolute token count.
 *
 * Kept here rather than folded into the scan because the context size belongs
 * to the model, not to the world book, and the scan should be able to take a
 * budget from anywhere.
 * @param maxContext - the generation's context window, in tokens.
 * @param percent - `world_info_budget`, a percentage.
 * @param cap - `world_info_budget_cap`; `0` means uncapped.
 * @returns the absolute budget, never below 1.
 */
export function computeBudget(maxContext: number, percent: number, cap = 0): number {
  const budget = Math.round((percent * maxContext) / 100) || 1
  return cap > 0 && budget > cap ? cap : budget
}

/** An empty timed-effect state. */
function emptyTimedEffects(): TimedEffectState {
  return { sticky: {}, cooldown: {} }
}

/** Identity of an entry within a chat's timed-effect state. */
function effectKey(entry: ScanEntry): string {
  return `${entry.world}.${entry.uid}`
}

/**
 * The text one scan reads.
 *
 * Messages are joined with a `\x01` sentinel on every boundary rather than a
 * bare newline. It is a character no message can contain, and it stops a key
 * from matching across the seam between two messages — without it, the last
 * word of one message and the first of the next would form a phrase that was
 * never said.
 */
class ScanBuffer {
  #depthBuffer: string[] = []
  #recurseBuffer: string[] = []
  #injectBuffer: string[]
  #globalScanData: GlobalScanData
  #settings: ActivationSettings
  #skew = 0

  constructor(
    messages: readonly string[],
    settings: ActivationSettings,
    globalScanData: GlobalScanData,
    injects: readonly string[],
  ) {
    for (let depth = 0; depth < MAX_SCAN_DEPTH && depth < messages.length; depth++) {
      const message = messages[depth]
      if (message) this.#depthBuffer[depth] = message.trim()
    }
    this.#settings = settings
    this.#globalScanData = globalScanData
    this.#injectBuffer = [...injects]
  }

  /**
   * Assemble the haystack for one entry.
   * @param entry - the entry about to be tested; its `scanDepth` and `match*` flags shape the buffer.
   * @param state - the current scan state; the recursion buffer is withheld from a minimum-activations pass.
   * @returns the text to scan.
   */
  get(entry: PreparedEntry, state: number): string {
    let depth = entry.scanDepth ?? this.depth()
    if (depth <= 0) return ''
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH

    const matcher = '\x01'
    const joiner = `\n${matcher}`
    let result = matcher + this.#depthBuffer.slice(0, depth).join(joiner)

    const global = this.#globalScanData
    if (entry.matchPersonaDescription && global.personaDescription) result += joiner + global.personaDescription
    if (entry.matchCharacterDescription && global.characterDescription) result += joiner + global.characterDescription
    if (entry.matchCharacterPersonality && global.characterPersonality) result += joiner + global.characterPersonality
    if (entry.matchCharacterDepthPrompt && global.characterDepthPrompt) result += joiner + global.characterDepthPrompt
    if (entry.matchScenario && global.scenario) result += joiner + global.scenario
    if (entry.matchCreatorNotes && global.creatorNotes) result += joiner + global.creatorNotes

    if (this.#injectBuffer.length > 0) result += joiner + this.#injectBuffer.join(joiner)

    // A minimum-activations pass exists to widen the *chat* window. Letting it
    // also see recursion output would let the two mechanisms feed each other.
    if (this.#recurseBuffer.length > 0 && state !== scanState.MIN_ACTIVATIONS) {
      result += joiner + this.#recurseBuffer.join(joiner)
    }

    return result
  }

  /** Add activated content for the next recursion pass to match against. */
  addRecurse(text: string): void {
    this.#recurseBuffer.push(text)
  }

  /** Whether any recursion output is pending. */
  hasRecurse(): boolean {
    return this.#recurseBuffer.length > 0
  }

  /** Widen the chat window by one message, for a minimum-activations pass. */
  advanceScan(): void {
    this.#skew++
  }

  /** The current chat window depth. */
  depth(): number {
    return this.#settings.scanDepth + this.#skew
  }

  /**
   * Count an entry's key hits, for inclusion-group scoring.
   *
   * Only the positive logics contribute the secondary score. A `NOT_ANY` entry
   * that beat its negative condition did so by *not* matching, so counting its
   * secondary keys would reward it for the keys it avoided.
   * @param entry - the entry to score.
   * @param state - the current scan state.
   * @returns the number of key activations.
   */
  score(entry: PreparedEntry, state: number): number {
    const haystack = this.get(entry, state)
    const options = keyMatchOptions(entry, this.#settings)

    if (entry.key.length === 0) return 0
    const primaryScore = countMatchingKeys(haystack, entry.key, options)

    if (entry.keysecondary.length > 0) {
      const secondaryScore = countMatchingKeys(haystack, entry.keysecondary, options)
      if (entry.selectiveLogic === worldInfoLogic.AND_ANY) return primaryScore + secondaryScore
      if (entry.selectiveLogic === worldInfoLogic.AND_ALL) {
        return secondaryScore === entry.keysecondary.length ? primaryScore + secondaryScore : primaryScore
      }
    }

    return primaryScore
  }
}

/**
 * Sticky, cooldown and delay windows for one scan.
 *
 * Holds a private clone of the state it was given and hands the clone back at
 * the end, so a caller that discards the result (a dry run, an abandoned swipe)
 * loses nothing it had.
 */
class TimedEffects {
  #chat: readonly string[]
  #entries: readonly PreparedEntry[]
  #state: TimedEffectState
  #dryRun: boolean
  #active: { sticky: PreparedEntry[]; cooldown: PreparedEntry[]; delay: PreparedEntry[] } = {
    sticky: [],
    cooldown: [],
    delay: [],
  }

  constructor(
    chat: readonly string[],
    entries: readonly PreparedEntry[],
    state: TimedEffectState | undefined,
    dryRun: boolean,
  ) {
    this.#chat = chat
    this.#entries = entries
    this.#dryRun = dryRun
    this.#state = state ? structuredClone(state) : emptyTimedEffects()
    if (!this.#state.sticky) this.#state.sticky = {}
    if (!this.#state.cooldown) this.#state.cooldown = {}
  }

  /** Open a window description for an entry. */
  #describe(type: 'sticky' | 'cooldown', entry: PreparedEntry, isProtected: boolean): TimedEffect {
    return {
      hash: entry.hash,
      start: this.#chat.length,
      end: this.#chat.length + Number(entry[type]),
      protected: isProtected,
    }
  }

  /**
   * Age one kind of window, retiring what has expired.
   * @param type - which window kind.
   * @param onEnded - what to do with an entry whose window just closed.
   */
  #age(type: 'sticky' | 'cooldown', onEnded: (entry: PreparedEntry) => void): void {
    for (const [key, value] of Object.entries(this.#state[type])) {
      const entry = this.#entries.find((candidate) => candidate.hash === value.hash)

      // The chat has not moved since the window opened, so this is a re-scan of
      // the same turn — a swipe, or a dry run. Anything unprotected is dropped
      // and re-established from scratch, which is what keeps swipes consistent.
      if (this.#chat.length <= value.start && !value.protected) {
        delete this.#state[type][key]
        continue
      }

      // The entry is gone: another character's book, or a book the user closed.
      // Keep the window until it would have expired, in case the book comes back.
      if (!entry) {
        if (this.#chat.length >= value.end) delete this.#state[type][key]
        continue
      }

      if (!entry[type]) {
        delete this.#state[type][key]
        continue
      }

      if (this.#chat.length >= value.end) {
        delete this.#state[type][key]
        onEnded(entry)
        continue
      }

      this.#active[type].push(entry)
    }
  }

  /** Suppress entries the chat is not yet long enough to reach. */
  #ageDelay(): void {
    for (const entry of this.#entries) {
      if (!entry.delay) continue
      if (this.#chat.length < entry.delay) this.#active.delay.push(entry)
    }
  }

  /** Bring every window up to the current chat length. */
  check(): void {
    if (!this.#dryRun) {
      this.#age('sticky', (entry) => {
        // A sticky entry that just let go goes straight onto cooldown, and that
        // cooldown has to be protected: it was opened in the same scan as the
        // chat length it records, so the unprotected sweep above would delete
        // it before it ever suppressed anything.
        if (!entry.cooldown) return
        const effect = this.#describe('cooldown', entry, true)
        this.#state.cooldown[effectKey(entry)] = effect
        this.#active.cooldown.push(entry)
      })
      this.#age('cooldown', () => {})
    }
    this.#ageDelay()
  }

  /**
   * Whether a window of the given kind is currently holding this entry.
   * @param type - which window kind.
   * @param entry - the entry to test.
   * @returns whether the window applies.
   */
  isActive(type: 'sticky' | 'cooldown' | 'delay', entry: PreparedEntry): boolean {
    return this.#active[type].some((candidate) => candidate.hash === entry.hash)
  }

  /**
   * Open windows for everything that activated.
   *
   * An existing window is left alone rather than restarted, so an entry that
   * keeps matching does not extend its own sticky window forever.
   * @param activated - the entries that made it into the prompt.
   */
  commit(activated: readonly PreparedEntry[]): void {
    if (this.#dryRun) return
    for (const entry of activated) {
      for (const type of ['sticky', 'cooldown'] as const) {
        if (!entry[type]) continue
        const key = effectKey(entry)
        if (!this.#state[type][key]) this.#state[type][key] = this.#describe(type, entry, false)
      }
    }
  }

  /** The state to carry into the next turn. */
  state(): TimedEffectState {
    return this.#state
  }
}

/** Resolve an entry's matching options against the global settings. */
function keyMatchOptions(
  entry: PreparedEntry,
  settings: ActivationSettings,
): { caseSensitive: boolean; matchWholeWords: boolean } {
  return {
    caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
    matchWholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
  }
}

/** Whether a `characterFilter` admits the active character. */
function passesCharacterFilter(entry: PreparedEntry, character: CharacterContext | undefined): boolean {
  const filter = entry.characterFilter
  // With no character in play there is nothing to filter against. ST would
  // compare against `undefined` and quietly exclude every filtered entry; that
  // failure mode is indistinguishable from a broken book, so skip instead.
  if (!character) return true

  if (filter.names.length > 0) {
    const included = filter.names.includes(character.name)
    if (filter.isExclude ? included : !included) return false
  }

  if (filter.tags.length > 0) {
    const included = character.tags.some((tag) => filter.tags.includes(tag))
    if (filter.isExclude ? included : !included) return false
  }

  return true
}

/** The recursion level an entry is held back to. `true` is level 1. */
function recursionDelayLevel(entry: PreparedEntry): number {
  if (entry.delayUntilRecursion === true) return 1
  if (typeof entry.delayUntilRecursion === 'number') return entry.delayUntilRecursion
  return 0
}

/**
 * Group activated entries by position.
 *
 * Entries whose content resolved to nothing are dropped here rather than
 * earlier: an empty entry still counts toward activation, still opens its timed
 * windows and still feeds recursion. It just has nothing to place.
 * @param activated - entries in activation order.
 * @returns the buckets.
 */
function bucketByPosition(activated: readonly PreparedEntry[]): PositionBuckets {
  const buckets: PositionBuckets = {
    before: [],
    after: [],
    anTop: [],
    anBottom: [],
    emTop: [],
    emBottom: [],
    atDepth: [],
    outlets: {},
  }

  // Descending by `order`, then unshifted — which leaves each bucket ascending.
  // Written the long way because for two entries with the same `order` the
  // round trip is a reversal, not a no-op, and books depend on it.
  const ordered = [...activated].sort((a, b) => b.order - a.order)

  for (const entry of ordered) {
    if (!entry.content) continue

    switch (entry.position) {
      case worldInfoPosition.before:
        buckets.before.unshift(entry)
        break
      case worldInfoPosition.after:
        buckets.after.unshift(entry)
        break
      case worldInfoPosition.ANTop:
        buckets.anTop.unshift(entry)
        break
      case worldInfoPosition.ANBottom:
        buckets.anBottom.unshift(entry)
        break
      case worldInfoPosition.EMTop:
        buckets.emTop.unshift(entry)
        break
      case worldInfoPosition.EMBottom:
        buckets.emBottom.unshift(entry)
        break
      case worldInfoPosition.atDepth: {
        const depth = entry.depth ?? DEFAULT_DEPTH
        const role = entry.role ?? promptRole.SYSTEM
        const existing = buckets.atDepth.find((slot) => slot.depth === depth && slot.role === role)
        if (existing) existing.entries.unshift(entry)
        else buckets.atDepth.push({ depth, role, entries: [entry] })
        break
      }
      case worldInfoPosition.outlet: {
        // An outlet entry with no target has nowhere to go. Upstream warns and
        // drops it; there is no sensible fallback, since outlets are named by
        // the prompt template.
        if (!entry.outletName) break
        const outlet = buckets.outlets[entry.outletName]
        if (outlet) outlet.push(entry)
        else buckets.outlets[entry.outletName] = [entry]
        break
      }
      default:
        // A position from a fork or a newer build. Nothing to place it in.
        break
    }
  }

  return buckets
}

/**
 * Reduce every inclusion group to a single survivor.
 *
 * Mutates `candidates` in place, which is how upstream does it and is load
 * bearing here too: the budget loop that follows walks the same array, and a
 * loser removed after the budget check would still have consumed tokens.
 *
 * The three filters run in order and the order is the semantics. Sticky wins
 * outright, because an entry the chat is still inside the window of must not be
 * displaced by a fresh roll. Scoring runs next and is a *pruning* step, not a
 * selection — it removes entries that scored below the group maximum, and can
 * leave several tied. Only then does the draw run.
 * @param candidates - entries activated this iteration; losers are spliced out.
 * @param activated - entries already in the prompt, keyed by `"<world>.<uid>"`.
 * @param buffer - the scan buffer, for scoring.
 * @param state - the current scan state.
 * @param timed - the timed-effect windows.
 * @param settings - global settings.
 * @param random - the injected RNG.
 */
function filterByInclusionGroups(
  candidates: PreparedEntry[],
  activated: ReadonlyMap<string, PreparedEntry>,
  buffer: ScanBuffer,
  state: number,
  timed: TimedEffects,
  settings: ActivationSettings,
  random: () => number,
): void {
  const groups: Record<string, PreparedEntry[]> = {}
  for (const entry of candidates) {
    if (!entry.group) continue
    // An entry may belong to several groups at once and has to win each of
    // them independently.
    for (const name of entry.group.split(/,\s*/).filter((part) => part !== '')) {
      const group = groups[name]
      if (group) group.push(entry)
      else groups[name] = [entry]
    }
  }

  if (Object.keys(groups).length === 0) return

  const remove = (entry: PreparedEntry): void => {
    const index = candidates.indexOf(entry)
    if (index !== -1) candidates.splice(index, 1)
  }
  const removeAllBut = (group: readonly PreparedEntry[], chosen: PreparedEntry | null): void => {
    for (const entry of group) {
      if (entry !== chosen) remove(entry)
    }
  }

  const hasSticky = new Map<string, boolean>()
  for (const [name, group] of Object.entries(groups)) {
    const stickyEntries = group.filter((entry) => timed.isActive('sticky', entry))
    if (stickyEntries.length > 0) {
      for (const entry of group) {
        if (!stickyEntries.includes(entry)) remove(entry)
      }
    }
    hasSticky.set(name, stickyEntries.length > 0)

    // Cooldown and delay should already have excluded these before grouping.
    // Upstream keeps the belt-and-braces check; so do we, because an entry
    // force-activated by a decorator can reach here on cooldown.
    for (const entry of group) {
      if (timed.isActive('cooldown', entry) || timed.isActive('delay', entry)) remove(entry)
    }
  }

  for (const [name, group] of Object.entries(groups)) {
    const scored = settings.useGroupScoring || group.some((entry) => entry.useGroupScoring === true)
    if (!scored || hasSticky.get(name)) continue

    const scores = group.map((entry) => buffer.score(entry, state))
    const maxScore = Math.max(...scores)

    for (let i = 0; i < group.length; i++) {
      const entry = group[i]
      const score = scores[i]
      if (entry === undefined || score === undefined) continue
      if ((entry.useGroupScoring ?? settings.useGroupScoring) !== true) continue
      if (score < maxScore) {
        remove(entry)
        group.splice(i, 1)
        scores.splice(i, 1)
        i--
      }
    }
  }

  for (const [name, group] of Object.entries(groups)) {
    if (hasSticky.get(name)) continue

    // A previous iteration already seated this group's winner. Everything else
    // in it is dropped rather than competing against a decided outcome.
    if ([...activated.values()].some((entry) => entry.group === name)) {
      removeAllBut(group, null)
      continue
    }

    if (group.length <= 1) continue

    const overrides = group.filter((entry) => entry.groupOverride).sort((a, b) => b.order - a.order)
    const priority = overrides[0]
    if (priority) {
      removeAllBut(group, priority)
      continue
    }

    const totalWeight = group.reduce((sum, entry) => sum + (entry.groupWeight ?? DEFAULT_WEIGHT), 0)
    const roll = random() * totalWeight
    let running = 0
    let winner: PreparedEntry | null = null
    for (const entry of group) {
      running += entry.groupWeight ?? DEFAULT_WEIGHT
      if (roll <= running) {
        winner = entry
        break
      }
    }

    if (!winner) continue
    removeAllBut(group, winner)
  }
}

/**
 * Run a world-book scan.
 * @param options - everything the scan reads; see {@link ActivateOptions}.
 * @returns the activated entries, their placement, and the timed-effect state for the next turn.
 */
export function activateEntries(options: ActivateOptions): ActivationResult {
  const settings: ActivationSettings = { ...defaultActivationSettings, ...options.settings }
  const random = options.random ?? Math.random
  const countTokens = options.countTokens ?? ((text: string) => text.length)
  const budgetLimit = options.budget ?? Number.POSITIVE_INFINITY
  const substitute = options.substituteMacros ?? ((text: string) => text)
  const chat = options.chat
  const globalScanData: GlobalScanData = {
    trigger: 'normal',
    personaDescription: '',
    characterDescription: '',
    characterPersonality: '',
    characterDepthPrompt: '',
    scenario: '',
    creatorNotes: '',
    ...options.globalScanData,
  }

  // Private copies from here on: the scan rewrites `content` in place when it
  // expands macros, exactly as upstream does, and the caller's entries must not
  // see that. The hash is taken before the rewrite so it identifies the entry
  // as authored, not as rendered for this particular turn.
  const sortedEntries: PreparedEntry[] = options.entries.map((entry) => {
    const [decorators, content] = parseDecorators(entry.content || '')
    const prepared = { ...entry, decorators, content }
    return { ...prepared, hash: stringHash(JSON.stringify(prepared)) }
  })

  const rank = new Map<PreparedEntry, number>()
  sortedEntries.forEach((entry, index) => rank.set(entry, index))

  const buffer = new ScanBuffer(chat, settings, globalScanData, options.injects ?? [])
  const timed = new TimedEffects(chat, sortedEntries, options.timedEffects, options.dryRun ?? false)
  timed.check()

  if (sortedEntries.length === 0) {
    return {
      activated: [],
      buckets: bucketByPosition([]),
      timedEffects: timed.state(),
      budgetOverflowed: false,
      loops: 0,
    }
  }

  // Delayed-recursion levels are walked one at a time in ascending order: a
  // level-2 entry must not fire until every level-1 entry has had a chance to
  // put its content into the recursion buffer.
  const pendingDelayLevels = [...new Set(
    sortedEntries.map(recursionDelayLevel).filter((level) => level > 0),
  )].sort((a, b) => a - b)
  let currentDelayLevel = pendingDelayLevels.shift() ?? 0

  let state: number = scanState.INITIAL
  let loops = 0
  let budgetOverflowed = false
  let activatedText = ''
  const activated = new Map<string, PreparedEntry>()
  const failedProbability = new Set<PreparedEntry>()

  while (state) {
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= loops) break
    loops++

    let nextState: number = scanState.NONE
    const activatedNow = new Set<PreparedEntry>()

    for (const entry of sortedEntries) {
      if (failedProbability.has(entry) || activated.has(effectKey(entry))) continue
      if (entry.disable) continue

      if (entry.triggers.length > 0 && !entry.triggers.includes(globalScanData.trigger)) continue
      if (!passesCharacterFilter(entry, options.character)) continue

      const isSticky = timed.isActive('sticky', entry)

      if (timed.isActive('delay', entry)) continue
      // Sticky outranks cooldown: an entry can be inside both windows when a
      // previous scan opened the cooldown early, and the sticky window is the
      // one the user is currently seeing the effect of.
      if (timed.isActive('cooldown', entry) && !isSticky) continue

      const delayLevel = recursionDelayLevel(entry)
      if (state !== scanState.RECURSION && delayLevel > 0 && !isSticky) continue
      if (state === scanState.RECURSION && delayLevel > currentDelayLevel && !isSticky) continue
      if (state === scanState.RECURSION && settings.recursive && entry.excludeRecursion && !isSticky) continue

      if (entry.decorators.includes('@@activate')) {
        activatedNow.add(entry)
        continue
      }
      if (entry.decorators.includes('@@dont_activate')) continue

      if (entry.constant) {
        activatedNow.add(entry)
        continue
      }
      if (isSticky) {
        activatedNow.add(entry)
        continue
      }

      if (entry.key.length === 0) continue

      const haystack = buffer.get(entry, state)
      const matchOptions = keyMatchOptions(entry, settings)
      const primary = findMatchingKey(haystack, entry.key.map(substitute), matchOptions)
      if (!primary) continue

      const hasSecondary = entry.selective && entry.keysecondary.length > 0
      if (!hasSecondary) {
        activatedNow.add(entry)
        continue
      }

      const secondaryMatches = entry.keysecondary.map((key) => {
        const substituted = substitute(key)
        return substituted !== '' && matchKey(haystack, substituted.trim(), matchOptions)
      })

      if (evaluateSelectiveLogic(entry.selectiveLogic, secondaryMatches)) activatedNow.add(entry)
    }

    // Sticky entries go first so that a group they belong to is decided in
    // their favour before anything else in it is considered.
    const candidates = [...activatedNow].sort((a, b) => {
      const stickyDelta = (timed.isActive('sticky', b) ? 1 : 0) - (timed.isActive('sticky', a) ? 1 : 0)
      return stickyDelta || (rank.get(a) ?? 0) - (rank.get(b) ?? 0)
    })

    // Measured once per iteration, against everything already committed. New
    // content is charged on top of it as the loop walks the candidates.
    const committedTokens = countTokens(activatedText)
    let newContent = ''

    filterByInclusionGroups(candidates, activated, buffer, state, timed, settings, random)

    // Budget-exempt entries are still reachable after an overflow, so the loop
    // has to know whether any remain before it can stop early.
    let exemptRemaining = candidates.filter((entry) => entry.ignoreBudget).length

    for (const entry of candidates) {
      exemptRemaining -= entry.ignoreBudget ? 1 : 0
      if (budgetOverflowed && !entry.ignoreBudget) {
        if (exemptRemaining > 0) continue
        break
      }

      const rolls = entry.useProbability && entry.probability !== 100 && !timed.isActive('sticky', entry)
      if (rolls && random() * 100 > entry.probability) {
        // Recorded rather than merely skipped: the entry must not be
        // reconsidered by a later iteration of the same scan, or a long
        // recursion would re-roll it until it passed.
        failedProbability.add(entry)
        continue
      }

      entry.content = substitute(entry.content)
      newContent += `${entry.content}\n`

      // `newContent` keeps growing past this point on purpose: once the budget
      // is blown, the remaining candidates are being measured against a total
      // that already includes what did not fit, which is how upstream reaches
      // its stop condition.
      if (!entry.ignoreBudget && committedTokens + countTokens(newContent) >= budgetLimit) {
        budgetOverflowed = true
        continue
      }

      activated.set(effectKey(entry), entry)
    }

    const succeeded = candidates.filter((entry) => !failedProbability.has(entry))
    const feedsRecursion = succeeded.filter((entry) => !entry.preventRecursion)

    if (settings.recursive && !budgetOverflowed && feedsRecursion.length > 0) {
      nextState = scanState.RECURSION
    }

    // A minimum-activations pass widened the chat window without letting
    // anything recurse. Give the new text one recursion pass before widening
    // again, or entries reachable only through recursion would never be seen.
    if (settings.recursive && !budgetOverflowed && state === scanState.MIN_ACTIVATIONS && buffer.hasRecurse()) {
      nextState = scanState.RECURSION
    }

    const minActivationsUnmet = settings.minActivations > 0 && activated.size < settings.minActivations
    if (!nextState && !budgetOverflowed && minActivationsUnmet) {
      const overMax = (settings.minActivationsDepthMax > 0 && buffer.depth() > settings.minActivationsDepthMax)
        || buffer.depth() > chat.length
      if (!overMax) {
        nextState = scanState.MIN_ACTIVATIONS
        buffer.advanceScan()
      }
    }

    if (nextState === scanState.NONE && pendingDelayLevels.length > 0) {
      nextState = scanState.RECURSION
      currentDelayLevel = pendingDelayLevels.shift() ?? currentDelayLevel
    }

    state = nextState
    if (state) {
      const text = feedsRecursion.map((entry) => entry.content).join('\n')
      if (text) {
        buffer.addRecurse(text)
        activatedText = `${text}\n${activatedText}`
      }
    }
  }

  const committed = [...activated.values()]
  timed.commit(committed)

  return {
    activated: committed,
    buckets: bucketByPosition(committed),
    timedEffects: timed.state(),
    budgetOverflowed,
    loops,
  }
}
