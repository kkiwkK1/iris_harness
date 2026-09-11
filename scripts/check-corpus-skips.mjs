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
 * not a CI-only mode nobody can reproduce. `IRIS_SAMPLES` is forced the same
 * way, for the one test that reads the gitignored sample folder rather than the
 * install — see the provenance list on {@link EXPECTED_SKIPPED}.
 *
 * @module scripts/check-corpus-skips
 */

import { spawn } from 'node:child_process'

/**
 * **Every** test that skips in this rehearsal, whatever gates it.
 *
 * The name says corpus, and for a long time the number counted corpus-gated
 * tests plus the two that skip without a provider key. That stopped being a
 * complete description when a third kind of gate arrived — the `IRIS_LIVE=1`
 * generation-kind tests count here as surely as a corpus test does while having
 * nothing to do with a corpus — so the sentence now says what the assertion
 * always was: the total. The grouped print below says which gate each skip
 * belongs to, so the next drift can be attributed without re-deriving it; the
 * **verdict** is still the one number, because a classifier that reads reason
 * prose is itself a probe, and a probe inside a verdict fails in the direction
 * nobody checks.
 *
 * Measured, not guessed. History: with the corpus present the suite skipped 2,
 * without it 16. 16 → 19 on the world book work (three new corpus tests
 * hardcoded the corpus path, ignored the rehearsal and ran against real data —
 * green here, 19 on CI, which is precisely the case a hand-maintained count
 * cannot notice on its own); 19 → 20 world book source choice; 20 → 21 MVU
 * listener premise guard; 21 → 22 global-selection acceptance; 22 → 23 JSON
 * Patch tag spelling; 23 → 24 real cards decode their embedded book; 24 → 25
 * schema-insert acceptance; 25 → 26 chat-search acceptance; 26 → 27 the
 * preset-library merge's gated test.
 *
 * 27 → 32, measured 2026-09-06 by listing every skip in the rehearsal and
 * reading each one's gate rather than by taking the difference (five is a gap
 * several different stories would have fitted equally well). The 32, by file:
 *
 * **Gated on `IRIS_CORPUS` (the SillyTavern install) — 26:**
 * - `packages/iris-app-service/tests/chat-search.test.ts` ×1 — the real 677-floor chat
 * - `packages/iris-app-service/tests/chat-transfer.test.ts` ×2 — every real chat imported and compared
 * - `packages/iris-app-service/tests/context.test.ts` ×2 — real cards' context fields and embedded books
 * - `packages/iris-app-service/tests/initvar-seed.test.ts` ×4 — one named real card (爱衣.png) and its chats
 * - `packages/iris-app-service/tests/itemize.test.ts` ×1 — one named real preset and card
 * - `packages/iris-app-service/tests/mvu-events.test.ts` ×1 — cards that listen for the end of an update
 * - `packages/iris-app-service/tests/mvu-storage.test.ts` ×2 — the longest real conversation round-trips
 * - `packages/iris-app-service/tests/script-variables.test.ts` ×3 — real cards' script data and button census
 * - `packages/iris-app-service/tests/library-summary.test.ts` ×1 — every real card lists with its three
 *   summary facts clipped and whole (added 2026-09-07 with the character-page facts)
 * - `packages/iris-app-service/tests/unit.test.ts` ×1 — every real filename is a usable id (**new to the
 *   count**: it hardcoded the install path until 2026-09-06 and so ran here while skipping on CI)
 * - `packages/iris-app-service/tests/worldbook-global.test.ts` ×1, `worldbook-source.test.ts` ×1,
 *   `worldbooks.test.ts` ×3 — real world books through the store
 * - `packages/iris-mvu/tests/json-patch.test.ts` ×1 — a real reply in the JSON Patch dialect
 * - `packages/iris-mvu/tests/json-patch-spelling.test.ts` ×1, `schema-insert.test.ts` ×1 — every real chat
 * - `packages/iris-preset/tests/chat-completion.test.ts` ×1 — every real preset
 * - `apps/iris-web/tests/tavern-helper.test.ts` ×1 — the installed Tavern Helper's manifest version
 *
 * **Gated on `IRIS_SAMPLES` (the gitignored `测试用卡/` folder) — 1:**
 * - `packages/iris-app-service/tests/preset-macros.test.ts` ×1 — the acceptance preset's three menu
 *   choices (**new to the count**: the folder is absent on CI and present here, so until the knob
 *   existed this ran in the rehearsal and skipped on CI)
 *
 * **Gated on `IRIS_LIVE=1` — 2:** `apps/iris/tests/live-generation-kinds.test.ts` (a real continue, a
 * real impersonate), from b64e2fb — a gate category this file had never counted before.
 *
 * **Gated on a provider key (`pnpm test:live`) — 2:** `apps/iris/tests/live-provider.test.ts`.
 *
 * The listing is the authority; the difference is not. Since 9751870 (where 27 was set) the tree
 * gained +2 chat-transfer cases (1fc2ffb), +2 IRIS_LIVE cases (b64e2fb) and +2 gates that now read
 * the forced variables — six, against a measured gap of five — so one of the 27 was a skip that no
 * longer exists or no longer skips, and the arithmetic of "what was added" would have put this
 * constant at 33 and been wrong. Update this number **only** after listing the skips again and
 * naming the one that moved.
 *
 * 33 → 34, 2026-09-10, and this one **is** named: `apps/iris-web/tests/upstream-context.test.ts`
 * ×1 — "the getContext surface is still the surface upstream returns", which re-extracts the 145
 * keys of `getContext()` from the installed SillyTavern's `public/scripts/st-context.js` and
 * compares them with `UPSTREAM_CONTEXT_MEMBERS`. Gated on `IRIS_CORPUS`, the same way
 * `tavern-helper.test.ts` gates the Tavern Helper manifest check, and its skip reason names
 * SillyTavern so it groups under `corpus` above. The file's other two tests read only this
 * repository and run everywhere.
 *
 * 34 → 35, 2026-09-10, and this one is a **new gate category**:
 * `apps/iris-web/tests/frame-bootstrap-live.test.ts` ×1 — "a card's first parse-time script
 * sees the bridge, and sees nothing when the bootstrap 404s", which drives a real Chrome over
 * CDP against three `srcdoc` frames built from the real assembly. Gated on `IRIS_BROWSER=1`,
 * and gated on the **flag** rather than on whether a browser is installed, deliberately: a
 * capability check would make this number a property of the machine, and the whole value of
 * pinning it is that it is not. With the flag set and no Chrome, or no `public/sandbox` build,
 * the test **fails** and says which — asking for a check and silently not getting it is the
 * outcome that file exists to prevent (§91).
 *
 * 35 → 39, 2026-09-11, the same gate and four tests of it:
 * `apps/iris/tests/shell-csp-live.test.ts` ×4 — the shell's Content-Security-Policy in a real
 * browser against a booted host. Two of the four are the reading that decided the policy (a
 * card frame still runs under the shipped one; it does **not** under the strict one the audit
 * asked for, against a control page carrying none), one is the click-jacking refusal, one is
 * the `connect-src 'self'` reading for a same-host WebSocket. Four rather than one because
 * each carries its own control and a single test would have hidden which half failed. Gated
 * on `IRIS_BROWSER=1` for the reason above, and failing rather than skipping when the flag is
 * set with no Chrome or no `apps/iris-web/dist`
 * (`notes/apps/iris-web/DEVIATIONS.md` §93).
 *
 * 39 → 40, 2026-09-11, and another **new gate category**:
 * `packages/iris-app-service/tests/key-at-rest.test.ts` ×1 — "DPAPI protects and unprotects a key
 * without putting it on a command line", the one test that really spawns a PowerShell and asks
 * Windows to wrap a (made-up) key. Gated on `IRIS_DPAPI=1` **and** `process.platform === 'win32'`,
 * so it skips in this rehearsal on every machine: on Linux for the platform, on Windows for the
 * flag. That is deliberate and is what keeps this number a property of the tree rather than of the
 * machine — the same reasoning `IRIS_BROWSER` above is gated by. The file's other 14 tests use an
 * injected fake protector and run everywhere (`notes/packages/iris-app-service/DEVIATIONS.md` §75).
 */
