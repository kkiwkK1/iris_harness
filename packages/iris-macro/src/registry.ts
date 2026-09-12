/**
 * The macro registry and the evaluation context resolvers are handed.
 *
 * Two things live here because they are one contract. A resolver is a pure
 * function of its {@link MacroInvocation}: everything it is allowed to read —
 * who the characters are, what the chat holds, what time it is, where the dice
 * come from — arrives on the context, and nothing is reachable from module
 * scope. SillyTavern's engine does the opposite, closing over `chat`,
 * `chat_metadata`, `moment()` and `Math.random` directly, which is why its
 * macros cannot be tested without booting the app.
 *
 * Registration is reversible. Iris is a plugin system, so `register` hands back
 * a disposer and a second registration of the same name *shadows* rather than
 * clobbers: disposing the newer one restores the older. Without that, unloading
 * a plugin that overrode `{{char}}` would leave the macro missing rather than
 * back to normal.
 *
 * @module @iris/macro/registry
 */

/**
 * Who authored a message.
 *
 * SillyTavern spreads this over two booleans (`is_user`, `is_system`); the
 * three-way union is the same information without the illegal fourth state.
 */
export type MacroRole = 'user' | 'assistant' | 'system'

/** One chat message, reduced to what a macro can see. */
export interface MacroMessage {
  readonly role: MacroRole
  /** Message text, already stripped of any reasoning block. */
  readonly content: string
  /** Display name of the speaker, when it differs from the persona/character. */
  readonly name?: string
  /** Epoch milliseconds the message was sent; drives `{{idleDuration}}`. */
  readonly sendDate?: number
  /**
   * How many alternate generations the message carries, when it carries any —
   * SillyTavern's `swipes.length`. Absent on a row with no candidates, which is
   * what makes `{{lastSwipeId}}` render empty when the newest floor is a user
   * message.
   */
  readonly swipes?: number
  /** Zero-based index of the selected candidate; only meaningful beside {@link swipes}. */
  readonly swipeId?: number
}

/**
 * Character card fields reachable from macros.
 *
 * `creator_notes` is deliberately absent even though SillyTavern exposes
 * `{{creatorNotes}}`: notes are author-to-human text that must never reach the
 * model, and a macro is exactly the hole through which a card would smuggle it
 * into a prompt.
 */
export interface MacroCharacter {
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  /** Raw `mes_example` block, unformatted. */
  readonly mesExamples?: string
  /** The card's Main Prompt override (`system_prompt`). */
  readonly charPrompt?: string
  /** The card's Post-History Instructions (`post_history_instructions`). */
  readonly charJailbreak?: string
  readonly charVersion?: string
  /** `extensions.depth_prompt.prompt`. */
  readonly charDepthPrompt?: string
}

/** Which of SillyTavern's two macro-visible variable tiers a name belongs to. */
export type VariableScope = 'local' | 'global'

/**
 * The store `{{getvar}}` and friends read and write.
 *
 * Deliberately string-valued and flat: this is the macro-visible slice of the
 * variable system, not the whole of `@iris/variables`. SillyTavern's macro tier
 * is likewise flat strings — structure is expressed by storing JSON and letting
 * `{{addvar}}` push into it.
 */
export interface MacroVariableStore {
  /**
   * @param scope - chat-local or global.
   * @param name - variable name, already trimmed.
   * @returns the stored string, or `undefined` when unset.
   */
  get(scope: VariableScope, name: string): string | undefined
  /**
   * @param scope - chat-local or global.
   * @param name - variable name, already trimmed.
   * @param value - the string to store.
   */
  set(scope: VariableScope, name: string, value: string): void
  /**
   * @param scope - chat-local or global.
   * @param name - variable name, already trimmed.
   */
  delete(scope: VariableScope, name: string): void
}

/** An in-memory store whose backing maps are exposed for assertions. */
export interface MemoryVariableStore extends MacroVariableStore {
  readonly local: Map<string, string>
  readonly global: Map<string, string>
}

/**
 * A variable store backed by two maps.
 * @returns a store plus its backing maps, so a test can seed and inspect them.
 */
export function createMemoryVariableStore(): MemoryVariableStore {
  const local = new Map<string, string>()
  const global = new Map<string, string>()
  const pick = (scope: VariableScope): Map<string, string> => (scope === 'global' ? global : local)

  return {
    local,
    global,
    get: (scope, name) => pick(scope).get(name),
    set: (scope, name, value) => void pick(scope).set(name, value),
    delete: (scope, name) => void pick(scope).delete(name),
  }
}

