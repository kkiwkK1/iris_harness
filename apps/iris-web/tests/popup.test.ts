/**
 * SillyTavern's popup semantics, checked against upstream's source rather than
 * against what the dialog looks like.
 *
 * Every case here is one where **a plausible wrong implementation disagrees**.
 * Getting a confirm to show two buttons is easy and proves almost nothing; the
 * cases that discriminate are the ones upstream decides in two passes or with a
 * per-type exception — a string custom button's result counting from `2` rather
 * than from `CUSTOM1`, a CONFIRM's captions being Yes/No, a TEXT popup's cancel
 * being opt-in while a CONFIRM's is opt-out, `CANCELLED` being `null` and not a
 * number. Each is annotated with the upstream line it comes from.
 *
 * The four shapes at the bottom are the ones a real bundle uses: MagVarUpdate's
 * `artifact/bundle.js` reaches `callGenericPopup` six times across four distinct
 * shapes (read 2026-09-08), and the corpus's own card scripts and interface text
 * reach it zero times — the population that exercises this API is the imported
 * bundle, not the cards' own sources.
 *
 * @module iris-web/tests/popup
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  IGNORED_POPUP_OPTIONS,
  POPUP_MEMBERS,
  POPUP_RESULT,
  POPUP_TYPE,
  buildTextWithHeader,
  controlCaption,
  customPopupButtons,
  defaultPopupLabel,
  inputHelperValue,
  normalizePopupContent,
  planPopup,
  popupValue,
  showsControl,
  type PopupButtonPlan,
} from '../src/sandbox/popup.ts'

/** The captions of a plan's row, in render order, with defaults left as tokens. */
function row(buttons: readonly PopupButtonPlan[]): string[] {
  return buttons.map(button => button.text ?? `<${button.label}>`)
}

test('the enums are upstream’s, and CANCELLED is null rather than a number', () => {
  /*
   * [ST] popup.js:9-36. The one value that cannot be approximated is
   * `CANCELLED`: MVU compares `result === POPUP_RESULT.CANCELLED`
   * (`legacy_chat.ts:27-33`), so a `-1` or an `undefined` would send every
   * dismissal down the wrong branch while every other value still matched.
   */
  assert.deepEqual(POPUP_TYPE, { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 })
  assert.equal(POPUP_RESULT.AFFIRMATIVE, 1)
  assert.equal(POPUP_RESULT.NEGATIVE, 0)
  assert.equal(POPUP_RESULT.CANCELLED, null)
  assert.notEqual(POPUP_RESULT.CANCELLED, 0, 'a dismissal is not a decline')
  assert.equal(POPUP_RESULT.CUSTOM1, 1001)
  assert.equal(POPUP_RESULT.CUSTOM9, 1009)
})

test('the five names are one list, so `get` and `in` cannot drift apart', () => {
  // The frame's `has` trap reads this same list. A member that answers a read
  // while `'name' in ctx` says no is what made every other unbuilt member here
  // inconsistent, and it is the shape a card's feature test walks into.
  assert.deepEqual([...POPUP_MEMBERS].sort(), [
    'POPUP_RESULT', 'POPUP_TYPE', 'Popup', 'callGenericPopup', 'callPopup',
  ].sort())
})

test('a string custom button’s result counts from 2, not from CUSTOM1', () => {
  /*
   * [ST] popup.js:55 (JSDoc: "their result will be in order from 2 onward")
   * and :284 (`{ text: x, result: index + 2 }`). MVU's branch is
   * `result === POPUP_RESULT.CUSTOM1 || result === 2` — two spellings that are
   * only both true because there is exactly one string button, so an
   * implementation that used 1001 would pass MVU and fail every card with two.
   */
  const customs = customPopupButtons(['first', 'second', 'third'])
  assert.deepEqual(customs.leading.map(button => button.result), [2, 3, 4])
  assert.notEqual(customs.leading[0]?.result, POPUP_RESULT.CUSTOM1)
})

test('custom buttons are prepended before ok; appendAtEnd sends one past cancel', () => {
  // [ST] popup.js:312-315 — `insertBefore(buttonElement, this.okButton)` unless
  // `appendAtEnd`, and the template's row is [ok, cancel] (index.html:6466-6469).
  const plan = planPopup('body', POPUP_TYPE.CONFIRM, '', {
    okButton: 'Clean only',
    cancelButton: 'Never',
    customButtons: ['Back up and clean', { text: 'Later', result: 9, appendAtEnd: true }],
  })
  assert.deepEqual(row(plan.buttons), ['Back up and clean', 'Clean only', 'Never', 'Later'])
  assert.deepEqual(plan.buttons.map(button => button.result), [2, 1, 0, 9])
})