const EXPECTED_SKIPPED = 40

const GLOBS = ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts']

/** The gate each skip reason names, in the order the report prints them. */
const GATES = ['corpus', 'samples', 'IRIS_LIVE', 'IRIS_BROWSER', 'IRIS_DPAPI', 'provider key', 'unlabelled', 'other']

/**
 * Which gate a skip reason names.
 *
 * Display only — the verdict is the total. Everything unrecognised lands in
 * `other` rather than being forced into a bucket: a classifier that always finds
 * a home for every input cannot say it has met something new, which is the one
 * thing this grouping is for. A skip with no reason goes to `unlabelled`, **not**
 * to `corpus`: most of them were corpus tests, but "no reason given" is not
 * evidence of any gate, and the point of this print is to say where a drift
 * came from. (Every skip in the tree carries a reason as of 2026-09-06, so a
 * non-zero `unlabelled` is itself a regression worth reading.)
 * @param {string} reason - the text after `#` on the reporter's skip line; `SKIP` when there was none.
 * @returns {string} one of {@link GATES}.
 */
function gateOf(reason) {
  if (reason === 'SKIP' || reason === '') return 'unlabelled'
  if (/IRIS_LIVE/.test(reason)) return 'IRIS_LIVE'
  if (/IRIS_BROWSER/.test(reason)) return 'IRIS_BROWSER'
  if (/IRIS_DPAPI/.test(reason)) return 'IRIS_DPAPI'
  if (/test:live|provider key/.test(reason)) return 'provider key'
  if (/IRIS_SAMPLES/.test(reason)) return 'samples'
  if (/IRIS_CORPUS|corpus|Tavern Helper install|SillyTavern/i.test(reason)) return 'corpus'
  return 'other'
}

