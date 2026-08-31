import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyRegexScripts,
  escapeForPattern,
  orderScripts,
  PLACEMENT,
  regexFromString,
  runRegexScript,
  SCRIPT_TYPE,
  SUBSTITUTE,
  type RegexScript,
} from '../src/index.ts'

/** A script with the defaults a card editor would leave in place. */
function script(overrides: Partial<RegexScript> & Pick<RegexScript, 'findRegex' | 'replaceString'>): RegexScript {
  return { placement: [PLACEMENT.AI_OUTPUT], trimStrings: [], ...overrides }
}

// ── the scenario this package exists for ────────────────────────────────────

/**
 * The two scripts MVU's own install instructions require, verbatim.
 *
 * "与这个工具相关的有一个脚本、两个正则和一个世界书条目" — these are the two.
 */
const MVU_STRIP_COMMANDS = script({
  scriptName: '去除变量更新',
  findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gm',
  replaceString: '',
  placement: [PLACEMENT.AI_OUTPUT],
  markdownOnly: true,
  promptOnly: true,
})

const MVU_HIDE_STATUS = script({
  scriptName: '对 AI 隐藏状态栏',
  findRegex: '<StatusPlaceHolderImpl/>',
  replaceString: '',
  placement: [PLACEMENT.AI_OUTPUT],
  promptOnly: true,
})

/** A reply shaped like the ones the live demo produced. */
const MVU_REPLY = [
  '络络对你笑了笑。',
  '<UpdateVariable>',
  `_.add('络络.好感度[0]', 5);//愉快的交谈`,
  '</UpdateVariable>',
  '',
  '<StatusPlaceHolderImpl/>',
].join('\n')

const MVU_SCRIPTS = [MVU_STRIP_COMMANDS, MVU_HIDE_STATUS]

test('the reader never sees the raw command block', () => {
  const shown = applyRegexScripts(MVU_REPLY, PLACEMENT.AI_OUTPUT, MVU_SCRIPTS, { isMarkdown: true })

  assert.equal(shown.includes('UpdateVariable'), false)
  assert.match(shown, /络络对你笑了笑。/)
  // The status placeholder is prompt-only, so it survives display.
  assert.equal(shown.includes('<StatusPlaceHolderImpl/>'), true)
})

test('the model never reads its own previous command block', () => {
  // The failure this prevents: without it, last turn's commands are in the
  // context and the model re-issues or contradicts them, corrupting state.
  const sent = applyRegexScripts(MVU_REPLY, PLACEMENT.AI_OUTPUT, MVU_SCRIPTS, { isPrompt: true })

  assert.equal(sent.includes('UpdateVariable'), false)
  assert.equal(sent.includes('StatusPlaceHolderImpl'), false)
})

test('the stored message keeps everything', () => {
  // Both MVU scripts are ephemeral, so the durable log is untouched and the
  // command history stays recoverable.
  const stored = applyRegexScripts(MVU_REPLY, PLACEMENT.AI_OUTPUT, MVU_SCRIPTS, {})

  assert.equal(stored, MVU_REPLY)
})

// ── ephemerality ────────────────────────────────────────────────────────────

test('a script with neither flag rewrites the stored text', () => {
  const permanent = script({ findRegex: '/ugly/g', replaceString: 'pretty' })

  assert.equal(applyRegexScripts('an ugly line', PLACEMENT.AI_OUTPUT, [permanent], {}), 'an pretty line')
})

test('a permanent script does not run again at display or prompt time', () => {
  // Upstream's reasoning: the stored text was already rewritten when it was
  // saved, so running it again would apply it twice.
  const permanent = script({ findRegex: '/x/g', replaceString: 'xx' })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [permanent], { isMarkdown: true }), 'x')
  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [permanent], { isPrompt: true }), 'x')
})

