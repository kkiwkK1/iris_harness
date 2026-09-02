import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ReadOnlyApiError, UnsupportedApiError } from '../src/sandbox/errors.ts'
import { createVirtualDocument, type VirtualDocumentSource } from '../src/sandbox/virtual-document.ts'

/** A container that records the selectors it was asked for. */
function source(overrides?: Partial<VirtualDocumentSource>): {
  doc: Record<string, unknown>
  selectors: string[]
  container: VirtualDocumentSource['container']
} {
  const selectors: string[] = []
  const container: VirtualDocumentSource['container'] = {
      id: 'card-root',
      querySelector: selector => {
        selectors.push(selector)
        return selector === '.present' ? { found: true } : null
      },
      querySelectorAll: selector => {
        selectors.push(selector)
        return [{ all: true }]
      },
  }
  const base: VirtualDocumentSource = {
    container,
    viewport: () => ({ width: 1280, height: 720 }),
    factory: {
      createElement: tagName => ({ tagName }),
      createTextNode: data => ({ data }),
      createDocumentFragment: () => ({ fragment: true }),
    },
    ...overrides,
  }
  return { doc: createVirtualDocument(base) as Record<string, unknown>, selectors, container: base.container }
}

test('the viewport size is answered truthfully', () => {
  // Ten of the fourteen real `parent.document` sites read exactly this, as a
  // fallback beside `parent.innerWidth` which is already allowed. Refusing it
  // would break ten sites to protect a number the frame can read off its own
  // window.screen.
  const { doc } = source()
  const element = doc['documentElement'] as Record<string, unknown>

  assert.equal(element['clientWidth'], 1280)
  assert.equal(element['clientHeight'], 720)
})

test('the viewport is read live, not captured', () => {
  let width = 800
  const { doc } = source({ viewport: () => ({ width, height: 600 }) })
  const element = doc['documentElement'] as Record<string, unknown>

  assert.equal(element['clientWidth'], 800)
  width = 1024
  // A card that lays itself out on resize has to see the new number.
  assert.equal(element['clientWidth'], 1024)
})

test('body is the card container itself, not the host body', () => {
  // Identity, not a field comparison: the earlier version of this test asserted
  // `doc.body === doc.body`, which is true however the proxy is wired.
  const { doc, container } = source()
  assert.equal(doc['body'], container)
})

test('lookups are scoped to the container', () => {
  const { doc, selectors } = source()
  const query = doc['querySelector'] as (selector: string) => unknown

  assert.deepEqual(query('.present'), { found: true })
  assert.equal(query('.absent'), null)
  assert.deepEqual(selectors, ['.present', '.absent'])
})

test('getElementById finds the container itself', () => {
  // Excluding the root would make the scoping look like a bug: a card that
  // mounts into its container and then looks it up by id should find it.
  const { doc, selectors } = source()
  const get = doc['getElementById'] as (id: string) => unknown

  assert.equal((get('card-root') as { id: string }).id, 'card-root')
  assert.deepEqual(selectors, [], 'the container was searched instead of matched')
})

test('getElementById survives an id that is not a valid CSS identifier', () => {
  // Cards do carry these. An attribute selector plus escaping handles them; a
  // `#id` selector would throw a SyntaxError from the browser instead.
  //
  // The two characters are built by code point rather than written as escapes:
  // in a test about escaping, a literal backslash in the source is one more
  // layer to reason about than the thing under test.
  const BACKSLASH = String.fromCharCode(92)
  const QUOTE = String.fromCharCode(34)
  const { doc, selectors } = source()
  const get = doc['getElementById'] as (id: string) => unknown

  get(`has${QUOTE}quote`)
  get(`has${BACKSLASH}backslash`)

  assert.deepEqual(selectors, [
    `[id=${QUOTE}has${BACKSLASH}${QUOTE}quote${QUOTE}]`,
    `[id=${QUOTE}has${BACKSLASH}${BACKSLASH}backslash${QUOTE}]`,
  ])
})

test('node factories are real, because an unattached node has no authority', () => {
  const { doc } = source()
  const create = doc['createElement'] as (tag: string) => unknown

  assert.deepEqual(create('div'), { tagName: 'div' })
  assert.deepEqual((doc['createDocumentFragment'] as () => unknown)(), { fragment: true })
})

