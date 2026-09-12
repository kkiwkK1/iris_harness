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
 * path. A non-2xx means no frame could be built at all: a `Host` this process
 * does not answer to, wrong method, wrong content type, an oversized or
 * unparsable body, a frame with no id.
 *
 * The `Host` allow-list (`host-guard.ts`) is the service's, not the endpoint's:
 * `@iris/app-service` registers four more routes on the same carrier and wraps
 * each with {@link IrisRpcHost.guard}, and this endpoint's own POST is
 * registered through the same wrapper, so every byte Iris answers goes through
 * one function — which is also where `X-Content-Type-Options: nosniff` is set,
 * for the same reason the allow-list is there rather than in five handlers. The
 * carrier's fallback seat — the static front-end bundle — stays unguarded and
 * unheadered, and is the known gap; see
 * `notes/packages/iris-rpc-host/DEVIATIONS.md` §1 and
 * `notes/packages/iris-app-service/DEVIATIONS.md` §74.
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
  type AnyRpcMethod,
  type IrisEvent,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
  type RpcResponseFrame,
} from '@iris/protocol'

import { EventHub } from './events.ts'
import { describeHubError, toRpcError } from './errors.ts'
import {
  deriveAllowance,
  describeUnconfiguredBind,
  hostHeadersOf,
  isHostAllowed,
  RefusalLog,
  type HostAllowance,
} from './host-guard.ts'
import { isJsonContentType, readBody, respondHostRefused, respondJson } from './http.ts'

export { EventHub, type EventHubOptions, type UpgradeRefusal } from './events.ts'
export { RpcFailure, describeHubError, isRpcErrorCode, toRpcError } from './errors.ts'
export {
  LOOPBACK_HOSTNAMES,
  MAX_REPORTED_HOSTS,
  RefusalLog,
  deriveAllowance,
  describeUnconfiguredBind,
  hostHeadersOf,
  isHostAllowed,
  isLoopbackBind,
  isOriginAllowed,
  type AllowanceInput,
  type HostAllowance,
} from './host-guard.ts'
export {
  HOST_REFUSAL_BODY,
  isJsonContentType,
  readBody,
  respondHostRefused,
  respondJson,
  type BodyResult,
} from './http.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    irisRpc: IrisRpcHost
  }
}

/**
 * What one method's handler does.
 *
 * `AnyRpcMethod` rather than `RpcMethod`: a system plugin registers methods
 * the static vocabulary never knew, and the transport is where their schemas
 * (registered alongside, in the protocol's runtime registry) are enforced —
 * `register` checks only the name is free, exactly as it does for built-ins.
 * Built-in callers keep the full per-method checking; a dynamic caller's
 * params and response are `unknown` by design, because the schema it handed
 * over is the type it gets back.
 */
export type RpcHandler<M extends AnyRpcMethod> = (params: RpcRequest<M>) => RpcResponse<M> | Promise<RpcResponse<M>>

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
  /**
   * Exact `host:port` values this deployment answers to.
   *
   * Empty is right for the product: a loopback bind derives `127.0.0.1:<port>`,
   * `localhost:<port>` and `[::1]:<port>` from the port it actually bound, and
   * that is every name a legitimate page on this machine can use. This exists
   * for the one case that cannot be derived — a reverse proxy in front, whose
   * public host is what the browser writes into `Host` — and a non-loopback
   * bind refuses to start until it is set.
   *
   * Exact strings, compared case-insensitively after trimming. No wildcards and
   * no suffix matching: `*.example.com` would admit
   * `127.0.0.1.attacker.example.com`, which is the attack this guard exists for.
   * @default []
   */
  allowedHosts?: string[]
}

