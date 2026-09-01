import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import type { ChatEntry } from '../src/entry.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * A card creating and deleting chat messages.
 *
 * Two arms, and the pair carries a trap worth stating before the tests: **there
 * are two index meanings here, both `number[]`, and they disagree.**
 *
 * - `script.deleteChatMessages` resolves every index against **one snapshot** and
 *   removes in a single pass. Upstream's `deleteChatMessages` does this
 *   (`sortedUniq` then `_.pullAt`), and a card calling it means "the messages
 *   currently at 2 and 5".
 * - `chat.deleteMessage`, called repeatedly, resolves each index against a list
 *   **that has already shrunk**. A card ledger replays its removals in sequence
 *   and must keep using it.
 *
 * Both are correct for their own caller. Neither type nor name distinguishes
 * them, so the difference is asserted below rather than left to a comment: the
 * same input produces different survivors, and that is the point.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'M0', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  /** Opens the same file through a fresh store, as a restart would. */
  reopen: () => Promise<ChatEntry>
  chatId: string
  texts: () => Promise<string[]>
  /** The chat's file, so persistence can be checked rather than inferred. */
  file: string
  /** Whether the appended marker has reached the disk yet. */
  onDisk: () => Promise<boolean>
}

/** A chat with `M0` and then `count` exchanges: M0, U0, A0, U1, A1, … */
async function fixture(t: TestContext, count = 3): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-writes-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  let ends = 0
  let reply = 0
  const stream: StreamFn = async function* () {
    const text = `A${String(reply)}`
    reply += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'U',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const chatId = created.view.chatId
  for (let turn = 0; turn < count; turn += 1) {
    await handlers['chat.send']({ chatId, text: `U${String(turn)}` })
    while (ends < turn + 1) await new Promise(resolve => setTimeout(resolve, 1))
  }

  const file = join(dir, 'chats', `${chatId}.jsonl`)
  return {
    handlers, chatId, file, chats,
    // A second store over the same directory, which is what a restart looks like
    // from the log's point of view — no shared cache to hide a difference.
    reopen: async () => new ChatStore(join(dir, 'chats'), library).open(chatId),
    texts: async () => (await handlers['chat.open']({ chatId })).view.messages.map(message => message.text),
    onDisk: async () => {
      try {
        return (await readFile(file, 'utf8')).includes('in memory')
      } catch {
        // No file yet is the strongest form of "not saved".
        return false
      }
    },
  }
}

const message = (name: string, isUser: boolean, mes: string): { name: string, is_user: boolean, mes: string } =>
  ({ name, is_user: isUser, mes })

test('messages are appended at the end by default', async (t) => {
  const fixed = await fixture(t, 1)
  const before = await fixed.texts()

  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [message('Aria', false, 'appended')],
  })
  assert.deepEqual(await fixed.texts(), [...before, 'appended'])
})

test('an insertion point places messages without disturbing the rest', async (t) => {
  const fixed = await fixture(t, 2)
  const before = await fixed.texts()

  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [message('U', true, 'wedged')],
    insertAt: 1,
  })

  const after = await fixed.texts()
  assert.deepEqual(after, [before[0], 'wedged', ...before.slice(1)])
})

test('a negative index counts from the end, as upstream’s clamp allows', async (t) => {
  const fixed = await fixture(t, 1)
  const before = await fixed.texts()

  // Upstream clamps to `[-length, length]` and hands the still-signed value to
  // `splice`, which reads a negative index from the end. Converting it here
  // would be a second interpretation of one number.
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [message('Aria', false, 'penultimate')],
    insertAt: -1,
  })

  const after = await fixed.texts()
  assert.deepEqual(after, [...before.slice(0, -1), 'penultimate', before[before.length - 1]])
})

test('an out-of-range index is clamped rather than refused', async (t) => {
  const fixed = await fixture(t, 1)
  const before = await fixed.texts()

  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId, messages: [message('Aria', false, 'far'), message('Aria', false, 'past')],
    insertAt: 9999,
  })
  assert.deepEqual(await fixed.texts(), [...before, 'far', 'past'])

  const now = await fixed.texts()
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId, messages: [message('Aria', false, 'before all')], insertAt: -9999,
  })
  assert.deepEqual(await fixed.texts(), ['before all', ...now])
})

