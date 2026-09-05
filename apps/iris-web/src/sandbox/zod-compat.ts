/**
 * `prefault()` chaining, made whole for the zod the frames are served.
 *
 * **The measured break.** A card's variable-structure script writes zod chains
 * of the shape
 *
 *     z.coerce.number().prefault(0).min(0).max(100)
 *
 * Under the zod Iris serves (4.x, matching upstream's own bundling), `.prefault()`
 * returns a `ZodPrefault` — a wrapper whose type carries none of the inner
 * schema's methods — so the next `.min` in the chain reads `undefined` and the
 * card dies with `…prefault(...).min is not a function`. This is not a
 * *regression against upstream*: the same chain breaks the same way against the
 * zod bundled inside the installed Tavern Helper. But cards were written
 * believing the chain works, and the corpus carries one (全职高手's 变量结构)
 * whose whole schema is built this way — 158 `prefault` sites, 5 of them
 * chained — while the other four `prefault`-using cards call it only at the
 * tail of a chain, where nothing follows and nothing breaks.
 *
 * **The mechanism.** Every classic schema prototype that owns `prefault` gets a
 * wrapper which hands back a **compatibility view** of the wrapper schema: a
 * proxy that answers with the wrapper's own members as before, and forwards any
 * method it does not have to the wrapped inner schema, re-applying the same
 * prefault to the result. So `.min(0)` reads as
 * `prefault(inner.min(0), defaultValue)` — a real `ZodPrefault` over the
 * constrained schema, which parses as the card author's chain reads, and is
 * itself chainable.
 *
 * **Semantics, written down because they are the contract.** The prefault value
 * is what the schema yields when the input is absent; constraints added after
 * it apply to that value as they apply to any other input — a chain of
 * `prefault(0).min(1)` refuses the absent case, exactly as it would upstream.
 * The measured card's five chains all carry prefault values that satisfy their
 * own constraints (`prefault(0).min(0)`, `prefault(100).min(0).max(100)`), so
 * the composed behaviour is what its author intended; nothing here invents a
 * clamp or otherwise "fixes" a contradictory chain — that would be an
 * approximate answer wearing a schema's clothes.
 *
 * **Why a proxy rather than a patch of `.min` itself:** the break is not
 * limited to the methods anyone has thought of. The wrapper lacks *every*
 * member of the inner schema, so a card could reach for `.int()`, `.safe()`,
 * `.trim()`, `.regex()` — forwarding by name would re-plant this same bug one
 * method at a time. The proxy is one mechanism that covers the family.
 *
 * **The install runs once.** `preset-entry.ts` calls this before publishing the
 * namespace; the prototype set is deduplicated by identity, so the double-proxy
 * indirection that a second pass over an already-patched prototype would build
 * cannot arise here, and the `WeakSet` of live views keeps a wrapped schema
 * from being wrapped again through any other path.
 *
 * @module iris-web/sandbox/zod-compat
 */

/** A classic zod schema, narrowed to the two members this module touches. */
interface CompatSchema {
  /** The v4 runtime introspection bag; `def.innerType` is the wrapped schema. */
  readonly _zod: {
    readonly def: {
      readonly innerType?: unknown
      readonly defaultValue: unknown
    }
  }
  [key: string]: unknown
}

/** Views already built, so a wrapped schema is never wrapped again. */
const views = new WeakSet<object>()

/**
 * Build the forwarding view over one `prefault` result.
 * @param schema - the `ZodPrefault` (or view) to wrap.
 * @returns a proxy answering the wrapper's members and forwarding the rest.
 */
function compatView(schema: CompatSchema): CompatSchema {
  if (views.has(schema)) return schema
  const proxy: CompatSchema = new Proxy(schema, {
    get(target, property): unknown {
      // Symbols are language machinery (`then`, spread, stringification), never
      // a schema method; pass them through untouched.
      if (typeof property !== 'string') {
        return Reflect.get(target, property, target)
      }
      const own = Reflect.get(target, property, target)
      if (own !== undefined) {
        return typeof own === 'function' ? (own as (...args: unknown[]) => unknown).bind(target) : own
      }
      const inner = target._zod.def.innerType
      if (inner === undefined || inner === null) return undefined
      const innerValue = Reflect.get(inner as object, property, inner as object)
      if (typeof innerValue !== 'function') return undefined
      return (...args: unknown[]): unknown => {
        // The inner schema's method builds the constrained schema; the same
        // prefault value is re-applied to it, so the chain composes exactly as
        // the author wrote it left to right.
        const next = (innerValue as (...args: unknown[]) => unknown).apply(inner as object, args)
        if (next === null || next === undefined || typeof next !== 'object') return next
        const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(next), 'prefault')
        if (descriptor === undefined) return next
        // `prefault` lives on the prototype as a lazy-binding getter (the WT
        // pattern): read it **through the receiver** so the binding lands on the
        // new schema, never on a captured prototype.
        const reapply = descriptor.get ? descriptor.get.call(next) : descriptor.value
        if (typeof reapply !== 'function') return next
        return compatView(
          (reapply as (value: unknown) => CompatSchema).call(next, target._zod.def.defaultValue),
        )
      }
    },
  })
  views.add(proxy)
  return proxy
}

/**
 * Wrap every classic `prefault` so its result is chainable.
 *
 * Called once from the preset entry, before the namespace is published. The
 * descriptor is read raw — a **getter**, in zod's own lazy-binding style, or a
 * plain value — and re-installed in the same shape, so the schema's own
 * machinery sees no difference in how `prefault` reaches it.
 * @param zod - the zod namespace the frames are served.
 * @returns how many distinct prototypes were wrapped.
 */
export function installPrefaultCompat(zod: object): number {
  const patched = new WeakSet<object>()
  let count = 0
  const probe = (schema: unknown): void => {
    if (schema === undefined || schema === null || typeof schema !== 'object') return
    const prototype = Object.getPrototypeOf(schema)
    if (prototype === null || patched.has(prototype)) return
    patched.add(prototype)
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'prefault')
    if (descriptor === undefined) return
    const rawGet = descriptor.get
    const rawValue = descriptor.value
    const installed: PropertyDescriptor = { configurable: true, enumerable: descriptor.enumerable ?? false }
    if (rawGet !== undefined) {
      // Typed `function` rather than an arrow so `this` is the schema the
      // property was read from, exactly as the original lazy getter expected.
      installed.get = function (this: unknown): unknown {
        return (value: unknown): unknown => compatView((rawGet.call(this) as (v: unknown) => CompatSchema)(value))
      }
    } else {
      installed.value = function (this: unknown, value: unknown): unknown {
        return compatView((rawValue as (this: unknown, v: unknown) => CompatSchema).call(this, value))
      }
    }
    Object.defineProperty(prototype, 'prefault', installed)
    count += 1
  }
  // One live instance per classic family the frames carry; the prototype set is
  // deduplicated, so overlapping families (z.number() vs z.coerce.number())
  // are wrapped exactly once.
  const z = zod as {
    string: () => unknown
    number: () => unknown
    coerce?: { number: () => unknown, string?: () => unknown }
    boolean: () => unknown
    any: () => unknown
    object: (shape: Record<string, never>) => unknown
    array: (schema: unknown) => unknown
    record: (key: unknown, value: unknown) => unknown
  }
  probe(z.string())
  if (z.coerce !== undefined) {
    probe(z.coerce.number())
    if (z.coerce.string !== undefined) probe(z.coerce.string())
  }
  probe(z.number())
  probe(z.boolean())
  probe(z.any())
  probe(z.object({}))
  probe(z.array(z.any()))
  probe(z.record(z.string(), z.any()))
  return count
}
