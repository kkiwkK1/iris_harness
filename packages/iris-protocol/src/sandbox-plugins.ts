/**
 * The half of the sandbox-plugin contract both realms have to agree on.
 *
 * A sandbox plugin is code a model wrote, mounted into the card-script frame of
 * one conversation ([SANDBOX-PLUGINS](../../../docs/SANDBOX-PLUGINS.md)). Almost
 * all of it lives on one side or the other — the tree is in the frame, the
 * record is in the host — and only three things have to be the *same* on both:
 *
 * - **the wrapper the code is compiled in** (§6.1). The host's syntax precheck
 *   runs in Node and the mount runs in a browser, so "the precheck passed and
 *   the mount still failed on syntax" is reachable the moment the two build
 *   their source differently. dsh paid for that lesson; here the two halves
 *   call {@link sandboxPluginBody} and a test compares the bytes each one
 *   actually handed its compiler.
 * - **the failure vocabulary** (§6). Seven named states, none of them silent,
 *   and deliberately *not* the seven of `SystemPluginFailureState` beside them
 *   — the stages are different and one word meaning two things across two
 *   tables is how a reader ends up debugging the wrong mechanism.
 * - **the limits** (§3.2 Q2). A ceiling enforced on one side only is a ceiling
 *   the other side has to guess at.
 *
 * Nothing here executes anything. {@link precheckSandboxPluginSyntax} takes its
 * compiler as a parameter precisely so that this module never needs one.
 *
 * @module @iris/protocol/sandbox-plugins
 */

/**
 * Why a sandbox plugin is not running.
 *
 * Seven, and the names are **not** `SystemPluginFailureState`'s seven. A system
 * plugin is full-privilege Node code installed from a place; a sandbox plugin is
 * untrusted code written a minute ago, and the only word the two stages share
 * honestly is "failed".
 *
 * Three of them are reachable without a model at all, which is what makes PR-A
 * able to test them: `mount-failed`, `mount-timeout`, `dispose-failed`.
 * `syntax-failed` is reachable through the precheck below. `unparseable`,
 * `too-large` and `orphaned` belong to the record and the sidecar (PR-B).
 */
export type SandboxPluginFailureState =
  /** The model's completion did not yield a record — neither route parsed. */
  | 'unparseable'
  /** Over one of {@link SANDBOX_PLUGIN_LIMITS}, refused before anything is stored. */
  | 'too-large'
  /** The definition-time syntax precheck refused it; see {@link precheckSandboxPluginSyntax}. */
  | 'syntax-failed'
  /** Evaluating the factory, or calling `apply`, threw. */
  | 'mount-failed'
  /** `apply` outran its deadline, or the batch outran its budget. */
  | 'mount-timeout'
  /** A teardown item did not come away; the plugin still works, the leftovers stay. */
  | 'dispose-failed'
  /** The record exists and nothing is mounted for it. */
  | 'orphaned'

/** Every failure state, in the order the type declares them. */
export const SANDBOX_PLUGIN_FAILURE_STATES: readonly SandboxPluginFailureState[] = [
  'unparseable',
  'too-large',
  'syntax-failed',
  'mount-failed',
  'mount-timeout',
  'dispose-failed',
  'orphaned',
]

/**
 * Whether a plain string names a failure state.
 *
 * The frame is untrusted and sends one of these over the wire, so the shell
 * validates rather than casts — the same rule `sizing`'s single mode already
 * follows in the frame protocol.
 * @param value - the raw field.
 * @returns whether it is one of the seven.
 */
export function isSandboxPluginFailureState(value: unknown): value is SandboxPluginFailureState {
  return typeof value === 'string'
    && (SANDBOX_PLUGIN_FAILURE_STATES as readonly string[]).includes(value)
}

/**
 * The attribute that says a `<style>` element belongs to a sandbox plugin, and
 * whose value is the owner's id.
 *
 * Shared because **two realms write it**: the frame's own sink puts one in the
 * card-script frame's head when a plugin calls `iris.styles.insert`, and the
 * shell writes the same attribute into every message frame's `srcdoc` when it
 * folds that sheet out (§5.1). One literal, so a census — "how many of a
 * plugin's sheets are on this document" — asks the same question of both, and so
 * the tooth that asserts **zero** of them on the shell's own page is asserting
 * about the same tag the fan-out actually writes.
 *
 * A second name rather than `data-iris-style`, which means "the message preset
 * put this here": sharing one attribute would let either side's clean-up take
 * the other's sheets away.
 */
export const SANDBOX_PLUGIN_STYLE_ATTRIBUTE = 'data-iris-plugin-style'

/**
 * The ceilings, in one place because both halves enforce some of them.
 *
 * Judgements, not measurements — the design says so in as many words (§3.2 Q2).
 * `codeBytes` against the frame's 2 MiB budget (`frame-budget.ts`) is the one
 * with a stated ratio: a single plugin taking a thirty-second of a frame is
 * already a lot.
 */
