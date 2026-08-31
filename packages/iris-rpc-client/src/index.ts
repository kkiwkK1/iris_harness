/**
 * The browser end of the Iris transport.
 *
 * Requests go over `fetch`, pushed frames over a WebSocket that reconnects on
 * its own. The two halves are deliberately separate: a reply is an event
 * stream, so a call resolves as soon as the host accepts it and the text
 * arrives later on the socket. A client that waited for the finished reply
 * could neither stream it nor interrupt it.
 *
 * Nothing here imports the DOM lib. The socket and fetch surfaces are declared
 * as the small structural types actually used, which the browser globals
 * satisfy — and which a test satisfies with twenty lines of fake.
 *
 * @module @iris/rpc-client
 */

import { RpcCallError, type IrisClient, type IrisEvent, type RpcMethod, type RpcRequest, type RpcResponse, type RpcResponseFrame } from '@iris/protocol'

import { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.ts'

export { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.ts'

/** The response members this client reads. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  text: () => Promise<string>
}

/** The `fetch` surface this client uses. */
export type FetchLike = (
  url: string,
  init: { method: string, headers: Record<string, string>, body: string },
) => Promise<FetchResponseLike>

/** The WebSocket surface this client uses. */
export interface SocketLike {
  close: () => void
  addEventListener: {
    (type: 'open' | 'close' | 'error', listener: () => void): void
    (type: 'message', listener: (event: { data: unknown }) => void): void
  }
}

/** Opens one event socket. */
export type SocketFactory = (url: string) => SocketLike

/** How the client reaches the host. */
export interface IrisClientOptions {
  /**
   * Host origin. Defaults to the page's own origin, which is the arrangement
   * to prefer: a dev server should proxy the two paths rather than serve the
   * page from a different origin, so the browser stays same-origin and no
   * cross-origin exception has to exist on the host.
   */
  baseUrl?: string
  /** Pathname of the POST endpoint. */
  rpcPath?: string
  /** Pathname of the event socket. */
  eventsPath?: string
  /** Reconnect schedule. */
  backoff?: BackoffOptions
  /** Open the event socket immediately. Default `true`. */
  autoConnect?: boolean
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Injected for tests; defaults to the global `WebSocket`. */
  socket?: SocketFactory
  /** Injected for tests; defaults to the global `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => unknown
  /** Reports a failure the client survived — a dead socket, a throwing listener. */
  onError?: (error: Error) => void
}

// The rejection type is the contract's, not this package's: a caller that wants
// to branch on a failure should not have to know which client implementation
// produced it.
export { RpcCallError } from '@iris/protocol'

/** Default request id source; a counter fallback keeps old runtimes working. */
let counter = 0

/**
 * A fresh request id.
 * @returns an id unique within this page.
 */
function nextId(): string {
  const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID
  if (uuid !== undefined) return uuid.call((globalThis as { crypto: object }).crypto)
  counter += 1
  return `iris-${String(counter)}-${Math.random().toString(36).slice(2)}`
}

/** The global `WebSocket`, resolved lazily so importing this module never needs one. */
function defaultSocketFactory(url: string): SocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket
  if (ctor === undefined) throw new Error('iris-rpc-client: no WebSocket implementation is available')
  return new ctor(url)
}

/** The `IrisClient` implementation that talks to a real host. */
export class IrisHttpClient implements IrisClient {
  readonly #rpcUrl: string
  readonly #eventsUrl: string
  readonly #backoff: BackoffOptions
  readonly #fetch: FetchLike
  readonly #socketFactory: SocketFactory
  readonly #schedule: (callback: () => void, delayMs: number) => unknown
  readonly #onError: (error: Error) => void

  readonly #listeners = new Set<(event: IrisEvent) => void>()
  readonly #connectionListeners = new Set<(connected: boolean) => void>()

  #socket: SocketLike | undefined
  #attempt = 0
  #closed = false
  #connected = false

  /**
   * @param options - endpoints, reconnect schedule and injectable transports.
   */
  constructor(options: IrisClientOptions = {}) {
    const origin = options.baseUrl ?? (globalThis as { location?: { origin: string } }).location?.origin
    if (origin === undefined) {
      throw new Error('iris-rpc-client: baseUrl is required outside a browser')
    }
    const base = new URL(origin)
    this.#rpcUrl = new URL(options.rpcPath ?? '/iris/rpc', base).href

    const events = new URL(options.eventsPath ?? '/iris/events', base)
    events.protocol = events.protocol === 'https:' ? 'wss:' : 'ws:'
    this.#eventsUrl = events.href

    this.#backoff = options.backoff ?? DEFAULT_BACKOFF
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init))
    this.#socketFactory = options.socket ?? defaultSocketFactory
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.#onError = options.onError ?? (() => {})

    if (options.autoConnect !== false) this.connect()
  }

  /** Whether the event socket currently has a live connection. */
  get connected(): boolean {
    return this.#connected
  }

  /** The resolved POST endpoint, for diagnostics. */
  get rpcUrl(): string {
    return this.#rpcUrl
  }

  /** The resolved event socket URL, for diagnostics. */
  get eventsUrl(): string {
    return this.#eventsUrl
  }

  /**
   * Call one method.
   * @param method - the method name.
   * @param params - its params; the host validates them again on arrival.
   * @returns the method's response.
   * @throws {RpcCallError} when the host refuses, or when it cannot be reached.
   */
  async call<M extends RpcMethod>(method: M, params: RpcRequest<M>): Promise<RpcResponse<M>> {
    const id = nextId()

    let response: FetchResponseLike
    try {
      response = await this.#fetch(this.#rpcUrl, {
        method: 'POST',
        // Not decoration: this content type is what makes the request
        // non-simple, so no other origin can fire it without a preflight the
        // host never answers.
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, method, params }),
      })
    } catch (cause: unknown) {
      throw new RpcCallError({
        code: 'internal',
        message: `could not reach the Iris host: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }

    const text = await response.text()
    let frame: RpcResponseFrame<M>
    try {
      frame = JSON.parse(text) as RpcResponseFrame<M>
    } catch {
      throw new RpcCallError({
        code: 'internal',
        message: `the Iris host answered ${String(response.status)} with a body that is not a response frame`,
      })
    }

    if (frame.ok === false) throw new RpcCallError(frame.error)
    if (frame.id !== id) {
      throw new RpcCallError({ code: 'internal', message: 'the Iris host answered a different request' })
    }
    return frame.result
  }

  /**
   * Subscribe to pushed frames.
   *
   * Opens the socket if it is not open yet, so a page that only listens does
   * not have to know about connection management.
   * @param listener - receives every event, in arrival order.
   * @returns a disposer; Iris is plugin-based, so every registration is reversible.
   */
  subscribe(listener: (event: IrisEvent) => void): () => void {
    this.#listeners.add(listener)
    if (this.#socket === undefined && !this.#closed) this.connect()
    return () => { this.#listeners.delete(listener) }
  }

  /**
   * Watch the connection state.
   *
   * Outside the protocol on purpose: `IrisClient.connected` is a plain readonly
   * boolean, and a UI that has to poll it shows the wrong badge for as long as
   * its polling interval. Code holding the concrete client can react instead.
   * @param listener - called with the new state on every change.
   * @returns the disposer removing the listener.
   */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.#connectionListeners.add(listener)
    return () => { this.#connectionListeners.delete(listener) }
  }

  /**
   * Open the event socket, if it is not already open.
   *
   * Idempotent, and resumes a client that {@link close} had stopped.
   */
  connect(): void {
    this.#closed = false
    if (this.#socket !== undefined) return

    let socket: SocketLike
    try {
      socket = this.#socketFactory(this.#eventsUrl)
    } catch (cause: unknown) {
      this.#onError(cause instanceof Error ? cause : new Error(String(cause)))
      this.#retry()
      return
    }
    this.#socket = socket

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#attempt = 0
      this.#setConnected(true)
    })

    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return
      this.#deliver(event.data)
    })

    // `error` and `close` both end the connection; the browser fires error
    // first and close after, so only `close` schedules the retry.
    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return
      this.#onError(new Error('the Iris event socket failed'))
    })

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#setConnected(false)
      this.#retry()
    })
  }

  /**
   * Detach and stop reconnecting.
   *
   * Subscribers are kept, so a later {@link connect} resumes delivering to them.
   */
  close(): void {
    this.#closed = true
    const socket = this.#socket
    this.#socket = undefined
    this.#setConnected(false)
    socket?.close()
  }

  /** Parse one pushed frame and fan it out. */
  #deliver(data: unknown): void {
    let event: IrisEvent
    try {
      event = JSON.parse(typeof data === 'string' ? data : String(data)) as IrisEvent
    } catch {
      this.#onError(new Error('the Iris host pushed a frame that is not JSON'))
      return
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (cause: unknown) {
        // One bad subscriber must not stop the others from seeing the frame,
        // and must not look like the stream ended.
        this.#onError(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
  }

  /** Announce a connection-state change, once per actual change. */
  #setConnected(connected: boolean): void {
    if (this.#connected === connected) return
    this.#connected = connected
    for (const listener of [...this.#connectionListeners]) {
      try {
        listener(connected)
      } catch (cause: unknown) {
        this.#onError(cause instanceof Error ? cause : new Error(String(cause)))
      }
    }
  }

  /** Schedule the next attempt, unless the client was closed. */
  #retry(): void {
    if (this.#closed) return
    const delay = backoffDelay(this.#attempt, this.#backoff)
    this.#attempt += 1
    // Re-checked at fire time: `close` may have happened while this was pending,
    // and `connect` clears the closed flag, so the guard cannot live there.
    this.#schedule(() => { if (!this.#closed) this.connect() }, delay)
  }
}
