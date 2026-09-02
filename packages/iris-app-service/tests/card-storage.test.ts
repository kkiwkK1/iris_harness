import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { StreamFn } from '@iris/turn'

import { CardStorageStore, MAX_VALUE_BYTES, removalNote } from '../src/card-storage.ts'
import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The key–value store cards use as browser storage.
 *
 * **Shared across the profile, because upstream shares it.** A card's scripts
 * write to one `localStorage` per origin, so two cards choosing the same key
 * see each other's values — measured on the corpus as four shared keys between
 * two cards. Partitioning it per card would be tidier and would break every
 * card that relies on the sharing, so the sharing is reproduced.
 *
 * **What is not reproduced is the silence.** Upstream's `clear()` empties the
 * origin with no way to learn whose keys went. Here every key records its last
 * writer, so a removal that took another card's key says so.
 */

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
  storage: CardStorageStore
  diagnostics: DiagnosticBuffer
  dir: string
}

async function fixture(t: TestContext, withStore = true): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-store-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const storage = new CardStorageStore(join(dir, 'card-storage.json'))
  const diagnostics = new DiagnosticBuffer()
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
    diagnostics,
    ...withStore ? { cardStorage: storage } : {},
  }).handlers()

  return { handlers, storage, diagnostics, dir }
}

test('a value written by one card is visible to another, as upstream shares it', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['storage.set']({ characterId: 'aria', key: 'theme', value: 'dark' })
  const snapshot = await fixed.storage.snapshot()

  // The sharing is the behaviour, not an accident: two cards choosing one key
  // see each other's value in SillyTavern, and a card may be relying on it.
  assert.deepEqual(snapshot, { theme: 'dark' })
})

test('the snapshot carries values only, never who wrote them', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'aria', scriptId: 'panel', key: 'k', value: 'v' })

  // Provenance is the host's bookkeeping. A frame has no use for it, and the
  // snapshot is already the expensive part of every turn — so the shape handed
  // over is flat and string-valued, exactly like `localStorage`.
  assert.deepEqual(await fixed.storage.snapshot(), { k: 'v' })
  assert.equal((await fixed.storage.lastWriter('k'))?.characterId, 'aria')
  assert.equal((await fixed.storage.lastWriter('k'))?.scriptId, 'panel')
})

test('removing another card’s key is reported, with the key and its writer', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'other-card', key: 'shared', value: 'theirs' })

  await fixed.handlers['storage.remove']({ characterId: 'aria', key: 'shared' })

  const page = await fixed.handlers['debug.reports']({})
  const storage = page.reports.filter(report => report.kind === 'storage')
  assert.equal(storage.length, 1, `expected one storage report, saw ${JSON.stringify(page.reports)}`)
  assert.match(storage[0]?.message ?? '', /"shared"/u)
  assert.match(storage[0]?.message ?? '', /other-card/u)
  assert.equal(storage[0]?.characterId, 'aria', 'the report does not say who did it')
})

test('removing your own key says nothing', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'aria', key: 'mine', value: 'v' })
  await fixed.handlers['storage.remove']({ characterId: 'aria', key: 'mine' })

  // The other half of the discipline: an instrument that also fires on the
  // ordinary path teaches its reader to ignore it.
  const page = await fixed.handlers['debug.reports']({})
  assert.deepEqual(page.reports.filter(report => report.kind === 'storage'), [])
})

test('clear empties everything and names each key it took from someone else', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'aria', key: 'mine', value: '1' })
  await fixed.handlers['storage.set']({ characterId: 'other-card', key: 'theirs', value: '2' })
  await fixed.handlers['storage.set']({ characterId: 'third-card', key: 'also-theirs', value: '3' })

  const result = await fixed.handlers['storage.clear']({ characterId: 'aria' })

  // Upstream's `clear()` empties the origin, taking every card's keys. That is
  // reproduced — and each loss that was not the caller's own is named, which is
  // the part upstream cannot do.
  assert.equal(result.removed, 3)
  assert.equal(result.foreign, 2)
  assert.deepEqual(await fixed.storage.snapshot(), {})

  const page = await fixed.handlers['debug.reports']({})
  const names = page.reports.filter(report => report.kind === 'storage').map(report => report.message)
  assert.equal(names.length, 2, 'a foreign key went unreported')
  assert.equal(names.some(message => message.includes('theirs')), true)
  assert.equal(names.some(message => message.includes('also-theirs')), true)
})

test('an unattributed key is not called someone else’s', async (t) => {
  const fixed = await fixture(t)
  // A key with no recorded writer predates this bookkeeping. Reporting it as
  // foreign would assert a theft that cannot be substantiated.
  await fixed.storage.set('legacy', 'v', {})

  const report = await fixed.storage.remove('legacy', { characterId: 'aria' })
  assert.equal(report?.foreign, false)
  assert.equal(removalNote(report as never, 'remove'), undefined)
})

test('a removal of a key that is not there is not an error', async (t) => {
  const fixed = await fixture(t)

  // Idempotent, like `localStorage.removeItem`.
  const result = await fixed.handlers['storage.remove']({ characterId: 'aria', key: 'never-existed' })
  assert.equal(result.removed, false)
})

test('an oversized value is refused rather than stored', async (t) => {
  const fixed = await fixture(t)

  // The cap is a placeholder pending a real-frame measurement of what one value
  // costs to clone per turn — bytes are the wrong unit, but an unbounded value
  // is the wrong answer while waiting for the right one.
  await assert.rejects(
    () => fixed.storage.set('big', 'x'.repeat(MAX_VALUE_BYTES + 1), { characterId: 'aria' }),
    /over the .* limit/u,
  )
  assert.deepEqual(await fixed.storage.snapshot(), {})
})

test('the store survives a restart, because a card expects its state to', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'aria', key: 'kept', value: 'across restarts' })

  const reopened = new CardStorageStore(join(fixed.dir, 'card-storage.json'))
  assert.deepEqual(await reopened.snapshot(), { kept: 'across restarts' })
  assert.equal((await reopened.lastWriter('kept'))?.characterId, 'aria')
})

test('the snapshot reaches a card through its script context', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['storage.set']({ characterId: 'aria', key: 'seen', value: 'by the card' })

  const created = await fixed.handlers['chat.create']({ characterId: 'aria' })
  const { context } = await fixed.handlers['script.context']({
    chatId: created.view.chatId, characterId: 'aria',
  })

  // The read path is the snapshot, not a request: a card reads its storage
  // synchronously, the same way it reads `localStorage`.
  assert.deepEqual(context.storage, { seen: 'by the card' })
})

test('a host with no store refuses rather than pretending the write landed', async (t) => {
  const fixed = await fixture(t, false)

  // The failure this prevents: a card believing its state is saved, and finding
  // it gone with nothing having said so.
  await assert.rejects(
    () => fixed.handlers['storage.set']({ characterId: 'aria', key: 'k', value: 'v' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})
