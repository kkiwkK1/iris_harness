/**
 * `localStorage`, for a frame that has none.
 *
 * An opaque origin has no storage, and the failure is not a missing method — it
 * is the **property access itself**. Measured in a real `sandbox="allow-scripts"`
 * frame: `window.localStorage` throws `SecurityError`, and so does
 * `typeof localStorage`, which is the shape that matters most. `@vue/devtools-kit`
 * guards with `typeof localStorage > 'u'` and pinia pulls it in, so every card
 * using pinia takes that path — the guard cannot help, because reading the
 * property to decide is the thing that throws.
 *
 * So this is installed as an **own property of `window`**, before any card code.
 * The same measurement says that works and says why cleanly: `localStorage` is
 * an own, configurable property of `window` (nothing on `Window.prototype`), so
 * one `defineProperty` shadows it, after which `typeof localStorage` is
 * `'object'` and bare-identifier access works. `sessionStorage`, left alone in
 * the same probe, still throws — which is what makes the reading a measurement
 * of the shadow rather than of a frame that happened to have storage.
 *
 * **The scope is the whole profile, shared, and that is compatibility rather
 * than an oversight.** Upstream's cards share one origin's `localStorage`, so
 * two cards choosing one key see each other's values; 44 measured four keys
 * (wallpaper, floating-button position) shared between 银麒赎世 and
 * 魔法少女的扣扣审判 today. Cross-card bleed is therefore faithful behaviour and
 * belongs in the compatibility ledger, not in a bug list — "my wallpaper changed
 * when I switched cards" is not a regression to fix.
 *
 * **Synchronous reads, written through asynchronously.** The API upstream
 * exposes is synchronous and 44 found four bare module-top-level accesses, so
 * the values have to be in the frame before card code runs: they arrive with the
 * context snapshot for a script frame and by a push after load for an interface
 * frame. Writes go to the host and cannot be awaited by a caller that has none —
 * so a local overlay answers the next read, and a rejected write is reported.
 *
 * @module iris-web/sandbox/card-storage
 */

/** What the facade needs from its frame. */
export interface StorageHost {
  /** The store as the host last sent it. */
  snapshot: () => Record<string, string>
  /**
   * Write one key through to the host.
   *
   * Rejection is the facade's to report; the caller has already been answered.
   */
  write: (key: string, value: string) => Promise<void>
  /** Remove one key. */
  remove: (key: string) => Promise<void>
  /** Empty the store, including other cards' keys. */
  clear: () => Promise<{ removed: number, foreign: number }>
  /** Say something on the storage channel. */
  report: (message: string, failed: boolean) => void
}

/**
 * The profile-wide ceiling, mirrored here so `setItem` can throw when upstream's
 * would.
 *
 * The host enforces it authoritatively; this copy exists because upstream's
 * `setItem` throws **synchronously** and a write here is answered before the
 * host has seen it. Two enforcers of one rule is a smell in general and is
 * accepted here for a specific reason: the rule is a sum of string lengths, not
 * a policy, so the copies cannot drift in behaviour — only in what they can see.
 * This one sees the snapshot plus this frame's own writes; the host also sees
 * writes other frames made since. When they disagree the host wins and the
 * rejection is reported, one round later.
 *
 * 10 MiB, corroborated rather than assumed: filling this app's own dev origin,
 * the browser refused the write that would have taken it past **9.5 MiB** of
 * probe data on top of what was already there — the same ceiling 49's host half
 * enforces. It is *more* likely to bind here than upstream, because everything
 * upstream spread across several origins lands in one.
 *
 * **Not a latch.** The same measurement shows a one-character write succeeding
 * while the store is otherwise full, so being over the line is a property of the
 * write rather than a state the store enters. Every `setItem` here is checked on
 * its own merits for that reason, and a card that frees space by overwriting a
 * large key with a small one is not left refused.
 */
export const STORAGE_QUOTA_BYTES = 10 * 1024 * 1024

/**
 * How much of the quota a store occupies.
 *
 * Keys count, not only values: the browser's accounting includes them, and a
 * card generating keys at runtime — which 44 found all of them do — can spend
 * real space on names alone. UTF-16 code units, the unit browsers charge in.
 * @param store - the store to measure.
 * @returns the size in bytes.
 */
export function storageBytes(store: Record<string, string>): number {
  let total = 0
  for (const [key, value] of Object.entries(store)) total += (key.length + value.length) * 2
  return total
}

