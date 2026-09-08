/**
 * An OpenAI-compatible LLM adapter, as a Cordis plugin.
 *
 * One adapter covers most of the SillyTavern backend matrix — OpenAI,
 * OpenRouter, Ollama, llama.cpp, TextGen WebUI, DeepSeek, Together and any
 * other endpoint that speaks `/chat/completions` with SSE.
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { parseSse } from './sse.ts'
import { serializeRequest } from './serialize.ts'
import { translate } from './translate.ts'

export type { IrisSampling } from './serialize.ts'

/**
 * The wire form, exported so the layer that *assembles* a request can check
 * what the request becomes.
 *
 * Not a new capability — {@link apply} has always sent
 * `JSON.stringify(serializeRequest(options))` — but the one thing a prompt
 * cache cares about is bytes, and only this function knows them. Without the
 * export, a determinism check at the assembly layer has to compare harness
 * objects and hope the serializer agrees, which is exactly the seam where a
 * difference would hide (`packages/iris-app-service/tests/assembly-determinism.test.ts`).
 */
export { serializeMessages, serializeRequest } from './serialize.ts'

/** Cordis plugin name. */
export const name = 'iris-llm-openai-compat'

/** The model registry this adapter registers into. */
export const inject = ['llm']

/** One model this route advertises. */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
}

/** Plugin config. */
export interface Config {
  /** Provider route key, e.g. `openai`, `openrouter`, `ollama`. */
  provider: string
  /** Human-readable provider name. */
  displayName?: string
  /** Endpoint root; `/chat/completions` is appended. */
  baseURL: string
  /** Environment variable holding the API key. Absent means an unauthenticated endpoint. */
  apiKeyEnv?: string
  /**
   * The API key itself, as a connection profile carries it.
   *
   * Takes precedence over {@link apiKeyEnv}: a key the user typed into a form
   * is more specific than one an operator put in the environment. Kept in the
   * adapter's config only — never logged, never served.
   */
  apiKey?: string
  /**
   * The header the credential is sent in.
   *
   * Absent (or `Authorization`, in any casing) means the OpenAI-compatible
   * convention: `Authorization: Bearer <key>`. Any other name sends the bare
   * value — Anthropic's `x-api-key` is the case that exists.
   */
  apiKeyHeader?: string
  /** Advisory model catalog. Unlisted ids are still accepted. */
  models?: ModelEntry[]
  /**
   * Milliseconds to wait for response headers. `0` disables the budget.
   *
   * @default 30000
   */
  connectTimeoutMs?: number
  /**
   * Milliseconds to wait for the stream's first payload. `0` disables it.
   *
   * The most generous of the three on purpose: a reasoning model on a long
   * context legitimately produces nothing for minutes before its first token,
   * so this is the budget that would manufacture a failure if it were tight.
   * @default 120000
   */
  firstByteTimeoutMs?: number
  /**
   * Milliseconds of provider silence mid-stream before the call is abandoned.
   * `0` disables it.
   *
   * @default 120000
   */
  idleTimeoutMs?: number
}

/**
 * Default budgets, in milliseconds.
 *
 * **Ours, not upstream's** — see {@link OpenAiCompatAdapter.stream}. They live
 * as one exported object because the schema below and {@link budgetsOf} must
 * not drift: the schema serves a plugin-config route, `budgetsOf` serves the
 * `new OpenAiCompatAdapter(...)` route the host's connection profiles take,
 * and a default written twice is a default that disagrees with itself.
 */
export const DEFAULT_TIMEOUTS = {
  connectMs: 30_000,
  firstByteMs: 120_000,
  idleMs: 120_000,
} as const

/**
 * Resolve one call's budgets.
 *
 * `0` means **disabled**, not "expire immediately" — a self-hosted endpoint on
 * slow hardware is a real configuration, and the operator turning a budget off
 * must not get the opposite of what they asked for. `??` rather than `||` for
 * the same reason: `0` is a value here, not an absence.
 * @param config - the adapter's configuration.
 * @returns the three budgets in milliseconds, zero meaning no budget.
 */
