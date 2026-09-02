import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyCommands } from '../src/apply.ts'
import { scanDialects } from '../src/dialects.ts'
import { applyTemplate, refuseInsert, schemaForPath } from '../src/schema.ts'

/**
 * The `schema` section, which the fold used to ignore entirely.
 *
 * Upstream consults the declaration on every `insert`: it refuses an append the
 * schema does not permit, and it merges a declared `template` into each newly
 * added member. Neither was implemented here, which the corpus shows as 2
 * inserts upstream refuses and we accepted, and 11 whose template upstream
 * merges and we did not.
 *
 * **This is a compatibility fix, not a fidelity one.** Against replay it is
 * worth under a point — the ceiling it moves is 78.8% to 79.7%, because 24 of
 * the 25 measured divergences are writes no command caused. The reason to do it
 * is that the same `applyCommands` runs on every finished turn, so accepting an
 * append upstream refuses writes a divergence into the user's save immediately,
 * and a card carried back to SillyTavern grows differently shaped members.
 */

/** An array that never declared `extensible`: closed, per upstream. */
const CLOSED_ARRAY = {
  type: 'object',
  properties: { 队伍: { type: 'array', elementType: { type: 'string' } } },
}

/** The same array, opened. */
const OPEN_ARRAY = {
  type: 'object',
  properties: { 队伍: { type: 'array', extensible: true, elementType: { type: 'string' } } },
}

test('an array is closed unless the declaration says extensible', () => {
  // Deny by default, and the default is the *absent* flag rather than a false
  // one — an array that simply never mentioned extensibility is closed.
  assert.notEqual(refuseInsert({ type: 'array' }, 2, undefined), undefined)
  assert.notEqual(refuseInsert({ type: 'array', extensible: false }, 2, undefined), undefined)
  assert.equal(refuseInsert({ type: 'array', extensible: true }, 2, undefined), undefined)
})

test('an object is open unless the declaration says otherwise', () => {
  // The opposite polarity from arrays, which is easy to get wrong by symmetry.
  assert.equal(refuseInsert({ type: 'object' }, 2, undefined), undefined)
  assert.equal(refuseInsert({ type: 'object', extensible: true }, 2, undefined), undefined)
  assert.notEqual(refuseInsert({ type: 'object', extensible: false }, 2, undefined), undefined)

  // A closed object still accepts a key it already declares.
  const closed = { type: 'object', extensible: false, properties: { 名字: { type: 'string' } } }
  assert.equal(refuseInsert(closed, 3, '名字'), undefined)
  assert.notEqual(refuseInsert(closed, 3, '新键'), undefined)
})

test('a closed array refuses the append, and says why', () => {
  const before = { initialized_lorebooks: {}, stat_data: { 队伍: ['剑士'] }, schema: CLOSED_ARRAY }
  const result = applyCommands(scanDialects("_.insert('队伍', '法师');").commands, before)

  assert.deepEqual(result.data.stat_data['队伍'], ['剑士'], 'the append went through anyway')
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0]?.reason ?? '', /not marked extensible/u)
})

test('an open array still appends', () => {
  // The other half: a schema-aware fold that refuses everything would pass the
  // test above while breaking every card that declares its arrays properly.
  const before = { initialized_lorebooks: {}, stat_data: { 队伍: ['剑士'] }, schema: OPEN_ARRAY }
  const result = applyCommands(scanDialects("_.insert('队伍', '法师');").commands, before)

  assert.deepEqual(result.data.stat_data['队伍'], ['剑士', '法师'])
  assert.deepEqual(result.failures, [])
})

test('a tree with no schema at all behaves exactly as before', () => {
  // The commonest case by far: 494 of 525 corpus inserts resolve to no schema
  // node. Reading the declaration must not turn "undeclared" into "forbidden".
  const before = { initialized_lorebooks: {}, stat_data: { 队伍: ['剑士'] } }
  const result = applyCommands(scanDialects("_.insert('队伍', '法师');").commands, before)

  assert.deepEqual(result.data.stat_data['队伍'], ['剑士', '法师'])
  assert.deepEqual(result.failures, [])
})

