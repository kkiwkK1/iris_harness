import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Tests get their `IrisAppService` from `createTestService`, and the files
 * that still build it by hand are named here and can only leave.
 *
 * Measured on 2026-09-25 (origin/main dc5662d): 74 test files built the
 * service by hand, at 104 call sites. Each chose its own subset of the 44
 * options. Splitting `service.ts`, or reshaping its options, would turn all 74
 * red for a reason that is not a behaviour change, and that red looks the same
 * as the red of a lost guard. `tests/support/service.ts` is the one builder.
 * The files below predate it. Migrating one means deleting its line here.
 *
 * In the style of `apps/iris/tests/temp-dir-discipline.test.ts`: allowances
 * are named files, not a pattern, because a pattern quietly grows to cover the
 * next file. Three assertions, because they fail for different reasons:
 *
 *  1. a test file that constructs the service and is not named here is new
 *     hand assembly, so it should use the builder;
 *  2. a named file that no longer constructs the service has been migrated, so
 *     its line must be deleted, or the hole stays open for the next file under
 *     that name;
 *  3. the list is no longer than it was seeded, so the list only shrinks.
 *
 * The five scripts under `scripts/` that also assemble the service are outside
 * this rule. They are `.mjs` files, and whether they can import the builder
 * depends on `scripts/tsconfig.json`, which typechecks them.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The builder: the one file allowed to construct the service for tests. */
const BUILDER = 'packages/iris-app-service/tests/support/service.ts'

/**
 * Built from pieces so this file does not contain the text it looks for.
 * Otherwise it would have to allow itself.
 */
const CONSTRUCTS = ['new', 'IrisAppService('].join(' ')

/**
 * The seed: every test file that built the service by hand on 2026-09-25,
 * less `worldbook-delete.test.ts`, migrated in the same change that added the
 * builder. 73 files, plus four that landed on main between this list being
 * written and the list itself landing, each written before the rule existed:
 * `calibration-feed` and `chat-ownership` (#168), `chat-claim` (#172) and
 * `entity-lifecycle` (#175). 77 files. Those four moved to the builder in
 * the same change that took them off this list, which leaves 73.
 */
const allowed = new Set([
  'apps/iris/tests/live-generation-kinds.test.ts',
  'packages/iris-app-service/tests/assembly-determinism.test.ts',
  'packages/iris-app-service/tests/backups.test.ts',
  'packages/iris-app-service/tests/branch.test.ts',
  'packages/iris-app-service/tests/bridge.test.ts',
  'packages/iris-app-service/tests/cache-friendly-assembly.test.ts',
  'packages/iris-app-service/tests/cache-trace.test.ts',
  'packages/iris-app-service/tests/card-storage.test.ts',
  'packages/iris-app-service/tests/character-ops.test.ts',
  'packages/iris-app-service/tests/chat-integrity.test.ts',
  'packages/iris-app-service/tests/chat-order.test.ts',
  'packages/iris-app-service/tests/chat-resync.test.ts',
  'packages/iris-app-service/tests/chat-search.test.ts',
  'packages/iris-app-service/tests/chat-transfer.test.ts',
  'packages/iris-app-service/tests/chat-writes.test.ts',
  'packages/iris-app-service/tests/compaction-usage.test.ts',
  'packages/iris-app-service/tests/compaction.test.ts',
  'packages/iris-app-service/tests/config-wiring.test.ts',
  'packages/iris-app-service/tests/connections.test.ts',
  'packages/iris-app-service/tests/depth-bucket-entries.test.ts',
  'packages/iris-app-service/tests/diagnostics.test.ts',
  'packages/iris-app-service/tests/eval-template.test.ts',
  'packages/iris-app-service/tests/extension-settings-shapes.test.ts',
  'packages/iris-app-service/tests/floor-anchor.test.ts',
  'packages/iris-app-service/tests/floor-macros.test.ts',
  'packages/iris-app-service/tests/floor-read.test.ts',
  'packages/iris-app-service/tests/generation-kinds.test.ts',
  'packages/iris-app-service/tests/generation-timing.test.ts',
  'packages/iris-app-service/tests/helper-macros.test.ts',
  'packages/iris-app-service/tests/history-stability.test.ts',
  'packages/iris-app-service/tests/identity-messages.test.ts',
  'packages/iris-app-service/tests/initvar-seed.test.ts',
  'packages/iris-app-service/tests/injection.test.ts',
  'packages/iris-app-service/tests/itemize.test.ts',
  'packages/iris-app-service/tests/keys.test.ts',
  'packages/iris-app-service/tests/legacy-cleanup.test.ts',
  'packages/iris-app-service/tests/message-id-domain.test.ts',
  'packages/iris-app-service/tests/model-context.test.ts',
  'packages/iris-app-service/tests/mvu-init-members.test.ts',
  'packages/iris-app-service/tests/plugin-install-rpc.test.ts',
  'packages/iris-app-service/tests/preset-card-api.test.ts',
  'packages/iris-app-service/tests/preset-macros.test.ts',
  'packages/iris-app-service/tests/preset-manager.test.ts',
  'packages/iris-app-service/tests/preset-read.test.ts',
  'packages/iris-app-service/tests/preset-regex.test.ts',
  'packages/iris-app-service/tests/profiles.test.ts',
  'packages/iris-app-service/tests/prompt-fingerprint.test.ts',
  'packages/iris-app-service/tests/prune.test.ts',
  'packages/iris-app-service/tests/reads-do-not-write.test.ts',
  'packages/iris-app-service/tests/regex-store.test.ts',
  'packages/iris-app-service/tests/report-event.test.ts',
  'packages/iris-app-service/tests/reserve-budget.test.ts',
  'packages/iris-app-service/tests/route-resolution.test.ts',
  'packages/iris-app-service/tests/sandbox-plugins.test.ts',
  'packages/iris-app-service/tests/scoped-regex.test.ts',
  'packages/iris-app-service/tests/script-buttons.test.ts',
  'packages/iris-app-service/tests/script-fetch.test.ts',
  'packages/iris-app-service/tests/script-library.test.ts',
  'packages/iris-app-service/tests/scripts.test.ts',
  'packages/iris-app-service/tests/service.test.ts',
  'packages/iris-app-service/tests/settle-storage.test.ts',
  'packages/iris-app-service/tests/side-generate.test.ts',
  'packages/iris-app-service/tests/st-compat-floor-variables.test.ts',
  'packages/iris-app-service/tests/tavern-regex.test.ts',
  'packages/iris-app-service/tests/templates.test.ts',
  'packages/iris-app-service/tests/trace-id-prompt.test.ts',
  'packages/iris-app-service/tests/usage-record.test.ts',
  'packages/iris-app-service/tests/variable-addressing.test.ts',
  'packages/iris-app-service/tests/variable-arbitration.test.ts',
  'packages/iris-app-service/tests/variable-writers.test.ts',
  'packages/iris-app-service/tests/worldbook-charlore.test.ts',
  'packages/iris-app-service/tests/worldbook-source.test.ts',
  'packages/iris-app-service/tests/worldbook-timing.test.ts',
])

