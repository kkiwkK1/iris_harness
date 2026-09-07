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

test('every context field the real corpus reads is accounted for', { skip: !existsSync(CORPUS) && `no characters folder at ${CORPUS}; point IRIS_CORPUS at a SillyTavern install` }, async () => {
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

  // JSON text on the wire: clone cost is per object, so carrying these as
  // trees was ~91% of the snapshot's clone time for 45% of its bytes. Parsing
  // one floor when asked costs under a millisecond.
  const carried = message['variables']
  assert.equal(typeof carried, 'string', 'the bridged chat carries its tables as JSON text')
  const perSwipe = JSON.parse(String(carried)) as Record<string, unknown>[]
  assert.ok(Array.isArray(perSwipe), 'the bridged chat carries per-swipe variables')
  const mine = perSwipe[message.swipe_id ?? 0]
  assert.deepEqual((mine?.['stat_data'] as Record<string, unknown>)['mood'], ['calm', 'how she seems'])
})

test('a card’s world book bindings reach the frame as names', () => {
  const bound = card()
  bound.data.extensions = { world: 'Eldoria' }
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: bound,
  })

  // Names, not contents: the frame answers `getCharWorldbookNames('current')`
  // from this, and upstream's member returns names too — a card that wants a
  // book asks for it separately.
  assert.deepEqual(contextOf(built).charWorldbooks, { primary: 'Eldoria', additional: [] })
})

test('a binding is reported even when nothing on disk answers to it', () => {
  const dangling = card()
  dangling.data.extensions = { world: 'a book that was deleted' }
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: dangling,
  })

  // `primary` is the **binding**, not the book the host ended up assembling
  // from. Two of the corpus's 18 bindings are dangling, and for those the host
  // falls back to the card's embedded book — but reporting that fallback here
  // would answer a different question than the one the card asked. 2 of 18
  // measured 2026-09-02.
  assert.equal(contextOf(built).charWorldbooks?.primary, 'a book that was deleted')
})

test('a card that binds nothing reports null, not an absent field', () => {
  // Null rather than the key being missing: a frame doing
  // `context.charWorldbooks.primary` should read "bound to nothing" rather than
  // crash on an absent object, and upstream's shape is `{primary: null, …}`.
  assert.deepEqual(contextOf(entry()).charWorldbooks, { primary: null, additional: [] })
})

test('additional books are empty because the source is absent, not unimplemented', () => {
  // Upstream fills this from `world_info.charLore[<avatar stem>].extraBooks`,
  // where `world_info` lives under `settings.json` → **`world_info_settings`**.
  // The measured installation has that section; it holds `globalSelect` and no
  // `charLore`. This host has no equivalent at all. So an empty list is the
  // *true* answer rather than a placeholder — the same distinction the fake
  // client draws between reporting an absence and inventing one.
  //
  // An earlier version of this comment said `world_info` was absent from the
  // settings file entirely, having looked at the top level. The conclusion
  // survived that error and the reason did not, which is the more dangerous
  // half: a false reason keeps producing the right answer until the data
  // changes, and then keeps producing it.
  //
  // The day a `charLore` equivalent exists, this test is the one that should
  // stop being true.
  const bound = card()
  bound.data.extensions = { world: 'Eldoria' }
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: bound,
  })
  assert.deepEqual(contextOf(built).charWorldbooks?.additional, [])
})

test('the played character carries its own book; the others stay summaries', () => {
  const withBook = card()
  withBook.data.character_book = {
    entries: [{ keys: ['tower'], content: 'The maps are in the west tower.' }],
  } as never
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: withBook,
  })

  const context = buildCardContext(built, {
    extensionSettings: {},
    characters: [
      { characterId: 'aria', name: 'Aria', tags: [] },
      { characterId: 'other', name: 'Other', tags: [] },
    ],
  })

  // The exact path the one real corpus reader walks, guard by guard:
  // `charData.data && charData.data.character_book && …entries`. Asserted as
  // that nesting rather than as "the book is somewhere", because a flattened
  // shape would fail the card's first guard and read to it as "this character
  // has no world info" — a silent absence, not an error.
  const played = context.characters.find(row => row.characterId === 'aria')
  const entries = (played?.data?.character_book as { entries?: unknown[] } | undefined)?.entries
  assert.equal(Array.isArray(entries), true)
  assert.equal(entries?.length, 1)

  // Everyone else stays a summary. Attaching every card's book would hand a
  // frame that asked about one conversation the whole library's world info.
  const other = context.characters.find(row => row.characterId === 'other')
  assert.equal(other?.data, undefined)
})

