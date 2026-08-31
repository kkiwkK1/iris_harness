/**
 * The push half of the transport: one WebSocket carrying `IrisEvent` frames.
 *
 * Generation is an event stream, not a response, so this socket is where a
 * reply's text actually arrives. Several pages may watch the same host, and
 * every frame names its chat, so the hub fans out rather than routing.
 *
 * WebSockets are exempt from the same-origin policy — a page on any origin can
 * open one to loopback and read whatever it pushes. Since these frames carry
 * conversation text, the upgrade checks `Origin` itself. A missing `Origin` is
 * allowed: browsers always send one, so its absence means a non-browser client.
 *
 * @module @iris/rpc-host/events
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { IrisEvent } from '@iris/protocol'
import { WebSocketServer, type WebSocket } from 'ws'

/**
 * Bytes a client may fall behind before it is dropped.
 *
 * A page this far behind on a token stream will not catch up, and buffering for
 * it without bound is how a host runs out of memory. Dropping it is recoverable:
 * the client reconnects and re-opens the chat, which resyncs from host truth.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/** What the hub needs from its owner. */
export interface EventHubOptions {
  /** Ping period in milliseconds; `0` disables liveness probing. */
  heartbeatMs: number
  /** Largest inbound frame accepted, in bytes. */
  maxPayloadBytes: number
  /** Origins allowed in addition to the request's own host. */
  allowedOrigins: readonly string[]
  /** Reports a socket-level failure; never throws. */
  onError: (error: Error) => void
}

/**
 * Whether an upgrade's `Origin` may connect.
 *
 * @param origin - the `Origin` header, absent for non-browser clients.
 * @param host - the request's `Host` header.
 * @param allowed - extra origins the composition opted into, e.g. a dev server.
 * @returns true when the upgrade should proceed.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined) return true
  if (allowed.includes(origin)) return true
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    // An unparsable Origin is either a bug or an attempt; either way, refuse.
    return false
  }
}

/** Fans `IrisEvent` frames out to every connected page. */
export class EventHub {
  readonly #server: WebSocketServer
  readonly #sockets = new Set<WebSocket>()
  /** Sockets that answered the last ping. Reset every heartbeat tick. */
  readonly #responsive = new Set<WebSocket>()
  readonly #options: EventHubOptions
  #heartbeat: ReturnType<typeof setInterval> | undefined

  /**
   * @param options - liveness, size limits and origin policy.
   */
  constructor(options: EventHubOptions) {
    this.#options = options
    this.#server = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes })
    if (options.heartbeatMs > 0) {
      this.#heartbeat = setInterval(() => { this.#probe() }, options.heartbeatMs)
      // The host process must be able to exit while pages are connected; a
      // liveness timer is not a reason to stay alive.
      this.#heartbeat.unref()
    }
  }

  /** How many pages are currently attached. */
  get size(): number {
    return this.#sockets.size
  }

  /**
   * Take over one HTTP upgrade.
   * @param req - the upgrade request.
   * @param socket - the raw socket, owned from here on.
   * @param head - bytes already read past the request head.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isOriginAllowed(req.headers.origin, req.headers.host, this.#options.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    this.#server.handleUpgrade(req, socket, head, (ws) => {
      this.#sockets.add(ws)
      this.#responsive.add(ws)
      ws.on('pong', () => { this.#responsive.add(ws) })
      ws.on('error', (error: Error) => { this.#options.onError(error) })
      ws.on('close', () => {
        this.#sockets.delete(ws)
        this.#responsive.delete(ws)
      })
    })
  }

  /**
   * Push one frame to every attached page.
   *
   * Serialized once and reused: a turn emits a delta per token, and re-encoding
   * per socket is the difference between fanning out and stalling.
   * @param event - the frame to push.
   */
  broadcast(event: IrisEvent): void {
    const text = JSON.stringify(event)
    for (const ws of this.#sockets) {
      if (ws.readyState !== ws.OPEN) continue
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate()
        continue
      }
      ws.send(text, (error) => {
        if (error !== undefined) this.#options.onError(error)
      })
    }
  }

  /** Drop sockets that missed the last ping and probe the rest. */
  #probe(): void {
    for (const ws of this.#sockets) {
      if (!this.#responsive.has(ws)) {
        ws.terminate()
        continue
      }
      this.#responsive.delete(ws)
      ws.ping()
    }
  }

  /**
   * Detach every page and release the server.
   * @returns once all sockets are closed.
   */
  async close(): Promise<void> {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    const closed = [...this.#sockets].map(ws => new Promise<void>((resolve) => {
      ws.once('close', () => { resolve() })
      ws.terminate()
    }))
    this.#sockets.clear()
    this.#responsive.clear()
    await Promise.all(closed)
    await new Promise<void>((resolve) => { this.#server.close(() => { resolve() }) })
  }
}
