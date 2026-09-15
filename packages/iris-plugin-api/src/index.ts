/**
 * The system-plugin contract: what a plugin is, and how the host activates it.
 *
 * One control plane owns the plugin catalog and lifecycle
 * (`docs/SYSTEM-PLUGINS.md`); the interfaces below are the face that
 * implementation code writes against. They moved here from
 * `@iris/app-service`'s `system-plugins.ts` — the transition site
 * `notes/SYSTEM-PLUGINS-HANDOFF.md` named — and the move is a move, not a
 * copy: there is exactly one `SystemPluginDefinition` in the repository, and
 * a second one is the second registry the handoff forbids.
 *
 * The contract's three pieces, and where each half lives:
 *
 * - **This package** describes *what a plugin is and how it activates*: the
 *   `apiVersion`-gated, dependency-declaring definition; the activation scope
 *   that publishes and reads capabilities on a Cordis child fiber; the lease
 *   a unit of admitted work holds so disable can wait for it to drain; and
 *   the options the host runtime is constructed with.
 * - **`@iris/protocol`** carries the wire projection — `SystemPluginSnapshot`
 *   and `SystemPluginView` — that the browser reconciles against.
 * - **`@iris/app-service`** owns the runtime: catalog, dependency ordering,
 *   serialized transitions, profile-local persistence, the Cordis child
 *   fibers themselves, and the drain that a disable waits behind.
 *
 * Two documents on `main` describe the rest, and this comment names them
 * rather than the third-party extension design it used to cite: that design's
 * contract document, `docs/EXTENSIONS`, exists only on the unmerged
 * `dev/feat-extension-system` branch, so a reader here could not open it.
 *
 * - `docs/SYSTEM-PLUGINS.md` — the architecture decision these types encode:
 *   one control plane whether the implementation shipped with Iris or arrived
 *   from outside, the lifecycle contract, the trust model, and the list of
 *   what is not built. A dynamic extension contributes through this contract's
 *   install/activate paths and through the capability names its activation
 *   publishes; it does not register a second registry (that document's
 *   "Authority and scope").
 * - `docs/INFRASTRUCTURE-INTERFACES.md` — the maintained inventory of what a
 *   plugin can actually reach on `main`, §8 being the gap list. This package
 *   describes *what a plugin is and how it activates*; the runtime services a
 *   plugin might reach once active are one layer later in the paper stack.
 *   `scope.storage` — the private key–value namespace under the profile —
 *   crossed that layer and exists as of the `dev/plugin-scope-storage` round
 *   (this file's `PluginStorage`); the event tap, the generation-pipeline
 *   hooks and a contributed settings face still do not exist. Documents go
 *   stale; a comment sits in the reader's hands, so this one names the commit
 *   the answer changed in rather than letting "none of them exists yet" stand
 *   past its truth.
 *
 * Dependencies, by contract: none of Iris's. The Cordis import is type-only —
 * the activation scope hands a plugin its host context, and Cordis is the
 * framework a plugin is written against. A runtime import added here would
 * widen what the contract drags into every consumer, so a source scan pins the
 * rule (`tests/contract.test.ts`).
 *
 * @module @iris/plugin-api
 */
import type { Context, Disposable } from '@deepseek-ai/cordis'

/** One implementation available in the host's local system-plugin catalog. */
export interface SystemPluginDefinition {
  id: string
  name: string
  description: string
  version: string
  apiVersion: 1
  dependencies?: readonly string[]
  activate(scope: SystemPluginActivationScope): void | Disposable | Promise<void | Disposable>
}

/**
 * What `registerRpc` needs of a request schema: the one reading the host's
 * request validation does.
 *
 * Declared structurally — not as some library's schema type — because this
 * package imports nothing at runtime and no Iris package at all (its own
 * contract test pins both), while `@iris/protocol`'s runtime registry states
 * the same shape for the host side. The two are one contract written in two
 * packages that must not depend on each other, like the purity tests
 * `@iris/text` and the compat core each carry a copy of. A zod schema
 * satisfies this as-is.
 */
export interface ScopedRequestSchema<T = unknown> {
  /** Validate one raw body, discriminated rather than throwing. */
  safeParse(input: unknown): { success: true, data: T } | { success: false, error: { issues: readonly { message?: string }[] } }
}

/**
 * The incarnation fence a controlled frame attaches to a request it sends.
 *
 * The wire type lives in `@iris/protocol` (`PluginRevisionRequest`); this is
 * the same one field, restated here for the same reason the schema shape
 * above is — the contract package cannot import it, and widening it would be
 * a protocol change anyway.
 */
export interface ScopedPluginRevision {
  pluginRevision?: number
}

