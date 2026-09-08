/**
 * Comparing SillyTavern's outgoing request with this host's, for the same card,
 * preset and conversation.
 *
 * "The preset feels less effective here" is a claim about the **request**. If
 * the two hosts send the same bytes then the preset is doing the same thing and
 * the difference lies somewhere else entirely; if they do not, the first place
 * they stop agreeing is the bug. Everything here exists to make that comparison
 * mechanical, in the order a reader can act on it:
 *
 *  1. **Body fields** — `max_tokens`, `temperature`, `top_p`, `seed` and every
 *     other top-level key. A field one side sends and the other omits is the
 *     cheapest possible finding and the easiest to miss by eye.
 *  2. **Message framing** — how many messages, in what roles. This host joins
 *     its system-placed contributions into one system message; upstream sends
 *     one message per prompt unless `squash_system_messages` is on. That is a
 *     framing difference rather than a content difference, and it is reported
 *     separately so it cannot drown the content findings.
 *  3. **Blocks** — each side's system text cut on the blank line that separates
 *     prompts, aligned by content: blocks only upstream sent, blocks only this
 *     host sent, and blocks both sent in a different order.
 *  4. **First byte of divergence** of the whole concatenated text.
 *
 * The functions are pure — two parsed bodies in, a report out — because the
 * thing that must be trustworthy is the comparison, and a comparator that can
 * only be exercised against a live host is a comparator nobody checks.
 * `scripts/preset-parity.mjs` is the shell that reads files and prints.
 *
 * @module @iris/preset/parity
 */

/** One request body, as parsed from JSON. Deliberately loose: it is foreign. */
export type RequestBody = Record<string, unknown>

/** One message of a request, normalised to a role and its text. */
export interface ParityMessage {
  role: string
  text: string
  /** Upstream's `names_behavior: COMPLETION` sets this; this host never does. */
  name?: string
}

/** Body keys that carry the prompt itself rather than a setting. */
const PROMPT_KEYS: ReadonlySet<string> = new Set(['messages', 'prompt'])

/**
 * Keys upstream sends to its **own** server, which never reach a provider.
 *
 * `generate_data` (`openai.js:2742-2767`) is the body of a request to
 * SillyTavern's backend, which then builds the provider call from it. These
 * keys are consumed there — routing, the source id, names for macro use — so
 * this host omitting them is not a divergence, and reporting them as one would
 * put a dozen false findings at the top of every report.
 */
const SERVER_SIDE_KEYS: ReadonlySet<string> = new Set([
  'type', 'chat_completion_source', 'user_name', 'char_name', 'group_names',
  'reverse_proxy', 'proxy_password', 'custom_prompt_post_processing',
  'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
  'bypass_status_check', 'azure_base_url', 'azure_deployment_name',
  'azure_api_version',
])

/** Bytes of a string as UTF-8, which is what the wire counts. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The messages of one body, normalised.
 *
 * A content array (a multimodal message) is flattened to its text parts, since
 * this comparison is about prompt text. The parts that were dropped are
 * **counted** rather than silently discarded: a body carrying an inlined image
 * on one side only is a real difference, and a count is what makes it visible
 * in the framing section instead of vanishing here.
 * @param body - a parsed request body.
 * @returns the messages, and how many non-text parts were dropped.
 */
export function messagesOf(body: RequestBody): { messages: ParityMessage[], dropped: number } {
  const raw = Array.isArray(body['messages']) ? body['messages'] as unknown[] : []
  let dropped = 0
  const messages = raw.map((entry): ParityMessage => {
    const message = (entry ?? {}) as Record<string, unknown>
    const role = String(message['role'] ?? '?')
    const name = typeof message['name'] === 'string' ? { name: message['name'] } : {}
    const content = message['content']
    if (typeof content === 'string') return { role, text: content, ...name }
    if (!Array.isArray(content)) return { role, text: '', ...name }
    const text = (content as unknown[])
      .map((part) => {
        const block = (part ?? {}) as Record<string, unknown>
        if (block['type'] === 'text') return String(block['text'] ?? '')
        dropped += 1
        return undefined
      })
      .filter((value): value is string => value !== undefined)
      .join('')
    return { role, text, ...name }
  })
  return { messages, dropped }
}

/**
 * Merge each run of adjacent system messages into one, joined by a blank line.
 *
 * The one normalisation applied to text, and only on request: it is how this
 * host frames the same content, so applying it to the upstream side too lets
 * layers 3 and 4 compare prompts rather than re-report the framing difference
 * layer 2 has already named.
 *
 * The separator is the blank line, which is what `assemble.ts` joins system
 * sections with — not upstream's squash separator, which is a single newline
 * (`DEVIATIONS.md` §41). Merging is a *reading* device here, not a claim about
 * either host's wire format.
 * @param messages - normalised messages.
 * @returns messages with adjacent system runs merged.
 */
