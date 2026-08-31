import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeCard, toV2, toV3, type CharacterCard } from '../src/index.ts'

/** A flat V1 card, the shape that predates `spec` entirely. */
function v1Card(): Record<string, unknown> {
  return {
    name: '络络',
    description: '一位森林里的魔女。',
    personality: '好奇、爱捉弄人',
    scenario: '在废弃的图书馆里相遇。',
    first_mes: '你好呀，旅人。',
    mes_example: '<START>\n{{user}}: 你是谁？\n{{char}}: 秘密。',
    creatorcomment: '请不要用于商业用途。',
    tags: ['魔女', '奇幻'],
    talkativeness: 0.8,
    fav: true,
    create_date: '2026-6-1 @10h 05m 00s',
  }
}

test('a V1 card is lifted into a V2 body', () => {
  const card = normalizeCard(v1Card())

  assert.equal(card.spec, 'chara_card_v2')
  assert.equal(card.spec_version, '2.0')
  assert.equal(card.data.name, '络络')
  assert.equal(card.data.first_mes, '你好呀，旅人。')
  // The V1 spelling of the field is `creatorcomment`.
  assert.equal(card.data.creator_notes, '请不要用于商业用途。')
  assert.deepEqual(card.data.tags, ['魔女', '奇幻'])
  // Fields V1 has no room for still have to exist for callers.
  assert.equal(card.data.system_prompt, '')
  assert.deepEqual(card.data.alternate_greetings, [])
})

test('V1 conversion materialises the ST extension defaults', () => {
  const card = normalizeCard(v1Card())

  assert.equal(card.data.extensions.talkativeness, 0.8)
  assert.equal(card.data.extensions.world, '')
  assert.deepEqual(card.data.extensions.depth_prompt, { prompt: '', depth: 4, role: 'system' })
})

test('V1 talkativeness falls back to 0.5 rather than 0', () => {
  const raw = v1Card()
  delete raw.talkativeness

  assert.equal(normalizeCard(raw).data.extensions.talkativeness, 0.5)
})

test('a genuine boolean fav is honoured, not just the string form', () => {
  // Upstream computes `fav == 'true'`, which reads a JSON card's `fav: true`
  // as false. Deliberate divergence.
  assert.equal(normalizeCard(v1Card()).data.extensions.fav, true)
  assert.equal(normalizeCard({ ...v1Card(), fav: 'true' }).data.extensions.fav, true)
  assert.equal(normalizeCard({ ...v1Card(), fav: false }).data.extensions.fav, false)
})

test('V1 keys the conversion consumed are not left duplicated at the top level', () => {
  const card = normalizeCard(v1Card())

  assert.equal('creatorcomment' in card, false)
  assert.equal('talkativeness' in card, false)
  // Anything the conversion did not consume stays put.
  assert.equal(card.create_date, '2026-6-1 @10h 05m 00s')
})

test('tags accept the comma-separated form SillyTavern forms post', () => {
  assert.deepEqual(normalizeCard({ ...v1Card(), tags: '魔女, 奇幻 , ' }).data.tags, ['魔女', '奇幻'])
})

test('a lone alternate greeting is read as a one-element list', () => {
  assert.deepEqual(normalizeCard({ ...v1Card(), alternate_greetings: '又见面了。' }).data.alternate_greetings, ['又见面了。'])
})

test('a V2 card keeps unknown keys in data, in extensions, and at the top level', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    avatar: 'luoluo.png',
    some_exporter_stamp: { run: 7 },
    data: {
      name: '络络',
      extensions: {
        chub: { full_path: 'author/luoluo' },
        risuai: { source: ['risu:abcd'] },
        pygmalion_id: 'pyg-123',
        traven_lab: { nested: { weights: [1, 2, 3] } },
      },
      a_field_no_spec_defines: ['keep', 'me'],
    },
  })

  assert.deepEqual(card.data.extensions.chub, { full_path: 'author/luoluo' })
  assert.equal(card.data.extensions.pygmalion_id, 'pyg-123')
  assert.deepEqual(card.data.extensions.traven_lab, { nested: { weights: [1, 2, 3] } })
  assert.deepEqual(card.data.a_field_no_spec_defines, ['keep', 'me'])
  assert.deepEqual(card.some_exporter_stamp, { run: 7 })
  assert.equal(card.avatar, 'luoluo.png')
})

