/**
 * What actually went out, kept on disk, so a cache miss can be attributed.
 *
 * `fingerprint.ts` records two hashes per generation and settles one question:
 * did the prompt change. It cannot answer the next one — *where*, and whose text
 * that was — because a hash is not a diff, and by the time anyone asks, the
 * request is gone. `CACHE-PREFIX.md` §5.3 names exactly this gap: "真实请求不留
 * 任何可回查的痕迹", and it is why three turns of the user's own corpus reported
 * `cacheReadTokens: 0` on 2026-09-07 and still have no explanation.
 *
 * So each real generation writes the canonical body it sent, plus a map from
 * byte offsets in that body back to the assembly parts that produced them, into
 * the profile's own `cache-trace/<chatId>/<seq>.json`. Two adjacent files then
 * answer the whole question arithmetically: the first differing byte, whose text
 * that byte belongs to, and how the unservable remainder splits between text
 * that is new and text that is merely in the wrong place.
 *
 * **This writes the user's prompts to the user's own disk.** Three rules follow,
 * and each is load-bearing rather than decorative:
 *
 * 1. **Bounded.** Only the newest {@link CacheTraceOptions.keep} files per
 *    conversation survive; the rest are deleted on every write. A prompt is tens
 *    of kilobytes and a long session is hundreds of turns, so an unbounded
 *    record would quietly become the largest thing in the profile.
 * 2. **Its own subtree, and nothing else's.** Every path is built from
 *    {@link fileFor}, so a chat id off the wire cannot name a file outside
 *    `cache-trace/`. The store never deletes anything it did not write: rotation
 *    only removes files whose names it can parse as its own.
 * 3. **Atomically, or not at all.** Written to a sibling temporary and renamed
 *    over the target, through `atomic.ts`'s `atomicWriteFile` — which is where
 *    this pattern lives now, and no longer in `worldbooks.ts`: the two
 *    hand-rolled copies (this one and that one) became one helper when every
 *    other write in the package was brought onto it. A half-written trace is
 *    worse than no trace: it reads as a request that diverged from itself.
 *
 * And one rule about failure: **a trace must never cost a generation.** Every
 * write is wrapped, and a failure is reported and dropped. The record exists to
 * explain a cost, and an instrument that can break the thing it measures is not
 * one.
 *
 * @module @iris/app-service/cache-trace
 */

import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicWriteFile } from './atomic.ts'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SYSTEM_JOIN, type Role } from '@iris/pipeline'
import { HISTORY_ITEM_PREFIX, type PromptDivergence, type PromptDivergenceItem } from '@iris/protocol'

import { canonicalBody, fingerprintBody, type BodySlot } from './fingerprint.ts'
import { fileFor } from './paths.ts'

/** How many traces one conversation keeps when nothing says otherwise. */
export const DEFAULT_CACHE_TRACE_KEEP = 8

/** The current on-disk shape. A reader refuses anything else by number. */
export const CACHE_TRACE_VERSION = 1

/**
 * The kind of assembly part a byte range belongs to.
 *
 * `tail` is this host's own closing message — a continue's nudge, an
 * impersonation's instruction — which is not a contribution and has no id in the
 * itemization. It gets a kind of its own rather than being filed under `depth`,
 * because "the nudge moved" and "an injection moved" have different fixes.
 */
export type TraceSpanKind = 'system' | 'depth' | 'history' | 'tail'

/** The id the tail carries, since it is not a contribution. */
export const TAIL_SPAN_ID = 'tail'

/** One assembly part and the bytes of the body it occupies. */
export interface TraceSpan {
  id: string
  label?: string
  kind: TraceSpanKind
  /** The role the assembly gave it, when that is not `system`. */
  role?: Role
  /** First byte of its escaped text in the body, inclusive. */
  start: number
  /** One past the last, exclusive. */
  end: number
}

