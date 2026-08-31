/**
 * Bundle and run `render-check.tsx`.
 *
 * esbuild rather than vite: this needs a Node-targeted CJS bundle (React's
 * server renderer `require`s `stream`, which an ESM bundle cannot shim), and
 * vite's build is configured for the browser. The `.css` loader is `empty`
 * because the borrowed primitives import their own stylesheets and a server
 * render has no use for them.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import { build } from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspacePackage = name => path.join(here, '..', '..', '..', 'packages', name, 'src', 'index.ts')

const out = await mkdtemp(path.join(tmpdir(), 'iris-render-'))
const bundle = path.join(out, 'render-check.cjs')

try {
  await build({
    entryPoints: [path.join(here, 'render-check.tsx')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    // The same two aliases vite.config.ts declares. Kept in step by hand; a
    // third alias appearing there without appearing here shows up as a resolve
    // error, not as a silent divergence.
    alias: {
      '@iris/protocol': workspacePackage('iris-protocol'),
      '@iris/client-fake': workspacePackage('iris-client-fake'),
    },
    logLevel: 'warning',
  })

  // The browser globals the render path reads before any effect runs. Deliberately
  // the bare minimum: anything more and the check starts proving that the stubs
  // work rather than that the app does.
  const stored = new Map()
  globalThis.window = {
    localStorage: {
      getItem: key => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => stored.set(key, value),
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.localStorage = globalThis.window.localStorage
  globalThis.matchMedia = globalThis.window.matchMedia
  globalThis.document = { documentElement: { style: { setProperty() {} }, setAttribute() {} } }

  createRequire(pathToFileURL(bundle))(bundle)
  assert.ok(true)
} finally {
  await rm(out, { recursive: true, force: true })
}