/** The config after schemastery has filled every default in. */
interface ResolvedConfig extends Config {
  rpcPath: string
  eventsPath: string
  maxBodyBytes: number
  heartbeatMs: number
  allowedOrigins: string[]
  allowedHosts: string[]
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
    allowedHosts: z.array(z.string()).default([]),
  })

  /** The carrier this transport rides on. */
  static inject = ['webServer']

  private readonly settings: ResolvedConfig
  private readonly handlers = new Map<string, (params: unknown) => Promise<unknown>>()
  private readonly hub: EventHub
  /** One line per distinct refused header value, capped so a scan cannot flood the log. */
  private readonly refusals = new RefusalLog()

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
      // A thunk, not a value: the carrier has not listened yet, so the bound
      // port — which is half of every entry in the set — does not exist at this
      // point. Deriving it per upgrade is also what makes `port: 0` work.
      allowance: () => this.allowance(),
      onRefused: (reason, value) => {
        this.reportRefusal(reason === 'host' ? 'Host (event-socket upgrade)' : 'Origin (event-socket upgrade)', value)
      },
      // `.message`, not the object, so the log line is the text a reader needs.
      // (An earlier comment here blamed the logger for printing `null` — the
      // logger was innocent: the hub's send callback was reporting `null`, the
      // value ws passes on SUCCESS, as an error. See events.ts. This sink
      // crashing on that `null` is what finally named the real culprit.)
      //
      // Read defensively, because this incident is what a reporting path must
      // survive by definition: a sink that throws while reporting turns a
      // logged warning into a dead host, and it does it at the moment something
      // is already going wrong. The guard at the source (events.ts) is the fix;
      // this is the seatbelt, and it costs one expression.
      onError: (error: unknown) => { this.ctx.logger.warn(describeHubError(error)) },
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
   *
   * A runtime method arrives with its own bookkeeping: the caller registers
   * the request schema in the protocol's registry (`registerRequestSchema`)
   * alongside this, and is answerable for disposing both. The transport does
   * not do that here only because half of it is the protocol's table, not the
   * transport's — the composition convenience lives where both halves are
   * owned (`@iris/app-service`'s activation scope).
   * @param method - the protocol method to answer.
   * @param handler - receives params already validated against the method's schema.
   * @returns the disposer removing the handler.
   */
  register<M extends AnyRpcMethod>(method: M, handler: RpcHandler<M>): () => void {
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

  /**
   * The `Host` and `Origin` allow-sets as they stand right now.
   *
   * Derived per call rather than cached, because the bound port is the one
   * input that is not configuration: `port: 0` and an already-taken configured
   * port both make it a number nobody wrote down, and it is not known until
   * after the carrier has listened. Building six strings and two sets is
   * cheaper than any way of noticing that the port changed.
   * @returns the sets one request is checked against.
   */
  allowance(): HostAllowance {
    return deriveAllowance({
      port: this.ctx.webServer.port,
      allowedHosts: this.settings.allowedHosts,
      allowedOrigins: this.settings.allowedOrigins,
    })
  }

  /**
   * Whether one request may be answered at all, refusing it with 403 if not.
   *
   * The application registers its own routes on the same carrier — avatars,
   * the script bundle, sandbox assets, `/version` — and a rebound page reaches
   * every one of them. So the check lives on the service rather than inside the
   * RPC handler, and `@iris/app-service` wraps its handlers with
   * {@link IrisRpcHost.guard}.
   * @param req - the incoming request.
   * @param res - the response, written only when the request is refused.
   * @returns true when the caller should go on to answer.
   */
  checkHost(req: IncomingMessage, res: ServerResponse): boolean {
    const hosts = hostHeadersOf(req)
    if (isHostAllowed(hosts, this.allowance().hosts)) return true
    this.reportRefusal('Host', hosts.join(', '))
    respondHostRefused(res)
    return false
  }

  /**
   * Wrap a route handler so it answers only requests this host is addressed by,
   * and so its answer is never re-typed by the browser.
   *
   * A wrapper rather than a line inside each handler: a handler that forgets
   * the line looks exactly like one that has it, and there is no test that can
   * see the omission from inside the handler's own package. That argument was
   * made for the `Host` check and it is the same argument for the header, which
   * is why the two travel together rather than in two wrappers — **every route
   * Iris owns goes through this one function**, the RPC POST included (it is
   * registered through `guard` rather than checking the host inside itself).
   *
   * `X-Content-Type-Options: nosniff` is set before the handler runs, through
   * `setHeader` rather than at each `writeHead`, because Node merges the two
   * with `writeHead` winning — so a handler that writes its own headers keeps
   * them and still gets this one. What it buys: every one of these routes
   * answers bytes the user's own machine produced but did not necessarily
   * author — an avatar is a file from a downloaded card, a script bundle is a
   * card author's JavaScript, an RPC answer is JSON containing conversation
   * text — and without the header a browser is free to decide a response is
   * really HTML and run it as a document at Iris's own origin. Upstream sets it
   * on every response too, by way of `helmet()`'s defaults
   * (`src/server-main.js:104`); it is one of the few of those it keeps after
   * turning `contentSecurityPolicy` off.
   *
   * The two responses this does **not** reach are recorded as gaps: the
   * WebSocket upgrade (no body to sniff) and the carrier's fallback seat —
   * `index.html` and the built assets, served by an external package with no
   * header hook (`notes/packages/iris-rpc-host/DEVIATIONS.md` §1,
   * `notes/packages/iris-app-service/DEVIATIONS.md` §74).
   * @param handler - the route handler to protect.
   * @returns a handler that refuses anything the allow-list does not admit.
   */
  guard(handler: WebRoute['handler']): WebRoute['handler'] {
    return (req, res) => {
      res.setHeader('x-content-type-options', 'nosniff')
      if (!this.checkHost(req, res)) return undefined
      return handler(req, res)
    }
  }

  /**
   * Log one refusal, at most once per distinct offending value.
   *
   * `warn`, because both readings are worth an operator's attention: either a
   * legitimate deployment is missing an `allowedHosts` entry, or something is
   * asking this host to answer to a name that is not its own.
   * @param header - which header, and where it was refused.
   * @param value - the offending value, as it arrived.
   */
  private reportRefusal(header: string, value: string): void {
    if (!this.refusals.shouldReport(value)) return
    const line = `iris-rpc-host: refused a request — ${header} ${JSON.stringify(value)}`
      + ' is not in this host\'s allow-list'
    this.ctx.logger.warn(this.refusals.capped
      ? `${line}; further distinct values will not be reported`
      : line)
  }

  /** Claim the two routes; releasing them detaches every page. */
  [Service.init](): void {
    // Before either route exists. A bind reachable from the network cannot
    // derive its own allow-list, and a host that answers to any name while
    // listening on one is worse than a host that did not start.
    const refusal = describeUnconfiguredBind(this.ctx.webServer.host, this.settings.allowedHosts)
    if (refusal !== undefined) throw new Error(refusal)

    // Through `guard` like every other Iris-owned route, rather than checking
    // the host inside `handleRequest` as this used to: one wrapper is the whole
    // point of there being a wrapper, and it is what makes "every route answers
    // nosniff" a property of one function instead of a habit five call sites
    // have to keep. The ordering the old comment inside `handleRequest`
    // insisted on is unchanged — the wrapper runs before the method, the
    // content type, or anything else is looked at.
    const route: WebRoute = {
      kind: 'exact',
      path: this.settings.rpcPath,
      handler: this.guard((req, res) => this.handleRequest(req, res)),
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

  /**
   * Answer one POST. Never rejects; the carrier's own guard is a last resort.
   *
   * The `Host` allow-list ran before this was called — the route is registered
   * through {@link IrisRpcHost.guard}, which refuses a rebound page before the
   * method or the content type is looked at, since a rebound page is
   * same-origin with this host and the content-type gate below is not in its
   * path.
   */
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
    // frame and leaves every other page's stream alone. `frame.method` is an
    // arbitrary string: a built-in resolves against the static schemas, a
    // plugin method against the runtime registry, and everything else is
    // `unsupported` — the cast this used to need is gone with the widening.
    const parsed = parseRequest(frame.method, frame.params)
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
      // because one map cannot hold fifteen different signatures. A runtime
      // method's response is `unknown` all the way to the frame — the caller
      // that registered it owns what the bytes mean.
      const result = await handler(parsed.params)
      respondJson(res, 200, { id, ok: true, result } satisfies RpcResponseFrame<AnyRpcMethod>)
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
