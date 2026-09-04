/**
 * Who owns a frame's height.
 *
 * The runner applies a frame's own height report to the element — correct for a
 * message frame, whose height *is* a measurement of its content, and wrong for
 * an overlay frame, whose box the shell already decided. `sizedByHost` splits
 * them, and this file is what makes either branch observable: `runCard` reads
 * its window from the injected document, so a message can be delivered to these
 * handlers without a browser. Before that it could not, which is why a bug that
 * cost the overlay its entire height reached a user's screen.
 *
 * @module iris-web/tests/runner-sizing
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCard, type RunnerHost } from '../src/sandbox/runner.ts'

/** A style bag that records the two operations the handlers use. */
interface Style extends Record<string, unknown> {
  height: string
  removeProperty: (name: string) => void
  setProperty: (name: string, value: string) => void
}

/**
 * A stub document, its window, and the one element the runner builds.
 *
 * The element carries a real `style` object rather than a recording proxy: the
 * question these tests ask is "what height does the element end up with", and a
 * log of calls would answer "what did the runner do", which is the thing that
 * looked right while the frame was 150px tall.
 */
function harness(host?: Partial<RunnerHost>): {
  card: ReturnType<typeof runCard>
  style: Style
  dataset: Record<string, string>
  /** Deliver a frame message, as the frame's own window. */
  fromFrame: (message: unknown) => void
  /** Become visible, or hidden, as the host document. */
  setVisible: (visible: boolean) => void
  /** What the runner posted into the frame, in order. */
  posted: () => Record<string, unknown>[]
  heights: () => number[]
  listeners: () => number
} {
  const style: Style = {
    height: '',
    removeProperty: name => {
      if (name === 'height') style.height = ''
    },
    setProperty: (name, value) => {
      style[name] = value
    },
  }
  const dataset: Record<string, string> = {}
  const posted: Record<string, unknown>[] = []
  const contentWindow = {
    postMessage: (message: unknown) => {
      posted.push(message as Record<string, unknown>)
    },
  }
  const element = {
    style,
    dataset,
    contentWindow,
    srcdoc: '',
    setAttribute: () => undefined,
    remove: () => undefined,
  }

  /*
   * Two registries, because the runner uses two targets and the split is
   * load-bearing: `message` and `resize` are the window's, `visibilitychange`
   * is the document's — it does not fire on a window at all, so a harness that
   * collapsed them would let a listener on the wrong target pass.
   */
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  const docHandlers = new Map<string, ((event: unknown) => void)[]>()
  const view = {
    location: { origin: 'https://iris.test' },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers.set(type, (handlers.get(type) ?? []).filter(it => it !== fn))
    },
  }
  const document = {
    defaultView: view,
    createElement: () => element,
    hidden: false,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      docHandlers.set(type, [...(docHandlers.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      docHandlers.set(type, (docHandlers.get(type) ?? []).filter(it => it !== fn))
    },
  }

  const heights: number[] = []
  const card = runCard(
    {
      bootstrap: ';',
      scripts: [{ id: 'one', code: ';' }],
      mode: 'classic',
      libraries: [],
      documentGranted: false,
      networkGranted: false,
      bundleOrigin: 'https://iris.test',
      context: {} as never,
      viewport: () => ({ width: 800, height: 600 }),
      fetch: async () => '',
      onSettings: () => undefined,
      onSlash: async () => '',
      onCall: async () => undefined,
      onError: () => undefined,
      onBlocked: () => undefined,
      onHeight: pixels => {
        heights.push(pixels)
      },
      ...host,
    },
    document as unknown as Document,
  )

  return {
    card,
    style,
    dataset,
    fromFrame: message => {
      for (const fn of handlers.get('message') ?? []) {
        fn({ source: contentWindow, data: message })
      }
    },
    setVisible: visible => {
      document.hidden = !visible
      for (const fn of docHandlers.get('visibilitychange') ?? []) fn({})
    },
    posted: () => posted,
    heights: () => heights,
    listeners: () =>
      [...handlers.values(), ...docHandlers.values()]
        .reduce((total, list) => total + list.length, 0),
  }
}

/** The token the runner minted, read off the srcdoc it just built. */
function tokenOf(srcdoc: string): string {
  const found = /__iris_token__\s*=\s*["']([^"']+)["']/.exec(srcdoc)
    ?? /["']([0-9a-z]{8,})["']/i.exec(srcdoc)
  assert.ok(found?.[1], 'no token in the srcdoc, so no message can be addressed')
  return found[1]
}

test('a message frame is sized by its own height report', () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'height', pixels: 420 })

  assert.equal(scope.style.height, '420px')
  assert.deepEqual(scope.heights(), [420])
})

