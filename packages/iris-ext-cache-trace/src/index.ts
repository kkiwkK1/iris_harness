/**
 * The cache-trace capability, as the extension system's first first-class
 * extension.
 *
 * What was a store inside `@iris/app-service` — the per-conversation record of
 * every real request's canonical body, behind the `cacheTraceKeep` row — is
 * now one package that consumes two host-provided services and nothing else:
 *
 * - `ctx.irisStorage.namespace('cache-trace')` — the profile's
 *   `extensions/cache-trace/` directory, contained and atomically written by
 *   the host's own guard and writer. The extension never sees a path.
 * - `ctx.irisGeneration.registerSink(...)` — the generation record hook. The
 *   host hands each sink the request as it went out, the provider's usage
 *   figures and the failure, once per generation, from the generation's own
 *   `finally`; a sink that throws is logged and the generation carries on.
 *
 * Uninstalling is commenting the `ext-cache-trace` row out of `cordis.yml`:
 * the record stops, `prompt.divergence` answers with no comparison (the same
 * answer a conversation with one turn gets, or the record switched off gets),
 * and nothing else in the host notices. The recorded files stay on disk until
 * the user deletes them — uninstalling removes the code, not the data.
 *
 * The retention knob rides the row's own `config.keep`, spelled from the same
 * environment chain the app row's `cacheTraceKeep` used to compose, so the
 * existing switches (`IRIS_CACHE_TRACE=0`, `IRIS_CACHE_TRACE_KEEP`) keep their
 * meaning. A declarative settings contribution (the ruling's §3 face) is what
 * replaces the row eventually; this PoC keeps the row, which is where the
 * value lived before.
 *
 * @module @iris/ext-cache-trace
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { CacheTraceStore, DEFAULT_CACHE_TRACE_KEEP } from './cache-trace.ts'

export {
  CacheTraceStore,
  divergenceOf,
  spansOf,
  traceOf,
  CACHE_TRACE_VERSION,
  DEFAULT_CACHE_TRACE_KEEP,
  TAIL_SPAN_ID,
  type CacheTraceFile,
  type CacheTraceOptions,
  type TraceSpan,
  type TraceSpanKind,
  type TraceTarget,
} from './cache-trace.ts'

/** Cordis plugin name. */
export const name = 'iris-ext-cache-trace'

/**
 * The capability face is the only sanctioned dependency: the storage namespace
 * and the generation hook the host provides. Nothing here injects the app
 * service's own context or any host internal.
 */
export const inject = ['irisGeneration', 'irisStorage']

/** Plugin config. Every field has a default. */
export interface Config {
  /**
   * How many traces one conversation keeps, `0` for none.
   * @default 8
   */
  keep?: number
}

/** Runtime schema for the extension row. */
export const Config: z<Config> = z.object({
  keep: z.natural().default(DEFAULT_CACHE_TRACE_KEEP),
})

/** The persistence id this extension claims inside the profile. */
export const EXTENSION_ID = 'cache-trace'

/**
 * Register the record sink for this extension's namespace.
 * @param ctx - context carrying the host's `irisGeneration` and `irisStorage`.
 * @param config - the retention, defaulted by the schema.
 */
export function apply(ctx: Context, config: Config): void {
  const keep = config.keep ?? DEFAULT_CACHE_TRACE_KEEP
  const store = new CacheTraceStore(ctx.irisStorage.namespace(EXTENSION_ID), {
    keep,
    onError: error => { ctx.logger.warn(`cache trace: ${error.message}`) },
  })
  ctx.effect(
    () => ctx.irisGeneration.registerSink(EXTENSION_ID, {
      apiVersion: 1,
      record: payload => store.record(payload),
      divergence: (chatId, seq) => store.divergence(chatId, seq),
    }),
    'ext-cache-trace.sink',
  )
}
