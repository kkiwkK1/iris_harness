import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyCommands, extractCommands, type CommandInfo, type MvuData } from '../src/index.ts'

/** A state tree shaped the way an `[InitVar]` entry declares one. */
function initialState(): MvuData {
  return {
    initialized_lorebooks: {},
    stat_data: {
      当前时间: ['2026-6-1 10:05', '每次行动后更新，格式为 yyyy-M-d HH:mm'],
      络络: {
        好感度: [10, '[-100,100] 之间，互动时更新'],
        // Three items on purpose: a two-item list of strings is shape-identical
        // to a `[value, description]` pair, which the ambiguity test below pins.
        着装: [['法杖', '粉色缎带', '靴子'], '当前穿戴，换装时更新'],
        在场: [true, '是否在场'],
      },
      队伍: ['露露', '络络'],
    },
  }
}

/** Parse and apply in one step, the way a turn would. */
function run(message: string, state: MvuData = initialState()) {
  return applyCommands(extractCommands(message), state)
}

/** Reach into 络络's sub-tree. */
function luoluo(result: { data: MvuData }): Record<string, unknown> {
  return result.data.stat_data.络络 as Record<string, unknown>
}

test('set writes through the description pair and keeps the description', () => {
  const result = run(`_.set('当前时间', '2026-6-1 10:15');//时间流逝`)

  assert.deepEqual(result.data.stat_data.当前时间, ['2026-6-1 10:15', '每次行动后更新，格式为 yyyy-M-d HH:mm'])
})

test('the three-argument form ignores the declared old value', () => {
  // Upstream does not verify it, and models get it wrong constantly.
  const result = run(`_.set('络络.好感度', 999, 20);//修正`)

  assert.deepEqual(luoluo(result).好感度, [20, '[-100,100] 之间，互动时更新'])
})

test('a numeric slot stays numeric even when the model quotes the value', () => {
  const result = run(`_.set('络络.好感度', '20');//引号里的数字`)

  assert.deepEqual(luoluo(result).好感度, [20, '[-100,100] 之间，互动时更新'])
})

test('set refuses to invent a path', () => {
  const result = run(`_.set('络络.不存在的字段', 1);//幻觉`)

  assert.equal(result.changed, false)
  assert.match(result.failures[0]?.reason ?? '', /does not exist/)
})

test('a pair whose value is a list is not unwrapped by set', () => {
  // The carve-out that forces the `[0]` convention: without an explicit
  // subscript, set replaces the whole leaf, description and all.
  const result = run(`_.set('络络.着装', ['剑']);//换装`)

  assert.deepEqual(luoluo(result).着装, ['剑'])
})

test('the [0] suffix reaches inside the pair and keeps the description', () => {
  const result = run(`_.set('络络.着装[0]', ['剑']);//换装`)

  assert.deepEqual(luoluo(result).着装, [['剑'], '当前穿戴，换装时更新'])
})

test('a two-element list of strings is indistinguishable from a value/description pair', () => {
  // Documented, inherited wart: upstream has the same hole, and only the
  // `[InitVar]` declaration can tell the two apart. Pinned here so the
  // behaviour is a known quantity rather than a surprise in the field.
  const state: MvuData = {
    initialized_lorebooks: {},
    stat_data: { 双持: ['剑', '盾'] },
  }
  const result = applyCommands(extractCommands(`_.set('双持', '斧');//换武器`), state)

  assert.deepEqual(result.data.stat_data.双持, ['斧', '盾'], 'the second string is treated as a description')
})

test('add applies a numeric delta, including a negative one', () => {
  const state = run(`_.add('络络.好感度', 5);//开心`).data
  const result = applyCommands(extractCommands(`_.add('络络.好感度', -3);//失望`), state)

  assert.deepEqual(luoluo(result).好感度, [12, '[-100,100] 之间，互动时更新'])
})

