/**
 * What the estimator's calibration is fed, and by whom.
 *
 * Two defects shared one line of `#stream`. The calibrator was handed
 * `usage.inputTokens` as "the size of the request just estimated", but in the
 * harness convention that figure excludes what the cache served — so on a
 * cache-hitting provider, the steady state Iris's cache-friendly assembly
 * exists to produce, every observation said the prompt was a fraction of its
 * size and the scale sank to its 0.5 floor within two turns. And every request
 * fed it, including the side requests the `#stream` docblock says must not
 * move the turn's calibration (a card's `generateRaw`, the host's compaction
 * summary).
 *
 * The fake provider here answers every request with **the request's own size**
 * (a scale-1 estimate of exactly what it was handed), split 10 / 90 between
 * uncached and cache-read. So a correct calibrator stays at 1, and the nearest
 * wrong one — reading `inputTokens` alone — is pulled to 0.5: the two disagree
 * by a factor of two, not by a rounding error.
 *
 * @module @iris/app-service/tests/calibration-feed
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { IrisEvent } from '@iris/protocol'
import { promptTokensOf } from '@iris/protocol'
import { createCalibratingCounter } from '@iris/tokenizer'
import type { StreamFn } from '@iris/turn'

import type { IrisAppService, Handlers } from '../src/service.ts'
import { textOf } from '../src/views.ts'
import { materialisingChatStore } from './support/materialising-store.ts'
import { createTestService } from './support/service.ts'

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Aria',
    description: 'An archivist.',
    first_mes: 'The shelves are quiet tonight.',
    personality: '', scenario: '', mes_example: '', creator_notes: '',
    system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '', extensions: {},
  },
})

const SUMMARY = 'They met in the archive. She is guarded; he is looking for one book.'

interface Fixture {
  handlers: Handlers
  service: IrisAppService
  /** The whole prompt size reported for each request, in order. */
  reported: number[]
  settled: () => Promise<void>
}

async function fixture(t: TestContext): Promise<Fixture> {
  const reported: number[] = []
  let ends = 0
  let waited = 0

  const stream: StreamFn = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The request's own size, estimated at scale 1 over the same texts the
    // service estimates — so "the provider agrees with the estimate" is the
    // truth this fake tells, and only a feed that drops the cached part can
    // disagree with it.
    const whole = createCalibratingCounter().countRequest([
      ...options.system === undefined ? [] : [{ text: options.system }],
      ...options.messages.map(message => ({ text: textOf(message) })),
    ])
    const inputTokens = Math.ceil(whole * 0.1)
    const usage = { inputTokens, outputTokens: 40, cacheReadTokens: whole - inputTokens }
    reported.push(promptTokensOf(usage))
    const isSummary = JSON.stringify(options.messages.at(-1)?.content ?? '').includes('compaction engine')
    const text = isSummary ? SUMMARY : 'The archivist says something.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const { service, handlers } = await createTestService(t, async ({ dir, library }) => {
    await mkdir(join(dir, 'characters'), { recursive: true })
    await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
    return {
      stream,
      chats: materialisingChatStore(dir, library),
      broadcast: (event: IrisEvent) => { if (event.type === 'stream.end') ends += 1 },
      userName: 'Traveller',
    }
  }, 'iris-calibration-feed-')
  return {
    handlers,
    service,
    reported,
    settled: async () => {
      waited += 1
      while (ends < waited) await new Promise(resolve => setTimeout(resolve, 1))
    },
  }
}

async function played(f: Fixture, turns: number): Promise<{ chatId: string, lastTurn: number }> {
  const { view } = await f.handlers['chat.create']({ characterId: 'aria' })
  let lastTurn = -1
  for (let at = 0; at < turns; at += 1) {
    const { turn } = await f.handlers['chat.send']({
      chatId: view.chatId,
      kind: 'send',
      text: `Line ${String(at)}: ${'the reader says something at length. '.repeat(6)}`,
    })
    lastTurn = turn
    await f.settled()
  }
  return { chatId: view.chatId, lastTurn }
}

test('a 90% cache hit does not drag the calibration down: the feed is the whole prompt', async (t) => {
  const f = await fixture(t)
  const { chatId, lastTurn } = await played(f, 4)

  assert.equal(f.service.calibration.samples, 4, 'every turn is one observation')
  // Reading `inputTokens` alone gives 0.5 here (the clamp floor) by the second
  // turn; the whole prompt keeps it at 1 up to the estimator's own rounding.
  const { scale } = f.service.calibration
  assert.ok(Math.abs(scale - 1) < 0.05, `the calibration moved to ${String(scale)} on a provider that agreed with every estimate`)

  // The turn's record says what the prompt cost, all of it.
  const { itemization } = await f.handlers['prompt.itemize']({ chatId, turn: lastTurn })
  assert.equal(itemization.preview, false)
  assert.equal(itemization.actualTokens, f.reported.at(-1),
    'actualTokens is the uncached remainder, not the prompt the provider counted')
})

test('side requests do not move the calibration: script.generateRaw and chat.compact', async (t) => {
  const f = await fixture(t)
  const { chatId } = await played(f, 3)
  const before = f.service.calibration
  assert.equal(before.samples, 3)
  const requests = f.reported.length

  await f.handlers['script.generateRaw']({ chatId, prompt: 'Name one book.' })
  const compacted = await f.handlers['chat.compact']({ chatId })
  assert.ok(compacted.compacted !== null, 'the fixture had history to compact')

  // Premise: both requests reached the provider and reported usage, so an
  // unchanged count is a decision and not an absence.
  assert.equal(f.reported.length, requests + 2, 'the two side requests did not both reach the provider')
  assert.deepEqual(f.service.calibration, before, 'a side request moved the turn’s calibration')
})
