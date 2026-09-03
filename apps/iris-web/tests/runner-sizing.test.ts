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
  const contentWindow = { postMessage: () => undefined }
  const element = {
    style,
    dataset,
    contentWindow,
    srcdoc: '',
    setAttribute: () => undefined,
    remove: () => undefined,
  }

  const handlers = new Map<string, ((event: unknown) => void)[]>()
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
    heights: () => heights,
    listeners: () => [...handlers.values()].reduce((total, list) => total + list.length, 0),
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

test('the listeners live on the injected document, not the global', () => {
  /*
   * The reason the three tests above can exist. `runCard` took a document as a
   * parameter "so this is not implicitly global" and then reached for the
   * ambient `window` anyway — every message and resize handler was unreachable
   * from a test, which is exactly the region the height bug was in.
   */
  const scope = harness()
  assert.equal(scope.listeners(), 2, 'message and resize, on the injected window')
  scope.card.dispose()
  assert.equal(scope.listeners(), 0, 'disposal left a listener on a dead frame')
})
