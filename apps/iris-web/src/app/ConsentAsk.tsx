/**
 * The run-scripts question, in front of the reader rather than behind a drawer.
 *
 * The first version of this lived only in the settings panel. That panel renders
 * inside a drawer which is closed by default and `aria-hidden` when closed, so
 * opening a chat with an unanswered card produced nothing at all: no question,
 * no scripts, and no hint that a decision was pending. `AUTORUN.md` §1 asks for
 * the question to be put once, and a question nobody can see has not been put.
 *
 * It was verified against a card whose drawer happened to be open, which is why
 * "the wording and both answers work" was true and "a user will encounter it"
 * was never tested.
 *
 * Three properties this surface has to keep:
 *
 * - **Not modal.** `AUTORUN.md` §3.4 keeps prompts off the conversation. This
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
import { ConsentGate } from './ScriptPanel.tsx'

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

  // Only once the list for *this* card has arrived: asking about a card whose
  // scripts are still loading would show a count that is about to change.
  if (characterId === undefined || scriptsFor !== characterId) return null
  if (consent !== 'unasked') return null
  // A card with no scripts is not a decision.
  if (scripts.length === 0) return null

  return (
    <div className="iris-notice iris-notice--info" role="region" aria-label="Card scripts">
      <ConsentGate
        scripts={scripts}
        onAnswer={allowed => void actions.answerScriptsAllowed(allowed)}
      />
    </div>
  )
}