/**
 * A `QuotaExceededError` shaped like the one the browser actually throws.
 *
 * **Measured rather than recalled.** Filling this app's own dev origin until
 * `setItem` refused, the throw reads:
 *
 * ```
 * constructor.name        QuotaExceededError
 * name                    QuotaExceededError
 * code                    22
 * instanceof DOMException true
 * ```
 *
 * — and the browser exposes a constructible `QuotaExceededError` interface that
 * reproduces all four. `new DOMException(msg, 'QuotaExceededError')` matches
 * three of them and differs on `constructor.name`, which is the reason for the
 * ladder below rather than a preference: each tier is measurably closer than the
 * next, and the first tier is exact.
 *
 * Upstream has **zero** places that catch this — 3c checked SillyTavern and
 * Tavern Helper both, and `f-localStorage.js`'s helpers are deprecated with no
 * callers — so no measured card consumes the shape. What the cards consume is
 * whether it throws at all: 44 found 89 `setItem` calls with no error checking,
 * and the one card that can reach the quota wraps its write in an **empty
 * catch** and then unconditionally toasts "已设为壁纸".
 *
 * That last detail is why the report matters more than the exception, and it is
 * recorded here rather than beside the report because it is the reason this
 * function is not the whole answer: the card's own success message is a lie the
 * reader sees, and a refusal that does not outrank it leaves them believing the
 * wallpaper was saved until a later load silently shows the old one.
 * @param message - what to say.
 * @returns the error to throw.
 */
function quotaError(message: string): Error {
  const named = (globalThis as { QuotaExceededError?: new (message: string) => Error })
    .QuotaExceededError
  // Exact: same constructor, name and code as a real `setItem` refusal.
  if (typeof named === 'function') return new named(message)
  // Close: name, code and `instanceof DOMException` match; `constructor.name`
  // reads `DOMException`. Nothing measured looks at the constructor.
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'QuotaExceededError')
  }
  // Under `node --test` there is neither. The name is what a consumer would
  // check, so it is set explicitly rather than inherited.
  const error = new Error(message)
  error.name = 'QuotaExceededError'
  return error
}

/** The `Storage` surface a card sees, plus arbitrary keys. */
export type CardStorage = Storage & Record<string, unknown>

/**
 * Build the storage a card frame provides.
 *
 * Returned as a `Proxy` rather than a plain object because both spellings are
 * live: 44's four bare startup points are **property** accesses
 * (`localStorage.x`), and the rest of the corpus uses `getItem`/`setItem`. A
 * plain object with the methods would answer half the corpus and silently
 * return `undefined` for the other half.
 *
 * @param host - the frame's storage channel.
 * @returns the object to install as `window.localStorage`.
 */
