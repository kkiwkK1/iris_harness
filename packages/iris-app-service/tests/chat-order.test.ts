import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { ChatSummary } from '@iris/protocol'

import { applyChatOrder, ChatOrderStore } from '../src/chat-order.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { materialisingChatStore } from './support/materialising-store.ts'

/**
 * The order a reader put their conversations in.
 *
 * **Upstream has no manual chat order.** SillyTavern sorts its list by a picker
 * — name or date, either direction — so there is no file, no key and no
 * behaviour here to be compatible with, and every question this suite asks is
 * about a decision Iris made on its own (host DEVIATIONS §62).
 *
 * The four that matter, and each one is a way the feature could look finished
 * and not be:
 *
 *  1. it survives a restart — the whole point of storing it on the host rather
 *     than in the browser that arranged it;
 *  2. `chat.list` answers *in* it, everywhere, rather than the panel sorting a
 *     newest-first list back into shape on its own;
 *  3. a conversation the arrangement has never heard of is on **top**, which is
 *     where a chat someone just started belongs and is also what makes an empty
 *     arrangement a no-op;
 *  4. an id the profile does not have refuses the whole request, because a
 *     partial write would store an arrangement the reader never made.
 */

/** A profile directory with a card in it, cleaned up after the test. */
async function profileFixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chatorder-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const characters = join(dir, 'characters')
  await mkdir(characters, { recursive: true })
  await writeFile(
    join(characters, 'sable.json'),
    JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      name: 'Sable',
      data: { name: 'Sable', description: 'A lighthouse keeper.', first_mes: 'The lamp is lit.', tags: [] },
    }),
    'utf8',
  )
  return dir
}

/** A service over that profile, with the arrangement store wired unless told not to. */
async function serviceFixture(dir: string, options: { ordered?: boolean } = {}) {
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  await settings.load()
  const chatOrder = new ChatOrderStore(join(dir, 'chat-order.json'))
  const service = new IrisAppService({
    stream: async function* () { throw new Error('no generation in this suite') },
    library,
    chats,
    settings,
    broadcast: () => {},
    ...options.ordered === false ? {} : { chatOrder },
  })
  return { handlers: service.handlers(), chatOrder }
}

/** A summary with only the fields the ordering reads. */
function summary(chatId: string, updatedAt: number): ChatSummary {
  return { chatId, title: chatId, updatedAt, messageCount: 0 }
}

// -------------------------------------------------------------------- store

test('the arrangement survives a restart, and an unused profile never gets the file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chatorder-store-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'chat-order.json')

  const store = new ChatOrderStore(path)
  assert.deepEqual(await store.list(), [], 'a fresh profile has no arrangement')
  assert.equal(existsSync(path), false, 'reading an arrangement created a file for a profile that has none')

  await store.set(['c', 'a', 'b'])
  assert.deepEqual(await store.list(), ['c', 'a', 'b'])

  // A new instance reads the same file, as a restart would. This is the whole
  // reason the order lives on the host and not in the browser that made it.
  const reopened = new ChatOrderStore(path)
  assert.deepEqual(await reopened.list(), ['c', 'a', 'b'])
})

test('a repeated id means one position, and an empty order is the way back', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chatorder-dedupe-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new ChatOrderStore(join(dir, 'chat-order.json'))

  // The panel assembles its request by concatenating roots with their
  // branches, so a duplicate is a caller's slip rather than a second position —
  // and there is exactly one sensible reading of "this id, twice".
  await store.set(['a', 'b', 'a', 'c', 'b'])
  assert.deepEqual(await store.list(), ['a', 'b', 'c'])

  await store.set([])
  assert.deepEqual(await store.list(), [], 'an empty order does not clear the arrangement')
})

test('the store rewrites nothing when the order it is handed is the order it has', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chatorder-idem-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'chat-order.json')
  const store = new ChatOrderStore(path)

  await store.set(['a', 'b'])
  const written = await readFile(path, 'utf8')
  await store.set(['a', 'b'])
  assert.equal(await readFile(path, 'utf8'), written, 'an unchanged order still rewrote the file')
  // The panel sends the whole order on every drop, including a drop that lands
  // a row back where it started, so this is the common case and not a corner.
})

test('forgetting one id closes the gap and leaves the rest in order', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-chatorder-forget-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new ChatOrderStore(join(dir, 'chat-order.json'))
  await store.set(['a', 'b', 'c'])
  await store.forget('b')
  assert.deepEqual(await store.list(), ['a', 'c'])
  await store.forget('nothing-by-that-name')
  assert.deepEqual(await store.list(), ['a', 'c'], 'forgetting an absent id disturbed the order')
})

// ---------------------------------------------------------------- the rule

test('what the arrangement has never heard of goes on top, newest first', () => {
  const rows = [summary('new', 300), summary('a', 200), summary('b', 100)]
  // `rows` arrives newest-first from the chat store, and `new` is not named.
  assert.deepEqual(
    applyChatOrder(rows, ['b', 'a']).map(row => row.chatId),
    ['new', 'b', 'a'],
    'a conversation the arrangement does not name should be on top',
  )
  /*
   * The other way round — arranged rows on top, new ones beneath — was the
   * first shape and it is wrong: the panel writes the *whole* visible order on
   * each drop, so after one drag the arrangement names every row in the
   * profile, and every new conversation would arrive at the bottom of it.
   */
})

