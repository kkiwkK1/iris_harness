import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveTranslation, translationSlots, type TranslationOriginals } from '../src/st-extensions/projection-i18n.ts'

function originals(text: string, attributes: Record<string, string> = {}): TranslationOriginals {
  return { text, attributes: new Map(Object.entries(attributes)) }
}

const ZH: Record<string, string> = {
  'Prompt template settings': '提示词模板',
  'PT Enable': '是否启用扩展',
  'Global switch': '全局开关',
}

test('a bare key is a text slot; [attribute]key is an attribute slot; ; separates', () => {
  assert.deepEqual(translationSlots('PT Enable'), [{ key: 'PT Enable' }])
  assert.deepEqual(translationSlots('[title]Global switch'), [{ attribute: 'title', key: 'Global switch' }])
  assert.deepEqual(
    translationSlots('[title]Global switch; PT Enable'),
    [{ attribute: 'title', key: 'Global switch' }, { key: 'PT Enable' }],
  )
  assert.deepEqual(translationSlots('  '), [])
})

test('a declared key with a table entry resolves to the translation', () => {
  assert.equal(resolveTranslation({ key: 'PT Enable' }, ZH, originals('Enable extension')), '是否启用扩展')
  assert.equal(
    resolveTranslation({ attribute: 'title', key: 'Global switch' }, ZH, originals('x', { title: 'Global switch' })),
    '全局开关',
  )
})

test('a key the table does not carry resolves to the ORIGINAL — this is the switch-back', () => {
  // The decisive rule: the app switched to English, the extension ships no
  // English table, and the panel must not keep the Chinese it was given.
  assert.equal(resolveTranslation({ key: 'PT Enable' }, {}, originals('Enable extension')), 'Enable extension')
})

test('an attribute the table does not carry restores the attribute\'s own original, not the text', () => {
  assert.equal(
    resolveTranslation({ attribute: 'title', key: 'Global switch' }, {}, originals('Enable extension', { title: 'Global switch' })),
    'Global switch',
  )
})

test('an attribute with no recorded original restores empty rather than throwing', () => {
  assert.equal(resolveTranslation({ attribute: 'title', key: 'Missing' }, {}, originals('x')), '')
})

test('an empty translated string is a real translation and wins over the original', () => {
  // A table that deliberately blanks a string (a locale that drops a label)
  // must be honoured: `undefined` is absence, `''` is an answer.
  assert.equal(resolveTranslation({ key: 'PT Enable' }, { 'PT Enable': '' }, originals('Enable extension')), '')
})

test('the two directions round-trip on the same originals', () => {
  const source = originals('Enable extension', { title: 'Global switch' })
  const textSlot = { key: 'PT Enable' }
  const titleSlot = { attribute: 'title', key: 'Global switch' }

  const toZh = [resolveTranslation(textSlot, ZH, source), resolveTranslation(titleSlot, ZH, source)]
  assert.deepEqual(toZh, ['是否启用扩展', '全局开关'])

  const backToEn = [resolveTranslation(textSlot, {}, source), resolveTranslation(titleSlot, {}, source)]
  assert.deepEqual(backToEn, ['Enable extension', 'Global switch'])
})
