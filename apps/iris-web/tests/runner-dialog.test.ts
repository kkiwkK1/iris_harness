import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCard, type RunnerHost } from '../src/sandbox/runner.ts'
import { parseFromFrame } from '../src/sandbox/protocol.ts'

/**
 * The dialog bridge, shell side.
 *
 * The sandbox never carries `allow-modals`, so a card's `alert` used to be a
 * browser no-op — the failure channel cards actually choose was swallowed, and
 * the 建国控制台's "请在酒馆前端环境中使用本控制台" was a sentence nobody
 * read. The frame shadows the three names with bridges that post here; the
 * shell is required to have a listener, because a host without one would
 * rebuild exactly the silence the bridge exists to end.
 */
function harness(): {
  card: ReturnType<typeof runCard>
  fromFrame: (message: unknown) => void
  dialogs: () => { kind: string, text: string }[]
} {
  const dialogs: { kind: string, text: string }[] = []
  const posted: Record<string, unknown>[] = []
  const contentWindow = {
    postMessage: (message: unknown) => {
      posted.push(message as Record<string, unknown>)
    },
  }
  const element = {
    style: { setProperty: () => undefined, removeProperty: () => undefined },
    dataset: {} as Record<string, string>,
    contentWindow,
    srcdoc: '',
    setAttribute: () => undefined,
    remove: () => undefined,
  }
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
      onDialog: (kind, text) => {
        dialogs.push({ kind, text })
      },
      onCall: async () => undefined,
      onError: () => undefined,
      onBlocked: () => undefined,
    } satisfies RunnerHost,
    document as unknown as Document,
  )

  return {
    card,
    fromFrame: message => {
      for (const fn of handlers.get('message') ?? []) {
        fn({ source: contentWindow, data: message })
      }
    },
    dialogs: () => dialogs,
  }
}

/** The token the runner minted, read off the srcdoc it just built. */
function tokenOf(srcdoc: string): string {
  const found = /name="iris-token" content="([0-9a-f]+)"/.exec(srcdoc)
  assert.ok(found?.[1], 'no token in the srcdoc, so no message can be addressed')
  return found[1]
}

test('a card dialog reaches the shell with its kind and text', () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)

  scope.fromFrame({ iris: token, type: 'dialog', kind: 'alert', text: '发送失败: 400' })
  assert.deepEqual(scope.dialogs(), [{ kind: 'alert', text: '发送失败: 400' }])
})

test('a dialog without a token is inert, like every other frame message', () => {
  const scope = harness()
  scope.fromFrame({ iris: 'not-the-token', type: 'dialog', kind: 'alert', text: 'spoofed' })
  assert.deepEqual(scope.dialogs(), [])
})

test('the frame-side parser bounds the text and refuses unknown kinds', () => {
  const token = 'abc123'
  const parsed = parseFromFrame(token, { iris: token, type: 'dialog', kind: 'alert', text: `x${'y'.repeat(3000)}` })
  assert.ok(parsed !== undefined)
  assert.equal(parsed.type === 'dialog' && parsed.text.length, 2000, 'card-controlled text is bounded')

  assert.equal(
    parseFromFrame(token, { iris: token, type: 'dialog', kind: 'vibrate', text: 'x' }),
    undefined,
    'a kind the shell has no arm for never reaches it',
  )
  assert.equal(
    parseFromFrame(token, { iris: token, type: 'dialog', kind: 'alert', text: 5 }),
    undefined,
  )
})
