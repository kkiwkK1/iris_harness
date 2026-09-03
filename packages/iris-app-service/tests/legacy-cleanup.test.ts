import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { formatChatFile, type SillyTavernMessage } from '@iris/persistence'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { backupsDir } from '../src/paths.ts'
import { DEFAULT_PRUNE, IGNORE_CLEANUP_KEY } from '../src/prune.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The one-time offer, and the two answers that are not "clean".
 *
 * Upstream sweeps `[1, len - 1 - keep]` here — the whole history bar the
 * protected tail — and only after asking, with a backup offered first. The
 * sweep itself is the easy half. **These are the two branches where nothing is
 * supposed to be deleted**, and each of them is a place where deleting anyway
 * would look, from the outside, exactly like working.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
  },
})

/** A chat long enough to qualify, with a table on every reply. */
function longChatFile(lines: number): string {
  const messages: SillyTavernMessage[] = Array.from({ length: lines }, (_unused, index) => index % 2 === 1
    ? { name: 'Traveller', is_user: true, mes: `line ${String(index)}` }
    : {
        name: 'Aria', is_user: false, mes: `line ${String(index)}`,
        swipes: [`line ${String(index)}`], swipe_id: 0,
        variables: [{ stat_data: { n: index }, schema: {}, event_chain: ['x'] }],
      })
  return formatChatFile({
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-03 @00h00m00s', chat_metadata: {},
      iris: { chatId: 'long', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    messages,
  })
}

interface Fixture {
  handlers: ReturnType<InstanceType<typeof IrisAppService>['handlers']>
  chats: ChatStore
  events: IrisEvent[]
  dir: string
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-legacy-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'chats'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'chats', 'long.jsonl'), longChatFile(673), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
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
    pruneVariables: DEFAULT_PRUNE,
  }).handlers()

  return { handlers, chats, events, dir }
}

/** How many replies still hold a full MVU table. */
async function intactLayers(chats: ChatStore): Promise<number> {
  const entry = await chats.open('long')
  let intact = 0
  for (const [index, message] of entry.toFile().messages.entries()) {
    if (index % 2 === 1) continue
    const table = Array.isArray(message['variables']) ? message['variables'][0] : undefined
    if (table !== undefined && 'stat_data' in (table as Record<string, unknown>)) intact += 1
  }
  return intact
}

test('answering "never" records the refusal and sweeps nothing', async (t) => {
  const fixed = await fixture(t)
  const before = await intactLayers(fixed.chats)
  assert.ok(before > 300, `the fixture starts with ${String(before)} intact layers`)

  const done = await fixed.handlers['chat.answerCleanup']({ chatId: 'long', answer: 'never' })

  assert.equal(done.cleaned, 0, 'a refusal swept floors')
  assert.equal(done.recorded, true)
  assert.equal(await intactLayers(fixed.chats), before, 'a refusal changed the stored tables')

  // Under upstream's own key, on the chat itself, so a chat moved between the
  // two hosts carries the answer its owner gave.
  const entry = await fixed.chats.open('long')
  const first = entry.readFloorVariables(1).variables ?? {}
  assert.equal(first[IGNORE_CLEANUP_KEY], true, 'the refusal was not written where upstream writes it')

  // And it survives the round trip to disk, which is the only thing that makes
  // it a refusal rather than a mood.
  const reloaded = new ChatStore(join(fixed.dir, 'chats'), new CharacterLibrary(join(fixed.dir, 'characters'), '/a'))
  const after = await reloaded.open('long')
  assert.equal((after.readFloorVariables(1).variables ?? {})[IGNORE_CLEANUP_KEY], true)
  assert.equal(after.legacyCleanupOffer(DEFAULT_PRUNE), undefined, 'the offer came back after a refusal')
})

test('a backup that cannot be written stops the sweep', async (t) => {
  const fixed = await fixture(t)
  const before = await intactLayers(fixed.chats)

  // The backup is the whole reason this answer differs from "clean only". A user
  // who asked for one and did not get it has not agreed to what was to follow.
  const chats = fixed.chats as unknown as { backup: (chatId: string) => Promise<string> }
  chats.backup = async () => { throw new Error('the disk said no') }

  await assert.rejects(
    fixed.handlers['chat.answerCleanup']({ chatId: 'long', answer: 'backup-and-clean' }),
    /the disk said no/u,
  )
  assert.equal(await intactLayers(fixed.chats), before, 'the sweep ran despite the backup failing')
})

test('a backup that is written lands under the profile and the sweep follows', async (t) => {
  const fixed = await fixture(t)
  const before = await intactLayers(fixed.chats)

  const done = await fixed.handlers['chat.answerCleanup']({ chatId: 'long', answer: 'backup-and-clean' })

  assert.ok(done.backup !== undefined, 'no backup path came back')
  assert.ok(existsSync(done.backup ?? ''), 'the backup path names no file')
  assert.ok(done.backup?.startsWith(backupsDir(join(fixed.dir, 'chats'))), 'the backup landed outside the profile')

  // A copy taken *before* the sweep is the only kind worth having.
  const files = await readdir(backupsDir(join(fixed.dir, 'chats')))
  assert.equal(files.length, 1)
  assert.ok(done.cleaned > 0, 'the sweep did not run after a successful backup')
  assert.ok(await intactLayers(fixed.chats) < before, 'the sweep removed nothing')
})

test('the offer returns on every open until it is answered', async (t) => {
  const fixed = await fixture(t)
  const offers = (): number => fixed.events.filter(event => event.type === 'cleanup.offer').length

  await fixed.handlers['chat.open']({ chatId: 'long' })
  assert.equal(offers(), 1, 'opening a never-cleaned chat raised no offer')

  // **A dismissal is not an answer.** Upstream hangs its check on the chat load,
  // so reopening asks again. The first version of this gated the dialog behind a
  // once-per-loaded-entry report note, which made "we will ask again" mean "next
  // time the host loads this entry" — so pressing Esc and reopening the chat was
  // indistinguishable from having declined for good.
  await fixed.handlers['chat.open']({ chatId: 'long' })
  assert.equal(offers(), 2, 'the offer did not come back after a dismissal')

  await fixed.handlers['chat.open']({ chatId: 'long' })
  assert.equal(offers(), 3, 'the offer stopped repeating on its own')
})

test('answering never is the only thing that stops the offer', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })
  const before = fixed.events.filter(event => event.type === 'cleanup.offer').length
  assert.equal(before, 1)

  await fixed.handlers['chat.answerCleanup']({ chatId: 'long', answer: 'never' })
  await fixed.handlers['chat.open']({ chatId: 'long' })

  assert.equal(
    fixed.events.filter(event => event.type === 'cleanup.offer').length,
    before,
    'the offer came back after the user declined it',
  )
})

test('a swept chat stops offering, with nothing recorded to remember it', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['chat.open']({ chatId: 'long' })
  await fixed.handlers['chat.answerCleanup']({ chatId: 'long', answer: 'clean' })
  const after = fixed.events.filter(event => event.type === 'cleanup.offer').length

  await fixed.handlers['chat.open']({ chatId: 'long' })
  assert.equal(fixed.events.filter(event => event.type === 'cleanup.offer').length, after)

  // **No bookkeeping was needed for that.** The sweep removes `stat_data` from
  // the first floor, and the absence of it *is* the record that a cleanup has
  // run — which is why upstream needs no flag either.
  const entry = await fixed.chats.open('long')
  const first = entry.readFloorVariables(1).variables ?? {}
  assert.equal('stat_data' in first, false)
  assert.equal(first[IGNORE_CLEANUP_KEY], undefined, 'a sweep recorded a refusal it was not given')
})
