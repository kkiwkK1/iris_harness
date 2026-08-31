/**
 * Where a chat's regex scripts run.
 *
 * Three directions, and they are mutually exclusive by design: a script marked
 * display-only rewrites what the reader sees, a prompt-only script rewrites what
 * the model sees, and a script marked neither rewrites the message as it is
 * stored — which is why the stored form is never rewritten again at render or
 * send time. Getting that wrong applies a script twice.
 *
 * This is not cosmetic. An MVU card ships exactly two scripts, and without them
 * the chat shows raw `<UpdateVariable>` blocks *and* the model reads back its
 * own command blocks from every earlier turn, which poisons the rest of the
 * conversation. The display direction in particular belongs to the host: the
 * browser receives a `ChatView` that is already clean, so the regex engine
 * exists in one place rather than two that can disagree.
 *
 * @module @iris/app-service/regex
 */

import type { CharacterCard } from '@iris/character'
import { createMacroContext, toRegexSubstitute } from '@iris/macro'
import type { ViewRole } from '@iris/protocol'
import {
  applyRegexScripts,
  orderScripts,
  PLACEMENT,
  SCRIPT_TYPE,
  type MacroSubstitute,
  type Placement,
  type RegexScript,
} from '@iris/regex'

/**
 * Which placement a message's text belongs to.
 * @param role - the speaker.
 * @returns the placement scripts are matched against.
 */
export function placementFor(role: ViewRole): Placement {
  return role === 'user' ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT
}

/**
 * The scripts one chat runs, in upstream's order.
 *
 * Only the character's own tier exists so far; the global and preset tiers are
 * ordered around it already, so adding them later is a matter of passing them
 * in rather than reworking the call sites.
 * @param card - the character being played, if any.
 * @returns the ordered scripts, empty when the card ships none.
 */
export function scriptsOf(card: CharacterCard | undefined): RegexScript[] {
  const scoped = card?.data.extensions.regex_scripts
  if (!Array.isArray(scoped)) return []
  return orderScripts(scoped.map(script => ({ script: script as RegexScript, type: SCRIPT_TYPE.SCOPED })))
}

/**
 * The macro expander a chat's regex scripts should use.
 *
 * Needed for `SUBSTITUTE.ESCAPED`, where a pattern's macros expand and the
 * expanded values are escaped before they are read as regex syntax — so a
 * character named `A.B` matches itself and not `AxB`. `@iris/regex` stays
 * dependency-free and `@iris/macro` supplies the adapter, so the two packages
 * meet by shape rather than by import.
 * @param names - what `{{char}}` and `{{user}}` expand to.
 * @returns the substitute to hand the regex engine.
 */
export function substituteFor(names: { user: string, character: string }): MacroSubstitute {
  return toRegexSubstitute(createMacroContext({ char: names.character, user: names.user }))
}

/**
 * Run the scripts for one direction.
 *
 * A thin wrapper, but it is the only place the role-to-placement mapping and
 * the depth convention live, and both are easy to get subtly wrong at a call
 * site.
 * @param text - the message text.
 * @param role - the speaker.
 * @param scripts - the chat's ordered scripts.
 * @param params - which direction, and how far from the end of the chat this
 *   message sits (`0` is the last message).
 * @returns the rewritten text.
 */
export function runScripts(
  text: string,
  role: ViewRole,
  scripts: readonly RegexScript[],
  params: {
    isMarkdown?: boolean
    isPrompt?: boolean
    depth?: number
    substitute?: MacroSubstitute | undefined
  } = {},
): string {
  if (scripts.length === 0) return text
  const { substitute, ...rest } = params
  return applyRegexScripts(text, placementFor(role), scripts, {
    ...rest,
    ...substitute === undefined ? {} : { substitute },
  })
}
