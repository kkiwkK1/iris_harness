/**
 * Taking a credential back out of text that is about to travel.
 *
 * A provider's non-2xx body is echoed into the error sentence a turn fails
 * with, and that sentence goes two places at once: to every open page as
 * `stream.error`'s `message`, and onto disk in the cache trace's `error` field.
 * Most endpoints answer a bad key with a description of it — DeepSeek prints
 * `Your api key: sk-**** is invalid`, already masked at the source — but
 * nothing in the protocol stops one from echoing the request's own
 * `Authorization` header back, and some proxies do exactly that on 401. The
 * body is not ours, so the defence cannot be a promise about what providers
 * send; it has to be a pass over the text before it becomes an error.
 *
 * Three patterns, in this order, because the first subsumes the others when it
 * matches and the last two are what catch a key this process never held (a
 * relayed upstream error, a proxy quoting a different tenant's header):
 *
 * 1. **The literal credential**, when the caller has one. Compared, never
 *    logged: the value arrives as an argument and only ever leaves as
 *    {@link REDACTED}.
 * 2. **`Bearer <token>` shapes**, header name and all when one is in front.
 * 3. **`sk-…` tokens**, the prefix every OpenAI-compatible provider in the
 *    corpus issues keys under.
 *
 * @module iris-llm-openai-compat/redact
 */

/** What a secret becomes. One spelling, so a reader can grep for it. */
export const REDACTED = '<redacted>'

/**
 * The shortest literal this will redact.
 *
 * A configured key of two or three characters is not a credential, and
 * replacing every occurrence of such a string would mangle the very sentence
 * the reader needs — a provider's `invalid api key` reduced to
 * `<redacted>nvalid api key`. Below the floor the shape patterns still apply,
 * so a short key echoed inside a header is caught by them rather than by its
 * own text.
 */
const SHORTEST_LITERAL = 8

/**
 * A `Bearer <token>` credential, scheme word and all.
 *
 * The header **name** is deliberately left standing: `Authorization:
 * <redacted>` tells the reader what was taken out, and a pattern that ate the
 * word before the colon would eat the wrong one out of an ordinary sentence
 * (`Authentication failed: Bearer …`). The token class is the base64url/JWT
 * alphabet plus `.` — the punctuation a `header.payload.signature` carries —
 * which covers every key shape in the corpus and stops at whitespace, quotes
 * and JSON punctuation, so a key inside `{"error":"Bearer sk-x…"}` loses the
 * key and keeps the braces. Eight characters minimum, which no key misses and
 * which keeps the English `Bearer token` out of it.
 */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi

/**
 * An `sk-` token.
 *
 * Twelve characters after the prefix, which every issued key clears and no
 * English word does; the floor is what keeps `sk-` used as a noun ("the sk-
 * prefix") out of it. Masked keys are unaffected: DeepSeek's `sk-****` has
 * neither the length nor the alphabet.
 */
const SK_TOKEN = /\bsk-[A-Za-z0-9_-]{12,}/g

/** Escape a literal for use inside a regular expression. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove credentials from text that came from outside this process.
 *
 * Identity when nothing matches: a body with no secret in it comes back byte
 * for byte, because the sentence a provider wrote about a bad request is the
 * whole diagnosis and a scrub that paraphrased it would cost the reader the
 * answer.
 *
 * **Scrub before truncating, not after.** The caller's 500-character cap stays
 * where it is; this runs on the full text first so a key straddling the cut is
 * removed rather than halved into something that still names most of itself.
 * @param text - whatever came back, verbatim.
 * @param secrets - literal credential values this caller holds, if any. Absent,
 *   empty and `undefined` entries are ignored, so a call site with no key
 *   configured passes what it has rather than branching.
 * @returns the same text with every credential replaced by {@link REDACTED}.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  // Longest first: a credential value (`Bearer sk-…`) contains the bare key, and
  // redacting the key first would leave the scheme word standing on its own.
  const literals = [...new Set(secrets.filter(
    (secret): secret is string => secret !== undefined && secret.length >= SHORTEST_LITERAL,
  ))].sort((left, right) => right.length - left.length)
  let scrubbed = text
  for (const literal of literals) {
    scrubbed = scrubbed.replace(new RegExp(escapeLiteral(literal), 'g'), REDACTED)
  }
  return scrubbed.replace(BEARER, REDACTED).replace(SK_TOKEN, REDACTED)
}
