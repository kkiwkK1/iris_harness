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

import type { PromptItemEntry, PromptItemization, PromptItemMember } from '@iris/protocol'
import { macroNote, messageRows, overflowNote, regexNote, sourceNoteKey, zeroReasonKey } from '../src/app/itemization.ts'
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

test('the panel offers both views, and the message view has rules and a locator', () => {
  const panel = readFileSync(join(HERE, '..', 'src', 'app', 'PromptPanel.tsx'), 'utf8')
  const panels = readFileSync(join(HERE, '..', 'src', 'app', 'panels.css'), 'utf8')
  // The switch is only rendered when the host sent a reverse index — an older
  // record has none, and a tab over an empty view reads as a defect. The
  // condition and the guard are checked as source facts because the panel only
  // renders past `loading` under a server render.
  assert.ok(panel.includes('messageRows'), 'the panel never builds the message view')
  assert.ok(panel.includes("messages.length === 0 ? null"), 'the view switch is not guarded on a present reverse index')
  for (const value of ['prompt-view-rows', 'prompt-view-messages']) {
    assert.ok(panel.includes(value), `the view switch lost ${value}`)
  }
  assert.ok(panel.includes('data-control="prompt-messages"'), 'the message list lost its QA locator')

  // Declared-against-used, both directions, for the message view's own classes.
  for (const cls of ['iris-prompt__messages', 'iris-prompt__message', 'iris-prompt__message-head', 'iris-prompt__message-empty']) {
    assert.ok(panels.includes(`.${cls}`), `${cls} has no CSS rule`)
    assert.ok(panel.includes(cls), `${cls} has a rule but nothing renders it`)
  }
  // A stable message is told from an unstable one by more than colour — the
  // words exist in both dictionaries (checked above) and the panel asks for the
  // right one per message.
  assert.ok(panel.includes("promptMessageStable") && panel.includes('promptMessageUnstable'))
})

test('the macro stage reports the most frequent head, not the first', () => {
  const note = macroNote(row(0, {
    source: { kind: 'preset', id: 'init' },
    zeroReason: 'macros-only',
    macros: { heads: { getvar: 2, setvar: 61 }, charsBefore: 1250, charsAfter: 0 },
  }))
  // `setvar` runs sixty-one times and `getvar` twice; the count is the point, so
  // the head reported is the frequent one however the map was ordered.
  assert.deepEqual(note, { kinds: 2, top: 'setvar', count: 61, before: 1250, after: 0 })

  // Absent macros produce nothing — an untraced or macro-free row must not grow
  // a line claiming a trace nobody took.
  assert.equal(macroNote(row(40, { source: { kind: 'preset', id: 'main' } })), null)
  assert.equal(macroNote(row(0, { source: { kind: 'preset', id: 'x' }, zeroReason: 'blank' })), null)
  // A traced row with no heads at all is the same nothing: the trace found
  // nothing to resolve, which the panel says by saying nothing.
  assert.equal(macroNote(row(40, {
    source: { kind: 'preset', id: 'main' },
    macros: { heads: {}, charsBefore: 12, charsAfter: 12 },
  })), null)
})

test('the regex stage tells "no rule fired" from "not recorded"', () => {
  // Recorded and nothing matched: the panel says so, because a chain that ran
  // is a different fact from a host that did not look.
  assert.deepEqual(regexNote(row(10, { source: { kind: 'preset', id: 'main' }, regex: { applied: [] } })), [])
  assert.deepEqual(
    regexNote(row(10, { source: { kind: 'preset', id: 'main' }, regex: { applied: ['strip', 'hide'] } })),
    ['strip', 'hide'],
  )
  // Not recorded at all.
  assert.equal(regexNote(row(10, { source: { kind: 'preset', id: 'main' } })), null)
})

test('the macro and regex copy exists in both dictionaries with matching slots', () => {
  const keys: StringKey[] = ['promptMacros', 'promptRegex', 'promptRegexNone']
  for (const key of keys) {
    const english = (en as Record<string, string>)[key]
    assert.ok(english !== undefined && english !== '', `${key} is missing from en`)
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      const value = (dictionary as Record<string, string>)[key]
      assert.ok(value !== undefined && value !== '', `${key} is missing from ${language}`)
    }
  }
  for (const token of ['{kinds}', '{top}', '{count}', '{before}', '{after}']) {
    assert.ok(en.promptMacros.includes(token), `promptMacros lost ${token}`)
  }
  assert.ok(en.promptRegex.includes('{rules}'), 'promptRegex lost {rules}')
  // `promptRegexNone` is a fixed phrase — no slots to fill.
  assert.equal(en.promptRegexNone.includes('{'), false)
})