/**
 * The source of "now".
 *
 * Injected rather than read from `Date` so time macros are testable, and
 * carrying its own UTC offset so "local time" is a property of the context
 * rather than of whatever timezone the host process happens to run in.
 */
export interface MacroClock {
  /** @returns the current instant. */
  now(): Date
  /** Minutes east of UTC for local formatting; the host's zone when omitted. */
  readonly utcOffsetMinutes?: number
}

/** A clock reading the host's wall time and timezone. */
export const systemClock: MacroClock = {
  now: () => new Date(),
}

/**
 * The two kinds of randomness the macro vocabulary needs.
 *
 * `{{random}}` must re-roll on every expansion while `{{pick}}` must return the
 * same answer for the same chat, text and position — see `builtins.ts`. Those
 * are different requirements, not one requirement with a flag, so they are two
 * methods and a test can stub either independently.
 */
export interface MacroRandom {
  /** @returns a fresh value in `[0, 1)`. */
  next(): number
  /**
   * @param seed - anything that identifies the decision being made.
   * @returns a generator that yields the same sequence for the same seed.
   */
  seeded(seed: string): () => number
}

/**
 * Re-exported so this package's public surface is unchanged by the move.
 *
 * The function lives in `@iris/text` because the lorebook engine, the macro
 * tier and the script-button event names must all produce the **same number** —
 * see that module for why two copies is the failure worth designing against. It
 * was in `@iris/compat-tavernhelper-core` until 2026-09-12, which made this
 * engine depend on the Tavern Helper compat layer to seed `{{pick}}` (root
 * `notes/DEVIATIONS.md`, stage 0).
 */
import { stringHash } from '@iris/text'

export { stringHash }

/**
 * A deterministic generator for a seed string.
 *
 * mulberry32 rather than SillyTavern's seedrandom: the sequences differ, so a
 * given pick may land on a different list item than upstream would choose, but
 * *stability* — the property `{{pick}}` actually promises — is identical and
 * the dependency is gone.
 * @param seed - the seed string.
 * @returns a generator yielding values in `[0, 1)`.
 */
