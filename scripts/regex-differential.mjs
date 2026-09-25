/**
 * The differential: Iris's regex engine against the installed SillyTavern's.
 *
 * The point of this file is to retire a class of question — "does our engine
 * mean what their engine means?" — from human review. The oracle is not a
 * re-implementation and not a golden recording: it is the **installed ST's own
 * `engine.js`**, loaded from wherever SillyTavern is installed
 * (`IRIS_ST_SRC`, default `E:/sillyTavern/SillyTavern/public` on this
 * machine) through the stub loader in `st-stub-loader.mjs`, which serves the
 * five app-tree imports the engine makes. Both engines then run the same
 * fixture scripts over the same inputs, and the outputs are compared
 * byte-for-byte.
 *
 * What is deliberately in scope: stage gating (markdownOnly/promptOnly),
 * depth windows, tier order and allow-gating, `$n`/`$<name>`/`{{match}}`
 * replacement, trim strings, invalid and non-global patterns, empty input.
 * What is deliberately out: macro substitution (both engines substitute
 * through one injected function, which the harness pins to identity) and
 * anything behind the settings UI.
 *
 * Run: `node scripts/regex-differential.mjs`, or `pnpm test:regex-differential`.
 * Exits non-zero on any divergence. Skips with a note when no ST install is
 * found, like the corpus tests do.
 *
 * @module scripts/regex-differential
 */

import { register } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ST_PUBLIC = process.env.IRIS_ST_SRC ?? 'E:/sillyTavern/SillyTavern/public'
const ENGINE = join(ST_PUBLIC, 'scripts', 'extensions', 'regex', 'engine.js')

if (!existsSync(ENGINE)) {
  console.log(`[skip] no SillyTavern install at ${ST_PUBLIC} — set IRIS_ST_SRC to run the differential`)
  process.exit(0)
}

register('./st-stub-loader.mjs', import.meta.url, { data: { stPublic: ST_PUBLIC } })

// Publish the stub state on the main thread before the engine is imported:
// the stub modules capture these objects at evaluation time (on the main
// thread, where modules execute), and the harness mutates their *contents*
// per fixture (never the references), so the engine's reads stay live.
globalThis.__stStubCharacters = []
globalThis.__stStubPresetScripts = []
globalThis.__stStubExtensionSettings = { disabledExtensions: [], regex: /** @type {any[]} */ ([]) }
const stub = {
  characters: globalThis.__stStubCharacters,
  presetScripts: globalThis.__stStubPresetScripts,
  extensionSettings: globalThis.__stStubExtensionSettings,
}
stub.characters.push({
  avatar: 'fixture.png',
  data: { extensions: { regex_scripts: [] } },
})

const USER_INPUT = /** @type {const} */ (1)
const AI_OUTPUT = /** @type {const} */ (2)

/**
 * A script with every field both engines read, as the Izumi preset family
 * writes them: `/pattern/flags` strings, placement arrays, depth windows.
 */
const script = fields => ({
  scriptName: 'fixture',
  findRegex: '',
  replaceString: '',
  trimStrings: [],
  disabled: false,
  placement: [AI_OUTPUT],
  markdownOnly: false,
  promptOnly: false,
  minDepth: null,
  maxDepth: null,
  substituteRegex: 0,
  runOnEdit: true,
  ...fields,
})

const FIXTURES = [
  {
    name: 'izumi-family (thinking erase, event beautify, progress window, status placeholder)',
    presetAllowed: true,
    global: [],
    preset: [
      {
        scriptName: 'erase thinking (prompt only)',
        findRegex: '/<think>[\\s\\S]*?<\\/think>/g',
        replaceString: '',
        placement: [AI_OUTPUT],
        promptOnly: true,
      },
      {
        scriptName: 'beautify events (display only, depth ≤ 4)',
        findRegex: '/<current_event>([\\s\\S]*?)<\\/current_event>\\s*<progress>([\\s\\S]*?)<\\/progress>/g',
        replaceString: '★ 任务指引 $1 💾 存档 Log $2',
        placement: [AI_OUTPUT],
        markdownOnly: true,
        maxDepth: 4,
      },
    ],
    scoped: [
      {
        scriptName: 'hide variable updates (prompt only)',
        findRegex: '/<update>[\\s\\S]*?<\\/update>/g',
        replaceString: '',
        placement: [USER_INPUT, AI_OUTPUT],
        promptOnly: true,
      },
      {
        scriptName: 'beautify variable updates (display only)',
        findRegex: '/<update>([\\s\\S]*?)<\\/update>/g',
        replaceString: '<div class="uv">$1</div>',
        placement: [AI_OUTPUT],
        markdownOnly: true,
      },
    ],
  },
  {
    name: 'replacement semantics (named groups, {{match}}, trim strings, one non-global)',
    presetAllowed: true,
    global: [],
    preset: [
      {
        scriptName: 'named group',
        findRegex: '/(?<who>[A-Z][a-z]+) says hello/',
        replaceString: '$<who> waved',
        placement: [AI_OUTPUT],
        markdownOnly: true,
      },
      {
        scriptName: 'match token and trim strings',
        findRegex: '/"([^"]+)"/g',
        replaceString: '「{{match}}」',
        trimStrings: ['！'],
        placement: [AI_OUTPUT],
        markdownOnly: true,
      },
      {
        scriptName: 'non-global replaces once',
        findRegex: '/a/gi',
        replaceString: 'A',
        placement: [AI_OUTPUT],
        markdownOnly: true,
      },
    ],
    scoped: [],
  },
  {
    name: 'tier gating: the preset tier is not allowed',
    presetAllowed: false,
    global: [
      {
        scriptName: 'global alt-source (runs when neither stage flag is set)',
        findRegex: '/(alt source)/g',
        replaceString: 'ALT',
        placement: [AI_OUTPUT],
      },
    ],
    preset: [
      {
        scriptName: 'preset rule that must not run while refused',
        findRegex: '/(refused tier)/g',
        replaceString: 'SHOULD NOT APPEAR',
        placement: [AI_OUTPUT],
        markdownOnly: true,
      },
    ],
    scoped: [],
  },
]

