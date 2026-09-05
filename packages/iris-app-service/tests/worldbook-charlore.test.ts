import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { normalizeCard, type CharacterCard } from '@iris/character'
import type { LorebookEntry } from '@iris/lorebook'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { scanEntriesOf } from '../src/prompt.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { charWorldbookNames, resolveCardWorldbook, WorldbookStore } from '../src/worldbooks.ts'

/**
 * The books a user binds to a character **through the host** — upstream's
 * `world_info.charLore[<file name>].extraBooks` (`world-info.js:4363-4417`,
 * written by `updateAuxBooks` at `:6039`).
 *
 * Two rulings shape everything here, and both are inherited rather than new:
 *
 * - **The list lives with the profile, never in the card file.** The binding is
 *   runtime state about this installation; the card file is shared between
 *   installations. Same reason `globalSelect` and the materialisation table
 *   live beside the installation.
 * - **The extra books are a second channel, but not that second channel.** The
 *   never-combine ruling kills the embedded/named union because those are two
 *   copies of one book. An extra book is the user naming a *different* book for
 *   this character — upstream joins it into the same search set as the primary
 *   (`worldsToSearch`, `world-info.js:4376`) and so does this host.
 *
 * Every guard below is transcribed from `getCharacterLore`'s per-name loop:
 * skip a book already active globally (`:4387`), skip the chat's book
 * (`:4392`), skip a name that fails to load. The loop walks one Set holding
 * the primary **and** the extras, so each guard is per book — the primary's
 * loss never takes an extra down with it.
 */

const entryJson = (uid: number, comment: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid, ...extra,
})

const cardWith = (world?: string): CharacterCard => normalizeCard({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: '', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: world === undefined ? {} : { world },
  },
})

async function storeWith(books: Record<string, string[]>): Promise<{ store: WorldbookStore, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charlore-'))
  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const [name, comments] of Object.entries(books)) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({ entries: Object.fromEntries(comments.map((c, i) => [i, entryJson(i, c)])) }),
      'utf8',
    )
  }
  return { store: new WorldbookStore(join(dir, 'worlds')), dir }
}

const entry = (uid: number, comment: string, extra: Partial<LorebookEntry> = {}): LorebookEntry => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid, ...extra,
}) as LorebookEntry

// ------------------------------------------------------------------- storage

test('bound extras persist with the profile, in upstream’s own file shape', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charlore-store-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'settings.json')
  const settings = new SettingsStore(path, { provider: 'test', model: 'm' })

  const stored = await settings.setCharBooks('aria', ['创世回廊1.3', '啊不吃'])
  // Read back in the order bound — that order is the scan order upstream's Set
  // preserves, so it is behaviour rather than presentation.
  assert.deepEqual(stored, ['创世回廊1.3', '啊不吃'])
  assert.deepEqual(settings.charBooks('aria'), ['创世回廊1.3', '啊不吃'])

  // The file is ST's `settings.json → world_info_settings.world_info.charLore`,
  // row shape and key names included, so the two install formats stay legible
  // to each other.
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    worldbooks?: { charLore?: { name: string, extraBooks: string[] }[] }
  }
  assert.deepEqual(file.worldbooks?.charLore, [{ name: 'aria', extraBooks: ['创世回廊1.3', '啊不吃'] }])

  // Survives a reload — the binding outlives the process that wrote it.
  const reopened = new SettingsStore(path, { provider: 'test', model: 'm' })
  await reopened.load()
  assert.deepEqual(reopened.charBooks('aria'), ['创世回廊1.3', '啊不吃'])
})

test('duplicate names collapse to their first occurrence', async () => {
  const settings = new SettingsStore(join(await mkdtemp(join(tmpdir(), 'iris-charlore-dup-')), 'settings.json'),
    { provider: 'test', model: 'm' })
  assert.deepEqual(await settings.setCharBooks('aria', ['One', 'Two', 'One']), ['One', 'Two'])
  assert.deepEqual(settings.charBooks('aria'), ['One', 'Two'])
})