test('add refuses a type it cannot add', () => {
  const result = run(`_.add('当前时间', 1);//无意义`)

  assert.match(result.failures[0]?.reason ?? '', /cannot add/)
})

test('insert appends to a list addressed through the pair', () => {
  const result = run(`_.assign('络络.着装[0]', '披风');//穿上披风`)

  assert.deepEqual(luoluo(result).着装, [['法杖', '粉色缎带', '靴子', '披风'], '当前穿戴，换装时更新'])
})

test('insert appends to a bare list', () => {
  const result = run(`_.assign('队伍', '悠纪');//新同伴`)

  assert.deepEqual(result.data.stat_data.队伍, ['露露', '络络', '悠纪'])
})

test('insert refuses a primitive target', () => {
  const result = run(`_.assign('络络.好感度[0]', 5);//没有意义`)

  assert.match(result.failures[0]?.reason ?? '', /cannot insert into number/)
})

test('delete removes a named element from a list', () => {
  const result = run(`_.remove('络络.着装[0]', '粉色缎带');//脱下缎带`)

  assert.deepEqual(luoluo(result).着装, [['法杖', '靴子'], '当前穿戴，换装时更新'])
})

test('delete with a numeric subscript drops that element rather than leaving a hole', () => {
  const result = run(`_.remove('队伍[0]');//露露离队`)

  assert.deepEqual(result.data.stat_data.队伍, ['络络'])
})

test('delete with only a path removes the whole entry', () => {
  const result = run(`_.remove('络络.在场');//离场`)

  assert.equal('在场' in luoluo(result), false)
})

test('display_data renders the arrow form status bars read', () => {
  const result = run(`_.set('络络.好感度', 10, 20);//愉快的一次交谈`)

  assert.equal(result.display_data['络络.好感度'], '10->20 (愉快的一次交谈)')
})

test('the input state is never mutated', () => {
  const before = initialState()
  run(`_.set('络络.好感度', 99);//改`, before)

  assert.deepEqual((before.stat_data.络络 as Record<string, unknown>).好感度, [10, '[-100,100] 之间，互动时更新'])
})

test('one rejected command does not lose the rest of the batch', () => {
  const result = run([
    `_.set('络络.幻觉字段', 1);//会被拒绝`,
    `_.add('络络.好感度', 2);//应当生效`,
  ].join('\n'))

  assert.equal(result.failures.length, 1)
  assert.deepEqual(luoluo(result).好感度, [12, '[-100,100] 之间，互动时更新'])
})

test('strictSet writes the whole leaf, destroying the description', () => {
  const result = applyCommands(extractCommands(`_.set('当前时间', 'x');`), initialState(), { strictSet: true })

  assert.equal(result.data.stat_data.当前时间, 'x')
})

test('a command type the fold does not handle is rejected, never dropped', () => {
  /*
   * The switch over `CommandType` had no `default`. All five members were
   * handled, so it compiled and behaved — but a sixth would have been
   * extracted, counted by `scanDialects`, and then neither applied nor
   * rejected. **A silently dropped command is the worst of the three
   * outcomes**: the caller sees a non-zero command count and no effect, and
   * nothing names the command that did nothing.
   *
   * The guard is two guards. A `never` assignment makes a new member a compile
   * error, which is where it should be caught. This test covers the other
   * direction — a value arriving at run time that the type says cannot exist,
   * from a hand-edited log or a newer build's data read by an older one.
   */
  const rogue = { type: 'teleport', full_match: '', args: ['a'], reason: '' } as unknown as CommandInfo
  const result = applyCommands([rogue], { initialized_lorebooks: {}, stat_data: { a: 1 } })

  assert.equal(result.failures.length, 1, 'an unknown command was dropped without a word')
  assert.match(result.failures[0]?.reason ?? '', /unknown command type/u)
  assert.equal(result.changed, false)
  assert.deepEqual(result.data.stat_data, { a: 1 }, 'an unknown command changed the tree')
})
