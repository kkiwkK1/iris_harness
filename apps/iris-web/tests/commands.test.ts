/**
 * The composer's command line: what is a command, what is a message, and what
 * belongs to SillyTavern.
 *
 * @module iris-web/tests/commands
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMAND_GROUPS,
  commandArgumentCompletions,
  commandCompletions,
  commandLabel,
  helpText,
  irisCommands,
  MODEL_DEFAULT_ARG,
  parseCommandLine,
  resolveCommand,
  ST_SLASH_NAMES,
  unknownCommandNotice,
  type CommandDescriptor,
  type ModelChoices,
} from '../src/app/commands.ts'
import { setLanguage } from '../src/app/i18n/language.ts'

/** What one `run` said, in order. */
interface Said { kind: 'info' | 'error', text: string }

/**
 * A table that records what ran instead of doing it.
 *
 * Every action is counted by name **with its arguments**, because for three of
 * them the argument is the whole question: which chat `/rename` retitled, and
 * whether `/chat-model default` passed `null` rather than the string.
 * @param options.choices - what the model capsule is showing.
 * @param options.capacity - whether the capacity card has a budget to open on.
 * @returns the table, the log, and the choices object the table reads live.
 */
function table(options: {
  choices?: Partial<ModelChoices>
  capacity?: boolean
} = {}): {
  commands: CommandDescriptor[]
  ran: string[]
  /**
   * Replace what the capsule is showing.
   *
   * **A reassignment, not a mutation**, because that is the seam
   * `Composer.tsx` actually has: `live.current` is a fresh object literal
   * every render. A fixture that handed back one mutable object would leave a
   * command that captured the object at build time indistinguishable from one
   * that reads it per call — the teeth check found exactly that hole.
   */
  setChoices: (patch: Partial<ModelChoices>) => void
} {
  const ran: string[] = []
  let choices: ModelChoices = {
    current: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    overridden: false,
    listed: true,
    ...options.choices,
  }
  const commands = irisCommands({
    compact: async () => {
      ran.push('compact')
      await Promise.resolve()
    },
    newChat: async () => {
      ran.push('newChat')
      await Promise.resolve()
    },
    rename: async (chatId, title) => {
      ran.push(`rename:${chatId}:${title}`)
      await Promise.resolve()
    },
    exportChat: async (chatId) => {
      ran.push(`export:${chatId}`)
      await Promise.resolve()
    },
    setModel: async (model) => {
      ran.push(`setModel:${model === null ? 'null' : model}`)
      await Promise.resolve()
    },
    // Read through the closure rather than copied in, so a test that calls
    // `setChoices` after building the table is exercising what the real thunk
    // faces: the endpoint's list arrives from a probe fired after the table
    // exists, and `Composer.tsx` hands over a new object each render.
    modelChoices: () => choices,
    showCapacity: () => {
      ran.push('showCapacity')
      return options.capacity ?? true
    },
    openSettings: () => {
      ran.push('openSettings')
    },
  })
  return { commands, ran, setChoices: (patch) => { choices = { ...choices, ...patch } } }
}

/**
 * Run one command and collect what it said.
 *
 * Awaited here rather than handed to the subject as a callback: the assertions
 * live in the calling test, so a `run` that throws fails the test instead of
 * being swallowed by anything of its own.
 * @param commands - the table.
 * @param name - the command to run.
 * @param args - what follows the name.
 * @returns the notices, in order.
 */
