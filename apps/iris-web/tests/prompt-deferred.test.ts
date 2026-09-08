/**
 * What the interface says about a prompt part the cache-friendly order moved.
 *
 * The reorder changes what the model reads, so it may not be invisible. Two
 * surfaces carry it and each answers a different question:
 *
 * - the prompt panel's row — "my instruction is not where I put it, and here is
 *   where I put it", and
 * - the context card's line — "how much of this request is reusable", which is
 *   the reading the whole feature exists to move.
 *
 * The rows are read out of the modules that compute them rather than out of a
 * rendered DOM: these are pure functions, and a test that mounted React here
 * would prove the same thing with a slower instrument. What *is* checked
 * against the sources is that the strings the components ask for exist in both
 * dictionaries and that the class names they use have rules.
 *
 * @module iris-web/tests/prompt-deferred
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

import { stablePrefix } from '../src/app/context-occupancy.ts'
import { rowsFor } from '../src/app/itemization.ts'
import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One itemization row; `phase` says which way the reorder moved it, if at all. */
function item(id: string, tokens: number, phase?: 'deferred' | 'promoted'): PromptItemEntry {
  return {
    id,
    label: id,
    kind: phase === 'promoted' ? 'depth' : 'system',
    tokens,
    ...phase === 'deferred' ? { deferred: true } : {},
    ...phase === 'promoted' ? { promoted: true, depth: 0 } : {},
  }
}

/**
 * A breakdown in the host's own order — contribution order — with one moved row
 * in the middle.
 *
 * In the middle on purpose: a row that only ever appeared last would let a
 * "sort moved rows to the end" implementation pass without sorting anything.
 */
function itemization(): PromptItemization {
  return {
    turn: 3,
    entries: [
      item('main', 40),
      item('worldInfoBefore', 300),
      item('worldInfoAfter', 120, 'deferred'),
      item('charDescription', 200),
      item('worldInfo.depth.0.0', 500, 'promoted'),
      { id: 'chatHistory', label: 'Chat History', kind: 'history', tokens: 1_000 },
    ],
    tokens: 2_160,
    stablePrefixTokens: 2_040,
    budget: { context: 32_768, reserve: 1_024 },
    droppedHistory: 0,
    overBudget: false,
    preview: false,
  }
}

test('the assembly-order view puts each moved row where the request carries it', () => {
  const rows = rowsFor(itemization().entries, 'assembly', 2_160)

  // Three phases, in request order: the promoted row goes ahead of the
  // conversation, the deferred row after it. Leaving either in its host-list
  // position would make a view named "assembly order" describe a request that
  // never happened.
  assert.deepEqual(rows.map(row => row.entry.id), [
    'worldInfo.depth.0.0',
    'main', 'worldInfoBefore', 'charDescription', 'chatHistory',
    'worldInfoAfter',
  ])
})

test('a moved row carries the position it was moved from, in both directions', () => {
  const rows = rowsFor(itemization().entries, 'assembly', 2_160)

  // Positions in the host's list, which is where the reader put things and
  // where they will go to change them. A badge alone would tell someone their
  // prompt moved and give them nowhere to look.
  assert.deepEqual(rows.find(row => row.entry.deferred === true)?.origin, { at: 3, total: 6 })
  assert.deepEqual(rows.find(row => row.entry.promoted === true)?.origin, { at: 5, total: 6 })
})

test('the size-ordered view keeps the host order as its tie-break, moved or not', () => {
  const rows = rowsFor(itemization().entries, 'size', 2_160)
  // Largest first; neither flag may perturb this order, because this view
  // answers "what is eating my context" and position is no part of that.
  assert.deepEqual(rows.map(row => row.entry.id),
    ['chatHistory', 'worldInfo.depth.0.0', 'worldInfoBefore', 'charDescription', 'worldInfoAfter', 'main'])
  // The origin travels with the row in either order.
  assert.deepEqual(rows.find(row => row.entry.id === 'main')?.origin, { at: 1, total: 6 })
})

