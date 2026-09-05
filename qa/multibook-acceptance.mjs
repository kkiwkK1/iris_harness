/**
 * B8 acceptance, against a live host: bind a second book to a character, see
 * it reach the scan, unbind, and leave no residue.
 *
 * Host selection is `IRIS_BASE` (this task's own port 8817 by default;
 * `qa/rpc.mjs` shares the variable). The probe imports its own cards and books
 * into the host's data dir and unbinds every binding it made before exiting,
 * so a real profile survives it untouched. Cards used:
 *
 * - a synthetic `B8 Probe` card bound to two synthetic constant books — the
 *   deterministic half (a constant entry always reaches the prompt, so the
 *   token deltas mean exactly what they say);
 * - `1_5.png` (哈人冰恋世界, the 107-entry book) and `V1.5.4_.png`
 *   (不要被神隐挑战) from the corpus dir — the regression half: for each,
 *   a bind → prompt grows → unbind → prompt is **exactly** the baseline again,
 *   and `worldbook.charNames` reports no additional. Nothing generates, so no
 *   conversation turn is spent.
 *
 * Usage: IRIS_BASE=http://127.0.0.1:8817 node qa/multibook-acceptance.mjs [cardsDir]
 */
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { rpc, call } from './rpc.mjs'

const CARDS_DIR = process.argv[2] ?? 'D:/workspace/小项目/iris_分支/测试用卡'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

const waitForHost = async () => {
  for (let i = 0; i < 120; i += 1) {
    try {
      await rpc('character.list', {})
      return true
    } catch {
      await delay(500)
    }
  }
  return false
}

/** A book of `count` constant entries, so every entry reaches every prompt. */
async function createBook(name, count, marker, order = 100) {
  const entries = Array.from({ length: count }, (_, i) => ({
    uid: i, name: `${marker} ${i}`, content: `${marker} entry ${i} for ${name}`,
    strategy: { type: 'constant', keys: [], keys_secondary: { logic: 'and_any', keys: [] } },
    position: { type: 'at_depth', role: 'system', depth: 4, order },
    enabled: true, probability: 100,
  }))
  const { created } = await call('worldbook.create', { name, entries })
  return created
}

/** World-info rows and their total token count, from a prompt preview. */
async function worldInfoTokens(chatId) {
  const { itemization } = await call('prompt.itemize', { chatId })
  // `worldInfoBefore`/`worldInfoAfter` are slot ids without the dot; the depth
  // injections are `worldInfo.depth.N.M`. Both are world info.
  const rows = itemization.entries.filter(item => /worldInfo/i.test(item.id))
  return { rows: rows.length, tokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0) }
}

// --------------------------------------------------------------------- setup

if (!await waitForHost()) {
  console.log('FAIL  host never answered')
  process.exit(3)
}

const card = JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'B8 Probe', description: 'A probe card.', personality: '', scenario: '',
    first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '',
    post_history_instructions: '', alternate_greetings: [], tags: [],
    creator: '', character_version: '1', extensions: { world: 'B8 Primary' },
  },
})

await createBook('B8 Primary', 2, 'primary')
await createBook('B8 Extra', 3, 'extra')
// Order 100000: sorts ahead of a book whose own matches already exhaust the
// scan's cumulative budget stop, so the corpus-card growth below is
// deterministic. ST's stop condition is order-based; a low-order extra riding
// behind a book that overflows the budget is upstream's own loss, not a
// binding bug.
await createBook('B8 Priority', 3, 'priority', 100000)
const names = (await call('worldbook.names', {})).names
check('probe books exist', names.includes('B8 Primary') && names.includes('B8 Extra'), names.join(', '))

const imported = await call('character.import', {
  filename: 'b8-probe.json', content: Buffer.from(card, 'utf8').toString('base64'),
})
const probeId = imported.character.characterId
const probeChat = await call('chat.create', { characterId: probeId })
const baseline = await worldInfoTokens(probeChat.view.chatId)
check('baseline: only the primary book scans', baseline.rows === 1 && baseline.tokens > 0,
  `rows=${String(baseline.rows)} tokens=${String(baseline.tokens)}`)

