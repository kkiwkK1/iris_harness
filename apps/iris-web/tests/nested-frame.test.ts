/**
 * The stand-in for a nested iframe, tested against what a card measurably does.
 *
 * Every assertion here traces to a line in a real card (`TEST-CARDS.md` §7.8,
 * the overlay card's `RA` class) rather than to a plausible iframe API, because
 * that card's failure paths are all silent: `sync()` is wrapped in `catch {}`,
 * so a stand-in missing one member produces a panel that mounts, shows nothing,
 * and reports nothing.
 *
 * @module iris-web/tests/nested-frame
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createNestedFrame,
  resetNestedFrameCounter,
  virtualiseNestedFrames,
  type NestedFrameEnv,
  type NestedNode,
  type NestedQueryHost,
} from '../src/sandbox/nested-frame.ts'

/** A node in the fake DOM: enough of an element to be appended and queried. */
interface FakeNode extends NestedNode {
  children: FakeNode[]
  attributes: Record<string, string>
}

/** One element, with the operations this module actually uses. */
function fakeElement(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    textContent: '',
    appendChild: child => {
      node.children.push(child as FakeNode)
      return child
    },
    append: (...kids) => {
      for (const kid of kids) node.children.push(kid as FakeNode)
    },
    setAttribute: (name, value) => {
      node.attributes[name] = value
    },
    addEventListener: () => undefined,
    querySelectorAll: selector => descendants(node).filter(it => matches(it, selector)),
    querySelector: selector => descendants(node).find(it => matches(it, selector)) ?? null,
  }
  return node
}

/** Every node under one, in document order. */
function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap(child => [child, ...descendants(child)])
}

/**
 * The three selector shapes this module and the measured card use.
 *
 * Deliberately not a selector engine: `#id`, a tag name, and
 * `style[data-style-sync]` are what is actually asked for, and a fake that
 * pretended to support more would be claiming coverage it does not have.
 */
function matches(node: FakeNode, selector: string): boolean {
  if (selector.startsWith('#')) return node.id === selector.slice(1)
  const withAttribute = /^([a-z]+)\[([^\]=]+)\]$/.exec(selector)
  if (withAttribute) {
    return node.tagName === withAttribute[1]?.toUpperCase()
      && withAttribute[2] !== undefined
      && withAttribute[2] in node.attributes
  }
  return node.tagName === selector.toUpperCase()
}

/** The env, plus what was reported through it. */
function env(): NestedFrameEnv & {
  notes: string[]
  refusals: { url: string, reason: string }[]
  pending: (() => void)[]
  flush: () => void
} {
  const notes: string[] = []
  const refusals: { url: string, reason: string }[] = []
  const pending: (() => void)[] = []
  return {
    notes,
    refusals,
    pending,
    flush: () => {
      const runs = [...pending]
      pending.length = 0
      for (const run of runs) run()
    },
    createElement: tagName => fakeElement(tagName),
    parseHtml: () => [],
    note: message => {
      notes.push(message)
    },
    refuse: (url, reason) => {
      refusals.push({ url, reason })
    },
    soon: run => {
      pending.push(run)
    },
  }
}

test('contentDocument answers, because null is what a real nested frame gives', () => {
  /*
   * The fact this module exists for, measured with a control: inside a
   * sandboxed srcdoc frame a nested iframe's `contentDocument` is `null` for
   * all four ways of making one, and a control frame with **no CSP at all**
   * answers null the same four ways. It is the opaque origin, not our policy.
   */
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  const doc = (frame.element as Record<string, unknown>)['contentDocument'] as
    Record<string, unknown>
  assert.ok(doc, 'contentDocument was null, which is the state being virtualised')
  assert.ok(doc['head'])
  assert.ok(doc['body'])
  assert.ok(doc['documentElement'])
})

