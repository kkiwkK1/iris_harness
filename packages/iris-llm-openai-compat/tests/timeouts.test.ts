import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { after, test } from 'node:test'

import { DEFAULT_TIMEOUTS, OpenAiCompatAdapter } from '../src/index.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * The three budgets, against a real endpoint that really stalls.
 *
 * A stub `fetch` would decide by itself what "aborted" means, and abort
 * propagation into a response body is exactly the mechanism under test — so
 * these run against `node:http`, over real `fetch`, with the server told which
 * phase to stall at. The stalls are what a hung provider does: accept the
 * connection and say nothing; send headers and no body; send some body and
 * then stop.
 *
 * **The control is the load-bearing test in this file.** Three tests that all
 * assert "it gave up" pass equally well against an implementation that gives
 * up on everything, so `a stream that keeps talking is left alone` is what
 * makes the other three mean anything.
 */

/** Small enough to keep the suite fast, wide enough not to race the loopback. */
const BUDGET = 200
/** Comfortably inside {@link BUDGET}, so the control never trips a clock. */
const GAP = 60
/**
 * The deadline on the tests that assert a budget fires.
 *
 * Without one, a regression here does not go red — it **hangs**, which is the
 * very failure this feature exists to end, reproduced inside its own suite. A
 * hang and a slow pass are the same output; a blown deadline names the test.
 * Ten budgets wide, so it can only be reached by a clock that never fired.
 */
const DEADLINE = BUDGET * 10
/**
 * Writes in the healthy control, chosen so the exchange lasts longer than one
 * BUDGET. Verified by mutation: at 3 writes the control passed even with the
 * clocks made un-disarmable, because the leaked clock and the last write
 * landed together.
 */
const HEALTHY_WRITES = 5

/** SSE frame for one content delta. */
function delta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
}

/** SSE frames that close a well-formed stream. */
const CLOSING = `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

const sockets = new Set<Socket>()

/**
 * A server whose `/v1/chat/completions` stalls in the requested phase.
 * @param phase - where to stop: before headers, after headers, after one
 *   payload, or nowhere (the healthy control).
 * @returns the base URL to point an adapter at.
 */
async function stallingEndpoint(phase: 'headers' | 'body' | 'mid' | 'none'): Promise<{ baseURL: string, server: Server }> {
  const server = createServer((_request, response) => {
    // Never answered at all: the socket is open and nothing comes back, which
    // is the shape a wedged endpoint has.
    if (phase === 'headers') return
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.flushHeaders()
    if (phase === 'body') return
    response.write(delta('the '))
    if (phase === 'mid') return
    let sent = 1
    const tick = setInterval(() => {
      sent += 1
      // Enough writes that the whole exchange outlasts a single budget
      // (6 × GAP against BUDGET). That margin is the point, not decoration:
      // with a shorter stream a leaked call-wide clock fires at the finish
      // line and the control passes by a race — measured, it did.
      if (sent <= HEALTHY_WRITES) {
        response.write(delta('cat '))
        return
      }
      clearInterval(tick)
      response.write(CLOSING)
      response.end()
    }, GAP)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return { baseURL: `http://127.0.0.1:${port}/v1`, server }
}

after(() => {
  for (const socket of sockets) socket.destroy()
})

/** Drain an adapter stream, returning the chunks or the failure. */
async function drain(
  baseURL: string,
  overrides: { connectTimeoutMs?: number, firstByteTimeoutMs?: number, idleTimeoutMs?: number } = {},
  options: Partial<GenerateOptions> = {},
): Promise<{ chunks: StreamChunk[], error?: unknown }> {
  const adapter = new OpenAiCompatAdapter({
    provider: 'test',
    baseURL,
    connectTimeoutMs: BUDGET,
    firstByteTimeoutMs: BUDGET,
    idleTimeoutMs: BUDGET,
    ...overrides,
  })
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of adapter.stream({
      provider: 'test',
      model: 'm',
      messages: [],
      ...options,
    } as GenerateOptions)) {
      chunks.push(chunk)
    }
    return { chunks }
  } catch (error: unknown) {
    return { chunks, error }
  }
}

