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

test('head is the frame document head itself', () => {
  /*
   * The card that asked: 灭仇家满门之后 schedules code that reads
   * `document.head` after mounting, and the refusal killed the whole script
   * for a member this frame genuinely has. Like `body`, it is answered by
   * identity: the head of the card's **own** frame document, handed over as a
   * real element because appending a `<style>` to it styles that document and
   * nothing else.
   */
  const head = { tagName: 'HEAD' }
  const { doc } = source({ head })
  assert.equal(doc['head'], head)
})

test('a style appended to head lands in the frame document', () => {
  /*
   * The measured use is injection: `document.head.append(style)`. The stub
   * records rather than lays out — "the browser applies it" is a property of
   * the real element this member hands over, which is the same guarantee
   * `body`'s real container already makes for markup.
   */
  const inserted: unknown[] = []
  const head = { tagName: 'HEAD', append: (node: unknown) => inserted.push(node) }
  const { doc } = source({ head })

  const create = doc['createElement'] as (tag: string) => unknown
  const style = create('style')
  ;(doc['head'] as { append: (node: unknown) => void }).append(style)

  assert.deepEqual(inserted, [style], 'the injection never reached the head')
})

test('a frame without a head answers undefined and names the gap', () => {
  // Absent is still not silent: a card reading `document.head.appendChild`
  // against a missing member gets `undefined` — upstream's own answer for a
  // name a document does not carry — and a report naming what was missing, so
  // the failure a line later still traces back to a policy decision rather
  // than to nothing.
  const notes: string[] = []
  const { doc } = source({ report: (message, failed) => {
    if (!failed) notes.push(message)
  } })

  assert.equal('head' in doc, false)
  assert.equal(doc['head'], undefined)
  assert.match(notes.join(' '), /document\.head/)
})

test('adding head widens nothing else', () => {
  // The answer surface is the policy; a member added to the answer side must
  // not quietly move any other provided name onto the data side, and assigning
  // `head` itself stays a refusal like every other write to a provided member.
  const head = { tagName: 'HEAD' }
  const { doc } = source({ head })

  assert.equal(doc['cookie'], undefined, 'an unprovided read yields, per the data-slot policy')
  assert.equal(doc['write'], undefined)
  assert.throws(() => {
    doc['head'] = { tagName: 'HEAD' }
  }, ReadOnlyApiError)
})

test('the event-target members delegate to the frame document', () => {
  /*
   * The card that asked: 人贩子物语's 黑市手机 walks `window.parent` outwards
   * until a document reads, holds the result as `hostDocument`, and its next
   * statement is `hostDocument.addEventListener('click', …, true)` — page-level
   * delegation whose handler reads `event.target` and walks the node. The
   * virtual document used to answer that read with `undefined`, and the walk's
   * success made the failure a TypeError one line later instead of a named
   * refusal.
   *
   * The delegation is asserted with the language's own EventTarget rather than
   * a recording stub, because the contract is not "the call was forwarded" but
   * "a listener registered here hears a DOM event dispatched on the target" —
   * the property a card's capture-phase delegation rests on.
   */
  const target = new EventTarget()
  const { doc } = source({ eventTarget: target })

  const heard: Event[] = []
  const listener = (event: Event): void => { heard.push(event) }
  ;(doc['addEventListener'] as EventTarget['addEventListener']).call(doc, 'click', listener)
  ;(doc['dispatchEvent'] as (event: Event) => boolean).call(doc, new Event('click'))
  assert.equal(heard.length, 1, 'a listener registered on the document stand-in never heard the event')
  assert.equal(heard[0]?.type, 'click')

  ;(doc['removeEventListener'] as EventTarget['removeEventListener']).call(doc, 'click', listener)
  ;(doc['dispatchEvent'] as (event: Event) => boolean).call(doc, new Event('click'))
  assert.equal(heard.length, 1, 'a removed listener kept hearing events')
})