/**
 * Every skipped test in the reporter output, with the gate its reason names.
 *
 * The spec reporter prints a skipped test as `﹣ <name> (<ms>ms) # SKIP` when
 * the skip carried no reason and `﹣ <name> (<ms>ms) # <reason>` when it did —
 * the word `SKIP` is **replaced** by the reason, not followed by it, which is
 * why a grep for `# SKIP` finds only the unlabelled ones.
 * @param {string} output - the captured runner output.
 * @returns {{ name: string, reason: string, gate: string }[]} one entry per skipped test.
 */
function skipsIn(output) {
  const skips = []
  for (const line of output.split('\n')) {
    const match = /^\s*﹣ (.+?) \([\d.]+ms\) # (.*)$/u.exec(line)
    if (match === null) continue
    const reason = match[2].trim()
    skips.push({ name: match[1], reason, gate: gateOf(reason) })
  }
  return skips
}

/**
 * Print the skips grouped by gate, every group named even when empty.
 * @param {{ name: string, reason: string, gate: string }[]} skips - from {@link skipsIn}.
 * @param {(line: string) => void} write - where the lines go.
 */
function printGrouped(skips, write) {
  write('\ncheck-corpus-skips: skips by gate')
  for (const gate of GATES) {
    const members = skips.filter(skip => skip.gate === gate)
    write(`  ${gate}: ${String(members.length)}`)
    for (const skip of members) {
      write(`    - ${skip.name}${gate === 'other' || gate === 'unlabelled' ? `  [# ${skip.reason.slice(0, 100)}]` : ''}`)
    }
  }
}

const child = spawn(
  process.execPath,
  ['--test', ...GLOBS],
  {
    // Paths no filesystem will have. Every corpus gate is an `existsSync` on a
    // path built from one of these, so all of them take their absent branch.
    env: {
      ...process.env,
      IRIS_CORPUS: '/iris-corpus-that-does-not-exist',
      IRIS_SAMPLES: '/iris-samples-that-do-not-exist',
    },
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

  const skips = skipsIn(output)
  printGrouped(skips, line => console.log(line))
  if (skips.length !== skipped) {
    // The grouping is display, but a display that disagrees with the summary
    // it explains is worse than none: say so rather than print a confident
    // table beside a number it does not add up to.
    console.error(
      `\ncheck-corpus-skips: the summary says ${String(skipped)} skipped but ${String(skips.length)} skip lines were `
      + 'recognised; the reporter format changed, and the grouping above is not to be trusted',
    )
    process.exit(1)
  }

  if (skipped !== EXPECTED_SKIPPED) {
    console.error(
      `\ncheck-corpus-skips: expected ${String(EXPECTED_SKIPPED)} skipped without a corpus, saw ${String(skipped)}.\n`
      + 'More than expected: a test started skipping that used to run — look for a gate that now matches too much.\n'
      + 'Fewer than expected: a corpus test stopped skipping. If it now passes, check that it still asserts\n'
      + 'something — a guard that returns early instead of skipping reports as a pass and proves nothing.\n'
      + 'A count that moved in `IRIS_LIVE` or `provider key` is not corpus drift; read the groups above.',
    )
    process.exit(1)
  }
  console.log(`\ncheck-corpus-skips: ${String(skipped)} skipped, 0 failed, as expected with no corpus present.`)
})
