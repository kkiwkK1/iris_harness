/**
 * A notice re-renders the notice bar, not the shell (web §131).
 *
 * Measured on 黑兽 (qa/stream-perf-acceptance.mjs, 2026-09-26): interface
 * frames booting while a reply streamed posted one CSP refusal of a web font
 * per shell commit — 476 per frame — and each refusal raised a notice. `App`
 * selected `state.notice`, so every one re-rendered the whole shell: 1 435
 * whole-tree commits in a 20-second stream, the main thread blocked for
 * 14–17 s, and a reply that looked stuck while its frames queued.
 *
 * Asserted at the source, in the style of the combined-claim tests, because
 * the property is *who subscribes*, which only the source shows: the one
 * `state.notice` selector in the app lives inside `NoticeBar`, and `App`'s own
 * body reads none.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('../src/app/', import.meta.url))

test('state.notice has one subscriber, the notice bar, and the shell is not it', () => {
  const selector = /state\s*=>\s*state\.notice\b(?!Log|sDropped)/g
  const subscribers: string[] = []
  for (const name of readdirSync(appDir)) {
    if (!name.endsWith('.tsx')) continue
    const source = readFileSync(`${appDir}${name}`, 'utf8')
    for (const _ of source.matchAll(selector)) subscribers.push(name)
  }
  assert.deepEqual(subscribers, ['App.tsx'], 'exactly one selector of state.notice in the app')

  const app = readFileSync(`${appDir}App.tsx`, 'utf8')
  const bar = app.indexOf('function NoticeBar(')
  assert.ok(bar > 0, 'the notice bar is its own component')
  const at = app.search(selector)
  assert.ok(at > bar, 'and the selector is inside it, not in the shell above it')
  const start = app.indexOf('export function App(')
  const shell = app.slice(start, app.indexOf('\n}\n', start))
  assert.doesNotMatch(shell, /state\.notice\b(?!Log|sDropped)/, 'the shell reads no notice')
  assert.match(shell, /<NoticeBar \/>/, 'the shell mounts the bar')
})
