/**
 * Read a profile's `cache-trace/` and rank what is costing it cache hits.
 *
 * This reads what really went out. `cache-prefix-probe.mjs` beside it *replays*
 * an assembly headlessly, which cannot see anything a card script injected at
 * runtime — `ChatEntry.extensionPrompts` is an in-memory `Map` and a headless
 * run has no browser. The traces here were written by the live host at the one
 * seam that sees the composed request, so they include that traffic and every
 * template pass with it. Whatever this reports is the whole request; whatever
 * the probe reports is a floor.
 *
 *   node scripts/cache-divergence-report.mjs
 *   node scripts/cache-divergence-report.mjs <profile dir>
 *   IRIS_REPORT_JSON=1 node scripts/cache-divergence-report.mjs   # machine-readable
 *
 * **Read-only, and it says so in one place**: the only filesystem calls here are
 * `readdir` and `readFile`. It is pointed at the operator's own profile and must
 * never be the reason a trace changed.
 *
 * ## What a pair is
 *
 * Every adjacent pair of traces of one conversation, oldest first — `0`→`1`,
 * `1`→`2`, and so on across whatever the retention window still holds. Adjacent
 * in *sequence*, not in turn: a turn that was swiped three times sent four
 * requests and each one had its own prefix to match, which is exactly where the
 * corpus's largest surprise lives (`爱衣` message 25's four swipes grew the
 * prompt from 12 343 to 20 935 billed tokens).
 *
 * ## The two leaderboards, and why there are two
 *
 * **By cause** groups the unservable bytes by what the part *is* — a card
 * script's injection, a world-info section, a preset segment, a depth bucket, a
 * new floor — which is the table that says what to change.
 *
 * **By part** ranks individual parts, because a single 5 KB block re-sent every
 * turn and fifty 100-byte segments that each changed once are the same total and
 * completely different problems. A report with only the first would present them
 * identically.
 *
 * Both are in bytes. Bytes are the unit the provider's cache is decided in and
 * the only unit two requests can be compared in exactly; the token figures the
 * provider reported are printed beside them, unconverted, because the
 * bytes-per-token ratio of CJK prose is not that of the JSON framing around it
 * and a conversion here would be an invention.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { divergenceOf } from '../packages/iris-app-service/src/cache-trace.ts'
import { HISTORY_ITEM_PREFIX, providerExcuse } from '../packages/iris-protocol/src/views.ts'

const PROFILE = process.argv[2]
  ?? 'D:/workspace/小项目/iris_cordis_traven/apps/iris/data/default-user'

const TRACE_FILE = /^(\d+)\.json$/

/**
 * Which family a part belongs to.
 *
 * The prefixes are the ids the host actually mints, listed here rather than
 * pattern-guessed: `prompt.ts` names world-info contributions
 * `worldInfoBefore` / `worldInfoAfter` / `worldInfo.depth.<depth>.<n>`, a card
 * script's injections come through `placementFor` as `script.*`, floors are
 * `history.<n>`, the tail is `tail`, and everything else is a preset segment —
 * whose id is a UUID for 29 of the 41 prompts in a real preset, which is why
 * "everything else" cannot be recognised by its shape.
 *
 * The depth bucket is split out from world info on purpose. Those two are the
 * same *source* and completely different cache problems: a `worldInfoAfter`
 * section sits in the system slot and can be in a stable prefix, while a depth-0
 * bucket is anchored after the newest floor and cannot be, however unchanged it
 * is. A table that merged them would report the recoverable and the geometric
 * loss as one number.
 * @param id - the part's id.
 * @param kind - the part's kind, for the cases the id does not settle.
 * @returns the family name.
 */
function familyOf(id, kind) {
  if (id === 'tail') return 'tail (nudge / impersonate)'
  if (id.startsWith(HISTORY_ITEM_PREFIX)) return 'history (new or edited floor)'
  if (id.startsWith('script.')) return 'script.* (card injection)'
  if (id.startsWith('worldInfo.depth.')) {
    const depth = id.split('.')[3] ?? '?'
    return `worldInfo depth ${depth}`
  }
  if (id.startsWith('worldInfo')) return 'worldInfo* (system slot)'
  if (kind === 'depth') return 'depth (other)'
  return 'preset segment'
}