test('a custom button with no result does not close the popup', () => {
  // [ST] popup.js:69 — "If no result is specified, this button will **not**
  // close the popup". Absence is the state, so the key must be absent rather
  // than defaulted: a `result: null` would close it with CANCELLED instead.
  const customs = customPopupButtons([{ text: 'Copy' }])
  assert.equal('result' in (customs.leading[0] ?? {}), false)
})

test('each kind’s default captions are upstream’s, and they differ per kind', () => {
  // [ST] popup.js:454-503 with the template's attributes (index.html:6455).
  assert.equal(defaultPopupLabel(POPUP_TYPE.CONFIRM, 'ok'), 'yes')
  assert.equal(defaultPopupLabel(POPUP_TYPE.CONFIRM, 'cancel'), 'no')
  assert.equal(defaultPopupLabel(POPUP_TYPE.INPUT, 'ok'), 'save')
  assert.equal(defaultPopupLabel(POPUP_TYPE.CROP, 'ok'), 'crop')
  assert.equal(defaultPopupLabel(POPUP_TYPE.TEXT, 'ok'), 'ok')
  assert.equal(defaultPopupLabel(POPUP_TYPE.TEXT, 'cancel'), 'cancel')
})

test('a TEXT popup’s cancel is opt-in; a CONFIRM’s is opt-out', () => {
  /*
   * [ST] popup.js:454-468 — TEXT hides cancel on `!cancelButton`, CONFIRM only
   * on `=== false`. One rule for both would either show a Cancel that upstream
   * never draws on a text popup, or hide the No on every default confirm.
   */
  assert.equal(showsControl(POPUP_TYPE.TEXT, 'cancel', undefined), false)
  assert.equal(showsControl(POPUP_TYPE.TEXT, 'cancel', null), false)
  assert.equal(showsControl(POPUP_TYPE.TEXT, 'cancel', true), true)
  assert.equal(showsControl(POPUP_TYPE.CONFIRM, 'cancel', undefined), true)
  assert.equal(showsControl(POPUP_TYPE.CONFIRM, 'cancel', false), false)
  // ok is hidden only by an explicit false, on every kind that has a row.
  assert.equal(showsControl(POPUP_TYPE.CONFIRM, 'ok', undefined), true)
  assert.equal(showsControl(POPUP_TYPE.CONFIRM, 'ok', false), false)
  // DISPLAY has no row at all; it gets the corner close.
  assert.equal(showsControl(POPUP_TYPE.DISPLAY, 'ok', 'Fine'), false)
  assert.equal(showsControl(POPUP_TYPE.DISPLAY, 'cancel', 'Fine'), false)
})

test('the caption comes from upstream’s two passes, including its three edges', () => {
  /*
   * [ST] popup.js:268-270 then :454-503. The constructor writes the option if it
   * is a string and a literal otherwise; the per-type switch overwrites that
   * only when the option is falsy AND the type has an override.
   */
  // A string wins, `''` included — and TEXT has no override to replace it.
  assert.deepEqual(controlCaption('', POPUP_TYPE.TEXT, 'ok'), { text: '' })
  // `''` is falsy, and CONFIRM does have one.
  assert.deepEqual(controlCaption('', POPUP_TYPE.CONFIRM, 'ok'), { label: 'yes' })
  // `true` is truthy, so the override never runs: upstream shows "OK" here.
  assert.deepEqual(controlCaption(true, POPUP_TYPE.CONFIRM, 'ok'), { label: 'ok' })
  // A cancel's constructor literal is the template's "Cancel", not "No".
  assert.deepEqual(controlCaption(true, POPUP_TYPE.CONFIRM, 'cancel'), { label: 'cancel' })
  assert.deepEqual(controlCaption(null, POPUP_TYPE.INPUT, 'cancel'), { label: 'cancel' })
})

test('a DISPLAY popup has no button row and gets the corner close instead', () => {
  // [ST] popup.js:478-483. Its custom buttons still render — the switch hides
  // `buttonControls`, and a custom button was inserted into it, so upstream
  // hides those too; that is the one place this is deliberately not copied,
  // because a hidden button a card declared is indistinguishable from a bug.
  const plan = planPopup('<p>a table</p>', POPUP_TYPE.DISPLAY, '', { okButton: 'Fine' })
  assert.deepEqual(plan.buttons, [])
  assert.equal(plan.closeCorner, true)
})

