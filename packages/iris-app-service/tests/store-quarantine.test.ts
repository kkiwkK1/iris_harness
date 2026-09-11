import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CardStorageStore } from '../src/card-storage.ts'
import { ChatOrderStore } from '../src/chat-order.ts'
import { ConnectionStore } from '../src/connections.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { FavoriteStore } from '../src/favorites.ts'
import { WorldbookBindingStore } from '../src/materialise.ts'
import { PersonaStore } from '../src/persona.ts'
import { ScriptButtonStore } from '../src/script-buttons.ts'
import { ScriptLibraryStore } from '../src/script-library.ts'
import { ScriptVariableStore } from '../src/script-variables.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Every JSON store in this package, held to one rule about a file it cannot read.
 *
 * **The incident this is about.** Each of these stores treated a parse failure
 * the way it treated a missing file: keep the defaults, say nothing. The next
 * `save()` — which for most of them is the very next thing the user does — then
 * wrote the degraded in-memory state over the original bytes. One corrupted
 * write therefore zeroed the settings, the connection profiles *with their API
 * keys*, and the consent records, with no `.bak` anywhere and no report. The
 * recovery is the same as before (start from defaults, because a store that
 * refused to start would take the UI that fixes it down with it); what changed
 * is that the bytes are renamed out of the way first and the fact is reported.
 *
 * **Why one parametrised test and not twelve.** The rule is a property of the
 * *set*, and the failure mode worth catching is a store added later that does
 * not have it — which no per-store test can ever notice. So the table below is
 * the population, and {@link COVERED} is asserted as a floor: adding a store
 * without a row here does not go red, but removing a row does, and a reader who
 * adds a store and runs this suite is told the number they have to move.
 *
 * The four assertions per store are the four halves of the rule that can each
 * fail on their own: the quarantined copy exists **and holds the original
 * bytes** (a copy of the defaults would satisfy a weaker check), the store is at
 * its defaults in memory, exactly one report names the path, and a later save
 * writes a *new* file without touching what was set aside.
 */

/** One store's row: how to build it, how to read it, how to make it save. */
interface StoreCase {
  /** What the store is called, for the assertion messages. */
  readonly name: string
  /** The file it is backed by, relative to the scratch directory. */
  readonly file: string
  /**
   * Construct it, wired to report through `onProblem`.
   *
   * Typed as `object` because the twelve stores share no interface — they are a
   * population, not a hierarchy, and inventing a base class to make this
   * signature prettier would add a real abstraction for a test's convenience.
   */
  readonly open: (path: string, onProblem: (message: string) => void) => object
  /** Read something from it, and answer what the defaults should look like. */
  readonly read: (store: never) => Promise<unknown>
  /** What {@link read} must answer when the file could not be used. */
  readonly fallback: unknown
  /** Write something, so the store persists its degraded state. */
  readonly write: (store: never) => Promise<unknown>
}

/**
 * How many stores carry the rule.
 *
 * A floor, not an equality: a thirteenth store added with a row here is a green
 * run and a number to bump, while a row deleted is a red one. The number that
 * would be wrong to write is `assert.equal(cases.length, 12)` — that fails on
 * the *good* change and passes on the bad one.
 */
const COVERED = 12

