/**
 * The masthead's settings control carries a handle that survives translation.
 *
 * Sibling of `sidebar-tabs.test.ts`, same failure: the button's only identity
 * was its translated label, so an acceptance script asking for `Settings` stops
 * matching the moment the shell speaks anything else. `data-control` is the
 * handle; the visible text stays the accessible name.
 *
 * Pinned against the source, as `shell-page.test.ts` and `sidebar-tabs.test.ts`
 * are: there is no DOM harness for a `.tsx` here, and a fact about markup is a
 * fact about the file that writes it.
 *
 * @module iris-web/tests/masthead-controls
 */

import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'Masthead.tsx'),
  'utf8',
)

test('the settings control is findable without reading its label', () => {
  assert.match(
    source,
    /data-control="settings"/u,
    'the settings button lost its language-independent handle, so locating it needs its translated text again',
  )
})

test('the handle is on the control that opens settings, not merely somewhere in the file', () => {
  /*
   * The failure this catches: the attribute drifting onto a neighbouring
   * element — still present, still unique, still matched by the test above, and
   * pointing an instrument at a button that does nothing. So the assertion is
   * that the handle and the `onOpenSettings` click sit on the same element.
   */
  const opens = source.indexOf('data-control="settings"')
  assert.ok(opens >= 0, 'no settings handle to locate')
  const element = source.slice(source.lastIndexOf('<', opens), source.indexOf('>', opens) + 1)
  assert.match(
    element,
    /onClick=\{onOpenSettings\}/u,
    `the handle is on an element that does not open settings: ${element.slice(0, 160)}`,
  )
})

test('the visible label stays the accessible name', () => {
  /*
   * Deliberately no `aria-label` on this button, and this pins the decision so
   * the next reader does not "fix" it. The button has visible text; an
   * `aria-label` would override that name for a screen reader, and a translated
   * one would vary with the language exactly like the text — buying an
   * instrument nothing while costing a reader the name they can see. The nav
   * toggle above it is the opposite case and keeps its label: its content is
   * `☰`, which names nothing.
   */
  const opens = source.indexOf('data-control="settings"')
  const element = source.slice(source.lastIndexOf('<', opens), source.indexOf('>', opens) + 1)
  assert.doesNotMatch(
    element,
    /aria-label/u,
    'an aria-label here replaces the visible label for a screen reader and still varies by language',
  )
})