/** The code and message of a thrown harness error. */
function failure(error: unknown): { code: unknown, message: string } {
  assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`)
  return { code: (error as { code?: unknown }).code, message: error.message }
}

test('an endpoint that never answers is given up on by name', { timeout: DEADLINE }, async () => {
  const { baseURL, server } = await stallingEndpoint('headers')
  try {
    const { error } = await drain(baseURL)
    const { code, message } = failure(error)
    assert.equal(code, 'TIMEOUT')
    // The phase and the number, not a bare "timed out": the reader's next move
    // differs for "never connected" and "connected and went quiet", and the
    // shell renders this message verbatim.
    assert.match(message, /no response headers from .*after 200 ms/u)
  } finally {
    server.close()
  }
})

test('headers with no body are given up on, named as the first byte', { timeout: DEADLINE }, async () => {
  const { baseURL, server } = await stallingEndpoint('body')
  try {
    const { error } = await drain(baseURL)
    const { code, message } = failure(error)
    assert.equal(code, 'TIMEOUT')
    assert.match(message, /no first byte from .*after 200 ms/u)
  } finally {
    server.close()
  }
})

test('a stream that stops mid-reply is given up on, and says how far it got', { timeout: DEADLINE }, async () => {
  const { baseURL, server } = await stallingEndpoint('mid')
  try {
    const { chunks, error } = await drain(baseURL)
    const { code, message } = failure(error)
    assert.equal(code, 'TIMEOUT')
    assert.match(message, /no data from .*for 200 ms after \d+ bytes/u)
    // The partial arrived before the clock ran out — a stall is not a reason to
    // pretend the first half never came, and the host settles what it holds.
    assert.ok(chunks.length > 0, 'the deltas that did arrive should have been yielded')
  } finally {
    server.close()
  }
})

test('a stream that keeps talking is left alone', async () => {
  const { baseURL, server } = await stallingEndpoint('none')
  try {
    // Gaps of GAP each, so the whole call outlives a single budget while no
    // individual silence approaches one. An implementation that armed one
    // un-disarmable clock for the call — `AbortSignal.timeout` composed once —
    // fails exactly here and nowhere else.
    const { chunks, error } = await drain(baseURL)
    assert.equal(error, undefined)
    const text = chunks
      .filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
      .map(chunk => chunk.text)
      .join('')
    assert.equal(text, `the ${'cat '.repeat(HEALTHY_WRITES - 1)}`)
  } finally {
    server.close()
  }
})

test('a budget of zero is off, not instant', async () => {
  const { baseURL, server } = await stallingEndpoint('none')
  try {
    // `0` reads as falsy and as "no time at all"; both readings would turn an
    // operator's "stop policing my slow local endpoint" into the opposite.
    const { chunks, error } = await drain(baseURL, {
      connectTimeoutMs: 0,
      firstByteTimeoutMs: 0,
      idleTimeoutMs: 0,
    })
    assert.equal(error, undefined)
    assert.ok(chunks.length > 0)
  } finally {
    server.close()
  }
})

test('the caller pressing stop is not reported as a timeout', { timeout: DEADLINE }, async () => {
  const { baseURL, server } = await stallingEndpoint('mid')
  try {
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, GAP)
    const { error } = await drain(baseURL, {}, { signal: controller.signal })
    // Whatever surfaces, it must not claim the provider went silent: the user
    // ended this, and `TIMEOUT` would send them to look at their endpoint.
    assert.notEqual(failure(error).code, 'TIMEOUT')
  } finally {
    server.close()
  }
})

test('the defaults are the documented ones', () => {
  // Pinned because they are written twice — here as the adapter's fallback and
  // again as the app config's schema default — and a pair that drifts is how a
  // documented default stops being the one that runs.
  assert.deepEqual(DEFAULT_TIMEOUTS, { connectMs: 30_000, firstByteMs: 120_000, idleMs: 120_000 })
})