test('a created message keeps the speaker it was given', async (t) => {
  const fixed = await fixture(t, 1)
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [message('Somebody Else', true, 'mine')],
  })

  // `is_user` decides the branch `importChat` takes, so a message that loses it
  // comes back as an assistant line — readable, storable, and wrong. The arm
  // requires it; this checks the value survives rather than being re-derived.
  const view = (await fixed.handlers['chat.open']({ chatId: fixed.chatId })).view
  const last = view.messages[view.messages.length - 1]
  assert.equal(last?.text, 'mine')
  assert.equal(last?.role, 'user')
})

test('deleting several removes exactly the messages named, in one pass', async (t) => {
  const fixed = await fixture(t, 3)
  const before = await fixed.texts()
  assert.deepEqual(before, ['M0', 'U0', 'A0', 'U1', 'A1', 'U2', 'A2'])

  await fixed.handlers['script.deleteChatMessages']({ chatId: fixed.chatId, messageIds: [2, 5] })

  // The messages that *were* at 2 and 5 — `A0` and `U2`.
  assert.deepEqual(await fixed.texts(), ['M0', 'U0', 'U1', 'A1', 'A2'])
})

test('the same ids applied one at a time delete something else — both are correct', async (t) => {
  const fixed = await fixture(t, 3)
  assert.deepEqual(await fixed.texts(), ['M0', 'U0', 'A0', 'U1', 'A1', 'U2', 'A2'])

  // Sequential removal, which is what a ledger replay does: each index is read
  // against the list as it stands at that moment. Measured, not asserted from
  // reading the code — deleting 2 then 5 removes `A0` and `A2`, because after
  // the first removal the old index 6 sits at 5.
  await fixed.handlers['chat.deleteMessage']({ chatId: fixed.chatId, id: 2 })
  await fixed.handlers['chat.deleteMessage']({ chatId: fixed.chatId, id: 5 })

  assert.deepEqual(await fixed.texts(), ['M0', 'U0', 'U1', 'A1', 'U2'])

  // The two survivors sets differ, which is the whole reason both arms exist.
  // If this assertion ever stops being true, one of the two has silently
  // adopted the other's meaning and every ledger replay is now off by however
  // many messages it removed.
  assert.notDeepEqual(['M0', 'U0', 'U1', 'A1', 'U2'], ['M0', 'U0', 'U1', 'A1', 'A2'])
})

test('duplicate and unsorted ids are handled, and a missing one is refused', async (t) => {
  const fixed = await fixture(t, 3)

  await fixed.handlers['script.deleteChatMessages']({ chatId: fixed.chatId, messageIds: [5, 2, 5] })
  assert.deepEqual(await fixed.texts(), ['M0', 'U0', 'U1', 'A1', 'A2'])

  // Refused whole rather than partially applied: a card asking to delete a
  // message that is not there has miscounted, and removing the others anyway
  // would leave it further from the state it believes in.
  await assert.rejects(
    () => fixed.handlers['script.deleteChatMessages']({ chatId: fixed.chatId, messageIds: [0, 99] }),
    /no message 99/u,
  )
  assert.deepEqual(await fixed.texts(), ['M0', 'U0', 'U1', 'A1', 'A2'])
})

test('neither arm writes the file — the batch decides that', async (t) => {
  const fixed = await fixture(t, 1)
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId, messages: [message('Aria', false, 'in memory')],
  })

  // Read off the disk, not off the view. The first version of this test
  // asserted that `chat.open` showed the new message and called that evidence
  // of not-saving — but `chat.open` is served from the cached entry, so it
  // shows the change either way. It would have passed against an arm that saved
  // on every call, which is the one thing it exists to rule out.
  assert.equal(await fixed.onDisk(), false, 'the arm wrote the file by itself')

  // A card still sees its own write immediately, which is what makes deferring
  // the save invisible to it.
  const view = (await fixed.handlers['chat.open']({ chatId: fixed.chatId })).view
  assert.equal(view.messages[view.messages.length - 1]?.text, 'in memory')

  // A replay batch is heterogeneous, so persistence belongs to the batch rather
  // than to whichever arm happened to run last. `script.saveChat` is the one
  // decision, and it is what a card calls upstream too.
  await fixed.handlers['script.saveChat']({ chatId: fixed.chatId })
  assert.equal(await fixed.onDisk(), true, 'saveChat did not persist the appended message')
})

