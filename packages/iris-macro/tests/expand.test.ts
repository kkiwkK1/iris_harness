import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMacroContext,
  createMacroRegistry,
  toRegexSubstitute,
  createMemoryVariableStore,
  expandMacros,
  MacroRegistry,
  type MacroContextInput,
} from '../src/index.ts'

/** A registry with the builtins, private to one test. */
function fixture(input: MacroContextInput = {}) {
  const registry = createMacroRegistry()
  const variables = createMemoryVariableStore()
  const context = createMacroContext({ char: 'Seraphina', user: 'Alex', variables, ...input })
  const expand = (text: string, maxDepth?: number): string =>
    expandMacros(text, context, maxDepth === undefined ? { registry } : { registry, maxDepth })
  return { registry, variables, context, expand }
}

test('text with nothing to expand comes back as the very same string', () => {
  const { context, registry } = fixture()
  const text = 'She looked up from the ledger and said nothing at all.'

  const result = expandMacros(text, context, { registry })
  assert.ok(Object.is(result, text), 'the fast path must not even rebuild the string')
  assert.equal(expandMacros('', context, { registry }), '')
})

test('an unknown macro is left in place, not blanked', () => {
  const { expand } = fixture()

  assert.equal(expand('a {{someOtherExtension}} b'), 'a {{someOtherExtension}} b')
  assert.equal(expand('{{qvink_memory::3}}'), '{{qvink_memory::3}}')
})

test('an unknown macro still gets its nested macros resolved', () => {
  const { expand } = fixture()

  // What SillyTavern's parser does: keep the syntax, resolve what is inside.
  assert.equal(expand('{{someExt::{{char}}}}'), '{{someExt::Seraphina}}')
})

test('adjacent and nested macros both resolve', () => {
  const { expand, variables } = fixture()
  variables.set('local', 'Seraphina_hp', '42')

  assert.equal(expand('{{char}}{{user}}'), 'SeraphinaAlex')
  assert.equal(expand('{{getvar::{{char}}_hp}}'), '42')
})

test('arguments split on top-level :: only', () => {
  const { registry, expand } = fixture()
  registry.register('probe', invocation => `${invocation.args.length}|${invocation.args.join('/')}`)

  assert.equal(expand('{{probe::a::b::c}}'), '3|a/b/c')
  assert.equal(expand('{{probe::a}}'), '1|a')
  assert.equal(expand('{{probe}}'), '0|')
  // The `::` inside a surviving unknown macro belongs to that macro.
  assert.equal(expand('{{probe::{{unknownExt::a::b}}}}'), '1|{{unknownExt::a::b}}')
})

test('arguments containing macros are expanded before the split', () => {
  const { expand, variables } = fixture()

  assert.equal(expand('{{setvar::note::{{char}} is here}}'), '')
  assert.equal(variables.local.get('note'), 'Seraphina is here')
})

test('a resolved value is never rescanned', () => {
  const { expand, variables } = fixture()
  // The whole point: a stored string that looks like a macro is data, not code.
  variables.set('local', 'payload', '{{setvar::pwned::1}}')

  assert.equal(expand('{{getvar::payload}}'), '{{setvar::pwned::1}}')
  assert.equal(variables.local.get('pwned'), undefined)
})

test('card fields do re-expand, because descriptions name the cast', () => {
  const { expand } = fixture({
    character: { description: '{{char}} met {{user}} in Vienna.' },
  })

  assert.equal(expand('{{description}}'), 'Seraphina met Alex in Vienna.')
})

test('a self-referential card field terminates at the depth limit', () => {
  const { expand } = fixture({ character: { description: 'loop {{description}}' } })

  assert.equal(expand('{{description}}', 2), 'loop loop loop {{description}}')
})

test('escaped braces survive as literal text', () => {
  const { expand } = fixture()

  assert.equal(expand('write \\{\\{char\\}\\} to keep it'), 'write {{char}} to keep it')
  assert.equal(expand('{{char}} and \\{{{user}}\\}'), 'Seraphina and {Alex}')
})

test('an unterminated brace pair is ordinary text', () => {
  const { expand } = fixture()

  assert.equal(expand('a {{char and b'), 'a {{char and b')
  assert.equal(expand('{{char}} }} {{user}}'), 'Seraphina }} Alex')
})

