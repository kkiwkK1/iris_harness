import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { deflateSync } from 'node:zlib'

import { decodeCardPng, encodeCardPng, normalizeCard, readCardChunks, serializePngChunks, type PngChunk } from '@iris/character'

import { CharacterLibrary } from '../src/library.ts'
import { FavoriteStore } from '../src/favorites.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { WorldbookBindingStore } from '../src/materialise.ts'

/**
 * The character manager: rename, duplicate, tags, export, favorites.
 *
 * These are the operations that *write a card*, and the card is someone
 * else's data — so every test here is really asking one of two questions.
 * Did the field the operation owns change? And did **everything else survive
 * untouched** — the unknown fields, the binding name in `extensions.world`,
 * the picture the card ships with. A manager that renames by re-encoding the
 * card fails the second question quietly; these tests exist so that failure
 * cannot come back.
 */

/** A genuinely valid 1x1 greyscale PNG, the same fixture shape png.test.ts uses. */
function blankPng(extra: readonly PngChunk[] = []): Uint8Array {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, 1) // width
  header.setUint32(4, 1) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  const idat = new Uint8Array(deflateSync(Uint8Array.of(0, 0)))
  return serializePngChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: idat },
    ...extra,
    { type: 'IEND', data: new Uint8Array(0) },
  ])
}

/** The card body every fixture starts from — deliberately V3-shaped. */
function cardBody(): Record<string, unknown> {
  return {
    name: 'Sable',
    description: 'A lighthouse keeper.',
    personality: '',
    scenario: '',
    first_mes: 'The lamp is lit.',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: ['sea'],
    creator: 'kestrel',
    character_version: '2',
    // The binding. A manager operation that disturbed this would break the
    // character's world info without anything looking broken.
    extensions: { world: 'Lighthouse Lore', depth_prompt: { prompt: 'calm', depth: 4, role: 'system' } },
    character_book: { entries: [], extensions: {} },
    nickname: 'Sab',
  }
}

/** A `.json` V3 card with an unknown top-level key a re-encoder would drop. */
function sableJson(): string {
  return JSON.stringify({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: cardBody(),
    name: 'Sable',
    description: 'A lighthouse keeper.',
    tags: ['sea'],
    // Unknown provenance, exactly what a card picked up in the wild carries.
    create_date: '2025.11.2',
    x_custom: { keep: true },
  })
}

/** A PNG card built around {@link cardBody}, through the real encode path. */
function sablePng(): Uint8Array {
  const card = normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data: cardBody() })
  return encodeCardPng(blankPng(), card)
}

/** A directory of cards, as a user's profile holds them. */
async function libraryFixture(t: TestContext, files: Record<string, Uint8Array | string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charops-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const characters = join(dir, 'characters')
  await mkdir(characters, { recursive: true })
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(characters, name), Buffer.isBuffer(bytes) || bytes instanceof Uint8Array ? bytes : String(bytes), 'utf8')
  }
  return characters
}

// ------------------------------------------------------------------- rename

test('a rename changes the name and nothing else on a .json card', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const renamed = await library.rename('sable', 'Sable of the Northern Light')
  assert.equal(renamed.characterId, 'sable', 'the id moved with the name')
  assert.equal(renamed.name, 'Sable of the Northern Light')

  const raw = JSON.parse(await readFile(join(characters, 'sable.json'), 'utf8')) as Record<string, unknown>
  assert.equal(raw['name'], 'Sable of the Northern Light', 'the V1 mirror was refreshed')
  const data = raw['data'] as Record<string, unknown>
  assert.equal(data['name'], 'Sable of the Northern Light')
  // Everything the operation did not own came through untouched.
  assert.equal(raw['spec'], 'chara_card_v3', 'a V3 card was not restamped V2')
  assert.equal(raw['create_date'], '2025.11.2', 'an unknown top-level key was dropped')
  assert.deepEqual(raw['x_custom'], { keep: true })
  const extensions = data['extensions'] as Record<string, unknown>
  assert.equal(extensions['world'], 'Lighthouse Lore', 'the worldbook binding moved')
  assert.deepEqual(data['tags'], ['sea'], 'tags drifted during a rename')
})

test('a rename rewrites the card chunks in place and leaves the picture alone', async (t) => {
  const characters = await libraryFixture(t, { 'sable.png': Buffer.from(sablePng()) })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const renamed = await library.rename('sable', 'Sable Renamed')
  assert.equal(renamed.characterId, 'sable')

  const bytes = await readFile(join(characters, 'sable.png'))
  const chunks = readCardChunks(new Uint8Array(bytes))
  assert.ok(chunks.ccv3 !== undefined, 'the ccv3 chunk vanished')
  assert.ok(chunks.chara !== undefined, 'the chara chunk vanished')
  const body = JSON.parse(Buffer.from(chunks.ccv3, 'base64').toString('utf8')) as Record<string, unknown>
  assert.equal((body['data'] as Record<string, unknown>)['name'], 'Sable Renamed')
  assert.equal(body['name'], 'Sable Renamed', 'the V1 mirror was refreshed')
  // The binding name survives — the acceptance property a rename exists to keep.
  const extensions = (body['data'] as Record<string, unknown>)['extensions'] as Record<string, unknown>
  assert.equal(extensions['world'], 'Lighthouse Lore')
  // And the card still decodes to what the file says it is.
  assert.equal(decodeCardPng(new Uint8Array(bytes)).data.name, 'Sable Renamed')
})

