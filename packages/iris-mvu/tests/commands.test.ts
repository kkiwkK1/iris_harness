import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractCommands, normalizeCommandPaths } from '../src/index.ts'

/** Parse, then normalize paths — what a caller with no fix-up hook does. */
function parse(message: string) {
  return normalizeCommandPaths(extractCommands(message))
}

test('parses a real UpdateVariable block', () => {
  const message = [
    '<UpdateVariable>',
    '    <Analysis>',
    '        当前时间[0]: Y',
    '    </Analysis>',
    `    _.set('当前时间[0]', '2026-6-1 10:05', '2026-6-1 10:15');//时间流逝`,
    `    _.add('悠纪.好感度[0]', 2);//与悠纪的好感度增加`,
    `    _.assign('悠纪.重要成就[0]', '2026年6月1日，悠纪告白成功');//告白成功`,
    `    _.remove('悠纪.着装[0]', '粉色缎带');//悠纪脱下粉色缎带`,
    '</UpdateVariable>',
  ].join('\n')

  const commands = parse(message)

  assert.deepEqual(commands.map(command => command.type), ['set', 'add', 'insert', 'delete'])
  assert.deepEqual(commands[0]?.args, ['当前时间[0]', `'2026-6-1 10:05'`, `'2026-6-1 10:15'`])
  assert.equal(commands[0]?.reason, '时间流逝')
  assert.equal(commands[1]?.args[1], '2')
  assert.equal(commands[3]?.reason, '悠纪脱下粉色缎带')
})

test('aliases fold onto the canonical verbs', () => {
  const commands = parse(`_.assign('a', 1);_.remove('b');_.unset('c');_.delete('d');_.insert('e', 2);`)

  assert.deepEqual(commands.map(command => command.type), ['insert', 'delete', 'delete', 'delete', 'insert'])
})

test('arguments stay in literal form until paths are normalized', () => {
  const raw = extractCommands(`_.set('角色.络络.好感度', 30);`)
  assert.equal(raw[0]?.args[0], `'角色.络络.好感度'`, 'a fix-up hook sees the source text, quotes and all')

  normalizeCommandPaths(raw)
  assert.equal(raw[0]?.args[0], '角色.络络.好感度')
  assert.equal(raw[0]?.args[1], '30', 'value arguments keep their literal form')
})

test('normalizing strips whitespace inside subscripts', () => {
  const commands = parse(`_.set('队伍[ 0 ].name', '络络');`)

  assert.equal(commands[0]?.args[0], '队伍[0].name')
})

test('parenthesis matching ignores brackets and semicolons inside strings', () => {
  const commands = parse(`_.set('道具', ['卷轴);碎片', '(残页']);//捡到东西`)

  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.args[1], `['卷轴);碎片', '(残页']`)
  assert.equal(commands[0]?.reason, '捡到东西')
})

test('a command without the trailing semicolon is not a command', () => {
  // The guard that keeps prose from rewriting state.
  const commands = parse(`她在控制台上敲下 _.set('系统.权限', '管理员') 然后停住了。`)

  assert.deepEqual(commands, [])
})

test('a command quoted inside a rejected command is not extracted', () => {
  // Scanning must resume past the whole rejected call, not inside it —
  // otherwise the narrator quoting a command would issue it.
  const commands = parse(`_.set('日志', "他写下 _.set('系统.权限', '管理员');")`)

  assert.deepEqual(commands, [])
})

test('a rejected match does not hide a valid command after it', () => {
  const commands = parse(`旁白提到 _.set('假.路径', 1) 只是叙述。\n_.set('真.路径', 2);//这条算数`)

  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.args[0], '真.路径')
})

test('an unbalanced parenthesis does not end the scan', () => {
  const commands = parse(`_.set('坏.命令', [1, 2\n_.set('好.命令', 3);//仍然生效`)

  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.args[0], '好.命令')
})

test('commands are found outside any wrapper tag', () => {
  const commands = parse(`络络笑了笑。_.add('络络.好感度', 1);//她很开心\n然后转身离开。`)

  assert.equal(commands.length, 1)
  assert.equal(commands[0]?.type, 'add')
  assert.equal(commands[0]?.reason, '她很开心')
})

test('add takes exactly two arguments', () => {
  assert.equal(parse(`_.add('a', 1);`).length, 1)
  assert.equal(parse(`_.add('a', 1, 2);`).length, 0, 'a third argument means it is not an add')
  assert.equal(parse(`_.add('a');`).length, 0)
})

test('set needs a path and a value; delete needs only a path', () => {
  assert.equal(parse(`_.set('a');`).length, 0)
  assert.equal(parse(`_.set('a',);`).length, 0, 'a trailing empty argument does not count')
  assert.equal(parse(`_.set('a', 1);`).length, 1)
  assert.equal(parse(`_.set('a', 0, 1);`).length, 1, 'the three-argument form carries the old value')
  assert.equal(parse(`_.delete('a');`).length, 1)
})

test('a missing reason comment yields an empty reason', () => {
  assert.equal(parse(`_.set('a', 1);`)[0]?.reason, '')
})

test('full_match spans the command, its semicolon and its comment', () => {
  const commands = parse(`前文 _.set('a', 1);//理由`)

  assert.equal(commands[0]?.full_match, `_.set('a', 1);//理由`)
})
