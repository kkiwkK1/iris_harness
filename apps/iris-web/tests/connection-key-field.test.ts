/**
 * The connection form's key field, and the model picker beside it.
 *
 * **Source assertions, with the compromise this package already names**: the
 * panel is a `.tsx` module and Node's type stripping does not transform JSX, so
 * no `node --test` file can import and render it. What is checked here is that
 * the structure still encodes the decisions — which is exactly the right shape
 * for these particular decisions, because both of them are *absences*, and an
 * absence is what a rendering test is worst at seeing. "The field does not echo
 * a stored key" cannot be observed by looking at one render; it is a property of
 * the source.
 *
 * Two things are pinned:
 *
 * - **The key field is `type="password"` and its value is the form's own
 *   scratch field, never a read.** No read ever returns a key, so a `value`
 *   sourced from a profile would either render `undefined` or — worse, the day
 *   somebody "fixes" the protocol — render the credential. There is exactly one
 *   `<input type="password">` in this module and its `value` must be
 *   `form.apiKey`. (The editor and the list live in one module deliberately, so
 *   "exactly one credential field in the whole connection surface" stays a
 *   statement this file can make.)
 * - **The model control is a `<select>` when there is a list**, which is the
 *   user's request ("改从 models list 里面选择"), with the text input kept only
 *   as the named fallback.
 *
 * Three wirings the panel around them depends on are pinned here for the same
 * reason — they are decisions visible in the source and invisible in a render:
 * the editor is *mounted* only while a provider is being edited (which is what
 * makes "no field in the panel body" structural rather than a habit), editing
 * the provider in use re-uses it afterwards (because `connection.save` writes
 * the file and installs no route), and the panel's "use" is global (no `chatId`
 * on the wire).
 *
 * The copy half is checked properly: every key the panel names must exist in
 * both dictionaries. `i18n.test.ts` holds the other direction for the whole
 * shell, and `tools/render-check.tsx` holds the panel's *shape* — three blocks,
 * one current row, no resident field — on a real render.
 *
 * @module iris-web/tests/connection-key-field
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL = readFileSync(join(HERE, '..', 'src', 'app', 'ConnectionPanel.tsx'), 'utf8')
const STORE = readFileSync(join(HERE, '..', 'src', 'client', 'store.ts'), 'utf8')

test('the key field is password-typed, and there is exactly one of it', () => {
  const password = PANEL.match(/type="password"/g) ?? []
  assert.equal(password.length, 1, 'the panel should have exactly one credential field')
  // A `type="text"` credential field is the failure this pins: it is invisible
  // in review (the form looks right) and visible to everyone behind the reader.
  assert.doesNotMatch(
    PANEL,
    /aria-label=\{t\('apiKeyLabel'\)\}[\s\S]{0,120}type="text"/,
    'the API key field must not be a text input',
  )
})

test('the key field’s value is the form’s own scratch field and nothing read', () => {
  /*
   * The window around the one password input. Asserting on a window rather
   * than on the file keeps this from passing because *some* line elsewhere
   * says `value={form.apiKey}`.
   */
  const at = PANEL.indexOf('type="password"')
  assert.ok(at > 0)
  const field = PANEL.slice(at - 400, at + 400)
  assert.match(field, /value=\{form\.apiKey\}/, 'the key field is not bound to the form’s own value')

  // The shapes that would mean a read is being echoed. `hasKey` and `keyTail`
  // are the only things a read returns about a key, and neither may reach a
  // `value`: they describe a credential, they are not one.
  assert.doesNotMatch(field, /value=\{[^}]*keyTail/, 'the key field renders the stored key’s tail as its value')
  assert.doesNotMatch(field, /value=\{[^}]*profile\./, 'the key field renders something from a profile read')
  assert.doesNotMatch(field, /defaultValue/, 'a defaultValue would seed the field from a read')
})

test('a stored key is announced, so an empty field does not read as "paste it again"', () => {
  // The user's report is that the key had to be re-entered every time. The fix
  // is behavioural (the host reuses it), but a form that says nothing about it
  // would still send the reader looking for a key most providers show once.
  assert.match(PANEL, /apiKeyPlaceholderKeep/, 'the field never says that blank keeps the saved key')
  assert.match(PANEL, /apiKeyStored/, 'a saved key is not announced at all')
  // Clearing stays an explicit act. Were it a side effect of an empty field,
  // every edit of a label would disarm the profile.
  assert.match(PANEL, /clearKey: true/, 'clearing the key is no longer an explicit action')
})

