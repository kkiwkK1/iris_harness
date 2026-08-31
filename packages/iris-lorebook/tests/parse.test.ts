import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LorebookParseError,
  fromCharacterBook,
  parseDecorators,
  parseLorebook,
  promptRole,
  serializeLorebook,
  toCharacterBook,
  worldInfoLogic,
  worldInfoPosition,
  type Lorebook,
  type LorebookEntry,
} from '../src/index.ts'

/** Reach into the uid-keyed object without fighting `noUncheckedIndexedAccess`. */
function at(book: Lorebook, uid: number): LorebookEntry {
  const entry = book.entries[String(uid)]
  if (!entry) throw new Error(`no entry ${uid} in [${Object.keys(book.entries).join(', ')}]`)
  return entry
}

test('the ST shape keys entries by uid, not by array index', () => {
  const book = parseLorebook({
    entries: {
      '7': { uid: 7, key: ['dragon'], content: 'It breathes fire.' },
    },
  })

  assert.deepEqual(Object.keys(book.entries), ['7'])
  assert.equal(at(book, 7).key[0], 'dragon')
})

test('missing fields are filled with SillyTavern\'s template defaults', () => {
  const entry = at(parseLorebook({ entries: { '0': { uid: 0 } } }), 0)

  assert.equal(entry.order, 100)
  assert.equal(entry.position, worldInfoPosition.before)
  assert.equal(entry.selectiveLogic, worldInfoLogic.AND_ANY)
  assert.equal(entry.probability, 100)
  assert.equal(entry.useProbability, true)
  assert.equal(entry.depth, 4)
  assert.equal(entry.groupWeight, 100)
  assert.equal(entry.role, promptRole.SYSTEM)
  // The three-state fields stay null so the global setting still applies.
  assert.equal(entry.scanDepth, null)
  assert.equal(entry.caseSensitive, null)
  assert.equal(entry.matchWholeWords, null)
  assert.deepEqual(entry.characterFilter, { isExclude: false, names: [], tags: [] })
})

test('unknown keys survive a round trip', () => {
  const raw = {
    name: 'Test Book',
    someToolWroteThis: { version: 3 },
    entries: {
      '0': { uid: 0, content: 'x', myExtensionState: { seen: true }, chubId: 'abc' },
    },
  }

  const out = serializeLorebook(parseLorebook(raw))

  assert.equal(out['name'], 'Test Book')
  assert.deepEqual(out['someToolWroteThis'], { version: 3 })
  assert.deepEqual(at(out, 0)['myExtensionState'], { seen: true })
  assert.equal(at(out, 0)['chubId'], 'abc')
})

test('serializing detaches the copy', () => {
  const book = parseLorebook({ entries: { '0': { uid: 0, content: 'x' } } })
  const copy = serializeLorebook(book)
  at(copy, 0).content = 'mutated'

  assert.equal(at(book, 0).content, 'x')
})

test('malformed field types are repaired rather than trusted', () => {
  const entry = at(parseLorebook({
    entries: {
      '0': { uid: 0, key: 'dragon, wyvern', keysecondary: null, probability: '80', characterFilter: [] },
    },
  }), 0)

  assert.deepEqual(entry.key, ['dragon', 'wyvern'], 'plaintext key input is comma-separated')
  assert.deepEqual(entry.keysecondary, [])
  assert.equal(entry.probability, 80)
  assert.deepEqual(entry.characterFilter, { isExclude: false, names: [], tags: [] })
})

test('an entries array is accepted and re-keyed by uid', () => {
  const book = parseLorebook({ entries: [{ content: 'a' }, { content: 'b' }] })

  assert.deepEqual(Object.keys(book.entries), ['0', '1'])
  assert.equal(at(book, 1).content, 'b')
})

test('input that is not a world book is refused', () => {
  assert.throws(() => parseLorebook(null), LorebookParseError)
  assert.throws(() => parseLorebook({ notEntries: {} }), LorebookParseError)
  assert.throws(() => fromCharacterBook({ entries: {} }), LorebookParseError)
})