test('the value rule is upstream’s, and NEGATIVE is not CANCELLED', () => {
  /*
   * [ST] popup.js:750-770. The INPUT row is `result >= AFFIRMATIVE`, so a
   * custom button on an input popup also returns the text — upstream's
   * behaviour, and the reason a card cannot tell its customs apart there.
   */
  assert.equal(popupValue(POPUP_TYPE.INPUT, 1, 'typed'), 'typed')
  assert.equal(popupValue(POPUP_TYPE.INPUT, 2, 'typed'), 'typed', 'a custom result is >= AFFIRMATIVE')
  assert.equal(popupValue(POPUP_TYPE.INPUT, 0, 'typed'), false)
  assert.equal(popupValue(POPUP_TYPE.INPUT, null, 'typed'), null)
  // Every other kind resolves with the result itself, `null` included.
  assert.equal(popupValue(POPUP_TYPE.CONFIRM, null, ''), null)
  assert.equal(popupValue(POPUP_TYPE.CONFIRM, 0, ''), 0)
  assert.equal(popupValue(POPUP_TYPE.CONFIRM, 1001, ''), 1001)
})

test('Popup.show.input returns ‘’ as a success and every other falsy as null', () => {
  // [ST] popup.js:110-112 — the one place upstream converts a result into a
  // different type, which is why it is one function rather than three copies.
  assert.equal(inputHelperValue(''), '')
  assert.equal(inputHelperValue('typed'), 'typed')
  assert.equal(inputHelperValue(false), null)
  assert.equal(inputHelperValue(null), null)
})

test('BuildTextWithHeader is reproduced, header unescaped as upstream leaves it', () => {
  // [ST] popup.js:888-898. Escaping the header here would make Iris render a
  // different document than upstream for the same call; the shell's sanitizer
  // is what makes that safe, and it runs over the whole string either way.
  assert.equal(buildTextWithHeader(null, 'body'), 'body')
  assert.match(buildTextWithHeader('Head', 'body'), /^<h3>Head<\/h3>/)
  assert.match(buildTextWithHeader('<b>Head</b>', ''), /<h3><b>Head<\/b><\/h3>/)
})

test('all three content shapes collapse to one HTML string', () => {
  /*
   * [ST] popup.js:520-530 accepts a jQuery set, an `HTMLElement` or a string.
   * None of the first two can cross a `postMessage`, and the DOM-node case is
   * not hypothetical: MagVarUpdate's profile-delete confirm builds a `<span>`
   * with `textContent` and passes the element.
   */
  assert.deepEqual(normalizePopupContent('<p>x</p>'), { html: '<p>x</p>', unknown: false })
  assert.deepEqual(
    normalizePopupContent({ outerHTML: '<span>Delete "A"?</span>' }),
    { html: '<span>Delete "A"?</span>', unknown: false },
  )
  // A jQuery set: every element of it, which is what `.append(set)` puts in.
  assert.deepEqual(
    normalizePopupContent({ jquery: '3.5.1', length: 2, 0: { outerHTML: '<i>a</i>' }, 1: { outerHTML: '<i>b</i>' } }),
    { html: '<i>a</i><i>b</i>', unknown: false },
  )
  // A text node has no `outerHTML`; upstream warns and shows nothing, so its
  // text is escaped and kept — and the shape is still reported as unrecognised.
  assert.deepEqual(
    normalizePopupContent({ textContent: 'a < b & c' }),
    { html: 'a &lt; b &amp; c', unknown: true },
  )
  assert.deepEqual(normalizePopupContent(42), { html: '', unknown: true })
  // Upstream's `BuildTextWithHeader` returns `text` unchanged, so nullish is a
  // real arrival rather than a mistake: an empty popup, not a warning.
  assert.deepEqual(normalizePopupContent(undefined), { html: '', unknown: false })
})

test('an option this surface drops is named, and one it honours is not', () => {
  const plan = planPopup('x', POPUP_TYPE.CONFIRM, '', {
    wide: true,
    allowVerticalScrolling: true,
    onClosing: () => false,
    customInputs: [{ id: 'a', label: 'A' }],
    classes: 'unused',
  } as never)
  assert.deepEqual([...plan.ignored].sort(), ['customInputs', 'onClosing'])
  assert.equal(plan.measure, 'wide', 'wide is honoured, so it is not in the list')
  assert.equal(plan.scrolling, true)
  // Nothing passed means nothing named: a report that fires on every popup is
  // a report nobody reads.
  assert.deepEqual(planPopup('x', POPUP_TYPE.CONFIRM, '', {}).ignored, [])
  // The list is what the plan draws from, so it cannot silently shrink.
  assert.ok(IGNORED_POPUP_OPTIONS.includes('onClosing'))
})

