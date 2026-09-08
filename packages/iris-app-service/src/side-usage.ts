/**
 * What a **card's own** generation cost, kept on the conversation's header.
 *
 * `./usage.ts` is the storage half for a *turn*: one record per candidate,
 * carried on the message the candidate belongs to. A card's generation
 * (`TavernHelper.generate` / `generateRaw` → `service.ts`'s `#sideGenerate` /
 * `#generateRaw`) has no candidate. It appends nothing to the log, produces no
 * reply, and belongs to no swipe of no floor — and it is billed exactly like a
 * turn, on the same route, to the same account.
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
 *   already names as its one residual. And a card's generation has no floor to
 *   pick: it is a request the conversation made between two turns, not a
 *   candidate for either of them.
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
 * `cache-trace.ts` bounds its eight traces is not available here — a trace is
 * evidence and this is a sum.
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
 */
export const SIDE_USAGE_FIELD = 'iris_side_usage'

/**
 * One card generation's cost, as stored and as read.
 *
 * `caller` is beside the usage rather than on `TurnUsage` because it is not on
 * the wire and no consumer of the protocol reads it: it is host-side evidence,
 * the same standing `PromptFingerprint` has in `./usage.ts`'s record.
 */
export interface SideUsage {
  /**
   * The buckets and the identity, with `source` always `'script'`.
   *
   * Stamped by {@link parseSideUsage} from the record's **location** rather
   * than trusted from the stored field: this array is the definition of a
   * script-sourced record, and a file that arrived from somewhere else claiming
   * `source: 'turn'` in here would otherwise move a card's spend into the turn
   * column. The field is still *written*, so the file says what it holds to
   * anyone reading it without this code.
   */
  usage: TurnUsage
  /**
   * Which RPC method asked, e.g. `script.generate`.
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
   */
  caller: string
  /**
   * The hashes of the body that went out.
   *
   * The reason a card's request can be *explained* rather than merely counted:
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
    // The location is the authority — see `SideUsage.usage`.
    usage: { ...usage, source: 'script' },
    caller,
    ...fingerprint === undefined ? {} : { fingerprint },
  }
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
 * Every card generation this conversation has recorded, oldest first.
 *
 * Unreadable entries are skipped rather than failing the read: a header that
 * arrived from elsewhere with something else under this key must degrade to
 * "this conversation has no card generations", never to a conversation that
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
    // Written even though the reader stamps it: the file has to say what it
    // holds to a reader that is not this code.
    source: 'script',
    caller: record.caller,
    ...record.fingerprint === undefined ? {} : { fingerprint: { ...record.fingerprint } },
  }]
}

/**
 * What a conversation's card generations cost, and how many there were.
 *
 * `conversationUsage`, so the ruling about `totalTokens` on an aggregate is the
 * same one the turn side ships: an aggregate carries the four buckets and no
 * total.
 * @param records - the conversation's records.
 * @returns the count and the sum, or undefined when there are none.
 */
export function scriptUsage(
  records: readonly SideUsage[],
): { turns: number, usage: TurnUsage } | undefined {
  const usage = conversationUsage(records.map(record => record.usage))
  if (usage === undefined) return undefined
  return { turns: records.length, usage }
}
