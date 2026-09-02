import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { lorebookSettings, UPSTREAM_DEFAULTS } from '../src/lorebook-settings.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

/**
 * The two members MVU's chat-level init calls, built to upstream's signatures.
 *
 * Both were absent, and their absence is a **quiet** half-death rather than a
 * loud one: `initGlobals` still runs, `Mvu` still publishes, and a card's
 * `waitGlobalInitialized('Mvu')` still returns — so the card holds a real Mvu
 * object while `initResponse()` was never attached and `<UpdateVariable>` is
 * silently not processed. The acceptance signal for this work is therefore not
 * "Mvu exists" but "the update block was actually folded".
 */

const BOOK = {
  entries: {
    '0': { uid: 0, key: ['alpha'], content: 'first', comment: 'a', disable: false },
    '7': { uid: 7, key: ['beta'], content: 'second', comment: 'b', disable: false },
  },
}

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chatId: string
  dir: string
}

/** A host with one book on disk and one open chat. */
async function fixture(t: TestContext, withWorldbooks = true): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-mvuinit-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'worlds', 'Lore.json'), JSON.stringify(BOOK), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    broadcast: () => {},
    userName: 'Traveller',
    ...withWorldbooks ? { worldbooks: new WorldbookStore(join(dir, 'worlds')) } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chatId: created.view.chatId, dir }
}

test('a loaded book keeps the raw uid-keyed shape MVU checks for', async (t) => {
  const fixed = await fixture(t)

  const { book } = await fixed.handlers['worldbook.load']({ name: 'Lore' })

  // MVU's guard is `isPlainObject(loaded) && isPlainObject(loaded.entries)`, so
  // an array of entries — which is what TavernHelper's `getWorldbook()` returns
  // for the same book — fails it. Two APIs, two shapes, and the card picks.
  assert.equal(typeof book, 'object')
  assert.notEqual(book, null)
  const entries = (book as { entries?: unknown }).entries
  assert.equal(Array.isArray(entries), false, 'the raw reader normalised into an array')
  assert.deepEqual(Object.keys(entries as object).sort(), ['0', '7'])
  assert.equal((entries as Record<string, { content: string }>)['7']?.content, 'second')
})

test('the two empty answers are told apart', async (t) => {
  const fixed = await fixture(t)

  // No name asked for: upstream's bare `return;`. The key is absent, not null.
  const nothing = await fixed.handlers['worldbook.load']({ name: '' })
  assert.equal('book' in nothing, false, 'an empty name produced a present key')

  // A name that resolves to nothing: upstream's `return null`.
  const missing = await fixed.handlers['worldbook.load']({ name: 'no-such-book' })
  assert.equal('book' in missing, true)
  assert.equal(missing.book, null)
})

test('a host with no world books answers null rather than refusing', async (t) => {
  const fixed = await fixture(t, false)

  // `null` is upstream's "asked and did not get it", which is exactly this
  // case. Throwing would make a card treat a host without world info as a
  // broken call rather than an empty one.
  const { book } = await fixed.handlers['worldbook.load']({ name: 'Lore' })
  assert.equal(book, null)
})

test('the lorebook settings are SillyTavern’s own defaults, not house numbers', () => {
  // Read from `world-info.js:69-82`. A plausible house default would make a
  // card decide differently here than in SillyTavern, with no symptom anyone
  // could trace back to this table.
  assert.equal(UPSTREAM_DEFAULTS.scan_depth, 2)
  assert.equal(UPSTREAM_DEFAULTS.context_percentage, 25)
  assert.equal(UPSTREAM_DEFAULTS.budget_cap, 0)
  assert.equal(UPSTREAM_DEFAULTS.min_activations, 0)
  assert.equal(UPSTREAM_DEFAULTS.max_depth, 0)
  assert.equal(UPSTREAM_DEFAULTS.max_recursion_steps, 0)
  assert.equal(UPSTREAM_DEFAULTS.insertion_strategy, 'character_first')
  assert.equal(UPSTREAM_DEFAULTS.include_names, true)
  assert.equal(UPSTREAM_DEFAULTS.recursive, false)
  assert.equal(UPSTREAM_DEFAULTS.overflow_alert, false)
})

test('the two misleading field names are carried, not corrected', () => {
  const settings = lorebookSettings([])

  // `max_depth` is the ceiling for *minimum activations*; the scan depth is
  // `scan_depth`. `context_percentage` is a percentage while `budget_cap` is a
  // byte count — two upstream fields called budget. Renaming either to
  // something honest would break every card that reads them by name.
  assert.equal(Object.hasOwn(settings, 'max_depth'), true)
  assert.equal(Object.hasOwn(settings, 'scan_depth'), true)
  assert.equal(Object.hasOwn(settings, 'context_percentage'), true)
  assert.equal(Object.hasOwn(settings, 'budget_cap'), true)
  assert.equal(Object.keys(settings).length, 14, 'the field set changed shape')
})

test('the settings ride in the context snapshot, because the member is synchronous', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['worldbook.setGlobalSelect']({ names: ['Lore'] })

  const { context } = await fixed.handlers['script.context']({
    chatId: fixed.chatId, characterId: 'aria',
  })

  // MVU calls `getLorebookSettings()` both with and without `await`, and both
  // work only because the value is already in hand. If this ever moved behind a
  // request, the call site that does not await would receive a Promise and read
  // `undefined` off it — silently, since a Promise has every field absent.
  assert.notEqual(context.lorebookSettings, undefined, 'a synchronous member has nothing to answer from')
  assert.deepEqual(context.lorebookSettings?.selected_global_lorebooks, ['Lore'])
  assert.equal(context.lorebookSettings?.scan_depth, 2)
})

test('a card scribbling on the settings cannot change the host’s', async (t) => {
  const fixed = await fixture(t)

  // Upstream returns a `klona` deep copy, so the snapshot semantics here are
  // upstream's own rather than a divergence from a live object.
  const first = lorebookSettings(['Lore'])
  first.selected_global_lorebooks.push('injected')
  first.scan_depth = 999

  const second = lorebookSettings(['Lore'])
  assert.deepEqual(second.selected_global_lorebooks, ['Lore'])
  assert.equal(second.scan_depth, 2)
})