test('an unrecognised kind still draws, as upstream’s warn-and-continue does', () => {
  /*
   * [ST] popup.js:504-507: `default: console.warn('Unknown popup type.')`, and
   * then it renders anyway. **Both** controls survive, and that is the part
   * worth pinning rather than guessing: nothing before the switch hides the ok
   * or cancel buttons (only `mainInput`, `inputControls`, `closeButton` and
   * `cropWrap` are hidden up front, `:446-451`), so the default arm leaves the
   * template's row exactly as it came — [ok, cancel] with the constructor's own
   * literals. This assertion was written the other way round first and the test
   * is what corrected it.
   */
  const plan = planPopup('x', 99, '', {})
  assert.equal(plan.kind, 99, 'the kind the card passed rides along so a report can name it')
  assert.deepEqual(row(plan.buttons), ['<ok>', '<cancel>'])
})

test('CROP is refused by name and resolves null rather than pretending', () => {
  // Iris draws no cropper, so there is nothing to crop. `null` is upstream's own
  // value for a cancelled crop, and the refusal is on the record.
  const plan = planPopup('x', POPUP_TYPE.CROP, '', { cropImage: 'data:,' })
  assert.ok(plan.ignored.includes('POPUP_TYPE.CROP'))
  assert.equal(popupValue(POPUP_TYPE.CROP, POPUP_RESULT.AFFIRMATIVE, ''), null)
})

/*
 * The four shapes a real bundle uses, as a table.
 *
 * Read out of MagVarUpdate's `artifact/bundle.js` on 2026-09-08: six
 * `callGenericPopup` calls, four distinct shapes (the settings-panel pair
 * appears twice, once minified). This is the shape check the whole surface
 * exists for — the third row is the one that crashed a real 26-message chat.
 */
test('MagVarUpdate’s four measured call shapes plan correctly', () => {
  // 1. Profile switch with unsaved changes — plain confirm, ok/cancel, and the
  //    branch reads `CANCELLED || NEGATIVE`.
  const switchDirty = planPopup('unsaved changes', POPUP_TYPE.CONFIRM, '', {
    okButton: 'Continue',
    cancelButton: 'Cancel',
  })
  assert.deepEqual(row(switchDirty.buttons), ['Continue', 'Cancel'])
  assert.deepEqual(switchDirty.buttons.map(button => button.result), [1, 0])

  // 2. Profile delete — the same shape, but the content is a **DOM element**
  //    the bundle built with `document.createElement('span')`.
  const deleteConfirm = planPopup(
    { outerHTML: '<span>Delete API profile “A”?</span>' },
    POPUP_TYPE.CONFIRM,
    '',
    { okButton: 'Delete', cancelButton: 'Cancel' },
  )
  assert.equal(deleteConfirm.content, '<span>Delete API profile “A”?</span>')

  // 3. The legacy variable cleanup — three buttons, custom leading, and the
  //    results MVU actually tests for: 2 (its `CUSTOM1 || 2`), 1, 0.
  const cleanup = planPopup('clean old variables?', POPUP_TYPE.CONFIRM, '', {
    okButton: '仅清理',
    cancelButton: '不再提醒',
    customButtons: ['备份并清理'],
  })
  assert.deepEqual(row(cleanup.buttons), ['备份并清理', '仅清理', '不再提醒'])
  assert.deepEqual(cleanup.buttons.map(button => button.result), [2, 1, 0])
  assert.equal(cleanup.buttons[0]?.result, 2, 'MVU reads CUSTOM1 || 2, and 2 is the value')

  // 4. Character-override conflict — confirm whose okButton is not "yes", and
  //    whose branch reads `=== AFFIRMATIVE`, so ok must carry exactly 1.
  const conflict = planPopup('entry was modified', POPUP_TYPE.CONFIRM, '', {
    okButton: 'Overwrite',
    cancelButton: 'Load latest configuration',
  })
  assert.equal(conflict.buttons.find(button => button.slot === 'ok')?.result, POPUP_RESULT.AFFIRMATIVE)
})
