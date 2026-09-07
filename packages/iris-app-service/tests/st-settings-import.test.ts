import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { SettingsStore } from '../src/settings.ts'
import { StInstall } from '../src/st-install.ts'
import {
  DEFAULT_WORLDBOOK_SETTINGS, IMPORTED_WORLDBOOK_KEYS, importWorldbookSettings,
} from '../src/worldbook-settings.ts'

/**
 * A brand-new profile takes its world-info scan knobs from the user's install.
 *
 * A migration convenience, and only that: it fires on the **first creation** of
 * a profile's `settings.json` and never again, so a user who then changes a
 * knob here keeps their change however the installation is configured
 * afterwards. `DEVIATIONS.md` §21 carries the reasoning; these tests carry the
 * three properties it rests on — first-run only, per-key fallback, and no
 * second read.
 *
 * Every value written into the fixtures below **differs from Iris's own
 * default** on purpose. An import that silently did nothing would still produce
 * a complete, plausible knob table, so a fixture agreeing with the defaults
 * would pass against no implementation at all.
 */

/** ST's settings.json as a current install writes it: the family nested. */
const NESTED = {
  world_info_settings: {
    world_info: { globalSelect: ['a book'] },
    world_info_depth: 9,
    world_info_budget: 100,
    world_info_budget_cap: 4096,
    world_info_min_activations: 3,
    world_info_min_activations_depth_max: 40,
    world_info_max_recursion_steps: 5,
    world_info_recursive: true,
    world_info_case_sensitive: true,
    world_info_match_whole_words: true,
    world_info_use_group_scoring: true,
    world_info_include_names: false,
    world_info_character_strategy: 2,
    // Modelled by nothing here, so it must not appear in the profile and must
    // not be reported either — it is not a failure, it is out of scope.
    world_info_overflow_alert: true,
  },
}

/** What {@link NESTED} must land as, once translated into this host's vocabulary. */
const NESTED_AS_IRIS = {
  scanDepth: 9,
  budgetPercent: 100,
  budgetCap: 4096,
  minActivations: 3,
  minActivationsDepthMax: 40,
  maxRecursionSteps: 5,
  recursive: true,
  caseSensitive: true,
  matchWholeWords: true,
  useGroupScoring: true,
  includeNames: false,
  // `2` is the numeric enum's `global_first` (`world-info.js:27-31`).
  insertionStrategy: 'global_first',
}

/** A fake install and a fresh profile directory, both removed with the test. */
async function fixture(t: TestContext, settings?: unknown): Promise<{
  install: string
  profile: string
  st: StInstall
  store: () => SettingsStore
}> {
  const install = await mkdtemp(join(tmpdir(), 'iris-st-import-'))
  const profile = await mkdtemp(join(tmpdir(), 'iris-profile-import-'))
  t.after(async () => {
    await rm(install, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true })
  })
  if (settings !== undefined) {
    await writeFile(join(install, 'settings.json'), JSON.stringify(settings), 'utf8')
  }
  return {
    install,
    profile,
    st: new StInstall(install),
    // A function, not a value: the "second start" tests need a second store
    // reading the same file, which is what a restart actually is.
    store: () => new SettingsStore(join(profile, 'settings.json'), { provider: 'test', model: 'm' }),
  }
}

test('a first-run profile adopts every modelled knob from the install', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const settings = store()
  await settings.load()

  const reports = await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  assert.deepEqual(reports, [], 'a well-formed install should report nothing')
  const effective = settings.worldbookSettings()
  for (const [field, expected] of Object.entries(NESTED_AS_IRIS)) {
    assert.deepEqual(
      effective[field as keyof typeof effective], expected,
      `${field} did not come from the install`,
    )
  }
  // The floor: a loop that compared nothing would also report no mismatch.
  assert.equal(Object.keys(NESTED_AS_IRIS).length, Object.keys(DEFAULT_WORLDBOOK_SETTINGS).length)
})

test('every knob this host models has an ST key to import from', () => {
  // The invariant, not a count: a knob added to `WorldbookSettings` without a
  // key here would import as its default while the profile reads as "seeded
  // from your install", and nothing else in the suite can see that.
  assert.deepEqual(
    Object.keys(IMPORTED_WORLDBOOK_KEYS).sort(),
    Object.keys(DEFAULT_WORLDBOOK_SETTINGS).sort(),
  )
})

