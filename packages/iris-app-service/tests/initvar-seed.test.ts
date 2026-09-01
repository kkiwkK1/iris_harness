import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * A new chat's message 0 carries the card's declared starting state.
 *
 * Not a preference. Tavern Helper's `waitGlobalInitialized('Mvu')` polls
 * `_.has(getVariables({type: 'message', message_id: 0}), 'stat_data')`
 * (`JS-Slash-Runner/src/function/global.ts:35`), so a card whose scripts wait on
 * it stalls for the whole timeout on every fresh Iris chat. SillyTavern's own
 * files satisfy that condition: 21 of the 31 real chats on this machine carry
 * `stat_data` on message 0.
 *
 * The shape is therefore compared **against those files**, field by field,
 * rather than against what seemed reasonable. That is the failure this
 * repository keeps paying for — a fixture written from the same belief as the
 * code — and the one place it was most likely to recur here.
 */

const CHARACTERS = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/characters`
const CHATS = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/chats`
const CARD = join(CHARACTERS, '爱衣.png')

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  dir: string
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-seed-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await copyFile(CARD, join(dir, 'characters', '爱衣.png'))

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
  }).handlers()
  return { handlers, chats, dir }
}

test('a new chat answers the question Tavern Helper actually asks', {
  skip: !existsSync(CARD),
}, async (t) => {
  const { handlers } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: '爱衣' })

  // The literal predicate from `global.ts:35`, not a paraphrase of it.
  const { variables } = await handlers['script.getVariables']({
    chatId: created.view.chatId,
    scope: 'message',
    messageId: 0,
  })
  assert.equal('stat_data' in variables, true, 'waitGlobalInitialized would still time out')
  assert.ok(Object.keys(variables['stat_data'] as object).length > 0, 'stat_data was seeded empty')
})

test('the seeded shape matches what SillyTavern writes, field by field', {
  skip: !existsSync(CHATS) || !existsSync(CARD),
}, async (t) => {
  // What real files put on message 0, gathered at run time rather than copied
  // in: the corpus trees carry explicit content, and the repository holds
  // shapes.
  const realKeys = new Set<string>()
  let realFiles = 0
  for (const character of await readdir(CHATS)) {
    let names: string[]
    try {
      names = await readdir(join(CHATS, character))
    } catch {
      continue
    }
    for (const name of names) {
      let text: string
      try {
        text = await readFile(join(CHATS, character, name), 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/).filter(Boolean)
      // Line 0 is the header; line 1 is message 0.
      if (lines.length < 2) continue
      let message: { variables?: unknown }
      try {
        message = JSON.parse(lines[1] as string) as typeof message
      } catch {
        continue
      }
      const table = Array.isArray(message.variables) ? message.variables[0] : undefined
      if (typeof table !== 'object' || table === null || Object.keys(table).length === 0) continue
      realFiles += 1
      for (const key of Object.keys(table as object)) realKeys.add(key)
    }
  }
  assert.ok(realFiles > 10, `expected the corpus's chats, saw ${String(realFiles)}`)

  const { handlers, chats } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: '爱衣' })
  const entry = await chats.open(created.view.chatId)
  const written = entry.toFile().messages[0] as { variables?: unknown[] }

  // Parallel to `swipes`, one table per alternate greeting — the corpus's
  // arrays match their `swipes` arrays element for element in every file.
  assert.ok(Array.isArray(written.variables), 'message 0 carries no variables array')
  const table = written.variables[0] as Record<string, unknown>
  assert.equal(
    written.variables.length,
    (written as unknown as { swipes?: unknown[] }).swipes?.length ?? 1,
    'the variables array is not parallel to swipes',
  )

  // Every field we write is a field real files have. This is the direction that
  // matters: writing a key SillyTavern does not use would be an invention.
  for (const key of Object.keys(table)) {
    assert.ok(realKeys.has(key), `we write "${key}", which no real chat file carries`)
  }
  assert.equal('stat_data' in table, true)
  assert.equal('initialized_lorebooks' in table, true)

  // And the known divergence, asserted rather than left to be discovered: every
  // non-empty table in the corpus carries `schema`, which MVU derives from the
  // declaration and Iris does not implement. Omitting a field is honest;
  // fabricating one a consumer might read is not. If this ever starts failing,
  // schema support arrived and this note is what says why it was missing.
  assert.ok(realKeys.has('schema'), 'the corpus stopped carrying schema')
  assert.equal('schema' in table, false, 'a schema appeared without anything computing one')
})

test('a chat is not given a variables table it has nothing to put in', {
  skip: !existsSync(CARD),
}, async (t) => {
  const { handlers, chats, dir } = await fixture(t)
  // A card with no `[InitVar]` entry declares no starting state. Writing an
  // empty tree would add a `variables` array that says nothing — and the one
  // corpus file whose card has no MVU has no `variables` key at all.
  const plain = JSON.stringify({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: 'Plain', description: '', personality: '', scenario: '', first_mes: 'Hi.',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
    },
  })
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'characters', 'plain.json'), plain, 'utf8')

  const created = await handlers['chat.create']({ characterId: 'plain' })
  const entry = await chats.open(created.view.chatId)
  const written = entry.toFile().messages[0] as { variables?: unknown }
  assert.equal(written.variables, undefined, 'a card with no declared state got a variables array anyway')
})

test('an existing chat file is left exactly as it is', {
  skip: !existsSync(CARD),
}, async (t) => {
  const { handlers, chats, dir } = await fixture(t)
  const created = await handlers['chat.create']({ characterId: '爱衣' })
  const path = join(dir, 'chats', `${created.view.chatId}.jsonl`)
  const before = await readFile(path, 'utf8')

  // A second store over the same folder is what a restart is — the first one
  // caches its entries, so reusing it would test the cache rather than the
  // file. Back-filling would be editing the user's data, and the two
  // generations of file are meant to coexist.
  const second = new ChatStore(join(dir, 'chats'), new CharacterLibrary(join(dir, 'characters'), '/iris/avatar'))
  const reopened = await second.open(created.view.chatId)
  const table = (reopened.toFile().messages[0] as { variables?: unknown[] }).variables?.[0] as Record<string, unknown>
  assert.equal('stat_data' in table, true, 'the seeded state did not survive the round trip')
  assert.equal(await readFile(path, 'utf8'), before, 'reopening rewrote the file')
  void chats
})
