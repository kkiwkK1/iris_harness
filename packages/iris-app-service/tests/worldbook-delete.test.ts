/**
 * Deleting a named world book: what goes, what is rewritten, what is reported.
 *
 * The one arm of the world-book family that destroys a file the user may hold
 * the only copy of, so it is pinned by what it *leaves behind* as much as by
 * what it removes. Upstream's `deleteWorldInfo` (`world-info.js:4234`) is the
 * model: a name with no file answers `false` rather than raising, the file
 * goes, the **global selection** drops the name (`:4253`), and every other
 * binding is left dangling — upstream touches neither `charLore` nor any
 * chat's `chat_metadata.world_info`.
 *
 * The dangling part is the interesting half. Leaving a binding pointing at
 * nothing sounds like a bug and is the behaviour every reader in this host
 * already accommodates (`getChatWorldbookName`'s existence guard,
 * `resolveCardWorldbook`'s rules 2 and 4) — so the fix is not to rewrite
 * settings the caller never mentioned, it is to **say** what now dangles,
 * which is what nothing else will remember once the file is gone.
 *
 * @module @iris/app-service/tests/worldbook-delete
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { normalizeCard, type CharacterCard } from '@iris/character'

import { ChatStore } from '../src/chats.ts'
import { DiagnosticBuffer } from '../src/diagnostics.ts'
import { CharacterLibrary } from '../src/library.ts'
import { WorldbookBindingStore } from '../src/materialise.ts'
import { IrisAppService } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'
import { WorldbookStore } from '../src/worldbooks.ts'

const entryJson = (uid: number, comment: string): Record<string, unknown> => ({
  uid, key: [], keysecondary: [], comment, content: `${comment} body`,
  constant: false, selective: true, vectorized: false, selectiveLogic: 0,
  order: 100, position: 4, disable: false, displayIndex: uid,
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

/**
 * A host with three books, one card, and a binding table.
 *
 * Real files and a real settings file, because the properties under test are
 * "is the file gone" and "did the settings change" — neither of which a double
 * can answer.
 */
async function fixture(t: TestContext): Promise<{
  handlers: ReturnType<IrisAppService['handlers']>
  settings: SettingsStore
  bindings: WorldbookBindingStore
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-delete-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  await mkdir(join(dir, 'worlds'), { recursive: true })
  for (const name of ['Own', 'Extra', 'Global']) {
    await writeFile(
      join(dir, 'worlds', `${name}.json`),
      JSON.stringify({ entries: { 0: entryJson(0, `${name} entry`) } }),
      'utf8',
    )
  }
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), JSON.stringify(cardWith('Own')), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const worldbooks = new WorldbookStore(join(dir, 'worlds'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  const bindings = new WorldbookBindingStore(join(dir, 'worldbook-bindings.json'))
  const chats = new ChatStore(
    join(dir, 'chats'), library, undefined, undefined, worldbooks,
    () => settings.globalSelect(),
    undefined, undefined, undefined,
    characterId => settings.charBooks(characterId),
  )

  const handlers = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } as never,
    library, chats, worldbooks, settings,
    worldbookBindings: bindings,
    diagnostics: new DiagnosticBuffer(),
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  return { handlers, settings, bindings, dir }
}

test('the file goes, and the answer says so', async (t: TestContext) => {
  const { handlers, dir } = await fixture(t)

  const answer = await handlers['worldbook.delete']({ name: 'Extra' })

  assert.equal(answer.deleted, true)
  assert.equal(existsSync(join(dir, 'worlds', 'Extra.json')), false, 'the file survived the delete')
  // The listing is the same reader every card and panel uses, so a name that
  // lingers there is a book that still exists as far as everything else is
  // concerned.
  assert.deepEqual((await handlers['worldbook.names']({})).names, ['Global', 'Own'])
})

test('a name with no file answers false, and is not an error', async (t: TestContext) => {
  const { handlers, settings } = await fixture(t)
  await settings.setGlobalSelect(['Global'])

  const answer = await handlers['worldbook.delete']({ name: 'no-such-book' })

  // Upstream's own first line (`world-info.js:4235`) and the reason both
  // card-facing members are typed `Promise<boolean>` rather than throwing.
  assert.deepEqual(answer, {
    deleted: false,
    clearedGlobalSelect: false,
    dangling: { characters: [], materialisedFor: [] },
  })
  // Nothing else moved. A delete that removed nothing must not rewrite a
  // selection or push a report — an instrument that fires on the empty case
  // teaches its reader to skim.
  assert.deepEqual(settings.globalSelect(), ['Global'])
  assert.deepEqual((await handlers['debug.reports']({})).reports.filter(row => row.kind === 'host'), [])
})

