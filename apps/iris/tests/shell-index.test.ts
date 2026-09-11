import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SHELL_CSP_DIRECTIVES } from '@iris/app-service'

/**
 * The shell page as the browser actually receives it, from a booted host.
 *
 * The unit test (`packages/iris-app-service/tests/shell-csp.test.ts`) asserts
 * what the transform does to a string. This asserts the transform is *wired*:
 * that `@iris/app-service` registers the tap, that the carrier applies it, and
 * that the external package holding the fallback seat runs the index through
 * `renderIndex` at all. Those are three separate facts about three packages,
 * two of which are not ours, and none of them is visible from a pure function.
 *
 * The real `apps/iris-web/index.html` is the fixture — not a stand-in — because
 * the position assertion (the policy precedes the page's first inline script)
 * is only worth anything against the document that actually ships.
 *
 * @module apps/iris/tests/shell-index
 */

let ctx: Context
let dataDir: string
let distDir: string
let port: number

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'iris-shellindex-'))
  await mkdir(join(dataDir, 'default-user', 'characters'), { recursive: true })

  distDir = await mkdtemp(join(tmpdir(), 'iris-shellindex-dist-'))
  await mkdir(join(distDir, 'sandbox'), { recursive: true })
  copyFileSync(
    fileURLToPath(new URL('../../iris-web/index.html', import.meta.url)),
    join(distDir, 'index.html'),
  )

  process.env.IRIS_TEST_DATA_DIR = dataDir
  process.env.IRIS_TEST_WEB_DIST = join(distDir, 'index.html')

  ctx = await boot('iris-shell-index', fileURLToPath(new URL('./fixtures/shell-index.cordis.yml', import.meta.url)))
  port = ctx.webServer.port
})

after(async () => {
  await ctx.fiber.dispose()
  await rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  await rm(distDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

/** The index, as served. */
async function index(): Promise<{ status: number, headers: Headers, body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/`)
  return { status: response.status, headers: response.headers, body: await response.text() }
}

test('the served index carries the policy, once, ahead of its first script', async () => {
  const served = await index()
  assert.equal(served.status, 200)

  const metas = [...served.body.matchAll(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)]
  assert.equal(metas.length, 1, 'two policies would be enforced as an intersection nobody wrote')

  /*
   * Named here, not only iterated. The loop below asks "is every directive the
   * code exports present in the page", which is true of *any* export including
   * an empty one — a check that cannot see a directive being deleted, which is
   * the change worth catching. So the three are spelled out as a floor first,
   * and the loop is what catches a directive that is exported and then lost on
   * the way through the carrier.
   */
  for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(served.body.includes(directive), `the served page is missing ${directive}`)
  }
  assert.ok(SHELL_CSP_DIRECTIVES.length >= 3, 'the shell policy lost a directive')
  for (const directive of SHELL_CSP_DIRECTIVES) {
    assert.ok(served.body.includes(directive), `the carrier dropped ${directive} on the way out`)
  }

  const policyAt = served.body.indexOf('http-equiv="Content-Security-Policy"')
  const firstScript = served.body.indexOf('<script')
  assert.ok(firstScript !== -1)
  assert.ok(policyAt < firstScript, 'a meta policy governs only what the parser reaches after it')
})

test('the file on disk is untouched: the policy is added on the way out', async () => {
  /*
   * The tap is a render-time transform, so the dist stays a dist — and the dev
   * server, which serves `index.html` with no carrier and therefore no tap,
   * gets the same bytes a build does. That the dev shell runs *without* this
   * policy is a recorded cost (`notes/apps/iris-web/DEVIATIONS.md` §93), not an
   * accident, and this is the assertion that keeps it a deliberate one rather
   * than something a build step quietly changed.
   */
  const onDisk = await import('node:fs/promises').then(fs =>
    fs.readFile(fileURLToPath(new URL('../../iris-web/index.html', import.meta.url)), 'utf8'))

  assert.ok(
    !/http-equiv="Content-Security-Policy"/i.test(onDisk),
    'the source index now declares its own policy; the tap would refuse rather than add a second',
  )
  assert.match((await index()).body, /http-equiv="Content-Security-Policy"/i)
})

test('every index response is tapped, not only the first', async () => {
  // The static seat re-reads `distIndex` and calls `renderIndex` per response,
  // so nothing is cached per process. Asserted rather than read off the
  // package, because it is the fact that decides whether a per-response value
  // (a nonce) would ever be sound here.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body = (await index()).body
    assert.equal([...body.matchAll(/http-equiv="Content-Security-Policy"/gi)].length, 1)
  }
})

test('the index still answers no nosniff, which is the recorded gap', async () => {
  /*
   * Not a requirement — a record. The fallback seat belongs to
   * `@deepseek-ai/dsh-host-frontend-static`, which writes `content-type` and
   * nothing else and offers no hook for a header, so `nosniff`,
   * `frame-ancestors`/`X-Frame-Options` and `Cache-Control: no-store` are
   * absent on the index and on every built asset. `IrisRpcHost.guard` covers
   * the routes Iris owns and cannot reach this one.
   *
   * If this assertion ever goes red, the gap has closed and the thing to do is
   * delete this test and the paragraph in `notes/packages/iris-app-service/
   * DEVIATIONS.md` §74 that records it — not to loosen it.
   */
  const served = await index()
  assert.equal(
    served.headers.get('x-content-type-options'),
    null,
    'the index now carries nosniff — the external package grew a hook, so §74’s gap is closed',
  )
  // And the contrast, on the same host, one route over: what a guarded route does.
  const version = await fetch(`http://127.0.0.1:${String(port)}/version`)
  assert.equal(version.headers.get('x-content-type-options'), 'nosniff')
})