test('{{trim}} eats the newlines around itself', () => {
  const { expand } = fixture()

  assert.equal(expand('above\n\n{{trim}}\n\nbelow'), 'abovebelow')
  assert.equal(expand('{{char}}\n{{trim}}\n{{user}}'), 'SeraphinaAlex')
})

test('legacy angle-bracket markers are accepted', () => {
  const { expand } = fixture()

  assert.equal(expand('<USER> greets <BOT>'), 'Alex greets Seraphina')
  assert.equal(expand('<CHAR> waits'), 'Seraphina waits')
})

test('a macro name may be introduced by a space or a single colon', () => {
  const { expand } = fixture()

  assert.equal(expand('{{reverse::abc}}'), 'cba')
  assert.equal(expand('{{reverse:abc}}'), 'cba')
  assert.equal(expand('{{reverse abc}}'), 'cba')
  assert.equal(expand('{{ char }}'), 'Seraphina')
})

test('a whitespace-introduced list keeps its `::` for the parts', () => {
  const { expand } = fixture()

  // The spelling upstream's own examples use: an introducer space followed by
  // `::` introduces the list, it does not manufacture an empty first argument.
  assert.equal(expand('{{ timeDiff :: 2023-01-02 :: 2023-01-01 }}'), 'in a day')
  // Direct `::` after the name is unchanged, and a single-colon list still
  // reaches the macro as one argument when the parts do not continue with `::`.
  assert.equal(expand('{{timeDiff::2023-01-02::2023-01-01}}'), 'in a day')
  assert.equal(expand('{{reverse:abc}}'), 'cba')
})

test('regex macros run after named expansion, so they see the leftovers', () => {
  const registry = new MacroRegistry()
  const context = createMacroContext()
  const seen: string[] = []
  registry.registerMacroLike(/\{\{leftover\}\}/g, (_context, substring) => {
    seen.push(substring)
    return 'caught'
  })

  assert.equal(expandMacros('x {{leftover}} y', context, { registry }), 'x caught y')
  assert.deepEqual(seen, ['{{leftover}}'])
})

test('postProcess transforms what a macro expanded to, not the text around it', () => {
  // The distinction a regex script depends on: a pattern built from `{{char}}`
  // must transform the NAME and leave the pattern's own syntax alone. Escaping
  // itself is `@iris/regex`'s job and is tested there; what matters here is
  // which characters the hook is even shown.
  const { context, registry } = fixture({ char: 'Seraphina' })

  const marked = expandMacros('^{{char}}.*$', context, {
    registry,
    postProcess: value => `<${value}>`,
  })

  assert.equal(marked, '^<Seraphina>.*$')
})

test('postProcess leaves an unresolved macro alone', () => {
  // An unrecognized macro passes through verbatim, so it is not a substituted
  // value and must not be handed to the hook.
  const { context, registry } = fixture()

  assert.equal(
    expandMacros('{{nobody_registered_this}}', context, { registry, postProcess: () => 'TOUCHED' }),
    '{{nobody_registered_this}}',
  )
})

test('a value composed from nested expansion is transformed once, not twice', () => {
  // Applying at every level would escape an inner value on the way in and again
  // on the way out, which is how a pattern ends up double-escaped.
  const { context, registry } = fixture({ char: 'Seraphina' })
  const dispose = registry.register('wrap', invocation => `[${invocation.expand('{{char}}')}]`)

  const result = expandMacros('{{wrap}}', context, {
    registry,
    postProcess: value => `<${value}>`,
  })
  dispose()

  assert.equal(result, '<[Seraphina]>', 'the outer value once; the inner not on its own')
})

test('toRegexSubstitute hands the regex engine the shape it asks for', () => {
  const { context, registry } = fixture({ char: 'Seraphina' })
  const substitute = toRegexSubstitute(context, { registry })

  assert.equal(substitute('{{char}}'), 'Seraphina', 'no hook means verbatim expansion')
  assert.equal(substitute('{{char}}', { postProcess: value => value.toUpperCase() }), 'SERAPHINA')
})
