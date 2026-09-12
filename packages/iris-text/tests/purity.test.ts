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
 * claim about every future edit, not about today, so the test reads the sources
 * rather than trusting the manifest — a stray import added to any file here
 * would silently widen what the browser can reach, and the manifest would go on
 * saying there are no dependencies.
 *
 * Modelled on `@iris/compat-tavernhelper-core`'s test of the same name, which
 * is the other package holding this contract. Two copies rather than a shared
 * helper on purpose: the helper would be an import, and the one thing neither
 * package may have is an import.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('this package imports nothing at all', async () => {
  const offenders: string[] = []
  const dir = join(ROOT, 'src')
  const files = (await readdir(dir)).filter(entry => entry.endsWith('.ts'))
  for (const entry of files) {
    const source = await readFile(join(dir, entry), 'utf8')
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const target = match[1] as string
      // Relative imports within the package are the only imports allowed.
      if (!target.startsWith('./') && !target.startsWith('../')) offenders.push(`${entry}: ${target}`)
    }
  }
  assert.deepEqual(offenders, [])
  // A scan that found no files reports the same empty list as a clean package.
  assert.ok(files.length >= 3, `expected the three sources, scanned ${String(files.length)}`)
})

test('manifest declares no dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: object, devDependencies?: object }
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
})
