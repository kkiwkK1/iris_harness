import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { serveSandboxAsset } from '../src/sandbox-assets.ts'

/**
 * The sandbox's own build artifacts, served to an opaque-origin frame.
 *
 * The header is the whole point of this route existing separately from the
 * frontend plugin. `preset.js` is loaded as a **classic** script, and a classic
 * script without `crossorigin` reports everything it throws as the bare string
 * `Script error.` — no message, no file, no line. `crossorigin` on the tag and
 * this header on the response have to arrive together: either alone leaves the
 * frame no better off, and one of the two orders leaves it worse (a tag with
 * `crossorigin` against a response without the header does not load at all).
 */

/** A response that records what it was given. */
function capture(): { res: Parameters<typeof serveSandboxAsset>[3], status: () => number, headers: () => Record<string, unknown>, body: () => unknown } {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body: unknown
  const res = {
    writeHead(code: number, given: Record<string, unknown>) {
      status = code
      headers = given
    },
    end(chunk?: unknown) { body = chunk },
  } as unknown as Parameters<typeof serveSandboxAsset>[3]
  return { res, status: () => status, headers: () => headers, body: () => body }
}

/** A request for one path under the route. */
function request(url: string, method = 'GET'): Parameters<typeof serveSandboxAsset>[2] {
  return { method, url } as Parameters<typeof serveSandboxAsset>[2]
}

async function assets(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-sandbox-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'sandbox'), { recursive: true })
  await writeFile(join(dir, 'sandbox', 'preset.js'), 'globalThis.Vue = {}', 'utf8')
  await writeFile(join(dir, 'secret.txt'), 'not for the frame', 'utf8')
  return join(dir, 'sandbox')
}

test('an artifact is served with the header the frame needs', async (t) => {
  const dir = await assets(t)
  const { res, status, headers, body } = capture()
  await serveSandboxAsset(dir, '/sandbox', request('/sandbox/preset.js'), res)

  assert.equal(status(), 200)
  assert.equal(headers()['access-control-allow-origin'], '*')
  assert.equal(headers()['content-type'], 'application/javascript; charset=utf-8')
  assert.equal(String(body()), 'globalThis.Vue = {}')
  // Revalidated rather than held: a wrong header on a long-TTL response outlives
  // the deployment inside a cache only the browser can see, which is exactly how
  // the bundle route's missing CORS header survived several restarts.
  assert.equal(headers()['cache-control'], 'no-cache')
  // Resource Timing is origin-restricted: without this an opaque-origin frame
  // reads zeroes, and a judgement built on those can say a request was sent but
  // not whether it finished or is still hanging.
  assert.equal(headers()['timing-allow-origin'], '*')
  assert.equal(headers()['vary'], 'Origin')
})

test('every answer carries the header, not only the successful one', async (t) => {
  const dir = await assets(t)
  const cases: [string, string, number][] = [
    ['a missing file', '/sandbox/nothing.js', 404],
    ['a normalized escape', '/sandbox/../secret.txt', 404],
    ['an encoded-slash escape', '/sandbox/..%2fsecret.txt', 403],
  ]
  for (const [what, url, expected] of cases) {
    const { res, status, headers } = capture()
    await serveSandboxAsset(dir, '/sandbox', request(url), res)
    assert.equal(status(), expected, what)
    // A route whose CORS behaviour depends on the outcome is a route where what
    // failure looks like depends on who is asking.
    assert.equal(headers()['access-control-allow-origin'], '*', `${what} answered without the header`)
    assert.equal(headers()['timing-allow-origin'], '*', `${what} answered without timing access`)
    assert.equal(headers()['vary'], 'Origin', `${what} answered without the vary net`)
  }

  const { res, status, headers } = capture()
  await serveSandboxAsset(dir, '/sandbox', request('/sandbox/preset.js', 'POST'), res)
  assert.equal(status(), 405)
  assert.equal(headers()['access-control-allow-origin'], '*')
})

test('a path cannot climb out, by either of the two routes it could take', async (t) => {
  const dir = await assets(t)

  // Two spellings, two mechanisms — measured, not assumed. The URL parser
  // collapses `..` and `%2e%2e` before this code sees them, so those escape the
  // prefix and are refused by the prefix check; `..%2f` survives normalization
  // untouched and is refused by the containment check after decoding.
  //
  // Writing one test that expected a single status for all of them is what
  // exposed this: the first three were being refused by *arithmetic* — the
  // sliced remainder of an unrelated path happened not to exist — rather than by
  // any rule. Now the prefix is checked, so the refusal is a decision.
  const normalized = ['/sandbox/../secret.txt', '/sandbox/%2e%2e/secret.txt', '/sandbox/nested/../../secret.txt']
  for (const url of normalized) {
    const { res, status, body } = capture()
    await serveSandboxAsset(dir, '/sandbox', request(url), res)
    assert.equal(status(), 404, `${url} was not refused`)
    assert.equal(body(), undefined, `${url} returned a body`)
  }

  const { res, status, body } = capture()
  await serveSandboxAsset(dir, '/sandbox', request('/sandbox/..%2fsecret.txt'), res)
  assert.equal(status(), 403, 'the encoded-slash spelling reached the file')
  assert.equal(body(), undefined)
})

test('a HEAD asks the same question and gets no body', async (t) => {
  const dir = await assets(t)
  const { res, status, headers, body } = capture()
  await serveSandboxAsset(dir, '/sandbox', request('/sandbox/preset.js', 'HEAD'), res)
  assert.equal(status(), 200)
  assert.equal(headers()['content-length'], 19)
  assert.equal(body(), undefined)
})