export function createCardStorage(host: StorageHost): CardStorage {
  /*
   * Writes this frame has made, over the top of the host's snapshot.
   *
   * Without it "write then read" fails inside one frame: the snapshot is
   * whatever the host last sent, and it does not include the write that just
   * happened. `null` marks a removal, so a key removed here stops being visible
   * even while the snapshot still carries it.
   */
  const overlay = new Map<string, string | null>()
  let cleared = false

  /** The store as this frame sees it: the snapshot, plus what it has done. */
  const view = (): Record<string, string> => {
    const store: Record<string, string> = cleared ? {} : { ...host.snapshot() }
    for (const [key, value] of overlay) {
      if (value === null) delete store[key]
      else store[key] = value
    }
    return store
  }

  const read = (key: string): string | null => {
    const store = view()
    return Object.hasOwn(store, key) ? store[key] ?? null : null
  }

  const setItem = (key: string, value: string): void => {
    const next = String(value)
    const name = String(key)

    /*
     * The ceiling is checked against the store **with this write applied**, not
     * against the store plus the new value: a card overwriting its own wallpaper
     * with a smaller one must not be refused for the size of the one it is
     * replacing.
     */
    const after = { ...view(), [name]: next }
    const size = storageBytes(after)
    if (size > STORAGE_QUOTA_BYTES) {
      const message =
        `${name} (${describeBytes((name.length + next.length) * 2)}) was not written:`
        + ` the cards' shared storage is full (${describeBytes(size)} of`
        + ` ${describeBytes(STORAGE_QUOTA_BYTES)}). It is shared across every card in this`
        + ` profile, so the card that ran out may not be the one that filled it.`
      /*
       * Reported **and** thrown, and the report is the half that reaches a
       * reader. The one card that can hit this catches the throw with an empty
       * block and then says "已设为壁纸" regardless, having already changed the
       * DOM — so the card's own success message is on screen and wrong. A
       * refusal that does not outrank it leaves the reader believing the write
       * happened until a later load silently shows the old value.
       */
      host.report(message, true)
      throw quotaError(message)
    }

    overlay.set(name, next)
    void host.write(name, next).then(undefined, (error: unknown) => {
      /*
       * The overlay is **not** rolled back. The card was told the write
       * succeeded and has moved on; taking the value away afterwards would make
       * a later read disagree with what the card believes it stored, which is
       * harder to reason about than a value that is durable in this frame and
       * absent on the next load. The report says which it is.
       */
      host.report(
        `${name} was written in this frame but the host refused to store it: `
        + (error instanceof Error ? error.message : String(error))
        + ' — it will be gone when this chat is opened again',
        true,
      )
    })
  }

  const removeItem = (key: string): void => {
    const name = String(key)
    overlay.set(name, null)
    void host.remove(name).then(undefined, (error: unknown) => {
      host.report(
        `${name} was removed in this frame but the host refused: `
        + (error instanceof Error ? error.message : String(error)),
        true,
      )
    })
  }

  const clear = (): void => {
    /*
     * The whole store goes, other cards' keys included, because that is what
     * `clear()` does to an origin upstream. The **report is the only channel**
     * that can tell a user what a card just wiped — upstream wipes them with no
     * way to attribute the loss — so it is made before the host answers, and
     * amended with the host's count when it does.
     */
    const keys = Object.keys(view())
    cleared = true
    overlay.clear()
    host.report(
      `a card called localStorage.clear(), emptying the ${String(keys.length)} keys this frame`
      + ` could see: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}`
      + ' — the store is shared across every card in this profile, so keys other cards wrote'
      + ' are gone too',
      false,
    )
    void host.clear().then(
      ({ removed, foreign }) => {
        if (foreign > 0) {
          host.report(
            `that clear() removed ${String(removed)} keys, ${String(foreign)} of which another`
            + ' card had written',
            false,
          )
        }
      },
      (error: unknown) => {
        host.report(
          'a card called localStorage.clear() and the host refused: '
          + (error instanceof Error ? error.message : String(error)),
          true,
        )
      },
    )
  }

  const api: Record<string, unknown> = {
    getItem: (key: unknown) => read(String(key)),
    setItem: (key: unknown, value: unknown) => {
      setItem(String(key), String(value))
    },
    removeItem: (key: unknown) => {
      removeItem(String(key))
    },
    clear,
    /**
     * The nth key, in the order the store enumerates.
     *
     * Upstream's order is the browser's and is not specified; ours is
     * `Object.keys` of the merged view. A card that depends on the order of
     * `key(n)` is depending on unspecified behaviour on both hosts — noted
     * rather than stabilised, because stabilising it would be Iris promising
     * something no real browser does.
     */
    key: (at: unknown) => Object.keys(view())[Number(at)] ?? null,
  }

  return new Proxy(api, {
    get(target, property): unknown {
      if (typeof property === 'symbol') return Reflect.get(target, property)
      // `length` is a live count, not a stored key, and a card storing a key
      // called "length" cannot shadow it — same as a real `Storage`.
      if (property === 'length') return Object.keys(view()).length
      if (Object.hasOwn(target, property)) return target[property]
      /*
       * A missing key is `undefined` through a property and `null` through
       * `getItem`, exactly as on a real `Storage`. The difference looks like a
       * detail and is load-bearing for the guard shape 44 found: a card writing
       * `localStorage.x || fallback` behaves the same either way, but one
       * writing `'x' in localStorage` or `localStorage.x === null` does not.
       */
      const value = read(property)
      return value === null ? undefined : value
    },
    set(target, property, value): boolean {
      if (typeof property === 'symbol') return Reflect.set(target, property, value)
      /*
       * Assigning over a method is refused rather than honoured. A real
       * `Storage` lets `localStorage.getItem = 1` shadow the method, and copying
       * that would let one card's typo disable storage for every script in the
       * frame — a compatibility detail nothing measured relies on, traded for a
       * failure mode that would be very hard to read.
       */
      if (Object.hasOwn(target, property) || property === 'length') {
        host.report(
          `a card assigned to localStorage.${property}, which is part of the storage API here`
          + ' — the assignment was ignored rather than replacing the method',
          false,
        )
        return true
      }
      setItem(property, String(value))
      return true
    },
    deleteProperty(target, property): boolean {
      if (typeof property === 'symbol') return Reflect.deleteProperty(target, property)
      if (Object.hasOwn(target, property)) return false
      removeItem(property)
      return true
    },
    has(_target, property): boolean {
      if (typeof property === 'symbol') return false
      return property === 'length' || Object.hasOwn(api, property)
        || Object.hasOwn(view(), property)
    },
    /** So `Object.keys(localStorage)` lists the stored keys, as on a real one. */
    ownKeys(): ArrayLike<string | symbol> {
      return Object.keys(view())
    },
    getOwnPropertyDescriptor(_target, property): PropertyDescriptor | undefined {
      if (typeof property !== 'string') return undefined
      const value = read(property)
      if (value === null) return undefined
      return { value, writable: true, enumerable: true, configurable: true }
    },
  }) as CardStorage
}

/**
 * A byte count a reader can act on.
 *
 * Named sizes rather than raw bytes because the numbers in these reports are
 * megabytes — "2411724 bytes were not written" is a number a reader has to
 * convert before it means anything.
 * @param bytes - the count.
 * @returns a short human figure.
 */
export function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${String(bytes)} bytes`
}
