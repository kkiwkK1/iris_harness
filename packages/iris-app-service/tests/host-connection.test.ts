/**
 * The coupling between this runtime's host-connection fallback and the shipped
 * composition.
 *
 * `connections.ts` reads three environment variables to answer "what is this
 * host generating through?" when the composition did not hand that in. It reads
 * them **because `apps/iris/cordis.yml` reads exactly the same three** for its
 * `llm-openai-compat` row — that is what makes the fallback a second reader of
 * one decision instead of a second decision.
 *
 * A rename in the composition with no rename here has no symptom. The panel
 * would go on showing a "host default" row, populated from variables nothing
 * sets any more, describing a connection that is not the one answering — a
 * confident report of the wrong thing, which is the failure mode this whole
 * area was built to remove. So the coupling is asserted rather than commented:
 * a `HOST_CONNECTION_ENV` name the composition does not mention goes red here.
 *
 * Reaching up into `apps/iris/` from a package test is a layering inversion,
 * and it is the deliberate price of the guard: this is the direction the
 * coupling actually runs, and the alternative is a comment, which never goes
 * red. `apps/iris/tests/composition.test.ts` parses the same file for its own
 * reasons, so the file is already treated as an asserted artefact.
 *
 * @module @iris/app-service/tests/host-connection
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { HOST_CONNECTION_ENV, hostConnectionFromEnv, hostDefaultView } from '../src/connections.ts'

const COMPOSITION = fileURLToPath(new URL('../../../apps/iris/cordis.yml', import.meta.url))

test('every variable the fallback reads is one the shipped composition reads too', async () => {
  const composition = await readFile(COMPOSITION, 'utf8')
  // A floor on the sample as well as the check itself: a path that silently
  // resolved to an empty or missing file would make the loop below pass by
  // comparing nothing.
  assert.ok(composition.includes('llm-openai-compat'), 'the composition file is not the one this guard means')

  for (const [role, name] of Object.entries(HOST_CONNECTION_ENV)) {
    assert.ok(
      composition.includes(name),
      `the fallback reads ${name} for the host's ${role}, and the composition never mentions it`,
    )
  }
})

test('the fallback reports an endpoint and a key source, never a key', () => {
  const host = hostConnectionFromEnv(
    {
      [HOST_CONNECTION_ENV.baseURL]: 'https://api.example.com/v1',
      [HOST_CONNECTION_ENV.model]: 'example-chat',
      [HOST_CONNECTION_ENV.keyEnv]: 'EXAMPLE_KEY',
      EXAMPLE_KEY: 'sk-not-for-the-wire',
    },
    { provider: 'default', model: 'ignored-when-the-env-says' },
  )
  assert.equal(host.apiKey, 'sk-not-for-the-wire', 'the in-process value is what a probe needs')

  const view = hostDefaultView(host)
  assert.equal(view.keySource, 'env')
  assert.equal(view.keyEnv, 'EXAMPLE_KEY')
  assert.equal(
    JSON.stringify(view).includes('sk-not-for-the-wire'),
    false,
    'the projection carries the credential',
  )
})

test('an empty key variable is no key, not a key that is the empty string', () => {
  // The shape that would otherwise read as "configured": the indirection is
  // set, and what it points at is blank. `keySource: 'env'` there would send
  // the reader looking for a key that was never there.
  const host = hostConnectionFromEnv(
    { [HOST_CONNECTION_ENV.keyEnv]: 'EXAMPLE_KEY', EXAMPLE_KEY: '' },
    { provider: 'default', model: 'm' },
  )
  assert.equal(host.apiKey, undefined)
  assert.equal(hostDefaultView(host).keySource, 'none')
  assert.equal(hostDefaultView(host).keyEnv, undefined)
})

test('a variable naming a variable nothing set is no key either', () => {
  const host = hostConnectionFromEnv(
    { [HOST_CONNECTION_ENV.keyEnv]: 'NEVER_EXPORTED' },
    { provider: 'default', model: 'm' },
  )
  assert.equal(host.apiKey, undefined)
  // The *name* is still worth keeping out of the view here: with no key behind
  // it, naming the variable would read as "your key is in NEVER_EXPORTED".
  assert.equal(hostDefaultView(host).keyEnv, undefined)
  assert.equal(hostDefaultView(host).keySource, 'none')
})
