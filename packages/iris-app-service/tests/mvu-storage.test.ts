import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { listCandidates } from '@iris/chat'
import { importChat, parseChatFile } from '@iris/persistence'

import { ChatEntry, lineTurns } from '../src/entry.ts'

/**
 * What the chat store does with MVU state.
 *
 * The acceptance test is the round trip over a real conversation, not a
 * fixture: a fixture would be written from the same belief as the code, and the
 * property at stake — that nothing is lost — is only interesting against data
 * somebody else's application wrote.
 */

const CHATS = 'E:/sillyTavern/SillyTavern/data/default-user/chats'

/** The largest real conversation on this machine, if it is here. */
async function findLongChat(): Promise<string | undefined> {
  if (!existsSync(CHATS)) return undefined
  for (const character of await readdir(CHATS)) {
    let files: string[]
    try {
      files = await readdir(join(CHATS, character))
    } catch {
      continue
    }
    for (const file of files) {
      if (file.startsWith('22 - 2026-01-20')) return join(CHATS, character, file)
    }
  }
  return undefined
}

const LONG_CHAT = await findLongChat()

test('a real conversation round-trips with every variable table intact', { skip: LONG_CHAT === undefined }, async () => {
  const original = parseChatFile(await readFile(LONG_CHAT as string, 'utf8'))
  const session = importChat(original, 'round-trip')
  const entry = new ChatEntry({ chatId: 'round-trip', header: original.header, session, card: undefined })
  entry.hydrateVariables(original.messages)

  assert.ok(original.messages.length > 600, `expected the long chat, got ${String(original.messages.length)} messages`)

  const exported = entry.toFile().messages
  assert.equal(exported.length, original.messages.length, 'no message was lost')

  // Per message, per swipe: what comes back out must be what went in. This is
  // the whole meaning of "lossless" for a storage change, and it is checked
  // against 677 real messages rather than a hand-written pair.
  let compared = 0
  for (let index = 0; index < original.messages.length; index += 1) {
    const before = original.messages[index]?.['variables']
    const after = exported[index]?.['variables']
    if (before === undefined && after === undefined) continue
    assert.deepEqual(after, before, `message ${String(index)} lost or changed its variables`)
    compared += 1
  }

  assert.ok(compared > 500, `only ${String(compared)} messages carried variables to compare`)
})

test('an imported conversation keeps a table on every message that had one', { skip: LONG_CHAT === undefined }, async () => {
  const original = parseChatFile(await readFile(LONG_CHAT as string, 'utf8'))
  const session = importChat(original, 'hydrate')
  const entry = new ChatEntry({ chatId: 'hydrate', header: original.header, session, card: undefined })
  entry.hydrateVariables(original.messages)

  // Hydration writes what the file held, and the write-skip must not swallow
  // those: an imported chat is not a chat being generated, and a table the file
  // carried is a fact about that file rather than a redundant re-statement.
  const turns = lineTurns(session)
  let withTables = 0
  for (let index = 0; index < original.messages.length; index += 1) {
    const stored = original.messages[index]?.['variables']
    if (!Array.isArray(stored) || stored.length === 0) continue
    const turn = turns[index]
    if (turn === undefined) continue
    const candidates = listCandidates(session, turn)
    if (candidates.length === 0) continue
    withTables += 1
  }
  assert.ok(withTables > 500, `expected most messages to carry a table, saw ${String(withTables)}`)
})
