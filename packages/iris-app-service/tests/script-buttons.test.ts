import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { effectiveButtons, ScriptButtonStore } from '../src/script-buttons.ts'
import { ScriptPolicyStore } from '../src/scripts.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Buttons a script rewrote at runtime.
 *
 * Upstream keeps them **in the card file**: `replaceScriptButtons` assigns
 * `script.button.buttons` and a deep watcher on the character settings store
 * writes the card immediately. This host does not put runtime state in a shared
 * card file — the ruling that moved `script.data` out — so the card's table is
 * a **seed** and the override lives beside the installation.
 *
 * The consequence worth knowing, and it is a real cost rather than a detail: a
 * card exported back to SillyTavern carries what it declared, not what a script
 * rearranged. Recorded in `notes/packages/iris-app-service/DEVIATIONS.md` so it is met on purpose.
 */

const BUTTONS = [{ name: '显示', visible: true }, { name: '隐藏', visible: false }]

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1',
    extensions: {
      tavern_helper: {
        scripts: [{
          id: 'panel', name: 'Panel', type: 'script', enabled: true, content: 'noop()',
          button: { enabled: true, buttons: BUTTONS },
        }],
      },
    },
  },
})

interface Fixture {
  handlers: Handlers
  chatId: string
  dir: string
}

async function fixture(t: TestContext, withStore = true): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-btn-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* () { yield { type: 'finish', reason: { kind: 'stop' } } }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: () => {},
    userName: 'U',
    // Needed for `script.list` to answer at all — without it the handler
    // returns an empty list, and a test asserting on `scripts[0]` would have
    // been comparing against `undefined` rather than against a wrong merge.
    scripts: new ScriptPolicyStore(join(dir, 'script-policy.json')),
    ...withStore ? { scriptButtons: new ScriptButtonStore(join(dir, 'script-buttons.json')) } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chatId: created.view.chatId, dir }
}

const seen = async (fixed: Fixture): Promise<{ name: string, visible: boolean }[] | undefined> => {
  const { context } = await fixed.handlers['script.context']({
    chatId: fixed.chatId, characterId: 'aria',
  })
  return context.scriptButtons?.['panel']
}

test('with no override, a script sees exactly what its card declared', async (t) => {
  const fixed = await fixture(t)
  assert.deepEqual(await seen(fixed), BUTTONS)
})

test('a replace overrides the declaration, whole-table', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.replaceScriptButtons']({
    characterId: 'aria', scriptId: 'panel',
    buttons: [{ name: '只剩这个', visible: true }],
  })

  // Whole-table, not merged by name. Upstream's writer assigns the array it is
  // given, so a declared button the script left out is meant to be gone —
  // merging the declaration back in would resurrect precisely what it removed,
  // and the script would keep seeing a button it had deleted.
  assert.deepEqual(await seen(fixed), [{ name: '只剩这个', visible: true }])
})

test('a hidden button survives the round trip — visible is data, not a filter', async (t) => {
  const fixed = await fixture(t)

  await fixed.handlers['script.replaceScriptButtons']({
    characterId: 'aria', scriptId: 'panel',
    buttons: [{ name: 'a', visible: false }, { name: 'b', visible: true }],
  })

  // `visible: false` means "do not render", not "do not store". A script flips
  // it to reveal a button, which it can only do if the hidden one came back.
  assert.deepEqual(await seen(fixed), [{ name: 'a', visible: false }, { name: 'b', visible: true }])
})

test('the override outlives the process, because the card file is untouched', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.replaceScriptButtons']({
    characterId: 'aria', scriptId: 'panel', buttons: [{ name: 'kept', visible: true }],
  })

  // A second store over the same file, which is what a restart looks like.
  const reopened = new ScriptButtonStore(join(fixed.dir, 'script-buttons.json'))
  assert.deepEqual(await reopened.get('aria', 'panel'), [{ name: 'kept', visible: true }])

  // And the card itself is unchanged — the whole reason the override exists.
  const onDisk = JSON.parse(
    await (await import('node:fs/promises')).readFile(join(fixed.dir, 'characters', 'aria.json'), 'utf8'),
  ) as { data: { extensions: { tavern_helper: { scripts: { button: { buttons: unknown } }[] } } } }
  assert.deepEqual(
    onDisk.data.extensions.tavern_helper.scripts[0]?.button.buttons,
    BUTTONS,
    'the card file was rewritten — the ruling this store exists for was broken',
  )
})

test('a script the card does not declare is refused', async (t) => {
  const fixed = await fixture(t)

  // An override for an unknown id would be state nothing can ever read — the
  // snapshot only carries declared ids — while looking like it succeeded.
  await assert.rejects(
    () => fixed.handlers['script.replaceScriptButtons']({
      characterId: 'aria', scriptId: 'not-declared', buttons: [],
    }),
    /declares no script/u,
  )
})

test('with no store the write is refused, not silently dropped', async (t) => {
  const fixed = await fixture(t, false)

  await assert.rejects(
    () => fixed.handlers['script.replaceScriptButtons']({
      characterId: 'aria', scriptId: 'panel', buttons: [],
    }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

test('one card cannot see another card’s overrides', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-btn-part-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const store = new ScriptButtonStore(join(dir, 'script-buttons.json'))

  await store.set('aria', 'panel', [{ name: 'aria only', visible: true }])
  await store.set('other', 'panel', [{ name: 'other only', visible: true }])

  assert.deepEqual(await store.get('aria', 'panel'), [{ name: 'aria only', visible: true }])
  assert.deepEqual(await store.get('other', 'panel'), [{ name: 'other only', visible: true }])
  assert.equal(await store.get('never-seen', 'panel'), undefined, 'an unknown card inherited something')

  // Detached on the way out, so scribbling changes nothing.
  const held = await store.get('aria', 'panel')
  held?.push({ name: 'injected', visible: true })
  assert.equal((await store.get('aria', 'panel'))?.length, 1)

  await store.forget('aria')
  assert.equal(await store.get('aria', 'panel'), undefined)
  assert.deepEqual(await store.get('other', 'panel'), [{ name: 'other only', visible: true }])
})

test('an empty override is a real state, not an absent one', () => {
  // A script may legitimately remove every button. `[]` must win over the
  // declaration; treating it as "nothing stored" would bring the whole declared
  // table back and undo the removal silently.
  assert.deepEqual(effectiveButtons(BUTTONS, []), [])
  assert.deepEqual(effectiveButtons(BUTTONS, undefined), BUTTONS)
  assert.equal(effectiveButtons(undefined, undefined), undefined)
})

test('the bar and the snapshot never disagree — both read the same merge', async (t) => {
  const fixed = await fixture(t)

  const before = await fixed.handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(before.scripts[0]?.buttons, BUTTONS, 'the list starts from the declaration')

  await fixed.handlers['script.replaceScriptButtons']({
    characterId: 'aria', scriptId: 'panel',
    buttons: [{ name: 'after', visible: true }],
  })

  // Two read paths, one fact. `ScriptView.buttons` feeds the panel's bar and
  // `ScriptContext.scriptButtons` feeds the card; if only the snapshot merged,
  // the bar would keep offering a button the script had already replaced — each
  // side correct on its own terms and disagreeing with the other, which is the
  // failure nobody can attribute.
  const after = await fixed.handlers['script.list']({ characterId: 'aria' })
  assert.deepEqual(after.scripts[0]?.buttons, [{ name: 'after', visible: true }])
  assert.deepEqual(await seen(fixed), after.scripts[0]?.buttons)
})