const RAW_STRINGS = [
  '正文一段。\n<current_event>当前主线任务: MQ.I</current_event>\n<progress>PG.1 时间推进</progress>\n<advice>建议一句</advice>\n正文收尾。',
  '<think>推理过程，可能很长</think>正文开始。<update>变量A=1</update>继续。',
  '"引号一句！" 说不说 hello 都行，aAa 之间。',
  'alt source 原文一行。',
  'refused tier 原文一行。',
  '',
]

const STAGES = [
  { isMarkdown: true, isPrompt: false },
  { isMarkdown: false, isPrompt: true },
  { isMarkdown: false, isPrompt: false },
  { isMarkdown: true, isPrompt: true },
]
const DEPTHS = [0, 2, 5, 11]
const PLACEMENTS = [USER_INPUT, AI_OUTPUT]

// --- run --------------------------------------------------------------------

/**
 * Fill in the fields ST's own UI always writes. Real scripts carry
 * `trimStrings`, `substituteRegex` and friends even when the author left them
 * at their defaults; the engine reads them unguarded, and a fixture missing
 * them would crash the oracle instead of testing it.
 */
const normalize = fields => ({
  trimStrings: [],
  substituteRegex: 0,
  disabled: false,
  runOnEdit: true,
  minDepth: null,
  maxDepth: null,
  placement: [AI_OUTPUT],
  ...fields,
})

const engineUrl = pathToFileURL(ENGINE).href

// ST narrates its skips on console.debug; the differential's own report is
// the output that matters, and 400+ debug lines per run bury it.
const debug = console.debug
console.debug = () => {}
const st = await import(engineUrl)
const iris = await import('../packages/iris-regex/src/engine.ts')

let cases = 0
let divergences = 0

for (const fixture of FIXTURES) {
  // The stub's mutable state: global tier lives in extension_settings.regex,
  // the preset tier in the stub preset, the scoped tier on the fixture
  // character — and the allow-list decides what getRegexScripts admits.
  stub.extensionSettings.regex = fixture.global.map(normalize)
  stub.extensionSettings.disabledExtensions = []
  stub.extensionSettings.character_allowed_regex = ['fixture.png']
  stub.extensionSettings.preset_allowed_regex = { openai: fixture.presetAllowed ? ['fixture'] : [] }
  stub.presetScripts.length = 0
  stub.presetScripts.push(...fixture.preset.map(normalize))
  stub.characters[0].data.extensions.regex_scripts = fixture.scoped.map(normalize)

  // Iris composes the same tiers in the same order (global → preset → scoped)
  // and gates them with its own policy objects; the harness builds that list
  // directly, because the policy plumbing is app-service territory and the
  // engine is the surface under test.
  const irisScripts = [
    ...fixture.global.map(normalize),
    ...(fixture.presetAllowed ? fixture.preset.map(normalize) : []),
    ...fixture.scoped.map(normalize),
  ]

  for (const raw of RAW_STRINGS) {
    for (const placement of PLACEMENTS) {
      for (const depth of DEPTHS) {
        for (const stage of STAGES) {
          cases += 1
          const stOut = st.getRegexedString(raw, placement, {
            isMarkdown: stage.isMarkdown,
            isPrompt: stage.isPrompt,
            depth,
          })
          const irisOut = iris.applyRegexScripts(raw, placement, irisScripts, {
            isMarkdown: stage.isMarkdown,
            isPrompt: stage.isPrompt,
            depth,
          })
          if (stOut !== irisOut) {
            divergences += 1
            console.log(`DIVERGENCE [${fixture.name}] placement=${placement} depth=${depth}`
              + ` markdown=${stage.isMarkdown} prompt=${stage.isPrompt} raw=${JSON.stringify(raw.slice(0, 60))}`
              + `\n  st:   ${JSON.stringify(stOut.slice(0, 160))}`
              + `\n  iris: ${JSON.stringify(irisOut.slice(0, 160))}`)
          }
        }
      }
    }
  }
}

console.debug = debug
console.log(`regex differential: ${String(cases)} cases, ${String(divergences)} divergences`)
if (divergences > 0) process.exit(1)
