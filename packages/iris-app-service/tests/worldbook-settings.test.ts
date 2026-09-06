import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { GenerationSettings } from '@iris/protocol'

import { SettingsStore } from '../src/settings.ts'
import {
  DEFAULT_WORLDBOOK_SETTINGS,
  activationSettingsOf,
  resolveWorldbookSettings,
  sanitizeWorldbookSettings,
} from '../src/worldbook-settings.ts'

/**
 * The world-info settings are real.
 *
 * Until this store existed the engine ran on hard-coded fallbacks while the
 * card-facing `getLorebookSettings()` reported upstream's defaults — and on
 * `matchWholeWords` the two disagreed outright. These tests pin the seam that
 * removed the split: one stored table, read by the engine, the card-facing
 * snapshot and the panel alike.
 */

const ROUTE: GenerationSettings = { provider: 'test', model: 'test-model' }

async function storeWith(file: Record<string, unknown> | undefined): Promise<SettingsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-settings-'))
  const path = join(dir, 'settings.json')
  if (file !== undefined) {
    await mkdir(dir, { recursive: true })
    await writeFile(path, JSON.stringify(file), 'utf8')
  }
  const store = new SettingsStore(path, ROUTE)
  await store.load()
  return store
}

test('the defaults are SillyTavern’s shipped values, including matchWholeWords', () => {
  // `world-info.js:69-82`. The false here is the point of this change: an
  // earlier engine default flipped it to true while every card-facing surface
  // reported false, so a book tuned on upstream under-fired with nothing
  // reporting why.
  assert.equal(DEFAULT_WORLDBOOK_SETTINGS.matchWholeWords, false)
  assert.equal(DEFAULT_WORLDBOOK_SETTINGS.scanDepth, 2)
  assert.equal(DEFAULT_WORLDBOOK_SETTINGS.budgetPercent, 25)
  assert.equal(DEFAULT_WORLDBOOK_SETTINGS.insertionStrategy, 'character_first')
  assert.deepEqual(resolveWorldbookSettings(undefined), DEFAULT_WORLDBOOK_SETTINGS)
})

test('a patch lands, persists, and survives a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-settings-'))
  const store = new SettingsStore(join(dir, 'settings.json'), ROUTE)
  await store.load()

  const after = await store.setWorldbookSettings({ scanDepth: 5, recursive: true })
  assert.equal(after.scanDepth, 5)
  assert.equal(after.recursive, true)
  // Untouched fields keep the defaults — a patch is not a replacement.
  assert.equal(after.budgetPercent, DEFAULT_WORLDBOOK_SETTINGS.budgetPercent)

  const reopened = new SettingsStore(join(dir, 'settings.json'), ROUTE)
  await reopened.load()
  assert.equal(reopened.worldbookSettings().scanDepth, 5)
  assert.equal(reopened.worldbookSettings().recursive, true)
})

test('a settings file carries its worldbooks section across a load', async () => {
  // **The regression.** `load` rebuilds the store's file state wholesale, and an
  // earlier version stopped at `chats` — so this section was written, read back
  // correctly while the process lived, and silently reset on the next start. A
  // user's global selection and scan knobs vanished with no error anywhere.
  const store = await storeWith({
    global: ROUTE,
    chats: {},
    worldbooks: {
      globalSelect: ['尸变纪元 v0.5（NSFW）'],
      settings: { scanDepth: 7, insertionStrategy: 'global_first' },
    },
  })

  assert.deepEqual(store.globalSelect(), ['尸变纪元 v0.5（NSFW）'])
  assert.equal(store.worldbookSettings().scanDepth, 7)
  assert.equal(store.worldbookSettings().insertionStrategy, 'global_first')
})

test('a global selection write does not reset the scan settings', async () => {
  const store = await storeWith({
    global: ROUTE,
    chats: {},
    worldbooks: { globalSelect: ['a'], settings: { scanDepth: 9 } },
  })

  await store.setGlobalSelect(['b'])
  assert.deepEqual(store.globalSelect(), ['b'])
  assert.equal(store.worldbookSettings().scanDepth, 9)
})

test('a scan settings write does not reset the global selection', async () => {
  const store = await storeWith({
    global: ROUTE,
    chats: {},
    worldbooks: { globalSelect: ['a'], settings: {} },
  })

  await store.setWorldbookSettings({ matchWholeWords: true })
  assert.deepEqual(store.globalSelect(), ['a'])
  assert.equal(store.worldbookSettings().matchWholeWords, true)
})

test('a bad value is refused by name, not clamped', async () => {
  const store = await storeWith(undefined)
  assert.throws(() => sanitizeWorldbookSettings({ scanDepth: 1.5 }), /scanDepth/)
  assert.throws(() => sanitizeWorldbookSettings({ budgetPercent: 101 }), /budgetPercent/)
  assert.throws(() => sanitizeWorldbookSettings({ insertionStrategy: 'sortednicely' }), /insertionStrategy/)
  assert.throws(() => sanitizeWorldbookSettings({ recursive: 'yes' }), /recursive/)
  await assert.rejects(store.setWorldbookSettings({ scanDepth: -1 }), /scanDepth/)
  // The refused patch must not have written the refused value.
  assert.equal(store.worldbookSettings().scanDepth, DEFAULT_WORLDBOOK_SETTINGS.scanDepth)
})

test('an unknown key is ignored, the same reading settings.set gives the sampler', () => {
  const patch = sanitizeWorldbookSettings({ scanDepth: 3, somedayFeature: true })
  assert.deepEqual(patch, { scanDepth: 3 })
})

test('the engine mapping carries the scan knobs and nothing else', () => {
  // `budgetPercent` and `budgetCap` are deliberately absent: the budget also
  // needs the context window, which belongs to the model and arrives through
  // `computeBudget` at the call site. Pinning the split so a knob cannot
  // silently migrate between the two vocabularies.
  const engine = activationSettingsOf(DEFAULT_WORLDBOOK_SETTINGS)
  assert.deepEqual(Object.keys(engine).sort(), [
    'caseSensitive', 'matchWholeWords', 'maxRecursionSteps', 'minActivations',
    'minActivationsDepthMax', 'recursive', 'scanDepth', 'useGroupScoring',
  ])
})
