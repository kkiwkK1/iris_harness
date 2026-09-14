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
 * The vocabulary is shared with the third-party extension design — its
 * contract document, `docs/EXTENSIONS`, lives on the
 * `dev/feat-extension-system` branch — not duplicated by it. That document
 * describes the *runtime
 * services* a plugin may reach once it is active — a storage namespace under
 * the profile, an event tap, the generation-pipeline hooks, a contributed
 * settings face — and is written for extensions that arrive the privileged
 * way: one npm package, one row. This package describes one layer earlier in
 * the paper stack, *what a plugin is and how it activates*, which is the same
 * control plane whether the implementation shipped with Iris or came from
 * outside it. The two documents meet in these types rather than growing a
 * second vocabulary: the `apiVersion` on a `SystemPluginDefinition` is the
 * same versioning device as the `iris.apiVersion` an extension manifest
 * declares, and the rule for breaking either is the same — a new version,
 * never an in-place edit. A dynamic extension contributes through this
 * contract's install/activate paths and through the capability names its
 * activation publishes; it does not register a second registry
 * (`docs/SYSTEM-PLUGINS.md`, Authority and scope).
 *
 * Dependencies, by contract: none of Iris's. The Cordis import is type-only —
 * the activation scope hands a plugin its host context, and Cordis is the
 * framework a plugin is written against, which is the same dependency set the
 * extension design's §2.1 grants an extension package. A runtime import
 * added here would widen what the contract drags into every consumer, so a
 * source scan pins the rule (`tests/contract.test.ts`).
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
  onError?: (error: Error) => void
  /** Persistence seam used by lifecycle tests; production uses atomic replacement. */
  writePreferences?: (file: string, contents: string) => Promise<void>
}