export function seededRandom(seed: string): () => number {
  let state = stringHash(seed) >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Randomness backed by `Math.random` and {@link seededRandom}. */
export const systemRandom: MacroRandom = {
  next: () => Math.random(),
  seeded: seededRandom,
}

/**
 * Everything a resolver may read.
 *
 * Assembled once per expansion by the caller (`@iris/pipeline`, a slash
 * command, a card script) and never mutated by the engine — the only writable
 * thing on it is {@link MacroVariableStore}, and that is writable because
 * `{{setvar}}` is defined to have a side effect.
 */
export interface MacroContext {
  /** Character name; `{{char}}`. */
  readonly char: string
  /** Persona name; `{{user}}`. */
  readonly user: string
  /** Persona *description*, matching SillyTavern's `{{persona}}`. */
  readonly persona?: string
  /** Group member names. Absent or empty means a one-on-one chat. */
  readonly group?: readonly string[]
  /** Card fields, for `{{description}}` and friends. */
  readonly character?: MacroCharacter
  /** The chat, oldest first. */
  readonly chat?: readonly MacroMessage[]
  /** Index into {@link chat} of the message being expanded, when there is one. */
  readonly messageId?: number
  /** Role of the message being expanded. */
  readonly role?: MacroRole
  /** Text sitting unsent in the composer; `{{input}}`. */
  readonly input?: string
  /** The text `{{original}}` restores, when a card overrides a prompt block. */
  readonly original?: string
  /**
   * Stable identity of the chat.
   *
   * `{{pick}}` seeds off it, so it must survive a rename or a branch — use the
   * creation-time id, never the file name.
   */
  readonly chatId?: string
  /**
   * Reader for the world-info outlet prompts: `{{outlet::key}}`.
   *
   * Upstream keeps the activated outlet entries in `extension_prompts` under
   * `inject_ids.CUSTOM_WI_OUTLET(key)` and has the macro read them back, so the
   * value a macro sees is whatever the last world-info scan wrote. Iris keeps
   * the same shape of lifetime — the reader is wired by the assembler once its
   * scan has produced the outlet buckets — and returns `''` for a key with no
   * bucket, exactly as `getOutletPrompt` does. Absent means the caller has no
   * scan at all, and every outlet renders empty.
   */
  readonly outlet?: (key: string) => string
  /**
   * Index of the first message that fit into the last assembled context —
   * `{{firstIncludedMessageId}}`.
   *
   * Upstream reads `chat_metadata.lastInContextMessageId`, which the previous
   * generation's budget trim wrote; until a generation has run it is unset and
   * the macro renders empty. Iris carries the same value the same way: the host
   * stores what its last assembly dropped, and an absent field renders empty.
   */
  readonly firstIncludedMessageId?: number
  /**
   * The generation budget the macros that report token limits read:
   * `{{maxContext}}`, `{{maxResponse}}` and `{{maxPrompt}}`.
   *
   * Upstream reads its per-backend settings getters; the honest Iris equivalent
   * is the budget the assembler itself runs under. Absent means no route is
   * configured, and the three macros render empty rather than pretending zero —
   * unlike upstream, which answers `0` from an unconfigured backend.
   */
  readonly tokenBudget?: TokenBudget
  readonly variables: MacroVariableStore
  readonly clock: MacroClock
  readonly random: MacroRandom
}

/** The token budgets `{{maxContext}}` and friends report. */
export interface TokenBudget {
  /** Total context window in tokens; `{{maxContext}}`. */
  readonly context: number
  /** Tokens reserved for the model's reply; `{{maxResponse}}`. */
  readonly response: number
}

/** {@link MacroContext} with everything defaultable left out. */
export interface MacroContextInput extends Omit<MacroContext, 'char' | 'user' | 'variables' | 'clock' | 'random'> {
  readonly char?: string
  readonly user?: string
  readonly variables?: MacroVariableStore
  readonly clock?: MacroClock
  readonly random?: MacroRandom
}

/**
 * Fill in the parts of a context a caller rarely cares about.
 *
 * The three injected seams (variables, clock, randomness) default to real ones
 * so ordinary callers need not think about them, while a test can replace any
 * single seam without hand-building the whole record.
 * @param input - the fields the caller knows.
 * @returns a complete context.
 */
export function createMacroContext(input: MacroContextInput = {}): MacroContext {
  return {
    ...input,
    char: input.char ?? '',
    user: input.user ?? '',
    variables: input.variables ?? createMemoryVariableStore(),
    clock: input.clock ?? systemClock,
    random: input.random ?? systemRandom,
  }
}

/** One `{{...}}` occurrence, handed to a resolver. */
export interface MacroInvocation {
  /** The macro name as written, before case folding. */
  readonly name: string
  /**
   * `::`-separated arguments, trimmed, with any macros inside them already
   * expanded.
   */
  readonly args: readonly string[]
  /** The full `{{...}}` text to fall back to when the macro declines. */
  readonly raw: string
  /** Character offset of the `{{` within the text being expanded. */
  readonly offset: number
  /** The whole text handed to `expandMacros`; `{{pick}}` hashes it. */
  readonly source: string
  readonly context: MacroContext
  /**
   * Scratch shared by every resolver in one expansion.
   *
   * `{{original}}` is the reason it exists: SillyTavern lets it yield its value
   * exactly once per substitution, so a card that writes `{{original}}` twice
   * does not duplicate the block it was overriding.
   */
  readonly scratch: Map<string, unknown>
  /**
   * Expand macros inside a value this resolver is about to return.
   *
   * Off by default — see the recursion note in `expand.ts`. Card-field macros
   * opt in, because a character description containing `{{user}}` is the norm
   * rather than the exception.
   * @param text - the text to expand.
   * @returns the expanded text, or `text` unchanged at the depth limit.
   */
  expand(text: string): string
}

/**
 * Resolves one macro.
 *
 * @returns the replacement text, or `undefined` to decline — which leaves the
 *   `{{...}}` in place. Declining is how a resolver rejects arguments it does
 *   not understand without eating text that belongs to some other extension.
 */
export type MacroResolver = (invocation: MacroInvocation) => string | undefined

/** What a regex macro is told about where it is being expanded. */
export interface MacroLikeContext {
  readonly messageId?: number
  readonly role?: MacroRole
}

/**
 * The replacement half of a regex macro.
 *
 * The argument list after `substring` is `String.replace`'s: capture groups
 * (possibly `undefined`), then the match offset, then the whole subject.
 */
export type MacroLikeReplace = (
  context: MacroLikeContext,
  substring: string,
  ...args: (string | number | undefined)[]
) => string

/** A registered regex macro. */
export interface MacroLike {
  readonly regex: RegExp
  readonly replace: MacroLikeReplace
}

/** Raised when a macro name cannot be registered. */
export class MacroRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MacroRegistrationError'
  }
}

