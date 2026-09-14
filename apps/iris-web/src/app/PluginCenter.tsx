import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'
import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { usePluginBrowserAssets, type PluginAssetErrorKind, type PluginBrowserAssetStatus } from './use-plugin-manifest.ts'
import { t, useLanguage } from './i18n/use-language.ts'
import { translate, type Language, type StringKey } from './i18n/strings.ts'
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

export function PluginCenter(): ReactElement {
  const { lang } = useLanguage()
  const actions = useIrisActions()
  const store = useIrisStore()
  const connected = useIris(state => state.connected)
  const snapshot = useIris(state => state.systemPlugins)
  const { statuses: assetStatuses, retry: retryAsset } = usePluginBrowserAssets(snapshot)
  const [request, setRequest] = useState<{ id: string, operation: Operation } | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [operationError, setOperationError] = useState<{ id: string, message: string } | undefined>()

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
  const active = snapshot.plugins.filter(plugin => plugin.status === 'enabled').length
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

  return <div className="iris-plugins" data-plugin-center data-plugin-revision={snapshot.revision}>
    <p className="iris-plugins__lead">{t('pluginCenterLead')}</p>
    <div className="iris-plugins__catalog-head">
      <h3>{t('pluginCenterBundled')}</h3>
      <span>{installed} {t('pluginCenterInstalled')}</span>
      <span>{active} {t('pluginCenterActive')}</span>
    </div>
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
        onRetryAsset={() => retryAsset(plugin.id)}
        onRun={run}
      />)}
    </div>
    <aside className="iris-plugins__retention" aria-label={t('pluginCenterRetentionAria')}>
      <p>{t('pluginCenterRetained')}</p>
      <p>{t('pluginCenterPermission')}</p>
    </aside>
  </div>
}

function PluginRow({ plugin, snapshot, lang, busy, busyReason, requestError, asset, onRetryAsset, onRun }: {
  plugin: SystemPluginView
  snapshot: SystemPluginSnapshot
  lang: Language
  busy: boolean
  busyReason: string | undefined
  requestError: string | undefined
  asset: PluginBrowserAssetStatus | undefined
  onRetryAsset: () => void
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
  const descriptionKey = DESCRIPTION_KEYS[plugin.id]
  const description = descriptionKey === undefined ? plugin.description : translate(lang, descriptionKey)
  const dependencies = plugin.dependencies.map(id => snapshot.plugins.find(row => row.id === id)?.name ?? id)
  const statusId = `iris-plugin-status-${safeId(plugin.id)}`
  const blockedId = `iris-plugin-blocked-${safeId(plugin.id)}`
  const busyId = `iris-plugin-busy-${safeId(plugin.id)}`
  const errorId = `iris-plugin-error-${safeId(plugin.id)}`
  const transitioning = plugin.status === 'enabling' ? 'enable' : plugin.status === 'disabling' ? 'disable' : undefined
  const describedBy = [statusId, blockedText === undefined ? undefined : blockedId, busyReason === undefined ? undefined : busyId, requestError === undefined ? undefined : errorId]
    .filter((id): id is string => id !== undefined)
    .join(' ')

  return <article className="iris-plugin" data-plugin-id={plugin.id} data-plugin-status={plugin.status}>
    <header className="iris-plugin__head">
      <div>
        <h4>{plugin.name}</h4>
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
    {asset === undefined ? null : <AssetStatus plugin={plugin} asset={asset} lang={lang} onRetry={onRetryAsset} />}
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
    </div>
  </article>
}

/**
 * The browser-asset half of the status surface: a second, independent row of
 * state next to the host's enable chip. A degraded or stale asset names the
 * expected revision, the revision actually served, the last error (classified
 * so the six failure kinds read differently), the last successful load, and a
 * retry that re-fetches the manifest row and the bundle — it never touches the
 * host plugin's enabled state, which stays exactly what the snapshot says.
 */
function AssetStatus({ plugin, asset, lang, onRetry }: {
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
      <div><dt>{translate(lang, 'pluginCenterActualRevision')}</dt><dd>{asset.actualRevision ?? translate(lang, 'pluginCenterNone')}</dd></div>
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
