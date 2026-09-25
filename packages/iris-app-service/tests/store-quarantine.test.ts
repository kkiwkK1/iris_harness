import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
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
import { tempDir } from './support/temp-dir.ts'

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
  /**
   * The concurrent first-use probe's half of the row: a `prior` write (made
   * through a first store over the file, so the seed is in the store's own
   * shape) and a `probe` that answers, from one store's memory, whether both
   * the prior write and {@link write} are there. Or the reason a store is
   * exempt — which the test pins by name, so an exemption cannot grow quietly.
   */
  readonly firstUse:
    | {
      readonly prior: (store: never) => Promise<unknown>
      readonly probe: (store: never) => Promise<Record<string, boolean>>
    }
    | { readonly exempt: string }
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

/**
 * How many stores the concurrent first-use probe actually compares — the same
 * kind of floor, asserted on the compared count, so a row that slides into
 * `exempt` (or a probe that stops running) goes red instead of green.
 */
const COVERED_FIRST_USE = 11

const cases: readonly StoreCase[] = [
  {
    name: 'SettingsStore',
    file: 'settings.json',
    open: (path, onProblem) =>
      new SettingsStore(path, { provider: 'default', model: 'local-model' }, onProblem),
    read: async (store: SettingsStore) => { await store.load(); return store.get().model },
    fallback: 'local-model',
    write: async (store: SettingsStore) => store.set(undefined, { model: 'after' }),
    firstUse: {
      exempt: 'not lazy: the composition awaits `settings.load()` at boot, before any handler is registered',
    },
  },
  {
    name: 'ConnectionStore',
    file: 'connections.json',
    open: (path, onProblem) => new ConnectionStore(path, onProblem),
    read: async (store: ConnectionStore) => (await store.list()).profiles.length,
    fallback: 0,
    write: async (store: ConnectionStore) => store.save({ provider: 'p', model: 'm' }),
    firstUse: {
      prior: async (store: ConnectionStore) => store.save({ provider: 'p0', model: 'm0' }),
      probe: async (store: ConnectionStore) => {
        const providers = (await store.list()).profiles.map(profile => profile.provider)
        return { prior: providers.includes('p0'), written: providers.includes('p') }
      },
    },
  },
  {
    name: 'ScriptPolicyStore',
    file: 'script-policy.json',
    open: (path, onProblem) => new ScriptPolicyStore(path, onProblem),
    read: async (store: ScriptPolicyStore) => store.scriptsAllowed('aria'),
    fallback: undefined,
    write: async (store: ScriptPolicyStore) => store.setScriptsAllowed('aria', true),
    firstUse: {
      prior: async (store: ScriptPolicyStore) => store.setScriptsAllowed('prior', true),
      probe: async (store: ScriptPolicyStore) => ({
        prior: await store.scriptsAllowed('prior') === true,
        written: await store.scriptsAllowed('aria') === true,
      }),
    },
  },
  {
    name: 'ScriptLibraryStore',
    file: 'script-library.json',
    open: (path, onProblem) => new ScriptLibraryStore(path, onProblem),
    read: async (store: ScriptLibraryStore) => (await store.views()).length,
    fallback: 0,
    write: async (store: ScriptLibraryStore) =>
      store.save('global', undefined, { name: 'n', content: 'c' }),
    firstUse: {
      prior: async (store: ScriptLibraryStore) =>
        store.save('global', undefined, { name: 'prior', content: 'c' }),
      probe: async (store: ScriptLibraryStore) => {
        const names = (await store.views()).map(view => view.name)
        return { prior: names.includes('prior'), written: names.includes('n') }
      },
    },
  },
  {
    name: 'PersonaStore',
    file: 'personas.json',
    open: (path, onProblem) => new PersonaStore(path, onProblem),
    read: async (store: PersonaStore) => (await store.list()).personas.length,
    fallback: 0,
    write: async (store: PersonaStore) => store.upsert({ name: 'me', description: 'd' }),
    firstUse: {
      prior: async (store: PersonaStore) => store.upsert({ name: 'prior', description: 'd' }),
      probe: async (store: PersonaStore) => {
        const names = (await store.list()).personas.map(persona => persona.name)
        return { prior: names.includes('prior'), written: names.includes('me') }
      },
    },
  },
  {
    name: 'FavoriteStore',
    file: 'favorites.json',
    open: (path, onProblem) => new FavoriteStore(path, onProblem),
    read: async (store: FavoriteStore) => (await store.list()).length,
    fallback: 0,
    write: async (store: FavoriteStore) => store.set('aria', true),
    firstUse: {
      prior: async (store: FavoriteStore) => store.set('prior', true),
      probe: async (store: FavoriteStore) => {
        const ids = await store.list()
        return { prior: ids.includes('prior'), written: ids.includes('aria') }
      },
    },
  },
  {
    name: 'ChatOrderStore',
    file: 'chat-order.json',
    open: (path, onProblem) => new ChatOrderStore(path, onProblem),
    read: async (store: ChatOrderStore) => (await store.list()).length,
    fallback: 0,
    write: async (store: ChatOrderStore) => store.set(['a', 'b']),
    firstUse: {
      // `set` replaces the whole arrangement, so the prior order is *meant* to
      // be gone; what must hold is that the write is what memory and disk say.
      prior: async (store: ChatOrderStore) => store.set(['prior']),
      probe: async (store: ChatOrderStore) => ({
        written: JSON.stringify(await store.list()) === JSON.stringify(['a', 'b']),
      }),
    },
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
    firstUse: {
      prior: async (store: CardStorageStore) => {
        await store.set('prior', '1', { characterId: 'aria' })
        await store.flush()
      },
      probe: async (store: CardStorageStore) => {
        const snapshot = await store.snapshot()
        return { prior: snapshot['prior'] === '1', written: snapshot['k'] === 'v' }
      },
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
    firstUse: {
      prior: async (store: ScriptVariableStore) => {
        const tables = await store.open('prior', undefined)
        store.backendFor(tables).write({ type: 'script', script_id: 's' }, { mp: 2 })
        await store.settled()
      },
      probe: async (store: ScriptVariableStore) => ({
        prior: JSON.stringify(await store.open('prior', undefined)).includes('"mp":2'),
        written: JSON.stringify(await store.open('aria', undefined)).includes('"hp":1'),
      }),
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
    firstUse: {
      prior: async (store: ScriptButtonStore) => store.set('prior', 's', [{ name: 'p', visible: true }]),
      probe: async (store: ScriptButtonStore) => ({
        prior: (await store.get('prior', 's'))?.[0]?.name === 'p',
        written: (await store.get('aria', 's'))?.[0]?.name === 'go',
      }),
    },
  },
  {
    name: 'ExtensionSettingsStore',
    file: 'extension-settings.json',
    open: (path, onProblem) => new ExtensionSettingsStore(path, onProblem),
    read: async (store: ExtensionSettingsStore) => Object.keys(await store.get('aria')).length,
    fallback: 0,
    write: async (store: ExtensionSettingsStore) => store.set('aria', { seen: true }),
    firstUse: {
      prior: async (store: ExtensionSettingsStore) => store.set('prior', { seen: true }),
      probe: async (store: ExtensionSettingsStore) => ({
        prior: (await store.get('prior'))['seen'] === true,
        written: (await store.get('aria'))['seen'] === true,
      }),
    },
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
    firstUse: {
      prior: async (store: WorldbookBindingStore) => store.set('prior', {
        name: 'prior-book', sourceHash: 'a', materialisedHash: 'b', origin: 'minted', at: 1,
      }),
      probe: async (store: WorldbookBindingStore) => ({
        prior: (await store.get('prior'))?.name === 'prior-book',
        written: (await store.get('aria'))?.name === 'aria-book',
      }),
    },
  },
]

/** Bytes that are unmistakably a real file and unmistakably not JSON. */
const CORRUPT = '{"profiles":[{"id":"a","apiKey":"sk-live-'

test('every JSON store covered here quarantines a file it cannot parse', async (t) => {
  assert.ok(cases.length >= COVERED,
    `a store lost its quarantine row: ${String(cases.length)} covered, ${String(COVERED)} required`)

  for (const subject of cases) {
    await t.test(subject.name, async (inner) => {
      const dir = await tempDir(inner, 'iris-quarantine-')
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
    const dir = await tempDir(t, 'iris-quarantine-fresh-')
    const path = join(dir, subject.file)

    const said: string[] = []
    const store = subject.open(path, message => { said.push(message) })
    await (subject.read as (s: object) => Promise<unknown>)(store)
    assert.deepEqual(said, [], `${subject.name} reported a first run as a problem`)
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.corrupt-')), [],
      `${subject.name} quarantined a file that was never there`)
  }
})

test('a read and a write during the first load both land, in memory and on disk', async (t) => {
  // **The lost-write class this is about.** A store that set a `#loaded` flag
  // *before* awaiting its file let a second caller arriving during that read
  // return at once, mutate the empty defaults and save them; the finishing
  // load then replaced the table. Measured on FavoriteStore: memory kept the
  // prior star and lost the new one, while disk kept the new one and lost the
  // prior star. Only ConnectionStore memoised the load *promise*; the other
  // lazy stores now do too, and this is the probe over the whole population.
  //
  // Each row seeds its file through a first store (so the seed is in the
  // store's own shape), then a fresh store over the same file takes a read and
  // a write at the same moment — both inside its first load — and must answer
  // both the prior and the new write from memory, and a third store reopened
  // from disk must answer the same.
  const exempt = cases.flatMap(subject => 'exempt' in subject.firstUse ? [subject.name] : [])
  assert.deepEqual(exempt, ['SettingsStore'], 'the exemption list grew or shrank; say why in the row')

  let compared = 0
  for (const subject of cases) {
    const firstUse = subject.firstUse
    if ('exempt' in firstUse) continue
    await t.test(subject.name, async (inner) => {
      const dir = await tempDir(inner, 'iris-first-use-')
      const path = join(dir, subject.file)
      const quiet = (): void => {}

      await (firstUse.prior as (s: object) => Promise<unknown>)(subject.open(path, quiet))

      const racing = subject.open(path, quiet)
      await Promise.all([
        (subject.read as (s: object) => Promise<unknown>)(racing),
        (subject.write as (s: object) => Promise<unknown>)(racing),
      ])
      const probe = firstUse.probe as (s: object) => Promise<Record<string, boolean>>
      const inMemory = await probe(racing)
      assert.ok(Object.keys(inMemory).length > 0, `${subject.name}'s probe checks nothing`)
      assert.deepEqual(inMemory, Object.fromEntries(Object.keys(inMemory).map(key => [key, true])),
        `${subject.name} lost a write made during its first load (in memory)`)

      const onDisk = await probe(subject.open(path, quiet))
      assert.deepEqual(onDisk, inMemory, `${subject.name}'s file disagrees with its memory after the first load`)
    })
    compared += 1
  }
  assert.ok(compared >= COVERED_FIRST_USE,
    `the first-use probe compared ${String(compared)} stores, ${String(COVERED_FIRST_USE)} required`)
})
