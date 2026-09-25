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
import { listedExtensionFor, servedExtensionEnabled, servedExtensionRow, isCardMemberProxyCall, type ListedExtension } from './plane-extension.ts'
import { StExtPlane, type StExtPlaneHost } from './plane-core.ts'
import { subscribeStCompatRequests } from './plane-bus.ts'

/** The settings-section id this pilot registers under. */
const SECTION_ID = 'st-compat-settings'

/**
 * The projection retry schedule.
 *
 * A `settings-project` posted before the frame installed its message
 * listeners — or before the extension appended its panel into the fixture
 * root — is lost or answered empty, and the section would stay blank forever.
 * The section asks again on this schedule until a non-empty serialization
 * settles; the plane refuses empty answers, so a stray retry can never blank
 * a document that already rendered.
 */
const PROJECTION_RETRY_MS = 300
const PROJECTION_RETRY_ATTEMPTS = 8

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

  // Which ST extension row this plane belongs to.
  //
  // The host answers the same question with the same function — its
  // `extensionId()` calls `servedStExtensionRow` from `@iris/plugin-web-api`
  // over the same snapshot — so this is ONE contract, not a second opinion
  // about which extension the pilot serves.
  //
  // **"Is some plugin enabled" was the earlier reading, and it was wrong**: the
  // bundled plugins are installed and enabled on every profile, so that
  // condition never turned false and a DISABLED extension kept its frame and its
  // panel on screen. The mount case only looked correct because the manifest
  // then 404s and no frame is ever built — the live case had a frame already,
  // and nothing took it down.
  const served = servedExtensionRow(snapshot?.plugins)
  const servedEnabled = servedExtensionEnabled(served)

  useEffect(() => {
    let alive = true
    if (!servedEnabled) {
      // Disabled or uninstalled: detach first, then drop the frame. The host
      // fails every pending round toward the raw passthrough the moment the
      // detach lands, and the section unregisters with the frame — so a panel
      // cannot outlive the enable that put it there.
      if (spec?.extensionId !== undefined) {
        void actions.stCompatDetach(spec.extensionId).catch(() => {})
      }
      setSpec(undefined)
      return () => { alive = false }
    }
    // Enabled: read the top-level manifest (the route lists every enabled
    // extension's composed manifest), then build a fresh frame from the entry
    // for the SERVED row — not from the listing's first entry, which is the
    // served one only by coincidence of order.
    void (async () => {
      try {
        const response = await fetch('/iris-st-ext/manifest.json')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const listing = await response.json() as { extensions?: ListedExtension[] }
        const row = listedExtensionFor(listing.extensions, served?.id)
        if (!alive) return
        if (row === undefined || typeof row.id !== 'string' || typeof row.rev !== 'string'
          || typeof row.dirName !== 'string' || row.rev === '' || row.dirName === '') {
          throw new Error(`the manifest listing carries no usable entry for the served extension "${String(served?.id)}"`)
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
    // `spec` is read but not a dependency on purpose: adding it would make the
    // effect re-run on its own `setSpec`, and the early `!servedEnabled` branch
    // is what the teardown needs — every path that can disable the extension
    // changes `servedEnabled` or the revision, and both are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild on enable-state or revision change
  }, [actions, servedEnabled, served?.id, snapshot?.revision])

  const onFrameMessage = useCallback((event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | null
    // A card frame's member-proxy call comes from a source that is NOT the
    // extension frame, so it must be handed to the plane before the gate
    // below; the plane's own guards (own-frame check, extension id, reply
    // targets) refuse what they do not recognise. Gating first made the
    // card-facing member proxy unreachable — every card call was swallowed
    // here and no member ever answered.
    if (isCardMemberProxyCall(data)) {
      plane.onWindowMessage(event)
      return
    }
    if (event.source !== frameRef.current?.contentWindow) return
    if (typeof data === 'object' && data !== null && data['type'] === 'ready') {
      // The kernel is up: arm with the open chat so the frame hydrates.
      if (spec?.extensionId !== undefined && revisionRef.current !== undefined) {
        void actions.stCompatAttach(spec.extensionId, revisionRef.current, chatId).catch(() => {})
      }
      const frameLanguage = lang === 'zh' ? 'zh-cn' : 'en'
      plane.sendLocale(frameRef.current.contentWindow as Window, frameLanguage)
      // Readiness is the first moment the frame can answer at all; the
      // section's retry loop has been asking into the void until now.
      plane.refreshSettingsProjection()
      return
    }
    plane.onWindowMessage(event)
  }, [actions, chatId, lang, plane, spec])

  // Language is pushed to an already-running frame too. The original code
  // pushed it only at `ready`, so a switch after mount left the extension
  // translating with its old table — and any open settings projection showing
  // the old language. The re-ask beside the push is what makes the projection
  // re-render from the freshly translated panel rather than keep its stale
  // serialization.
  useEffect(() => {
    if (spec === undefined) return
    const frame = frameRef.current?.contentWindow
    if (frame === null || frame === undefined) return
    plane.sendLocale(frame, lang === 'zh' ? 'zh-cn' : 'en')
    plane.refreshSettingsProjection()
  }, [lang, spec, plane])

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
    ...(spec.build === '' ? {} : { buildStamp: spec.build }),
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
  const [html, setHtml] = useState<string | undefined>()

  // The projection bridge with the retry the original mount lacked. The
  // handler is a subscription, not a one-shot: the panel keeps moving (a save
  // rewrites it, a locale switch re-translates it) and an open section must
  // track those updates. Identical HTML is not re-set, so an unchanged answer
  // never rebuilds the document under the reader.
  useEffect(() => {
    let disposed = false
    let settled = false
    let attempt = 0
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const stop = plane.requestSettingsProjection(next => {
      if (disposed) return
      settled = true
      setHtml(current => (current === next ? current : next))
    })
    const retry = (): void => {
      if (disposed || settled || attempt >= PROJECTION_RETRY_ATTEMPTS) return
      attempt += 1
      timers.push(setTimeout(() => {
        if (disposed || settled) return
        plane.refreshSettingsProjection()
        retry()
      }, PROJECTION_RETRY_MS))
    }
    retry()
    return () => {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      stop()
    }
  }, [plane, frameToken])

  // A save means the extension rewrote its own panel DOM, so the projection is
  // stale. Re-ask — unless the projection holds the user's focus, where a
  // rebuild would steal the caret and the scroll position mid-interaction. The
  // projection is a live mirror of the real panel in that case (the control the
  // reader touched is the one they see), so skipping is correct, not a gap.
  useEffect(() => plane.onSettingsPersisted(() => {
    if (document.activeElement === frameRef.current) return
    plane.refreshSettingsProjection()
  }), [plane])

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
    srcDoc: html === undefined ? '' : settingsProjectionSrcdoc(html, frameToken),
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
