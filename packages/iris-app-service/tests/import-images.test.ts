import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import {
  encodeCardPng,
  encodeTextChunk,
  normalizeCard,
  serializePngChunks,
} from '@iris/character'

import { CharacterLibrary } from '../src/library.ts'

/**
 * Images that carry no card, imported as empty characters.
 *
 * The corpus this guards: two SD generations whose only tEXt chunk is
 * `parameters` and a plain JPEG, all three opened as characters by the user in
 * SillyTavern while this library refused them. The fixtures rebuild the shapes
 * byte for byte in shape (not copied from the corpus) so the suite stays
 * hermetic; DEVIATIONS §18 carries the upstream evidence behind the rule.
 */

/** A 1x1 greyscale PNG body without any card chunk, plus extra tEXt chunks. */
function barePng(extra: readonly { keyword: string, text: string }[]): Uint8Array {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, 1)
  header.setUint32(4, 1)
  ihdr[8] = 8
  return serializePngChunks([
    { type: 'IHDR', data: ihdr },
    ...extra.map(chunk => encodeTextChunk(chunk.keyword, chunk.text)),
    { type: 'IEND', data: new Uint8Array(0) },
  ])
}

/**
 * A JPEG in the corpus file's own shape: SOI, a JFIF APP0, EOI.
 *
 * Only the SOI prefix is load-bearing for the decoder; the segment is here so
 * the fixture is the shape a real bare JPEG is, not the shape a test would
 * conveniently invent (METHODS: fixtures and code must not share one belief).
 */
function bareJpeg(): Uint8Array {
  const jfif = Uint8Array.of(
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // no density units
    0x00, 0x01, 0x00, 0x01, // 1x1 density
    0x00, 0x00, // no thumbnail
  )
  const file = new Uint8Array(2 + 4 + jfif.length + 2)
  const view = new DataView(file.buffer)
  file[0] = 0xff
  file[1] = 0xd8 // SOI
  view.setUint16(2, 0xffe0) // APP0 marker
  view.setUint16(4, jfif.length + 2)
  file.set(jfif, 6)
  file[file.length - 2] = 0xff
  file[file.length - 1] = 0xd9 // EOI
  return file
}

/** The SD-generation shape the two rejected corpus PNGs have, byte-verified. */
function parametersOnlyPng(): Uint8Array {
  return barePng([{ keyword: 'parameters', text: 'Steps: 30, Sampler: Euler a, Model: animeFinal' }])
}

/** The library under test, in a folder that dies with the test. */
async function libraryFor(t: TestContext): Promise<{ library: CharacterLibrary, charactersDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-import-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const charactersDir = join(dir, 'characters')
  const library = new CharacterLibrary(charactersDir, '/iris/avatar')
  await library.ensure()
  return { library, charactersDir }
}

/** Whether an import refusal is the named `invalid-request`, with its text. */
async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string, message: string }> {
  try {
    await run()
  } catch (cause) {
    assert.ok(cause instanceof Error, `expected a named refusal, got ${String(cause)}`)
    const { code } = cause as Error & { code?: string }
    return { code: code ?? 'none', message: cause.message }
  }
  throw new Error('the import was accepted where a refusal was pinned')
}

test('a PNG whose only text chunk is SD parameters imports as an empty character', async t => {
  const { library } = await libraryFor(t)
  const bytes = parametersOnlyPng()

  const summary = await library.import('00004-4209168235_1.png', Buffer.from(bytes).toString('base64'))

  // The name is the filename: the image is the whole card, so there is no
  // other name to read. A card-bearing PNG must keep its own name instead —
  // that is the test at the bottom of this file.
  assert.equal(summary.characterId, '00004-4209168235_1')
  assert.equal(summary.name, '00004-4209168235_1')
  assert.equal(summary.avatarUrl, '/iris/avatar/00004-4209168235_1')
  assert.deepEqual(summary.tags, [])

  const card = await library.load('00004-4209168235_1')
  assert.equal(card.data.name, '')
  assert.equal(card.data.description, '')
  assert.equal(card.data.first_mes, '')
})