test('an unprovided member throws and names itself', () => {
  // The core of the policy. `undefined` would be indistinguishable from "not
  // found", so a card would take a policy decision for a missing element and
  // fail later somewhere unrelated.
  const { doc } = source()

  assert.throws(() => doc['cookie'], UnsupportedApiError)
  assert.throws(
    () => doc['cookie'],
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedApiError)
      assert.equal(error.member, 'document.cookie')
      assert.match(error.message, /document\.cookie/)
      return true
    },
  )
})

test('reaching past the two measurements names the full path', () => {
  const { doc } = source()
  const element = doc['documentElement'] as Record<string, unknown>

  assert.throws(
    () => element['style'],
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedApiError)
      assert.equal(error.member, 'document.documentElement.style')
      return true
    },
  )
})

test('every write is refused, including to members that exist', () => {
  // `body` is the container the shell owns; letting a card replace it would hand
  // over the one thing the sandbox exists to keep.
  const { doc } = source()

  assert.throws(() => {
    doc['title'] = 'x'
  }, ReadOnlyApiError)
  assert.throws(() => {
    doc['body'] = 'x'
  }, ReadOnlyApiError)
})

test('symbol reads are absent rather than refused', () => {
  // A symbol is never a card asking for a DOM capability — it is the language or
  // a library introspecting. Throwing there produces a failure with no relation
  // to the policy, and would make the object impossible to log.
  const { doc } = source()

  assert.equal((doc as Record<symbol, unknown>)[Symbol.toStringTag], undefined)
  assert.doesNotThrow(() => String(Object.prototype.toString.call(doc)))
})

test('membership probes answer instead of throwing', () => {
  // `'body' in doc` is a question about the policy, not a request for access.
  const { doc } = source()

  assert.equal('body' in doc, true)
  assert.equal('cookie' in doc, false)
  /*
   * The read-only status members are here too, and they are the second half of
   * the surface rather than an extension of the first. A real card
   * (银麒赎世's system panel) opened with `document.readyState` and the
   * refusal killed the whole script — for a **read** that cannot break
   * anything, of a value this frame genuinely knows.
   *
   * `cookie` stays absent: it is a write as much as a read, and its read is a
   * fact about the shell's origin.
   */
  assert.deepEqual(Object.keys(doc).sort(), [
    'URL',
    'body',
    'characterSet',
    'charset',
    'compatMode',
    'createDocumentFragment',
    'createElement',
    'createTextNode',
    'documentElement',
    'documentURI',
    'getElementById',
    'hidden',
    'querySelector',
    'querySelectorAll',
    'readyState',
    'referrer',
    'title',
    'visibilityState',
  ])
})

test('a status read answers rather than killing the script that asked', () => {
  /*
   * **The card this exists for.** 银麒赎世's system panel reads
   * `document.readyState` on its first line, and the virtual document refused
   * — so the whole script died on a read that writes nothing, of a value the
   * frame knows for certain.
   *
   * The refusal policy was right and the *list* had never been sorted by it:
   * every name that was not a lookup or a factory fell through to one refusal,
   * so a benign status read and an unimplemented capability produced the same
   * fatal sentence. The split is now by what a member **does** — reads answer,
   * writes and structural operations keep the old policy.
   */
  const { doc } = source()
  const bag = doc as Record<string, unknown>

  // `'complete'` is not an approximation: a script frame is handed its body by
  // message and an interface frame's markup is already in the document, so the
  // parse is over before any card code runs.
  assert.equal(bag['readyState'], 'complete')
  assert.equal(bag['characterSet'], 'UTF-8')
  assert.equal(bag['compatMode'], 'CSS1Compat')
  // The frame's own URL, deliberately not the shell's: a card deciding which
  // host it is on must not be told it is the shell.
  assert.equal(bag['URL'], 'about:srcdoc')
  assert.equal(bag['referrer'], '')

  // And the members that are still refused are still refused, so the split is a
  // split rather than a general opening.
  assert.throws(() => bag['cookie'], /document\.cookie/)
  assert.throws(() => bag['write'], /document\.write/)
})
