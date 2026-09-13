/**
 * The extension plane's React mount: the one component that owns the hidden
 * iframe the upstream extension runs in, the settings-slot projection, and
 * the relay between them.
 *
 * Lifecycle rules, in the order the UCs depend on them:
 * - the frame exists only while an ST extension is enabled; a revision bump
 *   tears it down and the next build mounts a fresh one (an old frame dies
 *   with its token, and the host's revision check refuses its submits);
 * - the frame's id/rev/dir come from the route's top-level manifest BEFORE the
 *   srcdoc is built — the mirrored URLs are rev-keyed, so nothing is guessed;
 * - `ready` (the kernel's handshake) gates the attach RPC, so a half-built
 *   frame can never arm and answer a round; the attach carries the open chat
 *   id, so a frame built for an already-open conversation starts hydrated;
 * - disable detaches first (the host drops its arms and fails pending rounds
 *   toward the raw passthrough) and only then removes the frame.
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { useLanguage } from '../app/i18n/use-language.ts'
import { useSlots } from '../slots/Slot.tsx'
import { buildExtensionSrcdoc } from './srcdoc.ts'
import { StExtPlane, type StExtPlaneHost } from './plane-core.ts'
import { subscribeStCompatRequests } from './plane-bus.ts'

/** The settings-section id this pilot registers under. */
const SECTION_ID = 'st-compat-settings'

interface PlaneFrameSpec {
  extensionId: string
  token: string
  rev: string
  dirName: string
  build: string
}

