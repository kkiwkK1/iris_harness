import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyCommands } from '../src/apply.ts'
import { scanDialects } from '../src/dialects.ts'
import { extractJsonPatch, pointerToPath, scanJsonPatch } from '../src/json-patch.ts'

/**
 * The `<JSONPatch>` dialect.
 *
 * The unit tests below are written from the card's own specification, and the
 * last one is the only one that could have caught the bug they exist because of:
 * every `_.verb()` test in this package passed while cards using this dialect
 * folded nothing, because the fixtures were written in the dialect the code
 * already read. So the acceptance test takes its input from a reply a real model
 * produced against a real SillyTavern, and takes it **from disk at run time**
 * rather than copying it in — the corpus tree carries explicit content, and a
 * fixture that lives on the user's disk keeps the repository holding shapes.
 */

const CHATS = 'E:/sillyTavern/SillyTavern/data/default-user/chats/爱衣'

/** The first real reply on this machine that answered in this dialect. */
async function findRealPatch(): Promise<unknown[] | undefined> {
  if (!existsSync(CHATS)) return undefined
  for (const file of await readdir(CHATS)) {
    let text: string
    try {
      text = await readFile(join(CHATS, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      let message: { mes?: unknown, is_user?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue
      }
      if (message.is_user === true || typeof message.mes !== 'string') continue
      const found = scanJsonPatch(message.mes)
      if (found.blocks > 0 && found.commands.length > 0) return found.commands as unknown[]
    }
  }
  return undefined
}

const REAL = await findRealPatch()

test('a reply a real model wrote is understood, and folds', { skip: REAL === undefined }, async () => {
  // Re-scanned here rather than trusting the search above, so the assertion is
  // about the dialect reader and not about the helper that found the file.
  const commands = REAL as { type: string, args: string[] }[]
  assert.ok(commands.length >= 3, `expected the recorded reply's operations, got ${String(commands.length)}`)

  // Shapes only: every operation became a canonical verb with a lodash path.
  for (const command of commands) {
    assert.ok(['set', 'add', 'insert', 'delete', 'move'].includes(command.type), `unknown verb ${command.type}`)
    assert.equal(typeof command.args[0], 'string')
    assert.equal(command.args[0]?.includes('/'), false, 'a JSON Pointer reached the command model unconverted')
  }

  // And they fold: applied to a tree carrying those paths, the state changes.
  const baseline = { initialized_lorebooks: {}, stat_data: {} as Record<string, unknown> }
  for (const command of commands) {
    // Build just enough tree for each path to exist, since `set` refuses a path
    // that does not — which is upstream's rule and not this test's business.
    const segments = (command.args[0] ?? '').split('.')
    let node = baseline.stat_data
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) node[segment] = 0
      else node = (node[segment] ??= {}) as Record<string, unknown>
    }
  }
  const result = applyCommands(commands as never, baseline)
  assert.equal(result.changed, true, 'a real reply produced no change')
  assert.deepEqual(result.failures, [], 'a real reply produced failures')
})

test('every operation the card defines maps onto a verb', () => {
  const text = `<JSONPatch>
[
  { "op": "replace", "path": "/world/time", "value": "15:30" },
  { "op": "delta", "path": "/hero/hp", "value": -3 },
  { "op": "insert", "path": "/hero/bag/-", "value": "rope" },
  { "op": "insert", "path": "/hero/flags/seen", "value": true },
  { "op": "remove", "path": "/hero/curse" },
  { "op": "move", "from": "/hero/bag", "to": "/hero/pack" }
]
</JSONPatch>`
  assert.deepEqual(
    extractJsonPatch(text).map(command => [command.type, ...command.args]),
    [
      ['set', 'world.time', '"15:30"'],
      ['add', 'hero.hp', '-3'],
      // `-` is the card's append token, so the command addresses the container.
      ['insert', 'hero.bag', '"rope"'],
      // A named member becomes the three-argument insert: container, key, value.
      ['insert', 'hero.flags', '"seen"', 'true'],
      ['delete', 'hero.curse'],
      ['move', 'hero.bag', 'hero.pack'],
    ],
  )
})

