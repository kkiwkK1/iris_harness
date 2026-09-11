import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkScriptFetch, extractScripts, runnableScripts, allowedScriptSources } from '../src/index.ts'


/**
 * The fixtures are the three shapes measured in the local corpus, reduced to
 * the fields that carry meaning. Hermetic on purpose — the corpus is the user's
 * own card library and a test that reads it would pass or fail depending on
 * whose machine it ran on.
 */

/** The shape 8 of 19 cards use. */
const OBJECT_SHAPE = {
  spec: 'chara_card_v3',
  data: {
    name: 'Aria',
    extensions: {
      tavern_helper: {
        scripts: [
          { id: 'f0f993f6', name: 'ERA', type: 'script', enabled: true, content: 'var __webpack_modules__ = {}', info: 'notes', button: { visible: true }, data: {} },
          { id: 'second', name: 'Off', type: 'script', enabled: false, content: 'noop()' },
        ],
        variables: { stat: { hp: 10 } },
      },
    },
  },
}

/** The shape 7 of 19 cards use: `Object.entries()` of the above. */
const ENTRIES_SHAPE = {
  data: {
    extensions: {
      tavern_helper: [
        ['scripts', [{ id: 'f0f993f6', name: 'ERA', type: 'script', enabled: false, content: 'var __webpack_modules__ = {}' }]],
        ['variables', { stat: { hp: 10 } }],
      ],
    },
  },
}

/**
 * The shape 3 of 19 cards use — the script nested one level under `value`.
 *
 * Transcribed off a card. The first version of this fixture had `value` as the
 * content string, guessed from a summary of the key names, and the test passed
 * against that guess. In the corpus all three cards using this key also carry
 * the other one, so the guess cost 13 spurious "unreadable" reports rather than
 * 13 scripts — but a card exported with only this key would lose every script
 * it has, without an error.
 */
const LIST_SHAPE = {
  data: {
    extensions: {
      TavernHelper_scripts: [
        {
          type: 'script',
          value: { id: 'acf69655', name: 'ERA 经验值系统', content: "eventOn('era:writeDone', () => {})" },
        },
      ],
    },
  },
}

test('the object shape reads', () => {
  const bundle = extractScripts(OBJECT_SHAPE)

  assert.equal(bundle.scripts.length, 2)
  assert.equal(bundle.scripts[0]?.name, 'ERA')
  assert.deepEqual(bundle.variables, { stat: { hp: 10 } })
  assert.deepEqual(bundle.skipped, [])
})

test('the entries shape reads the same as the object shape', () => {
  // The one that matters: this is `Object.entries()` of the wrapper, and an
  // importer that only knows the object form loses seven of fifteen cards
  // without reporting anything. That is how an earlier count of this corpus
  // came out low.
  const bundle = extractScripts(ENTRIES_SHAPE)

  assert.equal(bundle.scripts.length, 1)
  assert.equal(bundle.scripts[0]?.id, 'f0f993f6')
  assert.deepEqual(bundle.variables, { stat: { hp: 10 } })
})

test('the nested shape unwraps `value` to find the script', () => {
  const bundle = extractScripts(LIST_SHAPE)

  assert.equal(bundle.scripts.length, 1)
  assert.equal(bundle.scripts[0]?.id, 'acf69655')
  assert.equal(bundle.scripts[0]?.name, 'ERA 经验值系统')
  assert.match(bundle.scripts[0]?.content ?? '', /era:writeDone/)
  assert.equal(bundle.scripts[0]?.type, 'script', 'read off the wrapper, where this shape keeps it')
})

test('a `value` holding a plain string is still taken as the body', () => {
  // Both readings have to work: the wrapper is what varies between exporters.
  const bundle = extractScripts({
    data: { extensions: { TavernHelper_scripts: [{ id: 'x', type: 'script', value: 'console.log(1)' }] } },
  })

  assert.equal(bundle.scripts[0]?.content, 'console.log(1)')
})

test("a script the card's author disabled does not run", () => {
  // Present in the corpus. Running it because it is there executes code its own
  // author switched off.
  const bundle = extractScripts(OBJECT_SHAPE)

  assert.equal(bundle.scripts.length, 2, 'both are listed, so a UI can show one as off')
  assert.deepEqual(runnableScripts(bundle).map(script => script.name), ['ERA'])
})

