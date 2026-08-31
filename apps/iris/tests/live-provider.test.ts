import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { historyFromSession, TurnDriver } from '@iris/turn'
import type { Contribution } from '@iris/pipeline'

/**
 * A real turn against a real provider.
 *
 * Gated on `IRIS_LIVE=1`, not merely on a key being present: a key sitting in
 * the working tree must not quietly turn `pnpm test` into something that costs
 * money and fails when the network is down. Run it with `pnpm test:live`.
 *
 * Assertions cover only what a provider must do regardless of what the model
 * chooses to say — text arrives incrementally, the stream terminates cleanly,
 * the deltas reassemble. Asserting on generated *content* would make the suite
 * fail for reasons that have nothing to do with Iris.
 */

const KEY_FILE = fileURLToPath(new URL('../../../key.txt', import.meta.url))

/** The key, from the environment or the gitignored file. Never logged. */
function apiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (!existsSync(KEY_FILE)) return undefined
  const fromFile = readFileSync(KEY_FILE, 'utf8').trim()
  return fromFile.length > 0 ? fromFile : undefined
}

const enabled = process.env.IRIS_LIVE === '1'
const key = enabled ? apiKey() : undefined
const skip = !enabled
  ? 'live provider tests are opt-in: run `pnpm test:live`'
  : key === undefined
    ? 'no provider key available (set DEEPSEEK_API_KEY or add key.txt)'
    : false

const MODEL = process.env.IRIS_LIVE_MODEL ?? 'deepseek-v4-flash'

let ctx: Context

before(async () => {
  if (key === undefined) return
  process.env.DEEPSEEK_API_KEY = key
  process.env.IRIS_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.IRIS_MODEL = MODEL
  process.env.IRIS_API_KEY_ENV = 'DEEPSEEK_API_KEY'
  ctx = await boot('iris-live', fileURLToPath(new URL('../cordis.yml', import.meta.url)))
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
})

const CONTRIBUTIONS: Contribution[] = [
  {
    id: 'persona',
    placement: { kind: 'system', order: 0 },
    text: '你是络络，一个话少但心细的制图师。用一到两句话回应，保持角色。',
  },
  {
    id: 'jailbreak',
    placement: { kind: 'depth', depth: 0, role: 'system' },
    text: '只输出络络的话，不要解释。',
  },
]

/** A driver over a real provider. */
function driverFor(session: Session): TurnDriver {
  return new TurnDriver({
    stream: options => ctx.llm.stream(options),
    provider: 'default',
    model: MODEL,
    contributions: () => CONTRIBUTIONS,
    history: current => historyFromSession(current),
    budget: { context: 32_000, reserve: 2_000, count: text => Math.ceil(text.length / 2) },
    temperature: 0.9,
    sampling: { topP: 0.95 },
    maxTokens: 200,
  })
}

/** Text of a candidate. */
function textOf(candidate: { message: { content: readonly { type: string, text?: string }[] } }): string {
  return candidate.message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

test('a real provider streams a roleplay turn through the whole stack', { skip }, async () => {
  const session = Session.create(SessionId('iris-live'))
  const driver = driverFor(session)

  const deltas: string[] = []
  const candidate = await driver.send(session, '你好，我在找一张旧地图。', {
    onText: delta => void deltas.push(delta),
  })

  const text = textOf(candidate)
  assert.ok(text.length > 0, 'the model said something')
  assert.ok(deltas.length > 1, 'text arrived incrementally, not in one lump')
  assert.equal(deltas.join(''), text, 'the streamed deltas reassemble into the recorded message')

  // The turn closed cleanly and is in the durable log.
  assert.equal(session.events.some(event => event.type === 'turn/end'), true)
  assert.ok(session.events.filter(event => event.type === 'assistant/chunk').length > 1)

  console.log(`\n  live reply (${MODEL}): ${text.replace(/\s+/g, ' ').slice(0, 160)}\n`)
})

test('regenerating against a real provider produces a second swipe', { skip }, async () => {
  const session = Session.create(SessionId('iris-live-swipe'))
  const driver = driverFor(session)

  await driver.send(session, '这张地图上有什么？')
  await driver.regenerate(session)

  const { candidates, selected } = driver.swipes(session, 0)
  assert.equal(candidates.length, 2)
  assert.equal(selected, 1)

  // Swiping back must restore the first generation exactly.
  const first = textOf(candidates[0] as never)
  driver.swipe(session, 0, 0)
  const view = session.deriveMessages().at(-1)
  const restored = (view?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
    .join('')
  assert.equal(restored, first)
})
