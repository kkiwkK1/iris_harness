import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import type {
  SystemPluginFailureState, SystemPluginInstallPreview, SystemPluginSnapshot,
  SystemPluginSource, SystemPluginView,
} from '@iris/protocol'
import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { usePluginBrowserAssets, type PluginAssetErrorKind, type PluginBrowserAssetStatus } from './use-plugin-manifest.ts'
import { t, useLanguage, usePluginCopy } from './i18n/use-language.ts'
import { translate, type Language, type StringKey } from './i18n/strings.ts'
import { describeBytes } from './format.ts'
import './plugin-center.css'

type Operation = 'install' | 'uninstall' | 'enable' | 'disable' | 'reload'

/*
 * The copy itself lives in the shared dictionaries (`i18n/strings.ts`, the
 * `pluginCenter*` keys), where the two-language audit in `i18n.test.ts` covers
 * it. What stays here are the tables that map this file's own enums — the
 * host's statuses, the asset probe's phases and failure kinds, the pending
 * operations, the two described plugins — onto those keys.
 */
const STATUS_KEYS: Record<SystemPluginView['status'], StringKey> = {
  'not-installed': 'pluginCenterStatusNotInstalled',
  disabled: 'pluginCenterStatusDisabled',
  enabling: 'pluginCenterStatusEnabling',
  enabled: 'pluginCenterStatusEnabled',
  disabling: 'pluginCenterStatusDisabling',
  error: 'pluginCenterStatusError',
}

const PHASE_KEYS: Record<PluginBrowserAssetStatus['phase'], StringKey> = {
  undeclared: 'pluginCenterAssetPhaseUndeclared',
  loading: 'pluginCenterAssetPhaseLoading',
  loaded: 'pluginCenterAssetPhaseLoaded',
  degraded: 'pluginCenterAssetPhaseDegraded',
  stale: 'pluginCenterAssetPhaseStale',
}

const ASSET_ERROR_KEYS: Record<PluginAssetErrorKind, StringKey> = {
  'client-missing': 'pluginCenterAssetErrorClientMissing',
  http: 'pluginCenterAssetErrorHttp',
  parse: 'pluginCenterAssetErrorParse',
  manifest: 'pluginCenterAssetErrorManifest',
  revision: 'pluginCenterAssetErrorRevision',
  conflict: 'pluginCenterAssetErrorConflict',
}

const PENDING_KEYS: Record<Operation, StringKey> = {
  install: 'pluginCenterInstalling',
  uninstall: 'pluginCenterUninstalling',
  enable: 'pluginCenterEnabling',
  disable: 'pluginCenterDisabling',
  reload: 'pluginCenterReloading',
}

/** Catalog rows whose description is the shell's own sentence, not the card's. */
const DESCRIPTION_KEYS: Record<string, StringKey> = {
  'tavern-helper': 'pluginCenterDescriptionTavernHelper',
  mvu: 'pluginCenterDescriptionMvu',
}

/** The badge word for each recorded source. `dev` is marked wherever it appears (§12 ruling 1). */
const SOURCE_KEYS: Record<SystemPluginSource, StringKey> = {
  builtin: 'pluginCenterSourceBuiltin',
  git: 'pluginCenterSourceGit',
  dev: 'pluginCenterSourceDev',
}

/** What each of the seven named failure states means, in one sentence. */
const FAILURE_KEYS: Record<SystemPluginFailureState, StringKey> = {
  'install-failed': 'pluginCenterFailureInstallFailed',
  'manifest-invalid': 'pluginCenterFailureManifestInvalid',
  incompatible: 'pluginCenterFailureIncompatible',
  tampered: 'pluginCenterFailureTampered',
  'load-failed': 'pluginCenterFailureLoadFailed',
  'activate-failed': 'pluginCenterFailureActivateFailed',
  'hook-failed': 'pluginCenterFailureHookFailed',
}

/** What the reader can do about each of them. Separate from the meaning on purpose. */
const FAILURE_FIX_KEYS: Record<SystemPluginFailureState, StringKey> = {
  'install-failed': 'pluginCenterFailureFixInstallFailed',
  'manifest-invalid': 'pluginCenterFailureFixManifestInvalid',
  incompatible: 'pluginCenterFailureFixIncompatible',
  tampered: 'pluginCenterFailureFixTampered',
  'load-failed': 'pluginCenterFailureFixLoadFailed',
  'activate-failed': 'pluginCenterFailureFixActivateFailed',
  'hook-failed': 'pluginCenterFailureFixHookFailed',
}

/** The uninstall sentence forks by source: `git` deletes the tree, `dev` never touches it. */
const UNINSTALL_KEYS: Partial<Record<SystemPluginSource, StringKey>> = {
  git: 'pluginCenterUninstallGit',
  dev: 'pluginCenterUninstallDev',
}

/**
 * The commit grammar, mirrored from the wire.
 *
 * `PLUGIN_GIT_COMMIT` (`packages/iris-protocol/src/rpc.ts:261`) is the
 * authority and still refuses everything this misses; this copy exists so a
 * typo costs a keystroke rather than a round trip, a `git clone` and a
 * refusal. It is deliberately a *copy* and not an import: `rpc.ts` is the
 * schema module, importing it here would pull zod into the settings drawer's
 * bundle, and the one thing that keeps the two in step is the comment you are
 * reading plus `plugin-center-install.test.ts`, which drives the same four
 * spellings the protocol's own test does.
 */
const COMMIT_SHAPE = /^[0-9a-f]{40}$/u

/** The wire's own bounds, for the same reason. */
const REMOTE_MAX = 2000
const PATH_MAX = 1000

/** What the install form is being asked to stage. */
export type InstallMode = 'git' | 'dev'

/**
 * The client-side shape check, as the copy key it fails with.
 *
 * Exported so the check is testable without a DOM: what a reader sees for each
 * malformed field is a property of this function, and the page only renders
 * what it answers.
 * @param mode - which half of the form is showing.
 * @param fields - the raw, untrimmed field values.
 * @returns the dictionary key naming the problem, or undefined when the shape
 * is one the host will at least look at.
 */
