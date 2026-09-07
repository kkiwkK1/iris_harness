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
import { createMacroContext, toRegexSubstitute, type MacroVariableStore } from '@iris/macro'
import type { ViewRole } from '@iris/protocol'
import {
  applyRegexScripts,
  orderScripts,
  PLACEMENT,
  SCRIPT_TYPE,
  type MacroSubstitute,
  type OwnedScript,
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
 * The user's decisions about one card's own regex tier.
 *
 * Two switches, for the same reason a card script has two: the card author's
 * `disabled` is a fact about the card and travels with it through export and
 * re-import, and the user's is a decision about this installation. Fusing them
 * would let a re-import quietly revive a rule the user had turned off.
 */
export interface ScopedRegexPolicy {
  /**
   * Whether the card's own tier may run at all — upstream's
   * `extension_settings.character_allowed_regex` (`engine.js:115,167`), a flat
   * list of avatar filenames there and a per-character record here.
   */
  allowed: boolean
  /**
   * The user's own per-script switches, by the script's `id`.
   *
   * A present key wins over the card's `disabled`, in both directions: `false`
   * switches off a rule the card shipped on, and `true` switches on one the
   * card shipped off. A missing key means the card decides, which is what
   * makes a fresh import behave as its author meant.
   */
  enabled: Readonly<Record<string, boolean>>
}

/**
 * The scripts one chat runs, in upstream's order.
 *
 * Two of the three tiers exist: the profile's global scripts
 * (`extension_settings.regex` upstream — the user's own, run before anything a
 * card ships) and the character's own. The preset tier is ordered around them
 * already and stays reserved — upstream reads it from the active preset file's
 * own `regex_scripts` field, which this host's read-only preset library does
 * not carry — so adding it later is a matter of passing it in rather than
 * reworking the call sites.
 *
 * Stable within a tier, so a card's own scripts keep the order it listed them
 * in — they are often written to run in sequence.
 *
 * **The card's tier is gated.** Upstream runs it only for a character on
 * `character_allowed_regex` — `getRegexedString` is the one caller that passes
 * `allowedOnly: true` (`engine.js:346`, gate at `:115`) — and until this round
 * nothing here could refuse it, so a user had no way to switch a card's rules
 * off short of editing the card. **`policy` absent means allowed**, which is
 * the behaviour this host already had and is not upstream's default; the
 * reasoning is in `notes/packages/iris-app-service/DEVIATIONS.md` §30.
 * @param card - the character being played, if any.
 * @param global - the profile's global scripts, in stored order.
 * @param policy - the user's decisions about the card's tier. Absent leaves the
 *   tier allowed and every rule at whatever the card said.
 * @returns the ordered scripts, empty when neither tier has any.
 */
export function scriptsOf(
  card: CharacterCard | undefined,
  global: readonly RegexScript[] = [],
  policy?: ScopedRegexPolicy,
): RegexScript[] {
  const owned: OwnedScript[] = global.map(script => ({ script, type: SCRIPT_TYPE.GLOBAL }))
  const scoped = card?.data.extensions.regex_scripts
  if (Array.isArray(scoped) && policy?.allowed !== false) {
    owned.push(...(scoped as RegexScript[]).map(script => ({
      script: withUserSwitch(script, policy?.enabled),
      type: SCRIPT_TYPE.SCOPED,
    })))
  }
  return orderScripts(owned)
}

/**
 * One scoped script with the user's switch folded into `disabled`.
 *
 * Returned **by identity** when the user has expressed nothing about it, which
 * is the common case: the storage contract for a card's own scripts is verbatim,
 * and a copy made on every read is a copy that can lose a key. A rewrite happens
 * only where there is a decision to fold in, and then only `disabled` moves.
 * @param script - the card's script.
 * @param enabled - the user's switches, by script id.
 * @returns the script the engine should see.
 */
function withUserSwitch(
  script: RegexScript,
  enabled: Readonly<Record<string, boolean>> | undefined,
): RegexScript {
  if (enabled === undefined) return script
  const id = script.id
  // An unnamed script cannot be addressed by a switch, so it keeps the card's
  // word. Upstream assigns ids lazily (on render, on save, on migration), which
  // means a card can genuinely arrive without them — measured over the local
  // corpus, all 173 scoped scripts carry one, but that is the corpus's fact and
  // not the format's.
  if (id === undefined) return script
  const decision = enabled[id]
  if (decision === undefined) return script
  return { ...script, disabled: !decision }
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
export function substituteFor(
  names: { user: string, character: string },
  variables?: MacroVariableStore,
): MacroSubstitute {
  return toRegexSubstitute(createMacroContext({
    char: names.character,
    user: names.user,
    // Optional, and unused today: a caller that supplies one binds the macro
    // tier to a store of its choosing. `entry.substitute` deliberately does not
    // — see the note there for what binding it to the chat's persistent scopes
    // cost when it was tried.
    ...variables === undefined ? {} : { variables },
  }))
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
