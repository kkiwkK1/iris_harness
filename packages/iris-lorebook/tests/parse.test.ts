import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_ORDER,
  LorebookParseError,
  convertAgnaiMemoryBook,
  convertLorebookDialect,
  convertNovelLorebook,
  convertRisuLorebook,
  entryDefaults,
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

// --- Dialect imports (ST world-info.js:5358/:5403/:5448) -------------------
//
// The samples are shaped after the upstream field lists: an Agnai memory book,
// a Risu lorebook and a NovelAI lorebook, each carrying one fully-populated
// entry plus one minimal one, because the minimal entry is where a mapping's
// fallback disagrees with ST's (the template default is applied by
// addMissingWorldInfoFields at load, and normalizeEntry is that same step).

test('an Agnai memory book maps keywords/name/entry/weight onto the ST shape', () => {
  const book = convertAgnaiMemoryBook({
    kind: 'memory',
    entries: [
      { keywords: ['meridian', 'vein'], name: 'Ley lines', entry: 'Power flows along them.', weight: 4, enabled: true },
      { keywords: ['quiet'], entry: 'Unmarked entry.' },
    ],
  })

  assert.deepEqual(Object.keys(book.entries), ['0', '1'])
  const named = at(book, 0)
  assert.deepEqual(named.key, ['meridian', 'vein'])
  assert.equal(named.comment, 'Ley lines')
  assert.equal(named.addMemo, true, 'a non-empty name ticks the memo box')
  assert.equal(named.content, 'Power flows along them.')
  assert.equal(named.order, 4, 'the Agnai weight becomes order verbatim')
  assert.equal(named.disable, false)
  assert.equal(named.selective, false, 'the dialect writes selective false over the template true')
  assert.equal(named.position, worldInfoPosition.before)

  const minimal = at(book, 1)
  assert.equal(minimal.comment, '')
  assert.equal(minimal.addMemo, false)
  assert.equal(minimal.disable, true, 'ST writes `!entry.enabled`, so a missing flag disables')
  assert.equal(minimal.order, DEFAULT_ORDER, 'a missing weight falls to the template default on load')
})

test('a Risu lorebook splits its comma-string keys and maps activationPercent', () => {
  const book = convertRisuLorebook({
    type: 'risu',
    data: [
      {
        key: 'ward, seal',
        secondkey: 'full moon, eclipse',
        comment: 'The barrier',
        content: 'It holds.',
        alwaysActive: true,
        selective: true,
        insertorder: 7,
        activationPercent: 60,
      },
      { key: 'plain', content: 'Minimal entry.' },
    ],
  })

  assert.deepEqual(Object.keys(book.entries), ['0', '1'])
  const full = at(book, 0)
  assert.deepEqual(full.key, ['ward', 'seal'], 'Risu keys are one comma-separated string')
  assert.deepEqual(full.keysecondary, ['full moon', 'eclipse'])
  assert.equal(full.comment, 'The barrier')
  assert.equal(full.constant, true, 'alwaysActive becomes constant')
  assert.equal(full.selective, true)
  assert.equal(full.order, 7)
  assert.equal(full.probability, 60)
  assert.equal(full.useProbability, true, 'ST writes `activationPercent ?? true`, never false')
  assert.equal(full.addMemo, true, 'Risu entries are always memo\'d')

  const minimal = at(book, 1)
  assert.deepEqual(minimal.key, ['plain'])
  assert.deepEqual(minimal.keysecondary, [])
  assert.equal(minimal.constant, false)
  assert.equal(minimal.selective, true, 'a missing selective falls to the template default on load')
  assert.equal(minimal.order, DEFAULT_ORDER)
  assert.equal(minimal.probability, 100)
  assert.equal(minimal.disable, false, 'Risu entries are imported enabled')
})