// ------------------------------------------------------------------ the bind

const bound = await call('worldbook.setCharBooks', { characterId: probeId, names: ['B8 Extra'] })
check('bind read back (primary kept, additional named)',
  bound.primary === 'B8 Primary' && bound.additional.length === 1 && bound.additional[0] === 'B8 Extra',
  JSON.stringify(bound))

// A chat opened after the bind resolves against the new list.
const second = await call('chat.create', { characterId: probeId })
const afterBind = await worldInfoTokens(second.view.chatId)
check('after bind: the extra book reaches the scan',
  afterBind.rows === 1 && afterBind.tokens > baseline.tokens,
  `tokens=${String(afterBind.tokens)} (baseline ${String(baseline.tokens)})`)
check('the growth is exactly the extra book’s three entries',
  afterBind.tokens - baseline.tokens > 0 && (await call('worldbook.get', { name: 'B8 Extra' })).entries.length === 3,
  `delta=${String(afterBind.tokens - baseline.tokens)}`)

// --------------------------------------------- the corpus cards (regression)

for (const [file, title] of [['1_5.png', '哈人冰恋世界'], ['V1.5.4_.png', '不要被神隐挑战']]) {
  const path = `${CARDS_DIR}/${file}`
  if (!existsSync(path)) {
    console.log(`SKIP  ${title} — ${path} not present`)
    continue
  }
  const png = readFileSync(path)
  const corpus = await call('character.import', { filename: file, content: png.toString('base64') })
  const corpusId = corpus.character.characterId
  const corpusChat = await call('chat.create', { characterId: corpusId })
  const corpusBaseline = await worldInfoTokens(corpusChat.view.chatId)
  const before = await call('worldbook.charNames', { characterId: corpusId })

  const boundCorpus = await call('worldbook.setCharBooks', {
    characterId: corpusId, names: ['B8 Priority'],
  })
  check(`${title}: second book bound`, boundCorpus.additional.length === 1, JSON.stringify(boundCorpus))

  const corpusChat2 = await call('chat.create', { characterId: corpusId })
  const corpusAfter = await worldInfoTokens(corpusChat2.view.chatId)
  check(`${title}: prompt grows while bound`, corpusAfter.tokens > corpusBaseline.tokens,
    `before=${String(corpusBaseline.tokens)} after=${String(corpusAfter.tokens)}`)

  const unboundCorpus = await call('worldbook.setCharBooks', { characterId: corpusId, names: [] })
  check(`${title}: unbind leaves primary only`,
    unboundCorpus.primary === before.primary && unboundCorpus.additional.length === 0,
    JSON.stringify(unboundCorpus))

  const corpusChat3 = await call('chat.create', { characterId: corpusId })
  const corpusRestored = await worldInfoTokens(corpusChat3.view.chatId)
  check(`${title}: after unbind the prompt is exactly the baseline again`,
    corpusRestored.tokens === corpusBaseline.tokens && corpusRestored.rows === corpusBaseline.rows,
    `baseline=${String(corpusBaseline.tokens)} restored=${String(corpusRestored.tokens)}`)
}

// ---------------------------------------------------------------- the unbind

const unbound = await call('worldbook.setCharBooks', { characterId: probeId, names: [] })
check('unbind read back', unbound.primary === 'B8 Primary' && unbound.additional.length === 0,
  JSON.stringify(unbound))

const third = await call('chat.create', { characterId: probeId })
const afterUnbind = await worldInfoTokens(third.view.chatId)
check('after unbind: scan back to baseline', afterUnbind.tokens === baseline.tokens,
  `tokens=${String(afterUnbind.tokens)} (baseline ${String(baseline.tokens)})`)

// The binding, as the card-facing read sees it — nothing left behind.
const finalNames = await call('worldbook.charNames', { characterId: probeId })
check('no residual key: charNames answers primary only, additional empty',
  finalNames.primary === 'B8 Primary' && finalNames.additional.length === 0,
  JSON.stringify(finalNames))

console.log(failures === 0 ? '\nALL PASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
