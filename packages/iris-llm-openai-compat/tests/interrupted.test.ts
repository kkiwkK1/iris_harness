import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { after, test } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { OpenAiCompatAdapter } from '../src/index.ts'

import { listenOnFetchablePort } from '../../iris-app-service/tests/support/fetchable-port.ts'

/**
 * A peer that closes the connection in the middle of a reply.
 *
 * The failure this file pins is the report text a user pastes when a provider's
 * connection dies mid-stream. Measured on 爱衣's own turns (2026-09-09), a saved
 * profile whose every reply was cut short reported each one as the single word
 * `terminated` — undici's bare `TypeError` for a socket reset — with nothing in
 * the trace to say what broke. This is that shape, reproduced with a real socket:
 * write some SSE, then destroy the connection before `[DONE]`, so the body
 * reader rejects rather than reaching a clean EOF.
 *
 * **The assertion is not that an error is thrown** — a mis-wired test could pass
 * with no fix at all. It is that the error is *readable*: that the report panel
 * never shows the bare word, and that a reader is told both what happened (the
 * peer closed the reply) and what it cost (the usage chunk that rides the end of
 * an OpenAI-compatible stream never arrived).
 */

const sockets = new Set<Socket>()

function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/** A server that sends two deltas and then destroys the socket, mid-body. */
async function interruptingEndpoint(): Promise<{ baseURL: string, server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    response.write(delta('the '))
    // Let the first payload flush before the reset, so the failure is a
    // mid-body rejection rather than a connect failure — the two read
    // differently in the report and the adapter must not blur them.
    setTimeout(() => {
      response.write(delta('cat '))
      response.destroy()
    }, 20)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  const port = await listenOnFetchablePort(server)
  return { baseURL: `http://127.0.0.1:${port}/v1`, server }
}

after(() => {
  for (const socket of sockets) socket.destroy()
})

async function drain(
  baseURL: string,
): Promise<{ chunks: StreamChunk[], error?: unknown }> {
  const adapter = new OpenAiCompatAdapter({ provider: 'test', baseURL })
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'test',
      model: 'm',
      messages: [],
    } as GenerateOptions)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error: unknown) {
    return { chunks, error }
  }
}

test('a connection closed mid-reply is reported as a readable sentence, never the bare word', async () => {
  const { baseURL, server } = await interruptingEndpoint()
  try {
    const { chunks, error } = await drain(baseURL)
    assert.ok(error instanceof Error, `expected a failure, got ${String(error)}`)
    assert.notEqual(error.message, 'terminated', 'the raw undici word must not reach a report verbatim')
    assert.notEqual(error.message, 'fetch failed', 'nor undici’s other terse wrapper')
    assert.ok(error instanceof Error && error.message.length > 40, `the report is one word long: ${error.message}`)
    // The two facts a reader needs: what broke, and that nothing was billed for it.
    assert.match(error.message, /closed by the peer|closed while the reply|connection to .*close/u)
    assert.match(error.message, /usage/i)
    assert.ok((error as { code?: string }).code !== undefined, 'a transport failure must carry a machine code')
    assert.equal((error as { code?: string }).code, 'TRANSPORT')
    // The reply really was cut short, so the chunks that reached the consumer are
    // the ones written before the reset — not a [DONE], not a finish.
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      ['block-start', 'text-delta'],
      'the reset must come mid-body, or this is not the failure under test',
    )
  } finally {
    server.close()
  }
})