test('a display-only script leaves the prompt alone and vice versa', () => {
  const display = script({ findRegex: '/secret/g', replaceString: '[redacted]', markdownOnly: true })
  const prompt = script({ findRegex: '/secret/g', replaceString: '[hidden]', promptOnly: true })

  assert.equal(applyRegexScripts('a secret', PLACEMENT.AI_OUTPUT, [display], { isPrompt: true }), 'a secret')
  assert.equal(applyRegexScripts('a secret', PLACEMENT.AI_OUTPUT, [prompt], { isMarkdown: true }), 'a secret')
})

// ── placement ───────────────────────────────────────────────────────────────

test('a script only runs at the placements it names', () => {
  const aiOnly = script({ findRegex: '/hi/g', replaceString: 'HI', placement: [PLACEMENT.AI_OUTPUT] })

  assert.equal(applyRegexScripts('hi', PLACEMENT.AI_OUTPUT, [aiOnly], {}), 'HI')
  assert.equal(applyRegexScripts('hi', PLACEMENT.USER_INPUT, [aiOnly], {}), 'hi')
})

test('a script with no placement never runs', () => {
  const orphan = script({ findRegex: '/hi/g', replaceString: 'HI', placement: [] })

  assert.equal(applyRegexScripts('hi', PLACEMENT.AI_OUTPUT, [orphan], {}), 'hi')
})

test('world info and reasoning are addressable placements', () => {
  const both = script({ findRegex: '/x/g', replaceString: 'y', placement: [PLACEMENT.WORLD_INFO, PLACEMENT.REASONING] })

  assert.equal(applyRegexScripts('x', PLACEMENT.WORLD_INFO, [both], {}), 'y')
  assert.equal(applyRegexScripts('x', PLACEMENT.REASONING, [both], {}), 'y')
  assert.equal(applyRegexScripts('x', PLACEMENT.SLASH_COMMAND, [both], {}), 'x')
})

// ── pattern parsing ─────────────────────────────────────────────────────────

test('both the delimited and the bare pattern form parse', () => {
  assert.equal(regexFromString('/abc/gi')?.source, 'abc')
  assert.equal(regexFromString('/abc/gi')?.flags, 'gi')
  assert.equal(regexFromString('abc')?.source, 'abc')
})

test('a bare pattern replaces only its first match', () => {
  // Upstream behaviour, pinned because it is surprising enough that someone
  // will eventually "fix" it: a bare pattern carries no flags, so a script
  // written as `{{char}}` rewrites the first mention and leaves the rest.
  // Adding `g` here would silently change what every such card does.
  const bare = script({ findRegex: 'X', replaceString: 'Y' })
  const global = script({ findRegex: '/X/g', replaceString: 'Y' })

  assert.equal(regexFromString('X')?.flags, '')
  assert.equal(applyRegexScripts('X a X', PLACEMENT.AI_OUTPUT, [bare], {}), 'Y a X')
  assert.equal(applyRegexScripts('X a X', PLACEMENT.AI_OUTPUT, [global], {}), 'Y a Y')
})

test('a bare pattern containing a slash is not mistaken for a delimiter', () => {
  // The exact shape of MVU's second script.
  const compiled = regexFromString('<StatusPlaceHolderImpl/>')

  assert.ok(compiled?.test('<StatusPlaceHolderImpl/>'))
})

test('an uncompilable pattern leaves the text alone', () => {
  const broken = script({ findRegex: '/([unclosed/g', replaceString: 'x' })

  assert.equal(regexFromString('([unclosed'), undefined)
  assert.equal(applyRegexScripts('untouched', PLACEMENT.AI_OUTPUT, [broken], {}), 'untouched')
})

test('one broken script does not stop the others', () => {
  const scripts = [
    script({ findRegex: '/([broken/g', replaceString: 'x' }),
    script({ findRegex: '/works/g', replaceString: 'worked' }),
  ]

  assert.equal(applyRegexScripts('it works', PLACEMENT.AI_OUTPUT, scripts, {}), 'it worked')
})

