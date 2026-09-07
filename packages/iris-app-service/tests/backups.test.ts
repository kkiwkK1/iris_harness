import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { formatChatFile, parseChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { BackupStore, backupStamp, parseBackupStamp, rotateBackups } from '../src/backups.ts'
import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { backupsDir } from '../src/paths.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The copies the host takes in front of the irreversible.
 *
 * Three properties are the feature, and each is asserted on the disk rather
 * than on a return value: a dangerous operation leaves a pre-change copy
 * behind; a restore writes the copy back **floor for floor** — the one thing a
 * backup is for; and retention deletes the oldest rather than growing without
 * bound. The rotation rule itself is a pure function and is tested without a
 * disk at all, because the rule is the part a bug in here would share with
 * every conversation at once.
 */

/** A small chat file with a card and a title, as this host stores them. */
function chatFile(chatId: string, floors: number, title = 'Aria', characterId?: string): string {
  const messages: SillyTavernMessage[] = Array.from({ length: floors }, (_unused, index) => ({
    name: index % 2 === 0 ? 'Aria' : 'Traveller',
    is_user: index % 2 === 1,
    mes: `floor ${String(index)} of ${chatId}`,
  }))
  return formatChatFile({
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-03 @00h00m00s', chat_metadata: {},
      iris: {
        chatId,
        ...characterId === undefined ? {} : { characterId },
        title,
        updatedAt: 0,
      },
    },
    messages,
  })
}

/** Overwrite a chat's file, the way an out-of-band writer would. */
async function setChatFile(dir: string, chatId: string, floors: number): Promise<void> {
  await writeFile(join(dir, 'chats', `${chatId}.jsonl`), chatFile(chatId, floors, 'Aria', 'aria'), 'utf8')
}

interface Fixture {
  handlers: ReturnType<InstanceType<typeof IrisAppService>['handlers']>
  chats: ChatStore
  backups: BackupStore
  events: IrisEvent[]
  dir: string
}

async function fixture(t: TestContext, options?: { keep?: number, withBackups?: boolean }): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-backups-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'chats'), { recursive: true })
  await setChatFile(dir, 'long', 6)

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const backups = new BackupStore(join(dir, 'chats'), { keep: options?.keep ?? 50 })
  const events: IrisEvent[] = []
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { events.push(event) },
    userName: 'Traveller',
    diagnostics: new DiagnosticBuffer(),
    // Absent on purpose when `withBackups` is false: that is the test host
    // shape, and the arms have to refuse it by name rather than pretend.
    ...(options?.withBackups === false ? {} : { backups }),
  }).handlers()

  return { handlers, chats, backups, events, dir }
}

test('rotateBackups keeps the newest and names the rest, oldest first', () => {
  const names = ['d.jsonl', 'a.jsonl', 'c.jsonl', 'b.jsonl']
  assert.deepEqual(rotateBackups(names, 2), ['a.jsonl', 'b.jsonl'])
  assert.deepEqual(rotateBackups(names, 4), [], 'keeping more than there are deletes nothing')
  assert.deepEqual(rotateBackups([], 3), [])
})

test('rotateBackups never deletes everything', () => {
  // A retention of zero would turn every protected write into the loss it was
  // meant to prevent, so the floor is one.
  assert.deepEqual(rotateBackups(['only.jsonl'], 0), [])
  assert.deepEqual(rotateBackups(['a.jsonl', 'b.jsonl'], 0), ['a.jsonl'])
  assert.deepEqual(rotateBackups(['a.jsonl', 'b.jsonl'], -5), ['a.jsonl'])
})

test('a snapshot stamp round-trips through UTC', () => {
  const moment = new Date('2026-09-06T08:09:10.123Z')
  const stamp = backupStamp(moment)
  assert.equal(stamp, '20260906-080910-123')
  assert.equal(parseBackupStamp(stamp), moment.getTime())
  assert.equal(parseBackupStamp('20260906'), undefined)
  // Lexicographic order is chronological order — the property rotation leans on.
  assert.ok(backupStamp(new Date(0)) < backupStamp(new Date()))
})

test('a snapshot lands under its character and chat, named with when and why', async (t) => {
  const fixed = await fixture(t)
  const saved = await fixed.backups.snapshot('long', 'delete-message', 'aria')

  assert.equal(saved.chatId, 'long')
  assert.equal(saved.characterId, 'aria')
  assert.equal(saved.reason, 'delete-message')
  assert.equal(saved.messageCount, 6, 'the name did not record the floor count')
  assert.ok(saved.bytes > 0)
  assert.ok(saved.createdAt > 0)

  const segments = saved.backupId.split('/')
  assert.deepEqual(segments.slice(0, 2), ['aria', 'long'], 'the copy did not file under its conversation')
  assert.match(segments[2] ?? '', /-f6-delete-message\.jsonl$/u, 'the name does not say when and why')
  assert.ok(existsSync(join(backupsDir(join(fixed.dir, 'chats')), 'aria', 'long', segments[2] ?? '')))

  // The copy is of the file as it is on disk.
  const original = await readFile(join(fixed.dir, 'chats', 'long.jsonl'), 'utf8')
  const copy = await readFile(fixed.backups.locate(saved.backupId), 'utf8')
  assert.equal(copy, original)
})

