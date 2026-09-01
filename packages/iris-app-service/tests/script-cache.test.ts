import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { cacheKey, nodeFetch, ScriptCache, type FetchLike } from '../src/script-cache.ts'

/**
 * The host-side half of the remote-bundle proxy.
 *
 * Two things are being defended and they pull in opposite directions. The point
 * of the route is that a card's dependency loads fast; the point of the checks
 * is that the URL deciding what gets executed comes from the untrusted side. So
 * most of what follows is about refusals, and the one performance property —
 * fetch once — is asserted by counting requests rather than by timing anything.
 */

/** An upstream that answers from a table and counts what it was asked. */
function upstream(
  routes: Record<string, { status: number, body?: string, location?: string }>,
): { fetch: FetchLike, asked: string[] } {
  const asked: string[] = []
  const fetch: FetchLike = async (url) => {
    asked.push(url)
    const route = routes[url] ?? { status: 404 }
    return {
      status: route.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? route.location ?? null : null) },
      arrayBuffer: async () => {
        const bytes = Buffer.from(route.body ?? '', 'utf8')
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      },
    }
  }
  return { fetch, asked }
}

async function cacheIn(
  t: TestContext,
  routes: Record<string, { status: number, body?: string, location?: string }>,
  options: { maxBytes?: number, ttlSeconds?: number } = {},
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
  })
  return { cache, asked, dir, errors }
}

const BUNDLE = 'https://testingcf.jsdelivr.net/gh/some/repo@1.2.3/dist/bundle.js'

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
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.close() })
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${String(port)}`

  const redirected = await nodeFetch(`${base}/redir`, { redirect: 'manual', headers: { accept: '*/*' } })
  assert.equal(redirected.status, 302, 'the redirect was followed or hidden')
  assert.equal(redirected.headers.get('location'), '/target', 'the location header was not readable')

  const ok = await nodeFetch(`${base}/target`, { redirect: 'manual', headers: { accept: '*/*' } })
  assert.equal(ok.status, 200)
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString('utf8'), 'BODY-OK')

  // A dead socket must reject rather than resolve with something falsy, because
  // the caller turns a rejection into a named 502 and would otherwise report
  // success with an empty body.
  server.close()
  await assert.rejects(() => nodeFetch(`${base}/target`, { redirect: 'manual', headers: { accept: '*/*' } }))
})
