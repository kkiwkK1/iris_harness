/**
 * REVIEW-6's three runs, in one command, with the environment checked first.
 *
 * `notes/tasks/REVIEW-6-GREETING-FRAME-OSCILLATION.md` §2.4 names five possible
 * readings and §2.5 asks for one control. One run of the recorder answers the
 * first question (which curve moves) but not the two that matter more — "does
 * it settle" and "is the movement the frame's at all" — because the notice
 * banner that moves the band is *this card's own boot noise*, which appears and
 * clears on its own schedule. So the record is three runs of the same
 * instrument:
 *
 *   1. as-is, both the greeting and the reply-side frame (§2.3 + §2.5);
 *   2. the same greeting with every transient banner dismissed before the
 *      recorder arms — holds everything still except the notice region;
 *   3. the same greeting with the notice region kept empty **for the whole
 *      window** — the counterfactual. If the movement survives this, the banner
 *      reading is wrong and the record must say so.
 *
 * Everything lands in `qa/results/review6/` (gitignored). Not part of any build.
 *
 * Usage: node qa/review6-three-runs.mjs [--base http://127.0.0.1:8791] [--seconds 24]
 *
 * @module qa/review6-three-runs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const BASE = process.env.IRIS_BASE ?? 'http://127.0.0.1:8791'
const argv = process.argv.slice(2)
const value = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const SECONDS = value('--seconds', '24')
// `fileURLToPath`, not `.pathname`: this repository's path carries CJK segments
// and a leading slash before the drive letter, and a hand-rolled conversion of
// that is how a wrapper ends up spawning nothing and reporting a failed run.
const HERE = fileURLToPath(new URL('./review6-frame-oscillation.mjs', import.meta.url))

const RUNS = [
  // The manual's own path: a **new** conversation, created through the shell,
  // which is where REVIEW-2 saw anomaly B. Existing conversations of this card
  // are skipped by default: two of them share the title `创世回廊1.3`, so
  // addressing one by title is ambiguous and addressing one by id needs a
  // profile-specific id the record should not depend on.
  { label: 'run 1 — as-is, new conversation', flags: ['--new-only'] },
  { label: 'run 2 — banners cleared before arming', flags: ['--new-only', '--clear-banners'] },
  { label: 'run 3 — banners suppressed for the whole window', flags: ['--new-only', '--suppress-banners'] },
]

for (const run of RUNS) {
  console.log(`\n############ ${run.label}`)
  const child = spawn(process.execPath, [HERE, '--base', BASE, '--seconds', SECONDS, ...run.flags], { stdio: 'inherit' })
  const code = await new Promise(resolve => child.on('exit', resolve))
  if (code !== 0) {
    console.error(`\n############ ${run.label} exited ${String(code)} — stopping so a failed run is not read as a clean one`)
    process.exit(code ?? 1)
  }
  await delay(1000)
}
console.log('\nall three runs done; results -> qa/results/review6/')
