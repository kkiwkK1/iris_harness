import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'

import { removeTempDir, tempDirOwned } from '../../../packages/iris-app-service/tests/support/temp-dir.ts'

/**
 * The retired `IRIS_TEMPLATES`, migrated by the product's own composition.
 *
 * The runtime-level rules (seed only a row the file does not hold, never
 * override a stored one, the notice's wording) are pinned in
 * `packages/iris-app-service/tests/template-engine-plugin.test.ts`. What only a
 * boot can show is that the real `cordis.yml` still hands the variable to the
 * app row and that `index.ts` turns it into the runtime's default: a profile
 * from before this build — a catalog holding only TH and MVU — booted with
 * `IRIS_TEMPLATES=1` comes up with the engine row enabled and stored.
 */

let ctx: Context
let dataDir: string

before(async () => {
  // `tempDirOwned`, not `tempDir`: a file-level `before` has no test context,
  // and the booted host runs out of this directory until the `after` below.
  dataDir = await tempDirOwned('iris-templates-env-')
  await mkdir(join(dataDir, 'default-user'), { recursive: true })
  await writeFile(join(dataDir, 'default-user', 'system-plugins.json'), JSON.stringify({
    version: 2,
    revision: 3,
    plugins: {
      'tavern-helper': { installed: true, enabled: true, source: 'builtin' },
      mvu: { installed: true, enabled: true, source: 'builtin' },
    },
  }), 'utf8')
  process.env.IRIS_DATA_DIR = dataDir
  process.env.IRIS_PORT = '0'
  process.env.IRIS_TEMPLATES = '1'
  delete process.env.IRIS_WEB_DIST
  ctx = await boot('iris-templates-env', fileURLToPath(new URL('../cordis.yml', import.meta.url)))
})

after(async () => {
  await ctx.fiber.dispose()
  await removeTempDir(dataDir)
})

test('IRIS_TEMPLATES=1 on an existing profile seeds the engine row enabled through the real composition', async () => {
  const stored = JSON.parse(await readFile(join(dataDir, 'default-user', 'system-plugins.json'), 'utf8')) as {
    plugins: Record<string, { installed: boolean, enabled: boolean, source?: string }>
  }
  assert.deepEqual(stored.plugins['iris-templates'], { installed: true, enabled: true, source: 'builtin' },
    'an operator who ran with IRIS_TEMPLATES=1 lost the engine on the upgrade boot')
  // The rows the operator already had are untouched.
  assert.equal(stored.plugins['tavern-helper']?.enabled, true)
  assert.equal(stored.plugins['mvu']?.enabled, true)
})
