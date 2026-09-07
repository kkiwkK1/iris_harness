/**
 * The card's own regex tier: what the character rewrites, and whether it may.
 *
 * **The tier that turned out to be the dominant one.** Measured over the 19
 * local cards: 15 carry `data.extensions.regex_scripts`, 173 rules between
 * them, while the same install's global tier — the only one this shell could
 * see until now — held nothing. All 15 carry at least one live display-only
 * rule and 11 of them use it to strip the card's own `<UpdateVariable>`
 * blocks, so this tier is what decides whether the reader sees a card's
 * bookkeeping.
 *
 * Two controls, and they are the two switches upstream has:
 *
 * - the tier's own permission, upstream's `character_allowed_regex` membership
 *   (`engine.js:115`, `:167`), which until this round did not exist here at all
 *   — this host ran a card's rules unconditionally, so there was no way to
 *   refuse a card that mangled its own output;
 * - and one switch per rule, which upstream stores by rewriting the card
 *   (`writeExtensionField`, `engine.js:148`) and this host stores beside the
 *   card, for the reason every other per-card decision is stored that way.
 *
 * **What this panel will not do is edit the rules.** They belong to the card:
 * the author wrote them, they travel with it through export and re-import, and
 * an edit here would either rewrite someone else's document or invent a
 * shadow copy that the next card update silently disagreed with. Export is
 * offered instead — a rule can be exported, edited as a global rule, and kept
 * — and the panel says so rather than leaving the absence to be discovered.
 *
 * @module iris-web/app/ScopedRegexPanel
 */

import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ScopedRegexView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { CollapsibleSection } from './fields.tsx'
import { exportRegexFile } from './regex-export.ts'
import { RegexBadges } from './regex-rows.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the card's regex section, or nothing.
 *
 * Nothing when no conversation is open, and nothing when the host keeps no
 * script policy — the second is `scopedRegex === undefined` while
 * `scopedRegexFor` names the card, which is how "refused" is told apart from
 * "still loading".
 * @returns the section, or null.
 */
export function ScopedRegexPanel(): ReactElement | null {
  const characterId = useIris(state => state.view?.characterId)
  const scripts = useIris(state => state.scopedRegex)
  const scriptsFor = useIris(state => state.scopedRegexFor)
  const allowed = useIris(state => state.scopedRegexAllowed)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    if (characterId !== undefined) void actions.loadScopedRegex(characterId)
  }, [characterId, actions])

  if (characterId === undefined) return null
  const loaded = scriptsFor === characterId
  // Held back until the answer is in. Rendering the section while the previous
  // card's list is still in state would show one card's rules under another's
  // name — the mistake the `scopedRegexFor` pairing exists to prevent.
  if (!loaded || scripts === undefined) return null
  if (scripts.length === 0) return null

  const running = scripts.filter(row => row.enabled).length

  return (
    <CollapsibleSection
      id="scopedRegex"
      title={t('sectionScopedRegex')}
      summary={allowed
        ? t('scopedRegexSummary', { running, count: scripts.length })
        : t('scopedRegexRefusedSummary', { count: scripts.length })}
    >
      <p className="iris-field__note">{t('scopedRegexNote')}</p>

      <div className="iris-grant">
        <div className="iris-grant__state">
          <span className="iris-field__label">{t('scopedRegexAllowLabel')}</span>
          <span className={`iris-grant__value${allowed ? ' iris-grant__value--on' : ''}`}>
            {allowed ? t('switchOn') : t('switchOff')}
          </span>
        </div>
        <p className="iris-field__note">
          {allowed ? t('scopedRegexAllowedNote') : t('scopedRegexRefusedNote')}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void actions.setScopedRegexAllowed(characterId, !allowed)}
        >
          {allowed ? t('scopedRegexRefuse') : t('scopedRegexAllow')}
        </Button>
      </div>

      <div className="iris-regex__list">
        {scripts.map((row, index) => (
          <ScopedRow
            key={row.script.id ?? index}
            row={row}
            /*
             * The rule's own id, and the row is inert without one. A switch is
             * addressed by id on the wire, so a rule that carries none cannot
             * be switched — upstream assigns ids lazily, so this is reachable,
             * and the row says so rather than offering a control that would be
             * refused. All 173 rules in the local corpus carry one.
             */
            onToggle={enabled => {
              const id = row.script.id
              if (id === undefined) return
              void actions.setScopedRegexEnabled(characterId, id, enabled)
            }}
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

/**
 * One of the card's rules.
 *
 * Reports **both** switches, for `ScriptPanel`'s reason: "why is this off" has
 * two possible answers and they call for different actions — one is the card
 * author's choice and one is the reader's own.
 * @param props.row - the rule and the two switches.
 * @param props.onToggle - the reader's switch.
 * @returns the row.
 */
function ScopedRow({
  row,
  onToggle,
}: {
  row: ScopedRegexView
  onToggle: (enabled: boolean) => void
}): ReactElement {
  const script = row.script
  const addressable = typeof script.id === 'string'

  return (
    <div className="iris-regex__row">
      <input
        type="checkbox"
        className="iris-regex__toggle"
        checked={row.enabled}
        disabled={!addressable}
        aria-label={script.scriptName}
        onChange={event => onToggle(event.target.checked)}
      />
      <span className="iris-regex__name">
        {script.scriptName}
        <RegexBadges script={script} />
        {row.enabledByCard ? null : (
          <span className="iris-regex__badge">{t('scopedRegexOffByCard')}</span>
        )}
        {addressable ? null : (
          <span className="iris-regex__badge">{t('scopedRegexUnaddressable')}</span>
        )}
      </span>
      <span className="iris-regex__actions">
        <button
          type="button"
          className="iris-act"
          onClick={() => exportRegexFile(script)}
        >
          {t('regexExport')}
        </button>
      </span>
    </div>
  )
}
