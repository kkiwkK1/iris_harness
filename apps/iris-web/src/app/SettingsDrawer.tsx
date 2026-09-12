/** Settings as a navigable drawer: a directory first, one focused task at a time. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import type { ReadingPrefs } from '../theme/theme.ts'
import { useLanguage } from './i18n/use-language.ts'
import { SettingsPageSections } from './fields.tsx'
import {
  SETTINGS_GROUPS, SettingsCountBadge, SettingsGroup, SettingsHeader,
  SettingsPage, SettingsRow, SettingsSearch, destinationOf, searchSettings,
  type SettingsRoute,
} from './SettingsNavigation.tsx'
import { AboutCard } from './AboutCard.tsx'
import { AppearanceCard } from './AppearanceCard.tsx'
import { BackupPanel } from './BackupPanel.tsx'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import { DemoActionsSection } from './DemoActionsSection.tsx'
import { GenerationPanel } from './GenerationPanel.tsx'
import { HostReports } from './HostReports.tsx'
import { MemoryContextPanel } from './MemoryContextPanel.tsx'
import { NoticeLog } from './NoticeLog.tsx'
import { PersonaPanel } from './PersonaPanel.tsx'
import { PluginCenter } from './PluginCenter.tsx'
import { PresetPanel } from './PresetPanel.tsx'
import { PresetRegexPanel } from './PresetRegexPanel.tsx'
import { ReadingPanel } from './ReadingPanel.tsx'
import { RegexPanel } from './RegexPanel.tsx'
import { ReplyBehaviorPanel } from './ReplyBehaviorPanel.tsx'
import { ScopedRegexPanel } from './ScopedRegexPanel.tsx'
import { ScriptLibraryPanel } from './ScriptLibraryPanel.tsx'
import { ScriptPanel } from './ScriptPanel.tsx'
import { UsagePanel } from './UsagePanel.tsx'
import { WorldbookPanel } from './WorldbookPanel.tsx'
import { SandboxProbe } from '../dev/SandboxProbe.tsx'
import { RailPreview } from '../dev/RailPreview.tsx'

export interface ReadingControl {
  reading: ReadingPrefs
  setReading: (prefs: ReadingPrefs) => void
}

type RegexScope = 'global' | 'preset' | 'character'

export function SettingsDrawer({ open, onClose, control }: {
  open: boolean
  onClose: () => void
  control: ReadingControl
}): ReactElement {
  const [route, setRoute] = useState<SettingsRoute>('home')
  const [query, setQuery] = useState('')
  const [regexScope, setRegexScope] = useState<RegexScope>('global')
  const drawer = useRef<HTMLElement>(null)
  const { lang } = useLanguage()
  const actions = useIrisActions()
  const chatId = useIris(state => state.chatId)
  const settings = useIris(state => state.settings)
  const connections = useIris(state => state.connections)
  const activeConnectionId = useIris(state => state.activeConnectionId)
  const presets = useIris(state => state.presets)
  const activePreset = useIris(state => state.activePreset)
  const personas = useIris(state => state.personas)
  const regex = useIris(state => state.regexScripts)
  const worldbooks = useIris(state => state.worldbooks)
  const library = useIris(state => state.library)
  const backups = useIris(state => state.backups)
  const systemPlugins = useIris(state => state.systemPlugins)

  useEffect(() => { if (!open) setRoute('home') }, [open])
  useEffect(() => {
    if (open) drawer.current?.querySelector<HTMLElement>('.iris-drawer__title')?.focus({ preventScroll: true })
  }, [open, route])

  const close = (): void => { setRoute('home'); setQuery(''); onClose() }
  const navigate = (next: SettingsRoute): void => { setRoute(next); setQuery('') }
  const activeConnection = connections.find(row => row.id === activeConnectionId)
  const activePersona = personas?.personas.find(row => row.id === personas.activeId)
  const values: Partial<Record<Exclude<SettingsRoute, 'home'>, string | undefined>> = {
    connections: activeConnection?.label ?? activeConnection?.summary,
    presets: activePreset,
    persona: activePersona?.name,
    'memory/context': settings?.contextWindow === undefined ? undefined : `${settings.contextWindow.toLocaleString()} tokens`,
    generation: settings?.model,
    appearance: `${control.reading.size}px`,
    plugins: systemPlugins === undefined
      ? undefined
      : lang === 'zh'
        ? `${systemPlugins.plugins.filter(plugin => plugin.status === 'enabled').length} 个运行中`
        : `${systemPlugins.plugins.filter(plugin => plugin.status === 'enabled').length} active`,
  }
  const counts: Partial<Record<Exclude<SettingsRoute, 'home'>, number | undefined>> = {
    connections: connections.length,
    presets: presets?.length,
    persona: personas?.personas.length,
    regex: regex?.length,
    worldbooks: worldbooks?.books.length,
    scripts: library?.length,
    backups: backups?.length,
    plugins: systemPlugins?.plugins.length,
  }
  const matches = useMemo(() => searchSettings(query), [query])
  const context = chatId === undefined
    ? (lang === 'zh' ? '新对话的默认值' : 'Defaults for new conversations')
    : (lang === 'zh' ? '当前对话' : 'This conversation')

  return <aside ref={drawer} className={`iris-drawer iris-settings${open ? ' iris-drawer--open' : ''}`}
    aria-label={lang === 'zh' ? '设置' : 'Settings'} aria-hidden={!open}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (!event.currentTarget.contains(event.target as Node)) return
      event.preventDefault()
      if (route === 'home') close(); else navigate('home')
    }}>
    <SettingsHeader route={route} lang={lang} context={context} onBack={() => navigate('home')} onClose={close} />
    <main className="iris-settings__content">
      <section className="iris-settings__home" hidden={route !== 'home'}>
        <SettingsSearch value={query} lang={lang} onChange={setQuery} />
        {SETTINGS_GROUPS.map(group => {
          const rows = matches.filter(row => row.group === group)
          if (rows.length === 0) return null
          return <SettingsGroup key={group} id={group} lang={lang}>{rows.map(row =>
            <SettingsRow key={row.route} destination={row} lang={lang} value={values[row.route]}
              accessory={counts[row.route] === undefined ? undefined : <SettingsCountBadge count={counts[row.route] ?? 0} />}
              onClick={() => navigate(row.route)} />,
          )}</SettingsGroup>
        })}
        {matches.length === 0 ? <p className="iris-list__empty">{lang === 'zh' ? '没有匹配的设置类别。' : 'No settings category matches.'}</p> : null}
      </section>

      <SettingsPageSections.Provider value>
        <SettingsPage route="connections" active={route === 'connections'}><ConnectionPanel /></SettingsPage>
        <SettingsPage route="presets" active={route === 'presets'}><PresetPanel /></SettingsPage>
        <SettingsPage route="persona" active={route === 'persona'}><PersonaPanel /></SettingsPage>
        <SettingsPage route="memory/context" active={route === 'memory/context'}><PageLead route="memory/context" lang={lang} /><MemoryContextPanel /></SettingsPage>
        <SettingsPage route="replies" active={route === 'replies'}><PageLead route="replies" lang={lang} /><ReplyBehaviorPanel /></SettingsPage>
        <SettingsPage route="generation" active={route === 'generation'}><PageLead route="generation" lang={lang} /><GenerationPanel /></SettingsPage>
        <SettingsPage route="regex" active={route === 'regex'}>
          <ScopeTabs value={regexScope} lang={lang} onChange={setRegexScope} />
          <div id="iris-regex-panel-global" role="tabpanel" aria-labelledby="iris-regex-tab-global" hidden={regexScope !== 'global'}><RegexPanel /></div>
          <div id="iris-regex-panel-preset" role="tabpanel" aria-labelledby="iris-regex-tab-preset" hidden={regexScope !== 'preset'}><PresetRegexPanel /></div>
          <div id="iris-regex-panel-character" role="tabpanel" aria-labelledby="iris-regex-tab-character" hidden={regexScope !== 'character'}><ScopedRegexPanel /></div>
        </SettingsPage>
        <SettingsPage route="worldbooks" active={route === 'worldbooks'}><WorldbookPanel /></SettingsPage>
        <SettingsPage route="scripts" active={route === 'scripts'}><ScriptPanel /><ScriptLibraryPanel /></SettingsPage>
        <SettingsPage route="appearance" active={route === 'appearance'}><AppearanceCard /><ReadingPanel control={control} /></SettingsPage>
        <SettingsPage route="backups" active={route === 'backups'}><BackupPanel /></SettingsPage>
        <SettingsPage route="usage" active={route === 'usage'}><UsagePanel embedded open={route === 'usage'} onClose={() => navigate('home')} onOpenChat={id => { close(); void actions.openChat(id) }} /></SettingsPage>
        <SettingsPage route="plugins" active={route === 'plugins'}><PluginCenter /></SettingsPage>
        <SettingsPage route="diagnostics" active={route === 'diagnostics'}>
          <HostReports /><NoticeLog /><DemoActionsSection />
          {import.meta.env.DEV ? <SandboxProbe /> : null}{import.meta.env.DEV ? <RailPreview /> : null}
          <Slot name="iris.settings.sections" owner={{}} />
        </SettingsPage>
        <SettingsPage route="about" active={route === 'about'}><AboutCard control={control} /></SettingsPage>
      </SettingsPageSections.Provider>
    </main>
  </aside>
}

function PageLead({ route, lang }: { route: SettingsRoute, lang: 'en' | 'zh' }): ReactElement | null {
  const row = destinationOf(route)
  return row === undefined ? null : <p className="iris-settings__lead">{row[lang === 'zh' ? 'summaryZh' : 'summaryEn']}</p>
}

function ScopeTabs({ value, lang, onChange }: { value: RegexScope, lang: 'en' | 'zh', onChange: (scope: RegexScope) => void }): ReactElement {
  const tabs: readonly [RegexScope, string][] = lang === 'zh'
    ? [['global', '全局'], ['preset', '预设'], ['character', '角色']]
    : [['global', 'Global'], ['preset', 'Preset'], ['character', 'Character']]
  return <div className="iris-settings__segments" role="tablist" aria-label={lang === 'zh' ? '正则作用域' : 'Regex scope'}>
    {tabs.map(([id, label], index) => <button key={id} id={`iris-regex-tab-${id}`} type="button" role="tab" aria-selected={value === id} aria-controls={`iris-regex-panel-${id}`} tabIndex={value === id ? 0 : -1}
      onClick={() => onChange(id)}
      onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + offset + tabs.length) % tabs.length
        if (offset === 0 && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const next = tabs[target]?.[0]
        if (next === undefined) return
        onChange(next)
        document.getElementById(`iris-regex-tab-${next}`)?.focus()
      }}>{label}</button>)}
  </div>
}
