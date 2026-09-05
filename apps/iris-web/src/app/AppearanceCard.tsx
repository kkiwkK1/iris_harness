/**
 * The appearance card: themes and the user.css slot.
 *
 * The card exists because the reading card's theme menu answers "which palette"
 * in words, and a palette is not a word — it is a ground, a page, an ink and an
 * accent. So the choice is drawn: one thumbnail per built-in theme, each painted
 * from that theme's own token table (`presets.ts`), which means the preview and
 * the page can never disagree — they are the same numbers.
 *
 * The user.css slot lives here too, because it is the same question from the
 * other side: what the page looks like when the built-in palettes stop being
 * enough. Textarea for the sheet, a switch, and a file import for a stylesheet
 * written elsewhere. And the theme package in and out — palette plus
 * stylesheet as one JSON file — because a look someone tuned is worth taking to
 * the next device.
 *
 * @module iris-web/app/AppearanceCard
 */

import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  loadThemeOverrides,
  resolveThemeId,
  setThemeOverrides,
} from '../theme/theme.ts'
import type { ThemeId } from '../theme/theme.ts'
import { useThemeChoice } from '../theme/use-theme-choice.ts'
import { THEME_PRESETS } from '../theme/presets.ts'
import {
  buildThemePackage,
  overridesFromPackage,
  packageThemeId,
  parseThemePackage,
} from '../theme/theme-transfer.ts'
import { useUserCss } from '../slots/user-css.ts'
import { CollapsibleSection, ToggleField } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/** The themes' menu words, by id — the card's summary reads from this too. */
const THEME_NAME: Record<ThemeId, StringKey> = {
  light: 'themeLight',
  dark: 'themeDark',
  parchment: 'themeParchment',
}

/**
 * Render the appearance card.
 * @returns the card.
 */
