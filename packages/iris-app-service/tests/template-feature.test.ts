import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { promptTexts } from '../src/templates.ts'

/**
 * The prompt-template feature's switch, as a first-party Iris setting.
 *
 * `templates.test.ts` owns the evaluation seam and `eval-template.test.ts` the
 * card-script contract; the claim here is about the *switch*: that the user's
 * persisted decision outranks the composition's boot default in both
 * directions, that clearing it hands the decision back, that the generation
 * path and `script.evalTemplate` cannot disagree about whether the feature is
 * on, and that the two doors share one kernel and one store — the properties
 * `notes/FEATURE-PROMPT-TEMPLATE.md` §4 defines as the difference between a
 * first-party capability and a deployment flag.
 *
 * Each of these fails silently if wrong. A switch the host reads once at boot
 * makes the setting a lie until restart; a generation path and a script path
 * reading different gates let a card render what a generation would have left
 * alone; a decision that survives nothing was never a decision.
 */

/** A card whose description carries whatever template the test needs. */
function card(description: string): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description,
      personality: '', scenario: '',
      first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: '', alternate_greetings: [],
      tags: [], creator: '', character_version: '1', extensions: {},
    },
  })
}

/** A stream that records the request it was handed and answers with one line. */
function scripted(seen: GenerateOptions[]): StreamFn {
  return async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    seen.push(options)
    const text = 'A reply.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Fixture {
  handlers: Handlers
  chatId: string
  seen: GenerateOptions[]
  errors: Error[]
  settingsPath: string
  /** Reopen the profile's settings file in a fresh store, as a restart would. */
  reopen: () => Promise<SettingsStore>
  settled: () => Promise<void>
}

/**
 * @param t - the test, for cleanup.
 * @param options - the card's description, and the composition row.
 * @returns a service over a throwaway data folder, with one chat open.
 */