/** One recorded request, as the file holds it. */
export interface CacheTraceFile {
  version: number
  chatId: string
  /** Monotonic per conversation; the file's own name. */
  seq: number
  /** When the request went out; Unix epoch milliseconds. */
  at: number
  /**
   * `send`, `regenerate`, `continue`, `impersonate`, or `side`.
   *
   * `side` is a generation a **card** asked for, which is not a turn: nothing is
   * appended to the log and no candidate is written. It is recorded anyway
   * because it is billed anyway, it goes to the same provider on the same route,
   * and it sits *between* two turns' traces — so a reader comparing adjacent
   * sequence numbers would otherwise meet a request nobody sent and no page
   * shows. See {@link caller}.
   */
  kind: string
  /**
   * Which entry point composed a `side` request.
   *
   * The RPC method, not the script's name: **`script.generate` and
   * `script.generateRaw` carry no script id on the wire**
   * (`packages/iris-protocol/src/rpc.ts`, the `script.generate` schema is
   * `chatId` / `userInput` / `systemPrompt` / `maxHistory`), so the name of the
   * script that asked is not information this host has at the moment it composes
   * the body. Recorded as the method rather than left blank, and named as the
   * method rather than as a script, so nobody reads it as an attribution it is
   * not.
   */
  caller?: string
  /** The turn it belongs to, or `-1` for a generation that is not a turn. */
  turn: number
  promptHash: string
  prefixHash: string
  provider: string
  model: string
  /** `Buffer.byteLength(body)`. Stored so a reader need not recompute it. */
  bytes: number
  /** What the provider charged in full, once it said. */
  inputTokens?: number
  /** What it served from cache, once it said. */
  cacheReadTokens?: number
  /**
   * Present when the reply did not complete: what surfaced in the report panel,
   * verbatim. A trace that ends this way has no usage fields — not zero, just
   * absent — because the provider never reported usage for a reply it never
   * finished; zero would be a measurement of nothing, and a reader comparing
   * turns could mistake an interrupted turn for a free one.
   */
  error?: string
  /** Every attributed range, in body order. */
  spans: TraceSpan[]
  /** Sum of the spans' lengths, so a reader can see how much was attributed. */
  coveredBytes: number
  /** False when a slot could not be attributed with certainty. */
  attributed: boolean
  /** Present when {@link attributed} is false: the first thing that did not map. */
  attributionNote?: string
  /** The bytes themselves — the point of the file. */
  body: string
}

/** Byte length of one string as it appears escaped inside a JSON string. */
function escapedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text).slice(1, -1), 'utf8')
}

/** What {@link spansOf} produces beside the spans. */
interface Attribution {
  spans: TraceSpan[]
  attributed: boolean
  note?: string
}

/**
 * Which assembly part owns each byte of the body.
 *
 * Built from the layout the driver recorded rather than by searching the body,
 * because searching is a different answer wearing this one's clothes: two
 * contributions carrying the same line — routine, since the MVU boilerplate is
 * copied verbatim between world books — would both match the first occurrence.
 *
 * A slot with one part takes the whole slot whatever its text now says, so a
 * template that rewrote the text still attributes to the right item. A slot with
 * several (a squashed system run) is subdivided by laying the parts end to end,
 * and the subdivision is *checked* against the slot: when it does not
 * reconstruct, the slot is attributed whole to its first part and the whole
 * trace is marked unattributed, because a confident wrong offset is the one
 * output this instrument must not produce.
 *
 * **The separators between segments belong to no part**, and that is a decision
 * rather than an oversight: the blank line `renderSystem` puts between two
 * sections is the cost of there being two sections, not text either one wrote.
 * Those bytes therefore land in `structureBytes` alongside the JSON framing —
 * four bytes per seam — so the spans do not quite cover the body's text, and the
 * shortfall is exactly that. Attributing them to the following segment would
 * make a section's reported size disagree with its own text.
 * @param canonical - the body and its text slots.
 * @param layout - which part produced which slot, from the driver.
 * @returns the spans, and whether every one of them is certain.
 */
