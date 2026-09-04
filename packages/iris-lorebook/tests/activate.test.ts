import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  activateEntries,
  createEntry,
  mulberry32,
  promptRole,
  worldInfoLogic,
  worldInfoPosition,
  type ActivationResult,
  type LorebookEntry,
  type ScanEntry,
} from '../src/index.ts'

/** Build a scan-ready entry. Every field not named here takes its ST default. */
function entry(overrides: Partial<LorebookEntry> & { uid: number }): ScanEntry {
  return { ...createEntry(overrides), world: 'test' }
}

/** Which entries made it in, in a stable order for comparison. */
function uids(result: ActivationResult): number[] {
  return result.activated.map((activated) => activated.uid).sort((a, b) => a - b)
}

/** A pinned RNG. Every roll in these tests is reproducible. */
function rng(seed = 1): () => number {
  return mulberry32(seed)
}

test('a constant entry fires with no chat and no keys', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, constant: true, content: 'Always present.' })],
    chat: [],
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
})

test('a keyword entry fires only when its key is in the scanned window', () => {
  const dragon = entry({ uid: 0, key: ['dragon'], content: 'It hoards gold.' })

  assert.deepEqual(uids(activateEntries({ entries: [dragon], chat: ['A dragon lands.'], random: rng() })), [0])
  assert.deepEqual(uids(activateEntries({ entries: [dragon], chat: ['Nothing here.'], random: rng() })), [])
})

test('key matching honours per-entry case and whole-word overrides', () => {
  const cases: Array<{ overrides: Partial<LorebookEntry>; chat: string; expected: number[] }> = [
    { overrides: { key: ['Dragon'], caseSensitive: true }, chat: 'a dragon lands', expected: [] },
    { overrides: { key: ['Dragon'], caseSensitive: true }, chat: 'a Dragon lands', expected: [0] },
    { overrides: { key: ['Dragon'] }, chat: 'a dragon lands', expected: [0] },
    // The global default is substring (ST's `false`); the boundary is per-entry.
    { overrides: { key: ['cat'] }, chat: 'concatenate', expected: [0] },
    { overrides: { key: ['cat'], matchWholeWords: true }, chat: 'concatenate', expected: [] },
    { overrides: { key: ['/dr.gon/i'] }, chat: 'a DRAGON lands', expected: [0] },
    { overrides: { key: ['/dr.gon/'] }, chat: 'a DRAGON lands', expected: [] },
  ]

  for (const { overrides, chat, expected } of cases) {
    const result = activateEntries({
      entries: [entry({ uid: 0, content: 'x', ...overrides })],
      chat: [chat],
      random: rng(),
    })
    assert.deepEqual(uids(result), expected, `${JSON.stringify(overrides)} against "${chat}"`)
  }
})

test('selectiveLogic decides whether a primary hit survives its secondary keys', () => {
  const cases: Array<{ logic: number; chat: string; expected: number[]; why: string }> = [
    { logic: worldInfoLogic.AND_ANY, chat: 'the dragon in a cave', expected: [0], why: 'a secondary matched' },
    { logic: worldInfoLogic.AND_ANY, chat: 'the dragon flies', expected: [], why: 'no secondary matched' },
    { logic: worldInfoLogic.NOT_ALL, chat: 'the dragon in a cave', expected: [0], why: 'gold is missing' },
    { logic: worldInfoLogic.NOT_ALL, chat: 'the dragon in a cave with gold', expected: [], why: 'both present' },
    { logic: worldInfoLogic.NOT_ANY, chat: 'the dragon flies', expected: [0], why: 'neither present' },
    { logic: worldInfoLogic.NOT_ANY, chat: 'the dragon in a cave', expected: [], why: 'cave present' },
    { logic: worldInfoLogic.AND_ALL, chat: 'the dragon in a cave with gold', expected: [0], why: 'both present' },
    { logic: worldInfoLogic.AND_ALL, chat: 'the dragon in a cave', expected: [], why: 'gold missing' },
  ]

  for (const { logic, chat, expected, why } of cases) {
    const result = activateEntries({
      entries: [entry({
        uid: 0,
        key: ['dragon'],
        keysecondary: ['cave', 'gold'],
        selectiveLogic: logic,
        content: 'x',
      })],
      chat: [chat],
      random: rng(),
    })
    assert.deepEqual(uids(result), expected, why)
  }
})

