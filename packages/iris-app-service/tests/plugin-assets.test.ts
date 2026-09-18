import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { PluginAssetManifest } from '@iris/plugin-web-api'
import { PluginAssetStore, type PluginAssetState, type PluginAssetStateView } from '../src/plugin-assets.ts'
import { tempDir } from './support/temp-dir.ts'

/**
 * The plugin-asset route: the aggregate manifest and the enabled plugin
 * bundles, served to an opaque-origin frame.
 *
 * What is asserted here mirrors `sandbox-assets.test.ts` on purpose — the two
 * routes carry the same three obligations (the CORS header the frame's
 * `crossorigin` tag needs on **every** answer, the containment checks, the
 * cache direction that fails toward revalidation) — plus the two that are
 * this route's own: the manifest is the enable state made fetchable, and a
 * disabled plugin's bundle stops answering with the same transition the RPC
 * face refuses stale incarnations on.
 */

/** A response that records what it was given. */
function capture(): {
  res: Parameters<PluginAssetStore['serve']>[1]
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
      headers = Object.fromEntries(
        Object.entries(given).map(([name, value]) => [name.toLowerCase(), value]),
      )
    },
    end(chunk?: unknown) { body = chunk },
  } as unknown as Parameters<PluginAssetStore['serve']>[1]
  return { res, status: () => status, headers: () => headers, body: () => body }
}

/** A request for one path under the route. */
function request(url: string, method = 'GET'): Parameters<PluginAssetStore['serve']>[0] {
  return { method, url } as Parameters<PluginAssetStore['serve']>[0]
}

/** The state the route reads: one revision, one enabled set. */
function state(revision: number, ...enabled: string[]): PluginAssetState {
  return { revision, enabled: new Set(enabled) }
}

/** A view over a state the test can change between requests. */
function flipper(initial: PluginAssetState | undefined): PluginAssetStateView & { set(next: PluginAssetState | undefined): void } {
  let current = initial
  return Object.assign(() => current, { set(next: PluginAssetState | undefined) { current = next } })
}

/** The sha1 12-hex rev this route computes, so the test states it, not approximates it. */
function revOf(bytes: string): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

/** An install directory with one plugin's client directory, plus a secret outside it. */
async function installDir(t: TestContext): Promise<string> {
  const dir = await tempDir(t, 'iris-plugins-')
  await mkdir(join(dir, 'demo', 'client'), { recursive: true })
  await mkdir(join(dir, 'other', 'client'), { recursive: true })
  await writeFile(join(dir, 'demo', 'client', 'client.js'), 'globalThis.demo = 1', 'utf8')
  await writeFile(join(dir, 'demo', 'client', 'client.js.map'), '{"version":3}', 'utf8')
  await writeFile(join(dir, 'other', 'client', 'client.js'), 'globalThis.other = 1', 'utf8')
  await writeFile(join(dir, 'secret.txt'), 'not for the frame', 'utf8')
  return dir
}

test('the manifest is the enable state made fetchable', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)

  const both = await store.manifest(state(4, 'demo', 'other', 'absent'))
  const expected: PluginAssetManifest = {
    revision: 4,
    plugins: {
      demo: { rev: revOf('globalThis.demo = 1'), client: `/plugins/demo/client.js?rev=${revOf('globalThis.demo = 1')}` },
      other: { rev: revOf('globalThis.other = 1'), client: `/plugins/other/client.js?rev=${revOf('globalThis.other = 1')}` },
    },
  }
  assert.deepEqual(both, expected)

  // The disabled row leaves with the state change, and the revision the runtime
  // already broadcasts through `plugins.changed` is the revision the manifest
  // carries — one number, one meaning, on both channels.
  const afterDisable = await store.manifest(state(5, 'demo'))
  assert.deepEqual(afterDisable, {
    revision: 5,
    plugins: { demo: expected.plugins['demo'] },
  })

  // No runtime at all is a state too: the manifest answers, empty, rather than
  // failing — a shell must be able to learn "there are no plugins".
  assert.deepEqual(await store.manifest(undefined), { revision: 0, plugins: {} })
})