test('a document without an event target refuses the members by name', () => {
  // The `head` policy: absent is still not silent. The names follow the
  // unprovided-name policy — `undefined` plus one report — rather than
  // half-working stubs that swallow registrations.
  const notes: string[] = []
  const { doc } = source({ report: (message, failed) => {
    if (!failed) notes.push(message)
  } })

  assert.equal(doc['addEventListener'], undefined)
  assert.equal(doc['removeEventListener'], undefined)
  assert.equal(doc['dispatchEvent'], undefined)
  assert.match(notes.join(' '), /document\.addEventListener/)
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

test('an unprovided member answers undefined, names itself once, and stores data', () => {
  /*
   * The core of the data-slot policy. `undefined` is upstream's own answer for
   * a name a document does not carry, and the report keeps the naming the old
   * throw provided — once per name, because a library polling a private slot
   * must not turn one gap into a stream.
   *
   * The write half is what makes the read half honest: a library that reads its
   * expando, finds nothing, and writes the cache onto the document (`jQuery35…`
   * from `$(parent.document)`, measured in the 开场白2.0.1 component) needs
   * that slot to come back — a throw here killed the library three steps from
   * a read it is entitled to make. The bag is the card's own; no capability
   * rides in on it.
   */
  const notes: string[] = []
  const { doc } = source({ report: (message, failed) => {
    if (!failed) notes.push(message)
  } })

  assert.equal(doc['cookie'], undefined)
  assert.equal(doc['cookie'], undefined, 'a second read must not report again')
  assert.equal(notes.filter(note => note.includes('document.cookie')).length, 1)

  const cache = { events: {} }
  doc['jQuery3510279613227334472251'] = cache
  assert.equal(doc['jQuery3510279613227334472251'], cache, 'a stored slot did not read back')
  assert.equal('jQuery3510279613227334472251' in doc, true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(doc, 'jQuery3510279613227334472251')?.value, cache)

  // One line for the read that missed, one for the data that landed — not one
  // per access.
  assert.equal(notes.filter(note => note.includes('jQuery3510279613227334472251')).length, 1)
  assert.ok(notes.join(' ').includes('stored data'))

  // A slot can go away, the way `$.removeData` and teardown expect.
  const deleted = delete (doc as Record<string, unknown>)['jQuery3510279613227334472251']
  assert.equal(deleted, true)
  assert.equal(doc['jQuery3510279613227334472251'], undefined)
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
  // The realm hands over a head and an event target, as a real frame's does, so
  // the enumeration is the surface a card actually sees.
  const { doc } = source({ head: { tagName: 'HEAD' }, eventTarget: new EventTarget() })

  assert.equal('body' in doc, true)
  assert.equal('head' in doc, true)
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
    'addEventListener',
    'body',
    'characterSet',
    'charset',
    'compatMode',
    'createDocumentFragment',
    'createElement',
    'createTextNode',
    'dispatchEvent',
    'documentElement',
    'documentURI',
    'getElementById',
    'getElementsByTagName',
    'head',
    'hidden',
    'nodeType',
    'querySelector',
    'querySelectorAll',
    'readyState',
    'referrer',
    'removeEventListener',
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
  // `9` is DOCUMENT_NODE, and duck-typing with it is how the 开场白2.0.1
  // component (哈人冰恋世界 / 绿茵好莱坞) recognises a document. The refusal
  // graded that pure read as a script failure; a constant answers instead.
  assert.equal(bag['nodeType'], 9)
  // The frame's own URL, deliberately not the shell's: a card deciding which
  // host it is on must not be told it is the shell.
  assert.equal(bag['URL'], 'about:srcdoc')
  assert.equal(bag['referrer'], '')

  // And the writes to provided members are still refused, so the split is a
  // split rather than a general opening; the unprovided names answer per the
  // data-slot policy instead of throwing.
  assert.equal(bag['cookie'], undefined)
  assert.equal(bag['write'], undefined)
  assert.throws(() => {
    bag['title'] = 'x'
  }, ReadOnlyApiError)
})