async function invoke(
  commands: readonly CommandDescriptor[],
  name: string,
  args = '',
): Promise<Said[]> {
  const said: Said[] = []
  const row = commands.find(entry => entry.name === name)
  assert.ok(row !== undefined, `there is no /${name} in the table`)
  await row.run({
    args,
    chatId: 'c1',
    generating: false,
    notify: (kind, text) => { said.push({ kind, text }) },
  })
  return said
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
  const names = commands.map(row => row.name)
  const shadowed = names.filter(name => ST_SLASH_NAMES.has(name))
  assert.deepEqual(shadowed, [], 'these Iris commands take a name SillyTavern already uses')
  /*
   * The sample. A disjointness that passed over an empty or half-built table
   * would be reporting on nothing — and the second batch is exactly when that
   * could happen silently, since a command whose registration was dropped
   * cannot collide. The floor is a floor, not the count: a ninth command must
   * not have to edit this line (`DEVIATIONS.md` on assertions that pin counts).
   */
  assert.ok(names.length >= 8, `the table has ${String(names.length)} commands, so this proves little`)
  assert.deepEqual([...new Set(names)], names, 'two commands are registered under one name')
  for (const name of names) {
    assert.match(name, /^[a-z][a-z-]*$/, `${name} is not a name the parser can produce`)
  }
  // The premise: the list is the real one, not an empty set that would make
  // the assertion above pass by vacuity. `?` is upstream's help — which is
  // also why `/help` is free.
  assert.equal(ST_SLASH_NAMES.size, 289)
  assert.ok(ST_SLASH_NAMES.has('trigger') && ST_SLASH_NAMES.has('summarize') && ST_SLASH_NAMES.has('?'))
  assert.ok(!ST_SLASH_NAMES.has('compact') && !ST_SLASH_NAMES.has('help'))
})

test('the six names Iris yielded are upstream’s, and Iris does not have them', () => {
  /*
   * **Yielding is the feature, so it is asserted rather than only written
   * down.** Three of these were re-spelled — `/model` became `/chat-model`,
   * `/tokens` and `/context` became `/capacity` — and three were dropped
   * entirely: `/regenerate`, `/continue` and `/impersonate` are the three
   * buttons above the field, and typing the names gets SillyTavern's own
   * meaning through the host instead of a second implementation here.
   *
   * Both halves, in one test, because either alone is silently satisfiable: a
   * name absent from Iris's table proves nothing if it was never upstream's,
   * and a name that is upstream's proves nothing about this table.
   */
  const { commands } = table()
  const names = commands.map(row => row.name)
  for (const yielded of ['model', 'tokens', 'context', 'regenerate', 'continue', 'impersonate']) {
    assert.ok(ST_SLASH_NAMES.has(yielded), `/${yielded} was supposed to be upstream's`)
    assert.ok(!names.includes(yielded), `Iris has taken /${yielded} back from SillyTavern`)
  }
  // And the replacements are real, so this test cannot pass by the commands
  // simply not existing.
  assert.ok(names.includes('chat-model') && names.includes('capacity'))
})

test('completions are a prefix match, and stop once the name is settled', () => {
  const { commands } = table()
  assert.deepEqual(
    commandCompletions('/', commands).map(row => row.name),
    ['new', 'rename', 'export', 'chat-model', 'capacity', 'compact', 'config', 'help'],
    'the menu order is the table order, which is also `/help`’s order',
  )
  assert.deepEqual(commandCompletions('/ca', commands).map(row => row.name), ['capacity'])
  assert.deepEqual(commandCompletions('/c', commands).map(row => row.name), ['chat-model', 'capacity', 'compact', 'config'])
  assert.deepEqual(commandCompletions('/h', commands).map(row => row.name), ['help'])
  // Not fuzzy: the menu opens on a `/` the reader typed, so they are spelling a
  // name they mean, and `/p` must not offer `/help`.
  assert.deepEqual(commandCompletions('/p', commands), [])
  // The reader has chosen and moved on to arguments.
  assert.deepEqual(commandCompletions('/compact now', commands), [])
  assert.deepEqual(commandCompletions('not a command', commands), [])
  /*
   * The separator, not the parsed arguments, is what ends the name — and
   * `parseCommandLine` trims, so these two lines parse identically and mean
   * different things. Without this, the name menu would still be up over a
   * chosen command while the argument menu was trying to replace it.
   */
  assert.deepEqual(commandCompletions('/chat-model', commands).map(row => row.name), ['chat-model'])
  assert.deepEqual(commandCompletions('/chat-model ', commands), [])
})

