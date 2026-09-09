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
 * Five wirings the panel around them depends on are pinned here for the same
 * reason — they are decisions visible in the source and invisible in a render:
 * the editor is *mounted* only while a provider is being edited (which is what
 * makes "no field in the panel body" structural rather than a habit), editing
 * the provider in use re-uses it afterwards (because `connection.save` writes
 * the file and installs no route), and the panel's "use" is global (no `chatId`
 * on the wire).
 *
 * **The 「宿主环境」 row's own pins are gone with the row** (web §79). What stands
 * in their place is the other kind of assertion: that the strings, the store
 * action and the protocol member it used are deleted rather than merely
 * unreferenced — `i18n.test.ts` checks used → dictionary only, so an unused key
 * is never reported, and a store action nobody calls is a path back to a
 * decision the user reversed.
 *
 * The model control gains the half the user asked for on 2026-09-10 (「模型要
 * 支持添加自定义名称的模型」): a fixed 「自定义…」 option that turns the dropdown
 * back into a field. It is pinned here rather than in `render-check` for the
 * reason the editor's other decisions are — the dialog is a `Modal` mounted
 * only while editing, and a server render cannot open it.
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
  // list *and* by the reader not having asked to type, with the input in the
  // else. Matching on the guard rather than on "there is a select somewhere" —
  // the provider dropdown is also a select.
  assert.match(
    PANEL,
    /const listed = form\.models !== undefined && form\.models\.length > 0/,
    'the "is there a list" question is not asked in one place',
  )
  assert.match(
    PANEL,
    /\{listed && form\.modelTyping !== true \? \([\s\S]{0,200}<select/,
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

test('a list is a shortcut, never a gate: 「自定义…」 turns the dropdown back into a field', () => {
  /*
   * The user's ruling, 2026-09-10, verbatim: 「供应商编辑这里模型要支持添加自定义
   * 名称的模型，以防止用户无法使用到还在内测的模型」. The pre-existing off-list path
   * only *preserved* such a name (a stored model the list lacks keeps a row of
   * its own); nothing let anyone enter one, so a provider whose model was in
   * closed testing could be read and never written.
   */
  // The option is in the select, and it is the last child — a reader scanning
  // for their model reads the endpoint's own list first.
  const selectAt = PANEL.indexOf("{listed && form.modelTyping !== true ? (")
  assert.ok(selectAt > 0, 'the model select is gone')
  const control = PANEL.slice(selectAt, selectAt + 1600)
  assert.match(
    control,
    /form\.models \?\? \[\]\)\.map\(model =>[\s\S]{0,200}<option value=\{CUSTOM_MODEL\}>\{t\('modelCustomOption'\)\}/,
    'the custom option is missing, or it is not after the endpoint’s own list',
  )
  // The sentinel is not a model name and never becomes one: choosing it
  // switches the control and leaves the value alone, so the save cannot store
  // it and a blanked field cannot disable 保存 the moment it is chosen.
  assert.match(
    control,
    /if \(event\.target\.value === CUSTOM_MODEL\) patchForm\(\{ modelTyping: true \}\)/,
    'the custom option writes itself into the model instead of switching the control',
  )
  assert.doesNotMatch(control, /modelTyping: true, model: ''/, 'choosing 「自定义…」 blanks the model')
  // The field it switches to is focused, and only in that case: autofocusing
  // the never-probed provider would take the caret off the endpoint field
  // every time the dialog opens.
  assert.match(PANEL, /autoFocus=\{form\.modelTyping === true\}/, 'the typed field is not focused')
  // And there is a way back while a list exists, so it is not a one-way door.
  assert.match(
    PANEL,
    /\{listed && form\.modelTyping === true \? \([\s\S]{0,400}modelFromList/,
    'nothing offers the list back once 「自定义…」 is chosen',
  )
  // The sentence that says why the field exists at all.
  assert.match(PANEL, /modelCustomTyped/, 'the typed field explains nothing')
})

test('the panel’s empty state says what to do, and offers the act', () => {
  // With no provider in use the host refuses to generate (host §61), so this is
  // the one thing between a fresh install and a reply. `render-check` renders
  // it; what a render cannot see is that the *button* is inside the branch
  // rather than only in the add block below it.
  const at = PANEL.indexOf('{profiles.length === 0 ? (')
  assert.ok(at > 0, 'the panel no longer has an empty state at all')
  const branch = PANEL.slice(at, at + 900)
  assert.match(branch, /t\('noSavedConnections'\)/, 'the empty state says nothing')
  assert.match(branch, /setEditing\(freshForm\(\)\)/, 'the empty state offers no way to add a provider')
  assert.match(branch, /t\('connAddProvider'\)/, 'the empty state’s button is unlabelled')
})

test('the environment is gone from the panel, the store and the dictionary', () => {
  /*
   * The absence half of the user's ruling of 2026-09-10 (「宿主环境这个功能废弃了」),
   * pinned three ways because three different things would bring it back.
   *
   * The **panel** would bring the row back as markup — `render-check` holds
   * that end on a real render. What this file holds is the two ends a render
   * cannot see.
   */
  /*
   * The store action: a caller-less path back to "no profile applied" is a path
   * back to a decision the user reversed.
   *
   * The *call* and the *declaration*, not the word — `store.ts` records in
   * prose what it used to do, and an assertion wide enough to see that sentence
   * would go red on the explanation of why the code is gone. Written after
   * exactly that: the first spelling was `STORE.includes('connection.deactivate')`
   * and it failed on the comment recording the deletion.
   */
  assert.doesNotMatch(
    STORE,
    /client\.call\('connection\.deactivate'/,
    'the store can still ask for no profile to be applied',
  )
  assert.doesNotMatch(STORE, /async deactivateConnection\(/, 'the store still declares the action')
  assert.doesNotMatch(STORE, /adoptHostKey\??:/, 'the store can still ask the host to copy its own key')
  /*
   * The strings. **Deleted from the dictionary, not merely unreferenced** —
   * `i18n.test.ts` checks used → dictionary only, so an unused key is never
   * reported, which is how two of them survived until web §77 went looking.
   *
   * All twelve, including the four the *composer* owned (`STRINGS.md`'s own
   * count for this section), because the dictionary is one object and this is
   * the only check that reads it in the deleting direction.
   */
  const deleted = [
    // The 「宿主环境」 row itself: its title, its explanation, its three key
    // states, its 存为供应商 button and that button's receipt.
    'hostDefaultTitle', 'hostDefaultNote', 'hostDefaultKeyEnv', 'hostDefaultKeyAnon', 'hostDefaultNoKey',
    'adoptHostConnection', 'hostAdopted',
    // Only that row was read-only, and only that row could carry no endpoint.
    'connReadOnly', 'connTestNeedsEndpoint',
    // The collapsed head's old summary key, replaced by `connNoneSelected`.
    'noActiveConnection',
    // The capsule's two headings for the environment as a source.
    'modelMenuFromHost', 'modelMenuFromHostEnv',
  ]
  assert.equal(deleted.length, 12, 'the count STRINGS.md states and the list checked here have drifted')
  for (const key of deleted) {
    assert.equal(Object.hasOwn(en, key), false, `the deleted string "${key}" is still in the dictionary`)
  }
  // And the panel names none of them. The *call*, not the word: this module's
  // prose says what these used to be for, and a pattern wide enough to see the
  // prose would go red on the explanation.
  for (const key of deleted) {
    assert.doesNotMatch(PANEL, new RegExp(`t\\('${key}'`), `the panel still names t('${key}')`)
  }
  // And the row's class, which is the one thing a stale style would keep alive.
  assert.doesNotMatch(PANEL, /iris-conn--host/, 'the host row’s own class is still rendered')
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
