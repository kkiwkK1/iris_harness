/**
 * Saying which jQuery plugin method a card reached for, without shipping it.
 *
 * jQuery UI and touch-punch are not in the message preset: measured at zero uses
 * across the corpus by two independent probes, against 316 KB that every message
 * frame fetches cold — the HTTP cache is partitioned by origin and each of these
 * frames is its own opaque origin.
 *
 * A card that wants one still gets `undefined`, which is precisely what it would
 * get from a SillyTavern install without the plugin. What Iris adds is a report
 * naming the method, so an absence that would otherwise surface three steps later
 * as `x is not a function` is stated where it happened.
 *
 * **Why `undefined` and not a stub that throws.** A stub has to be a function to
 * be callable, and a function is truthy, so every guard a careful card writes —
 * `if ($.fn.draggable)`, `typeof $el.draggable === 'function'` — would pass and
 * then the call would explode. The guard would trigger the thing it exists to
 * prevent. That is the same failure the `SillyTavern` surface had in mirror
 * image, where a throwing getter defeated truthiness guards; the fix there was
 * `undefined` plus a report, and this is that rule reaching a second surface.
 *
 * Nothing here enumerates jQuery UI's methods. A list taken from the package
 * would have to be read out of the package we are removing, and it would freeze
 * against whatever version happened to be installed the day it was written. This
 * catches *any* name jQuery does not have, so it covers touch-punch, any other
 * plugin dropped later, and a plain typo — all with one rule and no maintenance.
 *
 * @module iris-web/sandbox/jquery-plugin-gap
 */

/** What the interception needs from its surroundings. */
export interface JQueryGapEnv {
  /** The jQuery function, or whatever stands in for it. */
  jquery?: { fn?: object } | undefined
  /** Say that a card reached for something absent. Deduplicated here. */
  report: (message: string) => void
}

/**
 * Insert a reporting layer beneath `jQuery.fn`.
 *
 * The proxy goes **between** `jQuery.fn` and `Object.prototype`, so it sees only
 * lookups that jQuery itself did not satisfy. Real methods never reach it and
 * cannot be affected by it.
 *
 * Symbols and `Object.prototype` members are forwarded rather than reported:
 * `Symbol.iterator`, `toString`, `hasOwnProperty` and friends are read by the
 * language and by any code that stringifies or iterates a jQuery object, so
 * reporting them would bury the real signal under traffic no card generated.
 * @param env - jQuery and where to report.
 * @returns true when the layer was installed.
 */
export function installJQueryGapReporter(env: JQueryGapEnv): boolean {
  const fn = env.jquery?.fn
  if (fn === undefined || fn === null || typeof fn !== 'object') return false

  const said = new Set<string>()
  const beneath = Object.getPrototypeOf(fn) as object | null

  Object.setPrototypeOf(
    fn,
    new Proxy(Object.create(null) as object, {
      get(_target, property, receiver): unknown {
        /*
         * Forwarded, not reported. These are the language's own reads and the
         * reads of anything that stringifies or iterates a jQuery object; a card
         * asked for none of them.
         */
        if (typeof property === 'symbol') return Reflect.get(Object.prototype, property, receiver)
        if (property in Object.prototype) return Reflect.get(Object.prototype, property, receiver)

        if (!said.has(property)) {
          said.add(property)
          env.report(
            `a card read $.fn.${property}, which this frame's jQuery does not have`
              + ' — jQuery UI and touch-punch are not in the message preset',
          )
        }
        /*
         * `undefined`, so a card's own feature test works and it takes the same
         * fallback it would take on an install without the plugin. The report is
         * what turns that silence into a fact somebody can act on.
         */
        return undefined
      },

      /*
       * `has` answers for `in` without reporting: `'draggable' in $el` is a
       * question, not a use, and answering it truthfully is the whole point.
       */
      has(_target, property): boolean {
        return typeof property !== 'symbol' && property in Object.prototype
      },
    }),
  )

  // Kept for the disposer's sake: restoring is only meaningful if the original
  // link is known, and reading it after the swap would read the proxy.
  RESTORE.set(fn, beneath)
  return true
}

/** Original prototypes, so an installation can be undone in a test. */
const RESTORE = new WeakMap<object, object | null>()

/**
 * Undo `installJQueryGapReporter`.
 * @param fn - the `jQuery.fn` that was wrapped.
 * @returns true when something was restored.
 */
export function removeJQueryGapReporter(fn: object): boolean {
  if (!RESTORE.has(fn)) return false
  Object.setPrototypeOf(fn, RESTORE.get(fn) ?? Object.prototype)
  RESTORE.delete(fn)
  return true
}

/**
 * Install the reporter against the frame's real jQuery, if there is one.
 *
 * Separate from the implementation so the mechanism can be tested without a
 * browser: this half knows about `globalThis`, and the half above does not.
 * @returns true when the layer was installed.
 */
export function reportMissingJQueryPlugins(): boolean {
  const scope = globalThis as unknown as Record<string, unknown>
  const jquery = (scope['jQuery'] ?? scope['$']) as { fn?: object } | undefined
  return installJQueryGapReporter({
    jquery,
    report: message => {
      /*
       * Straight to the frame's own error channel, which the shell already
       * forwards into the card report list. Written as a bare `console` call
       * rather than through the sandbox bridge because this runs inside the
       * preset bundle, which is loaded before the bridge exists.
       */
      // eslint-disable-next-line no-console
      console.warn(`[iris] ${message}`)
    },
  })
}
