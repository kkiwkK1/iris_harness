import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { decodeCardPng, type CharacterCard } from '@iris/character'
import { extractScripts } from '@iris/script'

import {
  assertStorable,
  buildCardContext,
  commitChatMetadata,
  ExtensionSettingsStore,
  type ScriptContext,
} from '../src/context.ts'
import { ChatEntry, createSession } from '../src/entry.ts'
import { seedGreeting } from '../src/chats.ts'
import type { SillyTavernChatHeader } from '@iris/persistence'

/**
 * The host half of the `parent.*` bridge.
 *
 * The last test here is the important one, and it is not a unit test: it
 * re-runs the measurement that decided this module's shape against the real
 * card corpus. A fixture cannot tell us whether the surface is wide enough,
 * because a fixture is written from the same belief as the code.
 */

/** A card whose data is enough to open a chat with. */
function card(name = 'Aria'): CharacterCard {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '',
      personality: '',
      scenario: '',
      first_mes: 'Hello.',
      mes_example: '',
      creator_notes: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: {},
    },
  }
}

/** An open conversation with one greeting on it. */
function entry(): ChatEntry {
  const header: SillyTavernChatHeader = {
    user_name: 'Traveller',
    character_name: 'Aria',
    create_date: '2026-09-01 @10h00m00s',
    chat_metadata: {},
    iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
  }
  const built = new ChatEntry({ chatId: 'aria-1', header, session: createSession('aria-1'), card: card() })
  seedGreeting(built, card(), { user: 'Traveller', char: 'Aria' })
  return built
}

/** Build a context with empty extras. */
function contextOf(chat: ChatEntry): ScriptContext {
  return buildCardContext(chat, { extensionSettings: {}, characters: [] })
}

test('the conversation is handed over in SillyTavern’s own message shape', () => {
  const chat = entry()
  const context = contextOf(chat)

  // Cards index `chat[i].mes` and `is_user` directly — 194 of the corpus's
  // field reads are on this array — so the compatibility shape is the point.
  assert.equal(context.chat.length, 1)
  assert.equal(context.chat[0]?.mes, 'Hello.')
  assert.equal(context.chat[0]?.is_user, false)
  assert.equal(context.name1, 'Traveller')
  assert.equal(context.name2, 'Aria')
  assert.equal(context.chatId, 'aria-1')
  assert.equal(context.characterId, 'aria')
})

test('what a card is handed is a copy, not a way into host state', () => {
  const chat = entry()
  chat.header.chat_metadata['existing'] = { keep: true }

  const context = contextOf(chat)
  context.chatMetadata['existing'] = { keep: false }
  ;(context.chat[0] as { mes: string }).mes = 'rewritten behind the host’s back'

  // A frame is a separate trust domain; if it held references, a card could
  // edit the log without passing a single check on the way.
  assert.deepEqual(chat.header.chat_metadata['existing'], { keep: true })
  assert.equal(chat.toFile().messages[0]?.mes, 'Hello.')
})

test('committed metadata replaces wholesale, so a deleted key is gone', () => {
  const chat = entry()
  chat.header.chat_metadata['stale'] = 1

  commitChatMetadata(chat, { fresh: { count: 2 } })

  // Upstream hands a card the object and it mutates in place, so a key it
  // removed is meant to stay removed — merging would resurrect it.
  assert.deepEqual(chat.header.chat_metadata, { fresh: { count: 2 } })
})

test('a value the chat file could not hold is refused where it enters', () => {
  assertStorable({ ok: [1, 'two', null, { three: true }] })

  // These all fail later inside a session append, with a message about
  // serialization rather than about the card that sent them.
  assert.throws(() => assertStorable({ when: new Date() }, 'meta'), /meta\.when is a Date instance/)
  assert.throws(() => assertStorable({ big: 1 / 0 }, 'meta'), /meta\.big is Infinity/)
  assert.throws(() => assertStorable({ fn: () => 1 }, 'meta'), /meta\.fn is a function/)
  assert.throws(() => assertStorable({ deep: { list: [new Map()] } }, 'm'), /m\.deep\.list\[0\] is a Map instance/)
})