test('the overflow line prefers the reported weight and falls back to the count', () => {
  // A host that reported the richer object: the line carries both numbers.
  assert.deepEqual(
    overflowNote({ ...itemization(), droppedHistory: 3, overflow: { droppedFloors: 3, droppedTokens: 1_842 } }),
    { floors: 3, tokens: 1_842 },
  )
  // An older host that reported only the count.
  assert.deepEqual(overflowNote({ ...itemization(), droppedHistory: 2 }), { floors: 2 })
  // The richer object's count is the same number, so either source agrees.
  assert.deepEqual(
    overflowNote({ ...itemization(), droppedHistory: 3, overflow: { droppedFloors: 3, droppedTokens: 10 } })?.floors,
    3,
  )

  // Nothing dropped shows nothing, so the ordinary state gets no line.
  assert.equal(overflowNote({ ...itemization(), droppedHistory: 0 }), null)
  assert.equal(
    overflowNote({ ...itemization(), droppedHistory: 0, overflow: { droppedFloors: 0, droppedTokens: 0 } }),
    null,
  )
})

test('the overflow copy exists in both dictionaries with matching slots', () => {
  for (const key of ['promptOverflow', 'droppedToFit'] as StringKey[]) {
    const english = (en as Record<string, string>)[key]
    assert.ok(english !== undefined && english !== '', `${key} is missing from en`)
    for (const [language, dictionary] of Object.entries(DICTIONARIES)) {
      const value = (dictionary as Record<string, string>)[key]
      assert.ok(value !== undefined && value !== '', `${key} is missing from ${language}`)
    }
  }
  for (const token of ['{floors}', '{tokens}']) {
    assert.ok(en.promptOverflow.includes(token), `promptOverflow lost ${token}`)
  }
  assert.ok(en.droppedToFit.includes('{n}'), 'droppedToFit lost its {n} slot')
})

test('the message view carries the same divergence marks the row view does', () => {
  const panel = readFileSync(join(HERE, '..', 'src', 'app', 'PromptPanel.tsx'), 'utf8')

  // One comparison, two listings of the request: the message view resolves each
  // part by the same id the row view does, so a part the comparison names is
  // marked in both. A message view without the marks would silently disagree
  // with the table beside it about which part changed.
  assert.ok(panel.includes('compared={compared}'), 'the message view is not handed the comparison')
  // `MessageView` renders an `ItemMark` for a part the comparison names.
  const messageView = panel.slice(panel.indexOf('function MessageView'), panel.indexOf('function Explanation'))
  assert.ok(messageView.includes('ItemMark'), 'the message view never renders a divergence mark')
  assert.ok(messageView.includes('compared.get(part.id)'), 'the mark is not looked up by part id')
})

/**
 * One itemization with a system prompt holding two parts, a floor and a depth
 * injection — both views present and consistent with each other.
 */
function itemization(messages?: PromptItemization['messages']): PromptItemization {
  return {
    turn: 3,
    entries: [
      {
        id: 'main',
        label: 'Main Prompt',
        kind: 'system',
        tokens: 40,
        explanation: { source: { kind: 'preset', id: 'main' }, placement: { messageIndex: 0, role: 'system' }, stable: true },
      },
      {
        id: 'status',
        label: '状态栏格式',
        kind: 'depth',
        tokens: 9,
        depth: 0,
        role: 'system',
        explanation: { source: { kind: 'preset', id: 'status' }, placement: { messageIndex: 0, role: 'system', depth: 0 }, stable: true },
      },
      { id: 'chatHistory', label: 'Chat History', kind: 'history', tokens: 12, explanation: { source: { kind: 'history', id: 'chatHistory' } } },
    ],
    tokens: 61,
    budget: { context: 8192, reserve: 1024 },
    droppedHistory: 0,
    overBudget: false,
    preview: false,
    ...messages === undefined ? {} : { messages },
  }
}