test('the walk does not fall back to an extensible parent’s template', () => {
  /*
   * Upstream's `getSchemaForPath` resolves object keys through `properties`
   * only. A member added at runtime to an `extensible: true` object therefore
   * has no schema of its own, and every rule above is skipped for it.
   *
   * Copied rather than corrected, and pinned here because it looked exactly
   * like a bug: a corpus append into `命定之人.<runtime member>.职业` appeared to
   * be a schema refusal until this walk was traced. "Improving" it would refuse
   * writes upstream accepts — a divergence in the direction that loses data.
   */
  const schema = {
    type: 'object',
    properties: {
      命定之人: {
        type: 'object',
        extensible: true,
        properties: {},
        template: { 职业: { type: 'array' } },
      },
    },
  }
  assert.equal(schemaForPath(schema, '命定之人.伊芙琳.职业'), undefined)
  // And so the append is permitted, because no node means no rule.
  assert.equal(refuseInsert(schemaForPath(schema, '命定之人.伊芙琳.职业'), 2, undefined), undefined)
})

test('a template fills in what the model left out, and never overrides it', () => {
  const template = { 关系: '未知', 备注: '', 当前地点: '未知' }

  // The model's own fields win; the template only supplies the missing ones.
  assert.deepEqual(
    applyTemplate({ 关系: '俘虏', 身份: '幸存者' }, template),
    { 关系: '俘虏', 备注: '', 当前地点: '未知', 身份: '幸存者' },
  )

  // Absent template: identity, not an empty merge.
  assert.deepEqual(applyTemplate({ a: 1 }, undefined), { a: 1 })

  // Shape mismatches are left alone rather than coerced — upstream logs and
  // returns the value, and inventing a conversion would put a shape into the
  // tree neither side produces.
  assert.equal(applyTemplate('剑士', { 关系: '未知' }), '剑士')
  assert.deepEqual(applyTemplate(['a'], ['z']), ['a', 'z'])
  assert.deepEqual(applyTemplate('a', ['z']), ['a', 'z'])
})

test('a template does not leak between inserts', () => {
  // The template is shared structure; merging into it rather than into a copy
  // would make the second insert inherit the first one's fields.
  const template = { 备注: '' }
  const first = applyTemplate({ 身份: 'A' }, template) as Record<string, unknown>
  first['备注'] = 'scribbled'
  const second = applyTemplate({ 身份: 'B' }, template) as Record<string, unknown>

  assert.equal(second['备注'], '', 'the template carried a previous insert’s value')
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

test('the real declarations resolve, and the two rules reach real inserts', async (t) => {
  if (!existsSync(CHATS)) {
    t.skip('no corpus on this machine')
    return
  }

  let inserts = 0
  let resolved = 0
  let refused = 0
  let templated = 0

  for (const file of await chatFiles(CHATS)) {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      if (line.trim() === '') continue
      let message: { mes?: unknown, is_user?: unknown, variables?: unknown, swipe_id?: unknown }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        continue
      }
      if (typeof message.mes !== 'string' || message.is_user === true) continue
      const tables = Array.isArray(message.variables) ? message.variables : undefined
      const table = tables?.[typeof message.swipe_id === 'number' ? message.swipe_id : 0] ?? tables?.[0]
      const schema = (table as { schema?: unknown } | undefined)?.schema
      if (schema === undefined) continue

      for (const command of scanDialects(message.mes).commands) {
        if (command.type !== 'insert') continue
        inserts += 1
        const target = String(command.args[0] ?? '').replace(/^['"]|['"]$/gu, '')
        const node = schemaForPath(schema, target)
        if (node === undefined) continue
        resolved += 1
        if (refuseInsert(node, command.args.length, undefined) !== undefined) refused += 1
        if (node.template !== undefined) templated += 1
      }
    }
  }

  // Lower bounds, because the interesting direction is emptiness: a walker that
  // resolves nothing would report zero refusals and zero templates and look
  // exactly like a corpus that needs neither rule. That is not hypothetical —
  // the first version of this census had a broken walk and reported 494 of 525
  // paths unresolved, which read like a finding.
  assert.ok(inserts >= 50, `only ${String(inserts)} inserts in schema-carrying chats`)
  assert.ok(resolved >= 20, `only ${String(resolved)} insert targets resolved; the walk may be broken`)
  assert.ok(refused >= 1, 'no corpus insert exercised the extensible rule')
  assert.ok(templated >= 5, `only ${String(templated)} inserts reached a template`)
})
