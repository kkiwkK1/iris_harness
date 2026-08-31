/**
 * A tiny OpenAI-compatible SSE endpoint, so the spike can prove the whole
 * streaming path without a network call or an API key. It also echoes back the
 * request body it received, which is how the spike verifies that the Iris
 * sampling extension actually reaches the wire.
 */

import { createServer, type Server } from 'node:http'

/** What the mock captured from the last request it served. */
export interface MockCapture {
  body?: Record<string, unknown>
}

/** A running mock provider. */
export interface MockProvider {
  baseURL: string
  capture: MockCapture
  close(): Promise<void>
}

/** One SSE frame carrying a JSON payload. */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * Start the mock endpoint on an ephemeral port.
 * @returns its base URL, a capture slot for assertions, and a shutdown hook.
 */
export async function startMockProvider(): Promise<MockProvider> {
  const capture: MockCapture = {}

  const server: Server = createServer((request, response) => {
    if (request.url !== '/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      capture.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      // Reasoning first, then visible text in several deltas, then usage.
      response.write(frame({ choices: [{ delta: { reasoning_content: 'weighing the reply' } }] }))
      for (const piece of ['*She looks up.* ', 'Hello, ', 'traveller.']) {
        response.write(frame({ choices: [{ delta: { content: piece } }] }))
      }
      response.write(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
      response.write(frame({
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51, prompt_tokens_details: { cached_tokens: 2 } },
      }))
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock provider: no bound port')

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    capture,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}
