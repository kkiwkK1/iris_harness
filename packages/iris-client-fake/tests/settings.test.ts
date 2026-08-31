import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeSettings, DEFAULT_SETTINGS } from '../src/index.ts'
import { testClient } from './helpers.ts'

test('a patch touches only the keys it names', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { temperature: 0.4 })

  assert.equal(next.temperature, 0.4)
  assert.equal(next.model, DEFAULT_SETTINGS.model)
  assert.equal(next.topP, DEFAULT_SETTINGS.topP)
})

test('null clears an optional field, which omission cannot', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { topK: null })
  assert.equal('topK' in next, false)
})

test('a key the protocol does not name is dropped', () => {
  // Silently storing it would let a typo in the panel look like a supported
  // sampling parameter, which is worse than losing the write.
  const next = mergeSettings(DEFAULT_SETTINGS, { tfs: 0.9, temperature: 0.5 })

  assert.equal('tfs' in next, false)
  assert.equal(next.temperature, 0.5)
})

test('a non-finite number is refused rather than stored', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { temperature: Number.NaN })
  assert.equal(next.temperature, DEFAULT_SETTINGS.temperature)
})

test('stop keeps only the strings it was given', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { stop: ['\n\n', 7, '###'] })
  assert.deepEqual(next.stop, ['\n\n', '###'])
})

test('per-chat settings are independent of the global ones', async () => {
  const client = testClient()

  await client.call('settings.set', { chatId: 'chat-survey', settings: { temperature: 0.1 } })

  const chat = await client.call('settings.get', { chatId: 'chat-survey' })
  const global = await client.call('settings.get', {})

  assert.equal(chat.settings.temperature, 0.1)
  assert.notEqual(global.settings.temperature, 0.1)

  client.dispose()
})

test('a malformed request is refused with invalid-request, not a crash', async () => {
  const client = testClient()

  await assert.rejects(
    // The fake validates through the protocol's own schemas, so the UI meets
    // the host's rules here rather than on the wire.
    () => client.call('chat.send', { chatId: 'chat-survey', text: '' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )

  client.dispose()
})

test('a chat that is not there is refused with not-found', async () => {
  const client = testClient()
  await assert.rejects(
    () => client.call('chat.open', { chatId: 'no-such-chat' }),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
  client.dispose()
})

test('unsubscribing inside a handler does not skip the next listener', async () => {
  const client = testClient()
  const seen: string[] = []

  const first = client.subscribe(() => {
    seen.push('first')
    first()
  })
  client.subscribe(() => {
    seen.push('second')
  })

  await client.call('chat.rename', { chatId: 'chat-survey', title: 'Renamed' })

  assert.deepEqual(seen, ['first', 'second'])
  client.dispose()
})

test('connection state is reported and can be flipped for the offline banner', () => {
  const client = testClient()
  assert.equal(client.connected, true)
  client.setConnected(false)
  assert.equal(client.connected, false)
  client.dispose()
})

test('a connection change notifies subscribers, it does not just flip a flag', () => {
  // The flag alone is not enough, and this is the one place to prove it: the
  // interface's only route to the connection state is this channel, so a fake
  // that mutated `connected` silently would let the offline banner pass every
  // test here and never appear against a real transport.
  const client = testClient()
  const seen: boolean[] = []
  const off = client.onConnectionChange(connected => seen.push(connected))

  client.setConnected(false)
  client.setConnected(true)

  assert.deepEqual(seen, [false, true])
  off()
  client.dispose()
})

test('setting the state it already has notifies nobody', () => {
  // Otherwise a transport that polls would repaint the banner on every poll.
  const client = testClient()
  let calls = 0
  const off = client.onConnectionChange(() => {
    calls += 1
  })

  client.setConnected(true)
  assert.equal(calls, 0)

  client.setConnected(false)
  client.setConnected(false)
  assert.equal(calls, 1)

  off()
  client.dispose()
})

test('the connection disposer and dispose both drop the listener', () => {
  const client = testClient()
  let calls = 0
  const off = client.onConnectionChange(() => {
    calls += 1
  })

  off()
  client.setConnected(false)
  assert.equal(calls, 0, 'the disposer did not remove the listener')

  client.onConnectionChange(() => {
    calls += 1
  })
  client.dispose()
  client.setConnected(true)
  assert.equal(calls, 0, 'dispose left a connection listener behind')
})