test('exactly the three commands that change what the next request sees are idle-only', () => {
  /*
   * Not a list of three assertions but a **partition**, so a new command that
   * forgets the question goes red on whichever side it landed on. The rule the
   * partition encodes: gated when running it under a request in flight would
   * change or truncate something that request is about to produce.
   */
  const { commands } = table()
  const gated = commands.filter(row => row.idleOnly === true).map(row => row.name)
  assert.deepEqual(
    gated.sort(),
    ['compact', 'export', 'new'],
    'a compaction rewrites the next assembly, /new navigates off a streaming reply, and chat.export serves only what is stored',
  )
  const open = commands.filter(row => row.idleOnly !== true).map(row => row.name)
  assert.deepEqual(
    open.sort(),
    ['capacity', 'chat-model', 'config', 'help', 'rename'],
    '/chat-model is deliberately open, because the capsule’s menu is open during a generation and one action must not have two answers',
  )
})

test('each command runs the action it was given, and nothing else', async () => {
  /*
   * One action per command, counted with its arguments. The `ran` log is
   * compared whole rather than searched, so a command that also fired a second
   * action — the class of bug a keyboard entry into a store is most likely to
   * have — fails here rather than passing a `includes` check.
   */
  for (const [name, args, expected] of [
    ['new', '', ['newChat']],
    ['rename', 'A quiet evening', ['rename:c1:A quiet evening']],
    ['export', '', ['export:c1']],
    ['capacity', '', ['showCapacity']],
    ['config', '', ['openSettings']],
    ['compact', '', ['compact']],
  ] as const) {
    const { commands, ran } = table()
    await invoke(commands, name, args)
    assert.deepEqual(ran, expected, `/${name} did not call exactly its own action`)
  }
})

test('/rename refuses an empty title instead of retitling to nothing', async () => {
  setLanguage('en')
  const { commands, ran } = table()
  const said = await invoke(commands, 'rename', '')
  assert.deepEqual(ran, [], 'the store was called with an empty title')
  assert.equal(said.length, 1)
  assert.equal(said[0]?.kind, 'error')
  // The refusal carries the usage, because "needs something after it" without
  // saying what leaves the reader guessing at the grammar.
  assert.match(said[0]?.text ?? '', /<title>/)
})

test('/capacity says why nothing opened rather than looking ignored', async () => {
  setLanguage('en')
  const { commands, ran } = table({ capacity: false })
  const said = await invoke(commands, 'capacity')
  assert.deepEqual(ran, ['showCapacity'], 'it must still try before concluding')
  assert.equal(said[0]?.kind, 'error')
  assert.match(said[0]?.text ?? '', /context window/)
  // And with a budget there is no sentence at all: the card is the answer.
  const open = table()
  assert.deepEqual(await invoke(open.commands, 'capacity'), [])
})

test('/chat-model sets, clears and reports this conversation’s model', async () => {
  setLanguage('en')
  // Bare: a readout, not a change.
  const bare = table()
  const reported = await invoke(bare.commands, 'chat-model')
  assert.deepEqual(bare.ran, [], 'a bare /chat-model must not write anything')
  assert.match(reported[0]?.text ?? '', /deepseek-chat/)
  assert.match(reported[0]?.text ?? '', /deepseek-reasoner/, 'the readout names the choices too')

  // A name from the endpoint's list.
  const set = table()
  const done = await invoke(set.commands, 'chat-model', 'deepseek-reasoner')
  assert.deepEqual(set.ran, ['setModel:deepseek-reasoner'])
  assert.match(done[0]?.text ?? '', /Other conversations are unchanged/, 'the scope is the divergence worth stating')

  // The keyword clears the override — `null`, which is the protocol's clear,
  // and not the string `default`.
  const cleared = table({ choices: { overridden: true } })
  await invoke(cleared.commands, 'chat-model', MODEL_DEFAULT_ARG)
  assert.deepEqual(cleared.ran, ['setModel:null'])

  // Nothing to clear is said, not silently written.
  const already = table({ choices: { overridden: false } })
  const nothing = await invoke(already.commands, 'chat-model', MODEL_DEFAULT_ARG)
  assert.deepEqual(already.ran, [])
  assert.match(nothing[0]?.text ?? '', /already/)
})

