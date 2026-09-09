/**
 * The composer bar's word list and its one piece of arithmetic.
 *
 * A `.ts` module beside `model-menu.ts`, and for the same reason that one is
 * one: node's test runner strips types but does **not** transform JSX, so
 * nothing declared inside `Composer.tsx` can be reached by a unit test. What
 * lives here is what a test needs to hold — the six effort words in the order
 * the menu offers them, the rule that decides whether the control prints one at
 * all, and the ring's dash arithmetic — while the markup stays in the component.
 *
 * @module iris-web/app/composer-bar
 */

import type { ReasoningEffort } from '@iris/protocol'

/**
 * The effort words, in menu order.
 *
 * Upstream's own value words (`reasoning_effort_types`), which name provider
 * request fields and are therefore never translated — the settings drawer's
 * choice field has offered exactly these six since it was written, and this is
 * now the one list both surfaces read. The host validates against the same set
 * (`@iris/app-service`'s `REASONING_EFFORTS`); the order differs there because
 * that list is a membership test and this one is a menu.
 *
 * `auto` leads because it is the absence of a choice, not a level of one.
 */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'auto',
  'min',
  'low',
  'medium',
  'high',
  'max',
]

/**
 * Which effort row is ticked.
 *
 * `auto` stands for "nobody has chosen", because that is what the absence of
 * the field means to a provider: `@iris/llm-openai-compat`'s serializer omits
 * `reasoning_effort` for both an absent value and the literal `'auto'`, so the
 * two are one request. A menu with no row ticked would be a menu claiming this
 * conversation has no answer to a question every request answers.
 * @param effort - `GenerationSettings.reasoningEffort` as the merged read
 * carries it; absent both before the settings load and whenever nobody chose.
 * @returns the effort in force, `'auto'` when none was chosen.
 */
export function effortInForce(effort: ReasoningEffort | undefined): ReasoningEffort {
  return effort ?? 'auto'
}

/**
 * The word the model control prints beside the model name, when there is one.
 *
 * **Absent for `auto`, deliberately.** The control states what is in force in
 * as few words as it can, and 「auto」 beside a model name is a word that adds
 * no fact: the request goes out without a `reasoning_effort` either way. A
 * reader who wants to see the whole ladder opens the menu, where `auto` is a
 * row like the other five and is ticked.
 * @param effort - `GenerationSettings.reasoningEffort` as the merged read
 * carries it.
 * @returns the word, or undefined when the control should print the model alone.
 */
export function effortShown(effort: ReasoningEffort | undefined): ReasoningEffort | undefined {
  return effort === undefined || effort === 'auto' ? undefined : effort
}

/**
 * What an effort row writes.
 *
 * `null` is the protocol's clear — the same value the settings drawer's own
 * choice field writes for `auto`, and the same shape the model menu's restore
 * row uses — so choosing `auto` drops the field rather than storing the word.
 * The two are one request to a provider (see {@link effortShown}); storing the
 * word would additionally mean a chat layer that overrides the layer below it
 * with a value that changes nothing, which is an override a reader cannot see
 * the effect of and would have to guess the meaning of.
 * @param effort - the row the reader chose.
 * @returns the patch value for `reasoningEffort`.
 */
export function effortPatch(effort: ReasoningEffort): ReasoningEffort | null {
  return effort === 'auto' ? null : effort
}

/** The ring's radius in its own 24-unit viewBox, so the stroke has room inside it. */
export const RING_RADIUS = 9

/** The ring's full length, which is the denominator every arc is drawn against. */
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/**
 * The `stroke-dasharray` that draws one occupancy on the ring.
 *
 * Arithmetic rather than `pathLength`, which would express the same thing
 * declaratively: `pathLength` on a `<circle>` is the newer half of the SVG
 * geometry properties and has been unreliable on shapes (as opposed to paths)
 * in shipped browsers, and a ring that silently drew a full circle on one
 * engine is exactly the failure a gauge must not have.
 *
 * Fixed to three decimals so the markup is deterministic — a check can assert
 * the arc a seeded reading draws, which is what makes 「the ring is drawn at
 * the measured percentage」 a testable sentence rather than a hope.
 * @param percent - the occupancy, 0–100; anything outside is clamped.
 * @returns the two-length dasharray: the arc, then the rest of the ring.
 */
export function ringDash(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const arc = RING_CIRCUMFERENCE * clamped / 100
  return `${arc.toFixed(3)} ${RING_CIRCUMFERENCE.toFixed(3)}`
}