test('unbinding removes the whole row — no residual key', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charlore-unbind-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const path = join(dir, 'settings.json')
  const settings = new SettingsStore(path, { provider: 'test', model: 'm' })
  await settings.setGlobalSelect(['Global'])
  await settings.setCharBooks('aria', ['One'])
  await settings.setCharBooks('beatrix', ['Two'])

  // Upstream's `updateAuxBooks` splices the charLore entry when its list
  // empties (`world-info.js:6044`) — an unbound character leaves no row, not
  // an empty one.
  await settings.setCharBooks('aria', [])
  assert.deepEqual(settings.charBooks('aria'), [])
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    worldbooks?: {
      globalSelect?: string[]
      charLore?: { name: string, extraBooks: string[] }[]
    }
  }
  assert.equal(file.worldbooks?.charLore?.some(row => row.name === 'aria'), false,
    'the unbound character left a row behind')
  // The rest of the section survives the write: the other character's row and
  // the global selection are unrelated facts.
  assert.deepEqual(file.worldbooks?.charLore, [{ name: 'beatrix', extraBooks: ['Two'] }])
  assert.deepEqual(file.worldbooks?.globalSelect, ['Global'])

  // And unbinding the last row removes the list entirely.
  await settings.setCharBooks('beatrix', [])
  const final = JSON.parse(await readFile(path, 'utf8')) as { worldbooks?: { charLore?: unknown[] } }
  assert.equal(final.worldbooks?.charLore, undefined)
})

test('a global re-selection and a settings patch preserve the bindings', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charlore-preserve-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  await settings.setCharBooks('aria', ['One'])
  await settings.setWorldbookSettings({ scanDepth: 4 })

  // `setGlobalSelect` used to rewrite the whole `worldbooks` section; the
  // bindings would have died there, silently, on the user's next global pick.
  await settings.setGlobalSelect(['Global'])
  assert.deepEqual(settings.charBooks('aria'), ['One'])
  assert.equal(settings.worldbookSettings().scanDepth, 4)
})

test('a character with no row reads as unbound, not as an error', async () => {
  const settings = new SettingsStore(join(await mkdtemp(join(tmpdir(), 'iris-charlore-none-')), 'settings.json'),
    { provider: 'test', model: 'm' })
  assert.deepEqual(settings.charBooks('nobody'), [])
})

// ------------------------------------------------------- resolution and scan

test('bound extras join the primary in the scan, each under its own name', async () => {
  const { store } = await storeWith({
    Own: ['own entry'],
    'Extra One': ['extra one entry'],
    'Extra Two': ['extra two entry'],
    Global: ['global entry'],
  })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['Global'], undefined, ['Extra Two', 'Extra One'])

  assert.deepEqual(resolved.additional.map(book => book.world), ['Extra Two', 'Extra One'])

  // The acceptance property, per entry: the scan candidates carry the extra
  // books' entries, and `ScanEntry.world` says which book each came from —
  // `getwi(name, …)` matches on exactly this string.
  const scanned = scanEntriesOf(undefined, resolved)
  assert.deepEqual(scanned.map(e => e.comment).sort(),
    ['extra one entry', 'extra two entry', 'global entry', 'own entry'])
  assert.equal(scanned.find(e => e.comment === 'own entry')?.world, 'Own')
  assert.equal(scanned.find(e => e.comment === 'extra two entry')?.world, 'Extra Two')
  assert.equal(scanned.find(e => e.comment === 'extra one entry')?.world, 'Extra One')
  assert.equal(scanned.find(e => e.comment === 'global entry')?.world, 'Global')
})

