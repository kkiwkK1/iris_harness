/**
 * What a frame actually paid, in bytes, to load its libraries.
 *
 * Built to settle one question that no other instrument in this project can
 * reach: **is the HTTP cache partitioned per frame origin?** Every chat opens a
 * frame in a fresh opaque origin, and if caching is partitioned by that origin
 * then a 2.29 MB message preset is downloaded again for every chat, and
 * `immutable` buys nothing because the cache key lives in another partition.
 *
 * The extension's network log cannot answer it: `webRequest` sees that a request
 * was *initiated* but not whether bytes crossed the wire, and a frame's
 * `<script src>` subresources do not appear there at all. Resource timing, read
 * from inside the frame, does — now that the host sends `Timing-Allow-Origin`.
 *
 * ## Why this is three answers and not two
 *
 * The obvious test is `transferSize === 0` means cached. It is not enough, and
 * the gap is the shape this project keeps paying for: **a cross-origin entry
 * without `Timing-Allow-Origin` reports every field as zero**, so "cached" and
 * "not measurable" are the same reading. An experiment run on the two-way test
 * would conclude "second frame transferred nothing, so caching is shared" from a
 * frame that had simply told it nothing — and that conclusion is the opposite of
 * the truth it was looking for.
 *
 * `decodedBodySize` separates them. A cache hit still knows how big the body
 * was; an unreadable entry does not know anything.
 *
 * | transferSize | decodedBodySize | meaning |
 * | --- | --- | --- |
 * | `> 0` | any | bytes crossed the wire |
 * | `0` | `> 0` | served from cache |
 * | `0` | `0` | not readable — no `Timing-Allow-Origin`, so this says nothing |
 *
 * @module iris-web/sandbox/transfer-cost
 */

/** The timing fields this needs; a subset of `PerformanceResourceTiming`. */
export interface TransferTiming {
  name: string
  /** Bytes over the wire, headers included. Zero for a cache hit *and* when opaque. */
  transferSize?: number
  /** The body's size after decoding. Known even from cache; zero when opaque. */
  decodedBodySize?: number
  /** How long the fetch took, for the cost of a cold load. */
  duration?: number
}

/** What one resource cost this frame. */
export type TransferVerdict =
  | { kind: 'transferred', bytes: number, ms: number }
  | { kind: 'cached', bytes: number }
  | { kind: 'unreadable' }

/**
 * Classify one resource's cost.
 *
 * @param entry - the resource timing entry.
 * @returns which of the three answers this entry supports.
 */
export function transferVerdict(entry: TransferTiming): TransferVerdict {
  const transferred = entry.transferSize ?? 0
  const decoded = entry.decodedBodySize ?? 0

  if (transferred > 0) {
    return { kind: 'transferred', bytes: transferred, ms: Math.round(entry.duration ?? 0) }
  }
  /*
   * Nothing over the wire but a known body size: the bytes came from a cache.
   * This is the reading the partitioning question turns on, and it is only
   * distinguishable from silence because `decodedBodySize` survives a cache hit.
   */
  if (decoded > 0) return { kind: 'cached', bytes: decoded }
  return { kind: 'unreadable' }
}

/**
 * One sentence a reader can act on, for a frame's library loads.
 *
 * Reported for every frame rather than only when something is expensive.
 * Reporting only the expensive case would make silence mean either "cheap" or
 * "the instrument is broken", which is the unfalsifiable silence this project
 * has removed from three other places.
 *
 * @param entries - timing for the libraries this frame loaded.
 * @param shorten - turns a URL into something short enough to read.
 * @returns the sentence, or undefined when this frame loaded no libraries.
 */
export function describeTransferCost(
  entries: readonly TransferTiming[],
  shorten: (url: string) => string = name => name,
): string | undefined {
  if (entries.length === 0) return undefined

  const parts = entries.map(entry => {
    const verdict = transferVerdict(entry)
    const label = shorten(entry.name)
    if (verdict.kind === 'transferred') {
      return `${label} downloaded ${kib(verdict.bytes)} in ${String(verdict.ms)}ms`
    }
    if (verdict.kind === 'cached') {
      return `${label} came from cache (${kib(verdict.bytes)} not re-fetched)`
    }
    return `${label} reported no timings, so its cost is unknown here`
  })

  /*
   * A whole sentence, like every other note this frame sends. It read
   * `library cost: …` — a channel name concatenated into the text, which is the
   * shape the shell's reports were just corrected for: it cannot be styled,
   * cannot be filtered, and doubles up the moment anything else adds a prefix.
   * The other eight notes from this frame are plain sentences, so this is the
   * odd one out rather than the pattern.
   */
  return `this frame's libraries cost: ${parts.join('; ')}`
}

/**
 * Bytes as something a person compares at a glance.
 * @param bytes - the byte count.
 * @returns a short size.
 */
function kib(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${String(Math.round(bytes / 1024))} KB`
}