test('an empty arrangement changes nothing at all', () => {
  const rows = [summary('a', 300), summary('b', 200)]
  assert.deepEqual(applyChatOrder(rows, []).map(row => row.chatId), ['a', 'b'])
  // Which is what makes a profile that has never dragged a row read exactly as
  // it did before this feature existed.
})

test('the arrangement neither loses a conversation nor invents one', () => {
  const rows = [summary('a', 300), summary('b', 200), summary('c', 100)]
  // An id the arrangement names and the profile no longer has is skipped — a
  // deletion that raced the read, or a restore that has not landed.
  const ordered = applyChatOrder(rows, ['gone', 'c', 'a', 'b'])
  assert.deepEqual(ordered.map(row => row.chatId), ['c', 'a', 'b'])
  assert.equal(ordered.length, rows.length, 'the arrangement changed how many conversations exist')
})

// ------------------------------------------------------------- the method

test('chat.reorder is stored, and chat.list answers in it from then on', async (t) => {
  const dir = await profileFixture(t)
  const { handlers, chatOrder } = await serviceFixture(dir)

  const first = await handlers['chat.create']({ characterId: 'sable' })
  const second = await handlers['chat.create']({ characterId: 'sable' })
  const third = await handlers['chat.create']({ characterId: 'sable' })
  const ids = [first.view.chatId, second.view.chatId, third.view.chatId]

  const before = await handlers['chat.list']({})
  assert.equal(before.ordered, false, 'a profile that has arranged nothing should say so')
  assert.equal(before.chats.length, 3)

  // Reversed, which is a real arrangement whatever the timestamps did: the
  // three chats are created in the same millisecond on a fast machine, so an
  // assertion against the *unarranged* order would be a coin toss.
  const reversed = [...ids].reverse()
  const answered = await handlers['chat.reorder']({ order: reversed })
  assert.deepEqual(answered.chats.map(row => row.chatId), reversed, 'the reply is not in the order it was given')
  assert.equal(answered.ordered, true)
  assert.deepEqual(await chatOrder.list(), reversed, 'the arrangement was not stored')

  const listed = await handlers['chat.list']({})
  assert.deepEqual(listed.chats.map(row => row.chatId), reversed, 'chat.list does not answer in the arrangement')
  assert.equal(listed.ordered, true)

  // And a rename answers through the same reader, so no path hands one caller
  // the arrangement and another newest-first.
  const renamed = await handlers['chat.rename']({ chatId: ids[1] ?? '', title: 'Renamed' })
  assert.deepEqual(renamed.chats.map(row => row.chatId), reversed, 'chat.rename answered outside the arrangement')
})

test('a conversation created after the arrangement is listed on top of it', async (t) => {
  const dir = await profileFixture(t)
  const { handlers } = await serviceFixture(dir)

  const first = await handlers['chat.create']({ characterId: 'sable' })
  const second = await handlers['chat.create']({ characterId: 'sable' })
  await handlers['chat.reorder']({ order: [first.view.chatId, second.view.chatId] })

  const fresh = await handlers['chat.create']({ characterId: 'sable' })
  const listed = await handlers['chat.list']({})
  assert.deepEqual(
    listed.chats.map(row => row.chatId),
    [fresh.view.chatId, first.view.chatId, second.view.chatId],
    'a new conversation was buried under the arrangement instead of starting on top of it',
  )
})

test('an id the profile does not have refuses the whole order, and stores none of it', async (t) => {
  const dir = await profileFixture(t)
  const { handlers, chatOrder } = await serviceFixture(dir)

  const first = await handlers['chat.create']({ characterId: 'sable' })
  const second = await handlers['chat.create']({ characterId: 'sable' })
  await handlers['chat.reorder']({ order: [second.view.chatId, first.view.chatId] })
  const good = await chatOrder.list()

  await assert.rejects(
    handlers['chat.reorder']({ order: [first.view.chatId, 'no-such-chat', second.view.chatId] }),
    (error: Error) => {
      assert.match(error.message, /no-such-chat/, 'the refusal does not name the id it could not find')
      return true
    },
    'an order naming a chat the host does not have was accepted',
  )
  assert.deepEqual(
    await chatOrder.list(),
    good,
    'a refused order still wrote part of itself: the reader now has an arrangement they never made',
  )
})

test('deleting a conversation forgets its place', async (t) => {
  const dir = await profileFixture(t)
  const { handlers, chatOrder } = await serviceFixture(dir)

  const first = await handlers['chat.create']({ characterId: 'sable' })
  const second = await handlers['chat.create']({ characterId: 'sable' })
  await handlers['chat.reorder']({ order: [second.view.chatId, first.view.chatId] })

  await handlers['chat.delete']({ chatId: second.view.chatId })
  assert.deepEqual(
    await chatOrder.list(),
    [first.view.chatId],
    'a deleted conversation kept its seat, which the next chat of that name would inherit',
  )
})

test('a host that keeps no arrangement refuses the method and claims nothing in the list', async (t) => {
  const dir = await profileFixture(t)
  const { handlers } = await serviceFixture(dir, { ordered: false })
  await handlers['chat.create']({ characterId: 'sable' })

  const listed = await handlers['chat.list']({})
  assert.equal(
    'ordered' in listed,
    false,
    'a host with no arrangement store still answered the field: absent and false are different claims',
  )
  await assert.rejects(
    handlers['chat.reorder']({ order: [] }),
    /not configured on this host/,
    'a host with no arrangement store accepted an order it cannot keep',
  )
})