test('a V2 card gets no invented extension defaults', () => {
  // An absent `talkativeness` means the author never set one; writing 0.5 in
  // would change a card we were only asked to read.
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '络络' } })

  assert.deepEqual(card.data.extensions, {})
})

test('a V3 card keeps its spec and its V3-only fields', () => {
  const card = normalizeCard({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '络络',
      nickname: '小络',
      creator_notes_multilingual: { zh: '中文说明', en: 'English notes' },
      source: ['https://example.invalid/luoluo'],
      group_only_greetings: ['大家好。'],
      creation_date: 1_780_000_000_000,
      assets: [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }],
      extensions: {},
    },
  })

  assert.equal(card.spec, 'chara_card_v3')
  assert.equal(card.data.nickname, '小络')
  assert.deepEqual(card.data.group_only_greetings, ['大家好。'])
  assert.deepEqual(card.data.assets, [{ type: 'icon', uri: 'embeded://assets/main.png', name: 'main', ext: 'png' }])
})

test('an embedded character book keeps its entries and its unknown fields', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '络络',
      extensions: {},
      character_book: {
        name: '森林',
        scan_depth: 2,
        entries: [{ keys: ['魔女'], content: '森林深处的传说。', enabled: true, insertion_order: 0, extensions: {} }],
        some_vendor_field: 'kept',
      },
    },
  })

  assert.equal(card.data.character_book?.entries.length, 1)
  assert.equal(card.data.character_book?.name, '森林')
  assert.equal(card.data.character_book?.some_vendor_field, 'kept')
  assert.deepEqual(card.data.character_book?.extensions, {})
})

test('a book with no extensions bag is given the empty one the spec requires', () => {
  // The only field normalisation adds to somebody else's data. SillyTavern's
  // own bundled cards omit it, so this fires on real input.
  const card = normalizeCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '络络', extensions: {}, character_book: { name: '森林', entries: [] } },
  })

  assert.deepEqual(card.data.character_book?.extensions, {})
})

test('toV2 writes the V1 mirror fields alongside data', () => {
  const file = toV2(normalizeCard(v1Card()))

  assert.equal(file.spec, 'chara_card_v2')
  assert.equal(file.spec_version, '2.0')
  assert.equal(file.name, '络络')
  assert.equal(file.creatorcomment, '请不要用于商业用途。')
  assert.equal(file.talkativeness, 0.8)
  assert.equal(file.fav, true)
  assert.equal(file.data.name, file.name)
})

test('toV3 differs from toV2 only in the spec stamp', () => {
  const card = normalizeCard(v1Card())
  const v2 = toV2(card)
  const v3 = toV3(card)

  assert.equal(v3.spec, 'chara_card_v3')
  assert.equal(v3.spec_version, '3.0')
  assert.deepEqual({ ...v3, spec: v2.spec, spec_version: v2.spec_version }, v2)
})

test('serialising does not hand out the card own data object', () => {
  const card = normalizeCard(v1Card())
  const file = toV2(card)
  file.data.name = '别的名字'

  assert.equal(card.data.name, '络络')
})

test('normalise -> serialise -> normalise is lossless', () => {
  const card = normalizeCard({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    an_unknown_top_level_key: { kept: true },
    data: {
      name: '络络',
      description: '一位森林里的魔女。',
      nickname: '小络',
      alternate_greetings: ['又见面了。'],
      tags: ['魔女'],
      extensions: { talkativeness: 0.8, fav: false, traven_lab: { nested: [1, { deep: '值' }] } },
      an_unknown_data_key: 'kept',
    },
  })

  assert.deepEqual(normalizeCard(toV3(card)), card)
  // The V2 hop only restamps the spec fields; everything else must survive it.
  const viaV2: CharacterCard = normalizeCard(toV2(card))
  assert.deepEqual({ ...viaV2, spec: card.spec, spec_version: card.spec_version }, card)
})

test('input that is not an object is rejected', () => {
  assert.throws(() => normalizeCard('络络'), /must be a JSON object/)
  assert.throws(() => normalizeCard(null), /must be a JSON object/)
  assert.throws(() => normalizeCard([1, 2, 3]), /must be a JSON object/)
})

test('a card claiming a spec but missing data is read through its V1 mirrors', () => {
  // Seen in the wild from half-finished exporters; the mirrors are then the
  // only surviving copy of the character.
  const card = normalizeCard({ spec: 'chara_card_v2', spec_version: '2.0', ...v1Card() })

  assert.equal(card.data.name, '络络')
  assert.equal(card.data.creator_notes, '请不要用于商业用途。')
})
