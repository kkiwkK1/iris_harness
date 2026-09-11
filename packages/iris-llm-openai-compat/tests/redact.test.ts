import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test, type TestContext } from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { OpenAiCompatAdapter, REDACTED, redactSecrets } from '../src/index.ts'

import { listenOnFetchablePort } from '../../iris-app-service/tests/support/fetchable-port.ts'

/**
 * A provider's own words, minus the credential it may have quoted back.
 *
 * A non-2xx body is echoed into the sentence a turn fails with, and that
 * sentence travels to every open page as `stream.error`'s `message` and onto
 * disk in the cache trace's `error`. DeepSeek masks the key in its own answer
 * (`Your api key: **** is invalid`, measured 2026-09-09) but nothing in the
 * protocol obliges a provider or a proxy to, and echoing the request's
 * `Authorization` header on a 401 is a shape that exists in the wild. The scrub
 * is the defence; these tests hold both halves of it — what it takes out, and
 * that it leaves everything else exactly as it found it.
 */

/** Obviously not a credential, and long enough to look like one. */
const FAKE_KEY = 'sk-iris-test-not-a-real-key-000000000000'

test('the configured key is taken out wherever it appears', () => {
  const scrubbed = redactSecrets(`{"error":"key ${FAKE_KEY} rejected"}`, [FAKE_KEY])
  assert.equal(scrubbed, `{"error":"key ${REDACTED} rejected"}`)
  assert.ok(!scrubbed.includes(FAKE_KEY))
})

test('the header value is taken out as one credential, scheme and all', () => {
  // What the adapter actually holds: `credentialOf` returns `Bearer <key>` for
  // `Authorization`, so both spellings are passed and the longer must win —
  // redacting the bare key first would leave the scheme word standing alone.
  const scrubbed = redactSecrets(
    `unauthorized: Authorization: Bearer ${FAKE_KEY}`,
    [`Bearer ${FAKE_KEY}`, FAKE_KEY],
  )
  assert.equal(scrubbed, `unauthorized: Authorization: ${REDACTED}`)
})

test('a Bearer token this process never held is taken out by its shape', () => {
  // The case the literal cannot cover: a relayed error, or a proxy quoting
  // somebody else's header back at us.
  assert.equal(
    redactSecrets('401 {"echo":"authorization: Bearer abc.def.ghijklmno"}'),
    `401 {"echo":"authorization: ${REDACTED}"}`,
  )
  // The name in front is kept: it says what was taken out, and a pattern that
  // ate the word before the colon would eat the wrong one out of a sentence.
  assert.match(redactSecrets('Authorization: Bearer abc.def.ghijklmno'), /^Authorization: /u)
})

test('an sk- token is taken out by its shape', () => {
  assert.equal(
    redactSecrets('invalid key sk-abcdefghijklmnopqrstuvwxyz012345 supplied'),
    `invalid key ${REDACTED} supplied`,
  )
})

test('a body with no credential in it passes through byte for byte', () => {
  // DeepSeek's real answer to a bad key, masked at the source. The one sentence
  // that must survive: it is the diagnosis, and a scrub that paraphrased it
  // would cost the reader the answer.
  const real = '{"error":{"message":"Your api key: **** is invalid","type":"authentication_error"}}'
  assert.equal(redactSecrets(real, [FAKE_KEY]), real)
  const prose = 'model not found; the sk- prefix is not the problem, Bearer token missing'
  assert.equal(redactSecrets(prose), prose)
})

test('a key too short to be one is left alone rather than mangling the sentence', () => {
  // Below the floor the literal is not applied: replacing every `x` would turn
  // a provider's sentence into rubble, and a three-character key is not a
  // credential. The shape patterns still cover it inside a header.
  assert.equal(redactSecrets('the model xyz is invalid', ['xyz']), 'the model xyz is invalid')
})

