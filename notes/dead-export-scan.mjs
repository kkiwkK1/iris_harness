// Throwaway dead-export scan (audit working note, not a keeper).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sources = []
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', 'data', 'spike', 'docs', 'notes', 'qa'].includes(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx|mts)$/.test(e.name)) sources.push(p)
  }
}
walk(ROOT)
const corpus = sources.map(p => ({ p: p.split('\\').join('/'), s: readFileSync(p, 'utf8') }))
const dead = []
for (const c of corpus) {
  if (!/\/packages\/[^/]+\/src\//.test(c.p)) continue
  if (/\/src\/index\.ts$/.test(c.p)) continue
  const names = [...new Set([...c.s.matchAll(/export\s+(?:async\s+)?(?:function|class|const|type|interface|enum)\s+([A-Za-z0-9_]+)/g)].map(m => m[1]))]
  for (const name of names) {
    let used = false
    for (const o of corpus) {
      if (o.p === c.p) continue
      if (new RegExp(`\\b${name}\\b`).test(o.s)) { used = true; break }
    }
    if (!used) dead.push(`${c.p} : ${name}`)
  }
}
console.log(dead.join('\n') || '(none)')
console.log('--- files scanned:', corpus.length)