/**
 * A message-layer variable table.
 *
 * `@iris/variables`' `Variables` restated here in the same shape for the same
 * reason `ScopedRequestSchema` is: the contract package imports no `@iris`
 * package at all (`tests/contract.test.ts`), so the one type exists twice,
 * once per side of the dependency the tree forbids.
 */
export type PluginVariableTable = Record<string, unknown>

/** One generation's kind, named and valued as the protocol's `chat.send` kind. */
export type VariableWriteKind = 'send' | 'regenerate' | 'continue' | 'impersonate'

/**
 * Everything one settlement shows a variable writer. Constructed by the host,
 * read-only, and not reused across settlements.
 */
export interface VariableWriteView {
  readonly chatId: string
  /** The turn the settled reply landed on. */
  readonly turn: number
  readonly kind: VariableWriteKind
  /** Whether the generation ran to completion or was stopped. A stopped turn still settles the text it has. */
  readonly reason: 'completed' | 'aborted'
  /** The settlement text, past trim and the ST-compat rewrite — the text about to be stored. */
  readonly text: string
  /** This turn's message-layer table, as every writer's proposal finds it. */
  readonly baseline: PluginVariableTable
  /**
   * A stored table from an earlier turn; `undefined` when that turn has no
   * candidate to carry one. Writers that inherit state walk backwards through
   * this — a bare `turn` number would not let them.
   */
  variablesAt(turn: number): PluginVariableTable | undefined
  /** The table the card and its world books declare, before any turn. */
  readonly declared: PluginVariableTable
  /** Aborted when the settlement's budget for this writer runs out. Ignoring it does not save the writer; the host stops listening either way. */
  readonly signal: AbortSignal
}

/** One writer's answer for one settlement. */
export interface VariableWriteProposal {
  /** The complete table this writer wants stored for the turn. */
  variables: PluginVariableTable
  /**
   * Diagnostic lines the writer produced on the way. The host reports them
   * under its own metadata — a chat and a character belong to the settlement,
   * not to the activation, so the writer cannot fill them and only supplies
   * the sentences.
   */
  readonly reports?: readonly string[]
  /**
   * Which report kind the lines belong to, as a **plain string** on purpose:
   * the host's kind union is its own, and this package imports nothing to
   * name it. The host checks the spelling against its union and files an
   * unknown kind under its generic variables kind.
   */
  readonly reportKind?: string
}

/**
 * One plugin's variable contribution, registered through its activation scope.
 *
 * The two methods answer two different questions, and both exist because two
 * real writers disagree about the first: one baseline is the turn's own
 * message table, the other is the nearest earlier turn's state tree walked
 * backwards from `variablesAt` with `declared` as the floor. Only the writer
 * knows which table its proposal is a delta against.
 */
export interface VariableWriter {
  /** The table this writer's proposal is a delta from. */
  baselineFor(view: VariableWriteView): PluginVariableTable
  /** The proposal: a complete table, or `undefined` to write nothing this turn. */
  propose(view: VariableWriteView): VariableWriteProposal | undefined
    | Promise<VariableWriteProposal | undefined>
}

/** The variable-write face one activation owns. */
export interface PluginVariableFace {
  /**
   * Register one variable writer; the returned disposer removes it and is
   * idempotent. The host also removes it when this activation is disposed, so
   * a plugin that ignores the disposer still cannot write past its fiber.
   * Order across writers is activation order — dependencies before
   * dependents, same depth by id — and a later writer's delta wins.
   */
  registerWriter(writer: VariableWriter): () => void
}

/**
 * A JSON value, as `JSON.parse` can produce and `JSON.stringify` can write.
 *
 * This is the *whole* of what {@link PluginStorage.set} accepts: a class
 * instance, a function, a symbol or a non-finite number is refused by the
 * host before it reaches a file, because the store's only reader is
 * `JSON.parse` and a value that cannot survive that round trip would be a
 * save the plugin cannot get back.
 */
export type PluginJsonValue =
  | string
  | number
  | boolean
  | null
  | PluginJsonValue[]
  | { [key: string]: PluginJsonValue }

/**
 * One plugin's private key–value store under the profile.
 *
 * Keys are flat strings following the same grammar an extension id follows
 * (`^[a-z0-9][a-z0-9._-]{0,63}$`); each key is one file, and no plugin can
 * see another's keys. Every method is async and every refusal is a thrown
 * `Error` whose `code` names the reason: a key that breaks the grammar, a
 * value over the size ceiling or a write after the host unloaded answers
 * `invalid-request`, and a write from an activation that has been replaced
 * or disabled answers `unsupported`.
 */
