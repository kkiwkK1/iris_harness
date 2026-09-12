/**
 * The runtime half of the request-schema table.
 *
 * `requestSchemas` (`./rpc.ts`) is the static vocabulary: the methods this
 * protocol version was built knowing, written as a `const` literal so the
 * compiler holds the map and the exhaustiveness checks that read it. A system
 * plugin contributes methods at runtime, and the same boundary needs to
 * validate them — `notes/PLUGIN-CONTRACT-LANDING-SITES.md` 落点 1 — so the
 * schemas get a second, mutable table here, consulted by `parseRequest` only
 * after the static one misses.
 *
 * The rules mirror `IrisRpcHost.register` on purpose. A registration is
 * **refused** when the name is already spoken for — by this table or by the
 * static vocabulary — because which plugin answers a method is a
 * composition-level fact, and letting the later registration win would make
 * load order a contract. The returned disposer is identity-checked, so a
 * disposer that outlives its own replacement removes nothing. And the table
 * is module-global because both consulters — the host transport and the fake
 * client — must read the one table the other's process writes; a second
 * instance would be a second answer to "is this method real".
 *
 * @module @iris/protocol/rpc-registry
 */

import { requestSchemas } from './rpc.ts'

/**
 * What the registry needs of a schema: the one reading `parseRequest` does.
 *
 * Declared structurally — not as zod's `ZodType` — so `@iris/plugin-api` can
 * state the same shape for its `registerRpc` without importing zod or this
 * package (its contract test pins that it imports nothing of Iris's). Any zod
 * schema satisfies this as-is. `@iris/plugin-api` carries the plugin-facing
 * copy of this shape; the two are one contract stated in two packages that
 * must not depend on each other, and a field added here is added there or not
 * at all.
 */
export interface RuntimeRequestSchema<T = unknown> {
  /** Validate one raw body, discriminated rather than throwing. */
  safeParse(input: unknown): { success: true, data: T } | { success: false, error: { issues: readonly { message?: string }[] } }
}

/** The table itself. Names are unique across static and runtime vocabularies. */
const registry = new Map<string, RuntimeRequestSchema>()

/**
 * Register one runtime method's request schema.
 *
 * @param method - the method name. Must not collide with the static
 *   vocabulary or an existing runtime registration.
 * @param schema - validates the method's params the way a static schema does.
 * @returns the disposer removing the registration.
 * @throws {Error} when the name is already spoken for.
 */
export function registerRequestSchema(method: string, schema: RuntimeRequestSchema): () => void {
  if (method in requestSchemas) {
    throw new Error(`rpc registry: "${method}" is a built-in method and cannot be re-registered`)
  }
  if (registry.has(method)) {
    throw new Error(`rpc registry: a schema for "${method}" is already registered`)
  }
  registry.set(method, schema)
  return () => {
    // Identity-checked so a late disposer cannot evict a replacement a reload
    // installed after this one was torn down — the same rule the transport's
    // handler map follows.
    if (registry.get(method) === schema) registry.delete(method)
  }
}

/**
 * Read one runtime registration.
 * @param method - the method name.
 * @returns the schema, or `undefined` when the name is not runtime-registered.
 */
export function lookupRequestSchema(method: string): RuntimeRequestSchema | undefined {
  return registry.get(method)
}
