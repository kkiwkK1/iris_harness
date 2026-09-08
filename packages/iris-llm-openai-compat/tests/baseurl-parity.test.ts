import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatAdapter } from '../src/index.ts'

import { listenOnFetchablePort } from '../../iris-app-service/tests/support/fetchable-port.ts'

/**
 * Three spellings of one endpoint must reach the same request target.
 *
 * The user's route configuration stores a `baseURL`, and nothing normalises it
 * before it reaches this adapter — so the four spellings a real config file has
 * held (`/v1`, `/v1/`, `/v1///`, and no `/v1` at all on an endpoint that
 * happens to already sit at the right root) all have to assemble to the *same*
 * `POST …/chat/completions`. A trailing slash must not double into
 * `//chat/completions`, and the missing `/v1` must not have a phantom one
 * invented: both are path differences a proxy would answer differently, which
 * is how an identical prompt would bill differently.
 *
 * Measured on the user's own setup (2026-09-09): the profile route `deepseek`
 * was saved as `https://api.deepseek.com` **without** `/v1` while the default
 * route carried `…/v1`, and DeepSeek answers both — so the two are not to be
 * collapsed into one spelling, only assembled deterministically from whichever
 * the user typed. Both spellings must still land on `/chat/completions`.
 */

interface Recorded {
  url: string
  body: string
}

/** A server that answers every completion cleanly and records each request. */
async function endpoint(): Promise<{ baseURL: string, seen: Recorded[], server: Server }> {
  const seen: Recorded[] = []
  const server = createServer((request, response) => {
    const body: Buffer[] = []
    request.on('data', (chunk: Buffer) => body.push(chunk))
    request.on('end', () => {
      seen.push({ url: request.url ?? '', body: Buffer.concat(body).toString('utf8') })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  const port = await listenOnFetchablePort(server)
  return { baseURL: `http://127.0.0.1:${port}`, seen, server }
}

async function drain(baseURL: string): Promise<StreamChunk[]> {
  const adapter = new OpenAiCompatAdapter({ provider: 'test', baseURL })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'test',
    model: 'm',
    messages: [],
  } as GenerateOptions)) {
    chunks.push(chunk)
  }
  return chunks
}

test('a trailing slash never multiplies, and the /v1 the user typed is the /v1 sent', async () => {
  const { baseURL, seen, server } = await endpoint()
  try {
    const spellings = [
      baseURL,                 // no path segment at all
      `${baseURL}/v1`,         // the default-route spelling
      `${baseURL}/v1/`,        // one trailing slash
      `${baseURL}/v1///`,      // several, the way hand-edited configs accumulate them
    ]
    // What each spelling must assemble to, written out literally rather than by
    // the same `replace` the adapter uses — deriving the expectation with the
    // code under test would make the two agree even when both were wrong.
    const expectedTargets = [
      '/chat/completions',     // the base sat at the right root already
      '/v1/chat/completions',  // /v1 is the user's real path, preserved not invented
      '/v1/chat/completions',  // and the trailing slash is not doubled
      '/v1/chat/completions',  // nor multiplied
    ]

    for (const spelling of spellings) {
      const chunks = await drain(spelling)
      assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
    }

    // The three /v1 spellings agree with each other, and the one genuine path
    // difference the config holds is exactly the one that reaches the wire.
    assert.equal(seen.length, spellings.length, 'one request per spelling')
    const first = seen[0]
    assert.ok(first !== undefined, 'the first request was recorded')
    for (let index = 0; index < seen.length; index += 1) {
      const recorded = seen[index]
      const spelling = spellings[index]
      assert.ok(recorded !== undefined, `no request recorded at index ${index}`)
      assert.equal(
        recorded.url,
        expectedTargets[index],
        `the spelling ${spelling} reached ${recorded.url} instead of ${expectedTargets[index]}`,
      )
    }

    // And the payload was byte-identical across every spelling — the target
    // differs, never the request. (The one byte that is allowed to differ is the
    // credential header, which this fixture does not exercise.)
    for (const request of seen) {
      assert.equal(request.body, first.body, 'a baseURL spelling changed the bytes that were sent')
    }
  } finally {
    server.close()
  }
})
