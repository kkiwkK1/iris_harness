import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import type { IrisEvent } from '@iris/protocol'
import type { StreamFn } from '@iris/turn'

import { ChatStore } from '../src/chats.ts'
import { ExtensionSettingsStore } from '../src/context.ts'
import { CharacterLibrary } from '../src/library.ts'
import { IrisAppService, type Handlers } from '../src/service.ts'
import { SettingsStore } from '../src/settings.ts'

/**
 * The three shapes real cards use `extensionSettings` for.
 *
 * Measured by 3e across 121 sources — card scripts, rendered interface blocks
 * and the sample card — matching both `extensionSettings` and
 * `extension_settings`, with a left boundary that excludes identifier
 * characters but **not** `.`, so `ctx.extensionSettings` and
 * `window.parent.extension_settings` are counted. 20 sites, 3 cards, 3 shapes:
 *
 * | card | key | owner | direction |
 * | --- | --- | --- | --- |
 * | 希尔 | `.xierStatusRule` | its own | write only — nothing reads it back |
 * | 银麒赎世 | `['st-chatu8']`, plus a `for…in` for obfuscated keys | another extension | read |
 * | 创世回廊 | `.EjsTemplate.enabled` | another extension | read |
 *
 * **Two of the three are extension *detection*, not storage** — "is 智绘姬
 * installed", "is EjsTemplate enabled". That reframes the design question this
 * host had open. It was posed as flat-and-shared versus partitioned-per-card,
 * which presumes cards use it to keep things. Mostly they use it to ask whether
 * somebody else is there.
 *
 * This host partitions per card, which is a **different question** from
 * upstream's installation-wide bag. These tests pin that the difference is
 * invisible to all three measured shapes, and — more importantly — that it is
 * invisible for the *right reason*, so that a later change cannot quietly break
 * it. The scope of the negative claim is 19 corpus cards plus one sample card;
 * card 20 is under no obligation to be written defensively.
 */

const CARD = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
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

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'iris-extset-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'characters'), { recursive: true })
  await writeFile(join(dir, 'characters', 'aria.json'), CARD, 'utf8')
  await writeFile(join(dir, 'characters', 'other.json'), CARD.replace('"Aria"', '"Other"'), 'utf8')

  const library = new CharacterLibrary(join(dir, 'characters'), '/iris/avatar')
  const chats = new ChatStore(join(dir, 'chats'), library)
  const stream: StreamFn = async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const handlers = new IrisAppService({
    stream, library, chats,
    settings: new SettingsStore(join(dir, 'settings.json'), { provider: 'test', model: 'test-model' }),
    extensionSettings: new ExtensionSettingsStore(join(dir, 'extension-settings.json')),
    broadcast: (_event: IrisEvent) => {},
    userName: 'Traveller',
  }).handlers()

  const created = await handlers['chat.create']({ characterId: 'aria' })
  return { handlers, chatId: created.view.chatId }
}

const settingsOf = async (fixed: Fixture, characterId = 'aria'): Promise<Record<string, unknown>> => {
  const { context } = await fixed.handlers['script.context']({ chatId: fixed.chatId, characterId })
  return context.extensionSettings
}

test('probing for an extension this host does not have reads as absent', async (t) => {
  const fixed = await fixture(t)
  const settings = await settingsOf(fixed)

  // 银麒赎世 and 创世回廊's shape. `undefined` is the honest answer — 智绘姬 and
  // ST-Prompt-Template genuinely are not installed here — and both cards guard,
  // degrading to null and to false respectively.
  //
  // This works because the partition is empty of *other extensions'* keys, not
  // because the store is empty in general. That distinction is the whole point:
  // aliasing this field to any populated installation-wide bag would start
  // answering "is it installed" with somebody else's data.
  assert.equal(settings['st-chatu8'], undefined)
  assert.equal((settings['EjsTemplate'] as { enabled?: boolean } | undefined)?.enabled, undefined)

  // The `for…in` sweep 银麒赎世 uses for obfuscated `jiuguanSto*` keys must find
  // nothing rather than throw — it iterates whatever it is handed.
  assert.deepEqual(Object.keys(settings).filter(key => key.startsWith('jiuguanSto')), [])
})

test('a card’s own namespace survives a write and a re-read', async (t) => {
  const fixed = await fixture(t)

  // 希尔's shape. Upstream would put this in the installation-wide bag; here it
  // lands in the card's partition. No corpus card reads `xierStatusRule` back —
  // 希尔 itself republishes it on `window` and the real consumers read that — so
  // the difference is unobservable today. It is pinned anyway, because a card
  // that *does* read its own key back is the obvious next case and this is the
  // behaviour it would depend on.
  await fixed.handlers['script.setExtensionSettings']({
    characterId: 'aria',
    settings: { xierStatusRule: { rule: 'a' } },
  })

  const settings = await settingsOf(fixed)
  assert.deepEqual(settings['xierStatusRule'], { rule: 'a' })
})

test('one card cannot see another’s settings, which upstream does not promise', async (t) => {
  const fixed = await fixture(t)
  await fixed.handlers['script.setExtensionSettings']({
    characterId: 'aria',
    settings: { xierStatusRule: { rule: 'a' } },
  })

  // The deliberate divergence, stated as a test rather than left in a comment.
  // Upstream's bag is shared, so one card can read — and learn from — what
  // another stored. Partitioning is stricter, and it is what keeps the
  // detection reads above honest: a neighbour cannot make 智绘姬 look installed.
  //
  // It also costs nothing measured: no corpus card reads a key it did not
  // write, so nothing relies on the sharing this gives up.
  const other = await settingsOf(fixed, 'other')
  assert.deepEqual(other, {})
})

test('an unwritten partition is an empty object, not absent', async (t) => {
  const fixed = await fixture(t)
  // `for…in` over `undefined` throws; over `{}` it finds nothing. A card
  // sweeping for keys must get the second, and this is the shape 银麒赎世 walks
  // straight into on a host where nothing has ever been stored.
  const settings = await settingsOf(fixed)
  assert.equal(typeof settings, 'object')
  assert.notEqual(settings, null)
  assert.deepEqual(Object.keys(settings), [])
})
