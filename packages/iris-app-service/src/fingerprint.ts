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
 * ## The route is not in the hash — a correction, 2026-09-08
 *
 * The canonical body used to open with `{"provider":…,"model":…` and the prefix
 * window is the first {@link PREFIX_BYTES} bytes *of that string*, so **a model
 * switch changed `prefixHash` while the prompt was untouched**. That is not a
 * theoretical hazard: the composer lets a model be chosen per conversation, and
 * the two swipes of `爱衣` message 25 that were read as "the head 4 KB changed"
 * are arithmetically inconsistent with that reading — the second reports 7 424
 * cached tokens, which is a shared wire prefix of roughly 20 KB, and a request
 * whose first 4 KB really differed could not have had one.
 *
 * So the hashes now cover the **prompt only**: the system slot and every
 * message's role and text. The route is a fact about the *destination* — a cache
 * lives on one model, so it certainly matters — and it is recorded as its own
 * fields (`UsageRoute`, and the cache trace's `provider` / `model`), where a
 * change reads as a route change rather than as a prompt change.
 *
 * **Consequence, stated because it is silent otherwise**: hashes stored before
 * this change were taken over a different string and cannot be compared with
 * ones taken after it. One boundary turn per conversation will therefore read as
 * "the prompt changed" when it may not have. Nothing repairs that — the old
 * bodies are gone — and the alternative was leaving a measurement that answers a
 * different question from the one it is read as answering.
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
 * One text slot of the canonical body, and where its bytes are.
 *
 * The offsets bound the **escaped** content between a JSON string's quotes, not
 * the text itself: the body is what a provider's cache is decided over, so the
 * only coordinate system in which "the divergence is at byte 5 239" means
 * anything is the body's own. `JSON.parse('"' + slice + '"')` recovers the text
 * from a slice, and the trace's tests assert exactly that.
 */
export interface BodySlot {
  /**
   * Which slot this is: the system prompt, or the *n*th message.
   *
   * `-1` for the system slot, so a caller can order slots by this field and get
   * wire order, which is what the system prompt occupies in every serialiser
   * this host has.
   */
  message: number
  /** First byte of the escaped content, inclusive. */
  start: number
  /** One past the last byte of the escaped content. */
  end: number
  /** The text the slot carries, unescaped. */
  text: string
}

/** The canonical body and the position of every text slot inside it. */
export interface CanonicalBody {
  body: string
  /** In wire order: the system slot first when there is one, then the messages. */
  slots: BodySlot[]
  /** `Buffer.byteLength(body)`, computed once because every reader needs it. */
  bytes: number
}

/**
 * The prompt as one canonical string, with the position of every text slot.
 *
 * **What is in it**: the system slot, and every message's role and text — the
 * text a provider's cache matches on. **What is not**: the route, sampling,
 * `maxTokens`, `stop`, the abort signal. The route's exclusion is the 2026-09-08
 * correction this module's header records; the rest were never in, because a
 * temperature that jitters between turns must not make two identical prompts look
 * different — that would hide the very drift this is for behind noise from a knob
 * the cache never reads.
 *
 * Written out chunk by chunk rather than handed to `JSON.stringify` as one
 * object, because the offsets have to be exact and a second pass that *searched*
 * the finished string for each text would be a different answer wearing this
 * one's clothes: two messages with identical text would both match the first
 * occurrence. The bytes are identical to the object form — `tests/cache-trace`
 * pins that against a literal `JSON.stringify`, which is the only reference
 * worth checking it against.
 * @param options - the request as the adapter is about to receive it.
 * @returns the canonical body, its slots, and its byte length.
 */
export function canonicalBody(options: GenerateOptions): CanonicalBody {
  const slots: BodySlot[] = []
  const chunks: string[] = []
  let bytes = 0

  /** Append a chunk that is not a text slot. */
  const structure = (chunk: string): void => {
    chunks.push(chunk)
    bytes += Buffer.byteLength(chunk, 'utf8')
  }
  /** Append one JSON string and record where its content landed. */
  const slot = (message: number, text: string): void => {
    const escaped = JSON.stringify(text).slice(1, -1)
    structure('"')
    const start = bytes
    structure(escaped)
    slots.push({ message, start, end: bytes, text })
    structure('"')
  }

  structure('{"system":')
  // `null`, not `""`, when there is no system slot: the two are different facts
  // about a request and the fingerprint has always distinguished them.
  if (options.system === undefined) structure('null')
  else slot(-1, options.system)
  structure(',"messages":[')
  options.messages.forEach((message, index) => {
    if (index > 0) structure(',')
    structure('{"role":')
    structure(JSON.stringify(message.role))
    structure(',"text":')
    slot(index, textOf(message))
    structure('}')
  })
  structure(']}')

  return { body: chunks.join(''), slots, bytes }
}

/**
 * The prompt as one canonical string.
 * @param options - the request as the adapter is about to receive it.
 * @returns the canonical body string.
 */
export function serialiseRequest(options: GenerateOptions): string {
  return canonicalBody(options).body
}

/** The first 16 hex characters of a `sha256`. */
function digest(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/**
 * Fingerprint one already-serialised body.
 *
 * Separate from {@link fingerprintRequest} so the cache trace, which has the
 * body in hand and its slots with it, hashes the same bytes rather than
 * serialising a second time — two serialisations of one request are two chances
 * to disagree about what went out.
 * @param body - the canonical body.
 * @returns the whole-body hash and the prefix hash.
 */
export function fingerprintBody(body: string): PromptFingerprint {
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
 * Fingerprint one request.
 * @param options - the request as the adapter is about to receive it.
 * @returns the whole-body hash and the prefix hash.
 */
export function fingerprintRequest(options: GenerateOptions): PromptFingerprint {
  return fingerprintBody(serialiseRequest(options))
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
