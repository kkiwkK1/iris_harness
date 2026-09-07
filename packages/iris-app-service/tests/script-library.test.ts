import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { UserScript } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { ScriptLibraryStore } from '../src/script-library.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The user's own script library.
 *
 * TavernHelper's 脚本库: two repositories, a global one that runs everywhere and
 * one per character. What is pinned here is the storage round trip, the two
 * defaults that are safety decisions rather than conveniences, and — the part
 * that matters most — that a library script reaches the page through the
 * **same** two calls a card script does, so it cannot end up outside the
 * consent question, the run-state reporting or the switch that governs a card's.
 *
 * Field names and defaults come from the 酒馆助手 4.9.1 source on this machine
 * (`data/default-user/extensions/JS-Slash-Runner/src/type/scripts.ts:18-33`),
 * not from documentation.
 */

/** A card carrying two scripts of its own, so the merge has all three sources. */
function cardFile(): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria', description: '', personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [], tags: [],
      creator: '', character_version: '1',
      extensions: {
        TavernHelper_scripts: [
          {
            type: 'script',
            id: 'card-script',
            name: 'the card’s own',
            content: '// from the card\n',
            enabled: true,
            button: { enabled: true, buttons: [] },
          },
        ],
      },
    },
  })
}

/** A stream that answers with one fixed text. */
function scriptedStream(): StreamFn {
  return async function* (_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A host over a throwaway folder, with a library and a policy store. */
async function fixture(t: TestContext): Promise<{
  dir: string
  handlers: Handlers
  library: ScriptLibraryStore
  policy: ScriptPolicyStore
}> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-script-library-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')

  const characters = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const library = new ScriptLibraryStore(join(dir, 'script-library.json'))
  const policy = new ScriptPolicyStore(join(dir, 'script-policy.json'))
  const chats = new ChatStore(join(dir, 'chats'), characters)
  const handlers = new IrisAppService({
    stream: scriptedStream(),
    library: characters,
    chats,
    scripts: policy,
    scriptLibrary: library,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'Traveller',
  }).handlers()

  return { dir, handlers, library, policy }
}

/** A saved script, whole, as an import file would carry it. */
const IMPORTED: UserScript = {
  type: 'script',
  id: 'from-an-install',
  name: 'imported',
  content: 'console.log(1)\n',
  info: 'notes from its author',
  enabled: true,
  button: { enabled: true, buttons: [{ name: 'go', visible: true }, { name: 'reset', visible: false }] },
  data: { counter: 3, nested: { deep: [1, 2] } },
  export_with: { data: true, button: true },
}

// ── the store ───────────────────────────────────────────────────────────────

test('a script round-trips whole, including the fields no control edits', async (t) => {
  const { library } = await fixture(t)
  const { id: _id, enabled: _enabled, ...editable } = IMPORTED
  const id = await library.save('global', undefined, { ...editable, name: IMPORTED.name, content: IMPORTED.content })
  const read = await library.read('global', undefined, id)

  // `data` is the script's variable table and `export_with` is its author's
  // export choice. Neither has a field in this shell, and both have to survive
  // an edit — otherwise the export half of the migration cycle strips them.
  assert.deepEqual(read.data, IMPORTED.data, 'the variable table was dropped by a save')
  assert.deepEqual(read.export_with, IMPORTED.export_with, 'the export choice was dropped by a save')
  assert.deepEqual(read.button, IMPORTED.button, 'the button table did not round-trip')
  assert.equal(read.info, IMPORTED.info)
  assert.equal(read.type, 'script', 'the discriminator upstream’s schema requires is missing')
})

test('an edit that carries none of them keeps the fields no control edits', async (t) => {
  const { library } = await fixture(t)
  const { id: _id, enabled: _enabled, ...imported } = IMPORTED
  const id = await library.save('global', undefined, {
    ...imported, name: IMPORTED.name, content: IMPORTED.content,
  })

  /*
   * The **editor-shaped** save, which is the one that can lose something: the
   * form renders name, note, body and buttons, so those are all it sends, and
   * every other key has to come from the stored record underneath.
   *
   * The round-trip case above does not cover this and looked as though it did:
   * its save hands `data` and `export_with` straight back in, so it passes
   * against an implementation that rebuilds the record from the request alone.
   * Found by deleting `...previous` from `save` and watching it stay green.
   */
  await library.save('global', undefined, {
    id,
    name: 'renamed',
    content: 'a new body\n',
    info: 'a new note',
    button: { enabled: false, buttons: [] },
  })

  const read = await library.read('global', undefined, id)
  assert.equal(read.name, 'renamed')
  assert.equal(read.content, 'a new body\n')
  assert.deepEqual(read.data, IMPORTED.data, 'an ordinary edit erased the variable table')
  assert.deepEqual(read.export_with, IMPORTED.export_with, 'an ordinary edit erased the export choice')
  // And what the form did send replaces rather than merges: a save that merged
  // the button table would make a removed button impossible to remove.
  assert.deepEqual(read.button, { enabled: false, buttons: [] })
  assert.equal(read.info, 'a new note')
})

test('a saved script arrives switched off, and an edit does not re-answer that', async (t) => {
  const { library } = await fixture(t)
  const id = await library.save('global', undefined, { name: 'fresh', content: 'x' })
  assert.equal((await library.read('global', undefined, id)).enabled, false,
    'a script began running because someone pressed Save')

  await library.setEnabled('global', undefined, id, true)
  // The edit carries no `enabled`, so the stored answer must win over the
  // default. A save that re-applied the default would switch off a script the
  // user had switched on, every time they fixed a typo in it.
  await library.save('global', undefined, { id, name: 'fresh', content: 'y' })
  assert.equal((await library.read('global', undefined, id)).enabled, true,
    'editing a running script switched it off')
})

test('an edit whose target has gone is refused rather than becoming a create', async (t) => {
  const { library } = await fixture(t)
  await assert.rejects(
    library.save('global', undefined, { id: 'never-existed', name: 'x', content: '' }),
    /never-existed/,
  )
  assert.deepEqual(await library.views(), [], 'the refused edit was stored as a new script')
})

test('the two repositories are separate stores, and the scope must match the id', async (t) => {
  const { library } = await fixture(t)
  await library.save('global', undefined, { name: 'everywhere', content: '' })
  await library.save('character', 'aria', { name: 'just aria', content: '' })

  assert.deepEqual((await library.views()).map(row => row.name), ['everywhere'],
    'a global listing carried a character’s scripts')
  assert.deepEqual((await library.views('aria')).map(row => row.name), ['everywhere', 'just aria'],
    'a character listing is not global-then-character, which is run order')
  assert.deepEqual((await library.views('someone-else')).map(row => row.name), ['everywhere'])

  // Refused rather than ignored: a caller sending a character id with a global
  // write believes the write is scoped, and a store that dropped the id would
  // put the script in every conversation while the panel said otherwise.
  await assert.rejects(library.save('global', 'aria', { name: 'x', content: '' }), /no character id/)
  await assert.rejects(library.save('character', undefined, { name: 'x', content: '' }), /needs a character id/)
})

test('a listing reports UTF-8 bytes, not UTF-16 code units', async (t) => {
  const { library } = await fixture(t)
  // Three-byte characters. `String.length` would report 4 where the body is 12
  // bytes, and this number is shown to someone deciding whether to run it.
  const id = await library.save('global', undefined, { name: 'cjk', content: '状态栏更' })
  const row = (await library.views()).find(entry => entry.id === id)
  assert.equal(row?.bytes, 12, 'the size is being measured in code units')
})

test('a character’s repository is dropped when the character is deleted', async (t) => {
  const { library } = await fixture(t)
  await library.save('character', 'aria', { name: 'aria’s', content: '' })
  await library.forget('aria')
  assert.deepEqual(await library.views('aria'), [],
    'a reused character id would inherit the previous card’s scripts — arbitrary code')
})

test('an install that never stored a library reads as empty, and asking does not create the file', async (t) => {
  const { dir, library } = await fixture(t)
  assert.deepEqual(await library.views(), [])
  await assert.rejects(readFile(join(dir, 'script-library.json'), 'utf8'), /ENOENT/,
    'a read wrote the file, so “the user has no scripts” and “the store was touched” look alike')
})

test('the library survives a restart of the host', async (t) => {
  const { dir, library } = await fixture(t)
  await library.save('global', undefined, { name: 'kept', content: 'body' })
  const reloaded = new ScriptLibraryStore(join(dir, 'script-library.json'))
  assert.deepEqual((await reloaded.views()).map(row => row.name), ['kept'])
})

// ── the wire surface, and the one run path ──────────────────────────────────

test('script.list answers with all three sources, each naming its own, in run order', async (t) => {
  const { handlers, library } = await fixture(t)
  await library.save('global', undefined, { name: 'mine, everywhere', content: 'a' })
  await library.save('character', 'aria', { name: 'mine, aria', content: 'b' })

  const listed = await handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(
    listed.scripts.map(row => row.source),
    ['global', 'card', 'character'],
    'the merged list is not global → card → this character, which is the order they run in',
  )
  // The premise, asserted: without a card script in the middle this case would
  // pass on a list that had simply concatenated two library halves.
  assert.equal(
    listed.scripts.filter(row => row.source === 'card').length,
    1,
    'the fixture card no longer carries a script, so the middle of the order is untested',
  )
  // `enabledByCard` on a library row is `true` as a statement: there is no card
  // author to disagree with. A `false` would make the panel hide the toggle on
  // the user's own script and explain it as the card's decision.
  for (const row of listed.scripts.filter(entry => entry.source !== 'card')) {
    assert.equal(row.enabledByCard, true, `${row.name} reports the card switched it off`)
  }
})

test('a library script’s body comes down the same call a card script’s does', async (t) => {
  const { handlers, library } = await fixture(t)
  const id = await library.save('global', undefined, { name: 'mine', content: 'const x = 1\n' })
  await library.setEnabled('global', undefined, id, true)

  // The same method, the same character, distinguished only by `source`. This
  // is what makes the library one run path with the card's rather than two.
  const mine = await handlers['script.body']({ characterId: 'aria', scriptId: id, source: 'global' })
  assert.equal(mine.content, 'const x = 1\n')
  const theirs = await handlers['script.body']({ characterId: 'aria', scriptId: 'card-script' })
  assert.equal(theirs.content, '// from the card\n')
})

test('a switched-off library script’s body is refused, so the switch is not advisory', async (t) => {
  const { handlers, library } = await fixture(t)
  const id = await library.save('global', undefined, { name: 'mine', content: 'x' })
  await assert.rejects(
    handlers['script.body']({ characterId: 'aria', scriptId: id, source: 'global' }),
    /switched off/,
  )
})

test('an id is resolved in the repository the caller named, never searched for', async (t) => {
  const { handlers, library } = await fixture(t)
  // A library script deliberately given the *card* script's id. Upstream keeps
  // its three repositories' ids unique by re-minting on collision, but a card's
  // ids belong to the card author and cannot be re-minted here — so a lookup
  // that searched would resolve this by running the wrong body.
  const id = await library.save('global', undefined, { name: 'collides', content: 'from the library\n' })
  await library.setEnabled('global', undefined, id, true)

  // The card's id, asked for with no source: the card's body, as before.
  const card = await handlers['script.body']({ characterId: 'aria', scriptId: 'card-script' })
  assert.equal(card.content, '// from the card\n')
  // And the same id asked for in the global repository is a refusal rather than
  // the card's body — the routing is by name, so a miss is a miss.
  await assert.rejects(
    handlers['script.body']({ characterId: 'aria', scriptId: 'card-script', source: 'global' }),
    /card-script/,
  )
})

test('a library script’s switch is written to the library, a card script’s to the policy', async (t) => {
  const { handlers, library, dir } = await fixture(t)
  const id = await library.save('global', undefined, { name: 'mine', content: 'x' })

  const afterMine = await handlers['script.setEnabled']({
    characterId: 'aria', scriptId: id, enabled: true, source: 'global',
  })
  assert.equal(afterMine.scripts.find(row => row.id === id)?.enabled, true)
  const policyFile = await readFile(join(dir, 'script-policy.json'), 'utf8').catch(() => '{}')
  assert.doesNotMatch(policyFile, new RegExp(id),
    'a library script’s switch landed in the policy file, where a reused character id would inherit it')

  const afterCard = await handlers['script.setEnabled']({
    characterId: 'aria', scriptId: 'card-script', enabled: false,
  })
  assert.equal(afterCard.scripts.find(row => row.id === 'card-script')?.enabled, false)
  // And the card's own flag is untouched, which is the whole point of two
  // switches: a re-import must not revive a script the user turned off.
  assert.equal(afterCard.scripts.find(row => row.id === 'card-script')?.enabledByCard, true)
})

test('a host with no library refuses every library method rather than answering empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-no-library-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), cardFile(), 'utf8')
  const characters = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const handlers = new IrisAppService({
    stream: scriptedStream(),
    library: characters,
    chats: new ChatStore(join(dir, 'chats'), characters),
    // A policy store but no library, which is the composition this test is
    // about. Without the policy store the host lists no card scripts either,
    // and the last assertion below would pass on an empty list for the wrong
    // reason — the two stores would look folded together because *both* were
    // missing.
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
  }).handlers()

  // An empty listing under a panel with live controls would let someone type a
  // script, press Save, and be told nothing about where it went.
  await assert.rejects(handlers['scriptLibrary.list']({}), /no script library/)
  await assert.rejects(
    handlers['scriptLibrary.save']({ scope: 'global', script: { name: 'x', content: '' } }),
    /no script library/,
  )
  // `script.list` still answers, because the card's scripts are a different
  // store's business: folding the two together would hide a card's scripts on a
  // host that merely has no library.
  const listed = await handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(listed.scripts.map(row => row.source), ['card'])
})
