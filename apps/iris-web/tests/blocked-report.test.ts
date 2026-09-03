/**
 * A refusal that can be told apart from the next refusal.
 *
 * @module iris-web/tests/blocked-report
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { blockedMessageFor, describeBlocked } from '../src/sandbox/blocked-report.ts'

const SELF = 'http://127.0.0.1:8787'

test('a foreign origin is named by its host and nothing more', () => {
  const report = describeBlocked(
    { blockedURI: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css' },
    SELF,
  )
  assert.equal(report.host, 'cdnjs.cloudflare.com')
  // No detail: the host already distinguishes this from every other refusal a
  // reader will see beside it, and a path here would only crowd the line.
  assert.equal(report.detail, undefined)
})

test('our own origin carries the path, because the host cannot distinguish anything', () => {
  /*
   * **The bug this exists for.** A srcdoc frame resolves relative URLs against
   * the parent's base URL, so every unqualified request a card makes points at
   * Iris's own origin — and `connect-src` does not list that origin. Reported by
   * host alone, `blocked 127.0.0.1:8787 (connect-src)` is the identical sentence
   * for all of them, and a live one cost a round of "who, fetching what?" that
   * the report could not answer.
   */
  const report = describeBlocked(
    {
      blockedURI: `${SELF}/api/chat/completions?stream=1`,
      sourceFile: `${SELF}/script-bundles/mvu.js`,
      lineNumber: 421,
    },
    SELF,
  )
  assert.equal(report.host, '127.0.0.1:8787')
  assert.equal(report.detail, '/api/chat/completions?stream=1 from mvu.js:421')
})

test('the two cases do not produce the same sentence', () => {
  /*
   * Stated as a property rather than as two literals, because the property is
   * the requirement: the previous implementation satisfied every assertion about
   * *content* while making the two indistinguishable, which is the only thing
   * that mattered.
   */
  const ours = describeBlocked({ blockedURI: `${SELF}/a`, sourceFile: `${SELF}/x.js` }, SELF)
  const theirs = describeBlocked({ blockedURI: `${SELF}/b`, sourceFile: `${SELF}/y.js` }, SELF)
  assert.notEqual(
    `${ours.host}${ours.detail ?? ''}`,
    `${theirs.host}${theirs.detail ?? ''}`,
    'two different requests to our own origin must not report identically',
  )
})

test('a source location is omitted rather than faked when the browser has none', () => {
  // `sourceFile` is empty for a violation the browser cannot attribute, and
  // `:0` reads as line zero of an unnamed file rather than as "unknown".
  for (const sourceFile of ['', null, undefined]) {
    const report = describeBlocked(
      { blockedURI: `${SELF}/thing.json`, ...(sourceFile === undefined ? {} : { sourceFile }) },
      SELF,
    )
    assert.equal(report.detail, '/thing.json', `sourceFile ${JSON.stringify(sourceFile)}`)
  }
})

test('the four unparseable URIs survive unchanged', () => {
  // `inline`, `eval`, `data` and `blob` are not URLs, and each is already the
  // most identifying string available — there is no path to add to them.
  for (const uri of ['inline', 'eval', 'data', 'blob']) {
    assert.deepEqual(describeBlocked({ blockedURI: uri }, SELF), { host: uri })
  }
})