test('a message frame that cannot measure itself hands its height to CSS', () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'height', pixels: 420 })
  scope.fromFrame({ iris: token, type: 'sizing', mode: 'viewport' })

  // The inline height goes, so the stylesheet rule the mark selects can decide.
  assert.equal(scope.style.height, '')
  assert.equal(scope.dataset['irisSizing'], 'viewport')
})

test('a host-sized frame keeps the box the host gave it', () => {
  /*
   * **The failure this pins, in the terms it was seen in.** The shell sets
   * `height:100%` on the overlay frame; the card inside sizes itself to the
   * viewport, so the frame reports `sizing`; the runner removed the inline
   * height; nothing re-supplied it, because the rule `sizing` defers to selects
   * message-frame slots. The element became 150px — an iframe's intrinsic
   * height — while the clip already sent had been computed against 1353px, so
   * the card's one button was ~570px away from the hole it could be clicked
   * through. Every number involved looked plausible on its own.
   */
  const scope = harness({ sizedByHost: true })
  const token = tokenOf(scope.card.element.srcdoc)
  scope.style.setProperty('height', '100%')

  scope.fromFrame({ iris: token, type: 'height', pixels: 420 })
  scope.fromFrame({ iris: token, type: 'sizing', mode: 'viewport' })

  assert.equal(scope.style.height, '100%', 'the host lost the height it set')
  assert.equal(scope.dataset['irisSizing'], undefined, 'marked as CSS-sized when it is not')
  // Still reported. The height is no longer the runner's to apply, but "the card
  // wants 420px" is the only trace an overlay host has of what it asked for.
  assert.deepEqual(scope.heights(), [420])
})

test('a tab returning to the foreground is re-told its viewport', () => {
  /*
   * **Why `resize` alone is not enough.** A backgrounded tab is throttled: the
   * window can be resized, or the display changed, while nothing is being
   * rendered — and what the frame is holding then is a viewport that stopped
   * being true at a moment nothing observed. It is also the moment someone is
   * about to look, because they just came back to this tab.
   */
  const scope = harness()
  const before = scope.posted().filter(it => it['type'] === 'viewport').length

  scope.setVisible(false)
  assert.equal(
    scope.posted().filter(it => it['type'] === 'viewport').length,
    before,
    'going hidden spent a message on a frame that cannot act on it',
  )

  scope.setVisible(true)
  const pushed = scope.posted().filter(it => it['type'] === 'viewport')
  assert.equal(pushed.length, before + 1)
  assert.deepEqual(
    { width: pushed.at(-1)?.['width'], height: pushed.at(-1)?.['height'] },
    { width: 800, height: 600 },
    'the push carried something other than the host viewport',
  )
})

test('an explicit resize re-reads the viewport the frame is actually in', () => {
  /*
   * **Why a window `resize` is not enough either.** The overlay frame's box is
   * the surface it was attached to, and the surface is laid out inside the
   * reading column — so a notice appearing or a pane toggling reshapes the
   * frame with no window event at all. The shell watches the surface element
   * and calls `resize()`; the numbers it pushes must be read *at that moment*,
   * which is why the harness's viewport is mutable here: the second push has
   * to carry the box as it is now, not as it was when the frame was built.
   */
  let size = { width: 800, height: 600 }
  const scope = harness({ viewport: () => size })
  const count = () => scope.posted().filter(it => it['type'] === 'viewport').length

  scope.card.resize()
  assert.equal(count(), 1)
  assert.deepEqual(
    { width: scope.posted().at(-1)?.['width'], height: scope.posted().at(-1)?.['height'] },
    { width: 800, height: 600 },
  )

  // The reading column changed shape without any window event.
  size = { width: 1038, height: 612 }
  scope.card.resize()
  assert.equal(count(), 2)
  assert.deepEqual(
    { width: scope.posted().at(-1)?.['width'], height: scope.posted().at(-1)?.['height'] },
    { width: 1038, height: 612 },
    'the push carried the viewport the frame used to have',
  )
})

test('a resize after disposal is silence, not a post into a dead frame', () => {
  /*
   * Every door into the frame is a no-op once disposed, and this one is a
   * late observer callback's to trip over: a `ResizeObserver` disconnect is
   * asynchronous to the teardown it races.
   */
  const scope = harness()
  scope.card.dispose()
  scope.card.resize()
  assert.equal(scope.posted().filter(it => it['type'] === 'viewport').length, 0)
})

test('the listeners live on the injected document, not the global', () => {
  /*
   * The reason the three tests above can exist. `runCard` took a document as a
   * parameter "so this is not implicitly global" and then reached for the
   * ambient `window` anyway — every message and resize handler was unreachable
   * from a test, which is exactly the region the height bug was in.
   */
  const scope = harness()
  assert.equal(scope.listeners(), 3, 'message and resize on the window, visibility on the document')
  scope.card.dispose()
  assert.equal(scope.listeners(), 0, 'disposal left a listener on a dead frame')
})
