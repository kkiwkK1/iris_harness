import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { IFRAME_EVENTS, MVU_EVENTS, TAVERN_EVENTS } from '../src/index.ts'

/**
 * The property this package exists for, pinned.
 *
 * It sits on the browser's import allowlist because it can drag nothing in
 * behind it. That is a claim about every future edit, not about today, so the
 * test reads the sources rather than trusting the manifest — a stray import
 * added to any file here would silently widen what the browser can reach.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

test('this package imports nothing at all', async () => {
  const offenders: string[] = []
  const dir = join(ROOT, 'src')
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith('.ts')) continue
    const source = await readFile(join(dir, entry), 'utf8')
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      const target = match[1] as string
      // Relative imports within the package are the only imports allowed.
      if (!target.startsWith('./') && !target.startsWith('../')) offenders.push(`${entry}: ${target}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('manifest declares no dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: object, devDependencies?: object }
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
})

test('the two documented traps are still armed', () => {
  // Upstream's one uppercase value and its camelCase neighbours. Normalizing
  // either would break real cards silently; these assertions make the break
  // loud instead.
  assert.equal(TAVERN_EVENTS.GENERATION_AFTER_COMMANDS, 'GENERATION_AFTER_COMMANDS')
  assert.equal(TAVERN_EVENTS.CHARACTER_DELETED, 'characterDeleted')
  assert.ok(Object.values(IFRAME_EVENTS).every(value => typeof value === 'string'))
  assert.ok(Object.values(MVU_EVENTS).every(value => typeof value === 'string'))
})
