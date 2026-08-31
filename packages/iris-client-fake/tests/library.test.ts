import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readCard } from '../src/index.ts'
import { testClient } from './helpers.ts'

/** Build a PNG carrying one tEXt chunk, the way a character card does. */
function pngWithCard(keyword: string, json: string): string {
  const payload = Buffer.from(json, 'utf8').toString('base64')
  const body = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(payload, 'latin1')])

  const chunkOf = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    // The CRC is never read back — the fake's scanner walks lengths, not
    // checksums — so zeroes keep the fixture honest about what it is.
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkOf('IHDR', Buffer.alloc(13)),
    chunkOf('tEXt', body),
    chunkOf('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}

test('a V2 card in a chara chunk gives up its name, tags and creator', () => {
  const json = JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '络络', tags: ['原创', '悬疑'], creator: '灯塔' },
  })

  const card = readCard('luoluo.png', pngWithCard('chara', json))

  assert.equal(card.name, '络络')
  assert.deepEqual(card.tags, ['原创', '悬疑'])
  assert.equal(card.creator, '灯塔')
})

test('ccv3 wins over chara when a card carries both', () => {
  const v2 = JSON.stringify({ data: { name: 'old name' } })
  const v3 = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'new name' } })
  const payload = Buffer.from(pngWithCard('chara', v2), 'base64')
  const extra = Buffer.from(pngWithCard('ccv3', v3), 'base64')
  // Splice the ccv3 chunk in front of the IEND of the first file: a real V3
  // writer keeps the V2 block for older readers, so precedence has to be
  // decided by keyword rather than by position.
  const combined = Buffer.concat([payload.subarray(0, payload.length - 12), extra.subarray(8)])

  assert.equal(readCard('both.png', combined.toString('base64')).name, 'new name')
})

test('a flat V1 card still yields a name', () => {
  const json = JSON.stringify({ name: 'Flat Card', description: 'no data envelope' })
  assert.equal(readCard('flat.json', Buffer.from(json, 'utf8').toString('base64')).name, 'Flat Card')
})

test('an unreadable file falls back to the filename', () => {
  // The import path has to stay exercisable with a placeholder file; refusing
  // everything but a well-formed card would make the drop target untestable.
  const card = readCard('Mystery Guest.png', Buffer.from('not a png at all').toString('base64'))
  assert.equal(card.name, 'Mystery Guest')
  assert.deepEqual(card.tags, [])
  assert.equal(card.creator, undefined)
})

test('importing a card puts it at the front of the library', async () => {
  const client = testClient()
  const before = (await client.call('character.list', {})).characters.length

  const json = JSON.stringify({ data: { name: 'Imported', tags: ['test'] } })
  const { character } = await client.call('character.import', {
    filename: 'imported.png',
    content: pngWithCard('chara', json),
  })

  assert.equal(character.name, 'Imported')
  const after = (await client.call('character.list', {})).characters
  assert.equal(after.length, before + 1)
  assert.equal(after[0]?.characterId, character.characterId)

  client.dispose()
})

test('a new chat starts empty and titled after its character', async () => {
  const client = testClient()
  const { view } = await client.call('chat.create', { characterId: 'the-archivist' })

  assert.equal(view.title, 'The Archivist')
  assert.deepEqual(view.messages, [])

  const listed = (await client.call('chat.list', {})).chats
  assert.equal(listed[0]?.chatId, view.chatId)

  client.dispose()
})

test('creating a chat for a character that is not there is refused', async () => {
  const client = testClient()
  await assert.rejects(
    () => client.call('chat.create', { characterId: 'nobody' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
  client.dispose()
})

test('the empty option produces the empty states, not a crash', async () => {
  const { createFakeClient } = await import('../src/index.ts')
  const client = createFakeClient({ empty: true, chunkDelayMs: 0 })

  assert.deepEqual((await client.call('chat.list', {})).chats, [])
  assert.deepEqual((await client.call('character.list', {})).characters, [])

  client.dispose()
})