test('the origin compared is the one passed in, not a hardcoded dev port', () => {
  /*
   * The deployed origin is not `127.0.0.1:8787`. A check written against the dev
   * port would go quiet in exactly the deployment where a refusal is hardest to
   * reproduce, so this pins that the comparison is parameterised — a literal
   * inside the function fails here.
   */
  const deployed = 'https://iris.example'
  const report = describeBlocked(
    { blockedURI: `${deployed}/api/x`, sourceFile: `${deployed}/card.js`, lineNumber: 7 },
    deployed,
  )
  assert.equal(report.detail, '/api/x from card.js:7')

  // And the dev origin is foreign when the frame is served from the deployed
  // one, which is the same statement in the other direction.
  assert.equal(describeBlocked({ blockedURI: `${SELF}/api/x` }, deployed).detail, undefined)
})
test('a refused CDN library we already seed is named as covered', () => {
  /*
   * The whole point of the field. FontAwesome's rules are inlined in the frame
   * before any card runs, but a card cannot ask that — it asks whether a
   * stylesheet with `fontawesome` in its href loaded, does not find one, and
   * injects this. The policy refuses it, and the refusal is real but harmless.
   */
  const report = describeBlocked(
    { blockedURI: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css' },
    SELF,
  )
  assert.equal(report.covered, 'FontAwesome')
})

test('the unhyphenated spelling is recognised too', () => {
  // The test above reaches for `font-awesome`; cards use both, and a table that
  // knew one spelling would grade the same harmless refusal two different ways
  // depending on which CDN the card happened to name.
  const hyphen = describeBlocked(
    { blockedURI: 'https://use.fontawesome.com/releases/v6.5.2/css/all.css' },
    SELF,
  )
  assert.equal(hyphen.covered, 'FontAwesome')
})

test('vue-router is not reported as Vue', () => {
  /*
   * Ordering, and it is the one thing about this table that can silently be
   * wrong: `vue-router` contains `vue`, so a table tested only on Vue's own URL
   * passes while every router refusal claims the wrong library — a report that
   * names a library the card was not asking for is worse than an ungraded one.
   */
  const router = describeBlocked(
    { blockedURI: 'https://cdn.jsdelivr.net/npm/vue-router@4.6.4/dist/vue-router.global.js' },
    SELF,
  )
  assert.equal(router.covered, 'vue-router')

  const vue = describeBlocked(
    { blockedURI: 'https://cdn.jsdelivr.net/npm/vue@3.5.42/dist/vue.global.prod.js' },
    SELF,
  )
  assert.equal(vue.covered, 'Vue')
})

test('a library we do not seed is left ungraded, js-yaml included', () => {
  /*
   * **The near-miss is the case worth pinning.** We seed the `yaml` package as
   * `YAML`; a card asking for js-yaml wants `jsyaml`, a different global with a
   * different API. Grading that refusal as covered would tell a reader nothing
   * is missing at the exact moment something is — and over-claiming here is the
   * only direction that fails quietly, since under-claiming just leaves the
   * ordinary red report.
   */
  const yaml = describeBlocked(
    { blockedURI: 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js' },
    SELF,
  )
  assert.equal(yaml.covered, undefined)

  const chart = describeBlocked(
    { blockedURI: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js' },
    SELF,
  )
  assert.equal(chart.covered, undefined)
})

test('our own origin can be covered too, and still carries its path', () => {
  // A srcdoc frame resolves relative URLs against the parent's base, so a card
  // fetching `/lib/jquery.min.js` is refused as us rather than as a CDN.
  const report = describeBlocked(
    { blockedURI: `${SELF}/lib/jquery.min.js`, sourceFile: `${SELF}/card.js`, lineNumber: 9 },
    SELF,
  )
  assert.equal(report.covered, 'jQuery')
  assert.equal(report.detail, '/lib/jquery.min.js from card.js:9')
})

test('an unparseable URI is never graded as covered', () => {
  // `inline`, `eval`, `data`, `blob`: there is no URL to recognise a library in,
  // and guessing from four fixed words would be inventing evidence.
  for (const uri of ['inline', 'eval', 'data', 'blob']) {
    assert.equal(describeBlocked({ blockedURI: uri }, SELF).covered, undefined, uri)
  }
})
test('the message the frame sends carries every field the report decided', () => {
  /*
   * **The test that was missing, and its absence cost the whole feature.**
   *
   * `covered` was added to `describeBlocked`, to the protocol, and to the panel,
   * with a test either side: one proved this module returns it, one proved the
   * panel renders it. The listener that copied fields from the first into the
   * message was never updated, so the field was computed and dropped, both
   * tests stayed green, and no reader ever saw a grade. Two tests facing each
   * other across an untested seam prove less than one test that crosses it.
   *
   * So this asserts the *message*, not the decision — and it is deliberately
   * written as "every optional field survives" rather than as three field
   * checks, because the failure mode is a field being forgotten, and a test
   * that lists fields by hand is the same hand that forgot one.
   */
  const message = blockedMessageFor(
    'tok',
    {
      blockedURI: `${SELF}/lib/jquery.min.js`,
      effectiveDirective: 'connect-src',
      sourceFile: `${SELF}/card.js`,
      lineNumber: 9,
    },
    SELF,
  )
  const decided = describeBlocked(
    { blockedURI: `${SELF}/lib/jquery.min.js`, sourceFile: `${SELF}/card.js`, lineNumber: 9 },
    SELF,
  )
  for (const [key, value] of Object.entries(decided)) {
    assert.equal(
      (message as Record<string, unknown>)[key],
      value,
      `the message dropped ${key}, which the report had decided`,
    )
  }
  assert.equal(message.iris, 'tok')
  assert.equal(message.directive, 'connect-src')
  assert.equal(message.type, 'blocked')
})

test('a directive the browser did not name does not become undefined in the message', () => {
  // The protocol requires a string, and a message that fails to parse is a
  // refusal nobody hears about — the loudest possible way to lose a diagnostic.
  const message = blockedMessageFor('tok', { blockedURI: 'inline' }, SELF)
  assert.equal(typeof message.directive, 'string')
  assert.equal(message.directive, 'unknown')
})

test('the shell origin decides the self-origin branch, and "null" cannot', () => {
  /*
   * What a sandboxed srcdoc frame's `location.origin` actually is. Passing it —
   * which the listener did — makes the self-origin branch unreachable, so every
   * refusal aimed at us reported a bare host with no path: the one string this
   * module exists to stop producing.
   */
  const url = `${SELF}/lib/jquery.min.js`
  const withNull = blockedMessageFor('tok', { blockedURI: url, effectiveDirective: 'connect-src' }, 'null')
  assert.equal(withNull.detail, undefined, 'a bogus origin should not match, and did')

  const withReal = blockedMessageFor('tok', { blockedURI: url, effectiveDirective: 'connect-src' }, SELF)
  assert.equal(withReal.detail, '/lib/jquery.min.js')
})
