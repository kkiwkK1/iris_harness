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
  chatId: string
}

/**
 * @param t - the test context, for cleanup.
 * @param templates - whether the template feature is configured on.
 * @returns handlers and an open chat.
 */
async function fixture(t: TestContext, templates: boolean): Promise<Fixture> {
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
    ...templates ? { templates: { deadlineMs: 5000 } } : {},
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chatId: created.view.chatId }
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
