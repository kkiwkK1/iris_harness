/**
 * The tree map's lane palette, computed in every theme from the stylesheets
 * themselves.
 *
 * `tree-map.css` derives the six lane colours from theme tokens
 * (`var(...)` and `color-mix(in srgb, …)`), so what a lane looks like in 雪,
 * 墨 and 宣 is decided by `tokens.css`. This test reads both files, resolves
 * each lane token under each theme, and holds the properties the map needs:
 * every lane is legible on the page (3:1, the non-text floor), no two lanes
 * look alike, and none is mistakable for the accent, which is the reader's
 * path drawn on top.
 *
 * @module iris-web/tests/tree-lane-palette
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { LANE_HUES } from '../src/app/tree-map.ts'

const TOKENS = new URL('../src/theme/tokens.css', import.meta.url)
const TREE_CSS = new URL('../src/app/tree-map.css', import.meta.url)

type Rgb = [number, number, number]

/** Every `--name: value;` declared inside the blocks a selector opens, in order. */
function declarations(css: string, selector: string): Map<string, string> {
  const found = new Map<string, string>()
  let from = 0
  for (;;) {
    const at = css.indexOf(`${selector} {`, from)
    if (at < 0) break
    const end = css.indexOf('\n}', at)
    const body = css.slice(at, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//gu, '')
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) found.set(match[1] ?? '', (match[2] ?? '').trim())
    from = end < 0 ? css.length : end
  }
  return found
}

function hex(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/iu.exec(value.trim())
  assert.ok(match !== null, `not a #rrggbb colour: ${value}`)
  const n = Number.parseInt(match[1] ?? '', 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Resolve a lane expression to a colour, the way the browser would on `:root`. */
function resolve(value: string, table: ReadonlyMap<string, string>, depth = 0): Rgb {
  assert.ok(depth < 8, `a var() chain that does not end: ${value}`)
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/u.exec(v)
  if (ref !== null) {
    const next = table.get(ref[1] ?? '')
    assert.ok(next !== undefined, `no token ${ref[1] ?? ''}`)
    return resolve(next, table, depth + 1)
  }
  const mix = /^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+(\d+)%,\s*(var\(--[\w-]+\))\)$/u.exec(v)
  if (mix !== null) {
    const a = resolve(mix[1] ?? '', table, depth + 1)
    const b = resolve(mix[3] ?? '', table, depth + 1)
    const p = Number(mix[2]) / 100
    return [0, 1, 2].map(i => Math.round((a[i] ?? 0) * p + (b[i] ?? 0) * (1 - p))) as Rgb
  }
  return hex(v)
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

test('every lane colour is legible, distinct, and not the accent, in 雪, 墨 and 宣', async () => {
  const tokens = await readFile(TOKENS, 'utf8')
  const lanes = declarations(await readFile(TREE_CSS, 'utf8'), ':root')
  const light = declarations(tokens, ':root')
  const themes: Record<string, Map<string, string>> = {
    雪: light,
    墨: new Map([...light, ...declarations(tokens, ":root[data-iris-theme='dark']")]),
    宣: new Map([...light, ...declarations(tokens, ":root[data-iris-theme='parchment']")]),
  }
  const names = Array.from({ length: LANE_HUES }, (_, at) => `--iris-lane-${String(at)}`)
  // Premise: the reader found the palette, so an empty table cannot pass.
  for (const name of [...names, '--iris-lane-trunk']) assert.ok(lanes.has(name), `tree-map.css does not define ${name}`)
  assert.ok(themes['墨']?.get('--iris-meter-slate') !== light.get('--iris-meter-slate'), 'the dark block was not read')

  let checked = 0
  for (const [theme, table] of Object.entries(themes)) {
    const withLanes = new Map([...table, ...lanes])
    const page = resolve('var(--iris-bg-page)', withLanes)
    const accent = resolve('var(--iris-accent)', withLanes)
    const colours = names.map(name => resolve(`var(${name})`, withLanes))
    colours.forEach((colour, at) => {
      const ratio = contrast(colour, page)
      assert.ok(ratio >= 3, `${theme} lane ${String(at)} is ${ratio.toFixed(2)}:1 on the page`)
      assert.ok(distance(colour, accent) >= 60, `${theme} lane ${String(at)} is too close to the accent`)
      for (let other = at + 1; other < colours.length; other += 1) {
        const apart = distance(colour, colours[other] as Rgb)
        assert.ok(apart >= 30, `${theme} lanes ${String(at)} and ${String(other)} are ${apart.toFixed(0)} apart`)
      }
      checked += 1
    })
    const trunk = resolve('var(--iris-lane-trunk)', withLanes)
    assert.ok(contrast(trunk, page) >= 3, `${theme} trunk is ${contrast(trunk, page).toFixed(2)}:1 on the page`)
  }
  assert.equal(checked, LANE_HUES * 3)
})
