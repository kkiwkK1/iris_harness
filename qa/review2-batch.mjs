// Batch runner for the REVIEW-2 pass: runs review2-drive.mjs per card, saves
// the full log under review2/, and prints one compact line per card.
//
// Usage: node qa/results/review2-batch.mjs <cardsFile>
// cardsFile: one `id|displayName|flags` per line.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const file = process.argv[2]
const lines = readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#'))
for (const line of lines) {
  const [id, displayName, flags = ''] = line.split('|')
  const slug = id.replace(/[^\p{L}\p{N}-]+/gu, '-').slice(0, 48)
  const args = ['qa/review2-drive.mjs', id, displayName, ...flags.split(' ').filter(Boolean)]
  const started = Date.now()
  console.log(`\n######## ${id} (${displayName}) ${flags} ########`)
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  appendFileSync(`qa/results/review2/${slug}.log`, out)
  const keep = out.split('\n').filter(l => /^(scriptsAllowed|chat:|greeting:|turn:|reply:|iframe probes|  - about|itemize:|vars after|view vars|new host reports|  - #|console errors|  !|http>=400|  # http|cardScriptsText:|results ->|\$ )/.test(l))
  console.log(keep.join('\n'))
  console.log(`[exit ${String(r.status)} in ${String(Math.round((Date.now() - started) / 1000))}s]`)
}
