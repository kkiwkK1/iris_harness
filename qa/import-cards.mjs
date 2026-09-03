// Import the six real cards plus the four known non-card files, and record
// what the host did with each. Expected: six imports succeed, four are refused
// with a named error (those files are images/persona art, not character cards).
//
// Usage: node qa/import-cards.mjs [corpusDir]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { call, rpc } from './rpc.mjs'

const dir = process.argv[2] ?? 'D:/workspace/小项目/iris_分支/测试用卡'

// The six cards under acceptance, by file name (order = report order).
const CARDS = new Set([
  'V1.5.4_.png', // 不要被神隐挑战
  '2.1.0.png', // 灭仇家满门之后…
  '1_5.png', // 哈人冰恋世界
  '2.png', // 绿茵好莱坞
  'v0.5NSFW.png', // 尸变纪元
  'Lights_ON.png', // Lights ON
])

const rows = []
const files = readdirSync(dir).filter(f => /\.(png|webp|jpg|jpeg|json|charx)$/i.test(f)).sort()
for (const file of files) {
  const content = readFileSync(join(dir, file)).toString('base64')
  const frame = await rpc('character.import', { filename: file, content })
  const row = { file, expectedCard: CARDS.has(file) }
  if (frame.ok === false) {
    row.imported = false
    row.error = { code: frame.error?.code, message: frame.error?.message }
  } else {
    row.imported = true
    row.characterId = frame.result.character.characterId ?? frame.result.character.id
    row.name = frame.result.character.name
  }
  rows.push(row)
  console.log(`${row.imported ? 'OK   ' : 'REFUS'} ${file} -> ${row.imported ? `${JSON.stringify(row.name)} id=${row.characterId}` : `${row.error?.code}: ${row.error?.message}`}`)
}

const list = await call('character.list', {})
console.log(`\nregistered ${list.characters.length} character(s):`)
for (const c of list.characters) console.log(`  ${c.characterId}  ${JSON.stringify(c.name)}`)

writeFileSync(new URL('./state.json', import.meta.url), JSON.stringify({ imported: rows, characters: list.characters }, null, 2))
console.log('\nstate written to qa/state.json')