test('the manifest is served as revalidated JSON with the frame headers', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const { res, status, headers, body } = capture()
  await store.serve(request('/plugins/manifest.json'), res, () => state(4, 'demo'))

  assert.equal(status(), 200)
  assert.equal(headers()['access-control-allow-origin'], '*')
  assert.equal(headers()['timing-allow-origin'], '*')
  assert.equal(headers()['vary'], 'Origin')
  assert.equal(headers()['content-type'], 'application/json; charset=utf-8')
  // The one fixed path whose bytes change with every enable and disable; the
  // sandbox manifest's "poisoned cache" note is the whole argument.
  assert.equal(headers()['cache-control'], 'no-cache')
  const parsed = JSON.parse(String(body())) as PluginAssetManifest
  assert.equal(parsed.revision, 4)
  assert.equal(parsed.plugins['demo']?.rev, revOf('globalThis.demo = 1'))
  assert.equal(headers()['content-length'], Buffer.byteLength(String(body())))
})

test('a bundle is served with the headers the frame needs', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const { res, status, headers, body } = capture()
  await store.serve(request('/plugins/demo/client.js'), res, () => state(4, 'demo'))

  assert.equal(status(), 200)
  assert.equal(headers()['access-control-allow-origin'], '*')
  assert.equal(headers()['timing-allow-origin'], '*')
  assert.equal(headers()['vary'], 'Origin')
  assert.equal(headers()['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(String(body()), 'globalThis.demo = 1')
  // No rev in the address, no promise about its bytes: revalidate.
  assert.equal(headers()['cache-control'], 'no-cache')
})

test('the rev query is the cache decision, and it fails toward revalidation', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const view = flipper(state(4, 'demo'))
  const rev = revOf('globalThis.demo = 1')

  const held = capture()
  await store.serve(request(`/plugins/demo/client.js?rev=${rev}`), held.res, view)
  // The address names the current bytes, so a held copy is correct by
  // construction — the same ground the sandbox route hashes names on.
  assert.equal(held.headers()['cache-control'], 'public, max-age=31536000, immutable')

  const stale = capture()
  await store.serve(request('/plugins/demo/client.js?rev=000000000000'), stale.res, view)
  assert.equal(stale.status(), 200)
  assert.equal(stale.headers()['cache-control'], 'no-cache', 'a rev the content has moved past must revalidate')

  // A map is served under the same rule and its own content type.
  const map = capture()
  await store.serve(request(`/plugins/demo/client.js.map?rev=${rev}`), map.res, view)
  assert.equal(map.status(), 200)
  assert.equal(map.headers()['content-type'], 'application/json; charset=utf-8')
  assert.equal(map.headers()['cache-control'], 'public, max-age=31536000, immutable')

  // Content moved: the old address loses its immutability — the memo is keyed
  // on the file's own (mtime, size), so a rewrite rehashes.
  await writeFile(join(dir, 'demo', 'client', 'client.js'), 'globalThis.demo = 2 // longer now', 'utf8')
  const moved = capture()
  await store.serve(request(`/plugins/demo/client.js?rev=${rev}`), moved.res, view)
  assert.equal(moved.headers()['cache-control'], 'no-cache', 'the old rev no longer names these bytes')
  const next = capture()
  await store.serve(request('/plugins/demo/client.js'), next.res, view)
  assert.equal(next.status(), 200)
  assert.equal(String(next.body()), 'globalThis.demo = 2 // longer now')
})

test('a disabled plugin has no URL, the same transition the RPC face refuses on', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const view = flipper(state(4, 'demo'))

  const before = capture()
  await store.serve(request('/plugins/demo/client.js'), before.res, view)
  assert.equal(before.status(), 200)

  view.set(state(5))
  const manifest = capture()
  await store.serve(request('/plugins/manifest.json'), manifest.res, view)
  assert.deepEqual((JSON.parse(String(manifest.body())) as PluginAssetManifest).plugins, {})

  const bundle = capture()
  await store.serve(request('/plugins/demo/client.js'), bundle.res, view)
  assert.equal(bundle.status(), 404, 'a frame holding the pre-disable manifest must find the old address dead')
  assert.equal(bundle.body(), undefined)

  // No runtime is the same refusal, not an error: nothing is enabled.
  view.set(undefined)
  const none = capture()
  await store.serve(request('/plugins/demo/client.js'), none.res, view)
  assert.equal(none.status(), 404)
})