export const SANDBOX_PLUGIN_LIMITS = {
  /** One version's `code`, in UTF-8 bytes. */
  codeBytes: 64 * 1024,
  /** A plugin id on the wire. */
  idChars: 120,
  /** One `styles.insert` payload, in UTF-16 units as the wire measures it. */
  cssChars: 32 * 1024,
  /** A failure detail, bounded like `error`'s message. */
  detailChars: 2_000,
  /**
   * One plugin's `apply`, in milliseconds.
   *
   * 3 s rather than the generation hooks' 5 s, because this is on the
   * open-a-chat path rather than the settle-a-turn path (§6.3).
   */
  applyMs: 3_000,
  /**
   * The whole batch, in milliseconds.
   *
   * 3 s × 16 plugins is 48 s of an opening chat, which is not a budget, so the
   * batch has its own: a plugin whose turn comes after this is spent records
   * `mount-timeout` and is skipped. The two numbers point at each other here so
   * neither can drift alone.
   */
  batchMs: 10_000,
  /** One plugin's `dispose`, in milliseconds (§5.7 item 1). */
  disposeMs: 1_000,
} as const

/**
 * The parameter name a plugin's factory receives its facade under.
 *
 * One name, shared, because it is half of the wrapper the two realms must agree
 * on byte for byte — a precheck that compiles `function(iris)` while the mount
 * compiles `function(plugin)` would pass code that cannot run.
 */
export const SANDBOX_PLUGIN_FACADE_PARAM = 'iris'

/**
 * The function body a plugin's source is compiled as.
 *
 * `"use strict"` first, and the trailing newline is not decoration: a body
 * whose last line is a `//` comment swallows the closing brace without it.
 *
 * **This is the byte-identity contract.** The host's precheck and the frame's
 * mount both hand a compiler the output of this function and nothing else, so
 * "it compiled here" and "it compiles there" are the same question. The moment
 * either side assembles its own template the check below stops meaning anything
 * — which is why the test captures what each side actually passed rather than
 * calling this twice and comparing it with itself.
 * @param code - the plugin's source, as authored.
 * @returns the body to compile.
 */
export function sandboxPluginBody(code: string): string {
  return `"use strict";\n${code}\n`
}

/** What a precheck found, or nothing when the source compiles. */
export interface SandboxPluginSyntaxRefusal {
  readonly state: 'syntax-failed'
  /** The compiler's own words. Not a sentence written here. */
  readonly detail: string
}

/**
 * Compile a plugin's source without running it, to find syntax errors early.
 *
 * The compiler is a parameter for two reasons and both matter. It keeps this
 * module free of `new Function`, so it can be imported by a side that has no
 * business compiling anything; and it lets a test read back the **exact bytes**
 * this function handed over, which is the only way to check the byte-identity
 * claim above without trusting it.
 *
 * `new Function` is the compiler on both real paths, and that is deliberate: it
 * is the same construction the mount uses, so a form that parses here parses
 * there. A parser library would be a second opinion about a language, which is
 * the shape this project has already been bitten by.
 * @param code - the plugin's source, as authored.
 * @param compile - compiles a parameter list and a body, throwing on a syntax error.
 * @returns the refusal, or undefined when it compiles.
 */
