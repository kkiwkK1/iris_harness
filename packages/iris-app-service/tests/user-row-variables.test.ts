import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { ChatStore } from '../src/chats.ts'
import { buildCardContext } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'

/**
 * A user row's own variable table survives into the snapshot.
 *
 * Measured on the corpus: **79.7% of user rows carry a complete MVU table** —
 * `stat_data` and `schema` both present, on a par with assistant rows. That is
 * not decoration. MVU's `getMvuData({message_id: 'latest'})` does not use
 * TavernHelper's `is_system` filter; it scans backwards by a **data predicate**
 * (`getLastValidMessageId` → `findLastIndex(isMvuData)`), so a user row holding a
 * table is a legitimate stopping point.
 *
 * The failure that makes this worth pinning is therefore not an empty answer. If
 * the snapshot dropped a user row's table, `findLastIndex` would step *past* it
 * to an earlier assistant row and return **the previous turn's `stat_data`** —
 * complete, well-formed, every field present, and one turn stale. Nothing
 * downstream can tell that from the right answer.
 *
 * `entry.toFile()` skips user rows when writing candidate tables back
 * (`entry.ts:683`), and that skip is a guard against *overwriting*, not a strip:
 * `exportMessages` has already restored the row's own table through
 * `iris/st-meta`. This test exists so that the difference between those two
 * cannot be lost by a later reading of that line.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

/**
 * A chat whose last row is a user row with a table, preceded by an assistant row
 * with a **different** one.
 *
 * The two tables differ in a field that is read by the assertions, deliberately:
 * if they were equal, or differed only where nothing looks, the test would pass
 * against an implementation that returned the wrong row. Two rows that agree are
 * two rows that cannot tell the implementations apart.
 */
async function chatWithBoth(t: TestContext): Promise<ChatStore> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-urv-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'chats'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const rows = [
    { user_name: 'U', character_name: 'Aria', create_date: '2026-09-02 @10h00m00s', chat_metadata: {} },
    { name: 'Aria', is_user: false, mes: 'Hello.' },
    { name: 'U', is_user: true, mes: 'first' },
    {
      name: 'Aria', is_user: false, mes: 'a reply',
      variables: [{ stat_data: { owner: 'ASSISTANT_ROW', turn: 1 } }],
    },
    {
      name: 'U', is_user: true, mes: 'second',
      variables: [{ stat_data: { owner: 'USER_ROW', turn: 2 } }],
    },
  ]
  await writeFile(
    join(dir, 'chats', 'probe.jsonl'),
    rows.map(row => JSON.stringify(row)).join(String.fromCharCode(10)) + String.fromCharCode(10),
    'utf8',
  )

  return new ChatStore(join(dir, 'chats'), new CharacterLibrary(join(dir, 'characters'), '/iris/avatar'))
}

test('the snapshot carries a user row’s own variable table', async (t) => {
  const chats = await chatWithBoth(t)
  const messages = (await chats.open('probe')).toFile().messages

  const last = messages[messages.length - 1]
  assert.equal(last?.is_user, true, 'the fixture no longer ends on a user row')

  const table = (last?.['variables'] as { stat_data?: { owner?: string } }[] | undefined)?.[0]
  // Asserted on the distinguishing field, not on presence. A table that came
  // from the assistant row is also "present", also well-formed, and also has a
  // `stat_data` — it is simply the wrong turn's.
  assert.equal(
    table?.stat_data?.owner,
    'USER_ROW',
    'the user row came back with somebody else’s table, or none',
  )
})

test('the assistant row keeps its own table too — the rows do not share one', async (t) => {
  const chats = await chatWithBoth(t)
  const messages = (await chats.open('probe')).toFile().messages

  // The other half of the same guard. `toFile` writes candidate tables onto
  // assistant rows and skips user rows; a bug that wrote to both would still
  // satisfy the first test, because the user row would hold a table — the
  // assistant's.
  const assistant = messages[2]
  const table = (assistant?.['variables'] as { stat_data?: { owner?: string } }[] | undefined)?.[0]
  assert.equal(assistant?.is_user, false)
  assert.equal(table?.stat_data?.owner, 'ASSISTANT_ROW')
})

