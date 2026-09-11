import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseRequest } from '../src/index.ts'

/**
 * The world-book entry integers have ceilings, and the ceilings are measured.
 *
 * Two directions, and the second is the one that decides whether this was worth
 * doing: every extreme a **real** book carries has to be accepted, or the bound
 * is a compatibility break dressed up as hardening. The numbers below are not
 * invented — each is the largest or smallest value found in 2,856 entries
 * across 18 disk books, 17 embedded card books, the `originalData` mirror and
 * the shipped `Eldoria.json`. See `notes/packages/iris-app-service/DEVIATIONS.md`
 * §73 for the table and the file each extreme came from.
 */

/** Parse one entry patch through the real schema. */
function parse(entry: Record<string, unknown>): ReturnType<typeof parseRequest> {
  return parseRequest('worldbook.replace', { name: 'b', entries: [{ uid: 0, ...entry }] })
}

/** Assert an entry is accepted. */
function accepts(entry: Record<string, unknown>, why: string): void {
  const result = parse(entry)
  assert.equal(result.ok, true, `${why} must be accepted: ${result.ok ? '' : result.error.message}`)
}

/** Assert an entry is refused as an invalid request rather than thrown on. */
function refuses(entry: Record<string, unknown>, why: string): void {
  const result = parse(entry)
  assert.equal(result.ok, false, `${why} must be refused`)
  if (!result.ok) assert.equal(result.error.code, 'invalid-request')
}

test('every measured extreme in a real world book is still accepted', () => {
  accepts({ strategy: { scan_depth: 1 } }, 'scan_depth minimum, 缄默之秋2.5 entry 21')
  accepts({ strategy: { scan_depth: 6 } }, 'scan_depth maximum, card 终焉之刻NG entry 74')
  accepts({ strategy: { scan_depth: 'same_as_global' } }, 'the string form the fake client seeds')
  accepts({ position: { depth: 0 } }, 'depth minimum')
  accepts({ position: { depth: 10_000 } }, 'depth maximum, 银麒赎世 entry 127')
  accepts({ position: { order: -999 } }, 'the only real negative, OVERLORD entry 0')
  accepts({ position: { order: 100_000_000 } }, 'order maximum, [SG]可攻略女主拒绝被攻略 entry 35')
  accepts({ recursion: { delay_until: 0 } }, 'delay_until, the only numeric value on disk')
  accepts({ recursion: { delay_until: null } }, 'delay_until unset')
  accepts({ effect: { sticky: 10 } }, 'sticky maximum, card 终焉之刻NG entry 11')
  accepts({ effect: { cooldown: 9_999 } }, 'cooldown maximum, 魔法禁书目录_v1.0 entry 6')
  accepts({ effect: { delay: 0 } }, 'delay, only ever 0 or null')
  accepts({ effect: { sticky: null, cooldown: null, delay: null } }, 'the 898 entries that leave these unset')
  accepts({ groupWeight: 100 }, 'the one groupWeight value in the whole corpus')
})

test('nothing SillyTavern\'s own editor can produce is refused', () => {
  // Upstream declares these maxima in HTML and enforces none of them, so the
  // bounds here sit above what a person can type into the editor.
  accepts({ effect: { sticky: 999_999 } }, 'index.html:6992 declares max="999999"')
  accepts({ effect: { cooldown: 999_999 } }, 'index.html:7005')
  accepts({ effect: { delay: 999_999 } }, 'index.html:7018')
  accepts({ position: { depth: 9_999 } }, 'index.html:7194 declares max="9999"')
  accepts({ groupWeight: 10_000 }, 'world-info.js:3671-3675 clamps groupWeight to [1, 10000]')
  accepts({ strategy: { scan_depth: 1000 } }, 'MAX_SCAN_DEPTH, world-info.js:98')
})

test('one step past each bound is refused', () => {
  refuses({ strategy: { scan_depth: 1001 } }, 'scan_depth over upstream\'s own enforced limit')
  refuses({ strategy: { scan_depth: -1 } }, 'scan_depth negative — upstream resets it to 0 with a toast')
  refuses({ position: { depth: 100_001 } }, 'depth over the bound')
  refuses({ position: { depth: -1 } }, 'depth negative — none exists in 2,856 entries')
  refuses({ position: { order: 1_000_000_001 } }, 'order over the bound')
  refuses({ position: { order: -1_000_001 } }, 'order under the bound')
  refuses({ recursion: { delay_until: 100_001 } }, 'delay_until over the bound')
  refuses({ recursion: { delay_until: -1 } }, 'delay_until negative — the one deliberate narrowing')
  refuses({ effect: { sticky: 1_000_001 } }, 'sticky over the bound')
  refuses({ effect: { sticky: -1 } }, 'sticky negative')
  refuses({ effect: { cooldown: 1_000_001 } }, 'cooldown over the bound')
  refuses({ effect: { cooldown: -1 } }, 'cooldown negative')
  refuses({ effect: { delay: 1_000_001 } }, 'delay over the bound')
  refuses({ effect: { delay: -1 } }, 'delay negative')
  refuses({ groupWeight: 1_000_001 }, 'groupWeight over the bound')
  refuses({ groupWeight: -1 }, 'groupWeight negative')
})

test('a non-integer is still refused, which is what these fields always said', () => {
  refuses({ position: { depth: 1.5 } }, 'depth')
  refuses({ effect: { sticky: 2.5 } }, 'sticky')
  // No non-integer appears in any field in any measured population, so this is
  // the pre-existing rule rather than a new one — pinned here because the
  // bounds are written beside it and a `.min()` typed onto the wrong schema
  // would drop it silently.
  refuses({ position: { order: Number.NaN } }, 'order')
})