// ── replacement ─────────────────────────────────────────────────────────────

test('{{match}} stands for the whole match', () => {
  const wrap = script({ findRegex: '/\\bfog\\b/g', replaceString: '*{{match}}*' })

  assert.equal(applyRegexScripts('the fog rolled in', PLACEMENT.AI_OUTPUT, [wrap], {}), 'the *fog* rolled in')
})

test('numbered and named capture groups are substituted', () => {
  const numbered = script({ findRegex: '/(\\w+)@(\\w+)/g', replaceString: '$2 of $1' })
  const named = script({ findRegex: '/(?<who>\\w+) said/g', replaceString: '$<who> spoke' })

  assert.equal(applyRegexScripts('aria@vienna', PLACEMENT.AI_OUTPUT, [numbered], {}), 'vienna of aria')
  assert.equal(applyRegexScripts('Aria said', PLACEMENT.AI_OUTPUT, [named], {}), 'Aria spoke')
})

test('an unmatched optional group contributes nothing, not a literal $1', () => {
  const optional = script({ findRegex: '/a(x)?b/g', replaceString: '[$1]' })

  assert.equal(applyRegexScripts('ab', PLACEMENT.AI_OUTPUT, [optional], {}), '[]')
})

test('trim strings are stripped from each captured value', () => {
  const trimmed = script({
    findRegex: '/\\[.*?\\]/g',
    replaceString: '{{match}}',
    trimStrings: ['[', ']'],
  })

  assert.equal(applyRegexScripts('say [hello] now', PLACEMENT.AI_OUTPUT, [trimmed], {}), 'say hello now')
})

// ── depth and edit windows ──────────────────────────────────────────────────

test('a depth window limits which messages a script touches', () => {
  const recentOnly = script({ findRegex: '/x/g', replaceString: 'y', minDepth: 0, maxDepth: 2 })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [recentOnly], { depth: 1 }), 'y')
  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [recentOnly], { depth: 5 }), 'x')
})

test('minDepth of -1 is a real bound rather than an absent one', () => {
  const script1 = script({ findRegex: '/x/g', replaceString: 'y', minDepth: -1 })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [script1], { depth: -1 }), 'y')
})

test('a null depth bound means unset', () => {
  const unbounded = script({ findRegex: '/x/g', replaceString: 'y', minDepth: null, maxDepth: null })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [unbounded], { depth: 99 }), 'y')
})

test('a hand edit only runs the scripts that opted in', () => {
  const optedIn = script({ findRegex: '/x/g', replaceString: 'in', runOnEdit: true })
  const optedOut = script({ findRegex: '/x/g', replaceString: 'out' })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [optedIn], { isEdit: true }), 'in')
  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [optedOut], { isEdit: true }), 'x')
})

test('a disabled script never runs', () => {
  const off = script({ findRegex: '/x/g', replaceString: 'y', disabled: true })

  assert.equal(applyRegexScripts('x', PLACEMENT.AI_OUTPUT, [off], {}), 'x')
  assert.equal(runRegexScript(off, 'x'), 'x')
})

// ── macros in patterns ──────────────────────────────────────────────────────

test('escaped substitution stops a name from being read as syntax', () => {
  // A character called `A.B` must not match `AxB`.
  const substitute = (text: string, options?: { postProcess?: (value: string) => string }) =>
    text.replaceAll('{{char}}', options?.postProcess === undefined ? 'A.B' : options.postProcess('A.B'))

  const escaped = script({
    findRegex: '{{char}}',
    replaceString: 'NAME',
    substituteRegex: SUBSTITUTE.ESCAPED,
  })

  assert.equal(applyRegexScripts('A.B and AxB', PLACEMENT.AI_OUTPUT, [escaped], { substitute }), 'NAME and AxB')
})