test('the import is written to the profile, not just answered', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const settings = store()
  await settings.load()
  await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  // Answered-but-not-persisted would pass every in-memory assertion above and
  // still lose the whole migration at the next restart.
  const reopened = store()
  await reopened.load()
  assert.equal(reopened.worldbookSettings().scanDepth, 9)
  assert.equal(reopened.worldbookSettings().insertionStrategy, 'global_first')
})

test('one bad value falls back to that knob alone, and says so', async (t) => {
  const { st, store } = await fixture(t, {
    world_info_settings: {
      // Upstream would take these: `Number('deep')` is `NaN` and
      // `Boolean('false')` is `true`, and it gets away with it because the
      // result lives in a module variable. Stored into a profile, a `NaN` scan
      // depth would outlive the mistake.
      world_info_depth: 'deep',
      world_info_recursive: 'false',
      world_info_character_strategy: 7,
      world_info_budget: 100,
    },
  })
  const settings = store()
  await settings.load()

  const reports = await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  const effective = settings.worldbookSettings()
  assert.equal(effective.scanDepth, DEFAULT_WORLDBOOK_SETTINGS.scanDepth)
  assert.equal(effective.recursive, DEFAULT_WORLDBOOK_SETTINGS.recursive)
  assert.equal(effective.insertionStrategy, DEFAULT_WORLDBOOK_SETTINGS.insertionStrategy)
  // The one good key in the file still landed: a per-key fallback, not a
  // whole-file refusal.
  assert.equal(effective.budgetPercent, 100)

  assert.equal(reports.length, 3, `expected one line per bad key, got ${JSON.stringify(reports)}`)
  assert.ok(reports.some(line => line.startsWith('world_info_depth is "deep"')), reports.join(' | '))
  assert.ok(reports.some(line => line.startsWith('world_info_recursive is "false"')), reports.join(' | '))
  assert.ok(
    reports.some(line => line.startsWith('world_info_character_strategy is 7')),
    reports.join(' | '),
  )
  for (const line of reports) assert.match(line, /keeps its default/)
})

test('a key this host does not model is neither imported nor reported', async (t) => {
  const { profile, st, store } = await fixture(t, {
    world_info_settings: { world_info_overflow_alert: true, world_info_depth: 9 },
  })
  const settings = store()
  await settings.load()

  const reports = await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  assert.deepEqual(reports, [], 'overflow_alert has no field here; that is not a failure')
  // Read off the file rather than through `worldbookSettings()`, which can only
  // answer with fields the type has: an unmodelled key smuggled into storage
  // would be invisible to every typed read and would then reach the panel.
  const stored = await readFile(join(profile, 'settings.json'), 'utf8')
  assert.match(stored, /"scanDepth": 9/, 'the modelled key beside it did not import')
  assert.ok(!stored.includes('overflow'), stored)
})

test('a second seed on the same store asks the install nothing', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const settings = store()
  await settings.load()
  await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  let asked = false
  const reports = await settings.seedWorldbookSettings(async () => {
    asked = true
    return await st.worldInfoSettings()
  })

  // "At most once, ever" is the contract the docstring states; without it a
  // second boot path or a retry would reopen someone else's settings file.
  assert.equal(asked, false)
  assert.deepEqual(reports, [])
})

test('the global book selection is not imported, even though it sits in the same section', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const settings = store()
  await settings.load()
  await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  // `world_info.globalSelect` is a *selection*, not a scan knob: adopting it
  // would make this host's prompts depend on what the other application has
  // selected right now. `SettingsStore.setGlobalSelect`'s docstring is the
  // standing decision; this pins that the scan-knob import did not quietly
  // reverse it.
  assert.deepEqual(settings.globalSelect(), [])
})

test('a second start does not re-read the install, let alone overwrite a change', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const first = store()
  await first.load()
  await first.seedWorldbookSettings(() => st.worldInfoSettings())
  await first.setWorldbookSettings({ scanDepth: 33 })

  const second = store()
  await second.load()
  let asked = false
  const reports = await second.seedWorldbookSettings(async () => {
    asked = true
    return await st.worldInfoSettings()
  })

  assert.equal(asked, false, 'an existing profile opened the installation’s settings.json')
  assert.deepEqual(reports, [])
  assert.equal(second.worldbookSettings().scanDepth, 33, 'the user’s own value was overwritten')
  // And the rest of the seeded table survived the user's one-field patch.
  assert.equal(second.worldbookSettings().insertionStrategy, 'global_first')
})