test('the never-combine ruling still holds: extras add, they do not merge channels', async () => {
  const { store } = await storeWith({ Eldoria: ['named A', 'named B'], Extra: ['extra entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Eldoria'), store, [], undefined, ['Extra'])

  // The primary is still chosen by the old rules — one channel, the bound name.
  assert.equal(resolved.source, 'named')
  assert.deepEqual(resolved.entries.map(e => e.comment), ['named A', 'named B'])
  // The extra rides *beside* it, tagged separately — not merged into it.
  assert.deepEqual(resolved.additional.map(book => book.world), ['Extra'])
  assert.deepEqual(resolved.additional[0]?.entries.map(e => e.comment), ['extra entry'])
})

test('an extra that duplicates the primary contributes once', async () => {
  const { store } = await storeWith({ Own: ['own entry'] })
  // Upstream builds one Set with both names (`world-info.js:4376`), so a user
  // binding the card's own book as an extra gets one copy, not two.
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, [], undefined, ['Own'])
  assert.deepEqual(resolved.additional, [])
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['own entry'])
})

test('an extra that is globally selected is skipped — global wins that overlap', async () => {
  const { store } = await storeWith({ Own: ['own entry'], Shared: ['shared entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, ['Shared'], undefined, ['Shared'])

  // The per-book guard from `getCharacterLore` (`world-info.js:4387`): "already
  // activated in global world info! Skipping..." — the binding still exists,
  // the scan just does not double it.
  assert.deepEqual(resolved.additional, [])

  // One copy of the shared entry reaches the scan — through the **global**
  // channel, which is where it is selected. The count is the assertion: a
  // skipped guard would show two, from two directions at once.
  const scanned = scanEntriesOf(undefined, resolved)
  assert.equal(scanned.filter(e => e.comment === 'shared entry').length, 1)
  assert.deepEqual(scanned.filter(e => e.comment === 'own entry').map(e => e.world), ['Own'])
})

test('a dangling extra binding is skipped, not fatal, like a dangling global one', async () => {
  const { store } = await storeWith({ Own: ['own entry'] })
  const resolved = await resolveCardWorldbook(cardWith('Own'), store, [], undefined, ['deleted book', 'Own'])

  assert.deepEqual(resolved.additional, [])
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['own entry'])
})

test('the primary losing its guard does not take the extras down with it', async () => {
  const { store } = await storeWith({ Shared: ['shared entry'], Extra: ['extra entry'] })
  // The card binds the globally selected book: the primary contributes nothing
  // (`world-info.js:4387` again), and the extras are judged on their own turn
  // through the loop.
  const resolved = await resolveCardWorldbook(cardWith('Shared'), store, ['Shared'], undefined, ['Extra'])

  assert.deepEqual(resolved.entries, [])
  assert.deepEqual(resolved.additional.map(book => book.world), ['Extra'])
  assert.deepEqual(scanEntriesOf(undefined, resolved).map(e => e.comment), ['extra entry', 'shared entry'])
})

test('the chat-book guard is per book too', () => {
  // Upstream's loop skips any search-set name equal to the chat's book
  // (`world-info.js:4392`), so which book is the chat's decides who loses —
  // not whether the whole character side does.
  const chosen = {
    entries: [entry(0, 'own entry')], source: 'named' as const, world: 'Own',
    additional: [{ world: 'Chat Book', entries: [entry(1, 'extra entry')] }, { world: 'Other', entries: [entry(2, 'other entry')] }],
    global: [],
  }

  // The chat's book is the extra: that extra loses, the primary and the other
  // extra stay. Chat lore precedes every other source unconditionally.
  const asChatExtra = scanEntriesOf(undefined, chosen, [{ world: 'Chat Book', entries: [entry(9, 'chat copy')] }])
  assert.deepEqual(asChatExtra.map(e => e.comment), ['chat copy', 'own entry', 'other entry'])

  // The chat's book is the primary: the primary loses, the extras stay. The
  // pre-B8 guard cut the whole character side here.
  const primaryOnly = {
    ...chosen,
    additional: [{ world: 'Other', entries: [entry(2, 'other entry')] }],
  }
  const asChatPrimary = scanEntriesOf(undefined, primaryOnly, [{ world: 'Own', entries: [entry(9, 'chat copy')] }])
  assert.deepEqual(asChatPrimary.map(e => e.comment), ['chat copy', 'other entry'])
})

test('extras sit inside the character group: character_first keeps them ahead of globals', async () => {
  const chosen = {
    entries: [entry(0, 'own low', { order: 10 })], source: 'named' as const, world: 'Own',
    additional: [{ world: 'Extra', entries: [entry(1, 'extra low', { order: 5 })] }],
    global: [{ world: 'G', entries: [entry(2, 'global high', { order: 300 })] }],
  }

  // Upstream's characterLore is one list — primary and extras together —
  // before the strategy sorts groups (`world-info.js:4478`). An extra weighted
  // below the global still precedes every global entry under character_first.
  assert.deepEqual(
    scanEntriesOf(undefined, chosen, [], 'character_first').map(e => e.comment),
    ['own low', 'extra low', 'global high'],
  )
})

test('charWorldbookNames reports primary and extras, the shape the RPC answers', () => {
  const names = charWorldbookNames(cardWith('Own'), ['Extra One', 'Extra Two'])
  assert.deepEqual(names, { primary: 'Own', additional: ['Extra One', 'Extra Two'] })
  assert.deepEqual(charWorldbookNames(cardWith(), ['Extra']), { primary: null, additional: ['Extra'] })
  assert.deepEqual(charWorldbookNames(cardWith('Own')), { primary: 'Own', additional: [] })
})

// ------------------------------------------------- service wiring, end to end

interface Fixture {
  handlers: ReturnType<IrisAppService['handlers']>
  chats: ChatStore
  settings: SettingsStore
  dir: string
}

async function serviceFixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-charlore-svc-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await mkdir(join(dir, 'worlds'), { recursive: true })
  await writeFile(
    join(dir, 'characters', 'aria.json'),
    JSON.stringify({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: 'Aria', description: '', personality: '', scenario: '',
        first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
        post_history_instructions: '', alternate_greetings: [], tags: [],
        creator: '', character_version: '1',
        extensions: { world: 'Own' },
      },
    }),
    'utf8',
  )
  // Constant entries, so the itemize assertions see them: `prompt.itemize`
  // reports what the scan *activated*, and a selective entry with no keys
  // never activates on an empty conversation.
  for (const [name, comments] of Object.entries({ Own: ['own entry'], Extra: ['extra entry'] })) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({ entries: Object.fromEntries(comments.map((c, i) => [i, entryJson(i, c, { constant: true })])) }),
      'utf8',
    )
  }
  // A book whose only entry declares MVU starting state — for the test that
  // proves a bound extra seeds variables, the way MVU's own list
  // `[...selected_global_lorebooks, primary, ...additional]` says it should.
  await writeFile(
    join(dir, 'worlds', 'Seeds.json'),
    JSON.stringify({ entries: Object.fromEntries(
      [['0', entryJson(0, '[InitVar]', { content: 'mood: flat' })]],
    ) }),
    'utf8',
  )

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  // The same wiring as the composition: the bindings are read through a
  // closure at chat-open time, so a rebind reaches the next open.
  const chats = new ChatStore(
    join(dir, 'chats'), library, undefined, undefined, worldbooks,
    () => settings.globalSelect(),
    undefined, undefined, undefined,
    characterId => settings.charBooks(characterId),
  )
  const handlers = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } as never,
    library, chats, worldbooks, settings,
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()
  return { handlers, chats, settings, dir }
}

