import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'

import { IRIS_VERSION, REPRODUCED_ST_VERSION, versionInfo, versionRoute } from '../src/version.ts'

/** A response that records what it was given, as `sandbox-assets.test.ts` does. */
function capture(): {
  res: ServerResponse
  status: () => number
  headers: () => Record<string, unknown>
  body: () => unknown
} {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body: unknown
  const res = {
    writeHead(code: number, given: Record<string, unknown>) {
      status = code
      headers = given
    },
    end(chunk?: unknown) { body = chunk },
  } as unknown as ServerResponse
  return { res, status: () => status, headers: () => headers, body: () => body }
}

/**
 * `GET /version` answers upstream's shape.
 *
 * The route was missing, so MagVarUpdate's opening
 * `fetch('/version').then(e => e.json()).then(e => e.pkgVersion)` 404'd —
 * two red reports per MVU card per chat, across six observed runs. The noise
 * was the visible half; the expensive half is silent, because the bundle's
 * `.catch(() => '1.0.0')` then hands every version-gated card a number older
 * than any real SillyTavern.
 */

test('the payload carries upstream’s six fields, and one of ours', () => {
  const info = versionInfo()

  // `src/util.js:136-164` returns exactly these six. Pinned as a key set
  // rather than field by field, because the failure this guards against is a
  // field going *missing* — a card reading one it expects gets `undefined`,
  // which is not an error anywhere and shows up three layers away.
  assert.deepEqual(
    Object.keys(info).sort(),
    ['agent', 'commitDate', 'gitBranch', 'gitRevision', 'iris', 'isLatest', 'pkgVersion'],
  )

  // Upstream's own values when git is unavailable (`util.js:159`'s catch leaves
  // all three at their initial null) — a state a release-zip install really
  // reaches, not a stand-in invented here.
  assert.equal(info.gitRevision, null)
  assert.equal(info.gitBranch, null)
  assert.equal(info.commitDate, null)
  assert.equal(info.isLatest, true)
})

test('pkgVersion is the reproduced SillyTavern version, and is semver', () => {
  const info = versionInfo()
  assert.equal(info.pkgVersion, REPRODUCED_ST_VERSION)
  assert.match(info.pkgVersion, /^\d+\.\d+\.\d+$/u)

  // The comparison a version-gated card makes has to put us **above** the
  // fallback, or answering at all buys nothing: `'1.0.0'` is what the bundle's
  // `.catch` supplies, and a card gating on a feature added after 1.0 would
  // take the same wrong branch whether we answered or not.
  const [major, minor] = info.pkgVersion.split('.').map(Number) as [number, number, number]
  assert.ok(major > 1 || (major === 1 && minor > 0), `${info.pkgVersion} must outrank the 1.0.0 fallback`)
})

test('the agent keeps upstream’s shape without carrying a person’s handle', () => {
  const info = versionInfo()

  // Upstream's literal is `SillyTavern:${pkgVersion}:Cohee#1207`. The prefix
  // and the three-part shape are what a parser keys on and are reproduced; the
  // maintainer's personal identifier is not ours to send, and this string
  // exists to identify a client to the Horde API.
  assert.match(info.agent, /^SillyTavern:\d+\.\d+\.\d+:/u)
  assert.ok(info.agent.startsWith(`SillyTavern:${REPRODUCED_ST_VERSION}:`))
  assert.ok(!info.agent.includes('Cohee'), 'upstream’s maintainer handle must not be reproduced')
})

test('who is really answering is available, in a field upstream does not have', () => {
  // The compatibility answer above says which behaviour set this is. This says
  // which host it is. Two questions, two fields — rather than one field made
  // to carry both and answering neither well.
  assert.deepEqual(versionInfo().iris, { version: IRIS_VERSION })
  assert.match(IRIS_VERSION, /^\d+\.\d+\.\d+$/u)
})

test('the route answers 200 with the payload, at the path upstream serves', async () => {
  // **Driven through the real route object**, the same value `apply` hands the
  // server — not through `versionInfo()`. Testing the payload and the
  // consumer's expression while leaving the thing that answers the request
  // untested is the seam in `METHODS.md` §22, and this feature is small enough
  // that the seam would have been most of it.
  const route = versionRoute()
  assert.equal(route.path, '/version')
  assert.equal(route.kind, 'exact')

  const captured = capture()
  route.handler({ method: 'GET', url: '/version' } as IncomingMessage, captured.res)

  assert.equal(captured.status(), 200)
  assert.equal(captured.headers()['content-type'], 'application/json')

  // **The consumer's line, not a paraphrase of it.** MagVarUpdate opens with
  // `fetch('/version').then(e => e.json()).then(e => e.pkgVersion).catch(() => '1.0.0')`.
  // Every link has to survive: a payload that is valid JSON but carries no
  // `pkgVersion` resolves to `undefined` **without** reaching the catch, so
  // "the catch did not fire" alone would pass on a broken answer. Both halves
  // are asserted.
  let caught = false
  const resolved = await Promise.resolve(new Response(String(captured.body()), {
    headers: { 'content-type': 'application/json' },
  }))
    .then(res => res.json() as Promise<Record<string, unknown>>)
    .then(json => json['pkgVersion'])
    .catch(() => { caught = true; return '1.0.0' })

  assert.equal(caught, false, 'the bundle’s catch must not fire')
  assert.equal(resolved, REPRODUCED_ST_VERSION)
})