test('a chat with no card files under the no-character directory', async (t) => {
  const fixed = await fixture(t)
  await writeFile(join(fixed.dir, 'chats', 'loose.jsonl'), chatFile('loose', 2, 'Loose'), 'utf8')
  await fixed.chats.open('loose')
  await fixed.chats.backup('loose')

  const listed = await fixed.backups.list('loose')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.characterId, undefined)
  assert.equal(listed[0]?.backupId.startsWith('-/loose/'), true, 'a cardless chat has nowhere honest to file')
})

test('list answers newest first and narrows to a chat', async (t) => {
  const fixed = await fixture(t)
  await fixed.backups.snapshot('long', 'delete-message', 'aria')
  await setChatFile(fixed.dir, 'long', 7)
  await fixed.backups.snapshot('long', 'rewrite-messages', 'aria')
  await setChatFile(fixed.dir, 'other', 3)
  await fixed.backups.snapshot('other', 'delete-message', 'aria')

  const all = await fixed.backups.list()
  assert.equal(all.length, 3)
  assert.equal(all[0]?.reason, 'delete-message', 'the newest snapshot was not first')
  assert.ok((all[0]?.createdAt ?? 0) >= (all[1]?.createdAt ?? 0))

  const onlyLong = await fixed.backups.list('long')
  assert.deepEqual(onlyLong.map(row => row.chatId), ['long', 'long'])
})

test('a preview reads its facts off the snapshot bytes', async (t) => {
  const fixed = await fixture(t)
  const saved = await fixed.backups.snapshot('long', 'delete-message', 'aria')
  const { preview } = await fixed.handlers['backup.preview']({ backupId: saved.backupId })

  assert.equal(preview.backup.backupId, saved.backupId)
  assert.equal(preview.title, 'Aria', 'the header title did not come through')
  assert.equal(preview.userName, 'Traveller')
  assert.equal(preview.totalFloors, 6)
  assert.equal(preview.floors.length, 5, 'a preview is a head, not the whole file')
  assert.equal(preview.floors[0]?.messageId, 0)
  assert.equal(preview.floors[0]?.text, 'floor 0 of long')
  assert.equal(preview.floors[1]?.isUser, true)
})

test('a preview clips floor text instead of re-rendering the conversation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-backups-preview-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'chats'), { recursive: true })
  const long = 'x'.repeat(500)
  await writeFile(join(dir, 'chats', 'long.jsonl'), formatChatFile({
    header: {
      user_name: 'T', character_name: 'A', create_date: '', chat_metadata: {},
      iris: { chatId: 'long', title: 'A', updatedAt: 0 },
    },
    messages: [{ name: 'A', is_user: false, mes: long }],
  }), 'utf8')

  const store = new BackupStore(join(dir, 'chats'))
  const saved = await store.snapshot('long', 'rewrite-messages')
  const preview = await store.preview(saved.backupId)

  assert.equal(preview.floors[0]?.text.length, 201, 'the clip is 200 characters plus one ellipsis')
  assert.ok(preview.floors[0]?.text.endsWith('…'))
})

test('a deduped snapshot names the copy that already holds the state', async (t) => {
  const fixed = await fixture(t)
  const first = await fixed.backups.snapshot('long', 'rewrite-messages', 'aria', { dedup: true })
  const second = await fixed.backups.snapshot('long', 'rewrite-messages', 'aria', { dedup: true })

  assert.equal(second.backupId, first.backupId, 'an unchanged conversation got a second copy')
  assert.equal((await fixed.backups.list('long')).length, 1)

  // A changed conversation is a new restore point, dedup or not.
  await setChatFile(fixed.dir, 'long', 7)
  const third = await fixed.backups.snapshot('long', 'rewrite-messages', 'aria', { dedup: true })
  assert.notEqual(third.backupId, first.backupId)
  assert.equal(third.messageCount, 7)
})

test('retention deletes the oldest copies, newest survive', async (t) => {
  const fixed = await fixture(t, { keep: 2 })
  for (const floors of [6, 7, 8, 9]) {
    await setChatFile(fixed.dir, 'long', floors)
    await fixed.backups.snapshot('long', 'delete-message', 'aria')
  }

  const left = await fixed.backups.list('long')
  assert.deepEqual(left.map(row => row.messageCount), [9, 8], 'retention kept something other than the newest two')
})