test('unknown shapes answer 404, and every answer carries the CORS trio', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const view = flipper(state(4, 'demo'))

  const cases: [string, string, number][] = [
    ['an unknown plugin', '/plugins/nobody/client.js', 404],
    ['a file the route never serves', '/plugins/demo/other.js', 404],
    ['the bare prefix', '/plugins/', 404],
    ['a normalized escape', '/plugins/../secret.txt', 404],
    ['a nested normalized escape', '/plugins/demo/../../secret.txt', 404],
    ['an encoded-slash escape', '/plugins/..%2fsecret.txt', 404],
    ['an encoded-separator id', '/plugins/a%2f..%2f..%2fsecret/client.js', 404],
    ['the dot directory', '/plugins/../client.js', 404],
  ]
  for (const [what, url, expected] of cases) {
    const { res, status, headers, body } = capture()
    await store.serve(request(url), res, view)
    assert.equal(status(), expected, `${what} was not refused`)
    // A route whose CORS behaviour depends on the outcome is a route where
    // what failure looks like depends on who is asking.
    assert.equal(headers()['access-control-allow-origin'], '*', `${what} answered without the header`)
    assert.equal(headers()['timing-allow-origin'], '*', `${what} answered without timing access`)
    assert.equal(headers()['vary'], 'Origin', `${what} answered without the vary net`)
    assert.equal(body(), undefined, `${what} returned a body`)
  }

  const post = capture()
  await store.serve(request('/plugins/manifest.json', 'POST'), post.res, view)
  assert.equal(post.status(), 405)
  assert.equal(post.headers()['access-control-allow-origin'], '*')
  assert.equal(post.headers()['allow'], 'GET, HEAD')
})

test('a HEAD asks the same question and gets no body', async (t) => {
  const dir = await installDir(t)
  const store = new PluginAssetStore(dir)
  const { res, status, headers, body } = capture()
  await store.serve(request('/plugins/demo/client.js', 'HEAD'), res, () => state(4, 'demo'))

  assert.equal(status(), 200)
  assert.equal(headers()['content-length'], 19)
  assert.equal(body(), undefined)
})

// --- bundled copy: the third asset shape (U5) --------------------------------

/** An install directory that also carries one plugin's copy tables. */
async function copyInstallDir(t: TestContext): Promise<string> {
  const dir = await installDir(t)
  await mkdir(join(dir, 'demo', 'i18n'), { recursive: true })
  await writeFile(join(dir, 'demo', 'i18n', 'en.json'), '{"panelTitle":"Panel {name}","send":"Send"}', 'utf8')
  await writeFile(join(dir, 'demo', 'i18n', 'zh.json'), '{"panelTitle":"面板 {name}","send":"发送"}', 'utf8')
  return dir
}

test('a copy-only plugin gets a manifest row without a client URL', async (t) => {
  const dir = await installDir(t)
  // "other" loses its bundle but keeps a copy: the row survives, client-less.
  await mkdir(join(dir, 'other', 'i18n'), { recursive: true })
  await writeFile(join(dir, 'other', 'i18n', 'en.json'), '{"name":"Other"}', 'utf8')
  await writeFile(join(dir, 'other', 'i18n', 'zh.json'), '{"name":"另一个"}', 'utf8')
  await rm(join(dir, 'other', 'client', 'client.js'))

  const store = new PluginAssetStore(dir)
  const manifest = await store.manifest(state(7, 'other'))
  const entry = manifest.plugins['other']
  assert.ok(entry !== undefined, 'a copy-only plugin must still get a row')
  assert.equal(entry.client, undefined)
  assert.match(entry.i18n?.['en'] ?? '', /^\/plugins\/other\/i18n\/en\.json\?rev=[0-9a-f]{12}$/)
  assert.match(entry.i18n?.['zh'] ?? '', /^\/plugins\/other\/i18n\/zh\.json\?rev=[0-9a-f]{12}$/)
})

test('a half-published copy is no copy: the row falls back, all-or-nothing', async (t) => {
  const dir = await copyInstallDir(t)
  await rm(join(dir, 'demo', 'i18n', 'zh.json'))

  const store = new PluginAssetStore(dir)
  const manifest = await store.manifest(state(7, 'demo'))
  const entry = manifest.plugins['demo']
  // The bundle keeps the row alive; the copy tables are withheld whole, so no
  // reader lands on the overlay's key-name fallback from a half-published copy.
  assert.ok(entry !== undefined)
  assert.ok(entry.client !== undefined)
  assert.equal(entry.i18n, undefined)
})

