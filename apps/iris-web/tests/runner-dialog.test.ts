import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runCard, type PopupRequest, type RunnerHost } from '../src/sandbox/runner.ts'
import { parseFromFrame, parseToFrame } from '../src/sandbox/protocol.ts'
import { planPopup } from '../src/sandbox/popup.ts'

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
  popups: () => PopupRequest[]
  withdrawn: () => string[]
  posted: () => Record<string, unknown>[]
} {
  const dialogs: { kind: string, text: string }[] = []
  const popups: PopupRequest[] = []
  const withdrawn: string[] = []
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
      bootstrapUrl: 'http://iris.test/sandbox/bootstrap-abc.js',
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
      onPopup: request => {
        popups.push(request)
      },
      onPopupWithdrawn: id => {
        withdrawn.push(id)
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
    popups: () => popups,
    withdrawn: () => withdrawn,
    posted: () => posted,
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

/*
 * The popup bridge — SillyTavern's own `callGenericPopup`, which is a different
 * channel from the three dialogs above and for one reason: it is asynchronous
 * upstream too, so the reader's real answer can be carried back instead of the
 * shell answering "cancel" on the card's behalf.
 */

test('a card popup reaches the shell with its plan, and the answer goes back on its id', () => {
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)
  const plan = planPopup('清理旧变量？', 2, '', {
    okButton: '仅清理',
    cancelButton: '不再提醒',
    customButtons: ['备份并清理'],
  })

  scope.fromFrame({ iris: token, type: 'popup', id: 'p1', plan })
  const raised = scope.popups()
  assert.equal(raised.length, 1, 'the popup did not reach the shell')
  assert.equal(raised[0]?.id, 'p1')
  assert.deepEqual(
    raised[0]?.plan.buttons.map(button => button.text),
    ['备份并清理', '仅清理', '不再提醒'],
    'upstream prepends its custom buttons before the ok button (popup.js:312-315)',
  )

  raised[0]?.answer({ closed: true, result: 2, button: 0 })
  const answer = scope.posted().find(message => message['type'] === 'popup:answer')
  assert.ok(answer !== undefined, 'the answer never left the shell')
  assert.equal(answer['id'], 'p1', 'the answer must be addressed to the popup that asked')
  assert.equal(answer['result'], 2)
  assert.equal(answer['closed'], true)
})

test('a popup without the run token is inert', () => {
  const scope = harness()
  const plan = planPopup('x', 2, '', {})
  scope.fromFrame({ iris: 'not-the-token', type: 'popup', id: 'p1', plan })
  assert.deepEqual(scope.popups(), [])
})

test('a card closing its own popup withdraws it from the shell', () => {
  // Without this arm the shell holds a modal nobody is waiting for — the card's
  // promise resolved frame-side — and for a modal that means the reader is stuck.
  const scope = harness()
  const token = tokenOf(scope.card.element.srcdoc)
  scope.fromFrame({ iris: token, type: 'popup:done', id: 'p7' })
  assert.deepEqual(scope.withdrawn(), ['p7'])
})

test('a plan that is not one is dropped whole rather than repaired', () => {
  const token = 'abc123'
  const bad = (plan: unknown): unknown => parseFromFrame(token, { iris: token, type: 'popup', id: 'p1', plan })

  assert.equal(bad(undefined), undefined, 'a missing plan')
  assert.equal(bad({ kind: 2, content: 'x' }), undefined, 'a plan with no buttons array')
  assert.equal(bad({ kind: 'confirm', content: 'x', buttons: [] }), undefined, 'a kind that is not a number')
  assert.equal(
    bad({ kind: 2, content: 'x', buttons: [{ at: 0, slot: 'nope', label: 'ok' }] }),
    undefined,
    'a slot the shell has no styling arm for',
  )
  assert.equal(
    bad({ kind: 2, content: 'x', buttons: [{ at: 0, slot: 'ok', label: 'shout' }] }),
    undefined,
    'a caption token the dictionary cannot resolve',
  )

  const good = parseFromFrame(token, {
    iris: token,
    type: 'popup',
    id: 'p1',
    plan: { kind: 2, content: `x${'y'.repeat(40_000)}`, buttons: [{ at: 0, slot: 'ok', label: 'yes', result: 1 }] },
  })
  assert.ok(good?.type === 'popup')
  assert.equal(good.plan.content.length, 32_000, 'card-controlled markup is bounded')
  assert.equal(good.plan.buttons.length, 1)
})

test('the answer parser tells CANCELLED apart from a missing result', () => {
  /*
   * `null` is a value here — upstream's `POPUP_RESULT.CANCELLED` — so a parser
   * that treated absent and null alike would send a dismissal down the same
   * branch as a malformed message. MVU's cleanup compares against exactly this
   * value (`legacy_chat.ts:27-33`).
   */
  const token = 'abc123'
  const cancelled = parseToFrame(token, { iris: token, type: 'popup:answer', id: 'p1', closed: true, result: null })
  assert.ok(cancelled?.type === 'popup:answer')
  assert.equal(cancelled.result, null)

  assert.equal(
    parseToFrame(token, { iris: token, type: 'popup:answer', id: 'p1', closed: true }),
    undefined,
    'a result that is neither a number nor null is not an answer',
  )
  assert.equal(
    parseToFrame(token, { iris: token, type: 'popup:answer', id: 'p1', closed: true, result: '1' }),
    undefined,
    'a stringly result would lose every === comparison a card makes',
  )

  const open = parseToFrame(token, {
    iris: token,
    type: 'popup:answer',
    id: 'p1',
    closed: false,
    result: 0,
    button: 3,
  })
  assert.ok(open?.type === 'popup:answer')
  assert.equal(open.closed, false, 'a non-closing custom button press is still an answer')
  assert.equal(open.button, 3)
})
