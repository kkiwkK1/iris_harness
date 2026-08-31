import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMacroContext,
  createMacroRegistry,
  expandMacros,
  MacroRegistrationError,
  MacroRegistry,
  registerBuiltins,
  type MacroInvocation,
} from '../src/index.ts'

/** A bare invocation, for exercising the registry without the expander. */
function invocation(name: string, args: string[] = []): MacroInvocation {
  return {
    name,
    args,
    raw: `{{${[name, ...args].join('::')}}}`,
    offset: 0,
    source: '',
    context: createMacroContext(),
    scratch: new Map<string, unknown>(),
    expand: text => text,
  }
}

test('a disposer removes exactly its own registration', () => {
  const registry = new MacroRegistry()
  const dispose = registry.register('greeting', () => 'hi')

  assert.equal(registry.resolve(invocation('greeting')), 'hi')
  dispose()
  assert.equal(registry.resolve(invocation('greeting')), undefined)
  assert.equal(registry.has('greeting'), false)
  dispose()
})

test('a later registration shadows an earlier one and disposing restores it', () => {
  const registry = new MacroRegistry()
  registry.register('char', () => 'base')
  const dispose = registry.register('char', () => 'override')

  assert.equal(registry.resolve(invocation('char')), 'override')
  dispose()
  assert.equal(registry.resolve(invocation('char')), 'base', 'the shadowed registration comes back')
})

test('a shadowing resolver that declines falls through to the one it shadows', () => {
  const registry = new MacroRegistry()
  registry.register('time', () => 'local')
  registry.register('time', inv => (inv.args[0] === 'UTC+9' ? 'tokyo' : undefined))

  assert.equal(registry.resolve(invocation('time', ['UTC+9'])), 'tokyo')
  assert.equal(registry.resolve(invocation('time')), 'local')
})

test('names are matched case-insensitively', () => {
  const registry = new MacroRegistry()
  registry.register('LastMessage', () => 'x')

  assert.equal(registry.resolve(invocation('lastmessage')), 'x')
  assert.deepEqual(registry.names(), ['lastmessage'])
})

test('a name with braces or no name at all is refused', () => {
  const registry = new MacroRegistry()

  assert.throws(() => registry.register('{{char}}', () => ''), MacroRegistrationError)
  assert.throws(() => registry.register('   ', () => ''), MacroRegistrationError)
})

test('a regex macro rewrites text the named pass left alone', () => {
  const registry = createMacroRegistry()
  const context = createMacroContext({ char: 'Seraphina' })

  const dispose = registry.registerMacroLike(
    /\{\{get_chat_variable::(.*?)\}\}/g,
    (_context, _substring, path) => `<${String(path)}>`,
  )

  assert.equal(
    expandMacros('{{char}} has {{get_chat_variable::hp}}', context, { registry }),
    'Seraphina has <hp>',
  )

  dispose()
  assert.equal(
    expandMacros('{{char}} has {{get_chat_variable::hp}}', context, { registry }),
    'Seraphina has {{get_chat_variable::hp}}',
    'once disposed the syntax is left for whoever else may own it',
  )
})

test('a regex macro is told which message it is expanding', () => {
  const registry = new MacroRegistry()
  registry.registerMacroLike(/<who>/g, context => `${context.role ?? '?'}#${context.messageId ?? '?'}`)

  const context = createMacroContext({ messageId: 4, role: 'assistant' })
  assert.equal(expandMacros('{{noop}}<who>', context, { registry }), '{{noop}}assistant#4')
})

test('the builtin vocabulary can be retracted as a whole', () => {
  const registry = new MacroRegistry()
  const dispose = registerBuiltins(registry)

  assert.ok(registry.has('char'))
  assert.ok(registry.has('getglobalvar'))

  dispose()
  assert.deepEqual(registry.names(), [], 'unloading the plugin leaves nothing behind')
})