test('a second parameters-only PNG gets its own identity, not the first one', async t => {
  const { library } = await libraryFor(t)
  const bytes = parametersOnlyPng()

  const first = await library.import('00004-4209168235_1.png', Buffer.from(bytes).toString('base64'))
  const second = await library.import('00043-409781020.png', Buffer.from(bytes).toString('base64'))

  assert.notEqual(first.characterId, second.characterId)
  assert.deepEqual(
    (await library.list()).map(row => row.characterId).sort(),
    ['00004-4209168235_1', '00043-409781020'],
  )
})

test('a plain JPEG imports as an empty character and keeps its extension', async t => {
  const { library } = await libraryFor(t)
  const bytes = bareJpeg()

  const summary = await library.import('liwy.jpg', Buffer.from(bytes).toString('base64'))

  assert.equal(summary.characterId, 'liwy')
  assert.equal(summary.name, 'liwy')
  assert.equal(summary.avatarUrl, '/iris/avatar/liwy')

  const card = await library.load('liwy')
  assert.equal(card.data.name, '')
  assert.equal(card.data.description, '')
  assert.equal(card.data.first_mes, '')

  // Stored as it arrived — the avatar route serves these bytes as image/jpeg.
  const served = await library.bytes('liwy')
  assert.equal(served.extension, '.jpg')
  assert.deepEqual(served.data, Buffer.from(bytes))
})

test('an uppercase .JPEG extension lands on the same rule', async t => {
  const { library } = await libraryFor(t)

  const summary = await library.import('photo.JPEG', Buffer.from(bareJpeg()).toString('base64'))

  assert.equal(summary.characterId, 'photo')
  assert.equal(summary.avatarUrl, '/iris/avatar/photo')
})

test('bytes that are not a JPEG are refused by name, not imported', async t => {
  const { library } = await libraryFor(t)

  const refusal = await refusalOf(() =>
    library.import('fake.jpg', Buffer.from(parametersOnlyPng()).toString('base64')))

  assert.equal(refusal.code, 'invalid-request')
  assert.match(refusal.message, /not a JPEG/)
})

test('a corrupt PNG is still refused', async t => {
  const { library } = await libraryFor(t)
  const bytes = parametersOnlyPng()
  // Break the IHDR CRC: the file no longer parses as the image it claims to be.
  bytes[bytes.length - 2] = (bytes[bytes.length - 2] as number) ^ 0xff

  const refusal = await refusalOf(() =>
    library.import('broken.png', Buffer.from(bytes).toString('base64')))

  assert.equal(refusal.code, 'invalid-request')
  assert.match(refusal.message, /could not read the character card/)
})

test('extensions upstream also refuses keep their named rejection', async t => {
  const { library } = await libraryFor(t)

  for (const filename of ['card.webp', 'card.txt', 'card.gif']) {
    const refusal = await refusalOf(() => library.import(filename, Buffer.from('x').toString('base64')))
    assert.equal(refusal.code, 'invalid-request', filename)
    assert.match(refusal.message, /is not a \.png, \.jpg or \.json character card/, filename)
  }
})

test('a .charx is still refused as unsupported', async t => {
  const { library } = await libraryFor(t)

  const refusal = await refusalOf(() => library.import('card.charx', Buffer.from('x').toString('base64')))

  assert.equal(refusal.code, 'unsupported')
})

test('a card-bearing PNG still imports under the card\'s own name', async t => {
  const { library } = await libraryFor(t)

  // A real V2 card stamped into the image, alongside an unrelated `parameters`
  // chunk — the shape every corpus card has.
  const stamped = encodeCardPng(
    parametersOnlyPng(),
    normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '绿茵好莱坞', extensions: {} } }),
  )

  const summary = await library.import('whatever.png', Buffer.from(stamped).toString('base64'))

  assert.equal(summary.name, '绿茵好莱坞')
  assert.equal((await library.load(summary.characterId)).data.name, '绿茵好莱坞')
})

test('the stored empty-character file is the image that was uploaded', async t => {
  const { library, charactersDir } = await libraryFor(t)
  const bytes = parametersOnlyPng()

  await library.import('00043-409781020.png', Buffer.from(bytes).toString('base64'))

  const stored = await readFile(join(charactersDir, '00043-409781020.png'))
  assert.deepEqual(stored, Buffer.from(bytes))
})
