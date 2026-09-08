/**
 * The `z` global, kept answering through a card's own overwrite.
 *
 * **The seed decision this defends.** The preset publishes zod as the
 * **namespace** (`preset-entry.ts`), because a real card's helper dereferences
 * `z` → `.z` → `.ZodObject`, and the namespace is the shape that answers both
 * that and the bare spelling. That choice is about the *shape*, and it was
 * measured on the installed npm zod — where `ns.z` is itself a named export of
 * the namespace.
 *
 * **The measured break.** 人贩子物语's variable-schema script imports zod
 * itself — `({ z: zodZ } = await import('https://cdn.jsdelivr.net/npm/zod/v4/+esm'))`,
 * through the host's bundle proxy — and hangs the result on `globalThis.z`
 * before importing `mvu_zod.js`, whose module top level reads that global. But
 * the **named export** is not the namespace: measured on both the jsDelivr
 * rollup build and the npm package it is a frozen bag carrying `ZodObject`,
 * `looseObject`, `object`, `prettifyError`… and **no `.z`** — the self-reference
 * lives on the namespace, not on the export. So the helper's
 * `t instanceof r.z.ZodObject` read `.z` of a copy that does not have it, and
 * the card died with `Cannot read properties of undefined (reading
 * 'ZodObject')` before its variable schema ever registered. The overwrite is
 * the card's own doing and happens in upstream's frames too; what differs here
 * is only that the seed this sandbox published had already worked out the
 * right shape, and the card threw that work away.
 *
 * **The mechanism.** `z` is published as an **accessor**, not a data property.
 * A card's overwrite is stored and answered exactly as stored — except when the
 * stored value is zod-shaped and missing `.z`, in which case reads answer
 * through a view that owns one member, `z`, and inherits everything else from
 * the copy. That view *is* the namespace shape the seed chose, reconstructed
 * over whatever copy a card brought: `r.z.looseObject(t.shape)` resolves, and
 * `instanceof r.z.ZodObject` sees the very class the card's own schemas were
 * built from. Anything else a card assigns — a full namespace, a number, a
 * marker object — reads back identically, because the defense has nothing to
 * say about values that are not the one-spelled shape.
 *
 * Prototype layering rather than a `Proxy`, for the reason `zod-compat.ts`
 * records and one more: a namespace is `Object.freeze({__proto__:null,…})`, so
 * the missing member **cannot** be defined onto the copy itself, and a Proxy
 * would hand back fresh function identities on every read where layering
 * inherits the copy's own.
 *
 * The prefault-chaining compat (`zod-compat.ts`) stays installed on the seed's
 * prototypes only. A card's own copy chains or not by its own version — the
 * measured card builds all of its schemas with its copy successfully, and the
 * one thing it could not do was read the global's spelling.
 *
 * @module iris-web/sandbox/zod-global
 */

/**
 * Whether a value is a zod copy that cannot answer the `.z` spelling.
 *
 * Deliberately narrow, because the getter runs on every bare `z` read in the
 * realm, diagnostics included: only an object that carries the classic
 * namespace's members (`ZodObject`) but no `.z` gets a view. The npm namespace
 * (`ns.z` is the named export), a future zod that adds the self-reference to
 * the export, and every non-zod value fail this test and read back as stored.
 * @param value - whatever a card last assigned to the global.
 * @returns true when a spelling view is the honest answer.
 */
function isOneSpelledZod(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate['z'] === undefined && typeof candidate['ZodObject'] === 'function'
}

/**
 * Publish `z` on a frame's global with the spelling defense.
 *
 * Call once from the preset entry, before any card body can run: the seed is
 * the namespace, the setter accepts whatever a card assigns, and the getter
 * answers it under the shape contract the seed was chosen for.
 * @param target - the frame global to define the name on.
 * @param seed - the zod namespace this bundle ships.
 */
export function publishZodGlobal(target: Record<string, unknown>, seed: object): void {
  let current: unknown = seed
  /** One view per copy, so repeated reads of the global keep their identity. */
  const views = new WeakMap<object, object>()
  Object.defineProperty(target, 'z', {
    enumerable: true,
    configurable: true,
    get: (): unknown => {
      if (!isOneSpelledZod(current)) return current
      const copy = current
      const cached = views.get(copy)
      if (cached !== undefined) return cached
      const view: object = Object.create(copy, {
        z: { enumerable: false, get: (): object => copy },
      })
      views.set(copy, view)
      return view
    },
    set: (value: unknown): void => {
      current = value
    },
  })
}