function budgetsOf(config: Config): { connectMs: number, firstByteMs: number, idleMs: number } {
  return {
    connectMs: config.connectTimeoutMs ?? DEFAULT_TIMEOUTS.connectMs,
    firstByteMs: config.firstByteTimeoutMs ?? DEFAULT_TIMEOUTS.firstByteMs,
    idleMs: config.idleTimeoutMs ?? DEFAULT_TIMEOUTS.idleMs,
  }
}

/** Runtime schema for the adapter row. */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string(),
  apiKey: z.string(),
  apiKeyHeader: z.string(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.natural(),
  })).default([]),
  // Defaults come from DEFAULT_TIMEOUTS so this route and the profile route
  // cannot disagree; `0` is accepted and means the budget is off.
  connectTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.connectMs),
  firstByteTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.firstByteMs),
  idleTimeoutMs: z.natural().default(DEFAULT_TIMEOUTS.idleMs),
})

/**
 * Resolve the credential a request carries, and the header it goes in.
 *
 * One rule for every request this adapter makes, so a probe and a stream
 * cannot disagree about what "authenticated" means. An explicit key wins over
 * the environment; a configured source with nothing in it is a named error
 * rather than a silent unauthenticated request — endpoints answer that with a
 * 401 whose cause nobody can see.
 * @param config - the adapter's configuration.
 * @returns the header name and value to send, or undefined for an unauthenticated endpoint.
 * @throws {LlmError} `INVALID_CREDENTIAL` when a configured key source is empty.
 */
export function credentialOf(config: Config): { name: string, value: string } | undefined {
  const key = config.apiKey ?? (config.apiKeyEnv === undefined ? undefined : process.env[config.apiKeyEnv])
  if (config.apiKey === undefined && config.apiKeyEnv === undefined) return undefined
  if (key === undefined || key.length === 0) {
    const source = config.apiKey ?? config.apiKeyEnv
    throw new LlmError(
      `missing API key: ${config.apiKey !== undefined ? 'the stored key is empty' : `set ${String(source)}`}`,
      'INVALID_CREDENTIAL',
    )
  }
  const name = config.apiKeyHeader ?? 'Authorization'
  // `Authorization` carries a scheme; every other header is a bare value.
  const value = name.toLowerCase() === 'authorization' ? `Bearer ${key}` : key
  return { name: name.toLowerCase(), value }
}

/** Adapter over any endpoint speaking the OpenAI chat-completions SSE protocol. */
export class OpenAiCompatAdapter extends LlmAdapter {
  readonly #config: Config

