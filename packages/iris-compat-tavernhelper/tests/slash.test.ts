import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  parseSlashCommands,
  splitPipeline,
  UnsupportedSlashCommandError,
} from '../src/slash.ts'

/**
 * The two slash commands the corpus calls, and the refusal of everything else.
 *
 * The escape rule gets the most attention because it is the one that fails
 * quietly: a pipe typed by a user inside a message would cut that message in
 * half, and nothing would report it.
 */

test('the one pattern the corpus actually uses', () => {
  // `triggerSlash(`/send ${text}|/trigger`)` — four call sites, one snippet.
  assert.deepEqual(parseSlashCommands('/send 你好|/trigger'), [
    { name: 'send', text: '你好' },
    { name: 'trigger' },
  ])
})

/** One backslash, named rather than escaped — see the note on this test. */
const BS = String.fromCharCode(92)

test('a pipe the user typed is escaped, not a separator', () => {
  // Built from a named constant instead of backslash literals. Four times this
  // session a shell heredoc has silently halved the backslashes in a file, and
  // three of those times the fix was to correct the escaping; the durable fix
  // is to write a test whose meaning does not depend on getting escaping right.
  //
  // Upstream counts backslashes: an odd number escapes the pipe, an even number
  // is literal pairs and the pipe still separates.
  assert.deepEqual(splitPipeline(`a${BS}|b`), [`a${BS}|b`], 'one backslash escapes the pipe')
  assert.deepEqual(splitPipeline(`a${BS}${BS}|b`), [`a${BS}${BS}`, 'b'], 'two backslashes are a pair; the pipe splits')
  assert.deepEqual(splitPipeline('a|b'), ['a', 'b'])

  // The failure this guards is silent: a pipe inside a user's own message would
  // otherwise cut the message in half with nothing reported.
  assert.deepEqual(parseSlashCommands(`/send why not both${BS}|either`), [
    { name: 'send', text: 'why not both|either' },
  ])
})

test('an empty segment is a break, not a failure', () => {
  // Upstream treats `||` as a pipe break rather than an error.
  assert.deepEqual(parseSlashCommands('/send hi||/trigger'), [
    { name: 'send', text: 'hi' },
    { name: 'trigger' },
  ])
  assert.deepEqual(parseSlashCommands('/trigger|'), [{ name: 'trigger' }])
})

test('/send keeps the whole argument, including its spaces', () => {
  assert.deepEqual(parseSlashCommands('/send  两个  空格  '), [{ name: 'send', text: '两个  空格' }])
  assert.deepEqual(parseSlashCommands('/send'), [{ name: 'send', text: '' }])
})

test('a command name is matched without regard to case', () => {
  assert.deepEqual(parseSlashCommands('/SEND hi|/Trigger'), [
    { name: 'send', text: 'hi' },
    { name: 'trigger' },
  ])
})

test('anything else is refused by name, and says why', () => {
  // The refusal carries the evidence: when a real card calls one of these, the
  // error names it, and that name is the argument for implementing it.
  for (const command of ['setvar', 'gen', 'if', 'inject', 'regex', 'echo']) {
    assert.throws(
      () => parseSlashCommands(`/${command} x`),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedSlashCommandError)
        assert.equal(error.command, command)
        assert.match(error.message, new RegExp(`/${command}`))
        return true
      },
      `/${command} was not refused`,
    )
  }
})

test('a segment that is not a command at all is refused too', () => {
  assert.throws(() => parseSlashCommands('send hi'), UnsupportedSlashCommandError)
  assert.throws(() => parseSlashCommands('/send hi|oops'), UnsupportedSlashCommandError)
})
