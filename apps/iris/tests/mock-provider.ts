/**
 * A tiny OpenAI-compatible SSE endpoint, so the spike can prove the whole
 * streaming path without a network call or an API key. It also echoes back the
 * request body it received, which is how the spike verifies that the Iris
 * sampling extension actually reaches the wire.
 */

import { createServer, type Server } from 'node:http'

import { listenOnFetchablePort } from '../../../packages/iris-app-service/tests/support/fetchable-port.ts'

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
        /*
         * `close`, not `keep-alive`. The connection ends with the response, so
         * no socket of this test double outlives the tests: a runner asked to
         * force-exit then finds nothing mid-teardown. (Keep-alive here held
         * three undici sockets open past the last test, and `process.exit()`
         * amid their close tripped libuv's closing-handle assert on Windows —
         * 0xC0000409 — which marked the file failed after every test in it had
         * passed.)
         */
        'connection': 'close',
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

  // Through the shared guard rather than `listen(0)` directly: an ephemeral
  // draw can land on a port WHATWG Fetch refuses outright, and the adapter's
  // `bad port` would then read as the streaming path being broken. See
  // `packages/iris-app-service/tests/support/fetchable-port.ts`.
  const port = await listenOnFetchablePort(server)

  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    capture,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    }),
  }
}