test('a second book bound over RPC reaches the chat’s scan candidates', async (t: TestContext) => {
  const { handlers, chats } = await serviceFixture(t)

  // The bind, the way the panel makes it: one RPC, answered with the binding
  // as stored.
  const bound = await handlers['worldbook.setCharBooks']({ characterId: 'aria', names: ['Extra'] })
  assert.deepEqual(bound, { primary: 'Own', additional: ['Extra'] })

  const created = await handlers['chat.create']({ characterId: 'aria' })
  const opened = await chats.open(created.view.chatId)
  assert.equal(opened.worldbook?.source, 'named')
  assert.deepEqual(opened.worldbook?.additional.map(book => book.world), ['Extra'])

  // The acceptance property, through the whole stack: the extra book's entries
  // are scan candidates, and `ScanEntry.world` tells them apart from the
  // primary's.
  const scanned = scanEntriesOf(opened.card, opened.worldbook)
  const extra = scanned.filter(e => e.world === 'Extra')
  assert.deepEqual(extra.map(e => e.comment), ['extra entry'])
  assert.ok(scanned.some(e => e.world === 'Own'), 'the primary book vanished when an extra was bound')

  // …and into the prompt the chat actually assembles.
  const { itemization } = await handlers['prompt.itemize']({ chatId: created.view.chatId })
  const worldInfo = itemization.entries.filter(item => item.id.startsWith('worldInfo.'))
  assert.equal(worldInfo.length, 1, 'the two books should render as one world-info block')
  assert.ok((worldInfo[0]?.tokens ?? 0) > 0)
})

