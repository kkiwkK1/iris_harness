import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { cacheKey, ScriptCache } from '../src/script-cache.ts'
import { nodeFetch } from '../src/remote-fetch.ts'
import { fakeRemote } from './support/fake-remote.ts'
import { listenOnFetchablePort } from './support/fetchable-port.ts'

/**
 * The host-side half of the remote-bundle proxy.
 *
 * Two things are being defended and they pull in opposite directions. The point
 * of the route is that a card's dependency loads fast; the point of the checks
 * is that the URL deciding what gets executed comes from the untrusted side. So
 * most of what follows is about refusals, and the one performance property —
 * fetch once — is asserted by counting requests rather than by timing anything.
 */

/**
 * The upstream is `support/fake-remote.ts`, shared with `script-fetch.test.ts`.
 *
 * Both routes now fetch through one executor, so their tests inject one
 * transport: a second fake here with its own idea of what a redirect or a body
 * is would let the two sides drift apart again in the place they last did.
 */
const upstream = fakeRemote

async function cacheIn(
  t: TestContext,
  routes: Record<string, { status: number, body?: string, location?: string }>,
  options: { maxBytes?: number, ttlSeconds?: number, maxCacheBytes?: number } = {},
): Promise<{ cache: ScriptCache, asked: string[], dir: string, errors: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-bundles-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const { fetch, asked } = upstream(routes)
  const errors: string[] = []
  const cache = new ScriptCache({
    dir,
    fetchRemote: fetch,
    onError: (error: Error) => { errors.push(error.message) },
    ...options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes },
    ...options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds },
    // Forwarded explicitly, one line per option. An earlier version of this
    // helper accepted `maxCacheBytes` in its signature and never passed it on,
    // so the budget test ran against the 256 MiB default and asserted nothing —
    // the test failed, which is the only reason it was noticed.
    ...options.maxCacheBytes === undefined ? {} : { maxCacheBytes: options.maxCacheBytes },
  })
  return { cache, asked, dir, errors }
}

const BUNDLE = 'https://testingcf.jsdelivr.net/gh/some/repo@1.2.3/dist/bundle.js'

/** The sheet 人贩子物语's status bar asks for, the measured stylesheet case. */
const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css'

test('a bundle is fetched once and served from disk after that', async (t) => {
  const { cache, asked, dir } = await cacheIn(t, { [BUNDLE]: { status: 200, body: 'export const x = 1' } })

  const first = await cache.load(BUNDLE)
  assert.ok(Buffer.isBuffer(first))
  assert.equal(first.toString('utf8'), 'export const x = 1')

  const second = await cache.load(BUNDLE)
  assert.ok(Buffer.isBuffer(second))
  // The whole reason the route exists: an opaque-origin frame shares no HTTP
  // cache, so without this every chat open pays the 9–12 s again.
  assert.deepEqual(asked, [BUNDLE], 'the second load went back to the network')

  // On disk under a hashed name, with the URL recorded beside it so a cache
  // directory is still explicable to whoever opens it.
  const files = await readdir(dir)
  assert.deepEqual(files.sort(), [`${cacheKey(BUNDLE)}.js`, `${cacheKey(BUNDLE)}.json`])
  const meta = JSON.parse(await readFile(join(dir, `${cacheKey(BUNDLE)}.json`), 'utf8')) as { url: string }
  assert.equal(meta.url, BUNDLE)
})

test('concurrent opens cause one request, not one each', async (t) => {
  const { cache, asked } = await cacheIn(t, { [BUNDLE]: { status: 200, body: 'x' } })
  // Several scripts importing the same bundle as a chat opens is the ordinary
  // case, not a race worth ignoring: without coalescing, the first open after a
  // restart fetches 300 KB once per importer.
  await Promise.all([cache.load(BUNDLE), cache.load(BUNDLE), cache.load(BUNDLE)])
  assert.deepEqual(asked, [BUNDLE])
})