test('the model control is a select when a list exists, and a text field only as the named fallback', () => {
  // Ordered: the `<select>` branch has to be the one guarded by a non-empty
  // list, with the input in the else. Matching on the guard rather than on
  // "there is a select somewhere" — the provider dropdown is also a select.
  assert.match(
    PANEL,
    /form\.models !== undefined && form\.models\.length > 0 \? \([\s\S]{0,200}<select/,
    'the model control is not a select driven by the probed list',
  )
  // The current value survives a list that does not contain it. Without this
  // row, opening the editor on such a profile and touching the dropdown would
  // silently re-point it at whatever the endpoint happens to list first.
  assert.match(PANEL, /modelCustomCurrent/, 'a current value outside the list has no row of its own')
  // Both empty states are distinguished, because the next step differs.
  assert.match(PANEL, /modelsNoneYet/, 'never-probed has no sentence')
  assert.match(PANEL, /modelsEndpointOffersNone/, 'probed-and-empty has no sentence')
  assert.match(PANEL, /refreshModels/, 'there is no way to re-fetch the list')
})

test('a probe sends the profile id, which is what lets the stored key be reused', () => {
  // The whole "type the key once" behaviour is host-side, and this is the one
  // line in the browser it depends on: without `profileId`, the host cannot
  // know whose stored key is in play and the form is back to demanding a paste.
  assert.match(
    PANEL,
    /testConnection\(\{[\s\S]{0,200}profileId: form\.editId/,
    'the probe does not tell the host which profile it is testing',
  )
  // And the key goes only when something was typed.
  assert.match(PANEL, /form\.apiKey === '' \? \{\} : \{ apiKey: form\.apiKey \}/)
})

test('the model saved off-list is reported, not refused', () => {
  // Non-blocking on purpose: a list can be incomplete and a provider can serve
  // aliases, so blocking would make the dropdown a cage. What must not happen
  // is silence.
  assert.match(PANEL, /modelNotInList/, 'an off-list model is saved with no word about it')
  assert.doesNotMatch(
    PANEL,
    /if \(!form\.models\.includes\(form\.model\)\) return/,
    'an off-list model must not block the save',
  )
})

test('the editor is mounted only while a provider is being edited', () => {
  // This is what makes the render check's "no field in the panel body" a
  // property rather than a coincidence: a `Modal` kept mounted and merely
  // closed would still be a form holding state, and re-opening it for another
  // provider would show the previous one's endpoint under the new one's title.
  assert.match(PANEL, /<Modal/, 'the editor is not a Modal any more — the render check assumes it is')
  assert.match(
    PANEL,
    /\{editing === undefined \? null : \(\s*\n\s*<ProviderEditor/,
    'the editor is not conditionally mounted, so its form survives being closed',
  )
})

test('editing the provider in use re-uses it, because a save installs no route', () => {
  /*
   * The load-bearing line. `connection.save` writes the profile file and
   * nothing else — it does not call `#installConnectionFor` and does not write
   * the settings layer that names the route; only `connection.activate` does
   * either (`packages/iris-app-service/src/service.ts`, read 2026-09-09). So
   * changing the endpoint or model of the row in force would sit in the file
   * while generation kept going to the old address, silently, and the only
   * symptom would be a reply from a provider the panel says is not selected.
   */
  const at = PANEL.indexOf('onSaved={result')
  assert.ok(at > 0, 'the editor no longer reports its saves to the panel')
  const handler = PANEL.slice(at, at + 1600)
  assert.match(handler, /const wasCurrent = result\.editId !== undefined && result\.editId === activeId/)
  assert.match(
    handler,
    /wasCurrent[\s\S]{0,200}actions\.activateConnection\(result\.editId\)/,
    'saving the provider in use does not re-apply it',
  )
})

test('the panel’s “use” is global — no chatId reaches connection.activate', () => {
  // The user's separation: the provider list is the host's list, and the
  // per-conversation switch is the model capsule under the composer
  // (`setChatModel`). Scoped to whichever chat happened to be open, one list
  // meant two different things depending on where the reader was standing.
  const at = STORE.indexOf('async activateConnection')
  assert.ok(at > 0)
  const action = STORE.slice(at, at + 1800)
  assert.match(action, /client\.call\('connection\.activate',/, 'the action no longer activates anything')
  // Scoped to the activation's own argument list, not to the whole action: the
  // follow-up `settings.get` below legitimately carries a `chatId`, and a
  // pattern wide enough to see it would fail on the correct code.
  assert.doesNotMatch(
    action,
    /connection\.activate',[^)]*chatId/,
    'a chatId is being sent with the activation again',
  )
  // The follow-up read is not optional: the global layer moved under an open
  // conversation, so what that conversation effectively generates with changed.
  assert.match(action, /client\.call\('settings\.get', \{ chatId \}\)/, 'the open chat’s settings are not re-read')
})

test('every copy key the panel names exists in both dictionaries', () => {
  const named = new Set([...PANEL.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map(match => match[1]!))
  assert.ok(named.size > 20, `the scan found only ${String(named.size)} keys — it is not reading the panel`)
  for (const key of named) {
    assert.ok(Object.hasOwn(en, key), `the panel names t('${key}'), which en does not have`)
    assert.ok(
      Object.hasOwn(DICTIONARIES.zh, key as StringKey),
      `the panel names t('${key}'), which zh does not have`,
    )
  }
})
