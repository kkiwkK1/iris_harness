/**
 * What a generation that is **not a turn** cost, kept on the conversation's
 * header.
 *
 * `./usage.ts` is the storage half for a *turn*: one record per candidate,
 * carried on the message the candidate belongs to. Two other populations are
 * billed on the same route to the same account and have no candidate at all:
 *
 * - a **card's** generation (`TavernHelper.generate` / `generateRaw` →
 *   `service.ts`'s `#sideGenerate` / `#generateRaw`), `source: 'script'`;
 * - the **host's own** compaction summary (`service.ts`'s `#summarize`, reached
 *   from `/compact` and from the automatic trigger), `source: 'compaction'`.
 *
 * Neither appends anything to the log, produces a reply, or belongs to a swipe
 * of any floor. Both are billed exactly like a turn.
 *
 * Until this module existed those requests were recorded nowhere at all: they
 * reach `#stream` with no `entry`, and `noteUsage` / `notePromptFingerprint` /
 * `noteRoute` all hang off `entry.pending.turn`. The consequence was measured
 * rather than assumed — on MVU the card fires one of these per turn for its
 * variable update (`MagVarUpdate`'s `invoke_extra_model.ts:511`), so a
 * conversation on that card was showing roughly half of what it had spent, and
 * the usage page's totals were a claim about a population narrower than the
 * user's bill. `notes/packages/iris-app-service/CACHE-TARGET.md` §4.5 was
 * written around that gap; it now describes the fix.
 *
 * The compaction half arrived second, and the gap it closed was written down
 * before it was fixed (`DEVIATIONS.md` §51's last-but-two paragraph, now §55):
 * a profile that had compacted was short by one summary request per compaction,
 * with no figure anywhere naming the omission.
 *
 * @module @iris/app-service/side-usage
 */

import type { SillyTavernChatHeader } from '@iris/persistence'
import type { TurnUsage } from '@iris/protocol'

import type { PromptFingerprint } from './fingerprint.ts'
import { conversationUsage, parseUsage } from './usage.ts'

/**
 * Where these records live: a **top-level key on the chat header**, holding an
 * append-only array.
 *
 * Same place and same three reasons as `./compaction.ts`'s `COMPACTION_FIELD`,
 * which spells the measurements out; repeated here only where this feature's
 * shape differs.
 *
 * - **Not a message's `iris_usage` array.** That is the obvious home and it is
 *   the wrong one twice over. Positionally it is a lie: `./usage.ts`'s array is
 *   *parallel to `swipes`*, so an extra entry with no swipe behind it shifts
 *   every real record after it — the same failure that module's last paragraph
 *   already names as its one residual. And neither of these generations has a
 *   floor to pick: they are requests the conversation made between two turns,
 *   not candidates for either of them.
 * - **Not a message's `extra`.** SillyTavern replaces that object wholesale on
 *   every swipe (`public/script.js:6956` —
 *   `targetMessage.extra = structuredClone(targetSwipeInfo?.extra) ?? {}`), so
 *   one swipe in SillyTavern deletes the record with nothing said.
 * - **Not `chat_metadata`.** `./context.ts`'s `commitChatMetadata` replaces
 *   that block wholesale and is reachable from a card as
 *   `script.saveMetadata` — so the cards this feature exists to measure are
 *   exactly the code that would delete its records.
 * - **Not `header.iris`.** `ChatStore.importFile` re-mints that block
 *   wholesale, so the record survives save and open but not a round trip.
 *
 * **Append-only, and unbounded.** Nothing rewrites or prunes the array: a
 * total that drops its oldest entries understates a bill, which is the one
 * failure this whole feature exists to remove, so bounding it the way
 * the cache-trace record bounds its eight traces per conversation is not
 * available here — a trace is evidence and this is a sum.
 *
 * The growth is real and small. Measured, 2026-09-09: one record serialises to
 * **151 bytes** at its smallest (two buckets, a route, a moment, a caller),
 * **252** for the shape a DeepSeek route actually writes (a cache bucket and a
 * fingerprint as well), and **332** at its largest (every optional bucket
 * present). `tests/side-usage.test.ts` pins the upper figure, because these
 * numbers are the argument for leaving the array unbounded and an argument
 * resting on a number nothing checks drifts silently.
 *
 * So on the largest real conversation on this machine — 爱衣, 51 lines, 34
 * recorded generations, measured the same day — a card firing one per turn
 * would take the header line from 3 387 bytes to about 12 KB, and a thousand
 * turns would take it to ~250 KB. The header line is parsed by `chat.list`,
 * `chat.search` and `usage.summary`; for scale, one file in that same corpus
 * already carries a *single message line* of 237 KB.
 *
 * The compaction population does not move any of these numbers: it is **one
 * record per compaction**, not one per turn, and a compaction that fires at 80%
 * of the budget cannot fire again until the conversation has grown back.
 */
export const SIDE_USAGE_FIELD = 'iris_side_usage'

