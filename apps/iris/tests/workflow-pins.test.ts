import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every third-party action this repository's CI runs is pinned to a commit.
 *
 * A `uses: actions/checkout@v4` is a promise about a *name*, and the name is
 * writable by whoever owns the repository it points at: a major-version tag is
 * moved on every release, so what CI executes on the next push is whatever that
 * owner — or anyone who compromises them — last pointed the tag at. The commit
 * SHA is the only ref in GitHub Actions that cannot be repointed. That is audit
 * L-10 (`审计报告-网络安全工程.md` §5), the one finding of that audit whose other
 * half was a pass: this workflow carries no secret, runs `pull_request` rather
 * than `pull_request_target` and installs from frozen lockfiles, so the floating
 * tags were the last writable thing in it.
 *
 * Pinning is only half the job; the other half is that the pin stays. A
 * hand-maintained rule about a file nobody reads twice is a rule that lasts
 * until the first "quick bump", which is why this is an assertion rather than a
 * line in `CONTRIBUTING.md`. The `# vX.Y.Z` comment beside each SHA is required
 * too: a bare 40-hex ref is unreviewable, and the comment is what lets the next
 * person tell a routine bump from a substitution.
 *
 * The check is deliberately offline. Asking GitHub whether each SHA is still
 * the tip of its tag would turn a unit test into a network call with a rate
 * limit, and would go red for a reason that is not this repository's — the
 * property being pinned is "this ref cannot be moved under us", which is true
 * of any 40-hex commit whether or not a tag still points at it.
 */

// `fileURLToPath`, not `.pathname`: this repository's own path contains
// non-ASCII characters, which a URL percent-encodes.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const WORKFLOWS = join(ROOT, '.github', 'workflows')

/** A full commit SHA, and nothing shorter: an abbreviated ref is ambiguous. */
const FULL_SHA = /^[0-9a-f]{40}$/

interface Use {
  readonly file: string
  readonly line: number
  /** The whole value after `uses:`, comment stripped. */
  readonly spec: string
  /** Whatever followed the value on the same line, `#` included. */
  readonly comment: string
}

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
}

/**
 * Every `uses:` in a workflow, read as text.
 *
 * A line scan rather than a YAML parse, because this repository has no YAML
 * dependency and the shape being checked is a token in a line. The cost is that
 * a `uses:` inside a block scalar would be counted; there is none, and the
 * assertion below names each spec it saw, so one appearing would be visible
 * rather than silently tolerated.
 */
function uses(): Use[] {
  const found: Use[] = []
  for (const file of workflowFiles()) {
    const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/)
    lines.forEach((text, index) => {
      const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(text)
      if (match === null) return
      found.push({ file, line: index + 1, spec: match[1] ?? '', comment: (match[2] ?? '').trim() })
    })
  }
  return found
}

test('every action in .github/workflows is pinned to a full commit SHA', () => {
  const all = uses()

  // A floor, because the failure mode of a scan is an empty population: a
  // renamed directory, a changed extension filter or a regex that stopped
  // matching all produce zero finds and a green test. Three steps use an
  // action today (checkout, setup-node, pnpm/action-setup).
  assert.ok(all.length >= 3, `expected at least three action references, found ${all.length}`)

  const unpinned: string[] = []
  let checked = 0
  for (const use of all) {
    // A local action (`./.github/actions/x`) is this repository's own file and
    // has no ref to pin; a `docker://` reference is a different scheme. Neither
    // exists here — the count assertion below is what keeps that true, because
    // an exemption nobody exercises is also an exemption nobody notices being
    // exercised.
    if (use.spec.startsWith('./') || use.spec.startsWith('docker://')) continue
    checked += 1
    const at = use.spec.lastIndexOf('@')
    const ref = at === -1 ? '' : use.spec.slice(at + 1)
    if (!FULL_SHA.test(ref)) unpinned.push(`${use.file}:${use.line} ${use.spec}`)
  }

  assert.equal(
    checked,
    all.length,
    `expected every reference to be a third-party action, exempted ${all.length - checked}`,
  )
  assert.deepEqual(
    unpinned,
    [],
    `these action references are not pinned to a 40-hex commit SHA: ${unpinned.join('; ')}. ` +
      'Resolve with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`, dereferencing an annotated ' +
      'tag object through `git/tags/<sha>` to its commit.',
  )
})

test('every pinned action names the version it is', () => {
  const all = uses().filter(use => !use.spec.startsWith('./') && !use.spec.startsWith('docker://'))
  assert.ok(all.length >= 3, `expected at least three action references, found ${all.length}`)

  const unlabelled: string[] = []
  for (const use of all) {
    // `# v4.4.0`, or a `# v4.3.0 — …` that goes on to say why this one. What is
    // required is that a version number follows the hash, not that nothing else
    // does: one of these three pins is a deliberate departure from the newest
    // release of its major and the reason has to fit on the line.
    if (!/^#\s*v\d+\.\d+\.\d+/.test(use.comment)) unlabelled.push(`${use.file}:${use.line} ${use.spec}`)
  }

  assert.deepEqual(
    unlabelled,
    [],
    `these pins carry no '# vX.Y.Z' comment, so the SHA is unreviewable: ${unlabelled.join('; ')}`,
  )
})