test('the global selection drops the name, as upstream’s delete does', async (t: TestContext) => {
  const { handlers, settings, dir } = await fixture(t)
  await settings.setGlobalSelect(['Global', 'Own'])

  const answer = await handlers['worldbook.delete']({ name: 'Global' })

  assert.equal(answer.clearedGlobalSelect, true)
  assert.deepEqual(settings.globalSelect(), ['Own'], 'the deleted book is still globally selected')
  // Persisted, not only in memory: the next process reads the file, and a
  // selection that named a deleted book would make every chat open skip it
  // silently for ever.
  const file = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as {
    worldbooks?: { globalSelect?: string[] }
  }
  assert.deepEqual(file.worldbooks?.globalSelect, ['Own'])
})

test('a selection that did not name it is left alone', async (t: TestContext) => {
  const { handlers, settings } = await fixture(t)
  await settings.setGlobalSelect(['Global'])

  const answer = await handlers['worldbook.delete']({ name: 'Extra' })

  // The other direction, so `clearedGlobalSelect` is a fact and not a constant:
  // it has to be able to answer false for a real deletion.
  assert.equal(answer.clearedGlobalSelect, false)
  assert.deepEqual(settings.globalSelect(), ['Global'])
})

test('the bindings left dangling are named, not repaired', async (t: TestContext) => {
  const { handlers, settings, bindings } = await fixture(t)
  await settings.setCharBooks('aria', ['Extra'])
  await bindings.set('aria', {
    name: 'Extra', sourceHash: 'src', materialisedHash: 'mat',
    // The card's own `extensions.world` with no book of that name — the
    // commonest of the four origins, and the one the fixture's card is in.
    origin: 'card-name', at: 0,
  })

  const answer = await handlers['worldbook.delete']({ name: 'Extra' })

  assert.deepEqual(answer.dangling, { characters: ['aria'], materialisedFor: ['aria'] })
  /*
   * **Not repaired**, and this is the assertion that would go red if someone
   * "fixed" the dangling binding.
   *
   * Upstream clears neither, every reader here treats a name with no file as
   * unbound, and clearing would make a delete rewrite settings the caller never
   * mentioned. Clearing the *materialisation* row would be worse than
   * cosmetic: the next chat open would re-materialise the card's embedded book
   * under that name and the deletion would silently undo itself.
   */
  assert.deepEqual(settings.charBooks('aria'), ['Extra'])
  assert.equal((await bindings.get('aria'))?.name, 'Extra')
})

test('the deletion is reported as irreversible, with what it left behind', async (t: TestContext) => {
  const { handlers, settings } = await fixture(t)
  await settings.setCharBooks('aria', ['Extra'])
  await settings.setGlobalSelect(['Extra'])

  await handlers['worldbook.delete']({ name: 'Extra' })

  const reports = (await handlers['debug.reports']({})).reports.filter(row => row.kind === 'host')
  assert.equal(reports.length, 1, `expected one host report, saw ${JSON.stringify(reports)}`)
  const message = reports[0]?.message ?? ''
  // The book's name, so the record is about a specific loss…
  assert.match(message, /"Extra"/u)
  // …the selection write, which is the one binding this arm changed…
  assert.match(message, /global selection/u)
  // …and who is now bound to nothing, which is the fact the deleted file was
  // the only other record of.
  assert.match(message, /aria/u)
})

test('a name that climbs out of the directory is refused', async (t: TestContext) => {
  const { handlers, dir } = await fixture(t)
  // The containment guard every arm of this store shares. A name is used
  // verbatim as a filename here — that is load-bearing, because 13 of 18 real
  // book names change under `toId` — so the one thing that must not be verbatim
  // is a name that leaves the directory.
  //
  // The control matters as much as the refusal: the target has to be a file
  // that **exists**, or a passing test would only prove that deleting nothing
  // deletes nothing. `characters/aria.json` is written by the fixture.
  const outside = join(dir, 'characters', 'aria.json')
  assert.equal(existsSync(outside), true, 'the fixture did not write the file this test aims at')
  await assert.rejects(handlers['worldbook.delete']({ name: '../characters/aria' }), /identifier/u)
  assert.equal(existsSync(outside), true, 'a traversal deleted a file outside worlds/')
})

test('a host with no book store refuses rather than answering false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-wb-delete-bare-'))
  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'm' })
  const handlers = new IrisAppService({
    stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } as never,
    library,
    chats: new ChatStore(join(dir, 'chats'), library),
    settings,
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  /*
   * The line `worldbook.create` draws, for the same reason: such a host has no
   * books at all, so `false` — which here means "no book had that name" — would
   * be indistinguishable from the same answer on a host that keeps books. The
   * two lead to different repairs.
   */
  await assert.rejects(handlers['worldbook.delete']({ name: 'Own' }), /Own/u)
})
