/**
 * Pure text utilities that two trust domains must compute identically.
 *
 * The membership rule, because a package named `text` will otherwise collect
 * anything string-shaped:
 *
 * **What belongs here.** A function whose answer the host and the browser frame
 * must agree on *exactly*, and which needs nothing but the language to compute
 * it. `stringHash` is the case that names the rule — a card registers a button
 * listener under `${scriptId}_${hash(name)}` and the host fires the event under
 * the number it computed, so a second implementation differing by one bit
 * produces a listener that never fires and never says why.
 * `parseRegexFromString` is the same failure in the other direction: the frame
 * revives `strategy.keys` into `RegExp` objects and the activation engine
 * decides key-as-pattern versus key-as-text, and a drifted copy leaves both
 * halves internally consistent and the pair wrong.
 *
 * **What does not.** Anything that imports another package — `@iris/*` or npm.
 * This package is on the browser's import allowlist
 * (`apps/iris/tests/architecture.test.ts`) on exactly one ground: it can drag
 * nothing in behind it, and `tests/purity.test.ts` reads the sources to pin
 * that rather than trusting the manifest. `formatYamlBlock` is the worked
 * counter-example — it is pure and text-shaped and was considered for this
 * package, and it needs `js-yaml`, so it went to its one consumer instead
 * (`@iris/compat-tavernhelper`). Also not here: anything only one domain
 * computes, which belongs in that domain's own package, and the slash-command
 * grammar, which is pure but is kept off the browser by ruling so a second
 * parse site cannot appear.
 *
 * Both functions lived in `@iris/compat-tavernhelper-core` until 2026-09-12,
 * where they were equally pure and equally shared but made `@iris/lorebook` and
 * `@iris/macro` — two generic engines — declare a dependency on the Tavern
 * Helper compat layer. Root `notes/DEVIATIONS.md`, stage 0 records the move;
 * `notes/PLUGIN-FEASIBILITY.md` §3 is the reason.
 *
 * @module @iris/text
 */

export { parseRegexFromString } from './regex.ts'
export { stringHash } from './hash.ts'