/**
 * Which askers this array holds. Never `'turn'` — that is the whole point of
 * the location.
 *
 * A named list rather than a string union spelled at each site because it is
 * also the **read filter**: `parseSideUsage` accepts a stored `source` only
 * when it is one of these, and {@link sideShare} sums by picking one.
 */
export const SIDE_SOURCES = ['script', 'compaction'] as const

/** One of {@link SIDE_SOURCES}. */
export type SideSource = typeof SIDE_SOURCES[number]

/**
 * One not-a-turn generation's cost, as stored and as read.
 *
 * `caller` is beside the usage rather than on `TurnUsage` because it is not on
 * the wire and no consumer of the protocol reads it: it is host-side evidence,
 * the same standing `PromptFingerprint` has in `./usage.ts`'s record.
 */
export interface SideUsage {
  /**
   * The buckets and the identity, with `source` one of {@link SIDE_SOURCES}.
   *
   * **The location decides that this is not a turn; the stored field chooses
   * between the side sources.** That split is the honest version of the rule
   * this module shipped with — "the location is the authority" was written when
   * the array held one population, and a location cannot distinguish two
   * things stored in the same place. So {@link parseSideUsage} refuses a
   * `source` that is not a side source (a file arriving from elsewhere still
   * cannot move a card's spend into the turn column) and otherwise takes the
   * field at its word.
   *
   * A record with no readable `source` reads as `'script'`, and that default is
   * a population rather than a guess: `'compaction'` did not exist until the
   * summarizer was recorded, so everything already written under this key
   * without one is a card's. The field is always *written*, so the file says
   * what it holds to anyone reading it without this code.
   */
  usage: TurnUsage
  /**
   * Which RPC method asked, e.g. `script.generate` — or `host.compaction`,
   * where the asker is this host rather than an RPC.
   *
   * **Not the script's own id, because there is none to be had.** Checked
   * against the contract rather than assumed: `script.generate` carries
   * `chatId`, `userInput`, `systemPrompt` and `maxHistory`, and
   * `script.generateRaw` carries `chatId`, `prompt` and `systemPrompt`
   * (`@iris/protocol`'s `rpc.ts`) — neither carries a script id or a run id,
   * and neither does upstream's `TavernHelper.generate`, so a card cannot send
   * one even if it wanted to. `script.setExtensionPrompt` does carry a `runId`,
   * which is the shape a future attribution would use; adding it here would
   * mean widening two request schemas and changing what a card must send, and
   * that is a contract change rather than a bookkeeping one.
   *
   * So the method name is the finest attribution available, and it does
   * separate the two things a reader cares about: an assembled generation
   * (`script.generate`, which re-sends this conversation's whole prefix) from a
   * bare one (`script.generateRaw`, which sends only what the card handed it).
   *
   * The host's own summarizer has no RPC to name, so it says who it is:
   * `host.compaction`, the same string its cache trace files under. `source`
   * carries the split a *reader* groups by; this stays the finest attribution
   * available, which for one host-side caller is its name.
   */
  caller: string
  /**
   * The hashes of the body that went out.
   *
   * The reason such a request can be *explained* rather than merely counted:
   * a side generation sits between two turns' requests and competes for the
   * same prefix cache, so "did this one read the cache, and was its prefix the
   * same as last time" is the question, and it needs the pair. Absent when the
   * provider reported no usage at all — the record and the fingerprint exist to
   * be read together, and half of a pair persisted alone answers nothing while
   * looking like an answer (`./usage.ts`'s `recordUsage` states the same rule).
   */
  fingerprint?: PromptFingerprint
}

/**
 * The raw array a header carries.
 * @param header - the chat file's first line, as parsed.
 * @returns the entries as read, empty when the header carries none.
 */
export function sideUsageFieldOf(header: SillyTavernChatHeader): unknown[] {
  const stored = header[SIDE_USAGE_FIELD]
  return Array.isArray(stored) ? stored : []
}

/**
 * Read one stored entry.
 *
 * Strict through `parseUsage`, which already refuses a half-read cost, plus one
 * rule of its own: a record with no usable `caller` is refused whole rather
 * than given a placeholder. The caller is the only attribution these records
 * have, and `"unknown"` in that column would be indistinguishable from a real
 * method named that.
 *
 * The `source` is read through {@link sideSourceOf}, which is where the
 * location-versus-field rule now lives.
 * @param value - one array entry from the header.
 * @returns the record, or undefined when the entry is not one.
 */
export function parseSideUsage(value: unknown): SideUsage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const usage = parseUsage(record)
  if (usage === undefined) return undefined
  const caller = record['caller']
  if (typeof caller !== 'string' || caller.length === 0) return undefined
  const fingerprint = readFingerprint(record['fingerprint'])
  return {
    usage: { ...usage, source: sideSourceOf(record['source']) },
    caller,
    ...fingerprint === undefined ? {} : { fingerprint },
  }
}