export function spansOf(
  canonical: { slots: readonly BodySlot[] },
  layout: GenerateOptions['layout'],
): Attribution {
  const spans: TraceSpan[] = []
  let attributed = true
  let note: string | undefined

  /** Record the first thing that did not map, and only the first. */
  const doubt = (reason: string): void => {
    attributed = false
    note ??= reason
  }

  /**
   * Lay parts end to end inside one slot.
   *
   * `verify` is the difference between the two kinds of slot, and it is the
   * whole subtlety here.
   *
   * A **message** slot with one part is attributed whole without checking,
   * because there is exactly one candidate and it is right whatever the text now
   * says — a template that rewrote the message, or a continue's separator
   * appended after the layout was taken, changes the length and not the answer.
   *
   * A **system** slot is always checked, even when it has one segment, because
   * the layout is supposed to *describe the whole slot*: the assembler renders
   * that string from those segments and nothing else. A layout that lists one
   * segment for a two-segment system prompt would otherwise attribute the entire
   * head of the request to its first section and call the answer certain, which
   * is the one output this instrument must not produce.
   * @param slot - the slot to fill.
   * @param parts - its parts, in order.
   * @param join - what the slot's own renderer put between them.
   * @param kind - the kind to give every resulting span.
   * @param verify - whether the parts must reconstruct the slot.
   * @param role - the assembled role, when it is worth recording.
   */
  const subdivide = (
    slot: BodySlot,
    parts: readonly { id: string, label?: string, text: string }[],
    join: string,
    kind: TraceSpanKind,
    verify: boolean,
    role?: Role,
  ): void => {
    const first = parts[0]
    if (first === undefined) return
    const whole = (): void => {
      spans.push({
        id: first.id,
        ...first.label === undefined ? {} : { label: first.label },
        kind,
        ...role === undefined || role === 'system' ? {} : { role },
        start: slot.start,
        end: slot.end,
      })
    }
    if (!verify && parts.length === 1) {
      whole()
      return
    }
    if (parts.map(part => part.text).join(join) !== slot.text) {
      doubt(`slot ${String(slot.message)} does not reconstruct from its ${String(parts.length)} recorded parts`)
      whole()
      return
    }
    let cursor = slot.start
    const joinBytes = escapedBytes(join)
    parts.forEach((part, index) => {
      if (index > 0) cursor += joinBytes
      const length = escapedBytes(part.text)
      spans.push({
        id: part.id,
        ...part.label === undefined ? {} : { label: part.label },
        kind,
        ...role === undefined || role === 'system' ? {} : { role },
        start: cursor,
        end: cursor + length,
      })
      cursor += length
    })
    // Escaping one character never depends on its neighbours, so the parts'
    // escaped lengths must sum to the slot's — except across a surrogate pair
    // split between two parts, which cannot happen for whole strings and is
    // checked anyway rather than assumed.
    if (cursor !== slot.end) {
      doubt(`slot ${String(slot.message)} subdivided to ${String(cursor)}, not ${String(slot.end)}`)
    }
  }

  if (layout === undefined) {
    return {
      spans,
      attributed: false,
      note: 'the request carried no layout, so no byte can be attributed to a part',
    }
  }

  for (const slot of canonical.slots) {
    if (slot.message === -1) {
      // A body with a system slot and a layout with no segments is the one
      // shape that would slip through `subdivide` quietly: it has nothing to
      // lay down, so it lays nothing down, and the largest section of the
      // request goes unattributed while the trace still calls itself certain.
      if (layout.system.length === 0) doubt('the body carries a system slot the layout does not describe')
      subdivide(slot, layout.system, SYSTEM_JOIN, 'system', true)
      continue
    }
    const recorded = layout.messages[slot.message]
    if (recorded === undefined) {
      doubt(`the layout describes ${String(layout.messages.length)} messages and the body has more`)
      continue
    }
    if (recorded.tail === true) {
      spans.push({
        id: TAIL_SPAN_ID,
        kind: 'tail',
        ...recorded.role === 'system' ? {} : { role: recorded.role },
        start: slot.start,
        end: slot.end,
      })
      continue
    }
    const kind = recorded.parts[0]?.id.startsWith(HISTORY_ITEM_PREFIX) === true ? 'history' : 'depth'
    if (recorded.parts.length === 0) {
      doubt(`message ${String(slot.message)} has no recorded part`)
      continue
    }
    // A squashed system run joins with **one newline** — upstream's
    // `squash_system_messages` (`openai.js:3846`,
    // `lastMessage.content += '\n' + message.content`), transcribed in the
    // driver's `squashSystemRuns`. Written out here rather than imported for the
    // same reason it is written out there: it is not `SYSTEM_JOIN`, and the two
    // are decided by two independent upstream lines. The cost of writing it out
    // is that a change to the driver's separator has to be made here too, and
    // the failure is visible rather than silent — the parts stop reconstructing
    // their slot and the trace marks itself unattributed instead of reporting
    // wrong offsets.
    subdivide(slot, recorded.parts, '\n', kind, false, recorded.role)
  }

  if (layout.messages.length > canonical.slots.filter(slot => slot.message >= 0).length) {
    doubt(`the layout describes ${String(layout.messages.length)} messages and the body has fewer`)
  }

  return { spans, attributed, ...note === undefined ? {} : { note } }
}

