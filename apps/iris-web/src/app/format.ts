/**
 * Small formatters shared by the shell.
 *
 * Kept together because they are the copy layer, and copy consistency is easier
 * to hold when the wording lives in one file rather than inline at each site.
 *
 * @module iris-web/app/format
 */

/**
 * Describe when something last happened, in as few characters as possible.
 *
 * Relative rather than absolute: in a sidebar the useful question is "how stale
 * is this", and a wall-clock time forces the reader to do the subtraction.
 * @param at - Unix epoch milliseconds.
 * @param now - the current time, injectable so this is testable.
 * @returns a short relative stamp.
 */
export function since(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}

/**
 * Count words for the reasoning disclosure's summary.
 *
 * CJK text has no spaces, so a whitespace split would report "1 word" for a
 * paragraph of Chinese. Counting CJK codepoints individually and space-runs
 * elsewhere is close enough for a collapsed label.
 * @param text - the trace.
 * @returns an approximate word count.
 */
export function approximateWords(text: string): number {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu)?.length ?? 0
  const latin = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(word => word !== '').length
  return cjk + latin
}

/**
 * Read a dropped file as base64, the encoding `character.import` expects.
 * @param file - the dropped or chosen file.
 * @returns the base64 payload without a data-URI prefix.
 */
export async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Chunked rather than one spread: a 4MB card would blow the argument limit of
  // `String.fromCharCode` in one call, and a card with a large portrait is
  // normal.
  let binary = ''
  const step = 0x8000
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step))
  }
  return btoa(binary)
}

/**
 * Describe a script's size.
 *
 * Rounded hard and never below a kilobyte's precision: the number exists so a
 * reader can tell "a few lines someone wrote" from "a megabyte of compiled
 * output", and a byte count spelled out in full invites a precision that
 * decision does not need. `0` is reported as such, because a zero-byte script is
 * a real thing in the corpus and hiding it would make an empty row unexplainable.
 * @param bytes - the size.
 * @returns a short human size.
 */
export function describeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes === 0) return 'empty'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