test('unbinding over the RPC leaves no row and the scan returns to the primary alone', async (t: TestContext) => {
  const { handlers, chats, settings } = await serviceFixture(t)
  await handlers['worldbook.setCharBooks']({ characterId: 'aria', names: ['Extra'] })

  // An empty list is the unbind-all path.
  const unbound = await handlers['worldbook.setCharBooks']({ characterId: 'aria', names: [] })
  assert.deepEqual(unbound, { primary: 'Own', additional: [] })
  assert.deepEqual(settings.charBooks('aria'), [])

  // A re-open resolves without the extra: the candidates are the primary's only.
  const created = await handlers['chat.create']({ characterId: 'aria' })
  const opened = await chats.open(created.view.chatId)
  assert.deepEqual(opened.worldbook?.additional, [])
  assert.deepEqual(scanEntriesOf(opened.card, opened.worldbook).map(e => e.world), ['Own'])
})

test('binding a book with no file behind it is refused by name', async (t: TestContext) => {
  const { handlers } = await serviceFixture(t)
  await assert.rejects(
    handlers['worldbook.setCharBooks']({ characterId: 'aria', names: ['no-such-book'] }),
    /no-such-book/,
  )
  // A binding with no file behind it is silently skipped by every scan — which
  // reads as a book that activates nothing. Refusing here is what keeps the
  // panel honest about what was stored.
})

test('binding for a character that does not exist is refused', async (t: TestContext) => {
  const { handlers } = await serviceFixture(t)
  await assert.rejects(
    handlers['worldbook.setCharBooks']({ characterId: 'nobody', names: [] }),
    /no character/,
  )
})

test('an extra book declaring [InitVar] seeds the chat’s starting state', async (t: TestContext) => {
  const { handlers } = await serviceFixture(t)

  // MVU's own reader walks `[...selected_global_lorebooks, primary,
  // ...additional]` (MagVarUpdate `initvar/variable_init.ts:230`) — the
  // additional bindings have a named place in it, so a book bound through the
  // host declares starting state exactly as it would upstream.
  await handlers['worldbook.setCharBooks']({ characterId: 'aria', names: ['Seeds'] })
  const created = await handlers['chat.create']({ characterId: 'aria' })

  const { variables } = await handlers['script.getVariables']({
    chatId: created.view.chatId,
    scope: 'message',
    messageId: 0,
  })
  const statData = variables['stat_data'] as Record<string, unknown> | undefined
  assert.equal(statData?.['mood'], 'flat', 'the extra book’s [InitVar] never reached message 0')
})

test('charNames answers the stored extras, and an unknown character still refuses', async (t: TestContext) => {
  const { handlers } = await serviceFixture(t)
  await handlers['worldbook.setCharBooks']({ characterId: 'aria', names: ['Extra'] })
  assert.deepEqual(
    await handlers['worldbook.charNames']({ characterId: 'aria' }),
    { primary: 'Own', additional: ['Extra'] },
  )
  await assert.rejects(handlers['worldbook.charNames']({ characterId: 'nobody' }), /no character/)
})