test('seeding before load imports nothing, rather than seeding over a file it has not read', async (t) => {
  const { st, store } = await fixture(t, NESTED)
  const settings = store()

  let asked = false
  const reports = await settings.seedWorldbookSettings(async () => {
    asked = true
    return await st.worldInfoSettings()
  })

  // The fail-safe direction: a caller that seeds before loading loses the
  // convenience, not the user's settings.
  assert.equal(asked, false)
  assert.deepEqual(reports, [])
  assert.equal(settings.worldbookSettings().scanDepth, DEFAULT_WORLDBOOK_SETTINGS.scanDepth)
})

test('an install with no settings.json reports the miss instead of a clean default table', async (t) => {
  const { st, store } = await fixture(t)
  const settings = store()
  await settings.load()

  const reports = await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  // "Could not read it" and "the user runs the defaults" produce the same knob
  // table and are different facts; only one of them means the migration did not
  // happen.
  assert.equal(reports.length, 1, reports.join(' | '))
  assert.match(reports[0] ?? '', /could not be read/)
  assert.deepEqual(settings.worldbookSettings(), DEFAULT_WORLDBOOK_SETTINGS)
})

test('a half-written settings.json is reported as unparsable, not as absent', async (t) => {
  const { install, st, store } = await fixture(t)
  await writeFile(join(install, 'settings.json'), '{"world_info_settings": {', 'utf8')
  const settings = store()
  await settings.load()

  const reports = await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  assert.equal(reports.length, 1, reports.join(' | '))
  assert.match(reports[0] ?? '', /not valid JSON/)
})

test('no install configured says nothing at all', async (t) => {
  const { store } = await fixture(t)
  const settings = store()
  await settings.load()

  // Nothing was looked for, so there is nothing to report. The other two
  // "nothing" cases have a sentence precisely because something was.
  const reports = await settings.seedWorldbookSettings(() => new StInstall().worldInfoSettings())
  assert.deepEqual(reports, [])
})

test('the flat pre-migration layout is read too', () => {
  // `script.js:7954` — `setWorldInfoSettings(settings.world_info_settings ??
  // settings, data)`. An older install keeps the family at the top level, and
  // reading only the nested shape would import nothing from it and report a
  // clean "nothing to take".
  const { settings, reports } = importWorldbookSettings({ world_info_depth: 9, world_info_include_names: false })

  assert.deepEqual(reports, [])
  assert.deepEqual(settings, { scanDepth: 9, includeNames: false })
})

test('a settings.json that is not an object is refused whole, with a sentence', () => {
  for (const shape of [null, 42, 'settings', [1, 2]]) {
    const { settings, reports } = importWorldbookSettings(shape)
    if (Array.isArray(shape)) {
      // An array *is* an object, so it takes the ordinary path and simply
      // carries none of the keys. Asserted rather than assumed: the branch a
      // reader expects here is the whole-file refusal.
      assert.deepEqual(settings, {})
      assert.deepEqual(reports, [])
      continue
    }
    assert.deepEqual(settings, {})
    assert.equal(reports.length, 1, JSON.stringify(shape))
  }
})

test('the composition calls the seed, and calls it after load', async () => {
  // Structural, like `config-wiring.test.ts`, and for the same reason it exists:
  // the store's own tests hand it a reader directly, so they pass whether or not
  // the plugin ever asks. And the ordering is load-bearing in the *silent*
  // direction — seeding before `load` is a fail-safe no-op, so getting it wrong
  // disables the migration without a single red test or log line.
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')
  const load = source.indexOf('settings.load()')
  const seed = source.indexOf('settings.seedWorldbookSettings(')
  assert.ok(load >= 0, 'settings.load() is not called by the composition')
  assert.ok(seed >= 0, 'seedWorldbookSettings is declared and never called by the composition')
  assert.ok(seed > load, 'the seed runs before load, which makes it a silent no-op')
  assert.match(source.slice(seed, seed + 200), /stInstall\.worldInfoSettings\(\)/)
})

test('nothing in the import writes to the install', async (t) => {
  const { install, st, store } = await fixture(t, NESTED)
  const before = (await readdir(install)).sort()
  const settings = store()
  await settings.load()

  await settings.seedWorldbookSettings(() => st.worldInfoSettings())

  // The premise of every ST read here, asserted rather than left to review.
  assert.deepEqual((await readdir(install)).sort(), before)
  assert.equal(
    JSON.parse(await readFile(join(install, 'settings.json'), 'utf8'))['world_info_settings']
      ['world_info_depth'],
    9,
    'the install’s own value changed',
  )
  assert.equal(existsSync(join(install, 'worlds')), false, 'the import created a directory in the install')
})