test('a missing `enabled` means on, not off', () => {
  // The field postdates the format. A card written before it expects to run.
  const bundle = extractScripts({ data: { extensions: { tavern_helper: { scripts: [{ id: 'x', content: 'x()' }] } } } })

  assert.equal(bundle.scripts[0]?.enabled, true)
  assert.equal(runnableScripts(bundle).length, 1)
})

test('one unreadable script does not cost the card the others', () => {
  const bundle = extractScripts({
    data: { extensions: { tavern_helper: { scripts: [
      { id: 'good', content: 'ok()' },
      { id: 'bodyless', name: 'Empty' },
      'not an object',
    ] } } },
  })

  assert.deepEqual(bundle.scripts.map(script => script.id), ['good'])
  assert.equal(bundle.skipped.length, 2)
  assert.match(bundle.skipped[0]?.reason ?? '', /no content/)
})

test('the same script under both keys is taken once', () => {
  // A card exported by two versions of the extension carries both.
  const bundle = extractScripts({
    data: { extensions: {
      tavern_helper: { scripts: [{ id: 'dup', name: 'First', content: 'a()' }] },
      TavernHelper_scripts: [{ id: 'dup', name: 'Second', content: 'b()' }],
    } },
  })

  assert.equal(bundle.scripts.length, 1)
  assert.equal(bundle.scripts[0]?.name, 'First')
})

test('a card with no scripts is not an error', () => {
  for (const input of [undefined, null, {}, { data: {} }, { data: { extensions: {} } }, 'nonsense']) {
    const bundle = extractScripts(input)
    assert.deepEqual(bundle.scripts, [], `for ${JSON.stringify(input)}`)
    assert.deepEqual(bundle.skipped, [])
  }
})

test('a bare card object is accepted without rewrapping', () => {
  const bundle = extractScripts({ extensions: { tavern_helper: { scripts: [{ id: 'a', content: 'x()' }] } } })

  assert.equal(bundle.scripts.length, 1)
})

// ── remote sources ──────────────────────────────────────────────────────────

test('every jsdelivr hostname is allowed, not just the obvious one', () => {
  // Measured: 14 of 15 real imports use `testingcf`, one uses `cdn`. A
  // hostname-exact allowance for `cdn.` would fail 14 of 15 real cards.
  for (const host of ['cdn.jsdelivr.net', 'testingcf.jsdelivr.net', 'gcore.jsdelivr.net', 'fastly.jsdelivr.net']) {
    const verdict = checkScriptFetch(`https://${host}/gh/MagicalAstrogy/MagVarUpdate@master/artifact/bundle.js`)
    assert.equal(verdict.allowed, true, host)
  }
})

test('the bare jsdelivr.net apex is refused, because the frame refuses it too', () => {
  /*
   * `https://*.jsdelivr.net` in the frame's `script-src` does not match the
   * apex, and this list said it did until 2026-09-11 — drift in the widening
   * direction, where the host fetches and caches a bundle the browser will
   * never load and the card's failure names neither side. The corpus asks for
   * nothing here: 0 apex references across 1,888 card, interface, preset and
   * world-book bodies, against 43 `testingcf` and 13 `cdn`.
   *
   * `raw.githubusercontent.com` is the control on the next line. It is an
   * *exact* entry, so its bare form is its only form: a fix that deleted the
   * equality branch outright rather than gating it would have turned 27 real
   * corpus references off, and this pair is what makes that go red.
   */
  assert.equal(checkScriptFetch('https://jsdelivr.net/npm/lodash@4/lodash.min.js').allowed, false)
  assert.equal(checkScriptFetch('https://raw.githubusercontent.com/o/r/main/s.js').allowed, true)
})

test('GitHub raw is allowed exactly, without its siblings', () => {
  assert.equal(checkScriptFetch('https://raw.githubusercontent.com/o/r/main/s.js').allowed, true)
  // `githubusercontent.com` as a suffix would also cover hosts serving
  // arbitrary user uploads.
  assert.equal(checkScriptFetch('https://user-images.githubusercontent.com/x.js').allowed, false)
})

