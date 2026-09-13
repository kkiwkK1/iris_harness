/**
 * The pilot acceptance host: the real composition, a fixed port, the built web
 * app, a temp profile, and the pilot's own scripted provider. Stays alive and
 * takes commands on stdin so the acceptance driver can step through the UCs.
 *
 * Run: `node notes/st-compat/acceptance/pilot-host.mjs`
 * (from the repository root, so `boot` resolves the workspace's cordis.yml)
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { boot } from '@deepseek-ai/dsh-app-boot'

process.env.IRIS_BASE_URL = process.env.PILOT_BASE_URL ?? 'http://127.0.0.1:1/v1'
process.env.IRIS_MODEL = 'pilot-model'
process.env.IRIS_PORT = process.env.PILOT_PORT ?? '8799'
process.env.IRIS_WEB_DIST = fileURLToPath(new URL('../../../apps/iris-web/dist/index.html', import.meta.url))

const dataDir = await mkdtemp(join(tmpdir(), 'iris-pilot-'))
process.env.IRIS_DATA_DIR = dataDir

const ctx = await boot('iris-pilot', fileURLToPath(new URL('../../../apps/iris/cordis.yml', import.meta.url)))
console.log(`PILOT-DATA_DIR=${dataDir}`)
console.log('PILOT-READY')

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  const text = line.trim()
  if (text === 'dispose') {
    void (async () => {
      await ctx.fiber.dispose()
      process.exit(0)
    })()
  }
})
