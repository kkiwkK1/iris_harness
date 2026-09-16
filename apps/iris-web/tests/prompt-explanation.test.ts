/**
 * What the interface says about *why* a prompt part is there, and why a zero
 * part is zero.
 *
 * The assembly panel could already say how much each part cost; measured on an
 * open conversation, 23 of its 38 rows cost nothing, and the panel rendered all
 * of them as one identical 「空」. The three ordinary causes — a preset prompt
 * that is nothing but `{{setvar}}` macros, a marker slot this turn filled with
 * nothing, a preset item left blank — lead a reader to three different places.
 * `zeroReasonKey` and `sourceNoteKey` are where that distinction lives as a
 * decision; the panel is where it is laid out.
 *
 * Read out of the pure functions and the sources rather than a rendered DOM, the
 * same way `prompt-deferred.test.ts` reads the moved-row contract: mounting
 * React here would prove the same thing with a slower instrument. What is checked
 * against the sources is that the panel asks for the words and that the classes
 * they are drawn with have rules.
 *
 * @module iris-web/tests/prompt-explanation
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import type { PromptItemEntry, PromptItemMember } from '@iris/protocol'
import { sourceNoteKey, zeroReasonKey } from '../src/app/itemization.ts'
import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** One row, with an explanation attached only when one is given. */
function row(
  tokens: number,
  explanation?: PromptItemEntry['explanation'],
): PromptItemEntry {
  return {
    id: 'row',
    label: 'row',
    kind: 'system',
    tokens,
    ...explanation === undefined ? {} : { explanation },
  }
}

test('a zero row names its cause; a row with text never does', () => {
  // The three causes the host produces, each a different sentence. A panel that
  // showed one word for all three is the state this feature replaced.
  assert.equal(
    zeroReasonKey(row(0, { source: { kind: 'preset', id: 'init' }, zeroReason: 'macros-only' })),
    'promptZeroMacrosOnly',
  )
  assert.equal(
    zeroReasonKey(row(0, { source: { kind: 'card', id: 'scenario' }, zeroReason: 'marker-unfilled' })),
    'promptZeroMarkerUnfilled',
  )
  assert.equal(
    zeroReasonKey(row(0, { source: { kind: 'preset', id: 'nsfw' }, zeroReason: 'blank' })),
    'promptZeroBlank',
  )

  // The reserved reasons still have words, so the budget round lands into copy
  // that already exists rather than inventing its own.
  assert.equal(zeroReasonKey(row(0, { source: { kind: 'host', id: 'x' }, zeroReason: 'trimmed' })), 'promptZeroTrimmed')
  assert.equal(
    zeroReasonKey(row(0, { source: { kind: 'host', id: 'x' }, zeroReason: 'dropped-by-budget' })),
    'promptZeroDropped',
  )

  // A reason beside a nonzero cost is a host contradiction, and the safe
  // reading is the one the numbers support: say nothing rather than put a
  // sentence the row's own token count denies.
  assert.equal(zeroReasonKey(row(40, { source: { kind: 'preset', id: 'main' }, zeroReason: 'blank' })), null)
  // An unexplained row — an older host's record — produces no sentence, because
  // one invented here would claim a cause nobody measured.
  assert.equal(zeroReasonKey(row(0, { source: { kind: 'preset', id: 'init' } })), null)
  assert.equal(zeroReasonKey(row(0)), null)
})

test('the source names the author of the bytes, not the row', () => {
  assert.deepEqual(
    sourceNoteKey(row(10, { source: { kind: 'card', id: 'scenario', label: 'scenario' } })),
    { key: 'promptSourceCard', name: 'scenario' },
  )
  // No label means the id is the name — a preset UUID, which is the ordinary
  // case (29 of 41 in one real preset) and exactly why the label exists.
  assert.deepEqual(
    sourceNoteKey(row(10, { source: { kind: 'preset', id: '881044e5-cbef-4a1c-9b3d-2f0e6a7c5d31' } })),
    { key: 'promptSourcePreset', name: '881044e5-cbef-4a1c-9b3d-2f0e6a7c5d31' },
  )
  // Every kind has a key, so a sixth kind added to the contract reddens the
  // compiler in `itemization.ts` rather than rendering an empty span here.
  for (const kind of ['preset', 'card', 'worldbook', 'history', 'script', 'host'] as const) {
    const note = sourceNoteKey(row(10, { source: { kind, id: 'x' } }))
    assert.ok(note !== null && note.key.startsWith('promptSource'), `${kind} has no source key`)
  }
  assert.equal(sourceNoteKey(row(10)), null)
})