test('the scrub is applied before the cut, not after', () => {
  // A credential straddling character 500 would otherwise be halved into
  // something that still names most of itself.
  const body = 'x'.repeat(480) + `Bearer ${FAKE_KEY}`
  const detail = redactSecrets(body, [`Bearer ${FAKE_KEY}`]).slice(0, 500)
  assert.ok(!detail.includes('sk-iris'))
  assert.equal(detail, 'x'.repeat(480) + REDACTED)
})

/**
 * An endpoint that refuses with a body of the caller's choosing.
 * @param t - the test context, for closing the server.
 * @param body - what the refusal echoes back.
 * @returns the base URL to point an adapter at.
 */
async function refusing(t: TestContext, body: string): Promise<string> {
  const server: Server = createServer((request, response) => {
    request.resume()
    response.writeHead(401, { 'content-type': 'application/json', connection: 'close' })
    response.end(body)
  })
  const port = await listenOnFetchablePort(server)
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${String(port)}/v1`
}

/**
 * The sentence one refusal produces.
 * @param baseURL - the endpoint to ask.
 * @param apiKey - the key the adapter is configured with.
 * @returns the `LlmError`'s message.
 */
async function refusalOf(baseURL: string, apiKey: string, apiKeyHeader?: string): Promise<string> {
  const adapter = new OpenAiCompatAdapter({
    provider: 'p', baseURL, apiKey, ...apiKeyHeader === undefined ? {} : { apiKeyHeader },
  })
  try {
    for await (const _chunk of adapter.stream({ provider: 'p', model: 'm', messages: [] })) void _chunk
  } catch (error: unknown) {
    assert.ok(error instanceof LlmError)
    return error.message
  }
  throw new Error('the refusal was not raised')
}

test('a provider that echoes the request header does not put the key on the wire', async (t) => {
  // The mechanism, end to end: the proxy answers 401 with the header it was
  // sent. Nothing about the adapter's configuration tells it not to.
  const baseURL = await refusing(t, JSON.stringify({
    error: `no such key for Authorization: Bearer ${FAKE_KEY}`,
  }))

  const message = await refusalOf(baseURL, FAKE_KEY)

  assert.ok(!message.includes(FAKE_KEY), 'the configured key reached the error sentence')
  assert.ok(message.includes(REDACTED))
  // The two parts a reader navigates by are composed after the scrub and are
  // untouched by it.
  assert.ok(message.startsWith(`${baseURL}/chat/completions responded 401: `), message)
})

test('a key straddling the 500th character of the body is gone, not halved', async (t) => {
  /*
   * The call site's ordering, pinned where it lives: the adapter scrubs the
   * whole body and cuts afterwards. Cutting first leaves the *first* characters
   * of the key standing, and a truncated credential is still a credential's
   * prefix — the cap is a size limit, never a boundary anything may rely on.
   *
   * A bare key in a named header rather than `Bearer sk-…`, deliberately: the
   * shape patterns would catch a truncated Bearer token anyway and the two
   * orderings would agree, so the one case that tells them apart is the key
   * only the *literal* rule knows — which a cut has already destroyed by the
   * time the scrub runs.
   */
  const bare = 'iris-fake-not-a-real-key-0000000000000000'
  const baseURL = await refusing(t, 'x'.repeat(490) + bare)

  const message = await refusalOf(baseURL, bare, 'x-api-key')

  assert.ok(!message.includes(bare.slice(0, 10)), 'the cut ran before the scrub, and left the key’s head behind')
  assert.ok(message.includes(REDACTED))
  assert.ok(message.length <= `${baseURL}/chat/completions responded 401: `.length + 500, 'the 500-character cap is gone')
})

test('a provider that says something useful is quoted verbatim', async (t) => {
  const real = '{"error":{"message":"Your api key: **** is invalid","type":"authentication_error"}}'
  const baseURL = await refusing(t, real)

  const message = await refusalOf(baseURL, FAKE_KEY)

  assert.equal(message, `${baseURL}/chat/completions responded 401: ${real}`)
})
