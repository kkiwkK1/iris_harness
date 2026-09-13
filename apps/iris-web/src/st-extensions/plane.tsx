/**
 * The extension plane's React mount: the one component that owns the hidden
 * iframe the upstream extension runs in, the settings-slot projection, and
 * the relay between them.
 *
 * Lifecycle rules, in the order the UCs depend on them:
 * - the frame exists only while the extension is enabled; a revision bump
 *   tears it down and the next build mounts a fresh one (old frame → dead
 *   submit path: its token dies with it, and the revision check refuses it);
 * - the frame's rev comes from the composed manifest BEFORE the srcdoc is
 *   built — the mirrored URLs are rev-keyed, so nothing is guessed;
 * - `ready` (the kernel's handshake) gates the attach RPC, so a half-built
 *   frame can never arm and answer a round; the attach carries the open chat
 *   id, so a frame built for an already-open conversation starts hydrated;
 * - dispose detaches first (the host drops its arms and fails pending rounds
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

/** The extension the pilot serves: one id, one directory, by design. */
const EXTENSION_ID = 'st-prompt-template'
const EXTENSION_DIR_NAME = 'ST-Prompt-Template'

interface PlaneFrameSpec {
  token: string
  rev: string
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
      extensionId: () => EXTENSION_ID,
      submit: input => {
        void actions.stCompatSubmit(input).catch(() => {})
      },
      persistSettings: settings => {
        if (revisionRef.current !== undefined) {
          void actions.stCompatSettings(EXTENSION_ID, revisionRef.current, settings).catch(() => {})
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
      void actions.stCompatDetach(EXTENSION_ID).catch(() => {})
      setSpec(undefined)
      return () => { alive = false }
    }
    // Enabled: fetch the composed manifest, then build a fresh frame at the
    // revision the manifest names. A new revision builds a new frame; the old
    // one dies with its token.
    void (async () => {
      try {
        const response = await fetch(`/iris-st-ext/${EXTENSION_ID}/manifest.json`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const manifest = await response.json() as { rev?: unknown, dirName?: unknown }
        if (!alive) return
        if (typeof manifest.rev !== 'string' || manifest.rev === '') throw new Error('the manifest carries no rev')
        setSpec({ token: randomToken(), rev: manifest.rev })
      } catch (cause: unknown) {
        console.warn('[iris-st-compat] the extension manifest could not be read; the plane stays down', cause)
      }
    })()
    return () => { alive = false }
  }, [actions, enabled, snapshot?.revision, snapshot])

  const onFrameMessage = useCallback((event: MessageEvent): void => {
    if (event.source !== frameRef.current?.contentWindow) return
    const data = event.data as Record<string, unknown> | null
    if (typeof data === 'object' && data !== null && data['type'] === 'ready') {
      // The kernel is up: arm with the open chat so the frame hydrates.
      void actions.stCompatAttach(EXTENSION_ID, revisionRef.current ?? 0, chatId).catch(() => {})
      const frameLanguage = lang === 'zh' ? 'zh-cn' : 'en'
      plane.sendLocale(frameRef.current.contentWindow as Window, frameLanguage)
      return
    }
    plane.onWindowMessage(event)
  }, [actions, chatId, lang, plane])

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
    artifactBase: `/iris-st-ext/${EXTENSION_ID}/${spec.rev}`,
    dirName: EXTENSION_DIR_NAME,
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

  // Project once; re-projects happen when the section remounts (drawer open).
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
