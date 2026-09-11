import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertNoForbiddenKeys,
  assertPathWritable,
  deletePath,
  findForbiddenKey,
  forbiddenSegmentIn,
  ForbiddenKeyError,
  insertMissing,
  insertOrAssign,
  isForbiddenKey,
  memoryBackend,
  pathSegments,
  VariableStore,
} from '../src/index.ts'

/** The three, and a sample of names that merely look dangerous. */
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'] as const

test('the predicate names exactly three keys', () => {
  for (const name of FORBIDDEN) assert.equal(isForbiddenKey(name), true, name)
  // Neighbours that must stay ordinary: a card's 构造 field, a name that
  // contains one of the three, and the casings JavaScript does not treat as
  // the same property.
  for (const ok of ['proto', '__proto', 'proto__', 'Constructor', 'PROTOTYPE',
    'constructors', 'my_prototype', '构造', 'stat_data', '']) {
    assert.equal(isForbiddenKey(ok), false, ok)
  }
})

test('a path is split the way lodash splits one, brackets and quotes included', () => {
  assert.deepEqual(pathSegments('角色.络络.好感度'), ['角色', '络络', '好感度'])
  assert.deepEqual(pathSegments('队伍[0].name'), ['队伍', '0', 'name'])
  assert.deepEqual(pathSegments('a["__proto__"].b'), ['a', '__proto__', 'b'])
  assert.deepEqual(pathSegments("a['constructor']"), ['a', 'constructor'])
})

test('a forbidden segment is found wherever it sits in the path', () => {
  assert.equal(forbiddenSegmentIn('__proto__'), '__proto__')
  assert.equal(forbiddenSegmentIn('__proto__.x'), '__proto__')
  assert.equal(forbiddenSegmentIn('a.__proto__.b'), '__proto__')
  assert.equal(forbiddenSegmentIn('a.b.constructor'), 'constructor')
  assert.equal(forbiddenSegmentIn('a.constructor.prototype.x'), 'constructor')
  assert.equal(forbiddenSegmentIn('a["__proto__"].b'), '__proto__')
  assert.equal(forbiddenSegmentIn('队伍[0].__proto__'), '__proto__')
  // Ordinary paths answer nothing, which is the half a too-wide rule breaks.
  assert.equal(forbiddenSegmentIn('角色.络络.好感度'), undefined)
  assert.equal(forbiddenSegmentIn('队伍[0].name'), undefined)
  assert.equal(forbiddenSegmentIn('a.my_prototype.b'), undefined)
})

test('the walker reaches a forbidden key nested in objects and in arrays, and names its path', () => {
  // Built with JSON so that `__proto__` is an own data property, which is the
  // shape that actually crosses the wire. An object literal would have moved
  // the prototype instead and tested a different thing.
  const nested = JSON.parse('{"a":{"b":{"__proto__":{"polluted":1}}}}') as unknown
  assert.equal(findForbiddenKey(nested, 'variables'), 'variables.a.b.__proto__')

  const inArray = JSON.parse('{"队伍":[{"name":"络络"},{"constructor":1}]}') as unknown
  assert.equal(findForbiddenKey(inArray, 'variables'), 'variables.队伍[1].constructor')

  const atRoot = JSON.parse('{"prototype":{}}') as unknown
  assert.equal(findForbiddenKey(atRoot, 'v'), 'v.prototype')

  // A tree with none of them answers nothing, at every depth an ordinary card
  // reaches.
  assert.equal(findForbiddenKey({ 角色: { 络络: { 好感度: 5, 标签: ['a', 'b'] } } }), undefined)
  assert.equal(findForbiddenKey([1, 'two', null, { three: true }]), undefined)
  assert.equal(findForbiddenKey('a string'), undefined)
})

test('the walker catches a prototype that has already been moved', () => {
  // `{ __proto__: … }` in source is not an own key at all, so an own-key loop
  // walks straight past it. This is the shape a *host-side* caller can build.
  const moved = { a: { __proto__: { polluted: 1 } } }
  assert.equal(findForbiddenKey(moved, 'v'), 'v.a.__proto__')
})

test('a self-referential tree terminates instead of recursing forever', () => {
  const loop: Record<string, unknown> = { a: 1 }
  loop['self'] = loop
  assert.equal(findForbiddenKey(loop), undefined)
})

test('the assertions raise ForbiddenKeyError naming the offending path', () => {
  assert.throws(
    () => { assertNoForbiddenKeys(JSON.parse('{"a":{"__proto__":1}}'), 'variables') },
    (error: unknown) => error instanceof ForbiddenKeyError
      && error.keyPath === 'variables.a.__proto__'
      && /variables\.a\.__proto__/.test(error.message),
  )
  assert.throws(
    () => { assertPathWritable('a.constructor.b') },
    (error: unknown) => error instanceof ForbiddenKeyError && /a\.constructor\.b/.test(error.message),
  )
  // Ordinary writes pass, which is the rule that matters more than the refusal.
  assertNoForbiddenKeys({ 角色: { 络络: { 好感度: 5 } } })
  assertPathWritable('角色.络络.好感度')
})

