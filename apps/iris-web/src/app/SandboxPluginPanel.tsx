/**
 * 「What this conversation grew」 — one row per sandbox plugin.
 *
 * In the sidebar, through `iris.sidebar.panels` (`docs/SANDBOX-PLUGINS.md` §12),
 * rather than in the settings drawer: this is a property of **this
 * conversation**, like its messages and its variables, and the drawer's
 * equivalent place belongs to system plugins, which are a property of this
 * installation. Putting them in one list would be the first step toward one
 * control panel for two things whose consent, trust, lifetime and deletion
 * semantics have nothing in common.
 *
 * Three rules the design fixes, and all three are about what a row says rather
 * than what it does:
 *
 * - **A failed row is not merely greyed out.** It names the state and what the
 *   reader can do about it, because the two failures they will actually meet
 *   have different answers: `mount-failed` is fixed by saying another sentence,
 *   `dispose-failed` by leaving the conversation and coming back.
 * - **「see the code」 is read-only** — and is PR-D, so it is not here. Editing a
 *   model's code would mint a version nobody authorised, and authorisation is by
 *   hash, so one changed character would ask the reader to re-confirm something
 *   they wrote themselves.
 * - **Empty says a sentence.** The empty state is this feature's only entry
 *   explanation; a blank panel teaches nobody that there is a 「Grow a feature」
 *   entry in the composer.
 *
 * @module iris-web/app/SandboxPluginPanel
 */
import type { ReactElement } from 'react'

import type { SandboxPluginView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * What one row's state line says.
 *
 * Four readings, and the order matters: a failure is louder than a switch, a
 * switch is louder than an authorisation, and 「waiting for your answer」 is what
 * an un-authorised row is — not a failure, and not something the reader forgot.
 * @param plugin - the row.
 * @returns the sentence.
 */
function stateOf(plugin: SandboxPluginView): string {
  if (plugin.failure !== undefined) {
    return t('pluginStateFailed', { state: plugin.failure.state, detail: plugin.failure.detail })
  }
  if (!plugin.enabled) return t('pluginStateDisabled')
  if (!plugin.authorized) return t('pluginStatePending')
  return t('pluginStateMounted')
}

/**
 * What the reader can do about a failure, when there is something.
 * @param plugin - the row.
 * @returns the sentence, or undefined.
 */
function fixOf(plugin: SandboxPluginView): string | undefined {
  if (plugin.failure === undefined) return undefined
  if (plugin.failure.state === 'mount-failed') return t('pluginFixMountFailed')
  if (plugin.failure.state === 'dispose-failed') return t('pluginFixDisposeFailed')
  return undefined
}

/**
 * Render the panel.
 * @returns the section.
 */
export function SandboxPluginPanel(): ReactElement | null {
  const chatId = useIris(state => state.chatId)
  const plugins = useIris(state => state.sandboxPlugins)
  const listedFor = useIris(state => state.sandboxPluginsFor)
  const declined = useIris(state => state.scriptsAllowed) === 'declined'
  const actions = useIrisActions()
  useLanguage()

  // No conversation, no panel. The sidebar is also the place a reader stands
  // when nothing is open, and a heading over an empty list would be a question
  // about a conversation that does not exist.
  if (chatId === undefined) return null
  // The list for *this* conversation, or nothing: showing the previous chat's
  // plugins under this one's name for the length of a round trip is the failure
  // `sandboxPluginsFor` exists to prevent.
  if (listedFor !== chatId) return null

  return (
    <Section title={t('pluginsPanelTitle')}>
      {plugins.length === 0 ? (
        <p className="iris-field__note">{t('pluginsPanelEmpty')}</p>
      ) : (
        <>
          {/*
            The refusal's consequence, said where the plugins are.

            `scriptsAllowed === 'declined'` means "do not run this card's code",
            and a plugin is code (§4.2). Without this line a reader who declined
            would see rows saying 「Running」 and no frame, which is the one
            failure mode this whole panel exists to make impossible.
          */}
          {declined ? <p className="iris-field__note">{t('pluginsDeclined', { count: plugins.length })}</p> : null}
          {plugins.map(plugin => {
            const version = plugin.versions.at(-1)
            const fix = fixOf(plugin)
            return (
              <div className="iris-conn" key={plugin.id}>
                <div className="iris-conn__main">
                  <span className="iris-conn__name">{version?.name ?? plugin.id}</span>
                  <span className="iris-conn__summary">{version?.purpose ?? ''}</span>
                  <span className="iris-conn__meta">
                    {[
                      stateOf(plugin),
                      t('pluginVersionLabel', { version: version?.version ?? 0 }),
                      ...plugin.branchedFrom === undefined ? [] : [t('pluginBranchedFrom')],
                    ].join(' · ')}
                  </span>
                  {version === undefined ? null : (
                    <span className="iris-conn__meta">「{version.prompt}」</span>
                  )}
                  {fix === undefined ? null : <span className="iris-conn__meta">{fix}</span>}
                </div>
                <div className="iris-conn__actions">
                  <button
                    type="button"
                    className="iris-act"
                    onClick={() => void actions.decideSandboxPlugin(
                      plugin.id,
                      plugin.enabled ? 'disable' : 'enable',
                    )}
                  >
                    {plugin.enabled ? t('pluginDisable') : t('pluginEnable')}
                  </button>
                  <button
                    type="button"
                    className="iris-act iris-act--danger"
                    onClick={() => void actions.decideSandboxPlugin(plugin.id, 'remove')}
                  >
                    {t('pluginRemove')}
                  </button>
                </div>
              </div>
            )
          })}
        </>
      )}
    </Section>
  )
}
