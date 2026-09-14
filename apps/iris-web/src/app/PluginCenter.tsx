import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { SystemPluginSnapshot, SystemPluginView } from '@iris/protocol'
import { useIris, useIrisActions, useIrisStore } from '../client/provider.tsx'
import { usePluginBrowserAssets, type PluginAssetErrorKind, type PluginBrowserAssetStatus } from './use-plugin-manifest.ts'
import { useLanguage } from './i18n/use-language.ts'
import type { Language } from './i18n/strings.ts'
import './plugin-center.css'

type Operation = 'install' | 'uninstall' | 'enable' | 'disable' | 'reload'

const COPY = {
  en: {
    lead: 'System plugins provide optional runtime capabilities to cards. Card script permission is managed separately.',
    bundled: 'Bundled catalog',
    installed: 'installed',
    active: 'active',
    loading: 'Reading the system plugin catalog…',
    unavailable: 'The plugin catalog is unavailable while Iris is offline.',
    loadFailed: (detail: string) => `The plugin catalog could not be read. ${detail}`,
    retry: 'Retry',
    version: 'Version',
    api: 'Plugin API',
    dependencies: 'Requires',
    none: 'None',
    retained: 'Uninstalling keeps card and chat data, stored variables, and plugin settings. Bundled plugins can be reinstalled without a download.',
    permission: 'Enabling a system plugin does not allow card scripts or grant page access.',
    install: 'Reinstall',
    uninstall: 'Uninstall',
    enable: 'Enable',
    retryEnable: 'Retry enable',
    disable: 'Disable',
    reload: 'Reload',
    installing: 'Reinstalling…',
    uninstalling: 'Uninstalling…',
    enabling: 'Enabling…',
    disabling: 'Disabling…',
    reloading: 'Reloading…',
    requestSent: 'Request sent. Waiting for Iris to report the result.',
    waitFor: (name: string) => `Wait for ${name} to finish before changing another plugin.`,
    operationFailed: (name: string, detail: string) => `Iris could not change ${name}. ${detail}`,
    reportedError: 'Host error:',
    fixError: 'Fix the reported cause, then retry enable or uninstall this plugin.',
    blocked: (names: string) => `Disable ${names} first.`,
    descriptions: {
      'tavern-helper': 'Compatibility APIs and managed script lifetimes for community cards.',
      mvu: 'Variable initialization, updates, and replay for compatible cards.',
    },
    statuses: {
      'not-installed': 'Not installed',
      disabled: 'Disabled',
      enabling: 'Enabling…',
      enabled: 'Enabled',
      disabling: 'Disabling…',
      error: 'Error',
    },
    hostRuntime: 'Host runtime',
    browserAsset: 'Browser asset',
    assetPhases: {
      undeclared: 'Not declared',
      loading: 'Loading…',
      loaded: 'Loaded',
      degraded: 'Degraded',
      stale: 'Stale revision',
    },
    expectedRevision: 'Expected revision',
    actualRevision: 'Loaded revision',
    lastLoaded: 'Last loaded',
    lastLoadedNever: 'Never',
    assetErrorTitle: 'Browser asset problem:',
    assetErrorFix: 'The host plugin stays enabled; fix the browser asset, then retry. Ordinary cards keep running meanwhile.',
    assetRetry: 'Retry asset load',
    assetErrors: {
      'client-missing': 'client.js does not exist.',
      http: 'HTTP fetch of the browser asset failed.',
      parse: 'The browser asset failed JavaScript parsing.',
      manifest: 'The plugin manifest is malformed.',
      revision: 'The loaded manifest does not match the current revision.',
      conflict: 'Member name conflict between plugins.',
    } as Record<PluginAssetErrorKind, string>,
  },
  zh: {
    lead: '系统插件为卡片提供可选的运行能力。卡片脚本权限仍在脚本页面中单独管理。',
    bundled: '内置插件目录',
    installed: '个已安装',
    active: '个运行中',
    loading: '正在读取系统插件目录…',
    unavailable: 'Iris 离线时无法读取插件目录。',
    loadFailed: (detail: string) => `无法读取插件目录。${detail}`,
    retry: '重试',
    version: '版本',
    api: '插件 API',
    dependencies: '依赖',
    none: '无',
    retained: '卸载会保留卡片与聊天数据、已存变量和插件设置。内置插件可直接重新安装，无需下载。',
    permission: '启用系统插件不会允许卡片脚本运行，也不会授予页面访问权。',
    install: '重新安装',
    uninstall: '卸载',
    enable: '启用',
    retryEnable: '重试启用',
    disable: '停用',
    reload: '重新加载',
    installing: '正在重新安装…',
    uninstalling: '正在卸载…',
    enabling: '正在启用…',
    disabling: '正在停用…',
    reloading: '正在重新加载…',
    requestSent: '请求已发送，正在等待 Iris 返回实际结果。',
    waitFor: (name: string) => `请等待 ${name} 完成，再更改其他插件。`,
    operationFailed: (name: string, detail: string) => `Iris 无法更改 ${name}。${detail}`,
    reportedError: '宿主错误：',
    fixError: '请先处理上述原因，再重试启用或卸载此插件。',
    blocked: (names: string) => `请先停用 ${names}。`,
    descriptions: {
      'tavern-helper': '为社区卡片提供兼容 API，并管理脚本的运行生命周期。',
      mvu: '为兼容卡片提供变量初始化、更新与重放。',
    },
    statuses: {
      'not-installed': '未安装',
      disabled: '已停用',
      enabling: '正在启用…',
      enabled: '已启用',
      disabling: '正在停用…',
      error: '错误',
    },
    hostRuntime: '宿主运行时',
    browserAsset: '浏览器资产',
    assetPhases: {
      undeclared: '未声明',
      loading: '加载中…',
      loaded: '已加载',
      degraded: '降级',
      stale: '旧 revision',
    },
    expectedRevision: '期望 revision',
    actualRevision: '实际加载 revision',
    lastLoaded: '最近成功加载',
    lastLoadedNever: '从未',
    assetErrorTitle: '浏览器资产故障：',
    assetErrorFix: '宿主插件保持启用；请修复浏览器资产后重试，期间普通卡片照常运行。',
    assetRetry: '重试资产加载',
    assetErrors: {
      'client-missing': 'client.js 不存在。',
      http: '浏览器资产 HTTP 获取失败。',
      parse: '浏览器资产 JavaScript 解析失败。',
      manifest: '插件清单格式错误。',
      revision: '已加载清单与当前 revision 不匹配。',
      conflict: '插件之间存在成员名冲突。',
    } as Record<PluginAssetErrorKind, string>,
  },
} as const