/** Everything a trace needs that the request does not carry. */
export interface TraceTarget {
  chatId: string
  kind: string
  /** Which entry point composed a `side` request; see {@link CacheTraceFile.caller}. */
  caller?: string
  /** `-1` for a generation that is not a turn. */
  turn: number
}

/**
 * Build one trace from the request that is about to go out.
 *
 * `inputTokens` and `cacheReadTokens` are filled in by the caller once the
 * provider has said, which is after the body exists — so they are separate
 * arguments rather than read off anything here.
 * @param options - the request as the provider is about to receive it.
 * @param target - the conversation, the kind, and the turn.
 * @param at - the moment the request went out.
 * @param usage - what the provider charged, when it has said.
 * @returns the trace, with `seq` left for the store to assign.
 */
export function traceOf(
  options: GenerateOptions,
  target: TraceTarget,
  at: number,
  usage?: { inputTokens?: number, cacheReadTokens?: number },
  error?: string,
): Omit<CacheTraceFile, 'seq'> {
  const canonical = canonicalBody(options)
  const fingerprint = fingerprintBody(canonical.body)
  const attribution = spansOf(canonical, options.layout)
  return {
    version: CACHE_TRACE_VERSION,
    chatId: target.chatId,
    at,
    kind: target.kind,
    ...target.caller === undefined ? {} : { caller: target.caller },
    turn: target.turn,
    promptHash: fingerprint.promptHash,
    prefixHash: fingerprint.prefixHash,
    provider: options.provider,
    model: options.model,
    bytes: canonical.bytes,
    ...usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens },
    ...usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...error === undefined ? {} : { error },
    spans: attribution.spans,
    coveredBytes: attribution.spans.reduce((total, span) => total + (span.end - span.start), 0),
    attributed: attribution.attributed,
    ...attribution.note === undefined ? {} : { attributionNote: attribution.note },
    body: canonical.body,
  }
}