  constructor(config: Config) {
    super()
    this.#config = config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.#config.displayName ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve((this.#config.models ?? []).map(entry => ({
      provider,
      id: entry.id,
      name: entry.name ?? entry.id,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = (this.#config.models ?? []).find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {},
    })
  }

  /**
   * Stream one completion, under three separately disarmable budgets.
   *
   * **There is no upstream equivalent to copy, and that is the reason this
   * exists rather than an argument against it.** SillyTavern's browser sends a
   * signal nobody ever aborts (`openai.js:3047`, `new AbortController().signal`)
   * and its server wires the provider fetch to `request.socket.on('close')`
   * with an explicit `timeout: 0` (`chat-completions.js:2531-2535`, `:894`).
   * The single `AbortSignal.timeout` in its whole `src/` is 5 s on an
   * OpenRouter *model-list* probe (`:130`) — metadata, not a generation. That
   * is sound there because a hung request always has a person and a Stop button
   * at the other end of it. This host serves several pages and can be
   * generating for one that has since been closed, so silence has to be
   * something the host itself can end. Recorded as an upgrade in
   * `notes/packages/iris-app-service/DEVIATIONS.md`, not as a compatibility fix.
   *
   * Three phases rather than one budget, because they fail for different
   * reasons and only a phase-specific sentence tells a reader which: an
   * endpoint that never accepts the connection, one that accepts and never
   * speaks, and one that speaks and then stops.
   *
   * A single `AbortController` we own, rather than `AbortSignal.timeout()`
   * composed with `AbortSignal.any()`: a timeout signal **cannot be
   * disarmed**, so the connect budget would keep running underneath a healthy
   * long stream and kill it on schedule. Being able to stand each timer down
   * when its phase ends is the whole mechanism.
   * @param options - the request, and the caller's own cancellation.
   * @returns the stream's chunks in arrival order.
   * @throws {LlmError} `TIMEOUT` when a phase's budget expires, naming the
   *   phase and how long it waited; `TRANSPORT` for everything else.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Resolve the credential once per call, so an in-flight stream never
    // observes a configuration change mid-response.
    const credential = credentialOf(this.#config)

    const url = `${this.#config.baseURL.replace(/\/+$/, '')}/chat/completions`
    const budgets = budgetsOf(this.#config)
    const controller = new AbortController()
    // Why *we* aborted, when it was us. Without it a budget expiring and the
    // user pressing stop arrive at the `catch` as the same `AbortError`, and
    // the report would name the wrong one — the host's own §20 rule, that a
    // report signs its own name unless it can tell whose failure this was.
    let expired: LlmError | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const disarm = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }
    const arm = (ms: number, describe: () => string): void => {
      disarm()
      if (ms <= 0) return
      timer = setTimeout(() => {
        expired = new LlmError(describe(), 'TIMEOUT')
        controller.abort()
      }, ms)
    }
    const onCallerAbort = (): void => { controller.abort() }
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })

    try {
      // The connect budget covers the error body too: reading `response.text()`
      // from an endpoint that sent headers and then stalled hangs exactly as
      // the headers themselves would, and a failure path with no budget is
      // where a timeout would be missing on the day it mattered.
      arm(budgets.connectMs, () => `no response headers from ${url} after ${budgets.connectMs} ms`)

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            ...credential === undefined ? {} : { [credential.name]: credential.value },
            ...attributionHeaders(),
          },
          body: JSON.stringify(serializeRequest(options)),
          signal: controller.signal,
        })
      } catch (cause: unknown) {
        throw expired ?? new LlmError(`request to ${url} failed`, 'TRANSPORT', { cause })
      }

      if (!response.ok || response.body === null) {
        const detail = response.body === null ? '(no body)' : (await response.text()).slice(0, 500)
        throw new LlmError(`${url} responded ${response.status}: ${detail}`, 'TRANSPORT')
      }

      const body = response.body
      let bytes = 0
      arm(budgets.firstByteMs, () => `no first byte from ${url} after ${budgets.firstByteMs} ms`)

      // The idle clock measures the PROVIDER's silence, not the pipeline's:
      // it stands down while the consumer works on a payload and is re-armed
      // only once we are waiting on the source again. A consumer that hangs is
      // our own defect, and dressing it up as "the provider went quiet" would
      // send the next reader to the wrong side of the boundary.
      const timed = async function* (): AsyncGenerator<string> {
        for await (const payload of parseSse(body)) {
          disarm()
          bytes += payload.length
          yield payload
          arm(
            budgets.idleMs,
            () => `no data from ${url} for ${budgets.idleMs} ms after ${bytes} bytes`,
          )
        }
      }

      try {
        yield* translate(timed())
      } catch (cause: unknown) {
        // `expired` is the one abort this adapter owns, and it already names the
        // phase and the wait. `translate`'s own `LlmError`s name their failure
        // (a stream that ended without [DONE] is `STREAM_CLOSED`), and an
        // `AbortError` is the caller's own stop, which the host settles as an
        // abort. But a peer that closes the socket mid-reply reaches this catch
        // as undici's bare `TypeError: terminated` — one word that says nothing
        // about what broke or what was lost. The reply never completed, so the
        // usage chunk that rides the end of an OpenAI-compatible stream never
        // arrived; say both, so the report reads as a diagnosis instead of a
        // word a reader pastes into a search box.
        throw expired ?? (cause instanceof LlmError ? cause
          : cause instanceof Error && cause.name === 'AbortError' ? cause
          : new LlmError(
            `connection to ${url} was closed by the peer while the reply was streaming; no usage was reported for this turn`,
            'TRANSPORT',
            { cause },
          ))
      }
    } finally {
      disarm()
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }
}

/**
 * Register the adapter for its configured route.
 * @param ctx - context carrying the `llm` registry.
 * @param config - route, endpoint, credential reference, and advisory catalog.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    () => ctx.llm.registerAdapter([config.provider], new OpenAiCompatAdapter(config)),
    'openai-compat.registerAdapter()',
  )
}