test('the copy exists in both dictionaries, and its placeholders match', () => {
  const keys: StringKey[] = [
    'promptZeroMacrosOnly', 'promptZeroMarkerUnfilled', 'promptZeroBlank',
    'promptZeroTrimmed', 'promptZeroDropped',
    'promptSourcePreset', 'promptSourceCard', 'promptSourceWorldbook',
    'promptSourceHistory', 'promptSourceScript', 'promptSourceHost',
  ]
  for (const key of keys) {
    // Read through a widened view: `en`'s values are literal types, so comparing
    // one against `''` is a type error rather than a check.
    const english = (en as Record<string, string>)[key]
    assert.ok(english !== undefined && english !== '', `${key} is missing from en`)
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      const value = (dictionary as Record<string, string>)[key]
      assert.ok(value !== undefined && value !== '', `${key} is missing from ${language}`)
    }
  }
  // The one placeholder the source notes fill. A renamed `{name}` renders the
  // brace literally and nothing else complains.
  for (const key of ['promptSourcePreset', 'promptSourceCard', 'promptSourceWorldbook',
    'promptSourceScript', 'promptSourceHost'] as const) {
    assert.ok(en[key].includes('{name}'), `${key} lost its {name} slot`)
  }
  // `promptSourceHistory` is a fixed phrase — the conversation has no name.
  assert.equal(en.promptSourceHistory.includes('{name}'), false)
})

test('the panel renders the explanation and its classes have rules', () => {
  const panel = readFileSync(join(HERE, '..', 'src', 'app', 'PromptPanel.tsx'), 'utf8')
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')
  const module = readFileSync(join(HERE, '..', 'src', 'app', 'itemization.ts'), 'utf8')

  // Declared-against-used, in both directions: a class with no rule paints
  // nothing and a rule with no user is dead weight, and neither says so. The
  // locator is checked on the value alone, because the panel writes it as a JSX
  // attribute and the quoted form never appears in the source.
  for (const cls of ['iris-prompt__explain', 'iris-prompt__zero-reason']) {
    assert.ok(panels.includes(`.${cls}`), `${cls} has no CSS rule`)
    assert.ok(panel.includes(cls), `${cls} has a rule but nothing renders it`)
  }
  assert.ok(panel.includes("data-control=\"prompt-explained\""), 'the explained block lost its QA locator')

  // The two decisions are imported by the panel, not re-implemented in it — the
  // reason the pure functions exist is that the copy lives in one place.
  assert.ok(panel.includes('zeroReasonKey') && panel.includes('sourceNoteKey'),
    'the panel does not read the explanation decision from the module that holds it')
  assert.ok(module.includes('export function zeroReasonKey') && module.includes('export function sourceNoteKey'))

  // The explanation hangs on the row and on its members — a world-info entry
  // inside a depth bucket is a part in its own right and carries the same
  // shape, so one component renders both. A member that lost its explanation
  // would leave the largest row in the list unexplained.
  const member: PromptItemMember = { id: 'wi#atlas.10', label: '常驻·湖', tokens: 0, explanation: { source: { kind: 'worldbook', id: 'atlas.10' }, zeroReason: 'marker-unfilled' } }
  assert.equal(zeroReasonKey(member), 'promptZeroMarkerUnfilled')
  assert.deepEqual(sourceNoteKey(member), { key: 'promptSourceWorldbook', name: 'atlas.10' })
})
