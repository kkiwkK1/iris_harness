/**
 * One-shot seed: mock provider up, host booted, extension installed + enabled,
 * the test card imported, chat created and opened, 好感度 seeded.
 * Prints one JSON line per step so the acceptance log can quote them.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const bootRequire = createRequire(fileURLToPath(new URL('../../../apps/iris/package.json', import.meta.url)))
const { boot } = bootRequire('@deepseek-ai/dsh-app-boot')

const PORT = process.env.PILOT_PORT ?? '8799'
const PORT_ENV = `PILOT_PORT=${PORT}`

// ---- the scripted provider -------------------------------------------------
const { startPilotProvider } = await import('./mock-provider.mjs')
const provider = await startPilotProvider()

process.env.IRIS_BASE_URL = provider.baseURL
process.env.IRIS_MODEL = 'pilot-model'
process.env.IRIS_PORT = PORT
process.env.IRIS_WEB_DIST = fileURLToPath(new URL('../../../apps/iris-web/dist/index.html', import.meta.url))

const dataDir = await mkdtemp(join(tmpdir(), 'iris-pilot-'))
process.env.IRIS_DATA_DIR = dataDir

const ctx = await boot('iris-pilot', fileURLToPath(new URL('../../../apps/iris/cordis.yml', import.meta.url)))

async function rpc(method, params) {
  const response = await fetch(`http://127.0.0.1:${PORT}/iris/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: `seed-${Date.now()}`, method, params }),
  })
  const frame = await response.json()
  if (!frame.ok) throw new Error(`${method} refused: ${JSON.stringify(frame.error)}`)
  return frame.result
}

// ---- the test card ---------------------------------------------------------
const TEMPLATE_ENTRY = [
  "<% if (getvar('好感度', { defaults: 0 }) > 50) { %>",
  '你是我信赖的朋友。',
  '<% } else { %>',
  '我仍然对你保持警惕。',
  '<% } %>',
].join('\n')

const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Pilot卡',
    description: 'Pilot acceptance character: a card whose bound world book carries the upstream README example 2 template.',
    personality: '',
    scenario: '',
    first_mes: '你好。',
    mes_example: '',
    creator_notes: 'pilot fixture',
    system_prompt: '',
    character_book: {
      name: 'pilot-book',
      entries: [{
        uid: 0,
        name: 'UC1 template entry',
        enabled: true,
        strategy: { type: 'constant' },
        content: TEMPLATE_ENTRY,
        position: 0,
        depth: 4,
        constant: true,
        selective: false,
      }],
    },
  },
}

const cardPath = join(dataDir, 'pilot-card.json')
await writeFile(cardPath, JSON.stringify(card, null, 2), 'utf8')

// ---- the steps -------------------------------------------------------------
const log = (step, value) => { console.log(`SEED ${step}: ${JSON.stringify(value)}`) }

log('provider', { baseURL: provider.baseURL, dataDir, port: PORT })

const importResult = await rpc('character.import', {
  filename: 'pilot-card.json',
  content: Buffer.from(JSON.stringify(card), 'utf8').toString('base64'),
})
log('character.import', importResult)
const characterId = importResult.character?.characterId ?? importResult.characters?.[0]?.characterId
  ?? importResult.characterId

const chat = await rpc('chat.create', { characterId })
log('chat.create', { chatId: chat.view?.id ?? chat.chatId ?? chat.view?.chatId })
const chatId = chat.view?.id ?? chat.chatId ?? chat.view?.chatId

await rpc('chat.open', { chatId })

await rpc('stExtension.install', {
  path: 'E:/sillyTavern/SillyTavern/public/scripts/extensions/third-party/ST-Prompt-Template',
})
log('stExtension.install', 'done')

const list1 = await rpc('plugin.list', {})
log('plugin.list after install', list1.plugins.map(p => ({ id: p.id, installed: p.installed, status: p.status })))

// The extension id is derived from the manifest's display name, slugified —
// read it off the snapshot rather than hard-coding it.
const extensionId = list1.plugins
  .map(row => row.id)
  .find(id => id !== 'tavern-helper' && id !== 'mvu')
if (extensionId === undefined) throw new Error('the installed extension is not in the snapshot')

await rpc('plugin.enable', { id: extensionId })
const list2 = await rpc('plugin.list', {})
log('plugin.list after enable', list2.plugins.map(p => ({ id: p.id, installed: p.installed, status: p.status })))
log('revision', list2.revision)
log('extensionId', extensionId)

// Most scenarios isolate Prompt Template. UC-2 explicitly enables MVU for its
// final round and verifies the shared host-side variable transaction.
await rpc('plugin.disable', { id: 'mvu' })
const list3 = await rpc('plugin.list', {})
log('plugin.list after mvu disable', list3.plugins.map(p => ({ id: p.id, status: p.status })))
log('revision', list3.revision)

// Seed 好感度 = 70 for UC-1 step 1.
await rpc('script.setVariables', {
  chatId,
  scope: 'chat',
  op: 'insertOrAssign',
  variables: { 好感度: 70 },
})
const vars = await rpc('script.getVariables', { chatId, scope: 'chat' })
log('seeded variables', vars)

console.log(`SEED COMPLETE: PILOT_PORT=${PORT} CHAT_ID=${chatId} CHARACTER_ID=${characterId} DATA_DIR=${dataDir}`)
console.log(`SEED PROVIDER_BASE=${provider.baseURL}`)

// Stay alive; the driver talks over the wire.
process.stdin.resume()
process.stdin.on('data', chunk => {
  if (chunk.toString().trim() === 'dispose') {
    void (async () => {
      await ctx.fiber.dispose()
      await provider.close()
      process.exit(0)
    })()
  }
})