test('secondary keys are ignored when the entry is not selective', () => {
  const result = activateEntries({
    entries: [entry({
      uid: 0,
      key: ['dragon'],
      keysecondary: ['cave'],
      selective: false,
      selectiveLogic: worldInfoLogic.AND_ALL,
      content: 'x',
    })],
    chat: ['a dragon flies'],
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
})

test('scan depth limits how far back a key is seen', () => {
  const buried = entry({ uid: 0, key: ['excalibur'], content: 'x' })
  // Most recent message first, the order checkWorldInfo is given.
  const chat = ['nothing', 'nothing either', 'they found excalibur']

  assert.deepEqual(uids(activateEntries({ entries: [buried], chat, random: rng() })), [], 'default depth is 2')
  assert.deepEqual(
    uids(activateEntries({ entries: [buried], chat, settings: { scanDepth: 3 }, random: rng() })),
    [0],
    'the global depth reaches it',
  )
  assert.deepEqual(
    uids(activateEntries({ entries: [entry({ ...buried, scanDepth: 3 })], chat, random: rng() })),
    [0],
    'the per-entry override reaches it',
  )
})

test('a key cannot match across the seam between two messages', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, key: ['red dragon'], content: 'x' })],
    chat: ['dragon woke', 'the sky turned red'],
    random: rng(),
  })

  assert.deepEqual(uids(result), [], 'the phrase was never actually said')
})

test('probability is rolled against the injected RNG', () => {
  const rolled = (probability: number): number[] => uids(activateEntries({
    entries: [entry({ uid: 0, constant: true, probability, content: 'x' })],
    chat: [],
    random: rng(4),
  }))

  assert.deepEqual(rolled(100), [0], '100% short-circuits without consuming a roll')
  assert.deepEqual(rolled(0), [], '0% can never pass')
})

test('useProbability false skips the roll entirely', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, constant: true, probability: 0, useProbability: false, content: 'x' })],
    chat: [],
    random: () => 0.99,
  })

  assert.deepEqual(uids(result), [0])
})

test('a pinned RNG makes a partial-probability scan reproducible', () => {
  // This is what keeps a swipe from flickering an entry in and out: the same
  // seed replays the same rolls.
  const scan = (): ActivationResult => activateEntries({
    entries: [
      entry({ uid: 0, constant: true, probability: 50, content: 'a' }),
      entry({ uid: 1, constant: true, probability: 50, content: 'b' }),
      entry({ uid: 2, constant: true, probability: 50, content: 'c' }),
    ],
    chat: [],
    random: rng(99),
  })

  assert.deepEqual(uids(scan()), uids(scan()))
})

test('recursion finds an entry whose key appears only in another entry\'s content', () => {
  const entries = [
    entry({ uid: 0, constant: true, content: 'The knight carries Excalibur.' }),
    entry({ uid: 1, key: ['excalibur'], content: 'A sword of legend.' }),
  ]

  assert.deepEqual(
    uids(activateEntries({ entries, chat: ['Hello.'], settings: { recursive: true }, random: rng() })),
    [0, 1],
  )
  assert.deepEqual(
    uids(activateEntries({ entries, chat: ['Hello.'], random: rng() })),
    [0],
    'recursion is off by default, matching ST',
  )
})

test('preventRecursion stops an entry from feeding the next pass', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, preventRecursion: true, content: 'The knight carries Excalibur.' }),
      entry({ uid: 1, key: ['excalibur'], content: 'A sword of legend.' }),
    ],
    chat: ['Hello.'],
    settings: { recursive: true },
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
})

test('excludeRecursion keeps an entry out of a recursion pass but not out of the first one', () => {
  const source = entry({ uid: 0, constant: true, content: 'The knight carries Excalibur.' })
  const excluded = entry({ uid: 1, key: ['excalibur'], excludeRecursion: true, content: 'A sword of legend.' })

  assert.deepEqual(
    uids(activateEntries({ entries: [source, excluded], chat: ['Hello.'], settings: { recursive: true }, random: rng() })),
    [0],
    'recursion cannot reach it',
  )
  assert.deepEqual(
    uids(activateEntries({
      entries: [source, excluded],
      chat: ['He drew Excalibur.'],
      settings: { recursive: true },
      random: rng(),
    })),
    [0, 1],
    'the chat still can',
  )
})

test('delayUntilRecursion holds an entry back to its recursion level', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, content: 'The knight carries Excalibur.' }),
      entry({ uid: 1, key: ['excalibur'], delayUntilRecursion: true, content: 'A sword of legend.' }),
    ],
    chat: ['He drew Excalibur.'],
    settings: { recursive: true },
    random: rng(),
  })

  assert.deepEqual(uids(result), [0, 1], 'it fires on the recursion pass, not the first')
})

