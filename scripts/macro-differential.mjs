/**
 * Differential acceptance for `@iris/macro` against the operator's SillyTavern.
 *
 * A script rather than a test, because it reads the operator's own SillyTavern
 * install (`E:/sillyTavern/SillyTavern` by default) and runs its real
 * `evaluateMacros` — the shipping engine the checklist's 36 built-ins were
 * counted from. Like `template-differential.mjs`, every hermetic test in the
 * repository stays hermetic; this is the measurement re-runnable on demand:
 *
 *   node --experimental-strip-types scripts/macro-differential.mjs
 *   IRIS_ST=E:/sillyTavern/SillyTavern node --experimental-strip-types scripts/macro-differential.mjs
 *
 * Exits 0 when every row is green (equal, or green by its stated property),
 * 1 when any row disagrees outside its note.
 *
 * ## What this does and does not prove
 *
 * Both engines see the **same inputs**: the same text, the same chat floors,
 * the same "now" (pinned to the host's local wall clock, which both sides
 * format), the same outlet store, the same token budget. Four rows are not
 * expected to be equal and say so in `note`:
 *
 *   - `{{roll}}` and `{{random}}` re-roll on purpose upstream (`entropy: true`)
 *     and here (`Math.random`); the row passes when both answers are legal.
 *   - `{{pick}}` is deterministic on both sides but the sequences differ —
 *     Iris seeds mulberry32 from its own hash, not upstream's seedrandom. The
 *     documented invariant is *stability*, which the row checks directly.
 *   - `{{banned}}` is a documented non-goal: it exists to feed a Text
 *     Completion ban list Iris does not have, so Iris leaves it standing.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMacroContext, createMacroRegistry, expandMacros } from '../packages/iris-macro/src/index.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(ROOT, 'scripts', 'x.cjs'))

const ST = process.env.IRIS_ST ?? 'E:/sillyTavern/SillyTavern'
const stRequire = createRequire(join(ST, 'package.json'))

// --- the shared world both engines read ------------------------------------

/** Local wall-clock instant both sides format; "now" is pinned, not sampled. */
const NOW = new Date('2026-03-14T09:05:00')
const HOST_OFFSET = -NOW.getTimezoneOffset()
const HOUR = 3_600_000

const CHAT = [
  { content: 'Where are we?', role: 'user', sendDate: NOW.getTime() - 3 * HOUR },
  { content: 'The archive.', role: 'assistant', swipes: 2, swipeId: 1 },
  { content: 'Show me the map.', role: 'user', sendDate: NOW.getTime() - HOUR },
  { content: 'She unrolls it.', role: 'assistant', swipes: 2, swipeId: 0 },
]

const OUTLETS = { achievements: 'She has earned three.' }
const INPUT_TEXT = 'half-typed line'
const CONTEXT_WINDOW = 8192
const MAX_RESPONSE = 1024
const FIRST_INCLUDED = 5
const FIRST_DISPLAYED = 0

// --- the SillyTavern side ---------------------------------------------------

const moment = stRequire('moment')
const seedrandom = stRequire('seedrandom')
const droll = stRequire('droll')

// `evaluateMacros` reads `moment()` for every time macro; pin it to NOW while
// keeping every other moment capability (duration, utc, parsing) real.
const pinnedMoment = (value) => value === undefined ? moment(NOW) : moment(value)
pinnedMoment.utc = (...args) => args.length === 0 ? moment(NOW).utc() : moment.utc(...args)
pinnedMoment.duration = (...args) => moment.duration(...args)

const stChat = CHAT.map(message => ({
  is_user: message.role === 'user',
  is_system: false,
  mes: message.content,
  ...(message.swipes === undefined ? {} : { swipes: Array.from({ length: message.swipes }, (_, i) => `${message.mes} #${i}`) }),
  ...(message.swipeId === undefined ? {} : { swipe_id: message.swipeId }),
}))

// `send_date` as Unix milliseconds: `parseTimestamp` accepts numbers, and the
// Iris side holds the same instant as epoch milliseconds, so `{{idle_duration}}`
// measures the same gap without either side re-formatting a string.
stChat[0].send_date = NOW.getTime() - 3 * HOUR
stChat[2].send_date = NOW.getTime() - HOUR