/** Percentage with one decimal, or `-` when there is nothing to divide. */
function share(part, whole) {
  if (whole === 0) return '    - '
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`
}

/** Every trace of one conversation, ascending by sequence. */
async function tracesOf(dir) {
  const names = await readdir(dir)
  const seqs = names
    .map(name => TRACE_FILE.exec(name)?.[1])
    .filter(digits => digits !== undefined)
    .map(digits => Number(digits))
    .sort((left, right) => left - right)
  const traces = []
  for (const seq of seqs) {
    try {
      traces.push(JSON.parse(await readFile(join(dir, `${String(seq)}.json`), 'utf8')))
    } catch (error) {
      process.stderr.write(`  ! ${dir}/${String(seq)}.json unreadable: ${String(error)}\n`)
    }
  }
  return traces
}

const traceRoot = join(PROFILE, 'cache-trace')
let chatDirs
try {
  chatDirs = (await readdir(traceRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
} catch {
  process.stderr.write(
    `no cache-trace directory under ${traceRoot}\n`
    + 'Nothing has been recorded yet, or the record is switched off (IRIS_CACHE_TRACE=0).\n',
  )
  process.exit(1)
}

const byFamily = new Map()
const byPart = new Map()
const pairs = []
/** Pairs whose prefix was byte-identical and whose provider still served nothing. */
const providerShortfalls = []
let unattributed = 0

for (const chatId of chatDirs) {
  const traces = await tracesOf(join(traceRoot, chatId))
  if (traces.length < 2) {
    process.stdout.write(`\n=== ${chatId}\n    ${String(traces.length)} trace(s) — no pair to compare\n`)
    continue
  }

  process.stdout.write(`\n=== ${chatId}  (${String(traces.length)} traces)\n`)
  process.stdout.write(
    '    pair          kind                 bytes    diverged  ceiling  provider  first difference in\n',
  )

  for (let index = 1; index < traces.length; index += 1) {
    const previous = traces[index - 1]
    const current = traces[index]
    const row = divergenceOf(previous, current)
    pairs.push({ chatId, ...row })
    if (!row.attributed) unattributed += 1

    const served = row.cacheReadTokens === undefined
      ? '       -'
      : share(row.cacheReadTokens, row.cacheReadTokens + (row.inputTokens ?? 0))
    // A card's own generation between two turns is billed and belongs to no
    // turn, so it is labelled — a reader comparing sequence numbers would
    // otherwise meet a request nobody sent and no page shows.
    const label = current.kind === 'side'
      ? `side (${current.caller ?? 'unknown caller'})`
      : current.kind
    const excuse = providerExcuse(row)
    process.stdout.write(
      `    ${String(row.previousSeq).padStart(4)}->${String(row.seq).padEnd(4)}  `
      + `${label.padEnd(20)} ${String(row.bytes).padStart(7)}  `
      + `${String(row.divergedAt).padStart(8)}  ${share(row.divergedAt, row.bytes)}  ${served}  `
      + `${row.divergedIn === undefined ? '(json framing)' : `${row.divergedIn.id} [${row.divergedIn.kind}]`}`
      + `${excuse === null ? '' : `  [${excuse}]`}`
      + `${row.attributed ? '' : '  ! unattributed'}\n`,
    )
    process.stdout.write(
      `                  unservable ${String(row.uncacheableBytes).padStart(7)} = `
      + `new ${String(row.addedBytes).padStart(6)} + rewritten ${String(row.changedBytes).padStart(6)} + `
      + `unchanged-but-out-of-reach ${String(row.repeatedBytes).padStart(6)} + framing ${String(row.structureBytes).padStart(5)}\n`,
    )

    // A prefix that matched for most of the request and a provider that served
    // nothing is the pair that settles §2.1's open question. Collected rather
    // than only printed, because it is the one row worth naming twice.
    //
    // **The three ordinary reasons are excluded first**, and they are not
    // hypothetical: DeepSeek stores a prefix only after seeing it twice, an
    // entry lives hours to days, and a cache belongs to one model. A list that
    // included those would open with the first two pairs of every conversation
    // and read as a defect in the prompt.
    const ceiling = row.bytes === 0 ? 0 : row.divergedAt / row.bytes
    const actual = row.cacheReadTokens === undefined
      ? undefined
      : row.cacheReadTokens / (row.cacheReadTokens + (row.inputTokens ?? 0))
    if (excuse === null && actual !== undefined && ceiling - actual > 0.2) {
      providerShortfalls.push({ chatId, seq: row.seq, previousSeq: row.previousSeq, ceiling, actual })
    }

    for (const item of row.items) {
      if (item.uncachedBytes === 0) continue
      const family = `${familyOf(item.id, item.kind)}${item.state === 'same' ? ' — unchanged' : ''}`
      byFamily.set(family, (byFamily.get(family) ?? 0) + item.uncachedBytes)
      const key = `${item.id}\u0000${item.state}`
      const held = byPart.get(key) ?? { id: item.id, label: item.label, kind: item.kind, state: item.state, bytes: 0, pairs: 0 }
      held.bytes += item.uncachedBytes
      held.pairs += 1
      byPart.set(key, held)
    }
  }
}

const total = [...byFamily.values()].reduce((sum, value) => sum + value, 0)

process.stdout.write(`\n\n=== by cause, over ${String(pairs.length)} adjacent pair(s)\n`)
process.stdout.write(`    ${'family'.padEnd(38)} ${'bytes'.padStart(9)}  share\n`)
for (const [family, value] of [...byFamily.entries()].sort((left, right) => right[1] - left[1])) {
  process.stdout.write(`    ${family.padEnd(38)} ${String(value).padStart(9)}  ${share(value, total)}\n`)
}
process.stdout.write(`    ${'TOTAL'.padEnd(38)} ${String(total).padStart(9)}\n`)

process.stdout.write('\n=== by part, worst 20\n')
process.stdout.write(`    ${'bytes'.padStart(9)} ${'pairs'.padStart(5)}  ${'state'.padEnd(8)} part\n`)
for (const row of [...byPart.values()].sort((left, right) => right.bytes - left.bytes).slice(0, 20)) {
  process.stdout.write(
    `    ${String(row.bytes).padStart(9)} ${String(row.pairs).padStart(5)}  ${row.state.padEnd(8)} `
    + `${row.label}${row.label === row.id ? '' : ` (${row.id})`} [${row.kind}]\n`,
  )
}

// Printed even when empty, and worded as an absence rather than omitted: a
// reader who does not find this heading cannot tell "no pair fell short" from
// "this report does not check". `notes/packages/iris-app-service/CACHE-PREFIX.md`
// §2.1 asked for
// exactly this judgement and could not make it.
process.stdout.write('\n=== provider served far less than the bytes allowed, with no ordinary reason\n')
process.stdout.write(
  '    Pairs marked [cold-start] (a prefix must be seen twice before it is stored),\n'
  + '    [stale] (>30 min since the previous request) or [route] (a different model) are\n'
  + '    excluded above: each explains a miss on its own, and none of them is a prompt defect.\n',
)
if (providerShortfalls.length === 0) {
  process.stdout.write('    none — every remaining pair was within 20 points of its ceiling\n')
} else {
  for (const row of providerShortfalls) {
    process.stdout.write(
      `    ${row.chatId} ${String(row.previousSeq)}->${String(row.seq)}  `
      + `ceiling ${(row.ceiling * 100).toFixed(1)}%  provider ${(row.actual * 100).toFixed(1)}%\n`,
    )
  }
  process.stdout.write(
    '    A prefix that matched and a cache that was not served is a provider-side fact.\n'
    + '    The two shares are bytes and tokens respectively, so they agree in magnitude, not exactly.\n',
  )
}

if (unattributed > 0) {
  process.stdout.write(
    `\n! ${String(unattributed)} of ${String(pairs.length)} pair(s) could not attribute every byte to a part.\n`
    + '  The offsets and the totals above are still exact; the per-part rows for those pairs are not.\n',
  )
}

if (process.env.IRIS_REPORT_JSON === '1') {
  // The whole comparison, minus the bodies — those are the user's prompts and
  // this output is the thing most likely to be pasted somewhere.
  process.stdout.write(`${JSON.stringify({ pairs, byFamily: [...byFamily], byPart: [...byPart.values()] }, null, 2)}\n`)
}
