/**
 * The regex editor's form, as data.
 *
 * Kept apart from the component for two reasons. The round trip — a stored
 * script to a form and back — is the part that can silently lose a field, and
 * it is testable here without rendering anything. And the diagnosis below is a
 * judgement about upstream's own semantics that wants stating in one place
 * rather than in JSX.
 *
 * **The storage contract is verbatim.** A script edited here keeps every key it
 * arrived with, including ones no field renders: the list is the migration path
 * from a SillyTavern install, and an editor that rebuilt a script from its own
 * fields would strip whatever an extension had added the first time a user
 * opened it to change a name.
 *
 * @module iris-web/app/regex-editor
 */

import type { RegexScriptView } from '@iris/protocol'

/**
 * Where a rule applies, by upstream's numbers.
 *
 * `0` (`MD_DISPLAY`) and `4` (the retired `sendAs`) are deliberately absent:
 * upstream's editor offers neither, `0` is marked deprecated in its own source
 * ("MD Display is deprecated. Do not use.") and `4` is a hole in the enum. A
 * script that arrives carrying one keeps it — the round trip below preserves
 * whatever it cannot show — but nothing here can create one.
 */
export const PLACEMENT_CHOICES = [1, 2, 3, 5, 6] as const

/** How macros in the find pattern are treated, by upstream's numbers. */
export const SUBSTITUTE_CHOICES = [0, 1, 2] as const

/**
 * One rule as the form holds it.
 *
 * Strings where upstream's editor uses text inputs, including the two depths:
 * an empty depth field is "unlimited", and upstream stores that as `NaN` from
 * `parseInt('')`, which `JSON.stringify` writes as `null`. Holding a number
 * here would make "unlimited" and "0" the same state in the one place where 0
 * is a real and different answer — 0 means the last message.
 */