function randomToken(): string {
  return `st-frame-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

export function StExtensionPlane(): ReactElement | null {
  const actions = useIrisActions()
  const snapshot = useIris(state => state.systemPlugins)
  const chatId = useIris(state => state.chatId)
  const { lang } = useLanguage()
  const slots = useSlots()

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const revisionRef = useRef<number | undefined>(undefined)
  const [spec, setSpec] = useState<PlaneFrameSpec | undefined>()

  revisionRef.current = snapshot?.revision

  const plane = useMemo(() => {
    const host: StExtPlaneHost = {
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      frameToken: () => spec?.token ?? '',
      extensionId: () => spec?.extensionId ?? '',
      submit: input => {
        void actions.stCompatSubmit(input).catch(() => {})
      },
      persistSettings: settings => {
        if (revisionRef.current !== undefined && spec?.extensionId !== undefined) {
          void actions.stCompatSettings(spec.extensionId, revisionRef.current, settings).catch(() => {})
        }
      },
      report: (kind, detail) => {
        const line = `[iris-st-compat] ${String(detail['where'] ?? detail['level'] ?? '')}: ${String(detail['message'] ?? '')}`
        if (kind === 'error') console.error(line)
        else console.info(line)
      },
      replyToFrame: (source, message) => {
        source.postMessage(message, '*')
      },
      isOwnFrame: source => Array.from(window.frames ?? {}).some(frame => frame === source),
    }
    return new StExtPlane(host)
  }, [actions, spec])

  // The enabled row decides whether a frame exists at all.
  const enabled = snapshot?.plugins.some(plugin => plugin.installed && plugin.status === 'enabled') === true

  useEffect(() => {
    let alive = true
    if (!enabled || snapshot === undefined) {
      // Disabled: detach first, then drop the frame. The host fails every
      // pending round toward the raw passthrough the moment the detach lands.
      if (spec?.extensionId !== undefined) {
        void actions.stCompatDetach(spec.extensionId).catch(() => {})
      }
      setSpec(undefined)
      return () => { alive = false }
    }
    // Enabled: read the top-level manifest (the route lists every enabled
    // extension's composed manifest), then build a fresh frame from the row.
    void (async () => {
      try {
        const response = await fetch('/iris-st-ext/manifest.json')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const listing = await response.json() as { extensions?: Array<{ id?: unknown, rev?: unknown, dirName?: unknown, build?: unknown }> }
        const row = listing.extensions?.[0]
        if (!alive) return
        if (row === undefined || typeof row.id !== 'string' || typeof row.rev !== 'string'
          || typeof row.dirName !== 'string' || row.rev === '' || row.dirName === '') {
          throw new Error('the manifest listing carries no usable extension row')
        }
        setSpec({
          extensionId: row.id,
          token: randomToken(),
          rev: row.rev,
          dirName: row.dirName,
          build: typeof row.build === 'string' ? row.build : '',
        })
      } catch (cause: unknown) {
        console.warn('[iris-st-compat] the extension manifest could not be read; the plane stays down', cause)
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only on enable-state or revision change
  }, [actions, enabled, snapshot?.revision])

  const onFrameMessage = useCallback((event: MessageEvent): void => {
    if (event.source !== frameRef.current?.contentWindow) return
    const data = event.data as Record<string, unknown> | null
    if (typeof data === 'object' && data !== null && data['type'] === 'ready') {
      // The kernel is up: arm with the open chat so the frame hydrates.
      if (spec?.extensionId !== undefined && revisionRef.current !== undefined) {
        void actions.stCompatAttach(spec.extensionId, revisionRef.current, chatId).catch(() => {})
      }
      const frameLanguage = lang === 'zh' ? 'zh-cn' : 'en'
      plane.sendLocale(frameRef.current.contentWindow as Window, frameLanguage)
      return
    }
    plane.onWindowMessage(event)
  }, [actions, chatId, lang, plane, spec])

  useEffect(() => {
    if (spec === undefined) return undefined
    window.addEventListener('message', onFrameMessage)
    const stopRequests = subscribeStCompatRequests(request => { plane.onHostRequest(request) })
    return () => {
      window.removeEventListener('message', onFrameMessage)
      stopRequests()
      plane.reset()
    }
  }, [spec, onFrameMessage, plane])

  // The settings-section registration lives exactly as long as the frame does.
  useEffect(() => {
    if (slots === undefined || spec === undefined) return undefined
    const dispose = slots.register(
      { name: 'iris.settings.sections', registrant: 'iris-st-compat', id: SECTION_ID, label: 'Extension settings' },
      () => createElement(StExtensionSettingsSection, { plane, frameToken: spec.token }),
    )
    return dispose
  }, [slots, plane, spec])

  if (spec === undefined) return null

  const srcdoc = buildExtensionSrcdoc({
    token: spec.token,
    origin: window.location.origin,
    artifactBase: `/iris-st-ext/${spec.extensionId}/${spec.rev}`,
    buildStamp: spec.build === '' ? undefined : spec.build,
    dirName: spec.dirName,
  })

  return createElement('div', { className: 'iris-st-ext-plane', style: { display: 'none' } },
    createElement('iframe', {
      ref: frameRef,
      title: 'Iris ST-compat extension plane',
      sandbox: 'allow-scripts allow-downloads',
      srcDoc: srcdoc,
    }),
  )
}

function StExtensionSettingsSection({ plane, frameToken }: { plane: StExtPlane, frameToken: string }): ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  // Project once per mount; the drawer remounting the section re-projects.
  useEffect(() => {
    plane.requestSettingsProjection((html) => {
      if (frameRef.current !== null) frameRef.current.srcdoc = settingsProjectionSrcdoc(html, frameToken)
    })
    return () => {}
  }, [plane, frameToken])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as Record<string, unknown> | null
      if (typeof data !== 'object' || data === null) return
      if (data['irisStProject'] !== frameToken) return
      if (event.source !== frameRef.current?.contentWindow) return
      const path = String(data['path'] ?? '')
      const type = data['type']
      if (type === 'click') plane.replayEvent(path, 'click')
      else if (type === 'change' || type === 'input') plane.replayEvent(path, type, String(data['value'] ?? ''))
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [plane, frameToken])

  return createElement('section', {
    className: 'iris-st-ext-settings',
    'data-iris-st-ext-section': SECTION_ID,
  }, createElement('iframe', {
    ref: frameRef,
    title: 'Extension settings',
    sandbox: 'allow-scripts',
    srcDoc: '',
  }))
}

/** The projection iframe's document: the serialized panel plus the relay. */
function settingsProjectionSrcdoc(html: string, token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 13px/1.5 system-ui, sans-serif; color: #222; margin: 8px; }
    .inline-drawer { border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
    label { display: flex; gap: 6px; align-items: center; padding: 3px 0; }
    hr { border: none; border-top: 1px solid #eee; }
  </style></head><body>${html}<script>
  (function () {
    'use strict'
    var TOKEN = ${JSON.stringify(token)}
    function pathOf(element) {
      var node = element
      while (node !== null && node !== document.body) {
        if (node instanceof Element && node.hasAttribute('data-iris-proj-path')) {
          return node.getAttribute('data-iris-proj-path')
        }
        node = node.parentNode
      }
      return null
    }
    function send(type, element) {
      var path = pathOf(element)
      if (path === null) return
      window.parent.postMessage({
        irisStProject: TOKEN,
        path: path,
        type: type,
        value: element instanceof HTMLInputElement ? element.value : undefined,
      }, '*')
    }
    document.addEventListener('click', function (event) { send('click', event.target) }, true)
    document.addEventListener('change', function (event) { send('change', event.target) }, true)
    document.addEventListener('input', function (event) { send('input', event.target) }, true)
  })()
  </` + `script></body></html>`
}
