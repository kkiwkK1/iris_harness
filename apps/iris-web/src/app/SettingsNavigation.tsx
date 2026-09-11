import type { ReactElement, ReactNode } from 'react'

import type { Language } from './i18n/strings.ts'

export type SettingsRoute =
  | 'home' | 'connections' | 'presets' | 'persona' | 'memory/context'
  | 'replies' | 'generation' | 'regex' | 'worldbooks' | 'scripts'
  | 'appearance' | 'backups' | 'usage' | 'diagnostics' | 'about'

export interface SettingsDestination {
  route: Exclude<SettingsRoute, 'home'>
  group: 'general' | 'conversation' | 'content' | 'appearance' | 'data' | 'advanced'
  en: string
  zh: string
  summaryEn: string
  summaryZh: string
  aliases: string
}

export const SETTINGS_DESTINATIONS: readonly SettingsDestination[] = [
  { route: 'connections', group: 'general', en: 'Connections', zh: '连接', summaryEn: 'Providers, endpoints and connection tests', summaryZh: '供应商、端点与连接测试', aliases: 'provider api endpoint 供应商 端点' },
  { route: 'presets', group: 'general', en: 'Presets', zh: '预设', summaryEn: 'Prompt presets and their active selection', summaryZh: '提示词预设与当前选择', aliases: 'prompt 提示词' },
  { route: 'persona', group: 'general', en: 'Persona', zh: '人格', summaryEn: 'Your identity in conversations', summaryZh: '你在对话中的身份', aliases: 'identity profile 人设' },
  { route: 'memory/context', group: 'conversation', en: 'Memory & Context', zh: '记忆与上下文', summaryEn: 'Context capacity and model limits', summaryZh: '上下文容量与模型限制', aliases: 'memory context window capacity 记忆 上下文 容量' },
  { route: 'replies', group: 'conversation', en: 'Reply Behavior', zh: '回复行为', summaryEn: 'Continuation, trimming and cache behavior', summaryZh: '续写、修剪与缓存行为', aliases: 'reply continue trim cache 回复 续写 修剪 缓存' },
  { route: 'generation', group: 'conversation', en: 'Generation', zh: '生成', summaryEn: 'Sampling and response limits', summaryZh: '采样参数与回复限制', aliases: 'sampling temperature tokens 采样 温度 参数' },
  { route: 'regex', group: 'content', en: 'Regex Scripts', zh: '正则脚本', summaryEn: 'Global, preset and character rewrite rules', summaryZh: '全局、预设与角色改写规则', aliases: 'regex regular expression global preset character 正则 全局 预设 角色' },
  { route: 'worldbooks', group: 'content', en: 'Worldbooks', zh: '世界书', summaryEn: 'Lore sources used by conversations', summaryZh: '对话使用的世界设定来源', aliases: 'lore world book 世界书 知识' },
  { route: 'scripts', group: 'content', en: 'Scripts', zh: '脚本', summaryEn: 'Consent, run state and script library', summaryZh: '授权、运行状态与脚本库', aliases: 'script library card helper 酒馆助手 脚本 库' },
  { route: 'appearance', group: 'appearance', en: 'Appearance & Reading', zh: '外观与阅读', summaryEn: 'Theme, typography, language and user CSS', summaryZh: '主题、字号、语言与用户 CSS', aliases: 'appearance reading theme css language 外观 阅读 主题 语言' },
  { route: 'backups', group: 'data', en: 'Backups', zh: '备份', summaryEn: 'Preview, restore and remove snapshots', summaryZh: '预览、恢复与删除快照', aliases: 'backup restore snapshot 备份 恢复 快照' },
  { route: 'usage', group: 'data', en: 'Usage', zh: '用量', summaryEn: 'Token use, cache hits and model totals', summaryZh: 'Token、缓存命中与模型统计', aliases: 'usage token cache cost 用量 缓存 消耗' },
  { route: 'diagnostics', group: 'advanced', en: 'Diagnostics', zh: '诊断', summaryEn: 'Host reports, notices and extension checks', summaryZh: '宿主报告、通知与扩展检查', aliases: 'diagnostics report notice debug 诊断 报告 调试' },
  { route: 'about', group: 'advanced', en: 'About', zh: '关于', summaryEn: 'Import, export and application details', summaryZh: '导入、导出与应用信息', aliases: 'about import export version 关于 导入 导出 版本' },
] as const