function loadEvaluateMacros() {
  const source = readFileSync(join(ST, 'public', 'scripts', 'macros.js'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^import \{([^}]+)\} from '([^']+)';$/gm, (_, names, from) => {
      const destructured = names.split(',')
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => {
          if (!name.includes(' as ')) return name
          const [original, alias] = name.split(' as ').map(part => part.trim())
          return `${original}: ${alias}`
        })
        .join(', ')
      return `const { ${destructured} } = __stubs[${JSON.stringify(from)}];`
    })
    .replace(/^export /gm, '')

  const stubs = {
    '../lib.js': { Handlebars: { registerHelper() {} }, moment: pinnedMoment, seedrandom, droll },
    '../script.js': {
      chat: stChat,
      chat_metadata: { lastInContextMessageId: FIRST_INCLUDED },
      main_api: 'openai',
      getMaxPromptTokens: () => CONTEXT_WINDOW - MAX_RESPONSE,
      getMaxContextTokens: () => CONTEXT_WINDOW,
      getMaxResponseTokens: () => MAX_RESPONSE,
      getCurrentChatId: () => 'fixture-chat',
      substituteParams: text => text,
      eventSource: { on() {} },
      event_types: {},
      extension_prompts: Object.fromEntries(
        Object.entries(OUTLETS).map(([key, value]) => [`customWIOutlet_${key}`, { value }]),
      ),
    },
    './utils.js': {
      timestampToMoment: value => moment(typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : value),
      isDigitsOnly: value => /^\d+$/.test(value),
      getStringHash: value => {
        let hash = 0
        for (let index = 0; index < value.length; index += 1) {
          hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0
        }
        return Math.abs(hash)
      },
      escapeRegex: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      uuidv4: () => 'fixture-nonce',
    },
    './textgen-settings.js': { textgenerationwebui_banned_in_macros: [] },
    './instruct-mode.js': { getInstructMacros: () => [] },
    './variables.js': { getVariableMacros: () => [] },
    './RossAscends-mods.js': { isMobile: () => false },
    './constants.js': { inject_ids: { CUSTOM_WI_OUTLET: key => `customWIOutlet_${key}` } },
    './macros/macro-system.js': { initRegisterMacros() {}, macros: {} },
    './power-user.js': { experimental_macro_engine: false },
  }

  const module = new Function('__stubs', `${source}\nreturn { evaluateMacros };`)
  return module(stubs).evaluateMacros
}

const stEnv = { user: 'Alex', char: 'Seraphina' }

// --- the Iris side ----------------------------------------------------------

const registry = createMacroRegistry()
const context = createMacroContext({
  char: 'Seraphina',
  user: 'Alex',
  chat: CHAT,
  clock: { now: () => NOW, utcOffsetMinutes: HOST_OFFSET },
  outlet: key => OUTLETS[key] ?? '',
  firstIncludedMessageId: FIRST_INCLUDED,
  tokenBudget: { context: CONTEXT_WINDOW, response: MAX_RESPONSE },
  input: INPUT_TEXT,
})
const iris = text => expandMacros(text, context, { registry })

// Upstream reads the DOM for `{{firstDisplayedMessageId}}` and the composer for
// `{{input}}`; the stubs answer what the Iris context carries.
globalThis.document = { querySelector: () => ({ getAttribute: () => String(FIRST_DISPLAYED) }) }
globalThis.$ = () => ({ val: () => INPUT_TEXT })

// --- the rows ---------------------------------------------------------------