async function fixture(
  t: TestContext,
  options: { description?: string, templates?: boolean } = {},
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-tplfeat-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(
    join(dir, 'characters', 'aria.json'),
    card(options.description ?? ''),
    'utf8',
  )

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const settingsPath = join(dir, 'settings.json')
  const seen: GenerateOptions[] = []
  const errors: Error[] = []
  let ends = 0
  let waited = 0

  const handlers = new IrisAppService({
    stream: scripted(seen),
    library,
    chats,
    settings: new SettingsStore(settingsPath, { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
    userName: 'Traveller',
    onError: (error: Error) => { errors.push(error) },
    // The composition row: presence is the boot default, `IRIS_TEMPLATES=1`.
    ...options.templates === true ? { templates: {} } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return {
    handlers,
    chatId: created.view.chatId,
    seen,
    errors,
    settingsPath,
    reopen: async () => {
      const store = new SettingsStore(settingsPath, { provider: 'test', model: 'test-model' })
      await store.load()
      return store
    },
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

/** The text of everything the provider was handed, joined. */
function sentText(options: GenerateOptions | undefined): string {
  return options === undefined ? '' : promptTexts(options).join('\n')
}

/** The description the provider was handed, without the surrounding prompt. */
async function sendDescription(fixed: Fixture): Promise<string> {
  await fixed.handlers['chat.send']({ chatId: fixed.chatId, text: 'How are you?' })
  await fixed.settled()
  return sentText(fixed.seen[0])
}

test('until the user decides, the view answers the composition row', async (t) => {
  const off = await fixture(t, {})
  const on = await fixture(t, { templates: true })

  assert.deepEqual(await off.handlers['template.settings']({}), {
    settings: { enabled: false, persisted: false, defaultEnabled: false },
  })
  assert.deepEqual(await on.handlers['template.settings']({}), {
    settings: { enabled: true, persisted: false, defaultEnabled: true },
  })
})

test('a persisted decision wins over the composition, in both directions', async (t) => {
  // Off over on: the user turned a feature the deployment opted into back off,
  // and the description's tag reaches the provider untouched.
  const offOverOn = await fixture(t, { description: 'Aria feels <%= 6 * 7 %> today.', templates: true })
  const silenced = await offOverOn.handlers['template.setSettings']({ enabled: false })
  assert.deepEqual(silenced, {
    settings: { enabled: false, persisted: true, defaultEnabled: true },
  })
  assert.match(await sendDescription(offOverOn), /<%= 6 \* 7 %>/u)

  // On over off: the user opted in without editing the composition, and the
  // tag is evaluated.
  const onOverOff = await fixture(t, { description: 'Aria feels <%= 6 * 7 %> today.' })
  const lit = await onOverOff.handlers['template.setSettings']({ enabled: true })
  assert.deepEqual(lit, {
    settings: { enabled: true, persisted: true, defaultEnabled: false },
  })
  const sent = await sendDescription(onOverOff)
  assert.match(sent, /Aria feels 42 today\./u)
  assert.equal(sent.includes('<%'), false, 'a template tag reached the provider')
})

test('clearing the decision hands it back to the composition', async (t) => {
  const fixed = await fixture(t, { description: 'Aria feels <%= 6 * 7 %> today.', templates: true })
  await fixed.handlers['template.setSettings']({ enabled: false })
  const cleared = await fixed.handlers['template.setSettings']({ enabled: null })

  // `null` is not `false`: the view must show the decision is *gone*, and the
  // boot default rules again — the difference the tri-state exists for.
  assert.deepEqual(cleared, {
    settings: { enabled: true, persisted: false, defaultEnabled: true },
  })
  assert.match(await sendDescription(fixed), /Aria feels 42 today\./u)
})

test('the decision is persisted, and a fresh store reads it back', async (t) => {
  const fixed = await fixture(t, {})
  await fixed.handlers['template.setSettings']({ enabled: true })

  const raw = JSON.parse(await readFile(fixed.settingsPath, 'utf8')) as {
    template?: { enabled?: boolean }
  }
  assert.equal(raw.template?.enabled, true)

  const reopened = await fixed.reopen()
  assert.equal(reopened.templateEnabled(), true)
  // Clearing is a state on disk too, not just in memory.
  await reopened.setTemplateFeature(null)
  const twice = await fixed.reopen()
  assert.equal(twice.templateEnabled(), undefined)
})

test('script.evalTemplate reads the same switch the generation path reads', async (t) => {
  // Enabled only by the persisted switch: the composition never opted in.
  const offOverOn = await fixture(t, {})
  await assert.rejects(
    () => offOverOn.handlers['script.evalTemplate']({ chatId: offOverOn.chatId, content: 'x <%= 1 %>' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
  await offOverOn.handlers['template.setSettings']({ enabled: true })
  const { text } = await offOverOn.handlers['script.evalTemplate']({
    chatId: offOverOn.chatId, content: 'x <%= 1 %>',
  })
  assert.equal(text, 'x 1')

  // Disabled by the persisted switch although the composition opted in.
  const onOverOff = await fixture(t, { templates: true })
  await onOverOff.handlers['template.setSettings']({ enabled: false })
  await assert.rejects(
    () => onOverOff.handlers['script.evalTemplate']({ chatId: onOverOff.chatId, content: 'x <%= 1 %>' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

test('the two doors share one kernel and one store', async (t) => {
  // The card script writes through its door; the generation reads through the
  // other. One evaluator (the forked child), one variable store (the live
  // entry's) — a second engine or a second store would make the `K=42` miss.
  const fixed = await fixture(t, { description: 'K=<%= getvar("k") %>.' })
  await fixed.handlers['template.setSettings']({ enabled: true })

  const { text } = await fixed.handlers['script.evalTemplate']({
    chatId: fixed.chatId,
    content: `<% setvar('k', 42, { scope: 'global' }) %>set`,
  })
  assert.equal(text, 'set')

  const sent = await sendDescription(fixed)
  assert.match(sent, /K=42\./u, 'the generation did not read what the script door wrote')
})

test('a feature enabled by the switch keeps upstream failure semantics', async (t) => {
  const fixed = await fixture(t, { description: 'Before. <%= nope.missing.deeper %> After.' })
  await fixed.handlers['template.setSettings']({ enabled: true })

  const sent = await sendDescription(fixed)
  assert.match(sent, /Before\./u)
  assert.match(sent, /After\./u)
  assert.ok(
    fixed.errors.some(error => /template: generate\/.*failed/u.test(error.message)),
    `no failure was reported; saw ${JSON.stringify(fixed.errors.map(error => error.message))}`,
  )
})
