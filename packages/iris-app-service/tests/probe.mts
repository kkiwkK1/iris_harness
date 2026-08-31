import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeCardPng } from '@iris/character'
import { extractScripts } from '@iris/script'

const DIR = 'E:/sillyTavern/SillyTavern/data/default-user/characters'
const WINDOW = 90

let sites = 0
for (const name of (await readdir(DIR)).filter(entry => entry.endsWith('.png'))) {
  let card
  try {
    card = decodeCardPng(await readFile(join(DIR, name)))
  } catch {
    continue
  }
  for (const script of extractScripts(card).scripts) {
    let at = script.content.indexOf('display_data')
    while (at !== -1) {
      sites += 1
      const text = script.content.slice(Math.max(0, at - WINDOW), at + 40).replace(/\s+/gu, ' ')
      console.log(`\n--- ${name} :: ${script.name} ---\n${text}`)
      at = script.content.indexOf('display_data', at + 1)
    }
  }
}
console.log(`\ntotal display_data sites in card scripts: ${String(sites)}`)
