import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  budgetUse,
  discrepancy,
  itemizationMode,
  rowsFor,
} from '../src/app/itemization.ts'
import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

/** The measured shape: one column and a pile of rubble. */
const entries: PromptItemEntry[] = [
  { id: 'main', label: 'Main Prompt', kind: 'system', tokens: 148 },
  { id: 'wi', label: 'World Info (before)', kind: 'system', tokens: 1920 },
  { id: 'note', label: "Author's Note", kind: 'depth', tokens: 29, depth: 2, role: 'system' },
  { id: 'hist', label: 'Chat History', kind: 'history', tokens: 27 },
]

function itemization(overrides?: Partial<PromptItemization>): PromptItemization {
  const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0)
  return {
    turn: 3,
    entries,
    tokens,
    budget: { context: 8192, reserve: 1024 },
    droppedHistory: 0,
    overBudget: false,
    preview: false,
    ...overrides,
  }
}

test('by size, the thing eating the context is the first row', () => {
  // 66% of a real prompt was one world-info injection. Assembly order buries that
  // answer in a wall of two-token rows.
  const rows = rowsFor(entries, 'size', 2124)

  assert.deepEqual(
    rows.map(row => row.entry.id),
    ['wi', 'main', 'note', 'hist'],
  )
  assert.ok(rows[0] !== undefined)
  assert.ok(rows[0].share > 0.9, 'the dominant row should read as dominant')
})

test('assembly order is preserved as given, because it is information', () => {
  // The contract's order IS the assembly order. Answering "is my preset ordered
  // the way I think" is a different question, and discarding the order would
  // throw away something the host preserved on purpose.
  const rows = rowsFor(entries, 'assembly', 2124)
  assert.deepEqual(
    rows.map(row => row.entry.id),
    ['main', 'wi', 'note', 'hist'],
  )
})

test('equal rows keep assembly order rather than reshuffling', () => {
  const tied: PromptItemEntry[] = [
    { id: 'a', label: 'A', kind: 'system', tokens: 10 },
    { id: 'b', label: 'B', kind: 'system', tokens: 10 },
    { id: 'c', label: 'C', kind: 'system', tokens: 10 },
  ]
  assert.deepEqual(
    rowsFor(tied, 'size', 30).map(row => row.entry.id),
    ['a', 'b', 'c'],
  )
})

test('a zero total does not put NaN into every bar', () => {
  // A real answer for a chat with nothing in it yet.
  const rows = rowsFor(entries, 'size', 0)
  for (const row of rows) assert.equal(row.share, 0)
})

test('a breakdown that does not add up is reported, not drawn', () => {
  // Worse than no breakdown: every number in it still looks authoritative. The
  // contract promises the sum and the host tests it — this checks anyway, because
  // the cost of being wrong here is silent and total.
  assert.equal(discrepancy(itemization()), undefined)
  assert.equal(discrepancy(itemization({ tokens: 2000 })), 124)
  assert.equal(discrepancy(itemization({ tokens: 3000 })), -876)
})

test('the budget excludes the reserve, because the prompt never had it', () => {
  // Counting the reply's reserve would make a request that is about to be
  // truncated look comfortable.
  const use = budgetUse(itemization())
  assert.equal(use.available, 8192 - 1024)
  assert.equal(use.used, 2124 / 7168)
})

test('a reserve larger than the window does not produce a negative budget', () => {
  const use = budgetUse(itemization({ budget: { context: 512, reserve: 1024 } }))
  assert.equal(use.available, 0)
  assert.equal(use.used, 0)
})

test('an expired record is a third state, not an error and not a plain preview', () => {
  // Only the caller knows what it asked for, so only the caller can tell these
  // apart — which is why the contract exposes `preview` instead of failing.
  assert.equal(itemizationMode(itemization(), 3), 'record')
  assert.equal(itemizationMode(itemization({ preview: true }), undefined), 'preview')
  assert.equal(itemizationMode(itemization({ preview: true }), 3), 'expired')
})