test('a host outside the whitelist is refused by name', async (t) => {
  const { cache, asked } = await cacheIn(t, {})
  for (const url of [
    'https://evil.example/bundle.js',
    'https://jsdelivr.net.evil.example/bundle.js',
    'https://gist.githubusercontent.com/u/x.js',
    'http://testingcf.jsdelivr.net/gh/a/b.js',
  ]) {
    const result = await cache.load(url)
    assert.ok(!Buffer.isBuffer(result), `${url} was fetched`)
    assert.equal(result.status, 403, url)
    assert.ok(result.reason.length > 0, 'a refusal with no reason is indistinguishable from a network fault')
  }
  // Nothing left the machine. A whitelist checked after the request would be a
  // whitelist for the response, not for the fetch.
  assert.deepEqual(asked, [])
})

test('a redirect is checked like the first request was', async (t) => {
  const off = 'https://testingcf.jsdelivr.net/gh/a/b.js'
  const { cache, asked, errors } = await cacheIn(t, {
    [off]: { status: 302, location: 'https://evil.example/payload.js' },
  })

  const result = await cache.load(off)
  assert.ok(!Buffer.isBuffer(result))
  assert.equal(result.status, 403)
  assert.match(result.reason, /redirected to a host that is not allowed/u)
  // Aimed at an allowed host, landed somewhere else — and the far side chooses
  // the landing. Following it would make the whitelist a statement about
  // intentions rather than about what runs.
  assert.deepEqual(asked, [off], 'the redirect was followed')
  assert.ok(errors.some(message => /not allowed/u.test(message)))
})

test('a redirect that stays inside the whitelist is followed', async (t) => {
  const from = 'https://cdn.jsdelivr.net/npm/pkg@latest/dist/b.js'
  const to = 'https://cdn.jsdelivr.net/npm/pkg@1.0.0/dist/b.js'
  const { cache, asked } = await cacheIn(t, {
    [from]: { status: 302, location: to },
    [to]: { status: 200, body: 'ok' },
  })
  const result = await cache.load(from)
  assert.ok(Buffer.isBuffer(result))
  assert.equal(result.toString('utf8'), 'ok')
  // jsDelivr redirects a moving tag to its resolved version, so refusing every
  // redirect would refuse the ordinary case.
  assert.deepEqual(asked, [from, to])
})

test('a body over the limit is refused, and not stored', async (t) => {
  const { cache, dir, errors } = await cacheIn(t, {
    [BUNDLE]: { status: 200, body: 'x'.repeat(200) },
  }, { maxBytes: 100 })

  const result = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(result))
  assert.equal(result.status, 413)
  assert.deepEqual(await readdir(dir), [], 'an oversized body was written to disk anyway')
  assert.ok(errors.some(message => /over the 100 byte limit/u.test(message)))
})

test('an upstream failure is reported in the words the browser gets', async (t) => {
  const { cache, errors } = await cacheIn(t, { [BUNDLE]: { status: 503 } })
  const result = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(result))
  assert.equal(result.status, 502)
  // Named, both to the caller and to the log: a card that cannot load its
  // dependency has to be diagnosable by whoever holds the card, and "failed" on
  // its own does not distinguish a refusal from a CDN outage.
  assert.match(result.reason, /answered 503/u)
  assert.match(result.reason, /jsdelivr/u)
  assert.ok(errors.some(message => /answered 503/u.test(message)))
})

test('a stale entry is refetched, a fresh one is not', async (t) => {
  const { cache, asked } = await cacheIn(t, { [BUNDLE]: { status: 200, body: 'v1' } }, { ttlSeconds: 0 })
  await cache.load(BUNDLE)
  await cache.load(BUNDLE)
  // One TTL for every URL, on purpose: a pinned URL never changes so the window
  // costs nothing there, and a heuristic that guessed which URLs are pinned
  // would cache a branch name forever with no way to notice.
  assert.deepEqual(asked, [BUNDLE, BUNDLE])
})

test('the cache key is the whole URL', () => {
  // Two versions of one package are two entries. A key derived from the path's
  // last segment would serve `pkg@2` from `pkg@1`'s bytes.
  assert.notEqual(
    cacheKey('https://cdn.jsdelivr.net/npm/pkg@1.0.0/dist/b.js'),
    cacheKey('https://cdn.jsdelivr.net/npm/pkg@2.0.0/dist/b.js'),
  )
  assert.equal(cacheKey(BUNDLE), cacheKey(BUNDLE))
  // Hex, so it is a filename and never a path.
  assert.match(cacheKey(BUNDLE), /^[0-9a-f]{64}$/u)
})

