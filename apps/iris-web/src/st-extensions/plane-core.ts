/**
 * The shell side of the extension plane, as a framework-free client.
 *
 * The plane is a **pure relay**, and the reason is the revision fence: the
 * host broadcasts each bridge round with the full context attached (floors,
 * variable layers, the settings blob), the plane forwards it into the
 * extension frame, and whatever comes back goes out through `stCompat.submit`,
 * where the host re-checks the revision. The plane owns no generation state
 * and makes no decisions — a stale or lying plane can only echo bytes, and
 * every byte it echoes is validated host-side.
 *
 * Three side channels ride the same frame: `settings-persist` (the facade's
 * `saveSettingsDebounced` → `stCompat.settings` RPC), the settings projection
 * (serialize / replay for the standard settings slot), and the card-facing
 * member proxy (a card frame's `EjsTemplate` call, forwarded to the frame
 * where the extension's own API answers).
 */

import type {
  StBridgeContext,
  StBridgePayload,
  StBridgeResult,
  StFrameToShell,
  StMemberCallEnvelope,
  StShellToFrame,
} from '../../../../packages/iris-compat-st-extension/src/runtime/protocol.ts'

export interface HostRequest {
  type: 'st-compat.request'
  token: string
  extensionId: string
  kind: StBridgePayload['kind']
  revision: number
  payload: StBridgePayload
}

/** What the plane needs from its host app, injected for tests. */
export interface StExtPlaneHost {
  /** The frame's window, or undefined while no frame is mounted. */
  frameWindow(): Window | null
  /** The token this plane's frame was built with; frames without it are ignored. */
  frameToken(): string
  /** The extension id this plane serves (the member proxy routes by it). */
  extensionId(): string
  /** Forward a validated submit to the host (`stCompat.submit`). */
  submit(input: { token: string, kind: StBridgePayload['kind'], pluginRevision: number, result: StBridgeResult }): void
  /** Forward the facade's settings blob (`stCompat.settings`). */
  persistSettings(extensionSettings: Record<string, unknown>): void
  /** Forward an error/toast line to the app's report surface. */
  report(kind: 'error' | 'toast', detail: Record<string, unknown>): void
  /** Answer a card frame's member call. `source` is the card's window. */
  replyToFrame(source: Window, message: Record<string, unknown>): void
  /** True when `source` is a window this shell actually mounted (a card frame). */
  isOwnFrame(source: Window): boolean
}

export class StExtPlane {
  readonly #host: StExtPlaneHost
  readonly #pendingRevisions = new Map<string, number>()
  readonly #projectHandlers = new Set<(html: string, language: string) => void>()
  readonly #memberReplyTargets = new Map<string, Window>()

  constructor(host: StExtPlaneHost) {
    this.#host = host
  }