test('real cards decode their embedded book to an array', { skip: !existsSync(CORPUS) && `no characters folder at ${CORPUS}; point IRIS_CORPUS at a SillyTavern install` }, async () => {
  /*
   * The two tests above pin the MIRROR: hand it an array and it does not
   * helpfully normalise it into the disk shape. Neither can pin the DECODER,
   * because both build their own `character_book`. So the premise the card's
   * `.length` / `[i]` walk actually rests on — that a real card decodes to an
   * array — was recorded only in prose (`notes/TEST-CARDS.md` §七), and prose cannot
   * notice when it goes stale.
   *
   * SillyTavern's own disk world books key `entries` by uid; the V2/V3 card spec
   * uses an array. A card whose embedded book arrived in the keyed shape would
   * give `entries.length === undefined`, zero iterations, and a green run.
   */
  const { decodeCardPng } = await import('@iris/character')
  const files = (await import('node:fs')).readdirSync(CORPUS)
    .filter(name => name.toLowerCase().endsWith('.png'))

  let withBook = 0
  const keyed: string[] = []
  for (const name of files) {
    let decoded
    try { decoded = decodeCardPng((await import('node:fs')).readFileSync(`${CORPUS}/${name}`)) } catch { continue }
    const book = (decoded as { data?: { character_book?: { entries?: unknown } } }).data?.character_book
    if (book?.entries === undefined) continue
    withBook += 1
    if (!Array.isArray(book.entries)) keyed.push(name)
  }

  // A floor, not a bonus: without it a decoder that stopped attaching
  // `character_book` at all would leave `withBook === 0` and this test would
  // pass having compared nothing — the shape of failure this repo has already
  // shipped once (a loop that compared 4 of 26 and stayed green).
  assert.ok(withBook > 0, 'no corpus card decoded with an embedded book — the decoder or this path changed')
  assert.deepEqual(keyed, [], 'these cards decode `character_book.entries` to a keyed object, which a card walking it with .length reads as empty')
})

test('a chat with no card leaves every entry a summary', () => {
  const built = new ChatEntry({
    chatId: 'none-1',
    header: {
      user_name: 'Traveller', character_name: 'Nobody',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'none-1', title: 'Nobody', updatedAt: 0 },
    },
    session: createSession('none-1'),
    card: undefined,
  })
  const context = buildCardContext(built, {
    extensionSettings: {},
    characters: [{ characterId: 'aria', name: 'Aria', tags: [] }],
  })
  assert.equal(context.characters[0]?.data, undefined)
})

test('the snapshot carries every declared button, hidden ones included', () => {
  const withButtons = card()
  withButtons.data.extensions = {
    tavern_helper: {
      scripts: [{
        id: 'panel', name: 'Panel', type: 'script', enabled: true, content: 'noop()',
        button: {
          enabled: true,
          buttons: [
            { name: '显示', visible: true },
            { name: '隐藏', visible: false },
          ],
        },
      }],
    },
  } as never
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: withButtons,
  })

  // `getScriptButtons()` is synchronous upstream, so it is answered from here
  // rather than over the wire — and it returns **every** button. `visible:
  // false` is "not rendered", not "not there": 58 of the corpus's 89 buttons are
  // hidden, and flipping one to `true` is how a script reveals it. A filtered
  // surface would give a correct-looking panel and a script that cannot find the
  // button it means to show.
  const buttons = contextOf(built).scriptButtons?.['panel']
  assert.deepEqual(buttons, [
    { name: '显示', visible: true },
    { name: '隐藏', visible: false },
  ])
})

test('what a card is handed is a copy of its buttons, not the declaration', () => {
  const withButtons = card()
  withButtons.data.extensions = {
    tavern_helper: {
      scripts: [{
        id: 'panel', name: 'Panel', type: 'script', enabled: true, content: 'noop()',
        button: { enabled: true, buttons: [{ name: 'one', visible: true }] },
      }],
    },
  } as never
  const built = new ChatEntry({
    chatId: 'aria-1',
    header: {
      user_name: 'Traveller', character_name: 'Aria',
      create_date: '2026-09-01 @10h00m00s', chat_metadata: {},
      iris: { chatId: 'aria-1', characterId: 'aria', title: 'Aria', updatedAt: 0 },
    },
    session: createSession('aria-1'),
    card: withButtons,
  })

  // Upstream's own `_getScriptButtons` returns `klona(...)`, so a card that
  // scribbles on what it received changes nothing. Matched here: a frame is a
  // separate trust domain, and a shared array would be a way into the card's
  // declaration that passes no check on the way.
  const handed = contextOf(built).scriptButtons?.['panel']
  assert.ok(handed)
  handed[0] = { name: 'rewritten', visible: false }

  assert.deepEqual(contextOf(built).scriptButtons?.['panel'], [{ name: 'one', visible: true }])
})

test('the host’s world book names ride the snapshot for getWorldbookNames', () => {
  /*
   * Upstream's `getWorldbookNames()` is synchronous — `klona(world_names)` — so
   * the frame's answer has to be already in hand, the way `charWorldbooks` and
   * `lorebookSettings` are. The list is the caller's to fetch (this function is
   * synchronous, the store is not), and a book the host seeded from a card's
   * embedded copy must be named here: a card that asserts its own book exists
   * checks this very list.
   */
  const names = ['哈人冰恋世界v2.0', '另一本书']
  const chat = entry()
  const built = buildCardContext(chat, {
    extensionSettings: {},
    characters: [],
    worldbookNames: names,
  })
  assert.deepEqual(built.worldbookNames, names)

  // Absent means "no store", which is the same answer an empty list gives a
  // card — rather than an absent field a frame would have to branch on.
  assert.deepEqual(contextOf(entry()).worldbookNames, [])
})
