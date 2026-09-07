/**
 * The composer's command line: what is a command, what is a message, and what
 * belongs to SillyTavern.
 *
 * @module iris-web/tests/commands
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  commandCompletions,
  helpText,
  irisCommands,
  parseCommandLine,
  resolveCommand,
  ST_SLASH_NAMES,
  unknownCommandNotice,
  type CommandDescriptor,
} from '../src/app/commands.ts'
import { setLanguage } from '../src/app/i18n/language.ts'

/** A table that records what ran instead of doing it. */
function table(): { commands: CommandDescriptor[], ran: string[] } {
  const ran: string[] = []
  const commands = irisCommands({
    compact: async () => {
      ran.push('compact')
      await Promise.resolve()
    },
  })
  return { commands, ran }
}

test('a line that does not start with a slash is a message', () => {
  const { commands } = table()
  assert.equal(parseCommandLine('hello /compact'), undefined)
  assert.deepEqual(resolveCommand('hello /compact', commands), { kind: 'message' })
  assert.deepEqual(resolveCommand('', commands), { kind: 'message' })
  // A slash that is not the first character is prose, including the case a
  // reader is most likely to type by accident.
  assert.deepEqual(resolveCommand('and/or', commands), { kind: 'message' })
})

test('the name is parsed and the rest is handed on untouched', () => {
  // Only the name. Upstream's argument grammar — named arguments, quoting, the
  // pipe and its backslash escape — lives host-side in
  // `@iris/compat-tavernhelper`'s parser, and a second implementation here is
  // the thing this split exists to avoid.
  assert.deepEqual(parseCommandLine('/help'), { name: 'help', args: '' })
  assert.deepEqual(parseCommandLine('/HELP'), { name: 'help', args: '' })
  assert.deepEqual(
    parseCommandLine('/send hello "world" | /trigger'),
    { name: 'send', args: 'hello "world" | /trigger' },
  )
  assert.deepEqual(
    parseCommandLine('/echo a\\|b'),
    { name: 'echo', args: 'a\\|b' },
    'the escape must survive the split, because the host is the one that reads it',
  )
  // A pipe immediately after the name still ends the name.
  assert.deepEqual(parseCommandLine('/trigger|/echo x'), { name: 'trigger', args: '|/echo x' })
  // A bare slash is its own state: the reader has opened the menu.
  assert.deepEqual(parseCommandLine('/'), { name: '', args: '' })
})

test('a name Iris owns resolves to its descriptor, with its arguments', () => {
  const { commands } = table()
  const resolution = resolveCommand('/compact  ', commands)
  assert.equal(resolution.kind, 'iris')
  assert.equal(resolution.kind === 'iris' ? resolution.command.name : '', 'compact')
  assert.equal(resolution.kind === 'iris' ? resolution.args : 'x', '')
})

test('a name Iris does not own goes to the host verbatim', () => {
  const { commands } = table()
  for (const line of ['/trigger', '/send hi | /trigger', '/setvar key=a 1', '/nonsense']) {
    assert.deepEqual(
      resolveCommand(line, commands),
      { kind: 'upstream', line },
      `${line} must reach the host unrewritten`,
    )
  }
})

test('no Iris command shadows a SillyTavern one', () => {
  /*
   * The rule the whole table is subordinate to: compatibility is the floor, so
   * a name upstream registers keeps upstream's meaning and Iris may not take
   * it. `ST_SLASH_NAMES` is the measured list (289 names, SillyTavern 1.18.0);
   * this is the direction that matters, because it is a *new Iris command*
   * that can break the rule, and it goes red at the moment one is added.
   */
  const { commands } = table()
  const shadowed = commands.map(row => row.name).filter(name => ST_SLASH_NAMES.has(name))
  assert.deepEqual(shadowed, [], 'these Iris commands take a name SillyTavern already uses')
  // The premise: the list is the real one, not an empty set that would make
  // the assertion above pass by vacuity. `?` is upstream's help — which is
  // also why `/help` is free.
  assert.equal(ST_SLASH_NAMES.size, 289)
  assert.ok(ST_SLASH_NAMES.has('trigger') && ST_SLASH_NAMES.has('summarize') && ST_SLASH_NAMES.has('?'))
  assert.ok(!ST_SLASH_NAMES.has('compact') && !ST_SLASH_NAMES.has('help'))
})

test('completions are a prefix match, and stop once arguments are typed', () => {
  const { commands } = table()
  assert.deepEqual(commandCompletions('/', commands).map(row => row.name), ['compact', 'help'])
  assert.deepEqual(commandCompletions('/c', commands).map(row => row.name), ['compact'])
  assert.deepEqual(commandCompletions('/h', commands).map(row => row.name), ['help'])
  // Not fuzzy: the menu opens on a `/` the reader typed, so they are spelling a
  // name they mean, and `/p` must not offer `/help`.
  assert.deepEqual(commandCompletions('/p', commands), [])
  // The reader has chosen and moved on to arguments.
  assert.deepEqual(commandCompletions('/compact now', commands), [])
  assert.deepEqual(commandCompletions('not a command', commands), [])
})

test('/compact is refused while a reply is arriving, and /help is not', () => {
  const { commands } = table()
  const compact = commands.find(row => row.name === 'compact')
  const help = commands.find(row => row.name === 'help')
  assert.equal(compact?.idleOnly, true, 'a compaction rewrites what the next request assembles from')
  assert.notEqual(help?.idleOnly, true, 'asking what the commands are costs nothing')
})

test('/compact runs the action it was given', async () => {
  const { commands, ran } = table()
  const compact = commands.find(row => row.name === 'compact')
  assert.ok(compact !== undefined)
  await compact.run({ args: '', chatId: 'c1', generating: false, notify: () => {} })
  assert.deepEqual(ran, ['compact'])
})

test('/help lists Iris’s commands and says where everything else goes', () => {
  setLanguage('en')
  const { commands } = table()
  const said: string[] = []
  const help = commands.find(row => row.name === 'help')
  assert.ok(help !== undefined)
  help.run({ args: '', chatId: 'c1', generating: false, notify: (_kind, text) => said.push(text) })
  assert.equal(said.length, 1)
  const text = said[0] as string
  for (const row of commands) {
    assert.ok(text.includes(`/${row.name}`), `/help does not mention /${row.name}`)
  }
  // The line that stops a reader concluding `/trigger` does not work here.
  assert.match(text, /goes to the host/)
  assert.equal(text, helpText(commands))
})

test('an unknown command carries the host’s own reason', () => {
  setLanguage('en')
  const notice = unknownCommandNotice('nonsense', 'unsupported: no such command')
  assert.match(notice, /nonsense/)
  assert.match(
    notice,
    /unsupported: no such command/,
    'the host knows which of the two refused, and a sentence written here does not',
  )
})

test('the copy follows the language', () => {
  const { commands } = table()
  setLanguage('zh')
  assert.match(helpText(commands), /[㐀-鿿]/)
  setLanguage('en')
  assert.doesNotMatch(helpText(commands), /[㐀-鿿]/)
})
