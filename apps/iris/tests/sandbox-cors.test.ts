import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { serveSandboxAsset } from '../../../packages/iris-app-service/src/sandbox-assets.ts'

/**
 * The sandbox CORS pair, asserted from the one place that can see both halves.
 *
 * A card frame is an **opaque origin**, so every script it loads is cross-origin
 * to it — including Iris's own `preset.js`. Two things have to be true together
 * for that script's exceptions to arrive with names instead of the bare string
 * `Script error.`:
 *
 * 1. the frame's tag carries `crossorigin="anonymous"` (`apps/iris-web`), and
 * 2. the host answers that route with `Access-Control-Allow-Origin`
 *    (`@iris/app-service`).
 *
 * **Neither is safe alone, and each looks correct in isolation.** The attribute
 * without the header is not a weaker error message — it is a CORS fetch the
 * browser refuses, so the preset never runs at all. That combination shipped
 * once: it cost a full verification round, and the frame reported nine missing
 * libraries when the truth was one blocked request. The header without the
 * attribute is merely inert, but it means the masked errors nobody can read are
 * still masked while the fix appears to be in place.
 *
 * Each package can only test its own side, and both sides passed their own tests
 * on the day the pair was broken. So the pairing is asserted here, where the
 * dependency graph allows both to be seen — read as text rather than imported,
 * the same way `architecture.test.ts` inspects the browser without depending on
 * it.
 *
 * This is a static pairing check. Whether the running server really emits the
 * header on a real socket is a different question, covered by the app-service's
 * own route tests; this one exists so that changing one side alone cannot be
 * quietly correct.
 *
 * @module apps/iris/tests/sandbox-cors
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The frame's markup builder, as source. */
async function srcdocSource(): Promise<string> {
  return readFile(join(ROOT, 'apps', 'iris-web', 'src', 'sandbox', 'srcdoc.ts'), 'utf8')
}

/** The host's sandbox-asset route, as source, for the mounting check only. */
async function serviceSource(): Promise<string> {
  return readFile(join(ROOT, 'packages', 'iris-app-service', 'src', 'index.ts'), 'utf8')
}

/**
 * Ask the real route for a real file and report the headers it wrote.
 *
 * Invoked rather than read, because reading was not good enough: this route sets
 * the CORS header on five branches (405, 400, 403, 404 and success), so a search
 * of its source passes while the **success** path — the only one a working frame
 * ever takes — has lost it. That is not a hypothetical weakness; the first
 * version of this test was written as a source search and failed to notice
 * exactly that when the header was deliberately removed to check it.
 *
 * No socket and no boot: the route is an ordinary function over `req`/`res`, so
 * a stub response captures what a browser would receive.
 * @returns the status and headers of a successful asset response.
 */
async function serveOnce(): Promise<{ status: number, headers: Record<string, unknown> }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-sandbox-cors-'))
  await writeFile(join(dir, 'preset.js'), 'globalThis.x = 1', 'utf8')

  let status = 0
  let headers: Record<string, unknown> = {}
  const res = {
    writeHead(code: number, sent?: Record<string, unknown>) {
      status = code
      headers = Object.fromEntries(
        Object.entries(sent ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      )
      return res
    },
    end() {
      return res
    },
  }

  await serveSandboxAsset(
    dir,
    '/sandbox',
    { method: 'GET', url: '/sandbox/preset.js' } as never,
    res as never,
  )
  return { status, headers }
}

/**
 * Whether a source emits something, ignoring what its comments discuss.
 *
 * Both files explain this pairing at length and name the attribute and the
 * header while doing so. A search that counted those would pass on a file that
 * had removed the behaviour and kept the essay — and the cheapest way to quiet
 * such a test is to delete the explanation, which is the opposite of what should
 * happen here.
 *
 * Built with `String.fromCharCode` rather than written as escapes: escapes in
 * this project have been eaten in transit repeatedly, and a collapsed one still
 * parses while matching nothing.
 * @param source - the file contents.
 * @returns the source with block and line comments removed.
 */