test('the message view resolves each part from the id the message names, in order', () => {
  const rows = messageRows(itemization([
    { index: 0, role: 'system', tokens: 49, stable: true, partIds: ['main', 'status'] },
    { index: 1, role: 'user', tokens: 12, stable: false, partIds: ['history.0'] },
  ]))

  assert.equal(rows.length, 2)
  // A message can hold several parts — a squash, a split bucket — and they are
  // resolved to their entries **in the order the message names them**. Reversing
  // them would show the request's own text in the wrong sequence.
  const [system] = rows
  assert.ok(system !== undefined)
  assert.deepEqual(system.parts.map(part => part.label), ['Main Prompt', '状态栏格式'])
  assert.equal(system.parts.every(part => part.floor === false), true)
  // The explanation comes through with the depth field the view renders as `@0`.
  assert.equal(system.parts[0]?.explanation?.source.kind, 'preset')
  assert.equal(system.parts[1]?.explanation?.placement?.depth, 0)
  assert.equal(system.stable, true)

  // A floor is the one part no entry names — the conversation is one aggregate
  // row on purpose — so the view says its number and marks it as a floor.
  const floor = rows[1]?.parts[0]
  assert.equal(floor?.floor, true)
  assert.equal(floor?.label, 'floor 0')
  assert.equal(floor?.kind, 'history')
  assert.equal(floor?.explanation, undefined)
  // And the message's own verdict travels with it, not the part's.
  assert.equal(rows[1]?.stable, false)
})

test('the two directions are independently readable, so a fixture that drifts is visible', () => {
  // The host derives both from one pass, so a row's `placement.messageIndex` and
  // the message that names it must agree. This is a *drifted* fixture on purpose:
  // `status` says message 1 in its own explanation, and message 0 names it
  // anyway. The mismatch is visible precisely because neither direction is
  // derived from the other at render time — which is what lets the fake's own
  // consistency test above catch a hand-written fixture going stale.
  const drifted = itemization([
    { index: 0, role: 'system', tokens: 49, stable: true, partIds: ['main', 'status'] },
  ])
  // Move `status`'s own claim to a message that does not name it, without
  // touching the message list: that is the drift this test is about.
  const status = drifted.entries.find(entry => entry.id === 'status')
  assert.ok(status?.explanation !== undefined)
  status.explanation.placement = { messageIndex: 1, role: 'system', depth: 0 }
  const rows = messageRows(drifted)
  const namesStatus = rows.find(row => row.parts.some(part => part.id === 'status'))?.index
  const statusSays = status.explanation.placement.messageIndex
  assert.equal(namesStatus, 0)
  assert.equal(statusSays, 1)
  assert.notEqual(namesStatus, statusSays, 'both directions must be readable on their own, or a drift cannot be caught')
})

/**
 * The fake the shell is developed against carries both views, and they agree.
 *
 * The record a test or the render check sees comes from `fakeItemization`, so a
 * fake whose two views disagreed would let the panel pass while showing a
 * request the host cannot assemble. Read from the fake rather than from a
 * hand-built literal, so the shipped fixture is the thing under test.
 */
test('the fake itemization sends both views, and they agree', async () => {
  const { fakeItemization } = await import('@iris/client-fake')
  const itemization = fakeItemization(3, false)
  const messages = itemization.messages ?? []
  assert.ok(messages.length >= 2, 'the fake should describe a request with more than one message')

  const namedBy = new Map<string, number>()
  for (const message of messages) for (const id of message.partIds) namedBy.set(id, message.index)
  let placed = 0
  for (const entry of itemization.entries) {
    const at = entry.explanation?.placement
    if (at === undefined) continue
    placed += 1
    assert.equal(namedBy.get(entry.id), at.messageIndex, `${entry.id} disagrees between the two views`)
  }
  assert.ok(placed >= 10, `only ${String(placed)} placed entries; the fake is not exercising the reverse index`)
  // A part with no placement is named by no message — the zero rows the fixture
  // carries, which must not be given an invented message.
  for (const entry of itemization.entries) {
    if (entry.explanation?.placement !== undefined) continue
    assert.equal(namedBy.has(entry.id), false, `${entry.id} has no placement but a message names it`)
  }
  // The message view resolves the shipped fixture, so the panel's own path over
  // the fake is exercised here rather than only under a browser.
  const rows = messageRows(itemization)
  assert.equal(rows.length, messages.length)
  assert.equal(rows.some(row => row.parts.some(part => part.floor)), true,
    'the fake should carry a conversation floor for the message view to name')
})