const cases: readonly StoreCase[] = [
  {
    name: 'SettingsStore',
    file: 'settings.json',
    open: (path, onProblem) =>
      new SettingsStore(path, { provider: 'default', model: 'local-model' }, onProblem),
    read: async (store: SettingsStore) => { await store.load(); return store.get().model },
    fallback: 'local-model',
    write: async (store: SettingsStore) => store.set(undefined, { model: 'after' }),
  },
  {
    name: 'ConnectionStore',
    file: 'connections.json',
    open: (path, onProblem) => new ConnectionStore(path, onProblem),
    read: async (store: ConnectionStore) => (await store.list()).profiles.length,
    fallback: 0,
    write: async (store: ConnectionStore) => store.save({ provider: 'p', model: 'm' }),
  },
  {
    name: 'ScriptPolicyStore',
    file: 'script-policy.json',
    open: (path, onProblem) => new ScriptPolicyStore(path, onProblem),
    read: async (store: ScriptPolicyStore) => store.scriptsAllowed('aria'),
    fallback: undefined,
    write: async (store: ScriptPolicyStore) => store.setScriptsAllowed('aria', true),
  },
  {
    name: 'ScriptLibraryStore',
    file: 'script-library.json',
    open: (path, onProblem) => new ScriptLibraryStore(path, onProblem),
    read: async (store: ScriptLibraryStore) => (await store.views()).length,
    fallback: 0,
    write: async (store: ScriptLibraryStore) =>
      store.save('global', undefined, { name: 'n', content: 'c' }),
  },
  {
    name: 'PersonaStore',
    file: 'personas.json',
    open: (path, onProblem) => new PersonaStore(path, onProblem),
    read: async (store: PersonaStore) => (await store.list()).personas.length,
    fallback: 0,
    write: async (store: PersonaStore) => store.upsert({ name: 'me', description: 'd' }),
  },
  {
    name: 'FavoriteStore',
    file: 'favorites.json',
    open: (path, onProblem) => new FavoriteStore(path, onProblem),
    read: async (store: FavoriteStore) => (await store.list()).length,
    fallback: 0,
    write: async (store: FavoriteStore) => store.set('aria', true),
  },
  {
    name: 'ChatOrderStore',
    file: 'chat-order.json',
    open: (path, onProblem) => new ChatOrderStore(path, onProblem),
    read: async (store: ChatOrderStore) => (await store.list()).length,
    fallback: 0,
    write: async (store: ChatOrderStore) => store.set(['a', 'b']),
  },
  {
    name: 'CardStorageStore',
    file: 'card-storage.json',
    open: (path, onProblem) => new CardStorageStore(path, () => {}, onProblem),
    read: async (store: CardStorageStore) => Object.keys(await store.snapshot()).length,
    fallback: 0,
    write: async (store: CardStorageStore) => {
      await store.set('k', 'v', { characterId: 'aria' })
      await store.flush()
    },
  },
  {
    name: 'ScriptVariableStore',
    file: 'script-variables.json',
    open: (path, onProblem) => new ScriptVariableStore(path, () => {}, onProblem),
    read: async (store: ScriptVariableStore) =>
      Object.keys(await store.open('aria', undefined)).length,
    fallback: 0,
    write: async (store: ScriptVariableStore) => {
      const tables = await store.open('aria', undefined)
      store.backendFor(tables).write({ type: 'script', script_id: 's' }, { hp: 1 })
      await store.settled()
    },
  },
  {
    name: 'ScriptButtonStore',
    file: 'script-buttons.json',
    open: (path, onProblem) => new ScriptButtonStore(path, () => {}, onProblem),
    read: async (store: ScriptButtonStore) => Object.keys(await store.all('aria')).length,
    fallback: 0,
    write: async (store: ScriptButtonStore) =>
      store.set('aria', 's', [{ name: 'go', visible: true }]),
  },
  {
    name: 'ExtensionSettingsStore',
    file: 'extension-settings.json',
    open: (path, onProblem) => new ExtensionSettingsStore(path, onProblem),
    read: async (store: ExtensionSettingsStore) => Object.keys(await store.get('aria')).length,
    fallback: 0,
    write: async (store: ExtensionSettingsStore) => store.set('aria', { seen: true }),
  },
  {
    name: 'WorldbookBindingStore',
    file: 'worldbook-bindings.json',
    open: (path, onProblem) => new WorldbookBindingStore(path, () => {}, onProblem),
    read: async (store: WorldbookBindingStore) => Object.keys(await store.all()).length,
    fallback: 0,
    write: async (store: WorldbookBindingStore) => store.set('aria', {
      name: 'aria-book', sourceHash: 'a', materialisedHash: 'b', origin: 'minted', at: 1,
    }),
  },
]

/** Bytes that are unmistakably a real file and unmistakably not JSON. */
const CORRUPT = '{"profiles":[{"id":"a","apiKey":"sk-live-'

