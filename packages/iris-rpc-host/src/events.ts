/**
 * The push half of the transport: one WebSocket carrying `IrisEvent` frames.
 *
 * Generation is an event stream, not a response, so this socket is where a
 * reply's text actually arrives. Several pages may watch the same host, and
 * every frame names its chat, so the hub fans out rather than routing.
 *
 * WebSockets are exempt from the same-origin policy — a page on any origin can
 * open one to loopback and read whatever it pushes. Since these frames carry
 * conversation text, the upgrade is guarded twice, in this order: the request's
 * `Host` must be one this process answers to, and only then may its `Origin` be
 * checked. A missing `Origin` is allowed — browsers always send one on an
 * upgrade, so its absence means a non-browser client — but a missing `Host` is
 * not, because that is the header a DNS-rebinding page cannot forge.
 *
 * Until 2026-09-11 the order did not exist: the check was "the `Origin`'s host
 * equals the `Host` header", which a page at `http://127.0.0.1.nip.io:8787`
 * satisfies with the pair the browser writes for it. Both halves of the rule
 * now come from `host-guard.ts`, which holds the literal sets.
 *
 * @module @iris/rpc-host/events
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import type { IrisEvent } from '@iris/protocol'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  hostHeadersOf,
  isHostAllowed,
  isOriginAllowed,
  type HostAllowance,
} from './host-guard.ts'

/**
 * Bytes a client may fall behind before it is dropped.
 *
 * A page this far behind on a token stream will not catch up, and buffering for
 * it without bound is how a host runs out of memory. Dropping it is recoverable:
 * the client reconnects and re-opens the chat, which resyncs from host truth.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

/** Why one upgrade was refused. */
export type UpgradeRefusal = 'host' | 'origin'

/** What the hub needs from its owner. */
export interface EventHubOptions {
  /** Ping period in milliseconds; `0` disables liveness probing. */
  heartbeatMs: number
  /** Largest inbound frame accepted, in bytes. */
  maxPayloadBytes: number
  /**
   * The literal allow-sets, read per upgrade.
   *
   * A function rather than a value because the bound port is part of the set
   * and is not known when the hub is constructed — the carrier has not listened
   * yet, and with `port: 0` the number it settles on is the OS's choice.
   */
  allowance: () => HostAllowance
  /** Reports one refused upgrade and the header that caused it; never throws. */
  onRefused: (reason: UpgradeRefusal, value: string) => void
  /** Reports a socket-level failure; never throws. */
  onError: (error: Error) => void
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
   * @param options - liveness, size limits, and the host and origin allow-sets.
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
    const allowance = this.#options.allowance()

    // `Host` first, and unconditionally: a rebinding page sends an `Origin`
    // that agrees with its `Host`, so checking the pair against each other
    // proves nothing. Only a request that named this host correctly gets as far
    // as having its `Origin` looked at.
    const hosts = hostHeadersOf(req)
    if (!isHostAllowed(hosts, allowance.hosts)) {
      this.#options.onRefused('host', hosts.join(', '))
      this.#refuse(socket)
      return
    }
    if (!isOriginAllowed(req.headers.origin, allowance.origins)) {
      this.#options.onRefused('origin', req.headers.origin ?? '')
      this.#refuse(socket)
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
        // `!= null`, not `!== undefined`: this ws build calls back with `null`
        // on SUCCESS. The looser guard once reported every successful send as a
        // failure — one streamed generation produced 370 `null` warnings, and a
        // sink that then dared to read `.message` took the whole host down
        // mid-generation. The instrument was reporting its own health as noise.
        if (error != null) this.#options.onError(error)
      })
    }
  }

  /**
   * Answer one refused upgrade and hang up.
   *
   * Written straight onto the raw socket because nothing has been negotiated
   * yet: there is no `ServerResponse` here, and the handshake must not be
   * completed before it is refused. The socket is destroyed rather than left
   * half-open so a refused client cannot hold a file descriptor.
   * @param socket - the raw socket, owned from here on.
   */
  #refuse(socket: Duplex): void {
    socket.write(
      'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\nContent-Length: 0\r\n\r\n',
    )
    socket.destroy()
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
