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
 * - **「see the code」 is read-only.** The block is a `<pre>` and there is no
 *   editable element in this file — not a disabled `<textarea>`, which is an
 *   edit control that happens to be off and reads as one. Editing a model's code
 *   would mint a version nobody authorised, and authorisation is by hash, so one
 *   changed character would ask the reader to re-confirm something they wrote
 *   themselves. The note under the block says that, and says what to do instead.
 * - **Empty says a sentence.** The empty state is this feature's only entry
 *   explanation; a blank panel teaches nobody that there is a 「Grow a feature」
 *   entry in the composer — and when no authoring model is chosen, it says *that*
 *   first, because until it is done the other sentence names a control that is
 *   dark.
 *
 * The source is **not** in the list. `SandboxPluginView` carries no `code`, so
 * opening the block is its own call (`sandboxPlugin.source`) and closing it drops
 * the bytes. That is what keeps "this panel is open" from meaning "this
 * conversation's code is in the page".
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
 * The open source, as a block under its row.
 *
 * **A `<pre>` and nothing else.** Not a `<textarea readonly>`, not a
 * `contenteditable` with `false` on it: both are edit controls in a state, and a
 * reader who meets one reasonably tries to type in it. The only element here
 * that can hold a caret is the one that cannot keep a change.
 *
 * Three states in one block, because the reader is looking at the same place for
 * all three: reading, refused, and the bytes. The head carries the version and
 * the hash — the hash because that is the unit the authorisation was recorded
 * in, so it is what a reader holds against what the confirmation card said.
 * @param props.source - the open view's state.
 * @returns the block.
 */
function SourceBlock({
  source,
  onClose,
}: {
  source: { version?: number, hash?: string, code?: string, failure?: string }
  onClose: () => void
}): ReactElement {
  useLanguage()
  if (source.failure !== undefined) {
    return <span className="iris-conn__meta">{t('pluginCodeFailed', { detail: source.failure })}</span>
  }
  if (source.code === undefined) {
    return <span className="iris-conn__meta">{t('pluginCodeReading')}</span>
  }
  return (
    <div className="iris-plugin-code">
      <div className="iris-plugin-code__head">
        <span className="iris-conn__meta">
          {t('pluginCodeHead', { version: source.version ?? 0, hash: source.hash ?? '' })}
        </span>
        <button type="button" className="iris-act" onClick={onClose}>
          {t('pluginHideCode')}
        </button>
      </div>
      <pre className="iris-plugin-code__text" data-plugin-code="">{source.code}</pre>
      <span className="iris-conn__meta">{t('pluginCodeReadOnly')}</span>
    </div>
  )
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
  const open = useIris(state => state.sandboxPluginSource)
  const authoring = useIris(state => state.authoringConnection)
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
      {/*
        The panel's identity, for anything that has to find it from outside.

        Its heading is translated, and `qa/locators.mjs`'s rule is that the
        app's own chrome is never located by its visible text — a headless
        Chrome comes up in Chinese here and every English locator misses. The
        `data-tab` / `data-control` attributes exist for exactly this, and this
        is the same need one panel further in. The row carries its plugin id for
        the same reason `PluginCenter` rows carry theirs.
      */}
      <div data-panel="sandbox-plugins">
      {plugins.length === 0 ? (
        /*
          The empty state, which is this feature's only entry explanation.

          Two sentences when there is no authoring model, and **that one first**:
          the other sentence tells the reader to open 「Grow a feature」, and
          until a model is chosen that entry is dark. Instructions a reader
          cannot follow read as a broken feature, so the reason goes in front of
          them rather than behind a hover on a disabled control.
        */
        <>
          {authoring === undefined
            ? <p className="iris-field__note">{t('pluginsPanelNoAuthoring')}</p>
            : null}
          <p className="iris-field__note">{t('pluginsPanelEmpty')}</p>
        </>
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
              <div className="iris-conn" data-plugin-id={plugin.id} key={plugin.id}>
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
                  {open?.pluginId === plugin.id
                    ? <SourceBlock source={open} onClose={() => actions.closeSandboxPluginSource()} />
                    : null}
                </div>
                <div className="iris-conn__actions">
                  <button
                    type="button"
                    className="iris-act"
                    data-plugin-action="source"
                    aria-expanded={open?.pluginId === plugin.id}
                    onClick={() => void actions.readSandboxPluginSource(plugin.id)}
                  >
                    {open?.pluginId === plugin.id ? t('pluginHideCode') : t('pluginViewCode')}
                  </button>
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
      </div>
    </Section>
  )
}