test('every JSON store covered here quarantines a file it cannot parse', async (t) => {
  assert.ok(cases.length >= COVERED,
    `a store lost its quarantine row: ${String(cases.length)} covered, ${String(COVERED)} required`)

  for (const subject of cases) {
    await t.test(subject.name, async (inner) => {
      const dir = await mkdtemp(join(tmpdir(), 'iris-quarantine-'))
      inner.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
      const path = join(dir, subject.file)
      await writeFile(path, CORRUPT, 'utf8')

      const said: string[] = []
      const store = subject.open(path, message => { said.push(message) })

      // 1. The defaults are in memory — the recovery is unchanged.
      assert.deepEqual(await (subject.read as (s: object) => Promise<unknown>)(store),
        subject.fallback, `${subject.name} did not fall back to its defaults`)

      // 2. Exactly one report, and it names the file.
      assert.equal(said.length, 1, `${subject.name} was silent about a corrupt file`)
      assert.ok(said[0]?.includes(path), `${subject.name}'s report does not name the file`)

      // 3. The original bytes are set aside, verbatim, under a name no store writes.
      const quarantined = (await readdir(dir)).filter(name => name.includes('.corrupt-'))
      assert.equal(quarantined.length, 1, `${subject.name} did not set the file aside`)
      const kept = join(dir, quarantined[0] ?? '')
      assert.equal(await readFile(kept, 'utf8'), CORRUPT,
        `${subject.name} set aside something other than the original bytes`)
      assert.equal(existsSync(path), false,
        `${subject.name} left the unparsable bytes where its next save lands`)

      // 4. The next save writes a new file and leaves the quarantine alone —
      //    which is the whole point, and the assertion that would have gone red
      //    on every one of these stores before 2026-09-11.
      await (subject.write as (s: object) => Promise<unknown>)(store)
      assert.equal(existsSync(path), true, `${subject.name} did not write a new file`)
      assert.notEqual(await readFile(path, 'utf8'), CORRUPT)
      assert.equal(await readFile(kept, 'utf8'), CORRUPT,
        `${subject.name}'s save wrote over the quarantined copy`)
      assert.equal((await readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0,
        `${subject.name}'s save left a temporary behind`)
    })
  }
})

test('the composition hands every quarantining store the report channel', async () => {
  // **Wiring, and structural on purpose, for the reason `config-wiring.test.ts`
  // gives about the pruning options it was written for: giving a store an
  // `onProblem` and passing it one are two edits in two files, and the tests
  // above construct the stores themselves, so they exercise the reporting
  // perfectly while saying nothing about whether the host ever asks for it. A
  // store composed without the callback quarantines correctly and in silence,
  // which is a failure with no behaviour to observe from inside this package.
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const unwired: string[] = []
  for (const subject of cases) {
    const start = source.indexOf(`new ${subject.name}(`)
    if (start === -1) {
      // Not every store here is constructed by this composition, and that is
      // allowed — what is not allowed is constructing one without the channel.
      continue
    }
    let depth = 0
    let end = start
    for (; end < source.length; end += 1) {
      const char = source[end]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (!source.slice(start, end).includes('reportStoreProblem')) unwired.push(subject.name)
  }
  assert.deepEqual(unwired, [],
    'composed without the report channel, so its quarantine would happen in silence')
})

test('a first run is not reported and nothing is set aside', async (t) => {
  // The other direction of the same rule, and the one that goes red if a store
  // starts treating "no file" as a problem: every profile's first run would then
  // open with twelve faults on the debug page.
  for (const subject of cases) {
    const dir = await mkdtemp(join(tmpdir(), 'iris-quarantine-fresh-'))
    t.after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) })
    const path = join(dir, subject.file)

    const said: string[] = []
    const store = subject.open(path, message => { said.push(message) })
    await (subject.read as (s: object) => Promise<unknown>)(store)
    assert.deepEqual(said, [], `${subject.name} reported a first run as a problem`)
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.corrupt-')), [],
      `${subject.name} quarantined a file that was never there`)
  }
})