export function mergeSystemRuns(messages: readonly ParityMessage[]): ParityMessage[] {
  const merged: ParityMessage[] = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.role === 'system' && message.role === 'system') {
      previous.text = `${previous.text}\n\n${message.text}`
      continue
    }
    merged.push({ ...message })
  }
  return merged
}

/**
 * Cut one message's text into the blocks a preset's prompts became.
 *
 * The separator is the blank line this host joins system contributions with
 * (`@iris/pipeline`'s `assemble.ts`, `sections.join('\n\n')`), so the cut can
 * only ever be **finer** than a prompt boundary — a prompt whose own text
 * contains a blank line splits into two blocks on both sides equally, which
 * costs a reader nothing and never moves a byte across a boundary.
 * @param text - the message text.
 * @returns the blocks, blank ones dropped.
 */
export function blocksOf(text: string): string[] {
  return text.split('\n\n').map(block => block.trim()).filter(block => block.length > 0)
}

/** One block matched on both sides, with its position in each. */
export interface MatchedBlock { left: number, right: number, block: string }

/** One block only one side sent. */
export interface LoneBlock { index: number, block: string }

/** The block alignment of one comparison. */
export interface BlockAlignment {
  matched: MatchedBlock[]
  onlyLeft: LoneBlock[]
  onlyRight: LoneBlock[]
  /** The smallest set of matched blocks whose move explains the reordering. */
  moved: MatchedBlock[]
}

/**
 * The blocks that actually moved: everything outside a longest increasing
 * subsequence of the right-hand positions.
 *
 * The naive reading — "report every block that sits before a block with a
 * smaller index" — names the wrong elements. For `a,b,c` against `c,a,b` it
 * reports *a* and *b* as moved because both now sit after `c`, when the honest
 * description is that **c** moved to the front. The complement of a longest
 * increasing subsequence is the minimum set of blocks whose relocation produces
 * the observed order, which is the same thing a reader means by "what moved".
 *
 * O(n²) on purpose: a real preset contributes tens of blocks, and the
 * quadratic form is the one whose correctness can be read off the loop.
 * @param matched - matched pairs in left-hand order.
 * @returns the matched pairs not on a longest increasing run.
 */
function movedBlocks(matched: readonly MatchedBlock[]): MatchedBlock[] {
  if (matched.length === 0) return []
  // `best[i]` is the length of the longest increasing run ending at i, and
  // `from[i]` its predecessor, so the run itself can be walked back out.
  const best = matched.map(() => 1)
  const from = matched.map(() => -1)
  let endsAt = 0
  for (let i = 0; i < matched.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const here = matched[i]
      const there = matched[j]
      if (here === undefined || there === undefined) continue
      if (there.right < here.right && (best[j] ?? 0) + 1 > (best[i] ?? 0)) {
        best[i] = (best[j] ?? 0) + 1
        from[i] = j
      }
    }
    if ((best[i] ?? 0) > (best[endsAt] ?? 0)) endsAt = i
  }
  const onRun = new Set<number>()
  for (let at = endsAt; at >= 0; at = from[at] ?? -1) onRun.add(at)
  return matched.filter((_, index) => !onRun.has(index))
}

/**
 * Align two block lists by content, reporting what only one side has.
 *
 * Matching is by exact text, first-come: a block present on both sides at
 * different positions is **moved**, not "missing and added". That distinction
 * is the whole point — a moved block is an ordering bug, a missing one is a
 * field this host does not read, and the two have different fixes.
 *
 * "Out of order" is the minimum set of blocks whose move explains the order
 * (see {@link movedBlocks}), not an index distance: inserting one block at the
 * top shifts every later index by one without moving anything relative to
 * anything else, and a report that called that fifty moves would be useless.
 * @param left - upstream's blocks.
 * @param right - this host's blocks.
 * @returns the alignment.
 */
export function alignBlocks(left: readonly string[], right: readonly string[]): BlockAlignment {
  const seats = new Map<string, number[]>()
  right.forEach((block, index) => {
    const list = seats.get(block)
    if (list === undefined) seats.set(block, [index])
    else list.push(index)
  })

  const matched: MatchedBlock[] = []
  const onlyLeft: LoneBlock[] = []
  const taken = new Set<number>()
  left.forEach((block, index) => {
    const list = seats.get(block)
    const seat = list?.shift()
    if (seat === undefined) {
      onlyLeft.push({ index, block })
      return
    }
    taken.add(seat)
    matched.push({ left: index, right: seat, block })
  })
  const onlyRight: LoneBlock[] = right
    .map((block, index) => ({ index, block }))
    .filter(entry => !taken.has(entry.index))

  return { matched, onlyLeft, onlyRight, moved: movedBlocks(matched) }
}