/**
 * The seeded size. Lower it in the commit that removes a line. Raising it
 * means adding hand assembly back, which is what this file exists to stop.
 */
const SEEDED = 73

/** Every source file under a test tree, as repo-relative POSIX paths. */
function testSources(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const child = posix.join(dir, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (/\.(mjs|cjs|js|ts|tsx)$/.test(entry.name)) found.push(child)
    }
  }
  for (const group of ['packages', 'apps']) {
    let entries
    try {
      entries = readdirSync(join(ROOT, group), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(posix.join(group, entry.name, 'tests'))
    }
  }
  walk('tests')
  return found.sort()
}

const files = testSources()
  .map(path => ({ path, text: readFileSync(join(ROOT, path.split(posix.sep).join(sep)), 'utf8') }))

test('a test file that builds the service by hand is on the allowance list', () => {
  // The walk must have reached the tree. A walk that returns nothing passes
  // every assertion below it. About 400 files lived here when this was written.
  assert.ok(files.length >= 300, `scanned only ${String(files.length)} test files; the walk is not reaching the tree`)

  // And the positive control: the builder exists and is itself found.
  const builder = files.find(file => file.path === BUILDER)
  assert.ok(builder !== undefined && builder.text.includes(CONSTRUCTS), `${BUILDER} is missing or no longer builds the service`)

  const offenders = files
    .filter(file => file.path !== BUILDER && !allowed.has(file.path))
    .filter(file => file.text.includes(CONSTRUCTS))
    .map(file => file.path)
  assert.deepEqual(offenders, [],
    `these tests build the service by hand:\n  ${offenders.join('\n  ')}\n`
    + `Take it from { createTestService } in ${BUILDER}, which fills in only the required options, `
    + 'so a later change to the service options is one edit there rather than one per file.')
})

test('every allowance names a file that still builds the service by hand', () => {
  const byPath = new Map(files.map(file => [file.path, file.text]))
  for (const path of allowed) {
    const text = byPath.get(path)
    assert.ok(text !== undefined, `allowance for ${path} names a file that is not under a test tree any more; delete the line`)
    assert.ok(text.includes(CONSTRUCTS), `${path} no longer builds the service by hand; delete its allowance and lower SEEDED`)
  }
})

test('the allowance list only shrinks', () => {
  assert.ok(allowed.size <= SEEDED,
    `${String(allowed.size)} allowances against a seed of ${String(SEEDED)}. A new file should use createTestService instead of joining the list`)
  assert.equal(allowed.size, SEEDED,
    `the list has ${String(allowed.size)} entries and SEEDED says ${String(SEEDED)}. Lower SEEDED in the commit that removed the line, so the ceiling follows the list down`)
})