test('a handle that would leave the store is refused, not resolved', async (t) => {
  const fixed = await fixture(t)
  for (const id of [
    '../../settings.json',
    'aria/long/../../../settings.json',
    'aria/long/not-a-snapshot.txt',
    'aria/long',
    'aria//long/stamp.jsonl',
  ]) {
    assert.throws(() => fixed.backups.locate(id), /is not a snapshot/u, `accepted ${id}`)
  }
  await assert.rejects(
    fixed.backups.remove('aria/long/20990101-000000-000-f6-delete-message.jsonl'),
    (error: unknown) => (error as { code?: string }).code === 'not-found',
  )
})

test('deleting a message leaves a pre-deletion copy behind', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })
  await fixed.handlers['chat.deleteMessage']({ chatId: 'long', id: 5 })

  const listed = await fixed.backups.list('long')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.reason, 'delete-message')
  assert.equal(listed[0]?.messageCount, 6, 'the copy was taken after the deletion')

  // And the live chat really did lose the floor.
  const after = await fixed.chats.open('long')
  assert.equal(after.toFile().messages.length, 5)
})

test('the script batch delete snapshots the floors it is about to remove', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })

  await fixed.handlers['script.deleteChatMessages']({ chatId: 'long', messageIds: [1, 3] })

  const listed = await fixed.backups.list('long')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.reason, 'delete-messages')
  assert.equal(listed[0]?.messageCount, 6, 'the copy was taken after the deletion was decided')

  // The arm itself does not persist; the copy holds what the disk held — all
  // six floors — while the live chat has already dropped two.
  assert.equal((await fixed.chats.open('long')).toFile().messages.length, 4)
  const copy = parseChatFile(await readFile(fixed.backups.locate(listed[0]?.backupId ?? ''), 'utf8'))
  assert.equal(copy.messages.length, 6)
})

test('the script rewrite snapshots pre-rewrite state, once per batch', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })

  // The rollback shape: a replay batch handing floors back older text.
  await fixed.handlers['script.setChatMessages']({
    chatId: 'long',
    messages: [{ messageId: 0, message: 'rewritten' }],
  })
  await fixed.handlers['script.setChatMessages']({
    chatId: 'long',
    messages: [{ messageId: 1, message: 'rewritten too' }],
  })

  const listed = await fixed.backups.list('long')
  assert.equal(listed.length, 1, 'each arm of one batch copied the same unchanged disk again')
  assert.equal(listed[0]?.reason, 'rewrite-messages')
  const copy = await readFile(fixed.backups.locate(listed[0]?.backupId ?? ''), 'utf8')
  assert.equal(copy.includes('rewritten'), false, 'the copy was taken after the rewrite landed on disk')
})

test('a restore refuses anything but the typed name, then writes back floor for floor', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })
  await fixed.handlers['chat.deleteMessage']({ chatId: 'long', id: 5 })
  const listed = await fixed.backups.list('long')
  const backupId = listed[0]?.backupId ?? ''

  // The named confirmation, refused by name on a mismatch — and only on a
  // mismatch: surrounding whitespace from typing is trimmed away.
  await assert.rejects(
    fixed.handlers['backup.restore']({ backupId, confirm: 'aria' }),
    (error: unknown) => (error as { code?: string }).code === 'invalid-request',
  )
  assert.equal((await fixed.chats.open('long')).toFile().messages.length, 5, 'a refused restore still wrote')

  const done = await fixed.handlers['backup.restore']({ backupId, confirm: 'Aria' })
  assert.equal(done.chat.messageCount, 6, 'the restore answered with something other than what came back')
  assert.equal(done.previous?.reason, 'pre-restore', 'the version that was overwritten was not copied aside')

  // **逐楼等价 — floor for floor.** The restored file and the snapshot are the
  // same conversation: every floor's whole stored row, and the header with it.
  // Compared on the raw bytes — `toFile()` is the live projection, which adds
  // the swipe entries an assistant floor carries in memory, and the file is
  // the thing a restore promises to reproduce.
  const snapshotText = await readFile(fixed.backups.locate(backupId), 'utf8')
  const restoredText = await readFile(join(fixed.dir, 'chats', 'long.jsonl'), 'utf8')
  const snapshot = parseChatFile(snapshotText)
  const restored = parseChatFile(restoredText)
  assert.deepEqual(restored.messages, snapshot.messages)
  assert.deepEqual(restored.header, snapshot.header)
  // And through the live entry: the same floors the reader gets back.
  const entry = await fixed.chats.open('long')
  assert.deepEqual(
    entry.toFile().messages.map(row => row.mes),
    snapshot.messages.map(row => row.mes),
  )

  // The version that was overwritten is itself a snapshot, of the post-delete
  // state — a restore that goes wrong is itself restorable.
  const previousText = await readFile(fixed.backups.locate(done.previous?.backupId ?? ''), 'utf8')
  assert.equal(parseChatFile(previousText).messages.length, 5)
})

