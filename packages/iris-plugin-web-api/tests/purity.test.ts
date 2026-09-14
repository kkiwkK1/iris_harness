import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The property this package exists for, pinned.
 *
 * It sits on the browser's import allowlist (`apps/iris/tests/
 * architecture.test.ts`) because it can drag nothing in behind it. That is a
 * claim about every future edit, not about today, so the test reads the
 * sources rather than trusting the manifest — a runtime import added to any
 * file here would silently widen what the browser can reach, and the manifest
 * would go on saying there is almost nothing to see.
 *
 * Modelled on `@iris/text`'s test of the same name, with this package's own
 * rule in place of that one: the Iris contract (`@iris/protocol`) may be
 * imported **as types only** — the snapshot type names the shape both sides
 * speak, and a type import is erased before a bundler or a loader sees it, so
 * the browser gains this module's bytes and nothing behind them. Anything
 * else non-relative, in any non-type position, is out of contract.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('this package imports nothing at runtime', async () => {
  const offenders: string[] = []
  const dir = join(ROOT, 'src')
  const files = (await readdir(dir)).filter(entry => entry.endsWith('.ts'))
  for (const entry of files) {
    const source = await readFile(join(dir, entry), 'utf8')
    // Erase every explicit type-only import and type re-export, then forbid
    // whatever remains from naming anything outside the package.
    const runtime = source
      .replace(/import\s+type\s+\{[^}]*\}\s+from\s+'[^']+'\n/g, '')
      .replace(/import\s+type\s+\w+\s+from\s+'[^']+'\n/g, '')
      .replace(/export\s+type\s+\{[^}]*\}\s+from\s+'[^']+'\n/g, '')
    for (const match of runtime.matchAll(/from\s+'([^']+)'/g)) {
      const target = match[1] as string
      // Relative imports within the package are the only imports allowed.
      if (!target.startsWith('./') && !target.startsWith('../')) offenders.push(`${entry}: ${target}`)
    }
  }
  assert.deepEqual(offenders, [])
  // A scan that found no files reports the same empty list as a clean package.
  assert.ok(files.length >= 1, `expected the contract sources, scanned ${String(files.length)}`)
})

test('manifest: the Iris contract is the only dependency, and no registry package is one', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  // No npm dependency at all: a registry fetch behind a browser import would
  // be a supply chain the allowlist never voted on.
  const nonIris = Object.keys(manifest.dependencies ?? {}).filter(
    name => !name.startsWith('@iris/'),
  )
  assert.deepEqual(nonIris, [])
  assert.equal(manifest.devDependencies, undefined)
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}).sort(),
    ['@iris/protocol'],
    'the contract is the one thing both sides import; nothing else of Iris may come along',
  )
})
