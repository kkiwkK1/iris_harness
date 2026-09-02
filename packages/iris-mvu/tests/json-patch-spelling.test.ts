import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { scanJsonPatch } from '../src/json-patch.ts'

/**
 * Which spellings of the block tag this dialect actually answers to.
 *
 * The previous pattern was `/<JSONPatch>…<\/JSONPatch>/gi` — case-insensitive,
 * which reads as tolerant. It is not: `<json_patch>` does not match it, and
 * models write that spelling. Upstream matches `json_?patch`
 * (`update_variables.ts:296`) and says why in a comment — 「主要有两种情况，
 * llm加了 `<json_patch>` 和没有加的情况」.
 *
 * Measured before the fix: of 156 corpus floors carrying a patch block, 22 used
 * the underscore, and **21 floors produced no block, no rejection and no
 * report** — a reply that asked for a state change read as a reply that asked
 * for nothing. The cost is not one floor: each fold is the next fold's
 * baseline, so a single missed block moves every later floor.
 *
 * The teeth here are aimed at exactly that blind spot. A test for `<JSONPatch>`
 * would have passed before the fix and proves only that the new pattern is no
 * worse than the old one.
 */

/** Built from char codes: `<` `j` … `_` … so the underscore cannot be typed away. */
const UNDERSCORE = String.fromCharCode(95)
const OPEN_U = `<json${UNDERSCORE}patch>`
const CLOSE_U = `</json${UNDERSCORE}patch>`
const OPS = '[{"op":"replace","path":"/世界信息/年历","value":"阿拉德历990年3月1日"}]'

test('the underscore fixture is what it claims to be', () => {
  // The guard the fixture needs, not the one the code needs: a fixture whose
  // meaning rests on one invisible character has to assert that character, or
  // the test and its teeth-check go quiet together.
  assert.equal(OPEN_U.charCodeAt(5), 95, 'the fixture lost its underscore')
  assert.equal(OPEN_U, '<json_patch>')
  assert.equal(CLOSE_U, '</json_patch>')
})

test('the underscore spelling is read, not silently ignored', () => {
  const scan = scanJsonPatch(`prose${OPEN_U}${OPS}${CLOSE_U}more prose`)

  assert.equal(scan.blocks, 1, 'the block was invisible — this is the regression')
  assert.equal(scan.operations, 1)
  assert.deepEqual(scan.rejected, [])
  assert.equal(scan.commands.length, 1)
})

test('both spellings produce the same commands', () => {
  const underscore = scanJsonPatch(`${OPEN_U}${OPS}${CLOSE_U}`)
  const plain = scanJsonPatch(`<JSONPatch>${OPS}</JSONPatch>`)

  // Same reply, two spellings a model picks between at random. If they ever
  // disagree, state depends on which one the model happened to emit.
  assert.deepEqual(underscore.commands, plain.commands)
  assert.equal(underscore.operations, plain.operations)
})

test('a fenced body is unwrapped, as upstream unwraps it', () => {
  const fence = String.fromCharCode(96, 96, 96)
  const scan = scanJsonPatch(`<JSONPatch>${fence}json\n${OPS}\n${fence}</JSONPatch>`)

  // Mirrored from upstream's pattern rather than measured: the corpus carries
  // zero fenced blocks. Compatibility cover, and recorded as such so nobody
  // later reads this test as evidence that models do it.
  assert.equal(scan.blocks, 1)
  assert.equal(scan.operations, 1)
  assert.deepEqual(scan.rejected, [])
})

test('the closing tag must agree with the opening one', () => {
  // Upstream's backreference. A mismatched pair matches neither there nor here;
  // pinned so that "tolerate everything" cannot be introduced as an
  // improvement without someone deciding to diverge on purpose.
  const scan = scanJsonPatch(`${OPEN_U}${OPS}</JSONPatch>`)
  assert.equal(scan.blocks, 0)
})

const CHATS = `${process.env['IRIS_CORPUS'] ?? 'E:/sillyTavern/SillyTavern'}/data/default-user/chats`

/** Every `.jsonl` under the corpus chat tree. */
async function chatFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) found.push(...await chatFiles(path))
    else if (item.name.endsWith('.jsonl')) found.push(path)
  }
  return found
}

test('no corpus reply carries a patch block that reads as nothing at all', async (t) => {
  if (!existsSync(CHATS)) {
    t.skip('no corpus on this machine')
    return
  }

  let carrying = 0
  let underscored = 0
  const silent: string[] = []

  for (const file of await chatFiles(CHATS)) {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (line.trim() === '') continue
      let message: { mes?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue
      }
      if (typeof message.mes !== 'string') continue
      const lowered = message.mes.toLowerCase()
      const hasOpen = lowered.includes(OPEN_U) || lowered.includes('<jsonpatch>')
      if (!hasOpen) continue
      carrying += 1
      if (lowered.includes(OPEN_U)) underscored += 1

      const scan = scanJsonPatch(message.mes)
      // Silence is the failure, not rejection. A block we read and refused is a
      // reportable event; a block we never saw is indistinguishable from a
      // reply that asked for nothing.
      if (scan.blocks === 0 && scan.rejected.length === 0) silent.push(file)
    }
  }

  // Lower bounds, because a negative result needs them most: "0 silent floors"
  // is equally true of a scan that examined nothing, and this scan's own bug
  // was that it produced no rows to be suspicious of. Floors, not an exact
  // pin — the corpus grows, and only the empty direction is unsafe.
  assert.ok(carrying >= 100, `only ${String(carrying)} floors carried a block; the scan found nothing to judge`)
  assert.ok(underscored >= 20, `only ${String(underscored)} underscore floors; the spelling under test was not exercised`)
  assert.deepEqual(silent.slice(0, 3), [], `${String(silent.length)} floors carried a block that read as silence`)
})