/** Where two texts stop agreeing. */
export interface Divergence {
  charOffset: number
  byteOffset: number
}

/**
 * The first position at which two strings stop agreeing.
 * @param left - one text.
 * @param right - the other.
 * @returns the offset, or `undefined` when the two are identical.
 */
export function firstDivergence(left: string, right: string): Divergence | undefined {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  if (index === left.length && index === right.length) return undefined
  return { charOffset: index, byteOffset: byteLength(left.slice(0, index)) }
}

/** One top-level field, compared. */
export interface FieldRow {
  key: string
  verdict: 'same' | 'differs' | 'st-only' | 'st-only (server-side)' | 'iris-only'
  st: string | undefined
  iris: string | undefined
}

/**
 * Compare the top-level fields of two bodies.
 * @param st - upstream's body.
 * @param iris - this host's body.
 * @returns one row per key, sorted by key.
 */
export function compareFields(st: RequestBody, iris: RequestBody): FieldRow[] {
  const keys = [...new Set([...Object.keys(st), ...Object.keys(iris)])]
    .filter(key => !PROMPT_KEYS.has(key))
    .sort()
  return keys.map((key): FieldRow => {
    const inSt = Object.hasOwn(st, key)
    const inIris = Object.hasOwn(iris, key)
    const left = JSON.stringify(st[key])
    const right = JSON.stringify(iris[key])
    const verdict: FieldRow['verdict'] = !inIris
      ? (SERVER_SIDE_KEYS.has(key) ? 'st-only (server-side)' : 'st-only')
      : !inSt
        ? 'iris-only'
        : left === right ? 'same' : 'differs'
    return { key, verdict, st: left, iris: right }
  })
}

/** How the two requests are framed as messages. */
export interface Framing {
  stCount: number
  irisCount: number
  stRoles: string[]
  irisRoles: string[]
  stNonText: number
  irisNonText: number
  stNamed: number
  irisNamed: number
}

/** The whole comparison, as data. */
export interface ParityReport {
  mergeSystem: boolean
  fields: FieldRow[]
  framing: Framing
  blocks: BlockAlignment
  sizes: { st: number, iris: number }
  divergence?: Divergence & { stContext: string, irisContext: string }
}

/** How to compare. */
export interface ParityOptions {
  /** Merge each side's adjacent system runs before layers 3 and 4. Default true. */
  mergeSystem?: boolean
}

/** Characters of context shown on either side of the first divergence. */
const CONTEXT_CHARS = 60

/**
 * Compare two request bodies.
 * @param st - upstream's body.
 * @param iris - this host's body.
 * @param options - comparison options.
 * @returns the structured report.
 */
export function compareBodies(
  st: RequestBody,
  iris: RequestBody,
  options: ParityOptions = {},
): ParityReport {
  const mergeSystem = options.mergeSystem ?? true
  const stSide = messagesOf(st)
  const irisSide = messagesOf(iris)

  const framing: Framing = {
    stCount: stSide.messages.length,
    irisCount: irisSide.messages.length,
    stRoles: stSide.messages.map(message => message.role),
    irisRoles: irisSide.messages.map(message => message.role),
    stNonText: stSide.dropped,
    irisNonText: irisSide.dropped,
    stNamed: stSide.messages.filter(message => message.name !== undefined).length,
    irisNamed: irisSide.messages.filter(message => message.name !== undefined).length,
  }

  const stMessages = mergeSystem ? mergeSystemRuns(stSide.messages) : stSide.messages
  const irisMessages = mergeSystem ? mergeSystemRuns(irisSide.messages) : irisSide.messages

  const systemText = (messages: readonly ParityMessage[]): string => messages
    .filter(message => message.role === 'system')
    .map(message => message.text)
    .join('\n\n')
  const blocks = alignBlocks(blocksOf(systemText(stMessages)), blocksOf(systemText(irisMessages)))

  // Roles are stamped into the compared text so a divergence that is only a
  // role change still shows as a divergence: two requests whose text agrees but
  // whose roles do not are not the same request.
  const flatten = (messages: readonly ParityMessage[]): string => messages
    .map(message => `<${message.role}>${message.text}`)
    .join('\n')
  const stText = flatten(stMessages)
  const irisText = flatten(irisMessages)
  const divergence = firstDivergence(stText, irisText)

  return {
    mergeSystem,
    fields: compareFields(st, iris),
    framing,
    blocks,
    sizes: { st: byteLength(stText), iris: byteLength(irisText) },
    ...divergence === undefined ? {} : {
      divergence: {
        ...divergence,
        stContext: stText.slice(Math.max(0, divergence.charOffset - CONTEXT_CHARS), divergence.charOffset + CONTEXT_CHARS),
        irisContext: irisText.slice(Math.max(0, divergence.charOffset - CONTEXT_CHARS), divergence.charOffset + CONTEXT_CHARS),
      },
    },
  }
}

