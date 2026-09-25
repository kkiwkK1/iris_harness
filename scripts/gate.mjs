/**
 * `pnpm gate`: run the CI job's steps locally, in order, and report each
 * step's own exit code.
 *
 * The steps are read from `.github/workflows/ci.yml` by
 * `scripts/lib/ci-steps.ts`, so this cannot drift from CI. It replaces the
 * old `verify` script, which ran two of CI's six checks and was called by
 * nothing.
 *
 * Every step runs, even after one fails, because a red check usually hides
 * more failures behind the first, and a run that stops at the first red makes
 * you pay one round trip per failure. `--bail` stops at the first failure
 * instead. The summary at the end is one line per step with its exit code,
 * ready to paste. The process exits 1 if any step failed. Read the exit
 * codes from here, not from a tail of the output: a `tail && echo ok`
 * pipeline reports the tail's exit code, and one branch here reported
 * success that way while tsc was failing (c32605d).
 *
 * The two install steps (`pnpm install --frozen-lockfile`, `npm ci`) are
 * skipped unless `--install` is passed. They are the CI runner's setup, they
 * take minutes, and offline they can fail for reasons unrelated to the change
 * under test. The skipped steps are listed in the summary so the report says
 * what was not run.
 *
 * Usage: `pnpm gate [--install] [--bail]`
 *
 * @module scripts/gate
 */

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readCiSteps } from './lib/ci-steps.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const args = new Set(process.argv.slice(2))
const install = args.has('--install')
const bail = args.has('--bail')

/**
 * Whether a step is the runner's dependency install.
 * @param {string} run - the step's command.
 * @returns {boolean} true for `pnpm install` and `npm ci`.
 */
function isInstall(run) {
  return /^(pnpm install|npm ci)\b/.test(run)
}

const steps = readCiSteps(ROOT)
if (steps.length === 0) {
  console.error('gate: read no steps from .github/workflows/ci.yml; the reader or the workflow changed')
  process.exit(1)
}

/** @type {{ name: string, code: number | 'skipped' | 'not run' }[]} */
const results = []
let failed = false
for (const step of steps) {
  if (!install && isInstall(step.run)) {
    results.push({ name: step.name, code: 'skipped' })
    continue
  }
  if (failed && bail) {
    results.push({ name: step.name, code: 'not run' })
    continue
  }
  const where = step.workingDirectory === '.' ? '' : ` (in ${step.workingDirectory})`
  const env = Object.entries(step.env).map(([key, value]) => `${key}=${value} `).join('')
  console.log(`\n=== gate: ${step.name}\n=== ${env}${step.run}${where}\n`)
  const outcome = spawnSync(step.run, {
    cwd: join(ROOT, step.workingDirectory),
    env: { ...process.env, ...step.env },
    shell: true,
    stdio: 'inherit',
  })
  const code = outcome.status ?? 1
  if (outcome.error !== undefined) console.error(`gate: could not start the step: ${outcome.error.message}`)
  if (code !== 0) failed = true
  results.push({ name: step.name, code })
}

console.log('\n=== gate summary (exit code per step, from ci.yml)')
for (const result of results) {
  console.log(`  ${String(result.code).padStart(7)}  ${result.name}`)
}
console.log(failed ? '=== gate: FAILED' : '=== gate: all run steps exited 0')
process.exit(failed ? 1 : 0)