  /** The host broadcast entry (the `st-compat.request` handler in the store). */
  onHostRequest(request: unknown): void {
    if (typeof request !== 'object' || request === null) return
    const record = request as Record<string, unknown>
    if (record['type'] !== 'st-compat.request') return
    if (String(record['extensionId']) !== this.#host.extensionId()) return
    const token = String(record['token'])
    const revision = Number(record['revision'])
    this.#pendingRevisions.set(token, revision)
    const frame = this.#host.frameWindow()
    if (frame === null) {
      // Armed host, missing frame (mount still pending): the round times out
      // host-side and the raw text proceeds. Reported so the gap is visible.
      this.#pendingRevisions.delete(token)
      this.#host.report('error', {
        where: 'plane',
        message: 'a bridge round arrived before the extension frame was ready; it passes through unexpanded',
      })
      return
    }
    const envelope: StShellToFrame = {
      irisStExt: this.#host.frameToken(),
      type: 'bridge',
      token,
      revision,
      payload: record['payload'] as StBridgePayload,
    }
    frame.postMessage(envelope, '*')
  }

  /** Locale push: the app's language drives the facade's i18n table. */
  sendLocale(frame: Window, language: string): void {
    frame.postMessage({ irisStExt: this.#host.frameToken(), type: 'locale', language } satisfies StShellToFrame, '*')
  }

  /** Chat-open hydration, on the app's own signal (no host roundtrip). */
  sendChatOpen(frame: Window, context: StBridgeContext): void {
    frame.postMessage({ irisStExt: this.#host.frameToken(), type: 'chat-open', context } satisfies StShellToFrame, '*')
  }

  /** Ask the frame to serialize its settings panel (for the settings slot). */
  requestSettingsProjection(onHtml: (html: string, language: string) => void): () => void {
    const frame = this.#host.frameWindow()
    if (frame === null) return () => {}
    this.#projectHandlers.add(onHtml)
    frame.postMessage({ irisStExt: this.#host.frameToken(), type: 'settings-project' } satisfies StShellToFrame, '*')
    return () => { this.#projectHandlers.delete(onHtml) }
  }

  /** Replay a projected interaction onto the real settings DOM. */
  replayEvent(path: string, eventType: 'click' | 'change' | 'input', value?: string): void {
    const frame = this.#host.frameWindow()
    if (frame === null) return
    const envelope: StShellToFrame = value === undefined
      ? { irisStExt: this.#host.frameToken(), type: 'replay-event', path, eventType }
      : { irisStExt: this.#host.frameToken(), type: 'replay-event', path, eventType, value }
    frame.postMessage(envelope, '*')
  }

  /** The shell's window `message` entry. Only the plane's own frame and
   *  mounted card frames may speak; everything else is dropped silently. */
  onWindowMessage(event: MessageEvent): void {
    const data = event.data
    if (typeof data !== 'object' || data === null) return
    const record = data as Record<string, unknown>

    // From the extension frame.
    if (record['irisStExt'] === this.#host.frameToken()) {
      if (event.source !== this.#host.frameWindow()) return
      if (!isFrameMessageType(record['type'])) return
      this.#handleFrameMessage(record as unknown as StFrameToShell)
      return
    }

    // From a card frame: the member proxy.
    if (record['irisStMemberProxy'] !== undefined) {
      if (!this.#host.isOwnFrame(event.source as Window)) return
      const call = record as unknown as StMemberCallEnvelope
      const callId = String(call['callId'])
      if (String(record['irisStMemberProxy']) !== this.#host.extensionId()) return
      const frame = this.#host.frameWindow()
      if (frame === null) {
        this.#host.replyToFrame(event.source as Window, { irisStMemberResult: 'st-compat', callId, error: 'the extension plane is not running' })
        return
      }
      frame.postMessage({
        irisStExt: this.#host.frameToken(),
        type: 'member-call',
        callId,
        method: String(call['method']),
        args: Array.isArray(call['args']) ? call['args'] : [],
      } satisfies StShellToFrame, '*')
      this.#memberReplyTargets.set(callId, event.source as Window)
    }
  }

  /** Drop every pending accounting entry (frame rebuilt). */
  reset(): void {
    this.#pendingRevisions.clear()
    this.#memberReplyTargets.clear()
  }

  #handleFrameMessage(message: StFrameToShell): void {
    switch (message.type) {
      case 'bridge-result': {
        const revision = this.#pendingRevisions.get(message.token)
        if (revision === undefined) {
          this.#host.report('error', { where: 'plane', message: 'a bridge result arrived for a round this plane never sent' })
          return
        }
        this.#pendingRevisions.delete(message.token)
        if (message.error !== undefined) {
          this.#host.report('error', { where: 'extension bridge round', message: message.error.message })
          return // No submit: the host's deadline falls back to the raw text.
        }
        this.#host.submit({ token: message.token, kind: message.result.kind, pluginRevision: revision, result: message.result })
        return
      }
      case 'settings-persist':
        this.#host.persistSettings(message.extensionSettings)
        return
      case 'settings-html': {
        for (const handler of this.#projectHandlers) handler(message.html, message.language)
        return
      }
      case 'member-result': {
        const target = this.#memberReplyTargets.get(message.callId)
        if (target !== undefined) {
          this.#memberReplyTargets.delete(message.callId)
          this.#host.replyToFrame(target, { irisStMemberResult: 'st-compat', callId: message.callId, result: message.result, error: message.error })
        }
        return
      }
      case 'error':
        this.#host.report('error', { where: message.where, message: message.message })
        return
      case 'toast':
        this.#host.report('toast', { level: message.level, message: message.message, detail: message.detail })
        return
      case 'ready':
        return // The mount owns readiness.
    }
  }
}

function isFrameMessageType(type: unknown): boolean {
  return type === 'bridge-result' || type === 'settings-persist' || type === 'settings-html'
    || type === 'member-result' || type === 'error' || type === 'toast' || type === 'ready'
}
