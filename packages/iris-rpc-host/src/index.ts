/**
 * The Iris host transport, as a Cordis plugin.
 *
 * One POST endpoint for requests and one WebSocket for pushed events, over
 * `ctx.webServer`. It knows nothing about chats, characters or models: handlers
 * arrive through {@link IrisRpcHost.register}, which is what keeps domain logic
 * out of the wire and lets the application half be swapped, unloaded or hot
 * reloaded as its own composition row.
 *
 * HTTP status describes the transport; the frame describes the call. Anything
 * that could be correlated to a request id answers `200` with a
 * `RpcResponseFrame` — including refusals — so a client has exactly one code
 * path. A non-2xx means no frame could be built at all: wrong method, wrong
 * content type, an oversized or unparsable body, a frame with no id.
 *
 * @module @iris/rpc-host
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { Context, Service } from '@deepseek-ai/cordis'
// Imported for its `Context.webServer` declaration as much as for the route
// shapes: the carrier's augmentation only reaches this program through it.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import {
  parseRequest,
  type IrisEvent,
  type RpcError,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type RpcResponseFrame,
} from '@iris/protocol'

import { EventHub } from './events.ts'
import { toRpcError } from './errors.ts'
import { isJsonContentType, readBody, respondJson } from './http.ts'

export { EventHub, isOriginAllowed, type EventHubOptions } from './events.ts'
export { RpcFailure, isRpcErrorCode, toRpcError } from './errors.ts'
export { isJsonContentType, readBody, respondJson, type BodyResult } from './http.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    irisRpc: IrisRpcHost
  }
}

/** What one method's handler does. */
export type RpcHandler<M extends RpcMethod> = (params: RpcRequest<M>) => RpcResponse<M> | Promise<RpcResponse<M>>

/** Transport config. Every field has a default, so an empty row is valid. */
export interface Config {
  /** Absolute pathname of the POST endpoint, no trailing slash. @default '/iris/rpc' */
  rpcPath?: string
  /** Absolute pathname of the WebSocket endpoint, no trailing slash. @default '/iris/events' */
  eventsPath?: string
  /**
   * Largest request body accepted, in bytes.
   *
   * Sized for character cards, which is the only thing that arrives large. The
   * 19 real cards on the development machine run 46 KB to 8 MB with a 2.2 MB
   * median, and base64 adds a third on top — a 1 MB ceiling refused 17 of the
   * 19. This is still a bound rather than a licence: upstream's own limit is
   * 500 MB, which is not a limit.
   * @default 33554432
   */
  maxBodyBytes?: number
  /** WebSocket ping period in milliseconds; `0` disables liveness probing. @default 30000 */
  heartbeatMs?: number
  /**
   * Origins allowed to open the event socket besides the server's own.
   *
   * Needed only for a separate dev server. Prefer proxying the two paths from
   * the dev server instead, which keeps the browser same-origin and leaves this
   * empty.
   * @default []
   */
  allowedOrigins?: string[]
}

/** The config after schemastery has filled every default in. */
interface ResolvedConfig extends Config {
  rpcPath: string
  eventsPath: string
  maxBodyBytes: number
  heartbeatMs: number
  allowedOrigins: string[]
}

/** Frame shape as it arrives, before anything about it is trusted. */
interface RawFrame {
  id?: unknown
  method?: unknown
  params?: unknown
}

/**
 * Build a refusal frame.
 * @param id - the request id, or the empty string when none could be read.
 * @param error - the wire error.
 * @returns the frame to write.
 */
function refuse(id: string, error: RpcError): RpcResponseFrame {
  return { id, ok: false, error }
}

/**
 * HTTP + WebSocket carrier for the Iris protocol.
 *
 * Fields use TypeScript `private` rather than `#name`: Cordis derives a
 * per-context view of a service with `Object.create` over this instance, and a
 * true private field is not reachable through that delegation. `WebServer`
 * itself is written the same way.
 */
export class IrisRpcHost extends Service {
  static Config: z<Config> = z.object({
    rpcPath: z.string().default('/iris/rpc'),
    eventsPath: z.string().default('/iris/events'),
    maxBodyBytes: z.natural().default(33_554_432),
    heartbeatMs: z.natural().default(30_000),
    allowedOrigins: z.array(z.string()).default([]),
  })

  /** The carrier this transport rides on. */
  static inject = ['webServer']

  private readonly settings: ResolvedConfig
  private readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>()
  private readonly hub: EventHub

  /**
   * @param ctx - context carrying `webServer`.
   * @param config - endpoint paths and limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'irisRpc')
    // Every field carries a schema default, so the validated row is complete;
    // the same narrowing `WebServer` does with its own optional config.
    const resolved = config as ResolvedConfig
    this.settings = resolved
    // Built here rather than in the init hook so `broadcast` is safe the moment
    // the service is reachable: `super()` publishes it, and a dependent's inject
    // callback can run before the hook does.
    this.hub = new EventHub({
      heartbeatMs: resolved.heartbeatMs,
      maxPayloadBytes: resolved.maxBodyBytes,
      allowedOrigins: resolved.allowedOrigins,
      // `.message`, not the object, so the log line is the text a reader needs.
      // (An earlier comment here blamed the logger for printing `null` — the
      // logger was innocent: the hub's send callback was reporting `null`, the
      // value ws passes on SUCCESS, as an error. See events.ts. This sink
      // crashing on that `null` is what finally named the real culprit.)
      onError: (error) => { this.ctx.logger.warn(error.message) },
    })
  }

  /** Pathname the POST endpoint is served at. */
  get rpcPath(): string {
    return this.settings.rpcPath
  }

