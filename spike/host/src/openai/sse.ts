/**
 * Decode an OpenAI-compatible SSE byte stream into event `data` payloads.
 *
 * Framing — chunk reassembly, CRLF/BOM handling, comment and non-data field
 * skipping, multi-`data:` joining — is `eventsource-parser`'s. This module owns
 * only the protocol rule: the literal `[DONE]` is yielded so the caller
 * controls final flushing, and EOF before it is truncation — a response we must
 * not treat as complete.
 *
 * The byte source is consumed as a plain `AsyncIterable`, which keeps this free
 * of the DOM stream typings (`fetch` bodies iterate on every runtime we target).
 */

import { createParser } from 'eventsource-parser'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload OpenAI-compatible endpoints send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  // The parser is push-based; this queue hands its events back to the pull side.
  const pending: string[] = []
  const parser = createParser({ onEvent: event => void pending.push(event.data) })
  const decoder = new TextDecoder()

  for await (const bytes of stream) {
    parser.feed(decoder.decode(bytes, { stream: true }))
    while (pending.length > 0) {
      const data = pending.shift() as string
      yield data
      if (data === DONE) return
    }
  }

  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
