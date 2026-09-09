/**
 * The active preset's own regex tier: what the preset rewrites, and whether it may.
 *
 * **Upstream's third tier, and the one that arrives off.** SillyTavern runs
 * three tiers in declaration order — global, preset, character
 * (`extensions/regex/engine.js:11-16`, consumed at `:99`) — and reads this one
 * out of the active preset file's own `extensions.regex_scripts` (`:126`),
 * gated on the preset's *name* being in
 * `extension_settings.preset_allowed_regex[api]` (`:126-128`). Iris carried the
 * other two and ordered this one's place without ever filling it; the switched-in
 * preset body was stored whole the whole time, `extensions` included.
 *
 * **Why the switch is off until asked, unlike the card's.** The one preset
 * measured for the ledger ships **40 rules, 18 of them live: 6 that rewrite the
 * request** (stripping the model's own draft and option blocks out of what it
 * reads back) and 12 that only prettify the page. A preset is a settings file
 * people pass around by the dozen, and importing one must not silently acquire
 * eighteen rewrite rules over a transcript. A card is the opposite case — its
 * rules mostly hide its own bookkeeping from its own reader — which is why that
 * tier runs until refused and this one waits. Both defaults are deliberate and
 * both are recorded: host `DEVIATIONS.md` §30 and §53.
 *
 * **What this panel will not do is edit the rules**, for `ScopedRegexPanel`'s
 * reason: they belong to the preset's author, they travel with the file, and an
 * edit here would either rewrite someone else's document or invent a shadow
 * copy the next import would disagree with. Export is offered instead.
 *
 * @module iris-web/app/PresetRegexPanel
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
 * Render the preset's regex section, or nothing.
 *
 * Nothing when the answer is not in yet, nothing when the host keeps no script
 * policy (`presetRegex === undefined`, read as `regexScripts === undefined` is),
 * and nothing when the active preset ships no rules — a preset with none has
 * nothing for a reader to decide about, and an empty section under a live
 * switch would read as breakage.
 *
 * **A refused tier still renders.** That is the common state here, not the
 * exception: the section is where a reader finds out that the preset they just
 * imported carries rules at all, so it lists them and explains why none of them
 * are running.
 * @returns the section, or null.
 */
export function PresetRegexPanel(): ReactElement | null {
  const scripts = useIris(state => state.presetRegex)
  const presetName = useIris(state => state.presetRegexName)
  const allowed = useIris(state => state.presetRegexAllowed)
  const malformed = useIris(state => state.presetRegexMalformed)
  const activePreset = useIris(state => state.activePreset)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  // Re-read when the active preset changes, because the tier *is* a property of
  // the active preset: a switch replaces the rules, the permission that applies
  // to them, and the name they are listed under. Keyed on the store's own
  // `activePreset` rather than on a panel-local memory of it, so a switch made
  // from the section above this one lands here without a reload.
  useEffect(() => {
    void actions.loadPresetRegex()
  }, [activePreset, actions])

  if (scripts === undefined) return null
  if (scripts.length === 0) return null

  // Not guarded on `allowed`: the refused summary does not take a running
  // count, so a `allowed ? … : 0` here would be a line no render could tell
  // apart from this one — the teeth check for it came back green, which is how
  // it was found. The row badges carry the "on, but the tier is off" state
  // instead, where it *is* observable.
  const running = scripts.filter(row => row.enabled).length

  return (
    <CollapsibleSection
      id="presetRegex"
      title={t('sectionPresetRegex')}
      summary={allowed
        ? t('presetRegexSummary', { running, count: scripts.length })
        : t('presetRegexRefusedSummary', { count: scripts.length })}
    >
      <p className="iris-field__note">
        {presetName === undefined
          ? t('presetRegexUnnamed')
          : t('presetRegexNote', { name: presetName })}
      </p>

      {/*
        The rows the reader dropped, said rather than swallowed. Two of the 40
        rules in the measured preset are separators with an empty pattern, and
        an empty pattern matches at every position — so this line is the
        difference between "this preset has 38 rules" and the truth.
      */}
      {malformed === 0 ? null : (
        <p className="iris-field__note">{t('presetRegexMalformed', { n: malformed })}</p>
      )}

      {/*
        The permission. Hidden — not merely disabled — when the active preset has
        no library name, because there is nothing for the allow-list to be keyed
        by and the sentence above already says so. A control that could not be
        honoured is worse than no control.
      */}
      {presetName === undefined ? null : (
        <div className="iris-grant">
          <div className="iris-grant__state">
            <span className="iris-field__label">{t('presetRegexAllowLabel')}</span>
            <span className={`iris-grant__value${allowed ? ' iris-grant__value--on' : ''}`}>
              {allowed ? t('switchOn') : t('switchOff')}
            </span>
          </div>
          <p className="iris-field__note">
            {allowed ? t('presetRegexAllowedNote') : t('presetRegexRefusedNote')}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void actions.setPresetRegexAllowed(!allowed)}
          >
            {allowed ? t('presetRegexRefuse') : t('presetRegexAllow')}
          </Button>
        </div>
      )}

      <div className="iris-regex__list">
        {scripts.map((row, index) => (
          <PresetRow
            key={row.script.id ?? index}
            row={row}
            allowed={allowed}
            /*
             * The rule's own id, and the row is inert without one — the same
             * rule the scoped panel keeps, and it bites harder here: a card
             * passes through an importer that mints ids, and a preset's rules
             * are whatever its author wrote.
             */
            onToggle={enabled => {
              const id = row.script.id
              if (id === undefined) return
              void actions.setPresetRegexEnabled(id, enabled)
            }}
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

/**
 * One of the preset's rules.
 *
 * Reports **both** switches for `ScopedRegexPanel`'s reason — "why is this off"
 * has two answers and they call for different actions — plus a third state that
 * panel does not have: the whole tier can be refused, in which case a rule's own
 * switch says what would happen if it were allowed rather than what is
 * happening. The checkbox stays live so a reader can set the tier up before
 * turning it on, and the row says which reading applies.
 * @param props.row - the rule and the two switches.
 * @param props.allowed - whether the tier may run at all.
 * @param props.onToggle - the reader's switch.
 * @returns the row.
 */
function PresetRow({
  row,
  allowed,
  onToggle,
}: {
  row: ScopedRegexView
  allowed: boolean
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
          <span className="iris-regex__badge">{t('presetRegexOffByPreset')}</span>
        )}
        {addressable ? null : (
          <span className="iris-regex__badge">{t('scopedRegexUnaddressable')}</span>
        )}
        {allowed || !row.enabled ? null : (
          <span className="iris-regex__badge">{t('presetRegexHeldBack')}</span>
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