/** The first byte at which two buffers differ, or the shorter length. */
function firstDifference(left: Buffer, right: Buffer): number {
  const shortest = Math.min(left.length, right.length)
  for (let index = 0; index < shortest; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return shortest
}

/** Index one trace's spans by id, first occurrence winning. */
function byId(spans: readonly TraceSpan[]): Map<string, TraceSpan> {
  const index = new Map<string, TraceSpan>()
  for (const span of spans) if (!index.has(span.id)) index.set(span.id, span)
  return index
}

/**
 * Compare two recorded requests of one conversation.
 *
 * The whole measurement is over the two bodies' bytes, which is the unit the
 * provider's cache is decided in. Nothing is re-assembled and nothing is
 * estimated: if the two files disagree, the requests disagreed.
 * @param previous - the older request.
 * @param current - the newer one.
 * @returns the comparison, in bytes.
 */
export function divergenceOf(previous: CacheTraceFile, current: CacheTraceFile): PromptDivergence {
  const before = Buffer.from(previous.body, 'utf8')
  const after = Buffer.from(current.body, 'utf8')
  const divergedAt = firstDifference(before, after)

  const wasById = byId(previous.spans)
  const nowById = byId(current.spans)

  let addedBytes = 0
  let changedBytes = 0
  let repeatedBytes = 0

  const items: PromptDivergenceItem[] = current.spans.map((span) => {
    const bytes = span.end - span.start
    const was = wasById.get(span.id)
    const state = was === undefined
      ? 'added' as const
      // The escaped slices, compared as bytes. Escaping is injective, so equal
      // escaped bytes means equal text — and comparing the escaped form avoids
      // parsing 90 KB of JSON to answer a yes/no question.
      : after.subarray(span.start, span.end).equals(before.subarray(was.start, was.end))
        ? 'same' as const
        : 'changed' as const
    // Only the part of this span that falls after the divergence is unservable.
    // A span the divergence lands inside is partly cached, and counting it whole
    // would overstate every loss by up to one item's length.
    const uncached = Math.max(0, span.end - Math.max(span.start, divergedAt))
    if (state === 'added') addedBytes += uncached
    else if (state === 'changed') changedBytes += uncached
    else repeatedBytes += uncached
    return {
      id: span.id,
      label: span.label ?? span.id,
      kind: span.kind,
      ...span.role === undefined ? {} : { role: span.role },
      state,
      bytes,
      previousBytes: was === undefined ? 0 : was.end - was.start,
      uncachedBytes: uncached,
    }
  })

  // The parts that were in the older request and are not in this one. They cost
  // nothing now, and they are listed because "my world-info block stopped
  // appearing" is a question the same panel is opened to answer — and because a
  // part that vanished is usually the reason a neighbouring one moved.
  for (const span of previous.spans) {
    if (nowById.has(span.id)) continue
    items.push({
      id: span.id,
      label: span.label ?? span.id,
      kind: span.kind,
      ...span.role === undefined ? {} : { role: span.role },
      state: 'gone',
      bytes: 0,
      previousBytes: span.end - span.start,
      uncachedBytes: 0,
    })
  }

  const uncacheableBytes = current.bytes - divergedAt
  const divergedIn = current.spans.find(span => span.start <= divergedAt && divergedAt < span.end)

  return {
    chatId: current.chatId,
    seq: current.seq,
    previousSeq: previous.seq,
    at: current.at,
    previousAt: previous.at,
    kind: current.kind,
    previousKind: previous.kind,
    model: current.model,
    previousModel: previous.model,
    provider: current.provider,
    previousProvider: previous.provider,
    bytes: current.bytes,
    previousBytes: previous.bytes,
    divergedAt,
    ...divergedIn === undefined
      ? {}
      : { divergedIn: { id: divergedIn.id, label: divergedIn.label ?? divergedIn.id, kind: divergedIn.kind } },
    uncacheableBytes,
    addedBytes,
    changedBytes,
    repeatedBytes,
    // The remainder by construction, so the four terms add up exactly. It is
    // the JSON framing and the role names, which belong to no part — plus, when
    // `attributed` is false, whatever could not be mapped.
    structureBytes: uncacheableBytes - addedBytes - changedBytes - repeatedBytes,
    items,
    ...current.inputTokens === undefined ? {} : { inputTokens: current.inputTokens },
    ...current.cacheReadTokens === undefined ? {} : { cacheReadTokens: current.cacheReadTokens },
    ...current.error === undefined ? {} : { error: current.error },
    // Either side being uncertain makes the comparison uncertain: the items are
    // aligned by id across both.
    attributed: previous.attributed && current.attributed,
    ...previous.attributed && current.attributed
      ? {}
      : { attributionNote: current.attributionNote ?? previous.attributionNote ?? 'one of the two requests was not attributed' },
  }
}

/** What the store needs to know. */
export interface CacheTraceOptions {
  /**
   * How many traces to keep per conversation. `0` turns the record off
   * entirely — nothing is written and nothing is read.
   */
  keep: number
  /** Told when a write or a rotation fails; the generation carries on regardless. */
  onError?: (error: Error) => void
}

/** A trace file's name, and nothing else's. */
const TRACE_FILE = /^(\d+)\.json$/

/**
 * The profile's `cache-trace/` directory, one subdirectory per conversation.
 *
 * Sequence numbers are assigned from an in-memory counter seeded by one
 * directory read, rather than by re-reading before every write: two generations
 * of one conversation cannot overlap (the host refuses a second while one is
 * pending), but a *card's* side generation can land beside a turn, and a counter
 * makes that a distinct file rather than a race for one name.
 */
export class CacheTraceStore {
  readonly #dir: string
  readonly #options: CacheTraceOptions
  readonly #next = new Map<string, number>()

  /**
   * @param dir - the profile's `cache-trace` directory. It need not exist.
   * @param options - how many to keep, and where failures go.
   */
  constructor(dir: string, options: CacheTraceOptions) {
    this.#dir = dir
    this.#options = options
  }

  /** Whether anything is being recorded at all. */
  get enabled(): boolean {
    return this.#options.keep > 0
  }

  /**
   * One conversation's directory, guarded.
   *
   * Through {@link fileFor} with an empty extension, so a chat id that reached
   * this process from a browser is put through the same whitelist and the same
   * containment check a chat file's name is.
   * @param chatId - the conversation.
   * @returns the absolute directory path.
   */
  #chatDir(chatId: string): string {
    return fileFor(this.#dir, chatId, '')
  }

  /** Every recorded sequence number for one conversation, ascending. */
  async list(chatId: string): Promise<number[]> {
    if (!this.enabled) return []
    let names: string[]
    try {
      names = await readdir(this.#chatDir(chatId))
    } catch {
      // No directory is the ordinary state of a conversation that has not
      // generated yet, not a failure worth reporting.
      return []
    }
    return names
      .map(name => TRACE_FILE.exec(name)?.[1])
      .filter((digits): digits is string => digits !== undefined)
      .map(digits => Number(digits))
      .sort((left, right) => left - right)
  }

  /**
   * Read one trace back.
   * @param chatId - the conversation.
   * @param seq - the sequence number.
   * @returns the trace, or undefined when there is no readable file for it.
   */
  async read(chatId: string, seq: number): Promise<CacheTraceFile | undefined> {
    if (!this.enabled) return undefined
    try {
      const text = await readFile(join(this.#chatDir(chatId), `${String(seq)}.json`), 'utf8')
      const parsed = JSON.parse(text) as CacheTraceFile
      // Refused by version rather than repaired: a file written by a future
      // shape would be read with today's field meanings, and a comparison built
      // on that is a wrong answer rather than a missing one.
      if (parsed.version !== CACHE_TRACE_VERSION) return undefined
      if (typeof parsed.body !== 'string' || !Array.isArray(parsed.spans)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * Write one trace and drop whatever falls out of the window.
   *
   * Never throws. A failed write is reported and forgotten: this record exists
   * to explain what a generation cost, and an instrument that can fail a
   * generation is not one.
   * @param trace - the trace, without its sequence number.
   * @returns the sequence number written, or undefined when nothing was.
   */
  async write(trace: Omit<CacheTraceFile, 'seq'>): Promise<number | undefined> {
    if (!this.enabled) return undefined
    try {
      const dir = this.#chatDir(trace.chatId)
      const seq = await this.#claim(trace.chatId)
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${String(seq)}.json`)
      await atomicWriteFile(path, JSON.stringify({ ...trace, seq }))
      await this.#rotate(trace.chatId, dir)
      return seq
    } catch (error: unknown) {
      this.#options.onError?.(error instanceof Error ? error : new Error(String(error)))
      return undefined
    }
  }

  /** The next sequence number for one conversation, seeded from disk once. */
  async #claim(chatId: string): Promise<number> {
    const held = this.#next.get(chatId)
    if (held !== undefined) {
      this.#next.set(chatId, held + 1)
      return held
    }
    const existing = await this.list(chatId)
    const seq = (existing[existing.length - 1] ?? -1) + 1
    this.#next.set(chatId, seq + 1)
    return seq
  }

  /**
   * Delete everything but the newest `keep`.
   *
   * Only names this store can parse as its own are considered, so a file a user
   * dropped into the directory is left alone rather than deleted by an
   * instrument they did not ask for.
   */
  async #rotate(chatId: string, dir: string): Promise<void> {
    const existing = await this.list(chatId)
    const doomed = existing.slice(0, Math.max(0, existing.length - this.#options.keep))
    for (const seq of doomed) {
      try {
        await unlink(join(dir, `${String(seq)}.json`))
      } catch (error: unknown) {
        this.#options.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  /**
   * Compare one recorded request against the one before it.
   * @param chatId - the conversation.
   * @param seq - the newer of the pair; the newest recorded when absent.
   * @returns the comparison, or undefined when there is no pair to compare.
   */
  async divergence(chatId: string, seq?: number): Promise<PromptDivergence | undefined> {
    const existing = await this.list(chatId)
    const at = seq === undefined ? existing.length - 1 : existing.indexOf(seq)
    // `at < 1` covers both "no such trace" and "it is the first one", which are
    // different facts about the request and the same fact about the comparison:
    // there is no earlier request to compare against.
    if (at < 1) return undefined
    const current = await this.read(chatId, existing[at] as number)
    const previous = await this.read(chatId, existing[at - 1] as number)
    if (current === undefined || previous === undefined) return undefined
    return divergenceOf(previous, current)
  }
}