function code(source: string): string {
  const OPEN = String.fromCharCode(47, 42)
  const CLOSE = String.fromCharCode(42, 47)
  const LINE = String.fromCharCode(47, 47)
  const NEWLINE = String.fromCharCode(10)

  let stripped = source
  for (;;) {
    const at = stripped.indexOf(OPEN)
    if (at === -1) break
    const to = stripped.indexOf(CLOSE, at + OPEN.length)
    if (to === -1) break
    stripped = stripped.slice(0, at) + stripped.slice(to + CLOSE.length)
  }
  return stripped
    .split(NEWLINE)
    .filter(line => !line.trim().startsWith(LINE))
    .join(NEWLINE)
}

test('the frame asks for CORS and the host answers it, or neither does', async () => {
  const asks = code(await srcdocSource()).includes('crossorigin="anonymous"')

  const served = await serveOnce()
  assert.equal(served.status, 200, 'the route did not serve a file it should have served')
  const answers = served.headers['access-control-allow-origin'] === '*'

  /*
   * Stated as an equivalence rather than an implication.
   *
   * The dangerous direction is asking without answering — that blocks the
   * script outright. But the other direction is worth failing too: a header
   * added for this purpose while the tag stays plain means the round it was
   * meant to unblock produces the same unreadable output, and the work reads as
   * done. Both halves are supposed to move together, so the test says so.
   */
  assert.equal(
    asks,
    answers,
    asks
      ? 'the frame requests CORS but the route does not send Access-Control-Allow-Origin on its' +
        ' success path — the browser will refuse to run the preset at all, with no error anywhere'
      : 'the route sends Access-Control-Allow-Origin but the frame tag does not request CORS, so' +
        ' the preset\u2019s errors are still redacted to "Script error."',
  )

  // Both false is a legitimate state — it is what the pair looked like before
  // either half landed — but it is not the state anyone should be in now, and
  // saying so here is cheaper than discovering it from a masked error.
  assert.equal(asks, true, 'the sandbox CORS pair is not in place')
})

test('the route that sends the header is actually mounted', async () => {
  /*
   * A correct route nobody calls is the third way this pair fails, and it is the
   * one with no symptom at all from either side's own tests.
   *
   * It was the live state of this repository for part of an afternoon: the
   * handler existed, sent the right header, and had never been wired into the
   * server, so the browser kept receiving the frontend plugin's fallback
   * response with no CORS header. Both halves of the pairing check above can be
   * perfectly true while the mounting is missing.
   */
  const service = code(await serviceSource())

  /*
   * A **call**, not the name. An import alone proves nothing — the first version
   * of this assertion searched for the identifier and stayed green when the
   * handler was disconnected, because the now-unused import still spelled it
   * out. What matters is that something invokes it.
   */
  assert.ok(
    service.includes('serveSandboxAsset('),
    'nothing in the service calls the sandbox-asset route, so the frontend fallback answers' +
      ' instead — with no CORS header, and no symptom in either half’s own tests',
  )
})

test('the host serves the sandbox route without a long-lived cache entry', async () => {
  /*
   * The companion lesson, and it belongs beside the pair because it is how the
   * pair failed in practice rather than in principle.
   *
   * The bundle route once answered `200` with a seven-day `max-age` and no CORS
   * header. Chrome cached that, partitioned by top site, and every later frame
   * validated CORS against the stale copy — so the header was fixed, the server
   * was healthy to `curl`, and the frame kept failing against a corpse. It took
   * a forced `cache: 'reload'` to clear.
   *
   * A response whose correctness depends on a header must not be held long
   * enough for the header to change underneath it.
   */
  const served = await serveOnce()
  const cache = String(served.headers['cache-control'] ?? '')
  assert.ok(
    cache.includes('no-cache') || cache.includes('max-age=0'),
    `sandbox assets are served with "${cache}", which lets a browser keep a copy from before a` +
      ' header change — the shape that made a fixed CORS header keep failing in the frame',
  )
})
