/**
 * Boot the real host (`apps/iris/bin.ts`) on a test port and measure the time
 * from spawn until the HTTP server answers, three times.
 *
 * Safety rails, all deliberate:
 * - **Port 8799**, an explicit test port, never the live 8787/8790 row.
 * - **IRIS_DATA_DIR points at a fresh temp directory**, so the probe cannot
 *   touch the checkout's `data/`.
 * - The child is killed **by the PID this script holds** — no taskkill by
 *   name or port — and death is verified before the script reports.
 * - No generation is requested: the probe only waits for the server to
 *   answer `GET /version`, which the host answers without a provider.
 *
 * Usage:
 *   node notes/startup-probe.mjs
 *
 * @module notes/startup-probe
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 8799
const URL = `http://127.0.0.1:${String(PORT)}/version`
const BOOTS = 3
const ANSWER_TIMEOUT_MS = 30000

const dataDir = mkdtempSync(join(tmpdir(), 'iris-startup-probe-'))

async function waitUntilAnswering(child) {
  const started = performance.now()
  for (;;) {
    if (child.exitCode !== null) throw new Error(`host exited early with code ${String(child.exitCode)}`)
    if (performance.now() - started > ANSWER_TIMEOUT_MS) throw new Error('no answer within 30s')
    try {
      const response = await fetch(URL, { signal: AbortSignal.timeout(2000) })
      // Any HTTP response means the server is answering; the body is not read.
      await response.body?.cancel()
      return performance.now() - started
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
}

async function stop(child) {
  child.kill('SIGTERM')
  for (let waited = 0; waited < 5000; waited += 100) {
    if (child.exitCode !== null) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (child.exitCode === null) child.kill('SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 250))
}

const samples = []
for (let boot = 1; boot <= BOOTS; boot += 1) {
  const child = spawn(process.execPath, ['apps/iris/bin.ts'], {
    env: { ...process.env, IRIS_PORT: String(PORT), IRIS_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const ms = await waitUntilAnswering(child)
    samples.push(ms)
    console.log(`boot ${String(boot)}: ${ms.toFixed(0)}ms until ${URL} answered (pid ${String(child.pid)})`)
  } finally {
    await stop(child)
    if (child.exitCode === null && child.pid !== undefined) {
      try { process.kill(child.pid, 0); console.error(`pid ${String(child.pid)} STILL ALIVE`) } catch { /* dead, as required */ }
    }
  }
}

samples.sort((a, b) => a - b)
const median = samples[Math.floor(samples.length / 2)]
console.log(`\n${String(BOOTS)} boots, min ${samples[0]?.toFixed(0)}ms, median ${median.toFixed(0)}ms, max ${samples[samples.length - 1]?.toFixed(0)}ms`)

try {
  rmSync(dataDir, { recursive: true, force: true })
} catch {
  console.error(`note: temp data dir not removed: ${dataDir}`)
}
