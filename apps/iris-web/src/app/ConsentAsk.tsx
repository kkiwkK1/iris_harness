/**
 * The run-scripts question, in front of the reader rather than behind a drawer.
 *
 * The first version of this lived only in the settings panel. That panel renders
 * inside a drawer which is closed by default and `aria-hidden` when closed, so
 * opening a chat with an unanswered card produced nothing at all: no question,
 * no scripts, and no hint that a decision was pending. `docs/AUTORUN.md` §1 asks for
 * the question to be put once, and a question nobody can see has not been put.
 *
 * It was verified against a card whose drawer happened to be open, which is why
 * "the wording and both answers work" was true and "a user will encounter it"
 * was never tested.
 *
 * Three properties this surface has to keep:
 *
 * - **Not modal.** `docs/AUTORUN.md` §3.4 keeps prompts off the conversation. This
 *   sits above it and never blocks reading or writing.
 * - **No timer.** Notices expire; a question must not. A prompt that disappears
 *   on its own has answered itself, and the answer it gives is the one nobody
 *   chose.
 * - **Nothing a card can reach.** It is driven by host state and the card's own
 *   script list, never by anything a card says or does.
 *
 * @module iris-web/app/ConsentAsk
 */
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { shouldAsk } from '../sandbox/consent.ts'
import { ConsentGate } from './ScriptPanel.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Ask about this card's scripts, once, where it will be seen.
 * @returns the question, or null when there is nothing to ask.
 */
export function ConsentAsk(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const scripts = useIris(state => state.scripts)
  const scriptsFor = useIris(state => state.scriptsFor)
  const consent = useIris(state => state.scriptsAllowed)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the question. Before the early
  // returns: hook order must not depend on what is on screen.
  useLanguage()

  // Only once the list for *this* card has arrived: asking about a card whose
  // scripts are still loading would show a count that is about to change.
  if (characterId === undefined || scriptsFor !== characterId) return null
  /*
   * Through `shouldAsk`, not a comparison written here.
   *
   * Only `unasked` asks. `unknown` — the host has not answered yet — renders
   * nothing, because a question that appears and is then revealed to have been
   * answered already is worse than one that appears a beat late: it asks someone
   * to re-decide what they decided, and tells them their answer did not stick.
   */
  if (!shouldAsk(consent)) return null
  // A card with no scripts is not a decision.
  if (scripts.length === 0) return null

  return (
    <div className="iris-notice iris-notice--info" role="region" aria-label={t('sectionCardScripts')}>
      <ConsentGate
        scripts={scripts}
        onAnswer={allowed => void actions.answerScriptsAllowed(allowed)}
      />
    </div>
  )
}