test('with nothing moved, assembly order is the host order unchanged', () => {
  const plain = itemization().entries.map(entry => item(entry.id, entry.tokens))
  assert.deepEqual(rowsFor(plain, 'assembly', 2_160).map(row => row.entry.id),
    ['main', 'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'worldInfo.depth.0.0', 'chatHistory'])
})

test('the stable-prefix reading is a share of the request, rounded', () => {
  assert.deepEqual(stablePrefix(itemization()), { tokens: 2_040, percent: 94 })
})

test('a missing stable-prefix reading is absent, never zero', () => {
  // "The host sent no reading" and "nothing in this request is reusable" are
  // different facts. A `?? 0` would print the second whenever the first was
  // true, and a card claiming 0% reusable is a confident statement about a
  // measurement nobody took.
  const { stablePrefixTokens: _dropped, ...without } = itemization()
  assert.equal(stablePrefix(without), null)
  assert.equal(stablePrefix(undefined), null)
  // A request that costs nothing divides by nothing.
  assert.equal(stablePrefix({ ...itemization(), tokens: 0 }), null)
})

test('the two directions are told apart by wording, colour and locator', () => {
  const panel = readFileSync(join(HERE, '..', 'src', 'app', 'PromptPanel.tsx'), 'utf8')
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')

  // Two moves with opposite meanings — "sent after the transcript" and "sent
  // before it" — must not share one badge. A single 「已移动」 would leave the
  // reader unable to tell which way, which is the only thing they need.
  assert.notEqual(en.promptDeferred, en.promptPromoted)
  assert.ok(panel.includes('promptPromoted'))
  assert.ok(panel.includes("'prompt-promoted'"))
  for (const cls of ['iris-prompt__row--promoted', 'iris-prompt__deferred--promoted']) {
    assert.ok(panels.includes(`.${cls}`), `${cls} has no CSS rule`)
    assert.ok(panel.includes(cls), `${cls} has a rule but nothing renders it`)
  }
})

test('the strings both surfaces ask for exist in every dictionary', () => {
  const keys: StringKey[] = [
    'promptDeferred', 'promptDeferredWhere', 'promptDeferredAria',
    'promptPromoted', 'promptPromotedAria',
    'contextStablePrefix', 'cacheFriendly', 'cacheFriendlyNote', 'repliesCacheOff',
  ]
  for (const key of keys) {
    // Read through a widened view: `en`'s values are literal types, so
    // comparing one against `''` is a type error rather than a check.
    const english = (en as Record<string, string>)[key]
    assert.ok(english !== undefined && english !== '', `${key} is missing from en`)
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      const value = (dictionary as Record<string, string>)[key]
      assert.ok(value !== undefined && value !== '', `${key} is missing from ${language}`)
    }
  }
  // The two placeholders the panel fills. A renamed placeholder renders the
  // brace literally and nothing else complains.
  for (const token of ['{n}', '{total}']) {
    assert.ok(en.promptDeferredWhere.includes(token), `promptDeferredWhere lost ${token}`)
  }
  for (const token of ['{percent}', '{tokens}']) {
    assert.ok(en.contextStablePrefix.includes(token), `contextStablePrefix lost ${token}`)
  }
})

test('the classes the moved row uses have rules, and the panel still asks for them', () => {
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')
  const panel = readFileSync(join(HERE, '..', 'src', 'app', 'PromptPanel.tsx'), 'utf8')

  // Declared-against-used, in both directions: a class with no rule paints
  // nothing and a rule with no user is dead weight, and neither says so.
  for (const cls of ['iris-prompt__row--deferred', 'iris-prompt__deferred']) {
    assert.ok(panels.includes(`.${cls}`), `${cls} has no CSS rule`)
    assert.ok(panel.includes(cls), `${cls} has a rule but nothing renders it`)
  }
  // The handles a QA locator uses, so a switch to a different attribute is
  // caught here rather than by a browser run that silently falls back. Matched
  // on the value alone: the panel picks it with a conditional, so the literal
  // `data-control="…"` never appears in the source.
  assert.ok(panel.includes('data-control=') && panel.includes("'prompt-deferred'"))
  const meter = readFileSync(join(HERE, '..', 'src', 'app', 'ContextMeter.tsx'), 'utf8')
  assert.ok(meter.includes('data-control="stable-prefix"'))
})

test('the settings switch reads absence as ON', () => {
  const drawer = readFileSync(join(HERE, '..', 'src', 'app', 'SettingsDrawer.tsx'), 'utf8')

  // The one control on that card whose default is on. Written `!== false`; a
  // copy-paste of its neighbours' `=== true` would show every fresh
  // installation a switch that is off while the host reorders anyway — a
  // control that lies about what the product is doing.
  assert.ok(drawer.includes('settings.cacheFriendly !== false'),
    'the cache-friendly toggle must read absence as on')
  assert.equal(drawer.includes('settings.cacheFriendly === true'), false)
})
