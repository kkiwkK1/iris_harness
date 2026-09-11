import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { materialisingChatStore } from '../../../packages/iris-app-service/tests/support/materialising-store.ts'
import { CharacterLibrary } from '../../../packages/iris-app-service/src/library.ts'
import { ChatStore } from '../../../packages/iris-app-service/src/chats.ts'
import { IrisAppService } from '../../../packages/iris-app-service/src/service.ts'
import { SettingsStore } from '../../../packages/iris-app-service/src/settings.ts'

/**
 * The generation kinds against a real provider.
 *
 * Same gate as `live-provider.test.ts`: `IRIS_LIVE=1`, because a key in the
 * working tree must not turn `pnpm test` into something that costs money. The
 * assertions say what the KINDS do — where the text lands, what the request
 * closed with — never what the model chose to write.
 */

/** The key, from the environment and nowhere else — see `live-provider.test.ts`. */
function apiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined
}

const enabled = process.env.IRIS_LIVE === '1'
const key = enabled ? apiKey() : undefined
const skip = !enabled
  ? 'live generation-kind tests are opt-in: run with IRIS_LIVE=1'
  : key === undefined
    ? 'no provider key available (set DEEPSEEK_API_KEY)'
    : false

const MODEL = process.env.IRIS_LIVE_MODEL ?? 'deepseek-v4-flash'

let ctx: Context
let dir: string
let handlers: ReturnType<IrisAppService['handlers']>
let chatId: string
const seen: string[] = []

before(async () => {
  if (key === undefined) return
  process.env.DEEPSEEK_API_KEY = key
  process.env.IRIS_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.IRIS_MODEL = MODEL
  process.env.IRIS_API_KEY_ENV = 'DEEPSEEK_API_KEY'
  dir = await mkdtemp(join(tmpdir(), 'iris-live-kinds-'))
  // An ephemeral port and a temporary data directory, because this boots the
  // **real** composition: it defaults to 8787 and `apps/iris/data`, both of
  // which belong to whatever host the person running this has open — and the
  // app service now refuses to start on a data directory another host holds.
  process.env.IRIS_PORT = '0'
  process.env.IRIS_DATA_DIR = join(dir, 'host-data')
  ctx = await boot('iris-live-kinds', fileURLToPath(new URL('../cordis.yml', import.meta.url)))

  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '络络',
      description: '络络是一个话少但心细的制图师。',
      personality: '沉静', scenario: '', first_mes: '*她抬起头。* 你也来看地图？',
      mes_example: '', creator_notes: '', system_prompt: '',
      post_history_instructions: 'End every reply by asking a question.',
      alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
    },
  }), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats: ChatStore = materialisingChatStore(dir, library)
  const settings = new SettingsStore(join(dir, 'settings.json'), { provider: 'default', model: MODEL })
  const stream: StreamFn = options => ctx.llm.stream(options)
  handlers = new IrisAppService({
    stream, library, chats, settings,
    broadcast: (event: IrisEvent) => {
      if (event.type === 'stream.end') seen.push(event.turn.toString())
    },
    userName: '旅人',
    contextWindow: 32_000,
    reserveTokens: 2_000,
  }).handlers()
  const created = await handlers['chat.create']({ characterId: 'aria' })
  chatId = created.view.chatId
})

after(async () => {
  if (ctx !== undefined) await ctx.fiber.dispose()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/** Wait for one more settled generation. */
function settled(want: number): Promise<void> {
  let waited = 0
  const timer = setInterval(() => { waited += 1 }, 10)
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (seen.length >= want) { clearInterval(timer); resolve(); return }
      if (waited > 3_000) { clearInterval(timer); reject(new Error('generation did not settle in time')); return }
      setTimeout(check, 50)
    }
    check()
  })
}

test('a real continue rejoins the floor it continued', { skip }, async () => {
  await handlers['chat.send']({ chatId, text: '你在画什么？' })
  await settled(1)

  const before = (await handlers['chat.open']({ chatId })).view
  const floor = before.messages.find(message => message.role === 'assistant' && message.turn === 1)
  assert.ok((floor?.text.length ?? 0) > 0, 'the model did not reply')

  await handlers['chat.send']({ chatId, kind: 'continue' })
  await settled(2)

  const after = (await handlers['chat.open']({ chatId })).view
  const continued = after.messages.find(message => message.role === 'assistant' && message.turn === 1)
  assert.notEqual(continued, undefined)
  // Same floor, longer text, and the pre-continue reading is still swipable.
  assert.ok((continued?.text.length ?? 0) > (floor?.text.length ?? 0), 'the continue did not grow the floor')
  assert.ok((continued?.text ?? '').startsWith(floor?.text ?? ''), 'the continued reading lost its seed')
  assert.deepEqual(continued?.swipes, { count: 2, index: 1 })
  console.log(`\n  live continue (${MODEL}): …${continued?.text.slice(-80).replace(/\s+/g, ' ')}\n`)
})

test('a real impersonate lands as the user line', { skip }, async () => {
  await handlers['chat.send']({ chatId, kind: 'impersonate' })
  await settled(3)

  const view = (await handlers['chat.open']({ chatId })).view
  const line = view.messages.at(-1)
  assert.notEqual(line, undefined)
  assert.equal(line?.role, 'user', 'the impersonated text did not settle as a user line')
  assert.equal(line?.name, '旅人')
  assert.ok((line?.text.length ?? 0) > 0, 'the model wrote nothing')
  assert.equal(
    view.messages.some(message => message.role === 'assistant' && message.turn === line?.turn),
    false,
    'the impersonated turn grew a reply',
  )
  console.log(`\n  live impersonate (${MODEL}): ${line?.text.slice(0, 80).replace(/\s+/g, ' ')}\n`)
})