test('a rename refuses a blank name and a missing card', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  await assert.rejects(
    () => library.rename('sable', '   '),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
  await assert.rejects(
    () => library.rename('nobody', 'X'),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

// ---------------------------------------------------------------- duplicate

test('a duplicate is byte-for-byte the source under a fresh id', async (t) => {
  const png = sablePng()
  const characters = await libraryFixture(t, { 'sable.png': Buffer.from(png) })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const copy = await library.duplicate('sable')
  assert.notEqual(copy.characterId, 'sable', 'the copy took the source id')
  assert.equal(copy.name, 'Sable', 'the copy carries the same card')

  const [source, fresh] = await Promise.all([
    readFile(join(characters, 'sable.png')),
    readFile(join(characters, `${copy.characterId}.png`)),
  ])
  assert.ok(source.equals(fresh), 'the copy was re-encoded')
})

test('a second duplicate does not collide with the first', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const first = await library.duplicate('sable')
  const second = await library.duplicate('sable')
  assert.notEqual(first.characterId, second.characterId)
  const listed = await library.list()
  assert.deepEqual(listed.map(row => row.characterId).sort(), ['sable', first.characterId, second.characterId].sort())
})

// --------------------------------------------------------------------- tags

test('setTags replaces the list and refreshes the mirror only where one exists', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const edited = await library.setTags('sable', ['sea', 'storm', 'lamp'])
  assert.deepEqual(edited.tags, ['sea', 'storm', 'lamp'])

  const raw = JSON.parse(await readFile(join(characters, 'sable.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual((raw['data'] as Record<string, unknown>)['tags'], ['sea', 'storm', 'lamp'])
  assert.deepEqual(raw['tags'], ['sea', 'storm', 'lamp'], 'the V1 mirror went stale')
  // The unknown keys a tags edit has no business touching are still there.
  assert.deepEqual(raw['x_custom'], { keep: true })
})

test('setTags on a V1 card writes the top-level list the card actually has', async (t) => {
  // A flat V1 card: `tags` at the top level is the only copy.
  const v1 = JSON.stringify({ name: 'Old One', description: '', personality: '', scenario: '',
    first_mes: '', mes_example: '', tags: ['ancient'], creatorcomment: '' })
  const characters = await libraryFixture(t, { 'old.json': v1 })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  await library.setTags('old', ['ancient', 'vast'])
  const raw = JSON.parse(await readFile(join(characters, 'old.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(raw['tags'], ['ancient', 'vast'])
  assert.equal(raw['data'], undefined, 'a data object was invented on a V1 card')
})

// ------------------------------------------------------------------- export

test('an exported PNG re-imports to the same card, minus the private fields', async (t) => {
  // The source carries exactly the runtime state an export must strip: a
  // favourite flag in both spellings and the install's last-open pointer.
  const card = normalizeCard({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { ...cardBody(), extensions: { ...cardBody().extensions as Record<string, unknown>, fav: true } },
    fav: true,
    chat: 'Sable - 2026-01-18@05h53m41s311ms',
  })
  const characters = await libraryFixture(t, { 'sable.png': Buffer.from(encodeCardPng(blankPng(), card)) })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const { filename, content } = await library.exportCard('sable', 'png')
  assert.equal(filename, 'sable.png')
  const bytes = new Uint8Array(Buffer.from(content, 'base64'))

  // Re-import through the same door a user's card arrives by, and compare the
  // fields the card actually has — the acceptance, not a byte hash (the chunks
  // were legitimately rewritten).
  const round = decodeCardPng(bytes).data
  assert.deepEqual(round.tags, ['sea'])
  assert.equal(round.description, 'A lighthouse keeper.')
  assert.equal(round.nickname, 'Sab', 'a V3-only field was lost on export')
  assert.equal(round.extensions['world'], 'Lighthouse Lore')
  assert.equal(round.extensions['fav'], false, 'the favourite flag travelled')
  const raw = JSON.parse(Buffer.from(readCardChunks(bytes).ccv3 ?? '', 'base64').toString('utf8')) as Record<string, unknown>
  assert.equal(raw['fav'], false, 'the top-level favourite spelling travelled')
  assert.equal('chat' in raw, false, 'the last-open chat pointer travelled')
})

test('an exported JSON card parses to the stored card, private fields stripped', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const { filename, content } = await library.exportCard('sable', 'json')
  assert.equal(filename, 'sable.json')
  const raw = JSON.parse(content) as Record<string, unknown>
  assert.equal(raw['spec'], 'chara_card_v3', 'the stored shape was converted')
  assert.equal((raw['data'] as Record<string, unknown>)['name'], 'Sable')
  assert.deepEqual(raw['x_custom'], { keep: true }, 'an unknown key was dropped on export')
  // The file never carried private fields; exporting added none.
  assert.equal('chat' in raw, false)
})

test('export refuses the format a file cannot be', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')

  await assert.rejects(
    () => library.exportCard('sable', 'png'),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

// ---------------------------------------------------------------- favorites

test('the favorite store stars, unstarrs, persists, and forgets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-favs-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'favorites.json')

  const store = new FavoriteStore(path)
  await store.set('sable', true)
  await store.set('aria', true)
  await store.set('sable', true) // idempotent
  assert.deepEqual(await store.list(), ['sable', 'aria'])
  assert.equal(await store.has('sable'), true)

  await store.set('sable', false)
  assert.deepEqual(await store.list(), ['aria'])

  // A new instance reads the same file, as a restart would.
  const reopened = new FavoriteStore(path)
  assert.deepEqual(await reopened.list(), ['aria'])
  await reopened.forget('aria')
  assert.deepEqual(await reopened.list(), [])
})

test('character.list carries the stars, and deleting a character forgets one', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')
  const chats = materialisingChatStore(join(characters, '..'), library)
  const settings = new SettingsStore(join(characters, '..', 'settings.json'), { provider: 'test', model: 'm' })
  await settings.load()
  const favorites = new FavoriteStore(join(characters, '..', 'favorites.json'))
  const service = new IrisAppService({
    stream: async function* () { throw new Error('no generation in this suite') },
    library,
    chats,
    settings,
    broadcast: () => {},
    favorites,
  })
  const handlers = service.handlers()

  await handlers['character.favorite']({ characterId: 'sable', favorite: true })
  const listed = await handlers['character.list']({})
  assert.equal(listed.characters.find(row => row.characterId === 'sable')?.favorite, true)
  // And a rename answer carries it too.
  const renamed = await handlers['character.rename']({ characterId: 'sable', name: 'Sable II' })
  assert.equal(renamed.character.favorite, true)

  await handlers['character.delete']({ characterId: 'sable' })
  assert.deepEqual(await favorites.list(), [], 'a star outlived its card')
})

test('character.favorite is refused on a host that keeps no favorites', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const library = new CharacterLibrary(characters, '/iris/avatar')
  const chats = materialisingChatStore(join(characters, '..'), library)
  const settings = new SettingsStore(join(characters, '..', 'settings.json'), { provider: 'test', model: 'm' })
  await settings.load()
  const service = new IrisAppService({
    stream: async function* () { throw new Error('no generation in this suite') },
    library,
    chats,
    settings,
    broadcast: () => {},
  })
  await assert.rejects(
    () => service.handlers()['character.favorite']({ characterId: 'sable', favorite: true }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

// -------------------------------------------------- duplicate's binding row

test('a duplicate shares its source\'s materialised book, like a shared binding name', async (t) => {
  const characters = await libraryFixture(t, { 'sable.json': sableJson() })
  const dir = join(characters, '..')
  const library = new CharacterLibrary(characters, '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  await settings.load()
  // The binding table the service is told about. Seeded the way a first open
  // would have seeded it.
  const bindings = new WorldbookBindingStore(join(dir, 'worldbook-bindings.json'))
  await bindings.set('sable', {
    name: 'Lighthouse Lore',
    sourceHash: 'a'.repeat(64),
    materialisedHash: 'b'.repeat(64),
    origin: 'card-name',
    at: 1,
  })
  const service = new IrisAppService({
    stream: async function* () { throw new Error('no generation in this suite') },
    library,
    chats,
    settings,
    broadcast: () => {},
    worldbookBindings: bindings,
  })
  const { character } = await service.handlers()['character.duplicate']({ characterId: 'sable' })
  assert.notEqual(character.characterId, 'sable')

  const copied = await bindings.get(character.characterId)
  assert.ok(copied !== undefined, 'the duplicate was left unbound')
  assert.equal(copied.name, 'Lighthouse Lore', 'the duplicate minted its own book')
})

test('an import whose id differs from an existing card only by case does not take it', async () => {
  // An id is a filename, and on Windows and macOS `sable.json` and `Sable.json`
  // are the same file: minting `Sable` beside an existing `sable` would
  // overwrite that card there and sit next to it on Linux. The library folds
  // case when it asks what is taken, so both systems mint the same id - and it
  // is the suffixed one.
  const dir = await mkdtemp(join(tmpdir(), 'iris-case-'))
  const characters = join(dir, 'characters')
  await mkdir(characters, { recursive: true })
  const body = JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: cardBody() })
  await writeFile(join(characters, 'sable.json'), body, 'utf8')
  const library = new CharacterLibrary(characters, '/iris/avatar')

  const imported = await library.import('Sable.json', Buffer.from(body, 'utf8').toString('base64'))
  assert.equal(imported.characterId, 'Sable-2', 'a case-only twin of an existing id was minted as if it were free')
  assert.deepEqual(
    (await library.refs()).map(ref => ref.characterId).sort(),
    ['Sable-2', 'sable'],
    'the existing card must still be there under its own id',
  )
  await rm(dir, { recursive: true, force: true })
})