test('the merge faces refuse a forbidden tree and keep accepting an ordinary one', () => {
  const poison = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>
  assert.throws(() => insertOrAssign({}, poison), ForbiddenKeyError)
  assert.throws(() => insertMissing({}, poison), ForbiddenKeyError)
  assert.deepEqual(insertOrAssign({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
})

test('a deletion refuses a path that walks out of the table', () => {
  // Without the guard `_.has` answers `true` here, so the call reported a
  // deletion of something that was never stored.
  assert.throws(() => deletePath({ a: {} }, 'a.constructor.name'), ForbiddenKeyError)
  assert.deepEqual(deletePath({ a: { b: 1 } }, 'a.b'), { variables: { a: {} }, delete_occurred: true })
})

test('every VariableStore write face refuses, and the store stays as it was', () => {
  const store = new VariableStore({ chat: memoryBackend() })
  const scope = { type: 'chat' } as const
  store.replaceVariables({ 好感度: 5 }, scope)

  const poison = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<string, unknown>
  assert.throws(() => { store.replaceVariables(poison, scope) }, ForbiddenKeyError)
  assert.throws(() => store.insertOrAssignVariables(poison, scope), ForbiddenKeyError)
  assert.throws(() => store.insertVariables(poison, scope), ForbiddenKeyError)
  assert.throws(() => store.deleteVariable('__proto__.x', scope), ForbiddenKeyError)

  assert.deepEqual(store.getVariables(scope), { 好感度: 5 }, 'a refused write must change nothing')
})

test('property: no fuzzed batch through any face touches a prototype', () => {
  // Every forbidden shape the wire can carry, crossed with every face. The
  // assertion afterwards is deliberately not "the call threw": a face that
  // silently dropped the key would also leave the prototypes clean, and a face
  // that threw *after* writing would not — so both the prototypes and the
  // stored table are checked, and each face is required to have been exercised.
  const shapes: string[] = [
    '{"__proto__":{"polluted":"yes"}}',
    '{"constructor":{"prototype":{"polluted":"yes"}}}',
    '{"prototype":{"polluted":"yes"}}',
    '{"a":{"__proto__":{"polluted":"yes"}}}',
    '{"a":{"b":{"c":{"__proto__":{"polluted":"yes"}}}}}',
    '{"队伍":[{"__proto__":{"polluted":"yes"}}]}',
    '{"队伍":[[{"constructor":1}]]}',
    '{"a":[1,2,{"prototype":{"polluted":"yes"}}]}',
  ]
  const paths = [
    '__proto__', '__proto__.polluted', 'a.__proto__.polluted',
    'constructor.prototype.polluted', 'a.constructor.prototype.x',
    'prototype.polluted', 'a["__proto__"].b', '队伍[0].__proto__.x',
  ]

  const store = new VariableStore({ chat: memoryBackend() })
  const scope = { type: 'chat' } as const
  store.replaceVariables({ 好感度: 5 }, scope)

  let attempts = 0
  const attempt = (run: () => unknown): void => {
    attempts += 1
    try { run() } catch { /* a refusal is one correct outcome; a silent drop is the other */ }
  }

  for (const shape of shapes) {
    const tree = JSON.parse(shape) as Record<string, unknown>
    attempt(() => insertOrAssign({ 好感度: 5 }, tree))
    attempt(() => insertMissing({ 好感度: 5 }, tree))
    attempt(() => { store.replaceVariables(tree, scope) })
    attempt(() => store.insertOrAssignVariables(tree, scope))
    attempt(() => store.insertVariables(tree, scope))
    // The updater hands back a tree it built itself, which is how a card's
    // `updateVariablesWith` callback reaches this store.
    attempt(() => store.updateVariablesWith(() => JSON.parse(shape) as Record<string, unknown>, scope))
  }
  for (const path of paths) {
    attempt(() => deletePath({ 好感度: 5 }, path))
    attempt(() => store.deleteVariable(path, scope))
  }

  assert.equal(attempts, shapes.length * 6 + paths.length * 2)
  assert.ok(attempts >= 64, 'the fuzz must actually have run — a skipped loop passes every assertion below')

  // The three objects a pollution shows up in.
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype was written')
  assert.equal((Object.prototype as unknown as Record<string, unknown>)['polluted'], undefined)
  assert.equal(([] as unknown as Record<string, unknown>)['polluted'], undefined, 'Array.prototype was written')
  assert.equal((Array.prototype as unknown as Record<string, unknown>)['polluted'], undefined)
  assert.equal(Object.getPrototypeOf({}), Object.prototype)

  // And the table itself holds none of the three, at any depth.
  const stored = store.getVariables(scope)
  assert.equal(findForbiddenKey(stored), undefined)
  assert.deepEqual(Object.keys(stored), ['好感度'], 'an ordinary key must survive the batch')
})
