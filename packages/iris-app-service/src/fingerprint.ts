/**
 * What went out, in sixteen hex characters.
 *
 * This exists to settle one argument after the fact. A provider reports
 * `cacheReadTokens` per call, and a turn that comes back with `0` has exactly
 * two possible causes: **we** sent something different from last turn (a macro
 * that re-rolled, an injection that moved, a world-info entry that fired), or
 * the **provider** simply did not serve its cache. Those are opposite bugs with
 * opposite fixes, and nothing in a settled chat could tell them apart — the
 * request is gone by the time anyone looks at the number.
 *
 * So each generation records two hashes of the body it actually sent. Two
 * adjacent turns whose `prefixHash` agree and whose `cacheReadTokens` is `0`
 * indict the provider; two that disagree indict us, and the itemization beside
 * them says which section moved.
 *
 * **Sixteen hex characters, not sixty-four.** These are compared against each
 * other, never against a value from elsewhere, and the whole record rides in
 * every chat file forever — a 64-hex digest per swipe is four times the bytes
 * for a comparison that is already decided in the first eight.
 *
 * @module @iris/app-service/fingerprint
 */

import { createHash } from 'node:crypto'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * How much of the body {@link PromptFingerprint.prefixHash} covers.
 *
 * **Bytes, not tokens, and the choice is deliberate.** The thing being detected
 * is "did the leading text change at all", and a byte cut answers that
 * reproducibly with no tokenizer in the loop: this host's own counter is a
 * calibrated *estimate* (`@iris/tokenizer`), the provider's real tokenizer is
 * not available to us, and a prefix defined in estimated tokens would move
 * whenever the estimate was recalibrated — the hash would change while the
 * bytes did not, which is precisely the false positive this record exists to
 * rule out.
 *
 * It is therefore a **proxy** and named as one: DeepSeek's cache is reported in
 * 64-token blocks, so a matching `prefixHash` is evidence that the first ~1k
 * tokens were identical, not a measurement of how many tokens the cache could
 * have served. The `cacheReadTokens` figure beside it is the measurement.
 */
export const PREFIX_BYTES = 4096

/** Two hashes of one request body. */
export interface PromptFingerprint {
  /** `sha256` of the whole serialised body, first 16 hex characters. */
  promptHash: string
  /** `sha256` of its first {@link PREFIX_BYTES} bytes, first 16 hex characters. */
  prefixHash: string
}

/** Visible text of one message's content blocks. */
function textOf(message: { readonly content: readonly { readonly type: string, readonly text?: string }[] }): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/**
 * The request as one canonical string.
 *
 * **What is in it**: the route (provider and model, because a cache lives on
 * one model), the system slot, and every message's role and text — everything
 * that decides what the provider's cache can match. **What is not**: sampling,
 * `maxTokens`, `stop`, the abort signal. A temperature that jitters between
 * turns must not make two identical prompts look different; that would hide the
 * very drift this is for behind noise from a knob the cache never reads.
 *
 * Keys are written in a fixed order by construction rather than sorted, so the
 * string is stable across runs without depending on `JSON.stringify` key order
 * for an object built somewhere else.
 * @param options - the request as the adapter is about to receive it.
 * @returns the canonical body string.
 */
export function serialiseRequest(options: GenerateOptions): string {
  return JSON.stringify({
    provider: options.provider,
    model: options.model,
    system: options.system ?? null,
    messages: options.messages.map(message => ({ role: message.role, text: textOf(message) })),
  })
}

/** The first 16 hex characters of a `sha256`. */
function digest(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * Fingerprint one request.
 * @param options - the request as the adapter is about to receive it.
 * @returns the whole-body hash and the prefix hash.
 */
export function fingerprintRequest(options: GenerateOptions): PromptFingerprint {
  const body = serialiseRequest(options)
  const bytes = Buffer.from(body, 'utf8')
  return {
    promptHash: digest(body),
    // `subarray`, so a body shorter than the window hashes itself rather than
    // being padded — the two hashes then agree, which is the truth about a
    // short request and not a defect.
    prefixHash: digest(bytes.subarray(0, PREFIX_BYTES)),
  }
}

/**
 * The one line a report shows per generation.
 *
 * Deliberately terse and greppable: a reader scans the report panel for two
 * adjacent turns and compares the second field by eye.
 * @param fingerprint - the hashes for this generation.
 * @param cacheReadTokens - what the provider said it served from cache, if it
 *   said anything.
 * @returns the report line.
 */
export function fingerprintLine(
  fingerprint: PromptFingerprint,
  cacheReadTokens: number | undefined,
): string {
  const cache = cacheReadTokens === undefined ? 'unreported' : String(cacheReadTokens)
  return `prompt ${fingerprint.promptHash} prefix ${fingerprint.prefixHash} cache-read ${cache}`
}

/** One hash as it may appear in a chat file: 16 lowercase hex characters. */
function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

/**
 * Read a fingerprint back out of a stored usage entry.
 *
 * Both hashes or neither, and each one checked for shape. A half-read
 * fingerprint would compare unequal against every other turn and read as "the
 * prompt changed" — a wrong answer to the only question this record is asked,
 * which is worse than the absence a chat written before this existed produces.
 * @param value - one entry of the file's usage array.
 * @returns the fingerprint, or undefined when the entry carries none.
 */
export function parseFingerprint(value: unknown): PromptFingerprint | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const promptHash = record['promptHash']
  const prefixHash = record['prefixHash']
  if (!isHash(promptHash) || !isHash(prefixHash)) return undefined
  return { promptHash, prefixHash }
}