/**
 * Which side source a stored `source` names.
 *
 * The location says this is not a turn and the field chooses between the side
 * sources — `SideUsage.usage` argues why that is the split, and this is the one
 * place it is decided. Anything not in {@link SIDE_SOURCES} — `'turn'`, junk, or
 * nothing at all — reads as `'script'`: refusing `'turn'` is what keeps a file
 * from elsewhere out of the turn column, and defaulting to `'script'` is not a
 * guess but the population, since every record written under this key before
 * the summarizer was recorded is a card's.
 * @param stored - the record's `source` member, as read.
 * @returns the source to count this record under.
 */
export function sideSourceOf(stored: unknown): SideSource {
  return SIDE_SOURCES.find(source => source === stored) ?? 'script'
}

/**
 * A stored fingerprint, when both halves are there.
 *
 * Both or neither: the divergence question is "same prefix, different body?",
 * which one hash cannot be asked.
 * @param value - the stored `fingerprint` member.
 * @returns the pair, or undefined.
 */
function readFingerprint(value: unknown): PromptFingerprint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const promptHash = record['promptHash']
  const prefixHash = record['prefixHash']
  if (typeof promptHash !== 'string' || promptHash.length === 0) return undefined
  if (typeof prefixHash !== 'string' || prefixHash.length === 0) return undefined
  return { promptHash, prefixHash }
}

/**
 * Every not-a-turn generation this conversation has recorded, oldest first —
 * both populations, in stored order.
 *
 * Unreadable entries are skipped rather than failing the read: a header that
 * arrived from elsewhere with something else under this key must degrade to
 * "this conversation has no side generations", never to a conversation that
 * cannot be opened.
 * @param header - the chat file's first line, as parsed.
 * @returns the records, in stored order.
 */
export function readSideUsage(header: SillyTavernChatHeader): SideUsage[] {
  const records: SideUsage[] = []
  for (const entry of sideUsageFieldOf(header)) {
    const record = parseSideUsage(entry)
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * Append one record to the header, in place.
 *
 * The next `chats.save(entry)` puts it on disk. The header is not rebuilt by
 * `ChatEntry.rebuild`, so an edit or a deletion elsewhere in the conversation
 * cannot take these with them — which is the other half of why they are here
 * rather than on a message.
 *
 * **Appends onto whatever is already stored, including entries this code cannot
 * read.** A malformed neighbour is not a reason to drop the array and start
 * again: {@link readSideUsage} already skips it, and rewriting the field from
 * the parsed records would silently delete anything a future version wrote.
 * @param header - the chat header, mutated in place.
 * @param record - the record to store.
 */
export function appendSideUsage(header: SillyTavernChatHeader, record: SideUsage): void {
  const stored = sideUsageFieldOf(header)
  header[SIDE_USAGE_FIELD] = [...stored, {
    ...record.usage,
    // Written explicitly rather than left to the spread, so the field is never
    // absent on a record this code wrote: the reader defaults a missing one to
    // `'script'`, which would file a compaction as a card's. `sideSourceOf`
    // normalises it on the way in for the same reason it does on the way out —
    // a caller handing over a `TurnUsage` that says `'turn'` must not be able
    // to write that word into this array.
    source: sideSourceOf(record.usage.source),
    caller: record.caller,
    ...record.fingerprint === undefined ? {} : { fingerprint: { ...record.fingerprint } },
  }]
}

/**
 * What one of the two side populations cost, and how many requests it was.
 *
 * `conversationUsage`, so the ruling about `totalTokens` on an aggregate is the
 * same one the turn side ships: an aggregate carries the four buckets and no
 * total.
 *
 * **Filtered, not summed whole**, which is the behaviour change the second
 * population forced: this function used to add every record in the array
 * because every record in the array was a card's. A version that kept doing
 * that would report a card share that included the host's compactions — a
 * figure labelled "how much of this was the card" that a card did not spend.
 * @param records - the conversation's records, both populations.
 * @param source - which population to sum.
 * @returns the count and the sum, or undefined when this population has none.
 */
export function sideShare(
  records: readonly SideUsage[],
  source: SideSource,
): { turns: number, usage: TurnUsage } | undefined {
  const mine = records.filter(record => record.usage.source === source)
  const usage = conversationUsage(mine.map(record => record.usage))
  if (usage === undefined) return undefined
  return { turns: mine.length, usage }
}

/**
 * What a conversation's **card** generations cost, and how many there were.
 * @param records - the conversation's records, both populations.
 * @returns the count and the sum, or undefined when there are none.
 */
export function scriptUsage(
  records: readonly SideUsage[],
): { turns: number, usage: TurnUsage } | undefined {
  return sideShare(records, 'script')
}

/**
 * What a conversation's **compaction summaries** cost, and how many there were.
 * @param records - the conversation's records, both populations.
 * @returns the count and the sum, or undefined when there are none.
 */
export function compactionUsage(
  records: readonly SideUsage[],
): { turns: number, usage: TurnUsage } | undefined {
  return sideShare(records, 'compaction')
}