test('one card cannot read or overwrite another card’s settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ext-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new ExtensionSettingsStore(join(dir, 'extension-settings.json'))

  await store.set('aria', { theme: 'dark', token: 'aria-only' })
  await store.set('luoluo', { theme: 'light' })

  // The partition is what makes a per-card grant mean anything: a shared
  // settings bag is a channel that does not know which card is asking.
  assert.deepEqual(await store.get('aria'), { theme: 'dark', token: 'aria-only' })
  assert.deepEqual(await store.get('luoluo'), { theme: 'light' })
  assert.deepEqual(await store.get('never-seen'), {}, 'an unknown card starts empty, it does not inherit')

  // A returned partition is detached, so scribbling on it changes nothing.
  const held = await store.get('aria')
  held['token'] = 'stolen'
  assert.equal((await store.get('aria'))['token'], 'aria-only')

  await store.forget('aria')
  assert.deepEqual(await store.get('aria'), {})
  assert.deepEqual(await store.get('luoluo'), { theme: 'light' }, 'forgetting one leaves the others')
})

/**
 * The corpus check.
 *
 * Skipped where the library is not installed, the way the live-provider test
 * skips without a key: a machine without SillyTavern must still run the suite
 * offline and green.
 */
const CORPUS = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/data/default-user/characters`
const ST_CONTEXT = `${(process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern')}/public/scripts/st-context.js`

/** Fields answered in the browser, by the frame runner rather than the host. */
const BROWSER_SIDE = new Set(['addOneMessage', 'printMessages', 'eventSource', 'event_types'])

/** Fields that are operations needing a wire method, not data this module holds. */
const PENDING_WIRE = new Set(['saveChat', 'saveMetadata', 'updateChatMetadata', 'generateRaw', 'setExtensionPrompt'])

/**
 * Fields the frame answers from data this module already provides.
 *
 * `getCurrentChatId()` is a function on the global that returns `chatId`;
 * `variables` is `chat[i].variables[swipe_id]`, which rides inside `chat`.
 * Neither needs a wire call — but both need to be placed on purpose, which is
 * what this set records.
 */
const DERIVED = new Set(['getCurrentChatId', 'variables'])

/** Names ordinary enough that a hit is not evidence of context use. */
const AMBIGUOUS = new Set(['chat', 'characters', 'groups', 'tags', 't', 'translate', 'generate'])

test('every context field the real corpus reads is accounted for', { skip: !existsSync(CORPUS) }, async () => {
  const source = await readFile(ST_CONTEXT, 'utf8')
  const start = source.indexOf('export function getContext()')
  const body = source.slice(start, source.indexOf('\n}', start))
  const surface = new Set<string>()
  for (const match of body.matchAll(/^\s{8}(?:\/\*\*.*\*\/\s*)?([A-Za-z_$][\w$]*)\s*[,:]/gmu)) {
    surface.add(match[1] as string)
  }
  assert.ok(surface.size > 100, `read ${String(surface.size)} keys off SillyTavern's getContext`)

  const touched = new Set<string>()
  for (const name of (await readdir(CORPUS)).filter(file => file.endsWith('.png'))) {
    let decoded
    try {
      decoded = decodeCardPng(await readFile(join(CORPUS, name)))
    } catch {
      continue
    }
    for (const script of extractScripts(decoded).scripts) {
      for (const field of surface) {
        if (AMBIGUOUS.has(field)) continue
        if (new RegExp(String.raw`\??\.\s*${field}\b`, 'u').test(script.content)) touched.add(field)
      }
    }
  }

  assert.ok(touched.size > 0, 'the corpus decoded but no context field was seen — extraction is broken')

  const provided = new Set(Object.keys(contextOf(entry())))
  const unaccounted = [...touched].filter(field =>
    !provided.has(field) && !BROWSER_SIDE.has(field) && !PENDING_WIRE.has(field) && !DERIVED.has(field))

  // A card reaching for a field nobody answers fails silently — it falls back
  // to its own window and does nothing, with no error to trace. So a new field
  // appearing here has to be placed deliberately, not discovered in the wild.
  assert.deepEqual(unaccounted, [], `unplaced context fields: ${unaccounted.join(', ')}`)
})

test('a status-bar card reaches its MVU state at the path the corpus uses', () => {
  const chat = entry()
  // The exact access path measured in the corpus:
  //   msg.variables[msg.swipe_id ?? 0].stat_data
  chat.recordVariables(0, "<UpdateVariable>_.set('mood', 'calm');</UpdateVariable>")
  chat.variables.replaceVariables({ stat_data: { mood: ['calm', 'how she seems'] } }, { type: 'message' })

  const context = contextOf(chat)
  const message = context.chat[0]
  assert.ok(message !== undefined)

  const perSwipe = message['variables'] as Record<string, unknown>[] | undefined
  assert.ok(Array.isArray(perSwipe), 'the bridged chat carries per-swipe variables')
  const mine = perSwipe[message.swipe_id ?? 0]
  assert.deepEqual((mine?.['stat_data'] as Record<string, unknown>)['mood'], ['calm', 'how she seems'])
})