test('maxRecursionSteps caps the loop', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, content: 'Mentions Excalibur.' }),
      entry({ uid: 1, key: ['excalibur'], content: 'Which was forged in Avalon.' }),
      entry({ uid: 2, key: ['avalon'], content: 'An island.' }),
    ],
    chat: ['Hello.'],
    settings: { recursive: true, maxRecursionSteps: 2 },
    random: rng(),
  })

  assert.equal(result.loops, 2)
  assert.deepEqual(uids(result), [0, 1])
})

test('the token budget drops the lowest-priority entries', () => {
  const entries = [
    entry({ uid: 0, constant: true, order: 300, content: 'a'.repeat(10) }),
    entry({ uid: 1, constant: true, order: 200, content: 'b'.repeat(10) }),
    entry({ uid: 2, constant: true, order: 100, content: 'c'.repeat(10) }),
  ]

  const result = activateEntries({
    entries,
    chat: [],
    budget: 25,
    countTokens: (text) => text.length,
    random: rng(),
  })

  assert.deepEqual(uids(result), [0, 1], 'the last candidate did not fit')
  assert.equal(result.budgetOverflowed, true)
})

test('ignoreBudget survives an overflow', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, content: 'a'.repeat(10) }),
      entry({ uid: 1, constant: true, content: 'b'.repeat(40) }),
      entry({ uid: 2, constant: true, ignoreBudget: true, content: 'c' }),
    ],
    chat: [],
    budget: 25,
    countTokens: (text) => text.length,
    random: rng(),
  })

  assert.deepEqual(uids(result), [0, 2])
})

test('an inclusion group seats exactly one winner', () => {
  const entries = [0, 1, 2].map((uid) => entry({ uid, key: ['dragon'], group: 'beasts', content: `body ${uid}` }))

  for (const seed of [1, 2, 3, 4, 5]) {
    const result = activateEntries({ entries, chat: ['a dragon lands'], random: rng(seed) })
    assert.equal(result.activated.length, 1, `seed ${seed} seated more than one winner`)
  }
})

test('groupOverride wins the group outright', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, key: ['dragon'], group: 'beasts', groupWeight: 1000, content: 'a' }),
      entry({ uid: 1, key: ['dragon'], group: 'beasts', groupOverride: true, content: 'b' }),
    ],
    chat: ['a dragon lands'],
    random: rng(),
  })

  assert.deepEqual(uids(result), [1])
})

test('group scoring prunes the entry with fewer key hits before the draw', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, key: ['dragon'], group: 'beasts', useGroupScoring: true, content: 'a' }),
      entry({ uid: 1, key: ['dragon', 'cave', 'gold'], group: 'beasts', useGroupScoring: true, content: 'b' }),
    ],
    chat: ['a dragon in a cave with gold'],
    random: rng(),
  })

  assert.deepEqual(uids(result), [1], 'three hits beat one, so the draw never happens')
})

test('sticky keeps an entry alive for the next few turns', () => {
  const entries = (): ScanEntry[] => [entry({ uid: 0, key: ['dragon'], sticky: 3, content: 'It hoards gold.' })]

  const turn1 = activateEntries({ entries: entries(), chat: ['a dragon lands'], random: rng() })
  assert.deepEqual(uids(turn1), [0], 'the key matched')

  const turn2 = activateEntries({
    entries: entries(),
    chat: ['nothing about it', 'a dragon lands'],
    timedEffects: turn1.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn2), [0], 'held open by sticky')

  const turn3 = activateEntries({
    entries: entries(),
    chat: ['still nothing', 'nothing about it', 'a dragon lands'],
    timedEffects: turn2.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn3), [0], 'still inside the window')

  const turn4 = activateEntries({
    entries: entries(),
    chat: ['and nothing', 'still nothing', 'nothing about it', 'a dragon lands'],
    timedEffects: turn3.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn4), [], 'the window closed after three messages')
})

test('cooldown suppresses an entry that would otherwise re-match', () => {
  const entries = (): ScanEntry[] => [entry({ uid: 0, key: ['dragon'], cooldown: 2, content: 'It hoards gold.' })]

  const turn1 = activateEntries({ entries: entries(), chat: ['a dragon lands'], random: rng() })
  assert.deepEqual(uids(turn1), [0])

  const turn2 = activateEntries({
    entries: entries(),
    chat: ['the dragon roars', 'a dragon lands'],
    timedEffects: turn1.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn2), [], 'suppressed despite matching')

  const turn3 = activateEntries({
    entries: entries(),
    chat: ['the dragon circles', 'the dragon roars', 'a dragon lands'],
    timedEffects: turn2.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn3), [0], 'the cooldown expired')
})

