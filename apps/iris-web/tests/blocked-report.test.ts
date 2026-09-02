/**
 * A refusal that can be told apart from the next refusal.
 *
 * @module iris-web/tests/blocked-report
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeBlocked } from '../src/sandbox/blocked-report.ts'

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