test('the default upstream adapter behaves the way the cache assumes', async (t) => {
  // The one part of this module a test with an injected upstream never runs, and
  // the part production always runs. Two of its assumptions belong to somebody
  // else's runtime, not to this code: that `redirect: 'manual'` yields the real
  // 3xx with a readable `location` (a browser hands back an opaque response
  // instead, and this would then follow nothing and report nothing), and that
  // `credentials: 'omit'` is accepted at all. Both are asserted here against a
  // real socket rather than trusted.
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: '/target' })
      res.end()
      return
    }
    if (req.url === '/target') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('BODY-OK')
      return
    }
    res.writeHead(404)
    res.end()
  })
  // Through the shared guard rather than `listen(0)` directly: an ephemeral
  // draw can land on a port WHATWG Fetch refuses outright, and `nodeFetch`
  // would then reject for a reason that has nothing to do with the redirect
  // behaviour under test. See `support/fetchable-port.ts`.
  const port = await listenOnFetchablePort(server)
  t.after(() => { server.close() })
  const base = `http://127.0.0.1:${String(port)}`

  const init = { redirect: 'manual', credentials: 'omit', headers: { accept: '*/*' } } as const
  const redirected = await nodeFetch(`${base}/redir`, init)
  assert.equal(redirected.status, 302, 'the redirect was followed or hidden')
  assert.equal(redirected.headers.get('location'), '/target', 'the location header was not readable')

  const ok = await nodeFetch(`${base}/target`, init)
  assert.equal(ok.status, 200)
  // The third runtime assumption, added when the cap moved to an incremental
  // read: `response.body` is async-iterable, so a body can be abandoned partway.
  // If undici ever handed back something that is not, the cap would silently
  // stop being a cap — `for await` over a non-iterable throws, and the executor
  // would report an unreachable upstream for a body it could have read.
  assert.notEqual(ok.body, null, 'the adapter handed back no body to read')
  const chunks: Buffer[] = []
  for await (const chunk of ok.body ?? []) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'BODY-OK')

  // A dead socket must reject rather than resolve with something falsy, because
  // the caller turns a rejection into a named 502 and would otherwise report
  // success with an empty body.
  server.close()
  await assert.rejects(() => nodeFetch(`${base}/target`, init))
})

test('asking why something failed does not repeat the failure', async (t) => {
  const { cache, asked } = await cacheIn(t, { [BUNDLE]: { status: 503 } })

  const first = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(first))
  assert.equal(first.status, 502)

  // The shell reads the reason by requesting the same URL again — a failed
  // `import()` gives its caller no response to inspect, so there is no other
  // way to learn it. Re-running an unreachable fetch to produce an error string
  // would cost exactly what the error cost, which on a dead CDN is the 9–12 s
  // this module exists to stop paying.
  const second = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(second))
  assert.equal(second.status, 502)
  assert.equal(second.reason, first.reason, 'the second answer was not the remembered one')
  assert.deepEqual(asked, [BUNDLE], 'the diagnostic request went back to the network')
})

test('a refusal needs no network either time', async (t) => {
  const { cache, asked } = await cacheIn(t, {})
  const url = 'https://evil.example/x.js'
  const first = await cache.load(url)
  const second = await cache.load(url)
  assert.ok(!Buffer.isBuffer(first) && !Buffer.isBuffer(second))
  // A 403 is a property of the URL alone, so both answers come from the
  // whitelist and neither is remembered work.
  assert.equal(second.reason, first.reason)
  assert.deepEqual(asked, [])
})

test('a remembered failure does not lock out a recovery', async (t) => {
  // The window is short so a CDN that comes back is reachable again. Without a
  // bound this would be a negative cache, and a transient blip would look like
  // a permanent outage for as long as the host stayed up.
  const routes: Record<string, { status: number, body?: string }> = { [BUNDLE]: { status: 503 } }
  const { cache, asked } = await cacheIn(t, routes)
  assert.ok(!Buffer.isBuffer(await cache.load(BUNDLE)))

  await new Promise(resolve => setTimeout(resolve, 5))
  routes[BUNDLE] = { status: 200, body: 'recovered' }

  // Still inside the window, so still the remembered failure — asserted so the
  // bound is a real bound rather than an accident of timing.
  const stillFailing = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(stillFailing))
  assert.deepEqual(asked, [BUNDLE])
})