test('raw substitution lets an expanded macro carry regex syntax', () => {
  // The alternation has to survive expansion as syntax rather than as text —
  // which is the whole difference between RAW and ESCAPED.
  const substitute = (text: string) => text.replaceAll('{{pattern}}', 'cat|dog')
  const raw = script({ findRegex: '/{{pattern}}/g', replaceString: 'X', substituteRegex: SUBSTITUTE.RAW })

  assert.equal(applyRegexScripts('a cat and a dog', PLACEMENT.AI_OUTPUT, [raw], { substitute }), 'a X and a X')
  // Under ESCAPED the same expansion would be matched literally instead.
  const escaped = script({ findRegex: '{{pattern}}', replaceString: 'X', substituteRegex: SUBSTITUTE.ESCAPED })
  const escapingSubstitute = (text: string, options?: { postProcess?: (value: string) => string }) =>
    text.replaceAll('{{pattern}}', options?.postProcess === undefined ? 'cat|dog' : options.postProcess('cat|dog'))
  assert.equal(
    applyRegexScripts('a cat and a dog', PLACEMENT.AI_OUTPUT, [escaped], { substitute: escapingSubstitute }),
    'a cat and a dog',
  )
})

test('no substitution mode leaves the pattern literal even with an expander present', () => {
  const substitute = (text: string) => text.replaceAll('{{char}}', 'Aria')
  const none = script({ findRegex: '{{char}}', replaceString: 'X', substituteRegex: SUBSTITUTE.NONE })

  assert.equal(applyRegexScripts('Aria', PLACEMENT.AI_OUTPUT, [none], { substitute }), 'Aria')
  assert.equal(applyRegexScripts('{{char}}', PLACEMENT.AI_OUTPUT, [none], { substitute }), 'X')
})

test('macros in the replacement expand', () => {
  const substitute = (text: string) => text.replaceAll('{{user}}', 'Traveller')
  const greet = script({ findRegex: '/NAME/g', replaceString: '{{user}}' })

  assert.equal(applyRegexScripts('hello NAME', PLACEMENT.AI_OUTPUT, [greet], { substitute }), 'hello Traveller')
})

test('escapeForPattern neutralises metacharacters and control characters', () => {
  assert.equal(escapeForPattern('a.b'), 'a\\.b')
  assert.equal(escapeForPattern('a\nb'), 'a\\nb')
  assert.equal(escapeForPattern('(x)'), '\\(x\\)')
})

// ── ordering ────────────────────────────────────────────────────────────────

test('global scripts run before the character’s, and those before the preset’s', () => {
  const ordered = orderScripts([
    { script: script({ findRegex: '/./', replaceString: 'preset' }), type: SCRIPT_TYPE.PRESET },
    { script: script({ findRegex: '/./', replaceString: 'scoped' }), type: SCRIPT_TYPE.SCOPED },
    { script: script({ findRegex: '/./', replaceString: 'global' }), type: SCRIPT_TYPE.GLOBAL },
  ])

  assert.deepEqual(ordered.map(entry => entry.replaceString), ['global', 'scoped', 'preset'])
})

test('ordering is stable inside a tier, because a card lists its scripts in sequence', () => {
  const ordered = orderScripts([
    { script: script({ findRegex: '/1/', replaceString: 'first' }), type: SCRIPT_TYPE.SCOPED },
    { script: script({ findRegex: '/2/', replaceString: 'second' }), type: SCRIPT_TYPE.SCOPED },
  ])

  assert.deepEqual(ordered.map(entry => entry.replaceString), ['first', 'second'])
})

test('scripts compose in the order given', () => {
  const scripts = [
    script({ findRegex: '/a/g', replaceString: 'b' }),
    script({ findRegex: '/b/g', replaceString: 'c' }),
  ]

  assert.equal(applyRegexScripts('a', PLACEMENT.AI_OUTPUT, scripts, {}), 'c')
})

test('empty text is returned untouched', () => {
  assert.equal(applyRegexScripts('', PLACEMENT.AI_OUTPUT, [MVU_STRIP_COMMANDS], { isPrompt: true }), '')
})