test('/chat-model refuses an unlisted name only when the endpoint has answered', async () => {
  /*
   * **The policy is part of the result, so it is named here.** `models` always
   * carries the model in force, so a connection nobody has probed still yields
   * a one-row list — refusing against that would reject every valid id on a
   * connection the reader has not opened the capsule for. `listed` is the fact
   * that separates the two, and these two cases are the fork.
   */
  setLanguage('en')
  const answered = table({ choices: { listed: true } })
  const refused = await invoke(answered.commands, 'chat-model', 'gpt-4o')
  assert.deepEqual(answered.ran, [], 'an unlisted name reached the store')
  assert.equal(refused[0]?.kind, 'error')
  assert.match(refused[0]?.text ?? '', /deepseek-reasoner/, 'the refusal names the list it refused against')

  const unread = table({ choices: { listed: false, models: ['deepseek-chat'] } })
  await invoke(unread.commands, 'chat-model', 'gpt-4o')
  assert.deepEqual(unread.ran, ['setModel:gpt-4o'], 'an unprobed endpoint must not veto a valid id')
})

test('/chat-model’s argument menu offers the endpoint’s list, read live', () => {
  const { commands, setChoices } = table({ choices: { overridden: true } })
  const all = commandArgumentCompletions('/chat-model ', commands)
  assert.deepEqual(
    all?.values,
    ['deepseek-chat', 'deepseek-reasoner', MODEL_DEFAULT_ARG],
    'the undo is offered last, as the capsule menu’s footer row is',
  )
  assert.equal(all?.command.name, 'chat-model')
  // Filtered by what has been typed, case-insensitively.
  assert.deepEqual(commandArgumentCompletions('/chat-model deepseek-r', commands)?.values, ['deepseek-reasoner'])
  assert.deepEqual(commandArgumentCompletions('/chat-model DEEPSEEK-R', commands)?.values, ['deepseek-reasoner'])
  assert.equal(commandArgumentCompletions('/chat-model zzz', commands), undefined)
  /*
   * The live read. The endpoint's list arrives from a probe the reader fires by
   * opening the capsule — after this table was built — so a captured array, or
   * a captured `ModelChoices`, would offer yesterday's models forever.
   * `setChoices` **replaces** the object rather than editing it, which is what
   * `Composer.tsx` does every render and what makes both of those failures
   * visible here.
   */
  setChoices({ models: ['claude-opus'] })
  assert.deepEqual(commandArgumentCompletions('/chat-model ', commands)?.values, ['claude-opus', MODEL_DEFAULT_ARG])
})

test('an argument menu belongs to exactly one line shape', () => {
  const { commands } = table()
  // A command that takes nothing never offers values.
  assert.equal(commandArgumentCompletions('/compact ', commands), undefined)
  // A command with an argument but no completions for it — the reader is
  // writing a title, and a menu cannot know what it will be.
  assert.equal(commandArgumentCompletions('/rename ', commands), undefined)
  // The name is not settled yet: this is still a name being spelled.
  assert.equal(commandArgumentCompletions('/chat-model', commands), undefined)
  // Past completing: a value with a space in it is one the table did not offer,
  // and a menu over its first word would offer to replace what was typed.
  assert.equal(commandArgumentCompletions('/chat-model deepseek-chat x', commands), undefined)
  // Not a command line at all.
  assert.equal(commandArgumentCompletions('hello', commands), undefined)
  assert.equal(commandArgumentCompletions('/nonsense x', commands), undefined)
  // The undo is not offered when there is nothing to undo.
  const plain = table({ choices: { overridden: false } })
  assert.deepEqual(
    commandArgumentCompletions('/chat-model ', plain.commands)?.values,
    ['deepseek-chat', 'deepseek-reasoner'],
  )
})

