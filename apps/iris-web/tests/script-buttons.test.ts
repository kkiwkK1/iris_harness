/**
 * Which card-script buttons the bar shows.
 *
 * @module iris-web/tests/script-buttons
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import type { ScriptView } from '@iris/protocol'

import { visibleButtons } from '../src/app/script-buttons.ts'

/** A script, with only the fields these tests vary. */
function script(over: Partial<ScriptView> & { id: string }): ScriptView {
  return {
    name: `script ${over.id}`,
    enabled: true,
    bytes: 10,
    ...over,
  } as ScriptView
}

test('the three filter layers are independent', () => {
  /*
   * Upstream applies them in one chained expression
   * (`store/iframe_runtimes/script.ts:47-61`), and they answer three different
   * people's questions: does the script run at all, did its author switch the
   * whole set off, is this one button shown. Collapsing any two would give the
   * right answer for the corpus and the wrong one for a card that uses them
   * separately — which is what they are for.
   */
  const scripts = [
    script({ id: 'off', enabled: false, buttons: [{ name: 'a', visible: true }] }),
    script({ id: 'group-off', buttonsEnabled: false, buttons: [{ name: 'b', visible: true }] }),
    script({ id: 'hidden', buttons: [{ name: 'c', visible: false }] }),
    script({ id: 'shown', buttons: [{ name: 'd', visible: true }] }),
  ]

  assert.deepEqual(visibleButtons(scripts).map(one => one.name), ['d'])
})

test('the group switch defaults to on, and a button has no default at all', () => {
  /*
   * Asymmetric on purpose, and both halves are upstream's. `button.enabled`
   * defaults to `true`, so a script that never mentions it still shows its
   * buttons. `visible` is required per button — there is no default to inherit,
   * which is why an absent `buttons` array means nothing to show rather than
   * everything.
   */
  assert.deepEqual(
    visibleButtons([script({ id: 'a', buttons: [{ name: 'x', visible: true }] })]).map(b => b.name),
    ['x'],
    'an unmentioned group switch must not hide the set',
  )
  assert.deepEqual(visibleButtons([script({ id: 'b' })]), [], 'no buttons is not all buttons')
})

test('hidden is the common case, and it hides without removing', () => {
  /*
   * Measured: 58 of the corpus's 89 buttons are `visible: false`. So rendering
   * everything by default would put controls on screen that their authors
   * deliberately hid — the majority of them.
   *
   * The other half of that rule lives in `getScriptButtons`, which answers with
   * the **unfiltered** array so a script can read its own hidden buttons and
   * flip one on. This function filtering, and only this function, is what keeps
   * "hidden" and "absent" from collapsing into each other.
   */
  const one = script({
    id: 'mixed',
    buttons: [
      { name: 'shown', visible: true },
      { name: 'hidden', visible: false },
    ],
  })

  assert.deepEqual(visibleButtons([one]).map(b => b.name), ['shown'])
  assert.equal(one.buttons?.length, 2, 'filtering must not mutate the script’s own list')
})

test('a script whose buttons are all hidden contributes nothing at all', () => {
  // Upstream's `.some(b => b.visible)` guard. Without it a card with eight
  // hidden buttons and one shown produces eight empty groups.
  const scripts = [
    script({ id: 'empty', buttons: [{ name: 'h1', visible: false }, { name: 'h2', visible: false }] }),
    script({ id: 'real', buttons: [{ name: 'go', visible: true }] }),
  ]

  const shown = visibleButtons(scripts)
  assert.deepEqual(shown.map(one => one.name), ['go'])
  assert.deepEqual([...new Set(shown.map(one => one.scriptId))], ['real'])
})

test('order is declaration order, across scripts and within one', () => {
  /*
   * Upstream groups by script and does not sort within a group
   * (`button_map` is built from the array as declared). A card that publishes
   * `['Start', 'Stop']` means that order; sorting them would read as a bug in
   * the card.
   */
  const scripts = [
    script({ id: 'first', buttons: [{ name: 'b', visible: true }, { name: 'a', visible: true }] }),
    script({ id: 'second', buttons: [{ name: 'c', visible: true }] }),
  ]

  assert.deepEqual(visibleButtons(scripts).map(one => one.name), ['b', 'a', 'c'])
})

test('each button carries the script that published it', () => {
  /*
   * Two scripts may publish buttons with the same label, and the label is all a
   * reader sees. Without the owner there would be no way to tell them apart —
   * and no way to build the event name, which is keyed on the script id.
   */
  const scripts = [
    script({ id: 's1', name: 'Phone UI', buttons: [{ name: 'Open', visible: true }] }),
    script({ id: 's2', name: 'Status Bar', buttons: [{ name: 'Open', visible: true }] }),
  ]

  assert.deepEqual(visibleButtons(scripts), [
    { scriptId: 's1', scriptName: 'Phone UI', name: 'Open' },
    { scriptId: 's2', scriptName: 'Status Bar', name: 'Open' },
  ])
})
