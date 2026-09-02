import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { requestSchemas } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * Rendering a card's own EJS template.
 *
 * Upstream's `evalTemplate`. The corpus calls it at one site in one card
 * (银麒赎世, injecting world book content), always with a single argument.
 *
 * **The security property is the point of this arm, not a precaution around
 * it.** The string is whatever a card put there, and it is EJS — that is, it is
 * a program. It is evaluated in the forked child of
 * `@iris/compat-prompt-template`, which runs with `env: {}`, and there is no
 * `eval`, `Function` or `vm` anywhere on the host's side of the call. The last
 * test in this file asserts that as a property of the source rather than
 * trusting the reading, because "we don't do that here" is exactly the sort of
 * claim that stays in a comment while a later change quietly makes it false.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Aria', description: '', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: {},
  },
})

interface Fixture {
  handlers: Handlers
  chats: ChatStore
  chatId: string
}

/**
 * @param t - the test context, for cleanup.
 * @param templates - whether the template feature is configured on.
 * @returns handlers and an open chat.
 */
async function fixture(t: TestContext, templates: boolean, reports?: string[]): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-evalt-'))
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
    ...reports === undefined ? {} : { onError: (error: Error) => { reports.push(error.message) } },
    ...templates ? { templates: { deadlineMs: 5000 } } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chats, chatId: created.view.chatId }
}

test('a template renders, and the result is the rendered text', async (t) => {
  const fixed = await fixture(t, true)
  const { text } = await fixed.handlers['script.evalTemplate']({
    chatId: fixed.chatId,
    content: 'sum <%= 2 + 3 %>',
  })
  assert.equal(text, 'sum 5')
})

test('a template that throws is refused, not answered with empty text', async (t) => {
  const fixed = await fixture(t, true)

  // Cards expect upstream's soft degradation — a warning and the original text
  // — and the façade is what provides it. Answering `''` here would hand the
  // card a rendered-looking empty string and lose the text it asked about, with
  // nothing to say which of the two happened.
  await assert.rejects(
    () => fixed.handlers['script.evalTemplate']({
      chatId: fixed.chatId,
      content: '<%= nothing.at.all %>',
    }),
    /template evaluation failed/u,
  )
})

test('with the feature off it is refused by name', async (t) => {
  const fixed = await fixture(t, false)

  // Not an empty string, and not a silent pass-through of the input either. A
  // host running without templates has not rendered anything, and saying so is
  // the only answer a card can act on.
  await assert.rejects(
    () => fixed.handlers['script.evalTemplate']({ chatId: fixed.chatId, content: 'x <%= 1 %>' }),
    (error: unknown) => (error as { code?: string }).code === 'unsupported',
  )
})

test('the contract refuses a call carrying data or options', () => {
  // Upstream's signature is `(content, data?, options?)` and the corpus only
  // ever passes one argument. The schema is strict rather than lenient because
  // dropping `data` silently would render the template against the *wrong
  // values* and return well-formed text — indistinguishable, to the card, from
  // a correct render.
  const schema = requestSchemas['script.evalTemplate']
  assert.equal(schema.safeParse({ chatId: 'c', content: 'x' }).success, true)
  assert.equal(
    schema.safeParse({ chatId: 'c', content: 'x', data: { a: 1 } }).success,
    false,
    'a call carrying `data` was accepted and its data dropped',
  )
})

test('nothing evaluates the card’s string in the host process', async () => {
  // Asserted against the source, not against the design. The fence lives in a
  // forked child with `env: {}`; the risk is not that someone disagrees with
  // that, it is that a later change adds a "quick path" for one string and the
  // comment above it still says the evaluation is fenced.
  //
  // Scoped to this package's own source: the evaluator package is *supposed* to
  // contain an evaluator, and it runs in the child.
  const source = await readFile(new URL('../src/service.ts', import.meta.url), 'utf8')

  // Built from character codes so this file does not itself contain the tokens
  // it forbids — otherwise a scan of the repository for them finds its own
  // guard and the finding is noise.
  const forbidden = [
    ['e', 'v', 'a', 'l', '('].join(''),
    ['n', 'e', 'w', ' ', 'F', 'u', 'n', 'c', 't', 'i', 'o', 'n', '('].join(''),
    ['v', 'm', '.', 'r', 'u', 'n'].join(''),
  ]
  for (const token of forbidden) {
    assert.equal(
      source.includes(token),
      false,
      `service.ts contains \`${token}\` — a card's template must only ever run in the forked child`,
    )
  }

  // And the arm reaches the fenced evaluator rather than any other path.
  assert.ok(
    source.includes('evaluateBatch({'),
    'script.evalTemplate no longer goes through the fenced batch evaluator',
  )
})

