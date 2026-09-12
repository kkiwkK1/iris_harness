import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The property this package exists for, pinned.
 *
 * The contract sits below every consumer: the host implements it, the bundled
 * plugins are typed by it, and a future external plugin package will depend on
 * it, typed against the framework and the contract alone the way the
 * extension design's dependency rule (§2.1 of its contract document,
 * `docs/EXTENSIONS` on the `dev/feat-extension-system` branch) describes. What
 * makes that safe is that
 * the contract drags nothing in behind it — no domain package, no runtime code
 * at all. That is a claim about every future edit, not about today, so this
 * test reads the sources rather than trusting the manifest: a stray runtime
 * import added to any file here would widen what every plugin package reaches,
 * and the manifest would go on saying there is almost nothing to see.
 *
 * Modelled on `@iris/text`'s test of the same name. The rule is narrower here,
 * not identical: this package's one non-relative import is `@deepseek-ai/
 * cordis`, and it is allowed **as types only** — the activation scope hands a
 * plugin its host context, and a plugin is written against the framework, but
 * the contract itself executes nothing. `import type` is erased before any
 * loader sees the module, so the erasure is the whole difference between a
 * type dependency and a graph edge.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('this package imports nothing at runtime', async () => {
  const offenders: string[] = []
  const dir = join(ROOT, 'src')
  const files = (await readdir(dir)).filter(entry => entry.endsWith('.ts'))
  for (const entry of files) {
    const source = await readFile(join(dir, entry), 'utf8')
    // Erase every explicit type-only import and type re-export, then forbid
    // whatever remains from naming anything outside the package. A `type` on
    // every named specifier is the erasure this test exists to keep honest.
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

test('manifest: cordis is the only dependency, and nothing of it is ours', async () => {
  // The dependency list is the whole dependency policy for a package the
  // plugin ecosystem will be typed against: the framework's types, nothing
  // else, and never an `@iris/*` package — the contract must not learn what a
  // store is in order to say what a plugin is.
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), ['@deepseek-ai/cordis'])
  assert.equal(manifest.devDependencies, undefined)
})