test('the operations do what the verbs mean', () => {
  const baseline = {
    initialized_lorebooks: {},
    stat_data: { world: { time: '15:00' }, hero: { hp: 10, bag: ['torch'], flags: {}, curse: true } },
  }
  const text = `<JSONPatch>
[
  { "op": "replace", "path": "/world/time", "value": "15:30" },
  { "op": "delta", "path": "/hero/hp", "value": -3 },
  { "op": "insert", "path": "/hero/bag/-", "value": "rope" },
  { "op": "insert", "path": "/hero/flags/seen", "value": true },
  { "op": "remove", "path": "/hero/curse" }
]
</JSONPatch>`
  const result = applyCommands(extractJsonPatch(text), baseline)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.data.stat_data, {
    world: { time: '15:30' },
    hero: { hp: 7, bag: ['torch', 'rope'], flags: { seen: true } },
  })
})

test('move takes the value with it', () => {
  const text = '<JSONPatch>[{ "op": "move", "from": "/a/b", "to": "/c" }]</JSONPatch>'
  const result = applyCommands(extractJsonPatch(text), {
    initialized_lorebooks: {},
    stat_data: { a: { b: 42 }, c: 0 },
  })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.data.stat_data, { a: {}, c: 42 })
  // The card spells it `from`/`to`; the RFC spells the destination `path`, and a
  // model that has read the RFC writes that instead. Both are accepted.
  const rfc = extractJsonPatch('<JSONPatch>[{ "op": "move", "from": "/a", "path": "/b" }]</JSONPatch>')
  assert.deepEqual(rfc[0]?.args, ['a', 'b'])
})

test('a JSON Pointer becomes a lodash path, escapes and indices included', () => {
  assert.equal(pointerToPath('/world/time'), 'world.time')
  // RFC 6901: `~1` is `/` and `~0` is `~`, decoded in that order.
  assert.equal(pointerToPath('/a~1b/c~0d'), 'a/b.c~d')
  // A numeric segment is an array index, not an object key, or `remove` would
  // leave a hole where it should drop the element.
  assert.equal(pointerToPath('/team/0/name'), 'team[0].name')
  assert.equal(pointerToPath(''), '')
})

test('a value carrying an apostrophe survives as a value', () => {
  // The reason `CommandInfo.values` exists. `evaluateLiteral` parses object
  // literals by swapping `'` for `"`, so this object would come back as the
  // text of its own JSON — silently, as a string where a tree belongs.
  const text = '<JSONPatch>[{ "op": "replace", "path": "/note", "value": { "text": "don\'t" } }]</JSONPatch>'
  const result = applyCommands(extractJsonPatch(text), {
    initialized_lorebooks: {},
    stat_data: { note: {} },
  })
  assert.deepEqual(result.data.stat_data['note'], { text: "don't" })
})

test('what cannot be read is reported rather than dropped in silence', () => {
  // The whole reason this channel exists: for a release, models emitted these
  // blocks, nothing understood them, and there was nowhere for that to show up.
  const broken = scanJsonPatch('<JSONPatch>[{ "op": "replace" ]</JSONPatch>')
  assert.equal(broken.blocks, 1)
  assert.deepEqual(broken.commands, [])
  assert.equal(broken.rejected.length, 1)
  assert.match(broken.rejected[0] ?? '', /not valid JSON/u)

  const unknown = scanJsonPatch('<JSONPatch>[{ "op": "increment", "path": "/a", "value": 1 }]</JSONPatch>')
  assert.deepEqual(unknown.commands, [])
  assert.match(unknown.rejected[0] ?? '', /unknown op "increment"/u)

  const notArray = scanJsonPatch('<JSONPatch>{ "op": "replace" }</JSONPatch>')
  assert.match(notArray.rejected[0] ?? '', /expected an array/u)

  const missingValue = scanJsonPatch('<JSONPatch>[{ "op": "replace", "path": "/a" }]</JSONPatch>')
  assert.match(missingValue.rejected[0] ?? '', /needs a value/u)
})

test('a reply with no block at all reports no block', () => {
  // `blocks === 0` and `blocks > 0 with no commands` are different situations —
  // the model did not answer, versus we could not read the answer — and the
  // caller reports only the second.
  const quiet = scanJsonPatch('She closed the map and said nothing.')
  assert.deepEqual(quiet, { commands: [], blocks: 0, operations: 0, rejected: [] })
})