test('the head’s ownerDocument can create elements', () => {
  /*
   * **The path a plausible stand-in misses.** The card keeps
   * `contentDocument.head` as `targetHead` and then creates through
   * `targetHead.ownerDocument` — so answering `contentDocument` while leaving
   * `head.ownerDocument` alone passes every obvious test and still leaves the
   * panel unstyled, because `sync()` throws into its own `catch {}`.
   */
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  const head = frame.document['head'] as NestedNode
  const owner = head.ownerDocument as Record<string, unknown> | undefined
  assert.ok(owner, 'the head had no ownerDocument')
  assert.equal(typeof owner['createElement'], 'function')
  const made = (owner['createElement'] as (t: string) => NestedNode)('style')
  assert.equal(String(made.tagName).toLowerCase(), 'style')
})

test('a style appended to the head is re-pointed and confined', () => {
  /*
   * The card's actual sequence: create through `ownerDocument`, fill
   * `textContent`, `appendChild` to the head. Unintercepted, this CSS lands
   * unconfined — `html,body{…}` on the frame's real document, and the height
   * chain then also fails to reach the stand-in.
   */
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  const head = frame.document['head'] as NestedNode
  const owner = head.ownerDocument as Record<string, unknown>
  const style = (owner['createElement'] as (t: string) => NestedNode)('style')
  style.textContent = 'html,body,#app{height:100%}'
  head.appendChild?.(style)

  const css = String(style.textContent)
  assert.match(css, /@scope \(#iris-nf1-html\)/, 'the CSS was installed unconfined')
  assert.match(css, /#iris-nf1-html/)
  assert.match(css, /#iris-nf1-body/)
  assert.doesNotMatch(css, /(^|[^-\w#.])body\b/, 'a bare body selector survived confinement')
})

test('srcdoc reads back exactly what was written, for the reuse scan', () => {
  /*
   * The overlay card recognises its own frames with
   * `t.srcdoc.includes('viewport-fit=cover')`. Rendering the HTML but not
   * keeping the string fails that scan — and because the card also has a
   * re-entry guard (`window.__forumOverlayMounted`), the second mount then does
   * *nothing* rather than duplicating, which reads as "the overlay broke".
   */
  resetNestedFrameCounter()
  const scope = env()
  const frame = createNestedFrame(scope)
  const written = '<html><head><meta name="viewport" content="viewport-fit=cover"></head></html>'
  ;(frame.element as Record<string, unknown>)['srcdoc'] = written
  assert.equal((frame.element as Record<string, unknown>)['srcdoc'], written)
  assert.ok(String((frame.element as Record<string, unknown>)['srcdoc'])
    .includes('viewport-fit=cover'))
})

test('srcdoc content lands in the head and body stand-ins', () => {
  resetNestedFrameCounter()
  const scope = env()
  const style = fakeElement('style')
  style.textContent = ':root{--bg:#0e1028}'
  const app = fakeElement('div')
  app.id = 'app'
  // One flat list, the way a `<template>` parser really hands it over: the
  // head/body split is decided from tag names inside the module.
  scope.parseHtml = () => [style, app]

  const frame = createNestedFrame(scope)
  ;(frame.element as Record<string, unknown>)['srcdoc'] = '<html>…</html>'

  const head = frame.document['head'] as NestedNode
  const body = frame.document['body'] as NestedNode
  assert.equal(head.querySelectorAll?.('style').length, 1)
  assert.equal(body.querySelector?.('#app'), app)
  // And a style arriving this way is confined too, not only one appended later.
  assert.match(String(style.textContent), /@scope \(#iris-nf1-html\)/)
  assert.doesNotMatch(String(style.textContent), /:root/)
})

test('load is synthesised on a later task, so a handler set afterwards still hears it', () => {
  /*
   * The ordinary order a card writes: assign `srcdoc`, then attach `onload`. A
   * real frame's `load` cannot arrive before the assignment returns, so firing
   * synchronously would mean the handler is attached to an event that has
   * already happened — a card waiting forever, with nothing to report.
   */
  resetNestedFrameCounter()
  const scope = env()
  const frame = createNestedFrame(scope)
  const element = frame.element as Record<string, unknown>

  let fired = 0
  ;(element['srcdoc'] as unknown) = '<html></html>'
  assert.equal(fired, 0, 'load fired synchronously, before a handler could exist')

  ;(element['addEventListener'] as (t: string, h: () => void) => void)('load', () => {
    fired += 1
  })
  let viaProperty = 0
  element['onload'] = () => {
    viaProperty += 1
  }

  scope.flush()
  assert.equal(fired, 1, 'the listener never heard load')
  assert.equal(viaProperty, 1, 'the onload property never fired')
})

test('a src assignment is refused out loud, and does not throw', () => {
  /*
   * `frame-src 'none'` refuses every remote frame and a network grant does not
   * widen it — measured: of four ways to make a nested frame, only a remote
   * `src` produced a violation. So a real nested frame here would reproduce
   * this same refusal one browsing context later, and the value is entirely in
   * saying so: a frame that silently never loads looks like a card bug.
   */
  resetNestedFrameCounter()
  const scope = env()
  const frame = createNestedFrame(scope)
  ;(frame.element as Record<string, unknown>)['src'] = 'https://cdn.example/app.html'

  assert.equal(scope.refusals.length, 1)
  assert.equal(scope.refusals[0]?.url, 'https://cdn.example/app.html')
  assert.match(String(scope.refusals[0]?.reason), /frame-src/)
})

test('tagName reads IFRAME, and the two wrapper levels are both there', () => {
  /*
   * `tagName` is for a card's own `=== 'IFRAME'` check. It does **not** make
   * `querySelectorAll('iframe')` match, which goes by element type — the frame
   * document's query paths handle that separately, and neither substitutes for
   * the other.
   *
   * Two levels because the height chain needs them: `html,body,#app{height:100%}`
   * wants a definite height at every step, and one merged wrapper leaves `#app`
   * measuring against `auto`.
   */
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  assert.equal((frame.element as Record<string, unknown>)['tagName'], 'IFRAME')

  const html = frame.document['documentElement'] as NestedNode
  const body = frame.document['body'] as NestedNode
  assert.equal(html.id, frame.ids.html)
  assert.equal(body.id, frame.ids.body)
  assert.notEqual(html.id, body.id, 'the two levels collapsed into one')
  assert.equal(html.querySelector?.(`#${frame.ids.body}`), body, 'body is not inside html')
})

test('two stand-ins in one document do not share ids', () => {
  // A card can build a second overlay, and two subtrees answering to the same
  // scope root would have each other's CSS applied to them.
  resetNestedFrameCounter()
  const first = createNestedFrame(env())
  const second = createNestedFrame(env())
  assert.notEqual(first.ids.html, second.ids.html)
  assert.notEqual(first.ids.body, second.ids.body)
})

test('the head is not rendered, since a card puts styles in it', () => {
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  const head = frame.document['head'] as NestedNode
  assert.equal(head.style?.['display'], 'none')
})
/** A fake frame document whose query paths can be patched. */
function queryHost(realFrames: FakeNode[]): NestedQueryHost & { made: string[] } {
  const made: string[] = []
  return {
    made,
    createElement: tagName => {
      made.push(String(tagName))
      return fakeElement(String(tagName))
    },
    querySelector: selector =>
      realFrames.find(it => matches(it, selector)) ?? null,
    querySelectorAll: selector => realFrames.filter(it => matches(it, selector)),
    getElementsByTagName: name => realFrames.filter(it => matches(it, name)),
  }
}

test('a card asking for an iframe gets a stand-in, and anything else is real', () => {
  resetNestedFrameCounter()
  const host = queryHost([])
  virtualiseNestedFrames(host, env())

  const frame = host.createElement('iframe') as Record<string, unknown>
  assert.equal(frame['tagName'], 'IFRAME')
  assert.ok(frame['contentDocument'], 'the card got a real iframe, which answers null')

  const div = host.createElement('div') as NestedNode
  assert.equal(div.tagName, 'DIV')
  assert.equal((div as Record<string, unknown>)['contentDocument'], undefined)
})

test('the sandbox’s own frame is still found, with stand-ins after it', () => {
  /*
   * **Appended, never replacing.** The element standing for *this* frame is a
   * real `<iframe>` the sandbox put in the container, and ten measured sites in
   * one card enumerate frames to find it. A patch that answered with only
   * stand-ins would trade one card's overlay for another card's system panel.
   */
  resetNestedFrameCounter()
  const real = fakeElement('iframe')
  const host = queryHost([real])
  virtualiseNestedFrames(host, env())

  const standIn = host.createElement('iframe') as NestedNode
  const container = fakeElement('div')
  container.appendChild?.(standIn)
  standIn['isConnected'] = true

  const found = Array.from(host.querySelectorAll('iframe')) as NestedNode[]
  assert.equal(found.length, 2)
  assert.equal(found[0], real, 'the document’s own answer must come first')
  assert.equal(found[1], standIn)
  assert.equal(Array.from(host.getElementsByTagName('iframe')).length, 2)
})

test('a selector whose last step is not a frame is left alone', () => {
  // `iframe > div` asks for a div. Appending stand-ins there would hand a card
  // frames where it asked for children, and its loop would then treat a frame
  // as one of its own nodes.
  resetNestedFrameCounter()
  const host = queryHost([])
  virtualiseNestedFrames(host, env())
  const standIn = host.createElement('iframe') as NestedNode
  standIn['isConnected'] = true

  assert.equal(Array.from(host.querySelectorAll('iframe > div')).length, 0)
  assert.equal(Array.from(host.querySelectorAll('.panel')).length, 0)
  // But a descendant selector ending in one, and a list containing one, do ask.
  assert.equal(Array.from(host.querySelectorAll('div iframe')).length, 1)
  assert.equal(Array.from(host.querySelectorAll('.a, iframe')).length, 1)
})

test('a stand-in the card removed stops being found', () => {
  /*
   * The overlay card's reuse scan recognises its own frame by `srcdoc` and
   * takes a reuse branch when it finds one. Keeping a detached stand-in in the
   * answers would make it reuse a frame that is gone — and its re-entry guard
   * turns that into "the overlay silently stopped appearing" rather than into
   * an error.
   */
  resetNestedFrameCounter()
  const host = queryHost([])
  virtualiseNestedFrames(host, env())
  const standIn = host.createElement('iframe') as NestedNode
  standIn['isConnected'] = true
  assert.equal(Array.from(host.querySelectorAll('iframe')).length, 1)

  standIn['isConnected'] = false
  assert.equal(Array.from(host.querySelectorAll('iframe')).length, 0)
})

test('querySelector prefers the document’s own answer, then a stand-in', () => {
  resetNestedFrameCounter()
  const real = fakeElement('iframe')
  const withReal = queryHost([real])
  virtualiseNestedFrames(withReal, env())
  const first = withReal.createElement('iframe') as NestedNode
  first['isConnected'] = true
  assert.equal(withReal.querySelector('iframe'), real)

  const empty = queryHost([])
  virtualiseNestedFrames(empty, env())
  const second = empty.createElement('iframe') as NestedNode
  second['isConnected'] = true
  assert.equal(empty.querySelector('iframe'), second)
  assert.equal(empty.querySelector('.nothing'), null)
})
test('the attribute path works, which is the one the real card takes', async () => {
  /*
   * **V1.5.4's actual call chain**, read from the card's own script:
   *
   *   $('<iframe>').attr({ frameborder: '0', srcdoc: '<!DOCTYPE html>…' })
   *
   * Two measurements decide whether this reaches the stand-in at all, both made
   * against jQuery 3.5.1 — the version the frame is served:
   *
   * 1. `$('<iframe>')` (a bare tag) calls `document.createElement('iframe')`,
   *    so the element patch fires. `$('<iframe srcdoc="x">')` — attributes
   *    inside the tag string — calls `createElement('div')` instead and builds
   *    a real iframe through `innerHTML`, which the patch cannot see. The card
   *    is on the working side of that split.
   * 2. `.attr()` calls **`setAttribute`**, and on a plain element that does not
   *    touch the `srcdoc` property: measured, `setAttribute` received
   *    `frameborder` then `srcdoc`, and the property setter was called **zero**
   *    times.
   *
   * So a stand-in defining only the property would take the card's markup into
   * a dead attribute, render nothing, and never fire `load` — an empty panel
   * with no error anywhere. This test drives the attribute, not the property.
   */
  resetNestedFrameCounter()
  const scope = env()
  const app = fakeElement('div')
  app.id = 'app'
  scope.parseHtml = () => [app]

  const frame = createNestedFrame(scope)
  const element = frame.element as Record<string, unknown>
  const setAttribute = element['setAttribute'] as (name: string, value: string) => void

  let loaded = 0
  ;(element['addEventListener'] as (t: string, h: () => void) => void)('load', () => {
    loaded += 1
  })

  // The card's own order and spelling: frameborder first, then srcdoc.
  setAttribute('frameborder', '0')
  setAttribute('srcdoc', '<!DOCTYPE html><html style="height:100%"><body><div id="app"></div></body></html>')

  // Read back through the attribute, which is how `.attr('srcdoc')` reads.
  assert.match(String((element['getAttribute'] as (n: string) => string | null)('srcdoc')), /DOCTYPE/)
  // And through the property, since the reuse scan uses `t.srcdoc`.
  assert.match(String(element['srcdoc']), /DOCTYPE/)
  // The markup landed.
  assert.equal((frame.document['body'] as NestedNode).querySelector?.('#app'), app)

  scope.flush()
  assert.equal(loaded, 1, 'load was never synthesised, so the card waits forever')
})

test('a src attribute is refused the same way the property is', () => {
  // Two paths to one request. On a real iframe the attribute drives the
  // property; on a stand-in they are separate code, so both are wired to the
  // same refusal or one of them silently does nothing.
  resetNestedFrameCounter()
  const scope = env()
  const frame = createNestedFrame(scope)
  const element = frame.element as Record<string, unknown>

  ;(element['setAttribute'] as (n: string, v: string) => void)('src', 'https://cdn.example/a.html')
  element['src'] = 'https://cdn.example/b.html'

  assert.deepEqual(scope.refusals.map(r => r.url), [
    'https://cdn.example/a.html',
    'https://cdn.example/b.html',
  ])
})

test('an ordinary attribute still reaches the element', () => {
  // The interception is for two names. Everything else must pass through, or a
  // card setting `class`, `style` or `data-*` on its frame loses it.
  resetNestedFrameCounter()
  const scope = env()
  const frame = createNestedFrame(scope)
  const element = frame.element as Record<string, unknown>
  ;(element['setAttribute'] as (n: string, v: string) => void)('data-role', 'overlay')
  assert.equal((element['attributes'] as Record<string, string>)['data-role'], 'overlay')
})
test('the html wrapper carries height:100%, standing in for what our parse dropped', () => {
  /*
   * **This assertion exists because a comment cannot go red.**
   *
   * The measured card's srcdoc opens `<html style="height:100%">` — its height
   * chain starts on the `html` element as an inline attribute, not in the
   * stylesheet. Our own `parseHtml` throws that away: parsing with a
   * `<template>` drops `<html>` and all of its attributes, measured on the real
   * srcdoc (which yields exactly `META`, `STYLE`, `DIV#app` and no `HTML`
   * node). So the wrapper's inline height is not decoration and not belt-and-
   * braces — it is the **substitute** for a declaration this module ate.
   *
   * Someone will eventually read it as redundant, because the card's stylesheet
   * also sets `height:100%` on what becomes `:scope`. Deleting it then takes
   * the card's own inline height with it and the panel loses its height with no
   * error anywhere. The failure message below is aimed at that person.
   */
  resetNestedFrameCounter()
  const frame = createNestedFrame(env())
  const html = frame.document['documentElement'] as NestedNode

  assert.equal(
    html.style?.['height'],
    '100%',
    'the html wrapper lost its inline height. The card supplies this as'
      + ' `<html style="height:100%">` inside its srcdoc, and `parseHtml` drops the `<html>`'
      + ' element along with every attribute on it — so nothing else provides it, and the'
      + ' height chain silently resolves against `auto`.',
  )
  // `display:block` belongs to the same substitution: a dropped `<html>` also
  // takes its default block display with it.
  assert.equal(html.style?.['display'], 'block')
})
