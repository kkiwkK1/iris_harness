import assert from 'node:assert/strict'
import { test } from 'node:test'

import { StExtPlane, type StExtPlaneHost } from '../src/st-extensions/plane-core.ts'

/** A window stand-in: records postMessage calls and keeps an identity. */
function fakeWindow(): Window {
  const sent: Array<{ message: unknown, target: Window | null }> = []
  const win = {
    sent,
    postMessage(message: unknown, _target: string): void {
      sent.push({ message, target: null })
    },
  } as unknown as Window & { sent: Array<{ message: unknown }> }
  return win
}

interface Harness {
  plane: StExtPlane
  frame: Window & { sent: Array<{ message: unknown }> }
  card: Window
  submitted: Array<{ token: string, revision: number, result: unknown }>
  reports: Array<Record<string, unknown>>
  persisted: Array<unknown>
}

function harness(framePresent = true): Harness {
  const frame = fakeWindow() as Window & { sent: Array<{ message: unknown }> }
  const card = fakeWindow()
  const submitted: Array<{ token: string, revision: number, result: unknown }> = []
  const reports: Array<Record<string, unknown>> = []
  const persisted: Array<unknown> = []
  const host: StExtPlaneHost = {
    frameWindow: () => (framePresent ? (frame as unknown as Window) : null),
    frameToken: () => 'tok-1',
    extensionId: () => 'st-prompt-template',
    submit: input => { submitted.push(input) },
    persistSettings: settings => { persisted.push(settings) },
    report: (kind, detail) => { reports.push({ kind, ...detail }) },
    replyToFrame: (source, message) => { (source as unknown as { lastReply: unknown }).lastReply = message },
    isOwnFrame: source => source === (card as unknown as Window),
  }
  return { plane: new StExtPlane(host), frame, card: card as unknown as Window, submitted, reports, persisted }
}

const HOST_REQUEST = {
  type: 'st-compat.request',
  token: 'round-1',
  extensionId: 'st-prompt-template',
  kind: 'generate',
  revision: 12,
  payload: { kind: 'generate', messages: [{ role: 'system', content: 'x' }] },
}

test('a host request is forwarded into the frame with the frame\'s token and the round\'s revision', () => {
  const h = harness()
  h.plane.onHostRequest(HOST_REQUEST)
  assert.equal(h.frame.sent.length, 1)
  const envelope = h.frame.sent[0]!.message as Record<string, unknown>
  assert.equal(envelope['irisStExt'], 'tok-1')
  assert.equal(envelope['type'], 'bridge')
  assert.equal(envelope['token'], 'round-1')
  assert.equal(envelope['revision'], 12)
})

test('a bridge result submits with the revision recorded at request time', () => {
  const h = harness()
  h.plane.onHostRequest(HOST_REQUEST)
  const resultEvent = {
    source: h.frame,
    data: {
      irisStExt: 'tok-1',
      type: 'bridge-result',
      token: 'round-1',
      result: { kind: 'generate', messages: [{ role: 'system', content: 'expanded' }], chatVariables: {}, globalVariables: {} },
    },
  }
  h.plane.onWindowMessage(resultEvent as unknown as MessageEvent)
  assert.equal(h.submitted.length, 1)
  assert.equal(h.submitted[0]!.revision, 12)
  assert.equal(h.submitted[0]!.token, 'round-1')
})

test('a result for a round this plane never sent is reported, not submitted', () => {
  const h = harness()
  h.plane.onWindowMessage({
    source: h.frame,
    data: { irisStExt: 'tok-1', type: 'bridge-result', token: 'ghost', result: { kind: 'reply', turn: 0, mes: 'x', chatVariables: {} } },
  } as unknown as MessageEvent)
  assert.equal(h.submitted.length, 0)
  assert.equal(h.reports.length, 1)
})

test('a bridge round that failed in the frame is reported and never submitted — the host deadline falls back to raw', () => {
  const h = harness()
  h.plane.onHostRequest(HOST_REQUEST)
  h.plane.onWindowMessage({
    source: h.frame,
    data: { irisStExt: 'tok-1', type: 'bridge-result', token: 'round-1', result: undefined, error: { message: 'boom' } },
  } as unknown as MessageEvent)
  assert.equal(h.submitted.length, 0)
  assert.match(String(h.reports[0]!['message']), /boom/)
})

test('a request with no frame mounted is reported once and dropped', () => {
  const h = harness(false)
  h.plane.onHostRequest(HOST_REQUEST)
  assert.equal(h.frame.sent.length, 0)
  assert.match(String(h.reports[0]!['message']), /before the extension frame was ready/)
})

test('a message from a window other than the frame is ignored', () => {
  const h = harness()
  h.plane.onWindowMessage({
    source: h.card,
    data: { irisStExt: 'tok-1', type: 'bridge-result', token: 'round-1', result: { kind: 'reply', turn: 0, mes: 'x', chatVariables: {} } },
  } as unknown as MessageEvent)
  assert.equal(h.submitted.length, 0)
})

test('settings-persist reaches the host; settings-html reaches the registered projection handler', () => {
  const h = harness()
  const seen: Array<{ html: string, language: string }> = []
  const stop = h.plane.requestSettingsProjection((html, language) => { seen.push({ html, language }) })
  assert.equal((h.frame.sent.at(-1)!.message as Record<string, unknown>)['type'], 'settings-project')
  h.plane.onWindowMessage({
    source: h.frame,
    data: { irisStExt: 'tok-1', type: 'settings-html', html: '<div>panel</div>', language: 'zh-cn' },
  } as unknown as MessageEvent)
  assert.deepEqual(seen, [{ html: '<div>panel</div>', language: 'zh-cn' }])
  h.plane.onWindowMessage({
    source: h.frame,
    data: { irisStExt: 'tok-1', type: 'settings-persist', extensionSettings: { EjsTemplate: {} } },
  } as unknown as MessageEvent)
  assert.deepEqual(h.persisted, [{ EjsTemplate: {} }])
  stop()
})

test('a card frame\'s member call is forwarded to the frame and answered back on the same card window', () => {
  const h = harness()
  h.plane.onWindowMessage({
    source: h.card,
    data: { irisStMemberProxy: 'st-prompt-template', irisStMemberResult: 'st-compat', callId: 'st-prompt-template:1', method: 'evalTemplate', args: ['<%= 1 + 1 %>'] },
  } as unknown as MessageEvent)
  const dispatch = h.frame.sent.at(-1)!.message as Record<string, unknown>
  assert.equal(dispatch['type'], 'member-call')
  assert.equal(dispatch['method'], 'evalTemplate')
  h.plane.onWindowMessage({
    source: h.frame,
    data: { irisStExt: 'tok-1', type: 'member-result', callId: 'st-prompt-template:1', result: '2' },
  } as unknown as MessageEvent)
  assert.deepEqual((h.card as unknown as { lastReply: Record<string, unknown> }).lastReply, {
    irisStMemberResult: 'st-compat',
    callId: 'st-prompt-template:1',
    result: '2',
    error: undefined,
  })
})

test('a member call naming another extension is dropped', () => {
  const h = harness()
  h.plane.onWindowMessage({
    source: h.card,
    data: { irisStMemberProxy: 'some-other-extension', irisStMemberResult: 'st-compat', callId: 'x:1', method: 'evalTemplate', args: [] },
  } as unknown as MessageEvent)
  assert.equal(h.frame.sent.length, 0)
})