test('a sticky window ending puts the entry straight onto cooldown', () => {
  const entries = (): ScanEntry[] => [
    entry({ uid: 0, key: ['dragon'], sticky: 1, cooldown: 2, content: 'It hoards gold.' }),
  ]

  const turn1 = activateEntries({ entries: entries(), chat: ['a dragon lands'], random: rng() })
  assert.deepEqual(uids(turn1), [0])

  const turn2 = activateEntries({
    entries: entries(),
    chat: ['the dragon roars', 'a dragon lands'],
    timedEffects: turn1.timedEffects,
    random: rng(),
  })
  assert.deepEqual(uids(turn2), [], 'sticky expired and handed straight over to cooldown')
  assert.equal(Object.keys(turn2.timedEffects.cooldown).length, 1)
})

test('delay holds an entry back until the chat is long enough', () => {
  const held = entry({ uid: 0, key: ['dragon'], delay: 3, content: 'x' })

  assert.deepEqual(uids(activateEntries({ entries: [held], chat: ['a dragon lands'], random: rng() })), [])
  assert.deepEqual(
    uids(activateEntries({ entries: [held], chat: ['a dragon lands', 'b', 'c'], random: rng() })),
    [0],
  )
})

test('a dry run neither reads nor writes timed effects', () => {
  const first = activateEntries({
    entries: [entry({ uid: 0, key: ['dragon'], sticky: 3, content: 'x' })],
    chat: ['a dragon lands'],
    dryRun: true,
    random: rng(),
  })

  assert.deepEqual(uids(first), [0])
  assert.deepEqual(first.timedEffects, { sticky: {}, cooldown: {} })
})

test('the caller\'s timed-effect state is never mutated', () => {
  const carried = { sticky: {}, cooldown: {} }
  activateEntries({
    entries: [entry({ uid: 0, constant: true, sticky: 2, content: 'x' })],
    chat: ['hello'],
    timedEffects: carried,
    random: rng(),
  })

  assert.deepEqual(carried, { sticky: {}, cooldown: {} })
})

test('the caller\'s entries are never mutated', () => {
  const input = entry({ uid: 0, constant: true, content: '@@activate\nThe body.' })
  activateEntries({ entries: [input], chat: [], substituteMacros: () => 'rewritten', random: rng() })

  assert.equal(input.content, '@@activate\nThe body.')
})

test('activated entries are bucketed by position', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, position: worldInfoPosition.before, content: 'before' }),
      entry({ uid: 1, constant: true, position: worldInfoPosition.after, content: 'after' }),
      entry({ uid: 2, constant: true, position: worldInfoPosition.ANTop, content: 'an top' }),
      entry({ uid: 3, constant: true, position: worldInfoPosition.EMBottom, content: 'em bottom' }),
      entry({ uid: 4, constant: true, position: worldInfoPosition.atDepth, depth: 2, content: 'depth two' }),
      entry({ uid: 5, constant: true, position: worldInfoPosition.atDepth, depth: 2, content: 'also depth two' }),
      entry({
        uid: 6,
        constant: true,
        position: worldInfoPosition.atDepth,
        depth: 2,
        role: promptRole.USER,
        content: 'depth two, as user',
      }),
      entry({ uid: 7, constant: true, position: worldInfoPosition.outlet, outletName: 'sidebar', content: 'outlet' }),
    ],
    chat: [],
    random: rng(),
  })

  assert.deepEqual(result.buckets.before.map((e) => e.uid), [0])
  assert.deepEqual(result.buckets.after.map((e) => e.uid), [1])
  assert.deepEqual(result.buckets.anTop.map((e) => e.uid), [2])
  assert.deepEqual(result.buckets.emBottom.map((e) => e.uid), [3])
  assert.deepEqual(result.buckets.outlets['sidebar']?.map((e) => e.uid), [7])

  // Depth entries merge by depth *and* role, so the user-role one is its own slot.
  assert.equal(result.buckets.atDepth.length, 2)
  // Reversed, not sorted: for two entries at the same `order`, ST's
  // sort-descending-then-unshift pair is a reversal rather than a no-op. Pinned
  // because books with several same-order entries in one slot depend on it.
  assert.deepEqual(result.buckets.atDepth[0]?.entries.map((e) => e.uid), [5, 4])
  assert.equal(result.buckets.atDepth[1]?.role, promptRole.USER)
})