test('a NovelAI lorebook maps budgetPriority and the displayName memo rule', () => {
  const book = convertNovelLorebook({
    lorebookVersion: 4,
    entries: [
      {
        keys: ['crown'],
        displayName: 'The Crown',
        text: 'Worn by the regent.',
        enabled: true,
        contextConfig: { budgetPriority: 400 },
      },
      { keys: ['ruins'], text: 'No name, no budget.', enabled: false },
      { keys: ['crypt'], displayName: '   ', text: 'Blank name.', enabled: true },
    ],
  })

  assert.deepEqual(Object.keys(book.entries), ['0', '1', '2'])
  const titled = at(book, 0)
  assert.deepEqual(titled.key, ['crown'])
  assert.equal(titled.comment, 'The Crown')
  assert.equal(titled.addMemo, true)
  assert.equal(titled.content, 'Worn by the regent.')
  assert.equal(titled.order, 400, 'budgetPriority becomes order')
  assert.equal(titled.disable, false)
  assert.equal(titled.selective, false)

  const minimal = at(book, 1)
  assert.equal(minimal.comment, '')
  assert.equal(minimal.addMemo, false)
  assert.equal(minimal.disable, true)
  assert.equal(minimal.order, 0, 'a missing budgetPriority is a real 0, not the template 100')

  const blank = at(book, 2)
  assert.equal(blank.comment, '   ', 'ST writes `displayName || ""`, and whitespace is truthy')
  assert.equal(blank.addMemo, false, 'but the memo test trims, so a blank name ticks no box')
})

test('the dialect dispatch mirrors the importer\'s file features', () => {
  const novel = convertLorebookDialect({ lorebookVersion: 4, entries: [{ keys: ['a'], text: 'novel text', enabled: true }] })
  if (!novel) throw new Error('lorebookVersion did not dispatch to the NovelAI converter')
  assert.equal(at(novel, 0).content, 'novel text')

  const agnai = convertLorebookDialect({ kind: 'memory', entries: [{ keywords: ['a'], entry: 'agnai text' }] })
  if (!agnai) throw new Error('kind: memory did not dispatch to the Agnai converter')
  assert.equal(at(agnai, 0).content, 'agnai text')

  const risu = convertLorebookDialect({ type: 'risu', data: [{ key: 'a', content: 'risu text' }] })
  if (!risu) throw new Error('type: risu did not dispatch to the Risu converter')
  assert.equal(at(risu, 0).content, 'risu text')

  // An ST book carries none of the dialect features; the caller keeps using parseLorebook.
  assert.equal(convertLorebookDialect({ entries: { '0': { uid: 0, content: 'x' } } }), null)
  assert.equal(convertLorebookDialect('not a book'), null)
})

test('dialect conversion lands on the same normalization as parseLorebook', () => {
  // The superset invariant: whatever the dialect leaves unsaid, the entry says
  // after conversion — every template field present — and the result is
  // already in the shape parseLorebook returns, so the two import paths meet.
  const samples: Array<[string, Lorebook]> = [
    ['agnai', convertAgnaiMemoryBook({ kind: 'memory', entries: [{ keywords: ['a'], name: 'A', entry: 'x', weight: 1, enabled: true }] })],
    ['risu', convertRisuLorebook({ type: 'risu', data: [{ key: 'a', content: 'x' }] })],
    ['novel', convertNovelLorebook({ lorebookVersion: 4, entries: [{ keys: ['a'], text: 'x', enabled: true }] })],
  ]

  for (const [dialect, book] of samples) {
    for (const entry of Object.values(book.entries)) {
      for (const field of Object.keys(entryDefaults())) {
        assert.ok(field in entry, `${dialect} entry is missing template field ${field}`)
      }
    }
    assert.deepEqual(parseLorebook(book), book, `${dialect} output is already normalized`)
  }
})

test('a dialect file without its entry array is refused by name', () => {
  assert.throws(() => convertAgnaiMemoryBook({ kind: 'memory' }), LorebookParseError)
  assert.throws(() => convertRisuLorebook({ type: 'risu', entries: [] }), LorebookParseError)
  assert.throws(() => convertNovelLorebook({ lorebookVersion: 4 }), LorebookParseError)
})