export function AppearanceCard(): ReactElement {
  const { theme, setTheme } = useThemeChoice()
  const { userCss, setText, setEnabled } = useUserCss()
  // Subscribed so a language switch re-renders the card's words.
  useLanguage()

  // The overrides layer is read per render, not held in state: the theme
  // store notifies on every write to it, so this component re-renders with
  // the fresh table already in hand.
  const overrides = loadThemeOverrides()

  // The import's outcome, kept until the next one — a report rather than a toast.
  const [report, setReport] = useState<string[]>([])
  const cssPicker = useRef<HTMLInputElement>(null)
  const packagePicker = useRef<HTMLInputElement>(null)

  /** Write the theme package: the full palette (overrides folded in) and the sheet. */
  const exportTheme = (): void => {
    const file = buildThemePackage({
      themeId: resolveThemeId(theme),
      overrides,
      userCss,
    })
    const name = `iris-theme-${file.theme.id}-${stamp()}.json`
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(url)
    setReport([t('themeExported', { name })])
  }

  /** Apply a theme package: choice, token diff, and the stylesheet, as the file says. */
  const importTheme = async (file: File): Promise<void> => {
    const parsed = parseThemePackage(await file.text())
    if (!parsed.ok) {
      setReport([t(parsed.reason === 'bad-json' ? 'themeImportBadJson' : 'themeImportBadFormat')])
      return
    }
    const data = parsed.data
    const id = packageThemeId(data.theme.id)
    if (id !== undefined) setTheme(id)
    // The diff, not the table: a stock palette applies as nothing, so it can
    // not shadow the next theme switch; a customised one survives exactly.
    setThemeOverrides(overridesFromPackage(data))
    setText(data.userCss.css)
    setEnabled(data.userCss.enabled)
    setReport([t('themeImported')])
  }

  /** Bring in a .css file: kept verbatim, and switched on — importing to keep it off would be a puzzle. */
  const importCss = async (file: File): Promise<void> => {
    const css = await file.text()
    if (setText(css)) {
      setEnabled(true)
      setReport([t('userCssImported', { name: file.name })])
    } else {
      setReport([t('userCssTooLong')])
    }
  }

  return (
    <CollapsibleSection
      id="appearance"
      title={t('sectionAppearance')}
      summary={`${t(THEME_NAME[resolveThemeId(theme)])} · ${userCss.enabled ? t('appearanceUserCssOn') : t('appearanceUserCssOff')}`}
    >
      {/*
        The three built-ins, drawn rather than named. Each thumbnail is painted
        from the theme's own token table, so these are swatches of the real
        palettes, not pictures of them.
      */}
      <div className="iris-field">
        <span className="iris-field__label">{t('appearanceThemes')}</span>
        <span />
        <div className="iris-appearance__themes" role="group" aria-label={t('appearanceThemes')}>
          {THEME_PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className="iris-appearance__swatch"
              style={{ background: preset.tokens['--iris-bg-base'] }}
              aria-pressed={theme === preset.id}
              aria-label={t('appearanceThemeAria', { name: t(THEME_NAME[preset.id]) })}
              onClick={() => setTheme(preset.id)}
            >
              <span
                className="iris-appearance__sheet"
                style={{
                  background: preset.tokens['--iris-bg-page'],
                  borderColor: preset.tokens['--iris-rule'],
                }}
              >
                <span
                  className="iris-appearance__line"
                  style={{ background: preset.tokens['--iris-ink'] }}
                />
                <span
                  className="iris-appearance__line iris-appearance__line--short"
                  style={{ background: preset.tokens['--iris-ink-secondary'] }}
                />
                <span
                  className="iris-appearance__tick"
                  style={{ background: preset.tokens['--iris-accent'] }}
                />
              </span>
              <span className="iris-appearance__name">{t(THEME_NAME[preset.id])}</span>
            </button>
          ))}
        </div>
        <p className="iris-field__note">{t('appearanceThemesNote')}</p>
      </div>

      {/*
        The system option, beside the drawn choices: until it is chosen, the
        OS answers — and keeps answering if it changes its mind mid-session.
      */}
      <ToggleField
        label={t('appearanceFollowSystem')}
        note={t('appearanceFollowSystemNote')}
        value={theme === 'system'}
        onToggle={next => {
          if (next) setTheme('system')
          else setTheme(resolveThemeId('system'))
        }}
      />

      {Object.keys(overrides).length > 0 ? (
        <div className="iris-field">
          <span className="iris-field__label">{t('overridesInForce')}</span>
          <span className="iris-field__value">{Object.keys(overrides).length}</span>
          <span className="iris-field__note">
            {t('overridesNote')}{' '}
            <button
              type="button"
              className="iris-act iris-act--inline"
              onClick={() => {
                setThemeOverrides({})
                setReport([t('overridesCleared')])
              }}
            >
              {t('overridesClear')}
            </button>
          </span>
        </div>
      ) : null}

      {/*
        The user.css slot: the sheet, its switch, and a file import for a
        stylesheet written elsewhere. The text is kept while the slot is off,
        so toggling never loses work.
      */}
      <ToggleField
        label={t('userCss')}
        note={t('userCssNote')}
        value={userCss.enabled}
        onToggle={setEnabled}
      />
      <div className="iris-field">
        <span className="iris-field__label">{t('userCssEditorLabel')}</span>
        <span />
        <textarea
          className="iris-usercss__editor iris-field__control"
          value={userCss.css}
          placeholder={t('userCssPlaceholder')}
          spellCheck={false}
          aria-label={t('userCssEditorLabel')}
          onChange={event => {
            if (!setText(event.target.value)) setReport([t('userCssTooLong')])
          }}
        />
      </div>
      <div className="iris-about__transfer">
        <input
          ref={cssPicker}
          type="file"
          accept=".css,text/css"
          hidden
          onChange={event => {
            const file = event.target.files?.[0]
            // Reset before reading so picking the same file twice still fires.
            event.target.value = ''
            if (file !== undefined) void importCss(file)
          }}
        />
        <Button variant="outline" size="sm" onClick={() => cssPicker.current?.click()}>
          {t('userCssImport')}
        </Button>
      </div>

      {/*
        The theme package, in and out — the palette and the stylesheet as one
        file, the same shape the settings file uses one layer up.
      */}
      <div className="iris-about__transfer">
        <input
          ref={packagePicker}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void importTheme(file)
          }}
        />
        <Button variant="outline" size="sm" onClick={exportTheme}>
          {t('themeExport')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => packagePicker.current?.click()}>
          {t('themeImport')}
        </Button>
      </div>
      {report.length === 0 ? null : (
        <ul className="iris-about__report">
          {report.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
      <p className="iris-field__note">{t('themeTransferNote')}</p>
    </CollapsibleSection>
  )
}

/** A filename stamp: the minute an export was taken, sortable, unambiguous. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