/**
 * One line of a possibly multi-line block, for a table.
 * @param text - the block.
 * @returns at most 100 characters, newlines shown as `⏎`.
 */
function oneLine(text: string): string {
  const flat = text.replace(/\r?\n/g, '⏎')
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
}

/**
 * Render one report for a human.
 *
 * The four sections come out in the order a reader should act on them, and each
 * one states its own totals first: a report that opened with fifty "moved"
 * lines would hide the one missing field that actually explains the complaint.
 * @param report - the output of {@link compareBodies}.
 * @returns the text to print.
 */
export function renderReport(report: ParityReport): string {
  const lines: string[] = []
  const say = (line: string): void => { lines.push(line) }

  say('=== 1. body fields ===')
  const interesting = report.fields.filter(row => row.verdict !== 'same')
  say(`${String(report.fields.length)} keys compared, ${String(report.fields.length - interesting.length)} identical`)
  for (const row of interesting) {
    say(`  ${row.verdict.padEnd(22)} ${row.key}`)
    if (row.verdict === 'differs') {
      say(`      ST   ${String(row.st).slice(0, 140)}`)
      say(`      Iris ${String(row.iris).slice(0, 140)}`)
    } else if (row.verdict.startsWith('st-only')) say(`      ST   ${String(row.st).slice(0, 140)}`)
    else say(`      Iris ${String(row.iris).slice(0, 140)}`)
  }
  if (interesting.length === 0) say('  (every top-level field agrees)')

  say('')
  say('=== 2. message framing ===')
  say(`  messages   ST ${String(report.framing.stCount)}   Iris ${String(report.framing.irisCount)}`)
  say(`  roles ST   ${report.framing.stRoles.join(',')}`)
  say(`  roles Iris ${report.framing.irisRoles.join(',')}`)
  if (report.framing.stNamed > 0 || report.framing.irisNamed > 0) {
    say(`  messages carrying a "name" field: ST ${String(report.framing.stNamed)},`
      + ` Iris ${String(report.framing.irisNamed)}  (upstream's names_behavior = COMPLETION)`)
  }
  if (report.framing.stNonText > 0 || report.framing.irisNonText > 0) {
    say(`  non-text content parts ignored: ST ${String(report.framing.stNonText)},`
      + ` Iris ${String(report.framing.irisNonText)}`)
  }
  if (report.mergeSystem) {
    say('  (system runs merged on both sides for sections 3 and 4'
      + ' — pass --no-merge-system to compare as sent)')
  }

  say('')
  say('=== 3. system blocks ===')
  say(`  matched ${String(report.blocks.matched.length)}`
    + `   only in ST ${String(report.blocks.onlyLeft.length)}`
    + `   only in Iris ${String(report.blocks.onlyRight.length)}`
    + `   out of order ${String(report.blocks.moved.length)}`)
  for (const entry of report.blocks.onlyLeft) {
    say(`  ST-only   [${String(entry.index)}] ${String(byteLength(entry.block))}B  ${oneLine(entry.block)}`)
  }
  for (const entry of report.blocks.onlyRight) {
    say(`  Iris-only [${String(entry.index)}] ${String(byteLength(entry.block))}B  ${oneLine(entry.block)}`)
  }
  for (const entry of report.blocks.moved) {
    say(`  moved     ST position ${String(entry.left)} → Iris position ${String(entry.right)}`
      + `  ${oneLine(entry.block)}`)
  }

  say('')
  say('=== 4. first byte of divergence ===')
  say(`  total text  ST ${String(report.sizes.st)}B   Iris ${String(report.sizes.iris)}B`)
  if (report.divergence === undefined) {
    say('  none — the two requests carry byte-identical prompt text')
  } else {
    say(`  diverges at byte ${String(report.divergence.byteOffset)}`
      + ` (char ${String(report.divergence.charOffset)})`)
    say(`  ST   …${oneLine(report.divergence.stContext)}…`)
    say(`  Iris …${oneLine(report.divergence.irisContext)}…`)
  }
  return lines.join('\n')
}
