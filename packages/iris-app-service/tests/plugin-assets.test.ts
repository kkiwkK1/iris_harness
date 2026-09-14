import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { PluginAssetManifest } from '@iris/plugin-web-api'
import { PluginAssetStore, type PluginAssetState, type PluginAssetStateView } from '../src/plugin-assets.ts'

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
  const dir = await mkdtemp(join(tmpdir(), 'iris-plugins-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
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
