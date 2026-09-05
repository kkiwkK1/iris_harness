/**
 * Markdown read back as plain text.
 *
 * The demo floor action ("copy as plain text") hands the clipboard prose a
 * reader can paste into somewhere that does not render markdown: the words the
 * floor shows, not the source that produced them. The built-in Copy keeps the
 * raw text; this is the other half of that pair.
 *
 * Line-shaped constructs are handled line by line (fences, headings, quotes,
 * list markers, rules); inline markers by one ordered pass (strong before
 * emphasis, so `**x**` is not eaten as two `*` pairs; underscore emphasis only
 * at word edges, so `some_var_name` survives). What is deliberately **not**
 * here: tables, reference links, HTML — a demo fixture's honesty is in doing
 * the common cases predictably, not in reimplementing a renderer.
 *
 * @module iris-web/app/plain-text
 */

/**
 * Collapse markdown to plain text.
 * @param markdown - the raw floor text.
 * @returns the words, markers stripped, content kept.
 */
export function plainText(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    // Fenced code keeps its body verbatim — a paste of a code block is still
    // the code — and only the markers go.
    if (inFence) {
      if (/^\s*(```|~~~)/.test(line)) inFence = false
      else out.push(line)
      continue
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = true
      continue
    }
    // A horizontal rule carries no words at all.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) continue
    // Headings, blockquotes and list markers leave their content behind.
    const stripped = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
    out.push(stripInline(stripped))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Inline markers, longest first; a trailing backtick sweep catches lone ones. */
function stripInline(text: string): string {
  return text
    // Images and links keep their address: a paste that drops the URL is a
    // lossy paste, and "alt (url)" reads as prose in any target.
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_all, alt: string, url: string) =>
      alt === '' ? url : `${alt} (${url})`)
    .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_all, label: string, url: string) =>
      label === '' ? url : `${label} (${url})`)
    .replace(/(`+)([^`]+)\1/g, '$2')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/(?<![\w\\])___([^_]+?)___(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![\w\\])__([^_]+?)__(?!\w)/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(?<![\w\\])_([^_\n]+?)_(?!\w)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`/g, '')
}