test('an empty block is an answer, not a failure to read one', () => {
  // `<JSONPatch>[]</JSONPatch>` is a model saying "nothing changed this turn" —
  // a correct answer, and the ordinary one on a quiet turn. Counted only by
  // blocks it is indistinguishable from a dialect nobody understands, and the
  // host would warn about a parser that is working perfectly.
  //
  // This is the empty-set edge: the failure it would cause is a *report* rather
  // than a wrong value, so nothing observable breaks and the noise is blamed on
  // the model.
  const empty = scanJsonPatch('<JSONPatch>[]</JSONPatch>')
  assert.equal(empty.blocks, 1, 'the block was there')
  assert.equal(empty.operations, 0, 'and it asked for nothing')
  assert.deepEqual(empty.rejected, [])

  // The contrast: operations present, none usable. That is worth saying aloud.
  const unreadable = scanJsonPatch('<JSONPatch>[{ "op": "increment", "path": "/a", "value": 1 }]</JSONPatch>')
  assert.equal(unreadable.operations, 1)
  assert.deepEqual(unreadable.commands, [])
})

test('the legacy dialect still reads, and both can be read at once', () => {
  const legacy = scanDialects("_.set('world.time', '15:30');")
  assert.equal(legacy.legacyCommands, 1)
  assert.equal(legacy.jsonPatchBlocks, 0)
  assert.equal(legacy.commands.length, 1)

  // A card asks for one dialect or the other, so this is not a shape the corpus
  // produces — but reading only one of them is exactly the bug this fixes, and
  // the counts are reported so a reply using both is noticeable rather than
  // quietly half-applied.
  const both = scanDialects("_.set('a', 1);\n<JSONPatch>[{ \"op\": \"replace\", \"path\": \"/b\", \"value\": 2 }]</JSONPatch>")
  assert.equal(both.legacyCommands, 1)
  assert.equal(both.jsonPatchBlocks, 1)
  assert.equal(both.commands.length, 2)
})

test('a block is found without the <UpdateVariable> wrapper the card asks for', () => {
  // Observed in production, first compliant reply: the model emitted the
  // JSONPatch block with **no** `<UpdateVariable>` shell at all, nested inside
  // its own `<details>` HTML. The card's format spec shows the wrapper, so an
  // implementation written from that spec — requiring the shell, or parsing
  // inside it — reads this real reply as "no update" and folds nothing, exactly
  // the silence this whole dialect was added to end.
  //
  // Scanning the whole message is upstream's rule for the legacy dialect too
  // (`commands.ts`: the wrapper is advisory). This pins it for the new one,
  // where the temptation to anchor on the shell is much stronger because the
  // card documents it.
  const reply = [
    'She looked at the clock.',
    '<details><summary>state</summary>',
    '<JSONPatch>',
    '[ { "op": "replace", "path": "/world/time", "value": "20:00" } ]',
    '</JSONPatch>',
    '</details>',
  ].join('\n')

  const result = applyCommands(extractJsonPatch(reply), {
    initialized_lorebooks: {},
    stat_data: { world: { time: '15:00' } },
  })
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.data.stat_data, { world: { time: '20:00' } })

  // And the wrapper, when a model does write it, changes nothing.
  const wrapped = extractJsonPatch(`<UpdateVariable>${reply}</UpdateVariable>`)
  assert.equal(wrapped.length, 1)
})

test('an RFC operation this dialect lacks is refused by the right name', () => {
  // A model that has read RFC 6902 rather than the card writes `add`, and it is
  // not inventing anything: `add` is the standard's own name for what this
  // dialect calls `insert`. "unknown op" would blame it for the difference
  // between two specifications.
  const added = scanJsonPatch('<JSONPatch>[{ "op": "add", "path": "/a", "value": 1 }]</JSONPatch>')
  assert.match(added.rejected[0] ?? '', /RFC 6902 calls this "add"/u)
  assert.match(added.rejected[0] ?? '', /"insert"/u, 'the refusal does not say what to write instead')

  for (const op of ['copy', 'test']) {
    const result = scanJsonPatch(`<JSONPatch>[{ "op": "${op}", "path": "/a", "value": 1 }]</JSONPatch>`)
    assert.match(result.rejected[0] ?? '', /RFC 6902/u, `${op} was reported as an invention`)
  }

  // And a name that really is nobody's stays a plain unknown. Over-attributing
  // would move the blame from one innocent party to another.
  assert.match(
    scanJsonPatch('<JSONPatch>[{ "op": "increment", "path": "/a", "value": 1 }]</JSONPatch>').rejected[0] ?? '',
    /unknown op "increment"/u,
  )
})