export function precheckSandboxPluginSyntax(
  code: string,
  compile: (param: string, body: string) => unknown = (param, body) => new Function(param, body),
): SandboxPluginSyntaxRefusal | undefined {
  try {
    compile(SANDBOX_PLUGIN_FACADE_PARAM, sandboxPluginBody(code))
    return undefined
  } catch (error: unknown) {
    return {
      state: 'syntax-failed',
      detail: (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        .slice(0, SANDBOX_PLUGIN_LIMITS.detailChars),
    }
  }
}

/**
 * The ceilings a whole conversation's plugins are held to, and the text fields'.
 *
 * Separate from {@link SANDBOX_PLUGIN_LIMITS} because the two answer different
 * questions and are enforced in different places: those are what the **frame**
 * and the wire have to agree about, these are what the **host** refuses before
 * anything is stored (§10.4, §3.2 Q2). Both halves are judgements rather than
 * measurements — there is no corpus for a feature that does not exist yet — and
 * that is written here rather than discovered later.
 *
 * Seven of them, and the design's own test row says "seven ceilings, one
 * assertion each". They are not rounded to powers of ten on purpose: `codeBytes`
 * is 64 **KiB**, and a test exists whose only job is to go red if somebody
 * "tidies" it to 64000.
 */
export const SANDBOX_PLUGIN_QUOTAS = {
  /** How many plugins one conversation may hold. Over it, `define` refuses. */
  plugins: 16,
  /** Every version of every plugin in one conversation, in UTF-8 bytes. */
  chatCodeBytes: 256 * 1024,
  /**
   * How many versions of one plugin are kept.
   *
   * The same order as `DEFAULT_CACHE_TRACE_KEEP`: enough to see what the last
   * one looked like, not enough to become an archive. Appending past it drops
   * the oldest **together with its entry in `authorizedHashes`** — an
   * authorisation whose version is gone authorises nothing and would only make
   * the list longer than the thing it describes.
   */
  versionsKept: 8,
  /** A plugin's display name, in UTF-16 units as the wire measures it. */
  nameChars: 64,
  /** The sentence the confirmation card leads with. */
  purposeChars: 280,
  /** The player's own sentence, kept verbatim so "what did I say" has an answer. */
  promptChars: 2_000,
  /**
   * One sidecar file, in UTF-8 bytes.
   *
   * A backstop rather than a working limit: the four above bite first in every
   * ordinary case, and this one exists so a bug in any of them cannot write an
   * unbounded file.
   */
  sidecarBytes: 1024 * 1024,
} as const

/**
 * The sidecar's schema version.
 *
 * A mismatch **quarantines the whole file** rather than migrating it or
 * salvaging the rows it understands (§10.4). The reason is not tidiness: what
 * gets parsed out of this file gets executed, and a best-effort read of a
 * plugin table is a best-effort guess about which code the player authorised.
 */
export const SANDBOX_PLUGIN_SIDECAR_VERSION = 1

/**
 * What a plugin says it will register.
 *
 * **The model's own account, not the host's guarantee.** Nothing is gated on it
 * — the three capabilities are open to every plugin and the boundary is the
 * iframe (§7, §14.7) — and the confirmation card is required to say so in as
 * many words ("it says it will register"). Showing it is what lets a player
 * notice the mismatch between "only changes some colours" and forty kilobytes
 * of code.
 */
export type SandboxPluginDeclaration =
  | { readonly kind: 'style' }
  | { readonly kind: 'panel' }
  | { readonly kind: 'members', readonly names: readonly string[] }

/**
 * One version of a plugin, as the wire carries it.
 *
 * **No `code`.** The list panel does not need the source, and putting a model's
 * code into the answer of every `list` would be handing it a road to the shell
 * for nothing. Reading the source is its own call (`sandboxPlugin.source`,
 * PR-D).
 */
export interface SandboxPluginVersionView {
  /** Monotonic from 1, unique within its plugin. */
  readonly version: number
  readonly name: string
  readonly purpose: string
  readonly declares: readonly SandboxPluginDeclaration[]
  /** UTF-8 byte count of the source, so the card can show a size. */
  readonly bytes: number
  /** First 12 hex of the source's sha256. **The unit authorisation is recorded in.** */
  readonly hash: string
  /** The sentence that produced it, verbatim. */
  readonly prompt: string
  /** Which connection profile and model wrote it, and when. */
  readonly authored: { readonly connectionId: string, readonly model: string, readonly at: number }
}

/**
 * A plugin in one conversation, as the wire carries it.
 *
 * The projection `sandboxPlugin.list` / `define` / `decide` all answer in. It
 * carries the **authorisation state** rather than the authorisation mechanism:
 * a reader needs to know whether this version is waiting to be confirmed, not
 * which hashes have been confirmed before.
 */
export interface SandboxPluginView {
  readonly id: string
  /** Every kept version, oldest first. The current one is the last. */
  readonly versions: readonly SandboxPluginVersionView[]
  /** Whether the player has switched it off. Off is not gone. */
  readonly enabled: boolean
  /** Whether the player double-ticked this id, so future versions mount unasked. */
  readonly trustFutureVersions: boolean
  /**
   * Whether the **current** version may mount.
   *
   * Derived here rather than left to the reader to compute from a hash list:
   * the question "is this waiting for me" has exactly one right answer and it
   * should not be worked out twice on two sides.
   */
  readonly authorized: boolean
  /** The conversation this plugin's row was copied from, when it was branched. */
  readonly branchedFrom?: string
  /** The last failure, cleared by a successful mount. */
  readonly failure?: { readonly state: SandboxPluginFailureState, readonly detail: string, readonly at: number }
}

/**
 * What `sandboxPlugin.decide` is being asked to do.
 *
 * One arm rather than six RPCs because every one of them is the same sentence —
 * "the player made a decision about this plugin" — and they all answer with the
 * same list. `version` and `plugin` are the single and the double tick of §4.1;
 * the rest are the list panel's own controls.
 */
export const SANDBOX_PLUGIN_VERDICTS = [
  /** Single tick: authorise **this hash** and mount it. The next version asks again. */
  'version',
  /** Double tick: `trustFutureVersions`, so this id's future versions mount unasked. */
  'plugin',
  /** Refuse: the row goes, and the sidecar reads as it did before the definition. */
  'discard',
  /** Off, kept. Torn down, the record and its authorisations stay. */
  'disable',
  /** On again. Not asked again — the authorisation never went anywhere. */
  'enable',
  /** Gone. The record and its authorisations go with it. */
  'remove',
] as const

/** One of {@link SANDBOX_PLUGIN_VERDICTS}. */
export type SandboxPluginVerdict = typeof SANDBOX_PLUGIN_VERDICTS[number]