test('a backwards data-predicate scan stops at the user row', async (t) => {
  const chats = await chatWithBoth(t)
  const messages = (await chats.open('probe')).toFile().messages

  // MVU's own reader, reproduced: scan backwards for the last row that looks
  // like MVU data, regardless of who wrote it. This is the consumer whose
  // behaviour the two tests above exist to protect, so it is checked directly
  // rather than inferred from them.
  const isMvuData = (row: unknown): boolean => {
    const table = (row as { variables?: unknown[] } | undefined)?.variables?.[0]
    return typeof table === 'object' && table !== null && 'stat_data' in table
  }
  const index = messages.findLastIndex(isMvuData)
  const found = (messages[index]?.['variables'] as { stat_data?: { owner?: string } }[])[0]

  assert.equal(index, messages.length - 1, 'the scan stepped past the user row')
  assert.equal(
    found?.stat_data?.owner,
    'USER_ROW',
    'the scan returned an earlier turn’s state — complete, well-formed, and stale',
  )
})

test('the snapshot shows a table-less user row its turn’s table', async (t) => {
  const chats = await chatWithBoth(t)
  const entry = await chats.open('probe')

  // Row 1 is a user row the fixture gave no table. MVU's restore path asks
  // `_.has(chat[i].variables[swipe_id], 'stat_data')` to decide whether a floor
  // carries state; on a real install 79.7% of user rows answer yes, so a
  // backwards replay stops there. Answering no made the walk continue past it
  // and persist the state from *before* this turn's commands — losing a turn,
  // with nothing raised.
  const snapshot = buildCardContext(entry, { extensionSettings: {}, characters: [] })
  // Found by its text, not by a hardcoded index: the file's first line is the
  // header, so message indices are offset from row numbers by one — which is
  // exactly the arithmetic the first version of these tests got wrong.
  const userRow = snapshot.chat.find(line => line.mes === 'first')
  assert.equal(userRow?.is_user, true)
  const projected = (userRow?.['variables'] as { stat_data?: unknown }[] | undefined)?.[0]
  assert.ok(projected?.stat_data !== undefined, 'the user row still shows no table to a restore walk')
})

test('the projection fills absences and never overwrites a real table', async (t) => {
  const chats = await chatWithBoth(t)
  const snapshot = buildCardContext(
    await chats.open('probe'), { extensionSettings: {}, characters: [] })

  // `second` is the user row the fixture gave its *own* table, restored through
  // `iris/st-meta`. That is the genuine article — an imported chat's real data —
  // and the projection must leave it exactly as it found it.
  const row = snapshot.chat.find(line => line.mes === 'second')
  const owned = (row?.['variables'] as { stat_data?: { owner?: string } }[])[0]
  assert.equal(owned?.stat_data?.owner, 'USER_ROW', 'the projection overwrote an imported table')
})

test('the export path is untouched — a table-less user row stays table-less on disk', async (t) => {
  const chats = await chatWithBoth(t)
  const entry = await chats.open('probe')

  // The line the repair must not cross. Projecting into `toFile` would write
  // tables into the user's own chat file that SillyTavern never put there, and
  // it would break the byte-identical round trip by *adding* data — the kind of
  // damage a reader does not notice because nothing is missing.
  //
  // Asserted after building the snapshot, because the projection maps over
  // `toFile`'s output and a mutating implementation would have modified the
  // very lines the export path returns.
  buildCardContext(entry, { extensionSettings: {}, characters: [] })

  const exported = entry.toFile().messages
  const blank = exported.find(line => line.mes === 'first')
  assert.equal(blank?.is_user, true)
  assert.equal(
    blank?.['variables'],
    undefined,
    'the snapshot projection leaked into the export path',
  )
  // And the row that legitimately has one still does.
  const owned = exported.find(line => line.mes === 'second')
  assert.ok(Array.isArray(owned?.['variables']), 'an imported user-row table went missing')
})