export const SETTINGS_GROUPS = ['general', 'conversation', 'content', 'appearance', 'data', 'advanced'] as const
export type SettingsGroupId = typeof SETTINGS_GROUPS[number]

const GROUP_LABELS: Record<SettingsGroupId, { en: string, zh: string }> = {
  general: { en: 'General', zh: '常规' },
  conversation: { en: 'Conversation', zh: '对话' },
  content: { en: 'Content', zh: '内容' },
  appearance: { en: 'Appearance', zh: '外观' },
  data: { en: 'Data', zh: '数据' },
  advanced: { en: 'Advanced', zh: '高级' },
}

export function destinationOf(route: SettingsRoute): SettingsDestination | undefined {
  return SETTINGS_DESTINATIONS.find(row => row.route === route)
}

export function searchSettings(query: string): readonly SettingsDestination[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return SETTINGS_DESTINATIONS
  return SETTINGS_DESTINATIONS.filter(row =>
    `${row.en} ${row.zh} ${row.summaryEn} ${row.summaryZh} ${row.aliases}`.toLocaleLowerCase().includes(needle),
  )
}

export function SettingsHeader({ route, lang, context, onBack, onClose }: {
  route: SettingsRoute
  lang: Language
  context: string
  onBack: () => void
  onClose: () => void
}): ReactElement {
  const destination = destinationOf(route)
  const title = destination === undefined ? (lang === 'zh' ? '设置' : 'Settings') : destination[lang]
  return <header className="iris-drawer__head iris-settings__header">
    <SettingsBackButton visible={route !== 'home'} lang={lang} onClick={onBack} />
    <div className="iris-settings__heading">
      <h2 className="iris-label iris-drawer__title" tabIndex={-1}>{title}</h2>
      <span className="iris-settings__context">{context}</span>
    </div>
    <button type="button" className="iris-settings__icon" aria-label={lang === 'zh' ? '关闭设置' : 'Close settings'} onClick={onClose}>×</button>
  </header>
}

export function SettingsBackButton({ visible, lang, onClick }: { visible: boolean, lang: Language, onClick: () => void }): ReactElement {
  return <button type="button" className="iris-settings__icon" aria-label={lang === 'zh' ? '返回设置目录' : 'Back to settings'} onClick={onClick} hidden={!visible}>‹</button>
}

export function SettingsSearch({ value, lang, onChange }: { value: string, lang: Language, onChange: (value: string) => void }): ReactElement {
  return <label className="iris-settings__search">
    <span className="iris-settings__search-mark" aria-hidden="true">⌕</span>
    <input value={value} onChange={event => onChange(event.target.value)} aria-label={lang === 'zh' ? '搜索设置类别' : 'Search settings categories'} placeholder={lang === 'zh' ? '搜索设置…' : 'Search settings…'} />
  </label>
}

export function SettingsGroup({ id, lang, children }: { id: SettingsGroupId, lang: Language, children: ReactNode }): ReactElement {
  return <section className="iris-settings__group" aria-labelledby={`iris-settings-group-${id}`}>
    <h3 id={`iris-settings-group-${id}`} className="iris-settings__group-title">{GROUP_LABELS[id][lang]}</h3>
    <div className="iris-settings__rows">{children}</div>
  </section>
}

export function SettingsRow({ destination, lang, value, accessory, onClick }: {
  destination: SettingsDestination
  lang: Language
  value?: string | undefined
  accessory?: ReactNode | undefined
  onClick: () => void
}): ReactElement {
  return <button type="button" className="iris-settings__row" data-settings-destination={destination.route} onClick={onClick}>
    <span className="iris-settings__row-copy"><strong>{destination[lang]}</strong><small>{destination[lang === 'zh' ? 'summaryZh' : 'summaryEn']}</small></span>
    {value === undefined ? null : <SettingsStatus>{value}</SettingsStatus>}
    {accessory}
    <span className="iris-settings__chevron" aria-hidden="true">›</span>
  </button>
}

export function SettingsStatus({ children }: { children: ReactNode }): ReactElement {
  return <span className="iris-settings__status">{children}</span>
}

export function SettingsCountBadge({ count }: { count: number }): ReactElement {
  return <span className="iris-settings__count" aria-label={String(count)}>{count}</span>
}

export function SettingsPage({ route, active, children }: { route: Exclude<SettingsRoute, 'home'>, active: boolean, children: ReactNode }): ReactElement {
  return <section className="iris-settings__page" data-settings-route={route} hidden={!active}>{children}</section>
}