test('a created message can carry the floor’s variable layer', async (t) => {
  const fixed = await fixture(t, 1)
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [{ ...message('Aria', false, 'with state'), variables: { stat_data: { count: 7 } } }],
  })
  await fixed.handlers['script.saveChat']({ chatId: fixed.chatId })

  // Upstream's `data` becomes `variables[0]`; `variables` is not a modelled key
  // here, so it rides through `iris/st-meta` and must come back on export. A
  // layer that vanished would leave a card's freshly created floor reading empty
  // with nothing to show why.
  // Split on a character code rather than an escape. Written as `'\n'` through
  // a shell heredoc the backslash collapses, leaving a real newline inside the
  // string literal — which at least fails loudly here, unlike the silent
  // variants of the same trap.
  const raw = await readFile(fixed.file, 'utf8')
  const lines = raw.split(String.fromCharCode(10)).filter(line => line.trim().length > 0)
  const last = JSON.parse(lines[lines.length - 1] ?? '{}') as { mes?: string, variables?: unknown[] }
  assert.equal(last.mes, 'with state')
  assert.deepEqual(last.variables, [{ stat_data: { count: 7 } }])
})

test('no script arm commits a batch on its own, and a user edit still does', async (t) => {
  const fixed = await fixture(t, 1)
  const marker = async (needle: string): Promise<boolean> => {
    try {
      return (await readFile(fixed.file, 'utf8')).includes(needle)
    } catch {
      return false
    }
  }

  // The measured failure this pins: `setChatMessages` used to save, and its save
  // wrote the *whole* entry — so an append still queued from earlier in the
  // batch reached the file as a side effect of a later rewrite. A batch that
  // then failed left half of itself on disk while the card was told it failed.
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId, messages: [message('Aria', false, 'QUEUED')],
  })
  await fixed.handlers['script.setChatMessages']({
    chatId: fixed.chatId, messages: [{ messageId: 0, message: 'REWRITTEN' }],
  })
  await fixed.handlers['script.deleteChatMessages']({ chatId: fixed.chatId, messageIds: [1] })

  assert.equal(await marker('QUEUED'), false, 'a rewrite flushed an earlier append')
  assert.equal(await marker('REWRITTEN'), false, 'the script rewrite committed by itself')

  // One commit point, and it commits everything.
  await fixed.handlers['script.saveChat']({ chatId: fixed.chatId })
  assert.equal(await marker('QUEUED'), true)
  assert.equal(await marker('REWRITTEN'), true)

  // The user-facing edit is a complete action rather than part of a batch, so it
  // keeps writing immediately. Deferring it would leave a person's edit only in
  // memory, waiting for a `saveChat` that no card is going to call.
  await fixed.handlers['chat.editMessage']({
    chatId: fixed.chatId, id: 0, text: 'EDITED BY HAND',
  })
  assert.equal(await marker('EDITED BY HAND'), true, 'a user edit stopped persisting')
})

test('a created floor reads the same before and after a reload', async (t) => {
  const fixed = await fixture(t, 1)
  await fixed.handlers['script.createChatMessages']({
    chatId: fixed.chatId,
    messages: [{
      ...message('system', false, 'SYSTEM NOTE'),
      is_system: true,
      variables: { stat_data: { count: 999 } },
    }],
  })

  // The bug this pins was mine, and its shape is the reason it needs a test:
  // `rebuild` carries variables across by **position**, and a newly created line
  // has no earlier position to carry from — so the table reached the file but
  // never the live log. A card appending a floor and reading it straight back
  // got the *inherited* value; after a restart it got its own. One call, two
  // answers, decided by how long the process had been running.
  const live = await fixed.chats.open(fixed.chatId)
  const floor = live.toFile().messages.length - 1
  const liveTable = live.floorVariables(floor)

  await fixed.handlers['script.saveChat']({ chatId: fixed.chatId })
  const reopened = await fixed.reopen()

  assert.deepEqual(liveTable, { stat_data: { count: 999 } })
  assert.deepEqual(
    reopened.floorVariables(floor),
    liveTable,
    'a created floor reads differently once the chat has been reloaded',
  )
})