export function installFormProblem(
  mode: InstallMode,
  fields: { remote: string, commit: string, path: string },
): StringKey | undefined {
  if (mode === 'git') {
    const remote = fields.remote.trim()
    if (remote === '') return 'pluginCenterInstallNeedRemote'
    if (remote.length > REMOTE_MAX) return 'pluginCenterInstallLongRemote'
    if (!COMMIT_SHAPE.test(fields.commit.trim())) return 'pluginCenterInstallBadCommit'
    return undefined
  }
  const path = fields.path.trim()
  if (path === '') return 'pluginCenterInstallNeedPath'
  if (path.length > PATH_MAX) return 'pluginCenterInstallLongPath'
  return undefined
}

/** The head of a 64- or 40-hex identifier, for a row that has one line to spend. */
function abbreviate(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

/**
 * The settings drawer's plugin page.
 *
 * @param active - whether this page is the one the drawer is showing. It is a
 * prop rather than something read from here because a settings page is never
 * unmounted: `SettingsPage` (`SettingsNavigation.tsx:122`) renders every route
 * and hides all but one with the `hidden` attribute, so navigating away fires
 * no cleanup. A pending consent has to be cancelled when the reader leaves it
 * (§5.3), and without this flag there is nothing inside the component that can
 * tell "the reader is looking at this" from "this page is behind another one".
 * Defaults to true so a direct `<PluginCenter />` — the render check, the
 * harness — behaves as the visible page.
 */
export function PluginCenter({ active = true }: { active?: boolean } = {}): ReactElement {
  const { lang } = useLanguage()
  const actions = useIrisActions()
  const store = useIrisStore()
  const connected = useIris(state => state.connected)
  const snapshot = useIris(state => state.systemPlugins)
  const { statuses: assetStatuses, retry: retryAsset } = usePluginBrowserAssets(snapshot)
  const [request, setRequest] = useState<{ id: string, operation: Operation } | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [operationError, setOperationError] = useState<{ id: string, message: string } | undefined>()
  const [mode, setMode] = useState<InstallMode | undefined>()
  const [remote, setRemote] = useState('')
  const [commit, setCommit] = useState('')
  const [path, setPath] = useState('')
  const [formProblem, setFormProblem] = useState<StringKey | undefined>()
  const [installError, setInstallError] = useState<string | undefined>()
  const [preview, setPreview] = useState<SystemPluginInstallPreview | undefined>()
  const [staging, setStaging] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [reinstalling, setReinstalling] = useState<string | undefined>()
  // The row whose update form is open, and that form's one field. One row at a
  // time: an update is a question about one row's bytes, and two open forms
  // would read as two unrelated text boxes.
  const [updateFor, setUpdateFor] = useState<string | undefined>()
  const [updateCommit, setUpdateCommit] = useState('')
  const [updateStaging, setUpdateStaging] = useState(false)
  const [updateProblem, setUpdateProblem] = useState<StringKey | undefined>()
  const [updateError, setUpdateError] = useState<{ id: string, message: string } | undefined>()

  /*
   * Tokens whose transaction is already gone — confirmed, refused (a refused
   * confirm discards the whole transaction, §5.2), or explicitly cancelled.
   * A ref and not state: nothing renders from it, and the cleanup below has to
   * read the current value, not the one captured when the effect last ran.
   */
  const settled = useRef(new Set<string>())
  const discard = useCallback((token: string): void => {
    if (settled.current.has(token)) return
    settled.current.add(token)
    void actions.cancelSystemPluginInstall(token)
  }, [actions])

  /*
   * Leaving the consent page cancels it. Three ways to leave — the drawer
   * navigates to another route, the component unmounts, the reader starts a
   * different preview — and all three are this one cleanup, because all three
   * are "the token this effect was holding is no longer the one on screen".
   */
  const pending = preview?.previewToken
  useEffect(() => {
    if (pending === undefined || !active) return
    return () => { discard(pending) }
  }, [active, discard, pending])

  useEffect(() => {
    if (snapshot !== undefined || !connected) return
    let alive = true
    setLoadError(undefined)
    void actions.refreshSystemPlugins().then(result => {
      if (alive && !result.ok && store.getState().systemPlugins === undefined) setLoadError(result.error)
    })
    return () => { alive = false }
  }, [actions, connected, snapshot, store])

  if (snapshot === undefined) {
    return <div className="iris-plugins" data-plugin-center>
      <p className="iris-plugins__lead">{t('pluginCenterLead')}</p>
      <p className="iris-plugins__empty" role="status">
        {!connected ? t('pluginCenterUnavailable') : loadError === undefined ? t('pluginCenterLoading') : t('pluginCenterLoadFailed', { detail: loadError })}
      </p>
      {connected && loadError !== undefined ? <button type="button" className="iris-plugin__action" onClick={() => {
        setLoadError(undefined)
        void actions.refreshSystemPlugins().then(result => {
          if (!result.ok && store.getState().systemPlugins === undefined) setLoadError(result.error)
        })
      }}>{t('pluginCenterRetry')}</button> : null}
    </div>
  }

  const installed = snapshot.plugins.filter(plugin => plugin.installed).length
  // Not `active`: that name is this component's own prop now (is this page the
  // one the drawer is showing), and a parameter cannot be shadowed by a const.
  const activeCount = snapshot.plugins.filter(plugin => plugin.status === 'enabled').length
  const transitioning = snapshot.plugins.find(plugin => plugin.status === 'enabling' || plugin.status === 'disabling')
  const busyPlugin = request === undefined
    ? transitioning
    : snapshot.plugins.find(plugin => plugin.id === request.id)
  const busy = request !== undefined || transitioning !== undefined

  const run = async (plugin: SystemPluginView, operation: Operation): Promise<void> => {
    if (busy) return
    setRequest({ id: plugin.id, operation })
    setOperationError(current => current?.id === plugin.id ? undefined : current)
    try {
      const result = operation === 'install' ? await actions.installSystemPlugin(plugin.id)
        : operation === 'uninstall' ? await actions.uninstallSystemPlugin(plugin.id)
          : operation === 'enable' ? await actions.enableSystemPlugin(plugin.id)
            : operation === 'disable' ? await actions.disableSystemPlugin(plugin.id)
              : await actions.reloadSystemPlugin(plugin.id)
      if (!result.ok) setOperationError({ id: plugin.id, message: t('pluginCenterOperationFailed', { name: plugin.name, detail: result.error }) })
    } finally {
      setRequest(undefined)
    }
  }

  const stage = async (source: { kind: 'git', remote: string, commit: string } | { kind: 'dev', path: string }): Promise<void> => {
    setStaging(true)
    setInstallError(undefined)
    try {
      const staged = await actions.previewSystemPluginInstall(source)
      if (staged.ok) setPreview(staged.preview)
      else setInstallError(staged.error)
    } finally {
      setStaging(false)
    }
  }

  const submitForm = (): void => {
    if (mode === undefined || staging) return
    const problem = installFormProblem(mode, { remote, commit, path })
    setFormProblem(problem)
    if (problem !== undefined) return
    void stage(mode === 'git'
      ? { kind: 'git', remote: remote.trim(), commit: commit.trim() }
      : { kind: 'dev', path: path.trim() })
  }

  /*
   * §12 ruling 3. The uninstall is not optional and not a convenience: ruling 5
   * refuses a confirm whose id is already in the catalog, so the row has to go
   * before the same id can be staged again. Both steps are the ordinary RPCs —
   * there is no "reinstall" method. This is also why the update entry exists
   * beside it (U1): for a `tampered` row the update is the other road to the
   * same repair — full consent, fresh bytes fetched from the recorded remote —
   * and neither one removes the other.
   */
  const reinstall = async (plugin: SystemPluginView): Promise<void> => {
    const recordedRemote = plugin.provenance?.remote
    const recordedCommit = plugin.provenance?.commit
    if (recordedRemote === undefined || recordedCommit === undefined || reinstalling !== undefined) return
    setReinstalling(plugin.id)
    setOperationError(current => current?.id === plugin.id ? undefined : current)
    try {
      const removed = await actions.uninstallSystemPlugin(plugin.id)
      if (!removed.ok) {
        setOperationError({ id: plugin.id, message: t('pluginCenterOperationFailed', { name: plugin.name, detail: removed.error }) })
        return
      }
      const staged = await actions.previewSystemPluginInstall({ kind: 'git', remote: recordedRemote, commit: recordedCommit })
      if (staged.ok) setPreview(staged.preview)
      else setOperationError({ id: plugin.id, message: t('pluginCenterInstallRefused', { detail: staged.error }) })
    } finally {
      setReinstalling(undefined)
    }
  }

  /** Open (or reset) one row's update form. */
  const openUpdate = (id: string): void => {
    setUpdateFor(id)
    setUpdateCommit('')
    setUpdateProblem(undefined)
    setUpdateError(current => current?.id === id ? undefined : current)
  }

  /*
   * The update goes through the same consent page as an install, and the echo
   * rules are the same: this side only checks the commit's *shape* (the wire's
   * own regex, mirrored for the same reason the install form mirrors it), and
   * the confirm reads the preview object, never this field.
   */
  const submitUpdate = (plugin: SystemPluginView): void => {
    if (updateStaging) return
    const trimmed = updateCommit.trim()
    if (!COMMIT_SHAPE.test(trimmed)) {
      setUpdateProblem('pluginCenterInstallBadCommit')
      return
    }
    setUpdateProblem(undefined)
    setUpdateStaging(true)
    setUpdateError(current => current?.id === plugin.id ? undefined : current)
    void actions.updateSystemPlugin(plugin.id, trimmed).then(staged => {
      setUpdateStaging(false)
      if (staged.ok) setPreview(staged.preview)
      else setUpdateError({ id: plugin.id, message: t('pluginCenterUpdateRefused', { detail: staged.error }) })
    })
  }

  const closeUpdate = (): void => {
    setUpdateFor(undefined)
    setUpdateCommit('')
    setUpdateProblem(undefined)
  }

  /*
   * Every echoed field is read off the preview object, never off the form: the
   * form's job ended when the host staged a tree, and re-reading it would let a
   * page approve one set of bytes while displaying another. `commit ?? null` is
   * the wire's own distinction — a `dev` source has no commit, and that is not
   * the same request as one that forgot to echo it (§5.2).
   */
  const confirm = async (approved: SystemPluginInstallPreview): Promise<void> => {
    if (installing || !approved.compatible) return
    setInstalling(true)
    setInstallError(undefined)
    try {
      const result = await actions.confirmSystemPluginInstall({
        previewToken: approved.previewToken,
        id: approved.id,
        commit: approved.commit ?? null,
        treeHash: approved.treeHash,
      })
      settled.current.add(approved.previewToken)
      if (result.ok) {
        setPreview(undefined)
        setMode(undefined)
        setRemote('')
        setCommit('')
        setPath('')
        closeUpdate()
      } else {
        setInstallError(t('pluginCenterConsentRefused', { detail: result.error }))
      }
    } finally {
      setInstalling(false)
    }
  }

  if (preview !== undefined) {
    return <div className="iris-plugins" data-plugin-center data-plugin-revision={snapshot.revision}>
      <PluginConsent
        preview={preview}
        lang={lang}
        busy={installing}
        error={installError}
        onConfirm={() => { void confirm(preview) }}
        onCancel={() => {
          discard(preview.previewToken)
          setPreview(undefined)
          setInstallError(undefined)
          closeUpdate()
        }}
      />
    </div>
  }

  return <div className="iris-plugins" data-plugin-center data-plugin-revision={snapshot.revision}>
    <p className="iris-plugins__lead">{t('pluginCenterLead')}</p>
    <div className="iris-plugins__catalog-head">
      <h3>{t('pluginCenterBundled')}</h3>
      <span>{installed} {t('pluginCenterInstalled')}</span>
      <span>{activeCount} {t('pluginCenterActive')}</span>
    </div>
    <PluginInstallForm
      lang={lang}
      mode={mode}
      remote={remote}
      commit={commit}
      path={path}
      problem={formProblem}
      error={installError}
      staging={staging}
      onMode={next => {
        setMode(next)
        setFormProblem(undefined)
        setInstallError(undefined)
      }}
      onRemote={setRemote}
      onCommit={setCommit}
      onPath={setPath}
      onSubmit={submitForm}
    />
    <div className="iris-plugins__list">
      {snapshot.plugins.map(plugin => <PluginRow
        key={plugin.id}
        plugin={plugin}
        snapshot={snapshot}
        lang={lang}
        busy={busy}
        busyReason={request?.id === plugin.id
          ? t('pluginCenterRequestSent')
          : busyPlugin === undefined || busyPlugin.id === plugin.id
            ? undefined
            : t('pluginCenterWaitFor', { name: busyPlugin.name })}
        requestError={operationError?.id === plugin.id ? operationError.message : undefined}
        asset={assetStatuses[plugin.id]}
        reinstalling={reinstalling === plugin.id}
        updateOpen={updateFor === plugin.id}
        updateCommit={updateFor === plugin.id ? updateCommit : ''}
        updateStaging={updateFor === plugin.id && updateStaging}
        updateProblem={updateFor === plugin.id ? updateProblem : undefined}
        updateError={updateError?.id === plugin.id ? updateError.message : undefined}
        onUpdateOpen={() => openUpdate(plugin.id)}
        onUpdateCommit={setUpdateCommit}
        onUpdateSubmit={() => submitUpdate(plugin)}
        onUpdateCancel={closeUpdate}
        onRetryAsset={() => retryAsset(plugin.id)}
        onReinstall={reinstall}
        onRun={run}
      />)}
    </div>
    <aside className="iris-plugins__retention" aria-label={t('pluginCenterRetentionAria')}>
      <p>{t('pluginCenterRetained')}</p>
      <p>{t('pluginCenterPermission')}</p>
    </aside>
  </div>
}

/**
 * The install entry: two modes over one submit.
 *
 * Presentational — every value and every handler is the page's, so the whole
 * form is one `useState` group up there rather than a second copy of the
 * request shape down here. The two halves are radio-selected rather than
 * tabbed because they are two *sources*, and which one is chosen is part of
 * what the reader is about to consent to.
 */
function PluginInstallForm({ lang, mode, remote, commit, path, problem, error, staging, onMode, onRemote, onCommit, onPath, onSubmit }: {
  lang: Language
  mode: InstallMode | undefined
  remote: string
  commit: string
  path: string
  problem: StringKey | undefined
  error: string | undefined
  staging: boolean
  onMode: (mode: InstallMode | undefined) => void
  onRemote: (value: string) => void
  onCommit: (value: string) => void
  onPath: (value: string) => void
  onSubmit: () => void
}): ReactElement {
  const problemId = 'iris-plugin-install-problem'
  const errorId = 'iris-plugin-install-error'
  const described = [problem === undefined ? undefined : problemId, error === undefined ? undefined : errorId]
    .filter((id): id is string => id !== undefined).join(' ')

  if (mode === undefined) {
    return <div className="iris-plugins__install" data-plugin-install="closed">
      <button type="button" className="iris-plugin__action" onClick={() => onMode('git')}>
        {translate(lang, 'pluginCenterInstallOpen')}
      </button>
      <p className="iris-plugins__install-lead">{translate(lang, 'pluginCenterInstallLead')}</p>
    </div>
  }

  return <form
    className="iris-plugins__install"
    data-plugin-install={mode}
    onSubmit={event => { event.preventDefault(); onSubmit() }}
  >
    <h4>{translate(lang, 'pluginCenterInstallSection')}</h4>
    <p className="iris-plugins__install-lead">{translate(lang, 'pluginCenterInstallLead')}</p>
    <fieldset className="iris-plugins__install-mode">
      <legend>{translate(lang, 'pluginCenterInstallModeLabel')}</legend>
      {(['git', 'dev'] as const).map(candidate => <label key={candidate}>
        <input
          type="radio"
          name="iris-plugin-install-mode"
          value={candidate}
          checked={mode === candidate}
          onChange={() => onMode(candidate)}
        />
        {translate(lang, candidate === 'git' ? 'pluginCenterInstallModeGit' : 'pluginCenterInstallModeDev')}
      </label>)}
    </fieldset>
    {mode === 'git' ? <>
      <div className="iris-plugins__install-field">
        <label htmlFor="iris-plugin-install-remote">{translate(lang, 'pluginCenterInstallRemote')}</label>
        <input
          id="iris-plugin-install-remote"
          type="text"
          value={remote}
          aria-describedby={`iris-plugin-install-remote-hint${described === '' ? '' : ` ${described}`}`}
          onChange={event => onRemote(event.target.value)}
        />
        <p id="iris-plugin-install-remote-hint">{translate(lang, 'pluginCenterInstallRemoteHint')}</p>
      </div>
      <div className="iris-plugins__install-field">
        <label htmlFor="iris-plugin-install-commit">{translate(lang, 'pluginCenterInstallCommit')}</label>
        <input
          id="iris-plugin-install-commit"
          type="text"
          value={commit}
          aria-describedby={`iris-plugin-install-commit-hint${described === '' ? '' : ` ${described}`}`}
          onChange={event => onCommit(event.target.value)}
        />
        <p id="iris-plugin-install-commit-hint">{translate(lang, 'pluginCenterInstallCommitHint')}</p>
      </div>
    </> : <div className="iris-plugins__install-field">
      <label htmlFor="iris-plugin-install-path">{translate(lang, 'pluginCenterInstallPath')}</label>
      <input
        id="iris-plugin-install-path"
        type="text"
        value={path}
        aria-describedby={`iris-plugin-install-path-hint${described === '' ? '' : ` ${described}`}`}
        onChange={event => onPath(event.target.value)}
      />
      <p id="iris-plugin-install-path-hint">{translate(lang, 'pluginCenterInstallPathHint')}</p>
    </div>}
    {problem === undefined ? null : <p id={problemId} className="iris-plugins__install-problem" role="alert">{translate(lang, problem)}</p>}
    {error === undefined ? null : <p id={errorId} className="iris-plugins__install-problem" role="alert">
      {translate(lang, 'pluginCenterInstallRefused', { detail: error })}
    </p>}
    <div className="iris-plugin__actions">
      <button type="submit" className="iris-plugin__action" disabled={staging}>
        {translate(lang, staging ? 'pluginCenterInstallStaging' : 'pluginCenterInstallSubmit')}
      </button>
      <button type="button" className="iris-plugin__action" disabled={staging} onClick={() => onMode(undefined)}>
        {translate(lang, 'pluginCenterInstallDismiss')}
      </button>
    </div>
  </form>
}

/**
 * The consent page (§5.3, §12 ruling 4).
 *
 * Exported, and a pure function of its props, for two reasons that are the same
 * reason: the states worth rendering are states the fake client cannot be made
 * to produce — an `incompatible` preview above all — and a page whose every
 * input is a prop can be rendered in exactly those states by a test and by
 * `check:render`, with no seam added to the fake so that it can lie.
 *
 * Every field of `SystemPluginInstallPreview` but `previewToken` is rendered,
 * each under its own `data-consent-field` named after the protocol key, so a
 * field added to the wire and forgotten here is a test failure rather than a
 * quietly shorter page. `previewToken` is the one exclusion: it is a ticket the
 * page echoes, not a fact about the package.
 */
export function PluginConsent({ preview, lang, busy, error, onConfirm, onCancel }: {
  preview: SystemPluginInstallPreview
  lang: Language
  busy: boolean
  error: string | undefined
  onConfirm: () => void
  onCancel: () => void
}): ReactElement {
  const errorId = 'iris-plugin-consent-error'
  const list = (values: readonly string[]): string =>
    values.length === 0 ? translate(lang, 'pluginCenterNone') : values.join(', ')

  return <section
    className="iris-consent"
    data-plugin-consent={preview.source}
    data-consent-compatible={String(preview.compatible)}
    aria-label={translate(lang, 'pluginCenterConsentAria')}
  >
    <h3>{translate(lang, 'pluginCenterConsentTitle', { name: preview.displayName })}</h3>
    <aside className="iris-consent__disclosure" aria-label={translate(lang, 'pluginCenterConsentAria')}>
      <p className="iris-consent__privilege">{translate(lang, 'pluginCenterConsentPrivilege')}</p>
      {preview.source === 'dev' ? <p>{translate(lang, 'pluginCenterConsentDevNote')}</p> : null}
      <p>{translate(lang, 'pluginCenterConsentAfter')}</p>
    </aside>
    <dl className="iris-consent__facts">
      <ConsentField name="id" label={translate(lang, 'pluginCenterConsentId')}>{preview.id}</ConsentField>
      {preview.updateOf === undefined ? null : <ConsentField
        name="updateOf"
        label={translate(lang, 'pluginCenterConsentUpdateOf')}
        note={translate(lang, 'pluginCenterConsentUpdateOfNote')}
      >
        <span>{translate(lang, 'pluginCenterConsentUpdateOfValue', {
          from: abbreviate(preview.updateOf.fromCommit),
          to: preview.commit === undefined ? '—' : abbreviate(preview.commit),
        })}</span>
        <span className="iris-consent__note">{translate(lang, 'pluginCenterConsentUpdateOfHashes', {
          fromHash: abbreviate(preview.updateOf.fromTreeHash),
          toHash: abbreviate(preview.treeHash),
        })}</span>
      </ConsentField>}
      <ConsentField name="displayName" label={translate(lang, 'pluginCenterConsentName')}>{preview.displayName}</ConsentField>
      <ConsentField name="description" label={translate(lang, 'pluginCenterConsentDescription')}>{preview.description}</ConsentField>
      <ConsentField name="version" label={translate(lang, 'pluginCenterConsentVersion')}>{preview.version}</ConsentField>
      <ConsentField name="apiVersion" label={translate(lang, 'pluginCenterConsentApi')}>{preview.apiVersion}</ConsentField>
      <ConsentField name="supportedApiVersions" label={translate(lang, 'pluginCenterConsentSupported')}>{preview.supportedApiVersions}</ConsentField>
      <ConsentField name="compatible" label={translate(lang, 'pluginCenterConsentCompatible')}>
        {translate(lang, preview.compatible ? 'pluginCenterConsentApiOk' : 'pluginCenterConsentApiBad')}
      </ConsentField>
      <ConsentField name="source" label={translate(lang, 'pluginCenterConsentSource')}>
        <SourceBadge source={preview.source} lang={lang} />
      </ConsentField>
      {preview.remote === undefined ? null
        : <ConsentField name="remote" label={translate(lang, 'pluginCenterConsentRemote')}>{preview.remote}</ConsentField>}
      {preview.commit === undefined ? null
        : <ConsentField name="commit" label={translate(lang, 'pluginCenterConsentCommit')}>{preview.commit}</ConsentField>}
      {preview.path === undefined ? null
        : <ConsentField name="path" label={translate(lang, 'pluginCenterConsentPath')}>{preview.path}</ConsentField>}
      <ConsentField name="treeHash" label={translate(lang, 'pluginCenterConsentTreeHash')} note={translate(lang, 'pluginCenterConsentTreeHashNote')}>
        {preview.treeHash}
      </ConsentField>
      <ConsentField name="fileCount" label={translate(lang, 'pluginCenterConsentFiles')}>{String(preview.fileCount)}</ConsentField>
      <ConsentField name="sizeBytes" label={translate(lang, 'pluginCenterConsentSize')}>{describeBytes(preview.sizeBytes, lang)}</ConsentField>
      <ConsentField name="capabilities" label={translate(lang, 'pluginCenterConsentCapabilities')} note={translate(lang, 'pluginCenterConsentCapabilitiesNote')}>
        {list(preview.capabilities)}
      </ConsentField>
      <ConsentField name="permissions" label={translate(lang, 'pluginCenterConsentPermissions')} note={translate(lang, 'pluginCenterConsentPermissionsNote')}>
        {preview.permissions.length === 0 ? translate(lang, 'pluginCenterNone')
          : <ul className="iris-consent__permissions">
            {preview.permissions.map(permission => <li key={permission}>{permission}</li>)}
          </ul>}
      </ConsentField>
      <ConsentField name="dependencies" label={translate(lang, 'pluginCenterConsentDependencies')}>{list(preview.dependencies)}</ConsentField>
      <ConsentField name="hasClient" label={translate(lang, 'pluginCenterConsentClient')}>
        {translate(lang, preview.hasClient ? 'pluginCenterConsentClientYes' : 'pluginCenterConsentClientNo')}
      </ConsentField>
      {/* States the fact and promises nothing: the copy was audited before
          this page ever rendered (the artifact contract), so the row only
          says how much the package carries. */}
      <ConsentField name="i18n" label={translate(lang, 'pluginCenterConsentCopy')}>
        {preview.i18n === undefined ? translate(lang, 'pluginCenterConsentCopyNone')
          : translate(lang, 'pluginCenterConsentCopyCount', { count: preview.i18n.keys, languages: preview.i18n.languages.join('/') })}
      </ConsentField>
      <ConsentField name="warnings" label={translate(lang, 'pluginCenterConsentWarnings')}>
        {preview.warnings.length === 0 ? translate(lang, 'pluginCenterNone')
          : <ul className="iris-consent__warnings">
            {preview.warnings.map(warning => <li key={warning}>{warning}</li>)}
          </ul>}
      </ConsentField>
    </dl>
    {preview.compatible ? null : <p className="iris-consent__refusal" role="alert">
      {translate(lang, 'pluginCenterConsentIncompatible')}
    </p>}
    {error === undefined ? null : <p id={errorId} className="iris-consent__refusal" role="alert">{error}</p>}
    <div className="iris-plugin__actions">
      <button
        type="button"
        className="iris-plugin__action"
        data-consent-confirm
        disabled={busy || !preview.compatible}
        aria-describedby={error === undefined ? undefined : errorId}
        onClick={onConfirm}
      >{translate(lang, busy ? 'pluginCenterConsentInstalling' : 'pluginCenterConsentConfirm')}</button>
      <button type="button" className="iris-plugin__action" data-consent-cancel disabled={busy} onClick={onCancel}>
        {translate(lang, 'pluginCenterConsentCancel')}
      </button>
    </div>
  </section>
}

/** One consent row, tagged with the protocol key it renders. */
function ConsentField({ name, label, note, children }: {
  name: string
  label: string
  note?: string | undefined
  children: ReactNode
}): ReactElement {
  return <div className="iris-consent__field" data-consent-field={name}>
    <dt>{label}</dt>
    <dd>
      {children}
      {note === undefined ? null : <span className="iris-consent__note">{note}</span>}
    </dd>
  </div>
}

/** The source badge. `dev` carries its disclosure in the title attribute too. */
function SourceBadge({ source, lang }: { source: SystemPluginSource, lang: Language }): ReactElement {
  return <span
    className={`iris-plugin__source iris-plugin__source--${source}`}
    data-plugin-source={source}
    aria-label={translate(lang, 'pluginCenterSourceAria')}
    title={source === 'dev' ? translate(lang, 'pluginCenterSourceDevTitle') : undefined}
  >{translate(lang, SOURCE_KEYS[source])}</span>
}

function PluginRow({ plugin, snapshot, lang, busy, busyReason, requestError, asset, reinstalling, updateOpen, updateCommit, updateStaging, updateProblem, updateError, onUpdateOpen, onUpdateCommit, onUpdateSubmit, onUpdateCancel, onRetryAsset, onReinstall, onRun }: {
  plugin: SystemPluginView
  snapshot: SystemPluginSnapshot
  lang: Language
  busy: boolean
  busyReason: string | undefined
  requestError: string | undefined
  asset: PluginBrowserAssetStatus | undefined
  reinstalling: boolean
  updateOpen: boolean
  updateCommit: string
  updateStaging: boolean
  updateProblem: StringKey | undefined
  updateError: string | undefined
  onUpdateOpen: () => void
  onUpdateCommit: (value: string) => void
  onUpdateSubmit: () => void
  onUpdateCancel: () => void
  onRetryAsset: () => void
  onReinstall: (plugin: SystemPluginView) => Promise<void>
  onRun: (plugin: SystemPluginView, operation: Operation) => Promise<void>
}): ReactElement {
  const dependents = snapshot.plugins.filter(candidate =>
    candidate.enabled && candidate.dependencies.includes(plugin.id),
  )
  const blocked = dependents.length > 0
  const blockedText = blocked
    ? translate(lang, 'pluginCenterBlocked', { names: dependents.map(row => row.name).join(', ') })
    : undefined
  const status = translate(lang, STATUS_KEYS[plugin.status])
  /*
   * U5 ruling 7: the row speaks the plugin's own copy where it has one, under
   * the shell's own sentences where the shell has something to say. Order:
   * the two built-in descriptions stay the shell's (`DESCRIPTION_KEYS` — a
   * plugin cannot take those sentences away), then the bundled copy in the
   * current language (`zh` → `en`), then the snapshot's manifest sentence.
   * The row subscribes to the overlay (`usePluginCopy`) because copy arrives
   * after the row first renders.
   */
  const copyTables = usePluginCopy()[plugin.id]
  const descriptionKey = DESCRIPTION_KEYS[plugin.id]
  const description = descriptionKey !== undefined
    ? translate(lang, descriptionKey)
    : copyTables?.[lang]?.description ?? copyTables?.en?.description ?? plugin.description
  const displayName = copyTables?.[lang]?.displayName ?? copyTables?.en?.displayName ?? plugin.name
  const dependencies = plugin.dependencies.map(id => snapshot.plugins.find(row => row.id === id)?.name ?? id)
  const statusId = `iris-plugin-status-${safeId(plugin.id)}`
  const blockedId = `iris-plugin-blocked-${safeId(plugin.id)}`
  const busyId = `iris-plugin-busy-${safeId(plugin.id)}`
  const errorId = `iris-plugin-error-${safeId(plugin.id)}`
  const transitioning = plugin.status === 'enabling' ? 'enable' : plugin.status === 'disabling' ? 'disable' : undefined
  const describedBy = [statusId, blockedText === undefined ? undefined : blockedId, busyReason === undefined ? undefined : busyId, requestError === undefined ? undefined : errorId]
    .filter((id): id is string => id !== undefined)
    .join(' ')

  const uninstallKey = plugin.source === undefined ? undefined : UNINSTALL_KEYS[plugin.source]
  /*
   * §12 ruling 3: the one way out of `tampered` is the recorded (remote,
   * commit) through the full consent. There is deliberately no button that
   * accepts the current bytes — that would make the whole hash lock bypassable
   * in one click. U1 adds the update entry beside it: the same consent, the
   * row's own remote, a commit the user types. Both roads run the full review;
   * neither one replaces the other.
   */
  const reinstallable = plugin.failure?.state === 'tampered'
  const recorded = reinstallable
    && plugin.provenance?.remote !== undefined
    && plugin.provenance.commit !== undefined
  // The update entry is for installed git rows only: a dev row is loaded in
  // place (its note says so), and a builtin row ships with this build.
  const updatable = plugin.source === 'git' && plugin.installed

  return <article className="iris-plugin" data-plugin-id={plugin.id} data-plugin-status={plugin.status} data-plugin-source={plugin.source ?? 'unrecorded'}>
    <header className="iris-plugin__head">
      <div>
        <h4>{displayName}{plugin.source === undefined ? null : <> <SourceBadge source={plugin.source} lang={lang} /></>}</h4>
        <p>{description}</p>
        <p className="iris-plugin__id">{plugin.id}</p>
      </div>
      <span id={statusId} className={`iris-plugin__status iris-plugin__status--${plugin.status}`} role="status" aria-live="polite">
        {status}
      </span>
    </header>
    <dl className="iris-plugin__facts">
      <div><dt>{translate(lang, 'pluginCenterVersion')}</dt><dd>{plugin.version}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterApi')}</dt><dd>v{plugin.apiVersion}</dd></div>
      <div className="iris-plugin__dependency"><dt>{translate(lang, 'pluginCenterDependencies')}</dt><dd>{dependencies.length === 0 ? translate(lang, 'pluginCenterNone') : dependencies.join(', ')}</dd></div>
    </dl>
    {plugin.provenance === undefined ? null : <Provenance provenance={plugin.provenance} lang={lang} />}
    {asset === undefined ? null : <AssetStatus plugin={plugin} asset={asset} lang={lang} onRetry={onRetryAsset} />}
    {plugin.failure === undefined ? null : <p className="iris-plugin__failure" data-plugin-failure={plugin.failure.state} role="alert">
      <strong>{translate(lang, 'pluginCenterFailureTitle')}</strong> {translate(lang, FAILURE_KEYS[plugin.failure.state])}
      {plugin.failure.field === undefined ? null : <span>{translate(lang, 'pluginCenterFailureField', { field: plugin.failure.field })}</span>}
      {plugin.failure.step === undefined ? null : <span>{translate(lang, 'pluginCenterFailureStep', { step: plugin.failure.step })}</span>}
      <span className="iris-plugin__failure-reason">{plugin.failure.reason}</span>
      <span>{translate(lang, FAILURE_FIX_KEYS[plugin.failure.state])}</span>
      {reinstallable && !recorded ? <span>{translate(lang, 'pluginCenterFailureNoRecord')}</span> : null}
    </p>}
    {plugin.error === undefined ? null : <p className="iris-plugin__error" role="alert">
      <strong>{translate(lang, 'pluginCenterReportedError')}</strong> {plugin.error}
      <span>{translate(lang, 'pluginCenterFixError')}</span>
    </p>}
    {requestError === undefined ? null : <p id={errorId} className="iris-plugin__error" role="alert">{requestError}</p>}
    {blockedText === undefined ? null : <p id={blockedId} className="iris-plugin__blocked">{blockedText}</p>}
    {busyReason === undefined ? null : <p id={busyId} className="iris-plugin__busy" role="status">{busyReason}</p>}
    <div className="iris-plugin__actions" role="group" aria-label={plugin.name} aria-describedby={describedBy}>
      {transitioning !== undefined
        ? <Action plugin={plugin} operation={transitioning} disabled label={translate(lang, PENDING_KEYS[transitioning])} onRun={onRun} />
        : !plugin.installed ? <Action plugin={plugin} operation="install" disabled={busy} label={translate(lang, 'pluginCenterInstall')} reason={busyReason} onRun={onRun} /> : <>
        {plugin.enabled
          ? <Action plugin={plugin} operation="disable" disabled={busy || blocked} label={translate(lang, 'pluginCenterDisable')} reason={blockedText ?? busyReason} onRun={onRun} />
          : <Action plugin={plugin} operation="enable" disabled={busy} label={translate(lang, plugin.status === 'error' ? 'pluginCenterRetryEnable' : 'pluginCenterEnable')} reason={busyReason} onRun={onRun} />}
        {plugin.enabled ? <Action plugin={plugin} operation="reload" disabled={busy || blocked} label={translate(lang, 'pluginCenterReload')} reason={blockedText ?? busyReason} onRun={onRun} /> : null}
        <Action plugin={plugin} operation="uninstall" disabled={busy || blocked} label={translate(lang, 'pluginCenterUninstall')} reason={blockedText ?? busyReason} onRun={onRun} />
      </>}
      {recorded ? <button
        type="button"
        className="iris-plugin__action iris-plugin__action--danger"
        data-plugin-reinstall={plugin.id}
        disabled={busy || blocked || reinstalling}
        title={busy || blocked ? (blockedText ?? busyReason) : undefined}
        onClick={() => { void onReinstall(plugin) }}
      >{translate(lang, reinstalling ? 'pluginCenterFailureReinstalling' : 'pluginCenterFailureReinstall')}</button> : null}
      {updatable ? <button
        type="button"
        className="iris-plugin__action"
        data-plugin-update={plugin.id}
        disabled={busy}
        title={busy ? (blockedText ?? busyReason) : undefined}
        onClick={onUpdateOpen}
      >{translate(lang, 'pluginCenterUpdateOpen')}</button> : null}
    </div>
    {updateOpen && updatable ? <form
      className="iris-plugin__update"
      data-plugin-update-form={plugin.id}
      onSubmit={event => { event.preventDefault(); onUpdateSubmit() }}
    >
      <h5>{translate(lang, 'pluginCenterUpdate')}</h5>
      <div className="iris-plugin__update-field">
        <label htmlFor={`iris-plugin-update-commit-${safeId(plugin.id)}`}>{translate(lang, 'pluginCenterUpdateCommit')}</label>
        <input
          id={`iris-plugin-update-commit-${safeId(plugin.id)}`}
          type="text"
          value={updateCommit}
          aria-describedby={`iris-plugin-update-hint-${safeId(plugin.id)}`}
          onChange={event => onUpdateCommit(event.target.value)}
        />
        <p id={`iris-plugin-update-hint-${safeId(plugin.id)}`}>{translate(lang, 'pluginCenterUpdateCommitHint')}</p>
      </div>
      {updateProblem === undefined ? null : <p className="iris-plugins__install-problem" role="alert">{translate(lang, updateProblem)}</p>}
      {updateError === undefined ? null : <p className="iris-plugins__install-problem" role="alert">{updateError}</p>}
      {updateCommit.trim() !== '' && updateCommit.trim() === plugin.provenance?.commit
        ? <p className="iris-plugin__update-note" role="status">{translate(lang, 'pluginCenterUpdateSameCommit')}</p>
        : null}
      <div className="iris-plugin__actions">
        <button type="submit" className="iris-plugin__action" disabled={updateStaging}>
          {translate(lang, updateStaging ? 'pluginCenterUpdateStaging' : 'pluginCenterUpdateSubmit')}
        </button>
        <button type="button" className="iris-plugin__action" disabled={updateStaging} onClick={onUpdateCancel}>
          {translate(lang, 'pluginCenterUpdateCancel')}
        </button>
      </div>
    </form> : null}
    {plugin.source === 'dev' && plugin.installed ? <p className="iris-plugin__update-note" data-plugin-dev-note>
      {translate(lang, 'pluginCenterUpdateDevNote')}
    </p> : null}
    {uninstallKey === undefined ? null : <p className="iris-plugin__uninstall-note" data-uninstall-copy={plugin.source}>
      {translate(lang, uninstallKey)}
    </p>}
  </article>
}

/**
 * What the host recorded when this row's bytes arrived.
 *
 * Compact by default — a shortened commit and tree hash, the install date —
 * because a row is a list entry and a 64-hex string is not. The full values are
 * one keystroke away in the `<details>`, and on the summary's `title` for a
 * pointer, because "short commit" is only ever useful until the moment someone
 * has to compare it with something.
 */
function Provenance({ provenance, lang }: {
  provenance: NonNullable<SystemPluginView['provenance']>
  lang: Language
}): ReactElement {
  const compact = [
    provenance.commit === undefined ? undefined : abbreviate(provenance.commit),
    provenance.treeHash === undefined ? undefined : abbreviate(provenance.treeHash),
    provenance.installedAt,
  ].filter((part): part is string => part !== undefined).join(' · ')
  const full = [provenance.remote, provenance.path, provenance.commit, provenance.treeHash]
    .filter((part): part is string => part !== undefined).join('\n')

  return <details className="iris-plugin__provenance" data-plugin-provenance>
    <summary title={full === '' ? undefined : full}>
      {translate(lang, 'pluginCenterProvenance')}{compact === '' ? '' : ` — ${compact}`}
    </summary>
    <dl className="iris-plugin__facts">
      {provenance.remote === undefined ? null : <div data-provenance-field="remote">
        <dt>{translate(lang, 'pluginCenterConsentRemote')}</dt><dd>{provenance.remote}</dd>
      </div>}
      {provenance.path === undefined ? null : <div data-provenance-field="path">
        <dt>{translate(lang, 'pluginCenterConsentPath')}</dt><dd>{provenance.path}</dd>
      </div>}
      {provenance.commit === undefined ? null : <div data-provenance-field="commit">
        <dt>{translate(lang, 'pluginCenterConsentCommit')}</dt><dd>{provenance.commit}</dd>
      </div>}
      {provenance.treeHash === undefined ? null : <div data-provenance-field="treeHash">
        <dt>{translate(lang, 'pluginCenterConsentTreeHash')}</dt><dd>{provenance.treeHash}</dd>
      </div>}
      {provenance.installedAt === undefined ? null : <div data-provenance-field="installedAt">
        <dt>{translate(lang, 'pluginCenterProvenanceInstalledAt')}</dt><dd>{provenance.installedAt}</dd>
      </div>}
    </dl>
    <p className="iris-plugin__provenance-note">{translate(lang, 'pluginCenterProvenanceExpand')}</p>
  </details>
}

/**
 * The browser-asset half of the status surface: a second, independent row of
 * state next to the host's enable chip. A degraded or stale asset names the
 * catalog revision, the manifest revision that answers for it, the content rev
 * of the bytes actually served, the last error (classified so the six failure
 * kinds read differently), the last successful load, and a retry that
 * re-fetches the manifest row and the bundle — it never touches the host
 * plugin's enabled state, which stays exactly what the snapshot says.
 *
 * The three numbers are exported for render-check for the same reason the
 * consent page is: the surface's whole point is what it shows for a given
 * input, and the dimension mistake it used to carry — a catalog revision
 * count and a content hash side by side under labels that read as comparable —
 * is exactly the kind of thing a server render of one constructed row pins.
 */
export function AssetStatus({ plugin, asset, lang, onRetry }: {
  plugin: SystemPluginView
  asset: PluginBrowserAssetStatus
  lang: Language
  onRetry: () => void
}): ReactElement {
  const degraded = asset.phase === 'degraded' || asset.phase === 'stale'
  const assetId = `iris-plugin-asset-${safeId(plugin.id)}`
  const assetErrorId = `iris-plugin-asset-error-${safeId(plugin.id)}`
  const loadedAt = asset.loadedAt === undefined ? undefined : new Date(asset.loadedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
  return <div className={`iris-plugin__asset iris-plugin__asset--${asset.phase}`} id={assetId} data-plugin-asset-phase={asset.phase}>
    <dl className="iris-plugin__asset-facts">
      <div><dt>{translate(lang, 'pluginCenterHostRuntime')}</dt><dd>{translate(lang, STATUS_KEYS[plugin.status])}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterBrowserAsset')}</dt><dd className="iris-plugin__asset-phase">{translate(lang, PHASE_KEYS[asset.phase])}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterExpectedRevision')}</dt><dd>{asset.expectedRevision === undefined ? translate(lang, 'pluginCenterNone') : String(asset.expectedRevision)}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterManifestRevision')}</dt><dd>{asset.manifestRevision === undefined ? translate(lang, 'pluginCenterNone') : String(asset.manifestRevision)}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterActualRevision')}</dt><dd data-asset-rev={asset.actualRevision}>{asset.actualRevision ?? translate(lang, 'pluginCenterNone')}</dd></div>
      <div><dt>{translate(lang, 'pluginCenterLastLoaded')}</dt><dd>{loadedAt ?? translate(lang, 'pluginCenterLastLoadedNever')}</dd></div>
    </dl>
    {degraded && asset.error !== undefined ? <div className="iris-plugin__asset-failure">
      <p className="iris-plugin__asset-error" role="alert" id={assetErrorId}>
        <strong>{translate(lang, 'pluginCenterAssetErrorTitle')}</strong> {translate(lang, ASSET_ERROR_KEYS[asset.error.kind])} {asset.error.message}
        <span>{translate(lang, 'pluginCenterAssetErrorFix')}</span>
      </p>
      {asset.error.kind === 'conflict' && asset.error.sources !== undefined
        ? <p className="iris-plugin__asset-conflict">{asset.error.sources.claimants.map(id => `#${id}`).join(' + ')} → {asset.error.sources.member}</p>
        : null}
      <button type="button" className="iris-plugin__action" aria-describedby={assetErrorId} onClick={onRetry}>{translate(lang, 'pluginCenterAssetRetry')}</button>
    </div> : null}
  </div>
}

function Action({ plugin, operation, disabled, label, reason, danger = false, onRun }: {
  plugin: SystemPluginView
  operation: Operation
  disabled: boolean
  label: string
  reason?: string | undefined
  danger?: boolean
  onRun: (plugin: SystemPluginView, operation: Operation) => Promise<void>
}): ReactElement {
  return <button
    type="button"
    className={`iris-plugin__action${danger ? ' iris-plugin__action--danger' : ''}`}
    disabled={disabled}
    title={disabled ? reason : undefined}
    onClick={() => { void onRun(plugin, operation) }}
  >{label}</button>
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}