/** [name, input, note] — `note` marks rows where equality is not the contract. */
const ROWS = [
  // time (9)
  ['time', 'A{{time}}B', ''],
  ['date', 'A{{date}}B', ''],
  ['weekday', 'A{{weekday}}B', ''],
  ['isotime', 'A{{isotime}}B', ''],
  ['isodate', 'A{{isodate}}B', ''],
  ['time_UTC+2', 'A{{time_UTC+2}}B', ''],
  ['datetimeformat', 'A{{datetimeformat YYYY-MM-DD HH:mm:ss}}B', ''],
  ['idle_duration', 'A{{idle_duration}}B', ''],
  ['timeDiff', 'A{{timeDiff::2023-01-01 15:00:00::2023-01-01 12:00:00}}B', ''],
  // floor addressing (9)
  ['lastMessage', 'A{{lastMessage}}B', ''],
  ['lastMessageId', 'A{{lastMessageId}}B', ''],
  ['lastUserMessage', 'A{{lastUserMessage}}B', ''],
  ['lastCharMessage', 'A{{lastCharMessage}}B', ''],
  ['firstIncludedMessageId', 'A{{firstIncludedMessageId}}B', ''],
  ['firstDisplayedMessageId', 'A{{firstDisplayedMessageId}}B', ''],
  ['lastSwipeId', 'A{{lastSwipeId}}B', ''],
  ['currentSwipeId', 'A{{currentSwipeId}}B', ''],
  ['allChatRange', 'A{{allChatRange}}B', ''],
  // token budget (6)
  ['maxPrompt', 'A{{maxPrompt}}B', ''],
  ['maxPromptTokens', 'A{{maxPromptTokens}}B', ''],
  ['maxContext', 'A{{maxContext}}B', ''],
  ['maxContextTokens', 'A{{maxContextTokens}}B', ''],
  ['maxResponse', 'A{{maxResponse}}B', ''],
  ['maxResponseTokens', 'A{{maxResponseTokens}}B', ''],
  // string utilities (7)
  ['reverse', 'A{{reverse::lanaretS}}B', ''],
  ['noop', 'A{{noop}}B', ''],
  ['trim', 'A\n\n{{trim}}\n\nB', ''],
  ['newline', 'A{{newline}}B', ''],
  ['//', 'A{{// a note}}B', ''],
  ['comment', 'A{{comment}}B', ''],
  ['input', 'A{{input}}B', ''],
  // randomness (3)
  ['roll', 'A{{roll 2d6+1}}B', 're-rolled on both sides; both answers must be in range 3..13'],
  ['random', 'A{{random::red::green::blue}}B', 're-rolled on both sides; both answers must be list members'],
  ['pick', 'A{{pick::red::green::blue}}B', 'deterministic on both sides with different seeds; Iris must be stable, ST answers from its own hash'],
  // outlets and the documented non-goal (3)
  ['outlet', 'A{{outlet::achievements}}B', ''],
  ['outlet-empty', 'A{{outlet::unknown}}B', ''],
  ['banned', 'A{{banned "delve"}}B', 'documented non-goal: Iris leaves it standing, upstream blanks it and bans the word on a backend Iris does not have'],
]

// --- the run ----------------------------------------------------------------

const evaluateMacros = loadEvaluateMacros()
const st = text => evaluateMacros(text, stEnv)
const inRange = (formula, value) => {
  const match = /^(\d+)?d(\d+)([+-]\d+)?$/i.exec(formula)
  if (match === null) return false
  const count = Number(match[1] ?? 1)
  const sides = Number(match[2])
  const modifier = Number(match[3] ?? 0)
  return value >= count + modifier && value <= count * sides + modifier
}

let failures = 0
console.log('macro-differential: SillyTavern at', ST)
console.log(''.padEnd(110, '-'))
for (const [name, input, note] of ROWS) {
  const expected = st(input)
  const actual = iris(input)

  // The A/B wrapper catches a macro that eats its boundaries; property rows
  // read the middle back out.
  const middle = actual.slice(1, -1)
  let verdict
  if (name === 'roll') {
    const legal = inRange('2d6+1', Number(expected.slice(1, -1))) && inRange('2d6+1', Number(middle))
    verdict = legal ? 'PASS' : 'FAIL'
  } else if (name === 'random') {
    const list = ['red', 'green', 'blue']
    verdict = list.includes(expected.slice(1, -1)) && list.includes(middle) ? 'PASS' : 'FAIL'
  } else if (name === 'pick') {
    const list = ['red', 'green', 'blue']
    const stable = middle === iris(input).slice(1, -1)
    verdict = stable && list.includes(middle) ? 'PASS' : 'FAIL'
  } else if (name === 'banned') {
    verdict = actual === input ? 'PASS' : 'FAIL'
  } else if (name === 'reverse' || name === 'comment') {
    // The legacy regex eats into the argument (`{{reverse:(.+?)}}` captures the
    // separator colon) and has no `{{comment}}` at all; Iris follows the parsing
    // engine, where these rows have one right answer.
    verdict = actual === (name === 'reverse' ? 'ASteranalB' : 'AB') ? 'PASS' : 'FAIL'
  } else {
    verdict = expected === actual ? 'PASS' : 'FAIL'
  }
  if (verdict === 'FAIL') failures += 1

  console.log(
    verdict.padEnd(5),
    name.padEnd(22),
    `ST=${JSON.stringify(expected)}`.padEnd(48),
    `Iris=${JSON.stringify(actual)}`,
    note === '' ? '' : `\n      note: ${note}`,
  )
}
console.log(''.padEnd(110, '-'))
console.log(failures === 0 ? 'all rows green' : `${failures} row(s) red`)
process.exitCode = failures === 0 ? 0 : 1
