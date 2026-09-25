/**
 * What a card is told when the policy refuses it.
 *
 * A refusal **throws** rather than returning `undefined`, and that is the single
 * most important decision in this module. `undefined` from a DOM lookup is
 * indistinguishable from "no such element": a card would take a policy decision
 * for a missing node, carry on, and fail somewhere unrelated with nothing
 * connecting the symptom to the cause. Throwing puts the refused member's own
 * name in the stack at the moment it was reached.
 *
 * @module iris-web/sandbox/errors
 */

/** Refusal of a member the sandbox does not provide. */
export class UnsupportedApiError extends Error {
  /** The member as the card spelled it, e.g. `document.cookie`. */
  readonly member: string

  /**
   * @param member - dotted path of the refused member.
   * @param hint - what the card could do instead, when there is something.
   */
  constructor(member: string, hint?: string) {
    super(
      `Iris sandbox: ${member} is not available to card scripts.` +
        (hint === undefined ? '' : ` ${hint}`),
    )
    this.name = 'UnsupportedApiError'
    this.member = member
  }
}

/**
 * The refused member, when `error` is a sandbox refusal — from **any** copy of
 * this module.
 *
 * A brand check, not `instanceof`. The frame is built from two bundles (the
 * bootstrap and the member table), and each compiles its own copy of this file,
 * so `UnsupportedApiError` is two classes at run time: a refusal thrown by a
 * Tavern Helper member (members bundle) is not an `instanceof` the bootstrap's
 * class. Graded with `instanceof`, such a refusal reached the panel as a plain
 * `threw` with a stack into `members.js` instead of AUTORUN's `refused`. Node
 * tests load one module graph and could not see it.
 * @param error - whatever a card's body threw.
 * @returns the member the refusal names, or undefined for anything else.
 */
export function refusedMember(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { name, member } = error as { name?: unknown, member?: unknown }
  return name === 'UnsupportedApiError' && typeof member === 'string' ? member : undefined
}

/**
 * Whether `error` is a sandbox refusal, from any copy of this module.
 * @param error - whatever a card's body threw.
 * @returns true for a refusal, by brand.
 */
export function isRefusal(error: unknown): error is UnsupportedApiError {
  return refusedMember(error) !== undefined
}

/** Refusal of a write. Separate from a read so the message can say which it was. */
export class ReadOnlyApiError extends Error {
  /** The member the card tried to assign. */
  readonly member: string

  /**
   * @param member - dotted path of the assigned member.
   */
  constructor(member: string) {
    super(`Iris sandbox: ${member} cannot be assigned by a card script.`)
    this.name = 'ReadOnlyApiError'
    this.member = member
  }
}
