/**
 * Run the suite as a machine with no SillyTavern install would, and check the
 * shape of the result rather than only its exit code.
 *
 * A corpus-gated test has two honest outcomes when the corpus is absent: it
 * skips, or the whole suite fails. It has one dishonest outcome that neither
 * `npm test` nor a green CI badge can tell from success — **guarding by
 * returning early instead of skipping**, so the test reports as passed while
 * asserting nothing. That failure is invisible exactly where it matters, because
 * CI is the environment with no corpus.
 *
 * So this pins the skip count. A corpus test that quietly turns into a no-op
 * pass moves a number that is checked, and a new corpus test that forgets to
 * gate itself moves it the other way.
 *
 * `IRIS_CORPUS` is forced to a path that cannot exist, so the run is identical
 * on a developer's machine and on CI. That is the point: this is the rehearsal,
 * not a CI-only mode nobody can reproduce.
 *
 * @module scripts/check-corpus-skips
 */

import { spawn } from 'node:child_process'

/**
 * Tests that skip when there is no corpus, plus the two that skip without a
 * provider key.
 *
 * Measured, not guessed: with the corpus present the suite skips 2, without it
 * 16. Update this number **only** after checking which test moved and why — a
 * drift here is the signal, not the noise. It has already earned its keep once:
 * splitting one corpus test into two moved it from 15 to 16, and the check named
 * the drift before the change was reported as finished. It earned it a second
 * time on the world book work: three new corpus tests hardcoded the corpus path
 * instead of reading `IRIS_CORPUS`, so they ignored the rehearsal, ran against
 * real data, and left this number at 16 — green here and 19 on CI. The number
 * did not move because the gate was broken, which is precisely the case a
 * hand-maintained count cannot notice on its own. 19 → 20 with the world book
 * source-choice test, and 20 → 21 with the MVU listener premise guard; both are
 * gated the same way.
 */
const EXPECTED_SKIPPED = 21

const GLOBS = ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts']

const child = spawn(
  process.execPath,
  ['--test', ...GLOBS],
  {
    // A path no filesystem will have. Every corpus gate is an `existsSync` on a
    // path built from this, so all of them take their absent branch.
    env: { ...process.env, IRIS_CORPUS: '/iris-corpus-that-does-not-exist' },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
)

let output = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})

child.on('exit', (code) => {
  const read = (label) => {
    const match = output.match(new RegExp(`^. ${label} (\\d+)$`, 'm'))
    return match === null ? undefined : Number(match[1])
  }
  const failed = read('fail')
  const skipped = read('skipped')

  if (failed === undefined || skipped === undefined) {
    console.error('\ncheck-corpus-skips: could not read the summary; node:test output format changed')
    process.exit(1)
  }
  if (code !== 0 || failed > 0) {
    console.error(`\ncheck-corpus-skips: ${String(failed)} test(s) failed without a corpus`)
    process.exit(1)
  }
  if (skipped !== EXPECTED_SKIPPED) {
    console.error(
      `\ncheck-corpus-skips: expected ${String(EXPECTED_SKIPPED)} skipped without a corpus, saw ${String(skipped)}.\n`
      + 'More than expected: a test started skipping that used to run — look for a gate that now matches too much.\n'
      + 'Fewer than expected: a corpus test stopped skipping. If it now passes, check that it still asserts\n'
      + 'something — a guard that returns early instead of skipping reports as a pass and proves nothing.',
    )
    process.exit(1)
  }
  console.log(`\ncheck-corpus-skips: ${String(skipped)} skipped, 0 failed, as expected with no corpus present.`)
})