export interface RegexDraft {
  scriptName: string
  findRegex: string
  replaceString: string
  /** One trim string per line, upstream's own textarea convention. */
  trimStrings: string
  placement: number[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  substituteRegex: number
  /** Empty means unlimited. */
  minDepth: string
  /** Empty means unlimited. */
  maxDepth: string
}

/**
 * The form a brand-new rule starts on.
 *
 * Upstream's own new-script defaults (`extensions/regex/index.js:797-809`):
 * display-only, run-on-edit, and User Input as the single placement. Reproduced
 * rather than improved on, because a user who writes a rule here and exports it
 * to an install should get the rule they would have written there — and because
 * display-only is the direction that does not rewrite the chat file.
 * @returns the draft.
 */
export function emptyDraft(): RegexDraft {
  return {
    scriptName: '',
    findRegex: '',
    replaceString: '',
    trimStrings: '',
    placement: [1],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: '',
    maxDepth: '',
  }
}

/**
 * Fill the form from a stored rule.
 * @param script - the rule as the host stores it.
 * @returns the draft.
 */
export function draftOf(script: RegexScriptView): RegexDraft {
  return {
    scriptName: script.scriptName,
    findRegex: script.findRegex,
    replaceString: script.replaceString,
    trimStrings: (script.trimStrings ?? []).join('\n'),
    placement: [...script.placement ?? []],
    disabled: script.disabled === true,
    markdownOnly: script.markdownOnly === true,
    promptOnly: script.promptOnly === true,
    runOnEdit: script.runOnEdit === true,
    substituteRegex: script.substituteRegex ?? 0,
    minDepth: depthText(script.minDepth),
    maxDepth: depthText(script.maxDepth),
  }
}

/**
 * Write the form back onto the rule it came from.
 *
 * **`base` is spread first and is the whole point of this signature.** The
 * fields below overwrite what the form owns and nothing else, so a key the
 * editor has never heard of survives being opened, looked at and saved. Called
 * with `{}` for a new rule.
 * @param base - the stored rule, or `{}` for a new one.
 * @param draft - the form.
 * @returns the rule to store.
 */
export function applyDraft(
  base: Partial<RegexScriptView>,
  draft: RegexDraft,
): RegexScriptView {
  return {
    ...base,
    scriptName: draft.scriptName.trim(),
    findRegex: draft.findRegex,
    replaceString: draft.replaceString,
    // Empty lines dropped, as upstream's `filter(e => e.length !== 0)` does: a
    // trailing newline in a textarea would otherwise become a trim string that
    // matches everywhere.
    trimStrings: draft.trimStrings.split('\n').filter(line => line.length !== 0),
    placement: [...draft.placement].sort((left, right) => left - right),
    disabled: draft.disabled,
    markdownOnly: draft.markdownOnly,
    promptOnly: draft.promptOnly,
    runOnEdit: draft.runOnEdit,
    substituteRegex: draft.substituteRegex,
    minDepth: depthValue(draft.minDepth),
    maxDepth: depthValue(draft.maxDepth),
  }
}

/**
 * A stored depth as the field shows it.
 * @param value - `minDepth` or `maxDepth` as stored.
 * @returns the text, empty for "unlimited".
 */
function depthText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

/**
 * A depth field as it is stored.
 *
 * `null` for empty, which is what upstream's `NaN` becomes once
 * `JSON.stringify` has been over it — so a rule written here and read by an
 * install arrives in the shape that install's own editor produces. The engine
 * accepts both (`!isNaN(x) && x !== null`).
 * @param text - the field's contents.
 * @returns the value to store.
 */
function depthValue(text: string): number | null {
  if (text.trim() === '') return null
  const parsed = Number.parseInt(text, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * What a saved rule would fail to do, in the reader's own terms.
 *
 * Upstream saves whatever it is given and warns about two of these through
 * toasts; the other two it does not mention at all, and they are the ones that
 * cost people an afternoon. All four are consequences of one gate in the
 * engine (`getRegexedString`, `engine.js:348-355`) meeting the flags each call
 * site passes, not of any validation — so they are *derivable*, which is why
 * they are stated here rather than left for the user to discover:
 *
 * - **No placement.** Upstream warns. Nothing matches, ever.
 * - **No find pattern.** Upstream warns. `runRegexScript` bails on a falsy one.
 * - **World Info without "alter outgoing prompt".** World info is scanned with
 *   `{ isPrompt: true, isMarkdown: false }` (`world-info.js:5086`), so the only
 *   branch of the ephemerality gate that can fire is the `promptOnly` one.
 *   Upstream says this in a tooltip on the checkbox and enforces it nowhere.
 * - **Slash commands with either ephemerality flag.** All four slash-command
 *   call sites pass no flags at all, so only the "neither" branch can fire —
 *   and upstream's *new-script default* ticks "alter chat display", which means
 *   a freshly created slash-command rule silently never runs. That is the one
 *   worth catching here: the mistake is pre-made by the defaults.
 *
 * Reported rather than refused. A half-finished rule is a normal thing to save,
 * and upstream saves it; what a user should not have to do is deduce the four
 * lines above from an engine they cannot read.
 * @param draft - the form as it stands.
 * @returns one key per problem, empty when the rule would run.
 */
export function regexDraftProblems(draft: RegexDraft): RegexProblem[] {
  const problems: RegexProblem[] = []
  if (draft.placement.length === 0) problems.push('noPlacement')
  if (draft.findRegex.length === 0) problems.push('noPattern')
  if (draft.placement.includes(5) && !draft.promptOnly) problems.push('worldInfoNeedsPrompt')
  if (draft.placement.includes(3) && (draft.markdownOnly || draft.promptOnly)) {
    problems.push('slashNeedsNeither')
  }
  return problems
}

/** One thing wrong with a draft, by the string key that names its sentence. */
export type RegexProblem =
  | 'noPlacement'
  | 'noPattern'
  | 'worldInfoNeedsPrompt'
  | 'slashNeedsNeither'
