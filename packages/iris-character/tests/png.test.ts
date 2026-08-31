import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'

import {
  crc32,
  decodeCardPng,
  decodeTextChunk,
  encodeCardPng,
  encodeTextChunk,
  normalizeCard,
  parsePngChunks,
  readCardChunks,
  serializePngChunks,
  type PngChunk,
} from '../src/index.ts'

/**
 * A genuinely valid 1x1 greyscale PNG, built here rather than committed as a
 * binary so the fixture is readable and the encoder is exercised on the way in.
 */
function blankPng(extra: readonly PngChunk[] = []): Uint8Array {
  const ihdr = new Uint8Array(13)
  const header = new DataView(ihdr.buffer)
  header.setUint32(0, 1) // width
  header.setUint32(4, 1) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive
  ihdr[12] = 0 // interlace: none

  // One scanline: a leading filter-type byte plus the single pixel.
  const idat = new Uint8Array(deflateSync(Uint8Array.of(0, 0)))

  return serializePngChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'IDAT', data: idat },
    ...extra,
    { type: 'IEND', data: new Uint8Array(0) },
  ])
}

/** Byte offset of each chunk's length field, so tests can poke at the framing. */
function chunkOffsets(png: Uint8Array): number[] {
  const offsets: number[] = []
  let offset = 8
  for (const chunk of parsePngChunks(png)) {
    offsets.push(offset)
    offset += chunk.data.length + 12
  }
  return offsets
}

/** Read a big-endian uint32, independently of the implementation under test. */
function readUint32(png: Uint8Array, offset: number): number {
  return new DataView(png.buffer, png.byteOffset, png.byteLength).getUint32(offset)
}

/** Base64 a card body the way a card exporter would. */
function payload(card: unknown): string {
  return Buffer.from(JSON.stringify(card), 'utf8').toString('base64')
}

/** A minimal V2 card body. */
function v2Card(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name, description: `${name} is here.`, extensions: {} },
  }
}