test('the card spec\'s character_book maps onto the ST shape', () => {
  const book = fromCharacterBook({
    name: 'Embedded',
    extensions: {},
    entries: [
      {
        id: 3,
        keys: ['dragon'],
        secondary_keys: ['cave'],
        content: 'It hoards gold.',
        insertion_order: 42,
        position: 'after_char',
        enabled: false,
        selective: true,
        case_sensitive: true,
        comment: 'The dragon',
        extensions: { group: 'beasts', sticky: 3, vendorField: 'keep me' },
      },
    ],
  })

  const entry = at(book, 3)
  assert.deepEqual(entry.key, ['dragon'])
  assert.deepEqual(entry.keysecondary, ['cave'])
  assert.equal(entry.order, 42, 'insertion_order becomes order')
  assert.equal(entry.position, worldInfoPosition.after, 'after_char becomes 1')
  assert.equal(entry.disable, true, 'enabled is inverted')
  assert.equal(entry.group, 'beasts')
  assert.equal(entry.sticky, 3)
  assert.equal(entry.caseSensitive, true, 'the spec-level flag is honoured when extensions are silent')
  assert.equal(book['name'], 'Embedded', 'book-level fields are kept')
})

test('extensions.position wins over the spec position field', () => {
  // The spec can only say "before" or "after"; a card written by ST carries the
  // real position in extensions, and losing it would move depth-injected
  // entries to the top of the prompt.
  const book = fromCharacterBook({
    entries: [{
      keys: [], content: 'x', insertion_order: 0, enabled: true,
      position: 'before_char',
      extensions: { position: worldInfoPosition.atDepth, depth: 2, role: promptRole.USER },
    }],
  })

  assert.equal(at(book, 0).position, worldInfoPosition.atDepth)
  assert.equal(at(book, 0).depth, 2)
  assert.equal(at(book, 0).role, promptRole.USER)
})

test('a spec entry\'s unmapped fields ride through both directions', () => {
  const book = fromCharacterBook({
    entries: [{
      keys: ['a'], content: 'x', insertion_order: 5, enabled: true,
      use_regex: true, name: 'Entry name', priority: 10,
      extensions: { vendorField: 'keep me' },
    }],
  })

  assert.equal(at(book, 0)['use_regex'], true)
  assert.equal(at(book, 0)['name'], 'Entry name')

  const [exported] = toCharacterBook(book).entries
  if (!exported) throw new Error('no entry exported')
  assert.equal(exported['use_regex'], true)
  assert.equal(exported['priority'], 10)
  assert.equal(exported.insertion_order, 5)
  assert.equal(exported.enabled, true)
  assert.deepEqual(exported.extensions['vendorField'], 'keep me')
})

test('a character_book round trip is stable', () => {
  const original = {
    entries: [{
      id: 1,
      keys: ['dragon'],
      secondary_keys: [],
      content: 'It hoards gold.',
      insertion_order: 42,
      position: 'after_char',
      enabled: true,
      selective: false,
      comment: 'The dragon',
      extensions: { group: 'beasts', vendorField: 1 },
    }],
  }

  const once = toCharacterBook(fromCharacterBook(original))
  const twice = toCharacterBook(fromCharacterBook(once))

  assert.deepEqual(twice, once)
})

test('decorators are lifted off the front of the content', () => {
  assert.deepEqual(parseDecorators('@@activate\nThe real body.'), [['@@activate'], 'The real body.'])
  assert.deepEqual(parseDecorators('No decorators here.'), [[], 'No decorators here.'])
})

test('an unknown decorator opens its @@@ fallback chain', () => {
  // `@@@` lines are alternatives, not comments: they are skipped while the
  // primary decorator was understood, and consulted once it was not.
  assert.deepEqual(
    parseDecorators('@@unknown_thing\n@@@dont_activate\nBody.'),
    [['@@dont_activate'], 'Body.'],
  )
  assert.deepEqual(
    parseDecorators('@@activate\n@@@dont_activate\nBody.'),
    [['@@activate'], 'Body.'],
  )
})