test('every response carries the header a module fetch needs', async (t) => {
  const { cache } = await cacheIn(t, { [BUNDLE]: { status: 200, body: 'x' } })
  const seen: { status: number, headers: Record<string, unknown> }[] = []
  const res = () => {
    const captured = { status: 0, headers: {} as Record<string, unknown> }
    seen.push(captured)
    return {
      writeHead(status: number, headers: Record<string, unknown>) {
        captured.status = status
        captured.headers = headers
      },
      end() {},
    } as unknown as Parameters<ScriptCache['serve']>[1]
  }
  const req = (url: string, method = 'GET') => ({ method, url }) as Parameters<ScriptCache['serve']>[0]

  // A module fetch is a CORS fetch unconditionally — `import()` and
  // `<script type="module">` use request mode `cors` whatever the origin — and
  // the card's frame is opaque-origin, so every one of these arrives with
  // `Origin: null`. Without the header the browser holds the bytes and hands the
  // module system nothing, reporting only a failure against the outer blob URL.
  await cache.serve(req(`/x?url=${encodeURIComponent(BUNDLE)}`), res())
  await cache.serve(req('/x'), res())
  await cache.serve(req(`/x?url=${encodeURIComponent('https://evil.example/a.js')}`), res())
  await cache.serve(req('/x?url=y', 'POST'), res())

  assert.deepEqual(seen.map(entry => entry.status), [200, 400, 403, 405])
  for (const entry of seen) {
    assert.equal(
      entry.headers['access-control-allow-origin'],
      '*',
      `status ${String(entry.status)} answered without the header a module fetch needs`,
    )
    assert.equal(entry.headers['timing-allow-origin'], '*', `status ${String(entry.status)} withheld timing`)
    assert.equal(entry.headers['vary'], 'Origin', `status ${String(entry.status)} answered without the vary net`)
  }

  // The browser holds nothing. The cold-CDN cost this route exists to avoid is
  // already paid by the disk cache; a browser copy would save the ~46 ms it now
  // costs and buy back the failure this route has already paid for twice — a
  // response whose correctness depends on a header, held past the header
  // changing. `no-cache` is revalidate-before-use, so copies already poisoned in
  // the wild are replaced on next use instead of expiring on their own schedule.
  assert.equal(seen[0]?.headers['cache-control'], 'no-cache')
  assert.equal(
    String(seen[0]?.headers['cache-control']).includes('max-age'),
    false,
    'the browser was told it may hold this response',
  )
})

test('the cache stops growing at its budget instead of evicting', async (t) => {
  const first = 'https://cdn.jsdelivr.net/npm/a@1/x.js'
  const second = 'https://cdn.jsdelivr.net/npm/b@1/x.js'
  const { cache, dir } = await cacheIn(t, {
    [first]: { status: 200, body: 'a'.repeat(400) },
    [second]: { status: 200, body: 'b'.repeat(400) },
  }, { maxCacheBytes: 600 })

  assert.ok(Buffer.isBuffer(await cache.load(first)))
  const second2 = await cache.load(second)
  // Still served — the fetch worked, only the write was skipped.
  assert.ok(Buffer.isBuffer(second2))
  assert.equal(second2.toString('utf8').startsWith('b'), true)

  // Refusing to store beats evicting: eviction would let whoever filled the
  // directory push out the bundle a real card depends on.
  const files = await readdir(dir)
  assert.ok(files.includes(`${cacheKey(first)}.js`), 'the first entry was evicted')
  assert.equal(files.includes(`${cacheKey(second)}.js`), false, 'the budget was exceeded')
})