test('crc32 matches the standard check value', () => {
  // The CRC-32/ISO-HDLC check value for "123456789". If this drifts, every
  // chunk we write becomes unreadable to every other tool.
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('a card is read from a chara chunk', () => {
  const png = blankPng([encodeTextChunk('chara', payload(v2Card('络络')))])

  assert.equal(decodeCardPng(png).data.name, '络络')
})

test('ccv3 wins over chara when both are present', () => {
  const png = blankPng([
    encodeTextChunk('chara', payload(v2Card('过时的名字'))),
    encodeTextChunk('ccv3', payload({ ...v2Card('当前的名字'), spec: 'chara_card_v3', spec_version: '3.0' })),
  ])

  const card = decodeCardPng(png)
  assert.equal(card.data.name, '当前的名字')
  assert.equal(card.spec, 'chara_card_v3')
})

test('the keyword match is case-insensitive', () => {
  // Cards written by other tools do turn up with a capitalised keyword.
  const png = blankPng([encodeTextChunk('Chara', payload(v2Card('Luoluo')))])

  assert.equal(decodeCardPng(png).data.name, 'Luoluo')
})

test('a PNG with no card chunk throws', () => {
  assert.throws(() => decodeCardPng(blankPng()), /no character card/)
})

test('bytes that are not a PNG are rejected before anything else', () => {
  assert.throws(() => decodeCardPng(new TextEncoder().encode('not a png at all')), /bad file signature/)
})

test('export writes both chunks and they round-trip', () => {
  const card = normalizeCard(v2Card('络络'))
  const png = encodeCardPng(blankPng(), card)

  const chunks = readCardChunks(png)
  assert.ok(chunks.chara !== undefined, 'the V2 chunk is written')
  assert.ok(chunks.ccv3 !== undefined, 'the V3 chunk is written')

  const chara = JSON.parse(Buffer.from(chunks.chara, 'base64').toString('utf8')) as Record<string, unknown>
  const ccv3 = JSON.parse(Buffer.from(chunks.ccv3, 'base64').toString('utf8')) as Record<string, unknown>
  assert.equal(chara.spec, 'chara_card_v2')
  assert.equal(chara.spec_version, '2.0')
  assert.equal(ccv3.spec, 'chara_card_v3')
  assert.equal(ccv3.spec_version, '3.0')
  // The two chunks differ only in the spec stamp, exactly as upstream writes them.
  assert.deepEqual(ccv3.data, chara.data)

  // Reading back promotes the card to V3: export writes both chunks and the
  // reader prefers `ccv3`. That is upstream's behaviour too — the body is what
  // has to survive, not the stamp on it.
  const reread = decodeCardPng(png)
  assert.equal(reread.spec, 'chara_card_v3')
  assert.deepEqual(reread.data, card.data)
})

test('the card chunks are inserted immediately before IEND', () => {
  const types = parsePngChunks(encodeCardPng(blankPng(), normalizeCard(v2Card('络络')))).map(chunk => chunk.type)

  assert.deepEqual(types, ['IHDR', 'IDAT', 'tEXt', 'tEXt', 'IEND'])
})

test('re-encoding replaces the old card rather than stacking a second one', () => {
  const first = encodeCardPng(blankPng(), normalizeCard(v2Card('第一版')))
  const second = encodeCardPng(first, normalizeCard(v2Card('第二版')))

  const textChunks = parsePngChunks(second).filter(chunk => chunk.type === 'tEXt')
  assert.equal(textChunks.length, 2)
  assert.equal(decodeCardPng(second).data.name, '第二版')
})

test('unrelated tEXt chunks survive an export', () => {
  const png = encodeCardPng(
    blankPng([encodeTextChunk('Software', 'Some Other Editor')]),
    normalizeCard(v2Card('络络')),
  )

  const keywords = parsePngChunks(png)
    .filter(chunk => chunk.type === 'tEXt')
    .map(chunk => decodeTextChunk(chunk.data)?.keyword)
  assert.deepEqual(keywords, ['Software', 'chara', 'ccv3'])
})

test('every CRC we write is correct', () => {
  const png = encodeCardPng(blankPng(), normalizeCard(v2Card('络络')))

  // Re-reading verifies each chunk's CRC, so reaching this line at all is the
  // assertion; recomputing independently pins that it is not vacuous.
  const chunks = parsePngChunks(png)
  const offsets = chunkOffsets(png)
  chunks.forEach((chunk, index) => {
    const start = offsets[index] as number
    const end = start + 8 + chunk.data.length
    assert.equal(readUint32(png, end), crc32(png.subarray(start + 4, end)), `${chunk.type} CRC`)
  })
})

test('a corrupted chunk is rejected rather than silently decoded', () => {
  const png = encodeCardPng(blankPng(), normalizeCard(v2Card('络络')))
  const chunks = parsePngChunks(png)
  const textIndex = chunks.findIndex(chunk => chunk.type === 'tEXt')

  // Flip a byte inside the base64 payload; the CRC no longer describes it.
  const payloadStart = (chunkOffsets(png)[textIndex] as number) + 8
  png[payloadStart + 10] = (png[payloadStart + 10] as number) ^ 0xff

  assert.throws(() => decodeCardPng(png), /CRC mismatch/)
})

test('a non-UTF-8-safe name survives the base64 hop', () => {
  // The chunk itself is Latin-1, so the card body has to reach it as base64 of
  // UTF-8 bytes; a Latin-1 round trip of the JSON would mangle this.
  const card = normalizeCard(v2Card('络络 🦊'))

  assert.equal(decodeCardPng(encodeCardPng(blankPng(), card)).data.name, '络络 🦊')
})

test('unknown data.extensions keys survive decode, encode and decode again', () => {
  const png = blankPng([
    encodeTextChunk('chara', payload({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '络络',
        extensions: {
          talkativeness: 0.7,
          depth_prompt: { depth: 4, prompt: '保持角色', role: 'system' },
          // An invented vendor namespace: nothing in this package knows what
          // it means, and that is precisely why it has to come out unchanged.
          traven_lab: {
            version: 3,
            nested: { enabled: true, weights: [1, 2, 3], label: '实验性' },
          },
        },
      },
    })),
  ])

  const decoded = decodeCardPng(png)
  const reDecoded = decodeCardPng(encodeCardPng(blankPng(), decoded))

  assert.deepEqual(reDecoded.data.extensions.traven_lab, {
    version: 3,
    nested: { enabled: true, weights: [1, 2, 3], label: '实验性' },
  })
  // Nothing else in the body moved either; only the spec stamp is promoted.
  assert.deepEqual(reDecoded.data, decoded.data)
  assert.equal(reDecoded.spec, 'chara_card_v3')
})

test('a tEXt payload containing a NUL is read rather than rejected', () => {
  // `png-chunk-text` throws here. A stray byte in someone else's comment chunk
  // is no reason to fail an import.
  const data = Uint8Array.of(0x61, 0x00, 0x62, 0x00, 0x63)

  assert.deepEqual(decodeTextChunk(data), { keyword: 'a', text: 'b\u0000c' })
})

test('a truncated PNG is reported rather than read past', () => {
  const png = blankPng()

  assert.throws(() => parsePngChunks(png.subarray(0, png.length - 6)), /truncated|no IEND/)
})