export interface PluginStorage {
  /**
   * Read one key.
   *
   * `undefined` answers "never stored" **and** "stored but the file on disk
   * is damaged" — deliberately one answer, because the plugin cannot act on
   * the second fact and the host reports the damaged file to *its* diagnostics
   * instead. Narrow the result yourself; the bytes on disk were written by
   * whatever version of this plugin ran last, so their shape is not something
   * the type can promise.
   */
  get(key: string): Promise<unknown>
  /** Write one key, replacing any value already there. */
  set(key: string, value: PluginJsonValue): Promise<void>
  /** Remove one key. Removing a key that was never stored is not an error. */
  delete(key: string): Promise<void>
  /** This plugin's keys, sorted. */
  keys(): Promise<string[]>
}

/** The lifetime passed to a registered implementation during activation. */
export interface SystemPluginActivationScope {
  readonly context: Context
  readonly pluginId: string
  /** The snapshot revision that will identify this activation once it commits. */
  readonly revision: number
  /** Publish a capability owned by this activation's Cordis child fiber. */
  provide<T>(name: string, value: T): () => void
  /** Read a capability from one of this definition's declared dependencies. */
  getDependency<T>(pluginId: string, name: string): T | undefined
  /**
   * The variable-write face this activation owns. Present from the batch that
   * closes `docs/INFRASTRUCTURE-INTERFACES.md` §8's 「插件可写变量」 row; the
   * parallel `storage` member, when it lands, slots before this one.
   */
  readonly variables: PluginVariableFace
  /**
   * Register one RPC method this activation owns.
   *
   * The two halves a dynamic method needs — the request schema in the
   * protocol's runtime registry, the handler on the transport — are taken
   * together, so a method is never half-registered: a name already spoken for
   * (built-in or another registration) throws inside `activate`, where it
   * fails this plugin's own activation and nothing else. The returned
   * disposer removes both halves and is idempotent; the host also removes
   * them when this activation is disposed, so a plugin that ignores the
   * disposer still cannot outlive its fiber.
   *
   * Each call is admitted through this plugin's lease: while the plugin is
   * enabled the handler runs between a lease taken and released (so a disable
   * waits for in-flight calls), a stale `pluginRevision` on the request is
   * refused, and once the plugin is disabled the method answers `unsupported`
   * — the same refusal an absent method gets.
   *
   * Deliberate refusals from inside the handler: throw an `Error` carrying a
   * `code` from the protocol's fixed set (`not-found`, `invalid-request`,
   * `busy`, `unsupported`, ...); anything else reports as `internal`.
   *
   * @param method - the method name, unique across the whole composition.
   * @param schema - validates the method's params; the host reads only
   *   `safeParse`, so any schema library whose result matches works.
   * @param handler - receives the validated params, fence included.
   * @returns the disposer removing the registration.
   */
  registerRpc<T>(
    method: string,
    schema: ScopedRequestSchema<T>,
    handler: (params: T & ScopedPluginRevision) => unknown,
  ): () => void
  /**
   * This plugin's private store under the profile, declared by listing
   * `plugin-storage` in the manifest's `iris.plugin.permissions`.
   *
   * Unlike the other permission names, this one is a boundary and not only a
   * declaration: a plugin that skips it still has every other reach, but
   * calling any method here throws a named error instead of working. The
   * methods keep the interface's shape even when refused — a plugin that
   * captured `scope.storage` and calls it after being disabled gets a thrown
   * error naming why, never a silent no-op and never a different member.
   */
  readonly storage: PluginStorage
}

/** A lease held by work that started in one enabled plugin incarnation. */
export interface SystemPluginLease {
  readonly pluginId: string
  readonly revision: number
  readonly incarnation: number
  isCurrent(): boolean
  assertCurrent(): void
  release(): void
}

/** Runtime construction options. */
export interface SystemPluginRuntimeOptions {
  context: Context
  file: string
  definitions: readonly SystemPluginDefinition[]
  /** Defaults used only when the preference file does not exist. */
  defaultEnabled?: readonly string[]
  /**
   * The profile's `plugin-data` directory, where each activated plugin's
   * {@link PluginStorage} files live (`<root>/<pluginId>/<key>.json`).
   *
   * Absent means this runtime provides no storage at all: `scope.storage`
   * stays on the interface (it is not optional, so a plugin never has to
   * wonder) but every method throws a named error saying the host has no
   * plugin data root. Production always passes one; a runtime constructed by
   * a lifecycle test that never touches storage omits it.
   */
  pluginDataRoot?: string
  onError?: (error: Error) => void
  /** Persistence seam used by lifecycle tests; production uses atomic replacement. */
  writePreferences?: (file: string, contents: string) => Promise<void>
}