test('a restore into the hole a deletion left needs no previous-version copy', async (t) => {
  const fixed = await fixture(t)
  const saved = await fixed.backups.snapshot('long', 'delete-message', 'aria')
  await fixed.handlers['chat.delete']({ chatId: 'long' })
  assert.equal(existsSync(join(fixed.dir, 'chats', 'long.jsonl')), false)

  const done = await fixed.handlers['backup.restore']({ backupId: saved.backupId, confirm: 'Aria' })

  assert.equal(done.previous, undefined, 'a restore over nothing copied nothing')
  const entry = await fixed.chats.open('long')
  assert.deepEqual(
    entry.toFile().messages.map(row => row.mes),
    parseChatFile(await readFile(fixed.backups.locate(saved.backupId), 'utf8')).messages.map(row => row.mes),
  )
  // The push reaches an open page, so the conversation comes back without a reopen.
  assert.ok(fixed.events.some(event => event.type === 'chat.updated' && event.chatId === 'long'))
})

test('the legacy cleanup backup lands in the shared store, not a second layout', async (t) => {
  const fixed = await fixture(t)
  await fixed.chats.open('long')
  const path = await fixed.chats.backup('long')

  assert.ok(path.startsWith(backupsDir(join(fixed.dir, 'chats'))), 'the copy landed outside the profile')
  assert.ok(path.includes(join('aria', 'long')), 'the copy did not file under its conversation')
  const listed = await fixed.backups.list('long')
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.reason, 'cleanup')
  assert.equal(path, fixed.backups.locate(listed[0]?.backupId ?? ''))
})

test('a host without a snapshot store refuses the arms and still deletes', async (t) => {
  const fixed = await fixture(t, { withBackups: false })

  await assert.rejects(
    fixed.handlers['backup.list']({}),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
  await assert.rejects(
    fixed.handlers['backup.delete']({ backupId: 'aria/long/20990101-000000-000-f6-delete-message.jsonl' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )

  // The dangerous operation proceeds — a test host without a store is not
  // thereby broken — it just runs unprotected.
  await fixed.handlers['chat.deleteMessage']({ chatId: 'long', id: 0 })
  assert.equal((await fixed.chats.open('long')).toFile().messages.length, 5)
  assert.equal(existsSync(backupsDir(join(fixed.dir, 'chats'))), false, 'an unprotected host wrote a copy anyway')
})

test('the store reads back what it wrote after a fresh construction', async (t) => {
  // No cache in this store to stale: asserted anyway, because the summary's
  // numbers come off file *names* and a parse drift would show only here.
  const fixed = await fixture(t)
  const saved = await fixed.backups.snapshot('long', 'delete-message', 'aria')

  const fresh = new BackupStore(join(fixed.dir, 'chats'), { keep: 50 })
  const again = await fresh.list('long')
  assert.deepEqual(again.map(row => row.backupId), [saved.backupId])
  assert.deepEqual(again.map(row => row.messageCount), [saved.messageCount])

  // The directory layout a user browses by hand.
  const characters = await readdir(backupsDir(join(fixed.dir, 'chats')))
  assert.deepEqual(characters, ['aria'])
})

test('snapshots taken in the same millisecond still order newest first and rotate oldest first', async (t) => {
  // The failure this pins showed only on a fast Linux runner: three snapshots
  // in one millisecond shared a createdAt, so "newest first" was insertion
  // order and the same-millisecond `-2` suffix sorted before the unsuffixed
  // name. The store now stamps monotonically, which this asserts without
  // depending on how fast the clock ticks.
  const fixed = await fixture(t, { keep: 2 })
  const first = await fixed.backups.snapshot('long', 'delete-message', 'aria')
  await setChatFile(fixed.dir, 'long', 7)
  const second = await fixed.backups.snapshot('long', 'rewrite-messages', 'aria')
  await setChatFile(fixed.dir, 'long', 8)
  const third = await fixed.backups.snapshot('long', 'delete-message', 'aria')
  assert.ok(first.createdAt < second.createdAt && second.createdAt < third.createdAt, 'stamps did not increase strictly')
  const listed = await fixed.backups.list('long')
  assert.deepEqual(listed.map(row => row.createdAt), [third.createdAt, second.createdAt], 'keep 2 must leave the two newest, newest first')
})

