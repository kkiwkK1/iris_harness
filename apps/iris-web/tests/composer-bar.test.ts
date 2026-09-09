/**
 * The composer bar: the effort ladder's words and layer, the ring's geometry,
 * and the structure of the controls that carry them.
 *
 * The bar is markup in a `.tsx` file, so half of what is worth holding cannot be
 * rendered here (node strips types, it does not transform JSX) and is held by
 * `tools/render-check.tsx` on a real render instead. What this file holds is the
 * half a render cannot see:
 *
 * - **the word list**, against the two other copies of it in the repo — the
 *   host's validator and the fake's — because the failure is silent in both
 *   directions: a menu offering a word the host refuses is a row that throws,
 *   and a host accepting a word the menu does not offer is a setting no surface
 *   can reach;
 * - **the layer** an effort chosen in the bar is written to, which is a property
 *   of two source files and of no render;
 * - **the ring's arithmetic**, which is the one computation in the bar;
 * - **the roles**, because `menuitemradio` versus `menuitem` is the whole reason
 *   the bar has its own menu component and is invisible to everything else.
 *
 * @module iris-web/tests/composer-bar
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  effortInForce,
  effortPatch,
  effortShown,
  REASONING_EFFORTS,
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  ringDash,
} from '../src/app/composer-bar.ts'
import { DICTIONARIES, en, type StringKey } from '../src/app/i18n/strings.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const source = (...parts: string[]): string => readFileSync(join(...parts), 'utf8')

const COMPOSER = source(HERE, '..', 'src', 'app', 'Composer.tsx')
const MENU = source(HERE, '..', 'src', 'app', 'ComposerMenu.tsx')
const STORE = source(HERE, '..', 'src', 'client', 'store.ts')

/**
 * The words in a `['a', 'b']` literal assigned to a named const.
 *
 * Read out of the file rather than imported, because both of the other copies
 * are module-private: the host's is a `const` inside `@iris/app-service`'s
 * settings module and the fake's is one inside its own, and neither should be
 * exported to satisfy a test — exporting a validator's private set is how it
 * stops being the validator's own.
 * @param text - the file.
 * @param name - the const's name.
 * @returns the words, in the order they are written.
 */
function wordsOf(text: string, name: string): string[] {
  const found = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(text)
  assert.ok(found !== null, `${name} is not a list literal any more`)
  return [...(found[1] as string).matchAll(/'([a-z]+)'/g)].map(match => match[1] as string)
}

// --------------------------------------------------------------- the words

test('the six effort words are the host’s six, and the fake’s', () => {
  /*
   * Set equality, not order: the menu leads with `auto` because that row is the
   * absence of a choice, while the host's list is a membership test and is
   * written in the order upstream's own `reasoning_effort_types` is. Order is
   * therefore free; membership is not, in either direction.
   */
  const host = wordsOf(
    source(REPO, 'packages', 'iris-app-service', 'src', 'settings.ts'),
    'REASONING_EFFORTS',
  )
  const fake = wordsOf(
    source(REPO, 'packages', 'iris-client-fake', 'src', 'settings.ts'),
    'EFFORTS',
  )
  // A floor on the fixtures before anything is concluded from them: an empty
  // match would make every comparison below vacuously true.
  assert.equal(host.length, 6, `the host validates ${String(host.length)} effort words`)
  assert.deepEqual([...REASONING_EFFORTS].sort(), [...host].sort(), 'the menu and the host disagree')
  assert.deepEqual([...fake].sort(), [...host].sort(), 'the fake and the host disagree')
  assert.equal(REASONING_EFFORTS[0], 'auto', 'the row that is the absence of a choice must lead')
})