test('a menu row and /help both show the argument placeholder', () => {
  setLanguage('en')
  const { commands } = table()
  assert.equal(commandLabel(commands.find(row => row.name === 'compact') as CommandDescriptor), '/compact')
  assert.equal(commandLabel(commands.find(row => row.name === 'rename') as CommandDescriptor), '/rename <title>')
  assert.equal(
    commandLabel(commands.find(row => row.name === 'chat-model') as CommandDescriptor),
    '/chat-model <name>|default',
    '`/chat-model` alone does not say a model name follows, which is what the placeholder is for',
  )
})

test('every command is filed under the group its object belongs to', () => {
  /*
   * **The filing is pinned, not derived.** The grouping test below reads
   * `row.group` to find the heading a row should sit under, so it proves the
   * printing is *consistent* with the filing and can say nothing about the
   * filing itself — a `/config` mis-filed under 「这个对话」 satisfied it
   * completely, which is how the teeth check found this test missing.
   *
   * So a group is asserted as the decision it is: what the command acts on.
   * `chat` acts on this conversation, `context` on what the next request
   * carries, `app` on Iris itself. A ninth command has to edit this line, and
   * that is the point — the edit is where the author states which it is.
   */
  const { commands } = table()
  assert.deepEqual(commands.map(row => [row.name, row.group]), [
    ['new', 'chat'],
    ['rename', 'chat'],
    ['export', 'chat'],
    ['chat-model', 'context'],
    ['capacity', 'context'],
    ['compact', 'context'],
    ['config', 'app'],
    ['help', 'app'],
  ])
})

test('/help groups the commands and says where everything else goes', () => {
  setLanguage('en')
  const { commands } = table()
  const said: string[] = []
  const help = commands.find(row => row.name === 'help')
  assert.ok(help !== undefined)
  help.run({ args: '', chatId: 'c1', generating: false, notify: (_kind, text) => said.push(text) })
  assert.equal(said.length, 1)
  const text = said[0] as string
  for (const row of commands) {
    assert.ok(text.includes(commandLabel(row)), `/help does not mention ${commandLabel(row)}`)
  }
  // The line that stops a reader concluding `/trigger` does not work here.
  assert.match(text, /goes to the host/)
  assert.equal(text, helpText(commands))

  /*
   * Every command sits under its own group's heading, and the headings come in
   * `COMMAND_GROUPS` order. Checked by **position**, because a grouping that
   * printed the right headings and the wrong rows under them would satisfy any
   * membership test — that is the shape this whole change could get wrong.
   */
  const lines = text.split('\n')
  const headingAt = COMMAND_GROUPS.map(group => lines.findIndex(line => line === {
    chat: 'This conversation:',
    context: 'Model and context:',
    app: 'Settings and help:',
  }[group]))
  for (const [at, index] of headingAt.entries()) {
    assert.ok(index > 0, `the heading for ${COMMAND_GROUPS[at] ?? '?'} is missing from /help`)
    if (at > 0) assert.ok(index > (headingAt[at - 1] as number), 'the headings are out of order')
  }
  for (const row of commands) {
    const rowAt = lines.findIndex(line => line.startsWith(`${commandLabel(row)} —`))
    const own = headingAt[COMMAND_GROUPS.indexOf(row.group)] as number
    const next = headingAt.filter(index => index > own).sort((a, b) => a - b)[0] ?? lines.length - 1
    assert.ok(rowAt > own && rowAt < next, `/${row.name} is not printed under its own heading`)
  }
})

test('an empty group prints no heading', () => {
  setLanguage('en')
  // The shape follows the table rather than this function's idea of it: a
  // heading over nothing is what the filter exists to prevent.
  const { commands } = table()
  const only = commands.filter(row => row.group === 'chat')
  const text = helpText(only)
  assert.match(text, /This conversation:/)
  assert.doesNotMatch(text, /Model and context:/)
  assert.doesNotMatch(text, /Settings and help:/)
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