  /** Pathname the event socket is served at. */
  get eventsPath(): string {
    return this.settings.eventsPath
  }

  /** How many pages are currently attached to the event stream. */
  get connections(): number {
    return this.hub.size
  }

  /**
   * Serve one method.
   *
   * A duplicate registration throws rather than shadowing: which plugin answers
   * a method is a composition-level fact, so a collision is a misconfiguration
   * and not something to resolve by ordering.
   * @param method - the protocol method to answer.
   * @param handler - receives params already validated against the method's schema.
   * @returns the disposer removing the handler.
   */
  register<M extends RpcMethod>(method: M, handler: RpcHandler<M>): () => void {
    if (this.handlers.has(method)) {
      throw new Error(`iris-rpc-host: a handler for "${method}" is already registered`)
    }
    const entry = async (params: unknown): Promise<unknown> => handler(params as RpcRequest<M>)
    this.handlers.set(method, entry)
    return () => {
      // Identity-checked so a late disposer cannot evict a replacement that a
      // reload installed after this one was torn down.
      if (this.handlers.get(method) === entry) this.handlers.delete(method)
    }
  }

  /**
   * Push one frame to every attached page.
   * @param event - the frame.
   */
  broadcast(event: IrisEvent): void {
    this.hub.broadcast(event)
  }

  /** Claim the two routes; releasing them detaches every page. */
  [Service.init](): void {
    const route: WebRoute = {
      kind: 'exact',
      path: this.settings.rpcPath,
      handler: (req, res) => this.handleRequest(req, res),
    }
    this.ctx.effect(
      () => this.ctx.webServer.register(route),
      `irisRpc: POST ${this.settings.rpcPath}`,
    )

    const upgrade: WebUpgradeRoute = {
      path: this.settings.eventsPath,
      handler: (req, socket, head) => { this.hub.handleUpgrade(req, socket, head) },
    }
    this.ctx.effect(
      () => {
        const unregister = this.ctx.webServer.registerUpgrade(upgrade)
        return async () => {
          unregister()
          await this.hub.close()
        }
      },
      `irisRpc: WebSocket ${this.settings.eventsPath}`,
    )
  }

  /** Answer one POST. Never rejects; the carrier's own guard is a last resort. */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }

    // The cross-site guard. See the note in `http.ts`.
    if (!isJsonContentType(req.headers['content-type'])) {
      respondJson(res, 415, refuse('', {
        code: 'invalid-request',
        message: 'requests must carry content-type: application/json',
      }))
      return
    }

    const body = await readBody(req, this.settings.maxBodyBytes)
    if (!body.ok) {
      respondJson(res, 413, refuse('', {
        code: 'invalid-request',
        message: `request body exceeds ${this.settings.maxBodyBytes} bytes`,
      }))
      // The rest of the body is deliberately left unread. Node sees an
      // unconsumed request, closes the connection once the response is flushed,
      // and the sender stops — which is the point of the cap.
      return
    }

    let raw: unknown
    try {
      raw = JSON.parse(body.text)
    } catch {
      respondJson(res, 400, refuse('', { code: 'invalid-request', message: 'request body is not JSON' }))
      return
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      respondJson(res, 400, refuse('', { code: 'invalid-request', message: 'request frame must be an object' }))
      return
    }

    const frame = raw as RawFrame
    if (typeof frame.id !== 'string' || frame.id.length === 0) {
      respondJson(res, 400, refuse('', {
        code: 'invalid-request',
        message: 'request frame needs a non-empty string id',
      }))
      return
    }
    const id = frame.id

    if (typeof frame.method !== 'string') {
      respondJson(res, 200, refuse(id, { code: 'invalid-request', message: 'request frame needs a method name' }))
      return
    }

    // The single place a browser payload is trusted. A refusal answers with a
    // frame and leaves every other page's stream alone.
    const parsed = parseRequest(frame.method as RpcMethod, frame.params)
    if (!parsed.ok) {
      respondJson(res, 200, refuse(id, parsed.error))
      return
    }

    const handler = this.handlers.get(frame.method)
    if (handler === undefined) {
      respondJson(res, 200, refuse(id, {
        code: 'unsupported',
        message: `no handler is registered for "${frame.method}"`,
      }))
      return
    }

    try {
      // The handler was registered for this method, so its result is that
      // method's response; the registry stores handlers erased to `unknown`
      // because one map cannot hold fifteen different signatures.
      const result = await handler(parsed.params) as RpcResponse<RpcMethod>
      respondJson(res, 200, { id, ok: true, result } satisfies RpcResponseFrame)
    } catch (error: unknown) {
      const wire = toRpcError(error)
      // Deliberate refusals are the application talking; only an unclassified
      // failure is worth the host operator's attention.
      if (wire.code === 'internal') {
        this.ctx.logger.warn(error instanceof Error ? error.message : String(error))
      }
      respondJson(res, 200, refuse(id, wire))
    }
  }
}

export default IrisRpcHost