test('a template that writes is applied — and every write is named', async (t) => {
  const reports: string[] = []
  const fixed = await fixture(t, true, reports)

  // **The fixture is the real shape, and that correction came from measurement.**
  // The first version used `setvar`, which looked representative and is not:
  // across the corpus the card that actually calls `evalTemplate` reaches
  // exactly one writing entry, and **every op a card-supplied template produces
  // here is `saveMetadata`** — the 8 `setvar` entries in those books all sit in
  // entries `renderEntry` cannot reach, on the assembly path this route never
  // touches. A `setvar` fixture tests something with no overlap at all with real
  // traffic, which is this repository's recurring way of losing a test and its
  // teeth-check together.
  //
  // The real shape, from `银麒赎世` / `[EJS]末日世界观`: mutate `chatMetadata` in
  // place, then call `saveMetadata()`.
  const { text } = await fixed.handlers['script.evalTemplate']({
    chatId: fixed.chatId,
    content: '<% const m = SillyTavern.chatMetadata; m.yinqi_phone = { seen: true };'
      + ' SillyTavern.saveMetadata() %>rendered',
  })
  assert.equal(text, 'rendered')

  // Named, and named with *which top-level keys moved* rather than the payload:
  // the op carries a clone of the whole of `chat_metadata` and lands as a
  // wholesale replacement, so the keys are both the readable part and the actual
  // semantics.
  const named = reports.filter(line => line.includes('performed saveMetadata'))
  assert.equal(named.length, 1, `expected one named write, saw: ${reports.join(' | ')}`)
  assert.match(named[0] ?? '', /yinqi_phone/u)
})

test('the fence hands templates a live chatMetadata, not a copy', async (t) => {
  const fixed = await fixture(t, true)

  // The load-bearing detail behind the shape above, pinned where it will be
  // noticed. That template works only because `environment.ts` exposes
  // `chatMetadata` through a getter returning the **live** object: the template
  // holds it in a local, mutates in place, and `saveMetadata()` then clones
  // whatever state now holds.
  //
  // "Harden" that getter into returning a copy and the chain breaks in silence —
  // the template still runs, no error is raised, the op is still pushed, and the
  // pushed value simply lacks the mutation.
  //
  // So this asserts through **the value that came out the far end**, not that
  // the getter returned an object. The latter passes under a copying
  // implementation, which is precisely the implementation it must reject.
  await fixed.handlers['script.evalTemplate']({
    chatId: fixed.chatId,
    content: '<% const m = SillyTavern.chatMetadata; m.written_in_place = 42;'
      + ' SillyTavern.saveMetadata() %>ok',
  })

  const entry = await fixed.chats.open(fixed.chatId)
  assert.equal(
    (entry.header.chat_metadata as Record<string, unknown>)['written_in_place'],
    42,
    'an in-place mutation never reached the stored metadata — chatMetadata is being copied out',
  )
})

test('a timeout is thrown, never resolved as the original text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-evalt-slow-'))
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
    // Short enough that a spinning template is killed quickly.
    templates: { deadlineMs: 300 },
  }).handlers()
  const created = await handlers['chat.create']({ characterId: 'aria' })

  // The assembly path treats a timeout as "fall back to the original text",
  // which is right there — the generation still goes out. On this route it must
  // be the opposite: the card's own `catch` is the thing that degrades, and it
  // only runs on a rejection. Resolving with the input would make a template
  // that never finished look like one that rendered to itself.
  await assert.rejects(
    () => handlers['script.evalTemplate']({
      chatId: created.view.chatId,
      content: '<% while (true) {} %>',
    }),
    /timed out|template evaluation failed/u,
  )
})