test('a throw from the fetch does not claim to know it was the network', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-bundles-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const errors: string[] = []
  const cache = new ScriptCache({
    dir,
    // Whatever throws here reaches the same catch: the far side being
    // unreachable, and a fault in the adapter itself — the one part of this
    // module an injected upstream never exercises. "could not reach" would state
    // the first as fact, and someone chasing a CDN outage would never look at
    // our own code.
    fetchRemote: () => { throw new TypeError('cannot read properties of undefined') },
    onError: (error: Error) => { errors.push(error.message) },
  })

  const result = await cache.load(BUNDLE)
  assert.ok(!Buffer.isBuffer(result))
  assert.equal(result.status, 502)
  assert.match(result.reason, /threw \(TypeError/u, 'the message did not say what actually happened')
  assert.match(result.reason, /either the far side is unreachable/u)
  assert.match(result.reason, /fetch adapter faulted/u, 'the second reading was not named')
  assert.equal(result.reason.includes('could not reach'), false, 'the message still asserts a cause')
  assert.equal(errors.length, 1)
})

test('a stylesheet is served as CSS with its faces moved onto the route', async (t) => {
  /*
   * The second content this route serves. The measured sheet is shaped like
   * 人贩子物语's Tabler icons: the CSS comes back as JavaScript's content type
   * and the browser applies none of it, or it comes back as CSS with the faces
   * resolving against the route path — a 404 per glyph. Both halves are
   * asserted here, against the tabler URL the card actually requests.
   */
  const sheet = [
    '@font-face{font-family:"tabler-icons";',
    'src:url("fonts/tabler-icons.woff2?v0.0.1") format("woff2");}',
    '.ti-book::before{content:"\\eb15";}',
  ].join('')
  const { cache, asked } = await cacheIn(t, { [TABLER_CSS]: { status: 200, body: sheet } })

  const captured: { status: number, headers: Record<string, unknown>, body: string }[] = []
  const res = () => {
    const entry = { status: 0, headers: {} as Record<string, unknown>, body: '' }
    captured.push(entry)
    return {
      writeHead(status: number, headers: Record<string, unknown>) {
        entry.status = status
        entry.headers = headers
      },
      end(body?: Buffer) { entry.body = body?.toString('utf8') ?? '' },
    } as unknown as Parameters<ScriptCache['serve']>[1]
  }
  const req = (url: string) => ({ method: 'GET', url }) as Parameters<ScriptCache['serve']>[0]

  await cache.serve(req(`/x?url=${encodeURIComponent(TABLER_CSS)}`), res())

  assert.deepEqual(asked, [TABLER_CSS])
  assert.equal(captured[0]?.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(captured[0]?.headers['access-control-allow-origin'], '*', 'a stylesheet fetch from an opaque frame is CORS too')
  assert.ok(
    captured[0]?.body.includes('/iris/script-bundle?url='),
    'the face resolves against the route, not against it',
  )
  assert.ok(
    captured[0]?.body.includes(encodeURIComponent('https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/fonts/tabler-icons.woff2?v0.0.1')),
    'the face resolves against the upstream sheet',
  )
  assert.ok(captured[0]?.body.includes('content:'), 'the rule text itself is untouched')
})

test('a stylesheet reference off the allowlist is reported and left as written', async (t) => {
  const sheet = '@font-face{font-family:"x";src:url(https://fontsapi.zeoseven.com/292/result.woff2);}'
  const dir = await mkdtemp(join(tmpdir(), 'iris-bundles-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const reports: string[] = []
  const cache = new ScriptCache({
    dir,
    fetchRemote: upstream({ [TABLER_CSS]: { status: 200, body: sheet } }).fetch,
    onError: () => {},
    onReport: message => reports.push(message),
  })

  const captured: { status: number, headers: Record<string, unknown> }[] = []
  await cache.serve(
    { method: 'GET', url: `/x?url=${encodeURIComponent(TABLER_CSS)}` } as Parameters<ScriptCache['serve']>[0],
    (() => {
      const entry = { status: 0, headers: {} as Record<string, unknown> }
      captured.push(entry)
      return {
        writeHead(status: number, headers: Record<string, unknown>) { entry.status = status; entry.headers = headers },
        end() {},
      } as unknown as Parameters<ScriptCache['serve']>[1]
    })(),
  )

  assert.equal(captured[0]?.status, 200, 'the sheet itself is served')
  assert.equal(reports.length, 1)
  assert.match(reports[0] ?? '', /fontsapi\.zeoseven\.com/)
  assert.match(reports[0] ?? '', /not on the remote allowlist/)
})