test('a bucket is ordered ascending by order', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, order: 300, content: 'a' }),
      entry({ uid: 1, constant: true, order: 100, content: 'b' }),
      entry({ uid: 2, constant: true, order: 200, content: 'c' }),
    ],
    chat: [],
    random: rng(),
  })

  assert.deepEqual(result.buckets.before.map((e) => e.order), [100, 200, 300])
})

test('an entry with no content is activated but placed nowhere', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, constant: true, content: '' })],
    chat: [],
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
  assert.deepEqual(result.buckets.before, [])
})

test('disabled entries and decorators are honoured before anything else', () => {
  const result = activateEntries({
    entries: [
      entry({ uid: 0, constant: true, disable: true, content: 'x' }),
      entry({ uid: 1, key: ['never matches this'], content: '@@activate\nForced in.' }),
      entry({ uid: 2, constant: true, content: '@@dont_activate\nForced out.' }),
    ],
    chat: ['Hello.'],
    random: rng(),
  })

  assert.deepEqual(uids(result), [1])
  assert.equal(result.buckets.before[0]?.content, 'Forced in.', 'the decorator line is stripped from the body')
})

test('a characterFilter admits or excludes by name', () => {
  const restricted = entry({
    uid: 0,
    constant: true,
    content: 'x',
    characterFilter: { isExclude: false, names: ['seraphina.png'], tags: [] },
  })

  const admitted = activateEntries({
    entries: [restricted],
    chat: [],
    character: { name: 'seraphina.png', tags: [] },
    random: rng(),
  })
  const excluded = activateEntries({
    entries: [restricted],
    chat: [],
    character: { name: 'other.png', tags: [] },
    random: rng(),
  })

  assert.deepEqual(uids(admitted), [0])
  assert.deepEqual(uids(excluded), [])
})

test('a generation-type trigger filter narrows when a scan applies', () => {
  const onlyContinue = entry({ uid: 0, constant: true, triggers: ['continue'], content: 'x' })

  assert.deepEqual(uids(activateEntries({ entries: [onlyContinue], chat: [], random: rng() })), [])
  assert.deepEqual(
    uids(activateEntries({
      entries: [onlyContinue],
      chat: [],
      globalScanData: { trigger: 'continue' },
      random: rng(),
    })),
    [0],
  )
})

test('an entry can opt into scanning text that is not the chat', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, key: ['alchemist'], matchCharacterDescription: true, content: 'x' })],
    chat: ['Hello.'],
    globalScanData: { characterDescription: 'A wandering alchemist.' },
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
})

test('minimum activations widen the window until they are met', () => {
  const buried = entry({ uid: 0, key: ['excalibur'], content: 'x' })
  const chat = ['nothing', 'nothing either', 'they found excalibur']

  assert.deepEqual(uids(activateEntries({ entries: [buried], chat, random: rng() })), [])
  assert.deepEqual(
    uids(activateEntries({ entries: [buried], chat, settings: { minActivations: 1 }, random: rng() })),
    [0],
  )
})

test('macros are expanded in both keys and content', () => {
  const result = activateEntries({
    entries: [entry({ uid: 0, key: ['{{char}}'], content: 'About {{char}}.' })],
    chat: ['I met Seraphina today.'],
    substituteMacros: (text) => text.replaceAll('{{char}}', 'Seraphina'),
    random: rng(),
  })

  assert.deepEqual(uids(result), [0])
  assert.equal(result.buckets.before[0]?.content, 'About Seraphina.')
})

test('disabled entries cost nothing, at the proportion real books ship', () => {
  // Measured over the user's 1478 entries: 503 of them — 34% — are shipped
  // switched off by their author. That makes this behaviour magnitude-sensitive
  // rather than a detail: an engine that merely declined to *emit* them while
  // still charging them to the budget would evict a third of the book's real
  // content, and the symptom would be a model that had stopped knowing things
  // it was told.
  const entries = Array.from({ length: 90 }, (_, uid) =>
    entry({ uid, constant: true, disable: uid % 3 === 0, content: `body ${String(uid)}` }))
  const enabled = entries.filter(candidate => candidate.disable !== true).length
  assert.equal(enabled, 60, 'the fixture really is a third disabled')

  const result = activateEntries({
    entries,
    chat: ['Hello.'],
    // Enough for every enabled entry and not one more, so a disabled entry that
    // consumed budget would push a real one out and be visible here.
    budget: enabled,
    countTokens: () => 1,
    random: rng(),
  })

  assert.equal(result.activated.length, enabled)
  assert.equal(result.activated.some(activated => activated.disable === true), false)
  assert.equal(result.budgetOverflowed, false, 'the disabled two thirds were never charged')
})