const PENDING_LABEL: Record<Operation, 'installing' | 'uninstalling' | 'enabling' | 'disabling' | 'reloading'> = {
  install: 'installing',
  uninstall: 'uninstalling',
  enable: 'enabling',
  disable: 'disabling',
  reload: 'reloading',
}

export function PluginCenter(): ReactElement {
  const { lang } = useLanguage()
  const copy = COPY[lang]
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
      <p className="iris-plugins__lead">{copy.lead}</p>
      <p className="iris-plugins__empty" role="status">
        {!connected ? copy.unavailable : loadError === undefined ? copy.loading : copy.loadFailed(loadError)}
      </p>
      {connected && loadError !== undefined ? <button type="button" className="iris-plugin__action" onClick={() => {
        setLoadError(undefined)
        void actions.refreshSystemPlugins().then(result => {
          if (!result.ok && store.getState().systemPlugins === undefined) setLoadError(result.error)
        })
      }}>{copy.retry}</button> : null}
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
      if (!result.ok) setOperationError({ id: plugin.id, message: copy.operationFailed(plugin.name, result.error) })
    } finally {
      setRequest(undefined)
    }
  }

  return <div className="iris-plugins" data-plugin-center data-plugin-revision={snapshot.revision}>
    <p className="iris-plugins__lead">{copy.lead}</p>
    <div className="iris-plugins__catalog-head">
      <h3>{copy.bundled}</h3>
      <span>{installed} {copy.installed}</span>
      <span>{active} {copy.active}</span>
    </div>
    <div className="iris-plugins__list">
      {snapshot.plugins.map(plugin => <PluginRow
        key={plugin.id}
        plugin={plugin}
        snapshot={snapshot}
        lang={lang}
        busy={busy}
        busyReason={request?.id === plugin.id
          ? copy.requestSent
          : busyPlugin === undefined || busyPlugin.id === plugin.id
            ? undefined
            : copy.waitFor(busyPlugin.name)}
        requestError={operationError?.id === plugin.id ? operationError.message : undefined}
        asset={assetStatuses[plugin.id]}
        onRetryAsset={() => retryAsset(plugin.id)}
        onRun={run}
      />)}
    </div>
    <aside className="iris-plugins__retention" aria-label={lang === 'zh' ? '数据保留说明' : 'Data retention'}>
      <p>{copy.retained}</p>
      <p>{copy.permission}</p>
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
  const copy = COPY[lang]
  const dependents = snapshot.plugins.filter(candidate =>
    candidate.enabled && candidate.dependencies.includes(plugin.id),
  )
  const blocked = dependents.length > 0
  const blockedText = blocked ? copy.blocked(dependents.map(row => row.name).join(', ')) : undefined
  const status = copy.statuses[plugin.status]
  const description = plugin.id in copy.descriptions
    ? copy.descriptions[plugin.id as keyof typeof copy.descriptions]
    : plugin.description
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
      <div><dt>{copy.version}</dt><dd>{plugin.version}</dd></div>
      <div><dt>{copy.api}</dt><dd>v{plugin.apiVersion}</dd></div>
      <div className="iris-plugin__dependency"><dt>{copy.dependencies}</dt><dd>{dependencies.length === 0 ? copy.none : dependencies.join(', ')}</dd></div>
    </dl>
    {asset === undefined ? null : <AssetStatus plugin={plugin} asset={asset} lang={lang} onRetry={onRetryAsset} />}
    {plugin.error === undefined ? null : <p className="iris-plugin__error" role="alert">
      <strong>{copy.reportedError}</strong> {plugin.error}
      <span>{copy.fixError}</span>
    </p>}
    {requestError === undefined ? null : <p id={errorId} className="iris-plugin__error" role="alert">{requestError}</p>}
    {blockedText === undefined ? null : <p id={blockedId} className="iris-plugin__blocked">{blockedText}</p>}
    {busyReason === undefined ? null : <p id={busyId} className="iris-plugin__busy" role="status">{busyReason}</p>}
    <div className="iris-plugin__actions" role="group" aria-label={plugin.name} aria-describedby={describedBy}>
      {transitioning !== undefined
        ? <Action plugin={plugin} operation={transitioning} disabled label={copy[PENDING_LABEL[transitioning]]} onRun={onRun} />
        : !plugin.installed ? <Action plugin={plugin} operation="install" disabled={busy} label={copy.install} reason={busyReason} onRun={onRun} /> : <>
        {plugin.enabled
          ? <Action plugin={plugin} operation="disable" disabled={busy || blocked} label={copy.disable} reason={blockedText ?? busyReason} onRun={onRun} />
          : <Action plugin={plugin} operation="enable" disabled={busy} label={plugin.status === 'error' ? copy.retryEnable : copy.enable} reason={busyReason} onRun={onRun} />}
        {plugin.enabled ? <Action plugin={plugin} operation="reload" disabled={busy || blocked} label={copy.reload} reason={blockedText ?? busyReason} onRun={onRun} /> : null}
        <Action plugin={plugin} operation="uninstall" disabled={busy || blocked} label={copy.uninstall} reason={blockedText ?? busyReason} danger onRun={onRun} />
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
  const copy = COPY[lang]
  const degraded = asset.phase === 'degraded' || asset.phase === 'stale'
  const assetId = `iris-plugin-asset-${safeId(plugin.id)}`
  const assetErrorId = `iris-plugin-asset-error-${safeId(plugin.id)}`
  const loadedAt = asset.loadedAt === undefined ? undefined : new Date(asset.loadedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')
  return <div className={`iris-plugin__asset iris-plugin__asset--${asset.phase}`} id={assetId} data-plugin-asset-phase={asset.phase}>
    <dl className="iris-plugin__asset-facts">
      <div><dt>{copy.hostRuntime}</dt><dd>{copy.statuses[plugin.status]}</dd></div>
      <div><dt>{copy.browserAsset}</dt><dd className="iris-plugin__asset-phase">{copy.assetPhases[asset.phase]}</dd></div>
      <div><dt>{copy.expectedRevision}</dt><dd>{asset.expectedRevision === undefined ? copy.none : String(asset.expectedRevision)}</dd></div>
      <div><dt>{copy.actualRevision}</dt><dd>{asset.actualRevision ?? copy.none}</dd></div>
      <div><dt>{copy.lastLoaded}</dt><dd>{loadedAt ?? copy.lastLoadedNever}</dd></div>
    </dl>
    {degraded && asset.error !== undefined ? <div className="iris-plugin__asset-failure">
      <p className="iris-plugin__asset-error" role="alert" id={assetErrorId}>
        <strong>{copy.assetErrorTitle}</strong> {copy.assetErrors[asset.error.kind]} {asset.error.message}
        <span>{copy.assetErrorFix}</span>
      </p>
      {asset.error.kind === 'conflict' && asset.error.sources !== undefined
        ? <p className="iris-plugin__asset-conflict">{asset.error.sources.claimants.map(id => `#${id}`).join(' + ')} → {asset.error.sources.member}</p>
        : null}
      <button type="button" className="iris-plugin__action" aria-describedby={assetErrorId} onClick={onRetry}>{copy.assetRetry}</button>
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
