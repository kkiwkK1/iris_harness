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
  /** Advisory model catalog. Unlisted ids are still accepted. */
  models?: ModelEntry[]
}

/** Runtime schema for the adapter row. */
export const Config: z<Config> = z.object({
  provider: z.string().required(),
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    contextWindow: z.natural(),
  })).default([]),
})

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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Resolve the credential once per call, so an in-flight stream never
    // observes a configuration change mid-response.
    const apiKey = this.#config.apiKeyEnv === undefined ? undefined : process.env[this.#config.apiKeyEnv]
    if (this.#config.apiKeyEnv !== undefined && (apiKey === undefined || apiKey.length === 0)) {
      throw new LlmError(`missing API key: set ${this.#config.apiKeyEnv}`, 'INVALID_CREDENTIAL')
    }

    const url = `${this.#config.baseURL.replace(/\/+$/, '')}/chat/completions`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'text/event-stream',
          ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
          ...attributionHeaders(),
        },
        body: JSON.stringify(serializeRequest(options)),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
    } catch (cause: unknown) {
      throw new LlmError(`request to ${url} failed`, 'TRANSPORT', { cause })
    }

    if (!response.ok || response.body === null) {
      const detail = response.body === null ? '(no body)' : (await response.text()).slice(0, 500)
      throw new LlmError(`${url} responded ${response.status}: ${detail}`, 'TRANSPORT')
    }

    yield* translate(parseSse(response.body))
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
