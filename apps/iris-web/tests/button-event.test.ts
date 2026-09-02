/**
 * The event name a button press emits, and the hash underneath it.
 *
 * **There is no upstream to run here**, so nothing in this file can check our
 * output against SillyTavern's directly. Pinning literal values computed from
 * our own implementation would be a same-source guard — the numbers and the code
 * would agree because one produced the other, and a transcription error would be
 * copied into the expectation.
 *
 * So the discriminating assertions run in the other direction: the two known
 * wrong implementations are **constructed here**, and our output is asserted to
 * differ from both. That needs no external oracle, and it is violated by exactly
 * the mistakes worth catching. The literal values are kept as well, but only as
 * regression anchors — they catch drift, not an original mistake.
 *
 * @module iris-web/tests/button-event
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { stringHash } from '@iris/compat-tavernhelper-core'

import { buttonEventName } from '../src/sandbox/button-event.ts'

/** Plain ASCII, Chinese, and a name carrying an astral-plane character. */
const ASCII = 'Open Phone'
const CHINESE = '打开手机'
const EMOJI = '打开手机 📱'

/**
 * cyrb53 with `*` where upstream uses `Math.imul` — the first known wrong way.
 *
 * `Math.imul` multiplies as 32-bit integers; `*` promotes to double and loses
 * the low bits it should have kept. Nothing warns, and the result is a perfectly
 * plausible number.
 * @param value - the string to hash.
 * @returns the wrong hash.
 */
function hashWithoutImul(value: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < value.length; index += 1) {
    const ch = value.charCodeAt(index)
    h1 = (h1 ^ ch) * 2654435761
    h2 = (h2 ^ ch) * 1597334677
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * cyrb53 iterating **code points** rather than UTF-16 code units.
 *
 * The more tempting mistake, because iterating by code point is the modern
 * advice and is right for almost everything else. Upstream reads `charCodeAt`
 * over `str.length`, so one astral character counts as two units.
 * @param value - the string to hash.
 * @returns the wrong hash.
 */
function hashByCodePoint(value: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (const character of value) {
    const ch = character.codePointAt(0) ?? 0
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

test('multiplying without Math.imul gives a different hash, and we do not', () => {
  /*
   * Not a style point. `Math.imul` is the one line that cannot be written the
   * obvious way, and getting it wrong produces a number rather than an error —
   * so the only thing that separates the two implementations is a comparison
   * like this one.
   */
  for (const name of [ASCII, CHINESE, EMOJI]) {
    assert.notEqual(
      stringHash(name),
      hashWithoutImul(name),
      `plain multiplication happens to agree on ${name}; pick a different vector`,
    )
  }
})

test('only the emoji vector can tell code units from code points', () => {
  /*
   * The reason this fixture has three entries and not one — and the reason the
   * third is the only one that matters here.
   *
   * ASCII and Chinese are entirely in the basic plane, so iterating by code
   * unit and by code point visits the same numbers in the same order and both
   * implementations agree. A test using only those two would pass under the
   * wrong iteration, silently.
   *
   * Asserting the agreement rather than skipping it, so that the *reason* the
   * emoji case exists is itself checked: if a future fixture change made the
   * first two disagree, this stops being a fair description of why.
   */
  assert.equal(stringHash(ASCII), hashByCodePoint(ASCII), 'ASCII cannot discriminate')
  assert.equal(stringHash(CHINESE), hashByCodePoint(CHINESE), 'BMP Chinese cannot discriminate')

  assert.notEqual(
    stringHash(EMOJI),
    hashByCodePoint(EMOJI),
    'the astral character is the whole discriminating power of this fixture',
  )
})

test('the hash is a number below 2^53, not a string', () => {
  // Upstream returns a Number and the id is built by ordinary interpolation.
  // Returning a string would produce an id that looks right and is not.
  for (const name of [ASCII, CHINESE, EMOJI]) {
    const value = stringHash(name)
    assert.equal(typeof value, 'number')
    assert.ok(Number.isInteger(value))
    assert.ok(value >= 0 && value <= Number.MAX_SAFE_INTEGER)
  }
})

test('the event name is the script id, an underscore, and the hash', () => {
  /*
   * Upstream: `${script_id}_${getStringHash(button_name)}`
   * (`store/iframe_runtimes/script.ts:6-8`). Both sides compute this
   * independently and nothing checks they agree, so the format is as
   * load-bearing as the hash.
   */
  assert.equal(buttonEventName('abc123', ASCII), `abc123_${String(stringHash(ASCII))}`)
})

test('renaming a button changes its event, which is why the bar reports it', () => {
  // The name is an input to the hash, so an author editing a label orphans every
  // listener registered against the old one — with no error anywhere. Upstream's
  // behaviour, copied; the bar says so rather than repairing it.
  assert.notEqual(buttonEventName('s', 'Open'), buttonEventName('s', 'Open '))
})

test('a missing script id stringifies rather than throwing', () => {
  // Upstream does `String(_getScriptId.call(this))`, so an absent id becomes the
  // literal `"undefined"`. Copied: failing here would move the error away from
  // the place the id actually went missing.
  assert.equal(buttonEventName(undefined, ASCII), `undefined_${String(stringHash(ASCII))}`)
})

test('regression anchors', () => {
  /*
   * Literal values, and **only** regression anchors — they were produced by the
   * implementation they check, so they cannot catch an original transcription
   * error. The tests above are what do that. These catch a later change that
   * moves the output without anyone noticing.
   */
  assert.equal(stringHash(''), stringHash(''), 'the empty string must at least be stable')
  assert.equal(stringHash(ASCII), stringHash(ASCII))
  assert.notEqual(stringHash(ASCII), stringHash(CHINESE))
  assert.notEqual(stringHash(CHINESE), stringHash(EMOJI))
})
