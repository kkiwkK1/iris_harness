/**
 * The badge the two regex lists share.
 *
 * There are two lists now — the profile's global tier and the card's own — and
 * they show the same object side by side in one drawer. A rule's *direction* is
 * the one fact a reader carries from one list to the other, and two
 * implementations of a three-way choice, where one of the three cases is "both
 * flags at once", is exactly the shape where the copies agree on the two common
 * cases and disagree on the third.
 *
 * The export lives in `regex-export.ts` rather than here, because `node --test`
 * refuses a `.tsx` file and the filename convention is the part that needs a
 * test.
 *
 * @module iris-web/app/regex-rows
 */

import type { ReactElement } from 'react'

import type { RegexScriptView } from '@iris/protocol'

import { t } from './i18n/use-language.ts'

/**
 * Which direction a rule rewrites, as badges.
 *
 * **Three independent checks, not a three-way choice**, and the difference is a
 * real case: upstream's own migration sets `markdownOnly` *and* `promptOnly` on
 * a legacy `MD_DISPLAY` rule (`index.js:1389-1398`), and the engine then runs
 * it in both passes while never rewriting the stored message. A rule like that
 * must show both badges; a chain of `? :` would show one and hide the other
 * half of what it does.
 * @param props.script - the rule.
 * @returns the badges.
 */
export function RegexBadges({ script }: { script: RegexScriptView }): ReactElement {
  const display = script.markdownOnly === true
  const prompt = script.promptOnly === true
  return (
    <>
      {display ? <span className="iris-regex__badge">{t('regexDisplayOnly')}</span> : null}
      {prompt ? <span className="iris-regex__badge">{t('regexPromptOnly')}</span> : null}
      {display || prompt
        ? null
        : <span className="iris-regex__badge">{t('regexPermanent')}</span>}
    </>
  )
}