test('the menu builds its rows from the list, and so does the drawer', () => {
  // The one property that keeps the two surfaces the same ladder: neither may
  // spell the words out. Six literals in a `.tsx` file is how one of them comes
  // to offer five.
  assert.match(COMPOSER, /REASONING_EFFORTS\.map\(/, 'the bar spells its own effort rows')
  const drawer = source(HERE, '..', 'src', 'app', 'SettingsDrawer.tsx')
  assert.match(drawer, /REASONING_EFFORTS\.map\(/, 'the drawer spells its own effort rows')
  for (const file of [COMPOSER, drawer]) {
    assert.doesNotMatch(file, /id: 'medium'/, 'an effort word is written out beside the shared list')
  }
})

// ---------------------------------------------------------------- the rules

test('auto is what is in force when nobody chose, and is the row that prints nothing', () => {
  assert.equal(effortInForce(undefined), 'auto', 'a menu with no row ticked answers no question')
  assert.equal(effortInForce('high'), 'high')
  // The capsule's half: `auto` beside a model name adds no fact, because the
  // serializer omits `reasoning_effort` for both absent and `'auto'`.
  assert.equal(effortShown(undefined), undefined)
  assert.equal(effortShown('auto'), undefined)
  assert.equal(effortShown('min'), 'min')
  assert.equal(effortShown('max'), 'max')
})

test('choosing auto clears the field instead of storing the word', () => {
  assert.equal(effortPatch('auto'), null, 'a stored auto is an override with no effect')
  for (const effort of REASONING_EFFORTS.filter(row => row !== 'auto')) {
    assert.equal(effortPatch(effort), effort, `${effort} must be written as itself`)
  }
})

test('an effort chosen in the bar is written to the layer the model is', () => {
  /*
   * The layer rule, as a property of two files.
   *
   * The bar has no scope of its own to write to: it goes through
   * `patchSettings`, which is the settings drawer's action, and that action is
   * what decides the layer — the open conversation when there is one. So the
   * check is in two halves, and both are needed: the composer must reach for
   * that action and no other, and that action must still be the one that scopes
   * itself. Asserting only the first would pass for a `patchSettings` that had
   * quietly become global; asserting only the second would pass for a composer
   * that had grown its own `settings.set`.
   */
  assert.match(
    COMPOSER,
    /actions\.patchSettings\(\{ reasoningEffort: effortPatch\(chosen\) \}\)/,
    'the effort rows no longer write through the drawer’s own action',
  )
  // And nowhere in the composer is the wire called directly, which is the way
  // this could be made global without touching the line above.
  assert.doesNotMatch(COMPOSER, /'settings\.set'/, 'the composer calls the settings wire itself')

  const body = /async patchSettings\(patch: Record<string, unknown>\): Promise<void> \{([\s\S]*?)\n      \},/
    .exec(STORE)?.[1]
  assert.ok(body !== undefined, 'patchSettings is not a method on the store any more')
  assert.match(body, /const chatId = get\(\)\.chatId/, 'patchSettings stopped reading the open chat')
  assert.match(
    body.replace(/\s+/g, ''),
    /\.\.\.\(chatId===undefined\?\{\}:\{chatId\}\)/,
    'patchSettings no longer scopes its write to the open conversation',
  )
})

// ------------------------------------------------------------- the geometry

test('the ring’s arc is the occupancy’s share of the ring', () => {
  /*
   * Read back out of the string the component sets, so what is checked is the
   * value the browser is handed. The ring's own length is the second number, so
   * the ratio is checked against the same declaration rather than against a
   * constant written here twice.
   */
  const parts = (percent: number): [number, number] => {
    const [arc, whole] = ringDash(percent).split(' ').map(Number)
    assert.ok(arc !== undefined && whole !== undefined, `ringDash(${String(percent)}) is not two lengths`)
    return [arc, whole]
  }

  const [, whole] = parts(0)
  assert.equal(whole.toFixed(3), RING_CIRCUMFERENCE.toFixed(3), 'the denominator is not the ring')
  assert.equal(parts(0)[0], 0, 'an empty window draws an arc')
  assert.equal(parts(100)[0].toFixed(3), whole.toFixed(3), 'a full window leaves a gap')
  // A quarter, checked against the whole: the wrong-and-plausible formula here
  // is the diameter instead of the circumference, which passes any test that
  // only asks whether the arc grows.
  assert.ok(Math.abs(parts(25)[0] - whole / 4) < 0.002, 'a quarter of the window is not a quarter of the ring')
  assert.ok(Math.abs(parts(50)[0] - whole / 2) < 0.002, 'half the window is not half the ring')
  // Clamped at both ends. An over-budget reading is a real state
  // (`ringReading` clamps its percent too) and must not draw an arc longer
  // than the ring, which renders as a second lap over the first.
  assert.equal(parts(140)[0].toFixed(3), whole.toFixed(3), 'an over-budget reading draws a second lap')
  assert.equal(parts(-10)[0], 0, 'a negative reading draws backwards')
})

test('the ring fits inside its own box with its stroke on', () => {
  // The mark is drawn in a 24-unit viewBox at stroke-width 2, so the outer edge
  // of the stroke is `RING_RADIUS + 1` from the centre and the box has 12. A
  // radius that grew past this clips the ring on all four sides — which looks
  // like a rendering fault rather than like a number somebody changed.
  assert.ok(RING_RADIUS + 1 <= 12, `a radius of ${String(RING_RADIUS)} clips inside a 24-unit box`)
  assert.ok(RING_RADIUS >= 6, 'a ring this small cannot show a 5% arc')
})

// ----------------------------------------------------------------- the roles

test('a row that belongs to a set announces itself as one', () => {
  /*
   * The reason this component exists rather than the primitives' `Menu`, whose
   * rows are `role="menuitem"` and cannot be otherwise. Six efforts and a list
   * of models are radio sets — exactly one member in force — and a set announced
   * as six independent actions does not say that choosing one un-chooses the
   * rest.
   */
  assert.match(
    MENU,
    /role=\{checked === undefined \? 'menuitem' : 'menuitemradio'\}/,
    'a menu row no longer takes its role from whether it is a set member',
  )
  assert.match(MENU, /'aria-checked': checked/, 'a radio row does not say whether it is the one')
  // The arrow keys must not stop on the sentence rows, which are not buttons at
  // all — the query is what makes that structural.
  assert.match(MENU, /button\[role\^="menuitem"\]:not\(\[disabled\]\)/, 'the keyboard walk lost its filter')

  // And the effort rows pass `checked`, which is what puts them in a set at all:
  // omitting it is a compiling, rendering, wrong-role menu.
  const effortRows = /REASONING_EFFORTS\.map\(row => \(([\s\S]*?)\)\)/.exec(COMPOSER)?.[1]
  assert.ok(effortRows !== undefined, 'the effort rows are not built from the list')
  assert.match(effortRows, /checked=\{row === effortInForce\(effort\)\}/, 'the effort rows are not a radio set')
})

test('every mark-only control in the bar carries a name', () => {
  // Four controls in the bar have no words in them: the two discs, the ring and
  // the override dot. A graphic button with no accessible name is a button a
  // screen reader reads as "button".
  for (const key of ['composerMore', 'send', 'stop'] as const) {
    assert.match(
      COMPOSER,
      new RegExp(`aria-label=\\{t\\('${key}'\\)\\}`),
      `the ${key} control has no accessible name`,
    )
  }
  assert.match(COMPOSER, /aria-label=\{t\('modelOverriddenHere'\)\}/, 'the override dot has no name')
  const ring = source(HERE, '..', 'src', 'app', 'ContextMeter.tsx')
  // The ring's name is the reading itself, which is the fact the capsule used to
  // print — see that module's own doc.
  assert.match(ring, /aria-label=\{label\}/, 'the ring lost the reading as its name')
})

test('the send disc has three states, and the with-a-draft one is only pinnable here', () => {
  /*
   * `tools/render-check.tsx` renders two of the three — empty (idle and
   * `disabled`) and mid-turn (stop, beside a turning ring) — and cannot render
   * the third: the draft is `useState` inside the component, `renderToString`
   * runs no effects, and the card bus that could write a draft is installed by
   * one. So the branch that inks the disc up on the first keystroke is held
   * against the source, and this comment is what says which of the three is
   * held how.
   */
  assert.match(
    COMPOSER,
    /iris-composer__send--\$\{empty \? 'idle' : 'ready'\}/,
    'the disc no longer changes weight with whether there is something to send',
  )
  assert.match(COMPOSER, /iris-composer__send--stop/, 'the disc has no Stop state')
  // And the three are exclusive by construction: one `className` expression for
  // the send half, a separate element for Stop, so no render can carry two.
  assert.equal(
    (COMPOSER.match(/iris-composer__send--/g) ?? []).length,
    2,
    'the send disc’s state classes are written in more than the two places',
  )
})

test('「+」 opens the command list the same way the key does', () => {
  // Not a second code path that shows the same rows: the draft becomes `/`, and
  // the completion menu reads the draft. A reader who chose the row can keep
  // typing to filter, which is the whole difference.
  const opener = /const openCommands = \(\): void => \{([\s\S]*?)\n  \}/.exec(COMPOSER)?.[1]
  assert.ok(opener !== undefined, 'the 「+」 row’s command opener is gone')
  assert.match(opener, /setDraft\('\/'\)/, 'the opener does not put a slash in the field')
  assert.match(opener, /setCommandOpen\(true\)/, 'the opener does not open the completion list')
  assert.match(opener, /field\.current\?\.focus\(\)/, 'the opener leaves focus off the field')
})

// --------------------------------------------------------------- the colours

test('every colour the composer draws comes from a token', () => {
  /*
   * The three themes, held by the one property that makes them work: a rule
   * that names a colour cannot follow a palette. This is what makes 「三套主题
   * 都对」 a check rather than three screenshots — the light, dark and 墨
   * palettes redefine the same custom properties, so a composer that draws only
   * through `var(--iris-…)` is correct in all three by construction, and a
   * single `#fff` is a hole no amount of looking at one theme would find.
   *
   * Scoped to the composer's own rules, because that is what this task
   * rewrote; `tests/contrast.test.ts` holds the palettes themselves to their
   * contrast floors.
   */
  const panels = source(HERE, '..', 'src', 'app', 'panels.css')
  const literal = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|silver|gray|grey)\b/
  let checked = 0
  for (const match of panels.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] as string).replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!selector.includes('iris-composer')) continue
    checked += 1
    const body = (match[2] as string).replace(/\/\*[\s\S]*?\*\//g, '')
    // Values only, never property names: `white-space: nowrap` is not a colour,
    // and a check that read the whole declaration would have said it was.
    for (const declaration of body.split(';')) {
      const value = declaration.slice(declaration.indexOf(':') + 1)
      if (!declaration.includes(':')) continue
      const found = literal.exec(value)
      assert.equal(
        found,
        null,
        `${selector} draws ${String(found?.[0])} instead of a token`,
      )
    }
  }
  // The count as a floor, because a selector match that quietly stopped finding
  // anything would make every assertion above vacuous — the failure mode a loop
  // with a `continue` in it has.
  assert.ok(checked >= 25, `only ${String(checked)} composer rules were examined`)
})

// ------------------------------------------------------------------ the copy

test('every string the bar names exists in both columns', () => {
  // `i18n.test.ts` holds "used → dictionary" for the whole shell; this holds the
  // bar's own keys against **both** columns, which that check does not do.
  const keys: StringKey[] = [
    'composerMore',
    'composerSlash',
    'presetMenuHead',
    'presetMenuOpen',
    'presetLibraryAbsent',
    'presetLibraryEmpty',
    'presetGlobalNote',
    'presetNoneActive',
    'reasoningEffort',
  ]
  for (const key of keys) {
    assert.ok(key in en, `${key} is not in the English column`)
    assert.ok(DICTIONARIES.zh[key].length > 0, `${key} is empty in the Chinese column`)
    assert.match(COMPOSER, new RegExp(`t\\('${key}'`), `${key} is in the dictionary but nothing says it`)
  }
})