test('a copy file serves under the bundle gates, with its own rev (U5 T4 inside)', async (t) => {
  const dir = await copyInstallDir(t)
  const store = new PluginAssetStore(dir)
  const zhBytes = '{"panelTitle":"面板 {name}","send":"发送"}'
  const zhRev = revOf(zhBytes)
  const view = flipper(state(7, 'demo'))

  const revved = capture()
  await store.serve(request(`/plugins/demo/i18n/zh.json?rev=${zhRev}`), revved.res, view)
  assert.equal(revved.status(), 200)
  assert.equal(revved.headers()['content-type'], 'application/json; charset=utf-8')
  assert.equal(revved.headers()['cache-control'], 'public, max-age=31536000, immutable')

  const unrevved = capture()
  await store.serve(request('/plugins/demo/i18n/zh.json'), unrevved.res, view)
  assert.equal(unrevved.status(), 200)
  assert.equal(unrevved.headers()['cache-control'], 'no-cache', 'a copy URL without its own rev revalidates')

  // Language names are matched verbatim against PLUGIN_COPY_LANGUAGES: an
  // unknown language, a non-language name, or a climb is a 404, not a read.
  for (const url of [
    '/plugins/demo/i18n/fr.json',
    '/plugins/demo/i18n/json',
    '/plugins/demo/i18n/..%2Fsecret.txt',
    '/plugins/secret.txt/i18n/en.json',
  ]) {
    const refused = capture()
    await store.serve(request(url), refused.res, view)
    assert.equal(refused.status(), 404, url)
    assert.deepEqual(refused.body(), undefined)
  }

  // A disabled plugin's copy stops answering, the same transition the bundle
  // answers to — one gate, both asset shapes.
  view.set(state(8))
  const disabled = capture()
  await store.serve(request(`/plugins/demo/i18n/zh.json?rev=${zhRev}`), disabled.res, view)
  assert.equal(disabled.status(), 404, 'a disabled plugin serves no copy')

  // And the manifest's row is gone with the same state change.
  const manifest = await store.manifest(state(8))
  assert.equal(manifest.plugins['demo'], undefined)
})

test('one file, one rev: rewriting zh leaves the en address alone', async (t) => {
  const dir = await copyInstallDir(t)
  const store = new PluginAssetStore(dir)

  const before = await store.manifest(state(1, 'demo'))
  const beforeEn = before.plugins['demo']!.i18n!['en']

  await writeFile(join(dir, 'demo', 'i18n', 'zh.json'), '{"panelTitle":"面板（新）","send":"发送"}', 'utf8')
  const after = await store.manifest(state(1, 'demo'))
  const afterEn = after.plugins['demo']!.i18n!['en']
  const afterZh = after.plugins['demo']!.i18n!['zh']

  assert.equal(afterEn, beforeEn, 'unchanged bytes keep their address — the cache holds')
  assert.notEqual(afterZh, before.plugins['demo']!.i18n!['zh'], 'changed bytes change address')
})

test('the host manifest survives the wire parser with its copy intact (U5 T10)', async (t) => {
  // The seam the task sheet warns about: the host writes JSON, the shell
  // parses JSON, and both parsers rebuild rows field by field — so only an
  // end-to-end assertion over the actual bytes catches a field dropped in
  // between. Each side green alone proves nothing about the pair.
  const dir = await copyInstallDir(t)
  const store = new PluginAssetStore(dir)
  const body = JSON.stringify(await store.manifest(state(9, 'demo')))

  const { parsePluginAssetManifest } = await import('@iris/plugin-web-api')
  const parsed = parsePluginAssetManifest(body)
  assert.ok(typeof parsed !== 'string', 'the host manifest must parse')
  if (typeof parsed === 'string') return
  const entry = parsed.plugins['demo']
  assert.ok(entry !== undefined)
  assert.ok(entry.client !== undefined)
  assert.match(entry.i18n?.['zh'] ?? '', /^\/plugins\/demo\/i18n\/zh\.json\?rev=[0-9a-f]{12}$/)

  // And the copy-only shape round-trips too: client absent is client absent.
  const copyOnly = { revision: 1, plugins: { solo: { rev: 'a'.repeat(12), i18n: { en: '/plugins/solo/i18n/en.json?rev=' + 'b'.repeat(12), zh: '/plugins/solo/i18n/zh.json?rev=' + 'c'.repeat(12) } } } }
  const soloParsed = parsePluginAssetManifest(JSON.stringify(copyOnly))
  assert.ok(typeof soloParsed !== 'string', 'the copy-only manifest must parse')
  if (typeof soloParsed === 'string') return
  assert.equal(soloParsed.plugins['solo']!.client, undefined)
  assert.ok(soloParsed.plugins['solo']!.i18n !== undefined)
})