test('a lookalike domain is refused', () => {
  // The dot in the suffix check is what stops this.
  for (const host of ['evil-jsdelivr.net', 'jsdelivr.net.attacker.example', 'notjsdelivr.net']) {
    assert.equal(checkScriptFetch(`https://${host}/x.js`).allowed, false, host)
  }
})

test('http is refused rather than upgraded', () => {
  // Rewriting the scheme would hand the script code from a URL it did not name,
  // and on this path that code is about to run.
  const verdict = checkScriptFetch('http://cdn.jsdelivr.net/x.js')

  assert.equal(verdict.allowed, false)
  if (!verdict.allowed) assert.match(verdict.reason, /only https/)
})

test('a refusal names the host so the failure is diagnosable', () => {
  const verdict = checkScriptFetch('https://unpkg.com/thing')

  assert.equal(verdict.allowed, false)
  if (!verdict.allowed) {
    assert.match(verdict.reason, /unpkg\.com/)
    assert.match(verdict.reason, /\*\.jsdelivr\.net/, 'and says what would be allowed')
  }
})

test('garbage is refused without throwing', () => {
  assert.equal(checkScriptFetch('').allowed, false)
  assert.equal(checkScriptFetch('not a url').allowed, false)
  assert.equal(checkScriptFetch('//cdn.jsdelivr.net/x.js').allowed, false)
})

test('the whitelist can be shown to the user', () => {
  assert.deepEqual(allowedScriptSources(), ['*.jsdelivr.net', 'raw.githubusercontent.com'])
})

test('buttons are read from both shapes the corpus stores them in', () => {
  // Upstream's current shape wraps them; `backward.ts` puts a bare `buttons`
  // array on the script itself. Reading only the wrapper is the same mistake
  // this module already records for whole scripts — and measured, the legacy
  // shape sits on 13 entries across 3 cards, all of which also carry the modern
  // one, so nothing is lost *today*. A card exported with only the old key would
  // lose every button in silence.
  const modern = extractScripts({
    data: { extensions: { tavern_helper: { scripts: [{
      id: 'a', name: 'A', type: 'script', enabled: true, content: 'x',
      button: { enabled: true, buttons: [{ name: 'Open', visible: true }, { name: 'Hidden', visible: false }] },
    }] } } },
  }).scripts
  assert.deepEqual(modern[0]?.buttons, [{ name: 'Open', visible: true }, { name: 'Hidden', visible: false }])
  assert.equal(modern[0]?.buttonsEnabled, true)

  const legacy = extractScripts({
    data: { extensions: { TavernHelper_scripts: [{ type: 'script', value: {
      id: 'b', name: 'B', type: 'script', enabled: true, content: 'x',
      buttons: [{ name: 'Legacy', visible: true }],
    } }] } },
  }).scripts
  assert.deepEqual(legacy[0]?.buttons, [{ name: 'Legacy', visible: true }])
})

test('a hidden button stays hidden, and a malformed one does not become visible', () => {
  const scripts = extractScripts({
    data: { extensions: { tavern_helper: { scripts: [{
      id: 'a', name: 'A', type: 'script', enabled: true, content: 'x',
      button: {
        enabled: false,
        buttons: [
          { name: 'Shown', visible: true },
          { name: 'Hidden', visible: false },
          // No `visible` at all. Upstream's schema requires it, and 58 of the
          // corpus's 89 buttons set it false — so defaulting a malformed entry
          // to shown would surface controls an author hid, which is the wrong
          // direction to guess in.
          { name: 'Unspecified' },
          { visible: true },
        ],
      },
    }] } } },
  }).scripts

  assert.deepEqual(scripts[0]?.buttons, [
    { name: 'Shown', visible: true },
    { name: 'Hidden', visible: false },
    { name: 'Unspecified', visible: true },
  ])
  // A button with no name is dropped: position is a button's only identity, and
  // an unnamed one has nothing for a panel to render or a script to match.
  assert.equal(scripts[0]?.buttons?.length, 3)
  // The group switch is the author's, separate from each button's own.
  assert.equal(scripts[0]?.buttonsEnabled, false)
})
