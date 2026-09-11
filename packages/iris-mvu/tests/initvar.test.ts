import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractGreetingOverride, loadInitVars, parseInitVarBody, type InitVarSource, type MvuData } from '../src/index.ts'

/** An empty state, as a new chat starts. */
function fresh(): MvuData {
  return { initialized_lorebooks: {}, stat_data: {} }
}

/** A book with one `[InitVar]` entry. */
function book(name: string, comment: string, content: string, disable = false): InitVarSource {
  return { name, entries: [{ comment, content, disable }] }
}

const DECLARATION = `
日期: ["03月15日", "今天的日期，格式为 mm月dd日"]
络络:
  好感度: [10, "[-100,100] 之间，互动时更新"]
  当前所想: ["今天吃什么好呢？", "随互动更新"]
`

test('a JSON body parses, because YAML is a superset', () => {
  const parsed = parseInitVarBody('{"好感度": [5, "描述"]}')

  assert.deepEqual(parsed, { 好感度: [5, '描述'] })
})

test('an [InitVar] entry declares the variable tree', () => {
  const result = loadInitVars([book('主世界书', '[InitVar]初始变量', DECLARATION)], fresh())

  assert.deepEqual(result.loaded, ['主世界书'])
  assert.deepEqual(result.data.stat_data.日期, ['03月15日', '今天的日期，格式为 mm月dd日'])
  assert.deepEqual(
    (result.data.stat_data.络络 as Record<string, unknown>).好感度,
    [10, '[-100,100] 之间，互动时更新'],
  )
})

test('the marker is matched case-insensitively, anywhere in the title', () => {
  const lower = loadInitVars([book('a', 'xx[initvar]初始变量1', '好感度: 1')], fresh())
  const upper = loadInitVars([book('b', '前缀 [INITVAR] 后缀', '好感度: 1')], fresh())

  assert.deepEqual(lower.loaded, ['a'])
  assert.deepEqual(upper.loaded, ['b'])
})

test('a disabled entry still declares', () => {
  // Authors switch these off so they never reach the prompt, not so they stop
  // declaring the tree.
  const result = loadInitVars([book('主世界书', '[InitVar]', '好感度: 1', true)], fresh())

  assert.deepEqual(result.loaded, ['主世界书'])
  assert.equal(result.data.stat_data.好感度, 1)
})

test('an entry without the marker declares nothing', () => {
  const result = loadInitVars([book('主世界书', '普通条目', '好感度: 1')], fresh())

  assert.deepEqual(result.loaded, [])
  assert.deepEqual(result.data.stat_data, {})
})

test('a book initializes only once', () => {
  const once = loadInitVars([book('主世界书', '[InitVar]', '好感度: 1')], fresh())
  once.data.stat_data.好感度 = 99

  const twice = loadInitVars([book('主世界书', '[InitVar]', '好感度: 1')], once.data)

  assert.deepEqual(twice.loaded, [], 'the second pass is a no-op')
  assert.equal(twice.data.stat_data.好感度, 99, 'fifty turns of state are not reset by a re-scan')
})

test('a book added mid-chat contributes only the keys nobody has set', () => {
  const started = loadInitVars([book('主世界书', '[InitVar]', '好感度: 1')], fresh())
  started.data.stat_data.好感度 = 50

  const extended = loadInitVars(
    [book('主世界书', '[InitVar]', '好感度: 1'), book('副世界书', '[InitVar]', '好感度: 1\n体力: 100')],
    started.data,
  )

  assert.equal(extended.data.stat_data.好感度, 50, 'live state wins')
  assert.equal(extended.data.stat_data.体力, 100, 'the new key arrives')
})

test('an unparseable entry is reported, not thrown', () => {
  const result = loadInitVars([book('主世界书', '[InitVar]', '好感度: [1, 2\n  bad: :')], fresh())

  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.book, '主世界书')
})

test('an initvar block in a greeting replaces the declared tree', () => {
  const override = extractGreetingOverride('欢迎。\n<initvar>\n好感度: 30\n</initvar>\n开始吧。')

  assert.equal(override?.kind, 'replace')
  assert.equal(override?.body, '好感度: 30')
})

test('an UpdateVariable block in a greeting is applied on top instead', () => {
  const override = extractGreetingOverride(`<UpdateVariable>\n_.set('好感度', 0, 30);//开局\n</UpdateVariable>`)

  assert.equal(override?.kind, 'update')
  assert.match(override?.body ?? '', /_\.set/)
})

test('a greeting with no override says so', () => {
  assert.equal(extractGreetingOverride('只是普通的开场白。'), undefined)
})

test('an [InitVar] body naming a reserved key fails that entry, and the book still loads', () => {
  // The declared tree is merged into the chat's state by `mergeWith`, which is
  // the pollution site the network audit named. A world book is a file someone
  // downloaded, so this is refused where the other body problems are refused —
  // the entry is reported and the rest of the book still loads, rather than one
  // bad entry taking a card's whole opening state with it.
  const poisoned = {
    name: '主世界书',
    entries: [
      { comment: '[InitVar]坏条目', content: '__proto__:\n  polluted: 1' },
      { comment: '[InitVar]好条目', content: '好感度: 5' },
    ],
  }
  const result = loadInitVars([poisoned], fresh())

  assert.equal(result.failures.length, 1, 'exactly the bad entry fails')
  assert.match(result.failures[0]?.reason ?? '', /__proto__/)
  assert.equal(result.failures[0]?.comment, '[InitVar]坏条目')
  assert.equal(result.data.stat_data['好感度'], 5, 'the other entry still loaded')
  assert.deepEqual(result.loaded, ['主世界书'])
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype was written')
})

test('a book whose name is a reserved key loads without recording itself', () => {
  // `initialized_lorebooks[name] = []` is a wire string used as a plain object
  // key. The bookkeeping is not worth a prototype write, so such a book is
  // loaded and simply not recorded — it re-runs, which is the harmless
  // direction of this failure.
  const result = loadInitVars([{ name: '__proto__', entries: [{ comment: '[InitVar]', content: '好感度: 1' }] }], fresh())

  assert.equal(result.data.stat_data['好感度'], 1)
  assert.deepEqual(result.loaded, ['__proto__'], 'it is still reported as loaded')
  assert.equal(Object.getPrototypeOf(result.data.initialized_lorebooks), Object.prototype)
  assert.equal(({} as Record<string, unknown>)['length'], undefined)
})
