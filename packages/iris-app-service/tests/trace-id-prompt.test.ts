import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * `_trace_id` must not reach the wire unless a card asks for it.
 *
 * The host stamps an incrementing batch number into the variable scope a card's
 * EJS templates read — upstream's own quantity (`ST-Prompt-Template`'s
 * `variables.ts:58`, `{ _trace_id: (STATE.traceId)++, _modify_id: 0 }`), so
 * having it is fidelity, not a defect. But it is the one value this host feeds
 * a template that changes on **every generation**, which makes it the one value
 * that can make two otherwise-identical requests differ from the byte a card
 * printed it at onwards.
 *
 * Corpus exposure, measured 2026-09-08 over the operator's install
 * (`E:\sillyTavern\SillyTavern\data\default-user`, 19 cards with an embedded
 * payload, 18 disk world books, 1478 book entries): **zero** references to
 * `_trace_id` or `_modify_id`, in prompt text or in card script code, and zero
 * templates that print the whole `variables` object (which would carry it
 * without naming it). The population that uses EJS at all is 8 cards and 8
 * books, 203 distinct entries — so the surface exists and nothing on it uses
 * the counter today.
 *
 * A zero is only worth pinning next to a positive control, so this file has
 * both: a card that prints the counter (its requests must differ) and a card
 * that runs a template without printing it (its requests must not). Without the
 * first, the second would pass on a host where templates never ran at all.
 */

function card(template: string): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: 'Aria',
      description: 'A retired cartographer.',
      personality: '', scenario: '', first_mes: 'Hello.', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '1',
      // Delivered as a depth-0 note, so the template text lands in the
      // assembled request and `#applyTemplates` has something to fork for.
      extensions: { depth_prompt: { prompt: template, depth: 0, role: 'system' } },
    },
  })
}

interface Fixture {
  handlers: Handlers
  chatId: string
  captured: GenerateOptions[]
  settled: (count?: number) => Promise<void>
}

async function fixture(t: TestContext, template: string): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-trace-id-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), card(template), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const captured: GenerateOptions[] = []
  const stream: StreamFn = async function* (request) {
    captured.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'A reply.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'A reply.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  let ends = 0
  let waited = 0
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end' || event.type === 'stream.error') ends += 1
    },
    userName: 'Traveller',
    templates: { deadlineMs: 20_000 },
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return {
    handlers,
    chatId: created.view.chatId,
    captured,
    settled: async (count = 1) => {
      waited += count
      for (let tick = 0; tick < 30_000 && ends < waited; tick += 1) {
        await new Promise(done => { setTimeout(done, 1) })
      }
      assert.equal(ends >= waited, true, 'a generation never settled')
    },
  }
}

/** The whole request as text, system prompt included. */
function sent(options: GenerateOptions): string {
  return [
    options.system ?? '',
    ...options.messages.map(message => message.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')),
  ].join('\n')
}

/** Two swipes of one reply: two assemblies of one unchanged state. */
async function twoSwipes(fix: Fixture): Promise<[string, string]> {
  await fix.handlers['chat.send']({ chatId: fix.chatId, kind: 'send', text: 'Where are the maps?' })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()
  await fix.handlers['chat.regenerate']({ chatId: fix.chatId })
  await fix.settled()
  assert.equal(fix.captured.length, 3)
  return [sent(fix.captured[1] as GenerateOptions), sent(fix.captured[2] as GenerateOptions)]
}

test('a card that prints the batch counter makes every request different — the positive control', async (t) => {
  const fix = await fixture(t, 'batch <%= variables._trace_id %> begins.')
  const [first, second] = await twoSwipes(fix)

  // The counter is really in the scope and really reachable. If this ever
  // stops failing to match, the test below has stopped being able to detect a
  // leak and is passing for the wrong reason.
  assert.notEqual(first, second,
    'the batch counter did not reach the prompt at all, so the pin below cannot detect a leak')
  assert.match(first, /batch \d+ begins\./u)
  assert.match(second, /batch \d+ begins\./u)
})

test('a template that does not print the counter leaves the request byte-identical', async (t) => {
  // A template that evaluates, so the fork runs and the counter is stamped and
  // incremented — but never printed. A card with no `<%` at all would skip
  // `#applyTemplates` entirely (`promptHasTemplate`) and prove nothing.
  const fix = await fixture(t, 'the sum is <%= 2 + 3 %>.')
  const [first, second] = await twoSwipes(fix)

  assert.match(first, /the sum is 5\./u, 'the template never rendered, so no counter was ever stamped')
  assert.equal(first, second)
  assert.equal(first.includes('_trace_id'), false)
  // Nothing in the request looks like a bare batch number either — the check
  // above would pass if the counter arrived expanded rather than named.
  assert.equal(/\btrace\b/iu.test(first), false)
})
