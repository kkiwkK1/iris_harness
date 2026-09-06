import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'

import { credentialOf, OpenAiCompatAdapter, type Config } from '../src/index.ts'

/**
 * The credential a request carries.
 *
 * A connection profile's key is the user's own; the rules here decide which
 * header it goes out in and who wins when more than one source exists. The
 * one property worth pinning hardest: an endpoint the user pointed Iris at,
 * with a key typed into the form, must authenticate **as the form sent it** —
 * not as some operator's environment variable, and not stripped of its scheme
 * because the header happens to be `Authorization`.
 */

test('an explicit key wins over the environment', () => {
  process.env.IRIS_TEST_KEY_ENV = 'sk-from-env'
  const credential = credentialOf({ provider: 'p', baseURL: 'http://x/v1', apiKeyEnv: 'IRIS_TEST_KEY_ENV', apiKey: 'sk-from-form' })
  assert.deepEqual(credential, { name: 'authorization', value: 'Bearer sk-from-form' })
  delete process.env.IRIS_TEST_KEY_ENV
})

test('the environment serves when no explicit key exists', () => {
  process.env.IRIS_TEST_KEY_ENV = 'sk-from-env'
  const credential = credentialOf({ provider: 'p', baseURL: 'http://x/v1', apiKeyEnv: 'IRIS_TEST_KEY_ENV' })
  assert.deepEqual(credential, { name: 'authorization', value: 'Bearer sk-from-env' })
  delete process.env.IRIS_TEST_KEY_ENV
})

test('no source at all is an unauthenticated endpoint, not an error', () => {
  assert.equal(credentialOf({ provider: 'p', baseURL: 'http://x/v1' }), undefined)
})

test('a configured source with nothing in it is refused by name', () => {
  delete process.env.IRIS_TEST_KEY_EMPTY
  assert.throws(
    () => credentialOf({ provider: 'p', baseURL: 'http://x/v1', apiKeyEnv: 'IRIS_TEST_KEY_EMPTY' }),
    /missing API key: set IRIS_TEST_KEY_EMPTY/u,
  )
  // An explicitly empty key (the wire's "clear it" value) is the same refusal,
  // worded for the case where there is no environment to blame.
  assert.throws(
    () => credentialOf({ provider: 'p', baseURL: 'http://x/v1', apiKey: '' }),
    /the stored key is empty/u,
  )
})

test('a named header carries the bare value, without the Bearer scheme', () => {
  const credential = credentialOf({ provider: 'p', baseURL: 'http://x/v1', apiKey: 'sk-raw', apiKeyHeader: 'x-api-key' })
  assert.deepEqual(credential, { name: 'x-api-key', value: 'sk-raw' })
})

/** A one-shot /chat/completions endpoint that records the headers it saw. */
async function withCapture(t: test.TestContext, run: (baseURL: string, headers: Record<string, string>) => Promise<void>): Promise<void> {
  const headers: Record<string, string> = {}
  const server: Server = createServer((request, response) => {
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[name] = value
    }
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw new Error('no bound port')
  }
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))

  await run(`http://127.0.0.1:${String(address.port)}/v1`, headers)
}

function adapterOf(config: Omit<Config, 'provider' | 'baseURL'> & { baseURL?: string }): OpenAiCompatAdapter {
  return new OpenAiCompatAdapter({ provider: 'p', baseURL: 'unused', ...config })
}

test('a stream sends the key the form typed, in the header the profile named', async (t) => {
  await withCapture(t, async (baseURL, headers) => {
    const adapter = adapterOf({ baseURL, apiKey: 'sk-form-key', apiKeyHeader: 'x-api-key' })
    for await (const _chunk of adapter.stream({ provider: 'p', model: 'm', messages: [] })) void _chunk
    assert.equal(headers['x-api-key'], 'sk-form-key')
    // The default header is not also sent: one credential, one header.
    assert.equal(headers['authorization'], undefined)
  })
})

test('a stream under the default header authenticates as Bearer', async (t) => {
  await withCapture(t, async (baseURL, headers) => {
    const adapter = adapterOf({ baseURL, apiKey: 'sk-bearer-key' })
    for await (const _chunk of adapter.stream({ provider: 'p', model: 'm', messages: [] })) void _chunk
    assert.equal(headers['authorization'], 'Bearer sk-bearer-key')
  })
})

test('an unauthenticated stream sends no credential header at all', async (t) => {
  await withCapture(t, async (baseURL, headers) => {
    const adapter = adapterOf({ baseURL })
    for await (const _chunk of adapter.stream({ provider: 'p', model: 'm', messages: [] })) void _chunk
    assert.equal('authorization' in headers, false)
    assert.equal('x-api-key' in headers, false)
  })
})
