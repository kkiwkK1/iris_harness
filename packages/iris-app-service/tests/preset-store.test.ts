import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { ChatCompletionPreset } from '@iris/preset'

import { AppError } from '../src/errors.ts'
import { PresetStore, asPreset, sanitizePresetName } from '../src/presets.ts'

/**
 * The profile's preset files.
 *
 * Upstream's whole storage model is one JSON file per preset in
 * `data/<user>/OpenAI Settings/`, addressed by name — so the store is a folder
 * plus four file operations, and what the tests guard is the *fidelity*: a name
 * survives a round trip unchanged (or the import forks presets), the four-space
 * indent matches what upstream writes (or a round trip shows as a full-file
 * diff), and an import copies read-only towards the install it came from.
 */

const PRESET: ChatCompletionPreset = {
  temperature: 0.7,
  openai_max_context: 65536,
  prompts: [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'You are.', marker: false },
    { identifier: 'chatHistory', marker: true },
  ],
  prompt_order: [{ character_id: 100001, order: [
    { identifier: 'main', enabled: true },
    { identifier: 'chatHistory', enabled: true },
  ] }],
} as unknown as ChatCompletionPreset

async function mkStore(t: TestContext): Promise<{ store: PresetStore, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-presets-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return { store: new PresetStore(join(dir, 'presets')), dir }
}

test('sanitizePresetName keeps the classes upstream strips, and keeps real names intact', () => {
  // Names measured on a real install pass through untouched — an import that
  // renamed would fork one preset into two spellings.
  assert.equal(sanitizePresetName('Antennae_v18 (1)'), 'Antennae_v18 (1)')
  assert.equal(sanitizePresetName('梦境思客V1-0425'), '梦境思客V1-0425')
  // Illegal characters go, the way sanitize-filename strips them.
  assert.equal(sanitizePresetName('a/b<c>?\\d:*|'), 'abcd')
  // Control characters, trailing dots and spaces.
  assert.equal(sanitizePresetName('x\u0007y.. '), 'xy')
  // Reserved device names are refused rather than stored as `con.json`.
  assert.throws(() => sanitizePresetName('CON'), AppError)
  assert.throws(() => sanitizePresetName('com1.json'), AppError)
  // Empty after cleaning is refused: the file system needs a name.
  assert.throws(() => sanitizePresetName('???'), AppError)
})

test('asPreset accepts the one thing every preset carries: a prompts array', () => {
  assert.ok(asPreset({ prompts: [] }) !== undefined)
  assert.equal(asPreset({ settings: {} }), undefined)
  assert.equal(asPreset('prompts'), undefined)
  assert.equal(asPreset(null), undefined)
})

test('a fresh library lists nothing, and an absent directory is a state, not an error', async (t) => {
  const { store } = await mkStore(t)
  assert.deepEqual(await store.list(), [])
})

test('save and read round-trip a preset under its name, in upstream’s own format', async (t) => {
  const { store, dir } = await mkStore(t)
  await store.save('Test Preset', PRESET)

  assert.ok(await store.has('Test Preset'))
  const read = await store.read('Test Preset')
  assert.equal((read.prompts[0] as { identifier: string }).identifier, 'main')
  assert.equal(read['openai_max_context'], 65536)

  // Four-space indent and a trailing newline: what upstream's presets.js writes.
  const text = await readFile(join(dir, 'presets', 'Test Preset.json'), 'utf8')
  assert.ok(text.includes('\n    "prompts"'), 'the file is not in upstream’s four-space format')
  assert.ok(text.endsWith('\n'))
})

test('list skips files that are not presets, instead of listing them', async (t) => {
  const { store, dir } = await mkStore(t)
  await store.save('Good', PRESET)
  await mkdir(join(dir, 'presets'), { recursive: true })
  await writeFile(join(dir, 'presets', 'notes.json'), '{"hello": 1}', 'utf8')
  await writeFile(join(dir, 'presets', 'broken.json'), '{not json', 'utf8')
  await writeFile(join(dir, 'presets', 'ignoreme.txt'), 'preset', 'utf8')

  assert.deepEqual(await store.list(), ['Good'])
})

test('a name that is not in the library answers not-found, on read and on delete', async (t) => {
  const { store } = await mkStore(t)
  await assert.rejects(() => store.read('Missing'), (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'not-found')
    return true
  })
  await assert.rejects(() => store.delete('Missing'), AppError)
})

test('save refuses a body with no prompts array: a library of non-presets is worse than an error', async (t) => {
  const { store } = await mkStore(t)
  await assert.rejects(
    () => store.save('Junk', { temperature: 1 } as unknown as ChatCompletionPreset),
    (error: unknown) => error instanceof AppError && error.code === 'invalid-request',
  )
})

test('importFrom copies from the install read-only and reports each name’s outcome', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'iris-install-'))
  const lib = await mkdtemp(join(tmpdir(), 'iris-presets-'))
  t.after(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(lib, { recursive: true, force: true })
  })
  await mkdir(join(source, 'OpenAI Settings'), { recursive: true })
  await writeFile(join(source, 'OpenAI Settings', 'Real.json'), JSON.stringify(PRESET), 'utf8')
  await writeFile(join(source, 'OpenAI Settings', 'NotPreset.json'), '{"x": 1}', 'utf8')

  const store = new PresetStore(join(lib, 'presets'))
  const outcomes = await store.importFrom(source)
  // The non-preset is discovered and reported, not silently skipped.
  assert.deepEqual(outcomes.map(outcome => outcome.name).sort(), ['NotPreset', 'Real'])
  assert.deepEqual(outcomes.filter(outcome => outcome.imported).map(outcome => outcome.name), ['Real'])

  // The copy landed, and the source is untouched by anything but the read.
  assert.ok(await store.has('Real'))
  const original = await readFile(join(source, 'OpenAI Settings', 'Real.json'), 'utf8')
  assert.ok(original.length > 0)
})

test('importFrom overwrites a name already in the library: an import is a re-read of the source', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'iris-install-'))
  const lib = await mkdtemp(join(tmpdir(), 'iris-presets-'))
  t.after(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(lib, { recursive: true, force: true })
  })
  await mkdir(join(source, 'OpenAI Settings'), { recursive: true })
  await writeFile(join(source, 'OpenAI Settings', 'Same.json'), JSON.stringify(PRESET), 'utf8')

  const store = new PresetStore(join(lib, 'presets'))
  const drifted = { ...PRESET, temperature: 0.1 }
  await store.save('Same', drifted)
  await store.importFrom(source, ['Same'])

  const now = await store.read('Same')
  assert.equal(now['temperature'], PRESET['temperature'], 'the stale local copy survived the import')
})

test('importFrom names each reason a preset could not come over', async (t) => {
  const source = await mkdtemp(join(tmpdir(), 'iris-install-'))
  const lib = await mkdtemp(join(tmpdir(), 'iris-presets-'))
  t.after(async () => {
    await rm(source, { recursive: true, force: true })
    await rm(lib, { recursive: true, force: true })
  })
  // A profile directory with no OpenAI Settings at all.
  await mkdir(source, { recursive: true })

  const store = new PresetStore(join(lib, 'presets'))
  const outcomes = await store.importFrom(source, ['Whatever'])
  assert.deepEqual(outcomes, [{ name: 'Whatever', imported: false, why: 'absent' }])

  // No install configured at all: the one refusal with no per-name meaning.
  const nothing = await store.importFrom(undefined, ['Whatever'])
  assert.deepEqual(nothing, [{ name: 'Whatever', imported: false, why: 'not-configured' }])
})