/** Normalize a macro name for lookup. SillyTavern matches case-insensitively. */
function foldName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * A set of macros, resolvable against a context.
 *
 * Holds two populations that behave differently on purpose. Named macros are
 * looked up by name and get structured arguments; regex macros ("助手宏", after
 * Tavern Helper's `registerMacroLike`) sweep the finished text and can match
 * anything, which is what lets a card ship its own syntax without the engine
 * knowing about it.
 */
export class MacroRegistry {
  /** Folded name to a shadowing stack, newest last. */
  #named = new Map<string, MacroResolver[]>()
  #likes: MacroLike[] = []

  /**
   * Register a named macro.
   * @param name - the name without braces, e.g. `getvar`. Matched case-insensitively.
   * @param resolver - called for each `{{name...}}`.
   * @returns a disposer that removes exactly this registration, restoring any
   *   registration it shadowed. Calling it twice is a no-op.
   * @throws {MacroRegistrationError} when the name is empty or carries braces —
   *   `register('{{char}}')` is a mistake that would otherwise register a macro
   *   nothing can ever call.
   */
  register(name: string, resolver: MacroResolver): () => void {
    const key = foldName(name)
    if (key === '') throw new MacroRegistrationError('macro name must not be empty')
    if (key.includes('{{') || key.includes('}}')) {
      throw new MacroRegistrationError(`macro name must not include braces: "${name}"`)
    }

    const stack = this.#named.get(key) ?? []
    stack.push(resolver)
    this.#named.set(key, stack)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const current = this.#named.get(key)
      if (current === undefined) return
      const index = current.lastIndexOf(resolver)
      if (index !== -1) current.splice(index, 1)
      if (current.length === 0) this.#named.delete(key)
    }
  }

  /**
   * Register a regex macro, as Tavern Helper's `registerMacroLike` does.
   * @param regex - the pattern. Give it the `g` flag unless you really do mean
   *   "first occurrence only" — `String.replace` honours the flag literally,
   *   and so does upstream.
   * @param replace - called for each match, with the same trailing arguments
   *   `String.replace` passes.
   * @returns a disposer removing this registration. Unlike upstream, which
   *   dedupes and removes by `regex.source`, identity is what is tracked here:
   *   two plugins registering the same pattern get two independent handles.
   */
  registerMacroLike(regex: RegExp, replace: MacroLikeReplace): () => void {
    const entry: MacroLike = { regex, replace }
    this.#likes.push(entry)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = this.#likes.indexOf(entry)
      if (index !== -1) this.#likes.splice(index, 1)
    }
  }

  /**
   * @param name - macro name without braces.
   * @returns whether any named resolver answers to it.
   */
  has(name: string): boolean {
    return this.#named.has(foldName(name))
  }

  /** @returns every registered name, folded, in registration order. */
  names(): string[] {
    return [...this.#named.keys()]
  }

  /** @returns the regex macros, newest last. */
  macroLikes(): readonly MacroLike[] {
    return [...this.#likes]
  }

  /**
   * Resolve one macro.
   *
   * The newest registration wins, but a resolver that returns `undefined` falls
   * through to the one it shadows. That makes a narrow override — say, a plugin
   * that only handles `{{time::UTC+9}}` — safe to install over the general case.
   * @param invocation - the occurrence to resolve.
   * @returns the replacement, or `undefined` when no resolver claimed it.
   */
  resolve(invocation: MacroInvocation): string | undefined {
    const stack = this.#named.get(foldName(invocation.name))
    if (stack === undefined) return undefined
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const resolver = stack[index]
      if (resolver === undefined) continue
      const value = resolver(invocation)
      if (value !== undefined) return value
    }
    return undefined
  }

  /**
   * Sweep the regex macros over finished text.
   *
   * Runs after named expansion, which is what Tavern Helper does (it hooks the
   * outgoing prompt, long after SillyTavern has substituted its own macros) and
   * is also what makes the pairing work: an unrecognised `{{...}}` survives
   * named expansion untouched, so a regex macro still gets to see it.
   * @param text - the expanded text.
   * @param context - where the text is being expanded.
   * @returns the text with every regex macro applied, in registration order.
   */
  applyMacroLikes(text: string, context: MacroLikeContext): string {
    let result = text
    for (const macro of this.#likes) {
      macro.regex.lastIndex = 0
      result = result.replace(macro.regex, (substring: string, ...args: unknown[]) =>
        macro.replace(context, substring, ...(args as (string | number | undefined)[])),
      )
    }
    return result
  }
}
