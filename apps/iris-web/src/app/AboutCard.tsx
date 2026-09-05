/**
 * The general half of the drawer: how the shell starts, the settings file in
 * and out, and what this app promises about credentials.
 *
 * Three things live together here because they are the parts of the drawer
 * that are not about the conversation at all. The startup switch gates the
 * shell's one automatic behaviour. The export/import pair is the SillyTavern
 * migration path one layer up: a whole settings surface as one file. And the
 * credential statement is written here — at the only place a user might
 * reasonably wonder where their key went — rather than in a README nobody
 * opens while typing a key into a form.
 *
 * @module iris-web/app/AboutCard
 */

import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { WorldbookSettingsView } from '@iris/protocol'

import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { loadAutoOpenChat, saveAutoOpenChat } from '../theme/theme.ts'
import type { ReadingControl } from './SettingsDrawer.tsx'
import { CollapsibleSection, ToggleField } from './fields.tsx'
import { buildExport, parseSettingsExport, transferDevice } from './settings-transfer.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the general-and-about card.
 * @param props.control - reading preferences, so an import can apply the
 *   device half through the same owners the live controls write through.
 * @returns the card.
 */
export function AboutCard({ control }: { control: ReadingControl }): ReactElement {
  const worldbooks = useIris(state => state.worldbooks)
  const actions = useIrisActions()

  const [autoOpen, setAutoOpen] = useState(loadAutoOpenChat)
  // The import's outcome, kept until the next one — like the preset panel's
  // per-file outcomes, a report rather than a toast.
  const [report, setReport] = useState<string[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const store = useIrisStore()
  const { lang, setLang } = useLanguage()
  // Subscribed so a language switch re-renders the card's words.
  useLanguage()

  /** Write the settings file: every surface's current values, keys least of all. */
  const exportSettings = async (): Promise<void> => {
    // Both host surfaces are read before exporting, so a file taken from a
    // freshly opened drawer is as complete as one taken after a visit.
    await actions.loadConnections()
    if (store.getState().worldbooks === undefined) await actions.loadWorldbooks()
    const live = store.getState()
    const file = buildExport({
      chatId: live.chatId,
      theme: control.theme,
      reading: control.reading,
      language: lang,
      autoOpenChat: autoOpen,
      generation: live.settings ?? { provider: '', model: '' },
      worldbook: live.worldbooks,
      connections: live.connections,
    })
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `iris-settings-${stamp()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setReport([t('settingsExported', { name: anchor.download })])
  }

  /** Apply a settings file, one section at a time, and report what moved. */
  const importSettings = async (file: File): Promise<void> => {
    const parsed = parseSettingsExport(await file.text())
    if (!parsed.ok) {
      setReport([t(parsed.reason === 'bad-json' ? 'settingsImportBadJson' : 'settingsImportBadFormat')])
      return
    }
    const data = parsed.data
    const notes: string[] = []

    // The device half first, through the same owners the live controls use —
    // App applies theme and reading to the document on every change, so the
    // attributes follow the state; writing them here too would be a second
    // writer for the same value.
    const device = transferDevice(data.device)
    control.setTheme(device.theme)
    control.setReading(device.reading)
    if (device.language !== lang) setLang(device.language)
    saveAutoOpenChat(device.autoOpenChat)
    setAutoOpen(device.autoOpenChat)
    notes.push(t('settingsImportedDevice'))

    if (data.generation.provider !== '' || data.generation.model !== '') {
      const patch: Record<string, unknown> = { ...data.generation }
      await actions.patchSettings(patch)
      notes.push(t('settingsImportedGeneration'))
    }
    if (data.worldbook !== null) {
      if (worldbooks === undefined) await actions.loadWorldbooks()
      await actions.patchWorldbookSettings(data.worldbook.settings as Partial<WorldbookSettingsView>)
      await actions.setGlobalSelect(data.worldbook.globalSelect)
      notes.push(t('settingsImportedWorldbook', { count: data.worldbook.globalSelect.length }))
    }
    for (const profile of data.connections) {
      await actions.saveConnection({
        provider: profile.provider,
        model: profile.model,
        ...profile.label === undefined ? {} : { label: profile.label },
        ...profile.preset === undefined ? {} : { preset: profile.preset },
        ...profile.baseURL === undefined ? {} : { baseURL: profile.baseURL },
        ...profile.sampling === undefined ? {} : { sampling: profile.sampling },
      })
    }
    if (data.connections.length > 0) {
      // Restored keyless, and said: a profile that looks ready and isn't is
      // the exact failure the credential story exists to prevent.
      notes.push(t('settingsImportedConnections', { count: data.connections.length }))
    }
    setReport(notes)
  }

  return (
    <CollapsibleSection id="about" title={t('sectionAbout')} summary={t('aboutSummary')}>
      <ToggleField
        label={t('autoOpenChat')}
        note={t('autoOpenChatNote')}
        value={autoOpen}
        onToggle={next => { setAutoOpen(next); saveAutoOpenChat(next) }}
      />

      {/*
        The settings file, in and out. The picker is hidden and the button
        opens it — the same shape the preset panel's hand-carried import uses.
      */}
      <div className="iris-about__transfer">
        <input
          ref={picker}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={event => {
            const file = event.target.files?.[0]
            // Reset before reading so picking the same file twice still fires.
            event.target.value = ''
            if (file !== undefined) void importSettings(file)
          }}
        />
        <Button variant="outline" size="sm" onClick={() => void exportSettings()}>
          {t('exportSettings')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
          {t('importSettings')}
        </Button>
      </div>
      {report.length === 0 ? null : (
        <ul className="iris-about__report">
          {report.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
      <p className="iris-field__note">{t('settingsTransferNote')}</p>

      {/*
        The credential statement. Said where a key is typed, not in a manual:
        the host holds them, no read returns one, and an export cannot carry
        one — which the export section above depends on for its safety.
      */}
      <h3 className="iris-label iris-about__credential-head">{t('credentialHead')}</h3>
      <p className="iris-field__note">{t('credentialBody')}</p>
      <p className="iris-field__note">{t('credentialBodyTransport')}</p>
    </CollapsibleSection>
  )
}

/** A filename stamp: the minute an export was taken, sortable, unambiguous. */
function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}
